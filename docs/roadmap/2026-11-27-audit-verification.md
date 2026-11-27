# التحقق من تقرير المراجعة الشاملة (2026-11-27)

كل بند في تقرير "7 subsystems" اتشاف في الكود نفسه. الحالة:

- **مؤكد**: الكود بيعمل اللي التقرير قاله.
- **جزئي**: فيه مشكلة، بس أصغر أو مختلفة عن الوصف.
- **غلط**: الكود مش بيعمل كده.
- **ماتقاسش**: محتاج build أو جهاز حقيقي عشان يتأكد.

## البنود الحرجة (14)

| # | البند | الحالة | الدليل والملاحظة |
|---|---|---|---|
| 1 | Quick Support ينفّذ أوامر خارج `Limited()` | **مؤكد** | `internal/agent/agent.go:597-609`: أوامر session/jobs/patch/shell بتتنفّذ قبل `ExecuteCommand`. السيرفر الحقيقي بيرفض أي أمر غير `rd_capture`/`rd_input`/`fs_op`/`notify_user` لأجهزة Quick Support (`commands/service.ts:64`)، فالخطر لو المستخدم دوس على لينك بيشاور على سيرفر مهاجم. `ag.Run` بيشتغل مع ظهور شاشة الكود (`nigafiy-support/main.go:137`). |
| 2 | التحديث مش شغال في النسخة المتثبتة | **مؤكد** | `engine-stack.cjs:142-150` مابيبعتش `--bundle-dir`. والـ desktop بيبعت `NIGAFIY_BUNDLE_DIR`، والـ engine بيقرأ بس `NIGAFIY_ENGINE_BUNDLE_DIR` (`config.go:107`). النتيجة إن `BundleDir` بيبقى فاضي، و`update.go:91` بيرجّع "source checkout". اختيار البرامج بيقرأ HKCU وHKLM مع بعض (`programs.go:77`). |
| 3 | تصعيد صلاحيات للـ SYSTEM | **جزئي** | الخدمة بتتعمل بدون حساب محدد (`service_windows.go:132`)، يعني LocalSystem. HTTPS بيسمع على `0.0.0.0:47143`. `Verify` بيعدّي من غير فحص Authenticode لو `publisher == ""` (`update/update.go:127`). الـ Ed25519 بيتفحص في الـ API (`platform/updates.ts`) مش في الـ engine. المسارات اللي المستخدم يقدر يكتب فيها وحكاية الـ TOCTOU مش متحقق منها لسه. |
| 4 | باسورد `postgres:postgres` | **مؤكد** | `.env.example:7-8`، و`local.mjs:154-166` بيغيّر بس مفتاح التشفير وباسورد التطبيق. `mode: 0o600` مالوش تأثير على ويندوز. |
| 5 | Web Push بيفشل على Node 24 | **مؤكد** | `webpush.ts:242` بيرجّع عنوان واحد حتى لما يتطلب `all: true`، والتستات عاملة mock لـ `pushTransport.send`. |
| 6 | طلب upgrade واحد يوقّع الـ API | **مؤكد** | `stream-hub.ts:447` فيه `new URL` من غير try، و`main.ts` مفيهوش handler لـ `uncaughtException`. أما `decodeURIComponent` في `session.ts:16` فبيتنادى من مسار الـ upgrade (`stream-hub.ts:803`) جوه دالة async، فالأرجح يطلع unhandled rejection مش crash، ويبقى البند ده **جزئي**. |
| 7 | `phoneDashboardProxy` قبل helmet والـ rate limit | **مؤكد** | `app.ts:54-55`، ويضرب `systemPool` لكل كوكي جديد، و`seen.clear()` عند 500. |
| 8 | الـ scheduler ممكن يعلق، و`/readyz` بيكدب | **مؤكد** | `telegram.ts:78` فيه idle timeout بس، مفيش deadline إجمالي. `scheduler.ts:202` بيحدّث `lastProgressAt` في `finally` حتى لو الجوب فشل. |
| 9 | حقن أوامر في VyOS restore | **مؤكد** | الـ regex `^set [A-Za-z0-9_-]+( |$)` (`restore_vyos.go:51`)، وباقي السطر مابيتفحصش. |
| 10 | أخطاء في الـ router drivers | **مؤكد** (D-Link, Tenda, MikroTik, ASUS) / **جزئي** (pfSense) / **ماتقاسش** (Huawei LTE) | D-Link: الـ key والـ data معكوسين في الـ PrivateKey (`dlink.go:155`). Tenda: الـ transport بيرفض أي redirect بخطأ (`transport.go:82`)، فـ 302 عمره ما يوصل. MikroTik: dstnat من غير `in-interface` ولا `dst-address-type`. ASUS: `readPortForwards` بيفلتر صفوف والحذف بيستخدم index الليستة المفلترة على الليستة الكاملة. pfSense: الشرط ده مكتوب في الـ capability note ("requires a LAN block rule")، بس النتيجة لسه بتقول applied. Huawei LTE محتاج راوتر حقيقي. |
| 11 | Android `AgentService` بيعلق | **مؤكد** | `AgentService.kt:39` فيه ثريدين بس، والاتنين ماسكينهم `loop()` و`pollLoop()`. |
| 12 | كوكيز الـ WebView مابتتمسحش | **مؤكد** | `CookieManager` بيتستخدم بس لـ `setCookie` (`DashboardScreen.kt:146`). مفيش `dataExtractionRules`، والـ `targetSdk` هو 36. |
| 13 | "never hidden" ضد "silent by default" | **مؤكد (الكلام)** | migration 052 دي قرار منك إنت (2026-11-26)، بس `README.md:141` و`docs/security/model.md:16` لسه بيوعدوا بـ consent وbanner. المطلوب نصلّح النصوص، مش الكود. |
| 14 | `local.mjs` بيصرّح بأي شبكة | **مؤكد وأسوأ** | `local.mjs:702-707`، ومن غير audit log. و`ON CONFLICT ... SET enabled = true` كمان بيرجّع يفعّل شبكة إنت كنت قفلتها. |

