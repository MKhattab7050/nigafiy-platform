import { defineModule } from '../../infrastructure/module.ts';

/**
 * Network Doctor: explainable, rule-based diagnosis (rules.ts is pure; service.ts loads the facts).
 * A library module: its HTTP surface (GET /doctor, POST /doctor/run-checks) is served by the
 * incidents module, and the correlation module re-runs it for every incident.
 */
export const doctorModule = defineModule({ name: 'doctor' });

export { type IncidentRef, diagnoseIncident, diagnoseSiteNetwork } from './service.ts';
export { diagnoseSmartChecks } from './smart-facts.ts';
export { type DhcpFacts, type WifiDoctorFacts, diagnoseDhcp, diagnoseWifi } from './smart-rules.ts';
