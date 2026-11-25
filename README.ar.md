<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/hero-dark.svg">
    <img alt="Nigafiy: اعرف شبكتك وافهم كل عطل. سبعة برامج على محرك محلي واحد." src="docs/assets/readme/hero.svg" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/MKhattab7050/nigafiy-platform/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MKhattab7050/nigafiy-platform/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Platform: Windows 10 and 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-1466E6">
  <img alt="TypeScript on Node 24" src="https://img.shields.io/badge/TypeScript-Node%2024-3178C6?logo=typescript&amp;logoColor=white">
  <img alt="Go 1.27" src="https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&amp;logoColor=white">
  <img alt="English and Arabic" src="https://img.shields.io/badge/UI-English%20%2B%20%D8%A7%D9%84%D8%B9%D8%B1%D8%A8%D9%8A%D8%A9-0B2A7A">
  <img alt="No AI" src="https://img.shields.io/badge/AI-none%2C%20deterministic-2E8540">
  <img alt="Status: pre-release 0.1.0" src="https://img.shields.io/badge/status-pre--release%200.1.0-C27C0E">
  <img alt="Repository: private" src="https://img.shields.io/badge/repository-private-4B5563">
</p>

<p align="center"><a href="README.md">English</a> · <b>العربية</b></p>

<div dir="rtl">

Nigafiy منصة مجانية لإدارة الشبكات وأجهزة الشركة، مبنية أولاً لنظام Windows، لمسؤولي تقنية المعلومات
ومزوّدي الخدمات المُدارة (MSP). سبعة برامج تعمل فوق محرك محلي واحد: تكتشف كل جهاز على الشبكة وتراقبه،
وتشرح الأعطال بقواعد ثابتة مبنية على أدلة مُقاسة، وتتحكم في الراوترات والسويتشات وتصفية DNS، وتدير
أجهزة الشركة (Windows وLinux وmacOS) وتدعمها عبر وكيل مُسجَّل يوفر سطح المكتب البعيد والملفات وسطر
الأوامر والتحديثات. البيانات تبقى على أجهزة الجهة نفسها؛ لا يوجد ذكاء اصطناعي في أي مكان، ولا لوحة تحكم
سحابية. الواجهة بالعربية والإنجليزية (اتجاه من اليمين لليسار كامل)، بسمة فاتحة وداكنة.

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/how-it-works-dark.svg">
  <img alt="طريقة العمل: 1 الاكتشاف، 2 المراقبة، 3 التنبيه، 4 التصرف" src="docs/assets/readme/how-it-works.svg" width="100%">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/divider-dark.svg">
  <img alt="" src="docs/assets/readme/divider.svg" width="100%">
</picture>

<div dir="rtl">

## البرامج

<table>
  <tr>
    <td align="center" width="33%"><img src="packages/brand/svg/programs/hub.svg" width="56" alt=""><br><b>Nigafiy Hub</b><br><sub>الرئيسية وتسجيل الدخول والإعدادات والمحرك</sub></td>
    <td align="center" width="33%"><img src="packages/brand/svg/programs/radar.svg" width="56" alt=""><br><b>Nigafiy Radar</b><br><sub>رؤية كل جهاز على الشبكة</sub></td>
    <td align="center" width="33%"><img src="packages/brand/svg/programs/watch.svg" width="56" alt=""><br><b>Nigafiy Watch</b><br><sub>المراقبة وفهم سبب المشكلة</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="packages/brand/svg/programs/guard.svg" width="56" alt=""><br><b>Nigafiy Guard</b><br><sub>حماية الشبكة والتحكم بها</sub></td>
    <td align="center"><img src="packages/brand/svg/programs/fleet.svg" width="56" alt=""><br><b>Nigafiy Fleet</b><br><sub>إدارة أجهزة الشركة ودعمها</sub></td>
    <td align="center"><img src="packages/brand/svg/programs/mind.svg" width="56" alt=""><br><b>Nigafiy Mind</b><br><sub>المعرفة وخطط العمل والأتمتة</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="packages/brand/svg/programs/toolbox.svg" width="56" alt=""><br><b>Nigafiy Toolbox</b><br><sub>أدوات شبكة سريعة</sub></td>
    <td align="center"><img src="packages/brand/svg/programs/sensor.svg" width="56" alt=""><br><b>Nigafiy Sensor</b><br><sub>جامع بيانات الشبكة، واحد لكل موقع</sub></td>
    <td align="center"><img src="packages/brand/svg/programs/agent.svg" width="56" alt=""><br><b>Nigafiy Agent</b><br><sub>على كل جهاز مُدار بنظام Windows أو Linux أو macOS</sub></td>
  </tr>
</table>

