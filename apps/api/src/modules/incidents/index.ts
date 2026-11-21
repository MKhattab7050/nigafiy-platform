import { defineModule } from '../../infrastructure/module.ts';
import { incidentsRouter } from './routes.ts';

/**
 * Incidents API (list, detail with replay window, acknowledge / resolve / assign / comment,
 * re-diagnose), organization members for assignment, and the live Network Doctor view
 * (GET /doctor, POST /doctor/run-checks). Incidents are opened and resolved by the correlation module.
 */
export const incidentsModule = defineModule({ name: 'incidents', api: incidentsRouter });

export { INCIDENT_SELECT } from './queries.ts';
export { type IncidentActor, acknowledgeIncident, commentOnIncident } from './actions.ts';
