import type { Diagnosis, IncidentKind, KnowledgeSuggestResponse } from '@nigafiy/shared-types';
import { notFound } from '../../common/http.ts';
import type { Db } from '../../infrastructure/db.ts';
import { loadIncidentFacts } from './capture.ts';
import { ENTRY_SELECT, type EntryRow, formatEntry } from './repo.ts';
import { type RankContext, rankEntries, textQuery } from './ranking.ts';

type Context = KnowledgeSuggestResponse['context'];

interface ContextWithText {
  context: Context;
  text: string;
}

/** Context of an incident: its diagnosis rule, kind, events, device, check and site. */
async function incidentContext(db: Db, organizationId: string, incidentId: string): Promise<ContextWithText> {
  const f = await loadIncidentFacts(db, organizationId, incidentId);
  if (!f) throw notFound('Incident');
  const device = f.device_id
    ? (await db.query<{ device_type: string; vendor: string | null }>(`SELECT device_type, vendor FROM devices WHERE organization_id = $1 AND id = $2`, [organizationId, f.device_id])).rows[0]
    : undefined;
  return {
    context: {
      incident_id: f.id,
      device_id: f.device_id,
      site_id: f.site_id,
      check_id: f.check_id,
      rule_ids: f.diagnosis?.rule ? [f.diagnosis.rule] : [],
      fault_domain: f.diagnosis?.fault_domain ?? null,
      incident_kind: f.kind,
      event_types: f.event_types,
      device_type: device?.device_type ?? f.device_types[0] ?? null,
      vendor: device?.vendor ?? f.vendors[0] ?? null,
    },
    text: [f.title, f.diagnosis?.title, f.diagnosis?.summary, f.check_name].filter(Boolean).join(' '),
  };
}

/** Context of a device: its type, vendor and site, the events it produced and the rules of its recent incidents. */
async function deviceContext(db: Db, organizationId: string, deviceId: string): Promise<ContextWithText> {
  const d = (
    await db.query<{ id: string; site_id: string; device_type: string; vendor: string | null; name: string | null; hostname: string | null }>(
      `SELECT id, site_id, device_type, vendor, coalesce(display_name, hostname) AS name, hostname FROM devices WHERE organization_id = $1 AND id = $2`,
      [organizationId, deviceId],
    )
  ).rows[0];
  if (!d) throw notFound('Device');
  const events = await db.query<{ type: string }>(
    `SELECT DISTINCT type FROM network_events WHERE organization_id = $1 AND device_id = $2 AND occurred_at > now() - interval '30 days' ORDER BY type LIMIT 30`,
    [organizationId, deviceId],
  );
  const incidents = await db.query<{ kind: IncidentKind; rule: string | null; fault_domain: string | null; title: string }>(
    `SELECT kind, diagnosis ->> 'rule' AS rule, diagnosis ->> 'fault_domain' AS fault_domain, title FROM incidents
      WHERE organization_id = $1 AND device_id = $2 ORDER BY (status <> 'resolved') DESC, opened_at DESC LIMIT 5`,
    [organizationId, deviceId],
  );
  const latest = incidents.rows[0];
  return {
    context: {
      incident_id: null,
      device_id: d.id,
      site_id: d.site_id,
      check_id: null,
      rule_ids: [...new Set(incidents.rows.map((i) => i.rule).filter((r): r is string => Boolean(r)))],
      fault_domain: latest?.fault_domain ?? null,
      incident_kind: latest ? latest.kind : null,
      event_types: events.rows.map((e) => e.type),
      device_type: d.device_type,
      vendor: d.vendor,
    },
    text: [d.name, d.vendor, d.device_type !== 'unknown' ? d.device_type : null, latest?.title].filter(Boolean).join(' '),
  };
}

