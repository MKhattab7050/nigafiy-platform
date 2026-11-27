package com.nigafiy.agent.core

import kotlin.test.Test
import kotlin.test.assertEquals
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
    fun initialBitrateIsConservativeAndAdaptsOnHighRtt() {
        assertTrue(VideoPlan.initialBitrate(85) <= VideoPlan.INITIAL_BITRATE_CAP)
        assertTrue(VideoPlan.adaptBitrate(2_500_000, VideoPlan.bitrate(68), 320) <= 1_000_000)
        assertTrue(VideoPlan.adaptBitrate(2_000_000, VideoPlan.bitrate(68), 250) < 2_000_000)
        assertTrue(VideoPlan.adaptBitrate(1_500_000, VideoPlan.bitrate(68), 40) > 1_500_000)
        assertEquals(3, VideoPlan.inflightWindow(25, false))
        assertEquals(6, VideoPlan.inflightWindow(250, false))
        assertEquals(8, VideoPlan.inflightWindow(250, true))
    }
}
