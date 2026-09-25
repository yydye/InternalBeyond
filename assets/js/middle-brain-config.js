/* ====================================================================
   Middle Brain · Config + UI 层（P11-1A 自 middle-brain.js 物理拆分；M1-C.2i 抽取语义）
   --------------------------------------------------------------------
   职责（只此四类，不混其它层）：
     1. 全局配置的**宿主读写**（apiSettings 私有 key 'middle_brain'）
     2. 设置卡片 UI（DOM 构建 / 事件绑定 / 折叠态）
     3. 只读系统提示词常量（MB_SYSTEM_PROMPT，用户不可编辑）—— 定义在 core，这里只转出
     4. 配置侧归一与就绪判定的**转调**
   不含：本地组织/压缩、Admission Gate、Astra 传输、Judge。
   拆分只动位置，不改逻辑；window.* / _middleBrain 兼容符号由 middle-brain.js 代理。
   加载顺序：provider-directory.js → middle-brain-config-core.js → middle-brain-config.js
             → middle-brain-policy.js → middle-brain-astra.js → middle-brain-judge.js
             → middle-brain-integrity.js → middle-brain.js

   ── M1-C.2i · 为什么语义被抽到 middle-brain-config-core.js ──────────────
   Home Node 要进入**同一个** Middle Brain 执行缝，就必须读到同一套执行策略。
   在此之前"是否参与 / 思考深度 / Admission·Judge·Integrity 开关"只作为本文件的
   IndexedDB 记录存在于浏览器里；如果 Node 侧自己写一份"看起来一样"的判定，
   同一个角色在两端就会有不同的认知行为——这正是本阶段要消除的漂移。
   因此本文件现在只保留**宿主特有**的两件事：IndexedDB 读写 + DOM 设置卡片；
   所有判定（默认值 / 归一 / 就绪谓词 / reasoningEffort 解析 / 执行配置投影）
   只有一份实现，在 core 里。本文件不得再出现第二份。

   P11-1B：本层对外只经 MBC.config（冻结契约）暴露，不依赖任何其它层（DAG 起点）。

   ── 顺带修掉的一处**真实缺陷**（M1-C.2i 审计发现） ──────────────────────
   本文件此前用的是单参数 IIFE `})(typeof self!=='undefined' ? self : globalThis)`，
   而仓库里所有双载模块用的是 `})(typeof self!=='undefined' ? self : this, factory)`。
   两种写法在浏览器里完全等价（self === window），差别只在 Node：
     · 单参数写法把 root 硬编码成 `globalThis` —— **写全局**；
     · 双载写法在 CJS 里 `this` 是 `module.exports` —— **写调用方的返回对象**。
   本文件是"字段注册 → 其余四层 + facade 都来读"的 DAG 起点，两种写法必须二选一
   并且**全仓库一致**：五个层文件的 wrapper 都是 `globalThis`，它们会去
   `globalThis.IB.__middleBrainContracts` 找上游。所以本文件必须**也写 globalThis**，
   否则 Node 下会出现两个互不相见的 IB 注册表 —— facade 读到 config，四个层读不到，
   表现为"契约对象存在但层是空的"这种最难查的形态（本次实测踩到过）。
   因此这里保持写 globalThis，但把 root 的来源写成**显式且健壮**的形式：
   self → globalThis → this（依次回落），并在 factory 里把契约交回给 require 调用方，
   使 Node 侧既能经 `globalThis.IB` 也能经 `require()` 拿到同一个对象。
   ==================================================================== */
