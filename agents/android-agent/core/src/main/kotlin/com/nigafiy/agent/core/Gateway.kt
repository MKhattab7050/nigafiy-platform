package com.nigafiy.agent.core

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

/** An HTTP answer that was not 2xx; [code] is the API's error code when it sent one. */
class GatewayError(val status: Int, val code: String?, message: String) : IOException(message)

/**
 * The agent gateway (`/api/v1/agent/...`), plain HttpURLConnection so it runs on Android and in the
 * JVM tests. With a pin the connection trusts only the pinned chain (and, like the Windows agent,
 * the pin replaces the host name check); without one the system trust store decides.
 */
class Gateway(
    val server: String,
    private val pin: String?,
    private var credential: String? = null,
    /** Shorter when trying an address that may not answer (ServerAddresses.QUICK_CONNECT_MS). */
    private val connectTimeoutMs: Int = 15_000,
) {
    init {
        Enrollment.normaliseServer(server) // refuses http:// to anything but loopback
    }

    fun setCredential(c: String?) { credential = c }

    /**
     * SHA-256 of the server certificate this gateway last talked to over its pinned connection. The
     * admin phone's dashboard (a WebView, which cannot use the pin itself) accepts exactly that
     * certificate and nothing else.
     */
    @Volatile var lastLeafSha256: String? = null
        private set

    private fun open(path: String, readTimeoutMs: Int): HttpURLConnection {
        val c = URL(server + path).openConnection() as HttpURLConnection
        if (c is HttpsURLConnection) {
            c.sslSocketFactory = Pin.socketFactory(pin)
            if (pin != null) c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        }
        c.connectTimeout = connectTimeoutMs
        c.readTimeout = readTimeoutMs
        c.instanceFollowRedirects = false
        c.setRequestProperty("User-Agent", "nigafiy-android-agent/${Version.NAME}")
        credential?.let { c.setRequestProperty("Authorization", "Bearer $it") }
        return c
    }

    /** POSTs [body] as JSON and returns the parsed JSON object. */
    fun post(path: String, body: Map<String, Any?>, readTimeoutMs: Int = 30_000): Map<String, Any?> {
        val c = open(path, readTimeoutMs)
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            val bytes = Json.write(body).toByteArray(Charsets.UTF_8)
            c.outputStream.use { it.write(bytes) }
            return answer(c)
        } finally {
            c.disconnect()
        }
    }

    private fun answer(c: HttpURLConnection): Map<String, Any?> {
        val status = c.responseCode
        if (c is HttpsURLConnection) {
            try { lastLeafSha256 = Pin.sha256Hex(c.serverCertificates[0].encoded) } catch (_: Exception) { }
        }
        val stream = if (status in 200..299) c.inputStream else c.errorStream
        val text = stream?.use { String(it.readBytes(limit = 8 * 1024 * 1024), Charsets.UTF_8) } ?: ""
        if (status !in 200..299) {
            val err = try { Json.parseObject(text).obj("error") } catch (e: Exception) { null }
            throw GatewayError(status, err?.str("code"), err?.str("message") ?: "HTTP $status")
        }
        return if (text.isBlank()) emptyMap() else Json.parseObject(text)
    }

    /**
     * Downloads an APK pushed from Fleet into [dest], refusing it unless its size and SHA-256 are
     * the ones the command carried.
     */
    fun download(path: String, dest: File, expectSha256: String, expectSize: Long) {
        val c = open(path, 120_000)
        try {
            val status = c.responseCode
            if (status !in 200..299) throw GatewayError(status, null, "download failed: HTTP $status")
            val md = MessageDigest.getInstance("SHA-256")
            var total = 0L
            c.inputStream.use { input ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > expectSize) throw IOException("the APK is larger than announced")
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
            val sum = md.digest().joinToString("") { "%02x".format(it) }
            if (total != expectSize || sum != expectSha256) {
                dest.delete()
                throw IOException("the downloaded APK does not match its SHA-256 (got $sum, $total bytes)")
            }
        } finally {
            c.disconnect()
        }
    }

    fun enroll(body: Map<String, Any?>): Pair<String, String> {
        val r = post("/api/v1/agent/enroll", body)
        val cred = r.str("credential") ?: throw IOException("enrollment answer without a credential")
        require(cred.startsWith("lda_")) { "unexpected credential format" }
        return (r.str("endpoint_id") ?: "") to cred
    }

    fun heartbeat(body: Map<String, Any?>) = post("/api/v1/agent/heartbeat", body)

    /** Admin phones: a web session for the dashboard in the app ({cookie, value, expires_at}). */
    fun dashboardSession() = post("/api/v1/agent/dashboard-session", emptyMap(), readTimeoutMs = 15_000)

    /** "Log out" on the device: the server revokes this endpoint and its credential. */
    fun leave() = post("/api/v1/agent/leave", emptyMap(), readTimeoutMs = 8_000)

    /** Long poll (≤ 25 s on the server). */
    fun poll(waitMs: Int = 25_000): Pair<List<AgentCommand>, List<CommandOutcome>> {
        val c = open("/api/v1/agent/poll?wait_ms=$waitMs", waitMs + 20_000)
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            // The features tell the server which faster paths this agent takes ([FileRelay]).
            c.outputStream.use { it.write(Json.write(mapOf("features" to FileRelay.FEATURES)).toByteArray()) }
            return Protocol.parseCommands(Json.write(answer(c)))
        } finally {
            c.disconnect()
        }
    }

    /** GET of raw bytes (a file transfer piece, at most [FileRelay.MAX_PIECE]). */
    fun getBytes(path: String): ByteArray {
        val c = open(path, 60_000)
        try {
            val status = c.responseCode
            if (status !in 200..299) throw GatewayError(status, null, "HTTP $status")
            return c.inputStream.use { it.readBytes(limit = FileRelay.MAX_PIECE) }
        } finally {
            c.disconnect()
        }
    }

    /** POST of raw bytes (a file transfer piece). */
    fun postBytes(path: String, data: ByteArray) {
        val c = open(path, 60_000)
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setFixedLengthStreamingMode(data.size)
            c.setRequestProperty("Content-Type", "application/octet-stream")
            c.outputStream.use { it.write(data) }
            answer(c)
        } finally {
            c.disconnect()
        }
    }

    fun results(outcomes: List<CommandOutcome>) {
        if (outcomes.isEmpty()) return
        post("/api/v1/agent/command-result", mapOf("command_results" to outcomes.map { it.toJson() }))
    }

    /** The person stopped sharing on the phone (notification Stop, Android's cast indicator): the session ends in Fleet. */
    fun endSession(sessionId: String) {
        post("/api/v1/agent/rd-session/end", mapOf("session_id" to sessionId))
    }
}

private fun java.io.InputStream.readBytes(limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(16 * 1024)
    while (true) {
        val n = read(buf)
        if (n < 0) break
        if (out.size() + n > limit) throw IOException("answer too large")
        out.write(buf, 0, n)
    }
    return out.toByteArray()
}
