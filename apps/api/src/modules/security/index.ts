import { defineModule } from '../../infrastructure/module.ts';
import { securityRouter } from './routes.ts';

/**
 * Smart network checks (Phase 5) — read-only observations the collector makes by itself:
 * rogue DHCP servers (DHCPDISCOVER probe + clients' choices overheard), UPnP IGD port-forward audit,
 * the collector host's Wi-Fi link and nearby networks, device web banners and DHCP option fingerprints.
 *
 *   ingest.ts   the `smart_check` telemetry item (collector gateway → processSmartCheck)
 *   config.ts   the smart-check part of every heartbeat's configuration (schedules + "run now")
 *   routes.ts   findings, "this is expected", run now, schedule
 * Findings live in security_findings; DHCP problems also raise incidents through the event stream.
 */
export const securityModule = defineModule({ name: 'security', api: securityRouter });

export { processSmartCheck } from './ingest.ts';
export { type SmartCheckConfig, buildSmartCheckConfig } from './config.ts';
