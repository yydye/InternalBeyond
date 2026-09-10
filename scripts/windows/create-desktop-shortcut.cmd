@echo off
setlocal
rem This script lives in scripts\windows\, so the repository root is two levels up.
for %%I in ("%~dp0..\..") do set "IB_ROOT=%%~fI"
cd /d "%IB_ROOT%"

rem Internal Beyond desktop-shortcut installer (idempotent).
rem Creates Desktop\InternalBeyond.lnk pointing to the .vbs launcher at the
rem repository root, reusing the existing official icon
rem assets\icons\IB-icon.ico (no regeneration).
rem Re-run after moving the project to re-point the shortcut.
rem It only installs the desktop entry; the launcher logic is unchanged.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root=(Get-Location).Path; $ws=New-Object -ComObject WScript.Shell; $vbs=(Get-ChildItem -Path $root -Filter *.vbs | Select-Object -First 1).FullName; if(-not $vbs){ throw 'No .vbs launcher found in project root' }; $ico=Join-Path $root 'assets\icons\IB-icon.ico'; if(-not (Test-Path $ico)){ throw 'assets\icons\IB-icon.ico not found' }; $desktop=[Environment]::GetFolderPath('Desktop'); $lnk=$ws.CreateShortcut((Join-Path $desktop 'InternalBeyond.lnk')); $lnk.TargetPath=$vbs; $lnk.WorkingDirectory=$root; $lnk.IconLocation=$ico; $lnk.Description='Internal Beyond'; $lnk.Save(); Write-Output ('Desktop shortcut: '+(Join-Path $desktop 'InternalBeyond.lnk')); Write-Output ('  Target : '+$lnk.TargetPath); Write-Output ('  Icon   : '+$lnk.IconLocation)"

if errorlevel 1 (
  echo.
  echo Failed to create the desktop shortcut.
  pause
)
endlocal
exit /b 0
