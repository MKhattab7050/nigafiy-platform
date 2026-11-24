import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteFileResponse } from '@nigafiy/shared-types';
import type { ApiError } from '@/lib/api';
import { arrayBufferToBase64, base64ToUint8Array } from './file-utils';
import { Sha256, sha256OfFile } from './sha256';
import { classifyTransferError, uploadResumePoint } from './transfer-rules';

// The two-pane file manager's transfer queue: uploads (browser → computer) and downloads
// (computer → browser) run one at a time in 256 KiB chunks through the same fs_op commands as
// before (same path guards, roles and audit). A lost connection, a timeout or an offline agent
// leaves a transfer "interrupted" at the last chunk that arrived; Resume continues from there.
// Every finished transfer is checked with SHA-256 on both sides before it counts as done.

const CHUNK = 256 * 1024;

export type TransferState = 'queued' | 'running' | 'paused' | 'interrupted' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface Transfer {
  id: string;
  dir: 'up' | 'down';
  name: string;
  remotePath: string;
  size: number;
  done: number;
  state: TransferState;
  error?: string;
  /** SHA-256 both sides agreed on (done only). */
  sha256?: string;
  /** Upload: the operator confirmed replacing an existing file (first chunk only). */
  overwrite?: boolean;
  /** Download: a link to save the verified file again. */
  url?: string;
}

interface Internals {
  file?: File;
  fileSha?: string;
  chunks?: Uint8Array[];
}

type RunFsOp = (payload: Record<string, unknown>) => Promise<RemoteFileResponse>;

function stopped(): ApiError {
  return { status: 499, code: 'cancelled', message: 'cancelled' } as ApiError;
}

/** Stops between chunks when the operator paused or cancelled this transfer. */
function check(control: Map<string, 'pause' | 'cancel'>, id: string) {
  if (control.get(id)) throw stopped();
}

