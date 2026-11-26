package com.nigafiy.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.nigafiy.agent.core.Json

/**
 * Network alerts on an admin phone (docs/roadmap/2026-11-26-admin-phones.md): the server hands them
 * over with the heartbeat (important problems only, and "resolved" for a problem shown before). Each
 * one is an Android notification; tapping it opens that page of the dashboard in the app. The last
 * ones are kept for the Home tab.
 */
object Alerts {
    const val CHANNEL = "nigafiy-network-alerts"
    const val EXTRA_PATH = "com.nigafiy.agent.OPEN_PATH"
    private const val KEEP = 10

    data class Alert(val title: String, val body: String, val path: String, val tag: String, val severity: String, val resolved: Boolean, val at: String)

    fun parse(raw: Any?): List<Alert> = (raw as? List<*>)?.mapNotNull { a ->
        val m = a as? Map<*, *> ?: return@mapNotNull null
        val title = m["title"] as? String ?: return@mapNotNull null
        val path = (m["path"] as? String)?.takeIf { it.startsWith("/") } ?: "/"
        Alert(title, m["body"] as? String ?: "", path, m["tag"] as? String ?: title, m["severity"] as? String ?: "warning", m["resolved"] == true, m["created_at"]?.toString() ?: "")
    } ?: emptyList()

    fun show(ctx: Context, store: Store, alerts: List<Alert>) {
        if (alerts.isEmpty()) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.alerts_channel), NotificationManager.IMPORTANCE_HIGH))
        for (a in alerts) {
            val open = PendingIntent.getActivity(
                ctx, a.tag.hashCode(),
                Intent(ctx, MainActivity::class.java).putExtra(EXTRA_PATH, a.path).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val n = Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_nigafiy)
                .setContentTitle(if (a.resolved) ctx.getString(R.string.alert_resolved, a.title) else a.title)
                .setContentText(a.body.lineSequence().firstOrNull() ?: "")
                .setStyle(Notification.BigTextStyle().bigText(a.body))
                .setCategory(Notification.CATEGORY_STATUS)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            // Repeats of the same problem replace each other.
            nm.notify(ALERT_BASE + (a.tag.hashCode() and 0xffff), n)
        }
        val kept = (alerts.reversed() + recent(store)).take(KEEP)
        store.recentAlerts = Json.write(kept.map { mapOf("title" to it.title, "body" to it.body, "path" to it.path, "tag" to it.tag, "severity" to it.severity, "resolved" to it.resolved, "created_at" to it.at) })
    }

    fun recent(store: Store): List<Alert> = try { parse(Json.parse(store.recentAlerts)) } catch (_: Exception) { emptyList() }

    private const val ALERT_BASE = 0x20000
}
