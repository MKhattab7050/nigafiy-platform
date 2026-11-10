-- Interface history: traffic rate and error counts per switch port over time.
--
-- Rates are derived from the 64-bit octet counters of two consecutive SNMP reads. They are averages
-- over the interval between the reads (normally 5 minutes), not instantaneous or peak values.
-- A rate is NULL when it could not be derived honestly: counter reset, switch restart, or a gap
-- between reads too long for an average to mean anything.

ALTER TABLE switch_ports
  ADD COLUMN in_bps  double precision,
  ADD COLUMN out_bps double precision;

CREATE TABLE switch_port_samples (
  target_id       uuid NOT NULL,
  if_index        integer NOT NULL,
  ts              timestamptz NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  seconds         integer NOT NULL,          -- length of the interval this sample averages over
  in_bps          double precision,
  out_bps         double precision,
  errors          integer,                   -- errors added during the interval (in + out)
  discards        integer,
  oper_up         boolean NOT NULL,
  PRIMARY KEY (target_id, if_index, ts),
  FOREIGN KEY (organization_id, target_id) REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX switch_port_samples_ts_brin ON switch_port_samples USING brin (ts);

ALTER TABLE switch_port_samples ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON switch_port_samples FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON switch_port_samples TO lan_app;
