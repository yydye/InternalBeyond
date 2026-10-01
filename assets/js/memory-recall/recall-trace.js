/* ====================================================================
   IB Memory Recall · Trace — runtime-neutral 纯函数（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/recall-trace.js">
              → window.IBMemoryRecallTrace
   - Node   : require('../assets/js/memory-recall/recall-trace.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 零定时器 / 零随机 / 零时钟 / **零日志出口** / 纯函数。

   ── 本模块只做一件事 ────────────────────────────────────────────────
     构造**脱敏的** trace 对象（Contract §13）。

   ── 它明确不做 ──────────────────────────────────────────────────────
     不保存 trace / 不注册 window sink / 不做 UI / 不发 Home Node API /
     不写日志文件 / 不 console.log。Observatory 属于 R2-I。

   ── 隐私纪律（Contract §13.2，本模块的核心价值）──────────────────────
     candidate detail 只能针对 **ACL 已经允许的** 记录。因此：
       · 本模块**只**接受调用方给出的 visible 记录对应的条目的字段；
       · candidate row 的键是**封闭白名单** —— 出现未知键直接抛错，
         而不是静默丢弃。理由：静默丢弃会让"某天有人把整条 record 传进来"
         变成一次无人察觉的泄漏；抛错会让它在测试里立刻可见。
       · 绝不出现：content / summary / title / tags / createdByName /
         source / apiKey / credential / systemPrompt / 原始 memory 对象。

     隐藏记录**不产生任何 candidate row**（连 memoryId 都不出现）——
     只由 counts.input 与 counts.visible 的差值表达。这才符合
     SAFE_PRE_FILTER：隐藏记忆不得影响 trace 的任何细节。

   ── query 的脱敏 ────────────────────────────────────────────────────
     rawText / normalizedText / lexicalText **一律不进 trace**。
     只保留 Contract §13 要求的四类，且各自再收窄：
       lexicalTerms   → 字符串数组
       entities       → 只留 kind / raw / index
       temporalHints  → 只留 kind / raw / index
       aliases        → **不暴露 target**（只留 alias / matched / quoted）
     aliases 的 target 可能包含敏感内容，因此按"最小脱敏表示"处理。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallTrace = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TRACE_VERSION = 1;

  /* candidate row 的**封闭白名单**。多一个键就抛错。 */
  var CANDIDATE_KEYS = [
    'memoryId', 'relevanceScore', 'memoryValue', 'cooldownFactor',
    'finalScore', 'seat', 'decision', 'reasons'
  ];
  var DECISIONS = ['selected', 'rejected'];

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  function num(v) {
    /* nullish **先**判，不能只靠 Number()：
       Number(null) === 0 与 Number(undefined) === NaN 会把"未指定"变成
       一个看似合法的数字（0）—— 那正是"预算 0 字符"这种与事实相反的断言。 */
    if (v == null) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  /* 注意：**不要**再有第二个叫 num 的函数。本文件曾经在 query 脱敏里
     另定义一个 num(v){ String(v); return null }，把这里的数值语义整个盖掉，
     导致 maxChars 被写成字符串 "2000"、未指定时被写成 null→0。
     命名冲突在纯函数模块里不会报错，只会静默改变输出形状 —— 故此处显式记下。 */
  function strOrNull(v) {
    return v == null ? null : String(v);
  }
  function strList(v) {
    return (Array.isArray(v) ? v : []).map(function (x) {
      return (x == null ? '' : String(x));
    }).filter(function (x) { return x.length > 0; });
  }

  /* ── 1. query 脱敏 ─────────────────────────────────────────────────
     **不接受** rawText / normalizedText / lexicalText —— 如果调用方传了一个
     完整 buildRecallQuery 结果进来，这里只挑允许的四个字段，
     其余字段在结构上不可能进入 trace。 */
  function createQueryTrace(query) {
    var q = isPlainObject(query) ? query : {};
    var entities = (Array.isArray(q.entities) ? q.entities : []).map(function (e) {
      var o = isPlainObject(e) ? e : {};
      return { kind: strOrNull(o.kind) || '', raw: strOrNull(o.raw) || '', index: num(o.index) };
    });
    var temporalHints = (Array.isArray(q.temporalHints) ? q.temporalHints : []).map(function (h) {
      var o = isPlainObject(h) ? h : {};
      return { kind: strOrNull(o.kind) || '', raw: strOrNull(o.raw) || '', index: num(o.index) };
    });
    /* aliases：**刻意**只投影这三个字段。target 绝不进入 trace。 */
    var aliases = (Array.isArray(q.aliases) ? q.aliases : []).map(function (a) {
      var o = isPlainObject(a) ? a : {};
      return {
        alias: o.alias == null ? '' : String(o.alias),
        matched: o.matched === true,
        quoted: o.quoted === true
      };
    });
    return {
      lexicalTerms: strList(q.lexicalTerms),
      entities: entities,
      temporalHints: temporalHints,
      aliases: aliases
    };
  }

  /* ── 2. candidate row ──────────────────────────────────────────────
     allowlist：未知键**抛错**（不是静默丢弃）。
     传入整条 memory record 会立刻在这里炸掉 —— 这正是我们想要的失败方式。 */
  function createCandidateEntry(entry) {
    var e = isPlainObject(entry) ? entry : {};
    Object.keys(e).forEach(function (k) {
      if (CANDIDATE_KEYS.indexOf(k) < 0) {
        throw new Error('recall-trace: candidate row key not allowed: ' + k);
      }
    });
    var decision = String(e.decision || '');
    if (DECISIONS.indexOf(decision) < 0) {
      throw new Error('recall-trace: candidate decision must be selected|rejected, got: ' + decision);
    }
    return {
      memoryId: e.memoryId == null ? null : String(e.memoryId),
      relevanceScore: num(e.relevanceScore),
      memoryValue: num(e.memoryValue),
      /* R2-C：cooldown 尚未实现 ⇒ 恒为 1（**不是** 0，也不是"缺失"）。
         不要伪造未来模块已经存在。 */
      cooldownFactor: 1,
      /* finalScore：契约 §13 冻结了这个键，因此**保留字段**，但值当前为 null。
         为什么不留"算出来的"值（P21-R2-C.1）：
           selector 真正用的是 core 的 getMemoryScore × relBoost × fatigue，
           而 fatigue 与 relBoost 在本层都不可观察；本层的 relevanceScore 只是
           Hard Gate 的归一化信号。任何在本层组合出来的数都不是那个分数。
         准确措辞：**not truthfully observable at this layer** ——
         不是 "not implemented"（那会暗示"以后补上就行"，
         而真相是这个数值必须来自唯一 selector，不能在这里重算）。
         只有在能直接从唯一 ranker 取得真实值时，它才应该非 null。 */
      finalScore: e.finalScore == null ? null : num(e.finalScore),
      seat: e.seat == null ? null : String(e.seat),
      decision: decision,
      reasons: strList(e.reasons)
    };
  }

  /* ── 3. 完整 trace ─────────────────────────────────────────────────
     counts 的四个数字由调用方给（orchestrator 在真实流程点上计数），
     本模块只做归一化，不重新推导 —— 否则它会变成第二个"谁被选中"的判断点。 */
  function buildTrace(input) {
    var t = isPlainObject(input) ? input : {};
    var counts = isPlainObject(t.counts) ? t.counts : {};
    var budget = isPlainObject(t.budget) ? t.budget : {};
    var candidates = (Array.isArray(t.candidates) ? t.candidates : []).map(createCandidateEntry);
    return {
      version: TRACE_VERSION,
      channel: t.channel == null ? null : String(t.channel),
      earlyExit: t.earlyExit === true,
      earlyExitReason: t.earlyExitReason == null ? null : String(t.earlyExitReason),
      query: createQueryTrace(t.query),
      counts: {
        input: num(counts.input) || 0,
        visible: num(counts.visible) || 0,
        gated: num(counts.gated) || 0,
        selected: num(counts.selected) || 0
      },
      candidates: candidates,
      budget: {
        /* maxChars 允许为 null（调用方未指定预算）。
           刻意**不**写成 `num(budget.maxChars) || 0` —— 那会把"未指定"
           变成"预算 0 字符"，一个与事实相反的断言。 */
        maxChars: num(budget.maxChars),
        usedChars: num(budget.usedChars) || 0
      },
      reason: t.reason == null ? null : String(t.reason)
    };
  }

  /* ── 4. 便捷构造：无候选的 trace（legacy / early-exit 用）────────── */
  function emptyTrace(channel, reason, counts, budget) {
    return buildTrace({
      channel: channel,
      earlyExit: false,
      earlyExitReason: null,
      query: null,
      counts: counts || { input: 0, visible: 0, gated: 0, selected: 0 },
      candidates: [],
      budget: budget || { maxChars: null, usedChars: 0 },
      reason: reason == null ? null : reason
    });
  }

  /* ── 5. 序列化（测试用来做 secret sentinel 扫描）─────────────────── */
  function traceToJSON(trace) {
    try { return JSON.stringify(trace); } catch (e) { return ''; }
  }

  return {
    TRACE_VERSION: TRACE_VERSION,
    CANDIDATE_KEYS: CANDIDATE_KEYS.slice(),
    DECISIONS: DECISIONS.slice(),
    buildTrace: buildTrace,
    createQueryTrace: createQueryTrace,
    createCandidateEntry: createCandidateEntry,
    emptyTrace: emptyTrace,
    traceToJSON: traceToJSON
  };
});
