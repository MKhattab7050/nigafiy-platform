<#
.SYNOPSIS
  Signs Nigafiy executables with Authenticode using only built-in Windows PowerShell (no signtool).

.DESCRIPTION
  The certificate comes from Cert:\CurrentUser\My by -Thumbprint (made by New-NigafiySigningCert.ps1
  or a purchased one imported there), or from a .pfx with -PfxPath (password in the environment
  variable NIGAFIY_SIGN_PFX_PASSWORD, never on the command line).

  -TimestampUrl adds an RFC 3161 timestamp so signatures stay valid after the certificate expires.
  Only the file's hash is sent to that server. -NoTimestamp skips it.

  Fails (exit 1) if any file does not end up with a signature from the chosen certificate.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Path,
  [string]$Thumbprint,
  [string]$PfxPath,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [switch]$NoTimestamp
)
$ErrorActionPreference = 'Stop'

if ($Thumbprint) {
  $clean = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  $cert = Get-Item "Cert:\CurrentUser\My\$clean" -ErrorAction SilentlyContinue
  if (-not $cert) { throw "No certificate with thumbprint $clean in Cert:\CurrentUser\My." }
} elseif ($PfxPath) {
  $pw = $env:NIGAFIY_SIGN_PFX_PASSWORD
  $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path $PfxPath).Path, $pw, $flags)
} else {
  throw 'Give -Thumbprint or -PfxPath.'
}
if (-not $cert.HasPrivateKey) { throw 'The certificate has no private key on this computer.' }
if ($cert.NotAfter -lt (Get-Date)) { throw "The signing certificate expired on $($cert.NotAfter)." }

$failed = 0
foreach ($p in $Path) {
  $file = (Resolve-Path $p).Path
  $sigArgs = @{ FilePath = $file; Certificate = $cert; HashAlgorithm = 'SHA256' }
  if ($TimestampUrl -and -not $NoTimestamp) { $sigArgs.TimestampServer = $TimestampUrl }
  $null = Set-AuthenticodeSignature @sigArgs
  $sig = Get-AuthenticodeSignature -FilePath $file
  # A self-signed certificate that this PC does not trust reports UnknownError; the signature itself
  # is still checked by comparing the signer.
  if ($sig.SignerCertificate -and $sig.SignerCertificate.Thumbprint -eq $cert.Thumbprint -and
      ($sig.Status -eq 'Valid' -or $sig.Status -eq 'UnknownError')) {
    Write-Host "signed  $file  ($($sig.Status))"
  } else {
    Write-Host "FAILED  $file  ($($sig.Status): $($sig.StatusMessage))"
    $failed++
  }
}
if ($failed) { exit 1 }
