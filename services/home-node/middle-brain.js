/* ====================================================================
   IB Home Node · Middle Brain 宿主适配层（M1-C.2i）
   --------------------------------------------------------------------
   本文件是 Home Node 进入 **canonical Middle Brain 执行缝** 的唯一入口。
   它**不含任何判定**：readiness、Admission Gate、组织/压缩、Judge、Character
   Integrity 全部来自 assets/js 下那五个层 + facade，与桌面**同一份实现**。

   它只做三件宿主特有的事（其余一概不做）：
     ① 把浏览器里的全局形态补上（facade 结尾是一串 `window.x = …`），
        然后把五个层与 facade require 进来；
     ② **注入配置**：canonical config 层经一个具名读取器取"执行策略是什么"；
        浏览器读 IndexedDB，这里读桌面发布过来的执行配置投影；
     ③ **注入本轮上下文**：桌面把四个 producer 的已读结果交进来，
        Home Node 交的是自己 canonical 的 memory + 本轮 dialogue。

   ── 为什么不是"再写一份 Node 版 Middle Brain" ─────────────────────────
   同一个角色在桌面与在手机上必须是**同一个认知层**。若 Node 侧另写一套
   "看起来一样"的 readiness / Gate / 压缩，两端就会对同一段历史给出不同的
   上下文与思考深度 —— 那不是收敛，是把漂移藏起来。所以这里宁可 require
   浏览器那份文件，也不复制一行策略。

   ── 凭据边界（硬约束，已由构造保证而非纪律保证）──────────────────────
   配置对象由 `getMiddleBrainConfig()` **构造式**产生：默认值 + 已发布的投影。
   投影（middle-brain-config-core.projectExecutionConfig）里根本**没有**
   apiKey / endpoint / model 三个键，因此本模块拿到的配置恒为：
       apiKey: ''  → canonical 的 API 就绪谓词恒 false
                   → Admission Gate 恒 astra_not_ready → 走本地 pipeline
                   → 任何 Astra/Judge/Integrity 的网络调用在**发起之前**就被挡住
   也就是说：**Home Node 永远不持有 Middle Brain 凭据，也不需要**。桌面发布的
   是策略，不是能力。这一条有专门的回归测试（mb-node.secretsNeverReachable）。

   ── 失败语义（与桌面逐条对齐，不发明新的）────────────────────────────
   未启用 / 配置不可读  → 执行缝返回 null（source='bypass'），调用方保留原始上下文
   任何层抛错           → 本模块捕获，按"未参与"处理，**绝不**让回合失败
   Middle Brain 是认知增强层，不是聊天单点故障。
   ==================================================================== */
'use strict';

const path = require('path');

/* 仓库根（services/home-node/ → ../..）。用 __dirname 而不是 cwd：
   Home Node 可能以任意工作目录被拉起（安装器 / 测试 / 本地服务运行器）。 */
const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');

/* 五个层的加载顺序是硬 DAG（facade 在模块体里就索引五个契约）：
   config → policy → astra → judge → integrity → facade
   config 与其余四层的**发布形状不同**，这一点必须显式处理：
     · policy / astra / judge / integrity 写 `root.IB.__middleBrainContracts[k]`（Node 下 root=globalThis）
     · config 走双载形状，Node 下把契约**交回给 require 调用方**（不写 global）
   因此这里先 require config，再把它的契约登记进共享契约对象，其余层才看得到上游。 */
const CONFIG_FILE = 'middle-brain-config.js';
const LAYER_FILES = [
  'middle-brain-policy.js',
  'middle-brain-astra.js',
  'middle-brain-judge.js',
  'middle-brain-integrity.js'
];
const FACADE_FILE = 'middle-brain.js';

/* 「策略已发布」哨兵：填在 endpoint / model 上，只为满足上游"启用即可说出去处"的
   不变量（详见 getConfig() 的说明）。它不是地址 —— 没有任何路径会用它发请求，
   真正的闸门是 apiKey 恒空。值本身写死成一句话，任何日志/诊断里一眼可辨。 */
const PUBLISHED_POLICY_SENTINEL = 'published-by-desktop';

