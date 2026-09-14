'use strict';

/*
 * Internal Beyond local service runner (Node.js 18+)
 *
 * Keeps the Bridge and Active companion under one parent process, writes
 * readable per-service logs, and offers a small interactive control surface.
 * It deliberately never kills a process it did not spawn: Ctrl+C only stops
 * children started by this runner, so an existing independently-run service
 * remains untouched.
 *
 * Usage:
 *   node local-services-runner.js              # Bridge + Active
 *   node local-services-runner.js --vision     # also start vision helper
 *   node local-services-runner.js --status     # read-only health summary
 *   node local-services-runner.js --json       # machine-readable status
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
/* P11-3B：组件模型与端口/身份探针的单一事实源。这个 runner 只负责"怎么启动"
   （命令、参数、日志、进程句柄）；"有哪些组件、在哪个端口、什么算健康、哪些参与
   重启"一律由 registry 决定，不再在这里手写一份。 */
const registry = require('./component-registry.js');
/* P11-3C：有界崩溃恢复。supervisor 是纯策略引擎（无 fs / 无进程 / 无 HTTP），
   它只决定"该不该再试一次、隔多久、是不是已经锁死"；真正 spawn / kill / probe
   仍然只发生在本文件里。因此恢复行为不需要靠真进程才能测，而有界性可以在没有
   任何子进程的情况下被穷尽验证。 */
const supervisorModule = require('./component-supervisor.js');
/* P11-3H：停止状态机（唯一）。谁算组件、在哪个端口、什么算它的身份都由 registry
   决定；"怎么停止"由 component-lifecycle 决定 —— 本文件与 installer 的
   tools/ib-stop.js 都用它，因此不存在第二套停止语义。停止顺序是
   cooperative request → 有界等待 → 身份重验证后的 fallback kill → 有界等待。 */
const lifecycle = require('./component-lifecycle.js');

/* 恢复策略（P11-3C）。有界由四道独立的闸门保证，任何一道都足以阻止无限重启：
     maxAttempts     滑动窗口内允许的重启次数（有限值，supervisor 会强制夹紧）
     windowMs        计数窗口：一个跑得久的组件不会因为"历史上崩过很多次"被锁死
     base/capBackoff 指数退避，避免持续故障变成满 CPU 热循环
     lockout         预算耗尽 → failed，本进程内**不再**自动重试，只有真实健康证据能解除
   健康驱动的恢复额外要求连续 healthFailStreak 次探测失败：一次慢探测不能重启一个
   正在正常工作的服务。 */
const RECOVERY_POLICY = {
  maxAttempts: 5,
  windowMs: 10 * 60 * 1000,
  baseBackoffMs: 1000,
  maxBackoffMs: 60 * 1000,
  healthFailStreak: 2
};

/* Advanced override, for an operator who wants a TIGHTER bound and for tests that
   cannot wait minutes for a budget to exhaust. It is an env var because there is
   no settings file for the runner, and it is safe to expose because the value can
   only be clamped: the supervisor refuses a non-finite attempt count, caps
   maxAttempts at HARD_MAX_ATTEMPTS and caps its own window. There is no value of
   this variable that produces unbounded recovery. */
function recoveryPolicyFromEnv(value, base) {
  const t = String(value == null ? '' : value).trim();
  if (!t) return base;
  let given = null;
  try { given = JSON.parse(t); } catch (e) { given = null; }
  if (!given || typeof given !== 'object' || Array.isArray(given)) return base;
  /* Only known keys are read; an unknown key is ignored rather than forwarded. */
  const merged = Object.assign({}, base);
  for (const key of Object.keys(base)) {
    if (given[key] !== undefined) merged[key] = given[key];
  }
  return merged;
}

const RECOVERY_POLICY_ACTIVE = recoveryPolicyFromEnv(process.env.IB_RECOVERY_POLICY, RECOVERY_POLICY);

/* Repository root == installed app root. This file lives in runtime/, so the
   root is one level up: the service scripts live in services/, the Windows
   helper scripts in scripts/windows/. `path.basename(ROOT)` is still used for
   the process-matching heuristic below and must stay the project directory. */
const ROOT = path.resolve(__dirname, '..');
const SERVICE_DIR = path.join(ROOT, 'services');
const WINDOWS_DIR = path.join(ROOT, 'scripts', 'windows');
const LOCAL_DIR = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
  : path.join(os.homedir(), '.internal-beyond');
const LOG_DIR = path.join(LOCAL_DIR, 'logs');
const args = new Set(process.argv.slice(2));
const includeVision = args.has('--vision');
const jsonOnly = args.has('--json');
const statusOnly = args.has('--status') || jsonOnly;
const children = [];
/* Tracks the current live child per service name (restart uses the newest
   entry, not the first spawned, so repeated restarts stop the right one). */
const currentChild = {};
/* ── Supervisor wiring (P11-3C) ──
 * One supervisor for this run. Registration is per managed service; eligibility to
 * be recovered is NOT granted here — every event carries `restartable` straight
 * from the registry, which is the only authorization for starting a process. */
const supervisor = new supervisorModule.Supervisor({ policy: RECOVERY_POLICY_ACTIVE });
let recoveryDisabled = false;
/* Hoisted to the top on purpose: runRestart()'s finally block consults it, and a
   `let` declared further down would be in its temporal dead zone if a restart
   ever ran before that line. */
let shuttingDown = false;
/* Components currently being stopped on purpose. The health poll checks this so a
   probe landing mid-stop cannot be read as a failure and start a recovery for a
   component the runner is deliberately taking down. */
const stopping = new Set();

/* ── Silent backend restart (back-end lifecycle management) ──
 * A localhost-only control surface that restarts the Bridge (23115) and
 * Active (23114) backends using the same spawn path below, fully hidden
 * (no console window), with an in-flight guard. Reuses the existing service
 * definitions — it never introduces a second startup configuration. */
const RESTART_HOST = '127.0.0.1';
const RESTART_PORT = optionPort('IB_RESTART_PORT', 23116);
const RESTART_SERVER_NAME = 'InternalBeyond Restart';
/* P11-3X-B: ports this run refused to start into, keyed by component id. Reported
   on the component row so "offline" can carry the reason it is offline. Reset by a
   control-plane restart, which re-runs the same preflight. */
const portConflicts = {};

fs.mkdirSync(LOG_DIR, { recursive: true });

function optionPort(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

/* ── Service definitions, derived from the component registry ──
 *
 * The registry owns id / display name / port / health path / identity predicate
 * / required semantics. What remains HERE is exactly the part a registry cannot
 * know: which command to run, and how to run it. Ports are derived at process
 * start, so a port override (IB_*_PORT) affects the runner, the launcher and the
 * server identically.
 *
 * `process.execPath` stays the launch mechanism (P2 discipline): the services
 * must run on the exact same Node as the runner, bundled or not. */
const SERVICE_LAUNCH = {
  bridge: {
    command: process.execPath,
    commandArgs: [path.join(SERVICE_DIR, 'ib-bridge-service.js')],
    env: {}
  },
  active: {
    command: process.execPath,
    commandArgs: [path.join(SERVICE_DIR, 'active-message-service.js')],
    env: {}
  },
  /* M1-A：Home Node —— chatMessages 的 canonical authority。
     桌面**总是**用默认 HOST 启动它（env: {}），即 127.0.0.1 —— 远端来源一律拒绝。
     LAN 模式（M1-B 设备身份 / M1-C Android 客户端）只能由用户显式设置
     IB_HOME_NODE_HOST 打开，且还要求设备鉴权真的就绪（见 D21）。
     它的失败必须是 degraded 而不是 fatal：browser 侧 home-node-client 把
     "不在线" 判为可回退状态，桌面主 UI 不受影响。 */
  homeNode: {
    command: process.execPath,
    commandArgs: [path.join(SERVICE_DIR, 'home-node-service.js')],
    env: {}
  },
  vision: {
    command: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'sh',
    commandArgs: process.platform === 'win32'
      ? ['/d', '/c', path.join(WINDOWS_DIR, 'start-vision-service.cmd')]
      : ['-lc', 'echo "Vision helper is currently provided by start-vision-service.cmd on Windows."; exit 1'],
    env: {}
  }
};

function buildServiceSpec(component) {
  const launch = SERVICE_LAUNCH[component.id] || {};
  return {
    name: component.name,
    componentId: component.id,
    label: component.label,
    port: registry.portOf(component.id),
    endpoint: component.healthPath,
    command: launch.command,
    commandArgs: launch.commandArgs || [],
    matchesHealth: component.matchesHealth,
    /* P11-3H：停止目标逐字来自 registry（端口 / 健康路径 / 身份谓词 / 停止路径）。
       runner 与 installer 用同一份描述停止同一个组件，所以"runner 停得了但 installer
       停不了"这种漂移在结构上不再可能。 */
    lifecycleTarget: {
      id: component.id,
      name: component.name,
      label: component.label,
      port: registry.portOf(component.id),
      healthPath: component.healthPath,
      stopPath: component.stopPath || null,
      matchesHealth: component.matchesHealth
    },
    /* Recovery authorization travels WITH the spec, taken from the registry at
       construction time (P11-3C). Re-derived here rather than re-declared: there
       is no second list of "which components may be restarted". */
    restartable: component.restartable === true,
    managedByRunner: component.managedByRunner === true,
    env: launch.env || {}
  };
}

/* Vision is opt-in: it is only registered (and therefore only ever started,
   probed or stopped) when --vision is passed. Every other managed component is
   always registered. */
function servicesForRun() {
  const list = registry.managed().filter(c => c.id !== 'vision' || includeVision);
  return list.map(buildServiceSpec);
}

const SERVICES = servicesForRun().map(function (spec) {
  /* A managed component that is NOT restartable (Vision today) is still
     registered with the supervisor so its state is reported honestly; it simply
     never receives an attempt, because every event carries restartable:false. */
  supervisor.register(spec.componentId, spec.label || spec.name);
  return spec;
});

/* The restart control plane's targets come from the registry, not from a second
   hand-written list. P11-3B fixed a real drift here: this used to be
   `name === 'Bridge' || name === 'Active'`, so Home Node was never restarted by
   the control plane that claims to restart the local services. */
const RESTART_TARGET_IDS = registry.restartTargets().map(c => c.id);

function requestJson(port, endpoint, timeoutMs) {
  const startedAt = Date.now();
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (settled) return; settled = true; resolve(value); };
    const req = http.get({ host: '127.0.0.1', port, path: endpoint, timeout: timeoutMs || 1800 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
        done({
          responding: true,
          timedOut: false,
          healthy: res.statusCode >= 200 && res.statusCode < 300 && !!(data && data.ok),
          status: res.statusCode,
          data,
          startedAt: startedAt,
          tookMs: Date.now() - startedAt
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      done({ responding: false, timedOut: true, healthy: false, status: 0, data: null, startedAt: startedAt, tookMs: Date.now() - startedAt });
    });
    req.on('error', () => done({ responding: false, timedOut: false, healthy: false, status: 0, data: null, startedAt: startedAt, tookMs: Date.now() - startedAt }));
  });
}

