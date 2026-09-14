'use strict';

/*
 * Internal Beyond · component registry (P11-3B)
 *
 * ONE static model of every long-running component the product can have. It
 * replaces four hand-written lists that had already drifted apart:
 *
 *   1. runtime/local-services-runner.js SERVICES          (start + port + identity)
 *   2. runtime/local-services-runner.js runRestart()      (restart targets)
 *   3. runtime/launch-internal-beyond.js                  (boot-state components)
 *   4. runtime/boot-state.js COMPONENT_ORDER              (record vocabulary/order)
 *
 * The drift was not hypothetical: components 1 and 2 did not list the same
 * services, and list 3 could not describe Home Node at all, so a boot record
 * was structurally incapable of reporting a component the runner manages.
 *
 * ── What this file is, and is not ─────────────────────────────────────────
 *
 *   IS   the static declaration: ids, ports, health endpoints, identity
 *        predicates, required/degraded semantics, and the state↔reason mapping
 *        from one probe outcome.
 *   IS   dependency-free. No filesystem, no HTTP, no process, no other module.
 *        That is what lets the launcher, the runner and an installer-side tool
 *        load it without dragging a runtime in behind it.
 *   IS NOT a supervisor, a restart policy, or a recovery mechanism. P11-3B is
 *        observation only: registering, probing, reporting. Nothing in this
 *        file starts, stops, retries, backs off or recovers anything.
 *   IS NOT a second boot state. The launch snapshot stays boot-state.json
 *        (P2); this file supplies the component *axis* that snapshot is keyed
 *        by, so the two cannot disagree about which components exist.
 *   IS NOT a live monitor. Live aggregation is produced by the runner's probe
 *        (see services/../runtime/local-services-runner.js) at the moment it
 *        answers; a boot record only ever describes one launch.
 *
 * ── Vocabulary freeze ─────────────────────────────────────────────────────
 *
 * boot-state ids are a frozen P2/P3 contract (the loader, the diagnostics page
 * and the error catalogue all key off them). They are NEVER renamed here; a new
 * component only ever APPENDS. `id` is the boot-state id, `name` is the human
 * label used by the runner's status output, and `scriptKey` is the registration
 * key that satisfies the P11-3B contract.
 */

/* ── Probe outcome vocabulary ──────────────────────────────────────────────
 *
 * Component states are the same strings boot-state already emits, so the
 * diagnostics page and the error catalogue keep working unchanged. `reason`
 * categories are boot-state's REASON values, mirrored here by value so this
 * module stays dependency-free; tests/test_p11_3b_component_registry.js asserts
 * these are exactly boot-state.REASON's own set — drift fails the suite rather
 * than being discovered by a user.
 *
 * P11-3X-B adds two things to that closed set, and neither is a second taxonomy:
 *
 *   · `store-closed` — the component answered and named itself, but said it cannot
 *     serve the role it declares. Reachable-but-not-serving is a different fact
 *     from unreachable, and it used to be reported as `healthy`;
 *   · the `db-*` family — the database failure classes from the ONE classifier
 *     (runtime/db-failure.js).
 *
 * The `db-*` values are MIRRORED BY VALUE rather than required from the classifier,
 * and that is not laziness: `require`ing it here would break a real invariant this
 * module is held to — "the registry is a pure model with no dependencies at load
 * time" (tests/test_p11_3b_component_registry.js G1, which is what caught the first
 * attempt to derive them). Drift is guarded by assertion instead of by construction:
 * tests/test_p11_3b_component_registry.js A5 pins registry ⊆ boot-state, and
 * tests/test_p11_3x_b_runtime_db_reliability.js C8 pins the classifier's whole set
 * into BOTH — so a class the classifier can emit but the model cannot name fails the
 * suite rather than reaching an operator as "process-exit". */

const STATE = {
  UNKNOWN: 'unknown',
  STARTING: 'starting',
  HEALTHY: 'healthy',
  OFFLINE: 'offline',
  CONFLICT: 'conflict',
  ERROR: 'error',
  NOT_ENABLED: 'not-enabled'
};

/* The closed set a live probe may produce. `starting`/`not-enabled` are not
   probe outcomes — a probe cannot observe them — so they are excluded. */
const OBSERVED_STATES = [STATE.HEALTHY, STATE.OFFLINE, STATE.CONFLICT, STATE.ERROR, STATE.UNKNOWN];