## الـ API (HIGH)

| البند | الحالة | الملاحظة |
|---|---|---|
| fs_op / power / jobs من غير سياسة المجموعة | **مؤكد** | `commands/service.ts` و`fleet-jobs/jobs.ts` مابينادوش `evaluatePolicy`. `commandRefusal` بيشتغل بس جوه جلسة. |
| الجلسات الحية مابتتقفلش عند deactivate | **مؤكد** | `team.ts:283` بيمسح صفوف `sessions` بس، ومفيش إعادة تحقق في `stream-hub` أو `fleet-shell` أو SSE. |
| تحديثات المنصة لأي admin | **مؤكد** | `platform/index.ts` فيه `requireRole('admin')` بس. |
| إيقاف Tailscale serve | **جزئي** | المسار owner-only، بس `assertMayChange` بيتفحص بس لما `on=true`. |
| OIDC | **جزئي** | فيه timeout و`redirect: 'error'`، بس مفيش SSRF guard ولا حد لـ `res.text()`، والكاش من غير eviction. `email_verified` الناقصة (undefined) بتعدّي. `trust_idp_mfa` افتراضيًا `true`. |
| step-up من غير شرط atomic | **مؤكد** | `step-up.ts:77`. |
| admin يقدر يطفي `mfa_required` | **مؤكد** | `team.ts` (`PATCH /team/security`). |
| `/auth/password` من غير limiter | **مؤكد** | `routes.ts:349`. ومسار reset مابيمسحش `desktop_password_hash`: ماتأكدتش بالكامل، `PERSON_CHOSE_PASSWORD_SQL` محتاج يتقرا. |
| الـ viewer بيشوف مين معندوش MFA | **مؤكد** | `GET /team` من غير `requireRole`، و`mfa_enabled` جوه `MEMBER_SELECT`. |
| أخطاء جوبات tenants تانيين | **جزئي** | `jobHealth` على مستوى السيستم كله، والرسائل بتعدّي على `safeErrorMessage`. |
| Sync I/O في التسجيلات | **مؤكد** | `fs.readFileSync` للسيجمنت كله (لحد 256 MiB)، و`writeSync` على كل فريم. |
| `scryptSync` و gzip من غير حد | **مؤكد** | `logical-backup.ts:66` و`:155`. |
| `icacls /reset` | **مؤكد** | `lan-tls.ts:104-105`: فيه فجوة صغيرة بين الـ reset ومنع الوراثة. |
| Retention | **مؤكد** | `audit_logs` و`fleet_shell_transcript` و`fleet_job_outputs` و`notification_deliveries` و`phone_alerts` مش موجودين في `retention.ts`، والـ `DELETE` مش مقسّم على دفعات. |

## الويب

