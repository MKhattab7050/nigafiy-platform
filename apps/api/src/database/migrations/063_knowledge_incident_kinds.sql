-- Knowledge suggestions are captured from resolved incidents of every kind, but the knowledge table
-- still allowed only the four kinds of migration 025. A DHCP or endpoint incident (kinds added in
-- 023 and 043) made the capture job fail every run with knowledge_entries_incident_kinds_check.
-- The allowed list is now the same as incidents_kind_check.
-- tests/incident-kinds.test.ts keeps the code (incidents/kinds.ts) and both constraints in step.
ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_incident_kinds_check;
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_incident_kinds_check
  CHECK (incident_kinds <@ ARRAY['collector', 'device', 'dhcp', 'endpoint', 'network', 'service']::text[]);
