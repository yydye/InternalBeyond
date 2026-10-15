'use strict';

/* Internal Beyond · P23 Phase 2B · Delivery Runtime 测试
   （static 组：零依赖、零网络、零浏览器、**零真实 sleep**）
   运行：node tests/test_delivery_runtime.js

   Phase 2B 的唯一目标：一个 sequence 如何被**交付**（谁先出现、什么时候出现、取消时
   留下什么、未交付的能不能被别人看见）。因此本测试用**假时钟**精确驱动时间，
   断言的都是可证伪的事实：交付顺序、时间线、typing 开合、队列状态、假 store 里的行、
   以及"未交付 unit 不在任何 consumer 的输入里"。

   覆盖用户给定的 A–Z：
     A 单条 fast path · B 3 条文本顺序交付 · C text→voice→text · D typing ON/OFF
     E deterministic timing · F max delay clamp · G 首条前 cancel · H 首条后 cancel
     I partial delivery preservation · J user interrupt 取消剩余 · K 会话切换隔离
     L 两个会话同时交付 · M voice 自动播放只在交付后 · N voice 交付失败
     O reload 语义 · P 未交付不在 DB · Q 未交付不在 context · R 未交付不在 memory/search
     S 已交付 unit 可撤回 · T 取消 queued unit · U legacy 单条不变 · V 顺序稳定
     W 不重复渲染 · X 不重复落库 · Y trace 不含秘密 · Z 定时器清理

   另含：supersede（新一轮顶掉旧一轮）、有界性、参数校验、分层守卫（runtime 不碰 DB/DOM）。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SeqCore = require(path.join(ROOT, 'assets', 'js', 'delivery-sequence-core.js'));
const RT = require(path.join(ROOT, 'assets', 'js', 'delivery-runtime.js'));
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));
const DialogueCore = require(path.join(ROOT, 'assets', 'js', 'dialogue-core.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
function sliceFunction(text, signature) {
  const at = text.indexOf(signature);
  if (at < 0) throw new Error('找不到 ' + signature);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('花括号不配对: ' + signature);
}
/* 取一个具名函数声明（含可能的 `async ` 前缀）。sliceFunction 从签名处开始切，
   因此异步函数必须先把它前面的 `async ` 一起纳入切片，否则 await 会变成语法错误。 */
function sliceNamed(src, name) {
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  if (at < 0) throw new Error('找不到 ' + name);
  const isAsync = src.slice(Math.max(0, at - 6), at) === 'async ';
  /* sliceFunction 从签名处开始切，所以异步前缀要在切完之后补回来。 */
  return (isAsync ? 'async ' : '') + sliceFunction(src.slice(at), sig);
}

/* ── 假时钟：时间只由 advance() 推进，绝不真实等待 ─────────────────── */
function fakeClock() {
  let now = 0, seq = 0, timers = [];
  return {
    now: function () { return now; },
    setTimeout: function (fn, ms) {
      const h = { id: ++seq, at: now + Math.max(0, Number(ms) || 0), fn: fn, ms: Number(ms) || 0 };
      timers.push(h); return h;
    },
    clearTimeout: function (h) { timers = timers.filter(t => t !== h); },
    advance: function (ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      for (;;) {
        timers.sort((a, b) => (a.at - b.at) || (a.id - b.id));
        const t = timers[0];
        if (!t || t.at > target) break;
        timers.shift(); now = t.at;
        t.fn();
      }
      now = target;
    },
    pending: function () { return timers.length; }
  };
}

/* ── 假 adapter（代替 communication.js 的落库+渲染），时间线可断言 ────── */
function fakeAdapter(clock, conversationId, opts) {
  const o = opts || {};
  const store = new Map();        /* 模拟 canonical store：id → 行 */
  const events = [];              /* {at,type,index,id} */
  const renders = [];
  return {
    store, events, renders,
    onUnit: function (unit, index) {
      events.push({ at: clock.now(), type: 'deliver', index: index, id: unit.message.id });
      if (o.failAt != null && index === o.failAt) return { ok: false, reason: 'unit-failed' };
      if (o.throwAt != null && index === o.throwAt) throw new Error('adapter-boom');
      if (!store.has(unit.message.id)) store.set(unit.message.id, unit.message);   /* id 幂等（Home Node 语义） */
      renders.push({ at: clock.now(), index: index, id: unit.message.id, conversationId: conversationId });
      return { ok: true };
    }
  };
}

const TS = 1700000000000;
const FID = 'friend_1';
const CONV = 'dm:friend_1';
const CONV2 = 'dm:friend_2';
const TURN = SeqCore.turnIdFor('msg_1700000000100_u');
const TURN2 = SeqCore.turnIdFor('msg_1700000000200_u');
const AUDIO = 'data:audio/wav;base64,' + Buffer.from('RIFF0000WAVEfmt-delivery').toString('base64');

function buildTexts(texts, over) {
  return SeqCore.buildMessages(
    { turnId: TURN, units: texts.map(t => ({ kind: 'text', text: t })) },
    Object.assign({ friendId: FID, timestamp: TS, model: 'p', configId: FID }, over || {})
  );
}
function buildVoice(text, turnId) {
  return SeqCore.buildMessages(
    { turnId: turnId || TURN, units: [{ kind: 'voice', text: text, dataUrl: AUDIO, mime: 'audio/wav', duration: 2 }] },
    { friendId: FID, timestamp: TS, model: 'p', configId: FID }
  )[0];
}
/* 一条**混合** sequence：必须整体构造（同一回合的 index 由 core 连续分配），
   绝不能把三条各自构造的消息拼起来 —— 那样它们会是同一个 turnId + 同一个 index。 */
