package com.nigafiy.agent

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import com.nigafiy.agent.admin.NigafiyAdminReceiver
import com.nigafiy.agent.core.AgentCommand
import com.nigafiy.agent.core.CommandOutcome
import com.nigafiy.agent.core.CommandRules
import com.nigafiy.agent.core.Gateway
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Runs Fleet's commands with DevicePolicyManager / PackageInstaller. A command that ends the
 * agent's own management (wipe, stop management) reports its result first and acts afterwards
 * through [after], so Fleet sees "done" before the phone goes away.
 */
class Executor(private val ctx: Context, private val store: Store, private val facts: Facts) {
    private val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
    private val admin = ComponentName(ctx, NigafiyAdminReceiver::class.java)

    class Result(val outcome: CommandOutcome, val after: (() -> Unit)? = null, val refresh: Boolean = false)

    fun run(cmd: AgentCommand, gateway: Gateway): Result {
        CommandRules.refusal(cmd, facts.mode(), ctx.packageName)?.let { return Result(CommandOutcome(cmd.id, false, error = it)) }
        return try {
            when (cmd) {
                is AgentCommand.RefreshInventory -> Result(CommandOutcome(cmd.id, true, output = "inventory refreshed"), refresh = true)
                is AgentCommand.Lock -> {
                    dpm.lockNow()
                    Result(CommandOutcome(cmd.id, true, output = "locked"))
                }
                is AgentCommand.Camera -> {
                    dpm.setCameraDisabled(admin, cmd.disabled)
                    val now = dpm.getCameraDisabled(admin)
                    Result(CommandOutcome(cmd.id, now == cmd.disabled, output = if (now) "camera disabled" else "camera enabled", data = mapOf("camera_disabled" to now)), refresh = true)
                }
                is AgentCommand.PasswordPolicy -> {
                    passwordPolicy(cmd.complexity)
                    store.passwordComplexity = cmd.complexity
                    Result(CommandOutcome(cmd.id, true, output = "screen lock requirement: ${cmd.complexity}", data = mapOf("password_complexity" to cmd.complexity, "sufficient" to sufficient())), refresh = true)
                }
                is AgentCommand.InstallApk -> install(cmd, gateway)
                is AgentCommand.Uninstall -> uninstall(cmd)
                is AgentCommand.Wipe -> Result(CommandOutcome(cmd.id, true, output = "erasing the phone"), after = { wipe() })
                is AgentCommand.Release -> Result(CommandOutcome(cmd.id, true, output = "Nigafiy is no longer the Device Owner"), after = {
                    @Suppress("DEPRECATION") dpm.clearDeviceOwnerApp(ctx.packageName)
                    store.forget()
                })
                is AgentCommand.Unsupported -> Result(CommandOutcome(cmd.id, false, error = "unsupported"))
            }
        } catch (e: SecurityException) {
            Result(CommandOutcome(cmd.id, false, error = "Android refused: ${e.message}"))
        } catch (e: Exception) {
            Result(CommandOutcome(cmd.id, false, error = e.message ?: e.javaClass.simpleName))
        }
    }

    private fun sufficient(): Boolean? = try { dpm.isActivePasswordSufficient } catch (e: Exception) { null }

    @Suppress("DEPRECATION")
    private fun passwordPolicy(c: String) {
        if (Build.VERSION.SDK_INT >= 31) {
            dpm.requiredPasswordComplexity = when (c) {
                "low" -> DevicePolicyManager.PASSWORD_COMPLEXITY_LOW
                "medium" -> DevicePolicyManager.PASSWORD_COMPLEXITY_MEDIUM
                "high" -> DevicePolicyManager.PASSWORD_COMPLEXITY_HIGH
                else -> DevicePolicyManager.PASSWORD_COMPLEXITY_NONE
            }
        } else {
            // Before Android 12 the quality API is the only one (still valid for a Device Owner).
            dpm.setPasswordQuality(admin, when (c) {
                "low" -> DevicePolicyManager.PASSWORD_QUALITY_SOMETHING
                "medium" -> DevicePolicyManager.PASSWORD_QUALITY_NUMERIC_COMPLEX
                "high" -> DevicePolicyManager.PASSWORD_QUALITY_ALPHANUMERIC
                else -> DevicePolicyManager.PASSWORD_QUALITY_UNSPECIFIED
            })
            dpm.setPasswordMinimumLength(admin, when (c) { "medium" -> 4; "high" -> 6; else -> 0 })
        }
    }

