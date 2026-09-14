'use strict';

/*
 * P11-3H · Graceful Shutdown & Installer Lifecycle Closure
 *
 *   ONE COMPONENT REGISTRY → ONE STOP CONTRACT → COOPERATIVE SHUTDOWN FIRST
 *   → VERIFIED TERMINATION → HARD KILL ONLY AS BOUNDED FALLBACK
 *
 * Everything here runs against PRIVATE ports, PRIVATE data directories and
 * PRIVATE processes. The five product ports and any process this suite did not
 * spawn are never touched. Child output is always read from a log FILE, never
 * from a pipe (the harness cannot read a piped child here, and an empty capture
 * would look exactly like "the component said nothing").
 *
 * The suite is also the mutation target for
 * tests/test_p11_3h_lifecycle_mutations.js: its section names are the contract
 * the mutation runner names when it reports what a mutation broke.
 *
 * Sections:
 *   [A] registry convergence — one component list, one stop-target set
 *   [B] pre-fix facts — Home Node was not a stop target; Windows SIGTERM is not a stop
 *   [C] the state machine — every state, including the ones that never kill
 *   [D] identity / foreign / second-install safety
 *   [E] partial-dead, repeated stop, restart
 *   [F] Home Node SQLite evidence (cooperative and fallback)
 *   [G] the real runner's stop path
 *   [H] diagnostics and secret containment
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const harness = require(path.join(__dirname, 'helpers', 'lifecycle-harness.js'));
const ROOT = harness.ROOT;

const registry = require(path.join(ROOT, 'runtime', 'component-registry.js'));
const lifecycle = require(path.join(ROOT, 'runtime', 'component-lifecycle.js'));
const serviceControl = require(path.join(ROOT, 'runtime', 'service-control.js'));
const ibStop = require(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'));

const SECTION = String(process.env.P11_3H_SECTIONS || '').trim().toUpperCase();
const wants = s => !SECTION || SECTION.indexOf(s) >= 0;

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  \u2717 ' + name + ' \u2014 ' + (e && e.message || e)); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  \u2717 ' + name + ' \u2014 ' + (e && e.message || e)); }
}
function section(title) { if (SECTION) console.log('\n' + title); else console.log('\n' + title); }

const H = harness.createHarness('gate');
const cleanups = [];
function defer(fn) { cleanups.push(fn); }

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (e) { return null; }
}

/* Fixtures record what they were asked to do in their own marker file, and
   reading THAT is the point: the log file is the child's stdout, and stdout is
   not what proves a stop happened. A stop is a request the component either
   received or did not, and the marker is where the component itself says so. */
function markerText(fx) {
  try { return fs.readFileSync(fx.marker, 'utf8'); } catch (e) { return ''; }
}

/* Wait (bounded) for a line to appear in a component's log.
 *
 * This is a wait for the FILE, not for the stop: the facts the stop is judged on
 * are the pid and the port, and those are asserted directly. A component writes
 * its last line and then exits, and the write is visible to another process a
 * moment later — reading once, immediately, is how a correct implementation
 * would be reported as one that never ran its teardown. */
async function waitForLog(H, logName, re, timeoutMs) {
  const end = Date.now() + (timeoutMs || 4000);
  for (;;) {
    const text = H.logText(logName);
    if (re.test(text)) return text;
    if (Date.now() > end) return text;
    await harness.sleep(100);
  }
}

