#Requires -Version 5.1
<#
.SYNOPSIS
  InternalBeyond · one-command release build (P7).

.DESCRIPTION
  Produces dist\InternalBeyond-Setup-<version>.exe plus dist\SHA256SUMS.txt.

  Pipeline (no manual file copying anywhere):
    1. preflight        — VERSION / pin / Inno Setup / required sources
    2. runtime gate     — bundled node.exe exists, exact version, SHA-256, runs
    3. staging          — whitelist manifest materialised into dist\staging
    4. content + secret — release-audit over the staged bytes
    5. compile          — ISCC (per-user, no UAC, no console window)
    6. hash             — installer SHA-256 → dist\SHA256SUMS.txt
    7. install audit    — OPT-IN only (-InstallAudit): silent install into a
                          temp dir, enumerate + audit the installed payload,
                          then uninstall (test_installer_smoke.js --install-audit)
    8. summary

  The install audit is off by default: the P7 test budget allows exactly one
  real install smoke per built installer (docs\P7-TEST-BUDGET.md), so a plain
  build never touches the machine. Run it deliberately, once.

  Any failure aborts with a non-zero exit code and leaves dist\staging removed.

.PARAMETER IsccPath
  Explicit path to ISCC.exe. Default: ISCC on PATH, then Program Files.

.PARAMETER InstallAudit
  Run step 7 (isolated install + payload audit + uninstall). Off by default.

.PARAMETER SkipInstallAudit
  Accepted for compatibility; skipping the audit is now the default.

.PARAMETER KeepStaging
  Keep dist\staging after a successful build (debugging).

.PARAMETER SkipAudit
  Skip step 4 only. NOT recommended; the release gate expects it to run.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
#>
[CmdletBinding()]
param(
  [string]$IsccPath = '',
  [switch]$InstallAudit,
  [switch]$SkipInstallAudit,
  [switch]$KeepStaging,
  [switch]$SkipAudit
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 decodes native command output with the OEM code page by
# default, while our Node tools emit UTF-8 JSON (audit reasons are Chinese).
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$script:stage = 'preflight'

$repo      = Split-Path -Parent $PSScriptRoot
$dist      = Join-Path $repo 'dist'
$staging   = Join-Path $dist 'staging'
$iss       = Join-Path $repo 'installer\InternalBeyond.iss'
$pinFile   = Join-Path $repo 'installer\runtime-pin.json'
$versionFile = Join-Path $repo 'VERSION'
$nodeExe   = Join-Path $repo 'runtime\node\node.exe'
$smoke     = Join-Path $repo 'test_installer_smoke.js'

function Write-Step([string]$n, [string]$t) {
  Write-Host ''
  Write-Host "[$n] $t" -ForegroundColor Cyan
}
function Write-Ok([string]$m)   { Write-Host "     OK   $m" -ForegroundColor Green }
function Write-Info([string]$m) { Write-Host "     ..   $m" -ForegroundColor Gray }
function Write-Warn([string]$m) { Write-Host "     WARN $m" -ForegroundColor Yellow }

function Remove-Staging {
  if (Test-Path -LiteralPath $staging) {
    for ($i = 1; $i -le 3; $i++) {
      try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 300 }
    }
    Write-Warn "无法清理 $staging（可手动删除）"
  }
}

function Fail([string]$message) {
  Write-Host ''
  Write-Host "[FAIL @ $script:stage] $message" -ForegroundColor Red
  if ($script:stage -ne 'preflight') { Remove-Staging }
  exit 1
}

