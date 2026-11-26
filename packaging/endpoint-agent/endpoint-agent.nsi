; Nigafiy Endpoint Agent installer (docs/operations/installers.md).
;
; Built by scripts/installers/build-agent-installer.mjs:
;   makensis /DVERSION=1.2.3 /DAGENT_EXE=<signed nigafiy-agent.exe> /DOUTFILE=<setup.exe> /DICON=<agent.ico> endpoint-agent.nsi
;
; It unpacks nigafiy-agent.exe into its temporary folder and runs the agent's own
;   nigafiy-agent.exe install -install-dir "%ProgramFiles%\Nigafiy\Endpoint Agent" -server <url>
;       [-token-file <path>] [-tls-pin <sha256>] [-ca-file <pem>] [-service-name <n>] [-log-level <l>] [-no-start]
; which enrolls with the one-time token (a token file the agent reads itself, or a typed token in the
; NIGAFIY_AGENT_ENROLLMENT_TOKEN environment variable, never on the agent's command line), copies
; itself into the install folder and registers the Windows service on that copy. When the service is
; already installed the same command upgrades it in place (stop, swap the exe keeping the previous
; one, start, check it came up, roll back otherwise); the stored credential is kept and nothing
; enrolls again. The service, the consent prompt and the session banner are the agent's; this
; installer adds nothing hidden.
;
; Silent (GPO startup script, Intune Win32 app, SCCM):
;   Nigafiy-Endpoint-Agent-Setup.exe /S /CONNECT="nigafiy://enroll?server=...&token=...&pin=..."
;   Nigafiy-Endpoint-Agent-Setup.exe /S /SERVER=https://nigafiy.example.com [/TOKEN=lde_... | /TOKENFILE=C:\path\token.txt]
;       [/TLSPIN=sha256:AB:CD:...] [/CAFILE=C:\path\ca.pem] [/SERVICENAME=NigafiyEndpointAgent] [/LOGLEVEL=info] [/NOSTART]
;   /CONNECT takes the connection code the dashboard shows (server, token and pin in one line; the
;   same code goes in the "Connection code" box of the setup window); the bundled agent splits it
;   (nigafiy-agent connect-code, the code passed in its environment).
;   Exit code 0 = installed; 1 = the agent's install step failed (see install.log); 2 = bad or missing parameters.
; Upgrade: run the newer installer with /S (no token needed: the agent upgrades its service in place,
; the stored credential is kept and the saved server, pin and service name are reused).
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
!include WordFunc.nsh

!ifndef EM_SETCUEBANNER
  !define EM_SETCUEBANNER 0x1501
!endif
!include x64.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef AGENT_EXE
  !error "define AGENT_EXE: the nigafiy-agent.exe to package"
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
; The welcome and finish pages' side picture (brand navy, the agent icon; 164x314).
!define MUI_WELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\wizard.bmp"

Var Connect
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

Var ConnectField
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
  !insertmacro GetOpt CONNECT
  StrCpy $Connect $0
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

  ; One connection code in place of /SERVER, /TOKEN and /TLSPIN.
  ${If} $Connect != ""
    Call DecodeConnect
    ${If} $R0 != ""
      IfSilent +2
        MessageBox MB_ICONEXCLAMATION "$R0"
      IfSilent 0 +3
        SetErrorLevel 2
        Quit
    ${EndIf}
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

  ; The agent reads the token file itself (-token-file: first line, trimmed, never logged); this
  ; only checks that it can be opened, so a wrong path still ends with exit code 2.
  ${If} $TokenFile != ""
    ClearErrors
    FileOpen $1 $TokenFile r
    ${If} ${Errors}
      IfSilent +2
        MessageBox MB_ICONSTOP "Cannot read the token file $TokenFile."
      SetErrorLevel 2
      Quit
    ${EndIf}
    FileClose $1
    StrCpy $Token ""
  ${EndIf}
  ${TrimNewLines} $Token $Token

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

; Splits $Connect (the dashboard's nigafiy://enroll?server=…&token=…&pin=… line) into $Server, $Pin
; and $Token with the bundled agent; $R0 is "" on success, else the reason. The code goes to the agent
; in its environment only, never on a command line.
Function DecodeConnect
  InitPluginsDir
  File "/oname=$PLUGINSDIR\nigafiy-agent.exe" "${AGENT_EXE}"
  System::Call 'Kernel32::SetEnvironmentVariable(t "NIGAFIY_AGENT_CONNECT", t "$Connect") i'
  nsExec::ExecToStack '"$PLUGINSDIR\nigafiy-agent.exe" connect-code'
  Pop $0
  Pop $1
  System::Call 'Kernel32::SetEnvironmentVariable(t "NIGAFIY_AGENT_CONNECT", i 0) i'
  ${If} $0 != "0"
    ${TrimNewLines} $1 $R0
    StrCpy $R0 "The connection code could not be read: $R0$\r$\n$\r$\nCopy it again from the dashboard (Fleet > Add device)."
    Return
  ${EndIf}
  ${WordFind} $1 "$\n" "+1" $Server
  ${WordFind} $1 "$\n" "+2" $Pin
  ${WordFind} $1 "$\n" "+3" $Token
  ${TrimNewLines} $Server $Server
  ${TrimNewLines} $Pin $Pin
  ${TrimNewLines} $Token $Token
  ${If} $Pin == "-"
    StrCpy $Pin ""
  ${EndIf}
  StrCpy $TokenFile ""
  StrCpy $R0 ""
FunctionEnd

Function EnrollPage
  !insertmacro MUI_HEADER_TEXT "Connect to your Nigafiy server" "Paste the connection code from the dashboard, or enter the details yourself."
  nsDialogs::Create 1018
  Pop $0

  ; The one-line way: everything in a single code.
  ${NSD_CreateLabel} 0 0 100% 10u "Connection code (Fleet > Add device in the dashboard):"
  Pop $0
  ${NSD_CreateText} 0 11u 100% 13u "$Connect"
  Pop $ConnectField
  ${NSD_OnChange} $ConnectField ConnectChanged

  ; The separate way.
  ${NSD_CreateGroupBox} 0 30u 100% 76u "Or enter the details yourself"
  Pop $0
  ${NSD_CreateLabel} 8u 44u 27% 10u "Server address:"
  Pop $0
  ${NSD_CreateText} 30% 42u 67% 13u "$Server"
  Pop $ServerField
  SendMessage $ServerField ${EM_SETCUEBANNER} 0 "STR:https://"
  ${NSD_CreateLabel} 8u 62u 27% 10u "Enrollment token:"
  Pop $0
  ${NSD_CreatePassword} 30% 60u 67% 13u "$Token"
  Pop $TokenField
  ${NSD_CreateLabel} 8u 80u 27% 10u "Certificate pin:"
  Pop $0
  ${NSD_CreateText} 30% 78u 67% 13u "$Pin"
  Pop $PinField
  SendMessage $PinField ${EM_SETCUEBANNER} 0 "STR:optional (SHA-256)"
  ${NSD_CreateLabel} 30% 93u 67% 10u "Upgrading? Leave the token empty."
  Pop $0
  SetCtlColors $0 808080 transparent

  ${NSD_CreateLabel} 0 112u 100% 24u "Remote support asks the signed-in user for consent where your policy says so and always shows a banner on this computer. The agent runs as the Windows service ${DEFAULT_SERVICE}."
  Pop $0
  SetCtlColors $0 808080 transparent

  Push $ConnectField
  Call ConnectChanged
  nsDialogs::Show
FunctionEnd

; A code in the top box replaces the separate fields: they are greyed out while it is there.
Function ConnectChanged
  Pop $0
  ${NSD_GetText} $ConnectField $0
  ${If} $0 == ""
    EnableWindow $ServerField 1
    EnableWindow $PinField 1
    ${If} $TokenFile == ""
      EnableWindow $TokenField 1
    ${Else}
      ; A /TOKENFILE given on the command line is used; the field stays empty.
      EnableWindow $TokenField 0
    ${EndIf}
  ${Else}
    EnableWindow $ServerField 0
    EnableWindow $TokenField 0
    EnableWindow $PinField 0
  ${EndIf}
FunctionEnd

Function EnrollPageLeave
  ${NSD_GetText} $ConnectField $Connect
  ${If} $Connect != ""
    Call DecodeConnect
    ${If} $R0 != ""
      MessageBox MB_ICONEXCLAMATION "$R0"
      Abort
    ${EndIf}
  ${Else}
    ${NSD_GetText} $ServerField $Server
    ${If} $TokenFile == ""
      ${NSD_GetText} $TokenField $Token
    ${EndIf}
    ${NSD_GetText} $PinField $Pin
  ${EndIf}
  StrCpy $1 $Server 8
  ${If} $1 != "https://"
    MessageBox MB_ICONEXCLAMATION "Enter the server address starting with https:// (or paste the connection code)."
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  SetRegView 64
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  InitPluginsDir

  ; An installed nigafiy-agent service is upgraded in place by the agent's install step below.
  ; An agent installed before the rename is endpoint-agent.exe (docs/architecture/naming.md): its
  ; service (same name) is removed with that binary first (its credential in %ProgramData% stays and
  ; is used again), and the old file is deleted once the new one is installed.
  ${IfNot} ${FileExists} "$INSTDIR\nigafiy-agent.exe"
  ${AndIf} ${FileExists} "$INSTDIR\endpoint-agent.exe"
    DetailPrint "Removing the existing $ServiceName service (agent from before the rename)"
    nsExec::ExecToLog '"$INSTDIR\endpoint-agent.exe" uninstall -service-name "$ServiceName"'
    Pop $0
  ${EndIf}

  ; The agent copies itself into $INSTDIR (or swaps the installed copy on an upgrade).
  File "/oname=$PLUGINSDIR\nigafiy-agent.exe" "${AGENT_EXE}"

  StrCpy $2 'install -install-dir "$INSTDIR" -server "$Server" -service-name "$ServiceName" -log-level "$LogLevel"'
  ${If} $TokenFile != ""
    StrCpy $2 '$2 -token-file "$TokenFile"'
  ${EndIf}
  ${If} $Pin != ""
    StrCpy $2 '$2 -tls-pin "$Pin"'
  ${EndIf}
  ${If} $CAFile != ""
    StrCpy $2 '$2 -ca-file "$CAFile"'
  ${EndIf}
  ${If} $NoStart == "1"
    StrCpy $2 '$2 -no-start'
  ${EndIf}

  ; A typed token goes to the agent in its environment only, then is cleared from this process.
  System::Call 'Kernel32::SetEnvironmentVariable(t "NIGAFIY_AGENT_ENROLLMENT_TOKEN", t "$Token") i'
  ${If} $Upgrade == "1"
    DetailPrint "Upgrading the $ServiceName service in place"
  ${Else}
    DetailPrint "Enrolling and installing the service"
  ${EndIf}
  nsExec::ExecToStack '"$PLUGINSDIR\nigafiy-agent.exe" $2'
  Pop $0
  Pop $1
  System::Call 'Kernel32::SetEnvironmentVariable(t "NIGAFIY_AGENT_ENROLLMENT_TOKEN", i 0) i'
  StrCpy $Token ""

  FileOpen $3 "$INSTDIR\install.log" w
  FileWrite $3 "nigafiy-agent $2$\r$\nexit code $0$\r$\n$1$\r$\n"
  FileClose $3

  ${If} $0 != "0"
    DetailPrint "The agent's install step failed (exit code $0): $1"
    IfSilent +2
      MessageBox MB_ICONSTOP "The agent could not be installed:$\r$\n$\r$\n$1$\r$\nDetails: $INSTDIR\install.log"
    ; A failed first install leaves no agent behind (the agent removes the copy it made); a failed
    ; upgrade has already put the previous version back and started it again.
    SetErrorLevel 1
    Abort
  ${EndIf}
  DetailPrint "$1"
  Delete "$INSTDIR\endpoint-agent.exe"

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
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\nigafiy-agent.exe"
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
  nsExec::ExecToLog '"$INSTDIR\nigafiy-agent.exe" uninstall -service-name "$ServiceName"'
  Pop $0
  Delete "$INSTDIR\nigafiy-agent.exe"
  Delete "$INSTDIR\nigafiy-agent.previous.exe"
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
