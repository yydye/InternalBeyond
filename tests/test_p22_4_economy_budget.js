'use strict';
/* ====================================================================
   P22-4 · Economy 预算政策与**确定性**评估（canonical store 层）
   --------------------------------------------------------------------
   运行：node tests/test_p22_4_economy_budget.js

   本文件回答的问题：
     「这项经济行为在当前预算规则下**是否允许**？」—— 而这个答案必须是
       a) 确定的（同样的输入永远同样的输出），
       b) 只由结构化数据决定的（LLM / Memory / Relationship / Middle Brain
          的输出在类型上无处可放），
       c) 从 canonical 事实算出来的（窗口累计来自 committed ledger entries，
          不是缓存、不是 UI 计数器），
       d) **不产生任何经济后果**（评估不是授权，更不是执行）。

   ── 为什么这一阶段的失败模式与 P22-2/P22-3 不同 ─────────────────────
   P22-2 的失败模式是"余额算错"，P22-3 的是"两个数不一致"。P22-4 的是
   **一个不该有自由度的东西有了自由度**：如果评估器读了时钟、读了随机、
   读了某段文字，或者把"我不知道"兜成 0，那么它会**看起来**正常工作，
   而所有不喂那些输入的测试都是绿的。因此本文件的重量放在：
     · 确定性（同输入同输出、键序无关、深拷贝无关、跑一千次一致）；
     · 输入封闭性（白名单外的键一律拒绝，正文键没有位置）；
     · fail closed（DEGRADED 绝不返回 0，而是 null + DENY + systemFailure）；
     · 优先级（同一输入只能得到一个 reasonCode，且顺序可断言）；
     · 消费窗口的 canonical 来源（先破坏：直接改缓存、改 UI 侧的数、
       伪造窗口 —— 都不能改变结论）。

   ── 与方法名对应关系 ─────────────────────────────────────────────────
     B  契约里的确定性评估器（纯函数）      C  政策持久化
     D  消费窗口 = UTC + committed 事实     E  评估优先级与 reasonCode
     F  fail closed                         G  政策不是经济运动（ledgerMutation:false）
     H  幂等（scope POLICY）                I  崩溃注入
     J  重启恢复                            K  schema 2 → 3
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else {
    failures++;
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra, replacer) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }
/* BigInt 不能进 JSON.stringify（P22-1 §3）—— 连**失败信息**都必须显式
   处理它，否则一次断言失败会变成一次 TypeError。 */
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-4b-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

function deterministicIds() {
  let n = 0;
  return (kind) => { n += 1; return C.formatEconomyId(kind, 't' + n).id; };
}
/* 可推进的时钟。窗口边界是**比较**（utcDayStart(now) 等），因此只要能让
   now 动起来，"日/周/月滚动"与"进程离线跨天"都可以在一个测试进程里被
   如实复现 —— 不需要真的等到明天，也不需要任何定时器。 */
function mutableClock(start) {
  const box = { now: Number(start) || Date.UTC(2024, 0, 15, 12, 0, 0) };
  const fn = () => box.now;
  fn.box = box;
  fn.advance = (ms) => { box.now += Number(ms); return box.now; };
  fn.set = (t) => { box.now = Number(t); return box.now; };
  return fn;
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir,
    logger: () => { },
    nextId: deterministicIds()
  }, extra || {}));
}
function walletWith(store, amountMinor, ownerId, currency) {
  const w = store.openWallet({ owner: { type: 'character', id: ownerId || 'cfg_a' }, currency: currency || 'IB_CREDIT' });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  if (amountMinor && BigInt(amountMinor) !== 0n) {
    const m = store.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: currency || 'IB_CREDIT',
      amountMinor: amountMinor, idempotencyKey: 'seed-' + w.wallet.walletId
    });
    assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
  }
  return w.wallet;
}
let policySeq = 0;
function putPolicy(store, options) {
  const o = options || {};
  policySeq += 1;
  /* 缺省 key 里带一个**单调计数器**：caller 经常用同一个 tag 写两次
     （例如"建一条、再改一条"），而幂等键相同 + payload 不同正是
     IDEMPOTENCY_CONFLICT —— 那是被刻意设计出来的拒绝，不该被测试的
     helper 无意中触发。要测冲突的用例自己显式给 key。 */
  const out = store.putBudgetPolicy(Object.assign({
    ownerId: 'cfg_a',
    currency: 'IB_CREDIT',
    idempotencyKey: 'policy-' + (o.tag || 'x') + '-' + policySeq
  }, o, o.idempotencyKey != null ? { idempotencyKey: o.idempotencyKey } : {}));
  assert.equal(out.ok, true, 'putBudgetPolicy must succeed: ' + J(out.errors || out));
  return out.result;
}
/* §30 的那份确定性样例：余额 1000，perTx 300 / daily 500 / weekly 1000 /
   monthly 2000 / approvalAbove 200。 */
const SAMPLE_LIMITS = Object.freeze({
  perTransactionMinor: 300, dailyMinor: 500, weeklyMinor: 1000,
  monthlyMinor: 2000, approvalThresholdMinor: 200
});
function sampleContext(overrides) {
  return Object.assign({
    ownerId: 'cfg_a',
    currency: 'IB_CREDIT',
    amountMinor: 100,
    walletState: 'READY',
    timestamp: Date.UTC(2024, 0, 15, 12, 0, 0),
    usage: { spentTodayMinor: 0, spentThisWeekMinor: 0, spentThisMonthMinor: 0 },
    limits: Object.assign({ availableBalanceMinor: 1000 }, SAMPLE_LIMITS)
  }, overrides || {});
}
function samplePolicy(overrides) {
  const out = C.validateBudgetPolicy(Object.assign({
    policyId: 'econ_policy_sample', ownerId: 'cfg_a', currency: 'IB_CREDIT',
    status: 'ACTIVE', termEndsAt: null, limits: SAMPLE_LIMITS
  }, overrides || {}));
  assert.equal(out.ok, true, 'sample policy must validate: ' + J(out.errors));
  return out.policy;
}
function evaluate(store, amountMinor, extra) {
  const out = store.evaluateBudgetFor(Object.assign({
    ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: amountMinor
  }, extra || {}));
  assert.equal(out.ok, true, 'evaluateBudgetFor must answer: ' + J(out.errors || out));
  return out;
}
/* 一个"经济状态指纹"：钱包、账本拓扑、四张表的行数、revision 与 change
   log 的条数。任何一次**读**之后它必须逐字相同 —— 这是"评估没有副作用"
   这条性质最直接的证伪方式（而不是断言"我们没写"）。
   刻意全部通过 store 自己的公开读取面取，而不是另开一个连接：
   另开连接会和被测对象抢库，而"读到的数"与"被写的库"必须是同一个。 */
function economyFingerprint(store) {
  const h = store.health();
  return J({
    state: h.state,
    revision: h.revision,
    counts: h.counts,
    changes: store.listChanges(0, 500).length,
    topology: store.ledgerTopology(null),
    wallets: store.listWallets({ limit: 500 }).map(w => store.serializeWallet(w, {})),
    reservations: store.listReservations({ limit: 500 }).reservations.map(r => store.serializeReservation(r)),
    policies: store.listBudgetPolicies({ limit: 500 }).policies.map(p => store.serializeBudgetPolicy(p)),
    quotes: store.listQuotes({ limit: 500 }).quotes.map(q => store.serializeQuote(q))
  });
}

console.log('P22-4 · Economy budget policy + deterministic evaluation');

/* ══════════════════════════════════════════════════════════════════
   B · 契约里的确定性评估器（纯函数、§2/§15/§16/§30）
   ══════════════════════════════════════════════════════════════════ */
section('B · 确定性评估器：同输入同输出（不是"我们小心地没有引入不确定性"）');

