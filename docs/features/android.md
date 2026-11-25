# Nigafiy Android management (free, sideloaded)

Owner decisions (2026-11-25): Android management is **free**. The agent is installed by APK sideload or
private distribution. No Google Play, no Firebase/FCM, no Google or paid account, no Android Enterprise
EMM registration. iOS is out of scope (it needs a paid Apple account for MDM push certificates).

Migration `045_android_endpoints.sql` (2015's `015_remove_mobile_mdm.sql` removed an earlier attempt that
had no on-device app, so its commands could never run; this time the Device Policy Controller app is part
of the product: `agents/android-agent`).

## 1. What free Android management can and cannot do

Android offers three levels to an app that is not distributed through Play and has no EMM registration.
Sources are the Android developer documentation (links below, read 2026-11-25).

| Mode | How it is reached | What it allows | What it does not |
| --- | --- | --- | --- |
| **Regular app** | Install the APK (allow "Install unknown apps" for the browser or file manager) | Read device facts any app may read: model, Android version, security patch level (`Build.VERSION.SECURITY_PATCH`), storage (`StatFs`), battery (`ACTION_BATTERY_CHANGED`), Wi-Fi/IP (`ConnectivityManager`/`LinkProperties`), installed apps (`PackageManager`, needs `QUERY_ALL_PACKAGES` on Android 11+), screen lock set (`KeyguardManager.isDeviceSecure`), encryption status (`DevicePolicyManager.getStorageEncryptionStatus`), developer options and USB debugging (`Settings.Global.DEVELOPMENT_SETTINGS_ENABLED`, `ADB_ENABLED`), whether the agent may install unknown apps (`PackageManager.canRequestPackageInstalls`) | Lock, wipe, camera, password policy, silent app install/uninstall |
| **Device Admin** (`DeviceAdminReceiver` activated by the user) | Settings → Security → Device admin apps | `lockNow`, `wipeData` | **Deprecated.** Since Android 9 the camera, password-quality/expiry and encryption policies are deprecated for device admins, and on Android 10+ an app targeting API 29+ that is only a device admin gets a `SecurityException` for them ([Device admin deprecation](https://developer.android.com/work/device-admin)). Nigafiy therefore does **not** offer a Device Admin mode: it would give only lock and wipe, behind a deprecated API Google says will be removed. |
| **Device Owner** (the agent is the device's Device Policy Controller) | (a) `adb shell dpm set-device-owner com.nigafiy.agent/.admin.NigafiyAdminReceiver` on a phone with **no accounts** added (fresh or factory reset, setup finished without signing in), or (b) **QR provisioning** on a factory-reset phone: tap the welcome screen six times, scan the Nigafiy Device Owner QR ([Build a DPC: provisioning](https://developer.android.com/work/dpc/build-dpc), [QR provisioning extras](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#EXTRA_PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION)) | `lockNow`, `resetPasswordWithToken` / password requirements (`setRequiredPasswordComplexity`), `wipeDevice`/`wipeData`, `setCameraDisabled`, silent install through `PackageInstaller` sessions and silent uninstall (Device Owner apps may commit install sessions without user confirmation: [PackageInstaller](https://developer.android.com/reference/android/content/pm/PackageInstaller)), `FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED` for the agent service ([Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types#system-exempted)) | Anything Play-only (managed Google Play, zero-touch, Play Integrity). Removing Device Owner requires a factory reset or the agent clearing itself (`clearDeviceOwnerApp`, done by "Stop management" in Fleet). |

`dpm set-device-owner` refuses when any account exists on the phone ("Not allowed to set the device owner
because there are already some accounts on the device"); that is why the owner steps below start from a
factory reset. Neither path needs a Google account, Play or an EMM token: QR provisioning downloads the
APK from a URL the administrator controls and checks its SHA-256 (`PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM`,
URL-safe base64 of the APK's SHA-256).

## 2. What Nigafiy offers per mode

| Feature | Regular app | Device Owner |
| --- | --- | --- |
| Enrollment by code or QR from Fleet | yes | yes (also QR provisioning with the enrollment in the admin extras) |
| Heartbeat, inventory (model, OS, patch level, storage, battery, Wi-Fi/IP, installed apps) | yes | yes |
| Compliance facts: screen lock, encryption, patch age, developer options, USB debugging, unknown sources | yes | yes |
| Lock now | no (refused by the API: `android_requires_device_owner`) | yes |
| Screen-lock password policy (required complexity; reset the password with a token the operator never sees) | no | yes |
| Disable / enable camera | no | yes |
| Install an APK pushed from Fleet / uninstall an app | no | yes (silent) |
| Wipe (factory reset) | no | yes, admin only, MFA step-up always, second-admin approval when the endpoint's Fleet group asks for approvals |
| Persistent notification "Managed by Nigafiy" | yes | yes (cannot be hidden; there is no stealth mode) |

The web shows each action only where the agent's reported mode allows it, and the API checks again.

## 3. Enrollment flow

1. An admin opens **Fleet → Endpoints → Enroll**, picks **Android** and gets the usual single-use
   enrollment token (`ldea_…`, 24 h, hashed in the database).
2. The dialog shows:
   - **App enrollment QR**: `nigafiy://enroll?server=<url>&token=<ldea_…>&pin=<sha256>`. The phone's camera
     app opens the Nigafiy agent through its `nigafiy://enroll` intent filter, so the agent needs no
     camera permission and no QR library. The same three values can be typed by hand.
   - **Device Owner QR** (only when the server has an agent APK to serve: `NIGAFIY_ANDROID_APK`, default `agents/android-agent/app/build/outputs/apk/release/app-release.apk`): the
     Android provisioning JSON with the component name, the APK download URL
     (`/api/v1/agent/android/agent.apk`), its SHA-256 and the enrollment in
     `PROVISIONING_ADMIN_EXTRAS_BUNDLE`.
3. The agent calls `POST /api/v1/agent/enroll` with `platform: "android"` and receives the credential
   `lda_<endpoint-id>.<secret>`, stored in the app's private storage, encrypted with an Android Keystore
   AES-GCM key that never leaves the phone.

## 4. Transport without FCM

There is no push service. The agent runs a foreground service with a persistent notification and uses
the existing agent gateway: heartbeat every 30 s (`/api/v1/agent/heartbeat`), long poll for commands
(`/api/v1/agent/poll?wait_ms=25000`, woken through `pg_notify` on any API instance), and results through
`/api/v1/agent/command-result`.

Battery notes:
- A held HTTPS long poll costs one idle TCP connection; the radio wakes when a command arrives or every
  25 s at most. Doze defers network access for apps that are not exempt; a Device Owner agent runs its
  service as `systemExempted`, a regular-app agent asks the user once to exempt it from battery
  optimisation (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, the standard settings screen, the user
  can refuse). When the phone is in Doze anyway, commands wait until the next maintenance window: the
  web shows the command as pending, never as done.
- The agent restarts after a reboot (`BOOT_COMPLETED`) and after an app update (`MY_PACKAGE_REPLACED`).

## 5. Security

- Token prefixes as everywhere (`docs/architecture/naming.md`): `ldea_` enrollment, `lda_` credential.
- TLS: system trust by default; when Fleet shows a pin (Nigafiy LAN TLS), the agent pins it exactly like
  the Windows agent (`VerifyPinnedChain`): the SHA-256 of the leaf certificate, or of a CA certificate
  in the chain that the leaf verifies against. Plain `http://` is refused unless the server is a
  loopback address (development only).
- Commands are accepted only from the authenticated poll; each command id runs at most once.
- The release APK is signed with a key generated locally (`.data/android/release.jks`, never committed;
  its passwords live in `.data/android/keystore.properties`). Losing that key means sideloaded phones
  cannot take updates (Android refuses an update signed by another key), so the owner backs it up.
- Operator actions go through the same rules as the rest of Fleet: roles, the endpoint's Fleet group
  (allowed roles, address allow-list, hours, MFA step-up, approvals), audit rows, and refusals audited as
  `fleet.policy_refused`.

## 6. Updating a sideloaded APK

Without Play there is no automatic store update. Two paths:
- **Device Owner:** Fleet → the endpoint → Android → "Install APK" with a newer Nigafiy agent APK. The
  agent installs it through `PackageInstaller` silently (same signing key required), then restarts.
- **Regular app:** the person installs the newer APK by hand (Android asks them to confirm).

## 7. Build tools downloaded on this PC (2026-11-25)

All on `D:\nigafiy-tools`, no admin rights, nothing system-wide (no PATH, registry or environment changes
outside the build shell). Checksums are SHA-256 and matched the publisher's own published value.

| What | From | Size | SHA-256 | Where |
| --- | --- | --- | --- | --- |
| Eclipse Temurin JDK 17.0.21.1+2 (Windows x64 zip) | github.com/adoptium/temurin17-binaries (value from api.adoptium.net) | 191,150,540 B | `eafba0944f777abdc74d5aad16049c9b5a1275b6ce99e2939ba9f7f3e6f08c87` | `jdk17` |
| Android command-line tools, Windows, build 15859902 | dl.google.com (value from developer.android.com/studio) | 155,655,386 B | `90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a` | `android-sdk\cmdline-tools\latest` |
| Gradle 9.9.2 (bin) | services.gradle.org (value from its `.sha256`) | 134,970,550 B | `971fcd7150ca4ba04852c0b2ca0d2d0ab9468e14b03473eab19528809914c76b` | `gradle-9.9.2` |
| `platform-tools` r37.0.3, `platforms;android-36`, `build-tools;36.0.0` | sdkmanager (dl.google.com; sdkmanager checks each archive's SHA-1 from Google's repository XML) | 18 MB + 127 MB + 137 MB installed | checked by sdkmanager | `android-sdk` |

**License:** the SDK packages require Google's *Android Software Development Kit License Agreement*
(`android-sdk-license`). The owner accepted it on 2026-11-25 ("Yes, accept it"), for these three packages
only. `android-sdk-preview-license` and every other license were not accepted. No emulator and no
system image were downloaded.

## 8. As built (2026-11-25)

**Android app** (`agents/android-agent`, Kotlin, framework APIs only, no third-party library):
- `core/`: plain JVM module (protocol, JSON, enrollment link, TLS pin check, gateway client, compliance
  rules, command parsing). Unit-tested on the JVM: 27 tests.
- `app/`: the Android app (minSdk 26, target/compile 36, `com.nigafiy.agent` 0.1.0): `AgentService`
  (foreground service, heartbeat 30 s, long poll), `Executor` (lock, password policy, camera, install,
  uninstall, wipe, release), `Facts` (inventory and the six compliance checks), `Store` (credential
  encrypted with an Android Keystore AES-GCM key), `Provisioning` (Device Owner admin extras),
  `MainActivity` (enroll by link or by hand, status, battery exemption), `BootReceiver`.

**API** (migration `045_android_endpoints.sql`):
- `endpoints.platform` accepts `android`; the phone's own state is kept in `endpoints.android`.
- Android has no CPU load for apps: `cpu_pct` is stored as NULL (never 0), and a CPU monitoring rule on a
  phone reads "not measured", never a breach.
- Generic endpoint commands are refused on a phone (`unsupported_by_platform`) except "refresh inventory".
- `POST /api/v1/endpoints/:id/android/actions` with `lock` / `password_policy` / `camera` (technician),
  `install_apk` / `uninstall` (admin), `wipe` / `release` (admin, MFA step-up always, second-admin approval
  when the Fleet group asks for approvals). Refusals: `android_requires_device_owner`,
  `android_self_uninstall`, `endpoint_offline`, and every Fleet group rule (audited as
  `fleet.policy_refused`). The step-up code never reaches the audit log.
- Approvals: `GET /api/v1/fleet/android/requests`, `POST /api/v1/fleet/android/requests/:id/approve|deny`
  (not by the requester; requests expire; rows cannot be deleted).
- APKs pushed from Fleet: `GET|POST /api/v1/fleet/android/apks`, `DELETE /api/v1/fleet/android/apks/:id`
  (100 MiB max, must be a zip/APK, de-duplicated by SHA-256). A phone may download an APK
  (`/api/v1/agent/android/apks/:id`) only while it has an open install command for it.
- `GET /api/v1/agent/android/agent.apk` serves the Nigafiy agent itself for QR provisioning (with its
  SHA-256 in `X-Content-SHA256`); `GET /api/v1/fleet/android/provisioning` gives the web what the
  Device Owner QR needs.

**Web** (EN and AR, RTL): Android in the enroll dialog (app-link QR plus the three values to copy;
Device Owner QR or, when no APK is built, the `adb` command), the phone panel on the endpoint page
(mode, facts, actions shown only when the mode allows them, APK upload, remove app, erase / stop
management with reason and code), requests on the endpoint and on Fleet → Approvals, Android in the
platform mix and filters, and a guide section (Add a computer to Fleet → Android phones). The QR codes
are drawn by Nigafiy's own encoder (`features/endpoints/components/android/qr.ts`), checked by a test that
reads every code back.

**Build:** `pnpm android:keystore` once (creates `.data/android/release.jks` and
`keystore.properties`, random passwords, never committed, never printed), then `pnpm build:android`
(JVM tests, debug APK, release APK, then `aapt2 dump badging` and `apksigner verify`). `pnpm test:android`
runs the JVM tests only (no SDK needed).

| APK | Path | Signed by |
| --- | --- | --- |
| debug | `agents/android-agent/app/build/outputs/apk/debug/app-debug.apk` | the SDK's debug key (`CN=Android Debug`) |
| release | `agents/android-agent/app/build/outputs/apk/release/app-release.apk` | the local release key (`CN=Nigafiy Agent, O=Nigafiy (local key)`, RSA 3072, APK Signature Scheme v2) |

## 9. Owner steps

1. Build: `pnpm android:keystore` (once; back up `.data/android/` somewhere safe), then
   `pnpm build:android`. The release APK lands at the path above; the API serves it to phones.
2. Use **HTTPS** for the server phones reach (Nigafiy LAN TLS); Android refuses plain `http://` except
   loopback. The enroll dialog warns when the address will be refused.
3. **Regular app (any phone):** copy `app-release.apk` to the phone, install it (allow "install unknown
   apps" for the file manager once, then switch it off again), open Fleet → Managed computers → Enroll
   endpoint → Android, scan the first QR with the phone's camera (or type server, token and pin in the
   app). You get inventory and compliance; no lock, wipe, camera, password or app control.
4. **Device Owner (a test phone you may erase):**
   - QR: factory-reset the phone, tap the welcome screen six times, connect to Wi-Fi, scan the second
     QR. Android downloads the app from the server, checks its SHA-256 and enrolls it.
   - Or adb: on a phone with no accounts added, enable USB debugging, `adb install app-release.apk`, then
     `adb shell dpm set-device-owner com.nigafiy.agent/.admin.NigafiyAdminReceiver`, then enroll as in 3,
     then switch USB debugging off (Fleet flags it as non-compliant).
   - What is lost without Device Owner: lock, screen-lock policy, camera, silent app install and removal,
     erase. "Stop management" removes Device Owner without a factory reset.
5. Try every action once on the test phone and watch the result in the endpoint's commands tab.

## 10. What ran here and what never ran

Ran on this PC, for real:
- Kotlin JVM unit tests of `core` (27, pass).
- The debug and release APK builds (Gradle 9.9.2, AGP, build-tools 36.0.0), inspected with
  `aapt2 dump badging` (package, version, SDK levels, permissions) and `apksigner verify --print-certs`
  (signature v2 verifies; release signer is the local key).
- The API tests for Android (`apps/api/tests/fleet-android.test.ts`, 13 tests on a real PostgreSQL: the
  phone side is played by the test through the real agent protocol) and the full API suite.
- Web unit tests (the QR encoder read back by a decoder; the enrollment codes) and a Playwright walk of
  the phone's page and the enroll dialog in English (light) and Arabic (RTL, dark), with a phone seeded
  through the agent protocol.

Never ran:
- The app on any Android phone or emulator (no real phone was touched; no emulator or system image
  is approved). So nothing on the phone side has been seen working: enrollment from the app, the
  foreground service and long poll under Doze, Keystore storage, TLS pinning on a device, any
  Device Owner action (lock, password, camera, install, uninstall, wipe, release), QR provisioning by
  Android's setup wizard, and the boot / update restart. Treat the first test-phone run as the first
  real test.
