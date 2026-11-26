'use client';

import { Download, LifeBuoy, Link2, PlugZap } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FleetHelpRequest, FleetQuickSupport } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, DataTable, Input, Notice, PageHeader, Select, StatusBadge, Tabs, type Tone } from '@/components/ui';
import { ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { ConnectDialog } from '../components/fleet-policy/connect-dialog';
import { codeMessage, policyText } from '../components/fleet-policy/policy-text';
import { QuickConnectDialog } from '../components/reach/connect-box';
import { formatId, reachText } from '../components/reach/reach-text';

type HelpState = 'open' | 'in_session' | 'closed' | 'all';
const HELP_TONE: Record<string, Tone> = { open: 'warn', in_session: 'ok', closed: 'idle' };
const QS_TONE: Record<string, Tone> = { waiting: 'warn', connected: 'ok', ended: 'idle', expired: 'idle', locked: 'crit' };

/**
 * Nigafiy Fleet → Requests (technicians): help requests sent from the agent's tray icon, and
 * Quick Support (download nigafiy-support.exe for a site, connect with code and PIN, the codes).
 */
export function FleetRequestsScreen() {
  const { locale } = useI18n();
  const tx = reachText(locale);
  const px = policyText(locale);
  const router = useRouter();
  const [state, setState] = useState<HelpState>('open');
  const help = useQuery<{ requests: FleetHelpRequest[] }>(`/fleet/help-requests?state=${state}&limit=100`, ['devices', 'events'], state === 'open' ? 8_000 : 30_000);
  const [connecting, setConnecting] = useState<FleetHelpRequest | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeNote, setCloseNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  async function close(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/fleet/help-requests/${id}/close`, { method: 'POST', body: closeNote.trim() ? { note: closeNote.trim() } : {} });
      setClosing(null);
      setCloseNote('');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy('');
      void help.reload();
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title={tx.requestsTitle} description={tx.requestsSubtitle} icon={<LifeBuoy className="size-5" aria-hidden />} />

      <Card title={tx.helpTitle} padded={false}>
        <div className="border-b border-line px-4 py-2">
          <Tabs<HelpState>
            label={tx.helpTitle}
            value={state}
            onChange={setState}
            options={(['open', 'in_session', 'closed', 'all'] as const).map((s) => ({ value: s, label: tx.helpState[s] ?? s }))}
          />
        </div>
        {error && (
          <p role="alert" className="mx-4 mt-3 rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
            {codeMessage(px, error)}
          </p>
        )}
        <Async query={help}>
          {({ requests }) =>
            requests.length === 0 ? (
              <p className="p-5 text-sm text-muted">{tx.helpNone}</p>
            ) : (
              <ul className="divide-y divide-line">
                {requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-[1_1_24rem] space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge tone={HELP_TONE[r.state] ?? 'idle'}>{tx.helpState[r.state] ?? r.state}</Badge>
                        <Link href={`/fleet/endpoints/${r.endpoint_id}`} className="font-medium text-accent-hover hover:underline" dir="auto">
                          {tx.helpFrom(r.requested_by, r.endpoint_name)}
                        </Link>
                        <span className="mono text-xs text-muted">{ltr(formatId(r.nigafiy_id))}</span>
                        {r.connection_state !== 'online' && <StatusBadge status="offline" />}
                        <span className="text-xs text-faint" title={absoluteTime(r.created_at, locale)}>
                          {relativeTime(r.created_at, locale)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-[13px] text-fg" dir="auto">
                        {r.note}
                      </p>
                      {r.state !== 'open' && (
                        <p className="text-xs text-muted">
                          {tx.helpHandled(r.handled_by_email)}
                          {r.handled_at ? ` · ${absoluteTime(r.handled_at, locale)}` : ''}
                          {r.close_note ? (
                            <span className="block" dir="auto">
                              {r.close_note}
                            </span>
                          ) : null}
                        </p>
                      )}
                    </div>
                    {r.state === 'open' && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button size="sm" variant="primary" disabled={r.connection_state !== 'online' || Boolean(busy)} onClick={() => setConnecting(r)}>
                          <PlugZap className="size-3.5" aria-hidden />
                          {tx.helpConnect}
                        </Button>
                        {closing === r.id ? (
                          <>
                            <Input value={closeNote} maxLength={300} onChange={(e) => setCloseNote(e.target.value)} placeholder={tx.helpCloseNote} aria-label={tx.helpCloseNote} className="w-52" dir="auto" />
                            <Button size="sm" busy={busy === r.id} onClick={() => void close(r.id)}>
                              {tx.helpClose}
                            </Button>
                            <Button size="sm" onClick={() => setClosing(null)}>
                              {tx.cancel}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" onClick={() => setClosing(r.id)}>
                            {tx.helpClose}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </Card>

      <QuickSupportPanel onConnected={(id) => router.push(`/fleet/endpoints/${id}?tab=desktop`)} />

      {connecting && (
        <ConnectDialog
          endpoint={{ id: connecting.endpoint_id, name: connecting.endpoint_name }}
          onClose={() => setConnecting(null)}
          onSubmit={async (choice) => {
            try {
              await api(`/fleet/help-requests/${connecting.id}/connect`, { method: 'POST', body: choice });
              router.push(`/fleet/endpoints/${connecting.endpoint_id}?tab=desktop`);
              return null;
            } catch (err) {
              return err instanceof ApiError ? err : new ApiError(0, 'error', String(err));
            }
          }}
        />
      )}
    </div>
  );
}

/** Quick Support: the download per site (with the server key), connect with code and PIN, recent codes. */
function QuickSupportPanel({ onConnected }: { onConnected: (endpointId: string) => void }) {
  const { locale } = useI18n();
  const tx = reachText(locale);
  const px = policyText(locale);
  const { sites, siteId, can } = useApp();
  const canWrite = can('technician');
  const list = useQuery<{ sessions: FleetQuickSupport[]; key: { fingerprint: string } }>('/fleet/quick-support?limit=50', ['devices'], 10_000);
  const [site, setSite] = useState(siteId || sites[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [storeLink, setStoreLink] = useState<{ link: string; fingerprint: string; days: number; copied: boolean } | null>(null);

  /** The binding as a nigafiy-support: link for the Microsoft Store version (GET /fleet/quick-support/link). */
  async function copyStoreLink() {
    if (!site) return;
    setLinkBusy(true);
    setError(null);
    try {
      const r = await api<{ link: string; fingerprint: string; expires_in_seconds: number }>(`/fleet/quick-support/link${qs({ site_id: site })}`);
      let copied = false;
      try {
        await navigator.clipboard.writeText(r.link);
        copied = true;
      } catch {
        // No clipboard permission: the link stays selectable below.
      }
      setStoreLink({ link: r.link, fingerprint: r.fingerprint, days: Math.round(r.expires_in_seconds / 86_400), copied });
    } catch (err) {
      setError(err instanceof ApiError ? codeMessage(px, err) : String(err));
    } finally {
      setLinkBusy(false);
    }
  }

  async function download() {
    if (!site) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/fleet/quick-support/download${qs({ site_id: site })}`, { credentials: 'same-origin', headers: { 'X-LD-CSRF': '1' }, cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
        setError(codeMessage(px, body?.error ?? { code: 'http_error', message: `HTTP ${res.status}` }));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nigafiy-support.exe';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      void list.reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={tx.qsPanel}
      description={tx.qsPanelHelp}
      action={
        <Button size="sm" variant="primary" onClick={() => setConnectOpen(true)}>
          <PlugZap className="size-3.5" aria-hidden />
          {tx.qsConnectNow}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          {sites.length > 1 && (
            <Select value={site} onChange={(e) => setSite(e.target.value)} aria-label={tx.qsSite} className="w-56">
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
          {canWrite && (
            <>
              <Button busy={busy} disabled={!site} onClick={() => void download()}>
                <Download className="size-4" aria-hidden />
                {tx.qsDownload}
              </Button>
              <Button busy={linkBusy} disabled={!site} onClick={() => void copyStoreLink()} title={tx.qsStoreLinkHelp}>
                <Link2 className="size-4" aria-hidden />
                {tx.qsStoreLink}
              </Button>
            </>
          )}
          {list.data?.key && (
            <span className="text-xs text-muted" title={tx.qsKeyHelp}>
              {tx.qsKey}: <span className="mono text-fg">{ltr(list.data.key.fingerprint)}</span>
            </span>
          )}
        </div>
        <p className="text-xs text-faint">{tx.qsUnsigned}</p>
        {storeLink && (
          <div className="space-y-1">
            <Input readOnly value={storeLink.link} dir="ltr" className="mono text-xs" aria-label={tx.qsStoreLinkLabel} onFocus={(e) => e.currentTarget.select()} />
            <p className="text-xs text-muted" role="status">
              {storeLink.copied ? `${tx.qsStoreLinkCopied} ` : ''}
              {tx.qsStoreLinkExpires(storeLink.days)} {tx.qsKey}: <span className="mono text-fg">{ltr(storeLink.fingerprint)}</span>
            </p>
            <p className="text-xs text-faint">{tx.qsStoreLinkHelp}</p>
          </div>
        )}
        {error &&<Notice className="border-crit/30 bg-crit/[0.07]">{error}</Notice>}

        <div>
          <h3 className="mb-2 text-xs font-medium text-muted">{tx.qsList}</h3>
          <Async query={list}>
            {({ sessions }) =>
              sessions.length === 0 ? (
                <p className="text-sm text-muted">{tx.qsNone}</p>
              ) : (
                <DataTable stack>
                  <thead>
                    <tr>
                      <th>{tx.qsCol.code}</th>
                      <th>{tx.qsCol.state}</th>
                      <th>{tx.qsCol.host}</th>
                      <th>{tx.qsCol.operator}</th>
                      <th>{tx.qsCol.created}</th>
                      <th>{tx.qsCol.expires}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td data-label={tx.qsCol.code} className="mono">
                          {ltr(formatId(s.code))}
                        </td>
                        <td data-label={tx.qsCol.state}>
                          <Badge tone={QS_TONE[s.state] ?? 'idle'}>{tx.qsStates[s.state] ?? s.state}</Badge>
                        </td>
                        <td data-label={tx.qsCol.host} dir="auto">
                          {s.state === 'connected' ? (
                            <Link href={`/fleet/endpoints/${s.endpoint_id}?tab=desktop`} className="text-accent-hover hover:underline">
                              {s.hostname ?? '—'}
                            </Link>
                          ) : (
                            (s.hostname ?? '—')
                          )}
                          {s.os && <span className="block text-[11px] text-faint">{s.os}</span>}
                        </td>
                        <td data-label={tx.qsCol.operator}>{s.operator_email ? ltr(s.operator_email) : '—'}</td>
                        <td data-label={tx.qsCol.created}>{absoluteTime(s.created_at, locale)}</td>
                        <td data-label={tx.qsCol.expires}>{s.state === 'waiting' ? absoluteTime(s.expires_at, locale) : s.ended_at ? absoluteTime(s.ended_at, locale) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              )
            }
          </Async>
        </div>
      </div>
      {connectOpen && (
        <QuickConnectDialog
          code=""
          onClose={() => setConnectOpen(false)}
          onConnected={(id) => {
            setConnectOpen(false);
            onConnected(id);
          }}
        />
      )}
    </Card>
  );
}
