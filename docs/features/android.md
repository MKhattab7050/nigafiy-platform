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
| Screen view (MediaProjection) | yes — the person accepts every session (Android's own dialog, §12); regular-app phones cannot be unattended | yes — **unattended allowed**: when the Fleet group policy is unattended the admin connects with **no per-session prompt**; Android's cast indicator stays on |
| Remote control: taps, swipes, Back / Home / Recents | yes — during an accepted screen session only, the person turns the service on (§12) | yes — follows the group policy, same as screen view: unattended allowed |
| File manager on shared storage (All files access, granted by the person) | yes, Android 11+ (§12) | yes |
| Ring the phone / show a message | yes (§12) | yes |
| Persistent notification "Managed by Nigafiy" | yes | yes (cannot be hidden; there is no stealth mode) |

The web shows each action only where the agent's reported mode allows it, and the API checks again.

### Access model for phones — no per-session consent on managed devices (2026-11-26)

Owner decision: a phone under IT management must not ask the person every time. A phone therefore
follows the **Fleet group access policy**, exactly like a Windows / Linux / macOS computer: *attended*
(the person accepts each session) or *unattended* (the admin connects with no per-session prompt). The
standing grant for an unattended session is the management relationship itself — the one-time consent
given at enrollment — so **unattended is offered only on a Device Owner (managed) phone**. A **regular-app**
phone can never be unattended: Android itself forces the MediaProjection dialog and the person's own
accessibility switch each session, and no app (ours included) can remove them. On every phone, managed or
not, the persistent **"Managed by Nigafiy"** notification and **Android's own screen-cast indicator** stay
on while a session is possible or running. There is no stealth mode and no silent capture: the admin is not
asked each time on a managed device, but the person at the phone can always see that it is managed and when
the screen is being viewed.

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
only. `android-sdk-preview-license` and every other license were not accepted.

**Emulator (later on 2026-11-25, builder EMU):** `emulator` 37.3.10 (1.1 GB installed) and
`system-images;android-36;default;x86_64` revision 2 (AOSP Android 16 without Google APIs or Play,
security patch 2025-07-05, 2.0 GB installed), through sdkmanager (SHA-1 checked by sdkmanager). Both
packages name only `android-sdk-license` in their `package.xml`; no other license was asked for or
accepted. `emulator -accel-check` reports "WHPX(10.0.26200) is installed and usable", so it runs
accelerated without enabling any Windows feature. The AVD lives in `D:\nigafiy-tools\avd`
(`ANDROID_AVD_HOME`), not in the user profile.

## 8. As built (2026-11-25)

**Android app** (`agents/android-agent`, Kotlin, framework APIs only, no third-party library):
- `core/`: plain JVM module (protocol, JSON, enrollment link, TLS pin check, gateway client, compliance
  rules, command parsing). Unit-tested on the JVM: 27 tests.
- `app/`: the Android app (minSdk 26, target/compile 36, `com.nigafiy.agent` 0.1.0): `AgentService`
  (foreground service, heartbeat 30 s, long poll), `Executor` (lock, password policy, camera, install,
  uninstall, wipe, release), `Facts` (inventory and the six compliance checks), `Store` (credential
  encrypted with an Android Keystore AES-GCM key), `Provisioning` (Device Owner admin extras),
  `MainActivity` (enroll by link or by hand, status, battery exemption), `BootReceiver`.

**API** (migrations `045_android_endpoints.sql`, `048_android_apk_files.sql`):
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
- APKs pushed from Fleet: `GET /api/v1/fleet/android/apks` (technician+), `POST /api/v1/fleet/android/apks`,
  `GET /api/v1/fleet/android/apks/:id/file` and `DELETE /api/v1/fleet/android/apks/:id` (admin; 100 MiB
  max, must be a zip/APK, de-duplicated by SHA-256 per organization; download and delete are audited).
  A phone may download an APK (`/api/v1/agent/android/apks/:id`) only while it has an open install
  command for it.

**Where APK files live** (migration 048, `apps/api/src/infrastructure/file-store.ts`): not in
PostgreSQL. Each APK is a file `<NIGAFIY_FILES_DIR>/apks/<organization id>/<sha256>`; `NIGAFIY_FILES_DIR`
defaults to `<NIGAFIY_DATA_DIR>/files` (else `<repo>/.data/files`). The row keeps `storage_key`
(`apks/<organization id>/<sha256>`), `size_bytes` and `sha256`.
- Upload streams the request body into `.tmp-<random>` in the organization's folder (never the whole APK
  in memory), fsyncs it, reads it back to check size and SHA-256, then renames it to its SHA-256. Paths
  are built only from the organization's UUID and the hex digest; no user text reaches the file system.
  One folder per organization, so the tenant boundary also holds on disk.
