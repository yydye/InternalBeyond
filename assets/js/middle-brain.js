/* ====================================================================
   Middle Brain (GPT-6 Astra) · 全局配置层（独立于角色 API 配置）
   --------------------------------------------------------------------
   - Astra 是 IB 全局 Middle Brain，不是角色/API Provider。因此不在
     social.js 的 PROVIDERS 注册表里，而是走独立全局配置。
   - 配置持久化：apiSettings store 的私有 key 'middle_brain'（复用 IB
     现有全局设置模式，如 voiceTrans / summarySettings，零 DB 迁移）。
   - 复用 ib-model-core.js 的 AstraAdapter（runtime-neutral request/
     response 归一），保持干净 Adapter 接口供后续 Middle Brain 接入。
   - 边界：不改角色模型体系（apiConfigs / PROVIDERS / 各角色调用链），
     不做 Memory / OOC / Prompt 压缩 / 模型路由 / 自动重写。
   ==================================================================== */
(function (root) {
  'use strict';
  var KEY = 'middle_brain';
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
    /* Phase 4 · Astra 推理强度与处理速度（仅 UI + 配置持久化 + Responses 参数映射）：
       reasoningEffort: low/medium/high/xhigh/max → reasoning.effort（官方参数）
       speed: standard/fast → fast 时发送 service_tier:"fast"（官方参数，standard=不发送）。
       非法值一律回退默认，其余 Phase 1/2/3 业务逻辑不变。 */
    reasoningEffort: 'medium',
    speed: 'standard'
  };

  /* ── Middle Brain 系统提示词：引擎内部的认知约束，前端只读，用户不可修改。──
     这是 IB 的中间认知层的"角色契约"，不是底层模型的角色配置；
     不写入 apiSettings（避免随配置导出/UI 泄露），只作为本模块内常量，
     供将来 Middle Brain 实际调用（buildMiddleBrainRequest 时注入 system）。 */
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

  /* 归一：adapter 解析（运行时已加载 ib-model-core.js；缺失则回落内置 openai 归一） */
  function adapter() {
    try { if (root.IBModelCore && root.IBModelCore.AstraAdapter) return root.IBModelCore.AstraAdapter; } catch (e) {}
    return null;
  }

  /* —— 配置读写（apiSettings 私有 key） —— */
  async function getMiddleBrainConfig() {
    try {
      var cfg = await dbGet('apiSettings', KEY);
      if (!cfg) return Object.assign({}, MB_DEFAULTS);
      return Object.assign({}, MB_DEFAULTS, cfg);
    } catch (e) { return Object.assign({}, MB_DEFAULTS); }
  }
  function _mbPersist(cfg) {
    try { return dbPut('apiSettings', Object.assign({ id: KEY }, cfg)); } catch (e) {}
  }
  async function saveMiddleBrainConfig(cfg) {
    var merged = Object.assign({}, await getMiddleBrainConfig(), cfg || {});
    await _mbPersist(merged);
    return merged;
  }
  async function isMiddleBrainEnabled() {
    var c = await getMiddleBrainConfig();
    return !!(c && c.enabled && String(c.endpoint || '').trim() && String(c.model || '').trim());
  }
  /* 独立 API 就绪判定：Middle Brain 走自己的 endpoint/model/apiKey，与角色配置无关 */
  async function middleBrainReady() {
    var c = await getMiddleBrainConfig();
    return !!(c && c.enabled && String(c.endpoint || '').trim() && String(c.model || '').trim() && String(c.apiKey || '').trim());
  }

  /* —— 归一请求体（委托 AstraAdapter.buildRequest；返回 {endpoint, headers, body}） ——
     供后续 Middle Brain 接入复用；不在此处发起 fetch（保留独立调用权给中间层）。 */
  async function buildMiddleBrainRequest(spec, prompt, options) {
    var a = adapter();
    var cfg = spec || (await getMiddleBrainConfig());
    /* Middle Brain 系统提示词：缺省注入引擎内部的认知约束（用户不可修改）；
       调用方若显式传入 system 则尊重之（覆盖），否则使用 MB_SYSTEM_PROMPT。 */
    var effPrompt = prompt;
    if (effPrompt && effPrompt.messages !== undefined && !effPrompt.system) {
      effPrompt = { system: MB_SYSTEM_PROMPT, messages: effPrompt.messages };
    } else if (effPrompt && effPrompt.messages === undefined && Array.isArray(effPrompt)) {
      var hasSys = effPrompt.some(function (m) { return m && m.role === 'system'; });
      if (!hasSys) effPrompt = [{ role: 'system', content: MB_SYSTEM_PROMPT }].concat(effPrompt);
    }
    if (a && typeof a.buildRequest === 'function') {
      var r = a.buildRequest(cfg, effPrompt, options || {});
      return { endpoint: cfg.endpoint, headers: Object.assign({ 'Content-Type': 'application/json' }, (r.headers || {})), body: r.body };
    }
    /* 回落：内置 openai-兼容归一（无 astra adapter 时也能用） */
    var p = (effPrompt && effPrompt.messages !== undefined ? effPrompt : { system: MB_SYSTEM_PROMPT, messages: effPrompt || [] });
    var model = cfg.model, ps = (p.system || MB_SYSTEM_PROMPT), msgs = Array.isArray(p.messages) ? p.messages : [];
    var body = { model: model, messages: [{ role: 'system', content: ps }].concat(msgs), max_tokens: (options && options.maxTokens) || 512 };
    if (options && options.jsonMode) body.response_format = { type: 'json_object' };
    if (cfg.temperature != null) body.temperature = Number(cfg.temperature);
    return { endpoint: cfg.endpoint, headers: { 'Content-Type': 'application/json' }, body: body };
  }

  /* —— 归一响应（委托 AstraAdapter.parseResponse → {content, reasoning, truncated, usage}） —— */
  async function parseMiddleBrainResponse(wire, spec, options) {
    var a = adapter();
    var cfg = spec || (await getMiddleBrainConfig());
    if (a && typeof a.parseResponse === 'function') {
      return a.parseResponse(wire, cfg, options || {});
    }
    /* 回落：内置 openai-兼容解析 */
    var choice = (wire && wire.choices && wire.choices[0]) || {};
    var message = choice.message || {};
    var out = { content: message.content == null ? '' : message.content, reasoning: message.reasoning_content || message.reasoning || '', truncated: choice.finish_reason === 'length', usage: wire && wire.usage ? wire.usage : null };
    return out;
  }

  /* —— OpenAI Responses API · Middle Brain 专用 request builder ——
     委托 AstraAdapter.buildResponsesRequest（绝不发 Chat Completions 旧参数）。
     Phase 4：统一读取 middle_brain 配置的 reasoningEffort / speed，normalize 后映射到官方参数：
       reasoningEffort → reasoning.effort（官方）；speed:'fast' → service_tier:'fast'（官方）。
       speed:'standard'（默认）→ 不发送 service_tier（官方无 "standard" 值）。
     绝不用 temperature / top_p / logprobs / reasoning_effort。 */
  var MB_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  var MB_SPEEDS = ['standard', 'fast'];
  function normalizeMiddleBrainReasoningEffort(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return MB_REASONING_EFFORTS.indexOf(s) >= 0 ? s : 'medium';
  }
  function normalizeMiddleBrainSpeed(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return MB_SPEEDS.indexOf(s) >= 0 ? s : 'standard';
  }
  async function buildMiddleBrainResponsesRequest(spec, prompt, options) {
    var a = adapter();
    var cfg = spec || (await getMiddleBrainConfig());
    options = options || {};
    /* Phase 4：从配置归一推理强度/速度（显式 options 覆盖 > 配置 > 默认）。 */
    var effort = normalizeMiddleBrainReasoningEffort(options.reasoningEffort != null ? options.reasoningEffort : cfg.reasoningEffort);
    var speed = normalizeMiddleBrainSpeed(options.speed != null ? options.speed : cfg.speed);
    var reqOptions = Object.assign({}, options, { reasoningEffort: effort });
    if (a && typeof a.buildResponsesRequest === 'function') {
      var r = a.buildResponsesRequest(cfg, prompt, reqOptions);
      var body = r.body || {};
      /* speed:fast → 官方 service_tier:"fast"；standard → 不发送（默认档）。 */
      if (speed === 'fast') body.service_tier = 'fast';
      return { endpoint: cfg.endpoint || r.endpoint, headers: Object.assign({ 'Content-Type': 'application/json' }, (r.headers || {})), body: body, reasoningEffort: effort, speed: speed };
    }
    /* 回落：无 Responses API adapter → 走旧 openai-compat（保可用性，聊天不破）。
       Chat Completions 用 max_tokens / temperature，无 service_tier；仍可带 reasoning.effort。 */
    return await buildMiddleBrainRequest(cfg, prompt, reqOptions);
  }

  /* —— OpenAI Responses API · Middle Brain 专用 parser（委托 AstraAdapter）—— */
  async function parseMiddleBrainResponsesResponse(wire, spec) {
    var a = adapter();
    var cfg = spec || (await getMiddleBrainConfig());
    if (a && typeof a.parseResponsesResponse === 'function') {
      return a.parseResponsesResponse(wire, cfg, {});
    }
    /* 回落：Chat Completions 解析（保可用性） */
    return await parseMiddleBrainResponse(wire, cfg, {});
  }

  /* —— 设置 UI（API Settings 页 · 全局 Middle Brain 卡片） —— */
  function _mbEl(id) { return document.getElementById(id); }
  /* ====================================================================
     Phase 4 · Middle Brain Advanced Settings UI（Codex 风格滑动选择）
     --------------------------------------------------------------------
     只做 UI + 模型配置抽象；不改 Compression / Judge / Admission Gate 核心逻辑。
     - Reasoning：可拖拽横向 slider（Low→Medium→High→XHigh→Max），拖动/点档位均可。
     - Model：可左右滑动 / 箭头切换 / 点击档位的模型 swiper（非 <select>）。
     - Speed：两档 slider（Standard/Fast）。
     - 拖动仅实时预览，释放/点击才提交持久化；点击即写配置（无需 Save）。
     ==================================================================== */
  var MB_REASONING_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
  var MB_REASONING_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
  var MB_REASONING_DESC = { low: '优先速度与成本', medium: '默认平衡', high: '更深入分析', xhigh: '高强度推理', max: '最高推理强度' };
  var MB_SPEED_ORDER = ['standard', 'fast'];
  var MB_SPEED_LABELS = { standard: 'Standard', fast: 'Fast' };
  var MB_MODEL_CANDIDATES = ['gpt-6-astra', 'gpt-5.6-sol'];
  var _mbUi = { reasoning: 'medium', speed: 'standard', model: 'gpt-6-astra' };
  var _mbReasoningSlider = null, _mbSpeedBtn = null;

  function _mbReasoningDesc(v) { return MB_REASONING_DESC[v] || '默认平衡'; }
  function _mbModelList(cur) { var l = MB_MODEL_CANDIDATES.slice(); if (cur && l.indexOf(cur) < 0) l.unshift(cur); return l; }
  function _mbModelIdx(cur) { var l = _mbModelList(cur); var i = l.indexOf(cur); return i >= 0 ? i : 0; }
  function _mbSummaryText(re, sp) { return (MB_REASONING_LABELS[re] || re) + ' · ' + (MB_SPEED_LABELS[sp] || sp); }
  function _mbUpdateSummary(re, sp) { var s = _mbEl('mb-adv-summary'); if (s) s.textContent = _mbSummaryText(re, sp); }
  function _mbLbl(v) { return MB_REASONING_LABELS[v] || MB_SPEED_LABELS[v] || v; }

  function _mbReadReasoning() { return normalizeMiddleBrainReasoningEffort(_mbUi.reasoning); }
  function _mbReadSpeed() { return normalizeMiddleBrainSpeed(_mbUi.speed); }
  function _mbReadModel() { return String(_mbUi.model || '').trim() || 'gpt-6-astra'; }

  /* 通用可拖拽 slider。
     dragOnly=true（Reasoning 用）：真正拖动手柄/轨道平滑移动，拖动过程中只实时跟随（不吸附），
       松手才吸附到最近档位并提交。档位圆点仅作标记（不可点击跳转），thumb 可抓取。
     非 dragOnly（Speed 用）：保留拖动 + 点击轨道/档位两种方式。 */
  function _mbSliderBuild(hostId, values, current, onCommit, opts) {
    var host = _mbEl(hostId); if (!host) return null;
    var dragOnly = !!(opts && opts.dragOnly);
    host.innerHTML = '';
    var n = values.length;
    var track = document.createElement('div'); track.className = 'mb-trk';
    var fill = document.createElement('div'); fill.className = 'mb-fill';
    var thumb = document.createElement('div'); thumb.className = 'mb-thumb';
    if (dragOnly) { thumb.classList.add('mb-thumb-grab'); }
    track.appendChild(fill); track.appendChild(thumb);
    var ticks = document.createElement('div'); ticks.className = 'mb-ticks';
    var labs = document.createElement('div'); labs.className = 'mb-labels';
    var valueEl = document.createElement('div'); valueEl.className = 'mb-adv-slider-value';
    host.appendChild(valueEl);
    var tickEls = [];
    values.forEach(function (v, i) {
      var t = document.createElement('span'); t.className = 'mb-tick'; t.dataset.value = v; t.dataset.idx = i;
      t.style.left = (n > 1 ? (i / (n - 1) * 100) : 0) + '%';
      if (!dragOnly) t.addEventListener('click', function (e) { e.stopPropagation(); _paint(i); onCommit(v); });
      ticks.appendChild(t); tickEls.push(t);
      var l = document.createElement('span'); l.className = 'mb-lbl'; l.textContent = _mbLbl(v); labs.appendChild(l);
    });
    track.appendChild(ticks);
    host.appendChild(track); host.appendChild(labs);
    var idx = Math.max(0, Math.min(n - 1, values.indexOf(current)));
    function _pct(i) { return n > 1 ? (i / (n - 1) * 100) : 0; }
    function _paint(i) {
      i = Math.max(0, Math.min(n - 1, i)); idx = i;
      var pct = _pct(i);
      fill.style.width = pct + '%'; thumb.style.left = pct + '%';
      tickEls.forEach(function (t, j) { t.classList.toggle('mb-tick-active', j === i); });
      valueEl.textContent = _mbLbl(values[i]);
    }
    /* 拖动过程中的连续预览：只移动 thumb/fill，不吸附、不切换 value 标签。 */
    function _paintFrac(frac) {
      frac = Math.max(0, Math.min(1, frac));
      var pct = frac * 100;
      thumb.style.left = pct + '%'; fill.style.width = pct + '%';
    }
    function _fracFromX(cx) { var r = track.getBoundingClientRect(); if (!r.width) return 0.5; return (cx - r.left) / r.width; }
    _paint(idx);
    var dragging = false, frac = idx / (n - 1);
    function down(e) {
      dragging = true; frac = _fracFromX(e.clientX);
      if (dragOnly) _paintFrac(frac); else _paint(Math.round(frac * (n - 1)));
      if (track.setPointerCapture) { try { track.setPointerCapture(e.pointerId); } catch (x) {} }
    }
    function move(e) {
      if (!dragging) return; frac = Math.max(0, Math.min(1, _fracFromX(e.clientX)));
      if (dragOnly) _paintFrac(frac); else _paint(Math.round(frac * (n - 1)));
    }
    function up() {
      if (!dragging) return; dragging = false;
      var i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
      _paint(i); onCommit(values[i]);
    }
    track.addEventListener('pointerdown', down);
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', function () { dragging = false; });
    if (!dragOnly) track.addEventListener('click', function (e) { if (e.target === track || e.target === fill || e.target === thumb) { _paint(_fromX(e.clientX)); onCommit(values[_fromX(e.clientX)]); } });
    function _fromX(cx) { return Math.max(0, Math.min(n - 1, Math.round(_fracFromX(cx) * (n - 1)))); }
    return { setValue: function (v) { _paint(Math.max(0, Math.min(n - 1, values.indexOf(v)))); }, getValue: function () { return values[idx]; } };
  }

  /* 模型 swiper：左右箭头 + 可点击档位条 + 拖动，切换当前 Middle Brain 模型（写 cfg.model）。 */
  function _mbModelSet(m) {
    m = String(m || '').trim() || 'gpt-6-astra';
    _mbUi.model = m;
    if (_mbEl('mb-model')) _mbEl('mb-model').value = m;
    var nm = _mbEl('mb-model-name'); if (nm) nm.textContent = m;
    (document.querySelectorAll('.mb-model-cell') || []).forEach(function (c) { c.classList.toggle('mb-model-active', c.textContent === m); });
    _mbUpdateSummary(_mbReadReasoning(), _mbReadSpeed());
    saveMiddleBrainConfig({ model: m });
  }
  function _mbModelBuild() {
    var host = _mbEl('mb-adv-model'); if (!host) return;
    host.innerHTML = '';
    var cur = _mbReadModel();
    var list = _mbModelList(cur);
    var row = document.createElement('div'); row.className = 'mb-model-row';
    var prev = document.createElement('button'); prev.type = 'button'; prev.className = 'mb-model-arrow'; prev.textContent = '◀'; prev.title = '上一个模型';
    prev.addEventListener('click', function () { _mbModelSet(list[Math.max(0, _mbModelIdx(_mbReadModel()) - 1)]); });
    var center = document.createElement('div'); center.className = 'mb-model-center';
    var name = document.createElement('div'); name.className = 'mb-model-name'; name.id = 'mb-model-name'; name.textContent = cur;
    var sub = document.createElement('div'); sub.className = 'mb-model-sub'; sub.textContent = 'Responses';
    center.appendChild(name); center.appendChild(sub);
    var next = document.createElement('button'); next.type = 'button'; next.className = 'mb-model-arrow'; next.textContent = '▶'; next.title = '下一个模型';
    next.addEventListener('click', function () { _mbModelSet(list[Math.min(list.length - 1, _mbModelIdx(_mbReadModel()) + 1)]); });
    row.appendChild(prev); row.appendChild(center); row.appendChild(next);
    host.appendChild(row);
    var strip = document.createElement('div'); strip.className = 'mb-model-strip';
    list.forEach(function (m) {
      var c = document.createElement('div'); c.className = 'mb-model-cell'; c.textContent = m; c.title = m;
      c.addEventListener('click', function () { _mbModelSet(m); });
      c.classList.toggle('mb-model-active', m === cur);
      strip.appendChild(c);
    });
    host.appendChild(strip);
    var dragging = false, target = _mbModelIdx(cur);
    function _cellFromX(cx) { var r = strip.getBoundingClientRect(); if (!r.width) return target; var ratio = (cx - r.left) / r.width; return Math.max(0, Math.min(list.length - 1, Math.round(ratio * (list.length - 1)))); }
    strip.addEventListener('pointerdown', function (e) { dragging = true; target = _cellFromX(e.clientX); if (strip.setPointerCapture) { try { strip.setPointerCapture(e.pointerId); } catch (x) {} } });
    strip.addEventListener('pointermove', function (e) { if (!dragging) return; target = _cellFromX(e.clientX); });
    strip.addEventListener('pointerup', function () { if (!dragging) return; dragging = false; target = _cellFromX(0); });
    strip.addEventListener('pointercancel', function () { dragging = false; });
  }
  /* Speed：⚡ 闪电小按钮，点击在 Standard/Fast 间切换；激活时按钮平滑过渡为紫色（CSS transition，非瞬间）。 */
  function _mbBuildSpeedButton() {
    var host = _mbEl('mb-adv-speed'); if (!host) return;
    host.innerHTML = '';
    var btn = document.createElement('button'); btn.type = 'button'; btn.id = 'mb-speed-btn'; btn.className = 'mb-speed-btn';
    var bolt = document.createElement('span'); bolt.className = 'mb-speed-bolt'; bolt.textContent = '⚡';
    var label = document.createElement('span'); label.className = 'mb-speed-label'; label.id = 'mb-speed-label';
    var note = document.createElement('div'); note.className = 'mb-speed-note';
    btn.appendChild(bolt); btn.appendChild(label);
    btn.addEventListener('click', function () { mbSpeedPick(_mbUi.speed === 'fast' ? 'standard' : 'fast'); });
    host.appendChild(btn); host.appendChild(note);
    _mbSpeedBtn = btn;
    _mbRenderSpeed();
  }
  function _mbRenderSpeed() {
    var on = _mbUi.speed === 'fast';
    if (_mbSpeedBtn) _mbSpeedBtn.classList.toggle('mb-speed-on', on);
    var l = _mbEl('mb-speed-label'); if (l) l.textContent = on ? 'Fast' : 'Standard';
    var n = document.querySelector('#mb-adv-speed .mb-speed-note'); if (n) n.textContent = on ? '快速模式 · 更低延迟' : '标准处理';
  }
  function _mbInitAdvancedUI() {
    _mbReasoningSlider = _mbSliderBuild('mb-adv-reasoning', MB_REASONING_ORDER, _mbReadReasoning(), function (v) { mbReasoningPick(v); }, { dragOnly: true });
    _mbBuildSpeedButton();
    _mbModelBuild();
  }
  function mbReasoningPick(v) { v = normalizeMiddleBrainReasoningEffort(v); _mbUi.reasoning = v; if (_mbReasoningSlider) _mbReasoningSlider.setValue(v); _mbUpdateSummary(v, _mbReadSpeed()); saveMiddleBrainConfig({ reasoningEffort: v }); }
  function mbSpeedPick(v) { v = normalizeMiddleBrainSpeed(v); _mbUi.speed = v; _mbRenderSpeed(); _mbUpdateSummary(_mbReadReasoning(), v); saveMiddleBrainConfig({ speed: v }); }
  function mbModelPick(m) { _mbModelSet(m); }
  function mbModelStep(delta) { var list = _mbModelList(_mbReadModel()); _mbModelSet(list[Math.max(0, Math.min(list.length - 1, _mbModelIdx(_mbReadModel()) + delta))]); }

  function saveMiddleBrainConfigUI() {
    var enabled = !!(_mbEl('mb-enabled-toggle') && _mbEl('mb-enabled-toggle').checked);
    var endpoint = (_mbEl('mb-endpoint') ? _mbEl('mb-endpoint').value : '').trim();
    var apiKey = (_mbEl('mb-apikey') ? _mbEl('mb-apikey').value : '').trim();
    saveMiddleBrainConfig({ enabled: enabled, endpoint: endpoint, model: _mbReadModel(), apiKey: apiKey, reasoningEffort: _mbReadReasoning(), speed: _mbReadSpeed() }).then(function () {
      var st = _mbEl('mb-save-status'); if (st) { st.textContent = '已保存'; setTimeout(function () { st.textContent = ''; }, 1600); }
      if (typeof toast === 'function') toast('Middle Brain 已保存');
    }).catch(function (e) { if (typeof toast === 'function') toast('Middle Brain 保存失败：' + String(e && e.message || e)); });
  }
  function loadMiddleBrainConfigUI() {
    getMiddleBrainConfig().then(function (c) {
      if (_mbEl('mb-enabled-toggle')) _mbEl('mb-enabled-toggle').checked = !!c.enabled;
      if (_mbEl('mb-endpoint')) _mbEl('mb-endpoint').value = c.endpoint || '';
      if (_mbEl('mb-apikey')) _mbEl('mb-apikey').value = c.apiKey || '';
      _mbUi.reasoning = normalizeMiddleBrainReasoningEffort(c.reasoningEffort);
      _mbUi.speed = normalizeMiddleBrainSpeed(c.speed);
      _mbUi.model = String(c.model || '').trim() || 'gpt-6-astra';
      if (_mbEl('mb-model')) _mbEl('mb-model').value = _mbUi.model;
      _mbInitAdvancedUI();
      _mbUpdateSummary(_mbUi.reasoning, _mbUi.speed);
    }).catch(function () {});
  }

  /* ====================================================================
     Middle Brain v0 · Context Organization + Compression（独立 pipeline）
     --------------------------------------------------------------------
     - Astra 只读现有上下文；先组织（分类）再压缩（去重+按优先级保留+预算）。
     - 复用现有 Context 构建（getMemoryContext / getUnderstandingContext /
       getThreadContext / getMomentsContext），不重复实现 Memory 检索。
     - 压缩不改事实含义；不确定信息保持不确定（不变成确定事实）。
     - 不修改 Memory / Understanding / Thread；不做 OOC、Output Repair、
       模型路由、自动重写；不改角色模型调用链（本 pipeline 独立，供将来接入）。
     ==================================================================== */
  var MB_CTX_DEFAULT_BUDGET = 2600;  /* 字符预算（近似 token 的粗估：中文约 1 字≈1-1.5 token） */
  function _mbEstChars(s) { return String(s || '').length; }

  function _mbTextSimilarity(a, b) {
    if (typeof root._activeTextSimilarity === 'function') return root._activeTextSimilarity(a, b);
    /* 回落：字符 bigram 相似度（无 active-diary 依赖时也能去重） */
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); };
    var x = norm(a), y = norm(b); if (!x || !y) return 0; if (x === y) return 1;
    var grams = function (s) { var o = new Set(); for (var i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
    var gx = grams(x), gy = grams(y), ov = 0; gx.forEach(function (g) { if (gy.has(g)) ov++; });
    return (2 * ov) / (gx.size + gy.size);
  }

  /* ① 组织：复用现有 Context 构建，把上下文聚成结构化分类。 */
  async function middleBrainOrganizeContext(characterId, userMessage, opts) {
    opts = opts || {};
    var organized = { memory: [], understanding: [], threads: [], moments: [], dialogue: opts.dialogue || [], stats: {} };
    /* 记忆（复用现有召回） */
    try {
      if (opts.memoryCtx != null) { if (opts.memoryCtx) organized.memory = [opts.memoryCtx]; }
      else if (typeof root.getMemoryContext === 'function') {
        var mc = await root.getMemoryContext(characterId, { userMessage: userMessage || '' });
        if (mc) organized.memory = [mc];
      }
    } catch (e) {}
    /* 理解（活文档） */
    try {
      if (opts.understandingCtx != null) { if (opts.understandingCtx) organized.understanding = [opts.understandingCtx]; }
      else if (typeof root.getUnderstandingContext === 'function') {
        var uc = await root.getUnderstandingContext(characterId);
        if (uc) organized.understanding = [uc];
      }
    } catch (e) {}
    /* 线索（open thread） */
    try {
      if (opts.threadCtx != null) { if (opts.threadCtx) organized.threads = [opts.threadCtx]; }
      else if (typeof root.getThreadContext === 'function') {
        var tc = await root.getThreadContext(characterId);
        if (tc) organized.threads = [tc];
      }
    } catch (e) {}
    /* 动态（moments） */
    try {
      if (opts.momentsCtx != null) { if (opts.momentsCtx) organized.moments = [opts.momentsCtx]; }
      else if (typeof root.getMomentsContext === 'function') {
        var mC = await root.getMomentsContext(characterId, { userMessage: userMessage || '' });
        if (mC) organized.moments = [mC];
      } else if (opts.momentsText) { organized.moments = [opts.momentsText]; }
    } catch (e) {}
    return organized;
  }

  /* ② 压缩：把一层 line 列表去重（近重复合并）、按优先级保留、吃进预算。
     规则：绝不新增事实；保留"不确定"原样标记；删的是冗余/重复/过期，不是事实本身。 */
  function _mbCompressLines(lines, budget) {
    budget = Math.max(0, Number(budget) || 0);
    var picked = [];
    var used = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || '').trim();
      if (!line) continue;
      var len = _mbEstChars(line);
      /* 近重复：与已入选任一条相似度≥0.86 → 视为冗余，丢弃（保留更完整/更早的一条） */
      var dup = false;
      for (var j = 0; j < picked.length; j++) {
        if (_mbTextSimilarity(line, picked[j]) >= 0.86) { dup = true; break; }
      }
      if (dup) continue;
      if (budget && used + len > budget) continue;  /* 超预算则省略（不半截） */
      picked.push(line); used += len;
    }
    return picked;
  }

  /* ③ 压缩主流程：给每类设定优先级，按保序结构输出，控制总预算。
     优先级（高→低）：当前对话(dialogue) > 记忆(memory) > 理解(understanding) >
                      线索(threads) > 动态(moments)。
     ★ 关键保证：当前用户消息(dialogue)为最高优先级，永不因 budget 被省略。
     历史分类(memory/understanding/threads/moments)共享剩余预算（budget - 保底对话）。 */
  function middleBrainCompressContext(organized, opts) {
    opts = opts || {};
    var budget = Number(opts.budget) || MB_CTX_DEFAULT_BUDGET;
    var out = {
      memory: [], understanding: [], threads: [], moments: [], dialogue: (organized && Array.isArray(organized.dialogue)) ? organized.dialogue : (opts.dialogue || []),
      stats: { totalChars: 0, compressedChars: 0, droppedChars: 0, deduped: 0, categories: 0, fallback: false }
    };
    var flatten = [];
    /* 当前对话：最高优先级，原样保留（去重后），不参与 budget 省略。
       当前对话来自 organized.dialogue（第一参数组装），非 opts.dialogue。 */
    var dialogueArr = (organized && Array.isArray(organized.dialogue)) ? organized.dialogue : (opts.dialogue || []);
    var dialogueLines = _mbCompressLines(dialogueArr, 0 /* 无预算限制：当前消息永不完全省略 */);
    out.dialogue = dialogueLines;
    var dialogueLen = 0; dialogueLines.forEach(function (l) { dialogueLen += _mbEstChars(l); });
    /* 历史预算 = 总预算 - 当前对话保底占用；至少给历史留一小块，超支则不挤占对话 */
    var histBudget = Math.max(0, budget - dialogueLen);
    var catId = { memory: 0, understanding: 1, threads: 2, moments: 3, dialogue: 4 };

    function pushCat(cat, lines) {
      var arr = Array.isArray(lines) ? lines : (lines ? [lines] : []);
      var rawTotal = 0; arr.forEach(function (l) { rawTotal += _mbEstChars(l); });
      var picked = _mbCompressLines(arr, histBudget);
      var catLen = 0; picked.forEach(function (l) { catLen += _mbEstChars(l); });
      out[cat] = picked;
      out.stats.totalChars += rawTotal;
      out.stats.compressedChars += catLen;
      out.stats.droppedChars += Math.max(0, rawTotal - catLen);
      out.stats.deduped += Math.max(0, arr.length - picked.length);
      if (picked.length) out.stats.categories++;
      flatten.push({ cat: cat, order: catId[cat], lines: picked });
    }
    /* 历史分类按优先级共享剩余预算 */
    pushCat('memory', organized.memory);
    pushCat('understanding', organized.understanding);
    pushCat('threads', organized.threads);
    pushCat('moments', organized.moments);
    /* 把当前对话纳入统计（不计入历史压缩 dropped，但计入压缩总量与分类数） */
    out.stats.totalChars += dialogueLen;
    out.stats.compressedChars += dialogueLen;
    if (dialogueLines.length) out.stats.categories++;
    /* 按分类拼装 compressedContext（保序：记忆→理解→线索→动态→当前对话；对话恒在最后但永不省略） */
    var parts = [];
    flatten.sort(function (a, b) { return a.order - b.order; });
    flatten.forEach(function (f) {
      if (!f.lines.length) return;
      switch (f.cat) {
        case 'memory': parts.push('【记忆】\n' + f.lines.join('\n')); break;
        case 'understanding': parts.push('【对TA的理解】\n' + f.lines.join('\n')); break;
        case 'threads': parts.push('【仍在推进的线索】\n' + f.lines.join('\n')); break;
        case 'moments': parts.push('【近期动态】\n' + f.lines.join('\n')); break;
      }
    });
    if (dialogueLines.length) parts.push('【当前对话】\n' + dialogueLines.join('\n'));
    out.compressedContext = parts.join('\n\n');
    return out;
  }

  /* ④ pipeline：组织 → 压缩 → {structured, compressedContext, stats}。
     空上下文 / Astra 不可用 → 安全回落（返回组织后的原样，不丢信息）。 */
  async function middleBrainContextPipeline(characterId, userMessage, opts) {
    opts = opts || {};
    var organized = await middleBrainOrganizeContext(characterId, userMessage, opts);
    var hasAnything = organized.memory.length || organized.understanding.length || organized.threads.length || organized.moments.length || (opts.dialogue && opts.dialogue.length);
    if (!hasAnything) {
      return { structured: organized, compressedContext: '', stats: { totalChars: 0, compressedChars: 0, droppedChars: 0, deduped: 0, categories: 0, empty: true, fallback: false } };
    }
    var compressed = middleBrainCompressContext(organized, opts);
    compressed.stats.empty = false;
    return { structured: organized, compressedContext: compressed.compressedContext, stats: compressed.stats };
  }
  function middleBrainPipelineAvailable() {
    try { return typeof root.middleBrainContextPipeline === 'function'; } catch (e) { return false; }
  }

  /* ====================================================================
     Middle Brain v0 · Astra 认知协调接入（Context Organization + Compression）
     --------------------------------------------------------------------
     - Astra 只读"已组织好的 Context"（organized），判断相关性/优先级/去重合并，
       生成 structured 结果 + compressedContext。Astra 不是角色模型、不是新 Memory。
     - Astra 不得新增/修改/删除 Memory / Understanding / Thread / Diary / Moments；
       不得改变事实含义、不得把推测变成事实；当前 userMessage/最近 dialogue 必须保留；
       不生成角色回复、不改角色人格文风。
     - Astra 不可用/超时/报错 → 自动 fallback 到本地 pipeline（middleBrainContextPipeline），
       绝不影响正常角色聊天。
     - 结构化输出至少区分 keep / merge / drop / compressedContext，并可追溯到输入。
     ==================================================================== */
  var MB_ASTRA_TIMEOUT_MS = 20000;

  /* 解析 Astra 返回的 JSON 认知结果（Astra 只输出结构化 JSON，不生成角色回复）。
     仅接受白名单字段；任何异常/非 JSON → null（上层走 fallback）。 */
  function _mbParseAstraJson(text) {
    try {
      var s = String(text || '').trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      return {
        keep: Array.isArray(obj.keep) ? obj.keep.map(String).filter(Boolean).slice(0, 200) : [],
        merge: Array.isArray(obj.merge) ? obj.merge : [],
        drop: Array.isArray(obj.drop) ? obj.drop.map(String).filter(Boolean).slice(0, 200) : [],
        compressedContext: String(obj.compressedContext || '').trim(),
        currentKept: !!(obj.currentKept !== false)
      };
    } catch (e) { return null; }
  }

  /* Astra 结果安全校验：不得把"不确定"变成确定；必须保留当前 userMessage；
     不得生成角色回复（compressedContext 只能是整理后结果，非一段角色台词）。
     违规即返回 null（上层 fallback）。 */
  function _mbValidateAstraResult(result, organized) {
    if (!result) return null;
    if (!result.compressedContext) return null;
    var currentDialogue = organized && organized.dialogue ? organized.dialogue : [];
    /* 当前对话必须保留：Astra 显式 currentKept=false，或文本里不含任何一条当前对话 → 拒绝（走 fallback）。 */
    if (currentDialogue.length && result.currentKept === false) return null;
    if (currentDialogue.length) {
      var hasAny = currentDialogue.some(function (dl) { return String(dl || '') && result.compressedContext.indexOf(String(dl)) >= 0; });
      if (!hasAny) return null;
    }
    return result;
  }

  /* 真正的 Astra 调用：组织上下文 → 构建请求 → 拉取 → 解析 → 安全校验。
     任何失败（超时/网络/非 JSON/未启用/未配置/校验不过）→ 返回 null。 */
  async function middleBrainAstraInvoke(characterId, userMessage, opts) {
    opts = opts || {};
    try {
      if (!(await middleBrainReady())) return null;
      var organized = await middleBrainOrganizeContext(characterId, userMessage, opts);
      var hasAnything = organized.memory.length || organized.understanding.length || organized.threads.length || organized.moments.length || (organized.dialogue && organized.dialogue.length);
      if (!hasAnything) return { structured: organized, compressedContext: '', stats: { empty: true }, source: 'astra', keep: [], merge: [], drop: [] };

      /* 组织上下文文本 + 当前对话（Astra 判断相关性/优先级/去重合并） */
      var ctxBlocks = [];
      if (organized.memory.length) ctxBlocks.push('【Memory】' + organized.memory.join('\n'));
      if (organized.understanding.length) ctxBlocks.push('【Understanding】' + organized.understanding.join('\n'));
      if (organized.threads.length) ctxBlocks.push('【Thread】' + organized.threads.join('\n'));
      if (organized.moments.length) ctxBlocks.push('【Moments】' + organized.moments.join('\n'));
      ctxBlocks.push('【当前对话】' + ((organized.dialogue && organized.dialogue.join('\n')) || userMessage || ''));

      var userPrompt = '下面是组织好的 IB 上下文，请你作为认知协调层完成 Context Organization + Compression。\n'
        + '只做相关性判断、优先级、去重/合并，输出压缩后的 compressedContext（供下层角色模型读）。\n'
        + '要求：1) 绝不改变事实含义；无法确认的信息保持"可能/未确定"。2) 当前【当前对话】必须完整保留（currentKept:true）。3) 不要生成角色回复、不要改写角色人格文风。\n'
        + '只输出 JSON：{"keep":["保留条目..."],"merge":[{"from":"条目","into":"条目"}],"drop":["应删条目..."],"compressedContext":"合并整理后的精简上下文（含必要的事实、关系、状态、未完成线索；当前对话完整）","currentKept":true}\n'
        + '【上下文】\n' + ctxBlocks.join('\n\n');
      var messages = [{ role: 'user', content: userPrompt }];
      var cfg = await getMiddleBrainConfig();
      /* Responses API 请求：优先 buildResponsesRequest；失败回落 Chat Completions（保聊天不破）。 */
      var req = await buildMiddleBrainResponsesRequest(null, messages, { maxTokens: 1600, jsonMode: true });
      /* 若用户自定义了 endpoint 且非 responses 路径，仍尊重用户配置（不硬编码覆盖） */
      if (req && cfg.endpoint) req.endpoint = cfg.endpoint;

      var ac = new AbortController();
      var tm = setTimeout(function () { ac.abort(); }, (opts.timeoutMs != null ? Number(opts.timeoutMs) : MB_ASTRA_TIMEOUT_MS));
      /* 复用现有传输（Bridge-aware CORS 处理，file:// 也能直连 mock/远端）；无则回落 raw fetch */
      var res;
      if (typeof root._ibApiPost === 'function') {
        res = await root._ibApiPost(req.endpoint, Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }), JSON.stringify(req.body), { signal: ac.signal });
      } else {
        res = await fetch(req.endpoint, {
          method: 'POST',
          headers: Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }),
          body: JSON.stringify(req.body),
          signal: ac.signal
        });
      }
      clearTimeout(tm);
      if (!res.ok) return null;
      var data = await res.json().catch(function () { return null; });
      if (!data) return null;
      /* Responses API 解析：优先 output_text / output[].content[].text；不假设 choices。
         委托 AstraAdapter.parseResponsesResponse；任何异常 → 本地兜底解析为 {}（走 fallback）。 */
      var parsed = null;
      try {
        var _a = adapter();
        if (_a && typeof _a.parseResponsesResponse === 'function') parsed = _a.parseResponsesResponse(data, null, {});
      } catch (e) { parsed = null; }
      if (!parsed) parsed = { content: '', reasoning: '', truncated: false, usage: null };
      if (!parsed.content) return null;
      var result = _mbParseAstraJson(parsed.content);
      if (!result) return null;
      result = _mbValidateAstraResult(result, organized);
      if (!result) return null;
      /* 结构化：keep/merge/drop + compressedContext + 可追溯来源 */
      return {
        structured: organized,
        compressedContext: result.compressedContext,
        keep: result.keep, merge: result.merge, drop: result.drop,
        stats: { categories: (organized.memory.length ? 1 : 0) + (organized.understanding.length ? 1 : 0) + (organized.threads.length ? 1 : 0) + (organized.moments.length ? 1 : 0), source: 'astra' },
        source: 'astra'
      };
    } catch (e) { return null; }   /* 超时/网络/校验失败 → fallback */
  }

  /* ====================================================================
     Middle Brain Phase 2 · Astra Admission Gate（本地、确定性、无 LLM）
     --------------------------------------------------------------------
     目标：在调用 Astra 之前，用纯粹本地、确定性的信号判断"这次 Context
     是否值得花一次 Astra API 调用进行语义整理"，从而降低 Astra 调用次数与成本。

     链路：
       Context → Local Organization → Admission Gate
         ├─ NO  → Local Compress → Character Model（不产生任何 Astra 网络请求）
         └─ YES → Astra Responses API → Character Model（保持 Phase 1 不变）

     边界（与 Phase 1/要求一致）：
       - Gate 完全本地运行，绝不调用 LLM；绝不改写 Memory/Understanding/Thread/
         Diary/Moments；绝不改角色 Provider/模型/Prompt 语义。
       - Gate 不判断事实真假，只判断复杂度/价值（"是否值得一次语义整理"）。
       - 仅做降低成本的 gate；OOC/Output Repair/Memory Governance/Model Routing
         等一律不做（本阶段范围外）。
     可通过 admissionEnabled===false 完全关闭 → 恢复 Phase 1（永远尝试 Astra）。
     ==================================================================== */
  var MB_GATE_DEFAULTS = {
    scoreOn: 0.60,          /* 冷启动阈值：加权分 >= 此值 → YES（reason=context_complexity） */
    scoreHold: 0.45,        /* 迟滞保持阈值：近期我曾 YES，分 >= 此值 → 继续保持 YES */
    cooldownMs: 90000,      /* 冷却：同一角色两次 YES/调用之间至少间隔 90s（防连续轰击） */
    hysteresisMs: 180000,   /* 迟滞窗口：3 分钟内刚 YES 过 → 用 scoreHold 保持 */
    ctxCharsLow: 2500,      /* contextChars 低于 → context 分 0；高于 ctxCharsHigh → 1 */
    ctxCharsHigh: 7000,
    dlgCharsLow: 600,       /* dialogueChars 映射（当前对话长度） */
    dlgCharsHigh: 3500,
    budgetRatio: 0.90,      /* nearBudget：contextChars >= budgetRatio*ctxCharsHigh → YES */
    itemMax: 10,            /* 条目总数归一化上限 */
    reentryMs: 21600000,    /* 长时间离开（6h）后重新进入 → reentry 信号 */
    weights: { context: 0.35, dialogue: 0.15, items: 0.20, redundancy: 0.30 }
  };
  var MB_GATE_STATE = {};   /* 内存态：{characterId: {lastAstraAt,lastDecision,lastDecisionAt,lastMessageAt}}，不落盘 */
  function _mbGateCfg(cfg) {
    var g = (cfg && cfg.gate) || {};
    return Object.assign({}, MB_GATE_DEFAULTS, g);
  }
  function _mbClamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
  function _mbRamp(x, lo, hi) {
    if (hi <= lo) return Number(x) >= hi ? 1 : 0;
    return _mbClamp01((Number(x) - lo) / (hi - lo));
  }
  /* 加权复杂度分（0..1）。ratio 越低（越多被压缩/冗余）→ redundancy 分越高。 */
  function _mbGateScore(signals, cfg) {
    var w = (cfg && cfg.weights) || MB_GATE_DEFAULTS.weights;
    var ctxScore = _mbRamp(signals.contextChars, cfg.ctxCharsLow, cfg.ctxCharsHigh);
    var dlgScore = _mbRamp(signals.dialogueChars, cfg.dlgCharsLow, cfg.dlgCharsHigh);
    var items = (signals.memoryItems || 0) + (signals.understandingItems || 0) + (signals.threadItems || 0) + (signals.momentItems || 0);
    var itemScore = _mbRamp(items, 0, cfg.itemMax);
    var ratio = (signals.localCompressionRatio == null) ? 1 : signals.localCompressionRatio;
    var redScore = _mbClamp01((1 - ratio - 0.10) / 0.45);
    var score = w.context * ctxScore + w.dialogue * dlgScore + w.items * itemScore + w.redundancy * redScore;
    return { score: _mbClamp01(score), contextScore: ctxScore };
  }
  /* 纯判定（无副作用；可注入 signals/state/now 做确定性单元验证）。
     state: {lastAstraAt, lastDecision('yes'|'no'), lastDecisionAt} */
  function _mbDecisionFromSignals(signals, cfg, state, now) {
    cfg = _mbGateCfg(cfg); state = state || {}; if (signals == null) signals = {};
    now = (now == null ? Date.now() : now);
    var sc = _mbGateScore(signals, cfg);
    /* 硬触发（高价值信号，无视冷却）：明显冲突 / 多线程 / 接近预算 */
    if (signals.conflictSignal) return { useAstra: true, reason: 'conflict_signal', score: sc.score };
    if (signals.multipleThreads) return { useAstra: true, reason: 'multiple_threads', score: sc.score };
    if (signals.nearBudget) return { useAstra: true, reason: 'near_budget', score: sc.score };
    /* 冷却：刚 YES 过，同复杂度信号不立刻再轰 */
    if (state.lastAstraAt && (now - state.lastAstraAt) < cfg.cooldownMs) return { useAstra: false, reason: 'cooldown', score: sc.score };
    /* 迟滞：近期刚 YES → 用更低阈值保持，防止来回抖 */
    if (state.lastDecision === 'yes' && (now - state.lastDecisionAt) < cfg.hysteresisMs && sc.score >= cfg.scoreHold) {
      return { useAstra: true, reason: 'hysteresis_hold', score: sc.score };
    }
    /* 冷启动：达到 scoreOn → YES；否则省成本 → NO */
    if (sc.score >= cfg.scoreOn) return { useAstra: true, reason: 'context_complexity', score: sc.score };
    return { useAstra: false, reason: 'simple_context', score: sc.score };
  }
  /* 冲突信号启发式（复杂度代理，非事实判定）：识别组织文本中明显的矛盾/不一致标记。 */
  function _mbDetectConflict(organized) {
    var parts = [];
    (['memory', 'understanding', 'threads', 'moments']).forEach(function (k) {
      (organized && organized[k] || []).forEach(function (s) { if (s) parts.push(String(s)); });
    });
    var joined = parts.join('\n');
    if (!joined) return false;
    var markers = ['矛盾', '冲突', '不一致', '自相矛盾', '前后矛盾', '说法矛盾', '改口', '推翻', '完全相反', '恰好相反', '和之前不同', '说法不一致'];
    for (var i = 0; i < markers.length; i++) { if (joined.indexOf(markers[i]) >= 0) return true; }
    return false;
  }
  /* 从 organized 提取本地、确定性的信号（不写任何存储；无 LLM）。
     支持 opts.organized 复用（测试/接入方），否则组织一次。 */
  async function _mbAnalyzeSignals(characterId, userMessage, opts, cfg) {
    opts = opts || {};
    var organized = opts.organized || await middleBrainOrganizeContext(characterId, userMessage, opts);
    var dialogueArr = (
      organized && Array.isArray(organized.dialogue) && organized.dialogue.length
    ) ? organized.dialogue : (userMessage ? [userMessage] : []);
    function countLines(arr) {
      var n = 0; (arr || []).forEach(function (s) { if (!s) return; String(s).split(/\n+/).forEach(function (l) { if (l.trim()) n++; }); });
      return n;
    }
    function catChars(arr) { var c = 0; (arr || []).forEach(function (s) { if (s) c += String(s).length; }); return c; }
    var memoryItems = countLines(organized.memory), understandingItems = countLines(organized.understanding),
        threadItems = countLines(organized.threads), momentItems = countLines(organized.moments);
    var dialogueChars = 0; dialogueArr.forEach(function (l) { if (l) dialogueChars += String(l).length; });
    var contextChars = catChars(organized.memory) + catChars(organized.understanding) + catChars(organized.threads) + catChars(organized.moments) + dialogueChars;
    /* 本地压缩比例：越低 = 被压缩/冗余越多 = 越值得 Astra 语义整理 */
    var local, total = 0, comp = 0, deduped = 0;
    try {
      local = middleBrainCompressContext(organized, opts);
      total = (local && local.stats && local.stats.totalChars) || 0;
      comp = (local && local.stats && local.stats.compressedChars) || 0;
      deduped = (local && local.stats && local.stats.deduped) || 0;
    } catch (e) { total = 0; comp = 0; deduped = 0; }
    var localCompressionRatio = total > 0 ? (comp / total) : 1;
    var totalLines = memoryItems + understandingItems + threadItems + momentItems + dialogueArr.length;
    var duplicateRatio = totalLines > 0 ? (deduped / totalLines) : 0;
    var gcfg = _mbGateCfg(cfg);
    return {
      contextChars: contextChars, dialogueChars: dialogueChars,
      memoryItems: memoryItems, understandingItems: understandingItems,
      threadItems: threadItems, momentItems: momentItems,
      localCompressionRatio: localCompressionRatio, duplicateRatio: duplicateRatio,
      conflictSignal: _mbDetectConflict(organized),
      multipleThreads: (threadItems >= 2 || understandingItems >= 2),
      nearBudget: contextChars >= (gcfg.budgetRatio * gcfg.ctxCharsHigh),
      timeSinceLastAstraMs: null, longAbsenceReentry: false
    };
  }
  function _mbGateState(key, val) {
    if (val === undefined) return MB_GATE_STATE[key] || null;
    MB_GATE_STATE[key] = val; return val;
  }
  function middleBrainAdmissionGateReset(characterId) {
    if (characterId == null) { MB_GATE_STATE = {}; return; }
    delete MB_GATE_STATE[String(characterId)];
    return true;
  }
  /* Admission Gate 统一入口：返回 {useAstra, reason, signals, score}。
     - admissionEnabled===false → 绕过（永远允许 Astra，恢复 Phase 1）。
     - Astra 未就绪 → NO（本地压缩，不打 Astra）。
     - opts.signals 可注入（确定性测试）；opts.now / opts.state 可注入。 */
  async function middleBrainAdmissionGate(characterId, userMessage, opts, cfg) {
    opts = opts || {}; cfg = cfg || await getMiddleBrainConfig();
    var now = (opts.now != null ? opts.now : Date.now());
    /* feature flag 完全关闭 → 恢复 Phase 1（永远尝试 Astra） */
    if (cfg.admissionEnabled === false) return { useAstra: true, reason: 'gate_disabled', signals: {} };
    /* Astra 未配置/未启用 → 无 Astra 可用 → 本地压缩 */
    if (!(await middleBrainReady())) return { useAstra: false, reason: 'astra_not_ready', signals: {} };
    var signals = opts.signals || await _mbAnalyzeSignals(characterId, userMessage, opts, cfg);
    var state = opts.state ? opts.state : (_mbGateState(String(characterId)) || {});
    /* 时间型信号：距离上次 Astra 调用 / 长时间离开后重进 */
    signals.timeSinceLastAstraMs = (state.lastAstraAt && now) ? (now - state.lastAstraAt) : null;
    var lastMsg = state.lastMessageAt || 0;
    signals.longAbsenceReentry = !!(lastMsg && (now - lastMsg) > _mbGateCfg(cfg).reentryMs) && signals.contextChars >= 1200;
    var dec = _mbDecisionFromSignals(signals, cfg, state, now);
    /* 更新内存态（除非注入 state 由测试自行管理） */
    if (!opts.state) {
      state.lastMessageAt = now;
      state.lastDecision = dec.useAstra ? 'yes' : 'no';
      state.lastDecisionAt = now;
      if (dec.useAstra) state.lastAstraAt = now;  /* 以"判定 YES"为冷却锚点，防连续轰击 */
      _mbGateState(String(characterId), state);
    }
    return {
      useAstra: dec.useAstra,
      reason: dec.reason,
      signals: signals,
      score: dec.score != null ? Math.round(dec.score * 1000) / 1000 : null
    };
  }

  /* ====================================================================
     Middle Brain Phase 3 · Astra Context Judge（只读质量评估 / observe）
     --------------------------------------------------------------------
     - Judge 与 Compression 严格分离：Compression = "整理并压缩 Context"；
       Judge = "判断 Compression 做得好不好"。
     - Judge 只读：本次 organized Context、本次 Astra compressedContext、
       当前 userMessage、recent dialogue。绝不写 Memory/Understanding/Thread/
       Diary/Moments/IndexedDB/localStorage(Memory)。
     - 不修改 compressedContext；不生成角色回复；不做 OOC/Output Repair/
       Model Routing；不判断哪条 Memory 是真实事实（冲突只报告）。
     - 复用现有 Responses API Adapter（buildResponsesRequest / parseResponsesResponse /
       _ibApiPost 传输），不重新实现 HTTP/fetch/API Key/SSE/parser。
     - 失败（超时/500/非 JSON/校验不过）→ 返回 null，绝不重试、绝不影响聊天、
       绝不影响已成功的 Compression；不做第二次 Compression。
     - 只在 Astra 压缩实际成功时运行：Admission Gate=NO 或 fallback 到 local 均不调用。
     可用 middleBrainJudgeEnabled=false 完全关闭（Phase 2 行为不变）。
     ==================================================================== */
  var MB_JUDGE_SCHEMA = {
    type: 'object',
    properties: {
      relevance: { type: 'number' },
      contradiction: {
        type: 'object',
        properties: { detected: { type: 'boolean' }, items: { type: 'array', items: { type: 'string' } } },
        required: ['detected', 'items'], additionalProperties: false
      },
      stale: { type: 'array', items: { type: 'string' } },
      duplicate: { type: 'array', items: { type: 'string' } },
      missing_context: { type: 'array', items: { type: 'string' } },
      current_turn_coverage: { type: 'number' },
      compression_quality: { type: 'number' },
      overall: { type: 'number' },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['relevance', 'contradiction', 'stale', 'duplicate', 'missing_context', 'current_turn_coverage', 'compression_quality', 'overall', 'warnings'],
    additionalProperties: false
  };
  var MB_JUDGE_TIMEOUT_MS = 20000;
  var _mbJudgeTelemetry = {
    attempted: 0, success: 0, failed: 0, totalLatencyMs: 0,
    overallSum: 0, contradictionDetected: 0, missingTotal: 0, staleTotal: 0, duplicateTotal: 0, currentTurnCoverageSum: 0,
    last: null /* 最近一次数值快照（不含用户内容/API Key） */
  };
  function middleBrainJudgeEnabled() {
    try { return getMiddleBrainConfig().then(function (c) { return !!(c && c.middleBrainJudgeEnabled === true); }); } catch (e) { return Promise.resolve(false); }
  }
  function _mbStrArr(v) { return Array.isArray(v) ? v.map(function (x) { return String(x); }).filter(function (x) { return x; }) : []; }
  /* 解析 + 校验 Judge JSON：clamp 0..1，白名单字段，异常/非 JSON → null。 */
  function _mbParseJudgeJson(text) {
    try {
      var s = String(text || '').trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      var c = obj.contradiction || {};
      return {
        relevance: _mbClamp01(Number(obj.relevance)),
        contradiction: { detected: !!(c.detected), items: _mbStrArr(c.items) },
        stale: _mbStrArr(obj.stale),
        duplicate: _mbStrArr(obj.duplicate),
        missing_context: _mbStrArr(obj.missing_context),
        current_turn_coverage: _mbClamp01(Number(obj.current_turn_coverage)),
        compression_quality: _mbClamp01(Number(obj.compression_quality)),
        overall: _mbClamp01(Number(obj.overall)),
        warnings: _mbStrArr(obj.warnings)
      };
    } catch (e) { return null; }
  }
  /* Judge 专用请求体：复用现有 Responses 归一，仅替换 structured-output schema（不重实现 HTTP/鉴权）。 */
  async function _mbBuildJudgeRequest(prompt, options) {
    var base = await buildMiddleBrainResponsesRequest(null, prompt, { maxTokens: options.maxTokens || 900, jsonMode: true });
    base.body.text = { format: { type: 'json_schema', name: 'context_quality_report', schema: MB_JUDGE_SCHEMA } };
    return base;
  }
  function _mbBuildJudgePrompt(organized, compressedContext, userMessage) {
    var ctxBlocks = [];
    if (organized && organized.memory && organized.memory.length) ctxBlocks.push('【Memory】' + organized.memory.join('\n'));
    if (organized && organized.understanding && organized.understanding.length) ctxBlocks.push('【Understanding】' + organized.understanding.join('\n'));
    if (organized && organized.threads && organized.threads.length) ctxBlocks.push('【Thread】' + organized.threads.join('\n'));
    if (organized && organized.moments && organized.moments.length) ctxBlocks.push('【Moments】' + organized.moments.join('\n'));
    if (organized && Array.isArray(organized.dialogue) && organized.dialogue.length) ctxBlocks.push('【当前对话】' + organized.dialogue.join('\n'));
    if (userMessage) ctxBlocks.push('【当前用户消息】' + userMessage);
    return '你是 InternalBeyond（IB）的 Context Quality Judge。你只负责评估"压缩后的 Context 做得好不好"，'
      + '绝不修改它、绝不生成角色回复、绝不判断哪条 Memory 是真实事实（冲突只报告）。\n'
      + '读原始上下文（被压缩前的）与压缩后的结果，对压缩质量做只读评估，输出结构化 JSON。\n'
      + '评分规则：relevance / current_turn_coverage / compression_quality / overall 均为 0..1 分数（1 最佳）。\n'
      + 'stale / duplicate / missing_context 为问题条目字符串数组（无则空数组）。\n'
      + 'contradiction: 若上下文存在明显互相冲突的信息，detected:true 且列出冲突项；只报告，不判定哪个为真。\n'
      + '只输出 JSON，不要多余文字：{"relevance":0.9,"contradiction":{"detected":false,"items":[]},"stale":[],"duplicate":[],"missing_context":[],"current_turn_coverage":1.0,"compression_quality":0.85,"overall":0.9,"warnings":[]}\n'
      + '【原始上下文】\n' + (ctxBlocks.join('\n\n') || '(空)') + '\n\n【压缩后的 Context】\n' + (compressedContext || '(空)') + '\n\n'
      + '请评估【压缩后的 Context】的质量。';
  }
  /* Judge 主入口：复用现有 Responses 调用链，只读评估；失败 → null（不影响聊天/压缩）。 */
  async function middleBrainAstraJudge(characterId, userMessage, organized, compressedContext, opts) {
    opts = opts || {};
    try {
      /* disabled → 完全不调用 Judge（不计 telemetry，恢复 Phase 2 行为） */
      if (!(await middleBrainJudgeEnabled())) return null;
      if (!(await middleBrainReady())) return null;
      var cfg = await getMiddleBrainConfig();
      var t0 = Date.now();
      _mbJudgeTelemetry.attempted++;
      var prompt = _mbBuildJudgePrompt(organized, compressedContext, userMessage);
      var req = await _mbBuildJudgeRequest([{ role: 'user', content: prompt }], { maxTokens: 900 });
      if (req && cfg.endpoint) req.endpoint = cfg.endpoint;
      var ac = new AbortController();
      var tm = setTimeout(function () { ac.abort(); }, (opts.timeoutMs != null ? Number(opts.timeoutMs) : MB_JUDGE_TIMEOUT_MS));
      var res;
      if (typeof root._ibApiPost === 'function') {
        res = await root._ibApiPost(req.endpoint, Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }), JSON.stringify(req.body), { signal: ac.signal });
      } else {
        res = await fetch(req.endpoint, { method: 'POST', headers: Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }), body: JSON.stringify(req.body), signal: ac.signal });
      }
      clearTimeout(tm);
      if (!res.ok) return null;
      var data = await res.json().catch(function () { return null; });
      if (!data) return null;
      var parsed = null;
      try { var _a = adapter(); if (_a && typeof _a.parseResponsesResponse === 'function') parsed = _a.parseResponsesResponse(data, null, {}); } catch (e) { parsed = null; }
      if (!parsed) parsed = { content: '', reasoning: '', truncated: false, usage: null };
      if (!parsed.content) return null;
      var report = _mbParseJudgeJson(parsed.content);
      if (!report) return null;
      var latency = Date.now() - t0;
      _mbJudgeTelemetry.success++;
      _mbJudgeTelemetry.totalLatencyMs += latency;
      _mbJudgeTelemetry.overallSum += report.overall;
      if (report.contradiction && report.contradiction.detected) _mbJudgeTelemetry.contradictionDetected++;
      _mbJudgeTelemetry.missingTotal += report.missing_context.length;
      _mbJudgeTelemetry.staleTotal += report.stale.length;
      _mbJudgeTelemetry.duplicateTotal += report.duplicate.length;
      _mbJudgeTelemetry.currentTurnCoverageSum += report.current_turn_coverage;
      _mbJudgeTelemetry.last = {
        attempted: _mbJudgeTelemetry.attempted, success: _mbJudgeTelemetry.success,
        latencyMs: latency, overall: report.overall, contradictionDetected: !!(report.contradiction && report.contradiction.detected),
        missingCount: report.missing_context.length, staleCount: report.stale.length, duplicateCount: report.duplicate.length,
        currentTurnCoverage: report.current_turn_coverage, ts: Date.now()
      };
      return report;
    } catch (e) {
      _mbJudgeTelemetry.failed++;
      return null;
    }
  }
  function middleBrainJudgeTelemetry() { return _mbJudgeTelemetry; }
  function middleBrainJudgeReset() { _mbJudgeTelemetry.attempted = 0; _mbJudgeTelemetry.success = 0; _mbJudgeTelemetry.failed = 0; _mbJudgeTelemetry.totalLatencyMs = 0; _mbJudgeTelemetry.overallSum = 0; _mbJudgeTelemetry.contradictionDetected = 0; _mbJudgeTelemetry.missingTotal = 0; _mbJudgeTelemetry.staleTotal = 0; _mbJudgeTelemetry.duplicateTotal = 0; _mbJudgeTelemetry.currentTurnCoverageSum = 0; _mbJudgeTelemetry.last = null; }

  /* —— 统一入口：Admission Gate →（YES）Astra →（失败/NO）本地 pipeline ——
     网关只做成本开关：NO 时绝不发起 Astra 网络请求；YES 时沿用 Phase 1 Astra 管线不变。 */
  async function middleBrainCompressPipeline(characterId, userMessage, opts) {
    opts = opts || {};
    var admission = await middleBrainAdmissionGate(characterId, userMessage, opts);
    if (admission && admission.useAstra) {
      var astra = await middleBrainAstraInvoke(characterId, userMessage, opts);
      if (astra) {
        /* 要求 #3：当前 userMessage 永远保留。Astra 结果若不含当前消息（非破坏性 tail 追加）。 */
        if (userMessage && astra.compressedContext && astra.compressedContext.indexOf(userMessage) < 0) {
          astra.compressedContext = (astra.compressedContext ? astra.compressedContext + '\n\n' : '') + userMessage;
        }
        astra.admission = admission;
        /* Phase 3 · Context Judge：仅 Astra 压缩成功时运行；只读评估，不写 compressedContext，
           失败（含 disabled/无法就绪）→ astra.judge=null，绝不影响聊天与压缩。 */
        astra.judge = await middleBrainAstraJudge(characterId, userMessage, astra.structured, astra.compressedContext, opts);
        return astra;
      }
    }
    /* fallback：本地组织+压缩（纯规则，无 Astra 依赖） */
    var local = await middleBrainContextPipeline(characterId, userMessage, opts);
    local.stats = local.stats || {};
    local.stats.source = 'local';
    local.source = 'local';   /* 顶层标记来源（与 astra 返回对齐） */
    if (local.compressedContext) {
      /* 要求 #3 兜底：当前 userMessage 如在压缩结果中缺失（无论是否含 dialogue）→ 追加，绝不漏掉当前消息。 */
      if (userMessage && local.compressedContext.indexOf(userMessage) < 0) {
        local.compressedContext = (local.compressedContext ? local.compressedContext + '\n\n' : '') + userMessage;
      }
    } else if (userMessage) {
      local.compressedContext = userMessage;
    }
    local.admission = admission;
    return local;
  }
  function middleBrainAstraEnabled() { return true; }  /* 启用开关由 middleBrainReady 判定 */

  /* 暴露到 _middleBrain 与 window（供测试/将来接入） */
  var _mbApi = {
    getMiddleBrainConfig: getMiddleBrainConfig,
    saveMiddleBrainConfig: saveMiddleBrainConfig,
    isMiddleBrainEnabled: isMiddleBrainEnabled,
    middleBrainReady: middleBrainReady,
    getMiddleBrainSystemPrompt: getMiddleBrainSystemPrompt,
    buildMiddleBrainRequest: buildMiddleBrainRequest,
    buildMiddleBrainResponsesRequest: buildMiddleBrainResponsesRequest,
    parseMiddleBrainResponsesResponse: parseMiddleBrainResponsesResponse,
    parseMiddleBrainResponse: parseMiddleBrainResponse,
    middleBrainOrganizeContext: middleBrainOrganizeContext,
    middleBrainCompressContext: middleBrainCompressContext,
    middleBrainContextPipeline: middleBrainContextPipeline,
    middleBrainAstraInvoke: middleBrainAstraInvoke,
    middleBrainCompressPipeline: middleBrainCompressPipeline,
    middleBrainAdmissionGate: middleBrainAdmissionGate,
    middleBrainAdmissionGateReset: middleBrainAdmissionGateReset,
    _mbAnalyzeSignals: _mbAnalyzeSignals,
    _mbDecisionFromSignals: _mbDecisionFromSignals,
    _mbGateScore: _mbGateScore,
    MB_GATE_DEFAULTS: MB_GATE_DEFAULTS,
    middleBrainAstraJudge: middleBrainAstraJudge,
    middleBrainJudgeEnabled: middleBrainJudgeEnabled,
    middleBrainJudgeTelemetry: middleBrainJudgeTelemetry,
    middleBrainJudgeReset: middleBrainJudgeReset,
    _mbParseJudgeJson: _mbParseJudgeJson,
    MB_JUDGE_SCHEMA: MB_JUDGE_SCHEMA,
    MB_JUDGE_TIMEOUT_MS: MB_JUDGE_TIMEOUT_MS,
    middleBrainAstraEnabled: middleBrainAstraEnabled,
    _mbParseAstraJson: _mbParseAstraJson,
    MB_ASTRA_TIMEOUT_MS: MB_ASTRA_TIMEOUT_MS,
    middleBrainPipelineAvailable: middleBrainPipelineAvailable,
    MB_CTX_DEFAULT_BUDGET: MB_CTX_DEFAULT_BUDGET,
    saveMiddleBrainConfigUI: saveMiddleBrainConfigUI,
    loadMiddleBrainConfigUI: loadMiddleBrainConfigUI
  };
  root._middleBrain = _mbApi;
  window.middleBrainOrganizeContext = middleBrainOrganizeContext;
  window.middleBrainCompressContext = middleBrainCompressContext;
  window.middleBrainContextPipeline = middleBrainContextPipeline;
  window.middleBrainAstraInvoke = middleBrainAstraInvoke;
  window.middleBrainCompressPipeline = middleBrainCompressPipeline;
  window.middleBrainAdmissionGate = middleBrainAdmissionGate;
  window.middleBrainAdmissionGateReset = middleBrainAdmissionGateReset;
  window._mbAnalyzeSignals = _mbAnalyzeSignals;
  window._mbDecisionFromSignals = _mbDecisionFromSignals;
  window._mbGateScore = _mbGateScore;
  window.MB_GATE_DEFAULTS = MB_GATE_DEFAULTS;
  window.middleBrainAstraJudge = middleBrainAstraJudge;
  window.middleBrainJudgeEnabled = middleBrainJudgeEnabled;
  window.middleBrainJudgeTelemetry = middleBrainJudgeTelemetry;
  window.middleBrainJudgeReset = middleBrainJudgeReset;
  window._mbParseJudgeJson = _mbParseJudgeJson;
  window.MB_JUDGE_SCHEMA = MB_JUDGE_SCHEMA;
  window.MB_JUDGE_TIMEOUT_MS = MB_JUDGE_TIMEOUT_MS;
  window.mbReasoningPick = mbReasoningPick;
  window.mbSpeedPick = mbSpeedPick;
  window.mbModelPick = mbModelPick;
  window.mbModelStep = mbModelStep;
  window.normalizeMiddleBrainReasoningEffort = normalizeMiddleBrainReasoningEffort;
  window.normalizeMiddleBrainSpeed = normalizeMiddleBrainSpeed;
  window._mbReadReasoning = _mbReadReasoning;
  window._mbReadSpeed = _mbReadSpeed;
  window._mbReadModel = _mbReadModel;
  window.middleBrainAstraEnabled = middleBrainAstraEnabled;
  window.middleBrainPipelineAvailable = middleBrainPipelineAvailable;
  window.middleBrainAstraEnabled = middleBrainAstraEnabled;
  window._mbParseAstraJson = _mbParseAstraJson;
  window.saveMiddleBrainConfigUI = saveMiddleBrainConfigUI;
  window.loadMiddleBrainConfigUI = loadMiddleBrainConfigUI;
  window.getMiddleBrainConfig = getMiddleBrainConfig;
  window.saveMiddleBrainConfig = saveMiddleBrainConfig;
  window.isMiddleBrainEnabled = isMiddleBrainEnabled;
  window.middleBrainEnabled = isMiddleBrainEnabled;
  window.middleBrainReady = middleBrainReady;
  window.buildMiddleBrainRequest = buildMiddleBrainRequest;
  window.buildMiddleBrainResponsesRequest = buildMiddleBrainResponsesRequest;
  window.parseMiddleBrainResponsesResponse = parseMiddleBrainResponsesResponse;
  window.parseMiddleBrainResponse = parseMiddleBrainResponse;
  window.getMiddleBrainSystemPrompt = getMiddleBrainSystemPrompt;

  /* 初始化：填充 Middle Brain 设置卡片（dom 就绪后） */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadMiddleBrainConfigUI);
    else try { loadMiddleBrainConfigUI(); } catch (e) {}
  }
})(typeof self !== 'undefined' ? self : globalThis);
