import type { Diagnosis } from '@lan-detective/shared-types';
import { auditSystem } from '../../common/audit.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { automationEnabled } from '../automation/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { addRevision } from './repo.ts';

/**
 * Automatic capture: a resolved incident that carries human knowledge — a resolution note, or
 * comments by people — becomes a knowledge *candidate*, pre-filled from the incident and its
 * Network Doctor diagnosis so that a technician only has to confirm it.
 *
 * Reads the incidents module's tables only (no change to how incidents work). Runs on demand,
 * whenever the knowledge list, counts or suggestions are read (the sidebar badge polls them), so a
 * candidate appears seconds after the incident is resolved. Each incident is captured once
 * (knowledge_captured ledger), unless a published entry was already marked as the fix used.
 * Gated by the `suggest.knowledge_from_incidents` automation and recorded with auditSystem().
 */

const AUTOMATION = 'suggest.knowledge_from_incidents' as const;
const LOOKBACK_DAYS = 180;
const BATCH = 25;

/** What the candidate was pre-filled from. Same expression in the capture and refresh queries. */
const FINGERPRINT_SQL = `md5(coalesce(i.resolution_note, '') || '|' || coalesce((
    SELECT string_agg(a.id::text, ',' ORDER BY a.created_at, a.id) FROM incident_activity a
     WHERE a.incident_id = i.id AND a.kind = 'comment' AND a.user_id IS NOT NULL), ''))`;

const HAS_HUMAN_TEXT_SQL = `(coalesce(btrim(i.resolution_note), '') <> ''
    OR EXISTS (SELECT 1 FROM incident_activity a WHERE a.incident_id = i.id AND a.kind = 'comment' AND a.user_id IS NOT NULL))`;

export interface IncidentFacts {
  id: string;
  number: number;
  kind: 'network' | 'service' | 'collector' | 'device';
  title: string;
  site_id: string | null;
  site_name: string | null;
  device_id: string | null;
  check_id: string | null;
  check_name: string | null;
  diagnosis: Diagnosis | null;
  opened_at: Date;
  resolved_at: Date | null;
  resolution_kind: 'auto' | 'manual' | null;
  resolution_note: string | null;
  fingerprint: string;
  comments: { user_name: string | null; body: string }[];
  event_types: string[];
  device_types: string[];
  vendors: string[];
}

export interface CandidateContent {
  title: string;
  symptoms: string;
  cause: string;
  cause_source: 'doctor' | 'manual';
  fix_steps: string;
  tags: string[];
  rule_ids: string[];
  incident_kinds: string[];
  event_types: string[];
  device_types: string[];
  vendors: string[];
  fault_domain: string | null;
  diagnosis_summary: string | null;
  diagnosis_confidence: string | null;
  incident_duration_seconds: number | null;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** Keep pre-filled text plain: one line per item, no characters the markdown renderer would treat as structure at line start. */
const line = (s: string) => s.replace(/\s+/g, ' ').trim();

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Pure: the pre-filled candidate for an incident. Doctor text stays labelled as the doctor's (inferred). */
export function buildCandidate(f: IncidentFacts): CandidateContent {
  const d = f.diagnosis;
  const meaningfulDomain = d && !['healthy', 'insufficient_data'].includes(d.fault_domain) ? d.fault_domain : null;
  const duration = f.resolved_at ? Math.max(0, Math.round((new Date(f.resolved_at).getTime() - new Date(f.opened_at).getTime()) / 1000)) : null;

  const symptoms: string[] = [`- ${line(f.title)}`];
  if (d?.summary) symptoms.push(`- ${line(d.summary)}`);
  for (const c of d?.affected.checks ?? []) symptoms.push(`- ${line(c.name)}: ${c.state}`);
  for (const e of (d?.evidence ?? []).filter((x) => x.basis === 'observed').slice(0, 4)) symptoms.push(`- ${line(e.label)}: ${line(e.value)}`);
  if (duration !== null) symptoms.push(`- ${formatDuration(duration)}`);

  const fix: string[] = [];
  const note = f.resolution_note?.trim();
  if (note) fix.push(note);
  const comments = f.comments.filter((c) => !c.body.startsWith('Resolution note updated:') && c.body.trim() !== note);
  if (comments.length) {
    if (fix.length) fix.push('');
    for (const c of comments.slice(0, 20)) fix.push(`- ${line(c.body)}${c.user_name ? ` (${line(c.user_name)})` : ''}`);
  }

  const tags = [...new Set([f.kind, meaningfulDomain, ...f.device_types].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase().slice(0, 40)))].slice(0, 20);

