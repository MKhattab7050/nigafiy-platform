<#
.SYNOPSIS
  Makes this computer trust programs signed with your organisation's Nigafiy certificate.

.DESCRIPTION
  Run as administrator on each company computer that runs Nigafiy (or deploy the same .cer with
  Group Policy: Computer Configuration > Policies > Windows Settings > Security Settings >
  Public Key Policies > "Trusted Root Certification Authorities" and "Trusted Publishers").

  Imports the PUBLIC certificate (.cer) into LocalMachine\Root and LocalMachine\TrustedPublisher.
  Refuses a file that contains a private key, a certificate that is not for code signing, and an
  expired certificate. -Remove takes the trust away again.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File Install-NigafiyTrust.ps1 -CertPath .\nigafiy-code-signing.cer
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CertPath,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an administrator PowerShell.'
}
if ([IO.Path]::GetExtension($CertPath) -ne '.cer') { throw 'Give the public .cer file, not a .pfx.' }

$cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path $CertPath).Path)
if ($cert.HasPrivateKey) { throw 'This file contains a private key. Use the public .cer only.' }
$codeSigning = $cert.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }
if (-not $codeSigning) { throw 'This is not a code-signing certificate.' }
if ($cert.NotAfter -lt (Get-Date)) { throw "This certificate expired on $($cert.NotAfter)." }

foreach ($store in 'Root', 'TrustedPublisher') {
  $path = "Cert:\LocalMachine\$store\$($cert.Thumbprint)"
  if ($Remove) {
    if (Test-Path $path) { Remove-Item $path; Write-Host "Removed from LocalMachine\$store." }
  } elseif (Test-Path $path) {
    Write-Host "Already trusted in LocalMachine\$store."
  } else {
    Import-Certificate -FilePath $CertPath -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
    Write-Host "Trusted in LocalMachine\$store."
  }
}
Write-Host "Certificate: $($cert.Subject)  ($($cert.Thumbprint)), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))"
