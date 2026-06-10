//! Platform-aware file path resolver, Android file picker bridge, and native
//! directory scanner.
//!
//! ── Three-tier Android file picker ─────────────────────────────────────────
//!
//! TIER 1: tauri-plugin-android-fs  [optional, --features android-fs]
//!   Uses Tauri's proper Android plugin infrastructure. ActivityResultLauncher
//!   registered through plugin lifecycle hooks, not MainActivity.onCreate.
//!   No custom JNI. Architecturally correct, but requires the external crate.
//!   Failure -> silent fallthrough to Tier 2.
//!
//! TIER 2: Poll-based trigger + OpenMultipleDocuments (Kotlin daemon)
//!
//!   GENERATION 1 BUG: Rust called RiftFilePicker.pickFiles() via
//!   env.call_static_method(). Tauri's IPC bridge leaves stale pending
//!   exceptions on Tokio worker threads. jni-rs 0.21 calls ExceptionCheck at
//!   the top of every checked JNI call. Stale exception -> JavaException ->
//!   "RiftFilePicker.pickFiles() JNI failed: JavaException" in the UI.
//!
//!   GENERATION 2 BUG: Rust side was rewritten to use PICK_REQUESTED AtomicBool.
//!   The Kotlin polling daemon was documented but never implemented. PICK_REQUESTED
//!   was set but nothing read it. The 5-minute timeout always elapsed and Tier 3
//!   produced the error banner. "Both failed" message in the screenshot.
//!
//!   GENERATION 3 FIX (current):
//!     • RiftFilePicker.startPickPoller() daemon thread implemented in Kotlin.
//!       Polls nativeGetPickRequest() [Kotlin->Rust] every 100ms. When true,
//!       posts launcher.launch(arrayOf("*/*")) to the main thread.
//!     • Contract changed from GetMultipleContents (ACTION_GET_CONTENT) to
//!       OpenMultipleDocuments (ACTION_OPEN_DOCUMENT). ACTION_GET_CONTENT
//!       launches into a separate task on OEM builds (TECNO/Transsion, Samsung,
//!       MIUI), causing the ActivityResultLauncher callback to be silently
//!       dropped. ACTION_OPEN_DOCUMENT routes to DocumentsUI which is designed
//!       to return results to the calling Activity's task on all builds.
//!     • pickerInFlight guard + MainActivity.onResume() clearPickerGuard() call
//!       prevent permanent deadlock if even ACTION_OPEN_DOCUMENT fails on a
//!       particularly aggressive OEM build.
//!
//!   All JNI calls are now Kotlin->Rust only. Tauri stale exceptions cannot
//!   affect Kotlin-managed threads. JavaException is structurally impossible.
//!   Failure -> silent fallthrough to Tier 3.
//!
//! TIER 3: Accessible directory scan + in-app browser signal
//!   Scans known public directories using tokio::fs (zero JNI). If files are
//!   found, storage is accessible and the failure is picker-mechanism-only.
//!   The same scan logic is exposed as pub scan_android_dirs() for the frontend
//!   to populate an in-app file browser — the primary long-term approach for
//!   devices where both system pickers fail.
//!
//! ── Native file browser (the core path for capable devices) ────────────────
//!
//! scan_android_dirs() is the backend for the scan_android_files Tauri command.
//! When the frontend calls it:
//!   1. Returns all accessible files across known public directories.
//!   2. Frontend renders an in-app file browser populated from this list.
//!   3. User selects files; frontend passes the absolute paths to send_files.
//!   4. No content:// URIs, no OEM picker, no permission variation.
//!
//! This path works on all Android versions where READ_EXTERNAL_STORAGE (API ≤32)
//! or READ_MEDIA_* (API 33+) is granted. On API 33+ without those permissions,
//! OpenMultipleDocuments covers the gap (no permission required).
//!
//! ── File name preservation ─────────────────────────────────────────────────
//! RiftFilePicker.copyUriToCache() names cache files:
//!   rift_send_{timestamp_ms}_{original_display_name}
//!   rift_t1_{timestamp_ms}_{file_index}_{original_display_name}   (Tier 1)
//!
//! resolve_single() strips these prefixes before the name enters the transfer
//! manifest so the receiver saves files with their original display names.
//!
//! ── Developer diagnostics ──────────────────────────────────────────────────
//! All tier transitions emit eprintln! visible in logcat tag RustStdoutStderr.
//! Filter: `adb logcat -s RustStdoutStderr`
//! Tier 3 logs every accessible file path and size under [FilePicker/T3].

