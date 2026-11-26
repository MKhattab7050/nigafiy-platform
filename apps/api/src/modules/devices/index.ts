import { defineModule } from '../../infrastructure/module.ts';
import { devicesRouter } from './routes.ts';

/**
 * Device inventory and controls (incl. single and bulk one-click monitoring, monitor.ts), plus
 * identification (naming/classification) used by discovery ingest and by the "back to automatic" type reset.
 */
export const devicesModule = defineModule({ name: 'devices', api: devicesRouter });

export type { Fingerprint } from './classify.ts';
export { applyIdentification, shortVendor } from './identify.ts';
export { identityName } from './same-device.ts';
export { type ControlTarget, alertsControl, monitoringControl, trustControl, wakeControl } from './controls.ts';
export { type WakeQueued, queueWakeOnLan, setDeviceTrust } from './actions.ts';
export { type DhcpOsResult, type OsFamily, classifyDhcp, osFamilyLabel } from './dhcp-fingerprint.ts';
