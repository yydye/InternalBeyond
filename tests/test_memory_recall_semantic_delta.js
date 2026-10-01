'use strict';
/* Internal Beyond · P21-R2-D · Semantic Delta Matrix（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_semantic_delta.js

   ══════════════════════════════════════════════════════════════════════════
   ★ 本文件是 R2-D 的**硬门** ★
   ══════════════════════════════════════════════════════════════════════════

   R2-D 是**用户可见的语义切换**，不是 refactor。因此验收标准不再是
   "新旧输出必须逐字节相同"，而是：

     每个 fixture 先声明 EXPECTED: SAME | CHANGED
     然后测实际 delta
     未获批准的变化 = regression

   LEGACY 侧：memory-retrieval-core.buildMemoryContext(records, legacyOpts)
              —— 这就是接线前的用户可见行为
   R2-D  侧：memory-recall-orchestrator.recall(records, turnOpts).result
              —— 两个 Host 现在实际走的路径

   两侧使用**相同**的 clock / random / apiId / group flags / budget / contentLen，
   唯一差别是 R2-D 侧多了 turn（Host 现在会传它）。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1750000000000;
const DAY = 86400000;
const mk = o => Object.assign({
  id: 'm', title: 't', content: 'c', importance: 5, arousal: 0.3, resolved: false,
  activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
  visibility: 'public', tags: [], domain: '日常'
}, o || {});

const BASE = {
  apiId: 'role_a', now: NOW, random: () => 0.42, userMessage: '',
  isGroup: false, groupMemEnabled: false, maxChars: 2000, contentLen: 200
};

/* 两个共享 fixture 集合（都刻意**不含**与查询无关的高分记忆之外的干扰）。 */
const GPU = mk({ id: 'gpu', title: '显卡', content: 'RTX 5070 Ti 选购', importance: 8 });
const FOOD = mk({ id: 'food', title: '菜谱', content: '红烧肉做法', importance: 6 });
const SEA = mk({ id: 'sea', title: '看海', content: '七月一起去海边', importance: 7 });
const PIN_UNRELATED = mk({ id: 'pinx', pinned: true, title: '纪念日', content: '一起看海的日子', importance: 9 });

/* ══════════════════════════════════════════════════════════════════════
   §1 · 必须 CHANGED 的场景（R2-D 批准的产品变化）
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · EXPECTED CHANGED（批准的四类语义变化）');

const CHANGED_ROWS = [];

function deltaRow(id, label, records, message, expect, extraCheck) {
  const legacyOpts = Object.assign({}, BASE, { userMessage: message });
  const turnOpts = Object.assign({}, BASE, {
    userMessage: message,
    turn: Object.assign({ message: message }, (expect && expect.turnExtra) || {})
  });
  const legacy = CORE.buildMemoryContext(records, legacyOpts);
  const rd = ORCH.recall(records, turnOpts);
  const actual = rd.result;

  const sameText = actual.text === legacy.text;
  const sameIds = JSON.stringify(actual.selected.map(s => s.id)) === JSON.stringify(legacy.selected.map(s => s.id));
  const sameReason = actual.reason === legacy.reason;
  const sameAll = sameText && sameIds && sameReason && actual.count === legacy.count && actual.chars === legacy.chars;
  const isChanged = !sameAll;

  const want = expect.delta;
  const deltaOk = (want === 'SAME') ? sameAll : isChanged;

  let extraOk = true;
  let extraDetail = '';
  if (extraCheck) {
    const r = extraCheck({ legacy, actual, rd });
    extraOk = r.ok; extraDetail = r.detail || '';
  }

  CHANGED_ROWS.push({
    id, label,
    legacy: 'sel=' + legacy.selected.length + ' reason=' + String(legacy.reason),
    rd: 'sel=' + actual.selected.length + ' reason=' + String(actual.reason),
    want, actual: sameAll ? 'SAME' : 'CHANGED',
    pass: deltaOk && extraOk
  });

  check(id + '.delta.' + label + ' [' + want + ']', deltaOk,
    JSON.stringify({ want, legacy: legacy.reason, got: actual.reason, sameText, sameIds, sameReason }));
  if (extraCheck) check(id + '.shape.' + label, extraOk, extraDetail);
  return { legacy, actual, rd };
}

/* ---- A. semantic-empty / acknowledgement ---- */
deltaRow('A1', 'ack 嗯', [GPU, FOOD, SEA], '嗯', { delta: 'CHANGED' }, ({ legacy, actual, rd }) => ({
  ok: actual.reason === 'early-exit' && actual.count === 0 && actual.text === ''
    && legacy.selected.length > 0 && rd.trace.earlyExit === true && rd.meta.consulted === false,
  detail: JSON.stringify({ reason: actual.reason, legacySel: legacy.selected.length, consulted: rd.meta.consulted })
}));
deltaRow('A2', 'ack 哈哈', [GPU, FOOD, SEA], '哈哈', { delta: 'CHANGED' }, ({ actual }) => ({
  ok: actual.reason === 'early-exit' && actual.count === 0
}));
deltaRow('A3', 'emoji only', [GPU, FOOD, SEA], '😂😂', { delta: 'CHANGED' }, ({ actual }) => ({
  ok: actual.reason === 'early-exit' && actual.count === 0
}));
deltaRow('A4', 'punctuation only', [GPU, FOOD, SEA], '...', { delta: 'CHANGED' }, ({ actual }) => ({
  ok: actual.reason === 'early-exit' && actual.count === 0
}));
deltaRow('A5', 'empty message', [GPU, FOOD, SEA], '', { delta: 'CHANGED' }, ({ actual }) => ({
  ok: actual.reason === 'early-exit' && actual.count === 0
}));

