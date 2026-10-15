'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const policy = require('./p32-w5-recovery-network-policy.js');
const { extractFunction } = require('./helpers/rust-source.js');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log('PASS ' + name);
}

check('reserved ipc.localhost is classified as local Tauri IPC, not external', () => {
  assert.strictEqual(policy.classifyDestination('http://ipc.localhost/opaque', 'http://tauri.localhost').kind, 'TAURI_LOCAL_IPC');
  assert.strictEqual(policy.classifyDestination('https://api.example.test/v1', 'http://tauri.localhost').kind, 'EXTERNAL');
  assert.strictEqual(policy.classifyDestination('https://service.localhost/path', 'http://tauri.localhost').kind, 'LOCAL');
  assert.strictEqual(policy.classifyDestination('http://127.0.0.1:43127/path', 'http://tauri.localhost').kind, 'LOCAL');
});

check('only the read-only checkpoint command may use the local Tauri IPC transport', () => {
  const readCommand = JSON.stringify({ cmd: 'read_recovery_checkpoint', callback: 1, error: 2, payload: {} });
  assert.deepStrictEqual(
    policy.decideTauriIpc('http://ipc.localhost/opaque', 'http://tauri.localhost', 'POST', readCommand),
    { action: 'ALLOW_READ_ONLY_TAURI_IPC', command: 'read_recovery_checkpoint' }
  );
  const writeCommand = JSON.stringify({ cmd: 'write_recovery_checkpoint', payload: { token: 'DO_NOT_ECHO' } });
  assert.deepStrictEqual(
    policy.decideTauriIpc('http://ipc.localhost/opaque', 'http://tauri.localhost', 'POST', writeCommand),
    { action: 'BLOCK_TAURI_IPC', command: null }
  );
  assert.deepStrictEqual(
    policy.decideTauriIpc('http://ipc.localhost/write_recovery_checkpoint', 'http://tauri.localhost', 'POST', readCommand),
    { action: 'BLOCK_TAURI_IPC', command: null }
  );
  assert.deepStrictEqual(
    policy.decideTauriIpc('http://ipc.localhost/opaque', 'http://tauri.localhost', 'GET', readCommand),
    { action: 'BLOCK_TAURI_IPC', command: null }
  );
});

check('external HTTP, WebSocket and unapproved IPC requests fail closed', () => {
  for (const scheme of ['https:', 'http:', 'wss:', 'ws:']) {
    const url = scheme + '//external.example.test/resource';
    assert.strictEqual(policy.classifyDestination(url, 'http://tauri.localhost').kind, 'EXTERNAL');
  }
  assert.strictEqual(
    policy.decideTauriIpc('https://external.example.test/check', 'http://tauri.localhost', 'POST', '{}').action,
    'BLOCK_EXTERNAL'
  );
});

check('RecoveryOnly document has restrictive external-resource CSP and self-hosted scripts only', () => {
  const html = read('Recovery.html');
  assert.match(html, /default-src\s+'self'/);
  assert.match(html, /connect-src\s+'none'/);
  assert.match(html, /img-src\s+'self'\s+data:/);
  const scriptTags = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scriptTags.length > 0);
  assert.ok(scriptTags.every(src => !/^https?:/i.test(src) && !src.startsWith('//')));
  assert.doesNotMatch(html, /<img\b[^>]*\bsrc\s*=\s*['"]https?:/i);
});

check('RecoveryOnly loads no provider/update/runtime bootstrap modules', () => {
  const html = read('Recovery.html');
  for (const forbidden of ['assets/js/core.js', 'assets/js/communication.js', 'assets/js/provider-directory.js',
    'runtime/update-check.js', 'assets/js/active-diary.js', 'assets/js/bridge.js']) {
    assert.ok(!html.includes(forbidden), forbidden);
  }
  const rust = read('src-tauri/src/lib.rs');
  const recoveryBranch = rust.indexOf('if restricted_recovery_page {');
  const recoveryReturn = rust.indexOf('return Ok(());', recoveryBranch);
  const normalProjectKnowledge = rust.indexOf('app.manage(ProjectKnowledgeState::new(runtime.root.clone()))', recoveryBranch);
  const normalLauncher = rust.indexOf('spawn_existing_launcher(&lifecycle)', recoveryBranch);
  assert.ok(recoveryBranch >= 0 && recoveryReturn > recoveryBranch);
  assert.ok(normalProjectKnowledge > recoveryReturn);
  assert.ok(normalLauncher > recoveryReturn);
});

check('dry-run uses only the read-only checkpoint command; write commands stay approval-bound', () => {
  const adapter = read('assets/js/recovery-production-adapter.js');
  assert.match(adapter, /read:\s*async function\(\)\{return defaultInvoke\(\)\('read_recovery_checkpoint'\)\}/);
  assert.match(adapter, /save:\s*async function\(checkpoint,approval\)\{return defaultInvoke\(\)\('write_recovery_checkpoint'/);
  assert.match(adapter, /var PRODUCTION_APPLY_ENABLED=false/);
  assert.match(adapter, /if\(!this\.db\)await this\.prepareProductionTarget\(\)/);
  const rust = read('src-tauri/src/lib.rs');
  const readHandler = extractFunction(rust, 'read_recovery_checkpoint');
  assert.match(readHandler, /fs::read\(path\)/);
  assert.doesNotMatch(readHandler, /(?:create_dir_all|write_all|remove_file|OpenOptions::new)\s*\(/);
});

check('production dry-run harness blocks external API types and audits local IPC separately', () => {
  const runner = read('tests/test_p32_w5_composite_recovery_production_dryrun.js');
  assert.match(runner, /XMLHttpRequest\.prototype\.open/);
  assert.match(runner, /window\.WebSocket=function/);
  assert.match(runner, /window\.EventSource=function/);
  assert.match(runner, /externalNetworkDetails/);
  assert.match(runner, /tauriIpc/);
  assert.match(runner, /indexedDbReadwriteAttemptsZero/);
  assert.match(runner, /productionApplyClosed/);
  assert.match(runner, /providerCallsZero/);
});

check('plan-bound sources, authority, provenance, target and credential firewall stay pinned', () => {
  const runner = read('tests/test_p32_w5_composite_recovery_production_dryrun.js');
  const report = JSON.parse(read('tmp/p32-w5-r3b/p5.6.3-report.json'));
  assert.match(runner, /1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401/);
  assert.match(runner, /37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d/);
  assert.match(runner, /5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84/);
  assert.match(runner, /f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7/);
  assert.match(runner, /420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5/);
  assert.match(runner, /http:\/\/tauri\.localhost/);
  assert.strictEqual(report.productionBoundDryRun.productionBoundPlanId,
    'r3b3:f263ac9138bcabcfe5b718215fc1b49f7221785c648edd87e71c4399313aff6f');
  assert.strictEqual(report.productionBoundDryRun.productionBoundPlanSha256,
    'f263ac9138bcabcfe5b718215fc1b49f7221785c648edd87e71c4399313aff6f');
  assert.strictEqual(report.productionBoundDryRun.provenance.traceDigest,
    '420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5');
  assert.strictEqual(report.productionBoundDryRun.authority, 'USER_CONFIRMED_IDENTITY_SUCCESSION');
  assert.strictEqual(report.productionBoundDryRun.credentialFirewall.state, 'NEEDS_REBIND');
  assert.strictEqual(report.productionBoundDryRun.credentialFirewall.secretValuesProjected, 0);
});

console.log('PASS ' + pass + ' P5.6.4 network-zero checks');
