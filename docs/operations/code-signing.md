# Code signing (free)

Nigafiy's Windows build signs every program it ships (the desktop app, its uninstaller, the
installer, `nigafiy-engine.exe` and `nigafiy-sensor.exe`) with Authenticode. Signing uses only
built-in Windows PowerShell (`Set-AuthenticodeSignature`): no signtool, no paid service.

## The free route: your organisation's own certificate

Nigafiy is installed on company-owned computers that an administrator manages, so the organisation
can be its own publisher:

1. **Create the certificate once** on the build computer (no administrator rights needed):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\signing\New-NigafiySigningCert.ps1 -Organization "Your Company IT"
   ```

   The private key stays in `Cert:\CurrentUser\My` (non-exportable unless you pass `-ExportPfx`,
   which writes a password-protected backup). The public certificate is written to
   `.data\signing\nigafiy-code-signing.cer` and the thumbprint to `.data\signing\thumbprint.txt`
   (`.data` is git-ignored).

2. **Build signed:**

   ```powershell
   $env:NIGAFIY_SIGN_THUMBPRINT = Get-Content .data\signing\thumbprint.txt
   pnpm --filter @nigafiy/desktop dist
   ```

3. **Trust it on each company computer**, as administrator:

   ```powershell
   powershell -ExecutionPolicy Bypass -File Install-NigafiyTrust.ps1 -CertPath nigafiy-code-signing.cer
   ```

   Or deploy the same `.cer` with Group Policy: *Computer Configuration → Policies → Windows Settings
   → Security Settings → Public Key Policies*, import it under both **Trusted Root Certification
   Authorities** and **Trusted Publishers**. `-Remove` takes the trust away again.

On computers that trust the certificate, the installer and programs show your organisation as the
verified publisher.

## Settings

| Variable | Meaning |
| --- | --- |
| `NIGAFIY_SIGN_THUMBPRINT` | Certificate in `Cert:\CurrentUser\My` |
| `NIGAFIY_SIGN_PFX` + `NIGAFIY_SIGN_PFX_PASSWORD` | Or a `.pfx` file (the password is read from the environment only) |
| `NIGAFIY_SIGN_TIMESTAMP_URL` | RFC 3161 timestamp server, default `http://timestamp.digicert.com` (free). Only the file hash is sent |
| `NIGAFIY_SIGN_NO_TIMESTAMP=1` | Sign without a timestamp (signatures then stop validating when the certificate expires) |
| `NIGAFIY_REQUIRE_SIGNING=1` | Fail the build instead of producing unsigned files when nothing is configured |

With nothing configured the build still works and prints `building UNSIGNED`.

## Honest limits

- A self-signed certificate is trusted **only on computers where its `.cer` is installed**. Anywhere
  else Windows shows "Unknown publisher", and SmartScreen may warn about a downloaded installer.
- SmartScreen reputation for public downloads needs a certificate from a public certificate
  authority. Free ways to get one later, with no code changes here (put the certificate in
  `Cert:\CurrentUser\My` and set `NIGAFIY_SIGN_THUMBPRINT`, or use `NIGAFIY_SIGN_PFX`):
  - **SignPath Foundation** signs open-source projects for free (the repository must be public under
    an OSI licence).
  - **Microsoft Store**: an individual developer account is free; the Store signs MSIX packages it
    distributes.
- Keep the private key off shared drives and never commit a `.pfx`. If it leaks, remove the old
  certificate's trust (`Install-NigafiyTrust.ps1 -Remove`), make a new one and re-sign.

## What was verified

- `apps/desktop/test/signing.test.cjs`: configuration, refusing unsigned builds when required, the
  PFX password never appears in arguments, one PowerShell run per file.
- A real end-to-end run on Windows 11 (2026-11-22): a throwaway key signed a copy of
  `nigafiy-engine.exe` through `node apps/desktop/scripts/signing.cjs`, and Windows read back the
  signer.
- 2026-11-25: full `dist`, `dist:msi` and `build:agent-installer` builds signed with a self-signed
  test certificate created by `New-NigafiySigningCert.ps1` (no timestamp), every signature read back
  with `Get-AuthenticodeSignature` (installers.md, "What ran for real here"). The script's default
  `-OutDir` failed under Windows PowerShell 5.1 and was fixed then.
- Not yet run: a build with an organisation's real certificate, and the trust script (it needs
  administrator rights) on any computer.
