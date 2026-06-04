package com.abyssprotocol.therift

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * RiftService — foreground service that keeps The Rift alive and
 * discoverable indefinitely, even when the screen is off or the user
 * switches to another app.
 *
 * Compatible with API 24 (Android 7.0) through API 34+ (Android 14),
 * including Android Go edition devices.
 *
 * Acquires three locks at startup and holds them until the service stops:
 *
 *   WifiLock(WIFI_MODE_FULL_LOW_LATENCY)
 *     Keeps the WiFi radio at full power with minimal latency.
 *     Without this, Android throttles the radio after ~1 minute of
 *     screen-off time and all TCP connections stall.
 *
 *   MulticastLock
 *     Allows mDNS multicast packets to reach the process.
 *     Without this lock, Android's WifiManager drops every multicast
 *     frame before it reaches any user-space socket — mDNS discovery
 *     becomes completely non-functional.
 *
 *   WakeLock(PARTIAL_WAKE_LOCK)
 *     Keeps the CPU running when the screen is off.
 *     Without this, the rift-channel TCP ping loop suspends and
 *     connections time out within 30-60 s of screen lock.
 *
 * NotificationCompat is used throughout instead of the platform
 * Notification.Builder. The platform builder is unreliable below API 31
 * and can trigger an ANR if startForeground() does not post its
 * notification within 5 seconds — a race that is common on low-RAM
 * Go edition devices. NotificationCompat resolves this across all APIs.
 */
class RiftService : Service() {

    companion object {
        private const val TAG = "RiftService"
        private const val CHANNEL_ID = "rift_keepalive_v1"
        private const val NOTIFICATION_ID = 1001
    }

    private var wifiLock: WifiManager.WifiLock? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Creating RiftService")
        createNotificationChannel()
        startForegroundCompat()
        acquireLocks()
        Log.i(TAG, "RiftService online — all locks acquired")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.i(TAG, "RiftService stopping — releasing locks")
        releaseLocks()
        super.onDestroy()
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        // NotificationChannel is required from API 26 (Android 8.0).
        // On API 24–25 this block is skipped entirely — the channel concept
        // does not exist on those versions and notifications post directly.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "The Rift Connection",
                NotificationManager.IMPORTANCE_LOW  // no sound, no heads-up
            ).apply {
                description = "Keeps The Rift connected and discoverable on the local network"
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
            }
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }

        // FLAG_IMMUTABLE is required from API 31 (Android 12).
        // FLAG_UPDATE_CURRENT is safe on all API levels.
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val tapPending = PendingIntent.getActivity(this, 0, tapIntent, pendingFlags)

        // NotificationCompat.Builder works correctly on API 24–34+.
        // It handles channel ID silently on API 24–25 (where channels don't
        // exist), applies the correct defaults for each API level, and avoids
        // the startForeground() ANR window that the platform builder can hit
        // on low-RAM devices.
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("The Rift")
            .setContentText("Active — tap to return")
            .setSmallIcon(R.drawable.ic_notification)  // ← bolt silhouette from drawable/
            .setContentIntent(tapPending)
            .setOngoing(true)           // cannot be swiped away
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    /**
     * Calls startForeground() with the correct signature for the running
     * API level.
     *
     * API 29+ (Android 10+): must pass the foreground service type so the
     *   system can apply correct battery/doze/network exemptions.
     *   ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC matches the
     *   foregroundServiceType declared in AndroidManifest.xml.
     *
     * API 24–28: 2-argument form. The type concept does not exist on these
     *   versions; passing it would throw a NoSuchMethodError at runtime.
     */
    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // API 29+ — use ServiceCompat which correctly calls the
            // 3-argument startForeground and handles the API 34 enforcement
            // of the FOREGROUND_SERVICE_DATA_SYNC permission automatically.
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            // API 24–28 — classic 2-argument form
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    // ── Lock management ───────────────────────────────────────────────────────

    private fun acquireLocks() {
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        val power = getSystemService(POWER_SERVICE) as PowerManager

        // WifiLock — WIFI_MODE_FULL_LOW_LATENCY (value 4) is available from
        // API 12 and is the correct mode for low-latency LAN transfers.
        // The constant itself was formally named in API 12 but the integer
        // value 4 is stable back to API 1.
        @Suppress("DEPRECATION")
        wifiLock = wifi.createWifiLock(
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY,
            "TheRift:WifiLock"
        ).also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        Log.d(TAG, "WifiLock(LOW_LATENCY) acquired")

        // MulticastLock — non-negotiable for mDNS on all Android versions.
        multicastLock = wifi.createMulticastLock("TheRift:MulticastLock").also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        Log.d(TAG, "MulticastLock acquired")

        // WakeLock — PARTIAL keeps CPU alive; screen may still turn off.
        // This is the least aggressive wake lock that still prevents the
        // Tokio async runtime from being suspended mid-transfer.
        @Suppress("DEPRECATION")
        wakeLock = power.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "TheRift:WakeLock"
        ).also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        Log.d(TAG, "WakeLock(PARTIAL) acquired")
    }

    private fun releaseLocks() {
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        runCatching { multicastLock?.takeIf { it.isHeld }?.release() }
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        Log.d(TAG, "All locks released")
    }
}