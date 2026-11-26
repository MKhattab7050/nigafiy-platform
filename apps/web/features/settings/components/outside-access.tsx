'use client';

import { ExternalLink, Globe, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Async, Badge, Button, Card, CopyBlock, ErrorNote, Field, Input, Notice, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill, type Key, useI18n } from '@/lib/i18n';

/** GET /outside-access (apps/api/src/modules/outside-access). */
interface OutsideAccess {
  available: boolean;
  blocked_reason: 'disabled' | 'multi_tenant' | null;
  registration_open: boolean;
  web_port: number;
  local_target: string;
  serve_command: string;
  tailscale: {
    installed: boolean;
    version: string | null;
    state: string | null;
    dns_name: string | null;
    ips: string[];
    origin: string | null;
    serving: boolean;
    serve_target: string | null;
    origin_accepted: boolean;
  };
  cloudflared: { installed: boolean; version: string | null };
  origins: { origin: string; kind: 'tailscale' | 'cloudflare' | 'custom'; created_at: string }[];
}

// Official pages only: the user downloads and installs; Nigafiy never fetches installers.
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
const CLOUDFLARED_DOWNLOAD = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
const CLOUDFLARE_GUIDE = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/';

function OutLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

function Steps({ keys }: { keys: Key[] }) {
  const { t } = useI18n();
  return (
    <ol className="ms-5 list-decimal space-y-1 text-[13px] text-muted">
      {keys.map((k) => (
        <li key={k}>{t(k)}</li>
      ))}
    </ol>
  );
}

/**
 * Settings → Access from outside home (UX review item 18). Detects Tailscale and cloudflared on this
 * computer, turns Tailscale Serve on/off on the owner's request, and keeps the list of tunnel
 * addresses the server accepts sign-ins from. Never opens router ports or downloads software.
 */
