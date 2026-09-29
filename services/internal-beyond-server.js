'use strict';

/*
 * Internal Beyond static web server.
 *
 * Serves the project root over 127.0.0.1 so browser APIs such as AudioWorklet
 * (which fail under the opaque file:// origin) work correctly while the app is
 * loading from localhost. Binds ONLY to loopback; no network exposure.
 *
 * Usage:
 *   node internal-beyond-server.js            # serve on 127.0.0.1:23120
 *   IB_WEB_PORT=8080 node internal-beyond-server.js
 *
 * Idempotency: the launcher checks /health before starting; this server exits
 * with a distinct code (3) if its port is already bound by another process so
 * the launcher can report a conflict instead of creating a duplicate.
 *
 * GET /__boot-state (P2): read-only view of the launch record written by
 * launch-internal-beyond.js, so the UI can tell normal / degraded / fatal apart
 * without inventing a second state model. Same-origin only (no CORS headers),
 * no-store, and the record is re-scrubbed on read (no credentials, ever).
 *
 * GET /health (P7): also reports the product version from the single release
 * source (./VERSION), so Diagnostics and the Guide never hand-write a version.
 *
 * POST /__shutdown (P7): graceful stop of this static server, used by the
 * installer before replacing files on upgrade. Loopback bind + Origin guard
 * only; there is no unauthenticated remote surface.
 *
 * GET /__update-check (U2): the browser's only way to ask "is there a newer
 * version?". It is a THIN endpoint: every decision (transport, validation,
 * version comparison, caching) lives in runtime/update-check.js, because U-D4
 * makes Node the single source of truth and forbids the browser from
 * implementing a second manifest validator or semver compare.
 *
 *   · Never runs at startup — nothing here fires a check while booting, so a
 *     slow or dead network can never delay or break a launch.
 *   · `?force=1` is the manual check (bypasses the 24 h cache); without it the
 *     cached answer is served when it is younger than 24 h.
 *   · Concurrent callers share one round trip (single flight), so a reloaded
 *     Diagnostics page cannot stampede GitHub.
 *   · Always HTTP 200 with a status field. "Cannot check" is a normal answer
 *     ('no-information'), never an error status the UI would have to treat as a
 *     failure. Failures never write the cache.
 *   · This is the only outbound request the product makes on its own behalf,
 *     and it is same-origin guarded like /__shutdown.
 *
 * POST /__update/start (U3): begin downloading and installing the pending
 * update. The request body may carry a version confirmation and NOTHING else
 * (U-D6 item 7): no URL, no hash, no path. The server resolves the manifest from
 * its own verified cache, checks the confirmation against it, and starts
 * runtime/update-install.js as a short-lived detached helper, which exits as soon
 * as the installer is running. This endpoint never downloads anything itself, so
 * a slow link cannot hold a request open and a crash here cannot leave a
 * half-download behind.
 *
 * GET /__update/status (U3): read-only projection of that helper's state file
 * (%LOCALAPPDATA%\InternalBeyond\updates\update-install-state.json). U4 renders
 * it; this server invents nothing about the update's progress.
 *
 * Path safety (P7 hardening): requests are resolved inside the served root and
 * hidden/denylisted segments (`.git`, `.env`, `logs`, `node_modules`, ...) are
 * refused outright, so a dev checkout served by this process cannot be walked
 * into from the browser even though the release payload never contains them.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bootState = require('../runtime/boot-state.js');
const productVersion = require('../runtime/product-version.js');
/* P11-3H：停止面判定（唯一实现；Bridge / Active / Home Node 用的是同一份）。 */
const serviceControl = require('../runtime/service-control.js');
const { isTauriOrigin } = require('../runtime/host-origin.js');
const { createProjectKnowledge } = require('./project-knowledge.js');
const { createPackagingCenterApi } = require('./packaging-center-api.js');

