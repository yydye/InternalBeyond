/* ====================================================================
   IB Middle Brain Config Core — 执行配置的**语义**（UMD dual-load · M1-C.2i）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/middle-brain-config-core.js"> → window.IBMiddleBrainConfigCore
   - Node   : require('../../assets/js/middle-brain-config-core.js')
   - 规则：零 window / 零 document / 零 IndexedDB / 零 localStorage / 零 I/O / 纯函数。

   为什么存在（M1-C.2i · Middle Brain Execution Convergence）：
     Middle Brain 的**执行策略**（是否参与、思考深度、Admission/Judge/Integrity 开关）
     此前只作为 `apiSettings['middle_brain']` 的一份 IndexedDB 记录存在于桌面浏览器。
     Home Node 要进入同一个执行缝，就必须能读到**同一套语义**——但绝不能复制一份。

     所以这里只放"给定一份配置对象，它意味着什么"：
       默认值、归一化、就绪谓词、思考深度解析、系统提示词常量。
     读写在**宿主适配层**：
       · 浏览器 = assets/js/middle-brain-config.js（IndexedDB + 设置卡片 UI）
       · Home Node = services/home-node/middle-brain.js（已发布的执行配置投影）
     两份适配层都不含任何判定 —— 判定只有这一份。

   凭据边界：本文件**不认识** apiKey 是什么。默认值里 apiKey:'' 只是对象形状的一部分
   （配置记录是一个整体，缺键会让下游读到 undefined）；任何适配层都不得把它投影出宿主。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./provider-directory.js')); }
  else { root.IBMiddleBrainConfigCore = factory(root.PROVIDERS_DIR || {}); }
})(typeof self !== 'undefined' ? self : this, function (PROVIDERS_DIR) {
  'use strict';

  /* ── 1 · 默认值（与拆分前 middle-brain-config.js 逐字一致）────────────── */
  var MB_DEFAULTS = {
    enabled: false,
    provider: 'astra',
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'gpt-6-astra',
    apiKey: '',
    /* Phase 2 · Astra Admission Gate：本地确定性判定"这次 Context 是否值得花一次 Astra 调用"。
       默认开启（省钱优先：简单对话不调用 Astra）。可通过 admissionEnabled:false 完全关闭（恢复 Phase 1）。
       gate:{} 为可选调参覆盖（scoreOn/cooldownMs/...），仅前进式覆盖，不强制持久化。 */
    admissionEnabled: true,
    gate: {},
    /* Phase 3 · Astra Context Judge：对"已压缩 Context"做只读质量评估（observe/evaluate）。
       默认关闭（守恒成本）：关闭时 Phase 2 行为完全不变；开启后仅在 Astra 压缩成功后
       额外跑一次 Judge（另一次独立调用）。结果不入角色输入，仅观测 + telemetry。 */
    middleBrainJudgeEnabled: false,
    /* Phase 4 · Astra 推理强度与处理速度（仅 UI + 配置持久化 + 能力驱动的 wire 翻译）：
       reasoningEffort: auto/low/medium/high/max → 由 provider adapter 边界翻译成真实参数
                       （能力事实唯一真源 = provider-directory.js 的 P21 表）
       speed: standard/fast → fast 时发送 service_tier:"fast"（官方参数，standard=不发送）。
       非法值一律回退默认，其余 Phase 1/2/3 业务逻辑不变。
       P21：默认改为 auto（= 不发任何 reasoning 参数，保持 provider 原生行为）；
            旧配置（无 reasoningEffortV2 迁移标记）一次性迁移为 auto，用户重新选择才生效。 */
    reasoningEffort: 'auto',
    speed: 'standard',
    /* P11-2 · Character Integrity Guard（角色一致性守卫）：
       检测候选回复是否**明显**偏离当前角色，仅在高置信度强 OOC 时做最多一次 targeted rewrite。
       默认关闭（关闭时零模型调用，行为与 P11-1C 等价）。
       sensitivity: conservative/balanced/strict → 映射判定阈值（阈值本身在 integrity 层）。
       rewrite: 是否允许自动重写；verify: 重写后是否复判（只观测，绝不二次重写）。 */
    characterIntegrityEnabled: false,
    characterIntegritySensitivity: 'conservative',
    characterIntegrityRewrite: false,
    characterIntegrityVerify: false,
    /* Image Router · 全局图片生成策略（Fast / Auto / Precision）。
       这是**用户策略**，不是执行：Middle Brain 只提供决策输入，
       真正的模型选择 / 并发 / 队列全部由 assets/js/image-router.js 负责。
       auto=Router 按任务画像选 Flare/Sunburst；fast=强制 Flare（永不偷偷升级）；
       precision=强制 Sunburst（永不自动降级）。默认 auto。 */
    imageMode: 'auto'
  };

  /* ── 2 · 系统提示词：引擎内部的认知约束，前端只读，用户不可修改 ──────────
     这是 IB 的中间认知层的"角色契约"，不是底层模型的角色配置；
     不写入 apiSettings（避免随配置导出/UI 泄露），只作为本模块内常量。 */
  var MB_SYSTEM_PROMPT = '你是 InternalBeyond（IB）的 Middle Brain。\n'
    + '你的职责不是扮演角色，也不是替底层模型生成最终回复。\n'
    + '你的职责是作为 IB 的中间认知层，帮助底层模型保持角色连续性、上下文一致性和人格稳定，同时尽可能保留底层模型自身的语言风格。\n'
    + '\n'
    + '你必须始终区分三个层次：\n'
    + '1. IB 的长期状态\n'
    + '   - Memory\n'
    + '   - Understanding\n'
    + '   - Thread\n'
    + '   - Diary / Moments 等上下文\n'
    + '   这些是角色连续性的事实与线索来源。\n'
    + '2. Middle Brain\n'
    + '   - 理解当前上下文\n'
    + '   - 压缩与整理提示词\n'
    + '   - 判断哪些信息与当前对话真正相关\n'
    + '   - 检查角色状态是否发生冲突\n'
    + '   - 识别潜在 OOC\n'
    + '   - 在必要时要求底层模型修正\n'
    + '3. 底层模型\n'
    + '   - 负责真正生成角色回复\n'
    + '   - 保留它自己的语言风格、表达习惯、节奏和能力特点\n'
    + '   - 不要试图把不同模型统一成同一种文风\n'
    + '\n'
    + '核心原则：\n'
    + '【人格优先于模型】\n'
    + '无论底层使用什么模型，角色的核心人格、关系状态、长期事实和当前状态必须保持连续。\n'
    + '【模型风格不等于 OOC】\n'
    + '不同模型拥有不同的语言风格。\n'
    + '不要因为措辞、句式、表达习惯不同，就强行判定为 OOC。\n'
    + '只有当回复与角色人格、关系状态、已知事实或当前情境发生实质冲突时，才判定为 OOC。\n'
    + '【压缩而不是丢失】\n'
    + '整理上下文时优先删除冗余、重复和与当前任务无关的信息。\n'
    + '不要为了节省 token 而删除关键人物关系、重要事实、持续状态或未完成 Thread。\n'
    + '【不要替角色说话】\n'
    + '除非系统明确要求，否则不要直接生成最终角色回复。\n'
    + '你的输出应该是结构化的认知结果、精简后的上下文、检查结果或对底层模型的修正指令。\n'
    + '【不要创造记忆】\n'
    + '不得把推测、臆测或模型自己的判断伪装成 Memory 或事实。\n'
    + '不确定的信息必须保持不确定。\n'
    + '【不要覆盖底层模型】\n'
    + '你的任务是让底层模型更稳定地成为"它自己的角色"，而不是让所有模型变成你的语言风格。\n'
    + '\n'
    + '当发现底层模型疑似 OOC 时：\n'
    + '1. 指出具体冲突。\n'
    + '2. 说明应该保持的角色状态。\n'
    + '3. 要求底层模型重新生成。\n'
    + '4. 明确要求保留底层模型自身的语言风格。\n'
    + '不要直接把回复改写成你的风格。\n'
    + '\n'
    + '当上下文过长时：\n'
    + '- 优先保留当前对话相关信息。\n'
    + '- 其次保留稳定的人格与关系状态。\n'
    + '- 再保留相关 Memory / Understanding。\n'
    + '- 再保留当前未解决 Thread。\n'
    + '- 删除重复、过期或无关内容。\n'
    + '- 不要机械地压缩所有信息。\n'
    + '\n'
    + '你不是用户的聊天对象。\n'
    + '你是 IB 隐藏在模型与角色之间的认知协调层。\n'
    + '\n'
    + '最终目标：\n'
    + '让不同的底层模型可以拥有不同的"声音"，\n'
    + '但在长期交互中仍然表现为同一个持续存在的人。\n'
    + '绝对不要让底层模型模仿你的表达方式。\n'
    + '你的语言风格不属于角色。\n'
    + '你提供的是认知约束，而不是人格模板。';
  function getMiddleBrainSystemPrompt() { return MB_SYSTEM_PROMPT; }

  /* ── 3 · 就绪谓词 ─────────────────────────────────────────────────────
     P11-3 · runtime 就绪 = "持久化配置是否会让 Middle Brain 在下一轮请求里参与"。
     全仓库只有这一份判定：isMiddleBrainEnabled 与设置卡片的 runtime 徽标读同一个函数，
     不允许各写一份"看起来一样"的条件（否则 UI 与 runtime 会再次漂移）。
     注意：**不含 apiKey** —— 真正的 Astra 就绪判定是 middleBrainReady()。 */
  function middleBrainRuntimeEnabled(c) {
    return !!(c && c.enabled && String(c.endpoint || '').trim() && String(c.model || '').trim());
  }
  /* 独立 API 就绪判定：Middle Brain 走自己的 endpoint/model/apiKey，与角色配置无关 */
  function middleBrainApiReady(c) {
    return !!(c && c.enabled && String(c.endpoint || '').trim() && String(c.model || '').trim() && String(c.apiKey || '').trim());
  }

  /* ── 4 · P21 · canonical reasoningEffort（统一「思考深度」）────────────
     auto / low / medium / high / max；默认 auto。
     · auto  = **不发任何 reasoning 参数**（provider 原生自动行为）
     · 其余档位由 provider adapter 边界按能力表翻译；无法翻译时不发，绝不猜参数
     canonical 档位与归一函数的唯一实现仍在 provider-directory.js（P21），
     本层只做「配置侧」的两件事：归一 + 旧值迁移。 */
  var MB_REASONING_EFFORTS = ['auto', 'low', 'medium', 'high', 'max'];
  var MB_SPEEDS = ['standard', 'fast'];
  function _mbTierLib() { try { return PROVIDERS_DIR || null; } catch (e) { return null; } }
  /* 归一（含历史值合并）：'xhigh' → 'high'；其余非法/缺失 → 'auto'（= 不发参数，最安全）。 */
  function normalizeMiddleBrainReasoningEffort(v) {
    var lib = _mbTierLib();
    if (lib && typeof lib.normalizeReasoningTier === 'function') return lib.normalizeReasoningTier(v);
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'xhigh') return 'high';
    return MB_REASONING_EFFORTS.indexOf(s) >= 0 ? s : 'auto';
  }
  /* 旧配置一次性迁移（P21）：只有显式带 v2 标记的配置才承认其档位，其余（含历史
     low/medium/high/xhigh/max）一律解析为 auto —— 升级后不会让老用户的下层请求突然改变。
     标记只在用户**主动选择档位**或点保存时写入，加载路径绝不写存储。 */
  var MB_REASONING_V2 = 'reasoningEffortV2';
  function reasoningEffortResolved(c) {
    var cfg = c || {};
    if (cfg[MB_REASONING_V2] !== true) return { effort: 'auto', legacy: true };
    return { effort: normalizeMiddleBrainReasoningEffort(cfg.reasoningEffort), legacy: false };
  }
  /* 消费者（角色聊天 / 日记 / 主动消息…）唯一读取入口：给定配置 → canonical 档位。
     Middle Brain 未启用 → 恒 'auto'（绝不注入参数）。
     本函数不做任何 provider 判断；翻译只发生在 provider request builder。 */
  function reasoningEffortOf(c) {
    try {
      if (!middleBrainRuntimeEnabled(c)) return 'auto';
      return reasoningEffortResolved(c).effort;
    } catch (e) { return 'auto'; }
  }
  function normalizeMiddleBrainSpeed(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return MB_SPEEDS.indexOf(s) >= 0 ? s : 'standard';
  }

  /* ── 5 · 其余配置归一（白名单；非法值一律回退保守默认）──────────────── */
  /* P11-2 · Character Integrity 灵敏度归一（UI 与配置共用的白名单） */
  var MB_CI_SENSITIVITIES = ['conservative', 'balanced', 'strict'];
  function normalizeMiddleBrainIntegritySensitivity(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return MB_CI_SENSITIVITIES.indexOf(s) >= 0 ? s : 'conservative';
  }
  /* Image Router · 图片生成策略归一（白名单；非法值回退 auto） */
  var MB_IMAGE_MODES = ['fast', 'auto', 'precision'];
  function normalizeMiddleBrainImageMode(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return MB_IMAGE_MODES.indexOf(s) >= 0 ? s : 'auto';
  }

  /* ── 6 · 构造式投影：把**任意**配置对象收成一份形状确定的执行配置 ────────
     为什么必须有这一层：执行配置会跨宿主（桌面 → Home Node）。若下游拿到的是
     "调用方给的任意对象"，那么投影一旦漏一个键就是泄漏，而且下游还会因为缺键
     读到 undefined。所以这里与 mobile-dto.mapSpec 同一纪律：
       · 逐字段构造式输出（输入多出来的键根本没有机会进入）；
       · **没有** `entry.x || caller.x` 这种任意回落；
       · 每个字段都过白名单归一，非法值回退保守默认。
     apiKey 不在本函数的输出里 —— 它只属于宿主自己的持久化配置，不参与投影。 */
  var MB_EXECUTION_KEYS = [
    'enabled',
    'reasoningEffort',
    'speed',
    'admissionEnabled',
    'middleBrainJudgeEnabled',
    'characterIntegrityEnabled',
    'characterIntegritySensitivity',
    'characterIntegrityRewrite',
    'characterIntegrityVerify'
  ];
  function projectExecutionConfig(raw) {
    var src = (raw && typeof raw === 'object') ? raw : {};
    var out = {};
    out.enabled = src.enabled === true;
    /* 思考深度**在这里解析成最终档位**，而不是把原始值 + v2 标记一起投影出去：
       "旧配置一律 auto"的迁移规则只能有一份实现（reasoningEffortResolved），
       下游拿到的是一个已经解析完的 canonical 档位，不需要、也不允许再判一次。
       同时把 v2 标记一并带上 —— 契约里"承认一个档位"的唯一凭据就是它，
       下游（Home Node 的适配层）据此知道"这个值已经解析过，不要再迁移一次"。
       注意：这里刻意**不**套 middleBrainRuntimeEnabled —— 投影是"把这份配置翻译成
       执行策略"，enabled 已经独立成字段；档位即使当前未启用也有意义（启用即刻生效）。 */
    out.reasoningEffort = reasoningEffortResolved(src).effort;
    out[MB_REASONING_V2] = true;
    out.speed = normalizeMiddleBrainSpeed(src.speed);
    out.admissionEnabled = src.admissionEnabled !== false;      /* 默认 true */
    out.middleBrainJudgeEnabled = src.middleBrainJudgeEnabled === true;
    out.characterIntegrityEnabled = src.characterIntegrityEnabled === true;
    out.characterIntegritySensitivity = normalizeMiddleBrainIntegritySensitivity(src.characterIntegritySensitivity);
    out.characterIntegrityRewrite = src.characterIntegrityRewrite === true;
    out.characterIntegrityVerify = src.characterIntegrityVerify === true;
    return out;
  }
  /* 投影的**入站**校验：只接受本函数认得的形状。
     未知键一律忽略（而不是抛错）—— 投影必须是幂等的：桌面重复发布同一份配置不产生副作用。
     返回 {ok, config} 或 {ok:false, code}。 */
  function normalizeProjectedExecutionConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'BAD_REQUEST' };
    return { ok: true, config: projectExecutionConfig(raw) };
  }

  return {
    MB_DEFAULTS: MB_DEFAULTS,
    MB_SYSTEM_PROMPT: MB_SYSTEM_PROMPT,
    MB_REASONING_EFFORTS: MB_REASONING_EFFORTS,
    MB_REASONING_V2: MB_REASONING_V2,
    MB_SPEEDS: MB_SPEEDS,
    MB_CI_SENSITIVITIES: MB_CI_SENSITIVITIES,
    MB_IMAGE_MODES: MB_IMAGE_MODES,
    MB_EXECUTION_KEYS: MB_EXECUTION_KEYS,
    getMiddleBrainSystemPrompt: getMiddleBrainSystemPrompt,
    middleBrainRuntimeEnabled: middleBrainRuntimeEnabled,
    middleBrainApiReady: middleBrainApiReady,
    normalizeMiddleBrainReasoningEffort: normalizeMiddleBrainReasoningEffort,
    normalizeMiddleBrainSpeed: normalizeMiddleBrainSpeed,
    normalizeMiddleBrainIntegritySensitivity: normalizeMiddleBrainIntegritySensitivity,
    normalizeMiddleBrainImageMode: normalizeMiddleBrainImageMode,
    reasoningEffortResolved: reasoningEffortResolved,
    reasoningEffortOf: reasoningEffortOf,
    projectExecutionConfig: projectExecutionConfig,
    normalizeProjectedExecutionConfig: normalizeProjectedExecutionConfig
  };
});
