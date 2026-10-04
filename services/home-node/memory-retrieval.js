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
/* P21-R2-C：recall 的架构入口。Node 侧 require **同一份** orchestrator
   （浏览器加载的是同一个文件），因此"她记得什么"仍然只有一个实现。
   legacy path 会委托上面那份 core，所以召回结果逐字节不变。
   顶层 require 失败时回落为 null —— fail-open 兼容缝：recall 模块缺失
   绝不能让 Home Node 整轮不可用（见模块头"失败语义"一节）。 */
let MEMORY_RECALL_ORCHESTRATOR = null;
try { MEMORY_RECALL_ORCHESTRATOR = require('../../assets/js/memory-recall/memory-recall-orchestrator.js'); } catch (e) { MEMORY_RECALL_ORCHESTRATOR = null; }
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
  /* P21-R2-F1b：cooldown 的 session authority **由 composition 层注入**，
     与写入方（mobile-gateway settle）必须是同一个实例。
     缺席 ⇒ orchestrator 无 cooldown，行为与 F1a 逐字相同（legacy 兼容）。 */
  const sessionState = deps.sessionState || null;

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

    const buildOpts = {
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
         仍然出自共享实现，而小节标题是执行缝的决定。

         P21-R4-LIVE-3.3 · §5：`includeHeader` 由硬编码 `false` 变成**显式选项**，
         默认仍是 false ⇒ 既有 Host（mobile）行为**逐字节不变**。
         ★ 为什么必须暴露它：桌面 wrapper **省略**这个键 ⇒ core 默认 true ⇒
           header（`【记忆（系统参考，勿提及此段）】\n`）计入 maxChars 预算，
           并在**紧预算**下改变最终 selected set（实测 maxChars=200 时两侧集合不同）。
           因此 header 在当前实现里**不是**纯 presentation —— 它是**选择预算语义
           的一部分**。要让服务端 recall 边界复现桌面的选择，就必须能用同一套预算
           语义（新路由显式传 true）；将来若两侧都改成 ids-only 消费者，再一起改
           false —— 那需要改桌面 wrapper，不属本轮。 */
      includeHeader: options.includeHeader === true,
      /* F1b：只在 visibility/Hard Gate 之后为已 admitted 的候选算 factor；
         turnIndex 来自调用方在 retrieval **之前** begin 的 Home turn（§13/§17）。 */
      sessionState: sessionState,
      turnIndex: options.turnIndex == null ? null : options.turnIndex,
      /* P21-R2-D · 语义切换点：Host 正式传 turn。
         message 来自 buildRuntimeContext 的 ctx.userMessage —— 它在
         mobile-gateway 的 beginTurn 里由**本轮请求体**构造
         （payload.content / payload.message.content），不是历史最后一条、
         不是 assistant 消息、不是 summary。
         刻意**不**沿用上面那行 `|| ''` 的归一化：把"缺输入"变成"空消息"
         会让 orchestrator 静默走 early-exit、从而关掉该 Host 的全部记忆。
         缺输入时保持 undefined，orchestrator 会退回 legacy（见其 ①a fail-safe）。

         P21-R2-E1a · ColdStart 会话信号（**latent**）：
         conversationId / isFirstTurn 由 beginTurn 用 conversation store 探得
         （见 mobile-gateway：探针在当前 user message 落库**之前**执行）。
         本轮 orchestrator **不消费**它们 ⇒ production result 与 R2-D 逐字节相同。
         特别地，这里**不**写 channelHint:'coldStart' —— 那会让通道被提前启用。 */
      turn: {
        message: options.userMessage,
        conversationId: (options.conversationId == null) ? null : String(options.conversationId),
        isFirstTurn: options.isFirstTurn === true,
        conversationSignalAvailable: options.conversationSignalAvailable === true
      },
      /* P21-R4-LIVE-3.3 · §3/§4 · glossary provider seam（wrapper gap A）。
         桌面 wrapper 转发调用方的 `glossaryProvider` / `getGlossaryEntries`
         （assets/js/memory.js:216-217），而本 wrapper 以前**一个都没转发** ⇒
         服务端的 glossary 通道即使被显式要求，也永远拿不到 catalog
         （orchestrator 的 resolveGlossaryCatalog 走到 createEmptyCatalogProvider
         ⇒ available:false），于是同一次 turn 在两侧给出不同的选择。
         这里补上**同样的两个键**：两侧因此共用 orchestrator 里那**同一份**
         resolveGlossaryCatalog + glossary-catalog 工厂，
         **绝不复制 glossary 算法**、绝不另造 catalog 格式。

         ★ authority（§4）：provider **只由服务端装配层注入**（服务端自有的
           条目来源）。本 wrapper **不从 request 取任何 glossary 内容** ——
           entries / matches / forced result / selectedIds 都由新 recall 路由的
           闭集 schema 在更外层拒绝，因此"浏览器提交 glossary 结果"这条路不存在。 */
      glossaryProvider: options.glossaryProvider,
      getGlossaryEntries: options.getGlossaryEntries
    };
    /* P21-R2-C：经 orchestrator（legacy path 委托同一份 core）。
       ★ P21-R4-LIVE-3.2 · 事实性更正（**只改注释，不改行为**）：
         R2-D 起 **turn 已经在这里**（见紧邻上面的 `turn: {...}` 块）⇒ 本 Host 走的是
         **turn 路径**，R2-D/E/F 的 gate（channel / cooldown / seats / exploration）
         全部生效。P21-R2-C 写下"刻意**不**放 turn"时描述的是**接线阶段**的行为，
         那句已被 R2-D 的语义切换取代；留着它会让读者以为桌面/mobile 仍走 legacy。
       orchestrator 缺失时回落到 core 直调（逐行为等价）。 */
    /* P21-R2-E1b · activation policy：只从 meta 取**一个标量**（内部 seam）。
       coldStart = 'none' ⇒ 注入照旧，但**不**强化（见 reinforcementIds）。
       取不到时按 'normal' —— legacy / core 直调路径行为逐字节不变。 */
    let built, activationPolicy = 'normal', boundedDiagnostics = null;
    if (MEMORY_RECALL_ORCHESTRATOR && typeof MEMORY_RECALL_ORCHESTRATOR.recall === 'function') {
      const out = MEMORY_RECALL_ORCHESTRATOR.recall(page.records || [], buildOpts);
      built = out.result;
      if (out.meta && out.meta.activationPolicy === 'none') activationPolicy = 'none';
      /* P21-R4-LIVE-3.3 · §21 · **有界**诊断（显式 opt-in）。
         recall 边界要如实回报"这一轮走了哪个通道、几个候选、预算多少"，
         但 orchestrator 的 trace 里同时带着 `candidates[]`（逐条分数），
         而那正是边界明令**不得**外泄的东西。因此这里只取计数与通道：
         绝不把 trace.candidates 带出去，也绝不带正文。
         ★ 默认关闭（`withTrace !== true` ⇒ 返回对象逐字节不变），
           因此既有调用方与 parity/hash 类断言不受影响。 */
      if (options.withTrace === true) {
        const tr = out.trace || null;
        const meta = out.meta || null;
        const tc = (tr && tr.counts) || null;
        const tb = (tr && tr.budget) || null;
        boundedDiagnostics = {
          mode: meta && meta.mode != null ? meta.mode : null,
          channel: meta && meta.channel != null ? meta.channel : null,
          earlyExit: !!(tr && tr.earlyExit === true),
          earlyExitReason: (tr && tr.earlyExitReason != null) ? tr.earlyExitReason : null,
          counts: {
            input: tc && tc.input != null ? Number(tc.input) : null,
            visible: tc && tc.visible != null ? Number(tc.visible) : null,
            gated: tc && tc.gated != null ? Number(tc.gated) : null,
            selected: tc && tc.selected != null ? Number(tc.selected) : (built && Array.isArray(built.selected) ? built.selected.length : 0)
          },
          budget: {
            maxChars: tb && tb.maxChars != null ? Number(tb.maxChars) : budget,
            usedChars: tb && tb.usedChars != null ? Number(tb.usedChars) : (built && typeof built.chars === 'number' ? built.chars : 0)
          }
        };
      }
    } else {
      built = MEMORY_RETRIEVAL.buildMemoryContext(page.records || [], buildOpts);
    }
    const selectedIds = built.selected.map(s => s.id);
    return {
      ok: true,
      text: built.text,
      count: built.count,
      chars: built.chars,
      selectedIds: selectedIds,
      /* §21：selection 与 reinforcement eligibility **分开**。
         selectedIds 是"真正注入了谁"的事实，绝不因为不强化而被清空；
         reinforcementIds 才是"允许强化谁"（coldStart ⇒ 空）。 */
      reinforcementIds: (activationPolicy === 'none') ? [] : selectedIds.slice(),
      activationPolicy: activationPolicy,
      reason: built.reason,
      candidates: (page.records || []).length,
      /* 只在 `withTrace:true` 时出现；默认**不存在**这个键。 */
      ...(boundedDiagnostics ? { diagnostics: boundedDiagnostics } : {})
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
       （前者正常，后者需要修）。刻意不把 reason 覆盖成 null。
       M1-C.2i：ok / count 一并保留 —— 它们是"本轮是否真的读过记忆"的唯一凭据，
       而 Middle Brain 的 context 快照必须据此区分 empty 与 missing（见 buildRuntimeContext）。 */
    if (!picked.ok || !picked.text) {
      return Object.assign({}, picked, {
        block: '',
        reason: picked.reason || picked.error || null
      });
    }
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
        contentLen: opts.contentLen,
        /* ── P21-R2-F1b · §9 · logical turn index（**必须逐层转发**）────────
           这一层此前只转发上面 6 个 key，于是 orchestrator 永远收到
           turnIndex = undefined ⇒ 所有候选 distance=null ⇒ factor 恒 1
           （cooldown 在 Home Node 上静默失效，而表面上"什么都没报错"）。
           转发而不是在这里计算：cooldown 的唯一实现在 orchestrator + cooldown.js，
           本模块绝不自己生成 factor map。 */
        turnIndex: opts.turnIndex,
        /* P21-R2-E1a · ColdStart 会话信号（latent）：如实透传给 retrieval，
           由它放进 turn 元数据。本轮 orchestrator 不消费 ⇒ 结果不变。 */
        conversationId: opts.conversationId,
        isFirstTurn: opts.isFirstTurn,
        conversationSignalAvailable: opts.conversationSignalAvailable
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
      /* P21-R2-E1b · 强化资格与选择事实**分开**（§21）。
         coldStart 注入 anchors 但**不**强化 —— 自动恢复上下文 ≠ 用户主动想起；
         若强化会形成 coldStart→activation++→memoryValue↑→更易被选中的自强化回路。
         这是**内部** seam：不进入 mobile wire contract。 */
      reinforcementIds: Array.isArray(picked.reinforcementIds)
        ? picked.reinforcementIds
        : (Array.isArray(picked.selectedIds) ? picked.selectedIds : []),
      activationPolicy: (picked.activationPolicy === 'none') ? 'none' : 'normal',
      memoryCount: picked.count || 0,
      memoryReason: picked.reason || null,
      /* M1-C.2i：三个不同的真相必须分开回给调用方，否则 Middle Brain 的快照只能靠
         "记忆块是不是空串"猜，而"已读但为空 / 根本没读成功"的语义会一起塌成 empty：
           consulted=false → 本轮**没有**读过（读取失败 / 没有 store）→ 快照记 missing，
                             允许消费方自行 retrieval；
           consulted=true  → 已读（reason='empty' 也算已读）→ present / empty 由文本决定，
                             **禁止**二次读取（C1 契约）。 */
      memoryConsulted: !!(picked && picked.ok === true),
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
