/* ====================================================================
   IB 隐藏彩蛋 · The Basement / INFERNAL BEYOND（自包含，最小侵入）
   --------------------------------------------------------------------
   入口：Room 右侧书柜上的一个发光交互点（与床/茶桌同风格）。
   点击书柜 → 弹出 3 位数密码锁。输入正确密码 → 书柜脚下浮现通往
   地下室的阶梯（阶梯可点）。
   地下室：全屏极简场景，一个可交互的 INFERNAL BEYOND 核心。
   核心点击 → 黑屏淡入 + 「你发现了深渊的入口。INFERNAL BEYOND 已觉醒。」
            → 切 INFERNAL BEYOND Mode（body.infernal-beyond）。
   返回：地下室角落一个极小「回到地上」控件 + ESC（隐藏但可靠）。
   持久化：localStorage 'ib_basement_v1' = {crack,discovered,mode}（刷新不丢）。
   边界：不碰 G 状态机 / onInteract 既有 case / 寻路 / 存档 / Memory / Diary / 用户配置；
         全部旁路 + 失败静默。不在任何可见 UI / 帮助 / 设置 / 日志 / 文档泄露触发条件。
   密码：仅存在于本模块内，不在任何 UI 提示中明示（谜题本身即答案）。
   密码锁支持 0-9 拨号 + 退格，3 位；输错清空重来。
   ==================================================================== */
