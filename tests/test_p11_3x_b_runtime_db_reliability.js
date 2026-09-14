/* ====================================================================
   P11-3X-B · Runtime / DB Reliability — 可靠性回归测试
   --------------------------------------------------------------------
   本文件把 P11-3X-B 审计出的可靠性缺陷写成**可执行断言**。每条断言都对应一个
   实测过的真实行为（修复前会红、修复后必须绿），而不是"看起来应该如此"。

     §CLASSIFY  数据库失败分类器（**classifier test**：纯映射表，不碰磁盘）
     §DB        真实 SQLite 行为（**real SQLite behaviour test**：临时目录 + 真驱动）
                —— 只读 / 权限 / 侧车被挡 / 损坏 / schema 过新 / busy，
                   以及"隔离只允许由完整性结论授权"这条闸门
     §HEALTH    health truthfulness：可达 ≠ 能干活；聚合不得把 store-closed 洗成 healthy
     §PORT      端口归属分类 + 重复 runner + 外部占用者（真实进程、真实端口）
     §RECOVERY  只读库崩溃环有界，且终态保留根因（真实 runner）
     §SHUTDOWN  生产停止路径后端口释放、库可重开、数据仍在（真实 Home Node）

   隔离纪律（与用户测试纪律一致）：
     · 私有临时 data dir（os.tmpdir()）；绝不触碰 %LOCALAPPDATA%\InternalBeyond
       或开发目录里的任何用户数据；runner 的日志目录也指向临时 LOCALAPPDATA；
     · 私有端口（内核分配）；不绑定非 loopback 地址；
     · 不调用真实 provider；不启动浏览器；
     · 每个子进程与 server 在结束时显式回收，并**报告**残留。

   Windows 专属小节（attrib / icacls / taskkill）：非 win32 时整体跳过并如实打印，
   绝不假装跑过。

   用法：
     node tests/test_p11_3x_b_runtime_db_reliability.js
     P11_3X_B_SECTIONS=HEALTH,PORT   node ...   （mutation 驱动只跑受影响的小节）
   ==================================================================== */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* Home Node 的模块级装配在 require 时读这些环境变量：必须在 require 之前设好，
   否则进程级实例会指向真实用户目录。 */
const HN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3x-b-hn-'));
const RUNNER_LOGDIR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3x-b-log-'));
process.env.IB_HOME_NODE_DATA_DIR = HN_DIR;
process.env.LOCALAPPDATA = RUNNER_LOGDIR_ROOT;

let passed = 0, failed = 0, skipped = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else {
    failed++;
    failures.push(name);
    console.log('\u2718 FAIL  ' + name + (extra !== undefined ? '  \u2014 ' + JSON.stringify(extra) : ''));
  }
}
function skip(name, why) { skipped++; console.log('\u25CB SKIP  ' + name + '  \u2014 ' + why); }
function section(title) { console.log('\n\u2500\u2500 ' + title + ' \u2500\u2500'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const WANT = String(process.env.P11_3X_B_SECTIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const wants = id => !WANT.length || WANT.indexOf(id) >= 0;

const WIN = process.platform === 'win32';

/* ── 基础设施 ─────────────────────────────────────────────────────────── */

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-3x-b-' + tag + '-')); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } }

const openChildren = new Set();
const openServers = new Set();

function request(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = opts.body == null ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (data != null) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method,
      timeout: opts.timeoutMs || 15000, headers: headers
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

/* 宿主侧的端口占用者（与 runner 自己用的 PowerShell 查询同款） */
function listenersOn(port) {
  return new Promise(resolve => {
    if (!WIN) {
      execFile('sh', ['-c', '(netstat -tlnp 2>/dev/null || true) | grep ":' + Number(port) + '" | awk \'{print $7}\' | cut -d/ -f1'],
        { timeout: 6000 }, (e, out) => resolve(String(out || '').trim().split(/\s+/).filter(Boolean)));
      return;
    }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-NetTCPConnection -LocalPort ' + Number(port) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ","'],
      { windowsHide: true, timeout: 8000 }, (e, out) => resolve(String(out || '').trim().split(',').filter(Boolean)));
  });
}

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/* 一个什么都不回答的监听者：TCP 接受连接，但永不发一个字节。
   这不是"占端口的服务"，而是"端口被占了但没人会告诉你"——正是过去被读成
   "组件没起来"、于是 spawn 一个必然 EADDRINUSE 的 child 的那种情况。 */
function startSilentSquatter(port) {
  const sockets = [];
  const server = net.createServer(s => { sockets.push(s); });
  openServers.add(server);
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve({
      server: server,
      close() { for (const s of sockets) { try { s.destroy(); } catch (_) { /* 已断 */ } } try { server.close(); } catch (_) { /* 已关 */ } openServers.delete(server); }
    }));
  });
}

const store = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
const dbFailure = require(path.join(ROOT, 'runtime', 'db-failure.js'));
const registry = require(path.join(ROOT, 'runtime', 'component-registry.js'));
const bootState = require(path.join(ROOT, 'runtime', 'boot-state.js'));
const supervisorModule = require(path.join(ROOT, 'runtime', 'component-supervisor.js'));
/* require 这个模块没有副作用：main() 只在它作为入口时才跑（见文件底部守卫）。 */
const runnerLib = require(path.join(ROOT, 'runtime', 'local-services-runner.js'));

/* 进程级 Home Node 装配（只在 §HEALTH 用到，且用隔离实例） */
const homeNodeService = require(path.join(ROOT, 'services', 'home-node-service.js'));

/* ── 真实 SQLite 场景的构造工具 ────────────────────────────────────────── */

function seedStore(dir, count) {
  const s = store({ dataDir: dir, logger: () => {} });
  s.open();
  for (let i = 0; i < (count || 1); i++) {
    s.putMessage({ id: 'm' + i, role: 'user', content: 'history ' + i, friendId: 'f1', timestamp: 1700000000000 + i }, {});
  }
  const info = { file: s.file, messages: s.countMessages(), revision: s.getRevision() };
  s.close();
  return info;
}

function openOutcome(dir) {
  const s = store({ dataDir: dir, logger: () => {} });
  let out;
  try { s.open(); out = { ok: true, isOpen: s.isOpen(), code: null, message: null }; }
  catch (e) { out = { ok: false, isOpen: s.isOpen(), code: e && e.code, reason: e && e.dbReason, message: String(e && e.message || e).slice(0, 200) }; }
  try { s.close(); } catch (_) { /* 已关闭 */ }
  return out;
}