// ── Conditional imports ───────────────────────────────────────────────────────

#[cfg(target_os = "android")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

#[cfg(all(target_os = "android", feature = "android-fs"))]
use tauri_plugin_android_fs::AndroidFsExt;

// ── Public types ──────────────────────────────────────────────────────────────

/// A file resolved to a plain filesystem path that tokio::fs::File::open can use.
pub struct ResolvedFile {
    pub name:      String,
    pub real_path: String,
    pub size:      u64,
    /// Absolute path of a temp cache copy, if created. Caller deletes after transfer.
    pub temp_path: Option<String>,
}

/// A file returned by the Android picker or directory scan — plain absolute path.
pub struct PickedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

// ── Android statics ───────────────────────────────────────────────────────────

/// JavaVM pointer — seeded by nativeInitJvm (called from RiftAndroidHelper.init).
#[cfg(target_os = "android")]
static JVM_GLOBAL: OnceLock<jni::JavaVM> = OnceLock::new();

/// GlobalRef to RiftFilePicker class — seeded by nativeRegisterPickerClass.
/// Reserved for potential future diagnostic or Tier 1 fallback code.
#[cfg(target_os = "android")]
static PICKER_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

/// Tier 2 pick-request signal.
///
/// Rust stores `true` here to request a file pick. Kotlin's RiftPickPoller daemon
/// reads-and-clears it atomically via nativeGetPickRequest() every 100ms, then
/// calls launcher.launch(arrayOf("*/*")) [OpenMultipleDocuments] on the main thread.
///
/// Zero JNI involved in the Rust->signal direction. This eliminates the Tauri
/// stale-exception JavaException that afflicted the previous call_static_method approach.
#[cfg(target_os = "android")]
static PICK_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Oneshot result channel — sender registered by trigger_android_picker_tier2(),
/// consumed by nativeOnFilesSelected() when Kotlin delivers results.
#[cfg(target_os = "android")]
static PICK_SENDER: OnceLock<                                          // FIX 1: was `OnceLock` (missing `<`)
    std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Vec<PickedFile>>>>,
> = OnceLock::new();

// ── JNI exports: all called FROM Kotlin (safe Kotlin→Rust direction) ──────────
//
// Every function below is `external fun` in Kotlin and called BY Kotlin on
// Kotlin-managed threads. This is the safe direction. Kotlin threads carry no
// Tauri stale exception state. ExceptionCheck inside jni-rs cannot fire on a
// clean exception state.

/// Called by Kotlin: RiftAndroidHelper.nativeInitJvm()
/// Stores the JavaVM pointer. Called on the main thread during init.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftAndroidHelper_nativeInitJvm<  // FIX 2: was missing `<`
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
) {
    match env.get_java_vm() {
        Ok(vm) => {
            if JVM_GLOBAL.set(vm).is_ok() {
                eprintln!("[AndroidFS] JavaVM stored in OnceLock");
            }
        }
        Err(e) => eprintln!("[AndroidFS] get_java_vm failed: {e:?}"),
    }
}

/// Called by Kotlin: RiftFilePicker.nativeRegisterPickerClass()
/// Caches a GlobalRef to RiftFilePicker class. Called on the main thread from
/// RiftFilePicker.register() so the app class loader is active.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeRegisterPickerClass<  // FIX 3: was missing `<`
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    class_param: jni::objects::JClass<'local>,
) {
    match env.new_global_ref(&class_param) {
        Ok(global_ref) => {
            if PICKER_CLASS.set(global_ref).is_ok() {
                eprintln!("[FilePicker] RiftFilePicker GlobalRef cached");
            }
        }
        Err(e) => eprintln!("[FilePicker] new_global_ref failed: {e:?}"),
    }
}

/// Called by Kotlin: RiftFilePicker.nativeGetPickRequest()
///
/// The RiftPickPoller daemon calls this every 100ms. Atomically reads-and-clears
/// PICK_REQUESTED via compare_exchange(true->false). Returns JNI_TRUE exactly
/// once per trigger_android_picker_tier2() call.
///
/// DIRECTION: Kotlin->Rust. Runs on the RiftPickPoller daemon thread.
/// No Tauri exception state. No ExceptionCheck risk. Always safe.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeGetPickRequest<  // FIX 4: was missing `<`
    'local,
