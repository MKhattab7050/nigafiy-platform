package com.nigafiy.agent

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.view.Surface
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The phone's hardware H.264 encoder fed straight from the screen capture (the VirtualDisplay
 * draws into [surface]). It replaces a JPEG per picture, which was slow to make on the phone and
 * heavy on the network (owner, 2026-11-27: "from the computer to the phone is slow").
 *
 * Output is Annex B (start codes). Each key frame carries the SPS/PPS in front, so a viewer that
 * joins, or one the server stopped sending to for a moment, starts again from any key frame.
 * A still screen repeats its last picture every [REPEAT_US], so a key frame asked for on a still
 * screen still comes.
 */
class VideoEncoder(
    val width: Int,
    val height: Int,
    bitrate: Int,
    private val onFrame: (data: ByteArray, key: Boolean, ptsUs: Long) -> Unit,
) {
    private val codec: MediaCodec = MediaCodec.createEncoderByType(MIME)
    val surface: Surface
    private val running = AtomicBoolean(true)
    private val drain: Thread
    @Volatile private var config: ByteArray? = null

    init {
        try {
            codec.configure(format(bitrate, full = true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        } catch (_: Exception) {
            // Some encoders refuse the low-latency keys: the plain format is enough.
            codec.reset()
            codec.configure(format(bitrate, full = false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }
        surface = codec.createInputSurface()
        codec.start()
        drain = Thread({ drainLoop() }, "nigafiy-h264").also { it.start() }
    }

    private fun format(bitrate: Int, full: Boolean) = MediaFormat.createVideoFormat(MIME, width, height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
        setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
        // Key frames come when a viewer needs one (keyFrame()); the interval is only a safety net.
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 5)
        setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_US)
        if (full) {
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
            // Real time, and no B-frames (they hold pictures back to reorder them).
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LATENCY, 1)
        }
    }

    private fun drainLoop() {
        val info = MediaCodec.BufferInfo()
        try {
            while (running.get()) {
                val idx = codec.dequeueOutputBuffer(info, 20_000)
                if (idx < 0) continue
                val buf = codec.getOutputBuffer(idx)
                if (buf != null && info.size > 0) {
                    val bytes = ByteArray(info.size)
                    buf.position(info.offset)
                    buf.get(bytes, 0, info.size)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        config = bytes
                    } else {
                        val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                        val cfg = config
                        val out = if (key && cfg != null) cfg + bytes else bytes
                        try { onFrame(out, key, info.presentationTimeUs) } catch (_: Exception) { }
                    }
                }
                codec.releaseOutputBuffer(idx, false)
            }
        } catch (_: Exception) {
            // Stopped (IllegalStateException) or the codec failed: the stream falls back to JPEG.
        }
    }

    /** A viewer joined or lost pictures: the next frame is a key frame. */
    fun keyFrame() {
        try { codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) } catch (_: Exception) { }
    }

    fun bitrate(bps: Int) {
        try { codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps) }) } catch (_: Exception) { }
    }

    val alive: Boolean get() = running.get() && drain.isAlive

    fun stop() {
        if (!running.getAndSet(false)) return
        try { drain.join(500) } catch (_: InterruptedException) { }
        try { codec.stop() } catch (_: Exception) { }
        try { codec.release() } catch (_: Exception) { }
        try { surface.release() } catch (_: Exception) { }
    }

    companion object {
        const val MIME = "video/avc"
        const val FPS = 30
        private const val REPEAT_US = 400_000L

        /** Encoder size: the screen at most [maxSide] on its long side, both sides a multiple of 16. */
        fun sizeFor(w: Int, h: Int, maxSide: Int): Pair<Int, Int> {
            val f = minOf(1.0, maxSide.toDouble() / maxOf(w, h))
            fun align(v: Double) = (Math.round(v / 16.0) * 16).toInt().coerceAtLeast(16)
            return align(w * f) to align(h * f)
        }
    }
}
