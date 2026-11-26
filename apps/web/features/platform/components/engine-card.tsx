'use client';

import type { EngineChildState, PlatformEngineResponse, PlatformUpdateInstallStatus, PlatformUpdatesResponse } from '@nigafiy/shared-types/programs';
import { useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Modal, SkeletonBlock, type Tone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { ltr } from '@/lib/localize/bidi';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';

const STATE_TONE: Record<EngineChildState, Tone> = { running: 'ok', starting: 'info', backoff: 'warn', failed: 'crit', stopped: 'idle' };

const CHILD_KEYS: Record<string, Key> = {
  stack: 'platform.child.stack',
  db: 'platform.child.db',
  api: 'platform.child.api',
  web: 'platform.child.web',
  sensor: 'platform.child.sensor',
};

function childLabel(name: string, t: (k: Key) => string): string {
  const key = CHILD_KEYS[name];
  return key ? t(key) : name;
}

function EngineStatus({ data }: { data: PlatformEngineResponse }) {
  const { t, tn, locale } = useI18n();
  if (!data.reachable) return <p className="text-[13px] leading-relaxed text-muted">{t(`platform.engine.${data.reason}`)}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="info" dot={false}>
          {t(`platform.mode.${data.mode}`)}
        </Badge>
        <span dir="ltr">{fill(t('platform.version'), { v: data.version })}</span>
        <span title={absoluteTime(data.started_at, locale)}>{fill(t('platform.since'), { t: relativeTime(data.started_at, locale) })}</span>
      </div>
      <ul className="divide-y divide-line rounded-[8px] border border-line">
        {data.children.map((c) => (
          <li key={c.name} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-fg">{childLabel(c.name, t)}</p>
              {c.state === 'running' && c.health === 'ok' && <p className="text-xs text-muted">{t('platform.health.ok')}</p>}
              {c.state === 'running' && c.health === 'failing' && (
                <p className="mt-0.5 break-words text-xs text-warn" dir="auto">
                  {fill(t('platform.health.failing'), { e: c.health_error ?? '' })}
                </p>
              )}
              {c.waiting_for && <p className="text-xs text-muted">{fill(t('platform.waitingFor'), { name: childLabel(c.waiting_for, t) })}</p>}
              {c.restarts > 0 && <p className="text-xs text-muted">{fill(tn('platform.restarts', c.restarts), { n: c.restarts })}</p>}
              {c.last_error && (
                <p className="mt-0.5 break-words text-xs text-muted" dir="auto">
                  {fill(t('platform.lastError'), { e: c.last_error })}
                </p>
              )}
            </div>
            <Badge tone={STATE_TONE[c.state]}>{t(`platform.state.${c.state}`)}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UpdateStatus({ data, onCheck, checking }: { data: PlatformUpdatesResponse; onCheck?: () => void; checking: boolean }) {
  const { t, locale } = useI18n();
  let line: React.ReactNode;
  if (!data.configured) line = t(`platform.updates.${data.reason}`);
  else if (!data.ok) line = t(`platform.updates.error.${data.error}`);
  else if (data.update_available) line = fill(t('platform.updates.available'), { v: data.latest_version });
  else line = fill(t('platform.updates.upToDate'), { v: data.latest_version });
  const tone: Tone = !data.configured ? 'idle' : !data.ok ? 'warn' : data.update_available ? 'info' : 'ok';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={tone}>{t('platform.updates')}</Badge>
        {onCheck && data.configured && (
          <Button size="sm" onClick={onCheck} busy={checking}>
            {t('platform.updates.checkNow')}
          </Button>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-fg">{line}</p>
      <p className="text-xs text-muted">
        <span dir="ltr">{fill(t('platform.updates.current'), { v: data.current_version })}</span>
        {data.configured && <> · {fill(t('platform.updates.checked'), { t: relativeTime(data.checked_at, locale) })}</>}
        {data.configured && data.ok && data.notes_url && (
          <>
            {' · '}
            <a href={data.notes_url} target="_blank" rel="noopener noreferrer" className="text-accent-hover underline">
              {t('platform.updates.notes')}
            </a>
          </>
        )}
      </p>
    </div>
  );
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Download, verify and install a newer signed release. Download and install are separate steps,
 * both by an admin; the install is confirmed in a dialog and never happens on its own.
 */
function UpdateInstall({ latest, canAdmin }: { latest: string | null; canAdmin: boolean }) {
  const { t, locale } = useI18n();
  const status = useQuery<PlatformUpdateInstallStatus>('/platform/updates/install', [], 5000);
  const [busy, setBusy] = useState<'download' | 'install' | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState<string | null>(null);

  const run = async (what: 'download' | 'install', fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      status.reload();
      return true;
    } catch (err) {
      setError(err as ApiError);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <Async query={status} skeleton={<SkeletonBlock lines={2} />}>
      {(s) => {
        const dl = s.download;
        const staged = s.staged;
        const last = s.engine?.last ?? null;
        return (
          <div className="mt-3 space-y-2 rounded-[8px] border border-line p-3">
            {dl.state === 'downloading' && (
              <p className="text-[13px] text-fg">
                {fill(t('platform.install.downloading'), { v: ltr(dl.version), got: ltr(mb(dl.received)), total: ltr(mb(dl.total)) })}
              </p>
            )}
            {dl.state === 'failed' && (
              <p className="break-words text-[13px] text-warn" dir="auto">
                {fill(t('platform.install.downloadFailed'), { v: ltr(dl.version), e: dl.error })}
              </p>
            )}
            {staged && (
              <div className="space-y-1">
                <p className="text-[13px] text-fg">{fill(t('platform.install.staged'), { v: ltr(staged.version), t: relativeTime(staged.staged_at, locale) })}</p>
                <p className="break-all text-xs text-muted">
                  SHA-256 <span dir="ltr">{staged.sha256}</span>
                </p>
                <p className="text-xs text-muted">
                  {staged.signature.checked ? fill(t('platform.install.signerOk'), { tp: ltr(staged.signature.thumbprint ?? '') }) : t('platform.install.signerNotPinned')}
                </p>
              </div>
            )}
            {s.engine?.state === 'applying' && <p className="text-[13px] text-fg">{fill(t('platform.install.applying'), { v: ltr(s.engine.version ?? '') })}</p>}
            {requested && s.engine?.state !== 'applying' && <p className="text-[13px] text-fg">{fill(t('platform.install.requested'), { v: ltr(requested) })}</p>}
            {last && (
              <p className={last.ok ? 'text-xs text-muted' : 'break-words text-xs text-warn'} dir="auto">
                {last.ok
                  ? fill(t('platform.install.lastOk'), { v: ltr(last.version), t: relativeTime(last.finished_at, locale) })
                  : fill(t('platform.install.lastFailed'), { v: ltr(last.version), e: last.error ?? '' })}
              </p>
            )}
            {!s.engine && staged && <p className="text-xs text-muted">{t('platform.install.noEngine')}</p>}
            {error && !confirming && <ErrorNote error={error} />}
            {canAdmin ? (
              <div className="flex flex-wrap gap-2">
                {latest && (!staged || staged.version !== latest) && (
                  <Button size="sm" busy={busy === 'download'} disabled={dl.state === 'downloading'} onClick={() => void run('download', () => api('/platform/updates/download', { method: 'POST' }))}>
                    {fill(t('platform.install.download'), { v: ltr(latest) })}
                  </Button>
                )}
                {staged && (
                  <Button size="sm" variant="primary" disabled={!s.engine || s.engine.state === 'applying'} onClick={() => setConfirming(true)}>
                    {fill(t('platform.install.install'), { v: ltr(staged.version) })}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">{t('platform.install.adminOnly')}</p>
            )}
            {confirming && staged && (
              <Modal title={fill(t('platform.install.confirmTitle'), { v: ltr(staged.version) })} onClose={() => setConfirming(false)}>
                <div className="space-y-4">
                  <p className="text-[13px] leading-relaxed text-fg">{t('platform.install.confirmBody')}</p>
                  {error && <ErrorNote error={error} />}
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
                    <Button
                      variant="primary"
                      busy={busy === 'install'}
                      onClick={() =>
                        void run('install', () => api('/platform/updates/install', { method: 'POST', body: { version: staged.version, confirm: true } })).then((ok) => {
                          if (ok) {
                            setRequested(staged.version);
                            setConfirming(false);
                          }
                        })
                      }
                    >
                      {t('platform.install.confirm')}
                    </Button>
                  </div>
                </div>
              </Modal>
            )}
          </div>
        );
      }}
    </Async>
  );
}

/** Hub home: the engine's health (each supervised service) and the update check. */
export function EngineCard() {
  const { t } = useI18n();
  const { can } = useApp();
  const engine = useQuery<PlatformEngineResponse>('/platform/engine', [], 15_000);
  const updates = useQuery<PlatformUpdatesResponse>('/platform/updates', [], 3600_000);
  const [checking, setChecking] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    try {
      await api('/platform/updates/check', { method: 'POST' });
      updates.reload();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card title={t('platform.engine')} description={t('platform.engineHint')}>
      <div className="space-y-4">
        <Async query={engine} skeleton={<SkeletonBlock lines={3} />}>
          {(data) => <EngineStatus data={data} />}
        </Async>
        <div className="border-t border-line pt-3">
          <Async query={updates} skeleton={<SkeletonBlock lines={2} />}>
            {(data) => (
              <>
                <UpdateStatus data={data} checking={checking} onCheck={can('admin') ? checkNow : undefined} />
                {data.configured && data.ok && data.update_available && <UpdateInstall latest={data.latest_version} canAdmin={can('admin')} />}
              </>
            )}
          </Async>
        </div>
      </div>
    </Card>
  );
}

/** Settings: the same update line as the hub home, so "updates are off" or "a new version" is found where people look. */
export function UpdatesCard() {
  const { t } = useI18n();
  const { can } = useApp();
  const updates = useQuery<PlatformUpdatesResponse>('/platform/updates', [], 3600_000);
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try {
      await api('/platform/updates/check', { method: 'POST' });
      updates.reload();
    } finally {
      setChecking(false);
    }
  };
  return (
    <Card title={t('platform.updates')} description={t('platform.updates.desc')}>
      <Async query={updates} skeleton={<SkeletonBlock lines={2} />}>
        {(data) => (
          <div className="space-y-2">
            <UpdateStatus data={data} checking={checking} onCheck={can('admin') ? checkNow : undefined} />
            {!data.configured && (data.reason === 'no_source' || data.reason === 'no_key') && <p className="text-xs text-muted">{t('platform.updates.offHint')}</p>}
            {data.configured && data.ok && data.update_available && <UpdateInstall latest={data.latest_version} canAdmin={can('admin')} />}
          </div>
        )}
      </Async>
    </Card>
  );
}
