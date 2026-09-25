'use strict';

/* P32-W.4A · runtime authority contract (workspace/static, no installer). */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rust = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const launcherSource = fs.readFileSync(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(ROOT, 'runtime', 'boot-state.js'), 'utf8');
const launcher = require(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'));
const bootState = require(path.join(ROOT, 'runtime', 'boot-state.js'));
const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
  } catch (error) {
    failures += 1;
    console.error('  FAIL  ' + name + ' -> ' + String(error && error.message || error));
  }
}

console.log('P32-W.4A · runtime authority contract');

check('explicit runtime modes exist', () => {
  assert.ok(rust.includes('production'));
  assert.ok(rust.includes('acceptance'));
  assert.ok(rust.includes('development'));
  assert.ok(rust.includes('IB_RUNTIME_MODE'));
});

check('production positive identity requires manifest and Host', () => {
  assert.ok(rust.includes('ib-payload-manifest.json'));
  assert.ok(rust.includes('production_payload_identity'));
  assert.ok(rust.includes('internalbeyond-host.exe'));
  assert.ok(rust.includes('RUNTIME_PAYLOAD_INVALID'));
});

check('production does not accept IB_PROJECT_ROOT', () => {
  assert.ok(rust.includes('IB_PROJECT_ROOT is only allowed in development mode'));
});

check('acceptance root is explicit', () => {
  assert.ok(rust.includes('IB_ACCEPTANCE_ROOT'));
  assert.ok(rust.includes('tauri-resource'));
});

check('launcher root no longer iterates arbitrary parent/_up_ candidates', () => {
  assert.ok(/fn launcher_root\(state: &HostLifecycle\)[\s\S]*?state\.root\.join/.test(rust));
  assert.ok(!/fn launcher_root\(state: &HostLifecycle\)[\s\S]*?state\.root\.join\("_up_"\)/.test(rust));
});

check('runtime identity is projected through existing boot-state', () => {
  assert.ok(bootSource.includes('runtimeMode'));
  assert.ok(bootSource.includes('payloadIdentity'));
  assert.ok(launcherSource.includes('runtimeIdentity'));
  const state = bootState.buildBootState({
    phase: 'complete',
    runtime: {
      runtimeMode: 'acceptance',
      runtimeRootClass: 'tauri-resource',
      productVersion: '1.0.6',
      payloadManifestVersion: null,
      payloadIdentity: null,
      hostRoot: 'C:\\acceptance',
      runnerRootClass: 'tauri-resource',
      serviceRootClass: 'tauri-resource'
    },
    components: { static: { required: true, healthy: true, state: 'healthy' } }
  });
  assert.strictEqual(state.launcher.runtime.runtimeMode, 'acceptance');
  assert.strictEqual(state.launcher.runtime.runtimeRootClass, 'tauri-resource');
});

check('workspace launcher identifies as development', () => {
  const identity = launcher.runtimeIdentity();
  assert.strictEqual(identity.runtimeMode, 'development');
  assert.strictEqual(identity.runtimeRootClass, 'workspace');
});

check('runtime logs use per-user data root', () => {
  assert.ok(launcherSource.includes('path.join(LOCAL_DIR, \'logs\')'));
  assert.ok(!launcherSource.includes('const LOG_DIR = path.join(ROOT, \'logs\')'));
});

check('canonical manifest source includes R10.1 payload files', () => {
  const resolved = manifest.resolve({});
  assert.strictEqual(resolved.ok, true);
  const files = new Set(resolved.files.map(file => file.to.replace(/\\/g, '/')));
  assert.ok(files.has('active/persistence.js'));
  assert.ok(files.has('services/active-message-service.js'));
  assert.ok(files.has('runtime/local-services-runner.js'));
});

check('canonical build generates Host and payload manifest before compile', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-installer.ps1'), 'utf8');
  assert.ok(build.indexOf("$hostOutput = Join-Path $staging 'internalbeyond-host.exe'") >= 0);
  assert.ok(build.indexOf("$payloadManifest = Join-Path $staging 'ib-payload-manifest.json'") >= 0);
  assert.ok(build.indexOf("$payloadFiles += 'internalbeyond-host.exe'") >= 0);
  assert.ok(build.indexOf("$payloadFiles += 'ib-payload-manifest.json'") >= 0);
  assert.ok(build.indexOf("$compileArgs =") > build.indexOf("$payloadFiles += 'internalbeyond-host.exe'"));
});

console.log(failures ? ('P32-W.4A runtime authority: ' + failures + ' failure(s)') : 'P32-W.4A runtime authority: all checks passed');
process.exitCode = failures ? 1 : 0;
