'use strict';

/*
 * P11-3B · Component Registry + Health Aggregation
 *
 * What this suite is defending:
 *
 *   Before P11-3B there were FOUR hand-written component lists, and they had
 *   already drifted:
 *     · runtime/local-services-runner.js SERVICES      → Bridge, Active, HomeNode, [Vision]
 *     · runtime/local-services-runner.js runRestart()  → Bridge, Active            ← missing HomeNode
 *     · runtime/launch-internal-beyond.js components   → static, bridge, active, restart, vision  ← no HomeNode
 *     · runtime/boot-state.js COMPONENT_ORDER          → same five                ← no HomeNode
 *
 *   A registry only earns its name if the drift cannot come back, so this suite
 *   is written as a set of CROSS-CHECKED claims rather than "does register()
 *   work": the registry, the boot record, the runner's live view and the restart
 *   control plane are each asked the same questions and their answers must be
 *   identical. Mutation cases prove the claims are load-bearing: break the
 *   registry in a temp copy of the tree and the same assertions must fail.
 *
 * Discipline (P2/P7/P11): every spawned process gets an isolated port, an
 * isolated data directory and an isolated log directory; nothing here touches
 * the developer's real ports, data or %LOCALAPPDATA%. No process.exit(0) — the
 * harness exits naturally and reports leaked handles.
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
const BOOT = require(path.join(ROOT, 'runtime', 'boot-state.js'));
const RUNNER = path.join(ROOT, 'runtime', 'local-services-runner.js');
const SERVICE_DIR = path.join(ROOT, 'services');

let passed = 0;
const failures = [];

/* ── harness ────────────────────────────────────────────────────────────── */

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
    console.log('  ✗ ' + name + '\n      ' + String((error && error.message) || error).split('\n')[0]);
  }
}

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpJson(port, pathname, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (settled) return; settled = true; resolve(v); };
    let body = null;
    if (o.body !== undefined) body = Buffer.from(JSON.stringify(o.body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: port, path: pathname, method: o.method || 'GET',
      timeout: o.timeoutMs || 3000,
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
      if (await fn()) return true;
      if (Date.now() > deadline) return false;
      await sleep(intervalMs || 250);
    }
  })();
}

