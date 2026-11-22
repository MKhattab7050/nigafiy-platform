import type { NetworkEvent } from '@lan-detective/shared-types';
import type { Locale } from '@/lib/i18n';
import { ltr } from './bidi';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Localizes live network event titles into native Arabic when `locale === 'ar'`,
 * extracting structured `details` first and falling back to safe pattern matching on `title`.
 */
export function localizeEventTitle(ev: Pick<NetworkEvent, 'type' | 'title' | 'details'>, locale: Locale): string {
  if (locale !== 'ar') return ev.title;
  const d = (ev.details ?? {}) as Record<string, unknown>;
  const t = ev.title;

  // Watch-check transitions (ingest/checks.ts transitionTitle)
  if (ev.type.startsWith('check_')) {
    const w = t.match(/^(.+): (certificate expired|certificate expires in (\d+) days|critical threshold crossed|warning threshold crossed)$/);
    if (w) {
      const what = w[2] === 'certificate expired' ? 'انتهت صلاحية الشهادة' : w[3] !== undefined ? `تنتهي صلاحية الشهادة بعد ${ltr(w[3])} يوم` : w[2]!.startsWith('critical') ? 'تجاوز حد الخطورة' : 'تجاوز حد التحذير';
      return `${w[1]}: ${what}`;
    }
  }
  switch (ev.type) {
    case 'device_discovered': {
      const ip = str(d.ip);
      const name = str(d.hostname) ?? str(d.name);
      if (name && ip) return `تم اكتشاف جهاز جديد: ${name} (${ltr(ip)})`;
      if (ip) return `تم اكتشاف جهاز جديد على العنوان ${ltr(ip)}`;
      const m = t.match(/^New device(?: discovered)?:?\s*(.+)$/i);
      return m ? `تم اكتشاف جهاز جديد: ${ltr(m[1]!)}` : t;
    }

    case 'device_online': {
      const m = t.match(/^(.+?) (?:is back online|came online|back online)$/i);
      if (m) return `عاد الجهاز ${m[1]} للاتصال`;
      const ip = str(d.ip);
      return ip ? `عاد الجهاز (${ltr(ip)}) للاتصال` : t;
    }

    case 'device_offline': {
      const m = t.match(/^(.+?) (?:went offline|is offline|stopped responding)$/i);
      if (m) return `انقطع اتصال الجهاز ${m[1]}`;
      const ip = str(d.ip);
      return ip ? `انقطع اتصال الجهاز (${ltr(ip)})` : t;
    }

    case 'device_ip_changed': {
      const from = str(d.previous_ip) ?? str(d.old_ip) ?? str(d.from_ip);
      const to = str(d.new_ip) ?? str(d.ip) ?? str(d.to_ip);
      const m = t.match(/^(.+?):? IP changed from ([0-9.]+) to ([0-9.]+)/i) ?? t.match(/^(.+?) changed IP from ([0-9.]+) to ([0-9.]+)/i);
      if (m) return `تغيّر عنوان IP للجهاز ${m[1]} من ${ltr(m[2]!)} إلى ${ltr(m[3]!)}`;
      if (from && to) return `تغيّر عنوان IP من ${ltr(from)} إلى ${ltr(to)}`;
      return t;
    }

    case 'ip_mac_changed': {
      const ip = str(d.ip);
      const oldMac = str(d.previous_mac) ?? str(d.old_mac);
      const newMac = str(d.new_mac) ?? str(d.mac);
      if (ip && oldMac && newMac) return `العنوان ${ltr(ip)} ردّ بعنوان MAC جديد (${ltr(newMac)} بدلًا من ${ltr(oldMac)})`;
      const m = t.match(/([0-9.]+)/);
      return m ? `العنوان ${ltr(m[1]!)} استجاب بعنوان MAC مختلف` : t;
    }

    case 'unwanted_device_online': {
      const m = t.match(/Unwanted device(?: online)?:?\s*(.+)$/i);
      return m ? `جهاز غير مرغوب فيه متصل الآن: ${m[1]}` : 'جهاز غير مرغوب فيه متصل بالشبكة';
    }

    case 'discovery_baseline': {
      const count = typeof d.devices === 'number' ? d.devices : typeof d.count === 'number' ? d.count : null;
      return count !== null ? `اكتمل المسح الأولي واكتُشف ${ltr(count)} جهازًا` : 'اكتمل المسح الأولي للشبكة';
    }

    case 'check_down': {
      const m = t.match(/^(.+?)(?: is)? (?:down|failed|not responding)$/i);
      return m ? `توقّف الفحص: ${m[1]}` : `فشل فحص المراقبة: ${t}`;
    }

    case 'check_degraded': {
      const m = t.match(/^(.+?)(?: is)? degraded$/i);
      return m ? `تراجع أداء الفحص: ${m[1]}` : `تراجع فحص المراقبة: ${t}`;
    }

    case 'check_recovered': {
      const m = t.match(/^(.+?)(?: has)? recovered$/i);
      return m ? `تعافى الفحص: ${m[1]}` : `تعافي فحص المراقبة: ${t}`;
    }

    case 'collector_enrolled': {
      const m = t.match(/^Collector "(.+)" enrolled$/i);
      return m ? `تم تسجيل المجمِّع «${m[1]}»` : 'تم تسجيل مجمِّع جديد';
    }

    case 'collector_offline': {
      const m = t.match(/^Collector "(.+)" (?:went offline|lost contact|is offline)/i);
      return m ? `فقد المجمِّع «${m[1]}» الاتصال` : 'فقد أحد المجمِّعات الاتصال';
    }

    case 'collector_online': {
      const m = t.match(/^Collector "(.+)" (?:is back online|reconnected|came online)/i);
      return m ? `عاد المجمِّع «${m[1]}» للاتصال` : 'عاد أحد المجمِّعات للاتصال';
    }

    case 'notification_test':
      return 'إشعار اختبار من Nigafiy';

    case 'incident_escalated': {
      const num = typeof d.incident_number === 'number' ? d.incident_number : null;
      const attempt = typeof d.attempt === 'number' ? d.attempt : null;
      const mins = typeof d.unacknowledged_minutes === 'number' ? d.unacknowledged_minutes : null;
      const incTitle = str(d.incident_title);
      if (num !== null) {
        const suffix = mins !== null ? ` (بدون إقرار منذ ${ltr(mins)} دقيقة)` : '';
        const attemptStr = attempt && attempt > 1 ? ` — تذكير #${ltr(attempt)}` : '';
        return `تصعيد الحادثة ${ltr(`INC-${num}`)}${attemptStr}: ${incTitle ?? t}${suffix}`;
      }
      return `تصعيد حادثة مفتوحة: ${t}`;
    }

    case 'ip_conflict_detected': {
      const ip = str(d.ip);
      const kind = str(d.kind);
      if (ip && kind === 'duplicate_ip') return `جهازان يستخدمان نفس العنوان ${ltr(ip)}`;
      if (ip && kind === 'reserved_in_use') return `العنوان المحجوز ${ltr(ip)} قيد الاستخدام`;
      if (ip && kind === 'assignment_mismatch') return `العنوان ${ltr(ip)} يستخدمه جهاز مختلف عن الموثَّق`;
      if (ip && kind === 'static_in_dhcp_pool') return `العنوان الثابت ${ltr(ip)} يقع داخل نطاق DHCP`;
      return ip ? `تعارض على العنوان ${ltr(ip)}` : t;
    }

    case 'ip_conflict_resolved': {
      const ip = str(d.ip);
      return ip ? `تم حل تعارض العنوان ${ltr(ip)}` : 'تم حل تعارض عنوان IP';
    }

    case 'router_login_failed': {
      const m = t.match(/^(.+?):? login failed/i) ?? t.match(/login failed.*?(?:on|for) (.+)$/i);
      return m ? `فشل تسجيل الدخول إلى الراوتر ${m[1]}` : 'فشل تسجيل الدخول إلى الراوتر';
    }

    case 'router_unreachable': {
      const m = t.match(/^(.+?):? (?:is )?unreachable/i);
      return m ? `تعذّر الوصول إلى الراوتر ${m[1]}` : 'تعذّر الوصول إلى الراوتر';
    }

    case 'router_reachable': {
      const m = t.match(/^(.+?):? (?:is )?reachable/i);
      return m ? `عاد الوصول إلى الراوتر ${m[1]}` : 'عاد الوصول إلى الراوتر';
    }

    case 'device_blocked': {
      const m = t.match(/^Blocked (.+) on (.+)$/i);
      if (m) return `تم حظر ${m[1]} على الراوتر ${m[2]}`;
      return `تم حظر جهاز من الراوتر: ${t}`;
    }

    case 'device_unblocked': {
      const m = t.match(/^Unblocked (.+) on (.+)$/i);
      if (m) return `تم فك الحظر عن ${m[1]} على الراوتر ${m[2]}`;
      return `تم إلغاء حظر جهاز من الراوتر: ${t}`;
    }

    case 'switch_unreadable': {
      const m = t.match(/^Switch (.+?) (?:stopped|is not|unreadable)/i);
      return m ? `تعذّرت قراءة السويتش ${m[1]} عبر SNMP` : 'تعذّرت قراءة السويتش عبر SNMP';
    }

    case 'switch_readable': {
      const m = t.match(/^Switch (.+?) (?:is readable|recovered)/i);
      return m ? `عادت قراءة السويتش ${m[1]} عبر SNMP` : 'عادت قراءة السويتش عبر SNMP';
    }

    case 'device_port_changed': {
      const m = t.match(/^(.+?) moved from (.+) to (.+)$/i);
      return m ? `انتقل الجهاز ${m[1]} من المنفذ ${ltr(m[2]!)} إلى ${ltr(m[3]!)}` : t;
    }

    case 'maintenance_started': {
      const reason = str(d.reason);
      return reason ? `بدأت نافذة الصيانة: ${reason}` : 'بدأت نافذة صيانة مجدولة';
    }

    case 'maintenance_ended': {
      const reason = str(d.reason);
      return reason ? `انتهت نافذة الصيانة: ${reason}` : 'انتهت نافذة الصيانة المجدولة';
    }

    case 'rogue_dhcp_server': {
      const ip = str(d.server_id) ?? str(d.ip);
      return ip ? `تم رصد خادم DHCP غير مصرّح: ${ltr(ip)}` : 'تم رصد خادم DHCP غير مصرّح';
    }

    case 'rogue_dhcp_cleared':
      return 'اختفى خادم DHCP غير المصرّح';

    case 'dhcp_no_offer':
      return 'لا يوجد خادم DHCP يرد على الشبكة';

    case 'dhcp_offer_restored':
      return 'عادت استجابة خادم DHCP على الشبكة';

    case 'upnp_risky_mapping': {
      const port = d.external_port ?? d.port;
      return port ? `توجيه منفذ UPnP خطر مفتوح على المنفذ ${ltr(String(port))}` : 'تم رصد توجيه منفذ UPnP خطر';
    }

    case 'endpoint_enrolled': {
      const name = str(d.name) ?? str(d.hostname);
      return name ? `تم تسجيل الحاسوب المُدار: ${name}` : 'تم تسجيل حاسوب مُدار جديد';
    }

    case 'config_changed': {
      const target = str(d.target_name) ?? str(d.name);
      return target ? `تغيّرت إعدادات الجهاز ${target}` : 'تم رصد تغيير في إعدادات جهاز شبكي';
    }

    case 'config_backup_failed': {
      const target = str(d.target_name) ?? str(d.name);
      return target ? `فشل النسخ الاحتياطي لإعدادات ${target}` : 'فشل النسخ الاحتياطي للإعدادات';
    }

    case 'config_restored':
    case 'config_restore_failed': {
      const target = str(d.target_name);
      const ver = typeof d.version === 'number' ? d.version : null;
      const ok = ev.type === 'config_restored';
      const what = `${target ? `الجهاز ${target}` : 'الجهاز'}${ver !== null ? ` إلى الإصدار ${ltr(String(ver))}` : ''}`;
      return ok ? `استُعيدت إعدادات ${what}` : `لم تكتمل استعادة إعدادات ${what}`;
    }

    case 'config_host_key_changed': {
      const target = str(d.target_name) ?? str(d.name);
      return target ? `تغيّر مفتاح SSH للجهاز ${target}` : 'تم رصد تغيّر مفتاح SSH';
    }

    default:
      return t;
  }
}
