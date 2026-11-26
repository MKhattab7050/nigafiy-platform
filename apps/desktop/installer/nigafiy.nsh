; Nigafiy additions to electron-builder's NSIS installer (docs/operations/installers.md).
; Included through build.nsis.include in apps/desktop/package.json.
;
; 1. Choose programs: a page after the folder page with Radar, Watch, Guard, Fleet, Mind and Toolbox
;    (Hub is always installed). The choice is stored as REG_SZ Programs under
;    <HKCU or HKLM>\Software\Nigafiy\Hub ("all", or a comma list such as "hub,radar,watch"); the
;    engine passes it to the stack as NIGAFIY_PROGRAMS. Silent: /PROGRAMS=radar,watch (otherwise the
;    earlier choice is kept, else every program). Apps & features "Modify" opens the app's own
;    program chooser (Nigafiy.exe --choose-programs).
; 2. An earlier LAN Detective installation in another folder (the other install scope, or
;    C:\Program Files\LAN Detective / %LOCALAPPDATA%\Programs\LAN Detective without a registration
;    in this scope): interactive installs offer to remove that old copy with its own uninstaller.
;    The user's data (%APPDATA%\LAN Detective) is never touched here; the app offers to move it on
;    its first run. Silent installs never remove anything. An earlier install in the same scope is
;    upgraded in place by electron-builder itself (the NSIS GUID is pinned).
; 3. Uninstall (not an update) also removes the nigafiy:// handler when it opens this installation
;    and the copy of the setup electron-builder keeps in %LOCALAPPDATA%\@nigafiydesktop-updater.

!include LogicLib.nsh
!include FileFunc.nsh
!include WordFunc.nsh
!include nsDialogs.nsh

!define NG_PROGRAMS_KEY "Software\Nigafiy\Hub"
!define NG_LEGACY_UNINSTALLER "Uninstall LAN Detective.exe"

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    LangString ngProgramsTitle ${LANG_ENGLISH} "Choose programs"
    LangString ngProgramsSubtitle ${LANG_ENGLISH} "Pick the Nigafiy programs this computer offers. You can change this later with Modify in Apps & features."
    LangString ngProgramsHub ${LANG_ENGLISH} "Nigafiy Hub (home, sign-in, settings and the engine) is always installed. Programs you leave out keep collecting their data; only their screens are not offered."
    LangString ngRadar ${LANG_ENGLISH} "Nigafiy Radar: see every device on the network"
    LangString ngWatch ${LANG_ENGLISH} "Nigafiy Watch: monitor, and understand what went wrong"
    LangString ngGuard ${LANG_ENGLISH} "Nigafiy Guard: protect and control the network"
    LangString ngFleet ${LANG_ENGLISH} "Nigafiy Fleet: manage and support company computers"
    LangString ngMind ${LANG_ENGLISH} "Nigafiy Mind: knowledge, playbooks and automation"
    LangString ngToolbox ${LANG_ENGLISH} "Nigafiy Toolbox: quick network tools"
    LangString ngBadPrograms ${LANG_ENGLISH} "/PROGRAMS must be all or a comma list of radar, watch, guard, fleet, mind, toolbox (hub is always installed): $NgPrograms"
    LangString ngLegacyFound ${LANG_ENGLISH} "An earlier LAN Detective installation is still in:$\r$\n$R5$\r$\n$\r$\nRemove that old copy now with its own uninstaller? Your data is kept; Nigafiy offers to move it when it starts."
    LangString ngLegacyFailed ${LANG_ENGLISH} "The old copy in $R5 was not removed (exit code $R6). You can remove it later from Apps & features."
    !ifdef LANG_ARABIC
      LangString ngProgramsTitle ${LANG_ARABIC} "اختر البرامج"
      LangString ngProgramsSubtitle ${LANG_ARABIC} "اختر برامج Nigafiy التي يوفّرها هذا الكمبيوتر. يمكنك تغيير ذلك لاحقًا عبر «تعديل» في التطبيقات والميزات."
      LangString ngProgramsHub ${LANG_ARABIC} "يُثبَّت Nigafiy Hub (الرئيسية وتسجيل الدخول والإعدادات والمحرك) دائمًا. البرامج التي تستبعدها تستمر في جمع بياناتها؛ فقط شاشاتها غير معروضة."
      LangString ngRadar ${LANG_ARABIC} "Nigafiy Radar: رؤية كل جهاز على الشبكة"
      LangString ngWatch ${LANG_ARABIC} "Nigafiy Watch: المراقبة وفهم سبب المشكلة"
      LangString ngGuard ${LANG_ARABIC} "Nigafiy Guard: حماية الشبكة والتحكم بها"
      LangString ngFleet ${LANG_ARABIC} "Nigafiy Fleet: إدارة أجهزة الشركة ودعمها"
      LangString ngMind ${LANG_ARABIC} "Nigafiy Mind: المعرفة وخطط العمل والأتمتة"
      LangString ngToolbox ${LANG_ARABIC} "Nigafiy Toolbox: أدوات شبكة سريعة"
      LangString ngBadPrograms ${LANG_ARABIC} "يجب أن تكون /PROGRAMS إما all أو قائمة مفصولة بفواصل من radar وwatch وguard وfleet وmind وtoolbox (يُثبَّت hub دائمًا): $NgPrograms"
      LangString ngLegacyFound ${LANG_ARABIC} "ما زال تثبيت سابق لـ LAN Detective موجودًا في:$\r$\n$R5$\r$\n$\r$\nهل تريد إزالة تلك النسخة القديمة الآن بأداة إزالتها؟ تبقى بياناتك؛ يعرض Nigafiy نقلها عند تشغيله."
      LangString ngLegacyFailed ${LANG_ARABIC} "لم تتم إزالة النسخة القديمة في $R5 (رمز الخروج $R6). يمكنك إزالتها لاحقًا من التطبيقات والميزات."
    !endif
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  Var NgPrograms
  Var NgProgramsSet
  Var NgCbRadar
  Var NgCbWatch
  Var NgCbGuard
  Var NgCbFleet
  Var NgCbMind
  Var NgCbToolbox

  ; $R3 = "1" when ",$NgPrograms," contains ",$R2," (or the choice is all), else "0".
  Function NgHas
    Push $R0
    Push $R1
    Push $R4
    StrCpy $R3 "0"
    ${If} $NgPrograms == "all"
      StrCpy $R3 "1"
    ${Else}
      StrCpy $R0 ",$NgPrograms,"
      StrCpy $R1 ",$R2,"
      StrLen $R4 $R1
      ${Do}
        StrCpy $9 $R0 $R4
        ${If} $9 == $R1
          StrCpy $R3 "1"
          ${Break}
        ${EndIf}
        StrCpy $R0 $R0 "" 1
      ${LoopUntil} $R0 == ""
    ${EndIf}
    Pop $R4
    Pop $R1
    Pop $R0
  FunctionEnd

  ; $R3 = "1" when $NgPrograms is all or a comma list of known programs, else "0".
  Function NgValidPrograms
    Push $R0
    Push $R1
    StrCpy $R3 "1"
    ${If} $NgPrograms != "all"
      StrCpy $R0 1
      ${Do}
        ClearErrors
        ${WordFind} "$NgPrograms" "," "E+$R0" $R1
        ${If} ${Errors}
          ${Break}
        ${EndIf}
        ${If} $R1 != "hub"
        ${AndIf} $R1 != "radar"
        ${AndIf} $R1 != "watch"
        ${AndIf} $R1 != "guard"
        ${AndIf} $R1 != "fleet"
        ${AndIf} $R1 != "mind"
        ${AndIf} $R1 != "toolbox"
          StrCpy $R3 "0"
          ${Break}
        ${EndIf}
        IntOp $R0 $R0 + 1
      ${Loop}
    ${EndIf}
    Pop $R1
    Pop $R0
  FunctionEnd

