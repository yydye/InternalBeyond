@echo off
setlocal
cd /d "%~dp0"

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
