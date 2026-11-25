package com.nigafiy.agent

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import com.nigafiy.agent.core.FrameData
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The screen capture of an accepted session: a foreground service of type mediaProjection (its
 * notification "Sharing your screen with …" has a Stop button; Android shows its own cast
 * indicator as well). Frames are taken only when Fleet asks for one (rd_capture): the latest image
 * of an ImageReader behind a VirtualDisplay, scaled and compressed to JPEG. Nothing is stored on
 * the phone and nothing is captured after the session ends.
 */
class ScreenCaptureService : Service(), ScreenShare.Capturer {
    private val main = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var vdWidth = 0
    private var vdHeight = 0
    private var last: Bitmap? = null
    private var padded: Bitmap? = null
    private var contentWidth = 0
    private var lastSentDigest: String? = null
    private var lastSentKey: String? = null
    private var sessionId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Stop in the notification: the person ends the session.
            ScreenShare.endedOnPhone(this)
            return START_NOT_STICKY
        }
        val id = intent?.getStringExtra(ScreenShare.EXTRA_SESSION)
        val code = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java) else @Suppress("DEPRECATION") intent?.getParcelableExtra(EXTRA_DATA)
        if (id == null || data == null) { stopSelf(); return START_NOT_STICKY }
        sessionId = id
        val req = ScreenShare.pending?.request
        val who = req?.operator ?: "IT"
        // The foreground notification comes first: Android 14+ requires it before getMediaProjection.
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification(who), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(NOTIFICATION_ID, notification(who))
        try {
            val mpm = getSystemService(MediaProjectionManager::class.java)
            val p = mpm.getMediaProjection(code, data) ?: throw IllegalStateException("Android gave no screen capture")
            projection = p
            p.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    // Android's cast indicator, the screen locking or another app taking the capture.
                    release()
                    ScreenShare.endedOnPhone(this@ScreenCaptureService)
                }
            }, main)
            val (w, h) = screenSize()
            sizeFor(w, h)
            val r = ImageReader.newInstance(vdWidth, vdHeight, PixelFormat.RGBA_8888, 2)
            reader = r
            display = p.createVirtualDisplay("nigafiy-share", vdWidth, vdHeight, densityDpi(), DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, null)
            if (!ScreenShare.started(this, id, this)) {
                // The request was answered or withdrawn meanwhile: nothing may be captured.
                release()
                stopSelf()
            }
        } catch (e: Exception) {
            ScreenShare.answer(id, ScreenShare.Answer.UNAVAILABLE, "Android could not start the screen capture: ${e.message ?: e.javaClass.simpleName}")
            release()
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun notification(who: String): Notification {
        val stop = PendingIntent.getService(this, 31, Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val control = ScreenShare.pending?.request?.control == true && ControlService.isEnabled(this)
        val text = getString(if (control) R.string.sharing_text_control else R.string.sharing_text, who)
        return Notification.Builder(this, Notices.CHANNEL_SHARING)
            .setSmallIcon(R.drawable.ic_stat_nigafiy)
            .setContentTitle(getString(if (control) R.string.controlling_title else R.string.sharing_title))
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.sharing_stop), stop).build())
            .build()
    }

    @Suppress("DEPRECATION")
    override fun screenSize(): Pair<Int, Int> {
        val wm = getSystemService(WindowManager::class.java)
        if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.maximumWindowMetrics.bounds
            return b.width() to b.height()
        }
        val m = DisplayMetrics()
        wm.defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    private fun densityDpi(): Int = resources.displayMetrics.densityDpi

    /** The capture size: the real screen, at most [MAX_SIDE] pixels on its long side. */
    private fun sizeFor(w: Int, h: Int) {
        val f = minOf(1.0, MAX_SIDE.toDouble() / max(w, h))
        vdWidth = (w * f).roundToInt().coerceAtLeast(2) and 1.inv()
        vdHeight = (h * f).roundToInt().coerceAtLeast(2) and 1.inv()
    }

    /** The phone was turned: the virtual display follows so the picture is not squeezed. */
    private fun followRotation() {
        val (w, h) = screenSize()
        if ((w > h) == (vdWidth > vdHeight)) return
        sizeFor(w, h)
        val r = ImageReader.newInstance(vdWidth, vdHeight, PixelFormat.RGBA_8888, 2)
        display?.resize(vdWidth, vdHeight, densityDpi())
        display?.surface = r.surface
        reader?.close()
        reader = r
        last = null
        padded?.recycle()
        padded = null
    }

    /** Takes the newest image of the reader into [last]; false when the screen has not drawn since. */
    private fun takeLatest(): Boolean {
        val r = reader ?: throw IllegalStateException("the screen is not being shared")
        val img = r.acquireLatestImage() ?: return false
        img.use {
            val plane = it.planes[0]
            val pixelStride = plane.pixelStride
            val rowPadding = plane.rowStride - pixelStride * it.width
            val bw = it.width + rowPadding / pixelStride
            // The bitmap is reused while the size stays the same (no allocation per frame).
            val reuse = padded?.takeIf { b -> b.width == bw && b.height == it.height }
            val b = reuse ?: Bitmap.createBitmap(bw, it.height, Bitmap.Config.ARGB_8888).also { nb -> padded?.recycle(); padded = nb }
            plane.buffer.rewind()
            b.copyPixelsFromBuffer(plane.buffer)
            contentWidth = it.width
        }
        last = padded
        return true
    }

    private fun encode(src: Bitmap, quality: Int, scale: Double): Triple<ByteArray, Int, Int> {
        val (sw, _) = screenSize()
        val cw = contentWidth.takeIf { it in 1..src.width } ?: src.width
        val outW = minOf(cw, (sw * scale).roundToInt()).coerceAtLeast(2)
        val outH = (outW.toDouble() * src.height / cw).roundToInt().coerceAtLeast(2)
        val scaled = if (outW == src.width && cw == src.width) src else {
            val m = android.graphics.Matrix().apply { setScale(outW.toFloat() / cw, outH.toFloat() / src.height) }
            Bitmap.createBitmap(src, 0, 0, cw, src.height, m, true)
        }
        val buf = ByteArrayOutputStream(64 * 1024)
        scaled.compress(Bitmap.CompressFormat.JPEG, quality, buf)
        if (scaled !== src) scaled.recycle()
        return Triple(buf.toByteArray(), outW, outH)
    }

    @Synchronized
    override fun grab(quality: Int, scale: Double, full: Boolean): ScreenShare.Grabbed? {
        if (projection == null) throw IllegalStateException("the screen is not being shared")
        val t0 = System.currentTimeMillis()
        followRotation()
        val fresh = takeLatest()
        if (!fresh && !full) return null
        val src = last ?: return null
        val t1 = System.currentTimeMillis()
        val (bytes, w, h) = encode(src, quality, scale)
        val (sw, sh) = screenSize()
        return ScreenShare.Grabbed(bytes, w, h, sw, sh, t1 - t0, System.currentTimeMillis() - t1)
    }

    @Synchronized
    override fun frame(quality: Int, scale: Double, full: Boolean): Map<String, Any?> {
        val t0 = System.currentTimeMillis()
        if (projection == null) throw IllegalStateException("the screen is not being shared")
        followRotation()
        takeLatest()
        val src = last ?: throw IllegalStateException("no picture yet: the screen has not drawn since sharing started")
        val (sw, sh) = screenSize()
        val (bytes, outW, outH) = encode(src, quality, scale)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val key = "$quality/$outW"
        // The same picture again: no image travels (the viewer keeps the one it has).
        val unchanged = !full && digest == lastSentDigest && key == lastSentKey
        lastSentDigest = digest
        lastSentKey = key
        return FrameData.of(
            jpegBase64 = if (unchanged) null else Base64.getEncoder().encodeToString(bytes),
            byteLength = bytes.size,
            width = outW,
            height = outH,
            sourceWidth = sw,
            sourceHeight = sh,
            quality = quality,
            scale = outW.toDouble() / sw,
            captureMs = System.currentTimeMillis() - t0,
            capturedAt = Instant.now().toString(),
            unchanged = unchanged,
        )
    }

    @Synchronized
    private fun release() {
        try { display?.release() } catch (_: Exception) { }
        display = null
        try { reader?.close() } catch (_: Exception) { }
        reader = null
        val p = projection
        projection = null
        try { p?.stop() } catch (_: Exception) { }
        last = null
        padded?.recycle()
        padded = null
    }

    override fun onDestroy() {
        release()
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_ID = 30
        private const val MAX_SIDE = 1600
        private const val ACTION_STOP = "com.nigafiy.agent.STOP_SHARING"
        private const val EXTRA_CODE = "com.nigafiy.agent.CODE"
        private const val EXTRA_DATA = "com.nigafiy.agent.DATA"
        @Volatile private var running = false

        fun start(ctx: Context, sessionId: String, resultCode: Int, data: Intent) {
            running = true
            ctx.startForegroundService(
                Intent(ctx, ScreenCaptureService::class.java)
                    .putExtra(ScreenShare.EXTRA_SESSION, sessionId)
                    .putExtra(EXTRA_CODE, resultCode)
                    .putExtra(EXTRA_DATA, data),
            )
        }

        fun stop(ctx: Context) {
            if (!running) return
            running = false
            ctx.stopService(Intent(ctx, ScreenCaptureService::class.java))
        }
    }
}