- Downloads (phone and admin) check the size before the first byte and the SHA-256 while streaming; the
  last chunk is held back until the digest matches, so a damaged file is never delivered complete.
  A missing or wrong-sized file is `409 apk_file_missing` / `apk_file_corrupt` (EN/AR in the phone
  panel); `install_apk` is refused the same way. Each case writes a `fleet.android_apk_file_problem`
  audit row. Uploading the same APK again repairs a missing or damaged copy
  (`fleet.android_apk_file_repaired`, HTTP 200 with `repaired: true`).
- Delete removes the file when no row references it (an advisory lock per file key serialises upload,
  delete and sweep). The job `fleet-apk-file-sweep` (right after start, then every 6 hours) removes
  stored files no row references (older than 1 hour) and temporary files of interrupted uploads (older
  than 6 hours), never a referenced file and never a file it does not recognise, and writes one
  `fleet.android_apk_files_swept` audit row per organization with what it removed.
- Existing installs: the migrator copies every `content` row to the store inside migration 048's
  transaction (`apps/api/src/database/apk-file-mover.ts`), one row at a time, and checks each against its
  recorded size and SHA-256; the SQL then refuses to continue unless every row was moved, and drops
  `content`. A failure rolls back with `content` untouched and the move runs again on the next start
  (files are content-addressed, so a second run reuses them). Applying 048 with `psql` while APKs exist
  is refused. Restoring an older backup that still has `content` runs the same move.
- Backups: `db:backup` no longer contains APKs; back up the files folder too
  (`docs/operations/backup-restore-and-key-rotation.md`).
- Object storage (S3-compatible) can plug in behind the `FileStore` interface later; no S3 client is
  included today (feature freeze).
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
- The API tests for Android (`apps/api/tests/fleet-android.test.ts`, 16 tests on a real PostgreSQL: the
  phone side is played by the test through the real agent protocol), the file store and migration 048
  tests (`apps/api/tests/apk-files.test.ts`: real disk, a real pre-048 database moved) and the full API
  suite. The APK file store has only run in these tests, never with a phone.
- Web unit tests (the QR encoder read back by a decoder; the enrollment codes) and a Playwright walk of
  the phone's page and the enroll dialog in English (light) and Arabic (RTL, dark), with a phone seeded
  through the agent protocol.

- The release APK on an Android 16 emulator as Device Owner, driven from Fleet's real API: see §11 for
  each action and the bugs this found.

Never ran:
- The app on a **real phone** (none was touched). Not seen on any device: QR provisioning by
  Android's setup wizard, the foreground service and long poll under Doze over hours, TLS pinning
  against Nigafiy LAN TLS (the emulator talked plain `http://` to 127.0.0.1 through `adb reverse`),
  a reboot (the boot receiver), and an erase that really resets a phone (the emulator cannot, §11).

## 11. Emulator real run (2026-11-25, builder EMU)

A scratch emulator (AOSP Android 16, API 36, x86_64, WHPX), the **signed release APK**, and the real
API + web on 127.0.0.1 with a throwaway PostgreSQL. The phone reached the API only through
`adb reverse tcp:3271 tcp:3271` (its own 127.0.0.1); nothing touched a LAN address. Device Owner was set
with `dpm set-device-owner` on the fresh emulator. Every action was sent through Fleet's API as an
admin with MFA (step-up for erase and stop management), exactly as the web sends it.