{
  const policy = samplePolicy();

  check('B1 同一个 (policy, context) 跑 1000 次得到**逐字节**相同的 JSON',
    (() => {
      const first = J(C.evaluateBudget(policy, sampleContext()));
      for (let i = 0; i < 1000; i++) {
        if (J(C.evaluateBudget(policy, sampleContext())) !== first) return false;
      }
      return true;
    })());
  check('B2 键的顺序不影响结果（对象字面量与打乱后的构造是同一件事）',
    (() => {
      const a = samplePolicy();
      const shuffled = {};
      for (const k of Object.keys(a).reverse()) shuffled[k] = a[k];
      return J(C.evaluateBudget(a, sampleContext())) === J(C.evaluateBudget(shuffled, sampleContext())) &&
        J(C.evaluateBudget(policy, sampleContext({ amountMinor: 250 }))) ===
        J(C.evaluateBudget(policy, sampleContext({ amountMinor: 250 })));
    })());
  check('B3 深拷贝（结构化克隆出来的普通对象）得到同一个结果 —— 评估不依赖引用身份',
    J(C.evaluateBudget(policy, JSON.parse(JSON.stringify(sampleContext())))) ===
    J(C.evaluateBudget(policy, sampleContext())));
  check('B4 评估器不读时钟：把系统时间往前推一年，结果一个字都不变',
    (() => {
      const before = J(C.evaluateBudget(policy, sampleContext()));
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 365 * 86400000;
        return J(C.evaluateBudget(policy, sampleContext())) === before;
      } finally { Date.now = realNow; }
    })());
  check('B5 评估器不读随机：连续两次调用之间 Math.random 被换掉也不影响',
    (() => {
      const before = J(C.evaluateBudget(policy, sampleContext()));
      const realRandom = Math.random;
      try {
        Math.random = () => 0.42;
        return J(C.evaluateBudget(policy, sampleContext())) === before;
      } finally { Math.random = realRandom; }
    })());
  check('B6 §30 的五个样例逐一得到**指定**的那个结果与 reasonCode',
    (() => {
      const cases = [
        [{ amountMinor: 100 }, 'ALLOW', 'BUDGET_ALLOWED'],
        [{ amountMinor: 250 }, 'REQUIRE_APPROVAL', 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD'],
        [{ amountMinor: 350 }, 'DENY', 'AMOUNT_EXCEEDS_PER_TRANSACTION'],
        [{ amountMinor: 250, usage: { spentTodayMinor: 300, spentThisWeekMinor: 300, spentThisMonthMinor: 300 } }, 'DENY', 'DAILY_LIMIT'],
        [{ amountMinor: 100, limits: Object.assign({ availableBalanceMinor: 50 }, SAMPLE_LIMITS) }, 'DENY', 'INSUFFICIENT_AVAILABLE_BALANCE']
      ];
      return cases.every(([over, outcome, reason]) => {
        const d = C.evaluateBudget(policy, sampleContext(over));
        return d.outcome === outcome && d.reasonCode === reason;
      });
    })()
  );
  check('B7 恰好花完额度是允许的：日额度 500、已花 300 ⇒ 要 200 得到 ALLOW、要 201 得到 DAILY_LIMIT',
    (() => {
      /* 三档都给大数，只让**日额度**成为唯一紧的那一档 —— 否则
         "哪一个先说话"会变成测试自己也没想清楚的问题。 */
      const wide = {
        perTransactionMinor: 100000, dailyMinor: 500, weeklyMinor: 100000,
        monthlyMinor: 100000, approvalThresholdMinor: 100000
      };
      const p = samplePolicy({ limits: wide });
      const at = (amount, spentToday) => C.evaluateBudget(p, sampleContext({
        amountMinor: amount, limits: Object.assign({ availableBalanceMinor: 100000 }, wide),
        usage: { spentTodayMinor: spentToday, spentThisWeekMinor: spentToday, spentThisMonthMinor: spentToday }
      }));
      const exact = at(200, 300);
      const over = at(201, 300);
      const zero = at(500, 0);
      return exact.outcome === 'ALLOW' && exact.remainingMinor === undefined &&
        over.outcome === 'DENY' && over.reasonCode === 'DAILY_LIMIT' &&
        over.spentMinor === '300' && over.limitMinor === '500' && over.remainingMinor === '200' &&
        zero.outcome === 'ALLOW';
    })());
  check('B8 单笔上限用 `> cap` 比较：per-tx 300 时 300 通过、301 拒绝（额度是"最多能花这么多"）',
    (() => {
      /* 审批线放到很大，让"单笔上限"成为唯一可能说话的那一档。 */
      const p = samplePolicy({
        limits: { perTransactionMinor: 300, dailyMinor: 100000, weeklyMinor: 100000,
          monthlyMinor: 100000, approvalThresholdMinor: 100000 }
      });
      const at = (amount) => C.evaluateBudget(p, sampleContext({
        amountMinor: amount,
        limits: { availableBalanceMinor: 100000, perTransactionMinor: 300, dailyMinor: 100000,
          weeklyMinor: 100000, monthlyMinor: 100000, approvalThresholdMinor: 100000 }
      }));
      return at(300).outcome === 'ALLOW' && at(301).outcome === 'DENY' &&
        at(301).reasonCode === 'AMOUNT_EXCEEDS_PER_TRANSACTION';
    })());
  check('B9 审批线是 `>`：样例里的 200 通过、201 需要审批（阈值本身不需要点头）',
    (() => {
      /* 样例政策里 per-tx 300 / 审批线 200，因此 200 落在"上限内、线上"，
         201 落在"上限内、线外"。 */
      const at = (amount) => C.evaluateBudget(policy, sampleContext({ amountMinor: amount }));
      return at(200).outcome === 'ALLOW' && at(200).reasonCode === 'BUDGET_ALLOWED' &&
        at(201).outcome === 'REQUIRE_APPROVAL' &&
        at(201).reasonCode === 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD' &&
        at(201).approvalThresholdMinor === '200';
    })());
  check('B9b 审批线**只**在一切硬规则都通过之后才轮到它（否则它是 DENY 而不是 REQUIRE_APPROVAL）',
    (() => {
      /* 250 既超审批线、又在单笔上限之内 ⇒ 审批；350 超单笔上限 ⇒ 拒绝。 */
      const a = C.evaluateBudget(policy, sampleContext({ amountMinor: 250 }));
      const b = C.evaluateBudget(policy, sampleContext({ amountMinor: 350 }));
      return a.outcome === 'REQUIRE_APPROVAL' && b.outcome === 'DENY' &&
        a.priority === C.BUDGET_EVALUATION_PRIORITY[9] &&
        b.priority === C.BUDGET_EVALUATION_PRIORITY[5];
    })());
  check('B10 REQUIRE_APPROVAL **不是** DENY，也**不是** ALLOW（三种结果互不相同）',
    (() => {
      const d = C.evaluateBudget(policy, sampleContext({ amountMinor: 250 }));
      return d.outcome === 'REQUIRE_APPROVAL' && d.allowed === false && d.denied === false &&
        d.requiresApproval === true &&
        C.BUDGET_DECISION.REQUIRE_APPROVAL !== C.BUDGET_DECISION.DENY &&
        C.BUDGET_DECISION.REQUIRE_APPROVAL !== C.BUDGET_DECISION.ALLOW;
    })());
  check('B11 每一份结果都带 snapshot.authority="none"（ALLOW 不是可执行的许可，§19）',
    ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'].every(outcome => {
      const ctx = outcome === 'ALLOW' ? sampleContext()
        : outcome === 'REQUIRE_APPROVAL' ? sampleContext({ amountMinor: 250 })
          : sampleContext({ amountMinor: 350 });
      const d = C.evaluateBudget(policy, ctx);
      return d.outcome === outcome && d.snapshot.kind === 'evaluation' && d.snapshot.authority === 'none';
    }));

  /* ── 输入封闭性：正文没有地方可以放 ─────────────────────────────── */
  check('B12 prompt / relationship / llmOutput 这类键一律被拒绝（§2 的"无处可放"）',
    (() => {
      const polluted = [
        { prompt: 'I really want this.' },
        { llmOutput: 'buy it' },
        { reasoning: 'the user deserves it' },
        { relationship: { trust: 0.9 } },
        { message: 'please' },
        { narration: 'it longs for the dress' }
      ];
      return polluted.every(extra => {
        const d = C.evaluateBudget(policy, Object.assign(sampleContext(), extra));
        return d.outcome === 'DENY' && d.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED' &&
          d.errors.indexOf('policy-input-carries-non-deterministic-text') >= 0;
      });
    })());
  check('B13 白名单**外**的普通键也被拒绝（不是"只有正文键才挡"）',
    (() => {
      const d = C.evaluateBudget(policy, Object.assign(sampleContext(), { maxBudget: 1000 }));
      return d.outcome === 'DENY' && d.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED' &&
        d.errors.indexOf('policy-input-key-not-whitelisted') >= 0;
    })());
  check('B14 context 里缺任何一个窗口值 ⇒ 拒绝（不完整的快照不能得出 ALLOW）',
    ['spentTodayMinor', 'spentThisWeekMinor', 'spentThisMonthMinor'].every(key => {
      const ctx = sampleContext();
      const usage = Object.assign({}, ctx.usage);
      delete usage[key];
      const d = C.evaluateBudget(policy, Object.assign({}, ctx, { usage: usage }));
      return d.outcome === 'DENY' && d.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED';
    }));
  check('B15 评估器返回的每一个 reasonCode 都在封闭集合里（绝不自由文本）',
    (() => {
      const codes = new Set();
      const probes = [
        sampleContext(), sampleContext({ amountMinor: 250 }), sampleContext({ amountMinor: 350 }),
        sampleContext({ amountMinor: 250, usage: { spentTodayMinor: 300, spentThisWeekMinor: 300, spentThisMonthMinor: 300 } }),
        sampleContext({ usage: { spentTodayMinor: 0, spentThisWeekMinor: 0, spentThisMonthMinor: 900 } }),
        sampleContext({ limits: Object.assign({ availableBalanceMinor: 0 }, SAMPLE_LIMITS) }),
        sampleContext({ walletState: 'COLD' }), sampleContext({ currency: 'COMPUTE_PREMIUM' }),
        sampleContext({ amountMinor: 0 })
      ];
      for (const ctx of probes) {
        const d = C.evaluateBudget(policy, ctx);
        if (d.reasonCode !== 'BUDGET_ALLOWED' && !C.isDenyReasonCode(d.reasonCode)) return false;
        codes.add(d.reasonCode);
      }
      return codes.size >= 5;
    })());

  /* ── 政策的生效性：没有规则、规则被停用、规则到期 ───────────────── */
  check('B16 政策不存在 / DISABLED / 期限已过 ⇒ DENY，且 reasonCode 能区分前两者',
    (() => {
      const noPolicy = C.evaluateBudget(null, sampleContext());
      const disabled = C.evaluateBudget(samplePolicy({ status: 'DISABLED' }), sampleContext());
      const expired = C.evaluateBudget(
        samplePolicy({ termEndsAt: sampleContext().timestamp - 1 }), sampleContext());
      const future = C.evaluateBudget(
        samplePolicy({ termEndsAt: sampleContext().timestamp + 1 }), sampleContext());
      return noPolicy.outcome === 'DENY' && noPolicy.reasonCode === 'POLICY_NOT_FOUND' &&
        disabled.reasonCode === 'POLICY_NOT_FOUND' &&
        expired.reasonCode === 'POLICY_TERM_EXPIRED' &&
        future.outcome === 'ALLOW';
    })());
  check('B17 未知的 policy status ⇒ 结构化失败（不是"当成 ACTIVE"也不是"当成 DISABLED"）',
    (() => {
      const d = C.evaluateBudget(Object.assign(samplePolicy(), { status: 'PAUSED' }), sampleContext());
      return d.outcome === 'DENY' && d.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED';
    })());
  check('B18 owner 不匹配 ⇒ POLICY_NOT_FOUND（"没有规则"与"规则说不"必须分开）',
    C.evaluateBudget(policy, sampleContext({ ownerId: 'cfg_b' })).reasonCode === 'POLICY_NOT_FOUND');
  check('B19 币种不匹配 ⇒ INVALID_CURRENCY（刻意**不**做汇率换算，汇率属于 P22-6）',
    (() => {
      const d = C.evaluateBudget(policy, sampleContext({ currency: 'COMPUTE_PREMIUM' }));
      return d.reasonCode === 'INVALID_CURRENCY' && d.policyCurrency === 'IB_CREDIT' &&
        d.contextCurrency === 'COMPUTE_PREMIUM';
    })());
  check('B20 大额输入用 BigInt 参与比较，不经过 Number（MAX_SAFE_INTEGER 附近仍然精确）',
    (() => {
      const big = samplePolicy({
        limits: { perTransactionMinor: C.MAX_AMOUNT_MINOR, dailyMinor: C.MAX_AMOUNT_MINOR,
          weeklyMinor: C.MAX_AMOUNT_MINOR, monthlyMinor: C.MAX_AMOUNT_MINOR }
      });
      const ctx = sampleContext({
        amountMinor: C.MAX_AMOUNT_MINOR,
        limits: { availableBalanceMinor: C.MAX_AMOUNT_MINOR }
      });
      const okBig = C.evaluateBudget(big, ctx);
      const tooBig = C.evaluateBudget(big, sampleContext({
        amountMinor: C.MAX_AMOUNT_MINOR,
        limits: { availableBalanceMinor: C.MAX_AMOUNT_MINOR },
        usage: { spentTodayMinor: 1, spentThisWeekMinor: 0, spentThisMonthMinor: 0 }
      }));
      return okBig.outcome === 'ALLOW' && tooBig.reasonCode === 'DAILY_LIMIT' &&
        okBig.amountMinor === String(C.MAX_AMOUNT_MINOR);
    })());
  check('B21 金额的非法表示一律拒绝，且**拒绝的理由说的是"这个表示不合法"**',
    (() => {
      /* 除了"没给"（null / undefined）走 INVALID_AMOUNT 之外，其余都是
         契约的 normalizeAmountMinor 直接否掉的**表示**问题 —— 因此
         reasonCode 是 POLICY_INPUT_NOT_STRUCTURED。这条区分是有用的：
         前者是"这次请求没有金额内容"，后者是"这个字符串根本不是金额"。 */
      const representation = [-1, '1.5', '1e3', '0x10', '+1', '1,000', '', ' ', 1.5, NaN, Infinity];
      return representation.every(bad => {
        const d = C.evaluateBudget(policy, sampleContext({ amountMinor: bad }));
        return d.outcome === 'DENY' && d.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED' &&
          d.errors.length > 0;
      }) && [null, undefined].every(missing =>
        C.evaluateBudget(policy, sampleContext({ amountMinor: missing })).reasonCode === 'INVALID_AMOUNT');
    })());
  check('B22 0 金额既不允许也不拒绝成"余额不足"——它没有经济内容（INVALID_AMOUNT）',
    C.evaluateBudget(policy, sampleContext({ amountMinor: 0 })).reasonCode === 'INVALID_AMOUNT' &&
    C.evaluateBudget(policy, sampleContext({ amountMinor: '0' })).reasonCode === 'INVALID_AMOUNT');
}

