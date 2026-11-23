'use client';

import type { DeviceDetail, DeviceType, EndpointSummary } from '@nigafiy/shared-types';
import type { ProgramId } from '@nigafiy/shared-types/programs';
import type { DeviceAction } from '@nigafiy/shared-types/routes';
import clsx from 'clsx';
import {
  Activity,
  Ban,
  BellOff,
  BookOpen,
  Cable,
  FolderOpen,
  GitBranch,
  History,
  type LucideIcon,
  MonitorUp,
  PauseCircle,
  Power,
  Router,
  ScanSearch,
  ShieldCheck,
  Siren,
  Cpu,
  Wifi,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, Card } from '@/components/ui';
import { InstallNote, ProgramGlyph } from '@/features/platform';
import { useApp, useQuery } from '@/lib/app';
import { type Key, useI18n } from '@/lib/i18n';
import { PROGRAM_REGISTRY } from '@/lib/programs';
import { usePrograms } from '@/lib/programs-context';

/** Where each "jump" action lands on the shared device card (ids set by the card's sections). */
export const DEVICE_SECTION = {
  identification: 'device-identification',
  trust: 'device-trust',
  mute: 'device-mute',
  wake: 'device-wake',
  monitor: 'device-monitor',
  events: 'device-events',
  impact: 'device-impact',
  router: 'device-router',
  block: 'device-block',
  access: 'device-access',
  port: 'device-port',
  backup: 'device-backup',
  endpoint: 'device-endpoint',
  knowledge: 'device-knowledge',
} as const;

/** Device types the endpoint agent cannot run on (the same list as the Fleet card on this page). */
const NO_AGENT: ReadonlySet<DeviceType> = new Set<DeviceType>(['mobile', 'printer', 'camera', 'media_player', 'iot']);

type ActionSpec =
  | {
      id: DeviceAction;
      label: Key;
      icon: LucideIcon;
      /** Scroll to and highlight the first of these sections present on the card. */
      jump: string[];
      /** When none of them is on the card (for example no router controls for this device). */
      fallbackHref?: string;
    }
  | { id: DeviceAction; label: Key; icon: LucideIcon; href: string }
  | { id: DeviceAction; label: Key; icon: LucideIcon; unavailable: Key };

const HIGHLIGHT = ['ring-2', 'ring-accent', 'ring-offset-2', 'ring-offset-bg'];

/** Scrolls to a section of the card and highlights it for a moment; opens it when it is a <details>. Returns false when absent. */
function focusSection(ids: readonly string[]): boolean {
  // A section that rendered nothing (an empty wrapper) counts as absent.
  const el = ids.map((id) => document.getElementById(id)).find((x): x is HTMLElement => Boolean(x && (x.offsetHeight > 0 || x instanceof HTMLDetailsElement)));
  if (!el) return false;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  el.classList.add(...HIGHLIGHT);
  window.setTimeout(() => el.classList.remove(...HIGHLIGHT), 2400);
  return true;
}

/**
 * The shared device card's action bar (spec §5): every program's actions for this device, grouped
 * by program. Each action jumps to the control on this card that does the job, or opens the page
 * that owns it; the controls themselves are unchanged. A program that is not installed shows
 * "Available in Nigafiy X: Install" instead of its actions. `?action=<name>` (from a
 * `nigafiy://<program>/devices/<id>/<action>` link) focuses that action on load.
 */