/** Context of a live Network Doctor diagnosis (no incident): the rule and the site. */
async function ruleContext(db: Db, organizationId: string, rule: string, siteId: string | null): Promise<ContextWithText> {
  if (siteId && !(await db.query(`SELECT 1 FROM sites WHERE organization_id = $1 AND id = $2`, [organizationId, siteId])).rowCount) throw notFound('Site');
  // The newest stored diagnosis with this rule gives its fault domain and wording for text matching.
  const sample = (
    await db.query<{ diagnosis: Diagnosis }>(
      `SELECT diagnosis FROM incidents WHERE organization_id = $1 AND diagnosis ->> 'rule' = $2 ORDER BY opened_at DESC LIMIT 1`,
      [organizationId, rule],
    )
  ).rows[0]?.diagnosis;
  return {
    context: {
      incident_id: null,
      device_id: null,
      site_id: siteId,
      check_id: null,
      rule_ids: [rule],
      fault_domain: sample?.fault_domain ?? null,
      incident_kind: null,
      event_types: [],
      device_type: null,
      vendor: null,
    },
    text: [rule.replaceAll('-', ' '), sample?.title].filter(Boolean).join(' '),
  };
}

export interface SuggestInput {
  incident_id?: string;
  device_id?: string;
  rule?: string;
  site_id?: string;
  limit: number;
}

/**
 * Ranked published entries for an incident, a device, or a doctor rule, each with the reasons it
 * matched. The entry captured from the same incident is left out: it is this incident, not history.
 */
export async function suggest(db: Db, organizationId: string, userId: string, q: SuggestInput, now = new Date()): Promise<KnowledgeSuggestResponse> {
  const { context, text } = q.incident_id
    ? await incidentContext(db, organizationId, q.incident_id)
    : q.device_id
      ? await deviceContext(db, organizationId, q.device_id)
      : await ruleContext(db, organizationId, q.rule!, q.site_id ?? null);

  const tsq = textQuery(text);
  // Pre-filter in SQL to entries that share at least one matching attribute; scoring happens in ranking.ts.
  const rows = await db.query<EntryRow & { text_rank: number }>(
    `${ENTRY_SELECT.replace('FROM knowledge_entries k', `, CASE WHEN $3::text IS NULL THEN 0 ELSE ts_rank_cd(k.search, to_tsquery('simple', $3::text))::float8 END AS text_rank FROM knowledge_entries k`)}
      WHERE k.status = 'published'
        AND ($2::uuid IS NULL OR k.incident_id IS DISTINCT FROM $2::uuid)
        AND (k.rule_ids && $4::text[]
          OR ($5::text IS NOT NULL AND k.incident_kinds @> ARRAY[$5::text])
          OR ($6::text IS NOT NULL AND k.fault_domain = $6)
          OR k.event_types && $7::text[]
          OR ($8::uuid IS NOT NULL AND k.device_id = $8)
          OR ($9::uuid IS NOT NULL AND k.check_id = $9)
          OR ($10::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(k.device_types) t WHERE lower(t) = lower($10)))
          OR ($11::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(k.vendors) v WHERE lower($11) LIKE '%' || lower(v) || '%' OR lower(v) LIKE '%' || lower($11) || '%'))
          OR ($12::uuid IS NOT NULL AND k.site_id = $12)
          OR ($3::text IS NOT NULL AND k.search @@ to_tsquery('simple', $3::text)))
      ORDER BY k.updated_at DESC
      LIMIT 300`,
    [
      userId,
      context.incident_id,
      tsq,
      context.rule_ids,
      context.incident_kind,
      context.fault_domain && !['healthy', 'insufficient_data'].includes(context.fault_domain) ? context.fault_domain : null,
      context.event_types,
      context.device_id,
      context.check_id,
      context.device_type && context.device_type !== 'unknown' ? context.device_type : null,
      context.vendor || null,
      context.site_id,
    ],
  );
  const rankCtx: RankContext = context;
  const ranked = rankEntries(rankCtx, rows.rows, q.limit, now);
  return {
    context,
    items: ranked.map(({ entry: { text_rank: _t, ...e }, score, reasons }) => ({ entry: formatEntry(e), score, reasons })),
  };
}
