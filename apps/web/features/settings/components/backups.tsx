'use client';

import { Archive, KeyRound, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, Modal, Notice, Select, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, type Key, useI18n } from '@/lib/i18n';

/**
 * Settings → Backups (UX review item 15; API: /backups, owner only, installed copies). "Back up now",
 * the automatic schedule and folder, the passphrase that lets a backup carry the encryption key, and
 * restoring a backup (one in the folder, or any .nigafiy-backup file by its path).
 */

interface BackupFile {
  name: string;
  kind: 'manual' | 'auto';
  bytes: number;
  modified_at: string;
}

type BackupStatus =
  | { available: false }
  | {
      available: true;
      folder: string;
      default_folder: string;
      custom_folder: boolean;
      schedule: 'off' | 'daily' | 'weekly';
      hour: number;
      weekday: number;
      keep: number;
      key_protected: boolean;
      key_stale: boolean;
      last_run_at: string | null;
      last_ok_at: string | null;
      last_file: string | null;
      last_bytes: number | null;
      last_error: string | null;
      next_due_at: string | null;
      running: boolean;
      restoring: boolean;
      files: BackupFile[];
      extension: string;
    };

type Ready = Extract<BackupStatus, { available: true }>;

interface Inspect {
  file: string;
  created_at: string;
  app_version: string;
  same_key: boolean;
  needs_passphrase: boolean;
  key_missing: boolean;
  newer_version: boolean;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function BackupsCard() {
  const { t } = useI18n();
  const query = useQuery<BackupStatus>('/backups', [], 60_000);
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Archive className="size-4 text-accent" aria-hidden />
          {t('backups.title')}
        </span>
      }
    >
      <Async query={query}>
        {(s) =>
          s.available ? (
            <Backups s={s} reload={query.reload} />
          ) : (
            <p className="text-[13px] text-muted">{t('backups.unavailable')}</p>
          )
        }
      </Async>
    </Card>
  );
}

