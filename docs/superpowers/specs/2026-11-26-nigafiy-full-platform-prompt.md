# برومبت منصة Nigafiy الكاملة (2026-11-26)

> انسخ كل اللي تحت الخط ده والصقه في جلسة Claude Code جديدة مفتوحة على `D:\network`.

---

إنت هتكمّل منصة **Nigafiy** في `D:\network` (branch `phase-2-network-intelligence`، و`master` على GitHub private). Nigafiy منصة شبكات وIT للشركات، local-first وعلى أجهزة الشركة نفسها، مقسمة لعيلة برامج ويندوز على engine واحد، ومعاها Agent للأجهزة، وSensor للفروع، وتطبيق Android، وموقع للعرض والتنزيل. آخر إصدار: **1.0.3** (في `D:\nigafiy-releases\1.0.3`)، والـ CI أخضر من 2026-11-26.

دورك: **مدير المشروع**. بتقسم الشغل لـ builders (subagents Opus)، كل واحد في git worktree لوحده، وإنت اللي بتعمل الـ gate وبتدمج. كلمني بالعربي المصري، واسألني بس في الحاجات اللي هي قراري.

## 1. اقرا دول الأول بالكامل، قبل أي حاجة

1. `docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md`: التصميم المعتمد (البرامج، خريطة الخصائص في القسم 5، المعمارية، القواعد).
2. `docs/roadmap/status.md`: المصدر الوحيد للحقيقة. إيه اللي اتبنى، وإيه اللي اشتغل على hardware حقيقي، وإيه اللي اتجرب في tests بس، والفجوات المفتوحة.
3. `docs/architecture/overview.md` و`docs/architecture/naming.md` و`docs/security/model.md`.
4. `docs/features/*` و`docs/operations/*` (خصوصاً `installers.md` و`code-signing.md` و`microsoft-store.md`).
5. `docs/superpowers/plans/*` و`docs/superpowers/specs/2026-11-25-android-remote-controls-handoff.md`.
6. `git log --oneline -40` و`git status`.

## 2. المنصة الكاملة (الهدف)

| البرنامج | الوظيفة | اللون | فيه إيه |
| --- | --- | --- | --- |
| **Hub** | البيت والـ engine | أزرق Nigafiy | الـ dashboard، البحث الشامل، الحسابات والفريق وMFA وSSO (OIDC/SAML)، الإعدادات، فحص النظام، MSP portfolio، إدارة الـ Sensors، تسطيب وتحديث وفتح باقي البرامج، دليل المستخدم |
| **Radar** | يشوف الشبكة | Cyan | Discovery (IPv4 وIPv6)، الأجهزة وكارت الجهاز، Topology (LLDP/CDP/MNDP/Wi-Fi)، IPAM، السويتشات وPort Detective |
| **Watch** | يراقب ويفهم | Amber | Checks (ICMP/TCP/DNS/HTTP/TLS/SNMP-OID)، Events، Incidents، Network Doctor، Time Machine، Insights، الإشعارات (Email/Webhook/Telegram/Slack/Discord/ntfy)، Maintenance، Reports، Impact |
| **Guard** | يحمي ويتحكم | أحمر | DNS access control والـ Pause (متطبق على الراوتر كمان)، 16 driver للراوترات، التحكم في بورتات السويتش وVLAN وQuarantine، الفحوصات الأمنية الذكية، Config backup/diff/restore |
| **Fleet** | يدير أجهزة الشركة | Violet | Enrollment، Policy، Compliance، Remote desktop (WebSocket+JPEG، وWebRTC H.264 على LAN)، Fleet Pro (profiles، recording، shell، scripts/jobs، patches، Quick Support، tray)، تليفونات Android (Device Owner + تحكم في الوضع العادي + بث حي) |
| **Mind** | معرفة وأتمتة | Pink | Knowledge، Playbooks بموافقة، Automation catalogue. **من غير أي AI.** |
| **Toolbox** | أدوات سريعة | أخضر | Ping، TCP، Common ports، DNS، rDNS، Traceroute، Subnet calculator |

وبرّه جهاز الأدمن: **Agent** (Windows/Linux/macOS، `agents/endpoint-agent`)، **Sensor** (`collectors/lan-collector`، ومدموج في الـ engine كـ subcommand للفروع)، **تطبيق Android** (APK sideload). والموقع `apps/site` (static، EN/AR).

المشترك: كارت جهاز واحد في كل البرامج بيعرض أفعال كل البرامج المتسطبة ("متاح في Nigafiy Guard: سطّبه" للمش متسطب)، وتسجيل دخول واحد، وروابط `nigafiy://`، وإشعارات في Hub وفي Windows، وتحديثات بـ manifest موقّع Ed25519.

