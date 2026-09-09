'use strict';

/*
 * Internal Beyond · boot-state contract (P2)
 *
 * A small, stable, machine-readable record of ONE launch attempt, written by
 * `launch-internal-beyond.js` and read by the static server (`GET /__boot-state`)
 * so the future Diagnostics page (P5) consumes a single state model instead of
 * inventing its own.
 *
 * Design rules:
 *   - The record describes the *launcher's* view at the moment it finished:
 *     which components were probed, which are healthy, what is degraded, and
 *     why. It is a boot record, not a live monitor.
 *   - Optional components (Bridge / Active / Vision / restart control) can never
 *     make the app fatal. Only `static` (the thing that serves the main UI) is
 *     required, and it can only fail the launch when it truly cannot serve.
 *   - Never write credentials. `scrub()` drops secret-shaped keys and masks
 *     secret-shaped values on both write and read, so the guarantee holds even
 *     if a probe payload or a hand-edited file tries to smuggle one in.
 *   - Writes are atomic (tmp + fsync + rename) so a reader can never observe
 *     half a JSON document.
 *
 * File location (per-user, writable even when the app dir is read-only):
 *   %LOCALAPPDATA%\InternalBeyond\boot-state.json     (Windows)
 *   ~/.internal-beyond/boot-state.json                (other)
 * Override for tests/troubleshooting: IB_BOOT_STATE_DIR
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ── Contract identity ── */

const SCHEMA = 'internalbeyond.boot-state';
const VERSION = 1;

/* overall / phase vocabulary */
const OVERALL = {
  STARTING: 'starting',
  NORMAL: 'normal',
  DEGRADED: 'degraded',
  FATAL: 'fatal'
};

/* Stable reason categories. P5 may render these; never rename, only add. */
const REASON = {
  NONE: 'none',
  OFFLINE: 'offline',
  CONFLICT: 'conflict',
  TIMEOUT: 'timeout',
  STARTING: 'starting',
  UNKNOWN: 'unknown',
  NOT_ENABLED: 'not-enabled',
  RUNNER_UNAVAILABLE: 'runner-unavailable',
  SPAWN_FAILED: 'spawn-failed',
  PROBE_FAILED: 'probe-failed',
  PORT_CONFLICT: 'port-conflict',
  STATIC_UNAVAILABLE: 'static-unavailable',
  UI_DOCUMENT_UNAVAILABLE: 'ui-document-unavailable',
  LAUNCHER_ERROR: 'launcher-error',
  PERMISSION_DENIED: 'permission-denied',
  PATH_UNAVAILABLE: 'path-unavailable',
  DISK_FULL: 'disk-full',
  WRITE_FAILED: 'write-failed'
};

/* Component order is part of the contract: stable ordering → stable diffs/UI. */
const COMPONENT_ORDER = ['static', 'bridge', 'active', 'restart', 'vision'];

const DEFAULT_STALE_MS = 12 * 60 * 60 * 1000; /* a launch record is "current" for 12h */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ABANDONED_START_MS = 2 * 60 * 1000; /* a 'starting' record older than this never finished */
const MAX_STATE_BYTES = 256 * 1024;
const MAX_STRING = 1000;

/* ── Locations ── */

function stateDir(opts) {
  const o = opts || {};
  if (o.dir) return path.resolve(String(o.dir));
  if (process.env.IB_BOOT_STATE_DIR) return path.resolve(String(process.env.IB_BOOT_STATE_DIR));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'InternalBeyond');
  }
  return path.join(os.homedir(), '.internal-beyond');
}

function stateFile(opts) {
  const o = opts || {};
  if (o.file) return path.resolve(String(o.file));
  return path.join(stateDir(o), 'boot-state.json');
}

/* ── Redaction ── */

