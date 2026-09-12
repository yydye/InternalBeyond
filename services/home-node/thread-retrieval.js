/* ====================================================================
   IB Home Node · Canonical Thread Retrieval（M1-C.2k）
   --------------------------------------------------------------------
   职责：把 Home Node canonical 的 `memories` 变成**线索（open thread）证据块**，
   并保持与桌面**同一份**派生实现：

       canonical memories
             ↓   store.listRecords()          ← 完整候选集
             ↓   memory-visibility-core       ← 同一份可见性实现（先于规则）
             ↓   thread-derivation-core       ← 同一份规则 / 去重 / 合并实现
             ↓   渲染后的线索块
             ↓   Middle Brain 的 contextSnapshot（thread 字段）
             ↓   organized.threads → 压缩 → 注入

   ── 为什么这里没有第二套线索逻辑 ─────────────────────────────────────
   本模块**不**实现任何可见性判断、规则匹配、相似度去重或合并 —— 那些全部来自
   assets/js/thread-derivation-core.js 与 assets/js/memory-visibility-core.js
   （浏览器用同一批文件，见 InternalBeyond.html 的加载顺序）。
   本模块只做三件 Node 特有的事：
     ① 从 canonical store 取候选集；
     ② 用共享核心过滤可见性（与桌面 `_memDerivationCandidates` 同一函数）；
     ③ 把派生结果交给 Middle Brain 的**已有**快照契约（不新增字段、不改策略）。

   ── 为什么不建 Home Node 的 threads 表 ───────────────────────────────
   线索是 canonical memory 上的**确定性函数**，不需要独立权威：
   同一批 canonical 记忆 → 同一组线索。建表只会引入第二份可漂移的状态，
   并把"谁写过盘"重新变成语义的一部分 —— 那正是 M1-C.2j 判定为错误的 DAG。
   桌面侧同理不再依赖"心跳跑过没有"：两边都按需从同一批记忆派生。

   ── 失败语义（与 memory-retrieval.js 同款纪律）──────────────────────
   派生失败 / 核心不可用 / store 不可读  → 返回**未读过**（consulted:false），
   绝不返回"读过且为空" —— 后者会让 Middle Brain 认为"她确实没有线索"，
   而真相可能是"读不出来"。两者对诊断的含义完全不同。
   ==================================================================== */
'use strict';

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const THREAD_DERIVATION = require(path.join(ASSETS_JS, 'thread-derivation-core.js'));
const VISIBILITY_CORE = require(path.join(ASSETS_JS, 'memory-visibility-core.js'));

/* 线索块的标题与桌面 getThreadContext 的措辞**逐字一致**：
   两端注入的是同一段语义证据，若标题不同就会凭空造出一种宿主差异。 */
const THREAD_HEADER = '【仍在推进的线索（后台参考，勿向对方复述此段的存在）】';

/* 候选窗口：与桌面 `_threadRuleTick` 的处理窗口一致（最近 12 条 episodic）。
   刻意用同一个数字 —— 窗口不同会让"同一批 canonical 记忆"派生出不同线索集。 */
const THREAD_CANDIDATE_WINDOW = 12;

/* 每轮参与渲染的线索条数：与桌面 getThreadContext 的 opts.maxThreads 缺省一致。 */
const THREAD_CONTEXT_MAX = 3;

