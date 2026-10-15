@echo off
setlocal
for %%I in ("%~dp0..\..") do set "IB_ROOT=%%~fI"
cd /d "%IB_ROOT%"

if exist "%IB_ROOT%\runtime\node\node.exe" (
  "%IB_ROOT%\runtime\node\node.exe" "%IB_ROOT%\runtime\ib-dev-launcher.js" %*
) else (
  where node.exe >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [IB Dev Launcher] Node.js 22.5 or newer is required.
    echo Use the repository runtime or add Node.js to PATH.
    echo.
    pause
    exit /b 1
  )
  node.exe "%IB_ROOT%\runtime\ib-dev-launcher.js" %*
)
set "ib_exit=%errorlevel%"
if not "%ib_exit%"=="0" (
  echo.
  echo IB Dev Launcher stopped with an error. Use the logs command for details.
  pause
)
endlocal & exit /b %ib_exit%
