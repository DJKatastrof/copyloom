; Close only the executable being replaced; preserve Tauri's registers.
!include "Win\RestartManager.nsh"
!macro CopyloomCloseRunningApp executablePath
  Push $R0
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "${executablePath}"
    ${If} $0 = 0
      System::Call 'RSTRTMGR::RmGetList(i R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
      ${If} $0 = 234
        DetailPrint "Closing Copyloom before continuing..."
        ; Ask Windows to close it; terminate an unresponsive app if necessary.
        System::Call 'RSTRTMGR::RmShutdown(i R0, i ${RmForceShutdown}, p 0) i .r0'
      ${EndIf}
    ${EndIf}
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R0
!macroend
; A Copyloom started from somewhere else, such as dist-desktop\Copyloom-0.1.x.exe, is not the file at
; $INSTDIR, so the Restart Manager does not see it. It would keep running, and the new version would
; hand over to it. End every other Copyloom, but never this installer.
!macro CopyloomCloseOtherCopies
  Push $0
  Push $1
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /FI "IMAGENAME eq copyloom*" /FI "PID ne $0"'
  Pop $1 ; taskkill's exit code; nothing to end is not an error.
  Pop $1
  Pop $0
!macroend
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CopyloomCloseRunningApp "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro CopyloomCloseOtherCopies
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CopyloomCloseRunningApp "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro CopyloomCloseOtherCopies
!macroend
; Preserve the user's enabled/disabled choice while replacing an obsolete path.
!macro CopyloomRepairAutostart registryKey executablePath
  Push $0
  ClearErrors
  ReadRegStr $0 HKCU "${registryKey}" "Copyloom"
  ${IfNot} ${Errors}
  ${AndIf} $0 != ""
    WriteRegStr HKCU "${registryKey}" "Copyloom" '$\"${executablePath}$\" --autostart'
  ${EndIf}
  Pop $0
!macroend
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro CopyloomRepairAutostart "Software\Microsoft\Windows\CurrentVersion\Run" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend
; Uninstalling (not updating) gives Win+V back to Windows if Copyloom took it.
!include "WordFunc.nsh"
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Push $0
    Push $1
    ClearErrors
    ReadRegStr $0 HKCU "Software\Copyloom" "ReleasedWinV"
    ${If} $0 == "1"
      ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys"
      ${WordReplace} "$1" "V" "" "+" $1
      ${If} $1 == ""
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys"
      ${Else}
        WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys" "$1"
      ${EndIf}
      DeleteRegValue HKCU "Software\Copyloom" "ReleasedWinV"
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
!macroend
