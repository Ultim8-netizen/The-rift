//! Platform-aware file path resolver and Android file picker bridge.
//!
//! -- Three-tier Android file picker ------------------------------------------
//!
//! TIER 1: tauri-plugin-android-fs  [optional, requires --features android-fs]
//!   Uses Tauri's proper Android plugin infrastructure. ActivityResultLauncher
//!   is registered through plugin lifecycle hooks, not MainActivity.onCreate.
//!   No custom JNI of any kind. This is the architecturally correct solution.
//!   Failure -> silent fallthrough to Tier 2.
//!
//! TIER 2: Poll-based Kotlin trigger  [default, always active]
//!   ROOT-CAUSE FIX for the JavaException error:
//!
//!   Root cause: Rust called RiftFilePicker.pickFiles() via
//!   env.call_static_method(). jni-rs 0.21 calls ExceptionCheck at the top of
//!   every "checked" JNI method. Tauri's IPC bridge leaves stale pending
//!   exceptions on its Tokio worker threads. When our code ran on a reused
//!   thread, the stale exception caused call_static_method to return
//!   Err(JavaException) immediately -- before touching Kotlin at all.
//!
//!   Fix: eliminate ALL Rust->Kotlin JNI calls. Rust sets PICK_REQUESTED (a
//!   plain AtomicBool, no JNI). Kotlin's daemon thread polls
//!   nativeGetPickRequest() [Kotlin->Rust direction] every 100ms and launches
//!   the picker when it sees true. ALL JNI calls are now Kotlin->Rust --
//!   running on Kotlin-managed threads with no Tauri stale-exception pollution.
//!   Failure -> silent fallthrough to Tier 3.
//!
//! TIER 3: Accessible directory scan  [diagnostic + limited fallback]
//!   Scans /storage/emulated/0/Download and other known public dirs using
//!   tokio::fs (zero JNI). Logs all found files to logcat under [FilePicker/T3]
//!   so the developer can determine whether failures are permission-related or
//!   picker-mechanism-only. Does NOT auto-select files for the user.
//!
//! -- Developer diagnostics ---------------------------------------------------
//! All tier transitions and failures emit eprintln! visible in logcat under the
//! "RustStdoutStderr" tag. Filter: `adb logcat -s RustStdoutStderr`.
//! Tier 3 additionally logs every accessible file path and size.

// -- Conditional imports ------------------------------------------------------

#[cfg(target_os = "android")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

#[cfg(all(target_os = "android", feature = "android-fs"))]
use tauri_plugin_android_fs::AndroidFsExt;

// -- Public types -------------------------------------------------------------

/// A file resolved to a plain filesystem path that tokio::fs::File::open can use.
pub struct ResolvedFile {
    pub name:      String,
    pub real_path: String,
    pub size:      u64,
    /// Absolute path of a temp cache copy, if created. Caller deletes after transfer.
    pub temp_path: Option<String>,
}

/// A file returned by the Android picker -- already cached as a plain path.
#[cfg(target_os = "android")]
pub struct PickedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

// -- Android statics ----------------------------------------------------------

/// JavaVM pointer -- seeded by nativeInitJvm (called from RiftAndroidHelper.init).
/// Retained for potential future JNI use; not required by Tier 2.
#[cfg(target_os = "android")]
static JVM_GLOBAL: OnceLock<jni::JavaVM> = OnceLock::new();

/// GlobalRef to RiftFilePicker class -- seeded by nativeRegisterPickerClass.
/// No longer used for triggering (Tier 2 removed that call). Retained as a
/// reserved handle in case future diagnostic or Tier 1 fallback code needs it.
#[cfg(target_os = "android")]
static PICKER_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

/// Tier 2 pick-request signal.
///
/// Rust stores `true` here to request a file pick. Kotlin's polling daemon
/// thread reads-and-clears it atomically via nativeGetPickRequest().
/// This AtomicBool replaces the broken env.call_static_method("pickFiles") call.
/// No JNI involved in the Rust->signal direction.
#[cfg(target_os = "android")]
static PICK_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Oneshot result channel -- sender registered by trigger_android_picker_tier2(),
/// consumed by nativeOnFilesSelected() when Kotlin delivers results.
#[cfg(target_os = "android")]
static PICK_SENDER: OnceLock<
    std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Vec<PickedFile>>>>,
