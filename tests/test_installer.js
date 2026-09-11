'use strict';

/* P7 · Windows installer / release packaging — static contract tests.
   No installer run, no browser, zero deps. Covers:

     [1] single release version source (VERSION → installer / Guide / Diagnostics)
     [2] bundled Node runtime pin (24.18.0 + SHA-256) enforced by the build
     [3] release whitelist manifest: required files in, forbidden paths out
     [4] Inno Setup contract: per-user, no UAC, no console, single entry point,
         license page, graceful stop wiring, user data never deleted
     [5] stop helper: IB-specific matching, never image-name matching
     [6] static server hardening (.git / logs / hidden / traversal) + graceful stop
     [7] runner control plane graceful stop
     [8] audit rules self-test (planted secrets / stale release claims MUST fail)
     [9] README install section: one entry point + honest SmartScreen guidance

   Run: node test_installer.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));
const audit = require(path.join(ROOT, 'scripts', 'release-audit.js'));
const productVersion = require(path.join(ROOT, 'runtime', 'product-version.js'));
const ibStop = require(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'));

let pass = 0, fail = 0, skip = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
function skipped(name, why) { skip++; console.log('  – ' + name + ' (SKIP: ' + why + ')'); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

const VERSION_FILE = path.join(ROOT, 'VERSION');
const ISS = path.join(ROOT, 'installer', 'InternalBeyond.iss');
const PIN = path.join(ROOT, 'installer', 'runtime-pin.json');
const BUILD_PS1 = path.join(ROOT, 'scripts', 'build-installer.ps1');
const ISS_SRC = read(ISS);
const PIN_JSON = JSON.parse(read(PIN));
const BUILD_SRC = read(BUILD_PS1);
const README = read(path.join(ROOT, 'README.md'));

console.log('Windows installer / release packaging contract (P7)\n');

/* ── [1] single release version source ─────────────────────────────────── */
console.log('[1] single release version source');

check('VERSION is a single-line MAJOR.MINOR.PATCH', () => {
  assert.ok(fs.existsSync(VERSION_FILE), 'VERSION missing');
  const raw = read(VERSION_FILE);
  assert.match(raw, /^\d+\.\d+\.\d+$/, 'VERSION must be exactly x.y.z with no newline, got ' + JSON.stringify(raw));
});

check('product-version.js is the only Node-side parser', () => {
  const v = productVersion.read();
  assert.strictEqual(v.ok, true, 'VERSION unreadable: ' + v.error);
  assert.strictEqual(v.source, 'VERSION');
  assert.strictEqual(v.guide, v.major + '.' + v.minor, 'guide version must be MAJOR.MINOR');
  assert.strictEqual(productVersion.parse('1.2.3').guide, '1.2');
  assert.strictEqual(productVersion.parse('1.2'), null, 'must reject non-semver');
  assert.strictEqual(productVersion.parse('1.2.3.4'), null, 'must reject 4-part versions');
});

