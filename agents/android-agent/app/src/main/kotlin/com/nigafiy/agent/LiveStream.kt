package com.nigafiy.agent

import com.nigafiy.agent.core.Gestures
import com.nigafiy.agent.core.InputEvent
import com.nigafiy.agent.core.Json
import com.nigafiy.agent.core.ScreenSessionRequest
import com.nigafiy.agent.core.VideoPlan
import com.nigafiy.agent.core.WsClient
import com.nigafiy.agent.core.WsClosed
import com.nigafiy.agent.core.WsHandshakeError
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The live picture of an accepted session (docs/features/android.md §12, "Live stream"): a WebSocket
 * to the API's stream hub (`/api/v1/agent/stream`, the same one the Windows agent uses) that carries
 * a JPEG whenever the screen changes while an operator watches, and brings taps, swipes and
 * Back / Home / Recents straight back. Without it (an older server, a refused upgrade) the viewer
 * keeps the slower HTTP path (one rd_capture command per picture).
 *
 * The hub sends zero viewers until the database says the person accepted, so nothing is sent
 * before consent; the session ending (here or in Fleet) closes the socket.
 */
class LiveStream private constructor(
    private val server: String,
    private val pin: String?,
    private val credential: () -> String?,
    private val session: ScreenSessionRequest,
) {
    private val running = AtomicBoolean(true)
    private val lock = Object()
    @Volatile private var ws: WsClient? = null
    private val inputs = Executors.newSingleThreadExecutor { r -> Thread(r, "nigafiy-live-input") }

    // Guarded by lock.
    private var viewers = 0
    private var needFull = true
    private var quality = DEFAULT_QUALITY
    private var scale = DEFAULT_SCALE
    private var adaptive = true
    private val inflight = HashMap<Long, Long>()
    private var seq = 0L
    private var rttMs = 0L
    private var sentFrames = 0
    private var sentBytes = 0L
    private var statsAt = 0L
    private var last: ScreenShare.Grabbed? = null
    /** The viewer decodes H.264 (settings.codecs): hardware video instead of a JPEG per picture. */
    private var wantVideo = false
    private var bitrate = 0
    // Started and stopped by the serve loop; read by the ack reader (bitrate) and the stats.
    @Volatile private var video: VideoEncoder? = null
    private var videoSide = 0
    private var videoFailed = false
    private var droppingVideo = false
    private var lastDropBackoffAt = 0L
    private val link = VideoPlan.Link()
    private var lastAdaptAt = 0L

    private fun run() {
        try {
            var failures = 0
            while (running.get()) {
                val c = try {
                    val token = credential() ?: return
                    WsClient.connect(WsClient.streamUrl(server, session.sessionId), pin, mapOf("Authorization" to "Bearer $token", "User-Agent" to "nigafiy-android-agent"))
                } catch (e: WsHandshakeError) {
                    // 401/404/409/410: no live stream for this session here; the HTTP path stays.
                    if (e.status in setOf(401, 403, 404, 409, 410)) return
                    null
                } catch (e: Exception) {
                    null
                }
                if (c == null) {
                    failures++
                    pause(minOf(10_000L, 1000L shl minOf(failures - 1, 4)))
                    continue
                }
                failures = 0
                ws = c
                val over = serve(c)
                ws = null
                c.close()
                if (over) return
                pause(1_000)
            }
        } finally {
            inputs.shutdownNow()
        }
    }

    /** One connection; true when the server ended the session. */
    private fun serve(c: WsClient): Boolean {
        synchronized(lock) { viewers = 0; needFull = true; inflight.clear() }
        val size = ScreenShare.capturer?.screenSize() ?: return true
        c.sendText(Json.write(mapOf(
            "t" to "hello",
            "session_id" to session.sessionId,
            "displays" to listOf(display(size)),
            "desktop" to mapOf("mode" to "android", "backend" to "mediaprojection", "input_supported" to (session.control && ControlService.instance != null)),
            "encoder" to "jpeg",
            // This phone can send hardware H.264 when the viewer asks for it (settings.codecs).
            "video" to listOf("h264"),
            "webp" to false,
            "control" to session.control,
            "max_fps" to MAX_FPS,
            "webrtc" to mapOf("supported" to false, "reason" to "not available on Android"),
        )))
        val over = AtomicBoolean(false)
        val reader = Thread({
            try {
                while (running.get()) {
                    val m = c.read()
                    if (m is WsClient.Message.Text) handle(c, m.text)
                }
            } catch (e: WsClosed) {
                if (e.code == CLOSE_SESSION_ENDED) over.set(true)
            } catch (_: Exception) {
            } finally {
                synchronized(lock) { lock.notifyAll() }
            }
        }, "nigafiy-live-read")
        reader.start()
        var lastPing = System.currentTimeMillis()
        val minGap = 1000L / MAX_FPS
        var idleGap = minGap
        try {
            while (running.get() && reader.isAlive) {
                val now = System.currentTimeMillis()
                if (now - lastPing > 15_000) { c.ping(); lastPing = now }
                val (v, full, q, s, blocked) = synchronized(lock) {
                    inflight.entries.removeIf { (_, at) -> if (now - at > ACK_TIMEOUT_MS) { needFull = true; true } else false }
                    val f = needFull
                    needFull = false
                    Snapshot(viewers, f, quality, scale, inflight.size >= VideoPlan.inflightWindow(rttMs, false))
                }
                if (v > 0 && synchronized(lock) { wantVideo } && !videoFailed) {
                    serveVideo(c, full, s)
                    stats(c)
                    waitFor(250)
                    continue
                }
                if (video != null) stopVideo()
                if (v == 0 || blocked) {
                    if (full) synchronized(lock) { needFull = true }
                    waitFor(250)
                    continue
                }
                val cap = ScreenShare.capturer ?: return true
                val started = System.currentTimeMillis()
                val g = try {
                    cap.grab(q, s, full)
                } catch (e: Exception) {
                    c.sendText(Json.write(mapOf("t" to "error", "where" to "capture", "error" to (e.message ?: "capture failed"))))
                    waitFor(1_000)
                    continue
                }
                if (g == null) {
                    // A still screen: look again soon, a little less often while it stays still.
                    idleGap = minOf(idleGap * 2, 200L)
                    stats(c)
                    waitFor(idleGap)
                    continue
                }
                idleGap = minGap
                val n = synchronized(lock) { ++seq }
                val header = linkedMapOf<String, Any?>(
                    "t" to "frame", "seq" to n, "full" to true, "display" to 0,
                    "w" to g.width, "h" to g.height, "sw" to g.sourceWidth, "sh" to g.sourceHeight,
                    "q" to q, "s" to g.width.toDouble() / g.sourceWidth, "fmt" to "jpeg",
                    "tiles" to listOf(mapOf("x" to 0, "y" to 0, "w" to g.width, "h" to g.height, "n" to g.jpeg.size)),
                    "cap_ms" to g.captureMs, "enc_ms" to g.encodeMs, "changed_pct" to 100, "mode" to "android",
                )
                if (full) header["displays"] = listOf(display(g.sourceWidth to g.sourceHeight))
                val pkt = WsClient.framePacket(header, g.jpeg)
                synchronized(lock) {
                    inflight[n] = System.currentTimeMillis()
                    sentFrames++
                    sentBytes += pkt.size
                    last = g
                }
                c.sendBinary(pkt)
                stats(c)
                val wait = minGap - (System.currentTimeMillis() - started)
                if (wait > 0) pause(wait)
            }
        } catch (_: Exception) {
        }
        stopVideo()
        c.close()
        reader.join(2_000)
        return over.get()
    }

    /** Keeps the hardware video running at the chosen size; a key frame when a viewer needs one. */
    private fun serveVideo(c: WsClient, full: Boolean, scale: Double) {
        val cap = ScreenShare.capturer ?: return
        val (sw, sh) = cap.screenSize()
        val side = VideoPlan.side(maxOf(sw, sh), scale, synchronized(lock) { bitrate })
        val enc = video
        if (enc == null || !enc.alive || side != videoSide || cap.videoStale()) {
            if (enc != null) stopVideo()
            val target = synchronized(lock) { if (bitrate == 0) bitrate = VideoPlan.initialBitrate(quality); bitrate }
            val (ew, eh) = VideoEncoder.sizeFor(sw, sh, side)
            // The first frames (the first key frame among them) come before startVideo returns.
            val started = cap.startVideo(side, target) { data, key, _ -> sendVideoFrame(c, data, key, ew, eh) }
            if (started == null) {
                // No usable encoder on this phone: JPEG pictures, as before.
                videoFailed = true
                c.sendText(Json.write(mapOf("t" to "video", "codec" to null, "reason" to "no hardware H.264 encoder")))
                synchronized(lock) { needFull = true }
                return
            }
            video = started
            videoSide = side
            c.sendText(Json.write(mapOf("t" to "video", "codec" to "h264", "w" to started.width, "h" to started.height)))
            return
        }
        if (full) enc.keyFrame()
    }

    private fun sendVideoFrame(c: WsClient, data: ByteArray, key: Boolean, w: Int, h: Int) {
        val (sw, sh) = ScreenShare.capturer?.screenSize() ?: return
        val now = System.currentTimeMillis()
        var requestKey = false
        var lowerBitrate: Int? = null
        val n = synchronized(lock) {
            inflight.entries.removeIf { (_, at) -> now - at > ACK_TIMEOUT_MS }
            val limit = VideoPlan.inflightWindow(rttMs, true)
            if (inflight.size >= limit && (!key || inflight.size >= limit + 4)) {
                droppingVideo = true
                if (adaptive && now - lastDropBackoffAt >= 2_000L) {
                    lastDropBackoffAt = now
                    link.stalled()
                    val next = ((bitrate * 3) / 4).coerceAtLeast(MIN_BITRATE)
                    if (next != bitrate) {
                        bitrate = next
                        lowerBitrate = next
                    }
                }
                -1L
            } else if (droppingVideo && !key) {
                // Skip delta frames after a drop until a fresh key frame catches the viewer up.
                if (inflight.size <= maxOf(2, limit / 2)) requestKey = true
                -1L
            } else {
                if (key) droppingVideo = false
                ++seq
            }
        }
        lowerBitrate?.let { video?.bitrate(it) }
        if (requestKey) video?.keyFrame()
        if (n < 0) return
        val header = linkedMapOf<String, Any?>(
            "t" to "frame", "seq" to n, "full" to key, "display" to 0,
            "w" to w, "h" to h, "sw" to sw, "sh" to sh,
            "q" to synchronized(lock) { quality }, "s" to w.toDouble() / sw, "fmt" to "h264",
            "tiles" to listOf(mapOf("x" to 0, "y" to 0, "w" to w, "h" to h, "n" to data.size)),
            "changed_pct" to 100, "mode" to "android",
        )
        if (key) header["displays"] = listOf(display(sw to sh))
        val pkt = WsClient.framePacket(header, data)
        synchronized(lock) {
            inflight[n] = now
            sentFrames++
            sentBytes += pkt.size
        }
        c.sendBinary(pkt)
    }

    private fun stopVideo() {
        if (video == null) return
        video = null
        videoSide = 0
        ScreenShare.capturer?.stopVideo()
    }

    /** The bitrate the chosen quality asks for (VideoPlan.bitrate). */
    private fun targetBitrate(): Int = VideoPlan.bitrate(quality)

    private data class Snapshot(val viewers: Int, val full: Boolean, val quality: Int, val scale: Double, val blocked: Boolean)

    private fun display(size: Pair<Int, Int>) = mapOf("index" to 0, "name" to "Phone screen", "x" to 0, "y" to 0, "width" to size.first, "height" to size.second, "primary" to true)

    private fun handle(c: WsClient, text: String) {
        val m = try { Json.parseObject(text) } catch (_: Exception) { return }
        when (m["t"]) {
            "viewers" -> synchronized(lock) {
                val n = (m["count"] as? Number)?.toInt() ?: 0
                if (n > viewers) needFull = true
                viewers = maxOf(0, n)
                lock.notifyAll()
            }
            "ack" -> synchronized(lock) {
                val s = (m["seq"] as? Number)?.toLong() ?: return
                inflight.remove(s)?.let { at ->
                    val rtt = System.currentTimeMillis() - at
                    rttMs = if (rttMs == 0L) rtt else (rttMs * 7 + rtt) / 8
                    if (adaptive) adapt()
                }
                lock.notifyAll()
            }
            "full" -> synchronized(lock) { needFull = true; lock.notifyAll() }
            "settings" -> synchronized(lock) {
                (m["quality"] as? Number)?.let { quality = it.toInt().coerceIn(10, 95) }
                (m["scale"] as? Number)?.let { scale = it.toDouble().coerceIn(0.25, 1.0) }
                (m["adaptive"] as? Boolean)?.let { adaptive = it }
                @Suppress("UNCHECKED_CAST")
                wantVideo = (m["codecs"] as? List<Any?>)?.contains("h264") == true
                bitrate = if (adaptive) minOf(if (bitrate > 0) bitrate else VideoPlan.initialBitrate(quality), targetBitrate()) else targetBitrate()
                video?.bitrate(bitrate)
                needFull = true
                lock.notifyAll()
            }
            "displays" -> ScreenShare.capturer?.screenSize()?.let { c.sendText(Json.write(mapOf("t" to "displays", "displays" to listOf(display(it))))) }
            "input" -> {
                @Suppress("UNCHECKED_CAST")
                val ev = m["ev"] as? Map<String, Any?> ?: return
                inputs.execute { applyInput(c, ev) }
            }
            "end" -> stop()
        }
    }

    /** A slow link: smaller, softer pictures; a fast one: back towards what the operator chose. */
    private fun adapt() {
        val v = video
        if (v != null) {
            // Video: once a window (not on every ack), the bitrate follows the queue the ack round
            // trip shows above the link's own base RTT (VideoPlan.Link).
            val now = System.currentTimeMillis()
            if (now - lastAdaptAt < ADAPT_EVERY_MS) return
            lastAdaptAt = now
            val next = link.step(bitrate, targetBitrate(), rttMs, MIN_BITRATE)
            if (next != bitrate) { bitrate = next; v.bitrate(next) }
            return
        }
        if (rttMs > 350 && quality > 35) quality -= 5
        else if (rttMs < 180 && quality < DEFAULT_QUALITY) quality += 1
    }

    private fun applyInput(c: WsClient, ev: Map<String, Any?>) {
        val err: String? = try {
            val s = ScreenShare.active
            val service = ControlService.instance
            val size = ScreenShare.capturer?.screenSize()
            when {
                s == null || size == null -> "The screen is not being shared on the phone"
                !s.control -> "The session's permission profile is view only: input refused by the agent"
                service == null -> "android_control_not_enabled: remote control is not turned on in Settings → Accessibility on the phone"
                else -> {
                    val event = InputEvent.parse(ev)
                    if (event is InputEvent.Unsupported) null // keys and the wheel: nothing to do on a phone
                    else if (event is InputEvent.Touch) {
                        // A live finger: no wait for Android to finish (the next move continues it).
                        service.touch(event.phase, Gestures.px(event.x, size.first), Gestures.px(event.y, size.second))
                        null
                    }
                    else if (service.perform(Gestures.plan(event, size.first, size.second))) null
                    else "Android did not complete the gesture (cancelled by the system or by a touch on the phone)"
                }
            }
        } catch (e: Exception) {
            e.message ?: "input refused"
        }
        if (err != null) try { c.sendText(Json.write(mapOf("t" to "input_error", "error" to err))) } catch (_: Exception) { }
        // The screen changes after a tap: look at once.
        synchronized(lock) { lock.notifyAll() }
    }

    private fun stats(c: WsClient) {
        val now = System.currentTimeMillis()
        val msg = synchronized(lock) {
            if (now - statsAt < 1_000) return
            val elapsed = if (statsAt == 0L || now - statsAt > 5_000) 1.0 else (now - statsAt) / 1000.0
            val g = last
            val out = mapOf(
                "t" to "stats", "fps" to Math.round(sentFrames / elapsed * 10) / 10.0, "kbps" to (sentBytes * 8 / 1000 / elapsed).toLong(),
                "rtt_ms" to rttMs, "throughput_kbps" to 0, "quality" to quality, "scale" to scale, "display" to 0, "adaptive" to adaptive,
                "changed_pct" to 100, "cap_ms" to (g?.captureMs ?: 0), "enc_ms" to (g?.encodeMs ?: 0), "viewers" to viewers,
                "width" to (video?.width ?: g?.width ?: 0), "height" to (video?.height ?: g?.height ?: 0),
                "encoder" to (if (video != null) "h264" else "jpeg"), "bitrate_kbps" to (if (video != null) bitrate / 1000 else 0),
            )
            sentFrames = 0; sentBytes = 0; statsAt = now
            out
        }
        c.sendText(Json.write(msg))
    }

    private fun waitFor(ms: Long) = synchronized(lock) { try { lock.wait(ms) } catch (_: InterruptedException) { } }
    private fun pause(ms: Long) = try { Thread.sleep(ms) } catch (_: InterruptedException) { }

    fun stop() {
        if (!running.getAndSet(false)) return
        ws?.close()
        inputs.shutdownNow()
        synchronized(lock) { lock.notifyAll() }
    }

    companion object {
        const val CLOSE_SESSION_ENDED = 4000
        private const val MAX_FPS = 15
        private const val ACK_TIMEOUT_MS = 3_000L
        private const val ADAPT_EVERY_MS = 1_500L
        private const val DEFAULT_QUALITY = 60
        private const val DEFAULT_SCALE = 0.6
        private const val MIN_BITRATE = VideoPlan.MIN_BITRATE
        @Volatile private var current: LiveStream? = null

        fun start(server: String, pin: String?, credential: () -> String?, session: ScreenSessionRequest) {
            stopAll()
            val s = LiveStream(server, pin, credential, session)
            current = s
            Thread({ try { s.run() } finally { if (current === s) current = null } }, "nigafiy-live").start()
        }

        fun stopAll() {
            current?.stop()
            current = null
        }
    }
}
