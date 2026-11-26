-- Weekly report (monitoring of the monitor): one short, rule-based summary per organization and week.
--
--  * weekly_reports   one row per organization and local week (Monday 00:00 in the organization's time
--                     zone). The `weekly-report` job writes it once (UNIQUE + ON CONFLICT DO NOTHING), so
--                     re-runs, restarts and two API instances never make a second one.
--                     score / previous_score: the health score (insights) when the report was made and in
--                     the report before it; this is the score history the report compares against.
--                     events: [{ code, params, text }] one sentence each; improvements: the top 3 open
--                     insights (code / params let the web show them in the user's language).
--  * weekly_report_settings  notify: also send the report through the notification channels. Off by
--                     default: the report is always on its page, nothing is sent unless the user asks.

CREATE TABLE weekly_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  week_start       date NOT NULL,
  period_from      timestamptz NOT NULL,
  period_to        timestamptz NOT NULL,
  timezone         text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  score            smallint CHECK (score BETWEEN 0 AND 100),
  previous_score   smallint CHECK (previous_score BETWEEN 0 AND 100),
  events           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(events) = 'array'),
  improvements     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(improvements) = 'array'),
  notified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, week_start)
);
CREATE INDEX weekly_reports_org_week ON weekly_reports (organization_id, week_start DESC);

ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON weekly_reports FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT ON weekly_reports TO lan_app;

CREATE TABLE weekly_report_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  notify          boolean NOT NULL DEFAULT false,
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE weekly_report_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON weekly_report_settings FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE ON weekly_report_settings TO lan_app;
