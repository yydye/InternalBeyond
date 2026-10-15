'use strict';
/* ====================================================================
   P21-R4-F · Runtime seam guard（**唯一**的 seam 位置权威）
   --------------------------------------------------------------------
   为什么要有这个文件：LIVE-4 的守卫写着"recall 边界里 `behaviorEffect`
   这个词不许出现"。R4-F 把 BehaviorEffect 的**交付通道**按设计放进了
   runtime-recall.js（第 17 键 + 确定性派生 seam）。于是"禁止这个词"这条
   旧守卫必然变红 —— 而它**不能**被删掉、也**不能**被简单放宽成正则白名单：
   一个"允许出现"的正则看不见"第二个 seam""在错误函数里读 holder"
   "在 selector 阶段派生""源回合直接消费"这四类真实缺陷。

   本模块把守卫从"词是否出现"升级为"**精确位置 + 调用关系**"：
     · 装配注入的那一行 dep 必须**恰好一次**，且本文件**不构造**它
       （没有 `createRuntimeBehaviorEffect(`、没有 require、没有读权威、
        没有持有者常量）；
     · `deriveAndHold` 全局**恰好一次**，且必须落在
       `scheduleExpectationFromInterpretation` 的 `runTask` 里，
       紧跟在 `status === 'created'` 之后，并携带
       `interpretationValidated: true` / `interpretation: payload.interpretation`
       / `expectationHeld: true` / `expectation: res`（L3 **且** L5）；
     · `consumeForTurn` 全局**恰好一次**，且必须落在
       `behaviorEffectForEnvelope` 里（交付缝）；
     · 其余 `behaviorEffect` 记号只允许落在 5 个**具名**位置：
       dep 行 · `behaviorEffectForEnvelope` · `failure` · `run` · `describe`；
       任何第 6 个位置都是第二个 seam ⇒ 红；
     · 选择阶段区域（`const messageHash` → `counters.ok += 1;`）与
       `scheduleAutoInterpretation` 体内：`behaviorEffect` 一个都不许有
       （那正是"在 selector 阶段派生 / 源回合直接消费"的形状）；
     · Prediction Error 仍然全面禁止；Counterfactual 仅允许经下方唯一的
       post-K/L/N/O/P 生产 seam 消费；
     · 解释边界（runtime-interpretation.js）四个域**全部**仍然禁止。

   ── Prediction Error P1.5 · 命名归一与 seam taxonomy（治理相位迁移）──────
   迁移前有两个**真实的 governance bypass**：

     ① **拼写绕过**：匹配用 `code.toLowerCase().indexOf(token)`，
        而 token 是连字符形式 `'prediction-error'`。
        ⇒ `predictionError` 归一后是 `predictionerror`，**不含连字符**，不命中。
     ② **token 大小写绕过**：同一个表达式只 lowercase **haystack**、不 lowercase
        **token**。`FORBIDDEN_IN_INTERPRETATION` 里的 `'behaviorEffect'` 含大写，
        在 lowercased haystack 里**永远匹配不到** —— 那条禁令此前是**空转**的。

   迁移后（**TIGHTENING，不是放宽**）：
     `normalizeSemantic()` 把「语言分隔符」统一移除，把「其它标点」变成硬边界，
     于是 `prediction-error` ≡ `predictionError` ≡ `PREDICTION_ERROR` ≡
     `prediction_error` ≡ `prediction.error` ≡ `prediction/error` ≡ `prediction error`
     ⇒ 同一个 semantic token `predictionerror`。
     硬边界保证 `runPrediction(error)` 这类**跨 token 拼接不会误报**。

   同时引入 **definition / wiring 分离**（只凭"字符串出现"判定接线是错的）：
     · DEFINITION_ALLOWED —— contract / PE 纯核心 / 专用测试 / 未来预留模块名；
     · WIRING_FORBIDDEN  —— recall · interpretation · selector · browser 消息流 ·
       prompt 构造 · UI · export · relationship · memory 写路径；
     · 边界内的**只读自述**（如 `predictionErrorLive: 'NO'`）是 LEGITIMATE_METADATA：
       它断言"PE 没有接线"。因此 adoption 采用与 behaviorEffect 相同的纪律 ——
       **具名闭集 + 每名至多一次 + 右侧必须是字面量**；任何其它 PE 形态（任何拼写）
       都是"第二条 seam" ⇒ 红。

   `forgeRecallSeam(src, kind)` 提供 §23 的五个**对抗样本**；
   `forgePredictionErrorSeam(src, kind)` 提供 P1.5 的 **Prediction Error 第二条
   seam** 对抗样本（含 camelCase/分隔符拼写绕过、browser 提交、selector 结算等）。
   守卫必须逐个抓住（`ok === false`）。只有正例通过是不够的 ——
   那证明不了守卫在看什么。
   这些函数是**纯文本**函数：没有 fs、没有网络，输入是源码字符串。
   ==================================================================== */

const { stripJsComments } = require('./activation-wiring-probe.js');

/* 完全禁止的域（任何文件、任何理由）。behaviorEffect **不在这里** ——
   它是本相位获授权的交付通道，但只允许出现在下面那 5 个具名位置。 */
const FORBIDDEN_EVERYWHERE = Object.freeze(['prediction-error']);
const FORBIDDEN_IN_INTERPRETATION = Object.freeze(['expectation', 'behaviorEffect', 'counterfactual', 'prediction-error']);

/* ══════════════════════════════════════════════════════════════════════
   P1.5 · Semantic normalization（唯一匹配入口）
   ══════════════════════════════════════════════════════════════════════
   算法（确定性、无模型、无 NLP）：
     ① lowercase
     ② 移除「语言分隔符」`[\\s\\-_./]+` ⇒ **join**
        （这些是同一个 token 的不同写法，不是边界）
     ③ 其余一切非 `[a-z0-9]` ⇒ 替换为硬边界 `\\u0000` ⇒ **阻断跨 token 拼接**

   性质（由 tests/test_prediction_error_seam_guard.js 独立验证）：
     · `prediction-error` / `predictionError` / `PredictionError` / `PREDICTION_ERROR` /
       `prediction_error` / `prediction.error` / `prediction/error` / `prediction error` /
       `predictionErrorLive` 全部归一到含 `predictionerror` 的串；
     · `runPrediction(error)` **不**命中（`(` 是硬边界）；
     · `predictions.error` **不**命中（`prediction` 后面是 `s`）；
     · 同一 token 在大小写/分隔符上任意混合（`predictionERROR`、`PREDICTION.Error`）也命中。
   ══════════════════════════════════════════════════════════════════════ */
const SEMANTIC_SEPARATORS = /[\s\-_./]+/g;
const SEMANTIC_HARD_BOUNDARY = '\u0000';

function normalizeSemantic(input) {
  return String(input == null ? '' : input)
    .toLowerCase()
    .replace(SEMANTIC_SEPARATORS, '')
    .replace(/[^a-z0-9]/g, SEMANTIC_HARD_BOUNDARY);
}
/* 归一后 token 本身也不得含分隔符/大写（与 haystack 同一套规则）。 */
function semanticToken(token) { return normalizeSemantic(token).split(SEMANTIC_HARD_BOUNDARY).join(''); }

function semanticSitesOf(haystack, token) {
  const text = normalizeSemantic(haystack);
  const needle = semanticToken(token);
  if (!needle) return [];
  const out = [];
  let at = text.indexOf(needle);
  while (at >= 0) { out.push(at); at = text.indexOf(needle, at + 1); }
  return out;
}
function containsSemantic(haystack, token) { return semanticSitesOf(haystack, token).length > 0; }

/* **原始坐标**的语义命中位置。
   不能拿 semanticSitesOf（归一化串坐标）去 lineOf(raw, at)：归一化会改变长度，
   行号会指到无关的行 —— 这是一个真实踩过的坑，故单独提供 span 版。 */
function semanticSpanSites(code, token) {
  const needle = semanticToken(token);
  if (!needle) return [];
  const out = [];
  for (const span of semanticCandidateSpans(code)) {
    if (normalizeSemantic(span.text).indexOf(needle) < 0) continue;
    out.push(span);
  }
  return out;
}

/* ── Prediction Error seam taxonomy（definition allowed vs wiring forbidden）──
   A · DEFINITION_ALLOWED —— 允许出现 PE 语义的**定义/契约/测试**面。
       这些是"把边界写下来"的地方，不是接线。
   B · WIRING_FORBIDDEN —— P2/P3 到达之前，这些面**一个 PE 记号都不许有**
       （唯一例外见 PREDICTION_ERROR_DECLARATION_ALLOWLIST）。
   C · FUTURE_RESERVED_SEAMS —— 已预留名字，允许出现在 contract/test/allowlist，
       **但 P1.5 不创建任何生产接线**。 */
