'use strict';

/*
 * Internal Beyond · component lifecycle (P11-3H)
 *
 * ONE stop contract for every product component, derived from ONE component
 * registry. Nothing here decides *which* components exist — that is
 * `runtime/component-registry.js`, and this module refuses to work without it.
 *
 * ── The failure this closes ───────────────────────────────────────────────
 *
 * `installer/tools/ib-stop.js` held a hand-written service table (web, runner,
 * bridge, active). The registry manages six components. Measured (P11-3H Phase 1,
 * pre-fix): `ib-stop.serviceTable()` described four ports and none of them was
 * Home Node's. The installer therefore never stopped the canonical chat
 * authority, and the only reason a Home Node process did not survive an upgrade
 * is that the runner it was a child of happened to stop it too.
 *
 * ── The stop state machine ────────────────────────────────────────────────
 *
 *   NOT_RUNNING          nothing answers and nothing holds the port
 *   FOREIGN              something holds the port and it is verifiably not ours
 *   UNKNOWN_OWNER        something holds the port and we could not prove what it is
 *   COOPERATIVE_STOPPING a stop request was accepted; waiting (bounded) for it
 *   STOPPED              the process is gone AND no LIVE process holds the port
 *   COOPERATIVE_TIMEOUT  the accept happened but the process (or the port) did not go
 *   FALLBACK_KILL        identity was re-verified and the process was killed
 *   FAILED               a target we own could not be stopped
 *
 * STOPPED says "no live process holds the port", not "the port does not answer",
 * and the difference is not academic — it is the defect that made 1.0.4 installs
 * un-upgradable. Windows keeps a listening socket visible, still naming its
 * now-exited owner, for a moment after that owner dies; a fresh TCP connect can
 * even complete against it. Measured on a real 1.0.4 -> 1.0.5 upgrade (2026-09-15):
 * the runner accepted the cooperative stop and exited, `pidAlive()` was false, and
 * `Get-NetTCPConnection -State Listen` STILL returned pid 22436 on port 23116. The
 * old verdict read that as "still running", fell through to the fallback, failed to
 * re-read a command line from a dead pid, and ended FAILED — so `stopAll().ok` was
 * false, the helper exited 1, and the installer aborted with "please close
 * InternalBeyond manually" while nothing was running at all. See `listenerLiveness`
 * for the fact that replaces "the port answered".
 *
 * FOREIGN and UNKNOWN_OWNER are terminal *successes* from the caller's point of
 * view: they are never stopped, and a foreign process on one of our ports is
 * reported as a conflict rather than laundered into "InternalBeyond stopped".
 * The only states that make `ok:false` are COOPERATIVE_TIMEOUT, FALLBACK_KILL
 * (a kill is not a graceful stop) and FAILED.
 */

const http = require('http');
const net = require('net');
const { execFile } = require('child_process');

const registry = require('./component-registry.js');
const serviceControl = require('./service-control.js');

const HOST = '127.0.0.1';
const STOP_PATH = serviceControl.STOP_PATH;

/* ── The lifecycle target set ───────────────────────────────────────────────
 *
 * Derived, never listed. A component is a lifecycle target when the registry
 * says it exposes a cooperative stop surface (`stopPath`) — that is the one
 * declaration that makes it stoppable, and it is declared next to the port and
 * the identity predicate it belongs with.
 *
 * `vision` is not a target: its process is a `.cmd` helper the registry marks
 * `controllable:false`, with no stop surface. It is still a registry component,
 * so "the target set is a subset of the registry" is assertable.
 *
 * The `runner` (the restart control plane) belongs to the runner process
 * itself, so it has no separate target: stopping the runner stops it, and
 * `runtime/local-services-runner.js` owns that path. */
function targets(env) {
  const source = env || process.env;
  /* Derived through the registry's own accessor, not by filtering COMPONENTS
     here: the accessor owns the manager-before-managed ORDER (see its comment),
     and a second derivation is a second place for that order to be wrong. */
  return registry.lifecycleTargets()
    .map(c => ({
      id: c.id,
      name: c.name,
      label: c.label,
      /* The registry's own human label for the layout. It exists nowhere else,
         which makes it the cheapest possible evidence that a target set really
         came from the registry instead of from a list that happens to agree. */
      layout: c.label,
      port: registry.portOfEnv(c.portEnv, c.defaultPort, source),
      portEnv: c.portEnv,
      defaultPort: c.defaultPort,
      healthPath: c.healthPath,
      stopPath: c.stopPath,
      /* The registry's own predicate, under its own name. */
      matchesHealth: c.matchesHealth
    }));
}

/* The component ids the lifecycle MUST be able to stop. Derived from the same
 * registry the targets are, so a new component with a stop surface cannot be
 * added without the lifecycle and the installer both seeing it. */
function targetIds(env) {
  return targets(env).map(t => t.id);
}

