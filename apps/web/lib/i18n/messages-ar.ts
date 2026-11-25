// Every Arabic UI string, merged from each feature's leaf `strings.ts`. `satisfies` makes a module left out
// here (or a key missing in one) a compile error, so Arabic never needs an English fallback at runtime.
import type { Key } from './dictionary.ts';
import { ar as core } from './core-strings.ts';
import { ar as ui } from './ui-strings.ts';
import { ar as access } from '../../features/access/strings.ts';
import { ar as auth } from '../../features/auth/strings.ts';
import { ar as dashboard } from '../../features/dashboard/strings.ts';
import { ar as devices } from '../../features/devices/strings.ts';
import { ar as discovery } from '../../features/discovery/strings.ts';
import { ar as doctor } from '../../features/doctor/strings.ts';
import { ar as endpoints } from '../../features/endpoints/strings.ts';
import { ar as events } from '../../features/events/strings.ts';
import { ar as incidents } from '../../features/incidents/strings.ts';
import { ar as ipam } from '../../features/ipam/strings.ts';
import { ar as monitoring } from '../../features/monitoring/strings.ts';
import { ar as ports } from '../../features/ports/strings.ts';
import { ar as routers } from '../../features/routers/strings.ts';
import { ar as settings } from '../../features/settings/strings.ts';
import { ar as timeMachine } from '../../features/time-machine/strings.ts';
import { ar as toolbox } from '../../features/toolbox/strings.ts';
import { ar as topology } from '../../features/topology/strings.ts';
import { ar as knowledge } from '../../features/knowledge/strings.ts';
import { ar as impact } from '../../features/impact/strings.ts';
import { ar as portfolio } from '../../features/portfolio/strings.ts';
import { ar as security } from '../../features/security/strings.ts';
import { ar as configBackup } from '../../features/config-backup/strings.ts';
import { ar as playbooks } from '../../features/playbooks/strings.ts';
import { ar as platform } from '../../features/platform/strings.ts';
import { ar as guide } from '../../features/guide/strings.ts';

export const messages = {
  ...core,
  ...ui,
  ...access,
  ...auth,
  ...dashboard,
  ...devices,
  ...discovery,
  ...doctor,
  ...endpoints,
  ...events,
  ...incidents,
  ...ipam,
  ...monitoring,
  ...ports,
  ...routers,
  ...settings,
  ...timeMachine,
  ...toolbox,
  ...topology,
  ...knowledge,
  ...impact,
  ...portfolio,
  ...security,
  ...configBackup,
  ...playbooks,
  ...platform,
  ...guide,
} satisfies Record<Key, string>;