async function serviceStatus(service) {
  const health = await requestJson(service.port, service.endpoint);
  const identityMatches = health.healthy && (!service.matchesHealth || service.matchesHealth(health.data));
  /* Runner-side process tracking (P11-3B): what this runner itself did.
     `owned` means "started by this process", not "healthy" — a runner-owned
     child can have exited and a foreign instance can be perfectly healthy. */
  const entry = currentChild[service.name] || null;
  return {
    name: service.name,
    componentId: service.componentId || null,
    label: service.label || service.name,
    port: service.port,
    online: identityMatches,
    conflict: health.responding && !identityMatches,
    status: health.status,
    version: health.data && (health.data.version || health.data.serviceVersion) || '',
    details: health.data || null,
    responding: health.responding === true,
    timedOut: health.timedOut === true,
    tookMs: health.tookMs,
    respondedAt: health.startedAt,
    owned: !!(entry && !entry.exited),
    pid: entry && entry.pid ? entry.pid : null,
    exits: entry ? entry.exits : 0,
    startedAt: entry ? entry.startedAt : null
  };
}

async function allStatus() {
  return Promise.all(SERVICES.map(serviceStatus));
}

/* `rows` is the legacy service table (unchanged shape, plus the P11-3B process
   fields). `components` is the registry-wide aggregate and the machine-readable
   truth for other tools: launcher, diagnostics and tests. */
function printStatus(rows, components) {
  const agg = components && components.aggregated ? components.aggregated : null;
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(Object.assign({
      ok: true,
      services: rows
    }, components || {}), null, 2) + '\n');
    return;
  }
  console.log('\nInternal Beyond local services');
  rows.forEach(row => {
    const state = row.online ? 'online' : (row.conflict ? 'conflict' : 'offline');
    const extra = row.online && row.version ? ' · v' + row.version : '';
    console.log('  ' + row.name.padEnd(9) + state.padEnd(8) + '127.0.0.1:' + row.port + extra);
  });
  if (agg) {
    console.log('\n  components (' + agg.updatedAt + ') · ' + agg.overall);
    for (const c of agg.components) {
      const detail = c.state === 'healthy' ? '' :
        (c.reason && c.reason.category ? ' · ' + c.reason.category : '');
      /* Recovery axis (P11-3C): what the runner is doing about this component,
         which is a different question from what the probe observed. Shown only
         when this process owns the supervisor (a detached --json has none). */
      const rec = c.recoveryState
        ? ' · recover:' + c.recoveryState +
          (c.restartCount ? '×' + c.restartCount : '') +
          (c.recoveryLockedOut ? ' (locked out)' : '')
        : '';
      /* P11-3X-B: if this run refused to start into an occupied port, say who holds
         it. Otherwise the line reads "offline" and an operator has to guess between
         "it crashed" and "something else owns the port". */
      const owner = c.portOwner ? ' · port-owner:' + c.portOwner + (c.portOwnerPids ? '(' + c.portOwnerPids.join(',') + ')' : '') : '';
      console.log('    ' + String(c.id).padEnd(9) + String(c.state).padEnd(12) +
        (c.affectsOverall ? '' : '(informational)') + detail + owner + rec);
    }
    console.log('  running: ' + (agg.running.join(',') || 'none') +
      ' · stopped: ' + (agg.stopped.join(',') || 'none') +
      ' · affected: ' + (agg.affected.join(',') || 'none'));
  }
  console.log('  Logs: ' + LOG_DIR + '\n');
}

/* ── Redaction: never let secrets / full command lines reach logs or UI ── */
function redact(text) {
  let out = String(text == null ? '' : text);
  /* Keep the key label readable, mask the value. */
  out = out.replace(/(\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|bearer|authorization|x-ib-token|openai[_-]?key)\b\s*[:=]\s*)(['"]?)[^\s,'";]{4,}/gi,
    (m, p1, p2) => p1 + (p2 || '') + '***' + (p2 || ''));
  /* Bare credential tokens are masked entirely (never echoed). */
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, '****');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._-]{6,}\b/gi, (m, p1) => p1 + '****');
  out = out.replace(/\b(AIza[A-Za-z0-9_-]{15,})\b/g, '****');
  /* Never echo a full command line / spawn args. */
  out = out.replace(/(?:node(?:\.exe)?[^\r\n]*?(?:ib-bridge-service|active-message-service|local-services-runner)[^\r\n]*)/gi, '[script]');
  return out;
}
function appendRestartLog(msg) {
  const line = '[' + new Date().toISOString() + '] ' + redact(msg);
  try { fs.appendFileSync(path.join(LOG_DIR, 'restart.log'), line + '\n'); } catch (e) { /* logging must never take down services */ }
}

/* ── Port / process helpers (local management; fixed commands, no user input) ── */
function pidsForPort(port) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      const cmd = [ '-NoProfile', '-NonInteractive', '-Command',
        '$p=(Get-NetTCPConnection -LocalPort ' + Number(port) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ","; Write-Output $p' ];
      execFile('powershell.exe', cmd, { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        const pids = String(stdout || '').trim().split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
        resolve(pids);
      });
    } else {
      /* POSIX fallback (kept simple; the feature targets Windows). */
      execFile('sh', ['-c', '(netstat -tlnp 2>/dev/null || true) | grep ":' + Number(port) + '" | awk \'{print $7}\' | cut -d/ -f1'], { timeout: 6000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        const pids = String(stdout || '').trim().split(/\s+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
        resolve(pids);
      });
    }
  });
}
function processCommandline(pid) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') { resolve(String(process.platform)); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}
/* Is this command line an Internal Beyond instance of `scriptFile`?
 *
 * Two independent confirmations, as before: the expected script name must appear,
 * AND the invocation must be rooted in this repository/installation. P11-3X-B adds
 * the second *form* of "rooted here": this runner spawns children with absolute
 * paths, but a developer, a test or the installer may launch the very same file as
 * `node runtime/local-services-runner.js` — and a command line never contains a
 * working directory, so the absolute-path test alone called our OWN second runner
 * "foreign". Measured: runner B against runner A's control port was reported as
 * `control-plane-foreign`.
 *
 * The relative form therefore also has to show the script's own parent segment
 * (`runtime/`, `services/`) next to its name. Both forms still require an
 * IB-specific script name, so this is a heuristic about our own files — it was
 * never a security boundary, because a command line is controlled by whoever
 * started the process. */
function commandMatchesScript(commandLine, scriptFile) {
  const cl = String(commandLine || '');
  const full = String(scriptFile || '');
  if (!cl || !full) return false;
  const script = path.basename(full);
  if (!script || cl.indexOf(script) < 0) return false;
  if (cl.indexOf(path.basename(ROOT)) >= 0) return true;
  const parent = path.basename(path.dirname(full));
  if (!parent) return false;
  const quote = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* The pair `parent/script` must appear as a whole path fragment: preceded by a
     separator, a space, a quote or the start of the command line (a command line
     never contains a working directory, so `node runtime/x.js` starts the argument
     with the parent segment), and followed by a space, a quote or the end. */
  return new RegExp('(^|[\\s"\'\\\\/])' + quote(parent) + '[\\\\/]' + quote(script) + '([\\s"\']|$)').test(cl);
}

function processMatchesService(pid, service) {
  return new Promise(resolve => {
    processCommandline(pid).then(cl => resolve(commandMatchesScript(cl, service.commandArgs[0])));
  });
}