function createThreadRetrieval(deps) {
  deps = deps || {};
  const store = deps.store || null;
  const logger = deps.logger || (() => {});

  /* 与桌面 `_memNonSemantic` 逐字等价的候选谓词：
     线索只从 episodic（非 semantic / 非 core）记忆里派生 —— 已固化的语义记忆
     不再重新开线索，否则同一件事会被归纳结果反复重新提出。 */
  function nonSemantic(m) {
    return !!m && m.kind !== 'semantic' && m.kind !== 'core';
  }

  /* ── 纯派生：canonical 候选集 → 线索列表（无副作用）─────────────────
     可见性过滤用共享核心的 filterDerivationCandidates —— 与桌面
     `_memDerivationCandidates` 调用的是同一个函数、同一个谓词。 */
  function derive(characterId, options) {
    options = options || {};
    const roleId = String(characterId == null ? '' : characterId);
    if (!store || typeof store.listRecords !== 'function') {
      return { ok: false, error: 'memory-store-unavailable', threads: [], consulted: false };
    }
    let page;
    try {
      page = store.listRecords({});
    } catch (error) {
      logger('thread-retrieve-failed', { error: String((error && error.message) || error) });
      return { ok: false, error: 'memory-read-failed', threads: [], consulted: false };
    }
    if (!page || !page.ok) {
      return { ok: false, error: (page && page.error) || 'memory-read-failed', threads: [], consulted: false };
    }
    try {
      const rows = Array.isArray(page.records) ? page.records : [];
      /* ① 可见性（唯一实现在共享核心；核心不可用 → 空候选，fail closed） */
      const visible = VISIBILITY_CORE.filterDerivationCandidates(rows, roleId, nonSemantic);
      /* ② 最近 N 条（与桌面同一窗口；按 created 升序后取尾部） */
      const window = Number(options.window) > 0 ? Number(options.window) : THREAD_CANDIDATE_WINDOW;
      const recent = visible.slice(-window);
      /* ③ 规则 / 去重 / 合并（同一份实现） */
      const threads = THREAD_DERIVATION.deriveOpenThreads(recent);
      return { ok: true, threads: threads, consulted: true, candidates: rows.length, visible: visible.length };
    } catch (error) {
      logger('thread-derive-failed', { error: String((error && error.message) || error) });
      return { ok: false, error: 'thread-derive-failed', threads: [], consulted: false };
    }
  }

  /* ── 线索块： '' 表示"读过但没有线索"（此时调用方不塞空标题）。 ──────
     渲染形状与桌面 getThreadContext 逐字一致：
         标题
         - <question>（依据 N 条记忆）
     N 取**证据集长度**（而不是已被移除的观测计数）。 */
  function buildThreadBlock(characterId, options) {
    const picked = derive(characterId, options);
    const max = Number(options && options.maxThreads) > 0 ? Number(options.maxThreads) : THREAD_CONTEXT_MAX;
    const list = (picked.threads || []).slice(0, max);
    if (!picked.ok || !list.length) {
      return Object.assign({}, picked, { block: '', reason: picked.error || 'empty' });
    }
    const lines = list.map(t => '- ' + t.question + '（依据 ' + t.evidenceIds.length + ' 条记忆）');
    return Object.assign({}, picked, {
      block: THREAD_HEADER + '\n' + lines.join('\n'),
      reason: null
    });
  }

  /* ── 快照字段：交给 Middle Brain 的 context-snapshot 契约 ────────────
     三态必须与 context-snapshot.js 一致：
        present —— 已读且有内容
        empty   —— 已读但为空（**禁止**消费方二次 retrieval）
        missing —— 本轮未读取 / 派生失败（允许消费方自行 retrieval）
     这里直接返回该字段的构造参数，由调用方用 CS.field 落地 ——
     本模块不持有第二种三态表示。 */
  function snapshotField(characterId, options) {
    const built = buildThreadBlock(characterId, options);
    return {
      text: built.block || '',
      consulted: built.consulted === true,
      gatedBy: built.consulted === true ? null : 'home-node.thread-unavailable',
      count: (built.threads || []).length
    };
  }

  return {
    store: store,
    derive: derive,
    buildThreadBlock: buildThreadBlock,
    snapshotField: snapshotField,
    nonSemantic: nonSemantic,
    THREAD_HEADER: THREAD_HEADER,
    THREAD_CANDIDATE_WINDOW: THREAD_CANDIDATE_WINDOW,
    THREAD_CONTEXT_MAX: THREAD_CONTEXT_MAX
  };
}

module.exports = createThreadRetrieval;
module.exports.THREAD_HEADER = THREAD_HEADER;
module.exports.THREAD_CANDIDATE_WINDOW = THREAD_CANDIDATE_WINDOW;
module.exports.THREAD_CONTEXT_MAX = THREAD_CONTEXT_MAX;
