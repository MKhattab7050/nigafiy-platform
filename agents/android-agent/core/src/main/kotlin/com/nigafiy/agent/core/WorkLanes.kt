package com.nigafiy.agent.core

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicInteger

/**
 * Where a piece of the agent's work runs (audit 2026-11-27, item 7).
 *
 * Before, the heartbeat loop and the long poll each held one of the two threads of a shared pool for
 * as long as the service ran, so everything else sent to that pool (the extra heartbeat after an
 * install, "session ended" reports) waited forever; and every command ran on one worker, so an APK
 * download or a big file operation held back captures, taps, Lock and Ring behind it.
 *
 * Now each long-lived loop has its own thread, short background jobs have their own small pool, and
 * commands go to one of three lanes: [Lane.QUICK] (screen, input, policy: never waits behind a
 * download), [Lane.LONG] (installs, uninstalls, files: one at a time, in order) and [Lane.CONSENT]
 * (asking the person, up to a minute: its own thread each).
 */
enum class Lane { QUICK, LONG, CONSENT }

object WorkLanes {
    fun lane(cmd: AgentCommand): Lane = when (cmd) {
        is AgentCommand.SessionOpen -> Lane.CONSENT
        is AgentCommand.InstallApk, is AgentCommand.Uninstall, is AgentCommand.FsOp -> Lane.LONG
        else -> Lane.QUICK
    }
}

/** The agent service's threads; [shutdownNow] stops them all (the service's onDestroy). */
class AgentThreads(prefix: String = "nigafiy") {
    /** The heartbeat loop: one thread for the service's whole life. */
    val heartbeatLoop: ExecutorService = Executors.newSingleThreadExecutor(named("$prefix-heartbeat"))
    /** The long poll for commands: one thread, never shared with the heartbeat. */
    val pollLoop: ExecutorService = Executors.newSingleThreadExecutor(named("$prefix-poll"))
    /** Short background jobs (an extra heartbeat, a "session ended" report). */
    val background: ExecutorService = Executors.newFixedThreadPool(2, named("$prefix-bg"))
    private val quick: ExecutorService = Executors.newSingleThreadExecutor(named("$prefix-cmd"))
    private val long: ExecutorService = Executors.newSingleThreadExecutor(named("$prefix-cmd-long"))
    private val consent: ExecutorService = Executors.newCachedThreadPool(named("$prefix-share-request"))

    fun commands(lane: Lane): ExecutorService = when (lane) {
        Lane.QUICK -> quick
        Lane.LONG -> long
        Lane.CONSENT -> consent
    }

    fun run(cmd: AgentCommand, work: Runnable) = commands(WorkLanes.lane(cmd)).execute(work)

    fun shutdownNow() {
        for (e in listOf(heartbeatLoop, pollLoop, background, quick, long, consent)) e.shutdownNow()
    }

    private fun named(name: String): ThreadFactory {
        val n = AtomicInteger()
        return ThreadFactory { r -> Thread(r, if (n.incrementAndGet() == 1) name else "$name-${n.get()}").apply { isDaemon = true } }
    }
}
