import type { RemoteFileResponse } from '@nigafiy/shared-types';
import { FsError, type FsResult, fsCall, fsRead, fsStage, fsWrite, toFsError } from './fs-client';
import { Sha256, type Sha256State } from './sha256';
import { joinRemote, relPath } from './paths';
import { transferStore } from './transfer-store';
import { MemoryZipSink, ZipWriter, type ZipSink } from './zip-writer';

/*
 * The transfer engine (one per browser tab, outside React, so a transfer keeps running while the
 * operator moves to another page of the console). Built for very large files:
 *
 *  - 1 MiB chunks; downloads keep 3 chunks in flight; 3 transfers run at once.
 *  - Nothing is held whole in memory: a download is written straight to a file or folder the
 *    operator picked (File System Access, Chrome/Edge); without it a single file or a ZIP is
 *    assembled in memory (fine for a few hundred MB, the console says so for larger ones).
 *  - A lost connection, a server timeout, a device that went offline or restarted never fails a
 *    transfer: it waits and retries by itself (1 s, 2 s, 4 s … every 30 s, for as long as it
 *    takes), and continues from the last byte that arrived. The agent keeps its side of an upload
 *    across its own restarts (filemgr.SetStateDir), so an upload or device-to-device copy also
 *    continues after this page was closed; a download into a folder starts that file again.
 *  - Integrity: every downloaded chunk is checked against the SHA-256 the agent computed of it,
 *    the source must keep the same size and modification time from the first chunk to the last,
 *    and the receiving agent checks the whole file's SHA-256 before an upload or copy counts.
 *
 * Every chunk is an fs_op command: the same roles, policy roots, protected paths, session profile
 * and audit as before (the API audits the start and the end of each transfer).
 */

export const CHUNK = 1024 * 1024;
const PIPELINE = 3;
const PARALLEL = 3;
const MAX_BACKOFF_MS = 30_000;
/** Old agents send no chunk checksums: their whole-file checksum is compared up to this size. */
const FULL_HASH_LIMIT = 8 * 1024 * 1024 * 1024;
export const MEMORY_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;
/** The agent's refusal when an upload target exists (filemgr.ErrUploadTargetExists). */
export const UPLOAD_TARGET_EXISTS = 'upload target already exists';

export interface RemoteRef {
  endpointId: string;
  device: string;
}

export type Place =
  | ({ kind: 'remote'; path: string } & RemoteRef)
  | { kind: 'local'; file?: File; handle?: FileSystemFileHandle }
  | { kind: 'disk'; dir: FileSystemDirectoryHandle; rel: string; dirLabel: string }
  | { kind: 'save'; handle: FileSystemFileHandle }
  | { kind: 'memory' };

export interface ZipEntry {
  path: string;
  rel: string;
  size: number;
  mod?: string;
  dir: boolean;
}

export type JobState = 'queued' | 'running' | 'waiting' | 'paused' | 'interrupted' | 'verifying' | 'done' | 'failed' | 'cancelled' | 'skipped';
export type ConflictPolicy = 'ask' | 'replace' | 'skip';

export interface Job {
  id: string;
  group: string;
  groupLabel: string;
  name: string;
  size: number;
  done: number;
  src: Place;
  dst: Place;
  state: JobState;
  error?: string;
  /** Why it waits: shown with the countdown. */
  note?: string;
  retryAt?: number;
  attempts: number;
  sha256?: string;
  /** chunks: every chunk checked + unchanged source; receiver: whole file checked by the receiving agent; full: both whole-file checksums compared. */
  verified?: 'chunks' | 'receiver' | 'full';
  /** Remote destination: the operator confirmed replacing an existing file. */
  overwrite?: boolean;
  /** Remote source identity seen at the first chunk. */
  srcMod?: string;
  srcSize?: number;
  /** Upload/copy: running SHA-256 of bytes 0..hashedTo of the source. */
  hash?: Sha256State;
  hashedTo?: number;
  /** Saved result of an in-memory download. */
  url?: string;
  zip?: { entries: ZipEntry[]; index: number };
  startedAt?: number;
  finishedAt?: number;
  bytesPerSec?: number;
  persist: boolean;
  /** A chunk came without the agent's checksum (an older agent): the whole file is compared instead. */
  unchecked?: boolean;
}

