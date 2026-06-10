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
 * ── bindProcessToNetwork: corrected strategy ─────────────────────────────────
 *
 * PREVIOUS STRATEGY (broken for AP host mode):
 *   onAvailable → bind to WiFi network
 *   onLost      → hold binding (for fast-fail on reconnect)
 *
 * WHY IT BROKE:
 *   When mobile is the hotspot AP host, the AP interface (ap0/wlan_ap0,
 *   typically 192.168.43.1) is NOT reported as a TRANSPORT_WIFI network
 *   by ConnectivityManager. If the mobile has no WiFi client connection,
 *   no TRANSPORT_WIFI network ever becomes available. If the mobile had a
 *   WiFi client connection that then dropped, the binding was held to a
 *   dead/stale network.
 *
 *   Result: all Rust sockets — including UDP broadcasts in broadcast.rs —
 *   were forced through a dead WiFi client network or cellular. UDP
 *   broadcasts to 255.255.255.255 never reached PC clients on the
 *   192.168.43.x AP subnet. Discovery from mobile to PC was completely
 *   broken in AP host mode (the majority use-case on mobile).
 *
 * CORRECTED STRATEGY:
 *   onAvailable  → bind to WiFi network (same as before)
 *   onLost       → RELEASE binding (bindProcessToNetwork(null))
 *   onUnavailable → RELEASE binding
 *
 * WHY RELEASE IS CORRECT:
 *   With null binding, the OS uses its normal routing table:
 *     192.168.43.0/24 → ap0 (AP clients reachable)
 *     default         → cellular (internet traffic)
 *   Discovery broadcasts and TCP transfers to 192.168.43.x are routed
 *   through the AP interface. Combined with directed subnet broadcasts
 *   (broadcast.rs) and subnet scan (lib.rs), this makes discovery
 *   bidirectional in AP host mode.
 *
 * CONCERN: fast-fail reconnect after WiFi client drop
 *   With null binding after WiFi loss, Rust's reconnect attempt might
 *   briefly go through cellular before WiFi reconnects. This is
 *   acceptable — the alternative (permanent discovery failure in AP
 *   host mode) is far worse. The rift_channel reconnect loop handles
 *   transient failures gracefully.
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

    private var connectivityManager: ConnectivityManager? = null

    /**
     * NetworkCallback for WiFi transport.
     *
     * Strategy: bind on available, release on lost/unavailable.
     * See class-level comment for full rationale.
     */
    private val wifiNetworkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            connectivityManager?.bindProcessToNetwork(network)
            Log.i(TAG, "WiFi network available — process bound to $network")
        }

        override fun onLost(network: Network) {
            // Release binding so default OS routing takes over.
            // Critical for AP host mode: the AP interface (192.168.43.x)
            // is not reported as TRANSPORT_WIFI. With null binding, the
            // OS routing table correctly routes LAN traffic through ap0.
            connectivityManager?.bindProcessToNetwork(null)
            Log.w(TAG, "WiFi network lost: $network — binding released, OS routing active")
        }

        override fun onUnavailable() {
            // No WiFi client network is available at all.
            // This fires when mobile is in AP host mode with no upstream WiFi.
            // Release binding so AP interface traffic routes correctly.
            connectivityManager?.bindProcessToNetwork(null)
            Log.w(TAG, "WiFi transport unavailable — binding released (AP host mode likely)")
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
     * Hotspot client connections never satisfy that capability, so requiring it
     * would exclude the exact networks we need to bind to.
     *
     * Note: when mobile is in AP host mode, this callback may never fire
     * (the AP interface is not reported as TRANSPORT_WIFI). That is handled
     * by the corrected onLost/onUnavailable strategy above — the process
     * binding stays null and default routing through the AP interface is used.
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
            .build()

        try {
            cm.registerNetworkCallback(request, wifiNetworkCallback)
            Log.i(TAG, "WiFi NetworkCallback registered")

            // Immediate binding for the case where WiFi is already connected
            // before RiftService starts. The callback fires asynchronously so
            // this covers the zero-delay path.
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