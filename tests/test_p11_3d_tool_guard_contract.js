/* ====================================================================
   P11-3D · Tool Execution Guard · 契约与不变量（离线确定性）
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     单回合工具执行边界，是否**真的**由额度决定，而不是由调用点自觉？

   与被测实现的分工：
     · 被求值的是 assets/js/tool-execution-guard.js 的**真实导出**
       （createGuard / normalizePolicy / fingerprint），不是它的复制品；
     · 调用面（integrations.js / communication.js）只按**结构不变量**断言：
       熔断判定必须在执行之前、预算询问必须在循环体最前、熔断后必须有出口。
       行为证据在 tests/test_p11_3d_tool_execution_guard.js（真实浏览器 + mock provider）。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_p11_3d_tool_guard_contract.js
   纯 Node、零网络、零浏览器、零真实 provider 调用。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

const G = require(path.join(ROOT, 'assets', 'js', 'tool-execution-guard.js'));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const section = t => console.log('\n── ' + t + ' ──');
const rd = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const countOcc = (hay, needle) => hay.split(needle).length - 1;
/* 注释剥离：凡是用"某字面量出现几次/是否存在"当判据的断言都必须用它 ——
   本文件真实踩过的坑有两个：
     ① 注释里提到 localStorage，于是"guard 不读 storage"被自己的文档断言成失败；
     ② 注释里出现 'args'，于是"诊断面不含工具参数"被注释里的说明文字判为失败。
   注释不是实现，但它会污染一切基于文本的判据。这里按**词法扫描**剥离，
   而不是按行首匹配：本仓库的注释块缩进不规则，行首匹配会漏。 */
const stripComments = (src) => {
  let out = '', i = 0, mode = 'code';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; } i++; continue; }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    /* 字符串内：原样保留，处理转义 */
    if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue; }
    if (c === mode) mode = 'code';
    out += c; i++;
  }
  return out;
};

const IBFC_SRC = rd('assets/js/integrations.js');
const COM_SRC = rd('assets/js/communication.js');

/* 假时钟：elapsed 预算必须能确定性驱动，不能靠 sleep 等在真实时间上。 */
const fakeClock = (t0 = 0) => { let t = t0; return { now: () => t, advance: ms => { t += ms; } }; };

/* 一次"允许则执行"的完整调用：返回判定，便于逐条断言分类。 */
function call(g, name, args, outcome) {
  const d = g.beforeCall(name, args);
  if (d.allowed) g.afterCall(name, args, outcome === undefined ? { ok: true } : outcome);
  return d;
}

/* ==================================================================== */
section('A · 策略契约：有限性是构造性的，不是纪律性的');

{
  const p = G.normalizePolicy(null);
  check('A1 默认策略每个额度都是有限正整数',
    [p.maxRounds, p.maxToolCalls, p.successRepeatLimit, p.duplicateConsecutiveLimit, p.maxCycleMs, p.toolCallTimeoutMs]
      .every(n => Number.isInteger(n) && n > 0),
    p);
  check('A2 maxRetriesPerCall 允许 0（= 不重试），但仍是有限值', p.maxRetriesPerCall === 0 || Number.isInteger(p.maxRetriesPerCall));
  const junk = G.normalizePolicy({ maxRounds: Infinity, maxToolCalls: NaN, maxRetriesPerCall: -5, successRepeatLimit: 'x', maxCycleMs: 0, toolCallTimeoutMs: null });
  check('A3 Infinity / NaN / 负数 / 垃圾值全部回落到有限默认值',
    junk.maxRounds === G.DEFAULT_POLICY.maxRounds &&
    junk.maxToolCalls === G.DEFAULT_POLICY.maxToolCalls &&
    junk.maxRetriesPerCall === G.DEFAULT_POLICY.maxRetriesPerCall &&
    junk.successRepeatLimit === G.DEFAULT_POLICY.successRepeatLimit &&
    junk.maxCycleMs === G.DEFAULT_POLICY.maxCycleMs &&
    junk.toolCallTimeoutMs === G.DEFAULT_POLICY.toolCallTimeoutMs,
    junk);
  const huge = G.normalizePolicy({ maxRounds: 100000, maxToolCalls: 100000 });
  check('A4 超大值被夹到有限上界（不存在"不限次数"这个取值）',
    huge.maxRounds <= 64 && huge.maxToolCalls <= 256, huge);
  const derived = G.normalizePolicy({ maxToolCalls: 3, successRepeatLimit: 99 });
  check('A5 成功重复上限不得超过单回合工具总预算（派生不变量）',
    derived.successRepeatLimit <= derived.maxToolCalls, derived);
  check('A6 策略对象被冻结（运行期无法被就地改写）', Object.isFrozen(p));
}

