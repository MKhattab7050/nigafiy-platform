// What each program does, what it needs and what has not been seen working on real hardware.
// Every feature here is one the code has today: the sources are docs/features/capabilities.md and
// the tables in docs/roadmap/status.md ("Real hardware versus tests only"). The notes under
// `unverified` repeat what status.md says has only run in tests; keep them in step with it.
import type { ProgramId } from '@nigafiy/brand';
import type { T } from '../i18n.ts';

export interface Shot {
  /** File name under public/screenshots/{en,ar}/ (written by `pnpm --filter @nigafiy/site screenshots`). */
  readonly file: string;
  readonly caption: T;
}

export interface ProgramContent {
  readonly id: ProgramId;
  /** Runs on the admin's computer (part of the Hub installer) or on other machines. */
  readonly kind: 'program' | 'companion';
  readonly job: T;
  readonly summary: T;
  readonly intro: T;
  readonly features: readonly T[];
  readonly needs: readonly T[];
  readonly unverified: readonly T[];
  readonly shots: readonly Shot[];
  /** Doc slugs (docs/<slug>.md) with more detail. */
  readonly docs: readonly string[];
}

export const PROGRAM_ORDER: readonly ProgramId[] = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'];
export const COMPANION_ORDER: readonly ProgramId[] = ['agent', 'sensor'];

const WINDOWS_HUB: T = {
  en: 'Windows 10 or 11, 64-bit. The Hub installer carries everything else: the database, the engine, the web app and its own Node.js.',
  ar: 'Windows 10 أو 11 بنظام 64 بت. مثبّت Hub يحمل كل ما عدا ذلك: قاعدة البيانات والمحرك وتطبيق الويب وNode.js الخاص به.',
};
const IN_HUB: T = {
  en: 'Comes with the Hub installer: tick it on the installer’s “Choose programs” page (or leave it out and add it later with Modify).',
  ar: 'يأتي مع مثبّت Hub: اختره في صفحة «اختر البرامج» في المثبّت (أو اتركه وأضفه لاحقًا عبر «تعديل»).',
};
const SENSOR_NEEDED: T = {
  en: 'A Sensor at the site. Hub runs one on its own computer; other sites run their own.',
  ar: 'مستشعر (Sensor) في الموقع. يشغّل Hub واحدًا على حاسوبه، وللمواقع الأخرى مستشعرها الخاص.',
};

