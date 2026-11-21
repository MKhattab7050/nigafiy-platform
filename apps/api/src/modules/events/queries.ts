/** The timeline row as the API returns it (NetworkEvent). Other modules extend it with their own filters. */
export const EVENT_SELECT = `
  SELECT e.id, e.site_id, s.name AS site_name, e.device_id, e.check_id, e.collector_id, e.type, e.severity, e.title,
         e.details, e.source, e.occurred_at, e.received_at, e.in_maintenance, e.maintenance_window_id
    FROM network_events e LEFT JOIN sites s ON s.id = e.site_id`;
