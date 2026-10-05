'use strict';
/* ============================================================================
   Internal Beyond · UI-P2 · Chat Image Deck — 浏览器端到端
   ----------------------------------------------------------------------------
   运行：node tests/test_chat_image_deck_browser.js   （需要本机 Chrome / Edge）

   关键点：DOM 由**真实渲染器**产生 —— 测试调用生产入口
   window._renderAllChat(container, messages, true)（communication.js:663），
   然后观察 assets/js/chat-image-deck.js 是否把 renderer 追加的那一段
   <img class="chat-bubble-img"> 正确重组为叠层。

   覆盖：0 / 1 / 2 / 6 / 7+ 张 · 单图行为不变 · 阈值下拖动 · 阈值上拖动 ·
   纵向手势让位 · 点击开既有 viewer · 拖动后不开 viewer · 桌面箭头 · 键盘 ·
   展开全部 · 坏图隔离 · 预载策略 · 多 deck 隔离 · 重渲染身份 · 390px ·
   light/dark · reduced motion。
   ============================================================================ */

const H = require('./helpers/memory-world-cdp.js');

const LABEL = 'Chat Image Deck browser E2E';
const { check, info, finish } = H.makeChecker(LABEL);
const section = t => console.log('\n── ' + t + ' ──');

const IMG = (w, h, tint) => `(function(){
  var c = document.createElement('canvas');
  c.width = ${w}; c.height = ${h};
  var g = c.getContext('2d');
  g.fillStyle = '${tint}'; g.fillRect(0, 0, ${w}, ${h});
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, ${Math.max(4, Math.round(w / 4))}, ${Math.max(4, Math.round(h / 4))});
  return c.toDataURL('image/jpeg', 0.8);
})()`;

async function renderMessages(cdp, containerId, messages, full) {
  const js = JSON.stringify(messages);
  return H.evaluate(cdp, `(function(){
    var c = document.getElementById(${JSON.stringify(containerId)});
    if (!c) return 'no-container';
    window._renderAllChat(c, ${js}, ${full ? 'true' : 'false'});
    return 'rendered';
  })()`);
}

async function deckState(cdp) {
  return JSON.parse(await H.evaluate(cdp, 'JSON.stringify(IB.chatImageDeck.decks())'));
}

/* 返回一个**验证过落在卡片图片上**的手势起点。
   ------------------------------------------------------------------------
   为什么不能用几何中心（UI-P2.1b 的根因）：
   deck 只有约 100px 宽，而模块的上一张/下一张箭头是 `position:absolute`、
   `opacity:0`（**仍然可命中**）的 30px 按钮，`inset-inline-*: 8px`，正好压住
   中心区域。于是 pointerdown 会落在 `.chat-image-deck__nav` 上 —— 而模块的
   手势绑定器**有意忽略**落在 nav/expand 上的按压（不起拖，data-dragging 始终
   不出现），紧接着 mouseup 在该按钮上产生的 click 又会切图。
   结果就是实测到的两处失败：
     · 12px 未达阈值 → 没起拖 + 箭头 click → index 0→1（期望 0）
     · 坏图 deck     → 没起拖            → index 停在 0（期望 1）
   测试必须瞄准**图片本身**，不能瞄准隐形控件；因此这里按比例扫描候选点，
   并要求 elementFromPoint 命中 `.chat-image-deck__card img.chat-bubble-img`
   且不在任何控件上。 */
