@echo off
setlocal
set "ROOT=%~dp0"
where pwsh.exe >nul 2>nul
if not errorlevel 1 (
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%start-local-workbench.ps1"
  exit /b %errorlevel%
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%start-local-workbench.ps1"
exit /b %errorlevel%