| Action | Result on the emulator |
| --- | --- |
| Enroll (the `nigafiy://` link from Fleet) | Enrolled after fixes 1 and 2 below. The endpoint shows online. |
| Heartbeat / facts | Android 16, API 36, patch 2025-07-05, 182 apps. Compliance flagged the old patch and USB debugging; "unknown sources" shows as not measured. CPU is stored as NULL, never 0. |
| Lock | The screen went off and locked; the command completed. |
| Camera off / on | logcat: "Camera disabled by device policy"; the camera app showed its error. Switching it on again worked. |
| Screen-lock requirement (medium) | Reported as not met; after a PIN was set on the emulator, the screen-lock check passed. |
| Install APK (a small test APK uploaded to Fleet) | Silent install; `pm` lists `com.nigafiy.emutest`; the download went through the install command only. |
| Remove app | Removed. Removing the agent itself is refused (`409 android_self_uninstall`). |
| Stop management | Device Owner cleared, the agent's service stopped, its notification removed, and the endpoint became revoked/offline (fix 5). The app showed the enroll form, and enrolling again worked without restarting the app (fix 6). |
| APK update over an enrolled agent | The service came back by itself (`MY_PACKAGE_REPLACED`), and the Device Owner notification was visible (fix 7). |
| Erase | Android accepted `wipeDevice` and the command reported done, **but the emulator did not reset**. Its kernel log says it cannot write the recovery command ("failed to find /misc partition"), so the emulator kept running. Fix 8 makes Fleet detect this. A real phone's erase was not tested. |

**Bugs found and fixed** (each with tests: `apps/api/tests/fleet-android.test.ts`, now 20 tests, and
the Kotlin JVM tests):
1. Android refused plain `http://` to 127.0.0.1 (cleartext blocked by default). Now
   `network_security_config.xml` allows cleartext only for `127.0.0.1` and `localhost`. Every other host
   still needs HTTPS.
2. On Android 15+ (edge-to-edge) the action bar and the system bars covered the app's content. The
   content is now padded by the system-bar, cutout and keyboard insets.
3. Every heartbeat failed with 400: the installed-app list contains the framework package `android`,
   which the package-name check refused. One-segment names are now accepted for the inventory. The
   uninstall check is unchanged (`android` cannot be removed).
4. Light heartbeats (without the app list) erased the stored app count. It is now kept.
5. After "Stop management" the phone kept a working credential. A confirmed release now revokes the
   endpoint (credential and enrollment token cleared, `endpoint.revoked` audited with reason
   `android_management_stopped`). A failed release revokes nothing.
6. After release the agent's service kept running with no credential and ignored a new enrollment. It
   now stops itself, and the app restarts it when a new enrollment is entered.
7. The Device Owner's management notification was hidden (Android 13+ notification permission). A
   Device Owner now grants its own `POST_NOTIFICATIONS`, so the user can always see that the phone is
   managed.
8. An erase that Android accepted but never carried out showed as done. Now, when the phone reports
   again more than 3 minutes after the erase completed **and its uptime shows it did not restart**,
   the erase becomes `failed` ("The phone is still running ...") with the audit row
   `fleet.android_wipe_not_done`. A wipe does not revoke the credential, so this report can still arrive.
   Verified live: the second erase on the emulator turned to failed.

**Scripts** (`scripts/android-emu/`, Node, loopback only, nothing needs admin rights):