/* ══════════════════════════════════════════════════════════════════
   C · 政策持久化（§3/§5/§20）
   ══════════════════════════════════════════════════════════════════ */
section('C · 政策持久化：一个 owner 一条规则，存在 Economy SQLite 命名空间里');

{
  const dir = tmpDir('policy');
  const store = makeStore({ dataDir: dir });
  store.open();
  const w = walletWith(store, 1000n);

  check('C1 新建库的 counts 里 policies / quotes 都是 0（观测面跟着能力长）',
    store.health().counts.budgetPolicies === 0 && store.health().counts.activeBudgetPolicies === 0 &&
    store.health().counts.quotes === 0 && store.health().counts.openQuotes === 0,
    store.health().counts);
  check('C2 两张新表都在 economy_ 命名空间下（不是 localStorage / IndexedDB / 第二套库）',
    store.TABLES.BUDGET_POLICIES === 'economy_budget_policies' &&
    store.TABLES.QUOTES === 'economy_quotes' && store.SCHEMA_VERSION >= 3);
  check('C3 health() 自述预算的 canonical 来源与"评估不是许可"（可断言的字段，不是注释）',
    store.health().budgetCanonical === 'sqlite-budget-policies + committed-ledger-facts' &&
    store.health().budgetDerived === 'none' &&
    store.health().budgetEvaluationIsNotASpendPermit === true &&
    store.health().budgetTimezone === 'UTC' &&
    J(store.health().budgetSpendingTypes) === J(C.BUDGET_SPENDING_TYPES));
  check('C4 doesNotExpose 追加 policy-writes / quote-writes（本阶段的写方法一个都不在 HTTP 上）',
    store.health().doesNotExpose.indexOf('policy-writes') >= 0 &&
    store.health().doesNotExpose.indexOf('quote-writes') >= 0 &&
    store.health().doesNotExpose.indexOf('reservation-writes') >= 0);

  const created = putPolicy(store, { tag: 'a', limits: SAMPLE_LIMITS });
  check('C5 创建政策报告 created:true，并带回完整形态（金额一律十进制字符串）',
    created.created === true && created.eventKind === 'BUDGET_POLICY_CREATED' &&
    created.policy.status === 'ACTIVE' && created.policy.currency === 'IB_CREDIT' &&
    created.policy.ownerId.type === 'character' && created.policy.ownerId.id === 'cfg_a' &&
    created.policy.limits.perTransactionMinor === '300' &&
    created.policy.limits.dailyMinor === '500' &&
    created.policy.limits.approvalThresholdMinor === '200',
    created.policy);
  check('C6 政策 id 是契约冻结的 econ_policy_ 前缀（第 6 种 id 种类）',
    C.isEconomyId('BUDGET_POLICY', created.policyId) &&
    created.policyId.indexOf('econ_policy_') === 0);
  check('C7 读回来的是同一条（getBudgetPolicy 按 policyId 与 ownerId 都认）',
    store.getBudgetPolicy({ policyId: created.policyId }).policy.policyId === created.policyId &&
    store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy.policyId === created.policyId &&
    store.getBudgetPolicy({ ownerId: 'cfg_b' }).ok === false);
  check('C8 一个 owner **恰好**一条政策：再 put 一次是**更新**同一条，不新建第二条',
    (() => {
      const before = store.listBudgetPolicies({}).policies.length;
      const again = putPolicy(store, { tag: 'b', limits: Object.assign({}, SAMPLE_LIMITS, { dailyMinor: 700 }) });
      const after = store.listBudgetPolicies({}).policies;
      return again.created === false && again.eventKind === 'BUDGET_POLICY_UPDATED' &&
        again.policyId === created.policyId &&
        after.length === before && after.length === 1 &&
        store.health().counts.budgetPolicies === 1 &&
        store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy.limits.dailyMinor === 700n;
    })());
  check('C9 更新留痕：previousLimits 被写进结果，且事件是 BUDGET_POLICY_UPDATED',
    (() => {
      const before = store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
      const upd = putPolicy(store, { tag: 'c', limits: Object.assign({}, SAMPLE_LIMITS, { dailyMinor: 900 }) });
      /* 两种表示刻意不同，而且都必须成立：
         · putBudgetPolicy 的**结果**是序列化形态（金额一律十进制字符串）
           —— 它就是会被写进 change log 与幂等表的那一份；
         · getBudgetPolicy 的读回是 canonical 形态（BigInt）。
         这条断言把两者都钉住：一旦有人把其中一侧改成另一侧，
         "写入的是什么"与"读回的是什么"就会开始悄悄分叉。 */
      return upd.created === false && upd.eventKind === 'BUDGET_POLICY_UPDATED' &&
        String(upd.previousLimits.dailyMinor) === String(before.limits.dailyMinor) &&
        upd.policy.limits.dailyMinor === '900' &&
        upd.previousStatus === 'ACTIVE' &&
        typeof upd.policy.limits.dailyMinor === 'string' &&
        typeof store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy.limits.dailyMinor === 'bigint';
    })());
  check('C10 停用只改状态，**限额一个字都不动**（重新启用时不需要把数字猜回来）',
    (() => {
      const before = store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
      const off = putPolicy(store, { tag: 'disable', disable: true });
      const after = store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
      return off.eventKind === 'BUDGET_POLICY_DISABLED' &&
        after.status === 'DISABLED' && after.hardStop === true &&
        after.hardStoppedAt != null &&
        J(after.limits) === J(before.limits);
    })());
  check('C11 停用之后评估立刻是 DENY / POLICY_NOT_FOUND（规则在，但不生效）',
    (() => {
      const out = evaluate(store, 100);
      return out.decision.outcome === 'DENY' && out.decision.reasonCode === 'POLICY_NOT_FOUND' &&
        out.decision.policyStatus === 'DISABLED';
    })());
  check('C12 重新启用之后限额回到停用前的那一组（停用没有销毁规则内容）',
    (() => {
      const on = putPolicy(store, { tag: 'enable', limits: Object.assign({}, SAMPLE_LIMITS, { dailyMinor: 900 }) });
      return on.policy.status === 'ACTIVE' && on.policy.limits.dailyMinor === '900' &&
        on.policy.hardStop === false && on.policy.hardStoppedAt === null &&
        evaluate(store, 100).decision.outcome === 'ALLOW';
    })());
  check('C13 可选乐观并发：ifRevision 不对就拒绝，且拒绝时**不消耗** revision',
    (() => {
      const before = store.getRevision();
      const stale = store.putBudgetPolicy({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: 'stale-1',
        limits: SAMPLE_LIMITS, ifRevision: 999
      });
      return stale.ok === false && stale.errors.indexOf('budget-policy-revision-mismatch') >= 0 &&
        stale.actualRevision != null && store.getRevision() === before;
    })());
  check('C14 政策只能挂 canonical party；而 system **不能**拥有政策（它只有 ledger account）',
    store.putBudgetPolicy({
      ownerId: { type: 'system', id: 'system:mint' }, currency: 'IB_CREDIT',
      idempotencyKey: 'sys-1', limits: SAMPLE_LIMITS
    }).ok === false &&
    /* 'me' / 'self' 这些"看起来像用户"的字符串会走 promotePartyRef 的
       角色分支 —— 于是"用户"被悄悄变成"一个名叫 me 的角色"。
       P22-1 §6.1 用 USER_PARTY_ID 挡掉这件事，这里验证它仍然成立：
       要表达用户必须显式用 'user'。 */
    store.putBudgetPolicy({
      ownerId: 'me', currency: 'IB_CREDIT', idempotencyKey: 'me-1', limits: SAMPLE_LIMITS
    }).ok === true &&
    store.getBudgetPolicy({ ownerId: 'me' }).policy.ownerId.type === 'character' &&
    store.putBudgetPolicy({
      ownerId: { type: 'character', id: '' }, currency: 'IB_CREDIT',
      idempotencyKey: 'empty-1', limits: SAMPLE_LIMITS
    }).ok === false);
  check('C15 限额的非法值一律拒绝（负数 / 小数 / 科学计数法 / 未知键）',
    [[{ dailyMinor: -1 }], [{ dailyMinor: '1.5' }], [{ dailyMinor: '1e3' }], [{ maxBudget: 100 }],
      [{ daily: 100 }], [{ dailyMinor: null, unknownKey: 1 }]].every(([limits]) => {
      const out = store.putBudgetPolicy({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: 'bad-' + J(limits), limits: limits
      });
      return out.ok === false && out.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED';
    }));
  check('C16 政策**不带**任何 provider / 凭据 / 真实支付字段（表与 DTO 都没有位置）',
    (() => {
      const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
      const cols = raw.prepare('PRAGMA table_info(' + store.TABLES.BUDGET_POLICIES + ')').all()
        .map(r => String(r.name));
      raw.close();
      const banned = ['api_key', 'provider', 'provider_balance', 'payment_intent', 'payment_link',
        'checkout_url', 'real_currency', 'cny', 'usd', 'max_budget', 'relationship', 'memory'];
      return banned.every(b => cols.indexOf(b) < 0) &&
        cols.indexOf('max_per_day_minor') >= 0 && cols.indexOf('approval_above_minor') >= 0 &&
        cols.indexOf('hard_stop') >= 0;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · 消费窗口 = UTC 边界 + committed ledger 事实（§12/§13/§14）
   ══════════════════════════════════════════════════════════════════ */
section('D · spentToday / spentWeek / spentMonth 只来自 committed ledger 事实');

/* 花掉一笔钱：reserve + commit。这是 P22-3 的路径，P22-4 不改它。 */
function spend(store, walletId, amountMinor, tag, at, currency) {
  const res = store.reserveFunds({
    walletId: walletId, currency: currency || 'IB_CREDIT', amountMinor: amountMinor,
    expiresAt: Number(at || Date.now()) + 600000, idempotencyKey: 'res-' + tag
  });
  assert.equal(res.ok, true, 'reserve must succeed: ' + J(res.errors || res));
  const com = store.commitReservation({
    reservationId: res.result.reservationId, idempotencyKey: 'com-' + tag,
    txType: 'PURCHASE', counterparty: 'system:market'
  });
  assert.equal(com.ok, true, 'commit must succeed: ' + J(com.errors || com));
  return com.result;
}
function spendAt(store, walletId, amountMinor, tag, atMs) {
  /* 交易的时间戳由 store 的时钟决定，因此"在某一天花掉"必须靠**推进
     时钟**来表达 —— 这正是"窗口是一个比较"的直接后果。 */
  const before = store._clockNowForTest ? null : null;
  return spend(store, walletId, amountMinor, tag, atMs);
}

{
  const clock = mutableClock(Date.UTC(2024, 0, 15, 12, 0, 0));   /* 周一 */
  const dir = tmpDir('windows');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 10000n);

  check('D1 没有任何消费时三个窗口都是 0（不是 null、不是"未知"）',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.ok === true && win.spentTodayMinor === 0n && win.spentThisWeekMinor === 0n &&
        win.spentThisMonthMinor === 0n && win.countedTransactions === 0;
    })());
  check('D2 窗口边界用 UTC 且是纯函数返回的整数（时区与 locale 都不参与）',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.ok === true && win.windows.timezone === 'UTC' &&
        win.windows.dayStartsAt === C.utcDayStart(clock()) &&
        win.windows.weekStartsAt === C.utcWeekStart(clock()) &&
        win.windows.monthStartsAt === C.utcMonthStart(clock()) &&
        new Date(win.windows.weekStartsAt).getUTCDay() === 1;
    })());
  check('D3 spendingWindows 自述它统计了哪些 transaction type（"这个数怎么来的"可读）',
    J(store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spendingTypes) ===
    J(C.BUDGET_SPENDING_TYPES) && C.BUDGET_SPENDING_TYPES.indexOf('PURCHASE') >= 0 &&
    C.BUDGET_SPENDING_TYPES.indexOf('MINT') < 0);

  /* 周一花 120。 */
  spend(store, w.walletId, 120n, 'mon');
  check('D4 一笔 PURCHASE 之后三个窗口都是 120（同一周、同一月、同一天）',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.spentTodayMinor === 120n && win.spentThisWeekMinor === 120n &&
        win.spentThisMonthMinor === 120n && win.countedTransactions === 1;
    })());

  /* 铸币与销毁**不**算消费（它们是 NEUTRAL）。 */
  store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 5000n, idempotencyKey: 'extra-mint'
  });
  check('D5 增发不算消费（NEUTRAL）：窗口仍是 120，而余额已经变了（10000 − 120 + 5000）',
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === 120n &&
    store.ledgerBalanceOf(w.walletId).balanceMinor === '14880' &&
    store.health().counts.transactions === 3,
    { balance: store.ledgerBalanceOf(w.walletId).balanceMinor, transactions: store.health().counts.transactions });

  /* 日边界：23:59:59.999 → 00:00:00.000 */
  const dayEnd = C.utcDayStart(clock()) + 86400000 - 1;
  const dayStartNext = C.utcDayStart(clock()) + 86400000;
  check('D6 23:59:59.999 与次日 00:00:00.000 落在**不同**的日窗口（边界逐毫秒可断言）',
    C.utcDayStart(dayEnd) === C.utcDayStart(clock()) &&
    C.utcDayStart(dayStartNext) === dayStartNext &&
    C.utcDayStart(dayStartNext) !== C.utcDayStart(dayEnd));
  clock.set(dayStartNext + 1000);
  check('D7 跨日之后 spentToday 归零，而 spentThisWeek / spentThisMonth 仍是 120',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.spentTodayMinor === 0n && win.spentThisWeekMinor === 120n &&
        win.spentThisMonthMinor === 120n;
    })());
  /* 周二再花 80。 */
  spend(store, w.walletId, 80n, 'tue');
  check('D8 同周第二天：today=80 / week=200 / month=200',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.spentTodayMinor === 80n && win.spentThisWeekMinor === 200n &&
        win.spentThisMonthMinor === 200n;
    })());

  /* 周边界：周日 23:59:59.999 → 下周一 00:00:00.000 */
  const weekStart = C.utcWeekStart(clock());
  const weekEnd = weekStart + 7 * 86400000 - 1;
  const nextWeekStart = weekStart + 7 * 86400000;
  check('D9 周窗口的起点是 UTC 周一 00:00Z，且 7 天后是下一个周一（周界干净）',
    new Date(weekStart).getUTCDay() === 1 &&
    new Date(nextWeekStart).getUTCDay() === 1 &&
    C.utcWeekStart(weekEnd) === weekStart && C.utcWeekStart(nextWeekStart) === nextWeekStart);
  clock.set(nextWeekStart + 1000);
  check('D10 跨周之后 today=0 / week=0，而 month 仍是 200（三档各自独立滚动）',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.spentTodayMinor === 0n && win.spentThisWeekMinor === 0n &&
        win.spentThisMonthMinor === 200n;
    })());

  /* 月边界 */
  const monthStart = C.utcMonthStart(clock());
  const nextMonthStart = C.utcMonthStart(monthStart + 32 * 86400000);
  check('D11 月窗口的起点是 UTC 月首 00:00Z，且月份长度不一也能算对（1 月 31 日 / 2 月 29 日）',
    new Date(monthStart).getUTCDate() === 1 &&
    C.utcMonthStart(Date.UTC(2024, 0, 31, 23, 59, 59, 999)) === Date.UTC(2024, 0, 1) &&
    C.utcMonthStart(Date.UTC(2024, 1, 29, 23, 59, 59, 999)) === Date.UTC(2024, 1, 1) &&
    C.utcMonthStart(Date.UTC(2023, 1, 28, 23, 59, 59, 999)) === Date.UTC(2023, 1, 1) &&
    C.utcMonthStart(Date.UTC(2024, 2, 1)) === Date.UTC(2024, 2, 1));
  clock.set(nextMonthStart + 1000);
  check('D12 跨月之后三个窗口全部归零（每个窗口都只统计自己那一段）',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.spentTodayMinor === 0n && win.spentThisWeekMinor === 0n &&
        win.spentThisMonthMinor === 0n && win.countedTransactions === 0;
    })());

  /* 只统计 COMMITTED：reserve 之后 release 不能永久吃掉预算。 */
  const before = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor;
  const res = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 70n,
    expiresAt: clock() + 600000, idempotencyKey: 'res-released'
  });
  check('D13 一次 reserve **不**计入窗口（钱还没花，只是被锁住）',
    res.ok === true &&
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === before);
  store.releaseReservation({ reservationId: res.result.reservationId, idempotencyKey: 'rel-released' });
  check('D14 reserve 之后 release **不会**永久吃掉预算（否则一次取消就等于花掉了一笔）',
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === before);

  const res2 = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 70n,
    expiresAt: clock() + 600000, idempotencyKey: 'res-expired'
  });
  store.expireReservation({ reservationId: res2.result.reservationId, now: clock() + 600001, idempotencyKey: 'exp-1' });
  check('D15 过期（EXPIRED）与失败（FAILED）同样不计入窗口',
    (() => {
      const res3 = store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 30n,
        expiresAt: clock() + 600000, idempotencyKey: 'res-failed'
      });
      store.failReservation({
        reservationId: res3.result.reservationId, reasonCode: 'PRODUCT_DISABLED',
        idempotencyKey: 'fail-1'
      });
      return store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === before;
    })());

  /* 只有 COMMITTED 的那一笔算。 */
  spend(store, w.walletId, 55n, 'committed-only');
  check('D16 只有 COMMITTED 的消费进入窗口：+55 之后 exactly before+55',
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === before + 55n);

  /* 先破坏，再证明：改缓存不影响窗口。 */
  store.corruptCachedBalanceForTest(w.walletId, 999999n);
  store.corruptReservedCacheForTest(w.walletId, 12345n);
  check('D17 把两个派生缓存改坏成 999999 / 12345 之后，三个窗口**一个数都不变**',
    (() => {
      const win = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return win.spentTodayMinor === before + 55n && win.spentThisWeekMinor === before + 55n &&
        win.spentThisMonthMinor === before + 55n;
    })());
  store.rebuildWalletBalance(w.walletId);
  check('D18 窗口的求和入口只有**一处**（那条消费 SQL），且方向按账本语义写成 CREDIT',
    (() => {
      const sql = String(store._internal.SQL.selectSpendingRows);
      /* 这条断言是**算出来**的：WALLET 账户 balance = Σ(DEBIT) − Σ(CREDIT)
         （P22-2 §8.2），因此"钱从这个钱包出去"是一条 **CREDIT**。
         写成 DEBIT 的实现会让所有窗口恒为 0 —— 而那看起来完全正常，
         只有"窗口应该是 120"这一条会失败。这里把方向钉住，让下一次
         改动无法悄悄回到 DEBIT。 */
      const wallet = store.getWallet({ walletId: w.walletId }).wallet;
      const entries = store.listLedgerEntries({ accountId: wallet.accountId, currency: 'IB_CREDIT' }).entries;
      const credits = entries.filter(e => String(e.direction) === 'CREDIT');
      const debits = entries.filter(e => String(e.direction) === 'DEBIT');
      /* 反向证据：账本里"钱进来"是 DEBIT、"钱出去"是 CREDIT，而且
         这两类**没有**用 amount 的符号区分（金额永远非负）。 */
      return sql.indexOf("direction = 'CREDIT'") >= 0 &&
        sql.indexOf("direction = 'DEBIT'") < 0 &&
        sql.indexOf('amount_minor < 0') < 0 &&
        credits.length >= 1 && debits.length >= 1 &&
        entries.every(e => String(e.amountMinor).indexOf('-') < 0);
    })());

  /* 方向只从 direction 读；amount 是无符号的。 */
  check('D19 求和不使用"金额是负数"这条判据（canonical amount 无符号，靠符号会永远得 0）',
    (() => {
      const rows = new DatabaseSync(path.join(dir, 'home-node.db'))
        .prepare('SELECT amount_minor, direction FROM ' + store.TABLES.ENTRIES).all();
      return rows.length > 0 && rows.every(r => Number(r.amount_minor) >= 0) &&
        rows.every(r => String(r.direction) === 'DEBIT' || String(r.direction) === 'CREDIT');
    })());

  /* 别的 owner 的消费不算在我头上。 */
  const wB = walletWith(store, 1000n, 'cfg_b');
  spend(store, wB.walletId, 400n, 'b-spend');
  check('D20 另一个 owner 的消费不出现在我的窗口里（窗口是按 owner 的账算的）',
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === before + 55n &&
    store.spendingWindows({ ownerId: 'cfg_b', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === 400n);

  /* 别的币种的消费不算在这个币种的窗口里。 */
  const wC = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'COMPUTE_PREMIUM' });
  store.mintForSystem({
    systemInitiated: true, walletId: wC.wallet.walletId, currency: 'COMPUTE_PREMIUM',
    amountMinor: 100n, idempotencyKey: 'seed-compute'
  });
  spend(store, wC.wallet.walletId, 40n, 'compute-spend', null, 'COMPUTE_PREMIUM');
  check('D21 另一个币种的消费不出现在 IB_CREDIT 的窗口里（政策是 (owner, currency) 作用域）',
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === before + 55n &&
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'COMPUTE_PREMIUM', now: clock() }).spentTodayMinor === 40n,
    { ib: String(store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor) });
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · 评估顺序与 reasonCode 的**唯一性**（§15/§30）
   ══════════════════════════════════════════════════════════════════ */