const REASON = {
  OFFLINE: 'offline',
  CONFLICT: 'conflict',
  TIMEOUT: 'timeout',
  PROBE_FAILED: 'probe-failed',
  UNKNOWN: 'unknown',
  NOT_ENABLED: 'not-enabled',
  /* Identity confirmed, transport healthy, role not being served. */
  STORE_CLOSED: 'store-closed',
  /* Database failure classes. Mirrored by value from runtime/db-failure.js — see the
     vocabulary comment above for why this is not a `require`, and for the two tests
     that fail the moment these drift from the classifier. */
  DB_READONLY: 'db-readonly',
  DB_PERMISSION_DENIED: 'db-permission-denied',
  DB_BUSY: 'db-busy',
  DB_LOCKED: 'db-locked',
  DB_DISK_FULL: 'db-disk-full',
  DB_CORRUPT: 'db-corrupt',
  DB_SCHEMA_TOO_NEW: 'db-schema-too-new',
  DB_OPEN_FAILED: 'db-open-failed',
  DB_UNAVAILABLE: 'db-unavailable'
};

/* ── Port derivation ───────────────────────────────────────────────────────
 *
 * Each component owns the environment variable that overrides its port and the
 * fallback. The runner, the launcher and the server all read the SAME variable
 * (IB_BRIDGE_PORT etc.), so they agree by construction instead of by convention.
 * A blank or unusable override falls back to the default rather than inventing
 * port 0. */

function portOf(id, env) {
  const c = byId(id);
  if (!c) return 0;
  const source = env || process.env;
  const n = Number(source[c.portEnv]);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : c.defaultPort;
}

function portOfEnv(portEnv, defaultPort, env) {
  const source = env || process.env;
  const n = Number(source[portEnv]);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : defaultPort;
}

/* ── The registry ──────────────────────────────────────────────────────── */

/* Identity predicate: /health answered with JSON that names THIS component. A
   port holder that answers something else is a conflict, never a healthy
   component — the runner has enforced this since P2 and the registry is now the
   only place the predicate is written.
 *
 * Two layers, deliberately:
 *   · identity()      — "is this JSON about me?" (catches a foreign service on
 *                       our port, which is the interesting failure);
 *   · identityComplete — the probe layer's extra requirement (`ok:true` for the
 *                       components that have always required it).
 * Keeping them apart is what lets a test say WHICH of the two rejected a
 * response, instead of getting one opaque false. */
function identityIgnoresOk(component) {
  return component.identityRequiresOk !== true;
}

function identityMatches(component, data) {
  if (!component.matchesHealth || !component.matchesHealth(data)) return false;
  return identityIgnoresOk(component) || !!(data && data.ok === true);
}

function identityOk(data) {
  return !!(data && data.ok === true);
}

/* ── Reachable ≠ able to serve (P11-3X-B) ─────────────────────────────────
 *
 * The identity predicate answers "is this JSON about me?" and must keep doing
 * only that: a port that answers something else is a conflict, never an error,
 * and folding capability into identity would make those two indistinguishable.
 * So there is a second, separate question, asked only after identity passes:
 * "given that this is really you, are you able to do your job?"
 *
 * `servingHealth` is a declarative hook on the component, exactly like
 * `matchesHealth`. It returns null when the component is serving, or a
 * `{ category, message }` when it is reachable but cannot serve. The category is
 * validated against the frozen vocabulary: a component may name its own failure
 * class (that is the point — Home Node knows `store-closed`), but it cannot
 * invent one outside the closed set, which would put a class into the health view
 * that nothing else can render or act on.
 *
 * Only the identity check remains name-only (`identityRequiresOk` stays false for
 * homeNode on purpose): the installer's stop chain has to be able to recognise the
 * process in order to stop it, and a stop chain that loses the process because its
 * store is broken is a worse failure than the one it is trying to fix. */
const KNOWN_REASONS = Object.keys(REASON).map(k => REASON[k]);

function servingFailure(component, data) {
  if (!component.servingHealth || typeof component.servingHealth !== 'function') return null;
  const verdict = component.servingHealth(data);
  if (!verdict) return null;
  const known = typeof verdict.category === 'string' && KNOWN_REASONS.indexOf(verdict.category) >= 0;
  return {
    category: known ? verdict.category : REASON.STORE_CLOSED,
    message: String(verdict.message || (component.label + ' is reachable but cannot serve its role')).slice(0, 300)
  };
}

