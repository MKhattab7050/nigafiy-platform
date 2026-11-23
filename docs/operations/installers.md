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

## Desktop app: NSIS

Unchanged from before: `oneClick: false`, per-user by default, the folder can be changed. The
uninstaller and the installer are signed through `apps/desktop/scripts/signing.cjs`.

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
in-app updater.** The updater runs the NSIS installer, which would put a second, NSIS-registered copy
over an MSI-managed one. The engine cannot yet tell the two apart (see "Gaps"), so on MSI-managed
machines leave `NIGAFIY_UPDATE_MANIFEST_URL` unset (the update card then says updates are off).

## Endpoint agent

`packaging/endpoint-agent/endpoint-agent.nsi`, built by `scripts/installers/build-agent-installer.mjs`
(go build for windows/amd64 with `main.Version`, sign the exe, compile with makensis, sign the setup).
makensis is found from `NIGAFIY_MAKENSIS`, then `PATH`, then electron-builder's cache
(`%LOCALAPPDATA%\electron-builder\Cache\nsis-*`), so a machine that has built the desktop app once
needs nothing else. `NIGAFIY_REQUIRE_SIGNING=1` makes a missing certificate an error.

The installer is a thin wrapper around the agent's own `install` subcommand; it adds nothing the
agent does not do itself. What it does:

1. copies `nigafiy-agent.exe` to `C:\Program Files\Nigafiy\Endpoint Agent`;
2. runs, as administrator,
   `nigafiy-agent.exe install -server <url> -service-name <name> -log-level <level> [-tls-pin <hex>] [-ca-file <pem>] [-no-start]`
   with the one-time enrollment token in the `NIGAFIY_AGENT_ENROLLMENT_TOKEN` environment variable
   (never on a command line, so it does not show in process lists or logs). The agent enrolls, stores
   its credential in `%ProgramData%\Nigafiy\EndpointAgent` and registers the service
   (`NigafiyEndpointAgent` by default) pointing at that exe;
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
| `/TLSPIN=<sha256>` | Server certificate fingerprint, 64 hex digits, colons allowed; a `sha256:` prefix is accepted and stripped. |
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
`HKLM\Software\Nigafiy\EndpointAgent`, removes the old service (`nigafiy-agent.exe uninstall`, which
keeps the credential), replaces the exe and runs `install` again; the agent finds its stored
credential and does not enroll again.

### Uninstall

`uninstall.exe /S` removes the service, the program folder and the registry entries and **keeps** the
credential in `%ProgramData%\Nigafiy\EndpointAgent`, so a reinstall reconnects as the same endpoint.
`uninstall.exe /S /PURGE` also deletes the credential; the computer then needs a new token.

## Gaps (agent and packaging)

These are limits of the current agent and tooling, documented instead of worked around (the agent's Go
code was not changed for this milestone):

- **No self-copy in `install`.** The service points at whatever path `install` was run from, so the
  installer copies the exe first. Running `nigafiy-agent.exe install` from a download folder
  registers the service there.
- **No in-place upgrade.** `install` refuses when the service exists, so an upgrade is
  uninstall-service → replace exe → install. There is a short window with no agent service.
- **No `sha256:` prefix in `-tls-pin`.** The agent wants bare hex (colons allowed); the installer
  strips the prefix.
- **No fleet-wide token.** Tokens are per endpoint (see Silent mode), so a mass rollout needs a
  token file per computer.
- **No token-file flag.** The agent takes the token from `-token` or `NIGAFIY_AGENT_ENROLLMENT_TOKEN`;
  the installer reads `/TOKENFILE` and passes it in the environment.
- **NSIS 3.0.4 cannot sign the uninstaller it writes at install time.** `uninstall.exe` of the agent
  is unsigned; the setup and `nigafiy-agent.exe` are signed. (The desktop NSIS build signs its
  uninstaller through electron-builder.)
- **The engine cannot tell an MSI installation from an NSIS one**, so it would offer the NSIS update
  on MSI machines if updates are configured there (see above).
- **Not run on a real machine.** The agent installer was compiled (no warnings) but never executed
  here: running it would install a service. The MSI target is configured but was not built here
  (it needs the WiX download). Both need a test on a disposable Windows VM before the first release.
