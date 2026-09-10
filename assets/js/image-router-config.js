/* ====================================================================
   IB Image Router Config — 路由配置层（持久化 + 解析，零 DOM / 零 fetch）
   --------------------------------------------------------------------
   职责（只有这些）：
     ① 读/写 apiSettings['image_router'].routes —— Generation / Editing 两条路由
        （enabled / apiConfigId / model / fallback），与既有并发覆盖字段共存于同一
        私有 key（**不新建第二套存储**，也不动 'middle_brain' / 角色配置契约）。
     ② 把一条路由解析成执行器能吃的 cfg + 模型：
          route.apiConfigId → 已有 apiConfig（endpoint / apiKey / provider metadata）
          route.model       → 唯一 canonical 图片模型目录（image-models-core.js）
     ③ 在**发请求之前**给出明确、可执行的错误码（缺 Key / 缺 Endpoint / 配置不存在 /
        模型不支持该操作 / 路由被关闭），绝不把配置问题变成 fetch 401/404。
   不做的事：不发请求、不选并发、不排队、不碰 DOM、不复制 provider 推断。

   解析语义（三条，缺一不可）：
     · apiConfigId 为空  → mode='inherit'：沿用调用方传入的角色 cfg（与 P12/P13 行为逐字一致，
       老用户不需要重新配置就能继续用；角色 cfg 缺 Key/Endpoint 时同样给出明确错误）。
     · apiConfigId 有值  → mode='bound'：完全使用该 API 配置的 endpoint / apiKey / provider，
       与"当时正在和谁聊天"解耦（后台任务、朋友圈、Activity 共用同一条路由）。
     · model 为空        → 'auto'：交给 Image Router 的 Fast/Auto/Precision 双模型策略
       （Flare / Sunburst）。model 有值 → 用户显式选择，最高优先，Fast/Precision 覆盖不能改它。
   ==================================================================== */
