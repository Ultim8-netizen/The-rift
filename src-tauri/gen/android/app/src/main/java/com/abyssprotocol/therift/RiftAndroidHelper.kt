package com.abyssprotocol.therift

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.lang.ref.WeakReference

/**
 * JNI-accessible singleton. Provides ContentResolver access for content:// URIs
 * returned by the Android file picker (which Rust cannot open directly).
 *
 * Initialisation order (must be followed exactly):
 *   1. `init()` is called from `MainActivity.onCreate()` after `super.onCreate()`.
 *   2. `init()` stores `appContext`, caches a WeakReference to the Activity, and
 *      calls `nativeInitJvm()`.
 *   3. `nativeInitJvm()` stores the JavaVM + GlobalRef to this class in Rust OnceLocks.
 *
 * Activity WeakReference:
 *   Some OEM Android builds (Samsung, TECNO, Infinix, MIUI) check URI permissions
 *   against the calling Activity's component context rather than the process-wide
 *   ApplicationContext. Keeping a WeakRef lets copyUriToCache prefer the Activity's
 *   ContentResolver and fall back to applicationContext if the Activity is gone.
 *   MainActivity.onResume() calls updateActivity(this) to keep the ref fresh across
 *   rotations and restores.
 */
object RiftAndroidHelper {

    private const val TAG = "RiftAndroidHelper"

    @Volatile
    private var appContext: Context? = null

    /** WeakRef so we never prevent Activity GC; refreshed in onResume. */
    @Volatile
    private var activityRef: WeakReference<Activity>? = null

    // ── Native initialisation ─────────────────────────────────────────────────

    @JvmStatic
    private external fun nativeInitJvm()

    // ── Public API ────────────────────────────────────────────────────────────

    @JvmStatic
    fun init(ctx: Context) {
        appContext = ctx.applicationContext
        if (ctx is Activity) {
            activityRef = WeakReference(ctx)
        }
        try {
            nativeInitJvm()
            Log.i(TAG, "JVM and class GlobalRef initialised for native file operations")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "nativeInitJvm: native library not loaded — ${e.message}")
        }
        Log.i(TAG, "RiftAndroidHelper initialised")
    }

    /**
     * Called from MainActivity.onResume() to keep the Activity WeakRef current
     * across configuration changes (screen rotation, split-screen entry/exit).
     */
    @JvmStatic
    fun updateActivity(activity: Activity) {
        activityRef = WeakReference(activity)
        Log.d(TAG, "Activity reference refreshed: ${activity.javaClass.simpleName}")
    }

    // ── JNI-accessible helpers ────────────────────────────────────────────────

    /**
     * Queries display name and size for a content:// URI via ContentResolver.
     * Returns "displayName|sizeBytes". Returns "|0" on any failure.
     */
    @JvmStatic
    fun queryUriInfo(uriString: String): String {
        val ctx = appContext ?: run {
            Log.e(TAG, "queryUriInfo called before init()")
            return "|0"
        }
        return try {
            val uri = Uri.parse(uriString)

            // Persist the URI read grant so copyUriToCache can open it later.
            // SecurityException is expected for ACTION_GET_CONTENT URIs (non-persistable);
            // log at DEBUG and continue.
            try {
                ctx.contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
                Log.d(TAG, "URI grant persisted: $uriString")
            } catch (e: SecurityException) {
                Log.d(TAG, "URI grant not persistable (ACTION_GET_CONTENT expected): ${e.message}")
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
     * Copies a content:// URI to the app's internal cache directory.
     * Returns "absolutePath|fileSizeBytes" on success, "" on failure.
     *
     * Strategy:
     *   1. Try takePersistableUriPermission (works for ACTION_OPEN_DOCUMENT,
     *      silently fails for ACTION_GET_CONTENT — that is expected and safe).
     *   2. Prefer the live Activity's ContentResolver over applicationContext.
     *      Some OEM builds (Samsung, MIUI, TECNO) restrict content:// access to
     *      the component that received the original Intent grant.
     *   3. Try openInputStream first; if it returns null, fall back to
     *      openFileDescriptor → FileInputStream. Some Samsung/OEM providers
     *      return null from openInputStream but succeed via file descriptor.
     *
     * Called from android_fs::call_kotlin_string_method (Tokio blocking thread).
     */
    @JvmStatic
    fun copyUriToCache(uriString: String): String {
        val ctx = appContext ?: run {
            Log.e(TAG, "copyUriToCache called before init()")
            return ""
        }

        return try {
            val uri = Uri.parse(uriString)

            // ── 1. Attempt to persist the grant ──────────────────────────────
            // For ACTION_OPEN_DOCUMENT URIs this succeeds and is necessary.
            // For ACTION_GET_CONTENT URIs this throws SecurityException — safe to ignore.
            try {
                ctx.contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
                Log.d(TAG, "copyUriToCache: URI grant persisted")
            } catch (e: SecurityException) {
                Log.d(TAG, "copyUriToCache: URI grant not persistable (OK for GET_CONTENT)")
            }

            // ── 2. Pick the best ContentResolver ─────────────────────────────
            // Activity resolver is preferred; falls back to applicationContext.
            val resolver = activityRef?.get()?.contentResolver ?: ctx.contentResolver

            // ── 3. Resolve display name ───────────────────────────────────────
            var displayName = "rift_${System.currentTimeMillis()}"
            try {
                resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (cursor.moveToFirst() && nameIdx >= 0) {
                        cursor.getString(nameIdx)?.takeIf { it.isNotEmpty() }?.let {
                            displayName = it
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "copyUriToCache: could not query display name: ${e.message}")
            }

            val safeName = displayName
                .replace('/', '_')
                .replace('\\', '_')
                .replace(':', '_')

            val cacheFile = File(
                ctx.cacheDir,
                "rift_send_${System.currentTimeMillis()}_$safeName"
            )

            // ── 4. Open the source stream ─────────────────────────────────────
            // Primary: openInputStream — works on most providers.
            // Fallback: openFileDescriptor → FileInputStream — required on some
            //           Samsung Gallery and Documents providers that return null
            //           from openInputStream.
            val inputStream = resolver.openInputStream(uri)
                ?: run {
                    Log.w(TAG, "copyUriToCache: openInputStream returned null, trying openFileDescriptor")
                    val pfd = resolver.openFileDescriptor(uri, "r")
                        ?: throw IOException(
                            "Both openInputStream and openFileDescriptor returned null for $uriString"
                        )
                    FileInputStream(pfd.fileDescriptor)
                }

            // ── 5. Copy to cache ──────────────────────────────────────────────
            inputStream.use { input ->
                cacheFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }

            val fileSize = cacheFile.length()

            if (fileSize == 0L) {
                cacheFile.delete()
                Log.e(TAG, "copyUriToCache: cache copy is 0 bytes for $uriString — deleting")
                return ""
            }

            Log.i(TAG, "Copied $uriString → ${cacheFile.absolutePath} ($fileSize B)")
            "${cacheFile.absolutePath}|$fileSize"

        } catch (e: Exception) {
            Log.e(TAG, "copyUriToCache failed for $uriString: ${e.message}")
            ""
        }
    }
}