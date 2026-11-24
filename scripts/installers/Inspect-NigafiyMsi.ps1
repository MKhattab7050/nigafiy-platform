<#
.SYNOPSIS
  Reads a Nigafiy MSI's tables without installing it (docs/operations/installers.md).

.DESCRIPTION
  Opens the package read-only through Windows Installer's own COM object (msiOpenDatabaseModeReadOnly)
  and checks what an administrator relies on: the UpgradeCode, a per-machine install (ALLUSERS=1),
  the PROGRAMS property and the registry value it is written to. Nothing is installed or changed.
  Exit code 0 when every check passes, 1 otherwise.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\installers\Inspect-NigafiyMsi.ps1 -Path "apps\desktop\release\Nigafiy 1.2.3.msi"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$UpgradeCode = '{6DA7D862-27E7-4AC8-809D-89B4128FB3AE}'
)
$ErrorActionPreference = 'Stop'
$full = (Resolve-Path -LiteralPath $Path).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($full, 0)) # 0 = read-only

function Get-Rows([string]$sql, [int]$columns) {
  $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($sql))
  $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
  $rows = @()
  while ($true) {
    $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
    if ($null -eq $rec) { break }
    $row = @()
    for ($i = 1; $i -le $columns; $i++) { $row += $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @($i)) }
    $rows += , $row
  }
  $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
  return , $rows
}

$props = @{}
foreach ($r in (Get-Rows 'SELECT `Property`, `Value` FROM `Property`' 2)) { $props[$r[0]] = $r[1] }
$registry = Get-Rows 'SELECT `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`' 5
$upgrade = Get-Rows 'SELECT `UpgradeCode`, `VersionMin`, `VersionMax`, `Attributes`, `ActionProperty` FROM `Upgrade`' 5
$search = Get-Rows 'SELECT `Signature_`, `Root`, `Key`, `Name` FROM `RegLocator`' 4
$custom = Get-Rows 'SELECT `Action`, `Source`, `Target` FROM `CustomAction`' 3

# Summary information: word count bit 3 (8) = elevated/per-machine is not in the summary, so ALLUSERS decides.
$checks = [ordered]@{
  'UpgradeCode matches'                     = ($props['UpgradeCode'] -eq $UpgradeCode)
  'per-machine (ALLUSERS=1)'                = ($props['ALLUSERS'] -eq '1')
  'ProductName is Nigafiy'                  = ($props['ProductName'] -eq 'Nigafiy')
  'PROGRAMS is a secure public property'    = ($props['SecureCustomProperties'] -split ';' -contains 'PROGRAMS')
  'Programs value written to HKLM from [PROGRAMS]' = [bool]($registry | Where-Object { $_[0] -eq '2' -and $_[1] -eq 'Software\Nigafiy\Hub' -and $_[2] -eq 'Programs' -and $_[3] -eq '[PROGRAMS]' })
  'earlier choice is read back on upgrade'  = [bool]($search | Where-Object { $_[0] -eq 'NigafiyProgramsSaved' -and $_[1] -eq '2' -and $_[2] -eq 'Software\Nigafiy\Hub' -and $_[3] -eq 'Programs' })
  'default "all" when PROGRAMS is not given' = [bool]($custom | Where-Object { $_[0] -eq 'NigafiyProgramsDefault' -and $_[2] -eq 'all' })
  'Upgrade table uses the UpgradeCode'      = [bool]($upgrade | Where-Object { $_[0] -eq $UpgradeCode })
}

Write-Output "MSI: $full"
Write-Output ("ProductCode {0}  ProductVersion {1}  UpgradeCode {2}  ALLUSERS {3}" -f $props['ProductCode'], $props['ProductVersion'], $props['UpgradeCode'], $props['ALLUSERS'])
$failed = 0
foreach ($k in $checks.Keys) {
  $ok = [bool]$checks[$k]
  if (-not $ok) { $failed++ }
  Write-Output ("[{0}] {1}" -f $(if ($ok) { 'ok' } else { 'FAIL' }), $k)
}
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($db) | Out-Null
exit $(if ($failed -eq 0) { 0 } else { 1 })