function Backups({ s, reload }: { s: Ready; reload: () => void }) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<string | null>(null);

  const backupNow = async () => {
    setBusy('run');
    setError(null);
    setDone(null);
    try {
      const r = await api<{ file: string; bytes: number; key_included: boolean }>('/backups/run', { method: 'POST', timeoutMs: 0 });
      setDone(fill(t('backups.done'), { file: r.file, size: size(r.bytes) }) + (r.key_included ? '' : ` ${t('backups.doneNoKey')}`));
      reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">{t('backups.intro')}</p>
      {error && <ErrorNote error={error} />}
      {done && <Notice>{done}</Notice>}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line px-3 py-2.5">
        <Button variant="primary" busy={busy === 'run' || s.running} disabled={s.restoring} onClick={() => void backupNow()}>
          {t('backups.now')}
        </Button>
        {s.last_ok_at ? (
          <span className="text-xs text-muted" title={absoluteTime(s.last_ok_at, locale)}>
            {fill(t('backups.last'), { when: relativeTime(s.last_ok_at, locale) })}
            {s.last_bytes !== null && ` · ${size(s.last_bytes)}`}
          </span>
        ) : (
          <Badge tone="idle">{t('backups.never')}</Badge>
        )}
        {s.last_error && s.last_run_at && (!s.last_ok_at || s.last_run_at > s.last_ok_at) && (
          <span className="w-full text-xs text-warn" dir="auto">
            {t('backups.failed')}: {s.last_error}
          </span>
        )}
        {s.next_due_at && (
          <span className="w-full text-xs text-faint" title={absoluteTime(s.next_due_at, locale)}>
            {fill(t('backups.next'), { when: absoluteTime(s.next_due_at, locale) })}
          </span>
        )}
      </div>

      <ScheduleForm s={s} reload={reload} />
      <KeyForm s={s} reload={reload} />

      <div>
        <h3 className="mb-2 text-[13px] font-medium">{t('backups.files')}</h3>
        {s.files.length === 0 ? (
          <p className="text-xs text-muted">{t('backups.noFiles')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {s.files.slice(0, 20).map((f) => (
              <li key={f.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="mono min-w-0 truncate text-[12px]" dir="ltr">
                  {f.name}
                </span>
                <Badge tone="idle">{t(`backups.kind.${f.kind}` as Key)}</Badge>
                <span className="text-xs text-muted">{size(f.bytes)}</span>
                <Button size="sm" variant="ghost" className="ms-auto" disabled={s.restoring} onClick={() => setRestoreFile(f.name)}>
                  <RotateCcw className="size-3.5" aria-hidden />
                  {t('backups.restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="ghost" className="mt-2" disabled={s.restoring} onClick={() => setRestoreFile('')}>
          {t('backups.restoreOther')}
        </Button>
      </div>

      {restoreFile !== null && <RestoreDialog initialFile={restoreFile} extension={s.extension} onClose={() => setRestoreFile(null)} />}
    </div>
  );
}

function ScheduleForm({ s, reload }: { s: Ready; reload: () => void }) {
  const { t } = useI18n();
  const [folder, setFolder] = useState(s.custom_folder ? s.folder : '');
  const [schedule, setSchedule] = useState(s.schedule);
  const [hour, setHour] = useState(s.hour);
  const [weekday, setWeekday] = useState(s.weekday);
  const [keep, setKeep] = useState(s.keep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
          await api('/backups/settings', { method: 'PUT', body: { folder: folder.trim() || null, schedule, hour, weekday, keep } });
          setSaved(true);
          reload();
        } catch (err) {
          setError(err as ApiError);
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <ErrorNote error={error} />}
      <Field label={t('backups.folder')} hint={fill(t('backups.folderHint'), { path: s.default_folder })}>
        {(id) => <Input id={id} dir="ltr" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={s.default_folder} maxLength={400} />}
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('backups.schedule')}>
          {(id) => (
            <Select id={id} className="w-40" value={schedule} onChange={(e) => setSchedule(e.target.value as Ready['schedule'])}>
              <option value="daily">{t('backups.schedule.daily')}</option>
              <option value="weekly">{t('backups.schedule.weekly')}</option>
              <option value="off">{t('backups.schedule.off')}</option>
            </Select>
          )}
        </Field>
        {schedule === 'weekly' && (
          <Field label={t('backups.weekday')}>
            {(id) => (
              <Select id={id} className="w-36" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <option key={d} value={d}>
                    {t(`backups.weekday.${d}` as Key)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {schedule !== 'off' && (
          <>
            <Field label={t('backups.hour')}>
              {(id) => (
                <Select id={id} className="w-28" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {`${String(h).padStart(2, '0')}:00`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('backups.keep')}>
              {(id) => <Input id={id} type="number" className="w-24" min={1} max={100} value={keep} onChange={(e) => setKeep(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />}
            </Field>
          </>
        )}
        <Button type="submit" busy={busy}>
          {t('backups.save')}
        </Button>
        {saved && <span className="text-xs text-ok">{t('backups.saved')}</span>}
      </div>
      {schedule !== 'off' && <p className="text-xs text-faint">{t('backups.keepHint')}</p>}
    </form>
  );
}

function KeyForm({ s, reload }: { s: Ready; reload: () => void }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [open, setOpen] = useState(!s.key_protected);
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const mismatch = repeat.length > 0 && pass !== repeat;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="rounded-md border border-line px-3 py-3">
      <h3 className="mb-1 inline-flex items-center gap-2 text-[13px] font-medium">
        <KeyRound className="size-3.5 text-accent" aria-hidden />
        {t('backups.keyTitle')}
      </h3>
      <p className="mb-2 text-xs text-muted">{t('backups.keyIntro')}</p>
      <p className={s.key_protected ? 'mb-2 text-xs text-ok' : 'mb-2 text-xs text-warn'}>
        {s.key_protected ? t('backups.keyOn') : s.key_stale ? t('backups.keyStale') : t('backups.keyOff')}
      </p>
      {error && (
        <div className="mb-2">
          <ErrorNote error={error} />
        </div>
      )}
      {open ? (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (pass !== repeat) return;
            void act('set', async () => {
              await api('/backups/key', { method: 'PUT', body: { passphrase: pass } });
              setPass('');
              setRepeat('');
              setOpen(false);
            });
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label={t('backups.passphrase')} hint={t('backups.passphraseHint')}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} minLength={10} maxLength={200} required />}
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field label={t('backups.passphraseRepeat')} hint={mismatch ? t('backups.passphraseMismatch') : undefined}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} minLength={10} maxLength={200} required />}
            </Field>
          </div>
          <Button type="submit" variant="primary" busy={busy === 'set'} disabled={pass.length < 10 || pass !== repeat}>
            {t('backups.setKey')}
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('backups.changeKey')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            busy={busy === 'remove'}
            onClick={async () => {
              if (!(await confirm(t('backups.removeKeyConfirm'), { title: t('backups.removeKey'), destructive: true }))) return;
              void act('remove', () => api('/backups/key', { method: 'DELETE' }));
            }}
          >
            {t('backups.removeKey')}
          </Button>
        </div>
      )}
    </div>
  );
}

function RestoreDialog({ initialFile, extension, onClose }: { initialFile: string; extension: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [file, setFile] = useState(initialFile);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [pass, setPass] = useState('');
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const inspect = async (name: string) => {
    setBusy('check');
    setError(null);
    setInfo(null);
    try {
      setInfo(await api<Inspect>(`/backups/inspect?file=${encodeURIComponent(name)}`));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  // A file from the list is checked straight away.
  const [checkedInitial, setCheckedInitial] = useState(false);
  if (initialFile && !checkedInitial) {
    setCheckedInitial(true);
    void inspect(initialFile);
  }

  const restore = async () => {
    if (!info) return;
    setBusy('restore');
    setError(null);
    try {
      await api('/backups/restore', {
        method: 'POST',
        timeoutMs: 0, // a restore can take minutes
        body: { file, confirm: true, ...(info.needs_passphrase ? { passphrase: pass } : {}), allow_unreadable_secrets: info.key_missing && accept },
      });
      setDone(fill(t('backups.restoreDone'), { when: absoluteTime(info.created_at, locale) }));
      setTimeout(() => window.location.reload(), 3000);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  const canRestore = info && !info.newer_version && (!info.needs_passphrase || pass.length > 0) && (!info.key_missing || accept);

  return (
    <Modal title={t('backups.restoreTitle')} onClose={busy === 'restore' ? () => undefined : onClose}>
      <div className="space-y-3">
        {done ? (
          <Notice>{done}</Notice>
        ) : (
          <>
            {!initialFile && (
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  void inspect(file.trim());
                }}
              >
                <div className="min-w-0 flex-1">
                  <Field label={t('backups.restoreFile')} hint={t('backups.restoreFileHint')}>
                    {(id) => <Input id={id} dir="ltr" value={file} onChange={(e) => setFile(e.target.value)} placeholder={`D:\\nigafiy-20261126-030000Z-auto${extension}`} required />}
                  </Field>
                </div>
                <Button type="submit" busy={busy === 'check'} disabled={!file.trim()}>
                  {t('backups.check')}
                </Button>
              </form>
            )}
            {error && <ErrorNote error={error} />}
            {info && (
              <>
                {info.newer_version ? (
                  <p className="text-[13px] text-warn">{t('backups.restoreNewer')}</p>
                ) : (
                  <p className="text-[13px]">{fill(t('backups.restoreWarn'), { when: absoluteTime(info.created_at, locale), version: info.app_version })}</p>
                )}
                {info.needs_passphrase && (
                  <>
                    <p className="text-xs text-muted">{t('backups.restoreNeedsPass')}</p>
                    <Field label={t('backups.passphrase')}>
                      {(id) => <Input id={id} type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} maxLength={200} />}
                    </Field>
                  </>
                )}
                {info.key_missing && (
                  <>
                    <p className="text-xs text-warn">{t('backups.restoreKeyMissing')}</p>
                    <label className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                      {t('backups.restoreAcceptLoss')}
                    </label>
                  </>
                )}
                {!info.newer_version && <p className="text-xs text-faint">{t('backups.restoreSignIn')}</p>}
                {busy === 'restore' && <Notice>{t('backups.restoring')}</Notice>}
                <div className="flex justify-end">
                  <Button variant="danger" busy={busy === 'restore'} disabled={!canRestore} onClick={() => void restore()}>
                    {t('backups.restoreConfirm')}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
