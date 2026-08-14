'use strict';

/*
 * Internal Beyond local service runner (Node.js 18+)
 *
 * Keeps the Bridge and Active companion under one parent process, writes
 * readable per-service logs, and offers a small interactive control surface.
 * It deliberately never kills a process it did not spawn: Ctrl+C only stops
 * children started by this runner, so an existing independently-run service
 * remains untouched.
 *
 * Usage:
 *   node local-services-runner.js              # Bridge + Active
 *   node local-services-runner.js --vision     # also start vision helper
 *   node local-services-runner.js --status     # read-only health summary
 *   node local-services-runner.js --json       # machine-readable status
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const LOCAL_DIR = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
  : path.join(os.homedir(), '.internal-beyond');
const LOG_DIR = path.join(LOCAL_DIR, 'logs');
const args = new Set(process.argv.slice(2));
const includeVision = args.has('--vision');
const jsonOnly = args.has('--json');
const statusOnly = args.has('--status') || jsonOnly;
const children = [];

fs.mkdirSync(LOG_DIR, { recursive: true });

function optionPort(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const SERVICES = [
  {
    name: 'Bridge',
    port: optionPort('IB_BRIDGE_PORT', 23115),
    endpoint: '/health',
    command: process.execPath,
    commandArgs: [path.join(ROOT, 'ib-bridge-service.js')],
    matchesHealth: data => data && data.server === 'IB Bridge',
    env: {}
  },
  {
    name: 'Active',
    port: optionPort('IB_ACTIVE_PORT', 23114),
    endpoint: '/health',
    command: process.execPath,
    commandArgs: [path.join(ROOT, 'active-message-service.js')],
    matchesHealth: data => data && data.service === 'internal-beyond-active-messages',
    env: {}
  }
];

if (includeVision) {
  SERVICES.push({
    name: 'Vision',
    port: optionPort('IB_VISION_PORT', 8765),
    endpoint: '/health',
    command: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'sh',
    commandArgs: process.platform === 'win32'
      ? ['/d', '/c', path.join(ROOT, 'start-vision-service.cmd')]
      : ['-lc', 'echo "Vision helper is currently provided by start-vision-service.cmd on Windows."; exit 1'],
    matchesHealth: data => data && data.service === 'internal-beyond-vision',
    env: {}
  });
}

function requestJson(port, endpoint, timeoutMs) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: endpoint, timeout: timeoutMs || 1800 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
        resolve({
          responding: true,
          healthy: res.statusCode >= 200 && res.statusCode < 300 && !!(data && data.ok),
          status: res.statusCode,
          data
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ responding: false, healthy: false, status: 0, data: null }); });
    req.on('error', () => resolve({ responding: false, healthy: false, status: 0, data: null }));
  });
}

async function serviceStatus(service) {
  const health = await requestJson(service.port, service.endpoint);
  const identityMatches = health.healthy && (!service.matchesHealth || service.matchesHealth(health.data));
  return {
    name: service.name,
    port: service.port,
    online: identityMatches,
    conflict: health.responding && !identityMatches,
    status: health.status,
    version: health.data && (health.data.version || health.data.serviceVersion) || '',
    details: health.data || null
  };
}

async function allStatus() {
  return Promise.all(SERVICES.map(serviceStatus));
}

function printStatus(rows) {
  if (jsonOnly) {
    process.stdout.write(JSON.stringify({ ok: true, services: rows }, null, 2) + '\n');
    return;
  }
  console.log('\nInternal Beyond local services');
  rows.forEach(row => {
    const state = row.online ? 'online' : (row.conflict ? 'conflict' : 'offline');
    const extra = row.online && row.version ? ' · v' + row.version : '';
    console.log('  ' + row.name.padEnd(7) + state.padEnd(8) + '127.0.0.1:' + row.port + extra);
  });
  console.log('  Logs: ' + LOG_DIR + '\n');
}

function timestamp() { return new Date().toISOString(); }

function appendLog(service, stream, chunk) {
  const text = String(chunk || '');
  const prefix = '[' + timestamp() + '] [' + stream + '] ';
  try { fs.appendFileSync(path.join(LOG_DIR, service.name.toLowerCase() + '.log'), prefix + text); } catch (e) { /* logging must never take down services */ }
  if (!jsonOnly) process.stdout.write('[' + service.name + '] ' + text);
}

function spawnService(service) {
  const child = spawn(service.command, service.commandArgs, {
    cwd: ROOT,
    env: Object.assign({}, process.env, service.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const entry = { service, child, exited: false };
  children.push(entry);
  child.stdout.on('data', chunk => appendLog(service, 'out', chunk));
  child.stderr.on('data', chunk => appendLog(service, 'err', chunk));
  child.on('error', error => appendLog(service, 'err', 'spawn failed: ' + error.message + '\n'));
  child.on('exit', (code, signal) => {
    entry.exited = true;
    appendLog(service, 'runner', 'stopped (code=' + code + ', signal=' + (signal || '') + ')\n');
  });
  appendLog(service, 'runner', 'started pid=' + child.pid + '\n');
  return entry;
}

async function waitUntilHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await serviceStatus(service);
    if (row.online) return true;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function startServices() {
  const initial = await allStatus();
  const launched = [];
  for (let i = 0; i < SERVICES.length; i++) {
    const service = SERVICES[i];
    const existing = initial[i];
    if (existing.online) {
      console.log('[runner] ' + service.name + ' is already healthy on port ' + service.port + '; leaving it alone.');
      continue;
    }
    if (existing.conflict) {
      console.error('[runner] Port ' + service.port + ' answered /health but is not ' + service.name +
        '; refusing to treat it as healthy or start a competing process.');
      continue;
    }
    spawnService(service);
    launched.push(service);
  }
  for (const service of launched) {
    const healthy = await waitUntilHealthy(service, service.name === 'Vision' ? 120000 : 15000);
    console.log('[runner] ' + service.name + (healthy ? ' is ready.' : ' did not become healthy yet; inspect its log.'));
  }
  printStatus(await allStatus());
}

function stopChildren() {
  children.forEach(entry => {
    if (entry.exited || !entry.child || entry.child.killed) return;
    try { entry.child.kill('SIGTERM'); } catch (e) { /* best effort */ }
  });
}

function installInteractiveControls() {
  if (!process.stdin.isTTY) return;
  console.log('Controls: [s] status · [q] stop services and exit');
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', async data => {
    const key = String(data || '').trim().toLowerCase();
    if (key === 's' || key === 'status') printStatus(await allStatus());
    if (key === 'q' || key === 'quit' || key === 'exit') shutdown(0);
  });
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[runner] Stopping services started by this runner…');
  stopChildren();
  setTimeout(() => process.exit(code), 1200).unref();
}

async function main() {
  if (statusOnly) {
    printStatus(await allStatus());
    return;
  }
  await startServices();
  installInteractiveControls();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', error => {
  console.error('[runner] Unexpected error:', error && error.stack || error);
  shutdown(1);
});

main().catch(error => {
  console.error('[runner] Failed:', error && error.stack || error);
  shutdown(1);
});
