# Microsoft Store (MSIX)

Owner decision (2026-11-25): no "Unknown publisher" and no SmartScreen warning on anybody's PC, and
no paid certificate. The desktop app (Nigafiy Hub with its programs) and Nigafiy Quick Support are
published through the Microsoft Store as MSIX packages; Microsoft signs what it distributes. The
endpoint agent and the MSI stay on the organisation's own free certificate deployed by Group Policy
(code-signing.md).

## Research (2026-11-25, Microsoft's own documentation)

Every statement below is from the page linked next to it, read on 2026-11-25. Where Microsoft does
not say something, this section says so instead of guessing.

### Verdict

- **The Store route gives what the owner asked for, for MSIX packages.** Microsoft re-signs MSIX
  packages it publishes, no paid certificate is needed, and Store-installed apps never get a
  SmartScreen warning. Both packages can be built that way.
- **But not with an individual account, as far as the policy reads.** Store Policy 10.14 requires a
  **Company** account "for organizations, businesses, and any person acting in relation to their
  trade or profession", and whenever "a reasonable consumer would interpret your application or
  publisher name to be that of a business entity". An individual account publishes under the
  owner's own name. A product called Nigafiy, with publisher "Nigafiy", sold or used by companies,
  falls under the Company rule. **Company accounts are also free since 2026-05-07**, but they need a
  registered business (a D-U-N-S number, or formation/registration documents) and an e-mail address
  on the business's own domain. This is a decision for the owner (see "What the owner must decide").
- **Quick Support cannot stay the way it is inside the Store.** Today Fleet appends a signed server
  binding to `nigafiy-support.exe` at each download. A Store package is the same file for everybody,
  Microsoft signs it, and Windows refuses to start a package whose files were changed. So the Store
  version gets the binding from a `nigafiy-support:` link instead (item 3 below). It also cannot
  delete itself; the person removes it in Settings → Apps like any Store app.
- **The plain `.exe`/`.msi` route of the Store does not help.** For EXE/MSI submissions the Store
  does not re-sign, and every file must be signed with a certificate from a CA in Microsoft's Trusted
  Root Program, so a self-signed certificate is refused (Policy 10.2.9).

### Accounts and cost

| Fact | Source |
| --- | --- |
| Individual accounts: "The $19 registration fee is waived in the new flow", nearly 200 markets, ID + selfie verification, personal Microsoft account only (no work account), start at `https://storedeveloper.microsoft.com` (other entry points show the old paid flow). | [Free developer registration for individual developers](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-individual-developer) |
| Company accounts: "The $99 onboarding fee for company developer accounts has been removed" (2026-05-07). D-U-N-S recommended, or official business documents (manual review, 2–5 business days); a work e-mail on the company's domain; up to three verification appeals. | [Windows Developer Blog, 2026-05-07](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/), [Open a developer account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account) |
| Individual: "distribution of apps through the Store is **not in relation to their business, trade, or profession**"; Company: "in relation to their business, trade, or profession". An Individual account cannot be changed into a Company account later. | [Open a developer account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account) |
| Policy 10.14 Account Type (quoted in the verdict). Company accounts must show support contact details on the product page. | [Microsoft Store Policies 7.20, 10.14](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) |

### Signing and warnings

| Fact | Source |
| --- | --- |
| "The Microsoft Store will automatically re-sign your MSIX/AppX packages with a Microsoft certificate during the publishing process after your app passes certification." No CA certificate, `.pfx` or hardware token is needed. "If you are submitting an MSI or EXE installer to the Store, the Store does not re-sign those files." A package distributed outside the Store must be signed by you. | [App package requirements for MSIX](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements) |
| "Store-distributed apps are signed by a Microsoft certificate and are never subject to SmartScreen download warnings." Table: Microsoft Store — no warning; self-signed — "Same behavior as no signature" ("Windows protected your PC"). EV certificates no longer bypass SmartScreen. | [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) |
| EXE/MSI in the Store: signed "with a code signing certificate that chains up to a certificate issued by a Certificate Authority (CA) that is part of the Microsoft Trusted Root Program"; silent install required; the binary at the URL must not change. | [Store Policies 10.2.9](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) |

