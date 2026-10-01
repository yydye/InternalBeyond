'use strict';
/* Internal Beyond · P21-R2-D · Channel Policy（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_channels.js

   被测：assets/js/memory-recall/channel-policy.js（纯函数）
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'assets/js/memory-recall/channel-policy.js';
const CP = require(path.join(ROOT, MODULE_REL));
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
  id: 'm', title: '显卡', content: 'RTX 5070 Ti', importance: 5, arousal: 0.3,
  resolved: false, activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
  visibility: 'public', tags: [], domain: '日常'
}, o || {});
const BASE = {
  apiId: 'role_a', now: NOW, random: () => 0.42, isGroup: false,
  groupMemEnabled: false, maxChars: 2000, contentLen: 200
};
const withTurn = (msg, over) => Object.assign({}, BASE, over || {}, { turn: { message: msg } });

/* ══════════════════════════════════════════════════════════════════════
   §1 · surface / recall 已实现
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · 已实现通道');

const surface = CP.resolveChannelPolicy('surface');
const recall = CP.resolveChannelPolicy('recall');
check('C1.surfaceExists', surface.ok === true && surface.implemented === true);
check('C2.recallExists', recall.ok === true && recall.implemented === true);
check('C1.surfacePolicyShape', (() => {
  const p = surface.policy;
  return p.channel === 'surface' && typeof p.requireRelevance === 'boolean'
    && typeof p.gateMode === 'string' && typeof p.allowExploration === 'boolean'
    && Number.isInteger(p.maxTotalSeats);
})());
check('C2.recallPolicyShape', recall.policy && recall.policy.channel === 'recall');
check('C1.surfaceSeatCapIsProductBudget',
  surface.policy.maxTotalSeats === CP.MAX_SURFACE_TOTAL_SEATS
  && CP.MAX_SURFACE_TOTAL_SEATS === 3);
check('C2.recallSeatCapWider',
  recall.policy.maxTotalSeats === CP.MAX_RECALL_TOTAL_SEATS
  && CP.MAX_RECALL_TOTAL_SEATS === 5);
check('C2.surfaceAndRecallHaveExplicitlyDifferentPolicy',
  surface.policy.maxTotalSeats !== recall.policy.maxTotalSeats,
  'the point of two channels is that they are explicitly different');

/* ══════════════════════════════════════════════════════════════════════
   §2 · legacy 不由 channel policy 接管
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · legacy 边界');

const legacyRes = CP.resolveChannelPolicy('legacy');
check('C3.legacyNotManaged', legacyRes.ok === false && legacyRes.implemented === false);
check('C3.legacyReasonIsExplicit',
  legacyRes.reason === 'legacy-not-managed-by-channel-policy', 'got ' + legacyRes.reason);
check('C3.legacyNotListedAsImplemented', CP.listImplementedChannels().indexOf('legacy') < 0);
/* legacy 仍由 orchestrator 兼容路径处理（R2-C 契约未删除） */
check('C3.legacyPathStillWorksInOrchestrator', (() => {
  const out = ORCH.recall([mk({ id: 'a' })], BASE);
  return out.meta.mode === 'legacy' && out.meta.channel === 'legacy';
})());

/* ══════════════════════════════════════════════════════════════════════
   §3 · 未来通道显式未实现
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · 通道实现状态（R2-E1b 相位切换）');

/* ⚠ PHASE TRANSITION（R2-D → R2-E1b，有意更新）
   R2-D 时 glossary / coldStart 是 FUTURE，断言"未实现 + channel-unsupported"。
   R2-E1b 的目标就是**实现并启用**它们，因此那两条断言按设计失效。
   现在正确的判据是：该实现的能实现、该 future 的仍 future、
   且**没有任何通道被静默映射到另一个通道**。 */
[['C4', 'glossary', true], ['C5', 'coldStart', true], ['C6', 'reminisce', false]].forEach(([id, ch, wantImpl]) => {
  const r = CP.resolveChannelPolicy(ch);
  check(id + '.' + ch + 'Implemented=' + wantImpl, r.implemented === wantImpl && r.future === !wantImpl,
    JSON.stringify({ implemented: r.implemented, future: r.future }));
  check(id + '.' + ch + 'ImplementedList',
    (CP.listImplementedChannels().indexOf(ch) >= 0) === wantImpl);
  check(id + '.' + ch + 'FutureList',
    (CP.listFutureChannels().indexOf(ch) >= 0) === !wantImpl);
});
check('C6.reminisceStillFutureExplicit', (() => {
  const r = CP.resolveChannelPolicy('reminisce');
  return r.ok === false && r.implemented === false && r.future === true
    && r.reason === 'channel-not-implemented';
})(), 'reminisce must remain explicitly unimplemented — R2-E1b does not own it');
check('C6.futureListIsExactlyReminisce',
  JSON.stringify(CP.listFutureChannels()) === JSON.stringify(['reminisce']),
  JSON.stringify(CP.listFutureChannels()));