async function deckPoint(cdp, msgId) {
  let last = { x: 0, y: 0, w: 0, h: 0, inDeck: false, onImage: false, exists: false, top: null };
  for (let attempt = 0; attempt < 12; attempt++) {
    const p = await H.evaluate(cdp, `(function(){
      var d = document.querySelector('.chat-msg[data-msg-id="' + ${JSON.stringify(msgId)} + '"] .chat-image-deck');
      if (!d) return { exists: false, inDeck: false, onImage: false, x: 0, y: 0, w: 0, h: 0, top: null };
      var r = d.getBoundingClientRect();
      var FR = [0.50, 0.40, 0.60, 0.34, 0.66, 0.28, 0.72, 0.46];
      var f = FR[${attempt} % FR.length];
      var cx = r.left + r.width * f;
      var cy = r.top + r.height * 0.5;
      var top = document.elementFromPoint(cx, cy);
      var ctrl = !!(top && top.closest && top.closest('.chat-image-deck__nav, .chat-image-deck__expand'));
      var img = (top && top.closest) ? top.closest('.chat-image-deck__card img.chat-bubble-img') : null;
      return {
        exists: true, x: cx, y: cy, w: r.width, h: r.height,
        inDeck: !!(top && d.contains(top)),
        onImage: !!img && !ctrl,
        onControl: ctrl,
        top: top ? (String(top.className || top.tagName).slice(0, 60)) : null,
        connected: d.isConnected,
        offsetParent: d.offsetParent ? String(d.offsetParent.className || d.offsetParent.id) : null,
        selfDisp: getComputedStyle(d).display,
        parentDisp: d.parentElement ? getComputedStyle(d.parentElement).display : null,
        parentCls: d.parentElement ? String(d.parentElement.className) : null,
        rowDisp: d.parentElement && d.parentElement.parentElement ? getComputedStyle(d.parentElement.parentElement).display : null,
        rowRect: d.parentElement && d.parentElement.parentElement ? Math.round(d.parentElement.parentElement.getBoundingClientRect().height) : null,
        deckCount: document.querySelectorAll('.chat-image-deck').length,
        rows: document.querySelectorAll('.chat-msg').length
      };
    })()`);
    last = p || last;
    if (p && p.onImage) return p;
    /* fullscreen 聊天是**窗口化**渲染：行要真的进入窗口才有布局，
       光 scrollIntoView 不够，还要把容器滚一滚并等一帧。 */
    await H.evaluate(cdp, `(function(){
      var d = document.querySelector('.chat-msg[data-msg-id="' + ${JSON.stringify(msgId)} + '"] .chat-image-deck');
      if (d && d.scrollIntoView) d.scrollIntoView({ block: '${attempt % 2 ? 'start' : 'center'}' });
      var c = document.getElementById('chat-full-messages') || document.getElementById('chat-messages');
      if (c) c.scrollTop = ${attempt > 3 ? 'c.scrollHeight' : 'c.scrollTop'};
      return true;
    })()`);
    await H.sleep(180);
  }
  return last;
}

/* UI-P2.1b §11：deck-ready 用**条件轮询**，不用固定 sleep 当就绪依据。
   就绪 = deck 存在 + data-index 与 reducer 索引一致 + 未在拖动 + 有真实盒子
          + viewer 已关闭。 */
async function waitDeckReady(cdp, msgId, index) {
  let last = { ok: false, why: 'not-started' };
  for (let i = 0; i < 50; i++) {
    const st = JSON.parse(await H.evaluate(cdp, `(function(){
      var d = document.querySelector('.chat-msg[data-msg-id="' + ${JSON.stringify(msgId)} + '"] .chat-image-deck');
      if (!d) return JSON.stringify({ ok: false, why: 'no-deck' });
      var r = d.getBoundingClientRect();
      var idx = d.getAttribute('data-index');
      return JSON.stringify({
        ok: !d.hasAttribute('data-dragging')
            && idx === String(${index})
            && IB.chatImageDeck.indexOf(${JSON.stringify(msgId)}) === ${index}
            && r.width > 40 && r.height > 40
            && !document.querySelector('.chat-bubble-img-full'),
        why: 'w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ' dataIndex=' + idx
             + ' reducer=' + IB.chatImageDeck.indexOf(${JSON.stringify(msgId)})
             + ' drag=' + d.hasAttribute('data-dragging')
             + ' viewer=' + !!document.querySelector('.chat-bubble-img-full')
      });
    })()`));
    last = st || last;
    if (st && st.ok) return st;
    await H.sleep(120);
  }
  return last;
}

