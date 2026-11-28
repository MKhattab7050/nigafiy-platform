import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EndpointDetail, RemoteFileEntry, RemoteFileResponse, RemoteFileRoot } from '@nigafiy/shared-types';
import type { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useConfirm } from '@/components/ui';
import { type FsError, fsCall } from './fs-client';
import { crumbsOf, joinRemote } from './paths';
import { transfers } from './transfer-engine';

export { crumbsOf };

export interface RemoteFileManagerProps {
  ep: EndpointDetail;
  online: boolean;
  canWrite: boolean;
  /** Uploading replaces files on the endpoint, so it needs the same role as deleting. */
  canUpload: boolean;
  canDelete: boolean;
}

export type SortKey = 'name' | 'size' | 'mod_time' | 'ext';

const asApiError = (e: unknown): ApiError => {
  const f = e as FsError;
  return { status: f.kind === 'transient' ? 0 : 422, code: f.code || 'fs_op_failed', message: f.message } as ApiError;
};

/** State and file operations of one device's file pane; the component only renders. */
export function useRemoteFiles({ ep, online }: RemoteFileManagerProps) {
  const confirm = useConfirm();
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const ref = useMemo(() => ({ endpointId: ep.id, device: ep.name }), [ep.id, ep.name]);

  const [roots, setRoots] = useState<RemoteFileRoot[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string>('');
  const [pathInput, setPathInput] = useState<string>('');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'move'; paths: string[] } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [sortDesc, setSortDesc] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');

  const runFsOp = useCallback((payload: Record<string, unknown>): Promise<RemoteFileResponse> => fsCall(ep.id, payload), [ep.id]);

  const attempt = useCallback(async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy('');
    }
  }, []);

  const loadDirectory = useCallback(
    async (targetPath: string, hidden = showHidden) => {
      if (!online) return;
      await attempt('list', async () => {
        const res = await runFsOp({ op: 'list', path: targetPath || undefined, show_hidden: hidden });
        setCurrentPath(res.path ?? targetPath);
        setPathInput(res.path ?? targetPath);
        setParentPath(res.parent_path ?? '');
        setEntries(res.entries ?? []);
        setSearching(false);
        setSelected(new Set());
        anchor.current = null;
      });
    },
    [attempt, online, runFsOp, showHidden],
  );

  const initRoots = useCallback(async () => {
    if (!online) return;
    await attempt('roots', async () => {
      const res = await runFsOp({ op: 'roots' });
      const rList = res.roots ?? [];
      setRoots(rList);
      if (rList.length > 0) {
        const homeOrFirst = rList.find((r) => r.name === 'Home')?.path ?? rList[0]!.path;
        const r = await runFsOp({ op: 'list', path: homeOrFirst, show_hidden: showHidden });
        setCurrentPath(r.path ?? homeOrFirst);
        setPathInput(r.path ?? homeOrFirst);
        setParentPath(r.parent_path ?? '');
        setEntries(r.entries ?? []);
      }
    });
  }, [attempt, online, runFsOp, showHidden]);

  useEffect(() => {
    if (online && roots.length === 0 && !currentPath) void initRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, ep.id]);

  // A transfer that finished into the open folder refreshes it.
  const cur = useRef('');
  cur.current = currentPath;
  useEffect(
    () =>
      transfers.onRemoteChanged((endpointId, dir) => {
        if (endpointId === ep.id && dir && cur.current && dir.toLowerCase() === cur.current.replace(/[\\/]$/, '').toLowerCase()) void loadDirectory(cur.current);
      }),
    [ep.id, loadDirectory],
  );

  const sortedEntries = useMemo(() => {
    const copy = [...entries];
    const dir = sortDesc ? -1 : 1;
    copy.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let c = 0;
      if (sortBy === 'size') c = a.size - b.size;
      else if (sortBy === 'mod_time') c = a.mod_time.localeCompare(b.mod_time);
      else if (sortBy === 'ext') c = a.ext.localeCompare(b.ext);
      if (c === 0) c = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { numeric: true });
      return c * dir;
    });
    return copy;
  }, [entries, sortBy, sortDesc]);

  const sortOn = (k: SortKey) => {
    if (k === sortBy) setSortDesc((d) => !d);
    else {
      setSortBy(k);
      setSortDesc(k === 'size' || k === 'mod_time');
    }
  };

  /** Click: one item; Ctrl/⌘: add or remove; Shift: the range from the last click. */
  function selectClick(path: string, e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
    if (e.shiftKey && anchor.current) {
      const ids = sortedEntries.map((x) => x.path);
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(ids.slice(lo, hi + 1)));
        return;
      }
    }
    anchor.current = path;
    if (e.ctrlKey || e.metaKey) toggleSelect(path);
    else setSelected(new Set([path]));
  }

  function toggleSelect(path: string) {
    anchor.current = path;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const selectedEntries = useMemo(() => sortedEntries.filter((e) => selected.has(e.path)), [sortedEntries, selected]);

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!searchQuery.trim() || !currentPath) return;
    await attempt('search', async () => {
      const res = await runFsOp({ op: 'search', path: currentPath, query: searchQuery.trim(), show_hidden: showHidden });
      setEntries(res.entries ?? []);
      setSearching(true);
      setSelected(new Set());
      setNotice(isAr ? `تم العثور على ${(res.entries ?? []).length} نتيجة في ${currentPath} ومجلداته الفرعية` : `Found ${(res.entries ?? []).length} item(s) in ${currentPath} and its subfolders`);
    });
  }

  async function handleMkdir() {
    const folderName = window.prompt(isAr ? 'اسم المجلد الجديد:' : 'New folder name:');
    if (!folderName?.trim() || !currentPath) return;
    await attempt('mkdir', async () => {
      await runFsOp({ op: 'mkdir', path: joinRemote(currentPath, folderName.trim()) });
      await loadDirectory(currentPath);
    });
  }

  async function handleNewFile() {
    const fileName = window.prompt(isAr ? 'اسم الملف الجديد (مثال: notes.txt):' : 'New file name (e.g. notes.txt):');
    if (!fileName?.trim() || !currentPath) return;
    const content = window.prompt(isAr ? 'محتوى الملف النصي (اختياري):' : 'Initial text content (optional):') ?? '';
    await attempt('touch', async () => {
      const b64 = btoa(unescape(encodeURIComponent(content)));
      await runFsOp({ op: 'touch', path: joinRemote(currentPath, fileName.trim()), data_base64: b64 });
      await loadDirectory(currentPath);
    });
  }

  async function handleRename(entry: RemoteFileEntry) {
    const newName = window.prompt(isAr ? 'الاسم الجديد:' : 'Rename to:', entry.name);
    if (!newName?.trim() || newName.trim() === entry.name) return;
    await attempt(`rename-${entry.path}`, async () => {
      await runFsOp({ op: 'rename', path: entry.path, new_name: newName.trim() });
      await loadDirectory(currentPath);
    });
  }

  async function handlePaste() {
    if (!clipboard || clipboard.paths.length === 0 || !currentPath) return;
    await attempt('paste', async () => {
      await runFsOp({ op: clipboard.mode, paths: clipboard.paths, target_path: currentPath });
      if (clipboard.mode === 'move') setClipboard(null);
      await loadDirectory(currentPath);
    });
  }

  async function handleDelete(paths: string[]) {
    if (paths.length === 0) return;
    const msg = isAr
      ? `تحذير: هل أنت متأكد من حذف ${paths.length} عنصر نهائياً من ${ep.name}؟ لا يمكن التراجع عن ذلك.`
      : `Permanently delete ${paths.length} item(s) on ${ep.name}? This cannot be undone.`;
    if (!(await confirm(msg, { destructive: true }))) return;
    await attempt('delete', async () => {
      for (let i = 0; i < paths.length; i += 100) await runFsOp({ op: 'delete', paths: paths.slice(i, i + 100), confirm_destructive: true });
      await loadDirectory(currentPath);
    });
  }

  return {
    ref,
    locale,
    isAr,
    roots,
    currentPath,
    parentPath,
    pathInput,
    setPathInput,
    entries,
    searching,
    selected,
    setSelected,
    selectedEntries,
    clipboard,
    setClipboard,
    showHidden,
    setShowHidden,
    searchQuery,
    setSearchQuery,
    sortBy,
    sortDesc,
    sortOn,
    busy,
    setBusy,
    error,
    setError,
    notice,
    setNotice,
    runFsOp,
    attempt,
    loadDirectory,
    initRoots,
    sortedEntries,
    toggleSelect,
    selectClick,
    handleSearch,
    handleMkdir,
    handleNewFile,
    handleRename,
    handlePaste,
    handleDelete,
  };
}

export type RemoteFiles = ReturnType<typeof useRemoteFiles>;