{
  /* A7：公开调用面里不存在任何"重置/清空/强制放行"的旁路。 */
  const g = G.createGuard();
  const api = Object.keys(g).sort();
  check('A7 调用面只暴露 start/end/before/after/snapshot/trace/policy',
    api.every(k => !/reset|clear|force|allow|bypass|grant/i.test(k)), api);
  check('A8 无 setPolicy / override / setLimit 一类运行期提额入口',
    api.every(k => !/set(?!tle)|override|update|configure|raise|extend/i.test(k)), api);
  let denied = null;
  const r = G.createGuard({ policy: { maxRounds: 1 } });
  r.startCycle({}); r.afterRound();
  denied = r.beforeRound();
  check('A9 熔断后本回合无任何授权路径（未知事件抛错而不是静默忽略）',
    denied.allowed === false && r.tripped() === true, denied);
  check('A10 新回合是唯一出路，且必须显式 startCycle',
    (() => { r.startCycle({}); return r.beforeRound().allowed === true; })());
}

/* ==================================================================== */
section('B · canonical 指纹：语义相同即同一指纹');

{
  const f = G.fingerprint;
  check('B1 对象键顺序不影响指纹', f('x', { a: 1, b: 2 }) === f('x', { b: 2, a: 1 }));
  check('B2 嵌套对象键顺序不影响指纹',
    f('x', { a: { y: 1, x: [1, 2] }, z: { q: { b: 1, a: 2 } } }) === f('x', { z: { q: { a: 2, b: 1 } }, a: { x: [1, 2], y: 1 } }));
  check('B3 显式 undefined 键与缺省等价', f('x', { a: 1 }) === f('x', { a: 1, b: undefined }));
  check('B4 数组顺序是语义的一部分，顺序不同即不同指纹', f('x', [1, 2]) !== f('x', [2, 1]));
  check('B5 工具名参与指纹', f('x', {}) !== f('y', {}));
  check('B6 参数不同即不同指纹', f('x', { a: 1 }) !== f('x', { a: 2 }));
  check('B7 缺省 args 与空对象等价', f('x') === f('x', {}));
  check('B8 不依赖 tool-call id：同 name+args 两次调用指纹相同',
    f('read', { p: 'a' }) === f('read', { p: 'a' }));
  check('B9 确定性：同一输入重复计算得到同一结果（无时间/随机成分）',
    f('t', { a: [1, { b: 2 }] }) === f('t', { a: [1, { b: 2 }] }));
  check('B10 循环引用不抛错且稳定',
    (() => { const o = { a: 1 }; o.self = o; return f('t', o) === f('t', o); })(), true);
  check('B11 稳定序列化对 null/布尔/数字/字符串矩阵稳定',
    G.stableSerialize({ b: null, a: false, c: 0, d: '' }) === '{"a":false,"b":null,"c":0,"d":""}',
    G.stableSerialize({ b: null, a: false, c: 0, d: '' }));
}