| Script | What it does |
| --- | --- |
| `emulator.mjs create / start / prepare <apk> [port] / stop` | Creates the AVD `nigafiy-scratch`; boots it headless with its data wiped (port 5580); installs the APK, makes it Device Owner (retries while Android still says "accounts") and sets `adb reverse`; shuts it down. |
| `stack.mjs [--web]` | Throwaway PostgreSQL (5426), the API (3271) and optionally the web dev server (3272), all on 127.0.0.1; `--stop-file` stops it. |
| `fleet.mjs setup / show / act / upload / get / post` | A throwaway admin with MFA, an endpoint and its enrollment link; Android actions with step-up; APK upload; raw API calls. |
| `make-test-apk.mjs` | Builds the code-free test APK `com.nigafiy.emutest` for install/remove. |
| `web-shot.mjs` | A screenshot of a Fleet page, signed in as the throwaway admin. |
| `webrtc-browser.mjs` | The WebRTC real-browser run (`webrtc-networking.md` §7). |

A run: `emulator.mjs create` (once), `start`, `node scripts/android-emu/stack.mjs --web`,
`fleet.mjs setup`, `emulator.mjs prepare agents/android-agent/app/build/outputs/apk/release/app-release.apk`.
Then open the printed enrollment link on the emulator
(`adb -s emulator-5580 shell am start -a android.intent.action.VIEW -d '<link>'`), and send actions
with `fleet.mjs act '{"action":"lock"}'`. Erase only this scratch emulator; the next `start` wipes it
anyway.

## 12. Phone controls in regular app mode (app 1.0.2, 2026-11-25)

Asked by the owner after enrolling their own Samsung A36 (Android 16) as a regular app. Everything here
works without Device Owner and everything is visible on the phone while it happens. Nothing is hidden,
nothing reads messages or window text, and nothing logs keystrokes.

| Control | On the phone | In Fleet | Rules |
| --- | --- | --- | --- |
| Screen view | A high-priority notification "IT asks to see your screen" → a screen with who, why and what they will see → Android's own MediaProjection dialog → foreground service of type `mediaProjection` with a Stop button; Android shows its cast icon | Remote desktop tab (shown only when the phone reports `screen`). In **regular app mode** sessions are always attended (`consent_mode = prompt`) because Android forces its own dialog — the group's unattended policy does not apply here. A managed / Device Owner phone follows the group policy and may be unattended (§2, "Access model for phones") | Frames only after the person accepted (`consent_pending` before). Refusing, ignoring or closing Android's dialog ends the session. Stop on the phone ends it in Fleet (`/agent/rd-session/end`) |
| Remote control | Settings → Accessibility → Nigafiy (the person's own switch). A bar "Nigafiy: … is controlling this phone" stays on top while control is possible | Click = tap, hold = long press, drag = swipe, buttons Back / Home / Recent apps | Only inside an accepted session whose profile allows control. The service has no event types and `canRetrieveWindowContent=false`. Keys, text and the wheel are refused for phones (`unsupported_by_platform`); pointer down / move / up only for apps with `live_touch` (1.0.8) |
| File manager | Settings → All files access → Nigafiy (the person's switch, from the app's button) | Files tab (shown when the phone reports `files` and the access is granted) | Shared storage only (`SharedStorage.kt` confines paths); the usual file-manager roles: upload and delete are admin only, delete needs confirmation |
| Ring | Alarm sound at full alarm volume (the person's volume is put back), notification with Stop | Android panel → Phone controls → Ring / Stop ringing | technician and above, 5–120 s, audited (`endpoint.android_ring`) |
| Message | High-priority notification, plain text (title ≤ 120, text ≤ 600) | Android panel → Phone controls → Send message (`notify_user`) | technician and above, audited |

The phone reports in every heartbeat (`endpoints.android`): `features` (what this app build implements),
`all_files_access`, `accessibility_enabled`, `screen_capture`. The web shows a control only when the phone
reported it, and the API checks it again (`commands/guards.ts assertAndroidCommand`,
`fleet-android/actions.ts`, `capabilities.ts androidPhoneControls`). Migration 050 adds the
`android_ring` / `android_ring_stop` command kinds.

A server older than 1.0.2 refuses the new heartbeat fields (strict schema, 400). The app then reports
again without them (`Protocol.withoutPhoneControls`), so a newer phone never goes silent; seen on the
A36 before the PC was updated.

The phone app's screens were redesigned in 1.0.2 (header with the connection state, cards, a "Phone
controls" card with a coloured state and a button per control, light and dark), drawn in code
(`Ui.kt`) without new libraries.


### Live stream (app 1.0.3)

On 1.0.2 a phone's picture travelled one `rd_capture` command per frame (poll, capture, post the result,
then a 750 ms pause in the viewer): about one picture a second, and every tap waited for the same round trip.
From 1.0.3 the app opens the same live socket the Windows agent uses (`/api/v1/agent/stream`, `stream-hub.ts`)
once the person accepted, when the server's `rd_session_open` says `phone_stream: true` (older servers do not, and
the phone stays on the HTTP path there). Over it:

