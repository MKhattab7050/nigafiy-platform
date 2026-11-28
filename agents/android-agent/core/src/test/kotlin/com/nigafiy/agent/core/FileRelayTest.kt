package com.nigafiy.agent.core

import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.Base64
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** The phone's side channel for transfer bytes (FileRelay) against a protocol test double. */
class FileRelayTest {
    private lateinit var server: HttpServer
    private val piece = ByteArray(300_000) { (it * 7 % 251).toByte() }
    private val posted = mutableListOf<Pair<String, ByteArray>>()
    private var pollBody = ""
    private var refuseUpload = false

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes()
            val uri = ex.requestURI.toString()
            val (status, out) = when {
                ex.requestURI.path == "/api/v1/agent/poll" -> {
                    pollBody = body.toString(Charsets.UTF_8)
                    200 to """{"commands":[]}""".toByteArray()
                }
                ex.requestURI.path == "/api/v1/agent/file-data/ref-1" && ex.requestMethod == "GET" -> 200 to piece
                ex.requestURI.path.startsWith("/api/v1/agent/file-data/") -> 404 to """{"error":{"code":"not_found","message":"gone"}}""".toByteArray()
                ex.requestURI.path == "/api/v1/agent/file-data" && ex.requestMethod == "POST" ->
                    if (refuseUpload) 409 to """{"error":{"code":"conflict","message":"finished"}}""".toByteArray()
                    else {
                        posted.add(uri to body)
                        201 to """{"ok":true}""".toByteArray()
                    }
                else -> 404 to ByteArray(0)
            }
            ex.sendResponseHeaders(status, if (out.isEmpty()) -1 else out.size.toLong())
            ex.responseBody.use { if (out.isNotEmpty()) it.write(out) }
        }
        server.start()
    }

    @AfterTest
    fun stop() = server.stop(0)

    private fun gateway() = Gateway("http://127.0.0.1:${server.address.port}", null, "lda_e1.secret")

    @Test
    fun pollAnnouncesTheFeature() {
        gateway().poll(1000)
        assertEquals("""{"features":["fs_relay"]}""", pollBody)
    }

    @Test
    fun parsesTheRelayFields() {
        val r = FsRequest.parse(mapOf("op" to "upload", "path" to "/x", "data_ref" to "ref-1", "data_len" to 5.0))
        assertEquals("ref-1", r.dataRef)
        assertEquals(5L, r.dataLen)
        assertTrue(FsRequest.parse(mapOf("op" to "download", "path" to "/x", "relay" to true)).relay)
    }

    @Test
    fun anUploadByReferenceFetchesItsBytes() {
        val req = FsRequest(op = "upload", path = "/x", offset = 0, dataRef = "ref-1", dataLen = piece.size.toLong())
        val r = FileRelay.resolve(req, gateway())
        assertNull(r.dataRef)
        assertContentEquals(piece, Base64.getDecoder().decode(r.dataBase64))
    }

    @Test
    fun aMissingOrShortPieceIsRefusedBeforeWriting() {
        val missing = assertFailsWith<FsError> { FileRelay.resolve(FsRequest(op = "upload", path = "/x", dataRef = "ref-2"), gateway()) }
        assertTrue(missing.message!!.startsWith(FileRelay.MISSING), missing.message)
        val short = assertFailsWith<FsError> { FileRelay.resolve(FsRequest(op = "upload", path = "/x", dataRef = "ref-1", dataLen = 5), gateway()) }
        assertTrue(short.message!!.startsWith(FileRelay.MISSING), short.message)
    }

    @Test
    fun aRelayDownloadSendsItsBytesApart() {
        val res = mapOf("op" to "download", "offset" to 0L, "chunk_sha256" to "ab", "data_base64" to Base64.getEncoder().encodeToString(piece))
        val out = FileRelay.send("cmd-1", FsRequest(op = "download", path = "/x", relay = true), res, gateway())
        assertEquals(true, out["relayed"])
        assertNull(out["data_base64"])
        assertEquals("ab", out["chunk_sha256"])
        assertEquals("/api/v1/agent/file-data?command_id=cmd-1", posted.single().first)
        assertContentEquals(piece, posted.single().second)
    }

    @Test
    fun aRefusedRelayKeepsTheBytesInTheResult() {
        refuseUpload = true
        val res = mapOf("op" to "download", "data_base64" to Base64.getEncoder().encodeToString(piece))
        assertSame(res, FileRelay.send("cmd-1", FsRequest(op = "download", path = "/x", relay = true), res, gateway()))
    }

    @Test
    fun otherRequestsAreLeftAlone() {
        val res = mapOf("op" to "download", "data_base64" to "AAAA")
        assertSame(res, FileRelay.send("cmd-1", FsRequest(op = "download", path = "/x"), res, gateway()))
        val up = FsRequest(op = "upload", path = "/x", dataBase64 = "AAAA")
        assertSame(up, FileRelay.resolve(up, gateway()))
        assertTrue(posted.isEmpty())
    }
}