check('C4.noChannelSilentlyMappedToSurface', (() => {
  /* 关键：任何通道都不得返回 surface 的 policy 对象（那会让 R2-E 无法区分通道）。 */
  return ['glossary', 'coldStart'].every(ch => {
    const r = CP.resolveChannelPolicy(ch);
    return r.channel === ch && r.policy !== surface.policy;
  });
})(), 'each channel must own its policy object');
check('C4.glossarySeatsInheritRecall',
  CP.resolveChannelPolicy('glossary').policy.maxTotalSeats === CP.MAX_RECALL_TOTAL_SEATS,
  'glossary seat cap must INHERIT the recall constant, not copy the literal');
check('C5.coldStartSeatsInheritSurface',
  CP.resolveChannelPolicy('coldStart').policy.maxTotalSeats === CP.MAX_SURFACE_TOTAL_SEATS,
  'coldStart seat cap must INHERIT the surface constant, not copy the literal');
check('C4.activationPolicyIsExplicit', (() => {
  return CP.resolveChannelPolicy('glossary').policy.activationPolicy === 'normal'
    && CP.resolveChannelPolicy('coldStart').policy.activationPolicy === 'none';
})(), 'glossary reinforces normally; coldStart must NOT reinforce (self-reinforcement loop)');
check('C4.nonLexicalChannelsDoNotRequireRelevance', (() => {
  return CP.resolveChannelPolicy('glossary').policy.requireRelevance === false
    && CP.resolveChannelPolicy('coldStart').policy.requireRelevance === false;
})(), 'admission for these channels is exact evidence, not lexical relevance');

/* 端到端：host-forced 通道的行为（§24 / §5）。
   channelHint 走 **turn**（Host 的通道请求就在 turn 里）。 */
(function forcedChannelBehaviour() {
  /* reminisce 仍 future ⇒ host 强制它必须 fail closed。 */
  const rem = ORCH.recall([mk({ id: 'a' })], Object.assign({}, BASE, {
    userMessage: '显卡', turn: { message: '显卡', channelHint: 'reminisce' }
  }));
  check('C7.failClosedInOrchestrator.reminisce',
    rem.result.count === 0 && rem.result.text === '' && rem.result.reason === 'channel-unsupported',
    JSON.stringify({ reason: rem.result.reason, count: rem.result.count }));
  check('C7.metaReports.reminisce',
    rem.meta.channelSupported === false && rem.meta.channelImplemented === false
    && typeof rem.meta.channelUnsupportedReason === 'string');

  /* glossary 已实现但 production 默认**没有 provider** ⇒ host 强制时是
     channel-unsupported（通道服务不了），**不是** gate-rejected。
     这与"provider 可用但没有 entry"（⇒ 0 hit）必须区分。 */
  const gl = ORCH.recall([mk({ id: 'a' })], Object.assign({}, BASE, {
    userMessage: '显卡', turn: { message: '显卡', channelHint: 'glossary' }
  }));
  check('C7.forcedGlossaryWithoutProviderIsUnsupported',
    gl.result.reason === 'channel-unsupported' && gl.result.count === 0,
    JSON.stringify({ reason: gl.result.reason, count: gl.result.count }));
  check('C7.forcedGlossaryReportsProviderReason',
    gl.meta.channelImplemented === true && gl.meta.channelSupported === false
    && typeof gl.meta.channelUnsupportedReason === 'string',
    JSON.stringify(gl.meta));
  check('C7.forcedGlossaryDiffersFromEmptyCatalog', (() => {
    /* provider 可用但 entries=[] ⇒ 0 hit（gate-rejected），绝不是 unsupported。 */
    const GC = require(path.join(ROOT, 'assets/js/memory-recall/glossary-catalog.js'));
    const emptyProv = GC.createGlossaryCatalogProvider(function () { return []; });
    const r2 = ORCH.recall([mk({ id: 'a' })], Object.assign({}, BASE, {
      userMessage: '显卡', glossaryProvider: emptyProv,
      turn: { message: '显卡', channelHint: 'glossary' }
    }));
    return r2.result.reason === 'gate-rejected' && r2.result.reason !== 'channel-unsupported';
  })(), 'provider available + empty catalog is NOT the same as provider unavailable');

  /* coldStart 已实现：host 强制时**不**因未实现而 unsupported。 */
  const cs = ORCH.recall([mk({ id: 'a' })], Object.assign({}, BASE, {
    userMessage: '显卡', turn: { message: '显卡', channelHint: 'coldStart' }
  }));
  check('C5.forcedColdStartIsSupported',
    cs.result.reason !== 'channel-unsupported',
    JSON.stringify({ reason: cs.result.reason, channel: cs.trace && cs.trace.channel }));
  check('C5.forcedColdStartUsesColdStartChannel',
    cs.trace && cs.trace.channel === 'coldStart', JSON.stringify(cs.trace && cs.trace.channel));
  check('C5.forcedColdStartActivationNone', cs.meta.activationPolicy === 'none', JSON.stringify(cs.meta));
})();

