'use strict';

/*
 * Internal Beyond · installer stop + upgrade helpers (P7)
 *
 * Two modes, both called by the Windows installer/uninstaller:
 *
 *   node ib-stop.js --root "<install dir>" [--json] [--timeout-ms 12000] [--dry-run]
 *       Stop ONLY the InternalBeyond instance that provably runs from
 *       <install dir>. --root is REQUIRED; without it the helper refuses to
 *       stop anything.
 *
 *   node ib-stop.js --wait-unlock "<file>" [--timeout-ms 15000]
 *       Wait (bounded) until <file> — normally runtime\node\node.exe — can be
 *       opened for writing, i.e. is no longer mapped by a running process.
 *       Exit 0 = replaceable, 1 = still locked. Used before an in-place
 *       upgrade replaces the bundled runtime.
 *
 * Ownership (root binding):
 *   A process is stopped only when at least one of these proves it belongs to
 *   the given install root:
 *     · CommandLine references the root
 *     · ExecutablePath lives inside the root
 *     · the instance's own /__boot-state reports launcher.root === root
 *   Everything else is reported as `foreign` (another install / checkout /
 *   unrelated Node app) or `unknown` (InternalBeyond, but ownership cannot be
 *   proven) and is NEVER stopped. Occupying a product port is not evidence of
 *   ownership. Image names are never used as evidence, so no global node.exe
 *   cleanup is possible.
 *
 * Stop order for an owned instance: graceful endpoints → bounded wait →
 * verified fallback kill (ownership re-checked per PID).
 *
 * Env overrides match the rest of InternalBeyond: IB_WEB_PORT / IB_RESTART_PORT /
 * IB_BRIDGE_PORT / IB_ACTIVE_PORT.
 */

const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';

/* Every script name that can only belong to InternalBeyond. A command line must
   contain one of these to be considered an InternalBeyond process at all. */
const IB_SCRIPTS = [
  'internal-beyond-server.js',
  'launch-internal-beyond.js',
  'local-services-runner.js',
  'ib-bridge-service.js',
  'active-message-service.js',
  'ib-stop.js'
];

/* Ports owned by InternalBeyond. `kind` drives which stop path applies. */
function serviceTable() {
  const port = function (name, fallback) {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
  };
  return [
    { name: 'web', port: port('IB_WEB_PORT', 23120), health: '/health', identity: function (d) { return !!(d && d.server === 'InternalBeyond Web'); }, stop: '/__shutdown' },
    { name: 'runner', port: port('IB_RESTART_PORT', 23116), health: '/status', identity: function (d) { return !!(d && d.service === 'InternalBeyond Restart'); }, stop: '/shutdown' },
    { name: 'bridge', port: port('IB_BRIDGE_PORT', 23115), health: '/health', identity: function (d) { return !!(d && d.server === 'IB Bridge'); }, stop: null },
    { name: 'active', port: port('IB_ACTIVE_PORT', 23114), health: '/health', identity: function (d) { return !!(d && d.service === 'internal-beyond-active-messages'); }, stop: null }
  ];
}

function request(options) {
  const o = options || {};
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (value) { if (settled) return; settled = true; resolve(value); };
    let req;
    try {
      req = http.request({
        host: HOST, port: o.port, path: o.path, method: o.method || 'GET', timeout: o.timeoutMs || 1500
      }, function (res) {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { raw += c; });
        res.on('end', function () {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* not json */ }
          done({ reachable: true, status: res.statusCode, json: json });
        });
      });
    } catch (e) {
      done({ reachable: false, status: 0, json: null, error: String(e && e.message || e) });
      return;
    }
    req.on('timeout', function () { try { req.destroy(); } catch (e) { } done({ reachable: false, status: 0, json: null, error: 'timeout' }); });
    req.on('error', function (e) { done({ reachable: false, status: 0, json: null, error: String(e && e.code || e && e.message || e) }); });
    req.end();
  });
}

function run(file, args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs || 8000 }, function (err, stdout) {
      resolve({ ok: !err, stdout: String(stdout || ''), error: err ? String(err.message || err) : null });
    });
  });
}

/* ── Identity / evidence ── */

/* A command line is InternalBeyond only when it names one of our scripts.
   Case-insensitive (Windows paths) and tolerant of quoting. */
function commandLineIsInternalBeyond(cmdline) {
  const cl = String(cmdline || '').toLowerCase();
  if (!cl) return false;
  for (const script of IB_SCRIPTS) {
    if (cl.indexOf(script.toLowerCase()) >= 0) return true;
  }
  return false;
}

