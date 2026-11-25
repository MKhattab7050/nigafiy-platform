package com.nigafiy.agent.core

import java.time.Instant
import kotlin.math.roundToInt

/** One installed app (PackageManager). */
data class InstalledApp(val label: String, val packageName: String, val versionName: String?, val system: Boolean)

/** One network interface with its addresses (ConnectivityManager / LinkProperties). */
data class NetInterface(val name: String, val addresses: List<String>)

/**
 * Everything the app read on the phone for one heartbeat. A null is a value Android did not give;
 * it is left out of the report (the web shows "not measured"), never sent as 0.
 */
data class DeviceInfo(
    val deviceName: String,
    val manufacturer: String?,
    val model: String?,
    val androidRelease: String,
    val sdkInt: Int,
    val securityPatch: String?,
    val abi: String?,
    val ramTotalBytes: Long?,
    val ramAvailBytes: Long?,
    val storageTotalBytes: Long?,
    val storageFreeBytes: Long?,
    val batteryPct: Int?,
    val charging: Boolean?,
    /** wifi, cellular, ethernet, vpn, none or other. */
    val network: String?,
    val primaryIpv4: String?,
    val interfaces: List<NetInterface>,
    val apps: List<InstalledApp>?,
    val uptimeSeconds: Long,
    val mode: Mode,
    val cameraDisabled: Boolean?,
    /** none, low, medium, high (what Nigafiy required), or null when not Device Owner. */
    val passwordComplexityRequired: String?,
    val batteryOptimisationExempt: Boolean?,
    val notificationsAllowed: Boolean?,
    /** The phone controls this agent implements ([PhoneFeatures]); the API offers only these. */
    val features: List<String> = emptyList(),
    /** "All files access" granted by the person (Environment.isExternalStorageManager); null before Android 11. */
    val allFilesAccess: Boolean? = null,
    /** The person turned on Nigafiy's accessibility service (remote control). */
    val accessibilityEnabled: Boolean? = null,
    /** Screen capture is possible (false when a policy disables it). */
    val screenCapture: Boolean? = null,
)

object Protocol {
    private val IPV4 = Regex("^((25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1?\\d?\\d)$")
    // Control characters are refused by the API (cleanText); replace them rather than lose the field.
    private fun clean(s: String?, max: Int): String? = s?.replace(Regex("[\\u0000-\\u001f\\u007f]"), " ")?.trim()?.take(max)?.ifEmpty { null }

    private fun gb(bytes: Long): Double = (bytes / 1_073_741_824.0 * 100).roundToInt() / 100.0

    fun osVersion(i: DeviceInfo) = "Android ${i.androidRelease} (API ${i.sdkInt})"

    /** The common identity fields of enroll and heartbeat. */
    private fun identity(i: DeviceInfo): LinkedHashMap<String, Any?> {
        val m = linkedMapOf<String, Any?>(
            "agent_version" to Version.NAME,
            "hostname" to (clean(i.deviceName, 253) ?: clean(i.model, 253) ?: "android"),
            "platform" to "android",
            "os" to "android",
            "os_version" to osVersion(i),
            "arch" to (clean(i.abi, 40) ?: "unknown"),
        )
        clean(i.manufacturer, 120)?.let { m["manufacturer"] = it }
        clean(i.model, 120)?.let { m["model"] = it }
        i.ramTotalBytes?.takeIf { it > 0 }?.let { m["ram_total_mb"] = (it / 1_048_576).coerceAtLeast(1) }
        i.primaryIpv4?.takeIf { IPV4.matches(it) }?.let { m["primary_ip"] = it }
        return m
    }

    fun enrollBody(token: String, i: DeviceInfo, facts: SecurityFacts, now: Instant = Instant.now()): Map<String, Any?> {
        val m = linkedMapOf<String, Any?>("enrollment_token" to token)
        m.putAll(identity(i))
        m["security"] = security(facts, now)
        return m
    }

    fun security(facts: SecurityFacts, now: Instant): Map<String, Any?> = linkedMapOf(
        "checks" to Compliance.evidence(facts, now.toString(), java.time.LocalDate.ofInstant(now, java.time.ZoneOffset.UTC)).map { it.toJson() },
        "measured_at" to now.toString(),
    )

