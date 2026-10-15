#Requires -Version 5.1
<#
.SYNOPSIS
  InternalBeyond · one-command release build (P7).

.DESCRIPTION
  Produces dist\InternalBeyond-Setup-<version>.exe, dist\SHA256SUMS.txt and
  dist\update-stable.json (the Stable update channel contract).

  Pipeline (no manual file copying anywhere):
    1. preflight        — VERSION / pin / Inno Setup / required sources
    2. runtime gate     — bundled node.exe exists, exact version, SHA-256, runs
    3. source discovery — shared release resolver checks uncommitted files and
       static dependency closure before any release artifact is generated
       staging          — materialise that same manifest into dist\staging
    4. content + secret + release-claim — release-audit over the staged bytes
    5. compile          — ISCC (per-user, no UAC, no console window)
    6. hash             — installer SHA-256 → dist\SHA256SUMS.txt
    7. update manifest  — dist\update-stable.json, assembled from the bytes this
                          run just produced (hash + size + PE product version are
                          all read back, never re-typed) and self-validated by
                          runtime\update-manifest.js
    8. install audit    — OPT-IN only (-TestMode -InstallAudit): compile a
                           test-only identity into a test-owned output root, then
                           run tests\test_installer_smoke.js --install-audit
    9. summary

  Release order is a contract, not a preference (docs\RELEASE.md):
      InternalBeyond-Setup-<version>.exe  →  SHA256SUMS.txt  →  update-stable.json
  The manifest goes LAST; uploading it is what puts the version on the Stable
  update channel, so a half-uploaded release is never advertised to clients.

  `releasedAt` and `notes` have no reliable build-time source, so they are only
  written when passed explicitly (-ReleasedAt / -NotesFile). When they are
  missing the field is OMITTED and the build says so — it never invents a
  timestamp or release prose.

  The install audit is off by default: the P7 test budget allows exactly one
  real install smoke per built installer (docs\P7-TEST-BUDGET.md), so a plain
  build never touches the machine. Run it deliberately, once.

  Any failure aborts with a non-zero exit code. From step 3 onwards a failure
  also removes dist\staging again; a preflight or runtime-gate failure never
  touches it, because this run has not taken it over yet. A terminating error
  raised by a native tool (ISCC reports compile errors on stderr) is caught by
  the script-level trap and handled the same way.

.PARAMETER IsccPath
  Explicit path to ISCC.exe. Default: ISCC on PATH, then Program Files.

.PARAMETER ReleasedAt
  ISO-8601 UTC release timestamp for the update manifest, e.g.
  2026-09-10T06:00:00Z. Optional; omitted from the manifest when not given.

.PARAMETER NotesFile
  UTF-8 file with user-facing release notes for the update manifest. Optional;
  omitted when not given. Rendered as plain text in Diagnostics (never HTML).

.PARAMETER MinimumVersion
  Oldest version allowed to update in place (informational for now). Optional.

.PARAMETER InstallAudit
  Run step 8 (isolated install + payload audit + uninstall). Requires -TestMode;
  a production build is never installed by this script.

.PARAMETER TestMode
  Compile the deterministic test-only Inno identity into
  tmp\installer-smoke-build. This mode never writes dist\ or update-stable.json.

.PARAMETER SkipInstallAudit
  Accepted for compatibility; skipping the audit is now the default.

.PARAMETER KeepStaging
  Keep dist\staging after a successful build (debugging).

.PARAMETER SkipAudit
  Skip step 4 only. NOT recommended; the release gate expects it to run.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -TestMode -InstallAudit
