import { Router } from 'express';
import { defineModule } from '../../infrastructure/module.ts';
import { controlRouter } from './control/routes.ts';
import { runQuarantineAutoRelease } from './control/service.ts';
import { finderRouter } from './finder/routes.ts';
import { neighborsRouter } from './neighbors/routes.ts';
import { switchesRouter } from './switches/routes.ts';

/**
 * Port Detective: switches read over SNMP, per-port traffic/errors, and "which port is this device on".
 *
 *   switches/       switch management, port detail and history; detection.ts: switch candidates and the
 *                   `classify.switch_from_snmp` automation (first successful read → device type "switch", inferred)
 *   finder/         device → port location and search
 *   neighbors/      neighbour tables by protocol (LLDP, CDP, MikroTik) and MNDP announcements heard by collectors
 *   control/        port control (Phase 5): admin status, description and access VLAN over SNMP SET through
 *                   the site's collector, risk checks, write credentials, device quarantine / release
 *   credentials.ts  SNMP credentials (sealed at rest; decrypted only for the site's collector)
 *   ingest.ts       applies snmp_poll telemetry from the collector gateway
 *   locate.ts       pure location rules
 */
const portsApi: Router = Router();
portsApi.use(switchesRouter, finderRouter, controlRouter, neighborsRouter);

export const portsModule = defineModule({
  name: 'ports',
  api: portsApi,
  // Releases quarantines whose optional auto-release time has passed (control/service.ts).
  jobs: [{ name: 'quarantine-auto-release', everyMs: 60_000, lockKey: 727161, run: async () => void (await runQuarantineAutoRelease()) }],
});

export { buildSnmpConfig } from './credentials.ts';
export { processSnmpPoll } from './ingest.ts';
export { processMndpNeighbors } from './neighbors/service.ts';
export { processPortControlItem } from './control/ingest.ts';
export { devicePortLocation } from './finder/service.ts';
export { type PortLocation, type Sighting, locate, portRole } from './locate.ts';
export { disableDevicePort, quarantineDevice, runQuarantineAutoRelease } from './control/service.ts';
