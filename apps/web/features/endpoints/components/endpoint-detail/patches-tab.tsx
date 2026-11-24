'use client';

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { FleetPatchInstall, FleetPatchPolicy, FleetPatchStatus } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, DataTable, Fact, Notice, type Tone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { PatchInstallsTable } from '../fleet-patches/installs-table';
import { formatBytes, patchesText } from '../fleet-patches/patches-text';

function Warn({ children }: { children: React.ReactNode }) {
  return <p role="status" className="rounded-md border border-warn/30 bg-warn/[0.08] px-3 py-2 text-[13px]">{children}</p>;
}

const approvalTone = (a: string): Tone => (a === 'approved' || a === 'auto_approved' ? 'ok' : a === 'declined' ? 'crit' : 'idle');

/** The computer's missing updates, the decisions that apply to it, and its install history. */
export function PatchesTab({ endpointId, online }: { endpointId: string; online: boolean }) {
  const { locale } = useI18n();
  const t = patchesText(locale);
  const { can } = useApp();
  const q = useQuery<{ status: FleetPatchStatus | null; policy: FleetPatchPolicy; installs: FleetPatchInstall[] }>(`/endpoints/${endpointId}/patches`, ['devices'], 30_000);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setError(null);
    try {
      await api(`/endpoints/${endpointId}/patches/scan`, { method: 'POST', body: {} });
      setAsked(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function decide(updateId: string, decision: 'approved' | 'declined') {
    setError(null);
    try {
      await api('/fleet/patches/approvals', { method: 'POST', body: { update_id: updateId, decision, fleet_group_id: null } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
    void q.reload();
  }

  return (
    <Async query={q}>
      {({ status, policy, installs }) => (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid flex-1 gap-3 sm:grid-cols-3">
                <Fact label={t.updater}>{status ? t.source[status.source] : t.notMeasured}</Fact>
                <Fact label={t.scanned}>{status ? absoluteTime(status.scanned_at, locale) : '—'}</Fact>
                <Fact label={t.policies}>{policy.enabled ? `${t.enabled} · ${t.rebootPolicies[policy.reboot_policy]}` : t.disabled}</Fact>
              </div>
              {can('technician') && (
                <Button size="sm" onClick={() => void scan()} disabled={!online}>
                  <RefreshCw className="size-3.5" aria-hidden />
                  {t.checkNow}
                </Button>
              )}
            </div>
            {asked && <p className="mt-2 text-xs text-muted">{t.checkAsked}</p>}
            {error && (
              <p role="alert" className="mt-2 rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
                {error}
              </p>
            )}
          </Card>
          {!status ? (
            <Notice>{t.notReported}</Notice>
          ) : (
            <>
              <p className="text-xs text-muted">{t.sourceNote[status.source]}</p>
              {status.scan_error && (
                <Warn>
                  {t.scanError}: <span dir="ltr">{status.scan_error}</span>
                </Warn>
              )}
              {status.source !== 'none' && (status.install_supported ? <Notice>{t.installSupported}</Notice> : <Warn>{t.installUnsupported}</Warn>)}
              {status.reboot_pending && <Warn>{t.rebootPending}</Warn>}
              <Card padded={false}>
                {status.updates.length === 0 ? (
                  <p className="p-4 text-sm text-muted">{t.noUpdates}</p>
                ) : (
                  <DataTable minWidth={760}>
                    <thead>
                      <tr>
                        <th>{t.update}</th>
                        <th>{t.classification}</th>
                        <th>{t.size}</th>
                        <th>{t.reboot}</th>
                        <th>{t.decision}</th>
                        {can('admin') && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {status.updates.map((u) => (
                        <tr key={u.update_id}>
                          <td className="text-sm">
                            <span dir="auto">{u.title}</span>
                            {u.kb && <span className="mono ms-2 text-xs text-muted">{ltr(u.kb)}</span>}
                          </td>
                          <td className="text-xs">
                            {t.classes[u.classification]}
                            {u.severity && <div className="text-faint">{ltr(u.severity)}</div>}
                          </td>
                          <td className="text-xs">{formatBytes(u.size_bytes) ? ltr(formatBytes(u.size_bytes)!) : t.notMeasured}</td>
                          <td className="text-xs">{u.reboot_required === null ? t.notMeasured : u.reboot_required ? t.rebootMaybe : t.rebootNo}</td>
                          <td>
                            <Badge tone={approvalTone(u.approval)}>{t.approval[u.approval]}</Badge>
                          </td>
                          {can('admin') && (
                            <td className="whitespace-nowrap">
                              <Button size="sm" onClick={() => void decide(u.update_id, 'approved')} disabled={u.approval === 'approved'}>
                                {t.approve}
                              </Button>{' '}
                              <Button size="sm" onClick={() => void decide(u.update_id, 'declined')} disabled={u.approval === 'declined'}>
                                {t.decline}
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </Card>
            </>
          )}
          <Card padded={false}>
            <h3 className="px-4 pt-3 text-sm font-semibold">{t.installs}</h3>
            <PatchInstallsTable installs={installs} showComputer={false} canAdmin={can('admin')} onChanged={() => void q.reload()} />
          </Card>
        </div>
      )}
    </Async>
  );
}
