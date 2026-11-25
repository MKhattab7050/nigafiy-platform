// Every English UI string, merged from each feature's leaf `strings.ts`. Loaded on its own (lib/i18n
// imports it lazily), so a page in Arabic never downloads these and vice versa. Relative imports keep
// the module loadable by `node --test`.
import { en as core } from './core-strings';
import { en as ui } from './ui-strings';
import { en as access } from '../../features/access/strings';
import { en as auth } from '../../features/auth/strings';
import { en as dashboard } from '../../features/dashboard/strings';
import { en as devices } from '../../features/devices/strings';
import { en as discovery } from '../../features/discovery/strings';
import { en as doctor } from '../../features/doctor/strings';
import { en as endpoints } from '../../features/endpoints/strings';
import { en as events } from '../../features/events/strings';
import { en as incidents } from '../../features/incidents/strings';
import { en as ipam } from '../../features/ipam/strings';
import { en as monitoring } from '../../features/monitoring/strings';
import { en as ports } from '../../features/ports/strings';
import { en as routers } from '../../features/routers/strings';
import { en as settings } from '../../features/settings/strings';
import { en as timeMachine } from '../../features/time-machine/strings';
import { en as toolbox } from '../../features/toolbox/strings';
import { en as topology } from '../../features/topology/strings';
import { en as knowledge } from '../../features/knowledge/strings';
import { en as impact } from '../../features/impact/strings';
import { en as portfolio } from '../../features/portfolio/strings';
import { en as security } from '../../features/security/strings';
import { en as configBackup } from '../../features/config-backup/strings';
import { en as playbooks } from '../../features/playbooks/strings';
import { en as platform } from '../../features/platform/strings';
import { en as guide } from '../../features/guide/strings';

/** The English dictionary; its keys are the type `Key`. */
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
};
