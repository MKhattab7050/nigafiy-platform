# File transfers, speed round (2026-11-28)

Follows `2026-11-28-file-manager-pro.md`, which made very large transfers reliable but measured
1.5–3.5 MB/s between two devices. Owner: "do it" (the speed step).

## Why it was slow (measured)

1. **The agent gateway's rate limit.** `/api/v1/agent` allows 360 requests a minute per IP address.
   A transfer costs two agent requests per 1 MiB piece (take the command, send the result), so one
   agent is capped near 3 MB/s, and two agents behind one address (or on one PC) near 1.5 MB/s:
   exactly the speed seen in the browser test.
2. **The bytes go through PostgreSQL as base64 JSON.** An upload piece is stored in
   `endpoint_commands.payload` and a download piece in `result_data` (1.4 MB of text each, written
   to the WAL, then rewritten to strip it): ~150–250 ms per MiB.

## What changes

- **Transfer traffic gets its own limit.** Agent requests that move a transfer (`/poll`,
  `/command-result`, `/file-data…`) are counted per agent credential (6000 a minute) and per IP
  address (12 000 a minute) instead of the shared 360. Everything else (enroll, heartbeat,
  inventory…) keeps the 360 per IP.
- **A binary side channel for the bytes.** The command (path, offset, checks, audit, roles, policy
  and session profile) still goes through `endpoint_commands`; only the bytes move apart:
  - Upload: the browser sends the piece as `application/octet-stream` to
    `POST /api/v1/endpoints/:id/file-data` (admin, ≤ 2 MiB) and gets an id; the `upload` command
    carries `data_ref` instead of `data_base64`. The agent fetches the bytes from
    `GET /api/v1/agent/file-data/:ref` and writes them.
  - Download: the browser adds `relay: true`. The agent sends the piece to
    `POST /api/v1/agent/file-data?command_id=…` and its result carries `relayed: true` plus the
    size and the chunk's SHA-256, no bytes. The browser fetches
    `GET /api/v1/endpoints/:id/commands/:cid/data` (only the operator who asked).
  - The bytes wait in an **unlogged** table (`file_relay`, `bytea`, no WAL, no base64), so every API
    instance sees them. A piece is deleted when it is read (download) or when its command ends
    (upload), and anything left is swept after 10 minutes.
- **Old agents keep working.** A new agent says so in its command poll (`features: ["fs_relay"]`,
  kept in `endpoints.agent_features`). For an agent that did not, the API strips `relay` from a
  download and puts the stored bytes back into the upload command as `data_base64` (the old path).
  A new agent whose relay upload fails falls back to base64 in the result. The Android agent does
  the same from 1.0.10 (`core/FileRelay.kt`); Quick Support stays on the old path.
- Integrity checks are unchanged: per-chunk SHA-256, source time and size, final SHA-256 on the
  receiver.

## Target

On one PC (loopback), measured by `apps/api/tests/real-agent-transfer.test.ts`: at least 20 MB/s
for a one-piece-at-a-time download, against ~7 MB/s before (test limits) and 1.5–3 MB/s in real use.

## Result (measured 2026-11-28, one PC, loopback)

`apps/api/tests/real-agent-transfer.test.ts` with the rebuilt Windows agent, 24 MiB in 1 MiB
pieces, three runs:

| Path | Speed |
| --- | --- |
| Old path (base64 inside the command), one piece at a time | 7.1–7.3 MB/s |
| Side channel, download, one piece at a time | 17–18.3 MB/s |
| Side channel, upload, one piece at a time | 13.7–16.3 MB/s |
| Side channel, download, three pieces in flight (as the web engine reads) | **23.7–24.3 MB/s** |

The test fails if the three-in-flight download is under 20 MB/s, or if the side channel is not
faster than the old path. Real use was further capped by the 360/min limit, which no longer applies
to transfers, so the gain between two devices on a home network should be larger than these
numbers show; that is not measured yet.

What is covered by tests:

- API (`apps/api/tests/file-transfer.test.ts`): only an admin sends an upload piece, at most 2 MiB,
  for an endpoint of their own organization; an old agent gets the bytes inside the command and
  `relay` is removed; an agent that announced `fs_relay` keeps `data_ref`, another device cannot
  read the piece, a used reference is refused, the download piece is read once and only by the
  organization that asked, a finished download takes no more bytes; leftovers are swept after
  10 minutes.
- Agent (`internal/agent/filerelay_test.go`): fetches an upload piece with its credential and
  refuses a short or missing one before writing; sends a download piece apart and falls back to
  base64 when the server refuses it; leaves other commands alone.

To benefit, PCs and phones need the new agent (release 1.0.10). Quick Support and older agents keep
the old path, which still works. Phone side tested in `core/src/test/.../FileRelayTest.kt` (the poll
announces `fs_relay`; an upload piece is fetched and checked before writing; a download piece is
sent apart and stays in the result if the server refuses it).

## In the browser (measured 2026-11-28, one PC, isolated stack)

The first real-UI copy after the side channel ran at only 4.3 MB/s (700 MB in 170 s, in the
Claude browser pane), far under the test's 24 MB/s. The server path was not the cause: the same
copy driven from Node through the API ran at 15 MB/s steadily, and through the web server's `/api`
proxy from Node a 1 MiB piece costs the same 18 ms as direct. The browser itself costs more: in
plain Chromium a 1 MiB piece takes ~45 ms to send or fetch (most of it handing the body to the
browser's network process), and the browser pane, which records traffic, is slower still.

The engine paid that cost twice per piece in a row: send the bytes, then run the write command,
then the next piece. **Change:** only the write commands must go in order (the device appends), so
the next piece's bytes now go up while the previous piece is being written
(`orderedWriter` in `transfer-engine.ts`, `fsStage` in `fs-client.ts`), for device→device copies
and uploads from this computer. Copies also read three pieces ahead instead of two. The first
piece is still written alone (it may meet an existing file and be sent again after asking).

Real file manager, 700 MB A→B, plain Chromium (Playwright), same file and stack:

| Engine | Time | Speed |
| --- | --- | --- |
| Before (bytes, then command, per piece) | 111.5 s | 6.6 MB/s, dips to 4.8 |
| After (bytes overlap the previous write) | 87.9 s | 8.3 MB/s, steady 8.3–9.1 |
| After, agent B killed at 250 MiB and restarted 5 s later | 105.7 s | resumed, finished |

Upload from this computer (700 MB): ~76 s, about 9.6 MB/s. Every run ended byte-identical
(same SHA-256 as the source) and "SHA-256 verified by the receiving device". In the browser pane
the copy went from 170 s to 118 s.

Everything here ran on one PC (browser, web server, API, database and both agents share the CPU),
so these are a floor, not what two real PCs on a home network will see. The next limit is the
write command's round trip (~60–70 ms per 1 MiB piece); 2 MiB write pieces would halve it, but old
agents and phones get the bytes inlined in the command at a 1 MiB limit, so that needs the web to
know the device's features first. Not done.