/* ── Port ownership (P11-3X-B) ────────────────────────────────────────────
 *
 * Who holds a port, asked BEFORE anything is spawned. This is not a second
 * ownership ruleset: it is the same two existing predicates the stop path has used
 * since P11-3B — the OS's listener list (`pidsForPort`) plus "is that process one
 * of ours" (`processCommandline` against this repo and the expected script). What
 * P11-3X-B adds is asking the question *early* and giving the answer a name, so an
 * occupied port is a diagnosis instead of a random child that dies with
 * EADDRINUSE three lines later.
 *
 * Five outcomes, and the two that must never be conflated are FOREIGN and UNKNOWN:
 *
 *   free              nothing is listening
 *   self              this runner's own live child already holds it
 *   owned-component   a VERIFIED Internal Beyond process holds it (our repo path
 *                     and the expected script name both appear in its command line)
 *   foreign           a process is listening and is verifiably not ours
 *   unknown           a process is listening and we could not read its command line
 *
 * UNKNOWN is deliberately not folded into FOREIGN. "I could not identify it" is
 * not evidence that it is somebody else's, and the only action this classification
 * ever authorizes is a kill — so an unreadable command line must fail safe. It
 * does: neither FOREIGN nor UNKNOWN is ever killed. */
const PORT_OWNER = {
  FREE: 'free',
  SELF: 'self',
  OWNED_COMPONENT: 'owned-component',
  FOREIGN: 'foreign',
  UNKNOWN: 'unknown'
};

async function classifyPortOwner(port, scriptFile) {
  const pids = await pidsForPort(port);
  if (!pids.length) return { owner: PORT_OWNER.FREE, pids: [] };
  const ours = [];
  const others = [];
  for (const pid of pids) {
    const commandLine = await processCommandline(pid);
    if (!commandLine) {
      /* An unreadable command line is `unknown`, never `foreign`: we have no
         evidence either way, and the fail-safe direction is not to act. */
      return {
        owner: PORT_OWNER.UNKNOWN, pids: pids,
        reason: 'a process holds the port but its command line could not be read'
      };
    }
    if (commandMatchesScript(commandLine, scriptFile)) ours.push(pid);
    else others.push(pid);
  }
  if (ours.length && !others.length) return { owner: PORT_OWNER.OWNED_COMPONENT, pids: ours };
  /* A mixed set is reported as foreign: refusing is the safe answer, and one
     verified stranger on the port means the port is not uncontested. */
  return {
    owner: PORT_OWNER.FOREIGN, pids: others.concat(ours),
    reason: 'the port is held by a process that is not an Internal Beyond ' + path.basename(String(scriptFile || 'service'))
  };
}

/* The restart control plane's own identity, probed exactly like a component:
   identity is the JSON that names it, not "something answered". */
function probeControlPlane(port) {
  return requestJson(port, '/status', 1200).then(function (health) {
    const identity = !!(health.data && health.data.service === RESTART_SERVER_NAME);
    return { responding: health.responding === true, identity: identity, status: health.status, data: health.data };
  });
}
function killPid(pid) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/F', '/T', '/PID', String(Number(pid))], { windowsHide: true, timeout: 6000 }, () => resolve());
    } else {
      try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { }
      resolve();
    }
  });
}

/* Can this process bind the port right now? This is the cheap, authoritative
   "is it free" question — Node's own kernel answer, no shelling out. It is asked
   BEFORE the expensive ownership classification, because the common case is a free
   port and paying two PowerShell calls per launch for it would be a tax on every
   startup. A listening socket closed before accepting a connection leaves no
   TIME_WAIT, so probing is free of side effects; and because the port can still be
   taken in the window between this answer and the real bind, every caller keeps a
   bind-error path. */
function portBindable(port, host) {
  const bindHost = host || RESTART_HOST;
  return new Promise(resolve => {
    const probe = net.createServer();
    let settled = false;
    const done = value => { if (settled) return; settled = true; resolve(value); };
    probe.once('error', () => { try { probe.close(); } catch (e) { /* 未监听 */ } done(false); });
    try {
      probe.listen(port, bindHost, () => { probe.close(() => done(true)); });
    } catch (e) { done(false); }
  });
}

function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const probe = () => {
      if (Date.now() > deadline) { resolve(true); return; }
      const sock = net.connect({ host: '127.0.0.1', port: port, timeout: 300 });
      let settled = false;
      const done = bound => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) { } resolve(bound); };
      sock.on('connect', () => { done(false); });
      sock.on('timeout', () => { done(true); });
      sock.on('error', () => { done(true); });
    };
    probe();
  }).then(free => {
    if (free) return true;
    return new Promise(r => setTimeout(r, 200)).then(() => waitPortFree(port, deadline - Date.now()));
  });
}

async function stopService(service, opts) {
  const o = opts || {};
  /* 0. This stop is INTENTIONAL (P11-3C). Recording the intent before killing is
        what lets the exit handler tell a deliberate stop apart from a crash —
        without it, every shutdown and every control-plane restart would look like
        a crash and would be "recovered" into a process nobody asked for. The
        supervisor is told too, so the state is `stopped` rather than `recovering`. */
  const entry = currentChild[service.name];
  stopping.add(service.componentId);
  if (entry) entry.stopIntent = 'intentional';
  supervisor.handle(service.componentId, supervisorModule.EVENT.STOP, { at: Date.now() });
  /* 1. Cooperative stop FIRST (P11-3H).
        Until P11-3H this step was `entry.child.kill('SIGTERM')`, which on Windows
        is TerminateProcess: the child's own stop handler never runs, so its
        canonical stores are never closed and "did this component stop cleanly?"
        cannot be answered (measured: real Home Node gone in 0ms with a 440 KB
        WAL still on disk and no `{"event":"shutdown"}` line).
        Now the child is asked to stop over its own loopback port — the channel
        that already exists — and the kill is a bounded, identity-re-verified
        fallback performed by the shared state machine in
        runtime/component-lifecycle.js. The same state machine is what the
        installer's tools/ib-stop.js runs, so there is one stop contract.
        A child this runner spawned is proven-ours by construction (`provenOwn`),
        so no command-line heuristic is needed here. */
  let outcome = null;
  try {
    outcome = await lifecycle.stopComponent(service.lifecycleTarget, Object.assign({}, o, {
      /* `provenOwn` says "this runner started this component"; the command-line
         predicate is passed too, because the fallback kill still has to
         re-establish what it is about to kill — a port can change hands while a
         stop is in flight, and a kill on a stale pid is the failure mode the
         whole identity rule exists to prevent. This is the runner's own existing
         predicate (runtime/local-services-runner.js `commandMatchesScript`), not
         a second heuristic. */
      provenOwn: true,
      ownsCommandLine: (cmdline, root) => commandMatchesScript(cmdline, service.commandArgs[0]),
      root: ROOT
    }));
  } catch (e) {
    appendRestartLog(service.name + ' cooperative stop failed: ' + redact(String(e && e.message || e)).slice(0, 200));
  }
  /* 2. Any remaining process bound to the port that matches our service script
        (covers services started outside this runner). Only ever kills verified
        Internal Beyond service processes — never an arbitrary process. */
  if (!outcome || !outcome.verified || outcome.verified.portFree !== true) {
    const pids = await pidsForPort(service.port);
    for (const pid of pids) {
      if (await processMatchesService(pid, service)) await killPid(pid);
    }
  }
  stopping.delete(service.componentId);
  appendRestartLog('stopping ' + service.name + ' intentionally (port ' + service.port + ')' +
    (outcome ? (' → ' + outcome.state + (outcome.accepted ? ' (cooperative)' : '') +
      (outcome.fallbackKills ? ' fallback-kills=' + outcome.fallbackKills : '')) : ' (no lifecycle outcome)'));
  return outcome;
}

/* ── Health aggregation (P11-3B · live view) ──
 *
 * One live view over the registry: which components run, which are stopped,
 * which are in an error/conflict state, which are not enabled here, when this
 * view was built, and whether the runner itself owns a process for each one.
 *
 * This section is still pure observation: it starts nothing, stops nothing and
 * retries nothing. P11-3C's bounded recovery lives below (recoverService), not
 * here — the view REPORTS what that does, and the supervisor is told about probe
 * outcomes, but building a health view never causes an action. That separation is
 * what makes /components safe to call from a diagnostics page.
 *
 * Two evidence sources are joined and both are reported, because they can
 * legitimately disagree:
 *   · the probe   → is it answering, and is it really ours
 *   · the runner  → did THIS process start a child for it, and is that child alive
 *
 * `--probe-web` additionally includes the static layer (23120), which this
 * runner does not manage but every component model must describe. It is off by
 * default so a plain `--status` never touches a port nobody asked about.
 */
function findServiceSpec(componentId) {
  return SERVICES.find(s => s.componentId === componentId) || null;
}

function probeErrorReport(component, message, port) {
  return registry.componentReport(component, {
    port: port,
    state: registry.STATE.UNKNOWN,
    reason: { category: registry.REASON.PROBE_FAILED, message: message },
    probed: true,
    reachable: false,
    identityOk: false
  });
}

