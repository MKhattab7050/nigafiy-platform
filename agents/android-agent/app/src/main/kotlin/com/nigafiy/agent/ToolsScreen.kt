package com.nigafiy.agent

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import com.nigafiy.agent.core.NetTools
import com.nigafiy.agent.core.NetTools.Verdict
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The Tools tab: "Check my connection", a live ping with a graph, an internet speed test, the Wi-Fi
 * signal, and the devices on this network. Built once and kept across tab switches, so a running
 * scan or speed test keeps its results; each card updates its own views (the Home tab's 3-second
 * redraw never touches this screen).
 */
class ToolsScreen(private val act: Activity, private val ui: Ui, private val onCheckDone: (NetProbe.CheckResult) -> Unit) {
    private val probe = NetProbe(act)
    private val main = Handler(Looper.getMainLooper())
    private val prefs = act.getSharedPreferences("nigafiy-tools", Context.MODE_PRIVATE)
    private var visible = false

    val view: LinearLayout = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(24)) }

    private fun s(id: Int, vararg a: Any) = act.getString(id, *a)
    private fun ms(v: Double?) = if (v == null) "—" else s(R.string.unit_ms, NetTools.short(v))
    private fun ui(block: () -> Unit) = main.post { if (!act.isDestroyed) block() }

    init {
        view.addView(ui.header(s(R.string.tools_title), s(R.string.tools_subtitle), null))
        buildCheck()
        buildWifi()
        buildPing()
        buildSpeed()
        buildScan()
    }

    fun onShow() { visible = true; wifiTick.run() }
    fun onHide() { visible = false; main.removeCallbacks(wifiTick); stopPing() }

    // ---- Check my connection -------------------------------------------------------------------

    private lateinit var checkBody: LinearLayout
    private lateinit var checkButton: TextView
    private val checking = AtomicBoolean(false)

    private fun buildCheck() {
        val c = ui.card(view, s(R.string.check_title), s(R.string.check_hint))
        checkBody = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        c.addView(checkBody)
        checkButton = ui.button(s(R.string.check_run)) { runCheck() }
        c.addView(checkButton, lp(top = 10))
    }

    /** Runs the check (also from the Home tab's button). */
    fun runCheck() {
        if (!checking.compareAndSet(false, true)) return
        checkButton.isEnabled = false
        checkButton.text = s(R.string.check_running)
        checkBody.removeAllViews()
        checkBody.addView(ui.text(s(R.string.check_running_detail), 13f, ui.muted))
        Thread {
            val r = try { probe.check() } catch (e: Exception) { null }
            ui {
                checking.set(false)
                checkButton.isEnabled = true
                checkButton.text = s(R.string.check_again)
                checkBody.removeAllViews()
                if (r == null) { ui.note(checkBody, s(R.string.check_failed)); return@ui }
                showCheck(r)
                onCheckDone(r)
            }
        }.start()
    }

    private fun showCheck(r: NetProbe.CheckResult) {
        val (title, detail) = verdictText(r.verdict)
        val color = when (r.verdict) { Verdict.ALL_GOOD -> ui.ok; Verdict.SLOW, Verdict.WEAK_WIFI, Verdict.UNSTABLE -> ui.warn; else -> ui.bad }
        checkBody.addView(ui.verdict(title, detail, color))
        val c = r.checks
        c.router?.let { ui.fact(checkBody, s(R.string.check_router), pingLine(it)) }
        ui.fact(checkBody, s(R.string.check_internet), pingLine(c.internet))
        ui.fact(checkBody, s(R.string.check_dns), s(if (c.dnsOk) R.string.check_dns_ok else R.string.check_dns_bad))
        c.rssi?.takeIf { c.onWifi }?.let { ui.fact(checkBody, s(R.string.wifi_signal), signalLine(it)) }
    }

    private fun pingLine(p: NetTools.PingStats) =
        if (p.received == 0) s(R.string.check_no_reply) else s(R.string.check_ping_line, ms(p.avgMs), p.lossPct)

    fun verdictText(v: Verdict): Pair<String, String> = when (v) {
        Verdict.ALL_GOOD -> s(R.string.v_good) to s(R.string.v_good_detail)
        Verdict.NO_CONNECTION -> s(R.string.v_none) to s(R.string.v_none_detail)
        Verdict.ROUTER_UNREACHABLE -> s(R.string.v_router) to s(R.string.v_router_detail)
        Verdict.NO_INTERNET -> s(R.string.v_internet) to s(R.string.v_internet_detail)
        Verdict.DNS_BROKEN -> s(R.string.v_dns) to s(R.string.v_dns_detail)
        Verdict.WEAK_WIFI -> s(R.string.v_weak) to s(R.string.v_weak_detail)
        Verdict.UNSTABLE -> s(R.string.v_unstable) to s(R.string.v_unstable_detail)
        Verdict.SLOW -> s(R.string.v_slow) to s(R.string.v_slow_detail)
    }

    fun signalLine(rssi: Int): String {
        val word = s(when (NetTools.bars(rssi)) { 4 -> R.string.signal_4; 3 -> R.string.signal_3; 2 -> R.string.signal_2; 1 -> R.string.signal_1; else -> R.string.signal_0 })
        return s(R.string.signal_line, word, rssi)
    }

    // ---- Wi-Fi ---------------------------------------------------------------------------------

    private lateinit var wifiBody: LinearLayout
    private lateinit var bars: SignalBars
    private val wifiTick = object : Runnable {
        override fun run() {
            if (!visible) return
            Thread {
                val l = try { probe.link() } catch (_: Exception) { null }
                ui { if (l != null) showWifi(l) }
            }.start()
            main.postDelayed(this, 2000)
        }
    }

    private fun buildWifi() {
        val c = ui.card(view, s(R.string.wifi_title), s(R.string.wifi_hint))
        bars = SignalBars(act, ui)
        c.addView(bars, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, ui.dp(56)).apply { topMargin = ui.dp(8) })
        wifiBody = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        c.addView(wifiBody)
    }

    private fun showWifi(l: NetProbe.Link) {
        wifiBody.removeAllViews()
        if (!l.onWifi) {
            bars.set(null, s(if (l.onCellular) R.string.wifi_off_cell else R.string.wifi_off))
        } else {
            bars.set(l.rssi?.let { NetTools.bars(it) }, l.rssi?.let { signalLine(it) } ?: "—")
            val band = l.freqMhz?.let { f -> listOfNotNull(NetTools.bandOf(f), NetTools.channelOf(f)?.let { s(R.string.wifi_channel, it) }).joinToString(" · ") }
            if (!band.isNullOrEmpty()) ui.fact(wifiBody, s(R.string.wifi_band), band)
            l.linkMbps?.let { ui.fact(wifiBody, s(R.string.wifi_link), s(R.string.unit_mbps, it.toString())) }
        }
        l.ip?.let { ui.fact(wifiBody, s(R.string.wifi_ip), it, ltr = true) }
        l.gateway?.let { ui.fact(wifiBody, s(R.string.wifi_router), it, ltr = true) }
        if (l.dns.isNotEmpty()) ui.fact(wifiBody, s(R.string.wifi_dns), l.dns.joinToString("  "), ltr = true)
    }

    // ---- Ping ----------------------------------------------------------------------------------

    private lateinit var pingTarget: EditText
    private lateinit var pingButton: TextView
    private lateinit var pingStats: TextView
    private lateinit var graph: PingGraph
    @Volatile private var pinging: AtomicBoolean? = null

    private fun buildPing() {
        val c = ui.card(view, s(R.string.ping_title), s(R.string.ping_hint))
        val chips = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
        pingTarget = EditText(act).apply {
            hint = s(R.string.ping_target_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            isSingleLine = true
            textDirection = View.TEXT_DIRECTION_LTR
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            setText(prefs.getString("ping_target", NetProbe.INTERNET_HOST))
            ui.styleField(this)
        }
        fun preset(label: Int, host: () -> String?) = chips.addView(ui.pill(s(label)) {
            host()?.let { pingTarget.setText(it); if (pinging != null) { stopPing(); startPing() } }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginEnd = ui.dp(8) })
        preset(R.string.ping_router) { probe.link().gateway }
        preset(R.string.ping_internet) { NetProbe.INTERNET_HOST }
        preset(R.string.ping_google) { "8.8.8.8" }
        c.addView(HorizontalScrollView(act).apply { isHorizontalScrollBarEnabled = false; addView(chips) }, lp(top = 8))
        c.addView(pingTarget)
        graph = PingGraph(act, ui)
        c.addView(graph, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, ui.dp(120)).apply { topMargin = ui.dp(12) })
        pingStats = ui.text(s(R.string.ping_idle), 13f, ui.muted)
        c.addView(pingStats)
        pingButton = ui.button(s(R.string.ping_start)) { if (pinging == null) startPing() else stopPing() }
        c.addView(pingButton, lp(top = 10))
    }

    private fun startPing() {
        val host = pingTarget.text.toString().trim()
        if (host.isEmpty()) return
        prefs.edit().putString("ping_target", host).apply()
        val stop = AtomicBoolean(false)
        pinging = stop
        pingButton.text = s(R.string.ping_stop)
        graph.clear()
        val samples = ArrayList<Double?>()
        Thread {
            while (!stop.get()) {
                val t0 = System.currentTimeMillis()
                val v = probe.ping(host, 1000)
                if (stop.get()) break
                synchronized(samples) { samples.add(v); if (samples.size > 120) samples.removeAt(0) }
                val st = synchronized(samples) { NetTools.stats(samples.toList()) }
                ui {
                    graph.add(v)
                    pingStats.text = s(R.string.ping_line, if (v == null) s(R.string.ping_lost) else ms(v), ms(st.avgMs), ms(st.minMs), ms(st.maxMs), st.lossPct)
                }
                val wait = 1000 - (System.currentTimeMillis() - t0)
                if (wait > 0) try { Thread.sleep(wait) } catch (_: InterruptedException) { break }
            }
        }.start()
    }

    private fun stopPing() {
        pinging?.set(true)
        pinging = null
        if (::pingButton.isInitialized) pingButton.text = s(R.string.ping_start)
    }

    // ---- Speed ---------------------------------------------------------------------------------

    private lateinit var speedBody: LinearLayout
    private lateinit var speedButton: TextView
    private var speedCancel: AtomicBoolean? = null

    private fun buildSpeed() {
        val c = ui.card(view, s(R.string.speed_title), s(R.string.speed_hint))
        speedBody = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        c.addView(speedBody)
        showSpeed(
            prefs.getFloat("speed_down", -1f).takeIf { it >= 0 }?.toDouble(),
            prefs.getFloat("speed_up", -1f).takeIf { it >= 0 }?.toDouble(),
            prefs.getFloat("speed_ping", -1f).takeIf { it >= 0 }?.toDouble(),
            prefs.getLong("speed_at", 0L).takeIf { it > 0 },
        )
        speedButton = ui.button(s(R.string.speed_run)) { if (speedCancel == null) runSpeed() else speedCancel?.set(true) }
        c.addView(speedButton, lp(top = 10))
    }

    private fun showSpeed(down: Double?, up: Double?, ping: Double?, at: Long?, phase: Int = 0) {
        speedBody.removeAllViews()
        val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
        fun big(label: Int, v: String, active: Boolean) = row.addView(ui.bigNumber(s(label), v, active), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        big(R.string.speed_down, down?.let { NetTools.short(it) } ?: "—", phase == 1)
        big(R.string.speed_up, up?.let { NetTools.short(it) } ?: "—", phase == 2)
        big(R.string.speed_ping, ping?.let { NetTools.short(it) } ?: "—", false)
        speedBody.addView(row, lp(top = 8))
        speedBody.addView(ui.text(s(R.string.speed_units), 12f, ui.muted, top = 2))
        if (at != null && phase == 0) speedBody.addView(ui.text(s(R.string.speed_last, android.text.format.DateUtils.getRelativeTimeSpanString(at)), 12f, ui.muted, top = 2))
    }

    private fun runSpeed() {
        val cancel = AtomicBoolean(false)
        speedCancel = cancel
        speedButton.text = s(R.string.speed_cancel)
        var down: Double? = null
        var up: Double? = null
        showSpeed(null, null, null, null, phase = 1)
        Thread {
            val r = try {
                probe.speed(cancel) { phase, mbps ->
                    if (phase == 1) down = mbps else up = mbps
                    ui { showSpeed(down, up, null, null, phase) }
                }
            } catch (_: Exception) { null }
            ui {
                speedCancel = null
                speedButton.text = s(R.string.speed_again)
                if (r == null || (r.downMbps == null && r.upMbps == null)) {
                    showSpeed(null, null, null, null)
                    ui.note(speedBody, s(R.string.speed_failed))
                    return@ui
                }
                val now = System.currentTimeMillis()
                if (!cancel.get()) prefs.edit()
                    .putFloat("speed_down", (r.downMbps ?: -1.0).toFloat()).putFloat("speed_up", (r.upMbps ?: -1.0).toFloat())
                    .putFloat("speed_ping", (r.pingMs ?: -1.0).toFloat()).putLong("speed_at", now).apply()
                showSpeed(r.downMbps, r.upMbps, r.pingMs, now)
            }
        }.start()
    }

    // ---- Devices on this network ---------------------------------------------------------------

    private lateinit var scanBody: LinearLayout
    private lateinit var scanStatus: TextView
    private lateinit var scanButton: TextView
    private var scanCancel: AtomicBoolean? = null

    private fun buildScan() {
        val c = ui.card(view, s(R.string.scan_title), s(R.string.scan_hint))
        scanStatus = ui.text("", 13f, ui.muted)
        scanStatus.visibility = View.GONE
        c.addView(scanStatus)
        scanBody = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        c.addView(scanBody)
        scanButton = ui.button(s(R.string.scan_run)) { if (scanCancel == null) runScan() else scanCancel?.set(true) }
        c.addView(scanButton, lp(top = 10))
    }

    private fun runScan() {
        val l = probe.link()
        if (!l.onWifi || l.ip == null) {
            scanStatus.visibility = View.VISIBLE
            scanStatus.text = s(R.string.scan_need_wifi)
            return
        }
        val cancel = AtomicBoolean(false)
        scanCancel = cancel
        scanButton.text = s(R.string.scan_cancel)
        scanBody.removeAllViews()
        scanStatus.visibility = View.VISIBLE
        val found = sortedMapOf<Int, NetProbe.Found>()
        // This phone first: it is on the network too, and it does not answer its own scan.
        found[NetTools.ipToInt(l.ip) ?: 0] = NetProbe.Found(l.ip, 0.0, null)
        fun redraw(done: Int, total: Int) {
            // The scan threads add to [found] while this runs on the UI thread: copy it under the lock
            // (iterating it directly crashed the app on the first real-phone scan).
            val list = synchronized(found) { found.values.toList() }
            scanStatus.text = if (done < total) s(R.string.scan_progress, done, total, list.size) else s(R.string.scan_done, list.size)
            scanBody.removeAllViews()
            for (f in list) {
                val tag = when (f.ip) { l.ip -> s(R.string.scan_this_phone); l.gateway -> s(R.string.scan_router); else -> null }
                val name = f.name?.removeSuffix(".home")?.removeSuffix(".lan")?.removeSuffix(".local") ?: tag ?: s(R.string.scan_unknown)
                ui.deviceRow(scanBody, name, f.ip, tag?.takeIf { it != name }, if (f.ip == l.ip) null else ms(f.ms))
            }
        }
        redraw(0, 1)
        Thread {
            var last = 0L
            try {
                probe.scan(l.ip, l.prefix ?: 24, cancel, { done, total ->
                    val now = System.currentTimeMillis()
                    if (now - last > 300 || done == total) { last = now; ui { redraw(done, total) } }
                }) { f -> synchronized(found) { NetTools.ipToInt(f.ip)?.let { found[it] = f } } }
            } catch (_: Exception) {
            }
            ui {
                scanCancel = null
                scanButton.text = s(R.string.scan_again)
                redraw(1, 1)
            }
        }.start()
    }

    private fun lp(top: Int = 0) = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = ui.dp(top) }
}

