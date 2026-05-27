package com.abyssprotocol.therift

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.TauriActivity

/**
 * MainActivity — Tauri WebView host with permission handling and
 * foreground service lifecycle management.
 *
 * On first launch, presents a single consolidated permission dialog
 * covering storage and notifications. The foreground service starts
 * as soon as permissions are resolved (whether granted or denied)
 * so the app is always in the best possible state.
 */
class MainActivity : TauriActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PERMISSION_REQUEST_CODE = 1337
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "MainActivity created")
        handlePermissionsAndStartService()
    }

    // ── Permissions ───────────────────────────────────────────────────────────

    /**
     * Returns the set of permissions that require runtime grants on this device.
     * Permissions like INTERNET, WAKE_LOCK, CHANGE_WIFI_MULTICAST_STATE are
     * install-time permissions and do not appear here.
     */
    private fun runtimePermissions(): Array<String> {
        val perms = mutableListOf<String>()

        // Storage — scoped storage replaced WRITE_EXTERNAL_STORAGE on API 29+
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {   // API ≤ 32
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {      // API ≤ 28
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }

        // Notifications — runtime required from API 33
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) { // API 33
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        return perms.toTypedArray()
    }

    private fun handlePermissionsAndStartService() {
        val missing = runtimePermissions().filter { perm ->
            ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED
        }.toTypedArray()

        if (missing.isEmpty()) {
            Log.d(TAG, "All permissions already granted")
            startRiftService()
        } else {
            Log.d(TAG, "Requesting ${missing.size} runtime permissions")
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

            // Start regardless — app works in degraded state without storage perms.
            // Notification permission denial means the foreground notification won't
            // appear, but the service itself still runs and holds the WiFi locks.
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
            // Rare: thrown when the system is in a state that prevents service start.
            // The app still works — just without the keepalive guarantee.
            Log.e(TAG, "Failed to start RiftService: ${e.message}")
        }
    }
}