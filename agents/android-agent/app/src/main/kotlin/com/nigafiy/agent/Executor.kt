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
import com.nigafiy.agent.core.FsError
import com.nigafiy.agent.core.Gateway
import com.nigafiy.agent.core.Gestures
import com.nigafiy.agent.core.InputEvent
import com.nigafiy.agent.core.SharedStorage
import android.os.Environment
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
                    DashboardScreen.clearWebData(ctx)
                })
                is AgentCommand.SessionOpen -> sessionOpen(cmd)
                is AgentCommand.SessionClose -> {
                    val closed = ScreenShare.close(ctx, cmd.sessionId)
                    Result(CommandOutcome(cmd.id, true, output = "Session ${cmd.sessionId} closed ($closed): screen sharing stopped"))
                }
                is AgentCommand.SessionUpdate -> {
                    ScreenShare.update(cmd.operators)
                    Result(CommandOutcome(cmd.id, true, output = "Session ${cmd.sessionId}: ${cmd.operators.size} operator(s)"))
                }
                is AgentCommand.Capture -> {
                    val c = ScreenShare.capturer ?: return Result(CommandOutcome(cmd.id, false, error = "The screen is not being shared on the phone"))
                    val frame = c.frame(cmd.quality, cmd.scale, cmd.fullFrame)
                    val out = if (frame["unchanged"] == true) "Screen unchanged (no image sent)" else "Captured frame ${frame["width"]}x${frame["height"]} (${frame["byte_length"]} bytes)"
                    Result(CommandOutcome(cmd.id, true, output = out, data = frame))
                }
                is AgentCommand.Input -> input(cmd)
                is AgentCommand.FsOp -> fsOp(cmd)
                is AgentCommand.Notify -> {
                    if (!Notices.allowed(ctx)) return Result(CommandOutcome(cmd.id, false, error = NOTIFICATIONS_OFF))
                    Notices.message(ctx, cmd.id, cmd.title, cmd.message)
                    Result(CommandOutcome(cmd.id, true, output = "Message shown on the phone", data = mapOf("shown" to true)))
                }
                is AgentCommand.Ring -> {
                    if (!Notices.allowed(ctx)) return Result(CommandOutcome(cmd.id, false, error = NOTIFICATIONS_OFF))
                    val how = Ringer.start(ctx, cmd.seconds, cmd.operator)
                    Result(CommandOutcome(cmd.id, true, output = "Ringing for ${cmd.seconds} s ($how, full alarm volume)", data = mapOf("seconds" to cmd.seconds, "sound" to how)))
                }
                is AgentCommand.RingStop -> {
                    val was = Ringer.stop()
                    Result(CommandOutcome(cmd.id, true, output = if (was) "Ringing stopped" else "The phone was not ringing", data = mapOf("was_ringing" to was)))
                }
                is AgentCommand.Unsupported -> Result(CommandOutcome(cmd.id, false, error = "unsupported"))
            }
        } catch (e: SecurityException) {
            Result(CommandOutcome(cmd.id, false, error = "Android refused: ${e.message}"))
        } catch (e: Exception) {
            Result(CommandOutcome(cmd.id, false, error = e.message ?: e.javaClass.simpleName))
        }
    }

    /** Asks the person (blocks up to the consent time; AgentService runs it on its own thread). */
    private fun sessionOpen(cmd: AgentCommand.SessionOpen): Result {
        val data = ScreenShare.open(ctx, cmd.session)
        return Result(CommandOutcome(cmd.id, true, output = "Session ${cmd.session.sessionId}: consent ${data["consent"]}, notification ${data["banner"]}", data = data))
    }

    private fun input(cmd: AgentCommand.Input): Result {
        val session = ScreenShare.active ?: return Result(CommandOutcome(cmd.id, false, error = "No screen-sharing session the person accepted is running on the phone"))
        if (!session.control) return Result(CommandOutcome(cmd.id, false, error = "The session's permission profile is view only: input refused by the agent"))
        val service = ControlService.instance
            ?: return Result(CommandOutcome(cmd.id, false, error = "android_control_not_enabled: remote control is not turned on in Settings → Accessibility on the phone"))
        val (w, h) = ScreenShare.capturer?.screenSize() ?: return Result(CommandOutcome(cmd.id, false, error = "The screen is not being shared on the phone"))
        val plan = Gestures.plan(cmd.event, w, h)
        val ok = service.perform(plan)
        val what = when (val e = cmd.event) {
            is InputEvent.Tap -> if (e.double) "double tap" else "tap"
            is InputEvent.LongPress -> "long press"
            is InputEvent.Swipe -> "swipe"
            is InputEvent.Nav -> e.action
            is InputEvent.Touch -> "touch"
            is InputEvent.Unsupported -> e.kind
        }
        return if (ok) Result(CommandOutcome(cmd.id, true, output = "Input '$what' delivered"))
        else Result(CommandOutcome(cmd.id, false, error = "Android did not complete the $what (cancelled by the system or by a touch on the phone)"))
    }

    private val storage by lazy { SharedStorage(Environment.getExternalStorageDirectory()) }

    private fun fsOp(cmd: AgentCommand.FsOp): Result {
        if (Build.VERSION.SDK_INT < 30) return Result(CommandOutcome(cmd.id, false, error = "android_files_unsupported: the file manager needs Android 11 or newer"))
        if (!Environment.isExternalStorageManager()) {
            return Result(CommandOutcome(cmd.id, false, error = "android_files_not_allowed: All files access is not allowed on the phone yet (the person allows it in the Nigafiy app)"))
        }
        return try {
            val res = storage.execute(cmd.request)
            Result(CommandOutcome(cmd.id, true, output = (res["message"] as? String) ?: "fs ${cmd.request.op} ok", data = res))
        } catch (e: FsError) {
            Result(CommandOutcome(cmd.id, false, error = e.message ?: "file operation refused"))
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
        const val NOTIFICATIONS_OFF = "android_notifications_off: notifications for the Nigafiy app are turned off on the phone, so nothing can be shown"
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
