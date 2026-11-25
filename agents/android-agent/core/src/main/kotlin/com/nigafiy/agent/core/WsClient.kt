package com.nigafiy.agent.core

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket

/** The server refused the upgrade with this HTTP status (404, 409, 410 … mean: no live stream here). */
class WsHandshakeError(val status: Int, message: String) : IOException(message)

/** The server closed the socket with this code (4000: the session is over). */
class WsClosed(val code: Int, val reason: String) : IOException("closed $code $reason")

/**
 * A small RFC 6455 client (text, binary, ping/pong, close) on a plain socket, so the phone needs no
 * extra library: the live Remote Desktop stream (docs/features/android.md §12, "Live stream"). TLS
 * uses the same trust as [Gateway]: with a pin only the pinned chain is trusted (and the pin replaces
 * the host name check); without one the system trust store and host name check decide.
 * Writes are synchronised; one thread reads.
 */
class WsClient private constructor(private val socket: Socket, private val input: DataInputStream, private val output: OutputStream) {
    private val random = SecureRandom()
    private val writeLock = Any()

    sealed class Message {
        class Text(val text: String) : Message()
        class Binary(val bytes: ByteArray) : Message()
    }

    fun sendText(text: String) = write(0x1, text.toByteArray(Charsets.UTF_8))
    fun sendBinary(bytes: ByteArray) = write(0x2, bytes)
    fun ping() = write(0x9, byteArrayOf(0x6b))

    fun close(code: Int = 1000) {
        try { write(0x8, byteArrayOf((code shr 8).toByte(), code.toByte())) } catch (_: IOException) { }
        try { socket.close() } catch (_: IOException) { }
    }

