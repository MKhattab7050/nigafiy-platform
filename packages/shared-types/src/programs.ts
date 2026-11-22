// The Nigafiy program family: which program owns which screens (spec §5).
// Shared by the API (GET /api/v1/platform/programs) and the web UI (Hub home and the program shells, lib/programs.ts).
// No runtime dependencies. Accent colours live in @nigafiy/brand.

export const PROGRAM_IDS = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'] as const;
export type ProgramId = (typeof PROGRAM_IDS)[number];

export interface ProgramDefinition {
  readonly id: ProgramId;
  /** Brand stays in Latin letters in Arabic text too. */
  readonly name: { readonly en: string; readonly ar: string };
  readonly job: { readonly en: string; readonly ar: string };
  /** Where the program opens (`PROGRAM_HOME` in routes.ts). */
  readonly home: string;
  /** Every page the program owns, in sidebar order (Milestone 4 namespaced URLs; old URLs redirect, see routes.ts). */
  readonly pages: readonly string[];
}

export const PROGRAMS: readonly ProgramDefinition[] = [
  {
    id: 'hub',
    name: { en: 'Nigafiy Hub', ar: 'Nigafiy Hub' },
    job: { en: 'Home, sign-in, settings and the engine', ar: 'الرئيسية وتسجيل الدخول والإعدادات والمحرك' },
    home: '/',
    pages: ['/', '/portfolio', '/sensors', '/programs', '/settings', '/system/modules'],
  },
  {
    id: 'radar',
    name: { en: 'Nigafiy Radar', ar: 'Nigafiy Radar' },
    job: { en: 'See every device on the network', ar: 'رؤية كل جهاز على الشبكة' },
    home: '/radar/devices',
    pages: ['/radar/devices', '/radar/discovery', '/radar/topology', '/radar/ipam', '/radar/ports'],
  },
  {
    id: 'watch',
    name: { en: 'Nigafiy Watch', ar: 'Nigafiy Watch' },
    job: { en: 'Monitor, and understand what went wrong', ar: 'المراقبة وفهم سبب المشكلة' },
    home: '/watch/monitoring',
    pages: [
      '/watch/monitoring',
      '/watch/incidents',
      '/watch/events',
      '/watch/doctor',
      '/watch/insights',
      '/watch/time-machine',
      '/watch/impact',
      '/watch/reports',
      '/watch/notifications',
      '/watch/maintenance',
    ],
  },
  {
    id: 'guard',
    name: { en: 'Nigafiy Guard', ar: 'Nigafiy Guard' },
    job: { en: 'Protect and control the network', ar: 'حماية الشبكة والتحكم بها' },
    home: '/guard/security',
    pages: ['/guard/security', '/guard/access', '/guard/routers', '/guard/port-control', '/guard/config-backup'],
  },
  {
    id: 'fleet',
    name: { en: 'Nigafiy Fleet', ar: 'Nigafiy Fleet' },
    job: { en: 'Manage and support company computers', ar: 'إدارة أجهزة الشركة ودعمها' },
    home: '/fleet/endpoints',
    pages: ['/fleet/endpoints', '/fleet/sessions'],
  },
  {
    id: 'mind',
    name: { en: 'Nigafiy Mind', ar: 'Nigafiy Mind' },
    job: { en: 'Knowledge, playbooks and automation', ar: 'المعرفة وخطط العمل والأتمتة' },
    home: '/mind/knowledge',
    pages: ['/mind/knowledge', '/mind/playbooks', '/mind/automation'],
  },
  {
    id: 'toolbox',
    name: { en: 'Nigafiy Toolbox', ar: 'Nigafiy Toolbox' },
    job: { en: 'Quick network tools', ar: 'أدوات شبكة سريعة' },
    home: '/toolbox',
    pages: ['/toolbox', '/toolbox/subnet'],
  },
];

/** How the platform knows a program is installed. */
export type ProgramInstallSource =
  /** Part of this desktop app's single install (until Milestone 5 ships one installer per program). */
  | 'bundled'
  /** A separate program installer registered with the engine. */
  | 'installed';

export interface PlatformProgram extends ProgramDefinition {
  readonly installed: boolean;
  readonly install_source: ProgramInstallSource | null;
}

export interface PlatformProgramsResponse {
  readonly items: readonly PlatformProgram[];
}

export type EngineChildState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed';

export interface EngineChild {
  readonly name: string;
  readonly state: EngineChildState;
  readonly pid: number | null;
  readonly restarts: number;
  readonly last_error: string | null;
  readonly started_at: string | null;
}

export type PlatformEngineResponse =
  | {
      readonly reachable: true;
      readonly version: string;
      readonly mode: 'service' | 'foreground';
      readonly started_at: string;
      readonly children: readonly EngineChild[];
    }
  | {
      readonly reachable: false;
      /** Why: the API was not started by an engine (source checkout, `pnpm local`), or the engine did not answer. */
      readonly reason: 'not_running' | 'unreachable' | 'bad_response';
    };

export type PlatformUpdatesResponse =
  | { readonly configured: false; readonly reason: 'no_source' | 'no_key'; readonly current_version: string }
  | {
      readonly configured: true;
      readonly current_version: string;
      readonly checked_at: string;
      readonly ok: true;
      readonly latest_version: string;
      readonly update_available: boolean;
      readonly released_at: string | null;
      readonly notes_url: string | null;
    }
  | {
      readonly configured: true;
      readonly current_version: string;
      readonly checked_at: string;
      readonly ok: false;
      /** Download failed, the signature did not verify, or the manifest was malformed. Never shown as "up to date". */
      readonly error: 'unreachable' | 'bad_signature' | 'bad_manifest';
    };