const COMPONENTS = [
  {
    id: 'static',
    name: 'Static',
    scriptKey: 'static',
    label: '主界面服务',
    portEnv: 'IB_WEB_PORT',
    defaultPort: 23120,
    healthPath: '/health',
    identity: { server: 'InternalBeyond Web' },
    /* The static server has always been checked with ok:true as part of its
       identity (launcher + ib-stop). Pinned here so the registry cannot silently
       relax a check that a caller used to perform. */
    identityRequiresOk: true,
    /* Extra document proof: an identity-correct server that cannot serve the UI
       document still means "no UI", so the launcher checks this separately. */
    uiDocumentPath: '/InternalBeyond.html',
    /* Installer-side graceful stop surface (POST). Declared, not called here. */
    stopPath: '/__shutdown',
    requiresDeviceAuth: false,
    managedByRunner: false,
    observedByLauncher: true,
    required: true,
    affectsOverall: true,
    healthyRequiredForServices: false,
    restartable: false,
    controllable: true,
    matchesHealth: identityOk
  },
  {
    id: 'bridge',
    name: 'Bridge',
    scriptKey: 'ib-bridge-service.js',
    label: 'Bridge 后端',
    portEnv: 'IB_BRIDGE_PORT',
    defaultPort: 23115,
    healthPath: '/health',
    identity: { server: 'IB Bridge' },
    serviceFile: 'services/ib-bridge-service.js',
    requiresDeviceAuth: false,
    managedByRunner: true,
    observedByLauncher: true,
    required: false,
    affectsOverall: true,
    healthyRequiredForServices: true,
    restartable: true,
    controllable: true,
    /* P11-3H：合作停止面。声明在这里（而不是在 installer 的另一张表里），
       所以「哪些组件可被停止」与「它们是谁 / 在哪个端口」出自同一条登记。 */
    stopPath: '/__shutdown',
    matchesHealth: data => !!(data && data.server === 'IB Bridge')
  },
  {
    id: 'active',
    name: 'Active',
    scriptKey: 'active-message-service.js',
    label: '后台主动消息服务',
    portEnv: 'IB_ACTIVE_PORT',
    defaultPort: 23114,
    healthPath: '/health',
    identity: { service: 'internal-beyond-active-messages' },
    serviceFile: 'services/active-message-service.js',
    requiresDeviceAuth: false,
    managedByRunner: true,
    observedByLauncher: true,
    required: false,
    affectsOverall: true,
    healthyRequiredForServices: true,
    restartable: true,
    controllable: true,
    /* P11-3H：合作停止面（同上；Active 的调度器与状态文件在停止时必须先落盘）。 */
    stopPath: '/__shutdown',
    matchesHealth: data => !!(data && data.service === 'internal-beyond-active-messages')
  },
  {
    /* Home Node is the canonical chat authority (M1-A). The desktop always
       starts it on the default loopback host; LAN exposure requires explicit
       user opt-in plus real device auth (see services/home-node/http.js).
       Its absence must never block the main UI — home-node-client treats
       "offline" as a state it can fall back from — so it is an observed
       component that does NOT affect the overall launch verdict. That choice
       is deliberate: the UI works without it, and a boot record that cried
       "degraded" on every launch of a working product would train the user to
       ignore the word. */
    id: 'homeNode',
    name: 'HomeNode',
    scriptKey: 'home-node-service.js',
    label: 'Home Node 聊天权威',
    portEnv: 'IB_HOME_NODE_PORT',
    defaultPort: 23118,
    healthPath: '/health',
    identity: { service: 'internal-beyond-home-node' },
    serviceFile: 'services/home-node-service.js',
    requiresDeviceAuth: true,
    managedByRunner: true,
    observedByLauncher: true,
    required: false,
    affectsOverall: false,
    healthyRequiredForServices: false,
    restartable: true,
    controllable: true,
    /* P11-3H：Home Node 的合作停止面。这一行是"installer 停止链是否知道 Home Node"
       这个问题的答案：修复前它**没有**任何一处声明，于是 installer 的 stop helper
       里那张手写表根本没有 Home Node 这个组件（P11-3H Phase 1 实测：
       ib-stop.serviceTable() = web/runner/bridge/active，23118 不在其中）。 */
    stopPath: '/__shutdown',
    matchesHealth: data => !!(data && data.service === 'internal-beyond-home-node'),
    /* P11-3X-B：身份对只是第一问。Home Node 的 `/health` 现在还回答第二问 ——
       "我能不能干我的活"（`serving` / `failure`）。把它的裁决原样读出来即可；
       这一层不重新推断，因为只有它自己知道自己的 store 是什么状态。
       实测修复前：库已关闭时它回答 `{ok:true, open:false}`，于是这里把它判成
       healthy —— 一个连一条聊天都写不进去的进程被报成健康组件。

       P11-3E：`serving` 现在覆盖的不只是 chat store。Home Node 的生产启动路径
       补上了 canonical Moments store 的 open/close 之后，一个"能聊天但看不到
       任何动态"的节点才第一次**可能**被如实报出来。类别仍然原样取自 `/health`
       的 failure（那份词表是 boot-state.REASON 与 db-failure 分类器的共同闭集），
       这里不新增任何分类。 */
    servingHealth: data => {
      if (!data || data.serving !== false) return null;
      const failure = data.failure || null;
      return {
        category: (failure && failure.category) || REASON.STORE_CLOSED,
        message: (failure && failure.message) ||
          'Home Node answered but reports it cannot serve its canonical role'
      };
    }
  },
  {
    /* The restart control plane lives inside the runner process itself; it has
       no service file and nothing to spawn. It is informational in the boot
       record (the UI's restart button is optional), but it IS restartable in
       the sense that a restart cycle must not kill the plane answering it. */
    id: 'restart',
    name: 'Restart',
    scriptKey: 'restart-control',
    label: '后端重启控制面',
    portEnv: 'IB_RESTART_PORT',
    defaultPort: 23116,
    healthPath: '/status',
    identity: { service: 'InternalBeyond Restart' },
    serviceFile: null,
    requiresDeviceAuth: false,
    managedByRunner: false,
    observedByLauncher: true,
    required: false,
    affectsOverall: false,
    healthyRequiredForServices: false,
    restartable: false,
    controllable: false,
    matchesHealth: data => !!(data && data.service === 'InternalBeyond Restart')
  },
  {
    id: 'vision',
    name: 'Vision',
    scriptKey: 'vision-helper',
    label: 'Vision 高级可选组件',
    portEnv: 'IB_VISION_PORT',
    defaultPort: 8765,
    healthPath: '/health',
    identity: { service: 'internal-beyond-vision' },
    serviceFile: null,
    requiresDeviceAuth: false,
    managedByRunner: true,
    observedByLauncher: true,
    required: false,
    affectsOverall: false,
    healthyRequiredForServices: false,
    restartable: false,
    controllable: false,
    matchesHealth: data => !!(data && data.service === 'internal-beyond-vision')
  }
];