/* ── Legacy route table ────────────────────────────────────────────────────
 *
 * A bounded, explicit fallback for ONE case: an install root so old that it has
 * no `runtime/component-registry.js` (the installer's helper runs from a temp
 * directory and reads the registry out of the root it was given, during an
 * upgrade that is about to replace those very files).
 *
 * It carries ids and env-var names ONLY — the same names the registry uses. It
 * expresses no port default of its own, no health path of its own and no
 * identity predicate of its own; those come from this file. And it is a SINGLE
 * table: `installer/tools/ib-stop.js` no longer keeps its own copy, because two
 * copies of a fallback is how the original drift happened in the first place.
 * tests/test_p11_3h_lifecycle_gate.js pins every entry against the registry, so
 * it cannot silently become a second service table. */
const LEGACY_ROUTES = Object.freeze([
  /* Same order rule as the registry's accessor: the manager comes before the
     components it manages. On a pre-P11-3H root this is what makes the upgrade
     work at all — the runner is stopped first, and its own shutdown takes
     bridge/active/homeNode with it. Those old services never implemented the
     shared `/__shutdown` surface (v1.0.4 shipped it only in
     services/internal-beyond-server.js), so stopping them individually could
     only ever end in a fallback kill. */
  Object.freeze({ id: 'static', portEnv: 'IB_WEB_PORT', healthPath: '/health', stopPath: '/__shutdown' }),
  Object.freeze({ id: 'restart', portEnv: 'IB_RESTART_PORT', healthPath: '/status', stopPath: '/shutdown' }),
  Object.freeze({ id: 'bridge', portEnv: 'IB_BRIDGE_PORT', healthPath: '/health', stopPath: '/__shutdown' }),
  Object.freeze({ id: 'active', portEnv: 'IB_ACTIVE_PORT', healthPath: '/health', stopPath: '/__shutdown' }),
  Object.freeze({ id: 'homeNode', portEnv: 'IB_HOME_NODE_PORT', healthPath: '/health', stopPath: '/__shutdown' })
]);

/* The ports the fallback uses when the registry is not readable. They are NOT a
   second source of truth: every one of them is asserted equal to the registry's
   `defaultPort` by the lifecycle gate. They exist so that a pre-P11-3H install
   can still be upgraded at all. */
const LEGACY_DEFAULTS = Object.freeze({
  static: 23120,
  restart: 23116,
  bridge: 23115,
  active: 23114,
  homeNode: 23118
});

/* The identity predicates, mirrored by value from the registry. Same argument as
   the ports: pinned by A5, and only reachable when the registry is unreadable. */
function legacyIdentity(id) {
  return function (data) {
    if (!data) return false;
    if (id === 'static') return data.server === 'InternalBeyond Web';
    if (id === 'restart') return data.service === 'InternalBeyond Restart';
    if (id === 'bridge') return data.server === 'IB Bridge';
    if (id === 'active') return data.service === 'internal-beyond-active-messages';
    if (id === 'homeNode') return data.service === 'internal-beyond-home-node';
    return false;
  };
}

function legacyTargets(env) {
  const source = env || process.env;
  return LEGACY_ROUTES.map(function (route) {
    const n = Number(source[route.portEnv]);
    const configured = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0;
    return {
      id: route.id,
      name: route.id,
      label: route.id,
      layout: route.id,
      port: configured || (String(source.IB_DEV_MODE || '') === '1' ? 0 : LEGACY_DEFAULTS[route.id]),
      portEnv: route.portEnv,
      defaultPort: LEGACY_DEFAULTS[route.id],
      /* Per-route, because the runner's health path and stop path are not the
         services'. Pinned equal to the registry's own values by A5, so this
         cannot drift into a second set of facts. */
      healthPath: route.healthPath,
      stopPath: route.stopPath,
      matchesHealth: legacyIdentity(route.id)
    };
  });
}

/* ── Identity, reusing the established predicate ───────────────────────────
 *
 * Identity is the registry's own `matchesHealth` — the same predicate the
 * runner's probe, the launcher's boot record and P11-3X-B's port-ownership
 * classification already use. There is no second "is this InternalBeyond?"
 * heuristic in this file, and that is the point: a stop decision may only be
 * made on evidence the rest of the product already agrees about. */
function identifies(component, data) {
  try {
    return !!(component && typeof component.matchesHealth === 'function' && component.matchesHealth(data));
  } catch (e) { return false; }
}

/* A component that REFUSED the cooperative request is not a component that had
   a fair cooperative chance: there was nothing to time out. It goes down the
   same verified fallback path, and the caller gets the refusal in `reason`. */
function shouldFallback(state) {
  return state === 'COOPERATIVE_TIMEOUT' || state === 'FAILED';
}

