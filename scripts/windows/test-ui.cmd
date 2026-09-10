@echo off
setlocal
rem This script lives in scripts\windows\, so the repository root is two levels up.
rem The checks below are invoked with root-relative paths, so run from the root.
for %%I in ("%~dp0..\..") do set "IB_ROOT=%%~fI"
cd /d "%IB_ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [InternalBeyond] Node.js 18+ is required.
  pause
  exit /b 1
)

node scripts_check_html.js InternalBeyond.html || goto :failed
node test_frontend_structure.js || goto :failed
node test_game_smoke.js || goto :failed
node test_ui_regression.js || goto :failed

echo.
echo [InternalBeyond] Frontend regression passed.
pause
exit /b 0

:failed
echo.
echo [InternalBeyond] Frontend regression failed.
pause
exit /b 1