async function componentHealth(component, rows, opts) {
  const o = opts || {};
  const port = registry.portOf(component.id);
  const service = findServiceSpec(component.id);
  if (service) {
    const row = (rows || []).find(r => r && r.name === component.name);
    if (!row) {
      return probeErrorReport(component, component.name + ' has no probe row in this run', port);
    }
    const classified = registry.classifyProbe(component, {
      responding: row.responding,
      timedOut: row.timedOut,
      status: row.status,
      data: row.details,
      identityOk: row.online === true
    }, { port: port, timeoutMs: row.tookMs });
    const note = row.owned
      ? (row.exits > 0
        ? 'started by this runner; ' + row.exits + ' exit event(s) observed, recovery state above'
        : 'started by this runner')
      : (row.online ? 'reused: already running and not started by this runner' : null);
    /* P11-3X-B: if this run refused to start into an occupied port, the class of the
       occupant travels with the report. It is a SEPARATE field, not folded into
       `note`: `note` already carries "who started this" and overwriting it would
       destroy that answer to gain this one. */
    const conflict = portConflicts[component.id] || null;
    return registry.componentReport(component, {
      port: port,
      state: classified.state,
      reason: classified.reason,
      probed: true,
      reachable: row.responding,
      identityOk: row.online === true,
      timedOut: row.timedOut,
      statusCode: row.status,
      tookMs: row.tookMs,
      respondedAt: row.respondedAt,
      probedAt: row.respondedAt,
      startedAt: row.startedAt,
      pid: row.pid,
      version: row.version,
      details: row.details,
      note: note,
      portOwner: conflict ? conflict.owner : null,
      portOwnerPids: conflict ? conflict.pids : null,
      portOwnerReason: conflict ? conflict.reason : null
    });
  }
  /* A managed component that this run did not register (Vision without
     --vision). Reporting it as "not enabled" is the honest answer; reporting it
     as offline would be a lie about a component the user never asked for. */
  if (component.managedByRunner) {
    return registry.notEnabled(component, component.label + ' is opt-in and was not enabled for this run');
  }
  /* The static layer is managed by the launcher, and probing it means opening a
     socket to a port nobody asked about. It is strictly opt-in (--probe-web /
     probeWeb:true); otherwise it is reported as unobserved, which is the honest
     answer for a component this view has not looked at. */
  if (component.id === 'static' && o.probeWeb !== true) {
    return registry.componentReport(component, {
      port: port,
      state: registry.STATE.UNKNOWN,
      probed: false,
      reachable: false,
      identityOk: false,
      note: 'the static layer is managed by the launcher; pass --probe-web to include its live state'
    });
  }
  return registry.probeComponent(component, { port: port, host: '127.0.0.1' });
}

async function liveHealth(opts) {
  const o = opts || {};
  const rows = Array.isArray(o.rows) ? o.rows : await allStatus();
  const components = [];
  for (const component of registry.COMPONENTS) {
    /* eslint-disable no-await-in-loop -- bounded sequential probe: six local
       HTTP probes at most, and parallelism here would only make a degraded
       port answer slower to diagnose. */
    components.push(await componentHealth(component, rows, o));
  }
  const aggregated = registry.aggregate(components, { now: o.now });
  aggregated.checkedAt = aggregated.updatedAt;
  /* Recovery state is answered ONLY by the process that owns the supervisor. A
     detached `--json` invocation has no recovery state at all, so it reports the
     four contract fields as null rather than claiming every component is
     `stopped` — absence of knowledge must not be dressed up as knowledge. */
  if (o.withRecovery !== false) {
    for (const component of components) supervisor.decorate(component);
  } else {
    for (const component of components) {
      component.recoveryState = null;
      component.restartCount = null;
      component.lastRestartAt = null;
      component.lastFailureReason = null;
    }
  }
  return {
    ok: true,
    service: RESTART_SERVER_NAME,
    serviceState: shutdownState.requested ? 'shutting-down' : restartState.state,
    restartTargets: RESTART_TARGET_IDS.slice(),
    /* The P11-3B wording ("nothing here ever recovers anything") stopped being
       true in P11-3C, and a status view that lies about its own capabilities is
       worse than one that is merely terse. The bound is stated instead. */
    warning: 'recovery is bounded: restarts are budgeted, backed off and locked out; this view never starts or stops anything itself',
    recovery: {
      schema: supervisorModule.SCHEMA,
      version: supervisorModule.VERSION,
      policy: supervisor.policySnapshot(),
      /* Reported per component only when this process owns the supervisor. */
      observed: o.withRecovery !== false,
      states: componentRecoverySummary(components)
    },
    services: rows,
    components: components,
    aggregated: aggregated
  };
}

/* Counts by recovery state, so a caller can answer "is anything recovering or
   locked out right now" without walking the component list. */
function componentRecoverySummary(components) {
  const summary = { healthy: 0, starting: 0, stopped: 0, recovering: 0, failed: 0 };
  for (const c of components || []) {
    const state = c.recoveryState;
    if (state && Object.prototype.hasOwnProperty.call(summary, state)) summary[state] += 1;
  }
  return summary;
}
/* ── Restart state machine (idle → restarting → ready | failed) ── */
const restartState = { state: 'idle', lastError: '', startedAt: 0, restartCount: 0, lastRestartAt: null };
/* P7: a graceful stop requested through the control plane (installer upgrade /
   uninstall). Kept separate from the restart state so a stop can never be
   mistaken for an in-flight restart. */
const shutdownState = { requested: false };
/* P11-3H: what the last bounded stop cycle actually did, per component. Read
   only, in-memory, and never a secret: component ids, the state machine's own
   state names, pids the OS gave us, and reason strings that were already
   redacted on the way in. It exists so "the runner said it was stopping" can be
   checked against "here is what stopped", instead of inferred from a log. */
const lastShutdown = { at: null, requestedAt: null, budgetMs: null, components: [], complete: null };

function restartRunning() {
  return restartState.state === 'restarting';
}

/* P11-3C: an operator restart cycle is the control plane's; the supervisor's own
   bounded recovery runs through recoverService() below and reports through the
   health view instead. Keeping them apart is why a recovery attempt can never be
   reported as a failed USER restart. */

async function runRestart() {
  restartState.state = 'restarting';
  restartState.startedAt = Date.now();
  restartState.lastError = '';
  appendRestartLog('restart requested');
  /* P11-3C: a control-plane restart takes every target down ON PURPOSE. Pending
     automatic recoveries are dropped for the cycle (a scheduled attempt that
     fired mid-restart would spawn a second process for a port the cycle is
     already bringing up), and the exits it causes are marked intentional below,
     so none of them is mistaken for a crash. Recovery resumes when the cycle
     ends — it is suspended, never disabled for the life of the process. */
  const resumeRecovery = recoveryDisabled === false;
  recoveryDisabled = true;
  recoveryGeneration += 1;
  cancelRecoveryTimers();
  try {
    const targets = SERVICES.filter(s => RESTART_TARGET_IDS.indexOf(s.componentId) >= 0);
    /* stop → confirm old processes exit → release ports → start → health → ready */
    for (const service of targets) await stopService(service);
    for (const service of targets) await waitPortFree(service.port, 10000);
    const launched = [];
    for (const service of targets) {
      spawnService(service);
      launched.push(service);
    }
    for (const service of launched) {
      const healthy = await waitUntilHealthy(service, 25000);
      if (!healthy) throw new Error(service.name + ' did not become healthy');
      appendRestartLog(service.name + ' ready');
    }
    /* An operator restart is real recovery evidence: clear stale failure state,
       but do NOT wipe the bounded attempt budget — a manual restart that keeps
       failing must still hit the same wall as an automatic one. */
    targets.forEach(function (service) { supervisor.noteOperatorRestart(service.componentId); });
    for (const service of launched) supervisor.noteHealthy(service.componentId);
    restartState.state = 'ready';
    restartState.restartCount += 1;
    restartState.lastRestartAt = Date.now();
    appendRestartLog('restart complete');
  } catch (e) {
    restartState.state = 'failed';
    restartState.lastError = redact(String(e && e.message || e)).slice(0, 300);
    appendRestartLog('restart failed: ' + restartState.lastError);
  } finally {
    if (resumeRecovery && !shuttingDown) recoveryDisabled = false;
  }
}

/*
 * P7 graceful stop: used by the Windows installer before it replaces files on
 * upgrade/uninstall. Reuses the exact same verified stop path as restart —
 * stopService() only ever terminates a process whose command line contains both
 * this project directory and the service script, so an unrelated node.exe on
 * the machine is never touched. Bounded waits; then this runner exits.
 *
 * P11-3H: "the exact same verified stop path" is now literally true — both
 * paths call stopService(), whose first step is a cooperative stop request
 * (POST /__shutdown on the component's own port) with a bounded, re-verified
 * kill as the fallback. Before this, the first step was `child.kill('SIGTERM')`,
 * which on Windows is TerminateProcess: the components were killed, not stopped,
 * and none of their stores were closed.
 */
