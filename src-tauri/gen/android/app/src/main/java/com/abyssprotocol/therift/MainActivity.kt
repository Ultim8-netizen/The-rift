package com.abyssprotocol.therift

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

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
        RiftAndroidHelper.updateActivity(this)
    }

    /**
     * Called whenever the activity leaves the foreground (home press, back, screen off, etc.).
     */
    override fun onStop() {
        super.onStop()
        // REMOVED: IconSwitcher call was here.
        // Calling setComponentEnabledSetting(current_alias, DISABLED) from onStop()
        // disables the active launcher alias while the process is still live.
        // On Transsion OEM (and likely others), this triggers MainActivity.onDestroy()
        // even with DONT_KILL_APP, which Tauri interprets as app termination → exit(0).
        // The file picker opened via startActivityForResult has no process to return to.
    }

    override fun onDestroy() {
        super.onDestroy()
        // Safe here: the app is genuinely ending. setComponentEnabledSetting on the
        // now-dead launcher alias cannot disrupt anything. The background thread may
        // or may not complete before Tauri's exit(0) fires, but either outcome is
        // acceptable since the process is already shutting down.
        Thread { IconSwitcher.switchRandom(applicationContext) }.start()
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
            Log.d(TAG, "Requesting ${missing.size} runtime permission(s): ${missing.joinToString()}")
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