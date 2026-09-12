/* ====================================================================
   IB Home Node · Canonical Memory Retrieval（M1-C.2d Wave 2）
   --------------------------------------------------------------------
   职责：把 Home Node canonical 的 `memories` 变成**一段可直接注入 prompt 的
   运行上下文**，并保持 Wave 1 冻结的契约：

       canonical memories
             ↓   store.listRecords()      ← 完整候选集（不截断）
             ↓   memory-retrieval-core    ← **同一份**实现（可见性先于排名）
             ↓   rendered memory context
             ↓   runtimeContext（与 P0 拼接）
             ↓   execution.buildPrompt → system 尾部
             ↓   provider

   ── 为什么这里没有第二套召回 ──────────────────────────────────────────
   本模块**不**实现任何可见性判断、打分、排序或渲染 —— 那些全部来自
   assets/js/memory-retrieval-core.js（浏览器用同一份文件）。
   本模块只做三件 Node 特有的事：
     ① 从 canonical store 取候选集；
     ② 注入确定性 now / random；
     ③ 把结果与 P0 上下文按**稳定前缀**顺序拼接，并把激活强化交给
        store.recordActivation（不推进 revision）。

   ── 顺序契约（§13.4）─────────────────────────────────────────────────
   system 文本的拼接顺序：
       spec.systemPrompt               ← 最稳定
       P0 身份 / 称呼 / 关系            ← 每角色稳定
       memory block                    ← 每轮变化
       当前时间                        ← 每分钟变化，**必须最后**
   为什么：provider 的 prompt cache 按**前缀**命中。把每轮变化的东西
   （记忆、时间）放在最后，最长的公共前缀才能被缓存。
   P0 上下文里"当前时间"原本排在最前，因此这里显式做顺序调整，
   而不是把 memory 直接 append 到 P0 文本后面。

   ── 失败语义（三条规则刻意不同）──────────────────────────────────────
     召回失败          → 返回空块，回合继续（可用性 fail open）
     激活写入失败      → 只记录，绝不影响回合（排名提示不是事实）
     可见性无法判定    → 不注入任何记忆（暴露 fail closed）
   ==================================================================== */
'use strict';

const MEMORY_RETRIEVAL = require('../../assets/js/memory-retrieval-core.js');
const P0_CONTEXT = require('./p0-context.js');

/* 记忆块在 system 里的分隔说明。刻意**不**重复 P0 的标题 —— 两块上下文
   各有自己的小标题，provider 看到的是两段来源清晰的材料。 */
const MEMORY_HEADER = '【长期记忆】';
const MEMORY_FOOTER = '（以上为长期记忆，是系统参考，不要向对方复述此段。）';