export function useTransferQueue({
  runFsOp,
  confirmOverwrite,
  onUploaded,
}: {
  runFsOp: RunFsOp;
  /** Asks the operator before a restarted upload replaces the partial file it left. */
  confirmOverwrite: (name: string, path: string, size: number) => Promise<boolean>;
  onUploaded: () => void;
}) {
  const [items, setItems] = useState<Transfer[]>([]);
  const itemsRef = useRef<Transfer[]>([]);
  const internals = useRef(new Map<string, Internals>());
  const control = useRef(new Map<string, 'pause' | 'cancel'>());
  const running = useRef(false);
  const alive = useRef(true);

  useEffect(
    () => () => {
      alive.current = false;
      for (const t of itemsRef.current) if (t.url) URL.revokeObjectURL(t.url);
    },
    [],
  );

  const patch = useCallback((id: string, p: Partial<Transfer>) => {
    itemsRef.current = itemsRef.current.map((t) => (t.id === id ? { ...t, ...p } : t));
    if (alive.current) setItems(itemsRef.current);
  }, []);

  const runUpload = useCallback(
    async (t: Transfer) => {
      const inner = internals.current.get(t.id)!;
      const file = inner.file!;
      if (!inner.fileSha) {
        patch(t.id, { state: 'verifying' });
        inner.fileSha = await sha256OfFile(file);
        patch(t.id, { state: 'running' });
      }
      let offset = t.done;
      let overwrite = Boolean(t.overwrite);
      if (offset > 0) {
        // Resuming: ask the agent where its own upload of this file stopped.
        let answer: RemoteFileResponse | null = null;
        try {
          answer = await runFsOp({ op: 'hash', path: t.remotePath });
        } catch {
          answer = null;
        }
        const point = uploadResumePoint(file.size, answer);
        if (point.kind === 'resume') offset = point.offset;
        else {
          // The agent cannot continue it (restarted, or the partial file changed): start again,
          // replacing the partial file only after the operator says so.
          if (!(await confirmOverwrite(t.name, t.remotePath, file.size))) throw stopped();
          offset = 0;
          overwrite = true;
        }
        patch(t.id, { done: offset });
      }
      let last: RemoteFileResponse | null = null;
      do {
        check(control.current, t.id);
        const end = Math.min(file.size, offset + CHUNK);
        const buf = await file.slice(offset, end).arrayBuffer();
        last = await runFsOp({
          op: 'upload',
          path: t.remotePath,
          offset,
          append: offset > 0,
          data_base64: arrayBufferToBase64(buf),
          ...(offset === 0 && overwrite ? { overwrite: true } : {}),
          // The agent checks the whole file against this on the last chunk.
          ...(end >= file.size ? { expected_sha256: inner.fileSha } : {}),
        });
        offset = end;
        patch(t.id, { done: offset });
      } while (offset < file.size);
      if (!last?.sha256 || last.sha256.toLowerCase() !== inner.fileSha) {
        throw { status: 422, code: 'checksum', message: 'SHA-256 mismatch after upload' } as ApiError;
      }
      patch(t.id, { state: 'done', sha256: inner.fileSha, overwrite: false });
      internals.current.delete(t.id);
      onUploaded();
    },
    [confirmOverwrite, onUploaded, patch, runFsOp],
  );

  const runDownload = useCallback(
    async (t: Transfer) => {
      const inner = internals.current.get(t.id)!;
      inner.chunks ??= [];
      let offset = t.done;
      let total = t.size;
      for (;;) {
        check(control.current, t.id);
        const res = await runFsOp({ op: 'download', path: t.remotePath, offset, length: CHUNK });
        const raw = res.data_base64 ? base64ToUint8Array(res.data_base64) : new Uint8Array();
        inner.chunks.push(raw);
        offset += raw.byteLength;
        if (typeof res.total_size === 'number') total = res.total_size;
        patch(t.id, { done: offset, size: total });
        if (res.eof || raw.byteLength === 0) break;
      }
      patch(t.id, { state: 'verifying' });
      const local = new Sha256();
      for (const c of inner.chunks) local.update(c);
      const mine = local.hex();
      const theirs = await runFsOp({ op: 'hash', path: t.remotePath });
      if (theirs.sha256?.toLowerCase() !== mine || theirs.total_size !== offset) {
        // The file changed on the computer while it was copied, or bytes were lost: start again.
        inner.chunks = [];
        throw { status: 422, code: 'checksum', message: 'SHA-256 mismatch: the file changed while it was copied; download it again' } as ApiError;
      }
      const url = URL.createObjectURL(new Blob(inner.chunks as BlobPart[], { type: 'application/octet-stream' }));
      internals.current.delete(t.id);
      patch(t.id, { state: 'done', sha256: mine, url });
      const a = document.createElement('a');
      a.href = url;
      a.download = t.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [patch, runFsOp],
  );

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const t = itemsRef.current.find((x) => x.state === 'queued');
        if (!t || !alive.current) return;
        control.current.delete(t.id);
        patch(t.id, { state: 'running', error: undefined });
        try {
          if (t.dir === 'up') await runUpload(t);
          else await runDownload(t);
        } catch (err) {
          const e = err as ApiError;
          const c = control.current.get(t.id);
          control.current.delete(t.id);
          if (c === 'pause') patch(t.id, { state: 'paused' });
          else if (c === 'cancel' || classifyTransferError(e) === 'cancelled') {
            internals.current.delete(t.id);
            patch(t.id, { state: 'cancelled' });
          } else patch(t.id, { state: e.code === 'checksum' ? 'failed' : classifyTransferError(e), error: e.message });
        }
      }
    } finally {
      running.current = false;
    }
  }, [patch, runDownload, runUpload]);

  const add = useCallback(
    (t: Omit<Transfer, 'id' | 'done' | 'state'>, inner: Internals) => {
      const id = `${t.dir}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      internals.current.set(id, inner);
      itemsRef.current = [...itemsRef.current, { ...t, id, done: 0, state: 'queued' }];
      setItems(itemsRef.current);
      void pump();
    },
    [pump],
  );

  const enqueueUpload = useCallback(
    (file: File, remotePath: string, overwrite: boolean) => add({ dir: 'up', name: file.name, remotePath, size: file.size, overwrite }, { file }),
    [add],
  );
  const enqueueDownload = useCallback((name: string, remotePath: string, size: number) => add({ dir: 'down', name, remotePath, size }, {}), [add]);

  const pause = (id: string) => control.current.set(id, 'pause');
  const cancel = (id: string) => {
    const t = itemsRef.current.find((x) => x.id === id);
    if (t?.state === 'running' || t?.state === 'verifying') control.current.set(id, 'cancel');
    else if (t && t.state !== 'done') {
      internals.current.delete(id);
      patch(id, { state: 'cancelled' });
    }
  };
  /** Resume a paused or interrupted transfer (or retry a failed one) from where it stopped. */
  const resume = async (id: string) => {
    const t = itemsRef.current.find((x) => x.id === id);
    const inner = internals.current.get(id);
    if (!t || !inner || !['paused', 'interrupted', 'failed'].includes(t.state)) return;
    if (t.state === 'failed') {
      // A refused or mismatched transfer starts again from the beginning. An upload then replaces
      // the partial file it left, which the operator confirms first.
      if (t.dir === 'up' && t.done > 0) {
        if (!(await confirmOverwrite(t.name, t.remotePath, t.size))) return;
        patch(id, { done: 0, overwrite: true });
      } else {
        inner.chunks = [];
        patch(id, { done: 0 });
      }
    }
    patch(id, { state: 'queued' });
    void pump();
  };
  const clearFinished = () => {
    for (const t of itemsRef.current) if (t.url && (t.state === 'done' || t.state === 'cancelled')) URL.revokeObjectURL(t.url);
    itemsRef.current = itemsRef.current.filter((t) => !['done', 'cancelled'].includes(t.state));
    setItems(itemsRef.current);
  };
  const canResume = (id: string) => internals.current.has(id);

  return { items, enqueueUpload, enqueueDownload, pause, cancel, resume, clearFinished, canResume };
}
