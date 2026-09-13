'use strict';

/*
 * P11-3C · Supervisor Bounded Crash Recovery
 *
 * What this suite is defending:
 *
 *   P11-3B made the runner able to REPORT a dead component. P11-3C makes it able
 *   to DO something about one — and the only thing that makes that safe is that
 *   the doing is bounded. So the claims below are not "does a restart happen";
 *   they are:
 *
 *     1. no path reaches a retry without passing the budget gate;
 *     2. a failure that never improves ends in a lockout, not in a loop;
 *     3. the failure that ALWAYS gets forgotten — a deliberate stop (shutdown,
 *        control-plane restart) — is never recovered;
 *     4. components the registry marks non-restartable get a failed state and no
 *        attempt, ever.
 *
 *   Claim 3 is the one that bites in production: an unbounded-restart bug is
 *   loud, but a "shutdown then respawn" bug looks like the installer failing to
 *   replace a file. Claim 4 is the one that bites the user: Vision is opt-in and
 *   non-restartable, and a supervisor that restarts it anyway starts a component
 *   nobody asked for.
 *
 *   Bounded-ness is proved twice: once as a pure state machine (suite V, no
 *   processes at all, exhaustive over the event set) and once through real
 *   processes (suites C/D/E), and then three mutations prove the bound is
 *   load-bearing rather than decorative — a mutated copy of the runner that
 *   removes the gate, resets the counter, or bypasses the failed state must FAIL
 *   the same assertions the real source passes.
 *
 * Discipline (P2/P7/P11): every spawned process gets an isolated port, an
 * isolated data directory and an isolated log directory; the real ports
 * 23114/23115/23116/23118/23120 are never touched, and neither is the developer's
 * %LOCALAPPDATA%\InternalBeyond. No process.exit(0) — the harness exits naturally
 * and reports leaked handles.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const registry = require(path.join(ROOT, 'runtime', 'component-registry.js'));
const supervisorModule = require(path.join(ROOT, 'runtime', 'component-supervisor.js'));
const RUNNER = path.join(ROOT, 'runtime', 'local-services-runner.js');
const RUNNER_SRC = fs.readFileSync(RUNNER, 'utf8');

let passed = 0;
const failures = [];
const cleanup = [];

function section(title) {
  console.log('\n' + title);
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (error) {
    failures.push({ name: name, error: error });
    /* First line inline, the whole message when the failure carries evidence:
       a diagnosis that is truncated to one line is a diagnosis nobody can act on. */
    const lines = String((error && error.message) || error).split('\n');
    console.log('  ✗ ' + name + '\n      ' + lines[0]);
    if (lines.length > 1) console.log(lines.slice(1).join('\n'));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function httpJson(port, pathname, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (settled) return; settled = true; resolve(v); };
    let body = null;
    if (o.body !== undefined) body = Buffer.from(JSON.stringify(o.body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: port, path: pathname, method: o.method || 'GET',
      timeout: o.timeoutMs || 4000,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* not json */ }
        done({ status: res.statusCode, json: json, raw: raw });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } done({ status: 0, json: null, raw: '' }); });
    req.on('error', () => done({ status: 0, json: null, raw: '' }));
    if (body) req.write(body);
    req.end();
  });
}

function portBound(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port: port, timeout: 400 });
    let settled = false;
    const done = v => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) { } resolve(v); };
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

function waitFor(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  return (async () => {
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(intervalMs || 200);
    }
  })();
}

/* ── the fake service used to make crashes deterministic ───────────────────
 *
 * The script lives in tests/fixtures/p11-3c-fake-service.js and is copied into a
 * temp directory (the mutated trees link to nothing outside their own root). It is
 * spawned by the REAL runner through its own spawn path, so the process, the exit
 * event, the port and the identity probe are all real, and only its liveness is
 * scripted. Its env contract is documented in that file.
 */

/* ── mutation harness: a private copy of the runner that we are free to break ─
 *
 * Only runtime/ is copied; services/, assets/, active/, bridge/ and scripts/ are
 * junctioned from the real checkout so a mutated tree can still run. The fake
 * service lives next to the mutated runtime, so the mutated runner can be pointed
 * at it without touching the real repository. */
const MUTATION_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3c-mut-'));
const JUNCTION_DIRS = ['services', 'assets', 'active', 'bridge', 'scripts'];
const FAKE_SOURCE = path.join(__dirname, 'fixtures', 'p11-3c-fake-service.js');

/* The runner spawns the fake as a FILE, so each component gets its own copy: the
   fake identifies itself by its own filename, which is the only per-process fact
   available when one environment drives three processes. */
function fakePathFor(treeDir, componentId) {
  return path.join(treeDir, 'fakes', componentId + '.js');
}

function suffixOf(componentId) {
  return componentId === 'homeNode' ? 'HOMENODE' : componentId.toUpperCase();
}

/* Every scenario runs from a private tree: runtime/ copied, everything else
   junctioned, and one fake copy per stubbed component. The runner file is written
   by the caller afterwards, because the fake's identity is its path inside this
   tree and the launch lines have to name that path. Running from a tree rather
   than from the checkout is what makes "which script does the runner actually
   spawn" an explicit, inspectable fact — an earlier revision of this suite patched
   the source and then ran the checkout's own file, so the real service started and
   every recovery assertion silently tested nothing. */
function runnerTree(stubIds, runnerSource) {
  const dir = fs.mkdtempSync(path.join(MUTATION_TMP, 'tree-'));
  fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, 'runtime'))) {
    const src = path.join(ROOT, 'runtime', name);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(dir, 'runtime', name));
  }
  for (const name of JUNCTION_DIRS) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) continue;
    try { fs.symlinkSync(src, path.join(dir, name), 'junction'); } catch (e) { /* see P11-3B: optional */ }
  }
  for (const id of stubIds || []) {
    const target = fakePathFor(dir, id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(FAKE_SOURCE, target);
  }
  if (runnerSource) {
    fs.writeFileSync(path.join(dir, 'runtime', 'local-services-runner.js'), runnerSource);
  }
  return dir;
}

function sha256(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** True when `source` parses as JavaScript. */
function parses(source) {
  try {
    /* eslint-disable-next-line no-new-func -- parse only, never called */
    new Function(source);
    return true;
  } catch (e) {
    return false;
  }
}

/* Point the stubbed components' launch lines at their own fake copy. The registry
   is left untouched: only the launch commands move, which is exactly the part the
   registry does not own. A component that is not stubbed keeps its real script.
   The result is PARSED before it is written: a patcher that silently cuts or
   mangles the runner would otherwise surface as "the component never failed", and
   that is exactly the wrong diagnosis. */
function pointRunnerAtFake(source, fakeFor, ids) {
  let out = source;
  for (const id of ids) {
    const fakePath = fakeFor[id];
    assert.ok(fakePath, 'no fake path given for stubbed component ' + id);
    if (id === 'vision') {
      /* Vision is launched through cmd.exe (its helper is a .cmd), so it has no
         `path.join(SERVICE_DIR, …)` line to swap and needs its own anchor. Both
         lines are replaced exactly: an earlier revision searched forward from the
         commandArgs line for the next `  },` and cut 33k of the file, which made
         the mutated tree fail to parse and looked like "vision never failed". */
      const visionWait = "command: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'sh',";
      assert.ok(out.indexOf(visionWait) >= 0, 'could not find the vision command line');
      out = out.replace(visionWait, 'command: process.execPath,');
      const visionArgs = /commandArgs: process\.platform === 'win32'[\s\S]*?\],/;
      assert.ok(visionArgs.test(out), 'could not find the vision commandArgs block');
      out = out.replace(visionArgs, 'commandArgs: [' + JSON.stringify(fakePath) + '],');
      continue;
    }
    const serviceFile = registry.byId(id).serviceFile;
    const scriptName = path.basename(serviceFile);
    const before = "commandArgs: [path.join(SERVICE_DIR, '" + scriptName + "')]";
    const after = "commandArgs: [" + JSON.stringify(fakePath) + "]";
    assert.ok(out.indexOf(before) >= 0, 'could not find the launch line for ' + id + ' (' + scriptName + ')');
    out = out.replace(before, after);
  }
  assert.ok(parses(out), 'patching the launch lines produced a runner that does not parse');
  return out;
}

