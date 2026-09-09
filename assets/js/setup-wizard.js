/* ============================================================
   P4 · First-Run Setup Wizard（首次设置向导）
   ------------------------------------------------------------
   目标：完全不懂编程的用户第一次打开 InternalBeyond 后，通过向导完成
        「选 AI 服务 → 填密钥 → 选模型 → 测试连接 → 创建角色」，
        并成功发出第一条消息。

   铁律（本文件不得违反）：
     · 不新建第二套角色表 / 不新建第二份 API 保存逻辑：角色一律经
       addNewApi() 临时填充现有 API 编辑器 DOM → saveCurrentApi() 落盘，
       数据只存在 apiConfigs（唯一事实源）。
     · 不复制 provider metadata：name / endpoint / model / format / vision /
       streaming 全部读 provider-directory.js（window.PROVIDERS_DIR.PROVIDERS）。
     · 不升 IndexedDB DB_VER：状态写在 apiSettings 的
       'ibSetupV1Done' / 'ibSetupV1Draft' 两个私有 key。
     · API Key 永不进 console、永不进错误详情、永不进草稿持久化。
     · 错误一律经 P3 的 window.IBERR（present / model / detailsText）呈现，
       不另写一套错误字符串。
     · 测试连接走真实现有调用链 callApiChat(cfg,messages,opts)，不自建请求。
   ============================================================ */
