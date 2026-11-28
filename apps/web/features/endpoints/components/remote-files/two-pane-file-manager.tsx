'use client';

import clsx from 'clsx';
import { ArrowLeftRight, FolderInput, Laptop, MonitorSmartphone, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EndpointDetail, EndpointSummary, RemoteFileEntry } from '@nigafiy/shared-types';
import { Card } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { ltr } from '@/lib/localize/bidi';
import { formatBytes } from './file-utils';
import { type DragPayload, RemoteFilePane } from './remote-file-manager';
import type { RemoteRef } from './transfer-engine';
import { type LocalSelection, canWriteToDisk, copyItems, fromDrop, fromInput, pickLocalFolder, uploadItems } from './transfer-plans';
import { transferText } from './transfer-text';
import { type RemoteFileManagerProps, useRemoteFiles } from './use-remote-files';

// Two panes (Fleet Pro): this device on the right; on the left this computer (the browser) or
// another computer or phone of the organization. Files and whole folders go either way with the
// buttons, the right-click menu or by dragging rows from one pane to the other; every transfer
// runs in the transfer center (resumable, checked with SHA-256). A device-to-device copy is
// relayed chunk by chunk through this page: the same rules as doing it by hand (technician to
// read the source, admin to write the target, each device's policy and session profile).

const text = {
  en: {
    side: 'Left pane',
    local: 'This computer',
    device: 'Another device',
    choose: 'Choose a device…',
    noDevices: 'No other device is online.',
    localHint: 'Drop files or folders here (or pick them) to upload them into the folder open on the right.',
    to: 'Into',
    pickFiles: 'Pick files',
    pickFolder: 'Pick a folder',
    viewer: 'Viewers can browse, not copy files.',
    uploadNeedsAdmin: 'Sending files to a device needs the admin role (it can replace files).',
    disk: 'Downloads from the right are written straight into a folder you choose on this computer, any size, and are checked with SHA-256.',
    memory: 'This browser keeps a download in memory until it finishes: for files over 1.5 GB use Chrome or Edge.',
    offline: 'offline',
    copyLabel: (from: string, to: string) => `${from} → ${to}`,
  },
  ar: {
    side: 'الجهة اليسرى',
    local: 'هذا الحاسوب',
    device: 'جهاز آخر',
    choose: 'اختر جهازًا…',
    noDevices: 'لا يوجد جهاز آخر متصل.',
    localHint: 'أفلت ملفات أو مجلدات هنا (أو اخترها) لرفعها إلى المجلد المفتوح على اليمين.',
    to: 'إلى',
    pickFiles: 'اختيار ملفات',
    pickFolder: 'اختيار مجلد',
    viewer: 'يمكن للمشاهدين التصفح فقط، لا نسخ الملفات.',
    uploadNeedsAdmin: 'إرسال الملفات إلى جهاز يتطلب دور المسؤول (قد يستبدل ملفات).',
    disk: 'التنزيلات من اليمين تُكتب مباشرة في مجلد تختاره على هذا الحاسوب، مهما كان حجمها، وتُفحص بـ SHA-256.',
    memory: 'هذا المتصفح يحتفظ بالتنزيل في الذاكرة حتى ينتهي: للملفات الأكبر من 1.5 جيجابايت استخدم Chrome أو Edge.',
    offline: 'غير متصل',
    copyLabel: (from: string, to: string) => `${from} ← ${to}`,
  },
};

interface Side {
  ref: RemoteRef;
  path: string;
  online: boolean;
}

