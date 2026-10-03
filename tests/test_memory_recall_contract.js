'use strict';
/* Internal Beyond · P21-R2-A · Memory Recall Contract（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_contract.js

   ══════════════════════════════════════════════════════════════════════════
   本测试证明的是**架构契约**，不是"新 runtime 行为已实现"。
   ══════════════════════════════════════════════════════════════════════════

   R2-A 的交付是**冻结契约**：词表、不变量、边界。Recall Orchestrator 本体
   在 R2-A 时点**尚不存在** —— 生产召回仍是 memory-retrieval-core.js 的
   buildMemoryContext() 单一管线。因此本测试的断言分两类：

     [CONTRACT]  contract 文件写了什么（static assertion）
     [CURRENT]   当前生产代码事实（用于区分"已成立的不变量"与"FUTURE 条款"）

   两者都必要，因为一条契约若与当前代码矛盾却不标注 FUTURE，
   下一位读者会以为它已经生效 —— 那正是 docs/architecture/MEMORY.md §12
   早已警告过的"文档声称已修复"形状。

   ── 为什么 [CURRENT] 断言不写成"应该等于某常量" ────────────────────────
   R2-A 明令零生产代码改动。因此 [CURRENT] 断言的职责是**如实记录现状并
   在现状变化时变红**，而不是要求现状符合未来契约。例如：

     · calcRelevance 当前值域下限为 1（无法表达 0）→ 契约 §6.3 是 FUTURE；
       本测试断言"它现在确实是 [1,2.5]"，这样 R2-C 真正改掉它时，
       这条断言会失败并要求同步更新契约状态 —— 契约与代码因此不会静默漂移。

   ── 生产文件完整性（check 18）───────────────────────────────────────────
   本测试在**运行时**记录 production memory runtime 文件的 SHA-256，
   并把它写入 tests/fixtures/memory-recall-contract/production-hashes.json
   （不存在时创建，已存在时**必须**一致）。

   为什么用"首次写入 + 之后比对"而不是把哈希写死在源码里：
   把哈希硬编码进测试意味着任何人修改生产文件都必须手改测试里的十六进制串，
   而那正是"顺手把断言更新掉"最容易发生的地方 —— 哈希就变成了仪式。
   持久化基线让**任何**生产改动都必须显式地更新一份可 review 的 JSON，
   并在 diff 里留下痕迹。

   注意：本测试**不**要求整个工作树 clean（本仓库在 R2-A 开始前已存在
   其它未提交工作），只要求**生产 memory runtime 文件**逐字节不变。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');

/* R2-F1b-HASH-BYTES-1: verification is byte-level canonical (CRLF->LF only). */
const { canonicalTextBytes, canonicalTextSha256, rawSha256 } = require('./helpers/canonical-text-hash.js');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = 'docs/contracts/memory/MEMORY_RECALL_CONTRACT.md';
const ARCHITECTURE = 'docs/architecture/MEMORY.md';
const DECISIONS = 'docs/DECISIONS.md';
const VISIBILITY_CORE = 'assets/js/memory-visibility-core.js';
const RETRIEVAL_CORE = 'assets/js/memory-retrieval-core.js';
const MEMORY_CONTRACT = 'assets/js/memory-contract.js';
const HASH_BASELINE = path.join(__dirname, 'fixtures', 'memory-recall-contract', 'production-hashes.json');

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const read = rel => {
  const p = path.join(ROOT, rel);
  assert.ok(fs.existsSync(p), 'required file missing: ' + rel);
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
};
const tryRead = rel => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') : null;
};
/* 契约文本的"声明存在性"判据：忽略大小写地找一段连续措辞。
   刻意不做语义理解 —— 它证明的是"这句话被写下来了"，不是"它被实现了"。 */
const declares = (hay, needle) => hay.toLowerCase().indexOf(needle.toLowerCase()) >= 0;
const countOcc = (hay, needle) => hay.split(needle).length - 1;

/* ══════════════════════════════════════════════════════════════════════
   §1 · Canonical contract 文件存在（check 1）
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · Canonical contract 文件（check 1）');

const contractExists = fs.existsSync(path.join(ROOT, CONTRACT));
check('C1.contractFileExists', contractExists, CONTRACT + ' must exist');
const CONTRACT_TEXT = contractExists ? read(CONTRACT) : '';

check('C1.contractIsCanonical',
  declares(CONTRACT_TEXT, '**Status: Canonical**'),
  'contract must declare Status: Canonical');
check('C1.contractScopeCoversRecallOrchestration',
  declares(CONTRACT_TEXT, 'Memory Recall Orchestration'),
  'contract must name the subject it governs');
/* 契约必须自我声明"本轮不实现"，否则读者会以为编排器已经存在。 */
check('C1.contractDeclaresNotImplementedInR2A',
  declares(CONTRACT_TEXT, 'FUTURE CONTRACT') && declares(CONTRACT_TEXT, '尚不存在'),
  'contract must mark unimplemented clauses as FUTURE CONTRACT and say the orchestrator does not exist yet');

/* ══════════════════════════════════════════════════════════════════════
   §2 · Channel vocabulary（check 2）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · Channel vocabulary（check 2）');

const CHANNELS = ['legacy', 'surface', 'recall', 'glossary', 'coldStart', 'reminisce'];
CHANNELS.forEach(ch => {
  check('C2.channelDeclared.' + ch, declares(CONTRACT_TEXT, '`' + ch + '`'),
    'channel `' + ch + '` must appear in the frozen vocabulary');
});
/* legacy 必须被描述为兼容通道，而不是产品通道 —— 否则下一位读者会以为
   它是"给旧用户用的第五种体验"。 */
check('C2.legacyIsCompatibilityChannel',
  declares(CONTRACT_TEXT, 'compatibility') || declares(CONTRACT_TEXT, '兼容通道'),
  'legacy must be described as a compatibility channel, not a product channel');
/* 契约必须冻结 policy **形状**（5 个字段），但不冻结数值。 */
['gate', 'seats', 'cooldown', 'budgetShare', 'exploration'].forEach(f => {
  check('C2.policyShapeField.' + f, declares(CONTRACT_TEXT, f),
    'channel policy shape must include ' + f);
});
/* §4.2 的明文禁止：不得写死未校准 magic number。 */
check('C2.forbidsCalibratedMagicNumbers',
  declares(CONTRACT_TEXT, 'MUST NOT') && declares(CONTRACT_TEXT, '未经数据校准'),
  'contract must forbid freezing uncalibrated numeric thresholds inside the contract itself');

/* ══════════════════════════════════════════════════════════════════════
   §3 · Reason vocabulary（check 3 + 12）
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · Result reason vocabulary（check 3 + 12）');

/* ── 先取证**当前代码**的 reason 枚举，不凭报告记忆写 ─────────────────── */
const RETRIEVAL_TEXT = read(RETRIEVAL_CORE);
const CURRENT_REASONS = ['no-visible-memory', 'no-budget', 'visibility-unavailable'];
CURRENT_REASONS.forEach(r => {
  check('R.currentReasonInProduction.' + r,
    RETRIEVAL_TEXT.indexOf("'" + r + "'") >= 0,
    'production retrieval core must still return reason ' + r);
});
/* null 表示"有注入"。这条既有契约是调用方决定"是否拼接标题"的依据。 */
check('R.currentSuccessReasonIsNull',
  /reason:\s*null/.test(RETRIEVAL_TEXT),
  'successful recall must still report reason: null');
/* ── PHASE TRANSITION 链（R2-B → R2-C → R2-D，每一步都是有意更新）────────
   R2-B：`R.newReasonsAreNotYetInProduction` —— 断言两个新 reason 在
         生产代码里**根本不存在**。
   R2-C：升级为 `R.newReasonsImplementedInOrchestrator`（已实现）
         + `R.newReasonsNotProducedByActiveLegacyPath`（legacy 路径不产出）。
   R2-D：语义切换**正式发生**，因此后者的判据再次升级为：
         production 的 **turn-aware 模式**确实产出它们，
         而 **legacy 兼容路径**（不传 turn）仍然不产出。

   为什么这条断言要跟着改而不是删掉：它守的是"用户可见行为由谁决定"。
   R2-C 时答案是 legacy；R2-D 时答案变成 turn-aware。
   把它删掉就等于放弃这条守护；把它留着不改则会在 R2-D 的**目标**上变红。
   因此正确的动作是把它换成**R2-D 的真话**。 */
