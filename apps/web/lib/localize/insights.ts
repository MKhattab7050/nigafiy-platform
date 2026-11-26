import type { Locale } from '@/lib/i18n';
import { ltr } from './bidi';

/** Localizes health score deduction reasons (`InsightsReport.score_breakdown`) into native Arabic. */
export function localizeDeductionReason(item: { code: string; reason: string }, locale: Locale): string {
  if (locale !== 'ar') return item.reason;
  const { code, reason } = item;

  if (code === 'setup') return 'لم يُعَدّ الاكتشاف بعد';
  if (code === 'ip_conflict') return 'عناوين IP انتقلت بين أجهزة';
  if (code === 'slow_internet') return 'زمن استجابة الإنترنت مرتفع';
  if (code === 'open_incidents') return 'حوادث مفتوحة';
  if (code === 'port_errors') return 'منافذ سويتش تسجّل أخطاء';
  if (code === 'access_not_running') return 'التحكم في الوصول لا يعمل';
  if (code === 'access_no_devices') return 'قواعد الوصول لا تصل لأي جهاز';
  if (code === 'certificate_expiring') return 'شهادات تنتهي صلاحيتها';
  if (code === 'watch_refused') return 'فحوصات رُفضت بقاعدة النطاق';

  if (code === 'collector_silent') {
    const m = reason.match(/^Collector (.+) is not reporting$/);
    return m ? `المستشعر «${m[1]}» لا يرسل تقارير` : 'مستشعر لا يرسل تقارير';
  }
  if (code === 'unwanted_online') {
    const m = reason.match(/^(\d+)/);
    return m ? `${ltr(m[1]!)} جهاز غير مرغوب فيه متصل` : 'أجهزة غير مرغوب فيها متصلة';
  }
  if (code === 'unreviewed') {
    const m = reason.match(/^(\d+)/);
    return m ? `${ltr(m[1]!)} جهاز بانتظار المراجعة` : 'أجهزة بانتظار المراجعة';
  }
  if (code === 'critical_offline') {
    const m = reason.match(/^(\d+)/);
    return m ? `${ltr(m[1]!)} جهاز مهم غير متصل` : 'أجهزة مهمة غير متصلة';
  }
  if (code === 'switch_unreadable') {
    const m = reason.match(/^Switch (.+) unreadable$/);
    return m ? `تعذّرت قراءة السويتش ${m[1]}` : 'تعذّرت قراءة سويتش';
  }
  if (code === 'path_gateway') return reason.includes('down') ? 'الراوتر لا يستجيب' : 'أداء الراوتر متراجع';
  if (code === 'path_internet') return reason.includes('down') ? 'الإنترنت مقطوع' : 'جودة الإنترنت متراجعة';
  if (code === 'path_dns') return reason.includes('down') ? 'فشل ترجمة الأسماء (DNS)' : 'بطء ترجمة الأسماء (DNS)';

  return reason;
}

const AR_TIME = (unit: string) => (unit === 'min' ? 'د' : unit === 'h' ? 'س' : unit === 'd' ? 'ي' : unit);

