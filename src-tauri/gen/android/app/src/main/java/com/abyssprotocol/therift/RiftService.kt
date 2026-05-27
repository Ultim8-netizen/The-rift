package com.abyssprotocol.therift

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * RiftService — foreground service that keeps The Rift alive and
 * discoverable indefinitely, even when the screen is off or the user
 * switches to another app.
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
 * The service is START_STICKY so Android restarts it automatically
 * if it is ever killed under memory pressure.
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
        startForeground(NOTIFICATION_ID, buildNotification())
        acquireLocks()
        Log.i(TAG, "RiftService online — all locks acquired")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY: if killed, restart with a null intent
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
        val channel = NotificationChannel(
            CHANNEL_ID,
            "The Rift Connection",
            NotificationManager.IMPORTANCE_LOW          // no sound, no heads-up
        ).apply {
            description = "Keeps The Rift connected and discoverable on the local network"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        // Tapping the notification returns to MainActivity
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val tapPending = PendingIntent.getActivity(this, 0, tapIntent, pendingFlags)

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("The Rift")
            .setContentText("Active — tap to return")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(tapPending)
            .setOngoing(true)           // cannot be swiped away
            .setShowWhen(false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }

        return builder.build()
    }

    // ── Lock management ───────────────────────────────────────────────────────

    private fun acquireLocks() {
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        val power = getSystemService(POWER_SERVICE) as PowerManager

        // WifiLock — WIFI_MODE_FULL_LOW_LATENCY = 4 on all API levels
        @Suppress("DEPRECATION")
        wifiLock = wifi.createWifiLock(
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY,
            "TheRift:WifiLock"
        ).also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        Log.d(TAG, "WifiLock(LOW_LATENCY) acquired")

        // MulticastLock — non-negotiable for mDNS
        multicastLock = wifi.createMulticastLock("TheRift:MulticastLock").also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        Log.d(TAG, "MulticastLock acquired")

        // WakeLock — PARTIAL keeps CPU alive, screen may still turn off
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