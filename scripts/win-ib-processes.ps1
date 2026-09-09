#Requires -Version 5.1
<#
.SYNOPSIS
  InternalBeyond · Windows process / window audit helper (P7 tests only).

.DESCRIPTION
  Finds processes whose command line references a given install root and reports
  either the process list or the top-level VISIBLE windows owned by them. Used by
  test_installer_smoke.js to prove two things without guessing:

    -Mode processes : which InternalBeyond processes from this install are alive
    -Mode windows   : whether any of them owns a visible top-level window
                      (a console window would show up as ConsoleWindowClass)

  Output: one line per item, or nothing at all. Exit code is always 0; callers
  treat empty output as "none".

.EXAMPLE
  powershell -NoProfile -File scripts\win-ib-processes.ps1 -Root "C:\x\InternalBeyond" -Mode processes
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [ValidateSet('processes', 'windows')][string]$Mode = 'processes'
)

$ErrorActionPreference = 'SilentlyContinue'

$procs = Get-CimInstance Win32_Process | Where-Object {
  # Only executables InternalBeyond can own. Without this filter the audit would
  # match its own caller (the PowerShell/bash command line contains Root).
  ($_.Name -in @('node.exe', 'wscript.exe', 'cscript.exe')) -and
  $_.ProcessId -ne $PID -and
  $_.CommandLine -and ($_.CommandLine.IndexOf($Root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

if ($Mode -eq 'processes') {
  foreach ($p in $procs) { Write-Output ("{0}`t{1}`t{2}" -f $p.ProcessId, $p.Name, $p.CommandLine) }
  exit 0
}

# -Mode windows: enumerate visible top-level windows owned by those processes.
if (-not $procs) { exit 0 }
$pids = @($procs | Select-Object -ExpandProperty ProcessId)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class IbWindowAudit
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
    [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);

    public static List<string> VisibleWindows(int[] pids)
    {
        var found = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            int pid;
            GetWindowThreadProcessId(h, out pid);
            if (Array.IndexOf(pids, pid) >= 0 && IsWindowVisible(h))
            {
                var sb = new StringBuilder(256);
                GetClassName(h, sb, 256);
                found.Add(pid + ":" + sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

foreach ($w in [IbWindowAudit]::VisibleWindows([int[]]$pids)) { Write-Output $w }
exit 0