function buildMixed(specs, over) {
  const units = specs.map(s => (s.voice
    ? { kind: 'voice', text: s.text, dataUrl: AUDIO, mime: 'audio/wav', duration: 2 }
    : { kind: 'text', text: s.text }));
  return SeqCore.buildMessages(
    { turnId: TURN, units: units },
    Object.assign({ friendId: FID, timestamp: TS, model: 'p', configId: FID }, over || {})
  );
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function unitsOf(msgs, deliveries) {
  return msgs.map((m, i) => ({
    kind: m.voice ? 'voice' : 'text', content: m.content,
    delivery: (deliveries || [])[i] || null, message: m
  }));
}
function makeRuntime(clock) {
  const events = [];
  const rt = RT.createDeliveryRuntime({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onEvent: function (ev) { events.push(ev); }
  });
  return { rt, events };
}
/* 便捷：交付一整条 sequence 并推进时钟到结束 */
function runSequence(msgs, opts) {
  const o = opts || {};
  const clock = fakeClock();
  const { rt, events } = makeRuntime(clock);
  const conv = o.conversationId || CONV;
  const ad = fakeAdapter(clock, conv, o.adapter);
  const typ = [];
  const handle = rt.enqueue({
    turnId: o.turnId || TURN, conversationId: conv, scope: o.scope,
    units: unitsOf(msgs, o.deliveries), onUnit: ad.onUnit,
    onTyping: on => typ.push({ at: clock.now(), on: on })
  });
  clock.advance(o.advance == null ? 120000 : o.advance);
  return { clock, rt, events, ad, typ, handle };
}

/* ── A/B/C/V/W/X · 交付顺序与幂等 ───────────────────────────────────── */
function deliveryOrder() {
  /* A · 单条 fast path：零等待、零 typing、零定时器 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['不是，你等等']);
    const ad = fakeAdapter(clock, CONV);
    const typ = [];
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit, onTyping: on => typ.push({ at: clock.now(), on: on }) });
    ok('A.fastpath.deliveredImmediately', ad.store.size === 1 && ad.events[0].at === 0, JSON.stringify(ad.events));
    ok('A.fastpath.noTyping', typ.length === 0, JSON.stringify(typ));
    ok('A.fastpath.noTimer', clock.pending() === 0 && rt.hasPendingTimer() === false);
    ok('A.fastpath.queueReleased', rt.stateOf(CONV) === 'idle' && rt.activeCount() === 0);
  }
  /* B · 3 条文本顺序交付 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['一', '二', '三']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    ok('B.order.firstImmediate', ad.events.length === 1 && ad.events[0].index === 0);
    clock.advance(120000);
    ok('B.order.allDelivered', ad.store.size === 3, ad.store.size);
    ok('B.order.sequenceAscending', ad.events.map(e => e.index).join(',') === '0,1,2', JSON.stringify(ad.events.map(e => e.index)));
    ok('B.order.monotonicTime', ad.events.every((e, i) => i === 0 || e.at >= ad.events[i - 1].at));
    ok('B.order.contentIntact', [...ad.store.values()].map(m => m.content).join('|') === '一|二|三');
  }
  /* C · text → voice → text */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildMixed([{ text: 'A' }, { text: 'C', voice: true }, { text: 'D' }]);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    clock.advance(120000);
    ok('C.mixed.idsDistinct', new Set(ms.map(m => m.id)).size === 3, JSON.stringify(ms.map(m => m.id)));
    ok('C.mixed.threeDelivered', ad.store.size === 3);
    ok('C.mixed.voiceIsCanonical', VoiceCore.hasPlayable(ms[1].voice) && VoiceCore.isAiVoiceMessage(ms[1]) === true);
    ok('C.mixed.contentOrder', ad.renders.map(r => ms[r.index].content).join('|') === 'A|C|D', JSON.stringify(ad.renders));
  }
  /* V · 顺序稳定：给定顺序 = 交付顺序 = reload 后的 canonical 顺序 */
  {
    const r = runSequence(buildTexts(['一', '二', '三', '四']));
    const rows = [...r.ad.store.values()];
    ok('V.stable.deliveryOrderMatchesGiven', r.ad.renders.map(x => x.id).join(',') === buildTexts(['一', '二', '三', '四']).map(m => m.id).join(','));
    ok('V.stable.reloadOrderPreserved', SeqCore.orderMessages(rows).map(m => m.metadata.sequenceIndex).join(',') === '0,1,2,3');
    ok('V.stable.turnIdentityIntact', rows.every(m => m.metadata.turnId === TURN));
  }
  /* W/X · 不重复渲染、不重复落库 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['一', '二']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    clock.advance(120000);
    const renders1 = ad.renders.length;
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    clock.advance(120000);
    ok('W.noDup.oneRenderPerUnit', ad.renders.length === renders1 + ms.length, ad.renders.length);
    ok('X.noDup.storeRowsStable', ad.store.size === ms.length, ad.store.size);
    const deliverySrc = sliceFunction(read('assets/js/communication.js'), 'async function _ibDeliverUnit(');
    ok('X.noDup.singlePersistSiteInAdapter', (deliverySrc.match(/dbPut\('chatMessages'/g) || []).length === 1);
    ok('X.noDup.runtimeNeverWrites', !/dbPut|chatMessages/.test(stripComments(read('assets/js/delivery-runtime.js'))));
  }
}

/* ── D/E/F/Z · typing 与时间契约 ────────────────────────────────────── */
function timing() {
  /* D · typing ON → (typingDuration) → OFF → 交付 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['一', '二']);
    const ad = fakeAdapter(clock, CONV);
    const typ = [];
    rt.enqueue({
      turnId: TURN, conversationId: CONV, units: unitsOf(ms, [null, { delayBefore: 300, typingDuration: 650 }]),
      onUnit: ad.onUnit, onTyping: on => typ.push({ at: clock.now(), on: on })
    });
    clock.advance(300);
    ok('D.typing.quietDuringDelay', ad.store.size === 1 && (typ.length === 0 || typ[0].at >= 300), JSON.stringify(typ));
    ok('D.typing.onExactlyAtDelayEnd', typ.length === 1 && typ[0].on === true && typ[0].at === 300, JSON.stringify(typ));
    clock.advance(649);
    ok('D.typing.stillOnBeforeDuration', typ.length === 1 && ad.store.size === 1, JSON.stringify(typ) + ' store=' + ad.store.size);
    clock.advance(1);
    ok('D.typing.offThenDelivered', typ.length === 2 && typ[1].on === false && ad.store.size === 2, JSON.stringify(typ) + ' store=' + ad.store.size);
    ok('D.typing.totalTimeline', ad.events[1].at === 950, JSON.stringify(ad.events));
    ok('D.typing.cleanedAtEnd', clock.pending() === 0 && rt.hasPendingTimer() === false);
  }
  /* E · deterministic timing */
  {
    const run = () => {
      const r = runSequence(buildTexts(['一', '二', '三']));
      return r.ad.events.map(e => e.at + ':' + e.index).join('|');
    };
    ok('E.deterministic.identicalTimeline', run() === run(), run());
    ok('E.deterministic.matchesFormula', (() => {
      const t1 = RT.timingFor({ kind: 'text', content: '二' }, '一', null, false);
      const t2 = RT.timingFor({ kind: 'text', content: '三' }, '二', null, false);
      return t1.delayBefore === RT.defaultDelay('一') && t1.typingDuration === RT.defaultTyping('二')
        && t2.delayBefore === RT.defaultDelay('二') && t2.typingDuration === RT.defaultTyping('三');
    })());
    ok('E.deterministic.noRandom', !/Math\.random/.test(stripComments(read('assets/js/delivery-runtime.js'))));
    ok('E.deterministic.firstUnitNoWait', JSON.stringify(RT.timingFor({ kind: 'text', content: 'x' }, '', null, true))
      === JSON.stringify({ delayBefore: 0, typingDuration: 0, explicit: false }));
  }
  /* F · clamp：延迟与 typing 都有上界 */
  {
    const t = RT.timingFor({ kind: 'text', content: 'x', delivery: { delayBefore: 999999, typingDuration: 999999 } }, '', null, false);
    ok('F.clamp.delayMax', t.delayBefore === RT.DELAY_MAX, t.delayBefore);
    ok('F.clamp.typingMax', t.typingDuration === RT.TYPING_MAX, t.typingDuration);
    ok('F.clamp.negativeBecomesMin', RT.timingFor({ kind: 'text', content: 'x', delivery: { delayBefore: -5, typingDuration: -5 } }, '', null, false).delayBefore === 0);
    ok('F.clamp.boundedTotal', (RT.DELAY_MAX + RT.TYPING_MAX) <= 20000, RT.DELAY_MAX + RT.TYPING_MAX);
    const r = runSequence(buildTexts(['一', '二']), { deliveries: [null, { delayBefore: 999999, typingDuration: 999999 }], advance: RT.DELAY_MAX + RT.TYPING_MAX });
    ok('F.clamp.deliveredWithinBound', r.ad.store.size === 2 && r.ad.events[1].at === RT.DELAY_MAX + RT.TYPING_MAX, JSON.stringify(r.ad.events));
  }
  /* Z · 定时器清理 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['一', '二', '三']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    rt.abort(CONV, 'test');
    ok('Z.timers.clearedOnCancel', clock.pending() === 0 && rt.hasPendingTimer() === false);
    ok('Z.timers.disposeClears', (() => {
      const c3 = fakeClock(); const r3 = makeRuntime(c3).rt;
      r3.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(buildTexts(['一', '二'])), onUnit: () => true });
      r3.dispose();
      return c3.pending() === 0 && r3.activeCount() === 0;
    })());
    ok('Z.timers.exactlyOnePerQueue', (() => {
      const c4 = fakeClock(); const r4 = makeRuntime(c4).rt;
      r4.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(buildTexts(['一', '二', '三'])), onUnit: () => true });
      return c4.pending() === 1;
    })());
  }
}

/* ── G/H/I/J/T · cancel 与 user interrupt ──────────────────────────── */
function cancellation() {
  /* G · 首条交付前 cancel：什么都不进 conversation */
  {
    const clock = fakeClock(); const { rt, events } = makeRuntime(clock);
    const ms = buildTexts(['一', '二', '三']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms, [{ delayBefore: 500 }, { delayBefore: 500 }, { delayBefore: 500 }]), onUnit: ad.onUnit });
    rt.abort(CONV, 'cancel-before-first');
    clock.advance(120000);
    ok('G.cancelBeforeFirst.nothingDelivered', ad.store.size === 0 && ad.renders.length === 0, ad.store.size);
    ok('G.cancelBeforeFirst.terminalState', events.some(e => e.state === 'cancelled' && e.reason === 'cancel-before-first'));
    ok('G.cancelBeforeFirst.noTypingLeftOn', clock.pending() === 0);
  }
  /* H/I · 首条交付后 cancel：保留已交付（partial delivery preservation） */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['A', 'B', 'C']);
    const ad = fakeAdapter(clock, CONV);
    const h = rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    ok('H.cancelAfterFirst.firstDelivered', ad.store.size === 1 && ad.store.get(ms[0].id) === ms[0]);
    rt.abort(CONV, 'cancel-after-first');
    clock.advance(120000);
    ok('H.cancelAfterFirst.remainingNotDelivered', ad.store.size === 1, ad.store.size);
    ok('I.partial.deliveredKept', ad.store.has(ms[0].id) && !ad.store.has(ms[1].id) && !ad.store.has(ms[2].id));
    ok('I.partial.stateCancelled', rt.stateOf(CONV) === 'idle' && h.state === 'cancelled', h.state);
    ok('I.partial.traceHasDeliveredThenCancelled', (() => {
      const t = rt.trace(20);
      return t.some(e => e.state === 'delivered' && e.sequenceIndex === 0) && t.some(e => e.state === 'cancelled');
    })());
  }
  /* J · user interrupt：取消剩余（与 cancel 同一路径，reason 可区分） */
  {
    const clock = fakeClock(); const { rt, events } = makeRuntime(clock);
    const ms = buildTexts(['A', 'B', 'C']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    clock.advance(1);                                  /* 让 A 交付 */
    rt.abort(CONV, 'user_interrupt');
    clock.advance(120000);
    ok('J.interrupt.remainingCancelled', ad.store.size === 1, ad.store.size);
    ok('J.interrupt.reasonRecorded', events.some(e => e.state === 'cancelled' && e.reason === 'user_interrupt'));
    ok('J.interrupt.deliveredNotDeleted', ad.store.has(ms[0].id));
    /* 幂等：重复 abort 无副作用 */
    ok('J.interrupt.idempotent', rt.abort(CONV, 'user_interrupt') === false);
  }
  /* T · 取消 queued unit（不是 chatMessage ⇒ 只能通过 cancel，不能 withdraw） */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['A', 'B']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms, [{ delayBefore: 400 }, { delayBefore: 400 }]), onUnit: ad.onUnit });
    ok('T.queued.notInStore', ad.store.size === 0);
    ok('T.queued.noMessageRowExists', !ad.store.has(ms[0].id) && !ad.store.has(ms[1].id));
    rt.abort(CONV, 'cancel-queued');
    clock.advance(120000);
    ok('T.queued.cancelledWithoutRow', ad.store.size === 0);
    ok('T.queued.pendingCleared', rt.pending(CONV) === null);
  }
  /* supersede：同一会话新一轮 ⇒ 旧队列置 cancelled('superseded') */
  {
    const clock = fakeClock(); const { rt, events } = makeRuntime(clock);
    const first = buildTexts(['旧A', '旧B', '旧C']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(first), onUnit: ad.onUnit });
    const second = buildTexts(['新A', '新B'], { turnId: TURN2 });
    rt.enqueue({ turnId: TURN2, conversationId: CONV, units: unitsOf(second), onUnit: ad.onUnit });
    clock.advance(120000);
    ok('SUPERSEDE.oldCancelled', events.some(e => e.state === 'cancelled' && e.reason === 'superseded' && e.turnId === TURN));
    ok('SUPERSEDE.oldDeliveredKept', ad.store.has(first[0].id));
    ok('SUPERSEDE.oldRemainingDropped', !ad.store.has(first[1].id) && !ad.store.has(first[2].id));
    ok('SUPERSEDE.newFullyDelivered', ad.store.has(second[0].id) && ad.store.has(second[1].id));
  }
}