/* dialogue 投影上限。
   桌面把 tail 挂在末条 user 消息上，Home Node 把上下文放在 system 里 —— 这是
   **已知的宿主差异**，不假装一致。但"哪些话算当前对话"这条语义必须一致，
   否则 Gate 的两条硬触发（multipleThreads / nearBudget）会在两端给出不同判定。
   上限取自 integrity 层 _ciHistory 同一量级（短上下文），而不是新发明的数字。 */
const DIALOGUE_MAX_MESSAGES = 8;
const DIALOGUE_MAX_CHARS = 400;

/* ── 模块级加载（进程内一次）──────────────────────────────────────────
   facade 末尾是 43 条 `window.x = …`，在 Node 里会 ReferenceError。
   这不是"浏览器耦合"，而是**兼容代理**：它的 canonical 形态 root.IB 在 Node 里
   本来就成立（wrapper 是 `typeof self!=='undefined' ? self : globalThis`）。
   所以补一个最小别名就够，不需要改任何中间层源码。

   代价说清楚：这会在进程里留下 globalThis.window / globalThis.providers 两个别名。
   它们在浏览器里本来就是同一个全局对象，在 Node 里只被这六个文件使用；
   这是双载（DML）之外唯一需要的宿主 shim，没有第二个。 */
let _cache = null;

function loadCanonicalMiddleBrain() {
  if (_cache) return _cache;
  const created = [];
  if (typeof globalThis.window === 'undefined') { globalThis.window = globalThis; created.push('window'); }
  /* provider-directory 在浏览器里由 <script> 挂到 root.PROVIDERS_DIR；
     config-core 与 astra.js 都经它取权威能力表（唯一真源，不复制第二份）。 */
  if (!globalThis.PROVIDERS_DIR) {
    globalThis.PROVIDERS_DIR = require(path.join(ASSETS_JS, 'provider-directory.js'));
    created.push('providers');
  }
  /* config-core 是 UMD：浏览器里它把自己挂成 root.IBMiddleBrainConfigCore，
     Node 里只赋 module.exports（**不挂 global**）。浏览器版的 middle-brain-config.js
     两边都要能拿到它 —— 它在 Node 下走 require 拿到同一份模块实例，
     但为了形状与浏览器一致，这里也把全局别名补上（幂等，同一次 require 缓存）。 */
  if (!globalThis.IBMiddleBrainConfigCore) {
    globalThis.IBMiddleBrainConfigCore = require(path.join(ASSETS_JS, 'middle-brain-config-core.js'));
    created.push('config-core');
  }
  /* config 层：先把契约拿到手，再登记进共享契约对象（顺序不能反）。 */
  const configContract = require(path.join(ASSETS_JS, CONFIG_FILE));
  globalThis.IB = globalThis.IB || {};
  const contracts = globalThis.IB.__middleBrainContracts = globalThis.IB.__middleBrainContracts || {};
  contracts.config = (configContract && configContract.config) || contracts.config;
  if (!contracts.config) throw new Error('middle-brain config contract unavailable');
  for (const file of LAYER_FILES) require(path.join(ASSETS_JS, file));
  for (const layer of ['policy', 'astra', 'judge', 'integrity']) {
    if (!contracts[layer]) throw new Error('middle-brain layer contract unavailable: ' + layer);
  }
  /* facade 需要 IBModelCore 作为 Astra 适配器（buildMiddleBrainResponsesRequest）。
     这里**不**替换 root._ibApiPost：默认走 fetch，而 fetch 在本模块里是
     **结构性不可达**的（apiKey 恒为空 → middleBrainReady 恒 false）。 */
  globalThis.IBModelCore = require(path.join(ASSETS_JS, 'ib-model-core.js'));
  require(path.join(ASSETS_JS, FACADE_FILE));
  const facade = (globalThis.IB && globalThis.IB.middleBrain) || null;
  if (!facade) throw new Error('middle-brain facade unavailable after load');
  _cache = { facade: facade, shims: created };
  return _cache;
}

/* 把 history（{role,content} 数组）收成本轮 dialogue 数组。
   只取 user / assistant，跳过 system；单条截断到 400 字符，最多 8 条。
   当前用户消息**追加在最后** —— 与桌面把 tail 挂在末条 user 消息上同一语义：
   组织层把它当"当前对话"，而它与历史对话之间的相对顺序必须与桌面一致。 */
