package com.nigafiy.agent

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.nigafiy.agent.core.ScreenSessionRequest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * One screen-sharing session at a time (docs/features/android.md §12). Fleet's rd_session_open
 * waits here for the person: a high-priority notification asks them, [ShareRequestActivity] says who
 * asks and why, Android's own MediaProjection dialog asks again, and only then does
 * [ScreenCaptureService] start (its notification and Android's cast indicator stay while it runs).
 * Refusing, ignoring the request or closing Android's dialog means no picture is ever taken.
 */
object ScreenShare {
    enum class Answer(val wire: String) { ACCEPTED("accepted"), DENIED("denied"), TIMEOUT("timeout"), UNAVAILABLE("unavailable") }

    class Pending(val request: ScreenSessionRequest) {
        val latch = CountDownLatch(1)
        @Volatile var answer: Answer? = null
        @Volatile var error: String? = null
    }

    /** What [ScreenCaptureService] offers while the projection runs. */
    interface Capturer {
        /** The rd_capture result map (FrameData), or throws when no frame can be taken. */
        fun frame(quality: Int, scale: Double, full: Boolean): Map<String, Any?>
        /** The real screen size in pixels (gestures are mapped onto it). */
        fun screenSize(): Pair<Int, Int>
        /**
         * A live-stream picture: null when the screen has not drawn since the last one (and [full] is
         * false), so a still screen costs no encoding and no bytes.
         */
        fun grab(quality: Int, scale: Double, full: Boolean): Grabbed?
    }

    class Grabbed(val jpeg: ByteArray, val width: Int, val height: Int, val sourceWidth: Int, val sourceHeight: Int, val captureMs: Long, val encodeMs: Long)

    @Volatile var pending: Pending? = null
        private set
    /** The session the person accepted (null when nothing is shared). */
    @Volatile var active: ScreenSessionRequest? = null
        private set
    @Volatile var capturer: Capturer? = null
        private set
    /** Opens the live stream of an accepted session (set by [AgentService]). */
    @Volatile var streamStarter: ((ScreenSessionRequest) -> Unit)? = null
    /** Posts "the person ended the session" to Fleet (set by [AgentService]). */
    @Volatile var endReporter: ((String) -> Unit)? = null

    const val REQUEST_NOTIFICATION_ID = 20
    const val EXTRA_SESSION = "com.nigafiy.agent.SESSION"

    /**
     * Asks the person and waits for the answer (at most the session's consent time). Returns the
     * rd_session_open result data the API reads (remote-desktop/sessions.ts applySessionOpenResult).
     */
    fun open(ctx: Context, req: ScreenSessionRequest): Map<String, Any?> {
        // A new request replaces whatever was shared or asked before.
        stopAll(ctx, notifyFleet = false)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) {
            return result(req, Answer.UNAVAILABLE, "Notifications for the Nigafiy app are turned off on this phone, so the person could not be asked", banner = "unavailable")
        }
        val p = Pending(req)
        pending = p
        Notices.channels(ctx)
        nm.notify(REQUEST_NOTIFICATION_ID, requestNotification(ctx, req))
        val answered = p.latch.await(req.consentTimeoutS.toLong(), TimeUnit.SECONDS)
        nm.cancel(REQUEST_NOTIFICATION_ID)
        synchronized(this) { if (pending === p) pending = null }
        val answer = if (answered) p.answer ?: Answer.UNAVAILABLE else Answer.TIMEOUT
        if (answer != Answer.ACCEPTED) {
            // The capture may have started just as the time ran out: never keep it unanswered.
            if (active?.sessionId == req.sessionId) stopAll(ctx, notifyFleet = false)
            ShareRequestActivity.finishOpen()
        }
        return result(req, answer, p.error, banner = "shown")
    }

    private fun result(req: ScreenSessionRequest, answer: Answer, error: String?, banner: String): Map<String, Any?> = linkedMapOf<String, Any?>(
        "consent" to answer.wire,
        "banner" to banner,
        "desktop" to mapOf("mode" to "android"),
        "stream" to if (req.liveStream) "ws" else "http",
    ).also { m -> error?.let { m["consent_error"] = it.take(300) } }

    /** The person's answer (activity, notification action) or the capture service's. */
    fun answer(sessionId: String, answer: Answer, error: String? = null) {
        val p = pending ?: return
        if (p.request.sessionId != sessionId || p.answer != null) return
        p.error = error
        p.answer = answer
        p.latch.countDown()
    }

    /** The capture service runs: the session is live. */
    fun started(ctx: Context, sessionId: String, c: Capturer): Boolean {
        val p = pending
        if (p == null || p.request.sessionId != sessionId || p.answer != null) return false
        capturer = c
        active = p.request
        answer(sessionId, Answer.ACCEPTED)
        if (p.request.liveStream) streamStarter?.invoke(p.request)
        ControlService.refreshIndicator(ctx)
        return true
    }

    /** Fleet ended the session (operator, another session, timeout): capture stops at once. */
    fun close(ctx: Context, sessionId: String): Boolean {
        val wasPending = pending?.request?.sessionId == sessionId
        if (wasPending) answer(sessionId, Answer.UNAVAILABLE, "the operator cancelled the request")
        val wasActive = active?.sessionId == sessionId
        if (wasActive) stopAll(ctx, notifyFleet = false)
        return wasPending || wasActive
    }

    fun update(operators: List<String>) {
        val a = active ?: return
        active = a.copy(operators = operators.ifEmpty { a.operators })
    }

    /**
     * The capture ended on the phone (Stop in the notification, Android's cast indicator, the screen
     * locked): Fleet is told so the session ends there too.
     */
    fun endedOnPhone(ctx: Context) {
        val a = active ?: return
        stopAll(ctx, notifyFleet = true, ended = a)
    }

    @Synchronized
    private fun stopAll(ctx: Context, notifyFleet: Boolean, ended: ScreenSessionRequest? = active) {
        pending?.let { p -> answer(p.request.sessionId, Answer.UNAVAILABLE, "replaced by a newer request") }
        val was = active
        active = null
        capturer = null
        LiveStream.stopAll()
        ScreenCaptureService.stop(ctx)
        ControlService.refreshIndicator(ctx)
        if (notifyFleet && was != null && ended != null) endReporter?.invoke(ended.sessionId)
    }

    private fun requestNotification(ctx: Context, req: ScreenSessionRequest): Notification {
        val open = PendingIntent.getActivity(
            ctx, 21,
            Intent(ctx, ShareRequestActivity::class.java).putExtra(EXTRA_SESSION, req.sessionId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val refuse = PhoneControlReceiver.pending(ctx, PhoneControlReceiver.ACTION_REFUSE_SHARE, req.sessionId)
        val text = ctx.getString(R.string.share_request_text, req.operator, req.reason.ifEmpty { "—" })
        return Notification.Builder(ctx, Notices.CHANNEL_REQUESTS)
            .setSmallIcon(R.drawable.ic_stat_nigafiy)
            .setContentTitle(ctx.getString(R.string.share_request_title))
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_CALL)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter(req.consentTimeoutS * 1000L)
            .addAction(Notification.Action.Builder(null, ctx.getString(R.string.share_action_open), open).build())
            .addAction(Notification.Action.Builder(null, ctx.getString(R.string.share_action_refuse), refuse).build())
            .build()
    }
}
