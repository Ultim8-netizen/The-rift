package com.abyssprotocol.therift

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * Owns the entire Android file-picker lifecycle for The Rift.
 *
 * Why this exists:
 * Android's content:// URI permissions from ACTION_GET_CONTENT are live only
 * within the calling process's task. Passing a URI string through Tauri's async
 * IPC → JS → Rust invoke → Tokio worker → JNI is unreliable: OEM builds
 * (TECNO/Transsion, Samsung, MIUI) enforce stricter URI permission checks tied
 * to the component that received onActivityResult, not the application UID.
 * Every attempt to fix this in the Rust layer is fighting the Android permission
 * model rather than respecting it.
 *
 * Correct approach: consume the URI — copy its bytes to the app's private cache
 * directory — immediately inside the activity result callback, before anything
 * leaves the Android layer. Rust then receives a plain absolute path it can open
 * with std::fs::File::open. No URI, no grant, no OEM variation.
 *
 * Registration:
 *   MainActivity.onCreate() must call RiftFilePicker.register(this) before the
 *   activity reaches STARTED state. registerForActivityResult() has this hard
 *   requirement.
 */
object RiftFilePicker {

    private const val TAG = "RiftFilePicker"

    // ActivityResultLauncher<String> — input is MIME type, output is List<Uri>.
    // GetMultipleContents uses ACTION_GET_CONTENT + CATEGORY_OPENABLE +
    // EXTRA_ALLOW_MULTIPLE. CATEGORY_OPENABLE guarantees openInputStream works.
    private var launcher: ActivityResultLauncher<String>? = null

    // ── Registration ──────────────────────────────────────────────────────────

    /**
     * Must be called from MainActivity.onCreate(), before onStart().
     * Registers the ActivityResultLauncher and caches the class GlobalRef in Rust.
     */
    fun register(activity: MainActivity) {
        launcher = activity.registerForActivityResult(
            ActivityResultContracts.GetMultipleContents()
        ) { uris ->
            onPickerResult(activity, uris)
        }
        Log.i(TAG, "ActivityResultLauncher registered")

        // Cache this class as a JNI GlobalRef in Rust now — while we are on the
        // main thread and the app class loader is active. Worker threads cannot
        // call FindClass for app classes; they must use the cached ref.
        try {
            nativeRegisterPickerClass()
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "nativeRegisterPickerClass: native library not loaded yet — ${e.message}")
        }
    }

    // ── JNI entry point called from Rust ─────────────────────────────────────

    /**
     * Called from Rust's trigger_android_picker() via JNI.
     * Posts launch() to the main thread (JNI may call from any Tokio thread).
     */
    @JvmStatic
    fun pickFiles() {
        val l = launcher
        if (l == null) {
            Log.e(TAG, "pickFiles() called before register() — signalling empty result")
            nativeOnFilesSelected(emptyArray())
            return
        }
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            try {
                l.launch("*/*")
            } catch (e: Exception) {
                Log.e(TAG, "launcher.launch() failed: ${e.message}")
                nativeOnFilesSelected(emptyArray())
            }
        }
    }

    // ── Activity result callback ──────────────────────────────────────────────

    /**
     * Called on the main thread when the system picker returns.
     * Spawns a single worker thread to copy all URIs to cache.
     * The URI permission is live: we are within the task that received the grant,
     * and the copying thread is spawned while the Activity is still in the
     * foreground (it cannot be destroyed while we are in this callback).
     */
    private fun onPickerResult(context: Context, uris: List<Uri>) {
        if (uris.isEmpty()) {
            // User cancelled or dismissed the picker without selecting anything.
            nativeOnFilesSelected(emptyArray())
            return
        }

        // Copy on a background thread — do NOT block the main thread.
        // The URI permission remains valid for the task lifetime, so the worker
        // thread can open any of these URIs.
        Thread {
            val results = mutableListOf<String>()
            for (uri in uris) {
                val entry = copyUriToCache(context, uri)
                if (entry != null) results.add(entry)
            }
            nativeOnFilesSelected(results.toTypedArray())
        }.start()
    }

    // ── File copy ─────────────────────────────────────────────────────────────

    /**
     * Copies one content:// URI to the app's private cache directory.
     *
     * Returns "displayName\nabsolutePath\nsizeBytes" on success.
     * Returns null if the file cannot be read (error logged).
     *
     * Called from the worker thread spawned in onPickerResult, which is within
     * the same task as the Activity that received the URI grant. The context
     * passed here IS the Activity — its ContentResolver carries the permission.
     */
    private fun copyUriToCache(context: Context, uri: Uri): String? {
        return try {
            val resolver = context.contentResolver

            // ── 1. Resolve display name ───────────────────────────────────────
            var displayName = "file_${System.currentTimeMillis()}"
            try {
                resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val col = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (cursor.moveToFirst() && col >= 0) {
                        cursor.getString(col)?.takeIf { it.isNotBlank() }
                            ?.let { displayName = it }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Could not query display name for $uri: ${e.message}")
            }

            // Sanitise: replace any characters that are invalid in file names.
            val safeName = displayName
                .replace('/', '_').replace('\\', '_')
                .replace(':', '_').replace('*', '_')
                .replace('?', '_').replace('"', '_')
                .replace('<', '_').replace('>', '_')
                .replace('|', '_')

            val dest = File(
                context.cacheDir,
                "rift_send_${System.currentTimeMillis()}_$safeName"
            )

            // ── 2. Open source stream ─────────────────────────────────────────
            // Primary path: openInputStream. Works on all standard providers.
            // Fallback: openFileDescriptor → FileInputStream. Required for some
            // Samsung Gallery and TECNO Documents providers that return null
            // from openInputStream but succeed via a file descriptor.
            val inputStream = resolver.openInputStream(uri)
                ?: run {
                    Log.w(TAG, "openInputStream null for $uri — trying openFileDescriptor")
                    val pfd = resolver.openFileDescriptor(uri, "r")
                        ?: throw IOException(
                            "Both openInputStream and openFileDescriptor returned null for $uri"
                        )
                    FileInputStream(pfd.fileDescriptor)
                }

            // ── 3. Copy ───────────────────────────────────────────────────────
            inputStream.use { input ->
                dest.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            val size = dest.length()
            if (size == 0L) {
                dest.delete()
                Log.e(TAG, "Cache copy is 0 bytes for $uri — dropping file")
                return null
            }

            Log.i(TAG, "Cached $uri → ${dest.absolutePath} ($size B)")

            // Newline-delimited: name, absolute path, size.
            // Newlines cannot appear in file names or absolute paths.
            "$displayName\n${dest.absolutePath}\n$size"

        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache failed for $uri: ${e.javaClass.simpleName}: ${e.message}")
            null
        }
    }

    // ── JNI declarations ──────────────────────────────────────────────────────

    // Called from register() on the main thread to cache the RiftFilePicker
    // class GlobalRef in Rust. Must happen on the main thread so the app class
    // loader is active (FindClass from a worker thread would use the bootstrap
    // loader and fail to find app classes).
    @JvmStatic
    private external fun nativeRegisterPickerClass()

    // Called from the worker thread when all file copies are done.
    // paths: each element is "displayName\nabsolutePath\nsizeBytes".
    // Empty array signals cancellation or total failure.
    @JvmStatic
    private external fun nativeOnFilesSelected(paths: Array<String>)
}