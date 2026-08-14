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
echo Starting Internal Beyond local services (Bridge + Active)...
echo Type s then Enter for status, or q then Enter to stop services started here.
echo Add --vision to this command if you also want the optional Vision helper.
echo.
node.exe "%~dp0local-services-runner.js" %*
set "runner_exit=%errorlevel%"

if not "%runner_exit%"=="0" (
  echo.
  echo The local services runner stopped with an error.
  pause
)

endlocal & exit /b %runner_exit%