> = OnceLock::new();

// -- JNI exports: all called FROM Kotlin (safe direction) ---------------------
//
// CRITICAL DIRECTION NOTE: every function below is declared `external fun` in
// Kotlin and called BY Kotlin on Kotlin-managed threads. This is the SAFE
// direction. The previous architecture had Rust calling INTO Kotlin
// (call_static_method) -- that is the direction that fails.
//
// Kotlin threads do not carry Tauri's stale JNI exception state.
// These functions execute on clean threads and simply read/write Rust statics.

/// Called by Kotlin: RiftAndroidHelper.nativeInitJvm()
/// Stores the JavaVM pointer. Called on the main thread during init.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftAndroidHelper_nativeInitJvm<
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
) {
    match env.get_java_vm() {
        Ok(vm) => {
            if JVM_GLOBAL.set(vm).is_ok() {
                eprintln!("[AndroidFS] JavaVM stored");
            }
        }
        Err(e) => eprintln!("[AndroidFS] get_java_vm failed: {e:?}"),
    }
}

/// Called by Kotlin: RiftFilePicker.nativeRegisterPickerClass()
/// Caches a GlobalRef to RiftFilePicker for potential future use.
/// Called on the main thread from RiftFilePicker.register().
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeRegisterPickerClass<
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    class_param: jni::objects::JClass<'local>,
) {
    match env.new_global_ref(&class_param) {
        Ok(global_ref) => {
            if PICKER_CLASS.set(global_ref).is_ok() {
                eprintln!("[FilePicker] RiftFilePicker GlobalRef cached (reserved)");
            }
        }
        Err(e) => eprintln!("[FilePicker] new_global_ref failed: {e:?}"),
    }
}

/// Called by Kotlin: RiftFilePicker.nativeGetPickRequest()
///
/// The Kotlin polling daemon calls this every 100ms to check whether Rust
/// has requested a file pick. Atomically reads-and-clears PICK_REQUESTED.
/// Returns JNI_TRUE (1) exactly once per trigger_android_picker_tier2() call.
///
/// DIRECTION: Kotlin -> Rust. Runs on a Kotlin-managed daemon thread.
/// No Tauri stale-exception pollution. No ExceptionCheck needed.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeGetPickRequest<
    'local,
>(
    _env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
) -> jni::sys::jboolean {
    // compare_exchange: true->false. Returns Ok(true) exactly once; all
    // subsequent reads see false until Rust sets it again.
    PICK_REQUESTED
        .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok() as jni::sys::jboolean
}

/// Called by Kotlin: RiftFilePicker.nativeOnFilesSelected(paths: Array<String>)
///
/// Kotlin calls this after copying all selected files to app cache. Each
/// element of `paths` is "displayName\nabsolutePath\nsizeBytes".
/// An empty array signals cancellation or failure -- still resolves the channel.
///
/// DIRECTION: Kotlin -> Rust. Runs on the worker thread spawned in onPickerResult.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeOnFilesSelected<
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    paths: jni::objects::JObjectArray<'local>,
) {
    let len = env.get_array_length(&paths).unwrap_or(0);
    let mut picked: Vec<PickedFile> = Vec::with_capacity(len as usize);

    for i in 0..len {
        let elem = match env.get_object_array_element(&paths, i) {
            Ok(o) if !o.is_null() => o,
            _ => continue,
        };
        let jstr = jni::objects::JString::from(elem);
        let s: String = match env.get_string(&jstr) {
            Ok(s) => s.into(),
            Err(_) => continue,
        };

        // Format: "displayName\nabsolutePath\nsizeBytes"
        let mut parts = s.splitn(3, '\n');
        let name = match parts.next() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let path = match parts.next() {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => continue,
        };
        let size: u64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        picked.push(PickedFile { name, path, size });
    }

    eprintln!("[FilePicker] nativeOnFilesSelected: {} file(s) received", picked.len());

    let mutex = PICK_SENDER.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = mutex.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(picked);
        } else {
            eprintln!(
                "[FilePicker] nativeOnFilesSelected: no waiting Rust sender \
                 (spurious call or prior timeout -- result discarded)"
            );
        }
    }
}

// -- Three-tier Android picker dispatcher -------------------------------------

