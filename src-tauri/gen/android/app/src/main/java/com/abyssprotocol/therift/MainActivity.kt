package com.abyssprotocol.therift

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PERMISSION_REQUEST_CODE = 1337

        /**
         * Delay in milliseconds before clearPickerGuard() is checked in onResume.
         *
         * ROOT CAUSE (multi-file staging bug):
         *   On standard Android, the ActivityResultLauncher callback (onPickerResult)
         *   fires synchronously BEFORE onResume when returning from ACTION_OPEN_DOCUMENT.
         *   By the time onResume fires, pickerInFlight is already false, and
         *   clearPickerGuard() is a harmless no-op.
         *
         *   On some OEM builds (confirmed on TECNO/Transsion Camon/Spark series,
         *   certain Samsung One UI builds), the lifecycle order is INVERTED:
         *     onResume → ActivityResult callback
         *   This is not documented but reproducible: when the user selects multiple
         *   files (longer time in picker), onResume fires while pickerInFlight is
         *   still true. clearPickerGuard() then:
         *     1. Sees pickerInFlight = true
         *     2. Calls safeSignalEmpty() which sends empty Vec to Rust's oneshot channel
         *     3. Consumes the PICK_SENDER — the channel now has no sender
         *   Later, onPickerResult fires with the actual N selected files:
         *     4. Copies all URIs to cache ✓
         *     5. Calls nativeOnFilesSelected([f1, f2, f3, ...])
         *     6. Rust finds PICK_SENDER has no sender → "spurious call" log → DISCARDS files
         *   Result: 0 files staged even though the user selected N files.
         *
         *   Single-file selection is less affected because the copy is fast enough
         *   that onResume firing slightly early doesn't always win the race.
         *
         * FIX:
         *   Post clearPickerGuard() with PICKER_GUARD_DELAY_MS delay. This gives
         *   onPickerResult time to set pickerInFlight=false before the guard check.
         *
         *   If onPickerResult fires (success path):
         *     pickerInFlight = false → delayed clearPickerGuard() is a no-op ✓
         *   If onPickerResult never fires (true OEM picker-drop bug):
         *     After PICKER_GUARD_DELAY_MS, clearPickerGuard() signals empty → Rust
         *     unblocks immediately rather than waiting 5 minutes ✓
         */
        private const val PICKER_GUARD_DELAY_MS = 500L
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "MainActivity created — API ${Build.VERSION.SDK_INT}")

        Thread { IconSwitcher.repairOnStartup(applicationContext) }.start()

        RiftAndroidHelper.init(this)

        // Step 1: Register ActivityResultLauncher — must happen before STARTED state.
        RiftFilePicker.register(this)

        // Step 2: Start Kotlin poll daemon for Tier 2 file picking.
        // Must be called AFTER register() so launcher is non-null when the first
        // PICK_REQUESTED signal arrives from Rust.
        RiftFilePicker.startPickPoller(this)

        handlePermissionsAndStartService()
    }

    override fun onResume() {
        super.onResume()
        RiftAndroidHelper.updateActivity(this)

        // Delay clearPickerGuard() to prevent the OEM lifecycle race condition.
        // See PICKER_GUARD_DELAY_MS companion constant for full explanation.
        //
        // Short version: on some OEM builds onResume fires BEFORE onPickerResult.
        // If we call clearPickerGuard() immediately and pickerInFlight is still
        // true, we consume the PICK_SENDER oneshot channel with an empty signal,
        // causing all subsequently delivered files to be silently discarded.
        //
        // The 500ms delay ensures onPickerResult (which sets pickerInFlight=false)
        // has time to run first on any OEM build. The delay does not affect any
        // user-visible behavior: cancelled picker resolves instantly (pickerInFlight
        // is false immediately), true picker-drop resolves after 500ms (vs the
        // previous 5-minute timeout).
        Handler(Looper.getMainLooper()).postDelayed({
            RiftFilePicker.clearPickerGuard()
        }, PICKER_GUARD_DELAY_MS)
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

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.READ_MEDIA_IMAGES)
            perms.add(Manifest.permission.READ_MEDIA_VIDEO)
            perms.add(Manifest.permission.READ_MEDIA_AUDIO)
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