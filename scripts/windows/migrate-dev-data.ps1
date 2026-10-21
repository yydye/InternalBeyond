param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$LegacyLocalAppData = $env:LOCALAPPDATA
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-NotReparsePoint([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to traverse a reparse point: $Path"
  }
}

function Get-TreeInventory([string]$Root) {
  Assert-NotReparsePoint $Root
  $directories = [Collections.Generic.Stack[string]]::new()
  $manifest = [Collections.Generic.List[string]]::new()
  $directories.Push($Root)
  [long]$files = 0
  [long]$bytes = 0
  while ($directories.Count -gt 0) {
    $current = $directories.Pop()
    foreach ($entry in Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to copy a reparse point inside Dev data: $($entry.FullName)"
      }
      if ($entry.PSIsContainer) { $directories.Push($entry.FullName) }
      else {
        $files++
        $bytes += [long]$entry.Length
        $relative = $entry.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
        $manifest.Add($relative + "`t" + [string]$entry.Length)
      }
    }
  }
  $manifestArray = $manifest.ToArray()
  [Array]::Sort($manifestArray, [StringComparer]::OrdinalIgnoreCase)
  $manifestBytes = [Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $manifestArray))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $manifestHash = ([BitConverter]::ToString($sha.ComputeHash($manifestBytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return [pscustomobject]@{ Files = $files; Bytes = $bytes; ManifestHash = $manifestHash }
}

function Add-RecordedProcess([Collections.Generic.List[object]]$Records, $ProcessIdValue, $StartedAtMs) {
  if ($ProcessIdValue -and $StartedAtMs) { $Records.Add(@{ Pid = [int]$ProcessIdValue; StartedAtMs = [long]$StartedAtMs }) }
}

function Test-RecordedProcess([int]$ProcessIdValue, [long]$StartedAtMs) {
  if ($ProcessIdValue -le 0 -or $StartedAtMs -le 0) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessIdValue" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $created = ([DateTime]$process.CreationDate).ToUniversalTime()
  $actualStartedAtMs = ([DateTimeOffset]$created).ToUnixTimeMilliseconds()
  return [math]::Abs($actualStartedAtMs - $StartedAtMs) -le 20000
}

function Assert-LegacySandboxStopped([string]$SandboxRoot) {
  $launcherStatePath = Join-Path $SandboxRoot 'launcher-state.json'
  $hostRecordPath = Join-Path (Join-Path $SandboxRoot 'host') 'tauri-service-supervisor.json'
  $pidRecords = [Collections.Generic.List[object]]::new()
  if (Test-Path -LiteralPath $launcherStatePath) {
    $state = Get-Content -LiteralPath $launcherStatePath -Raw | ConvertFrom-Json
    Add-RecordedProcess $pidRecords $state.childPid $state.childStartedAtMs
    Add-RecordedProcess $pidRecords $state.staticPid $state.staticStartedAtMs
    Add-RecordedProcess $pidRecords $state.dshP0Pid $state.dshP0StartedAtMs
    foreach ($port in @($state.ports.PSObject.Properties | ForEach-Object { [int]$_.Value } | Where-Object { $_ -ge 1 -and $_ -le 65535 })) {
      $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($listener) { throw "Legacy Dev port $port is still listening; stop its owner before migration." }
    }
  }
  if (Test-Path -LiteralPath $hostRecordPath) {
    $record = Get-Content -LiteralPath $hostRecordPath -Raw | ConvertFrom-Json
    Add-RecordedProcess $pidRecords $record.hostPid $record.hostStartedAtMs
    foreach ($service in @($record.status.services)) {
      if ($service.spawnedByHost -eq $true) {
        Add-RecordedProcess $pidRecords $service.pid $service.startedAtMs
      }
      $port = [int]$service.port
      if ($port -ge 1 -and $port -le 65535) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) { throw "Legacy Host service port $port is still listening; stop its owner before migration." }
      }
    }
  }
  foreach ($entry in $pidRecords) {
    if (Test-RecordedProcess $entry.Pid $entry.StartedAtMs) {
      throw "Legacy Dev process PID $($entry.Pid) is still live; migration made no changes."
    }
  }
  $target = Join-Path $SandboxRoot 'cargo-target'
  $targetPrefix = ($target.TrimEnd('\') + '\')
  $buildProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(cargo|rustc|link|lld-link|cl|mspdbsrv)\.exe$' -and
    ((($_.ExecutablePath -as [string]).StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) -or
     (($_.CommandLine -as [string]).IndexOf($targetPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0))
  }
  if ($buildProcesses) { throw 'A Cargo/Rust linker process is still using the legacy target; migration made no changes.' }
}

if (-not $LegacyLocalAppData) { throw 'LOCALAPPDATA is required to locate the legacy Dev data.' }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$LegacyLocalAppData = [IO.Path]::GetFullPath($LegacyLocalAppData)
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'runtime\ib-dev-launcher.js') -PathType Leaf)) {
  throw 'ProjectRoot does not contain the InternalBeyond Dev Launcher.'
}
$legacyBase = Join-Path $LegacyLocalAppData 'InternalBeyond'
$destinationBase = Join-Path $ProjectRoot '.dev-data'
if ((Test-Path -LiteralPath $destinationBase) -and ((Get-Item -LiteralPath $destinationBase -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The destination .dev-data directory is a reparse point; no data was copied.'
}

$migrations = @(
  @{ Name = 'development'; Source = Join-Path $legacyBase 'dev-sandbox' },
  @{ Name = 'synthetic'; Source = Join-Path (Join-Path $legacyBase 'dev-synthetic') 'dev-sandbox' }
)
$pending = @($migrations | Where-Object { Test-Path -LiteralPath $_.Source })
foreach ($migration in $pending) { Assert-LegacySandboxStopped $migration.Source }

$stageRoot = Join-Path $destinationBase ('.migration-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
try {
  foreach ($migration in $pending) {
    $target = Join-Path $destinationBase (Join-Path $migration.Name 'dev-sandbox')
    $sourceInventory = Get-TreeInventory $migration.Source
    if (Test-Path -LiteralPath $target) {
      $targetInventory = Get-TreeInventory $target
      if (($sourceInventory.Files -ne $targetInventory.Files) -or ($sourceInventory.Bytes -ne $targetInventory.Bytes) -or ($sourceInventory.ManifestHash -ne $targetInventory.ManifestHash)) {
        throw "Destination already exists and differs for $($migration.Name); no source data was deleted."
      }
      Write-Output ("Already migrated: {0}; files={1}; bytes={2}" -f $migration.Name, $sourceInventory.Files, $sourceInventory.Bytes)
      continue
    }

    $stageTarget = Join-Path (Join-Path $stageRoot $migration.Name) 'dev-sandbox'
    New-Item -ItemType Directory -Path (Split-Path -Parent $stageTarget) -Force | Out-Null
    & robocopy.exe $migration.Source $stageTarget /E /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
    $robocopyCode = $LASTEXITCODE
    if ($robocopyCode -ge 8) { throw "Robocopy failed for $($migration.Name) (code=$robocopyCode). Source data remains intact." }
    $stageInventory = Get-TreeInventory $stageTarget
    if (($sourceInventory.Files -ne $stageInventory.Files) -or ($sourceInventory.Bytes -ne $stageInventory.Bytes) -or ($sourceInventory.ManifestHash -ne $stageInventory.ManifestHash)) {
      throw "Copy verification failed for $($migration.Name); source data remains intact at $($migration.Source)."
    }
    $targetParent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    Assert-NotReparsePoint $targetParent
    if (Test-Path -LiteralPath $target) { throw "Destination appeared during migration for $($migration.Name); source data remains intact." }
    Move-Item -LiteralPath $stageTarget -Destination $target
    Write-Output ("Copied and verified: {0}; files={1}; bytes={2}; legacy source retained" -f $migration.Name, $sourceInventory.Files, $sourceInventory.Bytes)
  }
}
finally {
  foreach ($migration in $migrations) {
    $emptyModeStage = Join-Path $stageRoot $migration.Name
    if (Test-Path -LiteralPath $emptyModeStage) {
      $children = Get-ChildItem -LiteralPath $emptyModeStage -Force
      if (-not $children) { Remove-Item -LiteralPath $emptyModeStage -Force }
    }
  }
  if (Test-Path -LiteralPath $stageRoot) {
    $children = Get-ChildItem -LiteralPath $stageRoot -Force
    if (-not $children) { Remove-Item -LiteralPath $stageRoot -Force }
  }
}

Write-Output "Legacy data was copied to $destinationBase; the C: source directories were not removed."