/* ── Small async plumbing ───────────────────────────────────────────────── */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function requestJson(opts) {
  const o = opts || {};
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    const started = Date.now();
    try {
      req = http.request({
        host: HOST, port: o.port, path: o.path, method: o.method || 'GET',
        timeout: o.timeoutMs || 1500,
        headers: o.headers || {}
      }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* not json */ }
          done({ reachable: true, status: res.statusCode, json: json, tookMs: Date.now() - started });
        });
      });
    } catch (e) {
      done({ reachable: false, status: 0, json: null, error: String((e && e.message) || e), tookMs: Date.now() - started });
      return;
    }
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } done({ reachable: false, status: 0, json: null, error: 'timeout', tookMs: Date.now() - started }); });
    req.on('error', e => done({ reachable: false, status: 0, json: null, error: String((e && e.code) || e), tookMs: Date.now() - started }));
    req.end();
  });
}

/* Is the port answering at all? A TCP connect, no HTTP: the cheap, side-effect
   free question that P11-3X-B already established for `portBindable`. */
function portAnswering(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: HOST, port: port, timeout: 400 });
    let settled = false;
    const done = v => { if (!settled) { settled = true; try { sock.destroy(); } catch (e) { } resolve(v); } };
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/* Can this process bind the port right now? Node's own kernel answer. */
function portBindable(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    probe.once('error', () => { try { probe.close(); } catch (e) { } done(false); });
    try {
      probe.listen(port, HOST, () => { probe.close(() => done(true)); });
    } catch (e) { done(false); }
  });
}

/* ── OS facts: who holds the port, and is that pid still alive ─────────────
 *
 * `pidsForPort` is the OS listener list — the same fact source P11-3X-B
 * established. It is the ONLY thing here that reads a pid, and it never guesses:
 * an empty answer means "nothing could be read", which the state machine treats
 * as a missing fact, never as "free".
 *
 * This is a deliberate, bounded duplication of a five-line PowerShell call that
 * also exists in `runtime/local-services-runner.js` and (before this phase) in
 * `installer/tools/ib-stop.js`. The RULE built on it — how a command line is
 * judged as ours — is NOT duplicated: the runner keeps its `commandMatchesScript`
 * heuristic for port preflight, and this module never invents one. Callers that
 * have an ownership proof pass it in as `ownsCommandLine`. */
function pidsForPort(port, runner) {
  const run = runner || execFile;
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      run('sh', ['-c', "netstat -tlnp 2>/dev/null | grep ':" + Number(port) + " ' | awk '{print $7}' | cut -d/ -f1"], { timeout: 6000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        resolve(String(stdout || '').trim().split(/\s+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0));
      });
      return;
    }
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$p=(Get-NetTCPConnection -LocalPort ' + Number(port) + " -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','; Write-Output $p"
    ], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      resolve(String(stdout || '').trim().split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0));
    });
  });
}

