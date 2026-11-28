'use client';

import clsx from 'clsx';
import {
  ArrowLeftRight,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  FileArchive,
  FilePlus,
  Folder,
  FolderInput,
  FolderPlus,
  HardDrive,
  Info,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteFileEntry } from '@nigafiy/shared-types';
import { Badge, Button, Card, ErrorNote, Input, Modal } from '@/components/ui';
import { absoluteTime, relativeTime } from '@/lib/format';
import { ltr } from '@/lib/localize/bidi';
import { formatBytes } from './file-utils';
import { fsRead } from './fs-client';
import { type LocalSelection, canWriteToDisk, downloadItems, folderSize, fromDrop, fromInput, pickLocalFolder, uploadItems } from './transfer-plans';
import { transferText } from './transfer-text';
import { type RemoteFileManagerProps, type RemoteFiles, type SortKey, crumbsOf, useRemoteFiles } from './use-remote-files';

/** Rows dragged from a pane carry this (a copy to the other device's pane). */
export const DRAG_TYPE = 'application/x-nigafiy-files';
export interface DragPayload {
  endpointId: string;
  device: string;
  entries: RemoteFileEntry[];
}

export function RemoteFileManager(props: RemoteFileManagerProps) {
  const files = useRemoteFiles(props);
  return <RemoteFilePane {...props} files={files} />;
}