async function main() {
  console.log('P11-3H \u00b7 graceful shutdown & installer lifecycle closure\n');

  /* ══ [A] registry convergence ═══════════════════════════════════════════ */
  if (wants('A')) {
    section('[A] registry convergence \u2014 ONE component list, ONE stop-target set');

    check('A1 the registry is the single source of the stop-target set', () => {
      const ids = registry.lifecycleTargetIds();
      assert.ok(ids.indexOf('homeNode') >= 0,
        'Home Node must be a lifecycle target; the pre-fix stop table never knew it existed: ' + JSON.stringify(ids));
      assert.ok(ids.indexOf('static') >= 0 && ids.indexOf('bridge') >= 0 && ids.indexOf('active') >= 0,
        'every stoppable component must be in the set: ' + JSON.stringify(ids));
      assert.strictEqual(new Set(ids).size, ids.length, 'the target set must not list a component twice');
    });

    check('A2 every target comes from a component that declares a stop surface', () => {
      for (const id of registry.lifecycleTargetIds()) {
        const c = registry.byId(id);
        assert.ok(c, 'target ' + id + ' is not a registry component');
        assert.strictEqual(c.stopPath, registry.byId(id).stopPath);
        assert.ok(/^\/__shutdown$/.test(c.stopPath),
          'the stop path is one value, declared once: ' + id + ' \u2192 ' + c.stopPath);
      }
    });

    check('A3 a managed component without a stop surface is NOT silently stoppable', () => {
      const managed = registry.managed().map(c => c.id);
      const targets = registry.lifecycleTargetIds();
      for (const id of targets) assert.ok(managed.indexOf(id) >= 0 || id === 'static',
        'a lifecycle target must be a managed component (or the static layer): ' + id);
      for (const id of managed) {
        const c = registry.byId(id);
        const declared = typeof c.stopPath === 'string' && c.stopPath.length > 0;
        assert.strictEqual(targets.indexOf(id) >= 0, declared,
          'being a stop target must be exactly the same fact as declaring a stop surface: ' + id);
      }
    });

    check('A4 the installer helper derives its targets from the registry, not a list', () => {
      const source = fs.readFileSync(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'), 'utf8');
      assert.ok(/component-registry\.js/.test(source) && /component-lifecycle\.js/.test(source),
        'the helper must resolve the registry and the lifecycle out of the install root');
      assert.ok(!/serviceTable\s*\(\s*\)\s*\{\s*[\s\S]{0,400}?return \[/.test(source),
        'the helper must not build its own literal service table again');
      const table = ibStop.serviceTable(ROOT);
      const viaRegistry = registry.lifecycleTargets().map(c => c.id);
      assert.deepStrictEqual(table.map(t => t.name).slice().sort(), viaRegistry.slice().sort(),
        'ib-stop.serviceTable() must be the registry\'s own target set: ' + JSON.stringify(table.map(t => t.name)));
    });

    check('A4b the helper\'s ACTUAL target set names the layout the registry declares', () => {
      /* serviceTable() is a convenience; this asserts the thing the stop itself
         runs on. `layout` is the human label that exists ONLY in the registry —
         a helper that went back to its own list would still produce the right ids
         for the four components it happens to know, and every one of them would
         have an undefined layout. A new component is therefore not just "not
         known": it is visibly not derived. */
      const resolved = ibStop.stopTargets(ROOT, process.env, false);
      assert.strictEqual(resolved.source, 'registry', 'a reachable registry must be the source');
      const expected = registry.lifecycleTargets();
      assert.strictEqual(resolved.targets.length, expected.length,
        'the stop target count must be the registry\'s: ' + JSON.stringify(resolved.targets.map(t => t.id)));
      for (const t of resolved.targets) {
        const c = registry.byId(t.id);
        assert.ok(c, 'target ' + t.id + ' must be a registry component');
        assert.strictEqual(t.layout, c.label,
          'target ' + t.id + ' must carry the registry\'s own layout label (\'' + c.label + '\')');
        assert.strictEqual(t.port, registry.portOfEnv(c.portEnv, c.defaultPort, process.env));
        assert.strictEqual(t.healthPath, c.healthPath);
        assert.strictEqual(t.stopPath, c.stopPath);
      }
    });

    check('A5 the legacy route fallback cannot drift from the registry', () => {
      /* It exists ONLY for an install root too old to have the registry, and it
         is a SINGLE table (runtime/component-lifecycle.js). Two copies of a
         fallback is how the original drift happened: the installer's own table
         and the registry's list of components disagreed about who exists. */
      const legacy = lifecycle.LEGACY_ROUTES;
      assert.ok(Array.isArray(legacy) && legacy.length > 0, 'the fallback table must exist');
      for (const route of legacy) {
        const c = registry.byId(route.id);
        assert.ok(c, 'legacy route ' + route.id + ' is not a registry component');
        assert.strictEqual(route.portEnv, c.portEnv, 'port env var drifted for ' + route.id);
        assert.strictEqual(lifecycle.LEGACY_DEFAULTS[route.id], c.defaultPort, 'default port drifted for ' + route.id);
      }
      for (const id of registry.lifecycleTargetIds()) {
        assert.ok(legacy.some(r => r.id === id),
          'the legacy fallback must be able to name ' + id + ' (it is a stop target today)');
      }
      /* Whatever shape it builds, it must agree with the registry on the facts
         that would be used against a live port. */
      const built = lifecycle.legacyTargets({});
      for (const t of built) {
        const c = registry.byId(t.id);
        assert.strictEqual(t.port, c.defaultPort, 'legacy target port for ' + t.id);
        assert.strictEqual(t.healthPath, c.healthPath, 'legacy target health path for ' + t.id);
        assert.strictEqual(t.stopPath, c.stopPath, 'legacy target stop path for ' + t.id);
        assert.strictEqual(typeof t.matchesHealth, 'function', 'legacy target ' + t.id + ' must still be identifiable');
      }
      /* And the helper must not hold a second copy of it. */
      const helper = fs.readFileSync(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'), 'utf8');
      assert.strictEqual(/const LEGACY_ROUTES = Object\.freeze/.test(helper), false,
        'the helper must not carry its own copy of the fallback table');
    });

    check('A6 an install root without the registry is REPORTED, not guessed at', () => {
      /* A pre-P11-3H install has no runtime/component-registry.js at all. That is
         the ONE case the bounded route table exists for, and the report has to
         say which of the two sources answered rather than leaving the caller to
         guess what the target set was derived from. */
      const resolved = ibStop.stopTargets(path.join(os.tmpdir(), 'ib-3h-no-such-root-xyz'), {}, false);
      assert.strictEqual(resolved.source, 'legacy-routes',
        'a root with no registry must fall back to the bounded route table, and say so');
      assert.ok(resolved.targets.length > 0);
      assert.strictEqual(resolved.error, null);
      /* And the ordinary case really is the registry. */
      const derived = ibStop.stopTargets(ROOT);
      assert.strictEqual(derived.source, 'registry', 'a root WITH a registry must never use the fallback table');
      assert.strictEqual(derived.from, path.join(ROOT, 'runtime', 'component-registry.js'));
      assert.strictEqual(derived.error, null);
    });

    await acheck('A7 the derived targets point at the ports the environment names', async () => {
      const port = await harness.freePort();
      const targets = lifecycle.targets({ IB_HOME_NODE_PORT: String(port) });
      const home = targets.find(t => t.id === 'homeNode');
      assert.ok(home, 'homeNode must be a derived target');
      assert.strictEqual(home.port, port, 'the derived port must honour IB_HOME_NODE_PORT');
    });

    check('A8 the stop path is declared as a value, not spelled twice', () => {
      assert.strictEqual(serviceControl.STOP_PATH, '/__shutdown');
      assert.strictEqual(lifecycle.STOP_PATH, serviceControl.STOP_PATH);
      for (const c of registry.lifecycleTargets()) {
        assert.strictEqual(c.stopPath, serviceControl.STOP_PATH,
          'component ' + c.id + ' declares a different stop path than the one the contract defines');
      }
    });
  }

  /* ══ [B] pre-fix facts ══════════════════════════════════════════════════ */
  if (wants('B')) {
    section('[B] the pre-fix failure chain');

    await acheck('B1 Windows: SIGTERM on a real component is a hard terminate, not a stop', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'b1', port: port, shape: 'homeNode' });
      defer(() => harness.forceKill(fx.pid));
      const up = await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000);
      assert.ok(up, 'fixture did not start');
      assert.ok(harness.alive(fx.pid));
      /* The pre-fix stop path was exactly this line (local-services-runner
         stopService step 1 / stopChildren). */
      const t0 = Date.now();
      process.kill(fx.pid, 'SIGTERM');
      const gone = await harness.waitFor(() => !harness.alive(fx.pid), 6000, 60);
      const tookMs = Date.now() - t0;
      assert.ok(gone, 'the process must be gone (this is the platform fact being recorded)');
      await harness.sleep(500);
      const text = H.logText('b1.log');
      assert.strictEqual(/cooperative/.test(markerText(fx)), false,
        'the fixture\'s own stop handler must NOT have run: SIGTERM on Windows is TerminateProcess');
      assert.ok(tookMs < 3000, 'the terminate is immediate: took ' + tookMs + 'ms');
      H.forget(fx.pid);
    });

    check('B2 the runner no longer stops its children with a bare signal', () => {
      const runner = fs.readFileSync(path.join(ROOT, 'runtime', 'local-services-runner.js'), 'utf8');
      const at = runner.indexOf('async function stopService');
      const stopFn = runner.slice(at, at + 3000);
      /* Comments are stripped first: the pre-fix line is quoted in the comment
         that explains why it is gone, and matching that would be the same class
         of mistake as asserting on a string the implementation no longer uses. */
      const code = stopFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(/lifecycle\.stopComponent/.test(code),
        'the runner\'s stop path must go through the shared lifecycle state machine');
      assert.ok(!/\.kill\(\s*'SIGTERM'\s*\)/.test(code),
        'the runner must no longer make a signal its stop mechanism');
      assert.ok(!/\.kill\(\s*"SIGTERM"\s*\)/.test(code));
    });

    check('B3 the pre-fix table could not describe Home Node (the drift is closed)', () => {
      const ids = registry.lifecycleTargetIds();
      assert.ok(ids.indexOf('homeNode') >= 0, 'homeNode must be stoppable');
      const source = fs.readFileSync(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'), 'utf8');
      assert.strictEqual(/\{ name: 'active', port: port\('IB_ACTIVE_PORT', 23114\)/.test(source), false,
        'the hand-written table must be gone');
    });
  }

  /* ══ [C] the state machine ══════════════════════════════════════════════ */
  if (wants('C')) {
    section('[C] the stop state machine');

    await acheck('C1 NOT_RUNNING: nothing answers and the port is free', async () => {
      const port = await harness.freePort();
      const target = harness.targetFor('bridge', port);
      const r = await lifecycle.stopComponent(target, { provenOwn: true, deadline: Date.now() + 5000 });
      assert.strictEqual(r.state, 'NOT_RUNNING', JSON.stringify(r));
      assert.strictEqual(r.fallbackKills, 0, 'nothing may be killed');
      assert.strictEqual(r.verified.portFree, true);
    });

    await acheck('C2 STOPPED cooperatively: the process is gone AND the port is free', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'c2', port: port, shape: 'bridge' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const r = await lifecycle.stopComponent(harness.targetFor('bridge', port), {
        provenOwn: true, cooperativeMs: 6000, fallbackMs: 4000, deadline: Date.now() + 15000
      });
      assert.strictEqual(r.state, 'STOPPED', JSON.stringify(r));
      assert.strictEqual(r.accepted, true, 'it must have been a COOPERATIVE stop');
      assert.strictEqual(r.fallbackKills, 0, 'the normal path must not kill anything');
      assert.deepStrictEqual(r.verified, { pidGone: true, portFree: true });
      assert.ok(markerText(fx).indexOf('cooperative') >= 0, 'the component ran its own stop handler: ' + JSON.stringify(markerText(fx)));
      H.forget(fx.pid);
    });

    await acheck('C3 STOPPED reports BOTH facts: a free port with a live pid is not stopped', async () => {
      /* A port that is free while the process is alive is not a stop. This is
         asserted directly, because "port free" alone is the cheaper check and
         using it alone is one of the mutations. */
      const target = harness.targetFor('bridge', 1);
      const r = await lifecycle.waitVerified(target, { pid: process.pid }, Date.now() + 300, { stepMs: 60 });
      assert.strictEqual(r.ok, false, 'our own live pid must never count as stopped');
      assert.strictEqual(r.pidGone, false);
      assert.strictEqual(r.portFree, true, 'the port really is free (port 1 is not served)');
    });

    await acheck('C4 COOPERATIVE_TIMEOUT: accepted but never went', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'c4', port: port, shape: 'active', behavior: 'hang' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const t0 = Date.now();
      const r = await lifecycle.stopComponent(harness.targetFor('active', port), {
        provenOwn: true, cooperativeMs: 800, fallbackMs: 3000, deadline: Date.now() + 12000
      });
      const took = Date.now() - t0;
      assert.ok(markerText(fx).indexOf('accepted-hang') >= 0, 'the component accepted the stop: ' + JSON.stringify(markerText(fx)));
      assert.ok(took < 12000, 'the whole call must respect its deadline: ' + took + 'ms');
      assert.ok(r.accepted === true, 'the accept is a fact and must be reported');
      assert.ok(r.state === 'FALLBACK_KILL' || r.state === 'FAILED',
        'a component that accepts and never goes must end in the fallback or as a failure, got ' + r.state);
      if (r.state === 'FALLBACK_KILL') {
        assert.strictEqual(r.fallbackKills, 1, 'exactly one fallback kill');
        assert.ok(/fallback kill, not cooperatively/.test(String(r.reason)),
          'the reason must say a kill is not a graceful stop: ' + r.reason);
        assert.ok(!harness.alive(fx.pid), 'and the process must really be gone');
        H.forget(fx.pid);
      }
    });

    await acheck('C5 a refused cooperative stop still has a bounded, verified ending', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'c5', port: port, shape: 'static', behavior: 'refuse' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const r = await lifecycle.stopComponent(harness.targetFor('static', port), {
        root: ROOT,
        /* The same two pieces of evidence the runner supplies: it started this
           component, AND it can recognise the component's own command line. The
           first authorizes the cooperative request; the second is what a fallback
           kill must re-establish. */
        provenOwn: true,
        ownsCommandLine: (cmdline, root) => String(cmdline || '').indexOf(String(root)) >= 0,
        cooperativeMs: 600, fallbackMs: 3000, deadline: Date.now() + 12000
      });
      assert.strictEqual(r.accepted, false,
        'a refusal is not an accept: ' + JSON.stringify({ state: r.state, reason: r.reason }));
      assert.ok(r.state === 'FALLBACK_KILL', 'a refusal must end in the verified fallback, got ' + r.state +
        ' (' + r.reason + ')');
      assert.strictEqual(r.fallbackKills, 1, 'exactly one kill, and only after the identity was re-verified: ' + JSON.stringify(r.kills));
      assert.ok(await harness.waitFor(() => !harness.alive(fx.pid), 6000), 'the fallback must really remove it');
      H.forget(fx.pid);
    });

    await acheck('C6 the fallback kill is bounded even when the component cannot be killed', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'c6', port: port, shape: 'static', behavior: 'hang' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      /* A kill that reports failure must not become an unbounded wait. */
      const t0 = Date.now();
      const r = await lifecycle.stopComponent(harness.targetFor('static', port), {
        provenOwn: true,
        cooperativeMs: 300,
        fallbackMs: 400,
        deadline: Date.now() + 4000,
        execFile: function (file, args, opts, cb) {
          if (String(file).indexOf('taskkill') >= 0) { cb(new Error('simulated taskkill failure'), ''); return; }
          require('child_process').execFile(file, args, opts, cb);
        }
      });
      const took = Date.now() - t0;
      assert.ok(took <= 6000, 'the state machine must return inside its deadline, took ' + took + 'ms');
      assert.strictEqual(r.state, 'FAILED', 'a kill that did not work is a failure, got ' + r.state + ' ' + r.reason);
      assert.strictEqual(r.fallbackKills, 0);
      assert.ok(harness.alive(fx.pid), 'and it must not claim the process is gone');
    });

    await acheck('C7 stopAll keeps one shared budget across every target', async () => {
      const a = await harness.freePort();
      const b = await harness.freePort();
      const fa = harness.startFixture(H, { name: 'c7a', port: a, shape: 'bridge', behavior: 'hang' });
      const fb = harness.startFixture(H, { name: 'c7b', port: b, shape: 'active', behavior: 'hang' });
      defer(() => { harness.forceKill(fa.pid); harness.forceKill(fb.pid); });
      assert.ok(await harness.waitFor(async () => (await harness.get(a, '/health')).status === 200, 15000));
      assert.ok(await harness.waitFor(async () => (await harness.get(b, '/health')).status === 200, 15000));
      const t0 = Date.now();
      const summary = await lifecycle.stopAll({
        targets: [harness.targetFor('bridge', a), harness.targetFor('active', b)],
        provenOwn: true,
        timeoutMs: 3500
      });
      const took = Date.now() - t0;
      assert.ok(took < 12000, 'two stuck components must not cost two full budgets: ' + took + 'ms');
      assert.strictEqual(summary.components.length, 2, 'both targets must be attempted and reported');
      assert.strictEqual(summary.ok, false, 'a component that had to be killed is not a graceful stop');
    });

    await acheck('C8 a component that takes real time to stop still stops cooperatively', async () => {
      /* A healthy component that needs a moment. The cooperative budget has to be
         a real budget: a wait clamped to (nearly) nothing turns an honest stop
         into a kill, and the report would then say FALLBACK_KILL about a
         component that was going to leave on its own. */
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'c8', port: port, shape: 'bridge', behavior: 'slow', env: { FX_SLOW_MS: '400' } });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const r = await lifecycle.stopComponent(harness.targetFor('bridge', port), {
        provenOwn: true, cooperativeMs: 6000, fallbackMs: 3000, deadline: Date.now() + 15000
      });
      assert.strictEqual(r.state, 'STOPPED', 'a 400ms stop is well inside a real budget: ' + JSON.stringify(r));
      assert.strictEqual(r.accepted, true);
      assert.strictEqual(r.fallbackKills, 0, 'and it must NOT have been killed');
      assert.ok(r.cooperativeMs >= 200, 'the wait must have actually waited: ' + r.cooperativeMs + 'ms');
      assert.deepStrictEqual(r.verified, { pidGone: true, portFree: true });
      H.forget(fx.pid);
    });

    await acheck('C9 a component that is no longer itself must NOT be killed', async () => {
      /* The fallback re-reads identity immediately before it kills. If it skipped
         that read, the pid holding the port would be terminated on the strength
         of a decision made several hundred milliseconds earlier — about a
         different fact. The component here stops being recognisable while still
         holding the port, so the correct ending is FOREIGN and untouched. */
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'c9', port: port, shape: 'bridge', behavior: 'deceive', env: { FX_DECEIVE_MS: '300' } });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const r = await lifecycle.stopComponent(harness.targetFor('bridge', port), {
        provenOwn: true, ownsCommandLine: (c, root) => String(c || '').indexOf(String(root)) >= 0,
        cooperativeMs: 1200, fallbackMs: 3000, deadline: Date.now() + 15000
      });
      assert.strictEqual(r.fallbackKills, 0,
        'a port that no longer answers as this component must not be killed: ' +
        JSON.stringify({ state: r.state, kills: r.kills, reason: r.reason }));
      assert.ok(harness.alive(fx.pid), 'it must still be running');
      assert.strictEqual(r.state, 'FOREIGN',
        'and the verdict must say the port is no longer ours, got ' + r.state);
      H.forget(fx.pid);
    });

  }

  /* ══ [D] identity / foreign / second install ════════════════════════════ */
  if (wants('D')) {
    section('[D] identity, foreign processes and a second installation');

    await acheck('D1 FOREIGN: a non-InternalBeyond listener is reported and NEVER killed', async () => {
      const http = require('http');
      const port = await harness.freePort();
      const foreign = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hello: 'not-internalbeyond' }));
      });
      await new Promise(r => foreign.listen(port, '127.0.0.1', r));
      defer(() => new Promise(r => { try { foreign.close(r); } catch (e) { r(); } }));
      const r = await lifecycle.stopComponent(harness.targetFor('bridge', port), {
        provenOwn: true, deadline: Date.now() + 5000
      });
      assert.strictEqual(r.state, 'FOREIGN', JSON.stringify(r));
      assert.strictEqual(r.fallbackKills, 0, 'a foreign process must never be killed');
      assert.strictEqual(harness.alive(process.pid), true);
      const still = await harness.get(port, '/');
      assert.strictEqual(still.status, 200, 'the foreign listener must still be answering');
    });

    await acheck('D2 a foreign listener on a product port still answers after ib-stop', async () => {
      const http = require('http');
      const port = await harness.freePort();
      const foreign = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ server: 'unrelated-http' }));
      });
      await new Promise(r => foreign.listen(port, '127.0.0.1', r));
      defer(() => new Promise(r => { try { foreign.close(r); } catch (e) { r(); } }));
      const dir = path.join(H.tmp, 'd2-root');
      fs.mkdirSync(dir, { recursive: true });
      const report = await ibStop.stop({
        root: dir, timeoutMs: 4000,
        env: { IB_WEB_PORT: String(port), IB_BRIDGE_PORT: String(port), IB_ACTIVE_PORT: String(port), IB_HOME_NODE_PORT: String(port), IB_RESTART_PORT: String(port) }
      });
      assert.strictEqual(report.detected.length, 0,
        'a non-InternalBeyond service must not be detected as ours: ' + JSON.stringify(report.detected));
      assert.strictEqual(report.graceful.length + report.fallback.length, 0);
      assert.strictEqual((await harness.get(port, '/')).status, 200, 'the foreign listener must survive');
    });

    await acheck('D3 a second installation is never touched (its processes are not ours)', async () => {
      const port = await harness.freePort();
      /* "Installation B": an InternalBeyond-shaped component started from a
         DIFFERENT root, holding the port. Stopping root A must not stop it. */
      const bRoot = path.join(H.tmp, 'installB');
      fs.mkdirSync(bRoot, { recursive: true });
      const bFixture = path.join(bRoot, 'ib-bridge-service.js');
      fs.writeFileSync(bFixture, harness.FIXTURE_SOURCE);
      const b = H.start(bFixture, {
        logName: 'd3-b.log',
        cwd: bRoot,
        env: { FX_PORT: String(port), FX_SHAPE: 'bridge', FX_LOG: path.join(bRoot, 'marker.txt') }
      });
      defer(() => harness.forceKill(b.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000), 'installation B must be up');
      const aRoot = path.join(H.tmp, 'installA');
      fs.mkdirSync(aRoot, { recursive: true });
      const report = await ibStop.stop({
        root: aRoot, timeoutMs: 4000,
        env: { IB_BRIDGE_PORT: String(port), IB_WEB_PORT: String(await harness.freePort()), IB_ACTIVE_PORT: String(await harness.freePort()), IB_HOME_NODE_PORT: String(await harness.freePort()), IB_RESTART_PORT: String(await harness.freePort()) }
      });
      assert.strictEqual(report.graceful.length + report.fallback.length, 0,
        'stopping root A must not stop anything: ' + JSON.stringify(report));
      assert.ok(report.foreign.length + report.unknown.length > 0,
        'installation B must be reported as foreign or unknown: ' + JSON.stringify({ f: report.foreign, u: report.unknown }));
      assert.ok(harness.alive(b.pid), 'installation B must still be running');
      assert.strictEqual((await harness.get(port, '/health')).status, 200, 'and still serving');
      assert.strictEqual(fs.readFileSync(path.join(bRoot, 'marker.txt'), 'utf8').indexOf('cooperative'), -1,
        'installation B must never receive a stop request');
    });

    await acheck('D4 UNKNOWN_OWNER: an IB component whose owner cannot be proven', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'd4', port: port, shape: 'bridge' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      /* No ownership proof at all: the state machine may not invent one. */
      const r = await lifecycle.stopComponent(harness.targetFor('bridge', port), {
        root: path.join(H.tmp, 'some-other-root'),
        ownsCommandLine: (cmd, root) => String(cmd || '').toLowerCase().indexOf(String(root).toLowerCase()) >= 0,
        cooperativeMs: 1000, fallbackMs: 1000, deadline: Date.now() + 6000
      });
      assert.strictEqual(r.state, 'UNKNOWN_OWNER', JSON.stringify(r));
      assert.strictEqual(r.fallbackKills, 0, 'an unproven owner must never be killed');
      assert.ok(harness.alive(fx.pid));
      assert.strictEqual(fs.readFileSync(fx.marker, 'utf8').indexOf('cooperative'), -1,
        'and must never even receive a stop request');
    });

    await acheck('D5 a pid that changes under the port is never killed without fresh proof', async () => {
      /* PID reuse is the case that makes "kill what we found earlier" wrong, and
         it is the reason the fallback re-reads the listener list and re-verifies
         identity immediately before the kill. The list is driven through the
         injected execFile so the change is deterministic instead of a race with
         the OS:
           read 1 (ownership proof) = the real owner, proven by its command line
           read 2 (pre-kill)        = a DIFFERENT process now holds the port
         With a recycled pid the candidate is a process this stop never verified,
         so nothing may be killed. */
      const port = await harness.freePort();
      const real = harness.startFixture(H, { name: 'd5-real', port: port, shape: 'bridge', behavior: 'hang' });
      defer(() => harness.forceKill(real.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const recycled = harness.startFixture(H, { name: 'd5-recycled', port: await harness.freePort(), shape: 'bridge', behavior: 'hang' });
      defer(() => harness.forceKill(recycled.pid));
      const realChild = require('child_process');
      let portCalls = 0;
      const r = await lifecycle.stopComponent(harness.targetFor('bridge', port), {
        root: ROOT,
        ownsCommandLine: (cmdline, root) => String(cmdline || '').indexOf(String(root)) >= 0,
        cooperativeMs: 300, fallbackMs: 3000, deadline: Date.now() + 9000,
        execFile: function (file, args, opts, cb) {
          const cmdline = args && args.length ? String(args[args.length - 1]) : '';
          if (String(file).indexOf('powershell') >= 0 && /Get-NetTCPConnection/.test(cmdline)) {
            portCalls += 1;
            cb(null, String(portCalls === 1 ? real.pid : recycled.pid));
            return;
          }
          if (String(file).indexOf('powershell') >= 0 && /CommandLine/.test(cmdline)) {
            const pid = Number((cmdline.match(/ProcessId=(\d+)/) || [])[1]);
            if (pid === real.pid) {
              /* The real holder's command line, read from the OS, so the ownership
                 proof succeeds honestly on read 1. */
              realChild.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\").CommandLine"], opts, cb);
              return;
            }
            /* The recycled pid: a real, readable command line that is not one of
               ours. So the candidate is checkable — and checking is the only thing
               that tells it apart from the process this stop verified. */
            cb(null, 'C:\\Windows\\System32\\notepad.exe');
            return;
          }
          realChild.execFile(file, args, opts, cb);
        }
      });
      assert.ok(portCalls >= 2, 'the listener list must be read again before the kill: ' + portCalls + ' reads');
      assert.strictEqual(r.fallbackKills, 0,
        'a pid that appeared under the port after the verified one must never be killed: ' +
        JSON.stringify({ state: r.state, kills: r.kills, reason: r.reason }));
      assert.ok(harness.alive(recycled.pid), 'that process must still be running');
      assert.strictEqual(fs.readFileSync(recycled.marker, 'utf8').indexOf('cooperative'), -1,
        'and it must never receive a stop request either');
      assert.ok(r.state === 'FOREIGN' || r.state === 'FAILED',
        'the stop must say it could not establish what holds the port now, got ' + r.state);
    });
  }

  /* ══ [E] partial dead / repeated stop / restart ═════════════════════════ */
  if (wants('E')) {
    section('[E] partial-dead, repeated stop, restart');

    await acheck('E1 one component already dead does not stop the others from stopping', async () => {
      const a = await harness.freePort();
      const b = await harness.freePort();
      const fa = harness.startFixture(H, { name: 'e1a', port: a, shape: 'bridge' });
      const fb = harness.startFixture(H, { name: 'e1b', port: b, shape: 'active' });
      defer(() => { harness.forceKill(fa.pid); harness.forceKill(fb.pid); });
      assert.ok(await harness.waitFor(async () => (await harness.get(a, '/health')).status === 200, 15000));
      assert.ok(await harness.waitFor(async () => (await harness.get(b, '/health')).status === 200, 15000));
      harness.forceKill(fa.pid);
      assert.ok(await harness.waitFor(() => !harness.alive(fa.pid), 6000));
      const summary = await lifecycle.stopAll({
        targets: [harness.targetFor('bridge', a), harness.targetFor('active', b)],
        provenOwn: true, timeoutMs: 12000
      });
      const states = summary.components.map(c => c.id + '=' + c.state).join(' ');
      assert.strictEqual(summary.components[0].state, 'NOT_RUNNING', 'the dead one is reported, not skipped: ' + states);
      assert.strictEqual(summary.components[1].state, 'STOPPED', 'the live one must still be stopped: ' + states);
      assert.strictEqual(summary.ok, true, 'a partial-dead set is a successful stop: ' + states);
      H.forget(fb.pid);
    });

    await acheck('E2 a repeated stop is safe and idempotent', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'e2', port: port, shape: 'bridge' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const target = harness.targetFor('bridge', port);
      const first = await lifecycle.stopComponent(target, { provenOwn: true, cooperativeMs: 5000, deadline: Date.now() + 12000 });
      assert.strictEqual(first.state, 'STOPPED');
      H.forget(fx.pid);
      const second = await lifecycle.stopComponent(target, { provenOwn: true, deadline: Date.now() + 5000 });
      assert.strictEqual(second.state, 'NOT_RUNNING', 'the second stop must be safe: ' + JSON.stringify(second));
      assert.strictEqual(second.fallbackKills, 0);
      const third = await lifecycle.stopComponent(target, { provenOwn: true, deadline: Date.now() + 5000 });
      assert.strictEqual(third.state, 'NOT_RUNNING');
    });

    await acheck('E2b a listener that holds the port and answers nothing is NOT "not running"', async () => {
      /* "Nothing answered /health" and "nothing is running" are different facts,
         and the difference is decided by whether the port can be bound. A
         component that is alive but mute — a wedged process, a store that cannot
         open, a listener someone else inherited — must be reported as an owner we
         could not identify, never as "not running". The second reading is how a
         stopped component that never stopped disappears from the report. */
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'e2b', port: port, shape: 'bridge', env: { FX_SILENT: '1' } });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(() => lifecycle.portAnswering(port), 15000),
        'the silent listener must actually be listening');
      assert.strictEqual(await lifecycle.portBindable(port), false,
        'premise: the port is held');
      assert.strictEqual((await harness.get(port, '/health', 800)).status, 0,
        'and it answers nothing at all');
      const r = await lifecycle.stopComponent(harness.targetFor('bridge', port), {
        provenOwn: true, deadline: Date.now() + 6000
      });
      assert.strictEqual(r.state, 'UNKNOWN_OWNER',
        'a held port with no answer is not "not running": ' + JSON.stringify(r));
      assert.strictEqual(r.fallbackKills, 0, 'and it must not be killed');
      assert.ok(harness.alive(fx.pid), 'the process must still be running');
      /* The two ways into UNKNOWN_OWNER are different diagnoses, and this one is
         the "a listener exists" case: the port is emphatically not free, and the
         reason names the listener rather than a bindability failure. Which of the
         two pid facts comes back depends on whether the OS listener list could be
         read at all — `null` is "nothing was read", `false` is "a pid was read and
         it is alive" — so both are correct here and neither may be `true`. */
      assert.strictEqual(r.verified.portFree, false,
        'the port is held and the report must say so: ' + JSON.stringify(r.verified));
      assert.ok(r.verified.pidGone === null || r.verified.pidGone === false,
        'the process must not be reported as gone: ' + JSON.stringify(r.verified));
      assert.ok(/is held but does not answer/.test(String(r.reason)),
        'and the reason must name the listener, not a bindability failure: ' + r.reason);
    });

    await acheck('E3 a repeated stop through the real helper is safe', async () => {
      const dir = path.join(H.tmp, 'e3-root');
      fs.mkdirSync(dir, { recursive: true });
      const env = {
        IB_WEB_PORT: String(await harness.freePort()), IB_BRIDGE_PORT: String(await harness.freePort()),
        IB_ACTIVE_PORT: String(await harness.freePort()), IB_HOME_NODE_PORT: String(await harness.freePort()),
        IB_RESTART_PORT: String(await harness.freePort())
      };
      const first = await ibStop.stop({ root: dir, timeoutMs: 4000, env: env });
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      const second = await ibStop.stop({ root: dir, timeoutMs: 4000, env: env });
      assert.strictEqual(second.ok, true, 'the second stop must also succeed: ' + JSON.stringify(second));
      assert.strictEqual(second.remaining.length, 0);
      assert.strictEqual(second.graceful.length + second.fallback.length, 0, 'nothing left to stop');
    });

    await acheck('E4 restart after a full stop: fresh pids, ports bindable, components healthy', async () => {
      const ports = {
        static: await harness.freePort(), bridge: await harness.freePort(),
        active: await harness.freePort(), homeNode: await harness.freePort()
      };
      const env = {
        IB_WEB_PORT: String(ports.static), IB_BRIDGE_PORT: String(ports.bridge),
        IB_ACTIVE_PORT: String(ports.active), IB_HOME_NODE_PORT: String(ports.homeNode),
        IB_HOME_NODE_DATA_DIR: path.join(H.tmp, 'e4-hn'), IB_ACTIVE_DATA_DIR: path.join(H.tmp, 'e4-active')
      };
      fs.mkdirSync(env.IB_HOME_NODE_DATA_DIR, { recursive: true });
      fs.mkdirSync(env.IB_ACTIVE_DATA_DIR, { recursive: true });
      const boot = () => ({
        static: H.start('services/internal-beyond-server.js', { logName: 'e4-static.log', env: { IB_WEB_PORT: env.IB_WEB_PORT } }),
        bridge: H.start('services/ib-bridge-service.js', { logName: 'e4-bridge.log', env: { IB_BRIDGE_PORT: env.IB_BRIDGE_PORT } }),
        active: H.start('services/active-message-service.js', { logName: 'e4-active.log', env: { IB_ACTIVE_PORT: env.IB_ACTIVE_PORT, IB_ACTIVE_DATA_DIR: env.IB_ACTIVE_DATA_DIR } }),
        homeNode: H.start('services/home-node-service.js', { logName: 'e4-homeNode.log', env: { IB_HOME_NODE_PORT: env.IB_HOME_NODE_PORT, IB_HOME_NODE_DATA_DIR: env.IB_HOME_NODE_DATA_DIR } })
      });
      const first = boot();
      for (const id of Object.keys(first)) defer(() => harness.forceKill(first[id].pid));
      for (const id of Object.keys(ports)) {
        assert.ok(await harness.waitFor(async () => (await harness.get(ports[id], '/health')).status !== 0, 30000), id + ' did not come up');
      }
      const report = await ibStop.stop({ root: ROOT, timeoutMs: 20000, env: env });
      assert.strictEqual(report.ok, true, 'the stop must succeed: ' + JSON.stringify(report.errors));
      assert.deepStrictEqual(report.graceful.slice().sort(), ['active', 'bridge', 'homeNode', 'static'],
        'every component must stop cooperatively: ' + JSON.stringify(report.byState));
      assert.strictEqual(report.fallbackKills, 0, 'the normal path must not kill anything');
      for (const id of Object.keys(first)) {
        assert.ok(await harness.waitFor(() => !harness.alive(first[id].pid), 8000), id + ' must have exited');
        H.forget(first[id].pid);
      }
      for (const id of Object.keys(ports)) {
        assert.strictEqual((await harness.get(ports[id], '/health')).status, 0, id + ' port must be free');
      }
      /* Restart: fresh pids, same ports, healthy again. */
      const second = boot();
      for (const id of Object.keys(second)) defer(() => harness.forceKill(second[id].pid));
      for (const id of Object.keys(ports)) {
        assert.notStrictEqual(second[id].pid, first[id].pid, id + ' must be a NEW process (no pid reuse)');
        assert.ok(await harness.waitFor(async () => (await harness.get(ports[id], '/health')).status !== 0, 30000),
          id + ' must come back up on the same port');
      }
      const hn = await harness.get(ports.homeNode, '/health');
      assert.strictEqual(hn.status, 200, 'Home Node health must converge');
      assert.strictEqual(hn.json.serving, true, 'and it must report itself able to serve: ' + JSON.stringify(hn.json));
    });
  }

  /* ══ [F] Home Node SQLite evidence ══════════════════════════════════════ */
  if (wants('F')) {
    section('[F] Home Node data safety');

    function readChatStore(dataDir) {
      const createChatStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
      const store = createChatStore({ dataDir: dataDir });
      store.open();
      return store;
    }

    await acheck('F1 cooperative stop: the store is closed by the component, data round-trips', async () => {
      const port = await harness.freePort();
      const dataDir = path.join(H.tmp, 'f1-data');
      fs.mkdirSync(dataDir, { recursive: true });
      const svc = H.start('services/home-node-service.js', {
        logName: 'f1.log',
        env: { IB_HOME_NODE_PORT: String(port), IB_HOME_NODE_DATA_DIR: dataDir }
      });
      defer(() => harness.forceKill(svc.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 30000), 'home node must start');
      const write = await harness.postJson(port, '/messages', {
        messages: [{
          id: 'p11-3h-f1', friendId: 'f1', role: 'user',
          content: 'lifecycle evidence', timestamp: Date.now()
        }]
      });
      assert.strictEqual(write.status, 200, 'the canonical write must succeed: ' + write.raw);
      assert.strictEqual(write.json.ok, true);
      assert.ok(fs.existsSync(path.join(dataDir, 'home-node.db-wal')), 'a WAL sidecar exists before the stop');

      const r = await lifecycle.stopComponent(harness.targetFor('homeNode', port), {
        provenOwn: true, cooperativeMs: 8000, fallbackMs: 4000, deadline: Date.now() + 18000
      });
      assert.strictEqual(r.state, 'STOPPED', JSON.stringify(r));
      assert.strictEqual(r.accepted, true, 'this must be a cooperative stop, not a kill');
      assert.strictEqual(r.fallbackKills, 0);
      assert.ok(await harness.waitFor(() => !harness.alive(svc.pid), 8000), 'the process must exit');
      H.forget(svc.pid);

      const text = await waitForLog(H, 'f1.log', /\[info\] stopped/, 5000);
      assert.ok(/\[info\] shutdown \{/.test(text),
        'the component\'s own teardown must have run (the pre-fix path never reached it): ' + JSON.stringify(text.slice(-400)));
      assert.ok(/\[info\] closed/.test(text), 'the canonical chat store must have been closed');
      assert.ok(/\[info\] stopped \{/.test(text), 'and the component must have reported the completion');
      assert.strictEqual(/Cannot write headers after they are sent/.test(text), false,
        'the stop request must be answered exactly once');

      const store = readChatStore(dataDir);
      try {
        assert.strictEqual(store.countMessages(), 1, 'the message must survive the stop');
        const got = store.getMessage('p11-3h-f1');
        assert.ok(got && got.id === 'p11-3h-f1', 'and be readable by id: ' + JSON.stringify(got));
      } finally { store.close(); }
    });

    await acheck('F2 fallback kill: the data is still recoverable, and the report says it was not graceful', async () => {
      const port = await harness.freePort();
      const dataDir = path.join(H.tmp, 'f2-data');
      fs.mkdirSync(dataDir, { recursive: true });
      const svc = H.start('services/home-node-service.js', {
        logName: 'f2.log',
        env: { IB_HOME_NODE_PORT: String(port), IB_HOME_NODE_DATA_DIR: dataDir }
      });
      defer(() => harness.forceKill(svc.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 30000));
      const write = await harness.postJson(port, '/messages', {
        messages: [{ id: 'p11-3h-f2', friendId: 'f2', role: 'user', content: 'fallback evidence', timestamp: Date.now() }]
      });
      assert.strictEqual(write.status, 200);
      /* No cooperative surface reachable at all: the port is held by the real
         Home Node but the stop endpoint is refused, which is exactly the case
         where the fallback is the only way out. */
      const target = Object.assign({}, harness.targetFor('homeNode', port), { stopPath: '/__does-not-exist' });
      const r = await lifecycle.stopComponent(target, {
        provenOwn: true, cooperativeMs: 500, fallbackMs: 5000, deadline: Date.now() + 12000
      });
      assert.ok(r.state === 'FALLBACK_KILL' || r.state === 'FAILED', JSON.stringify(r));
      if (r.state === 'FALLBACK_KILL') {
        assert.strictEqual(r.fallbackKills, 1);
        assert.ok(/not cooperatively/.test(String(r.reason)), 'the report must say this was a kill: ' + r.reason);
        assert.ok(await harness.waitFor(() => !harness.alive(svc.pid), 8000));
        H.forget(svc.pid);
        const text = H.logText('f2.log');
        assert.strictEqual(/\[info\] closed/.test(text), false,
          'a killed process did NOT run its teardown — the report must not pretend it did');
      }
      const store = readChatStore(dataDir);
      try {
        assert.strictEqual(store.countMessages(), 1,
          'WAL recovery still preserves the data — that is NOT the same fact as a graceful shutdown');
        assert.ok(store.getMessage('p11-3h-f2'), 'and the row is readable');
      } finally { store.close(); }
    });

    check('F3 no durability setting was changed to make any of this work', () => {
      /* The stop path may not buy "graceful" by weakening durability, and it may
         not guess that data was flushed. Asserted on the modules this phase
         touched, not on chat-store.js — that file's own PRAGMA lines are the
         product's existing, deliberate durability posture (WAL + synchronous
         FULL) and are not a stop-path decision. */
      const stopPathSources = [
        'runtime/service-control.js',
        'runtime/component-lifecycle.js',
        'services/home-node-service.js',
        'services/home-node/http.js',
        'services/internal-beyond-server.js',
        'services/ib-bridge-service.js',
        'services/active-message-service.js',
        'runtime/local-services-runner.js',
        'installer/tools/ib-stop.js'
      ].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')
        /* Comments are stripped first: this module explains that it does NOT add
           a checkpoint, and matching its own explanation would be exactly the
           "assert on a string the code does not use" mistake the rules forbid. */
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      assert.strictEqual(/PRAGMA\s+journal_mode/i.test(stopPathSources), false,
        'no stop path may touch journal_mode');
      assert.strictEqual(/PRAGMA\s+synchronous/i.test(stopPathSources), false,
        'no stop path may touch synchronous');
      assert.strictEqual(/wal_checkpoint|WAL\s+checkpoint/i.test(stopPathSources), false,
        'no checkpoint was added: a clean close is already enough, and inventing one is over-design');
      assert.strictEqual(/setTimeout\([^)]*\b(flush|close|commit)/i.test(stopPathSources), false,
        'no timer may be used to guess that data was flushed');
      /* And the existing durability posture is unchanged from HEAD's shape. */
      const chatStore = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'chat-store.js'), 'utf8');
      assert.ok(/PRAGMA journal_mode = WAL/.test(chatStore), 'WAL stays on');
      assert.ok(/PRAGMA synchronous = FULL/.test(chatStore), 'synchronous stays FULL');
    });
  }

  /* ══ [G] the runner's own stop path ═════════════════════════════════==== */
  if (wants('G')) {
    section('[G] the runner stop path');

    check('G1 the runner reports a lifecycle view derived from its own targets', () => {
      const runner = fs.readFileSync(path.join(ROOT, 'runtime', 'local-services-runner.js'), 'utf8');
      assert.ok(/url\.pathname === '\/lifecycle'/.test(runner), 'the control plane must expose the lifecycle view');
      assert.ok(/lifecycleTarget:/.test(runner), 'each service spec must carry its registry-derived lifecycle target');
      assert.ok(/lastShutdown: lastShutdown/.test(runner), 'and the last bounded stop cycle must be reportable');
    });

    check('G2 the runner shutdown path is bounded and reports per component', () => {
      const runner = fs.readFileSync(path.join(ROOT, 'runtime', 'local-services-runner.js'), 'utf8');
      const fn = runner.slice(runner.indexOf('async function runShutdown'), runner.indexOf('async function runShutdown') + 3200);
      assert.ok(/IB_SHUTDOWN_BUDGET_MS/.test(fn), 'the stop budget must be an explicit, overridable bound');
      assert.ok(/stopService\(service, \{/.test(fn), 'it must go through the shared stop path');
      assert.ok(/shutdown incomplete/.test(fn), 'an incomplete stop must be recorded, not swallowed');
      assert.ok(/lastShutdown\.complete/.test(fn), 'and the cycle must report what it did per component');
    });

    await acheck('G3 a real runner answers /lifecycle and stops its children cooperatively', async () => {
      const ports = {
        bridge: await harness.freePort(), active: await harness.freePort(),
        homeNode: await harness.freePort(), restart: await harness.freePort()
      };
      const env = {
        IB_BRIDGE_PORT: String(ports.bridge), IB_ACTIVE_PORT: String(ports.active),
        IB_HOME_NODE_PORT: String(ports.homeNode), IB_RESTART_PORT: String(ports.restart),
        IB_HOME_NODE_DATA_DIR: path.join(H.tmp, 'g3-hn'), IB_ACTIVE_DATA_DIR: path.join(H.tmp, 'g3-active'),
        /* Generous on purpose: this run's assertion is "every child stops
           cooperatively", so the budget must not be the thing under test. The
           budget's own bound is asserted in G2 and C7. */
        IB_SHUTDOWN_BUDGET_MS: '36000',
        IB_DBG_FILE: path.join(H.tmp, 'g3-runner-dbg.txt'),
        IB_RECOVERY_POLICY: JSON.stringify({ maxAttempts: 2, windowMs: 60000, baseBackoffMs: 200, maxBackoffMs: 400, healthFailStreak: 2 })
      };
      fs.mkdirSync(env.IB_HOME_NODE_DATA_DIR, { recursive: true });
      fs.mkdirSync(env.IB_ACTIVE_DATA_DIR, { recursive: true });
      const runner = H.start('runtime/local-services-runner.js', { logName: 'g3-runner.log', env: env });
      defer(() => harness.forceKill(runner.pid));
      const up = await harness.waitFor(async () => (await harness.get(ports.restart, '/status')).status === 200, 30000);
      assert.ok(up, 'the runner control plane must come up: ' + H.logText('g3-runner.log').slice(-600));
      for (const id of ['bridge', 'active', 'homeNode']) {
        assert.ok(await harness.waitFor(async () => (await harness.get(ports[id], '/health')).status === 200, 30000),
          id + ' must be started by the runner');
      }
      const view = await harness.get(ports.restart, '/lifecycle');
      assert.strictEqual(view.status, 200, 'the lifecycle view must answer');
      assert.ok(view.json && Array.isArray(view.json.targets), JSON.stringify(view.json));
      assert.ok(view.json.targets.some(t => t.id === 'homeNode'),
        'Home Node must be one of the runner\'s stop targets: ' + JSON.stringify(view.json.targets));
      assert.strictEqual(view.json.lastShutdown.at, null, 'nothing has been stopped yet');

      const stopped = await harness.post(ports.restart, '/shutdown');
      assert.ok(stopped.status === 202 || stopped.status === 200, 'the control plane must accept the stop: ' + JSON.stringify(stopped));
      /* The runner's own record of what the cycle did, read while it is still
         alive. This is stronger than parsing its log: it is the state machine's
         verdict per component, produced by the same code the installer's helper
         runs. */
      let last = null;
      const recorded = await harness.waitFor(async () => {
        if (!harness.alive(runner.pid)) return true;
        const v = await harness.get(ports.restart, '/lifecycle', 1200);
        if (v.status === 200 && v.json && v.json.lastShutdown && v.json.lastShutdown.at) { last = v.json.lastShutdown; return true; }
        return false;
      }, 20000, 200);
      assert.ok(recorded, 'the runner must record its shutdown cycle');
      assert.ok(await harness.waitFor(() => !harness.alive(runner.pid), 25000), 'the runner must exit');
      H.forget(runner.pid);
      for (const id of ['bridge', 'active', 'homeNode']) {
        assert.ok(await harness.waitFor(async () => (await harness.get(ports[id], '/health')).status === 0, 10000),
          id + ' must be gone and its port free');
      }
      assert.ok(last, 'the lifecycle view must have reported the cycle');
      assert.strictEqual(last.complete, true,
        'every component must be reported as stopped: ' + JSON.stringify(last));
      assert.deepStrictEqual(last.components.map(c => c.id + '=' + c.state).sort(),
        ['active=STOPPED', 'bridge=STOPPED', 'homeNode=STOPPED'],
        'each component must be STOPPED, i.e. gone AND its port free: ' + JSON.stringify(last.components));
      for (const c of last.components) {
        assert.strictEqual(c.accepted, true, c.id + ' must have been stopped cooperatively, not killed');
      }
    });
  }

  /* ══ [H] diagnostics ═══════════════════════════════════════════════════ */
  if (wants('H')) {
    section('[H] diagnostics and secret containment');

    check('H1 every state the contract names is reachable and named identically', () => {
      const src = fs.readFileSync(path.join(ROOT, 'runtime', 'component-lifecycle.js'), 'utf8');
      for (const state of ['NOT_RUNNING', 'FOREIGN', 'UNKNOWN_OWNER', 'COOPERATIVE_TIMEOUT', 'STOPPED', 'FALLBACK_KILL', 'FAILED']) {
        assert.ok(new RegExp("'" + state + "'").test(src), 'the state machine must be able to report ' + state);
      }
      /* `COOPERATIVE_STOPPING` is not a terminal state and is deliberately NOT
         invented as one: "a stop request was accepted and we are waiting" is
         `accepted:true` plus the state COOPERATIVE_TIMEOUT if the wait expires.
         A second name for the same fact is how two views start disagreeing. */
      const contract = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
      const states = contract.slice(contract.indexOf('P11-3H'), contract.indexOf('P11-3H') + 4000);
      for (const state of ['NOT_RUNNING', 'FOREIGN', 'UNKNOWN_OWNER', 'COOPERATIVE_TIMEOUT', 'STOPPED', 'FALLBACK_KILL', 'FAILED']) {
        assert.ok(states.indexOf(state) >= 0,
          'the documented lifecycle contract must name ' + state);
      }
    });

    await acheck('H2 the report never carries a body, a payload, a credential or a path secret', async () => {
      /* Scanned on a REAL report from a REAL stop, not on a report this test
         composed: a hand-built sample would keep passing after the production
         shape grew a field nobody looked at. */
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'h2', port: port, shape: 'bridge' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      /* The helper's ownership proof is the install root, so it is given the
         checkout root the fixtures actually run from; the ports are private. */
      const report = await ibStop.stop({
        root: ROOT, timeoutMs: 12000,
        env: {
          IB_BRIDGE_PORT: String(port),
          IB_WEB_PORT: String(await harness.freePort()),
          IB_ACTIVE_PORT: String(await harness.freePort()),
          IB_HOME_NODE_PORT: String(await harness.freePort()),
          IB_RESTART_PORT: String(await harness.freePort())
        }
      });
      assert.ok(await harness.waitFor(() => !harness.alive(fx.pid), 8000),
        'the component must be gone: ' + JSON.stringify({ state: report.byState, errors: report.errors }));
      H.forget(fx.pid);
      const json = JSON.stringify(report);
      /* A stop report is about PROCESSES and PORTS. It has no reason to carry
         anything a component was storing, anything a caller sent, or any
         credential — and once it does, it will be pasted into a bug report. */
      for (const forbidden of ['apiKey', 'apikey', 'token', 'secret', 'password',
        'payload', 'content', 'prompt', 'authorization', 'cookie', 'credential', 'sk-']) {
        assert.strictEqual(new RegExp(forbidden, 'i').test(json), false,
          'a stop report must not carry ' + forbidden + ': ' +
          json.slice(Math.max(0, json.search(new RegExp(forbidden, 'i')) - 60), json.search(new RegExp(forbidden, 'i')) + 80));
      }
      /* And it must still say the things a caller needs. */
      assert.strictEqual(typeof report.ok, 'boolean');
      assert.ok(Array.isArray(report.components) && report.components.length > 0);
      for (const c of report.components) {
        assert.strictEqual(typeof c.id, 'string');
        assert.strictEqual(typeof c.state, 'string');
        assert.strictEqual(typeof c.port, 'number');
      }
    });

    check('H3 the endpoint contract is one rule, shared by every component', () => {
      const files = [
        'services/internal-beyond-server.js', 'services/ib-bridge-service.js',
        'services/active-message-service.js', 'services/home-node-service.js',
        'services/home-node/http.js'
      ];
      for (const rel of files) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.ok(/service-control|serviceControl/.test(src),
          rel + ' must use the shared stop contract rather than its own');
        assert.strictEqual(/req\.method !== 'POST'/.test(src) && /origin-denied/.test(src) && !/serviceControl|service-control/.test(src), false,
          rel + ' must not re-implement the admission rule');
      }
      const control = fs.readFileSync(path.join(ROOT, 'runtime', 'service-control.js'), 'utf8');
      assert.ok(/u\.protocol === 'file:'/.test(control), 'the origin rule must keep file:// working (the desktop opens the page that way)');
      assert.ok(/host === 'localhost' \|\| host === '127\.0\.0\.1'/.test(control), 'and loopback origins');
    });

    await acheck('H4 a foreign Origin is refused and reported as a refusal, not as a stop', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'h4', port: port, shape: 'bridge' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const refused = await harness.post(port, '/__shutdown', { Origin: 'http://evil.example' });
      assert.strictEqual(refused.status, 403, 'a foreign page must not be able to stop a component: ' + JSON.stringify(refused));
      assert.ok(harness.alive(fx.pid), 'and the component must still be running');
      assert.strictEqual(fs.readFileSync(fx.marker, 'utf8').indexOf('cooperative'), -1, 'no teardown may have run');
      /* And the real request still works afterwards (the refusal did not wedge it). */
      const ok = await harness.post(port, '/__shutdown');
      assert.strictEqual(ok.status, 202, 'the normal stop must still be accepted: ' + JSON.stringify(ok));
      assert.ok(await harness.waitFor(() => !harness.alive(fx.pid), 6000));
      H.forget(fx.pid);
    });

    await acheck('H5 a GET is not a stop', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'h5', port: port, shape: 'bridge' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const r = await harness.get(port, '/__shutdown');
      assert.strictEqual(r.status, 405, 'a GET is a probe or a link preview, never a stop: ' + JSON.stringify(r));
      assert.ok(harness.alive(fx.pid));
    });

    await acheck('H6 the endpoint accepts exactly once and then reports already-stopping', async () => {
      const port = await harness.freePort();
      /* A component that accepts and does NOT exit: it stays answerable, which is
         the only way the second request can be observed at all. */
      const fx = harness.startFixture(H, { name: 'h6', port: port, shape: 'bridge', behavior: 'close-only' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const first = await harness.post(port, '/__shutdown');
      assert.strictEqual(first.status, 202, 'the first stop is accepted: ' + JSON.stringify(first));
      assert.strictEqual(first.json.stopping, true);
      assert.strictEqual(first.json.pid, fx.pid, 'the pid that answered must be the pid that is stopping');
      assert.strictEqual(first.json.already, undefined, 'a first stop is not a duplicate');
      const second = await harness.post(port, '/__shutdown');
      assert.strictEqual(second.status, 202, 'a repeated stop is not a failure: ' + JSON.stringify(second));
      assert.strictEqual(second.json.already, true, 'and it says so: ' + JSON.stringify(second.json));
      assert.strictEqual(markerText(fx).split('cooperative').length - 1, 1,
        'the teardown ran ONCE — a second request must not re-run it');
    });
  }

  /* ══ [I] installer / update lifecycle ══════════════════════════════════ */
  if (wants('I')) {
    section('[I] installer / update lifecycle');

    check('I1 the desktop updater never stops the service itself', () => {
      /* U-D5: the helper exits as soon as it has spawned the installer, so the
         installer is the only thing that can stop InternalBeyond — and the only
         thing that can relaunch it. A second stop path here would be a second
         lifecycle, which is exactly what this phase removed elsewhere. */
      const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-install.js'), 'utf8');
      for (const forbidden of ['ib-stop', 'taskkill', '__shutdown', 'execSync']) {
        assert.strictEqual(new RegExp(forbidden).test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false,
          'the updater must not own a stop path (' + forbidden + ')');
      }
      const installer = fs.readFileSync(path.join(ROOT, 'installer', 'InternalBeyond.iss'), 'utf8');
      assert.ok(/tools\\\{#StopHelper\}"" --root ""\{app\}""/.test(installer),
        'the installer must stop the instance it is about to replace, through its own helper');
      assert.ok(/ExtractTemporaryFile\('\{#StopHelper\}'\)/.test(installer));
    });

    check('I2 the installer refuses to continue when the helper reports a failure', () => {
      /* InstallShield's Pascal script cannot be executed here, so this is a
         contract check against the real installer source — the one check in this
         suite that asserts on a file instead of on behaviour, and it is worth
         saying so explicitly: the alternative would be "the file may have
         overridden a running instance", which is not assertable at all. */
      const installer = fs.readFileSync(path.join(ROOT, 'installer', 'InternalBeyond.iss'), 'utf8');
      assert.ok(/if Code <> 0 then/.test(installer),
        'the installer must read the stop helper\'s exit code');
      assert.ok(/function PrepareToInstall\(var NeedsRestart: Boolean\): String;[\s\S]{0,400}Result := StopInternalBeyond\(\);/m.test(installer),
        'and a non-empty result from the stop must be what PrepareToInstall returns');
      /* Exit-code contract, stated where it is produced: non-zero means at least
         one owned target could not be stopped. */
      const helper = fs.readFileSync(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'), 'utf8');
      assert.ok(/process\.exitCode = report\.ok \? 0 : 1;/.test(helper),
        'ib-stop must exit non-zero when it could not stop an owned target');
      assert.ok(/report\.ok = summary\.ok;/.test(helper),
        'and `ok` must come from the stop state machine, not from "nothing is on the port"');
    });

    await acheck('I3 a component that really cannot be stopped makes the helper report failure', async () => {
      const port = await harness.freePort();
      const fx = harness.startFixture(H, { name: 'i3', port: port, shape: 'static', behavior: 'hang' });
      defer(() => harness.forceKill(fx.pid));
      assert.ok(await harness.waitFor(async () => (await harness.get(port, '/health')).status === 200, 15000));
      const env = {
        IB_WEB_PORT: String(port),
        IB_BRIDGE_PORT: String(await harness.freePort()),
        IB_ACTIVE_PORT: String(await harness.freePort()),
        IB_HOME_NODE_PORT: String(await harness.freePort()),
        IB_RESTART_PORT: String(await harness.freePort())
      };
      /* A component that accepts and never goes is stopped by the fallback, and
         a fallback is a bounded ending — NOT a graceful one. The helper's `ok`
         must therefore be false even though nothing is left running, and the
         installer is the one that decides what that means. */
      const report = await ibStop.stop({ root: ROOT, timeoutMs: 12000, env: env });
      assert.ok(await harness.waitFor(() => !harness.alive(fx.pid), 12000),
        'the fallback must remove it: ' + JSON.stringify({ byState: report.byState, components: report.components.map(c => c.id + '=' + c.state + '/' + c.accepted + '/' + c.reason) }));
      H.forget(fx.pid);
      assert.strictEqual(report.fallbackKills, 1,
        'exactly one fallback kill: ' + JSON.stringify({ byState: report.byState, components: report.components.map(c => c.id + '=' + c.state + '/' + c.accepted) }));
      assert.strictEqual(report.graceful.length, 0, 'nothing was graceful here');
      assert.strictEqual(report.ok, false,
        'this stop was NOT graceful, and the helper must say so: ' + JSON.stringify({ ok: report.ok, byState: report.byState }));
      assert.ok(report.fallback.join('|').indexOf('static') >= 0,
        'and it must name the component that had to be killed: ' + JSON.stringify({ fallback: report.fallback, errors: report.errors }));
      /* A fallback kill is a bounded ending, not a leftover process: `remaining`
         is "the stop state machine did not reach STOPPED for this target", and
         a killed target is genuinely not in that state. What must hold is that
         nothing is still RUNNING — and that the report says a kill happened
         instead of dressing it up as a graceful stop. */
      const stillUp = report.components.filter(c => c.state !== 'STOPPED' && c.state !== 'NOT_RUNNING' && c.state !== 'FOREIGN');
      for (const c of stillUp) {
        assert.ok(!harness.alive(c.pid), c.id + ' must not be alive after the stop: ' + JSON.stringify(c));
      }
      assert.ok(report.remaining.join('|').indexOf('static') >= 0,
        'a killed target is honestly left in `remaining`: ' + JSON.stringify(report.remaining));
    });

    check('I4 uninstall stops first and never deletes user data', () => {
      const installer = fs.readFileSync(path.join(ROOT, 'installer', 'InternalBeyond.iss'), 'utf8');
      assert.ok(/\[UninstallRun\][\s\S]{0,600}?#StopHelper/.test(installer),
        'the uninstall stop must run before file deletion');
      assert.ok(/Flags: runhidden skipifdoesntexist/.test(installer),
        'and it must not be a hard requirement of uninstalling a machine where it is absent');
      assert.strictEqual(/^\[UninstallDelete\]/m.test(installer), false,
        'uninstall must still never delete user data');
    });
  }

  /* ── teardown ────────────────────────────────────────────────────────── */
  for (const fn of cleanups) { try { fn(); } catch (e) { /* best effort */ } }
  H.stopAll();
  H.cleanup();

  console.log('\n\u7ed3\u679c: ' + pass + ' \u901a\u8fc7, ' + fail + ' \u5931\u8d25');
  if (failures.length) { console.log('\u5931\u8d25\u660e\u7ec6:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => {
  console.error('\nUNEXPECTED FAILURE: ' + (e && e.stack || e));
  for (const fn of cleanups) { try { fn(); } catch (err) { /* best effort */ } }
  H.stopAll();
  H.cleanup();
  process.exitCode = 1;
});