>(
    _env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
) -> jni::sys::jboolean {
    PICK_REQUESTED
        .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok() as jni::sys::jboolean
}

/// Called by Kotlin: RiftFilePicker.nativeOnFilesSelected(paths: Array<String>)
///
/// Kotlin calls this from the worker thread spawned in onPickerResult(), after
/// copying all selected files to the app's private cache. Each element of `paths`
/// is "displayName\nabsolutePath\nsizeBytes". An empty array signals cancellation.
///
/// DIRECTION: Kotlin->Rust. Runs on the worker thread spawned in onPickerResult.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeOnFilesSelected<  // FIX 5: was missing `<`
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
                 (spurious call or prior timeout — result discarded)"
            );
        }
    }
}

// ── Public: native directory scanner ─────────────────────────────────────────

/// Scans all known Android public directories and returns every readable file.
///
/// This is the backend for the `scan_android_files` Tauri command. The frontend
/// uses the returned list to populate an in-app file browser, giving the user a
/// reliable file selection path that requires no system picker and no content://
/// URI machinery.
///
/// Directory scanning uses a breadth-first approach with MAX_DEPTH = 1, which
/// means each base directory and its immediate subdirectories are scanned. This
/// covers DCIM/Camera, Download/subfolders, etc. without traversing the full
/// file system.
///
/// Returns up to MAX_SCAN_FILES entries to avoid OOM on low-RAM devices (the
/// typical 2–3 GB RAM range of TECNO Camon, Infinix Hot, Itel P-series targets).
///
/// Accessibility depends on granted permissions:
///   API ≤ 32: READ_EXTERNAL_STORAGE → full access to /storage/emulated/0/
///   API 33+:  READ_MEDIA_IMAGES/VIDEO/AUDIO → respective media directories;
///             Downloads and Documents accessible without permission for
///             app-created files. OpenMultipleDocuments covers the rest.
#[cfg(target_os = "android")]
pub async fn scan_android_dirs() -> anyhow::Result<Vec<PickedFile>> {
    list_accessible_files().await
}

/// Desktop stub — scan_android_files command returns USE_DIALOG_PLUGIN on non-Android.
#[cfg(not(target_os = "android"))]
pub async fn scan_android_dirs() -> anyhow::Result<Vec<PickedFile>> {
    Ok(vec![])
}

// ── Three-tier Android picker dispatcher ─────────────────────────────────────

