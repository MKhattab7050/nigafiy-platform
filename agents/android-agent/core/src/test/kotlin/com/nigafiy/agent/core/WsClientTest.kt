package com.nigafiy.agent.core

import java.io.BufferedReader
import java.io.DataInputStream
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The live stream's WebSocket client (WsClient.kt) against a tiny server on 127.0.0.1. */
class WsClientTest {
    @Test
    fun `accept key matches RFC 6455`() {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", WsClient.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="))
    }

    @Test
    fun `stream url follows the server scheme`() {
        assertEquals("wss://srv:8443/api/v1/agent/stream?session=a+b", WsClient.streamUrl("https://srv:8443/", "a b"))
        assertEquals("ws://127.0.0.1:3001/api/v1/agent/stream?session=s1", WsClient.streamUrl("http://127.0.0.1:3001", "s1"))
    }

    @Test
    fun `frame packet is magic, header length, header, jpeg`() {
        val jpeg = byteArrayOf(1, 2, 3)
        val pkt = WsClient.framePacket(mapOf("t" to "frame", "seq" to 1, "tiles" to listOf(mapOf("n" to 3))), jpeg)
        assertEquals(0x4e, pkt[0].toInt())
        assertEquals(1, pkt[1].toInt())
        val n = DataInputStream(pkt.inputStream(2, 4)).readInt()
        val header = Json.parseObject(String(pkt, 6, n, Charsets.UTF_8))
        assertEquals("frame", header["t"])
        assertContentEquals(jpeg, pkt.copyOfRange(6 + n, pkt.size))
    }

    @Test
    fun `client frames are masked and long lengths use 16 or 64 bits`() {
        val mask = byteArrayOf(1, 2, 3, 4)
        val small = WsClient.encodeFrame(0x1, "hi".toByteArray(), mask)
        assertEquals(0x81, small[0].toInt() and 0xff)
        assertEquals(0x82, small[1].toInt() and 0xff)
        assertEquals('h'.code xor 1, small[6].toInt())
        assertEquals(126, WsClient.encodeFrame(0x2, ByteArray(300), mask)[1].toInt() and 0x7f)
        assertEquals(127, WsClient.encodeFrame(0x2, ByteArray(70_000), mask)[1].toInt() and 0x7f)
    }

    @Test
    fun `handshake, text both ways, binary out, close code in`() {
        val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        var auth: String? = null
        var gotText: String? = null
        var gotBinary: ByteArray? = null
        val t = thread {
            server.accept().use { s ->
                val r = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.ISO_8859_1))
                var key = ""
                while (true) {
                    val line = r.readLine() ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith("Sec-WebSocket-Key:")) key = line.substringAfter(':').trim()
                    if (line.startsWith("Authorization:")) auth = line.substringAfter(':').trim()
                }
                val out = s.getOutputStream()
                out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${WsClient.acceptKey(key)}\r\n\r\n".toByteArray())
                // Unmasked server text frame, then read two masked client frames, then close 4000.
                out.write(byteArrayOf(0x81.toByte(), 5) + "hello".toByteArray())
                out.flush()
                val inp = DataInputStream(s.getInputStream())
                fun readFrame(): Pair<Int, ByteArray> {
                    val b0 = inp.readUnsignedByte()
                    var len = inp.readUnsignedByte() and 0x7f
                    if (len == 126) len = inp.readUnsignedShort()
                    val m = ByteArray(4).also { inp.readFully(it) }
                    val p = ByteArray(len).also { inp.readFully(it) }
                    for (i in p.indices) p[i] = (p[i].toInt() xor m[i % 4].toInt()).toByte()
                    return (b0 and 0x0f) to p
                }
                gotText = String(readFrame().second)
                gotBinary = readFrame().second
                out.write(byteArrayOf(0x88.toByte(), 2, 0x0f, 0xa0.toByte()))
                out.flush()
                Thread.sleep(100)
            }
        }
        val c = WsClient.connect("ws://127.0.0.1:${server.localPort}/api/v1/agent/stream?session=s1", null, mapOf("Authorization" to "Bearer lda_x.y"))
        val first = c.read()
        assertTrue(first is WsClient.Message.Text && first.text == "hello")
        c.sendText("""{"t":"hello"}""")
        c.sendBinary(ByteArray(200) { it.toByte() })
        val closed = assertFailsWith<WsClosed> { c.read() }
        assertEquals(4000, closed.code)
        t.join(2_000)
        server.close()
        assertEquals("Bearer lda_x.y", auth)
        assertEquals("""{"t":"hello"}""", gotText)
        assertEquals(200, gotBinary?.size)
    }

    @Test
    fun `a refused upgrade reports its status`() {
        val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val t = thread {
            server.accept().use { s ->
                BufferedReader(InputStreamReader(s.getInputStream())).let { r -> while ((r.readLine() ?: "").isNotEmpty()) Unit }
                s.getOutputStream().write("HTTP/1.1 410 Gone\r\nContent-Length: 0\r\n\r\n".toByteArray())
            }
        }
        val e = assertFailsWith<WsHandshakeError> { WsClient.connect("ws://127.0.0.1:${server.localPort}/x", null, emptyMap()) }
        assertEquals(410, e.status)
        t.join(2_000)
        server.close()
    }
}
