<#
.SYNOPSIS
  Reads a Nigafiy MSI's tables without installing it (docs/operations/installers.md).

.DESCRIPTION
  Opens the package read-only through Windows Installer's own COM object (OpenDatabase mode 0,
  msiOpenDatabaseModeReadOnly) and checks what an administrator relies on: the UpgradeCode, a
  per-machine install (ALLUSERS=1), the PROGRAMS property, the registry value it is written to and
  the major-upgrade row. It also prints the package's Authenticode signature. Nothing is installed,
  registered or changed.

  Exit code 0 when every check passes, 1 when a check fails, 2 when the file cannot be read.

.PARAMETER Path
  The .msi to read.

.PARAMETER UpgradeCode
  The UpgradeCode the package must carry. Fixed for the life of the product; never change it.

.PARAMETER Thumbprint
  When given, the package must be signed by the certificate with this SHA-1 thumbprint and its hash
  must match (an untrusted self-signed root is accepted: see docs/operations/code-signing.md).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\installers\Inspect-NigafiyMsi.ps1 -Path "apps\desktop\release\Nigafiy 0.1.0.msi"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$UpgradeCode = '{6DA7D862-27E7-4AC8-809D-89B4128FB3AE}',
  [string]$Thumbprint = ''
)
$ErrorActionPreference = 'Stop'

try {
  $full = (Resolve-Path -LiteralPath $Path).Path
  $installer = New-Object -ComObject WindowsInstaller.Installer
  # 0 = msiOpenDatabaseModeReadOnly
  $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($full, 0))
} catch {
  Write-Error "Cannot open $Path as an MSI database: $($_.Exception.Message)" -ErrorAction Continue
  exit 2
}

function Invoke-Com($obj, [string]$name, [string]$kind, $argList) {
  return $obj.GetType().InvokeMember($name, $kind, $null, $obj, $argList)
}

# Rows of a query as arrays of strings; an empty list when the table does not exist in this package.
function Get-Rows([string]$table, [string[]]$columns) {
  $exists = Invoke-Com $db 'TablePersistent' 'GetProperty' @($table)
  # MSICONDITION_TRUE = 1 (persistent table present)
  if ($exists -ne 1) { return , @() }
  $sql = 'SELECT ' + (($columns | ForEach-Object { '`' + $_ + '`' }) -join ', ') + ' FROM `' + $table + '`'
  $view = Invoke-Com $db 'OpenView' 'InvokeMethod' @($sql)
  [void](Invoke-Com $view 'Execute' 'InvokeMethod' $null)
  $rows = New-Object System.Collections.ArrayList
  while ($true) {
    $rec = Invoke-Com $view 'Fetch' 'InvokeMethod' $null
    if ($null -eq $rec) { break }
    $row = @(for ($i = 1; $i -le $columns.Count; $i++) { [string](Invoke-Com $rec 'StringData' 'GetProperty' @($i)) })
    [void]$rows.Add($row)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($rec)
  }
  [void](Invoke-Com $view 'Close' 'InvokeMethod' $null)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($view)
  return , $rows.ToArray()
}

$props = @{}
foreach ($r in (Get-Rows 'Property' @('Property', 'Value'))) { $props[$r[0]] = $r[1] }
$registry = Get-Rows 'Registry' @('Root', 'Key', 'Name', 'Value', 'Component_')
$upgrade = Get-Rows 'Upgrade' @('UpgradeCode', 'VersionMin', 'VersionMax', 'Attributes', 'ActionProperty')
$search = Get-Rows 'RegLocator' @('Signature_', 'Root', 'Key', 'Name')
$custom = Get-Rows 'CustomAction' @('Action', 'Source', 'Target')
$components = Get-Rows 'Component' @('Component', 'ComponentId')

$same = { param($a, $b) [string]::Equals([string]$a, [string]$b, [StringComparison]::OrdinalIgnoreCase) }
# Registry.Root 2 = HKEY_LOCAL_MACHINE
$programsValue = @($registry | Where-Object { $_[0] -eq '2' -and (& $same $_[1] 'Software\Nigafiy\Hub') -and $_[2] -eq 'Programs' -and $_[3] -eq '[PROGRAMS]' })
$checks = [ordered]@{
  'UpgradeCode matches'                              = (& $same $props['UpgradeCode'] $UpgradeCode)
  'per-machine (ALLUSERS=1)'                         = ($props['ALLUSERS'] -eq '1')
  'ProductName is Nigafiy'                           = ($props['ProductName'] -eq 'Nigafiy')
  'PROGRAMS is a secure public property'             = (@(([string]$props['SecureCustomProperties']) -split ';') -contains 'PROGRAMS')
  'Programs value written to HKLM from [PROGRAMS]'   = ($programsValue.Count -eq 1)
  'its component GUID is the fixed one'              = [bool]($components | Where-Object { $_[0] -eq 'NigafiyProgramsSetting' -and (& $same $_[1] '{7B0E7C1E-5A61-4C38-9E1B-2F4D9C6A8E31}') })
  'earlier choice is read back on upgrade'           = [bool]($search | Where-Object { $_[0] -eq 'NigafiyProgramsSaved' -and $_[1] -eq '2' -and (& $same $_[2] 'Software\Nigafiy\Hub') -and $_[3] -eq 'Programs' })
  'earlier choice is used when PROGRAMS is not given' = [bool]($custom | Where-Object { $_[0] -eq 'NigafiyProgramsFromSaved' -and $_[1] -eq 'PROGRAMS' -and $_[2] -eq '[NIGAFIY_PROGRAMS_SAVED]' })
  'default "all" when nothing was chosen'            = [bool]($custom | Where-Object { $_[0] -eq 'NigafiyProgramsDefault' -and $_[1] -eq 'PROGRAMS' -and $_[2] -eq 'all' })
  'major upgrade row uses the UpgradeCode'           = [bool]($upgrade | Where-Object { (& $same $_[0] $UpgradeCode) })
}

$sig = Get-AuthenticodeSignature -LiteralPath $full
$signer = if ($sig.SignerCertificate) { "$($sig.SignerCertificate.Subject) [$($sig.SignerCertificate.Thumbprint)]" } else { 'none' }
if ($Thumbprint) {
  $want = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  # NotTrusted/UnknownError = the self-signed root is not installed on this computer; the hash still matched.
  $checks['signed by the given certificate, hash intact'] = ($sig.SignerCertificate -and $sig.SignerCertificate.Thumbprint -eq $want -and @('Valid', 'UnknownError', 'NotTrusted') -contains [string]$sig.Status)
}

Write-Output "MSI: $full"
Write-Output ("ProductName {0}  ProductVersion {1}  ProductCode {2}" -f $props['ProductName'], $props['ProductVersion'], $props['ProductCode'])
Write-Output ("UpgradeCode {0}  ALLUSERS {1}  MSIINSTALLPERUSER {2}" -f $props['UpgradeCode'], $props['ALLUSERS'], $props['MSIINSTALLPERUSER'])
Write-Output ("Signature {0}: {1}" -f $sig.Status, $signer)
foreach ($u in $upgrade) { Write-Output ("Upgrade row: code {0} min '{1}' max '{2}' attributes {3} -> {4}" -f $u[0], $u[1], $u[2], $u[3], $u[4]) }
$failed = 0
foreach ($k in $checks.Keys) {
  $ok = [bool]$checks[$k]
  if (-not $ok) { $failed++ }
  Write-Output ("[{0}] {1}" -f $(if ($ok) { 'ok' } else { 'FAIL' }), $k)
}
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($db)
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($installer)
exit $(if ($failed -eq 0) { 0 } else { 1 })
