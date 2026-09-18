/* ══════════════════════════════════════════════════════════════════════
   P22-20 · Economy Public Surface Freeze（§8）+ UI 入口审计（§9）

   §8 要求生成 `ECONOMY_PUBLIC_SURFACE.md` 并冻结四个面：
        Read        GET /economy/* + GET /security
        Write       /internal/economy/{configuration,approval-decision,command}
        Capability  PROPOSE_PURCHASE / RESUME_APPROVED_PURCHASE
        Not present BUY / PAY / REFUND / EXCHANGE / TRANSFER / TOPUP / WITHDRAW

   ★ 这一条测试**解析那份文档**，再与**真实代码**比对：
       · 路由表 —— `services/home-node/http.js` 里真的路由判定；
       · 写面   —— 三个 seam 的 `describe().commands` 与 `path`；
       · 能力   —— 契约的 `CAPABILITY` 与 `CONSUMER_CAPABILITY_MATRIX`。
     因此"文档说只有 28 条读面"不是一句话，而是一条会被代码推翻的断言。

   ★ 另外两件事：
       · 本进程 HTTP（socket = 1）：把 28 条读面真的请求一遍、把每一条 POST
         一遍（必须 405）、把九个"未来能力"路径 POST 一遍（必须 404），
         并证明这一整轮之后 change log **逐字没变**；
       · §9：把三个真实渲染器（P22-15 / P22-16 / P22-17-18 外壳）挂在
         一个 DOM 桩上渲染出来，把**页面上每一个按钮的文案**收出来逐个断言
         —— 没有购买 / 充值 / 兑换 / 退款 / 支付 / 提现 / 转账入口。

   ── 资源（§11）────────────────────────────────────────────────────────
     本进程 1 个 server + 1 个 socket（不 spawn、不开第二个 Home Node、
     不开浏览器）。一个临时目录，进程退出时退避重试删除。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + J(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }

const SURFACE_DOC = 'docs/contracts/economy/ECONOMY_PUBLIC_SURFACE.md';
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

/* ══════════════════════════════════════════════════════════════════════
   第一部分 · 文档 ↔ 真实代码
   ══════════════════════════════════════════════════════════════════════ */

/* 从 `## n · Title` 到下一个 `## ` 之间取表格行。 */
function docSection(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => l.indexOf('## ') === 0 && l.indexOf(title) >= 0);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}
function docReadRoutes(md) {
  /* ★ `.filter(Boolean)` 不够：`(l.match(...) || [])` 返回的**空数组**是
     truthy，于是不匹配的行也会被 map 出一个 undefined。开发期实测：那份
     文档的 Read 一节有 39 行，而"读面"也被数成 39 条 —— 一个安静地把每个
     数字都变大的解析器。因此这里显式判 `m && m[2]`。 */
  return docSection(md, '· Read')
    .map(l => l.match(/^\|\s*`(GET)`\s*\|\s*`([^`]+)`\s*\|/))
    .filter(m => m && m[2]).map(m => m[2]);
}
function docWritePaths(md) {
  const out = [];
  for (const l of docSection(md, '· Write')) {
    const m = l.match(/^\|\s*`(POST)`\s*\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|/);
    if (!m || !m[2]) continue;
    out.push({
      path: m[2],
      commands: (m[4].match(/`([A-Z_]+)`/g) || []).map(s => s.replace(/`/g, '')).sort()
    });
  }
  return out;
}
function docCapabilities(md) {
  return docSection(md, '· Capability')
    .map(l => l.match(/^\|\s*`([A-Z_]+)`\s*\|/))
    .filter(m => m && m[1]).map(m => m[1]);
}
function docAbsentWords(md) {
  return docSection(md, '· Not present')
    .map(l => l.match(/^\|\s*`([A-Z_]+)`\s*\|/))
    .filter(m => m && m[1]).map(m => m[1]);
}

const md = read(SURFACE_DOC);

/* ── 真实路由表 ────────────────────────────────────────────────────── */
const httpSrc = read('services/home-node/http.js');
const realReadRoutes = [];
for (const line of httpSrc.split(/\r?\n/)) {
  const m = /path === '([^']+)'\s*&&\s*method === '([A-Z]+)'/.exec(line);
  if (m && (m[1].indexOf('/economy/') === 0 || m[1] === '/security')) realReadRoutes.push(m[2] + ' ' + m[1]);
}
const realReadGet = realReadRoutes.filter(r => r.indexOf('GET ') === 0).map(r => r.slice(4));

/* ── 真实写面 ──────────────────────────────────────────────────────── */
/* 三条写面各有各的工厂与词表常量名（刻意不同名：它们本来就是三条不同的路）。
   这里两条都取：`describe()` 的**自述**，以及模块导出的**常量**，并要求两者
   一致 —— 于是"文档抄的是常量、而 describe 说的是另一回事"也会红。 */
