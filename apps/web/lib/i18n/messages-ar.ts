// Every Arabic UI string, merged from each feature's leaf `strings.ts`. `satisfies` makes a module left out
// here (or a key missing in one) a compile error, so Arabic never needs an English fallback at runtime.
import type { Key } from './dictionary';
import { ar as core } from './core-strings';
import { ar as ui } from './ui-strings';
import { ar as access } from '../../features/access/strings';
import { ar as auth } from '../../features/auth/strings';
import { ar as dashboard } from '../../features/dashboard/strings';
import { ar as devices } from '../../features/devices/strings';
import { ar as discovery } from '../../features/discovery/strings';
import { ar as doctor } from '../../features/doctor/strings';
import { ar as endpoints } from '../../features/endpoints/strings';
import { ar as events } from '../../features/events/strings';
import { ar as incidents } from '../../features/incidents/strings';
import { ar as ipam } from '../../features/ipam/strings';
import { ar as monitoring } from '../../features/monitoring/strings';
import { ar as ports } from '../../features/ports/strings';
import { ar as routers } from '../../features/routers/strings';
import { ar as settings } from '../../features/settings/strings';
import { ar as timeMachine } from '../../features/time-machine/strings';
import { ar as toolbox } from '../../features/toolbox/strings';
import { ar as topology } from '../../features/topology/strings';
import { ar as knowledge } from '../../features/knowledge/strings';
import { ar as impact } from '../../features/impact/strings';
import { ar as portfolio } from '../../features/portfolio/strings';
import { ar as security } from '../../features/security/strings';
import { ar as configBackup } from '../../features/config-backup/strings';
import { ar as playbooks } from '../../features/playbooks/strings';
import { ar as platform } from '../../features/platform/strings';
import { ar as guide } from '../../features/guide/strings';

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