function normalizeRoot(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

/* True when a path IS the root or lives inside it (used for ExecutablePath and
   for the boot-state launcher.root — both are directories/files, not command
   lines). */
function pathMatchesRoot(p, root) {
  const r = normalizeRoot(root);
  if (!r) return false;
  const v = String(p || '').toLowerCase().replace(/\//g, '\\').replace(/[\\/]+$/, '');
  if (!v) return false;
  return v === r || v.indexOf(r + '\\') === 0;
}

/* True when the command line references the given install root (strong signal,
   recorded as proof — a different root is what makes an instance foreign). */
function commandLineMatchesRoot(cmdline, root) {
  const r = normalizeRoot(root);
  if (!r) return false;
  return String(cmdline || '').toLowerCase().replace(/\//g, '\\').indexOf(r.replace(/\//g, '\\')) >= 0;
}

/* Absolute paths on a command line that point at one of our scripts. Used to
   tell "another install" (absolute path outside our root) apart from
   "cannot prove ownership" (no absolute path at all). */
function ibScriptAbsolutePaths(cmdline) {
  const cl = String(cmdline || '');
  const found = [];
  const re = /[a-zA-Z]:\\[^"'\s]*|\\\\[^"'\s]*/g;
  let m;
  while ((m = re.exec(cl)) !== null) {
    const candidate = m[0].replace(/[",]+$/, '');
    if (IB_SCRIPTS.some(function (s) { return candidate.toLowerCase().indexOf(s.toLowerCase()) >= 0; })) {
      found.push(candidate);
    }
  }
  return found;
}

/*
 * Classify one candidate process against the install root.
 *   own      — proven to belong to this root → may be stopped
 *   foreign  — proven NOT to belong to this root (another install, a dev
 *              checkout, or an unrelated Node app) → never stopped
 *   unknown  — InternalBeyond, but ownership cannot be proven → never stopped,
 *              reported so the user can close it manually
 */
function classifyTarget(evidence, root) {
  const e = evidence || {};
  const proof = [];
  if (pathMatchesRoot(e.executablePath, root)) proof.push('executable-path');
  if (commandLineMatchesRoot(e.commandLine, root)) proof.push('command-line');
  if (pathMatchesRoot(e.bootStateRoot, root)) proof.push('boot-state');
  const ib = commandLineIsInternalBeyond(e.commandLine);
  if (proof.length) return { verdict: 'own', proof: proof, internalBeyond: ib, reason: '' };
  if (!e.commandLine && !e.executablePath && !e.bootStateRoot) {
    return { verdict: 'unknown', proof: [], internalBeyond: false, reason: 'no-evidence' };
  }
  if (!ib) return { verdict: 'foreign', proof: [], internalBeyond: false, reason: 'not-internalbeyond' };
  const abs = ibScriptAbsolutePaths(e.commandLine);
  if (abs.length) return { verdict: 'foreign', proof: [], internalBeyond: true, reason: 'other-root' };
  return { verdict: 'unknown', proof: [], internalBeyond: true, reason: 'unproven-owner' };
}

/* ── Windows process helpers (fixed commands, no user input) ── */

function pidsForPort(port) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const cmd = ['-NoProfile', '-NonInteractive', '-Command',
    '$p=(Get-NetTCPConnection -LocalPort ' + Number(port) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ","; Write-Output $p'];
  return run('powershell.exe', cmd, 8000).then(function (r) {
    if (!r.ok) return [];
    return r.stdout.trim().split(',').map(function (s) { return parseInt(s, 10); })
      .filter(function (n) { return Number.isInteger(n) && n > 0; });
  });
}

/* Command line + executable path of one PID, as JSON (UTF-8 forced). */
function processEvidence(pid) {
  const empty = { pid: pid, commandLine: '', executablePath: '' };
  if (process.platform !== 'win32') return Promise.resolve(empty);
  const cmd = ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '";' +
    'if($p){ [pscustomobject]@{c=$p.CommandLine;e=$p.ExecutablePath} | ConvertTo-Json -Compress }'];
  return run('powershell.exe', cmd, 8000).then(function (r) {
    let d = null;
    try { d = JSON.parse(r.stdout.trim()); } catch (e) { d = null; }
    return {
      pid: pid,
      commandLine: d && d.c ? String(d.c) : '',
      executablePath: d && d.e ? String(d.e) : ''
    };
  });
}

/* Kept for the installer contract tests: the command line of one PID. */
function processCommandline(pid) {
  return processEvidence(pid).then(function (e) { return e.commandLine; });
}

/* The launcher root an instance reports about itself (web port only). */
function bootStateRoot(port) {
  return request({ port: port, path: '/__boot-state', timeoutMs: 1200 }).then(function (r) {
    const root = r && r.json && r.json.bootState && r.json.bootState.launcher && r.json.bootState.launcher.root;
    return root ? String(root) : '';
  });
}

function killPid(pid) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return run('taskkill.exe', ['/F', '/T', '/PID', String(Number(pid))], 8000).then(function (r) { return r.ok; });
}

function portBound(port) {
  const net = require('net');
  return new Promise(function (resolve) {
    const sock = net.connect({ host: HOST, port: port, timeout: 400 });
    let settled = false;
    const done = function (bound) { if (settled) return; settled = true; try { sock.destroy(); } catch (e) { } resolve(bound); };
    sock.on('connect', function () { done(true); });
    sock.on('timeout', function () { done(false); });
    sock.on('error', function () { done(false); });
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (!(await portBound(port))) return true;
    await sleep(200);
  }
  return !(await portBound(port));
}

/* ── Upgrade helper: wait until a file can be replaced ── */

/* True when the file can be opened for writing — on Windows a running image is
   mapped without FILE_SHARE_WRITE, so this fails with EBUSY while it runs. */
function fileReplaceable(file) {
  return new Promise(function (resolve) {
    fs.open(file, 'r+', function (err, fd) {
      if (err) { resolve(false); return; }
      fs.close(fd, function () { resolve(true); });
    });
  });
}

async function waitForUnlock(file, timeoutMs) {
  const target = String(file || '');
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
  if (!target) return { ok: false, error: 'no-file', waitedMs: 0 };
  if (!fs.existsSync(target)) return { ok: true, missing: true, waitedMs: 0 };
  const started = Date.now();
  for (;;) {
    if (await fileReplaceable(target)) return { ok: true, waitedMs: Date.now() - started };
    if (Date.now() - started >= budget) return { ok: false, error: 'still-locked', waitedMs: Date.now() - started };
    await sleep(300);
  }
}

/* ── Main ── */

async function stop(options) {
  const o = options || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 12000;
  const dryRun = o.dryRun === true;
  const root = String(o.root || '');
  const report = {
    ok: true, root: root, dryRun: dryRun,
    detected: [], own: [], foreign: [], unknown: [],
    graceful: [], fallback: [], skipped: [], remaining: [], errors: []
  };

  /* Root binding is not optional: without it we cannot tell our own instance
     from another checkout that happens to hold the same ports. */
  if (!normalizeRoot(root)) {
    report.ok = false;
    report.errors.push('root-required: refusing to stop anything without --root');
    return report;
  }

  const services = serviceTable();

  /* 1. Which product services answer on their ports (identity, not port alone). */
  for (const svc of services) {
    const r = await request({ port: svc.port, path: svc.health, timeoutMs: 1200 });
    const ours = !!(r.reachable && r.json && svc.identity(r.json));
    svc.ours = ours;
    svc.reachable = r.reachable;
    if (ours) report.detected.push(svc.name + ':' + svc.port);
    else if (r.reachable) report.skipped.push(svc.name + ':unidentified');
  }
  if (!report.detected.length) {
    report.ok = true;
    return report;
  }

  /* 2. Ownership: only a proven root match may be stopped. */
  const owned = new Set();
  for (const svc of services) {
    if (!svc.ours) continue;
    const pids = await pidsForPort(svc.port);
    const bsRoot = svc.name === 'web' ? await bootStateRoot(svc.port) : '';
    let sawOwn = false;
    if (!pids.length) {
      const verdict = classifyTarget({ bootStateRoot: bsRoot }, root);
      if (verdict.verdict === 'own') { sawOwn = true; report.own.push(svc.name + ':(boot-state)'); }
      else report.unknown.push(svc.name + ':no-pid-evidence');
    }
    for (const pid of pids) {
      const ev = await processEvidence(pid);
      ev.bootStateRoot = bsRoot;
      const verdict = classifyTarget(ev, root);
      const label = svc.name + ':pid' + pid + (verdict.proof.length ? '(' + verdict.proof.join('+') + ')' : '');
      if (verdict.verdict === 'own') { sawOwn = true; report.own.push(label); }
      else if (verdict.verdict === 'foreign') report.foreign.push(label + ':' + verdict.reason);
      else report.unknown.push(label + ':' + verdict.reason);
    }
    if (sawOwn) owned.add(svc.name);
  }
  if (dryRun) {
    report.ok = true;
    return report;
  }

  /* 3. Graceful stop through the existing control surfaces — owned only. */
  for (const svc of services) {
    if (!owned.has(svc.name) || !svc.stop) continue;
    const r = await request({ port: svc.port, path: svc.stop, method: 'POST', timeoutMs: 2500 });
    if (r.reachable && (r.status === 202 || r.status === 200)) report.graceful.push(svc.name);
    else report.errors.push(svc.name + ':graceful-unavailable(' + (r.status || r.error || 'no-response') + ')');
  }

  /* 4. Bounded wait for release, then a re-verified fallback kill. */
  const ownedServices = services.filter(function (s) { return owned.has(s.name); });
  const perPort = Math.max(2500, Math.floor(timeoutMs / Math.max(1, ownedServices.length)));
  for (const svc of ownedServices) {
    if (await waitPortFree(svc.port, perPort)) continue;
    const pids = await pidsForPort(svc.port);
    let killed = false;
    for (const pid of pids) {
      const ev = await processEvidence(pid);
      ev.bootStateRoot = svc.name === 'web' ? await bootStateRoot(svc.port) : '';
      const verdict = classifyTarget(ev, root);
      if (verdict.verdict !== 'own') {
        report.skipped.push(svc.name + ':pid' + pid + ':' + verdict.verdict);
        continue;
      }
      const ok = await killPid(pid);
      report.fallback.push(svc.name + ':pid' + pid + '(' + verdict.proof.join('+') + ')');
      if (ok) killed = true;
    }
    if (!killed) report.errors.push(svc.name + ':could-not-stop');
  }

  /* 5. Final state: only OUR ports count as remaining. A foreign instance on a
        product port is reported, never treated as our failure. */
  for (const svc of ownedServices) {
    if (await portBound(svc.port)) report.remaining.push(svc.name + ':' + svc.port);
  }
  report.ok = report.remaining.length === 0;
  return report;
}

/* Exported for tests: pure matching/classification logic + the two drivers. */
module.exports = {
  IB_SCRIPTS: IB_SCRIPTS,
  serviceTable: serviceTable,
  commandLineIsInternalBeyond: commandLineIsInternalBeyond,
  commandLineMatchesRoot: commandLineMatchesRoot,
  pathMatchesRoot: pathMatchesRoot,
  ibScriptAbsolutePaths: ibScriptAbsolutePaths,
  classifyTarget: classifyTarget,
  processEvidence: processEvidence,
  waitForUnlock: waitForUnlock,
  stop: stop
};

function parseArgs(argv) {
  const out = { root: '', json: false, timeoutMs: 0, dryRun: false, waitUnlock: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--root') { out.root = String(argv[++i] || ''); continue; }
    if (a === '--timeout-ms') { out.timeoutMs = Number(argv[++i]) || 0; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--wait-unlock') { out.waitUnlock = String(argv[++i] || ''); continue; }
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.waitUnlock) {
    waitForUnlock(opts.waitUnlock, opts.timeoutMs || 15000).then(function (r) {
      if (r.ok) {
        process.stdout.write('[ib-stop] unlocked ' + opts.waitUnlock + (r.missing ? ' (not present)' : '') +
          ' after ' + r.waitedMs + 'ms\n');
      } else {
        process.stdout.write('[ib-stop] still-locked ' + opts.waitUnlock + ' after ' + r.waitedMs + 'ms\n');
      }
      process.exitCode = r.ok ? 0 : 1;
    }).catch(function (err) {
      process.stdout.write('[ib-stop] wait-unlock failed: ' + String(err && err.message || err) + '\n');
      process.exitCode = 1;
    });
    return;
  }
  stop(opts).then(function (report) {
    if (opts.json) process.stdout.write(JSON.stringify(report) + '\n');
    else {
      process.stdout.write('[ib-stop] root=' + (report.root || '(none)') +
        ' detected=' + (report.detected.join(',') || 'none') +
        ' own=' + (report.own.join(',') || 'none') +
        ' graceful=' + (report.graceful.join(',') || 'none') +
        ' fallback=' + (report.fallback.join(',') || 'none') +
        ' foreign=' + (report.foreign.join(',') || 'none') +
        ' unknown=' + (report.unknown.join(',') || 'none') +
        ' remaining=' + (report.remaining.join(',') || 'none') + '\n');
      if (report.errors.length) process.stdout.write('[ib-stop] notes: ' + report.errors.join('; ') + '\n');
    }
    process.exitCode = report.ok ? 0 : 1;
  }).catch(function (err) {
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err) }) + '\n');
    else process.stdout.write('[ib-stop] failed: ' + String(err && err.stack || err) + '\n');
    process.exitCode = 1;
  });
}