/// Main Android file picker entry point. Tries tiers in order, falling through
/// silently on failure. All transitions logged to logcat RustStdoutStderr tag.
#[cfg(target_os = "android")]
pub async fn trigger_android_picker(
    _app: &tauri::AppHandle,
) -> anyhow::Result<Vec<PickedFile>> {

    // ── Tier 1: tauri-plugin-android-fs ──────────────────────────────────────
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
            }
        }
    }

    // ── Tier 2: Poll-based trigger (OpenMultipleDocuments, no Rust->Kotlin JNI) ─
    eprintln!(
        "[FilePicker] -- Tier 2: poll-trigger + OpenMultipleDocuments (RiftPickPoller daemon) --"
    );
    match trigger_android_picker_tier2().await {
        Ok(files) => {
            eprintln!("[FilePicker] Tier 2 success: {} file(s)", files.len());
            return Ok(files);
        }
        Err(e) => {
            eprintln!("[FilePicker] Tier 2 FAILED -> Tier 3: {e}");
        }
    }

    // ── Tier 3: Accessible directory scan (diagnostic + developer signal) ─────
    // If scan finds files, storage is accessible and the problem is picker-only.
    // The same data is available via scan_android_files command for the in-app browser.
    eprintln!("[FilePicker] -- Tier 3: accessible directory scan (diagnostic) --");
    match list_accessible_files().await {
        Ok(files) if !files.is_empty() => {
            eprintln!(
                "[FilePicker/T3] Storage IS accessible ({} file(s) found). \
                 Problem is picker-mechanism-only, NOT a storage permission issue.",
                files.len()
            );
            eprintln!("[FilePicker/T3] Accessible files (first 20):");
            for f in files.iter().take(20) {
                eprintln!("[FilePicker/T3]   {:>12} B  {}", f.size, f.path);
            }
            if files.len() > 20 {
                eprintln!("[FilePicker/T3]   ... and {} more", files.len() - 20);
            }
            Err(anyhow::anyhow!(
                "File picker unavailable on this device \
                 (Tier 1: android-fs plugin, Tier 2: OpenMultipleDocuments poll-trigger \
                 -- both failed). \
                 Storage IS accessible: {} file(s) found in known directories. \
                 Check logcat tag RustStdoutStderr for [FilePicker/T3] file list.",
                files.len()
            ))
        }
        Ok(_) => {
            eprintln!(
                "[FilePicker/T3] No accessible files found. Possible causes: \
                 storage permission denied, non-standard paths, or API-33 sandbox \
                 without READ_MEDIA_* permissions."
            );
            Err(anyhow::anyhow!(
                "File picker and storage scan both failed. \
                 Ensure storage permissions are granted. \
                 All three picker tiers exhausted — see logcat [FilePicker] tags."
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

// ── Tier 1: tauri-plugin-android-fs ──────────────────────────────────────────

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

        let reader_result = app.android_fs().open_file_readable(&uri_str).await;
        let mut reader = match reader_result {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[FilePicker/T1] open_file_readable({uri_str}): {e} — skipping");
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
                eprintln!("[FilePicker/T1] {display_name}: 0-byte copy — skipping");
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
                eprintln!("[FilePicker/T1] Copy error for {display_name}: {e} — skipping");
                let _ = tokio::fs::remove_file(&cache_path).await;
            }
        }
    }

    Ok(picked)
}

// ── Tier 2: Poll-based trigger (AtomicBool, no Rust->Kotlin JNI) ─────────────

/// Sets PICK_REQUESTED and waits for the RiftPickPoller Kotlin daemon to detect
/// it, call launcher.launch(arrayOf("*/*")) [OpenMultipleDocuments] on the main
/// thread, receive the result in onPickerResult, copy URIs to cache, and call
/// nativeOnFilesSelected.
///
/// The complete absence of Rust->Kotlin JNI calls is intentional and is the fix
/// for "RiftFilePicker.pickFiles() JNI failed: JavaException". See module doc
/// for the full root-cause chain across all three generations of this code.
#[cfg(target_os = "android")]
async fn trigger_android_picker_tier2() -> anyhow::Result<Vec<PickedFile>> {
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Vec<PickedFile>>();

    // Register sender BEFORE setting the flag. The Kotlin daemon could theoretically
    // fire nativeOnFilesSelected before this future resumes after the store.
    {
        let mutex = PICK_SENDER.get_or_init(|| std::sync::Mutex::new(None));
        let mut guard = mutex
            .lock()
            .map_err(|_| anyhow::anyhow!("PICK_SENDER mutex poisoned"))?;
        if guard.is_some() {
            anyhow::bail!(
                "Tier 2: a file picker is already open — \
                 complete or cancel the current selection before starting a new one"
            );
        }
        *guard = Some(tx);
    }

    // Signal the Kotlin RiftPickPoller daemon — zero JNI.
    // The daemon reads this via nativeGetPickRequest() within ≤100ms.
    PICK_REQUESTED.store(true, Ordering::SeqCst);
    eprintln!(
        "[FilePicker/T2] PICK_REQUESTED set — RiftPickPoller will launch \
         OpenMultipleDocuments picker within ≤100ms"
    );

    // 5-minute timeout: generous for manual file browsing; prevents indefinite hang.
    // If the picker is closed by clearPickerGuard() in onResume (OEM callback-drop
    // recovery), nativeOnFilesSelected(emptyArray()) is called and rx resolves
    // immediately with an empty Vec rather than waiting for this timeout.
    match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(files)) => {
            eprintln!(
                "[FilePicker/T2] {} file(s) received from nativeOnFilesSelected",
                files.len()
            );
            Ok(files)
        }
        Ok(Err(_channel_dropped)) => {
            PICK_REQUESTED.store(false, Ordering::SeqCst);
            Err(anyhow::anyhow!(
                "Tier 2: result channel dropped unexpectedly \
                 (sender gone before Kotlin called nativeOnFilesSelected)"
            ))
        }
        Err(_timeout) => {
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
                 (PICK_REQUESTED was set but nativeOnFilesSelected was never called — \
                 check that RiftFilePicker.startPickPoller() ran in MainActivity.onCreate, \
                 and that clearPickerGuard() is called in onResume)"
            ))
        }
    }
}

