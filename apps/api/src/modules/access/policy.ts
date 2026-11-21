import { z } from 'zod';
import { safeTimeZone } from '../../common/timezone.ts';

/** Categories the collector understands. `encrypted_dns` is always enforced while filtering is on. */
export const ACCESS_CATEGORIES = ['ads_malware', 'adult', 'gambling', 'social', 'video', 'games', 'chat'] as const;
export type AccessCategory = (typeof ACCESS_CATEGORIES)[number];

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Accepts "https://www.Example.com/path", "*.example.com" or "example.com." and stores "example.com". */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^\*\./, '').replace(/\.$/, '').replace(/^www\./, '');
  return DOMAIN.test(d) ? d : null;
}

export const domainList = z
  .array(z.string().max(300))
  .max(500)
  .transform((list, ctx) => {
    const out = new Set<string>();
    for (const raw of list) {
      if (!raw.trim()) continue;
      const d = normalizeDomain(raw);
      if (!d) {
        ctx.addIssue({ code: 'custom', message: `"${raw.slice(0, 60)}" is not a domain name` });
        return z.NEVER;
      }
      out.add(d);
    }
    return [...out].sort();
  });

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM');
export const scheduleSchema = z
  .array(
    z
      .object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), from: hhmm, to: hhmm })
      .strict()
      .refine((w) => w.from !== w.to, 'start and end must differ'),
  )
  .max(14);
export type ScheduleWindow = z.infer<typeof scheduleSchema>[number];

export interface RuleLayer {
  blocked_categories: string[];
  blocked_domains: string[];
  allowed_domains: string[];
  schedule?: ScheduleWindow[];
  paused_until?: Date | string | null;
}

export interface EffectiveRule {
  blocked_categories: string[];
  blocked_domains: string[];
  allowed_domains: string[];
  schedule: ScheduleWindow[];
  paused_until?: string;
}

const union = (...lists: (string[] | undefined)[]) => [...new Set(lists.flatMap((l) => l ?? []))].sort();

/**
 * Layers combine by union: a device in the "Kids" profile is blocked from what the whole site
 * blocks plus what the profile blocks plus its own list. Allowed domains from any layer win over
 * blocked lists and categories (but not over a pause or bedtime). The latest pause applies.
 */
export function mergeRules(now: Date, ...layers: (RuleLayer | null | undefined)[]): EffectiveRule {
  const present = layers.filter((l): l is RuleLayer => Boolean(l));
  const pauses = present
    .map((l) => (l.paused_until ? new Date(l.paused_until) : null))
    .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime());
  const rule: EffectiveRule = {
    blocked_categories: union(...present.map((l) => l.blocked_categories)).filter((c) => (ACCESS_CATEGORIES as readonly string[]).includes(c)),
    blocked_domains: union(...present.map((l) => l.blocked_domains)),
    allowed_domains: union(...present.map((l) => l.allowed_domains)),
    schedule: present.flatMap((l) => l.schedule ?? []),
  };
  if (pauses[0]) rule.paused_until = pauses[0].toISOString();
  return rule;
}

/**
 * Whether a rule turns the internet off at `now` (pause or bedtime), evaluated in the given IANA zone
 * (the site's). A zone this runtime does not know is evaluated as UTC rather than failing the request.
 */
export function internetOff(rule: EffectiveRule, now: Date, timeZone = 'UTC'): 'paused' | 'schedule' | null {
  if (rule.paused_until && new Date(rule.paused_until) > now) return 'paused';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone(timeZone), weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  for (const w of rule.schedule) {
    const from = toMin(w.from);
    const to = toMin(w.to);
    const active =
      from < to
        ? w.days.includes(day) && minutes >= from && minutes < to
        : (w.days.includes(day) && minutes >= from) || (w.days.includes((day + 6) % 7) && minutes < to);
    if (active) return 'schedule';
  }
  return null;
}
