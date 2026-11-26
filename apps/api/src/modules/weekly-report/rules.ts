import type { Insight, ReportLine, Severity, WeeklyImprovement } from '@nigafiy/shared-types';

/**
 * Weekly report rules: pure, deterministic, no AI. Facts in (service.ts gathers them from incidents
 * and their Doctor diagnosis, devices, monitoring gaps, the insights and the previous report's
 * score), at most a handful of one-sentence lines and three improvements out.
 *
 * The owner wants the app quiet: a line appears only when it says something (no "0 new devices").
 */
export interface WeeklyFacts {
  timezone: string;
  score: number | null;
  previousScore: number | null;
  incidents: {
    opened: number;
    /** Of those opened this week, how many are solved now. */
    resolved: number;
    stillOpen: number;
    longest: { title: string; seconds: number; open: boolean } | null;
    /** Doctor fault domains of this week's incidents, most frequent first. */
    domains: { domain: string; n: number }[];
  };
  newDevices: { n: number; unreviewed: number };
  gaps: { n: number; totalSeconds: number; longest: { from: Date; to: Date } | null };
  insights: Insight[];
  heartbeatConfigured: boolean;
}

export const DOMAIN_TEXT: Record<string, string> = {
  local_gateway: 'the router',
  lan_segment: 'the local network',
  wan_isp: 'the internet provider',
  wan_quality: 'the internet connection quality',
  remote_target: 'a remote service',
  dns: 'name lookups (DNS)',
  lan_quality: 'the local network quality',
  service: 'a monitored service',
  service_host: 'a server',
  device: 'a single device',
};

export function durationText(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function localTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

const line = (code: string, params: ReportLine['params'], text: string): ReportLine => ({ code, params, text });

/** The week's main events and changes, one sentence each. */
export function weeklyEvents(f: WeeklyFacts): ReportLine[] {
  const out: ReportLine[] = [];
  if (f.score !== null) {
    if (f.previousScore === null) out.push(line('score', { score: f.score }, `Health score: ${f.score}/100.`));
    else if (f.score > f.previousScore) out.push(line('score_up', { score: f.score, previous: f.previousScore }, `Health score went up from ${f.previousScore} to ${f.score}.`));
    else if (f.score < f.previousScore) out.push(line('score_down', { score: f.score, previous: f.previousScore }, `Health score went down from ${f.previousScore} to ${f.score}.`));
    else out.push(line('score_same', { score: f.score }, `Health score stayed at ${f.score}.`));
  }
  const inc = f.incidents;
  if (inc.opened > 0) {
    out.push(
      line(
        'problems',
        { opened: inc.opened, resolved: inc.resolved, open: inc.stillOpen },
        inc.stillOpen
          ? `${n(inc.opened, 'problem')} started; ${inc.resolved} solved, ${inc.stillOpen} still open.`
          : `${n(inc.opened, 'problem')} started and ${inc.opened === 1 ? 'it is' : 'all are'} solved.`,
      ),
    );
    if (inc.longest && inc.longest.seconds >= 600) {
      const d = durationText(inc.longest.seconds);
      out.push(
        line(
          inc.longest.open ? 'longest_open' : 'longest',
          { title: inc.longest.title, duration: d, seconds: inc.longest.seconds },
          inc.longest.open ? `Longest problem: "${inc.longest.title}", open for ${d} so far.` : `Longest problem: "${inc.longest.title}" (${d}).`,
        ),
      );
    }
    const top = inc.domains.find((x) => x.domain !== 'healthy' && DOMAIN_TEXT[x.domain]);
    if (top && top.n >= 2) {
      out.push(line('doctor_domain', { domain: top.domain, n: top.n }, `The Network Doctor traced ${top.n} of them to ${DOMAIN_TEXT[top.domain]}.`));
    }
  }
  if (f.newDevices.n > 0) {
    out.push(
      line(
        'new_devices',
        { n: f.newDevices.n, unreviewed: f.newDevices.unreviewed },
        f.newDevices.unreviewed
          ? `${n(f.newDevices.n, 'new device')} joined the network; ${f.newDevices.unreviewed} not reviewed yet.`
          : `${n(f.newDevices.n, 'new device')} joined the network.`,
      ),
    );
  }
  if (f.gaps.n > 0 && f.gaps.longest) {
    const total = durationText(f.gaps.totalSeconds);
    const from = localTime(f.gaps.longest.from, f.timezone);
    const to = localTime(f.gaps.longest.to, f.timezone);
    out.push(
      line(
        'monitoring_off',
        { n: f.gaps.n, total, total_seconds: f.gaps.totalSeconds, from: f.gaps.longest.from.toISOString(), to: f.gaps.longest.to.toISOString() },
        f.gaps.n === 1 ? `Monitoring was off for ${total}, from ${from} to ${to}.` : `Monitoring was off ${f.gaps.n} times, ${total} in total (longest from ${from} to ${to}).`,
      ),
    );
  }
  if (inc.opened === 0 && f.gaps.n === 0 && f.newDevices.n === 0) out.push(line('quiet', {}, 'A quiet week: nothing needed you.'));
  return out;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const CATEGORY_RANK: Record<Insight['category'], number> = { security: 0, availability: 1, setup: 2, performance: 3, inventory: 4 };

/** The top 3 things to improve next week: open insights by severity, plus the outside heartbeat after an unwatched gap. */
export function weeklyImprovements(f: WeeklyFacts): WeeklyImprovement[] {
  const fromInsights: WeeklyImprovement[] = [...f.insights]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category])
    .map((i) => ({
      code: i.code,
      params: i.params,
      text: i.title,
      detail: i.detail,
      severity: i.severity,
      href: i.actions.find((a) => a.kind === 'link')?.href ?? null,
    }));
  // Monitoring was off this week and nobody outside would have known: worth one step.
  if (f.gaps.n > 0 && !f.heartbeatConfigured) {
    const hb: WeeklyImprovement = {
      code: 'setup_outside_heartbeat',
      params: {},
      text: 'Get told when Nigafiy itself stops',
      detail: 'Monitoring was off this week. An outside check can warn you on your phone the next time it happens.',
      severity: 'info',
      href: '/system/health#outside-heartbeat',
    };
    const firstInfo = fromInsights.findIndex((i) => i.severity === 'info');
    fromInsights.splice(firstInfo === -1 ? fromInsights.length : firstInfo, 0, hb);
  }
  return fromInsights.slice(0, 3);
}

/** Title of the optional notification: short, the score and the one number that matters. */
export function weeklyTitle(f: Pick<WeeklyFacts, 'score' | 'incidents'>): string {
  const parts = ['Weekly report'];
  if (f.score !== null) parts.push(`score ${f.score}`);
  parts.push(f.incidents.opened ? n(f.incidents.opened, 'problem') : 'no problems');
  return `${parts[0]}: ${parts.slice(1).join(', ')}`;
}
