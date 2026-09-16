/* ====================================================================
   IB · Economy Approval UI — 渲染器（P22-15）
   --------------------------------------------------------------------
   这一页回答的问题只有一个：

     「某个角色想做一件事，需要你决定。」

   它**不是** Ecoonomy 的管理台，也不是钱包。它渲染的是 P22-13 那条
   决定路径的读面，而那条路径的写面只有一个动作：允许继续 / 拒绝请求。

   ── DOM 与逻辑的分工 ────────────────────────────────────────────────
   · 视图模型、文案映射、请求体构造全在 assets/js/economy-approval-core.js
     （纯层，可在 Node 里测）；
   · 本文件只做四件事：注入样式表、读三个只读面、建 DOM、把用户手势交给
     home-node-client 的 approvalDecision()。

   ── 它**不**做的（逐条对着 §5 / §6 / §15 / §16 / §17）───────────────
   · 不发任何 /economy/* 的写请求：整个文件里没有 fetch()。唯一的写动作
     是 _sendDecision() → driver.approvalDecision(...)，而那个方法自己
     构造恰好三个字段的 body。
   · 不判定任何经济事实：余额够不够、预算剩余、自主裁决、批准有效性、
     报价有效性、购买是否成功 —— 六个都不算。按钮的文字是「允许继续」
     而不是「购买」，因为批准之后仍可能被预算 / 报价 / 结算拦下。
   · 不做"乐观成功"：点击之后只把按钮置为进行中，然后**重新读** canonical
     状态；卡片显示的是读面说的，不是我们希望的。
   · 不做 P22-14 的配置面、不做 Store / Wallet / Inventory / Catalog /
     Activity 页面。商品信息只用来渲染这条请求。
   ==================================================================== */