export function TwoPaneFileManager(props: RemoteFileManagerProps) {
  const files = useRemoteFiles(props);
  const t = files.isAr ? text.ar : text.en;
  const tt = transferText(files.isAr);
  const { canWrite, canUpload, ep } = props;
  const [mode, setMode] = useState<'local' | 'device'>('local');
  const [otherId, setOtherId] = useState('');
  const [left, setLeft] = useState<Side | null>(null);

  const list = useQuery<{ items: EndpointSummary[] }>(mode === 'device' ? '/endpoints' : null, ['devices'], 30_000);
  const devices = (list.data?.items ?? []).filter((d) => d.id !== ep.id && d.status === 'active');

  // Copies into a folder of the other side (right → left, left → right).
  const copy = useCallback(
    async (from: RemoteRef, entries: RemoteFileEntry[], to: RemoteRef, dir: string, set: (s: string) => void, setErr: (e: never) => void) => {
      if (!entries.length || !dir) return;
      setErr(null as never);
      set(tt.walking);
      try {
        const r = await copyItems(from, entries, to, dir, { showHidden: files.showHidden, label: text.en.copyLabel(entries.length === 1 ? entries[0]!.name : `${entries.length}`, to.device) });
        set([tt.queuedN(r.files, formatBytes(r.bytes)), r.truncated ? tt.truncated : ''].filter(Boolean).join(' '));
      } catch (err) {
        set('');
        setErr({ status: 422, code: 'fs_op_failed', message: (err as Error).message } as never);
      }
    },
    [files.showHidden, tt],
  );

  const upload = async (sel: LocalSelection) => {
    if (!files.currentPath || (!sel.files.length && !sel.dirs.length)) return;
    files.setNotice(tt.walking);
    try {
      const top = new Set(sel.files.map((x) => x.rel.split('/')[0]!).concat(sel.dirs.map((d) => d.split('/')[0]!)));
      const r = await uploadItems(files.ref, files.currentPath, sel, top.size === 1 ? [...top][0]! : `${sel.files.length} → ${ep.name}`);
      files.setNotice(tt.queuedN(r.files, formatBytes(r.bytes)));
    } catch (err) {
      files.setNotice('');
      files.setError({ status: 422, code: 'fs_op_failed', message: (err as Error).message } as never);
    }
  };

  const leftReady = mode === 'device' && left && left.online && left.path;

  return (
    <div className="min-w-0 space-y-3">
      <div role="radiogroup" aria-label={t.side} className="inline-flex rounded-md border border-line bg-raised p-0.5 text-xs">
        {(['local', 'device'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={clsx('inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-medium', mode === m ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}
          >
            {m === 'local' ? <Laptop className="size-3.5" aria-hidden /> : <MonitorSmartphone className="size-3.5" aria-hidden />}
            {m === 'local' ? t.local : t.device}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        {mode === 'local' ? (
          <LocalPane t={t} canWrite={canWrite} canUpload={canUpload} target={files.currentPath} device={ep.name} online={props.online} onPick={(s) => void upload(s)} />
        ) : (
          <div className="min-w-0 space-y-2">
            <select
              value={otherId}
              onChange={(e) => {
                setOtherId(e.target.value);
                setLeft(null);
              }}
              className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-fg"
              aria-label={t.choose}
            >
              <option value="">{t.choose}</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.hostname && d.hostname !== d.name ? ` (${d.hostname})` : ''} · {d.platform}
                  {d.connection_state !== 'online' ? ` · ${t.offline}` : ''}
                </option>
              ))}
            </select>
            {list.data && devices.length === 0 && <p className="text-xs text-muted">{t.noDevices}</p>}
            {otherId && (
              <OtherDevicePane
                key={otherId}
                id={otherId}
                base={props}
                onState={setLeft}
                copyHere={(p) => void copyToLeft(p)}
                right={{ device: ep.name, folder: files.currentPath, ref: files.ref }}
                copy={copy}
              />
            )}
          </div>
        )}

        <RemoteFilePane
          {...props}
          files={files}
          other={leftReady ? { device: left.ref.device, folder: left.path, onCopy: (entries) => void copy(files.ref, entries, left.ref, left.path, files.setNotice, files.setError as never) } : undefined}
          onDropRemote={leftReady ? (p: DragPayload) => void copy({ endpointId: p.endpointId, device: p.device }, p.entries, files.ref, files.currentPath, files.setNotice, files.setError as never) : undefined}
        />
      </div>
    </div>
  );

  // Rows of the right pane dropped on the left device's pane.
  async function copyToLeft(p: DragPayload) {
    if (!left) return;
    await copy({ endpointId: p.endpointId, device: p.device }, p.entries, left.ref, left.path, files.setNotice, files.setError as never);
  }
}

