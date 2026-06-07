//! Platform-aware file path resolver and Android file picker bridge.
//!
//! ── Architecture (new) ───────────────────────────────────────────────────────
//! The previous implementation attempted to copy content:// URIs from a Tokio
//! blocking thread via JNI, long after the URI grant had been delivered via
//! Tauri's async IPC pipeline. This failed consistently on OEM Android builds
//! (TECNO/Transsion, Samsung, MIUI) because those ROMs enforce stricter URI
//! permission checks tied to the Activity component that received onActivityResult,
//! not the process-wide ApplicationContext.
//!
//! The replacement: RiftFilePicker.kt owns the entire picker lifecycle. It copies
//! file bytes to cache inside the activity result callback — while the grant is
//! unambiguously live — then signals this module via nativeOnFilesSelected. Rust
//! only ever receives plain absolute cache paths. No URI, no grant, no OEM gap.
//!
//! ── JVM initialisation (unchanged) ──────────────────────────────────────────
//! RiftAndroidHelper.nativeInitJvm() stores the JavaVM pointer in JVM_GLOBAL.
//! This is still required so trigger_android_picker() can call back into Kotlin
//! via with_jni().
//!
//! ── Classloader fix (unchanged mechanism, new target) ────────────────────────
//! FindClass from a Tokio worker thread uses the bootstrap classloader and cannot
//! find app classes. RiftFilePicker.nativeRegisterPickerClass() stores a GlobalRef
//! to RiftFilePicker on the main thread (where the app classloader is active).
//! trigger_android_picker() uses JClass::from_raw(PICKER_CLASS.get()) to call
//! RiftFilePicker.pickFiles() without ever calling FindClass again.
//!
//! ── Why with_jni clears the pending exception ────────────────────────────────
//! In jni-rs 0.21, "checked" JNI methods (call_static_method, get_static_method_id,
//! etc.) call ExceptionCheck at the top of their implementation before making any
//! JNI call. If there is already a pending Java exception on the thread, they
//! return Err(JavaException) immediately — without invoking GetStaticMethodID,
//! without invoking CallStaticVoidMethod, without entering Kotlin at all.
//!
//! Tauri 2's Android IPC bridge performs JNI operations on the same Tokio worker
//! threads it dispatches commands on. If any of those operations encounter a Java
//! exception that is handled internally on the Java side but not explicitly cleared
//! at the JNI level before the thread returns to the pool, the exception persists
//! on the thread's JNI state. attach_current_thread() on an already-attached thread
//! reuses the existing env — including its stale exception state — so the orphaned
//! exception is still pending when trigger_android_picker() runs.
//!
//! Per the JNI spec, ExceptionCheck, ExceptionDescribe, and ExceptionClear are
//! among the handful of functions safe to call with a pending exception. Calling
//! ExceptionClear at the start of with_jni() resets the thread to a clean state
//! before any of our JNI operations run. This is an explicit transaction boundary:
//! any exception still pending here was either already handled by its owner or
//! orphaned by a caller that failed to clean up; either way it must not poison
//! unrelated JNI operations.

#[cfg(target_os = "android")]
use std::sync::OnceLock;

// ── Public types ──────────────────────────────────────────────────────────────

/// A file resolved to a path that tokio::fs::File::open can open.
pub struct ResolvedFile {
    pub name:      String,
    pub real_path: String,
    pub size:      u64,
    /// Absolute path of the temp cache copy, if one was created.
    /// Caller must delete after transfer completes.
    pub temp_path: Option<String>,
}

/// A file produced by the Android picker — already copied to cache.
#[cfg(target_os = "android")]
pub struct PickedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

// ── Android statics ───────────────────────────────────────────────────────────

/// JavaVM pointer — seeded by nativeInitJvm (called from RiftAndroidHelper.init).
/// Used by with_jni() to attach any thread to the VM.
#[cfg(target_os = "android")]
static JVM_GLOBAL: OnceLock<jni::JavaVM> = OnceLock::new();

/// GlobalRef to com.abyssprotocol.therift.RiftFilePicker.
/// Seeded by nativeRegisterPickerClass on the main thread.
/// Used by trigger_android_picker() to call RiftFilePicker.pickFiles().
#[cfg(target_os = "android")]
static PICKER_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

/// Oneshot sender side for the current in-progress pick operation.
/// Set by trigger_android_picker() before calling Kotlin.
/// Consumed by nativeOnFilesSelected() when Kotlin reports results.
#[cfg(target_os = "android")]
static PICK_SENDER: OnceLock<                                                // FIX 1: restored <
    std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Vec<PickedFile>>>>,
