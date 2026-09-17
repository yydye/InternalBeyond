'use strict';

/*
 * Shared fixture helpers for the Release Builder test suites.
 *
 * Builds a THROWAWAY InternalBeyond-shaped checkout in a temp directory:
 *   · the REAL canonical modules are copied in, so every contract assertion
 *     exercises the repository's own code (no second implementation anywhere);
 *   · the REAL payload whitelist is copied in, because CHECK resolves it;
 *   · the canonical build script is replaced by a committed STUB that accepts
 *     exactly the arguments the real one documents and produces what a real
 *     build produces for these purposes: a versioned exe, SHA256SUMS.txt and a
 *     manifest written by the canonical module.
 *
 * No test in these suites installs anything, opens a browser, contacts the
 * network, or touches the real repository's dist/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TOOL = path.resolve(__dirname, '..');
const REAL_REPO = path.resolve(TOOL, '..', '..');

/* Files copied verbatim from the repository (real authorities). */
const REAL_FILES = [
  'runtime/product-version.js',
  'runtime/update-manifest.js',
  'runtime/pe-version.js',
  'runtime/update-transport.js',
  'runtime/update-check.js',
  'runtime/update-install.js',
  'scripts/release-manifest.js',
  'scripts/release-audit.js',
  'installer/runtime-pin.json',
  'installer/InternalBeyond.iss',
  'installer/languages/ChineseSimplified.isl',
  'installer/tools/ib-stop.js',
  'LICENSE',
  'LICENSES/THIRD-PARTY-NODE.md'
];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(f) { return sha256(fs.readFileSync(f)); }

/*
 * Remove a tree, retrying briefly, and REPORT whether it worked.
 *
 * Windows keeps a handle on files a git child process has just written (the bare
 * "origin" a fixture pushes to is the realistic case), so a single rmSync is
 * flaky. `maxRetries` plus a few attempts is enough, and the boolean return
 * means the suites can assert that nothing was left behind instead of the
 * failure being swallowed.
 */
function rmrf(p) {
  for (let i = 0; i < 6; i++) {
    try {
      if (!fs.existsSync(p)) return true;
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
      if (!fs.existsSync(p)) return true;
    } catch (e) { /* retry */ }
    const until = Date.now() + 150;
    while (Date.now() < until) { /* brief pause without a timer dependency */ }
  }
  return !fs.existsSync(p);
}

/*
 * A REAL PE image with a version resource.
 *
 * The canonical reader (runtime/pe-version.js) is strict: MZ, a PE header, a
 * section, an RT_VERSION resource with the VS_FIXEDFILEINFO signature, a string
 * table and a fixed version, all consistent. Hand-writing that byte layout in
 * the fixture would be a second implementation of a format the reader already
 * owns — and, worse, one that could be wrong in exactly the way the reader is
 * wrong. So the fixture asks the platform for a real image instead: it compiles
 * a three-line C# program with the .NET Framework compiler that ships with
 * Windows and sets the assembly version attributes. The result is a genuine
 * executable whose version resource the canonical reader verifies directly.
 *
 * Compiled images are cached per version under %TEMP%\ib-rb-pe-cache, so the
 * compiler runs at most once per version per machine. Padded with a filler tail
 * so the artifact clears the canonical MIN_PLAUSIBLE_INSTALLER_BYTES bound.
 */

const PE_CACHE = path.join(os.tmpdir(), 'ib-rb-pe-cache');
/* Just over the canonical MIN_PLAUSIBLE_INSTALLER_BYTES floor (8 MiB), so the
   fixture stays small and fast while still exercising the real bound. */
const PE_PAD_BYTES = 9 * 1024 * 1024;

