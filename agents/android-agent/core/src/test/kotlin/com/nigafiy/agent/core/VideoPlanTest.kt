package com.nigafiy.agent.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VideoPlanTest {
    @Test
    fun fullSizeUnlessTheLinkIsSlowOrHalfWasChosen() {
        // A 1080x2340 phone: capped at 1920 on the long side, even with the 75 % JPEG default.
        assertEquals(1920, VideoPlan.side(2340, 0.75, VideoPlan.bitrate(68)))
        assertEquals(1600, VideoPlan.side(1600, 1.0, 0))
        assertEquals(1200, VideoPlan.side(1600, 1.0, 1_000_000))
        assertEquals(800, VideoPlan.side(1600, 1.0, 600_000))
        assertEquals(800, VideoPlan.side(1600, 0.5, 8_000_000))
        assertEquals(VideoPlan.MIN_SIDE, VideoPlan.side(1000, 0.25, 8_000_000))
    }

    @Test
    fun qualityMapsToBitrate() {
        assertEquals(3_200_000, VideoPlan.bitrate(45))
        assertEquals(5_730_000, VideoPlan.bitrate(68))
        assertEquals(1_000_000, VideoPlan.bitrate(10))
    }

    @Test
    fun initialBitrateIsConservative() {
        assertTrue(VideoPlan.initialBitrate(85) <= VideoPlan.INITIAL_BITRATE_CAP)
    }

    private fun VideoPlan.Link.run(cur: Int, n: Int, rtt: Long, target: Int = VideoPlan.bitrate(68)): Int {
        var b = cur
        repeat(n) { b = step(b, target, rtt) }
        return b
    }

    @Test
    fun aSteadySlowPathClimbsToTheWanCap() {
        // Phase 1: a relay at ~200 ms when empty held the bitrate at the floor.
        val l = VideoPlan.Link()
        assertEquals(VideoPlan.WAN_BITRATE, l.run(VideoPlan.MIN_BITRATE, 40, 200))
        assertTrue(l.wan)
    }

    @Test
    fun theLocalNetworkClimbsToTheChosenQuality() {
        val l = VideoPlan.Link()
        assertEquals(VideoPlan.bitrate(68), l.run(2_000_000, 40, 8))
        assertFalse(l.wan)
    }

    @Test
    fun aQueueCutsAndThenHolds() {
        val l = VideoPlan.Link()
        val cur = l.run(2_000_000, 10, 200)
        val cut = l.step(cur, VideoPlan.bitrate(68), 1_500)
        assertTrue(cut < cur)
        var b = cut
        repeat(VideoPlan.HOLD_WINDOWS) {
            val next = l.step(b, VideoPlan.bitrate(68), 200)
            assertTrue(next <= b, "climbed during the hold")
            b = next
        }
    }

    @Test
    fun windowCoversOneRttOfFrames() {
        assertEquals(3, VideoPlan.inflightWindow(25, false))
        assertEquals(6, VideoPlan.inflightWindow(250, false))
        assertEquals(6, VideoPlan.inflightWindow(20, true))
        assertEquals(10, VideoPlan.inflightWindow(250, true))
        assertEquals(16, VideoPlan.inflightWindow(2_000, true))
    }
}
