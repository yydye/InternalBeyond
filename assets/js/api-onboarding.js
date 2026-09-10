/* Internal Beyond — P16 · 零门槛 API 获取向导（API Onboarding）
 *
 * 定位：给「第一次听说 API Key、也不知道接口地址是什么」的普通用户，
 * 把「我没有 API Key」→「选服务 → 打开官方平台 → 创建 Key → 回到 IB
 * 自动填好 → 只粘贴 Key → 测试连接」这条路走完。
 *
 * 铁律（与 P4 配置数据契约、P11-0 canonical provider 契约一致）：
 *   · 所有 provider 数据（名称 / 接口地址 / 格式 / 模型 / 能力）一律取
 *     assets/js/provider-directory.js（window.PROVIDERS_DIR），本文件**不**复制
 *     任何 endpoint / format / model / capabilities 字面量。
 *   · 官方平台入口、Key 获取地址、地区与充值提示、教程步骤，一律取目录里的
 *     onboarding metadata（onboardingEntry / officialList / thirdPartyList），
 *     本文件**不**维护第二份 URL 表。
 *   · 配置落地只有一条链：复用既有 addNewApi() / onProviderChange() / API 编辑器，
 *     本文件**不**写 apiConfigs、不调 _persistApiConfig、不新增保存逻辑。
 *   · 本文件**永不**读取、生成、保存、拼接用户的 API Key；Key 输入框只由用户自己填。
 *   · 外链一律走 linkEl()：https/http 白名单 + target=_blank + rel=noopener noreferrer，
 *     且 URL 里出现 api_key / token / key / secret / password 等参数名时直接拒绝渲染。
 */