// ── Tier 3 / native browser: accessible directory scan ───────────────────────

/// Scans known Android public directories. Zero JNI. Called by both Tier 3
/// (diagnostic in trigger_android_picker) and scan_android_dirs() (frontend
/// in-app browser backend via the scan_android_files Tauri command).
///
/// Uses a breadth-first traversal with MAX_DEPTH = 1 so that immediate
/// subdirectories are also scanned (e.g. DCIM/Camera, Download/subfolder).
/// Hidden directories (starting with '.') and the protected Android/data
/// directory are not enqueued.
///
/// Directory set covers:
///   • AOSP standard public dirs + common OEM aliases
///   • TECNO/Infinix/Itel sdcard symlinks (Transsion OEM path aliases)
///   • WhatsApp media (legacy + API-29 sandboxed Android/media path)
///   • Telegram
///   • Samsung/OEM Received folder
///
/// Capped at MAX_SCAN_FILES (2000) to protect low-RAM devices (2–3 GB, typical
/// for West African market targets). Files are returned in BFS discovery order;
/// the frontend can sort by name, date, or size.
#[cfg(target_os = "android")]
async fn list_accessible_files() -> anyhow::Result<Vec<PickedFile>> {
    const MAX_SCAN_FILES: usize = 2000;
    /// Scan base directories + their immediate subdirectories.
    const MAX_DEPTH: usize = 1;

    let candidate_dirs: &[&str] = &[
        // ── AOSP standard public directories ─────────────────────────────────
        "/storage/emulated/0/Download",
        "/storage/emulated/0/Downloads",
        "/storage/emulated/0/Documents",
        "/storage/emulated/0/DCIM",
        "/storage/emulated/0/Pictures",
        "/storage/emulated/0/Music",
        "/storage/emulated/0/Movies",
        "/storage/emulated/0/Video",
        "/storage/emulated/0/Videos",
        "/storage/emulated/0/Bluetooth",
        "/storage/emulated/0/Received",
        "/storage/emulated/0/Files",
        "/storage/emulated/0/Recordings",
        "/storage/emulated/0/Ringtones",
        "/storage/emulated/0/Podcasts",
        "/storage/emulated/0/Audiobooks",
        "/storage/emulated/0/Screenshots",
        // ── OEM path aliases (Transsion/TECNO, Infinix, Itel, Samsung) ───────
        // These are typically symlinks to /storage/emulated/0/ but some OEM
        // builds use them as actual distinct paths.
        "/sdcard/Download",
        "/sdcard/DCIM",
        "/sdcard/Pictures",
        "/sdcard/Documents",
        "/sdcard/Movies",
        "/sdcard/Music",
        "/sdcard/Videos",
        "/sdcard/Files",
        // ── TECNO/Infinix specific ────────────────────────────────────────────
        // TECNO stock file manager creates a "MyFiles" root; Infinix similarly.
        "/storage/emulated/0/MyFiles",
        // ── WhatsApp media paths ─────────────────────────────────────────────
        // Primary file-sharing channel in Nigeria, Ghana, Kenya, South Africa.
        // Legacy path (Android ≤9, or older WhatsApp installations):
        "/storage/emulated/0/WhatsApp/Media/WhatsApp Documents",
        "/storage/emulated/0/WhatsApp/Media/WhatsApp Images",
        "/storage/emulated/0/WhatsApp/Media/WhatsApp Video",
        "/storage/emulated/0/WhatsApp/Media/WhatsApp Audio",
        // API-29+ sandboxed path (WhatsApp stores media in app-specific dir):
        "/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Documents",
        "/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images",
        "/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video",
        // ── Telegram ─────────────────────────────────────────────────────────
        "/storage/emulated/0/Telegram",
        "/storage/emulated/0/Telegram Documents",
        "/storage/emulated/0/Android/media/org.telegram.messenger/Telegram/Telegram Documents",
    ];

    let mut found: Vec<PickedFile> = Vec::new();

    // BFS queue: (directory_path, current_depth).
    // All candidate roots start at depth 0.
    let mut queue: std::collections::VecDeque<(String, usize)> = candidate_dirs
        .iter()
        .map(|d| (d.to_string(), 0_usize))
        .collect();

    'scan: while let Some((dir_str, depth)) = queue.pop_front() {
        let path = std::path::Path::new(&dir_str);
        if !path.exists() {
            continue;
        }
        match tokio::fs::read_dir(path).await {
            Err(e) => {
                eprintln!("[FilePicker/T3] Cannot read {dir_str}: {e}");
            }
            Ok(mut entries) => {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    if found.len() >= MAX_SCAN_FILES {
                        eprintln!(
                            "[FilePicker/T3] Scan cap ({MAX_SCAN_FILES} files) reached — stopping"
                        );
                        break 'scan;
                    }
                    let fpath = entry.path();
                    if fpath.is_file() {
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
                    } else if depth < MAX_DEPTH {
                        // Enqueue subdirectory for the next BFS pass.
                        // Skip hidden dirs (.) and Android/data (permission-protected).
                        let dir_name = fpath
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("");
                        if !dir_name.starts_with('.') && dir_name != "data" {
                            queue.push_back((
                                fpath.to_string_lossy().to_string(),
                                depth + 1,
                            ));
                        }
                    }
                }
            }
        }
    }

    Ok(found)
}