/* ── K/L · 会话与 thread 隔离 ───────────────────────────────────────── */
function isolation() {
  /* K · 一个会话的 cancel 不影响另一个会话 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const a = buildTexts(['A1', 'A2', 'A3']);
    const b = buildTexts(['B1', 'B2'], { turnId: TURN2, friendId: 'friend_2' });
    const adA = fakeAdapter(clock, CONV);
    const adB = fakeAdapter(clock, CONV2);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(a), onUnit: adA.onUnit });
    rt.enqueue({ turnId: TURN2, conversationId: CONV2, units: unitsOf(b), onUnit: adB.onUnit });
    rt.abort(CONV, 'user_stop');
    clock.advance(120000);
    ok('K.isolation.abortedStaysPartial', adA.store.size === 1, adA.store.size);
    ok('K.isolation.otherConversationComplete', adB.store.size === 2, adB.store.size);
    ok('K.isolation.rendersTaggedByConversation', adB.renders.every(r => r.conversationId === CONV2));
    ok('K.isolation.stateQueryPerConversation', rt.stateOf(CONV) === 'idle' && rt.stateOf(CONV2) === 'idle');
  }
  /* L · 两个会话**同时**交付：各自独立推进、互不重排 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const a = buildTexts(['A1', 'A2', 'A3']);
    const b = buildTexts(['B1', 'B2', 'B3'], { turnId: TURN2, friendId: 'friend_2' });
    const adA = fakeAdapter(clock, CONV);
    const adB = fakeAdapter(clock, CONV2);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(a), onUnit: adA.onUnit });
    rt.enqueue({ turnId: TURN2, conversationId: CONV2, units: unitsOf(b), onUnit: adB.onUnit });
    ok('L.concurrent.twoActiveQueues', rt.activeCount() === 2, rt.activeCount());
    clock.advance(120000);
    ok('L.concurrent.bothComplete', adA.store.size === 3 && adB.store.size === 3);
    ok('L.concurrent.interleavedButIndependent', adA.events.map(e => e.index).join(',') === '0,1,2'
      && adB.events.map(e => e.index).join(',') === '0,1,2');
    ok('L.concurrent.identityPerQueue', [...adA.store.values()].every(m => m.friendId === 'friend_1')
      && [...adB.store.values()].every(m => m.friendId === 'friend_2'));
  }
  /* thread 隔离：conversationId 携带 thread ⇒ 两个队列互不覆盖 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const main = buildTexts(['主1', '主2']);
    const th = buildTexts(['话1', '话2'], { threadId: 'th_1', turnId: TURN2 });
    const adMain = fakeAdapter(clock, 'dm:friend_1');
    const adTh = fakeAdapter(clock, 'dm:friend_1|th_1');
    rt.enqueue({ turnId: TURN, conversationId: 'dm:friend_1', units: unitsOf(main), onUnit: adMain.onUnit });
    rt.enqueue({ turnId: TURN2, conversationId: 'dm:friend_1|th_1', units: unitsOf(th), onUnit: adTh.onUnit });
    clock.advance(120000);
    ok('K.isolation.threadSeparateQueue', adMain.store.size === 2 && adTh.store.size === 2);
    ok('K.isolation.threadRowsTagged', [...adTh.store.values()].every(m => m.threadId === 'th_1'));
  }
}

/* ── M/N · voice 交付与失败 ─────────────────────────────────────────── */
function voiceDelivery() {
  /* M · voice 只在它自己的交付时刻出现（绝不在 sequence 创建/首条交付时就播） */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildMixed([{ text: 'A' }, { text: 'C', voice: true }, { text: 'D' }]);
    const ad = fakeAdapter(clock, CONV);
    const plays = [];   /* 模拟"自动播放"：只在 voice unit 被交付后才会被触发 */
    const wrapped = {
      store: ad.store, events: ad.events, renders: ad.renders,
      onUnit: function (unit, index) {
        const res = ad.onUnit(unit, index);
        if (unit.kind === 'voice') plays.push({ at: clock.now(), index: index, id: unit.message.id });
        return res;
      }
    };
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: wrapped.onUnit });
    ok('M.voice.notPlayedAtSequenceStart', plays.length === 0, JSON.stringify(plays));
    clock.advance(50);
    ok('M.voice.notPlayedWhileTextDelivering', plays.length === 0, JSON.stringify(plays) + ' store=' + ad.store.size);
    clock.advance(120000);
    ok('M.voice.playedExactlyOnce', plays.length === 1 && plays[0].index === 1, JSON.stringify(plays));
    ok('M.voice.playedAfterItsDelivery', plays[0].at === ad.events[1].at, JSON.stringify({ play: plays[0], deliver: ad.events[1] }));
    ok('M.voice.autoplayIsDomAttachDriven', /if\(vc\.autoPlay\)\{/.test(read('assets/js/bridge.js'))
      && /_ibTtsEnqueue\(bubble,btn,vc\)/.test(read('assets/js/bridge.js')));
  }
  /* N · voice 交付失败：停止剩余、保留已交付、不静默继续 */
  {
    const r = runSequence(buildMixed([{ text: 'A' }, { text: 'C', voice: true }, { text: 'D' }]), {
      adapter: { failAt: 1 }, advance: 120000
    });
    ok('N.failure.stopsRemaining', r.ad.store.size === 1, r.ad.store.size);
    ok('N.failure.stateFailed', r.events.some(e => e.state === 'failed' && e.reason === 'unit-failed'), JSON.stringify(r.events.filter(e => e.state === 'failed')));
    ok('N.failure.deliveredKept', !!r.ad.store.values().next().value);
    ok('N.failure.noSilentContinue', !r.ad.renders.some(x => x.index === 2), JSON.stringify(r.ad.renders));
    ok('N.failure.noTimersLeft', r.clock.pending() === 0);
    /* adapter 抛错同样 fail closed */
    const r2 = runSequence(buildTexts(['A', 'B', 'C']), { adapter: { throwAt: 1 }, advance: 120000 });
    ok('N.failure.adapterThrewIsFailClosed', r2.ad.store.size === 1 && r2.events.some(e => e.state === 'failed' && e.reason === 'unit-threw'));
  }
  /* voice 不可播放的消息根本不该进队列（Phase 2A 已在构造期拒绝） */
  {
    const bad = SeqCore.buildMessages({ turnId: TURN, units: [{ kind: 'voice', text: 'no-audio' }] }, { friendId: FID, timestamp: TS });
    ok('N.failure.unplayableNeverBuilt', bad.length === 0);
    const v = SeqCore.validate({ turnId: TURN, units: [{ kind: 'voice', text: 'x' }] });
    ok('N.failure.unplayableReported', v.ok === false && v.errors.join(',').indexOf('unplayable-voice:0') >= 0, JSON.stringify(v.errors));
  }
}