const SECRET_KEY_RE = /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|passphrase|authorization|credential|bearer|cookie|private[_-]?key|session[_-]?id|client[_-]?secret)/i;
const SECRET_VALUE_RES = [
  /sk-[A-Za-z0-9_-]{6,}/g,
  /Bearer\s+[A-Za-z0-9._-]{6,}/gi,
  /AIza[A-Za-z0-9_-]{15,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g
];

function maskValue(text) {
  let out = String(text);
  for (const re of SECRET_VALUE_RES) out = out.replace(re, '***');
  return out;
}

/* Return a deep copy with secret-shaped keys removed and secret-shaped values
   masked. Depth- and length-capped so a hostile payload cannot blow up the file. */
function scrub(value, depth) {
  const d = typeof depth === 'number' ? depth : 0;
  if (value == null) return value;
  if (d > 6) return '[truncated]';
  if (typeof value === 'string') return maskValue(value).slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => scrub(v, d + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (SECRET_KEY_RE.test(key)) continue;
      out[key] = scrub(value[key], d + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
}

/* ── Build ── */

function newBootId(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  const p = n => String(n).padStart(2, '0');
  const stamp = d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + p(d.getUTCMilliseconds()) + 'Z';
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return stamp + '-' + rand;
}

function iso(value, fallbackNow) {
  if (value instanceof Date) return value.toISOString();
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  return new Date(fallbackNow == null ? Date.now() : fallbackNow).toISOString();
}

function reasonOf(raw, state) {
  if (raw == null) return { category: state || REASON.UNKNOWN, message: '' };
  if (typeof raw === 'string') return { category: state || REASON.UNKNOWN, message: raw.slice(0, MAX_STRING) };
  return {
    category: String(raw.category || state || REASON.UNKNOWN),
    message: String(raw.message || '').slice(0, MAX_STRING)
  };
}

function normalizeComponent(raw, absent) {
  if (absent) {
    /* A component the caller did not report is simply not part of this launch's
       classification — it must never manufacture a degraded reason. */
    return {
      required: false,
      affectsOverall: false,
      probed: false,
      healthy: false,
      state: REASON.UNKNOWN,
      reason: null
    };
  }
  const r = raw || {};
  const healthy = r.healthy === true;
  const state = (typeof r.state === 'string' && r.state) ? r.state : (healthy ? 'healthy' : REASON.UNKNOWN);
  const out = {
    required: r.required === true,
    affectsOverall: r.affectsOverall !== false,
    probed: r.probed !== false,
    healthy: healthy,
    state: state,
    reason: healthy ? null : reasonOf(r.reason != null ? r.reason : r.message, state)
  };
  const detail = ['port', 'host', 'url', 'identity', 'version', 'reused', 'controlState'];
  for (const key of detail) {
    if (r[key] === undefined || r[key] === null) continue;
    out[key] = typeof r[key] === 'string' ? r[key].slice(0, MAX_STRING) : r[key];
  }
  return out;
}

/*
 * input = {
 *   bootId, now, startedAt, finishedAt, phase, opened,
 *   launcher: { pid, root, platform, arch, node: {path, version, source, bundled, requiredMajor, ok} },
 *   components: { static, bridge, active, restart, vision },
 *   warnings: [{code, message}],
 *   fatal: null | {category, message}
 * }
 */
function buildBootState(input) {
  const i = input || {};
  const now = i.now == null ? Date.now() : i.now;
  const components = {};
  for (const name of COMPONENT_ORDER) {
    const raw = (i.components || {})[name];
    components[name] = normalizeComponent(raw, raw === undefined);
  }

  let fatal = null;
  if (i.fatal) fatal = reasonOf(i.fatal, REASON.LAUNCHER_ERROR);
  if (!fatal && i.phase !== 'starting' && components.static.required && !components.static.healthy) {
    /* Defensive: a required static layer that is not healthy can never be 'normal'. */
    fatal = {
      category: (components.static.reason && components.static.reason.category) || REASON.STATIC_UNAVAILABLE,
      message: (components.static.reason && components.static.reason.message) || 'static layer unavailable'
    };
  }

  const degradedReasons = [];
  for (const name of COMPONENT_ORDER) {
    const c = components[name];
    if (!c.affectsOverall || c.healthy || !c.probed) continue;
    degradedReasons.push({
      component: name,
      category: (c.reason && c.reason.category) || c.state,
      message: (c.reason && c.reason.message) || ''
    });
  }

  let overall;
  if (i.phase === 'starting') overall = OVERALL.STARTING;
  else if (fatal) overall = OVERALL.FATAL;
  else if (degradedReasons.length) overall = OVERALL.DEGRADED;
  else overall = OVERALL.NORMAL;

  const launcher = i.launcher || {};
  const node = launcher.node || {};
  const product = launcher.product || {};
  const mgr = launcher.serviceManager || {};
  const state = {
    schema: SCHEMA,
    version: VERSION,
    bootId: String(i.bootId || newBootId(now)),
    generatedAt: iso(now, now),
    phase: i.phase === 'starting' ? 'starting' : 'complete',
    overall: overall,
    ok: overall !== OVERALL.FATAL,
    opened: i.opened === true,
    degraded: overall === OVERALL.DEGRADED,
    staleAfterMs: Number(i.staleAfterMs) > 0 ? Number(i.staleAfterMs) : DEFAULT_STALE_MS,
    launcher: {
      pid: Number(launcher.pid) || process.pid,
      startedAt: iso(launcher.startedAt, now),
      finishedAt: i.phase === 'starting' ? null : iso(launcher.finishedAt == null ? now : launcher.finishedAt, now),
      root: String(launcher.root || process.cwd()).slice(0, MAX_STRING),
      platform: String(launcher.platform || process.platform),
      arch: String(launcher.arch || process.arch),
      /* P7 single release version source (VERSION). Empty string when the file
         is unreadable — diagnostics must stay honest, never invent a version. */
      product: {
        version: String(product.version || '').slice(0, 40),
        source: String(product.source || 'unknown').slice(0, 40)
      },
      node: {
        path: String(node.path || process.execPath).slice(0, MAX_STRING),
        version: String(node.version || process.version),
        source: String(node.source || 'unknown'),
        bundled: node.bundled === true,
        requiredMajor: Number(node.requiredMajor) > 0 ? Number(node.requiredMajor) : 18,
        ok: node.ok !== false
      },
      /* Whether this launch had to start the Bridge/Active manager itself. */
      serviceManager: {
        state: String(mgr.state || 'unknown'),
        wasRunning: mgr.wasRunning === true,
        startedByLauncher: mgr.started === true,
        error: mgr.error ? reasonOf(mgr.error, REASON.SPAWN_FAILED) : null
      }
    },
    components: components,
    degradedReasons: degradedReasons,
    fatal: fatal,
    warnings: (Array.isArray(i.warnings) ? i.warnings : []).slice(0, 20).map(w => ({
      code: String((w && w.code) || 'warning').slice(0, 120),
      message: String((w && w.message) || '').slice(0, MAX_STRING)
    }))
  };
  return scrub(state);
}

/* ── Atomic write ── */

function writeErrorCategory(err) {
  const code = String((err && err.code) || '');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY') return REASON.PERMISSION_DENIED;
  if (code === 'ENOTDIR' || code === 'ENOENT' || code === 'EISDIR' || code === 'EEXIST') return REASON.PATH_UNAVAILABLE;
  if (code === 'ENOSPC' || code === 'EDQUOT') return REASON.DISK_FULL;
  return REASON.WRITE_FAILED;
}

/* Synchronous sleep — the writer must stay synchronous so callers can never
   interleave two boot-state writes. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback busy wait */ }
  }
}