/* ══════════════════════════════════════════════════════════════════════
   §4 · 无魔法相关性阈值
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · gate 判据');

check('C8.surfaceGateRequiresPositive', surface.policy.gateMode === CP.GATE_MODE_POSITIVE);
check('C9.recallGateRequiresPositive', recall.policy.gateMode === CP.GATE_MODE_POSITIVE);
check('C7.noMagicRelevanceThreshold', (() => {
  /* policy 里不得出现任何数值型的相关性门槛字段。 */
  const keys = Object.keys(surface.policy).concat(Object.keys(recall.policy));
  const banned = keys.filter(k => /threshold|minScore|minRelevance|floor|cutoff/i.test(k));
  return banned.length === 0;
})(), 'seat caps are product budgets; relevance has exactly one rule (score > 0)');
check('C7.gateModeVocabularyIsSingle', (() => {
  const src = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
  const modes = src.match(/GATE_MODE_[A-Z_]+ = '[^']+'/g) || [];
  return modes.length === 1;
})(), 'there must be exactly one gate mode — no uncalibrated tiers');

/* ══════════════════════════════════════════════════════════════════════
   §5 · 非法通道显式失败
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · 非法输入');

[null, undefined, '', 'SURFACE', 'Surface', ' surface ', 'bogus', 0, 1, {}, []].forEach((bad, i) => {
  const r = CP.resolveChannelPolicy(bad);
  check('C17.invalidChannelFailsClosed#' + i,
    r.ok === false && r.implemented === false,
    JSON.stringify({ input: String(bad), out: r }));
});
check('C17.unknownReasonIsExplicit', CP.resolveChannelPolicy('bogus').reason === 'unknown-channel');
check('C17.doesNotThrowOnHostileInput', (() => {
  try { [null, undefined, {}, [], () => {}, Symbol.iterator ? 'x' : 'y'].forEach(v => CP.resolveChannelPolicy(v)); return true; }
  catch (e) { return false; }
})());

/* ══════════════════════════════════════════════════════════════════════
   §6 · 不可变性 / 确定性
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · 不可变与确定性');

check('C18.policyObjectsAreFrozen',
  Object.isFrozen(surface.policy) && Object.isFrozen(recall.policy));
check('C18.callerMutationDoesNotPollute', (() => {
  const before = CP.resolveChannelPolicy('surface').policy.maxTotalSeats;
  try { surface.policy.maxTotalSeats = 999; } catch (e) { /* 严格模式下抛错也算通过 */ }
  const after = CP.resolveChannelPolicy('surface').policy.maxTotalSeats;
  return before === after && after === CP.MAX_SURFACE_TOTAL_SEATS;
})());
check('C12.deterministic', (() => {
  const a = JSON.stringify(CP.resolveChannelPolicy('surface')) + JSON.stringify(CP.resolveChannelPolicy('glossary'));
  for (let i = 0; i < 100; i++) {
    if (JSON.stringify(CP.resolveChannelPolicy('surface')) + JSON.stringify(CP.resolveChannelPolicy('glossary')) !== a) return false;
  }
  return true;
})());