(function (NS) {
'use strict';

var CORE = NS.economyApprovalCore;
if (!CORE) return; /* 纯层没加载：整页不渲染，而不是渲染一个错的页面 */

var DOM = {
  HOST: CORE.ID.HOST,
  STYLE_ID: 'ib-econ-appr-style',
  STYLE_HREF: 'assets/css/economy-approval.css'
};

var READ_LIMIT = 60;
var HISTORY_VISIBLE_DEFAULT = CORE.HISTORY_LIMIT;

/* 上一句人话与"决定面还没打开"的那一句。 */
var COPY = Object.freeze({
  title: '待决定',
  subtitle: 'Requests',
  intro: '当某个角色想做一件需要你点头的事，它会出现在这里。',
  emptyTitle: '暂时没有需要你决定的请求',
  emptyBody: '角色提出需要确认的内部购买时，会出现在这里。',
  historyTitle: '近期的决定',
  historyMore: '再看一些',
  allow: '允许继续',
  reject: '拒绝请求',
  rejectAsk: '确定拒绝？',
  rejectNo: '再想想',
  allowInFlight: '正在允许…',
  inFlight: '正在进行…',
  refresh: '刷新',
  refreshing: '读取中…',
  detail: '细节',
  detailHide: '收起',
  retry: '再试一次',
  configHint: '这台设备还没有配置本机节点的访问凭据，因此"允许继续"现在不会生效。聊天与其它功能不受影响。',
  detailNote: '允许之后仍要由预算与报价自己放行 —— 批准不等于买到。'
});

/* 状态徽标的小图形（11px 线性，currentColor）。 */
var MARK = {
  waiting: '<circle cx="5.5" cy="5.5" r="4.2"/><path d="M5.5 3.4v2.4l1.6 1"/>',
  progress: '<path d="M5.5 1.6a3.9 3.9 0 1 0 3.9 3.9"/><path d="M5.5 3.4V5.5h2.1"/>',
  done: '<path d="M1.6 5.8l2.6 2.6 5.2-6"/>',
  denied: '<path d="M2 2l7 7M9 2l-7 7"/>',
  expired: '<circle cx="5.5" cy="5.5" r="4.2"/><path d="M5.5 3.2v2.6l1.7 1.7"/>',
  failed: '<path d="M5.5 2v4.2"/><circle cx="5.5" cy="8.6" r=".8"/>'
};

/* 商品类别（24×24 · currentColor · 统一 stroke）。 */
var KIND_ICON = {
  DIGITAL_ITEM: '<path d="M5 3.2h14v17.6H5z"/><path d="M9 7.4h6"/><path d="M9 11h6"/><path d="M9 14.6h3.4"/>',
  CONSUMABLE: '<path d="M4.6 7.6h14.8l-1.7 13.2H6.3z"/><path d="M8.4 7.6V5.4a3.6 3.6 0 0 1 7.2 0v2.2"/>',
  API_QUOTA: '<path d="M9.4 7.4 5.2 12l4.2 4.6"/><path d="M14.6 7.4 18.8 12l-4.2 4.6"/>',
  COMPUTE_CREDIT: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.4"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M9.6 3.4v3M14.4 3.4v3M9.6 17.6v3M14.4 17.6v3M3.4 9.6h3M3.4 14.4h3M17.6 9.6h3M17.6 14.4h3"/>',
  SERVICE: '<circle cx="12" cy="12" r="3.4"/><path d="M12 3.2v3.4M12 17.4v3.4M3.2 12h3.4M17.4 12h3.4"/><path d="M6.2 6.2 8.6 8.6M15.4 15.4l2.4 2.4M17.8 6.2l-2.4 2.4M8.6 15.4l-2.4 2.4"/>'
};
var KIND_ICON_DEFAULT = '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.4 12h7.2"/>';

/* 空状态：一只安静的空托盘（§9）。线性轮廓 · currentColor · 无金币无购物车。 */
var EMPTY_ART = [
  '<svg class="ec-empty-art" viewBox="0 0 160 120" width="160" height="120" role="img"',
  ' aria-label="空的托盘" fill="none" stroke="currentColor" stroke-width="1.4"',
  ' stroke-linecap="round" stroke-linejoin="round" focusable="false">',
  '<path d="M18 96h124"/>',
  '<path d="M28 96 38 62h84l10 34" opacity=".55"/>',
  '<path d="M46 62V40h20v22"/>',
  '<path d="M94 62V34h20v28"/>',
  '<path d="M56 34v-9"/>',
  '<path d="M104 28v-9"/>',
  '<path d="M74 52h12" opacity=".45"/>',
  '<path d="M78 30c0-2.4 1.8-3 1.8-5.4 0-2-1.4-3.4-1.8-4.6" opacity=".38"/>',
  '<path d="M86 30c0-2.4 1.8-3 1.8-5.4 0-2-1.4-3.4-1.8-4.6" opacity=".28"/>',
  '</svg>'
].join('');

function boot() {
  if (typeof document === 'undefined' || !document.head) return;

  injectStyle();

  /* ── 状态 ─────────────────────────────────────────────────────── */
  var stage = 'idle';
  var view = null;
  var failure = null;
  var syncedAt = null;
  var pending = Object.create(null);   /* approvalId → { decision, key } */
  var confirmReject = Object.create(null);
  var decisionNotes = null;            /* approvalId → classifyDecisionResponse 结果 */
  var historyVisible = HISTORY_VISIBLE_DEFAULT;
  var seq = 0;
  /* `/security` 说的"决定路径现在开不开"：null = 不知道（读不到那一条自述）。
     它**不**禁用按钮 —— 只是把"为什么按了不会生效"提前说出来。 */
  var decisionReady = null;

  /* ── 最小 DOM 助手 ─────────────────────────────────────────────── */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function svgOf(markup, cls) {
    var wrap = document.createElement('span');
    if (cls) wrap.className = cls;
    wrap.innerHTML = '<svg viewBox="0 0 11 11" width="11" height="11" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + markup + '</svg>';
    return wrap;
  }
  function kindIconOf(kind) {
    var wrap = document.createElement('span');
    wrap.className = 'ec-kind-icon';
    var body = KIND_ICON[String(kind)] || KIND_ICON_DEFAULT;
    wrap.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
    return wrap;
  }
  function injectStyle() {
    if (byId(DOM.STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = DOM.STYLE_ID;
    link.rel = 'stylesheet';
    link.href = DOM.STYLE_HREF;
    document.head.appendChild(link);
  }

  /* ── 传输 ─────────────────────────────────────────────────────────
     ★ 唯一的出口是既有 remote driver。本文件不出现 fetch()，
       因此 §15 那条"UI 不得直接 POST /economy/*"是**结构**事实。
     ★ 测试注入入口：window.__ibEconomyDecisionDriver。它只是替换
       driver 实例，**不**改变请求体的构造点（那在纯层里）。 */
  function driver() {
    if (NS.__ibEconomyDecisionDriver) return NS.__ibEconomyDecisionDriver;
    if (typeof NS.createHomeNodeRemote === 'function') return NS.createHomeNodeRemote({});
    return null;
  }
  function readJson(path, query) {
    var d = driver();
    if (!d || typeof d.getJson !== 'function') {
      return Promise.resolve({ ok: false, error: 'transport-not-available' });
    }
    return d.getJson(path, query);
  }

  /* ── 读：四条既有只读面 ─────────────────────────────────────────────
     ★ 第四条 `/security` 只回答一个问题：这条决定路径现在开不开。
       它是 `/security` 早就有的自述面（P11-3A），本阶段没有为它新增任何
       东西，也没有让 UI 自己判断凭据 —— 判定权在权威那边。 */
  function load() {
    var my = ++seq;
    stage = view ? 'refreshing' : 'loading';
    failure = null;
    render();
    var q = '?limit=' + READ_LIMIT;
    return Promise.all([
      readJson(CORE.READS.INTENTS, q),
      readJson(CORE.READS.APPROVALS, q),
      readJson(CORE.READS.PRODUCTS, q),
      readJson(CORE.READS.SECURITY, '')
    ]).then(function (results) {
      if (my !== seq) return null;
      var intents = results[0], approvals = results[1], products = results[2];
      var gate = CORE.decisionGate(results[3]);
      decisionReady = gate ? gate.open : null;
      var bad = null;
      if (!approvals || approvals.ok !== true) bad = (approvals && approvals.error) || 'approvals-unavailable';
      if (!intents || intents.ok !== true) bad = bad || (intents && intents.error) || 'intents-unavailable';
      if (!Array.isArray(intents && intents.intents)) bad = bad || 'intents-malformed';
      if (!Array.isArray(approvals && approvals.approvals)) bad = bad || 'approvals-malformed';
      if (bad) {
        stage = 'failed';
        failure = { kind: (bad === 'intents-malformed' || bad === 'approvals-malformed') ? 'malformed' : 'read', code: bad };
        failure.text = (CORE.classifyReadFailure(bad) || {}).text || '读取失败';
        syncedAt = null;
        render();
        return null;
      }
      if (products && products.ok !== true) {
        /* 商品信息取不到**不**让整页失败：卡片照样显示，只是产品名缺着。
           缺着是诚实的；编一个名字不是。 */
        products = { ok: true, products: [] };
      }
      if (!Array.isArray(products && products.products)) products = { ok: true, products: [] };
      view = CORE.buildView({
        intents: intents.intents,
        approvals: approvals.approvals,
        products: products.products
      }, { decisions: decisionNotes, now: Date.now() });
      stage = 'ready';
      failure = null;
      syncedAt = Date.now();
      render();
      return view;
    }, function (error) {
      if (my !== seq) return null;
      stage = 'failed';
      failure = { kind: 'transport', text: '读取失败', detail: String((error && error.message) || error) };
      render();
      return null;
    });
  }

  /* ── 写：P22-13 seam（唯一一处写）────────────────────────────────── */
  function sendDecision(approvalId, decision) {
    if (pending[approvalId]) return Promise.resolve(null);
    var slot = pending[approvalId] = {
      decision: decision,
      key: CORE.newIdempotencyKey('econ-appr-' + decision.toLowerCase())
    };
    if (!decisionNotes) decisionNotes = Object.create(null);
    delete decisionNotes[approvalId];
    render();
    var d = driver();
    if (!d || typeof d.approvalDecision !== 'function') {
      delete pending[approvalId];
      flash('这里还没有可用的本机节点连接', 'bad');
      render();
      return Promise.resolve(null);
    }
    var built = CORE.buildDecisionRequest(approvalId, decision, slot.key);
    if (built.ok !== true) {
      delete pending[approvalId];
      flash('这次操作没有构造出合法的请求', 'bad');
      render();
      return Promise.resolve(null);
    }
    return Promise.resolve(d.approvalDecision(built.body)).then(function (res) {
      delete pending[approvalId];
      var note = CORE.classifyDecisionResponse(res);
      decisionNotes[approvalId] = note;
      flash(note.text + (note.outcome === 'approved-not-continued' ? ' —— 但没有继续' : ''), note.ok ? '' : 'bad');
      return load();
    }, function (error) {
      delete pending[approvalId];
      var note = CORE.classifyDecisionResponse({ ok: false, error: 'home-node-transport-error' });
      note.detail = String((error && error.message) || error);
      decisionNotes[approvalId] = note;
      flash('这次操作没有送达本机节点', 'bad');
      render();
      return null;
    });
  }

  /* ── 反馈：既有的 toast（core.js 的实现），失败时不吞状态 ─────────── */
  function flash(text, tone) {
    try {
      if (typeof window.toast === 'function') {
        window.toast(tone === 'bad' ? (text + ' · 卡片上的状态仍是权威给的那个') : text);
        return;
      }
    } catch (e) { /* 没有 toast 也不能吞掉反馈 */ }
    try { if (window.console && console.info) console.info('[Economy] ' + text); } catch (e) { /* 无 console */ }
  }

  /* ── 渲染 ───────────────────────────────────────────────────────── */
  function render() {
    var host = byId(DOM.HOST);
    if (!host) return;
    host.textContent = '';
    host.appendChild(toolbar());
    /* 决定路径关着（未配置桌面凭据）时**提前**说清楚：用户不该等到点一下
       才发现不会生效。这只是把 `/security` 已经说过的话写在页面上。 */
    if (stage === 'ready' && decisionReady === false) host.appendChild(gateNotice());
    if (stage === 'loading' || stage === 'refreshing') host.appendChild(skeleton());
    if (stage === 'failed' && failure) host.appendChild(failureSurface());
    if (stage === 'ready' && view) {
      if (view.waiting.length === 0) host.appendChild(emptySurface());
      else {
        var list = el('div', 'ec-list');
        for (var i = 0; i < view.waiting.length; i++) list.appendChild(card(view.waiting[i], true));
        host.appendChild(list);
      }
      if (view.history.length) host.appendChild(historySection());
    }
  }

  function gateNotice() {
    var n = el('div', 'ec-gate');
    n.setAttribute('role', 'status');
    n.appendChild(el('span', 'ec-gate-dot', ''));
    n.appendChild(el('span', 'ec-gate-text', COPY.configHint));
    return n;
  }

  function toolbar() {
    var bar = el('div', 'ec-bar');
    var left = el('div', 'ec-bar-left');
    var h2 = el('h2', 'ec-title', COPY.title);
    var sub = el('span', 'ec-sub', COPY.subtitle);
    left.appendChild(h2);
    left.appendChild(sub);
    bar.appendChild(left);

    var right = el('div', 'ec-bar-right');
    var sync = el('span', 'ec-sync', stage === 'refreshing' ? COPY.refreshing : (syncedAt ? ('同步于 ' + CORE.relativeTime(syncedAt, Date.now())) : ''));
    sync.setAttribute('aria-live', 'polite');
    right.appendChild(sync);
    var refresh = el('button', 'btn ec-refresh', COPY.refresh);
    refresh.type = 'button';
    refresh.disabled = stage === 'loading' || stage === 'refreshing';
    refresh.addEventListener('click', function () { load(); });
    right.appendChild(refresh);
    bar.appendChild(right);
    return bar;
  }

  function skeleton() {
    var list = el('div', 'ec-list');
    for (var i = 0; i < 2; i++) {
      var cardEl = el('article', 'ec-card ec-card-skeleton');
      cardEl.setAttribute('aria-hidden', 'true');
      cardEl.appendChild(el('div', 'ec-sk ec-sk-head'));
      cardEl.appendChild(el('div', 'ec-sk ec-sk-surface'));
      cardEl.appendChild(el('div', 'ec-sk ec-sk-line'));
      cardEl.appendChild(el('div', 'ec-sk ec-sk-foot'));
      list.appendChild(cardEl);
    }
    var note = el('p', 'ec-sr', stage === 'refreshing' ? '正在重新读取' : '正在读取');
    list.appendChild(note);
    return list;
  }

  function surface(cls) {
    var s = el('section', cls);
    var art = el('div', 'ec-surface-art');
    art.innerHTML = EMPTY_ART;
    s.appendChild(art);
    return s;
  }

  function emptySurface() {
    var s = surface('ec-surface ec-surface-empty');
    s.appendChild(el('p', 'ec-surface-title', COPY.emptyTitle));
    s.appendChild(el('p', 'ec-surface-body', COPY.emptyBody));
    var hint = el('p', 'ec-surface-hint', COPY.intro);
    s.appendChild(hint);
    return s;
  }

  function failureSurface() {
    var s = surface('ec-surface ec-surface-failed');
    /* ★ 标题由**本地**文案决定，而不是用 failure.text：一条读面失败在
       transport 词表里未必有对应句（例如 intents-malformed），那时
       failure.text 只是一句兜底，把它当标题会把"数据不成形"说成"连不上"。 */
    var title = failure.kind === 'malformed' ? '读到的数据不成形' : (failure.text || '读不到本机节点');
    s.appendChild(el('p', 'ec-surface-title', title));
    if (failure.kind === 'malformed') {
      s.appendChild(el('p', 'ec-surface-body', '本机节点回答了，但那份数据不是这一页认识的形状 —— 因此这里什么都不显示，也不猜。'));
    } else if (failure.code === 'ECONOMY_APPROVAL_DECISION_DESKTOP_TOKEN_NOT_CONFIGURED') {
      s.appendChild(el('p', 'ec-surface-body', COPY.configHint));
    } else {
      s.appendChild(el('p', 'ec-surface-body', '本机节点可能还没起来。重启 InternalBeyond 之后再试一次。'));
    }
    if (failure.detail) {
      var det = el('p', 'ec-surface-detail', String(failure.detail).slice(0, 200));
      s.appendChild(det);
    }
    var again = el('button', 'btn ec-surface-action', COPY.retry);
    again.type = 'button';
    again.addEventListener('click', function () { load(); });
    s.appendChild(again);
    return s;
  }

  /* ── 一张卡片 ───────────────────────────────────────────────────── */
  function card(item, actionable) {
    var waiting = actionable && item.kind === 'waiting' && item.approvalId != null;
    var busy = pending[item.approvalId];
    var c = el('article', 'ec-card ec-tone-' + item.statusTone + (waiting ? ' ec-card-waiting' : ' ec-card-quiet'));
    c.setAttribute('data-approval-id', item.approvalId || '');
    c.setAttribute('data-status', item.statusCode || '');
    if (busy) c.setAttribute('aria-busy', 'true');

    /* ① 谁在请求。
       ★ 徽标放进 .ec-who 里，而不是与头像平级：手机端换行时它自然缩进到
         名字那一列的下面（而不是横跨整行、与头像对齐）。 */
    var head = el('header', 'ec-head');
    head.appendChild(avatar(item.agentId));
    var who = el('div', 'ec-who');
    var nameRow = el('div', 'ec-who-line');
    nameRow.appendChild(el('span', 'ec-name', agentName(item.agentId)));
    var badge = el('span', 'ec-badge ec-badge-' + item.statusTone);
    badge.appendChild(svgOf(MARK[item.statusTone] || MARK.progress));
    badge.appendChild(el('span', 'ec-badge-text', item.statusLabel));
    nameRow.appendChild(badge);
    who.appendChild(nameRow);
    who.appendChild(el('span', 'ec-ask', item.ask));
    head.appendChild(who);
    c.appendChild(head);

    /* ② 想要的那件东西 */
    var ps = el('div', 'ec-product');
    if (item.productMissing) {
      ps.classList.add('ec-product-unknown');
      ps.appendChild(el('span', 'ec-product-name', '一件已经读不到的内容'));
    } else {
      ps.appendChild(kindIconOf(item.productKindRaw));
      var ptext = el('div', 'ec-product-text');
      var nm = el('span', 'ec-product-name', item.productName);
      ptext.appendChild(nm);
      if (item.productKind) ptext.appendChild(el('span', 'ec-product-kind', item.productKind));
      if (item.productDescription) ptext.appendChild(el('span', 'ec-product-desc', item.productDescription));
      ps.appendChild(ptext);
    }
    c.appendChild(ps);

    /* ③ 她自己给的理由 */
    if (item.reason) {
      var r = el('blockquote', 'ec-reason');
      r.appendChild(el('span', 'ec-reason-mark', '“'));
      r.appendChild(el('span', 'ec-reason-text', item.reason));
      r.appendChild(el('span', 'ec-reason-mark ec-reason-mark-end', '”'));
      c.appendChild(r);
    }

    /* ④ 数字与权威事实 */
    var facts = el('div', 'ec-facts');
    var figs = el('div', 'ec-figures');
    if (item.amountText) {
      figs.appendChild(el('span', 'ec-amount', item.amountText));
    } else {
      figs.appendChild(el('span', 'ec-amount ec-amount-unknown', '金额未提供'));
    }
    if (item.units != null) figs.appendChild(el('span', 'ec-units', '× ' + item.units));
    if (item.recipientId) figs.appendChild(el('span', 'ec-recipient', '给 ' + agentName(item.recipientId)));
    facts.appendChild(figs);
    if (item.facts.length) {
      var dl = el('dl', 'ec-attrs');
      for (var i = 0; i < item.facts.length; i++) {
        dl.appendChild(el('dt', 'ec-attr-k', item.facts[i].label));
        dl.appendChild(el('dd', 'ec-attr-v', item.facts[i].value));
      }
      facts.appendChild(dl);
    }
    c.appendChild(facts);

    /* ⑤ 动作 */
    if (waiting) c.appendChild(actions(item, busy));
    else c.appendChild(resultLine(item));

    /* ⑥ 细节（默认收起；ID 与 canonical 词只在这里出现） */
    c.appendChild(detailBlock(item));
    return c;
  }

  function actions(item, busy) {
    var box = el('div', 'ec-actions');
    var note = el('p', 'ec-action-note', item.statusNote || '');
    box.appendChild(note);
    /* ★ 上一次决定被拒时，把**它**的原因贴在这里：卡片仍然停在"等待你的
       决定"（那是权威给的 canonical 状态），而用户需要知道刚才那一下为
       什么没生效。两者不是竞争关系：一个是状态，一个是这一次操作的结果。 */
    if (!busy && item.decisionNote && item.decisionNote.ok !== true) {
      box.appendChild(el('p', 'ec-action-result ec-action-result-warn',
        item.decisionNote.text + (item.decisionNote.detail ? '（' + item.decisionNote.detail + '）' : '')));
    }
    var row = el('div', 'ec-action-row');
    var asking = confirmReject[item.approvalId] === true;

    var rejecting = !!(busy && busy.decision === CORE.DECISION.REJECT);
    var no = el('button', 'btn ec-btn-reject',
      rejecting ? COPY.inFlight : (asking ? COPY.rejectAsk : COPY.reject));
    no.type = 'button';
    no.disabled = !!busy;
    if (rejecting) no.appendChild(el('span', 'ec-spin'));
    no.addEventListener('click', function () {
      if (pending[item.approvalId]) return;         /* 双击保护（第二次点击直接返回） */
      if (confirmReject[item.approvalId] !== true) {
        confirmReject[item.approvalId] = true;
        render();
        return;
      }
      delete confirmReject[item.approvalId];
      sendDecision(item.approvalId, CORE.DECISION.REJECT);
    });
    row.appendChild(no);

    if (asking) {
      var back = el('button', 'btn ec-btn-keep', COPY.rejectNo);
      back.type = 'button';
      back.disabled = !!busy;
      back.addEventListener('click', function () {
        delete confirmReject[item.approvalId];
        render();
      });
      row.appendChild(back);
    }

    var yes = el('button', 'btn btn-primary ec-btn-allow', busy && busy.decision === CORE.DECISION.APPROVE ? COPY.allowInFlight : COPY.allow);
    yes.type = 'button';
    yes.disabled = !!busy;
    if (busy) {
      yes.classList.add('ec-btn-busy');
      yes.appendChild(el('span', 'ec-spin'));
    }
    yes.addEventListener('click', function () {
      if (pending[item.approvalId]) return;         /* 双击保护 */
      sendDecision(item.approvalId, CORE.DECISION.APPROVE);
    });
    row.appendChild(yes);
    box.appendChild(row);
    return box;
  }

  function resultLine(item) {
    var box = el('div', 'ec-result');
    if (item.statusNote) box.appendChild(el('p', 'ec-result-note', item.statusNote));
    var note = item.decisionNote;
    if (note && note.detail) {
      var d = el('p', 'ec-result-detail' + (note.ok ? '' : ' ec-result-detail-warn'), note.detail);
      box.appendChild(d);
    }
    return box;
  }

  function detailBlock(item) {
    var wrap = el('div', 'ec-detail');
    var toggle = el('button', 'ec-detail-toggle', COPY.detail);
    toggle.type = 'button';
    var body = el('dl', 'ec-detail-body');
    body.hidden = true;
    var rows = [
      ['请求', item.intentId],
      ['许可', item.approvalId],
      ['商品', item.productId],
      ['报价', item.quoteId],
      ['购买', item.purchaseId],
      ['角色', item.agentId],
      ['币种', item.currency],
      ['状态码', item.statusCode]
    ];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][1] == null) continue;
      body.appendChild(el('dt', null, rows[i][0]));
      body.appendChild(el('dd', null, String(rows[i][1])));
    }
    for (var f = 0; f < item.facts.length; f++) {
      if (!item.facts[f].code) continue;
      body.appendChild(el('dt', null, item.facts[f].label + '（原词）'));
      body.appendChild(el('dd', null, item.facts[f].code));
    }
    body.appendChild(el('dt', null, '批准不等于买到'));
    body.appendChild(el('dd', null, COPY.detailNote));
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', function () {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? COPY.detail : COPY.detailHide;
      toggle.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    });
    wrap.appendChild(toggle);
    wrap.appendChild(body);
    return wrap;
  }

  function historySection() {
    var s = el('section', 'ec-history');
    var head = el('div', 'ec-history-head');
    head.appendChild(el('h3', 'ec-history-title', COPY.historyTitle));
    if (view.historyTruncated) head.appendChild(el('span', 'ec-history-count', '共 ' + view.historyTotal + ' 条'));
    s.appendChild(head);
    var list = el('div', 'ec-history-list');
    var shown = view.history.slice(0, historyVisible);
    for (var i = 0; i < shown.length; i++) list.appendChild(card(shown[i], false));
    s.appendChild(list);
    if (view.history.length > shown.length) {
      var more = el('button', 'btn ec-history-more', COPY.historyMore);
      more.type = 'button';
      more.addEventListener('click', function () { historyVisible += 12; render(); });
      s.appendChild(more);
    }
    return s;
  }

  /* ── 角色：名字与头像都来自既有唯一事实源 ──────────────────────────
     ★ apiConfigs 是角色的唯一事实源（P4 契约）—— 这里**不**建第二套角色表，
       只在找不到时才退回 id 本身。头像同理：cfg.avatar。 */
  function roleConfig(agentId) {
    try {
      var list = (typeof apiConfigs !== 'undefined' && Array.isArray(apiConfigs)) ? apiConfigs : null;
      if (!list) return null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].id) === String(agentId)) return list[i];
      }
      var arch = (typeof archivedConfigs !== 'undefined' && Array.isArray(archivedConfigs)) ? archivedConfigs : null;
      if (arch) {
        for (var j = 0; j < arch.length; j++) {
          if (arch[j] && String(arch[j].id) === String(agentId)) return arch[j];
        }
      }
    } catch (e) { /* 目录不可读时退回 id */ }
    return null;
  }
  function agentName(agentId) {
    var cfg = roleConfig(agentId);
    if (cfg) {
      var n = cfg.nickname || cfg.model;
      if (n) return String(n);
    }
    return agentId == null ? '一位角色' : String(agentId);
  }
  function avatar(agentId) {
    var wrap = el('span', 'ec-avatar');
    var cfg = roleConfig(agentId);
    var src = cfg ? (cfg.avatar || cfg.avatarUrl || '') : '';
    if (src) {
      var img = document.createElement('img');
      img.src = String(src);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      wrap.appendChild(img);
    } else {
      wrap.textContent = String(agentName(agentId) || '?').charAt(0).toUpperCase();
    }
    return wrap;
  }

  /* ── 接线 ───────────────────────────────────────────────────────── */
  var api = Object.freeze({
    render: function () {
      if (!byId(DOM.HOST)) return false;
      if (stage === 'idle') { load(); return true; }
      render();
      return true;
    },
    refresh: load,
    /* 给测试与诊断用：状态与视图模型的只读快照。 */
    snapshot: function () {
      return {
        stage: stage, syncedAt: syncedAt, failure: failure,
        pending: Object.keys(pending), view: view
      };
    },
    copy: COPY,
    DOM: DOM
  });
  NS.economyApprovalUI = api;

  /* 首次进入页面时 core.js 的 navTo 会调 render()；在此之前不主动读，
     因为绝大多数会话不会打开这一页（不制造无用的后台请求）。 */
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
})(window.IB || (window.IB = {}));