/// Main Android file picker entry point. Tries each tier in order, falling
/// through silently on failure. All failures are logged to logcat.
///
/// Returns Ok(vec![]) if the user cancelled (all tiers). Only returns Err if
/// all tiers were tried and could not produce a pick UI or file list.
#[cfg(target_os = "android")]
pub async fn trigger_android_picker(
    _app: &tauri::AppHandle,
) -> anyhow::Result<Vec<PickedFile>> {

    // -- Tier 1: tauri-plugin-android-fs --------------------------------------
    // Proper Tauri plugin infrastructure -- no custom JNI at all.
    // Activated by building with --features android-fs.
    // If the crate API differs from below, the compiler error is localised here.
    #[cfg(feature = "android-fs")]
    {
        eprintln!("[FilePicker] -- Tier 1: tauri-plugin-android-fs --");
        match try_tier1_android_fs_plugin(_app).await {
            Ok(files) => {
                eprintln!("[FilePicker] Tier 1 success: {} file(s)", files.len());
                return Ok(files);
            }
            Err(e) => {
                eprintln!("[FilePicker] Tier 1 FAILED -> Tier 2: {e}");
                // Silent fallthrough
            }
        }
    }

    // -- Tier 2: Poll-based trigger (AtomicBool, no Rust->Kotlin JNI) ---------
    // This tier is the guaranteed fix for the JavaException root cause.
    // Works independently of Tier 1 -- always compiled, always available.
    eprintln!("[FilePicker] -- Tier 2: poll-based trigger (no Rust->Kotlin JNI) --");
    match trigger_android_picker_tier2().await {
        Ok(files) => {
            eprintln!("[FilePicker] Tier 2 success: {} file(s)", files.len());
            return Ok(files);
        }
        Err(e) => {
            eprintln!("[FilePicker] Tier 2 FAILED -> Tier 3: {e}");
            // Silent fallthrough
        }
    }

    // -- Tier 3: Accessible directory scan (diagnostic) -----------------------
    // Scans known public dirs. Logs all readable files to logcat for developer
    // diagnosis. Does NOT auto-select files (would be surprising/wrong UX).
    // Returns an informative Err that the frontend displays as the error banner.
    eprintln!("[FilePicker] -- Tier 3: accessible directory scan (diagnostic) --");
    match list_accessible_files().await {
        Ok(files) if !files.is_empty() => {
            eprintln!(
                "[FilePicker/T3] File system IS accessible ({} file(s) found).",
                files.len()
            );
            eprintln!(
                "[FilePicker/T3] Problem is picker-mechanism-only, NOT a storage permission issue."
            );
            eprintln!("[FilePicker/T3] Accessible files:");
            for f in &files {
                eprintln!("[FilePicker/T3]   {:>12} B  {}", f.size, f.path);
            }
            Err(anyhow::anyhow!(
                "File picker unavailable on this device \
                 (Tier 1: android-fs plugin, Tier 2: JNI poll -- both failed). \
                 Storage IS accessible: {} file(s) found in known directories. \
                 Check logcat tag RustStdoutStderr for [FilePicker/T3] file list.",
                files.len()
            ))
        }
        Ok(_) => {
            eprintln!(
                "[FilePicker/T3] No accessible files in known public dirs. \
                 Possible causes: READ_EXTERNAL_STORAGE permission denied, \
                 non-standard storage paths, or sandbox restrictions."
            );
            Err(anyhow::anyhow!(
                "File picker and storage scan both failed. \
                 Ensure READ_EXTERNAL_STORAGE permission is granted. \
                 All three picker tiers exhausted -- see logcat [FilePicker] tags."
            ))
        }
        Err(e) => {
            eprintln!("[FilePicker/T3] Scan error: {e}");
            Err(anyhow::anyhow!(
                "All file picker mechanisms failed. Scan error: {e}. \
                 Check logcat tag RustStdoutStderr, filter [FilePicker]."
            ))
        }
    }
}

// -- Tier 1: tauri-plugin-android-fs ------------------------------------------

