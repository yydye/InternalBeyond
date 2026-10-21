'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const launcher = require('../runtime/launch-internal-beyond.js');
const serviceControl = require('../runtime/service-control.js');

const root = path.resolve(__dirname, '..');
const hostSource = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'assets/js/tauri-runtime-status.js'), 'utf8');
const runnerSource = fs.readFileSync(path.join(root, 'runtime/local-services-runner.js'), 'utf8');

const oldHost = process.env.IB_TAURI_HOST;
const oldAutostart = process.env.IB_HOME_NODE_AUTOSTART;
const rows = [
  { name: 'Bridge', online: true },
  { name: 'Active', online: true },
  { name: 'HomeNode', online: false }
];
try {
  delete process.env.IB_TAURI_HOST;
  delete process.env.IB_HOME_NODE_AUTOSTART;
  assert.strictEqual(launcher.servicesHealthy(rows), true, 'existing non-Tauri launcher policy remains unchanged');
  process.env.IB_TAURI_HOST = '1';
  process.env.IB_HOME_NODE_AUTOSTART = '1';
  assert.strictEqual(launcher.homeNodeRequiredForTauriStartup(), true);
  assert.strictEqual(launcher.servicesHealthy(rows), false, 'Tauri readiness includes Home Node');
  rows[2].online = true;
  assert.strictEqual(launcher.servicesHealthy(rows), true, 'Tauri becomes ready only after Home Node health passes');
} finally {
  if (oldHost === undefined) delete process.env.IB_TAURI_HOST; else process.env.IB_TAURI_HOST = oldHost;
  if (oldAutostart === undefined) delete process.env.IB_HOME_NODE_AUTOSTART; else process.env.IB_HOME_NODE_AUTOSTART = oldAutostart;
}

assert.ok(/homeNode:\s*\{[\s\S]{0,180}home-node-service\.js/.test(runnerSource),
  'the existing runner owns Home Node autostart');
assert.ok(/registry\.managed\(\)\.filter\(c => c\.id !== 'vision' \|\| includeVision\)/.test(runnerSource),
  'Vision remains opt-in and is not started with the Tauri service graph');

let stopCalled = false;
let refusal = null;
const tauriStop = serviceControl.createStopDispatch({
  service: 'runner',
  path: '/__tauri/shutdown',
  authorize: request => request.headers['x-ib-tauri-host-session'] === 'session-current'
    ? null : { status: 403, error: 'host-session-mismatch' },
  stop: () => { stopCalled = true; },
  drainMs: 1
});
const rejected = tauriStop(
  { method: 'POST', url: '/__tauri/shutdown', headers: { host: '127.0.0.1', 'x-ib-tauri-host-session': 'session-old' }, socket: { remoteAddress: '127.0.0.1' } },
  { writeHead() {}, end() {} },
  (status, error) => { refusal = { status, error }; }
);
assert.strictEqual(rejected, 'host-session-mismatch');
assert.deepStrictEqual(refusal, { status: 403, error: 'host-session-mismatch' });
assert.strictEqual(stopCalled, false, 'a previous or external owner session cannot be stopped');

assert.ok(/\.env\("IB_HOME_NODE_AUTOSTART", "1"\)/.test(hostSource), 'Tauri explicitly requests Home Node autostart');
assert.ok(hostSource.includes('runtime.home_node_ready = home_ready'), 'Host status follows live Home Node readiness');
assert.ok(fs.readFileSync(path.join(root, 'src-tauri/src/tauri_service_supervisor.rs'), 'utf8')
  .includes('home-node-port-conflict'), 'unknown Home Node port owners are reported as fail-closed conflicts');
assert.ok(hostSource.includes('Home Node 首选端口不兼容；Runner 正在协调空闲端口'),
  'an incompatible Home Node listener is reported while the existing Runner selects a free endpoint');
assert.ok(hostSource.includes('tauriHostSessionId'), 'ownership is bound to a per-Host session id');
assert.ok(hostSource.includes('home_node_instance_matches_with') && hostSource.includes('home_node_environment_identity_matches(&value)'),
  'Host Home Node probes require exact environment, instance, protocol, and data-directory identities');
assert.ok(hostSource.includes('"runtime/home-node-identity.js"'),
  'production Host payload validation requires the shared Home Node identity helper');
assert.ok(!/taskkill\.exe[\s\S]{0,140}\/T/.test(hostSource), 'Tauri cleanup does not kill a process tree');
assert.ok(runnerSource.includes('expectedPid: Number(entry.pid)') && !runnerSource.includes('path.basename(ROOT)'),
  'Runner stop authority is an exact live child PID, not a root-name substring');
assert.ok(/const ownedServices = SERVICES\.filter\(service => liveChildEntry\(service\)\)/.test(runnerSource),
  'Runner shutdown only stops services it spawned');
assert.ok(uiSource.includes("invoke('tauri_runtime_status')") && uiSource.includes('snapshot.degraded'),
  'the UI reads native readiness and displays degraded state');

console.log('Tauri service supervisor integration contract: all checks passed');