/** Localizes individual evidence bullets produced by `insights/rules.ts` into native Arabic. */
export function localizeInsightEvidence(line: string, locale: Locale): string {
  if (locale !== 'ar') return line;

  const exact: Record<string, string> = {
    'Never reported': 'لم يرسل أي تقرير بعد',
    'Marked unwanted by you': 'مُعلَّم كغير مرغوب فيه بواسطتك',
    'None joined in the last 24 hours': 'لم ينضم أي جهاز خلال آخر 24 ساعة',
    'Marked important': 'مُعلَّم كجهاز مهم',
    'No monitoring check': 'لا يوجد له فحص مراقبة مستمر',
    'The last read failed': 'فشلت آخر قراءة',
    'The collector reports it is not listening for DNS': 'يُفيد المستشعر أنه لا يستمع لطلبات DNS',
    'No DNS questions arrived from any device in the last 30 minutes': 'لم تصل أي طلبات DNS من أي جهاز خلال آخر 30 دقيقة',
    'Access control is off for this network': 'التحكم في الوصول متوقف لهذه الشبكة',
  };
  if (exact[line]) return exact[line]!;

  let m = line.match(/^(\d+) collector\(s\), (\d+) authorized range\(s\)$/);
  if (m) return `${ltr(m[1]!)} مستشعر، و${ltr(m[2]!)} نطاق مصرَّح به`;

  m = line.match(/^Last heartbeat (\d+) (min|h|d) ago$/);
  if (m) return `آخر نبض اتصال منذ ${ltr(`${m[1]} ${AR_TIME(m[2]!)}`)}`;

  m = line.match(/^Answered the last sweep at (.+)$/);
  if (m) return `استجاب لآخر مسح على العنوان ${m[1] === 'unknown address' ? 'عنوان غير معروف' : ltr(m[1]!)}`;

  m = line.match(/^Online at (.+)$/);
  if (m) return `متصل الآن على العنوان ${m[1] === 'unknown address' ? 'عنوان غير معروف' : ltr(m[1]!)}`;

  m = line.match(/^(.+) supports blocking devices$/);
  if (m) return `الراوتر ${m[1]} يدعم حظر الأجهزة`;

  m = line.match(/^(\d+) joined in the last 24 hours$/);
  if (m) return `انضم ${ltr(m[1]!)} جهازًا خلال آخر 24 ساعة`;

  m = line.match(/^([0-9.]+) was answered by a different MAC address$/);
  if (m) return `العنوان ${ltr(m[1]!)} ردّ عليه عنوان MAC مختلف`;

  m = line.match(/^Last seen (\d+) (min|h|d) ago(?: at ([0-9.]+))?$/);
  if (m) return `آخر ظهور منذ ${ltr(`${m[1]} ${AR_TIME(m[2]!)}`)}${m[3] ? ` على العنوان ${ltr(m[3])}` : ''}`;

  m = line.match(/^(\d+) online devices with a private \(randomized\) MAC and no announced name$/);
  if (m) return `${ltr(m[1]!)} جهازًا متصلًا بعنوان MAC عشوائي خاص وبدون اسم مُعلَن`;

  m = line.match(/^(\d+) devices sent DNS questions in the last 30 minutes$/);
  if (m) return `${ltr(m[1]!)} جهازًا أرسلت طلبات DNS خلال آخر 30 دقيقة`;

  m = line.match(/^(.+): (\d+) blocked request\(s\)$/);
  if (m) return `${m[1]}: ${ltr(m[2]!)} طلب محظور`;

  m = line.match(/^(.+): (\d+) attempt\(s\)$/);
  if (m) return `${m[1]}: ${ltr(m[2]!)} محاولة تخطّي`;

  m = line.match(/^(.+): (\d+) new error\(s\) in (\d+) min$/);
  if (m) return `${m[1]}: ${ltr(m[2]!)} خطأ جديد خلال ${ltr(m[3]!)} د`;

  m = line.match(/^(.+): expires in (\d+) day\(s\)$/);
  if (m) return `${m[1]}: تنتهي بعد ${ltr(m[2]!)} يوم`;

  m = line.match(/^(.+): expired (\d+) day\(s\) ago$/);
  if (m) return `${m[1]}: انتهت منذ ${ltr(m[2]!)} يوم`;

  m = line.match(/^(.+): refused: (.+)$/);
  if (m) return `${m[1]}: مرفوض: ${ltr(m[2]!)}`;

  m = line.match(/^(.+): (down|degraded)(?:, (\d+) ms)?(?:, (\d+)% loss)?$/);
  if (m) {
    const st = m[2] === 'down' ? 'متوقف' : 'متراجع';
    const extra = [m[3] && ltr(`${m[3]} ms`), m[4] && `فقد ${ltr(`${m[4]}%`)}`].filter(Boolean).join('، ');
    return `${m[1]}: ${st}${extra ? ` (${extra})` : ''}`;
  }

  return line;
}
