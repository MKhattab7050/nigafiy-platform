package com.nigafiy.agent.core

import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.net.URLDecoder

/**
 * What the agent needs to enroll: the Nigafiy server, the single-use enrollment token from Fleet
 * (`ldea_…`) and, when Fleet shows one, the SHA-256 pin of the server's TLS certificate (or of its
 * Nigafiy LAN TLS CA).
 *
 * It arrives three ways: the app enrollment QR (`nigafiy://enroll?server=…&token=…&pin=…`, opened
 * by the phone's camera app through the agent's intent filter), typed by hand, or (Device Owner QR
 * provisioning) the admin extras bundle with the keys `server`, `token`, `pin`.
 */
data class Enrollment(val server: String, val token: String, val pin: String?) {
    companion object {
        private val TOKEN = Regex("^ldea_[A-Za-z0-9_-]{20,200}$")
        private val PIN = Regex("^[0-9a-f]{64}$")

        /** Validates and normalises the three values; throws [IllegalArgumentException] with a reason. */
        fun of(serverRaw: String?, tokenRaw: String?, pinRaw: String?): Enrollment {
            val server = normaliseServer(serverRaw?.trim().orEmpty())
            val token = tokenRaw?.trim().orEmpty()
            require(TOKEN.matches(token)) { "The enrollment token must start with ldea_ (copy it from Fleet)" }
            val pin = pinRaw?.trim()?.lowercase()?.replace(":", "")?.ifEmpty { null }
            require(pin == null || PIN.matches(pin)) { "The certificate pin must be 64 hexadecimal characters (SHA-256)" }
            return Enrollment(server, token, pin)
        }

        /** Parses `nigafiy://enroll?server=…&token=…&pin=…`. */
        fun fromLink(link: String): Enrollment {
            val uri = try { URI(link.trim()) } catch (e: Exception) { throw IllegalArgumentException("Not a Nigafiy enrollment link") }
            require(uri.scheme.equals("nigafiy", ignoreCase = true) && uri.authority.equals("enroll", ignoreCase = true)) { "Not a Nigafiy enrollment link" }
            val q = query(uri.rawQuery.orEmpty())
            return of(q["server"], q["token"], q["pin"])
        }

        fun query(raw: String): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            for (part in raw.split('&')) {
                if (part.isEmpty()) continue
                val eq = part.indexOf('=')
                val k = URLDecoder.decode(if (eq < 0) part else part.substring(0, eq), "UTF-8")
                val v = if (eq < 0) "" else URLDecoder.decode(part.substring(eq + 1), "UTF-8")
                if (!out.containsKey(k)) out[k] = v
            }
            return out
        }

        /**
         * `https://host[:port][/base]` without a trailing slash. Plain `http://` only for a loopback
         * address (development); anything else is refused so the credential never travels in clear.
         */
        fun normaliseServer(raw: String): String {
            require(raw.isNotEmpty()) { "Enter the Nigafiy server address" }
            val uri = try { URI(raw) } catch (e: Exception) { throw IllegalArgumentException("The server address is not a valid URL") }
            val scheme = uri.scheme?.lowercase()
            val host = uri.host ?: throw IllegalArgumentException("The server address has no host name")
            require(uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "The server address must be a plain https:// address" }
            when (scheme) {
                "https" -> {}
                "http" -> require(isLoopback(host)) { "Plain http:// is allowed only for a server on this phone (127.0.0.1); use https://" }
                else -> throw IllegalArgumentException("The server address must start with https://")
            }
            val port = if (uri.port == -1) "" else ":${uri.port}"
            val path = uri.rawPath.orEmpty().trimEnd('/')
            val shownHost = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            return "$scheme://${shownHost.lowercase()}$port$path"
        }

        fun isLoopback(hostRaw: String): Boolean {
            val host = hostRaw.removePrefix("[").removeSuffix("]").lowercase()
            if (host == "localhost") return true
            // Literal addresses only: a name is never resolved here.
            if (!Regex("^[0-9.]+$").matches(host) && !host.contains(':')) return false
            return try {
                val a = InetAddress.getByName(host)
                a.isLoopbackAddress || (a is Inet6Address && a.isLoopbackAddress)
            } catch (e: Exception) {
                false
            }
        }
    }

    /** The app enrollment link Fleet encodes in its QR code. */
    fun toLink(): String {
        val enc = { s: String -> java.net.URLEncoder.encode(s, "UTF-8") }
        return "nigafiy://enroll?server=${enc(server)}&token=${enc(token)}" + (pin?.let { "&pin=$it" } ?: "")
    }
}
