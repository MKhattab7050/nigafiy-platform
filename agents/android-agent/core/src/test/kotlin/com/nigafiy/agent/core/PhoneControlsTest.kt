package com.nigafiy.agent.core

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val ID = "0b4b0f7e-9d0e-4d7a-9f3e-0a1b2c3d4e5f"
private fun cmd(kind: String, payload: Map<String, Any?> = emptyMap()) = AgentCommand.parse(mapOf("id" to ID, "kind" to kind, "payload" to payload))

class PhoneCommandsTest {
    @Test
    fun parsesThePhoneControls() {
        val open = cmd("rd_session_open", mapOf("session_id" to "abcDEF123_-x", "operator" to "it@example.com", "reason" to "Help with mail\u0007", "consent_timeout_s" to 90L, "control" to true, "operators" to listOf("it@example.com", 5))) as AgentCommand.SessionOpen
        assertEquals("abcDEF123_-x", open.session.sessionId)
        assertEquals("Help with mail", open.session.reason)
        assertEquals(90, open.session.consentTimeoutS)
        assertTrue(open.session.control)
        assertEquals(listOf("it@example.com"), open.session.operators)
        assertEquals("abcDEF123_-x", (cmd("rd_session_close", mapOf("session_id" to "abcDEF123_-x")) as AgentCommand.SessionClose).sessionId)
        val cap = cmd("rd_capture", mapOf("quality" to 200L, "scale" to 0.1)) as AgentCommand.Capture
        assertEquals(95, cap.quality)
        assertEquals(0.25, cap.scale)
        val msg = cmd("notify_user", mapOf("title" to "IT", "message" to "x".repeat(900))) as AgentCommand.Notify
        assertEquals(AgentCommand.MAX_MESSAGE, msg.message.length)
        assertEquals(60, (cmd("android_ring", mapOf("seconds" to 999L)) as AgentCommand.Ring).seconds)
        assertEquals(30, (cmd("android_ring") as AgentCommand.Ring).seconds)
        assertTrue(cmd("android_ring_stop") is AgentCommand.RingStop)
        assertEquals("list", (cmd("fs_op", mapOf("op" to "list", "path" to "/storage/emulated/0")) as AgentCommand.FsOp).request.op)
    }

    @Test
    fun phoneControlsDoNotNeedDeviceOwnerButStayValidated() {
        val own = "com.nigafiy.agent"
        for (c in listOf(cmd("rd_capture"), cmd("android_ring"), cmd("notify_user", mapOf("title" to "a", "message" to "b")), cmd("fs_op", mapOf("op" to "roots")))) {
            assertEquals(null, CommandRules.refusal(c, Mode.REGULAR, own), c.kind)
        }
        assertFailsWith<IllegalArgumentException> { cmd("rd_session_open", mapOf("session_id" to "../x")) }
        assertFailsWith<IllegalArgumentException> { cmd("notify_user", mapOf("title" to "  ", "message" to "b")) }
        assertFailsWith<IllegalArgumentException> { cmd("fs_op", mapOf("op" to "chmod")) }
        assertFailsWith<IllegalArgumentException> { cmd("rd_input", mapOf("kind" to "mouse_click", "x" to 1.5, "y" to 0.2)) }
        assertFailsWith<IllegalArgumentException> { cmd("rd_input", mapOf("kind" to "nav", "nav" to "power")) }
    }

    @Test
    fun plainTextDropsControlAndDirectionCharacters() {
        assertEquals("a b c", PlainText.clean("a\u0000b‮c", 10))
        assertEquals("line1\nline2", PlainText.clean("line1\nline2", 20))
    }
}

class GesturesTest {
    private fun input(p: Map<String, Any?>) = (cmd("rd_input", p) as AgentCommand.Input).event