// ── Desktop stubs ─────────────────────────────────────────────────────────────

/// Desktop: pick_files_for_send returns USE_DIALOG_PLUGIN sentinel; this is never called.
#[cfg(not(target_os = "android"))]
pub async fn trigger_android_picker(
    _app: &tauri::AppHandle,
) -> anyhow::Result<Vec<PickedFile>> {
    Err(anyhow::anyhow!("trigger_android_picker: not applicable on desktop"))
}

// ── resolve_paths: used by send_files ─────────────────────────────────────────

/// Resolves each path to a ResolvedFile for the transfer layer.
/// All paths here are plain absolute cache paths — no content:// URIs.
pub async fn resolve_paths(paths: &[String]) -> anyhow::Result<Vec<ResolvedFile>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(resolve_single(path).await?);
    }
    Ok(out)
}

/// Strips the `rift_send_` or `rift_t1_` cache prefix that
/// RiftFilePicker.copyUriToCache() prepends to the original display name.
///
/// Without this, `resolve_single` would derive the transfer name from the
/// cache path, causing the receiver to save files as `rift_send_1720000000_report.pdf`
/// instead of `report.pdf`.
///
/// Patterns recognised:
///   `rift_send_{digits}_{original_name}`          → `{original_name}`
///   `rift_t1_{digits}_{file_index}_{orig_name}`   → `{orig_name}`
///
/// If neither pattern matches (e.g. a real file on desktop that happens to
/// start with those characters), the filename is returned unchanged.
fn strip_rift_cache_prefix(filename: &str) -> String {
    // ── rift_send_{digits}_{name} ─────────────────────────────────────────────
    if let Some(rest) = filename.strip_prefix("rift_send_") {
        // Trim all leading ASCII digits (timestamp_ms, variable length).
        let after_ts = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        if let Some(name) = after_ts.strip_prefix('_') {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    // ── rift_t1_{digits}_{index}_{name} ──────────────────────────────────────
    if let Some(rest) = filename.strip_prefix("rift_t1_") {
        let after_ts = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        if let Some(after_first_us) = after_ts.strip_prefix('_') {
            // Skip the file index digits and the following underscore.
            let after_idx = after_first_us.trim_start_matches(|c: char| c.is_ascii_digit());
            if let Some(name) = after_idx.strip_prefix('_') {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    filename.to_string()
}

async fn resolve_single(path: &str) -> anyhow::Result<ResolvedFile> {
    let size = tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let raw_name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");

    // On Android, files staged through the system picker are copied to the app
    // cache with a rift_send_ / rift_t1_ timestamp prefix.  Strip it so the
    // receiver sees the original display name, not the cache artifact name.
    #[cfg(target_os = "android")]
    let name = strip_rift_cache_prefix(raw_name);
    #[cfg(not(target_os = "android"))]
    let name = raw_name.to_string();

    Ok(ResolvedFile {
        name,
        real_path: path.to_string(),
        size,
        temp_path: None,
    })
}