async function runShutdown() {
  appendRestartLog('shutdown requested');
  /* P11-3C: stop recovering FIRST. A graceful shutdown kills every child on
     purpose, and without this the exit handler would read each of those deaths as
     a crash and start restarting services the installer is trying to replace. */
  recoveryDisabled = true;
  cancelRecoveryTimers();
  const outcomes = [];
  /* One shared budget for the whole stop, divided across the components, so a
     single component that refuses to stop cannot spend every other component's
     time — and so the installer's own helper budget cannot be overrun. */
  const budgetMs = Number(process.env.IB_SHUTDOWN_BUDGET_MS) > 0
    ? Number(process.env.IB_SHUTDOWN_BUDGET_MS) : 12000;
  const deadline = Date.now() + budgetMs;
  lastShutdown.requestedAt = Date.now();
  lastShutdown.budgetMs = budgetMs;
  try {
    for (let i = 0; i < SERVICES.length; i += 1) {
      const service = SERVICES[i];
      const remaining = Math.max(0, deadline - Date.now());
      /* The same per-target budget the installer helper uses, so a component
         cannot get one amount of cooperative time from the runner and another
         from the installer. The floor is raised here because the runner owns
         this cycle and knows how many components it has; the TOTAL is still the
         budget above. */
      const budget = lifecycle.targetBudget(remaining, SERVICES.length - i, { perTargetFloorMs: 1500, discoveryMs: 1000 });
      const outcome = await stopService(service, {
        deadline: Math.min(deadline, Date.now() + budget.deadlineMs),
        cooperativeMs: budget.cooperativeMs,
        fallbackMs: budget.fallbackMs
      });
      if (outcome) outcomes.push({ id: service.componentId, state: outcome.state, accepted: outcome.accepted });
    }
    for (const service of SERVICES) await waitPortFree(service.port, 10000);
    const notStopped = outcomes.filter(o => o.state !== 'STOPPED' && o.state !== 'NOT_RUNNING');
    lastShutdown.components = outcomes;
    lastShutdown.complete = notStopped.length === 0;
    lastShutdown.at = Date.now();
    if (notStopped.length) {
      appendRestartLog('shutdown incomplete: ' +
        notStopped.map(o => o.id + '=' + o.state).join(', '));
    }
  } catch (e) {
    lastShutdown.at = Date.now();
    lastShutdown.complete = false;
    lastShutdown.error = redact(String(e && e.message || e)).slice(0, 300);
    appendRestartLog('shutdown error: ' + lastShutdown.error);
  }
  appendRestartLog('shutdown complete' + (outcomes.length ? ' (' +
    outcomes.map(o => o.id + '=' + o.state).join(', ') + ')' : ''));
  shutdown(0);
}

/* Drop every pending recovery attempt. Used by shutdown and by the control
   plane's restart, both of which take components down on purpose. */
function cancelRecoveryTimers() {
  Object.keys(recoveryTimers).forEach(function (id) {
    clearTimeout(recoveryTimers[id]);
    delete recoveryTimers[id];
  });
}

/* ── Restart control server (localhost-only; Origin guard) ── */function restartOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true; /* loopback / non-browser local call */
  if (origin === 'null') return true; /* file:// */
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:') return true;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const host = String(u.hostname).toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    }
  } catch (e) { /* illegal origin → deny */ }
  return false;
}
function acaOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin === 'null') return 'null';
  if (origin && restartOriginAllowed(req)) return origin;
  return null;
}
function sendJsonRes(res, status, obj, allowedOrigin) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
  if (allowedOrigin) headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
  if (allowedOrigin) headers['Access-Control-Allow-Headers'] = 'Content-Type';
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

/* ── Control-plane preflight (P11-3X-B) ───────────────────────────────────
 *
 * The control plane must come up BEFORE the services (P11-3C, and that stays), but
 * it must also come up *or not at all*. Before this, `server.listen()`'s failure was
 * written to a log file and the run continued: measured, a runner whose control port
 * was held by a foreign listener went on to spawn and manage Bridge, Active and Home
 * Node while its own /status, /restart and /shutdown were unreachable — a runner with
 * live children and no way to stop them. The same run also printed an ordinary
 * component table, so an operator reading stdout saw a working start. (The only
 * trace was restart.log: "restart control server error: listen EADDRINUSE".)
 *
 * So the question "who holds the control port?" is now asked before anything is
 * spawned, and every answer other than `free` is a refusal with a reason:
 *
 *   free                         → bind and continue (the normal case)
 *   own, answering, right name   → another runner already owns it. This process
 *                                  must not become a second supervisor: it would
 *                                  have no control plane and would fight the first
 *                                  one over every component.
 *   own, not answering           → a stale runner still holds the port. Refusing is
 *                                  the defined policy: killing it would kill the
 *                                  children it owns, and "which runner is real" is
 *                                  the operator's decision, not this process's.
 *   foreign / unknown            → refuse. Nothing is ever killed here.
 */
async function ensureControlPlane() {
  if (await portBindable(RESTART_PORT, RESTART_HOST)) {
    return startRestartServer();
  }
  const owner = await classifyPortOwner(RESTART_PORT, path.join(__dirname, 'local-services-runner.js'));
  if (owner.owner === PORT_OWNER.OWNED_COMPONENT) {
    const probe = await probeControlPlane(RESTART_PORT);
    if (probe.responding && probe.identity) {
      return {
        ok: false, reason: 'control-plane-already-running', owner: owner.owner,
        detail: 'another Internal Beyond runner already owns ' + RESTART_HOST + ':' + RESTART_PORT
      };
    }
    return {
      ok: false, reason: 'control-plane-own-stale', owner: owner.owner,
      detail: 'a runner process holds ' + RESTART_HOST + ':' + RESTART_PORT + ' but does not answer /status'
    };
  }
  return {
    ok: false,
    reason: owner.owner === PORT_OWNER.UNKNOWN ? 'control-plane-unknown-owner' : 'control-plane-foreign',
    owner: owner.owner,
    detail: owner.reason || ('port ' + RESTART_HOST + ':' + RESTART_PORT + ' is held by another process')
  };
}

function startRestartServer() {
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://' + (req.headers.host || RESTART_HOST + ':' + RESTART_PORT)); }
    catch (e) { sendJsonRes(res, 400, { ok: false, error: 'invalid-request' }); return; }
    const origin = acaOrigin(req);

    if (req.method === 'OPTIONS') { sendJsonRes(res, 204, {}, origin); return; }

    if (req.method === 'GET' && url.pathname === '/status') {
      sendJsonRes(res, 200, {
        ok: true,
        service: RESTART_SERVER_NAME,
        state: shutdownState.requested ? 'shutting-down' : restartState.state,
        error: restartState.lastError || ''
      }, origin);
      return;
    }
    /* P11-3B · read-only component health. Served by the RUNNING process, so it
       reports what that process actually started (pid/owned/exit count), which a
       detached `--json` invocation structurally cannot: a second runner knows the
       ports answer but not who started them. Observation only — no action. */
    if (req.method === 'GET' && url.pathname === '/components') {
      liveHealth({}).then(function (view) {
        sendJsonRes(res, 200, view, origin);
      }).catch(function (e) {
        sendJsonRes(res, 500, { ok: false, error: 'health-view-failed', message: redact(String(e && e.message || e)).slice(0, 300) }, origin);
      });
      return;
    }
    /* P11-3C · the supervisor's own record: per-component recovery state, the
       attempt timestamps inside the budget window, and the lockout history. Read
       only. This is why a component is `failed` rather than a guess from counters:
       "5 attempts inside 10 minutes" is only explicable if the attempts themselves
       are visible. No secrets: component ids, timestamps and reason strings that
       were already redacted on the way in. */
    if (req.method === 'GET' && url.pathname === '/recovery') {
      sendJsonRes(res, 200, {
        ok: true,
        service: RESTART_SERVER_NAME,
        schema: supervisorModule.SCHEMA,
        version: supervisorModule.VERSION,
        policy: supervisor.policySnapshot(),
        bounded: true,
        components: supervisor.snapshot(),
        history: supervisor.history()
      }, origin);
      return;
    }
    /* P11-3H · the lifecycle view: which components are stop targets (derived
       from the registry, not listed here), and what the last bounded stop cycle
       actually did to each of them. Read only, no action — the same discipline
       /components and /recovery already follow. */
    if (req.method === 'GET' && url.pathname === '/lifecycle') {
      sendJsonRes(res, 200, {
        ok: true,
        service: RESTART_SERVER_NAME,
        schema: 'internalbeyond.component-lifecycle',
        version: 1,
        targets: SERVICES.map(s => ({
          id: s.componentId,
          port: s.port,
          healthPath: s.endpoint,
          stopPath: s.lifecycleTarget ? s.lifecycleTarget.stopPath : null
        })),
        contract: {
          order: ['discover', 'verify-identity', 'cooperative-request', 'bounded-wait',
            'verify-pid-and-port', 'fallback-kill-if-identity-still-matches', 'bounded-wait', 'final-verify'],
          cooperative: 'POST ' + (SERVICES[0] && SERVICES[0].lifecycleTarget ? SERVICES[0].lifecycleTarget.stopPath : '/__shutdown'),
          fallback: 'verified kill only after a cooperative timeout or refusal',
          budgetMs: Number(process.env.IB_SHUTDOWN_BUDGET_MS) > 0 ? Number(process.env.IB_SHUTDOWN_BUDGET_MS) : 8000
        },
        lastShutdown: lastShutdown,
        shutdown: { requested: shutdownState.requested }
      }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {      if (!restartOriginAllowed(req)) { sendJsonRes(res, 403, { ok: false, error: 'origin-denied' }, origin); return; }
      if (shutdownState.requested) { sendJsonRes(res, 202, { ok: true, state: 'shutting-down' }, origin); return; }
      if (restartRunning()) { sendJsonRes(res, 409, { ok: false, state: 'restarting', error: 'restart-in-progress' }, origin); return; }
      shutdownState.requested = true;
      /* Fire-and-forget: the response must flush before this process exits. */
      setTimeout(runShutdown, 60).unref();
      sendJsonRes(res, 202, { ok: true, state: 'shutting-down' }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/restart') {
      if (!restartOriginAllowed(req)) { sendJsonRes(res, 403, { ok: false, error: 'origin-denied' }, origin); return; }
      if (restartRunning()) { sendJsonRes(res, 409, { ok: false, state: 'restarting', error: 'restart-in-progress' }, origin); return; }
      /* The control plane answers BEFORE the initial start finishes (so /shutdown
         stays reachable when a component cannot start), which means a restart can
         arrive while that first pass is still spawning children. Refusing it for
         that brief window is the honest answer — that pass IS a restart of
         everything — but it must be brief: once every child has been spawned, the
         pass is only waiting for them, and an operator restart can safely take
         over (it stops what it started and starts again). Refusing for the whole
         startup would make the button fail during exactly the situation it exists
         to fix. */
      if (!spawnPhaseComplete) { sendJsonRes(res, 409, { ok: false, state: 'starting', error: 'startup-in-progress' }, origin); return; }
      /* Fire-and-forget: the mutex is held for the whole run; UI polls /status. */
      runRestart();
      sendJsonRes(res, 202, { ok: true, state: 'restarting' }, origin);
      return;
    }
    sendJsonRes(res, 404, { ok: false, error: 'not-found' }, origin);
  });
  server.on('error', e => { appendRestartLog('restart control server error: ' + redact(String(e && e.message || e))); });
  /* P11-3X-B: the bind's outcome is the answer to "am I the service runner?".
     Resolving it instead of logging-and-continuing is what closes the hole where a
     runner with a dead control plane still spawned children. The preflight already
     answered "the port is free", so a failure here is a lost race — reported as a
     failure, not swallowed. */
  return new Promise(resolve => {
    let settled = false;
    server.once('error', error => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'control-plane-bind-failed', owner: null, detail: String((error && error.message) || error) });
    });
    server.listen(RESTART_PORT, RESTART_HOST, () => {
      if (settled) return;
      settled = true;
      appendRestartLog('restart control server listening on ' + RESTART_HOST + ':' + RESTART_PORT);
      resolve({ ok: true, reason: null, owner: 'self', detail: RESTART_HOST + ':' + RESTART_PORT });
    });
  });
}