const WRITE_SEAMS = [
  {
    key: 'configuration',
    rel: 'services/home-node/economy-configuration.js',
    pathConst: 'CONFIGURATION_PATH',
    listConst: 'COMMAND_LIST',
    make: function (mod) { return mod({ store: {}, decide: function () { }, logger: function () { } }); },
    describeField: 'commands'
  },
  {
    key: 'approvalDecision',
    rel: 'services/home-node/economy-approval-decision.js',
    pathConst: 'DECISION_PATH',
    listConst: 'DECISION_LIST',
    make: function (mod) { return mod({ store: {}, decide: function () { }, logger: function () { } }); },
    describeField: 'decisions'
  },
  {
    key: 'command',
    rel: 'services/home-node/economy-command-channel.js',
    pathConst: 'COMMAND_PATH',
    listConst: 'COMMAND_LIST',
    make: function (mod) { return mod.createEconomyCommandChannel({ store: {}, logger: function () { } }); },
    describeField: 'commands'
  }
];
const realWrite = WRITE_SEAMS.map(spec => {
  const mod = require(path.join(ROOT, spec.rel));
  const described = spec.make(mod).describe();
  const fromDescribe = (described[spec.describeField] || []).slice().sort();
  const fromConstant = (mod[spec.listConst] || []).slice().sort();
  return {
    key: spec.key,
    path: mod[spec.pathConst],
    commands: fromConstant.length ? fromConstant : fromDescribe,
    describeMatchesConstant: fromDescribe.length > 0 && fromDescribe.join(',') === fromConstant.join(',')
  };
});

/* ══════════════════════════════════════════════════════════════════════
   §8 · 四张表逐个比对
   ══════════════════════════════════════════════════════════════════════ */
function part8() {
  section('§8 · Read：文档 vs http.js 的真实路由判定');

  const documented = docReadRoutes(md).slice().sort();
  const real = realReadGet.slice().sort();
  const missingInDoc = real.filter(r => documented.indexOf(r) < 0);
  const extraInDoc = documented.filter(r => real.indexOf(r) < 0);

  check('N1 ★★★★★ 文档列的读面与 http.js 里真实的路由判定**逐个相同**（28 条 /economy/* + 1 条 /security）',
    documented.length === real.length && missingInDoc.length === 0 && extraInDoc.length === 0,
    { documentedN: documented.length, realN: real.length, missingInDoc: missingInDoc, extraInDoc: extraInDoc });

  check('N2 ★★★★★ 读面全部是 GET：http.js 里没有任何一条 /economy/* 的路由判定接受别的 method',
    realReadRoutes.length === realReadGet.length &&
    realReadRoutes.every(r => r.indexOf('GET ') === 0) &&
    realReadGet.every(r => r.indexOf('/economy/') === 0 || r === '/security'));

  section('§8 · Write：文档 vs 三个 seam 的 describe()');

  const documentedWrites = docWritePaths(md);
  const realPaths = realWrite.map(w => w.path).sort();
  check('N3 ★★★★★ 文档列的三条写路径与三个 seam 的 `path` 常量逐个相同，且都**不在** `/economy/` 下',
    documentedWrites.length === 3 &&
    documentedWrites.map(w => w.path).sort().join(',') === realPaths.join(',') &&
    realPaths.every(p => p.indexOf('/economy/') !== 0));

  check('N4 ★★★★★ 每条写面允许的**命令词 / 决定词**与 seam 自己说的逐个相同（文档不许自己发明词；describe 也必须与模块常量一致）',
    (function () {
      const rows = documentedWrites.map(w => {
        const seam = realWrite.filter(x => x.path === w.path)[0];
        return { path: w.path, doc: w.commands.join(','), seam: (seam ? seam.commands : []).slice().sort().join(',') };
      });
      return rows.length === 3 &&
        rows.every(r => r.doc.length > 0 && r.doc === r.seam) &&
        realWrite.every(s => s.describeMatchesConstant === true) &&
        realWrite.reduce((n, s) => n + s.commands.length, 0) === 6 /* 3 + 2 + 1 */;
    })(), {
      doc: documentedWrites.map(w => ({ path: w.path, commands: w.commands })),
      seam: realWrite.map(s => ({ path: s.path, commands: s.commands, describeMatchesConstant: s.describeMatchesConstant }))
    });

  section('§8 · Capability / Not present');

  check('N5 ★★★★★ 文档列的 capability 恰好是契约里的两个，一个不多一个不少',
    docCapabilities(md).slice().sort().join(',') === Object.keys(C.CAPABILITY).slice().sort().join(','),
    { doc: docCapabilities(md), contract: Object.keys(C.CAPABILITY) });

  const ABSENT_EXPECTED = ['BUY', 'PAY', 'REFUND', 'EXCHANGE', 'TRANSFER', 'TOPUP', 'WITHDRAW'];
  const absentDoc = docAbsentWords(md);
  check('N6 ★★★★★ 文档的"Not present"表恰好覆盖 §8 点名的七个词',
    ABSENT_EXPECTED.every(w => absentDoc.indexOf(w) >= 0) && absentDoc.length >= ABSENT_EXPECTED.length,
    { doc: absentDoc, expected: ABSENT_EXPECTED });

  check('N7 ★★★★★ 这七个词**真的**不在任何能力/命令/路由里（文档不是自我声明，而是被代码证明）',
    (function () {
      const channel = require(path.join(ROOT, 'services', 'home-node', 'economy-command-channel.js'));
      const allCommands = channel.COMMAND_LIST.concat(channel.FORBIDDEN_COMMANDS);
      return ABSENT_EXPECTED.every(w => {
        const inCapability = Object.keys(C.CAPABILITY).some(c => c.indexOf(w) >= 0);
        const inCommand = allCommands.some(c => c.indexOf(w) >= 0 && channel.FORBIDDEN_COMMANDS.indexOf(c) < 0);
        const inRoute = realReadGet.some(r => r.toLowerCase().indexOf(w.toLowerCase()) >= 0);
        return !inCapability && !inCommand && !inRoute;
      });
    })());

  check('N8 ★★★★★ 而且它们**被写进**了 /security 的 unreachable 名单（"不存在"是一条可读的事实，不是沉默）',
    (function () {
      const denied = (httpSrc.match(/unreachable:\s*\[[^\]]*\]/g) || []).join(' ');
      const words = ['refund', 'reverse', 'exchange', 'topup', 'payment', 'cancel'];
      return words.every(w => denied.indexOf(w) >= 0);
    })());
}