!endif

!macro NgCheckbox VAR ID TOP TEXT
  ${NSD_CreateCheckbox} 0 ${TOP} 100% 12u "${TEXT}"
  Pop ${VAR}
  StrCpy $R2 "${ID}"
  Call NgHas
  ${If} $R3 == "1"
    ${NSD_Check} ${VAR}
  ${EndIf}
!macroend
!macro NgAppendIfChecked VAR ID
  ${NSD_GetState} ${VAR} $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $1 "$1,${ID}"
    IntOp $2 $2 + 1
  ${EndIf}
!macroend

!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/PROGRAMS=" $R1
  ${IfNot} ${Errors}
    StrCpy $NgPrograms $R1
    Call NgValidPrograms
    ${If} $R3 != "1"
      MessageBox MB_ICONSTOP "$(ngBadPrograms)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $NgProgramsSet "1"
  ${EndIf}
!macroend

; The page and the functions that need electron-builder's own definitions (MUI2, $installMode,
; INSTALL_REGISTRY_KEY, isUpdated): this macro is expanded inside assistedInstaller.nsh, after them.
!macro customPageAfterChangeDir
  Page custom NgProgramsPage NgProgramsLeave


  Function NgProgramsPage
    ; The in-app updater (--updated) keeps the earlier choice; nothing to ask.
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $NgProgramsSet != "1"
      ReadRegStr $NgPrograms SHELL_CONTEXT "${NG_PROGRAMS_KEY}" "Programs"
    ${EndIf}
    ${If} $NgPrograms == ""
      StrCpy $NgPrograms "all"
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "$(ngProgramsTitle)" "$(ngProgramsSubtitle)"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 28u "$(ngProgramsHub)"
    Pop $0
    !insertmacro NgCheckbox $NgCbRadar "radar" 32u "$(ngRadar)"
    !insertmacro NgCheckbox $NgCbWatch "watch" 46u "$(ngWatch)"
    !insertmacro NgCheckbox $NgCbGuard "guard" 60u "$(ngGuard)"
    !insertmacro NgCheckbox $NgCbFleet "fleet" 74u "$(ngFleet)"
    !insertmacro NgCheckbox $NgCbMind "mind" 88u "$(ngMind)"
    !insertmacro NgCheckbox $NgCbToolbox "toolbox" 102u "$(ngToolbox)"
    nsDialogs::Show
  FunctionEnd


  Function NgProgramsLeave
    StrCpy $1 "hub"
    StrCpy $2 0
    !insertmacro NgAppendIfChecked $NgCbRadar "radar"
    !insertmacro NgAppendIfChecked $NgCbWatch "watch"
    !insertmacro NgAppendIfChecked $NgCbGuard "guard"
    !insertmacro NgAppendIfChecked $NgCbFleet "fleet"
    !insertmacro NgAppendIfChecked $NgCbMind "mind"
    !insertmacro NgAppendIfChecked $NgCbToolbox "toolbox"
    ${If} $2 == 6
      StrCpy $NgPrograms "all"
    ${Else}
      StrCpy $NgPrograms $1
    ${EndIf}
    StrCpy $NgProgramsSet "1"
  FunctionEnd

  ; Offers to remove one earlier LAN Detective copy in $R5 (its uninstaller, /allusers when $R7 is "all").
  Function NgOfferLegacyDir
    ${If} $R5 == ""
    ${OrIf} $R5 == $INSTDIR
      Return
    ${EndIf}
    ${IfNot} ${FileExists} "$R5\${NG_LEGACY_UNINSTALLER}"
      Return
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONQUESTION "$(ngLegacyFound)" /SD IDNO IDYES remove
    Return
    remove:
    ${If} $R7 == "all"
      ExecWait '"$R5\${NG_LEGACY_UNINSTALLER}" /S /allusers' $R6
    ${Else}
      ExecWait '"$R5\${NG_LEGACY_UNINSTALLER}" /S /currentuser' $R6
    ${EndIf}
    ${If} $R6 != 0
      MessageBox MB_ICONEXCLAMATION "$(ngLegacyFailed)" /SD IDOK
    ${EndIf}
  FunctionEnd

  ; Earlier LAN Detective copies outside this install's folder. Interactive only.
  Function NgOfferLegacyRemoval
    ${If} ${Silent}
      Return
    ${EndIf}
    ; The registration of the other install scope (same pinned GUID).
    ${If} $installMode == "all"
      ReadRegStr $R5 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      StrCpy $R7 "user"
    ${Else}
      ReadRegStr $R5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      StrCpy $R7 "all"
    ${EndIf}
    Call NgOfferLegacyDir
    ; The default folders of the old product name, when nothing registers them.
    ReadEnvStr $R8 "LOCALAPPDATA"
    StrCpy $R5 "$R8\Programs\LAN Detective"
    StrCpy $R7 "user"
    ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R9 != $R5
      Call NgOfferLegacyDir
    ${EndIf}
    StrCpy $R5 "$PROGRAMFILES64\LAN Detective"
    StrCpy $R7 "all"
    ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R9 != $R5
      Call NgOfferLegacyDir
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  ; Silent installs and in-app updates keep the earlier choice unless /PROGRAMS= is given.
  ${If} $NgProgramsSet != "1"
    ReadRegStr $NgPrograms SHELL_CONTEXT "${NG_PROGRAMS_KEY}" "Programs"
  ${EndIf}
  ${If} $NgPrograms == ""
    StrCpy $NgPrograms "all"
  ${EndIf}
  WriteRegStr SHELL_CONTEXT "${NG_PROGRAMS_KEY}" "Programs" "$NgPrograms"
  ; Apps & features "Modify": the app's own program chooser.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "ModifyPath" '"$appExe" --choose-programs'
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "NoModify" 0
  Call NgOfferLegacyRemoval
