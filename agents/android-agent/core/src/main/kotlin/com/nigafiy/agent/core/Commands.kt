package com.nigafiy.agent.core

/**
 * The commands Fleet can send to the Android agent (kinds as the API queues them, see
 * apps/api/src/modules/endpoints/fleet-android). The android_* management actions need the agent
 * to be the phone's Device Owner; the API refuses them first, the agent checks again. The phone
 * controls of regular app mode (docs/features/android.md §12) do not: screen sharing (rd_*, the
 * Remote Desktop session protocol), the file manager (fs_op), a message (notify_user) and ringing.
 * Each of them is visible on the phone, and the ones that need the person's permission check it.
 */
sealed class AgentCommand(val id: String, val kind: String) {
    open val needsDeviceOwner: Boolean get() = true

    class RefreshInventory(id: String) : AgentCommand(id, "refresh_inventory") {
        override val needsDeviceOwner get() = false
    }
    class Lock(id: String) : AgentCommand(id, "android_lock")
    /** [complexity]: none, low, medium or high (`DevicePolicyManager.PASSWORD_COMPLEXITY_*`). */
    class PasswordPolicy(id: String, val complexity: String) : AgentCommand(id, "android_password_policy")
    class Camera(id: String, val disabled: Boolean) : AgentCommand(id, "android_camera")
    /** Download [path] from the server (agent credential), check [sha256] and [sizeBytes], install. */
    class InstallApk(id: String, val apkId: String, val path: String, val sha256: String, val sizeBytes: Long, val name: String) : AgentCommand(id, "android_install_apk")
    class Uninstall(id: String, val packageName: String) : AgentCommand(id, "android_uninstall")
    class Wipe(id: String, val reason: String) : AgentCommand(id, "android_wipe")
    /** Stop management: the agent clears itself as Device Owner (`clearDeviceOwnerApp`). */
    class Release(id: String) : AgentCommand(id, "android_release")
    // ── Phone controls (regular app mode, docs/features/android.md §12) ──
    /** A screen-sharing session: the person is asked on the phone (MediaProjection consent). */
    class SessionOpen(id: String, val session: ScreenSessionRequest) : AgentCommand(id, "rd_session_open") {
        override val needsDeviceOwner get() = false
    }
    class SessionClose(id: String, val sessionId: String, val reason: String) : AgentCommand(id, "rd_session_close") {
        override val needsDeviceOwner get() = false
    }
    /** Who is in the session (shown in the sharing notification). */
    class SessionUpdate(id: String, val sessionId: String, val operators: List<String>) : AgentCommand(id, "rd_session_update") {
        override val needsDeviceOwner get() = false
    }
    /** One JPEG of the shared screen (the HTTP frame path of a Remote Desktop session). */
    class Capture(id: String, val quality: Int, val scale: Double, val fullFrame: Boolean) : AgentCommand(id, "rd_capture") {
        override val needsDeviceOwner get() = false
    }
    /** A tap, long press, swipe or Back/Home/Recents, dispatched by the accessibility service. */
    class Input(id: String, val event: InputEvent) : AgentCommand(id, "rd_input") {
        override val needsDeviceOwner get() = false
    }
    /** One file manager operation inside shared storage ([SharedStorage]). */
    class FsOp(id: String, val request: FsRequest) : AgentCommand(id, "fs_op") {
        override val needsDeviceOwner get() = false
    }
    /** A message from IT: a high-priority notification, plain text. */
    class Notify(id: String, val title: String, val message: String) : AgentCommand(id, "notify_user") {
        override val needsDeviceOwner get() = false
    }
    /** Rings the phone at full alarm volume for [seconds] (stoppable on the phone and from Fleet). */
    class Ring(id: String, val seconds: Int, val operator: String?) : AgentCommand(id, "android_ring") {
        override val needsDeviceOwner get() = false
    }
    class RingStop(id: String) : AgentCommand(id, "android_ring_stop") {
        override val needsDeviceOwner get() = false
    }

    /** A kind this agent does not know: answered with a failure, never ignored silently. */
    class Unsupported(id: String, kind: String) : AgentCommand(id, kind) {
        override val needsDeviceOwner get() = false
    }