function dirListing(dir) { try { return fs.readdirSync(dir).sort(); } catch (e) { return ['ERR:' + e.code]; } }
function quarantineFiles(dir) { return dirListing(dir).filter(f => f.indexOf('.corrupt-') >= 0); }

/* 读回一个（可能被隔离过的）库里的消息数。用于证明"数据还在原地"。 */
function messageCountOf(file) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    const row = db.prepare('SELECT COUNT(*) AS c FROM messages').get();
    db.close();
    return row ? row.c : -1;
  } catch (e) { return -1; }
}

const setReadonlyFile = file => execFileSync('attrib.exe', ['+R', file], { windowsHide: true });
const clearReadonlyFile = file => { try { execFileSync('attrib.exe', ['-R', file], { windowsHide: true }); } catch (_) { /* best effort */ } };
const denyAce = (target, perm) => execFileSync('icacls.exe', [target, '/deny', String(process.env.USERNAME) + ':(' + perm + ')'], { windowsHide: true });
const removeDeny = target => { try { execFileSync('icacls.exe', [target, '/remove:d', String(process.env.USERNAME)], { windowsHide: true }); } catch (_) { /* best effort */ } };

/* ── 真实 runner 的启动夹具 ────────────────────────────────────────────── */

function runnerEnv(ports, dataRoot, extra) {
  return Object.assign({}, process.env, {
    IB_WEB_PORT: String(ports.web),
    IB_BRIDGE_PORT: String(ports.bridge),
    IB_ACTIVE_PORT: String(ports.active),
    IB_HOME_NODE_PORT: String(ports.homeNode),
    IB_RESTART_PORT: String(ports.restart),
    IB_BRIDGE_DATA_DIR: path.join(dataRoot, 'bridge'),
    IB_ACTIVE_DATA_DIR: path.join(dataRoot, 'active'),
    IB_HOME_NODE_DATA_DIR: path.join(dataRoot, 'home'),
    IB_BOOT_STATE_DIR: path.join(dataRoot, 'boot'),
    LOCALAPPDATA: dataRoot
  }, extra || {});
}

async function freshPorts() {
  const ports = {};
  for (const k of ['web', 'bridge', 'active', 'homeNode', 'restart']) ports[k] = await freePort();
  return ports;
}

