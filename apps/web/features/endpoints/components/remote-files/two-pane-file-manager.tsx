'use client';

import clsx from 'clsx';
import { ArrowLeftRight, CheckCircle2, Download, Laptop, Pause, Play, RotateCcw, Upload, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { RemoteFileEntry } from '@nigafiy/shared-types';
import { Badge, Button, Card, useConfirm } from '@/components/ui';
import { ltr } from '@/lib/localize/bidi';
import { formatBytes } from './file-utils';
import { RemoteFilePane } from './remote-file-manager';
import { type RemoteFileManagerProps, useRemoteFiles } from './use-remote-files';
import { type Transfer, type TransferState, useTransferQueue } from './use-transfer-queue';

// Two-pane file manager (Fleet Pro): this browser on one side, the computer on the other, and a
// transfer queue between them. Uploads need the same role as before (admin: they can replace
// files), downloads the technician role; the agent's allowed roots and protected-path guards apply
// to every chunk, and every chunk is audited by name and size (never its contents).

const text = {
  en: {
    local: 'This browser',
    localHint: 'Drop files here or pick them, then send them to the folder open on the computer.',
    pick: 'Pick files…',
    sendTo: 'Send to',
    sendAll: 'Send all',
    remove: 'Remove',
    noFolder: 'Open a folder on the computer first.',
    uploadNeedsAdmin: 'Sending files to a computer needs the admin role (it can replace files).',
    viewer: 'Viewers can browse, not copy files.',
    received: 'Copied to this browser',
    saveAgain: 'Save again',
    queue: 'Transfers',
    empty: 'Nothing queued. Downloads and uploads run here one at a time, are checked with SHA-256, and can resume after a lost connection.',
    clear: 'Clear finished',
    pause: 'Pause',
    resume: 'Resume',
    retry: 'Start again',
    cancel: 'Cancel',
    up: 'to the computer',
    down: 'to this browser',
    verified: 'SHA-256 verified',
    states: {
      queued: 'Queued',
      running: 'Copying',
      paused: 'Paused',
      interrupted: 'Interrupted, can resume',
      verifying: 'Checking SHA-256',
      done: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
    } satisfies Record<TransferState, string>,
    restartAsk: (name: string) => `${name}: the computer cannot continue this upload where it stopped. Start again and replace the partial file?`,
  },
  ar: {
    local: 'هذا المتصفح',
    localHint: 'أفلت الملفات هنا أو اخترها، ثم أرسلها إلى المجلد المفتوح على الحاسوب.',
    pick: 'اختيار ملفات…',
    sendTo: 'إرسال إلى',
    sendAll: 'إرسال الكل',
    remove: 'إزالة',
    noFolder: 'افتح مجلدًا على الحاسوب أولًا.',
    uploadNeedsAdmin: 'إرسال الملفات إلى حاسوب يتطلب دور المسؤول (قد يستبدل ملفات).',
    viewer: 'يمكن للمشاهدين التصفح فقط، لا نسخ الملفات.',
    received: 'نُسخت إلى هذا المتصفح',
    saveAgain: 'حفظ مرة أخرى',
    queue: 'عمليات النقل',
    empty: 'لا شيء في الانتظار. تعمل عمليات التنزيل والرفع هنا واحدة تلو الأخرى، وتُفحص بـ SHA-256، ويمكن استئنافها بعد انقطاع الاتصال.',
    clear: 'مسح المنتهية',
    pause: 'إيقاف مؤقت',
    resume: 'استئناف',
    retry: 'البدء من جديد',
    cancel: 'إلغاء',
    up: 'إلى الحاسوب',
    down: 'إلى هذا المتصفح',
    verified: 'تم التحقق بـ SHA-256',
    states: {
      queued: 'في الانتظار',
      running: 'جارٍ النسخ',
      paused: 'متوقف مؤقتًا',
      interrupted: 'انقطع، يمكن استئنافه',
      verifying: 'جارٍ فحص SHA-256',
      done: 'اكتمل',
      failed: 'فشل',
      cancelled: 'أُلغي',
    } satisfies Record<TransferState, string>,
    restartAsk: (name: string) => `${name}: لا يستطيع الحاسوب متابعة هذا الرفع من حيث توقف. البدء من جديد واستبدال الملف الجزئي؟`,
  },
};

const tone: Record<TransferState, 'ok' | 'warn' | 'crit' | 'idle' | 'info'> = {
  queued: 'idle',
  running: 'info',
  paused: 'idle',
  interrupted: 'warn',
  verifying: 'info',
  done: 'ok',
  failed: 'crit',
  cancelled: 'idle',
};

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function TwoPaneFileManager(props: RemoteFileManagerProps) {
  const files = useRemoteFiles(props);
  const confirm = useConfirm();
  const t = files.isAr ? text.ar : text.en;
  const { canWrite, canUpload } = props;
  const [picked, setPicked] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);

  const confirmRestart = useCallback((name: string) => confirm(t.restartAsk(name), { destructive: true }), [t, confirm]);
  const onUploaded = useCallback(() => {
    if (files.currentPath) void files.loadDirectory(files.currentPath);
  }, [files.currentPath, files.loadDirectory]);
  const queue = useTransferQueue({ runFsOp: files.runFsOp, confirmOverwrite: confirmRestart, onUploaded });

  // Same rule as before: an existing file is replaced only after the operator confirms in the dialog.
  const send = async (file: File) => {
    const dir = files.currentPath;
    if (!dir) return;
    const remotePath = joinPath(dir, file.name);
    const win = dir.includes('\\');
    const existing = files.entries.find((e) => (win ? e.name.toLowerCase() === file.name.toLowerCase() : e.name === file.name));
    if (existing?.is_dir) {
      files.setNotice(files.isAr ? `يوجد مجلد باسم ${file.name} هنا؛ لا يمكن استبداله بملف.` : `A folder named ${file.name} exists here; an upload cannot replace it.`);
      return;
    }
    let overwrite = false;
    if (existing) {
      overwrite = await files.askOverwrite({ name: file.name, path: remotePath, newSize: file.size, existingSize: existing.size, existingModTime: existing.mod_time });
      if (!overwrite) return;
    }
    queue.enqueueUpload(file, remotePath, overwrite);
    setPicked((p) => p.filter((f) => f !== file));
  };
  const sendAll = async () => {
    for (const f of picked) await send(f);
  };
  const download = (entry: RemoteFileEntry) => queue.enqueueDownload(entry.name, entry.path, entry.size);
  const addPicked = (list: File[]) => setPicked((p) => [...p, ...list.filter((f) => !p.some((x) => x.name === f.name && x.size === f.size))]);

  const received = queue.items.filter((x) => x.dir === 'down' && x.state === 'done' && x.url);

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(260px,1fr)_minmax(0,2.2fr)]">
        <Card title={t.local} action={<Laptop className="size-4 text-muted" aria-hidden />}>
          <div className="space-y-3 text-xs">
            {!canWrite ? (
              <p className="text-muted">{t.viewer}</p>
            ) : !canUpload ? (
              <p className="text-muted">{t.uploadNeedsAdmin}</p>
            ) : (
              <>
                <section
                  aria-label={t.localHint}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    addPicked(Array.from(e.dataTransfer.files));
                  }}
                  className={clsx('rounded-md border border-dashed p-4 text-center text-muted', dragging ? 'border-accent bg-accent/10' : 'border-line')}
                >
                  <p>{t.localHint}</p>
                  <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1 font-medium text-fg hover:border-accent">
                    <Upload className="size-3.5" aria-hidden />
                    {t.pick}
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      onChange={(e) => {
                        addPicked(Array.from(e.target.files ?? []));
                        e.target.value = '';
                      }}
                    />
                  </label>
                </section>
                {picked.length > 0 && (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {picked.map((f) => (
                      <li key={`${f.name}-${f.size}`} className="flex items-center justify-between gap-2 px-2 py-1.5">
                        <span className="min-w-0 truncate">
                          {ltr(f.name)} <span className="text-faint">· {ltr(formatBytes(f.size))}</span>
                        </span>
                        <span className="flex shrink-0 gap-1">
                          <Button size="sm" variant="primary" disabled={!props.online || !files.currentPath} onClick={() => void send(f)} title={`${t.sendTo} ${files.currentPath}`}>
                            <ArrowLeftRight className="size-3.5" aria-hidden />
                          </Button>
                          <Button size="sm" onClick={() => setPicked((p) => p.filter((x) => x !== f))} title={t.remove}>
                            <X className="size-3.5" aria-hidden />
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {picked.length > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-muted">
                      {files.currentPath ? (
                        <>
                          {t.sendTo} {ltr(files.currentPath)}
                        </>
                      ) : (
                        t.noFolder
                      )}
                    </span>
                    <Button size="sm" variant="primary" disabled={!props.online || !files.currentPath} onClick={() => void sendAll()}>
                      {t.sendAll}
                    </Button>
                  </div>
                )}
              </>
            )}
            {received.length > 0 && (
              <div className="space-y-1">
                <h4 className="font-medium text-fg">{t.received}</h4>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {received.map((x) => (
                    <li key={x.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
                      <span className="min-w-0 truncate">
                        {ltr(x.name)} <span className="text-faint">· {ltr(formatBytes(x.size))}</span>
                      </span>
                      <a href={x.url} download={x.name} className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline">
                        <Download className="size-3.5" aria-hidden />
                        {t.saveAgain}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
        <RemoteFilePane
          {...props}
          files={files}
          onQueueDownload={canWrite ? download : undefined}
          onQueueUpload={canUpload ? (list) => addPicked(list) : undefined}
        />
      </div>
      <TransferQueue items={queue.items} t={t} onPause={queue.pause} onResume={(id) => void queue.resume(id)} onCancel={queue.cancel} onClear={queue.clearFinished} canResume={queue.canResume} />
    </div>
  );
}

function TransferQueue({
  items,
  t,
  onPause,
  onResume,
  onCancel,
  onClear,
  canResume,
}: {
  items: Transfer[];
  t: (typeof text)['en'];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onClear: () => void;
  canResume: (id: string) => boolean;
}) {
  return (
    <Card
      title={t.queue}
      action={
        items.some((x) => x.state === 'done' || x.state === 'cancelled') ? (
          <Button size="sm" onClick={onClear}>
            {t.clear}
          </Button>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <p className="text-xs text-muted">{t.empty}</p>
      ) : (
        <ul className="divide-y divide-line text-xs">
          {items.map((x) => {
            const pct = x.size > 0 ? Math.min(100, Math.round((x.done * 100) / x.size)) : x.state === 'done' ? 100 : 0;
            return (
              <li key={x.id} className="space-y-1 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {x.dir === 'up' ? <Upload className="me-1 inline size-3.5" aria-hidden /> : <Download className="me-1 inline size-3.5" aria-hidden />}
                    {ltr(x.name)} <span className="text-faint">{x.dir === 'up' ? t.up : t.down}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Badge tone={tone[x.state]}>{t.states[x.state]}</Badge>
                    {x.state === 'running' && (
                      <Button size="sm" onClick={() => onPause(x.id)} title={t.pause}>
                        <Pause className="size-3.5" aria-hidden />
                      </Button>
                    )}
                    {(x.state === 'paused' || x.state === 'interrupted') && canResume(x.id) && (
                      <Button size="sm" variant="primary" onClick={() => onResume(x.id)} title={t.resume}>
                        <Play className="size-3.5" aria-hidden />
                        {t.resume}
                      </Button>
                    )}
                    {x.state === 'failed' && canResume(x.id) && (
                      <Button size="sm" onClick={() => onResume(x.id)} title={t.retry}>
                        <RotateCcw className="size-3.5" aria-hidden />
                      </Button>
                    )}
                    {!['done', 'cancelled'].includes(x.state) && (
                      <Button size="sm" variant="danger" onClick={() => onCancel(x.id)} title={t.cancel}>
                        <X className="size-3.5" aria-hidden />
                      </Button>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg">
                    <div className={clsx('h-full transition-all', x.state === 'failed' ? 'bg-crit' : 'bg-accent')} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="mono shrink-0 text-end text-muted sm:w-40">
                    {ltr(`${formatBytes(x.done)} / ${formatBytes(x.size)}`)}
                  </span>
                </div>
                <div className="truncate text-faint">{ltr(x.remotePath)}</div>
                {x.state === 'done' && x.sha256 && (
                  <div className="flex items-center gap-1 text-ok">
                    <CheckCircle2 className="size-3.5" aria-hidden />
                    {t.verified}: <span className="mono">{ltr(`${x.sha256.slice(0, 16)}…`)}</span>
                  </div>
                )}
                {x.error && x.state !== 'done' && <div className="text-crit">{x.error}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
