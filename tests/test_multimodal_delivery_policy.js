'use strict';

/* Internal Beyond · P23 Phase 2D · Multimodal Delivery Policy 测试
   （static 组：零依赖、零网络、零浏览器、零真实 sleep、**零真实 TTS**）
   运行：node tests/test_multimodal_delivery_policy.js

   Phase 2D 只回答一件事：**这个 unit 是 text 还是 voice**（image 本阶段 DEFERRED）。
   因此本测试分两层：
     ① 纯策略层（真实模块）：决策表、能力/偏好/意图分离、降级、预算、确定性、纯净性、
        秘密消毒、image 延期契约；
     ② 生产 adapter（**真实函数体沙箱**）：delivery-time 物化、cancel/interrupt 零 TTS、
        物化失败确定性降级、无 provider roulette、无重复消息、与 2A/2B 的顺序与身份兼容。
   TTS 一律用注入的 fake adapter（window.__ibVoiceMaterializer），绝不调用真实 provider。

   覆盖：A default text · B configured-but-no-preference · C preferVoice+capability ·
   D preferVoice without capability · E explicit intent · F voice content preserved ·
   G transcript authority · H text→voice→text · I order · J runtime compatibility ·
   K cancel before voice → no TTS · L interrupt before voice → no TTS · M voice failure ·
   N no provider roulette · O no speechSynthesis · P no duplicate text+voice ·
   Q secret sanitization · R deterministic 50 runs · S no Math.random · T no DOM ·
   U no storage · V no network · W planner lossless · X legacy waifu off ·
   Y streaming unchanged · Z image deferred contract */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Policy = require(path.join(ROOT, 'assets', 'js', 'multimodal-delivery-policy.js'));
const Planner = require(path.join(ROOT, 'assets', 'js', 'delivery-planner.js'));
const SeqCore = require(path.join(ROOT, 'assets', 'js', 'delivery-sequence-core.js'));
const RT = require(path.join(ROOT, 'assets', 'js', 'delivery-runtime.js'));
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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
function sliceNamed(src, name) {
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  if (at < 0) throw new Error('找不到 ' + name);
  const isAsync = src.slice(Math.max(0, at - 6), at) === 'async ';
  return (isAsync ? 'async ' : '') + sliceFunction(src.slice(at), sig);
}
function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

const TURN = SeqCore.turnIdFor('msg_1700000000300_u');
const FID = 'friend_1';
const CONV = 'dm:friend_1';
const TS = 1700000000300;
const AUDIO = 'data:audio/wav;base64,' + Buffer.from('RIFF0000WAVEfmt-2d').toString('base64');

/* 能力视图（**消毒后**的形状：只有 available 与展示用元数据，绝无凭据）。 */
function capability(isAvailable, over) {
  return Object.assign({
    voice: {
      available: isAvailable === true, reason: isAvailable === true ? '' : 'voice-disabled',
      source: 'voicebox', provider: 'voicebox', engine: 'qwen', voiceId: 'p1', voiceType: 'builtin', model: ''
    }
  }, over || {});
}
function unitsOf(kinds, contents) {
  return kinds.map((k, i) => ({ kind: k, content: (contents || [])[i] || ('U' + i) }));
}
function resolve(kinds, contents, ctx) {
  return Policy.resolve(unitsOf(kinds, contents), ctx || {});
}