export const PROGRAMS: Readonly<Record<ProgramId, ProgramContent>> = {
  hub: {
    id: 'hub',
    kind: 'program',
    job: { en: 'Home and engine', ar: 'الرئيسية والمحرك' },
    summary: {
      en: 'Home, engine, sign-in and updates for every program',
      ar: 'الرئيسية والمحرك وتسجيل الدخول والتحديثات لكل البرامج',
    },
    intro: {
      en: 'Hub is always installed. It runs the engine that keeps the database, the API, the web app and the local Sensor going, signs people in, and opens the other programs.',
      ar: 'يُثبَّت Hub دائمًا. يشغّل المحرك الذي يُبقي قاعدة البيانات وواجهة البرمجة وتطبيق الويب والمستشعر المحلي قيد العمل، ويسجّل دخول المستخدمين، ويفتح البرامج الأخرى.',
    },
    features: [
      {
        en: 'Overview dashboard computed from stored data only, with a hint of where a fault is (LAN, internet or DNS) and live updates.',
        ar: 'لوحة عامة تُحسب من البيانات المخزّنة فقط، مع تلميح بمكان العطل (الشبكة المحلية أو الإنترنت أو DNS) وتحديثات مباشرة.',
      },
      {
        en: 'Program switcher and a programs page that says which programs this computer has installed.',
        ar: 'مبدّل البرامج وصفحة برامج تبيّن ما المثبّت منها على هذا الحاسوب.',
      },
      {
        en: 'Global search across devices, endpoints, incidents, switches, subnets, routers and knowledge.',
        ar: 'بحث شامل في الأجهزة والحواسيب المُدارة والحوادث والسويتشات والشبكات الفرعية والراوترات والمعرفة.',
      },
      {
        en: 'Sign-in with passwords (scrypt), TOTP two-factor codes with recovery codes, and OIDC or SAML 2.0 single sign-on; roles owner, admin, technician and viewer.',
        ar: 'تسجيل الدخول بكلمات مرور (scrypt)، ورموز TOTP للتحقق بخطوتين مع رموز استرداد، والدخول الموحّد عبر OIDC أو SAML 2.0؛ والأدوار: مالك ومسؤول وفنّي ومشاهد.',
      },
      {
        en: 'System self-check: every API module and background job, with jobs that are overdue or failing.',
        ar: 'فحص ذاتي للنظام: كل وحدات واجهة البرمجة والمهام الخلفية، مع المهام المتأخرة أو الفاشلة.',
      },
      {
        en: 'Signed update check (Ed25519 manifest); an update installs only after an owner or administrator confirms it.',
        ar: 'تحقّق موقّع من التحديثات (بيان موقّع بـ Ed25519)؛ ولا يُثبَّت التحديث إلا بعد أن يؤكده مالك أو مسؤول.',
      },
      {
        en: 'Built-in certificate authority and HTTPS listener for Sensors and Agents on other computers, with fingerprint pinning.',
        ar: 'جهة شهادات مدمجة ومنفذ HTTPS للمستشعرات والوكلاء على حواسيب أخرى، مع تثبيت البصمة.',
      },
      {
        en: 'Append-only audit log, an in-app user guide in English and Arabic, light and dark themes.',
        ar: 'سجل تدقيق لا يُعدَّل ولا يُحذف، ودليل استخدام داخل البرنامج بالعربية والإنجليزية، ووضعان فاتح وداكن.',
      },
    ],
    needs: [WINDOWS_HUB],
    unverified: [
      {
        en: 'The engine as a Windows service has only run in tests (installing a service needs elevation, which no build session used).',
        ar: 'تشغيل المحرك كخدمة Windows لم يجرِ إلا في الاختبارات (تثبيت الخدمة يحتاج صلاحيات مرتفعة لم تُستخدم في أي جلسة بناء).',
      },
      {
        en: 'Downloading and installing an update has never run end to end: no release has been built and signed yet.',
        ar: 'تنزيل التحديث وتثبيته لم يجرِ من البداية إلى النهاية قط: لم يُبنَ ويُوقَّع أي إصدار بعد.',
      },
      {
        en: 'Single sign-on was tested against identity providers inside the tests only; LAN HTTPS only on one computer (loopback).',
        ar: 'جُرّب الدخول الموحّد مع مزوّدي هوية داخل الاختبارات فقط، وHTTPS على الشبكة المحلية على حاسوب واحد فقط (عنوان الاسترجاع).',
      },
    ],
    shots: [
      { file: 'hub-home.png', caption: { en: 'Hub home: programs, engine and update state', ar: 'الصفحة الرئيسية في Hub: البرامج وحالة المحرك والتحديثات' } },
      { file: 'hub-programs.png', caption: { en: 'Which programs this computer has', ar: 'البرامج المثبّتة على هذا الحاسوب' } },
    ],
    docs: ['getting-started', 'features/global-search', 'features/system-self-check', 'features/sso', 'features/lan-tls', 'operations/updates'],
  },
  radar: {
    id: 'radar',
    kind: 'program',
    job: { en: 'See the network', ar: 'رؤية الشبكة' },
    summary: {
      en: 'Discovery, devices, network map, IP addresses and switch ports',
      ar: 'الاكتشاف والأجهزة وخريطة الشبكة وعناوين IP ومنافذ السويتش',
    },
    intro: {
      en: 'Radar finds what is on the network and keeps track of it, only inside the address ranges an administrator has authorized.',
      ar: 'يجد Radar ما على الشبكة ويتابعه، داخل نطاقات العناوين التي أذن بها مسؤول فقط.',
    },
    features: [
      {
        en: 'Discovery by ICMP sweep, the neighbour (ARP) table and reverse DNS; vendor from the IEEE registry; names from mDNS, SSDP/UPnP, NetBIOS and passive DHCP.',
        ar: 'اكتشاف بمسح ICMP وجدول الجيران (ARP) وDNS العكسي؛ والشركة المصنّعة من سجل IEEE؛ والأسماء من mDNS وSSDP/UPnP وNetBIOS وDHCP السلبي.',
      },
      {
        en: 'Authorized scopes: private ranges only, no larger than /20 (IPv6: /120), with the administrator’s attestation recorded.',
        ar: 'نطاقات مأذونة: عناوين خاصة فقط، لا تتجاوز /20 (و/120 في IPv6)، مع تسجيل إقرار المسؤول.',
      },
      {
        en: 'Device inventory that follows a device across IP changes: new, offline, IP-changed and “answered by a different MAC” events, IP history, tags, owner and notes.',
        ar: 'جرد أجهزة يتبع الجهاز عند تغيّر عنوانه: أحداث جهاز جديد وغير متصل وتغيّر العنوان و«ردّ عليه MAC مختلف»، وسجل العناوين والوسوم والمالك والملاحظات.',
      },
      {
        en: 'The shared device card: actions from every installed program, and “Available in Nigafiy …” for a program that is not installed.',
        ar: 'بطاقة الجهاز المشتركة: إجراءات من كل برنامج مثبّت، وعبارة «متاح في Nigafiy …» لبرنامج غير مثبّت.',
      },
      {
        en: 'Topology from routing and neighbour tables, SNMP forwarding tables, LLDP, CDP, MikroTik neighbours and MNDP; every link marked observed or inferred, with its evidence.',
        ar: 'خريطة الشبكة من جداول التوجيه والجيران وجداول التمرير عبر SNMP وLLDP وCDP وجيران MikroTik وMNDP؛ وكل وصلة موسومة «مرصودة» أو «مستنتجة» مع دليلها.',
      },
      {
        en: 'IPAM for IPv4 and IPv6: observed, documented and free addresses, subnet plans, conflict detection, address history and CSV export.',
        ar: 'إدارة العناوين لـ IPv4 وIPv6: العناوين المرصودة والموثّقة والحرّة، وخطط الشبكات الفرعية، وكشف التعارض، وسجل العناوين، والتصدير إلى CSV.',
      },
      {
        en: 'Switch ports over SNMP: state, speed, traffic and error history, devices per port, and which port a device is plugged into.',
        ar: 'منافذ السويتش عبر SNMP: الحالة والسرعة وسجل الحركة والأخطاء، والأجهزة على كل منفذ، والمنفذ الذي يتصل به الجهاز.',
      },
      {
        en: 'Wake-on-LAN through the Sensor, only inside an authorized range.',
        ar: 'إيقاظ الأجهزة عبر الشبكة (Wake-on-LAN) من خلال المستشعر، داخل نطاق مأذون فقط.',
      },
    ],
    needs: [IN_HUB, SENSOR_NEEDED, { en: 'Switch ports: managed switches that answer SNMP.', ar: 'منافذ السويتش: سويتشات مُدارة تجيب عبر SNMP.' }],
    unverified: [
      {
        en: 'Real here: a sweep of a real home/office /24 network (7–8 devices). Never on real hardware: SNMP switches, CDP and MNDP (no SNMP hardware was available), IPv6 discovery beyond the loopback address, and Wake-on-LAN waking a real machine.',
        ar: 'جرى فعلًا: مسح شبكة منزلية/مكتبية حقيقية /24 (7 إلى 8 أجهزة). لم يجرِ على عتاد حقيقي: سويتشات SNMP وCDP وMNDP (لم يتوفر عتاد يدعم SNMP)، واكتشاف IPv6 خارج عنوان الاسترجاع، وإيقاظ جهاز حقيقي عبر الشبكة.',
      },
    ],
    shots: [
      { file: 'radar-devices.png', caption: { en: 'Devices', ar: 'الأجهزة' } },
      { file: 'radar-device.png', caption: { en: 'The shared device card', ar: 'بطاقة الجهاز المشتركة' } },
      { file: 'radar-topology.png', caption: { en: 'Topology with observed and inferred links', ar: 'خريطة الشبكة بوصلات مرصودة ومستنتجة' } },
    ],
    docs: ['features/ipv6', 'features/neighbors-cdp-mndp'],
  },
  watch: {
    id: 'watch',
    kind: 'program',
    job: { en: 'Watch and understand', ar: 'المراقبة والفهم' },
    summary: {
      en: 'Monitoring, incidents, Network Doctor, Time Machine and reports',
      ar: 'المراقبة والحوادث وطبيب الشبكة وآلة الزمن والتقارير',
    },
    intro: {
      en: 'Watch checks what matters, groups alerts into incidents and explains them with deterministic rules: every diagnosis shows its evidence and what it ruled out.',
      ar: 'يفحص Watch ما يهم، ويجمع التنبيهات في حوادث، ويشرحها بقواعد ثابتة: كل تشخيص يبيّن أدلته وما استبعده.',
    },
    features: [
      {
        en: 'Checks: ICMP (latency, loss, jitter), TCP port, DNS, HTTP/HTTPS, TLS certificate expiry and SNMP OID, with flap damping.',
        ar: 'فحوص: ICMP (زمن الاستجابة والفقد والتذبذب) ومنفذ TCP وDNS وHTTP/HTTPS وانتهاء شهادة TLS وقيم SNMP، مع تخميد التذبذب.',
      },
      {
        en: 'History charts from 15 minutes to 30 days, and 90 days from hourly roll-ups.',
        ar: 'رسوم تاريخية من 15 دقيقة إلى 30 يومًا، و90 يومًا من تجميعات كل ساعة.',
      },
      {
        en: 'Incidents: alerts correlated automatically, resolved on recovery; acknowledge, assign, comment, and a before/during/after replay.',
        ar: 'الحوادث: ربط التنبيهات تلقائيًا وإغلاقها عند التعافي؛ مع الإقرار والإسناد والتعليق وإعادة عرض ما قبل الحادثة وأثناءها وبعدها.',
      },
      {
        en: 'Network Doctor: rules for LAN, gateway, internet provider, DNS, service and device faults, with evidence, what was ruled out, confidence and next steps.',
        ar: 'طبيب الشبكة: قواعد لأعطال الشبكة المحلية والبوابة ومزوّد الإنترنت وDNS والخدمات والأجهزة، مع الأدلة وما استُبعد ودرجة الثقة والخطوات التالية.',
      },
      {
        en: 'Time Machine: the state of the network at any recorded moment, and a comparison of two periods.',
        ar: 'آلة الزمن: حالة الشبكة في أي لحظة مسجّلة، والمقارنة بين فترتين.',
      },
      {
        en: 'Notifications by email, signed webhooks, Telegram, Slack, Discord and ntfy, with retries and escalation; maintenance windows; reports and impact.',
        ar: 'إشعارات بالبريد وwebhooks موقّعة وTelegram وSlack وDiscord وntfy، مع إعادة المحاولة والتصعيد؛ ونوافذ صيانة؛ وتقارير وتحليل الأثر.',
      },
    ],
    needs: [IN_HUB, SENSOR_NEEDED],
    unverified: [
      {
        en: 'Real here: gateway, internet and DNS checks on a real network. No real outage happened, so incidents, Network Doctor and Time Machine have only run on test data; HTTP, TLS and SNMP checks and the chat notifications only against local test servers.',
        ar: 'جرى فعلًا: فحوص البوابة والإنترنت وDNS على شبكة حقيقية. لم يحدث انقطاع حقيقي، فالحوادث وطبيب الشبكة وآلة الزمن لم تعمل إلا على بيانات اختبار، وفحوص HTTP وTLS وSNMP وإشعارات المحادثة على خوادم اختبار محلية فقط.',
      },
    ],
    shots: [
      { file: 'watch-incident.png', caption: { en: 'An incident with its diagnosis', ar: 'حادثة مع تشخيصها' } },
      { file: 'watch-monitoring.png', caption: { en: 'Checks', ar: 'الفحوص' } },
    ],
    docs: ['features/watch-checks'],
  },
  guard: {
    id: 'guard',
    kind: 'program',
    job: { en: 'Protect and control', ar: 'الحماية والتحكم' },
    summary: {
      en: 'DNS filter, router and switch-port control, security checks, config backup',
      ar: 'فلتر DNS والتحكم بالراوتر ومنافذ السويتش وفحوص الأمان والنسخ الاحتياطي',
    },
    intro: {
      en: 'Guard changes things only when someone asks it to: every change is confirmed, audited and read back. Nigafiy never disconnects a device by itself.',
      ar: 'لا يغيّر Guard شيئًا إلا عندما يطلب منه أحد ذلك: كل تغيير مؤكَّد ومسجّل ويُعاد قراءته. ولا يفصل Nigafiy أي جهاز من تلقاء نفسه.',
    },
    features: [
      {
        en: 'DNS filter answered by the Sensor (point the router’s DHCP DNS at it): block categories and sites for the network, a profile or a device; pause the internet; bedtimes. Off until you turn it on.',
        ar: 'فلتر DNS يجيب عنه المستشعر (وجّه DNS في DHCP الراوتر إليه): حظر فئات ومواقع للشبكة أو لملف تعريف أو لجهاز؛ وإيقاف الإنترنت مؤقتًا؛ وأوقات النوم. متوقف حتى تشغّله.',
      },
      {
        en: 'Router control with 16 vendor drivers: client list, block and unblock, rate limit, schedule, rename, Wi-Fi, DHCP reservations, port forwards and reboot where the firmware offers them; each change is read back.',
        ar: 'التحكم بالراوتر عبر 16 مشغّلًا لمصنّعين مختلفين: قائمة الأجهزة والحظر وفكّه وتحديد السرعة والجدولة وإعادة التسمية والواي فاي وحجوزات DHCP وتحويل المنافذ وإعادة التشغيل حيث يتيحها البرنامج الثابت؛ ويُعاد قراءة كل تغيير.',
      },
      {
        en: 'Switch port control over SNMP SET: enable, disable, VLAN and quarantine, refused on uplinks and trunks.',
        ar: 'التحكم بمنافذ السويتش عبر SNMP SET: تفعيل وتعطيل وVLAN وعزل، ويُرفض على وصلات الربط والمنافذ المشتركة.',
      },
      {
        en: 'Security checks run by the Sensor: rogue DHCP, UPnP gateway audit, Wi-Fi analyser and DHCP/HTTP fingerprinting.',
        ar: 'فحوص أمان يجريها المستشعر: خادم DHCP دخيل، وتدقيق UPnP في البوابة، ومحلّل الواي فاي، والبصمات عبر DHCP وHTTP.',
      },
      {
        en: 'Configuration backup over SSH with diff and secret sanitization; restore with automatic rollback for Juniper Junos, Cisco IOS XE, VyOS/EdgeOS and OpenWrt.',
        ar: 'نسخ احتياطي للإعدادات عبر SSH مع المقارنة وإخفاء الأسرار؛ واستعادة مع تراجع تلقائي لأجهزة Juniper Junos وCisco IOS XE وVyOS/EdgeOS وOpenWrt.',
      },
    ],
    needs: [
      IN_HUB,
      SENSOR_NEEDED,
      {
        en: 'Router control: a supported router and its admin credentials. Switch control: SNMP write access.',
        ar: 'التحكم بالراوتر: راوتر مدعوم وبيانات دخول المسؤول. التحكم بالسويتش: صلاحية كتابة عبر SNMP.',
      },
    ],
    unverified: [
      {
        en: 'Real here: one Zyxel VMG3625-T50B router (block, unblock, rename, reservation, port forward, guest Wi-Fi from the web app). The other 15 router drivers, switch port control, config backup and restore, and real devices using the DNS filter have only run against test doubles.',
        ar: 'جرى فعلًا: راوتر Zyxel VMG3625-T50B واحد (حظر وفك حظر وإعادة تسمية وحجز وتحويل منفذ وواي فاي للضيوف من تطبيق الويب). أما مشغّلات الراوترات الخمسة عشر الأخرى والتحكم بمنافذ السويتش والنسخ الاحتياطي والاستعادة واستخدام أجهزة حقيقية لفلتر DNS فلم تعمل إلا مع بدائل اختبار.',
      },
    ],
    shots: [
      { file: 'guard-routers.png', caption: { en: 'Routers', ar: 'الراوترات' } },
      { file: 'guard-access.png', caption: { en: 'DNS filter, off until turned on', ar: 'فلتر DNS، متوقف حتى يُشغَّل' } },
    ],
    docs: ['features/router-controls', 'features/switch-port-control', 'features/smart-checks', 'features/config-backup'],
  },
  fleet: {
    id: 'fleet',
    kind: 'program',
    job: { en: 'Manage company computers', ar: 'إدارة حواسيب الشركة' },
    summary: {
      en: 'Company computers: compliance, remote desktop, files and commands',
      ar: 'حواسيب الشركة: الامتثال وسطح المكتب البعيد والملفات والأوامر',
    },
    intro: {
      en: 'Fleet manages computers that run the Nigafiy Agent. Remote access is never hidden: the user sees a consent prompt and a session bar with an End button, and every action is in the audit log.',
      ar: 'يدير Fleet الحواسيب التي يعمل عليها Nigafiy Agent. الوصول عن بُعد لا يكون خفيًا أبدًا: يرى المستخدم طلب موافقة وشريط جلسة فيه زر «إنهاء»، وكل إجراء مسجّل في سجل التدقيق.',
    },
    features: [
      {
        en: 'Inventory: hardware, software, disks, licences, local administrators; processes, services and event logs.',
        ar: 'الجرد: العتاد والبرامج والأقراص والتراخيص والمسؤولون المحليون؛ والعمليات والخدمات وسجلات الأحداث.',
      },
      {
        en: 'Compliance from measured evidence only (Defender, BitLocker, Windows Update; firewall and encryption on Linux; FileVault, SIP and Gatekeeper on macOS); what was not measured says so.',
        ar: 'امتثال من أدلة مقيسة فقط (Defender وBitLocker وWindows Update؛ والجدار الناري والتشفير في Linux؛ وFileVault وSIP وGatekeeper في macOS)؛ وما لم يُقَس يُقال عنه ذلك.',
      },
      {
        en: 'Remote desktop with a consent prompt (60-second timeout) and a session bar; WebRTC H.264 video on Windows agents, WebSocket and JPEG everywhere else.',
        ar: 'سطح مكتب بعيد مع طلب موافقة (مهلة 60 ثانية) وشريط جلسة؛ وفيديو WebRTC H.264 مع وكلاء Windows، وWebSocket وJPEG في غيرها.',
      },
      {
        en: 'Access policies: attended or unattended, hours, roles, MFA step-up, second-admin approval, operator IP allow-list, permission profiles; encrypted session recording.',
        ar: 'سياسات الوصول: بحضور المستخدم أو بدونه، والساعات والأدوار والتحقق الإضافي بخطوتين وموافقة مسؤول ثانٍ وقائمة عناوين مسموحة للمشغّلين وملفات صلاحيات؛ وتسجيل مشفّر للجلسات.',
      },
      {
        en: 'File manager with resumable transfers checked by SHA-256; remote shell for administrators only, off by default, with a sealed transcript.',
        ar: 'مدير ملفات بنقل قابل للاستئناف يُتحقق منه بـ SHA-256؛ وطرفية بعيدة للمسؤولين فقط، متوقفة افتراضيًا، مع نص جلسة محفوظ ومختوم.',
      },
      {
        en: 'Scripts and jobs (now, once, recurring, in maintenance windows), patches with approvals and reboot policy, monitoring rules.',
        ar: 'السكربتات والمهام (الآن أو مرة واحدة أو بشكل متكرر أو في نوافذ الصيانة)، والتحديثات مع الموافقات وسياسة إعادة التشغيل، وقواعد المراقبة.',
      },
      {
        en: 'Address book with groups and tags, Request help from the tray, and Quick Support with a code and a one-time PIN.',
        ar: 'دفتر عناوين بمجموعات ووسوم، و«طلب مساعدة» من شريط المهام، والدعم السريع (Quick Support) برمز ورقم سري لمرة واحدة.',
      },
      {
        en: 'Android phones (free, sideloaded app): inventory and compliance facts; as Device Owner also lock, password policy, camera, app install and wipe.',
        ar: 'هواتف Android (تطبيق مجاني يُثبَّت يدويًا): الجرد وحقائق الامتثال؛ وفي وضع مالك الجهاز أيضًا القفل وسياسة كلمة المرور والكاميرا وتثبيت التطبيقات والمسح.',
      },
    ],
    needs: [IN_HUB, { en: 'The Nigafiy Agent on each managed computer or phone.', ar: 'Nigafiy Agent على كل حاسوب أو هاتف مُدار.' }],
    unverified: [
      {
        en: 'Real here: the Windows agent against the API (inventory, files, processes, commands, screen capture, remote shell), the consent prompt’s timeout, the tray icon. Tests only: remote mouse and keyboard, the agent as a LocalSystem service, Linux and macOS agents, WebRTC in a real browser or to a second computer, and any Android phone.',
        ar: 'جرى فعلًا: وكيل Windows مع واجهة البرمجة (الجرد والملفات والعمليات والأوامر والتقاط الشاشة والطرفية البعيدة)، ومهلة طلب الموافقة، وأيقونة شريط المهام. في الاختبارات فقط: الفأرة ولوحة المفاتيح عن بُعد، والوكيل كخدمة LocalSystem، ووكلاء Linux وmacOS، وWebRTC في متصفح حقيقي أو إلى حاسوب ثانٍ، وأي هاتف Android.',
      },
    ],
    shots: [
      { file: 'fleet-endpoints.png', caption: { en: 'Endpoints', ar: 'الحواسيب المُدارة' } },
      { file: 'fleet-endpoint.png', caption: { en: 'A computer, with compliance evidence', ar: 'حاسوب مع أدلة الامتثال' } },
    ],
    docs: ['features/fleet-pro', 'features/fleet-compliance', 'features/android'],
  },
  mind: {
    id: 'mind',
    kind: 'program',
    job: { en: 'Knowledge and automation', ar: 'المعرفة والأتمتة' },
    summary: {
      en: 'Knowledge, approval-gated playbooks and automation',
      ar: 'المعرفة والإجراءات بموافقة والأتمتة',
    },
    intro: {
      en: 'Mind remembers how problems were fixed and runs playbooks that stop at an approval gate before anything disruptive. There is no AI in it: every step is a rule you can read.',
      ar: 'يتذكّر Mind كيف حُلّت المشكلات، ويشغّل إجراءات تتوقف عند بوابة موافقة قبل أي خطوة مؤثرة. لا يوجد فيه ذكاء اصطناعي: كل خطوة قاعدة يمكنك قراءتها.',
    },
    features: [
      {
        en: 'Knowledge articles linked to devices and incidents.',
        ar: 'مقالات معرفة مرتبطة بالأجهزة والحوادث.',
      },
      {
        en: 'Playbooks with approval steps and a two-person rule; actions such as notify, set trust, router Wi-Fi, reboot, port quarantine and config backup.',
        ar: 'إجراءات (Playbooks) بخطوات موافقة وقاعدة الشخصين؛ وأفعال مثل الإشعار وتحديد الثقة وواي فاي الراوتر وإعادة التشغيل وعزل المنفذ والنسخ الاحتياطي للإعدادات.',
      },
      {
        en: 'Automation catalogue with per-organization overrides.',
        ar: 'فهرس أتمتة مع تعديلات خاصة بكل مؤسسة.',
      },
    ],
    needs: [IN_HUB],
    unverified: [
      {
        en: 'Playbooks have run in API tests only, not against real routers or switches.',
        ar: 'لم تعمل الإجراءات إلا في اختبارات واجهة البرمجة، لا مع راوترات أو سويتشات حقيقية.',
      },
    ],
    shots: [
      { file: 'mind-playbook-run.png', caption: { en: 'A playbook run waiting at its approval gate', ar: 'تشغيل إجراء متوقف عند بوابة الموافقة' } },
      { file: 'mind-knowledge.png', caption: { en: 'Knowledge', ar: 'المعرفة' } },
    ],
    docs: ['features/playbooks'],
  },
  toolbox: {
    id: 'toolbox',
    kind: 'program',
    job: { en: 'Quick tools', ar: 'أدوات سريعة' },
    summary: {
      en: 'Ping, port checks, DNS, traceroute and a subnet calculator',
      ar: 'Ping وفحص المنافذ وDNS وتتبع المسار وحاسبة الشبكات',
    },
    intro: {
      en: 'Toolbox runs quick probes from the site’s Sensor, so the answer is what that site sees. Every target is checked against the authorized scopes first.',
      ar: 'يشغّل Toolbox فحوصًا سريعة من مستشعر الموقع، فتكون النتيجة ما يراه ذلك الموقع. ويُتحقق من كل هدف مقابل النطاقات المأذونة أولًا.',
    },
    features: [
      { en: 'ICMP ping, TCP port check and a scan of 19 common IT and management ports.', ar: 'Ping عبر ICMP وفحص منفذ TCP وفحص 19 منفذًا شائعًا لخدمات تقنية المعلومات والإدارة.' },
      { en: 'DNS lookup, reverse DNS and hop-by-hop traceroute.', ar: 'استعلام DNS وDNS العكسي وتتبع المسار قفزة قفزة.' },
      { en: 'Subnet calculator for IPv4 and IPv6.', ar: 'حاسبة الشبكات الفرعية لـ IPv4 وIPv6.' },
    ],
    needs: [IN_HUB, SENSOR_NEEDED],
    unverified: [],
    shots: [
      { file: 'toolbox.png', caption: { en: 'Tools', ar: 'الأدوات' } },
      { file: 'toolbox-subnet.png', caption: { en: 'Subnet calculator', ar: 'حاسبة الشبكات الفرعية' } },
    ],
    docs: ['features/toolbox-scope'],
  },
  agent: {
    id: 'agent',
    kind: 'companion',
    job: { en: 'On each managed computer', ar: 'على كل حاسوب مُدار' },
    summary: {
      en: 'Runs on managed Windows, Linux and macOS computers and Android phones; Fleet talks to it',
      ar: 'يعمل على حواسيب Windows وLinux وmacOS المُدارة وهواتف Android؛ ويتواصل معه Fleet',
    },
    intro: {
      en: 'The Agent is what Fleet talks to. It enrolls with a one-time token, runs as a service, and only performs a closed list of typed actions, each checked against the user’s role and recorded.',
      ar: 'الوكيل هو ما يتواصل معه Fleet. يسجّل نفسه برمز لمرة واحدة، ويعمل كخدمة، ولا ينفّذ إلا قائمة مغلقة من الإجراءات المحددة، يُتحقق من كل منها مقابل دور المستخدم ويُسجَّل.',
    },
    features: [
      {
        en: 'Windows, Linux and macOS (one Go program): installs itself as a service with the install subcommand, upgrades in place and rolls back if the new version does not start.',
        ar: 'Windows وLinux وmacOS (برنامج Go واحد): يثبّت نفسه كخدمة بالأمر install، ويترقّى في مكانه ويتراجع إن لم يبدأ الإصدار الجديد.',
      },
      {
        en: 'Windows installer with a silent mode for Group Policy, Intune or SCCM (/S /SERVER= /TOKENFILE=).',
        ar: 'مثبّت Windows بوضع صامت لـ Group Policy أو Intune أو SCCM (‎/S /SERVER= /TOKENFILE=‎).',
      },
      {
        en: 'Consent prompt and an on-screen session bar for remote desktop; Request help in the tray.',
        ar: 'طلب موافقة وشريط جلسة على الشاشة لسطح المكتب البعيد؛ و«طلب مساعدة» من شريط المهام.',
      },
      {
        en: 'Android app (Device Policy Controller), installed from the APK: no Google Play, no Firebase, no Google account. A permanent “Managed by Nigafiy” notification; there is no hidden mode.',
        ar: 'تطبيق Android (وحدة التحكم بسياسة الجهاز) يُثبَّت من ملف APK: بلا Google Play ولا Firebase ولا حساب Google. وإشعار دائم «يُدار بواسطة Nigafiy»؛ ولا يوجد وضع مخفي.',
      },
    ],
    needs: [
      { en: 'Windows (64-bit), Linux or macOS; Android 8.0 or later for the phone app.', ar: 'Windows (64 بت) أو Linux أو macOS؛ وAndroid 8.0 أو أحدث لتطبيق الهاتف.' },
      { en: 'A Nigafiy server it can reach, and a one-time enrollment token created in Fleet.', ar: 'خادم Nigafiy يمكن الوصول إليه، ورمز تسجيل لمرة واحدة يُنشأ في Fleet.' },
    ],
    unverified: [
      {
        en: 'The agent installer and the upgrade with rollback have never run on a real machine (they need elevation). Linux and macOS agents are cross-compiled and tested by parsers only. The Android app has never run on a phone or an emulator.',
        ar: 'لم يعمل مثبّت الوكيل ولا الترقية مع التراجع على جهاز حقيقي قط (يحتاجان صلاحيات مرتفعة). وكلاء Linux وmacOS مترجَمون لتلك الأنظمة ومختبرون باختبارات التحليل فقط. ولم يعمل تطبيق Android على هاتف أو محاكٍ قط.',
      },
    ],
    shots: [{ file: 'agent-android.png', caption: { en: 'An Android phone in Fleet (seeded through the agent protocol)', ar: 'هاتف Android في Fleet (أُضيف عبر بروتوكول الوكيل)' } }],
    docs: ['operations/installers', 'features/android', 'features/fleet-compliance'],
  },
  sensor: {
    id: 'sensor',
    kind: 'companion',
    job: { en: 'At each site', ar: 'في كل موقع' },
    summary: {
      en: 'The network collector: Hub runs one locally; extra Sensors go at other sites',
      ar: 'جامع بيانات الشبكة: يشغّل Hub واحدًا محليًا، ومستشعرات إضافية للمواقع الأخرى',
    },
    intro: {
      en: 'The Sensor discovers devices, runs checks and smart checks, and answers DNS when the filter is on. It observes and probes; it has no way to run arbitrary commands, capture packet contents or exploit anything.',
      ar: 'يكتشف المستشعر الأجهزة، ويجري الفحوص والفحوص الذكية، ويجيب عن DNS عند تشغيل الفلتر. هو يرصد ويستطلع فقط؛ ولا يستطيع تشغيل أوامر عشوائية ولا التقاط محتوى الحزم ولا استغلال أي شيء.',
    },
    features: [
      {
        en: 'One executable with the engine: branch sites run nigafiy-engine sensor.',
        ar: 'ملف تنفيذي واحد مع المحرك: تشغّل المواقع الفرعية الأمر nigafiy-engine sensor.',
      },
      {
        en: 'Single-use enrollment token, then its own credential; heartbeat, configuration and commands by polling; results buffered on disk while the server is unreachable.',
        ar: 'رمز تسجيل لمرة واحدة ثم بيانات اعتماد خاصة به؛ ونبض وإعدادات وأوامر بالاستطلاع؛ والنتائج تُحفظ على القرص ما دام الخادم غير متاح.',
      },
      {
        en: 'Works only inside authorized private ranges, with compiled-in limits on rate and size.',
        ar: 'يعمل داخل النطاقات الخاصة المأذونة فقط، مع حدود مدمجة للمعدّل والحجم.',
      },
      {
        en: 'Pins the server’s certificate when it reaches Hub over the LAN.',
        ar: 'يثبّت بصمة شهادة الخادم عندما يتصل بـ Hub عبر الشبكة المحلية.',
      },
    ],
    needs: [
      { en: 'Windows or Linux on a computer at the site, and a Nigafiy server it can reach.', ar: 'Windows أو Linux على حاسوب في الموقع، وخادم Nigafiy يمكن الوصول إليه.' },
    ],
    unverified: [
      {
        en: 'Real here: the Sensor on Windows on a real network. Never run: the Sensor at runtime on Linux, and a Sensor on a second computer reaching Hub over LAN HTTPS.',
        ar: 'جرى فعلًا: المستشعر على Windows في شبكة حقيقية. لم يجرِ قط: المستشعر أثناء التشغيل على Linux، ومستشعر على حاسوب ثانٍ يتصل بـ Hub عبر HTTPS في الشبكة المحلية.',
      },
    ],
    shots: [{ file: 'sensor-sensors.png', caption: { en: 'Sensors in Hub', ar: 'المستشعرات في Hub' } }],
    docs: ['features/smart-checks', 'features/lan-tls'],
  },
};

