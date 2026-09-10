/* ====================================================================
   IB Image Router — 浏览器接线层（策略层唯一入口）
   --------------------------------------------------------------------
   本文件只做"接线"，不含任何路由/并发算法（全在 image-router-core.js）：

     Chat / Moments / AI Moments / …  →  IB.imageRouter.routeImageRequest
                                              ↓（image-router-config：路由配置 → API 配置 + 模型）
                                              ↓（core：识别 → 决策 → 排队）
                                        现有 executor window._wsExecImageGen
                                              ↓（assets/js/workspace.js，唯一 provider 执行器）
                                        Provider API → 现有图片存储/UI

   依赖（全部复用现有 canonical 实现，**不新建第二套**）：
     · 用户策略      Middle Brain 配置里的 imageMode（Fast / Auto / Precision）
     · 图片 provider window._imgResolveProvider（workspace.js，与 executor 同一判定）
     · 路由配置      assets/js/image-router-config.js（Settings → Image Router：
                     Generation / Editing 各自绑定的 API 配置 + 模型 + 开关 + 备用）
     · 模型目录      assets/js/image-models-core.js（唯一图片模型元数据源）
     · 资源覆盖      apiSettings 私有 key 'image_router'（并发/队列/冷却 + routes，可选）
   执行器缺失或 core 未加载时，routeImageRequest 一律返回 {ok:false,...}，
   绝不静默回落到一条绕过 Scheduler 的旁路。
   ==================================================================== */
