package com.nigafiy.agent.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WorkLanesTest {
    private val threads = AgentThreads("test")

    @AfterTest
    fun stop() = threads.shutdownNow()

    private fun fs(id: String) = AgentCommand.FsOp(id, FsRequest.parse(mapOf("op" to "list", "path" to "/")))

    @Test
    fun longCommandsHaveTheirOwnLane() {
        assertEquals(Lane.LONG, WorkLanes.lane(AgentCommand.InstallApk("1", "a", "/p", "00", 1, "x")))
        assertEquals(Lane.LONG, WorkLanes.lane(AgentCommand.Uninstall("2", "com.x")))
        assertEquals(Lane.LONG, WorkLanes.lane(fs("3")))
        // Download pieces are independent reads: their own lane, so they overlap.
        assertEquals(Lane.READ, WorkLanes.lane(AgentCommand.FsOp("4", FsRequest.parse(mapOf("op" to "download", "path" to "/a")))))
        assertEquals(Lane.LONG, WorkLanes.lane(AgentCommand.FsOp("5", FsRequest.parse(mapOf("op" to "upload", "path" to "/a")))))
        for (c in listOf(
            AgentCommand.Lock("4"),
            AgentCommand.Capture("5", 60, 1.0, false),
            AgentCommand.RingStop("6"),
            AgentCommand.RefreshInventory("7"),
            AgentCommand.SessionClose("8", "s", "done"),
        )) assertEquals(Lane.QUICK, WorkLanes.lane(c), c.kind)
    }

    /** The audit's case: both long-lived loops running and a long command busy, short work still runs. */
    @Test
    fun aLongTaskNeverBlocksHeartbeatsOrQuickCommands() {
        val release = CountDownLatch(1)
        val loopsRunning = CountDownLatch(2)
        threads.heartbeatLoop.execute { loopsRunning.countDown(); release.await() }
        threads.pollLoop.execute { loopsRunning.countDown(); release.await() }
        assertTrue(loopsRunning.await(5, TimeUnit.SECONDS), "the heartbeat and poll loops each got a thread")
        val longStarted = CountDownLatch(1)
        threads.run(fs("long")) { longStarted.countDown(); release.await() }
        assertTrue(longStarted.await(5, TimeUnit.SECONDS))

        val bg = CountDownLatch(2)
        threads.background.execute { bg.countDown() }
        threads.background.execute { bg.countDown() }
        val quick = CountDownLatch(1)
        threads.run(AgentCommand.Lock("lock")) { quick.countDown() }
        val consent = CountDownLatch(1)
        threads.commands(Lane.CONSENT).execute { consent.countDown() }

        assertTrue(bg.await(5, TimeUnit.SECONDS), "an extra heartbeat / session-ended report still runs")
        assertTrue(quick.await(5, TimeUnit.SECONDS), "Lock still runs while a file operation is busy")
        assertTrue(consent.await(5, TimeUnit.SECONDS), "asking the person still starts")
        release.countDown()
    }

    @Test
    fun longCommandsStayInOrder() {
        val order = java.util.Collections.synchronizedList(mutableListOf<String>())
        val done = CountDownLatch(3)
        for (id in listOf("a", "b", "c")) threads.run(fs(id)) { Thread.sleep(10); order.add(id); done.countDown() }
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("a", "b", "c"), order)
    }
}
