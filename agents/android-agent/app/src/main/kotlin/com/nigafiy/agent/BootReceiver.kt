package com.nigafiy.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the agent after a reboot and after an APK update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val store = Store(context)
        if (store.enrolled || store.pendingEnrollment != null) AgentService.start(context)
    }
}