const DEFINITION_ALLOWED_SURFACES = Object.freeze([
  'docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md',
  'docs/contracts/memory/PREDICTION_ERROR_AUTHORITY_CONTRACT.md',
  'assets/js/memory-recall/prediction-observation-core.js',
  'assets/js/memory-recall/outcome-observation-core.js',
  'assets/js/memory-recall/expectation-shadow-core.js',
  'assets/js/memory-recall/counterfactual-shadow-core.js',
  'tests/'
]);
const WIRING_FORBIDDEN_SURFACES = Object.freeze([
  'services/home-node/runtime-recall.js',
  'services/home-node/runtime-interpretation.js',
  'assets/js/communication.js',
  'assets/js/memory.js',
  'assets/js/social.js',
  'assets/js/core.js',
  'services/home-node/memory-store.js',
  'assets/js/role-dm-core.js'
]);
const FUTURE_RESERVED_SEAMS = Object.freeze([
  'runtime-prediction-registry',
  'runtime-prediction-settlement'
]);

/* ── 诚实边界：命名型守卫**不可能**完备 ─────────────────────────────────
   本 guard 的四层都是**命名/词表/位置**判定：
     ① PE 语义记号（任意拼写）· ② PE 能力记号（模块名 / 函数名）
     ③ 结算动词的被调方 + 结算状态**字符串字面量** · ④ 批准 seam 的位置与计数
   一个**任意命名**、既不引用 PE 能力、也不使用结算动词/状态字面量的 helper
   **无法**靠命名发现。更深一层的保护不在这里：
     · 这样的 helper 在 seam 里**没有可消费的对象**（OutcomeObservation 只能在
       Home Node 同实例内构建，且 capstone 不允许跨实例/JSON 重建）；
     · 它**没有可写的权威**（Prediction Error 零 durable 写、零 canonical 写）。
   记录在此，避免把"命名守卫是绿的"误读成"接线不可能存在"。 */
const RESIDUAL_LIMITATIONS = Object.freeze([
  'arbitrarily-named helper that references no PE capability and uses no settlement verb/state literal is not name-detectable',
  'protection then rests on: no consumable OutcomeObservation in the seam, and no writable authority'
]);

/* ── 只读自述的**具名闭集**（LEGITIMATE_METADATA）─────────────────────────
   `predictionErrorLive: 'NO'` 断言"PE 没有接线"，不是接线证据。
   纪律与 behaviorEffect 的 5 个具名位置相同：**闭集名 + 每名至多一次 +
   右侧必须是字面量**。任何其它 PE 形态（任何拼写）都是第二条 seam ⇒ 红。 */
const PREDICTION_ERROR_DECLARATION_ALLOWLIST = Object.freeze([
  'predictionErrorLive', 'predictionErrorCalls', 'predictionErrorBlocker'
]);
/* 右侧允许的字面量形态（属性声明，不是调用）。 */
const PE_LITERAL_RHS = /^\s*:\s*(?:'[^']*'|"[^"]*"|-?\d+|true|false|null)\s*,?\s*$/;

/* ── PE **能力**记号：出现在任何 WIRING_FORBIDDEN 面上都是接线 ───────────── */
const PREDICTION_ERROR_CAPABILITY_TOKENS = Object.freeze([
  'buildOutcomeObservation', 'isBuiltObservation', 'authorityGate', 'validateObservationShape',
  'outcome-observation-core', 'IBMemoryOutcomeObservation',
  'prediction-observation-core', 'IBMemoryPredictionObservation',
  'runtime-prediction-registry', 'runtime-prediction-settlement',
  'createRuntimePredictionRegistry', 'createRuntimePredictionSettlement',
  'createRuntimeOutcomeObservation', 'predictionRegistry', 'predictionSettlement',
  'settlementEngine', 'outcomeObservation'
]);

/* ── 语义候选 span ─────────────────────────────────────────────────────
   把 `a.b` / `a_b` / `a-b` / `a b` / `a/b` 视为**一个**候选名，
   但只在「两侧都是名字字符、且中间只有分隔符」时才合并。
   位置是**原始（已 strip 注释）文本**里的位置 ⇒ 可以直接取所在行做字面量校验。
   （不能拿归一化串去反推标识符：归一化会把所有标点变成硬边界字符，
     那样"标识符"会一路吞掉整个文件。） */
const SEMANTIC_NAME_CHAR = /[A-Za-z0-9_$]/;
const SEMANTIC_SEP_CHAR = /[\s\-_./]/;

function semanticCandidateSpans(code) {
  const isName = (ch) => SEMANTIC_NAME_CHAR.test(ch);
  const isSep = (ch) => SEMANTIC_SEP_CHAR.test(ch);
  const spans = [];
  let i = 0;
  while (i < code.length) {
    if (!isName(code[i])) { i++; continue; }
    let j = i;
    for (;;) {
      let k = j;
      while (k < code.length && isName(code[k])) k++;
      if (k === j) break;
      j = k;
      let s = j;
      while (s < code.length && isSep(code[s])) s++;
      if (s > j && s < code.length && isName(code[s])) { j = s; continue; }
      break;
    }
    spans.push({ start: i, end: j > i ? j : i + 1, text: code.slice(i, j > i ? j : i + 1) });
    i = j > i ? j : i + 1;
  }
  return spans;
}

/* span 内与 semantic token 匹配的**名字片段**；匹配跨片段时返回整段。 */
function matchedIdentifierOf(spanText, token) {
  const needle = semanticToken(token);
  const nSpan = normalizeSemantic(spanText);
  const hit = nSpan.indexOf(needle);
  if (hit < 0) return spanText;
  const re = /[A-Za-z0-9_$]+/g;
  let m;
  while ((m = re.exec(spanText)) !== null) {
    const nPrefix = normalizeSemantic(spanText.slice(0, m.index));
    const nPiece = normalizeSemantic(m[0]);
    if (nPrefix.length <= hit && hit < nPrefix.length + nPiece.length) return m[0];
  }
  return spanText;
}

/* ── Prediction Error 专用审计（definition vs wiring）────────────────────
   rawCode —— **已 strip 注释**的源码。
   允许集为空 ⇒ 该面一个 PE 记号都不许有（解释边界即如此）。 */
function auditPredictionErrorSurface(code, options) {
  const opt = options || {};
  const allow = Array.isArray(opt.declarationAllowlist) ? opt.declarationAllowlist : [];
  /* `grantedTokens` —— 只在**调用方另行做了位置/计数审计**的前提下授予；
     本函数仍然会报告它们出现在哪里（facts.grantedSites），但不再一票否决。 */
  const granted = Array.isArray(opt.grantedTokens) ? opt.grantedTokens : [];
  const reasons = [];
  const facts = { sites: [], capabilityHits: [], grantedSites: [] };

  /* ① 能力记号：任何拼写都不许出现（P2 批准的 registry seam 除外） */
  for (const token of PREDICTION_ERROR_CAPABILITY_TOKENS) {
    const sites = semanticSpanSites(code, token);
    if (!sites.length) continue;
    if (granted.indexOf(token) >= 0) {
      facts.grantedSites.push({ token: token, count: sites.length, lines: sites.map((s) => lineOf(code, s.start)) });
      continue;
    }
    facts.capabilityHits.push(token);
  }
  for (const t of facts.capabilityHits) reasons.push('prediction-error-capability-in-seam:' + t);

  /* ② PE 语义记号：要么是被允许的只读自述字面量，要么是接线 */
  const lineStartOf = (i) => code.lastIndexOf('\n', i) + 1;
  const lineEndOf = (i) => { const e = code.indexOf('\n', i); return e < 0 ? code.length : e; };
  const seen = Object.create(null);
  for (const span of semanticCandidateSpans(code)) {
    if (normalizeSemantic(span.text).indexOf(semanticToken('prediction-error')) < 0) continue;
    const ext = matchedIdentifierOf(span.text, 'prediction-error');
    const lineNo = lineOf(code, span.start);
    facts.sites.push({ line: lineNo, identifier: ext, span: span.text });
    if (allow.indexOf(ext) < 0) {
      reasons.push('prediction-error-wiring-detected:' + (ext || '<anonymous>') + ':line-' + lineNo);
      continue;
    }
    seen[ext] = (seen[ext] || 0) + 1;
    if (seen[ext] > 1) {
      reasons.push('prediction-error-declaration-duplicated:' + ext + ':line-' + lineNo);
      continue;
    }
    /* 右侧必须是字面量 ⇒ 排除 `predictionErrorLive: settle(...)` 这类伪装 */
    const line = code.slice(lineStartOf(span.start), lineEndOf(span.start));
    const rhsAt = line.indexOf(':', line.indexOf(ext) + ext.length);
    const rhs = rhsAt >= 0 ? line.slice(rhsAt) : '';
    if (!PE_LITERAL_RHS.test(rhs)) {
      reasons.push('prediction-error-declaration-not-a-literal:' + ext + ':line-' + lineNo);
    }
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: facts };
}

/* ── browser / prompt 面：PE 与 OutcomeObservation 都不得出现 ───────────── */
/* 浏览器侧**禁止**出现的 matcher 能力记号（P5-B）。 */
const BROWSER_FORBIDDEN_MATCHER_TOKENS = Object.freeze([
  'runtime-evidence-matcher', 'createRuntimeEvidenceMatcher', 'evidenceMatcher',
  'evidence-match-core', 'matchRelation', 'EvidenceMatch',
  'runtime-reality-event', 'createRuntimeRealityEvent', 'realityEvent'
]);

