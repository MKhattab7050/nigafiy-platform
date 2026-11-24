'use client';

import Link from 'next/link';
import { UserCheck } from 'lucide-react';
import { useState } from 'react';
import type { FleetSession } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, DataTable, Input, PageHeader, Tabs, type Tone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { PermissionChips } from '../components/fleet-policy/permission-chips';
import { codeMessage, policyText } from '../components/fleet-policy/policy-text';

interface FleetApproval extends FleetSession {
  endpoint_name: string;
  operator_user_id: string | null;
}

const TONE: Record<string, Tone> = { approved: 'ok', denied: 'crit', expired: 'warn', pending: 'warn' };

/**
 * Nigafiy Fleet → Approvals (admins): unattended sessions that wait for a second admin. The
 * requester's own requests show without buttons (the API refuses self-approval too).
 */
export function FleetApprovalsScreen() {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const { me } = useApp();
  const [state, setState] = useState<'pending' | 'decided'>('pending');
  const query = useQuery<{ approvals: FleetApproval[] }>(`/fleet/approvals?state=${state}&limit=100`, ['devices'], state === 'pending' ? 5_000 : 30_000);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(`${id}:${decision}`);
    setError(null);
    try {
      const note = notes[id]?.trim();
      await api(`/fleet/approvals/${id}/${decision}`, { method: 'POST', body: note ? { note } : {} });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy('');
      void query.reload();
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title={tx.approvals} description={tx.approvalsSub} icon={<UserCheck className="size-5" aria-hidden />} />
      <Tabs
        label={tx.approvals}
        value={state}
        onChange={setState}
        options={[
          { value: 'pending', label: tx.pending },
          { value: 'decided', label: tx.decided },
        ]}
      />
      {error && (
        <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
          {codeMessage(tx, error)}
        </p>
      )}
      <Card padded={false}>
        <Async query={query}>
          {({ approvals }) =>
            approvals.length === 0 ? (
              <p className="p-5 text-sm text-muted">{state === 'pending' ? tx.noPending : tx.noDecided}</p>
            ) : (
              <DataTable stack>
                <thead>
                  <tr>
                    <th>{tx.computer}</th>
                    <th>{tx.operator}</th>
                    <th>{tx.profile}</th>
                    <th>{state === 'pending' ? tx.expires : tx.approvalCol}</th>
                    {state === 'pending' && <th />}
                  </tr>
                </thead>
                <tbody>
                  {approvals.map((a) => {
                    const mine = a.operator_user_id === me.user.id;
                    return (
                      <tr key={a.id}>
                        <td data-label={tx.computer}>
                          <Link href={`/fleet/endpoints/${a.endpoint_id}`} className="text-accent-hover hover:underline" dir="auto">
                            {a.endpoint_name}
                          </Link>
                          {a.group_name && (
                            <span className="block text-[11px] text-faint" dir="auto">
                              {a.group_name}
                            </span>
                          )}
                        </td>
                        <td data-label={tx.operator}>
                          {a.operator_email ? ltr(a.operator_email) : '—'}
                          {a.reason && (
                            <span className="block max-w-72 text-[11px] text-muted" dir="auto">
                              {a.reason}
                            </span>
                          )}
                          <span className="block text-[11px] text-faint">{`${tx.requested} ${absoluteTime(a.started_at, locale)}${a.request_ip ? ` · ${ltr(a.request_ip)}` : ''}`}</span>
                        </td>
                        <td data-label={tx.profile}>
                          <span dir="auto">{a.profile_name ?? '—'}</span>
                          {a.permissions && <PermissionChips permissions={a.permissions} className="mt-1 max-w-80" />}
                        </td>
                        <td data-label={state === 'pending' ? tx.expires : tx.approvalCol}>
                          {state === 'pending' ? (
                            a.approval_expires_at ? (
                              absoluteTime(a.approval_expires_at, locale)
                            ) : (
                              '—'
                            )
                          ) : (
                            <span>
                              <Badge tone={TONE[a.approval_state] ?? 'idle'}>{tx.decision[a.approval_state] ?? a.approval_state}</Badge>
                              <span className="block text-[11px] text-faint">
                                {[a.approver_email ? tx.decidedBy(ltr(a.approver_email)) : '', a.approval_decided_at ? absoluteTime(a.approval_decided_at, locale) : ''].filter(Boolean).join(' · ')}
                              </span>
                              {a.approval_note && (
                                <span className="block text-[11px] text-muted" dir="auto">
                                  {a.approval_note}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        {state === 'pending' && (
                          <td>
                            {mine ? (
                              <span className="text-xs text-muted">{tx.yours}</span>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Input
                                  value={notes[a.id] ?? ''}
                                  maxLength={300}
                                  onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                                  placeholder={tx.note}
                                  aria-label={tx.note}
                                  className="w-44"
                                  dir="auto"
                                />
                                <Button size="sm" variant="primary" busy={busy === `${a.id}:approve`} disabled={Boolean(busy)} onClick={() => void decide(a.id, 'approve')}>
                                  {tx.approve}
                                </Button>
                                <Button size="sm" variant="danger" busy={busy === `${a.id}:deny`} disabled={Boolean(busy)} onClick={() => void decide(a.id, 'deny')}>
                                  {tx.deny}
                                </Button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            )
          }
        </Async>
      </Card>
    </div>
  );
}
