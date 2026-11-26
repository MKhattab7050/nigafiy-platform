// Interface text of the site, English and Arabic. Product and program names stay in Latin letters.
import type { T } from '../i18n.ts';

export const S = {
  siteName: { en: 'Nigafiy', ar: 'Nigafiy' },
  skip: { en: 'Skip to content', ar: 'انتقل إلى المحتوى' },
  navLabel: { en: 'Site', ar: 'الموقع' },
  navFooter: { en: 'More', ar: 'المزيد' },
  navPrograms: { en: 'Programs', ar: 'البرامج' },
  navDownloads: { en: 'Downloads', ar: 'التنزيلات' },
  navDocs: { en: 'Docs', ar: 'الوثائق' },
  navSecurity: { en: 'Security and privacy', ar: 'الأمان والخصوصية' },
  navChangelog: { en: 'Changelog', ar: 'سجل التغييرات' },
  navManifest: { en: 'Release manifest', ar: 'بيان الإصدارات' },
  otherLang: { en: 'العربية', ar: 'English' },
  otherLangLabel: { en: 'Read this page in Arabic', ar: 'اقرأ هذه الصفحة بالإنجليزية' },
  download: { en: 'Download', ar: 'تنزيل' },
  theme: { en: 'Theme', ar: 'المظهر' },
  themeSystem: { en: 'System', ar: 'النظام' },
  themeLight: { en: 'Light', ar: 'فاتح' },
  themeDark: { en: 'Dark', ar: 'داكن' },
  footTag: { en: 'Nigafiy · local-first, transparent, and it works things out by itself', ar: 'Nigafiy · محلي أولًا، شفاف، ويستنتج بنفسه' },
  footNoTracking: {
    en: 'This site has no cookies, analytics, trackers or third-party scripts.',
    ar: 'لا يستخدم هذا الموقع ملفات تعريف الارتباط ولا أدوات تحليل ولا متتبعات ولا نصوص برمجية من جهات خارجية.',
  },
  englishOnly: { en: 'English only', ar: 'بالإنجليزية فقط' },
  englishOnlyNote: { en: 'This page is available in English only.', ar: 'هذه الصفحة متاحة بالإنجليزية فقط.' },

  // Home
  h1: { en: 'The network and IT platform that runs on your own machines', ar: 'منصة الشبكات وتقنية المعلومات التي تعمل على أجهزتك أنت' },
  lead: {
    en: 'Find every device, understand every fault, protect the network and manage company computers. Your data stays with you, and every remote session is visible and logged.',
    ar: 'اكتشف كل جهاز، وافهم كل عطل، واحمِ الشبكة، وأدر حواسيب الشركة. تبقى بياناتك عندك، وكل جلسة عن بُعد ظاهرة ومُسجَّلة.',
  },
  ctaDownload: { en: 'Downloads', ar: 'التنزيلات' },
  ctaChoose: { en: 'Choose your programs', ar: 'اختر برامجك' },
  req: { en: 'Windows 10 and 11 · Agent for Windows, Linux, macOS and Android', ar: 'Windows 10 و11 · الوكيل لأنظمة Windows وLinux وmacOS وAndroid' },
  heroShotAlt: { en: 'Nigafiy Hub home, from the real program running with test data', ar: 'الصفحة الرئيسية في Nigafiy Hub، من البرنامج الحقيقي وهو يعمل ببيانات اختبار' },
  familyH: { en: 'A family of programs, one engine', ar: 'عائلة برامج، محرك واحد' },
  familySub: {
    en: 'Each program does one job well. They all share the same data and the same sign-in.',
    ar: 'كل برنامج يقوم بمهمة واحدة جيدًا، وكلها تتشارك البيانات وتسجيل الدخول نفسه.',
  },
  companionsH: { en: 'On other machines', ar: 'على أجهزة أخرى' },
  companionsSub: {
    en: 'The Agent runs on the computers and phones Fleet manages; a Sensor runs at each site.',
    ar: 'يعمل الوكيل على الحواسيب والهواتف التي يديرها Fleet، ويعمل مستشعر في كل موقع.',
  },
  bundleH: { en: 'Build your bundle', ar: 'ابنِ حزمتك' },
  bundleSub: {
    en: 'Tick the programs you need. One Hub installer installs exactly those, and you can add more later with Modify in Apps & features.',
    ar: 'اختر البرامج التي تحتاجها. مثبّت Hub واحد يثبّتها بالضبط، ويمكنك إضافة المزيد لاحقًا عبر «تعديل» في التطبيقات والميزات.',
  },
  bundleOpen: { en: 'Open the bundle picker', ar: 'افتح منتقي الحزمة' },
  noAiH: { en: 'No AI anywhere', ar: 'لا ذكاء اصطناعي في أي مكان' },
  noAi: {
    en: 'Diagnoses, insights and playbooks are deterministic rules. Each one shows its evidence, so you can check it yourself.',
    ar: 'التشخيصات والملاحظات والإجراءات قواعد ثابتة. كل منها يبيّن أدلته، فتستطيع التحقق منها بنفسك.',
  },
  honestH: { en: 'What has run on real hardware', ar: 'ما جرى على عتاد حقيقي' },
  honest: {
    en: 'Each program page says what has been seen working on a real network and what has only run in tests.',
    ar: 'تبيّن صفحة كل برنامج ما شوهد يعمل على شبكة حقيقية وما لم يجرِ إلا في الاختبارات.',
  },

  // Program pages
  whatItDoes: { en: 'What it does', ar: 'ماذا يفعل' },
  whatItNeeds: { en: 'What it needs', ar: 'ماذا يحتاج' },
  notVerifiedH: { en: 'Not verified on real hardware', ar: 'لم يُتحقق منه على عتاد حقيقي' },
  allVerified: {
    en: 'Nothing on this program is listed as tests-only in the project status.',
    ar: 'لا شيء في هذا البرنامج مُدرج في حالة المشروع على أنه في الاختبارات فقط.',
  },
  screenshotsH: { en: 'Screenshots', ar: 'لقطات الشاشة' },
  screenshotsNote: {
    en: 'Captured from the real program running against a test database (the same seeded records the browser tests use).',
    ar: 'التُقطت من البرنامج الحقيقي وهو يعمل مع قاعدة بيانات اختبار (السجلات نفسها التي تستخدمها اختبارات المتصفح).',
  },
  noScreenshots: {
    en: 'No screenshot has been captured for this page yet (pnpm --filter @nigafiy/site screenshots).',
    ar: 'لم تُلتقط لقطة شاشة لهذه الصفحة بعد (pnpm --filter @nigafiy/site screenshots).',
  },
  moreDocs: { en: 'More in the docs', ar: 'المزيد في الوثائق' },
  getIt: { en: 'Get it', ar: 'احصل عليه' },
  programsH: { en: 'Programs', ar: 'البرامج' },

  // Downloads
  downloadsH: { en: 'Downloads', ar: 'التنزيلات' },
  downloadsLead: {
    en: 'Every file lists its version, size and SHA-256. The list is read from the release file when the site is built.',
    ar: 'لكل ملف رقم إصدار وحجم وبصمة SHA-256. تُقرأ القائمة من ملف الإصدار عند بناء الموقع.',
  },
  notReleasedBanner: {
    en: 'No release of Nigafiy has been published yet, so there is nothing to download here today.',
    ar: 'لم يُنشر أي إصدار من Nigafiy بعد، لذلك لا يوجد شيء للتنزيل هنا اليوم.',
  },
  notReleased: { en: 'Not released yet', ar: 'لم يُصدر بعد' },
  releaseLine: { en: 'Release', ar: 'الإصدار' },
  releasedAt: { en: 'Published', ar: 'تاريخ النشر' },
  colFile: { en: 'File', ar: 'الملف' },
  colVersion: { en: 'Version', ar: 'الإصدار' },
  colSize: { en: 'Size', ar: 'الحجم' },
  colSha: { en: 'SHA-256', ar: 'SHA-256' },
  bundleGroup: { en: 'Nigafiy Hub with its programs (the full bundle)', ar: 'Nigafiy Hub مع برامجه (الحزمة الكاملة)' },
  bundleGroupNote: {
    en: 'The full bundle is one installer with every program; there is no separate file per program. Each program below says how to install it on its own.',
    ar: 'الحزمة الكاملة مثبّت واحد يضم كل البرامج؛ ولا يوجد ملف مستقل لكل برنامج. يبيّن كل برنامج أدناه كيف يُثبَّت وحده.',
  },
  perProgramH: { en: 'Each program', ar: 'كل برنامج' },
  perProgramVia: { en: 'Installed by the Hub installer with', ar: 'يثبّته مثبّت Hub مع' },
  agentGroup: { en: 'Nigafiy Agent', ar: 'Nigafiy Agent' },
  sensorGroup: { en: 'Nigafiy Sensor', ar: 'Nigafiy Sensor' },
  storeH: { en: 'Microsoft Store', ar: 'Microsoft Store' },
  storeText: {
    en: 'Coming: Nigafiy and Nigafiy Quick Support as Store packages, so Windows shows no “Unknown publisher” warning. Not published yet.',
    ar: 'قريبًا: Nigafiy وNigafiy Quick Support كحزم في المتجر، فلا يُظهر Windows تحذير «ناشر غير معروف». لم يُنشر بعد.',
  },
  warnH: { en: 'If Windows warns you', ar: 'إن حذّرك Windows' },
  warnLead: {
    en: 'The setup program is not signed with a certificate Windows already trusts, so Windows warns before it runs. The warning does not mean the file is harmful; it means Windows cannot tell who published it. Run it only if you downloaded it from this page, and check its SHA-256 below if you want to be sure it was not changed.',
    ar: 'برنامج الإعداد غير موقّع بشهادة يثق بها Windows مسبقًا، لذلك يحذّر Windows قبل تشغيله. ولا يعني التحذير أن الملف ضار؛ بل يعني أن Windows لا يعرف من نشره. شغّله فقط إن كنت نزّلته من هذه الصفحة، وتحقّق من بصمة SHA-256 أدناه إن أردت التأكد من أنه لم يتغيّر.',
  },
  warnSmartScreenH: { en: '“Windows protected your PC”', ar: '«حمى Windows جهاز الكمبيوتر»' },
  warnSmartScreen1: { en: 'Choose More info (1).', ar: 'اختر «مزيد من المعلومات» (1).' },
  warnSmartScreen2: {
    en: 'Check that the app is the Nigafiy setup program you downloaded.',
    ar: 'تأكد أن التطبيق هو برنامج إعداد Nigafiy الذي نزّلته.',
  },
  warnSmartScreen3: { en: 'Choose Run anyway (2).', ar: 'اختر «تشغيل على أي حال» (2).' },
  warnSmartScreenAlt: {
    en: 'Drawing of the blue SmartScreen window: first with the More info link (1), then with the app name, “Unknown publisher” and the Run anyway button (2).',
    ar: 'رسم لنافذة SmartScreen الزرقاء: أولًا مع رابط «مزيد من المعلومات» (1)، ثم مع اسم التطبيق و«ناشر غير معروف» وزر «تشغيل على أي حال» (2).',
  },
  warnUacH: { en: '“Unknown publisher”', ar: '«ناشر غير معروف»' },
  warnUacText: {
    en: 'Windows then asks whether this app may make changes to your device. Choose Yes (3) to install. Choose No if you did not download the file from this page yourself.',
    ar: 'ثم يسأل Windows هل يُسمح لهذا التطبيق بإجراء تغييرات على جهازك. اختر «نعم» (3) للتثبيت. واختر «لا» إن لم تكن نزّلت الملف من هذه الصفحة بنفسك.',
  },
  warnUacAlt: {
    en: 'Drawing of the User Account Control window asking whether an app from an unknown publisher may make changes, with the Yes button marked (3).',
    ar: 'رسم لنافذة التحكم في حساب المستخدم تسأل هل يُسمح لتطبيق من ناشر غير معروف بإجراء تغييرات، مع تحديد زر «نعم» (3).',
  },
  warnNote: {
    en: 'These are simplified drawings; the words can differ slightly between Windows versions. If your organization deploys its own certificate by Group Policy, or once Nigafiy is in the Microsoft Store, these warnings do not appear.',
    ar: 'هذه رسوم مبسّطة؛ وقد تختلف الكلمات قليلًا بين إصدارات Windows. وإن كانت مؤسستك توزّع شهادتها الخاصة عبر Group Policy، أو عندما يصبح Nigafiy في Microsoft Store، فلا تظهر هذه التحذيرات.',
  },
  verifySums: {
    en: 'Every release also comes with a SHA256SUMS file next to the installers, listing the SHA-256 of each file.',
    ar: 'ويأتي كل إصدار أيضًا بملف SHA256SUMS بجانب ملفات التثبيت، فيه بصمة SHA-256 لكل ملف.',
  },
  startHereLink: { en: 'New to Nigafiy? Start here: install, first scan, alerts on your phone.', ar: 'جديد على Nigafiy؟ ابدأ من هنا: التثبيت، وأول مسح، والتنبيهات على هاتفك.' },
  verifyH: { en: 'Check a download', ar: 'تحقّق من ملف التنزيل' },
  verifyText: {
    en: 'Compare the SHA-256 above with the one Windows computes for the file you downloaded:',
    ar: 'قارن بصمة SHA-256 أعلاه بالبصمة التي يحسبها Windows للملف الذي نزّلته:',
  },
  pickerH: { en: 'Build your bundle', ar: 'ابنِ حزمتك' },
  pickerLead: {
    en: 'Tick the programs this computer should offer. The Hub installer has a “Choose programs” page and a PROGRAMS option for silent installs; it does not build a separate file per choice. Here is exactly what installs your choice:',
    ar: 'اختر البرامج التي يجب أن يوفرها هذا الحاسوب. في مثبّت Hub صفحة «اختر البرامج» وخيار PROGRAMS للتثبيت الصامت، ولا يبني ملفًا مستقلًا لكل اختيار. هذا بالضبط ما يثبّت اختيارك:',
  },
  pickerLegend: { en: 'Programs', ar: 'البرامج' },
  alwaysIncluded: { en: 'always included', ar: 'مضمَّن دائمًا' },
  pickerInteractive: { en: 'In the installer', ar: 'في المثبّت' },
  pickerInteractiveText: {
    en: 'On the “Choose programs” page, tick:',
    ar: 'في صفحة «اختر البرامج»، اختر:',
  },
  pickerSilent: { en: 'Silent install for one user (NSIS installer)', ar: 'تثبيت صامت لمستخدم واحد (مثبّت NSIS)' },
  pickerMsi: { en: 'Group Policy or Intune (MSI, per machine)', ar: 'Group Policy أو Intune (MSI، لكل الجهاز)' },
  pickerAll: { en: 'every program', ar: 'كل البرامج' },
  pickerHubOnly: { en: 'Hub only', ar: 'Hub فقط' },
  pickerCopy: { en: 'Copy', ar: 'نسخ' },
  pickerCopied: { en: 'Copied', ar: 'تم النسخ' },
  pickerGet: { en: 'Download the Hub installer', ar: 'تنزيل مثبّت Hub' },
  pickerNotReleased: {
    en: 'The Hub installer is not released yet; the commands above are what will install your choice once it is.',
    ar: 'مثبّت Hub لم يُصدر بعد؛ الأوامر أعلاه هي ما سيثبّت اختيارك عند صدوره.',
  },
  pickerVersionPlaceholder: { en: '<version>', ar: '<version>' },
  pickerLater: {
    en: 'Change it later: Apps & features → Nigafiy → Modify. A program you leave out keeps collecting its data; only its screens are not offered.',
    ar: 'لتغييره لاحقًا: التطبيقات والميزات ← Nigafiy ← تعديل. البرنامج الذي تستبعده يستمر في جمع بياناته؛ فقط شاشاته لا تُعرض.',
  },

  // Docs
  docsH: { en: 'Documentation', ar: 'الوثائق' },
  docsLead: {
    en: 'Generated from the docs folder of the Nigafiy repository when the site is built.',
    ar: 'مولَّدة من مجلد الوثائق في مستودع Nigafiy عند بناء الموقع.',
  },
  docsLeadAr: {
    en: '',
    ar: 'دليل الاستخدام متاح بالعربية. بقية الوثائق التقنية بالإنجليزية فقط، وهي معلَّمة بذلك.',
  },
  docsNav: { en: 'Documentation', ar: 'الوثائق' },
  docsSearch: { en: 'Search the docs', ar: 'ابحث في الوثائق' },
  docsSearchHint: { en: 'Type at least two letters', ar: 'اكتب حرفين على الأقل' },
  docsNoResults: { en: 'Nothing found.', ar: 'لا نتائج.' },
  docsResults: { en: 'results', ar: 'نتيجة' },
  docsSource: { en: 'Source', ar: 'المصدر' },
  groupGuide: { en: 'User guide', ar: 'دليل الاستخدام' },
  groupStart: { en: 'Getting started', ar: 'البداية' },
  groupFeatures: { en: 'Features', ar: 'الميزات' },
  groupOperations: { en: 'Operations', ar: 'التشغيل' },
  groupSecurity: { en: 'Security', ar: 'الأمان' },
  onThisPage: { en: 'On this page', ar: 'في هذه الصفحة' },
  inAppLink: { en: 'In the program:', ar: 'في البرنامج:' },

  // Changelog
  changelogH: { en: 'Changelog', ar: 'سجل التغييرات' },
  changelogSource: {
    en: 'Source: the git history of the Nigafiy repository (commit subjects, merge commits left out), generated by pnpm --filter @nigafiy/site changelog.',
    ar: 'المصدر: سجل git لمستودع Nigafiy (عناوين الالتزامات، دون التزامات الدمج)، مولَّد بالأمر pnpm --filter @nigafiy/site changelog.',
  },
  changelogBranch: { en: 'Branch and last commit', ar: 'الفرع وآخر التزام' },
  changelogCount: { en: 'commits', ar: 'التزامًا' },

  // Security
  securityH: { en: 'Security and privacy', ar: 'الأمان والخصوصية' },
  securityLead: {
    en: 'Nigafiy runs on your machines and keeps your data there. This page is the project’s security model, generated from docs/security/model.md.',
    ar: 'يعمل Nigafiy على أجهزتك ويُبقي بياناتك عندها. هذه الصفحة هي نموذج الأمان للمشروع، مولَّدة من docs/security/model.md.',
  },
  privacyH: { en: 'Privacy in short', ar: 'الخصوصية باختصار' },
  privacy: [
    {
      en: 'No cloud console, no outside accounts: the engine and the database run on your own computer or server.',
      ar: 'لا لوحة تحكم سحابية ولا حسابات خارجية: المحرك وقاعدة البيانات يعملان على حاسوبك أو خادمك.',
    },
    {
      en: 'Nothing is sent to the makers of Nigafiy. The update check fetches only a signed manifest from the address you configure, and is off until you set one.',
      ar: 'لا يُرسل شيء إلى صانعي Nigafiy. التحقق من التحديثات يجلب فقط بيانًا موقّعًا من العنوان الذي تضبطه، وهو متوقف حتى تضبطه.',
    },
    {
      en: 'No hidden monitoring: remote desktop asks for consent where the policy says so, always shows a session bar with End, and every action is in the audit log.',
      ar: 'لا مراقبة خفية: سطح المكتب البعيد يطلب الموافقة حيث تقتضي السياسة، ويُظهر دائمًا شريط جلسة فيه «إنهاء»، وكل إجراء في سجل التدقيق.',
    },
    {
      en: 'No packet contents are captured, and the Sensor works only inside address ranges an administrator authorized.',
      ar: 'لا يُلتقط محتوى الحزم، ويعمل المستشعر داخل نطاقات العناوين التي أذن بها مسؤول فقط.',
    },
  ] as readonly T[],
  reportH: { en: 'Report a vulnerability', ar: 'الإبلاغ عن ثغرة' },
  report: {
    en: 'How to report one is in SECURITY.md at the root of the repository.',
    ar: 'طريقة الإبلاغ موضّحة في الملف SECURITY.md في جذر المستودع.',
  },

  // Manifest
  manifestH: { en: 'Release manifest', ar: 'بيان الإصدارات' },
  manifestLead: {
    en: 'How Nigafiy Hub decides that an update is genuine before anything is installed.',
    ar: 'كيف يتأكد Nigafiy Hub من أن التحديث أصلي قبل تثبيت أي شيء.',
  },
  manifestSteps: [
    {
      en: 'Each release has a manifest.json: a payload (version, and for each file its address, size and SHA-256) and an Ed25519 signature of exactly those bytes.',
      ar: 'لكل إصدار ملف manifest.json: حمولة (رقم الإصدار، ولكل ملف عنوانه وحجمه وبصمة SHA-256) وتوقيع Ed25519 لتلك البايتات بالضبط.',
    },
    {
      en: 'Each installation is configured with the release public key (NIGAFIY_UPDATE_PUBLIC_KEY). A manifest whose signature does not verify with that key is refused.',
      ar: 'تُضبط كل نسخة مثبّتة بالمفتاح العام للإصدار (NIGAFIY_UPDATE_PUBLIC_KEY). ويُرفض أي بيان لا يتحقق توقيعه بهذا المفتاح.',
    },
    {
      en: 'The installer is downloaded over HTTPS only, stopped at the manifest’s size, and its SHA-256 must match the manifest. With a publisher thumbprint set, its Authenticode signature must come from exactly that certificate.',
      ar: 'يُنزَّل المثبّت عبر HTTPS فقط، ويُوقف عند الحجم المذكور في البيان، ويجب أن تطابق بصمة SHA-256 ما في البيان. وعند ضبط بصمة الناشر يجب أن يكون توقيع Authenticode من تلك الشهادة بالضبط.',
    },
    {
      en: 'Nothing installs until an owner or administrator confirms. The engine and its update helper check the hash and the publisher again before running the installer.',
      ar: 'لا يُثبَّت شيء حتى يؤكد مالك أو مسؤول. ويتحقق المحرك ومساعد التحديث من البصمة والناشر مرة أخرى قبل تشغيل المثبّت.',
    },
  ] as readonly T[],
  manifestFileH: { en: 'The manifest file', ar: 'ملف البيان' },
  manifestNone: {
    en: 'No manifest has been published yet: no release exists, and the download host is not decided.',
    ar: 'لم يُنشر أي بيان بعد: لا يوجد إصدار، ولم يُحدَّد مكان استضافة التنزيلات.',
  },
  manifestLink: { en: 'The current manifest', ar: 'البيان الحالي' },
  manifestFormatH: { en: 'Format', ar: 'الصيغة' },
  manifestNotVerified: {
    en: 'Not yet run end to end: no installer has been run over a real installation by the update helper, and no release has been built signed.',
    ar: 'لم يجرِ من البداية إلى النهاية بعد: لم يشغّل مساعد التحديث أي مثبّت فوق نسخة مثبّتة حقيقية، ولم يُبنَ أي إصدار موقّع.',
  },
  moreDetail: { en: 'Full details', ar: 'التفاصيل الكاملة' },

  // 404 and root
  notFoundH: { en: 'Page not found', ar: 'الصفحة غير موجودة' },
  notFoundText: { en: 'There is no page at this address.', ar: 'لا توجد صفحة على هذا العنوان.' },
  goHome: { en: 'Go to the home page', ar: 'اذهب إلى الصفحة الرئيسية' },
  chooseLang: { en: 'Choose a language', ar: 'اختر اللغة' },
} as const satisfies Record<string, T | readonly T[]>;