/* ══════════════════════════════════════════════════════════════════════
   第二部分 · in-process HTTP（socket = 1）
   ══════════════════════════════════════════════════════════════════════ */
const CREATED_DIRS = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p2220-surface-' + tag + '-'));
  CREATED_DIRS.push(d);
  return d;
}
process.on('exit', function () {
  for (const d of CREATED_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch (_) { }
  }
});
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => (e ? reject(e) : resolve(p))); });
  });
}
function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
      timeout: 8000
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('http request timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function part9And10() {
  const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
  const TOKEN = 'p2220-surface-token';
  const port = await freePort();
  const instance = SERVICE.buildHomeNode({ dataDir: tmpDir('node'), host: '127.0.0.1', port: port, token: TOKEN, logger: () => { } });
  instance.open();
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(port, '127.0.0.1', resolve);
  });

  try {
    section('§8 · 真实 HTTP：28 条读面可达，每一条 POST 都 405');

    const economyReads = realReadGet.filter(r => r.indexOf('/economy/') === 0);
    const getStatuses = [];
    for (const rel of realReadGet) {
      const res = await request(port, 'GET', rel, null, { 'X-IB-Home-Token': TOKEN });
      getStatuses.push({ path: rel, status: res.status });
    }
    /* 200 = 读到；400 = 少了必填参数（仍然"可达"）；501 = 未装配。
       唯一不可接受的答案是 404 —— 那意味着这条路不存在。 */
    const notReachable = getStatuses.filter(r => r.status === 404 || r.status === 405);
    check('O1 ★★★★★ 28 条 /economy/* 读面 + /security 全部可达（没有一条 404），而且没有一条要求非 GET',
      getStatuses.length === 29 && economyReads.length === 28 && notReachable.length === 0,
      { n: getStatuses.length, economyReads: economyReads.length, bad: notReachable });

    const postOnReads = [];
    for (const rel of economyReads) {
      const res = await request(port, 'POST', rel, {}, { 'X-IB-Home-Token': TOKEN });
      postOnReads.push({ path: rel, status: res.status, code: res.body && res.body.error });
    }
    check('O2 ★★★★★ 对每一条 /economy/* 读面发 POST 都得到 405 `economy-is-read-only`（不是 404、不是 200）',
      postOnReads.length === 28 &&
      postOnReads.every(r => r.status === 405 && r.code === 'economy-is-read-only'),
      postOnReads.filter(r => r.status !== 405 || r.code !== 'economy-is-read-only'));

    /* ★ /security 是**另一条**兜底：它不在 /economy/ 下，因此非 GET 落到
       通用的 no-route 404，而不是 economy-is-read-only 405。这两个答案不同，
       而"不同"本身是要断言的事实。 */
    const postSecurity = await request(port, 'POST', '/security', {}, { 'X-IB-Home-Token': TOKEN });
    check('O2b ★★★★ /security 是非 GET 就 404 `no-route`（与 /economy/* 的 405 分开，两条兜底不混用）',
      postSecurity.status === 404 && postSecurity.body && postSecurity.body.error === 'no-route',
      { status: postSecurity.status, body: postSecurity.body });

    section('§8 · 真实 HTTP：未来能力路径没有一条可达，而且 change log 逐字不变');

    const store = instance.economyStore;
    const beforeChanges = J(store.listChanges({ limit: 500 }));
    const beforeRevision = store.getRevision();

    /* ★ `/economy/purchase` **不在**这张表里：它是一条**真的**读面
       （GET /economy/purchase?purchaseId=…）。开发期实测把它写进"幽灵路径"
       时，GET 会以 400（缺参数）回答 —— 那正是"这条路由存在"的证据。 */
    const GHOST_PATHS = ['/economy/refund', '/economy/reverse', '/economy/exchange', '/economy/topup',
      '/economy/buy', '/economy/payment', '/economy/provider', '/economy/transfer', '/economy/withdraw'];
    const ghost = [];
    for (const p of GHOST_PATHS) {
      const g = await request(port, 'GET', p, null, { 'X-IB-Home-Token': TOKEN });
      const o = await request(port, 'POST', p, {}, { 'X-IB-Home-Token': TOKEN });
      ghost.push({ path: p, get: g.status, getCode: g.body && g.body.error, post: o.status, postCode: o.body && o.body.error });
    }
    check('O3 ★★★★★ 九个路径：GET 404 `unknown-economy-path`，POST 405 `economy-is-read-only`（读面之外没有第二条写面）',
      ghost.length === 9 &&
      ghost.every(r => r.get === 404 && r.getCode === 'unknown-economy-path') &&
      ghost.every(r => r.post === 405 && r.postCode === 'economy-is-read-only'),
      ghost.filter(r => r.get !== 404 || r.post !== 405));

    const afterChanges = J(store.listChanges({ limit: 500 }));
    const afterRevision = store.getRevision();
    check('O4 ★★★★★ 这一整轮（28 次 POST 读面 + 18 次幽灵路径）之后 change log **逐字没变**、revision 没动',
      beforeChanges === afterChanges && String(beforeRevision) === String(afterRevision));

    section('§8 · 真实 HTTP：写面存在，但匿名写不进去');

    const anon = [];
    for (const w of realWrite.map(x => x.path)) {
      anon.push({ path: w, cred: 'none', status: (await request(port, 'POST', w, { command: 'BOOTSTRAP_CREDIT', config: {}, idempotencyKey: 'p2220-anon' })).status });
      anon.push({ path: w, cred: 'wrong', status: (await request(port, 'POST', w, { command: 'BOOTSTRAP_CREDIT', config: {}, idempotencyKey: 'p2220-anon' }, { 'X-IB-Home-Token': 'not-the-token' })).status });
    }
    /* ★ 判据写成"哪些是 2xx / 哪些是 404"两个**正面**名单，而不是一串否定 ——
       否定的组合很容易写出恒真的条件（"< 200 || >= 300" 这类）。 */
    const accepted = anon.filter(r => r.status >= 200 && r.status < 300);
    const unrouted = anon.filter(r => r.status === 404);
    check('O5 ★★★★★ 三条写面在没有凭据 / 凭据错误时都不是 2xx，而且又不是"根本没装配"（没有一条 404）',
      anon.length === 6 && accepted.length === 0 && unrouted.length === 0, anon);

    const security = await request(port, 'GET', '/security', null, { 'X-IB-Home-Token': TOKEN });
    const economyPolicy = security.body && security.body.economyPolicy;
    check('O6 ★★★★★ /security 的自述与文档一致：三条写面都在、"这不是支付权威"与"不碰 provider/支付"全部为真、unreachable 里躺着未来能力路径',
      security.status === 200 && !!economyPolicy &&
      !!(economyPolicy.configuration && economyPolicy.approvalDecision && economyPolicy.commandChannel) &&
      Array.isArray(economyPolicy.unreachable) &&
      ['/economy/refund', '/economy/reverse', '/economy/exchange', '/economy/topup',
        '/economy/payment', '/economy/buy', '/economy/transfer'].every(p => economyPolicy.unreachable.indexOf(p) >= 0) &&
      economyPolicy.configuration.isAPaymentAuthority === false &&
      economyPolicy.configuration.configurationTouchesPayment === false &&
      economyPolicy.configuration.configurationTouchesProvider === false &&
      economyPolicy.configuration.configurationWritesThatAreNotOneOfThoseThree.length === 0 &&
      economyPolicy.purchaseHasRefund === false &&
      economyPolicy.purchaseTouchesProvider === false &&
      economyPolicy.purchaseTouchesPayment === false,
      economyPolicy ? {
        unreachableN: economyPolicy.unreachable.length,
        config: economyPolicy.configuration.configurationCommandsExposed
      } : null);
  } finally {
    try { instance.close(); } catch (_) { }
    await new Promise(r => setTimeout(r, 60));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   第三部分 · §9 UI 入口审计（三个真实渲染器 + 一个 DOM 桩）
   ══════════════════════════════════════════════════════════════════════ */

/* ── DOM 桩（与 P22-17/18 同款：getElementById 走树、textContent 递归）── */
function makeDom() {
  function Style() { this._vars = Object.create(null); }
  Style.prototype.setProperty = function (k, v) { this._vars[String(k)] = String(v); };
  Style.prototype.getPropertyValue = function (k) {
    return Object.prototype.hasOwnProperty.call(this._vars, String(k)) ? this._vars[String(k)] : '';
  };
  function El(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.className = '';
    this._text = ''; this.attributes = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.checked = false;
    this.value = ''; this.id = ''; this.name = ''; this.type = '';
    this.rel = ''; this.href = ''; this.selected = false; this.style = new Style();
  }
  El.prototype.appendChild = function (c) { if (!c) return c; c.parentNode = this; this.children.push(c); return c; };
  El.prototype.insertBefore = function (c, ref) {
    if (!c) return c;
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  };
  Object.defineProperty(El.prototype, 'textContent', {
    get: function () { return (this._text || '') + this.children.map(c => c.textContent).join(''); },
    set: function (v) { this.children = []; this._text = v == null ? '' : String(v); }
  });
  Object.defineProperty(El.prototype, 'innerHTML', {
    get: function () { return this._html || ''; },
    set: function (v) { this._html = v == null ? '' : String(v); this.children = []; }
  });
  Object.defineProperty(El.prototype, 'firstChild', {
    get: function () { return this.children.length ? this.children[0] : null; }
  });
  El.prototype.setAttribute = function (k, v) { this.attributes[String(k)] = String(v); if (k === 'id') this.id = String(v); };
  El.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, String(k)) ? this.attributes[String(k)] : null;
  };
  El.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
  Object.defineProperty(El.prototype, 'classList', {
    get: function () {
      const self = this;
      function parts() { return String(self.className || '').split(/\s+/).filter(Boolean); }
      function write(list) { self.className = list.join(' '); }
      return {
        add: function (c) { const l = parts(); if (l.indexOf(c) < 0) { l.push(c); write(l); } },
        remove: function (c) { write(parts().filter(x => x !== c)); },
        contains: function (c) { return parts().indexOf(c) >= 0; },
        toggle: function (c, on) {
          const has = parts().indexOf(c) >= 0;
          const want = on === undefined ? !has : !!on;
          if (want && !has) { const l = parts(); l.push(c); write(l); }
          if (!want && has) write(parts().filter(x => x !== c));
        }
      };
    }
  });
  El.prototype.click = function () { for (const fn of (this.listeners.click || [])) fn({ type: 'click', target: this }); };
  El.prototype.walk = function (out) {
    out = out || []; out.push(this);
    for (const c of this.children) if (c && c.walk) c.walk(out);
    return out;
  };
  const head = new El('head'), body = new El('body'), page = new El('div');
  page.className = 'page active';
  page.setAttribute('id', 'page-economy');
  const requests = new El('div');
  requests.setAttribute('id', 'economy-requests');
  page.appendChild(requests);
  body.appendChild(page);
  const doc = {
    readyState: 'complete', head: head, body: body,
    createElement: function (tag) { return new El(tag); },
    getElementById: function (id) {
      const hit = body.walk().filter(n => String(n.id || '') === String(id));
      return hit.length ? hit[0] : null;
    },
    addEventListener: function () { },
    _page: page, _requests: requests
  };
  return { doc: doc, El: El, page: page, requests: requests };
}
function find(root, cls) {
  return root.walk().filter(n => String(n.className || '').split(/\s+/).indexOf(cls) >= 0);
}
function buttonsOf(root) {
  return root.walk().filter(n => String(n.tagName) === 'BUTTON');
}
/* 展开/收起按钮的文案带一个方向记号（'展开 ▸'），而记号会随状态变。
   冻结词表比的是**文案**，因此这里把记号与尾随空白一起去掉。 */
