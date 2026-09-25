'use strict';

/* P32-W.5-R3-B.2.3 canonical RecoveryOnly installer artifact contract. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const staging = path.join(dist, 'staging');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const requiredRecoveryFiles = [
  'Recovery.html',
  'assets/js/webcore-db-schema.js',
  'assets/js/recovery-engine.js',
  'assets/js/composite-recovery-plan.js',
  'assets/js/recovery-webcore-adapter.js',
  'assets/js/recovery-production-adapter.js',
  'assets/js/recovery-apply-executor.js',
  'assets/js/recovery-first-boot.js',
  'assets/js/recovery-source-manifest.js',
  'assets/js/recovery-ui.js',
  'assets/js/recovery-shell.js',
  'assets/js/recovery-c3-5-reconstruction.js',
  'services/home-node/reconstruction-runner.js',
  'services/home-node/production-reconstruction-adapter.js',
  'services/home-node/composite-reconstruction-executor.js',
  'services/home-node/composite-reconstruction-approval.js',
  'services/home-node/character-projection-store.js',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/composite-bundle.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-reconstruction-write-set.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/character-projection-write-set.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-proposed-write-set.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/character-field-authority-matrix.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/character-conflict-resolution.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/c2-authority-report.json'
];
let pass = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    pass++;
    process.stdout.write('✓ ' + name + '\n');
  });
}
function enumerateFiles(dir, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...enumerateFiles(full, rel));
    else out.push(rel.replace(/\\/g, '/'));
  }
  return out;
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const version = read('VERSION').trim();
  const installerName = `InternalBeyond-Setup-${version}.exe`;
  const installer = path.join(dist, installerName);
  const payloadPath = path.join(staging, 'ib-payload-manifest.json');
  const compileLogPath = path.join(dist, 'build-compile.log');

  process.stdout.write('P32-W.5 RecoveryOnly artifact contract tests\n');

  await check('canonical release whitelist resolves every RecoveryOnly runtime input', () => {
    const release = require(path.join(root, 'scripts', 'release-manifest.js'));
    const resolved = release.resolve({});
    assert.strictEqual(resolved.ok, true, JSON.stringify(resolved.missing || []));
    const destinations = new Set(resolved.files.map(file => file.to));
    for (const file of requiredRecoveryFiles) assert.ok(destinations.has(file), file);
    assert.ok(destinations.has('active/persistence.js'));
    assert.ok(destinations.has('runtime/node/node.exe'));
  });

  await check('RecoveryOnly is opt-in and returns before normal service graph construction', () => {
    const rust = read('src-tauri/src/lib.rs');
    const cargo = read('src-tauri/Cargo.toml');
    const stageHost = read('scripts/stage-tauri-host.ps1');
    assert.ok(cargo.includes('custom-protocol = ["tauri/custom-protocol"]'));
    assert.ok(stageHost.includes("'--features', 'custom-protocol'"));
    assert.ok(rust.includes('const RECOVERY_ONLY_ARG: &str = "--recovery-only"'));
    assert.ok(rust.includes('host_entry_mode(std::env::args_os().skip(1))'));
    const setup = rust.indexOf('.setup(move |app|');
    const recovery = rust.indexOf('if restricted_recovery_page {', setup);
    const earlyReturn = rust.indexOf('return Ok(())', recovery);
    const normalProjectState = rust.indexOf('app.manage(ProjectKnowledgeState::new', earlyReturn);
    const normalLauncher = rust.indexOf('spawn_existing_launcher(&lifecycle)', normalProjectState);
    assert.ok(setup >= 0 && recovery > setup && earlyReturn > recovery);
    assert.ok(normalProjectState > earlyReturn && normalLauncher > normalProjectState);
    assert.ok(rust.includes('host_starts_normal_services(entry_mode)'));
    assert.ok(rust.includes('if runtime.mode != RuntimeMode::Production'));
    assert.ok(rust.includes('recovery_payload_is_complete(&runtime.root)'));
  });

  await check('RecoveryOnly page is inert, network-closed, and excludes normal scripts', () => {
    const page = read('Recovery.html');
    assert.match(page, /connect-src 'none'/);
    assert.match(page, /composite-recovery-plan\.js/);
    assert.match(page, /composite-files/);
    assert.match(page, /issue-production-approval/);
    assert.match(page, /execute-production-restore/);
    assert.match(page, /approval-plan-id/);
    assert.match(page, /approval-plan-hash/);
    assert.match(page, /approval-confirmation/);
    assert.match(page, /全局 apply 默认关闭/);
    assert.match(page, /recovery-webcore-adapter\.js/);
    for (const forbidden of ['assets/js/core.js', 'active-diary.js', 'bridge.js', 'local-services-runner.js']) {
      assert.ok(!page.includes(forbidden), forbidden);
    }
    const shell = read('assets/js/recovery-shell.js');
    for (const forbidden of ['indexedDB', 'localStorage', 'fetch(', 'XMLHttpRequest', 'WebSocket']) {
      assert.ok(!shell.includes(forbidden), forbidden);
    }
    const host = read('src-tauri/src/lib.rs');
    assert.ok(host.includes('} else if recovery_policy.blocked() {\n        builder'));
    assert.ok(host.includes('if !restricted_recovery_page {\n            builder = builder.plugin(tauri_plugin_window_state'));
  });

  await check('production apply fails closed even with an approval-shaped object and touches no storage', async () => {
    const adapterModule = require(path.join(root, 'assets', 'js', 'recovery-webcore-adapter.js'));
    assert.strictEqual(adapterModule.PRODUCTION_APPLY_ENABLED, false);
    let storageTouched = false;
    const fakeIdb = new Proxy({}, { get() { storageTouched = true; throw new Error('storage-access-forbidden-in-contract-test'); } });
    const adapter = new adapterModule.RecoveryWebCoreAdapter({ indexedDB: fakeIdb, targetClass: 'production' });
    const approval = {
      kind: 'EXPLICIT_RESTORE_APPROVAL', planId: 'test', sourceSha256: '0'.repeat(64),
      targetOrigin: 'tauri.localhost', databaseName: 'InternalBeyondDB', selectedDomains: [],
      expiresAt: Date.now() + 60_000
    };
    await assert.rejects(adapter.apply(null, null), /production-apply-disabled/);
    await assert.rejects(adapter.apply(null, approval), /production-apply-disabled/);
    assert.strictEqual(storageTouched, false);
  });

  await check('canonical Inno recipe packages the complete staging tree without launching the application', () => {
    const iss = read('installer/InternalBeyond.iss');
    assert.ok(iss.includes('Source: "{#StagingDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs'));
    const build = read('scripts/build-installer.ps1');
    assert.ok(build.includes("-SkipInstallAudit"));
    assert.ok(build.includes("Write-Info '默认不安装"));
    assert.ok(!build.includes('Start-Process -FilePath $exe'));
  });

  await check('staged payload manifest and physical staging tree agree and contain all recovery inputs', () => {
    assert.ok(fs.existsSync(payloadPath), 'missing dist/staging; rebuild with -KeepStaging');
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    assert.strictEqual(payload.schema, 'internalbeyond.payload-manifest');
    assert.strictEqual(payload.product, version);
    const listed = new Set(payload.files);
    for (const file of requiredRecoveryFiles) assert.ok(listed.has(file), file);
    assert.ok(listed.has('internalbeyond-host.exe'));
    assert.ok(listed.has('active/persistence.js'));
    assert.ok(listed.has('runtime/node/node.exe'));
    assert.ok(listed.has('ib-payload-manifest.json'));
    assert.strictEqual(payload.count, payload.files.length);
    const physical = enumerateFiles(staging).sort();
    assert.deepStrictEqual([...listed].sort(), physical);
    for (const relative of requiredRecoveryFiles) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(staging, relative)),
        fs.readFileSync(path.join(root, relative)),
        relative + ' staged bytes differ from source'
      );
    }
    const forbidden = payload.files.filter(file => /(?:\.ibvault|InternalBeyond_auto_\d{4}|EBWebView|LocalAppData)/i.test(file));
    assert.deepStrictEqual(forbidden, []);
    const hostBytes = fs.readFileSync(path.join(staging, 'internalbeyond-host.exe'));
    for (const marker of ['--recovery-only', 'RECOVERY_ONLY_REQUIRES_CANONICAL_PRODUCTION_ROOT', 'Recovery.html', 'issue_recovery_restore_approval', 'write_recovery_checkpoint', 'open_recovery_apply_window', 'close_recovery_apply_window']) {
      assert.ok(hostBytes.includes(Buffer.from(marker)), 'staged Host missing marker: ' + marker);
    }
  });

  await check('built canonical installer, checksum, Stable manifest, and compile input all agree', () => {
    assert.ok(fs.existsSync(installer), 'missing canonical installer artifact');
    assert.ok(fs.existsSync(compileLogPath), 'missing canonical ISCC compile log');
    const bytes = fs.statSync(installer).size;
    const hash = sha256(installer);
    const sums = fs.readFileSync(path.join(dist, 'SHA256SUMS.txt'), 'utf8');
    const sumLine = sums.split(/\r?\n/).find(line => line.endsWith(' *' + installerName));
    assert.ok(sumLine, 'installer hash line missing');
    assert.strictEqual(sumLine.split(/\s+/)[0].toLowerCase(), hash);
    const stable = JSON.parse(fs.readFileSync(path.join(dist, 'update-stable.json'), 'utf8'));
    assert.strictEqual(stable.version, version);
    assert.strictEqual(stable.installer.productVersion, version);
    assert.strictEqual(stable.installer.sizeBytes, bytes);
    assert.strictEqual(stable.installer.sha256, hash);
    assert.strictEqual(stable.installer.url.split('/').pop(), installerName);
    const pe = require(path.join(root, 'runtime', 'pe-version.js'));
    const peCheck = pe.matchesProductVersion(installer, version);
    assert.strictEqual(peCheck.ok, true, peCheck.why || 'installer PE version mismatch');
    const log = fs.readFileSync(compileLogPath, 'utf8');
    assert.match(log, /compile identity: InstallerTestMode absent/);
    assert.match(log, /Successful compile/i);
    assert.match(log, /StagingDir=.*dist[\\/]staging/i);
    assert.match(log, /OutputDir=.*dist/i);
    assert.ok(!/install audit.*running|real-install-smoke/i.test(log));
    for (const relative of [
      'ib-payload-manifest.json', 'internalbeyond-host.exe', ...requiredRecoveryFiles,
      'active/persistence.js', 'runtime/node/node.exe'
    ]) {
      const compressedPath = path.join(staging, relative);
      assert.ok(log.includes('Compressing: ' + compressedPath), 'ISCC did not package ' + relative);
    }
    assert.ok(stable.installer.sizeBytes > 0 && /^[a-f0-9]{64}$/i.test(hash));
  });

  process.stdout.write(`PASS ${pass} RecoveryOnly artifact contract checks\n`);
}

main().catch(error => {
  process.stderr.write('FAIL ' + (error && error.stack || error) + '\n');
  process.exitCode = 1;
});
