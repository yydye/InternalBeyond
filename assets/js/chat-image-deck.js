/* ============================================================================
   UI-P2 · Chat Image Deck / 聊天图片叠层
   ----------------------------------------------------------------------------
   ROLE ................. PRESENTATION_LAYER_ONLY
   DATA AUTHORITY ....... the message's own image list, in payload order
                          (the <img class="chat-bubble-img"> elements that
                           communication.js already appended — we MOVE them,
                           we never build a second list)
   VIEWER AUTHORITY ..... window._viewImageFull(src, image) — the existing viewer,
                          invoked through the image's own onclick handler
   DURABLE WRITES ....... 0
   STATE ................ session-local Map keyed by data-msg-id
   GESTURE .............. AXIS_INTENT_LOCK (vertical scroll always wins)

   WHY DOM POST-PROCESSING (and not a renderer change):
   the conversation renderer lives in assets/js/communication.js, which is
   user-dirty. The four places that append message images
   (communication.js:593 / :619 / :3840 / :3868) all produce the SAME shape:
   a contiguous run of sibling <img class="chat-bubble-img"> inside a message
   row that carries data-msg-id. So this module can sit completely outside the
   renderer: it observes the two chat containers and re-composes that run into
   a deck. Nothing in the message pipeline is edited, and the product's own
   click → _viewImageFull path is preserved because the original <img> (with
   its onclick, its src, its loading/decoding attributes) is MOVED into the
   deck rather than copied.

   What this module does NOT do:
     · never touches message payload / attachment list / image URLs / captions
     · never re-uploads, re-encodes, or copies image data
     · never writes IndexedDB / localStorage / the message store
     · never creates a second fullscreen viewer
     · never changes the single-image case (COUNT = 1 is left completely alone)
   ============================================================================ */
