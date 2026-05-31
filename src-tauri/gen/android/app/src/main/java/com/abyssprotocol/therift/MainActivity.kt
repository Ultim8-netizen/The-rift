package com.abyssprotocol.therift

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * MainActivity — Tauri WebView host.
 *
 * Compatible with API 24 (Android 7.0) through API 34+ (Android 14),
 * including Android Go edition devices.
 *
 * Initialisation order:
 *   1. super.onCreate() — Tauri loads the native .so and sets up the WebView.
 *   2. RiftAndroidHelper.init(this) — stores the ApplicationContext AND calls
 *      `nativeInitJvm()` which seeds the Rust-side JavaVM OnceLock.  This
 *      MUST happen before any file-picker result is processed; see
 *      android_fs.rs for details on why ndk_context cannot be used here.
 *   3. handlePermissionsAndStartService() — requests runtime permissions and
 *      starts RiftService.
 *
 * Permission strategy:
 *   - Only runtime permissions are requested here. Install-time permissions
 *     (INTERNET, WAKE_LOCK, CHANGE_WIFI_MULTICAST_STATE, FOREGROUND_SERVICE)
 *     are granted automatically at install and never appear in this list.
 *   - Each permission is guarded by the API level it was introduced at.
 *     Requesting a permission that does not exist on the running API level
 *     causes a crash on some OEM builds (observed on TECNO and Infinix
 *     devices running Android 7–9 Go).
 *   - The foreground service is started regardless of whether permissions
 *     are granted — the app works in a degraded state without storage or
 *     notification permissions.
 */
class MainActivity : TauriActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PERMISSION_REQUEST_CODE = 1337
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "MainActivity created — API ${Build.VERSION.SDK_INT}")

        // Initialise the Android helper AFTER super.onCreate() so that the
        // native library has been loaded by Tauri's Activity base class.
        // This call stores the ApplicationContext (needed by ContentResolver
        // operations) and seeds the Rust JavaVM OnceLock (needed by every
        // JNI call originating from a Tokio blocking thread).
        RiftAndroidHelper.init(this)

        handlePermissionsAndStartService()
    }

    // ── Permissions ───────────────────────────────────────────────────────────

    /**
     * Returns only the runtime permissions that both:
     *   (a) exist on the current API level, and
     *   (b) have not yet been granted.
     *
     * API breakdown:
     *   WRITE_EXTERNAL_STORAGE  — API 24–28 only (scoped storage from API 29)
     *   READ_EXTERNAL_STORAGE   — API 24–32 only (MediaStore from API 33)
     *   POST_NOTIFICATIONS      — API 33+ only
     *
     * FOREGROUND_SERVICE is an install-time permission on API 28+ and does
     * not require a runtime grant — it must NOT appear in this list or the
     * request will be silently ignored and may confuse the permission system
     * on some OEM ROMs.
     */
    private fun runtimePermissions(): Array<String> {
        val perms = mutableListOf<String>()

        // WRITE_EXTERNAL_STORAGE — needed to save received files to Downloads
        // on Android 7.0–9.0 (API 24–28). Scoped storage replaces this on
        // API 29+; requesting it on API 29+ has no effect but wastes a dialog.
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }

        // READ_EXTERNAL_STORAGE — needed to read files for sending on API
        // 24–32. On API 33+ apps access media via MediaStore without this
        // permission. On API 33+ the system rejects this permission silently.
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

        // POST_NOTIFICATIONS — runtime permission introduced in API 33
        // (Android 13). Required to show the RiftService keepalive
        // notification. Without it the notification is silently suppressed
        // but the service and WiFi locks still work normally.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        return perms.toTypedArray()
    }

    private fun handlePermissionsAndStartService() {
        val missing = runtimePermissions().filter { perm ->
            ContextCompat.checkSelfPermission(this, perm) !=
                PackageManager.PERMISSION_GRANTED
        }.toTypedArray()

        if (missing.isEmpty()) {
            Log.d(TAG, "All permissions already granted")
            startRiftService()
        } else {
            Log.d(TAG,
                "Requesting ${missing.size} runtime permission(s): ${missing.joinToString()}")
            ActivityCompat.requestPermissions(this, missing, PERMISSION_REQUEST_CODE)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        if (requestCode == PERMISSION_REQUEST_CODE) {
            val granted = grantResults.count { it == PackageManager.PERMISSION_GRANTED }
            val denied  = grantResults.size - granted
            Log.i(TAG, "Permission results: $granted granted, $denied denied")
            // Start regardless — the app functions without storage/notification
            // permissions, just with reduced capability.
            startRiftService()
        }
    }

    // ── Service lifecycle ─────────────────────────────────────────────────────

    private fun startRiftService() {
        val intent = Intent(this, RiftService::class.java)
        try {
            // startForegroundService() is required from API 26 (Android 8.0).
            // On API 24–25, startService() is the correct call — there is no
            // foreground service distinction on those versions.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            Log.i(TAG, "RiftService start requested")
        } catch (e: Exception) {
            // Rare: thrown when the system is in a state that prevents service
            // start (e.g. background execution limits during testing). The app
            // still loads — just without the WiFi keepalive guarantee.
            Log.e(TAG, "Failed to start RiftService: ${e.message}")
        }
    }
}