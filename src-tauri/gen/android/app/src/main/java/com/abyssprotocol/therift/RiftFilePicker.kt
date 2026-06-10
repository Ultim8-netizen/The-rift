package com.abyssprotocol.therift

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns the entire Android file-picker lifecycle for The Rift.
 *
 * ── Root-cause history ────────────────────────────────────────────────────────
 *
 * GENERATION 1 (broken): Rust called RiftFilePicker.pickFiles() via
 * env.call_static_method(). jni-rs 0.21 calls ExceptionCheck at the top of
 * every checked JNI method. Tauri's IPC bridge leaves stale pending exceptions
 * on its Tokio worker threads. Reused threads surfaced the stale exception as
 * Err(JavaException) before Kotlin was ever reached.
 *
 * GENERATION 2 (incomplete): android_fs.rs was rewritten to set PICK_REQUESTED
 * (an AtomicBool) instead of calling Kotlin via JNI. A Kotlin daemon thread
 * was supposed to poll nativeGetPickRequest() and launch the picker. The Rust
 * side was correct but the Kotlin daemon was never implemented — PICK_REQUESTED
 * was set but nothing ever read it, so the 5-minute timeout always elapsed and
 * Tier 3 (directory scan) produced the error banner.
 *
 * GENERATION 3 (this file): Kotlin daemon implemented (startPickPoller).
 * Contract changed from GetMultipleContents → OpenMultipleDocuments.
 * pickerInFlight guard + onResume clearing added.
 *
 * ── Poller daemon stability ───────────────────────────────────────────────────
 *
 * The RiftPickPoller daemon MUST NOT exit for any reason other than process
 * termination. It is a daemon thread (isDaemon = true) and will be collected
 * with the process automatically. The previous code broke here:
 *
 *   InterruptedException catch { break }  ← WRONG
 *
 * Android may interrupt daemon threads during low-power modes, GC pauses, or
 * low-memory events. When this happened, pollerStarted stayed true (AtomicBool
 * compareAndSet never resets it), so the daemon could never restart. Every
 * subsequent pick attempt would set PICK_REQUESTED = true, find nobody reading
 * it, and time out after 5 minutes — producing the "both failed" error banner.
 *
 * Fix: the InterruptedException catch simply logs and continues without break.
 * The daemon runs until process death regardless of system interruptions.
 *
 * ── Contract change: GetMultipleContents → OpenMultipleDocuments ─────────────
 *
 * GetMultipleContents wraps ACTION_GET_CONTENT. On many OEM Android builds
 * (Transsion/TECNO, Infinix, Itel, Samsung One UI, MIUI), ACTION_GET_CONTENT
 * is dispatched into a SEPARATE task from the calling Activity. The
 * ActivityResultLauncher callback is tied to the calling Activity's task. When
 * the picker resolves in a foreign task, the callback is never invoked — the
 * result is silently dropped. pickerInFlight stays true forever. Subsequent
 * taps hit the "picker already open" guard and fall through to Tier 3
 * immediately, producing the error banner.
 *
 * OpenMultipleDocuments wraps ACTION_OPEN_DOCUMENT, which routes to the system
 * DocumentsUI process. DocumentsUI is explicitly designed to deliver its result
 * back to the calling Activity via the standard startActivityForResult path.
 * It does NOT launch into a separate task. The callback is reliably invoked on
 * all Android versions (API 19+) across all OEM builds.
 *
 * Additional benefits:
 *   • No storage permissions required — user grants access via the picker UI.
 *   • Returns persistable URIs; takePersistableUriPermission succeeds.
 *   • launch() takes Array<String> of MIME types, not a single String.
 *
 * ── @Volatile on launcher ────────────────────────────────────────────────────
 *
 * Written on the MAIN THREAD in register(). Read from the POLLER BACKGROUND
 * THREAD in startPickPoller(). Without @Volatile, the Java Memory Model
 * (JSR-133) permits the background thread to observe a stale (null) value.
 * On weakly-ordered ARM cores (Cortex-A53/A55, MediaTek Helio G85/G88/G96
 * found in TECNO Camon/Spark, Infinix Hot/Note, Itel P-series), stores are
 * locally buffered and are NOT immediately visible to other cores without an
 * explicit memory barrier. @Volatile inserts StoreStore + LoadStore barriers
 * on the write site and LoadLoad + StoreLoad on the read site.
 *
 * ── Stuck-guard protection ───────────────────────────────────────────────────
 *
 * If the picker is launched but onPickerResult is never called (OEM bug),
 * pickerInFlight stays true indefinitely. The next trigger attempt sees the
 * guard and falls through to Tier 3. Worse: every subsequent launch attempt
 * for the rest of the process lifetime hits the guard.
 *
 * Fix: MainActivity.onResume() calls clearPickerGuard(). When the user returns
 * to The Rift (by pressing Back from the picker or switching apps), if the
 * picker result was never delivered, clearPickerGuard() detects pickerInFlight
 * == true, resets it, and delivers an empty result to Rust so the waiting
 * pick_files_for_send command unblocks immediately rather than timing out.
 */
