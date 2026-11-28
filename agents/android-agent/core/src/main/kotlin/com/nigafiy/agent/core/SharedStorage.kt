package com.nigafiy.agent.core

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

/**
 * One fs_op request (apps/api/src/modules/endpoints/file-manager/schema.ts), the same fields the
 * Windows agent's filemgr.Request reads.
 */
data class FsRequest(
    val op: String,
    val path: String? = null,
    val paths: List<String> = emptyList(),
    val targetPath: String? = null,
    val newName: String? = null,
    val query: String? = null,
    val showHidden: Boolean = false,
    val confirmDestructive: Boolean = false,
    val offset: Long = 0,
    val length: Long = 0,
    val dataBase64: String? = null,
    val expectedSha256: String? = null,
    val overwrite: Boolean = false,
    /** hash only: size, modification time and resume point, without reading the file. */
    val sizeOnly: Boolean = false,
    val allowedRoots: List<String> = emptyList(),
) {
    companion object {
        val OPS = setOf("roots", "list", "walk", "search", "mkdir", "touch", "rename", "copy", "move", "delete", "download", "upload", "hash")

        fun parse(p: Map<String, Any?>): FsRequest {
            val op = p.str("op") ?: ""
            require(op in OPS) { "unknown file operation '$op'" }
            fun strings(k: String) = (p.list(k) ?: emptyList()).mapNotNull { it as? String }.take(100)
            return FsRequest(
                op = op,
                path = p.str("path"),
                paths = strings("paths"),
                targetPath = p.str("target_path"),
                newName = p.str("new_name"),
                query = p.str("query"),
                showHidden = p.bool("show_hidden") ?: false,
                confirmDestructive = p.bool("confirm_destructive") ?: false,
                offset = p.long("offset") ?: 0,
                length = p.long("length") ?: 0,
                dataBase64 = p.str("data_base64"),
                expectedSha256 = p.str("expected_sha256"),
                overwrite = p.bool("overwrite") ?: false,
                sizeOnly = p.bool("size_only") ?: false,
                allowedRoots = strings("allowed_roots").take(20),
            )
        }
    }
}

/** A refused or failed file operation; the message goes to Fleet as the command's error. */
class FsError(message: String) : IOException(message)

/**
 * The file manager of the Android agent, confined to the phone's shared storage ([root], normally
 * /storage/emulated/0). It needs "All files access" (MANAGE_EXTERNAL_STORAGE), which only the
 * person can grant in Settings; the app checks it before every operation.
 *
 * Confinement: every path must be absolute and inside [root] (checked on the text, which may not
 * contain "." or ".." segments, and again on the canonical path, so a symbolic link cannot lead
 * out). The app-private folders under Android/ (data, obb, media of other apps) are refused, and
 * the root itself and Android/ cannot be renamed, moved or deleted. Limits are the Windows file
 * manager's: 1 MiB per download chunk, 2 MiB per upload chunk, 1500 entries per listing, 250
 * search hits at most 6 levels deep, 10 000 entries at most 32 levels deep for a walk (a whole
 * folder for folder downloads and copies). Uploads never replace a file without the operator's
 * confirmed overwrite, and a continuation chunk only extends the file its own upload created.
 */
