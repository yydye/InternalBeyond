/* ====================================================================
   Middle Brain · Config + UI 层（P11-1A 自 middle-brain.js 物理拆分）
   --------------------------------------------------------------------
   职责（只此四类，不混其它层）：
     1. 全局配置默认值 / 读写（apiSettings 私有 key 'middle_brain'）
     2. 就绪判定（isMiddleBrainEnabled / middleBrainReady）
     3. 只读系统提示词常量（MB_SYSTEM_PROMPT，用户不可编辑）
     4. 设置卡片 UI + reasoningEffort / speed 归一
   不含：本地组织/压缩、Admission Gate、Astra 传输、Judge。
   拆分只动位置，不改逻辑；window.* / _middleBrain 兼容符号由 middle-brain.js 代理。
   加载顺序：middle-brain-config.js → middle-brain-policy.js → middle-brain-astra.js
             → middle-brain-judge.js → middle-brain.js
   P11-1B：本层对外只经 MBC.config（冻结契约）暴露，不依赖任何其它层（DAG 起点）。
   ==================================================================== */
(function (root) {
  'use strict';
  /* layer contract 登记处（P11-1B）：每层只向自己的键写入一个冻结契约对象。 */
  var MBC = (root.IB = root.IB || {}).__middleBrainContracts || (root.IB.__middleBrainContracts = {});
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
    speed: 'standard',
    /* P11-2 · Character Integrity Guard（角色一致性守卫）：
       检测候选回复是否**明显**偏离当前角色，仅在高置信度强 OOC 时做最多一次 targeted rewrite。
       默认关闭（关闭时零模型调用，行为与 P11-1C 等价）。
       sensitivity: conservative/balanced/strict → 映射判定阈值（阈值本身在 integrity 层）。
       rewrite: 是否允许自动重写；verify: 重写后是否复判（只观测，绝不二次重写）。 */
    characterIntegrityEnabled: false,
    characterIntegritySensitivity: 'conservative',
    characterIntegrityRewrite: false,
    characterIntegrityVerify: false,
    /* Image Router · 全局图片生成策略（Fast / Auto / Precision）。
       这是**用户策略**，不是执行：Middle Brain 只提供决策输入，
       真正的模型选择 / 并发 / 队列全部由 assets/js/image-router.js 负责。
       auto=Router 按任务画像选 Flare/Sunburst；fast=强制 Flare（永不偷偷升级）；
       precision=强制 Sunburst（永不自动降级）。默认 auto。 */
    imageMode: 'auto'
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
  /* P11-2 · Character Integrity 灵敏度归一（UI 与配置共用的白名单；非法值回退 conservative） */
  var MB_CI_SENSITIVITIES = ['conservative', 'balanced', 'strict'];
  function normalizeMiddleBrainIntegritySensitivity(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return MB_CI_SENSITIVITIES.indexOf(s) >= 0 ? s : 'conservative';
  }
  /* Image Router · 图片生成策略归一（白名单；非法值回退 auto）。
     只经 MBC.config 契约暴露给门面，**不挂 window 兼容别名**（避免散落全局依赖）。 */
  var MB_IMAGE_MODES = ['fast', 'auto', 'precision'];
  function normalizeMiddleBrainImageMode(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return MB_IMAGE_MODES.indexOf(s) >= 0 ? s : 'auto';
  }

  /* ── Image Router 接入缝（P12）：Middle Brain 只输出**决策**，不执行图片请求 ──
     返回归一后的用户图片策略（fast / auto / precision）+ 决策来源，供 Image Router 读取。
     Router 负责模型选择/并发/队列；Scheduler 负责资源控制；executor 负责 provider 执行。 */
  async function middleBrainImageMode() {
    var c = await getMiddleBrainConfig();
    var mode = normalizeMiddleBrainImageMode(c && c.imageMode);
    return { mode: mode, reason: 'user_policy', source: 'middle_brain_config' };
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
  /* P11-2 · Character Integrity Guard UI 档位 */
  var MB_CI_ORDER = ['conservative', 'balanced', 'strict'];
  var MB_CI_LABELS = { conservative: 'Conservative', balanced: 'Balanced', strict: 'Strict' };
  /* Image Router · 图片生成策略档位（Fast ─ Auto ─ Precision，默认 Auto 居中） */
  var MB_IMAGE_ORDER = ['fast', 'auto', 'precision'];
  var MB_IMAGE_LABELS = { fast: 'Fast', auto: 'Auto', precision: 'Precision' };
  var MB_IMAGE_DESC = { fast: 'Prefer faster image generation', auto: 'Let Middle Brain choose', precision: 'Prefer highest editing fidelity' };
  var _mbUi = { enabled: false, reasoning: 'medium', speed: 'standard', model: 'gpt-6-astra', imageMode: 'auto', integrity: { enabled: false, sensitivity: 'conservative', rewrite: false, verify: false } };
  var _mbReasoningSlider = null, _mbSpeedBtn = null, _mbCiSlider = null, _mbImageSlider = null;

  function _mbReasoningDesc(v) { return MB_REASONING_DESC[v] || '默认平衡'; }
  function _mbModelList(cur) { var l = MB_MODEL_CANDIDATES.slice(); if (cur && l.indexOf(cur) < 0) l.unshift(cur); return l; }
  function _mbModelIdx(cur) { var l = _mbModelList(cur); var i = l.indexOf(cur); return i >= 0 ? i : 0; }
  function _mbSummaryText(re, sp) { return (MB_REASONING_LABELS[re] || re) + ' · ' + (MB_SPEED_LABELS[sp] || sp); }
  function _mbUpdateSummary(re, sp) { var s = _mbEl('mb-adv-summary'); if (s) s.textContent = _mbSummaryText(re, sp); _mbRenderHeader(); }
  function _mbLbl(v) { return MB_REASONING_LABELS[v] || MB_SPEED_LABELS[v] || MB_CI_LABELS[v] || v; }

  /* ====================================================================
     P14 · Middle Brain 整块折叠（compact header + 轻量 height/opacity 过渡）
     --------------------------------------------------------------------
     折叠对象 = 整个 Middle Brain 区块（说明 / 启用 / Endpoint / API Key /
     Astra Cognitive Control / Model / Reasoning / Processing / Image Generation /
     Character Integrity Guard 及后续所有 Advanced Settings），不是只折叠子卡片。
     - 只切 body 的 class（隐藏 body，**不销毁 DOM**）：再展开后 input / slider /
       API Key 状态原样保留，不重新初始化 Middle Brain。
     - 事件只绑一次（_mbCollapseBound 幂等守卫），loadMiddleBrainConfigUI 重复调用
       不会重复绑定 listener。
     - 状态持久化：apiSettings 私有 key 'middle_brain_ui'（与其它子系统
       'image_router' / 'image_edit' / 'bgAi' 同一套 IndexedDB 设置存储方式；
       **不新建第二套存储**，也不写进 'middle_brain' 配置契约，避免 UI 态污染
       被 astra / policy / judge 层读取的 canonical 配置）。
     ==================================================================== */
  var MB_UI_KEY = 'middle_brain_ui';
  var _mbCollapseBound = false;
  var _mbUiPref = { collapsed: null };   /* null = 用户从未手动折叠过 */
  var _mbCollapsed = true;               /* 当前折叠态（内存）；持久化值见 _mbUiPref */

  /* 折叠态持久化（只存 UI 态，不碰 'middle_brain' 配置） */
  async function _mbLoadUiPref() {
    try {
      var c = await dbGet('apiSettings', MB_UI_KEY);
      _mbUiPref.collapsed = (c && typeof c.collapsed === 'boolean') ? c.collapsed : null;
    } catch (e) { _mbUiPref.collapsed = null; }
    return _mbUiPref.collapsed;
  }
  function _mbSaveUiPref(collapsed) {
    _mbUiPref.collapsed = !!collapsed;
    try { return dbPut('apiSettings', { id: MB_UI_KEY, collapsed: !!collapsed }); } catch (e) {}
  }
  /* header 摘要：model · reasoning effort · processing(service tier) · image mode */
  function _mbHeaderSummary() {
    return _mbReadModel() + ' · ' + (MB_REASONING_LABELS[_mbReadReasoning()] || _mbReadReasoning())
      + ' · ' + (MB_SPEED_LABELS[_mbReadSpeed()] || _mbReadSpeed())
      + ' · ' + (MB_IMAGE_LABELS[normalizeMiddleBrainImageMode(_mbUi.imageMode)] || _mbUi.imageMode);
  }
  /* 摘要 + enabled/disabled 徽标 + aria-expanded 全部收敛到一处刷新 */
  function _mbRenderHeader() {
    var s = _mbEl('mb-collapse-summary'); if (s) s.textContent = _mbHeaderSummary();
    var b = _mbEl('mb-collapse-badge');
    if (b) { b.textContent = _mbUi.enabled ? 'Enabled' : 'Disabled'; b.classList.toggle('is-on', !!_mbUi.enabled); }
    var t = _mbEl('mb-collapse-toggle'), body = _mbEl('mb-collapse-body');
    if (t) t.setAttribute('aria-expanded', _mbCollapsed ? 'false' : 'true');
    if (body) body.classList.toggle('is-collapsed', !!_mbCollapsed);
  }
  function _mbCollapseApply(collapsed) {
    _mbCollapsed = !!collapsed;
    _mbRenderHeader();
  }
  /* 首次配置 / 配置不完整 / 校验不通过 → 默认展开；否则（含已有用户）默认收起。
     enabled=true 但缺 endpoint / API Key 时仍算不完整（不因为 enabled 就强制展开）。 */
  function _mbConfigIncomplete(c) {
    c = c || {};
    if (!c.enabled) return true;
    return !(String(c.endpoint || '').trim() && String(c.model || '').trim() && String(c.apiKey || '').trim());
  }
  /* 事件只绑一次：header 点击 / Enter / Space（button 原生支持键盘，这里只防重复绑定） */
  function _mbBindCollapse() {
    if (_mbCollapseBound) return;
    var t = _mbEl('mb-collapse-toggle'); if (!t) return;
    t.addEventListener('click', function () { _mbCollapseApply(!_mbCollapsed); _mbSaveUiPref(_mbCollapsed); });
    var en = _mbEl('mb-enabled-toggle');
    if (en) en.addEventListener('change', function () { _mbUi.enabled = !!en.checked; _mbRenderHeader(); });
    _mbCollapseBound = true;
  }
  async function _mbInitCollapse(c) {
    _mbBindCollapse();
    var saved = await _mbLoadUiPref();
    _mbUi.enabled = !!(c && c.enabled);
    /* 无用户偏好时：配置不完整 → 展开；配置完整（已有用户）→ 收起 */
    _mbCollapseApply(saved === null ? !_mbConfigIncomplete(c) : saved);
    return _mbCollapsed;
  }

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
    /* opts.labels：该 slider 专属档位文案（不传则沿用全局 _mbLbl，既有 slider 行为不变） */
    var labelMap = (opts && opts.labels) || null;
    function _lbl(v) { return (labelMap && labelMap[v]) || _mbLbl(v); }
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
      var l = document.createElement('span'); l.className = 'mb-lbl'; l.textContent = _lbl(v); labs.appendChild(l);
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
      valueEl.textContent = _lbl(values[i]);
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
    _mbRenderHeader();
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
    _mbCiBuild();
    _mbImageBuild();
    _mbRenderHeader();
  }
  /* ── Image Router · 图片生成策略 UI（Fast ─ Auto ─ Precision）──────────
     与既有高级设置同一套滑动组件（_mbSliderBuild），不做三个大按钮；
     点击/拖动即写 canonical config（imageMode），与其它卡片一致无需 Save。
     本卡片**只写策略**，不触发任何图片请求：执行边界在 assets/js/image-router.js。 */
  function _mbImagePaint() {
    var m = normalizeMiddleBrainImageMode(_mbUi.imageMode);
    var s = _mbEl('mb-image-summary'); if (s) s.textContent = MB_IMAGE_LABELS[m] || m;
    var h = _mbEl('mb-adv-image-hint'); if (h) h.textContent = MB_IMAGE_DESC[m] || MB_IMAGE_DESC.auto;
  }
  function mbImageModePick(v) {
    v = normalizeMiddleBrainImageMode(v);
    _mbUi.imageMode = v;
    if (_mbImageSlider) _mbImageSlider.setValue(v);
    _mbImagePaint();
    saveMiddleBrainConfig({ imageMode: v });
  }
  function _mbImageBuild() {
    _mbImageSlider = _mbSliderBuild('mb-adv-image', MB_IMAGE_ORDER, normalizeMiddleBrainImageMode(_mbUi.imageMode),
      function (v) { mbImageModePick(v); }, { labels: MB_IMAGE_LABELS });
    _mbImagePaint();
  }
  /* ── P11-2 · Character Integrity Guard UI ──────────────────────────────
     静态卡片（HTML）+ 事件绑定（addEventListener，**不新增 window 全局**，兼容面保持 43 条）。
     点击即写 canonical config（与既有卡片一致，无需 Save）；Rewrite/Verify 在未启用时禁用。 */
  function _mbCiReadUi() {
    /* 元素缺失时保持内存态不变（避免卡片未挂载时把已保存的开关写成 false） */
    var e = _mbEl('mb-ci-enabled'); if (e) _mbUi.integrity.enabled = !!e.checked;
    var r = _mbEl('mb-ci-rewrite'); if (r) _mbUi.integrity.rewrite = !!r.checked;
    var v = _mbEl('mb-ci-verify'); if (v) _mbUi.integrity.verify = !!v.checked;
  }
  function _mbCiPaint() {
    var it = _mbUi.integrity, s = _mbEl('mb-ci-summary');
    if (s) s.textContent = it.enabled ? ((MB_CI_LABELS[it.sensitivity] || it.sensitivity) + (it.rewrite ? ' · Rewrite' : ' · Detect only')) : 'Off';
    var rw = _mbEl('mb-ci-rewrite'), vf = _mbEl('mb-ci-verify');
    if (rw) rw.disabled = !it.enabled;
    if (vf) vf.disabled = !(it.enabled && it.rewrite);
  }
  function _mbCiPersist() {
    saveMiddleBrainConfig({
      characterIntegrityEnabled: _mbUi.integrity.enabled,
      characterIntegritySensitivity: _mbUi.integrity.sensitivity,
      characterIntegrityRewrite: _mbUi.integrity.rewrite,
      characterIntegrityVerify: _mbUi.integrity.verify
    });
  }
  function mbIntegrityToggle() { _mbCiReadUi(); _mbCiPaint(); _mbCiPersist(); }
  function mbIntegritySensitivityPick(v) {
    v = normalizeMiddleBrainIntegritySensitivity(v);
    _mbUi.integrity.sensitivity = v;
    if (_mbCiSlider) _mbCiSlider.setValue(v);
    _mbCiPaint(); _mbCiPersist();
  }
  function _mbCiBuild() {
    ['mb-ci-enabled', 'mb-ci-rewrite', 'mb-ci-verify'].forEach(function (id) {
      var el = _mbEl(id); if (el) el.addEventListener('change', mbIntegrityToggle);
    });
    _mbCiSlider = _mbSliderBuild('mb-ci-sensitivity', MB_CI_ORDER, _mbUi.integrity.sensitivity, function (v) { mbIntegritySensitivityPick(v); });
    _mbCiPaint();
  }
  function mbReasoningPick(v) { v = normalizeMiddleBrainReasoningEffort(v); _mbUi.reasoning = v; if (_mbReasoningSlider) _mbReasoningSlider.setValue(v); _mbUpdateSummary(v, _mbReadSpeed()); saveMiddleBrainConfig({ reasoningEffort: v }); }
  function mbSpeedPick(v) { v = normalizeMiddleBrainSpeed(v); _mbUi.speed = v; _mbRenderSpeed(); _mbUpdateSummary(_mbReadReasoning(), v); _mbRenderHeader(); saveMiddleBrainConfig({ speed: v }); }
  function mbModelPick(m) { _mbModelSet(m); }
  function mbModelStep(delta) { var list = _mbModelList(_mbReadModel()); _mbModelSet(list[Math.max(0, Math.min(list.length - 1, _mbModelIdx(_mbReadModel()) + delta))]); }

  function saveMiddleBrainConfigUI() {
    var enabled = !!(_mbEl('mb-enabled-toggle') && _mbEl('mb-enabled-toggle').checked);
    var endpoint = (_mbEl('mb-endpoint') ? _mbEl('mb-endpoint').value : '').trim();
    var apiKey = (_mbEl('mb-apikey') ? _mbEl('mb-apikey').value : '').trim();
    _mbCiReadUi();
    saveMiddleBrainConfig({ enabled: enabled, endpoint: endpoint, model: _mbReadModel(), apiKey: apiKey, reasoningEffort: _mbReadReasoning(), speed: _mbReadSpeed(), characterIntegrityEnabled: _mbUi.integrity.enabled, characterIntegritySensitivity: _mbUi.integrity.sensitivity, characterIntegrityRewrite: _mbUi.integrity.rewrite, characterIntegrityVerify: _mbUi.integrity.verify, imageMode: normalizeMiddleBrainImageMode(_mbUi.imageMode) }).then(function () {
      var st = _mbEl('mb-save-status'); if (st) { st.textContent = '已保存'; setTimeout(function () { st.textContent = ''; }, 1600); }
      if (typeof toast === 'function') toast('Middle Brain 已保存');
    }).catch(function (e) { if (typeof toast === 'function') toast('Middle Brain 保存失败：' + String(e && e.message || e)); });
  }
  /* 填充设置卡片（dom 就绪后由 middle-brain.js 调用）。
     返回 Promise：新增折叠态初始化也纳入同一条链（便于等待与测试，不改变既有语义）。 */
  function loadMiddleBrainConfigUI() {
    return getMiddleBrainConfig().then(function (c) {
      if (_mbEl('mb-enabled-toggle')) _mbEl('mb-enabled-toggle').checked = !!c.enabled;
      if (_mbEl('mb-endpoint')) _mbEl('mb-endpoint').value = c.endpoint || '';
      if (_mbEl('mb-apikey')) _mbEl('mb-apikey').value = c.apiKey || '';
      _mbUi.reasoning = normalizeMiddleBrainReasoningEffort(c.reasoningEffort);
      _mbUi.speed = normalizeMiddleBrainSpeed(c.speed);
      _mbUi.model = String(c.model || '').trim() || 'gpt-6-astra';
      _mbUi.integrity.enabled = c.characterIntegrityEnabled === true;
      _mbUi.integrity.sensitivity = normalizeMiddleBrainIntegritySensitivity(c.characterIntegritySensitivity);
      _mbUi.integrity.rewrite = c.characterIntegrityRewrite === true;
      _mbUi.integrity.verify = c.characterIntegrityVerify === true;
      _mbUi.imageMode = normalizeMiddleBrainImageMode(c.imageMode);
      if (_mbEl('mb-ci-enabled')) _mbEl('mb-ci-enabled').checked = _mbUi.integrity.enabled;
      if (_mbEl('mb-ci-rewrite')) _mbEl('mb-ci-rewrite').checked = _mbUi.integrity.rewrite;
      if (_mbEl('mb-ci-verify')) _mbEl('mb-ci-verify').checked = _mbUi.integrity.verify;
      if (_mbEl('mb-model')) _mbEl('mb-model').value = _mbUi.model;
      _mbInitAdvancedUI();
      _mbUpdateSummary(_mbUi.reasoning, _mbUi.speed);
      return _mbInitCollapse(c);
    }).catch(function () {});
  }

  /* —— layer contract（P11-1B）：config 层唯一出口，冻结后下游只读 —— */
  MBC.config = Object.freeze({
    /* 配置读写 + 就绪判定 */
    getMiddleBrainConfig: getMiddleBrainConfig,
    saveMiddleBrainConfig: saveMiddleBrainConfig,
    isMiddleBrainEnabled: isMiddleBrainEnabled,
    middleBrainReady: middleBrainReady,
    getMiddleBrainSystemPrompt: getMiddleBrainSystemPrompt,
    MB_SYSTEM_PROMPT: MB_SYSTEM_PROMPT,   /* astra 注入 system 的只读常量 */
    /* Phase 4 · 推理强度 / 速度归一 */
    normalizeMiddleBrainReasoningEffort: normalizeMiddleBrainReasoningEffort,
    normalizeMiddleBrainSpeed: normalizeMiddleBrainSpeed,
    /* P11-2 · Character Integrity 灵敏度归一 */
    normalizeMiddleBrainIntegritySensitivity: normalizeMiddleBrainIntegritySensitivity,
    /* P12 · Image Router 决策缝（图片策略：fast/auto/precision） */
    middleBrainImageMode: middleBrainImageMode,
    normalizeMiddleBrainImageMode: normalizeMiddleBrainImageMode,
    /* 设置卡片 UI */
    saveMiddleBrainConfigUI: saveMiddleBrainConfigUI,
    loadMiddleBrainConfigUI: loadMiddleBrainConfigUI,
    mbReasoningPick: mbReasoningPick,
    mbSpeedPick: mbSpeedPick,
    mbModelPick: mbModelPick,
    mbModelStep: mbModelStep,
    _mbReadReasoning: _mbReadReasoning,
    _mbReadSpeed: _mbReadSpeed,
    _mbReadModel: _mbReadModel
  });
})(typeof self !== 'undefined' ? self : globalThis);