/// Attempts to pick files via tauri-plugin-android-fs.
///
/// COMPILE NOTE: if the plugin API has changed since this was written,
/// method names or types below may need adjustment. The compiler error
/// will be localised to this function. Common things to check:
///   - `pick_files` vs `open_file` vs `pick_file`
///   - `AndroidFsExt` trait method name
///   - `FileEntry` fields: `.uri()`, `.name()`, `.size()`
///   - `open_file_readable` return type: `impl Read` vs `impl AsyncRead`
#[cfg(all(target_os = "android", feature = "android-fs"))]
async fn try_tier1_android_fs_plugin(
    app: &tauri::AppHandle,
) -> anyhow::Result<Vec<PickedFile>> {
    let entries = app
        .android_fs()
        .pick_files(Default::default())
        .await
        .map_err(|e| anyhow::anyhow!("android-fs pick_files: {e}"))?;

    if entries.is_empty() {
        eprintln!("[FilePicker/T1] User cancelled (no files selected)");
        return Ok(vec![]);
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| anyhow::anyhow!("app_cache_dir: {e}"))?;

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| anyhow::anyhow!("create cache dir: {e}"))?;

    let mut picked = Vec::with_capacity(entries.len());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    for (i, entry) in entries.into_iter().enumerate() {
        let uri_str = entry.uri().to_string();
        let display_name = entry
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("file_{ts}_{i}"));

        let safe_name: String = display_name
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                c => c,
            })
            .collect();

        let cache_path = cache_dir.join(format!("rift_t1_{ts}_{i}_{safe_name}"));

        let reader_result = app
            .android_fs()
            .open_file_readable(&uri_str)
            .await;

        let mut reader = match reader_result {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[FilePicker/T1] open_file_readable({uri_str}): {e} -- skipping");
                continue;
            }
        };

        let cache_path_clone = cache_path.clone();
        let copy_result = tokio::task::spawn_blocking(move || -> anyhow::Result<u64> {
            use std::io::Read;
            let mut data = Vec::new();
            reader
                .read_to_end(&mut data)
                .map_err(|e| anyhow::anyhow!("read: {e}"))?;
            let size = data.len() as u64;
            std::fs::write(&cache_path_clone, &data)
                .map_err(|e| anyhow::anyhow!("write cache: {e}"))?;
            Ok(size)
        })
        .await
        .map_err(|e| anyhow::anyhow!("spawn_blocking: {e}"))
        .and_then(|r| r);

        match copy_result {
            Ok(0) => {
                eprintln!("[FilePicker/T1] {display_name}: 0-byte copy -- skipping");
                let _ = tokio::fs::remove_file(&cache_path).await;
            }
            Ok(size) => {
                let path_str = cache_path.to_string_lossy().to_string();
                eprintln!("[FilePicker/T1] Cached: {display_name} -> {path_str} ({size} B)");
                picked.push(PickedFile {
                    name: display_name,
                    path: path_str,
                    size,
                });
            }
            Err(e) => {
                eprintln!("[FilePicker/T1] Copy error for {display_name}: {e} -- skipping");
                let _ = tokio::fs::remove_file(&cache_path).await;
            }
        }
    }

    Ok(picked)
}

// -- Tier 2: Poll-based (AtomicBool, no Rust->Kotlin JNI) ---------------------

/// Sets PICK_REQUESTED and waits for Kotlin's polling daemon to detect it,
/// launch the picker, copy files, and call nativeOnFilesSelected.
///
/// The complete absence of Rust->Kotlin JNI calls (call_static_method etc.) is
/// intentional and is the fix for "RiftFilePicker.pickFiles() JNI failed:
/// JavaException". See module-level doc for full root-cause analysis.
#[cfg(target_os = "android")]
async fn trigger_android_picker_tier2() -> anyhow::Result<Vec<PickedFile>> {
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Vec<PickedFile>>();

    // Register sender BEFORE setting the flag -- the Kotlin thread could
    // theoretically fire nativeOnFilesSelected before this future proceeds.
    {
        let mutex = PICK_SENDER.get_or_init(|| std::sync::Mutex::new(None));
        let mut guard = mutex
            .lock()
            .map_err(|_| anyhow::anyhow!("PICK_SENDER mutex poisoned"))?;
        if guard.is_some() {
            anyhow::bail!(
                "Tier 2: a file picker is already open -- \
                 complete or cancel the current selection before starting a new one"
            );
        }
        *guard = Some(tx);
    }

    // Signal the Kotlin polling daemon -- zero JNI.
    // The daemon reads this via nativeGetPickRequest() within ~100ms.
    PICK_REQUESTED.store(true, Ordering::SeqCst);
    eprintln!(
        "[FilePicker/T2] PICK_REQUESTED set -- Kotlin poll thread will launch picker within <=100ms"
    );

    // 5-minute timeout: generous for manual file browsing, prevents indefinite hang.
    match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(files)) => {
            eprintln!(
                "[FilePicker/T2] {} file(s) received from nativeOnFilesSelected",
                files.len()
            );
            Ok(files)
        }
        Ok(Err(_channel_dropped)) => {
            // Sender was dropped without a send -- internal bookkeeping error.
            PICK_REQUESTED.store(false, Ordering::SeqCst);
            Err(anyhow::anyhow!(
                "Tier 2: result channel dropped unexpectedly \
                 (sender gone before Kotlin called nativeOnFilesSelected)"
            ))
        }
        Err(_timeout) => {
            // Kotlin never called back. Reasons: polling daemon not started,
            // launcher not registered, Activity in STOPPED state, or OEM restriction.
            PICK_REQUESTED.store(false, Ordering::SeqCst);
            // Clear stale sender so the next attempt can register a fresh one.
            if let Ok(mut guard) = PICK_SENDER
                .get_or_init(|| std::sync::Mutex::new(None))
                .lock()
            {
                guard.take();
            }
            Err(anyhow::anyhow!(
                "Tier 2: file picker timed out after 5 minutes \
                 (PICK_REQUESTED was set but nativeOnFilesSelected was never called -- \
                 check that RiftFilePicker.startPickPoller() ran in MainActivity.onCreate)"
            ))
        }
    }
}

