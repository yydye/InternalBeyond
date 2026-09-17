'use strict';
/* ====================================================================
   P22-24 · Not-Found wire contract guard（anti-leak）
   --------------------------------------------------------------------
   运行：node tests/test_p22_24_not_found_wire_contract.js

   这一条守卫要挡住的**不是**"某个字符串写错了"，而是一整类回归：

     一个 canonical **裁决**词汇（DENY_REASON）被当作 client-facing
     HTTP error token 发出去。

   为什么它是一个**类**而不是一处笔误：store 的 `denied` 结果里同时带着
   reasonCode（裁决词，SCREAMING_SNAKE）与 errors[]（面向客户端的资源
   token，kebab-case）。seam 只要写成 `reasonCode || errors[0]`，就会把那
   两个词表混起来。P22-24 在 `/economy/approval` 与 `/economy/autonomy-policy`
   上实测抓到这一处（`autonomy-policy-not-found` 那条把整页设置变成了
   "读不到自主规则"）。

   ── 这条守卫证明的四层 ──────────────────────────────────────────────
     ① 真实节点上："没有这个东西"的只读面答 **404 + kebab-case 资源 token**；
     ② 那个 token **不是**任何 DENY_REASON 成员（词表不互相顶替）；
     ③ 同一份 payload 喂给 **production** UI core，得到 state=absent
        （而不是 state=unknown）—— 这才是"产品级"的那一半；
     ④ 源码级：`bad(res, 404, …)` 全表里，error token 一律是 errors[0]，
        reasonCode 只以 `reasonCode === 'X' ? 404 : 400` 这种**选状态**的
        形态出现。

   ★ 判据刻意**限定**在这 11 条只读资源面上：写面（/internal/economy/…）
     的信封本来就把 reasonCode 当 reasonCode 发（那是它的契约），本条守卫
     **不**去全局禁止 reason code 出现在响应里。
   ★ 它不开浏览器、不碰开发目录、不碰 %LOCALAPPDATA%：一个真实 Home Node
     子进程 + 一个私有临时数据目录 + 一个显式测试凭据，结束即清理。
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

const TOKEN = 'p22-24-wire-guard-token';
const OWNER = 'cfg_p24_guard_owner';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { failed++; console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t); }
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

/* ── production UI core（与 P22-16/22 同一种沙箱加载：只有 window）──── */
const box = { console: { log() { }, warn() { }, error() { }, info() { } } };
box.window = box; box.self = box;
const sandbox = vm.createContext(box);
vm.runInContext(read('assets/js/economy-configuration-core.js'), sandbox, { filename: 'economy-configuration-core.js' });
const core = box.IB && box.IB.economyConfigurationCore;

/* ── 缺席面清单：11 条真实只读路由里的"没有这个东西" ─────────────────
   ★ 每条都写**期望的 client-facing token**（Evidence：由 store 的
     `errors[0]` 决定，逐条在真实节点上验证，而不是照抄常量）。
   ★ 每条 id 都按 canonical 的 ID_PREFIX 形状构造（econ_tx_ / econ_res_ /
     econ_inv_ / econ_purchase_ / …）—— 一个形状不合法 的 id 会被 id 校验
     挡在 400，那样测到的是"id 不合法"而不是"资源不存在"。 */
const ABSENCE = [
  { label: 'wallet', p: '/economy/wallet?ownerId=' + OWNER + '&currency=IB_CREDIT', token: 'wallet-not-found' },
  { label: 'transaction', p: '/economy/transaction?transactionId=econ_tx_nope_deadbeef', token: 'transaction-not-found' },
  { label: 'reservation', p: '/economy/reservation?reservationId=econ_res_nope_deadbee', token: 'reservation-not-found' },
  { label: 'budget policy', p: '/economy/policy?ownerId=' + OWNER, token: 'budget-policy-not-found', ui: 'buildBudgetView' },
  { label: 'quote', p: '/economy/quote?quoteId=econ_quote_nope_deadbeefdead', token: 'quote-not-found' },
  { label: 'store', p: '/economy/store?storeId=econ_store_nope_deadbeefdead', token: 'store-not-found' },
  { label: 'product', p: '/economy/product?productId=econ_product_nope_deadbeef', token: 'product-not-found' },
  { label: 'inventory entry', p: '/economy/inventory-entry?inventoryEntryId=econ_inv_nope_deadbe', token: 'inventory-entry-not-found' },
  { label: 'purchase', p: '/economy/purchase?purchaseId=econ_intent_nope_deadbeef', token: 'purchase-not-found' },
  { label: 'approval', p: '/economy/approval?approvalId=econ_approval_nope_deadbeef', token: 'approval-not-found' },
  { label: 'autonomy policy', p: '/economy/autonomy-policy?ownerId=' + OWNER, token: 'autonomy-policy-not-found', ui: 'buildAutonomyView' }
];

