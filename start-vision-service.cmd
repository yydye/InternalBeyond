@echo off
setlocal
cd /d "%~dp0"

rem 可移植的 Python 探测：环境变量优先，其次 py 启动器 / python / 常见安装位置，不再依赖本机特定路径。
set "VISION_PYTHON="
if defined IB_VISION_PYTHON set "VISION_PYTHON=%IB_VISION_PYTHON%"
if not defined VISION_PYTHON (
  py -3.12 -c "import sys" >nul 2>&1
  if not errorlevel 1 set "VISION_PYTHON=py -3.12"
)
if not defined VISION_PYTHON (
  py -3 -c "import sys" >nul 2>&1
  if not errorlevel 1 set "VISION_PYTHON=py -3"
)
if not defined VISION_PYTHON (
  python -c "import sys" >nul 2>&1
  if not errorlevel 1 set "VISION_PYTHON=python"
)
if not defined VISION_PYTHON (
  for %%P in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "%ProgramFiles%\Python313\python.exe"
    "%ProgramFiles%\Python312\python.exe"
    "%ProgramFiles%\Python311\python.exe"
    "%ProgramFiles%\Python310\python.exe"
  ) do if not defined VISION_PYTHON if exist %%P set "VISION_PYTHON=%%P"
)
if not defined VISION_PYTHON (
  echo Python 3.10 or newer was not found. Install it, add it to PATH, or set IB_VISION_PYTHON.
  goto :error
)

if not exist ".venv-vision\Scripts\python.exe" (
  echo Creating isolated Python environment...
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
