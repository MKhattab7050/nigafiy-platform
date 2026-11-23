import type { Insight, InsightAction } from '@nigafiy/shared-types';
import type { Locale } from '@/lib/i18n';

/**
 * Arabic wording for insights. The API sends English text plus a stable `code` and `params`;
 * other locales are rendered from these templates, falling back to the API's English.
 */
type Template = { title: string; detail: string };

const AR: Record<string, Template> = {
  no_collector: { title: 'لا شيء يراقب شبكتك بعد', detail: 'أضف مجمِّعًا وصرّح بنطاق شبكتك لبدء اكتشاف الأجهزة.' },
  no_scope: { title: 'لا يوجد نطاق شبكة مصرَّح بمسحه', detail: 'أضف مجمِّعًا وصرّح بنطاق شبكتك لبدء اكتشاف الأجهزة.' },
  collector_silent: { title: 'المراقبة متوقفة: المجمِّع "{name}" لا يرسل', detail: 'حالات الأجهزة المعروضة هي آخر حالة معروفة. تأكد أن الكمبيوتر الذي يشغّل المجمِّع يعمل ومتصل.' },
  unwanted_online: {
    title: 'جهاز غير مرغوب فيه متصل بشبكتك: {device}',
    detail: 'أنت علّمت هذا الجهاز كغير مرغوب فيه. لإزالته احظر عنوان MAC الخاص به من إعدادات الراوتر، وغيّر كلمة مرور الواي فاي إن كنت لا تعرف صاحبه.',
  },
  unwanted_blockable: {
    title: 'حظر {device} على الراوتر {router}؟',
    detail: 'أنت علّمت هذا الجهاز كغير مرغوب فيه وهو متصل الآن. يستطيع الراوتر حظره. Nigafiy لا ينفّذ ذلك تلقائيًا بل ينتظر قرارك.',
  },
  unreviewed: { title: '{count} جهاز في انتظار مراجعتك', detail: 'علّم الأجهزة التي تعرفها كـ"معروف"، وبعدها ستُنبَّه فقط عن الأجهزة الجديدة عليك.' },
  ip_conflict: {
    title: '{count} عنوان IP انتقل لجهاز آخر خلال 24 ساعة',
    detail: 'غالبًا أمر عادي (الراوتر أعاد استخدام العنوان، أو هاتف بعنوان MAC خاص). وقد يعني تعارضًا في العناوين أو جهازًا ينتحل جهازًا آخر. قارن الأجهزة المعنية.',
  },
  path_gateway_down: { title: 'الراوتر لا يستجيب', detail: 'طبيب الشبكة يقارن كل القياسات ليحدد مكان المشكلة: شبكتك، الراوتر، أم مزوّد الخدمة.' },
  path_gateway_degraded: { title: 'الراوتر يستجيب بشكل ضعيف', detail: 'طبيب الشبكة يقارن كل القياسات ليحدد مكان المشكلة: شبكتك، الراوتر، أم مزوّد الخدمة.' },
  path_internet_down: { title: 'الإنترنت مقطوع', detail: 'طبيب الشبكة يقارن كل القياسات ليحدد مكان المشكلة: شبكتك، الراوتر، أم مزوّد الخدمة.' },
  path_internet_degraded: { title: 'اتصال الإنترنت ضعيف', detail: 'طبيب الشبكة يقارن كل القياسات ليحدد مكان المشكلة: شبكتك، الراوتر، أم مزوّد الخدمة.' },
  path_dns_down: { title: 'ترجمة الأسماء (DNS) لا تعمل', detail: 'طبيب الشبكة يقارن كل القياسات ليحدد مكان المشكلة: شبكتك، الراوتر، أم مزوّد الخدمة.' },
  path_dns_degraded: { title: 'ترجمة الأسماء (DNS) بطيئة أو غير مستقرة', detail: 'طبيب الشبكة يقارن كل القياسات ليحدد مكان المشكلة: شبكتك، الراوتر، أم مزوّد الخدمة.' },
  slow_internet: { title: 'زمن استجابة الإنترنت مرتفع ({ms} ms)', detail: 'تتأثر به مكالمات الفيديو والألعاب. السبب غالبًا تنزيلات كبيرة على الشبكة أو مزوّد الخدمة.' },
  critical_offline: { title: '{device} غير متصل', detail: 'علّمت هذا الجهاز كمهم، وقد توقف عن الرد على الشبكة.' },
  open_incidents: { title: '{count} حادثة مفتوحة', detail: 'الأهم: {top}' },
  suggest_monitor: { title: 'راقب {device} عن قرب', detail: 'الجهاز مُعلَّم كمهم لكنه يُفحص فقط أثناء مسح الاكتشاف. فحص ping يقيسه كل دقيقة ويسجل زمن الاستجابة.' },
  nameless_phones: {
    title: '{count} هاتف أو جهاز لوحي بدون اسم',
    detail: 'تستخدم عناوين واي فاي خاصة ولا تعلن عن نفسها. اقفل الواي فاي وافتحه على الهاتف: يتعرف LAN Detective على اسمه عند إعادة الاتصال.',
  },
  new_today: { title: '{count} جهاز انضم اليوم', detail: '{names}' },
  access_not_running: { title: 'التحكم في الوصول مفعّل لكنه لا يعمل', detail: 'المُجمِّع لم يستطع تشغيل فلتر DNS، فلا تُطبَّق أي قواعد.' },
  access_no_devices: { title: 'لا يوجد جهاز يستخدم LAN Detective كـ DNS بعد', detail: 'اجعل خادم DNS في إعدادات DHCP بالراوتر {ip} حتى تصل القواعد للأجهزة، ثم أعد توصيلها بالـ Wi-Fi.' },
  access_partial: { title: '{protected} من {online} جهاز متصل يستخدم الفلتر', detail: 'الباقي لم يطلب أي اسم من LAN Detective مؤخرًا: ربما يستخدم DNS خاصًا (Private DNS أو VPN) أو لم يجدد عنوانه بعد.' },
  adult_attempts: { title: 'تم حظر محتوى للبالغين خلال آخر 24 ساعة', detail: '{names}' },
  bypass_attempts: { title: 'بعض الأجهزة حاولت استخدام DNS مشفّر خاص بها', detail: 'تم حظره لتعود لقواعد الشبكة. لو تكرر، اقفل "Private DNS" على الجهاز: {names}' },
  switch_unreadable: { title: 'السويتش {name} لا يرد على SNMP', detail: 'معلومات المنافذ الخاصة به هي آخر قراءة ناجحة. تأكد أن SNMP مفعّل عليه وأن بيانات الدخول صحيحة.' },
  port_errors: { title: '{count} منفذ سويتش يسجل أخطاء', detail: 'زيادة عدادات الأخطاء تعني غالبًا كابلًا تالفًا أو منفذًا معطوبًا أو عدم توافق duplex. الجهاز الموصل هناك سيكون بطيئًا أو ينقطع: {ports}' },
  suggest_monitor_infrastructure: {
    title: 'راقب {count} من أجهزة البنية التحتية باستمرار',
    detail: 'تبدو هذه الأجهزة موجّهات أو طابعات أو أجهزة تخزين أو كاميرات أو نقاط وصول أو خوادم. تُفحص فقط أثناء مسح الاكتشاف؛ فحص ping يقيس كل واحد منها كل دقيقة. نوعها استُنتج تلقائيًا: راجعه قبل أن توافق.',
  },
  certificate_expiring: {
    title: '{count} شهادة منتهية الصلاحية أو تنتهي خلال 30 يومًا',
    detail: 'العملاء الذين يتحققون من الشهادات سيرفضون هذه الخدمات عند انتهاء الشهادة. جدّدها وثبّت الشهادة الجديدة قبل ذلك.',
  },
  watch_refused: {
    title: '{count} فحص لا يمكن تشغيله: الهدف غير مسموح به',
    detail: 'يرفض المجمِّع الاتصال بعناوين خارج النطاقات المصرَّح بها للموقع، وبالمضيفات العامة ما لم يسمح الفحص بها. لا يُرسَل أي شيء إلى هذه الأهداف.',
  },
  access_off: { title: 'تحكّم فيما تصل إليه الأجهزة', detail: 'احظر مواقع وتطبيقات، أوقف الإنترنت عن جهاز، أو حدد مواعيد النوم. يعمل مع أي راوتر.' },
};