  return {
    title: clip(line(d?.title && meaningfulDomain ? d.title : f.title), 200),
    symptoms: clip(symptoms.join('\n'), 8000),
    cause: d?.probable_cause ? clip(d.probable_cause, 8000) : '',
    cause_source: d?.probable_cause ? 'doctor' : 'manual',
    fix_steps: clip(fix.join('\n'), 20000),
    tags,
    rule_ids: d?.rule ? [d.rule] : [],
    incident_kinds: [f.kind],
    event_types: f.event_types.filter((t) => /^[a-z0-9_]{1,64}$/.test(t)).slice(0, 30),
    device_types: f.device_types.slice(0, 20),
    vendors: f.vendors.slice(0, 20),
    fault_domain: d?.fault_domain ?? null,
    diagnosis_summary: d?.summary ?? null,
    diagnosis_confidence: d?.confidence ?? null,
    incident_duration_seconds: duration,
  };
}

const INCIDENT_FACTS_SQL = `
  SELECT i.id, i.number, i.kind, i.title, i.site_id, s.name AS site_name, i.device_id, i.check_id, c.name AS check_name,
         i.diagnosis, i.opened_at, i.resolved_at, i.resolution_kind, i.resolution_note,
         ${FINGERPRINT_SQL} AS fingerprint
    FROM incidents i
    LEFT JOIN sites s ON s.organization_id = i.organization_id AND s.id = i.site_id
    LEFT JOIN monitoring_checks c ON c.organization_id = i.organization_id AND c.id = i.check_id`;

type FactsRow = Omit<IncidentFacts, 'comments' | 'event_types' | 'device_types' | 'vendors'>;

/** Incident facts the candidate and the suggestions are built from (also used by suggest.ts). */
export async function loadIncidentFacts(db: Db, organizationId: string, incidentId: string): Promise<IncidentFacts | null> {
  const row = (await db.query<FactsRow>(`${INCIDENT_FACTS_SQL} WHERE i.organization_id = $1 AND i.id = $2`, [organizationId, incidentId])).rows[0];
  if (!row) return null;
  return completeFacts(db, organizationId, row);
}

async function completeFacts(db: Db, organizationId: string, row: FactsRow): Promise<IncidentFacts> {
  const comments = await db.query<{ user_name: string | null; body: string }>(
    `SELECT user_name, body FROM incident_activity WHERE organization_id = $1 AND incident_id = $2 AND kind = 'comment' AND user_id IS NOT NULL ORDER BY created_at, id LIMIT 50`,
    [organizationId, row.id],
  );
  const events = await db.query<{ type: string }>(
    `SELECT DISTINCT e.type FROM incident_events ie JOIN network_events e ON e.id = ie.event_id
      WHERE ie.organization_id = $1 AND ie.incident_id = $2 ORDER BY e.type LIMIT 30`,
    [organizationId, row.id],
  );
  // The incident's own device first, then devices named by its events.
  const devices = await db.query<{ device_type: string; vendor: string | null }>(
    `SELECT d.device_type, d.vendor FROM devices d
      WHERE d.organization_id = $1 AND (d.id = $3 OR d.id IN (
        SELECT e.device_id FROM incident_events ie JOIN network_events e ON e.id = ie.event_id
         WHERE ie.organization_id = $1 AND ie.incident_id = $2 AND e.device_id IS NOT NULL))
      ORDER BY (d.id = $3) DESC NULLS LAST, d.id LIMIT 10`,
    [organizationId, row.id, row.device_id],
  );
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x && x !== 'unknown')))];
  return {
    ...row,
    comments: comments.rows,
    event_types: events.rows.map((e) => e.type),
    device_types: uniq(devices.rows.map((d) => d.device_type)).slice(0, 5),
    vendors: uniq(devices.rows.map((d) => d.vendor)).slice(0, 5),
  };
}

/**
 * Create candidates for newly eligible incidents of one organization and refresh untouched
 * candidates whose incident gained a note or comments. Returns how many entries were written.
 */