(function (factory) {
  var root = (typeof self !== 'undefined' && self) ? self
    : (typeof globalThis !== 'undefined' && globalThis) ? globalThis
    : this;
  var contract = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = contract;
})(function (root) {
  'use strict';
  var MBC = (root.IB = root.IB || {}).__middleBrainContracts || (root.IB.__middleBrainContracts = {});
  /* M1-C.2i：执行配置的**语义**唯一实现（UMD 双载：浏览器经 <script>，Node 经 require）。
     本文件只做宿主适配：IndexedDB + DOM。
     三处刻意的写法：
       · 优先 require，但**必须 try 包住**：有些宿主（本仓库的静态沙箱测试用
         `new Function` 注入 require）里 require 存在却解析不了相对路径。
         try 之后必须静默回落 —— 否则模块加载直接炸，而"取不到 core"本来是
         一个可以在别处被显式发现的状态。
       · 回落读全局：浏览器里 core 由 <script> 挂成 root.IBMiddleBrainConfigCore；
         沙箱里由调用方显式提供同一个对象。两条路径拿到的是**同一个模块实例**
         （与 PROVIDERS_DIR 的既有约定完全一样）。
       · `typeof require === 'function'` 仍然要有，否则浏览器里直接 ReferenceError。 */
  var CORE = null;
  if (typeof require === 'function') {
    try { CORE = require('./middle-brain-config-core.js'); } catch (e) { CORE = null; }
  }
  if (!CORE) CORE = root.IBMiddleBrainConfigCore || null;
  var KEY = 'middle_brain';
  var MB_DEFAULTS = CORE.MB_DEFAULTS;
  var MB_SYSTEM_PROMPT = CORE.MB_SYSTEM_PROMPT;
  var MB_REASONING_EFFORTS = CORE.MB_REASONING_EFFORTS;
  var MB_SPEEDS = CORE.MB_SPEEDS;
  var _mbReasoningResolved = CORE.reasoningEffortResolved;
  var _mbRuntimeEnabled = CORE.middleBrainRuntimeEnabled;
  var normalizeMiddleBrainReasoningEffort = CORE.normalizeMiddleBrainReasoningEffort;
  var normalizeMiddleBrainSpeed = CORE.normalizeMiddleBrainSpeed;
  var normalizeMiddleBrainIntegritySensitivity = CORE.normalizeMiddleBrainIntegritySensitivity;
  var normalizeMiddleBrainImageMode = CORE.normalizeMiddleBrainImageMode;

  function getMiddleBrainSystemPrompt() { return MB_SYSTEM_PROMPT; }

  /* —— 配置读写 ——
     两条宿主路径，语义完全一样（缺键回落默认、非法值在 core 里回退）：
       · 浏览器 = IndexedDB（本文件的主要职责）
       · Home Node = 宿主注入的读取器（services/home-node/middle-brain.js 装好）
     为什么用"注入的读取器"而不是由 Node 侧直接改写本层的契约对象：
     契约是 Object.freeze 的，且是**进程内共享**的——就地改写它会让
     "哪个宿主在跑"变成一个隐式全局状态（两个装配实例互相覆盖、测试之间互相污染）。
     一个具名的 shim 是显式的：谁装、谁卸、装了什么，一眼可见。 */
  /* 宿主读取器**允许是 async**：Node 侧的装配函数本身就是 async（它可能要读 SQLite）。
     因此这里必须 await 它的返回值，而不是把它当成配置对象 —— 否则
     `Object.assign({}, DEFAULTS, Promise)` 会得到一个"看起来正常、其实全是默认值"的对象，
     也就是本阶段最难查的那类静默差异（实测踩到过）。 */
  async function getMiddleBrainConfig() {
    var host = root.__ibMiddleBrainConfigReader;
    if (typeof host === 'function') {
      try {
        var provided = await host();
        if (provided && typeof provided === 'object') return Object.assign({}, MB_DEFAULTS, provided);
      } catch (e) { /* 宿主读取器故障 → 回落默认（= 未启用），绝不抛给调用方 */ }
      return Object.assign({}, MB_DEFAULTS);
    }
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
    return _mbRuntimeEnabled(await getMiddleBrainConfig());
  }
  /* 独立 API 就绪判定：Middle Brain 走自己的 endpoint/model/apiKey，与角色配置无关 */
  async function middleBrainReady() {
    return CORE.middleBrainApiReady(await getMiddleBrainConfig());
  }
  /* 消费者（角色聊天 / 日记 / 主动消息…）唯一读取入口：返回 canonical 档位。
     Middle Brain 未启用 → 恒 'auto'（绝不注入参数）。判定在 core。 */
  async function middleBrainReasoningEffort() {
    try { return CORE.reasoningEffortOf(await getMiddleBrainConfig()); }
    catch (e) { return 'auto'; }
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
  async function getMiddleBrainCredentialStatus() {
    var cfg = await getMiddleBrainConfig();
    if (!cfg || cfg.enabled !== true) {
      return {
        credentialRef: null,
        authorityScope: 'desktop-local',
        status: 'none',
        secretPresent: false,
        sourceClass: 'middle-brain-policy-disabled'
      };
    }
    /*
     * R7 intentionally does not inspect cfg.apiKey. A legacy config without
     * a v2 credentialRef remains unknown until a later migration phase.
     */
    var ref = String(cfg.credentialRef || '').trim();
    if (!ref) {
      return {
        credentialRef: null,
        authorityScope: 'desktop-local',
        status: 'unknown',
        secretPresent: false,
        sourceClass: 'middle-brain-legacy-config',
        errorCode: 'CREDENTIAL_REF_MISSING'
      };
    }
    var consumers = root.IB && root.IB.credentialAuthorityConsumers;
    if (!consumers || typeof consumers.queryBinding !== 'function') {
      return {
        credentialRef: ref,
        authorityScope: 'desktop-local',
        status: 'unavailable',
        secretPresent: false,
        sourceClass: 'middle-brain-config',
        errorCode: 'CREDENTIAL_STATUS_UNAVAILABLE'
      };
    }
    return consumers.queryBinding({
      bindingId: ref,
      capability: 'chat',
      credentialPolicy: 'required',
      endpointClass: 'remote'
    });
  }
  /* ====================================================================
   Phase 4 · Middle Brain Advanced Settings UI（Codex 风格滑动选择）
     --------------------------------------------------------------------
     只做 UI + 模型配置抽象；不改 Compression / Judge / Admission Gate 核心逻辑。
     - Reasoning（P21「思考深度」）：横向分段/滑动选择器 自动 ─ 低 ─ 中 ─ 高 ─ 最大；
       点档位即选（与 Codex 一致），也支持拖动；默认「自动」= 不改变 provider 原生行为。
     - Model：可左右滑动 / 箭头切换 / 点击档位的模型 swiper（非 <select>）。
     - Speed：两档 slider（Standard/Fast）—— 与服务/延迟策略相关，与思考深度**严格分离**，
       两者不共用字段、不互相写入。
     ==================================================================== */
  /* canonical 档位顺序 = 强度阶梯（与 provider-directory.js P21 的 REASONING_TIERS 同序）。 */
  var MB_REASONING_ORDER = ['auto', 'low', 'medium', 'high', 'max'];
  var MB_REASONING_LABELS = { auto: '自动', low: '低', medium: '中', high: '高', max: '最大' };
  var MB_REASONING_DESC = { auto: '跟随服务商原生行为（不发送思考参数）', low: '优先速度与成本', medium: '默认平衡', high: '更深入分析', max: '最高推理强度' };
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
  var _mbUi = { enabled: false, reasoning: 'auto', speed: 'standard', model: 'gpt-6-astra', imageMode: 'auto', integrity: { enabled: false, sensitivity: 'conservative', rewrite: false, verify: false } };
  var _mbReasoningSlider = null, _mbSpeedBtn = null, _mbCiSlider = null, _mbImageSlider = null;

  /* ====================================================================
     P11-3 · UI 编辑态 vs runtime 态（两张不同的状态，绝不混用）
     --------------------------------------------------------------------
     两套状态的真实来源：
       · 编辑态（draft） = `_mbUi.enabled` + 表单里的 endpoint / API Key；
         **只有点击「保存 Middle Brain」才落盘**（本卡片其余控件是"点击即写"，
         见 _mbModelSet / mbReasoningPick / mbSpeedPick / mbImageModePick / mbCiPersist，
         它们不参与 dirty 判定）。
       · runtime 态 = 持久化 apiSettings['middle_brain']；middle-brain 的
         isMiddleBrainEnabled / Admission Gate 只读它。
     修复目标（Runtime Participation Audit 暴露的 "UI = Enabled / runtime = Disabled"）：
       toggle 改了但没保存 → runtime **不变**，徽标不得显示 Enabled。
     `_mbSaved` = 上述三个 Save-才生效字段的 pristine 快照；`_mbRuntime` = runtime 态镜像。
     两者只在「加载配置完成」与「保存成功」两处刷新 —— 没有第三条写入路径。 */
  var _mbSaved = { enabled: false, endpoint: '', apiKey: '' };
  var _mbRuntime = { enabled: false };

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
  /* 表单里两个 Save-才生效的输入框（读值只归一空白，不改内容） */
  function _mbFormEndpoint() { var e = _mbEl('mb-endpoint'); return e ? String(e.value == null ? '' : e.value).trim() : ''; }
  function _mbFormApiKey() { var e = _mbEl('mb-apikey'); return e ? String(e.value == null ? '' : e.value).trim() : ''; }
  /* pristine 快照：表单被填成持久化值（或保存成功后）调用，此后 DOM 与它一致 → 不 dirty。
     runtime 镜像与它同源刷新：徽标读的是**持久化**配置，不是编辑态。 */
  function _mbCaptureSaved(c) {
    c = c || {};
    _mbSaved = {
      enabled: !!c.enabled,
      endpoint: String(c.endpoint == null ? '' : c.endpoint).trim(),
      apiKey: String(c.apiKey == null ? '' : c.apiKey).trim()
    };
    _mbRuntime = { enabled: _mbRuntimeEnabled(c) };
  }
  /* dirty = 编辑态（toggle + 两个 Save-才生效的输入框）与持久化态不一致 → 尚未生效 */
  function _mbDirty() {
    return _mbUi.enabled !== _mbSaved.enabled
      || _mbFormEndpoint() !== _mbSaved.endpoint
      || _mbFormApiKey() !== _mbSaved.apiKey;
  }
  /* 徽标三态：on（runtime 启用且无未保存改动）/ off（runtime 关闭且无改动）/ unsaved（有未保存改动）。
     unsaved **绝不**渲染成 Enabled —— 这正是本阶段要修掉的"假 Enabled"。 */
  function _mbBadgeState() { return _mbDirty() ? 'unsaved' : (_mbRuntime.enabled ? 'on' : 'off'); }
  /* header 摘要：model · reasoning effort · processing(service tier) · image mode */
  function _mbHeaderSummary() {
    return _mbReadModel() + ' · ' + (MB_REASONING_LABELS[_mbReadReasoning()] || _mbReadReasoning())
      + ' · ' + (MB_SPEED_LABELS[_mbReadSpeed()] || _mbReadSpeed())
      + ' · ' + (MB_IMAGE_LABELS[normalizeMiddleBrainImageMode(_mbUi.imageMode)] || _mbUi.imageMode);
  }
  /* 摘要 + runtime 徽标 + aria-expanded 全部收敛到一处刷新。
     徽标只回答"持久化的 Middle Brain 是否启用"（runtime 事实），不跟随编辑态 toggle；
     两者不一致时进入 unsaved 态，真实 runtime 值退到 title，避免任何"看起来已生效"。 */
  function _mbRenderHeader() {
    var s = _mbEl('mb-collapse-summary'); if (s) s.textContent = _mbHeaderSummary();
    var state = _mbBadgeState();
    var b = _mbEl('mb-collapse-badge');
    if (b) {
      b.textContent = state === 'unsaved' ? 'Unsaved' : (state === 'on' ? 'Enabled' : 'Disabled');
      b.classList.toggle('is-on', state === 'on');
      b.classList.toggle('is-dirty', state === 'unsaved');
      b.title = 'Runtime: ' + (_mbRuntime.enabled ? 'Enabled' : 'Disabled')
        + (state === 'unsaved' ? ' · 有未保存的更改（点「保存 Middle Brain」后生效）' : '');
    }
    var st = _mbEl('mb-save-status');
    if (st && state === 'unsaved') st.textContent = '未保存';
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
  /* 事件只绑一次：header 点击 / Enter / Space（button 原生支持键盘，这里只防重复绑定）。
     P11-3：三个 Save-才生效的控件各自独立绑定（此前 enabled 开关的绑定被
     "折叠头不存在就直接 return" 顺带跳过）；编辑只刷新 dirty 显示，
     **不写任何存储、不改 runtime**。 */
  function _mbBindCollapse() {
    if (_mbCollapseBound) return;
    var t = _mbEl('mb-collapse-toggle');
    if (t) t.addEventListener('click', function () { _mbCollapseApply(!_mbCollapsed); _mbSaveUiPref(_mbCollapsed); });
    var en = _mbEl('mb-enabled-toggle');
    if (en) en.addEventListener('change', function () { _mbUi.enabled = !!en.checked; _mbRenderHeader(); });
    ['mb-endpoint', 'mb-apikey'].forEach(function (id) {
      var el = _mbEl(id);
      if (el) el.addEventListener('input', function () { _mbRenderHeader(); });
    });
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
    /* P21：思考深度 = 5 档分段选择器（自动/低/中/高/最大）。点档位即选，也支持拖动 */
    _mbReasoningSlider = _mbSliderBuild('mb-adv-reasoning', MB_REASONING_ORDER, _mbReadReasoning(), function (v) { mbReasoningPick(v); }, { labels: MB_REASONING_LABELS });
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
  /* P21：用户主动选择档位 → 写 canonical 值 + v2 迁移标记（此后该值才被承认是"用户选过的"）。 */
  function mbReasoningPick(v) { v = normalizeMiddleBrainReasoningEffort(v); _mbUi.reasoning = v; if (_mbReasoningSlider) _mbReasoningSlider.setValue(v); _mbUpdateSummary(v, _mbReadSpeed()); saveMiddleBrainConfig({ reasoningEffort: v, reasoningEffortV2: true }); }
  function mbSpeedPick(v) { v = normalizeMiddleBrainSpeed(v); _mbUi.speed = v; _mbRenderSpeed(); _mbUpdateSummary(_mbReadReasoning(), v); _mbRenderHeader(); saveMiddleBrainConfig({ speed: v }); }
  function mbModelPick(m) { _mbModelSet(m); }
  function mbModelStep(delta) { var list = _mbModelList(_mbReadModel()); _mbModelSet(list[Math.max(0, Math.min(list.length - 1, _mbModelIdx(_mbReadModel()) + delta))]); }

  function saveMiddleBrainConfigUI() {
    var enabled = !!(_mbEl('mb-enabled-toggle') && _mbEl('mb-enabled-toggle').checked);
    var endpoint = (_mbEl('mb-endpoint') ? _mbEl('mb-endpoint').value : '').trim();
    var apiKey = (_mbEl('mb-apikey') ? _mbEl('mb-apikey').value : '').trim();
    _mbCiReadUi();
    /* P11-3：保存成功是 runtime 态唯一的更新点。pristine 快照与 runtime 镜像一起刷新，
       徽标此刻才允许显示 runtime Enabled（未保存期间一律 unsaved / 旧 runtime 值）。 */
    return saveMiddleBrainConfig({ enabled: enabled, endpoint: endpoint, model: _mbReadModel(), apiKey: apiKey, reasoningEffort: _mbReadReasoning(), reasoningEffortV2: true, speed: _mbReadSpeed(), characterIntegrityEnabled: _mbUi.integrity.enabled, characterIntegritySensitivity: _mbUi.integrity.sensitivity, characterIntegrityRewrite: _mbUi.integrity.rewrite, characterIntegrityVerify: _mbUi.integrity.verify, imageMode: normalizeMiddleBrainImageMode(_mbUi.imageMode) }).then(function (merged) {
      _mbCaptureSaved(merged || { enabled: enabled, endpoint: endpoint, apiKey: apiKey });
      _mbRenderHeader();
      var st = _mbEl('mb-save-status'); if (st) { st.textContent = '已保存'; setTimeout(function () { if (st.textContent === '已保存') st.textContent = ''; }, 1600); }
      if (typeof toast === 'function') toast('Middle Brain 已保存');
      return merged;
    }).catch(function (e) { if (typeof toast === 'function') toast('Middle Brain 保存失败：' + String(e && e.message || e)); });
  }
  /* 填充设置卡片（dom 就绪后由 middle-brain.js 调用）。
     返回 Promise：新增折叠态初始化也纳入同一条链（便于等待与测试，不改变既有语义）。 */
  function loadMiddleBrainConfigUI() {
    return getMiddleBrainConfig().then(function (c) {
      if (_mbEl('mb-enabled-toggle')) _mbEl('mb-enabled-toggle').checked = !!c.enabled;
      if (_mbEl('mb-endpoint')) _mbEl('mb-endpoint').value = c.endpoint || '';
      if (_mbEl('mb-apikey')) _mbEl('mb-apikey').value = c.apiKey || '';
      /* P11-3：先对齐编辑态与 pristine/runtime 快照，再渲染（load 之后必须 UI === runtime）。
         之后任何 toggle / 输入都只是"未保存改动"，不会改动 _mbSaved / _mbRuntime。 */
      _mbUi.enabled = !!c.enabled;
      _mbCaptureSaved(c);
      /* P21：旧配置（无 v2 迁移标记）解析为 auto —— 加载路径不写存储，用户重新选择才落盘。 */
      _mbUi.reasoning = _mbReasoningResolved(c).effort;
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
    /* P21 · 统一思考深度（canonical reasoningEffort）：消费者唯一读取入口 */
    MB_REASONING_EFFORTS: MB_REASONING_EFFORTS,
    middleBrainReasoningEffort: middleBrainReasoningEffort,
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
  root.IB = root.IB || {};
  root.IB.credentialAuthorityConsumers = root.IB.credentialAuthorityConsumers || {};
  root.IB.credentialAuthorityConsumers.middleBrainStatus = getMiddleBrainCredentialStatus;
  /* Node 下把契约交回给 require 调用方（浏览器下 factory 的返回值被忽略）。
     注意这与其余五个 MB 层文件不同：那五个写全局 root.IB，本文件在 Node 下
     必须让调用方能拿到契约，否则 services 侧就没有 canonical 入口。 */
  return MBC;
});
