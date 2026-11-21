import { defineModule } from '../../infrastructure/module.ts';
import { accessRouter } from './routes.ts';

/**
 * Access control (DNS filtering on the site's collector): site settings, profiles, per-device rules,
 * pause, DNS activity. policy.ts holds the pure rule merging; collector-policy.ts builds what the
 * collector receives in its heartbeat.
 */
export const accessModule = defineModule({ name: 'access', api: accessRouter });

export { buildAccessPolicy } from './collector-policy.ts';
export { deviceAccessControl } from './controls.ts';
export { dnsFilterEnabled, setDeviceInternetPause } from './device-pause.ts';
export { pauseUntil } from './schema.ts';
export type { EffectiveRule } from './policy.ts';
