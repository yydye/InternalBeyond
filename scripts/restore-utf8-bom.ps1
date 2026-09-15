# Restore the UTF-8 BOM on the two release files that require one.
#
# Why this exists: scripts/build-installer.ps1 is parsed by Windows PowerShell
# 5.1, which decodes a BOM-less UTF-8 file as ANSI — every Chinese message in it
# becomes mojibake. installer/InternalBeyond.iss is read by Inno Setup and has
# carried a BOM since the first release. Editing either file with tooling that
# writes plain UTF-8 drops the BOM silently, and the failure is invisible until
# a user sees garbled text. tests/test_installer.js asserts both, so this script
# is only ever needed to REPAIR a working tree that already lost them.
param([string]$Repo = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$files = @('scripts\build-installer.ps1', 'installer\InternalBeyond.iss')
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
foreach ($rel in $files) {
  $p = Join-Path $Repo $rel
  if (-not (Test-Path -LiteralPath $p)) { throw "missing: $p" }
  $text = [System.IO.File]::ReadAllText($p, $utf8NoBom)
  # Never double up, and never touch content: only the first three bytes change.
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  [System.IO.File]::WriteAllText($p, $text, $utf8Bom)
  $b = [System.IO.File]::ReadAllBytes($p)
  $ok = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  Write-Output ("{0,-34} BOM={1} bytes={2}" -f $rel, $ok, $b.Length)
}
