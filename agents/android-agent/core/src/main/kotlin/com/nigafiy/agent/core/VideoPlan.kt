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

    /** Adapts bitrate from measured ack RTT; caps relayed/high-RTT links instead of flooding TCP. */
    fun adaptBitrate(cur: Int, target: Int, rttMs: Long, minBitrate: Int = MIN_BITRATE): Int {
        val rttCap = when {
            rttMs >= 300 -> 1_000_000
            rttMs >= 220 -> 1_600_000
            else -> target
        }
        val cap = maxOf(minBitrate, minOf(target, rttCap))
        val next = when {
            rttMs > 220 -> (cur * 3) / 4
            rttMs in 1..129 -> minOf(cap, (cur * 105) / 100 + 50_000)
            else -> cur
        }
        return next.coerceIn(minBitrate, cap)
    }

    /** Unacknowledged frame pipeline scaled by RTT so relayed links stay responsive without queue buildup. */
    fun inflightWindow(rttMs: Long, video: Boolean): Int {
        if (video) return if (rttMs >= 150) 8 else 6
        return when {
            rttMs >= 150 -> 6
            rttMs >= 60 -> 4
            else -> 3
        }
    }
}
