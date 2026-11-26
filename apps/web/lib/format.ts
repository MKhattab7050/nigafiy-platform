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

/**
 * A number with a Latin unit, isolated as left-to-right text (LRI … PDI) so that in Arabic it reads
 * "22 ms" instead of the bidi-reordered "ms 22". The marks are invisible.
 */
const ltr = (s: string): string => `\u2066${s}\u2069`;

export const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : ltr(v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`));
export const pct = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined ? '—' : ltr(`${v.toFixed(v === 0 || v === 100 ? 0 : digits)}%`));

/** Bits per second in the unit a network engineer expects (decimal: 1 Mb/s = 1,000,000 b/s). */
export function bps(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v >= 1e9) return ltr(`${(v / 1e9).toFixed(2)} Gb/s`);
  if (v >= 1e6) return ltr(`${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)} Mb/s`);
  if (v >= 1e3) return ltr(`${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)} kb/s`);
  return ltr(`${Math.round(v)} b/s`);
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
  device_offline: { en: 'Device offline', ar: 'جهاز غير متصل' },
  device_online: { en: 'Device back online', ar: 'جهاز عاد متصلًا' },
  device_ip_changed: { en: 'IP changed', ar: 'تغيّر IP' },
  ip_mac_changed: { en: 'IP answered by new MAC', ar: 'MAC جديد لعنوان IP' },
  discovery_baseline: { en: 'Initial discovery', ar: 'الاكتشاف الأولي' },
  check_down: { en: 'Check down', ar: 'فحص متوقف' },
  check_degraded: { en: 'Check degraded', ar: 'فحص متراجع' },
  check_recovered: { en: 'Check recovered', ar: 'تعافي فحص' },
  collector_enrolled: { en: 'Collector enrolled', ar: 'تسجيل مستشعر' },
  collector_offline: { en: 'Collector out of contact', ar: 'مستشعر فقد الاتصال' },
  collector_online: { en: 'Collector reconnected', ar: 'مستشعر عاد للاتصال' },
  notification_test: { en: 'Test notification', ar: 'إشعار اختبار' },
  notification_summary: { en: 'Notification summary', ar: 'ملخص الإشعارات' },
  unwanted_device_online: { en: 'Unwanted device online', ar: 'جهاز غير مرغوب متصل' },
  endpoint_enrolled: { en: 'Computer enrolled', ar: 'تسجيل حاسوب' },
  endpoint_command: { en: 'Computer command', ar: 'أمر على حاسوب' },
  endpoint_monitor_breach: { en: 'Computer monitoring alert', ar: 'تنبيه مراقبة حاسوب' },
  endpoint_monitor_recovered: { en: 'Computer monitoring recovered', ar: 'تعافي مراقبة حاسوب' },
  ip_conflict_detected: { en: 'IP conflict', ar: 'تعارض عناوين IP' },
  ip_conflict_resolved: { en: 'IP conflict resolved', ar: 'حل تعارض IP' },
  switch_unreadable: { en: 'Switch unreadable', ar: 'تعذّرت قراءة السويتش' },
  switch_readable: { en: 'Switch readable again', ar: 'عادت قراءة السويتش' },
  device_port_changed: { en: 'Device moved port', ar: 'جهاز غيّر المنفذ' },
  router_login_failed: { en: 'Router login failed', ar: 'فشل الدخول إلى الراوتر' },
  router_unreachable: { en: 'Router unreachable', ar: 'تعذّر الوصول إلى الراوتر' },
  router_reachable: { en: 'Router reachable again', ar: 'عاد الوصول إلى الراوتر' },
  device_blocked: { en: 'Device blocked', ar: 'حظر جهاز' },
  device_unblocked: { en: 'Device unblocked', ar: 'إلغاء حظر جهاز' },
  maintenance_started: { en: 'Maintenance started', ar: 'بدء الصيانة' },
  maintenance_ended: { en: 'Maintenance ended', ar: 'انتهاء الصيانة' },
  config_changed: { en: 'Configuration changed', ar: 'تغيّر الإعدادات' },
  config_backup_failed: { en: 'Config backup failed', ar: 'فشل نسخ الإعدادات' },
  config_host_key_changed: { en: 'SSH host key changed', ar: 'تغيّر مفتاح SSH للجهاز' },
  config_restored: { en: 'Configuration restored', ar: 'استُعيدت الإعدادات' },
  config_restore_failed: { en: 'Configuration restore failed', ar: 'فشلت استعادة الإعدادات' },
  dhcp_no_offer: { en: 'No DHCP offer', ar: 'لا يوجد عرض DHCP' },
  dhcp_offer_restored: { en: 'DHCP offers back', ar: 'عادت عروض DHCP' },
  rogue_dhcp_server: { en: 'Rogue DHCP server', ar: 'خادم DHCP غير مصرّح' },
  rogue_dhcp_cleared: { en: 'Rogue DHCP server gone', ar: 'اختفى خادم DHCP غير المصرّح' },
  upnp_risky_mapping: { en: 'Risky UPnP port mapping', ar: 'توجيه منفذ UPnP خطر' },
  playbook_notification: { en: 'Playbook notification', ar: 'إشعار من دليل تشغيل' },
  playbook_approval_requested: { en: 'Playbook approval requested', ar: 'طلب موافقة على دليل تشغيل' },
  incident_escalated: { en: 'Incident escalated', ar: 'تصعيد حادثة' },
  monitoring_off: { en: 'Monitoring was off', ar: 'توقفت المراقبة' },
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

/** The IANA time zone of this browser (sent when a site or account is created), or undefined when unavailable. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Every IANA zone this browser knows, with UTC first (some browsers leave it out of the list). */
export function allTimeZones(): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    /* older browser: the search box still accepts a typed zone */
  }
  return ['UTC', ...zones.filter((z) => z !== 'UTC')];
}
