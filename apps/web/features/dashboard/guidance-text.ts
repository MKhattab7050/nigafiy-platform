import type { Insight, InsightAction, InsightsReport } from '@nigafiy/shared-types';
import type { Key } from '@/lib/i18n';

/**
 * Plain-language wording for the dashboard's "Next" block and for the reasons behind the score.
 * The API sends stable codes and params (insights/rules.ts); these tables turn them into one
 * sentence each. A code without an entry falls back to the insight's own title.
 */

/** A finding worded as a step: the sentence, its button, and whether the sentence takes a count. */
export interface StepText {
  text: Key;
  button: Key;
  /** Read with tn(text, params.count). */
  plural?: boolean;
}

const STEP: Record<string, StepText> = {
  unreviewed: { text: 'dash.next.unreviewed', button: 'dash.next.unreviewed.do', plural: true },
  suggest_monitor_infrastructure: { text: 'dash.next.suggest_monitor_infrastructure', button: 'dash.next.suggest_monitor_infrastructure.do', plural: true },
  suggest_monitor: { text: 'dash.next.suggest_monitor', button: 'dash.next.suggest_monitor.do' },
  collector_silent: { text: 'dash.next.collector_silent', button: 'dash.next.collector_silent.do' },
  critical_offline: { text: 'dash.next.critical_offline', button: 'dash.next.critical_offline.do' },
  unwanted_online: { text: 'dash.next.unwanted_online', button: 'dash.next.unwanted_online.do' },
  unwanted_blockable: { text: 'dash.next.unwanted_blockable', button: 'dash.next.unwanted_blockable.do' },
  path: { text: 'dash.next.path', button: 'dash.next.path.do' },
  open_incidents: { text: 'dash.next.open_incidents', button: 'dash.next.open_incidents.do', plural: true },
  certificate_expiring: { text: 'dash.next.certificate_expiring', button: 'dash.next.certificate_expiring.do', plural: true },
  access_not_running: { text: 'dash.next.access_not_running', button: 'dash.next.access_not_running.do' },
  access_no_devices: { text: 'dash.next.access_no_devices', button: 'dash.next.access_no_devices.do' },
  port_errors: { text: 'dash.next.port_errors', button: 'dash.next.port_errors.do', plural: true },
  switch_unreadable: { text: 'dash.next.switch_unreadable', button: 'dash.next.switch_unreadable.do' },
  watch_refused: { text: 'dash.next.watch_refused', button: 'dash.next.watch_refused.do', plural: true },
  ip_conflict: { text: 'dash.next.ip_conflict', button: 'dash.next.ip_conflict.do', plural: true },
};

/** path_gateway_down, path_internet_degraded… share one step: "find the cause" in Network Doctor. */
const stepKey = (code: string) => (code.startsWith('path_') ? 'path' : code);

export function stepText(code: string): StepText | null {
  return STEP[stepKey(code)] ?? null;
}

/**
 * Tips that are not a job to do. They stay in Network health, never in "Next": the owner wants
 * the top of the dashboard quiet unless there is something to act on.
 */
const NOT_A_STEP = new Set(['new_today', 'access_off', 'access_partial', 'adult_attempts', 'bypass_attempts', 'nameless_phones', 'slow_internet']);

export const MAX_STEPS = 3;

export interface NextStep {
  insight: Insight;
  /** The action the step's button runs: an API call that does the job, else the link to the exact place. */
  action: InsightAction;
}

/**
 * The 1–3 things to do next, most serious first (the API already sorts by severity).
 * Only findings with an action qualify; `skip` drops codes another card already asks for.
 */
export function nextSteps(report: InsightsReport | null | undefined, skip: ReadonlySet<string> = new Set()): { steps: NextStep[]; more: number } {
  if (!report) return { steps: [], more: 0 };
  const all = report.insights
    .filter((i) => !NOT_A_STEP.has(i.code) && !skip.has(i.code) && i.actions.length > 0)
    .map((insight) => ({ insight, action: pickAction(insight) }));
  // One step per kind of job: "turn monitoring on" for one important device and for the
  // infrastructure devices read as the same step twice (or three times). The first, most serious
  // one stays; the others are still listed in Network health and counted in "more".
  const seen = new Set<string>();
  const steps: NextStep[] = [];
  for (const s of all) {
    const group = stepGroup(s.insight.code);
    if (seen.has(group)) continue;
    seen.add(group);
    if (steps.length < MAX_STEPS) steps.push(s);
  }
  return { steps, more: all.length - steps.length };
}

/** Steps that ask for the same job share a group: only one of a group goes in "Next". */
export function stepGroup(code: string): string {
  if (code === 'suggest_monitor' || code === 'suggest_monitor_infrastructure') return 'monitor';
  return stepKey(code);
}

/** Bulk "Mark all as known" asks too much trust for a one-click step: reviewing them is the step. */
function pickAction(i: Insight): InsightAction {
  if (i.code === 'unreviewed') return i.actions.find((a) => a.kind === 'link') ?? i.actions[0]!;
  return i.actions[0]!;
}

/** A score deduction worded as a sentence. `variant` picks the down / degraded form of path_* codes. */
export interface ReasonText {
  key: Key;
  plural?: boolean;
  params: Record<string, string | number>;
}

const REASON: Record<string, { key: Key; plural?: boolean }> = {
  collector_silent: { key: 'dash.why.collector_silent' },
  unwanted_online: { key: 'dash.why.unwanted_online', plural: true },
  unreviewed: { key: 'dash.why.unreviewed', plural: true },
  ip_conflict: { key: 'dash.why.ip_conflict' },
  slow_internet: { key: 'dash.why.slow_internet' },
  certificate_expiring: { key: 'dash.why.certificate_expiring' },
  watch_refused: { key: 'dash.why.watch_refused' },
  critical_offline: { key: 'dash.why.critical_offline', plural: true },
  open_incidents: { key: 'dash.why.open_incidents' },
  switch_unreadable: { key: 'dash.why.switch_unreadable' },
  port_errors: { key: 'dash.why.port_errors' },
  access_not_running: { key: 'dash.why.access_not_running' },
  access_no_devices: { key: 'dash.why.access_no_devices' },
};

const PATH: Record<string, Key> = {
  'path_gateway.down': 'dash.why.path_gateway.down',
  'path_gateway.degraded': 'dash.why.path_gateway.degraded',
  'path_internet.down': 'dash.why.path_internet.down',
  'path_internet.degraded': 'dash.why.path_internet.degraded',
  'path_dns.down': 'dash.why.path_dns.down',
  'path_dns.degraded': 'dash.why.path_dns.degraded',
};

/**
 * The deduction reasons are short English phrases ("12 unreviewed device(s)", "Collector X is not
 * reporting", "gateway down"); the count and the name are read back out of them.
 */
export function reasonText(d: InsightsReport['score_breakdown'][number]): ReasonText | null {
  if (d.code.startsWith('path_')) {
    const key = PATH[`${d.code}.${/\bdown\b/.test(d.reason) ? 'down' : 'degraded'}`];
    return key ? { key, params: {} } : null;
  }
  const r = REASON[d.code];
  if (!r) return null;
  const count = Number(d.reason.match(/^(\d+)/)?.[1] ?? 1);
  const name = d.reason.match(/^(?:Collector|Switch) (.+?) (?:is not reporting|unreadable)$/)?.[1] ?? '';
  return { key: r.key, plural: r.plural, params: { count, name } };
}