export interface RemoteFilePaneProps extends RemoteFileManagerProps {
  files: RemoteFiles;
  /** The other pane is a device: copy the selection there (its name is on the button). */
  other?: { device: string; folder: string; onCopy: (entries: RemoteFileEntry[]) => void };
  /** Rows dropped here from the other device's pane. */
  onDropRemote?: (payload: DragPayload) => void;
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const TEXT = new Set(['txt', 'log', 'md', 'json', 'xml', 'csv', 'ini', 'conf', 'cfg', 'yaml', 'yml', 'ps1', 'psm1', 'sh', 'bat', 'cmd', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'go', 'py', 'kt', 'java', 'c', 'h', 'cpp', 'cs', 'sql', 'toml', 'env', 'reg', 'inf']);
const PREVIEW_MAX = 25 * 1024 * 1024;
const canPreview = (e: RemoteFileEntry) => !e.is_dir && ((IMAGE.has(e.ext) && e.size <= PREVIEW_MAX) || TEXT.has(e.ext) || (e.ext === 'pdf' && e.size <= PREVIEW_MAX));

const text = {
  en: {
    title: 'Files',
    hidden: 'Show hidden',
    volumes: 'Drives',
    refresh: 'Refresh',
    up: 'Up one level',
    editPath: 'Type a path',
    go: 'Go',
    searchPh: 'Search this folder and its subfolders…',
    clearSearch: 'Back to the folder',
    newFolder: 'New folder',
    newFile: 'New file',
    uploadFiles: 'Upload files',
    uploadFolder: 'Upload folder',
    download: 'Download',
    zip: 'As ZIP',
    copyTo: (d: string) => `Copy to ${d}`,
    copy: 'Copy',
    cut: 'Cut',
    paste: 'Paste',
    del: 'Delete',
    rename: 'Rename',
    open: 'Open',
    preview: 'Preview',
    props: 'Properties',
    name: 'Name',
    size: 'Size',
    type: 'Type',
    modified: 'Modified',
    perms: 'Permissions',
    folder: 'Folder',
    empty: 'This folder is empty. Drop files or folders here to upload them.',
    offline: 'The device is offline.',
    items: (n: number) => `${n} item(s)`,
    selectedN: (n: number, s: string) => `${n} selected${s ? ` · ${s}` : ''}`,
    dropHere: 'Drop to upload into this folder',
    dropCopy: (d: string) => `Drop to copy from ${d} into this folder`,
    policy: 'The policy limits this device to:',
    diskNote: 'Downloads are written straight to a folder you choose, any size.',
    memNote: 'This browser keeps downloads in memory: use Chrome or Edge for very large files.',
    keys: 'Keys: Enter open · Backspace up · Del delete · F2 rename · F5 refresh · Ctrl+A/C/X/V',
    walkFailed: 'Could not read the folder',
    previewTooBig: 'Too large to preview: download it instead.',
    loading: 'Loading…',
    path: 'Path',
    contains: 'Contains',
    filesDirs: (f: number, d: number) => `${f} file(s), ${d} folder(s)`,
    attrs: 'Attributes',
    calc: 'Calculate size',
  },
  ar: {
    title: 'الملفات',
    hidden: 'إظهار المخفي',
    volumes: 'الأقراص',
    refresh: 'تحديث',
    up: 'المجلد الأعلى',
    editPath: 'كتابة مسار',
    go: 'انتقال',
    searchPh: 'بحث في هذا المجلد ومجلداته الفرعية…',
    clearSearch: 'العودة إلى المجلد',
    newFolder: 'مجلد جديد',
    newFile: 'ملف جديد',
    uploadFiles: 'رفع ملفات',
    uploadFolder: 'رفع مجلد',
    download: 'تنزيل',
    zip: 'كملف ZIP',
    copyTo: (d: string) => `نسخ إلى ${d}`,
    copy: 'نسخ',
    cut: 'قص',
    paste: 'لصق',
    del: 'حذف',
    rename: 'إعادة تسمية',
    open: 'فتح',
    preview: 'معاينة',
    props: 'الخصائص',
    name: 'الاسم',
    size: 'الحجم',
    type: 'النوع',
    modified: 'آخر تعديل',
    perms: 'الصلاحيات',
    folder: 'مجلد',
    empty: 'هذا المجلد فارغ. أفلت ملفات أو مجلدات هنا لرفعها.',
    offline: 'الجهاز غير متصل.',
    items: (n: number) => `${n} عنصر`,
    selectedN: (n: number, s: string) => `${n} محدد${s ? ` · ${s}` : ''}`,
    dropHere: 'أفلت للرفع إلى هذا المجلد',
    dropCopy: (d: string) => `أفلت للنسخ من ${d} إلى هذا المجلد`,
    policy: 'السياسة تقيّد هذا الجهاز بالمسارات:',
    diskNote: 'تُكتب التنزيلات مباشرة في مجلد تختاره، مهما كان الحجم.',
    memNote: 'هذا المتصفح يحتفظ بالتنزيلات في الذاكرة: استخدم Chrome أو Edge للملفات الكبيرة جدًا.',
    keys: 'المفاتيح: Enter فتح · Backspace للأعلى · Del حذف · F2 إعادة تسمية · F5 تحديث · Ctrl+A/C/X/V',
    walkFailed: 'تعذرت قراءة المجلد',
    previewTooBig: 'أكبر من أن يُعاين: نزّله بدلًا من ذلك.',
    loading: 'جارٍ التحميل…',
    path: 'المسار',
    contains: 'يحتوي',
    filesDirs: (f: number, d: number) => `${f} ملف، ${d} مجلد`,
    attrs: 'السمات',
    calc: 'حساب الحجم',
  },
};

interface Menu {
  x: number;
  y: number;
  entry: RemoteFileEntry | null;
}

/** One device's files: browse, search, manage, and send files and folders to and from it. */
export function RemoteFilePane(props: RemoteFilePaneProps) {
  const { ep, online, canWrite, canUpload, canDelete, other, onDropRemote, files: f } = props;
  const t = f.isAr ? text.ar : text.en;
  const tt = transferText(f.isAr);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [preview, setPreview] = useState<RemoteFileEntry | null>(null);
  const [propsOf, setPropsOf] = useState<RemoteFileEntry | null>(null);
  const [dropping, setDropping] = useState<'' | 'local' | 'remote'>('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const canTransfer = canWrite; // technician: copy files off the device
  const crumbs = useMemo(() => crumbsOf(f.currentPath), [f.currentPath]);
  const selectedBytes = f.selectedEntries.reduce((n, e) => n + (e.is_dir ? 0 : e.size), 0);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const run = async (label: string, fn: () => Promise<{ cancelled?: boolean; truncated?: boolean; memoryWarning?: boolean; files: number; bytes: number }>) => {
    f.setError(null);
    f.setBusy('plan');
    f.setNotice(tt.walking);
    try {
      const r = await fn();
      if (r.cancelled) f.setNotice('');
      else f.setNotice([tt.queuedN(r.files, formatBytes(r.bytes)), r.truncated ? tt.truncated : '', r.memoryWarning ? tt.memoryWarn : ''].filter(Boolean).join(' '));
    } catch (err) {
      f.setNotice('');
      f.setError({ status: 422, code: 'fs_op_failed', message: `${t.walkFailed}: ${(err as Error).message}` } as never);
    } finally {
      f.setBusy('');
    }
    void label;
  };

  const download = (entries: RemoteFileEntry[], asZip = false) => {
    if (!entries.length) return;
    const label = entries.length === 1 ? entries[0]!.name : `${entries.length} × ${ep.name}`;
    void run('download', () => downloadItems(f.ref, entries, { asZip, showHidden: f.showHidden, label }));
  };
  const upload = (sel: LocalSelection) => {
    if (!sel.files.length && !sel.dirs.length) return;
    if (!f.currentPath) return;
    const top = new Set(sel.files.map((x) => x.rel.split('/')[0]!).concat(sel.dirs.map((d) => d.split('/')[0]!)));
    const label = top.size === 1 ? [...top][0]! : `${sel.files.length} → ${ep.name}`;
    void run('upload', () => uploadItems(f.ref, f.currentPath, sel, label));
  };
  const uploadFolder = async () => {
    const picked = await pickLocalFolder().catch(() => null);
    if (picked) upload(picked);
    else folderInput.current?.click();
  };

  const open = (e: RemoteFileEntry) => {
    if (e.is_dir) void f.loadDirectory(e.path);
    else if (canPreview(e)) setPreview(e);
    else if (canTransfer) download([e]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,select')) return;
    const sel = f.selectedEntries;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' && canDelete && sel.length) void f.handleDelete(sel.map((x) => x.path));
    else if (e.key === 'F2' && canWrite && sel.length === 1) void f.handleRename(sel[0]!);
    else if (e.key === 'F5') void f.loadDirectory(f.currentPath);
    else if (e.key === 'Enter' && sel.length === 1) open(sel[0]!);
    else if (e.key === 'Backspace' && f.parentPath) void f.loadDirectory(f.parentPath);
    else if (e.key === 'Escape') f.setSelected(new Set());
    else if (mod && e.key.toLowerCase() === 'a') f.setSelected(new Set(f.sortedEntries.map((x) => x.path)));
    else if (mod && e.key.toLowerCase() === 'c' && sel.length) f.setClipboard({ mode: 'copy', paths: sel.map((x) => x.path) });
    else if (mod && e.key.toLowerCase() === 'x' && sel.length && canWrite) f.setClipboard({ mode: 'move', paths: sel.map((x) => x.path) });
    else if (mod && e.key.toLowerCase() === 'v' && f.clipboard && canWrite) void f.handlePaste();
    else return;
    e.preventDefault();
  };

  const onDragOver = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (types.includes(DRAG_TYPE) && onDropRemote) {
      e.preventDefault();
      setDropping('remote');
    } else if (types.includes('Files') && canUpload && f.currentPath) {
      e.preventDefault();
      setDropping('local');
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping('');
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw && onDropRemote) {
      const p = JSON.parse(raw) as DragPayload;
      if (p.endpointId !== ep.id) onDropRemote(p);
      return;
    }
    if (canUpload && f.currentPath && e.dataTransfer.files.length) upload(await fromDrop(e.dataTransfer));
  };

  const sortHead = (k: SortKey, label: string, cls = '') => (
    <th className={clsx('px-2 py-2.5 font-medium sm:px-3', cls)} aria-sort={f.sortBy === k ? (f.sortDesc ? 'descending' : 'ascending') : undefined}>
      <button type="button" onClick={() => f.sortOn(k)} className="hover:text-fg">
        {label} {f.sortBy === k ? (f.sortDesc ? '▾' : '▴') : ''}
      </button>
    </th>
  );

  const menuItems = (entry: RemoteFileEntry | null) => {
    const target = entry && !f.selected.has(entry.path) ? [entry] : f.selectedEntries;
    const items: { label: string; icon: React.ReactNode; on: () => void; danger?: boolean; hide?: boolean }[] = [
      { label: t.open, icon: <Folder className="size-3.5" />, on: () => entry && open(entry), hide: !entry || !entry.is_dir },
      { label: t.preview, icon: <Eye className="size-3.5" />, on: () => entry && setPreview(entry), hide: !entry || !canPreview(entry) },
      { label: t.download, icon: <Download className="size-3.5" />, on: () => download(target), hide: !canTransfer || !target.length },
      { label: `${t.download} ${t.zip}`, icon: <FileArchive className="size-3.5" />, on: () => download(target, true), hide: !canTransfer || !target.length },
      { label: other ? t.copyTo(other.device) : '', icon: <ArrowLeftRight className="size-3.5" />, on: () => other?.onCopy(target), hide: !other || !target.length },
      { label: t.copy, icon: <Copy className="size-3.5" />, on: () => f.setClipboard({ mode: 'copy', paths: target.map((x) => x.path) }), hide: !canWrite || !target.length },
      { label: t.cut, icon: <Scissors className="size-3.5" />, on: () => f.setClipboard({ mode: 'move', paths: target.map((x) => x.path) }), hide: !canWrite || !target.length },
      { label: t.paste, icon: <ClipboardPaste className="size-3.5" />, on: () => void f.handlePaste(), hide: !canWrite || !f.clipboard },
      { label: t.rename, icon: <Pencil className="size-3.5" />, on: () => entry && void f.handleRename(entry), hide: !canWrite || !entry },
      { label: t.newFolder, icon: <FolderPlus className="size-3.5" />, on: () => void f.handleMkdir(), hide: !canWrite || Boolean(entry) },
      { label: t.props, icon: <Info className="size-3.5" />, on: () => entry && setPropsOf(entry), hide: !entry },
      { label: t.del, icon: <Trash2 className="size-3.5" />, on: () => void f.handleDelete(target.map((x) => x.path)), danger: true, hide: !canDelete || !target.length },
    ];
    return items.filter((i) => !i.hide);
  };

  return (
    <div className="min-w-0 space-y-3">
      {f.error && <ErrorNote error={f.error} />}
      {f.notice && (
        <p role="status" className="flex items-start justify-between gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-fg">
          <span>{f.notice}</span>
          <button type="button" onClick={() => f.setNotice('')} aria-label="×" className="text-muted hover:text-fg">
            <X className="size-3.5" aria-hidden />
          </button>
        </p>
      )}
      {ep.policy?.allowed_fs_roots && ep.policy.allowed_fs_roots.length > 0 && (
        <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-muted">
          <strong className="text-fg">{t.policy}</strong>{' '}
          <span dir="ltr" className="mono break-all">
            {ep.policy.allowed_fs_roots.join(', ')}
          </span>
        </div>
      )}

      <Card
        title={`${t.title} · ${ep.name}`}
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1.5 px-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={f.showHidden}
                onChange={(e) => {
                  f.setShowHidden(e.target.checked);
                  if (f.currentPath) void f.loadDirectory(f.currentPath, e.target.checked);
                }}
              />
              {t.hidden}
            </label>
            <Button size="sm" disabled={!online} busy={f.busy === 'roots'} onClick={() => void f.initRoots()}>
              <HardDrive className="size-3.5" aria-hidden />
              {t.volumes}
            </Button>
            <Button size="sm" disabled={!online || !f.currentPath} busy={f.busy === 'list'} onClick={() => void f.loadDirectory(f.currentPath)} title={`${t.refresh} (F5)`}>
              <RefreshCw className="size-3.5" aria-hidden />
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          {f.roots.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {f.roots.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => void f.loadDirectory(r.path)}
                  className={clsx(
                    'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    f.currentPath.toLowerCase().startsWith(r.path.toLowerCase()) ? 'border-accent bg-accent/15 text-fg' : 'border-line bg-raised text-muted hover:text-fg',
                  )}
                >
                  <HardDrive className="size-3.5" aria-hidden />
                  <span dir="ltr" className="mono">
                    {r.name}
                  </span>
                  <span className="min-w-0 truncate text-[11px] text-faint">({r.label})</span>
                </button>
              ))}
            </div>
          )}

          {/* Breadcrumbs (or a typed path) and search */}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex min-w-0 items-center gap-1.5">
              <Button type="button" size="sm" disabled={!online || !f.parentPath} onClick={() => f.parentPath && void f.loadDirectory(f.parentPath)} title={`${t.up} (Backspace)`} aria-label={t.up}>
                <ArrowUp className="size-3.5" aria-hidden />
              </Button>
              {editing ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setEditing(false);
                    if (f.pathInput.trim()) void f.loadDirectory(f.pathInput.trim());
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                >
                  <Input dir="ltr" autoFocus className="mono flex-1" value={f.pathInput} onChange={(e) => f.setPathInput(e.target.value)} onBlur={() => setEditing(false)} aria-label={t.editPath} />
                  <Button type="submit" size="sm" onMouseDown={(e) => e.preventDefault()}>
                    {t.go}
                  </Button>
                </form>
              ) : (
                <nav
                  aria-label={t.path}
                  dir="ltr"
                  className="flex min-w-0 flex-1 cursor-text items-center overflow-x-auto rounded-md border border-line bg-bg px-1.5 py-1 text-xs"
                  onClick={(e) => e.target === e.currentTarget && setEditing(true)}
                >
                  {crumbs.map((c, i) => (
                    <span key={c.path} className="flex shrink-0 items-center">
                      {i > 0 && <ChevronRight className="size-3 text-faint" aria-hidden />}
                      <button type="button" onClick={() => void f.loadDirectory(c.path)} className={clsx('mono rounded px-1 py-0.5 hover:bg-raised hover:text-fg', i === crumbs.length - 1 ? 'font-semibold text-fg' : 'text-muted')}>
                        {c.name}
                      </button>
                    </span>
                  ))}
                  <button type="button" onClick={() => setEditing(true)} className="ms-auto shrink-0 rounded p-1 text-faint hover:text-fg" title={t.editPath} aria-label={t.editPath}>
                    <Pencil className="size-3" aria-hidden />
                  </button>
                </nav>
              )}
            </div>
            <form onSubmit={(e) => void f.handleSearch(e)} className="flex min-w-0 items-center gap-1.5">
              <Input value={f.searchQuery} onChange={(e) => f.setSearchQuery(e.target.value)} placeholder={t.searchPh} />
              <Button type="submit" size="sm" disabled={!online || !f.searchQuery.trim()} busy={f.busy === 'search'} aria-label={t.searchPh}>
                <Search className="size-3.5" aria-hidden />
              </Button>
              {f.searching && (
                <Button type="button" size="sm" onClick={() => void f.loadDirectory(f.currentPath)} title={t.clearSearch} aria-label={t.clearSearch}>
                  <X className="size-3.5" aria-hidden />
                </Button>
              )}
            </form>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg/60 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {canWrite && (
                <>
                  <Button size="sm" disabled={!online || !f.currentPath} busy={f.busy === 'mkdir'} onClick={() => void f.handleMkdir()}>
                    <FolderPlus className="size-3.5" aria-hidden />
                    {t.newFolder}
                  </Button>
                  <Button size="sm" disabled={!online || !f.currentPath} busy={f.busy === 'touch'} onClick={() => void f.handleNewFile()}>
                    <FilePlus className="size-3.5" aria-hidden />
                    {t.newFile}
                  </Button>
                </>
              )}
              {canUpload && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      upload(fromInput(e.target.files ?? []));
                      e.target.value = '';
                    }}
                  />
                  <input
                    ref={folderInput}
                    type="file"
                    multiple
                    className="hidden"
                    {...({ webkitdirectory: '' } as object)}
                    onChange={(e) => {
                      upload(fromInput(e.target.files ?? []));
                      e.target.value = '';
                    }}
                  />
                  <Button size="sm" variant="primary" disabled={!online || !f.currentPath} onClick={() => fileInput.current?.click()}>
                    <Upload className="size-3.5" aria-hidden />
                    {t.uploadFiles}
                  </Button>
                  <Button size="sm" disabled={!online || !f.currentPath} onClick={() => void uploadFolder()}>
                    <FolderInput className="size-3.5" aria-hidden />
                    {t.uploadFolder}
                  </Button>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {canTransfer && (
                <>
                  <Button size="sm" variant="primary" disabled={!online || !f.selected.size} busy={f.busy === 'plan'} onClick={() => download(f.selectedEntries)}>
                    <Download className="size-3.5" aria-hidden />
                    {t.download} {f.selected.size > 0 && `(${f.selected.size})`}
                  </Button>
                  <Button size="sm" disabled={!online || !f.selected.size} onClick={() => download(f.selectedEntries, true)} title={`${t.download} ${t.zip}`}>
                    <FileArchive className="size-3.5" aria-hidden />
                    {t.zip}
                  </Button>
                </>
              )}
              {other && canTransfer && (
                <Button size="sm" variant="primary" disabled={!online || !f.selected.size || !other.folder} onClick={() => other.onCopy(f.selectedEntries)} title={`${other.device}: ${other.folder}`}>
                  <ArrowLeftRight className="size-3.5" aria-hidden />
                  {t.copyTo(other.device)}
                </Button>
              )}
              {canWrite && (
                <>
                  <Button size="sm" disabled={!f.selected.size} onClick={() => f.setClipboard({ mode: 'copy', paths: f.selectedEntries.map((x) => x.path) })} title={`${t.copy} (Ctrl+C)`} aria-label={t.copy}>
                    <Copy className="size-3.5" aria-hidden />
                  </Button>
                  <Button size="sm" disabled={!f.selected.size} onClick={() => f.setClipboard({ mode: 'move', paths: f.selectedEntries.map((x) => x.path) })} title={`${t.cut} (Ctrl+X)`} aria-label={t.cut}>
                    <Scissors className="size-3.5" aria-hidden />
                  </Button>
                  {f.clipboard && (
                    <Button size="sm" variant="primary" disabled={!online} busy={f.busy === 'paste'} onClick={() => void f.handlePaste()}>
                      <ClipboardPaste className="size-3.5" aria-hidden />
                      {t.paste} ({f.clipboard.paths.length})
                    </Button>
                  )}
                </>
              )}
              {canDelete && (
                <Button size="sm" variant="danger" disabled={!online || !f.selected.size} busy={f.busy === 'delete'} onClick={() => void f.handleDelete(f.selectedEntries.map((x) => x.path))} title={`${t.del} (Del)`} aria-label={t.del}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              )}
            </div>
          </div>

          {/* Table: click selects, Ctrl/Shift extend, double-click opens, right-click menu, rows drag to the other pane */}
          <div
            ref={table}
            role="grid"
            aria-multiselectable="true"
            tabIndex={0}
            onKeyDown={onKey}
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping('');
            }}
            onDrop={(e) => void onDrop(e)}
            onContextMenu={(e) => {
              if ((e.target as HTMLElement).closest('tr[data-path]')) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, entry: null });
            }}
            className={clsx('relative max-h-[60vh] overflow-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-accent', dropping ? 'border-accent ring-2 ring-accent/40' : 'border-line')}
            aria-label={t.keys}
          >
            {dropping && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-accent/10 text-sm font-medium text-fg">
                {dropping === 'remote' ? t.dropCopy(other?.device ?? '') : t.dropHere}
              </div>
            )}
            <table className="w-full select-none text-start text-xs">
              <thead className="sticky top-0 z-[1] border-b border-line bg-raised text-muted">
                <tr>
                  <th className="w-8 px-2 py-2.5 text-center sm:w-10 sm:px-3">
                    <input
                      type="checkbox"
                      aria-label="Ctrl+A"
                      checked={f.sortedEntries.length > 0 && f.selected.size === f.sortedEntries.length}
                      onChange={(e) => f.setSelected(e.target.checked ? new Set(f.sortedEntries.map((x) => x.path)) : new Set())}
                    />
                  </th>
                  {sortHead('name', t.name, 'text-start')}
                  {sortHead('size', t.size, 'whitespace-nowrap text-end sm:w-24')}
                  {sortHead('ext', t.type, 'hidden w-20 text-start lg:table-cell')}
                  {sortHead('mod_time', t.modified, 'hidden w-36 text-start sm:table-cell')}
                  <th className="hidden w-28 px-3 py-2.5 text-start font-medium xl:table-cell">{t.perms}</th>
                  <th className="px-2 py-2.5 sm:w-24 sm:px-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {f.sortedEntries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-muted">
                      {online ? t.empty : t.offline}
                    </td>
                  </tr>
                ) : (
                  f.sortedEntries.map((entry) => {
                    const sel = f.selected.has(entry.path);
                    return (
                      <tr
                        key={entry.path}
                        data-path={entry.path}
                        draggable={canTransfer}
                        onDragStart={(e) => {
                          const list = sel ? f.selectedEntries : [entry];
                          const payload: DragPayload = { endpointId: ep.id, device: ep.name, entries: list };
                          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest('button,input,a')) return;
                          f.selectClick(entry.path, e);
                          table.current?.focus();
                        }}
                        onDoubleClick={() => open(entry)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!sel) f.selectClick(entry.path, {});
                          setMenu({ x: e.clientX, y: e.clientY, entry });
                        }}
                        className={clsx('cursor-default hover:bg-raised/40', sel && 'bg-accent/15')}
                        aria-selected={sel}
                      >
                        <td className="px-2 py-1.5 text-center sm:px-3">
                          <input type="checkbox" aria-label={entry.name} checked={sel} onChange={() => f.toggleSelect(entry.path)} />
                        </td>
                        <td className="px-2 py-1.5 sm:px-3">
                          <div className="flex min-w-0 items-center gap-2">
                            {entry.is_dir ? <Folder className="size-4 shrink-0 text-amber-400" aria-hidden /> : <FileIcon className="size-4 shrink-0 text-sky-400" aria-hidden />}
                            <span dir="ltr" title={f.searching ? entry.path : entry.name} className="mono max-w-[11rem] truncate font-medium text-fg sm:max-w-none sm:whitespace-normal sm:break-all">
                              {f.searching ? entry.path : entry.name}
                            </span>
                            {entry.is_hidden && <Badge tone="idle">{f.isAr ? 'مخفي' : 'hidden'}</Badge>}
                            {entry.is_system && <Badge tone="warn">{f.isAr ? 'نظام' : 'system'}</Badge>}
                          </div>
                        </td>
                        <td dir="ltr" className="mono whitespace-nowrap px-2 py-1.5 text-end text-muted sm:px-3">
                          {entry.is_dir ? '—' : formatBytes(entry.size)}
                        </td>
                        <td className="mono hidden px-3 py-1.5 text-faint lg:table-cell">{entry.is_dir ? t.folder : entry.ext || '—'}</td>
                        <td className="hidden px-3 py-1.5 text-muted sm:table-cell" title={absoluteTime(entry.mod_time, f.locale)}>
                          {relativeTime(entry.mod_time, f.locale)}
                        </td>
                        <td dir="ltr" className="mono hidden px-3 py-1.5 text-faint xl:table-cell">
                          {entry.mode}
                        </td>
                        <td className="px-2 py-1.5 text-end sm:px-3">
                          <div className="inline-flex items-center gap-1 whitespace-nowrap">
                            {canTransfer && (
                              <Button size="sm" disabled={!online} onClick={() => download([entry])} title={t.download} aria-label={`${t.download} ${entry.name}`}>
                                <Download className="size-3.5" aria-hidden />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                if (!sel) f.selectClick(entry.path, {});
                                setMenu({ x: r.left, y: r.bottom, entry });
                              }}
                              aria-label={`${t.props}: ${entry.name}`}
                            >
                              ⋯
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-faint">
            <span>
              {t.items(f.sortedEntries.length)}
              {f.selected.size > 0 && ` · ${t.selectedN(f.selected.size, selectedBytes ? formatBytes(selectedBytes) : '')}`}
            </span>
            <span className="hidden md:inline">{t.keys}</span>
            {canTransfer && <span>{canWriteToDisk() ? t.diskNote : t.memNote}</span>}
          </div>
        </div>
      </Card>

      {menu && (
        <div
          role="menu"
          tabIndex={-1}
          onKeyDown={(e) => e.key === 'Escape' && setMenu(null)}
          className="fixed z-50 min-w-48 rounded-md border border-line-strong bg-surface py-1 text-xs shadow-[var(--shadow-overlay)]"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 340) }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuItems(menu.entry).map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                it.on();
              }}
              className={clsx('flex w-full items-center gap-2 px-3 py-1.5 text-start hover:bg-raised focus:bg-raised focus:outline-none', it.danger ? 'text-crit' : 'text-fg')}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
      {preview && <PreviewDialog entry={preview} endpointId={ep.id} isAr={f.isAr} onClose={() => setPreview(null)} onDownload={canTransfer ? () => download([preview]) : undefined} />}
      {propsOf && <PropertiesDialog entry={propsOf} files={f} onClose={() => setPropsOf(null)} />}
    </div>
  );
}

