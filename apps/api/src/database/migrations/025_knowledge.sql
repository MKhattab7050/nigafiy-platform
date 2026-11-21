-- Knowledge memory: what fixed an incident before, and hand-written runbooks.
--
--  * knowledge_entries      one article / runbook. `source = 'incident'` rows are captured
--                           automatically from a resolved incident (status 'candidate' until a
--                           technician confirms them); `source = 'manual'` rows are written by hand.
--                           Links (doctor rule ids, incident kinds, event types, device types,
--                           vendors, site / device / check) drive the deterministic suggestions.
--                           `cause_source` keeps the Network Doctor's inferred cause apart from a
--                           cause a person wrote.
--  * knowledge_captured     ledger of incidents already turned into a candidate: an incident is
--                           captured once, even when its candidate is later discarded or deleted.
--  * knowledge_revisions    who changed what and when, with a snapshot of the content.
--  * knowledge_votes        "Did this help?" — one vote per user and entry.
--  * knowledge_uses         "Mark as fix used": which entry fixed which incident.

CREATE TABLE knowledge_entries (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  status                    text NOT NULL CHECK (status IN ('candidate', 'draft', 'published', 'discarded')),
  source                    text NOT NULL CHECK (source IN ('incident', 'manual')),
  kind                      text NOT NULL DEFAULT 'article' CHECK (kind IN ('article', 'runbook')),
  title                     text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  symptoms                  text NOT NULL DEFAULT '' CHECK (length(symptoms) <= 8000),
  cause                     text NOT NULL DEFAULT '' CHECK (length(cause) <= 8000),
  cause_source              text NOT NULL DEFAULT 'manual' CHECK (cause_source IN ('doctor', 'manual')),
  fix_steps                 text NOT NULL DEFAULT '' CHECK (length(fix_steps) <= 20000),
  tags                      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  rule_ids                  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(rule_ids) <= 20),
  incident_kinds            text[] NOT NULL DEFAULT '{}' CHECK (incident_kinds <@ ARRAY['network', 'service', 'collector', 'device']::text[]),
  event_types               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(event_types) <= 30),
  device_types              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(device_types) <= 20),
  vendors                   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(vendors) <= 20),
  site_id                   uuid,
  device_id                 uuid,
  check_id                  uuid,
  incident_id               uuid,
  fault_domain              text,
  diagnosis_summary         text,
  diagnosis_confidence      text CHECK (diagnosis_confidence IS NULL OR diagnosis_confidence IN ('low', 'medium', 'high')),
  incident_duration_seconds integer CHECK (incident_duration_seconds IS NULL OR incident_duration_seconds >= 0),
  -- md5 of the incident text the candidate was pre-filled from; a candidate nobody edited yet is
  -- refreshed when the resolution note or the comments change.
  source_fingerprint        text,
  edited                    boolean NOT NULL DEFAULT false,
  revision                  integer NOT NULL DEFAULT 1,
  created_by                uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_name           text,
  updated_by                uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by_name           text,
  published_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  published_by_name         text,
  published_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  search                    tsvector NOT NULL DEFAULT ''::tsvector,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE SET NULL (site_id),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id),
  FOREIGN KEY (organization_id, check_id) REFERENCES monitoring_checks (organization_id, id) ON DELETE SET NULL (check_id),
  FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE SET NULL (incident_id)
);
CREATE INDEX knowledge_entries_org_status_idx ON knowledge_entries (organization_id, status, updated_at DESC);
CREATE UNIQUE INDEX knowledge_entries_incident_key ON knowledge_entries (organization_id, incident_id) WHERE source = 'incident' AND incident_id IS NOT NULL;
CREATE INDEX knowledge_entries_rules_idx ON knowledge_entries USING gin (rule_ids);
CREATE INDEX knowledge_entries_tags_idx ON knowledge_entries USING gin (tags);
CREATE INDEX knowledge_entries_search_idx ON knowledge_entries USING gin (search);

-- The 'simple' configuration (no stemming, no stop words) treats English and Arabic text alike.
CREATE FUNCTION knowledge_entries_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.symptoms, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.cause, '') || ' ' || coalesce(NEW.diagnosis_summary, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.fix_steps, '') || ' ' || coalesce(array_to_string(NEW.vendors, ' '), '') || ' ' || coalesce(array_to_string(NEW.device_types, ' '), '')), 'D');
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_entries_search BEFORE INSERT OR UPDATE ON knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION knowledge_entries_search_update();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS knowledge_entries_title_trgm ON knowledge_entries USING gin (title gin_trgm_ops);
  END IF;
END $$;

CREATE TABLE knowledge_captured (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  incident_id     uuid NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, incident_id),
  FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  entry_id        uuid NOT NULL,
  revision        integer NOT NULL,
  action          text NOT NULL CHECK (action IN ('captured', 'refreshed', 'created', 'edited', 'published', 'unpublished', 'discarded', 'restored')),
  -- { title, symptoms, cause, cause_source, fix_steps, kind, tags, rule_ids, incident_kinds, event_types, device_types, vendors }
  snapshot        jsonb NOT NULL,
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  user_name       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, entry_id) REFERENCES knowledge_entries (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_revisions_entry_idx ON knowledge_revisions (entry_id, created_at DESC);

CREATE TABLE knowledge_votes (
  organization_id uuid NOT NULL,
  entry_id        uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  helpful         boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, user_id),
  FOREIGN KEY (organization_id, entry_id) REFERENCES knowledge_entries (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_uses (
  organization_id uuid NOT NULL,
  entry_id        uuid NOT NULL,
  incident_id     uuid NOT NULL,
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  user_name       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, incident_id),
  FOREIGN KEY (organization_id, entry_id) REFERENCES knowledge_entries (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_uses_incident_idx ON knowledge_uses (incident_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_entries', 'knowledge_captured', 'knowledge_revisions', 'knowledge_votes', 'knowledge_uses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