function cscPath() {
  const roots = [process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'];
  const candidates = [];
  for (const r of roots) {
    candidates.push(path.join(r, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
    candidates.push(path.join(r, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'));
  }
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* next */ } }
  return '';
}

function compilePe(version, outFile) {
  const csc = cscPath();
  if (!csc) throw new Error('no .NET Framework C# compiler found; the PE fixture cannot be produced');
  const dir = path.dirname(outFile);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'stub.cs');
  fs.writeFileSync(src,
    'using System.Reflection;\n' +
    '[assembly: AssemblyVersion("' + version + '.0")]\n' +
    '[assembly: AssemblyFileVersion("' + version + '.0")]\n' +
    '[assembly: AssemblyProduct("InternalBeyond")]\n' +
    '[assembly: AssemblyInformationalVersion("' + version + '")]\n' +
    'class IBReleaseFixtureStub { static void Main() { } }\n', 'utf8');
  const r = execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/out:' + outFile, src],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  void r;
  if (!fs.existsSync(outFile)) throw new Error('the C# compiler produced no output: ' + outFile);
  return outFile;
}

/*
 * buildPeWithVersion(version) → Buffer (cached on disk, padded to a plausible
 * installer size). Deterministic for a given machine and version.
 */
function buildPeWithVersion(version) {
  fs.mkdirSync(PE_CACHE, { recursive: true });
  const exe = path.join(PE_CACHE, 'ib-stub-' + version + '.exe');
  const bin = path.join(PE_CACHE, 'ib-stub-' + version + '.bin');
  if (!fs.existsSync(bin)) {
    if (!fs.existsSync(exe)) compilePe(version, exe);
    const body = fs.readFileSync(exe);
    const pad = Buffer.alloc(Math.max(0, PE_PAD_BYTES - body.length), 0x42);
    fs.writeFileSync(bin, Buffer.concat([body, pad]));
  }
  return fs.readFileSync(bin);
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(f) { return sha256(fs.readFileSync(f)); }


/* The committed stub build script. Accepts the canonical arguments. */
const STUB_PS1 = `#Requires -Version 5.1
<#
  Test stub for scripts/build-installer.ps1.
  Accepts the same arguments as the canonical build and produces the same three
  artifacts, so the Release Builder can be exercised end to end without ISCC.
  FAULT=<name> makes it produce a specifically broken result.
#>
[CmdletBinding()]
param(
  [string]$IsccPath = '', [string]$ReleasedAt = '', [string]$NotesFile = '',
  [string]$MinimumVersion = '', [switch]$InstallAudit, [switch]$SkipInstallAudit,
  [switch]$KeepStaging, [switch]$SkipAudit,
  [string]$FixtureRoot = '', [string]$Fault = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo 'dist'
$version = (Get-Content -LiteralPath (Join-Path $repo 'VERSION') -Raw -Encoding UTF8).Trim()
if ($version -notmatch '^\\d+\\.\\d+\\.\\d+$') { Write-Host "[FAIL @ preflight] bad VERSION"; exit 1 }
New-Item -ItemType Directory -Path $dist -Force | Out-Null

if ($Fault -eq 'build-exit-1') { Write-Host "[FAIL @ compile] injected failure"; exit 1 }
if ($Fault -eq 'no-manifest') { $skipManifest = $true }

$exeName = "InternalBeyond-Setup-$version.exe"
$exe = Join-Path $dist $exeName
if ($Fault -ne 'no-artifact') {
  Copy-Item -LiteralPath (Join-Path $repo 'fixture-payload.bin') -Destination $exe -Force
}

if ($Fault -eq 'tiny-artifact') {
  [System.IO.File]::WriteAllBytes($exe, (New-Object byte[] 1024))
}
if ($Fault -eq 'pe-version' -and (Test-Path -LiteralPath $exe)) {
  # A real PE image whose version resource says 0.0.1 while VERSION says
  # otherwise: the "bytes are fine but the version is wrong" case.
  if (Test-Path -LiteralPath (Join-Path $repo 'fixture-payload-wrong.bin')) {
    Copy-Item -LiteralPath (Join-Path $repo 'fixture-payload-wrong.bin') -Destination $exe -Force
  }
}

$sha = [System.Security.Cryptography.SHA256]::Create()
if (Test-Path -LiteralPath $exe) {
  $stream = [System.IO.File]::OpenRead($exe)
  try { $hash = $sha.ComputeHash($stream) } finally { $stream.Dispose() }
  $hex = ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  $bytes = (Get-Item -LiteralPath $exe).Length
} else {
  # no-artifact: the build reports success but produces nothing on disk. This is
  # the exact hazard the builder must refuse to believe.
  $hex = ('0' * 64)
  $bytes = 0
}
if ($Fault -eq 'sums-stale') { $hex = ('0' * 64) }

$lines = @(
  '# InternalBeyond release checksums',
  "# product version : $version",
  "# built (local)   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
  "$hex *$exeName"
)
$lines | Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ASCII

if (-not $skipManifest) {
  $node = Join-Path $repo 'runtime\\node\\node.exe'
  if (-not (Test-Path -LiteralPath $node)) { $node = $null }
  $manifestArgs = @(
    (Join-Path $repo 'runtime\\update-manifest.js'), '--write', (Join-Path $dist 'update-stable.json'),
    '--version', $version, '--sha256', $hex, '--sizeBytes', [string]$bytes, '--productVersion', $version
  )
  if ($MinimumVersion -ne '') { $manifestArgs += @('--minimumVersion', $MinimumVersion) }
  if ($NotesFile -ne '' -and (Test-Path -LiteralPath $NotesFile)) { $manifestArgs += @('--notesFile', $NotesFile) }
  $minPlausible = 8 * 1024 * 1024
  if ($node -and (Test-Path -LiteralPath $exe) -and $bytes -ge $minPlausible) {
    Write-Host "     ..   manifest via the canonical writer (bundled runtime)"
    & $node @manifestArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL @ update manifest] manifest failed"; exit 1 }
  } else {
    Write-Host "     ..   manifest via the fixture fallback writer (node=$node exe=$exe bytes=$bytes)"
    $manifestPath = Join-Path $dist 'update-stable.json'
    $obj = [ordered]@{
      schema = 'internalbeyond.update'; schemaVersion = 1; channel = 'stable'; version = $version
      installer = [ordered]@{
        url = "https://github.com/yydye/InternalBeyond/releases/download/v$version/InternalBeyond-Setup-$version.exe"
        sha256 = $hex; sizeBytes = [int]$bytes; productVersion = $version
      }
    }
    if ($MinimumVersion -ne '') { $obj.minimumVersion = $MinimumVersion }
    if ($NotesFile -ne '' -and (Test-Path -LiteralPath $NotesFile)) {
      $obj.notes = ((Get-Content -LiteralPath $NotesFile -Raw -Encoding UTF8) -replace '^\\uFEFF', '').Trim()
    }
    [System.IO.File]::WriteAllText($manifestPath, (($obj | ConvertTo-Json -Depth 5) + "\`n"), (New-Object System.Text.UTF8Encoding($false)))
  }
  if ($Fault -eq 'manifest-version') {
    $p = Join-Path $dist 'update-stable.json'
    $pattern = '"version": "' + $version + '"'
    $t = (Get-Content -LiteralPath $p -Raw -Encoding UTF8) -replace $pattern, '"version": "0.0.1"'
    if ($t -notmatch '0\.0\.1') { Write-Host "[FAIL @ update manifest] the manifest-version fault did not apply (pattern=$pattern)" ; exit 1 }
    [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
  }
  if ($Fault -eq 'manifest-sha') {
    $p = Join-Path $dist 'update-stable.json'
    $t = (Get-Content -LiteralPath $p -Raw -Encoding UTF8) -replace $hex, ('a' * 64)
    [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
  }
  if ($Fault -eq 'manifest-channel') {
    $p = Join-Path $dist 'update-stable.json'
    $t = (Get-Content -LiteralPath $p -Raw -Encoding UTF8) -replace '"channel": "stable"', '"channel": "beta"'
    [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
  }
}
Write-Host "  InternalBeyond release build complete (stub)"
exit 0
`;

/*
 * create({ version, target, notes, withReleaseNotes, gitInit, extraFiles })
 * Returns { dir, dispose() }.
 */
function create(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-rb-'));
  /* The bare "origin" this fixture pushes to (when one is created), so that
     dispose() removes the whole footprint and not just the checkout. */
  let remoteDir = '';
  const mk = function (rel, content) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return abs;
  };

  for (const rel of REAL_FILES) {
    const src = path.join(REAL_REPO, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  const version = o.version || '1.0.5';
  mk('VERSION', version + '\n');
  mk('README.md', '# InternalBeyond\n\n`Windows 10+` · 当前版本 **' + version + '** · 免管理员权限\n\n' +
    '**非官方二次开发版 / unofficial derivative**\n\n' +
    '正式发行文件：`InternalBeyond-Setup-<版本号>.exe`\n\n' +
    '## 关于本仓库 / About this fork\n\n上游署名说明。\n');
  /* The stub build script is written WITH a UTF-8 BOM, exactly like the real
     scripts/build-installer.ps1: Windows PowerShell 5.1 reads a BOM-less file
     as ANSI, so a BOM-less Chinese .ps1 is a syntax error. Same quirk, same
     rule, different writer. */
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'build-installer.ps1'),
    Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(STUB_PS1, 'utf8')]));
  mk('docs/RELEASE.md', '# release contract\n');
  mk('docs/release-notes/' + version + '.md', 'InternalBeyond ' + version + '\n\n上一版的发行说明。\n');
  if ((o.target || version) !== version) {
    mk('docs/release-notes/' + o.target + '.md', o.notes || ('InternalBeyond ' + o.target + '\n\n本版修复若干问题。\n'));
  }
  mk('runtime/node/VERSION', '24.18.0\n');
  mk('runtime/node/SHA256SUMS', '0'.repeat(64) + ' *node.exe\n');
  mk('runtime/node/LICENSE', 'node license stub\n');
  mk('runtime/node/README.md', 'node runtime stub\n');

  /*
   * The bundled runtime.
   *
   * By DEFAULT the fixture does NOT copy the real runtime\node\node.exe: that
   * file is ~100 MB and every fixture would copy it, turning a suite of fifteen
   * fixtures into ~1.5 GB of pointless I/O. Instead it installs a synthetic REAL
   * PE whose version resource equals the pinned runtime version, so the
   * three-way runtime gate (pin === SHA256SUMS === file bytes) genuinely passes
   * and the only thing that differs from production is what `node.exe` IS.
   *
   * The stub build then uses its own manifest writer — and it says so on stdout,
   * so nothing is hidden. IB_RB_USE_REAL_NODE=1 copies the real runtime instead,
   * which additionally exercises the path where the canonical manifest writer
   * (runtime/update-manifest.js, run by the bundled Node) produces the manifest.
   */
  const REAL_NODE = path.join(REAL_REPO, 'runtime', 'node', 'node.exe');
  const nodeFile = path.join(dir, 'runtime', 'node', 'node.exe');
  const pinFile = path.join(dir, 'installer/runtime-pin.json');
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  const wantRealNode = process.env.IB_RB_USE_REAL_NODE === '1' && fs.existsSync(REAL_NODE);
  if (wantRealNode) {
    fs.copyFileSync(REAL_NODE, nodeFile);
    fs.writeFileSync(path.join(dir, 'runtime/node/VERSION'), pin.runtime.version + '\n');
  } else {
    const want = String(pin.runtime.version).replace(/^v/, '').split('.');
    const synthetic = want.length === 3 ? want.join('.') : '24.18.0';
    fs.writeFileSync(nodeFile, buildPeWithVersion(synthetic));
    fs.writeFileSync(path.join(dir, 'runtime/node/VERSION'), synthetic + '\n');
  }

  /* Payload sources the real whitelist resolves. */
  mk('InternalBeyond.html', '<!DOCTYPE html><html><body>IB</body></html>');
  mk('assets/js/app.js', '/* app */');
  mk('assets/images/bg.jpg', 'img');
  mk('apps/catalog.json', '{"apps":[]}');
  mk('game/game_story.js', '/* game */');
  mk('bridge/bridge.js', '/* bridge */');
  mk('active/active.js', '/* active */');
  mk('services/internal-beyond-server.js', '/* server */');
  mk('services/ib-bridge-service.js', '/* bridge svc */');
  mk('services/active-message-service.js', '/* active svc */');
  mk('services/home-node-service.js', '/* home node */');
  mk('services/home-node/chat.js', '/* chat */');
  mk('runtime/boot-state.js', '/* boot */');
  mk('runtime/component-registry.js', '/* registry */');
  mk('runtime/component-supervisor.js', '/* supervisor */');
  mk('runtime/db-failure.js', '/* dbf */');
  mk('runtime/launch-internal-beyond.js', '/* launch */');
  mk('runtime/local-services-runner.js', '/* runner */');
  mk('runtime/service-control.js', '/* control */');
  mk('runtime/component-lifecycle.js', '/* lifecycle */');
  mk('启动 InternalBeyond.vbs', 'WScript.Quit 0');
  mk('docs/TROUBLESHOOTING.md', '# troubleshooting\n');
  mk('docs/guide/annotations.json', '{}');
  mk('docs/guide/shots/a.png', 'png');
  mk('tests/test_update_manifest.js', '/* test */');
  mk('tests/test_update_check.js', '/* test */');
  mk('tests/test_update_install.js', '/* test */');
  mk('tests/test_pe_version.js', '/* test */');
  mk('tests/test_installer.js', '/* test */');

  /* The artifact the stub build copies. Real PE bytes with a version resource. */
  const exeVersion = o.artifactVersion || (o.target || version);
  const pe = buildPeWithVersion(exeVersion);
  fs.writeFileSync(path.join(dir, 'fixture-payload.bin'), pe);
  /* A second real PE whose version resource is deliberately wrong, for the
     "right bytes, wrong version" counterproof. */
  fs.writeFileSync(path.join(dir, 'fixture-payload-wrong.bin'), buildPeWithVersion('0.0.1'));

  /* The bundled runtime pin must agree with whatever runtime the fixture holds:
     pin.sha256 === runtime\node\SHA256SUMS === sha256(node.exe), exactly the
     three-way agreement canonical step 2 enforces. */
  const nodeHash = sha256File(nodeFile);
  pin.runtime.sha256 = nodeHash;
  fs.writeFileSync(path.join(dir, 'installer/runtime-pin.json'), JSON.stringify(pin, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'runtime/node/SHA256SUMS'), nodeHash + ' *node.exe\n');
  /* NOTE: with the synthetic node.exe, `node --version` fails (it is a PE, not a
     Node runtime), so CHECK reports the runtime probe as a WARNING. That is the
     honest reading: the tool cannot prove this file is a working runtime, and it
     says so. The canonical build's own step 2 is the hard gate. */

  if (o.gitInit !== false) {
    const run = function (args, cwd) {
      try {
        execFileSync('git', args, { cwd: cwd || dir, stdio: 'ignore', windowsHide: true, shell: false });
      } catch (e) { /* a missing git is reported by CHECK, not by the fixture */ }
    };
    run(['init', '-q']);
    run(['config', 'user.email', 'fixture@example.com']);
    run(['config', 'user.name', 'Fixture']);
    run(['config', 'commit.gpgsign', 'false']);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'fixture baseline']);

    /*
     * A local bare "origin" with master pushed to it. This is what makes the
     * fixture a realistic publish target: `origin/master` exists, the local
     * branch is compared against it, and lib/publish.js finds a real remote URL.
     * It lives in %TEMP% too, so nothing can reach the network — and it is
     * removed together with the checkout (see `remoteDir` below).
     */
    if (o.gitRemote !== false) {
      const remote = path.join(os.tmpdir(), 'ib-rb-origin-' + path.basename(dir) + '.git');
      remoteDir = remote;
      try {
        fs.mkdirSync(remote, { recursive: true });
        run(['init', '--bare', '-q'], remote);
        run(['remote', 'add', 'origin', remote]);
        run(['push', '-q', '-u', 'origin', 'master']);
      } catch (e) { /* a missing remote only downgrades the Git checks to warnings */ }
    }
  }

  return {
    dir: dir,
    remoteDir: remoteDir,
    version: version,
    target: o.target || version,
    dispose: function () {
      rmrf(dir);
      if (remoteDir) rmrf(remoteDir);
    }
  };}

module.exports = { create, buildPeWithVersion, sha256, sha256File, rmrf, TOOL, REAL_REPO, STUB_PS1 };
