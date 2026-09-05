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
echo Starting Internal Beyond...
echo This window minimizes while services start, then your browser opens.
echo If it fails, see: %LOCALAPPDATA%\InternalBeyond\logs\launcher.log
echo.
start "" /min node.exe "%~dp0launch-internal-beyond.js"
endlocal
exit /b 0