/* ── A–I · 决策表 ─────────────────────────────────────────────────── */
function decisionTable() {
  const segs = ['不是，你等等。', '所以你不是普通用户？', '那事情就有意思了。'];
  /* A · 默认 text（没有任何意图/偏好/提示） */
  {
    const r = resolve(['text', 'text', 'text'], segs, { capability: capability(true) });
    ok('A.default.allText', r.units.every(u => u.kind === 'text'), JSON.stringify(r.units));
    ok('A.default.reason', r.decisions.every(d => d.reason === Policy.REASONS.DEFAULT_TEXT));
    ok('A.default.noVoiceRequested', r.stats.voiceRequested === 0 && r.stats.voiceResolved === 0);
    ok('A.default.contentLossless', norm(r.units.map(u => u.content).join('')) === norm(segs.join('')));
  }
  /* B · voice **配置存在**但没有偏好/意图 → 仍然 text（capability ≠ preference） */
  {
    const r = resolve(['text', 'text'], segs, { capability: capability(true) });
    ok('B.configuredButNoPreference.stillText', r.units.every(u => u.kind === 'text') && r.stats.voiceResolved === 0);
    ok('B.configuredButNoPreference.reasonDefault', r.decisions.every(d => d.reason === Policy.REASONS.DEFAULT_TEXT));
  }
  /* C · preferVoice + capability（生产者标记了 voice 候选）→ voice */
  {
    const r = resolve(['text', 'voice', 'text'], segs, { capability: capability(true), preference: { voice: true } });
    ok('C.preferWithCapability.mixed', r.units.map(u => u.kind).join(',') === 'text,voice,text', JSON.stringify(r.units.map(u => u.kind)));
    ok('C.preferWithCapability.reason', r.decisions[1].reason === Policy.REASONS.VOICE_ENABLED);
    ok('C.preferWithCapability.notUpgradingPlainText', r.decisions[0].resolved === 'text' && r.decisions[2].resolved === 'text');
    ok('C.preferWithCapability.contentKept', r.units[1].content === segs[1]);
    const r2 = resolve(['text', 'text'], segs, { capability: capability(true), preference: { voice: true } });
    ok('C.preferSoftOnly.noUpgrade', r2.units.every(u => u.kind === 'text') && r2.stats.upgraded === 0);
  }
  /* D · preferVoice 但没有 capability → 确定性降级为同内容 text */
  {
    const r = resolve(['text', 'voice', 'text'], segs, { capability: capability(false), preference: { voice: true } });
    ok('D.noCapability.downgraded', r.units.map(u => u.kind).join(',') === 'text,text,text');
    ok('D.noCapability.reason', r.decisions[1].reason === Policy.REASONS.VOICE_UNAVAILABLE, JSON.stringify(r.decisions[1]));
    ok('D.noCapability.contentIdentical', r.units[1].content === segs[1]);
    ok('D.noCapability.stats', r.stats.voiceRequested === 1 && r.stats.voiceResolved === 0 && r.stats.downgraded === 1);
  }
  /* E · force / explicit intent：text → voice（唯一允许升级的路径）＋预算与 policy off */
  {
    const r = resolve(['text', 'text'], segs, { capability: capability(true), intent: { voice: true } });
    ok('E.intent.upgradesText', r.units.every(u => u.kind === 'voice'), JSON.stringify(r.units.map(u => u.kind)));
    ok('E.intent.reason', r.decisions.every(d => d.reason === Policy.REASONS.VOICE_ENABLED));
    ok('E.intent.upgradedStat', r.stats.upgraded === 2);
    const rNo = resolve(['text', 'text'], segs, { capability: capability(false), intent: { voice: true } });
    ok('E.intent.unmetIsDeterministic', rNo.units.every(u => u.kind === 'text') && rNo.decisions.every(d => d.reason === Policy.REASONS.VOICE_INTENT_UNMET));
    const many = resolve(['text', 'text', 'text', 'text', 'text'], ['1', '2', '3', '4', '5'], { capability: capability(true), intent: { voice: true } });
    ok('E.intent.budgetBounded', many.stats.voiceResolved === Policy.MAX_VOICE_UNITS_PER_TURN
      && many.decisions.slice(Policy.MAX_VOICE_UNITS_PER_TURN).every(d => d.reason === Policy.REASONS.VOICE_BUDGET_EXCEEDED),
      JSON.stringify({ resolved: many.stats.voiceResolved, reasons: many.decisions.map(d => d.reason) }));
    const off = resolve(['voice'], ['x'], { capability: capability(true), intent: { voice: true }, policy: { voice: 'off' } });
    ok('E.policyOff.wins', off.units[0].kind === 'text' && off.decisions[0].reason === Policy.REASONS.VOICE_DISABLED_BY_POLICY);
  }
  /* F/G · voice 的内容与文字稿权威 */
  {
    const text = '你今天怎么这么晚还没睡？';
    const r = resolve(['voice'], [text], { capability: capability(true) });
    ok('F.voice.contentPreserved', r.units[0].content === text);
    ok('F.voice.kindVoice', r.units[0].kind === 'voice');
    const w = SeqCore.buildMessages({ turnId: TURN, units: [{ kind: 'voice', text: text, dataUrl: AUDIO, mime: 'audio/wav' }] },
      { friendId: FID, timestamp: TS });
    ok('G.transcript.authorityIsContent', w.length === 1 && w[0].content === text && w[0].voice.transcript === text);
    ok('G.transcript.hashMatchesContent', VoiceCore.isStale(w[0]) === false && VoiceCore.isAiVoiceMessage(w[0]) === true);
  }
  /* H/I · text → voice → text 的形状、顺序、条数 */
  {
    const r = resolve(['text', 'voice', 'text'], segs, { capability: capability(true) });
    ok('H.mixedShape', r.units.map(u => u.kind).join(',') === 'text,voice,text');
    ok('I.orderKept', r.units.map(u => u.content).join('|') === segs.join('|'));
    ok('I.countKept', r.units.length === 3 && r.stats.outputUnits === 3);
    ok('I.imageDeferredZero', r.stats.imageDeferred === 0);
  }
}

