package com.nigafiy.agent.core

/**
 * The commands Fleet can send to the Android agent (kinds as the API queues them, see
 * apps/api/src/modules/endpoints/fleet-android). Everything except [RefreshInventory] needs the
 * agent to be the phone's Device Owner; the API refuses them first, the agent checks again.
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
                else -> Unsupported(id, kind)
            }
        }

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
