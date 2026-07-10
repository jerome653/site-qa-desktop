; Custom NSIS include for SGEN Site QA — makes auto-updates reliable despite the windowless engine child.
;
; The app runs a SECOND copy of its own exe as the QA engine (ELECTRON_RUN_AS_NODE) with NO window, so
; electron-builder's default "app is running" check does a graceful WM_CLOSE the windowless child ignores,
; ending at "SGEN Site QA cannot be closed. Please close it manually." On the update flow that check even
; false-triggers with nothing running, looping on Retry. Two guards below make the install deterministic:

; 1) customCheckAppRunning REPLACES the default check entirely — just hard-kill any instance and proceed.
;    No graceful close, no "cannot be closed" dialog, no retry loop. The setup exe is a different image
;    name ("SGEN Site QA Setup <ver>.exe") so this never kills the running installer itself; no /T so it
;    can't reach the installer through a process tree either.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 400
!macroend

; 2) customInit runs first in .onInit as a belt-and-suspenders hard-kill before any wizard/check.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 300
!macroend