| البند | الحالة | الملاحظة |
|---|---|---|
| الطباعة متمنوعة بسبب الـ CSP | **مؤكد** | مفيش `frame-src`، و`default-src 'self'` بيمنع iframe من نوع `blob:`، والكود بيسجّل "printed". |
| `window.prompt` و`window.confirm` | **مؤكد** | `use-remote-files.ts:204-240`، و`android-panel.tsx:216-341` (فيهم wipe و release). |
| `crypto.subtle` على HTTP LAN | **مؤكد** | `use-session-tools.ts:45`. |
| Strict Mode و `alive` | **مؤكد** (dev بس) | `use-transfer-queue.ts:71`. ماشفتش نفس النمط في `use-remote-files.ts`. |
| WoL deps فيها `rd` | **مؤكد** | `use-session-tools.ts` (deps `[epId, wakeId, wakeState, rd]`). |
| `ld_site` بيتسرّب | **جزئي** | بيترجع من `localStorage` من غير ما يتأكد إنه تابع للمؤسسة (`app.tsx:128`). |
| `'use client'` في كل حتة | **مؤكد** | 65 من 68 صفحة، والـ layout كمان. |
| أحجام الـ bundle والترجمة | **ماتقاسش** | محتاج build. |
| `useApp()` 129 مرة و `isAr ?` | **مؤكد** | 129 و99 (التقرير قال 153). `doctor.ts` فيه 827 سطر (التقرير قال 1,396 لكذا ملف). |
| مفيش تستات component | **مؤكد** | مفيش vitest ولا RTL، و`test:unit` متكتب ملف ملف. |

## الـ LAN Sensor

| البند | الحالة | الملاحظة |
|---|---|---|
| icmp/tcp من غير فحص الـ scope | **مؤكد** | `agent.go:772-791` و`monitoring/routes.ts` مابيفحصوش الـ scope ولا العناوين الخاصة. |
| `seenCmds` بيتمسح عند 2048 | **مؤكد** | `agent.go:493`. |
| SSH legacy لكل الأجهزة | **مؤكد** | `configbackup.go:331,360`. |
| Huawei iterations من غير حد | **مؤكد** | `huawei.go`: فيه حد أدنى بس. |
| الـ spool plaintext | **جزئي** | `0o600`، ومالوش تأثير على ويندوز، ومش متشفر. |
| DNS من غير cache وبيحجز buffer لكل استعلام | **مؤكد** | `server.go:289`. وقوايم من `master` من غير hash. |
| AAAA | **جزئي** | AAAA المحظور بيرجع فاضي. موضوع كسر IPv6 GUA وتخطي قواعد الـ MAC ماتقاسش. |
| systemd و Dockerfile | **مؤكد** | `CAP_NET_RAW` بس، و`MemoryMax=128M`، ومفيش `traceroute` ولا `nmcli`. |
| Sanitizer ناقص | **ماتقاسش بالتفصيل** | محتاج عينات configs. |

## الـ Endpoint Agent

| البند | الحالة | الملاحظة |
|---|---|---|
| `Start-Service -Force` | **مؤكد** | `control.go:182`. |
| `LockWorkStation` من Session 0 | **مؤكد غالبًا** | `control/session.go:328` بيشغّل `rundll32` من خدمة الـ SYSTEM. |
| timeout 25 ثانية لمديري الحزم | **مؤكد** | `control.go:87`. و`winget` بالاسم بس. |
| Deadlock 45 ثانية من الـ Tray | **غلط** | `helper.go:254` بينادي `go fn()`، يعني غير متزامن. |
| حماية المجلد الأب | **مؤكد** | `isProtectedSystemPath` بيفحص المسار نفسه وأولاده بس، مش أجداده. `/private/etc` مش في الليستة. |
| FIFO / ADS / أسماء DOS | **ماتقاسش بالكامل** | فيه تعرّف على FIFO في `handles_unix.go:145`، وماشفتش منع لـ ADS. |
| RD بيكمّل لو الـ banner فشل | **مؤكد** | `rdstream/session.go:275`. |
| PowerShell كل 20 ثانية | **مؤكد** | `collectWindowsHealth` مع كل heartbeat (20 ثانية). فيه كاش بيتكتب بس مابيمنعش التشغيل. |

## الـ Engine والـ Desktop والـ Installer