/* Frozen so a consumer cannot mutate the single source of truth at runtime. */
COMPONENTS.forEach(Object.freeze);
Object.freeze(COMPONENTS);

const IDS = COMPONENTS.map(c => c.id);
const NAME_TO_ID = {};
COMPONENTS.forEach(c => { NAME_TO_ID[c.name] = c.id; });

/* ── Lookups ───────────────────────────────────────────────────────────── */

function byId(id) {
  return COMPONENTS.find(c => c.id === id) || null;
}

/* The runner registers services by their human name ('Bridge', 'Active', …). */
function byName(name) {
  const id = NAME_TO_ID[name];
  return id ? byId(id) : null;
}

/* A display name that is registered exactly once. Duplicate registration is a
   defect the registry refuses to hide. */
function uniqueByName(name) {
  const hits = COMPONENTS.filter(c => c.name === name);
  return hits.length === 1 ? hits[0] : null;
}

function managed() { return COMPONENTS.filter(c => c.managedByRunner); }
function observed() { return COMPONENTS.filter(c => c.observedByLauncher); }
function restartTargets() { return COMPONENTS.filter(c => c.restartable); }
function requiredForServices() { return COMPONENTS.filter(c => c.healthyRequiredForServices); }
function serviceFiles() { return COMPONENTS.map(c => c.serviceFile).filter(Boolean); }

/* ── Lifecycle targets (P11-3H) ────────────────────────────────────────────
 *
 * The components that expose a cooperative stop surface, i.e. the set the
 * lifecycle is required to be able to stop. Derived from ONE declaration —
 * `stopPath` — that sits next to the port and the identity predicate it belongs
 * with, so it cannot drift away from them.
 *
 * This replaces the hand-written stop table in installer/tools/ib-stop.js,
 * which listed four Services that were not even the registry's components and
 * omitted Home Node entirely. A component added here with a `stopPath` is
 * automatically a stop target for the installer, the updater's stop chain and
 * the runner; a component added WITHOUT one is automatically not, which is a
 * decision the author has to make explicitly instead of forgetting to update a
 * second list.
 *
 * `restartTargets()` above answers a different question (may the supervisor
 * start it again); the two sets are related but not the same, and neither is
 * derived from the other. */