/*
 * The update runtime is loaded DEFENSIVELY, and this is load-bearing.
 *
 * The U-series invariant is "更新失败不得阻塞启动" (fail-open). A hard require
 * would mean a missing or unloadable update module — a partial install, a
 * mid-refactor checkout, a future edit gone wrong — takes down the static
 * server, and with it the entire app: the user would see IB simply fail to
 * start because of a feature they never asked for. So the module is optional
 * here: without it the server starts normally and /__update-check answers
 * "no information".
 */
let updateCheck = null;
let updateCheckLoadError = null;
try {
  updateCheck = require('../runtime/update-check.js');
} catch (err) {
  updateCheck = null;
  updateCheckLoadError = 'the update runtime could not be loaded: ' + String((err && err.message) || err);
}

/*
 * The install half (U3) is loaded DEFENSIVELY for the same reason: /__update/start
 * and /__update/status degrade to a named "unavailable" answer, and the app —
 * which has nothing to do with updating — starts normally regardless.
 */
let updateInstall = null;
let updateInstallLoadError = null;
try {
  updateInstall = require('../runtime/update-install.js');
} catch (err) {
  updateInstall = null;
  updateInstallLoadError = 'the update install runtime could not be loaded: ' + String((err && err.message) || err);
}

/* Served web root == repository root (and == installed app root). This file
   lives in services/, so the root is one level up — never __dirname itself,
   or 23120 would only serve services/ and the whole UI would 404. */
const ROOT = path.resolve(__dirname, '..');

/* Top-level directories that are never part of the web app. Hidden segments
   (any segment starting with ".") are refused separately. `runtime` and `tools`
   exist only for the launcher/installer: the browser never requests them, and
   serving a 92 MB node.exe or internal helper scripts over HTTP is pointless. */
const DENY_SEGMENTS = ['logs', 'node_modules', 'browser-data', '__pycache__', '.venv-vision', 'runtime', 'tools'];

function optionPort(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

/* Resolve a request path safely within the project root. Returns null when the
   target escapes the root (path traversal), is denylisted, is hidden, or is a
   directory. */
function resolveRequest(root, urlPath) {
  let rel = '';
  try { rel = decodeURIComponent(String(urlPath || '').split('?')[0].split('#')[0]); }
  catch (e) { return null; } /* malformed percent-encoding → refuse */
  if (rel === '' || rel === '/') rel = '/InternalBeyond.html';
  if (rel === '/health' || rel === '/__health') return null; /* handled by caller */
  const relNoLead = rel.replace(/^[/\\]+/, '');
  /* Hidden and denylisted segments are refused before touching the filesystem:
     .git/, .env, logs/, node_modules/, browser-data/ can never be served even
     from a developer checkout. */
  const segments = relNoLead.split(/[/\\]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
    if (seg.charAt(0) === '.') return null;
  }
  const top = String(segments[0] || '').toLowerCase();
  if (DENY_SEGMENTS.indexOf(top) >= 0) return null;
  const target = path.resolve(root, '.' + path.sep + relNoLead);
  const normRoot = path.resolve(root);
  if (target !== normRoot && !target.startsWith(normRoot + path.sep)) return null; /* traversal */
  let stat = null;
  try { stat = fs.statSync(target); } catch (e) { return null; }
  if (stat.isDirectory()) {
    /* serve InternalBeyond.html as the directory index; else null */
    const index = path.join(target, 'InternalBeyond.html');
    if (fs.existsSync(index)) return { file: index, type: 'text/html; charset=utf-8' };
    return null;
  }
  if (!stat.isFile()) return null;
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  return { file: target, type: type };
}

/* Same origin policy as the runner's restart control plane: local callers (no
   Origin), file:// pages and loopback origins are allowed; anything else is
   denied. This server is loopback-bound, so this only defends against a
   browser page on a foreign origin.
   Shared by BOTH control endpoints: /__shutdown and /__update-check (which
   reaches out to the network, so a foreign page must never be able to trigger
   it — that would be free GitHub API quota for anyone who can get the user to
   open a page). */
function shutdownOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:') return true;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const host = String(u.hostname).toLowerCase();
      if (isTauriOrigin(origin) || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    }
  } catch (e) { /* illegal origin → deny */ }
  return false;
}