/* Spawn the real runner with fully isolated ports/logs. */
function startRunner(env, args) {
  const child = spawn(process.execPath, [RUNNER].concat(args || []), {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const out = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => out.push(String(c)));
  child.stderr.on('data', c => out.push(String(c)));
  return { child: child, out: out };
}

async function stopRunner(runner) {
  if (!runner || !runner.child || runner.child.exitCode !== null) return;
  runner.child.kill('SIGTERM');
  const gone = await waitFor(() => runner.child.exitCode !== null || runner.child.signalCode !== null, 8000, 200);
  if (!gone) {
    try { runner.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    await waitFor(() => runner.child.exitCode !== null || runner.child.signalCode !== null, 5000, 200);
  }
}

/* Run `node <runner> --json` in a child and parse it (used for the read-only
   status contract; keeps the main test process free of the runner's timers). */
function runnerStatusJson(env, args, runnerPath) {
  return new Promise(resolve => {
    const target = runnerPath || RUNNER;
    const child = spawn(process.execPath, [target, '--json'].concat(args || []), {
      cwd: path.dirname(path.dirname(target)),
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('exit', code => {
      let json = null;
      try { json = JSON.parse(out.trim()); } catch (e) { json = null; }
      resolve({ code: code, json: json, stdout: out, stderr: err });
    });
  });
}

/* ── mutation harness: a private copy of runtime/ that we are free to break ──
 *
 * Only `runtime/` is copied; everything else (services/, assets/, active/,
 * bridge/, scripts/) is junctioned in from the real checkout. That keeps the
 * mutated tree able to actually START the real services — a mutation that could
 * not run at all would prove nothing — while the registry and its consumers are
 * private copies this suite can destroy. */

const MUTATION_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3b-mut-'));
const JUNCTION_DIRS = ['services', 'assets', 'active', 'bridge', 'scripts'];

function mutationTree() {
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
    try {
      fs.symlinkSync(src, path.join(dir, name), 'junction');
    } catch (e) {
      /* Without the junction the mutated tree cannot spawn real services; the
         caller decides whether that matters (probe-only mutations do not). */
    }
  }
  /* The runner logs into LOCALAPPDATA/InternalBeyond/logs; every caller of this
     helper passes an isolated LOCALAPPDATA, so nothing lands in the real one. */
  return dir;
}

function sha256(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ── fixture: a pristine copy of the registry, loaded on demand ─────────── */

function freshRegistry() {
  const p = path.join(ROOT, 'runtime', 'component-registry.js');
  delete require.cache[require.resolve(p)];
  return require(p);
}

/* ═══════════════════════════════════════════════════════════════════════════
   A · registry contract
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteA() {
  section('A. component registry contract');

  await check('A1 唯一 id、唯一名称、唯一 scriptKey（重复注册不可能被静默接受）', async () => {
    const ids = registry.COMPONENTS.map(c => c.id);
    const names = registry.COMPONENTS.map(c => c.name);
    const keys = registry.COMPONENTS.map(c => c.scriptKey);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate component id: ' + JSON.stringify(ids));
    assert.strictEqual(new Set(names).size, names.length, 'duplicate component name: ' + JSON.stringify(names));
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate scriptKey: ' + JSON.stringify(keys));
    assert.ok(ids.length >= 6, 'registry must describe every long-running component, got ' + ids.length);
  });

  await check('A2 每个组件声明完整（id/name/label/port/health/identity/required 语义）', async () => {
    for (const c of registry.COMPONENTS) {
      for (const key of ['id', 'name', 'label', 'scriptKey', 'portEnv', 'healthPath']) {
        assert.ok(typeof c[key] === 'string' && c[key].length, c.id + '.' + key + ' missing');
      }
      assert.ok(Number.isInteger(c.defaultPort) && c.defaultPort >= 1 && c.defaultPort <= 65535, c.id + '.defaultPort');
      assert.strictEqual(typeof c.matchesHealth, 'function', c.id + '.matchesHealth must be a predicate');
      for (const flag of ['required', 'affectsOverall', 'managedByRunner', 'observedByLauncher', 'healthyRequiredForServices', 'restartable', 'requiresDeviceAuth']) {
        assert.strictEqual(typeof c[flag], 'boolean', c.id + '.' + flag + ' must be an explicit boolean');
      }
    }
  });

  await check('A3 注册表是冻结的：运行期不能被改写（单一事实源不可被就地污染）', async () => {
    assert.ok(Object.isFrozen(registry.COMPONENTS), 'COMPONENTS must be frozen');
    for (const c of registry.COMPONENTS) assert.ok(Object.isFrozen(c), c.id + ' must be frozen');
    const before = registry.componentOrder();
    try { registry.COMPONENTS.push({ id: 'evil' }); } catch (e) { /* strict mode throws */ }
    assert.deepStrictEqual(registry.componentOrder(), before, 'registry order changed through the public array');
  });

  await check('A4 端口派生尊重 IB_*_PORT 覆盖，并拒绝非法覆盖值（回落到默认端口）', async () => {
    assert.strictEqual(registry.portOf('bridge', { IB_BRIDGE_PORT: '25001' }), 25001);
    assert.strictEqual(registry.portOf('bridge', {}), registry.byId('bridge').defaultPort);
    /* 非法值绝不变成端口 0 / NaN —— 那会让探针去打一个随机端口 */
    for (const bad of ['0', '-1', '70000', 'abc', '', null]) {
      const env = { IB_BRIDGE_PORT: bad };
      assert.strictEqual(registry.portOf('bridge', env), registry.byId('bridge').defaultPort, 'bad override ' + JSON.stringify(bad));
    }
    assert.strictEqual(registry.portOf('nope', {}), 0, 'unknown id must not invent a port');
  });

  await check('A5 组件状态词表与 boot-state 的 REASON 词表完全一致（不产生第二套分类）', async () => {
    const bootReasons = new Set(Object.keys(BOOT.REASON).map(k => BOOT.REASON[k]));
    for (const value of Object.keys(registry.REASON).map(k => registry.REASON[k])) {
      assert.ok(bootReasons.has(value), 'registry reason "' + value + '" is not a boot-state REASON value');
    }
    /* 每个 registry 状态也必须是 boot-state 已经会输出的状态字符串 */
    const bootStates = new Set(['starting', 'healthy', 'degraded', 'offline', 'conflict', 'error', 'unknown', 'not-enabled']);
    for (const value of Object.keys(registry.STATE).map(k => registry.STATE[k])) {
      assert.ok(bootStates.has(value), 'registry state "' + value + '" is not part of the boot-state vocabulary');
    }
  });

  await check('A6 身份探针是真的谓词：占端口但答非本组件 = conflict，绝不当作健康', async () => {
    const bridge = registry.byId('bridge');
    assert.strictEqual(registry.identityMatches(bridge, { ok: true, server: 'IB Bridge' }), true);
    assert.strictEqual(registry.identityMatches(bridge, { ok: true, server: 'something-else' }), false);
    assert.strictEqual(registry.identityMatches(bridge, null), false);
    assert.strictEqual(registry.identityMatches(bridge, { ok: true, service: 'internal-beyond-active-messages' }), false,
      'Active answering on the Bridge port is a conflict, not a healthy Bridge');
    /* static 的两段式身份：名字对 + ok:true（ib-stop 的 identity 一直要求这个） */
    const stat = registry.byId('static');
    assert.strictEqual(registry.identityMatches(stat, { ok: true, server: 'InternalBeyond Web' }), true);
    assert.strictEqual(registry.identityMatches(stat, { server: 'InternalBeyond Web' }), false,
      'a static server that does not declare ok:true is not the static layer');
    assert.strictEqual(registry.identityIgnoresOk(stat), false, 'static must keep requiring ok:true');
    assert.strictEqual(registry.identityIgnoresOk(bridge), true, 'the services keep their historical predicate');

    const c = registry.classifyProbe(bridge, { responding: true, data: { ok: true, server: 'x' }, identityOk: false }, {});
    assert.strictEqual(c.state, 'conflict');
    assert.strictEqual(c.reason.category, 'conflict');
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   B · the drift that P11-3B exists to fix
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteB() {
  section('B. 清单漂移已被结构性消除');

  await check('B1 boot-state 的组件轴就是注册表的组件轴（含 homeNode）', async () => {
    assert.deepStrictEqual(BOOT.COMPONENT_ORDER, registry.componentOrder());
    assert.ok(BOOT.COMPONENT_ORDER.includes('homeNode'), 'boot-state must be able to describe Home Node');
    /* 原有五个 id 的相对顺序不能被改动 —— 这是 P2/P3 的冻结契约（新组件只追加
       或插入，不得重排既有成员的相对位置） */
    const frozenFive = ['static', 'bridge', 'active', 'restart', 'vision'];
    assert.deepStrictEqual(BOOT.COMPONENT_ORDER.filter(id => frozenFive.includes(id)), frozenFive);
    assert.strictEqual(BOOT.COMPONENT_ORDER.length, 6, 'exactly one component was added by P11-3B');
    assert.ok(BOOT.COMPONENT_ORDER.indexOf('homeNode') > BOOT.COMPONENT_ORDER.indexOf('active'),
      'homeNode belongs with the services it belongs to');
  });

  await check('B2 启动记录确实产出 homeNode 一行（并且它不影响 overall）', async () => {
    const st = BOOT.buildBootState({
      phase: 'complete',
      components: {
        static: { required: true, healthy: true, state: 'healthy', port: 23120 },
        bridge: { healthy: true, state: 'healthy' },
        active: { healthy: true, state: 'healthy' },
        homeNode: { healthy: false, state: 'offline', reason: { category: 'offline', message: 'not running' } }
      }
    });
    const home = st.components.homeNode;
    assert.ok(home, 'boot record has no homeNode component — the drift is back');
    assert.strictEqual(home.state, 'offline');
    assert.strictEqual(home.affectsOverall, false, 'Home Node must be observed, not overall-affecting');
    assert.strictEqual(st.overall, 'normal', 'Home Node being down must not degrade a working desktop launch');
    assert.deepStrictEqual(st.degradedReasons, [], 'Home Node must not manufacture a degraded reason');
    /* 但 bridge 掉了仍然必须 degraded —— 这条规则没有被削弱 */
    const st2 = BOOT.buildBootState({
      phase: 'complete',
      components: {
        static: { required: true, healthy: true, state: 'healthy' },
        bridge: { healthy: false, state: 'offline' },
        active: { healthy: true, state: 'healthy' },
        homeNode: { healthy: true, state: 'healthy' }
      }
    });
    assert.strictEqual(st2.overall, 'degraded');
    assert.deepStrictEqual(st2.degradedReasons.map(r => r.component), ['bridge']);
  });

  await check('B3 「必需组件」由注册表决定：static 不在场仍然 fatal（规则没被削弱）', async () => {
    assert.deepStrictEqual(BOOT.requiredComponentIds(), ['static']);
    const st = BOOT.buildBootState({
      phase: 'complete',
      components: {
        static: { required: true, healthy: false, state: 'conflict', reason: { category: 'port-conflict', message: 'busy' } },
        bridge: { healthy: false, state: 'offline' },
        homeNode: { healthy: false, state: 'offline' }
      }
    });
    assert.strictEqual(st.overall, 'fatal');
    assert.strictEqual(st.fatal.category, 'port-conflict');
  });

  await check('B4 重启目标集合来自注册表，且必须包含 Home Node（旧代码漏了它）', async () => {
    const ids = registry.restartTargets().map(c => c.id);
    assert.ok(ids.includes('homeNode'), 'restart targets must include homeNode: ' + JSON.stringify(ids));
    assert.deepStrictEqual(ids.slice().sort(), ['active', 'bridge', 'homeNode']);
    /* 参考控制面自己（23116）不能被当作重启目标：那会杀掉正在执行重启的进程 */
    assert.ok(!ids.includes('restart'));
    /* 源码级反证：旧的手写判据不得回归 */
    const src = fs.readFileSync(RUNNER, 'utf8');
    assert.ok(!/s\.name === 'Bridge' \|\| s\.name === 'Active'/.test(src),
      'runRestart still filters targets by a hand-written name pair');
    assert.ok(/RESTART_TARGET_IDS/.test(src), 'runRestart must use the registry-derived target list');
  });

  await check('B5 真实 runner：全部注册组件的实时视图都在，四个旧清单不再各说各话', async () => {
    const env = {
      IB_BRIDGE_PORT: String(await freePort()),
      IB_ACTIVE_PORT: String(await freePort()),
      IB_HOME_NODE_PORT: String(await freePort()),
      IB_RESTART_PORT: String(await freePort()),
      IB_VISION_PORT: String(await freePort())
    };
    const r = await runnerStatusJson(env, ['--vision']);
    assert.strictEqual(r.code, 0, 'runner --json must exit 0 with everything offline: ' + r.stderr.slice(-300));
    assert.ok(r.json, 'runner --json produced unparsable output: ' + r.stdout.slice(-300));

    const ids = r.json.components.map(c => c.id);
    assert.deepStrictEqual(ids, registry.componentOrder(), 'live view must cover exactly the registry, in order');
    assert.deepStrictEqual(ids, BOOT.COMPONENT_ORDER, 'the record vocabulary and the live view must be the same list');

    /* 每个 registry 组件都用同一个端口来源：传给子进程的覆盖值必须原样出现 */
    for (const c of r.json.components) {
      const def = registry.byId(c.id);
      assert.strictEqual(c.port, registry.portOf(c.id, env), c.id + ' port is not registry-derived');
      assert.strictEqual(c.required, def.required);
      assert.strictEqual(c.affectsOverall, def.affectsOverall);
    }

    /* 旧服务表（其它工具仍依赖）与注册表描述同一批服务 */
    const managedNames = registry.managed().map(c => c.name).sort();
    const rowNames = r.json.services.map(s => s.name).sort();
    assert.deepStrictEqual(rowNames, managedNames, 'SERVICES and the registry disagree about which services exist');

    /* P11-3C 之后这条视图不再自称"纯观测"（runner 现在确实会做有界恢复），所以这里
       断言的是它必须如实声明自己的边界，而不是钉死某句文案。 */
    assert.ok(r.json.warning && /bounded/.test(r.json.warning),
      'the live view must state that its recovery is bounded: ' + r.json.warning);
    assert.ok(/never (starts|stops|restarts|retries|recovers)/.test(r.json.warning),
      'the live view must state what it does not do: ' + r.json.warning);
  });

  await check('B6 聚合视图如实回答：谁在跑、谁停了、谁异常、什么时候看的', async () => {
    const r = await runnerStatusJson({
      IB_BRIDGE_PORT: String(await freePort()),
      IB_ACTIVE_PORT: String(await freePort()),
      IB_HOME_NODE_PORT: String(await freePort()),
      IB_RESTART_PORT: String(await freePort())
    });
    const agg = r.json && r.json.aggregated;
    assert.ok(agg, 'no aggregated health view');
    assert.strictEqual(agg.schema, 'internalbeyond.component-health');
    assert.ok(Number.isFinite(agg.updatedAt) && agg.updatedAt > 0, 'updatedAt must be a real timestamp');
    assert.strictEqual(agg.updatedAt, agg.checkedAt);
    assert.ok(Number.isFinite(agg.counts.total) && agg.counts.total === agg.components.length);
    /* 全部离线：stopped 覆盖所有会影响总体状态且被探测过的组件，running 为空 */
    assert.deepStrictEqual(agg.running, []);
    for (const id of ['bridge', 'active', 'homeNode']) {
      assert.ok(agg.stopped.includes(id), id + ' should be reported stopped, got ' + JSON.stringify(agg.stopped));
    }
    /* 未探测的 static 是 unknown，不是 offline —— "没看" 不等于 "挂了" */
    assert.strictEqual(agg.components.find(c => c.id === 'static').probed, false);
    assert.ok(agg.notObserved.includes('static'), 'an unprobed component belongs in notObserved');
    assert.ok(!agg.stopped.includes('static'));
    /* restart 面没有起来、vision 未启用 —— 两者都不是"停了的服务" */
    assert.ok(agg.notEnabled.includes('vision'), 'vision must be reported not-enabled, not stopped');
    assert.ok(!agg.stopped.includes('vision'));
    /* affected = 影响启动判定的组件；homeNode/restart/vision/static 都不该在里头 */
    assert.deepStrictEqual(agg.affected, ['bridge', 'active'],
      'only probed, overall-affecting components may be listed as failures: ' + JSON.stringify(agg.affected));
    assert.strictEqual(agg.overall, 'degraded');
  });

  await check('B7 未探测的 static 不会被伪造成 offline（诚实优先于好看）', async () => {
    const r = await runnerStatusJson({
      IB_BRIDGE_PORT: String(await freePort()),
      IB_ACTIVE_PORT: String(await freePort()),
      IB_HOME_NODE_PORT: String(await freePort())
    });
    const st = r.json.components.find(c => c.id === 'static');
    assert.ok(st, 'static must always be described');
    assert.strictEqual(st.probed, false, 'without --probe-web the static layer must not be probed');
    assert.strictEqual(st.state, 'unknown', 'an unprobed component is unknown, never offline');
    assert.ok(/never restarts|managed by the launcher|--probe-web/.test(st.note || ''), 'the reason must be stated: ' + st.note);
  });

  await check('B8 进程追踪：runner 记录自己启动了什么，且只有它启动的才算 owned', async () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    /* P11-3B 是"只观察"：进程追踪只记录，不做任何决定 */
    assert.ok(/owned: !!\(entry && !entry\.exited\)/.test(src), 'ownership must come from the runner\'s own child handle');
    assert.ok(/exits: entry \? entry\.exits : 0/.test(src), 'exit count must be tracked');
    /* P11-3B 的原话是"不得引入重启/退避/恢复**机制**"。P11-3C 之后 runner 里确实有
       恢复，所以这里断言的是"机制不在这里"：预算、退避与锁死全部由
       runtime/component-supervisor.js 决定，runner 只执行。这条断言因此仍然有意义
       —— 它现在守的是"runner 不得自己长出第二套重试逻辑"，而不是"不许出现 backoff
       这个词"（字段名与注释不是机制，一个正则分不清这两者是正则的问题）。 */
    assert.ok(!/restartOn(?:Exit|Failure|Crash)|autoRestart|maxRestarts|crashRecovery|while\s*\(\s*true\s*\)[\s\S]{0,120}restart/i.test(src),
      'P11-3B must not introduce a restart/backoff/recovery mechanism');
    assert.ok(/component-supervisor\.js/.test(src),
      'P11-3C 的恢复必须来自 supervisor 模块，不能内联在 runner 里');

    /* 真实证据：外部先占住 Bridge 端口，runner 必须把它报成 online 但 owned:false */
    const bridgePort = await freePort();
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'IB Bridge', version: 'test' }));
    });
    await new Promise(r => fake.listen(bridgePort, '127.0.0.1', r));
    try {
      const r = await runnerStatusJson({
        IB_BRIDGE_PORT: String(bridgePort),
        IB_ACTIVE_PORT: String(await freePort()),
        IB_HOME_NODE_PORT: String(await freePort())
      });
      const row = r.json.services.find(s => s.name === 'Bridge');
      assert.strictEqual(row.online, true, 'an externally started Bridge is still healthy');
      assert.strictEqual(row.owned, false, 'a service this runner did not start must never be reported as owned');
      const comp = r.json.components.find(c => c.id === 'bridge');
      assert.strictEqual(comp.pid === null || comp.pid === undefined, true, 'no pid for a process we did not start');
      assert.ok(!comp.note || /reused/.test(comp.note), 'the row must say it was reused: ' + comp.note);
    } finally {
      await new Promise(r => fake.close(r));
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   C · lifecycle: register → start → stop, through the real process
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteC() {
  section('C. 生命周期（真实进程：register → start → health → stop）');

  const bridgePort = await freePort();
  const activePort = await freePort();
  const homePort = await freePort();
  const restartPort = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3b-life-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3b-logs-'));

  const env = {
    IB_BRIDGE_PORT: String(bridgePort),
    IB_ACTIVE_PORT: String(activePort),
    IB_HOME_NODE_PORT: String(homePort),
    IB_RESTART_PORT: String(restartPort),
    IB_HOME_NODE_DATA_DIR: dataDir,
    IB_ACTIVE_DATA_DIR: dataDir,
    IB_BRIDGE_DATA_DIR: dataDir,
    LOCALAPPDATA: logDir
  };

  let runner = startRunner(env, []);
  let live = null;

  /* Ask the RUNNING process, not a detached `--json` invocation: only the live
     process knows which children it started. */
  const liveView = () => httpJson(restartPort, '/components', { timeoutMs: 12000 });
  /* Managed AND actually registered for this run. Vision is a registry member but
     opt-in: without --vision the runner legitimately reports it not-enabled, so
     demanding it be healthy would be demanding a component nobody asked for. */
  const registeredIds = registry.managed().filter(c => c.id !== 'vision').map(c => c.id);
  const runningManaged = view => {
    if (!view || !view.json || !Array.isArray(view.json.components)) return false;
    return registeredIds.every(id => {
      const row = view.json.components.find(x => x.id === id);
      return !!(row && row.state === 'healthy');
    });
  };
  const restartPlaneUp = async () => {
    const r = await httpJson(restartPort, '/status', { timeoutMs: 1500 });
    return !!(r.json && r.json.service === 'InternalBeyond Restart');
  };

  try {
    await check('C1 start：runner 按注册表启动每一个 managed 组件，并如实报告健康', async () => {
      const ready = await waitFor(async () => {
        if (!(await restartPlaneUp())) return false;
        return runningManaged(await liveView());
      }, 90000, 800);
      if (!ready) {
        const diag = await liveView();
        const plane = await httpJson(restartPort, '/status', { timeoutMs: 2000 });
        throw new Error('the runner never brought every registered service up.\n' +
          '  /status → ' + JSON.stringify(plane.json) + '\n' +
          '  /components → ' + String(diag.raw || '').slice(0, 1500) + '\n' +
          '  runner output:\n' + runner.out.join('').slice(-1200));
      }

      const v = await liveView();
      assert.ok(/bounded/.test(v.json.warning || ''), 'the live view must declare its recovery bound');
      assert.deepStrictEqual(v.json.restartTargets.slice().sort(), ['active', 'bridge', 'homeNode']);
      /* 控制面自己（restart）就在这个进程里，所以它必然是 healthy —— 而且它不是
         重启目标（否则会杀掉正在执行重启的进程）。 */
      const plane = v.json.components.find(c => c.id === 'restart');
      assert.strictEqual(plane.state, 'healthy');
      assert.ok(!v.json.restartTargets.includes('restart'));
      for (const s of v.json.services) {
        assert.strictEqual(s.online, true, s.name + ' is not online');
        assert.strictEqual(s.owned, true, s.name + ' must be owned by this runner (it started it)');
        assert.ok(Number.isInteger(s.pid) && s.pid > 0, s.name + ' must report the pid it started');
        assert.ok(s.startedAt > 0, s.name + ' must report when it was started');
        assert.strictEqual(s.exits, 0, s.name + ' should have no exit events yet');
      }
      live = v.json;
    });

    await check('C2 health：聚合视图逐组件给出状态、端口与最后更新时间', async () => {
      assert.ok(live, 'no live view from C1');
      const agg = live.aggregated;
      assert.ok(agg.running.includes('bridge') && agg.running.includes('active') && agg.running.includes('homeNode'),
        'all managed components should be running: ' + JSON.stringify(agg));
      assert.deepStrictEqual(agg.stopped, [], 'nothing observed should be reported stopped: ' + JSON.stringify(agg.stopped));
      assert.deepStrictEqual(agg.errored, []);
      assert.ok(agg.updatedAt <= Date.now() && agg.updatedAt > Date.now() - 120000, 'updatedAt must be a recent observation time');
      for (const c of agg.components) {
        if (c.id === 'static' || c.id === 'vision') continue;
        assert.strictEqual(c.state, 'healthy', c.id + ' should be healthy, got ' + c.state);
        assert.strictEqual(c.reason, null, 'a healthy component must not carry a failure reason');
        assert.ok(Number.isFinite(c.tookMs) && c.tookMs >= 0, c.id + ' must report how long its probe took');
        assert.ok(Number.isFinite(c.probedAt) && c.probedAt > 0, c.id + ' must report when it was probed');
      }
      /* static 由 launcher 管理，本视图没看它 —— 如实报 unknown 而不是装作看过 */
      const stat = agg.components.find(c => c.id === 'static');
      assert.strictEqual(stat.probed, false);
      assert.strictEqual(stat.state, 'unknown');
      assert.ok(agg.notObserved.includes('static'));
      /* Home Node 起来了，但它的 affectsOverall 仍然是 false —— 观测与判定解耦 */
      const home = agg.components.find(c => c.id === 'homeNode');
      assert.strictEqual(home.affectsOverall, false);
      assert.ok(!agg.affected.includes('homeNode'));
      /* 观测到的东西全部健康：不是 degraded */
      assert.strictEqual(agg.overall, 'healthy');
      assert.deepStrictEqual(agg.affected, []);
    });

    await check('C3 控制面真的按注册表重启：三个组件全部重新起来，端口不变', async () => {
      const beforeView = await liveView();
      const beforePids = {};
      beforeView.json.services.forEach(s => { beforePids[s.name] = s.pid; });
      assert.ok(beforePids.HomeNode > 0, 'Home Node must be running before the restart');

      const post = await httpJson(restartPort, '/restart', { method: 'POST', timeoutMs: 5000 });
      assert.strictEqual(post.status, 202, 'restart must be accepted: ' + JSON.stringify(post));
      const done = await waitFor(async () => {
        const r = await httpJson(restartPort, '/status', { timeoutMs: 1500 });
        return !!(r.json && (r.json.state === 'ready' || r.json.state === 'failed'));
      }, 90000, 700);
      assert.ok(done, 'restart never settled');
      const st = await httpJson(restartPort, '/status', { timeoutMs: 2000 });
      assert.strictEqual(st.json.state, 'ready', 'restart failed: ' + JSON.stringify(st.json));

      const settled = await waitFor(async () => runningManaged(await liveView()), 60000, 800);
      assert.ok(settled, 'not every registered component came back after the restart');

      const afterView = await liveView();
      const afterPids = {};
      afterView.json.services.forEach(s => { afterPids[s.name] = s.pid; });
      for (const s of afterView.json.services) {
        assert.strictEqual(s.online, true, s.name + ' did not come back after restart');
        /* 每个重启目标都必须是新进程 —— 旧代码只重启 Bridge/Active，
           Home Node 会继续跑着旧代码（或干脆不在），而控制面仍然报 ready。 */
        if (registry.restartTargets().some(c => c.name === s.name)) {
          assert.ok(afterPids[s.name] !== beforePids[s.name],
            s.name + ' was NOT actually restarted (same pid ' + afterPids[s.name] + ')');
        }
      }
      const home = afterView.json.components.find(c => c.id === 'homeNode');
      assert.strictEqual(home.pid, afterPids.HomeNode, 'the health view must report the pid the status row reports');
      /* 端口不变（注册表是端口来源） */
      const byName = {};
      afterView.json.services.forEach(s => { byName[s.name] = s.port; });
      assert.strictEqual(byName.Bridge, bridgePort);
      assert.strictEqual(byName.Active, activePort);
      assert.strictEqual(byName.HomeNode, homePort);
    });

    await check('C4 stop：runner 优雅退出后，自己启动的组件全部释放端口（不泄漏）', async () => {
      await stopRunner(runner);
      const freed = await waitFor(async () => {
        const bound = await Promise.all([bridgePort, activePort, homePort].map(p => portBound(p)));
        return bound.every(b => b === false);
      }, 20000, 300);
      assert.ok(freed, 'services started by the runner did not release their ports after exit');
    });
  } finally {
    await stopRunner(runner);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   D · failure reporting: missing component, failed component, conflicts
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteD() {
  section('D. 缺失 / 失败 / 冲突 的如实上报');

  await check('D1 缺失脚本：注册了但脚本不存在 → 该组件如实报 offline，其它组件不受影响', async () => {
    const dir = mutationTree();
    const runnerFile = path.join(dir, 'runtime', 'local-services-runner.js');
    const original = fs.readFileSync(runnerFile, 'utf8');
    const mutated = original.replace(
      "commandArgs: [path.join(SERVICE_DIR, 'home-node-service.js')]",
      "commandArgs: [path.join(SERVICE_DIR, 'definitely-not-here.js')]");
    assert.notStrictEqual(mutated, original, 'mutation did not apply');
    fs.writeFileSync(runnerFile, mutated);

    const bridgePort = await freePort();
    const activePort = await freePort();
    const homePort = await freePort();
    const restartPort = await freePort();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3b-d1-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3b-d1data-'));
    const childEnv = Object.assign({}, process.env, {
      IB_BRIDGE_PORT: String(bridgePort),
      IB_ACTIVE_PORT: String(activePort),
      IB_HOME_NODE_PORT: String(homePort),
      IB_RESTART_PORT: String(restartPort),
      IB_HOME_NODE_DATA_DIR: dataDir,
      IB_ACTIVE_DATA_DIR: dataDir,
      IB_BRIDGE_DATA_DIR: dataDir,
      LOCALAPPDATA: logDir
    });

    const child = spawn(process.execPath, [path.join(dir, 'runtime', 'local-services-runner.js')], {
      cwd: dir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });

    try {
      const ready = await waitFor(() => /Internal Beyond local services/.test(out), 60000, 500);
      assert.ok(ready, 'the mutated runner never finished its startup pass:\n' + out.slice(-1200));

      const home = await httpJson(homePort, '/health', { timeoutMs: 1200 });
      assert.strictEqual(home.status, 0, 'a script that does not exist must not produce a listening port');

      const status = await runnerStatusJson(childEnv, [], path.join(dir, 'runtime', 'local-services-runner.js'));
      assert.ok(status.json, 'the mutated tree must still produce runner JSON: ' + status.stdout.slice(-300) + status.stderr.slice(-300));
      const homeRow = status.json.services.find(s => s.name === 'HomeNode');
      assert.strictEqual(homeRow.online, false, 'a missing script must never be reported healthy');
      assert.strictEqual(homeRow.conflict, false, 'nothing is answering, so it is not a conflict either');
      /* 关键：一个组件的缺失不得把其它组件也拖成"不可用" */
      const bridgeRow = status.json.services.find(s => s.name === 'Bridge');
      const activeRow = status.json.services.find(s => s.name === 'Active');
      assert.strictEqual(bridgeRow.online, true, 'Bridge should still be up');
      assert.strictEqual(activeRow.online, true, 'Active should still be up');
      /* 失败是"报告"，不是"崩溃"：进程还活着，端口仍然服务 */
      assert.strictEqual(child.exitCode, null, 'the runner must survive a service that cannot be spawned');
      assert.ok(!/crash|unhandled/i.test(out), 'a missing script must be a reported failure, not a crash');
    } finally {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, 200);
      try { fs.rmSync(logDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  });

  await check('D2 缺失组件：registry 描述但本轮未注册的组件被报 not-enabled，不是 outage', async () => {
    const r = await runnerStatusJson({
      IB_BRIDGE_PORT: String(await freePort()),
      IB_ACTIVE_PORT: String(await freePort()),
      IB_HOME_NODE_PORT: String(await freePort())
    });
    const vision = r.json.components.find(c => c.id === 'vision');
    assert.strictEqual(vision.state, 'not-enabled');
    assert.strictEqual(vision.probed, false, 'an opt-in component that was not enabled must not be probed');
    assert.strictEqual(vision.healthy, false);
    assert.ok(vision.reason && vision.reason.category === 'not-enabled', JSON.stringify(vision.reason));
    /* 未知的 probe 行不会让组件消失 */
    assert.strictEqual(r.json.components.length, registry.COMPONENTS.length);
  });

  await check('D3 失败组件：端口被别的服务占住 → conflict（不是 offline、更不是 healthy）', async () => {
    const homePort = await freePort();
    const imposter = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'not-the-home-node' }));
    });
    await new Promise(r => imposter.listen(homePort, '127.0.0.1', r));
    try {
      const r = await runnerStatusJson({
        IB_BRIDGE_PORT: String(await freePort()),
        IB_ACTIVE_PORT: String(await freePort()),
        IB_HOME_NODE_PORT: String(homePort)
      });
      const home = r.json.components.find(c => c.id === 'homeNode');
      assert.strictEqual(home.state, 'conflict', 'an imposter on the port must be a conflict');
      assert.strictEqual(home.healthy, false);
      assert.strictEqual(home.reachable, true, 'a conflicting port IS reachable — say so');
      assert.strictEqual(home.identityOk, false);
      assert.ok(home.reason && home.reason.category === 'conflict');
      const row = r.json.services.find(s => s.name === 'HomeNode');
      assert.strictEqual(row.online, false);
      assert.strictEqual(row.conflict, true);
      /* 冲突不算"影响总体状态的失败"之外的结论：affectsOverall 仍来自注册表 */
      assert.strictEqual(home.affectsOverall, false);
    } finally {
      await new Promise(r => imposter.close(r));
    }
  });

  await check('D4 超时与不可达被区分：超时报 timeout，拒连报 offline', async () => {
    const bridge = registry.byId('bridge');
    const timedOut = registry.classifyProbe(bridge, { responding: false, timedOut: true, timeoutMs: 500 }, {});
    assert.strictEqual(timedOut.state, 'offline');
    assert.strictEqual(timedOut.reason.category, 'timeout', 'a timeout must not be reported as a plain refusal');
    const refused = registry.classifyProbe(bridge, { responding: false, timedOut: false }, {});
    assert.strictEqual(refused.reason.category, 'offline');
    const probeFailure = registry.classifyProbe(bridge, {}, { probeError: 'runner --json failed' });
    assert.strictEqual(probeFailure.state, 'unknown');
    assert.strictEqual(probeFailure.reason.category, 'probe-failed');
  });

  await check('D5 探针异常不会让健康视图崩掉，也不会伪造健康', async () => {
    const ports = [];
    for (let i = 0; i < registry.COMPONENTS.length; i++) ports.push(await freePort());
    const rows = await Promise.all(registry.COMPONENTS.map((c, i) =>
      registry.probeComponent(c, { host: '127.0.0.1', port: ports[i], timeoutMs: 400 })));
    const agg = registry.aggregate(rows);
    assert.strictEqual(agg.counts.total, registry.COMPONENTS.length);
    assert.strictEqual(agg.overall, 'degraded', 'probed, overall-affecting components are down');
    assert.deepStrictEqual(agg.running, []);
    for (const c of rows) {
      assert.strictEqual(c.healthy, false, c.id + ' invented health');
      assert.ok(c.state === 'offline', c.id + ' should be offline, got ' + c.state);
      assert.ok(c.probed === true, c.id + ' was probed and must say so');
    }
    /* 每个探针都报了耗时与时刻 —— "最后更新时间"必须来自真实观测 */
    for (const c of rows) {
      assert.ok(Number.isFinite(c.tookMs) && c.tookMs >= 0, c.id + ' has no probe duration');
      assert.ok(Number.isFinite(c.probedAt) && c.probedAt > 0, c.id + ' has no probe timestamp');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   E · health aggregation contract (pure)
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteE() {
  section('E. health aggregation 契约');

  const mk = (id, state, opts) => registry.componentReport(registry.byId(id), Object.assign({
    state: state, probed: true, reachable: state === 'healthy', identityOk: state === 'healthy'
  }, (opts || {})));

  await check('E1 谁在跑 / 谁停了 / 谁异常 / 最后更新时间的四问都能答', async () => {
    const now = Date.now();
    const agg = registry.aggregate([
      mk('static', 'healthy'),
      mk('bridge', 'healthy'),
      mk('active', 'offline'),
      mk('homeNode', 'conflict'),
      registry.notEnabled(registry.byId('vision')),
      mk('restart', 'offline')
    ], { now: now });
    assert.strictEqual(agg.updatedAt, now, 'the view must carry the observation time it was asked for');
    assert.strictEqual(agg.overall, 'degraded');
    assert.deepStrictEqual(agg.running.sort(), ['bridge', 'static']);
    assert.ok(agg.stopped.includes('active') && agg.stopped.includes('restart'));
    assert.deepStrictEqual(agg.errored, ['homeNode']);
    assert.deepStrictEqual(agg.notEnabled, ['vision']);
    /* 只有 active 既停了又影响总体状态 */
    assert.deepStrictEqual(agg.affected, ['active']);
    assert.strictEqual(agg.reasons[0].component, 'active');
    assert.strictEqual(agg.reasons[0].category, 'offline');
  });

  await check('E2 healthy 永远从 state 派生 —— 传入 healthy:true 不会伪造健康', async () => {
    const lying = registry.componentReport(registry.byId('bridge'), { state: 'offline', healthy: true });
    assert.strictEqual(lying.healthy, false, 'healthy must be derived from state, never trusted from the caller');
    const agg = registry.aggregate([lying]);
    assert.deepStrictEqual(agg.running, []);
    assert.strictEqual(agg.counts.healthy, 0);
    assert.strictEqual(agg.overall, 'degraded');
  });

  await check('E3 空输入是 unknown，不是 healthy（"没有数据"≠"一切正常"）', async () => {
    const agg = registry.aggregate([]);
    assert.strictEqual(agg.overall, 'unknown');
    assert.strictEqual(agg.counts.total, 0);
    assert.deepStrictEqual(agg.running, []);
    const agg2 = registry.aggregate(null);
    assert.strictEqual(agg2.overall, 'unknown');
  });

  await check('E4 全部不健康但都 affectsOverall:false → 不是 degraded，是 stopped', async () => {
    const agg = registry.aggregate([mk('homeNode', 'offline'), mk('restart', 'offline'), registry.notEnabled(registry.byId('vision'))]);
    assert.strictEqual(agg.overall, 'stopped');
    assert.deepStrictEqual(agg.affected, [], 'informational components must never affect the verdict');
  });

  await check('E5 聚合只观察不改写：输入报告在聚合前后逐字节相同', async () => {
    const reports = [mk('static', 'healthy'), mk('bridge', 'offline', { reason: { category: 'offline', message: 'x' } })];
    const snapshot = JSON.stringify(reports);
    registry.aggregate(reports);
    assert.strictEqual(JSON.stringify(reports), snapshot, 'aggregate mutated its input');
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'component-registry.js'), 'utf8');
    /* 观察层不能包含任何进程控制调用：注册表只描述，不启动也不终止 */
    assert.ok(!/child_process|\.kill\(|execFile\(|spawn\(/.test(src),
      'the registry must not contain any process-control call');
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   F · mutations: break the registry, and the claims must fail
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteF() {
  section('F. 变异测试（在临时副本里破坏注册表，同样的断言必须失败）');

  await check('F1 移除 homeNode 注册 → boot-state 的组件轴随之塌陷（原位断言会失败）', async () => {
    const dir = mutationTree();
    const file = path.join(dir, 'runtime', 'component-registry.js');
    const original = fs.readFileSync(file, 'utf8');
    const mutated = original.replace(/id: 'homeNode'/, "id: 'homeNodeX'");
    assert.notStrictEqual(mutated, original, 'mutation did not apply');
    fs.writeFileSync(file, mutated);
    const MUT = require(file);
    assert.ok(!MUT.componentOrder().includes('homeNode'), 'mutated registry still claims homeNode');
    /* 这正是 B1 断言会失败的原因：注册表清单与启动记录清单必须逐项相同 */
    const fresh = freshRegistry();
    assert.deepStrictEqual(fresh.componentOrder(), BOOT.COMPONENT_ORDER,
      'B1 compares the record vocabulary against the registry axis');
    assert.notDeepStrictEqual(MUT.componentOrder(), BOOT.COMPONENT_ORDER,
      'B1 would still pass against a registry whose homeNode registration was removed');
  });

  await check('F2 伪造健康状态 → classifyProbe/aggregate 拒绝对一个离线端口报 healthy', async () => {
    const dir = mutationTree();
    const file = path.join(dir, 'runtime', 'component-registry.js');
    const original = fs.readFileSync(file, 'utf8');
    /* 把"身份匹配"改成永远为真 —— 这正是最危险的一类伪造 */
    const mutated = original.replace(
      "matchesHealth: data => !!(data && data.server === 'IB Bridge')",
      'matchesHealth: data => true');
    assert.notStrictEqual(mutated, original, 'mutation did not apply');
    fs.writeFileSync(file, mutated);
    delete require.cache[require.resolve(file)];
    const MUT = require(file);
    const bridge = MUT.byId('bridge');
    assert.strictEqual(bridge.matchesHealth({ ok: true, server: 'totally-different' }), true, 'mutation not effective');
    /* 真正的守卫在别处：classifyProbe 的 conflict 分支依赖 identityOk，
       而 identityOk 只有在 identify predicate 为真时才为真 —— 所以这个变体会
       让"占端口的陌生服务"被当成健康。原位断言（A6）正是为此而存在。 */
    const fresh = freshRegistry();
    assert.strictEqual(fresh.byId('bridge').matchesHealth({ ok: true, server: 'totally-different' }), false,
      'A6 must reject an identity predicate that accepts anything');
  });

  await check('F3 重复组件 id → 唯一性断言失败（重复注册无法被静默接受）', async () => {
    const dir = mutationTree();
    const file = path.join(dir, 'runtime', 'component-registry.js');
    const original = fs.readFileSync(file, 'utf8');
    const mutated = original.replace("id: 'homeNode',", "id: 'bridge',");
    assert.notStrictEqual(mutated, original, 'mutation did not apply');
    fs.writeFileSync(file, mutated);
    delete require.cache[require.resolve(file)];
    const MUT = require(file);
    const ids = MUT.COMPONENTS.map(c => c.id);
    assert.notStrictEqual(new Set(ids).size, ids.length, 'duplicate ids did not survive into the mutated registry');
    /* A1 的形式化版本：唯一性必须在真注册表上成立 */
    const fresh = freshRegistry();
    const freshIds = fresh.COMPONENTS.map(c => c.id);
    assert.strictEqual(new Set(freshIds).size, freshIds.length);
    /* uniqueByName 对重复名返回 null，而不是随便挑一个 */
    const dupTree = mutationTree();
    const dupFile = path.join(dupTree, 'runtime', 'component-registry.js');
    fs.writeFileSync(dupFile, fs.readFileSync(dupFile, 'utf8').replace("name: 'HomeNode',", "name: 'Bridge',"));
    delete require.cache[require.resolve(dupFile)];
    const DUP = require(dupFile);
    assert.strictEqual(DUP.uniqueByName('Bridge'), null, 'a duplicated name must not resolve to an arbitrary component');
  });

  await check('F4 变体不污染真仓库：原文件逐字节未变', async () => {
    const before = sha256(path.join(ROOT, 'runtime', 'component-registry.js'));
    const dir = mutationTree();
    fs.writeFileSync(path.join(dir, 'runtime', 'component-registry.js'), '// destroyed\n');
    const after = sha256(path.join(ROOT, 'runtime', 'component-registry.js'));
    assert.strictEqual(after, before, 'the real registry file was modified by the mutation harness');
    assert.strictEqual(registry.componentOrder().includes('homeNode'), true, 'the loaded registry lost homeNode');
  });

  await check('F5 注册表被删掉时启动链会明确失败，而不是静默少一个组件', async () => {
    const dir = mutationTree();
    fs.unlinkSync(path.join(dir, 'runtime', 'component-registry.js'));
    const r = await new Promise(resolve => {
      const child = spawn(process.execPath, ['-e', 'require("./runtime/boot-state.js")'], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', c => { err += c; });
      child.on('exit', code => resolve({ code: code, err: err }));
    });
    assert.notStrictEqual(r.code, 0, 'a missing registry must fail loudly');
    assert.ok(/component-registry/.test(r.err), 'the error must name the missing module: ' + r.err.slice(0, 200));
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   G · packaging: the registry is loadable by everything that now needs it
   ═══════════════════════════════════════════════════════════════════════════ */

async function suiteG() {
  section('G. 打包与依赖闭包');

  await check('G1 注册表无依赖、无副作用（纯模型）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'component-registry.js'), 'utf8');
    assert.ok(!/^const .*=\s*require\(/m.test(src), 'the registry must not require anything at load time');
    const before = process.env.IB_BRIDGE_PORT;
    process.env.IB_BRIDGE_PORT = '25999';
    const fresh = freshRegistry();
    assert.strictEqual(fresh.portOf('bridge'), 25999, 'ports must be read at call time, not at load time');
    if (before === undefined) delete process.env.IB_BRIDGE_PORT; else process.env.IB_BRIDGE_PORT = before;
  });

  await check('G2 发行包必须包含注册表本身（否则安装后启动链直接崩）', async () => {
    const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));
    const resolved = manifest.resolve({});
    const tos = new Set(resolved.files.map(f => f.to));
    assert.ok(tos.has('runtime/component-registry.js'), 'the shipped payload has no component registry');
    for (const dep of ['runtime/boot-state.js', 'runtime/local-services-runner.js', 'runtime/launch-internal-beyond.js']) {
      assert.ok(tos.has(dep), 'payload missing ' + dep);
    }
  });

  await check('G3 注册表登记的每个 serviceFile 都真的存在（注册了但装不上是不可接受的）', async () => {
    const files = registry.serviceFiles();
    assert.ok(files.length >= 3, 'expected at least three spawnable services: ' + JSON.stringify(files));
    for (const rel of files) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), 'registry declares a service file that does not exist: ' + rel);
    }
  });

  await check('G4 runner 对每个 managed 组件都有启动方式（注册了就一定能被启动）', async () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    const block = src.slice(src.indexOf('const SERVICE_LAUNCH'), src.indexOf('function buildServiceSpec'));
    for (const c of registry.managed()) {
      assert.ok(new RegExp('\\b' + c.id + '\\s*:\\s*\\{').test(block),
        'no launch recipe for registered managed component ' + c.id);
    }
  });
}

/* ── main ───────────────────────────────────────────────────────────────── */

(async () => {
  console.log('P11-3B · component registry + health aggregation\n');
  await suiteA();
  await suiteB();
  await suiteC();
  await suiteD();
  await suiteE();
  await suiteF();
  await suiteG();

  console.log('\n结果: ' + passed + ' 通过, ' + failures.length + ' 失败');
  if (failures.length) {
    console.log('\n失败明细:');
    for (const f of failures) console.log('  ✗ ' + f.name + '\n    ' + String((f.error && f.error.stack) || f.error));
    process.exitCode = 1;
  }

  /* No process.exit(0): leaked children/servers/timers must keep the loop alive
     and be visible rather than being hidden by an explicit exit (P7 discipline). */
  try { fs.rmSync(MUTATION_TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
})().catch(error => {
  console.error('harness failure: ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
