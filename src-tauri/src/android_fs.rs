//! Platform-aware file info and path resolver.
//!
//! Android file pickers return `content://` URIs. The Rust layer cannot open
//! these directly — the kernel has no ContentResolver. This module resolves
//! them to real file paths Rust can `File::open`.
//!
//! ── Android JVM initialisation ────────────────────────────────────────────
//! The previous implementation called `ndk_context::android_context().vm()`
//! to obtain the JavaVM pointer.  This caused a fatal SIGABRT with the
//! message "android context was not initialized" the first time a file was
//! selected, because `ndk_context` stores its state in process-global statics
//! that are private to whichever .so called `initialize_android_context`.
//! Tauri initialises its own copy; our cdylib has a separate copy that is
//! never seeded.
//!
//! Fix: `RiftAndroidHelper.init()` in Kotlin calls the JNI function
//! `nativeInitJvm()`, whose Rust implementation stores the `JavaVM` in our
//! own `OnceLock`.  All subsequent JNI calls on any Tokio thread use that
//! stored pointer instead of ndk_context.  The `ndk-context` crate remains
//! in Cargo.toml as a transitive dependency of Tauri but is no longer used
//! directly from this file.
//!
//! ── Android JNI class-loading fix ─────────────────────────────────────────
//! `JNIEnv::FindClass` in Android uses the class loader of the CALLING
//! THREAD's top Java stack frame.  Tokio blocking threads that were attached
//! via `attach_current_thread()` have no Java frames on their stack, so the
//! JVM falls back to the BOOTSTRAP class loader — which knows JDK built-ins
//! but has never heard of app classes such as
//! `com.abyssprotocol.therift.RiftAndroidHelper`.
//!
//! Consequence: `env.find_class("com/abyssprotocol/therift/RiftAndroidHelper")`
//! silently returned `Err` on every Tokio worker call.  `copyUriToCache` and
//! `queryUriInfo` were never reached.  `android_copy_uri` returned `Err`, and
//! `get_file_metadata` fell through to its 0-byte stub, preserving the raw
//! `content://` URI as the staged path.  When `send_files` later tried to
//! re-resolve that URI (possibly after the ephemeral grant had expired), it
//! also returned `Err`, and nothing was ever sent.
//!
//! Fix: `nativeInitJvm` now caches the `RiftAndroidHelper` class as a JNI
//! `GlobalRef` while still on the MAIN THREAD (where the app class loader is
//! active).  All subsequent calls from worker threads obtain a `JClass` via
//! `JClass::from_raw(class_ref.as_raw())` — `FindClass` is never called again,
//! bypassing the classloader trap entirely.
//! ─────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
use std::sync::OnceLock;

// ── Public types ──────────────────────────────────────────────────────────────

pub struct ResolvedFile {
    /// Display name to use as the file name on the receiving device.
    pub name: String,
    /// A path that `tokio::fs::File::open` can open successfully.
    pub real_path: String,
    /// Byte count (from cache file after copy, or from fs::metadata on
    /// non-Android).
    pub size: u64,
    /// Absolute path of the temp cache copy we created, if any.
    /// The caller MUST delete this file after the transfer completes.
    pub temp_path: Option<String>,
}

// ── Android static singletons ─────────────────────────────────────────────────

/// JavaVM pointer seeded by `nativeInitJvm`; used by all worker threads to
/// attach and make JNI calls.
#[cfg(target_os = "android")]
static JVM_GLOBAL: OnceLock<jni::JavaVM> = OnceLock::new();

/// Cached `GlobalRef` to `com.abyssprotocol.therift.RiftAndroidHelper`.
///
/// Must be set on the MAIN THREAD (inside `nativeInitJvm`) where the app
/// class loader is active.  Worker threads then call
/// `JClass::from_raw(HELPER_CLASS.get().unwrap().as_raw())` to obtain a
/// usable `JClass` without ever invoking `FindClass`.
///
/// `GlobalRef` is `Send + Sync` — safe to store in a process-wide static.
#[cfg(target_os = "android")]
static HELPER_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

// ── JNI export: nativeInitJvm ────────────────────────────────────────────────

