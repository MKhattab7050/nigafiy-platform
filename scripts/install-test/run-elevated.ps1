<#
.SYNOPSIS
  One real install test of the Nigafiy desktop MSI and the two local-test MSIX packages (desktop app
  and Quick Support), plus the Windows App Certification Kit, on this PC. The owner runs it once in
  an elevated PowerShell; it never elevates itself.

.DESCRIPTION
  What it changes, and undoes before it ends (also after a failure, in finally):
    1. Imports the free self-signed test signing certificate into Cert:\LocalMachine\TrustedPeople
       ONLY (never Root), unless that thumbprint is already there; removes it again by thumbprint.
    2. Installs "Nigafiy <v>.msi" per machine, silently (msiexec /qn, PROGRAMS=radar,watch), checks
       files, signatures, services, Start-menu and desktop shortcuts, the Programs entry and version,
       HKLM\Software\Nigafiy\Hub Programs, `nigafiy-engine install-info` and `Nigafiy.exe --smoke`
       (scratch profile under the log folder, no network, no ports); uninstalls it (msiexec /x /qn)
       and checks that it is gone. HKCU\Software\Classes\nigafiy (written by the smoke run) and
       HKLM\Software\Nigafiy\Hub are put back as they were before.
    3. Installs each MSIX (Add-AppxPackage, for the current user), checks Get-AppxPackage, the
       manifest, the Start-menu entry, the files, the firewall rules the desktop package declares,
       and for the desktop package a `--smoke` start inside the package; removes them and checks
       that they, their firewall rules and their LocalState folders are gone.
    4. Runs WACK (appcert.exe) on both MSIX when the Windows SDK's App Certification Kit is
       installed (it downloads nothing); WACK installs, starts and removes each package itself.
  Nothing else on the PC is changed. Everything is logged under .data\install-test\<timestamp>\.
  Safe to rerun: a state file (.data\install-test\pending-cleanup.json) records what this script
  installed or imported, and a rerun undoes a previous run's leftovers first. It never touches a
  Nigafiy MSI, a folder or a certificate it did not put there itself.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-test\run-elevated.ps1
#>
[CmdletBinding()]
param(
  [string]$MsiPath = '',
  [string]$DesktopMsixPath = '',
  [string]$SupportMsixPath = '',
  [string]$CertPath = '',
  [string]$Programs = 'radar,watch',
  [switch]$SkipWack
)

$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Release = Join-Path $Repo 'apps\desktop\release'
$Version = (Get-Content -Raw -LiteralPath (Join-Path $Repo 'apps\desktop\package.json') | ConvertFrom-Json).version
if (-not $MsiPath) { $MsiPath = Join-Path $Release "Nigafiy $Version.msi" }
if (-not $DesktopMsixPath) { $DesktopMsixPath = Join-Path $Release "Nigafiy-$Version-x64-local-test.msix" }
if (-not $SupportMsixPath) { $SupportMsixPath = Join-Path $Release "Nigafiy-Quick-Support-$Version-x64-local-test.msix" }
if (-not $CertPath) { $CertPath = Join-Path $Repo '.data\install-test\nigafiy-test-signing.cer' }

$UpgradeCode = '{6DA7D862-27E7-4AC8-809D-89B4128FB3AE}'
$InstallDir = Join-Path $env:ProgramFiles 'Nigafiy'
$TestRoot = Join-Path $Repo '.data\install-test'
$StateFile = Join-Path $TestRoot 'pending-cleanup.json'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $TestRoot $Stamp
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$ResultsFile = Join-Path $LogDir 'results.json'
$script:Results = New-Object System.Collections.ArrayList

Start-Transcript -LiteralPath (Join-Path $LogDir 'transcript.log') | Out-Null

function Write-Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

function Add-Result([string]$area, [string]$check, [string]$status, [string]$detail = '') {
  [void]$script:Results.Add([ordered]@{ area = $area; check = $check; status = $status; detail = $detail; at = (Get-Date).ToString('s') })
  $color = 'Gray'
  if ($status -eq 'PASS') { $color = 'Green' } elseif ($status -eq 'FAIL') { $color = 'Red' } elseif ($status -eq 'SKIP') { $color = 'Yellow' }
  Write-Host ("[{0}] {1}: {2} {3}" -f $status, $area, $check, $detail) -ForegroundColor $color
  Save-Results
}