class SharedStorage(
    private val root: File,
    /** How paths look to Fleet: the phone's own path of [root] (tests use another folder as root). */
    prefix: String = root.absolutePath,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val rootPath = prefix.trimEnd('/')
    private val rootCanonical: String = root.canonicalPath.trimEnd(File.separatorChar)

    /** A checked path: [path] as Fleet sees it, [file] on the phone. */
    class Target(val path: String, val file: File) {
        val name: String get() = file.name
        fun child(name: String) = Target("$path/$name", File(file, name))
    }

    /** The standard folders listed as roots (when they exist), after the whole storage. */
    private val standard = listOf("Download", "DCIM", "Documents", "Pictures", "Movies", "Music")

    fun execute(req: FsRequest): Map<String, Any?> = when (req.op) {
        "roots" -> roots()
        "list" -> list(resolve(req.path?.takeIf { it.isNotBlank() } ?: rootPath, req, mutating = false), req.showHidden)
        "walk" -> walk(resolve(req.path, req, false), req.showHidden)
        "search" -> search(resolve(req.path, req, false), req)
        "mkdir" -> mkdir(resolve(req.path, req, true))
        "touch" -> touch(resolve(req.path, req, true), req.dataBase64)
        "rename" -> rename(resolve(req.path, req, true), req.newName)
        "copy", "move" -> copyOrMove(req)
        "delete" -> delete(req)
        "download" -> download(resolve(req.path, req, false), req.offset, req.length)
        "upload" -> upload(resolve(req.path, req, true), req)
        "hash" -> hash(resolve(req.path, req, false), req.sizeOnly)
        else -> throw FsError("unknown file operation '${req.op}'")
    }

    // ── Paths ──

    /**
     * The file for [raw] inside shared storage, or an [FsError] that says why not. [mutating]
     * also refuses the root and Android/ themselves (they can be listed, never changed).
     */
    fun resolve(raw: String?, req: FsRequest = FsRequest("list"), mutating: Boolean): Target {
        val p = raw?.trim() ?: throw FsError("a path is required")
        if (p.isEmpty()) throw FsError("a path is required")
        if (p.length > MAX_PATH) throw FsError("the path is too long")
        if (p.contains('\u0000') || p.contains('\\')) throw FsError("the path contains characters a phone path cannot have")
        if (!p.startsWith("/")) throw FsError("the path must be absolute (it starts with $rootPath)")
        val segments = p.split('/').filter { it.isNotEmpty() }
        if (segments.any { it == "." || it == ".." }) throw FsError("path traversal (. or ..) is refused")
        val clean = "/" + segments.joinToString("/")
        if (clean != rootPath && !clean.startsWith("$rootPath/")) throw FsError("only the phone's shared storage ($rootPath) can be opened")
        val rel = clean.removePrefix(rootPath).trimStart('/')
        refusePrivate(rel, mutating)
        if (req.allowedRoots.isNotEmpty() && req.allowedRoots.none { r -> val rr = r.trimEnd('/'); clean == rr || clean.startsWith("$rr/") }) {
            throw FsError("this folder is outside the folders the endpoint's policy allows")
        }
        val f = if (rel.isEmpty()) root else File(root, rel)
        // A symbolic link (or an existing file reached through one) must not lead outside the root.
        val probe = generateSequence(f) { it.parentFile }.firstOrNull { it.exists() } ?: throw FsError("shared storage is not available")
        val canonical = probe.canonicalPath.trimEnd(File.separatorChar)
        if (canonical != rootCanonical && !canonical.startsWith(rootCanonical + File.separator)) throw FsError("the path leads outside shared storage (symbolic link)")
        refusePrivate(canonical.removePrefix(rootCanonical).replace(File.separatorChar, '/').trimStart('/'), mutating && probe == f)
        return Target(clean, f)
    }

    private fun refusePrivate(rel: String, mutating: Boolean) {
        val parts = rel.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty()) {
            if (mutating) throw FsError("the root of shared storage cannot be changed")
            return
        }
        if (parts[0].equals("Android", ignoreCase = true)) {
            if (parts.size >= 2) throw FsError("Android/${parts[1]} holds apps' private files and is refused")
            if (mutating) throw FsError("the Android folder cannot be changed")
        }
    }

    // ── Operations ──

    private fun roots(): Map<String, Any?> {
        val roots = ArrayList<Map<String, Any?>>()
        roots.add(linkedMapOf("name" to "Internal storage", "path" to rootPath, "label" to "Internal storage"))
        for (name in standard) {
            val f = File(root, name)
            if (f.isDirectory) roots.add(linkedMapOf("name" to name, "path" to "$rootPath/$name", "label" to name))
        }
        return linkedMapOf("op" to "roots", "roots" to roots)
    }

    private fun entry(t: Target): Map<String, Any?> {
        val f = t.file
        val dir = f.isDirectory
        val name = f.name
        val ext = if (dir) "" else name.substringAfterLast('.', "").lowercase().takeIf { name.contains('.') } ?: ""
        val mode = buildString {
            append(if (dir) 'd' else '-')
            append(if (f.canRead()) 'r' else '-')
            append(if (f.canWrite()) 'w' else '-')
            append(if (dir) 'x' else '-')
        }
        return linkedMapOf(
            "name" to name,
            "path" to t.path,
            "is_dir" to dir,
            "ext" to ext,
            "size" to if (dir) 0L else f.length(),
            "mode" to mode,
            "mod_time" to Instant.ofEpochMilli(f.lastModified()).toString().replace(Regex("\\.\\d+Z$"), "Z"),
            "is_hidden" to name.startsWith("."),
            "is_system" to false,
        )
    }

    private fun children(dir: Target): List<Target> =
        (dir.file.listFiles()?.toList() ?: throw FsError("read directory failed: Android refused to list ${dir.name.ifEmpty { "storage" }} (is All files access still allowed?)"))
            .sortedWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
            .map { dir.child(it.name) }

    private fun list(dir: Target, showHidden: Boolean): Map<String, Any?> {
        if (!dir.file.exists()) throw FsError("${dir.name} does not exist")
        if (!dir.file.isDirectory) throw FsError("${dir.name} is not a folder")
        val shown = children(dir).filter { showHidden || !it.name.startsWith(".") }.take(MAX_LIST)
        val parent = if (dir.path == rootPath) "" else dir.path.substringBeforeLast('/')
        return linkedMapOf("op" to "list", "path" to dir.path, "parent_path" to parent, "entries" to shown.map { entry(it) })
    }

    private fun search(dir: Target, req: FsRequest): Map<String, Any?> {
        val q = req.query?.trim()?.lowercase().orEmpty()
        if (q.isEmpty()) throw FsError("search query is required")
        if (!dir.file.isDirectory) throw FsError("${dir.name} is not a folder")
        val hits = ArrayList<Target>()
        fun walk(d: Target, depth: Int) {
            if (hits.size >= MAX_SEARCH || depth > MAX_SEARCH_DEPTH) return
            if (d.path.removePrefix(rootPath).trimStart('/').startsWith("Android/", ignoreCase = true)) return
            for (c in (try { children(d) } catch (e: FsError) { return })) {
                if (hits.size >= MAX_SEARCH) return
                if (!req.showHidden && c.name.startsWith(".")) continue
                if (Files.isSymbolicLink(c.file.toPath())) continue
                if (c.path == "$rootPath/Android") continue
                if (c.name.lowercase().contains(q)) hits.add(c)
                if (c.file.isDirectory) walk(c, depth + 1)
            }
        }
        walk(dir, 1)
        return linkedMapOf("op" to "search", "path" to dir.path, "entries" to hits.map { entry(it) })
    }

    /** Every file and folder under [dir], folders before what they hold (links listed, not entered). */
    private fun walk(dir: Target, showHidden: Boolean): Map<String, Any?> {
        if (!dir.file.isDirectory) throw FsError("${dir.name} is not a folder")
        val out = ArrayList<Map<String, Any?>>()
        var files = 0
        var dirs = 0
        var bytes = 0L
        var truncated = false
        fun visit(d: Target, depth: Int): Boolean {
            if (d.path.removePrefix(rootPath).trimStart('/').startsWith("Android/", ignoreCase = true)) return true
            for (c in (try { children(d) } catch (e: FsError) { return true })) {
                if (!showHidden && c.name.startsWith(".")) continue
                if (c.path == "$rootPath/Android") continue
                if (out.size >= MAX_WALK) { truncated = true; return false }
                out.add(entry(c))
                val link = Files.isSymbolicLink(c.file.toPath())
                if (!c.file.isDirectory || link) {
                    if (!c.file.isDirectory) { files++; bytes += c.file.length() } else dirs++
                    continue
                }
                dirs++
                if (depth >= MAX_WALK_DEPTH) { truncated = true; continue }
                if (!visit(c, depth + 1)) return false
            }
            return true
        }
        visit(dir, 1)
        val m = linkedMapOf<String, Any?>("op" to "walk", "path" to dir.path, "entries" to out, "total_size" to bytes, "total_files" to files, "total_dirs" to dirs)
        if (truncated) m["truncated"] = true
        return m
    }

    private fun mkdir(t: Target): Map<String, Any?> {
        val f = t.file
        validName(f.name)
        if (f.exists()) throw FsError("${f.name} already exists")
        if (f.parentFile?.isDirectory != true) throw FsError("the folder to create it in does not exist")
        if (!f.mkdir()) throw FsError("mkdir failed: Android refused to create ${f.name}")
        return linkedMapOf("op" to "mkdir", "path" to t.path, "message" to "Created folder ${f.name}")
    }

    private fun touch(t: Target, dataB64: String?): Map<String, Any?> {
        val f = t.file
        validName(f.name)
        val content = dataB64?.let { decode(it) } ?: ByteArray(0)
        if (content.size > MAX_CHUNK) throw FsError("a new file can hold at most ${MAX_CHUNK / 1024} KiB")
        if (f.exists()) throw FsError("${f.name} already exists")
        if (f.parentFile?.isDirectory != true) throw FsError("the folder to create it in does not exist")
        if (!f.createNewFile()) throw FsError("${f.name} already exists")
        f.writeBytes(content)
        return linkedMapOf("op" to "touch", "path" to t.path, "message" to "Created file ${f.name}")
    }

    private fun rename(t: Target, newName: String?): Map<String, Any?> {
        val f = t.file
        val n = newName?.trim().orEmpty()
        validName(n)
        if (!f.exists()) throw FsError("${f.name} does not exist")
        val dstPath = t.path.substringBeforeLast('/') + "/" + n
        // The new name must stay a legal place (e.g. not create Android/… or a hidden escape).
        val dst = resolve(dstPath, mutating = true).file
        if (dst.exists()) throw FsError("$n already exists at the destination")
        if (!f.renameTo(dst)) throw FsError("rename failed: Android refused to rename ${f.name}")
        return linkedMapOf("op" to "rename", "path" to dstPath, "message" to "Renamed ${f.name} to $n")
    }

    private fun sources(req: FsRequest, mutating: Boolean): List<Target> {
        val raw = req.paths.ifEmpty { listOfNotNull(req.path) }
        if (raw.isEmpty()) throw FsError("no files were given")
        return raw.map { resolve(it, req, mutating) }
    }

    private fun copyOrMove(req: FsRequest): Map<String, Any?> {
        val move = req.op == "move"
        val srcs = sources(req, mutating = move)
        val target = resolve(req.targetPath, req, mutating = false)
        if (!target.file.isDirectory) throw FsError("the destination is not a folder")
        for (s in srcs) {
            if (!s.file.exists()) throw FsError("${s.name} does not exist")
            // Each destination is checked like any path written to (never into Android/…).
            val dst = resolve(target.child(s.name).path, req, mutating = true).file
            if (dst.exists()) throw FsError("${s.name} already exists at the destination")
            if (s.file.isDirectory && (target.path == s.path || target.path.startsWith(s.path + "/"))) throw FsError("a folder cannot be copied or moved into itself")
        }
        val budget = longArrayOf(MAX_COPY_BYTES)
        for (s in srcs) {
            val dst = File(target.file, s.name)
            if (move && s.file.renameTo(dst)) continue
            copyTree(s.file, dst, budget)
            if (move) deleteTree(s.file, intArrayOf(MAX_DELETE))
        }
        val verb = if (move) "Moved" else "Copied"
        return linkedMapOf("op" to req.op, "path" to target.path, "message" to "$verb ${srcs.size} item(s) to ${target.name.ifEmpty { "Internal storage" }}")
    }

    private fun copyTree(src: File, dst: File, budget: LongArray) {
        if (Files.isSymbolicLink(src.toPath())) throw FsError("${src.name} is a symbolic link and is not copied")
        if (src.isDirectory) {
            if (!dst.mkdir()) throw FsError("could not create ${dst.name}")
            for (c in src.listFiles() ?: emptyArray()) copyTree(c, File(dst, c.name), budget)
        } else {
            budget[0] -= src.length()
            if (budget[0] < 0) throw FsError("copies are limited to ${MAX_COPY_BYTES / 1_073_741_824} GiB at once")
            src.inputStream().use { i -> dst.outputStream().use { o -> i.copyTo(o, 64 * 1024) } }
            dst.setLastModified(src.lastModified())
        }
    }

    private fun delete(req: FsRequest): Map<String, Any?> {
        if (!req.confirmDestructive) throw FsError("deleting needs explicit confirmation")
        val targets = sources(req, mutating = true)
        val left = intArrayOf(MAX_DELETE)
        var n = 0
        for (t in targets) {
            if (!t.file.exists() && !Files.isSymbolicLink(t.file.toPath())) throw FsError("${t.name} does not exist")
            n += deleteTree(t.file, left)
        }
        return linkedMapOf("op" to "delete", "message" to "Deleted $n item(s)")
    }

    /** Deletes [f] (a folder with what it holds); a symbolic link is removed, never followed. */
    private fun deleteTree(f: File, left: IntArray): Int {
        var n = 0
        if (f.isDirectory && !Files.isSymbolicLink(f.toPath())) for (c in f.listFiles() ?: emptyArray()) n += deleteTree(c, left)
        if (--left[0] < 0) throw FsError("at most $MAX_DELETE items can be deleted at once")
        if (!f.delete()) throw FsError("delete failed: Android refused to delete ${f.name}")
        return n + 1
    }

    private fun download(t: Target, offset: Long, length: Long): Map<String, Any?> {
        val f = t.file
        if (!f.exists()) throw FsError("${f.name} does not exist")
        if (f.isDirectory) throw FsError("cannot download a directory directly")
        val size = f.length()
        val off = offset.coerceIn(0, size)
        val len = if (length <= 0 || length > MAX_CHUNK) MAX_CHUNK.toLong() else length
        val buf = ByteArray(minOf(len, size - off).toInt())
        RandomAccessFile(f, "r").use { r ->
            r.seek(off)
            r.readFully(buf)
        }
        val eof = off + buf.size >= size
        val m = linkedMapOf<String, Any?>(
            "op" to "download", "path" to t.path, "total_size" to size, "offset" to off, "bytes_read" to buf.size,
            "eof" to eof, "data_base64" to Base64.getEncoder().encodeToString(buf),
            "mod_time" to modTime(f),
            "chunk_sha256" to MessageDigest.getInstance("SHA-256").digest(buf).joinToString("") { "%02x".format(it) },
        )
        if (eof && size <= 32L * 1024 * 1024) m["sha256"] = sha256(f)
        return m
    }

    /** An upload this app started: where its next chunk begins, when, and the SHA-256 so far. */
    private class Tracked(val next: Long, val at: Long, val digest: MessageDigest?)

    private val uploads = HashMap<String, Tracked>()

    @Synchronized
    private fun tracked(p: String, offset: Long): Tracked? {
        val t = uploads[p] ?: return null
        return t.takeIf { it.next == offset && clock() - it.at < UPLOAD_TTL_MS }
    }

    private fun continues(p: String, offset: Long): Boolean = tracked(p, offset) != null

    @Synchronized
    private fun advance(p: String, next: Long, digest: MessageDigest?) {
        val now = clock()
        uploads.entries.removeIf { now - it.value.at > UPLOAD_TTL_MS }
        uploads[p] = Tracked(next, now, digest)
    }

    @Synchronized
    private fun forget(p: String) { uploads.remove(p) }

    private fun upload(t: Target, req: FsRequest): Map<String, Any?> {
        val f = t.file
        validName(f.name)
        val raw = decode(req.dataBase64 ?: "")
        if (raw.size > MAX_CHUNK * 2) throw FsError("upload chunk exceeds maximum permitted chunk size")
        val offset = req.offset
        if (offset < 0) throw FsError("upload offset must not be negative")
        val first = offset == 0L
        val exists = f.exists() || Files.isSymbolicLink(f.toPath())
        if (exists && (!Files.isRegularFile(f.toPath(), LinkOption.NOFOLLOW_LINKS))) throw FsError("${f.name} is a folder, link or special file and cannot be replaced by an upload")
        var overwritten = false
        when {
            first && !exists -> if (f.parentFile?.isDirectory != true) throw FsError("the folder to upload into does not exist") else if (!f.createNewFile()) throw FsError("$UPLOAD_TARGET_EXISTS: ${f.name} (confirm the overwrite to replace it)")
            first && !req.overwrite -> throw FsError("$UPLOAD_TARGET_EXISTS: ${f.name} (confirm the overwrite to replace it)")
            first -> overwritten = true
            !exists -> throw FsError("upload continuation refused: the file this upload started is missing")
            !continues(t.path, offset) -> throw FsError("upload continuation refused: no upload of ${f.name} started here at that offset")
            f.length() != offset -> throw FsError("upload continuation refused: the file is ${f.length()} bytes, the chunk starts at $offset")
        }
        // The running SHA-256 of the whole file, so the last chunk is checked without reading it again.
        val digest: MessageDigest? = if (first) MessageDigest.getInstance("SHA-256") else tracked(t.path, offset)?.digest?.let { d -> try { d.clone() as MessageDigest } catch (e: CloneNotSupportedException) { null } }
        try {
            RandomAccessFile(f, "rw").use { r ->
                if (overwritten) r.setLength(0)
                r.seek(offset)
                r.write(raw)
            }
        } catch (e: IOException) {
            forget(t.path)
            throw FsError("write failed: ${e.message}")
        }
        digest?.update(raw)
        advance(t.path, offset + raw.size, digest)
        var sum: String? = null
        val expected = req.expectedSha256?.trim()?.lowercase()
        if (!expected.isNullOrEmpty()) {
            val running = digest?.let { d -> try { (d.clone() as MessageDigest).digest().joinToString("") { "%02x".format(it) } } catch (e: CloneNotSupportedException) { null } }
            sum = running ?: sha256(f)
            if (sum != expected) {
                // A file that failed its check must not stay behind looking complete.
                forget(t.path)
                val note = if (f.delete()) "; the damaged file was removed, send it again" else ""
                throw FsError("upload checksum mismatch: expected $expected, got $sum$note")
            }
        }
        val msg = if (overwritten) "Overwrote ${f.name} with ${raw.size} bytes (operator-confirmed)" else "Uploaded ${raw.size} bytes to ${f.name}"
        val m = linkedMapOf<String, Any?>("op" to "upload", "path" to t.path, "total_size" to f.length(), "offset" to offset, "bytes_read" to raw.size, "message" to msg, "overwritten" to overwritten)
        if (sum != null) m["sha256"] = sum
        return m
    }

    private fun hash(t: Target, sizeOnly: Boolean): Map<String, Any?> {
        val f = t.file
        if (!Files.isRegularFile(f.toPath(), LinkOption.NOFOLLOW_LINKS)) throw FsError("only a regular file can be checked")
        val size = f.length()
        val m = linkedMapOf<String, Any?>("op" to "hash", "path" to t.path, "total_size" to size, "mod_time" to modTime(f))
        if (!sizeOnly) m["sha256"] = sha256(f)
        if (continues(t.path, size)) m["upload_next"] = size
        return m
    }

    private fun modTime(f: File): String = Instant.ofEpochMilli(f.lastModified()).toString()

    private fun decode(b64: String): ByteArray = try { Base64.getDecoder().decode(b64) } catch (e: IllegalArgumentException) { throw FsError("invalid base64 payload") }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { i ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = i.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val MAX_PATH = 1024
        const val MAX_CHUNK = 1024 * 1024
        const val MAX_WALK = 10_000
        const val MAX_WALK_DEPTH = 32
        /** How long an interrupted upload can wait to be continued. */
        const val UPLOAD_TTL_MS = 72L * 3_600_000
        const val MAX_LIST = 1500
        const val MAX_SEARCH = 250
        const val MAX_SEARCH_DEPTH = 6
        const val MAX_DELETE = 10_000
        const val MAX_COPY_BYTES = 4L * 1_073_741_824
        /** The web console looks for this text (filemgr.ErrUploadTargetExists). */
        const val UPLOAD_TARGET_EXISTS = "upload target already exists"

        fun validName(n: String) {
            if (n.isEmpty() || n.length > 255) throw FsError("a name must have 1 to 255 characters")
            if (n == "." || n == ".." || n.contains('/') || n.contains('\u0000') || n.contains('\\')) throw FsError("'$n' is not a valid name")
        }
    }
}