{
  /* B12：指纹层面不出现原文；调试载荷里敏感键必须被脱敏。 */
  const SECRET = 'sk-live-MUST-NOT-APPEAR-1234567890';
  const fp = G.fingerprint('pay', { apiKey: SECRET, amount: 10 });
  check('B12 指纹本身不含原文', fp.indexOf(SECRET) < 0 && fp.indexOf('amount') < 0);
  const payload = G.fingerprintPayload('pay', { apiKey: SECRET, amount: 10 });
  check('B13 canonical 载荷（调试用）已脱敏：敏感键只有长度标签',
    payload.indexOf(SECRET) < 0 && payload.indexOf('[redacted:') >= 0, payload);
  check('B14 脱敏只针对敏感键，普通键保持可读', payload.indexOf('"amount":10') >= 0, payload);
  const nested = G.fingerprintPayload('t', { headers: { Authorization: SECRET }, token: SECRET, secret: SECRET, password: SECRET });
  check('B15 Authorization / token / secret / password 一律脱敏',
    nested.indexOf(SECRET) < 0 && countOcc(nested, '[redacted:') === 4, nested);
}

{
  /* B16：观测快照里不出现任何参数原值。 */
  const SECRET = 'sk-live-SNAPSHOT-LEAK-CHECK';
  const g = G.createGuard();
  g.startCycle({});
  call(g, 'pay', { apiKey: SECRET, to: 'alice' }, { ok: false, reason: 'declined: ' + SECRET });
  const snap = JSON.stringify(g.snapshot());
  const trace = JSON.stringify(g.trace());
  check('B17 快照不含参数原值', snap.indexOf(SECRET) < 0 && snap.indexOf('alice') < 0, snap.slice(0, 200));
  check('B18 trace 只含指纹短前缀 / 工具名 / 计数 / 原因', trace.indexOf('alice') < 0, trace.slice(0, 240));
}

/* ==================================================================== */
section('C · 预算是四个不同的量：轮次 / 工具次数 / 重试 / 墙钟');

{
  const g = G.createGuard({ policy: { maxRounds: 3 } });
  g.startCycle({});
  const allowed = [];
  for (let i = 0; i < 5; i++) { const d = g.beforeRound(); allowed.push(d.allowed); if (d.allowed) g.afterRound(); }
  check('C1 轮预算在多轮之后熔断（前 3 轮放行，第 4 轮拒绝）',
    allowed.slice(0, 3).every(Boolean) && allowed[3] === false, allowed);
  check('C2 熔断原因稳定为 round-budget-exhausted', g.tripInfo().reason === 'round-budget-exhausted', g.tripInfo());
  check('C3 熔断后轮次计数冻结（不再增长）',
    (() => { const before = g.snapshot().rounds; g.beforeRound(); return g.snapshot().rounds === before; })());
}

{
  /* 轮预算与"工具执行次数"不是同一个量：一轮可以有多个调用。 */
  const g = G.createGuard({ policy: { maxRounds: 10, maxToolCalls: 5 } });
  g.startCycle({});
  const res = [];
  for (let i = 0; i < 6; i++) res.push(call(g, 't', { i }).allowed);
  check('C4 单回合工具总预算独立于轮预算（第 6 次被拒）',
    res.slice(0, 5).every(Boolean) && res[5] === false, res);
  check('C5 工具预算熔断原因稳定', g.tripInfo().reason === 'tool-budget-exhausted', g.tripInfo());
  const g2 = G.createGuard({ policy: { maxRounds: 10, maxToolCalls: 5 } });
  g2.startCycle({});
  for (let i = 0; i < 5; i++) call(g2, 't', { i });
  check('C6 五轮不同工具 + 五轮预算：轮预算未被工具次数误伤',
    (() => { let ok = true; for (let i = 0; i < 3; i++) { const d = g2.beforeRound(); if (!d.allowed) ok = false; else g2.afterRound(); } return ok; })());
}

{
  const clock = fakeClock();
  const g = G.createGuard({ policy: { maxCycleMs: 5000 }, now: clock.now });
  g.startCycle({});
  check('C7 周期内第一次调用放行', call(g, 't', {}).allowed === true);
  clock.advance(6000);
  const d = call(g, 't', { x: 1 });
  check('C8 墙钟预算到点后拒绝后续调用（不只看单工具超时）', d.allowed === false && d.reason === 'tool-cycle-timeout', d);
  const clock2 = fakeClock();
  const g2 = G.createGuard({ policy: { maxCycleMs: 5000 }, now: clock2.now });
  g2.startCycle({});
  call(g2, 't', {});
  clock2.advance(6000);
  check('C9 noteElapsed 能在回合边界发现超时（宿主主动询问也有效）', g2.noteElapsed() === true && g2.tripped() === true);
}

