package com.abyssprotocol.therift

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log

/**
 * Switches the launcher icon by enabling one activity-alias and disabling another.
 * Each alias is declared in AndroidManifest.xml with a distinct android:icon.
 * Exactly one alias must be enabled at any given time.
 */
object IconSwitcher {

    private const val TAG        = "IconSwitcher"
    private const val PREF_FILE  = "rift_icon_prefs"
    private const val PREF_INDEX = "active_variant_index"

    /**
     * Full component names that match android:name in each <activity-alias>.
     * Index 0 is enabled by default at install (all others start disabled).
     */
    private val ALIASES = arrayOf(
        "com.abyssprotocol.therift.MainActivityIconV0",
        "com.abyssprotocol.therift.MainActivityIconV1",
        "com.abyssprotocol.therift.MainActivityIconV2",
        "com.abyssprotocol.therift.MainActivityIconV3",
        "com.abyssprotocol.therift.MainActivityIconV4",
        "com.abyssprotocol.therift.MainActivityIconV5",
        "com.abyssprotocol.therift.MainActivityIconV6",
        "com.abyssprotocol.therift.MainActivityIconV7",
        "com.abyssprotocol.therift.MainActivityIconV8",
        "com.abyssprotocol.therift.MainActivityIconV9",
        "com.abyssprotocol.therift.MainActivityIconV10",
    )

    /**
     * Call from a background thread (e.g. from onStop via Thread {}).
     * Picks a random variant that differs from the current one, enables it,
     * and disables the previous alias. The launcher sees the change the next
     * time it renders the shortcut (usually within a few seconds of the app
     * leaving the foreground).
     */
    fun switchRandom(context: Context) {
        val pkg    = context.packageName
        val pm     = context.packageManager
        val prefs  = context.getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE)
        val current = prefs.getInt(PREF_INDEX, 0).coerceIn(ALIASES.indices)

        val candidates = ALIASES.indices.filter { it != current }
        if (candidates.isEmpty()) {
            Log.w(TAG, "Only one alias defined — no switch possible")
            return
        }
        val next = candidates.random()

        try {
            // Enable new alias BEFORE disabling old one so the launcher never
            // sees a moment where no alias is active.
            pm.setComponentEnabledSetting(
                ComponentName(pkg, ALIASES[next]),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP
            )
            pm.setComponentEnabledSetting(
                ComponentName(pkg, ALIASES[current]),
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )
            prefs.edit().putInt(PREF_INDEX, next).apply()
            Log.i(TAG, "Icon: v$current -> v$next")
        } catch (e: Exception) {
            Log.e(TAG, "switchRandom failed: ${e.message}")
        }
    }
}