/* ---- B. unrelated semantic message → Hard Gate ---- */
deltaRow('B1', 'unrelated semantic', [GPU, FOOD, SEA], '量子纠缠的退相干时间是多长',
  { delta: 'CHANGED' }, ({ legacy, actual, rd }) => ({
    ok: actual.reason === 'gate-rejected' && actual.count === 0 && legacy.selected.length > 0
      && rd.meta.consulted === true,
    detail: JSON.stringify({ reason: actual.reason, legacySel: legacy.selected.length })
  }));
deltaRow('B2', 'unrelated pinned', [PIN_UNRELATED], '量子纠缠的退相干时间是多长',
  { delta: 'CHANGED' }, ({ legacy, actual, rd }) => ({
    ok: actual.reason === 'gate-rejected' && actual.count === 0
      && legacy.selected.length === 1
      && rd.trace.candidates.length === 1
      && rd.trace.candidates[0].decision === 'rejected'
      && rd.trace.candidates[0].reasons.indexOf('gate-rejected') >= 0,
    detail: JSON.stringify({ legacySel: legacy.selected.length, reason: actual.reason })
  }));

/* ---- C. mixed relevant + unrelated ---- */
deltaRow('C1', 'mixed relevant+unrelated', [GPU, FOOD], '显卡最近怎么样',
  { delta: 'CHANGED' }, ({ legacy, actual, rd }) => ({
    /* 旧行为可能两条都进；R2-D 只让命中词元的那条过 gate。 */
    ok: actual.selected.length <= legacy.selected.length
      && actual.selected.every(s => s.id === 'gpu')
      && rd.trace.counts.visible === 2 && rd.trace.counts.gated === 1,
    detail: JSON.stringify({
      legacySel: legacy.selected.map(s => s.id), rdSel: actual.selected.map(s => s.id),
      counts: rd.trace.counts
    })
  }));

/* ---- D. explicit recall ---- */
section('§2 · Explicit recall（channel=recall）');