    @Test
    fun tapsLongPressesSwipesAndNavigation() {
        val tap = Gestures.plan(input(mapOf("kind" to "mouse_click", "x" to 0.5, "y" to 1.0)), 1080, 2400) as GesturePlan.Strokes
        assertEquals(1, tap.strokes.size)
        assertEquals(539.5f, tap.strokes[0].x)
        assertEquals(2399f, tap.strokes[0].y)
        val dbl = Gestures.plan(input(mapOf("kind" to "mouse_click", "x" to 0.1, "y" to 0.1, "double" to true)), 100, 100) as GesturePlan.Strokes
        assertEquals(2, dbl.strokes.size)
        assertTrue(dbl.strokes[1].startMs >= dbl.strokes[0].durationMs)
        val long = Gestures.plan(input(mapOf("kind" to "mouse_click", "x" to 0.2, "y" to 0.2, "button" to "right")), 100, 100) as GesturePlan.Strokes
        assertEquals(Gestures.LONG_PRESS_MS.toLong(), long.strokes[0].durationMs)
        val swipe = Gestures.plan(input(mapOf("kind" to "swipe", "x" to 0.5, "y" to 0.8, "x2" to 0.5, "y2" to 0.2, "duration_ms" to 99_999L)), 1000, 1000) as GesturePlan.Strokes
        assertEquals(Gestures.MAX_MS.toLong(), swipe.strokes[0].durationMs)
        assertTrue(swipe.strokes[0].y2 < swipe.strokes[0].y)
        assertEquals(GesturePlan.Global("home"), Gestures.plan(input(mapOf("kind" to "nav", "nav" to "home")), 10, 10))
    }

    @Test
    fun keyboardAndTextAreRefusedNeverTyped() {
        val ev = input(mapOf("kind" to "text", "text" to "secret"))
        assertTrue(ev is InputEvent.Unsupported)
        assertTrue(assertFailsWith<IllegalArgumentException> { Gestures.plan(ev, 10, 10) }.message!!.contains("not available"))
    }

    @Test
    fun frameDataHasTheRemoteDesktopShape() {
        val f = FrameData.of("QUJD", 3, 540, 1200, 1080, 2400, 68, 0.5, 12, "2026-11-25T10:00:00Z", unchanged = false)
        assertEquals("QUJD", f["jpeg_base64"])
        assertEquals(1080, (f["displays"] as List<*>).let { (it[0] as Map<*, *>)["width"] })
        val same = FrameData.of(null, 3, 540, 1200, 1080, 2400, 68, 0.5, 12, "2026-11-25T10:00:00Z", unchanged = true)
        assertEquals(true, same["unchanged"])
        assertEquals(0, same["byte_length"])
        assertFalse(same.containsKey("jpeg_base64"))
        Json.parseObject(Json.write(f))
    }

    @Test
    fun featuresFollowTheAndroidVersion() {
        assertFalse(PhoneFeatures.FILES in PhoneFeatures.supported(29))
        assertTrue(PhoneFeatures.FILES in PhoneFeatures.supported(36))
    }

    @Test
    fun heartbeatCarriesTheControlFacts() {
        val i = DeviceInfo(
            deviceName = "A36", manufacturer = "samsung", model = "SM-A366B", androidRelease = "16", sdkInt = 36, securityPatch = null, abi = null,
            ramTotalBytes = null, ramAvailBytes = null, storageTotalBytes = null, storageFreeBytes = null, batteryPct = null, charging = null,
            network = null, primaryIpv4 = null, interfaces = emptyList(), apps = null, uptimeSeconds = 1, mode = Mode.REGULAR, cameraDisabled = null,
            passwordComplexityRequired = null, batteryOptimisationExempt = null, notificationsAllowed = true,
            features = PhoneFeatures.supported(36), allFilesAccess = false, accessibilityEnabled = true, screenCapture = true,
        )
        val a = Protocol.androidBlock(i)
        assertEquals(listOf("screen", "control", "files", "ring", "message"), a["features"])
        assertEquals(false, a["all_files_access"])
        assertEquals(true, a["accessibility_enabled"])
        assertEquals(true, a["screen_capture"])
    }
}

class SharedStorageTest {
    private val dir: File = Files.createTempDirectory("nigafiy-storage").toFile()
    private val root = File(dir, "0").apply { mkdirs() }
    private val outside = File(dir, "outside").apply { mkdirs(); File(this, "secret.txt").writeText("no") }
    private val prefix = "/storage/emulated/0"
    private val fs = SharedStorage(root, prefix)

