@echo off
setlocal
rem This script lives in scripts\windows\, so the repository root is two levels up.
for %%I in ("%~dp0..\..") do set "IB_ROOT=%%~fI"
cd /d "%IB_ROOT%"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo [Internal Beyond] Node.js 18 or newer is required.
  echo Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Internal Beyond Active Messages companion...
echo Close this window to stop background scheduling.
echo.
node.exe "%IB_ROOT%\services\active-message-service.js"

if errorlevel 1 (
  echo.
  echo The Active Messages companion stopped with an error.
  pause
)

endlocal