function timestamp() { return new Date().toISOString(); }

function appendLog(service, stream, chunk) {
  const text = String(chunk || '');
  const prefix = '[' + timestamp() + '] [' + stream + '] ';
  try { fs.appendFileSync(path.join(LOG_DIR, service.name.toLowerCase() + '.log'), prefix + text); } catch (e) { /* logging must never take down services */ }
  if (!jsonOnly) process.stdout.write('[' + service.name + '] ' + text);
}

/* ── Root cause of a child death (P11-3X-B) ───────────────────────────────
 *
 * A child that exits tells this runner two things: a code, and everything it wrote
 * to stderr. The code alone is why the supervisor used to end up with
 * "exited unexpectedly (code=1, signal=n/a)" for every possible cause — a read-only
 * database, a squatted port, a schema from the future all looked identical from the
 * outside, and the only place that said which one it was was the child's own log
 * file. Measured before this change: a Bridge crash-log held "端口 12212 已被占用"
 * while the component report said "restart budget exhausted" and nothing else.
 *
 * So the tail is kept (bounded, per child) and read once, at exit. SQLite failures
 * are recognised by the one classifier, which also reads the `[db-readonly]` style
 * tag the stores print, so the class survives even when the prose around it changes.
 * A line that classifies as nothing keeps its own words, truncated and redacted.
 * Nothing here changes what the supervisor DOES — only what it can say. */
const CHILD_TAIL_BYTES = 4000;

function tailOf(entry) {
  return entry && entry.stderrTail ? entry.stderrTail : '';
}

function appendTail(entry, chunk) {
  if (!entry) return;
  const text = String(chunk || '');
  if (!text) return;
  entry.stderrTail = (entry.stderrTail + text).slice(-CHILD_TAIL_BYTES);
}

/* The most informative line of a dead child's stderr: the last non-empty line that
   is not the runner's own bookkeeping ("started pid=…" / "exited unexpectedly …"),
   so the cause is preferred over the report of the cause. */
function lastCauseLine(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\[?[\dT:.\-Z ]*\]?\s*\[runner\]/.test(lines[i])) continue;
    if (/^started pid=/.test(lines[i])) continue;
    return lines[i];
  }
  return '';
}

/* The `reason` handed to the supervisor for an unexpected exit. Prefixed with the
   class so a 200-character truncation can never eat it (see component-supervisor). */
function exitCause(service, entry) {
  const tail = tailOf(entry);
  if (!tail) return '';
  const line = lastCauseLine(tail);
  const isDb = require('./db-failure.js');
  const classified = isDb.classifyText(tail);
  if (classified) {
    /* Keep the child's own sentence next to the class: the class is what a consumer
       acts on, the sentence is what a human reads. */
    const detail = line ? line.replace(/^\[[^\]]*\]\s*\[(?:err|out)\]\s*/, '').slice(0, 140) : '';
    return classified + (detail ? ': ' + detail : '');
  }
  if (!line) return '';
  return redact(line).slice(0, 140);
}