function Get-Sha256([string]$file) {
  return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-Iscc {
  if ($IsccPath -ne '') {
    if (-not (Test-Path -LiteralPath $IsccPath)) { Fail "指定的 ISCC.exe 不存在：$IsccPath" }
    return (Resolve-Path -LiteralPath $IsccPath).Path
  }
  $cmd = Get-Command 'ISCC.exe' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  Fail @"
找不到 Inno Setup 6 的 ISCC.exe。请先安装 Inno Setup 6（免费）：
    choco install innosetup -y
  或 https://jrsoftware.org/isdl.php
  也可用 -IsccPath 指定路径。
"@
}

Write-Host 'InternalBeyond · release build (P7)' -ForegroundColor White

# ── 1. preflight ────────────────────────────────────────────────────────────
Write-Step '1/8' 'preflight'
if (-not (Test-Path -LiteralPath $versionFile)) { Fail "缺少 $versionFile（唯一版本源）" }
$version = (Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { Fail "VERSION 内容非法：'$version'（期望 MAJOR.MINOR.PATCH）" }
Write-Ok "product version = $version"

if (-not (Test-Path -LiteralPath $pinFile)) { Fail "缺少 $pinFile（运行时钉定值）" }
$pin = Get-Content -LiteralPath $pinFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pin.runtime -or -not $pin.runtime.version) { Fail "$pinFile 缺少 runtime.version" }
Write-Ok "runtime pin = node $($pin.runtime.version) $($pin.runtime.platform)"

if (-not (Test-Path -LiteralPath $iss)) { Fail "缺少 $iss" }
foreach ($required in @(
    (Join-Path $repo 'installer\languages\ChineseSimplified.isl'),
    (Join-Path $repo 'installer\tools\ib-stop.js'),
    (Join-Path $repo 'scripts\release-manifest.js'),
    (Join-Path $repo 'scripts\release-audit.js'),
    (Join-Path $repo 'LICENSE'),
    (Join-Path $repo 'LICENSES\THIRD-PARTY-NODE.md')
  )) {
  if (-not (Test-Path -LiteralPath $required)) { Fail "缺少必需文件：$required" }
}
$iscc = Resolve-Iscc
Write-Ok "ISCC = $iscc"

# ── 2. bundled runtime gate (fail hard, never fall back to system Node) ─────
Write-Step '2/8' 'bundled Node runtime gate'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  Fail @"
缺少内置运行时 runtime\node\node.exe。
正式安装包必须携带它（用户无需安装 Node.js）。请先获取：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update-node-runtime.ps1
"@
}
$metaVersionFile = Join-Path $repo $pin.runtime.metadata.versionFile
$metaSumsFile    = Join-Path $repo $pin.runtime.metadata.sumsFile
if (-not (Test-Path -LiteralPath $metaVersionFile)) { Fail "缺少 $metaVersionFile" }
if (-not (Test-Path -LiteralPath $metaSumsFile)) { Fail "缺少 $metaSumsFile" }

$metaVersion = (Get-Content -LiteralPath $metaVersionFile -Raw -Encoding UTF8).Trim()
if ($metaVersion -ne $pin.runtime.version) {
  Fail "runtime\node\VERSION ($metaVersion) 与发行钉定值 ($($pin.runtime.version)) 不一致。"
}
Write-Ok "runtime metadata version = $metaVersion"

$sumsText = Get-Content -LiteralPath $metaSumsFile -Raw -Encoding UTF8
$m = [regex]::Match($sumsText, '(?im)^\s*([0-9a-f]{64})\s+\*?node\.exe\s*$')
if (-not $m.Success) { Fail "runtime\node\SHA256SUMS 不含 node.exe 的 SHA-256" }
$sumsHash = $m.Groups[1].Value.ToLowerInvariant()
if ($sumsHash -ne $pin.runtime.sha256.ToLowerInvariant()) {
  Fail "SHA256SUMS ($sumsHash) 与发行钉定值 ($($pin.runtime.sha256)) 不一致。"
}
$actualHash = Get-Sha256 $nodeExe
if ($actualHash -ne $pin.runtime.sha256.ToLowerInvariant()) {
  Fail "runtime\node\node.exe 的 SHA-256 与钉定值不一致。`n  期望: $($pin.runtime.sha256)`n  实际: $actualHash"
}
Write-Ok "node.exe SHA-256 与钉定值一致"

$reported = (& $nodeExe '--version' 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Fail "内置 node.exe 无法执行（--version 退出码 $LASTEXITCODE）" }
if ($reported -ne "v$($pin.runtime.version)") { Fail "内置 node.exe 报告版本 '$reported'，期望 'v$($pin.runtime.version)'" }
$procVer = (& $nodeExe '-e' 'process.stdout.write(process.version)' 2>&1 | Out-String).Trim()
if ($procVer -ne "v$($pin.runtime.version)") { Fail "内置 node.exe 的 process.version='$procVer'，期望 'v$($pin.runtime.version)'" }
$requireCheck = (& $nodeExe '-e' "require('http');require('fs');require('path');process.stdout.write('ok')" 2>&1 | Out-String).Trim()
if ($requireCheck -ne 'ok') { Fail "内置 node.exe 无法加载内置模块：$requireCheck" }
Write-Ok "node.exe 可执行 · --version = $reported · process.version = $procVer"

# ── 3. staging from the whitelist manifest ─────────────────────────────────
Write-Step '3/8' 'staging (whitelist manifest)'
Remove-Staging
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$stageJson = & $nodeExe (Join-Path $repo 'scripts\release-manifest.js') '--stage' $staging 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "staging 失败：$stageJson" }
$stageResult = $stageJson.Trim() | ConvertFrom-Json
if (-not $stageResult.ok) { Fail "staging 不完整：$stageJson" }
Write-Ok ("staged {0} files · {1:N1} MiB → {2}" -f $stageResult.staged, ($stageResult.totalBytes / 1MB), $stageResult.dir)