/* Windows can transiently refuse MoveFileEx over a file another process is
   reading (EPERM/EACCES/EBUSY). Retry the rename a few times before giving up:
   a diagnostics record is never worth failing the launch for. */
const RENAME_RETRIES = 6;
const RENAME_BACKOFF_MS = 25;

/*
 * Atomic: write a sibling temp file, fsync it, then rename over the target.
 * A reader either sees the previous complete document or the new complete one —
 * never a truncated one. Never throws: the caller must be able to ignore the
 * failure and keep launching.
 */
function writeBootState(state, opts) {
  const o = opts || {};
  const file = o.file ? path.resolve(String(o.file)) : stateFile(o);
  const tmp = file + '.' + process.pid + '.tmp';
  const result = { ok: false, path: file, bytes: 0, error: null };
  let json = '';
  try {
    json = JSON.stringify(scrub(state), null, 2);
  } catch (e) {
    result.error = { category: REASON.WRITE_FAILED, message: 'serialize failed: ' + String(e && e.message || e).slice(0, 300) };
    return result;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      try { fs.fsyncSync(fd); } catch (e) { /* fsync unsupported → rename still atomic */ }
    } finally {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
    let lastError = null;
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      try {
        fs.renameSync(tmp, file);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        const code = String(e && e.code || '');
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
        sleepSync(RENAME_BACKOFF_MS);
      }
    }
    if (lastError) throw lastError;
    result.ok = true;
    result.bytes = Buffer.byteLength(json);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    result.error = {
      category: writeErrorCategory(e),
      message: String(e && e.message || e).slice(0, 300)
    };
  }
  return result;
}

