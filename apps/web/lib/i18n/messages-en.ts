// Every English UI string, merged from each feature's leaf `strings.ts`. Only the server imports it (lib/i18n/server.ts
// hands only the active language to the client), so neither file is client JavaScript. Relative .ts imports keep
// the module loadable by `node --test`.
import { en as core } from './core-strings.ts';
import { en as ui } from './ui-strings.ts';
import { en as access } from '../../features/access/strings.ts';
import { en as auth } from '../../features/auth/strings.ts';
import { en as ownPassword } from '../../features/auth/own-password-strings.ts';
import { en as dbBackups } from '../../features/settings/backup-strings.ts';
import { en as outsideAccess } from '../../features/settings/outside-access-strings.ts';
import { en as push } from '../../features/settings/push-strings.ts';
import { en as calm } from '../../features/settings/calm-strings.ts';
import { en as telegramLink } from '../../features/settings/telegram-strings.ts';
import { en as dashboard } from '../../features/dashboard/strings.ts';
import { en as devices } from '../../features/devices/strings.ts';
import { en as discovery } from '../../features/discovery/strings.ts';
import { en as doctor } from '../../features/doctor/strings.ts';
import { en as endpoints } from '../../features/endpoints/strings.ts';
import { en as events } from '../../features/events/strings.ts';
import { en as incidents } from '../../features/incidents/strings.ts';
import { en as ipam } from '../../features/ipam/strings.ts';
import { en as monitoring } from '../../features/monitoring/strings.ts';
import { en as ports } from '../../features/ports/strings.ts';
import { en as routers } from '../../features/routers/strings.ts';
import { en as settings } from '../../features/settings/strings.ts';
import { en as timeMachine } from '../../features/time-machine/strings.ts';
import { en as toolbox } from '../../features/toolbox/strings.ts';
import { en as topology } from '../../features/topology/strings.ts';
import { en as knowledge } from '../../features/knowledge/strings.ts';
import { en as impact } from '../../features/impact/strings.ts';
import { en as portfolio } from '../../features/portfolio/strings.ts';
import { en as security } from '../../features/security/strings.ts';
import { en as configBackup } from '../../features/config-backup/strings.ts';
import { en as playbooks } from '../../features/playbooks/strings.ts';
import { en as platform } from '../../features/platform/strings.ts';
import { en as guide } from '../../features/guide/strings.ts';

/** The English dictionary; its keys are the type `Key`. */
export const messages = {
  ...core,
  ...ui,
  ...access,
  ...auth,
  ...ownPassword,
  ...dbBackups,
  ...outsideAccess,
  ...push,
  ...calm,
  ...telegramLink,
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
