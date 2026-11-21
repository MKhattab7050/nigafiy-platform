import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EndpointCommand, EndpointDetail, RemoteFileEntry, RemoteFileResponse, RemoteFileRoot } from '@lan-detective/shared-types';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { formatBytes, arrayBufferToBase64, base64ToUint8Array } from './file-utils';

export interface RemoteFileManagerProps {
  ep: EndpointDetail;
  online: boolean;
  canWrite: boolean;
  /** Uploading replaces files on the endpoint, so it needs the same role as deleting. */
  canUpload: boolean;
  canDelete: boolean;
}

/** State and file operations of the remote file manager; the component only renders. */
export function useRemoteFiles({ ep, online, canWrite, canUpload, canDelete }: RemoteFileManagerProps) {
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

  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

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
        throw {
          status: 422,
          code: 'fs_op_failed',
          message: cmd.error || (isAr ? 'فشلت عملية الملفات على الجهاز' : 'File operation failed on endpoint'),
        } as ApiError;
      }
      // Poll up to 8 more seconds if the agent took slightly longer
      for (let i = 0; i < 16; i++) {
        if (cancelRef.current) break;
        await new Promise((r) => setTimeout(r, 500));
        if (cancelRef.current) break;
        const detail = await api<EndpointDetail>(`/endpoints/${ep.id}`);
        const found = detail.commands.find((c) => c.id === cmd.id);
        if (found?.status === 'completed' && found.result_data) {
          return found.result_data as unknown as RemoteFileResponse;
        }
        if (found?.status === 'failed') {
          throw {
            status: 422,
            code: 'fs_op_failed',
            message: found.error || (isAr ? 'فشلت عملية الملفات' : 'File operation failed'),
          } as ApiError;
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
        if (cancelRef.current) {
          throw {
            status: 499,
            code: 'cancelled',
            message: isAr ? 'تم إلغاء النقل بواسطة المشغّل' : 'Transfer cancelled by operator',
          } as ApiError;
        }
        const pctVal = entry.size > 0 ? Math.min(99, Math.round((offset * 100) / entry.size)) : 50;
        setProgress({
          label: isAr ? `جارٍ تنزيل ${entry.name}…` : `Downloading ${entry.name}…`,
          pct: pctVal,
        });
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
          ? isAr
            ? `تم تنزيل ${entry.name} (${formatBytes(totalLen)} · SHA-256: ${sha.slice(0, 16)}…)`
            : `Downloaded ${entry.name} (${formatBytes(totalLen)} · SHA-256: ${sha.slice(0, 16)}…)`
          : isAr
            ? `تم تنزيل ${entry.name} (${formatBytes(totalLen)})`
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
          if (cancelRef.current) {
            throw {
              status: 499,
              code: 'cancelled',
              message: isAr ? 'تم إلغاء الرفع بواسطة المشغّل' : 'Upload cancelled by operator',
            } as ApiError;
          }
          const end = Math.min(total, offset + chunkLen);
          const slice = buf.slice(offset, end);
          const b64 = arrayBufferToBase64(slice);
          setProgress({
            label: isAr ? `جارٍ رفع ${file.name}…` : `Uploading ${file.name}…`,
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
      setNotice(isAr ? `تم رفع ${file.name} (${formatBytes(total)})` : `Uploaded ${file.name} (${formatBytes(total)})`);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setProgress(null);
      setBusy('');
    }
  }
  return { locale, isAr, roots, setRoots, currentPath, setCurrentPath, parentPath, setParentPath, pathInput, setPathInput, entries, setEntries, selected, setSelected, clipboard, setClipboard, showHidden, setShowHidden, searchQuery, setSearchQuery, sortBy, setSortBy, busy, setBusy, progress, setProgress, error, setError, notice, setNotice, cancelRef, fileInputRef, runFsOp, loadDirectory, initRoots, sortedEntries, toggleSelect, handleSearch, handleMkdir, handleNewFile, handleRename, handlePaste, handleDelete, handleDownload, handleUploadFile };
}
