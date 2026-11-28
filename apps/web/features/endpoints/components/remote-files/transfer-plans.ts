import type { RemoteFileEntry } from '@nigafiy/shared-types';
import { fsCall, toFsError } from './fs-client';
import { type ConflictPolicy, type Job, type RemoteRef, type ZipEntry, joinRemote, relPath, transfers, MEMORY_WARN_BYTES } from './transfer-engine';

// Turns what the operator picked (files and folders on a device, files and folders on this
// computer) into transfers. Folders are expanded with the agent's `walk` (one command for up to
// 10 000 entries; older agents: folder by folder with `list`) and recreated first on the receiving
// side, so empty folders come along too.

type PickerWindow = Window & {
  showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (o?: object) => Promise<FileSystemFileHandle>;
};
const win = () => (typeof window === 'undefined' ? undefined : (window as PickerWindow));

/** Chrome and Edge: files and folders are written straight to disk, any size. */
export const canWriteToDisk = () => Boolean(win()?.showDirectoryPicker && win()?.showSaveFilePicker);

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
type Add = Omit<Job, 'id' | 'done' | 'state' | 'attempts'>;
const newGroup = () => `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export interface WalkResult {
  entries: RemoteFileEntry[];
  truncated: boolean;
}

/** Every file and folder under `path` on a device (folders before their contents). */
export async function walkRemote(ref: RemoteRef, path: string, showHidden: boolean): Promise<WalkResult> {
  try {
    const r = await fsCall(ref.endpointId, { op: 'walk', path, show_hidden: showHidden }, { deadlineMs: 5 * 60_000 });
    return { entries: r.entries ?? [], truncated: Boolean(r.truncated) };
  } catch (err) {
    const e = toFsError(err);
    if (!/unsupported file manager operation|unknown file operation|invalid_enum_value|Invalid enum/i.test(e.message)) throw e;
  }
  // An agent without walk: folder by folder.
  const out: RemoteFileEntry[] = [];
  const queue = [path];
  let truncated = false;
  while (queue.length) {
    const dir = queue.shift()!;
    const r = await fsCall(ref.endpointId, { op: 'list', path: dir, show_hidden: showHidden });
    for (const e of r.entries ?? []) {
      if (out.length >= 10_000) {
        truncated = true;
        break;
      }
      out.push(e);
      if (e.is_dir) queue.push(e.path);
    }
    if (truncated) break;
  }
  return { entries: out, truncated };
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  for (const get of [() => dir.getFileHandle(name), () => dir.getDirectoryHandle(name)]) {
    try {
      await get();
      return true;
    } catch {
      /* not this kind */
    }
  }
  return false;
}

/** "Report.pdf" → "Report (1).pdf" while a file or folder of that name is already there. */
async function freeName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  if (!(await exists(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; i < 1000; i++) {
    const n = `${base} (${i})${ext}`;
    if (!(await exists(dir, n))) return n;
  }
  return `${base} (${Date.now()})${ext}`;
}

async function localFolder(dir: FileSystemDirectoryHandle, rel: string) {
  let d = dir;
  for (const p of rel.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create: true });
}

export interface PlanResult {
  /** The operator closed the picker. */
  cancelled?: boolean;
  /** Folder walks stopped at 10 000 entries. */
  truncated?: boolean;
  /** A ZIP or file kept in memory is large (browsers without File System Access). */
  memoryWarning?: boolean;
  files: number;
  bytes: number;
}

/**
 * Downloads files and folders of a device to this computer: into a folder the operator picks
 * (each item keeps its name and tree), or one ZIP (`asZip`, or several items on a browser that
 * cannot write folders), or a single file saved by the browser.
 */
export async function downloadItems(ref: RemoteRef, items: RemoteFileEntry[], opts: { asZip?: boolean; showHidden: boolean; label: string }): Promise<PlanResult> {
  const w = win();
  const many = items.length > 1 || items.some((i) => i.is_dir);
  const zip = opts.asZip || (many && !canWriteToDisk());
  if (zip) {
    const name = `${items.length === 1 ? items[0]!.name : `${ref.device}-files`}.zip`.replace(/[\\/:*?"<>|]/g, '_');
    let save: FileSystemFileHandle | undefined;
    if (w?.showSaveFilePicker) {
      try {
        save = await w.showSaveFilePicker({ suggestedName: name, id: 'nigafiy-downloads', startIn: 'downloads', types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] });
      } catch (e) {
        if (isAbort(e)) return { cancelled: true, files: 0, bytes: 0 };
        throw e;
      }
    }
    const entries: ZipEntry[] = [];
    let truncated = false;
    for (const it of items) {
      if (!it.is_dir) {
        entries.push({ path: it.path, rel: it.name, size: it.size, mod: it.mod_time, dir: false });
        continue;
      }
      const t = await walkRemote(ref, it.path, opts.showHidden);
      truncated ||= t.truncated;
      entries.push({ path: it.path, rel: it.name, size: 0, mod: it.mod_time, dir: true });
      for (const e of t.entries) entries.push({ path: e.path, rel: `${it.name}/${relPath(it.path, e.path)}`, size: e.is_dir ? 0 : e.size, mod: e.mod_time, dir: e.is_dir });
    }
    const bytes = entries.reduce((n, e) => n + e.size, 0);
    transfers.add([
      {
        group: newGroup(),
        groupLabel: opts.label,
        name,
        size: bytes,
        src: { kind: 'remote', endpointId: ref.endpointId, device: ref.device, path: items[0]?.path ?? '' },
        dst: save ? { kind: 'save', handle: save } : { kind: 'memory' },
        zip: { entries, index: 0 },
        persist: false,
      },
    ]);
    return { truncated, memoryWarning: !save && bytes > MEMORY_WARN_BYTES, files: entries.filter((e) => !e.dir).length, bytes };
  }

  if (!canWriteToDisk()) {
    // One file, kept in memory and saved by the browser at the end.
    const it = items[0]!;
    transfers.add([{ group: newGroup(), groupLabel: opts.label, name: it.name, size: it.size, src: { kind: 'remote', ...ref, path: it.path }, dst: { kind: 'memory' }, persist: false }]);
    return { memoryWarning: it.size > MEMORY_WARN_BYTES, files: 1, bytes: it.size };
  }

  let dir: FileSystemDirectoryHandle;
  try {
    dir = await w!.showDirectoryPicker!({ id: 'nigafiy-downloads', mode: 'readwrite', startIn: 'downloads' });
  } catch (e) {
    if (isAbort(e)) return { cancelled: true, files: 0, bytes: 0 };
    throw e;
  }
  const group = newGroup();
  const jobs: Add[] = [];
  let truncated = false;
  for (const it of items) {
    const top = await freeName(dir, it.name);
    if (!it.is_dir) {
      // Reserve the name now, so two items with one name do not meet.
      await dir.getFileHandle(top, { create: true });
      jobs.push({ group, groupLabel: opts.label, name: it.name, size: it.size, src: { kind: 'remote', ...ref, path: it.path }, dst: { kind: 'disk', dir, rel: top, dirLabel: dir.name }, persist: true });
      continue;
    }
    const t = await walkRemote(ref, it.path, opts.showHidden);
    truncated ||= t.truncated;
    await localFolder(dir, top);
    for (const e of t.entries) {
      const rel = `${top}/${relPath(it.path, e.path)}`;
      if (e.is_dir) await localFolder(dir, rel);
      else jobs.push({ group, groupLabel: opts.label, name: e.name, size: e.size, src: { kind: 'remote', ...ref, path: e.path }, dst: { kind: 'disk', dir, rel, dirLabel: dir.name }, persist: true });
    }
  }
  transfers.add(jobs);
  return { truncated, files: jobs.length, bytes: jobs.reduce((n, j) => n + j.size, 0) };
}

/** A file or folder on this computer: a File (picker, drop) or a handle (kept across a reload). */
export interface LocalItem {
  rel: string;
  file?: File;
  handle?: FileSystemFileHandle;
  size: number;
}

export interface LocalSelection {
  files: LocalItem[];
  /** Folders to create (relative, forward slashes), including empty ones. */
  dirs: string[];
}

async function fromDirectoryHandle(d: FileSystemDirectoryHandle, prefix: string, out: LocalSelection) {
  out.dirs.push(prefix);
  const it = (d as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values();
  for await (const h of it) {
    const rel = `${prefix}/${h.name}`;
    if (h.kind === 'directory') await fromDirectoryHandle(h as FileSystemDirectoryHandle, rel, out);
    else {
      const fh = h as FileSystemFileHandle;
      out.files.push({ rel, handle: fh, size: (await fh.getFile()).size });
    }
  }
}

function readEntries(r: { readEntries: (ok: (e: FileSystemEntry[]) => void, err: (e: unknown) => void) => void }): Promise<FileSystemEntry[]> {
  return new Promise((ok, err) => r.readEntries(ok, err));
}

async function fromEntry(e: FileSystemEntry, prefix: string, out: LocalSelection) {
  const rel = prefix ? `${prefix}/${e.name}` : e.name;
  if (e.isDirectory) {
    out.dirs.push(rel);
    const reader = (e as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const c of batch) await fromEntry(c, rel, out);
    }
  } else {
    const file = await new Promise<File>((ok, err) => (e as FileSystemFileEntry).file(ok, err));
    out.files.push({ rel, file, size: file.size });
  }
}

/** What was dropped: files and whole folders (Chrome/Edge keep handles, so the upload can continue after a reload). */
export async function fromDrop(dt: DataTransfer): Promise<LocalSelection> {
  const out: LocalSelection = { files: [], dirs: [] };
  const items = Array.from(dt.items).filter((i) => i.kind === 'file');
  const withHandle = items.map((i) => (i as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.());
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const files = items.map((i) => i.getAsFile());
  for (let k = 0; k < items.length; k++) {
    const h = withHandle[k] ? await withHandle[k] : null;
    if (h?.kind === 'directory') await fromDirectoryHandle(h as FileSystemDirectoryHandle, h.name, out);
    else if (h?.kind === 'file') {
      const fh = h as FileSystemFileHandle;
      out.files.push({ rel: h.name, handle: fh, size: (await fh.getFile()).size });
    } else if (entries[k]) await fromEntry(entries[k]!, '', out);
    else if (files[k]) out.files.push({ rel: files[k]!.name, file: files[k]!, size: files[k]!.size });
  }
  return out;
}

/** Files from an <input type=file> (with webkitdirectory: their folder paths). */
export function fromInput(list: FileList | File[]): LocalSelection {
  const out: LocalSelection = { files: [], dirs: [] };
  const dirs = new Set<string>();
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    out.files.push({ rel, file: f, size: f.size });
  }
  out.dirs = [...dirs];
  return out;
}

/** The folder picker of Chrome/Edge (handles: an upload continues after a reload). */
export async function pickLocalFolder(): Promise<LocalSelection | null> {
  const w = win();
  if (!w?.showDirectoryPicker) return null;
  try {
    const d = await w.showDirectoryPicker({ id: 'nigafiy-uploads', mode: 'read' });
    const out: LocalSelection = { files: [], dirs: [] };
    await fromDirectoryHandle(d, d.name, out);
    return out;
  } catch (e) {
    if (isAbort(e)) return { files: [], dirs: [] };
    throw e;
  }
}

/** Creates folders on a device, parents first; a folder that is already there is fine. */
async function makeRemoteDirs(ref: RemoteRef, base: string, rels: string[]) {
  const sorted = [...new Set(rels.filter(Boolean))].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const rel of sorted) {
    try {
      await fsCall(ref.endpointId, { op: 'mkdir', path: joinRemote(base, rel) });
    } catch (err) {
      if (!/already exists/i.test(toFsError(err).message)) throw err;
    }
  }
}

/** Uploads files and folders of this computer into `dir` on a device. */
export async function uploadItems(ref: RemoteRef, dir: string, sel: LocalSelection, label: string, policy: ConflictPolicy = 'ask'): Promise<PlanResult> {
  await makeRemoteDirs(ref, dir, sel.dirs);
  const group = newGroup();
  transfers.add(
    sel.files.map((f) => ({
      group,
      groupLabel: label,
      name: f.rel.split('/').pop() ?? f.rel,
      size: f.size,
      src: { kind: 'local' as const, file: f.file, handle: f.handle },
      dst: { kind: 'remote' as const, ...ref, path: joinRemote(dir, f.rel) },
      persist: Boolean(f.handle),
    })),
    policy,
  );
  return { files: sel.files.length, bytes: sel.files.reduce((n, f) => n + f.size, 0) };
}

/** Copies files and folders from one device into `dir` on another, chunk by chunk through this page. */
export async function copyItems(src: RemoteRef, items: RemoteFileEntry[], dst: RemoteRef, dir: string, opts: { showHidden: boolean; label: string }): Promise<PlanResult> {
  const group = newGroup();
  const jobs: Add[] = [];
  const dirs: string[] = [];
  let truncated = false;
  for (const it of items) {
    if (!it.is_dir) {
      jobs.push({ group, groupLabel: opts.label, name: it.name, size: it.size, src: { kind: 'remote', ...src, path: it.path }, dst: { kind: 'remote', ...dst, path: joinRemote(dir, it.name) }, persist: true });
      continue;
    }
    const t = await walkRemote(src, it.path, opts.showHidden);
    truncated ||= t.truncated;
    dirs.push(it.name);
    for (const e of t.entries) {
      const rel = `${it.name}/${relPath(it.path, e.path)}`;
      if (e.is_dir) dirs.push(rel);
      else jobs.push({ group, groupLabel: opts.label, name: e.name, size: e.size, src: { kind: 'remote', ...src, path: e.path }, dst: { kind: 'remote', ...dst, path: joinRemote(dir, rel) }, persist: true });
    }
  }
  await makeRemoteDirs(dst, dir, dirs);
  transfers.add(jobs);
  return { truncated, files: jobs.length, bytes: jobs.reduce((n, j) => n + j.size, 0) };
}

/** Bytes of a folder (properties): from one walk. */
export async function folderSize(ref: RemoteRef, path: string, showHidden: boolean) {
  const r = await fsCall(ref.endpointId, { op: 'walk', path, show_hidden: showHidden }, { deadlineMs: 5 * 60_000 });
  return { bytes: r.total_size ?? 0, files: r.total_files ?? 0, dirs: r.total_dirs ?? 0, truncated: Boolean(r.truncated) };
}
