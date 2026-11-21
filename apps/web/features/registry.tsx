'use client';

import {
  Activity,
  Cable,
  Clock,
  Cpu,
  Gauge,
  Hash,
  History,
  type LucideIcon,
  MonitorSmartphone,
  Network,
  Radar,
  Router,
  Settings,
  ShieldCheck,
  Siren,
  Stethoscope,
  Wrench,
} from 'lucide-react';
import { BookOpen, Building2, GitBranch, Sparkles } from 'lucide-react'; // Phase 6: knowledge, portfolio, impact, assistant
import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import type { Paginated, Role } from '@lan-detective/shared-types';
import { qs } from '@/lib/api';
import type { Topic } from '@/lib/app';
import type { Key } from '@/lib/i18n';

/**
 * THE list of features. The sidebar, the dashboard and the quick actions all render from it;
 * nothing else hard-codes which features exist.
 *
 * Each feature lives in `features/<id>/` and exposes `index.ts` (its screens and the few components
 * other features may use). The dashboard widget is the one other public entry (`widget.tsx`): it is
 * loaded lazily here so the sidebar never pulls a feature's screens into every page.
 */

export type NavGroupId = 'network' | 'computers' | 'health' | 'tools';

/** Sidebar sections in display order. 'top' sits alone above the groups; 'bottom' is pinned above the account block. */
export type Placement = 'top' | NavGroupId | 'bottom';

export const NAV_GROUPS: { id: NavGroupId; label: Key }[] = [
  { id: 'network', label: 'nav.group.network' },
  { id: 'computers', label: 'nav.group.computers' },
  { id: 'health', label: 'nav.group.health' },
  { id: 'tools', label: 'nav.group.tools' },
];

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
  route: string;
  label: Key;
  icon: LucideIcon;
  placement: Placement;
  /** Hide the link and the widget below this role. No feature is restricted today. */
  minRole?: Role;
  badge?: NavBadge;
  widget?: DashboardWidget;
  /** Listed under the dashboard's quick actions. */
  quickAction?: boolean;
}

export const FEATURES: Feature[] = [
  { id: 'dashboard', route: '/', label: 'nav.dashboard', icon: Gauge, placement: 'top' },

  {
    id: 'devices',
    route: '/devices',
    label: 'nav.devices',
    icon: MonitorSmartphone,
    placement: 'network',
    widget: { component: lazy(() => import('./devices/widget')), order: 30, attention: true },
  },
  { id: 'topology', route: '/topology', label: 'nav.networkMap', icon: Network, placement: 'network', quickAction: true },
  {
    id: 'ports',
    route: '/ports',
    label: 'nav.switchPorts',
    icon: Cable,
    placement: 'network',
    widget: { component: lazy(() => import('./ports/widget')), order: 80, attention: true },
  },
  {
    id: 'ipam',
    route: '/ipam',
    label: 'nav.ipam',
    icon: Hash,
    placement: 'network',
    widget: { component: lazy(() => import('./ipam/widget')), order: 70, attention: true },
  },
  {
    id: 'discovery',
    route: '/discovery',
    label: 'nav.discovery',
    icon: Radar,
    placement: 'network',
    widget: { component: lazy(() => import('./discovery/widget')), order: 60, attention: true },
  },
  {
    id: 'routers',
    route: '/routers',
    label: 'nav.routers',
    icon: Router,
    placement: 'network',
    widget: { component: lazy(() => import('./routers/widget')), order: 65, attention: true },
  },

  {
    id: 'endpoints',
    route: '/endpoints',
    label: 'nav.managedComputers',
    icon: Cpu,
    placement: 'computers',
    widget: { component: lazy(() => import('./endpoints/widget')), order: 50, attention: true },
  },

  {
    id: 'monitoring',
    route: '/monitoring',
    label: 'nav.monitoring',
    icon: Activity,
    placement: 'health',
    widget: { component: lazy(() => import('./monitoring/widget')), order: 40, attention: true, span: 'wide' },
  },
  {
    id: 'incidents',
    route: '/incidents',
    label: 'nav.incidents',
    icon: Siren,
    placement: 'health',
    badge: {
      path: (siteId) => `/incidents${qs({ status: 'active', site_id: siteId, page_size: 1 })}`,
      topics: ['events', 'checks', 'collectors'],
      count: (data) => (data as Paginated<unknown>).total,
      label: 'nav.openIncidents',
    },
    widget: { component: lazy(() => import('./incidents/widget')), order: 10, attention: true, span: 'wide' },
  },
  {
    id: 'doctor',
    route: '/doctor',
    label: 'nav.doctor',
    icon: Stethoscope,
    placement: 'health',
    quickAction: true,
    widget: { component: lazy(() => import('./doctor/widget')), order: 20 },
  },
  {
    id: 'events',
    route: '/events',
    label: 'nav.events',
    icon: History,
    placement: 'health',
    widget: { component: lazy(() => import('./events/widget')), order: 100, span: 'wide' },
  },
  { id: 'time-machine', route: '/time-machine', label: 'nav.timeMachine', icon: Clock, placement: 'health', quickAction: true },

  {
    id: 'toolbox',
    route: '/toolbox',
    label: 'nav.toolbox',
    icon: Wrench,
    placement: 'tools',
    quickAction: true,
    widget: { component: lazy(() => import('./toolbox/widget')), order: 110 },
  },
  {
    id: 'access',
    route: '/access',
    label: 'nav.access',
    icon: ShieldCheck,
    placement: 'tools',
    widget: { component: lazy(() => import('./access/widget')), order: 90, attention: true },
  },

  // ── Phase 6: knowledge memory, digital twin impact, multi-site portfolio, optional AI assistant ──
  {
    id: 'portfolio',
    route: '/portfolio',
    label: 'nav.portfolio',
    icon: Building2,
    placement: 'top',
    widget: { component: lazy(() => import('./portfolio/widget')), order: 15 },
  },
  {
    id: 'impact',
    route: '/impact',
    label: 'nav.impact',
    icon: GitBranch,
    placement: 'network',
    quickAction: true,
    widget: { component: lazy(() => import('./impact/widget')), order: 75 },
  },
  {
    id: 'knowledge',
    route: '/knowledge',
    label: 'nav.knowledge',
    icon: BookOpen,
    placement: 'health',
    badge: {
      path: () => '/knowledge/counts',
      topics: ['events'],
      count: (data) => (data as { candidate: number }).candidate,
      label: 'nav.knowledgeCandidates',
    },
    widget: { component: lazy(() => import('./knowledge/widget')), order: 105 },
  },
  { id: 'assistant', route: '/assistant', label: 'nav.assistant', icon: Sparkles, placement: 'tools' },

  {
    id: 'settings',
    route: '/settings',
    label: 'nav.settings',
    icon: Settings,
    placement: 'bottom',
    widget: { component: lazy(() => import('./settings/widget')), order: 120, attention: true, minRole: 'admin' },
  },
];

/** Is `route` the current page (or one of its detail pages)? */
export const isActiveRoute = (route: string, pathname: string): boolean => (route === '/' ? pathname === '/' : pathname === route || pathname.startsWith(`${route}/`));
