/** UI strings owned by this module. The i18n core merges every module's `en` and `ar` into one typed dictionary. */
export const en = {
  'endpoints.nav.sessions': 'Remote sessions',
  'endpoints.widget.none': 'No computer is managed yet. Enroll one to see its health and compliance here.',
  'endpoints.widget.enroll': 'Enroll a computer',
  'endpoints.attn.nonCompliant': '{count} managed computers fail compliance.',
  'endpoints.attn.attention': '{count} managed computers need a compliance check.',
  'endpoints.attn.review': 'Review computers',
  'endpoints.enroll.loading': 'Looking up this device…',
  'endpoints.enroll.nameFromDevice': 'Taken from the network device. Change it if you like.',
  'endpoints.enroll.platformDefault': 'Nothing tells which operating system this device runs, so the default is selected. Change it if needed.',
  'endpoints.enroll.platformInferred': 'Worked out from what Nigafiy knows about the device:',
  'endpoints.enroll.existing': 'This device already has an endpoint enrolled or waiting for enrollment.',
  'endpoints.enroll.openExisting': 'Open it',
  'endpoints.install.serverFromRequest': 'The server address {url} is how your browser reached Nigafiy. If the computers reach it at another address, set PUBLIC_URL on the server and issue a new token.',
  'endpoints.install.insecure': 'The address uses plain HTTP, so the command includes -allow-insecure-http. Use HTTPS outside a trusted test network.',
} as const;

export const ar: Record<keyof typeof en, string> = {
  'endpoints.nav.sessions': 'الجلسات البعيدة',
  'endpoints.widget.none': 'لا يوجد حاسوب مُدار بعد. سجّل حاسوبًا لترى صحته وامتثاله هنا.',
  'endpoints.widget.enroll': 'سجّل حاسوبًا',
  'endpoints.attn.nonCompliant': '{count} من الحواسيب المُدارة غير ممتثلة.',
  'endpoints.attn.attention': '{count} من الحواسيب المُدارة تحتاج إلى مراجعة الامتثال.',
  'endpoints.attn.review': 'راجع الحواسيب',
  'endpoints.enroll.loading': 'جارٍ البحث عن هذا الجهاز…',
  'endpoints.enroll.nameFromDevice': 'مأخوذ من جهاز الشبكة. غيّره إن شئت.',
  'endpoints.enroll.platformDefault': 'لا شيء يدل على نظام تشغيل هذا الجهاز، لذلك اختير الافتراضي. غيّره إن لزم.',
  'endpoints.enroll.platformInferred': 'مُستنتَج مما يعرفه Nigafiy عن الجهاز:',
  'endpoints.enroll.existing': 'لهذا الجهاز بالفعل نقطة طرفية مسجَّلة أو بانتظار التسجيل.',
  'endpoints.enroll.openExisting': 'افتحها',
  'endpoints.install.serverFromRequest': 'عنوان الخادم {url} هو العنوان الذي وصل به متصفحك إلى Nigafiy. إن كانت الحواسيب تصل إليه بعنوان آخر، اضبط PUBLIC_URL على الخادم وأصدر رمزًا جديدًا.',
  'endpoints.install.insecure': 'العنوان يستخدم HTTP غير المشفّر، لذلك يتضمن الأمر ‎-allow-insecure-http. استخدم HTTPS خارج شبكة اختبار موثوقة.',
};
