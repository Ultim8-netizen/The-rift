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
        Log.i(TAG, "MainActivity created")
        handlePermissionsAndStartService()
    }

    private fun runtimePermissions(): Array<String> {
        val perms = mutableListOf<String>()

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
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
            startRiftService()
        }
    }

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