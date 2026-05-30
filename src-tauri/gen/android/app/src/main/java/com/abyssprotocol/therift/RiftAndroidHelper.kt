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
 * init() MUST be called from MainActivity.onCreate() before any Tauri command
 * fires. All @JvmStatic methods are called from android_fs.rs via JNI.
 *
 * Thread safety: init() is called once on the main thread. The JNI methods run
 * on spawn_blocking threads (Tokio blocking pool) — both only read appContext
 * after init, which is safe because ApplicationContext is immutable once set.
 */
object RiftAndroidHelper {

    private const val TAG = "RiftAndroidHelper"

    @Volatile
    private var appContext: Context? = null

    @JvmStatic
    fun init(ctx: Context) {
        appContext = ctx.applicationContext
        Log.i(TAG, "Initialized")
    }

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
                ?: throw IOException("ContentResolver returned null InputStream for $uriString")

            inputStream.use { input ->
                cacheFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            Log.i(TAG, "Copied $uriString → ${cacheFile.absolutePath} (${cacheFile.length()} B)")
            cacheFile.absolutePath
        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache failed for $uriString: ${e.message}")
            ""
        }
    }
}