function startRunner(env) {
  const child = spawn(process.execPath, ['runtime/local-services-runner.js'], {
    cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  openChildren.add(child);
  const rec = { child: child, out: '', exited: null, code: null };
  child.stdout.on('data', d => { rec.out += String(d); });
  child.stderr.on('data', d => { rec.out += String(d); });
  child.on('exit', (code, signal) => { rec.exited = true; rec.code = code === null ? 'sig:' + signal : code; openChildren.delete(child); });
  return rec;
}

async function waitControlPlane(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 40000);
  while (Date.now() < deadline) {
    try { const r = await request(port, 'GET', '/status', { timeoutMs: 1500 }); if (r.status === 200) return true; } catch (_) { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

async function componentsOf(port) {
  const r = await request(port, 'GET', '/components', { timeoutMs: 20000 });
  return (r.body && r.body.aggregated && r.body.aggregated.components) || [];
}

function runnerLog(dataRoot, name) {
  try { return fs.readFileSync(path.join(dataRoot, 'InternalBeyond', 'logs', name), 'utf8'); } catch (e) { return ''; }
}

async function shutdownRunner(rec, restartPort, timeoutMs) {
  try { await request(restartPort, 'POST', '/shutdown', { timeoutMs: 3000 }); } catch (_) { /* 可能已经不在 */ }
  const deadline = Date.now() + (timeoutMs || 12000);
  while (rec.exited === null && Date.now() < deadline) await sleep(250);
  if (rec.exited === null) { try { rec.child.kill(); } catch (_) { /* best effort */ } }
  return rec.exited !== null;
}

/* 收掉某个端口上还残留的监听进程（只用于测试清理，且只针对我们自己起的私有端口） */
async function killListeners(port) {
  if (!WIN) return;
  for (const pid of await listenersOn(port)) {
    try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }); } catch (_) { /* 可能已退出 */ }
  }
}

/* ==================================================================== */
(async () => {

  /* ── §CLASSIFY · 纯分类器（classifier test：没有磁盘、没有 SQLite） ──── */
  if (wants('CLASSIFY')) {
    section('§CLASSIFY \u00b7 db failure classifier (pure mapping, no disk)');
    const c = dbFailure;
    const cases = [
      ['SQLITE_NOTADB(26) 文件不是数据库 → db-corrupt', { code: 'ERR_SQLITE_ERROR', errcode: 26, errstr: 'file is not a database' }, 'db-corrupt'],
      ['SQLITE_CORRUPT(11) → db-corrupt', { code: 'ERR_SQLITE_ERROR', errcode: 11, errstr: 'database disk image is malformed' }, 'db-corrupt'],
      ['SQLITE_READONLY(8) → db-readonly（**不是** corruption）', { code: 'ERR_SQLITE_ERROR', errcode: 8, errstr: 'attempt to write a readonly database' }, 'db-readonly'],
      ['SQLITE_BUSY(5) → db-busy', { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' }, 'db-busy'],
      ['SQLITE_LOCKED(6) → db-locked', { code: 'ERR_SQLITE_ERROR', errcode: 6, errstr: 'database table is locked' }, 'db-locked'],
      ['SQLITE_CANTOPEN(14) → db-open-failed', { code: 'ERR_SQLITE_ERROR', errcode: 14, errstr: 'unable to open database file' }, 'db-open-failed'],
      ['扩展码 SQLITE_CANTOPEN_ISDIR(526) → 按主码 14 归为 db-open-failed', { code: 'ERR_SQLITE_ERROR', errcode: 526, errstr: 'unable to open database file' }, 'db-open-failed'],
      ['SQLITE_FULL(13) → db-disk-full', { code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' }, 'db-disk-full'],
      ['fs EACCES → db-permission-denied', { code: 'EACCES', message: 'EACCES: permission denied' }, 'db-permission-denied'],
      ['fs EPERM → db-permission-denied', { code: 'EPERM', message: 'EPERM: operation not permitted' }, 'db-permission-denied'],
      ['fs EROFS → db-readonly', { code: 'EROFS', message: 'read-only file system' }, 'db-readonly'],
      ['fs ENOSPC → db-disk-full', { code: 'ENOSPC', message: 'no space left on device' }, 'db-disk-full'],
      ['store 自设 SCHEMA_TOO_NEW → db-schema-too-new', { code: 'SCHEMA_TOO_NEW', message: 'newer than this build' }, 'db-schema-too-new'],
      ['node:sqlite 缺失 → db-unavailable', { code: 'SQLITE_UNAVAILABLE', message: 'no sqlite' }, 'db-unavailable'],
      ['文本 "malformed" → db-corrupt', { message: 'database disk image is malformed' }, 'db-corrupt'],
      ['完全未知 → db-open-failed（有类别，不是空）', { message: 'something nobody predicted' }, 'db-open-failed']
    ];
    const wrong = [];
    for (const [label, error, expect] of cases) {
      const got = c.classify(error);
      if (got.reason !== expect || c.REASONS.indexOf(got.reason) < 0) wrong.push(label + ' → ' + got.reason + ' (expect ' + expect + ')');
    }
    check('C1 十六类错误各归各类，且结果永远落在闭集里', wrong.length === 0, wrong);

    check('C2 扩展码按 SQLite 自己的主码规则还原（526 → 14）',
      c.primaryCodeOf(526) === 14 && c.primaryCodeOf(26) === 26 && c.primaryCodeOf(0) === 0);

    check('C3 只有完整性结论能授权隔离：NOTADB/CORRUPT 可以，READONLY/BUSY/权限/打不开/磁盘满都不行',
      c.allowsQuarantine({ errcode: 26 }) === true &&
      c.allowsQuarantine({ errcode: 11 }) === true &&
      c.allowsQuarantine({ errcode: 8 }) === false &&
      c.allowsQuarantine({ errcode: 5 }) === false &&
      c.allowsQuarantine({ code: 'EACCES' }) === false &&
      c.allowsQuarantine({ errcode: 14 }) === false &&
      c.allowsQuarantine({ errcode: 13 }) === false &&
      c.allowsQuarantine({ errcode: 526 }) === false,
      { quarantine: [26, 11, 8, 5, 14, 13, 526].map(x => c.allowsQuarantine({ errcode: x })) });

    check('C4 quick_check 的结论是一个值：只有 "ok" 才算完好',
      c.integrityVerdictOk('ok') === true && c.integrityVerdictOk('row 3 missing') === false &&
      c.integrityVerdictOk(null) === false && c.integrityVerdictOk('') === false);

    check('C5 日志尾巴里的 [db-readonly] 标记优先于散文（传播是确定的，不是猜的）',
      c.classifyText('Home Node failed [db-readonly] attempt to write a readonly database') === 'db-readonly' &&
      c.classifyText('nothing here matches') === null);

    check('C6 toError 把类别同时写进 code 与 message（下游可读结论，不必读散文）',
      (function () {
        const e = c.toError({ errcode: 8, errstr: 'attempt to write a readonly database' });
        return e.code === 'DB_READONLY' && e.dbReason === 'db-readonly' && /^\[db-readonly\]/.test(e.message);
      })());

    check('C7 isDatabaseError 只认真正的数据库错误（编程 bug 不得被伪装成 db-open-failed）',
      c.isDatabaseError({ errcode: 5 }) === true &&
      c.isDatabaseError({ code: 'EACCES' }) === true &&
      c.isDatabaseError({ dbReason: 'db-corrupt' }) === true &&
      c.isDatabaseError(new TypeError('x.y is not a function')) === false);

    check('C8 词表与组件模型/boot-state 是同一套（不产生第二套分类）',
      (function () {
        const boot = new Set(Object.keys(bootState.REASON).map(k => bootState.REASON[k]));
        const reg = new Set(Object.keys(registry.REASON).map(k => registry.REASON[k]));
        const missing = c.REASONS.filter(r => !boot.has(r) || !reg.has(r));
        return missing.length === 0;
      })(), c.REASONS.filter(r => !(new Set(Object.keys(bootState.REASON).map(k => bootState.REASON[k]))).has(r)));
  }

  /* ── §DB · 真实 SQLite 行为（real SQLite behaviour test） ─────────────── */
  if (wants('DB')) {
    section('§DB \u00b7 real SQLite behaviour on chat-store');

    /* DB1 只读文件：open 必须**失败**并且分类为 db-readonly。
       （修复前：open 返回 ok:true、isOpen()===true、探针 healthy，而每一条写入都
        抛 SQLITE_READONLY —— 一个写不进任何东西的库被报成健康。） */
    if (!WIN) skip('DB1 只读文件 → db-readonly', 'Windows-only (attrib +R)');
    else {
      const d = tmpDir('db-ro');
      const info = seedStore(d, 3);
      setReadonlyFile(info.file);
      const out = openOutcome(d);
      clearReadonlyFile(info.file);
      check('DB1 只读文件：open 以 db-readonly 失败，而不是"打开成功但写不进去"',
        out.ok === false && out.reason === 'db-readonly' && out.isOpen === false, out);
      check('DB2 只读文件**不得**被当作损坏隔离（数据还在原处）',
        quarantineFiles(d).length === 0 && dirListing(d).indexOf('home-node.db') >= 0 &&
        messageCountOf(info.file) === 3,
        { files: dirListing(d), messages: messageCountOf(info.file) });
      rmrf(d);
    }

    /* DB3 权限被拒（连读都不行）→ db-permission-denied，且绝不隔离。 */
    if (!WIN) skip('DB3 文件不可读 → db-permission-denied', 'Windows-only (icacls)');
    else {
      const d = tmpDir('db-perm');
      const info = seedStore(d, 2);
      denyAce(info.file, 'R');
      const out = openOutcome(d);
      const quarantined = quarantineFiles(d).length;
      /* 先按原样确认它确实读不出来，再解除限制读回数据 —— 断言"文件还在原地"用
         listing 就够了，但断言"数据没丢"必须真的把内容读出来。 */
      const unreadable = messageCountOf(info.file);
      removeDeny(info.file);
      const alive = messageCountOf(info.file);
      check('DB3 文件不可读：分类为 db-permission-denied（不是 db-corrupt）',
        out.ok === false && out.reason === 'db-permission-denied', out);
      check('DB4 权限问题**不得**触发损坏隔离：没有 .corrupt-* 文件，解除限制后两条消息仍在',
        quarantined === 0 && unreadable === -1 && alive === 2,
        { quarantined: quarantined, whileDenied: unreadable, afterRestore: alive });
      rmrf(d);
    }

    /* DB5 侧车路径被挡住（WAL 位置被一个目录占住）：
       库文件本身完好、未被占用、目录可写 —— 这是"探针失败 ≠ 库坏了"最能说明问题
       的一种。修复前 triage 实测：open 返回 ok:true 且 recoveredFromCorrupt 指向
       一个被改名的库，新的空库顶上，/health 报 open:true。也就是说 7 条消息在
       全绿的状态里消失。 */
    {
      const d = tmpDir('db-sidecar');
      const info = seedStore(d, 7);
      fs.mkdirSync(info.file + '-wal');
      const out = openOutcome(d);
      const quarantined = quarantineFiles(d);
      /* 侧车被挡住时连原生打开都失败（这正是失败的样子），所以先移开障碍再把数据
         读回来：这既证明"库完好"，也证明"我们什么都没搬走"。 */
      const blocked = messageCountOf(info.file);
      /* 防御式：如果隔离闸门被摘掉，这个 -wal 目录会被当成侧车改名搬走（那正是
         DB6 要抓的失败），此时它已经不在原地了 —— 测试不该因此炸在 harness 里，
         而应该让 DB5/DB6 如实变红。 */
      if (fs.existsSync(info.file + '-wal')) fs.rmdirSync(info.file + '-wal');
      const reopened = messageCountOf(info.file);
      check('DB5 WAL 侧车路径被挡住：开库失败并分类为 db-open-failed（不是 db-corrupt）',
        out.ok === false && out.reason === 'db-open-failed' && blocked === -1, { out: out, whileBlocked: blocked });
      check('DB6 该失败**不得**隔离完好库：没有 .corrupt-* 文件，移开障碍后七条消息原地保留',
        quarantined.length === 0 && reopened === 7, { quarantined: quarantined, messages: reopened });
      rmrf(d);
    }

    /* DB7 真正的损坏仍然要被隔离 —— 收紧闸门不能把该做的事也一起挡掉。 */
    {
      const d = tmpDir('db-corrupt');
      const info = seedStore(d, 4);
      fs.writeFileSync(info.file, Buffer.alloc(4096, 0x41));
      const out = openOutcome(d);
      const quarantined = quarantineFiles(d);
      check('DB7 真正的损坏：仍然隔离（改名保留，绝不删除），并以新库继续',
        out.ok === true && out.isOpen === true && quarantined.length >= 1, { out: out, quarantined: quarantined });
      rmrf(d);
    }

    /* DB8 schema 过新：拒绝降级写入，且分类稳定。 */
    {
      const d = tmpDir('db-schema');
      const info = seedStore(d, 1);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(info.file);
      db.exec("UPDATE meta SET value='99' WHERE key='schema_version'");
      db.close();
      const out = openOutcome(d);
      check('DB8 schema 过新：以 db-schema-too-new 拒绝打开（不降级写入、不动文件）',
        out.ok === false && out.reason === 'db-schema-too-new' && quarantineFiles(d).length === 0, out);
      rmrf(d);
    }

    /* DB9 另一个连接持有写锁：WAL 下读仍然可用，开库不得因此失败。 */
    {
      const d = tmpDir('db-busy');
      const info = seedStore(d, 2);
      const { DatabaseSync } = require('node:sqlite');
      const holder = new DatabaseSync(info.file);
      holder.exec('PRAGMA busy_timeout = 5000');
      holder.exec('BEGIN IMMEDIATE');
      holder.exec("INSERT INTO meta (key, value) VALUES ('lock-probe','1') ON CONFLICT(key) DO UPDATE SET value='1'");
      const out = openOutcome(d);
      try { holder.exec('ROLLBACK'); holder.close(); } catch (_) { /* best effort */ }
      check('DB9 并发写锁（WAL）：开库成功且**不**隔离（reader 不该被锁吓退，更不该被判成损坏）',
        out.ok === true && out.isOpen === true && quarantineFiles(d).length === 0, out);
      rmrf(d);
    }

    /* DB10 目录不可写（两个方向都属于 §DB，但它同时证明"环境问题不会走到改名"）。 */
    if (!WIN) skip('DB10 目录不可写 → 分类为非损坏', 'Windows-only (icacls)');
    else {
      const d = tmpDir('db-dirro');
      seedStore(d, 1);
      denyAce(d, 'W,D');
      const out = openOutcome(d);
      removeDeny(d);
      check('DB10 目录不可写：报成 db-open-failed（修复前这里报的是 "chat store is corrupt"）',
        out.ok === false && out.reason === 'db-open-failed' && out.reason !== 'db-corrupt', out);
      rmrf(d);
    }
  }

  /* ── §HEALTH · health truthfulness ────────────────────────────────────── */
  let hn = null;
  if (wants('HEALTH')) {
    section('§HEALTH \u00b7 reachable != able to serve');
    const dir = tmpDir('health');
    const port = await freePort();
    hn = homeNodeService.buildHomeNode({ dataDir: dir, token: 'p11-3x-b-token-0123456789', loopbackBind: true, listenPort: port, mobileOrigins: [] });
    hn.open();
    await new Promise(r => hn.server.listen(port, '127.0.0.1', r));
    const homeComp = registry.byId('homeNode');

    /* H1 store open → healthy（真实健康不得被这次收紧误伤） */
    {
      const h = await request(port, 'GET', '/health');
      const probe = await registry.probeComponent(homeComp, { port: port, host: '127.0.0.1' });
      check('H1 store open：/health ok:true + serving:true，探针 healthy',
        h.status === 200 && h.body.ok === true && h.body.serving === true && h.body.failure === null &&
        probe.state === 'healthy' && probe.healthy === true,
        { health: { ok: h.body.ok, serving: h.body.serving, failure: h.body.failure }, probe: probe.state });
    }

    /* H2/H3 store closed（HTTP server 还活着）→ 必须不再 healthy。
       这是本阶段的承重断言：修复前实测 /health = {ok:true, open:false} 且
       探针报 healthy —— 一个连一条聊天都写不进去的进程被报成健康组件。 */
    hn.store.close();
    {
      const h = await request(port, 'GET', '/health');
      const probe = await registry.probeComponent(homeComp, { port: port, host: '127.0.0.1' });
      check('H2 store closed：/health 不再声称 ok，明确给出 open:false + serving:false + 失败的类别',
        h.status === 200 && h.body.ok === false && h.body.open === false && h.body.serving === false &&
        h.body.failure && h.body.failure.category === 'store-closed',
        { ok: h.body.ok, open: h.body.open, serving: h.body.serving, failure: h.body.failure });
      check('H3 store closed：探针报 error（可达但干不了活），而不是 healthy，也不是 conflict',
        probe.state === 'error' && probe.healthy === false && probe.reachable === true &&
        probe.identityOk === true && probe.reason && probe.reason.category === 'store-closed',
        { state: probe.state, healthy: probe.healthy, reachable: probe.reachable, identityOk: probe.identityOk, reason: probe.reason });

      /* H4 聚合不得把 store-closed 洗成 healthy。 */
      const agg = registry.aggregate([probe, registry.componentReport(registry.byId('bridge'), { state: 'healthy' })]);
      const row = agg.components.find(c => c.id === 'homeNode');
      check('H4 聚合：store-closed 的组件进入 errored，healthy 计数不含它，overall 不得是 healthy',
        row.healthy === false && row.state === 'error' &&
        agg.errored.indexOf('homeNode') >= 0 && agg.overall !== 'healthy',
        { state: row.state, healthy: row.healthy, errored: agg.errored, overall: agg.overall });

      /* H5 boot-state：组件行同样不得被洗白。启动裁决与组件状态是两个问题 ——
         Home Node 的 affectsOverall 恒为 false（P11-3B 的刻意决定：它不在不该让
         桌面启动变 degraded），所以这里断言的是"组件行如实"，并同时证明同样条件
         落在 affectsOverall 组件上时启动裁决**会**下降。 */
      const st = bootState.buildBootState({
        phase: 'complete', opened: true, now: Date.now(),
        components: { static: { healthy: true, state: 'healthy', probed: true }, homeNode: { healthy: probe.healthy, state: probe.state, probed: true, reason: probe.reason } }
      });
      const stDeg = bootState.buildBootState({
        phase: 'complete', opened: true, now: Date.now(),
        components: { static: { healthy: true, state: 'healthy', probed: true }, bridge: { healthy: false, state: 'error', probed: true, reason: probe.reason } }
      });
      check('H5 boot-state：组件行 healthy:false / state:error（未洗白），且同类条件落在 affectsOverall 组件上时 overall=degraded',
        st.components.homeNode.healthy === false && st.components.homeNode.state === 'error' &&
        st.components.homeNode.reason && st.components.homeNode.reason.category === 'store-closed' &&
        stDeg.overall === 'degraded',
        { homeNode: st.components.homeNode, overall: st.overall, degradedCase: stDeg.overall });

      /* H6 监督者基于**真实** health 进入恢复路径：runner 对"在线"的判据是
         HTTP 200 + ok:true（requestJson），所以 store-closed 必须让它不再算在线，
         连续两次探测失败后监督者必须给出 retry —— 这正是过去做不到的一步：
         ok 恒为 true 时探针永远 healthy，健康驱动的恢复永远不会被触发。 */
      const onlineByRunnerRule = h.status >= 200 && h.status < 300 && h.body.ok === true;
      const sup = new supervisorModule.Supervisor({ policy: { maxAttempts: 3, windowMs: 60000, baseBackoffMs: 100, maxBackoffMs: 500, healthFailStreak: 2 } });
      sup.register('homeNode', 'Home Node');
      const first = sup.handle('homeNode', supervisorModule.EVENT.HEALTH_FAIL, { restartable: true, reason: 'store-closed' });
      const second = sup.handle('homeNode', supervisorModule.EVENT.HEALTH_FAIL, { restartable: true, reason: 'store-closed' });
      check('H6 store-closed 不再算"在线"，两次连续失败探测后监督者给出 retry（健康驱动的恢复第一次真的可达）',
        onlineByRunnerRule === false && first.action === 'none' && second.action === 'retry',
        { onlineByRunnerRule: onlineByRunnerRule, first: first.action, second: second.action });
    }

    /* H7 身份不符 / 不可达：两类都必须保持各自的语义，绝不被新逻辑吞掉。 */
    {
      const conflictServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, server: 'Somebody Else' }));
      });
      openServers.add(conflictServer);
      const cport = await new Promise(r => conflictServer.listen(0, '127.0.0.1', () => r(conflictServer.address().port)));
      const conflict = await registry.probeComponent(homeComp, { port: cport, host: '127.0.0.1' });
      conflictServer.close();
      openServers.delete(conflictServer);
      const gone = await registry.probeComponent(homeComp, { port: await freePort(), host: '127.0.0.1' });
      check('H7 身份不符仍是 conflict、不可达仍是 offline（收紧 store 语义不得改写另外两类）',
        conflict.state === 'conflict' && conflict.healthy === false && conflict.reachable === true &&
        (gone.state === 'offline') && gone.healthy === false,
        { conflict: conflict.state, gone: gone.state });
    }

    /* H8 探针失败原因里必须写**真实**端口与真实耗时。
       修复前实测（runner 自己的视图）：真实失败发生在 12212，报文却写 23115 且
       "within 0ms" —— 把排查引到一个不是问题所在的端口。 */
    {
      const squatted = await freePort();
      const squatter = await startSilentSquatter(squatted);
      const probe = await registry.probeComponent(registry.byId('bridge'), { port: squatted, host: '127.0.0.1', timeoutMs: 700 });
      squatter.close();
      const msg = (probe.reason && probe.reason.message) || '';
      check('H8 超时原因写明真实端口与真实耗时（不再是 defaultPort + "within 0ms"）',
        probe.state === 'offline' && probe.reason && probe.reason.category === 'timeout' &&
        msg.indexOf(String(squatted)) >= 0 && !/within 0ms/.test(msg),
        { port: squatted, message: msg });
    }

    /* H9 无法服务的 store 不得回答"你的请求有错"：400 会把调用方引去改一个
       本来没问题的请求体，而设备面对同一条件的回答是 503。 */
    {
      const post = await request(port, 'POST', '/messages',
        {
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1', 'X-IB-Home-Token': 'p11-3x-b-token-0123456789' },
          body: { message: { id: 'x1', role: 'user', content: 'hi', friendId: 'f1', timestamp: 1700000000001 } }
        });
      check('H9 store 不可服务时 HTTP 回答 503 store-closed（不再是 400 "请求有问题"）',
        post.status === 503 && post.body && post.body.error === 'store-closed',
        { status: post.status, body: post.body });
    }

    try { hn.close(); } catch (_) { /* 已关闭 */ }
    await sleep(200);
    rmrf(dir);
  }

  /* ── §PORT · 端口归属与重复 runner ─────────────────────────────────────── */
  if (wants('PORT')) {
    section('§PORT \u00b7 port ownership & duplicate runner');

    /* P1 纯谓词：命令行的两种形态都要认出来 —— runner 自己 spawn 孩子用绝对路径，
       而开发者/安装器/测试可能用仓库相对路径。修复前只认绝对路径，于是**我们自己的**
       第二个 runner 被报成 foreign。 */
    const absRunner = path.join(ROOT, 'runtime', 'local-services-runner.js');
    const absBridge = path.join(ROOT, 'services', 'ib-bridge-service.js');
    check('P1 归属谓词同时认绝对路径与仓库相对路径（且不认识别人的同名文件之外的路径）',
      runnerLib.commandMatchesScript('"C:\\nodejs\\node.exe" "' + absRunner + '"', absRunner) === true &&
      runnerLib.commandMatchesScript('"C:\\nodejs\\node.exe" runtime/local-services-runner.js', absRunner) === true &&
      runnerLib.commandMatchesScript('"C:\\nodejs\\node.exe" runtime\\local-services-runner.js', absRunner) === true &&
      runnerLib.commandMatchesScript('"C:\\nodejs\\node.exe" "' + absBridge + '"', absRunner) === false &&
      runnerLib.commandMatchesScript('', absRunner) === false &&
      runnerLib.commandMatchesScript('"C:\\other\\app.exe" --serve', absRunner) === false,
      { absolute: runnerLib.commandMatchesScript('"n" "' + absRunner + '"', absRunner), relative: runnerLib.commandMatchesScript('node runtime/local-services-runner.js', absRunner) });

    /* P2 free / own 的真实分类（不需要起服务） */
    {
      const free = await freePort();
      const bindableFree = await runnerLib.portBindable(free, '127.0.0.1');
      const ownerFree = await runnerLib.classifyPortOwner(free, absBridge);
      const selfBind = net.createServer();
      openServers.add(selfBind);
      const selfPort = await new Promise(r => selfBind.listen(0, '127.0.0.1', () => r(selfBind.address().port)));
      const bindableTaken = await runnerLib.portBindable(selfPort, '127.0.0.1');
      check('P2 空端口：可绑定 + 归属 free；已被监听：不可绑定（预检在 spawn 之前就给出答案）',
        bindableFree === true && ownerFree.owner === 'free' && bindableTaken === false,
        { bindableFree: bindableFree, ownerFree: ownerFree.owner, bindableTaken: bindableTaken });
      selfBind.close();
      openServers.delete(selfBind);
    }

    /* P3 我们的服务端口被一个**静默**监听者占住：runner 必须拒绝启动该组件、
       给出占用者类别，而且**不 spawn 任何 child**、不 kill 任何人。
       修复前实测：spawn → child EADDRINUSE 退出 → 恢复两次 → failed，对外理由只有
       "exited unexpectedly (code=1)"，真正原因只在 child 的 stderr 里。 */
    {
      const ports = await freshPorts();
      const dataRoot = tmpDir('port-squat');
      const squatter = await startSilentSquatter(ports.bridge);
      const run = startRunner(runnerEnv(ports, dataRoot, {
        IB_RECOVERY_POLICY: JSON.stringify({ maxAttempts: 2, windowMs: 60000, baseBackoffMs: 200, maxBackoffMs: 400, healthFailStreak: 2 })
      }));
      const up = await waitControlPlane(ports.restart, 40000);
      check('P3 静默外部占用者下 runner 仍然起来了（控制面不受影响）', up === true, { out: run.out.slice(-400) });
      let bridgeRow = {};
      if (up) {
        for (let i = 0; i < 12; i++) {
          const comps = await componentsOf(ports.restart);
          bridgeRow = comps.find(c => c.id === 'bridge') || {};
          if (bridgeRow.portOwner) break;
          await sleep(1000);
        }
      }
      const bridgeLog = runnerLog(dataRoot, 'bridge.log');
      check('P4 拒绝把组件起进被外部占用的端口：报告 portOwner=foreign + pid + 稳定 reason',
        bridgeRow.portOwner === 'foreign' && Array.isArray(bridgeRow.portOwnerPids) &&
        bridgeRow.portOwnerPids.length >= 1 && bridgeRow.portOwnerReason === 'port-owned-by-foreign-process',
        { portOwner: bridgeRow.portOwner, pids: bridgeRow.portOwnerPids, reason: bridgeRow.portOwnerReason });
      check('P5 拒绝时**没有** spawn 任何 child（bridge.log 不存在），也没有把组件写成"重试到锁死"',
        bridgeLog === '' && bridgeRow.recoveryState === 'stopped' &&
        !/restart budget exhausted/.test(String(bridgeRow.lastFailureReason || '')),
        { bridgeLogBytes: bridgeLog.length, recoveryState: bridgeRow.recoveryState, lastFailureReason: bridgeRow.lastFailureReason });
      check('P6 外部占用者没有被杀（它还在监听同一个端口）',
        (await listenersOn(ports.bridge)).length >= 1, await listenersOn(ports.bridge));
      /* 直到这里占用者都还在。runner 的停机路径会对每个端口做有界等待
         （stopService + waitPortFree 10s），所以"端口不是我们的"会让停机变慢但
         不会让它挂住 —— 这正是安装器升级时的真实处境，值得如实覆盖。 */
      const stopped = await shutdownRunner(run, ports.restart, 40000);
      check('P7 runner 能正常停机：即使有一个端口不属于它（有界等待后仍然退出，不挂住）',
        stopped === true && run.code === 0, { code: run.code, out: run.out.slice(-300) });
      squatter.close();
      await sleep(500);
      for (const p of [ports.bridge, ports.active, ports.homeNode]) await killListeners(p);
      rmrf(dataRoot);
    }

    /* P8 重复 runner：控制面已被**我们自己的**另一个 runner 占着。
       必须在控制面启动阶段明确失败 —— 不允许"起来一个没有控制面的 runner"。
       修复前实测：B 的 listen 失败只写进 restart.log，B 继续把三个服务起了起来
       （有自己的 child、没有可用的 /status 与 /shutdown），并且 exit code 是 0。 */
    {
      const ports = await freshPorts();
      const dataRoot = tmpDir('port-dup');
      const env = runnerEnv(ports, dataRoot);
      const a = startRunner(env);
      const aUp = await waitControlPlane(ports.restart, 40000);
      const b = startRunner(env);
      let bExited = false;
      for (let i = 0; i < 60 && !bExited; i++) { if (b.exited !== null) bExited = true; else await sleep(500); }
      check('P8 重复 runner：B 明确退出（不再变成一个没有控制面的孤儿 runner）',
        bExited === true && b.code === 1, { exited: bExited, code: b.code, out: b.out.slice(-400) });
      check('P9 重复 runner：理由指明"另一个 runner 已经拥有控制面"，且没有起任何服务',
        b.out.indexOf('control-plane-already-running') >= 0 && b.out.indexOf('No service was started') >= 0,
        { out: b.out.slice(-400) });

      /* B 不得成为竞争实例：A 的 child 仍在原端口上，且没有第二个监听者。 */
      const comps = aUp ? await componentsOf(ports.restart) : [];
      const aPids = {};
      for (const c of comps) if (c.pid) aPids[c.id] = String(c.pid);
      const bridgeListeners = await listenersOn(ports.bridge);
      check('P10 重复 runner 没有制造竞争实例（每个端口只有一个监听者，且仍是 A 的 child）',
        bridgeListeners.length === 1 && (!aPids.bridge || bridgeListeners[0] === aPids.bridge),
        { listeners: bridgeListeners, aBridgePid: aPids.bridge });
      const restartAlive = (await request(ports.restart, 'GET', '/status', { timeoutMs: 2000 })).status === 200;
      check('P11 控制面仍然属于 A（没有被 B 抢占或半接管）', restartAlive === true);
      await shutdownRunner(a, ports.restart);
      await sleep(500);
      for (const p of [ports.bridge, ports.active, ports.homeNode]) await killListeners(p);
      rmrf(dataRoot);
    }
  }

  /* ── §RECOVERY · 有界 + 根因保留 ──────────────────────────────────────── */
  if (wants('RECOVERY')) {
    section('§RECOVERY \u00b7 bounded crash loop keeps the root cause');
    const ports = await freshPorts();
    const dataRoot = tmpDir('recovery');
    const homeDir = path.join(dataRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    const info = seedStore(homeDir, 1);
    if (!WIN) {
      skip('R1\u2013R4 只读库崩溃环', 'Windows-only (attrib +R)');
    } else {
      setReadonlyFile(info.file);
      const run = startRunner(runnerEnv(ports, dataRoot, {
        IB_RECOVERY_POLICY: JSON.stringify({ maxAttempts: 2, windowMs: 60000, baseBackoffMs: 200, maxBackoffMs: 400, healthFailStreak: 2 })
      }));
      const up = await waitControlPlane(ports.restart, 40000);
      let homeRow = {};
      let terminal = false;
      const deadline = Date.now() + 60000;
      while (up && Date.now() < deadline) {
        const comps = await componentsOf(ports.restart);
        homeRow = comps.find(c => c.id === 'homeNode') || {};
        if (homeRow.recoveryState === 'failed' && /db-readonly/.test(String(homeRow.lastFailureReason || ''))) { terminal = true; break; }
        await sleep(700);
      }
      const childLog = runnerLog(dataRoot, 'homenode.log');
      check('R1 控制面可用（失败组件不影响 runner 自己的生命周期）', up === true, { out: run.out.slice(-300) });
      check('R2 只读库崩溃环是**有界**的：重试次数不超过策略上限，终态为 failed',
        terminal === true && Number(homeRow.recoveryAttempts) <= Number(homeRow.recoveryMaxAttempts) &&
        homeRow.recoveryState === 'failed',
        { terminal: terminal, attempts: homeRow.recoveryAttempts, max: homeRow.recoveryMaxAttempts, state: homeRow.recoveryState });
      check('R3 终态**保留根因**：lastFailureReason 写出 db-readonly（而不是只剩 process-exit / budget exhausted）',
        /db-readonly/.test(String(homeRow.lastFailureReason || '')),
        { lastFailureReason: homeRow.lastFailureReason });
      check('R4 终态同时回答"为什么不再试了"：lockout 理由先写（不被截断吃掉），根因作为上下文跟在后面',
        /budget exhausted|locked-out/.test(String(homeRow.recoveryFailedReason || '')) &&
        /db-readonly/.test(String(homeRow.recoveryFailedReason || '')),
        { recoveryFailedReason: homeRow.recoveryFailedReason, lastFailureReason: homeRow.lastFailureReason });
      check('R5 child 自己的日志里也能看到类别（[db-readonly]），排障不需要读驱动原文',
        /\[db-readonly\]/.test(childLog), { tail: childLog.slice(-300) });
      await shutdownRunner(run, ports.restart);
      clearReadonlyFile(info.file);
      await sleep(400);
      for (const p of [ports.bridge, ports.active, ports.homeNode]) await killListeners(p);
      check('R6 整个崩溃环之后，只读的库**一个字节都没被搬走**（数据仍可读，且没有 .corrupt-*）',
        quarantineFiles(homeDir).length === 0 && messageCountOf(info.file) === 1,
        { files: dirListing(homeDir), messages: messageCountOf(info.file) });
      rmrf(dataRoot);
    }
  }

  /* ── §RECOVERY 契约层：lockout 不得吞掉根因 ─────────────────────────────
     上面的 R1–R6 是真实进程与真实端口，因此它们证明"端到端确实如此"；但它们也
     依赖事件到达顺序：一个在途的重启尝试可能在 lockout **之后**再报一次失败，于是
     终态被重新叙述一遍。也就是说 R3 抓不住"锁死时覆盖根因"这个决策本身。
     决策住在 supervisor 里，所以这里直接对那个决策下断言 —— 确定、无时序。 */
  if (wants('RECOVERY')) {
    const sup = new supervisorModule.Supervisor({
      policy: { maxAttempts: 1, windowMs: 60000, baseBackoffMs: 50, maxBackoffMs: 200, healthFailStreak: 2 }
    });
    sup.register('homeNode', 'Home Node');
    const cause = 'db-readonly: Home Node failed to open its canonical store';
    const first = sup.handle('homeNode', supervisorModule.EVENT.PROCESS_EXIT, { restartable: true, code: 1, signal: null, reason: cause });
    sup.noteAttempt('homeNode');            /* 唯一的预算名额被这次尝试用掉 */
    const second = sup.handle('homeNode', supervisorModule.EVENT.PROCESS_EXIT, { restartable: true, code: 1, signal: null, reason: cause });
    const view = sup.describe('homeNode');
    check('R7 锁死时根因必须留下：lastFailureReason 保留 db-readonly，failedReason 说明为什么不再试',
      first.action === 'retry' && second.action === 'failed' &&
      /db-readonly/.test(String(view.lastFailureReason || '')) &&
      String(view.lastFailureReason) !== String(view.failedReason) &&
      /budget exhausted|locked-out/.test(String(view.failedReason || '')),
      { first: first.action, second: second.action, lastFailureReason: view.lastFailureReason, failedReason: view.failedReason });
    check('R8 锁死是一次性的：同一个组件不会因为再次收到失败信号而恢复重试资格',
      sup.handle('homeNode', supervisorModule.EVENT.PROCESS_EXIT, { restartable: true, code: 1, reason: cause }).action === 'failed' &&
      sup.authorizeAttempt('homeNode').allowed === false);
  }

  /* ── §SHUTDOWN · 生产停止路径 ─────────────────────────────────────────── */
  if (wants('SHUTDOWN')) {
    section('§SHUTDOWN \u00b7 production stop path');
    const port = await freePort();
    const dir = tmpDir('shutdown');
    const child = spawn(process.execPath, ['services/home-node-service.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { IB_HOME_NODE_PORT: String(port), IB_HOME_NODE_DATA_DIR: dir }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    openChildren.add(child);
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code: code, signal: signal }; openChildren.delete(child); });
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await request(port, 'GET', '/health', { timeoutMs: 1500 }); if (r.status === 200) { up = true; break; } } catch (_) { /* 还没起来 */ }
      await sleep(250);
    }
    const wrote = await request(port, 'POST', '/messages', {
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
      body: { message: { id: 's1', role: 'user', content: 'survives the stop path', friendId: 'f1', timestamp: 1700000000001 } }
    });
    check('S1 真实 Home Node 起来了并接受了一次写入', up === true && wrote.status === 200, { up: up, status: wrote.status });

    /* 生产停止路径：runtime/local-services-runner.js stopService() 的第一步就是
       child.kill('SIGTERM')。 */
    child.kill('SIGTERM');
    for (let i = 0; i < 60 && exited === null; i++) await sleep(250);
    check('S2 子进程确实结束了（没有留下半活着的服务）', exited !== null, exited);

    const freed = await portFree(port);
    check('S3 端口真的释放了（能被重新绑定，而不是只在表里显示关了）', freed === true, { port: port });

    const reopened = openOutcome(dir);
    const count = messageCountOf(path.join(dir, 'home-node.db'));
    check('S4 停止后库能被重新打开，且停止前提交的数据仍在（WAL 恢复成立）',
      reopened.ok === true && reopened.isOpen === true && count === 1, { reopened: reopened, messages: count });

    check('S5 没有残留 child：端口空闲且进程已退出',
      (await listenersOn(port)).length === 0 && exited !== null, { listeners: await listenersOn(port) });

    /* 平台事实（不是断言，只打印）：Windows 上 Node 的 child.kill('SIGTERM') 是
       TerminateProcess，服务自己的 SIGTERM handler 不会运行 —— 也就是说这条路径
       是**硬停**，不是优雅关闭。S3/S4 证明硬停仍然是安全且可恢复的；把"优雅"当成
       既有事实才是这里真正会骗人的地方。本轮观测：见下。 */
    console.log('  note: stop path observed as ' + (exited && exited.signal === 'SIGTERM' ? 'hard terminate (signal SIGTERM, handler not delivered on this platform)' : 'clean exit code=' + (exited && exited.code)));
    rmrf(dir);
  }

  /* ── §SHIP · 新增的运行时依赖必须真的进发行包 ───────────────────────────
     发行清单是**逐文件白名单**，不是 glob：新增一个被启动链 require 的运行时模块
     而忘记登记，开发机全绿、安装后必崩（而且是"启动失败但看不出为什么"这种）。
     这里不写死文件名，而是从**随包发布的源码**里把跨目录 require 扫出来，逐个确认
     目标也在包里 —— 换名字、加依赖都不会让这条断言失效。 */
  if (wants('SHIP')) {
    section('§SHIP \u00b7 shipped runtime closure');
    const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));
    const tos = new Set(manifest.resolve({}).files.map(f => f.to));
    check('SH1 runtime/db-failure.js 在发行清单里（store 与组件模型启动期都 require 它）',
      tos.has('runtime/db-failure.js'),
      [...tos].filter(f => f.indexOf('runtime/') === 0));

    const shippedSources = [...tos].filter(f => /^(runtime|services|bridge|active)\/.*\.js$/.test(f));
    const inPayload = rel => {
      /* Node 的解析顺序里目录/无扩展名的 require 是合法的（./util → util.js，
         ./asr → asr/index.js），所以闭合检查必须按同一条规则解析，否则它会把
         一堆正常依赖报成缺口 —— 一个只会误报的检查等于没有检查。 */
      const candidates = [rel, rel + '.js', rel + '/index.js', rel + '.json', rel + '/index.json'];
      return candidates.some(c => tos.has(c) || [...tos].some(t => c.indexOf(t + '/') === 0));
    };
    const missing = [];
    for (const rel of shippedSources) {
      let src = '';
      try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { continue; }
      const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
        if (!fs.existsSync(path.join(ROOT, target)) && !fs.existsSync(path.join(ROOT, target + '.js'))) continue;
        if (!inPayload(target)) missing.push(rel + ' -> ' + target);
      }
    }
    check('SH2 随包运行时源码的跨模块 require 全部闭合（开发机与安装包不会出现"少一个文件"的启动崩溃）',
      missing.length === 0, missing.slice(0, 8));
  }

  /* ── 回收并报告残留 ───────────────────────────────────────────────────── */
  const cleanup = [];
  try { if (hn) hn.close(); } catch (e) { cleanup.push('home-node close: ' + String(e && e.message || e)); }
  for (const s of [...openServers]) { try { s.close(); } catch (e) { cleanup.push('server close: ' + String(e && e.message || e)); } }
  for (const c of [...openChildren]) { try { c.kill(); } catch (e) { cleanup.push('child kill: ' + String(e && e.message || e)); } }
  await sleep(600);
  /* 私有端口上的残留监听者（如果某个 runner 没被收干净） */
  for (const c of [...openChildren]) { try { c.kill('SIGKILL'); } catch (_) { /* best effort */ } }
  const leaked = { children: openChildren.size, servers: [...openServers].filter(s => s.listening).length };

  rmrf(HN_DIR);
  rmrf(RUNNER_LOGDIR_ROOT);

  console.log('\n' + '\u2500'.repeat(60));
  console.log('P11-3X-B \u00b7 Runtime / DB reliability: ' + passed + ' passed, ' + failed + ' failed' +
    (skipped ? ', ' + skipped + ' skipped' : ''));
  if (WANT.length) console.log('sections filter: ' + WANT.join(','));
  console.log('resources: children=' + leaked.children + ' listeningServers=' + leaked.servers +
    (cleanup.length ? ' cleanupErrors=' + JSON.stringify(cleanup) : ''));
  if (failed) console.log('first failures: ' + failures.slice(0, 5).join(' | '));

  /* 泄漏哨兵：unref 过的定时器只有在**还有别的句柄挂着**时才会触发。
     也就是说：进程自然退出 = 没有泄漏；这条打印出来 = 有东西没释放。 */
  const watchdog = setTimeout(() => {
    console.log('\u2718 FAIL  resource leak: the event loop is still alive after cleanup');
    process.exit(2);
  }, 3000);
  watchdog.unref();

  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error('HARNESS ERROR ' + String(error && error.stack || error));
  process.exit(2);
});