function lifecycleTargets() { return COMPONENTS.filter(c => typeof c.stopPath === 'string' && c.stopPath); }
function lifecycleTargetIds() { return lifecycleTargets().map(c => c.id); }

/* boot-state COMPONENT_ORDER: the frozen ids, in registry order. */
function componentOrder() { return IDS.slice(); }

/* ── Probe outcome → (state, reason) ───────────────────────────────────────
 *
 * The SINGLE mapping from one probe result to a component report. The runner's
 * live view and the launcher's boot record both go through here, so a component
 * can never be "conflict" in one and "offline" in the other.
 *
 * probe = { responding, timedOut, status, data }
 * opts  = { waitedMs, probeError, port, timeoutMs }
 *
 * `port`/`timeoutMs` exist so the reason text names the port that was actually
 * probed and the timeout that actually elapsed. Before P11-3X-B the message always
 * said `c.defaultPort` and, when the caller passed no timeout, "within 0ms" —
 * measured in the runner's own view, which reported a real failure on port 12212 as
 * "did not answer /health on port 23115 within 0ms". A diagnosis that names the
 * wrong port is worse than no diagnosis: it sends the operator to a port that is
 * not the problem.
 */
function classifyProbe(component, probe, opts) {
  const c = component;
  const p = probe || {};
  const o = opts || {};
  const waited = Number(o.waitedMs) > 0 ? Number(o.waitedMs) : 0;
  const port = Number.isInteger(o.port) && o.port > 0 ? o.port
    : (Number.isInteger(p.port) && p.port > 0 ? p.port : c.defaultPort);
  const budget = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs)
    : (Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : waited);

  if (o.probeError) {
    return {
      state: STATE.UNKNOWN,
      reason: { category: REASON.PROBE_FAILED, message: String(o.probeError).slice(0, 300) }
    };
  }
  if (p.timedOut && p.responding !== true) {
    return {
      state: STATE.OFFLINE,
      reason: {
        category: REASON.TIMEOUT,
        message: c.name + ' did not answer ' + c.healthPath + ' on port ' + port +
          (budget > 0 ? ' within ' + budget + 'ms' : '')
      }
    };
  }
  if (p.responding === true) {
    const identityOkNow = p.identityOk !== undefined ? p.identityOk === true : identityMatches(c, p.data);
    if (identityOkNow) {
      /* Identity confirmed. The only question left is whether the component can do
         its job; a "no" here is `error` (it is ours, and it is broken), never
         `conflict` (which means the port belongs to somebody else). */
      const notServing = servingFailure(c, p.data);
      if (notServing) return { state: STATE.ERROR, reason: notServing };
      return { state: STATE.HEALTHY, reason: null };
    }
    return {
      state: STATE.CONFLICT,
      reason: {
        category: REASON.CONFLICT,
        message: 'port ' + port + ' answered ' + c.healthPath + ' but is not ' + c.label + ' (' + c.name + ')'
      }
    };
  }
  return {
    state: STATE.OFFLINE,
    reason: {
      category: REASON.OFFLINE,
      message: c.name + ' is not answering ' + c.healthPath + ' on port ' + port
    }
  };
}

/* ── Component report ──────────────────────────────────────────────────── */

/*
 * Normalize one component report. Every consumer builds its rows through this,
 * so the boot record, the live health view and the tests agree on the shape.
 * `healthy` is never trusted from the caller — it is derived from `state`, which
 * is derived from the probe. That is deliberate: a component cannot be reported
 * running because someone passed healthy:true.
 *
 * report = {
 *   id, port, state, reason, probed, reachable, identityOk, timedOut,
 *   statusCode, version, details, respondedAt, probedAt, startedAt, pid,
 *   tookMs, note
 * }
 */