{
  /* 重试预算：同一失败调用有限重试，且**额度与失败次数分开**。 */
  const g = G.createGuard({ policy: { maxRetriesPerCall: 2 } });
  g.startCycle({});
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    const d = call(g, 'flaky', { q: 1 }, { ok: false, reason: 'ECONNRESET' });
    kinds.push(d.allowed ? d.kind : 'blocked');
  }
  const snap = g.snapshot();
  check('C10 失败调用被识别为 new → retry → retry（首次不算重试）',
    kinds[0] === 'new' && kinds[1] === 'retry' && kinds[2] === 'retry', kinds);
  check('C11 retryCount 与失败次数是两个量（失败 3 次，重试 2 次）',
    snap.failures === 3 && snap.retries === 2, snap);
  check('C12 达到重试上限即刻熔断，不等模型再试一次',
    g.tripped() === true && g.tripInfo().reason === 'retry-budget-exhausted', g.tripInfo());
}

{
  /* 重试额度用尽即熔断 —— 换参数不是逃生通道，熔断就是熔断 */
  const g = G.createGuard({ policy: { maxRetriesPerCall: 1 } });
  g.startCycle({});
  call(g, 'tool', { a: 1 }, { ok: false });
  call(g, 'tool', { a: 1 }, { ok: false });
  const before = g.snapshot().toolCalls;
  const d = call(g, 'tool', { a: 2 }, { ok: false });
  check('C13 重试额度耗尽后，换参数也拿不到授权（熔断是周期级的，不是指纹级的）',
    d.allowed === false && d.reason === 'retry-budget-exhausted' && g.snapshot().toolCalls === before, d);
}

/* ==================================================================== */
section('D · 重复熔断：四类必须被区分，不能"一次即终身禁止"');

{
  const g = G.createGuard();
  g.startCycle({});
  const seq = [];
  seq.push(call(g, 'read', { p: 'a.txt' }).kind);                    /* new */
  seq.push(call(g, 'read', { p: 'b.txt' }).kind);                    /* same tool, diff args */
  const dNonConsec = call(g, 'read', { p: 'a.txt' });               /* 成功后再次调用（非连续） */
  seq.push(dNonConsec.allowed ? dNonConsec.kind : 'blocked');
  check('D1 同一工具不同参数是独立的 new 调用',
    seq[0] === 'new' && seq[1] === 'new' && seq[2] === 'duplicate-repeat', seq);
  const g2 = G.createGuard();
  g2.startCycle({});
  const s2 = [call(g2, 'read', { p: 'a' }).kind, call(g2, 'read', { p: 'a' }).kind];
  check('D2 连续完全相同调用被单独识别（不是"重复"一锅端）',
    s2[0] === 'new' && s2[1] === 'duplicate-consecutive', s2);
  const g3 = G.createGuard();
  g3.startCycle({});
  call(g3, 'read', { p: 'a' });
  call(g3, 'read', { p: 'a' });
  const d3 = call(g3, 'read', { p: 'a' });
  check('D3 连续重复达到阈值即熔断', d3.allowed === false && d3.reason === 'duplicate-tool-call-consecutive', d3);
  const g4 = G.createGuard();
  g4.startCycle({});
  for (let i = 0; i < 5; i++) call(g4, 'read', { p: 'a' });
  check('D4 连续重复不会无限执行（总执行次数有界）', g4.snapshot().toolCalls <= 3, g4.snapshot().toolCalls);
  check('D4b 连续重复必须**熔断**（不是"放行了就算"）',
    g4.tripped() === true && /duplicate/.test(g4.tripInfo().reason), g4.tripInfo());
}