(function explicitRecall() {
  const records = [GPU, FOOD];
  const msg = '你还记得上次我们聊的显卡吗？';
  const plain = '显卡最近怎么样';
  const rRecall = ORCH.recall(records, Object.assign({}, BASE, { userMessage: msg, turn: { message: msg } }));
  const rPlain = ORCH.recall(records, Object.assign({}, BASE, { userMessage: plain, turn: { message: plain } }));

  check('E1.recallChannelSelected', rRecall.trace.channel === 'recall',
    'got ' + rRecall.trace.channel);
  check('E2.plainChannelIsSurface', rPlain.trace.channel === 'surface',
    'got ' + rPlain.trace.channel);
  check('E3.recallNotEarlyExit', rRecall.trace.earlyExit === false && rRecall.result.reason !== 'early-exit');
  check('E4.recallQueryStrippingEffective', (() => {
    /* "你还记得" 应被剥掉；"显卡" 必须留下来。 */
    const q = require(path.join(ROOT, 'assets/js/memory-recall/recall-query.js')).buildRecallQuery(msg);
    return q.lexicalText.indexOf('你还记得') < 0 && q.lexicalText.indexOf('显卡') >= 0;
  })());
  check('E5.relevantMemoryPassesGate', rRecall.trace.counts.gated >= 1);
  check('E6.unrelatedMemoryGatedOut', (() => {
    const rows = rRecall.trace.candidates;
    const food = rows.filter(c => c.memoryId === 'food');
    return food.length === 0 || food.every(c => c.relevanceScore === 0);
  })());
  check('E7.channelsDifferInPolicyNotForcedResult',
    rRecall.trace.channel !== rPlain.trace.channel,
    'policy must differ even if the selected set happens to coincide');
  check('E8.bothChannelsShareGateRule', (() => {
    /* 两个通道的 gate 判据完全相同（score > 0），差别在座位预算。 */
    const CP = require(path.join(ROOT, 'assets/js/memory-recall/channel-policy.js'));
    return CP.resolveChannelPolicy('surface').policy.gateMode
      === CP.resolveChannelPolicy('recall').policy.gateMode;
  })());
})();

/* ══════════════════════════════════════════════════════════════════════
   §3 · 必须 SAME 的场景
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · EXPECTED SAME（不得出现未批准的漂移）');

const SAME_ROWS = [];
function sameRow(id, label, records, message, extraCheck, over) {
  const o = over || {};
  const legacyOpts = Object.assign({}, BASE, { userMessage: message }, o.legacy || {});
  const turnOpts = Object.assign({}, BASE, { userMessage: message }, o.legacy || {},
    { turn: { message: message } });
  const legacy = CORE.buildMemoryContext(records, legacyOpts);
  const rd = ORCH.recall(records, turnOpts);
  const actual = rd.result;
  const same = actual.text === legacy.text
    && JSON.stringify(actual.selected.map(s => s.id)) === JSON.stringify(legacy.selected.map(s => s.id))
    && actual.count === legacy.count && actual.chars === legacy.chars
    && actual.reason === legacy.reason;
  let ok = same, detail = JSON.stringify({
    legacy: { n: legacy.selected.length, reason: legacy.reason, chars: legacy.chars },
    rd: { n: actual.selected.length, reason: actual.reason, chars: actual.chars }
  });
  if (extraCheck) {
    const r = extraCheck({ legacy, actual, rd });
    ok = ok && r.ok; if (r.detail) detail += ' | ' + r.detail;
  }
  SAME_ROWS.push({ id, label, legacy: 'n=' + legacy.selected.length + ' r=' + String(legacy.reason), rd: 'n=' + actual.selected.length + ' r=' + String(actual.reason), want: 'SAME', actual: same ? 'SAME' : 'CHANGED', pass: ok });
  check(id + '.same.' + label, ok, detail);
  return { legacy, actual, rd };
}

/* 7. relevant single */
sameRow('S7', 'relevant single memory', [GPU], '显卡');
/* 8. relevant pinned */
sameRow('S8', 'relevant pinned memory', [mk({ id: 'p', pinned: true, title: '显卡', content: '显卡记录' })], '显卡');
/* 9. visibility private */
sameRow('S9', 'private filtered out', [mk({ id: 'v', title: '显卡', content: '显卡' }), mk({ id: 'p', visibility: 'private', title: '显卡', content: '显卡' })], '显卡');
/* 10. only visible */
sameRow('S10', 'only visible to caller', [mk({ id: 'a', visibility: 'only', visibleTo: ['role_a'], title: '显卡', content: '显卡' })], '显卡');
/* 11. except */
sameRow('S11', 'except caller', [mk({ id: 'a', visibility: 'except', excludeFrom: ['role_a'], title: '显卡', content: '显卡' })], '显卡');
/* 12. group public */
sameRow('S12', 'group public', [mk({ id: 'a', title: '显卡', content: '显卡' }), mk({ id: 'b', visibility: 'only', visibleTo: ['role_a'], title: '显卡', content: '显卡' })], '显卡',
  ({ actual }) => ({ ok: actual.count === 1 }), { legacy: { isGroup: true, groupMemEnabled: true } });
