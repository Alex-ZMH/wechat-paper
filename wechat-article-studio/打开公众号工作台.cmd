@echo off
setlocal

rem Clear only this child process test switch so the user's browser opens.
set "WECHAT_STUDIO_NO_BROWSER="

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-workbench.ps1"
if errorlevel 1 (
  echo.
  echo Workbench startup failed. See the reason above. Press any key to close.
  pause >nul
)

endlocal
