-- An endpoint that has reported nothing is not "compliant"; its posture is unknown.
ALTER TABLE endpoints ALTER COLUMN compliance_status SET DEFAULT 'unknown';

UPDATE endpoints
   SET compliance_status = 'unknown', compliance_reasons = '{}'
 WHERE last_heartbeat_at IS NULL AND security = '{}'::jsonb;
