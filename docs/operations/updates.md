# Updates

Nigafiy checks for a newer release, downloads it, verifies it, stages it and installs it **only when
an owner or administrator confirms**. Nothing is installed in the background, and nothing is sent
anywhere: the install only fetches a signed manifest and the file it names.

```
release build ──► manifest.json (Ed25519-signed) + installers (Authenticode-signed), on your HTTPS host
                                    │
   API (any role)   GET  /platform/updates          check: manifest signature, newer version?
   API (admin)      POST /platform/updates/download  download over HTTPS, size limit, SHA-256, publisher
                                    │                 → <data>/updates/staged/Nigafiy-Update-<v>.exe
   API (admin)      POST /platform/updates/install   { version, confirm: true }  (the confirm dialog)
                                    │                 hash again → engine POST /v1/update/apply
   engine                            validate, hash, publisher again; copy itself to the update helper;
                                    │                 stop web → api → db (and the sensor); exit
   update helper                     wait for the engine to exit; hash + publisher once more;
                                                      run the installer silently; write the result;
                                                      start the service / the desktop app again
```

## Configuration

On each installation, in the `.env` next to the data folder (or the environment of the service):

| Variable | Meaning |
| --- | --- |
| `NIGAFIY_UPDATE_MANIFEST_URL` | Where the signed manifest is. Unset: updates are off (the card says so). |
| `NIGAFIY_UPDATE_PUBLIC_KEY` | The Ed25519 public key manifests must be signed with (base64, printed by `new-update-key.mjs`). Required with the URL. |
| `NIGAFIY_UPDATE_COMPONENT` | Manifest component this install updates from. Default `desktop-windows-x64`. |
| `NIGAFIY_UPDATE_PUBLISHER_THUMBPRINT` | SHA-1 thumbprint of the code-signing certificate (code-signing.md). When set, the API and the engine refuse any installer that is not Authenticode-`Valid` and signed by exactly this certificate. **Set it for production.** The engine reads the same value (or `--update-publisher`). |
| `NIGAFIY_UPDATE_MAX_BYTES` | Largest download accepted. Default 1.5 GiB. |

The publisher certificate must be trusted on the computer (`scripts\signing\Install-NigafiyTrust.ps1`),
otherwise Windows reports the signature as not `Valid` and the update is refused.

Machines installed from the MSI are updated through GPO/Intune instead; leave the manifest URL unset
there (installers.md).

## Keys

Create the manifest signing key once, on the release computer, **outside the repository**:

```powershell
node scripts\release\new-update-key.mjs --out E:\nigafiy-release-key
```

It writes `nigafiy-update-key.pem` (Ed25519 private key, PKCS#8; the file's ACL is limited to you,
SYSTEM and Administrators), refuses a folder inside the repository and never overwrites an existing
key. It prints `NIGAFIY_UPDATE_PUBLIC_KEY=...` for every installation. Back the key up offline:
anyone holding it can publish manifests every install accepts; losing it means shipping a new
public key to every install by hand.

Nigafiy's key was created on 2026-11-25 on the owner's release PC (private key outside the repository, backed up offline by the owner). Its public key, for every install:
`NIGAFIY_UPDATE_PUBLIC_KEY=zS4UgEBIF2FdOJqXdoRlUf2OiXlf2v1Antnoa2cVr9w=`

## Manifest

```json
{ "payload": "<base64 of the JSON below>", "signature": "<base64 Ed25519 signature of those bytes>" }
```

```json
{
  "schema": 1,
  "product": "nigafiy",
  "version": "1.2.3",
  "released_at": "2026-11-23T10:00:00.000Z",
  "notes_url": "https://example.com/changelog/1.2.3",
  "components": [
    { "id": "desktop-windows-x64", "version": "1.2.3", "url": "https://downloads.example.com/1.2.3/LAN%20Detective%20Setup%201.2.3.exe", "size": 123456789, "sha256": "<64 hex>" },
    { "id": "endpoint-agent-windows-x64", "version": "1.2.3", "url": "https://...", "size": 2860410, "sha256": "<64 hex>" }
  ]
}
```

Every URL must be `https://`. Size and SHA-256 are read from the files. Sign one by hand with:

