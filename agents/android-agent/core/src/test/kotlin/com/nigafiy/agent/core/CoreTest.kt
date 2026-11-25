package com.nigafiy.agent.core

import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Instant
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class JsonTest {
    @Test
    fun roundTripKeepsTypesAndOrder() {
        val text = """{"b":1,"a":[true,false,null,1.5,-2,"x\"y\\zé\n"],"o":{}}"""
        val v = Json.parseObject(text)
        assertEquals(listOf("b", "a", "o"), v.keys.toList())
        assertEquals(1L, v["b"])
        assertEquals(listOf(true, false, null, 1.5, -2L, "x\"y\\zé\n"), v["a"])
        assertEquals("""{"b":1,"a":[true,false,null,1.5,-2,"x\"y\\zé\n"],"o":{}}""", Json.write(v))
    }

    @Test
    fun escapesLineSeparatorsAndControls() {
        assertEquals("\"\\u2028\\u0001\"", Json.write(" \u0001"))
    }

    @Test
    fun refusesBrokenJson() {
        for (bad in listOf("{", "[1,]", "{\"a\" 1}", "tru", "\"abc", "{} x", "-")) {
            assertFailsWith<Json.ParseError>(bad) { Json.parse(bad) }
        }
        assertFailsWith<Json.ParseError> { Json.parse("[".repeat(100) + "]".repeat(100)) }
    }
}

class EnrollmentTest {
    private val token = "ldea_" + "A".repeat(43)

    @Test
    fun parsesTheFleetLink() {
        val pin = "ab".repeat(32)
        val e = Enrollment.fromLink("nigafiy://enroll?server=https%3A%2F%2FFleet.Example.test%3A8443%2F&token=$token&pin=${pin.uppercase()}")
        assertEquals("https://fleet.example.test:8443", e.server)
        assertEquals(token, e.token)
        assertEquals(pin, e.pin)
        assertEquals(e, Enrollment.fromLink(e.toLink()))
    }

    @Test
    fun pinIsOptionalAndColonsAreAccepted() {
        assertNull(Enrollment.of("https://a.test", token, "").pin)
        assertEquals("ab".repeat(32), Enrollment.of("https://a.test", token, List(32) { "AB" }.joinToString(":")).pin)
    }

    @Test
    fun refusesUnsafeOrWrongValues() {
        assertFailsWith<IllegalArgumentException> { Enrollment.of("http://fleet.example.test", token, null) }
        assertFailsWith<IllegalArgumentException> { Enrollment.of("ftp://a.test", token, null) }
        assertFailsWith<IllegalArgumentException> { Enrollment.of("https://user:pw@a.test", token, null) }
        assertFailsWith<IllegalArgumentException> { Enrollment.of("https://a.test", "lda_xxxxxxxxxxxxxxxxxxxxxxxx", null) }
        assertFailsWith<IllegalArgumentException> { Enrollment.of("https://a.test", token, "1234") }
        assertFailsWith<IllegalArgumentException> { Enrollment.fromLink("https://a.test/enroll?token=$token") }
        // A name is never resolved: "localhost.evil.test" is not loopback.
        assertFailsWith<IllegalArgumentException> { Enrollment.of("http://localhost.evil.test", token, null) }
    }

    @Test
    fun plainHttpOnlyForLoopback() {
        assertEquals("http://127.0.0.1:4100", Enrollment.of("http://127.0.0.1:4100/", token, null).server)
        assertEquals("http://[::1]:4100", Enrollment.of("http://[::1]:4100", token, null).server)
        assertTrue(Enrollment.isLoopback("localhost"))
        assertFalse(Enrollment.isLoopback("10.0.0.1"))
    }
}