function createMemoryRetrieval(deps) {
  deps = deps || {};
  const store = deps.store || null;
  const clock = deps.clock || (() => Date.now());
  /* 随机源注入：探索窗口需要抽样。默认用 Math.random，但**测试必须注入**
     才能让"同一输入给出同一召回"成为可断言的契约（Wave 1 · §7.5）。 */
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  const logger = deps.logger || (() => {});

  /* ── 纯召回：从 canonical store 取候选集并交给共享核心 ──────────────
     无副作用。selectedIds 供调用方在**之后**做强化。 */
  function retrieve(characterId, options) {
    options = options || {};
    const roleId = String(characterId == null ? '' : characterId);
    if (!store || typeof store.listRecords !== 'function') {
      return { ok: false, error: 'memory-store-unavailable', text: '', selectedIds: [], count: 0 };
    }
    let page;
    try {
      page = store.listRecords({});
    } catch (error) {
      /* 召回失败 → 空块，回合继续。绝不因为存储问题拦住用户这一轮。 */
      logger('memory-retrieve-failed', { error: String((error && error.message) || error) });
      return { ok: false, error: 'memory-read-failed', text: '', selectedIds: [], count: 0 };
    }
    if (!page || !page.ok) {
      return { ok: false, error: (page && page.error) || 'memory-read-failed', text: '', selectedIds: [], count: 0 };
    }
    /* 预算 / contentLen：桌面发布的设置优先，否则用共享缺省。
       两边必须同源，否则同一份 canonical 数据会给出不同召回。 */
    let published = null;
    try {
      const settings = store.getMemorySettings ? store.getMemorySettings() : null;
      published = settings && settings.ok ? settings.settings : null;
    } catch (_) { published = null; }
    const budget = published && published.budget ? published.budget
      : (options.maxChars != null ? Number(options.maxChars) : MEMORY_RETRIEVAL.DEFAULT_BUDGET_CHARS);
    const contentLen = published && published.contentLen ? published.contentLen
      : (options.contentLen != null ? Number(options.contentLen) : MEMORY_RETRIEVAL.DEFAULT_CONTENT_LEN);

    const built = MEMORY_RETRIEVAL.buildMemoryContext(page.records || [], {
      apiId: roleId,
      now: options.now != null ? options.now : clock(),
      random: random,
      userMessage: options.userMessage || '',
      /* 1v1 角色回合：不是群聊，因此 group 分支不参与（与桌面单聊一致）。 */
      isGroup: false,
      groupMemEnabled: false,
      maxChars: budget,
      contentLen: contentLen,
      /* 标题由本模块提供（【长期记忆】）：只要正文行，保证"哪一行怎么渲染"
         仍然出自共享实现，而小节标题是执行缝的决定。 */
      includeHeader: false
    });
    return {
      ok: true,
      text: built.text,
      count: built.count,
      chars: built.chars,
      selectedIds: built.selected.map(s => s.id),
      reason: built.reason,
      candidates: (page.records || []).length
    };
  }

  /* ── 激活强化：独立通道，**不推进 canonical revision** ─────────────
     失败只记账。绝不抛出，绝不阻塞回合。 */
  function reinforce(selectedIds, options) {
    options = options || {};
    const ids = Array.isArray(selectedIds) ? selectedIds : [];
    if (!ids.length) return { ok: true, updated: 0, revisionTouched: false };
    if (!store || typeof store.recordActivation !== 'function') {
      return { ok: false, error: 'memory-store-unavailable', updated: 0, revisionTouched: false };
    }
    try {
      const at = options.at != null ? options.at : clock();
      const res = store.recordActivation(ids, { at: at });
      if (!res || !res.ok) {
        logger('memory-reinforce-failed', { count: ids.length, error: (res && res.error) || 'unknown' });
        return { ok: false, error: (res && res.error) || 'activation-failed', updated: 0, revisionTouched: false };
      }
      return res;
    } catch (error) {
      logger('memory-reinforce-failed', { count: ids.length, error: String((error && error.message) || error) });
      return { ok: false, error: 'activation-failed', updated: 0, revisionTouched: false };
    }
  }

  /* ── 记忆块（无 P0）────────────────────────────────────────────────
     返回 '' 表示"没有可注入的记忆" —— 此时调用方绝不塞空标题。 */
  function buildMemoryBlock(characterId, options) {
    const picked = retrieve(characterId, options);
    /* 失败时把 retrieve 的 error 带成 reason：否则调用方只看到 "没有记忆"，
       而真相可能是"存储读不出来" —— 两者对诊断的含义完全不同
       （前者正常，后者需要修）。刻意不把 reason 覆盖成 null。 */
    if (!picked.ok || !picked.text) return Object.assign({}, picked, { block: '', reason: picked.reason || picked.error || null });
    const body = picked.text.endsWith('\n') ? picked.text : picked.text + '\n';
    const block = MEMORY_HEADER + '\n' + body + MEMORY_FOOTER;
    return Object.assign({}, picked, { block: block });
  }

  /* ── 完整 runtimeContext：P0 + 记忆，按稳定前缀顺序 ─────────────────
     P0 的"当前时间"被**移到最末**（见模块头注释）。
     实现方式：把 P0 的四行文本按行拆开，抽出"当前时间"那一行放到最后 ——
     刻意不重写 P0 模块本身：它仍然是"只渲染四个事实"的窄模块，
     顺序调整是**执行缝**的职责（p0-context.js 的冻结不受影响：
     它没有变成 composer，它只被重新排序拼接）。 */
  function buildRuntimeContext(input) {
    const opts = input || {};
    const character = opts.character || {};
    const characterId = String(opts.characterId || character.id || '');
    let p0Text = '';
    try {
      p0Text = P0_CONTEXT.buildContinuityContext({
        userProfile: opts.userProfile,
        relationship: opts.relationship,
        currentTime: opts.currentTime
      });
    } catch (error) {
      logger('p0-context-failed', { error: String((error && error.message) || error) });
      p0Text = '';
    }
    let memoryBlock = '';
    let picked = { selectedIds: [], ok: false, text: '', count: 0 };
    try {
      picked = buildMemoryBlock(characterId, {
        userMessage: opts.userMessage,
        now: opts.now,
        maxChars: opts.maxChars,
        contentLen: opts.contentLen
      });
      memoryBlock = picked.block || '';
    } catch (error) {
      /* 记忆任何一步坏掉都不阻塞回合（P0 既有纪律）。 */
      logger('memory-context-failed', { error: String((error && error.message) || error) });
      memoryBlock = '';
      picked = { selectedIds: [], ok: false, text: '', count: 0 };
    }
    const ordered = orderP0WithTimeLast(p0Text);
    const parts = [];
    if (ordered.stable) parts.push(ordered.stable);
    if (memoryBlock) parts.push(memoryBlock);
    if (ordered.time) parts.push(ordered.time);
    return {
      runtimeContext: parts.join('\n\n'),
      memoryBlock: memoryBlock,
      selectedIds: Array.isArray(picked.selectedIds) ? picked.selectedIds : [],
      memoryCount: picked.count || 0,
      memoryReason: picked.reason || null,
      p0Stable: ordered.stable,
      p0Time: ordered.time
    };
  }

  /* 把 P0 文本拆成 {stable, time}：时间行（以 '当前时间：' 开头）单独返回。
     其余保持原顺序 —— 只做一次"抽出并后置"，不重排其余事实。 */
  function orderP0WithTimeLast(p0Text) {
    const text = String(p0Text || '');
    if (!text) return { stable: '', time: '' };
    const lines = text.split('\n');
    const stable = [];
    const times = [];
    for (const line of lines) {
      if (line.indexOf('当前时间：') === 0) times.push(line);
      else stable.push(line);
    }
    return { stable: stable.join('\n').trim(), time: times.join('\n').trim() };
  }

  return {
    /* 绑定的 canonical store：**刻意暴露**，只为让装配层能断言"召回器与网关
       看到的是同一个 store"。绑到另一个能开、能查、永远返回空的实例上不会
       抛任何错，只会表现为"她突然什么都不记得"—— 那种 bug 无法从行为反推，
       必须在装配期拦（见 services/home-node-service.js 的 canonicalMemoryDeps）。 */
    store: deps.store || null,
    retrieve: retrieve,
    reinforce: reinforce,
    buildMemoryBlock: buildMemoryBlock,
    buildRuntimeContext: buildRuntimeContext,
    orderP0WithTimeLast: orderP0WithTimeLast,
    MEMORY_HEADER: MEMORY_HEADER,
    MEMORY_FOOTER: MEMORY_FOOTER
  };
}

module.exports = createMemoryRetrieval;
module.exports.MEMORY_HEADER = MEMORY_HEADER;
module.exports.MEMORY_FOOTER = MEMORY_FOOTER;
