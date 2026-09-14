'use strict';

/*
 * Internal Beyond · installer stop + upgrade helpers (P7, P11-3H)
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
 * ── P11-3H: whose component list is this? ─────────────────────────────────
 *
 * Until P11-3H this file held its OWN service table (web / runner / bridge /
 * active). The runtime had a component registry with six components in it, and
 * the two lists had drifted: measured pre-fix, `serviceTable()` did not contain
 * Home Node at all, so the installer's stop chain could not stop the canonical
 * chat authority — it survived the whole upgrade path.
 *
 * The table is gone. The stop targets are now DERIVED from
 * `runtime/component-registry.js`, read out of the install root this helper was
 * given (`<root>\runtime\component-registry.js`), and the stop itself is
 * performed by `runtime/component-lifecycle.js` — the same state machine the
 * runner uses. This file keeps only what is genuinely installer-side:
 *
 *   · the root binding (a stop may only be aimed at the root it was given);
 *   · the ownership rule that decides whether a proven-ours process is
 *     *this* root's process;
 *   · the CLI and the report.
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
 * Stop order for an owned instance: cooperative endpoint (POST /__shutdown on
 * the component's own loopback port) → bounded wait → verified fallback kill
 * (ownership re-checked per PID, immediately before the kill). A fallback kill
 * is reported as `fallback` and is NOT reported as a graceful stop.
 *
 * Exit code: 0 = every owned target is stopped (or was already not running).
 * Anything else means at least one owned target could not be stopped, and the
 * installer must not proceed. A foreign process on a product port is reported
 * as a conflict and does NOT make this helper fail — it is not ours to stop.
 *
 * Env overrides match the rest of InternalBeyond: IB_WEB_PORT / IB_RESTART_PORT /
 * IB_BRIDGE_PORT / IB_ACTIVE_PORT / IB_HOME_NODE_PORT.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';

/* Every script name that can only belong to InternalBeyond. A command line must
   contain one of these to be considered an InternalBeyond process at all.
   `home-node-service.js` is added by P11-3H: without it, a Home Node process
   found on its port could not even be NAMED as InternalBeyond, so the fallback
   path had to call it foreign. The list decides only whether a process is
   InternalBeyond; whether it is THIS root's InternalBeyond is decided by
   classifyTarget below. */
const IB_SCRIPTS = [
  'internal-beyond-server.js',
  'launch-internal-beyond.js',
  'local-services-runner.js',
  'ib-bridge-service.js',
  'active-message-service.js',
  'home-node-service.js',
  'ib-stop.js'
];

/* ── Where the registry and the lifecycle live ─────────────────────────────
 *
 * This helper ships as `<root>\tools\ib-stop.js` and is ALSO extracted to a
 * temp directory by the installer and run from there with `--root <root>`. So
 * "next to me" is not good enough: the modules are resolved inside the install
 * root we were pointed at, which is also the only root we are allowed to touch.
 *
 * Two candidates, in order: the root itself (the shipped layout), then two
 * levels up (running from a repository checkout, where the helper is at
 * `installer/tools/`). The first candidate that yields a loadable registry
 * wins; nothing else is ever imported. */
function resolveRootModules(root, allowCheckoutFallback) {
  const base = String(root || '');
  const candidates = [];
  if (base) candidates.push(base);
  /* The checkout fallback exists only because this helper also runs from the
     repository (`installer/tools/`), where the root it was pointed at and the
     root the modules live in are the same tree reached two ways. A caller that
     wants to reason about a root in isolation passes `false`. */
  if (allowCheckoutFallback !== false) candidates.push(path.resolve(__dirname, '..', '..'));
  for (const dir of candidates) {
    if (!dir) continue;
    const reg = path.join(dir, 'runtime', 'component-registry.js');
    const life = path.join(dir, 'runtime', 'component-lifecycle.js');
    try {
      if (!fs.existsSync(reg) || !fs.existsSync(life)) continue;
      return {
        registry: require(reg),
        lifecycle: require(life),
        from: reg
      };
    } catch (e) {
      /* A root with a broken registry is a root we must not stop blindly. */
      return { registry: null, lifecycle: null, from: reg, error: String((e && e.message) || e) };
    }
  }
  return { registry: null, lifecycle: null, from: null };
}

/* ── Stop targets ──────────────────────────────────────────────────────────
 *
 * Derived. The registry owns ids, ports, ports-from-env, health paths, identity
 * predicates and the stop path; this file owns none of them.
 *
 * The ONLY case that does not go through the registry is an install root too
 * old to have one — the helper runs BEFORE the upgrade replaces those files, so
 * the very first upgrade of a pre-P11-3H install meets a root without
 * `runtime/component-registry.js`. For that one case the bounded route table
 * held by runtime/component-lifecycle.js is used (ids + port env names, pinned
 * to the registry's own entries by tests/test_p11_3h_lifecycle_gate.js A5), and
 * the report says so in `registrySource`.
 *
 * The lifecycle module cannot carry a `require` of the registry for this to
 * work — and it does not: the registry is required lazily, inside
 * `targets()`/`portOf()`, so the module loads even where there is no registry
 * to load. That is what makes a single fallback table possible instead of one
 * copy here and another there. */