function spawnService(service) {
  const child = spawn(service.command, service.commandArgs, {
    cwd: ROOT,
    env: Object.assign({}, process.env, service.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  /* Process tracking (P11-3B): this runner records WHAT IT STARTED. P11-3C adds
     the recovery signal on top of the same events — the supervisor is told about
     an exit, and decides; nothing in this function decides anything by itself. */
  const entry = {
    service,
    componentId: service.componentId || null,
    child,
    pid: child.pid || null,
    startedAt: Date.now(),
    exits: 0,
    exited: false,
    /* Set before a deliberate kill so the exit handler can tell a stop from a
       crash. Absent means "nobody asked for this". */
    stopIntent: null,
    /* One failure signal per child life: a spawn error and an exit can both
       arrive for the same dead child, and counting both would spend two budget
       slots on one failure. */
    failureReported: false,
    /* P11-3X-B: bounded stderr tail, read once at exit to recover WHY it died.
       Only stderr — stdout is the service's normal chatter and would drown the
       cause. 4000 bytes is enough for a startup failure block and small enough that
       a chatty service cannot grow memory without bound. */
    stderrTail: ''
  };
  children.push(entry);
  currentChild[service.name] = entry;
  child.stdout.on('data', chunk => appendLog(service, 'out', chunk));
  child.stderr.on('data', chunk => { appendTail(entry, chunk); appendLog(service, 'err', chunk); });
  child.on('error', error => {
    appendLog(service, 'err', 'spawn failed: ' + error.message + '\n');
    entry.failureReported = true;
    onServiceFailure(service, {
      spawnFailed: true,
      reason: 'spawn failed: ' + (error && error.code ? error.code : 'unknown-error'),
      code: null,
      signal: null
    });
  });
  child.on('exit', (code, signal) => {
    entry.exited = true;
    entry.exitedAt = Date.now();
    entry.exitCode = code;
    entry.exits += 1;
    const intentional = entry.stopIntent === 'intentional';
    /* P11-3X-B: what the child last said. Computed before the intentional check so
       an operator stop also leaves a cause in the log (a graceful stop should not
       look like a mystery). */
    const cause = exitCause(service, entry);
    appendLog(service, 'runner', (intentional ? 'stopped intentionally' : 'exited unexpectedly') +
      ' (code=' + code + ', signal=' + (signal || '') + ')' + (cause ? ' — ' + cause : '') + '\n');
    /* An exit we asked for is not a failure, and must never be recovered — that
       is how a control-plane restart would otherwise resurrect a service the
       operator just took down. */
    if (intentional || entry.failureReported) return;
    onServiceFailure(service, { spawnFailed: false, code: code, signal: signal, reason: cause });
  });
  appendLog(service, 'runner', 'started pid=' + child.pid + '\n');
  return entry;
}

async function waitUntilHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await serviceStatus(service);
    if (row.online) return true;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

/* ── Bounded crash recovery (P11-3C) ──────────────────────────────────────
 *
 * The runner is the only thing that can act here: the supervisor decides, this
 * section executes. Three signals can start a recovery, and all three converge
 * on ONE function so they cannot acquire different limits:
 *
 *   · process_exit   the child this runner started died without being asked to
 *   · spawn_failed   the OS refused to create the process at all
 *   · health_fail     the child is alive but its own /health stopped answering
 *
 * Everything is bounded: the supervisor's sliding-window budget, its exponential
 * backoff and its lockout. Once the budget is spent the component is `failed`
 * and this process will not try again — the health view says so, and that is the
 * whole behaviour. Nothing here ever retries in a loop of its own.
 *
 * Recovery is deliberately limited to components this runner STARTED. A healthy
 * service running outside this runner is not ours to restart, and a port held by
 * a foreign process is a conflict to report, not a crash to recover from.
 */
const recoveryTimers = {};
/* Bumped every time a control-plane restart cycle takes over. A recovery attempt
   that is already in flight (stopped the old process, spawned a new one, waiting
   for health) cannot be called back by clearTimeout — it has to notice that the
   world moved on and abandon its attempt instead of reporting a success for a
   process the restart cycle is about to kill (P11-3C). */
let recoveryGeneration = 0;
/* False until the first start pass has spawned everything it is going to spawn.
   The control plane answers during that pass, so it needs to know when spawning is
   over — after that point the pass is only waiting, and an operator restart may
   take over. */
let spawnPhaseComplete = false;

function onServiceFailure(service, detail) {
  if (recoveryDisabled) return;
  const decision = supervisor.handle(service.componentId, supervisorModule.EVENT.PROCESS_EXIT, {
    restartable: service.restartable,
    spawnFailed: detail.spawnFailed === true,
    code: detail.code,
    signal: detail.signal,
    reason: detail.reason,
    at: Date.now()
  });
  appendRestartLog(service.name + ' failure → ' + decision.action + ' (' + String(decision.reason || '').slice(0, 160) + ')');
  if (decision.action === 'retry') scheduleRecovery(service);
}

function scheduleRecovery(service) {
  if (recoveryDisabled) return;
  const view = supervisor.describe(service.componentId);
  if (!view) return;
  /* One pending attempt per component. A second crash signal must not queue a
     second recovery on top of the one already waiting. */
  if (recoveryTimers[service.componentId]) return;
  const delay = Math.max(0, Number(view.nextAttemptAt || 0) - Date.now());
  recoveryTimers[service.componentId] = setTimeout(function () {
    delete recoveryTimers[service.componentId];
    recoverService(service).catch(function (e) {
      appendRestartLog(service.name + ' recovery error: ' + redact(String(e && e.message || e)).slice(0, 200));
    });
  }, delay);
  if (delay > 0) appendRestartLog(service.name + ' recovery scheduled in ' + delay + 'ms');
}

async function recoverService(service) {
  if (recoveryDisabled || stopping.has(service.componentId)) return;
  /* The control plane may be mid-restart. Its own cycle will bring this
     component up; competing with it would mean two processes for one port. */
  if (restartRunning()) {
    appendRestartLog(service.name + ' recovery deferred: a restart cycle is in progress');
    scheduleRecovery(service);
    return;
  }
  /* The budget is checked by the supervisor, not here: this is the only place a
     recovery attempt can be authorized. */
  const authorization = supervisor.authorizeAttempt(service.componentId);
  if (!authorization.allowed) {
    supervisor.handle(service.componentId, supervisorModule.EVENT.BUDGET_EXHAUSTED, {
      reason: service.name + ': no recovery attempt authorized (' + authorization.reason + ')'
    });
    appendRestartLog(service.name + ' recovery refused: ' + authorization.reason);
    return;
  }

  const entry = currentChild[service.name];
  if (entry && !entry.exited && entry.child && !entry.child.killed) {
    /* Alive but unhealthy: take it down through the verified stop path (which
       also marks the exit intentional, so this stop is not itself recovered). */
    appendRestartLog(service.name + ' alive but unhealthy; stopping it before restart');
    await stopService(service);
    await waitPortFree(service.port, 8000);
  }

  /* Burn the budget slot here — immediately before the real attempt — so a
     decision that never became a process cannot consume the budget. The attempt
     number is read BEFORE noteAttempt, so the FIRST attempt logs "1/3" rather than
     "0/3"/"2/3"; a log that off-by-ones its own budget is a log nobody can use to
     explain a lockout. */
  const attemptNumber = supervisor.describe(service.componentId).attemptsInWindow + 1;
  supervisor.noteAttempt(service.componentId);
  appendRestartLog(service.name + ' recovery attempt ' + attemptNumber + '/' +
    RECOVERY_POLICY_ACTIVE.maxAttempts);
  const generation = recoveryGeneration;
  const newEntry = spawnService(service);
  const healthy = await waitUntilHealthy(service, service.componentId === 'vision' ? 120000 : 20000);

  /* A control-plane restart began while this attempt was waiting. That cycle owns
     the component now: this attempt must record NOTHING (a success would count a
     restart the supervisor never made, and a failure would spend a budget slot on
     a process the operator deliberately replaced). */
  if (generation !== recoveryGeneration || recoveryDisabled || shuttingDown) {
    appendRestartLog(service.name + ' recovery attempt abandoned: a control-plane restart took over');
    return;
  }

  if (healthy) {
    const decision = supervisor.handle(service.componentId, supervisorModule.EVENT.RESTART_SUCCESS, {
      restartable: service.restartable,
      trigger: supervisor.describe(service.componentId).lastTrigger || supervisorModule.TRIGGER.PROCESS_EXIT,
      at: Date.now()
    });
    appendRestartLog(service.name + ' recovered (pid=' + newEntry.pid + ', ' + decision.action + ')');
    return;
  }

  const death = currentChild[service.name];
  /* P11-3X-B: the recovery-attempt narration is the LAST thing that lands in the
     terminal state, so a generic sentence here would bury the root cause even after
     the exit handler had recovered it. The child that just failed to come up still
     has its stderr tail, so its own cause travels too; the class is placed before it
     so a 200-character truncation can never eat the part a consumer acts on. */
  const deathCause = death ? exitCause(service, death) : '';
  const decision = supervisor.handle(service.componentId, supervisorModule.EVENT.RESTART_FAILED, {
    restartable: service.restartable,
    reason: service.name + ' did not become healthy after recovery attempt ' + attemptNumber + '/' +
      RECOVERY_POLICY_ACTIVE.maxAttempts +
      (death && death.exited ? ' (process exited, code=' + death.exitCode + ')' : ' (process alive, port silent)') +
      (deathCause ? ' — ' + deathCause : ''),
    at: Date.now()
  });
  appendRestartLog(service.name + ' recovery attempt failed → ' + decision.action +
    (decision.inMs ? ' in ' + decision.inMs + 'ms' : '') +
    ' (' + String(decision.reason || '').slice(0, 160) + ')');
  if (decision.action === 'retry') scheduleRecovery(service);
}

/* ── Health-driven recovery ───────────────────────────────────────────────
 *
 * A child can be alive with a dead port (a wedged event loop, a failed bind, a
 * half-initialised server). No exit event ever fires, so without this poll that
 * component would sit there forever reported unhealthy and never recovered.
 *
 * Two guards keep the poll from acting on noise: it only ever probes components
 * THIS runner started and is not currently stopping, and the supervisor requires
 * two consecutive failed probes before it will treat it as a failure. */
async function healthWatchOnce() {
  if (recoveryDisabled) return;
  for (const service of SERVICES) {
    /* eslint-disable no-await-in-loop -- bounded: one probe per runner-owned
       component, and serial probing keeps a degraded port cheap to diagnose. */
    if (stopping.has(service.componentId)) continue;
    if (restartRunning()) continue;
    const entry = currentChild[service.name];
    if (!entry || entry.exited) continue;
    const row = await serviceStatus(service);
    if (row.online) {
      supervisor.noteHealthy(service.componentId);
      continue;
    }
    const decision = supervisor.handle(service.componentId, supervisorModule.EVENT.HEALTH_FAIL, {
      restartable: service.restartable,
      reason: service.name + ' is running (pid=' + (row.pid || '?') + ') but its health endpoint is not answering',
      at: Date.now()
    });
    if (decision.action === 'retry') {
      appendRestartLog(service.name + ' health failure → recover');
      scheduleRecovery(service);
    }
  }
}

function startHealthWatch() {
  /* Deliberately slow and unref'd: this is recovery, not monitoring. It also
     never keeps the process alive on its own. */
  const timer = setInterval(function () {
    healthWatchOnce().catch(function (e) {
      appendRestartLog('health watch error: ' + redact(String(e && e.message || e)).slice(0, 200));
    });
  }, 6000);
  timer.unref();
  return timer;
}

async function startServices() {
  const initial = await allStatus();
  const launched = [];
  for (let i = 0; i < SERVICES.length; i++) {
    const service = SERVICES[i];
    const existing = initial[i];
    if (existing.online) {
      console.log('[runner] ' + service.name + ' is already healthy on port ' + service.port + '; leaving it alone.');
      continue;
    }
    if (existing.conflict) {
      console.error('[runner] Port ' + service.port + ' answered /health but is not ' + service.name +
        '; refusing to treat it as healthy or start a competing process.');
      continue;
    }
    /* ── P11-3X-B：启动前的端口归属预检 ─────────────────────────────────
       "没人回答 /health"有三种完全不同的原因，而它们过去全都被当成"没起来"：
         · 端口空着                      → 正常启动；
         · 端口被我们自己的僵尸实例占着  → 明确策略：走已验证的 stop 路径收掉它，
                                            然后启动（stopService 只会杀被证实的
                                            Internal Beyond 进程）；
         · 端口被别人占着 / 身份读不出来 → **拒绝启动**，如实报类别。
       过去第二种和第三种都会 spawn，然后 child 以 EADDRINUSE 退出、被 3C 恢复
       五次、最后锁死，而对外理由只有 "exited unexpectedly (code=1)" —— 实测一个
       静默占端口的监听者就是这样把 Bridge 变成 failed 的，真正的"端口已被占用"
       只出现在 child 的 stderr 里。不擅自 kill 任何非本方进程。 */
    if (!(await portBindable(service.port, '127.0.0.1'))) {
      const holder = await classifyPortOwner(service.port, service.commandArgs[0]);
      if (holder.owner === PORT_OWNER.OWNED_COMPONENT) {
        console.error('[runner] Port ' + service.port + ' is held by a stale ' + service.name +
          ' instance (pid ' + holder.pids.join(',') + ') that is not answering; stopping it before starting a fresh one.');
        appendRestartLog(service.name + ': stale own instance on port ' + service.port +
          ' (pid ' + holder.pids.join(',') + ') → verified stop, then start');
        await stopService(service);
        await waitPortFree(service.port, 8000);
      } else {
        const reason = holder.owner === PORT_OWNER.UNKNOWN ? 'port-owner-unknown' : 'port-owned-by-foreign-process';
        console.error('[runner] Port ' + service.port + ' is not free (' + holder.owner + '): ' +
          (holder.reason || 'held by another process') + ' — refusing to start a competing ' + service.name +
          '. Nothing was killed; free the port or set the component port override.');
        appendRestartLog(service.name + ' not started: ' + reason + ' on port ' + service.port +
          ' (owner=' + holder.owner + ', pids=' + holder.pids.join(',') + ')');
        /* Recorded on the component so /components and the diagnostics page can say
           WHY it is not running instead of showing a bare `offline`. */
        portConflicts[service.componentId] = { owner: holder.owner, reason: reason, pids: holder.pids, port: service.port };
        continue;
      }
    }
    spawnService(service);
    launched.push(service);
  }
  /* Every child this pass is going to spawn now exists. From here the pass only
     WAITS, so an operator restart may take over (see the /restart handler). */
  spawnPhaseComplete = true;
  for (const service of launched) {
    const healthy = await waitUntilHealthy(service, service.componentId === 'vision' ? 120000 : 15000);
    /* The supervisor's own state must match reality at boot: a service that came
       up healthy is `healthy`, and a service that did not is a failure the
       bounded policy gets to act on (which is how a component whose first start
       lost a race with its port ends up recovered instead of sitting dead). */
    if (healthy) supervisor.noteHealthy(service.componentId);
    console.log('[runner] ' + service.name + (healthy ? ' is ready.' : ' did not become healthy yet; inspect its log.'));
  }
  /* Components that were already running and belong to somebody else are
     registered as healthy observers — this runner never restarts them. */
  const rows = await allStatus();
  rows.forEach(function (row) {
    const spec = SERVICES.find(s => s.name === row.name);
    if (spec && row.online && !row.owned) supervisor.noteHealthy(spec.componentId);
  });
  printStatus(rows, await liveHealth({ rows: rows, probeWeb: args.has('--probe-web') }));
  startHealthWatch();
}

/* P11-3H: the last-resort path. Used only when the bounded cooperative pass
   could not run to completion (its own budget expired, or the runner is being
   terminated by a signal it cannot spend time on) — a kill here is the
   documented fallback, never the mechanism. */function forceStopChildren() {
  children.forEach(entry => {
    if (entry.exited) return;
    try { if (entry.componentId) supervisor.handle(entry.componentId, supervisorModule.EVENT.STOP, { at: Date.now() }); } catch (e) { /* 已终态 */ }
    entry.stopIntent = 'intentional';
    try { lifecycle.killPid(entry.pid); } catch (e) { /* already gone */ }
  });
}

function installInteractiveControls() {
  if (!process.stdin.isTTY) return;
  console.log('Controls: [s] status · [q] stop services and exit');
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', async data => {
    const key = String(data || '').trim().toLowerCase();
    if (key === 's' || key === 'status') {
      const rows = await allStatus();
      printStatus(rows, await liveHealth({ rows: rows, probeWeb: args.has('--probe-web') }));
    }
    if (key === 'q' || key === 'quit' || key === 'exit') shutdown(0);
  });
}

/* The runner's own end-of-life path.
 *
 * P11-3H: it used to be `stopChildren()` + a fixed 1200ms timeout, where
 * `stopChildren()` was `child.kill('SIGTERM')` — i.e. on Windows, every child was
 * TerminateProcess-ed and the runner then waited a fixed amount of time for
 * something that had already happened. Now the children are asked to stop, with
 * one small shared budget, and only what did not stop is killed. The fixed wait
 * is kept as the last resort, not as the mechanism.
 *
 * `shuttingDown` is set synchronously so a second signal, the interactive 'q', or
 * a control-plane /shutdown arriving during the cooperative pass all collapse
 * into this one path. */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  /* P11-3C: this process is ending, so nothing may be recovered any more. */
  recoveryDisabled = true;
  cancelRecoveryTimers();
  console.log('\n[runner] Stopping services started by this runner…');
  const budgetMs = Number(process.env.IB_SHUTDOWN_BUDGET_MS) > 0
    ? Number(process.env.IB_SHUTDOWN_BUDGET_MS) : 4000;
  const deadline = Date.now() + budgetMs;
  const live = SERVICES.filter(s => {
    const entry = currentChild[s.name];
    return entry && !entry.exited;
  });
  const done = async () => {
    /* Anything still alive after the bounded pass gets the documented fallback. */
    const stillUp = SERVICES.filter(s => {
      const entry = currentChild[s.name];
      return entry && !entry.exited;
    });
    if (stillUp.length) {
      appendRestartLog('runner shutdown fallback: killing ' +
        stillUp.map(s => s.name + ':pid' + (currentChild[s.name].pid || '?')).join(', '));
      forceStopChildren();
    }
    setTimeout(() => process.exit(code), 300).unref();
  };
  if (!lifecycle || !live.length || lastShutdown.at) {
    /* Either there is nothing left to stop, or the bounded cycle above already
       ran and recorded what it did. Reporting that cycle and exiting is the
       whole job here — starting a second pass would only report "not running"
       over the verdict the first pass produced. */
    done();
    return;
  }
  (async () => {
    for (let i = 0; i < live.length; i += 1) {
      const service = live[i];
      const remaining = Math.max(0, deadline - Date.now());
      const budget = lifecycle.targetBudget(remaining, live.length - i, { perTargetFloorMs: 1500, discoveryMs: 1200 });
      try {
        await stopService(service, {
          deadline: Math.min(deadline, Date.now() + budget.deadlineMs),
          cooperativeMs: budget.cooperativeMs,
          fallbackMs: budget.fallbackMs
        });
      } catch (e) { /* 停止失败由下面的 stillUp 兜底 */ }
    }
  })().then(done).catch(done);
}