    /** The next text or binary message (pings are answered here); throws [WsClosed] on a close frame. */
    fun read(): Message {
        val buf = ByteArrayOutputStream()
        var opcode = -1
        while (true) {
            val b0 = input.readUnsignedByte()
            val b1 = input.readUnsignedByte()
            val fin = b0 and 0x80 != 0
            val op = b0 and 0x0f
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) len = input.readUnsignedShort().toLong() else if (len == 127L) len = input.readLong()
            if (len < 0 || len > MAX_MESSAGE) throw IOException("message too large")
            val mask = if (b1 and 0x80 != 0) ByteArray(4).also { input.readFully(it) } else null
            val payload = ByteArray(len.toInt()).also { input.readFully(it) }
            if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
            when (op) {
                0x8 -> {
                    val code = if (payload.size >= 2) ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff) else 1005
                    val reason = if (payload.size > 2) String(payload, 2, payload.size - 2, Charsets.UTF_8) else ""
                    try { socket.close() } catch (_: IOException) { }
                    throw WsClosed(code, reason)
                }
                0x9 -> { write(0xA, payload); continue }
                0xA -> continue
                0x0, 0x1, 0x2 -> {
                    if (op != 0) opcode = op
                    buf.write(payload)
                    if (buf.size() > MAX_MESSAGE) throw IOException("message too large")
                    if (fin) {
                        val bytes = buf.toByteArray()
                        return if (opcode == 0x1) Message.Text(String(bytes, Charsets.UTF_8)) else Message.Binary(bytes)
                    }
                }
                else -> throw IOException("unknown opcode $op")
            }
        }
    }

    private fun write(op: Int, payload: ByteArray) = synchronized(writeLock) {
        output.write(encodeFrame(op, payload, ByteArray(4).also { random.nextBytes(it) }))
        output.flush()
    }

    companion object {
        const val MAX_MESSAGE = 8 shl 20
        private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        /** One final, masked client frame. */
        fun encodeFrame(op: Int, payload: ByteArray, mask: ByteArray): ByteArray {
            val out = ByteArrayOutputStream(payload.size + 14)
            out.write(0x80 or op)
            when {
                payload.size < 126 -> out.write(0x80 or payload.size)
                payload.size < 65536 -> { out.write(0x80 or 126); out.write(payload.size shr 8); out.write(payload.size and 0xff) }
                else -> { out.write(0x80 or 127); for (i in 7 downTo 0) out.write(((payload.size.toLong() shr (8 * i)) and 0xff).toInt()) }
            }
            out.write(mask)
            for (i in payload.indices) out.write(payload[i].toInt() xor mask[i % 4].toInt())
            return out.toByteArray()
        }

        fun acceptKey(key: String): String =
            Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.US_ASCII)))

        /** `https://srv:8443` + session → `wss://srv:8443/api/v1/agent/stream?session=…`. */
        fun streamUrl(server: String, sessionId: String): String {
            val base = server.trimEnd('/')
            val ws = when {
                base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
                base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
                else -> throw IllegalArgumentException("unsupported server address")
            }
            return "$ws/api/v1/agent/stream?session=" + java.net.URLEncoder.encode(sessionId, "UTF-8")
        }

        fun connect(url: String, pin: String?, headers: Map<String, String>, timeoutMs: Int = 15_000): WsClient {
            val u = URI(url)
            val secure = u.scheme == "wss"
            val port = if (u.port > 0) u.port else if (secure) 443 else 80
            val raw = Socket()
            raw.connect(InetSocketAddress(u.host, port), timeoutMs)
            raw.tcpNoDelay = true
            val socket: Socket = if (secure) {
                val s = Pin.socketFactory(pin).createSocket(raw, u.host, port, true) as SSLSocket
                s.soTimeout = timeoutMs
                s.startHandshake()
                if (pin == null && !HttpsURLConnection.getDefaultHostnameVerifier().verify(u.host, s.session)) {
                    s.close()
                    throw IOException("the server certificate does not match ${u.host}")
                }
                s
            } else raw
            socket.soTimeout = timeoutMs
            val key = Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })
            val path = (u.rawPath ?: "/") + (u.rawQuery?.let { "?$it" } ?: "")
            val req = StringBuilder()
                .append("GET ").append(path).append(" HTTP/1.1\r\n")
                .append("Host: ").append(u.host).append(if (u.port > 0) ":${u.port}" else "").append("\r\n")
                .append("Upgrade: websocket\r\nConnection: Upgrade\r\n")
                .append("Sec-WebSocket-Key: ").append(key).append("\r\nSec-WebSocket-Version: 13\r\n")
            for ((k, v) in headers) req.append(k).append(": ").append(v).append("\r\n")
            req.append("\r\n")
            val out = socket.getOutputStream()
            out.write(req.toString().toByteArray(Charsets.UTF_8))
            out.flush()
            val inp = BufferedInputStream(socket.getInputStream())
            val status = readLine(inp)
            val code = status.split(' ').getOrNull(1)?.toIntOrNull() ?: 0
            var accept: String? = null
            while (true) {
                val line = readLine(inp)
                if (line.isEmpty()) break
                val i = line.indexOf(':')
                if (i > 0 && line.substring(0, i).trim().equals("Sec-WebSocket-Accept", ignoreCase = true)) accept = line.substring(i + 1).trim()
            }
            if (code != 101) { socket.close(); throw WsHandshakeError(code, "stream refused: HTTP $code") }
            if (accept != acceptKey(key)) { socket.close(); throw IOException("bad WebSocket handshake") }
            socket.soTimeout = 0
            return WsClient(socket, DataInputStream(inp), out)
        }

        private fun readLine(inp: InputStream): String {
            val b = ByteArrayOutputStream()
            while (true) {
                val c = inp.read()
                if (c < 0) throw IOException("connection closed during the handshake")
                if (c == '\n'.code) break
                if (c != '\r'.code) b.write(c)
                if (b.size() > 8192) throw IOException("handshake line too long")
            }
            return b.toString("UTF-8")
        }

        /** A live-stream frame packet: 'N', 1, uint32 header length, JSON header, the JPEG (one tile). */
        fun framePacket(header: Map<String, Any?>, jpeg: ByteArray): ByteArray {
            val h = Json.write(header).toByteArray(Charsets.UTF_8)
            val out = ByteArrayOutputStream(6 + h.size + jpeg.size)
            out.write(0x4e); out.write(1)
            out.write(h.size ushr 24); out.write((h.size ushr 16) and 0xff); out.write((h.size ushr 8) and 0xff); out.write(h.size and 0xff)
            out.write(h)
            out.write(jpeg)
            return out.toByteArray()
        }
    }
}