/* ── Q/R · 秘密消毒与确定性 ─────────────────────────────────────────── */
function secretsAndDeterminism() {
  {
    const dirty = { voice: { available: true, voiceId: 'p1', source: 'voicebox', apiKey: 'sk-should-never-appear-0001', endpoint: 'http://x/y' } };
    const view = Policy.sanitizeCapability(dirty);
    ok('Q.capability.rejectsDirtyBlock', view.available === false, JSON.stringify(view));
    ok('Q.capability.noSecretKeys', !('apiKey' in view) && !('endpoint' in view) && !('voiceData' in view));
    const clean = Policy.sanitizeCapability(capability(true).voice);
    ok('Q.capability.cleanView', clean.available === true && clean.source === 'voicebox' && clean.voiceId === 'p1');
    ok('Q.capability.keyClosedSet', Object.keys(clean).sort().join(',') === 'available,engine,model,provider,reason,source,voiceId,voiceType');
    Policy.resetTrace();
    const dirtyRecord = { enabled: true, voiceId: 'p1', apiKey: 'sk-abcdefghijklmnop0002' };
    const safe = Policy.sanitizeCapability(dirtyRecord);
    ok('Q.capability.dirtyAgentRecordFailsClosed', safe.available === false);
    const r = Policy.resolve(unitsOf(['voice', 'text'], ['A', 'B']), { capability: { voice: safe }, preference: { voice: true } });
    Policy.note(r.decisions, { turnId: TURN, conversationId: CONV });
    const blob = JSON.stringify({ units: r.units, decisions: r.decisions, trace: Policy.trace(20) });
    ok('Q.output.noSecretShape', !/sk-[A-Za-z0-9_\-]{8,}|Bearer\s|apiKey|token|endpoint/i.test(blob), blob.slice(0, 200));
    ok('Q.trace.noContent', JSON.stringify(Policy.trace(20)).indexOf('"A"') < 0, JSON.stringify(Policy.trace(3)));
    const blocked = SeqCore.buildMessages({ turnId: TURN, units: [{ kind: 'text', text: 'sk-should-never-appear-0003' }] }, { friendId: FID, timestamp: TS });
    ok('Q.sequence.rejectsSecretShape', blocked.length === 0);
    const m = SeqCore.buildMessages({ turnId: TURN, units: [{ kind: 'text', text: 'ok' }] }, { friendId: FID, timestamp: TS, model: 'p', configId: FID })[0];
    ok('Q.metadata.noCredentialFields', !/apikey|token|secret|authorization/i.test(JSON.stringify(m.metadata)));
  }
  {
    const ctx = { capability: capability(true), preference: { voice: true }, intent: { voice: false }, hints: { preferVoice: false } };
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(JSON.stringify(resolve(['text', 'voice', 'text'], ['a', 'b', 'c'], ctx)));
    ok('R.deterministic.identical50', seen.size === 1, seen.size);
  }
}