(function (NS) {
  'use strict';

  var DONE_KEY = 'ibSetupV1Done';
  var DRAFT_KEY = 'ibSetupV1Draft';
  var SCHEMA_VERSION = 1;
  var STYLE_HREF = 'assets/css/setup-wizard.css';
  var TEST_CFG_ID = '__ib_setup_test__';
  var TOTAL_STEPS = 7;

  /* ── 步骤（顺序即流程） ── */
  var STEPS = [
    { id: 'welcome', title: '欢迎使用 InternalBeyond' },
    { id: 'provider', title: '选择 AI 服务' },
    { id: 'key', title: '填写 API Key' },
    { id: 'model', title: '模型与接口' },
    { id: 'test', title: '测试连接' },
    { id: 'role', title: '创建你的第一个角色' },
    { id: 'done', title: '设置完成' }
  ];

  /* ── 呈现层：卡片顺序 + 一句话说明 ──
     这里只决定「怎么摆、怎么称呼」，绝不携带 provider 的 endpoint / model /
     format / vision / streaming —— 那些一律取 provider-directory.js。 */
  var PROVIDER_ORDER = ['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'glm', 'qwen', 'doubao', 'mimo', 'minimax', 'grok', 'mistral', 'yi', 'baichuan', 'custom'];
  var PROVIDER_HINT = {
    openai: 'OpenAI 官方',
    anthropic: 'Anthropic 官方',
    gemini: 'Google 官方',
    deepseek: 'DeepSeek 官方',
    moonshot: '月之暗面 Kimi',
    glm: '智谱 AI',
    qwen: '阿里云',
    doubao: '字节跳动',
    mimo: '小米',
    minimax: 'MiniMax',
    grok: 'xAI 官方',
    mistral: 'Mistral 官方',
    yi: '零一万物',
    baichuan: '百川智能',
    custom: '自己填写接口地址'
  };

  /* ── 运行状态（内存；只有非敏感字段会进草稿） ── */
  var S = null;

  function freshState() {
    return {
      step: 0,
      provider: '',
      apiKey: '',
      model: '',
      endpoint: '',
      noKey: false,
      nickname: '',
      relationship: '',
      desc: '',
      systemPrompt: '',
      promptDirty: false,
      avatar: null,
      test: null,
      testState: 'idle',
      savedRoleId: null,
      savedName: '',
      draftRestored: false,
      degraded: null,
      busy: false
    };
  }

  /* ══ 小工具 ══════════════════════════════════════════════ */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function toast(msg) {
    try { if (typeof window.toast === 'function') window.toast(msg); } catch (e) {}
  }

  function providers() {
    try {
      return (window.PROVIDERS_DIR && window.PROVIDERS_DIR.PROVIDERS) || window.PROVIDERS || {};
    } catch (e) { return {}; }
  }

  function providerMeta(p) {
    var all = providers();
    return all[p] || null;
  }

  function providerName(p) {
    var m = providerMeta(p);
    return (m && m.name) || p || 'AI';
  }

  function isLoopback(endpoint) {
    try { if (typeof window._ibIsLoopbackEndpoint === 'function') return !!window._ibIsLoopbackEndpoint(endpoint); } catch (e) {}
    return false;
  }

  function hasCredential(cfg) {
    try { if (typeof window._ibApiHasCredential === 'function') return !!window._ibApiHasCredential(cfg); } catch (e) {}
    return !!(cfg && (String(cfg.apiKey || '').trim() || isLoopback(cfg.endpoint)));
  }

  function defaultPrompt() {
    try { if (typeof window.getDefaultPromptForTheme === 'function') return String(window.getDefaultPromptForTheme() || ''); } catch (e) {}
    var ta = $('api-system');
    var ph = ta && ta.placeholder ? String(ta.placeholder) : '';
    return ph === '设置AI的系统提示词…' ? '' : ph;
  }

  /* ══ 纯逻辑（可被测试直接调用） ═══════════════════════════ */

  /* 角色描述 + 默认设定 → 实际保存的 systemPrompt。
     留空 = 不写系统提示词（与 API 编辑器「清空默认文本」语义一致）。 */
  function composePrompt(base, desc) {
    var b = String(base == null ? '' : base).trim();
    var d = String(desc == null ? '' : desc).trim();
    if (!d) return b;
    if (!b) return d;
    return b + '\n\n' + d;
  }

  /* 草稿载荷：绝不含 apiKey / 头像 dataURL（头像体积大且无必要）。 */
  function draftPayload(s) {
    s = s || {};
    return {
      id: DRAFT_KEY,
      version: SCHEMA_VERSION,
      step: Math.max(0, Math.min(TOTAL_STEPS - 1, Number(s.step) || 0)),
      provider: String(s.provider || ''),
      model: String(s.model || ''),
      endpoint: String(s.endpoint || ''),
      noKey: !!s.noKey,
      nickname: String(s.nickname || ''),
      relationship: String(s.relationship || ''),
      desc: String(s.desc || ''),
      systemPrompt: s.promptDirty ? String(s.systemPrompt || '') : '',
      updatedAt: Date.now()
    };
  }

  /* 自动进入向导的判定（纯函数，测试覆盖矩阵）。
     rec: {done:boolean, skipped:boolean, unreadable?:boolean} */
  function decide(rec, draft, rolesCount) {
    if (rec && rec.unreadable) return { open: false, reason: 'state-unreadable' };
    if (rec && rec.done === true) return { open: false, reason: rec.skipped ? 'skipped' : 'done' };
    if (Number(rolesCount) > 0) return { open: false, reason: 'existing-user' };
    return { open: true, reason: draft ? 'resume' : 'first-run' };
  }

  /* 测试连接用的临时配置：只走现有 callApiChat，不落盘。 */
  function testConfig(s) {
    s = s || {};
    return {
      id: TEST_CFG_ID,
      provider: String(s.provider || 'custom'),
      apiKey: String(s.apiKey || ''),
      model: String(s.model || ''),
      endpoint: String(s.endpoint || ''),
      nickname: '',
      relationship: '',
      temperature: 1,
      streaming: false,
      showThinking: false,
      promptCache: false,
      vision: false
    };
  }

  function roleNameTaken(name, roles) {
    var n = String(name || '').trim();
    if (!n) return false;
    return (roles || []).some(function (c) {
      return String((c && (c.nickname || c.model)) || '').trim() === n;
    });
  }

  /* 单步校验：返回 null = 通过；否则 {field, message} */
  function validateStep(stepId, s, roles) {
    s = s || {};
    if (stepId === 'provider') {
      if (!s.provider || !providerMeta(s.provider)) return { field: 'provider', message: '请选择一个 AI 服务。' };
      return null;
    }
    if (stepId === 'key') {
      if (String(s.apiKey || '').trim()) return null;
      if (s.noKey || isLoopback(s.endpoint)) return null;
      return { field: 'apiKey', message: '请填写 API Key。没有密钥时请选择「使用本机模型」。' };
    }
    if (stepId === 'model') {
      if (!String(s.model || '').trim()) return { field: 'model', message: '请填写模型名称（一般保持默认即可）。' };
      if (!String(s.endpoint || '').trim()) return { field: 'endpoint', message: '请填写接口地址。' };
      if (s.noKey && !isLoopback(s.endpoint)) return { field: 'endpoint', message: '免密钥只适用于本机运行的模型服务，请填写本机地址。' };
      return null;
    }
    if (stepId === 'role') {
      var n = String(s.nickname || '').trim();
      if (!n) return { field: 'nickname', message: '请给这个角色起一个名字。' };
      if (n.length > 16) return { field: 'nickname', message: '名字请控制在 16 个字符以内。' };
      if (roleNameTaken(n, roles)) return { field: 'nickname', message: '已经有同名角色了，换一个名字吧。' };
      return null;
    }
    return null;
  }

  /* ══ 持久化 ══════════════════════════════════════════════ */

  async function readSetupRecord() {
    try {
      var rec = await dbGet('apiSettings', DONE_KEY);
      if (!rec || typeof rec !== 'object' || rec.done !== true) {
        return { done: false, skipped: !!(rec && rec.skipped), raw: rec || null };
      }
      return { done: true, skipped: !!rec.skipped, raw: rec };
    } catch (e) {
      /* 状态损坏 / 数据库不可用：绝不让主界面打不开 —— 不自动弹向导。 */
      console.warn('[IBSetup] 设置状态读取失败，本次不自动打开向导', e);
      return { done: false, skipped: false, unreadable: true };
    }
  }

  async function readDraft() {
    try {
      var d = await dbGet('apiSettings', DRAFT_KEY);
      if (!d || typeof d !== 'object') return null;
      if (d.apiKey) return null;                 /* 旧版本误写的密钥：直接丢弃，不再使用 */
      return d;
    } catch (e) { return null; }
  }

  async function writeDone(skipped, extra) {
    try {
      await dbPut('apiSettings', Object.assign({
        id: DONE_KEY,
        done: true,
        skipped: !!skipped,
        version: SCHEMA_VERSION,
        at: Date.now()
      }, extra || {}));
      return true;
    } catch (e) {
      console.warn('[IBSetup] 设置状态写入失败', e);
      return false;
    }
  }

  async function writeDraft() {
    try { await dbPut('apiSettings', draftPayload(S)); } catch (e) {}
  }

  async function clearDraft() {
    try { await dbDelete('apiSettings', DRAFT_KEY); } catch (e) {}
  }

  /* ══ DOM 骨架 ════════════════════════════════════════════ */

  function injectStyles() {
    if (!document || !document.head) return;
    if ($('ib-setup-css')) return;
    var link = document.createElement('link');
    link.id = 'ib-setup-css';
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    document.head.appendChild(link);
  }

  function mount() {
    if ($('ib-setup')) return;
    var overlay = el('div', 'ib-setup-overlay');
    overlay.id = 'ib-setup';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ib-setup-title');

    var card = el('div', 'ib-setup-card glass-card');
    var head = el('div', 'ib-setup-head');
    var headText = el('div', 'ib-setup-headtext');
    var stepEl = el('div', 'ib-setup-step');
    stepEl.id = 'ib-setup-step';
    var titleEl = el('h3', 'ib-setup-title');
    titleEl.id = 'ib-setup-title';
    headText.appendChild(stepEl);
    headText.appendChild(titleEl);
    var close = el('button', 'ib-setup-close', '✕');
    close.id = 'ib-setup-close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭设置向导');
    close.onclick = function () { closeWizard('close'); };
    head.appendChild(headText);
    head.appendChild(close);

    var progress = el('div', 'ib-setup-progress');
    var bar = el('span', 'ib-setup-bar');
    var fill = el('i');
    fill.id = 'ib-setup-bar-fill';
    bar.appendChild(fill);
    progress.appendChild(bar);

    var body = el('div', 'ib-setup-body');
    body.id = 'ib-setup-body';

    var foot = el('div', 'ib-setup-foot');
    var note = el('div', 'ib-setup-foot-note');
    note.id = 'ib-setup-note';
    var back = el('button', 'btn', '上一步');
    back.id = 'ib-setup-back';
    back.type = 'button';
    back.onclick = function () { backStep(); };
    var next = el('button', 'btn btn-primary', '下一步');
    next.id = 'ib-setup-next';
    next.type = 'button';
    next.onclick = function () { nextStep(); };
    foot.appendChild(note);
    foot.appendChild(back);
    foot.appendChild(next);

    card.appendChild(head);
    card.appendChild(progress);
    card.appendChild(body);
    card.appendChild(foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  /* ══ 表单读写（每次重绘前收集，重绘后回填，绝不丢已填内容） ══ */

  function readFields() {
    var g = function (id) { var n = $(id); return n ? String(n.value || '') : null; };
    var before = [S.apiKey, S.model, S.endpoint].join('\u0000');
    var v;
    v = g('ib-setup-key'); if (v !== null) S.apiKey = v;
    v = g('ib-setup-model'); if (v !== null) S.model = v;
    v = g('ib-setup-endpoint'); if (v !== null) S.endpoint = v;
    v = g('ib-setup-name'); if (v !== null) S.nickname = v;
    v = g('ib-setup-rel'); if (v !== null) S.relationship = v;
    v = g('ib-setup-desc'); if (v !== null) S.desc = v;
    v = g('ib-setup-prompt'); if (v !== null) S.systemPrompt = v;
    /* 连接参数一旦变化，上一次的测试结论就失效（必须重新测试）。 */
    if (before !== [S.apiKey, S.model, S.endpoint].join('\u0000')) {
      S.testState = 'idle';
      S.test = null;
    }
  }

  function field(labelText, inputEl, hintText) {
    var wrap = el('div', 'ib-setup-field');
    var lab = el('label', 'ib-setup-label', labelText);
    if (inputEl.id) lab.setAttribute('for', inputEl.id);
    wrap.appendChild(lab);
    wrap.appendChild(inputEl);
    if (hintText) wrap.appendChild(el('div', 'ib-setup-hint', hintText));
    return wrap;
  }

  function textInput(id, placeholder, maxlength) {
    var n = el('input', 'ib-setup-input');
    n.id = id;
    n.type = 'text';
    if (placeholder) n.placeholder = placeholder;
    if (maxlength) n.maxLength = maxlength;
    return n;
  }

  function textArea(id, placeholder, rows) {
    var n = el('textarea', 'ib-setup-area');
    n.id = id;
    n.rows = rows || 3;
    if (placeholder) n.placeholder = placeholder;
    return n;
  }

  function advancedBlock(openByDefault) {
    var wrap = el('div', 'ib-setup-adv');
    var btn = el('button', 'ib-setup-adv-btn');
    btn.type = 'button';
    var label = el('span', null, '高级设置（一般不用改）');
    var caret = el('span', null, openByDefault ? '▴' : '▾');
    btn.appendChild(label);
    btn.appendChild(caret);
    var body = el('div', 'ib-setup-adv-body' + (openByDefault ? ' is-open' : ''));
    btn.onclick = function () {
      var open = body.classList.toggle('is-open');
      caret.textContent = open ? '▴' : '▾';
    };
    wrap.appendChild(btn);
    wrap.appendChild(body);
    return { root: wrap, body: body };
  }

  function errLine(id) {
    var n = el('div', 'ib-setup-err');
    n.id = id;
    return n;
  }

  function setErr(id, msg) {
    var n = $(id);
    if (n) n.textContent = msg || '';
  }

  /* ══ 各步渲染 ════════════════════════════════════════════ */

  function renderWelcome(body) {
    body.appendChild(el('p', 'ib-setup-lead', '几分钟完成第一次设置，不需要编程知识。'));
    var list = el('ul', 'ib-setup-bullets');
    ['选择一个 AI 服务', '填入你的 API Key', '创建一个角色，然后就能开始聊天'].forEach(function (t) {
      list.appendChild(el('li', null, t));
    });
    body.appendChild(list);
    body.appendChild(el('p', 'ib-setup-hint', '设置只保存在这台电脑的浏览器里，不会上传到任何服务器。'));
    body.appendChild(el('p', 'ib-setup-hint', '暂时还没有密钥也没关系：点「稍后设置」，之后可以随时重新打开这个向导。'));
    if (S.draftRestored) {
      body.appendChild(el('p', 'ib-setup-hint', '上次没有设置完，已经为你保留之前填写的内容。'));
    }
    if (S.degraded) {
      var d = el('div', 'ib-setup-degraded', S.degraded);
      body.insertBefore(d, body.firstChild);
    }
  }

  function renderProvider(body) {
    body.appendChild(el('p', null, '先选一个你准备使用的 AI 服务。列表来自 InternalBeyond 内置的服务商目录。'));
    var grid = el('div', 'ib-setup-grid');
    var all = providers();
    var seen = {};
    var order = PROVIDER_ORDER.filter(function (p) { return !!all[p]; });
    Object.keys(all).forEach(function (p) { if (order.indexOf(p) === -1) order.push(p); });
    order.forEach(function (p) {
      if (seen[p]) return;
      seen[p] = true;
      var meta = all[p] || {};
      var btn = el('button', 'ib-setup-provider' + (S.provider === p ? ' is-on' : ''));
      btn.type = 'button';
      btn.setAttribute('data-provider', p);
      btn.appendChild(el('span', 'ib-setup-provider-name', meta.name || p));
      var hint = PROVIDER_HINT[p];
      if (hint) btn.appendChild(el('span', 'ib-setup-provider-hint', hint));
      btn.onclick = function () {
        readFields();
        S.provider = p;
        S.model = meta.model || '';
        S.endpoint = meta.endpoint || '';
        S.noKey = false;
        S.test = null;
        S.testState = 'idle';
        render();
      };
      grid.appendChild(btn);
    });
    body.appendChild(grid);
    body.appendChild(errLine('ib-setup-err-provider'));
  }

  function renderKey(body) {
    body.appendChild(el('p', null, '把 ' + providerName(S.provider) + ' 的 API Key 粘贴到这里。'));
    var row = el('div', 'ib-setup-keyrow');
    var input = el('input', 'ib-setup-input');
    input.id = 'ib-setup-key';
    input.type = 'password';
    input.value = S.apiKey;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'API Key');
    input.placeholder = '粘贴你的 API Key';
    var reveal = el('button', 'ib-setup-reveal', '显示');
    reveal.type = 'button';
    reveal.onclick = function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.textContent = show ? '隐藏' : '显示';
      input.focus();
    };
    row.appendChild(input);
    row.appendChild(reveal);
    body.appendChild(field('API Key', row));
    body.appendChild(el('div', 'ib-setup-hint', '密钥只保存在这台电脑上，不会上传到任何服务器，也不会出现在日志里。'));
    var local = el('button', 'ib-setup-link', '使用本机模型，不需要密钥');
    local.type = 'button';
    local.onclick = function () {
      readFields();
      S.noKey = true;
      S.test = null;
      S.testState = 'idle';
      render();
    };
    var p = el('p', 'ib-setup-hint');
    if (S.noKey) {
      p.textContent = '已选择免密钥方式：请在下一步的「接口地址」里填写你本机运行的模型服务地址。';
    } else {
      p.appendChild(local);
    }
    body.appendChild(p);
    body.appendChild(errLine('ib-setup-err-key'));
  }

  function renderModel(body) {
    var meta = providerMeta(S.provider) || {};
    body.appendChild(el('p', null, '模型用默认的就可以；接口地址一般不用改。'));
    var model = textInput('ib-setup-model', meta.model ? '例如 ' + meta.model : '填写模型名称');
    model.value = S.model;
    body.appendChild(field('模型', model, '如果服务商给了新的模型名称，直接替换即可。'));

    var adv = advancedBlock(!!S.noKey || !meta.endpoint);
    var ep = textInput('ib-setup-endpoint', '接口地址');
    ep.value = S.endpoint;
    adv.body.appendChild(field('接口地址', ep, '默认已经填好，除非服务商另有说明，否则不用修改。'));
    body.appendChild(adv.root);
    body.appendChild(errLine('ib-setup-err-model'));
  }

  function renderTest(body) {
    var cfg = testConfig(S);
    body.appendChild(el('p', null, '现在验证一下配置是否真的可用。这一步会向 ' + providerName(S.provider) + ' 发一次极小的真实请求。'));
    var summary = el('div', 'ib-setup-summary');
    [['服务', providerName(S.provider)], ['模型', S.model || '—']].forEach(function (kv) {
      var row = el('div', 'ib-setup-summary-row');
      row.appendChild(el('div', 'ib-setup-summary-key', kv[0]));
      row.appendChild(el('div', 'ib-setup-summary-val', kv[1]));
      summary.appendChild(row);
    });
    body.appendChild(summary);

    var box = el('div');
    box.id = 'ib-setup-testbox';
    body.appendChild(box);
    body.appendChild(errLine('ib-setup-err-test'));

    if (!hasCredential(cfg)) {
      setErr('ib-setup-err-test', '还没有可用的密钥（或本机地址），请回到上一步填写后再测试。');
      return;
    }
    renderTestBox();
  }

  function renderTestBox() {
    var box = $('ib-setup-testbox');
    if (!box) return;
    box.innerHTML = '';
    if (S.testState === 'running') {
      box.appendChild(el('div', 'ib-setup-msg', '正在连接…'));
      return;
    }
    if (S.testState === 'ok') {
      box.appendChild(el('div', 'ib-setup-msg is-ok', '连接成功，可以使用。'));
      return;
    }
    if (S.testState === 'fail' && S.test) {
      box.appendChild(errorCard(S.test));
      return;
    }
    var run = el('button', 'btn btn-primary', '测试连接');
    run.type = 'button';
    run.id = 'ib-setup-run-test';
    run.onclick = function () { runTest(); };
    box.appendChild(run);
    var skipTest = el('button', 'ib-setup-link', '先不测试，继续');
    skipTest.type = 'button';
    var wrap = el('p', 'ib-setup-hint');
    wrap.appendChild(skipTest);
    skipTest.onclick = function () {
      S.testState = 'skipped';
      nextStep();
    };
    box.appendChild(wrap);
  }

  /* P3 错误模型 → 向导内联卡片（复用 IBERR 文案与脱敏详情，不新写错误字符串） */
  function errorCard(model) {
    var card = el('div', 'ib-setup-msg is-err');
    card.appendChild(el('div', 'ib-setup-err-title', model.title || '连接失败'));
    card.appendChild(el('div', 'ib-setup-err-message', model.message || ''));
    if (model.suggestion) card.appendChild(el('div', 'ib-setup-err-suggestion', model.suggestion));
    var actions = el('div', 'ib-setup-err-actions');
    var retry = el('button', 'ib-setup-mini', '再试一次');
    retry.type = 'button';
    retry.onclick = function () { runTest(); };
    actions.appendChild(retry);
    var details = el('div', 'ib-setup-err-details');
    var text = '';
    try {
      text = (window.IBERR && window.IBERR.detailsText) ? window.IBERR.detailsText(model) : '';
    } catch (e) { text = ''; }
    details.textContent = text;
    var toggle = el('button', 'ib-setup-mini', '查看详情');
    toggle.type = 'button';
    toggle.onclick = function () {
      var open = details.classList.toggle('is-open');
      toggle.textContent = open ? '收起详情' : '查看详情';
    };
    actions.appendChild(toggle);
    card.appendChild(actions);
    card.appendChild(details);
    return card;
  }

  function renderRole(body) {
    body.appendChild(el('p', null, '给 TA 起个名字，这样就能开始聊天了。'));
    var name = textInput('ib-setup-name', '例如：小雾', 16);
    name.value = S.nickname;
    name.setAttribute('aria-label', '角色名称');
    body.appendChild(field('名字', name));

    var rel = textInput('ib-setup-rel', '例如：挚友、家人、搭档…', 16);
    rel.value = S.relationship;
    body.appendChild(field('TA 和你的关系（可选）', rel));

    var desc = textArea('ib-setup-desc', '例如：说话简短，喜欢在深夜聊天，会记得我说过的小事。', 3);
    desc.value = S.desc;
    desc.oninput = function () {
      if (!S.promptDirty) {
        var ta = $('ib-setup-prompt');
        if (ta) ta.value = composePrompt(defaultPrompt(), desc.value);
      }
    };
    body.appendChild(field('简单描述一下 TA（可选）', desc, '这段话会作为 TA 的角色设定。'));

    var avatarWrap = el('div', 'ib-setup-field');
    avatarWrap.appendChild(el('label', 'ib-setup-label', '头像（可选）'));
    var row = el('div', 'ib-setup-avatar');
    var preview = el('div', 'ib-setup-avatar-img');
    preview.id = 'ib-setup-avatar';
    preview.textContent = (S.nickname || '?').charAt(0).toUpperCase();
    if (S.avatar) preview.style.backgroundImage = 'url("' + S.avatar + '")';
    var pick = el('button', 'ib-setup-mini', '选择图片');
    pick.type = 'button';
    var file = el('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.id = 'ib-setup-avatar-inp';
    file.hidden = true;
    pick.onclick = function () { file.click(); };
    file.onchange = function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        S.avatar = String(reader.result || '');
        var pv = $('ib-setup-avatar');
        if (pv) { pv.style.backgroundImage = 'url("' + S.avatar + '")'; pv.textContent = ''; }
      };
      reader.readAsDataURL(f);
      file.value = '';
    };
    var clear = el('button', 'ib-setup-mini', '移除');
    clear.type = 'button';
    clear.onclick = function () {
      S.avatar = null;
      var pv = $('ib-setup-avatar');
      if (pv) { pv.style.backgroundImage = ''; pv.textContent = (S.nickname || '?').charAt(0).toUpperCase(); }
    };
    row.appendChild(preview);
    row.appendChild(pick);
    row.appendChild(clear);
    row.appendChild(file);
    avatarWrap.appendChild(row);
    body.appendChild(avatarWrap);

    var adv = advancedBlock(false);
    var prompt = textArea('ib-setup-prompt', '角色设定（系统提示词）', 6);
    prompt.value = S.promptDirty ? S.systemPrompt : composePrompt(defaultPrompt(), S.desc);
    prompt.oninput = function () { S.promptDirty = true; };
    adv.body.appendChild(field('角色设定', prompt, '留空表示不额外设置；上面的「简单描述」会自动追加到这里。'));
    body.appendChild(adv.root);
    body.appendChild(errLine('ib-setup-err-role'));
  }

  function renderDone(body) {
    body.appendChild(el('p', 'ib-setup-lead', '现在可以开始聊天了。'));
    body.appendChild(el('p', null, '你的角色已经创建好，并且自动选中。随时可以在「API Settings」页面继续添加角色或调整设置。'));
    var summary = el('div', 'ib-setup-summary');
    [['角色', S.savedName || S.nickname], ['服务', providerName(S.provider)], ['模型', S.model || '—']].forEach(function (kv) {
      var row = el('div', 'ib-setup-summary-row');
      row.appendChild(el('div', 'ib-setup-summary-key', kv[0]));
      row.appendChild(el('div', 'ib-setup-summary-val', kv[1]));
      summary.appendChild(row);
    });
    body.appendChild(summary);
  }

  var RENDERERS = {
    welcome: renderWelcome,
    provider: renderProvider,
    key: renderKey,
    model: renderModel,
    test: renderTest,
    role: renderRole,
    done: renderDone
  };

  /* ══ 渲染 ════════════════════════════════════════════════ */

  function render() {
    if (!S.open) return;
    var step = STEPS[S.step] || STEPS[0];
    var stepEl = $('ib-setup-step');
    if (stepEl) stepEl.textContent = '第 ' + (S.step + 1) + ' 步 / 共 ' + TOTAL_STEPS + ' 步';
    var titleEl = $('ib-setup-title');
    if (titleEl) titleEl.textContent = step.title;
    var fill = $('ib-setup-bar-fill');
    if (fill) fill.style.width = Math.round(((S.step + 1) / TOTAL_STEPS) * 100) + '%';

    var body = $('ib-setup-body');
    if (body) {
      body.innerHTML = '';
      (RENDERERS[step.id] || renderWelcome)(body);
      body.scrollTop = 0;
    }

    var back = $('ib-setup-back');
    /* 完成步骤不允许回退：角色已经落库，回退再前进会重复创建 */
    if (back) back.style.display = (S.step === 0 || S.step === TOTAL_STEPS - 1) ? 'none' : '';
    var next = $('ib-setup-next');
    if (next) {
      next.textContent = S.step === TOTAL_STEPS - 1 ? '开始聊天' : (S.step === TOTAL_STEPS - 2 ? '创建角色' : '下一步');
      next.disabled = !!S.busy;
    }
    renderNote();
  }

  function renderNote() {
    var note = $('ib-setup-note');
    if (!note) return;
    note.innerHTML = '';
    if (S.step >= TOTAL_STEPS - 1) {
      note.textContent = '';
      return;
    }
    var skip = el('button', 'ib-setup-link', '稍后设置');
    skip.type = 'button';
    skip.id = 'ib-setup-skip';
    skip.onclick = function () { skipSetup(); };
    note.appendChild(skip);
    if (S.step > 0) note.appendChild(el('span', null, ' · 已填写的内容会自动保留'));
  }

  /* ══ 导航 ════════════════════════════════════════════════ */

  function stepId() { return (STEPS[S.step] || STEPS[0]).id; }

  function focusFirst() {
    var body = $('ib-setup-body');
    if (!body) return;
    var target = body.querySelector('input:not([type=file]), textarea, .ib-setup-provider, button.btn-primary');
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch (e) {}
    }
  }

  function goStep(i) {
    readFields();
    S.step = Math.max(0, Math.min(TOTAL_STEPS - 1, i));
    render();
    focusFirst();
  }

  function backStep() {
    if (S.busy) return;
    readFields();
    if (S.step > 0) goStep(S.step - 1);
  }

  async function nextStep() {
    if (S.busy) return;
    readFields();
    var id = stepId();
    if (id === 'done') { await finish(); return; }

    var problem = validateStep(id, S, window.apiConfigs || []);
    if (problem) {
      setErr('ib-setup-err-' + problem.field, problem.message);
      var focus = $('ib-setup-' + (problem.field === 'apiKey' ? 'key' : problem.field));
      if (focus && focus.focus) { try { focus.focus(); } catch (e) {} }
      return;
    }
    if (id === 'test' && S.testState === 'idle') {
      /* 没测试就继续：允许，但明确提示 */
      S.testState = 'skipped';
    }
    if (id === 'role') {
      S.busy = true; render();
      var ok = await createRole();
      S.busy = false;
      if (!ok) { render(); return; }
    }
    goStep(S.step + 1);
  }

  /* ══ 测试连接（走真实现有调用链） ═══════════════════════ */

  async function runTest() {
    if (S.busy) return;
    readFields();
    var problem = validateStep('model', S, window.apiConfigs || []);
    if (problem) { goStep(3); setErr('ib-setup-err-model', problem.message); return; }
    if (typeof window.callApiChat !== 'function') {
      S.testState = 'fail';
      S.test = { code: 'IBERR.UNKNOWN.UNKNOWN', title: '无法测试连接', message: '当前页面还没准备好，请刷新后再试。', suggestion: '', technicalDetails: {} };
      render();
      return;
    }
    S.busy = true; S.testState = 'running'; S.test = null;
    render();
    var cfg = testConfig(S);
    try {
      await window.callApiChat(cfg, [{ role: 'user', content: '你好' }], {
        maxTokens: 16,
        timeoutMs: 30000,
        disableTools: true,
        _noWebSearch: true,
        wantMeta: false
      });
      S.testState = 'ok';
      S.test = null;
    } catch (e) {
      S.testState = 'fail';
      try {
        S.test = window.IBERR && window.IBERR.present
          ? window.IBERR.present(e, {
            stage: 'setup_test',
            cfg: { id: TEST_CFG_ID, provider: cfg.provider, model: cfg.model, endpoint: cfg.endpoint },
            endpoint: cfg.endpoint,
            provider: cfg.provider,
            model: cfg.model
          })
          : { code: 'IBERR.UNKNOWN.UNKNOWN', title: '连接失败', message: '没能连接到这个 AI 服务，请检查填写的内容。', suggestion: '确认密钥和模型名称后再试一次。', technicalDetails: {} };
      } catch (e2) {
        S.test = { code: 'IBERR.UNKNOWN.UNKNOWN', title: '连接失败', message: '没能连接到这个 AI 服务，请检查填写的内容。', suggestion: '确认密钥和模型名称后再试一次。', technicalDetails: {} };
      }
      /* 原始诊断只在开发者控制台（不含密钥）；用户界面只显示 P3 文案 */
      try { console.warn('[IBSetup] 连接测试失败', e); } catch (e3) {}
    } finally {
      S.busy = false;
    }
    render();
  }

  /* ══ 创建角色（复用现有 API 编辑器保存链） ═══════════════ */

  async function createRole() {
    if (typeof window.addNewApi !== 'function' || typeof window.saveCurrentApi !== 'function') {
      setErr('ib-setup-err-role', '当前页面还没准备好，请刷新后再试。');
      return false;
    }
    var id = null;
    try {
      window.addNewApi();
      id = window.editingApiId;
      var setVal = function (domId, value) {
        var n = $(domId);
        if (n) n.value = value == null ? '' : String(value);
      };
      setVal('api-ai-name', S.nickname);
      var prov = $('api-provider');
      if (prov) prov.value = S.provider;
      if (typeof window.onProviderChange === 'function') window.onProviderChange();
      setVal('api-model', S.model);
      setVal('api-endpoint', S.endpoint);
      setVal('api-key', S.apiKey);
      setVal('api-relationship', S.relationship);
      setVal('api-system', S.promptDirty ? S.systemPrompt : composePrompt(defaultPrompt(), S.desc));
      window._pendingApiAvatar = S.avatar || null;
      await window.saveCurrentApi(null);
      var saved = (window.apiConfigs || []).filter(function (c) { return c.id === id; })[0];
      if (!saved) throw new Error('角色没有保存成功');
      S.savedRoleId = id;
      S.savedName = saved.nickname || saved.model || S.nickname;
      return true;
    } catch (e) {
      window._pendingApiAvatar = null;
      var msg = '创建角色失败，请重试。';
      try {
        if (window.IBERR && window.IBERR.present) {
          var m = window.IBERR.present(e, { stage: 'setup_create_role' });
          msg = (m.title ? m.title + '：' : '') + (m.message || msg) + (m.suggestion ? '（' + m.suggestion + '）' : '');
        }
      } catch (e2) {}
      setErr('ib-setup-err-role', msg);
      try { console.warn('[IBSetup] 创建角色失败', e); } catch (e3) {}
      return false;
    }
  }

  /* ══ 打开 / 关闭 / 完成 / 跳过 ═══════════════════════════ */

  function open(opts) {
    opts = opts || {};
    if (!S) S = freshState();
    if (S.open) return;
    injectStyles();
    mount();
    S.open = true;
    S.test = null;
    S.testState = 'idle';
    /* 有草稿（或显式 resume）时从上次步骤继续；否则从头开始 */
    if (!opts.resume && !S.draftRestored) {
      S.step = 0;
      S.savedRoleId = null;
      S.savedName = '';
    }
    var overlay = $('ib-setup');
    if (overlay) overlay.classList.add('is-open');
    document.addEventListener('keydown', onKeyDown, true);
    render();
    focusFirst();
  }

  async function closeWizard(reason) {
    if (!S || !S.open) return;
    if (S.step >= TOTAL_STEPS - 1 && S.savedRoleId) { await finish(); return; }
    readFields();
    S.open = false;
    var overlay = $('ib-setup');
    if (overlay) overlay.classList.remove('is-open');
    document.removeEventListener('keydown', onKeyDown, true);
    await writeDraft();
    S.draftRestored = true;          /* 同一会话内重新打开时从上次步骤继续 */
    refreshChatEmptyState();
    if (reason === 'esc' || reason === 'close') toast('已保存填写内容，下次打开可以继续');
  }

  async function skipSetup() {
    readFields();
    S.open = false;
    var overlay = $('ib-setup');
    if (overlay) overlay.classList.remove('is-open');
    document.removeEventListener('keydown', onKeyDown, true);
    await writeDone(true);
    await clearDraft();
    S.draftRestored = false;
    refreshChatEmptyState();
    toast('已跳过设置：聊天前需要先添加 AI 与角色');
  }

  async function finish() {
    await writeDone(false);
    await clearDraft();
    S.draftRestored = false;
    S.open = false;
    var overlay = $('ib-setup');
    if (overlay) overlay.classList.remove('is-open');
    document.removeEventListener('keydown', onKeyDown, true);
    refreshChatEmptyState();
    try { if (typeof window.navTo === 'function') window.navTo('chat'); } catch (e) {}
    if (S.savedRoleId && typeof window.selectFriend === 'function') {
      try { await window.selectFriend(S.savedRoleId); } catch (e) {}
    }
    try {
      var input = $('chat-full-input');
      if (input && input.focus) input.focus();
    } catch (e) {}
    toast('现在可以开始聊天了');
  }

  function onKeyDown(ev) {
    if (!S || !S.open) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeWizard('esc');
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      var t = ev.target;
      var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      if (tag === 'TEXTAREA') return;                 /* 多行输入保留换行 */
      if (tag === 'BUTTON' || tag === 'A') return;    /* 交给按钮自身 */
      ev.preventDefault();
      nextStep();
    }
  }

  /* ══ 聊天空状态（跳过后仍明确「需要先添加 AI/角色」） ════ */

  function buildEmptyState() {
    var box = el('div', 'ib-setup-empty');
    box.id = 'ib-setup-empty';
    box.appendChild(el('div', 'ib-setup-empty-title', '还没有可以聊天的角色'));
    box.appendChild(el('div', 'ib-setup-empty-text', 'InternalBeyond 需要先添加一个 AI 服务与角色，才能开始对话。整个过程只需要一个 API Key。'));
    var btn = el('button', 'btn btn-primary', '开始设置');
    btn.type = 'button';
    btn.id = 'ib-setup-start';
    btn.onclick = function () { open({ manual: true }); };
    box.appendChild(btn);
    return box;
  }

  function refreshChatEmptyState() {
    try {
      var host = $('chat-full-messages');
      if (!host) return;
      var roles = window.apiConfigs;
      if (!Array.isArray(roles)) return;
      var box = $('ib-setup-empty');
      if (roles.length > 0) {
        if (box && box.parentNode) box.parentNode.removeChild(box);
        return;
      }
      if (box && box.parentNode === host) return;
      if (!box) box = buildEmptyState();
      host.innerHTML = '';
      host.appendChild(box);
    } catch (e) {}
  }

  /* API Settings 页提供重新进入向导的入口（不新建配置中心，仅入口） */
  function ensureApiPageEntry() {
    try {
      var host = $('api-add-actions');
      if (!host || $('ib-setup-rerun')) return;
      var btn = el('button', 'btn', '重新运行设置向导');
      btn.type = 'button';
      btn.id = 'ib-setup-rerun';
      btn.onclick = function () { open({ manual: true }); };
      host.appendChild(btn);
    } catch (e) {}
  }

  /* ══ 启动判定 ════════════════════════════════════════════ */

  async function readDegraded() {
    try {
      if (typeof fetch !== 'function') return null;
      var res = await fetch('__boot-state', { headers: { Accept: 'application/json' } });
      if (!res || !res.ok) return null;
      var j = await res.json();
      var st = j && j.bootState;
      if (!st || st.degraded !== true) return null;
      var first = (st.degradedReasons || [])[0] || {};
      var component = String(first.component || '').toLowerCase();
      var text = '';
      try {
        if (window.IBERR && window.IBERR.model) {
          var m = window.IBERR.model('local_service', { component: component });
          text = m.title ? m.title + '：' + m.message : (m.message || '');
        }
      } catch (e) { text = ''; }
      if (!text) text = '部分本地增强功能暂时不可用。你仍然可以继续聊天。';
      return text;
    } catch (e) { return null; }
  }

  function waitForAppVisible(timeoutMs) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + (timeoutMs || 15000);
      (function tick() {
        var app = $('app');
        var splash = $('splash');
        var visible = !!(app && app.classList.contains('visible'));
        var splashGone = !splash || splash.classList.contains('hidden') || splash.classList.contains('dissolving');
        if (visible || splashGone || Date.now() > deadline) return resolve();
        setTimeout(tick, 120);
      })();
    });
  }

  function applyDraft(d) {
    if (!d || typeof d !== 'object') return;
    S.provider = String(d.provider || '');
    S.model = String(d.model || '');
    S.endpoint = String(d.endpoint || '');
    S.noKey = !!d.noKey;
    S.nickname = String(d.nickname || '');
    S.relationship = String(d.relationship || '');
    S.desc = String(d.desc || '');
    S.systemPrompt = String(d.systemPrompt || '');
    S.promptDirty = !!S.systemPrompt;
    S.step = Math.max(0, Math.min(TOTAL_STEPS - 1, Number(d.step) || 0));
    S.draftRestored = true;
    S.apiKey = '';                 /* 密钥永不从草稿恢复：安全优先，请用户重新输入 */
  }

  function hookWindow(name) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__ibSetupHooked) return;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      var run = function () { refreshChatEmptyState(); };
      if (r && typeof r.then === 'function') r.then(run, run);
      else run();
      return r;
    };
    wrapped.__ibSetupHooked = true;
    wrapped.__ibSetupOrig = orig;
    window[name] = wrapped;
  }

  async function boot() {
    if (S && S.booted) return;
    S = freshState();
    S.booted = true;
    injectStyles();
    if (!document.body) return;
    mount();
    S.degraded = await readDegraded();

    var rec = await readSetupRecord();
    var draft = await readDraft();
    var roles = 0;
    try {
      if (typeof window.loadApiConfigs === 'function') await window.loadApiConfigs();
      roles = (window.apiConfigs || []).length;
    } catch (e) { roles = (window.apiConfigs || []).length; }

    hookWindow('loadFriendsList');
    hookWindow('navTo');
    ensureApiPageEntry();
    refreshChatEmptyState();

    var d = decide(rec, draft, roles);
    if (d.reason === 'existing-user') {
      /* 老用户升级：静默标记完成，绝不弹向导 */
      await writeDone(false, { migrated: true });
      return;
    }
    if (!d.open) return;
    if (draft) applyDraft(draft);
    await waitForAppVisible(15000);
    if (S.open) return;
    open({ resume: !!draft });
  }

  /* ══ 导出 ════════════════════════════════════════════════ */

  var API = {
    open: open,
    close: function () { return closeWizard('close'); },
    skip: function () { return skipSetup(); },
    finish: function () { return finish(); },
    next: function () { return nextStep(); },
    back: function () { backStep(); },
    goStep: function (i) { goStep(i); },
    refreshChatEmptyState: refreshChatEmptyState,
    state: function () { return S; },
    boot: boot,
    /* 测试钩子（纯逻辑，不触碰 DOM / 网络） */
    __test: {
      STEPS: STEPS,
      TOTAL_STEPS: TOTAL_STEPS,
      PROVIDER_ORDER: PROVIDER_ORDER,
      DONE_KEY: DONE_KEY,
      DRAFT_KEY: DRAFT_KEY,
      TEST_CFG_ID: TEST_CFG_ID,
      STYLE_HREF: STYLE_HREF,
      composePrompt: composePrompt,
      draftPayload: draftPayload,
      decide: decide,
      testConfig: testConfig,
      validateStep: validateStep,
      roleNameTaken: roleNameTaken,
      providerName: providerName,
      defaultPrompt: defaultPrompt,
      applyDraft: function (d) { applyDraft(d); return S; },
      freshState: freshState,
      readSetupRecord: readSetupRecord,
      readDraft: readDraft,
      writeDone: writeDone,
      writeDraft: writeDraft,
      clearDraft: clearDraft,
      setState: function (patch) { S = Object.assign(freshState(), patch || {}); return S; }
    }
  };

  window.IBSetup = API;
  if (NS && typeof NS.expose === 'function') NS.expose('setup', API);

  /* ── 启动 ── */
  function start() {
    try {
      boot().catch(function (e) { console.warn('[IBSetup] 启动失败（不影响主界面）', e); });
    } catch (e) { console.warn('[IBSetup] 启动失败（不影响主界面）', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window.IB || (window.IB = {}));