/// Called from Kotlin as `RiftAndroidHelper.nativeInitJvm()`.
///
/// Stores the `JavaVM` pointer AND caches a `GlobalRef` to the
/// `RiftAndroidHelper` class.  Both operations MUST happen here — on the
/// main thread, via the JNIEnv passed by the JVM — because:
///   • `get_java_vm()` extracts the VM from the current env (no class loading).
///   • `new_global_ref(class_param)` uses `class_param`, which the JVM already
///     resolved with the correct app class loader before dispatching the call.
///     Calling `find_class` from a worker thread later would use the bootstrap
///     loader instead, silently failing to find app classes.
///
/// `class_param` is the second argument of every static JNI method — the JVM
/// passes the declaring class itself, which IS `RiftAndroidHelper`.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftAndroidHelper_nativeInitJvm<'local>(
    mut env: jni::JNIEnv<'local>,
    class_param: jni::objects::JClass<'local>,
) {
    // ── 1. Store the JavaVM pointer ───────────────────────────────────────────
    match env.get_java_vm() {
        Ok(vm) => {
            if JVM_GLOBAL.set(vm).is_ok() {
                eprintln!("[AndroidFS] JavaVM stored — JNI file ops enabled");
            }
            // Err means already set (Activity recreation) — that is fine.
        }
        Err(e) => {
            eprintln!("[AndroidFS] get_java_vm failed: {e:?}");
        }
    }

    // ── 2. Cache the RiftAndroidHelper class as a GlobalRef ───────────────────
    // Converting to a GlobalRef prevents the JVM from GC-ing the class object
    // and allows worker threads to reference it without FindClass.
    match env.new_global_ref(class_param) {
        Ok(global_ref) => {
            if HELPER_CLASS.set(global_ref).is_ok() {
                eprintln!(
                    "[AndroidFS] RiftAndroidHelper cached as GlobalRef \
                     — classloader fix active"
                );
            }
            // Err means already set (Activity recreation) — that is fine.
        }
        Err(e) => {
            eprintln!(
                "[AndroidFS] new_global_ref(RiftAndroidHelper) failed: {e:?} \
                 — file ops WILL FAIL on worker threads"
            );
        }
    }
}

// ── resolve_paths (async) ─────────────────────────────────────────────────────

/// Resolves every path in `paths` to a `ResolvedFile`.
///
/// For Android `content://` URIs: copies the file to the app cache directory
/// via JNI → ContentResolver. The temp file path is returned in
/// `ResolvedFile::temp_path`; the caller must delete it after transfer.
///
/// For regular file system paths (all platforms): returns the path unchanged
/// with no temp file created.
pub async fn resolve_paths(paths: &[String]) -> anyhow::Result<Vec<ResolvedFile>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(resolve_single(path).await?);
    }
    Ok(out)
}

async fn resolve_single(path: &str) -> anyhow::Result<ResolvedFile> {
    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        let owned = path.to_string();
        return tokio::task::spawn_blocking(move || android_copy_uri(owned.as_str()))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking panicked: {e}"))?;
    }

    // Regular file path — stat only, no copy.
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

// ── Android JNI implementation ────────────────────────────────────────────────

/// Attaches the current thread to the JavaVM and runs `f` with a valid
/// `JNIEnv`.
///
/// Uses `JVM_GLOBAL` (populated by `nativeInitJvm`).  Returns a descriptive
/// `Err` rather than aborting the process if initialisation has not yet
/// occurred.
///
/// `attach_current_thread` is idempotent: if the calling thread is already
/// attached, it returns the existing env.  The `AttachGuard` only detaches on
/// drop if *this call* was responsible for attaching.
#[cfg(target_os = "android")]
fn with_jni<F, R>(f: F) -> anyhow::Result<R>
where
    F: FnOnce(&mut jni::JNIEnv<'_>) -> anyhow::Result<R>,
{
    let jvm = JVM_GLOBAL.get().ok_or_else(|| {
        anyhow::anyhow!(
            "Android JVM not initialised — ensure RiftAndroidHelper.init() is called \
             from MainActivity.onCreate() before any file operation is attempted"
        )
    })?;

    let mut env = jvm
        .attach_current_thread()
        .map_err(|e| anyhow::anyhow!("attach_current_thread failed: {e:?}"))?;

    f(&mut env)
}

/// Calls `RiftAndroidHelper.<method>(uriString): String` using the cached
/// class `GlobalRef`, completely bypassing `FindClass`.
///
/// The `GlobalRef` in `HELPER_CLASS` prevents the class object from being
/// garbage-collected, making it safe to reconstruct a `JClass` from its raw
/// pointer on any thread at any time.
#[cfg(target_os = "android")]
fn call_kotlin_string_method(uri: &str, method: &str) -> anyhow::Result<String> {
    with_jni(|env| {
        // ── Obtain class from cached GlobalRef (no FindClass) ─────────────────
        let class_ref = HELPER_CLASS.get().ok_or_else(|| {
            anyhow::anyhow!(
                "RiftAndroidHelper class GlobalRef not cached — \
                 nativeInitJvm may have failed to store the class reference. \
                 Check logcat for '[AndroidFS] new_global_ref' errors."
            )
        })?;

        // SAFETY: `HELPER_CLASS` holds a JNI global reference for the entire
        // process lifetime, preventing garbage collection of the class object.
        // `JClass::from_raw` creates a thin pointer wrapper over the same
        // object; it is valid for the duration of this JNI call frame.
        let class: jni::objects::JClass<'_> = unsafe {
            jni::objects::JClass::from_raw(class_ref.as_raw())
        };

        // ── Build arguments ────────────────────────────────────────────────────
        let uri_jstr = env
            .new_string(uri)
            .map_err(|e| anyhow::anyhow!("new_string({uri}): {e:?}"))?;

        // ── Invoke static method ───────────────────────────────────────────────
        let result = env
            .call_static_method(
                &class,
                method,
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[(&*uri_jstr).into()],
            )
            .map_err(|e| {
                let _ = env.exception_clear();
                anyhow::anyhow!("call_static_method {method}: {e:?}")
            })?;

        // ── Extract String result ──────────────────────────────────────────────
        let jobj = result
            .l()
            .map_err(|e| anyhow::anyhow!("JValueOwned::l(): {e:?}"))?;

        if jobj.is_null() {
            return Ok(String::new());
        }

        let jstr = jni::objects::JString::from(jobj);
        let rust_str: String = env
            .get_string(&jstr)
            .map_err(|e| anyhow::anyhow!("get_string: {e:?}"))?
            .into();

        Ok(rust_str)
    })
}

