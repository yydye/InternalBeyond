'use strict';

/*
 * InternalBeyond Release Builder · local server + GUI host.
 *
 * Why a local server and the system default browser, instead of a desktop GUI
 * toolkit: this repository's product decision (Zero-Setup release decision) is
 * "Node owns the truth, the browser only renders", and it deliberately does not
 * bring in Electron/Tauri/WebView2. The Release Builder follows the same rule,
 * so it adds ZERO new dependencies and still ships as one double-clickable
 * executable (launcher/IB-Release-Builder.cs → the repo's own node.exe).
 *
 * Local-only by construction:
 *   · binds 127.0.0.1 on an ephemeral port;
 *   · every request needs the boot token issued on stdout at startup (a random
 *     32-byte hex value), so another local process cannot drive a release;
 *   · state-changing requests must carry a same-origin Origin/Referer or none
 *     at all, and must be POST;
 *   · no static path may escape public/.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Runner } = require('./lib/runner.js');
const canonical = require('./lib/canonical.js');
const plan = require('./lib/plan.js');
const notesPath = require('./lib/notes.js');
const publishStage = require('./lib/publish.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
/* Generous for a release-notes file, small enough that the editor cannot be
   used as a way to write an arbitrary large file into the checkout. */
const MAX_NOTES_BYTES = 256 * 1024;
const TOKEN = crypto.randomBytes(32).toString('hex');
const MAX_BODY = 1 << 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

function sameOrigin(req) {
  const origins = [req.headers.origin, req.headers.referer].filter(Boolean);
  if (!origins.length) return true; /* a local CLI client with the token */
  for (const raw of origins) {
    let u = null;
    try { u = new URL(raw); } catch (e) { return false; }
    const host = u.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') return false;
  }
  return true;
}

function tokenFrom(req, url) {
  const h = String(req.headers['x-ib-release-token'] || '');
  if (h) return h;
  const q = url.searchParams.get('token');
  return q || '';
}

function readBody(req) {
  return new Promise(function (resolve) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve(null); }
    });
    req.on('error', function () { resolve(null); });
  });
}

