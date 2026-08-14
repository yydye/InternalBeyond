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

rem Make repeated launches idempotent. A healthy Bridge already bound to the
rem configured port is success, not a startup failure.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$portValue = 23115; if ($env:IB_BRIDGE_PORT -match '^\d+$') { $portValue = [Math]::Max(1, [Math]::Min(65535, [int]$env:IB_BRIDGE_PORT)) }; try { $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $portValue + '/health') -TimeoutSec 2; if ($health.ok -eq $true -and $health.server -eq 'IB Bridge') { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 goto bridge_already_running

echo.
echo Starting Internal Beyond Bridge service...
echo Close this window to stop the Bridge backend.
echo.
node.exe "%~dp0ib-bridge-service.js"
set "bridge_exit=%errorlevel%"

if not "%bridge_exit%"=="0" (
  echo.
  echo The Bridge service stopped with an error.
  pause
)

endlocal & exit /b %bridge_exit%

:bridge_already_running
echo.
echo Internal Beyond Bridge is already running and healthy.
echo No second backend process is needed.
echo.
endlocal
exit /b 0
