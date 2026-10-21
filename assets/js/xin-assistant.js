/* Xin (心) · IB system helper
   Independent local session, bounded settings actions, and existing provider/navigation seams. */
(function (root) {
  'use strict';
  if (!root || root.IBXin) return;

  var SESSION_KEY = 'ib_xin_session_v1';
  var PREFS_KEY = 'ib_xin_prefs_v1';
  var INDEPENDENT_CONFIG_ID = 'xinModelConfig';
  var INDEPENDENT_CREDENTIAL_REF = 'xin_model_v1';
  var MAX_MESSAGES = 30;
  var MAX_ACTIONS = 8;
  var MAX_TEXT = 6000;
  var PAGE_LABELS = Object.freeze({
    home: 'Home', settings: 'Settings', workspace: 'Agent Workspace', 'work-mode': 'Work Mode',
    blog: 'Blog', chat: 'Chat', letters: 'Letters', voicebox: 'Voicebox', roledm: 'Role DM',
    memory: 'Memory', active: 'Active', diary: 'Diary', moments: 'Moments',
    'moments-settings': 'Moments settings', api: 'Characters & API', guide: 'GUIDE', diy: 'DIY',
    about: 'Profile', apps: 'Apps', favorites: 'Favorites', diagnostics: 'Diagnostics',
    packaging: 'Packaging', economy: 'Economy', coread: 'Co-reading'
  });
  var GLOBAL_SETTINGS = Object.freeze({
    'appearance.theme': { label: '显示主题', type: 'theme' },
    'output.maxContinues': { label: '自动续写轮数', type: 'select', defaultValue: 3 }
  });
  var ROLE_SETTINGS = Object.freeze({
    temperature: { label: '温度', type: 'number', min: 0, max: 2, defaultValue: 1 },
    streaming: { label: '流式回复', type: 'boolean' },
    thinkingEnabled: { label: '思考链', type: 'boolean' },
    promptCache: { label: '提示缓存', type: 'boolean' }
  });
  var QUICK_START = [
    { label: '设置清单', question: '设置清单' },
    { label: '接入 API', question: '接入 API' },
    { label: 'Home Node', question: 'Home Node 诊断' }
  ];
  var state = { open: false, busy: false, messages: [], selectedApiId: '', modelMode: 'reuse',
    independentModel: null, independentLoaded: false, lastFocus: null };
  var els = {};

  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function text(value, max) { return String(value == null ? '' : value).slice(0, max || MAX_TEXT); }
  function safeJson(raw) { try { return JSON.parse(raw); } catch (_) { return null; } }
  function safeStorageGet(key) { try { return root.localStorage.getItem(key); } catch (_) { return null; } }
  function safeStorageSet(key, value) { try { root.localStorage.setItem(key, value); return true; } catch (_) { return false; } }
  function safeStorageRemove(key) { try { root.localStorage.removeItem(key); return true; } catch (_) { return false; } }

  function validUndoData(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.target === 'global' && own(GLOBAL_SETTINGS, data.key)) {
      return { target: 'global', key: data.key, oldValue: data.oldValue, appliedValue: data.appliedValue };
    }
    if (data.target === 'role' && typeof data.roleId === 'string' && own(ROLE_SETTINGS, data.field)) {
      return {
        target: 'role', roleId: data.roleId.slice(0, 180), field: data.field,
        oldExists: data.oldExists === true, oldValue: data.oldValue, appliedValue: data.appliedValue
      };
    }
    return null;
  }

  function loadHistory() {
    var saved = safeJson(safeStorageGet(SESSION_KEY) || '');
    if (!saved || saved.version !== 1 || !Array.isArray(saved.messages)) return [];
    return saved.messages.slice(-MAX_MESSAGES).map(function (item) {
      if (!item || (item.role !== 'user' && item.role !== 'assistant')) return null;
      var msg = { id: text(item.id, 80) || ('xin-' + Date.now()), role: item.role, text: text(item.text), actions: [] };
      if (msg.role === 'assistant' && containsToolProtocol(msg.text, null, safeJson(msg.text))) {
        msg.text = '上一条回复格式异常；其中的内部调用没有执行。';
        return msg;
      }
      if (Array.isArray(item.actions)) msg.actions = item.actions.slice(0, MAX_ACTIONS).map(function (action) {
        if (!action || typeof action !== 'object') return null;
        var kind = action.kind === 'open' ? 'open' : (action.kind === 'setting' ? 'setting' : 'notice');
        var clean = {
          kind: kind, ok: action.ok === true, label: text(action.label, 180),
          from: text(action.from, 100), to: text(action.to, 100),
          page: own(PAGE_LABELS, action.page) ? action.page : '',
          undone: action.undone === true, error: text(action.error, 200),
          undoData: validUndoData(action.undoData)
        };
        if (!clean.label) return null;
        return clean;
      }).filter(Boolean);
      return msg;
    }).filter(Boolean);
  }

  function persistHistory() {
    var payload = { version: 1, messages: state.messages.slice(-MAX_MESSAGES) };
    try { safeStorageSet(SESSION_KEY, JSON.stringify(payload)); } catch (_) { }
  }

  function loadPrefs() {
    var saved = safeJson(safeStorageGet(PREFS_KEY) || '');
    state.selectedApiId = saved && typeof saved.apiId === 'string' ? saved.apiId.slice(0, 180) : '';
    /* v1 only stored apiId. Keep that user's selected role API as the legacy reuse mode. */
    state.modelMode = saved && saved.mode === 'independent' ? 'independent' : 'reuse';
  }

  function persistPrefs() {
    safeStorageSet(PREFS_KEY, JSON.stringify({ version: 2, apiId: state.selectedApiId, mode: state.modelMode }));
  }

  function providerCatalog() {
    var list = root.PROVIDERS_DIR && root.PROVIDERS_DIR.PROVIDERS;
    if (!list && root.PROVIDERS) list = root.PROVIDERS;
    return list && typeof list === 'object' ? list : {};
  }

  function safeEndpoint(value) {
    var endpoint = String(value || '').trim();
    if (!endpoint || endpoint.length > 1000) return false;
    try {
      if (root._ibEndpointHasInlineCredential && root._ibEndpointHasInlineCredential(endpoint)) return false;
      var url = new URL(endpoint);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash;
    } catch (_) { return false; }
  }

  function normalizeIndependentConfig(row) {
    if (!row || typeof row !== 'object' || row.id !== INDEPENDENT_CONFIG_ID) return null;
    var provider = String(row.provider || '').trim();
    var catalog = providerCatalog();
    if (!own(catalog, provider)) return null;
    var endpoint = String(row.endpoint || '').trim();
    var model = text(row.model || '', 120).trim();
    if (!safeEndpoint(endpoint) || !model) return null;
    return { id: INDEPENDENT_CONFIG_ID, provider: provider, endpoint: endpoint, model: model,
      credentialRef: INDEPENDENT_CREDENTIAL_REF };
  }

  async function loadIndependentConfig(force) {
    if (state.independentLoaded && !force) return state.independentModel;
    state.independentLoaded = true;
    try {
      var row = typeof root.dbGet === 'function' ? await root.dbGet('apiSettings', INDEPENDENT_CONFIG_ID) : null;
      state.independentModel = normalizeIndependentConfig(row);
    } catch (_) { state.independentModel = null; }
    return state.independentModel;
  }

  async function persistIndependentConfig(config) {
    if (!config || !safeEndpoint(config.endpoint) || !String(config.model || '').trim() || !own(providerCatalog(), config.provider)) {
      throw new Error('Xin 模型配置无效，请检查 Provider、Endpoint 和模型名。');
    }
    if (typeof root.dbPut !== 'function') throw new Error('本地设置存储不可用。');
    /* This record contains public routing metadata and the Vault reference only. */
    var row = { id: INDEPENDENT_CONFIG_ID, mode: 'independent', provider: String(config.provider),
      endpoint: String(config.endpoint).trim(), model: text(config.model, 120).trim(),
      credentialRef: INDEPENDENT_CREDENTIAL_REF, updatedAt: Date.now() };
    await root.dbPut('apiSettings', row);
    state.independentModel = normalizeIndependentConfig(row);
    state.independentLoaded = true;
    return state.independentModel;
  }

  function outputOptions() {
    var select = document.getElementById('api-max-continues');
    if (!select || !select.options) return [0, 1, 3, 6, 10];
    return Array.prototype.map.call(select.options, function (option) { return Number(option.value); })
      .filter(function (value) { return Number.isInteger(value) && value >= 0 && value <= 10; });
  }

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function createButton(label, className, title) {
    var button = el('button', className, label);
    button.type = 'button';
    if (title) button.title = title;
    return button;
  }

  function mountLauncher(launcher) {
    var bridge = document.getElementById('ib-bridge-nav');
    var panel = document.getElementById('nav-more-panel');
    var useMore = false;

    function place() {
      var width = Number(root.innerWidth);
      useMore = width >= 769 && width <= 1180;
      if (useMore && panel) {
        launcher.classList.add('nav-more-item');
        launcher.setAttribute('role', 'menuitem');
        if (launcher.parentNode !== panel) panel.appendChild(launcher);
        return;
      }
      launcher.classList.remove('nav-more-item');
      launcher.removeAttribute('role');
      if (bridge && (launcher.parentNode !== bridge.parentNode || launcher.previousElementSibling !== bridge)) {
        bridge.insertAdjacentElement('afterend', launcher);
      } else if (!bridge && !launcher.parentNode) {
        document.body.appendChild(launcher);
      }
    }

    place();
    root.addEventListener('resize', place);
    if (panel && typeof root.MutationObserver === 'function') {
      var observer = new root.MutationObserver(function () {
        if (useMore && launcher.parentNode !== panel) place();
      });
      observer.observe(panel, { childList: true });
    }
  }

  function buildUi() {
    if (els.drawer) return;
    var launcher = createButton('', 'nav-btn xin-launcher', '打开 Xin（心）系统助手');
    launcher.id = 'xin-launcher';
    var launcherMark = el('span', 'xin-nav-glyph', '✧');
    launcherMark.setAttribute('aria-hidden', 'true');
    var launcherLabel = el('span', 'nav-action-label', 'Xin');
    launcher.appendChild(launcherMark);
    launcher.appendChild(launcherLabel);
    launcher.setAttribute('aria-label', 'Xin 系统助手');
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-controls', 'xin-drawer');
    launcher.setAttribute('aria-expanded', 'false');

    var scrim = el('div', 'xin-scrim');
    scrim.id = 'xin-scrim';
    scrim.hidden = true;

    var drawer = el('section', 'xin-drawer');
    drawer.id = 'xin-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'xin-title');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.hidden = true;

    var header = el('header', 'xin-header');
    var identity = el('div', 'xin-identity');
    var title = el('h2', 'xin-title', 'Xin（心）');
    title.id = 'xin-title';
    var subtitle = el('p', 'xin-subtitle', 'IB 使用 · 设置 · 诊断');
    identity.appendChild(title);
    identity.appendChild(subtitle);
    var controls = el('div', 'xin-controls');
    var source = createButton('Xin 模型', 'xin-source', '选择 Xin 使用的模型来源');
    source.id = 'xin-source';
    var clearMenu = document.createElement('details');
    clearMenu.className = 'xin-overflow';
    var clearSummary = el('summary', 'xin-overflow-toggle', '···');
    clearSummary.setAttribute('aria-label', '更多会话操作');
    clearSummary.title = '更多会话操作';
    var clear = createButton('清空会话', 'xin-clear', '清空 Xin 的独立会话');
    clear.id = 'xin-clear';
    clearMenu.appendChild(clearSummary);
    clearMenu.appendChild(clear);
    var close = createButton('关闭', 'xin-close', '关闭 Xin');
    close.setAttribute('aria-label', '关闭 Xin');
    close.textContent = '×';
    controls.appendChild(source);
    controls.appendChild(clearMenu);
    controls.appendChild(close);
    header.appendChild(identity);
    header.appendChild(controls);

    var apiMenu = el('div', 'xin-api-menu');
    apiMenu.id = 'xin-api-menu';
    apiMenu.hidden = true;
    apiMenu.setAttribute('role', 'menu');

    var quick = el('nav', 'xin-quick');
    quick.setAttribute('aria-label', '建议接下来做什么');
    quick.setAttribute('aria-live', 'polite');

    var modelStrip = el('section', 'xin-model-strip');
    modelStrip.hidden = true;
    var modelSummary = el('div', 'xin-model-summary');
    var modelSummaryText = el('span', 'xin-model-summary-text', 'Xin 独立模型尚未配置');
    var modelEdit = createButton('设置', 'xin-model-edit', '编辑 Xin 独立模型配置');
    modelEdit.id = 'xin-model-edit';
    modelSummary.appendChild(modelSummaryText);
    modelSummary.appendChild(modelEdit);

    var modelEditor = el('div', 'xin-model-editor');
    modelEditor.id = 'xin-model-editor';
    modelEditor.hidden = true;
    var modelEditorTitle = el('strong', 'xin-model-editor-title', '独立配置 Xin 模型');
    var modelProvider = document.createElement('select');
    modelProvider.className = 'xin-model-field';
    modelProvider.id = 'xin-model-provider';
    modelProvider.setAttribute('aria-label', 'Provider');
    var modelEndpoint = document.createElement('input');
    modelEndpoint.className = 'xin-model-field';
    modelEndpoint.id = 'xin-model-endpoint';
    modelEndpoint.type = 'url';
    modelEndpoint.placeholder = 'Endpoint，例如 https://…/v1/chat/completions';
    modelEndpoint.setAttribute('aria-label', 'Endpoint');
    var modelName = document.createElement('input');
    modelName.className = 'xin-model-field';
    modelName.id = 'xin-model-name';
    modelName.type = 'text';
    modelName.maxLength = 120;
    modelName.placeholder = '模型名';
    modelName.setAttribute('aria-label', '模型名');
    var modelKey = document.createElement('input');
    modelKey.className = 'xin-model-field xin-model-key';
    modelKey.id = 'xin-model-key';
    modelKey.type = 'password';
    modelKey.autocomplete = 'new-password';
    modelKey.placeholder = '可选：绑定或更新 Xin 的 Vault 凭据';
    modelKey.setAttribute('aria-label', '写入 Xin Credential Vault 的 API Key');
    function fieldLabel(label, id) {
      var node = el('label', 'xin-model-label', label);
      node.htmlFor = id;
      return node;
    }
    var modelNote = el('p', 'xin-model-note', '只保存 Provider、Endpoint、模型和 Vault 引用。Key 直接交给现有 Credential Vault，成功后会清空输入框。');
    var modelStatus = el('p', 'xin-model-status');
    modelStatus.setAttribute('role', 'status');
    var modelActions = el('div', 'xin-model-actions');
    var modelSave = createButton('保存配置', 'xin-model-save');
    var modelCancel = createButton('取消', 'xin-model-cancel');
    modelSave.id = 'xin-model-save';
    modelCancel.id = 'xin-model-cancel';
    modelActions.appendChild(modelCancel);
    modelActions.appendChild(modelSave);
    modelEditor.appendChild(modelEditorTitle);
    modelEditor.appendChild(fieldLabel('Provider', 'xin-model-provider'));
    modelEditor.appendChild(modelProvider);
    modelEditor.appendChild(fieldLabel('Endpoint', 'xin-model-endpoint'));
    modelEditor.appendChild(modelEndpoint);
    modelEditor.appendChild(fieldLabel('模型', 'xin-model-name'));
    modelEditor.appendChild(modelName);
    modelEditor.appendChild(fieldLabel('API Key · Credential Vault', 'xin-model-key'));
    modelEditor.appendChild(modelKey);
    modelEditor.appendChild(modelNote);
    modelEditor.appendChild(modelStatus);
    modelEditor.appendChild(modelActions);
    modelStrip.appendChild(modelSummary);
    modelStrip.appendChild(modelEditor);

    var transcript = el('div', 'xin-transcript');
    transcript.id = 'xin-transcript';
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-live', 'polite');
    transcript.setAttribute('aria-relevant', 'additions text');

    var composer = el('div', 'xin-composer');
    var input = el('textarea', 'xin-input');
    input.id = 'xin-input';
    input.rows = 1;
    input.maxLength = 2000;
    input.placeholder = '问功能在哪、怎么用，或说明要改哪项设置';
    input.setAttribute('aria-label', '给 Xin 发消息');
    var send = createButton('发送', 'xin-send');
    send.id = 'xin-send';
    composer.appendChild(input);
    composer.appendChild(send);

    drawer.appendChild(header);
    drawer.appendChild(apiMenu);
    drawer.appendChild(modelStrip);
    drawer.appendChild(transcript);
    drawer.appendChild(quick);
    drawer.appendChild(composer);
    mountLauncher(launcher);
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);

    els = { launcher: launcher, scrim: scrim, drawer: drawer, title: title, source: source,
      clear: clear, clearMenu: clearMenu, close: close, apiMenu: apiMenu, quick: quick, transcript: transcript,
      modelStrip: modelStrip, modelSummaryText: modelSummaryText, modelEdit: modelEdit,
      modelEditor: modelEditor, modelProvider: modelProvider, modelEndpoint: modelEndpoint,
      modelName: modelName, modelKey: modelKey, modelStatus: modelStatus,
      modelSave: modelSave, modelCancel: modelCancel, input: input, send: send };
    populateProviderPicker();
    launcher.addEventListener('click', function () {
      var parentPanel = launcher.closest && launcher.closest('.nav-more-panel');
      var moreButton = parentPanel && document.getElementById('nav-more-btn');
      if (parentPanel && !parentPanel.hidden) {
        parentPanel.hidden = true;
        if (moreButton) moreButton.setAttribute('aria-expanded', 'false');
      }
      open();
      if (parentPanel && moreButton) state.lastFocus = moreButton;
    });
    scrim.addEventListener('click', closeDrawer);
    close.addEventListener('click', closeDrawer);
    clear.addEventListener('click', function () { clearMenu.open = false; clearSession(); });
    source.addEventListener('click', toggleApiMenu);
    modelEdit.addEventListener('click', function () { openIndependentEditor(); });
    modelCancel.addEventListener('click', function () { closeIndependentEditor(); });
    modelSave.addEventListener('click', function () { saveIndependentEditor(); });
    modelProvider.addEventListener('change', function () { applyProviderDefaults(modelProvider.value); });
    send.addEventListener('click', submit);
    input.addEventListener('input', resizeInput);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); submit();
      }
    });
    quick.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-xin-question],[data-xin-page],[data-xin-action]');
      if (!button) return;
      if (button.hasAttribute('data-xin-question')) sendText(button.getAttribute('data-xin-question') || '');
      else if (button.hasAttribute('data-xin-page')) jumpTo(button.getAttribute('data-xin-page') || '');
      else if (button.getAttribute('data-xin-action') === 'model') toggleApiMenu();
    });
    drawer.addEventListener('click', handleTranscriptClick);
    drawer.addEventListener('keydown', handleDialogKeys);
    renderHistory();
    refreshSourceLabel();
  }

  function handleDialogKeys(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); return; }
    if (event.key !== 'Tab') return;
    var nodes = Array.prototype.slice.call(els.drawer.querySelectorAll('summary,button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled])'))
      .filter(function (node) { return !node.hidden && node.getClientRects().length; });
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function setDrawer(opened) {
    if (!els.drawer) buildUi();
    state.open = opened;
    els.drawer.hidden = !opened;
    els.scrim.hidden = !opened;
    els.drawer.classList.toggle('is-open', opened);
    els.drawer.setAttribute('aria-hidden', opened ? 'false' : 'true');
    els.launcher.setAttribute('aria-expanded', opened ? 'true' : 'false');
    document.body.classList.toggle('xin-open', opened);
    if (opened) {
      state.lastFocus = document.activeElement;
      requestAnimationFrame(function () { els.input.focus(); scrollTranscript(); });
    } else if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
      state.lastFocus.focus();
    }
  }

  function open() {
    buildUi();
    setDrawer(true);
    if (state.modelMode === 'independent') {
      loadIndependentConfig().then(function () { refreshSourceLabel(); });
    } else apiConfigsLive().then(function () { refreshSourceLabel(); }).catch(function () { refreshSourceLabel(); });
  }

  function closeDrawer() {
    if (!els.drawer || !state.open) return;
    els.apiMenu.hidden = true;
    if (els.clearMenu) els.clearMenu.open = false;
    if (els.modelKey) els.modelKey.value = '';
    setDrawer(false);
  }

  function refreshSourceLabel() {
    if (!els.source) return;
    if (state.modelMode === 'independent') {
      var config = state.independentModel;
      els.source.textContent = config ? ('独立 · ' + text(config.model, 24) + ' ▾') : '独立配置 ▾';
      els.source.disabled = false;
      els.source.title = 'Xin 使用独立 Provider、Endpoint、模型和 Credential Vault 绑定';
      if (els.modelStrip) els.modelStrip.hidden = false;
      if (els.modelSummaryText) {
        els.modelSummaryText.textContent = config
          ? (providerName(config.provider) + ' · ' + config.model + ' · Credential Vault')
          : '独立模型尚未配置；不需要创建角色 API。';
      }
      return;
    }
    var list = getApiConfigs();
    var selected = state.selectedApiId
      ? list.filter(function (item) { return item.id === state.selectedApiId; })[0]
      : list[0];
    if (selected && !state.selectedApiId) {
      state.selectedApiId = selected.id;
      persistPrefs();
    }
    els.source.textContent = selected ? ('复用 ' + apiLabel(selected) + ' ▾')
      : (state.selectedApiId ? '已选来源不可用 ▾' : '选择模型 ▾');
    els.source.disabled = false;
    els.source.title = list.length ? '复用角色 API，或为 Xin 设置独立模型' : '选择独立配置即可不创建角色 API';
    if (els.modelStrip) els.modelStrip.hidden = true;
  }

  function apiLabel(config) {
    return text(config && (config.nickname || config.name || config.model || 'API'), 56);
  }

  function providerName(id) {
    try { if (root.PROVIDERS_DIR && typeof root.PROVIDERS_DIR.providerDisplayName === 'function') return text(root.PROVIDERS_DIR.providerDisplayName(id), 50); } catch (_) { }
    var meta = providerCatalog()[String(id || '')];
    return text(meta && (meta.name || id) || id || 'Provider', 50);
  }

  function getApiConfigs() {
    var source = [];
    try {
      if (Array.isArray(root.apiConfigs)) source = root.apiConfigs;
      else if (root.IB && root.IB.social && Array.isArray(root.IB.social.apiConfigs)) source = root.IB.social.apiConfigs;
      else if (typeof apiConfigs !== 'undefined' && Array.isArray(apiConfigs)) source = apiConfigs;
    } catch (_) { source = []; }
    return source.filter(function (config) {
      return config && typeof config.id === 'string' && config.id && !config.archived && !config._group;
    }).map(function (config) {
      return { id: text(config.id, 180), nickname: text(config.nickname || config.name || '', 90),
        model: text(config.model || '', 90), provider: text(config.provider || 'openai', 50),
        endpoint: text(config.endpoint || '', 1000), credentialRef: text(config.credentialRef || '', 180),
        config: config };
    });
  }

  function apiConfigsLive() {
    if (typeof root.loadApiConfigs === 'function') return Promise.resolve(root.loadApiConfigs()).then(getApiConfigs);
    return Promise.resolve(getApiConfigs());
  }

  function toggleApiMenu() {
    if (!els.apiMenu.hidden) { els.apiMenu.hidden = true; return; }
    refreshApiMenu().then(function () { if (els.apiMenu.children.length) els.apiMenu.hidden = false; });
  }

  function refreshApiMenu() {
    if (!els.apiMenu) return Promise.resolve();
    return apiConfigsLive().then(function (list) {
      while (els.apiMenu.firstChild) els.apiMenu.removeChild(els.apiMenu.firstChild);
      els.apiMenu.appendChild(el('div', 'xin-api-menu-title', '选择 Xin 模型来源'));
      var modes = el('div', 'xin-model-modes');
      var reuseMode = createButton('复用现有配置', 'xin-model-mode' + (state.modelMode === 'reuse' ? ' is-active' : ''));
      reuseMode.setAttribute('aria-pressed', state.modelMode === 'reuse' ? 'true' : 'false');
      reuseMode.addEventListener('click', function () { chooseReuseMode(); });
      var independentMode = createButton('独立配置', 'xin-model-mode' + (state.modelMode === 'independent' ? ' is-active' : ''));
      independentMode.setAttribute('aria-pressed', state.modelMode === 'independent' ? 'true' : 'false');
      independentMode.addEventListener('click', function () { chooseIndependentMode(); });
      modes.appendChild(reuseMode);
      modes.appendChild(independentMode);
      els.apiMenu.appendChild(modes);
      if (state.modelMode === 'independent') {
        var independentAction = createButton(state.independentModel ? '编辑 Xin 独立模型' : '配置 Xin 独立模型', 'xin-api-option');
        independentAction.addEventListener('click', function () {
          els.apiMenu.hidden = true;
          openIndependentEditor();
        });
        els.apiMenu.appendChild(independentAction);
      }
      els.apiMenu.appendChild(el('p', 'xin-api-menu-caption', '角色 API 不会被修改。导入只复制参数，不复制角色凭据。'));
      if (!list.length) els.apiMenu.appendChild(el('p', 'xin-api-empty', '当前没有可复用的角色 API；可以直接设置独立模型。'));
      list.forEach(function (item) {
        var row = el('div', 'xin-api-row');
        var button = createButton(apiLabel(item) + (item.model ? (' · ' + text(item.model, 60)) : ''), 'xin-api-option');
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', state.modelMode === 'reuse' && item.id === state.selectedApiId ? 'true' : 'false');
        button.addEventListener('click', function () { chooseRoleApi(item.id); });
        var importButton = createButton('导入', 'xin-api-import', '将 Provider、Endpoint 和模型参数导入 Xin 独立配置，不复制凭据');
        importButton.addEventListener('click', function () { importRoleParameters(item.id); });
        row.appendChild(button);
        row.appendChild(importButton);
        els.apiMenu.appendChild(row);
      });
      refreshSourceLabel();
    }).catch(function () {
      while (els.apiMenu.firstChild) els.apiMenu.removeChild(els.apiMenu.firstChild);
      els.apiMenu.appendChild(el('div', 'xin-api-menu-title', '选择 Xin 模型来源'));
      els.apiMenu.appendChild(el('p', 'xin-api-empty', '角色 API 暂时不可用；仍可配置独立模型。'));
      var independent = createButton('配置 Xin 独立模型', 'xin-api-option');
      independent.addEventListener('click', function () { chooseIndependentMode(); });
      els.apiMenu.appendChild(independent);
    });
  }

  function populateProviderPicker() {
    if (!els.modelProvider) return;
    while (els.modelProvider.firstChild) els.modelProvider.removeChild(els.modelProvider.firstChild);
    var ids = root.PROVIDERS_DIR && typeof root.PROVIDERS_DIR.providerPickerList === 'function'
      ? root.PROVIDERS_DIR.providerPickerList() : Object.keys(providerCatalog());
    ids.forEach(function (id) {
      var option = document.createElement('option');
      option.value = id;
      option.textContent = providerName(id);
      els.modelProvider.appendChild(option);
    });
  }

  function defaultIndependentConfig() {
    var catalog = providerCatalog();
    var provider = own(catalog, 'openai') ? 'openai' : Object.keys(catalog)[0];
    var meta = catalog[provider] || {};
    return { id: INDEPENDENT_CONFIG_ID, provider: provider || 'custom', endpoint: String(meta.endpoint || ''),
      model: String(meta.model || ''), credentialRef: INDEPENDENT_CREDENTIAL_REF };
  }

  function applyProviderDefaults(provider) {
    var meta = providerCatalog()[String(provider || '')] || {};
    if (els.modelEndpoint) els.modelEndpoint.value = String(meta.endpoint || '');
    if (els.modelName) els.modelName.value = String(meta.model || '');
  }

  async function chooseReuseMode() {
    state.modelMode = 'reuse';
    persistPrefs();
    if (els.apiMenu) els.apiMenu.hidden = true;
    closeIndependentEditor();
    refreshSourceLabel();
  }

  async function chooseIndependentMode() {
    state.modelMode = 'independent';
    persistPrefs();
    if (els.apiMenu) els.apiMenu.hidden = true;
    await loadIndependentConfig();
    refreshSourceLabel();
    if (!state.independentModel) openIndependentEditor(defaultIndependentConfig(), '设置 Xin 自己的 Provider、Endpoint 和模型；无需创建角色 API。');
  }

  function chooseRoleApi(id) {
    state.modelMode = 'reuse';
    state.selectedApiId = String(id || '').slice(0, 180);
    persistPrefs();
    if (els.apiMenu) els.apiMenu.hidden = true;
    closeIndependentEditor();
    refreshSourceLabel();
  }

  async function importRoleParameters(id) {
    var list = await apiConfigsLive();
    var entry = list.filter(function (item) { return item.id === id; })[0];
    if (!entry) return;
    var initial = { id: INDEPENDENT_CONFIG_ID, provider: entry.provider, endpoint: safeEndpoint(entry.endpoint) ? entry.endpoint : '',
      model: entry.model, credentialRef: INDEPENDENT_CREDENTIAL_REF };
    state.modelMode = 'independent';
    persistPrefs();
    if (initial.endpoint && initial.model && own(providerCatalog(), initial.provider)) {
      try { await persistIndependentConfig(initial); } catch (_) { }
    }
    if (els.apiMenu) els.apiMenu.hidden = true;
    refreshSourceLabel();
    var note = initial.endpoint
      ? '已复制 Provider、Endpoint 和模型。角色凭据没有复制；请为 Xin 单独写入 Credential Vault。'
      : '已复制 Provider 和模型；Endpoint 未通过安全校验，请检查后填写。角色凭据没有复制。';
    addMessage('assistant', note);
    await openIndependentEditor(initial, note);
  }

  async function openIndependentEditor(initial, note) {
    if (!els.modelEditor) return;
    var saved = await loadIndependentConfig();
    var config = initial || saved || defaultIndependentConfig();
    var catalog = providerCatalog();
    if (!own(catalog, config.provider)) config.provider = 'custom';
    els.modelStrip.hidden = false;
    els.modelEditor.hidden = false;
    els.drawer.classList.add('is-model-editing');
    els.modelProvider.value = config.provider;
    els.modelEndpoint.value = config.endpoint || '';
    els.modelName.value = config.model || '';
    els.modelKey.value = '';
    els.modelStatus.textContent = note || '独立配置使用 Xin 自己的 Vault 绑定；不会读取或覆盖角色 API 凭据。';
    els.modelKey.focus();
  }

  function closeIndependentEditor() {
    if (els.modelEditor) els.modelEditor.hidden = true;
    if (els.modelKey) els.modelKey.value = '';
    if (els.drawer) els.drawer.classList.remove('is-model-editing');
  }

  function vaultSaveErrorText(error) {
    var code = String(error && error.code || '');
    var message = String(error && error.message || '');
    if (/CREDENTIAL_UNAVAILABLE|credentials-service-unavailable/i.test(code + ' ' + message)) return 'Credential Vault 当前不可用；Key 未写入本地设置。可以在应用的正式桌面窗口重试。';
    if (/credentials-save-rejected/i.test(code + ' ' + message)) return 'Credential Vault 没有确认保存；Key 未写入本地设置。请重试或检查服务状态。';
    return 'Xin 模型参数已保存，但 Credential Vault 写入未确认。Key 未写入本地设置。';
  }

  async function saveIndependentEditor() {
    if (!els.modelSave || els.modelSave.disabled) return;
    var config = { provider: String(els.modelProvider.value || ''), endpoint: String(els.modelEndpoint.value || '').trim(),
      model: String(els.modelName.value || '').trim() };
    var secret = String(els.modelKey.value || '');
    if (!own(providerCatalog(), config.provider)) { els.modelStatus.textContent = '请选择当前 Provider 目录中的服务商。'; return; }
    if (!safeEndpoint(config.endpoint)) { els.modelStatus.textContent = 'Endpoint 必须是 HTTP(S) 地址，且不能在 URL 中携带 Key 或 token。'; return; }
    if (!config.model || config.model.length > 120) { els.modelStatus.textContent = '请填写模型名（最多 120 字符）。'; return; }
    els.modelSave.disabled = true;
    els.modelStatus.textContent = '正在保存 Xin 模型参数…';
    var saved = false, credentialSaved = false;
    try {
      await persistIndependentConfig(config);
      state.modelMode = 'independent';
      persistPrefs();
      saved = true;
      if (secret.trim()) {
        if (typeof root._ibWriteVaultCredential !== 'function') throw new Error('credentials-service-unavailable');
        await root._ibWriteVaultCredential(INDEPENDENT_CREDENTIAL_REF, config, secret);
        credentialSaved = true;
      }
    } catch (error) {
      els.modelStatus.textContent = saved ? vaultSaveErrorText(error) : text(error && error.message || '配置没有保存。', 180);
      return;
    } finally {
      els.modelKey.value = '';
      els.modelSave.disabled = false;
    }
    closeIndependentEditor();
    refreshSourceLabel();
    addMessage('assistant', credentialSaved
      ? 'Xin 独立模型参数已保存，新的凭据已交由 Credential Vault 管理。角色 API 配置与凭据保持原样。'
      : 'Xin 独立模型参数已保存。若 xin_model_v1 尚无可用凭据，请在设置面板输入 Key 并保存到 Credential Vault。');
  }

  function resizeInput() {
    if (!els.input) return;
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(112, els.input.scrollHeight) + 'px';
  }

  function quickSuggestions() {
    if (!state.messages.length) return QUICK_START;
    var last = state.messages[state.messages.length - 1];
    var lastUser = state.messages.slice().reverse().filter(function (item) { return item.role === 'user'; })[0];
    var q = String(lastUser && lastUser.text || '').toLowerCase();
    if (last && last.role === 'assistant' && (last.actions || []).some(function (action) { return action.kind === 'setting'; })) {
      return [
        { label: '设置清单', question: '设置清单' },
        { label: '打开 Settings', page: 'settings' },
        { label: '再调整一项', question: '我想调整一项设置' }
      ];
    }
    if (/home node|runner|节点|服务.*挂|诊断/.test(q)) {
      return [
        { label: '服务详情', page: 'diagnostics' },
        { label: '缓存探针', question: '缓存探针' },
        { label: '图片探针', question: '图片探针' }
      ];
    }
    if (/api|模型|凭据|key|中转/.test(q)) {
      return [
        { label: 'Xin 模型', action: 'model' },
        { label: '角色与 API', page: 'api' },
        { label: '接入 API', question: '接入 API' }
      ];
    }
    if (/设置|主题|续写|温度|流式|思考链/.test(q)) {
      return [
        { label: '设置清单', question: '设置清单' },
        { label: '打开 Settings', page: 'settings' },
        { label: 'Home Node', question: 'Home Node 诊断' }
      ];
    }
    return [
      { label: '设置清单', question: '设置清单' },
      { label: '找功能', question: '我想找一个功能' },
      { label: 'Home Node', question: 'Home Node 诊断' }
    ];
  }

  function updateQuickSuggestions() {
    if (!els.quick) return;
    while (els.quick.firstChild) els.quick.removeChild(els.quick.firstChild);
    quickSuggestions().slice(0, 3).forEach(function (item) {
      var chip = createButton(item.label, 'xin-chip');
      if (item.question) chip.setAttribute('data-xin-question', item.question);
      if (item.page) chip.setAttribute('data-xin-page', item.page);
      if (item.action) chip.setAttribute('data-xin-action', item.action);
      els.quick.appendChild(chip);
    });
  }

  function renderHistory() {
    if (!els.transcript) return;
    while (els.transcript.firstChild) els.transcript.removeChild(els.transcript.firstChild);
    if (!state.messages.length) {
      var welcome = el('div', 'xin-welcome');
      var line = el('p', '', '你好，我在。你可以问功能、设置，或看看现有诊断。');
      var note = el('p', 'xin-welcome-note', '要找页面时，我会把入口放在回复下面。');
      welcome.appendChild(line);
      welcome.appendChild(note);
      els.transcript.appendChild(welcome);
      updateQuickSuggestions();
      return;
    }
    state.messages.forEach(function (message) { renderMessage(message); });
    scrollTranscript();
    updateQuickSuggestions();
  }

  function renderMessage(message) {
    var bubble = el('article', 'xin-message ' + (message.role === 'user' ? 'is-user' : 'is-assistant'));
    bubble.setAttribute('data-message-id', message.id);
    var content = el('div', 'xin-message-text');
    if (message.role === 'assistant' && typeof root._mdRenderHtml === 'function') {
      var richText = el('div', 'r-text');
      try { richText.innerHTML = root._mdRenderHtml(message.text, false); }
      catch (_) { richText.textContent = message.text; }
      content.classList.add('md-rendered');
      content.appendChild(richText);
    } else content.textContent = message.text;
    bubble.appendChild(content);
    (message.actions || []).forEach(function (action, index) {
      var row = el('div', 'xin-action ' + (action.ok ? 'is-ok' : 'is-error'));
      row.setAttribute('data-action-index', String(index));
      var info = el('div', 'xin-action-copy');
      info.appendChild(el('strong', '', action.label));
      if (action.kind === 'setting' && action.ok) {
        var values = el('span', 'xin-action-values');
        values.appendChild(el('span', 'xin-action-old', '之前 ' + action.from));
        values.appendChild(el('span', 'xin-action-arrow', '→'));
        values.appendChild(el('span', 'xin-action-new', '现在 ' + (action.undone ? action.from : action.to)));
        info.appendChild(values);
      } else if (action.error) info.appendChild(el('span', 'xin-action-error', action.error));
      row.appendChild(info);
      if (action.kind === 'setting' && action.ok && action.undoData && !action.undone) {
        var undo = createButton('撤销', 'xin-action-button xin-undo');
        undo.setAttribute('data-xin-action', 'undo');
        row.appendChild(undo);
      } else if (action.kind === 'open' && action.ok && action.page) {
        var jump = createButton('打开 →', 'xin-action-button xin-jump');
        jump.setAttribute('data-xin-action', 'jump');
        row.appendChild(jump);
      } else if (action.undone) row.appendChild(el('span', 'xin-undone', '已撤销'));
      bubble.appendChild(row);
    });
    els.transcript.appendChild(bubble);
  }

  function scrollTranscript() {
    if (els.transcript) els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  function renderAll() { renderHistory(); }

  function addMessage(role, content, actions) {
    var message = { id: 'xin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      role: role === 'user' ? 'user' : 'assistant', text: text(content), actions: Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [] };
    state.messages.push(message);
    state.messages = state.messages.slice(-MAX_MESSAGES);
    persistHistory();
    if (els.transcript) {
      if (state.messages.length === 1) renderAll();
      else { renderMessage(message); scrollTranscript(); updateQuickSuggestions(); }
    } else updateQuickSuggestions();
    return message;
  }

  function handleTranscriptClick(event) {
    var button = event.target.closest && event.target.closest('[data-xin-action]');
    if (!button) return;
    var row = button.closest('[data-action-index]');
    var bubble = button.closest('[data-message-id]');
    if (!row || !bubble) return;
    var message = state.messages.filter(function (item) { return item.id === bubble.getAttribute('data-message-id'); })[0];
    var action = message && message.actions[Number(row.getAttribute('data-action-index'))];
    if (!action) return;
    if (button.getAttribute('data-xin-action') === 'undo') undoAction(action, message);
    else if (button.getAttribute('data-xin-action') === 'jump') jumpTo(action.page);
  }

  async function undoAction(action, message) {
    if (!action || action.undone || !action.undoData) return;
    try {
      var current = await readUndoTarget(action.undoData);
      if (!sameValue(current.value, action.undoData.appliedValue) ||
          (current.exists !== undefined && action.undoData.target === 'role' && current.exists !== true)) {
        action.error = '设置已在别处变化；为避免覆盖，我没有撤销。';
        action.undoData = null;
      } else {
        await restoreUndoTarget(action.undoData);
        action.undone = true;
        action.error = '';
      }
    } catch (_) { action.error = '撤销失败；请在原设置页确认当前值。'; }
    persistHistory();
    renderAll();
  }

  function sameValue(a, b) {
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return a === b;
  }

  async function readGlobalValue(key) {
    if (key === 'appearance.theme') return document.body.classList.contains('theme-infernal') ? 'infernal' : 'internal';
    if (key === 'output.maxContinues') {
      if (typeof root.loadOutputSettings === 'function') await root.loadOutputSettings();
      var row = typeof root.dbGet === 'function' ? await root.dbGet('apiSettings', 'outputSettings') : null;
      var value = row && row.maxContinues != null ? Number(row.maxContinues) : 3;
      return isFinite(value) ? Math.max(0, Math.min(10, Math.floor(value))) : 3;
    }
    throw new Error('global-setting-not-allowed');
  }

  function isThemeTransitioning() {
    try { return typeof themeTransitioning !== 'undefined' && !!themeTransitioning; } catch (_) { return false; }
  }

  function waitForThemeIdle() {
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      (function poll() {
        if (!isThemeTransitioning()) { resolve(); return; }
        if (Date.now() - started > 8000) { reject(new Error('主题切换仍在进行')); return; }
        setTimeout(poll, 50);
      })();
    });
  }

  function waitForThemeValue(value) {
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      (function poll() {
        var applied = document.body.classList.contains('theme-infernal') ? 'infernal' : 'internal';
        if (applied === value) { resolve(); return; }
        if (Date.now() - started > 5000) { reject(new Error('主题切换没有完成')); return; }
        setTimeout(poll, 40);
      })();
    });
  }

  async function writeGlobalValue(key, value) {
    if (key === 'appearance.theme') {
      if (value !== 'internal' && value !== 'infernal') throw new Error('主题值不在允许范围');
      var current = document.body.classList.contains('theme-infernal') ? 'infernal' : 'internal';
      if (current !== value) {
        if (typeof root.toggleTheme !== 'function') throw new Error('主题切换接口不可用');
        await waitForThemeIdle();
        root.toggleTheme();
        await waitForThemeValue(value);
      }
      return;
    }
    if (key === 'output.maxContinues') {
      var number = Number(value);
      if (!Number.isInteger(number) || outputOptions().indexOf(number) < 0) throw new Error('续写轮数只能选择：' + outputOptions().join('、'));
      var input = document.getElementById('api-max-continues');
      if (!input || typeof root.saveOutputSettings !== 'function') throw new Error('输出设置接口不可用');
      input.value = String(number);
      await root.saveOutputSettings();
      if (!sameValue(await readGlobalValue(key), number)) throw new Error('现有输出设置接口没有保存这个值');
      return;
    }
    throw new Error('global-setting-not-allowed');
  }

  async function getRole(id) {
    await apiConfigsLive();
    return getApiConfigs().filter(function (item) { return item.id === id; })[0] || null;
  }

  function readRoleValue(config, field) {
    if (!config || !own(ROLE_SETTINGS, field)) throw new Error('role-setting-not-allowed');
    return { exists: own(config, field), value: config[field] };
  }

  function displayRoleValue(config, field) {
    var current = readRoleValue(config, field);
    if (!current.exists) return '默认';
    if (typeof current.value === 'boolean') return current.value ? '开启' : '关闭';
    return String(current.value);
  }

  function validateRoleValue(field, value) {
    var spec = ROLE_SETTINGS[field];
    if (!spec) throw new Error('这项角色设置不在允许范围');
    if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('这项只接受开或关');
      return value;
    }
    var number = Number(value);
    if (!Number.isFinite(number) || number < spec.min || number > spec.max) throw new Error('温度必须在 0 到 2 之间');
    return Math.round(number * 100) / 100;
  }

  async function writeRoleValue(id, field, value, restore) {
    if (!own(ROLE_SETTINGS, field)) throw new Error('这项角色设置不在允许范围');
    var entry = await getRole(id);
    if (!entry) throw new Error('找不到这位角色的 API 配置');
    var nextValue = restore ? restore.value : validateRoleValue(field, value);
    var next = Object.assign({}, entry.config);
    delete next.apiKey;
    delete next.imageGenApiKey;
    if (restore && restore.exists === false) delete next[field];
    else next[field] = nextValue;
    if (typeof root._persistApiConfig !== 'function') throw new Error('角色 API 配置保存接口不可用');
    await root._persistApiConfig(next);
    if (typeof root.loadApiConfigs === 'function') await root.loadApiConfigs();
  }

  async function readUndoTarget(data) {
    if (data.target === 'global') return { value: await readGlobalValue(data.key) };
    var entry = await getRole(data.roleId);
    if (!entry) throw new Error('role-unavailable');
    var result = readRoleValue(entry.config, data.field);
    return { value: result.value, exists: result.exists };
  }

  async function restoreUndoTarget(data) {
    if (data.target === 'global') return writeGlobalValue(data.key, data.oldValue);
    return writeRoleValue(data.roleId, data.field, data.oldValue, { exists: data.oldExists, value: data.oldValue });
  }

  function normalizeTheme(value) {
    var v = String(value || '').toLowerCase();
    if (['internal', 'light', '明亮', '浅色'].indexOf(v) >= 0) return 'internal';
    if (['infernal', 'dark', '暗色', '深色'].indexOf(v) >= 0) return 'infernal';
    throw new Error('主题只接受 Internal（明亮）或 Infernal（暗色）');
  }

  function formatGlobalValue(key, value) {
    if (key === 'appearance.theme') return value === 'infernal' ? 'Infernal（暗色）' : 'Internal（明亮）';
    return Number(value) === 0 ? '0 轮（关闭自动续写）' : String(value) + ' 轮';
  }

  function mutationRequested(question) {
    var q = String(question || '').trim();
    var target = /主题|appearance\.theme|theme|自动续写|续写轮数|maxContinues|温度|temperature|流式|streaming|思考链|thinkingEnabled|提示缓存|prompt\s*cache/i.test(q);
    var namedChange = /(?:把|将|帮我|替我).{0,100}(?:改|设|调|开|关|增|减|切换|切到|切成|启用|停用|增加|减少)|^(?:开启|关闭|关掉|启用|停用|设为|调到|调为|改成|减少|增加|切换|切到|切成)[^?？]*$|^(?:please\s+)?(?:set|change|enable|disable|turn\s+(?:on|off))\b/i.test(q);
    var clearToggle = /^(?:打开|开启|关闭|关掉|启用|停用)\s*.+/i.test(q) && /(?:自动续写|流式|streaming|思考链|thinkingEnabled|提示缓存|prompt\s*cache)/i.test(q);
    var direct = namedChange || clearToggle;
    var uncertain = /[?？]|不要|别(?:再)?|不必|不用|不想|暂不|暂时|先不|是否|要不要|能不能|可不可以|能否|可以吗|行吗|好吗|会不会|如果|假如|假设|万一|也许|或许|可能|考虑|试试|尝试|试着|不确定|请问|怎么|如何|为什么|说说|讲讲|解释一下|\bdon't\b|\bdo not\b|\bnever\b|\bshould i\b|\bwould you\b|\bcan you\b|\bcould you\b|\bmaybe\b|\bperhaps\b/i.test(q);
    return target && direct && !uncertain;
  }

  function hasUncertainMutationIntent(question) {
    var q = String(question || '');
    var target = /主题|appearance\.theme|theme|自动续写|续写轮数|maxContinues|温度|temperature|流式|streaming|思考链|thinkingEnabled|提示缓存|prompt\s*cache/i.test(q);
    var changeLanguage = /改|设|调|开|关|增|减|切换|切到|切成|启用|停用|增加|减少|关闭|开启|\bset\b|\bchange\b|\benable\b|\bdisable\b|\bturn\s+(?:on|off)\b/i.test(q);
    var uncertainty = /[?？]|不要|别(?:再)?|不必|不用|不想|暂不|暂时|先不|是否|要不要|能不能|可不可以|能否|可以吗|行吗|好吗|会不会|如果|假如|假设|万一|也许|或许|可能|考虑|试试|尝试|试着|不确定|\bdon't\b|\bdo not\b|\bnever\b|\bshould i\b|\bwould you\b|\bcan you\b|\bcould you\b|\bmaybe\b|\bperhaps\b/i.test(q);
    return target && changeLanguage && uncertainty;
  }

  function settingPattern(scope, keyOrField) {
    if (scope === 'global') {
      if (keyOrField === 'appearance.theme') return /主题|appearance\.theme|theme/i;
      if (keyOrField === 'output.maxContinues') return /自动续写(?:轮数)?|续写轮数|maxContinues/i;
      return null;
    }
    if (keyOrField === 'temperature') return /温度|temperature/i;
    if (keyOrField === 'streaming') return /流式(?:回复|输出)?|streaming/i;
    if (keyOrField === 'thinkingEnabled') return /思考链|思维链|thinkingEnabled|thinking/i;
    if (keyOrField === 'promptCache') return /提示缓存|prompt\s*cache|promptCache/i;
    return null;
  }

  function settingDirectiveIn(text) {
    return /(?:把|将|帮我|替我).{0,100}(?:改|设|调|开|关|增|减|切换|切到|切成|启用|停用|增加|减少)|^(?:打开|开启|关闭|关掉|启用|停用|设为|调到|调为|改成|减少|增加|切换|切到|切成|(?:please\s+)?(?:set|change|enable|disable|turn\s+(?:on|off))\b)/i.test(String(text || '').trim());
  }

  function clauseAtSettingIndex(q, index) {
    var start = 0;
    var end = q.length;
    var split = /[，,。；;！？?!\n]+|然后|并且|同时|并(?=把|将|帮我|替我|开启|关闭|启用|停用|设置|设|调|改|切换)|\band\b/gi;
    var separator;
    while ((separator = split.exec(q))) {
      if (separator.index < index) start = separator.index + separator[0].length;
      else { end = separator.index; break; }
    }
    return q.slice(start, end).trim();
  }

  function clausesForSetting(question, pattern, qualifier) {
    var q = String(question || '');
    var matcher = new RegExp(pattern.source, 'gi');
    var hit, clauses = [];
    while ((hit = matcher.exec(q))) {
      var clause = clauseAtSettingIndex(q, hit.index);
      if ((!qualifier || clause.toLowerCase().indexOf(String(qualifier).toLowerCase()) >= 0) && clauses.indexOf(clause) < 0) clauses.push(clause);
      if (!hit[0].length) matcher.lastIndex++;
    }
    return clauses;
  }

  function clauseForSetting(question, pattern, qualifier) {
    return clausesForSetting(question, pattern, qualifier)[0] || '';
  }

  function requestedValueForTarget(scope, keyOrField, clause, targetPattern) {
    if (scope === 'global' && keyOrField === 'appearance.theme') return requestedTheme(clause) || null;
    if (scope === 'global' && keyOrField === 'output.maxContinues' && /关闭|关掉|停用|停止自动续写/i.test(clause)) return 0;
    if (scope === 'global' && keyOrField === 'output.maxContinues') return requestedNumberValue(clause, targetPattern);
    if (scope === 'role' && keyOrField === 'temperature') return requestedNumberValue(clause, targetPattern);
    if (scope === 'role' && ROLE_SETTINGS[keyOrField] && ROLE_SETTINGS[keyOrField].type === 'boolean') return requestedBoolean(clause);
    return null;
  }

  function hasConsistentClauses(clauses, scope, keyOrField, pattern) {
    if (clauses.length < 2) return clauses.length === 1;
    var values = clauses.map(function (clause) { return requestedValueForTarget(scope, keyOrField, clause, pattern); });
    return values.every(function (value) { return value !== null; }) && values.every(function (value) { return value === values[0]; });
  }

  function explicitSettingTargets(question, aliases) {
    var targets = [];
    var q = String(question || '');
    Object.keys(GLOBAL_SETTINGS).forEach(function (key) {
      var pattern = settingPattern('global', key);
      var clauses = pattern ? clausesForSetting(q, pattern).filter(settingDirectiveIn) : [];
      if (clauses.length && hasConsistentClauses(clauses, 'global', key, pattern)) {
        targets.push({ signature: 'global:' + key, scope: 'global', key: key, pattern: pattern });
      }
    });
    Object.keys(aliases || {}).forEach(function (roleRef) {
      var role = aliases[roleRef];
      if (!role || !role.label || q.toLowerCase().indexOf(String(role.label).toLowerCase()) < 0) return;
      var duplicateLabels = Object.keys(aliases).some(function (otherRef) {
        return otherRef !== roleRef && aliases[otherRef] &&
          String(aliases[otherRef].label || '').toLowerCase() === String(role.label).toLowerCase();
      });
      var shadowedByLongerLabel = Object.keys(aliases).some(function (otherRef) {
        var other = aliases[otherRef];
        var otherLabel = String(other && other.label || '').toLowerCase();
        var thisLabel = String(role.label).toLowerCase();
        return otherRef !== roleRef && otherLabel.length > thisLabel.length &&
          otherLabel.indexOf(thisLabel) >= 0 && q.toLowerCase().indexOf(otherLabel) >= 0;
      });
      if (duplicateLabels || shadowedByLongerLabel) return;
      Object.keys(ROLE_SETTINGS).forEach(function (field) {
        var pattern = settingPattern('role', field);
        var clauses = pattern ? clausesForSetting(q, pattern, role.label).filter(settingDirectiveIn) : [];
        if (clauses.length && hasConsistentClauses(clauses, 'role', field, pattern)) {
          targets.push({ signature: 'role:' + role.id + ':' + field, scope: 'role', field: field, roleRef: roleRef, roleId: role.id, roleLabel: role.label, pattern: pattern });
        }
      });
    });
    return targets.filter(function (target, index, all) {
      return all.findIndex(function (candidate) { return candidate.signature === target.signature; }) === index;
    });
  }

  function actionSignature(action, aliases) {
    if (!action || typeof action !== 'object') return '';
    if (action.type === 'set_global' && own(GLOBAL_SETTINGS, String(action.key || ''))) return 'global:' + action.key;
    if (action.type === 'set_role' && aliases && aliases[String(action.roleRef || '')] && own(ROLE_SETTINGS, String(action.field || ''))) {
      return 'role:' + aliases[String(action.roleRef)].id + ':' + action.field;
    }
    return '';
  }

  function requestedNumberValue(clause, targetPattern) {
    var assigned = /(?:设(?:置)?(?:为|成|到)|调(?:到|为|成)|改(?:为|成|到)|切换到|切换为|变为|变成|到|为|to|=)\s*(-?\d+(?:\.\d+)?)/ig;
    var match, last = null;
    while ((match = assigned.exec(clause))) last = match[1];
    if (last != null) return Number(last);
    var target = targetPattern.exec(clause);
    if (!target) return null;
    var tail = clause.slice(target.index + target[0].length);
    var values = tail.match(/-?\d+(?:\.\d+)?/g) || [];
    return values.length === 1 ? Number(values[0]) : null;
  }

  function requestedNumber(clause, value, targetPattern) {
    return typeof value === 'number' && Number.isFinite(value) && requestedNumberValue(clause, targetPattern) === value;
  }

  function requestedTheme(clause) {
    var assignment = /(?:设(?:置)?(?:为|成|到)|调(?:到|为|成)|改(?:为|成|到)|切换到|切换为|变为|变成|到|为|to|as)\s*(internal|infernal|light|dark|明亮|暗色|深色|浅色)/ig;
    var match, last = null;
    while ((match = assignment.exec(clause))) last = match[1];
    if (last) {
      try { return normalizeTheme(last); } catch (_) { return ''; }
    }
    var dark = /infernal|dark|暗色|深色|调暗|变暗/i.test(clause);
    var light = /internal|light|明亮|浅色|调亮|变亮/i.test(clause);
    return dark === light ? '' : (dark ? 'infernal' : 'internal');
  }

  function requestedBoolean(clause) {
    var matches = [];
    var pattern = /开启|打开|启用|设为开|改成开|关闭|关掉|停用|禁用|设为关|改成关|\bon\b|\boff\b|\btrue\b|\bfalse\b/ig;
    var match;
    while ((match = pattern.exec(clause))) {
      var token = match[0].toLowerCase();
      matches.push(/关闭|关掉|停用|禁用|设为关|改成关|\boff\b|\bfalse\b/i.test(token) ? false : true);
    }
    if (!matches.length) return null;
    if (matches.some(function (value) { return value !== matches[0]; })) return null;
    return matches[0];
  }

  function actionMatchesExplicitRequest(action, question, aliases, requestedTargets) {
    var signature = actionSignature(action, aliases);
    var target = (requestedTargets || []).filter(function (item) { return item.signature === signature; })[0];
    if (!target) return false;
    var clause = clauseForSetting(question, target.pattern, target.roleLabel);
    if (!clause || !settingDirectiveIn(clause)) return false;
    if (action.type === 'set_global' && action.key === 'appearance.theme') {
      var value;
      try { value = normalizeTheme(action.value); } catch (_) { return false; }
      return requestedTheme(clause) === value;
    }
    if (action.type === 'set_global' && action.key === 'output.maxContinues') {
      if (action.value === 0 && /关闭|关掉|停用|停止自动续写/i.test(clause)) return true;
      return requestedNumber(clause, action.value, target.pattern);
    }
    if (action.type === 'set_role' && action.field === 'temperature') {
      return requestedNumber(clause, action.value, target.pattern);
    }
    if (action.type === 'set_role' && ROLE_SETTINGS[action.field] && ROLE_SETTINGS[action.field].type === 'boolean') {
      return typeof action.value === 'boolean' && requestedBoolean(clause) === action.value;
    }
    return false;
  }

  function isClarificationReply(reply) {
    return /[?？]|请(?:问|确认)|具体(?:数值|值|设哪项)|要(?:调|设|改)到多少|你想(?:调|设|改)到多少|哪个角色|哪位角色|哪一项设置/i.test(String(reply || ''));
  }

  function requestedPageId(question) {
    var q = String(question || '').trim();
    if (!/^(?:请|请你|帮我)?\s*(?:打开|去|进入|跳转到|带我去|open|go to)\s*/i.test(q)) return '';
    return pageIdInText(q);
  }

  function pageIdInText(question) {
    var q = String(question || '');
    if (/诊断|diagnostic/i.test(q)) return 'diagnostics';
    if (/指南|说明书|\bguide\b/i.test(q)) return 'guide';
    if (/工作模式|work\s*mode/i.test(q)) return 'work-mode';
    if (/记忆|\bmemory\b/i.test(q)) return 'memory';
    if (/home\s*node|runner/i.test(q)) return 'diagnostics';
    if (/角色与\s*API|characters\s*(?:&|and)\s*api|\bapi\b/i.test(q)) return 'api';
    if (/设置|\bsettings\b/i.test(q)) return 'settings';
    if (/聊天|\bchat\b/i.test(q)) return 'chat';
    return '';
  }

  function pageSuggestionForQuestion(question) {
    if (!/(?:在哪|哪里|哪个页面|页面入口|怎么打开|如何打开|去哪里|where|how\s+to\s+open)/i.test(String(question || ''))) return null;
    var page = pageIdInText(question);
    return page ? createOpenAction(page, '打开 ' + PAGE_LABELS[page]) : null;
  }

  async function hasXinModelSource() {
    if (state.modelMode === 'independent') return !!(await loadIndependentConfig());
    var entries = await apiConfigsLive();
    return state.selectedApiId
      ? entries.some(function (entry) { return entry.id === state.selectedApiId; })
      : entries.length > 0;
  }

  function displayAction(action) {
    var label = action.label;
    if (action.kind === 'open') return { kind: 'open', ok: true, label: label, page: action.page };
    return action;
  }

  function noAction(message) { return { kind: 'notice', ok: false, label: '未执行', error: text(message, 200) }; }

  async function applyModelAction(action, aliases, canMutate) {
    if (!action || typeof action !== 'object') return noAction('动作格式无效。');
    if (action.type === 'open') {
      var page = String(action.page || '');
      if (!own(PAGE_LABELS, page) || !document.getElementById('page-' + page)) return noAction('这个页面在当前版本不存在。');
      return { kind: 'open', ok: true, label: '查看 ' + PAGE_LABELS[page], page: page };
    }
    if (action.type === 'set_global') {
      if (!canMutate) return noAction('请明确说出要改哪项设置后，我再执行。');
      var key = String(action.key || '');
      var spec = GLOBAL_SETTINGS[key];
      if (!spec) return noAction('这项全局设置不在允许列表。');
      var oldValue = await readGlobalValue(key);
      var nextValue = spec.type === 'theme' ? normalizeTheme(action.value) : Number(action.value);
      if (spec.type === 'select' && (!Number.isInteger(nextValue) || outputOptions().indexOf(nextValue) < 0)) return noAction('续写轮数只能选择：' + outputOptions().join('、') + '。');
      if (sameValue(oldValue, nextValue)) return { kind: 'setting', ok: true, label: spec.label, from: formatGlobalValue(key, oldValue), to: formatGlobalValue(key, nextValue), undoData: null };
      await writeGlobalValue(key, nextValue);
      if (!sameValue(await readGlobalValue(key), nextValue)) throw new Error('现有设置接口没有确认新值');
      return { kind: 'setting', ok: true, label: spec.label, from: formatGlobalValue(key, oldValue),
        to: formatGlobalValue(key, nextValue), undoData: { target: 'global', key: key, oldValue: oldValue, appliedValue: nextValue } };
    }
    if (action.type === 'set_role') {
      if (!canMutate) return noAction('请明确说出要改哪项角色设置后，我再执行。');
      var alias = String(action.roleRef || '');
      var role = aliases && aliases[alias];
      var field = String(action.field || '');
      if (!role || !own(ROLE_SETTINGS, field)) return noAction('角色或设置字段不在允许列表。');
      var roleEntry = await getRole(role.id);
      if (!roleEntry) return noAction('找不到这位角色的 API 配置。');
      var old = readRoleValue(roleEntry.config, field);
      var value = validateRoleValue(field, action.value);
      var specRole = ROLE_SETTINGS[field];
      var label = 'API「' + apiLabel(roleEntry) + '」· ' + specRole.label;
      var oldDisplay = old.exists ? (typeof old.value === 'boolean' ? (old.value ? '开启' : '关闭') : String(old.value)) : '默认';
      var newDisplay = typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value);
      if (old.exists && sameValue(old.value, value)) return { kind: 'setting', ok: true, label: label, from: oldDisplay, to: newDisplay, undoData: null };
      await writeRoleValue(role.id, field, value, null);
      var savedRole = await getRole(role.id);
      var savedValue = savedRole && readRoleValue(savedRole.config, field);
      if (!savedValue || !savedValue.exists || !sameValue(savedValue.value, value)) throw new Error('role-setting-save-not-confirmed');
      return { kind: 'setting', ok: true, label: label, from: oldDisplay, to: newDisplay,
        undoData: { target: 'role', roleId: role.id, field: field, oldExists: old.exists, oldValue: old.value, appliedValue: value } };
    }
    return noAction('动作类型不在允许范围。');
  }

  function tokenizeChinese(value) {
    var s = String(value || '').toLowerCase();
    var words = s.match(/[a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) || [];
    var terms = [];
    words.forEach(function (word) {
      if (/^[\u3400-\u9fff]+$/.test(word)) {
        for (var i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2));
        if (word.length <= 4) terms.push(word);
      } else terms.push(word);
    });
    return terms.filter(function (term) { return term.length > 1 && !/^(怎么|如何|哪些|这个|那个|可以|现在|一下)$/.test(term); });
  }

  function guideItems() {
    var host = document.getElementById('page-guide');
    if (!host) return [];
    return Array.prototype.slice.call(host.querySelectorAll('h1,h2,h3,h4,h5,p,li,summary'))
      .map(function (node) {
        var value = text(node.textContent.replace(/\s+/g, ' ').trim(), 900);
        if (value.length < 12) return null;
        var heading = node.closest('section,article,.guide-section') && node.closest('section,article,.guide-section').querySelector('h1,h2,h3,h4');
        return { title: heading ? text(heading.textContent.trim(), 100) : 'GUIDE', text: value };
      }).filter(Boolean);
  }

  function guideSnippets(question) {
    var terms = tokenizeChinese(question);
    if (!terms.length) return [];
    var unique = [];
    var ranked = guideItems().map(function (item, index) {
      var hay = (item.title + ' ' + item.text).toLowerCase();
      var score = terms.reduce(function (sum, term) { return sum + (hay.indexOf(term) >= 0 ? (term.length > 2 ? 3 : 1) : 0); }, 0);
      return { item: item, index: index, score: score };
    }).filter(function (entry) { return entry.score > 0; })
      .sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    ranked.forEach(function (entry) {
      var key = entry.item.title + '|' + entry.item.text;
      if (unique.length < 5 && unique.indexOf(key) < 0) unique.push(key);
    });
    return ranked.filter(function (entry) { return unique.indexOf(entry.item.title + '|' + entry.item.text) >= 0; })
      .slice(0, 5).map(function (entry) { return { title: entry.item.title, text: entry.item.text.slice(0, 700) }; });
  }

  async function currentMaxContinues() {
    try { return await readGlobalValue('output.maxContinues'); } catch (_) { return 3; }
  }

  async function makeSettingsList() {
    var lines = ['现在能直接改的设置：', '全局',
      '· 显示主题：' + formatGlobalValue('appearance.theme', await readGlobalValue('appearance.theme')),
      '· 自动续写轮数：' + formatGlobalValue('output.maxContinues', await currentMaxContinues()),
      '角色 API（角色之间相互独立）'];
    var list = await apiConfigsLive();
    if (!list.length) lines.push('· 还没有可列出的角色 API。');
    list.forEach(function (entry) {
      lines.push('· API「' + apiLabel(entry) + '」');
      Object.keys(ROLE_SETTINGS).forEach(function (field) {
        lines.push('  · ' + ROLE_SETTINGS[field].label + '：' + displayRoleValue(entry.config, field));
      });
    });
    lines.push('', '这些修改都能逐项撤销。密钥、联网搜索、Memory、备份和不可逆操作不在允许列表。');
    return lines.join('\n');
  }

  function createOpenAction(page, label) {
    if (!own(PAGE_LABELS, page) || !document.getElementById('page-' + page)) return null;
    return { kind: 'open', ok: true, label: label || ('查看 ' + PAGE_LABELS[page]), page: page };
  }

  async function openApiGuide() {
    var action = createOpenAction('api', '打开角色与 API 配置');
    addMessage('assistant', 'Xin 可以复用现有角色 API，也可以单独设置模型；独立模式不需要先创建角色。角色 API 在 Characters & API 页，Xin 自己的模型从抽屉顶部的「Xin 模型」进入。', action ? [action] : []);
  }

  function localHomeNodeReply() {
    var diagnostics = root.IBDiagnostics || (root.IB && root.IB.diagnostics);
    var status = null;
    try { status = diagnostics && typeof diagnostics.status === 'function' ? diagnostics.status() : null; } catch (_) { }
    var services = status && Array.isArray(status.services) ? status.services : [];
    var home = services.filter(function (row) { return row && row.id === 'homeNode'; })[0];
    var runner = services.filter(function (row) { return row && row.id === 'runner'; })[0];
    var stale = status && status.lastCheckAt && (Date.now() - Number(status.lastCheckAt) > 10 * 60 * 1000);
    var answer;
    if (!home) answer = '当前没有可读取的 Home Node 诊断结果。可以先打开 Diagnostics 查看服务详情；我没有触发探测，也不会自动重启服务。';
    else if (home.status !== 'ok' && runner && runner.status === 'ok') {
      answer = 'Home Node 没有进入 Ready 状态，但 Runner 仍在运行。你可以先查看服务详情；我不会自动重启它。';
      if (home.detail) answer += '\n诊断说明：' + text(home.detail, 220);
    } else if (home.status === 'ok') {
      answer = '现有诊断显示 Home Node 已就绪。若问题仍在，先查看最近一次服务详情和检查时间；我没有重新探测或更改服务。';
    } else {
      answer = '现有诊断显示 Home Node 状态为「' + text(home.status || '未知', 40) + '」。先打开 Diagnostics 查看服务详情；我不会自动重启它。';
      if (home.detail) answer += '\n诊断说明：' + text(home.detail, 220);
    }
    if (stale) answer += '\n这份诊断结果较旧，页面会显示检查时间。';
    var action = createOpenAction('diagnostics', '查看服务详情');
    addMessage('assistant', answer, action ? [action] : []);
  }

  function safeTimestamp(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? new Date(number).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '时间未知';
  }

  function cacheProbeReply() {
    var log = Array.isArray(root._ibCacheDiagLog) ? root._ibCacheDiagLog.slice(-6) : [];
    if (!log.length) {
      addMessage('assistant', '还没有脱敏的提示缓存比对记录。等现有 API 请求产生缓存审计后，我会只显示前缀是否稳定和变化类别，不读取聊天正文。');
      return;
    }
    var lines = ['最近 ' + log.length + ' 次提示缓存前缀审计：'];
    log.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var stateLabel = item.state === 'baseline' ? '已建立基线；下一次才能比较' : (item.ok ? '前缀稳定' : '前缀变化');
      var parts = [];
      if (item.systemChanged) parts.push('system');
      if (item.historyChanged) parts.push('history');
      if (item.toolsChanged) parts.push('tools');
      if (item.structureChanged) parts.push('request structure');
      lines.push('· ' + safeTimestamp(item.at) + ' · ' + stateLabel +
        (Number(item.stablePrefixChars) ? ' · 稳定前缀 ' + Number(item.stablePrefixChars) + ' 字符' : '') +
        (parts.length ? ' · 变化类别：' + parts.join('、') : ''));
    });
    lines.push('', '这只说明请求前缀是否延续；Provider 是否计入缓存，以它返回的 usage 为准。没有读取提示词内容。');
    addMessage('assistant', lines.join('\n'));
  }

  function imageProbeReply() {
    var log = Array.isArray(root._ibImgDiagLog) ? root._ibImgDiagLog.slice(-6) : [];
    if (!log.length) {
      addMessage('assistant', '最近没有可读取的带图模型请求记录。之后我只会记录时间、图片张数和请求是否成功，不保存图片、消息内容或密钥。');
      return;
    }
    var lines = ['最近 ' + log.length + ' 次带图模型请求：'];
    log.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var count = Math.max(0, Math.min(16, Number(item.n) || 0));
      var status = Number(item.status) || 0;
      lines.push('· ' + (item.ok ? '✓ 请求成功' : '✗ 请求失败') + ' · ' + safeTimestamp(item.at) +
        ' · ' + count + ' 张图' + (status ? ' · HTTP ' + status : ' · 未取得 HTTP 状态'));
    });
    lines.push('', '请求成功只表示服务端接受了这次请求，不保证模型确实理解图片。记录不含图片或聊天内容。');
    addMessage('assistant', lines.join('\n'));
  }

  function looksLikeIdentityQuestion(question) {
    return /^(你是谁|你是什么|你叫什么|你的名字|who are you)[\s？?！!。.]*$/i.test(String(question || '').trim());
  }

  function looksLikeGreeting(question) {
    return /^(你好|你好呀|嗨|哈喽|嘿|早上好|上午好|下午好|晚上好|在吗|hi|hello|hey)[\s，,。.!！?？~～]*$/i.test(String(question || '').trim());
  }

  function looksLikeHomeNodeDiagnosticQuestion(question) {
    var q = String(question || '').trim();
    if (!/(?:home\s*node|runner|节点)/i.test(q)) return false;
    if (/(?:在哪里|在哪|哪个页面|页面入口|怎么用|如何配置|怎么配置|是什么|有什么用|指南|guide)/i.test(q)) return false;
    return /(?:诊断|状态|ready|运行|挂|故障|异常|掉线|不可用|连不上|启动失败|为什么.*(?:节点|runner|home)|服务状态)/i.test(q);
  }

  async function runLocalQuestion(question) {
    var q = String(question || '').trim();
    if (/^设置(清单|列表|表)[？?。！!]*$/.test(q)) {
      try { addMessage('assistant', await makeSettingsList()); }
      catch (_) { addMessage('assistant', '当前设置清单暂时不可用。你可以打开 Settings 或 Characters & API 页面查看。'); }
      return true;
    }
    if (/^(缓存(探针|诊断|命中)?|缓存探针)[？?。！!]*$/.test(q)) { cacheProbeReply(); return true; }
    if (/^(图片(探针|诊断)?|图片探针)[？?。！!]*$/.test(q)) { imageProbeReply(); return true; }
    if (/^(接入 API|接 API|接中转站|配置 API)[？?。！!]*$/.test(q) && !(await hasXinModelSource())) {
      await openApiGuide();
      return true;
    }
    var directPage = requestedPageId(q);
    if (directPage) {
      var directAction = createOpenAction(directPage, '打开 ' + PAGE_LABELS[directPage]);
      if (directAction) { addMessage('assistant', '好，入口在下面。', [directAction]); return true; }
    }
    if (looksLikeHomeNodeDiagnosticQuestion(q)) { localHomeNodeReply(); return true; }
    if (looksLikeGreeting(q)) {
      if (!(await hasXinModelSource())) {
        addMessage('assistant', '你好，我在。当前还没有配置 Xin 模型；配置后就能继续聊。');
        return true;
      }
    }
    if (looksLikeIdentityQuestion(q) && !(await hasXinModelSource())) {
      addMessage('assistant', '我是 Xin，负责帮你使用 IB、查看设置和现有诊断。');
      return true;
    }
    return false;
  }

  function pagePromptList() {
    return Object.keys(PAGE_LABELS).filter(function (page) { return !!document.getElementById('page-' + page); })
      .map(function (page) { return page + ' = ' + PAGE_LABELS[page]; }).join('\n');
  }

  function settingPromptList(question, roleEntries) {
    var out = [
      '允许的全局设置：appearance.theme (internal 或 infernal)；output.maxContinues（只能选择：' + outputOptions().join('、') + '）。',
      '允许的角色 API 独立设置：temperature (0 到 2)、streaming (布尔)、thinkingEnabled (布尔)、promptCache (布尔)。',
      '不要建议或请求改密钥、endpoint、联网搜索、Memory、工具权限、备份、数据删除或任意代码。'
    ];
    var needRoles = /温度|temperature|流式|streaming|思考链|思维链|thinkingEnabled|提示缓存|prompt\s*cache|角色设置|好友设置/i.test(question);
    if (needRoles) {
      var aliases = Object.create(null);
      var lines = [];
      roleEntries.forEach(function (entry, index) {
        var ref = 'r' + (index + 1);
        aliases[ref] = { id: entry.id, label: apiLabel(entry) };
        lines.push(ref + ' = ' + apiLabel(entry) + ' · ' + Object.keys(ROLE_SETTINGS).map(function (field) {
          return ROLE_SETTINGS[field].label + ' ' + displayRoleValue(entry.config, field);
        }).join(' / '));
      });
      out.push('角色目录（使用临时别名 roleRef，不要输出真实 id）：\n' + (lines.join('\n') || '当前没有角色 API。'));
      return { text: out.join('\n'), aliases: aliases };
    }
    return { text: out.join('\n'), aliases: Object.create(null) };
  }

  function buildSystemPrompt(question, snippets, settingContext, actionMode) {
    var excerpts = snippets.length ? snippets.map(function (item, index) {
      return '[' + (index + 1) + '] GUIDE / ' + item.title + '\n' + item.text;
    }).join('\n\n') : '没有找到与当前问题直接匹配的 GUIDE 段落。请明确说 GUIDE 暂时没有给出依据；如果只按现有 IB 结构推断，标记「这是推断」。';
    var prompt = [
      '你是 Xin（心），Internal Beyond 内置的系统功能助手。你帮助用户理解 IB、定位功能、说明设置和查看只读诊断。Work Mode 承接复杂任务；不要建立第二套 Agent Runtime。',
      '像熟悉 IB 的同事一样自然回答：短句、直接、有一点温度；不要每轮自我介绍、重复寒暄或堆免责声明。普通问题先用一到三句回答，再给最相关的下一步。优先依据给出的 GUIDE 原文和实际页面；没有证据时明确说不确定，推断要标明「这是推断」。',
      '不要要求或输出 API Key、聊天记录、角色记忆或备份内容。不要声称已探测、重启或修复服务。不要执行代码、原生工具、网络搜索、删除、导出、凭据或其他未列入白名单的操作。',
      '相关 GUIDE 摘录：\n' + excerpts
    ];
    if (actionMode) {
      prompt.push(
        '这条用户消息明确要求修改设置。只有在目标和值都能从原话中核对时才返回动作；值不明确就只问一个简短问题。不要推断未说出的设置项或值。',
        '返回一个 JSON 对象：{"reply":"自然的简短答复","actions":[...]}。动作只能是：{"type":"set_global","key":"appearance.theme|output.maxContinues","value":"..."}；{"type":"set_role","roleRef":"r1","field":"temperature|streaming|thinkingEnabled|promptCache","value":...}。每个动作必须直接对应用户原话中的设置目标和值。布尔值必须是 JSON true/false，数值必须是 JSON 数字；不要返回 open、tool_call、function_call 或其他类型。没有可核对的修改时 actions 为空数组。',
        '设置白名单与角色目录：\n' + (settingContext && settingContext.text || '')
      );
    } else {
      prompt.push('这是普通对话，请直接用自然文本回答，不要输出 JSON、动作字段或工具协议。不得声称已经修改设置；如果用户表达得像是在询问、否定或试探修改，先解释或询问，不执行任何动作。');
      if (settingContext && settingContext.text) prompt.push('与问题相关的设置说明（仅用于解释，不允许产生修改）：\n' + settingContext.text);
      if (/(?:在哪|哪里|哪个页面|页面|入口|怎么打开|如何打开|打开|跳转|where|how to open)/i.test(question)) {
        prompt.push('当前页面目录：\n' + pagePromptList());
      }
    }
    return prompt.join('\n\n');
  }

  function modelResponseText(response) {
    if (typeof response === 'string') return { text: response, toolProtocol: false };
    if (!response || typeof response !== 'object') return { text: '', toolProtocol: false };
    var toolProtocol = Array.isArray(response.tool_calls) && response.tool_calls.length > 0 ||
      !!response.function_call || !!response.tool_call;
    if (typeof response.text === 'string') return { text: response.text, toolProtocol: toolProtocol };
    if (typeof response.t === 'string') return { text: response.t, toolProtocol: toolProtocol };
    if (typeof response.reply === 'string') return { text: response.reply, toolProtocol: toolProtocol };
    if (typeof response.content === 'string') return { text: response.content, toolProtocol: toolProtocol };
    if (Array.isArray(response.content)) {
      var parts = [];
      response.content.forEach(function (part) {
        if (!part || typeof part !== 'object') return;
        if (/tool|function_call/i.test(String(part.type || ''))) toolProtocol = true;
        if (typeof part.text === 'string' && !/tool|function_call/i.test(String(part.type || ''))) parts.push(part.text);
      });
      return { text: parts.join('\n'), toolProtocol: toolProtocol };
    }
    return { text: '', toolProtocol: toolProtocol };
  }

  function containsToolProtocol(raw, response, parsed) {
    if (/<\s*\/?\s*(?:tool_call|function_call|tool_result|function_result)\b|<\|(?:tool_call|function_call|python_tag)\|/i.test(String(raw || ''))) return true;
    if (response && typeof response === 'object' &&
        (response.function_call || response.tool_call || (Array.isArray(response.tool_calls) && response.tool_calls.length))) return true;
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.function_call || parsed.tool_call || (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length)) return true;
    return Array.isArray(parsed.actions) && parsed.actions.some(function (action) {
      if (!action || typeof action !== 'object') return false;
      return /^(tool_call|function_call|tool_use)$/i.test(String(action.type || action.kind || '')) ||
        !!action.tool_calls || !!action.function_call;
    });
  }

  function invalidModelReply() {
    return { reply: '刚才的回复格式异常，我没有执行任何操作。你可以再试一次。', actions: [], blocked: true };
  }

  function normalizeModelResponse(response, actionMode) {
    var extracted = modelResponseText(response);
    var raw = text(extracted.text, 12000);
    var candidate = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var parsed = safeJson(candidate);
    if (extracted.toolProtocol || containsToolProtocol(candidate, response, parsed)) return invalidModelReply();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.reply !== 'string') return invalidModelReply();
      var returnedActions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 6) : [];
      return { reply: text(parsed.reply, MAX_TEXT), actions: actionMode ? returnedActions : [], ignoredActions: !actionMode && returnedActions.length > 0 };
    }
    if (/^[\[{]/.test(candidate)) return invalidModelReply();
    return { reply: text(candidate, MAX_TEXT), actions: [] };
  }

  function providerConfig(entry) {
    var source = entry.config || entry || {};
    return {
      id: entry.id || source.id,
      provider: text(source.provider || entry.provider || 'openai', 50),
      model: text(source.model || entry.model, 100),
      endpoint: text(source.endpoint || entry.endpoint, 1000),
      credentialRef: text(source.credentialRef || entry.credentialRef || '', 180),
      temperature: 0.25,
      streaming: false,
      thinkingEnabled: false,
      promptCache: false,
      cacheTtl1h: false,
      webSearch: false,
      vision: false,
      memWrite: false,
      imageGen: false,
      systemPrompt: ''
    };
  }

  function buildConversation(systemPrompt) {
    var messages = state.messages.slice(-12).map(function (message) {
      return { role: message.role, content: message.text };
    });
    while (messages.length && messages[0].role !== 'user') messages.shift();
    var compact = [];
    messages.forEach(function (message) {
      if (compact.length && compact[compact.length - 1].role === message.role) compact[compact.length - 1].content += '\n' + message.content;
      else compact.push({ role: message.role, content: message.content });
    });
    return [{ role: 'system', content: systemPrompt }].concat(compact);
  }

  function providerErrorText(error) {
    var code = String(error && (error.code || error.ibCat) || '');
    var status = 0;
    try { status = Number(root.IBERR && root.IBERR.statusOf ? root.IBERR.statusOf(error) : error && error.status) || 0; } catch (_) { }
    var place = state.modelMode === 'independent' ? 'Xin 模型设置面板' : '角色与 API 配置页';
    if (/CREDENTIAL_UNAVAILABLE|credential/i.test(code)) return '这个模型还没有可用的 Vault 凭据。到' + place + '重新绑定后再试；我没有读取密钥。';
    if (status === 401 || status === 403) return '服务没有接受当前凭据（HTTP ' + status + '）。请检查' + place + '里的凭据绑定和服务权限。';
    if (/abort|timeout/i.test(code)) return '服务暂时没有响应，我没有改动设置。可以稍后再试。';
    if (status) return '服务返回 HTTP ' + status + '，这次没有完成，也没有改动设置。可检查模型配置或打开 Diagnostics。';
    return '我没能连上这个模型，设置没有改动。先检查模型地址、Vault 绑定和服务状态。';
  }

  function claimsSettingsChanged(reply) {
    return /(?:已|已经|成功地?)(?:把|将|修改|更改|设置|调整|切换|更新|开启|关闭|启用|停用)|(?:把|将).{0,30}(?:改成|设为|调到|切换到).{0,20}(?:了|成功)|(?:主题|设置|续写|温度|流式|theme|settings?|temperature|streaming).{0,35}(?:已|已经|成功|完成)|设置(?:已|已经)?(?:成功|完成)|修改(?:已|已经)?(?:成功|完成)|(?:settings?|theme|temperature|streaming).{0,40}\b(?:updated|changed|enabled|disabled|set)\b/i.test(String(reply || ''));
  }

  async function askProvider(question) {
    var entries = [];
    var entry = null;
    if (state.modelMode === 'independent') {
      entry = await loadIndependentConfig();
      if (!entry) {
        addMessage('assistant', 'Xin 独立模型尚未配置。设置 Xin 自己的 Provider、Endpoint 和模型即可，不需要创建角色 API。');
        openIndependentEditor(defaultIndependentConfig(), '先配置 Xin 自己的模型；Key 只写入 Credential Vault。');
        return;
      }
    } else {
      entries = await apiConfigsLive();
      entry = state.selectedApiId
        ? (entries.filter(function (item) { return item.id === state.selectedApiId; })[0] || null)
        : (entries[0] || null);
      if (entry && !state.selectedApiId) { state.selectedApiId = entry.id; persistPrefs(); }
    }
    if (!entry) {
      addMessage('assistant', state.modelMode === 'reuse' && state.selectedApiId
        ? '之前选择的角色 API 当前不可用；我保留了这个选择。请在「Xin 模型」里重新选择，或切换到独立配置。'
        : '还没有可用的模型来源。你可以设置 Xin 的独立模型，也可以复用现有角色 API。',
        [createOpenAction('api', '查看现有角色 API')].filter(Boolean));
      return;
    }
    if (typeof root.callApiChat !== 'function') {
      addMessage('assistant', '当前版本的 API 调用链还没有就绪。可以先查看 GUIDE，或打开 Diagnostics。', [createOpenAction('diagnostics', '打开 Diagnostics')].filter(Boolean));
      return;
    }
    var actionMode = mutationRequested(question);
    var needsRoleRoster = /温度|temperature|流式|streaming|思考链|思维链|thinkingEnabled|提示缓存|prompt\s*cache|角色设置|好友设置/i.test(question);
    var needsSettingContext = actionMode || /设置|主题|续写|温度|temperature|流式|streaming|思考链|思维链|提示缓存|prompt\s*cache/i.test(question);
    if (state.modelMode === 'independent' && needsRoleRoster) entries = await apiConfigsLive();
    var roles = needsRoleRoster ? entries : [];
    var settingContext = needsSettingContext
      ? settingPromptList(question, roles)
      : { text: '', aliases: Object.create(null) };
    var snippets = guideSnippets(question);
    var systemPrompt = buildSystemPrompt(question, snippets, settingContext, actionMode);
    var messages = buildConversation(systemPrompt);
    var result;
    try {
      result = await root.callApiChat(providerConfig(entry), messages, {
        maxTokens: 1100,
        timeoutMs: 90000,
        autoContinue: false,
        disableTools: true,
        _noWebSearch: true,
        _ibConsumer: 'xin_assistant',
        wantMeta: false
      });
    } catch (error) {
      addMessage('assistant', providerErrorText(error));
      return;
    }
    var parsed = normalizeModelResponse(result, actionMode);
    var actions = [];
    var actionFailed = false;
    var successfulMutations = 0;
    if (actionMode) {
      var requested = explicitSettingTargets(question, settingContext.aliases);
      var authorized = Object.create(null);
      var accounted = Object.create(null);
      var seen = Object.create(null);
      for (var i = 0; i < parsed.actions.length && actions.length < MAX_ACTIONS; i++) {
        var candidate = parsed.actions[i];
        var signature = actionSignature(candidate, settingContext.aliases);
        if (!signature || seen[signature] || !actionMatchesExplicitRequest(candidate, question, settingContext.aliases, requested)) {
          actionFailed = true;
          if (signature) accounted[signature] = true;
          actions.push(noAction('这项动作与原话中的目标和值不一致，没有执行。'));
          continue;
        }
        seen[signature] = true;
        accounted[signature] = true;
        authorized[signature] = true;
        try {
          var applied = await applyModelAction(candidate, settingContext.aliases, true);
          if (!applied.ok) actionFailed = true;
          else if (applied.kind === 'setting') successfulMutations++;
          actions.push(displayAction(applied));
        } catch (_) {
          actionFailed = true;
          actions.push(noAction('保存没有完成；请在原设置页确认当前值。'));
        }
      }
      if (parsed.actions.length) {
        requested.forEach(function (target) {
          if (authorized[target.signature] || accounted[target.signature]) return;
          actionFailed = true;
          actions.push(noAction('原话中提到的「' + (target.scope === 'global' ? GLOBAL_SETTINGS[target.key].label : ROLE_SETTINGS[target.field].label) + '」没有收到可核对的动作，因此没有修改。'));
        });
      }
    }
    var reply = parsed.reply || (actions.length ? '处理结果在下面。' : '这次没有收到可显示的答复。');
    if (actionMode && actionFailed) {
      reply = successfulMutations
        ? '我只完成了下面标明成功的修改；其余动作没有执行。'
        : '我没有执行这次修改；原因在下面。请确认目标和值后再试。';
    } else if (actionMode && !parsed.actions.length && !isClarificationReply(reply)) {
      reply = '我没有收到与你原话一致的设置动作，所以没有修改任何内容。请再确认要改的项目和值。';
    } else if (!actionMode && claimsSettingsChanged(reply) && (parsed.ignoredActions || hasUncertainMutationIntent(question))) {
      reply = '我没有执行任何设置修改。要更改设置，请明确说出项目和值；我会先核对后再执行。';
    }
    var pageAction = actionMode ? null : pageSuggestionForQuestion(question);
    if (pageAction) actions.push(pageAction);
    addMessage('assistant', reply, actions);
  }

  function submit() {
    if (!els.input) return;
    var value = els.input.value.trim();
    if (!value || state.busy) return;
    els.input.value = '';
    resizeInput();
    sendText(value);
  }

  async function sendText(value) {
    var question = text(value, 2000).trim();
    if (!question || state.busy) return;
    addMessage('user', question);
    try { if (await runLocalQuestion(question)) return; }
    catch (_) { addMessage('assistant', '这项本地功能暂时不可用。可以打开 Diagnostics 查看当前状态。'); return; }
    state.busy = true;
    if (els.send) { els.send.disabled = true; els.send.textContent = '…'; }
    var pending = el('div', 'xin-message is-assistant xin-pending');
    pending.setAttribute('role', 'status');
    pending.appendChild(el('span', 'xin-pending-label', '我看一下'));
    var dots = el('span', 'xin-pending-dots');
    dots.setAttribute('aria-hidden', 'true');
    for (var dotIndex = 0; dotIndex < 3; dotIndex++) dots.appendChild(el('i', ''));
    pending.appendChild(dots);
    if (els.transcript) {
      els.transcript.setAttribute('aria-busy', 'true');
      els.transcript.appendChild(pending);
      scrollTranscript();
    }
    try {
      await askProvider(question);
      renderAll();
    } catch (_) {
      addMessage('assistant', '我没完成这次查询，也没有执行设置。你可以重试，或打开 Diagnostics 查看服务状态。');
    } finally {
      if (pending.parentNode) pending.parentNode.removeChild(pending);
      if (els.transcript) els.transcript.removeAttribute('aria-busy');
      state.busy = false;
      if (els.send) { els.send.disabled = false; els.send.textContent = '发送'; }
    }
  }

  function jumpTo(page) {
    if (!own(PAGE_LABELS, page) || !document.getElementById('page-' + page) || typeof root.navTo !== 'function') return;
    closeDrawer();
    root.navTo(page);
  }

  function clearSession() {
    if (!root.confirm('清空 Xin 的独立会话？此操作不能撤销。')) return;
    state.messages = [];
    safeStorageRemove(SESSION_KEY);
    renderAll();
  }

  function boot() {
    state.messages = loadHistory();
    loadPrefs();
    buildUi();
  }

  var api = Object.freeze({
    open: open,
    close: closeDrawer,
    send: sendText,
    refreshSource: refreshSourceLabel,
    version: 1
  });
  root.IBXin = api;
  root.IB = root.IB || {};
  root.IB.xin = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(window);
