package com.nigafiy.agent

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import com.nigafiy.agent.core.NetTools
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection

/**
 * Measurements for the Tools tab, all made from this phone. Nothing here goes to the Nigafiy server.
 * The speed test is the one thing that talks to an outside service (Cloudflare's public speed test),
 * and only when the person presses its button; the screen says so.
 *
 * No location permission: Android then hides the Wi-Fi name (SSID), but signal, band, channel and
 * link speed are still readable, which is what the person needs.
 */
class NetProbe(private val ctx: Context) {
    data class Link(
        val connected: Boolean,
        val onWifi: Boolean,
        val onCellular: Boolean,
        val ip: String?,
        val prefix: Int?,
        val gateway: String?,
        val dns: List<String>,
        val rssi: Int?,
        val freqMhz: Int?,
        val linkMbps: Int?,
    )

    fun link(): Link {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val net = cm.activeNetwork
        val caps = net?.let { cm.getNetworkCapabilities(it) }
        val lp = net?.let { cm.getLinkProperties(it) }
        val onWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val v4 = lp?.linkAddresses?.firstOrNull { it.address is Inet4Address }
        val gw = lp?.routes?.firstOrNull { it.isDefaultRoute && it.gateway is Inet4Address }?.gateway?.hostAddress
        var info: WifiInfo? = null
        if (onWifi) {
            info = if (Build.VERSION.SDK_INT >= 31) caps?.transportInfo as? WifiInfo else null
            if (info == null) {
                @Suppress("DEPRECATION")
                info = try { ctx.applicationContext.getSystemService(WifiManager::class.java).connectionInfo } catch (_: Exception) { null }
            }
        }
        val rssi = info?.rssi?.takeIf { it in -126..-1 }
        return Link(
            connected = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
            onWifi = onWifi,
            onCellular = caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true,
            ip = v4?.address?.hostAddress,
            prefix = v4?.prefixLength,
            gateway = gw,
            // IPv4 servers only: the router's IPv6 link-local address ("fe80::…%wlan0") means nothing to a person.
            dns = lp?.dnsServers?.filterIsInstance<Inet4Address>()?.mapNotNull { it.hostAddress } ?: emptyList(),
            rssi = rssi,
            freqMhz = info?.frequency?.takeIf { it > 0 },
            linkMbps = info?.linkSpeed?.takeIf { it > 0 },
        )
    }

    /**
     * One ping: Android's own `ping` (ICMP), else the time to open a TCP connection on a common port
     * (a "connection refused" also proves the host answered). Null when nothing answered.
     */
    fun ping(host: String, timeoutMs: Int = 1000): Double? {
        try {
            val p = ProcessBuilder("/system/bin/ping", "-c", "1", "-W", ((timeoutMs + 999) / 1000).toString(), host)
                .redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().use { it.readText() }
            if (!p.waitFor(timeoutMs + 1500L, TimeUnit.MILLISECONDS)) p.destroy()
            NetTools.pingTimeMs(out)?.let { return it }
        } catch (_: Exception) {
        }
        for (port in intArrayOf(443, 53, 80)) tcpTime(host, port, timeoutMs)?.let { return it }
        return null
    }