/* ── S/T/U/V · 纯模块守卫 ───────────────────────────────────────────── */
function policyPurity() {
  const src = stripComments(read('assets/js/multimodal-delivery-policy.js'));
  ok('S.noRandom', !/Math\.random/.test(src));
  ok('S.noClock', !/Date\.now|performance\.now|setTimeout|setInterval/.test(src));
  ok('T.noDom', !/\bdocument\b|\bwindow\b|innerHTML|querySelector|classList/.test(src));
  ok('U.noStorage', !/\blocalStorage\b|\bindexedDB\b|\bIndexedDB\b|\bdbPut\b|\bdbGet\b/.test(src));
  ok('V.noNetwork', !/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|speechSynthesis/.test(src));
  ok('V.noTtsCall', !/\/api\/tts|voicebox|openai|mimo|edge/i.test(src));
}

/* ── W · planner lossless（policy 不改写任何字）──────────────────────── */
function plannerLossless() {
  const text = '不是，你等等。所以你不是普通用户？那事情就有意思了。';
  const plan = Planner.planTurn(text);
  const r = Policy.resolve(plan.units.map(u => ({ kind: u.kind, content: u.content })), { capability: capability(true), intent: { voice: true } });
  ok('W.plannerLossless', norm(r.units.map(u => u.content).join('')) === norm(text));
  ok('W.plannerUnitCountKept', r.units.length === plan.units.length);
  ok('W.policyDoesNotRewrite', r.units.every((u, i) => u.content === plan.units[i].content));
  ok('W.plannerSegmentsIntact', norm(plan.segments.join('')) === norm(text));
}

/* ── Z · image deferred contract ─────────────────────────────────────── */
function imageDeferred() {
  ok('Z.contract.registered', Policy.IMAGE_CAPABILITY.available === false
    && Policy.IMAGE_CAPABILITY.reason === Policy.REASONS.IMAGE_DEFERRED
    && Policy.IMAGE_CAPABILITY.deferredTo === 'P23.x');
  const r = resolve(['text', 'image', 'text'], ['看', '图', '好'], { capability: capability(true), intent: { voice: true } });
  ok('Z.image.downgradedContentKept', r.units.map(u => u.kind).join(',') === 'voice,text,voice', JSON.stringify(r.units.map(u => u.kind)));
  ok('Z.image.reason', r.decisions[1].reason === Policy.REASONS.IMAGE_DEFERRED && r.decisions[1].resolved === 'text');
  ok('Z.image.contentIdentical', r.units[1].content === '图');
  ok('Z.image.neverEmitsImageUnit', r.units.every(u => u.kind === 'text' || u.kind === 'voice'));
  const empty = Policy.resolve([{ kind: 'image', content: '' }], { capability: capability(true) });
  ok('Z.image.emptyUnitDropped', empty.units.length === 0 && empty.stats.dropped === 1, JSON.stringify(empty.stats));
  const emptyText = Policy.resolve([{ kind: 'text', content: '   ' }], {});
  ok('Z.emptyTextUnitDropped', emptyText.units.length === 0 && emptyText.stats.dropped === 1);
  const src = stripComments(read('assets/js/multimodal-delivery-policy.js'));
  ok('Z.noImageSchema', !/sequenceImage|imageMessage|imageUnit|imageContract/.test(src));
  ok('Z.noSecondSerializer', !/IBImageMessage|image-message-core/.test(src));
  ok('Z.sequenceCoreStillReservesImage', SeqCore.RESERVED_KINDS.indexOf('image') >= 0
    && SeqCore.SUPPORTED_KINDS.indexOf('image') < 0);
}

/* ══ ADAPTER · 真实生产函数体沙箱（delivery-time 物化 / cancel / 降级 / 顺序）═══
   TTS 用注入的 fake adapter；时钟用假时钟；DOM/db 全部是桩：绝不调用真实 provider 或真实存储。 */
