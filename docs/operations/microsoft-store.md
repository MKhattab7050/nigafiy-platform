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
| Sensor listeners | MNDP (UDP 5678, receive-only) and the DNS filter (53, off until turned on) listen on the LAN: declared as firewall rules for `nigafiy-sensor.exe`, domain and private networks only. ICMP echo uses the same code as today. | — |
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
