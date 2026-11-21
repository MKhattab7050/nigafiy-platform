import { defineModule } from '../../infrastructure/module.ts';

/**
 * Alert correlation: turns the event stream into incidents and keeps their Network Doctor
 * diagnosis current. Called by the events module for every emitted event (inside the caller's
 * transaction, isolated by a savepoint), by the collector gateway after uploads, and by the
 * incidents API. Kept separate from the incidents module so that events → correlation and
 * incidents → events never form a cycle.
 *
 * refresh.ts: automation `incident.refresh_measurements` — when a network-path or collector incident
 * opens, queue run_checks for the site's online collectors (gated, rate-limited, audited, isolated).
 */
export const correlationModule = defineModule({ name: 'correlation' });

export {
  type CorrelatableEvent,
  addActivity,
  correlateEvent,
  dhcpIncidentKey,
  rediagnose,
  refineCollectorIncident,
  refreshSiteCorrelation,
  resolveOpenIncidentByKey,
} from './engine.ts';