/* 13. resolved decay ordering among relevant candidates */
sameRow('S13', 'resolved decay ordering', [
  mk({ id: 'r1', title: '显卡', content: '显卡 A', resolved: true, created: NOW - DAY * 60, lastActivated: NOW - DAY * 60 }),
  mk({ id: 'r2', title: '显卡', content: '显卡 B', resolved: false })
], '显卡');
/* 14. high arousal ordering */
sameRow('S14', 'high arousal ordering', [
  mk({ id: 'a1', title: '显卡', content: '显卡 A', arousal: 1 }),
  mk({ id: 'a2', title: '显卡', content: '显卡 B', arousal: 0 })
], '显卡');
/* 15. activation ordering */
sameRow('S15', 'activation ordering', [
  mk({ id: 'c1', title: '显卡', content: '显卡 A', activationCount: 400 }),
  mk({ id: 'c2', title: '显卡', content: '显卡 B', activationCount: 0 })
], '显卡');
/* 16. fatigue ordering */
sameRow('S16', 'fatigue active ordering', [
  mk({ id: 'f1', title: '显卡', content: '显卡 A', activationCount: 10, lastActivated: NOW - 60000 }),
  mk({ id: 'f2', title: '显卡', content: '显卡 B' })
], '显卡');
/* 17. custom contentLen */
sameRow('S17', 'custom contentLen', [mk({ id: 'a', title: '显卡', content: '显卡' + 'x'.repeat(300) })], '显卡', null, { legacy: { contentLen: 50 } });
/* 18. maxChars */
sameRow('S18', 'custom maxChars', [mk({ id: 'a', title: '显卡', content: '显卡' }), mk({ id: 'b', title: '显卡', content: '显卡' })], '显卡', null, { legacy: { maxChars: 300 } });
/* 19. render format */
sameRow('S19', 'render format identical', [mk({ id: 'a', title: '显卡', content: '显卡选购', tags: ['硬件'], domain: '日常' })], '显卡',
  ({ legacy, actual }) => ({ ok: actual.text === legacy.text }));
/* 20. unrelated-but-relevant-less: a message with zero terms must NOT be forced SAME (it is CHANGED, tested in B1) */
section('§3b · 排序在相关候选之间保持 legacy');

sameRow('S20', 'multi relevant ordering preserved', [
  mk({ id: 'x1', title: '显卡', content: '显卡 A', importance: 9 }),
  mk({ id: 'x2', title: '显卡', content: '显卡 B', importance: 3 }),
  mk({ id: 'x3', title: '显卡', content: '显卡 C', importance: 6, pinned: true })
], '显卡');

/* ══════════════════════════════════════════════════════════════════════
   §4 · 矩阵自检（防止"没有 delta"被误判成通过）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · 矩阵自检');

check('M1.someRowsActuallyChanged', CHANGED_ROWS.some(r => r.actual === 'CHANGED'));
check('M2.someRowsActuallySame', SAME_ROWS.some(r => r.actual === 'SAME'));
check('M3.noUnexpectedDelta',
  SAME_ROWS.every(r => r.pass) && CHANGED_ROWS.every(r => r.pass),
  'every row must match its declared expectation');
check('M4.changedRowsAreExactlyTheApprovedOnes', (() => {
  /* 批准的变化只应发生在 §1/§2 的行；§3 的 SAME 行一个都不许变。 */
  return SAME_ROWS.filter(r => r.actual === 'CHANGED').length === 0;
})(), JSON.stringify(SAME_ROWS.filter(r => r.actual === 'CHANGED')));
check('M5.matrixHasEnoughRows', CHANGED_ROWS.length + SAME_ROWS.length >= 20,
  'got ' + (CHANGED_ROWS.length + SAME_ROWS.length));