/* ── Read + staleness ── */

function readErrorCategory(err) {
  const code = String((err && err.code) || '');
  if (code === 'ENOENT') return 'missing';
  if (code === 'EACCES' || code === 'EPERM') return REASON.PERMISSION_DENIED;
  return REASON.WRITE_FAILED;
}

/*
 * opts = { file|dir, now, expectWebPort }
 * → { ok, present, path, state, ageMs, stale, staleReason, error }
 * `stale:true` means "this record must not be presented as the current launch".
 */
function readBootState(opts) {
  const o = opts || {};
  const file = o.file ? path.resolve(String(o.file)) : stateFile(o);
  const now = Number.isFinite(Number(o.now)) && Number(o.now) > 0 ? Number(o.now) : Date.now();
  const out = {
    ok: false,
    present: false,
    path: file,
    state: null,
    ageMs: null,
    stale: true,
    staleReason: 'missing',
    error: null
  };
  let raw = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_STATE_BYTES) {
      out.error = { category: 'too-large', message: 'boot-state file exceeds ' + MAX_STATE_BYTES + ' bytes' };
      out.staleReason = 'invalid';
      return out;
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    out.error = { category: readErrorCategory(e), message: String(e && e.message || e).slice(0, 300) };
    return out;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    out.error = { category: 'invalid-json', message: 'boot-state is not valid JSON' };
    out.staleReason = 'invalid';
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    out.error = { category: 'invalid-shape', message: 'boot-state is not an object' };
    out.staleReason = 'invalid';
    return out;
  }
  out.ok = true;
  out.present = true;
  out.state = scrub(parsed);

  const generated = Date.parse(String(out.state.generatedAt || ''));
  if (Number.isFinite(generated)) out.ageMs = Math.max(0, now - generated);

  const windowMs = Number(out.state.staleAfterMs) > 0 ? Number(out.state.staleAfterMs) : DEFAULT_STALE_MS;
  let staleReason = null;
  if (!Number.isFinite(generated)) staleReason = 'invalid';
  else if (now - generated < -CLOCK_SKEW_MS) staleReason = 'clock-skew';
  else if (out.state.overall === OVERALL.STARTING && now - generated > ABANDONED_START_MS) staleReason = 'abandoned-start';
  else if (out.ageMs != null && out.ageMs > windowMs) staleReason = 'age';
  else if (o.expectWebPort != null) {
    const port = out.state.components && out.state.components.static && out.state.components.static.port;
    if (Number(port) !== Number(o.expectWebPort)) staleReason = 'web-port-mismatch';
  }
  out.stale = staleReason !== null;
  out.staleReason = staleReason;
  return out;
}

module.exports = {
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  OVERALL: OVERALL,
  REASON: REASON,
  COMPONENT_ORDER: COMPONENT_ORDER,
  DEFAULT_STALE_MS: DEFAULT_STALE_MS,
  stateDir: stateDir,
  stateFile: stateFile,
  newBootId: newBootId,
  scrub: scrub,
  buildBootState: buildBootState,
  writeBootState: writeBootState,
  readBootState: readBootState
};
