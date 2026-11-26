package com.nigafiy.agent.core

import kotlin.math.abs
import kotlin.math.max

/**
 * The phone's own network tools (Tools tab), the parts that need no Android: reading `ping` output,
 * the addresses of the phone's subnet, the one-line verdict of "Check my connection", speed maths
 * and Wi-Fi signal wording. Everything here is measured from the phone itself; nothing is sent to
 * the Nigafiy server.
 */
object NetTools {
    private val TIME = Regex("""time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms""")

    /** The round trip of one reply line of Android's `ping` ("… time=12.3 ms"), or null. */
    fun pingTimeMs(output: String): Double? = TIME.find(output)?.groupValues?.get(1)?.toDoubleOrNull()

    /** A run of pings; null samples were lost. */
    data class PingStats(val sent: Int, val received: Int, val minMs: Double?, val avgMs: Double?, val maxMs: Double?, val jitterMs: Double?) {
        val lossPct: Int get() = if (sent == 0) 0 else ((sent - received) * 100 + sent / 2) / sent
    }

    fun stats(samples: List<Double?>): PingStats {
        val got = samples.filterNotNull()
        if (got.isEmpty()) return PingStats(samples.size, 0, null, null, null, null)
        // Jitter as most tools show it: the mean difference between consecutive replies.
        val jitter = if (got.size < 2) 0.0 else got.zipWithNext { a, b -> abs(b - a) }.average()
        return PingStats(samples.size, got.size, got.min(), got.average(), got.max(), jitter)
    }

    fun ipToInt(ip: String): Int? {
        val p = ip.trim().split('.')
        if (p.size != 4) return null
        var v = 0
        for (s in p) {
            val n = s.toIntOrNull() ?: return null
            if (n !in 0..255) return null
            v = (v shl 8) or n
        }
        return v
    }

    fun intToIp(v: Int): String = "${(v ushr 24) and 255}.${(v ushr 16) and 255}.${(v ushr 8) and 255}.${v and 255}"

    /**
     * The other addresses to look at on the phone's subnet, nearest first in address order. A subnet
     * wider than /24 is cut to the /24 around the phone (a home network is a /24; a scan of a /16
     * would take hours and look like an attack).
     */
    fun hostsToScan(ip: String, prefix: Int): List<String> {
        val me = ipToInt(ip) ?: return emptyList()
        val bits = prefix.coerceIn(24, 30)
        val mask = if (bits == 0) 0 else -1 shl (32 - bits)
        val net = me and mask
        val broadcast = net or mask.inv()
        val out = ArrayList<String>()
        var a = net + 1
        while (a < broadcast) {
            if (a != me) out.add(intToIp(a))
            a++
        }
        return out
    }

    /** What "Check my connection" found, worst first. */
    enum class Verdict { NO_CONNECTION, ROUTER_UNREACHABLE, NO_INTERNET, DNS_BROKEN, WEAK_WIFI, UNSTABLE, SLOW, ALL_GOOD }

    /**
     * The measurements behind a verdict. Router values are null when the phone is not on Wi-Fi
     * (mobile data has no router of ours to test).
     */
    data class Checks(
        val connected: Boolean,
        val onWifi: Boolean,
        val rssi: Int?,
        val router: PingStats?,
        val internet: PingStats,
        val dnsOk: Boolean,
    )

    fun diagnose(c: Checks): Verdict {
        if (!c.connected) return Verdict.NO_CONNECTION
        val r = c.router
        if (c.onWifi && r != null && r.received == 0) return Verdict.ROUTER_UNREACHABLE
        // The internet probe already falls back from ping to a TCP connect, so no reply at all is a
        // real outage even if the router still answers names from its cache.
        if (c.internet.received == 0) return Verdict.NO_INTERNET
        if (!c.dnsOk) return Verdict.DNS_BROKEN
        val weak = c.onWifi && c.rssi != null && c.rssi < -75
        val routerSlow = r?.avgMs != null && r.avgMs > 40
        if (weak && (routerSlow || (r?.lossPct ?: 0) > 0)) return Verdict.WEAK_WIFI
        if (c.internet.lossPct >= 10 || (r?.lossPct ?: 0) >= 10) return if (weak) Verdict.WEAK_WIFI else Verdict.UNSTABLE
        if ((c.internet.avgMs ?: 0.0) > 150 || (c.internet.jitterMs ?: 0.0) > 50) return if (routerSlow) Verdict.WEAK_WIFI else Verdict.SLOW
        if (routerSlow) return Verdict.WEAK_WIFI
        return Verdict.ALL_GOOD
    }

    /** Megabits per second for [bytes] moved in [nanos]. */
    fun mbps(bytes: Long, nanos: Long): Double = if (nanos <= 0) 0.0 else bytes * 8.0 / (nanos / 1e9) / 1e6

    /** 0 (no signal) to 4 bars from the Wi-Fi RSSI in dBm, as Android's own status bar roughly does. */
    fun bars(rssi: Int): Int = when {
        rssi >= -55 -> 4
        rssi >= -67 -> 3
        rssi >= -75 -> 2
        rssi >= -85 -> 1
        else -> 0
    }

    fun bandOf(freqMhz: Int): String? = when (freqMhz) {
        in 2400..2500 -> "2.4 GHz"
        in 4900..5899 -> "5 GHz"
        in 5925..7125 -> "6 GHz"
        else -> null
    }

    fun channelOf(freqMhz: Int): Int? = when (freqMhz) {
        2484 -> 14
        in 2412..2472 -> (freqMhz - 2407) / 5
        in 5000..5899 -> (freqMhz - 5000) / 5
        in 5955..7115 -> (freqMhz - 5950) / 5
        else -> null
    }

    /** A rounded number for the screen: 0.8, 12, 345. */
    fun short(v: Double): String = when {
        v < 10 -> String.format(java.util.Locale.ROOT, "%.1f", v)
        else -> max(0, Math.round(v).toInt()).toString()
    }
}