const AR_ACTIONS: Record<string, string> = {
  open_access: 'التحكم في الوصول',
  open_ports: 'كاشف المنافذ',
  see_activity: 'عرض النشاط',
  open_collectors: 'إعداد الاكتشاف',
  open_device: 'فتح الجهاز',
  open_router: 'فتح إعدادات الراوتر',
  review: 'مراجعة الأجهزة',
  mark_all_known: 'علّمها كلها كمعروفة',
  open_events: 'عرض الأحداث',
  open_doctor: 'التشخيص بطبيب الشبكة',
  open_monitoring: 'عرض السجل',
  open_incidents: 'فتح الحوادث',
  monitor: 'راقبه',
  monitor_all: 'راقبها',
  block_on_router: 'احظره من الراوتر',
};

const AR_CONFIRM: Record<string, string> = {
  mark_all_known: 'هل تريد تعليم كل الأجهزة غير المراجَعة كمعروفة؟ افعل ذلك فقط إن كنت تعرفها كلها.',
  monitor_all: 'إنشاء فحص ping لكل جهاز من هذه الأجهزة؟',
  block_on_router: 'هل تريد حظر هذا الجهاز مباشرةً من الراوتر؟',
};

const fill = (s: string, params: Insight['params']) => s.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m));

export function insightText(i: Insight, locale: Locale): Template {
  const tpl = locale === 'ar' ? AR[i.code] : undefined;
  return tpl ? { title: fill(tpl.title, i.params), detail: fill(tpl.detail, i.params) } : { title: i.title, detail: i.detail };
}

export function actionText(a: InsightAction, locale: Locale): { label: string; confirm?: string } {
  if (locale !== 'ar') return { label: a.label, confirm: a.confirm };
  return { label: AR_ACTIONS[a.code] ?? a.label, confirm: a.confirm ? (AR_CONFIRM[a.code] ?? a.confirm) : undefined };
}
