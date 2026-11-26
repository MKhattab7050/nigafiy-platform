package com.nigafiy.agent.core

import com.nigafiy.agent.core.NetTools.Checks
import com.nigafiy.agent.core.NetTools.Verdict
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class NetToolsTest {
    @Test
    fun `reads the time from Android ping output`() {
        assertEquals(12.3, NetTools.pingTimeMs("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms"))
        assertEquals(4.0, NetTools.pingTimeMs("64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=4 ms"))
        assertEquals(1.0, NetTools.pingTimeMs("reply time<1 ms"))
        assertNull(NetTools.pingTimeMs("1 packets transmitted, 0 received, 100% packet loss"))
    }

    @Test
    fun `ping stats count losses and jitter`() {
        val s = NetTools.stats(listOf(10.0, null, 20.0, 10.0))
        assertEquals(4, s.sent)
        assertEquals(3, s.received)
        assertEquals(25, s.lossPct)
        assertEquals(10.0, s.minMs)
        assertEquals(20.0, s.maxMs)
        assertEquals(10.0, s.jitterMs)
        assertEquals(100, NetTools.stats(listOf(null, null)).lossPct)
    }

    @Test
    fun `scans the phone's slash 24 without itself, the network or the broadcast`() {
        val hosts = NetTools.hostsToScan("192.168.1.64", 24)
        assertEquals(253, hosts.size)
        assertEquals("192.168.1.1", hosts.first())
        assertEquals("192.168.1.254", hosts.last())
        assert("192.168.1.64" !in hosts)
        // A wide subnet is cut to the /24 around the phone.
        assertEquals(253, NetTools.hostsToScan("10.0.5.9", 16).size)
        assertEquals("10.0.5.1", NetTools.hostsToScan("10.0.5.9", 16).first())
        assertEquals(listOf("192.168.1.65"), NetTools.hostsToScan("192.168.1.66", 30))
        assertEquals(emptyList(), NetTools.hostsToScan("not an ip", 24))
    }

    private fun ok(ms: Double) = NetTools.stats(listOf(ms, ms, ms, ms, ms))
    private val lost = NetTools.stats(listOf(null, null, null))

    @Test
    fun `the verdict names the part that is broken`() {
        val good = Checks(connected = true, onWifi = true, rssi = -50, router = ok(3.0), internet = ok(20.0), dnsOk = true)
        assertEquals(Verdict.ALL_GOOD, NetTools.diagnose(good))
        assertEquals(Verdict.NO_CONNECTION, NetTools.diagnose(good.copy(connected = false)))
        assertEquals(Verdict.ROUTER_UNREACHABLE, NetTools.diagnose(good.copy(router = lost)))
        assertEquals(Verdict.NO_INTERNET, NetTools.diagnose(good.copy(internet = lost)))
        assertEquals(Verdict.DNS_BROKEN, NetTools.diagnose(good.copy(dnsOk = false)))
        assertEquals(Verdict.WEAK_WIFI, NetTools.diagnose(good.copy(rssi = -82, router = ok(80.0))))
        assertEquals(Verdict.UNSTABLE, NetTools.diagnose(good.copy(internet = NetTools.stats(listOf(20.0, null, 20.0, 20.0, 20.0)))))
        assertEquals(Verdict.SLOW, NetTools.diagnose(good.copy(internet = ok(300.0))))
        // On mobile data there is no router to test.
        assertEquals(Verdict.ALL_GOOD, NetTools.diagnose(good.copy(onWifi = false, rssi = null, router = null)))
    }

    @Test
    fun `speed, signal and channel wording`() {
        assertEquals(80.0, NetTools.mbps(10_000_000, 1_000_000_000))
        assertEquals(4, NetTools.bars(-50))
        assertEquals(1, NetTools.bars(-80))
        assertEquals("5 GHz", NetTools.bandOf(5180))
        assertEquals(36, NetTools.channelOf(5180))
        assertEquals(6, NetTools.channelOf(2437))
        assertEquals("2.4 GHz", NetTools.bandOf(2437))
        assertEquals("0.8", NetTools.short(0.83))
        assertEquals("345", NetTools.short(345.4))
    }
}
