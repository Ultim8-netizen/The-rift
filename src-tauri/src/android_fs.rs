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
//! ─────────────────────────────────────────────────────────────────────────
// ── Public types ──────────────────────────────────────────────────────────────

pub struct FileInfo {
    pub name: String,
    pub size: u64,
}

pub struct ResolvedFile {
    /// Display name to use as the file name on the receiving device.
    pub name: String,
    /// A path that `tokio::fs::File::open` can open successfully.
    pub real_path: String,
    /// Byte count from ContentResolver (or from fs::metadata on non-Android).
    pub size: u64,
    /// Absolute path of the temp cache copy we created, if any.
    /// The caller MUST delete this file after the transfer completes.
    pub temp_path: Option<String>,
}

// ── Android JVM storage ───────────────────────────────────────────────────────

/// Stores the `JavaVM` pointer supplied by `RiftAndroidHelper.nativeInitJvm()`.
///
/// `jni::JavaVM` is `Send + Sync` (it wraps a process-wide singleton pointer),
/// so placing it in a `static OnceLock` is safe.
#[cfg(target_os = "android")]
static JVM_GLOBAL: OnceLock<jni::JavaVM> = OnceLock::new();

/// JNI export called from Kotlin as `RiftAndroidHelper.nativeInitJvm()`.
///
/// This is the ONLY place `JavaVM` is captured.  It must be called from the
/// main thread (inside `MainActivity.onCreate`, after `super.onCreate`) so
/// that the JNI environment is fully set up before any Tokio worker thread
/// attempts a file-picker operation.
///
/// If the `OnceLock` is already populated (e.g. on a configuration-change
/// Activity recreation) the call is a no-op.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_abyssprotocol_therift_RiftAndroidHelper_nativeInitJvm<'local>(
    env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
) {
    match env.get_java_vm() {
        Ok(vm) => {
            // OnceLock::set returns Err if already set — that is fine.
            if JVM_GLOBAL.set(vm).is_ok() {
                eprintln!("[AndroidFS] JavaVM stored — JNI file ops enabled");
            }
        }
        Err(e) => {
            // Non-fatal: log and continue.  File operations will return a
            // descriptive error rather than aborting the process.
            eprintln!("[AndroidFS] get_java_vm failed: {e:?}");
        }
    }
}

// ── get_file_info (sync — wrap in spawn_blocking from async contexts) ─────────

/// Returns the display name and byte size for `path`.
/// On Android, `path` may be a `content://` URI; uses ContentResolver.query.
/// On all other platforms, uses `std::path` and `std::fs::metadata`.
pub fn get_file_info(path: &str) -> FileInfo {
    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        return android_query_uri_info(path);
    }

    let p = std::path::Path::new(path);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    FileInfo { name, size }
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
///
/// Returns `Err` only if a copy fails (e.g. storage full, permission denied).
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
/// Uses `JVM_GLOBAL` (populated by `nativeInitJvm`) instead of
/// `ndk_context::android_context()`.  Returns a descriptive `Err` rather
/// than aborting the process if initialisation has not yet occurred.
///
/// `attach_current_thread` is idempotent: if the calling thread is already
/// attached, it returns the existing env.  The `AttachGuard` only detaches
/// on drop if *this call* was responsible for attaching, so there is no risk
/// of detaching a thread that Tauri's runtime is mid-flight on.
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

/// Calls `RiftAndroidHelper.<method>(uriString): String` and returns the
/// Rust String result. Clears any pending Java exception before propagating
/// JNI errors so subsequent calls on the same thread are not poisoned.
#[cfg(target_os = "android")]
fn call_kotlin_string_method(uri: &str, method: &str) -> anyhow::Result<String> {
    with_jni(|env| {
        let class = env
            .find_class("com/abyssprotocol/therift/RiftAndroidHelper")
            .map_err(|e| {
                let _ = env.exception_clear();
                anyhow::anyhow!("find_class RiftAndroidHelper: {e:?}")
            })?;

        let uri_jstr = env
            .new_string(uri)
            .map_err(|e| anyhow::anyhow!("new_string({uri}): {e:?}"))?;

        // (&*uri_jstr) derefs JString → JObject, then Into<JValue::Object>.
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

/// Calls `RiftAndroidHelper.queryUriInfo` and parses the "name|size" response.
#[cfg(target_os = "android")]
fn android_query_uri_info(uri: &str) -> FileInfo {
    match call_kotlin_string_method(uri, "queryUriInfo") {
        Ok(s) => {
            let mut parts = s.splitn(2, '|');
            let name = parts.next().unwrap_or("unknown");
            let name = if name.is_empty() { "unknown" } else { name }.to_string();
            let size = parts.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            FileInfo { name, size }
        }
        Err(e) => {
            eprintln!("[AndroidFS] queryUriInfo JNI error: {e}");
            FileInfo {
                name: "unknown".to_string(),
                size: 0,
            }
        }
    }
}

/// Copies a content:// URI to the cache directory via JNI and builds a
/// `ResolvedFile` the transfer layer can open with `File::open`.
#[cfg(target_os = "android")]
fn android_copy_uri(uri: &str) -> anyhow::Result<ResolvedFile> {
    // Step 1: get display name and declared size (cheap, no I/O).
    let info_str = call_kotlin_string_method(uri, "queryUriInfo")
        .unwrap_or_else(|_| "|0".to_string());

    let mut parts = info_str.splitn(2, '|');
    let name = {
        let n = parts.next().unwrap_or("file");
        if n.is_empty() { "file" } else { n }.to_string()
    };
    let declared_size: u64 = parts
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    // Step 2: copy URI bytes to cache (blocking I/O — called from spawn_blocking).
    let cache_path = call_kotlin_string_method(uri, "copyUriToCache")
        .map_err(|e| anyhow::anyhow!("copyUriToCache JNI: {e}"))?;

    if cache_path.is_empty() {
        anyhow::bail!(
            "Could not read '{name}' — check storage permissions and that the file still exists."
        );
    }

    // Prefer the size from the actual cache file; ContentResolver sometimes
    // returns 0 for SIZE (e.g. cloud-backed documents not yet downloaded).
    let actual_size = if declared_size == 0 {
        std::fs::metadata(&cache_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        declared_size
    };

    if actual_size == 0 {
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