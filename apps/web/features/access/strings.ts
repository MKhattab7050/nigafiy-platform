/** UI strings owned by this module. The i18n core merges every module's `en` and `ar` into one typed dictionary. */
export const en = {
  'access.attn.offline': 'Access control is on, but its collector is out of contact. Protected devices may lose internet.',
  'access.attn.notListening': 'Access control is on, but filtering is not running on the collector.',
  'access.attn.check': 'Open access control',
  'access.widget.offNow': 'Devices with internet off now',
  'access.enable.title': 'Turn on access control',
  'access.enable.confirm': 'Turn on',
  'access.enable.adsMalware': 'Also block ads & malware',
  'access.enable.adsMalwareHint': 'Recommended for a first setup. Saved only when you turn access control on; you can change it any time under the network rules.',
  'access.upstreams': 'Upstream DNS servers',
  'access.upstreamsHint': 'Where the filter forwards allowed lookups. Up to 4 IPv4 addresses, one per line. Empty: the router first, then 1.1.1.1 and 8.8.8.8.',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'access.attn.offline': 'التحكم في الوصول مفعَّل، لكن مجمِّعه فقد الاتصال. قد تفقد الأجهزة المحمية الإنترنت.',
  'access.attn.notListening': 'التحكم في الوصول مفعَّل، لكن التصفية لا تعمل على المجمِّع.',
  'access.attn.check': 'افتح التحكم في الوصول',
  'access.widget.offNow': 'أجهزة مقطوع عنها الإنترنت الآن',
  'access.enable.title': 'تشغيل التحكم في الوصول',
  'access.enable.confirm': 'تشغيل',
  'access.enable.adsMalware': 'احظر أيضًا الإعلانات والبرمجيات الخبيثة',
  'access.enable.adsMalwareHint': 'مُستحسَن في الإعداد الأول. يُحفظ فقط عند تشغيل التحكم في الوصول؛ ويمكنك تغييره في أي وقت من قواعد الشبكة.',
  'access.upstreams': 'خوادم DNS الأعلى',
  'access.upstreamsHint': 'الخوادم التي يمرّر إليها الفلتر الطلبات المسموح بها. حتى 4 عناوين IPv4، كل عنوان في سطر. إن تُركت فارغة: الراوتر أولًا، ثم 1.1.1.1 و8.8.8.8.',
};
