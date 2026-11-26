import { type ModuleManifest, validateModules } from '../infrastructure/module.ts';
import { accessModule } from './access/index.ts';
import { authModule } from './auth/index.ts';
import { automationModule } from './automation/index.ts';
import { backupsModule } from './backups/index.ts';
import { collectorsModule } from './collectors/index.ts';
import { configBackupModule } from './configbackup/index.ts';
import { correlationModule } from './correlation/index.ts';
import { devicesModule } from './devices/index.ts';
import { doctorModule } from './doctor/index.ts';
import { endpointsModule } from './endpoints/index.ts';
import { eventsModule } from './events/index.ts';
import { impactModule } from './impact/index.ts';
import { incidentsModule } from './incidents/index.ts';
import { ingestModule } from './ingest/index.ts';
import { insightsModule } from './insights/index.ts';
import { ipamModule } from './ipam/index.ts';
import { knowledgeModule } from './knowledge/index.ts';
import { maintenanceModule } from './maintenance/index.ts';
import { monitoringModule } from './monitoring/index.ts';
import { notificationsModule } from './notifications/index.ts';
import { outsideAccessModule } from './outside-access/index.ts';
import { overviewModule } from './overview/index.ts';
import { platformModule } from './platform/index.ts';
import { playbooksModule } from './playbooks/index.ts';
import { portfolioModule } from './portfolio/index.ts';
import { portsModule } from './ports/index.ts';
import { realtimeModule } from './realtime/index.ts';
import { routersModule } from './routers/index.ts';
import { securityModule } from './security/index.ts';
import { sitesModule } from './sites/index.ts';
import { createSystemModule } from './system/index.ts';
import { timeMachineModule } from './timemachine/index.ts';
import { toolboxModule } from './toolbox/index.ts';
import { topologyModule } from './topology/index.ts';

/**
 * Every module of the API, in mount order. app.ts mounts, per kind and in this order:
 *   1. gateways (ingest → /api/v1/collector, endpoints → /api/v1/agent), each with its own limit and body parser;
 *   2. public routes (auth → /api/v1/auth);
 *   3. session routes, after requireSession — in the same order as before the module split.
 * Library modules (no routes, no jobs) are listed so the system report shows them.
 */
export const modules: readonly ModuleManifest[] = validateModules([
  authModule,
  ingestModule,
  overviewModule,
  insightsModule,
  accessModule,
  portsModule,
  ipamModule,
  toolboxModule,
  routersModule,
  securityModule,
  endpointsModule,
  sitesModule,
  collectorsModule,
  devicesModule,
  maintenanceModule,
  monitoringModule,
  eventsModule,
  notificationsModule,
  realtimeModule,
  incidentsModule,
  timeMachineModule,
  topologyModule,
  correlationModule,
  doctorModule,
  automationModule,
  playbooksModule,
  knowledgeModule,
  impactModule,
  portfolioModule,
  configBackupModule,
  platformModule,
  backupsModule,
  outsideAccessModule,
  createSystemModule(() => modules),
]);
