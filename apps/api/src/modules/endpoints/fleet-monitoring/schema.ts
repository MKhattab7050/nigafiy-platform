import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

/**
 * One monitoring rule. Each kind takes its own fields:
 *   cpu / memory   threshold (percent, breaches above it)
 *   disk_free      threshold in pct or gb (breaches below it), mount (one volume) or every volume
 *   service        service_name (Windows service name, systemd unit, launchd label) must be running
 *   event_log      event_log (Windows log name), event_source (provider / systemd unit), event_ids
 *                  (Windows), event_level, match_text; breaches when at least `threshold` entries
 *                  match within event_window_minutes
 */
const ruleFields = {
  name: text(1, 120),
  fleet_group_id: z.uuid().nullable().default(null),
  kind: z.enum(['cpu', 'memory', 'disk_free', 'service', 'event_log']),
  threshold: z.number().min(0).max(1_000_000).nullable().default(null),
  threshold_unit: z.enum(['pct', 'gb', 'count']).nullable().default(null),
  mount: text(1, 120).nullable().default(null),
  service_name: text(1, 256).nullable().default(null),
  event_log: text(1, 256).nullable().default(null),
  event_source: text(1, 256).nullable().default(null),
  event_ids: z.array(z.number().int().min(0).max(65_535)).max(20).nullable().default(null),
  event_level: z.enum(['critical', 'error', 'warning', 'any']).nullable().default(null),
  match_text: text(1, 200).nullable().default(null),
  event_window_minutes: z.number().int().min(1).max(1440).nullable().default(null),
  duration_seconds: z.number().int().min(0).max(86_400).default(300),
  severity: z.enum(['warning', 'critical']).default('warning'),
  enabled: z.boolean().default(true),
};

type RuleShape = z.infer<z.ZodObject<typeof ruleFields>>;

/** Clears the fields the kind does not use and checks the ones it needs. */
export function normalizeRule(r: RuleShape, ctx: z.RefinementCtx): RuleShape {
  const out = { ...r };
  const need = (cond: boolean, path: string, message: string) => {
    if (!cond) ctx.addIssue({ code: 'custom', path: [path], message });
  };
  if (r.kind !== 'disk_free') out.mount = null;
  if (r.kind !== 'service') out.service_name = null;
  if (r.kind !== 'event_log') Object.assign(out, { event_log: null, event_source: null, event_ids: null, event_level: null, match_text: null, event_window_minutes: null });
  switch (r.kind) {
    case 'cpu':
    case 'memory':
      need(r.threshold !== null && r.threshold > 0 && r.threshold <= 100, 'threshold', 'a percentage between 1 and 100 is required');
      out.threshold_unit = 'pct';
      break;
    case 'disk_free':
      need(r.threshold !== null, 'threshold', 'the free-space threshold is required');
      need(r.threshold_unit === 'pct' || r.threshold_unit === 'gb', 'threshold_unit', 'pct or gb');
      if (r.threshold_unit === 'pct') need(r.threshold !== null && r.threshold <= 100, 'threshold', 'at most 100 percent');
      break;
    case 'service':
      need(r.service_name !== null, 'service_name', 'the service name is required');
      out.threshold = null;
      out.threshold_unit = null;
      break;
    case 'event_log':
      need(r.event_log !== null, 'event_log', 'the log name is required (System, Application, … ; on Linux the journal is read)');
      need(r.event_window_minutes !== null, 'event_window_minutes', 'the time window is required');
      out.threshold = r.threshold ?? 1;
      need(out.threshold >= 1 && Number.isInteger(out.threshold), 'threshold', 'a whole number of entries, at least 1');
      out.threshold_unit = 'count';
      out.event_level = r.event_level ?? 'any';
      break;
  }
  return out;
}

export const monitorRuleSchema = z.object(ruleFields).strict().transform(normalizeRule);
export type MonitorRuleInput = z.infer<typeof monitorRuleSchema>;

/** The agent's measurements in the heartbeat (internal/monitor). */
export const agentMonitorSchema = z
  .object({
    services: z.record(text(1, 256), z.enum(['running', 'stopped', 'paused', 'starting', 'stopping', 'not_found', 'unknown', ''])).refine((r) => Object.keys(r).length <= 100, 'too many services'),
    events: z
      .record(
        z.uuid(),
        z
          .object({
            count: z.number().int().min(0).max(1_000_000),
            sample: z.string().max(200).optional(),
            error: z.string().max(300).optional(),
            measured_at: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .refine((r) => Object.keys(r).length <= 100, 'too many event rules'),
  })
  .strict();
export type AgentMonitor = z.infer<typeof agentMonitorSchema>;

export const monitorStatesQuery = z.object({ breaching: z.enum(['1', '0']).optional(), endpoint_id: z.uuid().optional() }).strict();