check('installer gets its version from the build script, never a literal', () => {
  assert.ok(/#error AppVersion is not defined/.test(ISS_SRC), '.iss must fail loudly without /DAppVersion');
  assert.ok(!/AppVersion\s*=\s*"\d/.test(ISS_SRC), '.iss must not hard-code a version literal');
  assert.ok(/VersionInfoVersion=\{#[A-Za-z]+\}\.0/.test(ISS_SRC) || /VersionInfoVersion=\{#[A-Za-z]+\}/.test(ISS_SRC),
    'VersionInfoVersion must come from the define');
  assert.ok(/OutputBaseFilename=\{#[A-Za-z]+\}-Setup-\{#[A-Za-z]+\}/.test(ISS_SRC),
    'installer file name must be built from the version define');
});

check('build script reads VERSION and passes it to ISCC', () => {
  assert.ok(/Get-Content -LiteralPath \$versionFile -Raw/.test(BUILD_SRC), 'must read VERSION');
  assert.ok(/\/DAppVersion=\$version/.test(BUILD_SRC), 'must pass /DAppVersion');
  assert.ok(!/\$version\s*=\s*'\d/.test(BUILD_SRC), 'must not hard-code the product version');
});

check('Guide version derives from the same source', () => {
  const ann = JSON.parse(read(path.join(ROOT, 'docs', 'guide', 'annotations.json')));
  const pv = productVersion.read();
  assert.strictEqual(String(ann.guideVersion), pv.guide,
    'annotations.guideVersion must equal MAJOR.MINOR of VERSION');
  const js = read(path.join(ROOT, 'assets', 'js', 'guide-beginner.js'));
  assert.ok(js.indexOf("VERSION_FALLBACK = '" + ann.guideVersion + "'") !== -1,
    'guide fallback must match the manifest version');
  assert.ok(/IB_GUIDE_VERSION/.test(js), 'guide must accept a host-injected product version');
  assert.ok(/ibv=/.test(js), 'guide must read the product version from the launcher-supplied URL parameter');
  assert.ok(!/\bfetch\s*\(/.test(js), 'guide must not fetch anything (P6 no-network contract)');
  const launcher = read(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'));
  assert.ok(/uiUrl\(\)/.test(launcher) && /ibv=/.test(launcher), 'launcher must pass the product version to the UI');
});

check('server + launcher + diagnostics expose the same version', () => {
  const server = read(path.join(ROOT, 'services', 'internal-beyond-server.js'));
  assert.ok(/require\('\.\.\/runtime\/product-version\.js'\)/.test(server), 'server must use product-version.js');
  assert.ok(/server:\s*identity,\s*version:/.test(server), '/health must report the product version');
  const launcher = read(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'));
  assert.ok(/require\('\.\/product-version\.js'\)/.test(launcher), 'launcher must use product-version.js');
  assert.ok(/product:\s*productInfo\(\)/.test(launcher), 'boot-state must record product version');
  const boot = read(path.join(ROOT, 'runtime', 'boot-state.js'));
  assert.ok(/product:\s*\{/.test(boot), 'boot-state schema must carry product version');
  const diag = read(path.join(ROOT, 'assets', 'js', 'diagnostics.js'));
  assert.ok(/launcher && b\.state\.launcher\.product|launcher\.product/.test(diag), 'diagnostics must show the product version');
});

/* ── [2] bundled runtime pin ───────────────────────────────────────────── */
console.log('\n[2] bundled Node runtime pin');

check('runtime pin records exact version + SHA-256 + provenance', () => {
  assert.strictEqual(PIN_JSON.runtime.version, '24.18.0', 'pinned runtime must be 24.18.0');
  assert.match(PIN_JSON.runtime.sha256, /^[0-9a-f]{64}$/, 'pin must record a SHA-256');
  assert.strictEqual(PIN_JSON.runtime.platform, 'win-x64');
  assert.ok(/^https:\/\/nodejs\.org\/dist\/v24\.18\.0\//.test(PIN_JSON.runtime.source), 'pin must record the upstream URL');
  assert.strictEqual(PIN_JSON.runtime.metadata.noticeFile, 'LICENSES/THIRD-PARTY-NODE.md');
});

check('pin agrees with the committed runtime metadata', () => {
  const v = read(path.join(ROOT, 'runtime', 'node', 'VERSION')).trim();
  assert.strictEqual(v, PIN_JSON.runtime.version, 'runtime/node/VERSION must equal the pin');
  const sums = read(path.join(ROOT, 'runtime', 'node', 'SHA256SUMS'));
  const m = sums.match(/^\s*([0-9a-f]{64})\s+\*?node\.exe\s*$/m);
  assert.ok(m, 'SHA256SUMS must cover node.exe');
  assert.strictEqual(m[1].toLowerCase(), PIN_JSON.runtime.sha256, 'SHA256SUMS must equal the pin');
  const notice = read(path.join(ROOT, 'LICENSES', 'THIRD-PARTY-NODE.md'));
  assert.ok(notice.indexOf(PIN_JSON.runtime.version) >= 0, 'third-party notice must state the bundled version');
});

check('the committed runtime binary matches the pin byte for byte', () => {
  const exe = path.join(ROOT, 'runtime', 'node', 'node.exe');
  assert.ok(fs.existsSync(exe), 'runtime/node/node.exe missing');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  assert.strictEqual(hash, PIN_JSON.runtime.sha256, 'runtime/node/node.exe does not match the pin');
  const v = execFileSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.strictEqual(v, 'v' + PIN_JSON.runtime.version, 'bundled runtime reports ' + v);
});

check('build gate fails hard instead of falling back to system Node', () => {
  assert.ok(/缺少内置运行时 runtime\\node\\node.exe/.test(BUILD_SRC), 'missing runtime must abort the build');
  assert.ok(/Get-FileHash -LiteralPath \$file -Algorithm SHA256/.test(BUILD_SRC), 'must hash node.exe');
  assert.ok(/与钉定值不一致/.test(BUILD_SRC), 'hash mismatch must abort');
  assert.ok(/process\.version/.test(BUILD_SRC), 'must verify process.version');
  assert.ok(!/if \(.*nodeExe.*\)\s*\{\s*\$nodeExe\s*=\s*'node'/.test(BUILD_SRC), 'must not silently use PATH node for the payload');
});

check('the build never installs anything unless explicitly asked', () => {
  assert.ok(/\[switch\]\$InstallAudit/.test(BUILD_SRC), 'install audit must be an explicit switch');
  assert.ok(/elseif \(-not \$InstallAudit\)/.test(BUILD_SRC), 'the default path must skip the install audit');
  assert.ok(/\$smoke '--install-audit'/.test(BUILD_SRC), 'the audit must use the isolated --install-audit mode');
  assert.ok(!/\$smoke '--force'/.test(BUILD_SRC), 'the build must never run the retired full smoke');
});

check('payload carries node.exe plus its metadata and license', () => {
  const files = manifest.resolve({}).files.map(f => f.to);
  for (const need of ['runtime/node/node.exe', 'runtime/node/VERSION', 'runtime/node/SHA256SUMS',
    'runtime/node/LICENSE', 'runtime/node/README.md', 'LICENSES/THIRD-PARTY-NODE.md', 'LICENSE']) {
    assert.ok(files.indexOf(need) >= 0, 'payload must include ' + need);
  }
});

/* ── [3] release whitelist manifest ────────────────────────────────────── */
console.log('\n[3] release whitelist manifest');

const resolved = manifest.resolve({});

check('manifest resolves with no missing or denied entry', () => {
  assert.strictEqual(resolved.missing.length, 0, 'missing sources: ' + JSON.stringify(resolved.missing));
  assert.strictEqual(resolved.denied.length, 0, 'denied paths: ' + JSON.stringify(resolved.denied));
  assert.ok(resolved.count > 100, 'payload looks too small: ' + resolved.count);
});

check('every whitelist entry states why it is shipped', () => {
  for (const e of manifest.ENTRIES) {
    assert.ok(e.why && e.why.length > 4, 'entry without a reason: ' + JSON.stringify(e.from));
  }
});

check('payload contains the full application closure', () => {
  const files = resolved.files.map(f => f.to);
  const set = new Set(files);
  for (const need of ['InternalBeyond.html', 'VERSION', 'runtime/product-version.js', 'runtime/boot-state.js',
    'runtime/update-manifest.js',
    'runtime/launch-internal-beyond.js', 'runtime/local-services-runner.js', 'services/internal-beyond-server.js',
    'services/ib-bridge-service.js', 'services/active-message-service.js', '启动 InternalBeyond.vbs',
    'assets/js/guide-beginner.js', 'assets/css/guide-beginner.css', 'assets/js/diagnostics.js',
    'assets/js/setup-wizard.js', 'assets/js/error-catalog.js', 'assets/js/provider-directory.js',
    'apps/catalog.json', 'assets/images/bg-internal.jpg', 'assets/images/bg-infernal.jpg', 'assets/icons/IB-icon.ico',
    'docs/guide/annotations.json', 'tools/ib-stop.js', 'README.md', 'TROUBLESHOOTING.md']) {
    assert.ok(set.has(need), 'payload missing runtime file: ' + need);
  }
  const shots = files.filter(f => /^docs\/guide\/shots\/.+\.png$/.test(f));
  assert.strictEqual(shots.length, 16, 'guide must ship all 16 screenshots, got ' + shots.length);
  assert.ok(files.some(f => /^assets\/js\//.test(f)), 'assets/js must ship');
  assert.ok(files.some(f => /^game\/game_module\.js$/.test(f)), 'game module must ship');
  assert.ok(files.some(f => /^bridge\//.test(f)) && files.some(f => /^active\//.test(f)), 'bridge/active modules must ship');
});

check('payload excludes dev, private and test material', () => {
  const files = resolved.files.map(f => f.to);
  const forbidden = [
    /(^|\/)\.git(\/|$)/, /(^|\/)logs(\/|$)/, /(^|\/)browser-data(\/|$)/,
    /(^|\/)node_modules(\/|$)/, /(^|\/)scripts(\/|$)/, /(^|\/)vision(\/|$)/,
    /(^|\/)test_[^/]*$/, /^test-all\.js$/, /^scripts_check_html\.js$/,
    /^tmp_ib_probe/, /^docs\/P\d+.*REPORT\.md$/, /\.results\.json$/,
    /^start-[^/]*\.cmd$/, /^Start Internal Beyond\.cmd$/, /^create-desktop-shortcut\.cmd$/,
    /^test-ui\.cmd$/, /^assets\/images\/bg-canvas\.png$/, /^_icon_preview\.png$/,
    /^Gemini_Generated_Image_/, /^game\/portraits\/portrait_\[.*\]\.png$/,
    /^scripts\/capture-guide-shots\.js$/, /^scripts\/guide-fixtures\.js$/, /^scripts\/cdp-lite\.js$/,
    /^installer\/InternalBeyond\.iss$/, /^installer\/languages\//
  ];
  for (const f of files) {
    for (const re of forbidden) assert.ok(!re.test(f), 'forbidden path in payload: ' + f);
  }
  assert.ok(files.indexOf('test_installer.js') < 0, 'test files must never ship');
});

check('manifest deny rules cover the audited leak classes', () => {
  const samples = [
    '.git/config', 'logs/launcher.log', 'browser-data/x/IndexedDB', 'test_bridge.js',
    'docs/P9-REPORT.md', 'tmp_ib_probe.js', 'node_modules/x/y.js', 'vision/main.py',
    'scripts/capture-guide-shots.js', 'start-bridge-service.cmd', 'foo/.env',
    'installer/InternalBeyond.iss', 'x.log', 'y.bak'
  ];
  for (const s of samples) {
    const hit = manifest.DENY_PATH.some(rule => rule.test.test(s));
    assert.ok(hit, 'deny rules must reject: ' + s);
  }
  for (const s of ['assets/js/core.js', 'docs/guide/shots/01-welcome.png', 'runtime/node/node.exe', 'tools/ib-stop.js',
    'runtime/launch-internal-beyond.js', 'services/internal-beyond-server.js', 'assets/images/bg-internal.jpg']) {
    const hit = manifest.DENY_PATH.some(rule => rule.test.test(s));
    assert.ok(!hit, 'deny rules must allow: ' + s);
  }
});

check('staging is guarded against wiping a non-staging directory', () => {
  const bad = manifest.stage(path.join(ROOT, 'assets'), { clean: true });
  assert.strictEqual(bad.ok, false, 'staging must refuse a non-staging target');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'js')), 'refusal must not have deleted anything');
});

/* ── [3b] release contract: build-side wiring (U1) ──────────────────────── */
console.log('\n[3b] update manifest wiring (U1)');

check('build script keeps the UTF-8 BOM PowerShell 5.1 needs', () => {
  /* PowerShell 5.1 decodes a BOM-less file as ANSI, which turns the Chinese
     [FAIL]/Write-Ok messages into mojibake and can break string literals
     outright. The edit tool strips BOMs (docs/TROUBLESHOOTING.md T10), and a
     stripped BOM makes the whole build fail to parse. */
  const raw = fs.readFileSync(path.join(ROOT, 'scripts', 'build-installer.ps1'));
  assert.strictEqual(raw[0], 0xEF, 'build-installer.ps1 must start with a UTF-8 BOM');
  assert.strictEqual(raw[1], 0xBB, 'build-installer.ps1 must start with a UTF-8 BOM');
  assert.strictEqual(raw[2], 0xBF, 'build-installer.ps1 must start with a UTF-8 BOM');
});

check('build produces the manifest from the bytes it just produced', () => {
  assert.ok(/Write-Step '7\/9' 'update manifest'/.test(BUILD_SRC), 'the manifest must be its own numbered step');
  for (const flag of ['--write', '--version', '--sha256', '--sizeBytes', '--productVersion']) {
    assert.ok(BUILD_SRC.indexOf(flag) >= 0, 'build must pass ' + flag + ' to the shared module');
  }
});

check('manifest step runs after the installer hash step', () => {
  const hashAt = BUILD_SRC.indexOf("Write-Step '6/9' 'SHA-256'");
  const manAt = BUILD_SRC.indexOf("Write-Step '7/9' 'update manifest'");
  assert.ok(hashAt > 0 && manAt > hashAt, 'the hash must exist before the manifest can pin it');
});

check('build never hand-writes the download URL', () => {
  assert.ok(BUILD_SRC.indexOf('releases/download') < 0, 'the URL comes from runtime/update-manifest.js');
  assert.ok(BUILD_SRC.indexOf('github.com/yydye') < 0, 'the repository URL belongs to one module only');
});

check('build ties the manifest URL asset name to the file it actually produced', () => {
  /* ISCC's OutputBaseFilename and installerAssetName() are two independent
     spellings; only comparing them against the real output closes the drift. */
  assert.ok(/\$urlAsset/.test(BUILD_SRC), 'must extract the asset segment from the manifest URL');
  assert.ok(/\$urlAsset -ne \$exeItem\.Name/.test(BUILD_SRC), 'must compare it against the built file name');
});

check('build confirms the PE product version before writing the manifest', () => {
  assert.ok(/VersionInfo\.ProductVersion/.test(BUILD_SRC), 'must read ProductVersion back from the exe');
  assert.ok(/PE ProductVersion \(\$peVersion\) 与 VERSION/.test(BUILD_SRC), 'a PE/VERSION mismatch must fail the build');
  assert.ok(/Get-Sha256 \$exe/.test(BUILD_SRC), 'the manifest hash must be the hash of the built exe');
});

check('releasedAt/notes are explicit inputs, never fabricated by the build', () => {
  assert.ok(/\[string\]\$ReleasedAt/.test(BUILD_SRC) && /\[string\]\$NotesFile/.test(BUILD_SRC),
    'both must be explicit build parameters');
  /* The build may print its own local build time inside SHA256SUMS.txt comments,
     but nothing may auto-fill releasedAt (runtime/update-manifest.js has no clock). */
  const manifestCall = BUILD_SRC.slice(BUILD_SRC.indexOf("Write-Step '7/9'"), BUILD_SRC.indexOf("Write-Step '8/9'"));
  assert.ok(!/Get-Date/.test(manifestCall), 'the manifest step must not invent a timestamp');
});

check('build preflight validates the optional release inputs', () => {
  assert.ok(/-NotesFile 指定的文件不存在/.test(BUILD_SRC), 'a missing notes file must fail the build');
  assert.ok(/ISO-8601 UTC/.test(BUILD_SRC), 'a malformed -ReleasedAt must fail the build');
});

/* ── [4] Inno Setup contract ───────────────────────────────────────────── */
console.log('\n[4] Inno Setup contract');

check('per-user, lowest privileges, no UAC elevation', () => {
  assert.ok(/^PrivilegesRequired=lowest$/m.test(ISS_SRC), 'must be lowest privileges');
  assert.ok(/^PrivilegesRequiredOverridesAllowed=\s*$/m.test(ISS_SRC), 'must not allow /ALLUSERS override');
  assert.ok(/^DefaultDirName=\{localappdata\}\\Programs\\InternalBeyond$/m.test(ISS_SRC),
    'must install under the per-user app location');
  assert.ok(!/Program Files/i.test(ISS_SRC.replace(/^;.*$/gm, '')), 'must never target Program Files');
  assert.ok(/^ChangesEnvironment=no$/m.test(ISS_SRC), 'must not touch the environment / PATH');
  assert.ok(!/^\[Registry\]/m.test(ISS_SRC), 'must not write registry beyond the uninstall key');
});

check('single user-facing entry point, no dev launchers', () => {
  const iconNames = (ISS_SRC.match(/^Name: "\{group\}\\{#AppName\}"/gm) || []).length;
  const deskNames = (ISS_SRC.match(/^Name: "\{autodesktop\}\\{#AppName\}"/gm) || []).length;
  assert.strictEqual(iconNames, 1, 'exactly one start menu entry named InternalBeyond');
  assert.strictEqual(deskNames, 1, 'exactly one desktop entry');
  assert.ok(!/\.cmd/.test(ISS_SRC.replace(/^;.*$/gm, '')), 'installer must not reference development .cmd files');
  assert.ok(/wscript\.exe/.test(ISS_SRC), 'shortcuts must launch through wscript (no console window)');
  assert.ok(/启动 InternalBeyond\.vbs/.test(ISS_SRC), 'shortcuts must target the real silent launcher');
  assert.ok(/^Name: "desktopicon";.*Flags: unchecked/m.test(ISS_SRC), 'desktop shortcut must be opt-in');
  assert.ok(/postinstall skipifsilent/.test(ISS_SRC), 'finish page must offer launching the app');
});

check('installer stops a running instance through IB control surfaces only', () => {
  assert.ok(/ib-stop\.js/.test(ISS_SRC), 'must use the shipped stop helper');
  assert.ok(/ExtractTemporaryFile\('\{#StopHelper\}'\)/.test(ISS_SRC), 'helper must be extracted at install time');
  assert.ok(/PrepareToInstall/.test(ISS_SRC), 'must stop before replacing files');
  assert.ok(/Flags: dontcopy/.test(ISS_SRC), 'helper must be available without being double-installed');
  assert.ok(/runhidden skipifdoesntexist/.test(ISS_SRC), 'uninstall stop must be hidden and optional');
  assert.ok(!/taskkill/i.test(ISS_SRC), 'installer must not call taskkill directly');
  assert.ok(!/\/IM\s+node\.exe/i.test(ISS_SRC), 'must never kill by image name');
  const helper = read(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'));
  assert.ok(!/taskkill\.exe',\s*\['\/IM'/.test(helper), 'helper must not kill by image name');
  assert.ok(/\/shutdown/.test(helper) && /__shutdown/.test(helper), 'helper must try the graceful endpoints first');
  assert.ok(helper.indexOf('/shutdown') < helper.indexOf('pidsForPort'), 'graceful stop must precede the fallback');
  assert.ok(/commandLineIsInternalBeyond/.test(helper), 'fallback must verify the command line');
  assert.ok(/RestartApplications=no/.test(ISS_SRC), 'must not let Restart Manager show internal process names');
  assert.ok(/CloseApplications=no/.test(ISS_SRC), 'must handle close applications ourselves');
});

check('zero-touch update relaunch is installer-side and parameter-gated (U-D5)', () => {
  /* The updater helper exits as soon as it has started the installer, so the
     installer is the only thing that can bring InternalBeyond back after a
     silent update. It must therefore relaunch when — and only when — the updater
     asked for it by passing /IBRELAUNCH=1 (U-D3). */
  const code = ISS_SRC.replace(/^;.*$/gm, '');
  assert.ok(/filename: "\{sys\}\\wscript\.exe"; Parameters: """\{app\}\\启动 InternalBeyond\.vbs"""; WorkingDir: "\{app\}"; Flags: nowait; Check: WantsRelaunch/i
    .test(code), '[Run] must carry a parameter-gated relaunch entry');
  assert.ok(/function WantsRelaunch\(\): Boolean;/.test(code), 'the gate must be a [Code] function');
  assert.ok(/\{param:IBRELAUNCH\|0\}/.test(code), 'the gate must read the IBRELAUNCH parameter');

  /* Exactly two launch entries: the untouched interactive one and the gated one.
     The gated entry must NOT be skipifsilent, or a silent update would install
     and never come back. */
  const runs = (code.match(/^Filename: "\{sys\}\\wscript\.exe"/gm) || []).length;
  assert.strictEqual(runs, 2, 'exactly two launch entries, got ' + runs);
  assert.ok(/Flags: nowait postinstall skipifsilent/.test(code),
    'the ordinary interactive install must keep the finish-page entry');
  const gated = code.split('\n').filter(function (l) { return /Check: WantsRelaunch/.test(l); });
  assert.strictEqual(gated.length, 1, 'exactly one gated entry');
  assert.strictEqual(/skipifsilent/.test(gated[0]), false,
    'the update relaunch must survive /VERYSILENT: ' + gated[0]);
  assert.strictEqual(/postinstall/.test(gated[0]), false,
    'the relaunch must not be tied to a finish page that a silent install never shows');

  /* A runtime that failed validation is not relaunched: the user was just told
     the install is broken. */
  assert.ok(/RelaunchBlocked := Problem;/.test(code), 'a broken runtime must block the relaunch');
  assert.ok(/if Problem <> '' then\s*\r?\n\s*begin\s*\r?\n\s*RelaunchBlocked := Problem;/.test(code),
    'the block must be recorded as soon as the runtime is known to be broken');

  /* Cross-module contract: what the helper passes must be what the installer
     reads. Neither side may spell it out on its own. */
  const helperArgs = require(path.join(ROOT, 'runtime', 'update-install.js')).INSTALL_ARGS;
  assert.ok(helperArgs.indexOf('/IBRELAUNCH=1') >= 0,
    'the updater must pass /IBRELAUNCH=1: ' + helperArgs.join(' '));
  assert.ok(helperArgs.indexOf('/VERYSILENT') >= 0 && helperArgs.indexOf('/SUPPRESSMSGBOXES') >= 0,
    'U-D3 fixes the silent install arguments: ' + helperArgs.join(' '));
  assert.ok(helperArgs.indexOf('/NORESTART') >= 0 && helperArgs.indexOf('/SP-') >= 0);
});

check('license is shown and no commercial claim is made', () => {
  assert.ok(/^LicenseFile=\.\.\\LICENSE$/m.test(ISS_SRC), 'must show the real project license');
  const license = read(path.join(ROOT, 'LICENSE'));
  assert.ok(/PolyForm Noncommercial/i.test(license), 'LICENSE must stay PolyForm Noncommercial');
  assert.ok(!/commercial (use|license) (is )?granted/i.test(ISS_SRC), 'installer must not imply commercial licensing');
  const langs = ISS_SRC.match(/MessagesFile: "compiler:Default\.isl,\{#SourcePath\}\\languages\\ChineseSimplified\.isl"/);
  assert.ok(langs, 'Chinese installer language must be wired');
  assert.ok(fs.existsSync(path.join(ROOT, 'installer', 'languages', 'ChineseSimplified.isl')),
    'Chinese language file must be vendored');
});

check('uninstall keeps user data and never deletes the data directory', () => {
  assert.ok(!/^\[UninstallDelete\]/m.test(ISS_SRC), 'must not use [UninstallDelete]');
  assert.ok(!/\{localappdata\}\\InternalBeyond"/.test(ISS_SRC.replace(/'\{localappdata\}\\InternalBeyond'\)/g, '')),
    'must not point a delete rule at the user data directory');
  assert.ok(/SuppressibleMsgBox/.test(ISS_SRC), 'completion notice must be silent-install safe');
  assert.ok(/个人数据/.test(ISS_SRC), 'uninstall must tell the user data was kept');
});

check('unsigned build is supported and not blocked by the script', () => {
  assert.ok(!/SignTool=/m.test(ISS_SRC), 'no signing configuration in the base script');
  assert.ok(!/signtool/i.test(ISS_SRC), 'must build without a certificate');
});

/* ── [5] stop helper logic ─────────────────────────────────────────────── */
console.log('\n[5] stop helper logic');

check('only InternalBeyond command lines are considered ours', () => {
  const ours = [
    'C:\\Program Files\\x\\node.exe "C:\\Users\\a\\AppData\\Local\\Programs\\InternalBeyond\\services\\ib-bridge-service.js"',
    '"C:\\x\\runtime\\node\\node.exe" C:\\x\\runtime\\local-services-runner.js --vision',
    'node.exe C:\\x\\services\\internal-beyond-server.js',
    'wscript.exe "C:\\x\\启动 InternalBeyond.vbs" runtime\\launch-internal-beyond.js'
  ];
  for (const cl of ours) assert.strictEqual(ibStop.commandLineIsInternalBeyond(cl), true, 'must match: ' + cl);
  const foreign = [
    'C:\\Program Files\\OtherApp\\node.exe server.js',
    'node.exe -e "setTimeout(function(){},1)"',
    'python.exe C:\\x\\vision\\main.py',
    'node.exe C:\\other\\ib-bridge-service-other.js',
    ''
  ];
  for (const cl of foreign) assert.strictEqual(ibStop.commandLineIsInternalBeyond(cl), false, 'must not match: ' + cl);
});

check('root matching is path-based and case/separator tolerant', () => {
  assert.strictEqual(ibStop.commandLineMatchesRoot('"C:\\X\\IB\\node.exe" "c:\\x\\ib\\services\\ib-bridge-service.js"', 'C:\\x\\IB'), true);
  assert.strictEqual(ibStop.commandLineMatchesRoot('"D:\\other\\node.exe" a.js', 'C:\\x\\ib'), false);
});

check('stop helper never uses the image name as evidence', () => {
  const src = read(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'));
  assert.ok(!/taskkill\.exe',\s*\['\/F',\s*'\/IM'/.test(src), 'no /IM image-name kill');
  assert.ok(/IB_SCRIPTS/.test(src) && /processCommandline/.test(src), 'must read the command line');
  assert.ok(/pidsForPort/.test(src), 'must resolve PIDs from ports');
});

/* ── [6] static server hardening ───────────────────────────────────────── */
console.log('\n[6] static server hardening');

const serverSrc = read(path.join(ROOT, 'services', 'internal-beyond-server.js'));

check('denies .git / logs / hidden / denylisted / traversal requests', () => {
  const server = require(path.join(ROOT, 'services', 'internal-beyond-server.js'));
  const root = ROOT;
  const bad = ['/.git/config', '/.env', '/logs/launcher.log', '/browser-data/x', '/node_modules/y.js',
    '/runtime/node/node.exe', '/tools/ib-stop.js',
    '/../../etc/passwd', '/assets/../.git/config', '/%2e%2e/%2e%2e/windows/win.ini'];
  for (const p of bad) {
    assert.strictEqual(server.resolveRequest(root, p), null, 'must refuse: ' + p);
  }
  assert.ok(server.resolveRequest(root, '/InternalBeyond.html'), 'must still serve the app');
  assert.ok(server.resolveRequest(root, '/assets/js/core.js'), 'must still serve assets');
  assert.ok(server.resolveRequest(root, '/docs/guide/shots/01-welcome.png'), 'must still serve guide shots');
  assert.ok(server.resolveRequest(root, '/LICENSE'), 'legal documents stay readable');
});

check('exposes a loopback-only graceful stop for the installer', () => {
  assert.ok(/\/__shutdown/.test(serverSrc), 'must implement /__shutdown');
  assert.ok(/req\.method !== 'POST'/.test(serverSrc), 'shutdown must be POST-only');
  assert.ok(/shutdownOriginAllowed/.test(serverSrc), 'shutdown must check Origin');
  assert.ok(/127\.0\.0\.1/.test(serverSrc), 'server must stay loopback-bound');
});

/* ── [7] runner graceful stop ──────────────────────────────────────────── */
console.log('\n[7] runner graceful stop');

check('control plane stops IB services gracefully and verifies identity', () => {
  const runner = read(path.join(ROOT, 'runtime', 'local-services-runner.js'));
  assert.ok(/url\.pathname === '\/shutdown'/.test(runner), 'must expose POST /shutdown');
  assert.ok(/restartOriginAllowed\(req\)/.test(runner), 'shutdown must reuse the Origin guard');
  assert.ok(/async function runShutdown/.test(runner), 'must implement a graceful stop path');
  assert.ok(/stopService\(service\)/.test(runner), 'must reuse the verified stop path');
  assert.ok(/processMatchesService/.test(runner), 'stop must stay command-line verified');
  assert.ok(!/taskkill\.exe',\s*\['\/F',\s*'\/IM'/.test(runner), 'runner must not kill by image name');
  assert.ok(/shutting-down/.test(runner), '/status must report the shutdown state');
});

/* ── [8] audit rules self-test ─────────────────────────────────────────── */
console.log('\n[8] audit rules self-test');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-audit-'));
function writeFile(rel, content) {
  const p = path.join(tmpBase, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

check('planted secret / dev path / forbidden file MUST fail the audit', () => {
  writeFile('assets/js/leak.js', 'var k = "sk-abcdefghijklmnopqrstuvwxyz012345";\n');
  writeFile('logs/launcher.log', 'nothing secret here\n');
  writeFile('.git/config', '[core]\n');
  writeFile('docs/P9-REPORT.md', '# report\n');
  writeFile('test_secret.js', '// dev only\n');
  writeFile('note.md', 'build machine: C:\\Users\\someone\\repo\n');
  const report = audit.scanDirectory(tmpBase);
  assert.strictEqual(report.ok, false, 'planted material must fail the audit');
  const rules = report.findings.map(f => f.rule).concat(report.violations.map(v => v.path));
  assert.ok(report.findings.some(f => f.rule === 'openai-key'), 'must detect an OpenAI-style key');
  assert.ok(report.findings.some(f => f.rule === 'dev-path-win'), 'must detect a developer user path');
  assert.ok(report.violations.length >= 4, 'must flag forbidden paths, got ' + report.violations.length);
});

/* A minimal stand-in for the shipped README: exactly one version claim plus a
   placeholder asset name — the shape the release-claim gate expects. */
function claimReadme(version, extra) {
  return '`Windows 10+` · 当前版本 **' + version + '** · 免管理员权限\n\n' +
    '下载 `InternalBeyond-Setup-<版本号>.exe`。\n' + (extra || '');
}

check('a clean directory passes', () => {
  const cleanDir = path.join(tmpBase, 'clean-staging');
  fs.mkdirSync(path.join(cleanDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(cleanDir, 'assets', 'app.js'), 'var ok = 1;\n');
  fs.writeFileSync(path.join(cleanDir, 'VERSION'), '1.0.0\n');
  /* A real payload always ships VERSION and README.md, and the release-claim
     gate reads both — a fixture without them is not a clean payload. */
  fs.writeFileSync(path.join(cleanDir, 'README.md'), claimReadme('1.0.0'));
  const report = audit.scanDirectory(cleanDir);
  assert.strictEqual(report.ok, true, 'clean payload must pass: ' + JSON.stringify(report.findings));
});

/* The 1.0.4 release shipped a README that still advertised 1.0.3 while VERSION
   said 1.0.4 — on the landing page and inside the installer — and nothing
   failed. This pins the gate that now catches it before the build finishes. */
check('release-claim gate pins the README version to VERSION', () => {
  const dir = path.join(tmpBase, 'claim-staging');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0\n');

  fs.writeFileSync(path.join(dir, 'README.md'), claimReadme('1.0.0'));
  const good = audit.scanDirectory(dir);
  assert.strictEqual(good.ok, true, 'a matching README must pass: ' + JSON.stringify(good.findings));

  /* The exact defect this gate exists for. */
  fs.writeFileSync(path.join(dir, 'README.md'), claimReadme('0.9.9'));
  const stale = audit.scanDirectory(dir);
  assert.strictEqual(stale.ok, false, 'a stale README version MUST fail the payload audit');
  assert.ok(stale.findings.some(f => f.rule === 'release-claim' && f.severity === 'error'),
    'must report a release-claim error');
  assert.ok(stale.errors >= 1, 'a stale claim must be an error, never a warning');

  /* Re-hard-coding an installer asset name for a different release. */
  fs.writeFileSync(path.join(dir, 'README.md'),
    claimReadme('1.0.0', '下载 `InternalBeyond-Setup-0.9.9.exe`。\n'));
  assert.strictEqual(audit.scanDirectory(dir).ok, false, 'a foreign hard-coded asset name MUST fail');

  /* Fail closed: losing the anchor must fail, never silently pass. */
  fs.writeFileSync(path.join(dir, 'README.md'), '本文没有任何版本声明。\n');
  assert.strictEqual(audit.scanDirectory(dir).ok, false, 'a missing anchor MUST fail closed');

  fs.rmSync(path.join(dir, 'README.md'));
  assert.strictEqual(audit.scanDirectory(dir).ok, false, 'a payload without README.md MUST fail');
});

check('documentation naming a prefix is not treated as a secret', () => {
  const findings = audit.scanMarkers('README.md', Buffer.from('演示占位密钥 sk-demo-… 与合成端点', 'utf8'), []);
  assert.strictEqual(findings.length, 0, 'prefix in prose must not be reported');
  const hit = audit.scanMarkers('fixture.js', Buffer.from('var k="sk-demo-1234567890abcdef";', 'utf8'), []);
  assert.strictEqual(hit.length, 1, 'an actual demo value must be reported');
});

check('UTF-16LE markers are detected in binaries', () => {
  const wide = Buffer.from('C:\\Users\\dev\\secret', 'utf16le');
  const findings = audit.scanMarkers('blob.bin', wide, []);
  assert.ok(findings.some(f => f.rule === 'dev-path-win'), 'must catch UTF-16LE paths');
});

check('the real payload audit is clean', () => {
  const report = audit.scanDirectory(tmpBase.replace(/[\\/]$/, ''));
  assert.ok(report.fileCount > 0);
  const realStage = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-real-'));
  try {
    const staged = manifest.stage(realStage, { clean: true, allowAnyDir: true });
    assert.strictEqual(staged.ok, true, 'staging failed: ' + JSON.stringify(staged));
    const real = audit.scanDirectory(realStage);
    assert.strictEqual(real.errors, 0, 'payload must have zero error findings: ' +
      JSON.stringify(real.findings.filter(f => f.severity === 'error')));
    assert.strictEqual(real.violations.length, 0, 'payload must have zero content violations');
  } finally {
    fs.rmSync(realStage, { recursive: true, force: true });
  }
});

/* ── [9] README install section ────────────────────────────────────────── */
console.log('\n[9] README install section');

check('README documents exactly one user entry point', () => {
  const idx = README.search(/InternalBeyond-Setup|安装包|Windows 安装/);
  assert.ok(idx >= 0, 'README must have an installer section');
  const section = README.slice(idx, idx + 6000);
  assert.ok(/InternalBeyond-Setup/.test(section), 'must name the installer');
  assert.ok(/开始菜单|桌面/.test(section), 'must mention the shortcuts');
  assert.ok(!/双击\s*`?Start Internal Beyond\.cmd/.test(section), 'must not send users to dev launchers');
  assert.ok(!/双击\s*`?启动 InternalBeyond\.vbs/.test(section), 'must not send users to the .vbs');
});

check('SmartScreen guidance is honest and does not teach disabling it', () => {
  const idx = README.search(/SmartScreen|Windows 已保护你的电脑|未知发布者/);
  assert.ok(idx >= 0, 'README must explain the first-run Windows warning');
  const section = README.slice(Math.max(0, idx - 1500), idx + 2500);
  assert.ok(/不.*关闭|不要.*关闭|无需关闭/.test(section), 'must not tell users to turn protection off');
  assert.ok(/官方|校验|SHA-?256|来源/.test(section), 'must tell users how to verify the source');
  assert.ok(!/仍要运行.*推荐|建议关闭/.test(section), 'must not recommend bypassing the warning');
});

check('Vision / Python is not packaged', () => {
  const files = resolved.files.map(f => f.to);
  assert.ok(!files.some(f => /^vision\//.test(f)), 'vision/ must not ship');
  assert.ok(!files.some(f => /\.py$/.test(f)), 'no Python sources in the payload');
  assert.ok(!files.some(f => /start-vision-service\.cmd$/.test(f)), 'vision launcher must not ship');
});

/* ── cleanup + report ──────────────────────────────────────────────────── */
try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch (e) { /* best effort */ }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败, ' + skip + ' 跳过');
process.exitCode = fail ? 1 : 0;