/** Images, PDFs and text files of the device, shown here (read through the same download command). */
function PreviewDialog({ entry, endpointId, isAr, onClose, onDownload }: { entry: RemoteFileEntry; endpointId: string; isAr: boolean; onClose: () => void; onDownload?: () => void }) {
  const t = isAr ? text.ar : text.en;
  const [state, setState] = useState<{ url?: string; text?: string; error?: string; pct: number }>({ pct: 0 });
  useEffect(() => {
    let stop = false;
    let url: string | undefined;
    void (async () => {
      try {
        const isText = TEXT.has(entry.ext);
        const limit = isText ? 1024 * 1024 : PREVIEW_MAX;
        const parts: Uint8Array[] = [];
        let offset = 0;
        while (!stop && offset < Math.min(entry.size, limit)) {
          const { res: r, data: d } = await fsRead(endpointId, { path: entry.path, offset, length: 1024 * 1024 });
          parts.push(d);
          offset += d.length;
          setState((s) => ({ ...s, pct: entry.size ? Math.round((offset * 100) / Math.min(entry.size, limit)) : 100 }));
          if (r.eof || !d.length) break;
        }
        if (stop) return;
        const blob = new Blob(parts as BlobPart[], { type: entry.ext === 'pdf' ? 'application/pdf' : IMAGE.has(entry.ext) ? `image/${entry.ext === 'jpg' ? 'jpeg' : entry.ext}` : 'text/plain' });
        if (isText) setState({ text: await blob.text(), pct: 100 });
        else {
          url = URL.createObjectURL(blob);
          setState({ url, pct: 100 });
        }
      } catch (err) {
        if (!stop) setState({ error: (err as Error).message, pct: 0 });
      }
    })();
    return () => {
      stop = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [endpointId, entry]);
  return (
    <Modal title={entry.name} onClose={onClose} wide>
      <div className="space-y-3">
        {state.error ? (
          <p className="text-xs text-crit">{state.error}</p>
        ) : state.text !== undefined ? (
          <pre dir="ltr" className="mono max-h-[65vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-bg p-3 text-[11.5px] text-fg">
            {state.text}
            {entry.size > 1024 * 1024 && '\n…'}
          </pre>
        ) : state.url ? (
          entry.ext === 'pdf' ? (
            <iframe title={entry.name} src={state.url} className="h-[70vh] w-full rounded-md border border-line" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={state.url} alt={entry.name} className="mx-auto max-h-[70vh] max-w-full rounded-md" />
          )
        ) : (
          <p className="text-xs text-muted">
            {t.loading} {state.pct}%
          </p>
        )}
        <div className="flex justify-between gap-2 text-xs text-muted">
          <span dir="ltr" className="mono truncate">
            {entry.path} · {formatBytes(entry.size)}
          </span>
          {onDownload && (
            <Button size="sm" onClick={onDownload}>
              <Download className="size-3.5" aria-hidden />
              {t.download}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PropertiesDialog({ entry, files: f, onClose }: { entry: RemoteFileEntry; files: RemoteFiles; onClose: () => void }) {
  const t = f.isAr ? text.ar : text.en;
  const [size, setSize] = useState<{ bytes: number; files: number; dirs: number; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const calc = async () => {
    setBusy(true);
    setErr('');
    try {
      setSize(await folderSize(f.ref, entry.path, f.showHidden));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`${t.props}: ${entry.name}`} onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted">{t.path}</dt>
        <dd className="mono break-all" dir="ltr">
          {entry.path}
        </dd>
        <dt className="text-muted">{t.type}</dt>
        <dd>{entry.is_dir ? t.folder : entry.ext || '—'}</dd>
        <dt className="text-muted">{t.size}</dt>
        <dd>
          {!entry.is_dir ? (
            <span className="mono">{ltr(`${formatBytes(entry.size)} (${entry.size.toLocaleString('en')} B)`)}</span>
          ) : size ? (
            <span className="mono">
              {ltr(`${formatBytes(size.bytes)}${size.truncated ? '+' : ''}`)} · {t.filesDirs(size.files, size.dirs)}
            </span>
          ) : (
            <Button size="sm" busy={busy} onClick={() => void calc()}>
              {t.calc}
            </Button>
          )}
          {err && <span className="ms-2 text-crit">{err}</span>}
        </dd>
        <dt className="text-muted">{t.modified}</dt>
        <dd>{absoluteTime(entry.mod_time, f.locale)}</dd>
        <dt className="text-muted">{t.perms}</dt>
        <dd className="mono" dir="ltr">
          {entry.mode}
        </dd>
        <dt className="text-muted">{t.attrs}</dt>
        <dd>{[entry.is_hidden && (f.isAr ? 'مخفي' : 'hidden'), entry.is_system && (f.isAr ? 'نظام' : 'system')].filter(Boolean).join(', ') || '—'}</dd>
      </dl>
    </Modal>
  );
}