function dialogueFrom(history, userMessage) {
  const out = [];
  if (Array.isArray(history)) {
    for (const item of history) {
      if (!item) continue;
      const role = item.role === 'assistant' ? 'assistant' : (item.role === 'user' ? 'user' : null);
      if (!role) continue;
      const text = String(item.content == null ? '' : item.content);
      if (!text.trim()) continue;
      out.push((role === 'assistant' ? '角色：' : '用户：') + (text.length > DIALOGUE_MAX_CHARS ? text.slice(0, DIALOGUE_MAX_CHARS) : text));
    }
  }
  if (out.length > DIALOGUE_MAX_MESSAGES) out.splice(0, out.length - DIALOGUE_MAX_MESSAGES);
  const current = String(userMessage || '');
  if (current.trim()) out.push('用户：' + (current.length > DIALOGUE_MAX_CHARS ? current.slice(0, DIALOGUE_MAX_CHARS) : current));
  return out;
}

/* 本轮 context 快照：与桌面 _buildSingleChatContext 的 _ctxSnapshot **同一契约**
   （复用 assets/js/context-snapshot.js，不写第二份快照实现）。
   Home Node 只有 memory 一个 producer：
     · 已读且非空 → present（组织层用它，且**禁止**二次 retrieval）
     · 已读但为空 → empty（同样禁止二次读取）
     · 没读成功   → missing（等价 undefined，允许消费方自行 retrieval）
   其余三个 producer 在本节点**根本不存在**，因此如实记 missing ——
   不是"空"，而是"这个宿主没有这个来源"。 */
function buildSnapshot(CS, input) {
  if (!CS || typeof CS.create !== 'function') return null;
  const mem = input.memory || {};
  const consulted = mem.consulted === true;
  const memoryField = CS.field('memory-retrieval.buildRuntimeContext', consulted ? String(mem.text || '') : '', {
    missing: !consulted,
    gatedBy: consulted ? null : 'home-node.memory-unavailable'
  });
  const absent = name => CS.field('home-node.absent:' + name, '', {
    missing: true,
    gatedBy: 'producer-not-canonical-on-home-node'
  });
  /* M1-C.2k：thread 从"本节点根本不存在"变成**已读** —— 它的派生是 canonical
     memory 上的确定性函数（见 thread-retrieval.js），因此 Home Node 与桌面对同一批
     记忆给出同一组线索，不再需要"浏览器写过盘才有"。
     M1-C.2m：understanding 同样从 absent 变成**已读** —— 它是本节点自己的
     canonical 文档（understanding-store.js），由本节点唯一派生。
     三态与 memory 同款：consulted 才 present/empty；读取失败或不曾读 → missing。
     moments 仍然如实记 missing（它**确实**不是本节点的来源）。 */
  const thr = input.thread || null;
  const threadField = thr
    ? CS.field('thread-retrieval.derive', String(thr.text || ''), {
      missing: thr.consulted !== true,
      gatedBy: thr.consulted === true ? null : (thr.gatedBy || 'home-node.thread-unavailable')
    })
    : absent('thread');
  const und = input.understanding || null;
  const understandingField = und
    ? CS.field('understanding-retrieval.buildUnderstandingBlock', String(und.text || ''), {
      missing: und.consulted !== true,
      gatedBy: und.consulted === true ? null : (und.gatedBy || 'home-node.understanding-unavailable')
    })
    : absent('understanding');
  return CS.create({
    characterId: String(input.characterId || ''),
    turnId: String(input.turnId || ''),
    fields: {
      memory: memoryField,
      understanding: understandingField,
      thread: threadField,
      moments: absent('moments')
    },
    gates: { threadMemoryEnabled: true, homeNodeProducers: ['memory', 'thread', 'understanding'] }
  });
}

/* 把执行缝的返回值翻译成一条**诚实**的 contextPolicy 标签。
   桌面用 metadata.contextPolicy 记录"这一轮到底吃了什么上下文"，Home Node 沿用
   同一字段、同一纪律：只描述事实，不描述期望。 */