/* Command line of one pid, read only when a caller needs to judge ownership. */
function commandLineOf(pid, runner) {
  const run = runner || execFile;
  return new Promise(resolve => {
    if (process.platform !== 'win32') { resolve(''); return; }
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'
    ], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/* ── Who holds the port, and is any of them still alive? ──────────────────
 *
 * The ONE question that separates "this component is still running" from "this
 * component exited and left a socket behind". `portAnswering()` alone cannot
 * answer it: a listening socket outlives its owner by a moment on Windows, and
 * during that moment it still accepts connects AND is still listed by
 * `Get-NetTCPConnection` under the dead pid. Reading the listener list without
 * asking whether those pids are alive is how a successful stop was reported as a
 * failure (see the STOPPED note at the top of this file).
 *
 * Three outcomes, and the caller must treat them differently:
 *   read=false              the listener list could not be read. An EMPTY list is
 *                           NOT "nothing holds it" while the port is answering —
 *                           it is a missing fact, and this module never guesses
 *                           from a missing fact.
 *   read=true, live>0       a live process holds it → the component really is up.
 *   read=true, live=0       every process the OS names as a listener is gone →
 *                           only a residue is left, and a dead pid holds nothing.
 */
async function listenerLiveness(port, runner) {
  const holders = await pidsForPort(port, runner);
  const live = holders.filter(pidAlive);
  return {
    read: holders.length > 0,
    holders: holders,
    live: live,
    /* Positive evidence of a residue: the OS named somebody, and none of them is
       alive. Distinct from `!read`, which is evidence of nothing. */
    deadOnly: holders.length > 0 && live.length === 0
  };
}

/* May this port's answering be ignored? Only on positive evidence: the OS named
   at least one listener and every one of them is dead. An unreadable listener
   list never authorizes a STOPPED verdict. */
function residueOnly(liveness) {
  return !!(liveness && liveness.deadOnly === true);
}

/* A verified hard kill. `/T` takes the process's own children with it — which
   is what "no orphan child" means for a component that spawns helpers — and `/F`
   is required because the cooperative path already had its bounded chance. */
function killPid(pid, runner) {
  const run = runner || execFile;
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try { process.kill(n, 'SIGKILL'); return Promise.resolve(true); } catch (e) { return Promise.resolve(false); }
  }
  return new Promise(resolve => {
    run('taskkill.exe', ['/F', '/T', '/PID', String(n)], { windowsHide: true, timeout: 8000 }, err => resolve(!err));
  });
}

/* ── Waiting ───────────────────────────────────────────────────────────────
 *
 * Both conditions are required, because either one alone is a lie:
 *   · pid gone  — a process that exited but whose port is still held by an
 *                 inherited handle means the socket outlived the owner;
 *   · port free — a port that is free while the pid is alive means it rebound,
 *                 or that we are looking at a different process now.
 * `requirePortFree`/`requirePidGone` exist so a caller that genuinely has only
 * one fact (a port with no readable pid) can say so instead of inventing one. */
async function waitVerified(target, facts, deadline, opts) {
  const o = opts || {};
  for (;;) {
    const portFree = !(await portAnswering(target.port));
    const pidGone = facts.pid ? !pidAlive(facts.pid) : true;
    if (portFree && pidGone) {
      if (process.env.IB_DBG_WV) console.error('WV portFree=' + portFree + ' pidGone=' + pidGone + ' pid=' + facts.pid + ' target=' + target.port);
      /* The port goes free the moment the component closes its listener, which
         can be a few milliseconds BEFORE the process itself has finished
         exiting. That gap is real but it is not a race worth losing assertions
         to: a caller that reads a log file right after this returns would
         sometimes read it before the process's last line reached disk.
         `settleMs` is a bounded, honest wait for the fact we already decided —
         it is NOT a wait for data to flush, and nothing in any stop path closes
         a store or commits anything inside it. */
      const settleMs = Number(o.settleMs) >= 0 ? Number(o.settleMs) : 250;
      if (settleMs > 0) await sleep(settleMs);
      return { ok: true, portFree: portFree, pidGone: pidGone, at: Date.now() };
    }
    if (Date.now() >= deadline) return { ok: false, portFree: portFree, pidGone: pidGone, at: Date.now() };
    await sleep(o.stepMs || 120);
  }
}

/* ── Cheap discovery / verification ───────────────────────────────────────
 *
 * A stop has two kinds of question, and they have very different costs:
 *
 *   "is the port answering, and is the component still itself?"  →  an HTTP read
 *   "which pid holds the port?"                                  →  a shell-out
 *
 * The second one spawns PowerShell, which is the single most expensive thing in
 * this whole path and is measurably the difference between a stop that fits in
 * its budget and one that does not (measured under CPU contention: each
 * `Get-NetTCPConnection` call took seconds, and three components then needed
 * more than 30s to stop). So it is asked for LAZILY — only when a pid is
 * actually required: as ownership evidence for a caller that has none, or as
 * the target of a fallback kill.
 *
 * The cooperative fast path never needs it, because a component that accepts
 * the stop releases its port, and "the port stopped answering and the component
 * no longer identifies itself there" is a fact that costs one HTTP read.
 */
function answersAsTarget(target, timeoutMs) {
  return requestJson({ port: target.port, path: target.healthPath, timeoutMs: timeoutMs || 1200 })
    .then(function (r) { return r.reachable === true && identifies(target, r.json); });
}

/* A port that stops answering is only evidence of a stop while the component
   does not identify itself there. A small confirmation window absorbs the gap
   between "the listener closed" and "the last in-flight connection finished". */
async function waitPortReleasedAndSilent(target, deadline, stepMs) {
  for (;;) {
    const answering = await portAnswering(target.port);
    if (!answering) {
      const stillOurs = await answersAsTarget(target, 800);
      if (!stillOurs) return true;
    }
    if (Date.now() >= deadline) return !(await portAnswering(target.port));
    await sleep(stepMs || 120);
  }
}

/* ── The stop of ONE component ────────────────────────────────────────────
 *
 * discover → verify identity → cooperative request → wait bounded →
 * verify pid + port → fallback kill only if identity STILL matches → wait
 * bounded → final verify.
 *
 * `opts` (all optional; a caller supplies only what it has):
 *   root            — the install root this caller is allowed to stop
 *   ownsCommandLine — (cmdline, root) → boolean; the caller's ownership proof
 *   provenOwn       — true when the caller has already proven ownership by a
 *                     means this function cannot see (e.g. the runner's own
 *                     child handle). Still verified against the port below.
 *   cooperativeMs   — bound for the cooperative phase
 *   fallbackMs      — bound for the fallback phase
 *   deadline        — absolute ms timestamp the WHOLE call must respect
 *   discoverOnly    — stop after classification (used by --dry-run)
 */
async function stopComponent(target, opts) {
  const o = opts || {};
  const startedAt = Date.now();
  const deadline = Number.isFinite(o.deadline) ? Number(o.deadline) : startedAt + 30000;
  const result = {
    id: target.id,
    name: target.name,
    port: target.port,
    stopPath: target.stopPath,
    state: null,
    reason: null,
    pid: null,
    accepted: false,
    cooperativeMs: 0,
    fallbackMs: 0,
    fallbackKills: 0,
    kills: [],
    proof: null,
    /* True when the verdict came from a socket that outlived its owner rather
       than from the port going quiet. It is reported, never hidden: it is the
       difference between "stopped and the port is free" and "stopped, and the OS
       is still tearing the socket down". */
    portResidue: false,
    verified: { pidGone: null, portFree: null },
    stoppedAt: null
  };

  /* 1 · discover. Identity is the registry's predicate, not "something
     answered" — a foreign service on our port is a conflict, not a target. */
  const probe = await requestJson({ port: target.port, path: target.healthPath, timeoutMs: o.probeMs || 1500 });
  if (!probe.reachable) {
    /* Nothing answered. That is only "not running" if the port is really free:
       a listener that does not speak HTTP at all would answer nothing while
       still holding the port, and calling that NOT_RUNNING is the class of lie
       this phase exists to remove. */
    if (await portBindable(target.port)) {
      result.state = 'NOT_RUNNING';
      result.reason = 'nothing answered ' + target.healthPath + ' and the port is free';
      result.verified = { pidGone: true, portFree: true };
      return result;
    }
    const holders = await pidsForPort(target.port, o.execFile);
    result.pid = holders.length === 1 ? holders[0] : null;
    if (holders.length) {
      result.state = 'UNKNOWN_OWNER';
      result.reason = 'port ' + target.port + ' is held but does not answer ' + target.healthPath;
      result.verified = { pidGone: false, portFree: false };
    } else {
      result.state = 'UNKNOWN_OWNER';
      result.reason = 'port ' + target.port + ' is not bindable but no listener could be read';
      result.verified = { pidGone: null, portFree: false };
    }
    return result;
  }

  if (!identifies(target, probe.json)) {
    const holders = await pidsForPort(target.port, o.execFile);
    result.pid = holders.length === 1 ? holders[0] : null;
    result.state = 'FOREIGN';
    result.reason = 'port ' + target.port + ' answered ' + target.healthPath + ' but is not ' + target.label;
    result.verified = { pidGone: false, portFree: false };
    return result;
  }

  /* 2 · ownership. `provenOwn` is the runner's own child handle; otherwise the
     caller's command-line proof is required, and that is the only reason a pid
     is read this early. Without either, the component is UNKNOWN_OWNER:
     InternalBeyond answers there, but this caller may not prove it is allowed to
     stop it. */
  let pid = null;
  let proof = null;
  const canProveByCommandLine = typeof o.ownsCommandLine === 'function';
  if (o.provenOwn === true) {
    /* "I started this component" is proof of ownership of THAT component. It is
       not a pid, and it says nothing about whoever holds the port right now — so
       it authorizes the cooperative request, and the fallback kill still has to
       re-establish what it is about to kill (see step 5). */
    proof = 'runner-child';
  } else if (canProveByCommandLine) {
    const holders = await pidsForPort(target.port, o.execFile);
    pid = holders.length === 1 ? holders[0] : null;
    if (pid) {
      const cmdline = await commandLineOf(pid, o.execFile);
      if (cmdline && o.ownsCommandLine(cmdline, o.root)) proof = 'command-line';
    }
  }
  result.pid = pid;
  result.proof = proof;
  if (!proof) {
    result.state = 'UNKNOWN_OWNER';
    result.reason = pid
      ? 'pid ' + pid + ' answers as ' + target.label + ' but ownership of ' + (o.root || '(no root)') + ' could not be proven'
      : 'a component answered on port ' + target.port + ' but no listener pid could be read for ' + (o.root || '(no root)');
    result.verified = { pidGone: false, portFree: false };
    return result;
  }

  /* 3 · cooperative request. When the response names a pid it must be the pid we
     already verified (if we verified one) and the pid that actually answered the
     health probe is the same one. */
  const answered = Number(probe.json && probe.json.pid);
  const answeringPid = Number.isInteger(answered) && answered > 0 ? answered : null;
  const cooperative = await requestJson({
    port: target.port, path: target.stopPath, method: 'POST', timeoutMs: o.stopRequestMs || 3000,
    headers: o.requestHeaders || {}
  });
  const cooperativeRequestSentAt = Date.now();
  if (!cooperative.reachable || (cooperative.status !== 202 && cooperative.status !== 200)) {
    result.state = 'FAILED';
    result.reason = 'the cooperative stop request was refused (' +
      (cooperative.status || cooperative.error || 'no-response') + ')';
    /* Not a timeout: the component said no. Fall back only if the identity and
       the pid still match, which the fallback phase re-checks. */
  } else {
    result.accepted = true;
    const stopPid = Number(cooperative.json && cooperative.json.pid);
    if (Number.isInteger(stopPid) && stopPid > 0) {
      if (answeringPid && stopPid !== answeringPid) {
        result.state = 'FAILED';
        result.reason = 'the stop was accepted by pid ' + stopPid + ' but the health probe was answered by pid ' + answeringPid;
        result.verified = { pidGone: false, portFree: false };
        return result;
      }
      if (pid && stopPid !== pid) {
        result.state = 'FAILED';
        result.reason = 'the stop was accepted by pid ' + stopPid + ' but the port is held by pid ' + pid;
        result.verified = { pidGone: false, portFree: false };
        return result;
      }
      if (!pid) { pid = stopPid; result.pid = stopPid; }
    }
  }
  if (o.discoverOnly === true) return result;

  /* 4 · bounded wait for the cooperative phase. The cheap probe first; the
     listener list only if the cheap probe says the port is still answering,
     because reading it spawns PowerShell and this is the common path. */
  if (result.accepted) {
    const coopDeadline = Math.min(deadline, cooperativeRequestSentAt + (o.cooperativeMs || 6000));
    const released = await waitPortReleasedAndSilent(target, coopDeadline, o.stepMs);
    result.cooperativeMs = Date.now() - cooperativeRequestSentAt;
    /* The verdict needs both facts, and until now only one of them was allowed
       to be the interesting one. `released` is "nothing answers any more";
       `residue` is "something still answers, but every process the OS names as a
       listener is dead". Either one, together with "the pid we identified is
       gone", is a stopped component. A port that still answers under a LIVE pid
       satisfies neither and keeps falling through to the fallback, which is
       where the supervisor-restarted case belongs. */
    const pidGone = pid ? !pidAlive(pid) : null;
    const liveness = (!released && pidGone !== false)
      ? await listenerLiveness(target.port, o.execFile)
      : null;
    const residue = residueOnly(liveness);
    if ((released || residue) && (!pid || !pidAlive(pid))) {
      result.state = 'STOPPED';
      result.stoppedAt = Date.now();
      result.portResidue = residue;
      if (residue) {
        result.note = 'the process exited; port ' + target.port + ' still answers from a listening socket whose ' +
          'owner (' + liveness.holders.join(', ') + ') is no longer alive, so the component is stopped';
      }
      result.verified = {
        pidGone: pid ? true : null,
        portFree: released,
        portAnswering: !released,
        liveOwners: residue ? 0 : (liveness ? liveness.live.length : 0)
      };
      return result;
    }
    /* A port that went quiet while the process we identified is STILL ALIVE is
       not a stop: the component stopped listening. It goes down the timeout
       path, where the listener list is the only thing that can say what to do
       next — which is exactly the case the fallback exists for. */
    result.state = 'COOPERATIVE_TIMEOUT';
    result.reason = released
      ? 'port ' + target.port + ' went quiet but pid ' + pid + ' is still alive after ' + result.cooperativeMs + 'ms'
      : 'the component accepted the stop but port ' + target.port + ' was still answering ' + target.healthPath +
        ' as ' + target.label + ' after ' + result.cooperativeMs + 'ms';
    result.verified = {
      pidGone: pid ? !pidAlive(pid) : null,
      portFree: released,
      portAnswering: !released,
      liveOwners: liveness ? liveness.live.length : 0
    };
  }

  /* 5 · fallback kill, re-verified. Identity is re-read HERE, immediately
     before the kill, because the wait may have been long enough for the pid to
     be recycled by an unrelated process. A pid alone is never evidence. */
  if (!shouldFallback(result.state)) {
    result.state = 'FAILED';
    result.reason = (result.reason || 'the component did not stop');
    return result;
  }
  if (Date.now() >= deadline) {
    result.state = 'FAILED';
    result.reason = (result.reason ? result.reason + '; ' : '') + 'the stop budget expired before a fallback could be verified';
    return result;
  }
  const before = await pidsForPort(target.port, o.execFile);
  const stillTarget = await requestJson({ port: target.port, path: target.healthPath, timeoutMs: 1200 });
  if (!stillTarget.reachable || !identifies(target, stillTarget.json)) {
    /* It went away (or someone else took the port) between the wait and here.
       Re-verified as "no longer our target" → nothing is killed. */
    const goneNow = !(await portAnswering(target.port));
    result.state = goneNow ? 'STOPPED' : 'FOREIGN';
    result.reason = goneNow
      ? 'the component stopped on its own after the cooperative deadline'
      : 'the port changed hands during the stop and is no longer ' + target.label;
    result.verified = { pidGone: pid ? !pidAlive(pid) : true, portFree: goneNow };
    return result;
  }
  /* It is still answering as our target. Before treating that as "there is
     something here to kill", ask whether anybody is ALIVE behind it: a dead pid
     holds no socket, so a listener list in which every entry is dead is a
     residue, not a component. Killing it is impossible anyway — there is no
     process — and the old code's attempt to re-read a command line from it is
     what produced FAILED for a stop that had already succeeded. */
  const liveHolders = before.filter(pidAlive);
  if (before.length > 0 && liveHolders.length === 0) {
    result.state = 'STOPPED';
    result.stoppedAt = Date.now();
    result.portResidue = true;
    result.note = 'the process exited; port ' + target.port + ' still answers from a listening socket whose owner (' +
      before.join(', ') + ') is no longer alive, so the component is stopped';
    result.verified = { pidGone: pid ? !pidAlive(pid) : true, portFree: false, portAnswering: true, liveOwners: 0 };
    return result;
  }
  /* The pid we are about to kill must be the pid that the port reports NOW. */
  const candidate = before.length === 1 ? before[0] : (before.indexOf(pid) >= 0 ? pid : null);
  if (!candidate) {
    result.state = 'FAILED';
    result.reason = 'the component is still answering but no single listener pid could be verified for the fallback';
    return result;
  }
  result.pid = candidate;
  /* Identity is re-verified immediately before the kill. "This runner started
     the child" is proof of ownership of THAT child — not proof that the pid the
     port reports now is still that child. A pid can be recycled while we waited,
     and re-reading the listener list is exactly what notices it. So a
     `runner-child` proof is only accepted when we actually know which pid that
     child is; otherwise ownership has to be established from scratch. */
  const pidChanged = pid !== candidate;
  const ownedByConstruction = result.proof === 'runner-child' && pid !== null && pid === candidate;
  if (!ownedByConstruction) {
    if (!canProveByCommandLine) {
      result.state = 'FAILED';
      result.reason = 'pid ' + candidate + ' answers as ' + target.label +
        ' but this caller cannot prove ownership of it, and it is not the process whose ownership was established';
      return result;
    }
    const cmdline = await commandLineOf(candidate, o.execFile);
    if (!cmdline || !o.ownsCommandLine(cmdline, o.root)) {
      if (pidChanged && pid) {
        result.state = 'FOREIGN';
        result.reason = 'the port is now held by pid ' + candidate + ', which is not the process this stop verified (pid ' +
          pid + ') and whose ownership could not be proven';
        result.verified = { pidGone: false, portFree: false };
        return result;
      }
      result.state = 'FAILED';
      result.reason = 'pid ' + candidate + ' answers as ' + target.label + ' but its identity could not be re-verified before the fallback kill';
      return result;
    }
    result.proof = 'command-line';
  }
  const killedAt = Date.now();
  const killed = await killPid(candidate, o.execFile);
  result.fallbackKills = killed ? 1 : 0;
  result.kills.push({ pid: candidate, at: killedAt, ok: killed, proof: result.proof });
  result.state = killed ? 'FALLBACK_KILL' : 'FAILED';
  if (!killed) result.reason = 'pid ' + candidate + ' could not be terminated';

  /* 6 · bounded wait, then the final verdict. */
  const fallbackDeadline = Math.min(deadline, killedAt + (o.fallbackMs || 5000));
  const final = await waitVerified(target, { pid: candidate }, fallbackDeadline, { stepMs: o.stepMs });
  result.fallbackMs = Date.now() - killedAt;
  result.verified = { pidGone: final.pidGone, portFree: final.portFree };
  if (final.ok) {
    result.stoppedAt = Date.now();
    if (result.state === 'FALLBACK_KILL') {
      result.reason = 'stopped by a verified fallback kill, not cooperatively';
    }
  } else {
    result.state = 'FAILED';
    result.reason = 'pid ' + candidate + ' was terminated but ' +
      (!final.pidGone ? 'the process is still alive' : 'port ' + target.port + ' is still held') +
      ' after ' + result.fallbackMs + 'ms';
  }
  return result;
}

/* ── Per-target budgets ───────────────────────────────────────────────────
 *
 * Two bounds, deliberately separate:
 *
 *  · the PHASE budget is what the cooperative wait and the fallback get.
 *    Discovery happens BEFORE either of them and costs whatever the component's
 *    /health probe costs, so a budget that also had to cover discovery would
 *    silently shrink the phases. Measured before this split: a 3000ms share
 *    left 1750ms for the cooperative wait and -10ms for the fallback after
 *    discovery — a stoppable component reported as "budget expired before a
 *    fallback could be verified".
 *  · the absolute DEADLINE is what keeps the whole call bounded. It allows for
 *    discovery on top of the phases, and it can only consume time that is
 *    actually left, so N components still cost at most `timeoutMs` in total.
 *
 * Every caller that loops over components uses this, so the runner and the
 * installer helper cannot acquire different budgets for the same work.
 */
function targetBudget(remaining, outstanding, opts) {
  const o = opts || {};
  const floor = Number(o.perTargetFloorMs) > 0 ? Number(o.perTargetFloorMs) : 3000;
  const discoveryMs = Number(o.discoveryMs) > 0 ? Number(o.discoveryMs) : 2500;
  const n = Math.max(1, Number(outstanding) || 1);
  const left = Math.max(0, Number(remaining) || 0);
  const evenPhase = Math.floor(left / n);
  const share = Math.max(Math.min(floor, Math.max(0, left - discoveryMs)), Math.min(evenPhase, left));
  const coopBudget = Math.max(300, Math.floor(share * 0.6));
  return {
    phaseMs: share,
    deadlineMs: discoveryMs + share + 500,
    cooperativeMs: Math.max(300, coopBudget),
    fallbackMs: Math.max(300, share - coopBudget)
  };
}

/* ── The stop of the whole target set ─────────────────────────────────────
 *
 * Sequential on purpose. Two components can genuinely share a store file, and
 * stopping them concurrently would make "which close ran first" undefined —
 * the exact ordering `home-node-service.js` documents as load-bearing.
 *
 * One shared budget, divided across the remaining targets, so the total is
 * bounded no matter how many components there are: an installer with a 15s
 * helper budget must not be able to hang for 15s per service.
 */
async function stopAll(opts) {
  const o = opts || {};
  const list = Array.isArray(o.targets) ? o.targets : targets(o.env);
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 12000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const results = [];

  for (let i = 0; i < list.length; i += 1) {
    const target = list[i];
    const remaining = Math.max(0, deadline - Date.now());
    const budget = targetBudget(remaining, list.length - i, o);
    const componentOpts = Object.assign({}, o, {
      deadline: Math.min(deadline, Date.now() + budget.deadlineMs),
      cooperativeMs: Math.min(Number(o.cooperativeMs) > 0 ? Number(o.cooperativeMs) : 6000, budget.cooperativeMs),
      fallbackMs: Math.min(Number(o.fallbackMs) > 0 ? Number(o.fallbackMs) : 5000, budget.fallbackMs)
    });
    const r = await stopComponent(target, componentOpts);
    results.push(r);
  }

  const byState = {};
  for (const r of results) byState[r.state] = (byState[r.state] || 0) + 1;
  const failed = results.filter(r => r.state === 'FAILED' || r.state === 'COOPERATIVE_TIMEOUT' || r.state === 'FALLBACK_KILL');
  const conflict = results.filter(r => r.state === 'FOREIGN' || r.state === 'UNKNOWN_OWNER');
  return {
    ok: failed.length === 0,
    schema: 'internalbeyond.component-lifecycle',
    version: 1,
    startedAt: startedAt,
    finishedAt: Date.now(),
    tookMs: Date.now() - startedAt,
    timeoutMs: timeoutMs,
    targetIds: list.map(t => t.id),
    byState: byState,
    graceful: results.filter(r => r.state === 'STOPPED' && r.accepted).map(r => r.id),
    notRunning: results.filter(r => r.state === 'NOT_RUNNING').map(r => r.id),
    fallback: results.filter(r => r.state === 'FALLBACK_KILL').map(r => r.id),
    conflicts: conflict.map(r => ({ id: r.id, port: r.port, state: r.state, reason: r.reason })),
    remaining: results.filter(r => r.state !== 'STOPPED' && r.state !== 'NOT_RUNNING' && r.state !== 'FOREIGN')
      .map(r => ({ id: r.id, port: r.port, state: r.state, reason: r.reason })),
    fallbackKills: results.reduce((n, r) => n + r.fallbackKills, 0),
    components: results
  };
}

/* Read-only: which targets exist and what is answering, without stopping
 * anything. `ib-stop --dry-run` and the diagnostics page both use this. */
async function survey(opts) {
  const o = opts || {};
  const list = Array.isArray(o.targets) ? o.targets : targets(o.env);
  const out = [];
  for (const t of list) {
    const probe = await requestJson({ port: t.port, path: t.healthPath, timeoutMs: o.probeMs || 1200 });
    out.push({
      id: t.id,
      port: t.port,
      answers: probe.reachable === true,
      identity: probe.reachable === true ? identifies(t, probe.json) : false,
      status: probe.status || 0,
      pid: (await pidsForPort(t.port, o.execFile)).slice(0, 8)
    });
  }
  return out;
}

module.exports = {
  HOST: HOST,
  STOP_PATH: STOP_PATH,
  LEGACY_ROUTES: LEGACY_ROUTES,
  LEGACY_DEFAULTS: LEGACY_DEFAULTS,
  legacyTargets: legacyTargets,
  targets: targets,
  targetIds: targetIds,
  identifies: identifies,
  shouldFallback: shouldFallback,
  listenerLiveness: listenerLiveness,
  residueOnly: residueOnly,
  targetBudget: targetBudget,
  stopComponent: stopComponent,
  stopAll: stopAll,
  survey: survey,
  pidsForPort: pidsForPort,
  commandLineOf: commandLineOf,
  pidAlive: pidAlive,
  killPid: killPid,
  portAnswering: portAnswering,
  portBindable: portBindable,
  requestJson: requestJson,
  waitVerified: waitVerified
};