section('E · 优先级固定，因此同一输入只可能得到一个 reasonCode');

{
  const clock = mutableClock(Date.UTC(2024, 0, 15, 12, 0, 0));
  const dir = tmpDir('priority');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);

  {
    /* 这条路只评估**一次**：check() 的第三个参数是**急求值**的，如果在
       那里再评估一次，那条输出就会描述一次新的评估 —— 而当两次评估之间
       有写入时，它与被断言的那次可以不同（开发期实测踩到：输出说
       ALLOW、断言说的是第一次的 POLICY_NOT_FOUND）。 */
    const noPolicy = store.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100 });
    check('E1 规则不存在 ⇒ POLICY_NOT_FOUND，**即使**余额、币种、金额全都合法',
      noPolicy.decision.outcome === 'DENY' && noPolicy.decision.reasonCode === 'POLICY_NOT_FOUND' &&
      noPolicy.decision.priority === C.BUDGET_EVALUATION_PRIORITY[0] &&
      noPolicy.decision.systemFailure !== true,
      { reason: noPolicy.decision.reasonCode, outcome: noPolicy.decision.outcome, errors: noPolicy.decision.errors });
  }
  putPolicy(store, { tag: 'p', limits: SAMPLE_LIMITS });
  check('E1b 同一条输入在政策出现之后变成 ALLOW（对照：证明 E1 不是"永远拒绝"）',
    evaluate(store, 100).decision.outcome === 'ALLOW');

  /* 逐条把前面的规则破坏掉，验证顺序：后面的规则不会抢先。 */
  check('E2 wallet 不是 READY 时先于一切业务规则拒绝：DENY + WALLET_NOT_READY + systemFailure',
    (() => {
      const degraded = makeStore({ dataDir: tmpDir('degraded'), clock: clock });
      degraded.open();
      const dw = walletWith(degraded, 1000n);
      putPolicy(degraded, { tag: 'd', limits: SAMPLE_LIMITS });
      /* 手工把钱包行改成 COLD：这是"余额未知"，不是"余额为 0"。
         余额**确实**有 1000，因此"它说不知道"这件事只能来自状态。 */
      const raw = new DatabaseSync(degraded.health().file);
      raw.prepare('UPDATE ' + degraded.TABLES.WALLETS + ' SET state=? WHERE wallet_id=?').run('COLD', dw.walletId);
      raw.close();
      const out = degraded.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100 });
      const ledger = degraded.ledgerBalanceOf(dw.walletId).balanceMinor;
      degraded.close();
      return ledger === '1000' &&
        out.decision.outcome === 'DENY' && out.decision.reasonCode === 'WALLET_NOT_READY' &&
        out.decision.systemFailure === true && out.decision.walletState === 'COLD' &&
        out.snapshot != null &&
        out.snapshot.availableBalanceMinor === null && out.snapshot.ledgerBalanceMinor === null;
    })());
  check('E3 金额非法排在余额之前：-1 得到 INVALID_AMOUNT，而不是 INSUFFICIENT_AVAILABLE_BALANCE',
    (() => {
      const out = evaluate(store, -1);
      return out.decision.reasonCode === 'INVALID_AMOUNT' || out.decision.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED';
    })());
  check('E4 余额不足排在单笔上限之前：余额 10 时即使要 350（超单笔）也是"钱不够"先说话',
    (() => {
      walletWith(store, 10n, 'cfg_poor');
      putPolicy(store, { tag: 'poor', ownerId: 'cfg_poor', limits: SAMPLE_LIMITS });
      const out = store.evaluateBudgetFor({ ownerId: 'cfg_poor', currency: 'IB_CREDIT', amountMinor: 350 });
      return out.decision.reasonCode === 'INSUFFICIENT_AVAILABLE_BALANCE' &&
        out.decision.priority === C.BUDGET_EVALUATION_PRIORITY[4] &&
        out.decision.availableBalanceMinor === '10';
    })());
  check('E5 单笔上限排在日额度之前：要 350 且今天已花 300 ⇒ AMOUNT_EXCEEDS_PER_TRANSACTION',
    (() => {
      const out = store.evaluateBudgetFor({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 350
      });
      return out.decision.reasonCode === 'AMOUNT_EXCEEDS_PER_TRANSACTION';
    })());
  check('E6 日 < 周 < 月：同时超三档时得到日额度（顺序由 BUDGET_WINDOW_RULES 固定）',
    (() => {
      const policy = samplePolicy({ limits: { perTransactionMinor: 100000, dailyMinor: 100, weeklyMinor: 100, monthlyMinor: 100 } });
      const ctx = sampleContext({
        amountMinor: 500,
        limits: { availableBalanceMinor: 100000, perTransactionMinor: 100000, dailyMinor: 100, weeklyMinor: 100, monthlyMinor: 100, approvalThresholdMinor: 1 },
        usage: { spentTodayMinor: 90, spentThisWeekMinor: 90, spentThisMonthMinor: 90 }
      });
      const d = C.evaluateBudget(policy, ctx);
      return d.reasonCode === 'DAILY_LIMIT' && d.window === 'DAY' &&
        d.priority === C.BUDGET_EVALUATION_PRIORITY[6];
    })());
  check('E7 日通过、周超 ⇒ WEEKLY_LIMIT；日周都过、月超 ⇒ MONTHLY_LIMIT',
    (() => {
      const policy = samplePolicy({ limits: { perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 200, monthlyMinor: 300 } });
      const base = {
        amountMinor: 150,
        limits: { availableBalanceMinor: 100000, perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 200, monthlyMinor: 300, approvalThresholdMinor: 100000 }
      };
      const weekly = C.evaluateBudget(policy, sampleContext(Object.assign({}, base, {
        usage: { spentTodayMinor: 0, spentThisWeekMinor: 100, spentThisMonthMinor: 100 }
      })));
      const monthly = C.evaluateBudget(policy, sampleContext(Object.assign({}, base, {
        usage: { spentTodayMinor: 0, spentThisWeekMinor: 0, spentThisMonthMinor: 200 }
      })));
      return weekly.reasonCode === 'WEEKLY_LIMIT' && weekly.window === 'WEEK' &&
        monthly.reasonCode === 'MONTHLY_LIMIT' && monthly.window === 'MONTH';
    })());
  check('E8 审批线排在最后：一切硬规则都通过才轮到它（因此它是 REQUIRE_APPROVAL 而不是 DENY）',
    (() => {
      const out = evaluate(store, 250);
      return out.decision.outcome === 'REQUIRE_APPROVAL' && out.decision.priority === C.BUDGET_EVALUATION_PRIORITY[9] &&
        out.decision.amountMinor === '250' && out.decision.approvalThresholdMinor === '200';
    })());
  check('E9 每一份结果都带回 priority 字符串（"为什么是这个 reasonCode"可以从输出直接读出来）',
    (() => {
      const probes = [100, 250, 350];
      return probes.every(a => {
        const d = evaluate(store, a).decision;
        return typeof d.priority === 'string' && C.BUDGET_EVALUATION_PRIORITY.indexOf(d.priority) >= 0;
      });
    })());
  check('E10 同一输入反复评估得到同一个 reasonCode（重复 50 次）',
    (() => {
      const first = evaluate(store, 250).decision.reasonCode;
      for (let i = 0; i < 50; i++) if (evaluate(store, 250).decision.reasonCode !== first) return false;
      return first === 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD';
    })());
  check('E11 需求为负数 / 0 / 字符串 "0" 都不会被读成"要花 0 所以允许"',
    evaluate(store, 0).decision.reasonCode === 'INVALID_AMOUNT' &&
    evaluate(store, '0').decision.reasonCode === 'INVALID_AMOUNT');
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · fail closed（§17：系统故障与业务拒绝必须可区分）
   ══════════════════════════════════════════════════════════════════ */