function describePolicy(result, memoryReadiness) {
  const res = result || {};
  const source = String(res.source || 'bypass');
  if (source === 'bypass') return 'middle-brain:bypass/memory:' + memoryReadiness;
  if (res.stats && res.stats.empty === true) return 'middle-brain:' + source + '/empty/memory:' + memoryReadiness;
  return 'middle-brain:' + source + '/memory:' + memoryReadiness;
}

function createNodeMiddleBrain(deps) {
  deps = deps || {};
  const readExecutionConfig = typeof deps.executionConfig === 'function' ? deps.executionConfig : null;
  const logger = deps.logger || (() => {});

  let CS = null;
  try { CS = require(path.join(ASSETS_JS, 'context-snapshot.js')); }
  catch (error) { logger('middle-brain-snapshot-unavailable', { error: String((error && error.message) || error) }); }

  let loaded = null;
  let loadError = null;
  try { loaded = loadCanonicalMiddleBrain(); }
  catch (error) {
    loadError = String((error && error.message) || error);
    logger('middle-brain-load-failed', { error: loadError });
    return {
      available: false,
      loadError: loadError,
      diagnostics: function () { return { available: false, loadError: loadError }; },
      /* 全部 seam 退化为"未参与"—— 绝不因为适配层自身的问题让回合失败。 */
      isEnabled: function () { return Promise.resolve(false); },
      reasoningEffort: function () { return Promise.resolve('auto'); },
      organizeContext: function () { return Promise.resolve({ applied: false, source: 'bypass', reason: 'adapter-unavailable' }); },
      finalizeReply: function (candidate) { return Promise.resolve({ reply: candidate, ran: false }); },
      describePolicy: function () { return 'middle-brain:unavailable'; }
    };
  }
  const facade = loaded.facade;

  /* ── 宿主适配：浏览器读 IndexedDB，这里读已发布的执行配置投影 ──────────
     这是 canonical 层与本节点之间**唯一**的接缝。它只负责"给出一份配置对象"，
     一个判定都不做（判定全在 middle-brain-config-core）。 */
  const CORE = globalThis.IBMiddleBrainConfigCore;
  if (!CORE) {
    const reason = 'middle-brain-config-core-missing';
    logger('middle-brain-contracts-missing', {});
    return {
      available: false, loadError: reason,
      diagnostics: function () { return { available: false, loadError: reason }; },
      isEnabled: function () { return Promise.resolve(false); },
      reasoningEffort: function () { return Promise.resolve('auto'); },
      organizeContext: function () { return Promise.resolve({ applied: false, source: 'bypass', reason: reason }); },
      finalizeReply: function (candidate) { return Promise.resolve({ reply: candidate, ran: false }); },
      describePolicy: function () { return 'middle-brain:unavailable'; }
    };
  }

  async function getConfig() {
    let stored = null;
    try { stored = readExecutionConfig ? readExecutionConfig() : null; }
    catch (error) { logger('middle-brain-config-read-failed', { error: String((error && error.message) || error) }); }
    /* 构造式合并：默认值打底，投影覆盖。投影里**没有** endpoint / model / apiKey
       三个键，因此它们保持默认 —— 而默认 apiKey 是空串，于是 Astra 恒"未就绪"。
       这里刻意**不**写 `stored.x || default.x` 之类的任意回落：
       键是显式列举的，缺一个是编程错误而不是运行时状态。 */
    const merged = Object.assign({}, CORE.MB_DEFAULTS, stored || {});
    /* ── 为什么 endpoint / model 要放哨兵值而不是留空 ──────────────────────
       canonical 的就绪谓词（middle-brain-config-core.middleBrainRuntimeEnabled）是
       `enabled && endpoint 非空 && model 非空` —— 上游多一个不变量："说启用就必须
       说得出往哪发、发给谁"。Home Node 不能持有真实 endpoint/model（那等于把桌面的
       provider 配置投影到设备侧），但**也不能**把两个字段留空：留空会让谓词恒 false，
       于是"桌面发布 enabled:true"在 Node 上表现为"未启用" —— 一个静默的、看起来
       像 bug 的行为差异。
       所以这里如实填入**非空哨兵**，把"策略已发布且可用"这个事实编码进去，
       最内层的不变量得以保持。它们是**地址**，不是**身份**：
         · 没有任何代码路径会用到它们 —— Astra 的传输要 cfg.endpoint，而它被
           apiKey 恒空这一道真实闸门挡在 middleBrainReady() 之前（见下）；
         · 本地 pipeline / Admission Gate / Integrity 证据构建都不读这两个字段。
       apiKey 留空**不是**哨兵而是真实闸门：middleBrainApiReady() 因它恒 false，
       于是 Admission Gate 恒 astra_not_ready、judge 恒 early-return、模型调用
       在发起之前就被挡住。Home Node 因此**永远不需要** Middle Brain 凭据。 */
    merged.endpoint = PUBLISHED_POLICY_SENTINEL;
    merged.model = PUBLISHED_POLICY_SENTINEL;
    merged.apiKey = '';
    return merged;
  }

  /* ── 宿主注入：canonical config 层经这个具名 shim 读执行策略 ────────────
     为什么不直接给 CFG.getMiddleBrainConfig 赋值：那是 Object.freeze 的**进程内
     共享**契约，就地改写会把"哪个宿主在跑"变成隐式全局状态（两个装配实例互相覆盖、
     测试之间互相污染）。具名 shim 是显式的，而且卸得掉。
     Home Node 是**每进程一个**服务，因此这里也如实按单例处理：重复装配会记一条
     non-fatal 诊断，而不是假装可以并存。 */
  const previousReader = globalThis.__ibMiddleBrainConfigReader;
  if (typeof previousReader === 'function') {
    logger('middle-brain-config-reader-replaced', { note: 'another assembly already installed a reader in this process' });
  }
  globalThis.__ibMiddleBrainConfigReader = getConfig;

  async function isEnabled() {
    try { return await facade.isMiddleBrainEnabled(); }
    catch (error) { logger('middle-brain-enabled-check-failed', { error: String((error && error.message) || error) }); return false; }
  }
  async function reasoningEffort() {
    try { return String((await facade.middleBrainReasoningEffort()) || 'auto'); }
    catch (error) { return 'auto'; }
  }

  /* ── seam 1 · 生成前 ──────────────────────────────────────────────────
     与桌面 communication.js:1519-1533 同一调用形状：
     交已读上下文结果 → 取回 {source, compressedContext, stats}；
     applied=false 表示"不要动上下文"（未启用 / 空产物 / 任何故障）。
     `injected` 的判定在调用方（execution.js 的注入契约），本层不替它决定。 */
  async function organizeContext(input) {
    const turn = input || {};
    const memory = turn.memory || {};
    const memoryReadiness = memory.consulted === true ? (String(memory.text || '').trim() ? 'present' : 'empty') : 'missing';
    const snapshot = buildSnapshot(CS, {
      characterId: turn.characterId, turnId: turn.turnId, memory: memory,
      thread: turn.thread || null, understanding: turn.understanding || null
    });
    /* 交出去的东西逐项显式构造（与桌面的 opts 形状对齐，但**不**照抄它的 producer：
       那四个 producer 在本宿主不存在，如实缺席）。
         · contextSnapshot —— 有快照就交快照；组织层优先读它，且 present/empty 都禁止二次 retrieval
         · memoryCtx        —— 仅当 memory **确实读过**时才给。没读成功就给 undefined，
                               让组织层按"未提供"处理，而不是把一个空串当成"读过且为空"
         · dialogue         —— 本轮对话（历史 + 当前消息），Gate 的复杂度信号要用 */
    const opts = {
      dialogue: dialogueFrom(turn.history, turn.userMessage),
      contextSnapshot: snapshot || null
    };
    if (memory.consulted === true) opts.memoryCtx = String(memory.text || '');
    /* M1-C.2k：thread 与快照同时给 —— 组织层优先读快照（present/empty 都禁止二次
       retrieval），threadCtx 只是快照不可用时的等价回落。与桌面
       communication.js:1520-1525 同时给 *Ctx 与 contextSnapshot 的形状一致。 */
    if (turn.thread && turn.thread.consulted === true) opts.threadCtx = String(turn.thread.text || '');
    /* M1-C.2m：understanding 与 thread **逐字同款** —— 快照优先，*Ctx 只作回落。
       为什么必须给：canonical 组织层（middle-brain-policy.js:74）在
       `understandingCtx != null` 时才把理解放进 organized.understanding，
       否则 understanding 分支恒为空 —— 也就是"她对自己的理解完全没参与过
       这一轮的认知组织"。桌面在 communication.js:1521 同样给了它。 */
    if (turn.understanding && turn.understanding.consulted === true) opts.understandingCtx = String(turn.understanding.text || '');
    try {
      const result = await facade.middleBrainExecute(String(turn.characterId || ''), String(turn.userMessage || ''), opts);
      const source = String((result && result.source) || '') || 'bypass';
      if (!result || source === 'bypass') {
        return { applied: false, source: 'bypass', reason: 'not-enabled-or-empty', memoryReadiness: memoryReadiness, policy: 'middle-brain:bypass/memory:' + memoryReadiness, snapshot: snapshot };
      }
      return {
        applied: true,
        source: source,
        compressedContext: String(result.compressedContext || ''),
        stats: (result && result.stats) || null,
        admission: (result && result.admission) || null,
        memoryReadiness: memoryReadiness,
        policy: describePolicy(result, memoryReadiness),
        snapshot: snapshot
      };
    } catch (error) {
      logger('middle-brain-organize-failed', { error: String((error && error.message) || error).slice(0, 300) });
      return { applied: false, source: 'bypass', reason: 'error', memoryReadiness: memoryReadiness, policy: 'middle-brain:bypass/memory:' + memoryReadiness, snapshot: snapshot };
    }
  }

  /* ── seam 2 · 生成后 ──────────────────────────────────────────────────
     与桌面 communication.js:2330-2333 同一调用形状：
     交候选回复 + 角色/历史/上下文证据 → 取回最终文本。
     任何故障 → 原样返回候选（facade 自己保证，本层不再包一层判定）。 */
  async function finalizeReply(input) {
    const turn = input || {};
    const candidate = String(turn.candidate == null ? '' : turn.candidate);
    if (!candidate) return { reply: candidate, ran: false };
    try {
      const reply = await facade.middleBrainFinalizeReply(
        String(turn.characterId || ''),
        String(turn.userMessage || ''),
        candidate,
        {
          character: turn.character || {},
          history: Array.isArray(turn.history) ? turn.history : [],
          contextSnapshot: turn.snapshot || null,
          voice: turn.voice === true
        }
      );
      const changed = typeof reply === 'string' && !!reply && reply !== candidate;
      return { reply: typeof reply === 'string' && reply ? reply : candidate, ran: true, rewritten: changed };
    } catch (error) {
      logger('middle-brain-finalize-failed', { error: String((error && error.message) || error).slice(0, 300) });
      return { reply: candidate, ran: false };
    }
  }

  return {
    available: true,
    loadError: null,
    isEnabled: isEnabled,
    reasoningEffort: reasoningEffort,
    organizeContext: organizeContext,
    finalizeReply: finalizeReply,
    describePolicy: describePolicy,
    dialogueFrom: dialogueFrom,
    /* 卸载宿主 shim（测试与"重新装配"用）。生产进程不调用它：
       Home Node 的配置读取器活到进程结束。 */
    dispose: function () {
      if (globalThis.__ibMiddleBrainConfigReader === getConfig) {
        if (typeof previousReader === 'function') globalThis.__ibMiddleBrainConfigReader = previousReader;
        else delete globalThis.__ibMiddleBrainConfigReader;
      }
    },
    /* 只读诊断：shims 说明本进程为加载 canonical 层补了哪些全局别名。
       绝不含配置内容（更不含凭据）。 */
    diagnostics: function () {
      return {
        available: true,
        loadError: null,
        shims: loaded.shims.slice(),
        layers: Object.keys((globalThis.IB && globalThis.IB.__middleBrainContracts) || {}),
        facadeKeys: Object.keys(facade).length,
        snapshotContract: !!CS,
        configReaderInstalled: globalThis.__ibMiddleBrainConfigReader === getConfig
      };
    }
  };
}

module.exports = createNodeMiddleBrain;
module.exports.DIALOGUE_MAX_MESSAGES = DIALOGUE_MAX_MESSAGES;
module.exports.dialogueFrom = dialogueFrom;
module.exports.loadCanonicalMiddleBrain = loadCanonicalMiddleBrain;
