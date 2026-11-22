'use client';

import clsx from 'clsx';
import { Download, FileText, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Async, BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, Button, Card, DataTable, EmptyState, ErrorNote, Modal, Notice, SkeletonBlock } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import type { Diff, Version } from '../types';
import { DiffView } from './diff-view';
import { RestoreDialog } from './restore';

const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MiB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KiB` : `${b} B`);

function ContentModal({ version, onClose }: { version: Version; onClose: () => void }) {
  const { t } = useI18n();
  // Fetched only when an administrator opens it (the read is audited).
  const query = useQuery<Version & { content: string }>(`/config-backup/versions/${version.id}`, [], 0);
  return (
    <Modal title={fill(t('cb.v.contentTitle'), { n: version.number })} onClose={onClose} wide>
      <Async query={query} skeleton={<SkeletonBlock lines={8} />}>
        {(v) => (
          <pre dir="ltr" className="mono max-h-[65vh] overflow-auto whitespace-pre rounded-[var(--radius-control)] border border-line bg-sunken p-3 text-start text-[12px] leading-[1.4]">
            {v.content}
          </pre>
        )}
      </Async>
    </Modal>
  );
}

/** The version timeline; administrators can read, download and compare any two versions. */
export function VersionList({ targetId, onRestore }: { targetId: string; onRestore?: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const admin = can('admin');
  const query = useQuery<{ items: Version[] }>(`/config-backup/targets/${targetId}/versions${qs({ limit: 200 })}`, ['devices'], 60_000);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Version | null>(null);
  const [restoring, setRestoring] = useState<Version | null>(null);
  const [restored, setRestored] = useState(false);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const compare = async (a: string, b: string) => {
    setBusy(true);
    setError(null);
    try {
      setDiff(await api<Diff>(`/config-backup/targets/${targetId}/diff${qs({ from: a, to: b })}`));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('cb.v.title')} padded={false}>
      <Async query={query}>
        {({ items }) => {
          if (items.length === 0)
            return (
              <EmptyState icon={<FileText />} title={t('cb.v.none')}>
                <p>{t('cb.v.noneHint')}</p>
              </EmptyState>
            );
          // Default comparison: the latest change (previous version → latest).
          const fromId = from ?? items[1]?.id ?? null;
          const toId = to ?? items[0]?.id ?? null;
          return (
            <div>
              {!admin && <p className="border-b border-line px-4 py-2.5 text-xs text-muted">{t('cb.v.adminOnly')}</p>}
              {restored && <Notice className="m-3">{t('cb.r.queued')}</Notice>}
              <DataTable stack>
                <thead>
                  <tr>
                    {admin && <th>{t('cb.v.from')}</th>}
                    {admin && <th>{t('cb.v.to')}</th>}
                    <th>{t('cb.v.number')}</th>
                    <th>{t('cb.v.captured')}</th>
                    <th>{t('cb.v.lastSeen')}</th>
                    <th>{t('cb.v.change')}</th>
                    <th>{t('cb.v.lines')}</th>
                    {admin && <th aria-label={t('cb.v.view')} />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((v, i) => (
                    <tr key={v.id}>
                      {admin && (
                        <td data-label={t('cb.v.from')}>
                          <input type="radio" name="cb-from" aria-label={`${t('cb.v.from')} ${v.number}`} className="accent-[var(--color-accent)]" checked={fromId === v.id} onChange={() => setFrom(v.id)} />
                        </td>
                      )}
                      {admin && (
                        <td data-label={t('cb.v.to')}>
                          <input type="radio" name="cb-to" aria-label={`${t('cb.v.to')} ${v.number}`} className="accent-[var(--color-accent)]" checked={toId === v.id} onChange={() => setTo(v.id)} />
                        </td>
                      )}
                      <td data-label={t('cb.v.number')} className="tnum font-medium">
                        v{v.number}
                      </td>
                      <td data-label={t('cb.v.captured')} title={absoluteTime(v.captured_at, locale)}>
                        {relativeTime(v.captured_at, locale)}
                        {v.collector_name && (
                          <span className="block text-xs text-faint" dir="auto">
                            {v.collector_name}
                          </span>
                        )}
                      </td>
                      <td data-label={t('cb.v.lastSeen')} title={absoluteTime(v.last_seen_at, locale)}>
                        {relativeTime(v.last_seen_at, locale)}
                        <span className="block text-xs text-faint">{fill(t('cb.v.confirmations'), { n: v.confirmations })}</span>
                      </td>
                      <td data-label={t('cb.v.change')}>
                        {i === items.length - 1 && v.added_lines === null ? (
                          <span className="text-xs text-muted">{t('cb.v.first')}</span>
                        ) : (
                          <span className="mono text-xs" dir="ltr">
                            <span className="text-ok">+{v.added_lines ?? 0}</span> <span className="text-crit">−{v.removed_lines ?? 0}</span>
                          </span>
                        )}
                      </td>
                      <td data-label={t('cb.v.lines')} className="tnum text-xs">
                        <span dir="ltr">
                          {v.line_count} · {size(v.size_bytes)}
                        </span>
                      </td>
                      {admin && (
                        <td>
                          <span className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => setViewing(v)}>
                              {t('cb.v.view')}
                            </Button>
                            <a href={`/api/v1/config-backup/versions/${v.id}/download`} download className={clsx(BUTTON_BASE, BUTTON_SIZE.sm, BUTTON_VARIANT.ghost)}>
                              <Download className="size-3.5" aria-hidden />
                              {t('cb.v.download')}
                            </a>
                            {i > 0 && (
                              <Button size="sm" variant="ghost" onClick={() => setRestoring(v)}>
                                <RotateCcw className="size-3.5" aria-hidden />
                                {t('cb.r.restore')}
                              </Button>
                            )}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              {admin && items.length > 1 && (
                <div className="space-y-3 border-t border-line p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" busy={busy} disabled={!fromId || !toId || fromId === toId} onClick={() => fromId && toId && void compare(fromId, toId)}>
                      {t('cb.v.compare')}
                    </Button>
                    {(!fromId || !toId || fromId === toId) && <span className="text-xs text-muted">{t('cb.v.pickTwo')}</span>}
                  </div>
                  <ErrorNote error={error} />
                  {diff && <DiffView diff={diff} downloadHref={`/api/v1/config-backup/targets/${targetId}/diff${qs({ from: diff.from.id, to: diff.to.id, format: 'unified' })}`} />}
                </div>
              )}
            </div>
          );
        }}
      </Async>
      {viewing && <ContentModal version={viewing} onClose={() => setViewing(null)} />}
      {restoring && (
        <RestoreDialog
          targetId={targetId}
          version={restoring}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            setRestored(true);
            onRestore?.();
          }}
        />
      )}
    </Card>
  );
}
