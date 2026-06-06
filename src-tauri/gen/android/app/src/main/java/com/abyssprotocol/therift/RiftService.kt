package com.abyssprotocol.therift

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
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
 * Additionally, this service binds the process to the WiFi network via
 * ConnectivityManager.bindProcessToNetwork(). This is critical on Android 10+
 * when The Rift is operating as a hotspot CLIENT:
 *
 *   Problem: If the hotspot network has no upstream internet access, Android
 *   marks it as "not satisfied" and routes all new TCP connections over the
 *   default network (typically cellular). Rust's tokio runtime then opens
 *   connections over LTE — devices appear discovered (UDP broadcast works on
 *   all interfaces) but every connect() attempt goes over the wrong network.
 *   Result: "unable to find device", timeouts, and mid-transfer disconnects.
 *
 *   Fix: bindProcessToNetwork() forces ALL new sockets in this process to use
 *   the specified WiFi network, regardless of whether it has internet access.
 *   A NetworkCallback fires immediately for already-connected WiFi and on
 *   every subsequent WiFi availability change, keeping the binding current.
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

    // ── WiFi network binding ──────────────────────────────────────────────────

    private var connectivityManager: ConnectivityManager? = null

    /**
     * NetworkCallback for WiFi transport.
     *
     * onAvailable fires:
     *   (a) Immediately after registerNetworkCallback if a matching WiFi
     *       network is already active. This covers the case where the user
     *       connected to the hotspot before launching The Rift.
     *   (b) Whenever a new WiFi network becomes available (e.g. user connects
     *       to the hotspot while the app is already running).
     *
     * onLost: we deliberately do NOT release the binding on loss. Keeping the
     * dead binding causes Rust connection attempts to fail fast (OS detects the
     * dead network within seconds and returns ENETDOWN), which triggers the
     * rift_channel reconnect loop. Releasing the binding would silently reroute
     * reconnect attempts over cellular — devices appear connected but on the
     * wrong network, making them invisible to each other on the hotspot subnet.
     */
    private val wifiNetworkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            connectivityManager?.bindProcessToNetwork(network)
            Log.i(TAG, "WiFi network available — process bound to $network (all Rust TCP → WiFi)")
        }

        override fun onLost(network: Network) {
            // Intentionally not releasing: see class-level comment above.
            Log.w(TAG, "WiFi network lost: $network — holding binding for fast-fail reconnect")
        }

        override fun onUnavailable() {
            Log.w(TAG, "Requested WiFi transport unavailable on this device")
        }
    }

    // ── Service lifecycle ─────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Creating RiftService")
        createNotificationChannel()
        startForegroundCompat()
        acquireLocks()
        bindWifiNetwork()
        Log.i(TAG, "RiftService online — locks acquired, WiFi binding active")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.i(TAG, "RiftService stopping — releasing locks and network binding")
        releaseLocks()
        releaseWifiBinding()
        super.onDestroy()
    }

    // ── WiFi network binding ──────────────────────────────────────────────────

    /**
     * Registers a NetworkCallback for TRANSPORT_WIFI (no internet requirement)
     * and immediately binds the process to any currently-active WiFi network.
     *
     * NET_CAPABILITY_INTERNET is deliberately omitted from the NetworkRequest.
     * Hotspot client connections never satisfy that capability (the hotspot
     * host has internet but the client-side network does not appear to have it
     * from Android's perspective), so requiring it would exclude the exact
     * networks we need to bind to.
     */
    private fun bindWifiNetwork() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (cm == null) {
            Log.w(TAG, "ConnectivityManager unavailable — WiFi network binding skipped")
            return
        }
        connectivityManager = cm

        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            // No NET_CAPABILITY_INTERNET: hotspot networks won't have it.
            .build()

        try {
            cm.registerNetworkCallback(request, wifiNetworkCallback)
            Log.i(TAG, "WiFi NetworkCallback registered")

            // Immediate binding: registerNetworkCallback fires onAvailable for
            // existing networks, but there can be a short dispatch delay on some
            // OEM builds. Binding here covers the zero-delay path so Rust's first
            // connection attempt (which may happen within milliseconds of service
            // start) already uses the WiFi network.
            val activeNet = cm.activeNetwork
            if (activeNet != null) {
                val caps = cm.getNetworkCapabilities(activeNet)
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    cm.bindProcessToNetwork(activeNet)
                    Log.i(TAG, "Immediately bound to active WiFi network: $activeNet")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register WiFi network callback: ${e.message}")
        }
    }

    /**
     * Unregisters the NetworkCallback and releases the process-to-network
     * binding. Called from onDestroy so there are no dangling callbacks after
     * the service stops.
     */
    private fun releaseWifiBinding() {
        try {
            connectivityManager?.unregisterNetworkCallback(wifiNetworkCallback)
            connectivityManager?.bindProcessToNetwork(null)
            Log.i(TAG, "WiFi network binding released")
        } catch (e: Exception) {
            Log.w(TAG, "WiFi binding release failed (safe to ignore on shutdown): ${e.message}")
        }
        connectivityManager = null
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "The Rift Connection",
                NotificationManager.IMPORTANCE_LOW
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

        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val tapPending = PendingIntent.getActivity(this, 0, tapIntent, pendingFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("The Rift")
            .setContentText("Active — tap to return")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(tapPending)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    // ── Lock management ───────────────────────────────────────────────────────

    private fun acquireLocks() {
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        val power = getSystemService(POWER_SERVICE) as PowerManager

        @Suppress("DEPRECATION")
        wifiLock = wifi.createWifiLock(
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY,
            "TheRift:WifiLock"
        ).also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        Log.d(TAG, "WifiLock(LOW_LATENCY) acquired")

        multicastLock = wifi.createMulticastLock("TheRift:MulticastLock").also {
            it.setReferenceCounted(false)
            it.acquire()
        }
        Log.d(TAG, "MulticastLock acquired")

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