export interface Prompt {
  id: string;
  kind: 'overwrite' | 'restart';
  job: Job;
  existingSize?: number;
  resolve: (answer: { replace: boolean; all: boolean }) => void;
}

export interface Snapshot {
  jobs: Job[];
  prompts: Prompt[];
}

interface Internals {
  writer?: FileSystemWritableFileStream;
  chunks?: Uint8Array[];
  zip?: { writer: ZipWriter; sink: ZipSink & { close?: () => Promise<void> }; entryDone: number; begun: boolean; memory?: MemoryZipSink };
  file?: File;
  sha?: Sha256;
}

async function chunkHex(data: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return new Sha256().update(data).hex();
}

const refused = (m: string, code = '') => new FsError('refused', m, code);

class TransferEngine {
  private jobs: Job[] = [];
  private prompts: Prompt[] = [];
  private snapshot: Snapshot = { jobs: [], prompts: [] };
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(endpointId: string, dir: string) => void>();
  private inner = new Map<string, Internals>();
  private control = new Map<string, 'pause' | 'cancel'>();
  private running = new Set<string>();
  private owner = '';
  private groupPolicy = new Map<string, ConflictPolicy>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastSaved = new Map<string, number>();
  private wakeLock: { release: () => Promise<void> } | null = null;
  private started = false;

  // ── React side ──

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;
  onRemoteChanged(fn: (endpointId: string, dir: string) => void) {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  private emit() {
    this.snapshot = { jobs: [...this.jobs], prompts: [...this.prompts] };
    for (const l of this.listeners) l();
    void this.keepAwake();
  }

  /** The signed-in user; loads the transfers a closed page left. */
  async setOwner(id: string) {
    if (this.owner === id) return;
    this.owner = id;
    this.start();
    const saved = await transferStore.load(id);
    for (const r of saved) {
      if (this.jobs.some((j) => j.id === r.id)) continue;
      const j = r as unknown as Job;
      if (['done', 'cancelled', 'skipped'].includes(j.state)) {
        void transferStore.remove(j.id);
        continue;
      }
      // A copy between two devices continues by itself; anything that reads or writes a file on
      // this computer waits for the operator (the browser asks again for access to it).
      const auto = j.src.kind === 'remote' && j.dst.kind === 'remote';
      j.state = auto ? 'queued' : 'interrupted';
      j.note = auto ? undefined : 'reload';
      j.retryAt = undefined;
      this.jobs.push(j);
    }
    this.emit();
    this.pump();
  }

  private start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    window.addEventListener('online', () => this.retryWaitingNow());
    window.addEventListener('beforeunload', (e) => {
      if (this.jobs.some((j) => ['running', 'queued', 'waiting', 'verifying'].includes(j.state))) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    document.addEventListener('visibilitychange', () => {
      this.wakeLock = null;
      void this.keepAwake();
    });
  }

  /** Keeps this computer's screen (and so the computer) awake while something is copying. */
  private async keepAwake() {
    const active = this.jobs.some((j) => ['running', 'queued', 'waiting', 'verifying'].includes(j.state));
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (active && !this.wakeLock && nav.wakeLock && document.visibilityState === 'visible') {
      try {
        this.wakeLock = await nav.wakeLock.request('screen');
      } catch {
        this.wakeLock = null;
      }
    } else if (!active && this.wakeLock) {
      const w = this.wakeLock;
      this.wakeLock = null;
      void w.release().catch(() => undefined);
    }
  }

  private persist(j: Job, force = false) {
    if (!j.persist || !this.owner) return;
    const now = Date.now();
    if (!force && now - (this.lastSaved.get(j.id) ?? 0) < 3000) return;
    this.lastSaved.set(j.id, now);
    const src = j.src.kind === 'local' ? { kind: 'local', handle: j.src.handle } : j.src;
    void transferStore.put({ ...j, src, url: undefined, owner: this.owner } as never);
  }

  private patch(id: string, p: Partial<Job>, save = false) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    Object.assign(j, p);
    this.emit();
    this.persist(j, save);
  }

  // ── Adding work ──

  add(items: Omit<Job, 'id' | 'done' | 'state' | 'attempts'>[], policy: ConflictPolicy = 'ask') {
    for (const it of items) {
      const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const j: Job = { ...it, id, done: 0, state: 'queued', attempts: 0 };
      if (!this.groupPolicy.has(j.group)) this.groupPolicy.set(j.group, policy);
      this.jobs.push(j);
      if (it.src.kind === 'local' && it.src.file) this.inner.set(id, { file: it.src.file });
      this.persist(j, true);
    }
    this.emit();
    this.pump();
  }

  /** An entry that cannot become a job (a failed folder walk): shown as failed in its group. */
  addFailed(group: string, groupLabel: string, name: string, error: string) {
    this.jobs.push({ id: `t-${Math.random().toString(36).slice(2)}`, group, groupLabel, name, size: 0, done: 0, src: { kind: 'memory' }, dst: { kind: 'memory' }, state: 'failed', error, attempts: 0, persist: false });
    this.emit();
  }

  // ── Controls ──

  pause(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    if (this.running.has(id)) this.control.set(id, 'pause');
    else if (['queued', 'waiting'].includes(j.state)) {
      this.clearTimer(id);
      this.patch(id, { state: 'paused', retryAt: undefined }, true);
    }
  }

  cancel(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || ['done', 'cancelled', 'skipped'].includes(j.state)) return;
    this.clearTimer(id);
    if (this.running.has(id)) {
      this.control.set(id, 'cancel');
      return;
    }
    void this.discard(id);
    this.patch(id, { state: 'cancelled', retryAt: undefined });
    void transferStore.remove(id);
    this.pump();
  }

