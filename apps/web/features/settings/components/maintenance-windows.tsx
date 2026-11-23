'use client';

import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { MaintenanceList } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, Select } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { browserTimeZone, toLocalInput } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export function MaintenanceWindows() {
  const { t } = useI18n();
  const { sites, siteId, can } = useApp();
  const query = useQuery<MaintenanceList>(`/maintenance${qs({ site_id: siteId })}`, ['events'], 30_000);

  const [reason, setReason] = useState('');
  const [chosenSite, setChosenSite] = useState<string>('');
  const [timezone, setTimezone] = useState(() => browserTimeZone() ?? 'UTC');
  const [startsLocal, setStartsLocal] = useState(() => toLocalInput(new Date()));
  const [endsLocal, setEndsLocal] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3600_000)));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const canManage = can('technician');

  async function createWindow(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim() || !startsLocal || !endsLocal) return;
    setBusy('create');
    setError(null);
    try {
      await api('/maintenance', {
        method: 'POST',
        body: {
          site_id: (chosenSite || siteId) ?? null,
          reason: reason.trim(),
          timezone: timezone.trim() || 'UTC',
          starts_local: startsLocal,
          ends_local: endsLocal,
          target_all: true,
        },
      });
      setReason('');
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function removeWindow(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/maintenance/${id}`, { method: 'DELETE' });
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <Card title={t('settings.maintenance.title')}>
      <div className="space-y-4">
        <p className="text-[13px] text-muted">{t('settings.maintenance.intro')}</p>
        {error && <ErrorNote error={error} />}

        <Async query={query}>
          {(data) => (
            <div className="space-y-4">
              {data.active_runs.length > 0 && (
                <div className="space-y-2 rounded-md border border-warn/30 bg-warn/[0.07] p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                    <CalendarClock className="size-4 text-warn" aria-hidden />
                    {t('settings.maintenance.activeRuns')}
                  </p>
                  <ul className="space-y-1 text-xs text-muted">
                    {data.active_runs.map((r) => (
                      <li key={r.id}>
                        <span className="font-medium text-fg">{r.reason}</span>
                        {r.site_name ? ` · ${r.site_name}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.items.length === 0 ? (
                <p className="text-[13px] text-muted">{t('settings.maintenance.empty')}</p>
              ) : (
                <ul className="divide-y divide-line rounded-md border border-line">
                  {data.items.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
                      <span className="font-medium text-fg" dir="auto">
                        {w.reason}
                      </span>
                      <Badge tone={w.active ? 'warn' : 'idle'}>
                        {w.site_name ?? t('top.allSites')}
                      </Badge>
                      <span className="mono text-xs text-muted" dir="ltr">
                        {w.starts_local.replace('T', ' ')} → {w.ends_local.replace('T', ' ')} ({w.timezone})
                      </span>
                      {canManage && (
                        <span className="ms-auto">
                          <Button
                            size="sm"
                            variant="ghost"
                            busy={busy === w.id}
                            aria-label={`${t('common.delete')}: ${w.reason}`}
                            onClick={() => void removeWindow(w.id)}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Async>

        {canManage && (
          <form onSubmit={createWindow} className="space-y-3 border-t border-line pt-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label={t('settings.maintenance.reason')}>
                  {(id) => (
                    <Input
                      id={id}
                      required
                      maxLength={500}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Field label={t('common.site')}>
                {(id) => (
                  <Select id={id} value={chosenSite} onChange={(e) => setChosenSite(e.target.value)}>
                    <option value="">{t('top.allSites')}</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('settings.maintenance.timezone')}>
                {(id) => (
                  <Input
                    id={id}
                    dir="ltr"
                    required
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('settings.maintenance.starts')}>
                {(id) => (
                  <Input
                    id={id}
                    type="datetime-local"
                    dir="ltr"
                    required
                    value={startsLocal}
                    onChange={(e) => setStartsLocal(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('settings.maintenance.ends')}>
                {(id) => (
                  <Input
                    id={id}
                    type="datetime-local"
                    dir="ltr"
                    required
                    value={endsLocal}
                    onChange={(e) => setEndsLocal(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div>
              <Button type="submit" variant="primary" busy={busy === 'create'} disabled={!reason.trim()}>
                <Plus className="size-4" aria-hidden />
                {t('settings.maintenance.add')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
