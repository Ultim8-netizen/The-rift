package com.abyssprotocol.therift

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.IOException

/**
 * JNI-accessible singleton. Provides ContentResolver access for content:// URIs
 * returned by the Android file picker (which Rust cannot open directly).
 *
 * Initialisation order (must be followed exactly):
 *   1. `init()` is called from `MainActivity.onCreate()` after `super.onCreate()`.
 *   2. `init()` stores `appContext` and then calls `nativeInitJvm()`.
 *   3. `nativeInitJvm()` (implemented in android_fs.rs) stores the `JavaVM`
 *      pointer in a Rust `OnceLock` that all Tokio blocking threads can access.
 *
 * Why `nativeInitJvm()` instead of `ndk_context`:
 *   The `ndk_context` crate stores its JVM pointer in statics that are private
 *   to a given .so linkage unit. Tauri initialises its own copy, but our
 *   cdylib has a separate copy that is never seeded, causing a fatal SIGABRT
 *   ("android context was not initialized") the first time a file is selected.
 *   Calling `nativeInitJvm()` from the Java side seeds our copy directly.
 *
 * Thread safety: `init()` is called once on the main thread. The @JvmStatic
 * methods are called from spawn_blocking threads (Tokio blocking pool) — both
 * only read `appContext` after init, which is safe because ApplicationContext
 * is immutable once set.
 */
object RiftAndroidHelper {

    private const val TAG = "RiftAndroidHelper"

    @Volatile
    private var appContext: Context? = null

    // ── Native initialisation ─────────────────────────────────────────────────

    /**
     * Implemented in android_fs.rs as
     * `Java_com_abyssprotocol_therift_RiftAndroidHelper_nativeInitJvm`.
     *
     * Stores the current JNIEnv's JavaVM pointer in a Rust OnceLock so that
     * Tokio blocking threads can attach to the JVM when performing file
     * operations. Must be called after the native library has been loaded
     * (i.e. after `TauriActivity.super.onCreate()` returns).
     */
    @JvmStatic
    private external fun nativeInitJvm()

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Initialises this singleton. Must be called from `MainActivity.onCreate()`
     * immediately after `super.onCreate(savedInstanceState)` returns.
     *
     * The call to `nativeInitJvm()` is wrapped in a try-catch so that a
     * missing native symbol (e.g. during a stripped release build with
     * mis-configured ProGuard) produces a log warning rather than a crash.
     */
    @JvmStatic
    fun init(ctx: Context) {
        appContext = ctx.applicationContext
        try {
            nativeInitJvm()
            Log.i(TAG, "JVM initialised for native file operations")
        } catch (e: UnsatisfiedLinkError) {
            // Native library not yet loaded — log and continue. File operations
            // will return a descriptive error from Rust rather than aborting.
            Log.e(TAG, "nativeInitJvm: native library not loaded — ${e.message}")
        }
        Log.i(TAG, "RiftAndroidHelper initialised")
    }

    // ── JNI-accessible helpers ────────────────────────────────────────────────

    /**
     * Queries display name and size for a content:// URI via ContentResolver.
     * Returns "displayName|sizeBytes". Returns "|0" on any failure.
     *
     * Called from android_fs::call_kotlin_string_method (blocking thread).
     */
    @JvmStatic
    fun queryUriInfo(uriString: String): String {
        val ctx = appContext ?: run {
            Log.e(TAG, "queryUriInfo called before init()")
            return "|0"
        }
        return try {
            val uri = Uri.parse(uriString)
            var name = ""
            var size = 0L

            ctx.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (cursor.moveToFirst()) {
                    if (nameIdx >= 0) name = cursor.getString(nameIdx) ?: ""
                    if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                        size = cursor.getLong(sizeIdx)
                    }
                }
            }

            // Fallback: use the last path segment of the URI as the name.
            if (name.isEmpty()) {
                name = uri.lastPathSegment ?: "file"
            }

            "$name|$size"
        } catch (e: Exception) {
            Log.e(TAG, "queryUriInfo failed for $uriString: ${e.message}")
            "|0"
        }
    }

    /**
     * Copies a content:// URI to the app's internal cache directory and returns
     * the absolute path of the cache file. Returns "" on any failure.
     *
     * Rust cannot open content:// URIs directly (no kernel-level support for
     * ContentResolver). This copy gives the transfer layer a real file path.
     * The caller (android_fs.rs) is responsible for deleting the cache file
     * after the transfer completes.
     *
     * Called from android_fs::call_kotlin_string_method (blocking thread).
     */
    @JvmStatic
    fun copyUriToCache(uriString: String): String {
        val ctx = appContext ?: run {
            Log.e(TAG, "copyUriToCache called before init()")
            return ""
        }
        return try {
            val uri = Uri.parse(uriString)

            // Derive a safe display name for the cache file.
            var displayName = "rift_${System.currentTimeMillis()}"
            ctx.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (cursor.moveToFirst() && nameIdx >= 0) {
                    cursor.getString(nameIdx)?.takeIf { it.isNotEmpty() }?.let {
                        displayName = it
                    }
                }
            }

            // Remove path separators so File() does not create subdirectories.
            val safeName = displayName
                .replace('/', '_')
                .replace('\\', '_')
                .replace(':', '_')

            val cacheFile = File(
                ctx.cacheDir,
                "rift_send_${System.currentTimeMillis()}_$safeName"
            )

            val inputStream = ctx.contentResolver.openInputStream(uri)
                ?: throw IOException(
                    "ContentResolver returned null InputStream for $uriString"
                )

            inputStream.use { input ->
                cacheFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            Log.i(TAG,
                "Copied $uriString → ${cacheFile.absolutePath} (${cacheFile.length()} B)")
            cacheFile.absolutePath
        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache failed for $uriString: ${e.message}")
            ""
        }
    }
}