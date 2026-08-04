@echo off
setlocal
cd /d "%~dp0"

set "VISION_PYTHON=py -3.12"
py -3.12 -c "import sys" >nul 2>&1
if errorlevel 1 (
  if exist "E:\python.exe" (
    set "VISION_PYTHON=E:\python.exe"
  ) else (
    echo Python 3.12 was not found. Install it or set VISION_PYTHON in this script.
    goto :error
  )
)

if not exist ".venv-vision\Scripts\python.exe" (
  echo Creating isolated Python 3.12 environment...
  %VISION_PYTHON% -m venv .venv-vision || goto :error
)

echo Checking and installing vision dependencies...
".venv-vision\Scripts\python.exe" -m vision.bootstrap || goto :error

echo Starting Qwen2.5-VL service on http://127.0.0.1:8765 ...
".venv-vision\Scripts\python.exe" -m uvicorn vision.api:app --host 127.0.0.1 --port 8765
goto :eof

:error
echo.
echo Vision service setup failed. Review the error above.
pause
exit /b 1
