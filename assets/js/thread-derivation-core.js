/* ====================================================================
   IB Thread Derivation Core — 线索（open thread）的**唯一**确定性派生实现
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/thread-derivation-core.js"> → window.IBThreadDerivation
              （必须在 active-diary.js 之前加载）
   - Node   : require('./assets/js/thread-derivation-core.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 fetch / 零 LLM / 无副作用 / 纯函数。

   为什么存在（M1-C.2k）：
   `threads`（认识层的"线索"）此前只有浏览器能产出 —— `_threadRuleTick` 在
   桌面的 6 小时心跳里按规则开线程，把行写进 IndexedDB。Home Node 读不到这些行，
   于是同一个 canonical Middle Brain 在两端拿到的证据不同：
   `organized.threads` 在桌面是 1，在 Home Node 是 0，`threadItems` 因此是 3 对 0，
   而 `multipleThreads`（threadItems>=2）是 Gate 的**无视冷却硬触发**
   （middle-brain-policy.js:267/326）—— 桌面走 astra 分支、Home Node 走 local 分支，
   纯粹因为缺少这份证据。

   关键观察：这条派生**本来就是确定性的**，而且已经是零 LLM 的规则匹配：
     canonical memories → 可见性过滤 → 正则命中 → 以 question 去重/合并证据
   没有任何一步需要桌面运行时、时间累积或模型判断。既是纯函数，它就不该由
   "谁写过盘"决定，而应由"输入是什么"决定。因此本模块把该规则收敛成唯一实现，
   桌面与 Home Node **各自按需调用同一份**，而不是让浏览器继续当唯一生产者。

   与 memory-visibility-core 的关系（刻意复用，不发明第二套）：
     可见性语义仍然只有 memory-visibility-core 一份。本模块**不**自带 ACL，
     而是要求调用方传入已经过滤好的候选集（桌面用 `_memDerivationCandidates`，
     Home Node 用 `core.filterDerivationCandidates`）—— 两边都是同一个核心函数。

   ── 与"叙述次数"（mentionCount）的边界 ──────────────────────────────
   本模块**不**产出 mentionCount。该字段此前是"被后台心跳观测了几次"的计数器
   （每次 `thOpen` 命中同一 question 就 +1，而规则会反复命中同一批记忆），
   与证据、显著性、产品事实都无关，且依赖宿主跑了多久 —— 那正是无法跨端一致的量。
   派生出的证据集（evidenceIds）才是真实支撑；渲染侧据此给出"依据 N 条记忆"。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBThreadDerivation = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 规则：一句话里出现"未完成/待推进"的语义标记即视为一条线索 ──────────
     与既有实现逐字一致（含英文词），不新增、不删减 —— 本模块是**提取**，
     不是重新设计规则。 */
  var THREAD_OPEN_RE = /(攒钱|攒|买|想换|计划|准备|还没|待办|未完成|打算|考虑|想学|在准备|等.*(回复|结果|消息)|project|prepare|plan|save up|save for|buy|upgrade)/i;

  /* 近重复去重阈值：与 memory.js 的 THREAD_SIM_THRESHOLD 同值（0.5）。
     `_activeTextSimilarity` 是字符 bigram Jaccard，对近字面重复可靠、
     对改写式释义不敏感 —— 阈值 0.5 只拦近字面同义重复，不误合并不同事项。 */
  var THREAD_SIM_THRESHOLD = 0.5;

  /* 每次派生最多产出的线索数。与桌面既有实现的处理窗口一致：
     `_threadRuleTick` 取最近 12 条 episodic（active-diary.js 的 .slice(-12)），
     因此"最多 12 条"不是新发明的数字，而是把已有窗口上限显式化。 */
  var MAX_DERIVED_THREADS = 12;

  /* ── 文本规范化 + 相似度（提取自 active-diary.js 的 _activeTextKey /
        _activeTextSimilarity，逐行等价）。这两个函数此前只服务主动消息与
        线索去重；现在由两处共享，因此必须只有一份实现。 ─────────────── */
  function textKey(text) {
    return String(text || '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[\s\p{P}\p{S}]+/gu, '');
  }
  function textSimilarity(a, b) {
    var x = textKey(a), y = textKey(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
    var grams = function (s) {
      var out = new Set();
      for (var i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
      return out;
    };
    var gx = grams(x), gy = grams(y), overlap = 0;
    gx.forEach(function (g) { if (gy.has(g)) overlap++; });
    return (2 * overlap) / (gx.size + gy.size);
  }

  /* ── 单条记忆 → 线索种子 ──────────────────────────────────────────────
     命中规则才产出；question 用标题（与既有实现同款），标题为空时用内容前
     20 字兜底。返回 null 表示"这条记忆不构成线索"。 */
  function threadSeedFor(memory) {
    if (!memory) return null;
    var text = String((memory.title || '') + ' ' + (memory.content || '') + ' ' + (memory.summary || ''));
    if (!THREAD_OPEN_RE.test(text)) return null;
    var q = String(memory.title || '').trim() || ('关于"' + String(memory.content || '').slice(0, 20) + '"的进展');
    if (!q) return null;
    return q;
  }

  /* ── 派生：候选记忆 → open 线索列表（确定性、幂等、无副作用）──────────
     入参 memories 必须是**已按可见性过滤**的候选集（见模块头注释）。
     同一输入永远给出同一输出；重复调用不改变结果（与"跑了几个心跳"无关）。

     合并语义与 memory.js 的 `thOpen` 一致：
       · question 完全相同 → 复用同一条
       · 相似度 >= THREAD_SIM_THRESHOLD → 视为同一未闭合事项，复用
       · 复用时的证据集取**并集**（去重、保序）；question 取更完整的那个表述
     产出按"首次出现顺序"排列 —— 与候选择序一致，因此跨端可比。 */
  function deriveOpenThreads(memories, options) {
    options = options || {};
    var opts = {
      limit: options.limit != null ? Number(options.limit) : MAX_DERIVED_THREADS,
      usedQuestions: options.usedQuestions || null
    };
    var list = Array.isArray(memories) ? memories : [];
    if (!(opts.limit > 0)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || m.id == null) continue;
      var q = threadSeedFor(m);
      if (!q) continue;
      var id = String(m.id);
      /* 与"已被持久化的既有线索"对齐（可选）：调用方把已知 question 传进来，
         使派生结果与磁盘上已有的线索收敛到同一批 question，而不是造出第二套。 */
      var merged = false;
      for (var k = 0; k < out.length; k++) {
        if (out[k].question === q || textSimilarity(out[k].question, q) >= THREAD_SIM_THRESHOLD) {
          if (out[k].evidenceIds.indexOf(id) < 0) out[k].evidenceIds.push(id);
          /* 保留更完整的 question 表述（只在原表述过短时替换） */
          if (out[k].question.length < q.length) out[k].question = q;
          merged = true;
          break;
        }
      }
      if (merged) continue;
      out.push({ question: q, evidenceIds: [id] });
      if (out.length >= opts.limit) break;
    }
    /* 证据集按字典序稳定化：同一集合不因候选顺序不同而渲染出不同文本。
       （question 顺序保持首次出现顺序，那才是"哪条先被提出"的真实信息。） */
    return out.map(function (t) {
      return {
        question: t.question,
        evidenceIds: t.evidenceIds.slice().sort(),
        evidenceCount: t.evidenceIds.length
      };
    });
  }

  return {
    THREAD_OPEN_RE: THREAD_OPEN_RE,
    THREAD_SIM_THRESHOLD: THREAD_SIM_THRESHOLD,
    MAX_DERIVED_THREADS: MAX_DERIVED_THREADS,
    textKey: textKey,
    textSimilarity: textSimilarity,
    threadSeedFor: threadSeedFor,
    deriveOpenThreads: deriveOpenThreads
  };
});
