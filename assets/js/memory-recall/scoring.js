/* ====================================================================
   IB Memory Recall · Scoring — runtime-neutral 纯函数（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/scoring.js">
              → window.IBMemoryRecallScoring
   - Node   : require('../assets/js/memory-recall/scoring.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 零定时器 / 零随机 / 零时钟 / 纯函数。

   ── 本模块实现 R2-A 冻结的**两个独立概念**（Contract §7）────────────
     memoryValue     —— "这条记忆本身有多值得浮现"（不依赖 query）
     relevanceScore  —— "这条记忆与本轮查询有多相关"（依赖 query）

   ── LegacyMemoryValue ≡ getMemoryScore（**不复制公式**）──────────────
     computeLegacyMemoryValue 直接委托 memory-retrieval-core.getMemoryScore。
     本模块**不**包含四因子公式的第二份实现 —— 那正是 Contract §7.2 与
     R2-A 审计反复强调的"两套她记得什么"的来源。
     MemoryValueV2 属于未来的独立 semantic cutover 阶段，R2-C **不**引入。

   ── relevanceScore 的归一化 ──────────────────────────────────────────
     复用 memory-retrieval-core.calcRelevance（不新造第二套 lexical 算法）：
         calcRelevance → relBoost ∈ [1, 2.5]      （1 + ratio × 1.5）
     归一化到 [0, 1]：
         relevanceScore = clamp((relBoost - 1) / 1.5, 0, 1)
     ⇒  relBoost 1.0 → 0      无 lexical 命中
         relBoost 2.5 → 1      全命中
     这使 Hard Gate 有一个**不需要魔法阈值**的判据：score > 0。

     lexicalTerms 为空时 relevanceScore = 0 —— 刻意**不**沿用"没有词 →
     relevance 1"的旧语义（Contract §6.3：score 必须能表达"没有任何相关证据"）。
     注意：core.calcRelevance(mem, []) 返回 1（即 relBoost 1.0），经上面的
     归一化后正好是 0，因此两种路径自然一致，无需特判分支。

   ── R2-C 刻意不做的事 ────────────────────────────────────────────────
     不加入 entityBoost / temporalBoost / aliasBoost / exactBoost /
     tagBoost。R2-C 的目标是**建立 Hard Gate**，不是一次性设计最终
     relevance 模型。这些属于后续阶段。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var core = null;
    try { core = require('../memory-retrieval-core.js'); } catch (e) { core = null; }
    module.exports = factory(core);
  } else {
    root.IBMemoryRecallScoring = factory(root.IBMemoryRetrievalCore || null);
  }
})(typeof self !== 'undefined' ? self : this, function (CORE) {
  'use strict';

  /* calcRelevance 的最大加成：relBoost = 1 + ratio × 1.5 ⇒ 上限 2.5。
     这个 1.5 是 core 的既有常量（其函数体内字面量）。这里只是把归一化的
     分母写清楚；它**不是**可调参数，改了它就不再是"core 的归一化"。 */
  var RELEVANCE_BOOST_RANGE = 1.5;

  function clamp01(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v;
  }

  function coreAvailable() {
    return !!(CORE && typeof CORE.getMemoryScore === 'function'
      && typeof CORE.calcRelevance === 'function');
  }

  /* ── memoryValue：LegacyMemoryValue（兼容定义，逐行为等于 core）────── */
  function computeLegacyMemoryValue(memory, now) {
    if (!CORE || typeof CORE.getMemoryScore !== 'function') return 0;
    return CORE.getMemoryScore(memory, now);
  }

  /* ── relevanceScore：core.calcRelevance 的归一化 ─────────────────── */
  function scoreRelevance(memory, query) {
    var q = query || {};
    var terms = Array.isArray(q.lexicalTerms) ? q.lexicalTerms : [];
    var meta = {
      lexicalScore: 0,
      lexicalTermsPresent: terms.length > 0,
      lexicalMatch: false,
      lexicalBoost: 1,
      coreAvailable: coreAvailable()
    };
    if (!memory || !meta.coreAvailable) {
      return { score: 0, signals: meta };
    }
    var boost;
    try {
      boost = CORE.calcRelevance(memory, terms);
    } catch (e) {
      /* 判定自身抛错 ⇒ 视为"没有相关证据"（fail closed 到 0，绝不放行）。 */
      return { score: 0, signals: meta };
    }
    if (!isFinite(boost)) boost = 1;
    meta.lexicalBoost = boost;
    var score = clamp01((boost - 1) / RELEVANCE_BOOST_RANGE);
    meta.lexicalScore = score;
    meta.lexicalMatch = score > 0;
    return { score: score, signals: meta };
  }

  /* ── Hard Gate（R2-C 第一版，唯一判据）─────────────────────────────
     Contract §6.3：score === 0 的候选不得通过 gate。
     刻意**不**加任何未经校准的阈值（0.1 / 0.25 / 0.5），
     也刻意**不**对 pinned 特判绕过 —— Contract 已冻结"score === 0 不得过 gate"。 */
  function passesHardGate(relevance) {
    var r = relevance || {};
    var score = Number(r.score);
    if (!isFinite(score)) return false;
    return score > 0;
  }

  return {
    computeLegacyMemoryValue: computeLegacyMemoryValue,
    scoreRelevance: scoreRelevance,
    passesHardGate: passesHardGate,
    RELEVANCE_BOOST_RANGE: RELEVANCE_BOOST_RANGE,
    coreAvailable: coreAvailable
  };
});