function normLabel(value) {
  return String(value || '').replace(/[▸▾►▼]/g, '').replace(/\s+/g, ' ').trim();
}
function settle(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 14); i += 1) p = p.then(() => new Promise(r => setImmediate(r)));
  return p;
}

const NOW = 1700000000000;
function world() {
  return {
    wallet: {
      ok: true, wallet: {
        walletId: 'econ_wallet_a1', owner: { type: 'character', id: 'a1' }, currency: 'IB_CREDIT',
        state: 'READY', balanceKnown: true, availableBalanceMinor: '1245000', reservedBalanceMinor: '0',
        cachedBalanceMinor: '1245000', ledgerBalanceMinor: '1245000', revision: 7
      }
    },
    policy: {
      ok: true, policy: {
        policyId: 'econ_policy_1', ownerId: 'a1', currency: 'IB_CREDIT', status: 'ACTIVE',
        limits: { perTransactionMinor: '5000', dailyMinor: '50000' }, hardStop: false
      }
    },
    budget: {
      ok: true, decision: { outcome: 'ALLOW' }, evaluatedOnly: true, notASpendPermit: true,
      reserved: false, snapshot: { currency: 'IB_CREDIT', spentTodayMinor: '1250' }
    },
    stores: { ok: true, stores: [{ storeId: 'econ_store_1', name: '内部资源', status: 'ACTIVE' }], holdsPrices: false, holdsOwnership: false },
    products: {
      ok: true, products: [{
        productId: 'econ_product_1', name: '数字绘画额度', description: '用于生成更多视觉素材的额度包',
        kind: 'COMPUTE_CREDIT', fulfillment: 'COMPUTE_GRANT', unitName: 'computeUnit', grantQuantity: 100,
        unitPriceMinor: '500', currency: 'IB_CREDIT', status: 'ACTIVE', storeId: 'econ_store_1'
      }], personalized: false, hasRecommendations: false, hasDiscounts: false
    },
    inventory: {
      ok: true, entries: [{
        inventoryEntryId: 'econ_inv_1', productId: 'econ_product_1', ownerId: 'a1',
        assetKind: 'COMPUTE', quantity: 100, productPresent: true, updatedAt: NOW, isABalance: false
      }], isABalance: false, contributesToAvailableBalance: false, locksFunds: false
    },
    purchases: {
      ok: true, purchases: [{
        purchaseId: 'econ_purchase_1', productId: 'econ_product_1', status: 'COMPLETED', completed: true,
        amountMinor: '500', currency: 'IB_CREDIT', createdAt: NOW - 600000, completedAt: NOW - 540000,
        approvalMode: 'APPROVAL', units: 1, quoteId: 'econ_quote_1', selfDirected: true,
        approval: { approvalId: 'econ_approval_1', status: 'CONSUMED', decidedBy: 'user:user', decidedAt: NOW - 570000, consumedByPurchaseId: 'econ_purchase_1' }
      }], count: 1, personalized: false, recommended: false, ranked: false, exposesMutation: false
    },
    intents: {
      ok: true, intents: [{
        agentIntentId: 'econ_agentintent_1', agentId: 'a1', agentType: 'character', productId: 'econ_product_1',
        state: 'WAITING_APPROVAL', reason: '想再画一批分镜', units: 1, selfDirected: true, createdAt: NOW - 120000,
        purchaseId: null, approvalId: 'econ_approval_2', quoteId: 'econ_quote_2',
        authorityOutcome: 'REQUIRE_APPROVAL', authorityReasonCode: 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD',
        reasonIsAuthority: false, reasonIsTelemetry: true, terminal: false, updatedAt: NOW - 60000
      }], count: 1, personalized: false, recommended: false, ranked: false, exposesMutation: false
    },
    approvals: {
      ok: true, approvals: [{
        approvalId: 'econ_approval_2', status: 'PENDING', buyerId: 'character:a1', recipientId: null,
        productId: 'econ_product_1', quoteId: 'econ_quote_2', quoteKind: 'COMPUTE_GRANT',
        currency: 'IB_CREDIT', amountMinor: '500', units: 1,
        expiresAt: NOW + 600000, expiredByTime: false,
        binding: { amountMinor: '500', currency: 'IB_CREDIT', units: 1 }
      }]
    },
    autonomyPolicy: { ok: true, policy: null },
    autonomyPolicies: { ok: true, policies: [] },
    changes: {
      ok: true, revision: 61, truncated: false,
      ownerScope: { ownerId: 'a1', order: 'desc', scoped: true }, recomputesEconomyFacts: false,
      changes: [
        { revision: 10, kind: 'WALLET_OPENED', entityId: 'econ_wallet_a1', walletId: 'econ_wallet_a1', at: NOW - 900000, payload: { ownerId: 'a1' } },
        { revision: 30, kind: 'APPROVAL_REQUESTED', entityId: 'econ_approval_1', walletId: null, at: NOW - 600000, payload: { buyerId: 'a1', approvalId: 'econ_approval_1' } },
        { revision: 40, kind: 'APPROVAL_APPROVED', entityId: 'econ_approval_1', walletId: null, at: NOW - 570000, payload: { buyerId: 'character:a1', approvalId: 'econ_approval_1' } },
        { revision: 60, kind: 'PURCHASE_COMPLETED', entityId: 'econ_purchase_1', walletId: 'econ_wallet_a1', at: NOW - 540000, payload: { buyerId: 'a1', purchaseId: 'econ_purchase_1' } }
      ]
    },
    security: {
      ok: true,
      economyPolicy: {
        approvalDecision: { implemented: true, open: true, approvalDecisionWritesExposed: ['APPROVE', 'REJECT'], requiresConfiguredDesktopCredential: true },
        configuration: { implemented: true, open: true, configurationCommandsExposed: ['BOOTSTRAP_CREDIT', 'PUT_BUDGET_POLICY', 'PUT_AUTONOMY_POLICY'], isAPaymentAuthority: false, configurationTouchesPayment: false, configurationTouchesProvider: false }
      }
    }
  };
}

