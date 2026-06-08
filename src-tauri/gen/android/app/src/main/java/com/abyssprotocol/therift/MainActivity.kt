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

        // Repair icon alias state on each launch before any other initialisation.
        // Enforces exactly one enabled alias, recovering from any crash that left
        // two aliases enabled in a prior session. Runs on a background thread —
        // PackageManager IPC must not block the main thread.
        Thread { IconSwitcher.repairOnStartup(applicationContext) }.start()

        RiftAndroidHelper.init(this)

        // Step 1: Register the ActivityResultLauncher (OpenMultipleDocuments).
        // Must happen before the activity reaches STARTED state — hard requirement
        // from the ActivityResult API.
        RiftFilePicker.register(this)

        // Step 2: Start the Kotlin poll daemon for Tier 2 file picking.
        // Must be called AFTER register() so launcher is non-null when the first
        // PICK_REQUESTED signal arrives from Rust. Safe to call on every onCreate
        // (Activity rotation, process restart) — pollerStarted AtomicBoolean
        // ensures exactly one daemon runs per process lifetime.
        RiftFilePicker.startPickPoller(this)

        handlePermissionsAndStartService()
    }

    override fun onResume() {
        super.onResume()
        RiftAndroidHelper.updateActivity(this)

        // If the system picker was launched but never returned a result — an OEM
        // bug where ACTION_OPEN_DOCUMENT resolves in a foreign task and drops the
        // ActivityResultLauncher callback — pickerInFlight is still true here.
        // clearPickerGuard() detects this state, resets it, and delivers an empty
        // result to Rust so the pending pick_files_for_send command unblocks
        // instead of waiting up to 5 minutes for the Tier 2 timeout.
        //
        // If the picker worked correctly (onPickerResult ran), pickerInFlight is
        // already false and this call is a no-op.
        RiftFilePicker.clearPickerGuard()
    }

    override fun onStop() {
        super.onStop()
    }

    override fun onDestroy() {
        super.onDestroy()
        Thread { IconSwitcher.switchRandom(applicationContext) }.start()
    }

    // ── Permissions ───────────────────────────────────────────────────────────

    private fun runtimePermissions(): Array<String> {
        val perms = mutableListOf<String>()

        // API ≤ 28: WRITE covers general external storage access.
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }

        // API 29–32: READ_EXTERNAL_STORAGE covers all files in /storage/emulated/0/.
        // Deprecated at API 33 but still honoured on those API levels.
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

        // API 33+: Granular media permissions replace READ_EXTERNAL_STORAGE.
        // These allow scan_android_dirs() to list DCIM, Pictures, Music, and
        // Movies directories without requiring MANAGE_EXTERNAL_STORAGE (which
        // requires Play Store approval). Downloads and Documents remain accessible
        // without any permission on API 33+ for app-created files; third-party
        // files in those directories require MANAGE_EXTERNAL_STORAGE for direct
        // access, but OpenMultipleDocuments (ACTION_OPEN_DOCUMENT) covers those
        // without any permission at all.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.READ_MEDIA_IMAGES)
            perms.add(Manifest.permission.READ_MEDIA_VIDEO)
            perms.add(Manifest.permission.READ_MEDIA_AUDIO)
        }

        // Notifications: required on API 33+ for the foreground service icon.
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
            Log.d(TAG, "Requesting ${missing.size} permission(s): ${missing.joinToString()}")
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
            // Always start the service regardless of which permissions were granted.
            // OpenMultipleDocuments works with zero storage permissions; the scan
            // command produces a narrower result set without media permissions but
            // remains functional.
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