Not found in Microsoft's documentation: whether a person can download the Microsoft-signed `.msix`
to put on a website. Plan with the Store listing (and its link) as the only public channel.

### Package rules

| Fact | Source |
| --- | --- |
| Identity values (Package/Identity/Name, Publisher, PublisherDisplayName) come from Partner Center → Product management → Product identity, case-sensitive. | [App package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements) |
| Version: the fourth number "is reserved for Store use and must be left as 0"; the first cannot be 0. Max 25 GB per package. Arabic (`ar`, `ar-sa` …) and English are supported Store languages. | same page |
| Run the Windows App Certification Kit before submitting. | same page |
| A full-trust desktop app (`uap10:TrustLevel="mediumIL"`) "needs to declare the **runFullTrust** restricted capability". Restricted capabilities are reviewed during certification ("our testers will review the info you provide"), normally once. | [App capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations) |
| Packaged services (`packagedServices`, `localSystemServices`): "We don't recommend that you declare this capability in applications that you submit to the Microsoft Store. In most cases, the use of this capability won't be approved." `allowElevation`: "subject to approval under strict criteria". `unvirtualizedResources` (switch off AppData/HKCU virtualization) is "designed for certain types of desktop PC games". | same page |
| Policy 10.2.4: "dependency on non-Microsoft provided drivers or NT services is not allowed" (case by case for WHCP drivers). | [Store Policies 10.2.4](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) |
| Policy 10.2.2: no dynamic code that changes the described functionality. 10.2.7: clean uninstall. 10.2.8: user consent for any change to Windows settings. 10.5.1: Desktop Bridge and Win32 products must always have a privacy policy URL. 10.7: the description must be localised in each declared language. | same page |

### How a packaged desktop app runs