function LocalPane({ t, canWrite, canUpload, target, device, online, onPick }: { t: (typeof text)['en']; canWrite: boolean; canUpload: boolean; target: string; device: string; online: boolean; onPick: (s: LocalSelection) => void }) {
  const [dragging, setDragging] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const ready = online && Boolean(target);
  return (
    <Card title={t.local} action={<Laptop className="size-4 text-muted" aria-hidden />}>
      <div className="space-y-3 text-xs">
        {!canWrite ? (
          <p className="text-muted">{t.viewer}</p>
        ) : !canUpload ? (
          <p className="text-muted">{t.uploadNeedsAdmin}</p>
        ) : (
          <section
            aria-label={t.localHint}
            onDragOver={(e) => {
              if (!ready) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragging(false);
              if (ready) onPick(await fromDrop(e.dataTransfer));
            }}
            className={clsx('rounded-md border border-dashed p-6 text-center text-muted', dragging ? 'border-accent bg-accent/10' : 'border-line')}
          >
            <Upload className="mx-auto mb-2 size-6 text-faint" aria-hidden />
            <p>{t.localHint}</p>
            {target && (
              <p className="mt-1 truncate text-faint">
                {t.to} {ltr(`${device}: ${target}`)}
              </p>
            )}
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <input
                ref={filesRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  onPick(fromInput(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <input
                ref={folderRef}
                type="file"
                multiple
                className="hidden"
                {...({ webkitdirectory: '' } as object)}
                onChange={(e) => {
                  onPick(fromInput(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <button type="button" disabled={!ready} onClick={() => filesRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1 font-medium text-fg hover:border-accent disabled:opacity-50">
                <Upload className="size-3.5" aria-hidden />
                {t.pickFiles}
              </button>
              <button
                type="button"
                disabled={!ready}
                onClick={async () => {
                  const picked = await pickLocalFolder().catch(() => null);
                  if (picked) onPick(picked);
                  else folderRef.current?.click();
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1 font-medium text-fg hover:border-accent disabled:opacity-50"
              >
                <FolderInput className="size-3.5" aria-hidden />
                {t.pickFolder}
              </button>
            </div>
          </section>
        )}
        <p className="flex items-start gap-1.5 text-muted">
          <ArrowLeftRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {canWriteToDisk() ? t.disk : t.memory}
        </p>
      </div>
    </Card>
  );
}

/** The left pane when it shows another device: its own files, the same tools and rules. */
function OtherDevicePane({
  id,
  base,
  onState,
  copyHere,
  right,
  copy,
}: {
  id: string;
  base: RemoteFileManagerProps;
  onState: (s: Side | null) => void;
  copyHere: (p: DragPayload) => void;
  right: { device: string; folder: string; ref: RemoteRef };
  copy: (from: RemoteRef, entries: RemoteFileEntry[], to: RemoteRef, dir: string, set: (s: string) => void, setErr: (e: never) => void) => Promise<void>;
}) {
  const q = useQuery<EndpointDetail>(`/endpoints/${id}`, ['devices'], 30_000);
  const ep = q.data;
  if (!ep) return <p className="text-xs text-muted">{q.error ? q.error.message : '…'}</p>;
  const online = ep.status === 'active' && ep.connection_state === 'online';
  return <OtherDeviceFiles ep={ep} online={online} base={base} onState={onState} copyHere={copyHere} right={right} copy={copy} />;
}

function OtherDeviceFiles({
  ep,
  online,
  base,
  onState,
  copyHere,
  right,
  copy,
}: {
  ep: EndpointDetail;
  online: boolean;
  base: RemoteFileManagerProps;
  onState: (s: Side | null) => void;
  copyHere: (p: DragPayload) => void;
  right: { device: string; folder: string; ref: RemoteRef };
  copy: (from: RemoteRef, entries: RemoteFileEntry[], to: RemoteRef, dir: string, set: (s: string) => void, setErr: (e: never) => void) => Promise<void>;
}) {
  const props = { ...base, ep, online };
  const files = useRemoteFiles(props);
  useEffect(() => {
    onState({ ref: files.ref, path: files.currentPath, online });
  }, [files.ref, files.currentPath, online, onState]);
  useEffect(() => () => onState(null), [onState]);
  return (
    <RemoteFilePane
      {...props}
      files={files}
      other={right.folder ? { device: right.device, folder: right.folder, onCopy: (entries) => void copy(files.ref, entries, right.ref, right.folder, files.setNotice, files.setError as never) } : undefined}
      onDropRemote={copyHere}
    />
  );
}
