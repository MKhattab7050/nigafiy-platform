/** The incident row as the API returns it (Incident). Other modules extend it with their own filters. */
export const INCIDENT_SELECT = `
  SELECT i.id, i.number, i.site_id, s.name AS site_name, i.kind, i.status, i.severity, i.title,
         i.diagnosis ->> 'fault_domain' AS fault_domain, i.diagnosis ->> 'confidence' AS confidence,
         i.opened_at, i.acknowledged_at, i.resolved_at, i.resolution_kind, i.resolution_note, i.assigned_to, i.assigned_to_name,
         (SELECT count(*) FROM incident_events ie WHERE ie.incident_id = i.id)::int AS event_count
    FROM incidents i LEFT JOIN sites s ON s.id = i.site_id`;