From [Understanding how packaged desktop apps run on Windows](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)
and [Detect package identity](https://learn.microsoft.com/en-us/windows/msix/detect-package-identity):

- Installed per user under `C:\Program Files\WindowsApps\<package full name>`; "package files are
  marked read-only … Windows prevents apps from launching if those files are tampered with". Writes
  into the package are not allowed.
- **AppData (Windows 10 1903 and later):** new files and folders created under `AppData\Local` and
  `AppData\Roaming` are written to "a private per-user, per-package location" and merged into the
  view; an existing real file that is opened is used in place ("no virtualization for that file
  occurs"); everything private is deleted when the app is uninstalled.
- **HKCU:** "All writes under HKCU are copied on write to a private per-user, per-app location",
  kept across upgrades, deleted on uninstall.
- A process is packaged when it has package identity; `GetCurrentPackageFullName` returns
  `ERROR_INSUFFICIENT_BUFFER` (122) when it has, `APPMODEL_ERROR_NO_PACKAGE` (15700) when it has not,
  anything else is an error. Microsoft's pages do not say in so many words whether child processes
  inherit the identity, so Nigafiy does not rely on it (below).
- Loopback: the "loopback blocked by default" rule of
  [Interprocess communication](https://learn.microsoft.com/en-us/windows/apps/develop/communication/interprocess-communication)
  is the AppContainer rule; a full-trust (mediumIL) app "doesn't run in an AppContainer"
  ([App capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)),
  so the engine's loopback servers (database, API, web, control) work as in the NSIS install.
- Firewall: `desktop2:FirewallRules` declares inbound rules for an executable of the package
  (Windows 10 1703+), added with the package
  ([desktop2:FirewallRules](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-desktop2-firewallrules)).
- Auto-start: `desktop:StartupTask`; with `Enabled="true"` it starts working when the app is first
  launched; enabling at install time needs a custom capability
  ([desktop:StartupTask](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-desktop-startuptask)).
  The desktop app has no auto-start today (the tray keeps it running while it is open), so the
  package declares none.

### What this means for Nigafiy's two packages

| Topic | Desktop app (Nigafiy) | Quick Support |
| --- | --- | --- |
| Trust level | Full trust (`runFullTrust`, mediumIL): Electron, the engine, embedded PostgreSQL, Node API/web and the sensor are ordinary Win32 programs. | Full trust (`runFullTrust`): the Go program and the agent code it reuses. |
| Data | Never the shared `%APPDATA%\Nigafiy`: with AppData virtualization a PostgreSQL data folder there would be split between the real folder and the private copy. The package uses its own folder `%LOCALAPPDATA%\Packages\<family name>\LocalState\Nigafiy` (profile, database, logs, config, sensor state). Windows deletes it when the app is uninstalled. | A temporary folder, deleted at the end as today. |
| Old installs | The NSIS profile (and the one from before the rename, naming.md) is left alone (not used, not moved, not deleted): moving it from inside a package would be virtualized. The first run says where that data is (EN + AR). | — |
| Programs in the package | Read-only; started from the install folder (engine, sensor, PostgreSQL, Node). | — |
| Ports | Same loopback ports as the NSIS install (47100/47130/47133, engine 47140), so the Store copy and an NSIS copy cannot run at the same time. | Outbound HTTPS only. |
| Sensor listeners | MNDP (UDP 5678, receive-only) and the DNS filter (53, off until turned on) listen on the LAN: declared as firewall rules for `nigafiy-engine.exe` (the Sensor runs as `nigafiy-engine sensor`, docs/architecture/engine-sensor.md), domain and private networks only. ICMP echo uses the same code as today. | — |
| Service | None (Store: services are "in most cases" not approved). The engine runs while the app runs, as in a per-user NSIS install. | None. |
| Updates | From the Store only; the in-app NSIS updater is switched off when the engine sees a package identity. | From the Store. |
| Link handler | `nigafiy://` declared in the manifest (a packaged app's HKCU writes are private, so `setAsDefaultProtocolClient` would not reach the browser). | `nigafiy-support:` declared in the manifest. |
| Binding | — | From the link Fleet gives, not from the file (the file cannot be changed). |
| Self-delete | — | Not possible; removed in Settings → Apps. |

### What the owner must decide

1. **Account type.** Company account (free; needs the business's D-U-N-S or registration papers and a
   domain e-mail) to publish as "Nigafiy", or Individual account (free; ID + selfie) to publish under
   his own name. Policy 10.14 points to Company for a product like Nigafiy; with an Individual
   account a certifier may refuse the submission or ask for a Company account. An Individual account
   cannot be converted later.
2. **Privacy policy URL** (Policy 10.5.1, required for desktop apps) and support contact details
   (Company accounts).
3. Two Store products: "Nigafiy" and "Nigafiy Quick Support" (two name reservations).

## Owner step by step

Nobody but the owner creates the account, accepts Microsoft's agreements or uploads. Everything
below happens on Microsoft's pages, in his name.

1. **Open the developer account** at `https://storedeveloper.microsoft.com` (other entry points show
   the old paid flow). Choose **Company** (to publish as "Nigafiy": the business's D-U-N-S number or
   registration papers, and an e-mail address on the business's own domain; review takes 2–5
   business days) or **Individual** (ID + selfie; the Store shows the owner's own name, and Policy
   10.14 may make a certifier ask for a Company account). Both are free. This choice cannot be
   changed later.
2. **Reserve two names** in Partner Center → Apps and games → New product → MSIX or PWA app:
   `Nigafiy` and `Nigafiy Quick Support`. Arabic display names are added per language in the listing.
3. **Copy the identity** of each product (the product → Product management → Product identity):
   `Package/Identity/Name`, `Package/Identity/Publisher` (`CN=…`) and
   `Package/Properties/PublisherDisplayName`. Put them in `.data/store/identity.json` (not committed):

   ```json
   {
     "publisher": "CN=…",
     "publisherDisplayName": "…",
     "desktop": { "identityName": "…" },
     "quickSupport": { "identityName": "…" }
   }
   ```

   or in the environment: `NIGAFIY_STORE_PUBLISHER`, `NIGAFIY_STORE_PUBLISHER_DISPLAY_NAME`,
   `NIGAFIY_STORE_DESKTOP_IDENTITY_NAME`, `NIGAFIY_STORE_QUICK_SUPPORT_IDENTITY_NAME`. The build refuses
   to run without them, and refuses a `LocalTest` name; nothing is invented.
4. **Version 1 or later.** The Store refuses a first number of 0, and the desktop is 0.1.0 today, so
   a Store build stops with "the Store does not accept a first number of 0". Raise the `version` in
   `apps/desktop/package.json` to `1.0.0` (so `Nigafiy.exe`, the in-app version and the package
   agree); the fourth number is always 0 and every later upload needs a higher version.
5. **Build** on a Windows PC with the Windows 10/11 SDK installed (no download; the build uses the
   installed `makeappx` and `makepri`):
   - Desktop: `pnpm build:engine` (the engine is also the Sensor), then
     `pnpm --filter @nigafiy/desktop dist:msix` → `apps/desktop/release/Nigafiy-<version>-x64.msix`.
     Build without `NIGAFIY_SIGN_THUMBPRINT` set, so the programs inside are not signed with the
     organisation's test certificate; Microsoft signs the package.
   - Quick Support: `pnpm build:agent`, then
     `node apps/desktop/scripts/build-msix.cjs quick-support --version 1.0.0` →
     `apps/desktop/release/Nigafiy-Quick-Support-1.0.0-x64.msix`.
   Store builds are left unsigned on purpose (Microsoft re-signs them).
6. **Run the Windows App Certification Kit** (Start → Windows App Cert Kit, it asks for administrator
   rights) on each `.msix` and fix what it reports. It ran once on the local test packages, started by
   the owner as administrator ("Real install test"): desktop PASS, Quick Support WARNING
   (DPI awareness), fixed in the program.
7. **Upload** each `.msix` in its product's submission → Packages.
8. **Store listing in English and Arabic** (Policy 10.7: every declared language needs its own
   description): name, description, at least one screenshot, the **privacy policy URL** (Policy
   10.5.1, required for desktop apps) and, for a Company account, support contact details. The
   package already carries the English and Arabic display names and descriptions.
9. **Restricted capability `runFullTrust`.** The submission asks why. Desktop: "Nigafiy is a desktop
   network-management app; it runs its own local database, API and web interface and a network sensor
   as ordinary Windows programs on this computer." Quick Support: "an attended remote-support program:
   the person starts it from a link, reads a code and PIN to their IT contact and accepts the
   session."
10. **Certification** (Microsoft's documentation: security tests, technical compliance, content
    review; usually up to a few business days). What to expect for Nigafiy: the `runFullTrust`
    review; the desktop's firewall rules for `nigafiy-engine.exe`, which runs the Sensor (inbound UDP 5678, TCP/UDP 53,
    domain and private networks); Quick Support's remote-control nature (it only runs after the
    person opens a link and accepts the session, with the Nigafiy banner and End session on screen).
    A refusal comes with the policy number; answer it in the submission notes.
11. **After publishing**, the Store listing link is the public download. For Quick Support, the person
    installs it once from the Store; each time, the technician sends the link from Fleet → Help
    requests → Quick Support → Copy Microsoft Store link.

### Local test packages (this PC only)

`pnpm --filter @nigafiy/desktop dist:msix:local-test` and
`node apps/desktop/scripts/build-msix.cjs quick-support --local-test --version 0.1.0` build packages
named `Nigafiy.LocalTest.*`, signed with the certificate whose thumbprint is in
`NIGAFIY_SIGN_THUMBPRINT` (for example the free self-signed test certificate from
`New-NigafiySigningCert.ps1`; `NIGAFIY_SIGN_NO_TIMESTAMP=1` skips the time-stamp server). These never
go to the Store. To install one, Windows needs that certificate in **Local Machine → Trusted People**
(administrator rights): `Add-AppxPackage` refuses it otherwise with `0x800B0109`. That trust is the
owner's decision on his own test PC; remove the certificate again afterwards.

What the owner does to try a local test package on his own PC (all of it his choice, as
administrator; the build session did none of it):

1. Export the public part of the test certificate:
   `Export-Certificate -Cert Cert:\CurrentUser\My\<thumbprint> -FilePath nigafiy-test.cer`.
2. In an administrator PowerShell:
   `Import-Certificate -FilePath nigafiy-test.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople`.
3. As the normal user: `Add-AppxPackage -Path apps\desktop\release\Nigafiy-0.1.0-x64-local-test.msix`,
   start "Nigafiy" from the Start menu, check that the dashboard opens, that the profile is in
   `%LOCALAPPDATA%\Packages\Nigafiy.LocalTest.Hub_<id>\LocalState\Nigafiy`, that Settings → Updates
   says updates come from the Microsoft Store, and that a `nigafiy://` link opens the app. For Quick
   Support: install its package, copy a link from Fleet → Help requests → Quick Support → Copy
   Microsoft Store link and open it.
4. Remove: `Get-AppxPackage Nigafiy.LocalTest* | Remove-AppxPackage`, then (administrator)
   `Remove-Item Cert:\LocalMachine\TrustedPeople\<thumbprint>`.

Only one Nigafiy desktop can run at a time (same ports): quit an NSIS copy first.

## What ran here vs never ran (2026-11-25)

**Ran for real on this PC (Windows 11 Pro 10.0.26200, Windows SDK 10.0.26100.0 already installed,
nothing downloaded):**

- Engine, sensor and Quick Support built from source; `dist:msix:local-test` ran the backend bundle,
  electron-builder `--win dir` and `build-msix.cjs desktop --local-test`. The first run stopped with
  `ENOBUFS` (MakeAppx prints one line per file); fixed in `build-msix.cjs`, then both packages built:
  - `Nigafiy-0.1.0-x64-local-test.msix`: 213.4 MB, 10 690 program files under `app\` (10 699 files in
    the package with manifest, assets, `resources.pri`, block map, signature and `CodeIntegrity.cat`).
  - `Nigafiy-Quick-Support-0.1.0-x64-local-test.msix`: 7.2 MB, `nigafiy-support.exe` byte-identical
    (SHA-256) to the built program.
- MakeAppx accepted both manifests (it validates them against the schema while packing). Signed with
  the free self-signed test certificate (`CN=Nigafiy Test I1 Nigafiy Code Signing`, no time stamp)
  through the installed `signtool.exe`. `Get-AuthenticodeSignature` reads that signer back on both
  files, status `UnknownError` ("terminated in a root certificate which is not trusted"), as expected
  for a certificate that is not trusted on this PC.
- `makeappx unpack` of both packages and a read of what came out: identity `Nigafiy.LocalTest.Hub` /
  `Nigafiy.LocalTest.QuickSupport` with the certificate's subject as publisher, version 0.1.0.0,
  `runFullTrust` as the only capability, `nigafiy://` / `nigafiy-support:` protocols, the three
  firewall rules for `app\resources\collector\nigafiy-sensor.exe` (that run was before the engine and
  the Sensor became one executable: a build now declares them for
  `app\resources\engine\nigafiy-engine.exe` and refuses a leftover `collector` folder;
  `msix.test.cjs` checks the manifest; the merged package was not rebuilt here) (UDP 5678, UDP 53, TCP 53,
  domain and private only), `app\Nigafiy.exe`, the engine, the sensor, `local.mjs` and `app.asar`
  present. `makepri dump` shows English and Arabic display names, descriptions and protocol names.
- A Store build without Partner Center values stops ("Store identity not configured …"), and one
  with a `LocalTest` name stops too.
- `Add-AppxPackage` of the Quick Support test package as the normal user: refused with
  `0x800B0109` ("The root certificate of the signature in the app package or bundle must be
  trusted"); nothing was installed (`Get-AppxPackage Nigafiy.LocalTest*` is empty). Developer Mode is
  off on this PC and the certificate is in no machine store; trusting it needs administrator rights,
  so the build session went no further (the owner's steps are above).

**Never ran in the build session** (both later ran with the owner, "Real install test" below):

- The Windows App Certification Kit: `appcert.exe` 10.0.26100.2454 is installed but its manifest
  says `requireAdministrator`, so a build session does not start it (no UAC prompt).
- Installing, starting or removing either package.

**Still never ran:** the desktop app's full local stack inside a package (engine, PostgreSQL, API,
web and Sensor started from `WindowsApps`; only `--smoke` ran), the Store notice and the update
card's Store message on a real install, and Quick Support opened from a real `nigafiy-support:` Fleet
link. These are covered by tests only
  (`apps/desktop/test/store-package.test.cjs`, `msix.test.cjs`, engine `update` package tests, the
  agent's `quicksupport` link tests, `platform-updates` and `fleet-reach` API tests).
- A Store build with real Partner Center values, an upload, certification, and Microsoft's
  re-signing: they need the owner's account.
## Real install test (owner, elevated, 2026-11-25)

The owner ran `scripts\install-test\run-elevated.ps1` once as administrator (run `20261125-095600`,
logs and WACK XML in `.data\install-test\20261125-095600\`; MSI results in
[installers.md](installers.md), "Real install test"). The test certificate went into
`LocalMachine\TrustedPeople` only and was removed at the end.

| Package | Checks | Result |
| --- | --- | --- |
| Desktop `Nigafiy-0.1.0-x64-local-test.msix` | signed by the test certificate (Valid once trusted); `Add-AppxPackage`; `Get-AppxPackage` version 0.1.0.0, publisher the test certificate, status Ok (SignatureKind Developer); `app\Nigafiy.exe`, engine, `local.mjs`, `app.asar` present; Start-menu entry; 3 firewall rules for `app\resources\engine\nigafiy-engine.exe` (declared in the manifest); `Nigafiy.exe --smoke` inside the package ok with `"store":"Nigafiy.LocalTest.Hub_0.1.0.0_x64__9s2n42zx96w3r"`; protocol `nigafiy`; `Remove-AppxPackage` leaves no package, no firewall rules and no `Packages\…` data folder | PASS |
| Quick Support `Nigafiy-Quick-Support-0.1.0-x64-local-test.msix` | signed; installed; version, publisher, status Ok; `nigafiy-support.exe` byte-identical to the built program; Start-menu entry "Nigafiy Quick Support"; protocol `nigafiy-support`; removed with its data folder | PASS; launch SKIP (without a Fleet link it only shows an error box and waits for a click) |
| WACK 10.0.26100.2454, desktop | 24 tests, 23 passed; overall **PASS**. The one failure is the **optional** "Blocked executables" test: it lists references to process-launch APIs and to names such as `cmd`, `reg`, `powershell` in Electron, the embedded PostgreSQL, the engine, the bundled API sources and third-party `node_modules` text files. Nigafiy does start its own programs (that is how the desktop runs its local stack), so this stays; it does not block certification. | PASS |
| WACK 10.0.26100.2454, Quick Support | 24 tests, 23 passed; overall **WARNING**: DPIAwarenessValidation, "Failed to process the binary nigafiy-support.exe" and "not DPI Aware". A Go program has no application manifest; the program only called `SetProcessDPIAware` at run time, which WACK cannot see. | WARNING, fixed |

**Fix (commit `7768aa7`):** `nigafiy-support.exe` now carries an application manifest
(`agents/endpoint-agent/cmd/nigafiy-support/nigafiy-support.manifest`: PerMonitorV2 DPI awareness,
`asInvoker`, Windows 10/11), linked in from the committed `rsrc_windows_amd64.syso`, which a small
pure-Go generator writes (`internal/winres`, `tools/winres`, `go generate ./cmd/nigafiy-support`; no
cgo, no external tool, no download). Tests: the COFF object reads back with `debug/pe` (section,
relocation, resource tree, manifest bytes); the committed `.syso` matches the manifest; and the test
program, which links the same `.syso`, starts PerMonitorV2 DPI aware (without the `.syso` that test
fails with awareness 0). Per-monitor awareness also gives the screen capture physical pixels on every
monitor, which `EnumerateDisplays` already assumed. Rebuilt and re-signed
`Nigafiy-Quick-Support-0.1.0-x64-local-test.msix` (10.4 MB); unpacked: identity
`Nigafiy.LocalTest.QuickSupport` 0.1.0.0, `runFullTrust` only, `nigafiy-support.exe` (SHA-256
`6802b14016f40e368d7dcc7f32b54ddafcc8cffa5660a9d86f00bae9e4e4f871`) identical to the built program,
and `mt.exe` reads the PerMonitorV2 manifest out of the packaged exe. **WACK on the rebuilt package
(rerun `20261125-105136`, owner, elevated): overall PASS.** The desktop package did
not change and was not rebuilt.
