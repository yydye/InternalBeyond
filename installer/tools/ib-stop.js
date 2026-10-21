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
 * Exit code: 0 = nothing of ours is left running out of the given root. That is
 * the question the installer asks before it replaces files, and it is answered
 * by TWO conditions that must both hold:
 *
 *   · the stop state machine reached a stopped verdict for every owned target
 *     (runtime/component-lifecycle.js), and
 *   · the root-scoped residual sweep finds no live process executing out of the
 *     root (`residualProcesses` below).
 *
 * Anything else means at least one owned process could not be stopped, and the
 * installer must not proceed. A foreign process on a product port is reported
 * as a conflict and does NOT make this helper fail — it is not ours to stop.
 *
 * "Stopped" and "stopped gracefully" are NOT the same fact, and this helper
 * reports both separately: `ok` is the first one (may files be replaced?),
 * `gracefulStop`/`fallbackKills` are the second (did every component go down
 * through its own surface?). An upgrade can only require the first — a 1.0.4
 * instance has no shared stop surface for Bridge/Active at all, so demanding the
 * second would make every legacy upgrade fail while the machine was in exactly
 * the state the installer needs. See the STOPPED note in
 * runtime/component-lifecycle.js for the measured defect this distinction closes.
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

/* This helper's own file name. A running copy of it is not a product component
   — it is the thing doing the stopping — and it has to be named here because the
   helper's own command line always references the root it was pointed at, which
   is exactly what the residual sweep looks for. */
const HELPER_NAME = 'ib-stop.js';

/* ── Where the registry and the lifecycle live ─────────────────────────────
 *
 * This helper meets three layouts and must load its module pair in all three:
 *
 *   1. the install root we were pointed at   <root>\runtime\component-*.js
 *      The installed layout, and what a 1.0.5-or-later upgrade finds.
 *   2. the directory this helper runs from   <dir>\component-*.js
 *      The installer extracts the helper AND these two modules into {tmp}
 *      together (installer/InternalBeyond.iss), because the other candidates
 *      cannot resolve where the installer actually needs them:
 *        · on a FRESH install {app} is still empty — PrepareToInstall runs
 *          before any payload has been copied, so candidate 1 has nothing to
 *          read at all;
 *        · on an upgrade from a pre-P11-3H install the root has neither
 *          module, because both shipped after 1.0.4;
 *        · candidate 3 resolves, from the installer's {tmp}, to
 *          %LOCALAPPDATA% — which is not an install root.
 *      Without this candidate the helper cannot load the shared stop state
 *      machine in the only two conditions the installer ever runs it in, so it
 *      refuses to stop anything and PrepareToInstall aborts the install.
 *   3. two levels up from here               (repository checkout layout,
 *      where the helper is at `installer/tools/`; also the caller's escape
 *      hatch when it wants to reason about a root in isolation — a caller that
 *      passes `allowCheckoutFallback === false` gets only candidates 1 and 2)
 *
 * The first candidate holding BOTH files wins; nothing else is ever imported.
 * The root stays first: it is the instance's own truth, and a root that has a
 * registry must keep reporting `registry` as its source. */
function moduleCandidates(root, allowCheckoutFallback) {
  const out = [];
  const base = String(root || '');
  if (base) out.push({ dir: base, flat: false });
  /* `flat` means the module files sit directly in the candidate directory
     rather than at `<dir>\runtime\`: ExtractTemporaryFile() always extracts to
     {tmp} itself, so the shipped pair lands next to the helper, not under a
     `runtime` child it would have to invent. */
  out.push({ dir: __dirname, flat: true });
  if (allowCheckoutFallback !== false) out.push({ dir: path.resolve(__dirname, '..', '..'), flat: false });
  return out;
}

function moduleFileIn(candidate, file) {
  return candidate.flat
    ? path.join(candidate.dir, file)
    : path.join(candidate.dir, 'runtime', file);
}

/* The first candidate that actually holds `file`, or '' when none does. Used
   for the lifecycle-only load in stopTargets(), which must not repeat the
   layout guesses this section already owns. */
