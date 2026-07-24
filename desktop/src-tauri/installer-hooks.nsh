!macro KEYDEX_CLOSE_RUNNING_PROCESSES
  DetailPrint "Closing running Keydex processes..."
  ; Do not use /T here. During an in-app update the NSIS installer is a
  ; descendant of keydex-desktop.exe and must survive while the old supervised
  ; process tree is closed. The supervisor Job Object still owns and cleans up
  ; the GUI, browser, terminal, and sidecar processes.
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C ""$SYSDIR\taskkill.exe" /IM keydex-desktop.exe /F 2>NUL || exit /B 0"`
  Pop $0
  nsExec::ExecToLog `"$SYSDIR\cmd.exe" /D /C ""$SYSDIR\taskkill.exe" /IM agent-server.exe /T /F 2>NUL || exit /B 0"`
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KEYDEX_CLOSE_RUNNING_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KEYDEX_CLOSE_RUNNING_PROCESSES
!macroend