/** The ping graph: the last two minutes of replies; a lost reply is a red tick at the bottom. */
class PingGraph(ctx: Context, private val ui: Ui) : View(ctx) {
    private val samples = ArrayList<Double?>()
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ui.brand; strokeWidth = ui.dp(2).toFloat(); style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(40, Color.red(ui.brand), Color.green(ui.brand), Color.blue(ui.brand)); style = Paint.Style.FILL }
    private val lostPaint = Paint().apply { color = ui.bad; strokeWidth = ui.dp(2).toFloat() }
    private val gridPaint = Paint().apply { color = ui.line; strokeWidth = 1f }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ui.muted; textSize = ui.dp(11).toFloat() }

    fun clear() { samples.clear(); invalidate() }
    fun add(v: Double?) { samples.add(v); if (samples.size > 120) samples.removeAt(0); invalidate() }

    override fun onDraw(c: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        val top = ui.dp(14).toFloat(); val bottom = h - ui.dp(6)
        val got = samples.filterNotNull()
        val max = maxOf(20.0, (got.maxOrNull() ?: 0.0) * 1.2)
        for (i in 0..2) { val y = top + (bottom - top) * i / 2; c.drawLine(0f, y, w, y, gridPaint) }
        c.drawText("${max.toInt()} ms", 0f, top - ui.dp(3), labelPaint)
        if (samples.isEmpty()) return
        // The first half minute spreads across the width; after that the graph scrolls (2 minutes).
        val span = samples.size.coerceIn(30, 120)
        val step = w / (span - 1f)
        val x0 = w - (samples.size - 1) * step
        val path = Path(); val fill = Path()
        var started = false
        samples.forEachIndexed { i, v ->
            val x = x0 + i * step
            if (v == null) { c.drawLine(x, bottom - ui.dp(8), x, bottom, lostPaint); return@forEachIndexed }
            val y = (bottom - (v / max) * (bottom - top)).toFloat()
            if (!started) { path.moveTo(x, y); fill.moveTo(x, bottom); fill.lineTo(x, y); started = true } else { path.lineTo(x, y); fill.lineTo(x, y) }
            if (i == samples.lastIndex) { fill.lineTo(x, bottom); fill.close() }
        }
        if (started) { c.drawPath(fill, fillPaint); c.drawPath(path, linePaint) }
    }
}