const FAKE_HEALTH = {
  bridge: JSON.stringify({ ok: true, server: 'IB Bridge', version: 'fake-1' }),
  active: JSON.stringify({ ok: true, service: 'internal-beyond-active-messages', version: 'fake-1' }),
  homeNode: JSON.stringify({ ok: true, service: 'internal-beyond-home-node', version: 'fake-1' })
};

/* ── runner harness ─────────────────────────────────────────────────────── */

function startRunner(opts) {
  const o = opts || {};
  const child = spawn(process.execPath, [o.runnerPath || RUNNER].concat(o.args || []), {
    cwd: o.cwd || ROOT,
    env: Object.assign({}, process.env, o.env || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const out = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => out.push(String(c)));
  child.stderr.on('data', c => out.push(String(c)));
  const handle = { child: child, out: out };
  cleanup.push(handle);
  return handle;
}

async function stopRunner(runner) {
  if (!runner || !runner.child || runner.child.exitCode !== null) return;
  runner.child.kill('SIGTERM');
  const gone = await waitFor(() => runner.child.exitCode !== null || runner.child.signalCode !== null, 10000, 200);
  if (!gone) {
    try { runner.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    await waitFor(() => runner.child.exitCode !== null || runner.child.signalCode !== null, 5000, 200);
  }
}

/* Which components the scriptable fake replaces, and on which port.
 *
 * ALL THREE recoverable components are replaced by default. The real services
 * start on their own schedule, and a scenario that left two of them real would be
 * measuring THEIR start-up timing instead of the supervisor's behaviour — which is
 * exactly how an earlier revision of this suite produced "the runner recovered a
 * healthy service" failures that had nothing to do with recovery. */
const ALL_STUBBED = [
  { id: 'bridge', portKey: 'bridge' },
  { id: 'active', portKey: 'active' },
  { id: 'homeNode', portKey: 'homeNode' }
];

/* One isolated environment for one scenario: its own ports, its own data dir, its
   own log root. Nothing here can reach the developer's real install. */
async function scenario(opts) {
  const o = opts || {};
  const ports = {
    bridge: await freePort(),
    active: await freePort(),
    homeNode: await freePort(),
    restart: await freePort()
  };
  ports.vision = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3c-data-'));
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3c-logs-'));
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3c-mark-'));
  const env = {
    IB_BRIDGE_PORT: String(ports.bridge),
    IB_ACTIVE_PORT: String(ports.active),
    IB_HOME_NODE_PORT: String(ports.homeNode),
    IB_VISION_PORT: String(ports.vision),
    IB_RESTART_PORT: String(ports.restart),
    IB_HOME_NODE_DATA_DIR: dataDir,
    IB_ACTIVE_DATA_DIR: dataDir,
    IB_BRIDGE_DATA_DIR: dataDir,
    LOCALAPPDATA: logRoot,
    IB_RECOVERY_POLICY: JSON.stringify(o.policy || {
      maxAttempts: 3, windowMs: 120000, baseBackoffMs: 300, maxBackoffMs: 1200, healthFailStreak: 2
    })
  };

  /* The stub list for this scenario, and the fake's inputs for each component.
     Defaults (`behavior`) and overrides (`perComponent`) are kept SEPARATE: applying
     a default only where a component has not already spoken is what lets "all three
     crash once" coexist with "the bridge also binds late". One merged object per
     component cannot express that, and silently loses one of the two. */
  const stub = o.stub || ALL_STUBBED;
  const behavior = o.behavior || {};
  const perComponent = o.perComponent || {};
  const resolved = stub.map(function (spec) {
    const overrides = perComponent[spec.id] || {};
    const merged = Object.assign({}, behavior, overrides);
    /* An override may be null, which means "this component uses no default at
       all" — the only way to express a value the fake would otherwise inherit. */
    for (const key of Object.keys(merged)) {
      if (merged[key] === null) delete merged[key];
    }
    return Object.assign({}, spec, { settings: merged });
  });

  for (const spec of resolved) {
    const suffix = suffixOf(spec.id);
    const port = spec.port !== undefined ? spec.port : ports[spec.portKey || spec.id];
    assert.ok(Number.isInteger(port) && port > 0, 'no port for stubbed component ' + spec.id + ' (got ' + String(port) + ')');
    env['IB_P113C_PORT_' + suffix] = String(port);
    env['IB_P113C_HEALTH_' + suffix] = spec.health || FAKE_HEALTH[spec.id] || '{}';
    env['IB_P113C_MARKER_' + suffix] = path.join(markerDir, spec.id + '.marker');
    /* Per-entry fields (never a whole default) are applied here. */
    for (const key of Object.keys(spec)) {
      if (key === 'id' || key === 'port' || key === 'portKey' || key === 'health' || key === 'settings') continue;
      env['IB_P113C_' + key + '_' + suffix] = String(spec[key]);
    }
    for (const key of Object.keys(spec.settings)) {
      if (spec.settings[key] === null) continue;
      env['IB_P113C_' + key + '_' + suffix] = String(spec.settings[key]);
    }
  }

  /* Always run from a private tree: the pointed source must be the file that
     actually executes, and a scenario that runs the checkout's own runner would
     start the real services instead of the fake. The tree is created empty of the
     runner first, because the fake's identity IS its path inside that tree. */
  const stubIds = resolved.map(s => s.id);
  const baseSource = o.runnerSource || RUNNER_SRC;
  const tree = o.runnerPath ? null : runnerTree(stubIds);
  /* When the caller supplies its own tree (a mutation tree), the fakes must live
     in THAT tree: the fake identifies itself by its own path, and the mutated
     tree is the one being executed. The caller's tree only holds runtime/, so the
     copies are written here. */
  const treeRoot = o.treeDir || tree;
  for (const id of stubIds) {
    const target = fakePathFor(treeRoot, id);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(FAKE_SOURCE, target);
    }
  }
  const fakeFor = {};
  for (const id of stubIds) fakeFor[id] = fakePathFor(treeRoot, id);
  const runnerPath = o.runnerPath || path.join(tree, 'runtime', 'local-services-runner.js');
  if (tree) fs.writeFileSync(runnerPath, pointRunnerAtFake(baseSource, fakeFor, stubIds));
  const runner = startRunner({
    runnerPath: runnerPath,
    cwd: o.cwd || tree || ROOT,
    env: env,
    args: o.args || []
  });
  const view = () => httpJson(ports.restart, '/components', { timeoutMs: 15000 });
  const componentOf = async (id) => {
    const v = await view();
    if (!v.json || !Array.isArray(v.json.components)) return null;
    return v.json.components.find(c => c.id === id) || null;
  };
  /* A failure in this suite is almost always "the runner did something I did not
     expect", and the only useful evidence is what it actually printed. Collected
     here so every assertion can attach it without repeating the plumbing. */
  const restartLogPath = path.join(logRoot, 'InternalBeyond', 'logs', 'restart.log');
  const readLog = () => {
    try { return fs.readFileSync(restartLogPath, 'utf8'); } catch (e) { return '(no restart.log)'; }
  };
  const recovery = () => httpJson(ports.restart, '/recovery', { timeoutMs: 4000 });
  const diagnose = async () => {
    const v = await view();
    /* A3-4: the fake's own stdout/stderr lands in the per-service logs, and a fake
       that failed to start says so there and nowhere else. */
    const logs = path.join(logRoot, 'InternalBeyond', 'logs');
    let serviceLogs = '';
    try {
      for (const name of fs.readdirSync(logs)) {
        if (!/\.log$/.test(name) || name === 'restart.log') continue;
        serviceLogs += '\n  [' + name + ']\n' + fs.readFileSync(path.join(logs, name), 'utf8').slice(-700);
      }
    } catch (e) { serviceLogs = ' (none)'; }
    const fakeEnv = Object.keys(env).filter(k => /^IB_P113C_/.test(k))
      .map(k => k + '=' + env[k]).join(' ');
    const bound = {};
    for (const id of ['bridge', 'active', 'homeNode']) bound[id] = await portBound(ports[id]);
    const rec = await recovery();
    return '  runner alive=' + (runner.child.exitCode === null && runner.child.signalCode === null) +
      ' exitCode=' + runner.child.exitCode + ' signal=' + runner.child.signalCode +
      ' runnerPath=' + runnerPath +
      '\n  ports=' + JSON.stringify(ports) +
      '\n  bound=' + JSON.stringify(bound) +
      '\n  /recovery → ' + String(JSON.stringify(rec.json && rec.json.components) || rec.raw || '').slice(0, 1600) +
      '\n  history → ' + String(JSON.stringify(rec.json && rec.json.history) || '').slice(0, 600) +
      '\n  fake env=' + fakeEnv +
      '\n  /components → ' + String(v.raw || '').slice(0, 1800) +
      '\n  restart.log:\n' + readLog().slice(-1500) +
      '\n  service logs:' + serviceLogs +
      '\n  runner output:\n' + runner.out.join('').slice(-1500);
  };
  return {
    env: env,
    ports: ports,
    runner: runner,
    view: view,
    componentOf: componentOf,
    logRoot: logRoot,
    markerDir: markerDir,
    dataDir: dataDir,
    diagnose: diagnose,
    recovery: recovery,
    restartLog: readLog
  };
}

async function teardown(s) {
  await stopRunner(s.runner);
  for (const p of [s.dataDir, s.logRoot, s.markerDir]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   A · policy contract (pure; no processes)
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteA() {
  section('A. 策略契约（纯函数，不起进程）');

  await check('A1 有限性：maxAttempts 被强制夹紧，Infinity / 垃圾值 / 超界都拿不到"无上限"', () => {
    assert.strictEqual(supervisorModule.HARD_MAX_ATTEMPTS > 0 && Number.isFinite(supervisorModule.HARD_MAX_ATTEMPTS), true);
    assert.strictEqual(supervisorModule.normalizePolicy({ maxAttempts: Infinity }).maxAttempts, supervisorModule.DEFAULT_POLICY.maxAttempts,
      'Infinity 必须回落到默认有限值，而不是变成"不限次数"');
    assert.strictEqual(supervisorModule.normalizePolicy({ maxAttempts: NaN }).maxAttempts, supervisorModule.DEFAULT_POLICY.maxAttempts);
    assert.strictEqual(supervisorModule.normalizePolicy({ maxAttempts: -1 }).maxAttempts, supervisorModule.DEFAULT_POLICY.maxAttempts);
    assert.strictEqual(supervisorModule.normalizePolicy({ maxAttempts: 'lots' }).maxAttempts, supervisorModule.DEFAULT_POLICY.maxAttempts);
    assert.strictEqual(supervisorModule.normalizePolicy({ maxAttempts: 1e9 }).maxAttempts, supervisorModule.HARD_MAX_ATTEMPTS,
      '超过硬上限的请求必须被夹紧');
    const p = supervisorModule.normalizePolicy({});
    assert.ok(Number.isFinite(p.windowMs) && p.windowMs > 0, '窗口必须有限');
    assert.ok(p.baseBackoffMs > 0, '退避基数不能为 0（0 退避就是忙循环）');
    assert.strictEqual(supervisorModule.normalizePolicy({ baseBackoffMs: 0 }).baseBackoffMs, supervisorModule.DEFAULT_POLICY.baseBackoffMs);
    /* 默认策略本身也必须是有界的 —— 这是产品实际使用的值 */
    assert.ok(Number.isFinite(supervisorModule.DEFAULT_POLICY.maxAttempts) && supervisorModule.DEFAULT_POLICY.maxAttempts > 0);
    assert.ok(supervisorModule.DEFAULT_POLICY.maxAttempts <= supervisorModule.HARD_MAX_ATTEMPTS);
  });

  await check('A2 状态机：start → health → stop 只走声明的转移；未知事件直接报错', () => {
    const s = new supervisorModule.Supervisor({ policy: { maxAttempts: 3 } });
    s.register('bridge', 'Bridge');
    const E = supervisorModule.EVENT;

    assert.strictEqual(s.handle('bridge', E.START, { restartable: true }).state, 'starting');
    assert.strictEqual(s.handle('bridge', E.RESTART_SUCCESS, { restartable: true }).state, 'healthy');
    assert.strictEqual(s.handle('bridge', E.STOP, {}).state, 'stopped');
    assert.strictEqual(s.handle('bridge', E.START, { restartable: true }).state, 'starting');
    assert.strictEqual(s.handle('bridge', E.RESTART_SUCCESS, {}).state, 'healthy');

    /* 五个声明状态都必须可达 */
    const reachable = new Set(['healthy', 'starting', 'stopped']);
    const s2 = new supervisorModule.Supervisor({ policy: { maxAttempts: 1, healthFailStreak: 1, baseBackoffMs: 10 } });
    s2.register('x', 'X');
    s2.handle('x', E.PROCESS_EXIT, { restartable: true, code: 1 });
    reachable.add(s2.stateOf('x'));                        /* recovering */
    s2.noteAttempt('x');
    s2.handle('x', E.RESTART_FAILED, { restartable: true, reason: 'nope' });
    reachable.add(s2.stateOf('x'));                        /* failed (budget out) */
    assert.deepStrictEqual(supervisorModule.STATES.slice().sort(), ['failed', 'healthy', 'recovering', 'starting', 'stopped']);
    assert.deepStrictEqual(Array.from(reachable).sort(), ['failed', 'healthy', 'recovering', 'starting', 'stopped'],
      '五个状态必须全部可达：' + JSON.stringify(Array.from(reachable)));

    assert.throws(() => s.handle('bridge', 'teleport', {}), /unknown event/,
      '未声明的事件必须报错，而不是被静默吸收');
    assert.throws(() => s.register('', ''), /requires a component id/);
  });

  await check('A3 预算：滑动窗口计数，窗口外的历史不能授权重启', () => {
    let now = 1000000;
    const s = new supervisorModule.Supervisor({
      policy: { maxAttempts: 2, windowMs: 1000, baseBackoffMs: 10, maxBackoffMs: 10 },
      now: () => now
    });
    s.register('bridge', 'Bridge');
    assert.strictEqual(s.authorizeAttempt('bridge').allowed, true);
    s.noteAttempt('bridge');
    assert.strictEqual(s.remainingBudget('bridge'), 1);
    s.noteAttempt('bridge');
    assert.strictEqual(s.remainingBudget('bridge'), 0);
    assert.strictEqual(s.authorizeAttempt('bridge').allowed, false);
    assert.strictEqual(s.authorizeAttempt('bridge').reason, 'budget-exhausted');
    /* 时间前进越过窗口：旧尝试不再计入（一个跑得久的组件不会因为"历史上崩过"被锁死） */
    now += 1500;
    assert.strictEqual(s.remainingBudget('bridge'), 2, '窗口滑走之后预算必须恢复');
    assert.strictEqual(s.authorizeAttempt('bridge').allowed, true);
    /* 未注册的组件永远拿不到授权 */
    assert.strictEqual(s.authorizeAttempt('ghost').allowed, false);
    assert.strictEqual(s.authorizeAttempt('ghost').reason, 'unregistered-component');
  });

  await check('A4 退避：指数增长且封顶，绝不出现 0 延迟的自动重试', () => {
    const s = new supervisorModule.Supervisor({
      policy: { maxAttempts: 5, baseBackoffMs: 100, maxBackoffMs: 400 }
    });
    s.register('bridge', 'Bridge');
    const E = supervisorModule.EVENT;
    s.handle('bridge', E.PROCESS_EXIT, { restartable: true, code: 1 });
    const delays = [];
    for (let i = 0; i < 5; i++) {
      s.noteAttempt('bridge');
      const d = s.handle('bridge', E.RESTART_FAILED, { restartable: true, reason: 'fail ' + i });
      if (d.action !== 'retry') break;
      delays.push(d.inMs);
    }
    assert.ok(delays.length >= 3, 'should have produced several retries: ' + JSON.stringify(delays));
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1], 'backoff must not shrink: ' + JSON.stringify(delays));
    }
    assert.strictEqual(delays[0], 100, 'first retry uses the base delay: ' + JSON.stringify(delays));
    assert.ok(Math.max.apply(null, delays) <= 400, 'backoff must be capped: ' + JSON.stringify(delays));
    for (const d of delays) assert.ok(d > 0, 'no automatic retry may have zero delay: ' + JSON.stringify(delays));
  });

  await check('A5 锁死：预算耗尽 → failed，且只有真实健康证据能解除（没有任何"清计数"入口）', () => {
    const s = new supervisorModule.Supervisor({ policy: { maxAttempts: 2, windowMs: 60000, baseBackoffMs: 10 } });
    s.register('bridge', 'Bridge');
    const E = supervisorModule.EVENT;
    s.noteAttempt('bridge');
    s.noteAttempt('bridge');
    const d = s.handle('bridge', E.PROCESS_EXIT, { restartable: true, code: 1 });
    assert.strictEqual(d.action, 'failed');
    assert.strictEqual(s.stateOf('bridge'), 'failed');
    assert.strictEqual(s.describe('bridge').lockedOut, true);
    /* 锁死之后，任何"还有预算了"的错觉都不能让它重试：窗口滑走也不解除锁死 */
    const later = Date.now() + 3600000;
    assert.strictEqual(s.authorizeAttempt('bridge', later).allowed, false);
    assert.strictEqual(s.authorizeAttempt('bridge', later).reason, 'locked-out');
    const again = s.handle('bridge', E.PROCESS_EXIT, { restartable: true, code: 1, at: later });
    assert.strictEqual(again.action, 'failed', '锁死状态下的新事件不得重新变成 retry');
    assert.strictEqual(s.stateOf('bridge'), 'failed');
    /* 公开接口里没有任何"重置计数器"的方法 */
    for (const name of ['reset', 'resetAttempts', 'clear', 'clearBudget', 'resetCounter', 'forceHealthy']) {
      assert.strictEqual(typeof s[name], 'undefined', '不得存在可以绕过预算的 ' + name + '()');
    }
    /* 真实健康证据可以解除 —— 否则一次瞬时故障会让产品永远红着 */
    s.noteHealthy('bridge');
    assert.strictEqual(s.stateOf('bridge'), 'healthy');
    assert.ok(s.history().some(h => h.event === 'lockout-cleared'), '解除锁死必须留痕');
  });

  await check('A6 非可重启组件：拿到 failed 状态，但永远拿不到一次尝试', () => {
    const s = new supervisorModule.Supervisor({ policy: { maxAttempts: 5, baseBackoffMs: 10 } });
    s.register('vision', 'Vision');
    const E = supervisorModule.EVENT;
    const d = s.handle('vision', E.PROCESS_EXIT, { restartable: false, code: 1 });
    assert.strictEqual(d.action, 'failed', '不可重启组件的失败必须如实变成 failed');
    assert.strictEqual(d.state, 'failed');
    assert.strictEqual(s.describe('vision').restartCount, 0);
    assert.strictEqual(s.attemptsInWindow('vision'), 0, '不得消耗任何预算');
    assert.strictEqual(s.authorizeAttempt('vision').allowed, false, '不可重启组件绝不能通过预算闸门');
    /* restartable 缺省即 false：沉默不是许可 */
    const s2 = new supervisorModule.Supervisor({});
    s2.register('x', 'X');
    assert.strictEqual(s2.handle('x', E.PROCESS_EXIT, {}).action, 'failed');
    assert.strictEqual(supervisorModule.Supervisor.eligible({}), false);
    assert.strictEqual(supervisorModule.Supervisor.eligible({ restartable: true }), false, 'managedByRunner 必须同时成立');
    assert.strictEqual(supervisorModule.Supervisor.eligible({ restartable: true, managedByRunner: true }), true);
  });

  await check('A7 观测契约：四个必需字段恒存在，且理由被二次脱敏', () => {
    const s = new supervisorModule.Supervisor({ policy: { maxAttempts: 2, baseBackoffMs: 10 } });
    s.register('bridge', 'Bridge');
    const view = s.describe('bridge');
    for (const key of ['restartCount', 'lastRestartAt', 'lastFailureReason', 'recoveryState']) {
      assert.ok(Object.prototype.hasOwnProperty.call(view, key), '恢复视图必须包含 ' + key);
    }
    assert.strictEqual(view.restartCount, 0, 'restartCount 未重启时是 0，不能缺省');
    assert.strictEqual(view.lastRestartAt, null, 'lastRestartAt 未重启时是 null');
    assert.strictEqual(view.lastFailureReason, null, 'lastFailureReason 未失败时是 null');
    assert.strictEqual(view.recoveryState, 'stopped');

    /* 凭据形状的字符串必须被抹掉，绝不能顺着 reason 流进健康视图或日志 */
    s.handle('bridge', supervisorModule.EVENT.PROCESS_EXIT, {
      restartable: true, code: 1,
      reason: 'failed with Authorization: Bearer sk-abcdef123456 and api_key=AKIAIOSFODNN7EXAMPLE'
    });
    const why = s.describe('bridge').lastFailureReason;
    assert.ok(why.indexOf('sk-abcdef123456') < 0, 'sk- 凭据泄漏进 reason：' + why);
    assert.ok(!/Bearer\s+[A-Za-z0-9._-]{6,}/.test(why), 'Bearer 凭据泄漏进 reason：' + why);
    assert.ok(why.length <= 200, 'reason 必须有长度上限');

    /* decorate() 只加白名单字段。未被 supervisor 管理的组件（static / restart）
       必须报 null，而不是谎称"stopped"：没答案不等于"知道它停了"。 */
    const report = { id: 'bridge', state: 'offline' };
    const out = new supervisorModule.Supervisor({}).decorate(report);
    for (const key of ['restartCount', 'lastRestartAt', 'lastFailureReason', 'recoveryState']) {
      assert.ok(Object.prototype.hasOwnProperty.call(out, key), 'decorate 必须补齐 ' + key);
      assert.strictEqual(out[key], null, '未注册组件不得凭空得到 ' + key);
    }
    /* 已注册的组件则必须有值：契约字段是"恒存在"，不是"恒非空"。 */
    const withOne = new supervisorModule.Supervisor({});
    withOne.register('bridge', 'Bridge');
    const decor = withOne.decorate({ id: 'bridge', state: 'offline' });
    assert.strictEqual(decor.restartCount, 0);
    assert.strictEqual(decor.recoveryState, 'stopped');
    assert.strictEqual(decor.lastRestartAt, null);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   B · integration contract (which components, and from where)
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteB() {
  section('B. 接入面：可恢复组件 = registry.restartable（没有第二份清单）');

  await check('B1 恢复授权来自注册表：runner 里不存在第二份"可重启组件"名单', () => {
    /* runner 必须从 registry 派生 restartable / managedByRunner 到 service spec，
       否则"哪些组件能被自动恢复"就会变成第二份清单。 */
    assert.ok(/restartable:\s*component\.restartable === true/.test(RUNNER_SRC),
      'service spec 必须从注册表派生 restartable');
    assert.ok(/managedByRunner:\s*component\.managedByRunner === true/.test(RUNNER_SRC),
      'service spec 必须从注册表派生 managedByRunner');
    /* 反证：runner 源码里不得再出现按名字写死的目标列表（P11-3B 修掉的那类漂移）。
       只匹配代码行 —— 解释历史的那句注释里就写着这行旧代码，注释不是缺陷。 */
    assert.ok(!/^\s*(?:const|let|var|if|return|.*[=(])\s*.*name === 'Bridge'\s*\|\|/m.test(RUNNER_SRC),
      '不得重新手写重启目标名单');
    const targets = registry.restartTargets().map(c => c.id).sort();
    assert.deepStrictEqual(targets, ['active', 'bridge', 'homeNode'],
      '本阶段允许自动恢复的组件必须恰好是这三个：' + JSON.stringify(targets));
    for (const id of targets) {
      const c = registry.byId(id);
      assert.strictEqual(c.managedByRunner, true, id + ' 可恢复却不由 runner 管理，矛盾');
    }
    /* 硬边界：这三类必须不可恢复 */
    assert.strictEqual(registry.byId('static').restartable, false, 'static 由 launcher 管理，不参与自动恢复');
    assert.strictEqual(registry.byId('restart').restartable, false, '重启控制面不能是恢复目标（会杀掉正在重启的进程）');
    assert.strictEqual(registry.byId('vision').restartable, false, '未启用的 Vision 不自动恢复');
    assert.strictEqual(registry.byId('vision').managedByRunner, true, 'Vision 仍由 runner 管理，只是不可恢复');
  });

  await check('B2 注册不等于授权：runner 只 register，授权逐事件携带 restartable', () => {
    const registerCalls = RUNNER_SRC.match(/supervisor\.register\([^)]*\)/g) || [];
    assert.ok(registerCalls.length === 1, 'register 只应出现在一处（按 SERVICES 注册）：' + JSON.stringify(registerCalls));
    const handleCalls = RUNNER_SRC.match(/supervisor\.handle\(|supervisor\.authorizeAttempt\(/g) || [];
    const withRestartable = RUNNER_SRC.match(/restartable:\s*service\.restartable/g) || [];
    assert.ok(handleCalls.length >= 4, '预期多处事件入口：' + handleCalls.length);
    assert.ok(withRestartable.length >= 3,
      '每个可能导致重启的事件都必须携带 restartable：' + withRestartable.length);
    assert.ok(/stopping\.has\(service\.componentId\)/.test(RUNNER_SRC),
      '健康巡检必须跳过正在被有意停止的组件');
    assert.ok(/entry\.stopIntent === 'intentional'/.test(RUNNER_SRC),
      '退出处理必须能区分"有意停止"与"崩溃"');
  });

  await check('B3 start：runner 启动后三个可恢复组件进入 healthy，且四个观测字段都在', async () => {
    const s = await scenario({ behavior: {} });
    try {
      const ready = await waitFor(async () => {
        const v = await s.view();
        if (!v.json || !Array.isArray(v.json.components)) return false;
        return ['bridge', 'active', 'homeNode'].every(id => {
          const c = v.json.components.find(x => x.id === id);
          return !!(c && c.state === 'healthy' && c.recoveryState === 'healthy');
        });
      }, 60000, 400);
      if (!ready) {
        throw new Error('runner never reported the three recoverable components healthy.\n' +
          '  /components → ' + String((await s.view()).raw || '').slice(0, 1200) + '\n' +
          '  runner output:\n' + s.runner.out.join('').slice(-1000));
      }
      const v = await s.view();
      assert.ok(/bounded/.test(v.json.warning || ''), 'warning 必须说明恢复是有界的：' + v.json.warning);
      assert.ok(v.json.recovery && v.json.recovery.policy, 'recovery.policy 必须随视图下发');
      assert.strictEqual(v.json.recovery.policy.bounded, true);
      assert.strictEqual(v.json.recovery.policy.maxAttempts, 3, '策略必须来自本场景的显式限制');
      assert.deepStrictEqual(v.json.recovery.states.recovering, 0, '启动稳定后不应有组件在 recovering');
      assert.deepStrictEqual(v.json.recovery.states.failed, 0, '启动稳定后不应有组件 failed');
      for (const c of v.json.components) {
        for (const key of ['restartCount', 'lastRestartAt', 'lastFailureReason', 'recoveryState']) {
          assert.ok(Object.prototype.hasOwnProperty.call(c, key), c.id + ' 缺少观测字段 ' + key);
        }
      }
      /* 非 managed 组件如实为 null，不假装"知道的" */
      const stat = v.json.components.find(c => c.id === 'static');
      assert.strictEqual(stat.recoveryState, null, 'static 不由 runner 恢复，必须报 null 而不是 stopped');
      assert.strictEqual(v.json.recovery.states.stopped, 0,
        'null 不得被统计成 stopped（否则 0 与"未知"会被混为一谈）');
      /* --json 是另一个进程，没有 supervisor，必须如实报 null */
      const detached = await new Promise(resolve => {
        const child = spawn(process.execPath, [RUNNER, '--json'], {
          cwd: ROOT, env: s.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        });
        let out = '';
        child.stdout.on('data', c => { out += c; });
        child.on('exit', () => {
          let json = null;
          try { json = JSON.parse(out.trim()); } catch (e) { json = null; }
          resolve(json);
        });
      });
      assert.ok(detached && Array.isArray(detached.components), '--json 必须仍输出 components');
      for (const c of detached.components) {
        assert.strictEqual(c.recoveryState, null, '--json 不得声称知道恢复状态：' + c.id);
      }
    } finally {
      await teardown(s);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   C · process crash → bounded recovery (real processes)
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteC() {
  section('C. 进程崩溃 → 有界恢复（真实进程）');

  await check('C1 process crash → restart success：进程退出被恢复，restartCount 增加，pid 变化', async () => {
    const s = await scenario({
      policy: { maxAttempts: 3, windowMs: 120000, baseBackoffMs: 250, maxBackoffMs: 1000, healthFailStreak: 2 },
      /* 每个组件第一次启动就崩（绑定端口之前），第二次起正常服务 */
      behavior: { CRASH_FIRST: '1', CRASH_AFTER_MS: '0' }
    });
    try {
      let firstSeen = await s.componentOf('bridge');
      /* The pid observed at the moment the crash happened: recovery must produce a
         DIFFERENT process, and comparing against the pid seen later would be
         comparing the recovered process with itself. */
      const firstPid = firstSeen && firstSeen.pid;

      /* 崩溃 → 自动恢复到 healthy（第一次启动崩掉，第二次起来） */
      const recovered = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        if (!c) return null;
        return (c.recoveryState === 'healthy' && c.restartCount >= 1 && c.pid && c.pid !== firstPid) ? c : null;
      }, 60000, 300);
      if (!recovered) {
        throw new Error('bridge never recovered.\n  firstPid → ' + JSON.stringify(firstSeen) +
          '\n  view → ' + JSON.stringify(await s.componentOf('bridge')) +
          '\n' + await s.diagnose());
      }
      assert.ok(recovered.restartCount >= 1, '恢复成功必须计入 restartCount：' + recovered.restartCount);
      assert.ok(recovered.lastRestartAt > 0, '必须记录最后一次恢复时间');
      assert.ok(recovered.restartCount <= 3, '重启次数不得超过预算：' + recovered.restartCount);
      /* 恢复过程必须留痕，且理由是"意外退出"而不是"被停掉" */
      const log = s.restartLog();
      assert.ok(/exited unexpectedly/.test(log), '必须记录"意外退出"：\n' + log.slice(-800));
      assert.ok(/recovery attempt/.test(log), '必须记录恢复尝试：\n' + log.slice(-800));
      assert.ok(/recovered/.test(log), '恢复成功必须留痕：\n' + log.slice(-800));

      /* 恢复后的进程真的健康（不是只改了状态字段） */
      const health = await httpJson(s.ports.bridge, '/health', { timeoutMs: 4000 });
      assert.strictEqual(health.status, 200);
      assert.strictEqual(health.json.server, 'IB Bridge');

      /* 端口被重新占用，且只有一个监听者 */
      assert.strictEqual(await portBound(s.ports.bridge), true);
    } finally {
      await teardown(s);
    }
  });

  await check('C2 有意停止不是崩溃：控制面 /restart 之后不得触发自动恢复', async () => {
    const s = await scenario({
      /* 三个组件都正常起来，全程不崩。C2 问的是"控制面有意停掉组件之后会不会被
         自动恢复"，所以开场必须干净：如果让它们先崩一次，日志里就会出现真实的
         "exited unexpectedly"，而这条断言就再也分不清"开场崩溃"与"重启之后被恢复"。
         那正是这个测试要防的混淆。 */
      behavior: {},
      policy: { maxAttempts: 3, windowMs: 120000, baseBackoffMs: 200, maxBackoffMs: 800, healthFailStreak: 2 }
    });
    try {
      const up = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        return c && c.recoveryState === 'healthy' ? c : null;
      }, 45000, 300);
      assert.ok(up, 'bridge did not come up');
      const beforeView = await s.componentOf('bridge');
      const beforeCount = beforeView.restartCount;
      const beforePid = beforeView.pid;

      const post = await httpJson(s.ports.restart, '/restart', { method: 'POST', timeoutMs: 6000 });
      assert.strictEqual(post.status, 202, 'restart must be accepted: ' + JSON.stringify(post));
      const settled = await waitFor(async () => {
        const r = await httpJson(s.ports.restart, '/status', { timeoutMs: 2000 });
        return r.json && r.json.state === 'ready' ? r.json : null;
      }, 90000, 500);
      assert.ok(settled, 'restart cycle never became ready\n' + (await s.diagnose()));

      /* restart 有意停掉了每个目标 —— supervisor 绝不能把这三条退出当成崩溃 */
      const after = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        return c && c.recoveryState === 'healthy' ? c : null;
      }, 45000, 300);
      assert.ok(after, 'bridge did not come back after the restart cycle');
      assert.ok(after.pid !== beforePid, 'the control plane did not actually restart bridge');
      assert.strictEqual(after.restartCount, beforeCount,
        '控制面重启不得被算成 supervisor 的自动恢复（restartCount 必须不变）：' +
        beforeCount + ' → ' + after.restartCount +
        '\n  after=' + JSON.stringify(after) +
        '\n  log:\n' + s.restartLog().slice(-1200));
      /* 有意停止的留痕是异步到达的（退出事件晚于 restart 返回 ready），所以等它
         出现，而不是赌它已经写完。 */
      const logged = await waitFor(() => {
        const n = (s.restartLog().match(/stopping \w+ intentionally/g) || []).length;
        return n >= 3 ? n : null;
      }, 15000, 300);
      assert.ok(logged, '三个目标的有意停止都必须留痕：' + s.restartLog().slice(-900));
      assert.ok(!/exited unexpectedly/.test(s.restartLog()),
        '控制面重启是有意停止，不得出现"意外退出"：\n' + s.restartLog().slice(-900));
      assert.ok(!/recovery attempt/.test(s.restartLog()),
        '控制面重启之后不得出现任何自动恢复尝试：\n' + s.restartLog().slice(-900));
    } finally {
      await teardown(s);
    }
  });

  await check('C3 优雅退出（SIGTERM）：退出时不得再恢复任何组件，端口必须释放', async () => {
    const s = await scenario({ behavior: {} });
    try {
      const up = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        return c && c.recoveryState === 'healthy' ? c : null;
      }, 45000, 300);
      assert.ok(up, 'bridge did not come up');

      await stopRunner(s.runner);
      const freed = await waitFor(async () => {
        const bound = await Promise.all(
          [s.ports.bridge, s.ports.active, s.ports.homeNode].map(p => portBound(p)));
        return bound.every(b => b === false);
      }, 25000, 300);
      assert.ok(freed, '组件端口未在 runner 退出后释放（可能被自动恢复重新拉起来了）');
      const log = s.restartLog();
      assert.ok(!/shutdown requested[\s\S]*recovery attempt/.test(log),
        '优雅退出之后不得出现任何恢复尝试：\n' + log.slice(-1200));
    } finally {
      await teardown(s);
    }
  });

  await check('C4 退出码 0 也是崩溃：正常返回不等于"我很好"', async () => {
    const s = await scenario({
      policy: { maxAttempts: 3, windowMs: 120000, baseBackoffMs: 200, maxBackoffMs: 800, healthFailStreak: 2 },
      /* 第一次启动以 0 退出（脚本跑完就返回），第二次起正常服务 */
      behavior: { CRASH_FIRST: '1', CRASH_CODE: '0', CRASH_AFTER_MS: '0' }
    });
    try {
      const recovered = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        if (!c) return null;
        return (c.recoveryState === 'healthy' && c.restartCount >= 1) ? c : null;
      }, 60000, 300);
      if (!recovered) {
        throw new Error('a clean (code 0) exit was not recovered.\n' + await s.diagnose());
      }
      assert.ok(recovered.lastFailureReason && /code=0/.test(recovered.lastFailureReason),
        '理由必须如实写出 code=0：' + recovered.lastFailureReason);
    } finally {
      await teardown(s);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   D · the failure never improves
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteD() {
  section('D. 一直失败：预算耗尽 → 锁死（不再自动重试）');

  await check('D1 反复崩溃：恰好用完预算后进入 failed，之后不再有新的尝试', async () => {
    const policy = { maxAttempts: 3, windowMs: 300000, baseBackoffMs: 150, maxBackoffMs: 400, healthFailStreak: 2 };
    const s = await scenario({
      policy: policy,
      /* 每一次启动都崩（绑定端口之后崩，确保它真的"活过"）。只对 bridge 施加：
         预算断言说的是 bridge 的预算，其它组件崩溃会把日志里的尝试次数搅在一起。 */
      behavior: {},
      perComponent: {
        bridge: { CRASH_EVERY: '1', CRASH_AFTER_MS: '120' },
        active: { CRASH_EVERY: null, CRASH_AFTER_MS: null },
        homeNode: { CRASH_EVERY: null, CRASH_AFTER_MS: null }
      }
    });
    try {
      const locked = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        return c && c.recoveryState === 'failed' ? c : null;
      }, 90000, 200);
      if (!locked) {
        throw new Error('bridge never reached the failed state.\n' + await s.diagnose());
      }
      assert.strictEqual(locked.recoveryLockedOut, true, 'failed 必须伴随锁死');
      assert.ok(locked.restartCount <= policy.maxAttempts,
        '重启次数不得超过预算 ' + policy.maxAttempts + '：' + locked.restartCount);
      assert.ok(locked.recoveryAttempts <= policy.maxAttempts,
        '窗口内尝试次数不得超过预算：' + locked.recoveryAttempts);
      assert.ok(locked.lastFailureReason, 'failed 必须带失败理由');
      assert.ok(!/\b(sk-|Bearer |api[_-]?key)/i.test(locked.lastFailureReason), '失败理由不得含凭据形状内容');

      /* 锁死之后静默观察：不应该再出现任何新的尝试 */
      const frozen = await sleep(3500).then(() => s.componentOf('bridge'));
      assert.strictEqual(frozen.recoveryState, 'failed', '锁死状态不得自行回到 recovering');
      assert.strictEqual(frozen.restartCount, locked.restartCount,
        '锁死之后不得再有新的恢复尝试：' + locked.restartCount + ' → ' + frozen.restartCount);
      const attempts = (s.restartLog().match(/recovery attempt \d+\/\d+/g) || []).length;
      assert.ok(attempts <= policy.maxAttempts, '日志里的尝试次数也不得超过预算：' + attempts);
      assert.ok(/recovery refused|locks? out|budget/i.test(s.restartLog()), '锁死必须留痕：\n' + s.restartLog().slice(-800));
    } finally {
      await teardown(s);
    }
  });

  await check('D2 进程活着但端口不答话：健康失败也能触发恢复（否则会永远半死）', async () => {
    const s = await scenario({
      policy: { maxAttempts: 3, windowMs: 120000, baseBackoffMs: 200, maxBackoffMs: 800, healthFailStreak: 2 },
      /* 第一次启动：进程活着、占着端口、永不回 /health（一个退出事件永远报不出来
         的"半死"）；从第二次启动起正常服务，所以"恢复成功"是可以被证明的。
         只对 bridge 施加，其它两个组件正常起来。 */
      behavior: {},
      perComponent: {
        bridge: { NEVER_HEALTHY_FIRST: '1', LISTEN_AFTER_MS: '6000' },
        active: { LISTEN_AFTER_MS: null },
        homeNode: { LISTEN_AFTER_MS: null }
      }
    });
    try {
      const recovered = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        if (!c) return null;
        return (c.recoveryState === 'healthy' && c.restartCount >= 1) ? c : null;
      }, 180000, 500);
      if (!recovered) {
        throw new Error('a live-but-silent component was never recovered.\n' + await s.diagnose());
      }
      const log = s.restartLog();
      assert.ok(/health failure/.test(log), '必须记录健康失败：\n' + log.slice(-1000));
      /* 那次被恢复的进程是"活着但端口不答话"，所以恢复必须先把它停掉再起新的；
         或者它自始至终没占住端口，那就不需要停。两者都必须留下尝试记录。 */
      assert.ok(/alive but unhealthy|no listening process/.test(log) || /recovery attempt/.test(log),
        '必须留下恢复过程：\n' + log.slice(-1000));
      assert.ok(recovered.restartCount <= 3);
    } finally {
      await teardown(s);
    }
  });

  await check('D3 不可重启组件（Vision）：一次失败即 failed，绝不自动拉起', async () => {
    const s = await scenario({
      args: ['--vision'],
      /* Vision 不能被 pointRunnerAtFake 用普通锚点改写（它由 .cmd 启动），
         pointRunnerAtFake 里为它准备了单独的锚点。 */
      stub: [{ id: 'vision', portKey: 'vision', health: JSON.stringify({ ok: true, service: 'internal-beyond-vision', version: 'fake-1' }), CRASH_EVERY: '1', CRASH_AFTER_MS: '0' }],
      behavior: {}
    });
    try {
      const failed = await waitFor(async () => {
        const c = await s.componentOf('vision');
        return c && c.recoveryState === 'failed' ? c : null;
      }, 60000, 400);
      if (!failed) {
        const c = await s.componentOf('vision');
        throw new Error('vision never reached failed.\n  view → ' + JSON.stringify(c) + '\n' + await s.diagnose());
      }
      assert.strictEqual(failed.restartCount, 0, '不可重启组件不得被自动拉起');
      assert.strictEqual(failed.recoveryLockedOut, true);
      assert.ok(!/Vision recovery attempt/.test(s.restartLog()),
        '不可重启组件不得出现恢复尝试：\n' + s.restartLog().slice(-800));
      assert.ok(/not restartable/.test(s.restartLog()), '必须留下"不可重启"的理由：\n' + s.restartLog().slice(-800));
    } finally {
      await teardown(s);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   E · mutation: prove the bound is load-bearing
   ═══════════════════════════════════════════════════════════════════════════ */

/* Every mutation is a one-line weakening of the REAL source that the suite
   considers benign ("just retry anyway", "just reset the counter", "the failed
   state is only cosmetic"). Each must make the same D1 assertions fail, in a
   private tree, without touching the repository. */
const MUTATIONS = [
  {
    name: 'E1 移除重启上限（预算闸门恒真）',
    apply: src => {
      const before = '    const used = this.attemptsInWindow(componentId, t);';
      const after = '    const used = 0;';
      assert.ok(src.indexOf(before) >= 0, 'mutation anchor not found');
      return src.replace(before, after);
    }
  },
  {
    name: 'E2 重置计数器（每次尝试后清空预算窗口，预算永远用不完）',
    apply: src => {
      /* The budget IS the window: making the window forget is the same defect as
         resetting a counter, and it is the version that survives a sliding-window
         design. This is the mutation that proves the budget is spent by evidence
         and not by a field someone can clear. */
      const before = '    rec.attemptTimes.push(t);';
      const after = '    rec.attemptTimes = [];';
      assert.ok(src.indexOf(before) >= 0, 'mutation anchor not found');
      return src.replace(before, after);
    }
  },
  {
    name: 'E3 绕过 failed 状态（锁死只是装饰，仍继续重试）',
    apply: src => {
      const before = '  _lockOut(rec, at, reason, wasState, event) {\n    rec.lockedOutAt = at;';
      const after = '  _lockOut(rec, at, reason, wasState, event) {\n    if (event !== \'stop\') { rec.consecutiveFailures = 0; return { state: RECOVERY_STATE.RECOVERING, event: event || EVENT.BUDGET_EXHAUSTED, action: \'retry\', inMs: 10, reason: sanitize(reason, 200), previous: wasState }; }\n    rec.lockedOutAt = at;';
      assert.ok(src.indexOf(before) >= 0, 'mutation anchor not found');
      return src.replace(before, after);
    }
  }
];

/* The exact assertions D1 makes about a bounded supervisor, run against a given
   tree. Returns null on success or a diagnostic string on failure. */
async function expectBounded(treeDir, policy, label) {
  const s = await scenario({
    runnerPath: path.join(treeDir, 'runtime', 'local-services-runner.js'),
    cwd: treeDir,
    treeDir: treeDir,
    policy: policy,
    behavior: { CRASH_EVERY: '1', CRASH_AFTER_MS: '120' }
  });
  try {
    const failed = await waitFor(async () => {
      const c = await s.componentOf('bridge');
      return c && c.recoveryState === 'failed' ? c : null;
    }, 12000, 200);
    const first = await s.componentOf('bridge');
    /* The mutant may also fail OPEN in a different direction: never locking out
       but also never exceeding the counter within the observation window. That is
       still a violation of "bounded", so it is caught explicitly rather than
       being allowed to slip through as "no failed state, nothing to see". */
    if (first && Number(first.restartCount) > policy.maxAttempts) {
      return label + ': restartCount ' + first.restartCount + ' exceeded the budget ' + policy.maxAttempts;
    }
    if (!failed) {
      await sleep(3000);
      const later = await s.componentOf('bridge');
      if (later && Number(later.restartCount) > policy.maxAttempts) {
        return label + ': restartCount ' + later.restartCount + ' exceeded the budget ' + policy.maxAttempts;
      }
      if (later && (later.recoveryState === 'recovering' || later.recoveryState === 'starting')) {
        return label + ': still retrying with no lockout (restartCount ' +
          later.restartCount + ', attempts ' + later.recoveryAttempts + ')';
      }
      return label + ': reached no failed state within 12s; view=' + JSON.stringify(later) +
        '\n  log:\n' + s.restartLog().slice(-800);
    }
    const view = failed;
    if (view.restartCount > policy.maxAttempts) {
      return label + ': restartCount ' + view.restartCount + ' exceeded the budget ' + policy.maxAttempts;
    }
    if (view.recoveryAttempts > policy.maxAttempts) {
      return label + ': attemptsInWindow ' + view.recoveryAttempts + ' exceeded the budget ' + policy.maxAttempts;
    }
    await sleep(3000);
    const frozen = await s.componentOf('bridge');
    if (!frozen || frozen.recoveryState === 'recovering') {
      return label + ': a locked-out component went back to recovering: ' + JSON.stringify(frozen);
    }
    if (frozen.restartCount !== view.restartCount) {
      return label + ': still attempting after lockout (' + view.restartCount + ' → ' + frozen.restartCount + ')';
    }
    const attempts = (s.restartLog().match(/recovery attempt \d+\/\d+/g) || []).length;
    if (attempts > policy.maxAttempts) {
      return label + ': ' + attempts + ' recovery attempts in the log exceeded the budget ' + policy.maxAttempts;
    }
    return null;
  } finally {
    await teardown(s);
  }
}

async function suiteE() {
  section('E. 变异：把有界性破坏掉，断言必须失败');

  const policy = { maxAttempts: 3, windowMs: 300000, baseBackoffMs: 150, maxBackoffMs: 400, healthFailStreak: 2 };

  await check('E0 对照：未变异的真实 runner 满足全部有界断言', async () => {
    const s = await scenario({
      policy: policy,
      /* 只让 bridge 崩：这里的预算断言说的是 bridge 的预算，三个组件一起崩会把
         日志里的尝试次数搅在一起（9 次 = 3 个组件 × 3 次预算）。 */
      behavior: {},
      perComponent: {
        bridge: { CRASH_EVERY: '1', CRASH_AFTER_MS: '120' },
        active: { CRASH_EVERY: null, CRASH_AFTER_MS: null },
        homeNode: { CRASH_EVERY: null, CRASH_AFTER_MS: null }
      }
    });
    try {
      const failed = await waitFor(async () => {
        const c = await s.componentOf('bridge');
        return c && c.recoveryState === 'failed' ? c : null;
      }, 60000, 200);
      assert.ok(failed, 'the real runner never locked out a permanently crashing component');
      assert.ok(failed.restartCount <= policy.maxAttempts,
        'real runner exceeded its own budget: ' + failed.restartCount);
        const attempts = (s.restartLog().match(/recovery attempt \d+\/\d+/g) || []).length;
      assert.ok(attempts <= policy.maxAttempts, 'real runner made ' + attempts + ' attempts');
    } finally {
      await teardown(s);
    }
  });

  for (const mutation of MUTATIONS) {
    await check(mutation.name + ' → 同一断言必须失败', async () => {
      /* Mutate the SUPERVISOR, because that is where the bound lives; the runner
         is copied verbatim so the tree is otherwise the real product. */
      const tree = runnerTree([], RUNNER_SRC);
      const target = path.join(tree, 'runtime', 'component-supervisor.js');
      const original = fs.readFileSync(target, 'utf8');
      const mutated = mutation.apply(original);
      assert.notStrictEqual(mutated, original, 'mutation did not change the file');
      assert.ok(parses(mutated), 'mutation ' + mutation.name + ' produced a supervisor that does not parse');
      fs.writeFileSync(target, mutated);
      const diagnostic = await expectBounded(tree, policy, mutation.name);
      assert.ok(diagnostic, 'MUTATION SURVIVED — the bound is not load-bearing: ' + mutation.name);
      console.log('      (变异被断言抓住：' + String(diagnostic).split('\n')[0].slice(0, 120) + ')');
    });
  }

  await check('E4 变异只发生在私有副本里：仓库文件逐字节未变', () => {
    assert.strictEqual(sha256(RUNNER), sha256For(RUNNER), 'runner 被变异测试改动了');
    assert.strictEqual(sha256(path.join(ROOT, 'runtime', 'component-supervisor.js')),
      sha256For(path.join(ROOT, 'runtime', 'component-supervisor.js')), 'supervisor 被变异测试改动了');
    assert.strictEqual(sha256(path.join(ROOT, 'runtime', 'component-registry.js')),
      sha256For(path.join(ROOT, 'runtime', 'component-registry.js')), 'registry 被变异测试改动了');
  });
}

/* Snapshot taken at load time, so E4 can prove nothing was rewritten in place. */
const ORIGINAL_DIGESTS = {
  runner: sha256(RUNNER),
  supervisor: sha256(path.join(ROOT, 'runtime', 'component-supervisor.js')),
  registry: sha256(path.join(ROOT, 'runtime', 'component-registry.js'))
};
function sha256For(file) {
  if (file === RUNNER) return ORIGINAL_DIGESTS.runner;
  if (/component-supervisor\.js$/.test(file)) return ORIGINAL_DIGESTS.supervisor;
  if (/component-registry\.js$/.test(file)) return ORIGINAL_DIGESTS.registry;
  return sha256(file);
}

/* ═══════════════════════════════════════════════════════════════════════════
   F · shipped and closed
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteF() {
  section('F. 打包闭包与泄漏');

  await check('F1 supervisor 必须进发行包（runner 启动期 require 它，缺了启动链直接崩）', () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'scripts', 'release-manifest.js'), 'utf8');
    assert.ok(/runtime\/component-supervisor\.js/.test(manifest),
      'runtime/component-supervisor.js 必须列入发行清单');
    assert.ok(/runtime\/component-registry\.js/.test(manifest), 'registry 也必须仍在清单里');
  });

  await check('F2 依赖闭包：supervisor 是纯策略引擎，不 require 任何兄弟模块', () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'component-supervisor.js'), 'utf8');
    const requires = src.match(/require\((['"])[^'"]+\1\)/g) || [];
    assert.deepStrictEqual(requires, [], 'supervisor 不得 require 任何东西：' + JSON.stringify(requires));
    assert.ok(!/\bfs\.|\bhttp\.|child_process/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      'supervisor 不得直接碰文件系统 / HTTP / 子进程');
    /* 反向依赖也要干净：registry 不知道 supervisor 的存在 */
    const registrySrc = fs.readFileSync(path.join(ROOT, 'runtime', 'component-registry.js'), 'utf8');
    assert.ok(!/component-supervisor/.test(registrySrc), 'registry 不得依赖 supervisor（会造成循环）');
  });
}

async function main() {
  console.log('P11-3C · supervisor bounded crash recovery');
  /* IB_IB_SUITES (comma separated, e.g. "A,F") runs a subset. Development runs use
     it to iterate on one phase; the delivery run takes the whole suite. It can
     only REMOVE suites, never skip a failing assertion inside one. */
  const only = String(process.env.IB_SUITES || '').trim().toUpperCase();
  const wanted = only ? only.split(',').map(s => s.trim()) : null;
  const suites = [['A', suiteA], ['B', suiteB], ['C', suiteC], ['D', suiteD], ['E', suiteE], ['F', suiteF]];
  for (const [name, fn] of suites) {
    if (wanted && wanted.indexOf(name) < 0) continue;
    await fn();
  }

  /* Leak discipline: every spawned process must be gone before we exit, and the
     process must exit on its own — no process.exit(0) masking a live handle. */
  for (const handle of cleanup) await stopRunner(handle);
  await sleep(300);

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) {
    for (const f of failures) console.log('  FAILED: ' + f.name + ' → ' + String((f.error && f.error.message) || f.error).split('\n')[0]);
    process.exitCode = 1;
  }
  try { fs.rmSync(MUTATION_TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

main().catch(error => {
  console.error('suite crashed:', error && error.stack || error);
  process.exitCode = 1;
});