section('F · fail closed：DEGRADED ≠ 余额为 0，系统故障 ≠ 业务拒绝');

{
  const clock = mutableClock(Date.UTC(2024, 0, 15, 12, 0, 0));
  const dir = tmpDir('failclosed');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);
  putPolicy(store, { tag: 'f', limits: SAMPLE_LIMITS });

  check('F1 正常状态下 available 是一个真实数字（对照组：证明后面那几条不是"永远返回 null"）',
    evaluate(store, 100).decision.outcome === 'ALLOW' &&
    evaluate(store, 100).snapshot.availableBalanceMinor === 1000n);

  /* ── 破坏账户引用链：完整性检查必须让**评估**失败关闭 ─────────────
     这一条与 P22-2/P22-3 的同类断言刻意放在**不同**的层次上：
       · P22-2 的 N 组把账户行删掉 ⇒ rebuildWalletBalance 失败 ⇒ DEGRADED；
       · 这里不删、只把 wallet_id 断掉，于是钱包行本身仍然说 READY。
     两种破坏的形状不同，而**两个层次都必须 fail closed**：
       · 钱包读路径：available 必须是 null（而不是 0）；
       · 评估：DENY + WALLET_NOT_READY + systemFailure（而不是"余额不足"，
         也不是 POLICY_INPUT_NOT_STRUCTURED）。
     第二点尤其重要：一个把系统故障说成"输入不对"的答案会让运维去查请求，
     而真正坏的是库。 */
  const raw = new DatabaseSync(store.health().file);
  raw.exec('UPDATE ' + store.TABLES.ACCOUNTS + " SET wallet_id=NULL WHERE wallet_id='" + w.walletId + "'");
  raw.close();
  const broken = evaluate(store, 100);
  check('F2 账户引用链断了 ⇒ DENY / WALLET_NOT_READY / systemFailure，**不是**"余额不足"',
    broken.decision.outcome === 'DENY' && broken.decision.reasonCode === 'WALLET_NOT_READY' &&
    broken.decision.systemFailure === true &&
    broken.decision.reasonCode !== 'INSUFFICIENT_AVAILABLE_BALANCE' &&
    /* 这一条是这一组的重点：系统故障不能被说成"输入不对"。 */
    broken.decision.reasonCode !== 'POLICY_INPUT_NOT_STRUCTURED',
    { reason: broken.decision.reasonCode, sys: broken.decision.systemFailure, errors: broken.decision.errors });
  check('F3 引用链断了时 available 是 **null**，绝不是 0（把"我不知道"说成"没有钱"是 R5 的根因）',
    broken.snapshot != null &&
    broken.snapshot.availableBalanceMinor === null &&
    broken.snapshot.ledgerBalanceMinor === null &&
    broken.snapshot.reservedBalanceMinor === null &&
    /* 连**读路径**也必须如实回答 null —— 两个层次都要 fail closed。 */
    (() => {
      const view = store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {});
      return view.availableBalanceMinor === null && view.balanceKnown === false;
    })(),
    { snapshot: broken.snapshot && broken.snapshot.availableBalanceMinor });
  check('F4 引用链断了不会被读成"规则不存在"（POLICY_NOT_FOUND 会是另一句错误的话）',
    broken.decision.reasonCode !== 'POLICY_NOT_FOUND' &&
    broken.decision.reasonCode !== 'DAILY_LIMIT' &&
    broken.decision.reasonCode !== 'AMOUNT_EXCEEDS_PER_TRANSACTION');
  check('F5 评估本身是纯读：它不因为发现结构事故就跑去"修"库（修与判必须分开）',
    (() => {
      const view = store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {});
      const again = evaluate(store, 100);
      return view.availableBalanceMinor === null && again.decision.systemFailure === true &&
        store.health().open === true;
    })());
  check('F6 连续多次评估得到同一个系统故障结论（不是"第一次坏了、第二次随机好转"）',
    (() => {
      const first = evaluate(store, 100).decision.reasonCode;
      for (let i = 0; i < 5; i++) if (evaluate(store, 100).decision.reasonCode !== first) return false;
      return first === 'WALLET_NOT_READY';
    })());
  store.close();

  /* ── 库没开：抛错（而不是返回一个"余额 0"的结论）───────────────── */
  const closed = makeStore({ dataDir: tmpDir('closed'), clock: clock });
  let threw = null;
  try { closed.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100 }); }
  catch (error) { threw = error; }
  check('F7 库没打开时 evaluateBudgetFor 抛 STORE_CLOSED（不是返回 DENY，也不是返回 0 余额）',
    threw !== null && /not open/.test(String(threw.message)));
  check('F8 关库之后 health() 仍然回答 state（不抛错）—— 抛错会诱使调用方把"关着"读成"没有钱"',
    closed.health().state === C.WALLET_STATE.COLD && closed.health().open === false);

  /* ── now 非法：系统侧问题 ───────────────────────────────────────── */
  const clock2 = mutableClock(Date.UTC(2024, 0, 15, 12, 0, 0));
  const store2 = makeStore({ dataDir: tmpDir('badnow'), clock: clock2 });
  store2.open();
  walletWith(store2, 100n);
  putPolicy(store2, { tag: 'g', limits: SAMPLE_LIMITS });
  check('F9 now 不是安全整数 ⇒ DENY / POLICY_INPUT_NOT_STRUCTURED / systemFailure（而不是当成"没有窗口"）',
    (() => {
      const out = store2.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, now: 1.5 });
      return out.decision.outcome === 'DENY' && out.decision.systemFailure === true &&
        out.decision.reasonCode === 'POLICY_INPUT_NOT_STRUCTURED';
    })());
  check('F10 显式 now 被采纳（同一个库在两个时刻可以得到两个不同的窗口结论）',
    (() => {
      const early = store2.evaluateBudgetFor({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, now: Date.UTC(2024, 0, 15, 12)
      });
      const later = store2.evaluateBudgetFor({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, now: Date.UTC(2024, 1, 15, 12)
      });
      return early.decision.outcome === 'ALLOW' && later.decision.outcome === 'ALLOW' &&
        early.snapshot.windows.dayStartsAt < later.snapshot.windows.dayStartsAt;
    })());
  store2.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · 政策变更不是经济运动（§21）与评估不改任何东西（§7/§18）
   ══════════════════════════════════════════════════════════════════ */