| البند | الحالة | الملاحظة |
|---|---|---|
| `/D=` جوه quotes | **مؤكد** | `RunInstaller` بيستخدم `exec.Command` (`system_windows.go:67`)، وGo بيحط quotes على أي argument فيه مسافة. أما المسار المرفوع (elevated) فسليم. |
| `Trust-Nigafiy.cmd` | **مؤكد (تصميم)** | `RunAs` + `Bypass` + `Invoke-Expression` على الملف نفسه + `LocalMachine\Root`. ده قرارك في 2026-11-27. |
| NSIS بيشغّل uninstaller من HKCU | **مؤكد** | `nigafiy.nsh` (`ExecWait` على `InstallLocation` من HKCU و`LOCALAPPDATA`). |
| Electron من غير `will-redirect` | **مؤكد** | وفيه `openExternal` تلقائي في `will-navigate`. |
| مفيش permission handlers | **غلط** | `main.cjs:178` فيه `setPermissionRequestHandler`. |
| سجلات الـ Sensor من غير redaction | **غلط** | `collector-manager.cjs:135` فيه `redact()` وبيتنادى في `pushLog`. |
| `embedded-postgres` بيتا | **مؤكد** | `18.6.0-beta.19`. |

## Android

| البند | الحالة | الملاحظة |
|---|---|---|
| "no Google Play services" | **مؤكد** | `play-services-code-scanner` و`useAndroidX=true`. |
| WebView بيضغط `proceed()` على أي خطأ | **غلط** | `DashboardScreen.kt:274` بيوافق بس لو الشهادة نفس الـ pin ونفس السيرفر. |
| hostname verification مقفول مع الـ pin | **مؤكد** | `Gateway.kt:43` (وفيه pin بالـ CA بتاعنا). |
| `server_addresses` بيقبل أي https | **مؤكد** | `ServerAddresses.kt:24`. |
| `ACTION_VIEW` لأي scheme | **مؤكد** | `DashboardScreen.kt:242`. |
| تثبيت APK من غير فحص التوقيع والحزمة | **جزئي** | فيه فحص sha256 من السيرفر، ومفيش فحص للتوقيع ولا الـ package ولا الـ downgrade. |
| `ws://` و `soTimeout = 0` | **جزئي** | `ws://` بيتستخدم بس لما السيرفر نفسه `http://`. و`soTimeout = 0` بعد الـ handshake (`WsClient.kt:166`). |
| JSON بيقبل أرقام عربية | **مؤكد** | `Char.isDigit()` بيقبل `٠-٩`. |

## نظافة الـ repo والتوثيق والـ CI

| البند | الحالة | الملاحظة |
|---|---|---|
| 8 worktrees في الـ repo | **غلط جزئيًا** | الـ 8 موجودين على الديسك بس متجاهلين في git، يعني مش في الـ repo. |
| handoff prompts في `docs/` | **مؤكد** | 18 ملف في `docs/superpowers` و`docs/roadmap` في git. الـ thumbprint والمسارات في `2026-11-26-nigafiy-full-platform-prompt.md:73-74`. الـ thumbprint بتاع شهادة عامة ومش سر، بس المسارات واسم التليفون حاجات شخصية. |
| الموقع بينشر `docs/operations` | **مؤكد** | `apps/site/lib/docs.ts`. فيه كلام داخلي في `docs/operations/real-hardware-checklist.md`. |
| ملفات ضخمة | **مؤكد** | الأرقام مطابقة تقريبًا (`stream-hub.ts` بقى 1,572). |
| Biome | **مؤكد** | الـ formatter مقفول، و`noExplicitAny` و`useExhaustiveDependencies` على warn. عدد الـ 264 warning ماتقاسش. |
| CI | **مؤكد** | job ويندوز واحد و3 لينكس، ومفيش Android ولا CodeQL ولا golangci-lint. |
| docker-compose | **مؤكد** | `timescaledb:latest-pg17` و`redis:7-alpine`. |

## الخلاصة

- التقرير دقيق في الغالب. فيه 4 بنود **غلط**: deadlock الـ tray، وpermission handlers في Electron، وredaction سجلات الـ Sensor، وWebView `proceed()`. وبند الـ worktrees نصه غلط.
- أهم حاجتين **أسوأ** من الوصف: `local.mjs` بيرجّع يفعّل شبكات إنت قفلتها، وسياسات المجموعات مش بتتطبق خالص على `fs_op`/`power_action`/`jobs` برّه جلسة.
- بنود محتاجة قياس أو جهاز حقيقي: أحجام الـ bundle، والـ sanitizer، وHuawei LTE، وIPv6 في الـ DNS filter، وFIFO/ADS.
