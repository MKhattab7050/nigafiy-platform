'use client';

import {
  Activity,
  Bell,
  BookOpen,
  Building2,
  Cable,
  Calculator,
  CalendarClock,
  Clock,
  Cpu,
  FileBarChart2,
  Gauge,
  GitBranch,
  Hash,
  History,
  LayoutGrid,
  Lightbulb,
  type LucideIcon,
  MonitorSmartphone,
  Network,
  Radar,
  RadioTower,
  Router,
  Settings,
  ShieldCheck,
  Siren,
  Stethoscope,
  ToggleRight,
  Workflow,
  Wrench,
} from 'lucide-react';
import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import type { Paginated, Role } from '@lan-detective/shared-types';
import type { ProgramId } from '@lan-detective/shared-types/programs';
import { qs } from '@/lib/api';
import type { Topic } from '@/lib/app';
import type { Key } from '@/lib/i18n';

/**
 * THE list of features. The program sidebars, the Hub dashboard and the quick actions all render
 * from it; nothing else hard-codes which features exist.
 *
 * Each feature belongs to exactly one program (spec §5) and its `route` lives in that program's URL
 * namespace (`@lan-detective/shared-types/routes`; old URLs redirect). The sidebar order is the
 * program's page order in `@lan-detective/shared-types/programs`; `lib/programs.ts` joins the two.
 *
 * Each feature lives in `features/<id>/` and exposes `index.ts` (its screens and the few components
 * other features may use). The dashboard widget is the one other public entry (`widget.tsx`): it is
 * loaded lazily here so the sidebar never pulls a feature's screens into every page.
 */

/** A count shown next to the sidebar link, read from an existing list endpoint. */
export interface NavBadge {
  path: (siteId: string | null) => string;
  topics: Topic[];
  count: (data: unknown) => number;
  label: Key;
}

export interface DashboardWidget {
  component: LazyExoticComponent<ComponentType>;
  /** Grid width on wide screens: one column (default), two, or the full row. */
  span?: 'wide' | 'full';
  /** Lower comes first. */
  order: number;
  /** Hide the widget below this role (the data behind it is restricted). */
  minRole?: Role;
  /** The widget reports items to "Needs your attention" under the feature id; the panel waits for it. */
  attention?: boolean;
}

export interface Feature {
  id: string;
  /** The program that owns this feature (spec §5). */
  program: ProgramId;
  route: string;
  label: Key;
  icon: LucideIcon;
  /** Shown at the bottom of the program's sidebar, above the account block. */
  pinBottom?: boolean;
  /** Hide the link and the widget below this role. No feature is restricted today. */
  minRole?: Role;
  badge?: NavBadge;
  widget?: DashboardWidget;
  /** Listed under the Hub dashboard's quick actions. */
  quickAction?: boolean;
}