function auditBrowserCognitionBoundary(rawSource, options) {  const opt = options || {};
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const hits = [];
  for (const token of PREDICTION_ERROR_CAPABILITY_TOKENS.concat(['prediction-error'])) {
    if (containsSemantic(code, token)) hits.push(token);
  }
  for (const t of hits) reasons.push('prediction-error-capability-in-browser-boundary:' + t);
  /* P5-B：matcher 能力同样**绝不**允许出现在浏览器侧 */
  for (const token of BROWSER_FORBIDDEN_MATCHER_TOKENS) {
    if (containsSemantic(code, token)) {
      hits.push(token);
      reasons.push('matcher-capability-in-browser-boundary:' + token);
    }
  }
  const coincidental = opt.surface ? (SETTLEMENT_LITERAL_COINCIDENCES[opt.surface] || []) : [];
  const setAudit = auditSettlementSurface(code, { coincidental: coincidental });
  for (const r of setAudit.reasons) reasons.push('browser-boundary:' + r);
  return { ok: reasons.length === 0, reasons: reasons, facts: { hits: hits, settlement: setAudit.facts } };
}

/* ══════════════════════════════════════════════════════════════════════
   P2.0 · Entry gate：把 enforcement 扩到 expectation / behavior-effect
   ══════════════════════════════════════════════════════════════════════
   P1.5 留了一个治理债：这两个文件有**合法 PE metadata**，但没被 seam audit 强制。
   P2 先补这个 gate，**再**写 Registry seam（NO_REGISTRY_RUNTIME_SEAM_BEFORE_P2_0）。

   三类区分：
     LEGITIMATE_METADATA      —— 只读自述（allowlist，字面量，至多一次）
     APPROVED_P2_INTERNAL_SEAM —— registry 的 dep + 唯一调用点（**位置 + 计数**钉死）
     FORBIDDEN_WIRING         —— 其余一切 PE 形态 / 能力记号
   ══════════════════════════════════════════════════════════════════════ */

/* P2 批准的唯一 registry 内部 seam（runtime-expectation.js）。
   它是**可选**的：P2.0 的 gate 必须在 seam 存在**之前**就能通过；
   seam 一旦存在，就必须落在被钉死的位置与计数上。 */
const P2_REGISTRY_SEAM = Object.freeze({
  surface: 'services/home-node/runtime-expectation.js',
  depSignature: 'const predictionRegistry = deps.predictionRegistry || null;',
  probeSignature: "typeof predictionRegistry.projectFromValidatedExpectation === 'function'",
  callSignature: 'predictionRegistry.projectFromValidatedExpectation(',
  callAnchor: "status === 'created'",
  grantedTokens: Object.freeze(['predictionRegistry']),
  maxCallCount: 1
});

/* assembly 面批准的 registry 构造（home-node-service.js） */
const P2_REGISTRY_ASSEMBLY = Object.freeze({
  surface: 'services/home-node-service.js',
  requireSignature: 'runtime-prediction-registry',
  factorySignature: 'createRuntimePredictionRegistry',
  grantedTokens: Object.freeze([
    'runtime-prediction-registry', 'createRuntimePredictionRegistry', 'predictionRegistry'
  ])
});

/* ── P3.0 · Settlement seam：FUTURE_RESERVED_SEAM → APPROVED_P3 ──────────
   `runtime-prediction-settlement` 从"预留名字"变成"**唯一**批准的结算权威面"。
   ★ 它**只**允许出现在两个权威面 + 一个装配面：
       · services/home-node/runtime-prediction-settlement.js（runtime 持有者）
       · assets/js/memory-recall/prediction-settlement-core.js（纯状态机）
       · services/home-node-service.js（**唯一**装配路径）
   ★ 其余一切面（recall / interpretation / expectation / behavior-effect /
     browser / communication / selector / memory-store / relationship）
     **零**结算能力。 */
const P3_SETTLEMENT_AUTHORITY_SURFACES = Object.freeze([
  'services/home-node/runtime-prediction-settlement.js',
  'assets/js/memory-recall/prediction-settlement-core.js'
]);
const P3_SETTLEMENT_ASSEMBLY = Object.freeze({
  surface: 'services/home-node-service.js',
  requireSignature: 'runtime-prediction-settlement',
  factorySignature: 'createRuntimePredictionSettlement',
  grantedTokens: Object.freeze([
    'runtime-prediction-settlement', 'createRuntimePredictionSettlement', 'predictionSettlement'
  ])
});
/* 结算状态机**只**允许在这两个权威面上以字符串字面量出现。 */
const P3_SETTLEMENT_STATE_LITERAL_SURFACES = P3_SETTLEMENT_AUTHORITY_SURFACES;

/* ── P4.0 · Calibration seam：FUTURE_RESERVED_SEAM → APPROVED_P4 ────────
   `runtime-prediction-calibration` 成为"**唯一**批准的校准统计权威面"。
   ★ 只允许：Settlement Engine → Calibration Ledger **一条**消费 seam。
   ★ 两个权威面 + 一个装配面：
       · assets/js/memory-recall/prediction-calibration-core.js（纯计数核心）
       · services/home-node/runtime-prediction-calibration.js（有界持有者）
       · services/home-node-service.js（**唯一**装配路径）
   ★ 其余一切面（recall / interpretation / expectation / behavior-effect /
     browser / communication / memory-store / relationship）**零**校准能力。
   ★ **尤其禁止** Calibration Ledger → Expectation / Interpretation 写回。 */
const P4_CALIBRATION_AUTHORITY_SURFACES = Object.freeze([
  'assets/js/memory-recall/prediction-calibration-core.js',
  'services/home-node/runtime-prediction-calibration.js'
]);
const P4_CALIBRATION_ASSEMBLY = Object.freeze({
  surface: 'services/home-node-service.js',
  requireSignature: 'runtime-prediction-calibration',
  factorySignature: 'createRuntimePredictionCalibration',
  grantedTokens: Object.freeze([
    'runtime-prediction-calibration', 'createRuntimePredictionCalibration',
    'predictionCalibration', 'calibrationLedger'
  ])
});
/* 任何面出现下列**写回**记号都是违规 —— 包括校准权威面自己。 */
const CALIBRATION_WRITEBACK_TOKENS = Object.freeze([
  'applyToExpectation', 'applyCalibration', 'adjustExpectationConfidence', 'adjustInterpretation',
  'updateExpectation', 'updateInterpretation', 'rewritePolicy', 'updatePrompt',
  'writeBackCalibration', 'subjectivePredictionConfidence\\s*=[^=]',
  'interpretation\\.confidence\\s*=[^=]', 'expectation\\.confidence\\s*=[^=]',
  '\\.subjectiveConfidence\\s*=[^=]'
]);

/* ── P5-B · Evidence Matcher seam：FUTURE_RESERVED → APPROVED_P5 ─────────
   **唯一**批准链：Settlement Engine → Evidence Matcher。
   ★ 两个权威面 + 一个装配面：
       · assets/js/memory-recall/evidence-match-core.js（纯 schema/validator）
       · services/home-node/runtime-evidence-matcher.js（唯一 model call 面）
       · services/home-node-service.js（**唯一**装配路径）
   ★ 其余一切面（recall / interpretation / expectation / behavior-effect /
     browser / communication / memory-store / relationship / calibration）
     **零** matcher 能力。 */
const P5_MATCHER_AUTHORITY_SURFACES = Object.freeze([
  'assets/js/memory-recall/evidence-match-core.js',
  'services/home-node/runtime-evidence-matcher.js'
]);
const P5_MATCHER_ASSEMBLY = Object.freeze({
  surface: 'services/home-node-service.js',
  requireSignature: 'runtime-evidence-matcher',
  factorySignature: 'createRuntimeEvidenceMatcher',
  grantedTokens: Object.freeze([
    'runtime-evidence-matcher', 'createRuntimeEvidenceMatcher',
    'evidenceMatcher', 'EvidenceMatch'
  ])
});
/* Matcher 输出里**禁止**出现的词：出现即 schema rejection。 */
const MATCHER_FORBIDDEN_OUTPUT_KEYS = Object.freeze([
  'matched', 'missed', 'mixed', 'expired_unobserved', 'unresolvable', 'superseded',
  'settlementState', 'state', 'lifecycleState', 'predictionError',
  'confirmed', 'contradicted', 'partial',
  'validated', 'settleable', 'calibrationCounted',
  'predictionType', 'targetDomain', 'source', 'sourceInstance',
  'admissibility', 'authorityLevel', 'confidence', 'probability', 'score'
]);

/* Matcher **权威面**的负面清单：不得越界到 memory / relationship /
   calibration / settlement 状态 / durable 写 / UI。 */