/* 反向控制：判据必须有能力发现一个**未批准**的变化。 */
check('M6.reverseControl.unapprovedDeltaWouldBeCaught', (() => {
  const records = [mk({ id: 'a', title: '显卡', content: '显卡' })];
  const legacy = CORE.buildMemoryContext(records, Object.assign({}, BASE, { userMessage: '显卡' }));
  const mutated = Object.assign({}, legacy, { chars: legacy.chars + 1 });
  const actual = ORCH.recall(records, Object.assign({}, BASE, { userMessage: '显卡', turn: { message: '显卡' } })).result;
  const same = JSON.stringify(actual) === JSON.stringify(mutated);
  return same === false;
})(), 'the SAME comparison must be able to fail on a one-char difference');

/* ══════════════════════════════════════════════════════════════════════
   §5 · >cap 场景（P21-R2-D.1 §7/§8）
   ──────────────────────────────────────────────────────────────────────
   R2-D **允许**改变的只有 selected **数量**（channel seat 上限）；
   它**不允许**改变 canonical selector 对候选的**相对优先级**。

     若 legacy canonical 序是 [D, A, B, C] 且 cap = 3：
       正确：[D, A, B]      ← canonical 前缀
       错误：[A, B, C]      ← 即使也是 3 条，仍是 regression

   因此这两行不只比"数量变了"，还断言**保留下来的是 canonical 前缀**。
   查询词用 4 个英文词 ⇒ relBoost 精确可控（命中 1/4 → 1.375；4/4 → 2.5），
   从而制造"memoryValue 序 ≠ canonical 序"的真实反演。
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · >cap（seat 上限生效时仍须保持 canonical 优先级）');

const Q_ADV = 'alpha beta gamma delta';
/* 命中 1 个词元（弱相关，但过 gate）与命中全部 4 个（强相关）的构造。 */
const advMem = (id, importance, content) => mk({
  id: id, title: '记录', content: content, importance: importance,
  arousal: 0.3, activationCount: 0, created: NOW, lastActivated: NOW
});

/* S21：4 条全部 relevant，surface cap = 3。
   memoryValue 序 A>B>C>D；canonical 序 D>A>B>C（D 靠 relBoost 2.5 反超）。 */
const ADV4 = [
  advMem('A', 10, 'alpha'),
  advMem('B', 9, 'beta'),
  advMem('C', 8, 'gamma'),
  advMem('D', 7, 'alpha beta gamma delta')
];
const canon4 = CORE.rankMemoryCandidates(ADV4, { apiId: 'role_a', now: NOW, userMessage: Q_ADV }).map(r => r.id);
const mv4 = ADV4.slice().sort((a, b) => CORE.getMemoryScore(b, NOW) - CORE.getMemoryScore(a, NOW)).map(m => m.id);

check('S21.fixtureInversionIsReal',
  JSON.stringify(canon4) === JSON.stringify(['D', 'A', 'B', 'C'])
  && JSON.stringify(mv4) === JSON.stringify(['A', 'B', 'C', 'D']),
  'canonical=' + JSON.stringify(canon4) + ' memoryValue=' + JSON.stringify(mv4));

deltaRow('S21', '>cap surface (4 relevant, cap 3)', ADV4, Q_ADV, { delta: 'CHANGED' }, ({ legacy, actual }) => {
  const kept = actual.selected.map(s => s.id);
  const wantPrefix = canon4.slice(0, 3);
  return {
    ok: legacy.selected.length === 4 && kept.length === 3
      && JSON.stringify(kept) === JSON.stringify(wantPrefix),
    detail: 'legacy=' + JSON.stringify(legacy.selected.map(s => s.id))
      + ' r2d=' + JSON.stringify(kept) + ' want=' + JSON.stringify(wantPrefix)
  };
});

/* S22：6 条全部 relevant，recall cap = 5（比 surface 宽 ⇒ 两个 policy 确有差异）。
   importance 10..5 且 F 命中全部词元 ⇒ canonical 序 A>F>B>C>D>E，
   而 memoryValue 序是 A>B>C>D>E>F —— 末位互换，正好落在 cap 边界上。 */