(function () {
  'use strict';

  var NS = (window.IBOnboarding = window.IBOnboarding || {});

  var STYLE_ID = 'ib-onboarding-style';
  var STYLE_HREF = 'assets/css/api-onboarding.css';
  var HOST_ID = 'api-onboarding-entry';
  var OVERLAY_ID = 'ib-onboarding';

  /* 官方卡片的顺序 / 一句话说明一律取 provider-directory.js 的 presentation metadata
     （P17）：本文件**不**维护第二份 provider 顺序表或 hint 表。 */

  /* ── 数据源（唯一 canonical 目录；缺失时一律 graceful fallback） ── */
  function dir() {
    try { return window.PROVIDERS_DIR || null; } catch (e) { return null; }
  }
  function providers() {
    var d = dir();
    if (d && d.PROVIDERS) return d.PROVIDERS;
    try { return window.PROVIDERS || {}; } catch (e) { return {}; }
  }
  function providerMeta(p) {
    var all = providers();
    return (p && all && all[p]) || null;
  }
  function providerName(p) {
    var m = providerMeta(p);
    return (m && m.name) || p || 'AI 服务';
  }
  function onboardingEntry(id) {
    var d = dir();
    if (d && typeof d.onboardingEntry === 'function') {
      try { return d.onboardingEntry(id); } catch (e) { return null; }
    }
    return null;
  }
  /* 官方卡片 id 列表：**目录说了算**（showInOnboarding + presentation order；
     隐藏语义由目录实现）。只有目录没提供读取面时才退到 PROVIDERS 键序。 */
  function officialIds() {
    var d = dir(), out = null, i, keys;
    if (d && typeof d.onboardingProviderList === 'function') {
      try { out = d.onboardingProviderList() || []; } catch (e) { out = null; }
    }
    if (out === null && d && typeof d.officialList === 'function') {
      try { out = d.officialList() || []; } catch (e) { out = null; }
    }
    if (out === null) {
      out = [];
      keys = Object.keys(providers());
      for (i = 0; i < keys.length; i++) if (keys[i] !== 'custom') out.push(keys[i]);
    }
    return out;
  }

  /* 一句话人话说明（「这是谁家的服务」）：唯一来源 = 目录 presentation metadata。 */
  function providerHint(id) {
    var d = dir();
    if (d && typeof d.providerHint === 'function') {
      try { var h = d.providerHint(id); if (h) return h; } catch (e) { }
    }
    return '';
  }
  function thirdPartyIds() {
    var d = dir();
    if (d && typeof d.thirdPartyList === 'function') {
      try { return d.thirdPartyList() || []; } catch (e) { return []; }
    }
    return [];
  }
  function riskLines() {
    var d = dir();
    if (d && Array.isArray(d.THIRD_PARTY_RISK) && d.THIRD_PARTY_RISK.length) return d.THIRD_PARTY_RISK;
    return ['模型、价格和可用性由第三方决定，IB 不做保证。',
      'API Key 和请求内容可能会经过第三方服务器。',
      'IB 仅提供兼容接入，不为第三方余额、服务稳定性、安全性或数据处理方式背书。'];
  }
  function tagLabel(tag) {
    var d = dir();
    if (d && d.TAG_LABELS && d.TAG_LABELS[tag]) return d.TAG_LABELS[tag];
    return String(tag || '');
  }

  /* ══ 安全外链 ══════════════════════════════════════════════
     只有 https / http 能渲染；URL 里一旦出现疑似凭据的参数名就直接拒绝。
     官方 / 第三方身份不靠域名判断，靠目录 metadata（kind 字段）。 */
  var SECRET_PARAM = /(?:^|[?&#])(?:api[-_]?key|apikey|key|token|access[-_]?token|secret|password|passwd|auth|authorization)=/i;

  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) return '';
    if (SECRET_PARAM.test(s)) return '';
    return s;
  }

  function linkEl(url, text, cls) {
    var href = safeUrl(url);
    if (!href) return null;
    var a = document.createElement('a');
    a.className = cls || 'ibo-link';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = String(text || href);
    return a;
  }

  /* ══ DOM 工具 ═════════════════════════════════════════════ */
  function byId(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function injectStyles() {
    if (byId(STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    (document.head || document.documentElement).appendChild(link);
  }

  /* ══ API 编辑器：预填 + 新手模式 ═════════════════════════════
     预填只走既有编辑器函数：addNewApi()（新建干净表单）→ api-provider.value
     → onProviderChange()（由它从 canonical 目录取 endpoint / model / 能力）。
     本文件不直接写 apiConfigs，也不触碰 api-key 输入框。 */

  function apiPageVisible() {
    var p = byId('page-api');
    try { return !!(p && p.classList && p.classList.contains('active')); } catch (e) { return false; }
  }
  function navTo(page) {
    try { if (typeof window.navTo === 'function') window.navTo(page); } catch (e) { }
  }
  /* 用户是否已经手工改过预填字段（是 → 绝不覆盖，只提示）。
     判定依据只有两条，不做任何启发式猜测：
       ① 字段值非空且不是我们自动填进去的（data-ib-auto-filled != '1'）；
       ② 从「我已经有 API Key / 手动填写」进来后又改过（编辑器上的 ibManualEdited 标记）。 */
  function fieldEdited(id) {
    var n = byId(id);
    if (!n) return false;
    try { return n.dataset && n.dataset.ibAutoFilled !== '1' && String(n.value || '').trim() !== ''; } catch (e) { return false; }
  }
  function prefillTargets() { return ['api-endpoint', 'api-model']; }
  function anyEdited() {
    var ids = prefillTargets(), i;
    for (i = 0; i < ids.length; i++) if (fieldEdited(ids[i])) return true;
    var ed = byId('api-editor');
    try { if (ed && ed.dataset && ed.dataset.ibManualEdited === '1') return true; } catch (e) { }
    return false;
  }
  function markManualEditor(on) {
    var ed = byId('api-editor');
    try { if (ed && ed.dataset) ed.dataset.ibManualEdited = on ? '1' : ''; } catch (e) { }
  }
  /* 首次设置向导可能压在上面（用户是在向导里点「还没有 Key？」进来的）：
     预填前把它收起，否则用户看不到已经填好的编辑器。
     只切换它自己的 is-open 类，不改向导状态、不触发任何保存逻辑。 */
  function closeSetupWizardIfOpen() {
    try {
      var w = byId('ib-setup');
      if (!w) return false;
      var open = true;
      try { open = w.classList.contains('is-open'); } catch (e) { open = true; }
      if (!open) return false;
      w.classList.remove('is-open');
      return true;
    } catch (e) { return false; }
  }
  /* 标记为「由我们自动填的」：之后可以安全重填；用户一动就摘掉标记。 */
  function bindAutoMark(id) {
    var n = byId(id);
    if (!n || n._ibAutoBound) return;
    n._ibAutoBound = true;
    n.addEventListener('input', function () {
      try { if (n.dataset) n.dataset.ibAutoFilled = ''; } catch (e) { }
    });
  }
  function markAuto(id, value) {
    var n = byId(id);
    if (!n) return;
    n.value = value == null ? '' : String(value);
    try { if (n.dataset) n.dataset.ibAutoFilled = '1'; } catch (e) { }
    bindAutoMark(id);
  }

  /* 应用预填。opts: { provider, endpoint, model, guided } */
  function applyPrefill(opts) {
    var o = opts || {};
    var pid = String(o.provider || '').trim();
    var applied = { provider: pid, endpoint: '', model: '', guided: !!o.guided };

    closeSetupWizardIfOpen();
    /* 1) 打开干净的编辑器（复用既有链路；无 addNewApi 时退回直接显示） */
    try {
      if (typeof window.addNewApi === 'function') window.addNewApi();
      else {
        var ed = byId('api-editor');
        if (ed) ed.style.display = 'block';
      }
    } catch (e) { }

    /* 2) provider 选中 → onProviderChange() 从 canonical 目录取 endpoint / model / 能力 */
    var sel = byId('api-provider');
    if (sel && pid) {
      var known = !!providers()[pid];
      if (known) {
        sel.value = pid;
        try { if (typeof window.onProviderChange === 'function') window.onProviderChange(); } catch (e) { }
        applied.endpoint = String((byId('api-endpoint') || {}).value || '');
        applied.model = String((byId('api-model') || {}).value || '');
        if (applied.endpoint) markAuto('api-endpoint', applied.endpoint);
        if (applied.model) markAuto('api-model', applied.model);
      }
    }
    /* 3) 显式传入的接口地址（第三方服务）优先于目录默认值 */
    var ep = String(o.endpoint || '').trim();
    if (ep) { markAuto('api-endpoint', ep); applied.endpoint = ep; }
    var md = String(o.model || '').trim();
    if (md) { markAuto('api-model', md); applied.model = md; }

    /* 4) 新手模式：收起协议术语（字段仍在 DOM 里，高级用户随时展开） */
    setGuided(!!o.guided);
    renderKeyHelp(pid);

    /* 5) 把编辑器带到用户眼前，光标落到 Key 输入框——用户只需要粘贴 */
    revealEditor();
    var key = byId('api-key');
    if (key) { try { key.focus(); } catch (e) { } }
    return applied;
  }

  /* 编辑器在 API 页下方，预填后把它滚入视野；不支持平滑滚动时静默降级。 */
  function revealEditor() {
    var ed = byId('api-editor');
    if (!ed || typeof ed.scrollIntoView !== 'function') return false;
    try { ed.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
    catch (e) { try { ed.scrollIntoView(true); return true; } catch (e2) { return false; } }
  }

  function setGuided(on) {
    var ed = byId('api-editor');
    if (!ed) return false;
    try {
      if (ed.classList) ed.classList.toggle('ibo-guided', !!on);
    } catch (e) { return false; }
    /* 提示位在 HTML 里（#ibo-guided-hint）：只在新手模式下写一句人话，其它情况留空 */
    var hint = byId('ibo-guided-hint');
    if (hint) {
      hint.innerHTML = '';
      if (on) hint.appendChild(el('span', null, '这个服务的接口地址已经帮你填好了，不用改。'));
    }
    return true;
  }

  /* 服务商说明位（P17）：只对「兼容 / 自定义」这类**不声明能力**的服务显示一句实话，
     依据是目录 metadata（providerKind / providerCapabilitiesKnown），不按名字猜。
     普通官方服务不显示（返回 false，保持原位为空）。 */
  function renderProviderNote(pid) {
    var host = byId('ibo-provider-note');
    if (!host) return false;
    host.innerHTML = '';
    var d = dir(), kind = '', known = true;
    if (d && typeof d.providerKind === 'function') { try { kind = d.providerKind(pid) || ''; } catch (e) { kind = ''; } }
    if (d && typeof d.providerCapabilitiesKnown === 'function') { try { known = d.providerCapabilitiesKnown(pid) !== false; } catch (e) { known = true; } }
    if (kind !== 'compatible' && known) return false;
    host.appendChild(el('span', null, providerName(pid) + '：IB 不声明这个服务的能力。图片识别、流式输出能不能用，取决于你填写的服务本身——填完点「测试连接」就知道。'));
    return true;
  }

  /* 「Key 在哪里获取？」——链接来自 onboarding metadata；没有就整行不渲染。 */
  function renderKeyHelp(pid) {
    var host = byId('ibo-key-help');
    if (!host) return false;
    host.innerHTML = '';
    var e = onboardingEntry(pid);
    var url = (e && (e.apiKeyUrl || e.signupUrl)) || '';
    var a = linkEl(url, 'Key 在哪里获取？');
    if (!a) return false;
    host.appendChild(a);
    return true;
  }

  /* ══ 入口分流（#page-api 顶部） ═════════════════════════════ */
  function entryCard(title, sub, label, onClick, primary) {
    var card = el('div', 'ibo-entry-card');
    card.appendChild(el('div', 'ibo-entry-title', title));
    card.appendChild(el('div', 'ibo-entry-sub', sub));
    card.appendChild(button('btn' + (primary ? ' btn-primary' : '') + ' ibo-entry-btn', label, onClick));
    return card;
  }

  function renderEntry() {
    var host = byId(HOST_ID);
    if (!host) return false;
    injectStyles();
    host.innerHTML = '';

    var box = el('div', 'ibo-entry');
    var head = el('div', 'ibo-entry-head');
    head.appendChild(el('h3', 'ibo-entry-h', '第一次配置 API？'));
    head.appendChild(el('p', 'ibo-entry-lead', '按顺序走一遍就行：先拿到 Key，再粘回来。全程不需要懂技术名词。'));
    box.appendChild(head);

    var grid = el('div', 'ibo-entry-grid');
    grid.appendChild(entryCard('我还没有 API Key', '带你从零拿到一把 Key：选服务、打开官方平台、创建、复制。', '带我获取', function () { openWizard(); }, true));
    grid.appendChild(entryCard('我已经有 API Key', '直接进配置页：服务选好、地址自动填好，你只要粘贴 Key。', '去粘贴', function () { openManualEditor(); }));
    grid.appendChild(entryCard('导入 OpenAI Compatible API', '中转服务或自建网关，地址和 Key 都由你自己填。', '手动填写', function () { openCompatibleImport(); }));
    box.appendChild(grid);

    var note = el('p', 'ibo-entry-note', '不确定该选哪个？点「带我获取」，里面每个服务都写清楚了适合谁。');
    box.appendChild(note);

    host.appendChild(box);
    return true;
  }

  /* 直接进 API 编辑器（已经拿到 Key 的用户） */
  function openManualEditor() {
    closeSetupWizardIfOpen();
    if (!apiPageVisible()) navTo('api');
    try { if (typeof window.addNewApi === 'function') window.addNewApi(); } catch (e) { }
    markManualEditor(true);
    setGuided(false);
    var sel = byId('api-provider');
    var pid = (sel && sel.value) || '';
    if (!pid || !providerMeta(pid)) { var first = officialIds()[0]; if (first) pid = first; }
    if (pid && providerMeta(pid)) {
      if (sel) sel.value = pid;
      try { if (typeof window.onProviderChange === 'function') window.onProviderChange(); } catch (e) { }
      var ep = String((byId('api-endpoint') || {}).value || '');
      var md = String((byId('api-model') || {}).value || '');
      if (ep) markAuto('api-endpoint', ep);
      if (md) markAuto('api-model', md);
    }
    renderKeyHelp(pid);
    revealEditor();
    var key = byId('api-key');
    if (key) { try { key.focus(); } catch (e) { } }
    return pid;
  }

  /* 导入 OpenAI Compatible API：走 custom provider（format 由目录决定为 openai），
     完整保留手动能力，不进入新手模式。 */
  function openCompatibleImport() {
    closeSetupWizardIfOpen();
    if (!apiPageVisible()) navTo('api');
    try { if (typeof window.addNewApi === 'function') window.addNewApi(); } catch (e) { }
    markManualEditor(true);
    setGuided(false);
    var sel = byId('api-provider');
    if (sel && providerMeta('custom')) {
      sel.value = 'custom';
      try { if (typeof window.onProviderChange === 'function') window.onProviderChange(); } catch (e) { }
    }
    var host = byId('ibo-compatible-hint');
    if (host && !host.firstChild) {
      host.appendChild(el('span', null, '把服务方给你的接口地址和 Key 填在下面。地址一般要填到完整路径（例如 …/v1/chat/completions）。'));
    }
    revealEditor();
    var ep = byId('api-endpoint');
    if (ep) { try { ep.focus(); } catch (e) { } }
    return true;
  }

  /* ══ 获取向导（弹层） ═══════════════════════════════════════ */
  function mountOverlay() {
    if (byId(OVERLAY_ID)) return byId(OVERLAY_ID);
    var ov = el('div', 'ibo-overlay');
    ov.id = OVERLAY_ID;
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'ibo-title');

    var card = el('div', 'ibo-card glass-card');
    var head = el('div', 'ibo-head');
    var htext = el('div', 'ibo-headtext');
    var title = el('h3', 'ibo-title', '获取 API Key');
    title.id = 'ibo-title';
    var sub = el('p', 'ibo-sub', '选一个你要用的服务，照着 3–5 步做完就行。');
    htext.appendChild(title);
    htext.appendChild(sub);
    var close = button('ibo-close', '✕', function () { closeWizard(); });
    close.setAttribute('aria-label', '关闭获取向导');
    head.appendChild(htext);
    head.appendChild(close);

    var body = el('div', 'ibo-body');
    body.id = 'ibo-body';

    var foot = el('div', 'ibo-foot');
    foot.appendChild(el('div', 'ibo-foot-note', 'API Key 只保存在这台电脑上。IB 不会替你生成、也不会替你保存 Key。'));
    foot.appendChild(button('ibo-link-btn', '我已经拿到 Key 了', function () { openManualEditor(); closeWizard(); }));

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    ov.appendChild(card);
    document.body.appendChild(ov);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) closeWizard(); });
    return ov;
  }

  function openWizard() {
    var ov = mountOverlay();
    renderWizard();
    try { ov.classList.add('is-open'); } catch (e) { }
    return true;
  }

  function closeWizard() {
    var ov = byId(OVERLAY_ID);
    if (!ov) return false;
    try { ov.classList.remove('is-open'); } catch (e) { }
    return true;
  }

  function sectionHead(parent, title, note) {
    var h = el('div', 'ibo-sec-head');
    h.appendChild(el('h4', 'ibo-sec-title', title));
    if (note) h.appendChild(el('p', 'ibo-sec-note', note));
    parent.appendChild(h);
    return h;
  }

  function metaLines(card, e) {
    var rows = [];
    if (e && e.regionHint) rows.push(e.regionHint);
    if (e && e.billingHint) rows.push(e.billingHint);
    if (e && e.audience) rows.push(e.audience);
    if (!rows.length) return card;
    var ul = el('ul', 'ibo-meta');
    for (var i = 0; i < rows.length; i++) ul.appendChild(el('li', null, rows[i]));
    card.appendChild(ul);
    return card;
  }

  function stepsBlock(card, e) {
    if (!e || !e.guideSteps || !e.guideSteps.length) return card;
    var det = document.createElement('details');
    det.className = 'ibo-steps';
    var sum = document.createElement('summary');
    sum.textContent = '照着做：' + e.guideSteps.length + ' 步拿到 Key';
    det.appendChild(sum);
    var ol = el('ol', 'ibo-step-list');
    for (var i = 0; i < e.guideSteps.length; i++) ol.appendChild(el('li', null, e.guideSteps[i]));
    det.appendChild(ol);
    card.appendChild(det);
    return card;
  }

  function tagRow(tags) {
    if (!tags || !tags.length) return null;
    var row = el('div', 'ibo-tags');
    for (var i = 0; i < tags.length; i++) {
      var lab = tagLabel(tags[i]);
      if (!lab) continue;
      row.appendChild(el('span', 'ibo-tag ibo-tag-' + String(tags[i]), lab));
    }
    return row;
  }

  /* 官方卡片 */
  function officialCard(pid) {
    var meta = providerMeta(pid) || {};
    var e = onboardingEntry(pid) || {};
    var card = el('div', 'ibo-card-item ibo-card-official');
    card.setAttribute('data-provider', pid);
    card.setAttribute('data-kind', 'official');

    var top = el('div', 'ibo-card-top');
    top.appendChild(el('span', 'ibo-card-name', meta.name || pid));
    top.appendChild(el('span', 'ibo-card-kind', '官方'));
    card.appendChild(top);

    var hint = providerHint(pid);
    if (hint) card.appendChild(el('div', 'ibo-card-hint', hint));
    metaLines(card, e);
    stepsBlock(card, e);

    var acts = el('div', 'ibo-card-acts');
    var get = linkEl(e.signupUrl || e.apiKeyUrl, '打开官网拿 Key', 'btn ibo-btn');
    if (get) acts.appendChild(get);
    else acts.appendChild(el('span', 'ibo-card-nokey', '官方入口待补充，请自行搜索该服务的官网。'));
    acts.appendChild(button('btn btn-primary ibo-btn', '配置到 IB', function () { configure(pid); }));
    card.appendChild(acts);
    return card;
  }

  /* 第三方卡片 */
  function thirdPartyCard(sid) {
    var e = onboardingEntry(sid) || {};
    var card = el('div', 'ibo-card-item ibo-card-third');
    card.setAttribute('data-site', sid);
    card.setAttribute('data-kind', 'thirdparty');

    var top = el('div', 'ibo-card-top');
    top.appendChild(el('span', 'ibo-card-name', e.name || sid));
    top.appendChild(el('span', 'ibo-card-kind ibo-card-kind-third', '第三方'));
    card.appendChild(top);
    card.appendChild(el('p', 'ibo-card-warn', '第三方聚合 / 中转服务，并非模型官方运营。'));
    if (e.note) card.appendChild(el('div', 'ibo-card-hint', e.note));
    var tags = tagRow(e.tags);
    if (tags) card.appendChild(tags);
    metaLines(card, e);
    stepsBlock(card, e);

    var acts = el('div', 'ibo-card-acts');
    var get = linkEl(e.signupUrl || e.apiKeyUrl, '打开官网', 'btn ibo-btn');
    if (get) acts.appendChild(get);
    acts.appendChild(button('btn btn-primary ibo-btn', '配置到 IB', function () { configure(sid); }));
    card.appendChild(acts);
    return card;
  }

  function renderWizard() {
    var body = byId('ibo-body');
    if (!body) return false;
    body.innerHTML = '';

    /* ① 官方 */
    var offWrap = el('section', 'ibo-sec');
    offWrap.id = 'ibo-sec-official';
    sectionHead(offWrap, '官方 API', '模型由这些公司自己运营，价格和额度以官网为准。');
    var offGrid = el('div', 'ibo-grid');
    var ids = officialIds();
    for (var i = 0; i < ids.length; i++) offGrid.appendChild(officialCard(ids[i]));
    offWrap.appendChild(offGrid);
    body.appendChild(offWrap);

    /* ② 第三方（视觉与语义都明显分区） */
    var thirdWrap = el('section', 'ibo-sec ibo-sec-third');
    thirdWrap.id = 'ibo-sec-third';
    sectionHead(thirdWrap, '第三方聚合 / 中转服务', '这些不是模型官方运营，只提供兼容接入。');
    var risk = el('div', 'ibo-risk');
    risk.appendChild(el('b', 'ibo-risk-title', '使用前请知道'));
    var rl = el('ul', 'ibo-risk-list');
    var lines = riskLines();
    for (var r = 0; r < lines.length; r++) rl.appendChild(el('li', null, lines[r]));
    risk.appendChild(rl);
    thirdWrap.appendChild(risk);
    var tGrid = el('div', 'ibo-grid');
    var tids = thirdPartyIds();
    for (var t = 0; t < tids.length; t++) tGrid.appendChild(thirdPartyCard(tids[t]));
    thirdWrap.appendChild(tGrid);
    body.appendChild(thirdWrap);

    /* ③ 兜底：目录里没有 onboarding metadata 的服务，依然可以配置 */
    var others = el('p', 'ibo-others');
    others.appendChild(el('span', null, '没找到你用的服务？'));
    others.appendChild(button('ibo-link-btn', '手动填写', function () { openCompatibleImport(); closeWizard(); }));
    body.appendChild(others);
    return true;
  }

  /* 编辑器里是否已经有一份「进行中」的配置（避免一键预填冲掉用户正在编辑的内容） */
  function editorBusy() {
    var ed = byId('api-editor');
    if (!ed) return false;
    var open = true;
    try { open = ed.style.display !== 'none'; } catch (e) { open = true; }
    if (!open) return false;
    var ids = ['api-ai-name', 'api-key', 'api-endpoint', 'api-model'], i;
    for (i = 0; i < ids.length; i++) {
      var n = byId(ids[i]);
      if (n && String(n.value || '').trim() !== '') return true;
    }
    return false;
  }
  function confirmReplace() {
    try { return window.confirm('编辑器里已经有一份正在编辑的配置。要用推荐的默认值新建一个吗？（原有内容不会保存）'); }
    catch (e) { return true; }
  }

  /* 「配置到 IB」：预填 + 关弹层。用户已经手工改过就不覆盖，只提示。 */
  function configure(id) {
    var e = onboardingEntry(id);
    /* 第三方自建/别家中转：没有固定地址，直接走手动填写（不猜地址） */
    if (id === 'custom-relay' || (e && e.kind === 'thirdparty' && !e.provider)) {
      closeWizard();
      return openCompatibleImport();
    }
    var pid = (e && e.provider) ? e.provider : id;
    var guided = !(e && e.kind === 'thirdparty');
    if (!apiPageVisible()) navTo('api');
    if (anyEdited() || editorBusy()) {
      if (anyEdited() || !confirmReplace()) {
        try {
          if (typeof window.toast === 'function') {
            window.toast('没有覆盖你正在编辑的内容。想用推荐默认值，请先点「+ 添加API」新建一个再回来。');
          }
        } catch (err) { }
        closeWizard();
        return false;
      }
    }
    var applied = applyPrefill({ provider: pid, guided: guided });
    closeWizard();
    return applied;
  }

  /* ══ 外链审计（只读；测试与诊断复用） ═════════════════════ */
  function auditExternalLinks(root) {
    var scope = root || document;
    var out = { total: 0, unsafe: [], missingRel: [] };
    var links = [];
    try { links = scope.querySelectorAll ? scope.querySelectorAll('a[href]') : []; } catch (e) { links = []; }
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = '';
      try { href = String(a.getAttribute('href') || ''); } catch (e) { href = ''; }
      if (!/^https?:\/\//i.test(href)) continue;
      out.total++;
      if (SECRET_PARAM.test(href)) out.unsafe.push(href);
      var rel = '';
      try { rel = String(a.getAttribute('rel') || ''); } catch (e) { rel = ''; }
      if (rel.indexOf('noopener') === -1 || rel.indexOf('noreferrer') === -1) out.missingRel.push(href);
    }
    return out;
  }

  /* ══ 导出 ═════════════════════════════════════════════════ */
  NS.STYLE_HREF = STYLE_HREF;
  NS.HOST_ID = HOST_ID;
  NS.OVERLAY_ID = OVERLAY_ID;
  NS.render = renderEntry;
  NS.openWizard = openWizard;
  NS.closeWizard = closeWizard;
  NS.configure = configure;
  NS.openManualEditor = openManualEditor;
  NS.openCompatibleImport = openCompatibleImport;
  NS.applyPrefill = applyPrefill;
  NS.setGuided = setGuided;
  NS.revealEditor = revealEditor;
  NS.renderKeyHelp = renderKeyHelp;
  NS.renderProviderNote = renderProviderNote;
  NS.providerHint = providerHint;
  NS.safeUrl = safeUrl;
  NS.auditExternalLinks = auditExternalLinks;
  NS.officialIds = officialIds;
  NS.thirdPartyIds = thirdPartyIds;
  NS.providerName = providerName;
  NS.onboardingEntry = onboardingEntry;
  NS.riskLines = riskLines;
  NS.tagLabel = tagLabel;

  function boot() {
    if (!renderEntry()) setTimeout(renderEntry, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