```powershell
node scripts\release\sign-manifest.mjs --key E:\nigafiy-release-key\nigafiy-update-key.pem --version 1.2.3 `
  --component "desktop-windows-x64=apps\desktop\release\Nigafiy Setup 1.2.3.exe@https://downloads.example.com/1.2.3/LAN%20Detective%20Setup%201.2.3.exe" `
  --expect-public-key <the key the installs have> --out manifest.json
```

The signature is self-checked before the file is written; `--expect-public-key` also refuses a key
the installs would not accept.

## Engine and Sensor in one executable: what an older install sees after the update

Since the merge (docs/architecture/engine-sensor.md) the package has no
`resources\collector\nigafiy-sensor.exe`; the Sensor runs as `resources\engine\nigafiy-engine.exe
sensor`. The update manifest is unchanged (components `desktop-windows-x64` and
`endpoint-agent-windows-x64`; there never was a separate Sensor component), so an older install finds
and applies the update as before. After it:

- the NSIS upgrade (the update helper runs the installer silently over the same folder) and the MSI
  major upgrade remove the old `collector` folder with the old files;
- the Sensor keeps its identity and settings (`%APPDATA%\Nigafiy\collector`) and starts again from
  the engine executable;
- Windows Defender Firewall decides per program, so the first time the Sensor opens UDP 5678 (MNDP)
  or port 53 (the DNS filter, if turned on) Windows may ask once about `nigafiy-engine.exe`. A rule
  accepted earlier for `nigafiy-sensor.exe` now points at a removed file and does nothing;
- an engine installed as a Windows service with a recorded `--sensor-exe=…\nigafiy-sensor.exe` runs
  the Sensor from itself (the engine logs one line about it).