(function (root) {
  'use strict';
  var KEY = 'ib_basement_v2';   /* v2：玩法从"地板连击"改为"书柜密码锁"，换 key 清掉旧触发存档 */
  /* 书柜交互点：Room 世界坐标（视口内绝对 px，与 MARKERS 的 iconX/iconY 同基准）。 */
  var BOOK = { x: 1240, y: 235 };
  /* 阶梯出现的世界坐标（书柜脚下）。 */
  var STAIR = { x: 1240, y: 330 };
  /* 密码锁：3 位（谜题本身即答案，不泄露到可见 UI）。 */
  var PASS = '666';
  var LOCK_LEN = 3;
  var st = { crack: false, discovered: false, mode: false };

  function load() { try { var r = JSON.parse(localStorage.getItem(KEY) || 'null'); if (r) st = r; } catch (e) {} }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  function vp() { return (root.G && root.G.viewport) || null; }

  /* ── 书柜交互点（id=ib-bookshelf，样式与 ix-marker 一致） ── */
  var _marker = null;
  function ensureMarker() {
    try {
      var v = vp(); if (!v) return null;
      if (_marker && _marker.isConnected) return _marker;
      _marker = document.createElement('div');
      _marker.id = 'ib-bookshelf';
      _marker.className = 'ix-marker ib-bookshelf-marker';
      _marker.style.left = BOOK.x + 'px';
      _marker.style.top = BOOK.y + 'px';
      _marker.innerHTML = '<div class="ix-aura"></div>'
        + '<div class="ix-spark"><div class="ix-spark-star"></div></div>'
        + '<div class="ix-tag"><span class="ix-tag-en">Secret</span><span class="ix-tag-cn">书柜</span></div>';
      _marker.setAttribute('role', 'button');
      _marker.setAttribute('tabindex', '0');
      _marker.setAttribute('aria-label', '书柜');
      _marker.addEventListener('click', function (e) { e.stopPropagation(); onBookshelfClick(); });
      _marker.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBookshelfClick(); }
      });
      v.appendChild(_marker);
      return _marker;
    } catch (e) { return null; }
  }
  function onBookshelfClick() {
    /* 已解开 → 直接进地下室；未解开 → 弹出密码锁 */
    if (st.crack && st.discovered) openBasement();
    else openLock();
  }

  /* ── 密码锁 overlay（懒创建） ── */
  var _lock = null, _code = '';
  function ensureLock() {
    var el = document.getElementById('ib-lock');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ib-lock'; el.className = 'ib-lock'; el.hidden = true;
    var digits = '';
    for (var i = 0; i < LOCK_LEN; i++) digits += '<span class="ib-lock-digit" data-i="' + i + '">–</span>';
    el.innerHTML = '<div class="ib-lock-panel">'
      + '<div class="ib-lock-head"><span class="ib-lock-title">SECRET</span>'
      + '<button type="button" class="ib-lock-x" id="ib-lock-x" aria-label="关闭">✕</button></div>'
      + '<div class="ib-lock-readout">' + digits + '</div>'
      + '<div class="ib-lock-pad" id="ib-lock-pad"></div>'
      + '<div class="ib-lock-hint" id="ib-lock-hint"></div>'
      + '</div>';
    document.body.appendChild(el);
    var pad = el.querySelector('#ib-lock-pad');
    for (var d = 0; d <= 9; d++) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ib-lock-key'; b.textContent = String(d);
      b.addEventListener('click', function () { pressDigit(parseInt(this.textContent, 10)); });
      pad.appendChild(b);
    }
    var clr = document.createElement('button');
    clr.type = 'button'; clr.className = 'ib-lock-key ib-lock-key-ok'; clr.textContent = '↺';
    clr.addEventListener('click', function () { _code = ''; renderLock(); });
    pad.appendChild(clr);
    el.querySelector('#ib-lock-x').addEventListener('click', function (e) { e.stopPropagation(); closeLock(); });
    return el;
  }
  function renderLock() {
    var el = ensureLock();
    var digits = el.querySelectorAll('.ib-lock-digit');
    for (var i = 0; i < digits.length; i++) digits[i].textContent = (_code[i] != null) ? _code[i] : '–';
    var hint = el.querySelector('#ib-lock-hint');
    if (hint) hint.textContent = st.crack ? '' : '';
  }
  function pressDigit(d) {
    try {
      if (_code.length >= LOCK_LEN) return;
      _code += String(d);
      renderLock();
      if (_code.length === LOCK_LEN) setTimeout(function () { trySubmit(); }, 120);
    } catch (e) {}
  }
  function trySubmit() {
    try {
      if (_code === PASS) { solveLock(); }
      else { shakeLock(); _code = ''; renderLock(); }
    } catch (e) {}
  }
  function shakeLock() {
    var el = document.getElementById('ib-lock'); if (!el) return;
    var p = el.querySelector('.ib-lock-panel'); if (p) { p.classList.remove('ib-shake'); void p.offsetWidth; p.classList.add('ib-shake'); }
  }
  function solveLock() {
    try {
      st.crack = true; st.discovered = true; save();
      closeLock();
      showStair();
    } catch (e) {}
  }
  function openLock() { try { var el = ensureLock(); el.hidden = false; _code = ''; renderLock(); } catch (e) {} }
  function closeLock() { try { var el = document.getElementById('ib-lock'); if (el) el.hidden = true; _code = ''; } catch (e) {} }

  /* ── 阶梯元素（书柜脚下） ── */
  function showStair() {
    try {
      var v = vp(); if (!v) return;
      if (!v.querySelector('#ib-crack')) {
        var c = document.createElement('div');
        c.id = 'ib-crack'; c.className = 'ib-basement-crack';
        c.style.left = STAIR.x + 'px'; c.style.top = STAIR.y + 'px';
        v.appendChild(c);
      }
      if (!v.querySelector('#ib-stairs')) {
        var s = document.createElement('div');
        s.id = 'ib-stairs'; s.className = 'ib-basement-stairs';
        s.style.left = STAIR.x + 'px'; s.style.top = STAIR.y + 'px';
        s.title = ''; s.setAttribute('aria-hidden', 'true');
        s.addEventListener('click', function (ev) { ev.stopPropagation(); openBasement(); });
        v.appendChild(s);
      }
    } catch (e) {}
  }

  /* ── 地下室 overlay（懒创建） ── */
  function ensureBasement() {
    var el = document.getElementById('ib-basement');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ib-basement'; el.className = 'ib-basement'; el.hidden = true;
    el.innerHTML = '<div class="ib-basement-core" id="ib-basement-core" role="button" tabindex="0" aria-hidden="true">INFERNAL BEYOND</div>'
      + '<div class="ib-basement-return" id="ib-basement-return" tabindex="0" aria-hidden="true">↺</div>';
    document.body.appendChild(el);
    el.querySelector('#ib-basement-core').addEventListener('click', function () { activateBeyond(); });
    el.querySelector('#ib-basement-core').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateBeyond(); } });
    el.querySelector('#ib-basement-return').addEventListener('click', function () { returnToSurface(); });
    return el;
  }
  function openBasement() {
    try { ensureBasement().hidden = false; } catch (e) {}
  }

  /* ── 激活：黑屏 + 提示 + INFERNAL BEYOND Mode ── */
  function activateBeyond() {
    try {
      var el = ensureBasement();
      var msg = document.createElement('div');
      msg.id = 'ib-basement-blind';
      msg.className = 'ib-basement-blind';
      msg.textContent = '你发现了深渊的入口。INFERNAL BEYOND 已觉醒。';
      document.body.appendChild(msg);
      setTimeout(function () {
        try { document.body.classList.add('infernal-beyond'); document.body.setAttribute('data-ib-beyond', '1'); } catch (e) {}
        st.mode = true; save();
        el.hidden = true;
      }, 1600);
    } catch (e) {}
  }

  /* ── 返回：清 Mode、收地下室（隐藏但可靠：角落控件 + ESC） ── */
  function returnToSurface() {
    try {
      document.body.classList.remove('infernal-beyond');
      document.body.removeAttribute('data-ib-beyond');
      var el = ensureBasement(); el.hidden = true;
      var b = document.getElementById('ib-basement-blind'); if (b) b.remove();
      st.mode = false; save();
    } catch (e) {}
  }
  function onKey(e) {
    try {
      if (e.key === 'Escape') {
        if (document.body.classList.contains('infernal-beyond')) returnToSurface();
        else { var l = document.getElementById('ib-lock'); if (l && !l.hidden) closeLock(); }
      }
    } catch (err) {}
  }

  /* ── 初始化：恢复持久化状态 ── */
  function settle() {
    load();
    try { if (st.mode) { document.body.classList.add('infernal-beyond'); document.body.setAttribute('data-ib-beyond', '1'); } } catch (e) {}
    try { ensureMarker(); } catch (e) {}
    if (st.crack) showStair();
  }

  /* 挂载：Room 视口创建后注入书柜交互点；全局 ESC。 */
  var _attached = false;
  function attach() {
    try {
      var v = vp();
      if (v && !_attached) { ensureMarker(); _attached = true; }
    } catch (e) {}
  }
  function boot() {
    settle();
    attach();
    if (!_attached) { var t = setInterval(function () { attach(); if (_attached) { settle(); clearInterval(t); } }, 400); }
    document.addEventListener('keydown', onKey);
  }

  /* 暴露仅供测试的旁路句柄（不泄露触发条件到可见 UI） */
  root._ibBasement = {
    get: function () { return st; },
    openLock: openLock, closeLock: closeLock, pressDigit: pressDigit,
    solveLock: solveLock, open: openBasement, activate: activateBeyond,
    returnToSurface: returnToSurface, _st: function () { return st; },
    _marker: function () { return _marker; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof self !== 'undefined' ? self : globalThis);