function componentReport(component, report) {
  const r = report || {};
  const state = typeof r.state === 'string' && r.state ? r.state : STATE.UNKNOWN;
  const out = {
    id: component.id,
    name: component.name,
    label: component.label,
    port: Number.isInteger(r.port) && r.port > 0 ? r.port : component.defaultPort,
    required: component.required,
    affectsOverall: component.affectsOverall,
    restartable: component.restartable,
    state: state,
    healthy: state === STATE.HEALTHY,
    probed: r.probed !== false,
    reachable: r.reachable === true,
    identityOk: r.identityOk === true,
    timedOut: r.timedOut === true,
    statusCode: Number.isInteger(r.statusCode) ? r.statusCode : 0,
    reason: state === STATE.HEALTHY ? null : (r.reason || null)
  };
  /* Detailed fields only when the caller actually has them — absence stays
     absence, so a report never invents a pid or a version. */
  if (r.version !== undefined && r.version !== null && String(r.version) !== '') out.version = String(r.version).slice(0, 60);
  if (r.pid !== undefined && r.pid !== null) out.pid = Number(r.pid);
  if (r.tookMs !== undefined && r.tookMs !== null) out.tookMs = Number(r.tookMs);
  if (r.respondedAt !== undefined && r.respondedAt !== null) out.respondedAt = Number(r.respondedAt);
  if (r.probedAt !== undefined && r.probedAt !== null) out.probedAt = Number(r.probedAt);
  if (r.startedAt !== undefined && r.startedAt !== null) out.startedAt = Number(r.startedAt);
  if (r.details !== undefined && r.details !== null) out.details = r.details;
  if (r.note !== undefined && r.note !== null) out.note = String(r.note).slice(0, 300);
  /* P11-3X-B · port ownership class. Reported only when a caller actually
     classified an occupant — `null` means "this view did not ask", which is not
     the same as "free", and inventing one would be the same class of lie this
     phase exists to remove. `pids` are numbers the OS gave us for a local port;
     they are never a path, a command line or a credential. */
  if (r.portOwner !== undefined && r.portOwner !== null) out.portOwner = String(r.portOwner).slice(0, 40);
  if (Array.isArray(r.portOwnerPids)) out.portOwnerPids = r.portOwnerPids.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0).slice(0, 8);
  if (r.portOwnerReason !== undefined && r.portOwnerReason !== null) out.portOwnerReason = String(r.portOwnerReason).slice(0, 120);
  return out;
}

/* Probe a component over HTTP. The ONLY place a component health request is
   constructed. Never throws: an unreachable component is a reportable state,
   not an exception. */
function probeComponent(component, opts) {
  const o = opts || {};
  const http = require('http');
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 1800;
  const host = o.host || '127.0.0.1';
  const port = Number.isInteger(o.port) && o.port > 0 ? o.port : component.defaultPort;
  const startedAt = Date.now();
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (settled) return; settled = true; resolve(value); };
    let req;
    try {
      req = http.get({ host: host, port: port, path: component.healthPath, timeout: timeoutMs }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
          done({
            responding: true,
            timedOut: false,
            status: res.statusCode,
            data: data
          });
        });
      });
    } catch (e) {
      done({ responding: false, timedOut: false, status: 0, data: null });
      return;
    }
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) { /* ignore */ }
      done({ responding: false, timedOut: true, status: 0, data: null, timeoutMs: timeoutMs });
    });
    req.on('error', () => done({ responding: false, timedOut: false, status: 0, data: null }));
  }).then(probe => {
    const took = Date.now() - startedAt;
    const identityOkNow = !!(probe.responding && identityMatches(component, probe.data));
    const classified = classifyProbe(component, {
      responding: probe.responding,
      timedOut: probe.timedOut,
      status: probe.status,
      data: probe.data,
      identityOk: identityOkNow,
      timeoutMs: probe.timeoutMs
    }, { port: port, timeoutMs: timeoutMs });
    return componentReport(component, {
      port: port,
      state: classified.state,
      reason: classified.reason,
      probed: true,
      reachable: probe.responding === true,
      identityOk: identityOkNow,
      timedOut: probe.timedOut === true,
      statusCode: probe.status,
      tookMs: took,
      probedAt: startedAt,
      version: (probe.data && (probe.data.version || probe.data.serviceVersion)) || '',
      details: probe.data || null
    });
  });
}

/* A component this host can never observe, reported honestly instead of as a
   health failure. Used for e.g. Vision on a platform without the helper. */
function notEnabled(component, note) {
  return componentReport(component, {
    state: STATE.NOT_ENABLED,
    probed: false,
    reachable: false,
    identityOk: false,
    reason: {
      category: REASON.NOT_ENABLED,
      message: note || (component.name + ' is not enabled in this configuration')
    }
  });
}

