package com.nigafiy.agent.core

import java.net.URLEncoder
import java.util.Base64

/**
 * File transfer bytes apart from the commands (docs/roadmap/2026-11-28-file-transfer-speed.md), as
 * the Windows agent does (internal/agent/filerelay.go). The server sends an upload piece as
 * `data_ref` (fetched here, raw) instead of base64 inside the command, and a download asked with
 * `relay` sends its bytes to the server raw before the result, which then carries `relayed` and the
 * checks but no bytes. The server does this only for agents that list [FEATURE] in their poll; if
 * sending a download's bytes fails, the result carries them as base64 as before.
 */
object FileRelay {
    const val FEATURE = "fs_relay"
    val FEATURES = listOf(FEATURE)

    /** The server's limit: an upload piece is at most 2 MiB. */
    const val MAX_PIECE = 2 shl 20

    /** The start of the error that makes the web send the piece again (fs-client.ts). */
    const val MISSING = "relay piece missing: "

    /** An upload by reference becomes an ordinary upload with its bytes; other requests are unchanged. */
    fun resolve(req: FsRequest, gateway: Gateway): FsRequest {
        val ref = req.dataRef ?: return req
        if (req.op != "upload") return req
        val data = try {
            gateway.getBytes("/api/v1/agent/file-data/" + URLEncoder.encode(ref, "UTF-8").replace("+", "%20"))
        } catch (e: Exception) {
            throw FsError(MISSING + (e.message ?: e.javaClass.simpleName))
        }
        if (req.dataLen != null && req.dataLen != data.size.toLong()) {
            throw FsError("${MISSING}got ${data.size} bytes, expected ${req.dataLen}")
        }
        return req.copy(dataRef = null, dataLen = null, dataBase64 = Base64.getEncoder().encodeToString(data))
    }

    /**
     * After a download asked with `relay`: sends the bytes to the server and returns the result
     * without them (marked `relayed`); on any failure returns [res] unchanged (bytes inside).
     */
    fun send(commandId: String, req: FsRequest, res: Map<String, Any?>, gateway: Gateway): Map<String, Any?> {
        if (!req.relay || req.op != "download") return res
        val b64 = res["data_base64"] as? String
        if (b64.isNullOrEmpty()) return res
        val data = try { Base64.getDecoder().decode(b64) } catch (e: IllegalArgumentException) { return res }
        if (data.size > MAX_PIECE) return res
        return try {
            gateway.postBytes("/api/v1/agent/file-data?command_id=" + URLEncoder.encode(commandId, "UTF-8"), data)
            LinkedHashMap(res).apply {
                remove("data_base64")
                put("relayed", true)
            }
        } catch (e: Exception) {
            res
        }
    }
}