- a JPEG (one tile, `WsClient.framePacket`) is sent only when the screen drew something new (the ImageReader
  gives no image otherwise), at most 15 a second, at most 3 unacknowledged; the quality drops when acks are slow;
- taps, long presses, swipes and Back / Home / Recents come back as `input` messages; the hub checks them
  against what the phone reports (`validateCommandForPlatform(..., android)`), audits them (`via: live_stream`),
  and the app checks the session's control permission and the accessibility service again before acting;
- nothing is sent before consent (the hub reports zero viewers until the session is active) and the socket
  closes when the session ends here or in Fleet.

Code: `core/.../WsClient.kt` (a small RFC 6455 client, same TLS pin as the gateway), `app/.../LiveStream.kt`,
`ScreenCaptureService.grab`. Tests: `WsClientTest` (6), `PhoneControlsTest`, and
`fleet-android.test.ts` "live stream".

### Hardware video and a live finger (app 1.0.8)

The owner found the phone slow to watch from a computer (2026-11-27): every picture was a whole JPEG made in
software. From 1.0.8:

- **H.264.** The hello says `video: ["h264"]`. A browser that decodes H.264 with WebCodecs (and a session
  that is not recorded: the recording player shows JPEG only, so the hub drops the request then) sends
  `settings.codecs: ["h264"]`. The VirtualDisplay then draws straight into the phone's hardware encoder
  (`VideoEncoder.kt`, MediaCodec, no B-frames, real-time priority) at full size up to 1920 on the long side
  (multiples of 16; `VideoPlan` in core: 75 % below 1.8 Mbit/s, 50 % below 0.9 Mbit/s or when the console
  chose 50 %; the console's 75 % default is for JPEG and does not shrink video). Frames use the same packet (`fmt: "h264"`, one tile, `full` = key frame); key frames carry
  SPS/PPS, so the hub's "skip to the next full frame" for a slow viewer works unchanged, and `full` asks the
  encoder for a key frame. A still screen repeats its picture every 400 ms. The bitrate follows the quality
  (q45 ≈ 3.2, q68 ≈ 5.7, q85 ≈ 7.6 Mbit/s) and drops by a fifth while acks take over 450 ms. The browser plays it with
  `h264-player.ts`. A phone without an encoder, a browser without WebCodecs, or a decoder error: JPEG as before.
- **Live finger.** Phones that report the feature `live_touch` take `mouse_down` / `mouse_move` / `mouse_up`
  on the live stream (`ANDROID_LIVE_TOUCH_KINDS` in `guards.ts`). The accessibility service continues one stroke
  per move (`StrokeDescription.continueStroke`), so a list scrolls while the operator drags instead of
  replaying the swipe after they let go. Taps and long presses are unchanged; older apps keep the one-shot swipe.

Controlling a computer from a phone (the other direction) is in `touch-gestures.ts` / `touch-control.tsx`:
tap = click, slide = drag, hold or two-finger tap = right click, two fingers = scroll, pinch = zoom here, a
touchpad mode, the phone's keyboard and a bar of keys a phone keyboard lacks (Ctrl, Alt, Win, Esc, arrows,
F-keys, Ctrl+Alt+Del). The hub no longer waits for each input's audit row before the next message (rows are
still written, in order), and scrolling writes one audit row every 3 s.