function Save-Results {
  $doc = [ordered]@{ version = $Version; started = $Stamp; logDir = $LogDir; results = @($script:Results) }
  ($doc | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $ResultsFile -Encoding UTF8
}

function Test-Check([string]$area, [string]$check, [bool]$ok, [string]$detail = '') {
  if ($ok) { Add-Result $area $check 'PASS' $detail } else { Add-Result $area $check 'FAIL' $detail }
  return $ok
}

# ---- state for safe reruns -------------------------------------------------------------------
function Get-State {
  if (Test-Path -LiteralPath $StateFile) { return (Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json) }
  return $null
}
function Set-StateValue([string]$name, $value) {
  $s = @{}
  $cur = Get-State
  if ($cur) { foreach ($p in $cur.PSObject.Properties) { $s[$p.Name] = $p.Value } }
  if ($null -eq $value) { $s.Remove($name) } else { $s[$name] = $value }
  if ($s.Count -eq 0) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue; return }
  ($s | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $StateFile -Encoding UTF8
}
function Get-StateValue([string]$name) {
  $cur = Get-State
  if ($cur -and ($cur.PSObject.Properties.Name -contains $name)) { return $cur.$name }
  return $null
}

# ---- helpers ---------------------------------------------------------------------------------
function Get-RelatedMsiProducts {
  $i = New-Object -ComObject WindowsInstaller.Installer
  return @($i.RelatedProducts($UpgradeCode))
}

function Get-MsiProperty([string]$path, [string]$name) {
  $i = New-Object -ComObject WindowsInstaller.Installer
  $db = $i.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $i, @($path, 0))
  $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$name'"))
  [void]$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
  $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
  if ($null -eq $rec) { return $null }
  return $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(1))
}

function Invoke-Logged([string]$file, [string[]]$arguments, [string]$logName, [int]$timeoutSec = 1800) {
  $out = Join-Path $LogDir "$logName.stdout.txt"
  $err = Join-Path $LogDir "$logName.stderr.txt"
  Write-Host "> $file $($arguments -join ' ')"
  $p = Start-Process -FilePath $file -ArgumentList $arguments -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    Write-Host "timed out after $timeoutSec s, stopping PID $($p.Id) (started by this script)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    return @{ code = -1; stdout = (Get-Content -Raw -LiteralPath $out -ErrorAction SilentlyContinue); timedOut = $true }
  }
  return @{ code = $p.ExitCode; stdout = (Get-Content -Raw -LiteralPath $out -ErrorAction SilentlyContinue); timedOut = $false }
}

function Invoke-Msiexec([string[]]$arguments, [string]$logName) {
  $log = Join-Path $LogDir "$logName.log"
  Write-Host "> msiexec.exe $($arguments -join ' ') /l*v `"$log`""
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList ($arguments + @('/l*v', "`"$log`"")) -PassThru -Wait
  return $p.ExitCode
}

function Export-RegKey([string]$regPath, [string]$name) {
  # reg.exe export of a key, or $null when the key does not exist.
  & reg.exe query $regPath *> $null
  if ($LASTEXITCODE -ne 0) { return $null }
  $file = Join-Path $TestRoot "backup-$name.reg"
  & reg.exe export $regPath $file /y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "reg export $regPath failed" }
  return $file
}

function Restore-RegKey([string]$regPath, [string]$stateName) {
  # Puts a key back as it was before the test: re-imports the backup, or deletes the key when it did
  # not exist then. The state value is "absent" or the backup file.
  $before = Get-StateValue $stateName
  if ($null -eq $before) { return }
  & reg.exe delete $regPath /f *> $null
  if ($before -ne 'absent') {
    & reg.exe import $before *> $null
    if ($LASTEXITCODE -ne 0) { throw "reg import $before failed" }
    Remove-Item -LiteralPath $before -Force -ErrorAction SilentlyContinue
  }
  Set-StateValue $stateName $null
}

function Save-RegKey([string]$regPath, [string]$stateName, [string]$fileName) {
  if ($null -ne (Get-StateValue $stateName)) { return } # an earlier run's backup is the real "before"
  $b = Export-RegKey $regPath $fileName
  if ($b) { Set-StateValue $stateName $b } else { Set-StateValue $stateName 'absent' }
}

