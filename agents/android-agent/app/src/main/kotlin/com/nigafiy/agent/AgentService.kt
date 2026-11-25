package com.nigafiy.agent

import android.Manifest
import android.app.Notification
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import com.nigafiy.agent.admin.NigafiyAdminReceiver
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.nigafiy.agent.core.CommandOutcome
import com.nigafiy.agent.core.Gateway
import com.nigafiy.agent.core.GatewayError
import com.nigafiy.agent.core.Mode
import com.nigafiy.agent.core.Protocol
import com.nigafiy.agent.core.SeenCommands
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The agent's foreground service: heartbeat every `heartbeat_interval_seconds` (30 s), a long poll
 * for commands (no push service: docs/features/android.md §4), results posted at once. The
 * notification "Managed by Nigafiy" stays while the phone is managed; there is no hidden mode.
 */
class AgentService : Service() {
    private lateinit var store: Store
    private lateinit var facts: Facts
    private lateinit var executor: Executor
    private val running = AtomicBoolean(false)
    private val pool = Executors.newScheduledThreadPool(2)
    private val worker = Executors.newSingleThreadExecutor()
    private val unsent = ConcurrentLinkedQueue<CommandOutcome>()
    private lateinit var seen: SeenCommands
    @Volatile private var lastAppsAt = 0L
    @Volatile private var forceApps = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        facts = Facts(this, store)
        executor = Executor(this, store, facts)
        seen = SeenCommands(store.seenCommands)
        channel(this)
        showManagementNotification()
        startInForeground(getString(R.string.notif_enrolling, store.server ?: store.pendingEnrollment?.server ?: "…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (running.compareAndSet(false, true)) {
            pool.execute { loop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        pool.shutdownNow()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun startInForeground(text: String) {
        val n = notification(text)
        if (Build.VERSION.SDK_INT >= 34) {
            val type = if (facts.mode() == Mode.DEVICE_OWNER) ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED else ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            startForeground(NOTIFICATION_ID, n, type)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_nigafiy)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    private fun show(text: String) = getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))

    private fun gateway(): Gateway? {
        val server = store.server ?: return null
        return Gateway(server, store.pin, store.credential)
    }

    private val polling = AtomicBoolean(false)

    private fun loop() {
        while (running.get()) {
            if (!store.enrolled) {
                // Not (or no longer) enrolled: enroll when an enrollment is waiting (QR provisioning
                // extras, or a link opened), else stop. "Stop management" forgets the credential
                // while this loop runs; before, the service kept running with nothing to do, kept the
                // "Managed by Nigafiy" notification and never picked up a new enrollment (emulator run).
                if (store.pendingEnrollment == null) { stopService(); return }
                enrollOnce()
                continue
            }
            if (polling.compareAndSet(false, true)) pool.execute { try { pollLoop() } finally { polling.set(false) } }
            heartbeat()
            sleep(store.heartbeatSeconds * 1000L)
        }
    }

    /** One enrollment attempt; on failure waits 30 s (a refused token is dropped). */
    private fun enrollOnce() {
        val p = store.pendingEnrollment ?: return
        try {
            val g = Gateway(p.server, p.pin)
            val (id, cred) = g.enroll(Protocol.enrollBody(p.token, facts.device(withApps = false), facts.security()))
            store.server = p.server
            store.pin = p.pin
            store.endpointId = id
            store.credential = cred
            store.pendingEnrollment = null
            store.lastError = null
            forceApps = true
        } catch (e: GatewayError) {
            store.lastError = e.message
            if (e.status == 401) { store.pendingEnrollment = null; return }
            sleep(30_000)
        } catch (e: Exception) {
            store.lastError = e.message
            sleep(30_000)
        }
    }

    /**
     * A Device Owner grants itself the notification permission (Android 13+), so "Managed by
     * Nigafiy" is always visible on a fully managed phone (no stealth mode). On the emulator run the
     * permission was never asked for, so the notification was hidden although the phone was managed.
     * A regular app keeps asking the person (MainActivity), who may refuse.
     */
    private fun showManagementNotification() {
        if (Build.VERSION.SDK_INT < 33 || facts.mode() != Mode.DEVICE_OWNER) return
        try {
            val dpm = getSystemService(DevicePolicyManager::class.java)
            dpm.setPermissionGrantState(
                ComponentName(this, NigafiyAdminReceiver::class.java),
                packageName,
                Manifest.permission.POST_NOTIFICATIONS,
                DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
            )
        } catch (e: Exception) {
            store.lastError = e.message
        }
    }

    private fun stopService() {
        running.set(false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun heartbeat() {
        val g = gateway() ?: return
        val now = System.currentTimeMillis()
        // Installed apps every 6 hours (and after a refresh or an install): they rarely change.
        val withApps = forceApps || now - lastAppsAt > TimeUnit.HOURS.toMillis(6)
        val results = generateSequence { unsent.poll() }.toList()
        try {
            val r = g.heartbeat(Protocol.heartbeatBody(facts.device(withApps), facts.security(), results))
            if (withApps) { lastAppsAt = now; forceApps = false }
            (r["heartbeat_interval_seconds"] as? Long)?.let { store.heartbeatSeconds = it.toInt() }
            store.lastContact = now
            store.lastError = null
            val mode = facts.mode()
            show(getString(if (mode == Mode.DEVICE_OWNER) R.string.notif_owner else R.string.notif_regular, store.server))
            @Suppress("UNCHECKED_CAST")
            handle(Protocol.parseCommands(com.nigafiy.agent.core.Json.write(mapOf("commands" to (r["commands"] ?: emptyList<Any>())))), g)
        } catch (e: GatewayError) {
            unsent.addAll(results)
            store.lastError = e.message
            if (e.status == 401) { show(getString(R.string.notif_offline, store.server, e.message)); return }
        } catch (e: Exception) {
            unsent.addAll(results)
            store.lastError = e.message
            show(getString(R.string.notif_offline, store.server, e.message ?: e.javaClass.simpleName))
        }
    }

    private fun pollLoop() {
        while (running.get()) {
            val g = gateway() ?: return
            try {
                handle(g.poll(), g)
            } catch (e: Exception) {
                store.lastError = e.message
                sleep(15_000)
            }
        }
    }

    private fun handle(polled: Pair<List<com.nigafiy.agent.core.AgentCommand>, List<CommandOutcome>>, g: Gateway) {
        val (commands, malformed) = polled
        report(g, malformed)
        for (cmd in commands) {
            if (!seen.take(cmd.id)) continue
            store.seenCommands = seen.snapshot()
            worker.execute {
                val r = executor.run(cmd, g)
                report(g, listOf(r.outcome))
                if (r.refresh) { forceApps = true; pool.execute { heartbeat() } }
                r.after?.let { act -> sleep(2_000); try { act() } catch (e: Exception) { store.lastError = e.message } }
            }
        }
    }

    private fun report(g: Gateway, outcomes: List<CommandOutcome>) {
        if (outcomes.isEmpty()) return
        try { g.results(outcomes) } catch (e: Exception) { unsent.addAll(outcomes) }
    }

    private fun sleep(ms: Long) = try { Thread.sleep(ms) } catch (e: InterruptedException) { running.set(false) }

    companion object {
        const val CHANNEL = "nigafiy-management"
        const val NOTIFICATION_ID = 1

        fun channel(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel(CHANNEL, ctx.getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW)
            ch.description = ctx.getString(R.string.channel_description)
            nm.createNotificationChannel(ch)
        }

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, AgentService::class.java))
        }
    }
}