/* The packaged Tauri page lives at tauri.localhost and reaches this loopback
   service cross-origin. Permit only the small set of web-host control routes
   needed by Diagnostics and Updates; ordinary browser pages remain same-origin. */
const TAURI_CORS_METHODS = Object.freeze({
  '/health': ['GET'],
  '/__health': ['GET'],
  '/__boot-state': ['GET'],
  '/__update-check': ['GET'],
  '/__update/status': ['GET'],
  '/__update/start': ['POST']
});

function dispatchTauriCors(req, res, pathname) {
  const origin = String(req.headers.origin || '').trim();
  const methods = TAURI_CORS_METHODS[pathname];
  if (!methods || !isTauriOrigin(origin)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method !== 'OPTIONS') return false;

  const requestedMethod = String(req.headers['access-control-request-method'] || '').trim().toUpperCase();
  const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
    .split(',').map(function (value) { return value.trim().toLowerCase(); }).filter(Boolean);
  if (methods.indexOf(requestedMethod) < 0 || requestedHeaders.some(function (header) { return header !== 'content-type'; })) {
    res.writeHead(403, { 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  const headers = {
    'Access-Control-Allow-Methods': methods.join(', ') + ', OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store'
  };
  if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  res.writeHead(204, headers);
  res.end();
  return true;
}

/* Read a small JSON request body. Bounded: a request that keeps sending is
   dropped rather than buffered. Always resolves. */
function readJsonBody(req, maxBytes) {
  return new Promise(function (resolve) {
    const chunks = [];
    let total = 0;
    let settled = false;
    const done = function (value) { if (!settled) { settled = true; resolve(value); } };
    req.on('data', function (chunk) {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        /* Stop accumulating, answer, and keep draining so the caller receives the
           answer instead of a reset. A sender that never stops is dropped after a
           bounded grace period (the timer is unref'd: it can never hold the
           process open). */
        done({ ok: false, kind: 'body-too-large', why: 'request body over ' + maxBytes + ' bytes' });
        try { req.resume(); } catch (e) { }
        const giveUp = setTimeout(function () { try { req.destroy(); } catch (e) { } }, 3000);
        if (typeof giveUp.unref === 'function') giveUp.unref();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      if (!raw) { done({ ok: true, json: {} }); return; }
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) {
        done({ ok: false, kind: 'bad-json', why: 'the request body is not valid JSON' });
        return;
      }
      done({ ok: true, json: parsed });
    });
    req.on('error', function (err) {
      done({ ok: false, kind: 'body-read-failed', why: String((err && err.message) || err) });
    });
  });
}

/*
 * POST /__update/start — the user's "download and install" confirmation.
 *
 * The security shape of this endpoint is one allowlist and one comparison:
 *
 *   · the body may contain `version` and nothing else (U-D6 item 7). A body
 *     carrying url / sha256 / path / file is REFUSED BY NAME rather than
 *     ignored, so a future UI can never quietly start depending on it.
 *   · the version must equal the version of the manifest this server itself has
 *     verified and cached. The browser cannot name what gets installed.
 *
 * Everything else — which URL, which hash, where the file goes — is resolved by
 * runtime/update-install.js from that same verified cache.
 */
function respondUpdateStart(req, res, ctx) {
  const install = ctx.install;
  const check = ctx.check;
  const respond = function (status, body) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const refuse = function (status, kind, message) {
    respond(status, { ok: false, error: { kind: kind, message: message } });
  };

  if (req.method !== 'POST') return refuse(405, 'method-not-allowed', 'POST only');
  if (!shutdownOriginAllowed(req)) return refuse(403, 'origin-denied', 'the request came from another origin');
  if (!install || !check) {
    return refuse(503, 'update-module-unavailable', ctx.installError || 'the update runtime is unavailable');
  }

  readJsonBody(req, 4096).then(function (body) {
    if (!body.ok) return refuse(400, body.kind, body.why);
    const payload = body.json;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return refuse(400, 'bad-body', 'the request body must be a JSON object');
    }

    /* U-D6 item 7: a version confirmation, or an opaque id — nothing that could
       locate or describe a payload. */
    const extra = Object.keys(payload).filter(function (k) { return k !== 'version'; });
    if (extra.length) {
      return refuse(400, 'browser-supplied-transport-fields',
        'the browser may not choose what gets installed; unexpected field(s): ' + extra.join(', '));
    }
    const version = typeof payload.version === 'string' ? payload.version.trim() : '';
    if (!version) return refuse(400, 'version-required', 'a version confirmation is required');

    /* The ONLY manifest this server will install from: its own verified cache. */
    const cached = check.readCache({ now: Date.now() });
    if (!cached || !cached.hit) {
      return refuse(409, 'no-verified-manifest',
        'there is no verified update information to install from; check for updates again');
    }
    const latest = String((cached.manifest && cached.manifest.version) || '');
    if (latest !== version) {
      return refuse(409, 'version-mismatch',
        'the verified update is ' + JSON.stringify(latest) + ', not ' + JSON.stringify(version));
    }

    const state = install.readState({});
    /* A busy check, not just a state check: the lock also covers the window
       before the helper has written anything, and the install itself. */
    if (install.isBusy ? install.isBusy({}) : state.active) {
      return refuse(409, 'already-in-progress', 'an update download is already running');
    }

    const started = install.spawnHelper({ version: version });
    if (!started.ok) return refuse(503, 'start-failed', started.why);

    /* The helper is a separate detached process; this request does not wait for
       it and does not track it. U4 polls /__update/status. */
    return respond(202, { ok: true, accepted: true, version: version, state: 'starting' });
  });
}

/* Stop accepting connections and exit. `opts.onShutdown` lets tests observe the
   request without terminating the test process. */function performShutdown(server, opts) {
  const o = opts || {};
  if (typeof o.onShutdown === 'function') {
    try { o.onShutdown({ port: server.port, identity: server.identity }); } catch (e) { }
    return;
  }
  const exit = function () { try { process.exit(0); } catch (e) { } };
  setTimeout(function () {
    try {
      server.close(exit);
      /* P11-3H：调用方自己的 keep-alive 连接也算"开着的连接"，只调 server.close()
         会让这个已经被停掉的进程一直活到 fallback kill。宽限之后关闭它们。 */
      serviceControl.closeListenerBounded(server, { graceMs: 150 });
      /* Bounded: a lingering keep-alive connection must never keep the old
         build alive while the installer replaces files. */
      setTimeout(exit, 2000).unref();
    } catch (e) { exit(); }
  }, 120);
}

function createWebServer(opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const host = o.host || '127.0.0.1';
  const port = o.port || optionPort('IB_WEB_PORT', 23120);
  const identity = o.identity || 'InternalBeyond Web';
  /* Injection seams for tests. Production always uses the modules above; a test
     may substitute a stub so it can exercise the endpoint contract without a
     network or a real install. */
  const check = o.updateCheck || updateCheck;
  const install = o.updateInstall || updateInstall;
  const acceptanceSecretRoutes = process.env.IB_ACCEPTANCE_SECRET_ROUTES === '1';
  const acceptanceSecretRoutesRunId = String(process.env.IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID || '');
  let acceptanceSecretRouteResult = null;
  let acceptanceSecretRouteGetLogged = false;
  function acceptanceTransportLog(event) {
    if (!acceptanceSecretRoutes) return;
    const runId = (acceptanceSecretRoutesRunId || 'missing').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'missing';
    const line = 'ts=' + Date.now() + ' pid=' + process.pid + ' runId=' + runId + ' event=' + String(event) + '\n';
    try { fs.appendFileSync(path.join(os.tmpdir(), 'p32-w3a-' + runId + '-transport.log'), line); } catch (_) {}
  }
  acceptanceTransportLog('M2_SERVER_BOOT');
  /* P32: the Browser adapter uses this same allowlisted, read-only resolver.
     Tauri uses its Rust counterpart; neither path exposes the repository root. */
  const projectKnowledge = o.projectKnowledge || createProjectKnowledge({ root: root });
  const packagingApiOptions = { root: root, originAllowed: shutdownOriginAllowed };
  if (Object.prototype.hasOwnProperty.call(o, 'packagingControlPlane')) {
    packagingApiOptions.controlPlane = o.packagingControlPlane;
  }
  const packagingApi = o.packagingApi || createPackagingCenterApi(packagingApiOptions);

  /* P11-3H · 停止面的判定（唯一实现在 runtime/service-control.js）。
     `exposeBody:false`：本文件的 /__shutdown 从 P7 起就回答
     `{ ok:true, server, shuttingDown:true }`，那是被 installer 契约与
     tests/test_installer.js 钉住的形状；判定由共享模块给，载荷仍由本文件给。 */
  const stopDispatch = serviceControl.createStopDispatch({
    service: identity,
    exposeBody: false,
    onAccepted: info => { try { console.log('[web] stop requested (pid ' + info.pid + ', port ' + port + ')'); } catch (e) { } }
  });

  const server = http.createServer(function (req, res) {
    const pathname = String(req.url || '/').split('?')[0];
    if (dispatchTauriCors(req, res, pathname)) return;
    let requestUrl = null;
    try { requestUrl = new URL(String(req.url || '/'), 'http://127.0.0.1'); } catch (_) { }
    if (packagingApi.handle(req, res, pathname, requestUrl)) return;
    if (pathname === '/health' || pathname === '/__health') {
      const pv = productVersion.get();
      const body = JSON.stringify({ ok: true, server: identity, version: pv.ok ? pv.version : '' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (pathname === '/__p32-w3a/acceptance') {
      /* W3A is an explicit, memory-only acceptance seam. It is absent from
         normal production processes and accepts only the fixed probe's bounded
         result shape; it never serves DOM, credentials, or arbitrary commands. */
      const origin = String(req.headers.origin || '').trim();
      const originOk = shutdownOriginAllowed(req);
      const cors = {};
      if (req.method === 'GET' && !acceptanceSecretRouteGetLogged) {
        acceptanceSecretRouteGetLogged = true;
        acceptanceTransportLog('M2_ENDPOINT_GET_FIRST');
      }
      if (req.method === 'POST') acceptanceTransportLog('M2_ENDPOINT_POST_RECEIVED');
      if (origin && originOk) {
        cors['Access-Control-Allow-Origin'] = origin;
        cors.Vary = 'Origin';
      }
      if (!acceptanceSecretRoutes) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'acceptance-disabled' }));
        return;
      }
      if (!originOk) {
        acceptanceTransportLog('M2_ORIGIN_DENIED');
        res.writeHead(403, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: false, error: 'origin-denied' }));
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign({
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
          'Cache-Control': 'no-store'
        }, cors));
        res.end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: true, ready: !!acceptanceSecretRouteResult, result: acceptanceSecretRouteResult }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      readJsonBody(req, 32768).then(function (body) {
        if (!body.ok || !body.json || typeof body.json !== 'object' || Array.isArray(body.json)) {
          res.writeHead(400, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
          res.end(JSON.stringify({ ok: false, error: body.kind || 'bad-body' }));
          return;
        }
        const input = body.json;
        const phases = ['probe_started', 'document_state', 'tauri_recognized', 'nav_home_found', 'probe_complete', 'probe_failed'];
        if (input.schemaVersion !== 1 || typeof input.runId !== 'string' || input.runId !== acceptanceSecretRoutesRunId || phases.indexOf(input.phase) < 0) {
          acceptanceTransportLog('M2_RUN_MISMATCH');
          res.writeHead(409, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
          res.end(JSON.stringify({ ok: false, error: 'acceptance-run-mismatch' }));
          return;
        }
        const phaseRank = {
          probe_started: 1,
          document_state: 2,
          tauri_recognized: 3,
          nav_home_found: 4,
          probe_complete: 5,
          probe_failed: 6
        };
        if (acceptanceSecretRouteResult && acceptanceSecretRouteResult.runId === input.runId &&
            phaseRank[input.phase] < (phaseRank[acceptanceSecretRouteResult.phase] || 0)) {
          acceptanceTransportLog('M2_PHASE_REGRESSION_IGNORED');
          res.writeHead(202, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
          res.end(JSON.stringify({ ok: true, accepted: true, retained: true }));
          return;
        }
        if (acceptanceSecretRouteResult && acceptanceSecretRouteResult.done === true && input.done !== true) {
          acceptanceTransportLog('M2_AFTER_DONE_IGNORED');
          res.writeHead(202, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
          res.end(JSON.stringify({ ok: true, accepted: true, terminal: true }));
          return;
        }
        const boolKeys = [
          'ready', 'tauri', 'navHome', 'initialConsoleHidden', 'sixClicksNoConsole',
          'timeoutReset', 'consoleOpened', 'consoleInput', 'consoleFocus',
          'maliciousRejected', 'beyondOpened', 'beyondClosed', 'consoleReopened',
          'middlebrainOpened', 'noNormalPage', 'middlebrainClosed', 'hashReturned',
          'noMiddlebrainQuery', 'directMessageSent', 'done'
        ];
        const output = { schemaVersion: 1, runId: input.runId.slice(0, 64), phase: input.phase, reportedAt: Date.now() };
        boolKeys.forEach(function (key) { output[key] = input[key] === true; });
        ['origin', 'pathname', 'error'].forEach(function (key) {
          if (typeof input[key] === 'string') output[key] = input[key].slice(0, 256);
        });
        if (['loading', 'interactive', 'complete'].indexOf(input.readyState) >= 0) output.readyState = input.readyState;
        if (Number.isInteger(input.documentSeq) && input.documentSeq >= 0 && input.documentSeq <= 10000) output.documentSeq = input.documentSeq;
        if (['BLANK', 'OPAQUE', 'INTERNALBEYOND', 'OTHER_LOCAL', 'UNEXPECTED', 'BOOTSTRAP'].indexOf(input.urlClass) >= 0) output.urlClass = input.urlClass;
        if (['initialization', 'started', 'finished'].indexOf(input.pageLoadPhase) >= 0) output.pageLoadPhase = input.pageLoadPhase;
        ['hrefClass', 'originClass', 'pathnameClass'].forEach(function (key) {
          if (['TAURI', 'ASSET', 'HTTP', 'HTTPS', 'FILE', 'ABOUT', 'DATA', 'OTHER', 'CUSTOM', 'EMPTY', 'TAURI_LOCAL', 'LOOPBACK', 'OPAQUE', 'INTERNALBEYOND', 'ROOT'].indexOf(input[key]) >= 0) output[key] = input[key];
        });
        ['titlePresent', 'bodyPresent', 'ibMarkerPresent', 'ibHostPresent'].forEach(function (key) {
          if (typeof input[key] === 'boolean') output[key] = input[key];
        });
        if (typeof input.errorCode === 'string') output.errorCode = input.errorCode.slice(0, 64);
        output.modelCallsObserved = Number.isInteger(input.modelCallsObserved) && input.modelCallsObserved >= 0 && input.modelCallsObserved <= 1 ? input.modelCallsObserved : 0;
        output.elapsedMs = Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0 && input.elapsedMs <= 60000 ? Math.floor(input.elapsedMs) : 0;
        acceptanceSecretRouteResult = output;
        acceptanceTransportLog('M2_PHASE_' + input.phase.toUpperCase());
        acceptanceTransportLog('M2_BODY_ACCEPTED');
        res.writeHead(202, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: true, accepted: true }));
      });
      return;
    }
    if (pathname === '/__p32-w3a/acceptance') {
      /* P32-W.3A is a fixed, memory-only acceptance seam. It is unreachable
         unless the explicit test environment gate is present. The endpoint
         accepts only bounded boolean/URL metadata from the fixed Rust probe. */
      const origin = String(req.headers.origin || '').trim();
      const originOk = shutdownOriginAllowed(req);
      const cors = {};
      if (origin && originOk) { cors['Access-Control-Allow-Origin'] = origin; cors.Vary = 'Origin'; }
      if (!acceptanceSecretRoutes) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'acceptance-disabled' }));
        return;
      }
      if (!originOk) {
        res.writeHead(403, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: false, error: 'origin-denied' }));
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign({
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
          'Cache-Control': 'no-store'
        }, cors));
        res.end();
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: true, ready: !!acceptanceSecretRouteResult, result: acceptanceSecretRouteResult }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      readJsonBody(req, 32768).then(function (body) {
        if (!body.ok || !body.json || typeof body.json !== 'object' || Array.isArray(body.json)) {
          res.writeHead(400, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
          res.end(JSON.stringify({ ok: false, error: body.kind || 'bad-body' }));
          return;
        }
        const input = body.json;
        const boolKeys = [
          'ready', 'tauri', 'navHome', 'initialConsoleHidden', 'sixClicksNoConsole',
          'timeoutReset', 'consoleOpened', 'consoleInput', 'consoleFocus',
          'maliciousRejected', 'beyondOpened', 'beyondClosed', 'consoleReopened',
          'middlebrainOpened', 'noNormalPage', 'middlebrainClosed', 'hashReturned',
          'noMiddlebrainQuery', 'directMessageSent', 'done'
        ];
        const output = { schema: 'p32-w3a.v1', reportedAt: Date.now() };
        boolKeys.forEach(function (key) { output[key] = input[key] === true; });
        ['origin', 'pathname', 'error'].forEach(function (key) {
          if (typeof input[key] === 'string') output[key] = input[key].slice(0, 256);
        });
        output.modelCallsObserved = Number.isInteger(input.modelCallsObserved) && input.modelCallsObserved >= 0 && input.modelCallsObserved <= 1 ? input.modelCallsObserved : 0;
        output.elapsedMs = Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0 && input.elapsedMs <= 60000 ? Math.floor(input.elapsedMs) : 0;
        acceptanceSecretRouteResult = output;
        res.writeHead(202, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors));
        res.end(JSON.stringify({ ok: true, accepted: true }));
      });
      return;
    }
    if (pathname === '/__shutdown') {
      /* P11-3H：同一个停止判定来自 runtime/service-control.js（与 Bridge /
         Active / Home Node 逐字同一份），而不是本文件自己再写一遍方法与来源
         检查 —— 四个组件里三份实现正是这一阶段要收口的东西。
         返回值：true = 已接受（202 已发出）；'origin-denied' / 'method-not-allowed'
         = 停止面拒绝，拒绝文案仍由本文件按既有形状发出（P7 契约与既有测试断言
         依赖这两个错误名与状态码，不停用它们）。 */
      const decision = stopDispatch(req, res);
      if (decision === true) {
        /* P7 契约（被 installer 与 tests/test_installer.js 钉住）：202 + 这个载荷。 */
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, server: identity, shuttingDown: true }));
        performShutdown(server, o);
        return;
      }
      if (decision) {
        res.writeHead(decision === 'method-not-allowed' ? 405 : 403,
          { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: decision }));
        return;
      }
    }
    if (pathname === '/__boot-state') {
      /* Read-only launch record. Never fatal when absent: present=false is an
         honest answer (e.g. the server was started outside the launcher). */
      const live = server.address();
      const listeningPort = live && typeof live === 'object' ? live.port : port;
      const read = bootState.readBootState({ expectWebPort: listeningPort });
      const body = JSON.stringify({
        ok: read.ok,
        present: read.present,
        stale: read.stale,
        staleReason: read.staleReason,
        ageMs: read.ageMs,
        schema: bootState.SCHEMA,
        version: bootState.VERSION,
        path: read.path,
        error: read.error,
        bootState: read.state
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }
    if (pathname === '/__update-check') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      if (!shutdownOriginAllowed(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'origin-denied' }));
        return;
      }
      /* Manual check = force. Anything else may be served from the 24 h cache.
         A malformed query string is simply "not forced". */
      let force = false;
      try {
        const q = new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams;
        force = q.get('force') === '1' || q.get('force') === 'true';
      } catch (e) { force = false; }

      const respond = function (payload) {
        /* The client may have navigated away while we were on the network. */
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      };

      /* "Cannot check" is always a 200 with a status in the body — never a
         status code the UI would have to interpret as a failure. */
      const respondNoInformation = function (kind, message) {
        respond({
          ok: false,
          /* Frozen literal, used only when the module is unavailable and its
             constant therefore cannot be read. Same value, same contract. */
          status: check ? check.STATUS_NO_INFORMATION : 'no-information',
          updateAvailable: false,
          currentVersion: '',
          latestVersion: '',
          fromCache: false,
          transport: '',
          checkedAt: '',
          error: { kind: kind, message: message },
          update: null
        });
      };

      if (!check) {
        respondNoInformation('update-module-unavailable', updateCheckLoadError);
        return;
      }

      check.checkShared({ force: force }).then(function (result) {
        respond(check.summarize(result));
      }, function (err) {
        /* check() never rejects, and this branch exists so a future bug cannot
           leave a Diagnostics request hanging forever. */
        respondNoInformation('internal-error', String((err && err.message) || err));
      });
      return;
    }
    if (pathname === '/__update/start') {
      respondUpdateStart(req, res, { install: install, check: check, installError: updateInstallLoadError });
      return;
    }
    if (pathname === '/__update/status') {
      const body = install
        ? install.summarizeState(install.readState({}))
        : {
          ok: false, state: 'unavailable', active: false, version: '', transport: '',
          bytes: 0, totalBytes: 0, startedAt: '', updatedAt: '', finishedAt: '',
          error: { kind: 'update-module-unavailable', message: updateInstallLoadError }
        };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    if (pathname.indexOf('/__project-knowledge') === 0) {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      if (!shutdownOriginAllowed(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'origin-denied' }));
        return;
      }
      let url;
      try { url = new URL(String(req.url || '/'), 'http://127.0.0.1'); } catch (_) { url = null; }
      let payload;
      if (!url) payload = { ok: false, error: 'invalid-request' };
      else if (url.pathname === '/__project-knowledge/status') payload = projectKnowledge.status();
      else if (url.pathname === '/__project-knowledge/list') payload = projectKnowledge.listProjectDocs();
      else if (url.pathname === '/__project-knowledge/search') {
        payload = projectKnowledge.searchProjectDocs(url.searchParams.get('q') || '', {
          limit: url.searchParams.get('limit'),
          authority: url.searchParams.get('authority')
        });
      } else if (url.pathname === '/__project-knowledge/read') {
        payload = projectKnowledge.readProjectDoc(url.searchParams.get('docId') || '', url.searchParams.get('section') || '');
      } else payload = { ok: false, error: 'not-found' };
      const statusCode = payload && payload.ok === false && payload.error === 'not-found' ? 404 : 200;
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    const hit = resolveRequest(root, req.url);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      const data = fs.readFileSync(hit.file);
      res.writeHead(200, {
        'Content-Type': hit.type,
        'Cache-Control': 'no-store',
        'Content-Length': data.length
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  });

  server.port = port;
  server.host = host;
  server.identity = identity;

  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      /* Port already bound by another process; distinct exit code for the launcher. */
      server.__bindError = err.code;
      if (o.listenOnError) o.listenOnError(err.code);
      try { process.exitCode = 3; } catch (_) { }
    }
  });

  return server;
}

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(server.port, server.host, function () { resolve(server.port); });
  });
}

module.exports = {
  createWebServer: createWebServer,
  resolveRequest: resolveRequest,
  MIME: MIME
};

if (require.main === module) {
  const server = createWebServer({});
  listen(server).then(function (port) {
    console.log('[InternalBeyond Web] serving ' + ROOT + ' at http://127.0.0.1:' + port + '/');
  }).catch(function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[InternalBeyond Web] port ' + server.port + ' already bound by another process; not starting a duplicate.');
      process.exit(3);
    }
    console.error('[InternalBeyond Web] failed to start:', err && err.stack || err);
    process.exit(1);
  });
}
