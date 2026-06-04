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
 *      `nativeInitJvm()` which seeds the Rust-side JavaVM OnceLock.  Also
 *      caches a WeakReference to this Activity for URI permission resolution.
 *   3. handlePermissionsAndStartService() — requests runtime permissions and
 *      starts RiftService.
 *
 * onResume() refreshes the Activity WeakReference in RiftAndroidHelper so that
 * copyUriToCache always has a live Activity context available, even after a
 * rotation or configuration change rebuilds the Activity instance.
 */
class MainActivity : TauriActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PERMISSION_REQUEST_CODE = 1337
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "MainActivity created — API ${Build.VERSION.SDK_INT}")

        RiftAndroidHelper.init(this)
        handlePermissionsAndStartService()
    }

    override fun onResume() {
        super.onResume()
        // Refresh the Activity WeakReference so copyUriToCache always uses a
        // live Activity ContentResolver. The Activity is recreated on rotation
        // and other configuration changes, so onCreate alone is not enough.
        RiftAndroidHelper.updateActivity(this)
    }

    // ── Permissions ───────────────────────────────────────────────────────────

    private fun runtimePermissions(): Array<String> {
        val perms = mutableListOf<String>()

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

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
            startRiftService()
        }
    }

    // ── Service lifecycle ─────────────────────────────────────────────────────

    private fun startRiftService() {
        val intent = Intent(this, RiftService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            Log.i(TAG, "RiftService start requested")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start RiftService: ${e.message}")
        }
    }
}