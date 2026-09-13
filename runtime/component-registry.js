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
 * than being discovered by a user. */

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
  NOT_ENABLED: 'not-enabled'
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
    controllable: false,
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
    controllable: false,
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
    controllable: false,
    matchesHealth: data => !!(data && data.service === 'internal-beyond-home-node')
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

/* boot-state COMPONENT_ORDER: the frozen ids, in registry order. */
function componentOrder() { return IDS.slice(); }

/* ── Probe outcome → (state, reason) ───────────────────────────────────────
 *
 * The SINGLE mapping from one probe result to a component report. The runner's
 * live view and the launcher's boot record both go through here, so a component
 * can never be "conflict" in one and "offline" in the other.
 *
 * probe = { responding, timedOut, status, data }
 * opts  = { waitedMs, probeError }
 */
function classifyProbe(component, probe, opts) {
  const c = component;
  const p = probe || {};
  const o = opts || {};
  const waited = Number(o.waitedMs) > 0 ? Number(o.waitedMs) : 0;

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
        message: c.name + ' did not answer ' + c.healthPath + ' on port ' + c.defaultPort +
          ' within ' + (p.timeoutMs || waited || 0) + 'ms'
      }
    };
  }
  if (p.responding === true) {
    const identityOkNow = p.identityOk !== undefined ? p.identityOk === true : identityMatches(c, p.data);
    if (identityOkNow) return { state: STATE.HEALTHY, reason: null };
    return {
      state: STATE.CONFLICT,
      reason: {
        category: REASON.CONFLICT,
        message: 'port answered ' + c.healthPath + ' but is not ' + c.label + ' (' + c.name + ')'
      }
    };
  }
  return {
    state: STATE.OFFLINE,
    reason: {
      category: REASON.OFFLINE,
      message: c.name + ' is not answering ' + c.healthPath + ' on port ' + c.defaultPort
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
    }, {});
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
  let overall;
  if (!list.length) overall = 'unknown';
  else if (affected.length) overall = 'degraded';
  else if (healthy === 0 && stopped.length === 0) overall = 'unknown';
  else if (healthy === 0) overall = 'stopped';
  else if (stopped.length) overall = 'partial';
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