export async function captureCandidates(db: Db, organizationId: string): Promise<number> {
  let written = 0;
  const eligible = await db.query<FactsRow>(
    `${INCIDENT_FACTS_SQL}
      WHERE i.organization_id = $1 AND i.status = 'resolved' AND i.resolved_at > now() - make_interval(days => $2)
        AND ${HAS_HUMAN_TEXT_SQL}
        AND NOT EXISTS (SELECT 1 FROM knowledge_captured kc WHERE kc.organization_id = i.organization_id AND kc.incident_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM knowledge_uses u WHERE u.organization_id = i.organization_id AND u.incident_id = i.id)
      ORDER BY i.resolved_at DESC LIMIT $3`,
    [organizationId, LOOKBACK_DAYS, BATCH],
  );
  for (const row of eligible.rows) {
    if (!(await automationEnabled(db, organizationId, row.site_id, AUTOMATION))) continue;
    const claimed = await db.query(`INSERT INTO knowledge_captured (organization_id, incident_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [organizationId, row.id]);
    if (!claimed.rowCount) continue;
    const facts = await completeFacts(db, organizationId, row);
    const c = buildCandidate(facts);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO knowledge_entries (organization_id, status, source, kind, title, symptoms, cause, cause_source, fix_steps, tags, rule_ids,
                                      incident_kinds, event_types, device_types, vendors, site_id, device_id, check_id, incident_id,
                                      fault_domain, diagnosis_summary, diagnosis_confidence, incident_duration_seconds, source_fingerprint,
                                      created_by_name, updated_by_name)
       VALUES ($1,'candidate','incident','article',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NULL,NULL)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        organizationId, c.title, c.symptoms, c.cause, c.cause_source, c.fix_steps, c.tags, c.rule_ids, c.incident_kinds, c.event_types,
        c.device_types, c.vendors, facts.site_id, facts.device_id, facts.check_id, facts.id, c.fault_domain, c.diagnosis_summary,
        c.diagnosis_confidence, c.incident_duration_seconds, facts.fingerprint,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) continue;
    await addRevision(db, organizationId, id, 'captured', null);
    await auditSystem(db, organizationId, {
      automation: AUTOMATION,
      action: 'knowledge.candidate_captured',
      target: { type: 'knowledge', id },
      siteId: facts.site_id,
      metadata: { incident_id: facts.id, incident_number: facts.number, rule_ids: c.rule_ids },
    });
    written++;
  }

  // A candidate nobody has edited follows its incident: a later note or comment updates the pre-fill.
  const stale = await db.query<FactsRow & { entry_id: string }>(
    `${INCIDENT_FACTS_SQL.replace('SELECT i.id,', 'SELECT k.id AS entry_id, i.id,')}
       JOIN knowledge_entries k ON k.organization_id = i.organization_id AND k.incident_id = i.id
      WHERE i.organization_id = $1 AND k.status = 'candidate' AND k.source = 'incident' AND NOT k.edited
        AND k.source_fingerprint IS DISTINCT FROM ${FINGERPRINT_SQL}
      LIMIT $2`,
    [organizationId, BATCH],
  );
  for (const { entry_id, ...row } of stale.rows) {
    const facts = await completeFacts(db, organizationId, row);
    const c = buildCandidate(facts);
    await db.query(
      `UPDATE knowledge_entries SET title = $3, symptoms = $4, cause = $5, cause_source = $6, fix_steps = $7, tags = $8, event_types = $9,
              device_types = $10, vendors = $11, source_fingerprint = $12, revision = revision + 1, updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND NOT edited AND status = 'candidate'`,
      [organizationId, entry_id, c.title, c.symptoms, c.cause, c.cause_source, c.fix_steps, c.tags, c.event_types, c.device_types, c.vendors, facts.fingerprint],
    );
    await addRevision(db, organizationId, entry_id, 'refreshed', null);
    written++;
  }

  if (written) await notifyRealtime(db, organizationId, 'events');
  return written;
}

/** Run a capture pass for one organization in its own transaction; a failure never breaks the read that triggered it. */
export async function syncCandidates(organizationId: string): Promise<void> {
  try {
    await withTenant(organizationId, (db) => captureCandidates(db, organizationId));
  } catch (err) {
    logger.warn({ err, organizationId }, 'knowledge candidate capture failed');
  }
}