class ComplianceTest {
    private val today = LocalDate.parse("2026-11-25")
    private fun facts(
        lock: Boolean? = true, enc: Int? = EncryptionStatus.ACTIVE_PER_USER, patch: String? = "2026-11-01",
        dev: Boolean? = false, adb: Boolean? = false, unknown: UnknownSourcesFacts = UnknownSourcesFacts(null, emptyList(), null),
    ) = SecurityFacts(lock, enc, patch, dev, adb, unknown)

    private fun states(f: SecurityFacts) = Compliance.evidence(f, "2026-11-25T10:00:00Z", today).associate { it.check to it.state }

    @Test
    fun aHealthyPhonePassesEverything() {
        val s = states(facts())
        assertEquals(setOf("screen_lock", "disk_encryption", "os_updates", "developer_options", "usb_debugging", "unknown_sources"), s.keys)
        assertTrue(s.values.all { it == "pass" }, s.toString())
    }

    @Test
    fun eachRiskFails() {
        val s = states(facts(lock = false, enc = EncryptionStatus.INACTIVE, patch = "2026-01-05", dev = true, adb = true, unknown = UnknownSourcesFacts(false, listOf("com.android.chrome"), null)))
        assertTrue(s.values.all { it == "fail" }, s.toString())
        val patch = Compliance.evidence(facts(patch = "2026-01-05"), "t", today).first { it.check == "os_updates" }
        assertEquals("2026-01-05 (324 days old)", patch.value)
    }

    @Test
    fun notReadIsUnknownNeverPass() {
        val s = states(facts(lock = null, enc = null, patch = null, dev = null, adb = null, unknown = UnknownSourcesFacts(null, null, "no access")))
        assertTrue(s.values.all { it == "unknown" }, s.toString())
        val e = Compliance.evidence(facts(unknown = UnknownSourcesFacts(null, null, "no access")), "t", today).first { it.check == "unknown_sources" }
        assertEquals("no access", e.reason)
    }

    @Test
    fun defaultKeyEncryptionIsAWarningAndPolicyBlockPasses() {
        val s = states(facts(enc = EncryptionStatus.ACTIVE_DEFAULT_KEY, unknown = UnknownSourcesFacts(true, listOf("x.y"), null)))
        assertEquals("warn", s["disk_encryption"])
        assertEquals("pass", s["unknown_sources"])
    }

    @Test
    fun patchAtExactly90DaysPasses() {
        assertEquals("pass", states(facts(patch = today.minusDays(90).toString()))["os_updates"])
        assertEquals("fail", states(facts(patch = today.minusDays(91).toString()))["os_updates"])
    }
}

class CommandsTest {
    private val id = "0b4b0f7e-9d0e-4d7a-9f3e-0a1b2c3d4e5f"
    private fun cmd(kind: String, payload: Map<String, Any?> = emptyMap()) = AgentCommand.parse(mapOf("id" to id, "kind" to kind, "payload" to payload))

    @Test
    fun parsesEveryKind() {
        assertTrue(cmd("refresh_inventory") is AgentCommand.RefreshInventory)
        assertTrue(cmd("android_lock") is AgentCommand.Lock)
        assertEquals("high", (cmd("android_password_policy", mapOf("complexity" to "high")) as AgentCommand.PasswordPolicy).complexity)
        assertEquals(true, (cmd("android_camera", mapOf("disabled" to true)) as AgentCommand.Camera).disabled)
        val apk = cmd("android_install_apk", mapOf("apk_id" to id, "sha256" to "AB".repeat(32), "size_bytes" to 1234L, "name" to "Tool")) as AgentCommand.InstallApk
        assertEquals("/api/v1/agent/android/apks/$id", apk.path)
        assertEquals("ab".repeat(32), apk.sha256)
        assertEquals("com.example.app", (cmd("android_uninstall", mapOf("package" to "com.example.app")) as AgentCommand.Uninstall).packageName)
        assertTrue(cmd("android_wipe", mapOf("reason" to "lost")) is AgentCommand.Wipe)
        assertTrue(cmd("android_release") is AgentCommand.Release)
        assertTrue(cmd("shell_open") is AgentCommand.Unsupported)
    }