  cancelGroup(group: string) {
    for (const j of this.jobs.filter((x) => x.group === group)) this.cancel(j.id);
  }
  pauseGroup(group: string) {
    for (const j of this.jobs.filter((x) => x.group === group)) this.pause(j.id);
  }
  resumeGroup(group: string) {
    for (const j of this.jobs.filter((x) => x.group === group)) void this.resume(j.id);
  }

  /** Continue a paused, interrupted or waiting transfer now (or retry a failed one). */
  async resume(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || !['paused', 'interrupted', 'waiting', 'failed'].includes(j.state)) return;
    // Files on this computer: the browser asks again for access after a reload (needs a click).
    for (const place of [j.src, j.dst]) {
      const h = place.kind === 'local' ? place.handle : place.kind === 'disk' ? place.dir : place.kind === 'save' ? place.handle : undefined;
      if (!h) continue;
      const perm = h as unknown as { queryPermission?: (o: object) => Promise<string>; requestPermission?: (o: object) => Promise<string> };
      const mode = place.kind === 'local' ? 'read' : 'readwrite';
      if (perm.queryPermission && (await perm.queryPermission({ mode })) !== 'granted') {
        if (!perm.requestPermission || (await perm.requestPermission({ mode })) !== 'granted') {
          this.patch(id, { state: 'interrupted', note: 'permission' });
          return;
        }
      }
    }
    if (j.src.kind === 'local' && !j.src.handle && !this.inner.get(id)?.file) {
      this.patch(id, { state: 'failed', error: 'lost_local_file' });
      return;
    }
    this.clearTimer(id);
    this.patch(id, { state: 'queued', retryAt: undefined, note: undefined, error: undefined, attempts: j.state === 'failed' ? 0 : j.attempts });
    this.pump();
  }

  resumeAll() {
    for (const j of this.jobs) if (['paused', 'interrupted', 'waiting'].includes(j.state)) void this.resume(j.id);
  }

  clearFinished() {
    for (const j of this.jobs) {
      if (['done', 'cancelled', 'skipped', 'failed'].includes(j.state)) {
        if (j.url) URL.revokeObjectURL(j.url);
        void transferStore.remove(j.id);
      }
    }
    this.jobs = this.jobs.filter((j) => !['done', 'cancelled', 'skipped', 'failed'].includes(j.state));
    this.emit();
  }

  answer(promptId: string, replace: boolean, all: boolean) {
    const p = this.prompts.find((x) => x.id === promptId);
    if (!p) return;
    this.prompts = this.prompts.filter((x) => x !== p);
    if (all && p.kind === 'overwrite') this.groupPolicy.set(p.job.group, replace ? 'replace' : 'skip');
    this.emit();
    p.resolve({ replace, all });
  }

  private ask(kind: Prompt['kind'], job: Job, existingSize?: number): Promise<boolean> {
    if (kind === 'overwrite') {
      const pol = this.groupPolicy.get(job.group);
      if (pol === 'replace') return Promise.resolve(true);
      if (pol === 'skip') return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.prompts.push({ id: `p-${Math.random().toString(36).slice(2)}`, kind, job, existingSize, resolve: (a) => resolve(a.replace) });
      this.emit();
    });
  }

  private clearTimer(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private retryWaitingNow() {
    for (const j of this.jobs) {
      if (j.state === 'waiting') {
        this.clearTimer(j.id);
        this.patch(j.id, { state: 'queued', retryAt: undefined });
      }
    }
    this.pump();
  }

  private async discard(id: string) {
    const inner = this.inner.get(id);
    this.inner.delete(id);
    try {
      await inner?.writer?.abort();
    } catch {
      /* already closed */
    }
  }

  // ── Running ──

  private pump() {
    while (this.running.size < PARALLEL) {
      const j = this.jobs.find((x) => x.state === 'queued' && !this.running.has(x.id));
      if (!j) return;
      void this.run(j);
    }
  }

  private check(j: Job) {
    if (this.control.get(j.id)) throw new FsError('cancelled', 'stopped');
  }

  private async run(j: Job) {
    this.running.add(j.id);
    this.control.delete(j.id);
    this.patch(j.id, { state: 'running', note: undefined, error: undefined, startedAt: j.startedAt ?? Date.now() });
    try {
      if (j.zip) await this.runZip(j);
      else if (j.src.kind === 'remote' && j.dst.kind === 'remote') await this.runCopy(j);
      else if (j.src.kind === 'remote') await this.runDownload(j);
      else await this.runUpload(j);
      this.patch(j.id, { state: j.state === 'skipped' ? 'skipped' : 'done', finishedAt: Date.now(), note: undefined, retryAt: undefined });
      void transferStore.remove(j.id);
      this.inner.delete(j.id);
      if (j.dst.kind === 'remote') {
        const dir = j.dst.path.slice(0, Math.max(j.dst.path.lastIndexOf('\\'), j.dst.path.lastIndexOf('/')));
        for (const l of this.changeListeners) l(j.dst.endpointId, dir);
      }
    } catch (err) {
      const e = toFsError(err);
      const c = this.control.get(j.id);
      this.control.delete(j.id);
      if (c === 'cancel') {
        await this.discard(j.id);
        this.patch(j.id, { state: 'cancelled' });
        void transferStore.remove(j.id);
      } else if (c === 'pause') {
        this.patch(j.id, { state: 'paused' }, true);
      } else if (e.kind === 'transient') {
        const attempts = j.attempts + 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 5));
        this.patch(j.id, { state: 'waiting', attempts, retryAt: Date.now() + delay, note: e.code || 'network_error', error: e.message }, true);
        this.timers.set(
          j.id,
          setTimeout(() => {
            this.timers.delete(j.id);
            const cur = this.jobs.find((x) => x.id === j.id);
            if (cur?.state === 'waiting') {
              this.patch(j.id, { state: 'queued', retryAt: undefined });
              this.pump();
            }
          }, delay),
        );
      } else if (e.kind === 'cancelled') {
        this.patch(j.id, { state: 'paused' }, true);
      } else {
        this.patch(j.id, { state: 'failed', error: e.message || 'failed' }, true);
      }
    } finally {
      this.running.delete(j.id);
      this.pump();
    }
  }

  /** Progress: resets the retry count (it is moving again) and measures the speed. */
  private progress(j: Job, done: number, extra: Partial<Job> = {}) {
    const elapsed = (Date.now() - (j.startedAt ?? Date.now())) / 1000;
    const prev = j.bytesPerSec ?? 0;
    const inst = elapsed > 0.5 ? done / elapsed : prev;
    this.patch(j.id, { done, attempts: 0, bytesPerSec: prev ? prev * 0.8 + inst * 0.2 : inst, ...extra });
  }

  /**
   * Reads `path` on a device from `from`, CHUNK at a time with up to `window` chunks in flight,
   * checks each chunk (its SHA-256, the file's size and modification time), and hands them to
   * `sink` in order. An agent with smaller chunks (older builds: 512 KiB) is followed.
   */
  private async pull(j: Job, ref: RemoteRef, path: string, from: number, sink: (data: Uint8Array, offset: number) => Promise<void>, window = PIPELINE): Promise<number> {
    let offset = from;
    let chunk = CHUNK;
    for (;;) {
      const inflight: { at: number; p: Promise<{ res: FsResult; data: Uint8Array }> }[] = [];
      let next = offset;
      let restart = false;
      const fill = () => {
        while (inflight.length < window && (inflight.length === 0 || next < (j.srcSize ?? j.size))) {
          const at = next;
          const p = fsRead(ref.endpointId, { path, offset: at, length: chunk }, { stopped: () => Boolean(this.control.get(j.id)) });
          p.catch(() => undefined);
          inflight.push({ at, p });
          next += chunk;
        }
      };
      fill();
      while (inflight.length) {
        this.check(j);
        const { at, p } = inflight.shift()!;
        const { res, data } = await p;
        if (typeof res.offset === 'number' && res.offset !== at) throw refused('chunk_order');
        // The source must stay the same file from the first chunk to the last.
        if (j.srcMod === undefined && res.mod_time) j.srcMod = res.mod_time;
        if (j.srcSize === undefined && typeof res.total_size === 'number') j.srcSize = res.total_size;
        if ((res.mod_time && j.srcMod && res.mod_time !== j.srcMod) || (typeof res.total_size === 'number' && j.srcSize !== undefined && res.total_size !== j.srcSize)) {
          throw refused('source_changed', 'source_changed');
        }
        if (!res.chunk_sha256 && data.length > 0) j.unchecked = true;
        if (res.chunk_sha256 && (await chunkHex(data)) !== res.chunk_sha256.toLowerCase()) throw new FsError('transient', 'chunk_checksum', 'chunk_checksum');
        await sink(data, at);
        offset = at + data.length;
        if (res.eof || data.length === 0) return offset;
        if (data.length < chunk) {
          // Fewer bytes than asked and not the end: this agent's chunk is smaller; ask again from here.
          chunk = data.length;
          restart = true;
          break;
        }
        fill();
      }
      if (!restart && offset >= (j.srcSize ?? j.size)) return offset;
    }
  }

  /** After the last chunk: the source is still the same file (size, time; whole checksum for old agents). */
  private async verifySource(j: Job, ref: RemoteRef, path: string, localHex: string | null, sawChunkHashes: boolean): Promise<Job['verified']> {
    const st = await fsCall(ref.endpointId, { op: 'hash', path, ...(sawChunkHashes ? { size_only: true } : {}) }, { deadlineMs: 20 * 60_000 });
    if ((st.mod_time && j.srcMod && st.mod_time !== j.srcMod) || (typeof st.total_size === 'number' && st.total_size !== j.srcSize)) throw refused('source_changed', 'source_changed');
    if (st.sha256 && localHex) {
      if (st.sha256.toLowerCase() !== localHex) throw refused('checksum_mismatch', 'checksum');
      return 'full';
    }
    if (!sawChunkHashes && localHex && (j.srcSize ?? 0) <= FULL_HASH_LIMIT) {
      const full = await fsCall(ref.endpointId, { op: 'hash', path }, { deadlineMs: 20 * 60_000 });
      if (full.sha256?.toLowerCase() !== localHex) throw refused('checksum_mismatch', 'checksum');
      return 'full';
    }
    return 'chunks';
  }

  // Download: device → this computer.
  private async runDownload(j: Job) {
    const src = j.src as Extract<Place, { kind: 'remote' }>;
    const inner = this.inner.get(j.id) ?? {};
    this.inner.set(j.id, inner);
    // Without the open writer of this page (closed, reloaded) the file starts again.
    if (!inner.sha || (!inner.writer && !inner.chunks)) {
      await inner.writer?.abort().catch(() => undefined);
      inner.writer = undefined;
      inner.chunks = undefined;
      inner.sha = new Sha256();
      j.srcMod = undefined;
      j.srcSize = undefined;
      this.patch(j.id, { done: 0 });
      if (j.dst.kind === 'memory') inner.chunks = [];
      else {
        const dst = j.dst;
        if (dst.kind !== 'save' && dst.kind !== 'disk') throw refused('bad_target');
        const handle = dst.kind === 'save' ? dst.handle : await fileIn(dst.dir, dst.rel);
        inner.writer = await handle.createWritable({ keepExistingData: false });
      }
    }
    const sha = inner.sha;
    await this.pull(j, src, src.path, j.done, async (data) => {
      if (inner.writer) await inner.writer.write(data as BufferSource);
      else inner.chunks!.push(data);
      sha.update(data);
      this.progress(j, j.done + data.length);
    });
    this.patch(j.id, { state: 'verifying' });
    const hex = Sha256.restore(sha.save()).hex();
    const verified = await this.verifySource(j, src, src.path, hex, !j.unchecked);
    if (inner.writer) {
      await inner.writer.close();
      inner.writer = undefined;
    } else if (inner.chunks) {
      const url = URL.createObjectURL(new Blob(inner.chunks as BlobPart[], { type: 'application/octet-stream' }));
      inner.chunks = undefined;
      j.url = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = j.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    this.patch(j.id, { sha256: hex, verified, url: j.url });
  }

  /**
   * Where an upload or copy continues on the receiving device, and the running checksum for it.
   * readSource reads bytes [a, b) of the source to bring the checksum to the agent's offset.
   */
  private async resumePoint(j: Job, dst: Extract<Place, { kind: 'remote' }>, readSource: (a: number, b: number) => Promise<Uint8Array>): Promise<{ offset: number; sha: Sha256; overwrite: boolean }> {
    const fresh = { offset: 0, sha: new Sha256(), overwrite: Boolean(j.overwrite) };
    if (j.done === 0) return fresh;
    let next: number | undefined;
    try {
      const st = await fsCall(dst.endpointId, { op: 'hash', path: dst.path, size_only: true }, { deadlineMs: 20 * 60_000 });
      next = st.upload_next;
    } catch (err) {
      const e = toFsError(err);
      if (e.kind !== 'refused') throw e;
    }
    if (typeof next !== 'number' || next > j.size) {
      // The device cannot continue it (an older agent restarted): start again, replacing the
      // partial file this transfer left, after the operator says so.
      if (!(await this.ask('restart', j))) throw new FsError('cancelled', 'stopped');
      this.patch(j.id, { done: 0, overwrite: true, hash: undefined, hashedTo: 0 });
      return { offset: 0, sha: new Sha256(), overwrite: true };
    }
    let sha = j.hash ? Sha256.restore(j.hash) : new Sha256();
    let at = j.hash ? (j.hashedTo ?? 0) : 0;
    if (at > next) {
      sha = new Sha256();
      at = 0;
    }
    while (at < next) {
      const b = Math.min(next, at + CHUNK);
      sha.update(await readSource(at, b));
      at = b;
    }
    this.patch(j.id, { done: next, hash: sha.save(), hashedTo: next });
    return { offset: next, sha, overwrite: false };
  }

  /** Sends one chunk; the first may meet an existing file (asks, or follows the group's choice). */
  private async put(j: Job, dst: Extract<Place, { kind: 'remote' }>, offset: number, data: Uint8Array, overwrite: boolean, last: boolean, sha: Sha256, staged?: Promise<string>): Promise<RemoteFileResponse | 'skipped'> {
    const before = sha.save();
    sha.update(data);
    const expected = last ? Sha256.restore(sha.save()).hex() : undefined;
    const send = (ow: boolean) =>
      fsWrite(
        dst.endpointId,
        {
          path: dst.path,
          offset,
          append: offset > 0,
          ...(offset === 0 && ow ? { overwrite: true } : {}),
          ...(expected ? { expected_sha256: expected } : {}),
        },
        data,
        // Staged bytes serve one command only; the first piece (which may ask to overwrite and be
        // sent again) is never staged.
        offset > 0 ? staged : undefined,
      );
    try {
      try {
        return await send(overwrite);
      } catch (err) {
        const e = toFsError(err);
        if (offset !== 0 || overwrite || e.kind !== 'refused' || !e.message.includes(UPLOAD_TARGET_EXISTS)) throw e;
        if (!(await this.ask('overwrite', j))) {
          j.state = 'skipped';
          return 'skipped';
        }
        this.patch(j.id, { overwrite: true });
        return await send(true);
      }
    } catch (err) {
      // Not written (or not known to be): the checksum goes back to before this chunk.
      const r = Sha256.restore(before);
      Object.assign(sha, r);
      throw err;
    }
  }

  /**
   * Writes pieces to a device in order, one write command at a time (the device appends), while the
   * next piece's bytes already go up to the server: a piece costs one round trip instead of two.
   * The first piece (it may meet an existing file) is written alone. After each written piece,
   * `written` records the progress. `flush` waits for the last write and reports its error.
   */
  private orderedWriter(j: Job, dst: Extract<Place, { kind: 'remote' }>, sha: Sha256, overwrite: boolean, written: (res: RemoteFileResponse, end: number) => void) {
    let pending: Promise<void> | null = null;
    let first = overwrite;
    const one = async (data: Uint8Array, at: number, staged?: Promise<string>) => {
      const end = at + data.length;
      const res = await this.put(j, dst, at, data, first && at === 0, end >= j.size, sha, staged);
      if (res === 'skipped') throw new FsError('cancelled', 'skipped', 'skipped');
      first = false;
      written(res, end);
    };
    return {
      write: async (data: Uint8Array, at: number) => {
        const staged = at > 0 && data.length > 0 ? fsStage(dst.endpointId, data) : undefined;
        staged?.catch(() => undefined);
        if (pending) await pending;
        pending = null;
        if (!staged) return one(data, at);
        const p = one(data, at, staged);
        p.catch(() => undefined);
        pending = p;
      },
      flush: async () => {
        const p = pending;
        pending = null;
        if (p) await p;
      },
      /** After a failure elsewhere: let a running write settle (its own error is not the one to report). */
      settle: async () => {
        const p = pending;
        pending = null;
        await p?.catch(() => undefined);
      },
    };
  }

  // Upload: this computer → device.
  private async runUpload(j: Job) {
    const dst = j.dst as Extract<Place, { kind: 'remote' }>;
    const src = j.src as Extract<Place, { kind: 'local' }>;
    const inner = this.inner.get(j.id) ?? {};
    this.inner.set(j.id, inner);
    inner.file ??= src.file ?? (src.handle ? await src.handle.getFile() : undefined);
    const file = inner.file;
    if (!file) throw refused('lost_local_file');
    if (file.size !== j.size) throw refused('source_changed', 'source_changed');
    const read = async (a: number, b: number) => new Uint8Array(await file.slice(a, b).arrayBuffer());
    const resumed = await this.resumePoint(j, dst, read);
    let offset = resumed.offset;
    const sha = resumed.sha;
    let last: RemoteFileResponse | null = null;
    const w = this.orderedWriter(j, dst, sha, resumed.overwrite, (res, end) => {
      last = res;
      this.progress(j, end, { hash: sha.save(), hashedTo: end });
      this.persist(j);
    });
    try {
      do {
        this.check(j);
        const end = Math.min(file.size, offset + CHUNK);
        await w.write(await read(offset, end), offset);
        offset = end;
      } while (offset < file.size);
      await w.flush();
    } catch (err) {
      await w.settle();
      if (toFsError(err).code === 'skipped') return;
      throw err;
    }
    const res = last as RemoteFileResponse | null;
    const mine = Sha256.restore(sha.save()).hex();
    if (res?.sha256 && res.sha256.toLowerCase() !== mine) throw refused('checksum_mismatch', 'checksum');
    this.patch(j.id, { sha256: mine, verified: res?.sha256 ? 'receiver' : undefined });
  }

  // Copy: device → device, chunk by chunk through this page (nothing kept whole).
  private async runCopy(j: Job) {
    const src = j.src as Extract<Place, { kind: 'remote' }>;
    const dst = j.dst as Extract<Place, { kind: 'remote' }>;
    const readSource = async (a: number, b: number) => {
      const parts: Uint8Array[] = [];
      let at = a;
      while (at < b) {
        const { data: d } = await fsRead(src.endpointId, { path: src.path, offset: at, length: Math.min(CHUNK, b - at) });
        if (!d.length) break;
        parts.push(d);
        at += d.length;
      }
      const out = new Uint8Array(at - a);
      let p = 0;
      for (const x of parts) {
        out.set(x, p);
        p += x.length;
      }
      return out;
    };
    const { offset, sha, overwrite } = await this.resumePoint(j, dst, readSource);
    if (offset > 0) {
      // The source must still be the file whose first part was copied.
      const st = await fsCall(src.endpointId, { op: 'hash', path: src.path, size_only: true }, { deadlineMs: 20 * 60_000 });
      if ((j.srcMod && st.mod_time && st.mod_time !== j.srcMod) || st.total_size !== j.size) throw refused('source_changed', 'source_changed');
    }
    if (j.size === 0) {
      const res = await this.put(j, dst, 0, new Uint8Array(), overwrite, true, sha);
      if (res !== 'skipped') this.patch(j.id, { sha256: Sha256.restore(sha.save()).hex(), verified: 'receiver' });
      return;
    }
    let last: RemoteFileResponse | null = null;
    const w = this.orderedWriter(j, dst, sha, overwrite, (res, end) => {
      last = res;
      this.progress(j, end, { hash: sha.save(), hashedTo: end });
      this.persist(j);
    });
    try {
      await this.pull(j, src, src.path, offset, (data, at) => w.write(data, at));
      await w.flush();
    } catch (err) {
      await w.settle();
      if (toFsError(err).code !== 'skipped') throw err;
    }
    if (j.state === 'skipped') return;
    const res = last as RemoteFileResponse | null;
    const mine = Sha256.restore(sha.save()).hex();
    if (res?.sha256 && res.sha256.toLowerCase() !== mine) throw refused('checksum_mismatch', 'checksum');
    this.patch(j.id, { state: 'verifying' });
    await this.verifySource(j, src, src.path, null, true);
    this.patch(j.id, { sha256: mine, verified: res?.sha256 ? 'receiver' : 'chunks' });
  }

  // ZIP: several files and folders of one device in one archive.
  private async runZip(j: Job) {
    const src = j.src as Extract<Place, { kind: 'remote' }>;
    const z = j.zip!;
    const inner = this.inner.get(j.id) ?? {};
    this.inner.set(j.id, inner);
    if (!inner.zip) {
      // A new archive (also after a reload: the archive cannot be continued, it starts again).
      z.index = 0;
      this.patch(j.id, { done: 0 });
      if (j.dst.kind === 'save') {
        const w = await j.dst.handle.createWritable({ keepExistingData: false });
        let pos = 0;
        const sink = {
          write: async (d: Uint8Array) => {
            await w.write({ type: 'write', position: pos, data: d as BufferSource });
            pos += d.length;
          },
          writeAt: async (p: number, d: Uint8Array) => {
            await w.write({ type: 'write', position: p, data: d as BufferSource });
          },
          close: () => w.close(),
          abort: () => w.abort(),
        };
        inner.writer = w;
        inner.zip = { writer: new ZipWriter(sink), sink, entryDone: 0, begun: false };
      } else {
        const memory = new MemoryZipSink();
        inner.zip = { writer: new ZipWriter(memory), sink: memory, entryDone: 0, begun: false, memory };
      }
    }
    const zz = inner.zip;
    let total = z.entries.slice(0, z.index).reduce((n, e) => n + e.size, 0) + zz.entryDone;
    while (z.index < z.entries.length) {
      this.check(j);
      const e = z.entries[z.index]!;
      if (e.dir) {
        await zz.writer.addFolder(e.rel, e.mod);
      } else {
        if (!zz.begun) {
          await zz.writer.begin(e.rel, e.size, e.mod);
          zz.begun = true;
          zz.entryDone = 0;
          j.srcMod = undefined;
          j.srcSize = e.size;
          j.unchecked = false;
        }
        if (e.size > 0) {
          await this.pull(j, src, e.path, zz.entryDone, async (data) => {
            await zz.writer.data(data);
            zz.entryDone += data.length;
            total += data.length;
            this.progress(j, total);
          });
        }
        await this.verifySource(j, src, e.path, null, !j.unchecked);
        await zz.writer.end();
        zz.begun = false;
        zz.entryDone = 0;
      }
      z.index++;
      this.patch(j.id, { zip: { ...z } });
    }
    await zz.writer.finish();
    if (zz.memory) {
      const url = URL.createObjectURL(zz.memory.blob());
      j.url = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = j.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else await zz.sink.close?.();
    inner.writer = undefined;
    this.patch(j.id, { verified: 'chunks', url: j.url });
  }
}

/** A file at `rel` (forward slashes) under `dir`, creating its folders. */
export async function fileIn(dir: FileSystemDirectoryHandle, rel: string): Promise<FileSystemFileHandle> {
  const parts = rel.split('/').filter(Boolean);
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  return d.getFileHandle(parts[parts.length - 1]!, { create: true });
}

export const transfers = new TransferEngine();

export { joinRemote, relPath };
