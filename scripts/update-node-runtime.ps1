#Requires -Version 5.1
<#
.SYNOPSIS
  下载并安装 InternalBeyond 的私有 Node.js 运行时到 runtime\node\。

.DESCRIPTION
  构建期脚本（不随安装包分发给最终用户）。流程：
    1. 解析目标版本（参数 > runtime\node\VERSION）
    2. 下载官方 node.exe / SHASUMS256.txt / LICENSE 到临时目录
    3. 用官方 SHASUMS256.txt 逐字节校验 node.exe 的 SHA-256
    4. 全部通过后才写入 runtime\node\（先临时文件，再原子替换）
    5. 实际执行 node.exe --version 自检，并核对与目标版本一致

  任一步失败即中止，且不会留下半成品（下载全部在临时目录完成）。

.PARAMETER Version
  精确版本号（如 24.18.0）。省略时读取 runtime\node\VERSION。

.PARAMETER Force
  即使 node.exe 已存在且校验通过也重新下载。

.PARAMETER RuntimeDir
  覆盖输出目录，默认 <repo>\runtime\node。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-node-runtime.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-node-runtime.ps1 -Version 24.18.0 -Force
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [switch]$Force,
  [string]$RuntimeDir = ''
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Host ''
  Write-Host "[update-node-runtime] ERROR: $Message" -ForegroundColor Red
  exit 1
}
function Info([string]$Message) {
  Write-Host "[update-node-runtime] $Message"
}

# ── 0. 定位仓库与输出目录 ─────────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
  $RuntimeDir = Join-Path $root 'runtime\node'
}
$versionFile = Join-Path $RuntimeDir 'VERSION'
$nodeExe     = Join-Path $RuntimeDir 'node.exe'
$licenseFile = Join-Path $RuntimeDir 'LICENSE'
$sumsFile    = Join-Path $RuntimeDir 'SHA256SUMS'

# ── 1. 解析版本 ───────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($Version)) {
  if (-not (Test-Path -LiteralPath $versionFile)) {
    Fail "未指定 -Version，且找不到 $versionFile"
  }
  $Version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Fail "版本号格式非法：'$Version'（期望形如 24.18.0）"
}
if ($Version -notmatch '^24\.') {
  Write-Host "[update-node-runtime] 注意：目标版本 $Version 不在 Node 24 LTS 线上。" -ForegroundColor Yellow
}

$baseUrl = "https://nodejs.org/dist/v$Version"
$urlExe  = "$baseUrl/win-x64/node.exe"
$urlSums = "$baseUrl/SHASUMS256.txt"
$urlLic  = "https://raw.githubusercontent.com/nodejs/node/v$Version/LICENSE"

Info "目标版本：v$Version"
Info "输出目录：$RuntimeDir"

# ── 2. 若已存在且校验通过，且未指定 -Force，则跳过 ─────────────────────
if ((Test-Path -LiteralPath $nodeExe) -and -not $Force) {
  if (Test-Path -LiteralPath $sumsFile) {
    try {
      $expected = (Get-Content -LiteralPath $sumsFile | Where-Object { $_ -match 'node\.exe' } | Select-Object -First 1)
      if ($expected) {
        $expectedHash = ($expected -split '\s+')[0].ToUpperInvariant()
        $actualHash = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash
        if ($actualHash -eq $expectedHash) {
          $current = (& $nodeExe --version) 2>$null
          if ($current -eq "v$Version") {
            Info "已存在且校验通过（$current），跳过。使用 -Force 可强制重下。"
            exit 0
          }
        }
      }
    } catch {
      Info "现有文件校验未通过，将重新下载。"
    }
  }
}

# ── 3. 下载到临时目录（失败不留半成品） ────────────────────────────────
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ib-node-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  $tmpExe  = Join-Path $tmpDir 'node.exe'
  $tmpSums = Join-Path $tmpDir 'SHASUMS256.txt'
  $tmpLic  = Join-Path $tmpDir 'LICENSE'

  Info "下载 SHASUMS256.txt …"
  Invoke-WebRequest -Uri $urlSums -OutFile $tmpSums -UseBasicParsing
  Info "下载 LICENSE …"
  Invoke-WebRequest -Uri $urlLic -OutFile $tmpLic -UseBasicParsing
  Info "下载 node.exe（约 88 MiB，请稍候）…"
  Invoke-WebRequest -Uri $urlExe -OutFile $tmpExe -UseBasicParsing

  if (-not (Test-Path -LiteralPath $tmpExe) -or (Get-Item -LiteralPath $tmpExe).Length -lt 10MB) {
    Fail "下载的 node.exe 体积异常，疑似下载失败。"
  }

  # ── 4. 用官方清单校验 SHA-256 ───────────────────────────────────────
  $line = Get-Content -LiteralPath $tmpSums | Where-Object { $_ -match 'win-x64/node\.exe' } | Select-Object -First 1
  if (-not $line) { Fail "官方 SHASUMS256.txt 中没有 win-x64/node.exe 条目。" }
  $expectedHash = ($line -split '\s+')[0].ToUpperInvariant()
  $actualHash   = (Get-FileHash -LiteralPath $tmpExe -Algorithm SHA256).Hash
  Info "期望 SHA-256：$expectedHash"
  Info "实际 SHA-256：$actualHash"
  if ($actualHash -ne $expectedHash) {
    Fail "SHA-256 不匹配，已中止（不写入任何文件）。"
  }

  # ── 5. 先自检，再落盘 ───────────────────────────────────────────────
  $probe = (& $tmpExe --version) 2>$null
  if ($probe -ne "v$Version") {
    Fail "下载的 node.exe 自检失败：期望 v$Version，实际 '$probe'。"
  }
  Info "自检通过：$probe"

  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  Copy-Item -LiteralPath $tmpExe  -Destination $nodeExe     -Force
  Copy-Item -LiteralPath $tmpLic  -Destination $licenseFile -Force
  Set-Content -LiteralPath $versionFile -Value $Version -NoNewline -Encoding ASCII
  Set-Content -LiteralPath $sumsFile    -Value ("$expectedHash *node.exe") -Encoding ASCII

  # ── 6. 落盘后复核 ───────────────────────────────────────────────────
  $finalHash = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash
  if ($finalHash -ne $expectedHash) { Fail "落盘后复核失败：$finalHash" }
  $finalVer = (& $nodeExe --version) 2>$null
  if ($finalVer -ne "v$Version") { Fail "落盘后自检失败：'$finalVer'" }

  Info "完成：$nodeExe ($finalVer, $([Math]::Round((Get-Item -LiteralPath $nodeExe).Length / 1MB, 1)) MiB)"
  Info "已同步：VERSION / SHA256SUMS / LICENSE"
  exit 0
}
finally {
  if (Test-Path -LiteralPath $tmpDir) {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
