package com.abyssprotocol.therift

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log

/**
 * Switches the launcher icon by enabling one activity-alias and disabling all others.
 * Each alias is declared in AndroidManifest.xml with a distinct android:icon.
 * Exactly one alias must be enabled at any given time.
 *
 * Crash-safety design:
 *   switchRandom() saves the intended target index to SharedPreferences via
 *   commit() (synchronous write) BEFORE issuing any PackageManager calls.
 *   If the process is killed between the enable and the disable loop, the pref
 *   already reflects the intended state. The next launch calls repairOnStartup(),
 *   which reads that pref and enforces exactly one enabled alias, closing the gap.
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
     * Called from a background thread in MainActivity.onCreate() on every launch.
     *
     * Reads the saved active index from SharedPreferences and enforces that
     * exactly one alias is enabled and all others are disabled. This repairs
     * any state left by a process kill that occurred mid-switch in a previous
     * session (e.g. two aliases both enabled after enable(next) ran but
     * disable(old) never did).
     *
     * Safe to call repeatedly — idempotent.
     */
    fun repairOnStartup(context: Context) {
        val pkg    = context.packageName
        val pm     = context.packageManager
        val prefs  = context.getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE)
        val target = prefs.getInt(PREF_INDEX, 0).coerceIn(ALIASES.indices)

        try {
            var enabledCount = 0
            for (i in ALIASES.indices) {
                val desired = if (i == target)
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                else
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED

                val actual = pm.getComponentEnabledSetting(ComponentName(pkg, ALIASES[i]))

                // Only call setComponentEnabledSetting when the state needs to change.
                // Avoids unnecessary IPC to the system server on a clean launch.
                val alreadyCorrect = when (desired) {
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED ->
                        actual == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    else ->
                        actual == PackageManager.COMPONENT_ENABLED_STATE_DISABLED ||
                        actual == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                }

                if (!alreadyCorrect) {
                    pm.setComponentEnabledSetting(
                        ComponentName(pkg, ALIASES[i]),
                        desired,
                        PackageManager.DONT_KILL_APP
                    )
                    if (desired == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
                        Log.w(TAG, "Repair: enabled v$i (was $actual)")
                    } else {
                        Log.w(TAG, "Repair: disabled v$i (was $actual, leaked from prior crash)")
                    }
                }

                if (desired == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) enabledCount++
            }

            Log.i(TAG, "repairOnStartup complete — v$target active ($enabledCount alias(es) enabled)")
        } catch (e: Exception) {
            Log.e(TAG, "repairOnStartup failed: ${e.message}")
        }
    }

    /**
     * Call from a background thread (e.g. from onDestroy via Thread {}).
     *
     * Picks a random variant that differs from the current one, then:
     *   1. Saves the target index to SharedPreferences synchronously (commit,
     *      not apply) so repairOnStartup() knows the intended state even if
     *      the process is killed before the PackageManager calls complete.
     *   2. Enables the new alias.
     *   3. Iterates ALL aliases and disables every index that is not the new
     *      target — this cleans up any accidentally leaked enabled aliases from
     *      prior crash scenarios, not just the immediately previous one.
     *
     * The launcher sees the change the next time it renders the shortcut
     * (usually within a few seconds of the app leaving the foreground).
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
            // Persist the target index BEFORE any PackageManager calls.
            // commit() is synchronous: the value reaches disk before we proceed.
            // If the process is killed after this line, repairOnStartup() will
            // read `next` on the next launch and enforce the correct state.
            prefs.edit().putInt(PREF_INDEX, next).commit()

            // Enable the new alias BEFORE disabling others so the launcher never
            // sees a window where no alias is active.
            pm.setComponentEnabledSetting(
                ComponentName(pkg, ALIASES[next]),
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP
            )

            // Disable ALL aliases except the new target — not just `current`.
            // This handles any residual enabled aliases left by prior crashes.
            for (i in ALIASES.indices) {
                if (i != next) {
                    pm.setComponentEnabledSetting(
                        ComponentName(pkg, ALIASES[i]),
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP
                    )
                }
            }

            Log.i(TAG, "Icon: v$current -> v$next")
        } catch (e: Exception) {
            Log.e(TAG, "switchRandom failed: ${e.message}")
        }
    }
}