package com.nigafiy.agent.admin

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import com.nigafiy.agent.AgentService
import com.nigafiy.agent.Provisioning

/**
 * The Device Policy Controller's admin component. It becomes Device Owner through
 * `adb shell dpm set-device-owner com.nigafiy.agent/.admin.NigafiyAdminReceiver` or QR
 * provisioning; Nigafiy does not offer the deprecated Device Admin mode on its own.
 */
class NigafiyAdminReceiver : DeviceAdminReceiver() {
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        Provisioning.takeExtras(context, intent)
        AgentService.start(context)
    }

    override fun onEnabled(context: Context, intent: Intent) {
        AgentService.start(context)
    }
}