!macroend

!macro customUnInstall
  ; An update (--updated) keeps the choice for the new version.
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "${NG_PROGRAMS_KEY}" "Programs"
    DeleteRegKey /ifempty SHELL_CONTEXT "${NG_PROGRAMS_KEY}"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Nigafiy"
    Push $R0
    Push $R1
    Push $R2
    ; The nigafiy:// link handler the app registers for the person who ran it (HKCU), only when it
    ; still opens this installation (another install's registration is left alone).
    ReadRegStr $R0 HKCU "Software\Classes\nigafiy\shell\open\command" ""
    StrLen $R1 '"$INSTDIR\'
    StrCpy $R2 $R0 $R1
    ${If} $R2 == '"$INSTDIR\'
      DeleteRegKey HKCU "Software\Classes\nigafiy"
    ${EndIf}
    ; "Start with Windows" (the app writes it under its AppUserModelId), again only when it starts this installation.
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.nigafiy.hub"
    StrCpy $R2 $R0 $R1
    ${If} $R2 == '"$INSTDIR\'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.nigafiy.hub"
    ${EndIf}
    ; electron-builder keeps a copy of the setup (about 160 MB) for electron-updater, which Nigafiy
    ; does not use (the engine downloads and checks updates itself, docs/operations/updates.md).
    !ifdef APP_INSTALLER_STORE_FILE
      ${If} $installMode == "all"
        SetShellVarContext current
      ${EndIf}
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
      RMDir "$R0"
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
    !endif
    Pop $R2
    Pop $R1
    Pop $R0
  ${endIf}
!macroend