/* The derived target set, plus where it came from. */
function stopTargets(root, env, allowCheckoutFallback) {
  const source = env || process.env;
  const mods = resolveRootModules(root, allowCheckoutFallback);
  if (mods.lifecycle && typeof mods.lifecycle.targets === 'function') {
    return { targets: mods.lifecycle.targets(source), source: 'registry', from: mods.from, error: null, mods: mods };
  }
  /* The registry is unreadable. `require`ing the lifecycle module is still what
     supplies the bounded fallback table — it is the same module, just the one
     export that does not need a registry. */
  let fallback = null;
  try { fallback = require(path.join(path.dirname(__filename), '..', '..', 'runtime', 'component-lifecycle.js')); }
  catch (e) { fallback = null; }
  if (!fallback || typeof fallback.legacyTargets !== 'function') {
    return { targets: [], source: 'unavailable', from: mods.from, error: mods.error || 'component-lifecycle.js could not be loaded', mods: mods };
  }
  return {
    targets: fallback.legacyTargets(source),
    source: 'legacy-routes',
    from: mods.from,
    error: mods.error || null,
    mods: mods
  };
}

/* Kept as an exported convenience for the installer contract tests and for a
   caller that only wants to know "which components and which ports does the
   product have". Derived from the registry the same way `stop()` derives its
   targets, so it cannot become the second table this phase removed.
   `name` is the component id and `stop` is the declared stop path. */
