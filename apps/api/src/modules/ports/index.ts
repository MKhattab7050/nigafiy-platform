import { Router } from 'express';
import { defineModule } from '../../infrastructure/module.ts';
import { controlRouter } from './control/routes.ts';
import { finderRouter } from './finder/routes.ts';
import { switchesRouter } from './switches/routes.ts';

/**
 * Port Detective: switches read over SNMP, per-port traffic/errors, and "which port is this device on".
 *
 *   switches/       switch management, port detail and history; detection.ts: switch candidates and the
 *                   `classify.switch_from_snmp` automation (first successful read → device type "switch", inferred)
 *   finder/         device → port location and search
 *   control/        port control (Phase 5): admin status, description and access VLAN over SNMP SET through
 *                   the site's collector, risk checks, write credentials, device quarantine / release
 *   credentials.ts  SNMP credentials (sealed at rest; decrypted only for the site's collector)
 *   ingest.ts       applies snmp_poll telemetry from the collector gateway
 *   locate.ts       pure location rules
 */
const portsApi: Router = Router();
portsApi.use(switchesRouter, finderRouter, controlRouter);

export const portsModule = defineModule({ name: 'ports', api: portsApi });

export { buildSnmpConfig } from './credentials.ts';
export { processSnmpPoll } from './ingest.ts';
export { processPortControlItem } from './control/ingest.ts';
export { devicePortLocation } from './finder/service.ts';
export { type PortLocation, type Sighting, locate, portRole } from './locate.ts';
export { disableDevicePort, quarantineDevice } from './control/service.ts';
