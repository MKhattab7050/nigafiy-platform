; Nigafiy Endpoint Agent installer (docs/operations/installers.md).
;
; Built by scripts/installers/build-agent-installer.mjs:
;   makensis /DVERSION=1.2.3 /DAGENT_EXE=<signed endpoint-agent.exe> /DOUTFILE=<setup.exe> /DICON=<agent.ico> endpoint-agent.nsi
;
; It copies endpoint-agent.exe to "%ProgramFiles%\Nigafiy\Endpoint Agent" and runs the agent's own
;   endpoint-agent.exe install -server <url> [-tls-pin <sha256>] [-ca-file <pem>] [-service-name <n>] [-log-level <l>] [-no-start]
; which enrolls with the one-time token (passed in the LAN_ENDPOINT_ENROLLMENT_TOKEN environment
; variable, never on the agent's command line) and registers the Windows service. The service, the
; consent prompt and the session banner are the agent's; this installer adds nothing hidden.
;
; Silent (GPO startup script, Intune Win32 app, SCCM):
;   Nigafiy-Endpoint-Agent-Setup.exe /S /SERVER=https://nigafiy.example.com [/TOKEN=lde_... | /TOKENFILE=C:\path\token.txt]
;       [/TLSPIN=sha256:AB:CD:...] [/CAFILE=C:\path\ca.pem] [/SERVICENAME=NigafiyEndpointAgent] [/LOGLEVEL=info] [/NOSTART]
;   Exit code 0 = installed; 1 = the agent's install step failed (see install.log); 2 = bad or missing parameters.
; Upgrade: run the newer installer with /S (no token needed: the stored credential is kept and the
; saved server, pin and service name are reused).
; Uninstall: "%ProgramFiles%\Nigafiy\Endpoint Agent\uninstall.exe" /S [/PURGE]  (/PURGE also deletes
; the endpoint credential in %ProgramData%\Nigafiy\EndpointAgent).

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel admin

!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include TextFunc.nsh
!include x64.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef AGENT_EXE
  !error "define AGENT_EXE: the endpoint-agent.exe to package"
!endif
!ifndef OUTFILE
  !define OUTFILE "Nigafiy-Endpoint-Agent-Setup-${VERSION}.exe"
!endif

!define PRODUCT "Nigafiy Endpoint Agent"
!define SETTINGS_KEY "Software\Nigafiy\EndpointAgent"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NigafiyEndpointAgent"
!define DEFAULT_SERVICE "NigafiyEndpointAgent"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Nigafiy\Endpoint Agent"
BrandingText "${PRODUCT} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "CompanyName" "Nigafiy"
VIAddVersionKey "FileDescription" "${PRODUCT} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Nigafiy"

!ifdef ICON
  !define MUI_ICON "${ICON}"
  !define MUI_UNICON "${ICON}"
!endif
!define MUI_ABORTWARNING

Var Server
Var Token
Var TokenFile
Var Pin
Var CAFile
Var ServiceName
Var LogLevel
Var NoStart
Var Upgrade
Var Purge

Var ServerField
Var TokenField
Var PinField

!insertmacro MUI_PAGE_WELCOME
Page custom EnrollPage EnrollPageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Arabic"

; Reads /NAME=value from the command line into $0 ("" when absent).
!macro GetOpt NAME
  ClearErrors
  ${GetOptions} $R9 "/${NAME}=" $0
  ${If} ${Errors}
    StrCpy $0 ""
  ${EndIf}
!macroend

Function StripPinPrefix
  ; Accept "sha256:AB:CD..." as well as the bare fingerprint the agent expects.
  StrCpy $1 $Pin 7
  ${If} $1 == "sha256:"
  ${OrIf} $1 == "SHA256:"
    StrCpy $Pin $Pin "" 7
  ${EndIf}
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    IfSilent +2
      MessageBox MB_ICONSTOP "${PRODUCT} needs 64-bit Windows."
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext all

  ${GetParameters} $R9
  !insertmacro GetOpt SERVER
  StrCpy $Server $0
  !insertmacro GetOpt TOKEN
  StrCpy $Token $0
  !insertmacro GetOpt TOKENFILE
  StrCpy $TokenFile $0
  !insertmacro GetOpt TLSPIN
  StrCpy $Pin $0
  !insertmacro GetOpt CAFILE
  StrCpy $CAFile $0
  !insertmacro GetOpt SERVICENAME
  StrCpy $ServiceName $0
  !insertmacro GetOpt LOGLEVEL
  StrCpy $LogLevel $0
  ClearErrors
  ${GetOptions} $R9 "/NOSTART" $0
  ${If} ${Errors}
    StrCpy $NoStart ""
  ${Else}
    StrCpy $NoStart "1"
  ${EndIf}

  ; An earlier installation: reuse its settings (never a token: none is stored).
  ReadRegStr $0 HKLM "${SETTINGS_KEY}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
    StrCpy $Upgrade "1"
  ${EndIf}
  ${If} $Server == ""
    ReadRegStr $Server HKLM "${SETTINGS_KEY}" "Server"
  ${EndIf}
  ${If} $Pin == ""
    ReadRegStr $Pin HKLM "${SETTINGS_KEY}" "TlsPin"
  ${EndIf}
  ${If} $CAFile == ""
    ReadRegStr $CAFile HKLM "${SETTINGS_KEY}" "CAFile"
  ${EndIf}
  ${If} $ServiceName == ""
    ReadRegStr $ServiceName HKLM "${SETTINGS_KEY}" "ServiceName"
  ${EndIf}
  ${If} $ServiceName == ""
    StrCpy $ServiceName "${DEFAULT_SERVICE}"
  ${EndIf}
  ${If} $LogLevel == ""
    StrCpy $LogLevel "info"
  ${EndIf}

  ${If} $TokenFile != ""
    ClearErrors
    FileOpen $1 $TokenFile r
    ${If} ${Errors}
      IfSilent +2
        MessageBox MB_ICONSTOP "Cannot read the token file $TokenFile."
      SetErrorLevel 2
      Quit
    ${EndIf}
    FileRead $1 $Token
    FileClose $1
  ${EndIf}
  ; Trim a trailing newline from a token file.
  ${TrimNewLines} $Token $Token
  Call StripPinPrefix

  IfSilent 0 done
    ${If} $Server == ""
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $1 $Server 8
    ${If} $1 != "https://"
      SetErrorLevel 2
      Quit
    ${EndIf}
  done:
FunctionEnd

Function EnrollPage
  !insertmacro MUI_HEADER_TEXT "Connect to your Nigafiy server" "The agent reports this computer's inventory and health to your organization's server."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "Server address (https://):"
  Pop $0
  ${NSD_CreateText} 0 13u 100% 12u "$Server"
  Pop $ServerField
  ${NSD_CreateLabel} 0 32u 100% 12u "One-time enrollment token (leave empty when upgrading an enrolled computer):"
  Pop $0
  ${NSD_CreatePassword} 0 45u 100% 12u "$Token"
  Pop $TokenField
  ${NSD_CreateLabel} 0 64u 100% 12u "Server certificate pin, SHA-256 (optional; for the server's own local CA):"
  Pop $0
  ${NSD_CreateText} 0 77u 100% 12u "$Pin"
  Pop $PinField
  ${NSD_CreateLabel} 0 98u 100% 36u "Remote support sessions ask the signed-in user for consent where your policy says so and always show a visible banner on this computer. The agent runs as the Windows service ${DEFAULT_SERVICE}."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function EnrollPageLeave
  ${NSD_GetText} $ServerField $Server
  ${NSD_GetText} $TokenField $Token
  ${NSD_GetText} $PinField $Pin
  Call StripPinPrefix
  StrCpy $1 $Server 8
  ${If} $1 != "https://"
    MessageBox MB_ICONEXCLAMATION "Enter the server address starting with https://"
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  SetRegView 64
  SetShellVarContext all
  SetOutPath "$INSTDIR"

  ; Upgrade: the agent's install step refuses an existing service, so the old one is removed first
  ; (its credential in %ProgramData% stays and is used again).
  ${If} ${FileExists} "$INSTDIR\endpoint-agent.exe"
    DetailPrint "Removing the existing $ServiceName service"
    nsExec::ExecToLog '"$INSTDIR\endpoint-agent.exe" uninstall -service-name "$ServiceName"'
    Pop $0
  ${EndIf}

  File "/oname=endpoint-agent.exe" "${AGENT_EXE}"

  StrCpy $2 'install -server "$Server" -service-name "$ServiceName" -log-level "$LogLevel"'
  ${If} $Pin != ""
    StrCpy $2 '$2 -tls-pin "$Pin"'
  ${EndIf}
  ${If} $CAFile != ""
    StrCpy $2 '$2 -ca-file "$CAFile"'
  ${EndIf}
  ${If} $NoStart == "1"
    StrCpy $2 '$2 -no-start'
  ${EndIf}

  ; The token goes to the agent in its environment only, then is cleared from this process.
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAN_ENDPOINT_ENROLLMENT_TOKEN", t "$Token") i'
  DetailPrint "Enrolling and installing the service"
  nsExec::ExecToStack '"$INSTDIR\endpoint-agent.exe" $2'
  Pop $0
  Pop $1
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAN_ENDPOINT_ENROLLMENT_TOKEN", i 0) i'
  StrCpy $Token ""

  FileOpen $3 "$INSTDIR\install.log" w
  FileWrite $3 "endpoint-agent $2$\r$\nexit code $0$\r$\n$1$\r$\n"
  FileClose $3

  ${If} $0 != "0"
    DetailPrint "The agent's install step failed (exit code $0): $1"
    IfSilent +2
      MessageBox MB_ICONSTOP "The agent could not be installed:$\r$\n$\r$\n$1$\r$\nDetails: $INSTDIR\install.log"
    SetErrorLevel 1
    ${If} $Upgrade != "1"
      Delete "$INSTDIR\endpoint-agent.exe"
    ${EndIf}
    Abort
  ${EndIf}
  DetailPrint "$1"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${SETTINGS_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${SETTINGS_KEY}" "Server" "$Server"
  WriteRegStr HKLM "${SETTINGS_KEY}" "TlsPin" "$Pin"
  WriteRegStr HKLM "${SETTINGS_KEY}" "CAFile" "$CAFile"
  WriteRegStr HKLM "${SETTINGS_KEY}" "ServiceName" "$ServiceName"
  WriteRegStr HKLM "${SETTINGS_KEY}" "Version" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Nigafiy"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\endpoint-agent.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  SetErrorLevel 0
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext all
  ReadRegStr $ServiceName HKLM "${SETTINGS_KEY}" "ServiceName"
  ${If} $ServiceName == ""
    StrCpy $ServiceName "${DEFAULT_SERVICE}"
  ${EndIf}
  ${GetParameters} $R9
  ClearErrors
  ${GetOptions} $R9 "/PURGE" $0
  ${If} ${Errors}
    StrCpy $Purge ""
  ${Else}
    StrCpy $Purge "1"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all
  nsExec::ExecToLog '"$INSTDIR\endpoint-agent.exe" uninstall -service-name "$ServiceName"'
  Pop $0
  Delete "$INSTDIR\endpoint-agent.exe"
  Delete "$INSTDIR\install.log"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  RMDir "$PROGRAMFILES64\Nigafiy"
  ${If} $Purge == "1"
    ; $APPDATA is %ProgramData% under SetShellVarContext all. The credential: without it the computer must be enrolled again with a new token.
    RMDir /r "$APPDATA\Nigafiy\EndpointAgent"
    RMDir "$APPDATA\Nigafiy"
  ${EndIf}
  DeleteRegKey HKLM "${SETTINGS_KEY}"
  DeleteRegKey /ifempty HKLM "Software\Nigafiy"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
SectionEnd