function findModuleFile(candidates, file) {
  for (let i = 0; i < candidates.length; i++) {
    const p = moduleFileIn(candidates[i], file);
    try { if (fs.existsSync(p)) return p; } catch (e) { /* unreadable candidate */ }
  }
  return '';
}

/* The lifecycle module has to be findable even when `allowCheckoutFallback` is
   false. It is what supplies the bounded route table for a root too old to have
   a registry — and that is precisely the case where dropping the table would
   leave the helper with no way to stop anything at all. The root's own modules
   still win when they exist; the caller only loses the ability to take the
   table away entirely (tests/test_p11_3h_lifecycle_gate.js A6). */
function lifecycleCandidates(root, allowCheckoutFallback) {
  const out = moduleCandidates(root, allowCheckoutFallback);
  const checkout = { dir: path.resolve(__dirname, '..', '..'), flat: false };
  for (let i = 0; i < out.length; i++) {
    if (out[i].dir === checkout.dir && out[i].flat === false) return out;
  }
  out.push(checkout);
  return out;
}

function resolveRootModules(root, allowCheckoutFallback) {
  const candidates = moduleCandidates(root, allowCheckoutFallback);
  for (let i = 0; i < candidates.length; i++) {
    const reg = moduleFileIn(candidates[i], 'component-registry.js');
    const life = moduleFileIn(candidates[i], 'component-lifecycle.js');
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
     export that does not need a registry. It is located through the same
     candidate list as the pair above, so this path cannot keep the old
     `<here>\..\..\runtime` assumption that the pair just stopped making. */
  let fallback = null;
  try {
    const lifeOnly = findModuleFile(lifecycleCandidates(root, allowCheckoutFallback), 'component-lifecycle.js');
    fallback = lifeOnly ? require(lifeOnly) : null;
  } catch (e) { fallback = null; }
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
  const cl = String(cmdline || '').toLowerCase().replace(/\//g, '\\');
  let at = -1;
  while ((at = cl.indexOf(r, at + 1)) >= 0) {
    const before = at > 0 ? cl[at - 1] : '';
    const after = cl[at + r.length] || '';
    const beginsPath = !before || /[\s"'=]/.test(before);
    const endsPath = !after || after === '\\' || /[\s"']/.test(after);
    if (beginsPath && endsPath) return true;
  }
  return false;
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

/* ── The upgrade gate: is ANYTHING still running out of this root? ─────────
 *
 * This is the question the installer actually has to have answered before it
 * replaces files, and until 1.0.5 nothing in the chain asked it. `stopAll()`
 * answers "which components reached which state", which is a statement about the
 * components the registry knows and about the way each one ended — not about the
 * machine. A process the registry does not list, a component that changed its
 * script name between versions, an orphan whose parent died: none of them would
 * make `stopAll()` fail, and all of them lock `<root>\runtime\node\node.exe`
 * (the file whose replacement is what a failed upgrade looks like from the
 * outside: "DeleteFile failed; code 5").
 *
 * So the installer's gate is a fact about the root, measured after the stop: no
 * live process may be executing out of it. Fail closed — an unreadable list is
 * reported as an empty list, but `ok` never depends on this sweep succeeding in
 * order to become false.
 *
 * ── What counts, and why it is this narrow ────────────────────────────────
 *
 * A process belongs to this root in exactly two ways, and both are PROOF rather
 * than resemblance:
 *
 *   · its executable image IS this root's bundled runtime
 *     (`<root>\runtime\node\node.exe`) — the file an upgrade replaces, and the
 *     only executable the payload installs;
 *   · its command line names this root AND names one of our scripts — the same
 *     two-part rule `classifyTarget` already applies to a stop, reused rather
 *     than restated.
 *
 * "Mentioning the root somewhere on the command line" is deliberately NOT enough,
 * and that is not caution for its own sake: measured while building this gate, a
 * root that happened to be a directory other programs were launched from matched
 * nine unrelated processes (a venv python, a shell, six editor workers) purely
 * because the path appeared in their arguments. A gate that aborts an upgrade
 * over somebody else's process is worse than no gate, and a gate that would
 * delete based on that list is how a product destroys a machine.
 *
 * Two further exclusions: this helper's own pid, and any process running this
 * helper (whose command line always names the root it was pointed at).
 */
function psSingleQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

/* The one executable the payload installs, and therefore the one image whose
   loading proves a process is executing this root's own runtime. */
function rootRuntimeExe(root) {
  return path.join(String(root || ''), 'runtime', 'node', 'node.exe');
}

/* The Tauri Host is the other executable the canonical installer owns. Its
   exact absolute image path is the ownership proof; a shared process name is
   never sufficient. */
function rootHostExe(root) {
  return path.join(String(root || ''), 'internalbeyond-host.exe');
}

function executableIsRootRuntime(executablePath, root) {
  if (!executablePath || !root) return false;
  const a = String(executablePath).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  const b = String(rootRuntimeExe(root)).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  return a !== '' && a === b;
}

function executableIsRootHost(executablePath, root) {
  if (!executablePath || !root) return false;
  const a = String(executablePath).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  const b = String(rootHostExe(root)).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  return a !== '' && a === b;
}

/* The directories under an install root that the PAYLOAD owns: every component
   entry script the registry names lives in one of them (`services/…`,
   `runtime/…`, `tools/…`). A process whose script sits directly in one of these
   is running this root's own files, which is the fact the installer needs. */
const OWNED_LAYOUT_DIRS = ['services', 'runtime', 'tools', 'apps'];

/* The first path segment of `p` below `root`, or '' when `p` is not under it.
   Path-prefix semantics — `E:\root\tests\x` is under `E:\root`, and so is
   `E:\root\services`, which is what the two callers need to tell apart. */
function firstSegmentUnderRoot(p, root) {
  if (!pathMatchesRoot(p, root)) return '';
  const norm = String(p).replace(/\//g, '\\');
  const rest = norm.slice(normalizeRoot(root).length).replace(/^\\+/, '');
  return String(rest.split('\\')[0] || '').toLowerCase();
}

/* Pure classification, exported so the identity rule can be tested without a
   machine full of processes. `evidence` = { pid, name, executablePath, commandLine }. */
function isResidualProcess(evidence, root) {
  const e = evidence || {};
  const pid = Number(e.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  const cmdline = String(e.commandLine || '');
  if (cmdline && cmdline.toLowerCase().indexOf(HELPER_NAME) >= 0) return false;
  /* Running this root's own bundled runtime or Tauri Host is the strongest
     possible proof, and both are files an upgrade has to replace. */
  if (executableIsRootRuntime(e.executablePath, root) || executableIsRootHost(e.executablePath, root)) return true;
  if (!cmdline || !commandLineIsInternalBeyond(cmdline)) return false;
  /* Otherwise the script it names must be inside this root's OWNED LAYOUT — and
     "inside" is a path question, not a text question. Measured while building
     this gate: a second installation nested under the root being asked about
     (`<root>\tests\.tmp\…\installB\ib-bridge-service.js`) contains the root as a
     SUBSTRING while belonging to a different installation entirely, and a gate
     that treated that as ours would abort an upgrade over somebody else's
     process. The first segment under the root is what tells the two apart. */
  return ibScriptAbsolutePaths(cmdline).some(function (p) {
    return OWNED_LAYOUT_DIRS.indexOf(firstSegmentUnderRoot(p, root)) >= 0;
  });
}

function residualProcesses(root, extraExcludePids) {
  const r = String(root || '');
  if (!r || process.platform !== 'win32') return Promise.resolve([]);
  const exclude = [process.pid].concat(extraExcludePids || [])
    .map(function (n) { return Number(n); })
    .filter(function (n) { return Number.isInteger(n) && n > 0; });
  /* Delimited text, not JSON: `ConvertTo-Json -AsArray` does not exist on the
     Windows PowerShell 5.1 this runs under, and a one-element array serialises
     differently from a two-element one there. A `|` cannot appear in a path.
     The PowerShell filter is deliberately WIDER than the rule — it is a cheap
     pre-filter over every process on the machine — and the judgement is made in
     JS by the predicate above, so the identity rule exists in exactly one place. */
  const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
    + '$root=' + psSingleQuote(r.toLowerCase()) + ';'
    + '$ex=@(' + exclude.join(',') + ');'
    + 'Get-CimInstance Win32_Process | Where-Object {'
    + '  $_.ProcessId -ne $null -and ($ex -notcontains $_.ProcessId)'
    + '  -and (($_.ExecutablePath) -or ($_.CommandLine))'
    + '  -and ('
    + '    ($_.ExecutablePath -and $_.ExecutablePath.ToLower().Replace("/","\\").StartsWith($root))'
    + '    -or ($_.CommandLine -and $_.CommandLine.ToLower().Contains($root))'
    + '  )'
    + '} | ForEach-Object {'
    + '  Write-Output ("{0}|{1}|{2}|{3}" -f $_.ProcessId, $_.Name, $_.ExecutablePath, $_.CommandLine)'
    + '}';
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 10000)
    .then(function (out) {
      if (!out.ok) return [];
      const lines = String(out.stdout || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
      /* IB_DBG_RESIDUAL=1 prints the whole pre-filter with each verdict. A gate
         that refuses an upgrade has to be able to say what it saw, and "pid N
         under root" is not enough when every product process shares one image
         name: the command line is what names the component. Gated, because it is
         a whole-machine process listing. */
      const debug = String(process.env.IB_DBG_RESIDUAL || '') === '1';
      const evidence = lines.map(function (line) {
        const parts = line.split('|');
        const pid = parseInt(parts[0], 10);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        return {
          pid: pid,
          name: String(parts[1] || ''),
          executablePath: String(parts[2] || ''),
          commandLine: String(parts.slice(3).join('|') || '')
        };
      }).filter(Boolean);
      const residuals = evidence.filter(function (e) { return isResidualProcess(e, r); });
      if (debug) {
        process.stderr.write('[ib-stop] residual candidates root=' + r + ' prefilter=' + evidence.length +
          ' residual=' + residuals.length + '\n');
        for (const e of evidence) {
          process.stderr.write('[ib-stop]   pid=' + e.pid + ' name=' + e.name +
            ' verdict=' + (isResidualProcess(e, r) ? 'residual' : 'ignored') +
            ' exe=' + e.executablePath + ' cmd=' + e.commandLine.slice(0, 300) + '\n');
        }
      }
      return residuals.map(function (e) { return { pid: e.pid, name: e.name, path: e.executablePath }; });
    });
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

/* Best-effort durable copy of a report.
 *
 * The installer cannot capture a child's stdout, so a failed upgrade used to
 * leave nothing behind but "please close InternalBeyond manually" — the message
 * this whole fix exists to stop producing, and one that says nothing about which
 * component, which pid or which state. With `--report <file>` the helper writes
 * the report it already computed to a path the installer chooses in the user's
 * preserved data directory, so the next failure is diagnosable from the machine
 * it happened on. Never fatal: a report we could not write must not change a
 * verdict we already reached. */
function writeReportFile(file, report) {
  const target = String(file || '');
  if (!target) return '';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf8');
    return target;
  } catch (e) {
    return '';
  }
}

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
    conflicts: [], components: [],
    /* Two different questions, reported separately on purpose:
         gracefulStop — was every component stopped through its own surface
                        (no fallback kill, no cooperative timeout)?
         residual     — is anything at all still running out of this root?
       The installer needs the second one, and only the second one, to decide
       whether files can be replaced. Conflating them is what aborted every
       upgrade from an instance whose stop had to fall back. */
    gracefulStop: null,
    residual: [],
    hostDetected: [],
    hostStopped: [],
    hostFailures: []
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
     bounded wait → verified fallback → bounded wait → final verify.
     The per-target floor is raised for this caller (§ "per-target budgets" in
     runtime/component-lifecycle.js): an install-time stop has up to five targets
     and the MANAGER among them is the one whose cooperative shutdown is
     load-bearing, because its own teardown is what takes its children down.
     The Runner owns a 12s bounded child-stop pass plus an exit tail. The normal
     lifecycle caller caps each cooperative phase at 6s; for installer stop only,
     allow up to 15s cooperative inside a 22s phase floor. The shared helper
     budget remains bounded by timeoutMs.
     Measured on a real 1.0.4 instance: the legacy runner needed 2058-2371ms to
     stop Bridge and Active, while the default 3000ms share gave it only 1800ms
     of cooperative window — so every upgrade from a pre-P11-3H install expired
     that window and fell through to a kill. The TOTAL is unchanged and still
     bounded by `timeoutMs`; only the split between discovery, cooperative and
     fallback moved. */
  const summary = await lifecycle.stopAll({
    targets: targets,
    timeoutMs: timeoutMs,
    root: root,
    ownsCommandLine: ownsCommandLine,
    env: o.env,
    cooperativeMs: 15000,
    perTargetFloorMs: 22000,
    discoveryMs: 2500
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
  /* The answer to that question, as a boolean, so a caller never has to derive
     it from `ok` — which now answers a different question. */
  report.gracefulStop = summary.fallbackKills === 0 && !summary.byState.COOPERATIVE_TIMEOUT;
  /* Only OUR ports count as remaining. A foreign instance on a product port is
     reported in `conflicts`, never treated as our failure — and never as
     "InternalBeyond was stopped", which is why it is not silently dropped. */
  for (const r of summary.components) {
    if (r.state !== 'STOPPED' && r.state !== 'NOT_RUNNING' && r.state !== 'FOREIGN') {
      report.remaining.push(r.id + ':' + r.port);
    }
  }
  /* The gate the installer actually needs, measured on the filesystem root
     rather than inferred from component states: nothing may still be running out
     of the directory whose files are about to be replaced. It can only ever make
     `ok` stricter, so it cannot turn a real failure into a success. */
  /* The Host is not one of the HTTP components in the registry. Once every
     component has had its cooperative stop window, stop only Host images whose
     executable path proves they belong to this exact install root. */
  const hostResiduals = (await residualProcesses(root)).filter(function (p) {
    return executableIsRootHost(p.path, root);
  });
  report.hostDetected = hostResiduals.map(function (p) { return p.pid; });
  for (const host of hostResiduals) {
    if (await killPid(host.pid)) report.hostStopped.push(host.pid);
    else report.hostFailures.push(host.pid);
  }
  if (hostResiduals.length) await sleep(500);
  report.residual = await residualProcesses(root);
  report.ok = summary.ok && report.residual.length === 0;
  if (report.residual.length) {
    report.errors.push('residual-processes: ' + report.residual.map(function (p) {
      return p.pid + ':' + (p.path || p.name);
    }).join('; '));
  }
  return report;
}

/* ── Stale payload cleanup (upgrade §7) ────────────────────────────────────
 *
 * An upgrade replaces files by name. A file the previous version shipped and the
 * new one does not therefore stays on disk forever — an old copy of a module that
 * nothing imports any more, which is how an install accumulates code that no
 * release ever audited. Deleting it is the obvious fix and the dangerous one:
 * "delete what is not in the new payload" is a rule that also deletes the user's
 * own files, and the install directory is not ours exclusively.
 *
 * So the rule is a DIFF OF TWO MANIFESTS and nothing else:
 *
 *   previous payload manifest  (what the version being replaced owned)
 *   −
 *   new payload manifest       (what the version being installed owns)
 *   =
 *   the files this upgrade obsoletes
 *
 * A path is deleted only when it is in the FIRST list, absent from the second,
 * a relative path that resolves to a regular file strictly inside the root, and
 * not the manifest itself. A root with no previous manifest — every install made
 * before 1.0.5, including 1.0.4 — deletes NOTHING, because nothing there is
 * provably ours: those files would have to be recognised by a heuristic, and a
 * heuristic plus `fs.unlinkSync` is how a product deletes something it does not
 * own. Directories are never removed, and nothing is ever scanned.
 *
 * Deletion happens AFTER the payload is in place (the installer calls this from
 * ssPostInstall), so a failed copy can never leave a pruned, half-upgraded
 * install.
 *
 * `ok` reports whether the DECISION was safe to act on; a file that could not be
 * deleted is recorded in `failures` and does not fail the install, whose payload
 * is already complete at this point. That asymmetry is deliberate: refusing to
 * finish an install over housekeeping is worse than leaving one dead file.
 */
const MANIFEST_NAME = 'ib-payload-manifest.json';

/* A manifest is { schema, version, files: [root-relative posix paths] }.
   Anything else is refused rather than interpreted: this list authorizes
   DELETION, and a shape we do not recognise is a shape we must not guess about. */
function readManifest(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: 'unreadable: ' + String((e && e.message) || e) }; }
  let json = null;
  try { json = JSON.parse(raw); } catch (e) { return { ok: false, error: 'not-json' }; }
  if (!json || typeof json !== 'object' || !Array.isArray(json.files)) {
    return { ok: false, error: 'no files[] array' };
  }
  const files = [];
  for (const entry of json.files) {
    const rel = normalizeRelPath(entry);
    if (!rel) return { ok: false, error: 'unsafe path in files[]: ' + String(entry).slice(0, 120) };
    files.push(rel);
  }
  return { ok: true, version: String(json.version || ''), files: files };
}

/* Root-relative, forward-slash, no traversal, no drive letters, no UNC, no
   absolute paths. This is the gate that keeps a manifest from reaching outside
   the root it belongs to. */
function normalizeRelPath(value) {
  const raw = String(value == null ? '' : value).replace(/\\/g, '/').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return '';
  if (/^[a-zA-Z]:/.test(raw)) return '';
  const parts = raw.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') return '';
    out.push(part);
  }
  if (!out.length) return '';
  return out.join('/');
}

/* Absolute path inside root, or '' when it would escape it. */
function resolveInsideRoot(root, rel) {
  const base = path.resolve(String(root || ''));
  const full = path.resolve(base, rel.split('/').join(path.sep));
  const b = base.replace(/[\\/]+$/, '').toLowerCase();
  const f = full.toLowerCase();
  if (f !== b && f.indexOf(b + path.sep) !== 0) return '';
  return full;
}

/* The pure decision, exported so the rule can be tested without deleting
   anything: which relative paths does this upgrade obsolete? */
function stalePaths(previous, next) {
  const keep = new Set((next || []).map(function (p) { return String(p).toLowerCase(); }));
  const out = [];
  for (const p of (previous || [])) {
    const rel = normalizeRelPath(p);
    if (!rel) continue;
    if (rel.toLowerCase() === MANIFEST_NAME) continue;
    if (keep.has(rel.toLowerCase())) continue;
    out.push(rel);
  }
  return out;
}

function pruneStale(options) {
  const o = options || {};
  const root = String(o.root || '');
  const report = {
    ok: true, root: root, manifest: String(o.manifest || ''), previous: String(o.previous || ''),
    reason: '', pruned: [], skipped: [], failures: [], errors: []
  };
  if (!normalizeRoot(root)) {
    report.ok = false;
    report.errors.push('root-required');
    return report;
  }
  if (!o.previous || !fs.existsSync(String(o.previous))) {
    /* The common case for every install that predates the manifest: nothing was
       recorded, so nothing is provably obsolete, so nothing is deleted. */
    report.reason = 'no-previous-manifest';
    return report;
  }
  const prev = readManifest(String(o.previous));
  if (!prev.ok) {
    report.ok = false;
    report.errors.push('previous-manifest-invalid: ' + prev.error);
    return report;
  }
  const next = o.manifest && fs.existsSync(String(o.manifest))
    ? readManifest(String(o.manifest))
    : { ok: true, files: [] };
  if (!next.ok) {
    report.ok = false;
    report.errors.push('manifest-invalid: ' + next.error);
    return report;
  }
  const candidates = stalePaths(prev.files, next.files);
  for (const rel of candidates) {
    const full = resolveInsideRoot(root, rel);
    if (!full) { report.skipped.push(rel + ':outside-root'); continue; }
    let st = null;
    try { st = fs.lstatSync(full); } catch (e) { report.skipped.push(rel + ':absent'); continue; }
    /* Never a directory, never a link or any other reparse point: a manifest
       entry authorizes deleting the FILE it names, not whatever a name resolves
       to at the moment of the upgrade. */
    if (st.isSymbolicLink() || !st.isFile()) { report.skipped.push(rel + ':not-a-regular-file'); continue; }
    try { fs.unlinkSync(full); report.pruned.push(rel); }
    catch (e) { report.failures.push(rel + ':' + String((e && e.code) || (e && e.message) || e)); }
  }
  return report;
}

/* Exported for tests: pure matching/classification logic + the three drivers. */
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
  residualProcesses: residualProcesses,
  isResidualProcess: isResidualProcess,
  firstSegmentUnderRoot: firstSegmentUnderRoot,
  OWNED_LAYOUT_DIRS: OWNED_LAYOUT_DIRS,
  executableIsRootRuntime: executableIsRootRuntime,
  rootRuntimeExe: rootRuntimeExe,
  executableIsRootHost: executableIsRootHost,
  rootHostExe: rootHostExe,
  portBound: portBound,
  waitPortFree: waitPortFree,
  waitForUnlock: waitForUnlock,
  MANIFEST_NAME: MANIFEST_NAME,
  normalizeRelPath: normalizeRelPath,
  resolveInsideRoot: resolveInsideRoot,
  readManifest: readManifest,
  stalePaths: stalePaths,
  pruneStale: pruneStale,
  stop: stop
};

function parseArgs(argv) {
  const out = { root: '', json: false, timeoutMs: 0, dryRun: false, waitUnlock: '', pruneStale: false, manifest: '', previous: '', report: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--root') { out.root = String(argv[++i] || ''); continue; }
    if (a === '--timeout-ms') { out.timeoutMs = Number(argv[++i]) || 0; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--wait-unlock') { out.waitUnlock = String(argv[++i] || ''); continue; }
    if (a === '--prune-stale') { out.pruneStale = true; continue; }
    if (a === '--manifest') { out.manifest = String(argv[++i] || ''); continue; }
    if (a === '--previous') { out.previous = String(argv[++i] || ''); continue; }
    if (a === '--report') { out.report = String(argv[++i] || ''); continue; }
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.pruneStale) {
    /* Third mode: obsolete-payload cleanup, run by the installer AFTER the new
       payload is in place. It never stops anything and never scans a directory. */
    const r = pruneStale(opts);
    writeReportFile(opts.report, r);
    if (opts.json) process.stdout.write(JSON.stringify(r) + '\n');
    else {
      process.stdout.write('[ib-stop] prune root=' + (r.root || '(none)') +
        ' reason=' + (r.reason || 'diff') +
        ' pruned=' + (r.pruned.join(',') || 'none') +
        ' skipped=' + (r.skipped.join(',') || 'none') +
        ' failures=' + (r.failures.join(',') || 'none') + '\n');
      if (r.errors.length) process.stdout.write('[ib-stop] notes: ' + r.errors.join('; ') + '\n');
    }
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
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
    writeReportFile(opts.report, report);
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
        ' remaining=' + (report.remaining.join(',') || 'none') +
        ' gracefulStop=' + (report.gracefulStop === null ? '?' : String(report.gracefulStop)) +
        ' residual=' + (report.residual.length ? report.residual.map(function (p) { return p.pid; }).join(',') : 'none') + '\n');
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