const ADV6 = [
  advMem('A', 10, 'alpha'),
  advMem('B', 9, 'beta'),
  advMem('C', 8, 'gamma'),
  advMem('D', 7, 'delta'),
  advMem('E', 6, 'alpha'),
  advMem('F', 5, 'alpha beta gamma delta')
];
const canon6 = CORE.rankMemoryCandidates(ADV6, { apiId: 'role_a', now: NOW, userMessage: Q_ADV }).map(r => r.id);
const mv6 = ADV6.slice().sort((a, b) => CORE.getMemoryScore(b, NOW) - CORE.getMemoryScore(a, NOW)).map(m => m.id);

check('S22.fixtureInversionIsReal',
  canon6[0] === 'A' && canon6[1] === 'F' && canon6[5] === 'E'
  && mv6[5] === 'F',
  'canonical=' + JSON.stringify(canon6) + ' memoryValue=' + JSON.stringify(mv6)
  + ' — F must be canonically high but memoryValue-low');

deltaRow('S22', '>cap recall (6 relevant, cap 5)', ADV6, Q_ADV,
  { delta: 'CHANGED', turnExtra: { channelHint: 'recall' } }, ({ legacy, actual, rd }) => {
    const kept = actual.selected.map(s => s.id);
    const wantPrefix = canon6.slice(0, 5);
    return {
      ok: rd.trace.channel === 'recall'
        && legacy.selected.length === 6 && kept.length === 5
        && JSON.stringify(kept) === JSON.stringify(wantPrefix),
      detail: 'channel=' + rd.trace.channel
        + ' legacy=' + JSON.stringify(legacy.selected.map(s => s.id))
        + ' r2d=' + JSON.stringify(kept) + ' want=' + JSON.stringify(wantPrefix)
    };
  });

/* S23：反向控制 —— 若 seat planner 改用 memoryValue 前缀，这两行必须变红。 */
check('S23.reverseControl.memoryValuePrefixWouldFailS21',
  JSON.stringify(mv4.slice(0, 3)) !== JSON.stringify(canon4.slice(0, 3)),
  'the memoryValue prefix must differ from the canonical prefix, otherwise S21 cannot '
  + 'distinguish a correct planner from a second selector');
check('S23.reverseControl.memoryValuePrefixWouldFailS22',
  JSON.stringify(mv6.slice(0, 5)) !== JSON.stringify(canon6.slice(0, 5)));

/* S24：budget 不是限制因素（否则"数量变了"会归因到预算而不是 seat 上限）。 */
check('S24.budgetIsNotTheLimiterInAdvFixtures', (() => {
  const legacy6 = CORE.buildMemoryContext(ADV6, {
    apiId: 'role_a', now: NOW, random: () => 0, userMessage: Q_ADV,
    maxChars: BASE.maxChars, contentLen: BASE.contentLen
  });
  return legacy6.selected.length === 6;
})(), 'legacy must fit all six under the same budget — proving the seat cap, not chars, is the limiter');

/* ══════════════════════════════════════════════════════════════════════
   §6 · 打印矩阵
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(100));
console.log('SEMANTIC DELTA MATRIX');
console.log('─'.repeat(100));
console.log('id   fixture                          legacy                     R2-D                       expected  actual   result');
CHANGED_ROWS.concat(SAME_ROWS).forEach(r => {
  console.log(
    r.id.padEnd(5)
    + r.label.padEnd(33)
    + r.legacy.padEnd(27)
    + r.rd.padEnd(27)
    + r.want.padEnd(10)
    + r.actual.padEnd(9)
    + (r.pass ? 'PASS' : 'FAIL')
  );
});
console.log('─'.repeat(100));
console.log('rows=' + (CHANGED_ROWS.length + SAME_ROWS.length)
  + '  changed=' + CHANGED_ROWS.filter(r => r.actual === 'CHANGED').length
  + '  same=' + SAME_ROWS.filter(r => r.actual === 'SAME').length);

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL SEMANTIC DELTA FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL SEMANTIC DELTA PASSED · ' + passed + ' assertions green');
  console.log('（每一行都与其声明的 EXPECTED 一致：无未批准的语义漂移）');
}
