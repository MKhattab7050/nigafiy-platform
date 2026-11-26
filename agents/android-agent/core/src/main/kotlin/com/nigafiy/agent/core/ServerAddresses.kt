package com.nigafiy.agent.core

/**
 * Where the phone tries to reach its Nigafiy server (owner, 2026-11-27: the app works away from home
 * too, through Tailscale).
 *
 * The phone connected at a home address (the LAN https://192.168.x.x:47143 from the QR code). Each
 * heartbeat answer may list other addresses of the same server (`server_addresses`, this PC's
 * Tailscale address); the phone keeps them. When the address in use does not answer, the phone tries
 * the others in order and keeps the first that answers. While it is on another address it checks the
 * home address again every [HOME_RETRY_MS], with a short connect timeout, and goes back to it.
 *
 * Every address is the same server with the same certificate: the pin still decides what is trusted,
 * so an address in the list cannot point the phone at anything else.
 */
object ServerAddresses {
    const val MAX = 4
    const val HOME_RETRY_MS = 5 * 60_000L
    const val QUICK_CONNECT_MS = 4_000

    /** The heartbeat's `server_addresses`: only valid https:// addresses, at most [MAX]; null when absent. */
    fun parse(raw: Any?): List<String>? {
        if (raw !is List<*>) return null
        return raw.asSequence()
            .mapNotNull { it as? String }
            .filter { it.startsWith("https://", ignoreCase = true) }
            .mapNotNull { try { Enrollment.normaliseServer(it) } catch (_: Exception) { null } }
            .distinct()
            .take(MAX)
            .toList()
    }

    /** Addresses to try, the one in use first, then home, then the others. */
    fun order(home: String, others: List<String>, active: String?): List<String> =
        (listOfNotNull(active) + home + others).distinct()

    /** Stored as one address per line. */
    fun encode(list: List<String>): String = list.joinToString("\n")
    fun decode(text: String?): List<String> = text.orEmpty().lines().map { it.trim() }.filter { it.isNotEmpty() }

    /**
     * Calls [attempt] on each address in [order] until one does not fail to connect. An HTTP error
     * ([GatewayError]) means the server answered: it is not retried elsewhere and is thrown at once.
     * Returns the address that answered with its result; throws the last connection error when none did.
     */
    fun <T> firstAnswering(addresses: List<String>, attempt: (String) -> T): Pair<String, T> {
        var last: Exception? = null
        for (a in addresses) {
            try {
                return a to attempt(a)
            } catch (e: GatewayError) {
                throw e
            } catch (e: Exception) {
                last = e
            }
        }
        throw last ?: IllegalStateException("no server address")
    }
}