section('G · 改规则 / 做评估都不产生经济后果（ledgerMutation:false）');

{
  const clock = mutableClock(Date.UTC(2024, 0, 15, 12, 0, 0));
  const dir = tmpDir('nomutation');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);
  /* 先建一条政策 —— 这样下面测的是**更新**路径（created:false），
     而不是"第一条政策恰好也是唯一一条"。 */
  putPolicy(store, { tag: 'before', limits: SAMPLE_LIMITS });

  /* 一个"经济状态指纹"：把钱包、预留、政策、报价、账本拓扑、行数与
     revision 一起取下来。任何一次**读**之后它必须逐字相同。 */
  const before = economyFingerprint(store);
  const revisionBefore = store.getRevision();

  const evals = [evaluate(store, 100), evaluate(store, 250), evaluate(store, 350), evaluate(store, 0)];
  check('G1 四次评估（ALLOW / REQUIRE_APPROVAL / DENY / INVALID）之后，钱包、账本、预留**逐字未变**',
    economyFingerprint(store) === before,
    { before: before.slice(0, 400), after: economyFingerprint(store).slice(0, 400) });
  check('G2 评估**不消耗 revision**（评估不是一次经济事件，也不该是审计噪音）',
    store.getRevision() === revisionBefore);
  check('G3 评估结果里带着"只评估"的声明（evaluatedOnly / notASpendPermit / reserved:false）',
    evals.every(e => e.evaluatedOnly === true && typeof e.notASpendPermit === 'string' &&
      e.notASpendPermit.length > 0 && e.reserved === false));

  const revBeforePolicy = store.getRevision();
  const upd = putPolicy(store, { tag: 'after', limits: Object.assign({}, SAMPLE_LIMITS, { dailyMinor: 800 }) });
  const afterPolicyFingerprint = economyFingerprint(store);
  check('G4 改政策**不写 ledger**：交易数、entry 数、reserved、available 全部不变',
    JSON.parse(afterPolicyFingerprint).counts.transactions === JSON.parse(before).counts.transactions &&
    JSON.parse(afterPolicyFingerprint).counts.entries === JSON.parse(before).counts.entries &&
    JSON.parse(afterPolicyFingerprint).counts.reservations === JSON.parse(before).counts.reservations &&
    JSON.parse(afterPolicyFingerprint).counts.activeReservations === JSON.parse(before).counts.activeReservations &&
    J(JSON.parse(afterPolicyFingerprint).topology) === J(JSON.parse(before).topology),
    { before: JSON.parse(before).counts, after: JSON.parse(afterPolicyFingerprint).counts });
  check('G5 改政策的 change payload 里逐字写着 ledgerMutation:false（审计里"规则变了"与"账本动了"一眼可分）',
    upd.ledgerMutation === false &&
    store.listChanges(revBeforePolicy, 10).filter(c => c.kind === 'BUDGET_POLICY_UPDATED')
      .every(c => c.payload.ledgerMutation === false),
    store.listChanges(revBeforePolicy, 10).map(c => c.kind));
  check('G6 改政策**消耗**一个 revision（规则的变化是一条不该被静默的事实）',
    store.getRevision() === revBeforePolicy + 1);
  check('G7 改政策的事件是 BUDGET_POLICY_UPDATED，且整条 change log 仍是同一条无洞的 revision 序列',
    (() => {
      const all = store.listChanges(0, 500);
      const changed = store.listChanges(revBeforePolicy, 10);
      return upd.created === false &&
        changed.length === 1 && changed[0].kind === 'BUDGET_POLICY_UPDATED' &&
        changed[0].revision === revBeforePolicy + 1 &&
        all.length === store.getRevision() &&
        all.every((c, i) => Number(c.revision) === i + 1) &&
        /* 建政策的那一条也在同一条序列里 —— "没有第二套 revision" */
        all.some(c => c.kind === 'BUDGET_POLICY_CREATED');
    })(),
    { revision: store.getRevision(), revBeforePolicy: revBeforePolicy, kinds: store.listChanges(revBeforePolicy, 10).map(c => c.kind) });

  /* 评估一个**不存在**的 owner：不能凭空创建钱包或政策。 */
  const beforeGhost = economyFingerprint(store);
  const ghost = store.evaluateBudgetFor({ ownerId: 'cfg_ghost', currency: 'IB_CREDIT', amountMinor: 10 });
  check('G8 给一个不存在的 owner 做评估不会凭空创建钱包 / 政策（评估没有副作用）',
    ghost.ok === true && ghost.decision.outcome === 'DENY' &&
    economyFingerprint(store) === beforeGhost &&
    store.listWallets({}).length === 1);
  check('G9 spendingWindows 也是纯读（它被调用十次不改变任何东西）',
    (() => {
      for (let i = 0; i < 10; i++) store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
      return economyFingerprint(store) === beforeGhost && store.getRevision() === revBeforePolicy + 1;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · 幂等（§11 的同一纪律用到政策上，scope = POLICY）
   ══════════════════════════════════════════════════════════════════ */
section('H · 幂等：同一个 key 在 POLICY scope 下的重放与冲突');

{
  const dir = tmpDir('idem');
  const store = makeStore({ dataDir: dir });
  store.open();
  walletWith(store, 1000n);

  const first = putPolicy(store, { tag: 'h1', idempotencyKey: 'policy-h1', limits: SAMPLE_LIMITS });
  const replay = store.putBudgetPolicy({
    ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: 'policy-h1', limits: SAMPLE_LIMITS
  });
  check('H1 同 key 同 payload ⇒ replayed:true，且返回**原来**那一次的结果',
    replay.ok === true && replay.replayed === true &&
    replay.result.policyId === first.policyId && replay.result.revision === first.revision);

  const revAfterReplay = store.getRevision();
  check('H2 重放零副作用：revision 不动、change log 不增、政策不变',
    revAfterReplay === first.revision &&
    store.listChanges(0, 500).filter(c => c.kind === 'BUDGET_POLICY_CREATED').length === 1);

  const conflict = store.putBudgetPolicy({
    ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: 'policy-h1',
    limits: Object.assign({}, SAMPLE_LIMITS, { dailyMinor: 12345 })
  });
  check('H3 同 key 不同 payload ⇒ IDEMPOTENCY_CONFLICT（不静默返回第一次的结果）',
    conflict.ok === false && conflict.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0 &&
    store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy.limits.dailyMinor === 500n);
  check('H4 冲突被拒之后 revision 与政策**完全没变**（冲突检测在任何写入之前）',
    store.getRevision() === revAfterReplay &&
    store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy.limits.dailyMinor !== 12345n);
  check('H5 数字与字符串 key 归一成同一个身份（P22-1 §5 的规则在 P22-4 继续成立）',
    (() => {
      const numeric = store.putBudgetPolicy({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: 7777, limits: SAMPLE_LIMITS, disable: true
      });
      const stringy = store.putBudgetPolicy({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: '7777', limits: SAMPLE_LIMITS, disable: true
      });
      return numeric.ok === true && stringy.replayed === true &&
        stringy.result.policyId === numeric.result.policyId;
    })());
  check('H6 POLICY 与 RESERVE 是**两个** scope：同一个 key 在两边是两件事',
    (() => {
      const w = store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' });
      const res = store.reserveFunds({
        walletId: w.wallet.walletId, currency: 'IB_CREDIT', amountMinor: 10n,
        expiresAt: store._internal.SQL && Date.now() + 60000, idempotencyKey: 'policy-h1'
      });
      const rows = new DatabaseSync(path.join(dir, 'home-node.db'))
        .prepare('SELECT scope, idempotency_key FROM ' + store.TABLES.OPERATION_IDEMPOTENCY + ' WHERE idempotency_key=?')
        .all('policy-h1');
      return res.ok === true && rows.length === 2 &&
        rows.map(r => String(r.scope)).sort().join(',') === 'POLICY,RESERVE';
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   I · 崩溃注入（§33：不得留下 partial policy）
   ══════════════════════════════════════════════════════════════════ */
section('I · 崩溃注入：政策写入的每一个故障点都必须整体回滚');

const POLICY_FAULTS = [
  'after-policy-insert',
  'after-policy-update',
  'before-policy-change-log',
  'before-policy-commit',
  'after-policy-expire-validated',
  'after-policy-expired',
  'before-policy-expire-change-log',
  'before-policy-expire-commit'
];

POLICY_FAULTS.forEach((fault, index) => {
  const dir = tmpDir('crash-' + index);
  let bang = false;
  const store = makeStore({
    dataDir: dir,
    faults: { hit: (name) => { if (name === fault && !bang) { bang = true; const e = new Error('injected:' + name); e.code = 'INJECTED_FAULT'; throw e; } } }
  });
  store.open();
  const w = walletWith(store, 500n);

  const expiring = fault.indexOf('expire') >= 0;
  let policyId = null;
  /* ── 为什么"更新路径"的故障点要先**真的**建一条政策 ─────────────────
     after-policy-update 只在**已存在**政策时才会被执行（新建走的是
     after-policy-insert）。因此对那一个故障点，必须先在不注入的状态下
     把政策建出来 —— 否则那条断言会在"什么都没执行"的情况下变绿，
     而一个关于注入的断言在注入没发生时通过，是这类测试最坏的失败方式。
     播种类写入用的是**不同的** idempotencyKey：幂等键相同 + payload
     不同会被判成 IDEMPOTENCY_CONFLICT（那是刻意的设计，不是这里要测的）。 */
  const testingUpdatePath = fault === 'after-policy-update';
  const seedKey = testingUpdatePath ? 'seed-before-injection' : 'seed-for-' + fault;
  if (expiring || testingUpdatePath) {
    /* 为了测到期/更新路径的故障点，先**正常**建一条（到期那一路还会
       把它的期限改到过去：期限是一条数据，到期是一个比较）。 */
    const created = putPolicy(store, {
      tag: 'x', idempotencyKey: seedKey, limits: SAMPLE_LIMITS,
      termEndsAt: expiring ? Date.now() + 1000 : null
    });
    policyId = created.policyId;
    if (expiring) {
      const rawSeed = new DatabaseSync(store.health().file);
      rawSeed.prepare('UPDATE ' + store.TABLES.BUDGET_POLICIES + ' SET term_ends_at=? WHERE policy_id=?')
        .run(Number(Date.now()) - 1000, policyId);
      rawSeed.close();
    }
  }
  /* 注入**之前**把真实基线取下来（行数、revision、账本指纹、change 数）。 */
  const rawBefore = new DatabaseSync(store.health().file);
  const base = {
    policies: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.BUDGET_POLICIES).get().c),
    changes: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.CHANGE_LOG).get().c),
    idempotency: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.OPERATION_IDEMPOTENCY).get().c),
    transactions: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.TRANSACTIONS).get().c),
    entries: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.ENTRIES).get().c),
    revision: store.getRevision(),
    balances: economyFingerprint(store)
  };
  rawBefore.close();

  let threw = null;
  try {
    if (expiring) store.expirePolicy({ policyId: policyId, now: Date.now() });
    else if (testingUpdatePath) {
      /* 更新路径：同一条 owner 上再写一次（政策已存在 ⇒ created=false ⇒
         走 upsert ⇒ 撞上 after-policy-update）。 */
      store.putBudgetPolicy({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: 'crash-update',
        limits: Object.assign({}, SAMPLE_LIMITS, { dailyMinor: 777 })
      });
    } else putPolicy(store, { tag: 'crash', limits: SAMPLE_LIMITS });
  } catch (error) { threw = error; }

  check('I' + (index + 1) + ' 故障点 ' + fault + '：抛出的是注入的错误（不是被吞掉）',
    threw !== null && threw.code === 'INJECTED_FAULT', threw && (threw.code || threw.message));

  const raw = new DatabaseSync(store.health().file);
  const rows = raw.prepare('SELECT * FROM ' + store.TABLES.BUDGET_POLICIES).all();
  const idem = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.OPERATION_IDEMPOTENCY).get();
  const changes = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.CHANGE_LOG).get();
  const txs = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.TRANSACTIONS).get();
  const entries = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.ENTRIES).get();
  raw.close();

  check('I' + (index + 1) + 'b 故障点 ' + fault + '：没有留下部分政策行（行数回到注入前）',
    rows.length === base.policies, { after: rows.length, before: base.policies });
  check('I' + (index + 1) + 'c 故障点 ' + fault + '：幂等表回到注入前的行数（重试能真的落地）',
    Number(idem.c) === base.idempotency, { after: Number(idem.c), before: base.idempotency });
  check('I' + (index + 1) + 'd 故障点 ' + fault + '：change log / 账本 / revision 全部回到注入前',
    Number(changes.c) === base.changes && Number(txs.c) === base.transactions &&
    Number(entries.c) === base.entries && store.getRevision() === base.revision &&
    economyFingerprint(store) === base.balances,
    { changes: Number(changes.c), before: base.changes, revision: store.getRevision(), revBefore: base.revision });
  store.close();
});

