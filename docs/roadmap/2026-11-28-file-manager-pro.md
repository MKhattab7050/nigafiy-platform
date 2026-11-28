# File manager, professional round (2026-11-28)

Owner: "the Fleet file manager is missing a lot: I can't download a whole folder to my PC or from
one device to another; it isn't professional." Owner said: do all of it.

## What was wrong (found in the code)

1. **Uploads over ~75 KB failed.** The user API parses JSON up to 100 KB; an upload chunk
   (256 KiB → ~350 KB of base64) got 413. Proven by `apps/api/tests/file-transfer.test.ts`.
2. No folder download, no multi-file download (button only on files).
3. No folder upload (picker takes files; dropped folders were not walked).
4. No device → device copy: download to the browser, upload again by hand.
5. Downloads were held whole in browser memory before saving (GB files crash the tab).
6. Slow: 256 KiB per command round trip, one transfer at a time; the shared API limiter
   (600 requests/min) also caps a transfer.
7. No breadcrumbs, context menu, keyboard shortcuts, double-click, preview, properties, folder
   size, drag between panes, range select, sort direction.

## What we build (all through the existing `fs_op` command; same roles, policy roots, protected
paths, session profiles and audit as before)

- **API**: commands route takes bodies up to 2 MB (others keep 100 KB); its own limiter
  (6000/min) so transfers do not starve the dashboard; download `length` up to 1 MiB; new op
  `walk` (read-only, technician, same guards as `list`).
- **Agents** (Windows/Linux/macOS Go + Android): `walk` = every file and folder under a folder
  (no links entered, credential stores skipped, ≤ 10 000 entries, ≤ 32 levels, `truncated` when
  cut) with totals; download chunk 1 MiB (upload already allowed 1 MiB).
- **Web transfers**: 1 MiB chunks, 3 transfers at once, downloads with 3 chunks in flight.
  Downloads go **straight to disk** where the browser can (Chrome/Edge: File System Access) —
  the operator picks a folder once and files/folders are written there with their tree; else a
  single file is saved as before and several files/folders are saved as one **ZIP** (store,
  ZIP64, streamed). Folder upload (picker + drag-drop of folders): the tree is created first,
  then files are queued; an existing file asks "Replace / Skip" with "apply to all".
- **Device → device**: the left pane can be "This browser" or another computer/phone of the
  organization. Copy between the two panes (button, drag-drop) relays chunk by chunk through
  the browser (download from A, upload to B, nothing kept whole), SHA-256 checked on both sides.
  Same rules as doing it by hand: technician to read A, admin to write B, each device's policy
  and session profile apply to its own commands. The browser has to stay open; a server-side
  background copy is a later step if needed.
- **UX**: breadcrumbs, double-click to open, right-click menu, keyboard (Enter, Backspace,
  Del, F2, F5, Ctrl+A/C/X/V), shift-click range select, sort asc/desc, status bar (count,
  selected size), preview (images, text ≤ 1 MiB), properties (folder size via walk), download
  button on folders and on the selection.

## Very large files: a transfer must not die midway (owner, mid-task)

- **Retries forever, never starts over.** A lost connection, an offline device, a server restart
  or a rate limit marks the job "Waiting for the connection" and retries (1 s doubling to 30 s,
  at once when the browser is back online). It continues from the last byte that really arrived.
  A request the device has not taken after 20 s counts as "device gone" at once, not after 90 s.
- **The receiver remembers.** The agent keeps each unfinished upload (path, next offset, running
  SHA-256 state) in `<state dir>/file-uploads.json` for 72 h, so an agent or PC restart resumes
  too. `hash` with `size_only` answers size, time and the resume point without reading the file.
- **The browser remembers.** Jobs and their folder/file handles are kept in IndexedDB
  (`nigafiy-transfers`). After a reload, copies between devices resume by themselves; uploads from
  this computer resume after one click (the browser asks again for the folder permission).
  Downloads to a folder restart that one file (the browser commits a file only when it closes).
- **Checked end to end.** Every downloaded chunk carries its own SHA-256 and the file's time; a
  changed source stops the job ("the file changed while copying") instead of mixing two versions.
  The receiving agent checks the whole-file SHA-256 on the last chunk and deletes a file that
  fails it (it never stays behind looking complete).
- **No noise, no bloat.** Only the start and the end of a transfer are audited. The middle pieces
  are transport: their rows are deleted 10 minutes later (heartbeat sweep), and bytes nobody
  collected are dropped. The screen is kept awake and leaving the page warns while a transfer runs.

## Tested (2026-11-28)

- `apps/api/tests/real-agent-transfer.test.ts` (opt-in `NIGAFIY_UI_TEST=1`, real Windows agent):
  24 MiB in 1 MiB pieces, agent killed and restarted at 10 MiB, resumed and verified; a wrong
  final checksum is refused and the file removed; `walk` of a tree; download with per-chunk checks.
- In the browser, isolated stack with two real agents: folder + 700 MB file copied device A →
  device B while device B's agent was killed and restarted and the page was reloaded: all files
  byte-identical (SHA-256), empty folder and an Arabic file name kept. Folder download to a folder
  and as ZIP (10 entries, all CRCs right).
- Measured on one PC (loopback): a command round trip is ~13 ms, a 1 MiB piece ~150–250 ms because
  its bytes pass through PostgreSQL as base64 JSON. Device → device copy ≈ 1.5–3.5 MB/s.

## Not in this round

- A binary streaming channel agent ↔ server that keeps the bytes out of PostgreSQL. This is the
  speed step (the measured limit above); proposed to the owner as the next round.
- Server-side background copies that survive closing the browser.
