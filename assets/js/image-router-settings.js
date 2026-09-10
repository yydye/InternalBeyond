/* ====================================================================
   IB Image Router Settings — Settings → API → Image Router 配置界面
   --------------------------------------------------------------------
   这一层只做"人机界面"：
     · 两条路由（Image Generation / Image Editing）各自绑定：
         API Config（已有 API 配置系统） + Model（唯一图片模型目录） + Enabled + 备用通道
     · 显示"当前实际路由"：Generation → 配置 / 模型（一眼可见，不需要猜 <ws_edit_image> 用了谁）
     · 把配置写进 apiSettings['image_router'].routes（image-router-config.js 负责存储与解析）
   不做的事：不发请求、不选并发、不复制 API 表单 —— 「+ 新建」直接调用既有 addNewApi()，
   模型下拉的唯一数据源是 IB.imageModels（image-models-core.js），没有第二份硬编码数组。
   ==================================================================== */
(function (NS) {
  'use strict';
  var UI_KEY = 'image_router_ui';
  var ROUTES = ['generation', 'editing'];
  var ROUTE_LABEL = { generation: 'Image Generation', editing: 'Image Editing' };
  var ROUTE_OP = { generation: 'generate', editing: 'edit' };
  var ROUTE_CAP = { generation: 'image-generation', editing: 'image-editing' };
  var AUTO_LABEL = '自动（Image Router 决策：Flare / Sunburst）';
  var INHERIT_LABEL = '跟随角色配置（默认）';
  var _bound = false;
  var _collapsed = false;

  function _el(id) { return document.getElementById(id); }
  function _cfg() { return NS.imageRouterConfig || null; }
  function _models() { return NS.imageModels || null; }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _status(msg, kind) {
    var el = _el('ir-save-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'mb-save-status' + (kind === 'bad' ? ' is-bad' : (kind === 'ok' ? ' is-ok' : ''));
  }
  function _providerLabel(p) { return p ? String(p) : '—'; }

  /* ── 折叠态（与 Middle Brain 同一套 mb-collapse 样式，独立私有 key 持久化） ── */
  function _applyCollapse() {
    var body = _el('ir-collapse-body'), head = _el('ir-collapse-toggle');
    if (body) body.classList.toggle('is-collapsed', !!_collapsed);
    if (head) head.setAttribute('aria-expanded', _collapsed ? 'false' : 'true');
  }
  function _bindCollapse() {
    if (_bound) return;
    var head = _el('ir-collapse-toggle');
    if (!head) return;
    _bound = true;
    head.addEventListener('click', function () {
      _collapsed = !_collapsed;
      _applyCollapse();
      try { if (typeof dbPut === 'function') dbPut('apiSettings', { id: UI_KEY, collapsed: _collapsed }); } catch (e) {}
    });
    try {
      if (typeof dbGet === 'function') {
        Promise.resolve(dbGet('apiSettings', UI_KEY)).then(function (c) {
          if (c && typeof c.collapsed === 'boolean') { _collapsed = c.collapsed; _applyCollapse(); }
        }, function () {});
      }
    } catch (e) {}
  }

  /* ── 选项构建（唯一数据源：IB.imageModels / IB.imageRouterConfig） ──── */
  function _configOptions(configs, selectedId) {
    var html = '<option value="">' + INHERIT_LABEL + '</option>';
    var seen = false;
    (configs || []).forEach(function (c) {
      var label = (c.nickname || c.model || '未命名') + ' · ' + (c.imageGenProvider || c.provider || '—') + ' · ' + (c.model || '未填模型');
      var sel = (c.id === selectedId) ? ' selected' : '';
      if (c.id === selectedId) seen = true;
      html += '<option value="' + _esc(c.id) + '"' + sel + '>' + _esc(label) + '</option>';
    });
    if (selectedId && !seen) html += '<option value="' + _esc(selectedId) + '" selected>（已不存在）' + _esc(selectedId) + '</option>';
    return html;
  }
  function _modelOptions(name, selectedId) {
    var M = _models();
    var cap = ROUTE_CAP[name];
    var list = M ? M.list({ capability: cap }) : [];
    var html = '<option value="">' + AUTO_LABEL + '</option>';
    var seen = false;
    list.forEach(function (m) {
      var sel = (m.id === selectedId) ? ' selected' : '';
      if (m.id === selectedId) seen = true;
      html += '<option value="' + _esc(m.id) + '"' + sel + '>' + _esc(m.label) + ' · ' + _esc(m.id) + '</option>';
    });
    if (selectedId && !seen) {
      html += '<option value="' + _esc(selectedId) + '" selected>（不支持该操作）' + _esc(selectedId) + '</option>';
    }
    return html;
  }

  function _routeCard(name, st, configs) {
    var modelHint = name === 'editing'
      ? '编辑下拉只列出支持 image-editing 的模型；不支持的模型不会出现在这里。'
      : '生成下拉只列出支持 image-generation 的模型。';
    return ''
      + '<div class="ir-card" id="ir-card-' + name + '">'
      +   '<div class="ir-card-head">'
      +     '<span class="ir-card-title">' + ROUTE_LABEL[name] + '</span>'
      +     '<span class="ir-card-state" id="ir-state-' + name + '"></span>'
      +     '<label class="ib-switch ir-card-switch" title="关闭后该路由的图片请求会直接给出提示，不会发请求">'
      +       '<input type="checkbox" id="ir-enabled-' + name + '"' + (st.enabled ? ' checked' : '') + '><span class="kn"></span>'
      +     '</label>'
      +   '</div>'
      +   '<div class="ir-grid">'
      +     '<div class="api-form-group">'
      +       '<label>API Config</label>'
      +       '<div class="ir-select-row">'
      +         '<select id="ir-config-' + name + '">' + _configOptions(configs, st.apiConfigId) + '</select>'
      +         '<button type="button" class="btn ir-new" onclick="addNewApi()">+ 新建</button>'
      +       '</div>'
      +       '<div class="f-hint">留空 = 沿用当前角色的图片 API 配置；选择具体配置 = 该路由始终使用它（与正在和谁聊天无关）。</div>'
      +     '</div>'
      +     '<div class="api-form-group">'
      +       '<label>Model</label>'
      +       '<select id="ir-model-' + name + '">' + _modelOptions(name, st.model) + '</select>'
      +       '<div class="f-hint">' + modelHint + '</div>'
      +     '</div>'
      +   '</div>'
      +   '<details class="ir-adv">'
      +     '<summary>备用通道（可选）</summary>'
      +     '<div class="ir-grid">'
      +       '<div class="api-form-group"><label>备用 API Config</label>'
      +         '<select id="ir-fbconfig-' + name + '">' + _configOptions(configs, (st.fallback && st.fallback.apiConfigId) || '') + '</select></div>'
      +       '<div class="api-form-group"><label>备用 Model</label>'
      +         '<select id="ir-fbmodel-' + name + '">' + _modelOptions(name, (st.fallback && st.fallback.model) || '') + '</select></div>'
      +     '</div>'
      +     '<div class="f-hint">只在主通道遇到 provider / 网络类失败时重试一次；缺 Key、模型不支持等配置问题不会重试。</div>'
      +   '</details>'
      +   '<div class="ir-route-line" id="ir-line-' + name + '"></div>'
      + '</div>';
  }

  /* 当前实际路由：Generation → [API Config] / [Model]（含 provider 与来源） */
  function _routeLine(name, st) {
    var M = _models(), L = _cfg();
    var who = st.mode === 'bound' ? ('API 配置「' + (st.apiConfigLabel || st.apiConfigId) + '」') : INHERIT_LABEL.replace('（默认）', '');
    var modelTxt;
    if (st.model) {
      modelTxt = (M ? M.label(st.model) : st.model) + '（' + st.model + '）';
    } else {
      modelTxt = '自动 · Flare / Sunburst';
    }
    var parts = ['<span class="ir-line-k">' + ROUTE_LABEL[name] + '</span>', '→', _esc(who), '/', _esc(modelTxt)];
    if (st.provider) parts.push('<span class="ir-line-dim">provider: ' + _esc(_providerLabel(st.provider)) + '</span>');
    if (st.fallback) parts.push('<span class="ir-line-dim">备用: ' + _esc(st.fallback.model || st.fallback.apiConfigId || '') + '</span>');
    return parts.join(' ');
  }
  function _routeState(name, st) {
    var L = _cfg();
    var el = _el('ir-state-' + name);
    var line = _el('ir-line-' + name);
    if (line) line.innerHTML = _routeLine(name, st);
    if (!el) return;
    if (!st.enabled) { el.textContent = '已关闭'; el.className = 'ir-card-state is-off'; return; }
    if (st.ok) {
      if (st.warnings && st.warnings.indexOf('no_key_local') >= 0) {
        el.textContent = '本地端点 · 未填 API Key（可留空）';
        el.className = 'ir-card-state is-on';
        return;
      }
      el.textContent = st.mode === 'bound' ? '已绑定' : '跟随角色';
      el.className = 'ir-card-state is-on';
      return;
    }
    el.textContent = (L && L.errorText(st.code)) || st.code || '配置不完整';
    el.className = 'ir-card-state is-bad';
  }

  /* API 编辑器里的"生图模型"输入框：候选值来自同一份唯一模型目录，
     不再让用户凭记忆手打模型名（也保证 Image 2.5 的真实 id 出现在提示里）。 */
  function _fillModelDatalist() {
    var list = _el('api-imagegen-model-list'), M = _models();
    if (!list || !M) return;
    var all = M.list({});
    var html = '';
    all.forEach(function (m) { html += '<option value="' + _esc(m.id) + '">' + _esc(m.label) + '</option>'; });
    list.innerHTML = html;
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────── */
  function render() {
    var L = _cfg();
    var box = _el('ir-route-generation'), box2 = _el('ir-route-editing');
    if (!box || !box2 || !L || typeof L.describe !== 'function') return Promise.resolve(false);
    _bindCollapse();
    _applyCollapse();
    _fillModelDatalist();
    return L.describe().then(function (d) {
      box.innerHTML = _routeCard('generation', d.status.generation, d.apiConfigs);
      box2.innerHTML = _routeCard('editing', d.status.editing, d.apiConfigs);
      ROUTES.forEach(function (n) { _routeState(n, d.status[n]); });
      var badge = _el('ir-collapse-badge');
      var summary = _el('ir-collapse-summary');
      var gen = d.status.generation, edi = d.status.editing;
      if (summary) {
        summary.textContent = 'Generation: ' + (gen.model ? gen.model : '自动')
          + ' · Editing: ' + (edi.model ? edi.model : '自动');
      }
      if (badge) {
        var bad = !gen.ok || !edi.ok || !gen.enabled || !edi.enabled;
        badge.textContent = bad ? 'Needs setup' : 'Ready';
        badge.classList.toggle('is-on', !bad);
      }
      return true;
    }, function () { return false; });
  }

  function _readRoute(name) {
    var en = _el('ir-enabled-' + name), cf = _el('ir-config-' + name), md = _el('ir-model-' + name);
    var fcf = _el('ir-fbconfig-' + name), fmd = _el('ir-fbmodel-' + name);
    return {
      enabled: !!(en && en.checked),
      apiConfigId: cf ? cf.value : '',
      model: md ? md.value : '',
      fallback: { apiConfigId: fcf ? fcf.value : '', model: fmd ? fmd.value : '' }
    };
  }

  /* 保存前预校验：给出"去哪里修"，不静默保存一个必然失败的配置 */
  function _validate(routes) {
    var M = _models(), problems = [];
    ROUTES.forEach(function (n) {
      var r = routes[n];
      if (r.model && M && !M.supportsCapability(r.model, ROUTE_CAP[n])) {
        problems.push(ROUTE_LABEL[n] + '：模型 ' + r.model + ' 不支持该操作');
      }
      if (r.fallback && r.fallback.model && M && !M.supportsCapability(r.fallback.model, ROUTE_CAP[n])) {
        problems.push(ROUTE_LABEL[n] + '：备用模型 ' + r.fallback.model + ' 不支持该操作');
      }
    });
    return problems;
  }

  function save(btn) {
    var L = _cfg();
    if (!L || typeof L.saveRoutes !== 'function') { _status('Image Router 配置层未加载', 'bad'); return Promise.resolve(false); }
    var routes = {};
    ROUTES.forEach(function (n) { routes[n] = _readRoute(n); });
    var problems = _validate(routes);
    if (problems.length) { _status(problems.join('；'), 'bad'); if (typeof toast === 'function') toast(problems[0]); return Promise.resolve(false); }
    if (btn) { btn.disabled = true; }
    _status('保存中…');
    return L.saveRoutes(routes).then(function () {
      return render();
    }).then(function () {
      _status('已保存', 'ok');
      if (typeof toast === 'function') toast('Image Router 配置已保存');
      if (btn) btn.disabled = false;
      return true;
    }, function (e) {
      _status('保存失败：' + String((e && e.message) || e), 'bad');
      if (btn) btn.disabled = false;
      return false;
    });
  }

  NS.expose('imageRouterSettings', {
    render: render,
    save: save,
    routeLine: _routeLine
  });
  /* 既有代码风格：全局函数供 onclick 与 navTo 钩子调用 */
  if (typeof window !== 'undefined') {
    window.loadImageRouterSettingsUI = render;
    window.saveImageRouterSettingsUI = function (btn) { return save(btn); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { render(); });
    else try { render(); } catch (e) {}
  }
})(window.IB || (window.IB = {}));