/** The three promises on the home page (Site.dc.html). */
export const PILLARS: readonly { icon: string; title: T; text: T }[] = [
  {
    icon: 'M3 12l9-8 9 8M5 10v10h14V10',
    title: { en: 'Local-first', ar: 'محلي أولًا' },
    text: {
      en: 'The engine and the database run on the company’s own machine. No cloud console and no outside accounts.',
      ar: 'المحرك وقاعدة البيانات يعملان على جهاز الشركة. لا لوحة تحكم سحابية ولا حسابات خارجية.',
    },
  },
  {
    icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    title: { en: 'Transparent', ar: 'شفاف' },
    text: {
      en: 'Every remote desktop session shows on the user’s screen with a session bar, and every action is in the audit log. There is no hidden monitoring.',
      ar: 'كل جلسة سطح مكتب بعيد تظهر على شاشة المستخدم مع شريط الجلسة، وكل إجراء مسجّل في سجل التدقيق. لا توجد مراقبة خفية.',
    },
  },
  {
    icon: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18',
    title: { en: 'Works things out', ar: 'يستنتج بنفسه' },
    text: {
      en: 'It discovers the network and suggests the next step, and always shows how it knows and how sure it is. Deterministic rules, no AI.',
      ar: 'يكتشف الشبكة ويقترح الخطوة التالية، ويبيّن دائمًا كيف عرف الشيء ومدى ثقته. قواعد ثابتة، بلا ذكاء اصطناعي.',
    },
  },
];