    @AfterTest
    fun cleanup() { dir.deleteRecursively() }

    private fun op(op: String, vararg kv: Pair<String, Any?>) = fs.execute(FsRequest.parse(mapOf("op" to op, *kv)))
    private fun refused(op: String, vararg kv: Pair<String, Any?>): String = assertFailsWith<FsError> { op(op, *kv) }.message!!

    @Test
    fun rootsAndListingsUsePhonePaths() {
        File(root, "Download").mkdirs()
        File(root, "DCIM/Camera").mkdirs()
        File(root, "Download/report.pdf").writeText("pdf")
        File(root, ".hidden").writeText("h")
        @Suppress("UNCHECKED_CAST") val roots = op("roots")["roots"] as List<Map<String, Any?>>
        assertEquals(listOf("$prefix", "$prefix/Download", "$prefix/DCIM"), roots.map { it["path"] })
        val list = op("list", "path" to prefix)
        @Suppress("UNCHECKED_CAST") val names = (list["entries"] as List<Map<String, Any?>>).map { it["name"] }
        assertEquals(listOf("DCIM", "Download"), names, "folders first, hidden files only on request")
        assertEquals("", list["parent_path"])
        @Suppress("UNCHECKED_CAST") val dl = (op("list", "path" to "$prefix/Download")["entries"] as List<Map<String, Any?>>)[0]
        assertEquals("$prefix/Download/report.pdf", dl["path"])
        assertEquals("pdf", dl["ext"])
        assertEquals(prefix, op("list", "path" to "$prefix/Download")["parent_path"])
    }

    @Test
    fun refusesTraversalOutsidePathsAndAppPrivateFolders() {
        File(root, "Android/data/com.bank.app").mkdirs()
        assertTrue(refused("list", "path" to "$prefix/../outside").contains("traversal"))
        assertTrue(refused("list", "path" to "/data/data/com.nigafiy.agent").contains("shared storage"))
        assertTrue(refused("list", "path" to "relative/path").contains("absolute"))
        assertTrue(refused("list", "path" to "$prefix/Android/data").contains("private"))
        assertTrue(refused("download", "path" to "$prefix/Android/data/com.bank.app/x").contains("private"))
        assertTrue(refused("delete", "paths" to listOf(prefix), "confirm_destructive" to true).contains("root"))
        assertTrue(refused("delete", "paths" to listOf("$prefix/Android"), "confirm_destructive" to true).contains("Android folder"))
        assertTrue(refused("mkdir", "path" to "$prefix/Android/obb/x").contains("private"))
        // The Android folder itself may be listed (its private subfolders are refused).
        op("list", "path" to "$prefix/Android")
    }

    @Test
    fun aSymbolicLinkCannotLeadOutside() {
        val link = File(root, "escape")
        try {
            Files.createSymbolicLink(link.toPath(), outside.toPath())
        } catch (e: Exception) {
            return // no symlink privilege on this machine (Windows without developer mode): nothing to test
        }
        assertTrue(refused("list", "path" to "$prefix/escape").contains("symbolic link"))
        assertTrue(refused("download", "path" to "$prefix/escape/secret.txt").contains("symbolic link"))
    }