    private fun tcpTime(host: String, port: Int, timeoutMs: Int): Double? {
        val t0 = System.nanoTime()
        return try {
            Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs) }
            (System.nanoTime() - t0) / 1e6
        } catch (e: java.net.ConnectException) {
            // Refused: the host is there and said no. Android throws the same exception for "no route
            // to host" (nobody at that address), which made the first real scan list dozens of
            // addresses that were not there: only a real refusal counts.
            val ms = (System.nanoTime() - t0) / 1e6
            if (ms < timeoutMs && (e.message ?: "").contains("ECONNREFUSED")) ms else null
        } catch (_: Exception) {
            null
        }
    }

    /** True when a name resolves (the phone's DNS works). */
    fun dnsWorks(): Boolean = try { InetAddress.getAllByName("www.google.com").isNotEmpty() } catch (_: Exception) { false }

    data class CheckResult(val link: Link, val checks: NetTools.Checks, val verdict: NetTools.Verdict)

    /** "Check my connection": 5 pings to the router and to the internet, and a name lookup. */
    fun check(): CheckResult {
        val l = link()
        val router = if (l.onWifi && l.gateway != null) NetTools.stats((1..5).map { ping(l.gateway, 1000) }) else null
        val internet = NetTools.stats((1..5).map { ping(INTERNET_HOST, 1500) })
        val dns = dnsWorks()
        val checks = NetTools.Checks(l.connected, l.onWifi, l.rssi, router, internet, dns)
        return CheckResult(l, checks, NetTools.diagnose(checks))
    }

    data class Speed(val downMbps: Double?, val upMbps: Double?, val pingMs: Double?)

    /**
     * Download then upload against speed.cloudflare.com, each for about [seconds] seconds, with
     * progress (phase, current Mbps). Stops early when [cancel] is set.
     */
    fun speed(cancel: AtomicBoolean, seconds: Int = 8, progress: (phase: Int, mbps: Double) -> Unit): Speed {
        val pingMs = NetTools.stats((1..3).map { tcpTime(SPEED_HOST, 443, 2000) }).avgMs
        val down = runCatching { download(cancel, seconds) { progress(1, it) } }.getOrNull()
        if (cancel.get()) return Speed(down, null, pingMs)
        val up = runCatching { upload(cancel, seconds) { progress(2, it) } }.getOrNull()
        return Speed(down, up, pingMs)
    }

    private fun download(cancel: AtomicBoolean, seconds: Int, progress: (Double) -> Unit): Double {
        val deadline = System.nanoTime() + seconds * 1_000_000_000L
        val t0 = System.nanoTime()
        var total = 0L
        val buf = ByteArray(64 * 1024)
        while (System.nanoTime() < deadline && !cancel.get()) {
            val c = URL("https://$SPEED_HOST/__down?bytes=25000000").openConnection() as HttpsURLConnection
            c.connectTimeout = 5000; c.readTimeout = 5000
            try {
                c.inputStream.use { ins ->
                    var lastReport = 0L
                    while (System.nanoTime() < deadline && !cancel.get()) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        total += n
                        val now = System.nanoTime()
                        if (now - lastReport > 250_000_000L) { lastReport = now; progress(NetTools.mbps(total, now - t0)) }
                    }
                }
            } finally { c.disconnect() }
        }
        return NetTools.mbps(total, System.nanoTime() - t0)
    }

    private fun upload(cancel: AtomicBoolean, seconds: Int, progress: (Double) -> Unit): Double {
        val deadline = System.nanoTime() + seconds * 1_000_000_000L
        val t0 = System.nanoTime()
        var total = 0L
        val chunk = ByteArray(64 * 1024)
        while (System.nanoTime() < deadline && !cancel.get()) {
            val c = URL("https://$SPEED_HOST/__up").openConnection() as HttpURLConnection
            c.connectTimeout = 5000; c.readTimeout = 10000
            c.doOutput = true
            c.requestMethod = "POST"
            c.setFixedLengthStreamingMode(UPLOAD_BYTES)
            c.setRequestProperty("Content-Type", "application/octet-stream")
            try {
                var sent = 0L
                var lastReport = 0L
                c.outputStream.use { out ->
                    while (sent < UPLOAD_BYTES) {
                        val n = minOf(chunk.size.toLong(), UPLOAD_BYTES - sent).toInt()
                        out.write(chunk, 0, n)
                        sent += n
                        val now = System.nanoTime()
                        if (now - lastReport > 250_000_000L) { lastReport = now; progress(NetTools.mbps(total + sent, now - t0)) }
                    }
                }
                c.responseCode
                total += sent
            } finally { c.disconnect() }
        }
        return NetTools.mbps(total, System.nanoTime() - t0)
    }

    data class Found(val ip: String, val ms: Double, val name: String?)

    /**
     * Who answers on this phone's /24: a ping (or a TCP knock on common ports, for phones and PCs that
     * ignore ping) to every address, 48 at a time, then the name the router's DNS gives each one.
     * [onFound] and [onProgress] run on the scan's threads.
     */
    fun scan(ip: String, prefix: Int, cancel: AtomicBoolean, onProgress: (done: Int, total: Int) -> Unit, onFound: (Found) -> Unit) {
        val hosts = NetTools.hostsToScan(ip, prefix)
        val pool = Executors.newFixedThreadPool(48)
        val done = AtomicInteger()
        try {
            val jobs = hosts.map { h ->
                pool.submit(Callable {
                    if (!cancel.get()) {
                        val ms = knock(h)
                        if (ms != null && !cancel.get()) onFound(Found(h, ms, nameOf(h)))
                    }
                    onProgress(done.incrementAndGet(), hosts.size)
                })
            }
            jobs.forEach { runCatching { it.get() } }
        } finally {
            pool.shutdownNow()
        }
    }

    private fun knock(host: String): Double? {
        val t0 = System.nanoTime()
        try {
            if (InetAddress.getByName(host).isReachable(700)) return (System.nanoTime() - t0) / 1e6
        } catch (_: Exception) {
        }
        for (port in KNOCK_PORTS) tcpTime(host, port, 250)?.let { return it }
        return null
    }

    /** The name the network's DNS (usually the router) gives an address, or null. */
    fun nameOf(ip: String): String? = try {
        InetAddress.getByName(ip).canonicalHostName.takeIf { it != ip && it.isNotBlank() }
    } catch (_: Exception) {
        null
    }

    companion object {
        const val INTERNET_HOST = "1.1.1.1"
        const val SPEED_HOST = "speed.cloudflare.com"
        private const val UPLOAD_BYTES = 4L * 1024 * 1024
        // Web, phones' sync ports (iPhone 62078), Windows file sharing, SSH, cameras (RTSP), printers.
        private val KNOCK_PORTS = intArrayOf(80, 443, 62078, 445, 22, 554, 8080, 9100)
    }
}