function Stop-ProcessesUnder([string]$folder) {
  # Only programs started from the folder this script installed (the MSI folder or a test package).
  if (-not $folder) { return }
  $prefix = $folder.TrimEnd('\') + '\'
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {
    Write-Host "stopping PID $($_.ProcessId) $($_.ExecutablePath) (started from the test install)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-Signer([string]$file) {
  $s = Get-AuthenticodeSignature -LiteralPath $file
  $t = ''
  if ($s.SignerCertificate) { $t = $s.SignerCertificate.Thumbprint }
  return @{ status = [string]$s.Status; thumbprint = $t }
}

function Get-PackageFirewallRules([string]$installLocation) {
  if (-not $installLocation) { return @() }
  $prefix = $installLocation.TrimEnd('\') + '\'
  return @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.Program -and $_.Program.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

# ---- cleanup (also of an earlier run) ---------------------------------------------------------
function Invoke-Cleanup([string]$why) {
  Write-Step "Cleanup ($why)"
  # Test packages: only the LocalTest identities, which nothing but these test builds uses.
  foreach ($name in @('Nigafiy.LocalTest.Hub', 'Nigafiy.LocalTest.QuickSupport')) {
    foreach ($p in @(Get-AppxPackage -Name $name -ErrorAction SilentlyContinue)) {
      try {
        Stop-ProcessesUnder $p.InstallLocation
        Remove-AppxPackage -Package $p.PackageFullName
        Write-Host "removed $($p.PackageFullName)"
      } catch { Add-Result 'cleanup' "remove $($p.PackageFullName)" 'FAIL' $_.Exception.Message }
    }
  }
  # The MSI, only when this script installed it.
  $pc = Get-StateValue 'msiProductCode'
  if ($pc) {
    $related = Get-RelatedMsiProducts
    if ($related -contains $pc) {
      Stop-ProcessesUnder $InstallDir
      $code = Invoke-Msiexec @('/x', $pc, '/qn', '/norestart') "cleanup-msi-uninstall-$((Get-Date).ToString('HHmmss'))"
      if ($code -ne 0 -and $code -ne 3010) { Add-Result 'cleanup' 'MSI uninstall' 'FAIL' "msiexec exit $code" } else { Write-Host "MSI $pc removed" }
    }
    if (-not ((Get-RelatedMsiProducts) -contains $pc)) { Set-StateValue 'msiProductCode' $null }
  }
  try { Restore-RegKey 'HKCU\Software\Classes\nigafiy' 'hkcuProtocolBefore' } catch { Add-Result 'cleanup' 'restore HKCU\Software\Classes\nigafiy' 'FAIL' $_.Exception.Message }
  try { Restore-RegKey 'HKLM\Software\Nigafiy\Hub' 'hklmHubBefore' } catch { Add-Result 'cleanup' 'restore HKLM\Software\Nigafiy\Hub' 'FAIL' $_.Exception.Message }
  if ((Get-StateValue 'hklmNigafiyAbsent') -eq $true) {
    # HKLM\Software\Nigafiy did not exist before the test: remove it again if it is now empty.
    $k = 'HKLM:\Software\Nigafiy'
    if ((Test-Path $k) -and -not (Get-ChildItem $k) -and -not (Get-Item $k).Property) { Remove-Item $k -Force }
    Set-StateValue 'hklmNigafiyAbsent' $null
  }
  # The certificate, only when this script imported it.
  $thumb = Get-StateValue 'certImported'
  if ($thumb) {
    $c = "Cert:\LocalMachine\TrustedPeople\$thumb"
    if (Test-Path $c) { Remove-Item -LiteralPath $c -Force; Write-Host "removed certificate $thumb from LocalMachine\TrustedPeople" }
    if (-not (Test-Path $c)) { Set-StateValue 'certImported' $null }
  }
}

# ---- MSI -------------------------------------------------------------------------------------
function Test-Msi([string]$thumb) {
  $area = 'MSI'
  Write-Step "MSI: $MsiPath"
  if (-not (Test-Check $area 'package present' (Test-Path -LiteralPath $MsiPath) $MsiPath)) { return }
  $sig = Get-Signer $MsiPath
  [void](Test-Check $area 'package signed by the test certificate' ($sig.thumbprint -eq $thumb) "$($sig.thumbprint) $($sig.status)")
  $productCode = Get-MsiProperty $MsiPath 'ProductCode'
  $productVersion = Get-MsiProperty $MsiPath 'ProductVersion'
  Write-Host "ProductCode $productCode ProductVersion $productVersion"

  $related = Get-RelatedMsiProducts
  if ($related.Count -gt 0) {
    Add-Result $area 'no Nigafiy MSI installed before the test' 'FAIL' ("already installed: " + ($related -join ', ') + '; the test does not touch an install it did not make')
    return
  }
  if (Test-Path -LiteralPath $InstallDir) {
    Add-Result $area "$InstallDir absent before the test" 'FAIL' 'the folder exists; the test does not install over it'
    return
  }
  Add-Result $area 'clean before the test' 'PASS' "no product with UpgradeCode $UpgradeCode, no $InstallDir"

  Save-RegKey 'HKLM\Software\Nigafiy\Hub' 'hklmHubBefore' 'hklm-nigafiy-hub'
  if (-not (Test-Path 'HKLM:\Software\Nigafiy') -and $null -eq (Get-StateValue 'hklmNigafiyAbsent')) { Set-StateValue 'hklmNigafiyAbsent' $true }
  Save-RegKey 'HKCU\Software\Classes\nigafiy' 'hkcuProtocolBefore' 'hkcu-classes-nigafiy'
  $servicesBefore = @(Get-CimInstance Win32_Service | ForEach-Object { $_.Name })

  # Install.
  Set-StateValue 'msiProductCode' $productCode
  $code = Invoke-Msiexec @('/i', "`"$MsiPath`"", '/qn', '/norestart', "PROGRAMS=$Programs") 'msi-install'
  if (-not (Test-Check $area 'msiexec /i /qn exit code' ($code -eq 0 -or $code -eq 3010) "exit $code (log msi-install.log)")) { return }
  $installed = Get-RelatedMsiProducts
  [void](Test-Check $area 'registered with Windows Installer' ($installed -contains $productCode) ($installed -join ', '))

  # Files and signatures.
  $exe = Join-Path $InstallDir 'Nigafiy.exe'
  $engine = Join-Path $InstallDir 'resources\engine\nigafiy-engine.exe'
  foreach ($rel in @('Nigafiy.exe', 'resources\app.asar', 'resources\engine\nigafiy-engine.exe', 'resources\backend\local.mjs', 'resources\backend\api', 'resources\backend\web')) {
    [void](Test-Check $area "file $rel" (Test-Path -LiteralPath (Join-Path $InstallDir $rel)))
  }
  [void](Test-Check $area 'no separate Sensor program (resources\collector absent)' (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\collector'))))
  $exes = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter *.exe -File)
  $badSig = @($exes | Where-Object { (Get-Signer $_.FullName).thumbprint -ne $thumb })
  [void](Test-Check $area "every .exe signed by the test certificate ($($exes.Count))" ($badSig.Count -eq 0) (($badSig | ForEach-Object { $_.FullName }) -join '; '))
  $fileCount = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File).Count
  Add-Result $area 'installed file count' 'INFO' "$fileCount files in $InstallDir"

  # Services: the MSI installs none.
  $newServices = @(Get-CimInstance Win32_Service | Where-Object { $servicesBefore -notcontains $_.Name })
  $underInstall = @(Get-CimInstance Win32_Service | Where-Object { $_.PathName -and $_.PathName -like "*$InstallDir*" })
  [void](Test-Check $area 'no Windows service installed' ($newServices.Count -eq 0 -and $underInstall.Count -eq 0) ((@($newServices) + @($underInstall) | ForEach-Object { $_.Name }) -join ', '))

  # Shortcuts.
  $startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
  $links = @(Get-ChildItem -LiteralPath $startMenu -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*Nigafiy*' })
  $shell = New-Object -ComObject WScript.Shell
  $startOk = @($links | Where-Object { $shell.CreateShortcut($_.FullName).TargetPath -ieq $exe })
  [void](Test-Check $area 'Start-menu shortcut to Nigafiy.exe (all users)' ($startOk.Count -ge 1) (($links | ForEach-Object { $_.FullName }) -join '; '))
  $publicDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
  $desk = @(Get-ChildItem -LiteralPath $publicDesktop -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $shell.CreateShortcut($_.FullName).TargetPath -ieq $exe })
  [void](Test-Check $area 'desktop shortcut (public desktop)' ($desk.Count -ge 1) (($desk | ForEach-Object { $_.FullName }) -join '; '))

  # Programs and Features entry.
  $arp = Get-ItemProperty -LiteralPath "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productCode" -ErrorAction SilentlyContinue
  if ($arp) {
    [void](Test-Check $area 'Programs entry name' ($arp.DisplayName -eq 'Nigafiy') "$($arp.DisplayName)")
    $dv = [string]$arp.DisplayVersion
    [void](Test-Check $area 'Programs entry version' ($dv -eq $productVersion -or $dv -eq $Version -or $dv -eq "$Version.0") "DisplayVersion $dv, ProductVersion $productVersion, package.json $Version")
    [void](Test-Check $area 'Programs entry is a Windows Installer entry' ($arp.WindowsInstaller -eq 1) "WindowsInstaller=$($arp.WindowsInstaller) Publisher=$($arp.Publisher)")
  } else {
    Add-Result $area 'Programs entry' 'FAIL' "no HKLM Uninstall\$productCode"
  }

  # PROGRAMS property.
  $hub = Get-ItemProperty -LiteralPath 'HKLM:\Software\Nigafiy\Hub' -ErrorAction SilentlyContinue
  $val = ''
  if ($hub -and ($hub.PSObject.Properties.Name -contains 'Programs')) { $val = [string]$hub.Programs }
  [void](Test-Check $area "HKLM\Software\Nigafiy\Hub Programs = $Programs" ($val -eq $Programs) "read $val")

  # The engine's own view of the install (read-only).
  if (Test-Path -LiteralPath $engine) {
    $r = Invoke-Logged $engine @('install-info') 'msi-engine-install-info' 60
    $txt = [string]$r.stdout
    [void](Test-Check $area 'nigafiy-engine install-info says msi' ($r.code -eq 0 -and $txt -match '(?i)\bmsi\b') (($txt -replace '\s+', ' ').Trim()))
  }

  # Start-up self-check of the installed app: scratch profile, no local stack, no ports, then it quits.
  if (Test-Path -LiteralPath $exe) {
    $profile = Join-Path $LogDir 'msi-smoke-profile'
    $r = Invoke-Logged $exe @('--smoke', "--user-data-dir=`"$profile`"") 'msi-smoke' 120
    $line = ([string]$r.stdout -split "`r?`n" | Where-Object { $_ -match '"smoke"' } | Select-Object -Last 1)
    [void](Test-Check $area 'Nigafiy.exe --smoke' ($r.code -eq 0 -and $line -match '"smoke":"ok"') "exit $($r.code) $line")
    Stop-ProcessesUnder $InstallDir
  }
  # The smoke run registers nigafiy:// for this user (HKCU): put it back now.
  Restore-RegKey 'HKCU\Software\Classes\nigafiy' 'hkcuProtocolBefore'

  # Uninstall.
  Stop-ProcessesUnder $InstallDir
  $code = Invoke-Msiexec @('/x', $productCode, '/qn', '/norestart') 'msi-uninstall'
  [void](Test-Check $area 'msiexec /x /qn exit code' ($code -eq 0 -or $code -eq 3010) "exit $code (log msi-uninstall.log)")
  $after = Get-RelatedMsiProducts
  if (Test-Check $area 'no longer registered' (-not ($after -contains $productCode)) ($after -join ', ')) { Set-StateValue 'msiProductCode' $null }
  $left = @()
  if (Test-Path -LiteralPath $InstallDir) { $left = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue) }
  [void](Test-Check $area "$InstallDir removed" (-not (Test-Path -LiteralPath $InstallDir)) ("$($left.Count) items left: " + (($left | Select-Object -First 20 | ForEach-Object { $_.FullName }) -join '; ')))
  [void](Test-Check $area 'Programs entry removed' (-not (Test-Path -LiteralPath "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productCode")))
  $links = @(Get-ChildItem -LiteralPath $startMenu -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*Nigafiy*' -and $shell.CreateShortcut($_.FullName).TargetPath -ieq $exe })
  $desk = @(Get-ChildItem -LiteralPath $publicDesktop -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $shell.CreateShortcut($_.FullName).TargetPath -ieq $exe })
  [void](Test-Check $area 'shortcuts removed' ($links.Count -eq 0 -and $desk.Count -eq 0) ((@($links) + @($desk) | ForEach-Object { $_.FullName }) -join '; '))
  $hub = Get-ItemProperty -LiteralPath 'HKLM:\Software\Nigafiy\Hub' -ErrorAction SilentlyContinue
  $hasVal = $hub -and ($hub.PSObject.Properties.Name -contains 'Programs')
  $hadBefore = (Get-StateValue 'hklmHubBefore') -ne 'absent'
  if ($hadBefore) { Add-Result $area 'HKLM\Software\Nigafiy\Hub Programs after uninstall' 'INFO' "the key existed before the test; it is restored from the backup" }
  else { [void](Test-Check $area 'HKLM\Software\Nigafiy\Hub Programs removed by the uninstall' (-not $hasVal)) }
  Restore-RegKey 'HKLM\Software\Nigafiy\Hub' 'hklmHubBefore'
}

# ---- MSIX ------------------------------------------------------------------------------------
function Test-Msix([string]$label, [string]$path, [string]$name, [string]$appId, [string]$exeRel, [string]$thumb, [string]$subject, [bool]$desktop) {
  $area = "MSIX $label"
  Write-Step "$area`: $path"
  if (-not (Test-Check $area 'package present' (Test-Path -LiteralPath $path) $path)) { return }
  $sig = Get-Signer $path
  [void](Test-Check $area 'package signed by the test certificate' ($sig.thumbprint -eq $thumb) "$($sig.thumbprint) $($sig.status)")
  foreach ($old in @(Get-AppxPackage -Name $name -ErrorAction SilentlyContinue)) { Remove-AppxPackage -Package $old.PackageFullName }

  try {
    Add-AppxPackage -Path $path -ForceApplicationShutdown
    Add-Result $area 'Add-AppxPackage' 'PASS'
  } catch {
    Add-Result $area 'Add-AppxPackage' 'FAIL' $_.Exception.Message
    try { Get-AppxLog -All | Select-Object -First 60 | Out-File -LiteralPath (Join-Path $LogDir "appx-$label-install-error.txt") -Encoding UTF8 } catch {}
    return
  }
  $p = Get-AppxPackage -Name $name
  if (-not (Test-Check $area 'Get-AppxPackage finds it' ($null -ne $p))) { return }
  $p | Format-List * | Out-File -LiteralPath (Join-Path $LogDir "appx-$label.txt") -Encoding UTF8
  [void](Test-Check $area 'version' ($p.Version -eq "$Version.0") "$($p.Version)")
  [void](Test-Check $area 'publisher is the test certificate' ($p.Publisher -eq $subject) "$($p.Publisher)")
  [void](Test-Check $area 'status Ok' ([string]$p.Status -eq 'Ok') "$($p.Status) SignatureKind=$($p.SignatureKind)")
  $exe = Join-Path $p.InstallLocation $exeRel
  [void](Test-Check $area "file $exeRel" (Test-Path -LiteralPath $exe) $exe)
  $m = Get-AppxPackageManifest -Package $p.PackageFullName
  $m.OuterXml | Out-File -LiteralPath (Join-Path $LogDir "appx-$label-manifest.xml") -Encoding UTF8
  $start = @(Get-StartApps | Where-Object { $_.AppID -eq "$($p.PackageFamilyName)!$appId" })
  [void](Test-Check $area 'Start-menu entry' ($start.Count -ge 1) (($start | ForEach-Object { "$($_.Name) ($($_.AppID))" }) -join '; '))

  if ($desktop) {
    foreach ($rel in @('app\resources\engine\nigafiy-engine.exe', 'app\resources\backend\local.mjs', 'app\resources\app.asar')) {
      [void](Test-Check $area "file $rel" (Test-Path -LiteralPath (Join-Path $p.InstallLocation $rel)))
    }
    $rules = Get-PackageFirewallRules $p.InstallLocation
    $progs = @($rules | ForEach-Object { $_.Program } | Sort-Object -Unique)
    $anyEngine = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*nigafiy-engine.exe' } | ForEach-Object { $_.Program } | Sort-Object -Unique)
    Add-Result $area 'firewall filters naming nigafiy-engine.exe (any)' 'INFO' ($anyEngine -join '; ')
    [void](Test-Check $area 'firewall rules for nigafiy-engine.exe (declared in the manifest)' ($rules.Count -ge 3 -and ($progs | Where-Object { $_ -like '*\app\resources\engine\nigafiy-engine.exe' })) "$($rules.Count) rules: $($progs -join '; ')")

    # Start-up self-check inside the package (package identity, scratch profile, no ports).
    $out = Join-Path $LogDir 'msix-desktop-smoke.txt'
    $profile = Join-Path $LogDir 'msix-smoke-profile'
    try {
      Invoke-CommandInDesktopPackage -PackageFamilyName $p.PackageFamilyName -AppId $appId -Command 'cmd.exe' -Args "/d /c `"`"$exe`" --smoke --user-data-dir=`"$profile`" > `"$out`" 2>&1`"" -PreventBreakaway
      $deadline = (Get-Date).AddSeconds(90)
      $line = $null
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-Path -LiteralPath $out) { $line = (Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ -match '"smoke"' } | Select-Object -Last 1) }
        if ($line) { break }
      }
      [void](Test-Check $area 'Nigafiy.exe --smoke inside the package' ($line -match '"smoke":"ok"' -and $line -match '"store":"[^"]') "$line")
    } catch {
      Add-Result $area 'Nigafiy.exe --smoke inside the package' 'SKIP' "Invoke-CommandInDesktopPackage: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 3
    Stop-ProcessesUnder $p.InstallLocation
  } else {
    $built = Join-Path $Repo 'agents\endpoint-agent\bin\nigafiy-support.exe'
    if (Test-Path -LiteralPath $built) {
      $same = (Get-FileHash -LiteralPath $exe).Hash -eq (Get-FileHash -LiteralPath $built).Hash
      [void](Test-Check $area 'nigafiy-support.exe identical to the built program' $same)
    }
    Add-Result $area 'launch' 'SKIP' 'started without a Fleet link it only shows an error dialog and waits for a click; its link handling is covered by the agent quicksupport tests'
  }
  try {
    $protocols = @($m.Package.Applications.Application.Extensions.Extension | Where-Object { $_.Category -eq 'windows.protocol' } | ForEach-Object { $_.Protocol.Name })
    Add-Result $area 'declared protocols' 'INFO' ($protocols -join ', ')
  } catch { Add-Result $area 'declared protocols' 'INFO' "could not read: $($_.Exception.Message)" }

  # Remove.
  $loc = $p.InstallLocation
  $pfn = $p.PackageFamilyName
  Stop-ProcessesUnder $loc
  try { Remove-AppxPackage -Package $p.PackageFullName; Add-Result $area 'Remove-AppxPackage' 'PASS' } catch { Add-Result $area 'Remove-AppxPackage' 'FAIL' $_.Exception.Message }
  [void](Test-Check $area 'Get-AppxPackage empty after removal' ($null -eq (Get-AppxPackage -Name $name)))
  if ($desktop) { [void](Test-Check $area 'firewall rules removed' ((Get-PackageFirewallRules $loc).Count -eq 0)) }
  $data = Join-Path $env:LOCALAPPDATA "Packages\$pfn"
  [void](Test-Check $area 'package data folder removed' (-not (Test-Path -LiteralPath $data)) $data)
}

# ---- WACK ------------------------------------------------------------------------------------
function Invoke-Wack([string]$label, [string]$path) {
  $area = "WACK $label"
  $appcert = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\App Certification Kit\appcert.exe'
  if (-not (Test-Path -LiteralPath $appcert)) {
    Add-Result $area 'appcert.exe' 'SKIP' "not installed ($appcert). It comes with the Windows SDK (Windows App Certification Kit feature): https://developer.microsoft.com/windows/downloads/windows-sdk/ . This script downloads nothing."
    return
  }
  if (-not (Test-Path -LiteralPath $path)) { Add-Result $area 'package present' 'FAIL' $path; return }
  Write-Step "$area`: $path"
  $report = Join-Path $LogDir "wack-$label.xml"
  [void](Invoke-Logged $appcert @('reset') "wack-$label-reset" 300)
  $r = Invoke-Logged $appcert @('test', '-appxpackagepath', "`"$path`"", '-reportoutputpath', "`"$report`"") "wack-$label" 5400
  if (-not (Test-Path -LiteralPath $report)) { Add-Result $area 'report written' 'FAIL' "appcert exit $($r.code), timedOut=$($r.timedOut), see wack-$label.stdout.txt"; return }
  $xml = [xml](Get-Content -Raw -LiteralPath $report)
  $overall = [string]$xml.REPORT.OVERALL_RESULT
  $status = 'FAIL'
  if ($overall -eq 'PASS') { $status = 'PASS' } elseif ($overall -match 'WARN') { $status = 'WARN' }
  Add-Result $area 'overall result' $status "OVERALL_RESULT=$overall appcert exit $($r.code) ($report)"
  # WACK installs and removes the package itself; make sure nothing of it is left.
  foreach ($name in @('Nigafiy.LocalTest.Hub', 'Nigafiy.LocalTest.QuickSupport')) {
    foreach ($p in @(Get-AppxPackage -Name $name -ErrorAction SilentlyContinue)) { Stop-ProcessesUnder $p.InstallLocation; Remove-AppxPackage -Package $p.PackageFullName }
  }
}

# ---- main ------------------------------------------------------------------------------------
Write-Host "Nigafiy install test $Stamp, log folder $LogDir"
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  # Nothing was changed. This script never elevates itself and never starts a UAC prompt.
  Add-Result 'setup' 'elevated PowerShell' 'FAIL' 'not elevated: open PowerShell with "Run as administrator" and run this script again. Nothing was changed.'
  Stop-Transcript | Out-Null
  exit 1
}

$exitCode = 1
try {
  Add-Result 'setup' 'elevated PowerShell' 'PASS' "$($id.Name)"
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Result 'setup' 'Windows' 'INFO' "$($os.Caption) $($os.Version)"

  if (Get-State) { Invoke-Cleanup 'leftovers of an earlier run' }

  # The test certificate.
  if (-not (Test-Path -LiteralPath $CertPath)) { throw "test certificate file $CertPath is missing" }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CertPath
  if ($cert.HasPrivateKey) { throw "$CertPath holds a private key; give the public .cer only" }
  $thumb = $cert.Thumbprint
  $subject = $cert.Subject
  Add-Result 'setup' 'test certificate' 'INFO' "$subject $thumb, valid to $($cert.NotAfter.ToString('s'))"
  if (Test-Path "Cert:\LocalMachine\Root\$thumb") { Add-Result 'setup' 'certificate not in LocalMachine\Root' 'FAIL' 'it is in Root; this script never adds or removes Root certificates' }
  $target = "Cert:\LocalMachine\TrustedPeople\$thumb"
  if (Test-Path $target) {
    Add-Result 'setup' 'certificate in LocalMachine\TrustedPeople' 'INFO' 'already there before this run (not imported by this script); left as it is'
  } else {
    Set-StateValue 'certImported' $thumb
    Import-Certificate -FilePath $CertPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    [void](Test-Check 'setup' 'certificate imported into LocalMachine\TrustedPeople' (Test-Path $target) $thumb)
  }

  try { Test-Msi $thumb } catch { Add-Result 'MSI' 'unexpected error' 'FAIL' "$($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)" }
  try { Test-Msix 'desktop' $DesktopMsixPath 'Nigafiy.LocalTest.Hub' 'Nigafiy' 'app\Nigafiy.exe' $thumb $subject $true } catch { Add-Result 'MSIX desktop' 'unexpected error' 'FAIL' "$($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)" }
  try { Test-Msix 'quick-support' $SupportMsixPath 'Nigafiy.LocalTest.QuickSupport' 'NigafiyQuickSupport' 'nigafiy-support.exe' $thumb $subject $false } catch { Add-Result 'MSIX quick-support' 'unexpected error' 'FAIL' "$($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)" }
  if ($SkipWack) {
    Add-Result 'WACK' 'run' 'SKIP' '-SkipWack'
  } else {
    try { Invoke-Wack 'desktop' $DesktopMsixPath } catch { Add-Result 'WACK desktop' 'unexpected error' 'FAIL' $_.Exception.Message }
    try { Invoke-Wack 'quick-support' $SupportMsixPath } catch { Add-Result 'WACK quick-support' 'unexpected error' 'FAIL' $_.Exception.Message }
  }
  $exitCode = 0
} catch {
  Add-Result 'run' 'unexpected error' 'FAIL' "$($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)"
} finally {
  try { Invoke-Cleanup 'end of run' } catch { Add-Result 'cleanup' 'unexpected error' 'FAIL' $_.Exception.Message }
  $left = Get-State
  if ($left) { Add-Result 'cleanup' 'everything undone' 'FAIL' ("still pending: " + (($left.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ') + " (rerun the script to retry)") }
  else { Add-Result 'cleanup' 'everything undone' 'PASS' 'certificate, MSI, packages and registry back as before' }
  $fails = @($script:Results | Where-Object { $_.status -eq 'FAIL' })
  $passes = @($script:Results | Where-Object { $_.status -eq 'PASS' })
  $skips = @($script:Results | Where-Object { $_.status -eq 'SKIP' -or $_.status -eq 'WARN' })
  Write-Host ''
  Write-Host '================ SUMMARY ================'
  foreach ($a in @($script:Results | ForEach-Object { $_.area } | Select-Object -Unique)) {
    $rs = @($script:Results | Where-Object { $_.area -eq $a })
    $f = @($rs | Where-Object { $_.status -eq 'FAIL' }).Count
    $verdict = 'PASS'
    if ($f -gt 0) { $verdict = 'FAIL' } elseif (@($rs | Where-Object { $_.status -eq 'SKIP' -or $_.status -eq 'WARN' }).Count -gt 0) { $verdict = 'PASS (with skips/warnings)' }
    Write-Host ("{0,-22} {1}" -f $a, $verdict)
  }
  $overall = 'PASS'
  if ($fails.Count -gt 0 -or $exitCode -ne 0) { $overall = 'FAIL'; $exitCode = 1 }
  Write-Host ("OVERALL: {0}  ({1} pass, {2} fail, {3} skip/warn)" -f $overall, $passes.Count, $fails.Count, $skips.Count)
  foreach ($f in $fails) { Write-Host ("  FAIL {0}: {1} {2}" -f $f.area, $f.check, $f.detail) -ForegroundColor Red }
  Write-Host "Logs: $LogDir"
  Save-Results
  Stop-Transcript | Out-Null
}
exit $exitCode