    private fun wipe() {
        if (Build.VERSION.SDK_INT >= 34) dpm.wipeDevice(0) else @Suppress("DEPRECATION") dpm.wipeData(0)
    }

    private fun install(cmd: AgentCommand.InstallApk, gateway: Gateway): Result {
        val f = File(ctx.cacheDir, "fleet-${cmd.apkId}.apk")
        try {
            gateway.download(cmd.path, f, cmd.sha256, cmd.sizeBytes)
            val pi = ctx.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            val sessionId = pi.createSession(params)
            pi.openSession(sessionId).use { s ->
                f.inputStream().use { input -> s.openWrite("base.apk", 0, f.length()).use { out -> input.copyTo(out); s.fsync(out) } }
                val (status, msg, pkg) = await(sessionId) { s.commit(it) }
                return if (status == PackageInstaller.STATUS_SUCCESS) {
                    Result(CommandOutcome(cmd.id, true, output = "installed ${pkg ?: cmd.name}", data = mapOf("package" to pkg, "sha256" to cmd.sha256)), refresh = true)
                } else {
                    Result(CommandOutcome(cmd.id, false, error = "install failed (status $status): ${msg ?: "no message"}"))
                }
            }
        } finally {
            f.delete()
        }
    }

    private fun uninstall(cmd: AgentCommand.Uninstall): Result {
        val pi = ctx.packageManager.packageInstaller
        val (status, msg, _) = await(-cmd.packageName.hashCode() - 1) { pi.uninstall(cmd.packageName, it) }
        return if (status == PackageInstaller.STATUS_SUCCESS) Result(CommandOutcome(cmd.id, true, output = "removed ${cmd.packageName}"), refresh = true)
        else Result(CommandOutcome(cmd.id, false, error = "uninstall failed (status $status): ${msg ?: "no message"}"))
    }

    /** Starts an install/uninstall whose status arrives at [PackageResultReceiver]; waits ≤ 3 min. */
    private fun await(key: Int, start: (android.content.IntentSender) -> Unit): Triple<Int, String?, String?> {
        val latch = CountDownLatch(1)
        PENDING[key] = latch
        val intent = Intent(ctx, PackageResultReceiver::class.java).putExtra(EXTRA_KEY, key)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pending = PendingIntent.getBroadcast(ctx, key, intent, flags)
        start(pending.intentSender)
        if (!latch.await(3, TimeUnit.MINUTES)) {
            PENDING.remove(key)
            return Triple(PackageInstaller.STATUS_FAILURE, "no answer from the package installer within 3 minutes", null)
        }
        return RESULTS.remove(key) ?: Triple(PackageInstaller.STATUS_FAILURE, "no result", null)
    }

    companion object {
        const val EXTRA_KEY = "com.nigafiy.agent.KEY"
        val PENDING = ConcurrentHashMap<Int, CountDownLatch>()
        val RESULTS = ConcurrentHashMap<Int, Triple<Int, String?, String?>>()
    }
}

/** Receives PackageInstaller's status for [Executor.await]. */
class PackageResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val key = intent.getIntExtra(Executor.EXTRA_KEY, Int.MIN_VALUE)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Only a Device Owner installs silently; Android asked the user instead. Not shown: the
            // command reports it (Fleet refuses installs outside Device Owner mode anyway).
            Executor.RESULTS[key] = Triple(status, "Android asked for the user's confirmation (not Device Owner?)", null)
        } else {
            Executor.RESULTS[key] = Triple(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE), intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME))
        }
        Executor.PENDING.remove(key)?.countDown()
    }
}