const ORCH_PATH = 'assets/js/memory-recall/memory-recall-orchestrator.js';
const ORCH_TEXT = fs.existsSync(path.join(ROOT, ORCH_PATH)) ? read(ORCH_PATH) : '';

check('R.newReasonsImplementedInOrchestrator',
  ORCH_TEXT.indexOf("REASON_EARLY_EXIT = 'early-exit'") >= 0
  && ORCH_TEXT.indexOf("REASON_GATE_REJECTED = 'gate-rejected'") >= 0,
  'R2-C implemented the two new reasons in the orchestrator');

/* ── R2-D：production semantic mode 是 turn-aware ─────────────────────── */
(function r2dSemanticMode() {
  if (!ORCH_TEXT) { check('R.r2dOrchestratorPresent', false); return; }
  let ORCH;
  try { ORCH = require(path.join(ROOT, ORCH_PATH)); } catch (e) { check('R.r2dOrchestratorLoads', false); return; }
  const now = 1750000000000;
  const day = 86400000;
  const mk = (o) => Object.assign({
    id: 'm', title: 't', content: 'c', importance: 5, arousal: 0.3, resolved: false,
    activationCount: 0, created: now - day, lastActivated: now - day,
    visibility: 'public', tags: [], domain: '日常'
  }, o || {});
  const base = {
    apiId: 'role_a', now: now, random: () => 0.42, isGroup: false,
    groupMemEnabled: false, maxChars: 2000, contentLen: 200
  };
  const turnCall = (recs, msg) => ORCH.recall(recs, Object.assign({}, base, {
    userMessage: msg, turn: { message: msg }
  }));
  const legacyCall = (recs, msg) => ORCH.recall(recs, Object.assign({}, base, {
    userMessage: msg, turn: null
  }));

  const gpu = mk({ id: 'gpu', title: '显卡', content: 'RTX 5070 Ti' });
  const noise = mk({ id: 'noise', title: '量子', content: '退相干时间' });

  /* ① turn-aware：可产出 early-exit */
  const ack = turnCall([gpu], '嗯');
  check('R.r2dTurnModeProducesEarlyExit',
    ack.result.reason === 'early-exit' && ack.result.count === 0,
    'got ' + ack.result.reason);
  /* ② turn-aware：可产出 gate-rejected */
  const unrel = turnCall([gpu], '量子纠缠的退相干时间');
  check('R.r2dTurnModeProducesGateRejected',
    unrel.result.reason === 'gate-rejected' && unrel.result.count === 0,
    'got ' + unrel.result.reason);
  /* ③ turn-aware：相关输入正常产出 */
  const rel = turnCall([gpu], '显卡怎么样');
  check('R.r2dTurnModeProducesNormalResult',
    rel.result.reason === null && rel.result.count === 1 && rel.trace.channel === 'surface',
    JSON.stringify({ reason: rel.result.reason, count: rel.result.count, channel: rel.trace.channel }));

  /* ④ legacy 兼容路径：仍然**不产出**两个新 reason（R2-C 的守护仍然成立） */
  const legacyCases = [
    [[], {}], [[gpu], { userMessage: '量子纠缠的退相干时间' }],
    [[mk({ id: 'p', visibility: 'private' })], { userMessage: 'x' }],
    [[gpu], { userMessage: '显卡' }], [[gpu], { userMessage: '嗯' }],
    [[gpu], { userMessage: '😂' }], [[gpu], { userMessage: '' }]
  ];
  let legacyClean = true;
  const legacySeen = new Set();
  for (const [recs, over] of legacyCases) {
    const out = legacyCall(recs, over.userMessage == null ? '' : over.userMessage);
    legacySeen.add(String(out.result.reason));
    if (out.result.reason === 'early-exit' || out.result.reason === 'gate-rejected') legacyClean = false;
    if (out.meta.mode !== 'legacy') legacyClean = false;
  }
  check('R.legacyPathStillDoesNotProduceNewReasons', legacyClean,
    'the R2-C compatibility layer must keep its old semantics');
  check('R.legacyPathVocabularyReachable',
    legacySeen.has('null') && legacySeen.has('no-visible-memory'),
    'coverage self-check: the legacy probes must actually exercise real legacy reasons — '
    + JSON.stringify(Array.from(legacySeen)));

  /* ⑤ fail-safe：turn 存在但 message 缺失 ⇒ legacy-fallback，不是 early-exit */
  const fb = ORCH.recall([gpu], Object.assign({}, base, { userMessage: '显卡', turn: {} }));
  check('R.turnWithoutMessageFallsBackToLegacy',
    fb.meta.mode === 'legacy-fallback' && fb.meta.turnUsable === false
    && fb.result.reason !== 'early-exit',
    JSON.stringify({ mode: fb.meta.mode, reason: fb.result.reason }));

  /* ⑥ 反向控制：判据必须能发现"turn-aware 没生效"。 */
  check('R.reverseControl.turnAwareDetectorIsLive',
    legacyCall([gpu], '嗯').result.reason !== 'early-exit',
    'reverse control: without turn the early-exit must NOT fire');
})();

CURRENT_REASONS.concat(['early-exit', 'gate-rejected']).forEach(r => {
  /* 词表条目可能写作 `'no-budget'`（代码字面量）或 `no-budget`（表格单元格）。
     两者都算"被冻结"；断言不该绑定某一种排版。 */
  check('C3.contractFreezesReason.' + r,
    declares(CONTRACT_TEXT, '`' + r + '`') || declares(CONTRACT_TEXT, "'" + r + "'"),
    'reason `' + r + '` must be frozen in the contract');
});
check('C3.newReasonsMarkedFuture',
  declares(CONTRACT_TEXT, '只增不改'),
  'contract must state new reasons are additive-only (never redefine existing values)');

/* 三态必须可区分：early-exit ≠ gate-rejected ≠ no-visible-memory。 */
check('C3.threeZeroStatesAreDistinguished',
  declares(CONTRACT_TEXT, 'early-exit') && declares(CONTRACT_TEXT, 'gate-rejected')
  && declares(CONTRACT_TEXT, 'no-visible-memory'),
  'contract must distinguish "not consulted", "gate-rejected" and "no visible candidate"');

/* ══════════════════════════════════════════════════════════════════════
   §4 · "0 memory is valid success"（check 4 + 6 + 11）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · 0 memory 是合法成功结果（check 4）');

check('C4.declaresZeroIsValidSuccess',
  declares(CONTRACT_TEXT, '0 memory is a valid successful recall result'),
  'contract must state the core proposition verbatim');
check('C4.zeroIsNotFailure',
  declares(CONTRACT_TEXT, '不是错误') || declares(CONTRACT_TEXT, 'not an error'),
  'contract must state that a zero result is neither error nor degraded');
check('C4.selectionNotSliceOnly',
  declares(CONTRACT_TEXT, 'sort().slice(0, N)'),
  'contract must explicitly reject unconditioned sort().slice(0,N) as the selection policy');

/* ── [CURRENT] 现状如实记录：当前实现**不满足**该契约 ────────────────────
   calcRelevance 的值域是 [1, 2.5]（1 + ratio*1.5）。下限恒为 1 ⇒ 无法表达
   "无相关证据" ⇒ 预算是唯一停止条件。这正是 R2-C 要处理的核心问题。
   本断言把现状钉住：R2-C 真正改掉它时，这里会变红并要求更新契约状态。 */
check('R.currentCalcRelevanceFloorIsOne',
  /return 1 \+ ratio \* 1\.5/.test(RETRIEVAL_TEXT),
  'current production relevance floor must still be 1 (contract §6 is FUTURE, not yet true)');
check('R.currentRelevanceCannotExpressZero',
  /if \(!keywords \|\| !keywords\.length\) return 1;/.test(RETRIEVAL_TEXT),
  'empty keyword list must still yield 1 (no way to express "no evidence")');

