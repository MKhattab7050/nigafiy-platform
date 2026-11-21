import { defineModule } from '../../infrastructure/module.ts';
import { collectorGatewayRouter } from './routes.ts';

/**
 * The collector gateway (/api/v1/collector): enrollment, heartbeat (answers with the collector's
 * configuration and commands) and telemetry upload. The wire contract is common/collector-protocol.ts.
 *
 *   collector-auth.ts  credential authentication
 *   enrollment.ts      token → credential exchange
 *   heartbeat.ts       state update + configuration (scopes, checks, access policy, SNMP targets)
 *   telemetry.ts       batch application: per-item savepoints, dispatch to the item processors
 *   discovery/         discovery sweeps → device inventory, identity, availability
 *   checks.ts          check samples → check state machine
 *   dns-stats.ts       DNS-filter statistics
 * snmp_poll and tool_result items are processed by the ports and toolbox modules.
 */
export const ingestModule = defineModule({
  name: 'ingest',
  gateway: { path: '/api/v1/collector', rateLimitPerMinute: 240, router: collectorGatewayRouter },
});