/* ══════════════════════════════════════════════════════════════════
   J · 重启恢复（§34）
   ══════════════════════════════════════════════════════════════════ */
section('J · 重启恢复：政策与窗口在 close → open 之后逐字相同');

{
  const clock = mutableClock(Date.UTC(2024, 0, 15, 12, 0, 0));
  const dir = tmpDir('restart');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);
  putPolicy(store, {
    tag: 'r', limits: SAMPLE_LIMITS,
    termEndsAt: Date.UTC(2024, 5, 1), autonomyLevel: 'STANDARD'
  });
  spend(store, w.walletId, 120n, 'r1');
  const before = evaluate(store, 100);
  const policyBefore = store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
  const windowsBefore = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });
  const revisionBefore = store.getRevision();
  store.close();

  const reopened = makeStore({ dataDir: dir, clock: clock });
  reopened.open();
  const after = reopened.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100 });
  const windowsAfter = reopened.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() });

  check('J1 重启之后政策逐字还在（限额 / 期限 / autonomyLevel / revision 全部相同）',
    J(reopened.getBudgetPolicy({ ownerId: 'cfg_a' }).policy) === J(policyBefore),
    { before: policyBefore, after: reopened.getBudgetPolicy({ ownerId: 'cfg_a' }).policy });
  check('J2 重启之后三个窗口逐字相同（它们是从 committed 事实重算的，不是存下来的）',
    J(windowsAfter) === J(windowsBefore));
  check('J3 重启之后同一个输入的评估结论逐字相同（含 snapshot 与 priority）',
    J(after.snapshot) === J(before.snapshot) && after.decision.reasonCode === before.decision.reasonCode &&
    after.decision.priority === before.decision.priority);
  check('J4 重启**不**消耗 revision（对账无误 ⇒ 什么都不写）',
    reopened.getRevision() === revisionBefore);
  check('J5 重启之后停用仍然是停用（状态是持久事实，不是内存标记）',
    (() => {
      putPolicy(reopened, { tag: 'r-off', disable: true });
      reopened.close();
      const third = makeStore({ dataDir: dir, clock: clock });
      third.open();
      const p = third.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
      const out = third.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10 });
      third.close();
      return p.status === 'DISABLED' && p.hardStop === true &&
        out.decision.reasonCode === 'POLICY_NOT_FOUND';
    })());
  check('J6 期限是一个**比较**：进程离线跨过期限之后重启，政策自动不生效（没有定时器参与）',
    (() => {
      const store2 = makeStore({ dataDir: dir, clock: clock });
      store2.open();
      putPolicy(store2, { tag: 'term', limits: SAMPLE_LIMITS, termEndsAt: clock() + 60000 });
      store2.close();
      clock.advance(120000);
      const store3 = makeStore({ dataDir: dir, clock: clock });
      store3.open();
      const p = store3.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
      const out = store3.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10 });
      /* 行仍然是 ACTIVE（到期是比较出来的，不是某个调度写下来的），
         但**评估**必须说不。 */
      const swept = store3.expireDuePolicies({ now: clock() });
      const afterSweep = store3.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
      store3.close();
      return p.status === 'ACTIVE' && p.expiredByTerm === true &&
        out.decision.reasonCode === 'POLICY_TERM_EXPIRED' &&
        swept.expired.length === 1 && afterSweep.status === 'DISABLED';
    })());
  check('J7 到期扫描幂等：再扫一次什么都不做（不可能产生第二条 expiration）',
    (() => {
      const store4 = makeStore({ dataDir: dir, clock: clock });
      store4.open();
      const again = store4.expireDuePolicies({ now: clock() });
      const kinds = store4.listChanges(0, 500).map(c => c.kind);
      store4.close();
      return again.expired.length === 0 && again.scanned === 0 &&
        kinds.filter(k => k === 'BUDGET_POLICY_EXPIRED').length === 1;
    })());
}

