'use strict';

/* ====================================================================
   PROVIDER DIRECTORY —— 唯一 canonical provider metadata 源
   --------------------------------------------------------------------
   · 唯一一份 PROVIDERS 字面量 + providerFormat() 归约在此。
   · social.js（浏览器 window.PROVIDERS 兼容暴露）与
     ib-model-core.js（runtime-neutral UMD）都从这里取数，
     不再各自维护第二份 provider metadata 字面量。
   · 这里**只**承载 provider metadata / PROVIDERS / providerFormat，
     以及 P16 的 keyed onboarding metadata（OFFICIAL_ONBOARDING /
     THIRD_PARTY_SITES：官方平台入口、Key 获取地址、地区与充值提示、
     3–5 步教程）、P17 的呈现层 metadata（PROVIDER_PRESENTATION）与
     P18 的模型时效 metadata（MODEL_POLICIES / MODEL_AUDIT）。
     onboarding 条目按 provider id 关联，**不复制**
     endpoint / format / model / vision / streaming。
     绝不塞入 request builder、response parser、API client、
     streaming handler、auth、ModelAdapter 等架构。

   加载方式:
     - Node   : const { PROVIDERS, providerFormat } = require('./assets/js/provider-directory.js');
     - Browser: 先于 social.js 用 <script> 加载 → window.PROVIDERS_DIR
   ==================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PROVIDERS_DIR = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 唯一 canonical provider 目录（照搬自 browser social.js window.PROVIDERS 字面量，
     逐字段一致，不改变任何 provider 元数据）。 */
  var PROVIDERS = {
    anthropic: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-5', format: 'anthropic', vision: true, streaming: true },
    openai: { name: 'GPT', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', format: 'openai', vision: true, streaming: true },
    grok: { name: 'Grok', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.3', format: 'openai', vision: true, streaming: true },
    deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-v4-flash', format: 'openai', vision: true, streaming: true, showThinking: true },
    gemini: { name: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', model: 'gemini-3.5-flash', format: 'gemini', vision: true, streaming: true },
    glm: { name: 'GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', format: 'openai', vision: true, streaming: true, showThinking: false },
    qwen: { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', format: 'openai', vision: true, streaming: true },
    doubao: { name: '豆包', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-seed-2-0-lite', format: 'openai', vision: true, streaming: true },
    moonshot: { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'kimi-k2.6', format: 'openai', vision: true, streaming: true },
    mimo: { name: 'MiMo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5', format: 'openai', vision: true, streaming: true, showThinking: true },
    minimax: { name: 'MiniMax', endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2', model: 'MiniMax-Text-01', format: 'openai', vision: false, streaming: true },
    yi: { name: '零一万物', endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions', model: 'yi-lightning', format: 'openai', vision: false, streaming: true },
    baichuan: { name: '百川', endpoint: 'https://api.baichuan-ai.com/v1/chat/completions', model: 'Baichuan4', format: 'openai', vision: false, streaming: true },
    mistral: { name: 'Mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest', format: 'openai', vision: false, streaming: true },
    /* custom 不是「某一家 AI 服务」，而是 Generic / OpenAI-Compatible 兼容模式：
       没有官方端点、没有官方模型、也不由本目录声明它具备什么能力。
       显示名直说这一点，避免被当成一家服务商。 */
    custom: { name: '自定义 / OpenAI Compatible', endpoint: '', model: '', format: 'openai', vision: true, streaming: true }
  };

  /* ══════════════════════════════════════════════════════════════════════
     P17 · Provider Presentation Metadata（**唯一**一份呈现层真源）
     ----------------------------------------------------------------------
     定位：本表回答「IB 有哪些服务、以什么顺序摆、给新手看哪句说明、出现在
     哪些列表里」。它取代此前散落在 setup-wizard.js（PROVIDER_ORDER /
     PROVIDER_HINT）、api-onboarding.js（OFFICIAL_ORDER / PROVIDER_HINT）、
     InternalBeyond.html（15 个硬编码 <option>）以及本文件 ONBOARDING_ORDER
     里的多份顺序 / 文案表。

     key === PROVIDERS 的 canonical provider id。**绝不**包含
     endpoint / model / format / vision / streaming —— 那些只存在于 PROVIDERS；
     也**不**重复 display name（一律用 PROVIDERS[id].name）。

     ── 字段 ──
     order            展示顺序（数字，小者在前；同号按本表声明顺序）
     group            展示分组：'domestic' | 'international' | 'compatible'
     kind             身份：缺省 'official'（= 目录成员）；'custom' 显式
                      'compatible'（Generic / OpenAI 兼容，不是某家服务）
     shortHint        一句话说明「这是谁家的服务」（卡片副标题 / 下拉提示）
     showInPicker     是否出现在 API 编辑器「服务商」下拉
     showInSetup      是否出现在首次设置向导
     showInOnboarding 是否出现在「获取 API Key」向导的官方区
     capabilitiesKnown  false = 本目录不为它声明能力（兼容接入，能力取决于用户填的服务）
     beginnerHint     可选；缺省由 P16 onboarding 的 audience 派生，不复制第二份

     缺省语义：**目录里有、呈现表没写**的 provider 仍然出现（showIn* 默认 true、
     order 500、group 'other'）——目录才是 canonical 名单，新增服务不必改别处。
     ====================================================================== */

  var PROVIDER_PRESENTATION = {
    /* 国内（新手优先：先看到国内可直接访问的服务） */
    deepseek: { order: 10, group: 'domestic', shortHint: 'DeepSeek 官方', showInPicker: true, showInSetup: true, showInOnboarding: true },
    qwen: { order: 20, group: 'domestic', shortHint: '阿里云百炼', showInPicker: true, showInSetup: true, showInOnboarding: true },
    glm: { order: 30, group: 'domestic', shortHint: '智谱 AI', showInPicker: true, showInSetup: true, showInOnboarding: true },
    minimax: { order: 40, group: 'domestic', shortHint: 'MiniMax', showInPicker: true, showInSetup: true, showInOnboarding: true },
    moonshot: { order: 50, group: 'domestic', shortHint: '月之暗面 Kimi', showInPicker: true, showInSetup: true, showInOnboarding: true },
    doubao: { order: 60, group: 'domestic', shortHint: '字节跳动', showInPicker: true, showInSetup: true, showInOnboarding: true },
    mimo: { order: 70, group: 'domestic', shortHint: '小米', showInPicker: true, showInSetup: true, showInOnboarding: true },
    yi: { order: 80, group: 'domestic', shortHint: '零一万物', showInPicker: true, showInSetup: true, showInOnboarding: true },
    baichuan: { order: 90, group: 'domestic', shortHint: '百川智能', showInPicker: true, showInSetup: true, showInOnboarding: true },
    /* 国际 */
    openai: { order: 110, group: 'international', shortHint: 'OpenAI 官方', showInPicker: true, showInSetup: true, showInOnboarding: true },
    anthropic: { order: 120, group: 'international', shortHint: 'Anthropic 官方', showInPicker: true, showInSetup: true, showInOnboarding: true },
    gemini: { order: 130, group: 'international', shortHint: 'Google 官方', showInPicker: true, showInSetup: true, showInOnboarding: true },
    grok: { order: 140, group: 'international', shortHint: 'xAI 官方', showInPicker: true, showInSetup: true, showInOnboarding: true },
    mistral: { order: 150, group: 'international', shortHint: 'Mistral 官方', showInPicker: true, showInSetup: true, showInOnboarding: true },
    /* 兼容 / 自定义（不是一家服务） */
    custom: { order: 900, group: 'compatible', kind: 'compatible', shortHint: '自己填写接口地址', showInPicker: true, showInSetup: true, showInOnboarding: false, capabilitiesKnown: false }
  };

  /* 分组展示顺序与文案（唯一一份）。 */
  var GROUP_ORDER = ['domestic', 'international', 'other', 'compatible'];
  var GROUP_LABELS = {
    domestic: '国内服务',
    international: '国际服务',
    other: '其它服务',
    compatible: '兼容 / 自定义'
  };

  /* 呈现表缺失时的缺省值：目录成员默认到处都出现（不因缺 metadata 而消失）。 */
  var PRESENTATION_DEFAULTS = {
    order: 500, group: 'other', kind: 'official',
    showInPicker: true, showInSetup: true, showInOnboarding: true,
    capabilitiesKnown: true
  };

  /* ══════════════════════════════════════════════════════════════════════
     P18 · Model Catalog Freshness（默认模型时效 + 最小 model policy）
     ----------------------------------------------------------------------
     本区块只回答两件事，且**只**回答这两件事：

       ① 新建配置用哪个 model —— 仍然是 PROVIDERS[id].model（唯一一份默认值）。
          已有用户配置里的 model 一律照旧使用：本区块不迁移、不升级、
          不在打开编辑器 / 启动 / 保存时改写用户的 model。

       ② 某个**具体 model id** 在请求侧有没有已知的硬约束 —— MODEL_POLICIES。

     ── MODEL_POLICIES（key = 官方 model id；逐条取证，不按前缀 / 正则猜）──
       supportsSamplingParameters
         false = 官方已移除 temperature / top_p / top_k；请求必须省略这些字段，
                 否则 4xx。true/缺省 = 与 P18 之前行为逐位一致（照发 temperature）。
       supportsAssistantPrefill（P19）
         false = 该 model 不接受「最后一条 assistant 消息作为 seed」（Anthropic
                 自 4.6 起移除 prefill：官方报 400「This model does not support
                 assistant message prefill」）。请求必须改为把 JSON 意图写进
                 prompt 约束，绝不追加 seed assistant 消息。
         true/缺省 = 保留历史行为（追加 seed assistant 消息），与 P19 之前逐位一致。
       · 表里**没有**的 model id 一律取 MODEL_POLICY_DEFAULTS。绝不因为
         「名字看起来像新模型」就改变既有请求行为。
       · Anthropic 的 dated snapshot（如 claude-sonnet-5-20260701）按官方命名
         约定去掉尾部 -YYYYMMDD 再查表；不做任何其它模糊匹配。两条能力
         （sampling / prefill）共用这一个 canonical lookup，禁止第二套归一化。

     ── MODEL_AUDIT（key = provider id；**审计元数据**，不参与运行时判定）──
       status   current          官方当前可调用，且适合作为 IB 新建配置默认值
                deprecation-risk 有官方/多方证据指向弃用或即将关停，尚缺官方 API 表
                unverified       无法从官方来源确认 → 保持现状，不猜替代值
       latest   官方最新一代（可能与 default 不同：IB 默认选「稳定 GA + 适合新手」）
       evidence 取证来源（官方文档优先；第三方仅作交叉印证）
       audited  取证日期（YYYY-MM-DD）

       · DeepSeek 官方「首次调用 API」页的模型清单 = deepseek-v4-flash /
         deepseek-v4-pro / deepseek-v4-flash-vision-exp：前两个的内部版本名
         （DeepSeek-V4-Flash-0731 / -V4-Pro-0813）不影响调用 ID；
         deepseek-v4-flash-vision-exp 是官方**实验性视觉模型**（额外支持图片
         输入，模型名精确匹配即可调用，详见官方「图像理解」页），因此它同样
         不进 MODEL_POLICIES、不加任何限制，`communication.js` 的精确匹配常量
         与这条官方事实一致。

     本表**不**是 Model Registry / Marketplace：没有模型列表、没有价格、
     没有动态发现。模型枚举属于以后阶段。
     ====================================================================== */

  var MODEL_POLICY_DEFAULTS = { supportsSamplingParameters: true, supportsAssistantPrefill: true };

  var MODEL_POLICIES = {
    /* Anthropic 自 Opus 4.7 / Sonnet 5 起移除采样参数（官方迁移指南 + 多个
       独立项目实测 400「temperature is deprecated for this model」）。
       只登记已取证的 id；其余 id 保持旧行为。 */
    'claude-sonnet-5': { supportsSamplingParameters: false, supportsAssistantPrefill: false },
    'claude-opus-4-7': { supportsSamplingParameters: false, supportsAssistantPrefill: false },
    'claude-opus-4-8': { supportsSamplingParameters: false, supportsAssistantPrefill: false },
    'claude-opus-5': { supportsSamplingParameters: false, supportsAssistantPrefill: false },
    /* Anthropic 自 4.6 起移除 assistant message prefill（官方 400
       「This model does not support assistant message prefill」；多个独立项目
       已在 4.6 上复现并改为剥离尾部 assistant seed）。
       4.6 仍接受 temperature —— 故只关 prefill，不动 sampling 策略。 */
    'claude-sonnet-4-6': { supportsAssistantPrefill: false },
    'claude-opus-4-6': { supportsAssistantPrefill: false }
  };

  var MODEL_AUDIT = {
    anthropic: { status: 'current', latest: 'claude-sonnet-5', audited: '2026-09-10', evidence: 'https://platform.claude.com/docs/en/about-claude/models/migration-guide' },
    openai: { status: 'deprecation-risk', latest: 'gpt-5.6-luna', audited: '2026-09-10', evidence: 'https://developers.openai.com/api/docs/deprecations' },
    gemini: { status: 'current', latest: 'gemini-3.8-flash', audited: '2026-09-10', evidence: 'https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5' },
    grok: { status: 'current', latest: 'grok-4.6', audited: '2026-09-10', evidence: 'https://docs.x.ai/developers/migration/may-15-retirement' },
    deepseek: { status: 'current', latest: 'deepseek-v4-flash', audited: '2026-09-10', evidence: 'https://api-docs.deepseek.com/zh-cn/' },
    moonshot: { status: 'current', latest: 'kimi-k2.6', audited: '2026-09-10', evidence: 'https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart' },
    mimo: { status: 'current', latest: 'mimo-v2.5', audited: '2026-09-10', evidence: 'https://mimo.mi.com/docs/zh-CN/updates/deprecate' },
    qwen: { status: 'current', latest: 'qwen3.6-plus', audited: '2026-09-10', evidence: 'https://help.aliyun.com/zh/model-studio/qwen-plus' },
    glm: { status: 'current', latest: 'glm-4.7-flash', audited: '2026-09-10', evidence: 'https://docs.bigmodel.cn/' },
    minimax: { status: 'unverified', latest: '', audited: '2026-09-10', evidence: 'https://platform.minimaxi.com/docs/guides/models-intro' },
    doubao: { status: 'deprecation-risk', latest: 'doubao-seed-2-1-turbo', audited: '2026-09-10', evidence: 'https://seed.bytedance.com/zh/blog/seed2-1-officially-released-advancing-ai-productivity' },
    mistral: { status: 'unverified', latest: '', audited: '2026-09-10', evidence: 'https://docs.mistral.ai/' },
    yi: { status: 'unverified', latest: '', audited: '2026-09-10', evidence: '' },
    baichuan: { status: 'unverified', latest: '', audited: '2026-09-10', evidence: '' },
    custom: { status: 'unverified', latest: '', audited: '2026-09-10', evidence: '' }
  };

  /* Anthropic 官方 dated snapshot 命名：<alias>-YYYYMMDD。 */
  var MODEL_DATE_SUFFIX_RE = /-\d{8}$/;

  /* model id → 策略（归一化：先去 dated snapshot 后缀，再精确查表）。 */
  function modelPolicy(model) {
    var id = (model == null ? '' : String(model)).trim();
    if (!id) return MODEL_POLICY_DEFAULTS;
    if (MODEL_POLICIES[id]) return MODEL_POLICIES[id];
    var base = id.replace(MODEL_DATE_SUFFIX_RE, '');
    if (base && MODEL_POLICIES[base]) return MODEL_POLICIES[base];
    return MODEL_POLICY_DEFAULTS;
  }

  /* 该 model 是否接受 temperature / top_p / top_k。
     未知 model → true（与 P18 之前逐位一致），绝不因为查不到就改变行为。 */
  function modelSupportsSamplingParameters(model) {
    return modelPolicy(model).supportsSamplingParameters !== false;
  }

  /* P19 · 该 model 是否接受「最后一条 assistant 消息作为 seed」（assistant prefill）。
     未知 model → true（保留历史行为），与 sampling 共用同一个 modelPolicy 归一化。 */
  function modelSupportsAssistantPrefill(model) {
    return modelPolicy(model).supportsAssistantPrefill !== false;
  }

  /* provider 的新建默认模型（唯一来源 = PROVIDERS）。 */
  function providerDefaultModel(id) {
    var e = providerEntry(id);
    return (e && e.model) || '';
  }

  /* 审计条目（只读快照；缺省 = unverified，绝不假装已核实）。 */
  function modelAuditEntry(id) {
    var key = (id == null ? '' : String(id));
    var e = MODEL_AUDIT[key];
    if (!e) return { provider: key, status: 'unverified', latest: '', evidence: '', audited: '' };
    return { provider: key, status: e.status, latest: e.latest || '', evidence: e.evidence || '', audited: e.audited || '' };
  }

  /* ══════════════════════════════════════════════════════════════════════
     P21 · Reasoning capability（**唯一**一份 provider 思考深度能力真源）
     ----------------------------------------------------------------------
     问题：Middle Brain 的 canonical `reasoningEffort`（auto/low/medium/high/max）
     在哪里变成真实 wire 参数？只在 provider adapter / request builder 边界，
     而**能力事实只允许存在于本文件**（与 endpoint / format / model 同一层）。
     communication.js / Middle Brain 各层 / UI 一律只传 canonical 值 ——
     禁止在那些文件里出现任何一家 provider 的字段名判断。

     ── canonical 档位语义 ──
       auto                 → **永不发送任何字段**（provider 原生自动行为；默认档，
                              请求体逐字节等于本功能上线前）
       low/medium/high/max  → 按下面的能力表翻译；无法翻译时 abstain（不发任何字段），
                              调用方据 plan.fallbackReason 记录原因，绝不猜参数

     ── REASONING_CAPABILITIES（key = provider id）──
       appliesToAllModels  true  = 该能力对该 provider 下所有 model 成立
                           false = 只对 REASONING_MODEL_POLICIES 里逐条取证的 id 成立
       kind    'effort' = 官方档位枚举（values = 官方支持值，取值必须来自 LADDER）
               'budget' = 官方数值预算（budgets = 档位 → token 数；只用于「没有档位枚举、
                          只有 thinking 预算」的 provider）
               toggle / none 类能力不进本表：它们表达不了档位 → 一律 abstain
       verified false = 未取证 → 运行时 abstain（照实登记，绝不按前缀或正则猜）
       wire    wire 摆放：{ responses:[...] | chat:[...] | anthropic:[...] | gemini:[...] }
               值为 body 内的字段路径（数组），由 request builder 按 kind 写入
       evidence / audited = 取证来源与日期（与 MODEL_AUDIT 同一纪律）

     ── REASONING_MODEL_POLICIES（key = 官方 model id，逐条取证）──
       只登记「该 model 自身」的能力；Anthropic 官方 dated snapshot（-YYYYMMDD）
       沿用 modelPolicy 的同一套后缀归一，不做任何其它模糊匹配。

     ── REASONING_PENDING（审计元数据，**不参与运行时判定**）──
       已确知存在 reasoning 入口、但字段摆放或取值枚举尚未取证的 provider。
       它们当前一律 abstain；取证完成后把条目搬进 REASONING_CAPABILITIES 即可
       （搬运是数据改动，不需要碰 request builder）。
     ====================================================================== */

  /* canonical 档位（顺序即强度阶梯；UI 的 5 档与之一一对应）。 */
  var REASONING_TIERS = ['auto', 'low', 'medium', 'high', 'max'];
  /* 官方枚举可能出现而我们没作为档位暴露的值（用于 values 子集的就近降级比较；
     顺序必须包含全部合法官方值，且 low/medium/high/max 的相对次序与 REASONING_TIERS 一致）。 */
  var REASONING_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  var REASONING_CAPABILITIES = {
    /* IB 自有 Responses 端点（Middle Brain 的默认 provider）：Phase 4 既有契约 ——
       reasoning.effort 直传 low/medium/high/max，由 test_middle_brain_advanced.js 锁定。
       这不是第三方 provider 的官方参数承诺，而是 IB 自己的 wire 契约。 */
    astra: {
      verified: true, appliesToAllModels: true, kind: 'effort',
      values: ['low', 'medium', 'high', 'max'],
      wire: { responses: ['reasoning', 'effort'] },
      audited: '2026-09-11',
      evidence: 'IB 自有 Responses 端点（Phase 4 契约；test_middle_brain_advanced.js 锁定）'
    },
  };

  /* OpenAI：Responses 面 `reasoning.effort`、Chat Completions 面 `reasoning_effort`。
     该参数**只对推理型 model 成立**：非推理模型（例如目录默认的 `gpt-4o-mini`）收到它会直接
     400，因此按 model 逐条登记（默认 abstain），沿用 MODEL_POLICIES 的同一纪律 ——
     新增 id 必须逐条取证，绝不按 `gpt-5` 之类前缀推测。
     官方档位枚举随模型代次增加（minimal / none / xhigh…），因此只声明并发送
     low/medium/high 这三个长期稳定的值；max 就近降级为 high 并记录原因。 */
  var OPENAI_REASONING_MODELS = ['gpt-5.6-luna'];

  /* Anthropic：没有档位枚举，只有 extended thinking 的数值预算
     （thinking:{type:'enabled',budget_tokens:N}）。官方硬约束：≥1024 且 < max_tokens。
     只登记已确认支持 extended thinking 的 4.6+/5 系 id（与 MODEL_POLICIES 同一份取证）。 */
  var ANTHROPIC_THINKING_MODELS = ['claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-opus-4-6'];
  var REASONING_MODEL_POLICIES = {};
  OPENAI_REASONING_MODELS.forEach(function (id) {
    REASONING_MODEL_POLICIES[id] = {
      verified: true, kind: 'effort', provider: 'openai',
      values: ['low', 'medium', 'high'],
      wire: { responses: ['reasoning', 'effort'], chat: ['reasoning_effort'] },
      audited: '2026-09-11',
      evidence: 'https://developers.openai.com/api/docs/guides/reasoning?api-mode=responses（推理型 model 专属；非推理模型一律不发送）'
    };
  });
  ANTHROPIC_THINKING_MODELS.forEach(function (id) {
    REASONING_MODEL_POLICIES[id] = {
      verified: true, kind: 'budget', provider: 'anthropic',
      budgets: { low: 1024, medium: 4096, high: 16384, max: 32768 },
      minBudget: 1024,
      wire: { anthropic: ['thinking'] },
      audited: '2026-09-11',
      evidence: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking'
    };
  });

  /* 未取证 → 一律 abstain（运行时绝不发送）。这里只登记「知道有入口、但字段/取值没取证死」的事实，
     供后续取证时一条条搬进上面的表。 */
  var REASONING_PENDING = {
    deepseek: { note: '官方文档存在 Thinking Mode 页；字段摆放（thinking.type / reasoning_effort）与取值枚举未取证', evidence: 'https://api-docs.deepseek.com/guides/thinking_mode/' },
    gemini: { note: 'generationConfig.thinkingConfig 存在，但 thinkingLevel（3.x）与 thinkingBudget（2.5）按代次不同，未逐条取证', evidence: 'https://ai.google.dev/api/generate-content' },
    glm: { note: '官方「深度思考」页确认 thinking 开关存在；档位取值未取证', evidence: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking' },
    qwen: { note: 'enable_thinking / thinking_budget 字段存在；兼容模式下的摆放位置未取证', evidence: 'https://docs.qwencloud.com/developer-guides/text-generation/thinking' },
    minimax: { note: 'thinking 参数存在；wire 细节未取证', evidence: 'https://platform.minimaxi.com/docs/api-reference/text-chat-openai' },
    mimo: { note: 'thinking_type 开关存在（第三方实现交叉印证）；取值域未取证', evidence: 'https://mimo.mi.com/docs/zh-CN/api/chat/responses' },
    custom: { note: '兼容接入：本目录不为其声明任何能力（capabilitiesKnown=false）', evidence: '' }
  };

  function _reasoningStr(v) { return (v == null ? '' : String(v)).trim(); }

  /* canonical 档位归一（唯一实现）：非法 / 缺失 → 'auto'。
     历史档位 'xhigh' 合并进 'high'（新 canonical 集合不再暴露 XHigh）。 */
  function normalizeReasoningTier(v) {
    var s = _reasoningStr(v).toLowerCase();
    if (s === 'xhigh') return 'high';
    return REASONING_TIERS.indexOf(s) >= 0 ? s : 'auto';
  }

  /* model id 归一（与 modelPolicy 共用同一套 dated snapshot 规则）。 */
  function _reasoningModelKey(model) {
    var id = _reasoningStr(model);
    if (!id) return '';
    if (REASONING_MODEL_POLICIES[id]) return id;
    var base = id.replace(MODEL_DATE_SUFFIX_RE, '');
    return (base && REASONING_MODEL_POLICIES[base]) ? base : id;
  }

  /* capability lookup（唯一实现）：model 级逐条取证优先；否则取 provider 级条目，
     但仅当它显式声明 appliesToAllModels===true。查不到 / 未取证 → null（abstain）。 */
  function reasoningCapability(provider, model) {
    var prov = _reasoningStr(provider).toLowerCase();
    var modelId = _reasoningStr(model);
    var key = _reasoningModelKey(modelId);
    var byModel = key ? REASONING_MODEL_POLICIES[key] : null;
    if (byModel && byModel.verified === true) {
      return {
        source: 'model', provider: byModel.provider || prov, model: modelId, kind: byModel.kind,
        values: (byModel.values || []).slice(), budgets: byModel.budgets || null,
        minBudget: byModel.minBudget != null ? byModel.minBudget : 1024,
        wire: byModel.wire || {}, verified: true,
        evidence: byModel.evidence || '', audited: byModel.audited || ''
      };
    }
    var cap = REASONING_CAPABILITIES[prov] || null;
    if (!cap || cap.verified !== true || cap.appliesToAllModels !== true) return null;
    return {
      source: 'provider', provider: prov, model: modelId, kind: cap.kind,
      values: (cap.values || []).slice(), budgets: cap.budgets || null,
      minBudget: cap.minBudget != null ? cap.minBudget : 1024,
      wire: cap.wire || {}, verified: true,
      evidence: cap.evidence || '', audited: cap.audited || ''
    };
  }

  /* 档位 → 官方支持值的就近映射（tie → 更低档，绝不向上越档）。
     返回 null = 该能力下没有任何可表达的值。 */
  function _reasoningNearest(values, tier) {
    var want = REASONING_LADDER.indexOf(tier);
    if (want < 0) return null;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < values.length; i++) {
      var at = REASONING_LADDER.indexOf(String(values[i]));
      if (at < 0) continue;
      var dist = Math.abs(at - want);
      if (dist < bestDist || (dist === bestDist && at < REASONING_LADDER.indexOf(best))) { best = String(values[i]); bestDist = dist; }
    }
    return best;
  }

  /* canonical 档位 → 真实 wire 计划（**纯函数**，无副作用）。
     spec: {provider, model, format, effort, maxTokens}
     返回（字段全部会被 telemetry 记录，绝不包含 prompt / apiKey / body 内容）：
       {requested, effective, wirePath, value, fallbackReason, capability}
       · value === undefined → 不写任何字段（auto / abstain）
       · fallbackReason: '' | 'auto' | 'unverified_provider' | 'format_unsupported'
                        | 'tier_unsupported' | 'tier_downgraded' | 'budget_exceeds_max_tokens'
                        | 'budget_clamped_to_max_tokens'
     format: 'responses' | 'openai'(= Chat Completions) | 'anthropic' | 'gemini'。
     provider/model 由调用方从**本次请求的 spec** 传入（不是 Middle Brain 配置）。 */
  function reasoningWirePlan(spec) {
    spec = spec || {};
    var requested = normalizeReasoningTier(spec.effort);
    var wirePlan = { requested: requested, effective: 'auto', wirePath: [], value: undefined, fallbackReason: '', capability: null };
    if (requested === 'auto') { wirePlan.fallbackReason = 'auto'; return wirePlan; }
    var cap = reasoningCapability(spec.provider, spec.model);
    if (!cap) { wirePlan.fallbackReason = 'unverified_provider'; return wirePlan; }
    wirePlan.capability = cap;
    var fmt = _reasoningStr(spec.format) || 'openai';
    var wireKey = fmt === 'responses' ? 'responses' : (fmt === 'openai' ? 'chat' : fmt);
    var path = (cap.wire && cap.wire[wireKey]) || null;
    if (!path || !path.length) { wirePlan.fallbackReason = 'format_unsupported'; return wirePlan; }
    if (cap.kind === 'effort') {
      var picked = _reasoningNearest(cap.values || [], requested);
      if (!picked) { wirePlan.fallbackReason = 'tier_unsupported'; return wirePlan; }
      wirePlan.effective = normalizeReasoningTier(picked);
      wirePlan.wirePath = path.slice();
      wirePlan.value = picked;
      wirePlan.fallbackReason = picked === requested ? '' : 'tier_downgraded';
      return wirePlan;
    }
    if (cap.kind === 'budget') {
      var want = cap.budgets ? cap.budgets[requested] : null;
      if (want == null) { wirePlan.fallbackReason = 'tier_unsupported'; return wirePlan; }
      var budget = Number(want), clamped = false;
      var maxTokens = Number(spec.maxTokens);
      if (isFinite(maxTokens) && maxTokens > 0 && budget >= maxTokens) {
        budget = Math.floor(maxTokens) - 1;
        clamped = true;
        if (budget < cap.minBudget) { wirePlan.fallbackReason = 'budget_exceeds_max_tokens'; return wirePlan; }
      }
      wirePlan.effective = requested;
      wirePlan.wirePath = path.slice();
      wirePlan.value = { type: 'enabled', budget_tokens: budget };
      wirePlan.fallbackReason = clamped ? 'budget_clamped_to_max_tokens' : '';
      return wirePlan;
    }
    wirePlan.fallbackReason = 'tier_unsupported';
    return wirePlan;
  }

  /* ══════════════════════════════════════════════════════════════════════
     P16 · Provider Onboarding Metadata（**唯一**一份获取/接入元数据）
     ----------------------------------------------------------------------
     定位：这是 onboarding 元数据的 canonical 源，与 PROVIDERS 同层、同文件，
     由 key 关联（key === PROVIDERS 的 provider id），**不复制** provider 核心
     协议配置：endpoint / format / model / vision / streaming 一律只存在于上面的
     PROVIDERS 字面量里，onboarding 条目**不**重复声明这些字段。
     消费方（API 获取向导 / API 编辑器提示 / 设置向导）必须通过本文件的
     onboardingEntry() / officialList() / thirdPartyList() 取数，禁止各自再写一份
     URL、地区提示或教程步骤。

     官方与第三方的身份由这里的显式 metadata 决定（kind 字段 / 两张表分置），
     **不**允许通过域名或字符串猜测。

     ── 字段 ──
     官方条目（OFFICIAL_ONBOARDING，key = provider id）：
       signupUrl  官方平台入口（注册 / 登录）
       apiKeyUrl  创建 / 复制 API Key 的页面（缺失则回落到 signupUrl）
       docsUrl    官方文档（可选）
       regionHint 地区 / 网络影响（一句人话）
       billingHint 是否通常需要充值（一句人话）
       audience   适合什么用户（一句人话）
       guideSteps 3–5 步极简教程（纯字符串数组，不写成长篇文档）
     第三方条目（THIRD_PARTY_SITES，key = 站点 id）：
       kind 恒为 'thirdparty'（官方条目恒为 'official'，由表决定）
       provider 接入时使用的 canonical provider id（例如 'custom' = OpenAI 兼容）
       name / note / siteUrl / apiKeyUrl / docsUrl / regionHint / billingHint /
       audience / guideSteps / tags[]
     ====================================================================== */

  /* P17：官方条目顺序不再单独维护——一律取 PROVIDER_PRESENTATION.order。 */
  var OFFICIAL_ONBOARDING = {
    deepseek: {
      signupUrl: 'https://platform.deepseek.com/',
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
      docsUrl: 'https://api-docs.deepseek.com/',
      regionHint: '国内通常可直接访问。',
      billingHint: '按用量计费，需要先充值；新账号一般有少量赠送额度。',
      audience: '第一次配 API 的国内用户，价格便宜、中文表现好。',
      guideSteps: [
        '打开 DeepSeek 开放平台，用手机号或邮箱注册并登录。',
        '在左侧菜单找到「API keys」。',
        '点「创建 API key」，给 Key 起个名字。',
        '复制弹出的那一串字符（只显示一次，关掉就看不到了）。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    qwen: {
      signupUrl: 'https://bailian.console.aliyun.com/',
      apiKeyUrl: 'https://bailian.console.aliyun.com/',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/',
      regionHint: '国内通常可直接访问，需要阿里云账号。',
      billingHint: '有免费额度，用完后按量计费，需要开通并充值。',
      audience: '已经有阿里云账号、想用通义千问系列的用户。',
      guideSteps: [
        '打开阿里云百炼控制台，用阿里云账号登录（没有就注册一个）。',
        '首次进入按提示开通「百炼」服务。',
        '在右上角头像菜单里找到「API-KEY」，点「创建 API-KEY」。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    glm: {
      signupUrl: 'https://open.bigmodel.cn/',
      apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
      docsUrl: 'https://docs.bigmodel.cn/',
      regionHint: '国内通常可直接访问。',
      billingHint: 'GLM-4-Flash 等小模型有免费额度；更大的模型按量计费，需要充值。',
      audience: '想先零成本试用、或预算有限的用户。',
      guideSteps: [
        '打开智谱开放平台，注册并登录。',
        '进入右上角头像里的「API keys」页面。',
        '点「创建 API key」。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    minimax: {
      signupUrl: 'https://platform.minimaxi.com/',
      apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
      /* P18 核实：官方文档中心（取证页 platform.minimaxi.com/docs/guides/models-intro
         与 /docs/api-reference/text-openai-api）。P17 的纯数据守卫已不再误伤含
         document 的 URL，故此处可以登记。 */
      docsUrl: 'https://platform.minimaxi.com/docs/',
      regionHint: '国内通常可直接访问。',
      billingHint: '按量计费，通常需要先充值。',
      audience: '想用 MiniMax 系列模型或语音能力的用户。',
      guideSteps: [
        '打开 MiniMax 开放平台，注册并登录。',
        '在「账户管理 → 接口密钥」里找到 Key 的位置。',
        '点「新建密钥」。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    moonshot: {
      signupUrl: 'https://platform.moonshot.cn/',
      apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
      docsUrl: 'https://platform.moonshot.cn/docs',
      regionHint: '国内通常可直接访问。',
      billingHint: '按量计费，需要充值；新账号一般有少量赠送额度。',
      audience: '想用 Kimi 系列、看重长文本处理的用户。',
      guideSteps: [
        '打开 Moonshot 开放平台，注册并登录。',
        '在左侧菜单找到「API Key 管理」。',
        '点「新建 API Key」。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    openai: {
      signupUrl: 'https://platform.openai.com/',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
      docsUrl: 'https://platform.openai.com/docs',
      regionHint: '可能受地区或网络环境影响，国内访问通常需要额外条件。',
      billingHint: '按量计费，需要绑卡并预先充值，没有免费额度。',
      audience: '能访问国际网络、有境外支付方式的用户。',
      guideSteps: [
        '打开 OpenAI 平台，注册并登录（可能需要海外手机号）。',
        '在「Settings → Billing」里充值（不充值 Key 会报错）。',
        '进入「API keys」页面，点「Create new secret key」。',
        '复制生成的 Key（只显示一次）。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    anthropic: {
      signupUrl: 'https://console.anthropic.com/',
      apiKeyUrl: 'https://console.anthropic.com/settings/keys',
      docsUrl: 'https://docs.anthropic.com/',
      regionHint: '可能受地区或网络环境影响，国内访问通常需要额外条件。',
      billingHint: '按量计费，需要先充值；部分账号有少量试用额度。',
      audience: '能访问国际网络、想用 Claude 的用户。',
      guideSteps: [
        '打开 Anthropic Console，注册并登录。',
        '在「Billing」里充值。',
        '进入「Settings → API keys」，点「Create Key」。',
        '复制生成的 Key（只显示一次）。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    gemini: {
      signupUrl: 'https://aistudio.google.com/',
      apiKeyUrl: 'https://aistudio.google.com/app/apikey',
      docsUrl: 'https://ai.google.dev/gemini-api/docs',
      regionHint: '可能受地区或网络环境影响，国内访问通常需要额外条件。',
      billingHint: '有免费额度，超出后按量计费；免费额度不需要充值。',
      audience: '能访问国际网络、想先免费试用的用户。',
      guideSteps: [
        '打开 Google AI Studio，用 Google 账号登录。',
        '点左侧的「Get API key」。',
        '点「Create API key」，选一个项目。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    doubao: {
      signupUrl: 'https://console.volcengine.com/ark',
      apiKeyUrl: 'https://console.volcengine.com/ark',
      docsUrl: 'https://www.volcengine.com/docs/82379',
      regionHint: '国内通常可直接访问，需要火山引擎账号并实名。',
      billingHint: '按量计费；新账号通常有赠送额度，用完后需要充值。',
      audience: '已经用火山引擎、想用豆包系列的用户。',
      guideSteps: [
        '打开火山引擎方舟控制台，登录并完成实名认证。',
        '在「API Key 管理」里创建一个 API Key。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    mimo: {
      signupUrl: 'https://platform.xiaomimimo.com/',
      apiKeyUrl: 'https://platform.xiaomimimo.com/',
      regionHint: '国内通常可直接访问。',
      billingHint: '按量计费，以官方页面说明为准。',
      audience: '想试小米 MiMo 系列的用户。',
      guideSteps: [
        '打开小米 MiMo 开放平台，注册并登录。',
        '在控制台里找到 API Key 的位置并创建。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    grok: {
      signupUrl: 'https://console.x.ai/',
      apiKeyUrl: 'https://console.x.ai/team/default/api-keys',
      docsUrl: 'https://docs.x.ai/',
      regionHint: '可能受地区或网络环境影响，国内访问通常需要额外条件。',
      billingHint: '按量计费，需要先充值。',
      audience: '能访问国际网络、想用 Grok 的用户。',
      guideSteps: [
        '打开 xAI Console，登录并完成充值。',
        '进入「API Keys」，点「Create API Key」。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    mistral: {
      signupUrl: 'https://console.mistral.ai/',
      apiKeyUrl: 'https://console.mistral.ai/api-keys',
      docsUrl: 'https://docs.mistral.ai/',
      regionHint: '可能受地区或网络环境影响，国内访问通常需要额外条件。',
      billingHint: '部分模型有免费额度，超出后按量计费。',
      audience: '能访问国际网络、想用 Mistral 的用户。',
      guideSteps: [
        '打开 Mistral Console，注册并登录。',
        '进入「API Keys」，点「Create new key」。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    yi: {
      signupUrl: 'https://platform.lingyiwanwu.com/',
      apiKeyUrl: 'https://platform.lingyiwanwu.com/',
      regionHint: '国内通常可直接访问。',
      billingHint: '按量计费，以官方页面说明为准。',
      audience: '想用零一万物系列的用户。',
      guideSteps: [
        '打开零一万物开放平台，注册并登录。',
        '在控制台里找到 API Key 并创建。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    },
    baichuan: {
      signupUrl: 'https://platform.baichuan-ai.com/',
      apiKeyUrl: 'https://platform.baichuan-ai.com/console/apikey',
      regionHint: '国内通常可直接访问。',
      billingHint: '按量计费，以官方页面说明为准。',
      audience: '想用百川系列的用户。',
      guideSteps: [
        '打开百川智能开放平台，注册并登录。',
        '在控制台的「API Key」页面创建一个 Key。',
        '复制生成的 Key。',
        '回到 IB 粘贴，点「测试连接」。'
      ]
    }
  };

  /* 第三方聚合 / 中转服务（与官方严格分置，永不进 PROVIDERS）。
     这些站点**不是**模型官方运营：IB 只提供兼容接入，不为余额、稳定性、
     安全性或数据处理方式背书。新增 / 删除一个站点只需改这一张表。
     状态标签含义（tags）：
       'compatible'  OpenAI 兼容协议 —— 只是协议层事实
       'verified'    IB 已验证兼容 —— **仅表示调用实际跑通过**，
                     不代表官方、安全或可信背书
       'unverified'  未验证 —— 尚未实际验证过
       'multi-model' 支持多模型 */
  var THIRD_PARTY_SITES = [
    {
      id: 'openrouter',
      kind: 'thirdparty',
      provider: 'custom',
      name: 'OpenRouter',
      note: '第三方聚合服务，并非模型官方运营。它把多家模型接到一个地址上，用一个 Key 就能调用。',
      siteUrl: 'https://openrouter.ai/',
      apiKeyUrl: 'https://openrouter.ai/keys',
      docsUrl: 'https://openrouter.ai/docs',
      regionHint: '国际站点，国内访问可能受地区或网络环境影响。',
      billingHint: '由第三方计费，通常需要先充值，价格以该站点为准。',
      audience: '想一个 Key 试多个模型、并且能访问国际网络的用户。',
      guideSteps: [
        '打开 OpenRouter，注册并登录。',
        '在「Credits」里充值。',
        '进入「Keys」页面，点「Create Key」。',
        '复制生成的 Key。',
        '回到 IB，把它的接口地址填进「接口地址」，粘贴 Key，点「测试连接」。'
      ],
      tags: ['compatible', 'multi-model', 'unverified']
    },
    {
      id: 'custom-relay',
      kind: 'thirdparty',
      provider: 'custom',
      name: '我用的是别家中转 / 自建网关',
      note: '第三方聚合 / 中转服务，并非模型官方运营。任何 OpenAI 兼容的服务都可以填在这里。',
      siteUrl: '',
      apiKeyUrl: '',
      regionHint: '取决于你自己的服务。',
      billingHint: '取决于你自己的服务。',
      audience: '已经买了中转服务，或自己搭了网关（如 one-api / new-api）的用户。',
      guideSteps: [
        '在你购买或搭建的服务里，找到「接口地址」和「API Key」。',
        '接口地址一般要填到完整路径，例如 …/v1/chat/completions。',
        '回到 IB，点「导入 OpenAI Compatible API」。',
        '把接口地址和 Key 填进去，点「测试连接」。'
      ],
      tags: ['compatible', 'unverified']
    }
  ];

  /* 第三方统一风险说明（唯一一份，UI 与测试都从这里取，不各写一版）。 */
  var THIRD_PARTY_RISK = [
    '模型、价格和可用性由第三方决定，IB 不做保证。',
    'API Key 和请求内容可能会经过第三方服务器。',
    'IB 仅提供兼容接入，不为第三方余额、服务稳定性、安全性或数据处理方式背书。'
  ];

  /* 状态标签文案（唯一一份）。'verified' 的措辞只声明协议跑通，不得暗示官方/安全/可信。 */
  var TAG_LABELS = {
    compatible: 'OpenAI Compatible',
    verified: 'IB 已验证兼容',
    unverified: '未验证',
    'multi-model': '支持多模型'
  };

  /* ── P11-0 · provider read-path canonical 层 ──────────────────────────
     本文件是 provider metadata 与 wire-format 判定的**唯一决策点**。
     communication.js / agent-runtime.js / ib-model-core.js / 三个后台域的
     诊断 helper 全部委托到这里，不再各自复制表达式。 */

  /* 目录条目查找（唯一 canonical lookup）。 */
  function providerEntry(provider) {
    return (provider == null ? null : PROVIDERS[provider]) || null;
  }

  /* provider → wire format 决策（唯一 canonical 决策）。
     返回 {format, known, hasFormat}：
       known     —— provider 是否存在于目录（未知 provider 不再静默：调用方可如实标记）
       hasFormat —— 目录条目是否自带 format（缺失时回落 openai，调用方可标注来源）
     与旧表达式 `(PROVIDERS[p] && PROVIDERS[p].format) || 'openai'` 逐值等价：
     15 个条目的 format 均为非空字符串，缺失/未知一律 'openai'。 */
  function resolveProviderFormat(provider) {
    var entry = providerEntry(provider);
    if (entry) {
      var fmt = String(entry.format || '');
      return { format: fmt || 'openai', known: true, hasFormat: !!fmt };
    }
    return { format: 'openai', known: false, hasFormat: false };
  }

  /* provider → wire format（字符串形态；model-client 分支保持一致：anthropic/gemini/else-openai） */
  function providerFormat(provider) {
    return resolveProviderFormat(provider).format;
  }

  /* ── P16 · onboarding 读取（唯一入口；消费方不得再维护第二份 URL / 教程） ──

     onboardingEntry(id)：
       · 官方条目 → { kind:'official', id, ...onboarding 字段 }（**不含**任何协议配置）
       · 第三方条目 → { kind:'thirdparty', id, provider, ... }
       · 未知 id   → null（消费方必须 graceful fallback 到 provider 目录本身） */
  function officialOnboardingEntry(id) {
    if (id == null) return null;
    var e = OFFICIAL_ONBOARDING[String(id)];
    if (!e) return null;
    return {
      kind: 'official', id: String(id),
      signupUrl: e.signupUrl || '', apiKeyUrl: e.apiKeyUrl || '', docsUrl: e.docsUrl || '',
      regionHint: e.regionHint || '', billingHint: e.billingHint || '', audience: e.audience || '',
      guideSteps: (e.guideSteps || []).slice()
    };
  }

  function thirdPartyEntry(id) {
    if (id == null) return null;
    for (var i = 0; i < THIRD_PARTY_SITES.length; i++) {
      if (THIRD_PARTY_SITES[i].id === String(id)) {
        var s = THIRD_PARTY_SITES[i];
        return {
          kind: 'thirdparty', id: s.id, provider: s.provider || 'custom',
          name: s.name || s.id, note: s.note || '',
          signupUrl: s.siteUrl || '', apiKeyUrl: s.apiKeyUrl || '', docsUrl: s.docsUrl || '',
          regionHint: s.regionHint || '', billingHint: s.billingHint || '', audience: s.audience || '',
          guideSteps: (s.guideSteps || []).slice(), tags: (s.tags || []).slice()
        };
      }
    }
    return null;
  }

  function onboardingEntry(id) {
    return officialOnboardingEntry(id) || thirdPartyEntry(id);
  }

  /* ── P17 · presentation 读取（唯一入口；消费方不得再维护顺序 / 文案表） ── */

  /* 单个 provider 的呈现元数据（归一化）。未知 id → null。
     只读呈现字段，**不含**任何协议配置。 */
  function providerPresentation(id) {
    if (id == null) return null;
    var key = String(id);
    if (!PROVIDERS[key]) return null;
    var raw = PROVIDER_PRESENTATION[key] || {};
    return {
      id: key,
      order: typeof raw.order === 'number' ? raw.order : PRESENTATION_DEFAULTS.order,
      group: raw.group || PRESENTATION_DEFAULTS.group,
      kind: raw.kind || PRESENTATION_DEFAULTS.kind,
      shortHint: raw.shortHint || '',
      showInPicker: raw.showInPicker !== false,
      showInSetup: raw.showInSetup !== false,
      showInOnboarding: raw.showInOnboarding !== false,
      capabilitiesKnown: raw.capabilitiesKnown !== false
    };
  }

  /* 按「出现在哪里」取 provider id 列表（顺序 = order → 本表声明顺序）。
     opts.where: 'picker' | 'setup' | 'onboarding'（缺省 picker）
     opts.includeHidden: true 时忽略 showIn* 开关（仅用于测试 / 诊断）。
     'onboarding' 额外排除 kind === 'compatible'：兼容模式不是「一家服务」。 */
  function providerList(opts) {
    var o = opts || {};
    var where = o.where || 'picker';
    var flag = where === 'setup' ? 'showInSetup' : (where === 'onboarding' ? 'showInOnboarding' : 'showInPicker');
    var keys = Object.keys(PROVIDERS), rows = [], out = [], i, p;
    for (i = 0; i < keys.length; i++) {
      p = providerPresentation(keys[i]);
      if (!p) continue;
      if (where === 'onboarding' && p.kind === 'compatible') continue;
      if (o.includeHidden !== true && p[flag] !== true) continue;
      rows.push({ id: p.id, order: p.order, seq: i });
    }
    rows.sort(function (a, b) { return (a.order - b.order) || (a.seq - b.seq); });
    for (i = 0; i < rows.length; i++) out.push(rows[i].id);
    return out;
  }

  function providerPickerList() { return providerList({ where: 'picker' }); }
  function setupProviderList() { return providerList({ where: 'setup' }); }
  function onboardingProviderList() { return providerList({ where: 'onboarding' }); }

  /* 下拉分组（含组内顺序）：[{ group, label, providers:[id] }]，空组不返回。 */
  function pickerGroups() {
    var ids = providerPickerList(), buckets = {}, out = [], i, p, g;
    for (i = 0; i < ids.length; i++) {
      p = providerPresentation(ids[i]);
      if (!p) continue;
      if (!buckets[p.group]) buckets[p.group] = [];
      buckets[p.group].push(p.id);
    }
    for (i = 0; i < GROUP_ORDER.length; i++) {
      g = GROUP_ORDER[i];
      if (buckets[g] && buckets[g].length) {
        out.push({ group: g, label: GROUP_LABELS[g] || g, providers: buckets[g].slice() });
      }
    }
    return out;
  }

  /* 显示名 / 一句话说明 / 新手说明（全部来自 canonical 数据，不重复声明）。 */
  function providerDisplayName(id) {
    var e = providerEntry(id);
    return (e && e.name) || (id == null ? '' : String(id));
  }

  function providerHint(id) {
    var p = providerPresentation(id);
    return p ? p.shortHint : '';
  }

  /* 新手说明：呈现表显式值 → P16 onboarding 的 audience → shortHint。
     这里不复制 audience 文案，避免出现第二份。 */
  function providerBeginnerHint(id) {
    var raw = (id == null ? null : PROVIDER_PRESENTATION[String(id)]) || {};
    if (raw.beginnerHint) return String(raw.beginnerHint);
    var e = officialOnboardingEntry(id);
    if (e && e.audience) return e.audience;
    return providerHint(id);
  }

  /* 本目录是否为该 provider 声明能力（false = 兼容接入，能力由用户填的服务决定）。 */
  function providerCapabilitiesKnown(id) {
    var p = providerPresentation(id);
    return p ? p.capabilitiesKnown : true;
  }

  /* 官方卡片列表 = 目录成员中 showInOnboarding 的（按 presentation order）。
     兼容模式（custom）不是一家服务，永不进入官方列表。 */
  function officialList() {
    return onboardingProviderList();
  }

  function thirdPartyList() {
    var out = [], i;
    for (i = 0; i < THIRD_PARTY_SITES.length; i++) out.push(THIRD_PARTY_SITES[i].id);
    return out;
  }

  /* 身份判定：只依据本文件的 metadata，禁止按域名 / 字符串猜测。
     'official'（目录成员）| 'compatible'（自定义 OpenAI 兼容）| 'thirdparty' | 'unknown' */
  function providerKind(id) {
    if (thirdPartyEntry(id)) return 'thirdparty';
    var p = providerPresentation(id);
    if (p) return p.kind;
    return PROVIDERS[id] ? 'official' : 'unknown';
  }

  return {
    PROVIDERS: PROVIDERS,
    providerEntry: providerEntry,
    resolveProviderFormat: resolveProviderFormat,
    providerFormat: providerFormat,
    /* P17 presentation（keyed metadata，与 PROVIDERS 同源同文件） */
    PROVIDER_PRESENTATION: PROVIDER_PRESENTATION,
    GROUP_ORDER: GROUP_ORDER,
    GROUP_LABELS: GROUP_LABELS,
    providerPresentation: providerPresentation,
    providerList: providerList,
    providerPickerList: providerPickerList,
    setupProviderList: setupProviderList,
    onboardingProviderList: onboardingProviderList,
    pickerGroups: pickerGroups,
    providerDisplayName: providerDisplayName,
    providerHint: providerHint,
    providerBeginnerHint: providerBeginnerHint,
    providerCapabilitiesKnown: providerCapabilitiesKnown,
    /* P16 onboarding（keyed metadata，与 PROVIDERS 同源同文件） */
    OFFICIAL_ONBOARDING: OFFICIAL_ONBOARDING,
    THIRD_PARTY_SITES: THIRD_PARTY_SITES,
    THIRD_PARTY_RISK: THIRD_PARTY_RISK,
    TAG_LABELS: TAG_LABELS,
    onboardingEntry: onboardingEntry,
    officialOnboardingEntry: officialOnboardingEntry,
    thirdPartyEntry: thirdPartyEntry,
    officialList: officialList,
    thirdPartyList: thirdPartyList,
    providerKind: providerKind,
    /* P18 model 时效（keyed metadata，与 PROVIDERS 同源同文件） */
    MODEL_POLICIES: MODEL_POLICIES,
    MODEL_AUDIT: MODEL_AUDIT,
    modelPolicy: modelPolicy,
    modelSupportsSamplingParameters: modelSupportsSamplingParameters,
    modelSupportsAssistantPrefill: modelSupportsAssistantPrefill,
    providerDefaultModel: providerDefaultModel,
    modelAuditEntry: modelAuditEntry,
    /* P21 reasoning 能力（keyed metadata，与 PROVIDERS 同源同文件）：
       能力数据 + 唯一归约函数；request builder 只调用 reasoningWirePlan()。 */
    REASONING_TIERS: REASONING_TIERS,
    REASONING_CAPABILITIES: REASONING_CAPABILITIES,
    REASONING_MODEL_POLICIES: REASONING_MODEL_POLICIES,
    REASONING_PENDING: REASONING_PENDING,
    normalizeReasoningTier: normalizeReasoningTier,
    reasoningCapability: reasoningCapability,
    reasoningWirePlan: reasoningWirePlan
  };
});