    fun heartbeatBody(i: DeviceInfo, facts: SecurityFacts, results: List<CommandOutcome>, now: Instant = Instant.now()): Map<String, Any?> {
        val m = identity(i)
        m["uptime_seconds"] = i.uptimeSeconds.coerceAtLeast(0)
        if (i.ramTotalBytes != null && i.ramAvailBytes != null && i.ramTotalBytes > 0) {
            val used = (i.ramTotalBytes - i.ramAvailBytes).coerceAtLeast(0)
            m["ram_used_mb"] = used / 1_048_576
            m["ram_pct"] = ((used * 1000.0 / i.ramTotalBytes).roundToInt() / 10.0).coerceIn(0.0, 100.0)
        }
        if (i.storageTotalBytes != null && i.storageFreeBytes != null && i.storageTotalBytes > 0) {
            val used = (i.storageTotalBytes - i.storageFreeBytes).coerceAtLeast(0)
            val pct = ((used * 1000.0 / i.storageTotalBytes).roundToInt() / 10.0).coerceIn(0.0, 100.0)
            m["disk_used_pct"] = pct
            m["disks"] = listOf(
                linkedMapOf(
                    "mount" to "/data",
                    "filesystem" to "internal storage",
                    "total_gb" to gb(i.storageTotalBytes),
                    "used_gb" to gb(used),
                    "free_gb" to gb(i.storageFreeBytes),
                    "used_pct" to pct,
                ),
            )
        }
        m["interfaces"] = i.interfaces.take(32).mapNotNull { n ->
            clean(n.name, 120)?.let { linkedMapOf("name" to it, "addresses" to n.addresses.mapNotNull { a -> clean(a, 64) }.take(16)) }
        }
        if (i.apps != null) {
            m["software"] = i.apps.sortedBy { it.label.lowercase() }.take(1000).map { a ->
                linkedMapOf<String, Any?>("name" to (clean(a.label, 240) ?: a.packageName.take(240))).also { s ->
                    clean(a.versionName, 120)?.let { s["version"] = it }
                    s["package_id"] = a.packageName.take(200)
                    if (a.system) s["publisher"] = "system app"
                }
            }
        }
        m["security"] = security(facts, now)
        if (results.isNotEmpty()) m["command_results"] = results.take(50).map { it.toJson() }
        m["android"] = androidBlock(i)
        return m
    }

    /** The Android-only facts (endpoints.android, migration 045). */
    fun androidBlock(i: DeviceInfo): Map<String, Any?> {
        val a = linkedMapOf<String, Any?>(
            "mode" to i.mode.wire,
            "sdk_int" to i.sdkInt,
            "release" to i.androidRelease.take(40),
        )
        i.securityPatch?.let { a["security_patch"] = it.take(20) }
        i.batteryPct?.takeIf { it in 0..100 }?.let { a["battery_pct"] = it }
        i.charging?.let { a["charging"] = it }
        i.network?.let { a["network"] = it }
        i.cameraDisabled?.let { a["camera_disabled"] = it }
        i.passwordComplexityRequired?.let { a["password_complexity"] = it }
        i.batteryOptimisationExempt?.let { a["battery_optimisation_exempt"] = it }
        i.notificationsAllowed?.let { a["notifications_allowed"] = it }
        if (i.apps != null) a["apps_count"] = i.apps.size
        if (i.features.isNotEmpty()) a["features"] = i.features
        i.allFilesAccess?.let { a["all_files_access"] = it }
        i.accessibilityEnabled?.let { a["accessibility_enabled"] = it }
        i.screenCapture?.let { a["screen_capture"] = it }
        return a
    }

    /** The poll answer `{ "commands": [...] }`; malformed entries come back as failures to report. */
    fun parseCommands(body: String): Pair<List<AgentCommand>, List<CommandOutcome>> {
        val root = Json.parseObject(body)
        val list = root.list("commands") ?: return emptyList<AgentCommand>() to emptyList()
        val ok = ArrayList<AgentCommand>()
        val bad = ArrayList<CommandOutcome>()
        for (item in list) {
            @Suppress("UNCHECKED_CAST")
            val m = item as? Map<String, Any?> ?: continue
            try {
                ok.add(AgentCommand.parse(m))
            } catch (e: IllegalArgumentException) {
                val id = m.str("id")
                if (id != null) bad.add(CommandOutcome(id, false, error = e.message ?: "malformed command"))
            }
        }
        return ok to bad
    }
}
