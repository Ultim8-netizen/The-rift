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
     *
     * Guards against the "permanent deadlock" scenario: without this flag,
     * trigger_android_picker_tier2() would register a new PICK_SENDER for every
     * tap, and if the old tap's callback is dropped by the OEM, every new
     * attempt finds "picker already open" in the Rust mutex and bails to Tier 3.
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
     *
     * Registers the launcher with OpenMultipleDocuments (ACTION_OPEN_DOCUMENT)
     * and caches the RiftFilePicker class GlobalRef in Rust for future use.
     * Does NOT start the poller — call startPickPoller() separately after this.
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

    // ── Poll daemon (the missing Kotlin side of Tier 2) ───────────────────────

    /**
     * Starts the Kotlin-side poll daemon for Tier 2 file picking.
     * Safe to call multiple times — exactly one daemon runs per process lifetime
     * (guarded by pollerStarted AtomicBoolean).
     *
     * WHAT IT DOES:
     *   Polls nativeGetPickRequest() [Kotlin→Rust] every 100ms. When Rust sets
     *   PICK_REQUESTED = true (via trigger_android_picker_tier2), this function
     *   returns true exactly once (compare-exchange atomically clears the flag).
     *   The daemon then posts launcher.launch() to the main thread.
     *
     * WHY THIS DIRECTION IS SAFE:
     *   All JNI calls go Kotlin→Rust. This daemon is a plain Kotlin thread with
     *   no Tauri IPC history — no stale exception state. nativeGetPickRequest()
     *   is a simple atomic read-and-clear in Rust. JavaException is impossible.
     *
     * MUST be called from MainActivity.onCreate() AFTER register() so that
     * `launcher` is non-null when the first PICK_REQUESTED is seen.
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
                        // PICK_REQUESTED was true — atomically cleared by nativeGetPickRequest.
                        // One pick request is now in flight. Post to main thread.
                        Handler(Looper.getMainLooper()).post {
                            try {
                                val l = launcher
                                if (l == null) {
                                    Log.e(TAG, "Poller: launcher is null — register() not called?")
                                    // Do NOT set pickerInFlight — there's nothing in flight.
                                    safeSignalEmpty()
                                    return@post
                                }
                                // Set BEFORE launch so clearPickerGuard() can detect
                                // the in-flight state immediately on the next onResume.
                                pickerInFlight = true
                                // OpenMultipleDocuments.launch() requires Array<String> of
                                // MIME types. "*/*" = all file types, no restriction.
                                l.launch(arrayOf("*/*"))
                                Log.i(TAG, "Picker launched via OpenMultipleDocuments (*/*)")
                            } catch (e: Throwable) {
                                // Covers ActivityNotFoundException (no system picker installed —
                                // extremely rare on Android 4.4+), IllegalStateException (Activity
                                // in wrong lifecycle state), OutOfMemoryError, etc.
                                Log.e(TAG, "launcher.launch() failed (${e::class.simpleName}): ${e.message}")
                                pickerInFlight = false
                                safeSignalEmpty()
                            }
                        }
                    }
                } catch (e: UnsatisfiedLinkError) {
                    // Native library not yet linked — normal for the first few milliseconds
                    // after process start. Log at VERBOSE to avoid logcat spam.
                    Log.v(TAG, "nativeGetPickRequest: library not ready yet — retrying in 100ms")
                } catch (e: Throwable) {
                    Log.e(TAG, "Poller iteration error (${e::class.simpleName}): ${e.message}")
                }

                try {
                    Thread.sleep(100)
                } catch (e: InterruptedException) {
                    Log.w(TAG, "RiftPickPoller interrupted — exiting")
                    break
                }
            }
        }.also {
            it.isDaemon = true          // Dies when the process exits — never blocks termination
            it.name = "RiftPickPoller"  // Visible in Android Studio's Threads view
            it.start()
        }

        Log.i(TAG, "RiftPickPoller daemon thread started")
    }

    // ── onResume guard clearing ───────────────────────────────────────────────

    /**
     * Called from MainActivity.onResume().
     *
     * Scenario: ACTION_OPEN_DOCUMENT picker was launched (pickerInFlight = true),
     * but the system never delivered a result to onPickerResult (OEM bug on some
     * Transsion/TECNO, Samsung, or MIUI builds). The user sees The Rift come back
     * to the foreground with no feedback. Without this method, pickerInFlight stays
     * true for the rest of the process lifetime and every subsequent pick attempt
     * fails instantly with "picker already open".
     *
     * Fix: onResume fires after the user returns. If pickerInFlight is still true
     * at that point, the picker result was dropped. We clear the flag and deliver
     * an empty result to Rust so pick_files_for_send unblocks immediately.
     *
     * If onPickerResult ran normally (picker returned, callback was invoked),
     * pickerInFlight is already false and this method is a complete no-op.
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
     *
     * Clears pickerInFlight FIRST so that clearPickerGuard() (called in onResume,
     * which fires after this callback on some Android versions) is always a no-op
     * when the picker worked correctly.
     *
     * Spawns a single worker thread to copy all URIs to the app's private cache.
     * The URI permission is live: we are within the task that received the grant,
     * and the copying thread is spawned while the Activity is still in the
     * foreground (it cannot be destroyed while we are in this callback).
     */
    private fun onPickerResult(context: Context, uris: List<Uri>) {
        pickerInFlight = false  // Clear before any async work

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

    /**
     * Calls nativeOnFilesSelected(emptyArray()) without allowing any exception
     * to propagate. Centralises all "unblock Rust with empty result" code paths.
     *
     * If nativeOnFilesSelected itself throws (UnsatisfiedLinkError if the library
     * never loaded, or a Rust panic wrapped as a RuntimeException), the exception
     * is swallowed and logged. Rust will time out on its channel receiver — an
     * acceptable degraded state compared to a JavaException crossing the JNI
     * boundary and crashing the command.
     */
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
     * With OpenMultipleDocuments (ACTION_OPEN_DOCUMENT), URIs are persistable:
     * takePersistableUriPermission succeeds and the grant survives process restart.
     * The copy is still performed here (inside the task that received the grant)
     * to produce plain absolute paths that Rust can open without any content://
     * machinery, eliminating all OEM-specific URI permission edge cases.
     *
     * Fallback strategy: some Samsung Gallery and TECNO Documents providers return
     * null from openInputStream() but succeed via openFileDescriptor(). We try
     * openInputStream first and fall back to the file-descriptor path.
     */
    private fun copyUriToCache(context: Context, uri: Uri): String? {
        return try {
            val resolver = context.contentResolver

            // Persist the URI read grant for future access.
            // Succeeds for ACTION_OPEN_DOCUMENT; SecurityException for ACTION_GET_CONTENT
            // (not used here, but guarded for safety in case of future code changes).
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
            // Newlines cannot appear in Android file names or absolute paths.
            "$displayName\n${dest.absolutePath}\n$size"

        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache failed for $uri (${e.javaClass.simpleName}): ${e.message}")
            null
        }
    }

    // ── JNI declarations — ALL Kotlin→Rust direction ──────────────────────────

    /**
     * Called from register() on the main thread.
     * Caches the RiftFilePicker class GlobalRef in Rust's PICKER_CLASS OnceLock.
     * Runs on the main thread so the app class loader is active (FindClass from
     * a worker thread uses the bootstrap loader and cannot find app classes).
     */
    @JvmStatic
    private external fun nativeRegisterPickerClass()

    /**
     * Called from the RiftPickPoller daemon thread every 100ms.
     * Atomically reads-and-clears PICK_REQUESTED in android_fs.rs via
     * compare_exchange(true, false). Returns JNI_TRUE exactly once per
     * trigger_android_picker_tier2() invocation.
     *
     * DIRECTION: Kotlin→Rust. Runs on a Kotlin-managed daemon thread.
     * No Tauri stale-exception state. No ExceptionCheck risk. Safe.
     */
    @JvmStatic
    private external fun nativeGetPickRequest(): Boolean

    /**
     * Called from the worker thread spawned in onPickerResult() after all cache
     * copies complete. Also called by safeSignalEmpty() on all error/cancel paths.
     * paths: each element is "displayName\nabsolutePath\nsizeBytes".
     * Empty array signals cancellation or total failure.
     *
     * DIRECTION: Kotlin→Rust. Safe.
     */
    @JvmStatic
    private external fun nativeOnFilesSelected(paths: Array<String>)
}