/* ══════════════════════════════════════════════════════════════════
   K · schema 2 → 3（§10 的同一条纪律，第三次应用）
   ══════════════════════════════════════════════════════════════════ */
section('K · schema 2 → 3：补表 + 抬水位，既有账本一个字节不动');

{
  const clock = mutableClock(Date.UTC(2024, 0, 15, 12, 0, 0));
  const dir = tmpDir('migrate');
  /* 先用"P22-3 代"的库：把水位写成 2 并删掉 P22-4 的两张表。 */
  const seed = makeStore({ dataDir: dir, clock: clock });
  seed.open();
  const w = walletWith(seed, 777n);
  spend(seed, w.walletId, 100n, 'm1');
  /* 基线必须在**所有**播种动作之后一起取：revision 与 change log 条数
     是同一个量的两种读法，分两次取会让"一字节都没动"变成一句关于
     测试自己动作顺序的话（开发期实测踩到：revision 在 reserve 之前读、
     changes 在之后读，于是两端各差一个）。 */
  const channel = seed.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 50n,
    expiresAt: clock() + 600000, idempotencyKey: 'm-res'
  }).result.reservationId;
  const before = {
    revision: seed.getRevision(),
    ledger: seed.ledgerBalanceOf(w.walletId).balanceMinor,
    channel: channel,
    changes: seed.listChanges(0, 500).length,
    topology: seed.ledgerTopology(null)
  };
  seed.close();
  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  raw.exec('DROP TABLE ' + seed.TABLES.BUDGET_POLICIES);
  raw.exec('DROP TABLE ' + seed.TABLES.QUOTES);
  raw.prepare('UPDATE ' + seed.TABLES.META + ' SET value=? WHERE key=?').run('2', seed.META_KEYS.SCHEMA);
  raw.close();

  /* 打开旧库之后的第一件事：确认两张新表是**空的**（补表不等于补数据），
     然后取基线。基线必须在**所有**播种动作之后取 —— 否则"一字节都没动"
     这句话会变成一句关于测试自己动作的话。 */
  const upgraded = makeStore({ dataDir: dir, clock: clock });
  const opened = upgraded.open();
  const migratedEmpty = upgraded.health().counts.budgetPolicies === 0 &&
    upgraded.health().counts.quotes === 0;
  check('K1 打开 P22-3 代的库：水位抬到 3，两张新表被补上且**是空的**（补表不等于补数据）',
    opened.ok === true && Number(opened.schemaVersion) === 3 &&
    Number(upgraded.health().schemaVersion) === 3 && migratedEmpty);
  check('K1b 既有账本与预留一字节都没动：revision / 余额 / 拓扑 / change log 逐条相同',
    upgraded.getRevision() === before.revision &&
    upgraded.ledgerBalanceOf(w.walletId).balanceMinor === before.ledger &&
    upgraded.listChanges(0, 500).length === before.changes &&
    J(upgraded.ledgerTopology(null)) === J(before.topology) &&
    upgraded.getReservation({ reservationId: before.channel }).reservation.state === 'ACTIVE',
    { revision: upgraded.getRevision(), before: before.revision, changes: upgraded.listChanges(0, 500).length });
  check('K2 在**旧库**上建一条政策之后，既有账本仍然一个字节都没动（只多了政策那一行）',
    (() => {
      const created = putPolicy(upgraded, { tag: 'migrated-seed', limits: SAMPLE_LIMITS });
      return created.created === true &&
        upgraded.ledgerBalanceOf(w.walletId).balanceMinor === before.ledger &&
        J(upgraded.ledgerTopology(null)) === J(before.topology) &&
        upgraded.health().counts.transactions === 2 &&
        upgraded.health().counts.budgetPolicies === 1;
    })());
  check('K3 补表之后 P22-4 的能力立即可用（在旧库上直接建政策并评估）',
    (() => {
      putPolicy(upgraded, { tag: 'migrated', limits: SAMPLE_LIMITS });
      const out = upgraded.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100 });
      return out.decision.outcome === 'ALLOW' &&
        upgraded.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: clock() }).spentTodayMinor === 100n;
    })());
  upgraded.close();
}

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-4 budget: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-4 budget: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
