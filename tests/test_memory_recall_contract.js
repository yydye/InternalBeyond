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
/* 当前生产代码**不允许**出现新 reason —— 它们只能在契约里作为 FUTURE 存在。 */
check('R.newReasonsAreNotYetInProduction',
  RETRIEVAL_TEXT.indexOf("'early-exit'") < 0 && RETRIEVAL_TEXT.indexOf("'gate-rejected'") < 0,
  'R2-A must not have introduced the new reasons into production code yet');

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

/* ── [CURRENT] 事实核对：authority 通道确实存在且确实无人调用 ───────────── */
const AUTHORITY_TEXT = read('assets/js/memory-authority.js');
check('R.authorityActivationChannelExists',
  /function recordActivation\(ids, options\)/.test(AUTHORITY_TEXT),
  'memory-authority must expose a recordActivation channel (the un-wired one)');
const PRODUCTION_JS_DIRS = ['assets/js', 'services', 'bridge'];
const productionCallers = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (text.indexOf('memoryAuthority.recordActivation') >= 0
      || text.indexOf('authority.recordActivation') >= 0) {
      productionCallers.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  }
})(path.join(ROOT, 'assets', 'js'));
check('R.authorityActivationHasNoProductionCaller',
  productionCallers.length === 0,
  'no production file may call the authority activation channel yet (found: ' + productionCallers.join(', ') + ')');
/* 契约明确要求 R2-A 不接线：因此"无人调用"是**本轮期望的现状**，不是缺陷。 */
check('R.desktopActivationUsesDbUpdate',
  /window\.dbUpdate/.test(read('assets/js/memory.js')),
  'desktop activation must still go through dbUpdate (the gap this contract registers)');

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
  currentHashes[rel] = crypto.createHash('sha256')
    .update(fs.readFileSync(p)).digest('hex').toUpperCase();
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

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('P21-R2-A MEMORY RECALL CONTRACT FAILED · ' + failures + ' assertion(s), '
    + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('P21-R2-A MEMORY RECALL CONTRACT PASSED · ' + passed + ' assertions green');
}