function auditMatcherAuthoritySurface(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const facts = { forbiddenPaths: [], settlementAssignment: [], legacyResults: [] };
  const PATTERNS = [
    ['memory-write', /require\([^)]*memory-store|\bputRecord\b|\bdeleteRecord\b/],
    ['memory-authority', /memoryAuthority\s*\./],
    ['relationship-write', /relationDelta|relationshipStore|writeRelationship/],
    ['trust-affinity', /\btrust\s*[-+]?=|\baffinity\s*[-+]?=|\bfamiliarity\s*[-+]?=/],
    ['calibration', /require\([^)]*prediction-calibration|calibrationLedger|ingestSettlement/],
    ['expectation-writeback', /applyToExpectation|updateExpectation|subjectivePredictionConfidence\s*=[^=]/],
    ['durable', /indexedDB|localStorage|sessionStorage|\bwriteFile\b|dbPut|sqlite/i],
    ['vector-store', /embedding|vectorStore|faiss|pinecone/i],
    ['ui-export', /window\s*\.\s*(?:location|localStorage|sessionStorage|document|navigator)|document\s*\.\s*(?:getElementById|querySelector|createElement|body)|exportMemories|createObjectURL/]
  ];
  for (const [name, re] of PATTERNS) if (re.test(code)) facts.forbiddenPaths.push(name);
  for (const t of facts.forbiddenPaths) reasons.push('matcher-authority-surface-forbidden:' + t);

  /* 结算状态**赋值**（把模型输出直接写进结算状态）—— 本轮最关键的一条 */
  for (const state of ['matched', 'missed', 'mixed', 'expired_unobserved', 'unresolvable', 'superseded']) {
    const re = new RegExp('(?:state|settlementState|lifecycleState)\\s*[:=]\\s*[\'"]?' + state + '\\b', 'i');
    if (re.test(code)) {
      facts.settlementAssignment.push(state);
      reasons.push('matcher-may-not-assign-settlement-state:' + state);
    }
  }
  /* legacy D.2 结果词表不得出现在 matcher 权威面。
     唯一豁免：把它们**声明为禁止**的 `FORBIDDEN_OUTPUT_KEYS` 数组字面量。 */
  const declStart = code.indexOf('FORBIDDEN_OUTPUT_KEYS');
  let declRange = null;
  if (declStart >= 0) {
    const open = code.indexOf('[', declStart);
    const close = open >= 0 ? code.indexOf(']', open) : -1;
    if (open >= 0 && close > open) declRange = { start: open, end: close };
  }
  for (const legacy of ['confirmed', 'contradicted', 'partial']) {
    const sites = semanticSpanSites(code, legacy).filter((s) => {
      if (!isQuotedLiteral(code, s)) return false;
      if (declRange && s.start >= declRange.start && s.start <= declRange.end) return false;
      return true;
    });
    if (sites.length) {
      facts.legacyResults.push(legacy);
      reasons.push('legacy-result-in-matcher:' + legacy + ':line-' + lineOf(code, sites[0].start));
    }
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: facts };
}

/**
 * 校验一段（模型）输出**只**含允许的关系词表 —— 供 guard 测试直接调用。
 * 返回 { ok, relation, forbiddenKeys[], reasonCodes[] }。
 */
function auditMatcherOutputShape(raw) {
  const ALLOWED = ['support', 'conflict', 'irrelevant', 'ambiguous'];
  const reasons = [];
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) { return { ok: false, relation: null, forbiddenKeys: [], reasonCodes: ['matcher-invalid-output'] }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, relation: null, forbiddenKeys: [], reasonCodes: ['matcher-invalid-output'] };
  }
  const forbiddenKeys = Object.keys(obj).filter((k) => MATCHER_FORBIDDEN_OUTPUT_KEYS.indexOf(k) >= 0);
  if (forbiddenKeys.length) reasons.push('matcher-forbidden-field');
  const relation = typeof obj.relation === 'string' ? obj.relation : null;
  if (!relation || ALLOWED.indexOf(relation) < 0) reasons.push('matcher-unknown-relation');
  return {
    ok: reasons.length === 0,
    relation: reasons.length === 0 ? relation : 'ambiguous',
    forbiddenKeys: forbiddenKeys,
    reasonCodes: reasons.length ? reasons : ['ok']
  };
}

/* 校准权威面的**负面**清单：不得越界到模型 / memory / relationship /
   Expectation·Interpretation 写回 / durable 写 / UI。 */