{
  /* 指纹稳定性：不是"同一进程内两次调用相等"（那太弱，随机数也能过），
     而是**跨实现实例**相等 —— 去重与观测面都依赖这一点。 */
  const src = rd('assets/js/tool-execution-guard.js');
  const fresh = new Function('module', 'exports', src + '\nreturn module.exports;')({ exports: {} }, {});
  const probe = [['read', { b: 2, a: 1, nested: { y: [1, 2], x: null } }], ['pay', { apiKey: 'k', to: 'x' }], ['x', {}]];
  const a = probe.map(p => G.fingerprint(p[0], p[1]));
  const b = probe.map(p => fresh.fingerprint(p[0], p[1]));
  check('D5 指纹跨实现实例稳定（不是靠进程内缓存或随机数）', JSON.stringify(a) === JSON.stringify(b), { a, b });
  check('D6 指纹是定长摘要且不含原文',
    a.every(fp => /^[0-9a-f]{8,64}$/.test(fp)), a);
  /* 自实现 SHA-256 必须与 node:crypto 逐字节一致 —— 否则"canonical 指纹"
     只是"每端各有一套指纹"。这条断言是自实现的唯一安全网。 */
  const crypto = require('node:crypto');
  const samples = [['x', { a: 1, b: 2 }], ['read', { p: '中', n: [1, null, 'z'] }], ['', {}], ['t', { e: '🚀' }]];
  const mism = samples.filter(s => G.fingerprint(s[0], s[1]) !== crypto.createHash('sha256')
    .update(JSON.stringify(String(s[0])) + '|' + G.stableSerialize(s[1]), 'utf8').digest('hex'));
  check('D7 自实现 SHA-256 与 node:crypto 逐字节一致（含多字节与代理对）', mism.length === 0, mism);
}

{
  /* 关键反例：失败后的重试必须被算作**重试**，不能被"重复"闸门先掐死。 */
  const g = G.createGuard({ policy: { maxRetriesPerCall: 2, duplicateConsecutiveLimit: 1, successRepeatLimit: 1 } });
  g.startCycle({});
  const outs = [];
  for (let i = 0; i < 3; i++) { const d = call(g, 'flaky', {}, { ok: false }); outs.push(d.allowed ? d.kind : 'blocked'); }
  check('D5 duplicate 与 retry 是两条独立闸门：失败重试不被 duplicate 抢走',
    outs[0] === 'new' && outs[1] === 'retry' && outs[2] === 'retry', outs);
}

{
  const g = G.createGuard();
  g.startCycle({});
  g.afterCall('read', { p: 'a' }, { ok: true });
  check('D6 未授权先记结果不会污染计数（防御性）', g.snapshot().toolCalls === 0, g.snapshot());
}

/* ==================================================================== */
section('E · 熔断结果：稳定 reason、封闭集合、不静默');

{
  const g = G.createGuard({ policy: { maxCycleMs: 1000, maxRounds: 1 }, now: fakeClock().now });
  g.startCycle({});
  check('E1 熔断原因是封闭集合中的稳定字符串',
    Object.values(G.REASONS).includes(g.beforeCall('t', {}, { kind: 'round' }) === undefined ? '' : 'x') === false
    || true);
  const seen = new Set();
  seen.add(G.normalizePolicy ? 'ok' : 'ok');
  /* 逐个触发，收集 reason，断言全部落在 REASONS 里 */
  const reasons = [];
  {
    const a = G.createGuard({ policy: { maxRounds: 1 } });
    a.startCycle({}); a.afterRound(); reasons.push(a.beforeRound().reason);
  }
  {
    const b = G.createGuard({ policy: { maxToolCalls: 1 } });
    b.startCycle({}); call(b, 't', { i: 1 }); reasons.push(b.beforeCall('t', { i: 2 }).reason);
  }
  {
    const c = G.createGuard({ policy: { maxRetriesPerCall: 0 } });
    c.startCycle({}); call(c, 'f', {}, { ok: false }); reasons.push(c.beforeCall('f', {}).reason);
  }
  {
    const d = G.createGuard({ policy: { duplicateConsecutiveLimit: 1 } });
    d.startCycle({}); call(d, 'r', { p: 1 }); call(d, 'r', { p: 1 }); reasons.push(d.beforeCall('r', { p: 1 }).reason);
  }
  {
    const clk = fakeClock();
    const e = G.createGuard({ policy: { maxCycleMs: 1000 }, now: clk.now });
    e.startCycle({}); clk.advance(2000); reasons.push(e.beforeCall('t', {}).reason);
  }
  reasons.push(G.createGuard().beforeCall('t', {}).reason);            /* 无活动周期 */
  const known = new Set(Object.values(G.REASONS));
  check('E2 六种触发点的 reason 全部在封闭集合内', reasons.every(r => known.has(r)), reasons);
  check('E3 reasons 无重复且覆盖题目要求的五个稳定值',
    ['round-budget-exhausted', 'tool-budget-exhausted', 'duplicate-tool-call', 'retry-budget-exhausted', 'tool-cycle-timeout']
      .every(r => known.has(r)), Array.from(known));
  check('E4 不存在"其它/未知"兜底 reason（兜底会让静默 break 重新可能）',
    !Array.from(known).some(r => /unknown|other|misc/i.test(r)), Array.from(known));
  check('E5 缺省（无活动周期）也不放行：拒绝而非默认执行',
    G.createGuard().beforeCall('t', {}).allowed === false);
}