async function main() {
  if (statusOnly) {
    const rows = await allStatus();
    /* --status / --json always answers the component question, because that is
       what every other tool now consumes. It answers the RECOVERY question as
       null: this invocation is not the process that owns the supervisor, so it
       has no recovery state to report (P11-3C). */
    printStatus(rows, await liveHealth({ rows: rows, probeWeb: args.has('--probe-web'), withRecovery: false }));
    return;
  }
  /* The control plane comes up BEFORE the services (P11-3C). It used to start
     only after every service reported healthy, which meant a single component
     that could never become healthy left the runner with no /status, no
     /components, no /restart and — the one that actually hurts — no /shutdown:
     an install could not be upgraded or uninstalled because the runner would not
     answer. The health view is honest during startup (components are `starting`),
     and the supervisor needs no service to be up in order to report.

     P11-3X-B adds the other half of that rule: it must come up, or this process
     must not run. A runner without a control plane cannot be asked to stop, cannot
     be asked to restart, and competes with any real runner over every component —
     so `ensureControlPlane()` runs FIRST and its refusal ends the process before a
     single child is spawned. It does not kill anything, and it does not retry: a
     port that belongs to somebody else is a decision for the operator. */
  const control = await ensureControlPlane();
  if (!control.ok) {
    console.error('[runner] Refusing to start: ' + control.reason + ' — ' + control.detail);
    console.error('[runner] No service was started and no process was killed. ' +
      'Free ' + RESTART_HOST + ':' + RESTART_PORT + ' (or set IB_RESTART_PORT) and try again.');
    appendRestartLog('refusing to start: ' + control.reason + ' (' + control.detail + ')');
    /* Deliberately NOT shutdown(): that path exists to stop children, and there are
       none yet. It also ends with an UNREF'd timer, which in a process that holds no
       handles at all (the control server never bound) would let the event loop drain
       and exit 0 — a refusal that reports success. So: set the code, hold the loop
       with a ref'd timer long enough for the writes to flush, and exit non-zero. A
       launcher that treats exit 0 as "the runner is up" must not be told otherwise. */
    recoveryDisabled = true;
    shuttingDown = true;
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1500);
    return;
  }
  await startServices();
  installInteractiveControls();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', error => {
  console.error('[runner] Unexpected error:', error && error.stack || error);
  shutdown(1);
});

/* P11-3X-B: the port-ownership and root-cause decisions are the承重 parts of this
   phase, and a decision that can only be observed by starting a whole runner is a
   decision nobody can falsify. So they are exported for direct assertion (and for
   the mutation suite, which must prove each one is load-bearing). Requiring this
   module has no side effect on the world: `main()` only runs when it is the entry
   point. The mutable per-run state (children, the supervisor, portConflicts) stays
   private — what is exported is exactly the pure/半-pure predicates. */
module.exports = {
  PORT_OWNER: PORT_OWNER,
  classifyPortOwner: classifyPortOwner,
  commandMatchesScript: commandMatchesScript,
  portBindable: portBindable,
  probeControlPlane: probeControlPlane,
  lastCauseLine: lastCauseLine,
  exitCause: exitCause,
  SERVICE_FILES: SERVICES.reduce(function (acc, s) { acc[s.componentId] = s.commandArgs[0] || null; return acc; }, {})
};

if (require.main === module) {
  main().catch(error => {
    console.error('[runner] Failed:', error && error.stack || error);
    shutdown(1);
  });
}
