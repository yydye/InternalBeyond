/* P32-W.3A · acceptance seam contract.
   Proves the loopback result channel is disabled by default and only accepts
   a bounded fixed-probe-shaped result when explicitly enabled. */
'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const { createWebServer } = require(path.join(__dirname, '..', 'services', 'internal-beyond-server.js'));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function request(port, method, body) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/__p32-w3a/acceptance', method, headers: raw ? { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(raw) } : {} }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(server.port, server.host, resolve); }); }
function close(server) { return new Promise(resolve => server.close(() => resolve())); }

async function main() {
  const old = process.env.IB_ACCEPTANCE_SECRET_ROUTES;
  const oldRunId = process.env.IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID;
  delete process.env.IB_ACCEPTANCE_SECRET_ROUTES;
  const offPort = await freePort();
  const off = createWebServer({ port: offPort });
  await listen(off);
  assert.strictEqual((await request(offPort, 'GET')).status, 404);
  await close(off);

  process.env.IB_ACCEPTANCE_SECRET_ROUTES = '1';
  process.env.IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID = 'contract-run';
  const onPort = await freePort();
  const on = createWebServer({ port: onPort });
  await listen(on);
  assert.strictEqual((await request(onPort, 'GET')).body.ready, false);
  const accepted = await request(onPort, 'POST', {
    schemaVersion: 1, runId: 'contract-run', phase: 'probe_complete', ready: true, tauri: true, navHome: true,
    consoleOpened: true, beyondOpened: true, middlebrainOpened: true,
    done: true, origin: 'http://tauri.localhost', pathname: '/InternalBeyond.html',
    modelCallsObserved: 0, elapsedMs: 100
  });
  assert.strictEqual(accepted.status, 202);
  const result = await request(onPort, 'GET');
  assert.strictEqual(result.body.ready, true);
  assert.strictEqual(result.body.result.schemaVersion, 1);
  assert.strictEqual(result.body.result.runId, 'contract-run');
  assert.strictEqual(result.body.result.origin, 'http://tauri.localhost');
  await close(on);
  if (old == null) delete process.env.IB_ACCEPTANCE_SECRET_ROUTES; else process.env.IB_ACCEPTANCE_SECRET_ROUTES = old;
  if (oldRunId == null) delete process.env.IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID; else process.env.IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID = oldRunId;
  console.log('P32-W.3A acceptance seam contract: all checks passed');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
