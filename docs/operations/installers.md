# Installers

Nigafiy ships three Windows installers. All of them, and every program inside them, are signed with
the free Authenticode route in [code-signing.md](code-signing.md).

| Installer | Built by | Use it for |
| --- | --- | --- |
| `Nigafiy Setup <v>.exe` (NSIS) | `pnpm --filter @nigafiy/desktop dist` | Interactive installs and the in-app updater. Per-user by default; an administrator can pick "all users". |
| `Nigafiy <v>.msi` (WiX, per-machine) | `pnpm --filter @nigafiy/desktop dist:msi` | Group Policy software installation, Intune line-of-business apps, SCCM. |
| `Nigafiy-Endpoint-Agent-Setup-<v>.exe` (NSIS) | `pnpm build:agent-installer` | The endpoint agent on managed computers, interactive or silent (GPO, Intune Win32 app). |

`pnpm release` builds all three signed (see [updates.md](updates.md#building-a-release)).

The desktop installers are named "Nigafiy" (productName). The NSIS GUID stays the one the earlier builds had, so an update installs over an existing install instead of beside it (docs/architecture/naming.md).
New installers (the endpoint agent) say Nigafiy.

## Three channels

| Channel | Who it is for | Package | Signed by | Warning on a stranger's PC |
| --- | --- | --- | --- | --- |
| **Microsoft Store** | The public: anybody installing Nigafiy or Nigafiy Quick Support | MSIX (`dist:msix`, `build-msix.cjs quick-support`; [microsoft-store.md](microsoft-store.md)) | Microsoft, at publishing (free; needs the owner's Partner Center account) | None: Store apps are never subject to SmartScreen |
| **Group Policy, own certificate** | Computers of an organisation that deploys its own free certificate by GPO | The endpoint agent installer and the desktop MSI | The organisation's self-signed certificate ([code-signing.md](code-signing.md)) | None on computers that received the `.cer` by GPO; "Unknown publisher" anywhere else |
| **Direct download** (NSIS `.exe`, Quick Support `.exe` from Fleet) | Testing, and organisations that accept the warning | NSIS, plain exe | The organisation's certificate, or none | "Windows protected your PC" (SmartScreen) and "Unknown publisher" |

The Store package and an NSIS install of the desktop use the same loopback ports, so only one of them
runs at a time. The Store copy keeps its own data in its package folder and leaves an NSIS profile
alone (microsoft-store.md).

## Desktop app: NSIS

`oneClick: false`, per-user by default, the folder can be changed, English and Arabic
(`multiLanguageInstaller`). The uninstaller and the installer are signed through
`apps/desktop/scripts/signing.cjs`. Nigafiy's own additions are in `apps/desktop/installer/nigafiy.nsh`.

Silent install for one user into a chosen folder (the form used in "What ran for real here"):

```
"Nigafiy Setup 0.1.1.exe" /S /currentuser /PROGRAMS=radar,watch /D=C:\Users\me\Apps\Nigafiy
```

`/D=` must be the last option. Silent uninstall: the entry's `QuietUninstallString`
(`"<folder>\Uninstall Nigafiy.exe" /currentuser /S`). Uninstall keeps the user's data
(`%APPDATA%\Nigafiy`); it removes the program folder, the Apps & features entry, the Start-menu and
desktop shortcuts, the programs choice, the `nigafiy://` link handler when it opens this installation,
and the copy of the setup that electron-builder keeps in `%LOCALAPPDATA%\@nigafiydesktop-updater`
(Nigafiy's updater does not use it).

### Choose programs

After the folder page the installer shows **Choose programs**: Nigafiy Hub (home, sign-in, settings,
the engine) is always installed; Radar, Watch, Guard, Fleet, Mind and Toolbox can be left out. A
program left out keeps collecting its data; only its screens are not offered.

- The choice is saved as `Programs` (REG_SZ: `all`, or a comma list such as `radar,watch`) under
  `Software\Nigafiy\Hub` in the install's own hive: HKCU for a per-user install, HKLM for all users.
- Silent: `/PROGRAMS=radar,watch` (an invalid list ends with exit code 2). Without it a silent install
  or an update keeps the earlier choice, otherwise it is `all`.
- The engine reads it at start (`NIGAFIY_PROGRAMS` in the engine's own environment wins) and passes
  it to the stack as `NIGAFIY_PROGRAMS`; `/v1/status` reports it, and
  `nigafiy-engine install-info` prints the install kind and the choice (read-only).
- Changing it later: Apps & features → Nigafiy → **Modify** runs `Nigafiy.exe --choose-programs`
  (EN + AR chooser; writes HKCU for a per-user install, HKLM through the UAC prompt for all users,
  read-only for an MSI install, where the administrator sets `PROGRAMS`).

### An old LAN Detective install

Nigafiy was called LAN Detective before (docs/architecture/naming.md). The NSIS GUID is the same, so
installing Nigafiy in the same scope upgrades the old install in place, and the app keeps using
`%APPDATA%\LAN Detective` while only that profile folder exists.

- An old copy in **another folder** (the other install scope, or `C:\Program Files\LAN Detective` /
  `%LOCALAPPDATA%\Programs\LAN Detective` without a registration in this scope): an interactive install
  asks whether to remove it with its own uninstaller. Silent installs never remove anything.
- On its first run the app offers, in one dialog (EN or AR), to **move** the profile folder to
  `%APPDATA%\Nigafiy` (a rename on the same drive; refused when the new folder exists; on any error
  the old folder stays and is used), to **remove** an old copy with its own uninstaller (and its own UAC
  prompt for an all-users copy), **later**, or **don't ask again**. Nothing happens without a click.
  An explicit `--user-data-dir`, `--smoke` and the program chooser never ask.

The in-app updater (updates.md) runs this installer silently over the existing installation:
`/S /allusers --updated /D=<folder>` for an installation under Program Files and
`/S /currentuser --updated /D=<folder>` otherwise, so an update never switches the installation mode.

## Desktop app: MSI for Group Policy

`apps/desktop/package.json` → `build.msi`:

- `perMachine: true` — installs into `C:\Program Files\Nigafiy` for every user, which is what
  GPO computer-assigned software needs;
- `oneClick: true` — no wizard; `msiexec /i "Nigafiy 0.1.0.msi" /qn` installs silently;
- `upgradeCode: 6DA7D862-27E7-4AC8-809D-89B4128FB3AE` — fixed for the life of the product, so a newer
  MSI upgrades the older one in place. **Never change it.**
- `PROGRAMS` property (added by `apps/desktop/scripts/msi-programs.cjs`, a `msiProjectCreated` hook):
  `msiexec /i "Nigafiy 0.1.1.msi" /qn PROGRAMS=radar,watch,fleet`. Written to
  `HKLM\Software\Nigafiy\Hub` `Programs`; an upgrade without `PROGRAMS` keeps the earlier value
  (RegistrySearch), a first install without it writes `all`.

Check a built MSI without installing it (read-only, Windows Installer's own COM object):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\installers\Inspect-NigafiyMsi.ps1 -Path "apps\desktop\release\Nigafiy 0.1.1.msi" -Thumbprint (Get-Content .data\signing\thumbprint.txt)
```

It checks the UpgradeCode, per-machine (`ALLUSERS=1`), the product name, `PROGRAMS` (secure
property, registry value, fixed component GUID, read back on upgrade, default `all`), the major-upgrade
rows and, with `-Thumbprint`, the signer and an intact hash. Exit 0 all ok, 1 a check failed, 2 not an MSI.

Deploy:

- **GPO**: Computer Configuration → Policies → Software Settings → Software installation → New →
  Package, from a UNC share readable by Domain Computers; "Assigned". For a new version, add the new
  MSI and set it to upgrade the old package.
- **Intune**: Apps → Windows → Line-of-business app → the .msi. Install context: device.
- Uninstall: `msiexec /x "Nigafiy 0.1.0.msi" /qn` (or the product code from the GPO/Intune
  console).

Building the MSI needs WiX 4, which electron-builder downloads into its cache the first time
(`wix-4.0.0.5512.2.7z`, checksum-pinned by electron-builder).

**Machines installed from the MSI are updated by publishing a newer MSI through GPO/Intune, not by the
in-app updater.** The engine tells the two apart, read-only: a Windows Installer registration for the
fixed UpgradeCode (or an uninstall entry with `WindowsInstaller=1`) for its folder means MSI; the NSIS
install key (`Software\664f0038-…`) means NSIS. On an MSI install `/v1/status` says so, the engine
refuses to run the NSIS update, the API's update check answers `msi_managed` (download and install are
refused with 409 and audited), and the update card says the administrator updates this installation
(EN + AR).

## Endpoint agent

`packaging/endpoint-agent/endpoint-agent.nsi`, built by `scripts/installers/build-agent-installer.mjs`
(go build for windows/amd64 with `main.Version`, sign the exe, compile with makensis, sign the setup).
makensis is found from `NIGAFIY_MAKENSIS`, then `PATH`, then electron-builder's cache
(`%LOCALAPPDATA%\electron-builder\Cache\nsis-*`), so a machine that has built the desktop app once
needs nothing else. `NIGAFIY_REQUIRE_SIGNING=1` makes a missing certificate an error.

The installer is a thin wrapper around the agent's own `install` subcommand; it adds nothing the
agent does not do itself. What it does:

1. unpacks `nigafiy-agent.exe` into its temporary folder;
2. runs it, as administrator,
   `nigafiy-agent.exe install -install-dir "C:\Program Files\Nigafiy\Endpoint Agent" -server <url> -service-name <name> -log-level <level> [-token-file <path>] [-tls-pin <sha256>] [-ca-file <pem>] [-no-start]`.
   A typed token goes in the `NIGAFIY_AGENT_ENROLLMENT_TOKEN` environment variable (never on a
   command line, so it does not show in process lists or logs); `/TOKENFILE` is passed as
   `-token-file` and the agent reads the first line itself (trimmed; the content never appears in an
   error or log). `-tls-pin` accepts a `sha256:` prefix in any case. The agent enrolls, stores its
   credential in `%ProgramData%\Nigafiy\EndpointAgent`, **copies itself into `-install-dir`**
   (default `C:\Program Files\Nigafiy\Endpoint Agent`, `/opt/nigafiy-agent`,
   `/Library/Nigafiy/EndpointAgent`) and registers the service (`NigafiyEndpointAgent` by default) on
   that copy, so running `install` from a download folder no longer leaves the service there;
3. writes `install.log` next to the exe (the agent's command line without the token, its exit code
   and output), the settings it used to `HKLM\Software\Nigafiy\EndpointAgent` (server, pin, CA file,
   service name, version; **never the token**) and an "Apps & features" entry.

Remote-support consent and the on-screen session banner are the agent's own behaviour and policy;
the installer shows the same notice on its connection page.

### Silent mode (GPO startup script, Intune Win32 app, SCCM)

```
Nigafiy-Endpoint-Agent-Setup-0.1.0.exe /S /SERVER=https://nigafiy.corp.example /TOKENFILE=\\server\share\enroll.txt
```

| Option | Meaning |
| --- | --- |
| `/S` | Silent. |
| `/SERVER=https://...` | Nigafiy server. Required on a first install (silent mode refuses anything but `https://`). |
| `/TOKEN=...` | One-time enrollment token. Prefer `/TOKENFILE`: a token on a command line can be seen by other administrators' process tools while setup runs. |
| `/TOKENFILE=<path>` | Reads the token from the first line of a file (a share readable only by Domain Computers, or the Intune package). |
| `/TLSPIN=<sha256>` | Server certificate fingerprint, 64 hex digits, colons allowed; a `sha256:` prefix is accepted (by the agent itself). |
| `/CAFILE=<pem>` | PEM file with the CA that signed the server certificate. |
| `/SERVICENAME=<name>` | Service name (default `NigafiyEndpointAgent`). |
| `/LOGLEVEL=debug\|info\|warn\|error` | Default `info`. |
| `/NOSTART` | Register the service without starting it. |

Exit codes: `0` installed; `1` the agent's install step failed (reason in
`C:\Program Files\Nigafiy\Endpoint Agent\install.log`); `2` bad or missing options (no `/SERVER`,
not `https://`, unreadable token file, not 64-bit Windows).

Intune Win32 app: wrap the setup with the Win32 Content Prep Tool; install command as above; uninstall
command `"C:\Program Files\Nigafiy\Endpoint Agent\uninstall.exe" /S`; detection rule: registry
`HKLM\Software\Nigafiy\EndpointAgent`, value `Version`, equals the version you ship. An enrollment
token belongs to one endpoint record on the server (created in the console) and is consumed by
that endpoint's enrollment, so each computer needs its own token. For a GPO rollout, export one token
file per computer name and let the startup script pick it:
`/TOKENFILE=\\server\enroll$\%COMPUTERNAME%.txt` (cmd expands `%COMPUTERNAME%`). Delete the files
once the computers have enrolled.

### Upgrade

Run the newer setup with `/S` (no token, no server needed): it reuses the settings saved in
`HKLM\Software\Nigafiy\EndpointAgent` and runs the new agent's `install`, which finds the installed
service and **upgrades it in place** (also available as `nigafiy-agent upgrade`):

1. stops the service (at most 30 s);
2. renames the installed exe to `nigafiy-agent.previous.exe` (the rollback copy) and copies itself in;
3. starts the service and waits until the service manager reports it running **and** the new
   version has written its health marker (`health.json` in the state folder: version, PID, start,
   last accepted heartbeat), within `-timeout` (default 90 s);
4. otherwise rolls back: stops it, puts the previous exe back, starts it again, and fails.

The stored credential is kept and nothing enrolls again. There is no longer a window with no agent
service registered.

### Uninstall

`uninstall.exe /S` removes the service, the program folder and the registry entries and **keeps** the
credential in `%ProgramData%\Nigafiy\EndpointAgent`, so a reinstall reconnects as the same endpoint.
`uninstall.exe /S /PURGE` also deletes the credential; the computer then needs a new token.

## Gaps (agent and packaging)

Closed in this round (Builder I1): self-copy in `install`, in-place upgrade with rollback, `sha256:`
pins and `-token-file` in the agent, telling an MSI install from an NSIS one, choosing programs at
install, importing an old LAN Detective install. What is left:

- **No fleet-wide token.** Tokens are per endpoint (see Silent mode), so a mass rollout needs a
  token file per computer.
- **NSIS 3.0.4 cannot sign the uninstaller it writes at install time.** `uninstall.exe` of the agent
  is unsigned; the setup and `nigafiy-agent.exe` are signed. (The desktop NSIS build signs its
  uninstaller through electron-builder; checked on the real install below.)
- **The agent installer, the agent's install/upgrade/rollback and the MSI were never run on a real
  machine.** By the owner's rule nothing here installs a service, elevates, installs for all users or
  installs the MSI. The agent's upgrade and rollback are covered by unit tests with a fake service
  manager; the MSI was built and its tables read (below). All three need a run on a disposable
  Windows VM before the first release.
- **Test builds carry the engine's development version.** `pnpm --filter @nigafiy/desktop dist`
  builds `nigafiy-engine.exe` without `main.Version` (it reports `0.1.0-dev`); `pnpm release` stamps
  every binary with the release version.
- **Signing covers every `.exe` in the package**, including the bundled embedded-postgres programs
  (`initdb.exe`, `pg_ctl.exe`, `postgres.exe`) and electron-builder's `elevate.exe`: they carry the
  organisation's signature, not their makers'.

## What ran for real here

Windows 11 Pro 26200, 2026-11-25, worktree `worktree-installers`. Signed with the free test route
(code-signing.md): the self-signed certificate "Nigafiy Test I1" in `Cert:\CurrentUser\My`,
thumbprint `76B9582BE34D0E972BB6B7A37ABF318CCE2A7DCA`, with `NIGAFIY_SIGN_NO_TIMESTAMP=1` (no
timestamp server was contacted) and `NIGAFIY_REQUIRE_SIGNING=1`. Its root is **not** trusted on this
PC (installing the trust needs administrator rights), so every signature reads `UnknownError`
("terminated in a root certificate which is not trusted"): signer and hash are checked, the chain is not.

**Builds**

| Step | Result |
| --- | --- |
| `New-NigafiySigningCert.ps1 -Organization "Nigafiy Test I1"` | First **failed**: Windows PowerShell 5.1 leaves `$PSScriptRoot` empty in parameter defaults. Fixed; then it reused the existing certificate and wrote `.data\signing`. |
| `pnpm --filter @nigafiy/desktop dist` | Exit 0, `Nigafiy Setup 0.1.0.exe` (164 MB); 9 files signed (sensor, engine, 3 postgres programs, Nigafiy.exe, elevate.exe, uninstaller, setup). `pnpm deploy` asked the npm registry for package metadata (one ECONNRESET retry) and downloaded 0 packages; Electron came from the local cache. |
| Version 0.1.1 | `pnpm --filter @nigafiy/desktop dist -- -c.extraMetadata.version=0.1.1` does **not** work: pnpm passes the `--` on and electron-builder ignores what follows (it built 0.1.0 again). Built instead with `pnpm exec electron-builder --win nsis -c.extraMetadata.version=0.1.1` in `apps/desktop` after the bundle step; the packaged app reports 0.1.1. (`pnpm release` requires the package version to be bumped, so it is not affected.) |
| `pnpm --filter @nigafiy/desktop dist:msi` | Exit 0, `Nigafiy 0.1.0.msi` (168 MB). WiX came through electron-builder's checksum-pinned download (`wix-4.0.0.5512.2.7z`, now in `%LOCALAPPDATA%\electron-builder\Cache`). Signed. |
| `pnpm build:agent-installer` | Exit 0, `Nigafiy-Endpoint-Agent-Setup-0.1.0.exe` (3.1 MB), makensis from electron-builder's cache, no warnings; `nigafiy-agent.exe` and the setup signed. |
| `Get-AuthenticodeSignature` | Both desktop setups, the MSI, the agent setup, `nigafiy-agent.exe` and all 8 `.exe` in each installed copy: signer = the thumbprint above, status `UnknownError` (untrusted root only). A copy of `nigafiy-agent.exe` with one byte changed reads `HashMismatch`. |
| `Inspect-NigafiyMsi.ps1 -Thumbprint …` on the MSI | 11/11 ok: UpgradeCode `{6DA7D862-27E7-4AC8-809D-89B4128FB3AE}`, ALLUSERS 1, ProductName Nigafiy, PROGRAMS secure, HKLM `Software\Nigafiy\Hub` `Programs` = `[PROGRAMS]`, its component GUID, the RegistrySearch, both SetProperty actions, the Upgrade rows (max 0.1.0.0, attributes 513 → `WIX_UPGRADE_DETECTED`; min 0.1.0.0 → `WIX_DOWNGRADE_DETECTED`), the signature. With a wrong `-UpgradeCode`: 2 FAIL, exit 1. On the NSIS setup (not an MSI): exit 2. **The MSI was not installed.** |

**Desktop app, per user, in a scratch folder** (the only real install allowed). This PC already has
LAN Detective 0.1.0 installed for all users (`C:\Program Files\LAN Detective`, HKLM entry with the
same GUID) and an unrelated `HKCU\Software\Nigafiy\Hostify` key; both were checked before and after
every step and were never touched. Nothing ran on the owner's ports.

| Step | Result |
| --- | --- |
| `"Nigafiy Setup 0.1.0.exe" /S /currentuser /PROGRAMS=radar,watch /D=<scratch>\app` | Exit 0, no elevation prompt. HKCU Apps & features entry "Nigafiy 0.1.0" with `ModifyPath "<scratch>\app\Nigafiy.exe" --choose-programs` and `NoModify 0`; `HKCU\Software\<GUID>` `InstallLocation` = the scratch folder; `HKCU\Software\Nigafiy\Hub` `Programs` = `radar,watch`; Start-menu and desktop shortcuts created. |
| `<scratch>\app\resources\engine\nigafiy-engine.exe install-info` | `kind nsis`, `scope user`, programs `hub,radar,watch` from HKCU. |
| `Nigafiy.exe --smoke --user-data-dir=<scratch>\profile` | Exit 0: `{"smoke":"ok","binaryAvailable":true,"enrolled":false,"status":"stopped","hasServer":false,"windows":1,"tray":true,"program":"hub","protocolRegistered":true}`. A marker file was added to the profile and the SHA-256 of all 41 profile files recorded. |
| `"Nigafiy Setup 0.1.1.exe" /S /currentuser /D=<scratch>\app` (no `/PROGRAMS`) | Exit 0. Entry "Nigafiy 0.1.1", same folder, `Programs` still `radar,watch`; `install-info` still `nsis` / `user` / `hub,radar,watch`; the packaged app's version is 0.1.1; all 41 profile files byte-identical; `--smoke` ok again. |
| `"<scratch>\app\Uninstall Nigafiy.exe" /S /currentuser` | Exit 0. Folder, Apps & features entry, `HKCU\Software\<GUID>`, `Programs` and `HKCU\Software\Nigafiy\Hub` gone (Hostify kept); Start-menu and desktop shortcuts gone; the profile (user data) kept. **First run:** `HKCU\Software\Classes\nigafiy` (registered by the app) still pointed at the deleted exe, and `%LOCALAPPDATA%\@nigafiydesktop-updater\installer.exe` (164 MB) stayed. Fixed in `nigafiy.nsh`, rebuilt 0.1.1 and ran the whole sequence again: both are now removed, everything else as above. |

**Not run for real:** the installed app's full local stack (it uses the installed app's ports
47100/47130/47133 and the engine's 47140, which belong to the owner's install, and asks to scan the
network) — only `--smoke`; the interactive installer pages (Choose programs, the old-copy question)
and the Modify chooser — only silent mode; the first-run "move my data" dialog (an explicit
`--user-data-dir` never asks); an all-users NSIS install; the MSI install, upgrade and `PROGRAMS=`;
the agent installer and the agent's install/upgrade/rollback on a real service.

**Microsoft Store packages (Builder S1, 2026-11-25, worktree `worktree-store-msix`):** both MSIX
packages (desktop 213.4 MB, Quick Support 7.2 MB) were built with the `--local-test` identity, signed
with the same test certificate and inspected (manifest, capabilities, firewall rules, files, English
and Arabic strings). Installing them was refused (`0x800B0109`, certificate not trusted; Developer
Mode off), and the Windows App Certification Kit needs administrator rights, so neither ran. Details
and the owner's steps: [microsoft-store.md](microsoft-store.md), "What ran here vs never ran".