## 3. اللي فاضل (رتّبه من `status.md` واعرضه عليّ قبل ما تبدأ)

**أ. ثبات المنتج المتسطب (أهم حاجة).** لقيت bugs واحد ورا التاني وأنا بستخدم البرنامج. عايز مرور كامل على البرنامج **المتسطب** (مش الـ dev stack) على الشبكة الحقيقية: كل صفحة في كل برنامج، EN وAR، light وdark، وكل زرار بيعمل حاجة حقيقية. كل bug يتصلح ويتعمله test. الحاجات اللي محتاجة إيدي (باسورد الراوتر، UAC، جهاز تاني) تعملّي بيها checklist واضحة.

**ب. فجوات مفتوحة من `status.md`:**
- كل اللي في عمود "Tests only": يتعمله **checklist تجربة على hardware حقيقي** ليا، مرتب بالأولوية، فيه الخطوة والنتيجة المتوقعة ومكان تسجيل النتيجة.
- WebRTC: ما اتشافش في متصفح حقيقي بين جهازين.
- Agent كـ LocalSystem service وتحديثه، والـ MSI upgrade، والـ upgrade فوق LAN Detective قديم: ما اشتغلوش. اعمل خطة تجربة (VM ويندوز disposable لو أمكن ببلاش).
- صفحات `docs/features` للخصائص القديمة (DNS access، IPAM، Monitoring، Doctor).
- الـ flake في site e2e (React hydration #418 على CI). فيه `apps/site/repro.tmp.mjs` مش متعمله commit: افحصه الأول قبل ما تمسحه أو تستخدمه.

**ج. أسئلة لسه ما جاوبتش عليها** (اسألني فيها لما توصلها، سؤال واحد كل مرة): مراجعة أمنية كاملة، backup تلقائي لبيانات المستخدم، المستندات القانونية (Privacy policy وEULA وقانون حماية البيانات المصري 151/2020)، Linux agent جوه WSL، Load test.

**د. الموقع:** مبني ومش مرفوع. الدومين والاستضافة ومكان التنزيلات قراري أنا.

**هـ. آخر خطوة في المشروع كله:** أنا بعمل حساب Partner Center وبرفع على Microsoft Store. **فكّرني** بيها في الآخر، بالخطوات من `docs/operations/microsoft-store.md`.

## 4. القواعد (ممنوع تتكسر)

- **ممنوع أي خاصية تختفي أو تتبسط أو تبقى زرار مش بيعمل حاجة.** الترتيب ترتيب، مش إذن إنك تشيل.
- **100% حقيقي:** مفيش بيانات وهمية ولا simulated mode ولا demo في المنتج. الـ test doubles في الـ tests بس. ما تقولش على حاجة إنها شغالة إلا لو شفتها شغالة، وفرّق دايماً بين "اشتغل على hardware حقيقي" و"اتجرب في tests".
- **مفيش AI في أي حتة** (اتشال في migration 027 بقراري).
- كل خاصية: backend، database، UI، validation، صلاحيات، audit log، tests، EN+AR مع RTL، وdocs بالمتطلبات.
- الـ remote access شفاف دايماً: consent واضح، banner، audit. ممنوع stealth أو keylogging أو سرقة credentials.
- الموافقات بتفضل click صريح: تصريح نطاق الـ scan، الـ enrollment، الـ remote session، الحاجات اللي بتمسح، الـ DNS filter، الـ credentials.
- **ببلاش بس:** مفيش شهادات أو حسابات مدفوعة. التوقيع: شهادة self-signed للشركة تتنشر بالـ GPO، والـ Store يوقّع النسخة العامة. ممنوع تزرع root certificate في السر. iOS مرفوض (محتاج حساب Apple مدفوع). مفيش Google Play.
- مفيش mascot أو شخصية في البراند أبداً. ما تفتحش موضوع الاسم تاني.
- Nigafiy **مجاني** دلوقتي: مفيش licensing ولا billing.

## 5. البيئة (اقرا قبل ما تشغّل أي حاجة)

- **Nigafiy 1.0.3 متسطب وشغال** على جهازي (`C:\Program Files\LAN Detective\Nigafiy`، بيانات في `%APPDATA%\Nigafiy\data`، بورتات 47100/47130/47133 و47143 للـ LAN HTTPS). أوعى تسطب فوقه أو توقفه أو تلمس بياناته من غير ما أوافق. وقّف العمليات بالـ PID بس، مش بالاسم.
- **مينفعش الـ dev stack والبرنامج المتسطب يشتغلوا مع بعض:** الـ dev sensor بياخد UDP 67/53 والأجهزة بتظهر من غير أسماء. لو لازم، قولّي أقفل البرنامج من الـ tray (قفل الشباك لوحده مش بيقفله). بعد أي restart اتأكد من StartTime بتاع العملية.
- قبل أي تجربة desktop: اتأكد إن البورتات 47100/47130/47133/47143 و3100/4100/5433 فاضية، واستخدم `--user-data-dir=<scratch>`.
- مفيش Docker. Embedded PostgreSQL (dev 5433، tests عن طريق `NIGAFIY_TEST_PG_PORT`، كل builder ياخد بورت لوحده، و5487 و5490 ماسكهم PIDs مش بتوعنا). الـ API بـ `node` عادي من غير `--watch`.
- **الـ scan على 192.168.1.0/24 بس**، وأي نطاق تاني تسألني الأول.
- **باسورد الراوتر أنا بس اللي أكتبه.** حساب التجربة `tester@nigafiy.test` باسورده في `D:\network\.data\test-account.txt`.
- Android: `D:\nigafiy-tools\android-sdk` و`D:\nigafiy-tools\jdk17`، وadb في `platform-tools` (في Git Bash: `MSYS_NO_PATHCONV=1`). التليفون الحقيقي: Samsung A36.
- الإصدار: `NIGAFIY_SIGN_THUMBPRINT=398443A6F79F824F576A97DC43465E6684426915 JAVA_HOME='D:\nigafiy-tools\jdk17' ANDROID_HOME='D:\nigafiy-tools\android-sdk' node scripts/release/release.mjs --version X`، وبعدين انسخ `dist/release/X` مع الـ `.cer` و`Install-NigafiyTrust.ps1` لـ `D:\nigafiy-releases\X`.

## 6. طريقة الشغل

1. **ابدأ بجرد:** `git status`، والـ worktrees في `.claude/worktrees` (فيه منها قديم اتدمج؛ ما تمسحش حاجة غير لما تتأكد إنها متدمجة وتقولّي)، وتأكد إن مفيش جلسات تانية شغالة على نفس الملفات.
2. **اعرض عليّ خطة** مرتبة من القسم 3، كل بند فيه: هيعمل إيه، والـ migration لو فيه، والـ worktree، وإزاي هيتجرب. وبعد موافقتي نفّذ.
3. **builder لكل بند**، في worktree لوحده من آخر `phase-2-network-intelligence`، وبورت PostgreSQL لوحده، وcommit لكل خطوة. لو حاجتين مش بيلمسوا نفس الملفات ينفع يشتغلوا مع بعض؛ غير كده واحد ورا التاني.
4. **الـ gate** (إنت بتشغله بنفسك قبل أي دمج):
   - `pnpm typecheck` و`pnpm lint` و`pnpm check:brand` و`pnpm test:scripts`
   - `go vet` (windows/linux/darwin) و`go test` للـ agent والـ collector والـ engine
   - `pnpm build:agent` وبعدين الـ API suite لوحدها (`NIGAFIY_TEST_PG_PORT=<port>`). الـ real-agent tests بتفلك لو شغالة مع build في نفس الوقت
   - tests الـ desktop و`pnpm build` (وبعدها `git checkout -- packages/brand` عشان الـ build بيغيّر الـ SVGs لـ LF)
   - Playwright EN+AR على كل الصفحات
   - لو عدّى: fast-forward لـ `phase-2-network-intelligence`، وحدّث `status.md` (افصل real hardware عن tests).
5. **الـ push والإصدارات:** ما تعملش push ولا release ولا تسطيب غير لما أقولّك. بعد الـ push شوف الـ CI.
6. **لو قلتلك "وقّف واحفظ":** وقّف كل الـ builders، احفظ الشغل اللي مش متعمله commit كـ WIP commit في branch بتاعه، واكتبلي فين وصلنا وإيه اللي فاضل بالظبط، عشان أي جلسة جاية تكمّل من غير ما تعيد.

## 7. القرارات

**أنا اللي بقرر:** ترتيب الشغل، الدومين والاستضافة، أي حاجة بتتصرف فيها فلوس، تسطيب أو تغيير على جهازي أو الراوتر أو التليفون، الـ push، والأسئلة اللي في 3-ج.

**إنت اللي بتقرر وتكتب القرار في الـ docs:** التفاصيل التقنية، أسماء الـ identifiers، تقسيم الـ builders، وشكل الـ tests.
