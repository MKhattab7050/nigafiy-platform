package com.nigafiy.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper

/** The notification channels of the phone controls, and IT's messages. */
object Notices {
    const val CHANNEL_REQUESTS = "nigafiy-share-requests"
    const val CHANNEL_SHARING = "nigafiy-sharing"
    const val CHANNEL_MESSAGES = "nigafiy-messages"
    const val CHANNEL_RING = "nigafiy-ring"

    fun channels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_REQUESTS, ctx.getString(R.string.channel_requests), NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_SHARING, ctx.getString(R.string.channel_sharing), NotificationManager.IMPORTANCE_DEFAULT).apply { setSound(null, null) })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_MESSAGES, ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_RING, ctx.getString(R.string.channel_ring), NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null) })
    }

    fun allowed(ctx: Context): Boolean = ctx.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    /** A message from IT (notify_user): plain text, shown until the person dismisses it. */
    fun message(ctx: Context, commandId: String, title: String, message: String) {
        channels(ctx)
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(ctx, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_nigafiy)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(Notification.BigTextStyle().bigText(message))
            .setSubText(ctx.getString(R.string.message_from_it))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(MESSAGE_BASE + (commandId.hashCode() and 0xffff), n)
    }

    private const val MESSAGE_BASE = 0x10000
}

/**
 * Rings the phone so the person can find it: the alarm sound at full alarm volume (the volume the
 * person had is put back afterwards), for the requested seconds, with a notification whose Stop
 * button ends it. Fleet can stop it too.
 */
object Ringer {
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var tone: ToneGenerator? = null
    private var previousVolume: Int? = null
    private val stopLater = Runnable { stopNow() }
    @Volatile var appContext: Context? = null
        private set
    @Volatile var ringing = false
        private set

    const val NOTIFICATION_ID = 40

    /** Starts ringing (on the main thread); returns what was used to make the sound. */
    fun start(ctx: Context, seconds: Int, operator: String?): String {
        val app = ctx.applicationContext
        appContext = app
        var how = ""
        val done = java.util.concurrent.CountDownLatch(1)
        var failure: Exception? = null
        main.post {
            try {
                stopNow()
                val am = app.getSystemService(AudioManager::class.java)
                try {
                    previousVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
                    am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
                } catch (_: SecurityException) { previousVolume = null }
                val uri = RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                how = try {
                    player = MediaPlayer().apply {
                        setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                        setDataSource(app, uri!!)
                        isLooping = true
                        prepare()
                        start()
                    }
                    "alarm sound"
                } catch (e: Exception) {
                    // No playable alarm sound (an emulator without media): a loud tone instead.
                    player?.release(); player = null
                    tone = ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME).apply { startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, seconds * 1000) }
                    "alarm tone"
                }
                ringing = true
                Notices.channels(app)
                val stop = PhoneControlReceiver.pending(app, PhoneControlReceiver.ACTION_STOP_RING, null)
                val text = app.getString(R.string.ring_text, operator ?: "IT")
                app.getSystemService(NotificationManager::class.java).notify(
                    NOTIFICATION_ID,
                    Notification.Builder(app, Notices.CHANNEL_RING)
                        .setSmallIcon(R.drawable.ic_stat_nigafiy)
                        .setContentTitle(app.getString(R.string.ring_title))
                        .setContentText(text)
                        .setStyle(Notification.BigTextStyle().bigText(text))
                        .setCategory(Notification.CATEGORY_ALARM)
                        .setOngoing(true)
                        .setContentIntent(stop)
                        .addAction(Notification.Action.Builder(null, app.getString(R.string.ring_stop), stop).build())
                        .setTimeoutAfter(seconds * 1000L + 2000)
                        .build(),
                )
                main.postDelayed(stopLater, seconds * 1000L)
            } catch (e: Exception) {
                failure = e
                stopNow()
            } finally {
                done.countDown()
            }
        }
        done.await(5, java.util.concurrent.TimeUnit.SECONDS)
        failure?.let { throw it }
        return how
    }

    /** Stops ringing; true when it was ringing. */
    fun stop(): Boolean {
        val was = ringing
        main.post { stopNow() }
        return was
    }

    private fun stopNow() {
        main.removeCallbacks(stopLater)
        try { player?.stop() } catch (_: Exception) { }
        player?.release()
        player = null
        tone?.release()
        tone = null
        val app = appContext
        if (app != null) {
            previousVolume?.let { v -> try { app.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, v, 0) } catch (_: Exception) { } }
            app.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        }
        previousVolume = null
        ringing = false
    }
}

/** The buttons of the phone-control notifications (not exported: only this app's notifications reach it). */
class PhoneControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_REFUSE_SHARE -> intent.getStringExtra(ScreenShare.EXTRA_SESSION)?.let { ScreenShare.answer(it, ScreenShare.Answer.DENIED) }
            ACTION_STOP_RING -> Ringer.stop()
        }
    }

    companion object {
        const val ACTION_REFUSE_SHARE = "com.nigafiy.agent.REFUSE_SHARE"
        const val ACTION_STOP_RING = "com.nigafiy.agent.STOP_RING"

        fun pending(ctx: Context, action: String, sessionId: String?): PendingIntent {
            val i = Intent(ctx, PhoneControlReceiver::class.java).setAction(action)
            sessionId?.let { i.putExtra(ScreenShare.EXTRA_SESSION, it) }
            return PendingIntent.getBroadcast(ctx, action.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
