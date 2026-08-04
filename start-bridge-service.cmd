@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo [Internal Beyond Bridge] Node.js 18 or newer is required.
  echo Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Internal Beyond Bridge service...
echo Close this window to stop the Bridge backend.
echo.
node.exe "%~dp0ib-bridge-service.js"

if errorlevel 1 (
  echo.
  echo The Bridge service stopped with an error.
  pause
)

endlocal
