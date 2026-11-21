import * as access from '@/features/access/strings';
import * as auth from '@/features/auth/strings';
import * as dashboard from '@/features/dashboard/strings';
import * as devices from '@/features/devices/strings';
import * as discovery from '@/features/discovery/strings';
import * as doctor from '@/features/doctor/strings';
import * as endpoints from '@/features/endpoints/strings';
import * as events from '@/features/events/strings';
import * as incidents from '@/features/incidents/strings';
import * as ipam from '@/features/ipam/strings';
import * as monitoring from '@/features/monitoring/strings';
import * as ports from '@/features/ports/strings';
import * as routers from '@/features/routers/strings';
import * as settings from '@/features/settings/strings';
import * as timeMachine from '@/features/time-machine/strings';
import * as toolbox from '@/features/toolbox/strings';
import * as topology from '@/features/topology/strings';
import * as knowledge from '@/features/knowledge/strings';
import * as assistant from '@/features/assistant/strings';
import * as impact from '@/features/impact/strings';
import * as portfolio from '@/features/portfolio/strings';
import * as security from '@/features/security/strings';
import * as configBackup from '@/features/config-backup/strings';
import * as playbooks from '@/features/playbooks/strings';
import * as core from './core-strings';
import * as ui from './ui-strings';

/**
 * Every feature keeps its `t(key)` strings in its own `strings.ts` (a leaf module with no imports);
 * this file only merges them. Keys are namespaced by feature, so they never collide.
 */
const modules = [core, ui, access, auth, dashboard, devices, discovery, doctor, endpoints, events, incidents, ipam, monitoring, ports, routers, settings, timeMachine, toolbox, topology, knowledge, assistant, impact, portfolio, security, configBackup, playbooks] as const;

type Union = (typeof modules)[number]['en'];
type Merge<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type En = Merge<Union>;

export type Key = keyof En;
export type Locale = 'en' | 'ar';

const merge = (pick: (m: (typeof modules)[number]) => Record<string, string>) => Object.assign({}, ...modules.map(pick)) as Record<Key, string>;

export const dictionaries: Record<Locale, Record<Key, string>> = {
  en: merge((m) => m.en),
  ar: merge((m) => m.ar),
};