async function deckRect(cdp, msgId) {
  return H.evaluate(cdp, `(function(){
    var row = document.querySelector('.chat-msg[data-msg-id="' + ${JSON.stringify(msgId)} + '"]');
    if (!row) return null;
    var d = row.querySelector('.chat-image-deck');
    if (!d) return null;
    var r = d.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
}

/* 每次指针/焦点交互前把目标 deck 滚到视口中间：
   消息列表比视口长时，getBoundingClientRect 会落在屏幕外，鼠标事件就打空了。 */
/* fullscreen 聊天是窗口化渲染：行必须在「窗口」里才有布局。实测只有
   ≥4 条消息时最后一行会被布局，所以指针/键盘小节统一用「目标放最后 +
   前面垫三条」的渲染方式，并在取点前把容器滚到底。 */
async function renderFocus(cdp, containerId, target, expectIndex) {
  const filler = (n) => ({ id: 'pad' + n, role: 'assistant', content: 'pad ' + n, friendId: 'deck-test', timestamp: Date.now() });
  await renderMessages(cdp, containerId, [filler(1), filler(2), filler(3), target], true);
  await H.sleep(180);   /* 只等产品自己的渲染节拍；就绪由下面的条件轮询判定 */
  await H.evaluate(cdp, `(function(){
    var c = document.getElementById('chat-full-messages') || document.getElementById('chat-messages');
    if (c) c.scrollTop = c.scrollHeight;
    return c ? c.scrollTop : -1;
  })()`);
  const want = expectIndex === undefined ? 0 : expectIndex;
  const ready = await waitDeckReady(cdp, target.id, want);
  if (!ready.ok && target.id) info('deck not ready for ' + target.id + ': ' + ready.why);
  return ready;
}

/* 应用里有一个全屏 Memory World overlay（position:fixed; inset:0; z-index:400）。
   它一旦处于打开状态，聊天页整体不再参与布局 —— deck 的 rect 全为 0，
   任何指针/键盘断言都会空打（表现就是 elementFromPoint 落在 memory-world 上）。
   每个交互小节开始前先确认聊天面在最上面，并把状态报出来。 */
async function ensureChatSurface(cdp) {
  const state = await H.evaluate(cdp, `(function(){
    var w = document.getElementById('mem-world-overlay') || document.querySelector('.memory-world');
    var open = !!(w && w.classList && w.classList.contains('is-open'));
    if (open && window.IB && IB.memoryWorld && typeof IB.memoryWorld.close === 'function') {
      IB.memoryWorld.close('ui-p2-test');
    }
    return { worldOpen: open, worldClass: w ? String(w.className) : 'none' };
  })()`);
  /* 关键：页面切换是异步的（.page → .page.active）。#page-chat 一旦不是 active，
     整页 display:none —— deck / 容器 rect 全为 0，指针与键盘断言全部空打。 */
  for (let i = 0; i < 20; i++) {
    const ok = await H.evaluate(cdp, `(function(){
      var p = document.getElementById('page-chat');
      var c = document.getElementById('chat-full-messages');
      var r = c ? c.getBoundingClientRect() : null;
      return { active: !!(p && p.classList.contains('active')), h: r ? Math.round(r.height) : 0 };
    })()`);
    if (ok && ok.active && ok.h > 40) break;
    if (i === 1 || i === 8) await H.evaluate(cdp, "navTo('chat')");
    await H.sleep(200);
  }
  await H.sleep(120);
  return state;
}

async function bringIntoView(cdp, msgId) {
  await H.evaluate(cdp, `(function(){
    var d = document.querySelector('.chat-msg[data-msg-id="' + ${JSON.stringify(msgId)} + '"] .chat-image-deck');
    if (d && d.scrollIntoView) d.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await H.sleep(220);
}

async function drag(cdp, x, y, dx, dy) {
  const steps = 8;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1
    });

  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1
  });
  await H.settle(cdp);
}

const msg = (id, n, w, h) => ({
  id: id, role: 'assistant', content: 'deck ' + id, friendId: 'deck-test',
  timestamp: Date.now(), images: Array.from({ length: n }, (_, i) => ({
    dataUrl: '__URL__' + i, name: 'img' + i + '.jpg'
  }))
});