function auditCalibrationAuthoritySurface(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const facts = { forbiddenPaths: [], legacyResults: [], writeback: [], globalAccuracy: [] };
  const PATTERNS = [
    ['model-port', /require\([^)]*model-port|modelPort\s*\.|invokeOnce\s*\(/],
    ['provider', /require\([^)]*provider|providerConfig|endpoint/],
    ['credential', /credentialAccess\s*\.|require\([^)]*credential/],
    ['fetch', /\bfetch\s*\(/],
    ['memory-write', /require\([^)]*memory-store|\bputRecord\b|\bdeleteRecord\b|\brewrite\s*\(/],
    ['memory-authority', /memoryAuthority\s*\./],
    ['relationship-write', /relationDelta|relationshipStore|writeRelationship/],
    ['trust-affinity', /\btrust\s*[-+]?=|\baffinity\s*[-+]?=|\bfamiliarity\s*[-+]?=/],
    ['expectation-store', /require\([^)]*expectation-store|expectationShadow\.(?:set|put|write)/],
    ['durable', /indexedDB|localStorage|sessionStorage|\bwriteFile\b|dbPut|sqlite/i],
    ['ui-export', /window\s*\.\s*(?:location|localStorage|sessionStorage|document|navigator)|document\s*\.\s*(?:getElementById|querySelector|createElement|body)|exportMemories|createObjectURL/]
  ];
  for (const [name, re] of PATTERNS) if (re.test(code)) facts.forbiddenPaths.push(name);
  for (const t of facts.forbiddenPaths) reasons.push('calibration-authority-surface-forbidden:' + t);

  /* 写回记号：**任何**一种都违规（CALIBRATION_APPLIED_TO_LIVE = NO） */
  for (const t of CALIBRATION_WRITEBACK_TOKENS) {
    const re = new RegExp(t);
    if (re.test(code)) { facts.writeback.push(t); reasons.push('calibration-writeback-forbidden:' + t); }
  }
  /* legacy D.2 结果词表不得成为 ledger key */
  for (const legacy of ['confirmed', 'contradicted', 'partial', 'ambiguous']) {
    const offending = semanticSpanSites(code, legacy).filter((s) => {
      if (!isQuotedLiteral(code, s)) return false;
      const ls = code.lastIndexOf('\n', s.start) + 1;
      const le = code.indexOf('\n', s.start);
      const line = code.slice(ls, le < 0 ? code.length : le);
      return !/LEGACY_D2_RESULTS\s*=/.test(line);
    });
    if (offending.length) {
      facts.legacyResults.push(legacy);
      reasons.push('legacy-d2-result-as-ledger-key:' + legacy + ':line-' + lineOf(code, offending[0].start));
    }
  }
  /* 禁止可被 authority 消费的全局精度字段。两处豁免：
       ① `FORBIDDEN_ACCURACY_FIELDS = [ ... ]` 的**整个数组字面量**（声明它们非法）
       ② `xxx: 'FORBIDDEN'` 形式的自述（声明"我不产出它"）
     声明它们不合法是合法的；**产出**它们不合法。 */
  const declStart = code.indexOf('FORBIDDEN_ACCURACY_FIELDS');
  let declRange = null;
  if (declStart >= 0) {
    const open = code.indexOf('[', declStart);
    const close = open >= 0 ? code.indexOf(']', open) : -1;
    if (open >= 0 && close > open) declRange = { start: open, end: close };
  }
  for (const name of ['globalAccuracy', 'overallAccuracy', 'predictionAccuracy', 'hitRate', 'successRate']) {
    /* 用**精确标识符边界**匹配，而不是语义子串：
         · `globalAccuracyForbidden`（reason key）后跟字母 ⇒ 不匹配
         · `GLOBAL_ACCURACY`（规则名）大小写不同 ⇒ 不匹配
         · `globalAccuracy: 0.8`（真字段）⇒ 匹配 ⇒ 红
       语义 span 在部分形状下会吞掉关键字（如 `return overallAccuracy`），
       所以这里刻意不用它。 */
    const re = new RegExp('(?<![A-Za-z0-9_])' + name + '(?![A-Za-z0-9_])', 'g');
    let m;
    const offending = [];
    while ((m = re.exec(code)) !== null) {
      const start = m.index, end = start + name.length;
      if (declRange && start >= declRange.start && start <= declRange.end) continue;
      if (/^\s*:\s*'FORBIDDEN'/.test(code.slice(end, end + 24))) continue;
      offending.push({ start: start });
    }
    if (offending.length) {
      facts.globalAccuracy.push(name);
      reasons.push('global-accuracy-field:' + name + ':line-' + lineOf(code, offending[0].start));
    }
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: facts };
}

/* 结算权威面的**负面**清单：不得越界到模型 / memory / relationship /
   calibration 回写 / durable 写 / UI。 */
function auditSettlementAuthoritySurface(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const facts = { forbiddenPaths: [], legacyResults: [] };
  const PATTERNS = [
    ['model-port', /require\([^)]*model-port|modelPort\s*\.|invokeOnce\s*\(/],
    ['provider', /require\([^)]*provider|providerConfig|endpoint/],
    ['credential', /credentialAccess\s*\.|require\([^)]*credential/],
    ['fetch', /\bfetch\s*\(/],
    ['memory-write', /require\([^)]*memory-store|\bputRecord\b|\bdeleteRecord\b|\brewrite\s*\(/],
    ['memory-authority', /memoryAuthority\s*\./],
    ['relationship-write', /relationDelta|relationshipStore|writeRelationship/],
    ['trust-affinity', /\btrust\s*[-+]?=|\baffinity\s*[-+]?=|\bfamiliarity\s*[-+]?=/],
    ['calibration-writeback', /applyCalibration|calibrationConfidence\s*=/],
    ['durable', /indexedDB|localStorage|sessionStorage|\bwriteFile\b|dbPut|sqlite/i],
    /* 精确到**真实 DOM / 导出 API** —— `'window.closed-without-occurrence'`
       是一个已注册词表 token，不是 DOM 引用。 */
    ['ui-export', /window\s*\.\s*(?:location|localStorage|sessionStorage|document|navigator)|document\s*\.\s*(?:getElementById|querySelector|createElement|body)|exportMemories|createObjectURL/]
  ];
  for (const [name, re] of PATTERNS) if (re.test(code)) facts.forbiddenPaths.push(name);
  for (const t of facts.forbiddenPaths) reasons.push('settlement-authority-surface-forbidden:' + t);
  /* legacy 五词表不得**作为结算结果**出现在新引擎里（LEGACY_RESULT_ADAPTER = NONE）。
     唯一豁免：`LEGACY_RESULTS` 的**声明行** —— 声明"我不产出它们"合法，产出它们不合法。 */
  for (const legacy of ['confirmed', 'contradicted', 'partial', 'unsettled']) {
    const offending = semanticSpanSites(code, legacy).filter((s) => {
      if (!isQuotedLiteral(code, s)) return false;
      const ls = code.lastIndexOf('\n', s.start) + 1;
      const le = code.indexOf('\n', s.start);
      const line = code.slice(ls, le < 0 ? code.length : le);
      return !/LEGACY_RESULTS\s*=/.test(line);
    });
    if (offending.length) {
      facts.legacyResults.push(legacy);
      reasons.push('legacy-settlement-result-in-new-engine:' + legacy + ':line-' + lineOf(code, offending[0].start));
    }
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: facts };
}

function lineIndexOf(code, at) { return lineOf(code, at); }
function lineSpanOf(code, at) {
  const start = code.lastIndexOf('\n', at) + 1;
  const endIdx = code.indexOf('\n', at);
  return { start: start, end: endIdx < 0 ? code.length : endIdx, line: lineOf(code, at) };
}

/* 通用「批准 seam」审计：dep 恰好一次 + 调用恰好一次且位于 anchor 之后 +
   被授予的 token **只**允许出现在 dep 行或调用行。 */
function auditApprovedSeam(code, descriptor) {
  const d = descriptor || {};
  const reasons = [];
  const facts = { depCount: 0, callCount: 0, callLine: null, anchorLine: null, grantedLines: {} };
  const dep = String(d.depSignature || '');
  const call = String(d.callSignature || '');
  const anchor = String(d.callAnchor || '');

  const depSites = dep ? occurrences(code, dep) : [];
  const callSites = call ? occurrences(code, call) : [];
  facts.depCount = depSites.length;
  facts.callCount = callSites.length;

  if (depSites.length > 1) reasons.push('p2-seam:dep-signature-count:' + depSites.length);
  if (callSites.length > (d.maxCallCount || 1)) reasons.push('p2-seam:call-count:' + callSites.length);

  if (depSites.length === 0 && callSites.length > 0) {
    reasons.push('p2-seam:call-without-dep');
  }
  if (depSites.length === 1 && callSites.length === 0) {
    reasons.push('p2-seam:dep-without-call');
  }
  if (depSites.length === 1 && callSites.length === 1) {
    const anchorAt = anchor ? code.indexOf(anchor) : -1;
    facts.anchorLine = anchorAt >= 0 ? lineIndexOf(code, anchorAt) : null;
    facts.callLine = lineIndexOf(code, callSites[0]);
    if (anchorAt < 0) reasons.push('p2-seam:anchor-missing:' + anchor);
    else if (callSites[0] < anchorAt) reasons.push('p2-seam:call-before-anchor');

    /* 被授予 token 只允许落在**已批准的行**上：dep 行 / 探针行 / 调用行 */
    const depSpan = lineSpanOf(code, depSites[0]);
    const callSpan = lineSpanOf(code, callSites[0]);
    const probeAt = d.probeSignature ? code.indexOf(d.probeSignature) : -1;
    const probeSpan = probeAt >= 0 ? lineSpanOf(code, probeAt) : null;
    facts.probeLine = probeSpan ? probeSpan.line : null;
    const approvedLines = [depSpan.line, callSpan.line];
    if (probeSpan) approvedLines.push(probeSpan.line);
    for (const token of (d.grantedTokens || [])) {
      const sites = semanticSpanSites(code, token);
      for (const sp of sites) {
        const ln = lineIndexOf(code, sp.start);
        if (approvedLines.indexOf(ln) >= 0) continue;
        reasons.push('p2-seam:granted-token-outside-approved-lines:' + token + ':line-' + ln);
      }
      facts.grantedLines[token] = sites.map((s) => lineIndexOf(code, s.start));
    }
    facts.approvedLines = approvedLines;
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: facts };
}

/* ── 结算面探测（P2.0）──────────────────────────────────────────────────
   两层、都要求**精确**，避免误报：
     ① settle-ish **调用**：取 span 后面紧跟 `(` 时的**被调方**（最后一个名字片段），
        只有被调方名字含 `settle`/`settlement` 且不在 allowlist 里才红。
        ⇒ `settledTurns.set(...)` 的被调方是 `set`，不误报。
     ② 结算**状态字面量**：七个状态词只在以**字符串字面量**出现时才红
        （`'mixed'` 是结算状态；`mixed:` 是 L3 appraisal 的键，合法）。
        `pending` 刻意排除 —— 它已被既有 `status:'pending'` 合法占用。 */
const SETTLE_CALL_ALLOWLIST = Object.freeze([
  /* 既有的测试用 settle 缝（P1.5 已冻结；与 prediction settlement 无关） */
  'settleAutoWaiters', 'settleExpectationWaiters', 'settleWaiters'
]);
const SETTLEMENT_STATE_TOKENS = Object.freeze([
  'matched', 'missed', 'mixed', 'expiredunobserved', 'unresolvable', 'superseded'
]);

function calleeIfCalled(code, span) {
  let i = span.end;
  while (i < code.length && /\s/.test(code[i])) i++;
  if (code[i] !== '(') return null;
  const m = /([A-Za-z0-9_$]+)\s*$/.exec(span.text);
  return m ? m[1] : null;
}
function isQuotedLiteral(code, span) {
  const before = code[span.start - 1];
  const after = code[span.end];
  return (before === "'" && after === "'") || (before === '"' && after === '"');
}

/* 词表**碰撞**登记：这些字符串在既有生产代码里**已经**合法存在，
   与 prediction settlement 无关。逐面登记（不是全局放宽），避免误报。
     · assets/js/home-node-bootstrap.js: `'superseded'` 是 **delivery** 的
       abortQueue reason（delivery-runtime.js 的状态机），不是预测结算状态。 */
const SETTLEMENT_LITERAL_COINCIDENCES = Object.freeze({
  'assets/js/home-node-bootstrap.js': Object.freeze(['superseded'])
});

function auditSettlementSurface(code, options) {
  const opt = options || {};
  const coincidental = Array.isArray(opt.coincidental) ? opt.coincidental : [];
  const reasons = [];
  const facts = { settleCalls: [], stateLiterals: [], coincidentalLiterals: [] };
  for (const span of semanticCandidateSpans(code)) {
    const n = normalizeSemantic(span.text);
    const callee = calleeIfCalled(code, span);
    if (callee) {
      const nc = normalizeSemantic(callee);
      if ((nc.indexOf('settle') >= 0 || nc.indexOf('settlement') >= 0)
        && SETTLE_CALL_ALLOWLIST.indexOf(callee) < 0) {
        facts.settleCalls.push({ callee: callee, line: lineOf(code, span.start) });
        reasons.push('settlement-call-in-seam:' + callee + ':line-' + lineOf(code, span.start));
      }
    }
    for (const st of SETTLEMENT_STATE_TOKENS) {
      if (n.indexOf(st) < 0) continue;
      if (!isQuotedLiteral(code, span)) continue;
      const id = matchedIdentifierOf(span.text, st);
      if (coincidental.indexOf(id) >= 0) {
        facts.coincidentalLiterals.push({ token: id, line: lineOf(code, span.start) });
        continue;
      }
      facts.stateLiterals.push({ token: id, line: lineOf(code, span.start) });
      reasons.push('settlement-state-literal-in-seam:' + id + ':line-' + lineOf(code, span.start));
    }
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: facts };
}

/* expectation 面：合法 metadata 仍允许；registry seam 可选但必须被钉死。 */
function auditExpectationSeam(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const pe = auditPredictionErrorSurface(code, {
    declarationAllowlist: PREDICTION_ERROR_DECLARATION_ALLOWLIST,
    grantedTokens: P2_REGISTRY_SEAM.grantedTokens
  });
  facts_push(reasons, 'expectation', pe.reasons);
  const seam = auditApprovedSeam(code, P2_REGISTRY_SEAM);
  facts_push(reasons, 'expectation', seam.reasons);
  const set = auditSettlementSurface(code);
  facts_push(reasons, 'expectation', set.reasons);
  return {
    ok: reasons.length === 0, reasons: reasons,
    facts: { predictionError: pe.facts, approvedSeam: seam.facts, settlement: set.facts }
  };
}

/* behavior-effect 面：**没有**批准的 registry seam —— 零 PE 能力、零结算。 */
function auditBehaviorEffectSeam(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const pe = auditPredictionErrorSurface(code, {
    declarationAllowlist: PREDICTION_ERROR_DECLARATION_ALLOWLIST
  });
  facts_push(reasons, 'behavior-effect', pe.reasons);
  const set = auditSettlementSurface(code);
  facts_push(reasons, 'behavior-effect', set.reasons);
  return {
    ok: reasons.length === 0, reasons: reasons,
    facts: { predictionError: pe.facts, settlement: set.facts }
  };
}

function facts_push(target, prefix, list) {
  for (const r of (list || [])) target.push(prefix + ':' + r);
  return target;
}

const DEP_LINE_SIGNATURE = 'const behaviorEffect = deps.behaviorEffect || null;';

function regionOf(code, signature, from) {
  const start = code.indexOf(signature, from || 0);
  if (start < 0) return null;
  const open = code.indexOf('{', start + signature.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return { start: start, end: i + 1, text: code.slice(start, i + 1) }; }
  }
  return null;
}
function contains(region, index) { return !!region && index >= region.start && index < region.end; }
function occurrences(haystack, needle) {
  const out = [];
  let at = haystack.indexOf(needle);
  while (at >= 0) { out.push(at); at = haystack.indexOf(needle, at + needle.length); }
  return out;
}
function lineOf(code, index) { return code.slice(0, index).split('\n').length; }

/* ── 对抗样本：把"另一种 seam"写进真实源码里 ─────────────────────────── */
function forgeRecallSeam(source, kind) {
  const src = String(source == null ? '' : source);
  const into = (signature, snippet) => {
    const at = src.indexOf(signature);
    if (at < 0) return null;
    const open = src.indexOf('{', at + signature.length);
    if (open < 0) return null;
    return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
  };
  switch (kind) {
    /* ① 第二个交付 seam：在另一个函数里再消费一次 */
    case 'second-consume-seam':
      return into('function settleAutoWaiters()', 'out.behaviorEffect = behaviorEffect.consumeForTurn({ characterId: characterId, conversationId: conversationId, turnId: turnId });');
    /* ② 在这里**构造** BehaviorEffect（而不是由装配注入） */
    case 'construct-in-recall':
      return into('function createRuntimeRecall(deps)', 'const rogueBehaviorEffect = createRuntimeBehaviorEffect({});');
    /* ③ 在错误的函数里读 holder */
    case 'holder-read-in-wrong-function':
      return into('function settleAutoWaiters()', 'const rogueHeld = behaviorEffect.heldCount(); if (rogueHeld < 0) return;');
    /* ④ 在 Recall selector 阶段派生 */
    case 'derive-in-selector-stage':
      return into('function scheduleAutoInterpretation(ctx)', 'behaviorEffect.deriveAndHold({ characterId: characterId, conversationId: conversationId, turnId: turnId, interpretationValidated: true, expectationHeld: true });');
    /* ⑤ 源回合直接消费自己的效果 */
    case 'consume-in-source-turn':
      return into('function scheduleAutoInterpretation(ctx)', 'behaviorEffect.consumeForTurn({ characterId: characterId, conversationId: conversationId, turnId: turnId });');
    default:
      return null;
  }
}
const FORGERY_KINDS = Object.freeze([
  'second-consume-seam', 'construct-in-recall', 'holder-read-in-wrong-function',
  'derive-in-selector-stage', 'consume-in-source-turn'
]);

/* ══════════════════════════════════════════════════════════════════════
   P1.5 · Prediction Error 第二条 seam 对抗样本
   ══════════════════════════════════════════════════════════════════════
   旧守卫只防"PE 出现在错误文件"，不防"同一个 cognition phase 被偷偷接
   第二条 authority seam"。下面每一类都必须被 auditRecallSeam /
   auditBrowserCognitionBoundary 抓住（`ok === false`）。
   ══════════════════════════════════════════════════════════════════════ */
const PE_FORGERY_KINDS = Object.freeze([
  /* ① recall 响应新增 PE 字段 */
  'pe-field-in-recall-response',
  /* ② selector 阶段提前结算 */
  'selector-stage-settlement',
  /* ③ recall 接受 browser 直接提交的 OutcomeObservation */
  'browser-submits-outcome',
  /* ④ browser 消息流直接调用 settlement */
  'communication-calls-settlement',
  /* ⑤ 第二个 Registry seam */
  'second-registry-seam',
  /* ⑥ 源回合直接消费 outcome */
  'source-turn-outcome-consumption',
  /* ⑦ 绕过 Home Node authority（在 recall 里 require 纯核心并直接调用） */
  'bypass-home-node-authority',
  /* ⑧ 拼写绕过矩阵：同一 semantic token 的各种写法 */
  'spelling-hyphen', 'spelling-camel', 'spelling-pascal', 'spelling-underscore',
  'spelling-dot', 'spelling-slash', 'spelling-space', 'spelling-upper', 'spelling-mixed'
]);

/* 拼写变体 → 一段**看起来合法**的赋值（space/slash 只能落在字符串里） */
const PE_SPELLING_SNIPPETS = Object.freeze({
  'spelling-hyphen': 'out[\'prediction-error\'] = true;',
  'spelling-camel': 'out.predictionError = true;',
  'spelling-pascal': 'out.PredictionError = true;',
  'spelling-underscore': 'out.prediction_error = true;',
  'spelling-dot': 'out.prediction.error = true;',
  'spelling-slash': 'out[\'prediction/error\'] = true;',
  'spelling-space': 'out[\'prediction error\'] = true;',
  'spelling-upper': 'out.PREDICTION_ERROR = true;',
  'spelling-mixed': 'out.predictionERROR = true;'
});

function forgePredictionErrorSeam(source, kind) {
  const src = String(source == null ? '' : source);
  const into = (signature, snippet) => {
    const at = src.indexOf(signature);
    if (at < 0) return null;
    const open = src.indexOf('{', at + signature.length);
    if (open < 0) return null;
    return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
  };
  const append = (snippet) => src + '\n' + snippet + '\n';

  if (Object.prototype.hasOwnProperty.call(PE_SPELLING_SNIPPETS, kind)) {
    return into('function createRuntimeRecall(deps)', PE_SPELLING_SNIPPETS[kind]);
  }
  switch (kind) {
    case 'pe-field-in-recall-response':
      return into('function run(body, options)', 'out.predictionErrorLive = true;');
    case 'selector-stage-settlement':
      return into('function createRuntimeRecall(deps)', 'const predictionSettlement = createRuntimePredictionSettlement({});');
    case 'browser-submits-outcome':
      return into('async function run(body, options)', 'const outcomeObservation = body.outcomeObservation;');
    case 'communication-calls-settlement':
      return append('async function _ibPlacePredictionErrorMessage(messages, settlement) { return messages; }');
    case 'second-registry-seam':
      return into('function createRuntimeRecall(deps)', 'const predictionRegistry = createRuntimePredictionRegistry({});');
    case 'source-turn-outcome-consumption':
      return into('function scheduleAutoInterpretation(ctx)', 'const consumed = outcomeObservation.consumeForTurn({ turnId: turnId });');
    case 'bypass-home-node-authority':
      return into('function createRuntimeRecall(deps)', 'const core = require(\'../../assets/js/memory-recall/outcome-observation-core.js\'); const built = core.buildOutcomeObservation({});');
    default:
      return null;
  }
}

/* ── recall 边界审计 ────────────────────────────────────────────────── */
function auditRecallSeam(rawSource) {
  const raw = String(rawSource == null ? '' : rawSource);
  const code = stripJsComments(raw);
  const reasons = [];
  const facts = { tokenSites: [], regions: {} };

  if (!/function createRuntimeRecall\(deps\)/.test(code)) reasons.push('not-the-recall-boundary');

  /* 1 · 全面禁止的域（**semantic normalization**：任何大小写 / 分隔符拼写都命中）
         `prediction-error` 走 1b 的专用 definition/wiring 审计（它需要区分
         "只读自述"与"接线"，而其余 token 不需要）。 */
  for (const token of FORBIDDEN_EVERYWHERE) {
    if (token === 'prediction-error') continue;
    if (containsSemantic(code, token)) reasons.push('forbidden-domain-in-recall:' + token);
  }
  const counterfactualAudit = auditCounterfactualRecallSeam(code);
  facts.counterfactual = counterfactualAudit.facts;
  for (const reason of counterfactualAudit.reasons) reasons.push('recall:' + reason);
  /* 1b · Prediction Error：白名单只读自述之外的一切 PE 形态 ⇒ 第二条 seam */
  const peAudit = auditPredictionErrorSurface(code, {
    declarationAllowlist: PREDICTION_ERROR_DECLARATION_ALLOWLIST
  });
  facts.predictionError = peAudit.facts;
  for (const r of peAudit.reasons) reasons.push('recall:' + r);
  /* 1c · 结算面：recall 里不得出现 prediction settlement */
  const setAudit = auditSettlementSurface(code);
  facts.settlement = setAudit.facts;
  for (const r of setAudit.reasons) reasons.push('recall:' + r);
  /* 2 · 本文件不得**获得** BehaviorEffect 权威（只能装配注入） */
  if (/createRuntimeBehaviorEffect\s*\(/.test(code)) reasons.push('behavior-effect-constructed-in-recall');
  if (/require\([^)]*runtime-behavior-effect/.test(code)) reasons.push('behavior-effect-required-in-recall');
  if (/MAX_HELD_BEHAVIOR_EFFECTS|HOLDER_TTL_MS/.test(code)) reasons.push('recall-manages-behavior-holder-constants');
  if (/readBehaviorEffect|setBehaviorEffect/.test(code)) reasons.push('recall-reads-behavior-authority');
  if (/\brender(Line)?\s*\(/.test(code)) reasons.push('recall-renders-effect-line');

  /* 3 · dep 行恰好一次 */
  const depSites = occurrences(code, DEP_LINE_SIGNATURE);
  facts.depLineCount = depSites.length;
  if (depSites.length !== 1) reasons.push('behavior-effect-dep-line-count:' + depSites.length);
  const depSpan = depSites.length === 1
    ? { start: depSites[0], end: depSites[0] + DEP_LINE_SIGNATURE.length }
    : null;

  /* 4 · 预期 seam 区域 */
  const envRegion = regionOf(code, 'function behaviorEffectForEnvelope(ctx)');
  const failureRegion = regionOf(code, 'function failure(code, ctx)');
  const runRegion = regionOf(code, 'async function run(body, options)');
  const descRegion = regionOf(code, 'function describe()');
  const schedRegion = regionOf(code, 'function scheduleExpectationFromInterpretation(ctx, binding, interpretationRes)');
  const autoRegion = regionOf(code, 'function scheduleAutoInterpretation(ctx)');
  facts.regions = {
    behaviorEffectForEnvelope: !!envRegion, failure: !!failureRegion, run: !!runRegion,
    describe: !!descRegion, scheduleExpectationFromInterpretation: !!schedRegion,
    scheduleAutoInterpretation: !!autoRegion
  };
  if (!envRegion) reasons.push('missing-delivery-seam:behaviorEffectForEnvelope');
  if (!schedRegion) reasons.push('missing-expectation-seam:scheduleExpectationFromInterpretation');
  if (!runRegion) reasons.push('missing-run');
  if (!descRegion) reasons.push('missing-describe');
  if (!failureRegion) reasons.push('missing-failure');

  /* 5 · 期望 L3 中介的**既有**纪律（LIVE-5 保留项，逐字未放宽） */
  if (!new RegExp('const expectation = deps\\.expectation \\|\\| null;').test(code)) reasons.push('expectation-not-taken-from-assembly');
  if (/createRuntimeExpectation\s*\(/.test(code)) reasons.push('expectation-constructed-in-recall');
  if (/readExpectation|setExpectation/.test(code)) reasons.push('recall-reads-expectation-authority');
  /* ★ 这一条量的是**自动解释调度体内**与期望域的唯一交互（原 LIVE-5 守卫
     的语义），因此必须落在 `scheduleAutoInterpretation` 里 —— 用它自己的
     区域，而不是期望调度函数的区域（后者满篇都是"expectation"，那是它的
     本职，不是耦合证据）。 */
  const schedExpectationLines = autoRegion
    ? autoRegion.text.split('\n').map((s) => s.trim()).filter((s) => /expectation/i.test(s))
    : [];
  facts.schedulerExpectationLines = schedExpectationLines;
  if (!autoRegion || schedExpectationLines.length !== 1 || !/scheduleExpectationFromInterpretation\(/.test(schedExpectationLines[0])) {
    reasons.push('expectation-scheduler-interaction-count:' + schedExpectationLines.length);
  }

  /* 6 · 期望 runTask 区域（`const status = / const runTask =` 两处同名 ⇒ 取 sched 内那一处） */
  let expectationRunTask = null;
  if (schedRegion) {
    const local = regionOf(schedRegion.text, 'const runTask = async () =>');
    if (local) expectationRunTask = { start: schedRegion.start + local.start, end: schedRegion.start + local.end, text: local.text };
  }
  facts.regions.expectationRunTask = !!expectationRunTask;
  if (!expectationRunTask) reasons.push('missing-expectation-runTask');

  /* 7 · derive / consume 的**唯一**调用位置（带括号 = 调用；
     `typeof x.deriveAndHold === 'function'` 那一处探针不算第二次调用）。 */
  const deriveSites = occurrences(code, '.deriveAndHold(');
  const consumeSites = occurrences(code, '.consumeForTurn(');
  facts.deriveSites = deriveSites.map((i) => lineOf(code, i));
  facts.consumeSites = consumeSites.map((i) => lineOf(code, i));
  if (deriveSites.length !== 1) reasons.push('deriveAndHold-call-count:' + deriveSites.length);
  else if (!contains(expectationRunTask, deriveSites[0])) reasons.push('deriveAndHold-outside-expectation-runTask');
  if (consumeSites.length !== 1) reasons.push('consumeForTurn-call-count:' + consumeSites.length);
  else if (!contains(envRegion, consumeSites[0])) reasons.push('consumeForTurn-outside-delivery-seam');

  /* 8 · 派生调用点必须同时携带 L3 与 L5（且只在 status==='created' 之后） */
  if (expectationRunTask && deriveSites.length === 1) {
    const body = expectationRunTask.text;
    const statusAt = body.indexOf("status === 'created'");
    const deriveAt = body.indexOf('.deriveAndHold(');
    const required = [
      'interpretationValidated: true', 'interpretationResult: interpretationRes',
      'expectationHeld: true', 'expectation: res'
    ];
    for (const needle of required) {
      if (body.indexOf(needle) < 0) reasons.push('derive-call-missing:' + needle);
    }
    if (statusAt < 0 || deriveAt < 0 || statusAt > deriveAt) reasons.push('derive-not-guarded-by-created-status');
  }

  /* 9 · behaviorEffect 记号只允许落在 5 个具名位置 */
  for (const at of occurrences(code, 'behaviorEffect')) {
    const site = {
      line: lineOf(code, at),
      inDepLine: !!depSpan && at >= depSpan.start && at < depSpan.end,
      inEnvelopeSeam: contains(envRegion, at),
      inFailure: contains(failureRegion, at),
      inRun: contains(runRegion, at),
      inDescribe: contains(descRegion, at),
      inExpectationRunTask: contains(expectationRunTask, at)
    };
    facts.tokenSites.push(site);
    const allowed = site.inDepLine || site.inEnvelopeSeam || site.inFailure || site.inRun || site.inDescribe || site.inExpectationRunTask;
    if (!allowed) reasons.push('behaviorEffect-outside-authorized-seam:line-' + site.line);
  }

  /* 10 · 选择阶段与自动解释调度体内不得有 behaviorEffect */
  const selStart = code.indexOf('const messageHash');
  const selEnd = code.indexOf('counters.ok += 1;');
  if (selStart >= 0 && selEnd > selStart) {
    const selectionRegion = { start: selStart, end: selEnd };
    for (const at of occurrences(code, 'behaviorEffect')) {
      if (contains(selectionRegion, at)) reasons.push('behaviorEffect-in-selection-stage:line-' + lineOf(code, at));
    }
  } else {
    reasons.push('selection-region-not-found');
  }
  if (autoRegion) {
    for (const at of occurrences(code, 'behaviorEffect')) {
      if (contains(autoRegion, at)) reasons.push('behaviorEffect-in-auto-interpretation-scheduler:line-' + lineOf(code, at));
    }
  }

  /* 11 · describe() 不得消费 / 派生 */
  if (descRegion) {
    if (/consumeForTurn|deriveAndHold/.test(descRegion.text)) reasons.push('describe-consumes-or-derives');
  }

  return { ok: reasons.length === 0, reasons: reasons, facts: facts, codeLength: code.length };
}

/* P21-R4-Q · Counterfactual has one authorized consumer: the post-K/L/N/O/P
   cognition function. This guards callsite location/count, while keeping the
   interpretation boundary and selector stage free of this capability. */
function auditCounterfactualRecallSeam(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const depSignature = 'const counterfactualMemory = deps.counterfactualMemory || null;';
  const depSites = occurrences(code, depSignature);
  const deriveSites = occurrences(code, 'counterfactualMemory.derive(');
  const cognition = regionOf(code, 'async function runCurrentMeaningAndNarrative(ctx)');
  const consumer = regionOf(code, 'async function runCounterfactualMemory(ctx, cognition)');
  const runCallSites = occurrences(code, 'await runCounterfactualMemory(ctx, outcome)');
  const facts = {
    depCount: depSites.length,
    deriveCount: deriveSites.length,
    runCallCount: runCallSites.length,
    cognitionRegion: !!cognition,
    consumerRegion: !!consumer,
    deriveLines: deriveSites.map((at) => lineOf(code, at)),
    runLines: runCallSites.map((at) => lineOf(code, at))
  };
  if (depSites.length !== 1) reasons.push('counterfactual-dependency-count:' + depSites.length);
  if (!cognition || !consumer) reasons.push('counterfactual-cognition-seam-missing');
  if (deriveSites.length !== 1 || !contains(consumer, deriveSites[0])) reasons.push('counterfactual-derive-outside-approved-consumer');
  if (runCallSites.length !== 1 || !contains(cognition, runCallSites[0])) reasons.push('counterfactual-cognition-call-count-or-location-invalid');
  const selectionStart = code.indexOf('const messageHash');
  const selectionEnd = code.indexOf('counters.ok += 1;');
  if (selectionStart >= 0 && selectionEnd > selectionStart
    && code.slice(selectionStart, selectionEnd).indexOf('counterfactual') >= 0) {
    reasons.push('counterfactual-in-selection-stage');
  }
  return { ok: reasons.length === 0, reasons: reasons, facts: facts };
}

/* ── 解释边界审计：四域全禁（措辞未放宽）───────────────────────────── */
function auditInterpretationSeam(rawSource) {
  const code = stripJsComments(String(rawSource == null ? '' : rawSource));
  const reasons = [];
  const hits = [];
  for (const token of FORBIDDEN_IN_INTERPRETATION) {
    if (token === 'prediction-error') continue;   /* 走专用审计（允许集为**空**） */
    if (containsSemantic(code, token)) { reasons.push('forbidden-domain-in-interpretation:' + token); hits.push(token); }
  }
  /* 解释边界：**零** PE 记号、**零** PE 能力 —— 没有任何"只读自述"豁免。 */
  const peAudit = auditPredictionErrorSurface(code, { declarationAllowlist: [] });
  for (const r of peAudit.reasons) reasons.push('interpretation:' + r);
  const setAudit = auditSettlementSurface(code);
  for (const r of setAudit.reasons) reasons.push('interpretation:' + r);
  return {
    ok: reasons.length === 0, reasons: reasons,
    facts: { forbiddenHits: hits, predictionError: peAudit.facts, settlement: setAudit.facts }
  };
}

/* ── P2.0 · expectation / behavior-effect 对抗样本 ─────────────────────── */
const PE_EXPECTATION_FORGERY_KINDS = Object.freeze([
  /* 未批准的结算调用出现在 expectation runtime 里 */
  'expectation-settlement-call',
  /* 第二条 registry seam（第二次 project 调用） */
  'expectation-second-registry-seam',
  /* registry 调用出现在 anchor 之前（提前投影） */
  'expectation-registry-call-before-anchor',
  /* expectation 接受 browser 提交的 outcome observation */
  'expectation-browser-outcome-submission',
  /* 未批准的 PE 字段被塞进 expectation 结果 */
  'expectation-invented-pe-field',
  /* behavior-effect 里出现 registry seam */
  'behavior-effect-registry-seam',
  /* behavior-effect 里出现 settlement 调用 */
  'behavior-effect-settlement-call'
]);

function forgeExpectationPeSeam(source, kind) {
  const src = String(source == null ? '' : source);
  const afterAnchor = (snippet) => {
    const at = src.indexOf("if (status === 'created') {");
    if (at < 0) return null;
    return src.slice(0, at) + snippet + '\n      ' + src.slice(at);
  };
  const into = (signature, snippet) => {
    const at = src.indexOf(signature);
    if (at < 0) return null;
    const open = src.indexOf('{', at + signature.length);
    if (open < 0) return null;
    return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
  };
  switch (kind) {
    case 'expectation-settlement-call':
      return afterAnchor('const settled = settlePredictionFromOutcome({ turnId: turnId });');
    case 'expectation-second-registry-seam':
      return afterAnchor('const rogue = predictionRegistry.projectFromValidatedExpectation({ rogue: true });');
    case 'expectation-registry-call-before-anchor':
      return into('async function runFromValidatedInterpretation(input, opts)',
        'const early = predictionRegistry.projectFromValidatedExpectation({ early: true });');
    case 'expectation-browser-outcome-submission':
      return afterAnchor('const submitted = body.outcomeObservation;');
    case 'expectation-invented-pe-field':
      return afterAnchor('return finish({ predictionErrorState: \'matched\' });');
    case 'behavior-effect-registry-seam':
      return into('function createRuntimeBehaviorEffect(deps)',
        'const predictionRegistry = deps.predictionRegistry || null;');
    case 'behavior-effect-settlement-call':
      return into('function createRuntimeBehaviorEffect(deps)',
        'const settled = settlePredictionFromOutcome({});');
    default:
      return null;
  }
}

/* ── recall 边界的 PE 对抗样本（P1.5 已有的 16 类之外，P2 追加）────────── */
const PE_RECALL_FORGERY_KINDS = Object.freeze([
  'recall-registry-seam',
  'recall-settlement-call',
  'recall-outcome-observation-consumption'
]);

function forgeRecallPeSeam(source, kind) {
  const src = String(source == null ? '' : source);
  const into = (signature, snippet) => {
    const at = src.indexOf(signature);
    if (at < 0) return null;
    const open = src.indexOf('{', at + signature.length);
    if (open < 0) return null;
    return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
  };
  switch (kind) {
    case 'recall-registry-seam':
      return into('function createRuntimeRecall(deps)', 'const predictionRegistry = deps.predictionRegistry || null;');
    case 'recall-settlement-call':
      return into('function createRuntimeRecall(deps)', 'const settled = settlePrediction(predictionId);');
    case 'recall-outcome-observation-consumption':
      /* 现实形状：要"消费 outcome"就必须引用 OutcomeObservation 能力对象本身。
         （诚实边界：一个**任意命名**、既不引用 PE 能力也不用结算动词的 helper
           无法靠命名发现 —— 见 RESIDUAL_LIMITATIONS。） */
      return into('function createRuntimeRecall(deps)', 'const consumed = outcomeObservation.consumeForTurn({ turnId: turnId });');
    default:
      return null;
  }
}

module.exports = {
  auditRecallSeam, auditInterpretationSeam, auditCounterfactualRecallSeam,
  forgeRecallSeam, FORGERY_KINDS,
  FORBIDDEN_EVERYWHERE, FORBIDDEN_IN_INTERPRETATION,
  DEP_LINE_SIGNATURE, regionOf, contains, occurrences, lineOf,

  /* P1.5 · semantic normalization */
  normalizeSemantic, semanticToken, semanticSitesOf, containsSemantic, semanticSpanSites,
  semanticCandidateSpans, matchedIdentifierOf,
  /* P1.5 · seam taxonomy */
  DEFINITION_ALLOWED_SURFACES, WIRING_FORBIDDEN_SURFACES, FUTURE_RESERVED_SEAMS,
  PREDICTION_ERROR_DECLARATION_ALLOWLIST, PREDICTION_ERROR_CAPABILITY_TOKENS,
  auditPredictionErrorSurface, auditBrowserCognitionBoundary,
  /* P1.5 · 第二条 seam 对抗样本 */
  forgePredictionErrorSeam, PE_FORGERY_KINDS, PE_SPELLING_SNIPPETS,

  /* P2.0 · expectation / behavior-effect enforcement */
  auditExpectationSeam, auditBehaviorEffectSeam, auditApprovedSeam, auditSettlementSurface,
  P2_REGISTRY_SEAM, P2_REGISTRY_ASSEMBLY,
  P3_SETTLEMENT_AUTHORITY_SURFACES, P3_SETTLEMENT_ASSEMBLY, P3_SETTLEMENT_STATE_LITERAL_SURFACES,
  auditSettlementAuthoritySurface,
  P4_CALIBRATION_AUTHORITY_SURFACES, P4_CALIBRATION_ASSEMBLY, CALIBRATION_WRITEBACK_TOKENS,
  auditCalibrationAuthoritySurface,
  P5_MATCHER_AUTHORITY_SURFACES, P5_MATCHER_ASSEMBLY, MATCHER_FORBIDDEN_OUTPUT_KEYS,
  auditMatcherAuthoritySurface, auditMatcherOutputShape,
  SETTLE_CALL_ALLOWLIST, SETTLEMENT_STATE_TOKENS, calleeIfCalled, isQuotedLiteral,
  SETTLEMENT_LITERAL_COINCIDENCES,
  RESIDUAL_LIMITATIONS,
  forgeExpectationPeSeam, PE_EXPECTATION_FORGERY_KINDS,
  forgeRecallPeSeam, PE_RECALL_FORGERY_KINDS
};






