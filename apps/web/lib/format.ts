import type { Locale } from './i18n';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

export function relativeTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '—';
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') return rtf.format(Math.trunc(seconds / size), unit);
  }
  return '—';
}

export function absoluteTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
}

export function clockTime(iso: string, locale: Locale, withDate: boolean): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', withDate ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

export const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);
export const pct = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined ? '—' : `${v.toFixed(v === 0 || v === 100 ? 0 : digits)}%`);

/** Bits per second in the unit a network engineer expects (decimal: 1 Mb/s = 1,000,000 b/s). */
export function bps(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)} Mb/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)} kb/s`;
  return `${Math.round(v)} b/s`;
}

export function duration(fromIso: string, toIso: string | null): string {
  const seconds = Math.max(0, Math.round(((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129_600) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export const DEVICE_TYPE_LABEL: Record<string, { en: string; ar: string }> = {
  windows_computer: { en: 'Windows computer', ar: 'حاسوب Windows' },
  linux_computer: { en: 'Linux computer', ar: 'حاسوب Linux' },
  server: { en: 'Server', ar: 'خادم' },
  router: { en: 'Router', ar: 'موجّه' },
  switch: { en: 'Switch', ar: 'مبدّل' },
  firewall: { en: 'Firewall', ar: 'جدار حماية' },
  printer: { en: 'Printer', ar: 'طابعة' },
  access_point: { en: 'Access point', ar: 'نقطة وصول' },
  camera: { en: 'Camera', ar: 'كاميرا' },
  nas: { en: 'NAS', ar: 'تخزين شبكي' },
  iot: { en: 'IoT device', ar: 'جهاز IoT' },
  mobile: { en: 'Phone / tablet', ar: 'هاتف / لوحي' },
  apple_computer: { en: 'Mac computer', ar: 'حاسوب Mac' },
  media_player: { en: 'TV / media player', ar: 'تلفاز / مشغّل وسائط' },
  unknown: { en: 'Unclassified', ar: 'غير مصنّف' },
};

export const EVENT_TYPE_LABEL: Record<string, { en: string; ar: string }> = {
  device_discovered: { en: 'New device', ar: 'جهاز جديد' },
  device_offline: { en: 'Device offline', ar: 'انقطاع جهاز' },
  device_online: { en: 'Device back online', ar: 'عودة جهاز' },
  device_ip_changed: { en: 'IP changed', ar: 'تغيّر IP' },
  ip_mac_changed: { en: 'IP answered by new MAC', ar: 'MAC جديد لعنوان IP' },
  discovery_baseline: { en: 'Initial discovery', ar: 'الاكتشاف الأولي' },
  check_down: { en: 'Check down', ar: 'فحص متوقف' },
  check_degraded: { en: 'Check degraded', ar: 'فحص متراجع' },
  check_recovered: { en: 'Check recovered', ar: 'تعافي فحص' },
  collector_enrolled: { en: 'Collector enrolled', ar: 'تسجيل مجمِّع' },
  collector_offline: { en: 'Collector out of contact', ar: 'مجمِّع فقد الاتصال' },
  collector_online: { en: 'Collector reconnected', ar: 'مجمِّع عاد للاتصال' },
  notification_test: { en: 'Test notification', ar: 'إشعار اختبار' },
};

/** <input type="datetime-local"> value (local time, minute precision) ↔ ISO string. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | null => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