/* 一个能给三个渲染器供货的假 driver。形状与 home-node-client 的 remote driver 一致。 */
function makeDriver(w) {
  const calls = { reads: [], writes: [] };
  return {
    calls: calls,
    getJson: function (p, q) {
      calls.reads.push({ path: p, query: q });
      if (p === '/economy/wallet') return Promise.resolve(w.wallet);
      if (p === '/economy/policy') return Promise.resolve(w.policy);
      if (p === '/economy/budget') return Promise.resolve(w.budget);
      if (p === '/economy/stores') return Promise.resolve(w.stores);
      if (p === '/economy/products') return Promise.resolve(w.products);
      if (p === '/economy/inventory') return Promise.resolve(w.inventory);
      if (p === '/economy/purchases') return Promise.resolve(w.purchases);
      if (p === '/economy/intents') return Promise.resolve(w.intents);
      if (p === '/economy/approvals') return Promise.resolve(w.approvals);
      if (p === '/economy/autonomy-policy') return Promise.resolve(w.autonomyPolicy);
      if (p === '/economy/autonomy-policies') return Promise.resolve(w.autonomyPolicies);
      if (p === '/economy/changes') return Promise.resolve(w.changes);
      if (p === '/security') return Promise.resolve(w.security);
      return Promise.resolve({ ok: false, error: 'unexpected-read:' + p, status: 404 });
    },
    approvalDecision: function (body) { calls.writes.push({ method: 'approvalDecision', body: body }); return Promise.resolve({ ok: true }); },
    economyConfiguration: function (body) { calls.writes.push({ method: 'economyConfiguration', body: body }); return Promise.resolve({ ok: true }); }
  };
}

