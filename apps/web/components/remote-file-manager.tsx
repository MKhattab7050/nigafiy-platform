'use client';

import clsx from 'clsx';
import {
  ArrowUp,
  ClipboardPaste,
  Copy,
  Download,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  HardDrive,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EndpointCommand, EndpointDetail, RemoteFileEntry, RemoteFileResponse, RemoteFileRoot } from '@lan-detective/shared-types';
import { Badge, Button, Card, ErrorNote, Input } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 10 || i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function RemoteFileManager({
  ep,
  online,
  canWrite,
  canDelete,
}: {
  ep: EndpointDetail;
  online: boolean;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';

  const [roots, setRoots] = useState<RemoteFileRoot[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string>('');
  const [pathInput, setPathInput] = useState<string>('');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'move'; paths: string[] } | null>(null);

  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'mod_time'>('name');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const cancelRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const runFsOp = useCallback(
    async (payload: Record<string, unknown>): Promise<RemoteFileResponse> => {
      const cmd = await api<EndpointCommand>(`/endpoints/${ep.id}/commands?wait_ms=4500`, {
        method: 'POST',
        body: { kind: 'fs_op', ...payload },
      });
      if (cmd.status === 'completed' && cmd.result_data) {
        return cmd.result_data as unknown as RemoteFileResponse;
      }
      if (cmd.status === 'failed') {
        throw { status: 422, code: 'fs_op_failed', message: cmd.error || 'File operation failed on endpoint' } as ApiError;
      }
      // Poll up to 8 more seconds if the agent took slightly longer
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const detail = await api<EndpointDetail>(`/endpoints/${ep.id}`);
        const found = detail.commands.find((c) => c.id === cmd.id);
        if (found?.status === 'completed' && found.result_data) {
          return found.result_data as unknown as RemoteFileResponse;
        }
        if (found?.status === 'failed') {
          throw { status: 422, code: 'fs_op_failed', message: found.error || 'File operation failed' } as ApiError;
        }
      }
      throw {
        status: 504,
        code: 'timeout',
        message: isAr ? 'انتهت مهلة انتظار استجابة وكيل الجهاز' : 'Timed out waiting for endpoint agent response',
      } as ApiError;
    },
    [ep.id, isAr],
  );

  const loadDirectory = useCallback(
    async (targetPath: string, hidden = showHidden) => {
      if (!online) return;
      setBusy('list');
      setError(null);
      try {
        const res = await runFsOp({ op: 'list', path: targetPath || undefined, show_hidden: hidden });
        setCurrentPath(res.path ?? targetPath);
        setPathInput(res.path ?? targetPath);
        setParentPath(res.parent_path ?? '');
        setEntries(res.entries ?? []);
        setSelected(new Set());
      } catch (err) {
        setError(err as ApiError);
      } finally {
        setBusy('');
      }
    },
    [online, runFsOp, showHidden],
  );

  const initRoots = useCallback(async () => {
    if (!online) return;
    setBusy('roots');
    setError(null);
    try {
      const res = await runFsOp({ op: 'roots' });
      const rList = res.roots ?? [];
      setRoots(rList);
      if (rList.length > 0) {
        const homeOrFirst = rList.find((r) => r.name === 'Home')?.path ?? rList[0]!.path;
        await loadDirectory(homeOrFirst, showHidden);
      }
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }, [loadDirectory, online, runFsOp, showHidden]);

  useEffect(() => {
    if (online && roots.length === 0 && !currentPath) {
      void initRoots();
    }
  }, [online, roots.length, currentPath, initRoots]);

  const sortedEntries = useMemo(() => {
    const copy = [...entries];
    copy.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      if (sortBy === 'size') return b.size - a.size;
      if (sortBy === 'mod_time') return b.mod_time.localeCompare(a.mod_time);
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return copy;
  }, [entries, sortBy]);

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim() || !currentPath) return;
    setBusy('search');
    setError(null);
    try {
      const res = await runFsOp({
        op: 'search',
        path: currentPath,
        query: searchQuery.trim(),
        show_hidden: showHidden,
      });
      setEntries(res.entries ?? []);
      setSelected(new Set());
      setNotice(
        isAr
          ? `تم العثور على ${(res.entries ?? []).length} نتيجة في ${currentPath}`
          : `Found ${(res.entries ?? []).length} item(s) in ${currentPath}`,
      );
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function handleMkdir() {
    const folderName = window.prompt(isAr ? 'اسم المجلد الجديد:' : 'New folder name:');
    if (!folderName?.trim() || !currentPath) return;
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const full = currentPath.endsWith(sep) ? `${currentPath}${folderName.trim()}` : `${currentPath}${sep}${folderName.trim()}`;
    setBusy('mkdir');
    setError(null);
    try {
      await runFsOp({ op: 'mkdir', path: full });
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function handleNewFile() {
    const fileName = window.prompt(isAr ? 'اسم الملف الجديد (مثال: notes.txt):' : 'New file name (e.g. notes.txt):');
    if (!fileName?.trim() || !currentPath) return;
    const content = window.prompt(isAr ? 'محتوى الملف النصي (اختياري):' : 'Initial text content (optional):') ?? '';
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const full = currentPath.endsWith(sep) ? `${currentPath}${fileName.trim()}` : `${currentPath}${sep}${fileName.trim()}`;
    setBusy('touch');
    setError(null);
    try {
      const b64 = btoa(unescape(encodeURIComponent(content)));
      await runFsOp({ op: 'touch', path: full, data_base64: b64 });
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function handleRename(entry: RemoteFileEntry) {
    const newName = window.prompt(isAr ? 'الاسم الجديد:' : 'Rename to:', entry.name);
    if (!newName?.trim() || newName.trim() === entry.name) return;
    setBusy(`rename-${entry.path}`);
    setError(null);
    try {
      await runFsOp({ op: 'rename', path: entry.path, new_name: newName.trim() });
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function handlePaste() {
    if (!clipboard || clipboard.paths.length === 0 || !currentPath) return;
    setBusy('paste');
    setError(null);
    try {
      await runFsOp({
        op: clipboard.mode,
        paths: clipboard.paths,
        target_path: currentPath,
      });
      if (clipboard.mode === 'move') setClipboard(null);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function handleDelete(paths: string[]) {
    if (paths.length === 0) return;
    const msg = isAr
      ? `تحذير: هل أنت متأكد من حذف ${paths.length} عنصر نهائياً من الجهاز البعيد؟`
      : `Confirm permanent deletion of ${paths.length} item(s) on the remote endpoint?`;
    if (!window.confirm(msg)) return;
    setBusy('delete');
    setError(null);
    try {
      await runFsOp({ op: 'delete', paths, confirm_destructive: true });
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function handleDownload(entry: RemoteFileEntry) {
    if (entry.is_dir) return;
    cancelRef.current = false;
    setBusy(`dl-${entry.path}`);
    setError(null);
    try {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      const chunkLen = 256 * 1024;
      let sha = '';
      while (true) {
        if (cancelRef.current) throw { status: 499, code: 'cancelled', message: 'Transfer cancelled by operator' } as ApiError;
        const pctVal = entry.size > 0 ? Math.min(99, Math.round((offset * 100) / entry.size)) : 50;
        setProgress({ label: `Downloading ${entry.name}…`, pct: pctVal });
        const res = await runFsOp({ op: 'download', path: entry.path, offset, length: chunkLen });
        if (res.data_base64) {
          const raw = base64ToUint8Array(res.data_base64);
          chunks.push(raw);
          offset += raw.byteLength;
        }
        if (res.sha256) sha = res.sha256;
        if (res.eof || !res.bytes_read) break;
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
      const merged = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) {
        merged.set(c, pos);
        pos += c.byteLength;
      }
      const blob = new Blob([merged], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(
        sha
          ? `Downloaded ${entry.name} (${formatBytes(totalLen)} · SHA-256: ${sha.slice(0, 16)}…)`
          : `Downloaded ${entry.name} (${formatBytes(totalLen)})`,
      );
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setProgress(null);
      setBusy('');
    }
  }

  async function handleUploadFile(file: File) {
    if (!currentPath) return;
    cancelRef.current = false;
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const remotePath = currentPath.endsWith(sep) ? `${currentPath}${file.name}` : `${currentPath}${sep}${file.name}`;
    setBusy('upload');
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const total = buf.byteLength;
      const chunkLen = 256 * 1024;
      let offset = 0;
      if (total === 0) {
        await runFsOp({ op: 'upload', path: remotePath, offset: 0, append: false, data_base64: '' });
      } else {
        while (offset < total) {
          if (cancelRef.current) throw { status: 499, code: 'cancelled', message: 'Upload cancelled by operator' } as ApiError;
          const end = Math.min(total, offset + chunkLen);
          const slice = buf.slice(offset, end);
          const b64 = arrayBufferToBase64(slice);
          setProgress({
            label: `Uploading ${file.name}…`,
            pct: Math.min(99, Math.round((end * 100) / total)),
          });
          await runFsOp({
            op: 'upload',
            path: remotePath,
            offset,
            append: offset > 0,
            data_base64: b64,
          });
          offset = end;
        }
      }
      setNotice(`Uploaded ${file.name} (${formatBytes(total)})`);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setProgress(null);
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      {error && <ErrorNote error={error} />}
      {notice && (
        <p role="status" className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-fg">
          {notice}
        </p>
      )}
      {progress && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-line-strong bg-raised p-3 text-xs">
          <div className="flex-1">
            <div className="mb-1 flex justify-between">
              <span className="font-medium text-fg">{progress.label}</span>
              <span className="mono text-muted">{progress.pct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-bg">
              <div className="h-full bg-accent transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              cancelRef.current = true;
            }}
          >
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
        </div>
      )}

      {ep.policy?.allowed_fs_roots && ep.policy.allowed_fs_roots.length > 0 && (
        <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-muted">
          <strong className="text-fg">{isAr ? 'تقييد المسارات حسب السياسة:' : 'Policy Directory Restriction:'}</strong>{' '}
          <span dir="ltr" className="mono">
            {ep.policy.allowed_fs_roots.join(', ')}
          </span>
        </div>
      )}

      <Card
        title={isAr ? 'مستكشف الملفات عن بُعد (Enterprise File Manager)' : 'Enterprise Remote File Explorer'}
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1.5 text-xs text-muted px-2">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => {
                  setShowHidden(e.target.checked);
                  if (currentPath) void loadDirectory(currentPath, e.target.checked);
                }}
              />
              {isAr ? 'إظهار المخفي' : 'Show hidden'}
            </label>
            <Button size="sm" disabled={!online} busy={busy === 'roots'} onClick={() => void initRoots()}>
              <HardDrive className="size-3.5" aria-hidden />
              {isAr ? 'الأقراص' : 'Volumes'}
            </Button>
            <Button size="sm" disabled={!online || !currentPath} busy={busy === 'list'} onClick={() => void loadDirectory(currentPath)}>
              <RefreshCw className="size-3.5" aria-hidden />
              {isAr ? 'تحديث' : 'Refresh'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {/* Volume / Root Selector chips */}
          {roots.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {roots.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => void loadDirectory(r.path)}
                  className={clsx(
                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    currentPath.startsWith(r.path)
                      ? 'border-accent bg-accent/15 text-fg'
                      : 'border-line bg-raised text-muted hover:text-fg',
                  )}
                >
                  <HardDrive className="size-3.5" aria-hidden />
                  <span dir="ltr" className="mono">
                    {r.name}
                  </span>
                  <span className="text-[11px] text-faint">({r.label})</span>
                </button>
              ))}
            </div>
          )}

          {/* Path navigation bar + Search bar */}
          <div className="grid gap-2 md:grid-cols-[1fr_280px]">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pathInput.trim()) void loadDirectory(pathInput.trim());
              }}
              className="flex items-center gap-1.5"
            >
              <Button
                type="button"
                size="sm"
                disabled={!online || !parentPath}
                onClick={() => parentPath && void loadDirectory(parentPath)}
                title={isAr ? 'المجلد الأعلى' : 'Up one level'}
              >
                <ArrowUp className="size-3.5" aria-hidden />
              </Button>
              <Input
                dir="ltr"
                className="mono flex-1"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder="C:\Users or /var/log"
              />
              <Button type="submit" size="sm" disabled={!online || !pathInput.trim()} busy={busy === 'list'}>
                {isAr ? 'انتقال' : 'Go'}
              </Button>
            </form>

            <form onSubmit={handleSearch} className="flex items-center gap-1.5">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isAr ? 'بحث في المجلد الحالي…' : 'Search in current folder…'}
              />
              <Button type="submit" size="sm" disabled={!online || !searchQuery.trim()} busy={busy === 'search'}>
                <Search className="size-3.5" aria-hidden />
              </Button>
            </form>
          </div>

          {/* Action Toolbar */}
          {canWrite && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg/60 p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" disabled={!online || !currentPath} busy={busy === 'mkdir'} onClick={() => void handleMkdir()}>
                  <FolderPlus className="size-3.5" aria-hidden />
                  {isAr ? 'مجلد جديد' : 'New Folder'}
                </Button>
                <Button size="sm" disabled={!online || !currentPath} busy={busy === 'touch'} onClick={() => void handleNewFile()}>
                  <FilePlus className="size-3.5" aria-hidden />
                  {isAr ? 'ملف نصي' : 'New File'}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUploadFile(f);
                    e.target.value = '';
                  }}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!online || !currentPath}
                  busy={busy === 'upload'}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="size-3.5" aria-hidden />
                  {isAr ? 'رفع ملف للجهاز' : 'Upload File'}
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={() => setClipboard({ mode: 'copy', paths: Array.from(selected) })}
                >
                  <Copy className="size-3.5" aria-hidden />
                  {isAr ? `نسخ (${selected.size})` : `Copy (${selected.size})`}
                </Button>
                <Button
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={() => setClipboard({ mode: 'move', paths: Array.from(selected) })}
                >
                  <Scissors className="size-3.5" aria-hidden />
                  {isAr ? `قص (${selected.size})` : `Cut (${selected.size})`}
                </Button>
                {clipboard && (
                  <Button size="sm" variant="primary" disabled={!online} busy={busy === 'paste'} onClick={() => void handlePaste()}>
                    <ClipboardPaste className="size-3.5" aria-hidden />
                    {isAr ? `لصق (${clipboard.paths.length})` : `Paste (${clipboard.paths.length})`}
                  </Button>
                )}
                {canDelete && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!online || selected.size === 0}
                    busy={busy === 'delete'}
                    onClick={() => void handleDelete(Array.from(selected))}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {isAr ? `حذف (${selected.size})` : `Delete (${selected.size})`}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* File Table */}
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-start text-xs">
              <thead className="border-b border-line bg-raised/60 text-muted">
                <tr>
                  <th className="w-10 px-3 py-2.5 text-center">
                    <input
                      type="checkbox"
                      checked={sortedEntries.length > 0 && selected.size === sortedEntries.length}
                      onChange={(e) => {
                        if (e.target.checked) setSelected(new Set(sortedEntries.map((x) => x.path)));
                        else setSelected(new Set());
                      }}
                    />
                  </th>
                  <th className="px-3 py-2.5 text-start font-medium">
                    <button type="button" onClick={() => setSortBy('name')} className="hover:text-fg">
                      {isAr ? 'الاسم' : 'Name'} {sortBy === 'name' ? '▾' : ''}
                    </button>
                  </th>
                  <th className="w-28 px-3 py-2.5 text-end font-medium">
                    <button type="button" onClick={() => setSortBy('size')} className="hover:text-fg">
                      {isAr ? 'الحجم' : 'Size'} {sortBy === 'size' ? '▾' : ''}
                    </button>
                  </th>
                  <th className="w-32 px-3 py-2.5 text-start font-medium">{isAr ? 'الصلاحيات' : 'Permissions'}</th>
                  <th className="w-40 px-3 py-2.5 text-start font-medium">
                    <button type="button" onClick={() => setSortBy('mod_time')} className="hover:text-fg">
                      {isAr ? 'آخر تعديل' : 'Modified'} {sortBy === 'mod_time' ? '▾' : ''}
                    </button>
                  </th>
                  <th className="w-44 px-3 py-2.5 text-end font-medium">{isAr ? 'إجراءات' : 'Actions'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sortedEntries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted">
                      {online
                        ? isAr
                          ? 'المجلد فارغ أو اضغط "الأقراص" لتصفح الجهاز'
                          : 'Folder is empty or click "Volumes" to browse endpoint storage'
                        : isAr
                          ? 'الجهاز غير متصل حالياً'
                          : 'Endpoint is currently offline'}
                    </td>
                  </tr>
                ) : (
                  sortedEntries.map((entry) => (
                    <tr key={entry.path} className={clsx('hover:bg-raised/40', selected.has(entry.path) && 'bg-accent/10')}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={selected.has(entry.path)}
                          onChange={() => toggleSelect(entry.path)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {entry.is_dir ? (
                            <Folder className="size-4 shrink-0 text-amber-400" aria-hidden />
                          ) : (
                            <FileIcon className="size-4 shrink-0 text-sky-400" aria-hidden />
                          )}
                          {entry.is_dir ? (
                            <button
                              type="button"
                              dir="ltr"
                              onClick={() => void loadDirectory(entry.path)}
                              className="mono font-medium text-fg hover:text-accent-hover hover:underline text-start"
                            >
                              {entry.name}
                            </button>
                          ) : (
                            <span dir="ltr" className="mono text-fg">
                              {entry.name}
                            </span>
                          )}
                          {entry.is_hidden && <Badge tone="idle">hidden</Badge>}
                          {entry.is_system && <Badge tone="warn">system</Badge>}
                        </div>
                      </td>
                      <td dir="ltr" className="mono px-3 py-2 text-end text-muted">
                        {entry.is_dir ? '—' : formatBytes(entry.size)}
                      </td>
                      <td dir="ltr" className="mono px-3 py-2 text-faint">
                        {entry.mode}
                      </td>
                      <td className="px-3 py-2 text-muted">{relativeTime(entry.mod_time, locale)}</td>
                      <td className="px-3 py-2 text-end">
                        <div className="inline-flex items-center gap-1">
                          {!entry.is_dir && (
                            <Button
                              size="sm"
                              disabled={!online}
                              busy={busy === `dl-${entry.path}`}
                              onClick={() => void handleDownload(entry)}
                              title={isAr ? 'تحميل الملف' : 'Download'}
                            >
                              <Download className="size-3.5" aria-hidden />
                            </Button>
                          )}
                          {canWrite && (
                            <Button
                              size="sm"
                              disabled={!online}
                              busy={busy === `rename-${entry.path}`}
                              onClick={() => void handleRename(entry)}
                              title={isAr ? 'إعادة تسمية' : 'Rename'}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={!online}
                              onClick={() => void handleDelete([entry.path])}
                              title={isAr ? 'حذف' : 'Delete'}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}

