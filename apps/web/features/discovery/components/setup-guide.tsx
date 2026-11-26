'use client';

import clsx from 'clsx';
import { Check, Copy, Laptop, Loader2, PartyPopper, Share2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { Collector, CollectorCreated, NetworkScope, Overview, Site } from '@nigafiy/shared-types';
import { PhoneAccessCard } from '@/features/platform/components/phone-access-card';
import { Button, ErrorNote } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';
import { ScopeSuggestionList, useScopeSuggestions } from './scope-suggestions';
import { InstallCode, onServerComputer } from './token-modal';

type Step = 'install' | 'connect' | 'confirm';
const STEPS: Step[] = ['install', 'connect', 'confirm'];

/** A phone or tablet: it cannot run a Sensor, so the guide says to continue on a computer. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px), (hover: none) and (pointer: coarse)');
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/** Where this site's setup stands, from data the page already has. null = set up. */
export function setupStep(collectors: Collector[], scopes: NetworkScope[]): Step | null {
  const live = collectors.filter((c) => c.status !== 'revoked');
  if (live.length === 0) return 'install';
  if (!live.some((c) => c.status === 'active' && c.last_heartbeat_at)) return 'connect';
  if (scopes.length === 0) return 'confirm';
  return null;
}

/** "Continue on a computer": the link to this page, to copy or share to the computer. */
function ContinueOnComputer() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const url = typeof window === 'undefined' ? '' : `${window.location.origin}/radar/discovery`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <div className="rounded-md border border-accent/30 bg-accent/10 p-3 text-[13px]">
      <p className="flex items-center gap-2 font-medium text-fg">
        <Laptop className="size-4 shrink-0" aria-hidden />
        {t('setup.phone.title')}
      </p>
      <p className="mt-1 text-muted">{t('setup.phone.body')}</p>
      <p className="mono mt-2 break-all text-xs text-fg" dir="ltr">
        {url}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            void navigator.clipboard?.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? t('setup.phone.copied') : t('setup.phone.copy')}
        </Button>
        {canShare && (
          <Button size="sm" onClick={() => void navigator.share({ title: 'Nigafiy', url }).catch(() => undefined)}>
            <Share2 className="size-3.5" aria-hidden />
            {t('setup.phone.share')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * First-run setup for one site, as three steps that advance by themselves: install a Sensor (its
 * one-time code), wait for it to connect, confirm the network it found. Each step is decided from
 * the Sensors and scopes the server reports, so leaving and coming back resumes at the right step.
 * Nothing is scanned until an administrator confirms a range (same POST /sites/:id/scopes).
 */
export function SetupGuide({ site, collectors, scopes, reload }: { site: Site; collectors: Collector[]; scopes: NetworkScope[]; reload: () => void }) {
  const { t } = useI18n();
  const { can } = useApp();
  const admin = can('admin');
  const phone = usePhone();
  const [created, setCreated] = useState<CollectorCreated | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const step = setupStep(collectors, scopes);
  // While waiting for the Sensor, look every 5 s so the guide moves on as soon as it reports.
  const live = useQuery<{ items: Collector[] }>(step === 'connect' ? '/collectors' : null, ['collectors'], 5_000);
  const liveStep = live.data ? setupStep(live.data.items.filter((c) => c.site_id === site.id), scopes) : step;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (step === 'connect' && liveStep !== 'connect') reloadRef.current();
  }, [step, liveStep]);
  const suggestions = useScopeSuggestions(step === 'confirm' ? site.id : null);
  if (!step) return <FirstScan site={site} scopes={scopes} />;

  const pending = collectors.find((c) => c.status === 'pending');
  const issue = async (fn: () => Promise<CollectorCreated>) => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await fn());
      reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const newSensor = () => issue(() => api<CollectorCreated>('/collectors', { method: 'POST', body: { site_id: site.id, name: onServerComputer() ? t('setup.thisComputer') : t('setup.homeComputer') } }));
  const newCode = (id: string) => issue(() => api<CollectorCreated>(`/collectors/${id}/enrollment-token`, { method: 'POST' }));
  const current = STEPS.indexOf(step);

  return (
    <section aria-label={t('setup.title')} className="rounded-[var(--radius-card)] border border-accent/40 bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
      <h2 className="text-[15px] font-semibold text-fg">{fill(t('setup.title'), { site: site.name })}</h2>
      <p className="mt-1 text-[13px] text-muted">{t('setup.intro')}</p>
      <ol className="mt-4 space-y-3">
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s} className={clsx('rounded-md border p-3', active ? 'border-line-strong bg-raised/40' : 'border-line')} aria-current={active ? 'step' : undefined}>
              <p className="flex items-center gap-2.5 text-[13.5px] font-medium">
                <span className={clsx('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-ok/15 text-ok' : active ? 'bg-accent text-on-accent' : 'bg-raised text-faint')}>
                  {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
                </span>
                <span className={done || active ? 'text-fg' : 'text-faint'}>{t(`setup.step.${s}`)}</span>
              </p>
              {active && (
                <div className="mt-3 space-y-3 ps-8.5 text-[13px]">
                  {error && <ErrorNote error={error} />}
                  {s === 'install' && (
                    <>
                      <p className="text-muted">{t('setup.install.body')}</p>
                      {phone && <ContinueOnComputer />}
                      {!admin ? (
                        <p className="text-muted">{t('setup.adminOnly')}</p>
                      ) : created ? (
                        <InstallCode created={created} />
                      ) : (
                        <Button variant="primary" busy={busy} onClick={() => void newSensor()}>
                          {t('setup.install.button')}
                        </Button>
                      )}
                    </>
                  )}
                  {s === 'connect' && (
                    <>
                      <p className="flex items-center gap-2 text-muted" role="status">
                        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                        {t('setup.connect.waiting')}
                      </p>
                      {created ? (
                        <InstallCode created={created} />
                      ) : (
                        <>
                          <p className="text-muted">{t('setup.connect.lost')}</p>
                          {phone && <ContinueOnComputer />}
                          {admin && pending && (
                            <Button busy={busy} onClick={() => void newCode(pending.id)}>
                              {t('setup.connect.newCode')}
                            </Button>
                          )}
                        </>
                      )}
                    </>
                  )}
                  {s === 'confirm' && (
                    <>
                      <p className="text-muted">{t('setup.confirm.body')}</p>
                      {(suggestions.data?.items.length ?? 0) > 0 ? (
                        <ScopeSuggestionList siteId={site.id} items={suggestions.data!.items} admin={admin} onAuthorized={reload} />
                      ) : (
                        <p className="flex items-center gap-2 text-muted" role="status">
                          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                          {t('setup.confirm.waiting')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const DAY = 24 * 60 * 60 * 1000;
const seenKey = (siteId: string) => `nigafiy.firstScanSeen.${siteId}`;

/**
 * Right after setup: the first scan as it happens (devices found so far, every 5 s), then what it
 * found, where to look next and the phone QR code. Shown for a range authorized in the last day until
 * the user closes it (remembered in this browser), so long-standing sites never see it.
 */
function FirstScan({ site, scopes }: { site: Site; scopes: NetworkScope[] }) {
  const { t } = useI18n();
  const [seen, setSeen] = useState(true);
  useEffect(() => setSeen(window.localStorage.getItem(seenKey(site.id)) === '1'), [site.id]);
  const enabled = scopes.filter((s) => s.enabled);
  const scanning = enabled.some((s) => !s.last_run_finished_at);
  const recent = enabled.some((s) => Date.now() - new Date(s.authorized_at).getTime() < DAY);
  const show = !seen && recent;
  const overview = useQuery<Overview>(show ? `/overview${qs({ site_id: site.id })}` : null, ['devices'], scanning ? 5_000 : 30_000);
  if (!show) return null;
  const found = overview.data?.devices.total ?? 0;
  const close = () => {
    window.localStorage.setItem(seenKey(site.id), '1');
    setSeen(true);
  };
  return (
    <div className="space-y-4">
      <section aria-label={t('setup.scan.title')} className="rounded-[var(--radius-card)] border border-accent/40 bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
        {scanning ? (
          <>
            <p className="flex items-center gap-2 text-[15px] font-semibold text-fg" role="status">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
              {t('setup.scan.title')}
            </p>
            <p className="mt-1 text-[13px] text-muted">{t('setup.scan.body')}</p>
            <p className="tnum mt-3 text-[28px] font-semibold leading-none text-fg" aria-live="polite">
              {found}
              <span className="ms-2 text-[13px] font-normal text-muted">{t('setup.scan.soFar')}</span>
            </p>
          </>
        ) : (
          <>
            <p className="flex items-center gap-2 text-[15px] font-semibold text-fg">
              <PartyPopper className="size-4 shrink-0 text-ok" aria-hidden />
              {fill(t('setup.scan.done'), { count: found })}
            </p>
            <p className="mt-1 text-[13px] text-muted">{t('setup.scan.next')}</p>
          </>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/radar/devices" className="inline-flex h-8 items-center rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-strong">
            {t('setup.scan.devices')}
          </Link>
          <Button size="sm" onClick={close}>
            {t('setup.scan.close')}
          </Button>
        </div>
      </section>
      <PhoneAccessCard />
    </div>
  );
}
