/* test_restart_backend.js — Silent Backend Restart (Backend lifecycle management)
   ----------------------------------------------------------------------------
   Spawns the real local-services-runner (Bridge 23115 + Active 23114) on random
   ports with temp data dirs, then verifies the localhost restart control surface:
     POST /restart    (mutex: rapid repeats are coalesced → no duplicate instances)
     GET  /status     (idle → restarting → ready | failed)
   Also verifies: ports are released then re-bound, health is eventually ready,
   a foreign process on a port is NOT killed (only verified IB services are),
   Origin guard returns 403 for a non-local origin, and no secret / command line
   leaks into responses. node test_restart_backend.js (Node 18+). */
'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const RUNNER = path.join(__dirname, 'local-services-runner.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const usedPorts = new Set();
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => {
        if (usedPorts.has(p)) { resolve(freePort()); return; }
        usedPorts.add(p);
        resolve(p);
      });
    });
  });
}
function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function httpJson(method, port, pathname, body, headers) {
  return new Promise(resolve => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let j = null; try { j = raw ? JSON.parse(raw) : null; } catch (e) { }
        resolve({ status: res.statusCode, body: j, raw });
      });
    });
    req.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, body: null, raw: '' }); });
    if (data) req.write(data);
    req.end();
  });
}
async function waitHealth(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await httpJson('GET', port, '/health'); if (r.status >= 200 && r.status < 300) return true; } catch (e) { }
    await sleep(220);
  }
  return false;
}
async function waitRestartStatus(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await httpJson('GET', port, '/status');
    if (r.status === 200 && r.body && r.body.service === 'InternalBeyond Restart') return r;
    await sleep(250);
  }
  return null;
}
async function pollTerminal(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await httpJson('GET', port, '/status');
    if (r.status === 200 && (r.body.state === 'ready' || r.body.state === 'failed')) return r.body;
    await sleep(1000);
  }
  return null;
}
function pidsListening(port) {
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-NetTCPConnection -LocalPort ' + Number(port) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ","'],
      { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        resolve(String(stdout || '').trim().split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0));
      });
  });
}
function killTree(pid) {
  return new Promise(resolve => {
    execFile('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 8000 }, () => resolve());
  });
}

/* ── Frontend contract (test 8/9): never hard-refresh the page, and reuse the
      existing IBNET / active-companion reconnect instead of a new socket. */
{
  const ui = fs.readFileSync(path.join(__dirname, 'assets', 'js', 'backend-restart.js'), 'utf8');
  assert.ok(!/window\.location\s*=|location\.(reload|replace)\(|location\.href\s*=/.test(ui), 'restart UI must never hard-refresh the page');
  assert.ok(/IBNET\.connect\s*\(/.test(ui), 'restart UI must reuse the existing IBNET reconnect');
  assert.ok(/_activeCheckCompanion\s*\(/.test(ui), 'restart UI must reuse the existing active-companion health poll');
  assert.ok(!/new WebSocket\(/.test(ui), 'restart UI must not create a second WebSocket');
}

(async () => {
  const bridgePort = await freePort();
  const activePort = await freePort();
  const restartPort = await freePort();
  const logsDir = tmpDir('ib-rs-logs');
  const bridgeData = tmpDir('ib-rs-bridge');
  const activeData = tmpDir('ib-rs-active');

  const env = Object.assign({}, process.env, {
    IB_BRIDGE_PORT: String(bridgePort),
    IB_ACTIVE_PORT: String(activePort),
    IB_RESTART_PORT: String(restartPort),
    IB_BRIDGE_DATA_DIR: bridgeData,
    IB_ACTIVE_DATA_DIR: activeData,
    IB_ACTIVE_START_DELAY_MS: '500',
    LOCALAPPDATA: logsDir,
    IB_SOCIAL_OBSERVE: 'off'
  });

  let runnerOut = '';
  const runner = spawn(process.execPath, [RUNNER], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  runner.stdout.on('data', c => { runnerOut += c; });
  runner.stderr.on('data', c => { runnerOut += c; });
  let runnerExited = false;
  runner.on('exit', code => { runnerExited = true; runnerOut += '\n[runner-exit ' + code + ']'; });
  const cleanup = async () => {
    if (!runnerExited && runner.pid) await killTree(runner.pid);
    else if (!runnerExited && runner.pid) { try { runner.kill('SIGTERM'); } catch (e) { } }
  };
  const RESTART = 'http://127.0.0.1:' + restartPort;
  const st = (pathname, extra) => httpJson('GET', restartPort, pathname, null, extra);
  const post = (body, extra) => httpJson('POST', restartPort, '/restart', body, extra);

  try {
    /* initial services healthy */
    assert.ok(await waitHealth(bridgePort, 15000), 'Bridge did not become healthy');
    assert.ok(await waitHealth(activePort, 15000), 'Active did not become healthy');

    /* initial status = idle (retry: control server binds just after services) */
    const sInit = await waitRestartStatus(restartPort, 15000);
    assert.ok(sInit, 'restart control server did not come up');
    assert.strictEqual(sInit.body.state, 'idle', 'initial state should be idle');

    const bridgePidBefore = (await pidsListening(bridgePort))[0];
    const activePidBefore = (await pidsListening(activePort))[0];
    assert.ok(bridgePidBefore, 'no bridge PID before restart');
    assert.ok(activePidBefore, 'no active PID before restart');

    /* single click restart → accepted */
    const kick = await post({}, { 'Content-Type': 'application/json' });
    assert.strictEqual(kick.status, 202, 'POST /restart should be 202, got ' + kick.status);
    assert.strictEqual(kick.body.state, 'restarting');

    /* rapid second click → coalesced (409), no duplicate instance */
    const second = await post({}, { 'Content-Type': 'application/json' });
    assert.strictEqual(second.status, 409, 'rapid second POST should be 409 (coalesced)');
    assert.strictEqual(second.body.error, 'restart-in-progress');

    /* poll until terminal */
    const deadline = Date.now() + 40000;
    let terminal = null;
    while (Date.now() < deadline) {
      const r = await st('/status');
      if (r.status === 200 && (r.body.state === 'ready' || r.body.state === 'failed')) { terminal = r.body; break; }
      await sleep(1000);
    }
    assert.ok(terminal, 'restart did not reach a terminal state');
    assert.strictEqual(terminal.state, 'ready', 'restart should report ready, got: ' + terminal.state);

    /* both health ready again */
    assert.ok(await waitHealth(bridgePort, 12000), 'Bridge not healthy after restart');
    assert.ok(await waitHealth(activePort, 12000), 'Active not healthy after restart');

    /* ports re-bound to fresh PIDs (no duplicate instance → single PID each) */
    const bridgePidAfter = await pidsListening(bridgePort);
    const activePidAfter = await pidsListening(activePort);
    assert.strictEqual(bridgePidAfter.length, 1, 'expected exactly one Bridge listener, got ' + bridgePidAfter.length);
    assert.strictEqual(activePidAfter.length, 1, 'expected exactly one Active listener, got ' + activePidAfter.length);
    assert.notStrictEqual(bridgePidAfter[0], bridgePidBefore, 'Bridge PID should have changed');
    assert.notStrictEqual(activePidAfter[0], activePidBefore, 'Active PID should have changed');

    /* Origin guard: a non-local origin is denied */
    const evil = await post({}, { 'Origin': 'http://evil.example' });
    assert.strictEqual(evil.status, 403, 'non-local Origin should be 403, got ' + evil.status);

    /* Secret / command-line leakage: responses must not expose anything */
    for (const r of [kick, second, terminal, await st('/status')]) {
      const raw = JSON.stringify(r);
      assert.ok(!/sk-[A-Za-z0-9]{8,}/i.test(raw), 'response leaked an API key');
      assert.ok(!/\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(raw), 'response leaked a bearer token');
      assert.ok(!/api[_-]?key/i.test(raw) && !/--api[_-]?key/i.test(raw), 'response leaked apiKey');
      assert.ok(!/(node(?:\.exe)?[^\n]*?ib-bridge-service|node(?:\.exe)?[^\n]*?active-message-service)/i.test(raw), 'response leaked a command line');
    }

    console.log('Silent backend restart test passed ✔');
  } finally {
    await cleanup();
  }

  /* ── Failure reporting + foreign-process safety (dedicated scenario) ──
     A fresh runner whose Active port is pre-occupied by a NON-matching process.
     The runner must NOT kill the foreign process (only verified IB services) and
     the restart must report failed (EADDRINUSE on the occupied port). */
  {
    const bridgePort2 = await freePort();
    const activePort2 = await freePort();
    const restartPort2 = await freePort();
    const foreign = http.createServer((req, res) => { res.end('{}'); });
    foreign.on('error', () => {}); /* a busy port is the whole point; never crash the test */
    await new Promise(resolve => foreign.listen(activePort2, '127.0.0.1', resolve));
    const env2 = Object.assign({}, process.env, {
      IB_BRIDGE_PORT: String(bridgePort2),
      IB_ACTIVE_PORT: String(activePort2),
      IB_RESTART_PORT: String(restartPort2),
      IB_BRIDGE_DATA_DIR: tmpDir('ib-rs-f-bridge'),
      IB_ACTIVE_DATA_DIR: tmpDir('ib-rs-f-active'),
      IB_ACTIVE_START_DELAY_MS: '500',
      LOCALAPPDATA: logsDir,
      IB_SOCIAL_OBSERVE: 'off'
    });
    let runner2Out = '';
    const runner2 = spawn(process.execPath, [RUNNER], { cwd: __dirname, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
    runner2.stdout.on('data', c => { runner2Out += c; });
    runner2.stderr.on('data', c => { runner2Out += c; });
    let runner2Exited = false;
    runner2.on('exit', () => { runner2Exited = true; });
    try {
      const st2 = (p, e) => httpJson('GET', restartPort2, p, null, e);
      const post2 = (b, e) => httpJson('POST', restartPort2, '/restart', b || {}, e);
      /* Bridge alone comes up; Active is reported as a conflict, not started. */
      assert.ok(await waitHealth(bridgePort2, 15000), 'failure-scenario Bridge did not start');
      const up2 = await waitRestartStatus(restartPort2, 15000);
      assert.ok(up2, 'failure-scenario restart control did not come up');
      const fk2 = await post2({}, { 'Content-Type': 'application/json' });
      assert.strictEqual(fk2.status, 202, 'failure-scenario POST should be 202');
      const fTerm2 = await pollTerminal(restartPort2, 70000);
      assert.ok(fTerm2, 'failure-scenario restart did not reach terminal');
      assert.strictEqual(fTerm2.state, 'failed', 'restart with occupied foreign port should fail, got: ' + fTerm2.state);
      /* foreign process never killed */
      const fakeAlive2 = await pidsListening(activePort2);
      assert.ok(fakeAlive2.length >= 1, 'foreign process was wrongly killed (or vanished)');
      console.log('Restart failure reporting + foreign-process safety passed ✔');
    } finally {
      await new Promise(resolve => foreign.close(resolve));
      await killTree(runner2.pid);
    }
  }
})().catch(error => {
  console.error(error && error.stack || error);
  if (typeof runnerOut === 'string' && runnerOut.trim()) console.error('--- runner output ---\n' + runnerOut);
  process.exitCode = 1;
});
