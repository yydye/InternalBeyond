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
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;

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
   target escapes the root (path traversal) or is a directory. */
function resolveRequest(root, urlPath) {
  let rel = decodeURIComponent(String(urlPath || '').split('?')[0].split('#')[0]);
  if (rel === '' || rel === '/') rel = '/InternalBeyond.html';
  if (rel === '/health' || rel === '/__health') return null; /* handled by caller */
  const target = path.resolve(root, '.' + path.sep + rel.replace(/^\//, ''));
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

function createWebServer(opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const host = o.host || '127.0.0.1';
  const port = o.port || optionPort('IB_WEB_PORT', 23120);
  const identity = o.identity || 'InternalBeyond Web';

  const server = http.createServer(function (req, res) {
    const pathname = String(req.url || '/').split('?')[0];
    if (pathname === '/health' || pathname === '/__health') {
      const body = JSON.stringify({ ok: true, server: identity });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
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