export function OutsideAccessCard() {
  const confirm = useConfirm();
  const { t } = useI18n();
  const { can } = useApp();
  const owner = can('owner');
  const query = useQuery<OutsideAccess>('/outside-access', [], 0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [cliOutput, setCliOutput] = useState('');
  const [host, setHost] = useState('');

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
      query.reload();
    }
  };

  const serve = (on: boolean) =>
    act(on ? 'on' : 'off', async () => {
      setCliOutput('');
      const r = await api<{ ok: boolean; output: string }>('/outside-access/tailscale/serve', { method: 'POST', body: { on, confirm: true } });
      // Tailscale refused: show its own words (e.g. the link to enable HTTPS certificates).
      if (!r.ok) setCliOutput(r.output || '?');
    });

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Globe className="size-4 text-accent" aria-hidden />
          {t('outside.title')}
        </span>
      }
    >
      <p className="mb-3 text-[13px] text-muted">{t('outside.intro')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      <Async query={query}>
        {(s) => {
          if (!s.available) return <Notice>{t(`outside.unavailable.${s.blocked_reason ?? 'disabled'}` as Key)}</Notice>;
          const ts = s.tailscale;
          const locked = s.registration_open || !owner;
          return (
            <div className="space-y-4">
              {s.registration_open && <Notice className="border-warn/40 bg-warn/[0.08]">{t('outside.signupOpen')}</Notice>}
              {!owner && <p className="text-xs text-faint">{t('outside.ownerOnly')}</p>}

              {/* Tailscale */}
              <section className="rounded-md border border-line p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-fg">{t('outside.ts.title')}</h3>
                  <Badge tone="ok">{t('outside.recommended')}</Badge>
                  {ts.version && <span className="text-xs text-faint">{fill(t('outside.ts.version'), { version: ts.version })}</span>}
                  <Button size="sm" variant="ghost" className="ms-auto" onClick={() => query.reload()} busy={query.loading}>
                    <RefreshCw className="size-3.5" aria-hidden />
                    {t('outside.ts.recheck')}
                  </Button>
                </div>
                <p className="mb-2 text-xs text-muted">{t('outside.ts.why')}</p>
                {!ts.installed ? (
                  <div className="space-y-2">
                    <p className="text-[13px] text-fg">{t('outside.ts.missing')}</p>
                    <Steps keys={['outside.ts.step1', 'outside.ts.step2', 'outside.ts.step3']} />
                    <OutLink href={TAILSCALE_DOWNLOAD}>{t('outside.ts.download')}</OutLink>
                  </div>
                ) : ts.state !== 'Running' ? (
                  <p className="text-[13px] text-warn">{fill(t('outside.ts.notRunning'), { state: ts.state ?? '?' })}</p>
                ) : !ts.origin ? (
                  <p className="text-[13px] text-warn">{t('outside.ts.noName')}</p>
                ) : (
                  <div className="space-y-2">
                    {ts.serving && ts.origin_accepted ? (
                      <>
                        <p className="text-[13px] text-ok">{t('outside.ts.on')}</p>
                        <CopyBlock value={ts.origin} />
                      </>
                    ) : (
                      <>
                        <p className="text-[13px] text-fg">
                          {t('outside.ts.ready')}{' '}
                          <span className="mono" dir="ltr">
                            {ts.dns_name}
                          </span>
                        </p>
                        {ts.serve_target && !ts.serving && <p className="text-xs text-warn">{fill(t('outside.ts.otherTarget'), { target: ts.serve_target })}</p>}
                        <p className="text-xs text-faint">{t('outside.ts.step2')}</p>
                      </>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {!(ts.serving && ts.origin_accepted) ? (
                        <Button
                          variant="primary"
                          busy={busy === 'on'}
                          disabled={locked}
                          onClick={async () => {
                            if (!(await confirm(fill(t('outside.ts.confirmOn'), { command: s.serve_command, origin: ts.origin ?? '' }), { title: t('outside.ts.turnOn') }))) return;
                            void serve(true);
                          }}
                        >
                          {t('outside.ts.turnOn')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          busy={busy === 'off'}
                          disabled={!owner}
                          onClick={async () => {
                            if (!(await confirm(t('outside.ts.confirmOff'), { title: t('outside.ts.turnOff'), destructive: true }))) return;
                            void serve(false);
                          }}
                        >
                          {t('outside.ts.turnOff')}
                        </Button>
                      )}
                    </div>
                    {cliOutput && (
                      <div>
                        <p className="mb-1 text-xs text-warn">{t('outside.ts.failed')}</p>
                        <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2 text-xs" dir="ltr">
                          {cliOutput}
                        </pre>
                      </div>
                    )}
                    <CopyBlock label={t('outside.ts.manual')} value={s.serve_command} />
                  </div>
                )}
              </section>

              {/* Cloudflare Tunnel */}
              <section className="rounded-md border border-line p-3">
                <h3 className="mb-1 text-sm font-semibold text-fg">{t('outside.cf.title')}</h3>
                <p className="mb-2 text-xs text-muted">{t('outside.cf.why')}</p>
                <p className="mb-2 text-[13px] text-fg">
                  {s.cloudflared.installed ? fill(t('outside.cf.installed'), { version: s.cloudflared.version ?? '?' }) : t('outside.cf.missing')}
                </p>
                <div className="mb-2 flex flex-wrap gap-4">
                  {!s.cloudflared.installed && <OutLink href={CLOUDFLARED_DOWNLOAD}>{t('outside.cf.download')}</OutLink>}
                  <OutLink href={CLOUDFLARE_GUIDE}>{t('outside.cf.guide')}</OutLink>
                </div>
                <Steps keys={['outside.cf.step1', 'outside.cf.step2', 'outside.cf.step3', 'outside.cf.step4']} />
                <div className="mt-2">
                  <CopyBlock label={t('outside.cf.service')} value={s.local_target} />
                </div>
                <form
                  className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('add', async () => {
                      await api('/outside-access/origins', { method: 'POST', body: { origin: host.trim(), kind: 'cloudflare' } });
                      setHost('');
                    });
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <Field label={t('outside.cf.hostname')} hint={t('outside.cf.hostnameHint')}>
                      {(id) => (
                        <Input id={id} dir="ltr" type="url" inputMode="url" value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://nigafiy.example.com" maxLength={300} required disabled={locked} />
                      )}
                    </Field>
                  </div>
                  <Button type="submit" variant="primary" busy={busy === 'add'} disabled={locked || !host.trim()}>
                    {t('outside.cf.add')}
                  </Button>
                </form>
              </section>

              {/* Accepted origins */}
              <section>
                <h3 className="mb-2 text-sm font-semibold text-fg">{t('outside.origins')}</h3>
                {s.origins.length === 0 ? (
                  <p className="text-[13px] text-muted">{t('outside.originsNone')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {s.origins.map((o) => (
                      <li key={o.origin} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2">
                        <span className="mono text-[13px]" dir="ltr">
                          {o.origin}
                        </span>
                        <Badge tone="idle">{t(`outside.kind.${o.kind}` as Key)}</Badge>
                        {owner && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ms-auto"
                            busy={busy === `rm:${o.origin}`}
                            onClick={async () => {
                              if (!(await confirm(fill(t('outside.removeConfirm'), { origin: o.origin }), { title: t('outside.remove'), destructive: true }))) return;
                              void act(`rm:${o.origin}`, () => api('/outside-access/origins/remove', { method: 'POST', body: { origin: o.origin } }));
                            }}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                            {t('outside.remove')}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-faint">{t('outside.mfaTip')}</p>
              </section>
            </div>
          );
        }}
      </Async>
    </Card>
  );
}