(function (NS) {
  'use strict';
  var CORE = (typeof window !== 'undefined') ? window.IBImageRouterCore : null;
  var MODELS = (typeof window !== 'undefined') ? window.IBImageModelsCore : null;
  var CFG_KEY = 'image_router';
  var DEBUG_KEY = 'ibImageRouterDebug';
  var _cfgCache = null, _cfgLoaded = false;

  function _debugOn() {
    try { return localStorage.getItem(DEBUG_KEY) === '1'; } catch (e) { return false; }
  }
  function _log(line) { try { console.log(line); } catch (e) {} }

  /* apiSettings 私有 key：只读一次（改配置后由 resetImageRouter 重新读） */
  function _routerConfig() {
    if (_cfgLoaded) return Promise.resolve(_cfgCache);
    _cfgLoaded = true;
    try {
      if (typeof dbGet !== 'function') return Promise.resolve(null);
      return Promise.resolve(dbGet('apiSettings', CFG_KEY)).then(function (c) {
        _cfgCache = (c && typeof c === 'object') ? c : null;
        return _cfgCache;
      }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  /* 用户策略：只经 Middle Brain 的 canonical 决策缝读取（不直读其内部配置/契约） */
  function _userMode() {
    try {
      var MB = NS.middleBrain;
      if (MB && typeof MB.middleBrainImageMode === 'function') {
        return Promise.resolve(MB.middleBrainImageMode()).then(function (d) {
          return CORE.normalizeImageMode(d && d.mode);
        }, function () { return CORE.IMAGE_MODE_DEFAULT; });
      }
    } catch (e) {}
    return CORE.IMAGE_MODE_DEFAULT;
  }
  /* 唯一 provider 执行器（现有实现，含 120s 超时 AbortController） */
  function _executor(cfg, prompt, size, opts) {
    var fn = (typeof window._wsExecImageGen === 'function') ? window._wsExecImageGen : null;
    if (!fn) return Promise.resolve({ ok: false, code: 'IMAGE_NO_EXECUTOR', reason: '图像执行器未就绪' });
    return Promise.resolve(fn(cfg, prompt, size, opts));
  }
  /* 唯一 provider 推断（workspace.js）；拿不到 → null（Router 不改用户配置） */
  function _resolveProvider(cfg) {
    var fn = (typeof window._imgResolveProvider === 'function') ? window._imgResolveProvider : null;
    if (!fn) return null;
    try { return fn(cfg); } catch (e) { return null; }
  }
  /* 路由配置层（assets/js/image-router-config.js）：把"用户在 Settings → Image Router 里
     绑定的 API 配置 + 模型"解析成执行器 cfg。缺失时返回 null → core 保持 P12/P13 的
     旧语义（只用调用方 cfg），不会因为设置层未加载而炸掉图片链路。 */
  function _resolveRoute(input) {
    var cfgLayer = NS.imageRouterConfig;
    if (!cfgLayer || typeof cfgLayer.resolveRoute !== 'function') return null;
    return cfgLayer.resolveRoute(input);
  }

  if (!CORE) {
    _log('[ImageRouter] image-router-core.js 未加载，图片路由不可用');
    NS.expose('imageRouter', {
      available: false,
      routeImageRequest: function () {
        return Promise.resolve({ ok: false, code: 'IMAGE_NO_ROUTER', reason: 'Image Router 未加载' });
      }
    });
    return;
  }

  var router = CORE.createImageRouter({
    executor: _executor,
    resolveProvider: _resolveProvider,
    getUserMode: _userMode,
    getConfig: _routerConfig,
    resolveRoute: _resolveRoute,
    log: _log
  });
  router.setDebug(_debugOn());

  /* 生产调用方唯一入口（producers 只交参数，不关心模型/队列） */
  function routeImageRequest(opts) { return router.routeImageRequest(opts || {}); }

  NS.expose('imageRouter', {
    available: true,
    routeImageRequest: routeImageRequest,
    classifyImageTask: CORE.classifyImageTask,
    decideImageRoute: CORE.decideImageRoute,
    decideImagePriority: CORE.decideImagePriority,
    normalizeImageMode: CORE.normalizeImageMode,
    normalizeImageOperation: CORE.normalizeImageOperation,
    imageModelProblem: CORE.imageModelProblem,
    imageCoalesceKey: CORE.imageCoalesceKey,
    imageRejectText: CORE.imageRejectText,
    IMAGE_MODES: CORE.IMAGE_MODES,
    IMAGE_MODELS: CORE.IMAGE_MODELS,
    IMAGE_MODE_LABELS: CORE.IMAGE_MODE_LABELS,
    IMAGE_PRIORITY: CORE.IMAGE_PRIORITY,
    IMAGE_ROUTER_DEFAULTS: CORE.IMAGE_ROUTER_DEFAULTS,
    IMAGE_FALLBACK_CODES: CORE.IMAGE_FALLBACK_CODES,
    scheduler: router.scheduler,
    stats: function () { return router.stats(); },
    telemetry: function () { return router.telemetry(); },
    reset: function () { return router.reset(); },
    setDebug: function (v) { return router.setDebug(v); },
    /* 改完 apiSettings['image_router'] 后调用：让下一次请求重新读配置 */
    reloadConfig: function () { _cfgLoaded = false; _cfgCache = null; return true; }
  });
  /* 唯一图片模型目录（UI 下拉与请求体同一条记录）：Settings 层只从这里取模型 */
  if (MODELS) {
    NS.expose('imageModels', {
      available: true,
      CAPABILITIES: MODELS.CAPABILITIES,
      CAPABILITY_LABELS: MODELS.CAPABILITY_LABELS,
      list: MODELS.listImageModels,
      imageModel: MODELS.imageModel,
      normalizeModelId: MODELS.normalizeModelId,
      isKnownModel: MODELS.isKnownModel,
      supportsCapability: MODELS.supportsCapability,
      supportsOperation: MODELS.supportsOperation,
      capabilityForOperation: MODELS.capabilityForOperation,
      tierModelId: MODELS.tierModelId,
      tierOf: MODELS.tierOf,
      wireFor: MODELS.wireFor,
      requestModelId: MODELS.requestModelId,
      label: MODELS.modelLabel
    });
  }
})(window.IB || (window.IB = {}));