/// Copies a `content://` URI to the cache directory via JNI and builds a
/// `ResolvedFile` the transfer layer can open with `File::open`.
///
/// `copyUriToCache` returns `"absolutePath|fileSizeBytes"` so Rust obtains
/// the accurate post-copy size directly from Kotlin (after `cacheFile.length()`),
/// without a separate `std::fs::metadata` call that could be affected by path
/// encoding or permission quirks.
#[cfg(target_os = "android")]
fn android_copy_uri(uri: &str) -> anyhow::Result<ResolvedFile> {
    // ── Step 1: display name + declared size (no I/O, non-fatal on failure) ───
    let info_str = call_kotlin_string_method(uri, "queryUriInfo")
        .unwrap_or_else(|e| {
            eprintln!("[AndroidFS] queryUriInfo failed (non-fatal, copy will still proceed): {e}");
            "|0".to_string()
        });

    let mut info_parts = info_str.splitn(2, '|');
    let name = {
        let n = info_parts.next().unwrap_or("file");
        if n.is_empty() { "file" } else { n }.to_string()
    };
    let declared_size: u64 = info_parts
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // ── Step 2: copy URI bytes → app cache ────────────────────────────────────
    // Returns "absoluteCachePath|fileSizeBytes".
    let copy_result = call_kotlin_string_method(uri, "copyUriToCache")
        .map_err(|e| anyhow::anyhow!("copyUriToCache JNI failed: {e}"))?;

    if copy_result.is_empty() {
        anyhow::bail!(
            "Could not read '{name}' — check storage permissions and that \
             the file still exists."
        );
    }

    // ── Parse "cache_path|size_bytes" ─────────────────────────────────────────
    // rfind guards against (highly unlikely) '|' characters in the cache path.
    let (cache_path, copy_size) = match copy_result.rfind('|') {
        Some(sep) => {
            let path = copy_result[..sep].to_string();
            let size: u64 = copy_result[sep + 1..].parse().unwrap_or(0);
            (path, size)
        }
        // Fallback: Kotlin returned just a path with no size (should not happen
        // with the updated copyUriToCache, but handled defensively).
        None => (copy_result, 0u64),
    };

    if cache_path.is_empty() {
        anyhow::bail!("Could not read '{name}': cache copy returned an empty path.");
    }

    // ── Determine actual file size ────────────────────────────────────────────
    // Preference order:
    //   1. copy_size  — from cacheFile.length() after the copy (most accurate).
    //   2. declared_size — from ContentResolver SIZE column (often 0 for
    //      Documents Provider URIs, so only use as fallback).
    //   3. std::fs::metadata — last resort if both above are 0.
    let actual_size = if copy_size > 0 {
        copy_size
    } else if declared_size > 0 {
        declared_size
    } else {
        std::fs::metadata(&cache_path).map(|m| m.len()).unwrap_or(0)
    };

    if actual_size == 0 {
        // The file is genuinely empty — clean up and surface a clear error.
        let _ = std::fs::remove_file(&cache_path);
        anyhow::bail!("'{name}' appears to be empty (0 bytes). Nothing to send.");
    }

    eprintln!("[AndroidFS] Resolved '{name}' → {cache_path} ({actual_size} B)");

    Ok(ResolvedFile {
        name,
        real_path: cache_path.clone(),
        size: actual_size,
        temp_path: Some(cache_path),
    })
}