/* ── Health aggregation (observation only) ─────────────────────────────────
 *
 * Answers, from reports produced by probes: which components run, which are
 * stopped, which are in an error/conflict state, and when this view was built.
 * It performs no action of any kind on the reported components.
 */
function aggregate(reports, opts) {
  const o = opts || {};
  const list = Array.isArray(reports) ? reports.filter(Boolean) : [];
  const now = Number.isFinite(Number(o.now)) && Number(o.now) > 0 ? Number(o.now) : Date.now();

  const running = [];
  const stopped = [];
  const errored = [];
  const notEnabledIds = [];
  const notObserved = [];

  for (const r of list) {
    if (r.state === STATE.HEALTHY) running.push(r.id);
    else if (r.state === STATE.NOT_ENABLED) notEnabledIds.push(r.id);
    else if (r.state === STATE.CONFLICT || r.state === STATE.ERROR) errored.push(r.id);
    else if (r.probed === false) notObserved.push(r.id);
    else stopped.push(r.id);
  }

  /* affected = what actually pulls the verdict down. Two conditions, both
     deliberate:
       · affectsOverall — an informational component is never a failure;
       · probed — an unobserved component is UNKNOWN, and "unknown" must not be
         laundered into "failed". (The static layer is observed by the launcher,
         not by the runner, so the runner's own view of it is honestly unknown.) */
  const affected = list.filter(r => r.affectsOverall === true && r.probed !== false && !r.healthy);

  const healthy = list.filter(r => r.healthy === true).length;
  /* P11-3X-B：`notUp` = 明确没在正常工作的组件（停了，或者被探到处于 conflict/error）。
     `errored` 与 `stopped` 在这里必须同等对待，否则会出现下面这种自相矛盾的裁决：
     "运行中: bridge,active · 异常: homeNode · overall: healthy" —— 一个已经在
     `errored` 列表里的组件同时出现在一张说整体健康的表上。`affectsOverall` 管的是
     "它不在会不会挡住产品"（Home Node 不在不该让桌面启动变 degraded，这是 P11-3B
     刻意的决定，这里不动它）；而"它在而且坏了"是更弱的问题，答案只能是 partial。 */
  const notUp = stopped.length + errored.length;
  let overall;
  if (!list.length) overall = 'unknown';
  else if (affected.length) overall = 'degraded';
  else if (healthy === 0 && notUp === 0) overall = 'unknown';
  else if (healthy === 0) overall = 'stopped';
  else if (notUp) overall = 'partial';
  else overall = 'healthy';
  return {
    schema: 'internalbeyond.component-health',
    version: 1,
    updatedAt: now,
    overall: overall,
    counts: {
      total: list.length,
      healthy: healthy,
      running: running.length,
      stopped: stopped.length,
      errored: errored.length,
      notEnabled: notEnabledIds.length,
      notObserved: notObserved.length,
      affected: affected.length
    },
    running: running,
    stopped: stopped,
    errored: errored,
    notEnabled: notEnabledIds,
    notObserved: notObserved,
    affected: affected.map(r => r.id),
    reasons: affected.map(r => ({
      component: r.id,
      state: r.state,
      category: (r.reason && r.reason.category) || r.state,
      message: (r.reason && r.reason.message) || ''
    })),
    components: list
  };
}

module.exports = {
  SCHEMA: 'internalbeyond.component-registry',
  VERSION: 1,
  STATE: STATE,
  OBSERVED_STATES: OBSERVED_STATES,
  REASON: REASON,
  COMPONENTS: COMPONENTS,
  IDS: IDS,
  byId: byId,
  byName: byName,
  uniqueByName: uniqueByName,
  managed: managed,
  observed: observed,
  restartTargets: restartTargets,
  lifecycleTargets: lifecycleTargets,
  lifecycleTargetIds: lifecycleTargetIds,
  requiredForServices: requiredForServices,
  serviceFiles: serviceFiles,
  componentOrder: componentOrder,
  portOf: portOf,
  portOfEnv: portOfEnv,
  classifyProbe: classifyProbe,
  identityMatches: identityMatches,
  identityIgnoresOk: identityIgnoresOk,
  componentReport: componentReport,
  probeComponent: probeComponent,
  notEnabled: notEnabled,
  aggregate: aggregate
};
