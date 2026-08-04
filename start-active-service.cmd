@echo off
setlocal
cd /d "%~dp0"

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
node.exe "%~dp0active-message-service.js"

if errorlevel 1 (
  echo.
  echo The Active Messages companion stopped with an error.
  pause
)

endlocal