> = OnceLock::new();

// ── JNI exports: called from RiftAndroidHelper ───────────────────────────────

/// Called from Kotlin: RiftAndroidHelper.nativeInitJvm()
/// Stores the JavaVM pointer and caches the RiftAndroidHelper class GlobalRef.
/// Must run on the main thread so the app classloader is active.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftAndroidHelper_nativeInitJvm< // FIX 2: restored <
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    _class_param: jni::objects::JClass<'local>,
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

// ── JNI exports: called from RiftFilePicker ───────────────────────────────────

/// Called from Kotlin: RiftFilePicker.nativeRegisterPickerClass()
/// Caches a GlobalRef to RiftFilePicker so worker threads can call its static
/// methods without invoking FindClass (which would use the bootstrap loader).
/// Must run on the main thread — called from RiftFilePicker.register().
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeRegisterPickerClass< // FIX 3: restored <
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    class_param: jni::objects::JClass<'local>,
) {
    match env.new_global_ref(&class_param) {
        Ok(global_ref) => {
            if PICKER_CLASS.set(global_ref).is_ok() {
                eprintln!("[FilePicker] RiftFilePicker cached as GlobalRef");
            }
        }
        Err(e) => eprintln!("[FilePicker] new_global_ref(RiftFilePicker) failed: {e:?}"),
    }
}

/// Called from Kotlin: RiftFilePicker.nativeOnFilesSelected(paths: Array<String>)
/// Each element of `paths` is "displayName\nabsolutePath\nsizeBytes".
/// An empty array signals cancellation or complete failure.
/// Signals the waiting trigger_android_picker() via the PICK_SENDER oneshot.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftFilePicker_nativeOnFilesSelected< // FIX 4: restored <
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

    eprintln!("[FilePicker] nativeOnFilesSelected: {} file(s)", picked.len());

    // Signal the waiting trigger_android_picker() future.
    let mutex = PICK_SENDER.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = mutex.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(picked);
        } else {
            eprintln!("[FilePicker] nativeOnFilesSelected: no waiting sender (spurious call?)");
        }
    }
}

// ── Public API: Android file picker ──────────────────────────────────────────

/// Launches the Android file picker via Kotlin and waits for the user to
/// complete the selection (or cancel).
///
/// The entire copy-to-cache operation happens inside RiftFilePicker before
/// this future resolves. The returned PickedFile structs contain plain absolute
/// paths that tokio::fs::File::open can open without any URI or permission logic.
///
/// Returns an empty Vec if the user cancelled.
/// Returns Err on setup failure (class not registered, already in progress, etc.).
#[cfg(target_os = "android")]
pub async fn trigger_android_picker() -> anyhow::Result<Vec<PickedFile>> {
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Vec<PickedFile>>();

    // Register the sender before calling Kotlin — the callback could fire before
    // trigger_android_picker returns on a fast device.
    {
        let mutex = PICK_SENDER.get_or_init(|| std::sync::Mutex::new(None));
        let mut guard = mutex
            .lock()
            .map_err(|_| anyhow::anyhow!("PICK_SENDER mutex poisoned"))?;
        if guard.is_some() {
            anyhow::bail!(
                "A file picker is already open. \
                 Complete or cancel the current selection before starting a new one."
            );
        }
        *guard = Some(tx);
    }

    // Call RiftFilePicker.pickFiles() via JNI.
    // RiftFilePicker.pickFiles() posts to the main thread Handler and returns
    // immediately — it does not block.
    let jni_result = with_jni(|env| {
        let class_ref = PICKER_CLASS.get().ok_or_else(|| {
            anyhow::anyhow!(
                "RiftFilePicker class GlobalRef not registered. \
                 Ensure RiftFilePicker.register(this) is called from \
                 MainActivity.onCreate() before the activity starts."
            )
        })?;

        // SAFETY: PICKER_CLASS holds a JNI global reference for the process
        // lifetime. JClass::from_raw creates a thin wrapper over the same object;
        // valid for the duration of this JNI call frame.
        let class = unsafe { jni::objects::JClass::from_raw(class_ref.as_raw()) };

        eprintln!("[FilePicker] invoking RiftFilePicker.pickFiles() via JNI");

        env.call_static_method(&class, "pickFiles", "()V", &[])
            .map_err(|e| {
                // Dump the pending Java exception to stderr (appears in logcat under
                // RustStdoutStderr) BEFORE clearing it. This is the definitive
                // diagnostic: if this error path is still reached after the
                // exception_clear() added in with_jni(), exception_describe() will
                // show exactly which Java exception class is being thrown and from
                // where — NoSuchMethodError, NullPointerException, or otherwise.
                if env.exception_check().unwrap_or(false) {
                    eprintln!("[FilePicker] pending Java exception at JNI boundary:");
                    let _ = env.exception_describe();
                    let _ = env.exception_clear();
                }
                anyhow::anyhow!("RiftFilePicker.pickFiles() JNI failed: {e:?}")
            })?;

        eprintln!("[FilePicker] pickFiles() posted to main thread Handler — waiting for result");
        Ok(())
    });

    // If the JNI call itself failed, clean up the sender so the next call works.
    if let Err(e) = jni_result {
        let mutex = PICK_SENDER.get_or_init(|| std::sync::Mutex::new(None));
        if let Ok(mut guard) = mutex.lock() {
            guard.take();
        }
        return Err(e);
    }

    // Wait for nativeOnFilesSelected to signal completion.
    // 5-minute timeout: generous enough for manual file browsing but prevents
    // an indefinite hang if the callback is never fired due to a system bug.
    tokio::time::timeout(std::time::Duration::from_secs(300), rx)
        .await
        .map_err(|_| anyhow::anyhow!("File picker timed out after 5 minutes"))?
        .map_err(|_| anyhow::anyhow!("File picker result channel dropped unexpectedly"))
}