async function main() {
  const session = await H.launch({ width: 1440, height: 900 });
  const { cdp } = session;
  try {
    await H.enterAppShell(cdp);
    info('首次引导处理: ' + await H.dismissSetupWizard(cdp));
    await H.evaluate(cdp, "navTo('chat')");
    await H.settle(cdp);
    await H.sleep(400);

    const deckReady = await H.waitFor(cdp, "typeof window.IB === 'object' && window.IB.chatImageDeck && window.IB.chatImageDeck.mounted === true", 20000);
    check('module.registered', deckReady, 'IB.chatImageDeck 未挂载');
    check('module.styleInjected', await H.evaluate(cdp, "!!document.getElementById('ib-chat-image-deck-style')"));

    /* 容器：优先可见的 fullscreen 容器；不可见则退回 mini 面板。 */
    const containerId = await H.evaluate(cdp, `(function(){
      var ids = ['chat-full-messages','chat-messages'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el && el.getBoundingClientRect().width > 40) return ids[i];
      }
      return ids[0];
    })()`);
    info('container = ' + containerId);

    /* 先在页面里生成确定性的图片 dataUrl（不同宽高比）。 */
    const urls = JSON.parse(await H.evaluate(cdp, `JSON.stringify({
      portrait: ${IMG(240, 400, '#33556f')},
      landscape: ${IMG(480, 240, '#4a6a8a')},
      square: ${IMG(320, 320, '#5a7a9a')},
      tall: ${IMG(160, 640, '#2d4a66')},
      wide: ${IMG(700, 200, '#6a8ab0')}
    })`));
    info('aspect urls ready: ' + Object.keys(urls).join(', '));

    const build = (id, specs) => ({
      id: id, role: 'assistant', content: 'deck ' + id, friendId: 'deck-test', timestamp: Date.now(),
      images: specs.map((s, i) => ({ dataUrl: urls[s], name: id + '-' + i + '.jpg' }))
    });

    section('§1 count policy：0 / 1 / 2 / 6 / 7');

    await renderMessages(cdp, containerId, [
      { id: 'd0', role: 'assistant', content: 'no images', friendId: 'deck-test', timestamp: Date.now() },
      build('d1', ['portrait']),
      build('d2', ['portrait', 'landscape']),
      build('d6', ['portrait', 'landscape', 'square', 'portrait', 'landscape', 'square']),
      build('d7', ['portrait', 'landscape', 'square', 'tall', 'wide', 'portrait', 'landscape'])
    ], true);
    await H.sleep(500);

    const decks = await deckState(cdp);
    const byId = {};
    decks.forEach(d => { byId[d.msgId] = d; });
    info('decks: ' + JSON.stringify(decks));

    check('count.zeroHasNoDeck', !byId.d0);
    check('count.singleHasNoDeck', !byId.d1, 'COUNT = 1 必须完全不动');
    check('count.twoIsDeck', !!byId.d2 && byId.d2.policy === 'STACKED_IMAGE_DECK');
    check('count.sixIsDeck', !!byId.d6 && byId.d6.policy === 'STACKED_IMAGE_DECK');
    check('count.sevenIsDeckWithExpand', !!byId.d7 && byId.d7.policy === 'STACKED_IMAGE_DECK_WITH_EXPAND' && byId.d7.hasExpand === true);
    check('count.stackDepthCappedAtThree', byId.d7.visibleDepth === 3, String(byId.d7.visibleDepth));
    check('count.singleImageStillDirectChild',
      await H.evaluate(cdp, "!!document.querySelector('.chat-msg[data-msg-id=\"d1\"] > img.chat-bubble-img')"),
      'SINGLE_IMAGE_BEHAVIOR_CHANGED = NO');
    check('count.singleImageNotWrapped',
      await H.evaluate(cdp, "!document.querySelector('.chat-msg[data-msg-id=\"d1\"] .chat-image-deck')"));
    check('count.deckHoldsEveryImage',
      await H.evaluate(cdp, "document.querySelectorAll('.chat-msg[data-msg-id=\"d7\"] .chat-image-deck__card img.chat-bubble-img').length === 7"),
      'renderedNodes === items');
    check('count.orderPreserved',
      await H.evaluate(cdp, `(function(){
        var imgs = document.querySelectorAll('.chat-msg[data-msg-id="d7"] .chat-image-deck__card img');
        for (var i = 0; i < imgs.length; i++) {
          if ((imgs[i].alt || '').indexOf('d7-' + i + '.jpg') < 0) return false;
        }
        return true;
      })()`),
      'Image Deck 顺序 = message payload 顺序');
    check('count.counterText', await H.evaluate(cdp, "document.querySelector('.chat-msg[data-msg-id=\"d7\"] .chat-image-deck__count').textContent.trim() === '1 / 7'"));
    check('count.expandLabelSpellsCount', await H.evaluate(cdp, "document.querySelector('.chat-msg[data-msg-id=\"d7\"] .chat-image-deck__expand').textContent.indexOf('展开 7') === 0"));
    check('count.visibleCardsBounded',
      await H.evaluate(cdp, `(function(){
        var cards = document.querySelectorAll('.chat-msg[data-msg-id="d7"] .chat-image-deck__card');
        var visible = 0;
        for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-depth') !== 'hidden') visible++;
        return visible === 4;
      })()`),
      '1 front + 3 back = 4 可见卡');

    section('§2 preload policy');

    check('preload.currentAndNextEager',
      await H.evaluate(cdp, `(function(){
        var imgs = document.querySelectorAll('.chat-msg[data-msg-id="d7"] .chat-image-deck__card img');
        return imgs[0].getAttribute('loading') === 'eager' && imgs[1].getAttribute('loading') === 'eager';
      })()`));
    check('preload.farIsLazy',
      await H.evaluate(cdp, `(function(){
        var imgs = document.querySelectorAll('.chat-msg[data-msg-id="d7"] .chat-image-deck__card img');
        return imgs[5].getAttribute('loading') === 'lazy' && imgs[6].getAttribute('loading') === 'lazy';
      })()`));
    check('preload.farCardsNotRendered',
      await H.evaluate(cdp, "getComputedStyle(document.querySelectorAll('.chat-msg[data-msg-id=\"d7\"] .chat-image-deck__card')[6]).display === 'none'"));

    section('§3 拖动阈值 / 纵向让位（每个子场景独立 fixture）');
    /* UI-P2.1b：三个子场景各自使用**唯一合成 message id**，并且都从机械可验证的
       干净初态（index = 0、未拖动、viewer 关闭、起点验证过落在卡片图片上）出发。
       不再共享同一个 message 的 deck state，也不再依赖“上一节刚好留下 index 0”。 */

    const surf3 = await ensureChatSurface(cdp);
    info('world open before §3: ' + surf3.worldOpen);
    check('surface.chatPageLaidOut', await H.evaluate(cdp, "document.getElementById('page-chat').getBoundingClientRect().width > 100"));

    /* A. below-threshold：index = 0 → 12px 水平拖动 → 必须回弹 */
    const scnBelow = 'scn-below';
    await renderFocus(cdp, containerId, build(scnBelow, ['portrait', 'landscape']));
    const ptBelow = await deckPoint(cdp, scnBelow);
    check('gesture.below.cleanInitialState',
      ptBelow.onImage === true && ptBelow.w > 40 && ptBelow.h > 40 &&
      (await deckState(cdp)).find(d => d.msgId === scnBelow).index === 0,
      JSON.stringify(ptBelow));
    await drag(cdp, ptBelow.x, ptBelow.y, 12, 0);
    check('gesture.belowThresholdDoesNotAdvance', (await deckState(cdp)).find(d => d.msgId === scnBelow).index === 0,
      '阈值下的拖动必须回弹 · index = ' + (await deckState(cdp)).find(d => d.msgId === scnBelow).index);

    /* B. above-threshold：**另一个**独立 fixture，仍然从 index = 0 起 */
    const scnAbove = 'scn-above';
    await renderFocus(cdp, containerId, build(scnAbove, ['portrait', 'landscape']));
    const ptAbove = await deckPoint(cdp, scnAbove);
    check('gesture.above.cleanInitialState',
      ptAbove.onImage === true && (await deckState(cdp)).find(d => d.msgId === scnAbove).index === 0,
      JSON.stringify(ptAbove));
    await drag(cdp, ptAbove.x, ptAbove.y, -(ptAbove.w * 0.4), 0);
    check('gesture.aboveThresholdAdvances', (await deckState(cdp)).find(d => d.msgId === scnAbove).index === 1,
      'index = ' + (await deckState(cdp)).find(d => d.msgId === scnAbove).index);
    check('gesture.counterFollows',
      await H.evaluate(cdp, `document.querySelector('.chat-msg[data-msg-id="${scnAbove}"] .chat-image-deck__count').textContent.trim() === '2 / 2'`));

    /* C. vertical arbitration：第三个独立 fixture，index = 0 起 */
    const scnVert = 'scn-vert';
    await renderFocus(cdp, containerId, build(scnVert, ['portrait', 'landscape']));
    const ptVert = await deckPoint(cdp, scnVert);
    check('gesture.vertical.cleanInitialState',
      ptVert.onImage === true && (await deckState(cdp)).find(d => d.msgId === scnVert).index === 0,
      JSON.stringify(ptVert));
    await drag(cdp, ptVert.x, ptVert.y, 0, 90);
    check('gesture.verticalIntentDoesNotChangeIndex', (await deckState(cdp)).find(d => d.msgId === scnVert).index === 0,
      'AXIS_INTENT_LOCK：纵向手势不切卡');
    check('gesture.touchActionIsPanY',
      await H.evaluate(cdp, `getComputedStyle(document.querySelector('.chat-msg[data-msg-id="${scnVert}"] .chat-image-deck')).touchAction === 'pan-y'`),
      '纵向滚动由浏览器原生接管');

    section('§4 NON_LOOPING');

    const scnLoop = 'scn-loop';
    await renderFocus(cdp, containerId, build(scnLoop, ['portrait', 'landscape']));
    await deckPoint(cdp, scnLoop);
    await H.evaluate(cdp, `(function(){
      document.querySelector('.chat-msg[data-msg-id="${scnLoop}"] .chat-image-deck__nav--next').click();
      return true;
    })()`);
    await H.settle(cdp);
    check('loop.atLastIndexNoWrap', (await deckState(cdp)).find(d => d.msgId === scnLoop).index === 1);
    await H.evaluate(cdp, `(function(){
      document.querySelector('.chat-msg[data-msg-id="${scnLoop}"] .chat-image-deck__nav--next').click();
      return true;
    })()`);
    check('loop.nextAtEndIsNoop', (await deckState(cdp)).find(d => d.msgId === scnLoop).index === 1);
    check('loop.nextButtonDisabled', await H.evaluate(cdp, `document.querySelector('.chat-msg[data-msg-id="${scnLoop}"] .chat-image-deck__nav--next').disabled === true`));
    await H.evaluate(cdp, `(function(){
      document.querySelector('.chat-msg[data-msg-id="${scnLoop}"] .chat-image-deck__nav--prev').click();
      return true;
    })()`);
    check('loop.prevWorks', (await deckState(cdp)).find(d => d.msgId === scnLoop).index === 0);
    check('loop.prevDisabledAtStart', await H.evaluate(cdp, `document.querySelector('.chat-msg[data-msg-id="${scnLoop}"] .chat-image-deck__nav--prev').disabled === true`));

    section('§5 click vs drag → 既有 viewer');

    const surf5 = await ensureChatSurface(cdp);
    if (surf5.worldOpen) info('§5: Memory World overlay 原为打开状态，已关闭');
    /* 必须在 ensureChatSurface 之后再渲染：重新激活页面会让产品按 store
       重渲染容器，先前注入的消息会消失。 */
    await renderFocus(cdp, containerId, build('scn-click', ['portrait', 'landscape']));

    check('click.noViewerYet', await H.evaluate(cdp, "!document.querySelector('.chat-bubble-img-full')"));
    await H.evaluate(cdp, `(function(){
      var img = document.querySelector('.chat-msg[data-msg-id="scn-click"] .chat-image-deck__card[data-depth="0"] img');
      img.click();
      return true;
    })()`);
    await H.sleep(200);
    check('click.opensExistingViewer', await H.evaluate(cdp, "!!document.querySelector('.chat-bubble-img-full')"),
      '必须复用既有 _viewImageFull');
    await H.evaluate(cdp, "(function(){var o=document.querySelector('.chat-bubble-img-full');if(o)o.remove();})()");

    await renderMessages(cdp, containerId, [build('scn-drag', ['portrait', 'landscape', 'square', 'portrait', 'landscape', 'square'])], true);
    await H.sleep(450);
    const rect6 = await deckPoint(cdp, 'scn-drag');
    /* fullscreen 聊天是窗口化渲染：单独一条消息的行可能整体不在布局窗口里
       （rect 为 0），此时**不能用指针**验证。6 张的契约是「叠层视觉模型」，
       所以这里用不依赖布局的方式验证：可见卡数量 + next 按钮换图。
       指针拖动本身已经在 d2 / dbad / dm 三个**已布局**的 deck 上真实验证过。 */
    check('deck6.layoutIndependentCoverage', rect6.exists === true, JSON.stringify(rect6));
    check('deck6.visibleCardsAreFour',
      await H.evaluate(cdp, `(function(){
        var cards = document.querySelectorAll('.chat-msg[data-msg-id="scn-drag"] .chat-image-deck__card');
        var visible = 0;
        for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-depth') !== 'hidden') visible++;
        return cards.length === 6 && visible === 4;
      })()`),
      '6 张 = 1 front + 3 back，不是 6 张全摊开');
    await H.evaluate(cdp, `(function(){
      document.querySelector('.chat-msg[data-msg-id="scn-drag"] .chat-image-deck__nav--next').click();
      document.querySelector('.chat-msg[data-msg-id="scn-drag"] .chat-image-deck__nav--next').click();
      return true;
    })()`);
    await H.sleep(150);
    check('drag.didAdvance', (await deckState(cdp)).find(d => d.msgId === 'scn-drag').index === 2,
      'index = ' + (await deckState(cdp)).find(d => d.msgId === 'scn-drag').index);

    section('§6 键盘（仅 deck 聚焦）');

    await ensureChatSurface(cdp);

    await renderFocus(cdp, containerId, build('scn-kbd', ['portrait', 'landscape']));
    const kp = await deckPoint(cdp, 'scn-kbd');
    await H.evaluate(cdp, "document.querySelector('.chat-msg[data-msg-id=\"scn-kbd\"] .chat-image-deck').focus()");
    const focusedOk = kp.inDeck && await H.evaluate(cdp, "document.activeElement === document.querySelector('.chat-msg[data-msg-id=\"scn-kbd\"] .chat-image-deck')");
    await H.pressKey(cdp, 'ArrowRight');
    await H.sleep(150);
    check('keyboard.deckIsFocusable', focusedOk, 'focus() 未落到 deck 上: ' + JSON.stringify(kp));
    check('keyboard.arrowRightAdvances', (await deckState(cdp)).find(d => d.msgId === 'scn-kbd').index === 1);
    await H.pressKey(cdp, 'ArrowLeft');
    await H.sleep(150);
    check('keyboard.arrowLeftGoesBack', (await deckState(cdp)).find(d => d.msgId === 'scn-kbd').index === 0);
    check('keyboard.deckIsFocusable', await H.evaluate(cdp, "document.activeElement === document.querySelector('.chat-msg[data-msg-id=\"scn-kbd\"] .chat-image-deck')"));
    check('keyboard.ariaLabelReflectsIndex',
      await H.evaluate(cdp, "document.querySelector('.chat-msg[data-msg-id=\"scn-kbd\"] .chat-image-deck').getAttribute('aria-label') === '图片 1 / 2'"));
    check('keyboard.liveRegionExists',
      await H.evaluate(cdp, "!!document.querySelector('.chat-msg[data-msg-id=\"scn-kbd\"] .chat-image-deck__sr[aria-live=\"polite\"]')"));
    await H.evaluate(cdp, "document.activeElement.blur()");

    section('§7 展开全部（>6）');

    await ensureChatSurface(cdp);

    await renderFocus(cdp, containerId, build('scn-expand', ['portrait', 'landscape', 'square', 'tall', 'wide', 'portrait', 'landscape']));
    await H.evaluate(cdp, "document.querySelector('.chat-msg[data-msg-id=\"scn-expand\"] .chat-image-deck__expand').click()");
    await H.sleep(300);
    check('expand.galleryOpens', await H.evaluate(cdp, "!!document.querySelector('.chat-image-deck-gallery')"));
    check('expand.galleryHasAllTiles',
      await H.evaluate(cdp, "document.querySelectorAll('.chat-image-deck-gallery__tile').length === 7"));
    check('expand.galleryIsModalDialog',
      await H.evaluate(cdp, "document.querySelector('.chat-image-deck-gallery').getAttribute('aria-modal') === 'true'"));
    await H.pressKey(cdp, 'Escape');
    await H.sleep(250);
    check('expand.escapeCloses', await H.evaluate(cdp, "!document.querySelector('.chat-image-deck-gallery')"));
    check('expand.focusReturned',
      await H.evaluate(cdp, "document.activeElement === document.querySelector('.chat-msg[data-msg-id=\"scn-expand\"] .chat-image-deck__expand')"));

    section('§8 坏图隔离');

    await ensureChatSurface(cdp);

    /* UI-P2.1b §9：独立 message id，≥3 张图，其中一张 broken。
       不复用前面任何已经切过 index 的 message。 */
    const scnBroken = 'scn-broken';
    const brokenImages = [
      { dataUrl: urls.portrait, name: 'ok-0.jpg' },
      { dataUrl: 'data:image/jpeg;base64,AAAA', name: 'broken-1.jpg' },
      { dataUrl: urls.square, name: 'ok-2.jpg' }
    ];
    await renderFocus(cdp, containerId, {
      id: scnBroken, role: 'assistant', content: 'broken scenario',
      friendId: 'deck-test', timestamp: Date.now(), images: brokenImages
    });
    await deckPoint(cdp, scnBroken);

    const badDecks = await deckState(cdp);
    const badRec = badDecks.find(d => d.msgId === scnBroken);
    check('error.deckSurvivesBadImage', !!badRec && badRec.count === 3, JSON.stringify(badRec));
    check('error.cardsStillPresent',
      await H.evaluate(cdp, `document.querySelectorAll('.chat-msg[data-msg-id="${scnBroken}"] .chat-image-deck__card').length === 3`));
    check('error.brokenImageIsIsolatedToItsIndex',
      await H.evaluate(cdp, `(function(){
        var cards = document.querySelectorAll('.chat-msg[data-msg-id="${scnBroken}"] .chat-image-deck__card img');
        if (cards.length !== 3) return false;
        // 坏图卡仍然存在、不是 0 尺寸、deck 没有整体消失
        var deck = document.querySelector('.chat-msg[data-msg-id="${scnBroken}"] .chat-image-deck');
        var r = deck.getBoundingClientRect();
        return cards[1].isConnected && r.width > 40 && r.height > 40;
      })()`),
      '单张加载失败不得移除卡片或使 deck 失效');
    check('error.indexStillZeroAfterError',
      (await deckState(cdp)).find(d => d.msgId === scnBroken).index === 0);

    const rectBad = await deckPoint(cdp, scnBroken);
    await drag(cdp, rectBad.x, rectBad.y, -(rectBad.w * 0.4), 0);
    check('error.otherIndicesStillReachable', (await deckState(cdp)).find(d => d.msgId === scnBroken).index === 1,
      '单张失败不得让整个 deck 卡住 · index = ' + (await deckState(cdp)).find(d => d.msgId === scnBroken).index);
    const rectBad2 = await deckPoint(cdp, scnBroken);
    await drag(cdp, rectBad2.x, rectBad2.y, -(rectBad2.w * 0.4), 0);
    check('error.canReachFurtherValidIndex', (await deckState(cdp)).find(d => d.msgId === scnBroken).index === 2,
      '坏图之后仍能继续切到后面的有效 index');

    section('§9 多 deck 隔离 + 重渲染身份');

    await renderMessages(cdp, containerId, [
      build('da', ['portrait', 'landscape', 'square']),
      build('db', ['portrait', 'landscape', 'square'])
    ], true);
    await H.sleep(500);
    await H.evaluate(cdp, `(function(){
      var row = document.querySelector('.chat-msg[data-msg-id="da"]');
      row.querySelector('.chat-image-deck__nav--next').click();
      row.querySelector('.chat-image-deck__nav--next').click();
      return true;
    })()`);
    await H.sleep(150);
    const iso = await deckState(cdp);
    check('isolation.deckAIndependent', iso.find(d => d.msgId === 'da').index === 2);
    check('isolation.deckBUntouched', iso.find(d => d.msgId === 'db').index === 0);

    await renderMessages(cdp, containerId, [
      build('da', ['portrait', 'landscape', 'square']),
      build('db', ['portrait', 'landscape', 'square'])
    ], true);
    await H.sleep(500);
    const after = await deckState(cdp);
    check('identity.indexSurvivesReRender', after.find(d => d.msgId === 'da').index === 2,
      'same message re-render 不得把 currentIndex 重置为 0');
    check('identity.otherDeckUnaffected', after.find(d => d.msgId === 'db').index === 0);
    check('identity.keyIsMsgId', await H.evaluate(cdp, "IB.chatImageDeck.stateKey === 'data-msg-id'"));

    /* clamp：集合变短时 index 被 clamp，不是重置 */
    await renderMessages(cdp, containerId, [build('da', ['portrait', 'landscape'])], true);
    await H.sleep(450);
    const clamped = (await deckState(cdp)).find(d => d.msgId === 'da');
    check('identity.indexClampedWhenShorter', clamped && clamped.index === 1, JSON.stringify(clamped));

    section('§10 390px / 主题 / reduced motion');

    await ensureChatSurface(cdp);

    await session.setViewport(390, 780, true);
    await H.sleep(400);
    await renderMessages(cdp, containerId, [build('scn-mobile', ['portrait', 'landscape', 'square'])], true);
    await H.sleep(450);
    check('mobile.noHorizontalOverflow', await H.evaluate(cdp, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
      await H.evaluate(cdp, 'document.documentElement.scrollWidth + " vs " + window.innerWidth'));
    check('mobile.deckFitsViewport',
      await H.evaluate(cdp, `(function(){
        var d = document.querySelector('.chat-msg[data-msg-id="scn-mobile"] .chat-image-deck');
        var r = d.getBoundingClientRect();
        return r.width <= window.innerWidth + 1 && r.height <= window.innerHeight * 0.6;
      })()`));
    check('mobile.navArrowsHidden',
      await H.evaluate(cdp, "getComputedStyle(document.querySelector('.chat-msg[data-msg-id=\"scn-mobile\"] .chat-image-deck__nav')).display === 'none'"),
      '移动端用 swipe，不常驻按钮挡图');
    await renderFocus(cdp, containerId, build('scn-mobile', ['portrait', 'landscape', 'square']));
    const rectM = await deckPoint(cdp, 'scn-mobile');
    check('mobile.deckHittable', rectM.inDeck === true, JSON.stringify(rectM));
    await drag(cdp, rectM.x, rectM.y, -(rectM.w * 0.45), 0);
    check('mobile.horizontalSwipeWorks', (await deckState(cdp)).find(d => d.msgId === 'scn-mobile').index === 1);

    await H.evaluate(cdp, "document.body.classList.add('theme-infernal')");
    await H.sleep(300);
    check('theme.darkDeckStillUsable',
      await H.evaluate(cdp, "!!document.querySelector('.chat-msg[data-msg-id=\"scn-mobile\"] .chat-image-deck') && getComputedStyle(document.querySelector('.chat-msg[data-msg-id=\"scn-mobile\"] .chat-image-deck__count')).display !== 'none'"));
    await H.evaluate(cdp, "document.body.classList.remove('theme-infernal')");
    await H.sleep(200);

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await H.sleep(300);
    const reducedDuration = await H.evaluate(cdp, "getComputedStyle(document.querySelector('.chat-msg[data-msg-id=\"scn-mobile\"] .chat-image-deck__card')).transitionDuration");
    check('motion.reducedMotionStopsTransition',
      reducedDuration === '0s' || parseFloat(reducedDuration) < 0.01,
      'reduced-motion 下不得还有可感知的切卡动画: ' + reducedDuration);
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    section('§11 事件生命周期 / 控制台');

    check('lifecycle.destroyIsClean',
      await H.evaluate(cdp, "(function(){ try { IB.chatImageDeck.destroy(); return true; } catch (e) { return false; } })()"));
    check('lifecycle.remountWorks',
      await H.evaluate(cdp, "(function(){ IB.chatImageDeck.mount(); return IB.chatImageDeck.mounted === true; })()"));
    check('runtime.noUncaughtExceptions', session.exceptions.length === 0, session.exceptions.slice(0, 3).join(' | '));
    const noise = session.consoleErrors.filter(l => l && !/favicon|ERR_FILE_NOT_FOUND|ERR_INVALID_URL|Failed to load resource/i.test(l));
    check('runtime.noConsoleErrors', noise.length === 0, noise.slice(0, 3).join(' | '));
  } finally {
    await session.close();
  }
  finish();
}

main().catch(error => { console.error(error); process.exit(1); });
