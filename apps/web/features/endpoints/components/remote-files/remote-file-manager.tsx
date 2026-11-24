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
import { Badge, Button, Card, ErrorNote, Input } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { formatBytes } from './file-utils';
import { OverwriteDialog } from './overwrite-dialog';
import type { RemoteFileEntry } from '@nigafiy/shared-types';
import { type RemoteFileManagerProps, useRemoteFiles } from './use-remote-files';

export function RemoteFileManager(props: RemoteFileManagerProps) {
  const files = useRemoteFiles(props);
  return <RemoteFilePane {...props} files={files} />;
}

export interface RemoteFilePaneProps extends RemoteFileManagerProps {
  files: ReturnType<typeof useRemoteFiles>;
  /** Two-pane mode: downloads and uploads go through the transfer queue instead of running here. */
  onQueueDownload?: (entry: RemoteFileEntry) => void;
  onQueueUpload?: (files: File[]) => void;
}

/** The remote pane: browse, search and manage the computer's files (the agent's path guards apply). */
export function RemoteFilePane(props: RemoteFilePaneProps) {
  const { ep, online, canWrite, canUpload, canDelete, onQueueDownload, onQueueUpload } = props;
  const { overwritePrompt, answerOverwrite, locale, isAr, roots, currentPath, parentPath, pathInput, setPathInput, selected, setSelected, clipboard, setClipboard, showHidden, setShowHidden, searchQuery, setSearchQuery, sortBy, setSortBy, busy, progress, error, notice, cancelRef, fileInputRef, loadDirectory, initRoots, sortedEntries, toggleSelect, handleSearch, handleMkdir, handleNewFile, handleRename, handlePaste, handleDelete, handleDownload, handleUploadFile } = props.files;

  return (
    <div className="space-y-4">
      {overwritePrompt && <OverwriteDialog prompt={overwritePrompt} isAr={isAr} onAnswer={answerOverwrite} />}
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
                aria-label={isAr ? 'مسار المجلد' : 'Directory path'}
                placeholder={isAr ? 'C:\\Users أو /var/log' : 'C:\\Users or /var/log'}
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
                  multiple={Boolean(onQueueUpload)}
                  className="hidden"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    if (onQueueUpload) onQueueUpload(picked);
                    else if (picked[0]) void handleUploadFile(picked[0]);
                    e.target.value = '';
                  }}
                />
                {canUpload && (
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
                )}
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
                      aria-label={isAr ? 'تحديد الكل' : 'Select all'}
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
                          aria-label={entry.name}
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
                          {entry.is_hidden && <Badge tone="idle">{isAr ? 'مخفي' : 'hidden'}</Badge>}
                          {entry.is_system && <Badge tone="warn">{isAr ? 'نظام' : 'system'}</Badge>}
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
                              onClick={() => (onQueueDownload ? onQueueDownload(entry) : void handleDownload(entry))}
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