export const FEATURES: Feature[] = [
  // ── Nigafiy Hub ──
  { id: 'dashboard', program: 'hub', route: '/', label: 'nav.dashboard', icon: Gauge },
  {
    id: 'portfolio',
    program: 'hub',
    route: '/portfolio',
    label: 'nav.portfolio',
    icon: Building2,
    widget: { component: lazy(() => import('./portfolio/widget')), order: 15 },
  },
  { id: 'sensors', program: 'hub', route: '/sensors', label: 'platform.nav.sensors', icon: RadioTower },
  { id: 'programs', program: 'hub', route: '/programs', label: 'platform.nav.programs', icon: LayoutGrid },
  { id: 'settings', program: 'hub', route: '/settings', label: 'nav.settings', icon: Settings, pinBottom: true },

  // ── Nigafiy Radar ──
  {
    id: 'devices',
    program: 'radar',
    route: '/radar/devices',
    label: 'nav.devices',
    icon: MonitorSmartphone,
    widget: { component: lazy(() => import('./devices/widget')), order: 30, attention: true },
  },
  {
    id: 'discovery',
    program: 'radar',
    route: '/radar/discovery',
    label: 'nav.discovery',
    icon: Radar,
    widget: { component: lazy(() => import('./discovery/widget')), order: 60, attention: true },
  },
  { id: 'topology', program: 'radar', route: '/radar/topology', label: 'nav.networkMap', icon: Network, quickAction: true },
  {
    id: 'ipam',
    program: 'radar',
    route: '/radar/ipam',
    label: 'nav.ipam',
    icon: Hash,
    widget: { component: lazy(() => import('./ipam/widget')), order: 70, attention: true },
  },
  {
    id: 'ports',
    program: 'radar',
    route: '/radar/ports',
    label: 'nav.switchPorts',
    icon: Cable,
    widget: { component: lazy(() => import('./ports/widget')), order: 80, attention: true },
  },

  // ── Nigafiy Watch ──
  {
    id: 'monitoring',
    program: 'watch',
    route: '/watch/monitoring',
    label: 'nav.monitoring',
    icon: Activity,
    widget: { component: lazy(() => import('./monitoring/widget')), order: 40, attention: true, span: 'wide' },
  },
  {
    id: 'incidents',
    program: 'watch',
    route: '/watch/incidents',
    label: 'nav.incidents',
    icon: Siren,
    badge: {
      path: (siteId) => `/incidents${qs({ status: 'active', site_id: siteId, page_size: 1 })}`,
      topics: ['events', 'checks', 'collectors'],
      count: (data) => (data as Paginated<unknown>).total,
      label: 'nav.openIncidents',
    },
    widget: { component: lazy(() => import('./incidents/widget')), order: 10, attention: true, span: 'wide' },
  },
  {
    id: 'events',
    program: 'watch',
    route: '/watch/events',
    label: 'nav.events',
    icon: History,
    widget: { component: lazy(() => import('./events/widget')), order: 100, span: 'wide' },
  },
  {
    id: 'doctor',
    program: 'watch',
    route: '/watch/doctor',
    label: 'nav.doctor',
    icon: Stethoscope,
    quickAction: true,
    widget: { component: lazy(() => import('./doctor/widget')), order: 20 },
  },
  { id: 'insights', program: 'watch', route: '/watch/insights', label: 'platform.nav.insights', icon: Lightbulb },
  { id: 'time-machine', program: 'watch', route: '/watch/time-machine', label: 'nav.timeMachine', icon: Clock, quickAction: true },
  {
    id: 'impact',
    program: 'watch',
    route: '/watch/impact',
    label: 'nav.impact',
    icon: GitBranch,
    quickAction: true,
    widget: { component: lazy(() => import('./impact/widget')), order: 75 },
  },
  { id: 'reports', program: 'watch', route: '/watch/reports', label: 'platform.nav.reports', icon: FileBarChart2 },
  {
    id: 'notifications',
    program: 'watch',
    route: '/watch/notifications',
    label: 'settings.notifications',
    icon: Bell,
    widget: { component: lazy(() => import('./settings/widget')), order: 120, attention: true, minRole: 'admin' },
  },
  { id: 'maintenance', program: 'watch', route: '/watch/maintenance', label: 'platform.nav.maintenance', icon: CalendarClock },

  // ── Nigafiy Guard ──
  {
    id: 'security',
    program: 'guard',
    route: '/guard/security',
    label: 'nav.security',
    icon: ShieldCheck,
    widget: { component: lazy(() => import('./security/widget')), order: 66, attention: true },
  },
  {
    id: 'access',
    program: 'guard',
    route: '/guard/access',
    label: 'nav.access',
    icon: ShieldCheck,
    widget: { component: lazy(() => import('./access/widget')), order: 90, attention: true },
  },
  {
    id: 'routers',
    program: 'guard',
    route: '/guard/routers',
    label: 'nav.routers',
    icon: Router,
    widget: { component: lazy(() => import('./routers/widget')), order: 65, attention: true },
  },
  { id: 'port-control', program: 'guard', route: '/guard/port-control', label: 'platform.nav.portControl', icon: ToggleRight },
  {
    id: 'config-backup',
    program: 'guard',
    route: '/guard/config-backup',
    label: 'nav.configBackup',
    icon: History,
    widget: { component: lazy(() => import('./config-backup/widget')), order: 67, attention: true },
  },

  // ── Nigafiy Fleet ──
  {
    id: 'endpoints',
    program: 'fleet',
    route: '/fleet/endpoints',
    label: 'nav.managedComputers',
    icon: Cpu,
    widget: { component: lazy(() => import('./endpoints/widget')), order: 50, attention: true },
  },

  // ── Nigafiy Mind ──
  {
    id: 'knowledge',
    program: 'mind',
    route: '/mind/knowledge',
    label: 'nav.knowledge',
    icon: BookOpen,
    badge: {
      path: () => '/knowledge/counts',
      topics: ['events'],
      count: (data) => (data as { candidate: number }).candidate,
      label: 'nav.knowledgeCandidates',
    },
    widget: { component: lazy(() => import('./knowledge/widget')), order: 105 },
  },
  {
    id: 'playbooks',
    program: 'mind',
    route: '/mind/playbooks',
    label: 'nav.playbooks',
    icon: GitBranch,
    badge: {
      path: () => '/playbook-approvals?page_size=100',
      topics: ['events'],
      count: (data) => (data as { items: unknown[] }).items.length,
      label: 'nav.pendingApprovals',
    },
    widget: { component: lazy(() => import('./playbooks/widget')), order: 95, attention: true },
  },
  { id: 'automation', program: 'mind', route: '/mind/automation', label: 'platform.nav.automation', icon: Workflow },

  // ── Nigafiy Toolbox ──
  {
    id: 'toolbox',
    program: 'toolbox',
    route: '/toolbox',
    label: 'nav.toolbox',
    icon: Wrench,
    quickAction: true,
    widget: { component: lazy(() => import('./toolbox/widget')), order: 110 },
  },
  { id: 'subnet', program: 'toolbox', route: '/toolbox/subnet', label: 'platform.nav.subnet', icon: Calculator },
];

/**
 * Is `route` the current page (or one of its detail pages)? A program's home that is also its
 * namespace root (`/toolbox`) only matches itself and paths no other section of it claims.
 */
export const isActiveRoute = (route: string, pathname: string, siblings: readonly string[] = []): boolean => {
  if (route === '/') return pathname === '/';
  if (pathname === route) return true;
  if (!pathname.startsWith(`${route}/`)) return false;
  return !siblings.some((s) => s !== route && s.length > route.length && (pathname === s || pathname.startsWith(`${s}/`)));
};