Not run against a real older install (the owner's installation is never touched).

## Building a release

```powershell
$env:NIGAFIY_SIGN_THUMBPRINT = Get-Content .data\signing\thumbprint.txt
pnpm release -- --key E:\nigafiy-release-key\nigafiy-update-key.pem --base-url https://downloads.example.com/1.2.3/
```

`scripts/release/release.mjs` always sets `NIGAFIY_REQUIRE_SIGNING=1`: with no certificate it stops
before building anything. It builds `nigafiy-engine.exe`, which is the engine and the Sensor in one
executable (docs/architecture/engine-sensor.md), with `main.Version`, signs it,
builds the desktop NSIS installer and the MSI (`--no-msi` to skip), the endpoint-agent installer
(`--no-agent` to skip), checks that every installer and the programs inside the app report a `Valid`
Authenticode signature, builds the Android agent (`--no-android` to skip) and refuses its APK unless it
is signed with the release key (not the Android debug key), not debuggable, and its `versionName` is the
release version (`--android-cert-sha256 <hex>` or `NIGAFIY_ANDROID_CERT_SHA256` also pins the signing
certificate; `scripts/android/release-apk.mjs`), and copies the files, the APK as
`Nigafiy-Android-Agent-<version>.apk`, with `SHA256SUMS` (and, with `--key`, `manifest.json`)
to `dist/release/<version>`. The Android build needs the JDK, SDK and Gradle of `pnpm build:android`
and the release key in `.data/android` (`pnpm android:keystore`). The APK is not in the update
manifest: phones get it through the fleet's APK upload (docs/features/android.md). `--version` must equal `apps/desktop/package.json`'s version (bump it
first). Upload the folder's files to `--base-url`, then the manifest to `NIGAFIY_UPDATE_MANIFEST_URL`
last, so no install sees a manifest whose files are not there yet.

### The update channel built into a release

Every release says where its installs look for updates (UX review 2026-11-26, item 14). Before 1.0.5
the variables above were never set on installed copies, so updates were silently off for everyone.

- `--update-url https://…/manifest.json --update-public-key <base64>`, or the same two values in
  `scripts/release/update-channel.json` (copy `update-channel.example.json`; nothing in it is secret).
  The URL must be the **stable** address of the latest manifest (not the per-version `--base-url`).
  With `--key`, the key's public half must equal `--update-public-key`, or the release stops.
- No channel: the release stops. `--no-updates` builds one that never checks; the app says so.
- No hosting address is built into the code: none has been decided yet.

The release writes `update-channel.json` into the backend bundle (`scripts/update-channel.mjs`). On
every start the launcher passes it to the API as `NIGAFIY_UPDATE_MANIFEST_URL` / `NIGAFIY_UPDATE_PUBLIC_KEY`,
unless the data folder's `.env` has a line for either one: that line wins, and an empty
`NIGAFIY_UPDATE_MANIFEST_URL=` turns checks off for good. The desktop app asks the API every 6 hours and
shows the result in the tray (an update is a clickable line plus one Windows notice per version; off,
managed by MSI/Store, or a failed check are said plainly, never "up to date"). Settings has an Updates
card with the same line.

## Download and staging (API)

`POST /platform/updates/download` (admin; audit `platform.update.download_started`, then
`platform.update.staged` or `platform.update.download_failed`):

- re-fetches the manifest and verifies its signature; the component must be newer than the running
  version;
- downloads over HTTPS only (every redirect too, at most 5), stops at the manifest's size or
  `NIGAFIY_UPDATE_MAX_BYTES`, whichever is smaller, and after 60 s without data;
- the SHA-256 must equal the manifest's; with a publisher thumbprint, the Authenticode signature must
  be `Valid` and from that certificate;
- only then moves it to `<data>/updates/staged/Nigafiy-Update-<version>.exe` with `staged.json`
  (version, SHA-256, signer). A partial or rejected download leaves nothing behind.

`GET /platform/updates/install` shows progress, the staged update (version, SHA-256, signer) and the
last installation's result. The web console's engine card shows the same, in English and Arabic.

## Installing (confirmation)

`POST /platform/updates/install` with `{ "version": "1.2.3", "confirm": true }` (admin; audit
`platform.update.install_requested` or `platform.update.install_refused`). The console sends it from a
confirmation dialog that names the version, the SHA-256 and the signer and says that every part
restarts. The API hashes the staged file again and hands it to the engine's control API
(`POST /v1/update/apply`, loopback, control token).

The engine refuses (409) when it runs from a source checkout (no installation to update) and
rejects (422) a request whose file is not a regular `.exe` directly in the staging folder, whose hash
differs, or whose signature is not the configured publisher's. Otherwise it answers 202, copies
itself to `<data>/updates/helper/nigafiy-engine-update.exe` (the installer replaces the engine's own
file), starts that copy detached (outside the engine's job object) as
`update-apply --data-dir ... --installer ... --sha256 ... --version ... --install-dir ... --wait-pid <engine pid> [--publisher ...] [--service NigafiyEngine | --restart-exe <app>]`,
and shuts down every part in order.

The helper (log: `<data>/logs/update.log`):

1. waits for the engine to exit; if it does not, it **does not** run the installer;
2. validates, hashes and checks the publisher once more;
3. runs the NSIS installer silently over the same folder: `/S /allusers --updated /D=<folder>` for a
   Program Files installation, `/S /currentuser --updated /D=<folder>` otherwise; if Windows answers
   that elevation is needed, it asks through the normal UAC prompt;
4. writes `<data>/updates/last-install.json` (`version`, `ok`, `exit_code`, `error`, `started_at`,
   `finished_at`, `restarted`);
5. always starts the engine again (the `NigafiyEngine` service, or the desktop app), also after a
   failed installation, so the computer is not left without its engine.

The status document (`GET /v1/status` → `update`) and the console card show the result.

## What has and has not been verified

- Tested by unit tests: manifest building, signing and verifying (also across the scripts and the
  API), HTTPS-only download with redirects, size limits and hash mismatch against a local HTTPS
  server; staging and the confirm/refusal paths; the engine's request validation, hashing, publisher
  check, installer arguments, per-machine detection, the helper's wait/verify/run/restart sequence
  with fake system calls; the control route.
- Run for real: the release scripts (key creation, refusals, signing) and the release script's
  refusal without a certificate; the packaged engine (desktop `pack` output) rejecting an apply
  request whose SHA-256 does not match (422) and staying up.
- **Never run end to end**: no installer has been run over a real installation by the helper, the
  UAC fallback and the service restart have not been exercised, and no release has been built signed
  (no certificate on the build computer). Do that on a disposable Windows VM before relying on it.