/* ── O/P/Q/R · reload 与 consumer 隔离 ──────────────────────────────── */
function isolationFromConsumers() {
  /* P · 未交付 unit 不在 DB（队列只是内存状态） */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['A', 'B', 'C']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
    const p = rt.pending(CONV);
    ok('P.queued.pendingReportsRemaining', p && p.cursor === 1 && p.total === 3, JSON.stringify(p));
    ok('P.queued.onlyDeliveredRowsExist', ad.store.size === 1 && ad.store.has(ms[0].id));
    ok('P.queued.undeliveredIdsAbsent', !ad.store.has(ms[1].id) && !ad.store.has(ms[2].id));
    clock.advance(120000);
    ok('P.queued.allRowsAfterCompletion', ad.store.size === 3);
  }
  /* Q · 未交付 unit 不在 provider context / 对话证据里 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['已交付的话', '尚未交付的话']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms, [null, { delayBefore: 5000 }]), onUnit: ad.onUnit });
    const rows = [...ad.store.values()];
    const history = rows.map(m => ({ role: m.role, content: m.content }));
    const evidence = DialogueCore.lines({ history: history, userMessage: '等等' });
    ok('Q.context.onlyDeliveredRows', rows.length === 1 && rows[0].content === '已交付的话');
    ok('Q.context.futureTextAbsent', evidence.join('\n').indexOf('尚未交付的话') < 0, JSON.stringify(evidence));
    ok('Q.context.userTurnStillPresent', evidence.join('\n').indexOf('等等') >= 0);
    clock.advance(120000);
    ok('Q.context.appearsOnlyAfterDelivery', [...ad.store.values()].length === 2);
  }
  /* R · 未交付 unit 不在 search / memory 取样里 */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['我会在梦里记得你', '未来的那句话']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms, [null, { delayBefore: 5000 }]), onUnit: ad.onUnit });
    const search = q => [...ad.store.values()].filter(m => String(m.content || '').includes(q));
    ok('R.search.deliveredHit', search('梦里').length === 1);
    ok('R.search.futureMiss', search('未来').length === 0);
    const sample = SeqCore.orderMessages([...ad.store.values()]).slice(-2).map(m => m.content);
    ok('R.memory.sampleOnlyDelivered', sample.length === 1 && sample[0] === '我会在梦里记得你', JSON.stringify(sample));
    ok('R.memory.queueHoldsNoConsumerSurface', !/chatMessages|dbPut|dbGet/.test(stripComments(read('assets/js/delivery-runtime.js'))));
  }
  /* O · reload 语义：队列 ephemeral，已交付的仍在新 runtime 的视野里（在 DB 里） */
  {
    const clock = fakeClock(); const { rt } = makeRuntime(clock);
    const ms = buildTexts(['A', 'B', 'C']);
    const ad = fakeAdapter(clock, CONV);
    rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms, [null, { delayBefore: 2000 }, { delayBefore: 4000 }]), onUnit: ad.onUnit });
    const before = rt.pending(CONV);
    const clock2 = fakeClock();
    const fresh = makeRuntime(clock2).rt;      /* 模拟 reload：新 runtime 实例 */
    ok('O.reload.pendingQueueIsEphemeral', before && before.state === 'delivering' && fresh.pending(CONV) === null);
    ok('O.reload.noResumeAfterReload', fresh.stateOf(CONV) === 'idle' && fresh.activeCount() === 0);
    ok('O.reload.deliveredRowsSurvive', ad.store.size === 1 && ad.store.has(ms[0].id));
    clock.advance(120000);
    ok('O.reload.oldRuntimeStillFinishesOwnQueue', ad.store.size === 3);   /* 队列本身没被 reload 语义污染 */
  }
}

