@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-workbench.ps1"
if errorlevel 1 (
  echo.
  echo Workbench startup failed. See the exact reason above. Press any key to close.
  pause >nul
)
endlocal