export function DeviceActions({ device: d }: { device: DeviceDetail }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const { installed } = usePrograms();
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('action');
  const bar = useRef<HTMLElement>(null);
  const endpoints = useQuery<{ items: EndpointSummary[] }>(`/endpoints?device_id=${d.id}`, ['devices'], 15_000);
  const ep = endpoints.data?.items[0] ?? null;
  const tech = can('technician');
  const admin = can('admin');
  const toolbox = (tool: string) => `/toolbox?site_id=${encodeURIComponent(d.site_id)}&target=${encodeURIComponent(d.current_ip ?? '')}&tool=${tool}`;

  const groups: Record<Exclude<ProgramId, 'hub'>, ActionSpec[]> = {
    radar: [
      { id: 'identify', label: 'platform.action.identify', icon: ScanSearch, jump: [DEVICE_SECTION.identification] },
      { id: 'trust', label: 'platform.action.trust', icon: ShieldCheck, jump: [DEVICE_SECTION.trust] },
      ...(tech
        ? [d.primary_mac ? { id: 'wake' as const, label: 'platform.action.wake' as const, icon: Power, jump: [DEVICE_SECTION.wake] } : { id: 'wake' as const, label: 'platform.action.wake' as const, icon: Power, unavailable: 'platform.action.noMac' as const }]
        : []),
    ],
    watch: [
      { id: 'monitor', label: 'platform.action.monitor', icon: Activity, jump: [DEVICE_SECTION.monitor] },
      { id: 'mute', label: 'platform.action.mute', icon: BellOff, jump: [DEVICE_SECTION.mute] },
      { id: 'incidents', label: 'platform.action.incidents', icon: Siren, href: `/watch/incidents?device_id=${encodeURIComponent(d.id)}` },
      { id: 'events', label: 'platform.action.events', icon: History, jump: [DEVICE_SECTION.events] },
      { id: 'impact', label: 'platform.action.impact', icon: GitBranch, jump: [DEVICE_SECTION.impact] },
    ],
    guard: [
      { id: 'block', label: 'platform.action.block', icon: Ban, jump: [DEVICE_SECTION.router, DEVICE_SECTION.block] },
      { id: 'pause', label: 'platform.action.pause', icon: PauseCircle, jump: [DEVICE_SECTION.access] },
      { id: 'quarantine', label: 'platform.action.quarantine', icon: Cable, jump: [DEVICE_SECTION.port] },
      { id: 'router', label: 'platform.action.router', icon: Router, jump: [DEVICE_SECTION.router], fallbackHref: '/guard/routers' },
      { id: 'backup', label: 'platform.action.backup', icon: History, jump: [DEVICE_SECTION.backup] },
    ],
    fleet: ep
      ? [
          { id: 'remote', label: 'platform.action.remote', icon: MonitorUp, href: `/fleet/endpoints/${encodeURIComponent(ep.id)}?tab=desktop` },
          { id: 'files', label: 'platform.action.files', icon: FolderOpen, href: `/fleet/endpoints/${encodeURIComponent(ep.id)}?tab=files` },
        ]
      : endpoints.data && admin && !NO_AGENT.has(d.device_type)
        ? [{ id: 'enroll', label: 'platform.action.enroll', icon: Cpu, jump: [DEVICE_SECTION.endpoint], fallbackHref: `/fleet/endpoints?enroll_device=${encodeURIComponent(d.id)}` }]
        : endpoints.data
          ? [{ id: 'remote', label: 'platform.action.remote', icon: MonitorUp, unavailable: 'platform.action.notEnrolled' }]
          : [],
    mind: [{ id: 'knowledge', label: 'platform.action.knowledge', icon: BookOpen, jump: [DEVICE_SECTION.knowledge], fallbackHref: '/mind/knowledge' }],
    toolbox: tech
      ? d.current_ip
        ? [
            { id: 'ping', label: 'platform.action.ping', icon: Wifi, href: toolbox('ping') },
            { id: 'ports', label: 'platform.action.ports', icon: Wrench, href: toolbox('ports') },
          ]
        : [{ id: 'ping', label: 'platform.action.ping', icon: Wifi, unavailable: 'platform.action.noIp' }]
      : [],
  };
  const all = Object.entries(groups).flatMap(([program, specs]) => specs.map((s) => ({ program: program as ProgramId, spec: s })));

  const run = useCallback(
    (spec: ActionSpec) => {
      if ('jump' in spec) {
        if (!focusSection(spec.jump) && spec.fallbackHref) router.push(spec.fallbackHref);
      }
    },
    [router],
  );

  // ?action=<name>: focus that action once the card (and, for Fleet, the endpoint lookup) is there.
  const handled = useRef<string | null>(null);
  const endpointsReady = endpoints.data !== undefined;
  const hit = requested ? all.find((a) => a.spec.id === requested) : undefined;
  const hitProgram = hit?.program ?? null;
  const hitJump = hit && 'jump' in hit.spec ? hit.spec.jump.join(' ') : '';
  const hitInstalled = hitProgram ? installed(hitProgram) : false;
  useEffect(() => {
    if (!requested || !hitProgram || handled.current === requested || !endpointsReady) return;
    // Let the sections below finish their first render before scrolling.
    const timer = window.setTimeout(() => {
      handled.current = requested;
      if (hitInstalled && hitJump && focusSection(hitJump.split(' '))) return;
      // A link action, an unavailable one, a missing section or a program that is not installed: point at it in the bar.
      const target = bar.current?.querySelector<HTMLElement>(`[data-action="${requested}"]`) ?? bar.current?.querySelector<HTMLElement>(`[data-program-group="${hitProgram}"]`);
      if (target) focusSection([target.id]);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [requested, hitProgram, hitJump, hitInstalled, endpointsReady]);

  const cls = clsx(BUTTON_BASE, BUTTON_SIZE.sm, BUTTON_VARIANT.secondary);
  const programs = PROGRAM_REGISTRY.filter((p) => p.id !== 'hub' && groups[p.id as Exclude<ProgramId, 'hub'>].length > 0);

  return (
    <section ref={bar} aria-labelledby="device-actions-title" className="mb-5">
      <Card title={<span id="device-actions-title">{t('platform.actions.title')}</span>} description={t('platform.actions.hint')}>
        <ul className="grid gap-x-6 gap-y-3 md:grid-cols-2 2xl:grid-cols-3">
          {programs.map((p) => {
            const specs = groups[p.id as Exclude<ProgramId, 'hub'>];
            return (
              <li key={p.id} id={`device-actions-${p.id}`} data-program-group={p.id} className="min-w-0 rounded-[var(--radius-control)]">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
                  <ProgramGlyph id={p.id} size={18} />
                  <bdi>{p.name[locale]}</bdi>
                </p>
                {!installed(p.id) ? (
                  <InstallNote program={p.id} />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {specs.map((s) => {
                      const Icon = s.icon;
                      const common = { id: `device-action-${s.id}`, 'data-action': s.id } as const;
                      if ('unavailable' in s)
                        return (
                          <span key={s.id} {...common} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-1 text-xs text-faint">
                            <Icon className="size-3.5" aria-hidden />
                            {t(s.label)}: {t(s.unavailable)}
                          </span>
                        );
                      if ('href' in s)
                        return (
                          <Link key={s.id} {...common} href={s.href} className={cls}>
                            <Icon className="size-3.5" aria-hidden />
                            {t(s.label)}
                          </Link>
                        );
                      return (
                        <button key={s.id} {...common} type="button" className={cls} onClick={() => run(s)}>
                          <Icon className="size-3.5" aria-hidden />
                          {t(s.label)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}