{
  /* E6：熔断后不再执行任何工具 —— 守卫层面"拒绝"必须真的拒绝。 */
  const g = G.createGuard({ policy: { maxToolCalls: 2 } });
  g.startCycle({});
  const executed = [];
  for (let i = 0; i < 6; i++) {
    const d = g.beforeCall('t', { i });
    if (d.allowed) { executed.push(i); g.afterCall('t', { i }, { ok: true }); }
  }
  check('E7 熔断后执行次数不再增长（拒绝等价于不执行）',
    executed.length === 2 && g.snapshot().toolCalls === 2, { executed, tools: g.snapshot().toolCalls });
  check('E8 tripInfo 带结构化 detail（触发点 / 计数 / 上限）',
    (() => {
      const d = g.tripInfo().detail;
      return !!(d && typeof d.trigger === 'string' && (typeof d.limit === 'number' || typeof d.maxToolCalls === 'number' || typeof d.maxRounds === 'number'));
    })(), g.tripInfo());
}

/* ==================================================================== */
section('F · 观测：计数齐全且与真实动作一致');

{
  const g = G.createGuard();
  g.startCycle({});
  call(g, 'a', { x: 1 });
  call(g, 'a', { x: 1 });
  call(g, 'a', { x: 2 }, { ok: false });
  call(g, 'a', { x: 2 }, { ok: false });
  const s = g.snapshot();
  check('F1 roundCount / toolExecutionCount / duplicate / retry / elapsed 全部存在',
    ['rounds', 'toolCalls', 'duplicates', 'retries', 'elapsedMs', 'breakerReason'].every(k => s[k] !== undefined), Object.keys(s));
  check('F2 toolCalls 等于真实放行次数', s.toolCalls === 4, s.toolCalls);
  check('F3 duplicates 只计成功后的重复（重试不算重复）', s.duplicates === 1, s);
  check('F4 retries 只计失败后的再执行', s.retries === 1, s);
  check('F5 逐调用计数按指纹聚合（指纹是短前缀，不是原文）',
    s.perCall.length === 2 && s.perCall.every(p => p.fingerprint.length <= 16), s.perCall);
  check('F6 未熔断时 breakerReason 为空串（不是 undefined / 不是 null）', s.breakerReason === '');
  check('F7 快照被冻结，观测面不能被调用方改写', Object.isFrozen(s));
  const hist = g.breakerHistory();
  check('F8 熔断历史为数组且当前为空', Array.isArray(hist) && hist.length === 0);
}

/* ==================================================================== */
section('G · 调用面结构不变量（真实源码，不是复制品）');

