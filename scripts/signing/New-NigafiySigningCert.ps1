<#
.SYNOPSIS
  Creates your organisation's own Nigafiy code-signing certificate, free, with built-in Windows tools.

.DESCRIPTION
  Makes a self-signed code-signing certificate (RSA 3072, SHA-256, valid 5 years) in the current
  user's personal certificate store (Cert:\CurrentUser\My). The private key stays in that store and
  is marked non-exportable unless -ExportPfx is given.

  It also writes the PUBLIC certificate (.cer, no private key) to -OutDir. Install that .cer on the
  company computers that run Nigafiy (Install-NigafiyTrust.ps1, or Group Policy) so Windows trusts
  everything signed with it.

  Honest limits: a self-signed certificate is trusted only on computers where you installed the .cer.
  On other computers Windows still shows "Unknown publisher". See docs/operations/code-signing.md.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\signing\New-NigafiySigningCert.ps1 -Organization "Contoso IT"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Organization,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\.data\signing'),
  [int]$Years = 5,
  [switch]$ExportPfx
)
$ErrorActionPreference = 'Stop'

if ($Organization -match '[,=+<>#;"\\]') { throw 'Organization must not contain , = + < > # ; " or \' }
$subject = "CN=$Organization Nigafiy Code Signing, O=$Organization"

$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date).AddDays(30) }
if ($existing) {
  $cert = $existing | Sort-Object NotAfter -Descending | Select-Object -First 1
  Write-Host "A valid certificate already exists; reusing it."
} else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -KeyExportPolicy ($(if ($ExportPfx) { 'Exportable' } else { 'NonExportable' })) `
    -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears($Years)
  Write-Host "Created certificate $($cert.Thumbprint)."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$cerPath = Join-Path $OutDir 'nigafiy-code-signing.cer'
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
Set-Content -Path (Join-Path $OutDir 'thumbprint.txt') -Value $cert.Thumbprint -Encoding ascii

if ($ExportPfx) {
  $pw = Read-Host -AsSecureString 'Password to protect the .pfx backup'
  $pfxPath = Join-Path $OutDir 'nigafiy-code-signing.pfx'
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pw | Out-Null
  Write-Host "Private key backup: $pfxPath (keep it offline; never commit it)."
}

Write-Host ''
Write-Host "Public certificate: $cerPath"
Write-Host "Thumbprint:         $($cert.Thumbprint)"
Write-Host ''
Write-Host 'Next:'
Write-Host "  1. Build signed:  `$env:NIGAFIY_SIGN_THUMBPRINT='$($cert.Thumbprint)'; pnpm --filter @lan-detective/desktop dist"
Write-Host "  2. Trust it on each company PC (as administrator): scripts\signing\Install-NigafiyTrust.ps1 -CertPath <path to .cer>"
