import type { KnowledgeReason } from '@lan-detective/shared-types';

/**
 * Deterministic similarity ranking of knowledge entries (no AI, no randomness).
 *
 * Every point of a score comes from a named reason, so the UI can say exactly why an entry was
 * suggested. Matching reasons (rule, kind, event type, device, check, type, vendor, site, text) decide
 * whether an entry is relevant at all; recency and the team's feedback only re-order relevant entries.
 */

export interface RankContext {
  incident_id: string | null;
  device_id: string | null;
  site_id: string | null;
  check_id: string | null;
  rule_ids: string[];
  fault_domain: string | null;
  incident_kind: string | null;
  event_types: string[];
  device_type: string | null;
  vendor: string | null;
}

export interface RankCandidate {
  id: string;
  rule_ids: string[];
  fault_domain: string | null;
  incident_kinds: string[];
  event_types: string[];
  device_types: string[];
  vendors: string[];
  site_id: string | null;
  device_id: string | null;
  check_id: string | null;
  /** Full-text rank (ts_rank_cd) of the entry against the context text, 0 when no term matched. */
  text_rank: number;
  helpful: number;
  not_helpful: number;
  uses: number;
  updated_at: Date | string;
}

export const POINTS = {
  rule: 40,
  device: 25,
  check: 15,
  incident_kind: 10,
  fault_domain: 10,
  device_type: 10,
  vendor: 10,
  site: 8,
  event_type_each: 8,
  event_type_max: 16,
  text_max: 15,
  recent_max: 5,
  recent_days: 90,
  vote_each: 3,
  vote_max: 15,
  use_each: 2,
  use_max: 10,
} as const;

/** Codes that make an entry relevant; recency, votes and uses never do on their own. */
const MATCH_CODES = new Set(['rule', 'fault_domain', 'incident_kind', 'event_type', 'device', 'check', 'device_type', 'vendor', 'site', 'text']);

const norm = (s: string) => s.trim().toLowerCase();
const overlap = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(b.map(norm));
  return [...new Set(a.map(norm))].filter((x) => x && set.has(x));
};
const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreEntry(ctx: RankContext, e: RankCandidate, now: Date = new Date()): { score: number; reasons: KnowledgeReason[] } {
  const reasons: KnowledgeReason[] = [];
  const add = (code: KnowledgeReason['code'], points: number, detail: string | null) => {
    if (points !== 0) reasons.push({ code, points: round1(points), detail });
  };

  const rules = overlap(ctx.rule_ids, e.rule_ids);
  if (rules.length) add('rule', POINTS.rule, rules.join(', '));
  if (ctx.fault_domain && e.fault_domain && norm(ctx.fault_domain) === norm(e.fault_domain) && !['healthy', 'insufficient_data'].includes(ctx.fault_domain)) {
    add('fault_domain', POINTS.fault_domain, ctx.fault_domain);
  }
  if (ctx.incident_kind && e.incident_kinds.map(norm).includes(norm(ctx.incident_kind))) add('incident_kind', POINTS.incident_kind, ctx.incident_kind);
  const events = overlap(ctx.event_types, e.event_types);
  if (events.length) add('event_type', Math.min(POINTS.event_type_max, events.length * POINTS.event_type_each), events.join(', '));
  if (ctx.device_id && e.device_id === ctx.device_id) add('device', POINTS.device, null);
  if (ctx.check_id && e.check_id === ctx.check_id) add('check', POINTS.check, null);
  if (ctx.device_type && ctx.device_type !== 'unknown' && e.device_types.map(norm).includes(norm(ctx.device_type))) add('device_type', POINTS.device_type, ctx.device_type);
  if (ctx.vendor && e.vendors.some((v) => norm(v) && (norm(ctx.vendor!).includes(norm(v)) || norm(v).includes(norm(ctx.vendor!))))) add('vendor', POINTS.vendor, ctx.vendor);
  if (ctx.site_id && e.site_id === ctx.site_id) add('site', POINTS.site, null);
  // ts_rank_cd of a handful of shared words is ~0.1–1; scale so a strong text match is worth a vendor match.
  if (e.text_rank > 0) add('text', Math.min(POINTS.text_max, Math.max(1, e.text_rank * 30)), null);

  const relevant = reasons.some((r) => MATCH_CODES.has(r.code));
  if (!relevant) return { score: 0, reasons: [] };

  const ageDays = Math.max(0, (now.getTime() - new Date(e.updated_at).getTime()) / 86_400_000);
  if (ageDays < POINTS.recent_days) add('recent', POINTS.recent_max * (1 - ageDays / POINTS.recent_days), null);
  const net = e.helpful - e.not_helpful;
  if (net !== 0) add('votes', Math.max(-POINTS.vote_max, Math.min(POINTS.vote_max, net * POINTS.vote_each)), `+${e.helpful} / -${e.not_helpful}`);
  if (e.uses > 0) add('used', Math.min(POINTS.use_max, e.uses * POINTS.use_each), String(e.uses));

  const score = round1(reasons.reduce((s, r) => s + r.points, 0));
  return { score, reasons };
}

/**
 * Score every candidate, drop irrelevant ones (and ones whose feedback pushed them to zero or
 * below), and order: score, then helpful votes, then most recently updated, then id (total order).
 */
export function rankEntries<T extends RankCandidate>(ctx: RankContext, entries: readonly T[], limit = 5, now: Date = new Date()): { entry: T; score: number; reasons: KnowledgeReason[] }[] {
  return entries
    .map((entry) => ({ entry, ...scoreEntry(ctx, entry, now) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.helpful - a.entry.helpful ||
        new Date(b.entry.updated_at).getTime() - new Date(a.entry.updated_at).getTime() ||
        (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
    )
    .slice(0, limit);
}

/** Words of the context text turned into an OR full-text query: letters and digits only, so the query is always safe to pass to to_tsquery. */
export function textQuery(text: string, maxTerms = 16): string | null {
  const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'not', 'has', 'have', 'its', 'into', 'but', 'all', 'any', 'one']);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w) && w.length <= 40);
  const unique = [...new Set(words)].slice(0, maxTerms);
  return unique.length ? unique.join(' | ') : null;
}