function start(opts) {
  const o = opts || {};
  const discovery = canonical.discover(__dirname, o.root || '');
  const runner = new Runner({ root: discovery.root });
  let lastLogSeq = 0;
  let pendingPublish = null; /* { fingerprint, actions, createdAt } */

  const server = http.createServer(async function (req, res) {
    let url = null;
    try { url = new URL(String(req.url || '/'), 'http://127.0.0.1'); } catch (e) { url = null; }
    if (!url) { res.writeHead(400).end('bad request'); return; }

    const isApi = url.pathname.indexOf('/api/') === 0;

    const send = function (code, obj) {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(body);
    };

    if (isApi) {
      if (tokenFrom(req, url) !== TOKEN) return send(403, { ok: false, error: 'token-required' });
      if (!sameOrigin(req)) return send(403, { ok: false, error: 'origin-denied' });
    }

    /* ── snapshot ───────────────────────────────────────────────────────── */
    if (url.pathname === '/api/snapshot') {
      const since = Number(url.searchParams.get('since') || '0');
      if (!Number.isFinite(since) || since < 0 || since > lastLogSeq + 100000) lastLogSeq = 0;
      const snap = runner.snapshot(Number.isFinite(since) ? since : 0);
      lastLogSeq = snap.log.seq;
      return send(200, { ok: true, snapshot: snap });
    }

    /* ── root selection ─────────────────────────────────────────────────── */
    if (url.pathname === '/api/root' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.root !== 'string') return send(400, { ok: false, error: 'bad-body' });
      const disc = canonical.discover(__dirname, body.root);
      if (runner.running) return send(409, { ok: false, error: 'busy' });
      const fresh = new Runner({ root: disc.root });
      runner.root = fresh.root;
      runner.repo = fresh.repo;
      runner.openError = fresh.openError;
      runner.stages = fresh.stages;
      runner.results = {};
      runner.log = fresh.log;
      runner.lastError = fresh.openError;
      lastLogSeq = 0;
      runner.log.event('checkout opened: ' + (disc.root || '(none)') + ' via ' + disc.via);
      return send(200, { ok: !!disc.root, describe: runner.describe(), tried: disc.tried || [] });
    }

    /* ── options ────────────────────────────────────────────────────────── */
    if (url.pathname === '/api/options' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return send(400, { ok: false, error: 'bad-body' });
      runner.setOptions(body);
      return send(200, { ok: true, options: runner.options });
    }

    /* ── open a folder for the operator (read-only convenience) ─────────── */
    /*
     * Two things a person needs to touch with their own hands after a build:
     * the dist folder (to hand the installer to someone) and this release's log
     * file. This endpoint opens them in Explorer. It reads no repository state
     * beyond listing dist, writes nothing, and takes a fixed keyword rather than
     * a path — so it can never be pointed at an arbitrary file.
     */
    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || (body.what !== 'dist' && body.what !== 'log')) return send(400, { ok: false, error: 'bad-body' });
      if (!runner.repo) return send(200, { ok: false, error: 'no-repo', why: '还没有识别到仓库根目录。' });
      const dist = path.join(runner.repo.root, 'dist');
      const { spawn } = require('child_process');
      const open = function (args) {
        try {
          const p = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
          p.unref();
          return true;
        } catch (e) { return false; }
      };
      if (body.what === 'dist') {
        if (!fs.existsSync(dist)) return send(200, { ok: false, error: 'dist-missing', why: 'dist 目录还不存在：先完成一次构建。' });
        if (!open([dist])) return send(200, { ok: false, error: 'open-failed', why: '无法调起资源管理器。' });
        return send(200, { ok: true, opened: dist });
      }
      let newest = null;
      try {
        for (const n of fs.readdirSync(dist)) {
          if (!/^release-.*\.log$/.test(n)) continue;
          const st = fs.statSync(path.join(dist, n));
          if (!newest || st.mtimeMs > newest.ms) newest = { name: n, ms: st.mtimeMs };
        }
      } catch (e) { newest = null; }
      if (!newest) return send(200, { ok: false, error: 'log-missing', why: 'dist 里还没有本次发行的日志文件：先完成一次构建（构建过程中也会写）。' });
      const abs = path.join(dist, newest.name);
      if (!open(['/select,' + abs])) return send(200, { ok: false, error: 'open-failed', why: '无法调起资源管理器。' });
      return send(200, { ok: true, opened: abs });
    }

    /* ── the canonical release notes (read + edit) ──────────────────────── */
    /*
     * The release notes ARE a canonical repository file, not a GUI artifact:
     * lib/publish.js hands docs/release-notes/<target>.md to
     * `gh release create --notes-file`, lib/seal.js folds its text into the
     * manifest, and lib/verify.js proves the manifest still matches it.
     *
     * This endpoint exists so a human can fill that file in without leaving the
     * tool, and it is deliberately the narrowest possible write:
     *   · the path is derived from VERSION's shape by lib/notes.js, the one
     *     place that knows the rule — a caller cannot name a file of its own;
     *   · only docs/release-notes/<MAJOR.MINOR.PATCH>.md can ever be reached,
     *     so this can never touch VERSION, dist/, or source;
     *   · it refuses while a stage is running, and once BUILD has pinned the
     *     notes into a manifest (SEAL or VERIFY green) editing them would
     *     invalidate that run, so it refuses and asks for a re-run instead of
     *     silently making the stored verification untrue.
     */
    if (url.pathname === '/api/notes') {
      if (!runner.repo) return send(200, { ok: false, error: 'no-repo' });
      const target = String((runner.options && runner.options.target) || '').trim();
      if (!/^\d+\.\d+\.\d+$/.test(target)) {
        return send(200, { ok: false, error: 'bad-target', why: '目标版本必须是 MAJOR.MINOR.PATCH（例如 1.0.6）' });
      }
      const abs = notesPath.pathFor(runner.repo.root, target);
      const rel = notesPath.relFor(runner.repo.root, target);
      if (!abs) return send(200, { ok: false, error: 'bad-target' });

      const stageOf = function (n) { return (runner.stages[n] && runner.stages[n].status) || 'pending'; };

      if (req.method === 'GET') {
        if (!fs.existsSync(abs)) return send(200, { ok: true, exists: false, target: target, rel: rel, content: '' });
        let content = '';
        try { content = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''); }
        catch (e) { return send(200, { ok: false, error: 'read-failed', why: String((e && e.message) || e) }); }
        return send(200, { ok: true, exists: true, target: target, rel: rel, content: content });
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body.content !== 'string') return send(400, { ok: false, error: 'bad-body' });
        if (runner.running) return send(409, { ok: false, error: 'busy', stage: runner.running.stage });
        if (Buffer.byteLength(body.content, 'utf8') > MAX_NOTES_BYTES) {
          return send(413, { ok: false, error: 'notes-too-large', limit: MAX_NOTES_BYTES });
        }
        const pinned = ['ok', 'warn'].indexOf(stageOf('SEAL')) >= 0 ? 'SEAL'
          : (['ok', 'warn'].indexOf(stageOf('VERIFY')) >= 0 ? 'VERIFY' : '');
        if (pinned) {
          return send(409, {
            ok: false, error: 'notes-pinned', stage: pinned,
            why: pinned + ' 已用当前这份发行说明完成校验：现在改写它会让那次校验不再成立。先「重置」再改，然后重新运行一遍。'
          });
        }
        const existed = fs.existsSync(abs);
        try {
          /*
           * LF, always. The canonical build reads this file into the manifest and
           * verify compares the two texts, so the bytes must not carry CRLF: a
           * browser textarea posts CRLF, and a file that differs from its own
           * normalized form is a difference git reports forever.
           */
          const text = body.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, text, 'utf8');
        } catch (e) {
          return send(200, { ok: false, error: 'write-failed', why: String((e && e.message) || e) });
        }
        runner.log.event((existed ? 'release notes updated: ' : 'release notes created: ') + rel + ' (' + Buffer.byteLength(body.content, 'utf8') + ' B)');
        return send(200, { ok: true, target: target, rel: rel, created: !existed, bytes: fs.statSync(abs).size });
      }

      return send(405, { ok: false, error: 'method-not-allowed' });
    }

    /* ── stages ─────────────────────────────────────────────────────────── */
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.stage !== 'string') return send(400, { ok: false, error: 'bad-body' });
      if (runner.running) return send(409, { ok: false, error: 'busy', stage: runner.running.stage });
      if (body.options) runner.setOptions(body.options);

      if (body.stage === 'DRY') {
        const r = await runner.runDryRun();
        return send(200, { ok: true, dry: r });
      }
      if (body.stage === 'ONECLICK') {
        /* The sanctioned one-click path: CHECK → BUILD → VERIFY → SEAL → STOP.
           PUBLISH is deliberately not part of it. */
        await runner.runOneClick({ archiveOldReleases: runner.options.archiveOldReleases });
        return send(200, { ok: true, snapshot: runner.snapshot(0) });
      }
      if (body.stage === 'RESET') {
        /* One reset method on the runner, so a reset can never clear half the
           run state (a stale `releaseFacts` would show a SEAL result from a run
           the user just discarded). */
        runner.resetRun();
        lastLogSeq = 0;
        runner.log.event('run state reset by the user');
        return send(200, { ok: true, snapshot: runner.snapshot(0) });
      }
      if (plan.STAGES.indexOf(body.stage) < 0) return send(400, { ok: false, error: 'unknown-stage' });

      if (body.stage === 'PUBLISH') {
        /* PUBLISH never runs from this endpoint without a confirmation bound to
           the artifact fingerprint that the human was shown. */
        const confirmed = String(body.confirmation || '');
        const wanted = body.actions && body.actions.length ? body.actions : ['commit', 'push', 'tag', 'pushTag', 'releaseCreate', 'manifestUpload'];
        const token = publishStage.confirmToken(String(body.fingerprint || ''), wanted);
        if (!confirmed || confirmed !== token) {
          return send(200, { ok: false, error: 'confirmation-required', expectedFingerprint: String(body.fingerprint || '') });
        }
        runner.attempted.PUBLISH = true;
        const r = await runner.runStage('PUBLISH', { actions: wanted, confirmation: confirmed, commitMessage: body.commitMessage, remote: body.remote });
        return send(200, { ok: true, result: { status: r.status, blockers: r.blockers }, snapshot: runner.snapshot(lastLogSeq) });
      }

      if (body.stage === 'BUILD') runner.attempted.BUILD = true;
      if (body.stage === 'VERIFY') runner.attempted.VERIFY = true;
      if (body.stage === 'SEAL') runner.attempted.SEAL = true;
      const stageExtra = { archiveOldReleases: runner.options.archiveOldReleases };
      if (body.stage === 'SEAL') {
        /* The artifact of the version BUILD started from is never archived:
           those bytes may be the published release's bytes, and
           docs/RELEASE.md §6 forbids replacing them with a rebuild. */
        stageExtra.protectedVersions = [runner.versionAtBuildStart].filter(Boolean);
      }
      const r = await runner.runStage(body.stage, stageExtra);
      return send(200, { ok: true, result: { status: r.status, blockers: r.blockers }, snapshot: runner.snapshot(lastLogSeq) });
    }

    /* ── publish plan (read-only preview) ───────────────────────────────── */
    if (url.pathname === '/api/publish-plan') {
      if (!runner.repo) return send(200, { ok: false, error: 'no-repo' });
      const p = publishStage.buildPlan(runner.repo, { target: runner.options.target, remote: 'origin' });
      const actions = p.actions.map(function (a) { return a.id; });
      const token = publishStage.confirmToken(p.fingerprint, actions);
      pendingPublish = { fingerprint: p.fingerprint, actions: actions, at: Date.now() };
      return send(200, {
        ok: p.ok,
        blockers: p.blockers,
        artifact: p.artifact,
        sums: p.sums,
        manifest: p.manifest,
        tag: p.tag,
        branch: p.branch,
        remote: p.remote,
        remoteUrl: p.remoteUrl,
        notesFile: p.notesFile,
        commitPaths: p.commitPaths,
        fingerprint: p.fingerprint,
        confirmation: token,
        actions: p.actions.map(function (a) {
          return { id: a.id, label: a.label, command: a.command, irreversible: a.irreversible, preconditions: a.preconditions };
        })
      });
    }

    /* ── log export ─────────────────────────────────────────────────────── */
    if (url.pathname === '/api/export-log') {
      const text = runner.exportLog();
      const name = 'IB-release-builder-' + (runner.options.target || runner.describe().version || 'unknown') + '-' +
        new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.log';
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + name + '"',
        'Cache-Control': 'no-store'
      });
      return res.end(text);
    }

    /* ── cancel ─────────────────────────────────────────────────────────── */
    if (url.pathname === '/api/cancel' && req.method === 'POST') {
      const ok = runner.cancel();
      return send(200, { ok: ok });
    }

    /* ── static ─────────────────────────────────────────────────────────── */
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.join(PUBLIC_DIR, rel.replace(/^[\\/]+/, ''));
    if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== PUBLIC_DIR) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(abs, function (err, data) {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
    });
  });

  /* The GUI host is not usable until the socket is bound, so `start()` resolves
     once it is — a caller that read the port immediately would otherwise race
     the bind and see null. */
  const ready = new Promise(function (resolve, reject) {
    server.once('listening', function () {
      const addr = server.address();
      const url = 'http://127.0.0.1:' + addr.port + '/?token=' + TOKEN;
      /* The launcher (and any human) reads these lines. The URL carries the boot
         token, which is regenerated every start. */
      process.stdout.write('RELEASE-BUILDER-URL ' + url + '\n');
      process.stdout.write('RELEASE-BUILDER-ROOT ' + (discovery.root || '(none)') + '\n');
      if (!discovery.root) {
        process.stdout.write('RELEASE-BUILDER-WARN no InternalBeyond checkout was found; choose the repository root in the GUI\n');
        if (discovery.tried) for (const t of discovery.tried) process.stdout.write('  tried ' + t + '\n');
      }
      resolve({ server: server, runner: runner, token: TOKEN, port: addr.port, url: url, root: discovery.root });
    });
    server.once('error', function (err) {
      process.stderr.write('server error: ' + String((err && err.message) || err) + '\n');
      process.exitCode = 1;
      reject(err);
    });
  });

  server.listen(o.port || 0, '127.0.0.1');

  return { server: server, runner: runner, token: TOKEN, ready: ready, discovery: discovery };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = function (name) {
    const hit = args.find(function (a) { return a.indexOf('--' + name + '=') === 0; });
    return hit ? hit.slice(name.length + 3) : '';
  };
  const api = start({ root: getArg('root'), port: Number(getArg('port') || 0) });
  api.ready.then(function (info) {
    if (args.indexOf('--open') >= 0) {
      const { spawn } = require('child_process');
      try {
        spawn('cmd.exe', ['/c', 'start', '', info.url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (e) { /* the URL was printed above either way */ }
    }
  }).catch(function () { process.exit(1); });
  process.on('SIGINT', function () { process.exit(0); });
  process.on('SIGTERM', function () { process.exit(0); });
}

module.exports = { start };
