/*************************************************************
 * ====================================================================
 *   IB Active · Commerce Domain（Phase 1：只读购物状态机）
 *   --------------------------------------------------------------------
 *   定位：InternalBeyond 通过现有 IBMCP（assets/js/integrations.js）
 *   接入本地 Playwright MCP（mcp.shopping.*）后，Commerce 域负责：
 *     · 购物会话状态机（browsing → product → sku → checkout_captured）
 *     · 预算状态与金额门禁（orderCap / dailyCap · canSpend）
 *     · 流程编排建议（nextStep()：告诉模型下一步该做什么）
 *     · 可靠捕获 checkout URL（收银台 URL 提取）
 *   它【不做】底层浏览器通信（那是 Playwright MCP），【不做】任何支付。
 *
 *   加载方式（UMD 双载，与 reply-chain-core.js 同款模式，禁止分叉）：
 *     - 浏览器：<script src="active/commerce.js"> → window.IBCommerce
 *     - Node   ：require('../active/commerce.js') → createCommerce
 *
 *   边界（铁律）：
 *     - 零 Harness 耦合：不 require node-model-port / node-model-compat /
 *       ib-model-core / agent-runtime；不引用 window fetr/DOM；纯逻辑。
 *     - 零 ModelPort：本域不负责模型执行。
 *     - 支付边界：submitPayment() 仅返回 {ok:false, boundary:'...'}，
 *       Phase 1 绝不含 alipay-bot / 真实下单逻辑；只留扩展契约。
 *   ====================================================================
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IBCommerce = factory();
    root.IB = root.IB || {};
    root.IB.commerce = root.IBCommerce;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ── 常量（前后台唯一来源） ── */
  var LIMITS = {
    DAILY_CAP: 500,          /* 默认单日预算（元，本地软上限） */
    ORDER_CAP: 200,          /* 默认单笔上限（元） */
    MAX_HISTORY: 40          /* 会话内事件日志条数上限 */
  };
  /* 支付扩展边界标记：Phase 1 严禁进入（常量，供 Phase 2 探测） */
  var PAYMENT_BOUNDARY = 'alipay-agent-payment';
  /* 收银台 URL 特征（source of truth，供 observeToolResult 捕获） */
  var CHECKOUT_URIS = [
    /https?:\/\/(?:[^\/\s]*\.)?cashier[\w.-]*\.alipay\.com\/[^\s"']*/i,
    /cashiermain\.htm\?[^\s"']*orderId=[\w-]+/i,
    /https?:\/\/[^\s"']*(?:checkout|pay|payment|cashier)[^\s"']*/i
  ];

  /* 阶段静态定义 */
  var STAGES = {
    idle:            'idle',
    browsing:        'browsing',
    product_selected:'product_selected',
    sku_selected:    'sku_selected',
    checkout_captured:'checkout_captured',
    awaiting_payment:'awaiting_payment'   /* 仅 Phase 2 使用 */
  };
  var ORDER = [
    STAGES.idle, STAGES.browsing, STAGES.product_selected,
    STAGES.sku_selected, STAGES.checkout_captured, STAGES.awaiting_payment
  ];

  function todayKey(now) {
    var d = new Date(Number(now) || Date.now());
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function pickNumber(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  function stageRank(stage) {
    var i = ORDER.indexOf(stage);
    return i < 0 ? 0 : i;
  }

  function createCommerce(deps) {
    deps = deps || {};
    var _now = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
    var _persist = deps.persist || null;   /* state => void（可注入原子写/IndexedDB） */

    var _state = {
      version: 1,
      serverAlias: 'shopping',
      session: {
        active: false,
        stage: STAGES.idle,
        startedAt: 0,
        query: '',
        productTitle: '',
        productUrl: '',
        sku: '',
        checkoutUrl: '',
        orderId: '',
        amount: null,
        notes: []
      },
      budget: {
        dailyCap: LIMITS.DAILY_CAP,
        orderCap: LIMITS.ORDER_CAP,
        spentToday: 0,
        dayKey: todayKey(_now())
      },
      history: []
    };

    function save() {
      if (_persist) { try { _persist(_state); } catch (e) { /* 持久化失败不阻断状态机 */ } }
    }
    function commuteDay() {
      var k = todayKey(_now());
      if (_state.budget.dayKey !== k) { _state.budget.dayKey = k; _state.budget.spentToday = 0; }
    }
    function log(kind, detail) {
      _state.history.push({ t: _now(), kind: kind, detail: detail || '' });
      if (_state.history.length > LIMITS.MAX_HISTORY) _state.history = _state.history.slice(-LIMITS.MAX_HISTORY);
    }
    function setStage(stage) {
      if (ORDER.indexOf(stage) < 0) return;
      if (stageRank(stage) >= stageRank(_state.session.stage) || stage === STAGES.idle) {
        _state.session.stage = stage;
        log('stage', stage);
        save();
      }
    }

    /* ── 外部 API：配置 ── */
    function configure(opts) {
      opts = opts || {};
      if (opts.serverAlias) _state.serverAlias = String(opts.serverAlias);
      if (opts.dailyCap != null) _state.budget.dailyCap = pickNumber(opts.dailyCap, LIMITS.DAILY_CAP);
      if (opts.orderCap != null) _state.budget.orderCap = pickNumber(opts.orderCap, LIMITS.ORDER_CAP);
      save();
      return current();
    }

    /* ── 外部 API：会话 ── */
    function reset() {
      _state.session = {
        active: false, stage: STAGES.idle, startedAt: 0, query: '',
        productTitle: '', productUrl: '', sku: '', checkoutUrl: '',
        orderId: '', amount: null, notes: []
      };
      _state.history = [];
      log('reset', '会话已重置');
      save();
      return current();
    }

    function startSession(opts) {
      opts = opts || {};
      commuteDay();
      _state.session.active = true;
      _state.session.stage = STAGES.browsing;
      _state.session.startedAt = _now();
      if (opts.query) _state.session.query = String(opts.query).slice(0, 200);
      log('start', '开始购物会话' + (_state.session.query ? ' · 关键词=' + _state.session.query : ''));
      save();
      return current();
    }

    function setProduct(p) {
      p = p || {};
      if (p.title != null) _state.session.productTitle = String(p.title).slice(0, 200);
      if (p.url != null) _state.session.productUrl = String(p.url).slice(0, 500);
      if (p.amount != null) _state.session.amount = pickNumber(p.amount, _state.session.amount);
      setStage(STAGES.product_selected);
      return current();
    }

    function setSku(s) {
      s = s || {};
      if (s.label != null) _state.session.sku = String(s.label).slice(0, 120);
      if (s.amount != null) _state.session.amount = pickNumber(s.amount, _state.session.amount);
      setStage(STAGES.sku_selected);
      return current();
    }

    /* 可靠捕获收银台 URL：Phase 1 只兜住，不支付 */
    function captureCheckout(url, meta) {
      commuteDay();
      var u = String(url || '').trim();
      if (!u) return { ok: false, reason: '缺少收银台 URL' };
      _state.session.checkoutUrl = u;
      if (meta && meta.orderId != null) _state.session.orderId = String(meta.orderId);
      if (meta && meta.amount != null) _state.session.amount = pickNumber(meta.amount, _state.session.amount);
      setStage(STAGES.checkout_captured);
      log('capture_checkout', u);
      save();
      return { ok: true, orderId: _state.session.orderId, amount: _state.session.amount };
    }

    /* ── 外部 API：预算 ── */
    function budget() {
      commuteDay();
      return {
        dailyCap: _state.budget.dailyCap,
        orderCap: _state.budget.orderCap,
        spentToday: _state.budget.spentToday,
        remainingToday: Math.max(0, _state.budget.dailyCap - _state.budget.spentToday),
        dayKey: _state.budget.dayKey
      };
    }

    /* 金额风控门禁：Phase 1 只读不花，但契约已就位（Phase 2 直接复用） */
    function canSpend(amount) {
      commuteDay();
      var amt = Number(amount);
      if (!Number.isFinite(amt) || amt < 0) return { ok: false, reason: '金额无效' };
      var b = _state.budget;
      if (amt > b.orderCap) return { ok: false, reason: '超过单笔上限 ' + b.orderCap + ' 元' };
      if (amt > (b.dailyCap - b.spentToday)) return { ok: false, reason: '超过单日剩余预算' };
      return { ok: true };
    }

    /* ── 核心：观测一次 mcp.shopping.* 调用结果（由适配器在 execOp 后注入） ── */
    function observeToolResult(fullName, args, result) {
      args = args || {};
      result = result || {};
      var name = String(fullName || '');
      var text = [result.response, result.text, result.reason].filter(Boolean).join('\n');
      var argsText = '';
      try { argsText = JSON.stringify(args); } catch (e) { argsText = ''; }
      var hay = text + '\n' + argsText;

      /* 会话自动化：一旦出现 mcp.shopping.* 调用即激活会话（已激活则推进） */
      var isShopping = name.indexOf('mcp.' + _state.serverAlias + '.') === 0;
      if (isShopping && !_state.session.active) {
        _state.session.active = true;
        _state.session.stage = STAGES.browsing;
        _state.session.startedAt = _state.session.startedAt || _now();
      }

      /* 关键词/商品标题捕获 */
      var title = _extractTitle(args, text);
      if (title) _state.session.productTitle = title.slice(0, 200);

      /* SKU 捕获：args 中提到 sku/option/spec/颜色/尺码 */
      var sku = _extractSku(args);
      if (sku) { _state.session.sku = sku.slice(0, 120); setStage(STAGES.sku_selected); }

      /* 金额捕获 */
      var amt = _extractAmount(args, text);
      if (amt != null) {
        _state.session.amount = amt;
        var gate = canSpend(amt);
        log('amount', '检测到金额 ' + amt + (gate.ok ? '' : ' · ⚠' + gate.reason));
      }

      /* 收银台 URL 捕获（最高优先级） */
      var checkout = _extractCheckoutUrl(text);
      if (checkout) {
        _state.session.checkoutUrl = checkout;
        _state.session.orderId = _extractOrderId(text) || _state.session.orderId || '';
        _state.session.amount = amt != null ? amt : _state.session.amount;
        setStage(STAGES.checkout_captured);
        log('capture_checkout', checkout);
      }

      /* 阶段推导：商品页/详情 */
      if (!!title && stageRank(_state.session.stage) < stageRank(STAGES.product_selected)) {
        setStage(STAGES.product_selected);
      }

      save();
      return current();
    }

    /* ── 提取助手（纯函数） ── */
    function _extractTitle(args, text) {
      var t = args.title || args.productTitle || args.name;
      if (t && String(t).trim().length > 2) return String(t).trim();
      var m = String(text || '').match(/(?:商品名称|商品标题|标题|productTitle)[【:：]\s*([^\n【】]{2,80})/) ||
              String(text || '').match(/(?:商品名称|标题)[:：]\s*([^\n【】]{2,80})/);
      return m ? m[1].trim() : '';
    }
    function _extractSku(args) {
      var fields = ['sku', 'spec', 'option', 'color', '尺寸', '规格', '颜色'];
      for (var i = 0; i < fields.length; i++) {
        var v = args[fields[i]];
        if (v != null && String(v).trim()) return String(v).trim();
      }
      return '';
    }
    function _extractAmount(args, text) {
      var raw = args.amount != null ? args.amount
        : (args.price != null ? args.price
        : (args.total != null ? args.total : null));
      if (raw != null && Number(raw) > 0) return Number(raw);
      /* 只匹配带货币单位/前缀的金额，避免吃掉 orderId 等裸数字 */
      var m = String(text || '').match(/(?:¥|￥)\s*(\d{1,6}(?:\.\d{1,2})?)/) ||
              String(text || '').match(/(\d{1,6}(?:\.\d{1,2})?)\s*(?:元|块钱?|人民币)/);
      return m ? Number(m[1]) : null;
    }
    function _extractCheckoutUrl(text) {
      for (var i = 0; i < CHECKOUT_URIS.length; i++) {
        var m = String(text || '').match(CHECKOUT_URIS[i]);
        if (m && m[0]) return m[0];
      }
      return '';
    }
    function _extractOrderId(text) {
      var m = String(text || '').match(/orderId=[\w-]+/i) || String(text || '').match(/order_id["':\s]+([\w-]{6,})/i);
      return m ? (m[0].indexOf('=') >= 0 ? m[0].split('=')[1] : m[1]) : '';
    }

    /* ── 编排：下一步建议（供模型/宿主决定） ── */
    function nextStep() {
      var s = _state.session;
      switch (s.stage) {
        case STAGES.idle:
          return { action: 'start', stage: s.stage, hint: '开始购物：先搜索商品关键词', tool: 'mcp.shopping.browser_navigate' };
        case STAGES.browsing:
          return { action: 'open_product', stage: s.stage, hint: '打开目标商品页并核对标题/价格', tool: 'mcp.shopping.browser_click' };
        case STAGES.product_selected:
          return { action: 'select_sku', stage: s.stage, hint: '选择 SKU/规格（颜色、尺码等）', tool: 'mcp.shopping.browser_click' };
        case STAGES.sku_selected:
          return { action: 'capture_checkout', stage: s.stage, hint: '进行到结算并捕获收银台 URL；Phase 1 只读，到捕获即停', tool: 'mcp.shopping.browser_snapshot' };
        case STAGES.checkout_captured:
          return { action: 'stop', stage: s.stage, hint: '已捕获收银台 URL。Phase 1 禁止支付，请停止并告知用户，不要调用任何支付工具' };
        default:
          return { action: 'stop', stage: s.stage, hint: '会话结束' };
      }
    }

    /* ── 状态文本（供提示词注入/控制台查看） ── */
    function statusBlock() {
      if (!_state.session.active) return '';
      var s = _state.session;
      var b = budget();
      var lines = [];
      lines.push('【购物会话】阶段=' + s.stage
        + (s.query ? ' · 关键词=' + s.query : '')
        + (s.productTitle ? ' · 商品=' + s.productTitle.slice(0, 40) : '')
        + (s.sku ? ' · 规格=' + s.sku : '')
        + (s.amount != null ? ' · 金额=' + s.amount : ''));
      if (s.checkoutUrl) lines.push('· 已捕获收银台URL=' + s.checkoutUrl.slice(0, 120) + '（Phase1 只读，禁止支付）');
      var step = nextStep();
      lines.push('· 下一步建议=' + step.hint);
      if (b.spentToday > 0) lines.push('· 今日已花=' + b.spentToday + '，剩余预算=' + b.remainingToday);
      return lines.join('\n');
    }

    /* ── 支付边界（Phase 2）：只暴露契约，不实现 ── */
    function submitPayment(payload) {
      /* Phase 1 铁律：禁止真实支付。此方法为 Phase 2 扩展点。
         Phase 2 设计：适配器捕获收银台 URL → 经 Bridge 侧白名单工具调用
         alipay-bot（仅 cashier*.alipay.com 域名）→ 用户手机指纹确认。 */
      return {
        ok: false,
        boundary: PAYMENT_BOUNDARY,
        phase: 1,
        reason: 'PHASE1_DISABLED：Phase 1 只读，禁止支付（' + PAYMENT_BOUNDARY + '）'
      };
    }

    /* ══════════════════════════════════════════════════════════════
       PHASE 3A · SHOPPING AGENT（购物决策器——纯确定性，无模型循环）
       ------------------------------------------------------------------
       职责：把购物需求解析成结构化 task，持有候选/选择/下一步状态，做
       多准则候选排序，并驱动 SEARCH→OBSERVE→FILTER→COMPARE→SELECT→
       SKU→CHECKOUT 决策环。
       边界：
         · 不调用模型（ModelPort 仍单次执行）；不新增 Agent Runtime。
         · 动作由【现有关注的 AI/IBMCP 工具】执行，本域只算「下一步+排序+何时停」。
         · 不调真实 Provider；捕获 checkoutUrl 后生成 PaymentIntent 即停（3A 到确认点）。
         · step / failure 预算防止无限循环；所有异常进入明确 STOP 状态，不静默继续。
         · 支付凭证绝不进入本域。
       ══════════════════════════════════════════════════════════════ */
    var AGENT_STEPS = ['SEARCH', 'OBSERVE', 'FILTER', 'COMPARE', 'SELECT', 'SKU', 'CHECKOUT', 'REVIEW', 'DONE', 'STOP'];
    var AGENT = { MAX_STEPS: 12, MAX_FAILURES: 3, SCORE: { price: 0.4, rating: 0.25, delivery: 0.15, stock: 0.1, sku: 0.06, keyword: 0.04 } };
    var STOP_REASON = { STEP_BUDGET: 'STEP_BUDGET', TOOL_FAILURE: 'TOOL_FAILURE', OVER_BUDGET: 'OVER_BUDGET', NO_RESULTS: 'NO_RESULTS', CHECKOUT_STOP: 'CHECKOUT_STOP_PHASE3A', USER_STOP: 'USER_STOP' };

    /* ── Agent 子状态（持久化于 _state.agent） ── */
    function _agent() {
      if (!_state.agent) {
        _state.agent = {
          active: false, intent: 'SEARCH', reason: '', halted: false, haltedReason: '',
          task: {}, candidates: [], selected: null, step: 0, failures: 0,
          maxSteps: AGENT.MAX_STEPS, maxFailures: AGENT.MAX_FAILURES,
          lastAction: '', canonicalId: '', canonicalNonce: ''
        };
      }
      return _state.agent;
    }

    /* ── 1. Shopping Planner：自然语言 → 结构化 task（确定性启发式） ── */
    function planShopping(nl) {
      var text = String(nl || '').replace(/\s+/g, ' ').trim();
      var task = { keywords: [], category: '', maxBudget: null, skuPrefs: [], quantity: 1, urgency: false, notes: text.slice(0, 200) };
      var m;

      /* 预算：优先「N 元 以内/以下/预算」；其次「不超过/最多/上限 N」；再次裸「¥N / N元」 */
      m = text.match(/([¥￥]?\d{2,8}(?:\.\d{1,2})?)\s*(?:元|块钱?)?\s*(?:以内|以下|之内|内)/)
        || text.match(/(?:不超过|最多|上限|预算|控制在)\s*([¥￥]?\d{2,8}(?:\.\d{1,2})?)\s*(?:元|块钱?)?/)
        || text.match(/([¥￥]\d{1,8}(?:\.\d{1,2})?)\s*(?:元|块钱)?/);
      if (m) task.maxBudget = Number(m[1].replace(/[¥￥]/g, ''));

      /* 规格偏好：显式「颜色/尺码/型号/规格/版本」+ 值 */
      m = text.match(/(?:颜色|尺码|型号|规格|版本)[:：为\s]*([^\s，。;；,、]+)/i);
      if (m && m[1]) task.skuPrefs.push(m[1].trim());

      /* 数量 */
      m = text.match(/(\d+)\s*(?:件|个|台|只|双|份)/);
      if (m) task.quantity = Math.max(1, Number(m[1]));

      /* 急切 */
      if (/急|尽快|今天|马上|立刻|越早越好/.test(text)) task.urgency = true;

      /* 关键词：先剔除 预算/数量/招呼语/触发词，再按分隔符切词，去掉停用词与纯数字 */
      var clean = text
        .replace(/请|帮我|帮忙|麻烦|给我|我想|希望|想要|买|购买|下单|采购|一个|一件|这个|那个|商品|东西|谢谢|京东|淘宝|拼多多|天猫/gi, ' ')
        .replace(/([¥￥]?\d{2,8}(?:\.\d{1,2})?)\s*(?:元|块钱?)?\s*(?:以内|以下|之内|内)?/g, ' ')
        .replace(/(\d+)\s*(?:件|个|台|只|双|份)/g, ' ')
        .replace(/急|尽快|今天|马上|立刻|越早越好|预算|不超过|最多|上限|控制在|以内|以下|之内|的/gi, ' ');
      var kws = clean.split(/[\s,，。、;；、和与及]+/).map(function (s) { return s.trim(); }).filter(function (s) {
        return s.length >= 2 && !/^\d+$/.test(s) && !/^(再|也|还|都|吧|嘛|啊|哦|呢|这|那)$/.test(s);
      });
      task.keywords = kws.slice(0, 8);
      task.category = task.keywords[0] || '通用';
      return task;
    }

    /* ── 2. 多准则评分（不简单按最低价；价格仅占 0.4 权重） ── */
    function scoreCandidate(c, task) {
      var t = task || {};
      var W = AGENT.SCORE;
      var maxB = Number(t.maxBudget);
      var price = Number(c.price);
      var inBudget = !(maxB > 0) || (price > 0 && price <= maxB);
      /* 价格归一：候选集内越低越接近满分（基于全集相对） */
      var priceScore = 1;
      var p = (price > 0 || inBudget === false) ? price : 0;
      priceScore = p > 0 ? Math.max(0, 1 - (p - 0) / Math.max(1, maxB > 0 ? maxB : (p * 1.5))) : 0;
      var rating = Number(c.rating);
      var ratingScore = rating > 0 ? Math.min(1, rating / 5) : 0.3;
      var delivery = Number(c.deliveryDays) || 7;
      var deliveryScore = delivery > 0 ? Math.max(0, 1 - (delivery - 1) / 14) : 0.5;
      var stock = String(c.stock || '').toLowerCase();
      var stockScore = (stock === '缺货' || stock === 'out' || c.stock === 0) ? 0 : 1;
      /* 规格匹配：候选 sku 需覆盖 task.skuPrefs（任一项命中即 1，否则 0.4） */
      var skuMatch = (t.skuPrefs || []).length ? (t.skuPrefs.some(function (p) { return String(c.sku || '').indexOf(p) >= 0; }) ? 1 : 0.4) : 1;
      /* 关键词命中占比（标题文本包含任一 / 全部） */
      var kw = (t.keywords || []).filter(Boolean);
      var kwHit = kw.length ? kw.filter(function (k) { return String(c.title + ' ' + (c.keywords || []).join(' ')).indexOf(k) >= 0; }).length / kw.length : 0.6;
      var total = W.price * priceScore + W.rating * ratingScore + W.delivery * deliveryScore + W.stock * stockScore + W.sku * skuMatch + W.keyword * kwHit;
      return { id: c.id, title: c.title, price: price, rating: rating, deliveryDays: delivery, stock: c.stock, sku: c.sku, score: Math.round(total * 1000) / 1000, inBudget: inBudget };
    }
    function rankCandidates() {
      var a = _agent();
      var task = a.task || {};
      var rows = (a.candidates || []).map(function (c) { return scoreCandidate(c, task); });
      rows.sort(function (x, y) { return y.score - x.score; });
      return rows;
    }

    /* ── 3. 观测注入：把一次 mcp.shopping.* 结果变为候选/状态推进（决策环核心） ── */
    /* L2：商品 URL 与 checkoutUrl 完全分离；采购 URL 不得被误判为收银台 */
    function _cashierUrl(text) {
      return (String(text || '').match(/https?:\/\/(?:[a-z0-9-]+\.)?cashier[\w.-]*\.alipay\.com\/[^\s"']*/i) || [''])[0];
    }
    function _detectCheckout(args, text) {
      var url = String(args && (args.checkoutUrl || args.checkout_url) || '').trim();
      if (url) return url;
      return _cashierUrl(text);   /* 仅识别明确 cashier*.alipay.com 特征 */
    }
    /* M4：candidate 稳定指纹（规范化 title + price + sku） */
    function _fingerprint(c) {
      return String((c && c.title) || '').trim().toLowerCase() + '|' + Number(c && c.price) + '|' + String((c && c.sku) || '').trim().toLowerCase();
    }
    function _resolveSelected() {
      var a = _agent();
      if (a.selected == null) return null;
      var c = (a.candidates || []).find(function (x) { return String(x.id) === String(a.selected); });
      return c || null;
    }

    function _parseCandidate(args, text) {
      var title = String(args.title || args.productTitle || '').trim();
      if (!title) title = _extractTitle(args, text);
      if (!title && !(args.price != null || args.amount != null)) return null;
      var price = null;
      if (args.price != null) price = Number(args.price);
      else if (args.amount != null) price = Number(args.amount);
      else price = _extractAmount(args, text);
      return {
        id: String(args.id || ('cand_' + (aCounterId++))),
        title: title || '(未命名商品)',
        price: Number.isFinite(price) && price >= 0 ? price : 0,
        rating: args.rating != null ? Number(args.rating) : 0,
        deliveryDays: args.deliveryDays != null ? Number(args.deliveryDays) : 0,
        stock: String(args.stock != null ? args.stock : (args.inStock === false ? '缺货' : '有货')),
        sku: String(args.sku || args.spec || args.option || ''),
        url: String(args.url || args.productUrl || ''),   /* 商品页 URL（非收银台） */
        keywords: []
      };
    }
    var aCounterId = 0;

    function agentObserve(fullName, args, result) {
      var a = _agent();
      args = args || {};
      result = result || {};
      /* M1：halted 为终态，任何后续 observe 立即停止（不增加 step/failure/candidate/paymentIntent） */
      if (a.halted) { save(); return agentSnapshot(); }
      var text = [result.response, result.text].filter(Boolean).join('\n');
      a.step += 1;

      /* ① 失败处理：进入明确 STOP 状态，不静默继续 */
      if (result.ok === false || result.isError || /error|失败|异常|拒绝/i.test(String(result.reason || result.error || ''))) {
        a.failures += 1;
        a.lastAction = 'OBSERVE_FAIL';
        log('agent_fail', fullName + ' · ' + (result.reason || result.error || ''));
        if (a.failures >= a.maxFailures) { _halt(STOP_REASON.TOOL_FAILURE, '连续 ' + a.failures + ' 次工具失败，停止购物流程'); return agentSnapshot(); }
        save(); return agentSnapshot();
      }

      /* ② 收银台捕获（仅明确 cashier 特征/显式 checkoutUrl）→ CHECKOUT → Review */
      var checkout = _detectCheckout(args, text);
      if (checkout) {
        var orderId = _extractOrderId(text) || String(args.orderId || '');
        _state.session.checkoutUrl = checkout;
        _state.session.orderId = orderId;
        _state.session.amount = _extractAmount(args, text) != null ? _extractAmount(args, text) : (_state.session.amount);
        /* M2：同 orderId + checkoutUrl 只产生一个 PaymentIntent（幂等，不 last-wins） */
        var reuse = a.paymentIntent && a.paymentIntent.orderId === orderId && a.paymentIntent.checkoutUrl === checkout ? a.paymentIntent : null;
        if (!reuse) {
          a.paymentIntent = {
            id: 'pi_' + Date.now(), amount: _state.session.amount != null ? _state.session.amount : 0,
            currency: String(args.currency || 'CNY'), orderId: orderId,
            domain: String(args.domain || args.merchant || _domainOf(checkout)), merchant: String(args.merchant || ''),
            checkoutUrl: checkout, createdAt: _now(), expiresAt: _now() + 15 * 60000
          };
          a.reviewProduct = _resolveSelected() || rankCandidates()[0] || null;
        }
        a.intent = 'REVIEW';   /* CHECKOUT_STOP → 进入 Shopping Review */
        a.halted = true; a.haltedReason = STOP_REASON.CHECKOUT_STOP;
        a.reason = '已捕获收银台 URL，生成 PaymentIntent，等待人工审核（Phase 3B 到确认点即停，不调用真实支付）';
        log('agent_review', checkout);
        save();
        return { intent: 'REVIEW', halted: true, haltedReason: a.haltedReason, paymentIntent: reuse || a.paymentIntent, review: agentReview(), snapshot: agentSnapshot() };
      }

      /* ③ 候选注入（可观察到的商品） */
      var cand = _parseCandidate(args, text);
      if (cand && cand.title && (cand.price > 0 || cand.title)) {
        var key = _fingerprint(cand);
        var dup = (a.candidates || []).some(function (c) { return _fingerprint(c) === key; });
        if (!dup) { a.candidates.push(cand); a.intent = a.candidates.length >= 2 ? 'COMPARE' : (a.intent === 'SEARCH' ? 'OBSERVE' : a.intent); }
      }

      /* ④ 事件（如 checkout 前观察）：无候选且已到步数预算 → STOP */
      if (a.step >= a.maxSteps) { _halt(STOP_REASON.STEP_BUDGET, '达到最大观察步数 ' + a.maxSteps + '，停止继续搜索'); return agentSnapshot(); }
      /* 无候选且多次尝试 → NO_RESULTS */
      if (a.candidates.length === 0 && a.step >= 2) { _halt(STOP_REASON.NO_RESULTS, '多次观察仍无候选商品，未找到相关结果'); return agentSnapshot(); }

      save();
      return agentSnapshot();
    }

    var NEXT_HINT = { SEARCH: '发起搜索并返回商品列表', OBSERVE: '逐条查看候选商品详情（价格/评分/配送/库存）', FILTER: '过滤掉超预算/缺货的候选', COMPARE: '对候选做多准则排序，挑出最优', SELECT: '选定最优候选商品', SKU: '选择符合规格/颜色/尺码的 SKU', CHECKOUT: '进入结算并捕获收银台 URL，至此停止', STOP: '流程结束（见 reason）', DONE: '完成' };
    function agentNext() {
      var a = _agent();
      if (a.halted) return { action: 'STOP', intent: a.intent, reason: a.reason, halted: true, haltedReason: a.haltedReason, ranked: rankCandidates(), selected: a.selected, hint: NEXT_HINT.STOP };
      var ranked = rankCandidates();
      var inBudget = ranked.filter(function (r) { return r.inBudget; });
      /* 超预算 */
      var hasCandidate = (a.candidates || []).length > 0;
      var allOver = hasCandidate && inBudget.length === 0 && (a.task || {}).maxBudget;
      if (allOver) { _halt(STOP_REASON.OVER_BUDGET, '候选均超过预算 ' + a.task.maxBudget + ' 元'); return { action: 'STOP', intent: 'STOP', reason: a.reason, halted: true, haltedReason: STOP_REASON.OVER_BUDGET, ranked: ranked, hint: NEXT_HINT.STOP }; }
      if (!hasCandidate) return { action: 'SEARCH', intent: 'SEARCH', ranked: [], reason: '尚未搜索到候选商品', hint: NEXT_HINT.SEARCH };
      var best = inBudget[0] || ranked[0];
      var intent = a.candidates.length >= 2 ? 'COMPARE' : 'OBSERVE';
      /* SKU 约束未满足且存在规格偏好的候选较少时，需选 SKU */
      var needSku = (a.task || {}).skuPrefs && (a.task || {}).skuPrefs.length && !(a.candidates || []).some(function (c) { return String(c.sku || ''); });
      if (needSku) intent = 'SKU';
      return { action: intent, intent: intent, ranked: ranked, selected: best, reason: '' , hint: NEXT_HINT[intent] || NEXT_HINT.OBSERVE };
    }

    function _halt(reason, msg) { var a = _agent(); a.halted = true; a.haltedReason = reason; a.reason = msg || reason; a.intent = 'STOP'; save(); }
    function _domainOf(url) { try { return new URL(url).hostname; } catch (e) { return ''; } }
    function agentSnapshot() { return { active: _agent().active, intent: _agent().intent, halted: _agent().halted, haltedReason: _agent().haltedReason, reason: _agent().reason, task: _agent().task, candidates: _agent().candidates, selected: _resolveSelected(), step: _agent().step, maxSteps: _agent().maxSteps, failures: _agent().failures, ranked: rankCandidates(), lastAction: _agent().lastAction }; }

    /* ── Agent 生命周期管理 ── */
    function agentStart(task, opts) {
      opts = opts || {};
      var a = _agent();
      a.task = task || (opts.nl ? planShopping(opts.nl) : { keywords: _state.session.query ? [_state.session.query] : [], maxBudget: null, skuPrefs: [], quantity: 1, urgency: false });
      /* M5：新 session 必须完全清空上一 session 的 terminal/review/payment 残留 */
      a.active = true; a.intent = 'SEARCH'; a.halted = false; a.haltedReason = ''; a.reason = ''; a.step = 0; a.failures = 0; a.candidates = []; a.selected = null;
      a.paymentIntent = null; a.reviewProduct = null; a.reviewApproved = false; a.lastAction = ''; a.canonicalId = ''; a.canonicalNonce = '';
      _state.session.checkoutUrl = ''; _state.session.orderId = ''; _state.session.amount = null;
      a.maxSteps = Number(opts.maxSteps) || AGENT.MAX_STEPS;
      a.maxFailures = Number(opts.maxFailures) || AGENT.MAX_FAILURES;
      log('agent_start', '任务=' + JSON.stringify(a.task));
      save();
      return agentSnapshot();
    }
    function agentSetSelected(candidateId) {
      var a = _agent();
      var c = (a.candidates || []).find(function (x) { return String(x.id) === String(candidateId); });
      if (!c) return { ok: false, reason: '候选不存在' };
      a.selected = String(c.id); a.intent = 'SELECT'; save(); return agentSnapshot();
    }
    function agentAddCandidate(c) {
      var a = _agent();
      var cand = _parseCandidate(c || {}, '');
      if (!cand) return agentSnapshot();
      /* M4：按规范化 title+price+sku 指纹去重（区分同标题同价不同 SKU） */
      var key = _fingerprint(cand);
      var dedup = (a.candidates || []).some(function (x) { return _fingerprint(x) === key; });
      if (!dedup) a.candidates.push(cand);
      if (a.active && a.candidates.length >= 2) a.intent = 'COMPARE';
      save(); return agentSnapshot();
    }
    function agentFinish() { var a = _agent(); a.intent = 'DONE'; a.halted = true; a.haltedReason = 'USER_STOP'; a.reason = '由用户手动结束购物流程'; save(); return agentSnapshot(); }

    /* ══════════════════════════════════════════════════════════════
       PHASE 3B · SHOPPING REVIEW / HUMAN REVIEW（人工审核接管）
       ------------------------------------------------------------------
       在 CHECKOUT_STOP 生成可解释、可人工操作的审核状态：展示真实商品数据
       （标题/价格/评分/配送/SKU/商家域名/checkout），并把「AI 选择理由」绑定到
       实际 scorer / 约束（scoreDetail 逐项），绝不编造。动作：
         view_product / change_candidate / continue_checkout / stop
       只有 continue_checkout 才把 PaymentIntent 交回现有 PaymentAuth → PayGate；
       UI/浏览器不能自行声明 ALLOW（Bridge pay-gate 独立重算 decide）。无真实支付。
       ══════════════════════════════════════════════════════════════ */
    function scoreDetail(c, task) {
      var t = task || {};
      var W = AGENT.SCORE;
      var price = Number(c && c.price);
      var maxB = Number(t.maxBudget);
      var inBudget = !(maxB > 0) || (price > 0 && price <= maxB);
      var priceScore = price > 0 ? Math.max(0, 1 - price / Math.max(1, maxB > 0 ? maxB : price * 1.5)) : 0;
      var rating = Number(c && c.rating);
      var ratingScore = rating > 0 ? Math.min(1, rating / 5) : 0.3;
      var delivery = Number(c && c.deliveryDays) || 7;
      var deliveryScore = delivery > 0 ? Math.max(0, 1 - (delivery - 1) / 14) : 0.5;
      var stock = String((c && c.stock) || '').toLowerCase();
      var stockScore = (stock === '缺货' || stock === 'out' || c.stock === 0) ? 0 : 1;
      var skuMatch = (t.skuPrefs || []).length ? ((t.skuPrefs || []).some(function (p) { return String(c && c.sku || '').indexOf(p) >= 0; }) ? 1 : 0.4) : 1;
      var kw = (t.keywords || []).filter(Boolean);
      var kwHit = kw.length ? kw.filter(function (k) { return String((c && c.title) + ' ' + ((c && c.keywords || []).join(' '))).indexOf(k) >= 0; }).length / kw.length : 0.6;
      var total = W.price * priceScore + W.rating * ratingScore + W.delivery * deliveryScore + W.stock * stockScore + W.sku * skuMatch + W.keyword * kwHit;
      function part(name, label, s, w, value, reason) {
        return { name: name, label: label, weight: w, score: Math.round(s * 1000) / 1000, value: value, reason: reason, contrib: Math.round(s * w * 1000) / 1000 };
      }
      var parts = [
        part('price', '价格', priceScore, W.price, price + (maxB > 0 ? (' / 预算' + maxB) : ''),
          price > 0 ? (maxB > 0 ? (price <= maxB ? '低价优先：' + price + ' ≤ ' + maxB + ' 元' : '超出预算') : '低价优先') : '未知价格'),
        part('rating', '评分', ratingScore, W.rating, rating + '/5',
          rating > 0 ? (rating >= 4.5 ? '高评分' : (rating >= 4 ? '评分良好' : '评分偏低')) : '无评分'),
        part('delivery', '配送', deliveryScore, W.delivery, (delivery || '-') + ' 天',
          delivery > 0 ? (delivery <= 3 ? '到货快' : (delivery <= 7 ? '常规配送' : '配送偏慢')) : '未知'),
        part('stock', '库存', stockScore, W.stock, String((c && c.stock) != null ? c.stock : ''),
          stockScore > 0 ? '有货' : '缺货'),
        part('sku', '规格', skuMatch, W.sku, String((c && c.sku) || ('偏好:' + (t.skuPrefs || []).join('/'))),
          skuMatch >= 1 ? '已匹配规格' : '未匹配规格'),
        part('keyword', '关键词', kwHit, W.keyword, (kw || []).slice(0, 3).join('/'),
          kwHit > 0 ? '命中需求关键词' : '未命中关键词')
      ];
      return { id: c && c.id, title: c && c.title, price: price, rating: rating, deliveryDays: delivery, stock: c && c.stock, sku: c && c.sku, total: Math.round(total * 1000) / 1000, inBudget: inBudget, parts: parts };
    }

    function agentReview() {
      var a = _agent();
      if (!a.active || !a.halted || a.haltedReason !== STOP_REASON.CHECKOUT_STOP) {
        return { ok: false, intent: a.intent || 'IDLE', reason: '无待审核的购物状态（需先 CHECKOUT_STOP → Review）', actions: [] };
      }
      var prod = a.reviewProduct || _resolveSelected() || rankCandidates()[0] || null;
      var task = a.task || {};
      var detail = prod ? scoreDetail(prod, task) : null;
      var pi = a.paymentIntent;
      var domain = String((pi && pi.domain) || _domainOf((prod && prod.url) || '')) || '';
      var reasons = [];
      if (detail) detail.parts.forEach(function (p) { if (p.value != null && p.value !== '') reasons.push(p.label + '：' + p.reason); });
      if (task.maxBudget > 0) reasons.push('预算：' + (detail && detail.inBudget === false ? '超出预算 ' + task.maxBudget : '符合 ' + task.maxBudget + ' 元上限'));
      if ((task.skuPrefs || []).length) reasons.push('规格：' + (String((prod && prod.sku) || '').indexOf(task.skuPrefs[0]) >= 0 ? '已选 ' + task.skuPrefs[0] : '未选 ' + task.skuPrefs[0]));
      return {
        ok: true, intent: 'REVIEW', halted: true, haltedReason: STOP_REASON.CHECKOUT_STOP,
        product: prod ? { title: prod.title, price: prod.price, rating: prod.rating, deliveryDays: prod.deliveryDays, stock: prod.stock, sku: prod.sku, url: prod.url, domain: domain, merchant: (pi && pi.merchant) || '' } : null,
        checkout: { status: 'captured', url: (pi && pi.checkoutUrl) || '' },
        selectionReason: reasons,
        reasonText: reasons.join('；'),
        ranked: rankCandidates(),
        paymentIntent: pi,
        scoreDetail: detail,
        actions: ['view_product', 'change_candidate', 'continue_checkout', 'stop'],
        snapshot: agentSnapshot()
      };
    }

    function agentSetCanonical(canonicalId, nonce) {
      var a = _agent();
      if (!a.paymentIntent) return { ok: false, reason: '无 PaymentIntent 可绑定 canonical' };
      a.canonicalId = String(canonicalId || '');
      a.canonicalNonce = String(nonce || '');
      save();
      return { ok: true, canonicalId: a.canonicalId, nonce: a.canonicalNonce };
    }

    function agentContinue() {
      var a = _agent();
      if (!a.halted || a.haltedReason !== STOP_REASON.CHECKOUT_STOP || !a.paymentIntent) {
        return { ok: false, reason: '无待继续结算的审核状态（请先 CHECKOUT_STOP → Review）' };
      }
      a.reviewApproved = true; a.intent = 'CHECKOUT'; a.lastAction = 'CONTINUE_CHECKOUT';
      save();
      return { ok: true, intent: 'CHECKOUT', paymentIntent: a.paymentIntent, canonicalId: a.canonicalId || '', nonce: a.canonicalNonce || '', note: '已通过人工审核继续结算；真实支付由 Bridge 依据 canonical PaymentIntent 独立重算授权（UI 不能声明 ALLOW）' };
    }

    function agentChangeCandidate(candidateId) {
      var a = _agent();
      if (candidateId) a.selected = String(candidateId);
      /* M3：更换候选后，旧商品的 checkout/PI/review 及 session checkout 状态全部失效 */
      a.halted = false; a.haltedReason = ''; a.reason = ''; a.paymentIntent = null; a.reviewProduct = null; a.reviewApproved = false; a.canonicalId = ''; a.canonicalNonce = '';
      _state.session.checkoutUrl = ''; _state.session.orderId = ''; _state.session.amount = null;
      a.intent = (a.candidates || []).length >= 2 ? 'COMPARE' : ((a.candidates || []).length ? 'SELECT' : 'OBSERVE');
      a.lastAction = 'CHANGE_CANDIDATE';
      log('agent_change', '用户更换候选，回到比较状态');
      save();
      return agentSnapshot();
    }

    function agentStop() { _halt(STOP_REASON.USER_STOP, '用户停止购物（Human Review 停止）'); return agentSnapshot(); }

    /* ── 导出 ── */
    function current() { return JSON.parse(JSON.stringify(_state)); }

    return {
      LIMITS: LIMITS,
      STAGES: STAGES,
      PAYMENT_BOUNDARY: PAYMENT_BOUNDARY,
      create: createCommerce,
      configure: configure,
      reset: reset,
      startSession: startSession,
      setProduct: setProduct,
      setSku: setSku,
      captureCheckout: captureCheckout,
      observeToolResult: observeToolResult,
      nextStep: nextStep,
      budget: budget,
      canSpend: canSpend,
      statusBlock: statusBlock,
      submitPayment: submitPayment,
      current: current,
      /* PHASE 3A · Shopping Agent */
      AGENT_STEPS: AGENT_STEPS,
      AGENT: AGENT,
      STOP_REASON: STOP_REASON,
      planShopping: planShopping,
      agentStart: agentStart,
      agentObserve: agentObserve,
      agentNext: agentNext,
      agentAddCandidate: agentAddCandidate,
      agentSetSelected: agentSetSelected,
      agentFinish: agentFinish,
      rankCandidates: rankCandidates,
      scoreCandidate: scoreCandidate,
      agentSnapshot: agentSnapshot,
      /* PHASE 3B · Shopping Review / Human Review */
      scoreDetail: scoreDetail,
      agentReview: agentReview,
      agentContinue: agentContinue,
      agentChangeCandidate: agentChangeCandidate,
      agentStop: agentStop,
      agentSetCanonical: agentSetCanonical,
      /* 内部（测试/高级用途） */
      _stages: ORDER
    };
  }

  return { create: createCommerce, LIMITS: LIMITS, STAGES: STAGES, PAYMENT_BOUNDARY: PAYMENT_BOUNDARY };
});