    companion object {
        private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
        private val SHA = Regex("^[0-9a-f]{64}$")
        private val UUID = Regex("^[0-9a-fA-F-]{36}$")
        val COMPLEXITIES = setOf("none", "low", "medium", "high")

        /** One entry of the poll's `commands` list. Throws [IllegalArgumentException] for a malformed one. */
        fun parse(m: Map<String, Any?>): AgentCommand {
            val id = m.str("id") ?: throw IllegalArgumentException("command without id")
            require(UUID.matches(id)) { "command id is not a UUID" }
            val kind = m.str("kind") ?: throw IllegalArgumentException("command without kind")
            val p = m.obj("payload") ?: emptyMap()
            return when (kind) {
                "refresh_inventory" -> RefreshInventory(id)
                "android_lock" -> Lock(id)
                "android_password_policy" -> {
                    val c = p.str("complexity") ?: ""
                    require(c in COMPLEXITIES) { "unknown password complexity '$c'" }
                    PasswordPolicy(id, c)
                }
                "android_camera" -> Camera(id, p.bool("disabled") ?: throw IllegalArgumentException("camera command without 'disabled'"))
                "android_install_apk" -> {
                    val apkId = p.str("apk_id") ?: ""
                    require(UUID.matches(apkId)) { "install command without a valid apk_id" }
                    val sha = p.str("sha256")?.lowercase() ?: ""
                    require(SHA.matches(sha)) { "install command without a SHA-256" }
                    val size = p.long("size_bytes") ?: -1
                    require(size in 1..MAX_APK_BYTES) { "install command with an invalid size" }
                    InstallApk(id, apkId, "/api/v1/agent/android/apks/$apkId", sha, size, p.str("name") ?: "app")
                }
                "android_uninstall" -> {
                    val pkg = p.str("package") ?: ""
                    require(PACKAGE.matches(pkg) && pkg.length <= 200) { "not an Android package name" }
                    Uninstall(id, pkg)
                }
                "android_wipe" -> Wipe(id, p.str("reason") ?: "")
                "android_release" -> Release(id)
                "rd_session_open" -> SessionOpen(id, ScreenSessionRequest.parse(p))
                "rd_session_close" -> SessionClose(id, sessionId(p), p.str("reason") ?: "operator")
                "rd_session_update" -> SessionUpdate(id, sessionId(p), operators(p))
                "rd_capture" -> Capture(
                    id,
                    (p.long("quality") ?: 65L).toInt().coerceIn(10, 95),
                    (p["scale"] as? Number)?.toDouble()?.coerceIn(0.25, 1.0) ?: 0.75,
                    p.bool("full_frame") ?: false,
                )
                "rd_input" -> Input(id, InputEvent.parse(p))
                "fs_op" -> FsOp(id, FsRequest.parse(p))
                "notify_user" -> {
                    val title = PlainText.clean(p.str("title"), MAX_TITLE)
                    val message = PlainText.clean(p.str("message"), MAX_MESSAGE)
                    require(title.isNotEmpty() && message.isNotEmpty()) { "a message needs a title and a text" }
                    Notify(id, title, message)
                }
                "android_ring" -> Ring(id, (p.long("seconds") ?: 30L).toInt().coerceIn(5, MAX_RING_SECONDS), p.str("operator")?.let { PlainText.clean(it, 254) })
                "android_ring_stop" -> RingStop(id)
                else -> Unsupported(id, kind)
            }
        }

        private val SESSION_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        internal fun sessionId(p: Map<String, Any?>): String {
            val s = p.str("session_id") ?: ""
            require(SESSION_ID.matches(s)) { "session command without a valid session_id" }
            return s
        }
        internal fun operators(p: Map<String, Any?>): List<String> =
            (p.list("operators") ?: emptyList()).mapNotNull { (it as? String)?.let { o -> PlainText.clean(o, 254) }?.ifEmpty { null } }.take(10)

        /** notify_user limits (the API's commands schema: title 120, message 600). */
        const val MAX_TITLE = 120
        const val MAX_MESSAGE = 600
        const val MAX_RING_SECONDS = 60

        /** The largest APK Fleet stores (fleet-android/apks.ts): 100 MiB. */
        const val MAX_APK_BYTES = 100L * 1024 * 1024
    }
}

/** Whether a command may run in [mode]; the refusal text when not. */
object CommandRules {
    fun refusal(cmd: AgentCommand, mode: Mode, ownPackage: String): String? {
        if (cmd is AgentCommand.Unsupported) return "this agent does not support '${cmd.kind}'"
        if (cmd.needsDeviceOwner && mode != Mode.DEVICE_OWNER) return "android_requires_device_owner: Nigafiy is not the Device Owner of this phone"
        if (cmd is AgentCommand.Uninstall && cmd.packageName == ownPackage) return "the Nigafiy agent cannot uninstall itself; use Stop management"
        return null
    }
}

/**
 * At most once: a command id that was taken is never run again, even after the app restarts
 * (the set is persisted by the app). Keeps the newest [capacity] ids.
 */
class SeenCommands(initial: Collection<String> = emptyList(), private val capacity: Int = 500) {
    private val ids = LinkedHashSet<String>(initial)

    /** True the first time [id] is seen. */
    @Synchronized
    fun take(id: String): Boolean {
        if (ids.contains(id)) return false
        ids.add(id)
        while (ids.size > capacity) ids.remove(ids.first())
        return true
    }

    @Synchronized
    fun snapshot(): List<String> = ids.toList()
}

/** A command's result, posted to `/api/v1/agent/command-result`. */
data class CommandOutcome(val id: String, val ok: Boolean, val output: String? = null, val error: String? = null, val data: Map<String, Any?>? = null) {
    fun toJson(): Map<String, Any?> = linkedMapOf<String, Any?>("id" to id, "ok" to ok).also {
        if (output != null) it["output"] = output.take(32_000)
        if (error != null) it["error"] = error.take(2000)
        if (data != null) it["data"] = data
    }
}
