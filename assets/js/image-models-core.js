/* ====================================================================
   IB Image Models Core — 唯一 canonical 图片模型目录（UMD dual-load, runtime-neutral）
   --------------------------------------------------------------------
   存在的理由（P15）：图片模型此前散落在三处 ——
     · image-router-core.js 的 IMAGE_MODELS 双模型字面量
     · workspace.js 执行器里的 `|| 'gpt-image-1'` / `gemini-2.5-flash-image` 回落
     · API 编辑器里手填的 imageGenModel 输入框
   结果是"模型目录里只有 Image 1/2、没有 Image 2.5"，且 UI 与请求体可能不一致。
   本文件是**唯一**的图片模型元数据源：id / 显示名 / provider / 能力（generation|editing）
   / wire format / 尺寸与 quality 白名单 / 双模型档位，全部只在这里定义一次。

   Image 2.5 的真实 model id（已核实，非猜测）：
     · gpt-image-2.5-flare     — 快档
     · gpt-image-2.5-sunburst  — 精修档
   证据：Vercel AI Gateway 的模型页 `models/gpt-image-2.5-sunburst`
   （https://vercel.com/ai-gateway/models/gpt-image-2.5-sunburst）与
   https://vercel.com/changelog/gpt-image-2-5-flare-and-sunburst-now-available-on-ai-gateway ；
   注意部分中转/网关的响应元数据仍回显 2.0，但请求体的 model 字段就是上面的 id。

   本文件**零 window / 零 DOM / 零 fetch / 零 IndexedDB**，只做纯数据与纯函数，
   因此 Node 与浏览器可加载同一份；调用方（Router core / 执行器 / Settings UI）
   一律从这里取模型，不得再维护第二份图片模型数组。

   Browser: <script src="assets/js/image-models-core.js"> → window.IBImageModelsCore
   Node   : require('./assets/js/image-models-core.js')
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBImageModelsCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 能力标签（Generation 下拉只显示 image-generation，Editing 下拉只显示 image-editing） ── */
  var CAPABILITIES = ['image-generation', 'image-editing'];
  var CAPABILITY_LABELS = { 'image-generation': '生成', 'image-editing': '编辑' };

  /* 双模型档位 → 目录 id（Router 的自动策略从这里取，不再硬编码模型名） */
  var TIER_MODEL_IDS = { flare: 'gpt-image-2.5-flare', sunburst: 'gpt-image-2.5-sunburst' };

  /* ── 唯一模型目录 ─────────────────────────────────────────────────────
     字段：
       id          请求体 `model` 字段的**真实值**（UI 显示名与请求体同一条记录）
       label       UI 显示名
       provider    该模型所属的图片服务商（决定 wire format，不再靠模型名正则猜）
       family      家族（用于 Router 的双模型管辖判断）
       tier        双模型档位 'flare' | 'sunburst'（非双模型为 null）
       capabilities 该模型支持的操作（generation / editing）
       wire        每个操作对应的协议：openai_images_generations / openai_images_edits / gemini_inline
       qualities   /images 接口接受的 quality 白名单（空数组 = 该模型不接受 quality）
       sizes       接口接受的 size 白名单
       note        UI 里的一句话说明
     ——新增模型只改这一处；UI 下拉、Router 决策、请求体三处自动同步。 */
  var IMAGE_MODELS = [
    {
      id: 'gpt-image-2.5-flare',
      label: 'GPT Image 2.5 Flare',
      provider: 'openai',
      family: 'gpt-image-2.5',
      tier: 'flare',
      capabilities: ['image-generation', 'image-editing'],
      wire: { generate: 'openai_images_generations', edit: 'openai_images_edits' },
      qualities: ['low', 'medium', 'high', 'auto'],
      sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      note: '快 · 日常生成与轻量修改'
    },
    {
      id: 'gpt-image-2.5-sunburst',
      label: 'GPT Image 2.5 Sunburst',
      provider: 'openai',
      family: 'gpt-image-2.5',
      tier: 'sunburst',
      capabilities: ['image-generation', 'image-editing'],
      wire: { generate: 'openai_images_generations', edit: 'openai_images_edits' },
      qualities: ['low', 'medium', 'high', 'auto'],
      sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      note: '精修 · 高保真 / 参考保持'
    },
    {
      id: 'gpt-image-1',
      label: 'GPT Image 1',
      provider: 'openai',
      family: 'gpt-image',
      tier: null,
      capabilities: ['image-generation', 'image-editing'],
      wire: { generate: 'openai_images_generations', edit: 'openai_images_edits' },
      qualities: ['low', 'medium', 'high', 'auto'],
      sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      note: '上一代 · 兼容性最好'
    },
    {
      id: 'dall-e-3',
      label: 'DALL·E 3',
      provider: 'openai',
      family: 'dall-e',
      tier: null,
      capabilities: ['image-generation'],
      wire: { generate: 'openai_images_generations' },
      qualities: [],
      sizes: ['1024x1024', '1792x1024', '1024x1792'],
      note: '只支持生成，不支持编辑'
    },
    {
      id: 'dall-e-2',
      label: 'DALL·E 2',
      provider: 'openai',
      family: 'dall-e',
      tier: null,
      capabilities: ['image-generation', 'image-editing'],
      wire: { generate: 'openai_images_generations', edit: 'openai_images_edits' },
      qualities: [],
      sizes: ['256x256', '512x512', '1024x1024'],
      note: '老接口 · 编辑走 /images/edits'
    },
    {
      id: 'gemini-2.5-flash-image',
      label: 'Gemini 2.5 Flash Image',
      provider: 'gemini',
      family: 'gemini-image',
      tier: null,
      capabilities: ['image-generation', 'image-editing'],
      wire: { generate: 'gemini_inline', edit: 'gemini_inline' },
      qualities: [],
      sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      note: 'Google · 生成与编辑同一端点'
    }
  ];

  var _byId = {};
  for (var i = 0; i < IMAGE_MODELS.length; i++) _byId[IMAGE_MODELS[i].id] = IMAGE_MODELS[i];

  function _norm(v) { return String(v == null ? '' : v).trim(); }

  /* 模型查找（大小写不敏感，去空白）；未知模型返回 null —— 绝不臆造条目 */
  function imageModel(id) {
    var key = _norm(id).toLowerCase();
    if (!key) return null;
    if (_byId[key]) return _byId[key];
    for (var k in _byId) { if (Object.prototype.hasOwnProperty.call(_byId, k) && k.toLowerCase() === key) return _byId[k]; }
    return null;
  }
  /* canonical id（未知 → 原样返回去空白后的值；是否支持能力由 supportsCapability 判定） */
  function normalizeModelId(id) {
    var m = imageModel(id);
    return m ? m.id : _norm(id);
  }
  function isKnownModel(id) { return !!imageModel(id); }

  /* 操作 → 能力标签（Router 与 UI 共用同一映射） */
  function capabilityForOperation(operation) {
    return _norm(operation).toLowerCase() === 'edit' ? 'image-editing' : 'image-generation';
  }
  /* 请求 → 操作（唯一归一：结构化 operation 优先，其次"有上一张/参考图即编辑"）
     调用方（Router core / 接线层 / 配置层）一律用它，避免各处各写一份判断。 */
  function normalizeOperation(input) {
    var op = _norm(input && input.operation).toLowerCase();
    if (op === 'edit' || op === 'generate') return op;
    var refs = (input && Array.isArray(input.referenceImages)) ? input.referenceImages.filter(Boolean) : [];
    if ((input && input.previousImage) || refs.length) return 'edit';
    return 'generate';
  }

  function supportsCapability(id, capability) {
    var m = imageModel(id);
    if (!m) return false;
    var cap = _norm(capability);
    if (!cap) return true;
    return m.capabilities.indexOf(cap) >= 0;
  }

  /* 能力过滤的模型列表（UI 下拉唯一数据源）
     opts: { capability, provider, tiersOnly } —— 非法/未知 capability 不静默放行，返回空数组 */
  function listImageModels(opts) {
    opts = opts || {};
    var cap = _norm(opts.capability);
    if (cap && CAPABILITIES.indexOf(cap) < 0) return [];
    var prov = _norm(opts.provider).toLowerCase();
    var out = [];
    for (var i = 0; i < IMAGE_MODELS.length; i++) {
      var m = IMAGE_MODELS[i];
      if (cap && m.capabilities.indexOf(cap) < 0) continue;
      if (prov && _norm(m.provider).toLowerCase() !== prov) continue;
      if (opts.tiersOnly === true && !m.tier) continue;
      out.push(m);
    }
    return out;
  }

  /* 双模型档位 → id / 反向查档位 */
  function tierModelId(tier) { return TIER_MODEL_IDS[_norm(tier).toLowerCase()] || ''; }
  function tierOf(id) { var m = imageModel(id); return m && m.tier ? m.tier : null; }

  /* 该模型在该操作下的 wire format（未知模型/不支持的操作 → null，调用方必须如实失败） */
  function wireFor(id, operation) {
    var m = imageModel(id);
    if (!m || !m.wire) return null;
    var op = _norm(operation).toLowerCase() === 'edit' ? 'edit' : 'generate';
    return m.wire[op] || null;
  }
  function supportsOperation(id, operation) {
    return supportsCapability(id, capabilityForOperation(operation));
  }
  /* 模型 → 请求体 model 字段（唯一出口：UI 显示名与请求体同一条记录） */
  function requestModelId(id) {
    var m = imageModel(id);
    return m ? m.id : _norm(id);
  }
  function modelLabel(id) {
    var m = imageModel(id);
    return m ? m.label : _norm(id);
  }
  function qualitiesFor(id) { var m = imageModel(id); return m ? m.qualities.slice() : []; }
  function sizesFor(id) { var m = imageModel(id); return m ? m.sizes.slice() : []; }

  return {
    CAPABILITIES: CAPABILITIES,
    CAPABILITY_LABELS: CAPABILITY_LABELS,
    TIER_MODEL_IDS: TIER_MODEL_IDS,
    IMAGE_MODELS: IMAGE_MODELS,
    imageModel: imageModel,
    normalizeModelId: normalizeModelId,
    isKnownModel: isKnownModel,
    capabilityForOperation: capabilityForOperation,
    normalizeOperation: normalizeOperation,
    supportsCapability: supportsCapability,
    supportsOperation: supportsOperation,
    listImageModels: listImageModels,
    tierModelId: tierModelId,
    tierOf: tierOf,
    wireFor: wireFor,
    requestModelId: requestModelId,
    modelLabel: modelLabel,
    qualitiesFor: qualitiesFor,
    sizesFor: sizesFor
  };
});