/* ── S/U · 已交付 unit 的撤回入口 / legacy 单条不变 ─────────────────── */
function deliveredWithdrawAndLegacy() {
  /* S · 已交付 unit 走普通 message withdraw（真实函数体，桩 store） */
  {
    const ms = buildTexts(['A', 'B']);
    const src = read('assets/js/communication.js');
    const fnSrc = sliceFunction(src, 'async function _chatWithdrawMsg(');
    const store = new Map(ms.map(m => [m.id, JSON.parse(JSON.stringify(m))]));
    const writes = [];
    const fn = new Function('dbGet', 'dbPut', 'document', '_chatCfgById', 'window', 'activeFriendId', 'appendChatBubble', 'return (' + fnSrc + ')')(
      async (s, k) => (store.get(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
      async (s, d) => { store.set(d.id, JSON.parse(JSON.stringify(d))); writes.push(d.id); },
      { querySelectorAll: () => ({ forEach: () => { } }) },
      () => ({ nickname: 'X' }), { IBVoiceMessage: VoiceCore }, null, () => { }
    );
    return fn(ms[0].id).then(() => {
      ok('S.withdraw.deliveredUnitWithdrawable', store.get(ms[0].id).withdrawn === true && writes.length === 1);
      ok('S.withdraw.siblingUntouched', store.get(ms[1].id).content === 'B' && !store.get(ms[1].id).withdrawn);
      ok('S.withdraw.queuedHasNoMessageId', (() => {
        /* queued unit 不是 chatMessage ⇒ 没有可撤回的 id：队列里只有 message 引用，未被交付前不在 store */
        const clock = fakeClock(); const { rt } = makeRuntime(clock);
        const q = buildTexts(['Q1', 'Q2']);
        const ad = fakeAdapter(clock, CONV);
        rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(q, [{ delayBefore: 900 }, { delayBefore: 900 }]), onUnit: ad.onUnit });
        return ad.store.size === 0 && rt.pending(CONV) !== null;
      })());
    });
  }
  /* U · legacy 单条路径不变（源码级 + 行为级） */
  {
    const comm = read('assets/js/communication.js');
    ok('U.legacy.singleWriteUnchanged', comm.indexOf("await dbPut('chatMessages',aiMsg);") >= 0
      && /appendChatBubble\('ai',replyText,undefined,thinkingText\|\|undefined,aiMsg\.id/.test(comm));
    ok('U.legacy.resultShapeUnchanged', /_sendResult=\{ok:true,replyText:replyText,messageId:aiMsg\.id,userMessageId:userMsg\.id\}/.test(comm));
    ok('U.legacy.runtimeOnlyOnSequencePath', /const _waifuMsgs=_waifuSegs\?_ibSequenceMessages\(/.test(comm)
      && /const _wHandle=_ibStartDelivery\(\{/.test(comm));
    ok('U.legacy.typingStillSingleImplementation', (comm.match(/classList|className='chat-typing'|className=\"chat-typing\"/g) || []).length <= 2);
    /* 行为：单条（无 delivery 提示）零等待零 typing，且只写一行 */
    const r = runSequence(buildTexts(['hello']));
    ok('U.legacy.singleUnitNoDelay', r.ad.events.length === 1 && r.ad.events[0].at === 0 && r.typ.length === 0, JSON.stringify({ ev: r.ad.events, typ: r.typ }));
    ok('U.legacy.singleUnitOneRow', r.ad.store.size === 1);
  }
}

/* ── Y · trace 不含秘密 / 不含正文 ─────────────────────────────────── */
function traceSafety() {
  const clock = fakeClock(); const { rt, events } = makeRuntime(clock);
  const ms = buildTexts(['秘密前的那句话', '第二句话']);
  const ad = fakeAdapter(clock, CONV);
  rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms), onUnit: ad.onUnit });
  clock.advance(120000);
  const t = rt.trace(50);
  const allowed = ['at', 'turnId', 'conversationId', 'scope', 'sequenceIndex', 'state', 'reason', 'seq'];
  ok('Y.trace.hasEntries', t.length >= 3, t.length);
  ok('Y.trace.keysAreClosedSet', t.every(e => Object.keys(e).every(k => allowed.indexOf(k) >= 0)),
    JSON.stringify(t.map(e => Object.keys(e))));
  const blob = JSON.stringify(t);
  ok('Y.trace.noContent', blob.indexOf('秘密前的那句话') < 0 && blob.indexOf('第二句话') < 0, blob.slice(0, 200));
  ok('Y.trace.noSecretShape', !/sk-[A-Za-z0-9_-]{8,}|Bearer\s|apiKey|token/i.test(blob), blob.slice(0, 200));
  ok('Y.trace.statesRecorded', t.some(e => e.state === 'queued') && t.some(e => e.state === 'delivered') && t.some(e => e.state === 'completed'));
  ok('Y.trace.identityRecorded', t.every(e => e.turnId === TURN && e.conversationId === CONV));
  ok('Y.trace.bounded', RT.TRACE_MAX <= 512 && rt.trace(100000).length <= RT.TRACE_MAX);
  /* 事件流向 app 层（onEvent）也不含正文 */
  ok('Y.trace.eventsNoContent', JSON.stringify(events).indexOf('秘密前的那句话') < 0);
  /* 秘密形状的文本在**构造期**就被拒（fail closed）⇒ 根本进不了队列与 trace */
  ok('Y.secret.neverReachesQueue', (() => {
    const c2 = fakeClock(); const r2 = makeRuntime(c2).rt;
    const badMsgs = buildTexts(['first', 'sk-this-must-never-be-delivered-0001']);
    const ad2 = fakeAdapter(c2, CONV);
    const h = r2.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(badMsgs), onUnit: ad2.onUnit });
    c2.advance(120000);
    return badMsgs.length === 0 && h === null && ad2.store.size === 0 && r2.trace(10).length === 0;
  })());
  ok('Y.secret.rejectedAtBuildTime', (() => {
    const v = SeqCore.validate({ turnId: TURN, units: [{ kind: 'text', text: 'sk-should-never-appear-0001' }] });
    return v.ok === false && v.errors.join(',').indexOf('secret-in-unit:0') >= 0;
  })());
}

/* ── 契约守卫：参数校验 / 有界性 / 分层 ─────────────────────────────── */
function contractGuards() {
  const clock = fakeClock(); const { rt } = makeRuntime(clock);
  const ms = buildTexts(['x']);
  ok('GUARD.enqueue.requiresConversationId', rt.enqueue({ turnId: TURN, units: unitsOf(ms), onUnit: () => true }) === null);
  ok('GUARD.enqueue.requiresUnits', rt.enqueue({ turnId: TURN, conversationId: CONV, units: [], onUnit: () => true }) === null);
  ok('GUARD.enqueue.requiresOnUnit', rt.enqueue({ turnId: TURN, conversationId: CONV, units: unitsOf(ms) }) === null);
  ok('GUARD.enqueue.rejectsGarbage', rt.enqueue(null) === null && rt.enqueue('x') === null);
  ok('GUARD.abort.unknownConversationIsFalse', rt.abort('dm:nobody', 'x') === false);
  ok('GUARD.states.closedSet', RT.STATES.join(',') === 'queued,delivering,completed,cancelled,failed');
  ok('GUARD.queueBoundary', (() => {
    const c = fakeClock(); const r = makeRuntime(c).rt;
    let made = 0;
    /* 必须让队列**留在活动态**才测得到上界（单条 unit 会立刻完成并释放槽位）。
       因此每条队列都带显式延迟。 */
    const slow = unitsOf(buildTexts(['x']), [{ delayBefore: 5000 }]);
    for (let i = 0; i < RT.QUEUE_MAX + 5; i++) {
      const id = 'dm:f' + i;
      if (r.enqueue({ turnId: 'turn_' + i, conversationId: id, units: slow, onUnit: () => true })) made++;
    }
    return made <= RT.QUEUE_MAX && r.activeCount() <= RT.QUEUE_MAX;
  })());
  /* 分层：runtime 是纯的（无 DOM / 无存储 / 无网络），adapter 才碰 DB 与 DOM */
  const rtSrc = read('assets/js/delivery-runtime.js');
  ok('GUARD.layer.runtimeNoDomNoIo', !/\bdocument\b|\bindexedDB\b|\blocalStorage\b|\bfetch\s*\(/.test(
    rtSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')));
  ok('GUARD.layer.runtimeInjectedClock', /deps\.setTimeout/.test(rtSrc) && /deps\.now/.test(rtSrc));
  const commSrc = read('assets/js/communication.js');
  ok('GUARD.layer.adapterIsOnlyDeliverer', /async function _ibDeliverUnit\(queue,unit,index\)/.test(commSrc)
    && (sliceFunction(commSrc, 'async function _ibDeliverUnit(').match(/dbPut\('chatMessages'/g) || []).length === 1
    && !/dbPut|chatMessages/.test(stripComments(rtSrc)));
  ok('GUARD.layer.singleTypingAuthority', /function _ibTypingOn\(friendId,threadId,name,mode(?:,roleId)?\)/.test(commSrc)
    && (commSrc.match(/className='chat-typing';/g) || []).length === 2, (commSrc.match(/className='chat-typing';/g) || []).length);
  ok('GUARD.layer.conversationIdentityFromChatCore', /conversationIdOf\(friendId,threadId\)/.test(commSrc));
  ok('GUARD.interrupt.hookedOnUserSend', /_ibDeliveryAbort\(_targetFriend,_targetThread,'user_interrupt'\)/.test(commSrc));
  ok('GUARD.stop.hookedOnStopStreaming', /_ibDeliveryAbort\(activeFriendId,activeThreadId,'user_stop'\)/.test(commSrc));
  ok('GUARD.turnEndAtDeliveryCompletion', /_ibAppBroadcast\('turn',\{state:'end',friendId:queue\.friendId/.test(commSrc));
  ok('GUARD.render.threadAwareGuard', /function _ibConvIsActive\(friendId,threadId\)/.test(commSrc)
    && /String\(cur\|\|''\)!==String\(threadId\|\|''\)/.test(commSrc));
  ok('GUARD.html.moduleLoaded', (() => {
    const html = read('InternalBeyond.html');
    const a = html.indexOf('assets/js/delivery-sequence-core.js');
    const b = html.indexOf('assets/js/delivery-runtime.js');
    const c = html.indexOf('assets/js/chat-authority.js');
    return a > 0 && b > a && c > b;
  })());
  ok('GUARD.noGroupBehaviorAdded', !/group_|isGroupFriendId/.test(
    rtSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')));
}

/* ── ADAPTER · 真实 adapter 函数体（沙箱 + 假 DOM/假 store）───────────────
   这是"生产真的这么接"的证据：把 communication.js 里的 12 个交付函数**逐字**抽出来，
   在一个受控环境里执行，断言落库、渲染、typing DOM、会话/thread 守卫、cancel、
   以及"回到还在 typing 的会话时把 typing 重新画出来"。 */
function fakeDom() {
  function mk(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), className: '', id: '', innerHTML: '',
      textContent: '', style: {}, dataset: {}, children: [], parentNode: null,
      attributes: Object.create(null),
      setAttribute: function (name, value) { el.attributes[String(name)] = String(value); },
      getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(el.attributes, String(name)) ? el.attributes[String(name)] : null; },
      removeAttribute: function (name) { delete el.attributes[String(name)]; },
      appendChild: function (c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild: function (c) { el.children = el.children.filter(x => x !== c); c.parentNode = null; },
      remove: function () { if (el.parentNode) el.parentNode.removeChild(el); },
      querySelector: function (sel) { return el.querySelectorAll(sel)[0] || null; },
      querySelectorAll: function (sel) {
        const want = String(sel || '').replace(/^\./, '');
        const out = [];
        (function walk(n) {
          for (const c of n.children) {
            const cls = String(c.className || '').split(/\s+/);
            if (want && (cls.indexOf(want) >= 0 || c.id === want)) out.push(c);
            walk(c);
          }
        })(el);
        return out;
      }
    };
    Object.defineProperty(el, 'isConnected', { get: () => !!el.parentNode });
    /* querySelector('.typing-sec') 需要能按 class 找到子节点 —— 上面的递归已覆盖。 */
    return el;
  }
  const containers = { 'chat-messages': mk('div'), 'chat-full-messages': mk('div') };
  return { createElement: mk, getElementById: id => containers[id] || null, containers };
}

function adapterSandbox(active, thread) {
  const comm = read('assets/js/communication.js');
  const names = ['_ibConvId', '_ibConvScope', '_ibConvIsActive', '_ibTypingOff', '_ibTypingOn',
    '_ibTypingFinish', '_ibDeliveryRuntime', '_ibDeliverUnit', '_ibStartDelivery',
    '_ibDeliveryAbort', '_ibDeliveryPending', '_ibDeliveryTypingReassert'];
  const block = names.map(n => sliceNamed(comm, n)).join('\n');
  const dom = fakeDom();
  const clock = fakeClock();
  const runtimeEvents = [];
  const shared = RT.createDeliveryRuntime({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onEvent: e => runtimeEvents.push(e)
  });
  const store = new Map();
  const bubbles = [];
  const ui = [];
  const broadcasts = [];
  const api = new Function(
    'window', 'document', 'currentPage', 'activeFriendId', 'activeThreadId', 'esc',
    '_ibPrepareExpressionMessage', '_getActiveAiName', 'dbPut', 'appendChatBubble', '_showStreamingUI', '_ibAppBroadcast',
    'setTimeout', 'clearTimeout', 'Date',
    'var _ibTypingReg=Object.create(null);var _ibDeliveryRuntimeSingleton=null;\n'
    + block + '\n'
    + 'function __setActive(a,t){activeFriendId=a;activeThreadId=t;}\n'
    + 'return {api:{_ibConvId:_ibConvId,_ibConvScope:_ibConvScope,_ibConvIsActive:_ibConvIsActive,'
    + '_ibTypingOn:_ibTypingOn,_ibTypingOff:_ibTypingOff,_ibTypingFinish:_ibTypingFinish,'
    + '_ibStartDelivery:_ibStartDelivery,_ibDeliveryAbort:_ibDeliveryAbort,'
    + '_ibDeliveryPending:_ibDeliveryPending,_ibDeliveryTypingReassert:_ibDeliveryTypingReassert},'
    + 'reg:function(){return _ibTypingReg},setActive:__setActive};'
  )(
    { IBChatCore: { conversationIdOf: (f, t) => 'dm:' + f + (t ? ('|' + t) : ''), isGroupFriendId: f => String(f).indexOf('group_') === 0 },
      IBDeliveryRuntime: { createDeliveryRuntime: () => shared } },
    dom, 'chat', active, thread, s => String(s == null ? '' : s),
    message => message,
    () => 'AI',
    async (s, row) => { if (!store.has(row.id)) store.set(row.id, row); },
    (role, text, senderName, reasoning, msgId) => { bubbles.push({ role: role, text: text, msgId: msgId, at: clock.now() }); },
    show => ui.push({ at: clock.now(), show: !!show }),
    (ev, payload) => broadcasts.push({ ev: ev, payload: payload }),
    clock.setTimeout, clock.clearTimeout, Date
  );
  return { api: api.api, reg: api.reg, setActive: api.setActive, clock, store, bubbles, ui, broadcasts, dom, runtimeEvents };
}

async function flush(n) { for (let i = 0; i < (n || 12); i++) await Promise.resolve(); }
/* 假时钟 + 异步 adapter 的正确驱动方式：advance 只跑"当前已排队"的定时器，
   而 adapter 的落库/渲染是异步的（下一次定时器要等它完成才排队）。
   因此必须 advance → flush（让微任务跑完）→ 再 advance，如此往复。 */
async function settle(clock, ms, rounds) {
  for (let i = 0; i < (rounds || 6); i++) { clock.advance(ms); await flush(); }
}

async function desktopAdapter() {
  /* 1 · 真实交付：落库 + 渲染 + typing DOM 开合 */
  {
    const s = adapterSandbox('friend_1', null);
    const ms = buildMixed([{ text: 'A' }, { text: 'B' }, { text: 'C', voice: true }]);
    const h = s.api._ibStartDelivery({
      turnId: TURN, friendId: 'friend_1', threadId: null, senderName: 'Sui', thinkingText: '内省',
      units: unitsOf(ms, [null, { delayBefore: 200, typingDuration: 300 }, { delayBefore: 100, typingDuration: 100 }])
    });
    await flush();
    ok('ADAPTER.delivery.startsWithoutError', !!h);
    ok('ADAPTER.delivery.firstUnitPersisted', s.store.size === 1 && s.store.has(ms[0].id));
    ok('ADAPTER.delivery.firstUnitRendered', s.bubbles.length === 1 && s.bubbles[0].msgId === ms[0].id);
    ok('ADAPTER.delivery.rendersThroughAppendChatBubble', s.bubbles.every(b => b.role === 'ai' && !!b.msgId));
    ok('ADAPTER.delivery.containerAvailable', !!s.dom.containers['chat-full-messages'] && !!s.dom.containers['chat-messages']);
    ok('ADAPTER.delivery.conversationIdCanonical', s.api._ibConvId('friend_1', null) === 'dm:friend_1');
    ok('ADAPTER.delivery.scopeSingle', s.api._ibConvScope('friend_1') === 'single'
      && s.api._ibConvScope('group_9') === 'group');
    s.clock.advance(200);
    await flush();
    ok('ADAPTER.typing.shownAsChatTypingElement', (() => {
      const els = s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing');
      return els.length === 1 && els[0].dataset.ibTypingMode === 'typing' && String(els[0].innerHTML).indexOf('正在输入') >= 0;
    })(), JSON.stringify(s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing').map(e => e.innerHTML)));
    ok('ADAPTER.typing.announcesOneStateNotTimer', (() => {
      const el=s.dom.containers['chat-full-messages'].querySelector('chat-typing');
      return !!el&&el.getAttribute('role')==='status'&&el.getAttribute('aria-live')==='polite'&&el.getAttribute('aria-atomic')==='true';
    })());
    ok('ADAPTER.typing.singletonRegistered', Object.keys(s.reg()).length === 1);
    ok('ADAPTER.typing.deliveryNotYetPersisted', s.store.size === 1);
    s.clock.advance(300);
    await flush();
    ok('ADAPTER.typing.removedBeforeUnitAppears', s.bubbles.length === 2 && Object.keys(s.reg()).length === 0);
    await settle(s.clock, 1000, 4);
    ok('ADAPTER.delivery.allThreePersisted', s.store.size === 3, s.store.size);
    ok('ADAPTER.delivery.voiceRowCanonical', VoiceCore.hasPlayable(s.store.get(ms[2].id).voice));
    ok('ADAPTER.delivery.broadcastsPerUnit', s.broadcasts.filter(b => b.ev === 'message').length === 3);
    ok('ADAPTER.delivery.turnEndAtCompletion', s.broadcasts.filter(b => b.ev === 'turn' && b.payload.state === 'end').length === 1);
    ok('ADAPTER.delivery.stopButtonShownThenHidden', s.ui.some(u => u.show === true) && s.ui[s.ui.length - 1].show === false, JSON.stringify(s.ui));
    ok('ADAPTER.delivery.noTimersLeft', s.clock.pending() === 0);
  }
  /* 2 · 会话/thread 守卫：非活动会话只落库、不渲染（切到话题频道时不污染该视图） */
  {
    const s = adapterSandbox('friend_1', null);
    const ms = buildTexts(['A', 'B', 'C']);
    s.api._ibStartDelivery({
      turnId: TURN, friendId: 'friend_1', threadId: null, units: unitsOf(ms, [null, { delayBefore: 100, typingDuration: 50 }, { delayBefore: 100, typingDuration: 50 }])
    });
    s.setActive('friend_1', 'th_1');           /* 用户切到话题频道 */
    const bubblesBefore = s.bubbles.length;
    await settle(s.clock, 1000, 4);
    ok('ADAPTER.isolation.persistsWhileInactive', s.store.size === 3, s.store.size);
    ok('ADAPTER.isolation.doesNotRenderIntoOtherView', s.bubbles.length === bubblesBefore, JSON.stringify(s.bubbles));
    ok('ADAPTER.isolation.noTypingIntoOtherView', s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing').length === 0);
  }
  /* 3 · abort（user interrupt / stop）：保留已交付，清 typing，不再渲染 */
  {
    const s = adapterSandbox('friend_1', null);
    const ms = buildTexts(['A', 'B', 'C']);
    s.api._ibStartDelivery({
      turnId: TURN, friendId: 'friend_1', threadId: null, units: unitsOf(ms, [null, { delayBefore: 500, typingDuration: 200 }, { delayBefore: 500, typingDuration: 200 }])
    });
    await flush();
    s.clock.advance(500);
    await flush();
    ok('ADAPTER.abort.typingVisibleBeforeAbort', s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing').length === 1);
    ok('ADAPTER.abort.cancelled', s.api._ibDeliveryAbort('friend_1', null, 'user_interrupt') === true);
    await settle(s.clock, 5000, 3);
    ok('ADAPTER.abort.keepsDelivered', s.store.size === 1 && s.store.has(ms[0].id));
    ok('ADAPTER.abort.noFurtherRender', s.bubbles.length === 1, s.bubbles.length);
    ok('ADAPTER.abort.typingCleared', s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing').length === 0
      && Object.keys(s.reg()).length === 0);
    ok('ADAPTER.abort.idempotent', s.api._ibDeliveryAbort('friend_1', null, 'user_interrupt') === false);
  }
  /* 4 · 回到"仍在 typing"的会话：重渲染后 typing 重新画出来（不是第二套 UI） */
  {
    const s = adapterSandbox('friend_1', null);
    const ms = buildTexts(['A', 'B']);
    s.api._ibStartDelivery({
      turnId: TURN, friendId: 'friend_1', threadId: null, units: unitsOf(ms, [null, { delayBefore: 100, typingDuration: 900 }])
    });
    await flush();
    s.clock.advance(150);                       /* typing 阶段中 */
    await flush();
    ok('ADAPTER.reassert.pendingReportsTyping', (() => {
      const p = s.api._ibDeliveryPending('friend_1', null);
      return p && p.state === 'delivering' && p.typing === true;
    })());
    /* 模拟面板被整体重渲染：把容器清空 */
    s.dom.containers['chat-full-messages'].children = [];
    s.dom.containers['chat-messages'].children = [];
    ok('ADAPTER.reassert.recreatesTyping', s.api._ibDeliveryTypingReassert() === true
      && s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing').length === 1);
    await settle(s.clock, 2000, 3);
    ok('ADAPTER.reassert.cleanedAfterDelivery', s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing').length === 0
      && s.store.size === 2);
  }
  /* 5 · 单条 sequence 不产生额外延迟与 typing（legacy 手感） */
  {
    const s = adapterSandbox('friend_1', null);
    const ms = buildTexts(['只有一条']);
    s.api._ibStartDelivery({ turnId: TURN, friendId: 'friend_1', threadId: null, units: unitsOf(ms) });
    await flush();
    ok('ADAPTER.single.immediatePersistAndRender', s.store.size === 1 && s.bubbles.length === 1 && s.bubbles[0].at === 0);
    ok('ADAPTER.single.noTyping', s.dom.containers['chat-full-messages'].querySelectorAll('chat-typing').length === 0);
    ok('ADAPTER.single.noStopButtonFlicker', s.ui.length === 0, JSON.stringify(s.ui));
  }
}

async function main() {
  console.log('== Internal Beyond · P23 Phase 2B · Delivery Runtime 测试 ==');
  deliveryOrder();
  timing();
  cancellation();
  isolation();
  voiceDelivery();
  isolationFromConsumers();
  await deliveredWithdrawAndLegacy();
  traceSafety();
  await desktopAdapter();
  contractGuards();
  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main();
