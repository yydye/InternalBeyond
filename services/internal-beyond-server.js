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
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    }
  } catch (e) { /* illegal origin → deny */ }
  return false;
}

/* Stop accepting connections and exit. `opts.onShutdown` lets tests observe the
   request without terminating the test process. */
function performShutdown(server, opts) {
  const o = opts || {};
  if (typeof o.onShutdown === 'function') {
    try { o.onShutdown({ port: server.port, identity: server.identity }); } catch (e) { }
    return;
  }
  const exit = function () { try { process.exit(0); } catch (e) { } };
  setTimeout(function () {
    try {
      server.close(exit);
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

  const server = http.createServer(function (req, res) {
    const pathname = String(req.url || '/').split('?')[0];
    if (pathname === '/health' || pathname === '/__health') {
      const pv = productVersion.get();
      const body = JSON.stringify({ ok: true, server: identity, version: pv.ok ? pv.version : '' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (pathname === '/__shutdown') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      if (!shutdownOriginAllowed(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'origin-denied' }));
        return;
      }
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, server: identity, shuttingDown: true }));
      performShutdown(server, o);
      return;
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
          status: updateCheck ? updateCheck.STATUS_NO_INFORMATION : 'no-information',
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

      if (!updateCheck) {
        respondNoInformation('update-module-unavailable', updateCheckLoadError);
        return;
      }

      updateCheck.checkShared({ force: force }).then(function (result) {
        respond(updateCheck.summarize(result));
      }, function (err) {
        /* check() never rejects, and this branch exists so a future bug cannot
           leave a Diagnostics request hanging forever. */
        respondNoInformation('internal-error', String((err && err.message) || err));
      });
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