(function (NS) {
  'use strict';
  var MODELS = (typeof window !== 'undefined' && window.IBImageModelsCore) ? window.IBImageModelsCore : null;
  var CFG_KEY = 'image_router';
  var ROUTE_NAMES = ['generation', 'editing'];
  var ROUTE_META = {
    generation: { label: 'Image Generation', operation: 'generate' },
    editing: { label: 'Image Editing', operation: 'edit' }
  };

  function _norm(v) { return String(v == null ? '' : v).trim(); }
  function _log(line) { try { console.log(line); } catch (e) {} }

  function routeNameForOperation(operation) {
    return _norm(operation).toLowerCase() === 'edit' ? 'editing' : 'generation';
  }
  function emptyRoute() {
    return { enabled: true, apiConfigId: '', model: '', fallback: { apiConfigId: '', model: '' } };
  }
  /* 归一一条路由：非法值一律回落到安全默认（enabled 只有显式 false 才是关闭） */
  function normalizeRoute(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var fb = (r.fallback && typeof r.fallback === 'object') ? r.fallback : {};
    return {
      enabled: r.enabled === false ? false : true,
      apiConfigId: _norm(r.apiConfigId),
      model: MODELS ? MODELS.normalizeModelId(r.model) : _norm(r.model),
      fallback: { apiConfigId: _norm(fb.apiConfigId), model: MODELS ? MODELS.normalizeModelId(fb.model) : _norm(fb.model) }
    };
  }
  function normalizeRoutes(raw) {
    var out = {};
    for (var i = 0; i < ROUTE_NAMES.length; i++) {
      var n = ROUTE_NAMES[i];
      out[n] = normalizeRoute(raw && raw[n]);
    }
    return out;
  }

  /* ── 持久化（apiSettings['image_router']，与并发覆盖字段同 key 共存） ── */
  function getConfig() {
    try {
      if (typeof dbGet !== 'function') return Promise.resolve(null);
      return Promise.resolve(dbGet('apiSettings', CFG_KEY)).then(function (c) { return (c && typeof c === 'object') ? c : null; }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function getRoutes() {
    return getConfig().then(function (c) { return normalizeRoutes(c && c.routes); });
  }
  function saveRoutes(routes) {
    var next = normalizeRoutes(routes);
    return getConfig().then(function (raw) {
      var merged = Object.assign({}, raw || {});
      merged.id = CFG_KEY;
      merged.routes = next;
      if (typeof dbPut !== 'function') return next;
      return Promise.resolve(dbPut('apiSettings', merged)).then(function () {
        /* 让 Image Router 下次请求重新读配置（并发覆盖字段也一并重新生效） */
        try { if (NS.imageRouter && typeof NS.imageRouter.reloadConfig === 'function') NS.imageRouter.reloadConfig(); } catch (e) {}
        return next;
      });
    });
  }

  /* ── API 配置读取（复用已有 apiConfigs 存储，不新建 Secret Store） ── */
  function _dbConfigs() {
    try {
      if (typeof dbGetAll === 'function') {
        return Promise.resolve(dbGetAll('apiConfigs')).then(function (all) {
          if (Array.isArray(all) && all.length) return all;
          return _memConfigs();
        }, function () { return _memConfigs(); });
      }
    } catch (e) {}
    return Promise.resolve(_memConfigs());
  }
  function _memConfigs() {
    try { if (typeof apiConfigs !== 'undefined' && Array.isArray(apiConfigs)) return apiConfigs; } catch (e) {}
    return [];
  }
  /* 绑定下拉用的列表：非归档、按 sortOrder/created 排序 */
  function listApiConfigs() {
    return _dbConfigs().then(function (all) {
      var out = (all || []).filter(function (c) { return c && !c.archived; });
      out.sort(function (a, b) { return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || (Number(a.created) || 0) - (Number(b.created) || 0); });
      return out;
    });
  }
  /* 解析用查找：归档的绑定仍然能解析（否则用户归档一个角色就静默炸掉路由） */
  function findApiConfig(id) {
    var key = _norm(id);
    if (!key) return Promise.resolve(null);
    return _dbConfigs().then(function (all) {
      for (var i = 0; i < (all || []).length; i++) { if (all[i] && all[i].id === key) return all[i]; }
      return null;
    });
  }
  function apiConfigLabel(cfg) {
    if (!cfg) return '';
    return _norm(cfg.nickname) || _norm(cfg.model) || _norm(cfg.handle) || '未命名 API 配置';
  }

  /* ── 图片服务商 / 编辑能力：一律复用执行器的唯一实现，不复制表达式 ── */
  function _resolveProvider(cfg) {
    var fn = (typeof window !== 'undefined' && typeof window._imgResolveProvider === 'function') ? window._imgResolveProvider : null;
    if (!fn) return null;
    try { return _norm(fn(cfg)).toLowerCase(); } catch (e) { return null; }
  }
  function _editCapability(cfg) {
    var fn = (typeof window !== 'undefined' && typeof window._imgEditCapability === 'function') ? window._imgEditCapability : null;
    if (!fn) return { ok: true, wire: '', model: '' };
    try { return fn(cfg) || { ok: true }; } catch (e) { return { ok: true }; }
  }
  function _endpointOf(cfg) { return _norm(cfg && cfg.imageGenEndpoint) || _norm(cfg && cfg.endpoint); }
  function _keyOf(cfg) { return _norm(cfg && cfg.imageGenApiKey) || _norm(cfg && cfg.apiKey); }
  /* 端点主机名 / 本地判定：IB 的 local-first 与 Bridge 本地服务（127.0.0.1:23115 等）
     本来就允许不填 API Key，配置层不得把这类可用配置判死。 */
  function _hostOf(url) {
    try { return String(new URL(_norm(url)).hostname || '').toLowerCase(); } catch (e) { return ''; }
  }
  function _isLocalHost(h) {
    if (!h) return false;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || /\.local$/.test(h)
      || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h);
  }
  /* provider 官方默认端点（与执行器的回落一致）：端点留空但有默认端点 = 可用，不是配置错误 */
  function _providerDefaultEndpoint(provider) {
    var p = _norm(provider).toLowerCase();
    if (p === 'openai') return 'https://api.openai.com/v1/images/generations';
    if (p === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
    return '';
  }

  function _fail(code, reason, extra) {
    return Object.assign({ ok: false, code: code, reason: reason }, extra || {});
  }
  /* 配置问题的用户可读文案：一律指明"去哪里修"，不只抛接口错误 */
  function errorText(code) {
    try { if (NS.imageRouter && typeof NS.imageRouter.imageRejectText === 'function') return NS.imageRouter.imageRejectText({ code: code }); } catch (e) {}
    return '';
  }

  /* ── 主解析：route → {ok, cfg, model, fallback, provider, …} ────────── */
  function resolveRoute(input) {
    input = input || {};
    var operation = _norm(input.operation).toLowerCase() === 'edit' ? 'edit' : 'generate';
    var opts = input.opts || {};
    var name = routeNameForOperation(operation);
    var label = ROUTE_META[name].label;
    var capability = MODELS ? MODELS.capabilityForOperation(operation) : '';
    var warnings = [];

    return getRoutes().then(function (routes) {
      var route = routes[name];
      if (!route.enabled) return _fail('IMAGE_ROUTER_DISABLED', label + ' 已在 Image Router 中关闭', { routeName: name });

      return findApiConfig(route.apiConfigId).then(function (bound) {
        if (route.apiConfigId && !bound) {
          return _fail('IMAGE_ROUTER_CONFIG_MISSING', label + ' 绑定的 API 配置不存在（可能已被删除）', { routeName: name, apiConfigId: route.apiConfigId });
        }
        var base = bound || opts.cfg || null;
        if (!base) return _fail('IMAGE_NO_CONFIG', '当前入口不支持图像生成（缺少 API 配置上下文）', { routeName: name });
        var cfg = Object.assign({}, base);
        /* 绑定的 API 配置 = 该路由专用图片通道：显式开启图片能力（等价于在 API 编辑器里勾选"启用图像生成"） */
        if (bound) cfg.imageGen = true;

        var model = '', modelSource = 'auto';
        if (route.model) {
          var entry = MODELS ? MODELS.imageModel(route.model) : null;
          if (!entry) return _fail('IMAGE_MODEL_UNKNOWN', '所选图片模型不在支持的模型目录中：' + route.model, { routeName: name, model: route.model });
          if (!MODELS.supportsCapability(entry.id, capability)) {
            return _fail('IMAGE_MODEL_CAPABILITY', '模型 ' + entry.label + ' 不支持' + (operation === 'edit' ? '图片编辑' : '图片生成'), { routeName: name, model: entry.id });
          }
          cfg.imageGenModel = entry.id;
          cfg.imageGenProvider = entry.provider;   /* 模型所属服务商决定 wire format */
          model = entry.id;
          modelSource = 'route';
        } else if (bound) {
          model = _norm(bound.imageGenModel);
          modelSource = model ? 'api_config' : 'auto';
          if (model && MODELS && MODELS.isKnownModel(model) && !MODELS.supportsOperation(model, operation)) {
            return _fail('IMAGE_MODEL_CAPABILITY', '绑定的 API 配置所用模型 ' + MODELS.modelLabel(model) + ' 不支持' + (operation === 'edit' ? '图片编辑' : '图片生成'), { routeName: name, model: model });
          }
        }

        /* 端点/凭证校验原则：只拦**确定不可用**的配置，其余如实警告放行。
           · 端点留空但 provider 有官方默认端点 → 可用（与执行器回落一致）
           · API Key 留空但端点是本地/内网 → 可用（local-first / 自建代理的常态）
           · API Key 留空且端点在公网 → 必然 401，提前拦下并指明去哪修 */
        var provider = _resolveProvider(cfg);
        var endpoint = _endpointOf(cfg) || _providerDefaultEndpoint(provider);
        if (!endpoint) return _fail('IMAGE_ROUTER_NO_ENDPOINT', label + ' 使用的 API 配置没有接口地址', { routeName: name, apiConfigId: route.apiConfigId });
        var key = _keyOf(cfg);
        if (!key) {
          if (_isLocalHost(_hostOf(endpoint))) warnings.push('no_key_local');
          else return _fail('IMAGE_ROUTER_NO_KEY', label + ' 使用的 API 配置没有 API Key', { routeName: name, apiConfigId: route.apiConfigId });
        }

        if (provider === 'anthropic' || provider === 'deepseek') {
          return _fail(operation === 'edit' ? 'IMAGE_EDIT_UNSUPPORTED' : 'IMAGE_ROUTER_PROVIDER_UNSUPPORTED',
            (provider === 'anthropic' ? 'Anthropic' : 'DeepSeek') + ' 不支持' + (operation === 'edit' ? '图片编辑' : '图像生成') + '，请在 Image Router 中改绑 OpenAI 兼容或 Gemini 的 API 配置',
            { routeName: name, provider: provider });
        }
        /* 编辑：复用执行器唯一的能力判定（模型/端点能力不足时 0 次 provider 请求） */
        if (operation === 'edit') {
          var cap = _editCapability(cfg);
          if (!cap.ok) return _fail(cap.code || 'IMAGE_EDIT_UNSUPPORTED', cap.reason || '当前图片模型不支持编辑这张图片', { routeName: name, model: cap.model || model });
        }

        return _resolveFallback(route, cfg, operation, capability, warnings).then(function (fallback) {
          return {
            ok: true, routeName: name, routeLabel: label, operation: operation,
            mode: bound ? 'bound' : 'inherit',
            apiConfigId: route.apiConfigId,
            apiConfigLabel: bound ? apiConfigLabel(bound) : '',
            cfg: cfg, model: model, modelSource: modelSource,
            provider: provider, endpoint: endpoint,
            fallback: fallback, warnings: warnings
          };
        });
      });
    }).catch(function (e) {
      return _fail('IMAGE_ROUTER_ERROR', '图片路由配置读取失败：' + String((e && e.message) || e).slice(0, 120), { routeName: name });
    });
  }

  /* 备用通道（可选）：只做主通道失败后的重试，不参与决策；配置不完整时如实降级为"没有备用" */
  function _resolveFallback(route, primaryCfg, operation, capability, warnings) {
    var fb = route.fallback || {};
    if (!fb.apiConfigId && !fb.model) return Promise.resolve(null);
    return findApiConfig(fb.apiConfigId).then(function (bound) {
      var cfg = Object.assign({}, primaryCfg);
      if (fb.apiConfigId) {
        if (!bound) { warnings.push('fallback_config_missing'); return null; }
        cfg = Object.assign({}, bound, { imageGen: true });
      }
      var model = '';
      if (fb.model) {
        var entry = MODELS ? MODELS.imageModel(fb.model) : null;
        if (!entry || !MODELS.supportsCapability(entry.id, capability)) { warnings.push('fallback_model_unsupported'); return null; }
        cfg.imageGenModel = entry.id;
        cfg.imageGenProvider = entry.provider;
        model = entry.id;
      } else {
        model = _norm(cfg.imageGenModel);
      }
      /* 与主通道同一套"可用性"判定：有官方默认端点、或本地端点免 Key，都算可用 */
      var fbProvider = _resolveProvider(cfg);
      var fbEndpoint = _endpointOf(cfg) || _providerDefaultEndpoint(fbProvider);
      if (!fbEndpoint) { warnings.push('fallback_incomplete'); return null; }
      if (!_keyOf(cfg) && !_isLocalHost(_hostOf(fbEndpoint))) { warnings.push('fallback_incomplete'); return null; }
      return { cfg: cfg, model: model, apiConfigId: fb.apiConfigId, modelSource: fb.model ? 'route_fallback' : 'api_config' };
    });
  }

  /* ── 只读描述（Settings UI 与诊断用；不写库、不发请求、不需要会话上下文） ── */
  function describe() {
    return Promise.all([getRoutes(), listApiConfigs()]).then(function (pair) {
      var routes = pair[0], configs = pair[1];
      var out = { routes: routes, apiConfigs: configs, models: {}, status: {} };
      if (MODELS) {
        out.models.generation = MODELS.listImageModels({ capability: 'image-generation' });
        out.models.editing = MODELS.listImageModels({ capability: 'image-editing' });
      }
      return Promise.all(ROUTE_NAMES.map(function (name) {
        var meta = ROUTE_META[name];
        var route = routes[name];
        var capability = MODELS ? MODELS.capabilityForOperation(meta.operation) : '';
        var st = {
          name: name, label: meta.label, operation: meta.operation, enabled: route.enabled,
          mode: route.apiConfigId ? 'bound' : 'inherit', apiConfigId: route.apiConfigId,
          apiConfigLabel: '', model: route.model, modelSource: route.model ? 'route' : 'auto',
          provider: '', endpoint: '', fallback: null, ok: true, code: '', reason: '', warnings: []
        };
        if (route.fallback && (route.fallback.apiConfigId || route.fallback.model)) {
          st.fallback = { apiConfigId: route.fallback.apiConfigId, model: route.fallback.model };
        }
        if (route.model && MODELS && !MODELS.supportsCapability(route.model, capability)) {
          st.ok = false; st.code = 'IMAGE_MODEL_CAPABILITY';
        }
        return findApiConfig(route.apiConfigId).then(function (bound) {
          if (route.apiConfigId && !bound) { st.ok = false; st.code = 'IMAGE_ROUTER_CONFIG_MISSING'; return null; }
          if (!bound) return null;   /* inherit：运行时才拿得到角色 cfg */
          st.apiConfigLabel = apiConfigLabel(bound);
          var cfg = Object.assign({}, bound, { imageGen: true });
          if (route.model) { cfg.imageGenModel = route.model; cfg.imageGenProvider = (MODELS && MODELS.imageModel(route.model) || {}).provider || cfg.imageGenProvider; }
          st.provider = _resolveProvider(cfg);
          st.endpoint = _endpointOf(cfg) || _providerDefaultEndpoint(st.provider);
          if (!st.ok) return null;
          if (!st.endpoint) { st.ok = false; st.code = 'IMAGE_ROUTER_NO_ENDPOINT'; return null; }
          if (!_keyOf(cfg)) {
            if (_isLocalHost(_hostOf(st.endpoint))) st.warnings.push('no_key_local');
            else { st.ok = false; st.code = 'IMAGE_ROUTER_NO_KEY'; }
            return null;
          }
          return null;
        }).then(function () { out.status[name] = st; return null; });
      })).then(function () { return out; });
    });
  }

  NS.expose('imageRouterConfig', {
    CFG_KEY: CFG_KEY,
    ROUTE_NAMES: ROUTE_NAMES,
    ROUTE_META: ROUTE_META,
    routeNameForOperation: routeNameForOperation,
    emptyRoute: emptyRoute,
    normalizeRoute: normalizeRoute,
    normalizeRoutes: normalizeRoutes,
    getConfig: getConfig,
    getRoutes: getRoutes,
    saveRoutes: saveRoutes,
    listApiConfigs: listApiConfigs,
    findApiConfig: findApiConfig,
    apiConfigLabel: apiConfigLabel,
    resolveRoute: resolveRoute,
    describe: describe,
    errorText: errorText,
    _log: _log
  });
})(window.IB || (window.IB = {}));