function serviceTable(root) {
  const from = root || path.resolve(__dirname, '..', '..');
  return stopTargets(from, process.env).targets
    .map(function (t) {
      return { name: t.id, port: t.port, health: t.healthPath, identity: t.matchesHealth, stop: t.stopPath };
    });
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

/* The ownership proof the lifecycle state machine asks for, in one place: the
   command line of a pid is this root's process only when it names the root. */
function ownsCommandLine(cmdline, root) {
  return commandLineMatchesRoot(cmdline, root);
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

/*
 * The report keeps the pre-P11-3H field names (an installer that only reads
 * exit code, and the P7 identity suite, both keep working) and adds the state
 * machine underneath them:
 *
 *   ok          true when every OWNED target is stopped or was not running
 *   detected    targets whose identity answered on their port
 *   own         targets with a proven owner
 *   foreign     targets that are verifiably somebody else's → never stopped
 *   unknown     targets whose owner could not be proven → never stopped
 *   graceful    targets that stopped through the cooperative surface
 *   fallback    targets that needed a verified fallback kill (NOT graceful)
 *   remaining   targets that are still up
 *   conflicts   a foreign/unknown process occupying one of our ports
 *   fallbackKills  how many kills this stop needed, overall: the single number
 *                  that answers "was this a graceful stop?" (0 = yes)
 */
async function stop(options) {
  const o = options || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 12000;
  const dryRun = o.dryRun === true;
  const root = String(o.root || '');
  const report = {
    ok: true, root: root, dryRun: dryRun,
    registrySource: null,
    detected: [], own: [], foreign: [], unknown: [],
    graceful: [], fallback: [], skipped: [], remaining: [], errors: [],
    conflicts: [], components: []
  };

  /* Root binding is not optional: without it we cannot tell our own instance
     from another checkout that happens to hold the same ports. */
  if (!normalizeRoot(root)) {
    report.ok = false;
    report.errors.push('root-required: refusing to stop anything without --root');
    return report;
  }

  const resolved = stopTargets(root, o.env);
  report.registrySource = resolved.source;
  const targets = resolved.targets;
  if (resolved.error) {
    /* A root with a registry that cannot be LOADED is a decision for the
       operator: we do not know which components exist, so we do not guess. */
    report.ok = false;
    report.errors.push('registry-load-failed: ' + String(resolved.error).slice(0, 200));
    return report;
  }
  const lifecycle = resolved.mods && resolved.mods.lifecycle
    ? resolved.mods.lifecycle
    /* Without the lifecycle module there is no state machine to run, and
       improvising one here is exactly what this phase removes. The helper
       reports that it cannot stop safely rather than killing on a guess. */
    : null;

  /* 1. Which product services answer on their ports (identity, not port alone). */
  for (const target of targets) {
    const r = await request({ port: target.port, path: target.healthPath, timeoutMs: 1200 });
    const ours = !!(r.reachable && r.json && typeof target.matchesHealth === 'function' && target.matchesHealth(r.json));
    target.ours = ours;
    target.reachable = r.reachable === true;
    if (ours) report.detected.push(target.id + ':' + target.port);
    else if (r.reachable) report.skipped.push(target.id + ':unidentified');
  }

  if (!lifecycle) {
    report.ok = false;
    report.errors.push('lifecycle-unavailable: ' + String(resolved.from || '(not found)') +
      ' — refusing to stop anything without the shared stop state machine');
    return report;
  }

  /* 2. Dry run: classification only, no request, no kill. */
  if (dryRun) {
    for (const target of targets) {
      if (!target.ours) continue;
      const r = await lifecycle.stopComponent(target, {
        root: root, ownsCommandLine: ownsCommandLine, discoverOnly: true, probeMs: 1200
      });
      report.components.push(r);
      if (r.state === 'FOREIGN') report.foreign.push(r.id + ':' + (r.reason || 'foreign'));
      else if (r.state === 'UNKNOWN_OWNER') report.unknown.push(r.id + ':' + (r.reason || 'unknown-owner'));
      else report.own.push(r.id + ':' + (r.proof || 'unproven'));
    }
    report.ok = true;
    return report;
  }

  /* 3–6. The shared state machine does discover → verify → cooperative →
     bounded wait → verified fallback → bounded wait → final verify. */
  const summary = await lifecycle.stopAll({
    targets: targets,
    timeoutMs: timeoutMs,
    root: root,
    ownsCommandLine: ownsCommandLine,
    env: o.env
  });

  for (const r of summary.components) {
    report.components.push(r);
    const label = r.id + ':pid' + (r.pid || '?') + (r.proof ? '(' + r.proof + ')' : '');
    if (r.state === 'FOREIGN') { report.foreign.push(label + ':foreign'); continue; }
    if (r.state === 'UNKNOWN_OWNER') { report.unknown.push(label + ':' + (r.reason || 'unproven-owner')); continue; }
    if (r.proof === 'runner-child' || r.proof === 'command-line') report.own.push(label);
    if (r.state === 'STOPPED' && r.accepted) report.graceful.push(r.id);
    if (r.state === 'STOPPED' && !r.accepted) report.skipped.push(r.id + ':stopped-on-its-own');
    if (r.state === 'NOT_RUNNING') report.skipped.push(r.id + ':not-running');
    if (r.state === 'FALLBACK_KILL') report.fallback.push(r.id + ':pid' + (r.pid || '?'));
    if (r.state === 'COOPERATIVE_TIMEOUT' || r.state === 'FAILED') {
      report.errors.push(r.id + ':' + r.state + (r.reason ? ('(' + r.reason + ')') : ''));
    }
  }

  report.byState = summary.byState;
  report.tookMs = summary.tookMs;
  report.conflicts = summary.conflicts;
  /* How many fallback kills this stop needed, overall. It is the single number
     that answers "was this a graceful stop?" — a non-zero value means at least
     one component had to be killed, which is a bounded ending but NOT the
     cooperative one. */
  report.fallbackKills = summary.fallbackKills;
  /* Only OUR ports count as remaining. A foreign instance on a product port is
     reported in `conflicts`, never treated as our failure — and never as
     "InternalBeyond was stopped", which is why it is not silently dropped. */
  for (const r of summary.components) {
    if (r.state !== 'STOPPED' && r.state !== 'NOT_RUNNING' && r.state !== 'FOREIGN') {
      report.remaining.push(r.id + ':' + r.port);
    }
  }
  report.ok = summary.ok;
  return report;
}

/* Exported for tests: pure matching/classification logic + the two drivers. */
module.exports = {
  IB_SCRIPTS: IB_SCRIPTS,
  serviceTable: serviceTable,
  stopTargets: stopTargets,
  resolveRootModules: resolveRootModules,
  ownsCommandLine: ownsCommandLine,
  commandLineIsInternalBeyond: commandLineIsInternalBeyond,
  commandLineMatchesRoot: commandLineMatchesRoot,
  pathMatchesRoot: pathMatchesRoot,
  ibScriptAbsolutePaths: ibScriptAbsolutePaths,
  classifyTarget: classifyTarget,
  processEvidence: processEvidence,
  bootStateRoot: bootStateRoot,
  pidsForPort: pidsForPort,
  portBound: portBound,
  waitPortFree: waitPortFree,
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
        ' targets=' + (report.registrySource || '?') +
        ' detected=' + (report.detected.join(',') || 'none') +
        ' own=' + (report.own.join(',') || 'none') +
        ' graceful=' + (report.graceful.join(',') || 'none') +
        ' fallback=' + (report.fallback.join(',') || 'none') +
        ' foreign=' + (report.foreign.join(',') || 'none') +
        ' unknown=' + (report.unknown.join(',') || 'none') +
        ' remaining=' + (report.remaining.join(',') || 'none') + '\n');
      if (report.conflicts.length) {
        process.stdout.write('[ib-stop] conflicts: ' +
          report.conflicts.map(function (c) { return c.id + ':' + c.port + ':' + c.state; }).join('; ') + '\n');
      }
      if (report.errors.length) process.stdout.write('[ib-stop] notes: ' + report.errors.join('; ') + '\n');
    }
    process.exitCode = report.ok ? 0 : 1;
  }).catch(function (err) {
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err) }) + '\n');
    else process.stdout.write('[ib-stop] failed: ' + String(err && err.stack || err) + '\n');
    process.exitCode = 1;
  });
}