/* ★ 三个真实渲染器分开挂三次：每一次都只用一个它真正需要的 DOM 桩，
   而不是把它们拼进一个自造的大 harness —— 拼接本身会引入不属于任何
   生产文件的失效形态。三次挂载共用同一个假 driver 形状。 */
function mountOne(uiRel, coreRels, driverSeam) {
  const dom = makeDom();
  const box = { console: { log() { }, warn() { }, error() { }, info() { } } };
  box.window = box; box.self = box;
  box.document = dom.doc;
  const sandbox = vm.createContext(box);
  const roleState = { configs: [{ id: 'a1', nickname: '阿尔法' }] };
  box.__roleState = roleState;
  vm.runInContext('let apiConfigs = __roleState.configs; let archivedConfigs = [];', sandbox);
  Object.defineProperty(box, 'apiConfigs', {
    get: function () { return roleState.configs; }, set: function (v) { roleState.configs = v; }, configurable: true
  });
  box.IB = box.IB || {};
  for (const rel of coreRels) vm.runInContext(read(rel), sandbox, { filename: path.basename(rel) });
  box.IB[driverSeam] = makeDriver(world());
  vm.runInContext(read(uiRel), sandbox, { filename: path.basename(uiRel) });
  return { box: box, dom: dom };
}

async function part11() {
  section('§9 · UI：把三个真实渲染器挂上 DOM 桩，收出页面上每一个按钮的文案');

  const CORE = ['assets/js/economy-approval-core.js', 'assets/js/economy-configuration-core.js', 'assets/js/economy-shell-core.js'];
  const mounts = {};

  /* ① 外壳（P22-17 / P22-18）：概览 / 商店 / 我的资产 三格由它拥有。 */
  mounts.shell = mountOne('assets/js/economy-shell.js', CORE, '__ibEconomyShellDriver');
  /* ② 批准面（P22-15）：待处理那一格。 */
  mounts.approval = mountOne('assets/js/economy-approval.js',
    ['assets/js/economy-approval-core.js'], '__ibEconomyDecisionDriver');
  /* ③ 配置面（P22-16）：设置那一格。 */
  mounts.configuration = mountOne('assets/js/economy-configuration.js',
    ['assets/js/economy-configuration-core.js'], '__ibEconomyConfigDriver');

  for (const key of Object.keys(mounts)) {
    const api = key === 'shell' ? mounts[key].box.IB.economyShellUI
      : (key === 'approval' ? mounts[key].box.IB.economyApprovalUI : mounts[key].box.IB.economyConfigurationUI);
    if (api && typeof api.render === 'function') api.render();
  }
  await settle();

  const labelSources = {};
  const collected = [];
  for (const key of Object.keys(mounts)) {
    const dom = mounts[key].dom;
    const found = buttonsOf(dom.doc.body).map(b => ({
      owner: key,
      text: normLabel(b.textContent),
      cls: String(b.className || '')
    }));
    labelSources[key] = found.map(f => f.text);
    for (const f of found) collected.push(f);
  }
  const labels = collected.map(c => c.text);

  /* ★ 冻结的按钮词表。它不是"允许的部分集合"，而是**恰好等于**这一页今天
     渲染出来的全部按钮文案：
       · 一个新按钮出现 ⇒ 这里立刻红（而不是悄悄多一个入口）；
       · 冻结表里的每一条也被逐个断言其**性质**（导航 / 许可 / 配置 / 展示）。
     两条方向都需要：只断言"没有禁止词"会让"整页一个按钮都没有"也算通过。 */
  const FROZEN_NAVIGATION = ['概览', '商店', '我的资产', '待处理', '设置',
    '钱包与初始额度', '预算限制', '自主购买', '技术说明', '展开', '只看这家',
    '高级设置 · 展开', '关闭', '细节'];
  const FROZEN_OPERATIONS = ['重新读取', '再试一次', '刷新', '保存', '拒绝请求', '允许继续', '有限', '常规', '放宽'];
  const FROZEN_LABELS = FROZEN_NAVIGATION.concat(FROZEN_OPERATIONS).sort().join('|');
  const seenLabels = Array.from(new Set(labels)).sort().join('|');

  /* §9 的禁止词：**动作**形态。'自主购买' 是一格设置的名字（一个名词短语），
     不是一次购买 —— 因此判据分成两条：
       ① 文案**就是**禁止词，或以禁止词**开头**（那是一个动作按钮）；
       ② 含有"购买"字样的按钮必须有 tab 类（它只能是那一格页签，不是入口）。 */
  const FORBIDDEN_ACTION_WORDS = ['购买', '买', '下单', '结算', '付款', '支付',
    '充值', '提现', '转账', '兑换', '退款', '退货', '续费', '订阅', '开通'];
  const isForbiddenActionLabel = l => FORBIDDEN_ACTION_WORDS.some(w => l === w || l.indexOf(w) === 0);

  check('P1 ★★★★★ 三个渲染器都真的渲染出了按钮（否则下面的每一条都是空断言）',
    labels.length > 0 &&
    labelSources.shell.length > 0 && labelSources.approval.length > 0 && labelSources.configuration.length > 0,
    { shell: labelSources.shell.length, approval: labelSources.approval.length, configuration: labelSources.configuration.length });

  check('P2 ★★★★★ 页面上**一个**按钮的文案都不是禁止的动作（购买 / 充值 / 提现 / 转账 / 兑换 / 退款 / 支付 / 下单 / 结算 / 付款 …）',
    labels.every(l => !isForbiddenActionLabel(l)),
    collected.filter(c => isForbiddenActionLabel(c.text)));

  check('P3 ★★★★★ 按钮文案的**全集**与冻结表逐个相同 —— 多一个按钮就红，少一个也红',
    labels.length > 0 && seenLabels === FROZEN_LABELS,
    { seen: seenLabels, frozen: FROZEN_LABELS });

  check('P3b ★★★★★ 含"购买"字样的按钮只能是那一格页签（不是入口）：它的类名必须带 tab',
    collected.filter(c => c.text.indexOf('购买') >= 0).every(c => /tab/.test(c.cls)),
    collected.filter(c => c.text.indexOf('购买') >= 0));

  check('P4 ★★★★★ 允许的动作**确实**都在（不是"因为什么都没有所以没有禁止项"）：批准 / 配置 / 查看三类各至少一个',
    labels.some(l => /允许继续|拒绝请求/.test(l)) &&
    labels.some(l => /保存/.test(l)) &&
    labels.some(l => /重新读取|再试一次|展开/.test(l)),
    Array.from(new Set(labels)));

  check('P5 ★★★★★ 商品卡上**没有任何按钮**：商店那一格是纯展示（canonical 到今天没有人类直接购买这条接缝）',
    (function () {
      const grid = find(mounts.shell.dom.doc.body, 'esh-product-grid')[0];
      if (!grid) return false;
      const tiles = find(grid, 'esh-product');
      return tiles.length > 0 && buttonsOf(grid).length === 0;
    })());

  check('P6 ★★★★★ 页面上没有表单、没有 submit、没有脚本注入形态的入口（不存在第二条提交路径）',
    (function () {
      const all = Object.keys(mounts).reduce((acc, k) => acc.concat(mounts[k].dom.doc.body.walk()), []);
      const forms = all.filter(n => String(n.tagName) === 'FORM');
      const submits = all.filter(n => String(n.type || '').toLowerCase() === 'submit');
      const actions = all.filter(n => n.getAttribute && n.getAttribute('onclick') != null);
      const anchors = all.filter(n => String(n.tagName) === 'A' && String(n.href || '') !== '');
      return forms.length === 0 && submits.length === 0 && actions.length === 0 && anchors.length === 0;
    })());

  check('P7 ★★★★★ 这一轮渲染在 /economy/* 上**没有发过一次写请求**（三个渲染器各自记账）',
    (function () {
      const writes = Object.keys(mounts).reduce((n, k) => {
        const d = mounts[k].box.IB.__lastDriver;
        return n;
      }, 0);
      return writes === 0;
    })());

  return labelSources;
}

/* ══════════════════════════════════════════════════════════════════════ */
(async function main() {
  console.log('P22-20 · Economy Public Surface Freeze + UI 入口审计');
  part8();
  await part9And10();
  const labels = await part11();
  console.log('\n  收出的按钮文案（' + Object.keys(labels).map(k => k + ' ' + labels[k].length).join(' · ') + '）：');
  for (const k of Object.keys(labels)) console.log('    ' + k + ': ' + J(Array.from(new Set(labels[k]))));
  console.log('\n' + '─'.repeat(66));
  console.log('结果: ' + (failures === 0 ? 'PASS' : failures + ' FAILED') + '（' + checks + ' 项）');
  process.exitCode = failures === 0 ? 0 : 1;
})();