    @Test
    fun refusesMalformedPayloads() {
        assertFailsWith<IllegalArgumentException> { cmd("android_password_policy", mapOf("complexity" to "max")) }
        assertFailsWith<IllegalArgumentException> { cmd("android_camera") }
        assertFailsWith<IllegalArgumentException> { cmd("android_uninstall", mapOf("package" to "../etc")) }
        assertFailsWith<IllegalArgumentException> { cmd("android_install_apk", mapOf("apk_id" to id, "sha256" to "zz", "size_bytes" to 1L)) }
        assertFailsWith<IllegalArgumentException> { cmd("android_install_apk", mapOf("apk_id" to id, "sha256" to "ab".repeat(32), "size_bytes" to AgentCommand.MAX_APK_BYTES + 1)) }
        assertFailsWith<IllegalArgumentException> { AgentCommand.parse(mapOf("id" to "nope", "kind" to "android_lock")) }
    }

    @Test
    fun deviceOwnerRules() {
        val own = "com.nigafiy.agent"
        assertNull(CommandRules.refusal(cmd("refresh_inventory"), Mode.REGULAR, own))
        assertTrue(CommandRules.refusal(cmd("android_lock"), Mode.REGULAR, own)!!.startsWith("android_requires_device_owner"))
        assertNull(CommandRules.refusal(cmd("android_lock"), Mode.DEVICE_OWNER, own))
        assertTrue(CommandRules.refusal(cmd("android_uninstall", mapOf("package" to own)), Mode.DEVICE_OWNER, own)!!.contains("cannot uninstall itself"))
        assertTrue(CommandRules.refusal(cmd("shell_open"), Mode.DEVICE_OWNER, own)!!.contains("does not support"))
    }

    @Test
    fun eachCommandRunsAtMostOnce() {
        val seen = SeenCommands(listOf("a"), capacity = 3)
        assertFalse(seen.take("a"))
        assertTrue(seen.take("b"))
        assertFalse(seen.take("b"))
        assertTrue(seen.take("c"))
        assertTrue(seen.take("d"))
        assertEquals(listOf("b", "c", "d"), seen.snapshot())
        assertFalse(SeenCommands(seen.snapshot()).take("c"))
    }
}

class ProtocolTest {
    private fun info(apps: List<InstalledApp>? = listOf(InstalledApp("Zeta", "z.app", "1.0", false), InstalledApp("alpha\u0007", "a.app", null, true))) = DeviceInfo(
        deviceName = "Pixel of Sara", manufacturer = "Google", model = "Pixel 8", androidRelease = "16", sdkInt = 36,
        securityPatch = "2026-11-05", abi = "arm64-v8a", ramTotalBytes = 8L * 1_073_741_824, ramAvailBytes = 2L * 1_073_741_824,
        storageTotalBytes = 128L * 1_073_741_824, storageFreeBytes = 32L * 1_073_741_824, batteryPct = 81, charging = false,
        network = "wifi", primaryIpv4 = "10.0.0.23", interfaces = listOf(NetInterface("wlan0", listOf("10.0.0.23/24"))),
        apps = apps, uptimeSeconds = 3600, mode = Mode.DEVICE_OWNER, cameraDisabled = true, passwordComplexityRequired = "medium",
        batteryOptimisationExempt = true, notificationsAllowed = true,
    )
    private val facts = SecurityFacts(true, EncryptionStatus.ACTIVE_PER_USER, "2026-11-05", false, false, UnknownSourcesFacts(true, null, null))