/* ══════════════════════════════════════════════════════════════════════
   §5 · relevanceScore 可取 0（check 5）+ 与 memoryValue 分离（check 6）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · relevanceScore / memoryValue 分离（check 5 + 6）');

check('C5.relevanceScoreRangeIncludesZero',
  declares(CONTRACT_TEXT, '值域**必须包含 0**') || declares(CONTRACT_TEXT, 'must include 0'),
  'contract must require relevanceScore to be able to express 0');
check('C5.zeroMustFailGate',
  declares(CONTRACT_TEXT, '不得**通过 gate') || declares(CONTRACT_TEXT, 'must not pass the gate'),
  'contract must require score===0 to fail the hard gate');
check('C5.scoreRelevanceInterfaceShape',
  declares(CONTRACT_TEXT, 'scoreRelevance(memory, query, context)'),
  'contract must freeze the scoreRelevance interface shape');
check('C5.scoreFormulaNotFrozen',
  declares(CONTRACT_TEXT, '本轮不冻结'),
  'contract must explicitly leave the concrete formula unfrozen');

/* 分离必须写成 MUST 级约束，而不是一句描述性的话 —— 否则它读起来像观察结果。
   注意证据串带 markdown 加粗标记：契约用 `**两个独立概念**` 强调它，
   断言要匹配**实际写下来的字节**，而不是我们记忆中的措辞。 */
check('C6.relevanceVsValueDistinct',
  declares(CONTRACT_TEXT, '**两个独立概念**'),
  'contract must state as a MUST that relevanceScore and memoryValue are two independent concepts');
check('C6.relevanceVsValueIsMandatory',
  /MUST\*\*：`relevanceScore` 与 `memoryValue` 是/.test(CONTRACT_TEXT),
  'the separation must be introduced by a MUST, not by a descriptive sentence');
check('C6.relevanceDependsOnQuery',
  declares(CONTRACT_TEXT, '与本轮查询有多相关'),
  'contract must state relevanceScore answers "how relevant to this turn\'s query"');
check('C6.valueDoesNotDependOnQuery',
  declares(CONTRACT_TEXT, '这条记忆本身有多值得浮现'),
  'contract must state memoryValue answers "how much is this memory itself worth surfacing"');
check('C6.valueIsQueryIndependent',
  declares(CONTRACT_TEXT, '是否依赖 query') || declares(CONTRACT_TEXT, '不依赖'),
  'contract must state which of the two depends on the query');
/* 修订 3：不得把四因子公式永久冻结。 */
check('C6.legacyValueFrozenAsCompatibilityOnly',
  declares(CONTRACT_TEXT, 'LegacyMemoryValue'),
  'contract must freeze the current formula as LegacyMemoryValue (compatibility definition)');
check('C6.doesNotFreezeFormulaForever',
  !declares(CONTRACT_TEXT, '永久逐字不变'),
  'contract must NOT declare the four-factor formula permanently unchanged (R2-A revision 3)');
check('C6.memoryValueV2Reserved',
  declares(CONTRACT_TEXT, 'MemoryValueV2'),
  'contract must reserve MemoryValueV2 for a later, independently tested semantic cutover');
check('C6.v2RequiresIndependentTestsAndRecord',
  declares(CONTRACT_TEXT, '独立测试') && declares(CONTRACT_TEXT, '行为变更记录'),
  'MemoryValueV2 must require independent tests and a behaviour-change record');

/* ══════════════════════════════════════════════════════════════════════
   §6 · Legacy compatibility（check 7）
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · Legacy compatibility / parity safety belt（check 7）');

check('C7.legacyPathDeclared',
  declares(CONTRACT_TEXT, 'legacy') && declares(CONTRACT_TEXT, 'turn / recall signal'),
  'contract must define when the legacy path is entered');
check('C7.parityIsByteIdenticalText',
  declares(CONTRACT_TEXT, '逐字节相同'),
  'legacy parity must require byte-identical text');
check('C7.parityCoversIdsAndReason',
  declares(CONTRACT_TEXT, 'selected IDs') && declares(CONTRACT_TEXT, 'reason'),
  'legacy parity must cover selected ids and reason, not only text');
check('C7.parityIsAssertable',
  declares(CONTRACT_TEXT, '可断言的') || declares(CONTRACT_TEXT, '可断言'),
  'parity must be an assertable property, not a visual impression');
check('C7.clockAndRandomInjected',
  declares(CONTRACT_TEXT, '注入'),
  'parity depends on injected clock/random (no global reads)');

/* ══════════════════════════════════════════════════════════════════════
   §7 · Visibility pre-filter invariant（check 8 + 9）
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · Visibility invariant（check 8 + 9）');

check('C8.preFilterInvariantDeclared',
  declares(CONTRACT_TEXT, 'Visibility filtering MUST occur before'),
  'contract must state the pre-filter ordering invariant verbatim');
/* 该不变量必须覆盖 trace candidate detail —— 否则 ACL 拒绝的记忆会把
   标题泄漏到观测面，"先过滤"就只在打分路径成立而不在观测路径成立。 */
check('C8.invariantCoversTraceDetail',
  declares(CONTRACT_TEXT, 'trace candidate detail'),
  'the pre-filter invariant must explicitly cover trace candidate detail');
check('C8.invariantIsCurrentFact',
  RETRIEVAL_TEXT.indexOf('visibility / ACL') >= 0
  && /visible\.push\(m\)/.test(RETRIEVAL_TEXT),
  'production must still filter visibility before scoring (this invariant is already true today)');

check('C9.singleAclIsVisibilityCore',
  declares(CONTRACT_TEXT, 'memory-visibility-core.js'),
  'contract must name memory-visibility-core.js as the single ACL');
check('C9.forbidsSecondAcl',
  declares(CONTRACT_TEXT, 'MUST NOT') && declares(CONTRACT_TEXT, '第二套 ACL'),
  'contract must forbid a second ACL');
check('C9.failClosedDeclared',
  declares(CONTRACT_TEXT, 'fail closed') || declares(CONTRACT_TEXT, 'fail-closed'),
  'contract must require fail-closed behaviour for missing/invalid visibility');
check('R.visibilityCoreIsFailClosed',
  /if \(mem\.visibility === 'private'\) return false;/.test(read(VISIBILITY_CORE))
  && /return false;\n  \}/.test(read(VISIBILITY_CORE)),
  'production visibility core must still fail closed on unknown/missing visibility');

/* ══════════════════════════════════════════════════════════════════════
   §8 · Cooldown = session-local（check 10）+ 不扩 TELEMETRY_FIELDS
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · Cooldown / RecallSessionState（check 10）');

check('C10.sessionLocalDeclared',
  declares(CONTRACT_TEXT, 'session-local'),
  'contract must state cooldown is session-local in R2');
check('C10.recallSessionStateShape',
  declares(CONTRACT_TEXT, 'RecallSessionState') && declares(CONTRACT_TEXT, 'lastSurfacedAt')
  && declares(CONTRACT_TEXT, 'lastRecalledAt') && declares(CONTRACT_TEXT, 'lastChannel'),
  'contract must freeze the RecallSessionState shape');
check('C10.notAMemoryRecordField',
  declares(CONTRACT_TEXT, '不是') && declares(CONTRACT_TEXT, 'MemoryRecord content'),
  'contract must state RecallSessionState is not MemoryRecord content');
check('C10.notPersistedOrCrossDevice',
  declares(CONTRACT_TEXT, '重启可丢失') || declares(CONTRACT_TEXT, '重启后保留'),
  'contract must state restart/cross-device persistence is not guaranteed');
check('C10.isExplicitSemanticsNotDegraded',
  declares(CONTRACT_TEXT, '不是') && declares(CONTRACT_TEXT, 'degraded'),
  'session-local cooldown must be declared explicit product semantics, not a degraded state');
check('C10.durableCooldownDeferredToR2H',
  declares(CONTRACT_TEXT, 'R2-H') && declares(CONTRACT_TEXT, 'Authority Closure'),
  'durable/coordinate cooldown must be deferred to R2-H Authority Closure');

/* ── 修订 2：不得扩展 TELEMETRY_FIELDS ───────────────────────────────────
   这是本轮最容易"顺手做掉"的越界：契约里提到 telemetry，实现者顺手就往
   TELEMETRY_FIELDS 里加字段。R2-A 明令禁止。 */
