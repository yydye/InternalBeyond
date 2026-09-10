/* ====================================================================
   IB Image Router Core — 统一图片策略层（UMD dual-load, runtime-neutral）
   --------------------------------------------------------------------
   定位（按真实代码边界，不为了画图改架构）：

     producers (Chat / Moments / AI Moments / 未来 Blog·Diary·Activity·Edit)
            ↓
        Image Router        ← 本文件：任务识别 → 模型选择 → quality → priority
            ↓
        Image Scheduler     ← 本文件：global / model / character 并发 + 优先级队列
            ↓
       现有 executor _wsExecImageGen（assets/js/workspace.js，唯一 provider 执行器）
            ↓
        Provider API → 现有图片存储/UI（aiMsg.images / ICode 归档）

   **本文件绝不复制 provider executor**：不发 fetch、不碰 DOM、不碰 IndexedDB、
   不维护第二份 provider metadata。执行器、时间源、用户策略全部由调用方注入，
   因此可在纯 Node 下做确定性并发/路由测试。

   Browser: <script src="assets/js/image-router-core.js"> → window.IBImageRouterCore
   Node   : require('./assets/js/image-router-core.js')
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./image-models-core.js')); }
  else { root.IBImageRouterCore = factory(root.IBImageModelsCore); }
})(typeof self !== 'undefined' ? self : this, function (MODELS) {
  'use strict';

  /* ── ① 模型与模式（集中配置，禁止在调用点散落模型字符串） ────────────── */
  var IMAGE_MODES = ['auto', 'fast', 'precision'];
  var IMAGE_MODE_DEFAULT = 'auto';
  var IMAGE_MODE_LABELS = { auto: 'Auto', fast: 'Fast', precision: 'Precision' };
  /* GPT Image 2.5 双模型：Flare = 快/日常；Sunburst = 精修/高保真。
     模型 id 不再写死在这里 —— 唯一 canonical 来源是 assets/js/image-models-core.js
     （Node 下 require，浏览器下 window.IBImageModelsCore）。目录缺失时**不静默**：
     双模型策略直接不可用（policy 退化为 provider_managed），调用方与测试能立刻看到。 */
  var IMAGE_MODELS = MODELS ? {
    flare: MODELS.tierModelId('flare'),
    sunburst: MODELS.tierModelId('sunburst')
  } : { flare: '', sunburst: '' };
  var IMAGE_MODEL_KINDS = ['flare', 'sunburst'];
  /* 双模型策略只治理 gpt-image 家族：配置为空（执行器回落 gpt-image-1）或
     显式 gpt-image* → 由 Router 决策；dall-e / flux / 自定义模型 → 交给用户配置
     （provider_managed，绝不偷偷改用户填的模型，避免把能用的配置改成不可用）。 */
  var GPT_IMAGE_FAMILY = /^gpt-image/i;
  /* 与 _wsExecImageGen 的能力边界逐字一致：这三家没有生图能力 */
  var IMAGE_UNSUPPORTED_PROVIDERS = ['anthropic', 'deepseek', 'gemini'];

  /* ── ② 优先级（数值越小越优先；后台最多通过 aging 提升到 P1，永不超过 P0） ── */
  var IMAGE_PRIORITY = { USER_EDIT: 0, USER_GENERATE: 1, FOREGROUND: 2, BACKGROUND: 3 };
  var IMAGE_PRIORITY_NAMES = ['P0', 'P1', 'P2', 'P3'];

  /* ── ③ 唯一资源与队列配置（Phase 4 默认策略；所有 magic number 只在这里） ── */
  var IMAGE_ROUTER_DEFAULTS = {
    /* 并发 */
    maxConcurrent: 2,            /* 全局：任何时刻最多 2 个图片请求真正执行 */
    maxFlareConcurrent: 2,       /* Flare：最多 2（仍受 global=2 限制） */
    maxSunburstConcurrent: 1,    /* Sunburst：最多 1 */
    perCharacterConcurrent: 1,   /* 同一角色最多 1 个图片任务执行 */
    /* 队列 */
    queueLimit: 8,               /* 排队上限：达到上限不再堆积 */
    /* 防饥饿：等待每满 agingStepMs 提升 1 级，最多提升 agingMaxBoost 级 */
    agingStepMs: 8000,
    agingMaxBoost: 2,
    /* 重复合并窗口（相同 character+source+prompt+operation+reference 只保留一个） */
    coalesceWindowMs: 8000,
    /* 后台保护 */
    backgroundCooldownMs: 15000, /* 同一角色后台生成冷却 */
    downgradeAfterWaitMs: 30000, /* 后台 Sunburst 排队超时 → Auto 降级 Flare */
    /* 观测 */
    telemetryLimit: 50,
    debug: false
  };

  /* ── ④ 文本线索（只是**次要**信号，结构化字段优先；不单独作为判定依据） ── */
  var PRECISION_TEXT_HINTS = [
    '精修', '最高质量', '高保真', '高精度', '不要改变其他地方', '不要改变其他区域', '其他区域不变',
    '其他地方完全不要动', '其他都不要动', '保持人物一致', '保持角色一致', '保持构图', '保持原样',
    '只改', '只把', '局部修改', '一模一样', '原样保留', '不要动', '完全不要动',
    'high fidelity', 'highest quality', 'keep everything else', 'preserve identity', 'only change'
  ];

  function _norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function _clampInt(v, lo, hi, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    n = Math.floor(n);
    return Math.max(lo, Math.min(hi, n));
  }
  function _mergeCfg(options) {
    var out = {};
    for (var k in IMAGE_ROUTER_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(IMAGE_ROUTER_DEFAULTS, k)) out[k] = IMAGE_ROUTER_DEFAULTS[k];
    }
    if (options && typeof options === 'object') {
      for (var k2 in options) {
        if (!Object.prototype.hasOwnProperty.call(options, k2)) continue;
        if (!Object.prototype.hasOwnProperty.call(IMAGE_ROUTER_DEFAULTS, k2)) continue;
        out[k2] = options[k2];
      }
    }
    /* 数值归一：非法值一律回默认，绝不让 0/NaN 把并发锁死 */
    out.maxConcurrent = _clampInt(out.maxConcurrent, 1, 32, IMAGE_ROUTER_DEFAULTS.maxConcurrent);
    out.maxFlareConcurrent = _clampInt(out.maxFlareConcurrent, 1, 32, IMAGE_ROUTER_DEFAULTS.maxFlareConcurrent);
    out.maxSunburstConcurrent = _clampInt(out.maxSunburstConcurrent, 1, 32, IMAGE_ROUTER_DEFAULTS.maxSunburstConcurrent);
    out.perCharacterConcurrent = _clampInt(out.perCharacterConcurrent, 1, 32, IMAGE_ROUTER_DEFAULTS.perCharacterConcurrent);
    out.queueLimit = _clampInt(out.queueLimit, 1, 256, IMAGE_ROUTER_DEFAULTS.queueLimit);
    out.agingStepMs = _clampInt(out.agingStepMs, 0, 600000, IMAGE_ROUTER_DEFAULTS.agingStepMs);
    out.agingMaxBoost = _clampInt(out.agingMaxBoost, 0, 3, IMAGE_ROUTER_DEFAULTS.agingMaxBoost);
    out.coalesceWindowMs = _clampInt(out.coalesceWindowMs, 0, 600000, IMAGE_ROUTER_DEFAULTS.coalesceWindowMs);
    out.backgroundCooldownMs = _clampInt(out.backgroundCooldownMs, 0, 600000, IMAGE_ROUTER_DEFAULTS.backgroundCooldownMs);
    out.downgradeAfterWaitMs = _clampInt(out.downgradeAfterWaitMs, 0, 3600000, IMAGE_ROUTER_DEFAULTS.downgradeAfterWaitMs);
    out.telemetryLimit = _clampInt(out.telemetryLimit, 1, 500, IMAGE_ROUTER_DEFAULTS.telemetryLimit);
    return out;
  }

  function normalizeImageMode(v) {
    var s = _norm(v);
    return IMAGE_MODES.indexOf(s) >= 0 ? s : IMAGE_MODE_DEFAULT;
  }
  function normalizePriority(v) {
    var n = Number(v);
    if (!isFinite(n)) return IMAGE_PRIORITY.FOREGROUND;
    n = Math.floor(n);
    return Math.max(IMAGE_PRIORITY.USER_EDIT, Math.min(IMAGE_PRIORITY.BACKGROUND, n));
  }
  function priorityName(p) { return IMAGE_PRIORITY_NAMES[normalizePriority(p)] || 'P2'; }

  /* ── ⑤ 任务识别（结构化信号优先，文本线索只做补充） ─────────────────── */
  function _refImages(opts) {
    var a = opts && opts.referenceImages;
    return Array.isArray(a) ? a.filter(function (x) { return !!x; }) : [];
  }
  function _hasPrecisionHint(prompt) {
    var s = _norm(prompt);
    if (!s) return false;
    for (var i = 0; i < PRECISION_TEXT_HINTS.length; i++) {
      if (s.indexOf(_norm(PRECISION_TEXT_HINTS[i])) >= 0) return true;
    }
    return false;
  }
  /* 请求 → 操作（唯一归一在 image-models-core；目录未加载时用等价最小兜底） */
  function normalizeImageOperation(opts) {
    if (MODELS && typeof MODELS.normalizeOperation === 'function') return MODELS.normalizeOperation(opts);
    var op = _norm(opts && opts.operation).toLowerCase();
    if (op === 'edit' || op === 'generate') return op;
    return ((opts && opts.previousImage) || _refImages(opts).length) ? 'edit' : 'generate';
  }
  /* 返回结构化任务画像：{ taskKind, precision, strictReference, signals, reasons } */
  function classifyImageTask(opts) {
    opts = opts || {};
    var refs = _refImages(opts);
    var operation = _norm(opts.operation) || 'generate';
    var editing = operation === 'edit' || refs.length > 0 || !!opts.previousImage;
    var signals = {
      operation: operation,
      referenceCount: refs.length,
      multiReference: refs.length >= 2,
      hasPreviousImage: !!opts.previousImage,
      multiTurn: opts.multiTurn === true || _clampInt(opts.multiTurnEdits, 0, 99, 0) >= 1,
      identityPreservation: opts.identityPreservation === true,
      finalProduct: opts.finalProduct === true,
      requestedQuality: _norm(opts.requestedQuality),
      textHint: _hasPrecisionHint(opts.prompt)
    };
    var reasons = [];
    /* 严格参考保持：有参考图 / 明确 identity 要求 / 编辑上一轮成图 */
    var strictReference = signals.referenceCount > 0 || signals.identityPreservation || signals.hasPreviousImage;
    if (signals.referenceCount > 0) reasons.push('reference_image');
    if (signals.multiReference) reasons.push('multi_reference');
    if (signals.hasPreviousImage) reasons.push('edit_previous_image');
    if (signals.identityPreservation) reasons.push('identity_preservation');
    if (signals.finalProduct) reasons.push('final_product');
    if (signals.multiTurn) reasons.push('multi_turn_edit');
    if (signals.requestedQuality === 'high') reasons.push('requested_high_quality');
    if (signals.textHint) reasons.push('precision_text_hint');

    var precision = strictReference || signals.multiReference || signals.finalProduct
      || signals.multiTurn || signals.requestedQuality === 'high' || signals.textHint;
    var taskKind = editing ? (precision ? 'precision_edit' : 'simple_edit') : (precision ? 'precision_generate' : 'generate');
    return { taskKind: taskKind, precision: precision, strictReference: strictReference, signals: signals, reasons: reasons };
  }

  /* ── ⑥ 模型选择（用户显式选择 > Auto Router；绝不偷偷升级/降级） ─────── */
  function _providerManaged(provider) {
    var p = _norm(provider);
    return IMAGE_UNSUPPORTED_PROVIDERS.indexOf(p) >= 0;
  }
  /* 双模型策略是否管辖这次请求（provider 支持 + 模型属于 gpt-image 家族）
     provider == null 表示"拿不到 canonical 图片 provider 推断"→ 不碰用户配置（provider_managed） */
  function policyApplies(provider, configuredModel) {
    if (provider === null || provider === undefined) return false;
    if (_providerManaged(provider)) return false;
    var m = String(configuredModel == null ? '' : configuredModel).trim();
    if (!m) return true;
    return GPT_IMAGE_FAMILY.test(m);
  }
  /* 目录能力校验：显式选定的模型必须真实存在于唯一模型目录，且支持当前操作。
     返回 '' | 'IMAGE_MODEL_UNKNOWN' | 'IMAGE_MODEL_CAPABILITY'（纯函数，供 Router 与测试共用）。 */
  function imageModelProblem(modelId, operation) {
    if (!MODELS) return '';
    var id = String(modelId == null ? '' : modelId).trim();
    if (!id) return '';
    var entry = MODELS.imageModel(id);
    if (!entry) return 'IMAGE_MODEL_UNKNOWN';
    var cap = MODELS.capabilityForOperation(normalizeImageOperation({ operation: operation }));
    return MODELS.supportsCapability(entry.id, cap) ? '' : 'IMAGE_MODEL_CAPABILITY';
  }

  /* decideImageRoute(opts, ctx) → 决策（纯函数，无副作用，可确定性测试）
     ctx: { userMode, provider, configuredModel } */
  function decideImageRoute(opts, ctx) {
    opts = opts || {}; ctx = ctx || {};
    var classification = classifyImageTask(opts);
    var requestedMode = _norm(opts.requestedMode);
    var perRequest = IMAGE_MODES.indexOf(requestedMode) >= 0 ? requestedMode : '';
    /* 用户显式选择优先级最高：请求级 fast/precision > 全局用户策略（Middle Brain）> auto */
    var userMode = normalizeImageMode((perRequest && perRequest !== 'auto') ? perRequest : ctx.userMode);
    var explicit = userMode === 'fast' || userMode === 'precision';
    var applies = policyApplies(ctx.provider, ctx.configuredModel);
    var priority = decideImagePriority(opts);
    var background = priority === IMAGE_PRIORITY.BACKGROUND;
    var quality = _norm(opts.requestedQuality);
    if (quality !== 'low' && quality !== 'medium' && quality !== 'high') quality = 'auto';

    /* 用户在 Image Router 里显式选定模型 → 最高优先：Fast/Precision 覆盖不能改它，
       双模型策略也不接管（否则"改模型后请求体没变"，UI 与执行链就会分裂）。
       modelKind 只用于并发桶（flare/sunburst 档位），非双模型目录条目 → null → flare 桶。 */
    var routeModel = String(ctx.routeModel == null ? '' : ctx.routeModel).trim();
    if (routeModel) {
      var routeEntry = MODELS ? MODELS.imageModel(routeModel) : null;
      var routeKind = routeEntry && routeEntry.tier ? routeEntry.tier : null;
      if (quality === 'auto' && routeKind === 'sunburst') quality = 'high';
      return {
        mode: userMode, policy: 'route_model', modelKind: routeKind,
        model: routeEntry ? routeEntry.id : routeModel,
        quality: quality, priority: priority, priorityName: priorityName(priority),
        background: background, downgradable: false, routeReason: 'route_model_configured',
        classification: classification
      };
    }

    if (!applies) {
      /* provider 自管模型（gemini / dall-e / 自定义）：只做并发与优先级，不改模型 */
      return {
        mode: userMode, policy: 'provider_managed', modelKind: null,
        model: String(ctx.configuredModel == null ? '' : ctx.configuredModel).trim(),
        quality: quality, priority: priority, priorityName: priorityName(priority),
        background: background, downgradable: false,
        routeReason: _providerManaged(ctx.provider) ? 'provider_unsupported_model' : 'provider_managed_model',
        classification: classification
      };
    }

    var modelKind, routeReason, downgradable = false;
    if (explicit) {
      /* 用户显式选择：Fast 永不升级，Precision 永不降级 */
      modelKind = userMode === 'fast' ? 'flare' : 'sunburst';
      routeReason = userMode === 'fast' ? 'user_fast_override' : 'user_precision_override';
    } else if (classification.precision) {
      modelKind = 'sunburst';
      routeReason = classification.reasons[0] || 'precision_task';
      /* 后台且无严格参考要求 → 排队过久可降级 Flare（Phase 8） */
      downgradable = background && !classification.strictReference;
    } else {
      modelKind = 'flare';
      routeReason = classification.taskKind === 'simple_edit' ? 'simple_edit'
        : (background ? 'background_generation' : 'standard_generation');
    }
    if (quality === 'auto' && modelKind === 'sunburst') quality = 'high';
    return {
      mode: userMode, policy: 'dual_model', modelKind: modelKind, model: IMAGE_MODELS[modelKind],
      quality: quality, priority: priority, priorityName: priorityName(priority),
      background: background, downgradable: downgradable, routeReason: routeReason,
      classification: classification
    };
  }

  /* 优先级：P0 用户主动编辑 > P1 用户主动生成 > P2 当前聊天/Activity 内任务 > P3 后台 */
  function decideImagePriority(opts) {
    opts = opts || {};
    var operation = _norm(opts.operation) || 'generate';
    if (opts.userInitiated === true) {
      return operation === 'edit' ? IMAGE_PRIORITY.USER_EDIT : IMAGE_PRIORITY.USER_GENERATE;
    }
    return opts.background === true ? IMAGE_PRIORITY.BACKGROUND : IMAGE_PRIORITY.FOREGROUND;
  }

  /* ── ⑦ 拒绝码 → 用户可读原因（producers 共用；不泄露内部术语/接口细节） ── */
  var IMAGE_REJECT_TEXT = {
    IMAGE_QUEUE_OVERFLOW: '当前图片任务较多，本次生成未能排队，请稍后重试',
    IMAGE_QUEUE_EVICTED: '当前图片任务较多，本次后台生成已被取消',
    IMAGE_BACKGROUND_COOLDOWN: '该角色刚刚生成过图片，请稍后再试',
    IMAGE_ABORTED: '图片生成已取消',
    IMAGE_TIMEOUT: '图像生成超时，请稍后重试',
    IMAGE_NO_ROUTER: '图片路由未就绪，请重启应用后重试',
    IMAGE_NO_EXECUTOR: '图片执行器未就绪，请重启应用后重试',
    IMAGE_NO_CONFIG: '当前入口不支持图像生成（缺少 API 配置上下文）',
    IMAGE_EMPTY_PROMPT: '缺少提示词（prompt 属性为空）',
    IMAGE_EXECUTOR_ERROR: '图像服务暂时不可用，请稍后重试',
    IMAGE_EMPTY_RESULT: '图像服务没有返回结果，请稍后重试',
    /* P13 · 图片编辑 / 参考图（与 image-edit-core 的文案保持一致） */
    IMAGE_EDIT_NO_SOURCE: '当前会话里没有可编辑的图片，请先生成一张，或选中要修改的图片',
    IMAGE_EDIT_UNSUPPORTED: '当前图片模型不支持编辑这张图片',
    IMAGE_REFERENCE_INVALID: '这张图片无法用作编辑参考（格式不受支持或内容为空）',
    IMAGE_REFERENCE_TOO_LARGE: '图片太大，无法作为编辑参考',
    IMAGE_REFERENCE_LIMIT: '参考图数量超出上限',
    IMAGE_EDIT_ABORTED: '图片编辑已取消',
    IMAGE_EDIT_TIMEOUT: '图片编辑超时，请稍后重试',
    IMAGE_PROVIDER_ERROR: '图片服务暂时不可用，请稍后重试',
    /* P15 · Image Router 配置层（每条都告诉用户"去哪里修"） */
    IMAGE_ROUTER_DISABLED: '图片功能已关闭，可在 设置 → API → Image Router 中开启',
    IMAGE_ROUTER_UNBOUND: '尚未配置图片 API。请前往 设置 → API → Image Router 绑定一个 API 配置',
    IMAGE_ROUTER_CONFIG_MISSING: '绑定的 API 配置不存在（可能已被删除）。请前往 设置 → API → Image Router 重新选择',
    IMAGE_ROUTER_NO_KEY: '图片 API 缺少 API Key。请前往 设置 → API → Image Router（或该角色的 API 设置）补齐',
    IMAGE_ROUTER_NO_ENDPOINT: '图片 API 缺少接口地址。请前往 设置 → API → Image Router（或该角色的 API 设置）补齐',
    IMAGE_ROUTER_PROVIDER_UNSUPPORTED: '当前 API 配置的服务商不支持图像生成。请前往 设置 → API → Image Router 改绑 OpenAI 兼容或 Gemini',
    IMAGE_ROUTER_ERROR: '图片路由配置读取失败，请重启应用后重试',
    IMAGE_MODEL_CAPABILITY: '所选图片模型不支持这个操作。请前往 设置 → API → Image Router 更换模型',
    IMAGE_MODEL_UNKNOWN: '所选图片模型不在支持的模型目录中。请前往 设置 → API → Image Router 重新选择'
  };
  function imageRejectText(result) {
    if (!result) return '生成失败';
    var code = String(result.code || '');
    if (IMAGE_REJECT_TEXT[code]) return IMAGE_REJECT_TEXT[code];
    return String(result.reason || '生成失败');
  }

  /* 备用通道可重试的失败类别：只重试"provider / 执行器层面"的失败。
     输入与配置类错误（缺 Key、模型不支持、空提示词、被取消、超时）绝不重试——
     否则会把一次明确的配置问题变成两次无意义的等待。 */
  var IMAGE_FALLBACK_CODES = ['IMAGE_PROVIDER_ERROR', 'IMAGE_EXECUTOR_ERROR', 'IMAGE_EMPTY_RESULT'];
  function imageFallbackEligible(code) { return IMAGE_FALLBACK_CODES.indexOf(String(code || '')) >= 0; }
  var _fallbackEligible = imageFallbackEligible;

  /* ── ⑧ 重复合并 key（不做复杂 hash：长度 + 前缀即可区分） ───────────── */
  function imageCoalesceKey(opts, modelKind) {
    opts = opts || {};
    var refs = _refImages(opts).map(function (u) {
      var s = String(u || '');
      return s.length + ':' + s.slice(0, 24);
    }).join('|');
    return [String(opts.characterId || ''), String(opts.source || ''), _norm(opts.operation) || 'generate',
      String(modelKind || ''), String(opts.prompt || '').trim(), refs].join('\u0001');
  }

  /* ── ⑧ Image Scheduler：global / model / character 并发 + 优先级队列 ────
     task = {
       modelKind: 'flare' | 'sunburst',
       characterId, priority, background, coalesceKey,
       downgradable: bool, signal: AbortSignal | null,
       run(dispatchInfo) → Promise<result>,
       onDispatch(dispatchInfo) → void
     }
     enqueue(task) → Promise<result>（永不 reject：失败也是 {ok:false, code, reason}） */
  function createImageScheduler(options) {
    var cfg = _mergeCfg(options);
    var now = (options && options.now) || function () { return Date.now(); };
    /* 定时器可注入（测试用假时钟）；unref 保证定时器永远不会让进程/页面无法退出 */
    var setT = (options && options.setTimeout) || (typeof setTimeout === 'function' ? setTimeout : null);
    var clearT = (options && options.clearTimeout) || (typeof clearTimeout === 'function' ? clearTimeout : null);
    var queue = [];              /* 待执行 */
    var running = [];            /* 已派发：{ task, modelKind } */
    var lastBackgroundAt = {};   /* characterId → 最近一次后台派发时间 */
    var seq = 0;
    var timer = null;            /* 后台 Sunburst 降级到期的单次唤醒定时器（自清理） */
    var stats = { enqueued: 0, dispatched: 0, completed: 0, failed: 0, rejected: 0, coalesced: 0, downgraded: 0, evicted: 0 };

    function _defer() {
      var d = {};
      d.promise = new Promise(function (res, rej) { d.resolve = res; d.reject = rej; });
      return d;
    }
    function _countRunning(modelKind) {
      var n = 0;
      for (var i = 0; i < running.length; i++) if (running[i].modelKind === modelKind) n++;
      return n;
    }
    function _countRunningChar(characterId) {
      if (!characterId) return 0;
      var n = 0;
      for (var i = 0; i < running.length; i++) if (running[i].task.characterId === characterId) n++;
      return n;
    }
    function _modelMax(modelKind) {
      return modelKind === 'sunburst' ? cfg.maxSunburstConcurrent : cfg.maxFlareConcurrent;
    }
    function _canRun(task, modelKind) {
      if (running.length >= cfg.maxConcurrent) return false;
      if (_countRunning(modelKind) >= _modelMax(modelKind)) return false;
      if (_countRunningChar(task.characterId) >= cfg.perCharacterConcurrent) return false;
      return true;
    }
    /* 防饥饿：等待越久有效优先级越高，但最多提升 agingMaxBoost 级（后台永远到不了 P0） */
    function _effectivePriority(base, waitMs) {
      if (!cfg.agingStepMs) return base;
      var boost = Math.floor(Math.max(0, waitMs) / cfg.agingStepMs);
      boost = Math.min(boost, cfg.agingMaxBoost);
      return Math.max(IMAGE_PRIORITY.USER_EDIT, base - boost);
    }
    function _removeFromQueue(task) {
      var i = queue.indexOf(task);
      if (i >= 0) queue.splice(i, 1);
      return i >= 0;
    }
    function _settle(task, result) {
      if (task._settled) return;
      task._settled = true;
      task._resolve(result);
    }
    function _rejectResult(task, code, reason) {
      stats.rejected++;
      return {
        ok: false, code: code, reason: reason, via: 'scheduler',
        model: task.model, priority: task.priority, priorityName: priorityName(task.priority)
      };
    }
    function _release(task) {
      for (var i = 0; i < running.length; i++) {
        if (running[i].task === task) { running.splice(i, 1); break; }
      }
    }
    function _unbindAbort(task) {
      if (!task.signal || !task._abortHandler) return;
      try { task.signal.removeEventListener('abort', task._abortHandler); } catch (e) {}
      task._abortHandler = null;
    }
    function _bindAbort(task) {
      if (!task.signal || typeof task.signal.addEventListener !== 'function') return;
      if (task.signal.aborted) { _cancelQueued(task); return; }
      task._abortHandler = function () {
        if (task._dispatched) return;   /* 已派发 → 由 executor 自己的 AbortController 负责 */
        _cancelQueued(task);
      };
      try { task.signal.addEventListener('abort', task._abortHandler); } catch (e) {}
    }
    function _cancelQueued(task) {
      if (task._dispatched || task._settled) return;
      task.cancelled = true;
      _removeFromQueue(task);
      _unbindAbort(task);
      _settle(task, _rejectResult(task, 'IMAGE_ABORTED', 'aborted_before_dispatch'));
      _pump();
    }
    /* 队列溢出：优先顶掉最低优先级的后台任务；来者不比最差的好就拒绝来者 */
    function _overflowVictim(incoming) {
      var worst = null;
      for (var i = 0; i < queue.length; i++) {
        var t = queue[i];
        if (t._settled) continue;
        if (!worst || t.priority > worst.priority || (t.priority === worst.priority && t.id > worst.id)) worst = t;
      }
      if (!worst) return null;
      return incoming.priority < worst.priority ? worst : null;
    }
    function _findCoalesce(task) {
      if (!task.coalesceKey || !cfg.coalesceWindowMs) return null;
      var t = now();
      var pools = [queue, running.map(function (r) { return r.task; })];
      for (var p = 0; p < pools.length; p++) {
        for (var i = 0; i < pools[p].length; i++) {
          var cand = pools[p][i];
          if (!cand || cand === task || cand._settled || cand.cancelled) continue;
          if (cand.coalesceKey !== task.coalesceKey) continue;
          if (t - cand.enqueuedAt > cfg.coalesceWindowMs) continue;
          return cand;
        }
      }
      return null;
    }
    function _pickRunnable() {
      var t = now();
      var best = null;
      for (var i = 0; i < queue.length; i++) {
        var task = queue[i];
        if (task._settled || task.cancelled) continue;
        var wait = Math.max(0, t - task.enqueuedAt);
        var eff = _effectivePriority(task.priority, wait);
        var kind = task.modelKind;
        var downgrade = false;
        /* 只在 Sunburst 槽位真正挡路、且 Flare 槽位可用时降级；能跑 Sunburst 就不降级 */
        if (kind === 'sunburst' && task.downgradable && wait >= cfg.downgradeAfterWaitMs &&
            !_canRun(task, 'sunburst') && _canRun(task, 'flare')) {
          downgrade = true; kind = 'flare';
        }
        if (!_canRun(task, kind)) continue;
        if (!best || eff < best.eff || (eff === best.eff && task.id < best.task.id)) {
          best = { task: task, eff: eff, wait: wait, downgrade: downgrade, modelKind: kind };
        }
      }
      return best;
    }
    function _dispatch(cand) {
      var task = cand.task;
      _removeFromQueue(task);
      task._dispatched = true;
      task.queueWaitMs = cand.wait;
      task.downgraded = cand.downgrade;
      task.dispatchedModelKind = cand.modelKind;
      if (cand.downgrade) stats.downgraded++;
      running.push({ task: task, modelKind: cand.modelKind });
      stats.dispatched++;
      if (task.background) lastBackgroundAt[task.characterId] = now();
      _unbindAbort(task);
      var info = {
        priority: task.priority, priorityName: priorityName(task.priority), effectivePriority: cand.eff,
        queueWaitMs: task.queueWaitMs, downgraded: task.downgraded,
        modelKind: cand.modelKind, queueDepth: queue.length, running: running.length
      };
      if (typeof task.onDispatch === 'function') { try { task.onDispatch(info); } catch (e) {} }
      Promise.resolve().then(function () { return task.run(info); }).then(function (result) {
        if (result && result.ok) stats.completed++; else stats.failed++;
        _release(task);
        _settle(task, result && typeof result === 'object' ? result : { ok: false, code: 'IMAGE_EMPTY_RESULT', reason: 'executor_returned_nothing' });
        _pump();
      }, function (error) {
        /* 任何 throw / provider error / parse error 都在这里收敛 → 槽位一定释放 */
        stats.failed++;
        _release(task);
        _settle(task, { ok: false, code: 'IMAGE_EXECUTOR_ERROR', reason: _errorText(error) });
        _pump();
      });
    }
    /* ── 后台降级唤醒定时器（自清理）─────────────────────────────────────
       后台 Sunburst 的降级条件只与"等待时长"有关，若没有新请求/完成事件，
       队列不会自己醒来。这里为最早到期的可降级任务挂一个单次定时器；
       队列清空或重新 pump 时立即清除，绝不堆积、绝不 keep-alive（unref）。 */
    function _clearTimer() {
      if (timer && clearT) { try { clearT(timer); } catch (e) {} }
      timer = null;
    }
    function _nextDowngradeDelay() {
      if (!cfg.downgradeAfterWaitMs) return -1;
      var t = now(), best = -1;
      for (var i = 0; i < queue.length; i++) {
        var task = queue[i];
        if (task._settled || task.cancelled) continue;
        if (!(task.modelKind === 'sunburst' && task.downgradable)) continue;
        var due = task.enqueuedAt + cfg.downgradeAfterWaitMs - t;
        /* 已过期仍未派发 = 非时间因素阻塞（槽位/角色），交给下一次事件唤醒，不再挂 0ms 定时器空转 */
        if (due <= 0) continue;
        if (best < 0 || due < best) best = due;
      }
      return best;
    }
    function _pump() {
      _clearTimer();
      for (var guard = 0; guard < 256; guard++) {
        var cand = _pickRunnable();
        if (!cand) break;
        _dispatch(cand);
      }
      var delay = _nextDowngradeDelay();
      if (delay > 0 && setT && !timer) {
        timer = setT(function () { timer = null; _pump(); }, delay);
        if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (e) {} }
      }
    }
    function _errorText(error) {
      var name = String((error && error.name) || 'Error');
      return name === 'AbortError' ? 'aborted' : '执行器异常（' + name + '）';
    }

    function enqueue(task) {
      task = task || {};
      var d = _defer();
      task.id = ++seq;
      task._resolve = d.resolve;
      task._settled = false;
      task._dispatched = false;
      task.cancelled = false;
      task.promise = d.promise;
      task.enqueuedAt = now();
      task.modelKind = task.modelKind === 'sunburst' ? 'sunburst' : 'flare';
      task.model = task.model || IMAGE_MODELS[task.modelKind];
      task.priority = normalizePriority(task.priority);
      task.characterId = String(task.characterId || '');
      task.background = task.background === true;

      /* ① 重复合并：短时间相同 character+source+prompt+operation+reference 只保留一个 */
      var dup = _findCoalesce(task);
      if (dup) {
        stats.coalesced++;
        if (task.priority < dup.priority) dup.priority = task.priority;  /* 合并时取更高优先级 */
        task._settled = true;
        return dup.promise;
      }
      /* ② 后台冷却：同一角色后台生成受限，绝不排队堆积 */
      if (task.background && task.characterId && cfg.backgroundCooldownMs > 0) {
        var last = lastBackgroundAt[task.characterId];
        if (last != null && (task.enqueuedAt - last) < cfg.backgroundCooldownMs) {
          task._settled = true;
          return Promise.resolve(_rejectResult(task, 'IMAGE_BACKGROUND_COOLDOWN', 'background_cooldown'));
        }
      }
      /* ③ 队列上限：不无限堆积，按优先级取舍 */
      if (queue.length >= cfg.queueLimit) {
        var victim = _overflowVictim(task);
        if (!victim) {
          task._settled = true;
          return Promise.resolve(_rejectResult(task, 'IMAGE_QUEUE_OVERFLOW', 'queue_overflow'));
        }
        _removeFromQueue(victim);
        _unbindAbort(victim);
        stats.evicted++;
        _settle(victim, _rejectResult(victim, 'IMAGE_QUEUE_EVICTED', 'queue_overflow_evicted'));
      }
      queue.push(task);
      stats.enqueued++;
      _bindAbort(task);
      if (task._settled) return task.promise;   /* 绑定 abort 时发现已取消 */
      _pump();
      return task.promise;
    }

    function snapshot() {
      var byModel = { flare: 0, sunburst: 0 };
      running.forEach(function (r) { byModel[r.modelKind] = (byModel[r.modelKind] || 0) + 1; });
      return {
        running: running.length, queued: queue.length, byModel: byModel,
        cfg: { maxConcurrent: cfg.maxConcurrent, maxFlareConcurrent: cfg.maxFlareConcurrent, maxSunburstConcurrent: cfg.maxSunburstConcurrent, perCharacterConcurrent: cfg.perCharacterConcurrent, queueLimit: cfg.queueLimit },
        stats: Object.assign({}, stats)
      };
    }
    function configure(overrides) {
      cfg = _mergeCfg(Object.assign({}, cfg, overrides || {}));
      return cfg;
    }
    /* reset 只清空"尚未派发"的任务与计数；已在 provider 上的请求绝不中断（测试收尾用） */
    function reset() {
      _clearTimer();
      var pending = queue.slice();
      queue = [];
      pending.forEach(function (t) { _unbindAbort(t); _settle(t, _rejectResult(t, 'IMAGE_ABORTED', 'scheduler_reset')); });
      lastBackgroundAt = {};
      stats = { enqueued: 0, dispatched: 0, completed: 0, failed: 0, rejected: 0, coalesced: 0, downgraded: 0, evicted: 0 };
      return true;
    }
    return {
      enqueue: enqueue, snapshot: snapshot, configure: configure, reset: reset,
      pump: _pump, stats: function () { return Object.assign({}, stats); }, config: function () { return Object.assign({}, cfg); }
    };
  }

  /* ── ⑨ Image Router：把决策 + 调度 + 现有 executor 串起来 ───────────────
     deps = {
       executor(cfg, prompt, size, opts) → Promise<result>,   // 必填：现有 _wsExecImageGen
       resolveProvider(cfg) → string,                          // 必填：现有 _imgResolveProvider
       getUserMode() → 'auto'|'fast'|'precision',              // 可选：Middle Brain 用户策略
       getConfig() → object,                                   // 可选：apiSettings['image_router'] 覆盖
       now(), log(line), onTelemetry(record)
     } */
  function createImageRouter(deps) {
    deps = deps || {};
    var now = deps.now || function () { return Date.now(); };
    var log = typeof deps.log === 'function' ? deps.log : function () {};
    var telemetry = [];
    var telemetryLimit = IMAGE_ROUTER_DEFAULTS.telemetryLimit;
    var debug = !!IMAGE_ROUTER_DEFAULTS.debug;
    /* 定时器透传（测试可注入假时钟）；生产走全局 setTimeout/clearTimeout */
    var scheduler = createImageScheduler({ now: now, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });
    var cfgLoaded = false;

    function _record(rec) {
      telemetry.push(rec);
      if (telemetry.length > telemetryLimit) telemetry.splice(0, telemetry.length - telemetryLimit);
      if (debug) {
        log('[ImageRouter] source=' + rec.source + ' character=' + (rec.characterId || '-') +
          ' mode=' + rec.requestedMode + ' op=' + (rec.operation || 'generate') +
          (rec.operation === 'edit' ? (' refs=' + rec.referenceCount + ' depth=' + rec.editDepth) : '') +
          ' model=' + (rec.modelKind || rec.selectedModel || '-') +
          ' reason=' + rec.routeReason + ' priority=' + rec.priorityName +
          ' queue=' + rec.queueDepth + ' wait=' + rec.queueWaitMs + 'ms' +
          ' exec=' + rec.executionMs + 'ms' + (rec.downgraded ? ' downgraded=true' : '') +
          ' ok=' + rec.ok);
      }
      if (typeof deps.onTelemetry === 'function') { try { deps.onTelemetry(rec); } catch (e) {} }
    }
    function _errorClass(error) {
      var name = String((error && error.name) || '');
      if (name === 'AbortError') return 'abort';
      if (name) return name;
      return 'Error';
    }
    /* 编辑可观测字段（P13）：operation / referenceCount / editDepth 进 telemetry（不含图片数据） */
    function _editFields(opts, decision) {
      var cls = decision && decision.classification;
      var sig = (cls && cls.signals) || {};
      var prev = opts && opts.previousImage;
      return {
        operation: String(sig.operation || (opts && opts.operation) || 'generate'),
        referenceCount: Number(sig.referenceCount || 0),
        editDepth: prev && isFinite(prev.editDepth) ? Math.floor(prev.editDepth) : 0
      };
    }
    function _fail(opts, decision, code, reason, extra) {
      var rec = Object.assign({
        ts: now(), source: String(opts.source || 'unknown'), characterId: String(opts.characterId || ''),
        requestedMode: decision ? decision.mode : normalizeImageMode(opts.requestedMode),
        selectedModel: decision ? decision.model : '', modelKind: decision ? decision.modelKind : null,
        priority: decision ? decision.priority : decideImagePriority(opts),
        priorityName: priorityName(decision ? decision.priority : decideImagePriority(opts)),
        queueWaitMs: 0, executionMs: 0, downgraded: false,
        routeReason: reason || code, queueDepth: 0, ok: false, errorClass: code
      }, _editFields(opts, decision));
      _record(rec);
      return Object.assign({ ok: false, code: code, reason: reason, route: rec }, extra || {});
    }

    /* 单次图片请求：路由配置 → 识别 → 决策 → 排队 → 现有 executor → 结果 + route 信息 */
    function routeImageRequest(opts) {
      opts = opts || {};
      var prompt = String(opts.prompt || '');
      var source = String(opts.source || 'unknown');
      var operation = normalizeImageOperation(opts);
      var fallbackUsed = false;

      /* 路由配置解析（可选依赖）：把"用户在 Image Router 里绑定的 API 配置 + 模型"
         解析成执行器 cfg。deps 未注入时行为与 P12/P13 逐字一致（只用调用方 cfg）。 */
      var preflightP = Promise.resolve(null);
      if (typeof deps.resolveRoute === 'function') {
        preflightP = Promise.resolve()
          .then(function () { return deps.resolveRoute({ operation: operation, opts: opts }); })
          .catch(function (e) {
            return { ok: false, code: 'IMAGE_ROUTER_ERROR', reason: '图片路由配置读取失败：' + String((e && e.message) || e).slice(0, 120) };
          });
      }

      return preflightP
        .then(function (pre) {
          var cfg = (pre && pre.ok && pre.cfg) ? pre.cfg : (opts.cfg || null);
          var routeModel = (pre && pre.ok) ? String(pre.model || '') : '';
          var routeApiConfigId = (pre && pre.ok) ? String(pre.apiConfigId || '') : '';
          var routeName = (pre && pre.ok) ? String(pre.routeName || '') : '';
          var fallback = (pre && pre.ok && pre.fallback) ? pre.fallback : null;
          var characterId = String(opts.characterId || (cfg && cfg.id) || '');
          var provider = null;
          if (typeof deps.resolveProvider === 'function') {
            try {
              var pv = deps.resolveProvider(cfg);
              provider = (pv === null || pv === undefined) ? null : String(pv);
            } catch (e) { provider = null; }
          }
          var configuredModel = String((cfg && cfg.imageGenModel) || '').trim();

          /* 用户策略（Middle Brain）+ 资源覆盖（apiSettings['image_router']）只读一次；
             任一依赖失败都回退默认值——路由层绝不成为图片链路的单点故障 */
          var modeP = Promise.resolve()
            .then(function () { return deps.getUserMode ? deps.getUserMode() : IMAGE_MODE_DEFAULT; })
            .catch(function () { return IMAGE_MODE_DEFAULT; });
          var cfgP = (cfgLoaded || !deps.getConfig) ? null : Promise.resolve().then(deps.getConfig).catch(function () { return null; });
          return Promise.all([modeP, cfgP]).then(function (pair) {
            var userMode = pair[0];
            var overrides = pair[1];
            if (overrides && typeof overrides === 'object') {
              if (overrides.telemetryLimit) telemetryLimit = _clampInt(overrides.telemetryLimit, 1, 500, telemetryLimit);
              if (overrides.debug != null) debug = !!overrides.debug;
              scheduler.configure(overrides);
            }
            cfgLoaded = true;

            var decision = decideImageRoute(Object.assign({}, opts, { characterId: characterId, source: source }),
              { userMode: userMode, provider: provider, configuredModel: configuredModel, routeModel: routeModel, routeName: routeName });
            var base = Object.assign({}, opts, { characterId: characterId, source: source });

            /* ① 路由配置问题优先于一切：缺 Key / 配置不存在 / 模型不支持 → 0 次 provider 请求 */
            if (pre && pre.ok === false) return _fail(base, decision, pre.code || 'IMAGE_ROUTER_ERROR', pre.reason || '图片路由未配置', { route: { apiConfigId: routeApiConfigId, routeName: routeName } });
            /* ② 显式选定的模型必须真实存在于唯一模型目录且支持当前操作 */
            var modelProblem = routeModel ? imageModelProblem(routeModel, operation) : '';
            if (modelProblem) return _fail(base, decision, modelProblem, '所选图片模型不支持当前操作：' + routeModel, { route: { apiConfigId: routeApiConfigId, routeName: routeName, model: routeModel } });

            if (!cfg) return _fail(base, decision, 'IMAGE_NO_CONFIG', '当前入口不支持图像生成（缺少 API 配置上下文）');
            if (typeof deps.executor !== 'function') return _fail(base, decision, 'IMAGE_NO_EXECUTOR', '图像执行器未就绪');
            if (!prompt.trim()) return _fail(base, decision, 'IMAGE_EMPTY_PROMPT', '缺少提示词');

            /* 复用现有 executor：只在双模型策略管辖时替换模型名（provider_managed / route_model 保持配置值） */
            var runCfg = Object.assign({}, cfg);
            if (decision.policy === 'dual_model') runCfg.imageGenModel = IMAGE_MODELS[decision.modelKind];
            var size = String(opts.size || '');
            /* P13：编辑请求把结构化图片输入一并交给**同一个** executor（edit wire format 在
               executor 内部），路由/模型/并发/优先级决策逐字不变——不复制 Router contract。 */
            var execOpts = {
              signal: opts.signal || null, quality: decision.quality,
              operation: decision.classification.signals.operation,
              previousImage: opts.previousImage || null,
              referenceImages: Array.isArray(opts.referenceImages) ? opts.referenceImages : []
            };

            var execMs = 0;
            var task = {
              modelKind: decision.modelKind || 'flare',
              model: decision.policy === 'dual_model' ? IMAGE_MODELS[decision.modelKind] : configuredModel,
              characterId: characterId,
              priority: decision.priority,
              background: decision.background,
              downgradable: decision.downgradable,
              signal: opts.signal || null,
              coalesceKey: imageCoalesceKey(Object.assign({}, opts, { characterId: characterId, source: source }), decision.modelKind || decision.policy),
              run: function (info) {
                var t0 = now();
                /* Scheduler 可能因后台长时间排队把 Sunburst 降级为 Flare：以派发结果为准，
                   确保真正发给 provider 的模型与 route 报告一致 */
                var useCfg = (info && info.downgraded && decision.policy === 'dual_model')
                  ? Object.assign({}, runCfg, { imageGenModel: IMAGE_MODELS.flare })
                  : runCfg;
                return Promise.resolve()
                  .then(function () { return deps.executor(useCfg, prompt, size, execOpts); })
                  .then(function (r) {
                    /* 可选备用通道：只在 provider/执行器层面的失败上重试一次，
                       输入/配置类错误（缺 Key、模型不支持、空提示词）绝不重试。 */
                    if (r && r.ok) { execMs = now() - t0; return r; }
                    if (!fallback || !_fallbackEligible(r && r.code)) { execMs = now() - t0; return r; }
                    fallbackUsed = true;
                    var fbCfg = Object.assign({}, fallback.cfg || useCfg);
                    if (fallback.model) fbCfg.imageGenModel = fallback.model;
                    return Promise.resolve()
                      .then(function () { return deps.executor(fbCfg, prompt, size, execOpts); })
                      .then(function (r2) {
                        execMs = now() - t0;
                        return Object.assign({}, r2 || { ok: false, code: 'IMAGE_EMPTY_RESULT' }, {
                          fallbackUsed: true, primaryCode: String((r && r.code) || ''), model: (r2 && r2.model) || fallback.model || ''
                        });
                      });
                  }, function (e) { execMs = now() - t0; throw e; });
              }
            };
            var dispatchInfo = null;
            task.onDispatch = function (info) { dispatchInfo = info; };

            return scheduler.enqueue(task).then(function (result) {
              var rec = Object.assign({
                ts: now(), source: source, characterId: characterId, requestedMode: decision.mode,
                selectedModel: result && result.model ? result.model : (task.model || ''),
                modelKind: dispatchInfo && dispatchInfo.downgraded ? 'flare' : (decision.modelKind || null),
                priority: decision.priority, priorityName: priorityName(decision.priority),
                queueWaitMs: dispatchInfo ? dispatchInfo.queueWaitMs : 0,
                executionMs: execMs,
                downgraded: !!(dispatchInfo && dispatchInfo.downgraded),
                routeReason: decision.routeReason,
                queueDepth: dispatchInfo ? dispatchInfo.queueDepth : scheduler.snapshot().queued,
                ok: !!(result && result.ok),
                errorClass: result && result.ok ? '' : String((result && result.code) || 'IMAGE_UNKNOWN'),
                /* P15 · 路由来源（不含任何凭证/图片数据）：谁被真正用了，一眼可见 */
                apiConfigId: routeApiConfigId, routeName: routeName, policy: decision.policy,
                modelSource: routeModel ? 'route' : (routeApiConfigId ? 'api_config' : 'inherit'),
                fallbackUsed: !!(result && result.fallbackUsed) || fallbackUsed
              }, _editFields(opts, decision));
              _record(rec);
              return Object.assign({}, result || { ok: false, code: 'IMAGE_EMPTY_RESULT', reason: 'executor_returned_nothing' }, {
                route: {
                  source: rec.source, characterId: rec.characterId, mode: rec.requestedMode,
                  policy: decision.policy, modelKind: rec.modelKind, model: rec.selectedModel,
                  quality: decision.quality, priority: rec.priority, priorityName: rec.priorityName,
                  queueWaitMs: rec.queueWaitMs, executionMs: rec.executionMs,
                  downgraded: rec.downgraded, routeReason: rec.routeReason,
                  operation: rec.operation, referenceCount: rec.referenceCount, editDepth: rec.editDepth,
                  apiConfigId: rec.apiConfigId, routeName: rec.routeName, modelSource: rec.modelSource,
                  fallbackUsed: rec.fallbackUsed,
                  classification: decision.classification
                }
              });
            });
          });
        });
    }

    return {
      routeImageRequest: routeImageRequest,
      scheduler: scheduler,
      telemetry: function () { return telemetry.slice(); },
      reset: function () { telemetry = []; cfgLoaded = false; scheduler.reset(); return true; },
      stats: function () { return scheduler.snapshot(); },
      setDebug: function (v) { debug = !!v; return debug; },
      isDebug: function () { return debug; }
    };
  }

  return {
    IMAGE_MODES: IMAGE_MODES,
    IMAGE_MODE_DEFAULT: IMAGE_MODE_DEFAULT,
    IMAGE_MODE_LABELS: IMAGE_MODE_LABELS,
    IMAGE_MODELS: IMAGE_MODELS,
    IMAGE_MODEL_KINDS: IMAGE_MODEL_KINDS,
    IMAGE_PRIORITY: IMAGE_PRIORITY,
    IMAGE_PRIORITY_NAMES: IMAGE_PRIORITY_NAMES,
    IMAGE_ROUTER_DEFAULTS: IMAGE_ROUTER_DEFAULTS,
    IMAGE_FALLBACK_CODES: IMAGE_FALLBACK_CODES,
    imageFallbackEligible: imageFallbackEligible,
    normalizeImageMode: normalizeImageMode,
    normalizeImageOperation: normalizeImageOperation,
    imageModelProblem: imageModelProblem,
    normalizePriority: normalizePriority,
    priorityName: priorityName,
    policyApplies: policyApplies,
    classifyImageTask: classifyImageTask,
    decideImagePriority: decideImagePriority,
    decideImageRoute: decideImageRoute,
    imageCoalesceKey: imageCoalesceKey,
    IMAGE_REJECT_TEXT: IMAGE_REJECT_TEXT,
    imageRejectText: imageRejectText,
    createImageScheduler: createImageScheduler,
    createImageRouter: createImageRouter
  };
});
