package com.nigafiy.agent.core

import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class ServerAddressesTest {
    private val home = "https://192.168.1.10:47143"
    private val ts = "https://100.101.102.103:47143"

    @Test
    fun parseKeepsOnlyHttpsAddresses() {
        assertNull(ServerAddresses.parse(null))
        assertNull(ServerAddresses.parse("https://x"))
        assertEquals(emptyList(), ServerAddresses.parse(emptyList<Any>()))
        assertEquals(
            listOf(ts),
            ServerAddresses.parse(listOf("HTTPS://100.101.102.103:47143/", "http://100.1.1.1:80", "ftp://x", 5, null, "not a url", ts)),
        )
        assertEquals(ServerAddresses.MAX, ServerAddresses.parse((1..9).map { "https://100.64.0.$it:47143" })!!.size)
    }

    @Test
    fun orderPutsTheAddressInUseFirst() {
        assertEquals(listOf(home, ts), ServerAddresses.order(home, listOf(ts), null))
        assertEquals(listOf(ts, home), ServerAddresses.order(home, listOf(ts), ts))
        assertEquals(listOf(home, ts), ServerAddresses.order(home, listOf(ts, home), home))
    }

    @Test
    fun storedOnePerLine() {
        assertEquals(listOf(home, ts), ServerAddresses.decode(ServerAddresses.encode(listOf(home, ts))))
        assertEquals(emptyList(), ServerAddresses.decode(null))
    }

    @Test
    fun firstAnsweringMovesOnOnlyWhenAnAddressDoesNotAnswer() {
        val tried = mutableListOf<String>()
        val (addr, r) = ServerAddresses.firstAnswering(listOf(home, ts)) { a ->
            tried += a
            if (a == home) throw IOException("connect timed out") else "ok"
        }
        assertEquals(ts, addr)
        assertEquals("ok", r)
        assertEquals(listOf(home, ts), tried)

        // The server answered with an error: that is the answer, no other address is tried.
        tried.clear()
        assertFailsWith<GatewayError> {
            ServerAddresses.firstAnswering(listOf(home, ts)) { a -> tried += a; throw GatewayError(401, "unauthorized", "no") }
        }
        assertEquals(listOf(home), tried)

        assertFailsWith<IOException> { ServerAddresses.firstAnswering(listOf(home, ts)) { throw IOException("down") } }
    }
}