/* ── 词表：canonical 裁决词 vs 客户端 token ────────────────────────────
   ★ 一条**结构**不变量（不是字符串黑名单）：canonical 裁决词是
     SCREAMING_SNAKE，客户端资源 token 是 kebab-case。两者没有交集，
     因此"线上 error 是不是裁决词"可以被机器判定。 */
const DENY = Object.values(C.DENY_REASON);
const SCREAMING = /^[A-Z][A-Z0-9_]*$/;

(async function main() {
  const exe = null; /* 不需要浏览器 */
  console.log('P22-24 · Not-Found wire contract guard');

  section('0 · 词表不变量（纯层，先钉住判据本身）');
  check('词表 · DENY_REASON 的 50 个成员**全部**是 SCREAMING_SNAKE（裁决词的形状）',
    DENY.length >= 50 && DENY.every(v => SCREAMING.test(v)),
    DENY.filter(v => !SCREAMING.test(v)));
  check('词表 · 本阶段涉及的两个缺席 token 都**不是** DENY_REASON 成员'
    + '（词表不互相顶替；这就是"泄漏"的操作性定义）',
    DENY.indexOf('autonomy-policy-not-found') < 0 && DENY.indexOf('approval-not-found') < 0 &&
    DENY.indexOf('POLICY_NOT_FOUND') >= 0 && DENY.indexOf('APPROVAL_NOT_FOUND') >= 0);
  check('词表 · canonical 裁决词与 kebab-case 客户端 token 无交集（0 个成员同时满足两种形状）',
    DENY.filter(v => !SCREAMING.test(v)).length === 0);

  /* ── 起一个真实 Home Node ─────────────────────────────────────────── */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2224-guard-'));
  const port = await fx.freePort();
  const child = spawn(process.execPath, [path.join('services', 'home-node-service.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(port), IB_HOME_NODE_DATA_DIR: dir, IB_HOME_NODE_TOKEN: TOKEN
    }),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let out = '';
  child.stdout.on('data', c => { out += String(c); });
  child.stderr.on('data', c => { out += String(c); });

  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      const h = await fx.request(port, 'GET', '/health');
      if (h.status === 200) { up = true; break; }
      await fx.sleep(250);
    }
    section('1 · 真实节点：11 条只读缺席面');
    check('节点起来了（/health 200，真实子进程）', up, out.slice(-300));
    if (!up) throw new Error('home node did not start');

    const seen = [];
    for (const a of ABSENCE) {
      const r = await fx.request(port, 'GET', a.p, null, { 'X-IB-Home-Token': TOKEN });
      const err = r.body && r.body.error;
      seen.push({ label: a.label, status: r.status, error: err });
      check('① ' + a.label + ' ⇒ 404 + ' + a.token,
        r.status === 404 && err === a.token,
        { status: r.status, error: err });
      check('② ' + a.label + ' 的 error **不是**任何 canonical 裁决词',
        DENY.indexOf(err) < 0,
        { error: err });
    }

    section('2 · 缺席面全表：没有任何一条漏出裁决词');
    check('③ 11 条缺席面，全部 404，且 error 全部不是 DENY_REASON 成员',
      seen.length === ABSENCE.length && seen.every(s => s.status === 404 && DENY.indexOf(s.error) < 0),
      seen);
    check('★★ 逐条点名：autonomy policy 与 approval 这两条**不再**发裁决词',
      seen.filter(s => s.label === 'autonomy policy')[0].error === 'autonomy-policy-not-found' &&
      seen.filter(s => s.label === 'approval')[0].error === 'approval-not-found' &&
      seen.filter(s => s.label === 'autonomy policy')[0].error !== C.DENY_REASON.POLICY_NOT_FOUND &&
      seen.filter(s => s.label === 'approval')[0].error !== C.DENY_REASON.APPROVAL_NOT_FOUND,
      seen.filter(s => s.label === 'autonomy policy' || s.label === 'approval'));

    /* ── ③ production UI core：同一份真实 payload → absent ──────────── */
    section('3 · production UI core 读到同一份 payload 的归类');
    check('UI core 加载成功（window.IB.economyConfigurationCore）', !!core);
    if (core) {
      const realAutonomy = seen.filter(s => s.label === 'autonomy policy')[0];
      const autonomyPayload = { ok: false, error: realAutonomy.error, status: realAutonomy.status };
      const v = core.buildAutonomyView(autonomyPayload);
      check('④ 真实的 autonomy 缺席 payload ⇒ state=absent（**不是** unknown）',
        v.state === 'absent' && v.code === 'autonomy-policy-not-found',
        v);
      check('⑤ 而且它**不**带任何"读不到/重试"的措辞与 detail（absent 是系统状态，不是故障）',
        v.text == null && v.detail == null, v);
      /* 反方向：真正的传输故障仍然进 unknown（否则这一条守卫会禁止"报错"） */
      const broke = core.buildAutonomyView({ ok: false, error: 'timeout' });
      check('⑥ 真 transport 失败仍然进 state=unknown（分离，而不是把一切都读成 absent）',
        broke.state === 'unknown' && typeof broke.text === 'string', broke);
      const realBudget = seen.filter(s => s.label === 'budget policy')[0];
      const bv = core.buildBudgetView({ ok: false, error: realBudget.error, status: realBudget.status });
      check('⑦ 预算那一格仍然是 absent（本阶段没有改动它的行为）',
        bv.state === 'absent', bv);
    }

    /* ── ④ 源码级：所有"缺席即 404"的 error token ─────────────────────
       ★ 两种写法都要覆盖，否则被修的那两条会**逃出**这条守卫：
         · `bad(res, 404, …)`                       —— 11 条（状态是字面量）
         · `bad(res, reasonCode === 'X' ? 404 : 400, …)` —— 2 条（被修的）
       这正是"测到的东西必须包含被测对象"：第一版只匹配前者，两条被修的
       路由恰好不在其中。 */
    section('4 · 源码级："缺席即 404"的 error token 一律不是裁决词');
    const httpCode = read('services/home-node/http.js')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const absenceLines = httpCode.split(/\r?\n/).filter(l =>
      /bad\(res,\s*404/.test(l) || /bad\(res,[^;]*\?\s*404\s*:\s*400/.test(l));
    /* ★ 判据：这**一条语句**里不许出现 reasonCode 作为 error token。
       只允许它以 `reasonCode === 'X' ? 404 : 400` 的形态出现在**状态**位置
       —— 因此判据是"去掉那个三元条件之后还有没有 reasonCode"。 */
    const offenders = absenceLines.filter(l => {
      const withoutStatusTernary = l.replace(/[A-Za-z_$][\w$]*\.reasonCode\s*===\s*'[^']*'\s*\?\s*404\s*:\s*400/g, '');
      return /reasonCode/.test(withoutStatusTernary);
    });
    check('⑧ 源码里每一条"缺席即 404"的 error token 都不是 reasonCode（' + absenceLines.length + ' 条，含两条三元状态形态）',
      absenceLines.length >= 13 && offenders.length === 0, offenders);
    /* ★ 这一条刻意**不是**"所有 404 都必须写 errors[0]"：有一条路由用固定
       字面量 token，那也是客户端词表里的词、不是裁决词 —— ⑧ 才是本阶段
       真正要钉住的性质。这里钉的是**被修的两条**各自的兜底 token 字面量
       （它们在处理块里、回答行会折行，因此按**处理块**匹配，而不是按行），
       免得将来有人把它们改回硬编码的裁决词。 */
    const fixedFallbacks = ['approval-not-found', 'autonomy-policy-not-found'].map(t => {
      const re = new RegExp("errors\\[0\\]\\s*\\|\\|\\s*'" + t + "'", 'g');
      const m = httpCode.match(re) || [];
      return { token: t, hits: m.length, inAbsenceLines: absenceLines.filter(l => l.indexOf(t) >= 0).length };
    });
    check('⑨ 被本阶段修的两条路由各自带**客户端**兜底 token（errors[0] || 客户端 token，逐条在位）',
      fixedFallbacks.every(f => f.hits === 1), fixedFallbacks);

    section('5 · 结果');
  } catch (error) {
    failed++;
    console.error('  ✖ 守卫抛出异常 — ' + String((error && (error.stack || error.message)) || error));
  } finally {
    try { child.kill(); } catch (_) { }
    await fx.sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { }
    /* 不留孤儿进程、不留临时目录引用。 */
    console.log('\n' + (failed === 0 ? '全部通过 ✔' : failed + ' 项失败 ✘') +
      '  (' + passed + ' 通过 / ' + failed + ' 失败)');
    process.exitCode = failed === 0 ? 0 : 1;
  }
})();