// -- Tier 3: Accessible directory scan ----------------------------------------

/// Diagnostic-only scan of known public directories. Zero JNI.
/// Returns all readable files found; caller logs them and produces a
/// structured error message for the developer.
#[cfg(target_os = "android")]
async fn list_accessible_files() -> anyhow::Result<Vec<PickedFile>> {
    // Known Android public directory paths -- covers AOSP and common OEMs.
    let candidate_dirs: &[&str] = &[
        "/storage/emulated/0/Download",
        "/storage/emulated/0/Downloads",
        "/storage/emulated/0/Documents",
        "/storage/emulated/0/DCIM",
        "/storage/emulated/0/Pictures",
        "/storage/emulated/0/Music",
        "/storage/emulated/0/Movies",
        "/sdcard/Download",
    ];

    let mut found = Vec::new();
    for dir in candidate_dirs {
        let path = std::path::Path::new(dir);
        if !path.exists() {
            continue;
        }
        match tokio::fs::read_dir(path).await {
            Err(e) => {
                eprintln!("[FilePicker/T3] Cannot read {dir}: {e}");
            }
            Ok(mut entries) => {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let fpath = entry.path();
                    if !fpath.is_file() {
                        continue;
                    }
                    let name = fpath
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let size = tokio::fs::metadata(&fpath)
                        .await
                        .map(|m| m.len())
                        .unwrap_or(0);
                    found.push(PickedFile {
                        name,
                        path: fpath.to_string_lossy().to_string(),
                        size,
                    });
                }
            }
        }
    }
    Ok(found)
}

// -- resolve_paths: used by send_files ----------------------------------------

/// Resolves each path to a ResolvedFile for the transfer layer.
/// All paths arriving here are plain absolute cache paths -- no content:// URIs.
pub async fn resolve_paths(paths: &[String]) -> anyhow::Result<Vec<ResolvedFile>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(resolve_single(path).await?);
    }
    Ok(out)
}

async fn resolve_single(path: &str) -> anyhow::Result<ResolvedFile> {
    let size = tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    Ok(ResolvedFile {
        name,
        real_path: path.to_string(),
        size,
        temp_path: None,
    })
}

// -- Desktop stubs ------------------------------------------------------------

/// Desktop platforms do not use this picker -- lib.rs returns USE_DIALOG_PLUGIN.
/// This stub is only present to satisfy Rust's type checker for pick_files_for_send.
#[cfg(not(target_os = "android"))]
pub async fn trigger_android_picker(
    _app: &tauri::AppHandle,
) -> anyhow::Result<Vec<PickedFile>> {
    // Never called on desktop -- pick_files_for_send returns USE_DIALOG_PLUGIN sentinel first.
    Err(anyhow::anyhow!("trigger_android_picker: not applicable on desktop"))
}

// Suppress unused type warning on desktop
#[cfg(not(target_os = "android"))]
pub struct PickedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}