package com.nigafiy.agent

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import com.nigafiy.agent.core.Enrollment

/**
 * QR provisioning (docs/features/android.md §3): Fleet's Device Owner QR carries the enrollment in
 * PROVISIONING_ADMIN_EXTRAS_BUNDLE as `server`, `token`, `pin`.
 */
object Provisioning {
    @Suppress("DEPRECATION")
    fun takeExtras(ctx: Context, intent: Intent?) {
        val extras = (if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE, PersistableBundle::class.java)
        else intent?.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)) ?: return
        try {
            val e = Enrollment.of(extras.getString("server"), extras.getString("token"), extras.getString("pin"))
            val store = Store(ctx)
            if (!store.enrolled) store.pendingEnrollment = e
        } catch (e: IllegalArgumentException) {
            Store(ctx).lastError = e.message
        }
    }
}

/** Android 10+: the setup wizard asks which mode to provision. Nigafiy is a fully managed DPC. */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Provisioning.takeExtras(this, intent)
        val result = Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE)
        setResult(RESULT_OK, result)
        finish()
    }
}

/** Android 10+: called once the phone is provisioned; the agent enrolls and starts. */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Provisioning.takeExtras(this, intent)
        AgentService.start(this)
        setResult(RESULT_OK)
        finish()
    }
}
