#Requires -Version 5.1
<#
.SYNOPSIS
  Build and stage the Tauri host executable as a stable production payload input.

  The Cargo mirror is build-only. It is populated from the release whitelist plus
  src-tauri source/config, and is deleted after the host EXE is copied out. The
  installed contract contains one host EXE, never Cargo target internals, _up_,
  .tauri-frontend, or a second Web Core.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$BuildRoot,
  [switch]$TestMode
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) { throw $message }

function Get-Sha256([string]$file) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $file).Path)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

$repo = (Resolve-Path -LiteralPath $RepositoryRoot).Path.TrimEnd('\')
$output = [System.IO.Path]::GetFullPath($OutputPath)
$mirror = [System.IO.Path]::GetFullPath($BuildRoot).TrimEnd('\')
$marker = Join-Path $mirror '.ib-host-build-owned'
$cargoManifest = Join-Path $mirror 'src-tauri\Cargo.toml'
$cargoLock = Join-Path $mirror 'src-tauri\Cargo.lock'
$hostSource = Join-Path $mirror 'cargo-target\release\internalbeyond-host.exe'
$cargoLog = Join-Path ([System.IO.Path]::GetTempPath()) ('ib-host-cargo-' + [Guid]::NewGuid().ToString('N') + '.log')
$mirrorOwned = $false

try {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "invalid host version: $Version" }
  if (-not (Test-Path -LiteralPath (Join-Path $repo 'runtime\node\node.exe'))) {
    Fail 'bundled Node is required to materialize the host build mirror'
  }
  $cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
  if (-not $cargo) { Fail 'cargo.exe is required to build the production Tauri host' }

  if (Test-Path -LiteralPath $mirror) {
    if (-not (Test-Path -LiteralPath $marker) -or
        (Get-Content -Raw -LiteralPath $marker).Trim() -ne 'internalbeyond-host-build-v1') {
      Fail "refusing to reuse a non-owned host build root: $mirror"
    }
    Remove-Item -LiteralPath $mirror -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $mirror | Out-Null
  $mirrorOwned = $true

  # Materialize the canonical payload sources into a bounded build mirror.
  $node = Join-Path $repo 'runtime\node\node.exe'
  $manifestTool = Join-Path $repo 'scripts\release-manifest.js'
  $stageJson = & $node $manifestTool '--stage' $mirror '--allow-any-dir' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Fail "release payload mirror staging failed: $stageJson" }
  $stageResult = $stageJson.Trim() | ConvertFrom-Json
  if (-not $stageResult.ok) { Fail "release payload mirror is incomplete: $stageJson" }
  [System.IO.File]::WriteAllText($marker, "internalbeyond-host-build-v1" + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

  $srcTauri = Join-Path $mirror 'src-tauri'
  New-Item -ItemType Directory -Force -Path $srcTauri | Out-Null
  foreach ($file in @('Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json')) {
    Copy-Item -LiteralPath (Join-Path $repo ('src-tauri\' + $file)) -Destination (Join-Path $srcTauri $file) -Force
  }
  $hostIdentifier = 'com.internalbeyond.desktop'
  if ($TestMode) {
    # The real application may be open during the isolated installer smoke.
    # Tauri's single-instance plugin is keyed by this identifier, so a test Host
    # must not forward its launch to the production window or reuse its WebView.
    $hostIdentifier = 'com.internalbeyond.installer-smoke'
    $tauriConfigPath = Join-Path $srcTauri 'tauri.conf.json'
    $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $tauriConfig.identifier = $hostIdentifier
    $tauriConfigJson = $tauriConfig | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($tauriConfigPath, $tauriConfigJson + "`n", (New-Object System.Text.UTF8Encoding($false)))
  }
  foreach ($dir in @('src', 'icons', 'capabilities')) {
    Copy-Item -LiteralPath (Join-Path $repo ('src-tauri\' + $dir)) -Destination (Join-Path $srcTauri $dir) -Recurse -Force
  }

  # Keep compiler metadata out of the host PE and make the build path-independent.
  $previousTarget = $env:CARGO_TARGET_DIR
  $previousFlags = $env:RUSTFLAGS
  try {
    $env:CARGO_TARGET_DIR = Join-Path $mirror 'cargo-target'
    $env:RUSTFLAGS = '-C strip=debuginfo --remap-path-prefix=E:\InternalBeyond-main=.'
    $args = @('build', '--release', '--features', 'custom-protocol', '--locked', '--manifest-path', $cargoManifest)
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $cargo.Source @args *> $cargoLog
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
  } finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    $env:RUSTFLAGS = $previousFlags
  }
  if ($code -ne 0) { Fail "cargo host build failed (exit $code); log: $cargoLog" }
  if (-not (Test-Path -LiteralPath $hostSource)) { Fail "cargo build succeeded but host executable is missing: $hostSource" }

  $item = Get-Item -LiteralPath $hostSource
  $peVersion = [regex]::Match([string]$item.VersionInfo.ProductVersion, '\d+\.\d+\.\d+')
  if (-not $peVersion.Success) { Fail "host PE ProductVersion is unreadable: $($item.VersionInfo.ProductVersion)" }
  if ($peVersion.Value -ne $Version) { Fail "host PE ProductVersion $($peVersion.Value) does not match root VERSION $Version" }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
  Copy-Item -LiteralPath $hostSource -Destination $output -Force
  $staged = Get-Item -LiteralPath $output
  $sha = Get-Sha256 $output

  try { Remove-Item -LiteralPath $cargoLog -Force -ErrorAction Stop } catch { }
  $result = [ordered]@{
    ok = $true
    source = 'src-tauri/Cargo.toml + src-tauri/src'
    staged = $output
    version = $peVersion.Value
    bytes = [int64]$staged.Length
    sha256 = $sha
    identifier = $hostIdentifier
    testMode = ($TestMode -eq $true)
    build = 'cargo build --release --features custom-protocol --locked --manifest-path src-tauri/Cargo.toml'
    buildMirror = $mirror
    targetInternalsInstalled = $false
    tauriUpInstalled = $false
    tauriFrontendInstalled = $false
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
} finally {
  if ($mirrorOwned -and (Test-Path -LiteralPath $mirror)) {
    try { Remove-Item -LiteralPath $mirror -Recurse -Force -ErrorAction Stop } catch { }
  }
}
