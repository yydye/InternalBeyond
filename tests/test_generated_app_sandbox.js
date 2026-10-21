'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createWebServer } = require('../services/internal-beyond-server.js');

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('generated app documents are served from an opaque, CSP-bounded preview route', async t => {
  const port = await freePort();
  const server = createWebServer({ root: path.resolve(__dirname, '..'), host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = 'http://127.0.0.1:' + port;
  const draft = {
    draftRef: 'ad_123e4567-e89b-42d3-a456-426614174000', projectRef: 'synthetic-project',
    name: 'Sandbox probe', version: 1,
    files: {
      'index.html': '<!doctype html><html><head><title>Sandbox probe</title></head><body><button id=\"go\">Run</button></body></html>',
      'styles.css': 'body{color:#123}',
      'app.js': 'document.body.dataset.started=\"yes\";window.AppStorage.set(\"probe\",{ok:true});'
    }
  };

  const preflight = await fetch(base + '/__ib-generated-app', {
    method: 'OPTIONS', headers: {
      Origin: 'http://tauri.localhost',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://tauri.localhost');

  const deniedNull = await fetch(base + '/__ib-generated-app', {
    method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: JSON.stringify({ draft })
  });
  assert.equal(deniedNull.status, 403, 'opaque/untrusted frames cannot publish app documents');
  const deniedForeign = await fetch(base + '/__ib-generated-app', {
    method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ draft })
  });
  assert.equal(deniedForeign.status, 403, 'foreign origins cannot publish app documents');
  const deniedTauriPort = await fetch(base + '/__ib-generated-app', {
    method: 'POST', headers: { Origin: 'http://tauri.localhost:9999', 'Content-Type': 'application/json' }, body: JSON.stringify({ draft })
  });
  assert.equal(deniedTauriPort.status, 403, 'only the canonical Tauri origin may cross the local service boundary');
  const deniedOtherLoopbackPort = await fetch(base + '/__ib-generated-app', {
    method: 'POST', headers: { Origin: 'http://127.0.0.1:' + (port + 1), 'Content-Type': 'application/json' }, body: JSON.stringify({ draft })
  });
  assert.equal(deniedOtherLoopbackPort.status, 403, 'other loopback services do not inherit the app host origin');

  const created = await fetch(base + '/__ib-generated-app', {
    method: 'POST', headers: { Origin: 'http://tauri.localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ draft })
  });
  assert.equal(created.status, 201);
  const receipt = await created.json();
  assert.match(receipt.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const document = await fetch(base + '/__ib-generated-app/' + receipt.id, { headers: { Origin: 'null' } });
  assert.equal(document.status, 200, 'the sandboxed iframe can load its opaque preview URL');
  assert.equal(document.headers.get('content-type'), 'text/html; charset=utf-8');
  const csp = document.headers.get('content-security-policy');
  assert.match(csp, /script-src 'unsafe-inline'/, 'inline app code is allowed only by this isolated document policy');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /sandbox allow-scripts/);
  assert.doesNotMatch(csp, /unsafe-eval|allow-same-origin/);
  assert.match(await document.text(), /window\.AppStorage/);

  const removed = await fetch(base + '/__ib-generated-app/' + receipt.id, {
    method: 'DELETE', headers: { Origin: 'http://tauri.localhost' }
  });
  assert.equal(removed.status, 204);
  const expired = await fetch(base + '/__ib-generated-app/' + receipt.id);
  assert.equal(expired.status, 404, 'unmount cleanup removes the served document');

  const secondCreated = await fetch(base + '/__ib-generated-app', {
    method: 'POST', headers: { Origin: 'http://tauri.localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ draft })
  });
  const secondReceipt = await secondCreated.json();
  const beaconCleanup = await fetch(base + '/__ib-generated-app/cleanup/' + secondReceipt.id, {
    method: 'POST', headers: { Origin: 'http://tauri.localhost', 'Content-Type': 'text/plain;charset=UTF-8' }, body: ''
  });
  assert.equal(beaconCleanup.status, 204, 'page exit can release a preview without an unload-time CORS preflight');
  assert.equal((await fetch(base + '/__ib-generated-app/' + secondReceipt.id)).status, 404);
});