object RiftFilePicker {

    private const val TAG = "RiftFilePicker"

    /**
     * OpenMultipleDocuments launcher. Takes Array<String> of MIME types.
     * Written on the main thread (register); read from the poller daemon thread.
     * @Volatile is mandatory — see class-level doc for ARM weak-memory details.
     */
    @Volatile
    private var launcher: ActivityResultLauncher<Array<String>>? = null

    /**
     * True from the moment launcher.launch() is posted to the main thread until
     * onPickerResult() runs (success or cancellation) or clearPickerGuard()
     * resets it (OEM callback-drop recovery).
     */
    @Volatile
    private var pickerInFlight: Boolean = false

    /**
     * Ensures exactly one poller daemon runs per process lifetime.
     * Kotlin object is a singleton — this AtomicBoolean is initialised false
     * when the class first loads and stays true thereafter.
     */
    private val pollerStarted = AtomicBoolean(false)

    // ── Registration ──────────────────────────────────────────────────────────

    /**
     * Must be called from MainActivity.onCreate(), before onStart().
     * ActivityResultLauncher has a hard lifecycle requirement on this ordering.
     */
    fun register(activity: MainActivity) {
        launcher = activity.registerForActivityResult(
            ActivityResultContracts.OpenMultipleDocuments()
        ) { uris ->
            onPickerResult(activity, uris)
        }
        Log.i(TAG, "ActivityResultLauncher registered (OpenMultipleDocuments / ACTION_OPEN_DOCUMENT)")

        try {
            nativeRegisterPickerClass()
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "nativeRegisterPickerClass: native library not loaded — ${e.message}")
        } catch (e: Throwable) {
            Log.e(TAG, "nativeRegisterPickerClass: unexpected (${e::class.simpleName}): ${e.message}")
        }
    }

    // ── Poll daemon ───────────────────────────────────────────────────────────

    /**
     * Starts the Kotlin-side poll daemon for Tier 2 file picking.
     * Safe to call multiple times — exactly one daemon runs per process lifetime
     * (guarded by pollerStarted AtomicBoolean).
     *
     * The daemon polls nativeGetPickRequest() every 100ms. When Rust sets
     * PICK_REQUESTED = true, this function returns true exactly once and posts
     * launcher.launch() to the main thread.
     *
     * CRITICAL: The daemon must never exit. Android may interrupt daemon threads
     * during low-power or low-memory events (InterruptedException on sleep).
     * If the daemon exits, pollerStarted stays true and cannot restart, meaning
     * PICK_REQUESTED is set by Rust but nobody reads it — every subsequent file
     * pick times out after 5 minutes. The InterruptedException handler must
     * therefore NOT break out of the loop.
     */
    fun startPickPoller(activity: MainActivity) {
        if (!pollerStarted.compareAndSet(false, true)) {
            Log.d(TAG, "startPickPoller: daemon already running — skipping")
            return
        }

        Thread {
            Log.i(TAG, "RiftPickPoller daemon started")
            while (true) {
                try {
                    if (nativeGetPickRequest()) {
                        Handler(Looper.getMainLooper()).post {
                            try {
                                val l = launcher
                                if (l == null) {
                                    Log.e(TAG, "Poller: launcher is null — register() not called?")
                                    safeSignalEmpty()
                                    return@post
                                }
                                pickerInFlight = true
                                l.launch(arrayOf("*/*"))
                                Log.i(TAG, "Picker launched via OpenMultipleDocuments (*/*)")
                            } catch (e: Throwable) {
                                Log.e(TAG, "launcher.launch() failed (${e::class.simpleName}): ${e.message}")
                                pickerInFlight = false
                                safeSignalEmpty()
                            }
                        }
                    }
                } catch (e: UnsatisfiedLinkError) {
                    Log.v(TAG, "nativeGetPickRequest: library not ready yet — retrying in 100ms")
                } catch (e: Throwable) {
                    Log.e(TAG, "Poller iteration error (${e::class.simpleName}): ${e.message}")
                }

                try {
                    Thread.sleep(100)
                } catch (_: InterruptedException) {
                    // Android may interrupt daemon threads during low-power states,
                    // GC pauses, or low-memory events. The poller MUST NOT exit —
                    // it is the sole consumer of PICK_REQUESTED for the entire
                    // process lifetime. As a daemon thread (isDaemon = true) it
                    // will be terminated automatically when the process exits.
                    // Logging at VERBOSE to avoid logcat noise during normal operation.
                    Log.v(TAG, "RiftPickPoller: sleep interrupted — continuing (daemon does not exit)")
                }
            }
        }.also {
            it.isDaemon = true
            it.name    = "RiftPickPoller"
            it.start()
        }

        Log.i(TAG, "RiftPickPoller daemon thread started")
    }

    // ── onResume guard clearing ───────────────────────────────────────────────

    /**
     * Called from MainActivity.onResume().
     *
     * If the picker was launched but onPickerResult was never called (OEM bug),
     * pickerInFlight stays true. This method detects that state, resets it, and
     * delivers an empty result to Rust so pick_files_for_send unblocks
     * immediately rather than waiting for the 5-minute timeout.
     */
    fun clearPickerGuard() {
        if (pickerInFlight) {
            Log.w(
                TAG,
                "clearPickerGuard: picker was in-flight on Activity resume. " +
                "OEM likely dropped the ACTION_OPEN_DOCUMENT result. " +
                "Clearing guard and signalling empty result to unblock Rust."
            )
            pickerInFlight = false
            safeSignalEmpty()
        }
    }

    // ── Activity result callback ──────────────────────────────────────────────

    /**
     * Called on the MAIN THREAD when the system picker returns.
     * Clears pickerInFlight FIRST so clearPickerGuard() (called in onResume,
     * which fires after this callback on some Android versions) is always a no-op
     * when the picker worked correctly.
     */
    private fun onPickerResult(context: Context, uris: List<Uri>) {
        pickerInFlight = false

        if (uris.isEmpty()) {
            Log.i(TAG, "Picker returned 0 URIs — user cancelled or picker dismissed")
            nativeOnFilesSelected(emptyArray())
            return
        }

        Log.i(TAG, "Picker returned ${uris.size} URI(s) — spawning cache-copy worker")

        Thread {
            val results = mutableListOf<String>()
            for (uri in uris) {
                val entry = copyUriToCache(context, uri)
                if (entry != null) results.add(entry)
            }
            Log.i(TAG, "${results.size}/${uris.size} file(s) cached — calling nativeOnFilesSelected")
            nativeOnFilesSelected(results.toTypedArray())
        }.start()
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun safeSignalEmpty() {
        try {
            nativeOnFilesSelected(emptyArray())
        } catch (e: Throwable) {
            Log.e(
                TAG,
                "safeSignalEmpty: nativeOnFilesSelected threw (${e::class.simpleName}): ${e.message}. " +
                "Rust channel receiver will time out."
            )
        }
    }

    // ── URI → cache copy ──────────────────────────────────────────────────────

    /**
     * Copies one content:// URI into the app's private cache directory.
     * Returns "displayName\nabsolutePath\nsizeBytes" on success, null on failure.
     *
     * The cache file is named: rift_send_{timestamp_ms}_{sanitized_display_name}
     * android_fs::resolve_single() strips this prefix to restore the original
     * display name before the file enters the transfer manifest.
     */
    private fun copyUriToCache(context: Context, uri: Uri): String? {
        return try {
            val resolver = context.contentResolver

            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                Log.d(TAG, "URI grant persisted: $uri")
            } catch (e: SecurityException) {
                Log.d(TAG, "URI grant not persistable (OK for GET_CONTENT path): ${e.message}")
            }

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

            // Sanitise: replace all characters invalid in Android file names.
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
            val inputStream = resolver.openInputStream(uri)
                ?: run {
                    Log.w(TAG, "openInputStream null for $uri — trying openFileDescriptor fallback")
                    val pfd = resolver.openFileDescriptor(uri, "r")
                        ?: throw IOException(
                            "Both openInputStream and openFileDescriptor returned null for $uri"
                        )
                    FileInputStream(pfd.fileDescriptor)
                }

            // ── 3. Copy to cache ──────────────────────────────────────────────
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

            Log.i(TAG, "Cached: $uri → ${dest.absolutePath} ($size B)")

            // Newline-delimited: displayName, absolutePath, sizeBytes.
            // android_fs::resolve_single() strips the rift_send_ prefix from
            // absolutePath's filename to recover displayName as the transfer name.
            "$displayName\n${dest.absolutePath}\n$size"

        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache failed for $uri (${e.javaClass.simpleName}): ${e.message}")
            null
        }
    }

    // ── JNI declarations — ALL Kotlin→Rust direction ──────────────────────────

    @JvmStatic
    private external fun nativeRegisterPickerClass()

    @JvmStatic
    private external fun nativeGetPickRequest(): Boolean

    @JvmStatic
    private external fun nativeOnFilesSelected(paths: Array<String>)
}