import type { Insight, ReportLine, WeeklyImprovement } from '@nigafiy/shared-types';
import { insightText } from '@/features/dashboard/insights-text';
import { clockTime } from '@/lib/format';
import type { Locale } from '@/lib/i18n';
import { localizeIncidentTitle } from '@/lib/localize';

/**
 * Wording for the sentences of System Health and the weekly report. The API sends a stable `code`,
 * its `params` and the English `text`; English shows `text`, Arabic is rendered from these rules and
 * falls back to the English when a code is unknown (a newer server).
 */

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => String(v ?? '');

/** "3 h 5 min" in the reader's language, from seconds. */
export function spanText(seconds: number, locale: Locale): string {
  const f = (n: number, unit: 'minute' | 'hour' | 'day') => new Intl.NumberFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { style: 'unit', unit, unitDisplay: locale === 'ar' ? 'long' : 'short' }).format(n);
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return f(min, 'minute');
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${f(h, 'hour')} ${f(m, 'minute')}` : f(h, 'hour');
  return f(Math.round(h / 24), 'day');
}

const DOMAIN_AR: Record<string, string> = {
  local_gateway: 'الراوتر',
  lan_segment: 'الشبكة المحلية',
  wan_isp: 'مزوّد الإنترنت',
  wan_quality: 'جودة اتصال الإنترنت',
  remote_target: 'خدمة بعيدة',
  dns: 'ترجمة الأسماء (DNS)',
  lan_quality: 'جودة الشبكة المحلية',
  service: 'خدمة مراقَبة',
  service_host: 'خادم',
  device: 'جهاز واحد',
};

const AR: Record<string, (p: ReportLine['params'], locale: Locale) => string> = {
  // System Health actions
  database_unreachable: () => 'قاعدة البيانات لا تستجيب. أعد تشغيل Nigafiy.',
  scheduler_stopped: () => 'توقف العمل في الخلفية، فلا شيء يُفحص الآن. أعد تشغيل Nigafiy.',
  jobs_stuck: (p) => `مهام خلفية متأخرة أو تفشل باستمرار: ${num(p.n)}. إن استمر ذلك فأعد تشغيل Nigafiy.`,
  no_sensor: () => 'لم يُعدّ أي مستشعر بعد، لذلك لا شيء في شبكتك مراقَب.',
  sensor_offline: (p) => `المستشعر "${str(p.name)}" لا يرسل تقاريره. تأكد أن الكمبيوتر الذي يشغّله يعمل ومتصل.`,
  heartbeat_failing: () => 'الفحص الخارجي لا يتلقى إشاراته. تحقق من الرابط في "أخبرني إذا توقف Nigafiy نفسه".',
  // Weekly report events
  score: (p) => `درجة الصحة: ${num(p.score)}/100.`,
  score_up: (p) => `ارتفعت درجة الصحة من ${num(p.previous)} إلى ${num(p.score)}.`,
  score_down: (p) => `انخفضت درجة الصحة من ${num(p.previous)} إلى ${num(p.score)}.`,
  score_same: (p) => `بقيت درجة الصحة عند ${num(p.score)}.`,
  problems: (p) =>
    num(p.open)
      ? `مشكلات بدأت هذا الأسبوع: ${num(p.opened)}. حُلّ منها ${num(p.resolved)} وما زال ${num(p.open)} مفتوحًا.`
      : `مشكلات بدأت هذا الأسبوع: ${num(p.opened)}، وحُلّت كلها.`,
  longest: (p, l) => `أطول مشكلة: "${localizeIncidentTitle(str(p.title), l)}" (${spanText(num(p.seconds), l)}).`,
  longest_open: (p, l) => `أطول مشكلة: "${localizeIncidentTitle(str(p.title), l)}"، مفتوحة منذ ${spanText(num(p.seconds), l)} حتى الآن.`,
  doctor_domain: (p) => `أرجع طبيب الشبكة ${num(p.n)} منها إلى ${DOMAIN_AR[str(p.domain)] ?? str(p.domain)}.`,
  new_devices: (p) =>
    num(p.unreviewed)
      ? `أجهزة جديدة انضمت إلى الشبكة: ${num(p.n)}، لم يُراجَع منها ${num(p.unreviewed)} بعد.`
      : `أجهزة جديدة انضمت إلى الشبكة: ${num(p.n)}.`,
  monitoring_off: (p, l) => {
    const total = spanText(num(p.total_seconds), l);
    const from = clockTime(str(p.from), l, true);
    const to = clockTime(str(p.to), l, true);
    return num(p.n) === 1 ? `توقفت المراقبة مدة ${total}، من ${from} إلى ${to}.` : `توقفت المراقبة ${num(p.n)} مرات، مجموعها ${total} (الأطول من ${from} إلى ${to}).`;
  },
  quiet: () => 'أسبوع هادئ: لم يحتج شيء إلى تدخلك.',
};

export function reportLineText(line: ReportLine, locale: Locale): string {
  const rule = locale === 'ar' ? AR[line.code] : undefined;
  return rule ? rule(line.params, locale) : line.text;
}

const HEARTBEAT_AR = { title: 'اعرف عندما يتوقف Nigafiy نفسه', detail: 'توقفت المراقبة هذا الأسبوع. يمكن لفحص خارجي أن ينبهك على هاتفك في المرة القادمة.' };

/** An improvement is an insight (worded like the dashboard does) or a setup step. */
export function improvementText(i: WeeklyImprovement, locale: Locale): { title: string; detail: string } {
  if (i.code === 'setup_outside_heartbeat') return locale === 'ar' ? HEARTBEAT_AR : { title: i.text, detail: i.detail };
  return insightText({ code: i.code, params: i.params, title: i.text, detail: i.detail } as Insight, locale);
}