const MEMCONTRACT_TEXT = read(MEMORY_CONTRACT);
const telemetryBlock = (MEMCONTRACT_TEXT.match(/var TELEMETRY_FIELDS = \[([\s\S]*?)\];/) || [])[1] || '';
const telemetryFields = (telemetryBlock.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
const EXPECTED_TELEMETRY = [
  'activationCount', 'lastActivated', 'lastConsolidatedAt',
  'visibilityRepairedAt', 'visibilityRepairReason'
];
check('R.telemetryFieldsUnchanged',
  JSON.stringify(telemetryFields) === JSON.stringify(EXPECTED_TELEMETRY),
  'TELEMETRY_FIELDS must be byte-identical to the pre-R2-A baseline (got ' + JSON.stringify(telemetryFields) + ')');
check('R.noRecallTelemetryPromoted',
  telemetryFields.indexOf('lastSurfacedAt') < 0 && telemetryFields.indexOf('lastRecalledAt') < 0
  && telemetryFields.indexOf('lastChannel') < 0,
  'recall cooldown telemetry must NOT be promoted to durable record fields in R2-A');

/* ══════════════════════════════════════════════════════════════════════
   §9 · Trace contract（check 16 + 17）
   ══════════════════════════════════════════════════════════════════════ */
section('§9 · RecallTrace 契约（check 16 + 17）');

['RecallTrace', 'version', 'earlyExit', 'earlyExitReason', 'lexicalTerms', 'entities',
  'temporalHints', 'aliases', 'counts', 'input', 'visible', 'gated', 'selected',
  'candidates', 'memoryId', 'relevanceScore', 'memoryValue', 'cooldownFactor',
  'finalScore', 'seat', 'decision', 'reasons', 'budget', 'maxChars', 'usedChars', 'reason'
].forEach(f => {
  check('C16.traceField.' + f, declares(CONTRACT_TEXT, f),
    'trace contract must include field ' + f);
});
check('C16.traceForbidsContentAndCredentials',
  declares(CONTRACT_TEXT, 'API Key') && declares(CONTRACT_TEXT, 'credential')
  && declares(CONTRACT_TEXT, 'system prompt'),
  'trace contract must forbid content, credentials and system prompt');
check('C16.traceForbidsHiddenMemoryBody',
  declares(CONTRACT_TEXT, '私有 / 隐藏记忆的正文') || declares(CONTRACT_TEXT, '隐藏记忆的正文'),
  'trace contract must forbid hidden memory bodies');
check('C16.aclRejectedNotInTraceDetail',
  declares(CONTRACT_TEXT, '只允许') && declares(CONTRACT_TEXT, 'opaque id'),
  'ACL-rejected memories must be expressible by count / opaque id only');
check('C16.traceAllowsZeroSelected',
  declares(CONTRACT_TEXT, 'selected === 0'),
  'trace must be able to express a legal zero-selection turn');

check('C17.durableTelemetryRequiresExclusion',
  declares(CONTRACT_TEXT, 'TELEMETRY_FIELDS'),
  'contract must name the telemetry exclusion mechanism');
check('C17.durableTelemetryRequiresFingerprintProof',
  declares(CONTRACT_TEXT, 'contentFingerprint') && declares(CONTRACT_TEXT, 'idempotency'),
  'contract must require proving fingerprint / migration idempotency are unaffected');

/* ══════════════════════════════════════════════════════════════════════
   §10 · Storage / schema 边界（check 11 + 12 + 13）
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · Storage / dependency 边界（check 11 + 12 + 13）');

check('C11.noNewStoreRequired',
  declares(CONTRACT_TEXT, '不新增 store') || declares(CONTRACT_TEXT, '不得') ,
  'contract must state no new object store is required');
check('C12.noDbVerBump',
  declares(CONTRACT_TEXT, 'DB_VER'),
  'contract must state DB_VER is not bumped');
check('C13.noVectorOrEmbedding',
  declares(CONTRACT_TEXT, 'embedding') && declares(CONTRACT_TEXT, 'vector DB'),
  'contract must explicitly exclude vector DB / embedding');
check('C13.noRagFramework',
  declares(CONTRACT_TEXT, 'RAG framework'),
  'contract must explicitly exclude a RAG framework');
check('C13.bm25RequiresEvidence',
  declares(CONTRACT_TEXT, 'BM25'),
  'contract must state BM25 requires real-distribution evidence before adoption');
check('C13.lexicalNaturePreserved',
  declares(CONTRACT_TEXT, 'lexical') || declares(CONTRACT_TEXT, '可解释'),
  'contract must preserve the lexical / explainable nature of native recall');
check('C11.storageAuthorityUnchanged',
  declares(CONTRACT_TEXT, 'storage authority') && declares(CONTRACT_TEXT, '不变'),
  'contract must state storage authority is unchanged');

/* ── [CURRENT] 依赖面不变：本轮不得引入任何新依赖 ─────────────────────── */
const pkgExists = fs.existsSync(path.join(ROOT, 'package.json'));
check('R.noPackageManifestAtRoot', !pkgExists,
  'R2-A must not have introduced a package.json / dependency manifest at repo root');

/* ══════════════════════════════════════════════════════════════════════
   §11 · Auto Memory 登记为 parallel pipeline（check 14）
   ══════════════════════════════════════════════════════════════════════ */
section('§11 · Auto Memory 并行管线（check 14）');

check('C14.autoMemoryRegisteredAsParallel',
  declares(CONTRACT_TEXT, 'Known Parallel Recall Pipeline')
  || declares(CONTRACT_TEXT, '并行召回管线'),
  'contract must register Auto Memory as a known parallel recall pipeline');
check('C14.notDescribedAsCanonicalProducer',
  declares(CONTRACT_TEXT, '不得') && declares(CONTRACT_TEXT, 'canonical Memory 的 producer'),
  'contract must forbid describing Auto Memory as a canonical Memory producer');
/* 架构文档同样必须如实登记 —— 只写在 contract 里不够，因为
   docs/architecture/MEMORY.md 才是读者默认会打开的那一份。 */
const ARCH_TEXT = read(ARCHITECTURE);
check('C14.architectureDocRegistersParallelPipeline',
  declares(ARCH_TEXT, 'Parallel Recall Pipeline'),
  'docs/architecture/MEMORY.md must register the parallel pipeline');
check('C14.mergeIsUndecided',
  declares(CONTRACT_TEXT, '未决'),
  'whether to merge Auto Memory must be recorded as an undecided product/architecture question');
check('C14.notFixedInR2',
  declares(CONTRACT_TEXT, '本轮不修'),
  'contract must state Auto Memory is not fixed in R2-A');

/* ── [CURRENT] 事实核对：autoMemory 确实不是 canonical memories 的写入面 ── */
const AUTO_MEMORY_TEXT = read('assets/js/memory/auto-memory.js');
check('R.autoMemoryWritesOwnStoreOnly',
  countOcc(AUTO_MEMORY_TEXT, "dbPut('autoMemory'") > 0
  && countOcc(AUTO_MEMORY_TEXT, "dbPut('memories'") === 0,
  'production auto-memory must write only the autoMemory store');
check('R.autoMemoryDoesNotWriteCanonical',
  AUTO_MEMORY_TEXT.indexOf('quickCreateMemory') < 0,
  'production auto-memory must not route through quickCreateMemory');

/* ══════════════════════════════════════════════════════════════════════
   §12 · Known Authority Gap: MEMORY-ACTIVATION-AUTHORITY（check 15）
   ══════════════════════════════════════════════════════════════════════ */
section('§12 · Known Authority Gap（check 15）');

check('C15.gapIsNamed',
  declares(CONTRACT_TEXT, 'MEMORY-ACTIVATION-AUTHORITY'),
  'contract must register the authority gap under a stable name');
check('C15.gapRecordsAllThreeFacts',
  declares(CONTRACT_TEXT, 'dbUpdate') && declares(CONTRACT_TEXT, '没有生产调用点')
  && declares(CONTRACT_TEXT, 'hydration'),
  'gap record must state: desktop writes via dbUpdate, authority channel has no caller, hydration overwrites');
check('C15.gapNotFixedInR2A',
  declares(CONTRACT_TEXT, '本轮**不接线**') || declares(CONTRACT_TEXT, '不接线'),
  'contract must state the gap is registered but not wired in R2-A');
check('C15.gapPointsToR2H',
  declares(CONTRACT_TEXT, 'R2-H'),
  'gap must point forward to R2-H Authority Closure');

/* ══ [CURRENT] R4-A.1 · activation authority 的真实 wiring 不变量 ══════════
   R2-A 时代这里断言的是"authority 通道存在，但**没有任何**生产调用者"。
   R2-H2 已经**合法地**把桌面 recall 强化接进那条通道 —— 但接线走的是局部别名
   （assets/js/memory.js 的 `auth.recordActivation(...)`），而旧断言查的是字面量
   `memoryAuthority.recordActivation`。于是它一直绿着，却不再守任何东西：
   这正是 R4-A 登记的 stale guard（"绿着但已失效"）。

   本轮按 R2-H 的**当前真相**重写成两层不变量，不再依赖字面量匹配：
     W1（行为）  把生产源码里的 _ibMemoryAuthority / recordMemoryActivation
                 **原样抽出来**在隔离 vm 里执行（helpers/activation-wiring-probe.js），
                 证明 canonical 分支是 remote-first，且失败**不回落**成镜像写入。
     W2（结构）  登记**全部**把 activation 遥测写进浏览器 memories 的写者；
                 新增一个绕过 authority 的写者会让本测试变红，而**已知**的越界面
                 被显式登记为 debt，而不是被断言成"不存在"。
   完整 runtime 行为（hydrate / retry / 双端 parity）由
   test_memory_activation_authority.js 与 test_memory_recall_cooldown_hosts.js 覆盖；
   这里**不**重复那套行为测试。 */
/* R4-A.2：扫描器必须 comment-aware（helper 提供），否则修复注释里逐字引用的旧代码
   会被误判成"仍然存在的写者"。 */
const WIRING = require('./helpers/activation-wiring-probe.js');
const AUTHORITY_TEXT = read('assets/js/memory-authority.js');
check('R.authorityActivationChannelExists',
  /function recordActivation\(ids, options\)/.test(AUTHORITY_TEXT),
  'memory-authority must expose the recordActivation channel');

/* ── W1 · 行为：执行真实生产源码（不是匹配字面量）───────────────────────── */
const PROBE = JSON.parse(require('node:child_process').execFileSync(
  process.execPath,
  [path.join(__dirname, 'helpers', 'activation-wiring-probe.js')],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).recall;
const S = PROBE.scenarios;
const PROBE_SCENARIOS = ['canonicalSuccess', 'canonicalDefiniteFailure', 'canonicalTransportThrow',
  'canonicalSyncThrow', 'canonicalStatusThrows', 'canonicalInvalidResultShape',
  'canonicalMissingOkFlag', 'authorityWithoutStatus', 'authorityResolverThrows',
  'mirrorMode', 'offMode', 'noAuthority', 'moduleFallbackInstance',
  'authorityWithoutRecordActivation', 'mirrorWithoutDbUpdate', 'emptySelection'];
/* canonical / ambiguous 类场景：一律不得写镜像。 */
const AMBIGUOUS_SCENARIOS = ['canonicalSuccess', 'canonicalDefiniteFailure', 'canonicalTransportThrow',
  'canonicalSyncThrow', 'canonicalStatusThrows', 'canonicalInvalidResultShape',
  'canonicalMissingOkFlag', 'authorityWithoutStatus', 'authorityResolverThrows'];

check('R.activationProbeCoversEveryScenario',
  PROBE.probe === 'P21-R4-A.3' && PROBE_SCENARIOS.every(name => S[name] && typeof S[name] === 'object'),
  'the vm probe must report every declared activation scenario (missing: '
  + PROBE_SCENARIOS.filter(name => !S[name]).join(', ') + ')');

check('R.canonicalActivationGoesThroughAuthoritySeam',
  S.canonicalSuccess.authorityCalls === 1
  && S.canonicalSuccess.statusCalls === 1
  && JSON.stringify(S.canonicalSuccess.authorityIds) === JSON.stringify(['m1', 'm2']),
  'canonical mode must resolve the authority instance and call recordActivation with the selected ids');

check('R.canonicalActivationIsRemoteFirstAndDoesNotTouchMirrorDirectly',
  S.canonicalSuccess.mirrorUpdateCalls === 0
  && S.canonicalSuccess.mirrorWriteCalls === 0
  && S.canonicalSuccess.returned === 2
  && S.canonicalSuccess.rowActivationCounts.every(count => count === 0),
  'canonical success must not bump the mirror locally (AUTHORITY §2.1 remote-first)');

check('R.canonicalActivationPreservesAtStamp',
  S.canonicalSuccess.authorityOptions && S.canonicalSuccess.authorityOptions.at === 1700000000000,
  'the activation timestamp must be forwarded to the authority unchanged');

check('R.canonicalDefiniteFailureLeavesBothSidesUnchanged',
  S.canonicalDefiniteFailure.authorityCalls === 1
  && S.canonicalDefiniteFailure.mirrorWriteCalls === 0
  && S.canonicalDefiniteFailure.returned === 0,
  'DEFINITE_FAILURE must leave canonical and mirror unchanged (TELEMETRY_FAIL_CLOSED)');

check('R.canonicalAmbiguousSeamResultLeavesMirrorUnchanged',
  S.canonicalMissingOkFlag.authorityCalls === 1
  && S.canonicalMissingOkFlag.mirrorWriteCalls === 0
  && S.canonicalMissingOkFlag.returned === 0,
  'a seam result without ok:true (AMBIGUOUS_OUTCOME shape) must not guess a mirror delta');

/* ── R4-A.2 · R4A1-ACTIVATION-FALLTHROUGH-1 关闭后的**逐结局**断言 ─────────
   修复前：canonical 判定与 authority 调用共用同一个 try/catch，因此 reject 会被
   吞掉并**继续向下执行**到镜像分支（probe 实测 mirrorWriteCalls=2）。
   修复后：canonical 归属一经判定 ⇒ 必定 return，镜像代码结构上不可达。
   下面把"任何结局都不得本地补账"逐条钉住。 */
check('R.canonicalTransportRejectCannotFallThroughToMirror',
  S.canonicalTransportThrow.authorityCalls === 1
  && S.canonicalTransportThrow.mirrorUpdateCalls === 0
  && S.canonicalTransportThrow.mirrorWriteCalls === 0
  && S.canonicalTransportThrow.returned === 0
  && S.canonicalTransportThrow.threw === null,
  'a rejected authority promise must fail closed: no local mirror delta, no throw to the chat caller');

check('R.canonicalSyncThrowCannotFallThroughToMirror',
  S.canonicalSyncThrow.authorityCalls === 1
  && S.canonicalSyncThrow.mirrorWriteCalls === 0
  && S.canonicalSyncThrow.returned === 0
  && S.canonicalSyncThrow.threw === null,
  'a synchronously throwing authority must fail closed exactly like a rejected promise');

check('R.canonicalStatusThrowDoesNotGuessTheMode',
  S.canonicalStatusThrows.statusCalls === 1
  && S.canonicalStatusThrows.authorityCalls === 0
  && S.canonicalStatusThrows.mirrorWriteCalls === 0
  && S.canonicalStatusThrows.returned === 0
  && S.canonicalStatusThrows.threw === null,
  'if the resolved authority cannot report its mode, the caller must not guess — no mirror delta');

check('R.canonicalInvalidResultShapeIsNotASuccess',
  S.canonicalInvalidResultShape.authorityCalls === 1
  && S.canonicalInvalidResultShape.mirrorWriteCalls === 0
  && S.canonicalInvalidResultShape.returned === 0,
  'a non-object / ok-less result must count as failure, never as confirmed telemetry');

check('R.noCanonicalScenarioEverBumpsTheMirror',
  AMBIGUOUS_SCENARIOS.every(name => S[name].mirrorWriteCalls === 0 && S[name].threw === null),
  'no canonical/ambiguous scenario may write the mirror or throw to the caller: '
  + JSON.stringify(AMBIGUOUS_SCENARIOS.filter(name => S[name].mirrorWriteCalls !== 0 || S[name].threw !== null)));

/* ── R4-A.3 · resolver-throw 边界（§5/§6/§7）─────────────────────────────
   关键区分（不得混淆）：
     NO AUTHORITY                ⇒ 可以本地回落（既有 host-local 语义）
     AUTHORITY RESOLUTION FAILED ⇒ ambiguous，**不得猜** */
check('R.resolverIsStructurallyThrowSafe',
  WIRING.resolverIsStructurallyThrowSafe(read('assets/js/memory.js')).ok === true,
  'the whole _ibMemoryAuthority() body must stay inside try/catch returning null '
  + '(so it can never propagate a throw): '
  + JSON.stringify(WIRING.resolverIsStructurallyThrowSafe(read('assets/js/memory.js'))));

check('R.authorityResolverThrowCannotFallThroughToMirror',
  S.authorityResolverThrows.mirrorUpdateCalls === 0
  && S.authorityResolverThrows.mirrorWriteCalls === 0
  && S.authorityResolverThrows.returned === 0
  && S.authorityResolverThrows.threw === null,
  'if the resolver itself throws, the caller must fail closed — no local canonical guess');

check('R.authorityWithoutStatusIsAmbiguousNotAbsent',
  S.authorityWithoutStatus.mirrorWriteCalls === 0
  && S.authorityWithoutStatus.returned === 0
  && S.authorityWithoutStatus.threw === null,
  'a resolved authority whose mode is unreadable is ambiguous, not absent: fail closed');

check('R.noAuthorityStillFallsBackWhileAmbiguityDoesNot',
  S.noAuthority.mirrorWriteCalls === 2 && S.noAuthority.returned === 2
  && S.authorityResolverThrows.mirrorWriteCalls === 0
  && S.authorityWithoutStatus.mirrorWriteCalls === 0,
  'the NO-AUTHORITY fallback must survive while AMBIGUOUS RESOLUTION must not (the two are different states)');

check('R.noScenarioEverRetries',
  PROBE_SCENARIOS.every(name => S[name].authorityCalls <= 1),
  'AUTO_RETRY = NONE: no scenario may call the authority twice');

check('R.seamResolvesAmbiguousInsteadOfRejecting',
  /outcome:\s*'ambiguous'/.test(AUTHORITY_TEXT)
  && /mirrorUnchanged:\s*true/.test(AUTHORITY_TEXT)
  && /noteRemoteFailure\(error\)/.test(AUTHORITY_TEXT),
  'memory-authority must resolve transport failure as outcome:ambiguous (never reject). '
  + 'R4-A.2 之后这**不再是** caller 唯一的保护 —— caller 自身已经 fail-closed '
  + '（见 R.canonicalTransportRejectCannotFallThroughToMirror）；这条保留为两层防线中的 seam 层');

/* ── W2 · 结构：登记每一个 activation 遥测写者 ───────────────────────────
   motif 只描述**形状**，不描述意图；分类由人逐个读代码给出。
   数量刻意写死：删掉/新增一个写者都必须显式更新这张表（可评审的改动）。
   R4-A.2 之后 memory.js 剩两个 motif 组：
     · mirror-bump ×2        —— recordMemoryActivation 的 host-local 回落（mirror/off/无 authority 才可达）
     · last-activated-write ×3 —— 同上两条 + importMemoriesFile 的缺省填充
   两个 UI 越界面（writeOneLineToMemory / saveInlineEdit）已不再出现在这里。 */
const ACTIVATION_WRITER_MOTIFS = [
  { id: 'mirror-bump', re: /([A-Za-z_$][\w$]*)\.activationCount\s*=\s*\(?\s*\1\.activationCount\s*\|\|\s*0\s*\)?\s*\+\s*1/g },
  { id: 'authoritative-set', re: /([A-Za-z_$][\w$]*)\.activationCount\s*=\s*Number\(/g },
  { id: 'last-activated-write', re: /\.lastActivated\s*=(?!=)/g }
];
const DECLARED_ACTIVATION_WRITERS = [
  { file: 'assets/js/memory-authority.js', motif: 'authoritative-set', count: 1, kind: 'CANONICAL_CONFIRMED_MIRROR_SET',
    why: 'setMirrorFromCanonical：canonical 成功后用服务端权威 per-id 值 SET mirror（Strategy C）' },
  { file: 'assets/js/memory-authority.js', motif: 'last-activated-write', count: 1, kind: 'CANONICAL_CONFIRMED_MIRROR_SET',
    why: '同上（权威 lastActivated 一并 SET）' },
  { file: 'assets/js/home-node-bootstrap.js', motif: 'mirror-bump', count: 1, kind: 'MIRROR_MODE_LOCAL',
    why: 'bumpActivation：memory-authority 的镜像驱动，只在 remoteEnabled()=false（mirror/off）时可达' },
  { file: 'assets/js/home-node-bootstrap.js', motif: 'last-activated-write', count: 1, kind: 'MIRROR_MODE_LOCAL',
    why: '同上' },
  { file: 'assets/js/memory.js', motif: 'mirror-bump', count: 2, kind: 'MIRROR_MODE_LOCAL',
    why: 'recordMemoryActivation 的 host-local 回落（canonical 分支必定 return；只有 mirror/off/无 authority 才到达）' },
  { file: 'assets/js/memory.js', motif: 'last-activated-write', count: 3, kind: 'MIRROR_MODE_LOCAL + MIGRATION_IMPORT',
    why: '2 = 同上的回落；1 = importMemoriesFile 的缺省填充（if(!m.lastActivated)m.lastActivated=m.created）' }
];

/* ── R4-A.2 关闭的 defect 登记 ────────────────────────────────────────────
   这三个 ID 来自 R4-A.1 的机械发现。R4-A.2 已修，因此这里断言的不再是
   "marker 存在"，而是：
     · **旧代码在剥离注释后的代码面上不再出现**（回归即变红）；
     · 修复标记仍在（防止有人把注释一起删掉、让读者不知道这里发生过什么）。 */
const CLOSED_ACTIVATION_DEFECTS = [
  { id: 'R4A1-ACTIVATION-UI-BYPASS-1', fn: 'writeOneLineToMemory',
    repairMarker: 'R4A1-ACTIVATION-UI-BYPASS-1 修复',
    forbidden: [/mem\.activationCount\s*=\s*\(\s*mem\.activationCount\s*\|\|\s*0\s*\)\s*\+\s*1/,
      /mem\.lastActivated\s*=\s*Date\.now\(\)/],
    why: 'UI 写一句话不是 recall 激活；此前直改镜像遥测（canonical mode 下也发生）' },
  { id: 'R4A1-ACTIVATION-UI-BYPASS-2', fn: 'saveInlineEdit',
    repairMarker: 'R4A1-ACTIVATION-UI-BYPASS-2 修复',
    forbidden: [/m\.lastActivated\s*=\s*Date\.now\(\)\s*;/],
    why: '编辑内容不是激活；此前把 lastActivated 写成 now，人为抬高 LegacyMemoryValue 的 recency' },
  { id: 'R4A1-ACTIVATION-FALLTHROUGH-1', fn: 'recordMemoryActivation',
    repairMarker: 'R4A1-ACTIVATION-FALLTHROUGH-1 修复',
    forbidden: [/if\s*\(\s*auth\s*&&[^\n]*auth\.status\(\)\.mode\s*===\s*'canonical'\s*\)/],
    why: 'canonical 判定与 authority 调用曾共用同一个 try/catch，reject 会落进镜像乐观 +1' }
];

function scanActivationWriters(dir) {
  const found = [];
  const walk = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      /* R4-A.2：先剥注释再匹配 —— 注释里逐字引用的旧代码不是写者。 */
      const text = WIRING.stripJsComments(fs.readFileSync(full, 'utf8'));
      for (const motif of ACTIVATION_WRITER_MOTIFS) {
        motif.re.lastIndex = 0;
        const count = (text.match(motif.re) || []).length;
        if (count > 0) {
          found.push({ file: path.relative(ROOT, full).replace(/\\/g, '/'), motif: motif.id, count: count });
        }
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => (a.file + a.motif).localeCompare(b.file + b.motif));
}
const FOUND_ACTIVATION_WRITERS = scanActivationWriters(path.join(ROOT, 'assets', 'js'));
const DECLARED_SORTED = DECLARED_ACTIVATION_WRITERS
  .map(row => ({ file: row.file, motif: row.motif, count: row.count }))
  .sort((a, b) => (a.file + a.motif).localeCompare(b.file + b.motif));

check('R.activationMirrorWritersMatchDeclaredRegistry',
  JSON.stringify(FOUND_ACTIVATION_WRITERS) === JSON.stringify(DECLARED_SORTED),
  'every production writer of activation telemetry must be registered in the declared table '
  + '(this is what catches a NEW authority bypass)\n        found    =' + JSON.stringify(FOUND_ACTIVATION_WRITERS)
  + '\n        declared =' + JSON.stringify(DECLARED_SORTED));

check('R.activationCanonicalWriterIsAuthorityOnly',
  DECLARED_ACTIVATION_WRITERS.filter(row => row.motif === 'authoritative-set').length === 1
  && DECLARED_ACTIVATION_WRITERS.filter(row => row.motif === 'authoritative-set')[0].file === 'assets/js/memory-authority.js'
  && /activate:\s*function \(ids, options\)/.test(read('assets/js/home-node-client.js')),
  'the only authoritative activation SET in the browser must be memory-authority → /memory/activate');

const MEMORY_JS_SOURCE = read('assets/js/memory.js');
const MEMORY_JS_CODE = WIRING.stripJsComments(MEMORY_JS_SOURCE);
let stripperSane = false;
try { stripperSane = WIRING.assertStripperSane(MEMORY_JS_SOURCE, MEMORY_JS_CODE) === true; }
catch (e) { stripperSane = false; }

check('R.activationScannerIsCommentAware',
  stripperSane && MEMORY_JS_CODE.indexOf('function writeOneLineToMemory(') >= 0
  && MEMORY_JS_SOURCE.indexOf('R4A1-ACTIVATION-UI-BYPASS-1 修复') >= 0,
  'the writer scan must strip comments without eating live code '
  + '(the R4-A.2 repair comments quote the removed code verbatim)');

check('R.closedActivationDefectsStayClosed',
  CLOSED_ACTIVATION_DEFECTS.every(defect => defect.forbidden.every(re => !re.test(MEMORY_JS_CODE))),
  'every R4-A.2-closed activation defect must remain absent from the CODE surface: '
  + CLOSED_ACTIVATION_DEFECTS.filter(d => d.forbidden.some(re => re.test(MEMORY_JS_CODE))).map(d => d.id).join(', '));

check('R.closedActivationDefectsKeepTheirRepairMarker',
  CLOSED_ACTIVATION_DEFECTS.every(defect => MEMORY_JS_SOURCE.indexOf(defect.repairMarker) >= 0),
  'each closed defect must keep its repair-marker comment so the change stays reviewable: '
  + CLOSED_ACTIVATION_DEFECTS.filter(d => MEMORY_JS_SOURCE.indexOf(d.repairMarker) < 0).map(d => d.id).join(', '));

check('R.rejectingSeamNowFailsClosedNotMirrorOnly',
  S.canonicalTransportThrow.authorityCalls === 1
  && S.canonicalTransportThrow.mirrorWriteCalls === 0
  && S.canonicalTransportThrow.returned === 0,
  'R4-A.2: with a rejecting seam the caller must fail closed (mirror untouched), not bump the mirror locally');

check('R.mirrorModeUsesHostLocalMirrorOnly',
  S.mirrorMode.authorityCalls === 0 && S.mirrorMode.mirrorWriteCalls === 2 && S.mirrorMode.returned === 2,
  'mirror mode must keep the host-local bump and never call the canonical seam (AUTHORITY §2.5)');

check('R.offModeUsesHostLocalMirrorOnly',
  S.offMode.authorityCalls === 0 && S.offMode.mirrorWriteCalls === 2 && S.offMode.returned === 2,
  'off mode must behave like mirror mode (AUTHORITY §2.5)');

check('R.noAuthorityFallsBackToMirrorWithoutThrowing',
  S.noAuthority.authorityCalls === 0 && S.noAuthority.statusCalls === 0
  && S.noAuthority.mirrorWriteCalls === 2 && S.noAuthority.threw === null,
  'an unavailable authority must degrade to the host-local path and never throw (TURN_FAIL_OPEN)');

check('R.moduleFallbackInstanceIsAccepted',
  S.moduleFallbackInstance.authorityCalls === 1 && S.moduleFallbackInstance.mirrorWriteCalls === 0,
  'window.IBMemoryAuthority must still be accepted when it is instance-shaped');

check('R.authorityWithoutRecordActivationIsTreatedAsAbsent',
  S.authorityWithoutRecordActivation.authorityCalls === 0
  && S.authorityWithoutRecordActivation.mirrorWriteCalls === 2,
  'a mis-shaped authority object must be treated as unavailable rather than half-used');

check('R.mirrorPathWorksWithoutDbUpdate',
  S.mirrorWithoutDbUpdate.mirrorUpdateCalls === 0
  && S.mirrorWithoutDbUpdate.mirrorWriteCalls === 2
  && S.mirrorWithoutDbUpdate.returned === 2,
  'without window.dbUpdate the mirror path must still work through dbGet + dbPut');

check('R.emptySelectionIsANoOp',
  S.emptySelection.mirrorWriteCalls === 0 && S.emptySelection.authorityCalls === 0,
  'an empty selection must not touch the authority or the mirror');

/* ══════════════════════════════════════════════════════════════════════
   §13 · DECISIONS.md（decisions 记录）
   ══════════════════════════════════════════════════════════════════════ */
section('§13 · DECISIONS.md 记录');

const DECISIONS_TEXT = read(DECISIONS);
check('D.recallOrchestrationDecisionRecorded',
  declares(DECISIONS_TEXT, 'P21-R2'),
  'DECISIONS.md must record the P21-R2 decision');
check('D.decisionListsCoreTenets',
  declares(DECISIONS_TEXT, 'Recall Orchestration'),
  'DECISIONS.md must name Recall Orchestration');
check('D.historicalDecisionsNotRewritten',
  DECISIONS_TEXT.indexOf('## D12. 输出解析失败优先修 token 预算') >= 0
  && DECISIONS_TEXT.indexOf('## D14. 已接受的债务') >= 0
  && DECISIONS_TEXT.indexOf('## D15. 曾考虑但放弃/否决的方案') >= 0,
  'D12 / D14 / D15 headings must remain intact (add-only discipline)');
check('D.vectorDecisionsStillIntact',
  DECISIONS_TEXT.indexOf('引入向量库做记忆/动态检索') >= 0,
  'the D15 vector-store rejection row must remain intact');

/* ══════════════════════════════════════════════════════════════════════
   §14 · 生产文件完整性（check 18）
   ══════════════════════════════════════════════════════════════════════ */
section('§14 · Production memory runtime 逐字节完整性（check 18）');

/* 冻结的 production memory runtime 面。R2-A 不允许其中任何一个字节变化。 */
const PRODUCTION_FILES = [
  'assets/js/memory.js',
  'assets/js/memory-contract.js',
  'assets/js/memory-retrieval-core.js',
  'assets/js/memory-visibility-core.js',
  'assets/js/communication.js',
  'assets/js/home-node-bootstrap.js',
  'services/home-node/memory-retrieval.js',
  'services/home-node/memory-store.js',
  /* 超出题面要求的两个：它们同样属于 memory runtime 的权威面，
     R2-A 的"零生产改动"若不覆盖它们就是漏网的越界面。 */
  'assets/js/memory-authority.js',
  'assets/js/memory/auto-memory.js'
];

const currentHashes = {};
PRODUCTION_FILES.forEach(rel => {
  const p = path.join(ROOT, rel);
  assert.ok(fs.existsSync(p), 'production file missing: ' + rel);
  currentHashes[rel] = canonicalTextSha256(fs.readFileSync(p));
});

if (!fs.existsSync(HASH_BASELINE)) {
  fs.mkdirSync(path.dirname(HASH_BASELINE), { recursive: true });
  fs.writeFileSync(HASH_BASELINE, JSON.stringify({
    note: 'P21-R2-A · production memory runtime SHA-256 baseline. '
      + 'Any production change to these files must be an explicit, reviewable update to this file. '
      + 'Written on first run; asserted equal on every later run.',
    files: currentHashes
  }, null, 2) + '\n', 'utf8');
  console.log('  NOTE  hash baseline created at ' + path.relative(ROOT, HASH_BASELINE));
}

const baselineRaw = JSON.parse(fs.readFileSync(HASH_BASELINE, 'utf8'));
const baseline = baselineRaw.files || {};
PRODUCTION_FILES.forEach(rel => {
  check('P18.unchanged.' + rel,
    baseline[rel] === currentHashes[rel],
    'production file changed since the R2-A baseline was recorded: ' + rel
    + '\n        baseline=' + (baseline[rel] || '(absent)')
    + '\n        current =' + currentHashes[rel]);
});
check('P18.baselineCoversSameFileSet',
  Object.keys(baseline).length === PRODUCTION_FILES.length,
  'baseline file set must match the asserted file set');

/* 反向控制：哈希断言必须真的会因内容变化而变红。
   否则一个"比较两个相同对象"的空断言也能让它绿 —— 那种绿色毫无信息量。 */
(function reverseControl() {
  const probe = crypto.createHash('sha256').update('probe-a').digest('hex');
  const probeChanged = crypto.createHash('sha256').update('probe-b').digest('hex');
  check('P18.hashComparisonIsLive', probe !== probeChanged,
    'reverse control: the hash comparison must be capable of failing');
  const real = fs.readFileSync(path.join(ROOT, PRODUCTION_FILES[0]));
  const mutated = Buffer.concat([real, Buffer.from('\n/* probe */')]);
  const mutatedHash = crypto.createHash('sha256').update(mutated).digest('hex').toUpperCase();
  check('P18.appendWouldBeDetected', mutatedHash !== currentHashes[PRODUCTION_FILES[0]],
    'reverse control: appending one line to a production file must change its hash');
})();

/* ══════════════════════════════════════════════════════════════════════
   §15 · 注册（test-all）
   ══════════════════════════════════════════════════════════════════════ */
section('§15 · test-all 注册');

const TEST_ALL = read('tests/test-all.js');
check('T.registeredInTestAll',
  TEST_ALL.indexOf('test_memory_recall_contract.js') >= 0,
  'the new contract test must be registered in tests/test-all.js');
/* 注册必须落在 static 组：本测试是纯 Node、零浏览器、零网络。
   若被放进 service / browser 组，CI 会在没有 Chrome 的环境里跳过一个本可运行的契约测试。
   组边界用真实的 GROUPS 分组名定位（test-all.js 的 `name: 'static' | 'service' | 'browser'`），
   而不是某个人为标记 —— 后者会随着文件被重排而静默失效。 */
(function groupCheck() {
  const entries = TEST_ALL.split('\n');
  const groupOf = [];
  let current = null;
  entries.forEach((line, i) => {
    const m = /^\s{4}name:\s*'([^']+)'/.exec(line);
    if (m) { current = m[1]; return; }
    if (/test_memory_recall_contract\.js/.test(line)) groupOf.push(current);
  });
  check('T.registeredExactlyOnce', groupOf.length === 1,
    'the contract test must be registered exactly once (found ' + groupOf.length + ')');
  check('T.registeredInStaticGroup',
    groupOf.length === 1 && groupOf[0] === 'static',
    'the contract test must be registered in the static group, got: ' + JSON.stringify(groupOf));
})();

/* ══════════════════════════════════════════════════════════════════════
   §16 · Docs truth guard（R2-G1）
   ──────────────────────────────────────────────────────────────────────
   为什么需要：canonical doc 的**状态描述**曾经落后于实现 —— cooldown contract 头部在
   P21-R2-F1b 已闭合之后仍写着 "not implemented / do not cite this as evidence that
   cooldown is live"。这类漂移不会让任何行为测试变红，只会让读者相信一件假事。

   判据只钉**语义 token / 段落局部 marker**，不钉整段原文：
   文档措辞可以自由演进，但不得退回"未实现"的旧状态。
   ══════════════════════════════════════════════════════════════════════ */
section('§16 · Docs truth guard（R2-G1）');

const COOLDOWN_DOC = 'docs/contracts/memory/MEMORY_COOLDOWN_CONTRACT.md';
const COOLDOWN_TRUTH = read(COOLDOWN_DOC);
const CONTRACT_TRUTH = read(CONTRACT);
const ARCH_TRUTH = read(ARCHITECTURE);
/* 只扫**头部状态块**：正文会合法地讨论 FUTURE 条款（durable cooldown / reminisce），
   对全文做 "not implemented" 扫描会产生假阳性。 */
const COOLDOWN_HEADER = COOLDOWN_TRUTH.split('\n').slice(0, 40).join('\n');

check('D1.cooldownHeaderNotUnimplemented',
  !/\bnot implemented\b/i.test(COOLDOWN_HEADER) && !/contract only/i.test(COOLDOWN_HEADER),
  'cooldown contract header must no longer claim "not implemented / contract only"');
check('D2.noRecallSessionStateAbsenceClaim',
  !/No\s+`?RecallSessionState`?\s+exists/i.test(COOLDOWN_TRUTH),
  'cooldown contract must not claim RecallSessionState does not exist');
check('D3.noHardcodedFactorClaim',
  !/still hardcoded|hardcoded to/i.test(COOLDOWN_TRUTH),
  'cooldown contract must not describe trace.cooldownFactor as hardcoded');
check('D4.implementationAnchorPresent',
  COOLDOWN_HEADER.indexOf('2e6f7e9') >= 0 && /\bimplemented\b/i.test(COOLDOWN_HEADER),
  'cooldown contract header must carry an implemented status and the closure-commit anchor');
check('D5.recallContractReferencesCooldownContract',
  CONTRACT_TRUTH.indexOf('MEMORY_COOLDOWN_CONTRACT.md') >= 0,
  'MEMORY_RECALL_CONTRACT must reference the cooldown contract as a current authority');
check('D6.architectureSection52Truthful', (() => {
  /* section-local：只钉 §5.2 这一段，不扫全文 —— 文档别处合法地讨论 R2-A 时点的 chronology
     （"R2-A 时点尚无生产实现的部分"），全文 substring 扫描会把chronology 误判成陈旧声明。 */
  const i = ARCH_TRUTH.indexOf('### 5.2');
  const j = ARCH_TRUTH.indexOf('\n## 6.', i);
  const s52 = (i >= 0 && j > i) ? ARCH_TRUTH.slice(i, j) : '';
  return s52.length > 0
    && s52.indexOf('尚无生产实现') < 0
    && s52.indexOf('已实现') >= 0
    && s52.indexOf('R2-F1b') >= 0;
})(), 'architecture §5.2 must state the implemented status and must not claim "尚无生产实现"');
check('D7.cooldownEnforcementMappingPresent',
  /##\s*26\.\s*Enforcement/.test(COOLDOWN_TRUTH)
  && COOLDOWN_TRUTH.indexOf('Mapping ≠ registry membership') >= 0,
  'cooldown contract must carry an enforcement mapping plus the mapping≠registry clarification');
check('D8.pipelineOrderMatchesImplementation', (() => {
  /* R2-F1a-PIPELINE-DOC-1：§3.1 的顺序必须与实现一致 —— budget(main) → exploration → seat cap。 */
  const i = CONTRACT_TRUTH.indexOf('⑥ budget composition');
  const j = CONTRACT_TRUTH.indexOf('⑦ exploration');
  const k = CONTRACT_TRUTH.indexOf('⑧ seat allocation');
  return i >= 0 && j > i && k > j;
})(), 'recall contract §3.1 must list budget → exploration → seat (implemented order)');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('P21-R2-A MEMORY RECALL CONTRACT FAILED · ' + failures + ' assertion(s), '
    + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('P21-R2-A MEMORY RECALL CONTRACT PASSED · ' + passed + ' assertions green');
}