/** Four bars and a sentence ("Good (−62 dBm)"); null bars = not on Wi-Fi. */
class SignalBars(ctx: Context, private val ui: Ui) : LinearLayout(ctx) {
    private val barsView = object : View(ctx) {
        var n: Int? = null
        val on = Paint(Paint.ANTI_ALIAS_FLAG)
        val off = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ui.line }
        override fun onDraw(c: Canvas) {
            val bw = width / 5f; val gap = bw / 3
            on.color = when (n) { 4, 3 -> ui.ok; 2 -> ui.warn; else -> ui.bad }
            for (i in 0 until 4) {
                val bh = height * (i + 1) / 4f
                val x = i * (bw + gap)
                c.drawRoundRect(x, height - bh, x + bw, height.toFloat(), 4f, 4f, if ((n ?: -1) > i) on else off)
            }
        }
    }
    private val label = TextView(ctx).apply { textSize = 18f; setTextColor(ui.fg); typeface = android.graphics.Typeface.DEFAULT_BOLD }

    init {
        orientation = HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        addView(barsView, LayoutParams(ui.dp(48), ui.dp(36)).apply { marginEnd = ui.dp(14) })
        addView(label, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    }

    fun set(bars: Int?, text: String) { barsView.n = bars; barsView.invalidate(); label.text = text }
}
