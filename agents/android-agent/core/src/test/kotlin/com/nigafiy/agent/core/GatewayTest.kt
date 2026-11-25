package com.nigafiy.agent.core

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.MessageDigest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The gateway client against a protocol test double on 127.0.0.1 (plain http is allowed only there). */
class GatewayTest {
    private lateinit var server: HttpServer
    private val seen = mutableListOf<Triple<String, String?, String>>()
    private val apk = ByteArray(5000) { (it % 251).toByte() }
    private val apkSha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private val cmdId = "0b4b0f7e-9d0e-4d7a-9f3e-0a1b2c3d4e5f"

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().toString(Charsets.UTF_8)
            seen.add(Triple(ex.requestURI.toString(), ex.requestHeaders.getFirst("Authorization"), body))
            val (status, out: ByteArray) = when (ex.requestURI.path) {
                "/api/v1/agent/enroll" ->
                    if (body.contains("ldea_good")) 201 to """{"endpoint_id":"e1","credential":"lda_e1.secret","heartbeat_interval_seconds":30}""".toByteArray()
                    else 401 to """{"error":{"code":"invalid_enrollment_token","message":"Enrollment token is invalid"}}""".toByteArray()
                "/api/v1/agent/poll" -> 200 to """{"commands":[{"id":"$cmdId","kind":"android_lock","payload":{}}]}""".toByteArray()
                "/api/v1/agent/android/apks/$cmdId" -> 200 to apk
                else -> 200 to """{"ok":true}""".toByteArray()
            }
            ex.sendResponseHeaders(status, out.size.toLong())
            ex.responseBody.use { it.write(out) }
        }
        server.start()
    }

    @AfterTest
    fun stop() = server.stop(0)

    private val base get() = "http://127.0.0.1:${server.address.port}"

    @Test
    fun enrollsPollsAndReports() {
        val g = Gateway(base, null)
        val (id, cred) = g.enroll(mapOf("enrollment_token" to "ldea_good"))
        assertEquals("e1", id)
        assertEquals("lda_e1.secret", cred)
        g.setCredential(cred)
        val (cmds, bad) = g.poll(1000)
        assertTrue(cmds.single() is AgentCommand.Lock)
        assertTrue(bad.isEmpty())
        g.results(listOf(CommandOutcome(cmdId, true, output = "locked")))
        assertEquals("/api/v1/agent/poll?wait_ms=1000", seen[1].first)
        assertEquals("Bearer lda_e1.secret", seen[1].second)
        assertEquals("""{"command_results":[{"id":"$cmdId","ok":true,"output":"locked"}]}""", seen[2].third)
    }

    @Test
    fun apiErrorsCarryTheirCode() {
        val e = assertFailsWith<GatewayError> { Gateway(base, null).enroll(mapOf("enrollment_token" to "ldea_bad")) }
        assertEquals(401, e.status)
        assertEquals("invalid_enrollment_token", e.code)
    }

    @Test
    fun downloadChecksSizeAndSha() {
        val dir = kotlin.io.path.createTempDirectory("nigafiy").toFile()
        try {
            val f = File(dir, "a.apk")
            Gateway(base, null, "lda_x").download("/api/v1/agent/android/apks/$cmdId", f, apkSha, apk.size.toLong())
            assertEquals(apk.size.toLong(), f.length())
            val g = File(dir, "b.apk")
            assertFailsWith<IOException> { Gateway(base, null).download("/api/v1/agent/android/apks/$cmdId", g, "00".repeat(32), apk.size.toLong()) }
            assertFalse(g.exists())
            assertFailsWith<IOException> { Gateway(base, null).download("/api/v1/agent/android/apks/$cmdId", g, apkSha, 10) }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun refusesPlainHttpToANonLoopbackServer() {
        assertFailsWith<IllegalArgumentException> { Gateway("http://10.1.2.3:4100", null) }
    }
}
