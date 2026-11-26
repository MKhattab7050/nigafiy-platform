import type { IncidentKind } from '@nigafiy/shared-types';

/**
 * Every incident kind, at run time. A new kind goes here, in the IncidentKind type, and in a
 * migration that extends incidents_kind_check AND knowledge_entries_incident_kinds_check (see 063);
 * tests/incident-kinds.test.ts fails when one of them is left behind.
 */
export const INCIDENT_KINDS = ['network', 'service', 'collector', 'device', 'dhcp', 'endpoint'] as const satisfies readonly IncidentKind[];

// Compile-time check that the list above names every member of IncidentKind.
type Missing = Exclude<IncidentKind, (typeof INCIDENT_KINDS)[number]>;
const everyKindListed: [Missing] extends [never] ? true : Missing = true;
void everyKindListed;
