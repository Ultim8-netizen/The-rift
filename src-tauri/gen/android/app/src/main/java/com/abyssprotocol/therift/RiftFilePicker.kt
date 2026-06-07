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
 *
 * ── Thread-safety: why @Volatile is required ─────────────────────────────────
 *
 * `launcher` is written on the MAIN THREAD in register() and read from a JNI
 * WORKER THREAD in pickFiles() (Rust's pick_files_for_send Tauri command runs
 * on a Tokio thread that is attached to the JVM via AttachCurrentThread).
 *
 * The Java Memory Model (JMM, JSR-133) guarantees that a write to a field is
 * visible to a subsequent read on another thread ONLY if there is a
 * happens-before edge between the write and the read. Without @Volatile or
 * explicit synchronisation, no such edge exists here — the JMM explicitly
 * permits (and compilers/CPUs exploit) the read seeing a stale cached value.
 *
 * On x86 the strong TSO memory model makes this benign in practice. On ARM —
 * specifically Cortex-A53 and A55, the MediaTek Helio G85/G88/G96 cores found
 * in TECNO Camon/Spark, Infinix Hot/Note, and Itel P-series — stores are
 * locally buffered and are NOT immediately visible to other cores without a
 * barrier. The Tokio thread can therefore observe launcher == null even if
 * register() has already completed on the main thread.
 *
 * When pickFiles() sees null it falls into the null-launcher path and calls
 * nativeOnFilesSelected(emptyArray()). If nativeOnFilesSelected is registered
 * only through RegisterNatives (inside nativeRegisterPickerClass()) rather than
 * via JNI_OnLoad name-mangling, and nativeRegisterPickerClass() has not yet
 * completed, that call throws UnsatisfiedLinkError. UnsatisfiedLinkError is a
 * Throwable, not caught by any try-catch in the original pickFiles(), so it
 * escapes across the JNI boundary. The jni Rust crate surfaces a pending Java
 * exception as Err(Error::JavaException). Rust formats this as:
 *
 *   "RiftFilePicker.pickFiles() JNI failed: JavaException"
 *
 * exactly what is visible in the UI error banner.
 *
 * @Volatile inserts StoreStore + LoadStore barriers on the write site and a
 * LoadLoad + StoreLoad barrier on the read site, guaranteeing the JNI thread
 * always sees the launcher value that register() committed.
 */
object RiftFilePicker {

    private const val TAG = "RiftFilePicker"

    /**
     * @Volatile enforces JMM happens-before between the main-thread write in
     * register() and the JNI worker-thread read in pickFiles().
     * Mandatory for correctness on weakly-ordered ARM micro-architectures.
     */
    @Volatile
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
        } catch (e: Throwable) {
            // Broadened from UnsatisfiedLinkError only. Any other Throwable escaping
            // here (e.g. a Rust panic converted to a RuntimeException, or a JNI
            // internal error) would propagate into MainActivity.onCreate() and crash
            // the app at startup — a worse outcome than the degraded state logged here.
            Log.e(TAG, "nativeRegisterPickerClass: unexpected error (${e::class.simpleName}): ${e.message}")
        }
    }

    // ── JNI entry point called from Rust ─────────────────────────────────────

    /**
     * Called from Rust's trigger_android_picker() via JNI on a Tokio worker thread.
     *
     * CONTRACT: This method MUST NOT allow any exception to escape across the JNI
     * boundary. The jni Rust crate converts any pending Java exception into
     * Err(Error::JavaException), causing the entire pick_files_for_send command to
     * fail and display "RiftFilePicker.pickFiles() JNI failed: JavaException" in
     * the UI. Every code path in this method is therefore guarded with
     * try-catch(Throwable).
     *
     * Posts launch() to the main thread (JNI may call from any Tokio thread) and
     * returns immediately. Results arrive later via nativeOnFilesSelected().
     */
    @JvmStatic
    fun pickFiles() {
        try {
            val l = launcher
            if (l == null) {
                // With @Volatile this path should never be reached in normal operation:
                // register() runs in onCreate() before the WebView renders and the user
                // can interact with any UI control. The path is preserved as a defensive
                // fallback — if somehow reached, signal empty result immediately so the
                // Rust channel receiver unblocks rather than hanging indefinitely.
                Log.e(TAG, "pickFiles() called before register() — signalling empty result")
                safeSignalEmpty()
                return
            }

            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try {
                    l.launch("*/*")
                } catch (e: Throwable) {
                    // Changed from catch(Exception) to catch(Throwable).
                    //
                    // Exception catches most cases (ActivityNotFoundException,
                    // IllegalStateException from lifecycle mismatch). But Error
                    // subclasses — OutOfMemoryError, StackOverflowError — are not
                    // Exception and would escape uncaught, silently leaving Rust
                    // blocked on its channel receiver. Catching Throwable here ensures
                    // safeSignalEmpty() always runs and Rust always unblocks.
                    Log.e(TAG, "launcher.launch() failed (${e::class.simpleName}): ${e.message}")
                    safeSignalEmpty()
                }
            }
        } catch (e: Throwable) {
            // Top-level safety net for anything outside the Handler.post block —
            // theoretically unreachable (Looper.getMainLooper() does not throw on
            // a running Activity, Handler construction does not throw), but present
            // as an absolute guarantee that pickFiles() never propagates a Throwable
            // to the JNI caller.
            Log.e(TAG, "pickFiles() unexpected error (${e::class.simpleName}): ${e.message}")
            safeSignalEmpty()
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

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Calls nativeOnFilesSelected(emptyArray()) without throwing.
     *
     * This is the canonical "unblock Rust" signal for all error-fallback paths.
     * Centralising it here means every failure path — null launcher, launch()
     * crash, top-level exception — goes through a single, exception-safe call site.
     *
     * If nativeOnFilesSelected itself throws (e.g. UnsatisfiedLinkError if
     * nativeRegisterPickerClass() never ran successfully and the native method was
     * not registered via JNI_OnLoad, or a Rust panic wrapped as a Java exception),
     * the exception is swallowed and logged. Rust will time out on its channel
     * receiver rather than receive an explicit empty result — an acceptable degraded
     * state compared to the JavaException that would otherwise crash the command.
     */
    private fun safeSignalEmpty() {
        try {
            nativeOnFilesSelected(emptyArray())
        } catch (e: Throwable) {
            Log.e(TAG, "safeSignalEmpty: nativeOnFilesSelected threw (${e::class.simpleName}): ${e.message}")
            // Cannot unblock Rust's channel receiver. The pick_files_for_send
            // command must rely on its own timeout to recover.
        }
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