## البنية

</div>

```mermaid
flowchart LR
  subgraph PC["Admin's Windows PC, loopback only"]
    DESK["Desktop app and program windows (Electron)"]
    ENG["nigafiy-engine (supervisor)"]
    WEB["Web console (Next.js)"]
    API["API (Node, Express)"]
    DB[("PostgreSQL with RLS")]
    SEN["Local Sensor"]
  end
  SITE["Sensor at another site"]
  AGENT["Agent on managed computers"]
  LAN["Devices, routers, switches"]
  DESK --> WEB
  ENG -->|supervises| WEB
  ENG -->|supervises| API
  ENG -->|supervises| DB
  ENG -->|supervises| SEN
  WEB -->|"same-origin /api"| API
  API --> DB
  SEN -->|"outbound HTTPS"| API
  SITE -->|"outbound HTTPS"| API
  AGENT -->|"outbound HTTPS and WebSocket"| API
  SEN -->|"ICMP, ARP, SNMP, SSH, router APIs"| LAN
```

<div dir="rtl">

الخادم لا يفتح أي اتصال إلى داخل شبكة العميل: الـ Sensor والـ Agent هما من يتصلان بالخادم ويطلبان
الأوامر من قائمة مغلقة. باقي المخططات (المنافذ، الاكتشاف، التسجيل، سطح المكتب البعيد، تغييرات
الراوتر، استعادة الإعدادات، التحديثات، التوزيع، تسجيل الدخول) موجودة في
[docs/architecture/flowcharts.md](docs/architecture/flowcharts.md) (بالإنجليزية).

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/divider-dark.svg">
  <img alt="" src="docs/assets/readme/divider.svg" width="100%">
</picture>

<div dir="rtl">

## البدء السريع

**المتطلبات:** Node.js 24 أو أحدث، وGo 1.27.3 أو أحدث (يثبّت `pnpm local` أداة pnpm 10 تلقائياً إن لم
تكن موجودة). لا حاجة إلى Docker أو PostgreSQL أو Redis.

</div>

```bash
pnpm local
```

<div dir="rtl">

على Windows يمكن بدلاً من ذلك النقر المزدوج على `Start Nigafiy.cmd`. التشغيل الأول يثبّت الاعتماديات،
وينشئ ملف `.env`، ويشغّل قاعدة البيانات والـ API وتطبيق الويب على هذا الجهاز، ويطلب تأكيد شبكتك،
وينشئ حسابك، ثم يفتح http://localhost:3100.

</div>

<details>
<summary dir="rtl"><b>فحوص الجودة التي يمر بها كل تغيير</b></summary>

```bash
pnpm typecheck
pnpm lint
pnpm check:brand
pnpm test
pnpm test:collector
pnpm test:agent
pnpm test:engine
pnpm build
```

</details>

<div dir="rtl">

تفاصيل التثبيت وبناء البرامج وكل أوامر الاختبار: [docs/getting-started.md](docs/getting-started.md)
(بالإنجليزية).

## التوثيق والحالة

- 📚 [فهرس التوثيق](docs/README.md)
- 🧭 [حالة المشروع: ما بُني، وما جُرّب على أجهزة حقيقية، وما اختُبر بالاختبارات فقط](docs/roadmap/status.md)
- 🔐 [نموذج الأمان](docs/security/model.md) و[طريقة الإبلاغ عن ثغرة](SECURITY.md)

<details>
<summary><b>الحالة بصراحة: ما جُرّب فعلاً وما اختُبر بالاختبارات فقط</b></summary>

كثير من الخصائص لم تُجرَّب إلا أمام بدائل اختبار للبروتوكولات أو على عنوان loopback، وليس على أجهزة
حقيقية؛ مثل 15 من أصل 16 مشغّل راوتر (ومنها تحكم Cisco IOS XE)، وسويتشات SNMP، وتسجيل الدخول الموحد
SSO، واستعادة الإعدادات (Junos وIOS XE)، والوكيل على Linux وmacOS، وWebRTC في متصفح حقيقي، ووضع خدمة
Windows للمحرك، ومثبّتات MSI والوكيل. أما الاكتشاف والفحوص فعملت على شبكة حقيقية، والوكيل على Windows
عمل مع الـ API الحقيقي، وتم التحكم فعلياً في راوتر واحد (Zyxel VMG3625-T50B). ولم يعمل سير عمل CI على
GitHub بعد. الملف [docs/roadmap/status.md](docs/roadmap/status.md) يذكر بالضبط ما جُرّب فعلاً وما لم
يُجرَّب.

</details>

## الترخيص

لم يُحدَّد بعد: جميع الحقوق محفوظة حتى ذلك الحين.

</div>