    @Test
    fun folderOperations() {
        op("mkdir", "path" to "$prefix/Work")
        assertTrue(refused("mkdir", "path" to "$prefix/Work").contains("already exists"))
        op("touch", "path" to "$prefix/Work/a.txt", "data_base64" to Base64.getEncoder().encodeToString("hi".toByteArray()))
        assertEquals("hi", File(root, "Work/a.txt").readText())
        op("rename", "path" to "$prefix/Work/a.txt", "new_name" to "b.txt")
        assertTrue(File(root, "Work/b.txt").exists())
        assertTrue(refused("rename", "path" to "$prefix/Work/b.txt", "new_name" to "../c.txt").contains("not a valid name"))
        op("mkdir", "path" to "$prefix/Other")
        op("copy", "paths" to listOf("$prefix/Work"), "target_path" to "$prefix/Other")
        assertEquals("hi", File(root, "Other/Work/b.txt").readText())
        assertTrue(refused("move", "paths" to listOf("$prefix/Work"), "target_path" to "$prefix/Work").contains("into itself"))
        op("move", "paths" to listOf("$prefix/Other/Work/b.txt"), "target_path" to "$prefix/Other")
        assertTrue(File(root, "Other/b.txt").exists())
        @Suppress("UNCHECKED_CAST") val hits = op("search", "path" to prefix, "query" to "B.T")["entries"] as List<Map<String, Any?>>
        assertEquals(setOf("$prefix/Work/b.txt", "$prefix/Other/b.txt"), hits.map { it["path"] }.toSet())
        assertTrue(refused("delete", "paths" to listOf("$prefix/Work")).contains("confirmation"))
        op("delete", "paths" to listOf("$prefix/Work", "$prefix/Other"), "confirm_destructive" to true)
        assertFalse(File(root, "Work").exists())
        assertFalse(File(root, "Other").exists())
    }

    @Test
    fun downloadInChunksWithTheChecksumAtTheEnd() {
        val data = ByteArray(700_000) { (it % 251).toByte() }
        File(root, "big.bin").writeBytes(data)
        val first = op("download", "path" to "$prefix/big.bin", "offset" to 0L, "length" to 10_000_000L)
        assertEquals(SharedStorage.MAX_CHUNK, first["bytes_read"])
        assertEquals(false, first["eof"])
        val second = op("download", "path" to "$prefix/big.bin", "offset" to SharedStorage.MAX_CHUNK.toLong(), "length" to 524_288L)
        assertEquals(true, second["eof"])
        assertEquals(sha(data), second["sha256"])
        val joined = Base64.getDecoder().decode(first["data_base64"] as String) + Base64.getDecoder().decode(second["data_base64"] as String)
        assertTrue(joined.contentEquals(data))
    }

    @Test
    fun uploadsNeverReplaceWithoutConfirmationAndContinueOnlyTheirOwnFile() {
        val part1 = "hello ".toByteArray()
        val part2 = "world".toByteArray()
        val whole = part1 + part2
        val b64 = { b: ByteArray -> Base64.getEncoder().encodeToString(b) }
        op("upload", "path" to "$prefix/up.txt", "offset" to 0L, "data_base64" to b64(part1))
        val done = op("upload", "path" to "$prefix/up.txt", "offset" to part1.size.toLong(), "data_base64" to b64(part2), "expected_sha256" to sha(whole))
        assertEquals(sha(whole), done["sha256"])
        assertEquals("hello world", File(root, "up.txt").readText())
        assertTrue(refused("upload", "path" to "$prefix/up.txt", "offset" to 0L, "data_base64" to b64(part1)).startsWith(SharedStorage.UPLOAD_TARGET_EXISTS))
        val over = op("upload", "path" to "$prefix/up.txt", "offset" to 0L, "data_base64" to b64(part2), "overwrite" to true)
        assertEquals(true, over["overwritten"])
        assertEquals("world", File(root, "up.txt").readText())
        // A continuation of a file this upload did not create, or at the wrong offset, is refused.
        File(root, "other.txt").writeText("abc")
        assertTrue(refused("upload", "path" to "$prefix/other.txt", "offset" to 3L, "data_base64" to b64(part2)).contains("continuation refused"))
        assertTrue(refused("upload", "path" to "$prefix/up.txt", "offset" to 1L, "data_base64" to b64(part2)).contains("continuation refused"))
        assertTrue(refused("upload", "path" to "$prefix/bad.txt", "offset" to 0L, "data_base64" to b64(part1), "expected_sha256" to "00".repeat(32)).contains("checksum mismatch"))
        assertEquals(part2.size.toLong(), op("hash", "path" to "$prefix/up.txt")["upload_next"])
        assertTrue(refused("upload", "path" to "$prefix/huge.bin", "offset" to 0L, "data_base64" to b64(ByteArray(SharedStorage.MAX_CHUNK * 2 + 1))).contains("maximum"))
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
}