# ── 4. content + secret audit on the staged bytes ──────────────────────────
Write-Step '4/8' 'content + secret audit'
if ($SkipAudit) {
  Write-Warn '已按 -SkipAudit 跳过（不推荐）'
} else {
  $auditJson = & $nodeExe (Join-Path $repo 'scripts\release-audit.js') '--dir' $staging '--json' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    $audit = $auditJson.Trim() | ConvertFrom-Json
    $audit.findings | Where-Object { $_.severity -eq 'error' } | ForEach-Object {
      Write-Host ("     ✗ [{0}] {1}:{2} — {3}" -f $_.rule, $_.path, $_.line, $_.excerpt) -ForegroundColor Red
    }
    $audit.violations | ForEach-Object { Write-Host ("     ✗ {0} — {1}" -f $_.path, $_.why) -ForegroundColor Red }
    Fail '内容/密钥审计未通过'
  }
  $audit = $auditJson.Trim() | ConvertFrom-Json
  Write-Ok ("audit PASS · {0} files · {1} error / {2} warn" -f $audit.fileCount, $audit.errors, $audit.warnings)
  if ($audit.warnings -gt 0) {
    Write-Info 'warn 项（人工复核，不阻断）：'
    $audit.findings | Where-Object { $_.severity -eq 'warn' } | Select-Object -First 12 | ForEach-Object {
      Write-Info ("  [{0}] {1}:{2}" -f $_.rule, $_.path, $_.line)
    }
  }
}

# ── 5. compile ─────────────────────────────────────────────────────────────
Write-Step '5/8' 'ISCC compile'
$stagingAbs = (Resolve-Path -LiteralPath $staging).Path.TrimEnd('\')
$distAbs = (Resolve-Path -LiteralPath $dist).Path.TrimEnd('\')
$logFile = Join-Path $dist 'build-compile.log'
$compileOutput = & $iscc "/DAppVersion=$version" "/DStagingDir=$stagingAbs" "/DOutputDir=$distAbs" $iss 2>&1 | Out-String
$compileCode = $LASTEXITCODE
$compileOutput | Set-Content -LiteralPath $logFile -Encoding UTF8
if ($compileCode -ne 0) {
  Write-Host $compileOutput
  Fail "ISCC 编译失败（退出码 $compileCode），完整日志：$logFile"
}
$exe = Join-Path $dist "InternalBeyond-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $exe)) { Fail "编译成功但找不到输出：$exe" }
$exeItem = Get-Item -LiteralPath $exe
Write-Ok ("{0} · {1:N1} MiB" -f $exeItem.Name, ($exeItem.Length / 1MB))

# ── 6. hash ────────────────────────────────────────────────────────────────
Write-Step '6/8' 'SHA-256'
$exeHash = Get-Sha256 $exe
$sumsOut = Join-Path $dist 'SHA256SUMS.txt'
$lines = @(
  "# InternalBeyond release checksums",
  "# product version : $version",
  "# built (local)   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
  "# bundled runtime : node $($pin.runtime.version) ($($pin.runtime.platform)) sha256 $($pin.runtime.sha256)",
  "# verify          : certutil -hashfile <file> SHA256   (compare the line below)",
  "$exeHash *$($exeItem.Name)"
)
$lines | Set-Content -LiteralPath $sumsOut -Encoding ASCII
Write-Ok "installer sha256 = $exeHash"
Write-Ok "checksums → $sumsOut"

# ── 7. install audit (opt-in: one real install per built installer) ────────
Write-Step '7/8' 'install / content audit'
if ($SkipInstallAudit) {
  Write-Info '安装审计已跳过（-SkipInstallAudit，现在也是默认行为）'
} elseif (-not $InstallAudit) {
  Write-Info '默认不安装：测试预算只允许一次真实安装 smoke（docs\P7-TEST-BUDGET.md）'
  Write-Info '需要隔离载荷审计时显式加 -InstallAudit'
  Write-Info '真实安装 smoke：node test_installer_smoke.js --real-install-smoke'
} elseif (-not (Test-Path -LiteralPath $smoke)) {
  Write-Warn "缺少 $smoke，跳过"
} else {
  & $nodeExe $smoke '--install-audit' '--exe' $exe
  if ($LASTEXITCODE -ne 0) { Fail '安装审计未通过（安装后的载荷包含被禁止的内容或安装失败）' }
  Write-Ok '安装后载荷审计通过'
}

# ── 8. summary ─────────────────────────────────────────────────────────────
Write-Step '8/8' 'summary'
if (-not $KeepStaging) { Remove-Staging; Write-Ok 'staging 已清理' } else { Write-Info "保留 staging：$staging" }
Write-Host ''
Write-Host '  InternalBeyond release build complete' -ForegroundColor Green
Write-Host ("  version    : {0}" -f $version)
Write-Host ("  installer  : {0}" -f $exe)
Write-Host ("  size       : {0:N1} MiB ({1} bytes)" -f ($exeItem.Length / 1MB), $exeItem.Length)
Write-Host ("  sha256     : {0}" -f $exeHash)
Write-Host ("  checksums  : {0}" -f $sumsOut)
Write-Host ''
exit 0