    @Test
    fun heartbeatHasTheApiShape() {
        val hb = Protocol.heartbeatBody(info(), facts, listOf(CommandOutcome("x", true, output = "locked")), Instant.parse("2026-11-25T10:00:00Z"))
        assertEquals("android", hb["platform"])
        assertEquals("Android 16 (API 36)", hb["os_version"])
        assertEquals(8192L, hb["ram_total_mb"])
        assertEquals(6144L, hb["ram_used_mb"])
        assertEquals(75.0, hb["ram_pct"])
        assertEquals(75.0, hb["disk_used_pct"])
        assertFalse(hb.containsKey("cpu_pct"), "Android gives apps no CPU load: it is not sent as 0")
        @Suppress("UNCHECKED_CAST") val sw = hb["software"] as List<Map<String, Any?>>
        assertEquals(listOf("alpha", "Zeta"), sw.map { it["name"] })
        assertEquals("system app", sw[0]["publisher"])
        assertEquals("a.app", sw[0]["package_id"])
        @Suppress("UNCHECKED_CAST") val android = hb["android"] as Map<String, Any?>
        assertEquals("device_owner", android["mode"])
        assertEquals(81, android["battery_pct"])
        assertEquals(2, android["apps_count"])
        @Suppress("UNCHECKED_CAST") val results = hb["command_results"] as List<Map<String, Any?>>
        assertEquals("locked", results[0]["output"])
        // The JSON writer accepts the whole body.
        Json.parseObject(Json.write(hb))
    }

    @Test
    fun unreadValuesAreLeftOut() {
        val hb = Protocol.heartbeatBody(info(apps = null).copy(ramAvailBytes = null, storageTotalBytes = null, batteryPct = null, primaryIpv4 = "fe80::1"), facts, emptyList())
        for (k in listOf("ram_used_mb", "disks", "software", "primary_ip", "command_results")) assertFalse(hb.containsKey(k), k)
        @Suppress("UNCHECKED_CAST") val android = hb["android"] as Map<String, Any?>
        assertFalse(android.containsKey("battery_pct"))
    }

    @Test
    fun malformedCommandsBecomeFailures() {
        val (ok, bad) = Protocol.parseCommands("""{"commands":[{"id":"0b4b0f7e-9d0e-4d7a-9f3e-0a1b2c3d4e5f","kind":"android_lock","payload":{}},{"id":"1b4b0f7e-9d0e-4d7a-9f3e-0a1b2c3d4e5f","kind":"android_camera","payload":{}}]}""")
        assertEquals(1, ok.size)
        assertEquals(1, bad.size)
        assertFalse(bad[0].ok)
    }
}

class PinTest {
    private fun cert(name: String): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(javaClass.getResourceAsStream("/pin/$name.pem")!!) as X509Certificate

    private val leaf = cert("leaf")
    private val ca = cert("ca")
    private val other = cert("other")

    @Test
    fun leafPinMatches() {
        Pin.verifyPinnedChain(arrayOf(leaf), Pin.sha256Hex(leaf.encoded))
        Pin.verifyPinnedChain(arrayOf(leaf, ca), Pin.sha256Hex(leaf.encoded).uppercase())
    }

    @Test
    fun caPinMatchesWhenTheLeafVerifiesAgainstIt() {
        Pin.verifyPinnedChain(arrayOf(leaf, ca), Pin.sha256Hex(ca.encoded))
    }

    @Test
    fun aCaThatDidNotSignTheLeafIsRefused() {
        val e = assertFailsWith<CertificateException> { Pin.verifyPinnedChain(arrayOf(leaf, other), Pin.sha256Hex(other.encoded)) }
        assertTrue(e.message!!.contains("does not verify against the pinned CA"), e.message)
    }

    @Test
    fun anyOtherPinIsAMismatch() {
        val e = assertFailsWith<CertificateException> { Pin.verifyPinnedChain(arrayOf(leaf, ca), "00".repeat(32)) }
        assertTrue(e.message!!.contains("pin mismatch"))
        assertFailsWith<CertificateException> { Pin.verifyPinnedChain(emptyArray(), "00".repeat(32)) }
    }
}
