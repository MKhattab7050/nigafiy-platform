package com.nigafiy.agent.core

/**
 * Size and bitrate of the phone's hardware video (app VideoEncoder / LiveStream).
 *
 * The console's 75 % scale default exists for JPEG pictures, where every pixel costs bandwidth;
 * H.264 at 75 % only blurs text. So video is full size (up to [MAX_SIDE] on the long side) while
 * the bitrate allows it, smaller only when a slow link pushed the bitrate down, and the console's
 * 50 % (a deliberate choice for a weak link) is still honoured (owner, 2026-11-27: speed and
 * quality must match the big remote desktop products).
 */
object VideoPlan {
    const val MIN_SIDE = 480
    const val MAX_SIDE = 1920
    const val MIN_BITRATE = 300_000
    const val INITIAL_BITRATE_CAP = 2_000_000

    /** Long side of the encoded picture for a screen whose long side is [screenLong]. */
    fun side(screenLong: Int, chosenScale: Double, bitrate: Int): Int {
        var s = when {
            bitrate in 1 until 900_000 -> 0.5
            bitrate in 1 until 1_800_000 -> 0.75
            else -> 1.0
        }
        if (chosenScale > 0 && chosenScale <= 0.5) s = minOf(s, chosenScale)
        return (screenLong * s).toInt().coerceIn(MIN_SIDE, MAX_SIDE)
    }

    /** Target bitrate ceiling for the chosen quality on a fast LAN (45: ~3.2 Mbit/s, 68: ~5.7, 85: ~7.6). */
    fun bitrate(quality: Int): Int = 1_000_000 + (quality - 25).coerceAtLeast(0) * 110_000

    /** Conservative starting bitrate so mobile / Tailscale DERP uplinks do not bufferbloat on connect. */
    fun initialBitrate(quality: Int): Int = minOf(bitrate(quality), INITIAL_BITRATE_CAP)

    /** Highest bitrate off the local network (Phase 1, 2026-11-28: clean up to ~4 Mbit/s over the relay). */
    const val WAN_BITRATE = 3_000_000
    /** A base RTT below this is the local network. */
    const val LAN_BASE_MS = 40L
    /** Windows without climbing after a cut (hysteresis). */
    const val HOLD_WINDOWS = 3
    /** The video frame rate the window is sized for (VideoEncoder.FPS). */
    const val VIDEO_FPS = 30

    /**
     * One link's bitrate controller, stepped once per window (about 1.5 s), not once per ack.
     *
     * The old rule cut the bitrate whenever the ack RTT passed 220 ms, on every ack. A phone on 4G
     * reaches the PC through a Tailscale relay whose RTT is 150-230 ms when the link is empty, so
     * the bitrate fell to the floor within a second (owner, 2026-11-28, docs/roadmap/2026-11-28-wan-speed.md).
     * This one learns the link's base RTT (the lowest recent RTT) and cuts only when the RTT rises
     * well above it (a queue is building), then waits [HOLD_WINDOWS] windows before climbing again.
     */
    class Link {
        var rttMs = 0L; private set
        var baseMs = 0L; private set
        private var hold = 0

        val wan: Boolean get() = baseMs >= LAN_BASE_MS
        val queueMs: Long get() = maxOf(0L, rttMs - baseMs)

        private fun observe(sample: Long) {
            if (sample <= 0) return
            if (rttMs == 0L) { rttMs = sample; baseMs = sample; return }
            rttMs = (rttMs * 7 + sample * 3) / 10
            baseMs = if (rttMs < baseMs) rttMs else baseMs + (rttMs - baseMs + 9) / 10
        }

        /** A stall (frames dropped or never acknowledged): no climbing for a while. */
        fun stalled() { hold = HOLD_WINDOWS }

        fun step(cur: Int, target: Int, sampleMs: Long, minBitrate: Int = MIN_BITRATE): Int {
            observe(sampleMs)
            val q = queueMs
            val big = if (wan) maxOf(300L, baseMs) else 250L
            val small = if (wan) maxOf(140L, baseMs / 2) else 100L
            val calm = if (wan) maxOf(70L, baseMs / 4) else 50L
            var next = cur
            when {
                q > big -> { next = cur * 3 / 4; hold = HOLD_WINDOWS }
                q > small -> { next = cur * 9 / 10; hold = HOLD_WINDOWS }
                hold > 0 -> hold--
                q < calm -> next = cur * 108 / 100 + 50_000
            }
            val cap = maxOf(minBitrate, if (wan) minOf(target, WAN_BITRATE) else target)
            return next.coerceIn(minBitrate, cap)
        }
    }

    /**
     * Unacknowledged frame pipeline. Video needs about one RTT of frames at [VIDEO_FPS] in flight
     * plus a few for arrival time, or the window, not the link, caps the frame rate.
     */
    fun inflightWindow(rttMs: Long, video: Boolean): Int {
        if (video) return (rttMs * VIDEO_FPS / 1000 + 3).toInt().coerceIn(6, 16)
        return when {
            rttMs >= 150 -> 6
            rttMs >= 60 -> 4
            else -> 3
        }
    }
}