#>
[CmdletBinding()]
param(
  [string]$IsccPath = '',
  [string]$ReleasedAt = '',
  [string]$NotesFile = '',
  [string]$MinimumVersion = '',
  [switch]$InstallAudit,
  [switch]$TestMode,
  [switch]$SkipInstallAudit,
  [switch]$KeepStaging,
  [switch]$SkipAudit
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 decodes native command output with the OEM code page by
# default, while our Node tools emit UTF-8 JSON (audit reasons are Chinese).
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
# $script:stage 只负责 [FAIL @ <stage>] 里的阶段名。是否清理 dist\staging 由
# $script:stagingOwned 单独决定：只有第 3 步真正接管了 staging 之后，失败才允许
# 删除它 —— preflight / runtime gate 失败绝不能删掉不是本次构建创建的目录。
$script:stage = 'preflight'
$script:stagingOwned = $false

$repo      = Split-Path -Parent $PSScriptRoot
$productionDist = Join-Path $repo 'dist'
$dist      = $productionDist
$staging   = Join-Path $dist 'staging'
$iss       = Join-Path $repo 'installer\InternalBeyond.iss'
$pinFile   = Join-Path $repo 'installer\runtime-pin.json'
$versionFile = Join-Path $repo 'VERSION'
$nodeExe   = Join-Path $repo 'runtime\node\node.exe'
$smoke     = Join-Path $repo 'tests\test_installer_smoke.js'
$optionalDshBuilder = Join-Path $repo 'scripts\build-optional-dsh-runtime.js'
$discoveryCheck = Join-Path $repo 'scripts\packaging-auto-discovery.js'
$hostStageTool = Join-Path $repo 'scripts\stage-tauri-host.ps1'
$hostBuildRoot = Join-Path ($env:ProgramData | ForEach-Object { if ($_){$_} else { Split-Path -Parent $repo } }) 'InternalBeyond\host-build'
$manifestOut = Join-Path $dist 'update-stable.json'
$manifestTool = Join-Path $repo 'runtime\update-manifest.js'

function Get-IssQuotedDefine([string]$source, [string]$name) {
  $m = [regex]::Match($source, '(?m)^\s*#define\s+' + [regex]::Escape($name) + '\s+"([^"]+)"\s*$')
  if (-not $m.Success) { Fail "installer identity define missing from $iss : $name" }
  return $m.Groups[1].Value
}

function Get-IssGuidDefine([string]$source, [string]$name) {
  $raw = Get-IssQuotedDefine $source $name
  $m = [regex]::Match($raw, '^\{\{([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}$')
  if (-not $m.Success) { Fail "installer identity define is not a valid Inno GUID: $name = $raw" }
  return $m.Groups[1].Value.ToUpperInvariant()
}

function Normalize-FullPath([string]$value) {
  return [System.IO.Path]::GetFullPath($value).TrimEnd('\')
}

function Assert-TestOutputIsolated([string]$candidate, [string]$production) {
  $candidateAbs = Normalize-FullPath $candidate
  $productionAbs = Normalize-FullPath $production
  $candidateKey = $candidateAbs.ToLowerInvariant()
  $productionKey = $productionAbs.ToLowerInvariant()
  if ($candidateKey -eq $productionKey -or $candidateKey.StartsWith($productionKey + '\')) {
    Fail "-TestMode output must be outside production dist: $candidateAbs"
  }
  return $candidateAbs
}

function Find-InstallerToken([byte[]]$bytes, [string]$token) {
  $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
  $utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
  return $ascii.IndexOf($token, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $utf16.IndexOf($token, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Assert-CompiledIdentity([string]$file, [string]$expectedAppId, [string]$forbiddenAppId, [string]$expectedName, [string]$forbiddenName) {
  $bytes = [System.IO.File]::ReadAllBytes($file)
  # Inno stores AppId in compiled setup data rather than as a stable plain-text
  # GUID, so the direct EXE evidence here is the resolved display identity. The
  # AppId proof is the source macro + explicit compiler define + test sidecar below.
  $expectedTokens = @($expectedName)
  $forbiddenTokens = @($forbiddenName) | Where-Object { $_ }
  foreach ($token in $expectedTokens) {
    if (-not (Find-InstallerToken $bytes $token)) {
      Fail "compiled installer is missing the expected identity token: $token"
    }
  }
  foreach ($token in $forbiddenTokens) {
    if (Find-InstallerToken $bytes $token) {
      Fail "compiled installer contains a forbidden identity token: $token"
    }
  }
}

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
  if ($script:stagingOwned) { Remove-Staging }
  exit 1
}

# Fail() 只覆盖我们显式判断过的失败。原生命令往 stderr 写一行（Inno Setup 的编译
# 错误正是这样）在 Windows PowerShell 5.1 里会变成终止性错误，直接跳过 Fail()：
# 既不打印阶段名也不清理 staging。这个 trap 让任何未预料的终止性错误走同一条
# 收尾路径，因此没有哪条失败路径能绕过清理。
trap { Fail $_.Exception.Message }

function Get-Sha256([string]$file) {
  # .NET rather than Get-FileHash: the cmdlet lives in Microsoft.PowerShell.Utility,
  # which is auto-loaded from PSModulePath. In a PowerShell host spawned with a
  # reduced module path (observed when a Node test spawns powershell.exe) the
  # cmdlet simply does not exist and the build dies at the runtime gate with
  # "Get-FileHash is not recognized" — a tooling failure that looks like a broken
  # release. SHA256.Create() needs no module, so the build no longer depends on
  # how its parent launched it. Same bytes, same lowercase hex.
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $file).Path)
    try { $hash = $sha.ComputeHash($stream) } finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
  return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
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
Write-Step '1/9' 'preflight'
if (-not (Test-Path -LiteralPath $versionFile)) { Fail "缺少 $versionFile（唯一版本源）" }
$version = (Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { Fail "VERSION 内容非法：'$version'（期望 MAJOR.MINOR.PATCH）" }
Write-Ok "product version = $version"

if (-not (Test-Path -LiteralPath $pinFile)) { Fail "缺少 $pinFile（运行时钉定值）" }
$pin = Get-Content -LiteralPath $pinFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pin.runtime -or -not $pin.runtime.version) { Fail "$pinFile 缺少 runtime.version" }
Write-Ok "runtime pin = node $($pin.runtime.version) $($pin.runtime.platform)"

if (-not (Test-Path -LiteralPath $iss)) { Fail "缺少 $iss" }
$issSource = Get-Content -LiteralPath $iss -Raw -Encoding UTF8
$productionAppId = Get-IssGuidDefine $issSource 'ProductionAppId'
$testAppId = Get-IssGuidDefine $issSource 'TestOnlyAppId'
$productionAppName = Get-IssQuotedDefine $issSource 'ProductionAppName'
$testAppName = Get-IssQuotedDefine $issSource 'TestOnlyAppName'
$productionOutputBaseName = Get-IssQuotedDefine $issSource 'ProductionOutputBaseName'
$testOutputBaseName = Get-IssQuotedDefine $issSource 'TestOnlyOutputBaseName'
if ($productionAppId -ne '78B427F6-A48F-4443-86D5-2F50DC899D07') {
  Fail "production Inno AppId changed unexpectedly: $productionAppId"
}
if ($testAppId -eq $productionAppId) {
  Fail 'TEST ONLY AppId must never equal the protected production AppId'
}
if ($InstallAudit -and -not $TestMode) {
  Fail '-InstallAudit requires explicit -TestMode; a production installer is never installed by this script'
}
if ($TestMode) {
  $dist = Assert-TestOutputIsolated (Join-Path $repo 'tmp\installer-smoke-build') $productionDist
  $staging = Join-Path $dist 'staging'
  $manifestOut = Join-Path $dist 'update-stable.json'
  if (Test-Path -LiteralPath $manifestOut) {
    Fail "test output already contains update-stable.json; refusing to treat release metadata as a test artifact: $manifestOut"
  }
  Write-Ok "TEST ONLY identity = $testAppName · AppId {$testAppId}"
  Write-Ok "test output = $dist (production dist is not used)"
} else {
  Write-Ok "production identity = $productionAppName · AppId {$productionAppId}"
}
foreach ($required in @(
    (Join-Path $repo 'installer\languages\ChineseSimplified.isl'),
    (Join-Path $repo 'installer\tools\ib-stop.js'),
    (Join-Path $repo 'scripts\release-manifest.js'),
    $discoveryCheck,
    (Join-Path $repo 'scripts\release-audit.js'),
    $optionalDshBuilder,
    $hostStageTool,
    (Join-Path $repo 'src-tauri\Cargo.toml'),
    (Join-Path $repo 'src-tauri\Cargo.lock'),
    $manifestTool,
    (Join-Path $repo 'LICENSE'),
    (Join-Path $repo 'LICENSES\THIRD-PARTY-NODE.md')
  )) {
  if (-not (Test-Path -LiteralPath $required)) { Fail "缺少必需文件：$required" }
}
if ($NotesFile -ne '' -and -not (Test-Path -LiteralPath $NotesFile)) {
  Fail "-NotesFile 指定的文件不存在：$NotesFile"
}
if ($ReleasedAt -ne '' -and $ReleasedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$') {
  Fail "-ReleasedAt 必须是 ISO-8601 UTC 时间戳，例如 2026-09-10T06:00:00Z（实际：'$ReleasedAt'）"
}
if ($MinimumVersion -ne '' -and $MinimumVersion -notmatch '^\d+\.\d+\.\d+$') {
  Fail "-MinimumVersion 必须是 MAJOR.MINOR.PATCH（实际：'$MinimumVersion'）"
}
if ($InstallAudit) {
  # 显式要求的安装审计不允许静默降级：脚本缺失必须在编译前就失败。
  if (-not (Test-Path -LiteralPath $smoke)) { Fail "-InstallAudit 需要安装审计脚本，但找不到：$smoke" }
  Write-Ok "install audit script = $smoke"
}
$iscc = Resolve-Iscc
Write-Ok "ISCC = $iscc"

# ── 2. bundled runtime gate (fail hard, never fall back to system Node) ─────
Write-Step '2/9' 'bundled Node runtime gate'
$script:stage = 'runtime gate'
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

# Resolve the complete production payload before any release artifact is
# generated, including the separately distributed DSH ZIP. The standalone
# check uses the same resolver that the later Stage command consumes.
$script:stage = 'packaging auto-discovery'
Write-Info 'Packaging Auto-Discovery · checking source files and static references'
$discoveryJson = & $nodeExe $discoveryCheck '--check' '--json' 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  try {
    $discovery = $discoveryJson.Trim() | ConvertFrom-Json
    foreach ($bucket in @('missingEntries', 'excludedOrDangerous', 'unsafeFilesOrReferences', 'missingReferences', 'duplicatePaths')) {
      foreach ($finding in @($discovery.findings.$bucket)) {
        Write-Host ("     ✗ [{0}] {1} — {2}" -f $bucket, $finding.path, $finding.why) -ForegroundColor Red
      }
    }
  } catch { Write-Host $discoveryJson -ForegroundColor Red }
  Fail 'Packaging Auto-Discovery 未通过；停止打包'
}
$discovery = $discoveryJson.Trim() | ConvertFrom-Json
Write-Ok ("auto-discovery PASS · {0} source files · {1} front-end resources · {2} referenced modules" -f `
  $discovery.count, $discovery.frontEndResourceCount, $discovery.staticallyDiscoveredFiles.Count)

# Package the pinned production DSH Runtime separately and verify its archive
# against the SHA-256 embedded in the Home Node installer payload.
$optionalDshZipName = 'InternalBeyond-DSH-Runtime-0.2.1-alpha.2-windows-x64.zip'
$optionalDshZip = Join-Path $dist $optionalDshZipName
Write-Info 'building optional DSH Runtime ZIP from the existing pinned runtime'
$optionalDshJson = & $nodeExe $optionalDshBuilder '--output' $optionalDshZip '--replace' 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "optional DSH Runtime ZIP build failed: $optionalDshJson" }
try { $optionalDsh = $optionalDshJson.Trim() | ConvertFrom-Json }
catch { Fail "optional DSH Runtime ZIP report is invalid: $optionalDshJson" }
if (-not $optionalDsh.ok -or $optionalDsh.sourceRevision -ne 'd743267388641bc76f17c45ce8b4c231aed1d32c' -or
    $optionalDsh.target -ne 'windows-x64' -or $optionalDsh.archiveSha256 -notmatch '^[a-f0-9]{64}$') {
  Fail "optional DSH Runtime ZIP does not match its pinned production contract: $optionalDshJson"
}
Write-Ok ("optional DSH Runtime ZIP · {0:N1} MiB · {1} files · sha256 {2}" -f `
  ($optionalDsh.archiveBytes / 1MB), $optionalDsh.fileCount, $optionalDsh.archiveSha256)

# ── 3. staging from the release manifest and discovered dependency closure ─
Write-Step '3/9' 'staging (release manifest + discovered dependencies)'
$script:stage = 'staging'
# 从此处起 dist\staging 归本次构建所有：之后任何失败都必须清掉它。
$script:stagingOwned = $true
Remove-Staging
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$stageJson = & $nodeExe (Join-Path $repo 'scripts\release-manifest.js') '--stage' $staging 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "staging 失败：$stageJson" }
$stageResult = $stageJson.Trim() | ConvertFrom-Json
if (-not $stageResult.ok) { Fail "staging 不完整：$stageJson" }
Write-Ok ("staged {0} files · {1:N1} MiB → {2}" -f $stageResult.staged, ($stageResult.totalBytes / 1MB), $stageResult.dir)

$dshPinPath = Join-Path $staging 'runtime\dsh-runtime-package-pin.json'
if (-not (Test-Path -LiteralPath $dshPinPath)) { Fail 'staging is missing the optional DSH Runtime pin' }
try { $dshPin = Get-Content -LiteralPath $dshPinPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Fail 'optional DSH Runtime pin is malformed in staging' }
if ($dshPin.schema -ne 'internalbeyond.optional-dsh-runtime-pin' -or
    $dshPin.runtimeVersion -ne $optionalDsh.runtimeVersion -or
    $dshPin.sourceRevision -ne $optionalDsh.sourceRevision -or
    $dshPin.target -ne $optionalDsh.target -or
    [string]$dshPin.archiveSha256 -ne [string]$optionalDsh.archiveSha256) {
  Fail 'optional DSH Runtime pin does not match the ZIP built for this release'
}

# The native host is the only generated production input. Build it from the
# locked Cargo project, verify its PE version against root VERSION, then copy
# exactly one executable into the canonical payload root. No _up_, target tree
# or .tauri-frontend directory is ever consumed by Inno.
$hostOutput = Join-Path $staging 'internalbeyond-host.exe'
$hostJson = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $hostStageTool `
  -RepositoryRoot $repo -OutputPath $hostOutput -Version $version -BuildRoot $hostBuildRoot 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "Tauri host staging 失败：$hostJson" }
$hostResult = $hostJson.Trim() | ConvertFrom-Json
if (-not $hostResult.ok) { Fail "Tauri host staging 不完整：$hostJson" }
Write-Ok ("stable host · {0:N1} MiB · version {1} · sha256 {2}" -f ($hostResult.bytes / 1MB), $hostResult.version, $hostResult.sha256)

# The install root carries its OWN payload manifest (upgrade §7). It is written
# from the bytes staging just produced — never hand-maintained — and it is what
# makes obsolete-payload cleanup a diff of two declarations instead of a scan of
# a directory that also holds the user's files. Its own name is listed among the
# files it declares: the manifest is payload too, and a manifest that omitted
# itself would have the next upgrade delete it.
$payloadManifest = Join-Path $staging 'ib-payload-manifest.json'
$payloadFiles = @($stageResult.files)
# A manifest that does not describe the WHOLE payload is worse than none: the next
# upgrade deletes (previous payload - this list), so an under-stated list would
# delete the files that very install had just put in place. The list comes from the
# whitelist staging just resolved; any disagreement with the count it reported is a
# hard failure, not a warning. (Measured: an earlier version of this step read a
# CLI field that did not exist yet and silently wrote a 2-entry manifest.)
if ($payloadFiles.Count -ne $stageResult.staged) {
  Fail "staging 报告 $($stageResult.staged) 个文件，但白名单返回 $($payloadFiles.Count) 条 —— 拒绝生成载荷清单"
}
$uniquePayloadFiles = @($payloadFiles | ForEach-Object { ([string]$_).Replace('\', '/') } | Sort-Object -Unique)
if ($uniquePayloadFiles.Count -ne $payloadFiles.Count) {
  Fail 'staging 白名单包含重复目标路径 —— 拒绝生成会被正式 Host 拒绝的载荷清单'
}
$payloadFiles = $uniquePayloadFiles
$payloadRecords = @($stageResult.records)
if ($payloadRecords.Count -ne $payloadFiles.Count) {
  Fail "Stage 记录 $($payloadRecords.Count) 个 size/SHA-256 项，但清单返回 $($payloadFiles.Count) 个路径 —— 拒绝生成载荷清单"
}
$recordPaths = @($payloadRecords | ForEach-Object { ([string]$_.path).Replace('\', '/') } | Sort-Object -Unique)
if ($recordPaths.Count -ne $payloadRecords.Count -or
    (@($recordPaths | Where-Object { $payloadFiles -notcontains $_ }).Count -gt 0)) {
  Fail 'Stage size/SHA-256 记录与解析器路径不一致 —— 拒绝生成载荷清单'
}
$hostRecord = [ordered]@{
  path = 'internalbeyond-host.exe'
  sizeBytes = (Get-Item -LiteralPath $hostOutput).Length
  sha256 = Get-Sha256 $hostOutput
}
$payloadRecords += $hostRecord
$payloadFiles += 'internalbeyond-host.exe'
$payloadFiles += 'ib-payload-manifest.json'
$payloadRecords = @($payloadRecords | Sort-Object -Property path)
$payloadManifestObject = [ordered]@{
  schema    = 'internalbeyond.payload-manifest'
  version   = 1
  product   = $version
  generated = 'scripts/build-installer.ps1'
  note      = 'files lists every installed path, including this manifest. artifacts records byte size and SHA-256 for every other staged file; the manifest cannot hash itself. An upgrade deletes exactly (previous manifest - this manifest) and nothing else.'
  count     = $payloadFiles.Count
  files     = @($payloadFiles | Sort-Object)
  artifactCount = $payloadRecords.Count
  artifactTotalBytes = [long](($payloadRecords | Measure-Object -Property sizeBytes -Sum).Sum)
  artifacts = $payloadRecords
}
# UTF-8 WITHOUT BOM: JSON.parse cannot read a BOM, and the installer's helper is
# the only reader. ConvertTo-Json escapes non-ASCII, so the Chinese entry names
# stay correct either way.
$manifestJson = $payloadManifestObject | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($payloadManifest, $manifestJson + "`n", (New-Object System.Text.UTF8Encoding($false)))
if (-not (Test-Path -LiteralPath $payloadManifest)) { Fail "无法生成 $payloadManifest" }
Write-Ok ("payload manifest · {0} files → {1}" -f $payloadFiles.Count, 'ib-payload-manifest.json')

# ── 4. content + secret audit on the staged bytes ──────────────────────────
Write-Step '4/9' 'content + secret + release-claim audit'
$script:stage = 'content + secret audit'
if ($SkipAudit) {
  Write-Warn '已按 -SkipAudit 跳过（不推荐）'
} else {
  $auditJson = & $nodeExe (Join-Path $repo 'scripts\release-audit.js') '--dir' $staging '--json' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    $audit = $auditJson.Trim() | ConvertFrom-Json
    $audit.findings | Where-Object { $_.severity -eq 'error' } | ForEach-Object {
      Write-Host ("     ✗ [{0}] {1}:{2} — {3} · {4}" -f $_.rule, $_.path, $_.line, $_.excerpt, $_.why) -ForegroundColor Red
    }
    $audit.violations | ForEach-Object { Write-Host ("     ✗ {0} — {1}" -f $_.path, $_.why) -ForegroundColor Red }
    Fail '内容/密钥/发行声明审计未通过'
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

# Final byte-level check runs after the content audit, immediately before ISCC.
# Inno's recursive [Files] entry consumes this exact verified Stage directory.
$script:stage = 'Stage and payload manifest verification'
$stageVerifyJson = & $nodeExe $discoveryCheck '--verify-stage' $staging '--json' 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  try {
    $stageVerify = $stageVerifyJson.Trim() | ConvertFrom-Json
    foreach ($failure in @($stageVerify.failures)) { Write-Host ("     ✗ {0}" -f $failure) -ForegroundColor Red }
  } catch { Write-Host $stageVerifyJson -ForegroundColor Red }
  Fail 'Stage 与 Payload Manifest 不一致；停止打包'
}
$stageVerify = $stageVerifyJson.Trim() | ConvertFrom-Json
Write-Ok ("Stage + payload manifest exact · {0} files · {1:N1} MiB" -f `
  $stageVerify.fileCount, ($stageVerify.totalBytes / 1MB))

# ── 5. compile ─────────────────────────────────────────────────────────────
Write-Step '5/9' 'ISCC compile'
$script:stage = 'compile'
$stagingAbs = (Resolve-Path -LiteralPath $staging).Path.TrimEnd('\')
$distAbs = (Resolve-Path -LiteralPath $dist).Path.TrimEnd('\')
$logFile = Join-Path $dist 'build-compile.log'
$compileArgs = @("/DAppVersion=$version", "/DStagingDir=$stagingAbs", "/DOutputDir=$distAbs")
if ($TestMode) { $compileArgs += '/DInstallerTestMode=1' }
$compileOutput = & $iscc @compileArgs $iss 2>&1 | Out-String
$compileCode = $LASTEXITCODE
$compileIdentity = if ($TestMode) { 'InstallerTestMode=1; resolved AppId = {' + $testAppId + '}' } else { 'InstallerTestMode absent; resolved AppId = {' + $productionAppId + '}' }
$compileOutput = "compile identity: $compileIdentity`r`ncompile args: $($compileArgs -join ' ')`r`n" + $compileOutput
$compileOutput | Set-Content -LiteralPath $logFile -Encoding UTF8
if ($compileCode -ne 0) {
  Write-Host $compileOutput
  Fail "ISCC 编译失败（退出码 $compileCode），完整日志：$logFile"
}
$outputBaseName = if ($TestMode) { $testOutputBaseName } else { $productionOutputBaseName }
$exe = Join-Path $dist "$outputBaseName-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $exe)) { Fail "编译成功但找不到输出：$exe" }
$exeItem = Get-Item -LiteralPath $exe
Write-Ok ("{0} · {1:N1} MiB" -f $exeItem.Name, ($exeItem.Length / 1MB))

$expectedAppId = if ($TestMode) { $testAppId } else { $productionAppId }
$forbiddenAppId = if ($TestMode) { $productionAppId } else { $testAppId }
$expectedAppName = if ($TestMode) { $testAppName } else { $productionAppName }
$forbiddenAppName = if ($TestMode) { '' } else { $testAppName }
Assert-CompiledIdentity $exe $expectedAppId $forbiddenAppId $expectedAppName $forbiddenAppName
Write-Ok ("compiled identity verified · AppId {{{0}}} · {1}" -f $expectedAppId, $expectedAppName)

# ── 6. hash ────────────────────────────────────────────────────────────────
Write-Step '6/9' 'SHA-256'
$script:stage = 'hash'
$exeHash = Get-Sha256 $exe
$sumsOut = Join-Path $dist 'SHA256SUMS.txt'
$checksumTitle = if ($TestMode) { '# InternalBeyond installer smoke test checksums' } else { '# InternalBeyond release checksums' }
$lines = @(
  $checksumTitle,
  "# product version : $version",
  "# built (local)   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
  "# bundled runtime : node $($pin.runtime.version) ($($pin.runtime.platform)) sha256 $($pin.runtime.sha256)",
  "# verify          : certutil -hashfile <file> SHA256   (compare the line below)",
  "$exeHash *$($exeItem.Name)"
)
$lines | Set-Content -LiteralPath $sumsOut -Encoding ASCII
Write-Ok "installer sha256 = $exeHash"
Write-Ok "checksums → $sumsOut"

if ($TestMode) {
  $identityOut = Join-Path $dist 'installer-test-identity.json'
  $identity = [ordered]@{
    schema = 'internalbeyond.installer-test-identity'
    testOnly = $true
    appId = "{$testAppId}"
    productionAppId = "{$productionAppId}"
    resolvedAppId = "{$testAppId}"
    appName = $testAppName
    publisher = 'InternalBeyond (Test Only)'
    installDirectoryName = (Get-IssQuotedDefine $issSource 'TestOnlyInstallDirectoryName')
    hostVersion = [string]$hostResult.version
    hostBytes = [int64]$hostResult.bytes
    hostSha256 = [string]$hostResult.sha256
    outputBaseName = $testOutputBaseName
    artifact = $exeItem.Name
    sha256 = $exeHash
    compilerDefine = 'InstallerTestMode=1'
    compilerArgs = @($compileArgs)
    source = 'installer/InternalBeyond.iss'
  }
  $identityJson = $identity | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($identityOut, $identityJson + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "test identity evidence → $identityOut"
}

# ── 7. update manifest (Stable channel contract) ───────────────────────────
# 值全部来自本次构建刚刚产生的字节，绝不重新输入：hash 用第 6 步算出的值，
# size 取文件实际长度，productVersion 从 PE 里读回来核对。三者任一不符即失败
# —— 发布契约宁可不产出，也不能产出一份和 exe 对不上的清单。
Write-Step '7/9' 'update manifest'
$script:stage = 'update manifest'
$manifestResult = $null
if ($TestMode) {
  Write-Info 'test mode: update-stable.json is deliberately not generated'
} else {
$peProduct = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
$peMatch = [regex]::Match([string]$peProduct, '\d+\.\d+\.\d+')
if (-not $peMatch.Success) { Fail "无法从安装包读取 ProductVersion：'$peProduct'" }
$peVersion = $peMatch.Value
if ($peVersion -ne $version) {
  Fail "安装包 PE ProductVersion ($peVersion) 与 VERSION ($version) 不一致；请检查 ISCC define 传递。"
}
Write-Ok "PE ProductVersion = $peVersion（与 VERSION 一致）"

$manifestArgs = @(
  $manifestTool, '--write', $manifestOut,
  '--version', $version,
  '--sha256', $exeHash,
  '--sizeBytes', [string]$exeItem.Length,
  '--productVersion', $peVersion
)
if ($ReleasedAt -ne '') { $manifestArgs += @('--releasedAt', $ReleasedAt) }
if ($MinimumVersion -ne '') { $manifestArgs += @('--minimumVersion', $MinimumVersion) }
if ($NotesFile -ne '') { $manifestArgs += @('--notesFile', (Resolve-Path -LiteralPath $NotesFile).Path) }

$manifestJson = & $nodeExe @manifestArgs 2>&1 | Out-String
$manifestCode = $LASTEXITCODE
$manifestResult = $null
try { $manifestResult = $manifestJson.Trim() | ConvertFrom-Json } catch { }
if ($manifestCode -ne 0 -or -not $manifestResult -or -not $manifestResult.ok) {
  if ($manifestResult -and $manifestResult.errors) {
    $manifestResult.errors | ForEach-Object { Write-Host ("     ✗ {0} — {1}" -f $_.field, $_.why) -ForegroundColor Red }
  }
  Fail "更新清单生成失败（退出码 $manifestCode）：$manifestJson"
}
$man = $manifestResult.manifest
# 反漂移闸门：清单 URL 的资产名必须就是这次真正产出的文件名。ISCC 的
# OutputBaseFilename 与 runtime\update-manifest.js 的 installerAssetName() 是两处
# 独立拼写，这里用真实字节把它们钉在一起 —— 否则清单可能指向一个不存在的资产。
$urlAsset = ($man.installer.url -split '/')[-1]
if ($urlAsset -ne $exeItem.Name) {
  Fail "清单 URL 的资产名 ($urlAsset) 与实际产出文件 ($($exeItem.Name)) 不一致。"
}
Write-Ok ("update-stable.json → {0}" -f $manifestOut)
Write-Ok ("  version {0} · {1:N1} MiB · sha256 {2}" -f $man.version, ($man.installer.sizeBytes / 1MB), $man.installer.sha256.Substring(0, 16))
Write-Ok ("  url {0}" -f $man.installer.url)
if ($manifestResult.warnings) {
  $manifestResult.warnings | ForEach-Object { Write-Info ("  warn [{0}] {1}" -f $_.field, $_.why) }
}
# releasedAt / notes 没有可靠的构建期来源：没显式给就不写，绝不编造。
if (-not $manifestResult.releasedAtSupplied) {
  Write-Warn '清单未包含 releasedAt（未传 -ReleasedAt）：发布阶段可补，或接受缺省'
}
if (-not $manifestResult.notesSupplied) {
  Write-Warn '清单未包含 notes（未传 -NotesFile）：用户在更新卡片上看不到更新说明'
}
Write-Info '发布顺序：exe → SHA256SUMS.txt → update-stable.json（清单最后上传才进入 Stable 通道）'
}

# ── 7. install audit (opt-in: one real install per built installer) ────────
Write-Step '8/9' 'install / content audit'
$script:stage = 'install audit'
if ($SkipInstallAudit) {
  Write-Info '安装审计已跳过（-SkipInstallAudit，现在也是默认行为）'
} elseif (-not $InstallAudit) {
  Write-Info '默认不安装：测试预算只允许一次真实安装 smoke（docs\P7-TEST-BUDGET.md）'
  if ($TestMode) {
    Write-Info 'test mode 已编译；需要安装审计时再加 -InstallAudit'
    Write-Info "真实安装 smoke：node tests/test_installer_smoke.js --real-install-smoke --exe `"$exe`""
  } else {
    Write-Info '需要测试 installer 时显式加 -TestMode（生产 build 不可直接安装）'
  }
} elseif (-not (Test-Path -LiteralPath $smoke)) {
  # 显式安装审计绝不能降级成「跳过」：缺脚本即构建失败（非零退出）。
  Fail "-InstallAudit 需要安装审计脚本，但找不到：$smoke`n  期望位置：tests\test_installer_smoke.js（测试套件位于 tests\）"
} else {
  & $nodeExe $smoke '--install-audit' '--exe' $exe
  if ($LASTEXITCODE -ne 0) { Fail '安装审计未通过（安装后的载荷包含被禁止的内容或安装失败）' }
  Write-Ok '安装后载荷审计通过'
}

# ── 8. summary ─────────────────────────────────────────────────────────────
Write-Step '9/9' 'summary'
$script:stage = 'summary'
if (-not $KeepStaging) { Remove-Staging; Write-Ok 'staging 已清理' } else { Write-Info "保留 staging：$staging" }
Write-Host ''
if ($TestMode) { Write-Host '  InternalBeyond test-only installer build complete' -ForegroundColor Yellow }
else { Write-Host '  InternalBeyond release build complete' -ForegroundColor Green }
Write-Host ("  version    : {0}" -f $version)
Write-Host ("  installer  : {0}" -f $exe)
Write-Host ("  size       : {0:N1} MiB ({1} bytes)" -f ($exeItem.Length / 1MB), $exeItem.Length)
Write-Host ("  sha256     : {0}" -f $exeHash)
Write-Host ("  checksums  : {0}" -f $sumsOut)
if ($TestMode) {
  Write-Host '  manifest   : (test mode intentionally emits no update-stable.json)'
  Write-Host '  release    : TEST ONLY — do not upload or publish'
} else {
  Write-Host ("  manifest   : {0}" -f $manifestOut)
  Write-Host ("  DSH Runtime ZIP : {0}" -f $optionalDshZip)
  Write-Host ("  DSH ZIP size    : {0} bytes" -f $optionalDsh.archiveBytes)
  Write-Host ("  DSH ZIP sha256  : {0}" -f $optionalDsh.archiveSha256)
  Write-Host ''
  Write-Host '  发布（顺序即契约，清单最后）：' -ForegroundColor White
  Write-Host '    gh release create v<version> "<exe>" "dist\SHA256SUMS.txt" --title "InternalBeyond v<version>" --notes-file <notes>'
  Write-Host '    gh release upload v<version> "dist\update-stable.json"   # LAST: 进入 Stable 通道'
}
Write-Host ''
exit 0
