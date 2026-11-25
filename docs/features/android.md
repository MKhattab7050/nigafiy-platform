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
   - **Device Owner QR** (only when the server has an agent APK to serve, `NIGAFIY_ANDROID_APK_PATH`): the
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