(function (NS) {
  'use strict';

  var CSS_HREF = 'assets/css/chat-image-deck.css';
  var CSS_ID = 'ib-chat-image-deck-style';
  var CONTAINER_IDS = ['chat-full-messages', 'chat-messages'];
  var MIN_DECK = 2;            /* 1 image = untouched single image */
  var MAX_STACKED = 6;         /* 2..6 = stacked deck */
  var VISIBLE_STACK_DEPTH = 3; /* >6 still shows at most 3 back cards */
  var DRAG_LOCK_PX = 8;
  var AXIS_BIAS = 1.25;        /* |dx| must beat |dy| by this factor */
  var COMMIT_RATIO = 0.22;     /* of deck width */
  var COMMIT_VELOCITY = 0.5;   /* px/ms */
  var EDGE_GUARD_PX = 24;      /* left-edge system back gesture keeps priority */
  var CLICK_SLOP_PX = 6;

  var state = {
    mounted: false,
    decks: Object.create(null),   /* msgId -> deck record */
    order: [],
    observer: null,
    scheduled: false,
    applying: false,
    overlay: null,
    overlayReturn: null
  };

  /* --------------------------------------------------------------- utils */

  function el(tag, className, parent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function isChatImage(node) {
    return !!(node && node.nodeType === 1 && node.tagName === 'IMG' &&
      node.classList && node.classList.contains('chat-bubble-img'));
  }

  function msgIdOf(row) {
    if (!row || !row.dataset) return '';
    return String(row.dataset.msgId || '').trim();
  }

  /* 只接受「连续兄弟」的图片序列：renderer 用 forEach append，所以一个消息的
     图片一定是连续的一段。非连续的图片不属于同一组，不做处理。 */
  function imageRun(row) {
    var kids = row.children;
    var run = [];
    var best = [];
    for (var i = 0; i < kids.length; i++) {
      if (isChatImage(kids[i])) {
        run.push(kids[i]);
      } else {
        if (run.length > best.length) best = run;
        run = [];
      }
    }
    if (run.length > best.length) best = run;
    return best;
  }

  /* ------------------------------------------------------- count policy */

  function policy(count) {
    if (!count) return 'NO_IMAGE_DECK';
    if (count === 1) return 'SINGLE_IMAGE';
    if (count <= MAX_STACKED) return 'STACKED_IMAGE_DECK';
    return 'STACKED_IMAGE_DECK_WITH_EXPAND';
  }

  function visibleDepth(count) {
    return clamp(count - 1, 0, VISIBLE_STACK_DEPTH);
  }

  /* -------------------------------------------------------------- styles */

  function injectStyles() {
    if (document.getElementById(CSS_ID)) return;
    var link = document.createElement('link');
    link.id = CSS_ID;
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    document.head.appendChild(link);
  }

  /* --------------------------------------------------------- deck record */

  function recordFor(msgId) {
    var rec = state.decks[msgId];
    if (rec) return rec;
    rec = { msgId: msgId, index: 0, deck: null, stack: null, cards: [], imgs: [], aspect: 0 };
    state.decks[msgId] = rec;
    state.order.push(msgId);
    return rec;
  }

  function openViewer(rec) {
    /* 复用既有 viewer：直接触发图片自己的 onclick，绝不重建 image authority。 */
    var img = rec.imgs[rec.index];
    if (!img) return false;
    if (typeof img.click === 'function') { img.click(); return true; }
    return false;
  }

  /* ------------------------------------------------------------- render */

  function setIndex(rec, next, options) {
    options = options || {};
    var count = rec.imgs.length;
    if (!count) return;
    /* NON_LOOPING：越界即 no-op，不做无提示循环。 */
    next = clamp(next, 0, count - 1);
    var changed = next !== rec.index;
    rec.index = next;
    paint(rec);
    if (changed && options.announce !== false) announce(rec);
  }

  function announce(rec) {
    if (rec.live) rec.live.textContent = '';
    if (rec.live) rec.live.textContent = '图片 ' + (rec.index + 1) + ' / ' + rec.imgs.length;
  }

  function paint(rec) {
    var count = rec.imgs.length;
    if (!count) return;
    /* 集合变短（late attachment / 撤回 / 图片被清理）时把 index 收进新长度 ——
       这是唯一允许改变 currentIndex 的情形；同一消息的重渲染不得重置它。 */
    if (rec.index > count - 1) rec.index = count - 1;
    if (rec.index < 0) rec.index = 0;
    var depth = visibleDepth(count);
    var deck = rec.deck;
    if (!deck) return;
    var i;
    for (i = 0; i < rec.cards.length; i++) {
      var card = rec.cards[i];
      var img = rec.imgs[i];
      var rel = i - rec.index;
      var visible = rel >= 0 && rel <= depth;
      card.setAttribute('data-depth', visible ? String(rel) : 'hidden');
      card.setAttribute('aria-hidden', i === rec.index ? 'false' : 'true');
      if (img) {
        /* 只有可见卡在视口里 —— 于是浏览器只会解码 current + next + 少量后景，
           而不是一次把 20 张全部 decode（IMAGE_DECK_PRELOAD_POLICY）。 */
        img.setAttribute('loading', visible && rel <= 1 ? 'eager' : 'lazy');
      }
    }
    deck.setAttribute('data-count', String(count));
    deck.setAttribute('data-index', String(rec.index));
    deck.setAttribute('aria-label', '图片 ' + (rec.index + 1) + ' / ' + count);
    if (rec.counter) rec.counter.textContent = (rec.index + 1) + ' / ' + count;
    if (rec.prev) rec.prev.disabled = rec.index <= 0;
    if (rec.next) rec.next.disabled = rec.index >= count - 1;
    if (rec.expand) rec.expand.textContent = '展开 ' + count;
  }

  /* ------------------------------------------------------------ enhance */

  function enhance(row, imgs) {
    var msgId = msgIdOf(row);
    if (!msgId) return null;                 /* 没有稳定身份 → 保持既有呈现 */
    var rec = recordFor(msgId);
    if (rec.adopted) return rec;             /* 幂等：同一消息只接管一次 DOM */
    var count = imgs.length;
    var anchor = imgs[0];

    var deck = el('div', 'chat-image-deck');
    deck.setAttribute('role', 'group');
    deck.setAttribute('data-msg-id', msgId);
    deck.tabIndex = 0;

    var stack = el('div', 'chat-image-deck__stack', deck);

    /* 先把 deck 插到第一张图原来的位置，**再**把图片搬进来。
       顺序反了的话 imgs[0] 已经不是 row 的子节点，insertBefore 会抛
       NotFoundError，图片被留在离屏的 deck 里 —— 聊天里的图片会凭空消失。
       （UI-P2 首轮浏览器 E2E 正是这样抓到的。） */
    row.insertBefore(deck, anchor);

    var i;
    for (i = 0; i < count; i++) {
      var card = el('div', 'chat-image-deck__card', stack);
      card.setAttribute('data-depth', i === 0 ? '0' : 'hidden');
      /* MOVE 原元素：onclick（既有 viewer）、src、loading/decoding 全部保留，
         不复制 blob、不重新编码、不产生第二份 image authority。 */
      var node = imgs[i];
      /* 只清掉 renderer 写在元素上的内联尺寸约束（classic panel 会写
         max-width:180px）。内联样式压过任何选择器，所以必须在这里让位，
         否则后卡无法按帧尺寸叠放。这不是 message 语义，只是呈现。 */
      if (node.style) {
        node.style.removeProperty('max-width');
        node.style.removeProperty('max-height');
      }
      /* 桌面鼠标拖动：禁掉浏览器原生图片拖拽，否则 pointermove 会被抢走。 */
      node.draggable = false;
      card.appendChild(node);
      rec.cards.push(card);
      rec.imgs.push(node);
    }

    var counter = el('span', 'chat-image-deck__count', deck);
    counter.setAttribute('aria-hidden', 'true');

    var prev = el('button', 'chat-image-deck__nav chat-image-deck__nav--prev', deck);
    prev.type = 'button';
    prev.setAttribute('aria-label', '上一张图片');
    prev.textContent = '\u2039';
    var next = el('button', 'chat-image-deck__nav chat-image-deck__nav--next', deck);
    next.type = 'button';
    next.setAttribute('aria-label', '下一张图片');
    next.textContent = '\u203a';

    var expand = null;
    if (policy(count) === 'STACKED_IMAGE_DECK_WITH_EXPAND') {
      expand = el('button', 'chat-image-deck__expand', deck);
      expand.type = 'button';
      expand.textContent = '展开 ' + count;
      expand.setAttribute('aria-haspopup', 'dialog');
      expand.setAttribute('aria-label', '展开全部 ' + count + ' 张图片');
    }

    var live = el('span', 'chat-image-deck__sr', deck);
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');

    rec.deck = deck;
    rec.stack = stack;
    rec.counter = counter;
    rec.prev = prev;
    rec.next = next;
    rec.expand = expand;
    rec.live = live;
    rec.adopted = true;              /* DOM 手术完成才置位：失败不留半接管状态 */

    /* 帧尺寸：以第一张图的比例定一次（clamp 到安全带），此后不再随切图变化
       —— 于是 IMAGE_DECK_LAYOUT_SHIFT = BOUNDED。 */
    applyAspect(rec);
    var probe = rec.imgs[0];
    if (probe && !probe.complete) {
      probe.addEventListener('load', function () { applyAspect(rec); }, { once: true });
    }

    prev.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setIndex(rec, rec.index - 1);
    });
    next.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setIndex(rec, rec.index + 1);
    });
    if (expand) {
      expand.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openGallery(rec, expand);
      });
    }

    bindGesture(rec, deck);
    bindKeyboard(rec, deck);
    paint(rec);
    return rec;
  }

  function applyAspect(rec) {
    var img = rec.imgs[0];
    var a = 0;
    if (img && img.naturalWidth && img.naturalHeight) {
      a = img.naturalWidth / img.naturalHeight;
    }
    if (!a || !isFinite(a) || a <= 0) return;   /* 未就绪：保留默认帧，不塌成 0 高 */
    a = clamp(a, 0.62, 2.35);
    rec.aspect = a;
    if (rec.deck) rec.deck.style.setProperty('--deck-aspect', String(Math.round(a * 1000) / 1000));
  }

  /* ------------------------------------------------------------ gesture */

  function bindGesture(rec, deck) {
    var drag = null;

    deck.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      /* 系统返回手势优先：左缘起手不启动 deck drag。 */
      if (ev.clientX <= EDGE_GUARD_PX) return;
      if (ev.target && ev.target.closest && ev.target.closest('.chat-image-deck__nav, .chat-image-deck__expand')) return;
      drag = {
        id: ev.pointerId, x0: ev.clientX, y0: ev.clientY,
        dx: 0, axis: null, t0: ev.timeStamp || Date.now(), moved: false
      };
      rec.drag = drag;
      /* 刻意不 preventDefault：垂直滚动必须能立刻接管。 */
    });

    deck.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.x0;
      var dy = ev.clientY - drag.y0;
      if (!drag.axis) {
        if (Math.abs(dx) < DRAG_LOCK_PX && Math.abs(dy) < DRAG_LOCK_PX) return;
        if (Math.abs(dx) > Math.abs(dy) * AXIS_BIAS) {
          drag.axis = 'deck';
          try { deck.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
          deck.setAttribute('data-dragging', 'true');
        } else {
          /* AXIS_INTENT_LOCK：纵向意图 → 立即让给聊天滚动，deck 全程不介入。 */
          drag.axis = 'scroll';
          rec.drag = null;
          drag = null;
          return;
        }
      }
      if (drag.axis !== 'deck') return;
      ev.preventDefault();
      drag.dx = dx;
      drag.moved = drag.moved || Math.abs(dx) > CLICK_SLOP_PX;
      deck.style.setProperty('--deck-drag', String(Math.round(dx)) + 'px');
    });

    function finish(ev) {
      if (!drag) return;
      var d = drag;
      drag = null;
      rec.drag = null;
      deck.removeAttribute('data-dragging');
      deck.style.removeProperty('--deck-drag');
      if (d.axis !== 'deck') return;
      var box = deck.getBoundingClientRect();
      var width = box.width || 1;
      var dt = Math.max(1, (ev.timeStamp || Date.now()) - d.t0);
      var velocity = Math.abs(d.dx) / dt;
      var commit = Math.abs(d.dx) > width * COMMIT_RATIO || velocity > COMMIT_VELOCITY;
      if (commit && d.dx !== 0) {
        setIndex(rec, rec.index + (d.dx < 0 ? 1 : -1));
      } else {
        paint(rec);
      }
      if (d.moved) {
        /* 拖动过就不是点击：抑制紧随其后的 click，避免 swipe 完又打开 viewer。 */
        rec.suppressClick = true;
        var clear = function () { rec.suppressClick = false; };
        if (window.setTimeout) setTimeout(clear, 350);
      }
    }

    deck.addEventListener('pointerup', finish);
    deck.addEventListener('pointercancel', function (ev) {
      if (!drag) return;
      drag = null;
      rec.drag = null;
      deck.removeAttribute('data-dragging');
      deck.style.removeProperty('--deck-drag');
      paint(rec);
    });

    /* 捕获阶段拦掉「拖动之后的 click」。 */
    deck.addEventListener('click', function (ev) {
      if (rec.suppressClick) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.target && ev.target.closest && ev.target.closest('.chat-image-deck__nav, .chat-image-deck__expand')) return;
      /* 点在图片上 → 让产品自己的 onclick（既有 viewer）处理；
         点在卡的空白处 → 视作点当前图。 */
      if (isChatImage(ev.target)) return;
      if (ev.target && ev.target.closest && ev.target.closest('.chat-image-deck__card')) {
        openViewer(rec);
      }
    }, true);
  }

  /* ----------------------------------------------------------- keyboard */

  function bindKeyboard(rec, deck) {
    deck.addEventListener('keydown', function (ev) {
      /* 只在 deck 自己聚焦时响应：绝不全局劫持聊天快捷键。 */
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        setIndex(rec, rec.index - 1);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        setIndex(rec, rec.index + 1);
      } else if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        openViewer(rec);
      }
    });
  }

  /* ---------------------------------------------------- minimal gallery */
  /* >6 的「展开 N」：只补一个最小 gallery 网格；每张仍然交回既有 viewer，
     因此没有第二套 fullscreen viewer。 */

  function openGallery(rec, trigger) {
    closeGallery();
    var overlay = el('div', 'chat-image-deck-gallery');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '全部 ' + rec.imgs.length + ' 张图片');

    var bar = el('div', 'chat-image-deck-gallery__bar', overlay);
    var title = el('span', 'chat-image-deck-gallery__title', bar);
    title.textContent = '全部 ' + rec.imgs.length + ' 张图片';
    var close = el('button', 'chat-image-deck-gallery__close', bar);
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '\u00d7';

    var grid = el('div', 'chat-image-deck-gallery__grid', overlay);
    var i;
    for (i = 0; i < rec.imgs.length; i++) {
      (function (idx) {
        var src = rec.imgs[idx].getAttribute('src') || '';
        var alt = rec.imgs[idx].getAttribute('alt') || ('图片 ' + (idx + 1));
        var tile = el('button', 'chat-image-deck-gallery__tile', grid);
        tile.type = 'button';
        tile.setAttribute('aria-label', '查看 ' + alt);
        var im = document.createElement('img');
        im.loading = 'lazy';
        im.decoding = 'async';
        im.alt = alt;
        im.src = src;                 /* 同一个 dataUrl 引用；不复制、不重编码 */
        tile.appendChild(im);
        tile.addEventListener('click', function () {
          closeGallery();
          rec.index = clamp(idx, 0, rec.imgs.length - 1);
          paint(rec);
          announce(rec);
          openViewer(rec);
        });
      })(i);
    }

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeGallery();
    });
    close.addEventListener('click', closeGallery);

    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.overlayReturn = trigger || null;
    state.overlayKey = function (ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeGallery();
      }
    };
    document.addEventListener('keydown', state.overlayKey);
    if (close.focus) close.focus({ preventScroll: true });
  }

  function closeGallery() {
    if (state.overlayKey) {
      document.removeEventListener('keydown', state.overlayKey);
      state.overlayKey = null;
    }
    if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    state.overlay = null;
    var back = state.overlayReturn;
    state.overlayReturn = null;
    if (back && back.isConnected && back.focus) {
      try { back.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    }
  }

  /* ---------------------------------------------------------------- scan */

  function scan() {
    state.applying = true;
    try {
      for (var c = 0; c < CONTAINER_IDS.length; c++) {
        var container = document.getElementById(CONTAINER_IDS[c]);
        if (!container) continue;
        var rows = container.querySelectorAll('[data-msg-id]');
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var msgId = msgIdOf(row);
          if (!msgId) continue;
          var rec = state.decks[msgId];
          if (rec && rec.adopted && row.contains(rec.deck)) { continue; }
          if (rec && rec.adopted) { forget(msgId); }   /* 行被重建：旧 DOM 已消失 */
          var run = imageRun(row);
          if (run.length >= MIN_DECK) enhance(row, run);
        }
      }
    } finally {
      state.applying = false;
    }
  }

  function forget(msgId) {
    var rec = state.decks[msgId];
    if (!rec) return;
    rec.adopted = false;
    rec.deck = null;
    rec.stack = null;
    rec.cards = [];
    rec.imgs = [];
    rec.counter = null;
    rec.prev = null;
    rec.next = null;
    rec.expand = null;
  }

  function schedule() {
    if (state.scheduled || state.applying) return;
    state.scheduled = true;
    var run = function () {
      state.scheduled = false;
      if (state.applying) return;
      scan();
    };
    if (window.requestAnimationFrame) requestAnimationFrame(run);
    else setTimeout(run, 40);
  }

  function bindObserver() {
    if (!window.MutationObserver) return;
    state.observer = new MutationObserver(function () { schedule(); });
    for (var i = 0; i < CONTAINER_IDS.length; i++) {
      var container = document.getElementById(CONTAINER_IDS[i]);
      if (container) {
        state.observer.observe(container, { childList: true, subtree: true });
      }
    }
  }

  /* --------------------------------------------------------------- mount */

  function mount() {
    if (state.mounted) return api;
    if (!document.body) return api;
    injectStyles();
    state.mounted = true;
    bindObserver();
    scan();
    /* 两个容器可能在 mount 之后才出现（页面首次激活）。 */
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      var found = 0;
      for (var i = 0; i < CONTAINER_IDS.length; i++) if (document.getElementById(CONTAINER_IDS[i])) found += 1;
      scan();
      if (found >= 2 || tries > 40) clearInterval(timer);
    }, 250);
    return api;
  }

  /* ------------------------------------------------------------------ API */

  var api = {
    version: 'ui-p2.1',
    role: 'PRESENTATION_LAYER_ONLY',
    dataAuthority: 'MESSAGE_IMAGE_LIST',
    orderAuthority: 'EXISTING_MESSAGE_PAYLOAD_ORDER',
    viewerAuthority: 'window._viewImageFull',
    durableWrites: 0,
    stateKey: 'data-msg-id',
    navigation: 'NON_LOOPING',
    gestureArbitration: 'AXIS_INTENT_LOCK',
    preloadPolicy: 'CURRENT_PLUS_NEXT',
    visibleStackDepth: VISIBLE_STACK_DEPTH,
    mounted: false,
    mount: mount,
    policy: policy,
    visibleDepth: visibleDepth,
    scan: scan,
    destroy: function () {
      if (state.observer) { state.observer.disconnect(); state.observer = null; }
      closeGallery();
      state.mounted = false;
      state.decks = Object.create(null);
      state.order = [];
    },
    decks: function () {
      var out = [];
      for (var i = 0; i < state.order.length; i++) {
        var rec = state.decks[state.order[i]];
        if (rec && rec.adopted && rec.deck) {
          out.push({
            msgId: rec.msgId,
            count: rec.imgs.length,
            index: rec.index,
            policy: policy(rec.imgs.length),
            visibleDepth: visibleDepth(rec.imgs.length),
            hasExpand: !!rec.expand,
            dragging: !!rec.drag
          });
        }
      }
      return out;
    },
    indexOf: function (msgId) {
      var rec = state.decks[String(msgId)];
      return rec ? rec.index : -1;
    },
    _internals: { imageRun: imageRun, clamp: clamp }
  };

  api.mounted = true;
  NS.expose('chatImageDeck', api);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(); }, { once: true });
  } else {
    mount();
  }
})(window.IB || (window.IB = {}));