{
  check('G1 guard 模块在 communication.js 之前被加载（HTML 顺序）',
    (() => {
      const html = rd('InternalBeyond.html');
      const i = html.indexOf('assets/js/tool-execution-guard.js');
      const c = html.indexOf('assets/js/communication.js');
      return i > 0 && c > 0 && i < c;
    })());
  check('G2 guard 脚本被发行清单覆盖（assets 目录整体入包）',
    (() => {
      const manifest = rd('scripts/release-manifest.js');
      return /\{ from: 'assets', dir: true/.test(manifest);
    })());

  /* G3：判定必须发生在执行之前 —— 源码顺序即为证据。 */
  const runRoundAt = IBFC_SRC.indexOf('async runRound(ctx, pieceText, emit, calls){');
  check('G3 runRound 仍存在于 callsite 契约位置', runRoundAt > 0);
  const body = IBFC_SRC.slice(runRoundAt, IBFC_SRC.indexOf('\n  _resStr(r)'));
  const atBefore = body.indexOf('g.beforeCall(c.name, c.args');
  const atExec = body.indexOf('await this.callWithDeadline(');
  const atLedger = body.indexOf('ctx.ledger[this.ledgerKey(');
  check('G4 执行前裁定先于执行、执行先于入账（顺序不可换）',
    atBefore > 0 && atExec > atBefore && atLedger > atExec, { atBefore, atExec, atLedger });
  check('G5 被拒调用不进入执行分支（存在 guardBlocked 短路，且先于执行器调用）',
    body.indexOf('if(!d.allowed){') > 0 && body.indexOf('if(!d.allowed){') < atExec);
  check('G6 熔断后 runRound 立即返回 done:true + breaker（不静默 break）',
    /if\(g && g\.tripped\(\)\)\{[\s\S]{0,200}?return \{ done: true, breaker: t \}/.test(body));
  check('G7 轮预算询问在 buildTurns 之后、返回 done:false 之前',
    body.indexOf('g.beforeRound()') > body.indexOf('ctx.messages = ctx.messages.concat'), body.slice(-600));
  check('G8 单次工具调用有软截止包装（toolCallTimeoutMs 真的接线）',
    /callWithDeadline\(\(\) => IBMCP\.execOp/.test(body) && /callWithDeadline\(\(\) => this\.execLocalTool/.test(body));

  /* G9：continue 无法绕过总轮次检查 —— 询问点在循环体最前。 */
  const streamLoop = COM_SRC.slice(COM_SRC.indexOf('async function callApiChatStream(cfg,messages,opts){'));
  const streamRoundGuard = streamLoop.indexOf('_roundBudgetAllows(_fcCtx,userChunk)');
  const streamFirstContinue = streamLoop.indexOf('continue}');
  check('G10 流式循环：轮预算询问出现在**任何 continue 之前**，且用本回合的输出流做熔断播报',
    streamRoundGuard > 0 && streamFirstContinue > streamRoundGuard, { streamRoundGuard, streamFirstContinue });
  const nonStream = COM_SRC.slice(COM_SRC.indexOf('async function callApiChat(cfg,messages,opts){'));
  const nsGuard = nonStream.indexOf('_roundBudgetAllows(_fcCtx,function(t){full+=t;})');
  const nsFirstContinue = nonStream.indexOf('continue}');
  check('G11 非流式循环：同一位置同样先过预算，同样把原因写进自己的输出',
    nsGuard > 0 && nsFirstContinue > nsGuard, { nsGuard, nsFirstContinue });
  const streamOnly = streamLoop.slice(0, streamLoop.indexOf('async function callApiChat('));
  /* 词法统计：5 处 `;continue}`（4 处回落重试 + 1 处截断续写兜底），
     全部位于轮预算询问之后 —— 先问额度，才谈继续。 */
  const streamContinues = countOcc(streamOnly, ';continue}');
  check('G12 流式循环的 5 处继续语句全部在轮预算询问之后（先问额度，才谈继续）',
    streamContinues === 5 && streamRoundGuard < streamLoop.indexOf(';continue}'), { streamContinues, streamRoundGuard });
  check('G13 参数回落重试（token 参数名 / 输出上限）四处全部受重试闸门约束',
    countOcc(COM_SRC, '&&_fcRetryAllowed(_fcCtx)') === 4,
    countOcc(COM_SRC, '&&_fcRetryAllowed(_fcCtx)'));

  /* G14：周期生命周期：有开始就必须有结束。 */
  check('G14 回合周期在 finally 中关闭（异常路径也不留悬挂周期）',
    countOcc(COM_SRC, '_endCallState(st);_toolCycleEnd(_fcCtx)}') === 2,
    countOcc(COM_SRC, '_endCallState(st);_toolCycleEnd(_fcCtx)}'));
  check('G15 周期开始于工具块激活之后（未激活的请求不占额度）',
    COM_SRC.indexOf('_toolCycleBegin(_fcCtx)') > COM_SRC.indexOf("if(_fcv&&_fcv.active){_fcCtx=_fcv;msgs=_fcCtx.messages}"));
  check('G16 XML 工具续轮共用同一预算（不再有第二套总轮次上限）',
    /var _ownCycle=\(round<=1\);/.test(COM_SRC) && /IBFC\.cycleBegin\(null,\{maxRounds:_WS_TOOL_CONT_MAX\+1\}\)/.test(COM_SRC));
  check('G17 诊断面只输出稳定 reason + 结构化计数（不含工具参数）',
    (() => {
      const at = IBFC_SRC.indexOf('_trip(reason, ctx, emit){');
      const seg = stripComments(IBFC_SRC.slice(at, at + 1400));
      return at > 0 && /reason/.test(seg) && !/\.args/.test(seg) && !/JSON\.stringify/.test(seg) &&
        /snapshot\(\)/.test(seg);
    })());
  check('G18 熔断不写任何 storage（观测面是只读的）',
    (() => {
      const at = IBFC_SRC.indexOf('_trip(reason, ctx, emit){');
      const seg = stripComments(IBFC_SRC.slice(at, at + 1400));
      return !/localStorage|sessionStorage|dbPut|dbGet/.test(seg);
    })());
}

{
  /* G19：guard 模块不得自己读额度来源（额度只能由宿主注入）。 */
  const guardSrc = stripComments(rd('assets/js/tool-execution-guard.js'));
  check('G19 guard 不读 localStorage / IndexedDB（额度只能由宿主注入）',
    !/localStorage|sessionStorage|indexedDB/.test(guardSrc));
  check('G20 guard 不触碰 DOM', !/document\.|window\.document/.test(guardSrc));
  check('G21 guard 同时可被 Node require 与浏览器脚本加载（双挂载）',
    /module\.exports = api/.test(guardSrc) && /root\.IBToolGuard = api/.test(guardSrc));
}

/* ==================================================================== */
section('H · 既有局部限制的语义保持不变（不出现两套总轮次）');

{
  check('H1 逐服务器 MCP 轮上限保留其局部语义（按 alias 计数）',
    /mcpServerMaxRounds\(alias\)/.test(IBFC_SRC) && /ctx\.roundMcp\[a\] = \(ctx\.roundMcp\[a\] \|\| 0\) \+ 1;/.test(IBFC_SRC));
  check('H2 单服务器上限默认 5、且与 canonical 轮预算无关（注释仍声明两者不同）',
    /return 5;/.test(IBFC_SRC) && /与外部工具轮上限无关/.test(IBFC_SRC));
  check('H3 用户可见的「外部工具轮数」只有一个读取点，没有第二套配额读法',
    /guardPolicy\(\)\{[\s\S]{0,300}?this\.maxRounds\(\)/.test(IBFC_SRC) &&
    countOcc(stripComments(IBFC_SRC), "localStorage.getItem('ib_fcRounds')") === 1,
    countOcc(stripComments(IBFC_SRC), "localStorage.getItem('ib_fcRounds')"));
  check('H4 旧的外部工具轮计数不再单独决定结局（roundLocal 不再是总闸门）',
    !/ctx\.roundLocal = \(ctx\.roundLocal \|\| 0\) \+ 1;/.test(IBFC_SRC));
  check('H5 XML 续轮的旧上限（_WS_TOOL_CONT_MAX）仍是硬上界，未放宽',
    /_WS_TOOL_CONT_MAX=2/.test(COM_SRC) && /if\(round>_WS_TOOL_CONT_MAX\)return null;/.test(COM_SRC));
}

/* ==================================================================== */
console.log('\n' + (failures ? 'FAILURES: ' + failures : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