/* ══════════════════════════════════════════════════════════════════════
   §7 · 纯函数静态证明
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · 纯函数');

const SRC = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
const BARE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
[
  ['Date.now', /Date\s*\.\s*now\s*\(/],
  ['new Date', /new\s+Date\s*\(/],
  ['Math.random', /Math\s*\.\s*random\s*\(/],
  ['setTimeout', /\bsetTimeout\s*\(/],
  ['fetch', /\bfetch\s*\(/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['document', /\bdocument\s*\./],
  ['window', /\bwindow\s*\./],
  ['require', /\brequire\s*\(/],
  ['LLM', /\bmiddleBrain\b|\bcallApi\b|\bprovider\b/i],
  ['vector', /\bbm25\b|\bembedding\b|\bfaiss\b|\bchroma\b|\bqdrant\b/i]
].forEach(([label, re]) => {
  check('C13-16.noForbidden.' + label, !re.test(BARE), label + ' must not appear');
});
check('C13.noIOAtAll', !/\bdbPut\b|\bdbGet\b|\bDB\b/.test(BARE));

/* ══════════════════════════════════════════════════════════════════════
   §8 · Contract 取证（P21-R2-D.1 §10）
   ──────────────────────────────────────────────────────────────────────
   问题：`reason = 'channel-unsupported'` 是 R2-D 新引入的 result reason，
         它**没有**被写进 canonical contract 的 reason 词表。
   裁决依据来自 contract 文本本身，而不是推测：
     · §11.1 冻结 4 个既有值，要求"保留、语义不变"
     · §11.2 标题为「新增（FUTURE CONTRACT）」，规则是**只增不改**
       ⇒ 词表**允许扩展**，不是 closed enumeration
   因此：新增 reason 在机制上**合规**，但该具体值尚未枚举 ⇒
         记为文档缺口 **R2-D-CONTRACT-1**（属 R2-G 的 doc drift），
         本轮**不**改 contract。
   这一节把上述判断变成可执行证据；若将来有人在 §11.2 补上这个值，
   下面的断言会失败并提醒把"未枚举"这条标记删掉。
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · Contract 取证');

const CONTRACT_REL = 'docs/contracts/memory/MEMORY_RECALL_CONTRACT.md';
const CONTRACT_TEXT = fs.readFileSync(path.join(ROOT, CONTRACT_REL), 'utf8');

check('C19.contractHasAdditiveReasonMechanism',
  CONTRACT_TEXT.indexOf('只增不改') >= 0 && CONTRACT_TEXT.indexOf('FUTURE CONTRACT') >= 0,
  'the reason vocabulary must be additive (not a closed enumeration)');
check('C19.contractFreezesExistingReasonsWithoutRedefinition',
  CONTRACT_TEXT.indexOf('保留') >= 0 && CONTRACT_TEXT.indexOf('不得静默改义') >= 0,
  'existing reason values must be preserved verbatim — R2-D did not touch them');
check('C19.channelUnsupportedIsCurrentlyUnenumerated',
  CONTRACT_TEXT.indexOf('channel-unsupported') < 0,
  'R2-D-CONTRACT-1: `channel-unsupported` ships but is not yet enumerated. If this assertion '
  + 'starts failing the gap was closed — then drop the R2-D-CONTRACT-1 note.');
check('C20.seatNumbersLiveInCodeNotContract',
  CONTRACT_TEXT.indexOf('maxTotalSeats') < 0 && CONTRACT_TEXT.indexOf('maxPrimarySeats') < 0,
  'contract §4.2 MUST NOT hardcode uncalibrated seat counts — the frozen 3/5 are R2-D '
  + 'product policy and live in channel-policy.js');
check('C20.contractForbidsUncalibratedNumbers',
  CONTRACT_TEXT.indexOf('未经数据校准') >= 0 || CONTRACT_TEXT.indexOf('未经校准') >= 0,
  'the contract itself forbids freezing uncalibrated numbers in it — evidence for C20');
check('C20.contractFreezesChannelVocabulary',
  ['legacy', 'surface', 'recall', 'glossary', 'coldStart', 'reminisce']
    .every(ch => CONTRACT_TEXT.indexOf('`' + ch + '`') >= 0),
  'all six channels are named in §4.1 — R2-D implements two and fails closed on the rest');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL CHANNELS FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL CHANNELS PASSED · ' + passed + ' assertions green');
}