function fakeClock() {
  let now = 0, seq = 0, timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const h = { id: ++seq, at: now + Math.max(0, Number(ms) || 0), fn }; timers.push(h); return h; },
    clearTimeout: h => { timers = timers.filter(t => t !== h); },
    advance: ms => {
      const target = now + Math.max(0, Number(ms) || 0);
      for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const t = timers[0]; if (!t || t.at > target) break; timers.shift(); now = t.at; t.fn(); }
      now = target;
    },
    pending: () => timers.length
  };
}
async function flush(n) { for (let i = 0; i < (n || 14); i++) await Promise.resolve(); }
async function settle(clock, ms, rounds) {
  for (let i = 0; i < (rounds || 6); i++) { clock.advance(ms); await flush(); }
}
function fakeDom() {
  function mk(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), className: '', id: '', innerHTML: '', textContent: '',
      style: {}, dataset: {}, children: [], parentNode: null,
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
    return el;
  }
  const containers = { 'chat-messages': mk('div'), 'chat-full-messages': mk('div') };
  return { createElement: mk, getElementById: id => containers[id] || null, containers };
}

function adapterSandbox(opts) {
  const o = opts || {};
  const comm = read('assets/js/communication.js');
  const names = ['_ibDeliveryCore', '_ibConvId', '_ibConvScope', '_ibConvIsActive', '_ibTypingOff', '_ibTypingOn',
    '_ibTypingFinish', '_ibDeliveryRuntime', '_ibDeliverUnit', '_ibStartDelivery', '_ibDeliveryAbort',
    '_ibDeliveryPending', '_ibDeliveryTypingReassert', '_ibMmPolicy', '_ibVoiceCapability', '_ibMmIntent',
    '_ibMmResolve', '_ibVoiceMaterializerSeam', '_ibMaterializeVoiceUnit', '_ibBuildUnitAt'];
  const block = names.map(n => sliceNamed(comm, n)).join('\n');
  const dom = fakeDom();
  const clock = fakeClock();
  const store = new Map();
  const bubbles = [];
  const broadcasts = [];
  const tts = { calls: [], mode: o.materializerMode || 'ok', sources: [] };
  const fakeMaterializer = async function (req) {
    tts.calls.push({ content: String((req && req.content) || '') });
    if (tts.mode === 'fail') return { ok: false, reason: 'tts-failed' };
    if (tts.mode === 'throw') throw new Error('tts-boom');
    return {
      ok: true, audio: {
        dataUrl: AUDIO, audioUrl: '/tts/mock_2d.wav', mime: 'audio/wav', duration: 2,
        provenance: { source: 'voicebox', provider: 'voicebox', engine: 'qwen', voiceId: 'p1', voiceType: 'builtin' }
      }
    };
  };
  const runtime = RT.createDeliveryRuntime({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  let activeFriend = o.activeFriend || FID, activeThread = o.activeThread || null;
  const win = {
    IBChatCore: { conversationIdOf: (f, t) => 'dm:' + f + (t ? ('|' + t) : ''), isGroupFriendId: f => String(f).indexOf('group_') === 0 },
    IBDeliveryRuntime: { createDeliveryRuntime: () => runtime },
    IBDeliverySequence: SeqCore,
    IBMultimodalPolicy: Policy,
    IBVoiceMessage: VoiceCore,
    __ibVoiceMaterializer: fakeMaterializer
  };
  const api = new Function(
    'window', 'document', 'currentPage', 'activeFriendId', 'activeThreadId', 'esc',
    '_ibPrepareExpressionMessage', '_getActiveAiName', 'dbPut', 'appendChatBubble', '_showStreamingUI', '_ibAppBroadcast', 'setTimeout', 'clearTimeout',
    'var _ibTypingReg=Object.create(null);var _ibDeliveryRuntimeSingleton=null;\n' + block + '\n'
    + 'function __setActive(f,t){activeFriendId=f;activeThreadId=t;}\n'
    + 'return {api:{_ibConvId:_ibConvId,_ibConvIsActive:_ibConvIsActive,_ibMmResolve:_ibMmResolve,'
    + '_ibVoiceCapability:_ibVoiceCapability,_ibMmIntent:_ibMmIntent,_ibStartDelivery:_ibStartDelivery,'
    + '_ibDeliveryAbort:_ibDeliveryAbort,_ibDeliveryPending:_ibDeliveryPending,'
    + '_ibMaterializeVoiceUnit:_ibMaterializeVoiceUnit,_ibBuildUnitAt:_ibBuildUnitAt},setActive:__setActive};'
  )(
    win,
    dom, 'chat', activeFriend, activeThread, s => String(s == null ? '' : s), message => message, () => 'AI',
    async (s, row) => { if (!store.has(row.id)) store.set(row.id, row); },
    (role, text, senderName, reasoning, msgId, images, files, wsResults, voice) => { bubbles.push({ role: role, text: text, msgId: msgId, voice: voice || null, at: clock.now() }); },
    () => { },
    (ev, payload) => broadcasts.push({ ev: ev, payload: payload }),
    clock.setTimeout, clock.clearTimeout
  );
  return {
    api: api.api, setActive: api.setActive, clock, store, bubbles, broadcasts, dom, tts, runtime,
    getActive: () => ({ friend: activeFriend, thread: activeThread }),
    win: win
  };
}

/* ── J · policy → adapter → 2A → 2B 的完整链路（意图升级为 voice）────────── */
async function adapterChain() {
  const voiceCfg = { voice: { enabled: true, source: 'voicebox', provider: 'voicebox', voiceId: 'p1', voiceType: 'builtin' } };
  const s = adapterSandbox({});
  Policy.resetTrace();
  s.win.__ibMultimodalIntent = { voice: true };
  const segs = ['A 句。', 'B 句。', 'C 句。'];
  const mm = s.api._ibMmResolve(segs, voiceCfg, { turnId: TURN, conversationId: CONV });
  ok('J.chain.intentUpgradesAll', !!mm && mm.units.every(u => u.kind === 'voice'), JSON.stringify(mm && mm.units));
  ok('J.chain.statsRecorded', !!mm && mm.stats.voiceResolved === 3 && mm.stats.upgraded === 3);
  const h = s.api._ibStartDelivery({
    turnId: TURN, friendId: FID, threadId: null, cfg: voiceCfg, senderName: 'Sui', thinkingText: '内省',
    timestamp: TS, lazyBuild: true, model: 'p', configId: FID, showThinking: true,
    units: mm.units.map((u, i) => ({ kind: u.kind, content: u.content, delivery: (i === 0 ? null : { delayBefore: 50, typingDuration: 20 }) }))
  });
  ok('J.chain.enqueued', !!h);
  await flush();
  ok('J.chain.firstDeliveredThroughLazyBuild', s.store.size === 1, s.store.size + ' trace=' + JSON.stringify(s.runtime.trace(6)));
  await settle(s.clock, 500, 4);
  ok('J.chain.allDelivered', s.store.size === 3, s.store.size + ' trace=' + JSON.stringify(s.runtime.trace(8)));
  const rows = SeqCore.orderMessages([...s.store.values()]);
  ok('J.chain.sequenceIndexOrder', rows.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2', JSON.stringify(rows.map(m => m.metadata.sequenceIndex)));
  ok('J.chain.idsAscending', rows.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map(m => m.metadata.sequenceIndex).join(',') === '0,1,2');
  ok('J.chain.turnIdentity', rows.every(m => m.metadata.turnId === TURN));
  ok('J.chain.allAreVoiceMessages', rows.every(m => !!m.voice && VoiceCore.hasPlayable(m.voice)), JSON.stringify(rows.map(m => !!m.voice)));
  ok('J.chain.transcriptEqualsContent', rows.every(m => m.voice.transcript === m.content));
  ok('J.chain.sequenceTotalOmittedInLazyBuild', rows.every(m => m.metadata.sequenceTotal === undefined));
  ok('J.chain.sharedTimestamp', new Set(rows.map(m => m.timestamp)).size === 1);
  ok('J.chain.canonicalShape', rows.every(m => ChatCore.validateMessage(m).ok));
  ok('J.chain.renderedAsVoiceBubbles', s.bubbles.filter(b => b.voice).length === 3, JSON.stringify(s.bubbles.map(b => !!b.voice)));
  ok('J.chain.runtimeReleased', s.runtime.stateOf(CONV) === 'idle' && s.clock.pending() === 0);
}

/* ── K/L · cancel 与 user interrupt 都不得产生 TTS 成本 ────────────────── */
async function adapterCancellation() {
  const voiceCfg = { voice: { enabled: true, source: 'voicebox', provider: 'voicebox', voiceId: 'p1' } };
  /* K · 在 voice unit 交付前 Stop ⇒ 零 TTS 请求 */
  {
    const s = adapterSandbox({});
    s.api._ibStartDelivery({
      turnId: TURN, friendId: FID, threadId: null, cfg: voiceCfg, timestamp: TS, lazyBuild: true,
      units: [
        { kind: 'text', content: 'A', delivery: null },
        { kind: 'voice', content: 'B', delivery: { delayBefore: 5000, typingDuration: 100 } },
        { kind: 'text', content: 'C', delivery: { delayBefore: 5000, typingDuration: 100 } }
      ]
    });
    await flush();
    ok('K.cancel.firstDeliveredAsText', s.store.size === 1 && ![...s.store.values()][0].voice);
    s.api._ibDeliveryAbort(FID, null, 'user_stop');
    await settle(s.clock, 6000, 3);
    ok('K.cancel.noTtsCallAtAll', s.tts.calls.length === 0, JSON.stringify(s.tts.calls));
    ok('K.cancel.voiceUnitNeverPersisted', s.store.size === 1, s.store.size);
    ok('K.cancel.noVoiceRows', [...s.store.values()].every(m => !m.voice));
    ok('K.cancel.timersCleared', s.clock.pending() === 0);
  }
  /* L · 用户插话取消剩余 ⇒ 零 TTS；已交付的保留 */
  {
    const s = adapterSandbox({});
    s.api._ibStartDelivery({
      turnId: TURN, friendId: FID, threadId: null, cfg: voiceCfg, timestamp: TS, lazyBuild: true,
      units: [
        { kind: 'text', content: 'A', delivery: null },
        { kind: 'voice', content: 'B', delivery: { delayBefore: 4000, typingDuration: 100 } }
      ]
    });
    await flush();
    s.api._ibDeliveryAbort(FID, null, 'user_interrupt');
    await settle(s.clock, 5000, 3);
    ok('L.interrupt.noTtsCall', s.tts.calls.length === 0);
    ok('L.interrupt.deliveredKept', s.store.size === 1 && [...s.store.values()][0].content === 'A');
  }
}

/* ── M · 物化失败 ⇒ 同内容 text 降级，剩余继续，trace 留原因 ─────────── */
async function adapterFailure() {
  const voiceCfg = { voice: { enabled: true, source: 'voicebox', provider: 'voicebox', voiceId: 'p1' } };
  Policy.resetTrace();
  const s = adapterSandbox({ materializerMode: 'fail' });
  s.api._ibStartDelivery({
    turnId: TURN, friendId: FID, threadId: null, cfg: voiceCfg, timestamp: TS, lazyBuild: true,
    units: [
      { kind: 'text', content: 'A', delivery: null },
      { kind: 'voice', content: 'B', delivery: { delayBefore: 50, typingDuration: 20 } },
      { kind: 'text', content: 'C', delivery: { delayBefore: 50, typingDuration: 20 } }
    ]
  });
  await settle(s.clock, 500, 4);
  const rows = SeqCore.orderMessages([...s.store.values()]);
  ok('M.failure.allUnitsStillDelivered', rows.length === 3, rows.length);
  ok('M.failure.voiceBecameText', rows.map(m => !!m.voice).join(',') === 'false,false,false');
  ok('M.failure.contentIdentical', rows.map(m => m.content).join('|') === 'A|B|C');
  ok('M.failure.traceRecordsDowngrade', Policy.trace(20).some(e => e.reason === 'tts-failed' && e.resolved === 'text'), JSON.stringify(Policy.trace(6)));
  ok('M.failure.orderKept', rows.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2');
  const s2 = adapterSandbox({ materializerMode: 'throw' });
  s2.api._ibStartDelivery({
    turnId: TURN, friendId: FID, threadId: null, cfg: voiceCfg, timestamp: TS, lazyBuild: true,
    units: [{ kind: 'voice', content: 'X', delivery: null }]
  });
  await settle(s2.clock, 200, 3);
  ok('M.failure.throwingMaterializerDowngrades', s2.store.size === 1 && ![...s2.store.values()][0].voice);
}

/* ── N/O/P · 无 provider roulette、无 speechSynthesis、无重复消息 ─────── */
async function adapterNoRoulette() {
  const voiceCfg = { voice: { enabled: true, source: 'voicebox', provider: 'voicebox', voiceId: 'p1' } };
  const s = adapterSandbox({});
  s.api._ibStartDelivery({
    turnId: TURN, friendId: FID, threadId: null, cfg: voiceCfg, timestamp: TS, lazyBuild: true,
    units: [
      { kind: 'voice', content: 'A', delivery: null },
      { kind: 'voice', content: 'B', delivery: { delayBefore: 50, typingDuration: 20 } }
    ]
  });
  await settle(s.clock, 500, 4);
  ok('N.roulette.oneCallPerUnit', s.tts.calls.length === 2, JSON.stringify(s.tts.calls.map(c => c.content)));
  const comm = read('assets/js/communication.js');
  const block = ['_ibMaterializeVoiceUnit', '_ibBuildUnitAt'].map(n => sliceNamed(comm, n)).join('\n');
  ok('N.roulette.singleTtsEndpoint', (block.match(/\/api\/tts/g) || []).length === 1);
  ok('N.roulette.noSecondProviderPath', !/edge|mimo|openai|speechSynthesis/i.test(block));
  ok('N.roulette.noRetryOfFailedUnit', s.tts.calls.length === 2);
  ok('O.noSpeechSynthesisIn2dPath', !/speechSynthesis/.test(block));
  const s2 = adapterSandbox({});
  s2.api._ibStartDelivery({
    turnId: TURN, friendId: FID, threadId: null, cfg: voiceCfg, timestamp: TS, lazyBuild: true,
    units: [
      { kind: 'text', content: 'A', delivery: null },
      { kind: 'voice', content: 'B', delivery: { delayBefore: 50, typingDuration: 20 } }
    ]
  });
  await settle(s2.clock, 500, 4);
  const rows = [...s2.store.values()];
  ok('P.noDup.oneRowPerUnit', rows.length === 2, rows.length);
  ok('P.noDup.noContentTwin', new Set(rows.map(m => m.content)).size === rows.length, JSON.stringify(rows.map(m => m.content)));
  ok('P.noDup.voiceRowIsVoice', !!rows.find(m => m.content === 'B' && m.voice));
  ok('P.noDup.textRowStayedText', !!rows.find(m => m.content === 'A' && !m.voice));
  ok('P.noDup.renderOncePerUnit', s2.bubbles.length === 2, s2.bubbles.length);
}

/* ── X/Y · legacy（waifu off）与 streaming 未受影响 ─────────────────── */
function legacyAndStreaming() {
  const comm = read('assets/js/communication.js');
  /* X · waifu 关闭时仍是单条：policy 只在多段分支里被调用 */
  ok('X.legacy.policyOnlyInMultiBranch', /if\(_mmHasVoice&&_mmResult&&_mmResult\.units\.length\)\{/.test(comm)
    && /_mmResult=\(_waifuSegs&&_waifuSegs\.length\)\?_ibMmResolve\(/.test(comm));
  ok('X.legacy.singlePathUnchanged', /await dbPut\('chatMessages',aiMsg\);/.test(comm)
    && /_sendResult=\{ok:true,replyText:replyText,messageId:aiMsg\.id,userMessageId:userMsg\.id\}/.test(comm));
  ok('X.legacy.noPolicyOnUserMessage', !/_ibMmResolve\(\[text\]/.test(comm) && !/_ibMmResolve\(\[String\(text/.test(comm));
  /* Y · streaming 不接 policy（2C 已冻结：流式仍单条） */
  ok('Y.streaming.noPolicyInStreamPath', !/_mmHasVoice[\s\S]{0,400}?streamingOk/.test(comm));
  ok('Y.streaming.planModeKept', /if \(opts\.streaming\) return \{ mode: 'stream', messages: \[\], segments: \[\] \};/.test(comm));
  ok('Y.streaming.singleMessagePathKept', /const _waifuPlan=\(cfg\.waifu===true&&/.test(comm));
}

async function main() {
  console.log('== Internal Beyond · P23 Phase 2D · Multimodal Delivery Policy 测试 ==');
  decisionTable();
  secretsAndDeterminism();
  policyPurity();
  plannerLossless();
  imageDeferred();
  await adapterChain();
  await adapterCancellation();
  await adapterFailure();
  await adapterNoRoulette();
  legacyAndStreaming();
  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main();
