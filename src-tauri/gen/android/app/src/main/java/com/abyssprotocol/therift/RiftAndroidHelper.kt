package com.abyssprotocol.therift

import android.content.Context
import android.content.Intent
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
 *      pointer AND a `GlobalRef` to this class in Rust `OnceLock`s.
 *      The GlobalRef is what allows Tokio worker threads to call static methods
 *      without hitting Android's bootstrap-classloader trap (FindClass failing
 *      on non-Java threads because no app classloader is on the stack).
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
     * Stores the current JNIEnv's JavaVM pointer AND caches a GlobalRef to
     * the RiftAndroidHelper class in Rust OnceLocks. Both must be set on
     * the main thread (here) where the app classloader is active.
     *
     * The GlobalRef fix: FindClass called from Tokio blocking threads uses the
     * bootstrap classloader, which cannot find app classes. By caching the
     * class as a GlobalRef here on the main thread, worker threads call
     * JClass::from_raw(cached_ref) instead, bypassing FindClass entirely.
     */
    @JvmStatic
    private external fun nativeInitJvm()

    // ── Public API ────────────────────────────────────────────────────────────

    @JvmStatic
    fun init(ctx: Context) {
        appContext = ctx.applicationContext
        try {
            nativeInitJvm()
            Log.i(TAG, "JVM and class GlobalRef initialised for native file operations")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "nativeInitJvm: native library not loaded — ${e.message}")
        }
        Log.i(TAG, "RiftAndroidHelper initialised")
    }

    // ── JNI-accessible helpers ────────────────────────────────────────────────

    /**
     * Queries display name and size for a content:// URI via ContentResolver.
     * Returns "displayName|sizeBytes". Returns "|0" on any failure.
     *
     * Also persists the URI read grant via takePersistableUriPermission so that
     * copyUriToCache() can still open the URI after the originating file-picker
     * Intent has been destroyed.
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

            // Persist the URI read grant so copyUriToCache() can open it later.
            // SecurityException is expected for URIs that don't support persistable
            // grants — log at WARN and continue; copyUriToCache() handles access
            // failures explicitly.
            try {
                ctx.contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
                Log.d(TAG, "URI grant persisted: $uriString")
            } catch (e: SecurityException) {
                Log.w(TAG, "URI grant not persistable ($uriString): ${e.message}")
            }

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
     * "absolutePath|fileSizeBytes" on success, or "" on failure.
     *
     * The size is taken from `cacheFile.length()` AFTER the copy completes,
     * giving Rust the accurate byte count without a separate metadata call.
     * This is important because `OpenableColumns.SIZE` is frequently null or 0
     * for Documents Provider URIs (e.g. content://com.android.providers.media
     * .documents/document/video%3A...), so the ContentResolver column cannot
     * be relied upon for size.
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

            var displayName = "rift_${System.currentTimeMillis()}"
            ctx.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (cursor.moveToFirst() && nameIdx >= 0) {
                    cursor.getString(nameIdx)?.takeIf { it.isNotEmpty() }?.let {
                        displayName = it
                    }
                }
            }

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

            // Read size from the actual cache file after copy — this is the
            // authoritative byte count that Rust uses for staging and the
            // transfer manifest.  ContentResolver's SIZE column is unreliable
            // for Documents Provider URIs and is intentionally not used here.
            val fileSize = cacheFile.length()
            Log.i(TAG,
                "Copied $uriString → ${cacheFile.absolutePath} ($fileSize B)")

            // Return "path|size" so Rust can parse both in one JNI call.
            "${cacheFile.absolutePath}|$fileSize"
        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache failed for $uriString: ${e.message}")
            ""
        }
    }
}