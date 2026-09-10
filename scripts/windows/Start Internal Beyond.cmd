@echo off
setlocal
rem This script lives in scripts\windows\, so the repository root (== installed
rem app root) is two levels up. Resolve it once, fully qualified, so nothing
rem downstream has to reason about "..".
for %%I in ("%~dp0..\..") do set "IB_ROOT=%%~fI"
cd /d "%IB_ROOT%"

rem Compat alias entry. Node runtime resolution order (see runtime\node\README.md):
rem   1. IB_NODE environment variable (explicit override)
rem   2. bundled runtime\node\node.exe (the path used by the official installer)
rem   3. node.exe on PATH (development / compatibility fallback only)
rem A bundled runtime that exists but cannot run is reported as an error by the
rem .vbs launcher; this alias only resolves the executable path.

set "IB_NODE_EXE="
if defined IB_NODE if exist "%IB_NODE%" set "IB_NODE_EXE=%IB_NODE%"
if not defined IB_NODE_EXE if exist "%IB_ROOT%\runtime\node\node.exe" set "IB_NODE_EXE=%IB_ROOT%\runtime\node\node.exe"
if not defined IB_NODE_EXE (
  where node.exe >nul 2>nul
  if not errorlevel 1 set "IB_NODE_EXE=node.exe"
)

if not defined IB_NODE_EXE (
  echo.
  echo [Internal Beyond] No Node.js runtime found.
  echo Bundled runtime is missing at runtime\node\node.exe and node.exe is not on PATH.
  echo Reinstall InternalBeyond. Developers: run scripts\update-node-runtime.ps1 first.
  echo.
  pause
  exit /b 1
)

rem A truncated or damaged runtime must be reported here in product language.
rem Handing it to Windows makes the OS show a "16-bit application" system dialog
rem that no ordinary user can act on. The .vbs entry point performs the same
rem preflight plus a PE header check before it executes anything.
if /i not "%IB_NODE_EXE%"=="node.exe" call :verify_runtime "%IB_NODE_EXE%"
if errorlevel 1 (
  echo.
  echo [Internal Beyond] The Node.js program is damaged or incomplete:
  echo   %IB_NODE_EXE%
  echo Reinstall InternalBeyond. Developers: run scripts\update-node-runtime.ps1
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Internal Beyond...
echo This window minimizes while services start, then your browser opens.
echo If it fails, see: %LOCALAPPDATA%\InternalBeyond\logs\launcher.log
echo.
start "" /min "%IB_NODE_EXE%" "%IB_ROOT%\runtime\launch-internal-beyond.js"
endlocal
exit /b 0

rem ---------------------------------------------------------------------------
rem :verify_runtime <absolute path>
rem Reject a runtime binary that is obviously not a working Windows program:
rem missing, or far too small to be node.exe.
rem ---------------------------------------------------------------------------
:verify_runtime
if not exist "%~1" exit /b 1
for %%I in ("%~1") do set "IB_RT_SIZE=%%~zI"
if not defined IB_RT_SIZE exit /b 1
if %IB_RT_SIZE% LSS 1048576 exit /b 1
exit /b 0