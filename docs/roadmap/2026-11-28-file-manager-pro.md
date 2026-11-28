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
  (3000/min) so transfers do not starve the dashboard; download `length` up to 1 MiB; new op
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

## Not in this round

- A binary streaming channel agent ↔ server (would beat base64-over-commands on speed).
- Server-side background copies that survive closing the browser.