// ── resolve_paths: used by send_files ────────────────────────────────────────

/// Resolves each path to a ResolvedFile for the transfer layer.
///
/// In the new architecture, all paths arriving here are plain absolute cache
/// paths (pre-copied by RiftFilePicker on Android, or direct filesystem paths
/// on desktop). No content:// URI handling is needed or attempted.
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

// ── with_jni: internal helper ─────────────────────────────────────────────────

/// Attaches the current thread to the JavaVM and runs `f` with a valid JNIEnv.
/// Uses JVM_GLOBAL populated by nativeInitJvm.
///
/// Clears any pending Java exception on the env before dispatching to `f`.
/// See the module-level doc comment for why this is necessary and safe.
#[cfg(target_os = "android")]
fn with_jni<F, R>(f: F) -> anyhow::Result<R>
where
    F: FnOnce(&mut jni::JNIEnv<'_>) -> anyhow::Result<R>,
{
    let jvm = JVM_GLOBAL.get().ok_or_else(|| {
        anyhow::anyhow!(
            "Android JVM not initialised. \
             Ensure RiftAndroidHelper.init() is called from MainActivity.onCreate()."
        )
    })?;

    let mut env = jvm
        .attach_current_thread()
        .map_err(|e| anyhow::anyhow!("attach_current_thread failed: {e:?}"))?;

    // ── Clear stale pending exception ─────────────────────────────────────────
    //
    // jni-rs 0.21 "checked" methods (call_static_method, get_static_method_id,
    // etc.) call ExceptionCheck at the top of their implementation. If a pending
    // exception is detected they return Err(JavaException) immediately, before
    // making any JNI call and before any Kotlin code runs.
    //
    // Tauri 2's Android IPC bridge makes JNI calls on the same Tokio worker
    // threads used to run async commands. If any of those calls encounters a
    // Java exception that is handled internally on the Java side but not cleared
    // at the JNI layer, the exception lingers on the thread. When
    // attach_current_thread() reuses an already-attached thread it inherits that
    // stale exception state verbatim.
    //
    // ExceptionCheck, ExceptionDescribe, and ExceptionClear are explicitly listed
    // in the JNI spec as safe to call with a pending exception. Clearing here is
    // safe: this is an explicit transaction boundary, and any exception still
    // pending from prior work on this thread is either already handled or orphaned.
    if env.exception_check().unwrap_or(false) {
        eprintln!(
            "[FilePicker] WARNING: stale pending exception on JNI env (thread reuse artifact). \
             Clearing before dispatch. Exception details:"
        );
        // exception_describe() prints the exception class, message, and Java stack
        // trace to stderr. Visible in logcat under the RustStdoutStderr tag.
        // This line is the primary diagnostic if the picker is still broken after
        // this fix: the logcat will show exactly which Java exception was orphaned.
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }

    f(&mut env)
}