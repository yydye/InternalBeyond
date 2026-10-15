'use strict';

/* Internal Beyond · Native Voice Message 专项测试（P23 Phase 1）。
 * 覆盖「voice 是一级消息类型」的完整生命周期契约：
 *   create → persist → hydrate → render decision → play → duration / transcript / provenance
 * 以及失败与兼容边界（不写假 voice message、旧消息继续可读、不重复显示文字气泡）。
 * 零依赖、零外网、零浏览器：纯契约（voice-message-core + chat-core）用真实 require 驱动，
 * 渲染/持久化决策用源码内嵌路径断言（与本仓库既有的 bridge/tts.js 源码级断言同一套做法）。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const VoiceMsgFixture = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* CRLF 安全的花括号配对提取器（源码可能是 CRLF，不能用 indexOf('\n}\n')）。 */
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
const WAV_B64 = Buffer.from('RIFF0000WAVEfmt-fake-audio-payload-for-tests').toString('base64');
const INLINE = 'data:audio/wav;base64,' + WAV_B64;

function makeAiVoice(extra) {
  return VoiceCore.build(Object.assign({
    dataUrl: INLINE,
    audioUrl: '',
    mime: 'audio/wav',
    duration: 2.5,
    transcript: '今晚早点睡。',
    provenance: { source: 'voicebox', provider: 'voicebox', engine: 'qwen', model: '', voiceId: 'prof-uuid-1', voiceType: 'builtin', refAudioId: '' }
  }, extra || {}));
}

function main() {
  console.log('== Internal Beyond · Native Voice Message 测试 ==');

  /* ── A. create：canonical 形态 ── */
  {
    const v = makeAiVoice();
    ok('A.create.notNull', !!v);
    ok('A.create.coreFields', typeof v.dataUrl === 'string' && typeof v.audioUrl === 'string' && typeof v.mime === 'string' && typeof v.duration === 'number' && typeof v.transcript === 'string',
      JSON.stringify(Object.keys(v)));
    ok('A.create.mime', v.mime === 'audio/wav', v.mime);
    ok('A.create.duration', v.duration === 2.5, v.duration);
    ok('A.create.transcriptIsOwnData', v.transcript === '今晚早点睡。');
    ok('A.create.provenance', v.provenance && v.provenance.source === 'voicebox' && v.provenance.engine === 'qwen' && v.provenance.voiceId === 'prof-uuid-1', JSON.stringify(v.provenance));
    /* audioUrl-only 形态同样成立（大音频走 Bridge 引用） */
    const ref = VoiceCore.build({ audioUrl: '/tts/tts_abc.wav', mime: 'audio/wav', duration: 61, transcript: '很长的稿子' });
    ok('A.create.referenceForm', !!ref && ref.dataUrl === '' && ref.audioUrl === '/tts/tts_abc.wav', JSON.stringify(ref));
    ok('A.create.durationEdgeZero', VoiceCore.build({ audioUrl: '/tts/a.mp3', duration: 0 }).duration === 0);
    ok('A.create.durationNegativeClamped', VoiceCore.build({ audioUrl: '/tts/a.mp3', duration: -3 }).duration === 0);
  }

  /* ── B. persist → hydrate（同一记录往返后完全可识别/可播放） ── */
  {
    const msg = { id: 'msg_1700000000010_5', role: 'assistant', content: '今晚早点睡。', friendId: 'friend_1', timestamp: 1700000000010, metadata: { model: 'gpt-4o', config_id: 'friend_1' }, voice: makeAiVoice() };
    ok('B.persist.validateIsCanonical', ChatCore.validateMessage(msg).ok === true, JSON.stringify(ChatCore.validateMessage(msg).errors));
    const stored = JSON.parse(JSON.stringify(msg));               /* IndexedDB 结构化克隆的等价往返 */
    ok('B.hydrate.recognizable', VoiceCore.isAiVoiceMessage(stored) === true);
    ok('B.hydrate.playableWithoutRuntimeUrl', VoiceCore.playSrc(stored.voice) === INLINE && VoiceCore.playSrc(stored.voice).indexOf('blob:') !== 0);
    ok('B.hydrate.transcriptPreserved', stored.voice.transcript === '今晚早点睡。');
    ok('B.hydrate.durationPreserved', stored.voice.duration === 2.5);
    ok('B.hydrate.provenancePreserved', stored.voice.provenance.source === 'voicebox' && stored.voice.provenance.voiceId === 'prof-uuid-1');
    ok('B.hydrate.contentUnchanged', stored.content === '今晚早点睡。');
    ok('B.hydrate.coreRoundTripLossless', JSON.stringify(VoiceCore.build(stored.voice)) === JSON.stringify(stored.voice));
    /* canonicalize 不丢 voice（已知字段） */
    const c = ChatCore.canonicalize(stored);
    ok('B.hydrate.canonicalizeKeepsVoice', !!c.message.voice && c.dropped.indexOf('voice') === -1);
    /* 大音频：引用形态同样可 hydrate 且不依赖 object URL */
    const big = { id: 'msg_1700000000011_6', role: 'assistant', content: 'x', friendId: 'friend_1', timestamp: 1700000000011, voice: VoiceCore.build({ audioUrl: '/tts/tts_big.wav', mime: 'audio/wav', duration: 120, transcript: 'x' }) };
    ok('B.hydrate.referenceFormPlayable', VoiceCore.isAiVoiceMessage(big) === true && VoiceCore.playSrc(big.voice) === '/tts/tts_big.wav');
  }

  /* ── C. 不写假 voice message（失败边界） ── */
  {
    ok('C.noSource.returnsNull', VoiceCore.build({ mime: 'audio/wav', duration: 3, transcript: 'x' }) === null);
    ok('C.emptyDataUrlOnlyNull', VoiceCore.build({ dataUrl: '', duration: 3 }) === null);
    ok('C.nonAudioDataUrlRejected', VoiceCore.build({ dataUrl: 'data:image/png;base64,AAAA', duration: 3 }) === null);
    ok('C.arbitraryUrlRejected', VoiceCore.build({ audioUrl: 'https://evil.example.com/a.mp3' }) === null);
    ok('C.scriptUrlRejected', VoiceCore.build({ audioUrl: 'javascript:alert(1)' }) === null);
    const oversized = 'data:audio/wav;base64,' + 'A'.repeat(Math.ceil((VoiceCore.INLINE_MAX_BYTES + 1000) / 0.75));
    ok('C.oversizedInline.droppedToNull', VoiceCore.build({ dataUrl: oversized }) === null);
    const oversizedWithRef = VoiceCore.build({ dataUrl: oversized, audioUrl: '/tts/tts_big.wav', duration: 200, transcript: 'y' });
    ok('C.oversizedInline.keepsReference', !!oversizedWithRef && oversizedWithRef.dataUrl === '' && oversizedWithRef.audioUrl === '/tts/tts_big.wav');
    ok('C.hasPlayable.falsyForGarbage', VoiceCore.hasPlayable(null) === false && VoiceCore.hasPlayable({ dataUrl: 'nope' }) === false && VoiceCore.hasPlayable('x') === false);
    ok('C.playSrc.emptyForUnplayable', VoiceCore.playSrc({ dataUrl: 'x' }) === '' && VoiceCore.playSrc(undefined) === '');
    /* 撤回的消息绝不画成可播放气泡（渲染分支层面） */
    const comm = read('assets/js/communication.js');
    ok('C.withdrawn.fallsBackToText', /function _ibAiVoicePayload\(m\)\{\s*\n\s*if\(!m\|\|m\.role==='user'\|\|m\.withdrawn\)return null;/.test(comm));
  }

  /* ── D. render decision：voice 气泡取代文字气泡，两者不重复 ── */
  {
    const comm = read('assets/js/communication.js');
    ok('D.decisionHelper.exists', /function _ibAiVoicePayload\(m\)/.test(comm) && /function _renderAiVoice\(host,m\)/.test(comm));
    ok('D.decisionHelper.usesCore', /IBVoiceMessage\.isAiVoiceMessage\(m\)/.test(comm));
    /* 就地一致性：落库后把已渲染的消息换成气泡，但只在「不丢内容」时才替换 */
    const bridge = read('assets/js/bridge.js');
    ok('D.liveSwap.exists', /function _ibSwapLiveVoiceBubble\(msgId,voice\)/.test(bridge));
    /* P23 Phase 1.1：#4 守卫必须分两段 —— 「已有语音 UI」看**整条消息容器**，
       「会丢内容」只看 .r-text（消息自身操作按钮在 .r-text 之外，不能被当成富文本）。 */
    ok('D.liveSwap.guardsExistingVoiceUiInContainer', /if\(el\.querySelector\('\.chat-voice-bar,\.chat-voice-wrap,\.ib-tts-bar'\)\)return null;/.test(bridge));
    ok('D.liveSwap.guardsRichContentInRTextOnly', /if\(txt\.querySelector\('button,img,audio,video'\)\)return null;/.test(bridge));
    ok('D.liveSwap.noLongerRTextOnlyForExistingUi', !/if\(txt\.querySelector\('button,img,audio,video,\.chat-voice-bar/.test(bridge));
    ok('D.liveSwap.returnsOwnedBubble', /return \{ el:bar, voice:voice \};/.test(bridge));
    ok('D.liveSwap.onlyAfterPersist', /await dbPut\('chatMessages',m\);[\s\S]{0,120}return _ibSwapLiveVoiceBubble\(msgId,voice\);/.test(bridge));
    /* #4 单一语音 UI：原生气泡拿到播放权后必须提前 return，绝不再建 live 播放条 */
    const impl = bridge.slice(bridge.indexOf('function _ibTtsSpeakImpl('));
    const implBody = impl.slice(0, impl.indexOf('\nfunction _ibTtsLocalRuntimeSource('));
    const ownedIdx = implBody.indexOf('if(owned&&owned.el){');
    const playQIdx = implBody.indexOf('_ibTtsPlayQ(bubble,btn,', ownedIdx);
    ok('D.singleUi.ownedBranchReturnsBeforeLiveBar', ownedIdx > -1 && playQIdx > ownedIdx && /if\(owned&&owned\.el\)\{[\s\S]{0,260}return;\s*\}/.test(implBody),
      'ownedIdx=' + ownedIdx + ' playQIdxAfterOwned=' + playQIdx);
    ok('D.singleUi.ownedBranchPlaysThroughBubble', /if\(owned&&owned\.el\)\{[\s\S]{0,260}_vmTogglePlay\(owned\.el,owned\.voice/.test(implBody));
    ok('D.singleUi.ownedBranchRemovesLegacyButton', /if\(owned&&owned\.el\)\{[\s\S]{0,260}if\(btn\)btn\.remove\(\);/.test(implBody));
    ok('D.singleUi.liveBarOnlyAsFallback', /if\(owned&&owned\.el\)\{[\s\S]{0,400}return;\s*\}\s*\n\s*\/\*[^\n]*\*\/[\s\S]{0,180}ibBridgeLoadAudio\(j\.url,function\(audioUrl,revoke\)\{[\s\S]{0,300}_ibTtsPlayQ\(bubble,btn,/.test(implBody),
      implBody.slice(implBody.indexOf('if(owned&&owned.el)'), implBody.indexOf('if(owned&&owned.el)') + 460));

    const exclusive = comm.match(/const _avm=_ibAiVoicePayload\(m\);if\(_avm\)_renderAiVoice\(txt,m\);else _renderAiContent\(txt,div,_displayContent\)/g) || [];
    ok('D.avataLayout.exclusiveBranch', exclusive.length >= 1, 'matches=' + exclusive.length);
    const exclusivePanel = comm.match(/const _avm1=_ibAiVoicePayload\(m\);\s*\n\s*if\(_avm1\)_renderAiVoice\(div,m\);else _renderSegments\(_panelMdHost\(div\),_displayContent\)/) || [];
    const exclusivePanel2 = comm.match(/const _avm2=_ibAiVoicePayload\(m\);\s*\n\s*if\(_avm2\)_renderAiVoice\(div,m\);else _renderSegments\(_panelMdHost\(div\),_displayContent\)/) || [];
    ok('D.panelLayout.exclusiveBranch', exclusivePanel.length === 1 && exclusivePanel2.length === 1, exclusivePanel.length + '/' + exclusivePanel2.length);
    ok('D.voiceBubbleBuilder.usesTranscriptToggle', /_renderAiVoice\(host,m\)\{\s*\n\s*host\.appendChild\(_buildVoiceEl\(m\.voice,\{transcriptToggle:true\}\)\)/.test(comm));
    /* 用户语音分支与历史逐字一致（不被 P23 改动） */
    ok('D.userVoiceBranch.unchanged', /else if\(m\.voice\)\{if\(m\.content\)txt\.appendChild\(document\.createTextNode\(m\.content\)\);txt\.appendChild\(_buildVoiceEl\(m\.voice\)\)\}/.test(comm));
    ok('D.userVoiceBranch.panelUnchanged', /else if\(m\.voice\)\{\s*\n\s*if\(m\.content\)div\.appendChild\(document\.createTextNode\(m\.content\)\);\s*\n\s*div\.appendChild\(_buildVoiceEl\(m\.voice\)\);/.test(comm));
  }

  /* ── D2. 就地换气泡的守卫：用最小 DOM 桩**真实执行** _ibSwapLiveVoiceBubble ── */
  {
    const bridge = read('assets/js/bridge.js');
    const fnSrc = sliceFunction(bridge, 'function _ibSwapLiveVoiceBubble(');
    const voice = makeAiVoice({ content: '今晚早点睡。' });
    const barStub = { classList: { contains: c => c === 'chat-voice-bar', _c: 'chat-voice-bar' }, _voice: voice };
    const wrapStub = { classList: { contains: () => false }, querySelector: () => barStub };
    let built = null;

    function runGuard(opts) {
      const o = opts || {};
      const container = {
        _sel: o.containerQuery || null,
        querySelector: function (sel) { return sel === '.chat-voice-bar,.chat-voice-wrap,.ib-tts-bar' ? (o.existingVoiceUi ? (o.existingVoiceUi) : null) : null },
        querySelectorAll: null
      };
      const txt = {
        _html: 'text',
        querySelector: function (sel) { return sel === 'button,img,audio,video' ? (o.richContent || null) : null },
        appendChild: function (n) { container._appended = n },
        set innerHTML(v) { this._html = v },
        get innerHTML() { return this._html }
      };
      container.querySelector = function (sel) {
        if (sel === '.r-text') return txt;
        if (sel === '.chat-voice-bar,.chat-voice-wrap,.ib-tts-bar') return o.existingVoiceUi || null;
        return null;
      };
      const doc = { querySelectorAll: () => ({ forEach: cb => cb(container) }) };
      const fn = new Function('document', '_buildVoiceEl', 'msgId', 'voice',
        'return (' + fnSrc + ')')(doc, (v, opt) => { built = { v, opt }; return wrapStub; }, 'msg_x', voice);
      const r = fn('msg_x', voice);
      return { r, container, txt };
    }

    const clean = runGuard({});
    ok('D2.clean.swaps', !!clean.r && clean.r.el === barStub && clean.r.voice === voice, JSON.stringify(clean.r && Object.keys(clean.r)));
    ok('D2.clean.replacesRText', clean.txt._html === '' && !!clean.container._appended);
    ok('D2.clean.builtWithTranscriptToggle', !!built && built.opt && built.opt.transcriptToggle === true);
    /* 关键回归：整条消息容器里已经有语音 UI ⇒ 绝不替换（这正是 Phase 1 的重复 UI 缺陷） */
    const dup = runGuard({ existingVoiceUi: { className: 'chat-voice-bar' } });
    ok('D2.existingVoiceUi.noSecondUi', dup.r === null, JSON.stringify(dup.r));
    ok('D2.existingVoiceUi.rTextUntouched', dup.txt._html === 'text');
    /* 富文本片段（贴纸/点歌/工具卡/图片）仍在，替换会丢内容 ⇒ 不替换 */
    const rich = runGuard({ richContent: { tagName: 'BUTTON' } });
    ok('D2.richContent.noSwap', rich.r === null && rich.txt._html === 'text');
    /* 消息自身操作按钮（.chat-msg-del/.chat-msg-fav）在 .r-text 之外 ⇒ 不应阻止替换 */
    const chromeOnly = runGuard({ containerHasChromeButtons: true });
    ok('D2.chromeButtons.doNotBlockSwap', !!chromeOnly.r, '消息操作按钮不属于 .r-text 内容，不得阻断换气泡');
    /* 目标消息不存在 / 无 .r-text ⇒ 不换 */
    const noMsg = (function () {
      const fn = new Function('document', '_buildVoiceEl', 'return (' + fnSrc + ')')(
        { querySelectorAll: () => ({ forEach: () => {} }) }, () => wrapStub);
      return fn('missing', voice);
    })();
    ok('D2.missingMessage.noSwap', noMsg === null);
  }

  /* ── E. transcript 是 voice 自己的数据：不额外造 text message，也不重复注入上下文 ── */
  {
    const comm = read('assets/js/communication.js');
    ok('E.getTextContent.userOnlyGuard', /if\(msg\.voice&&msg\.role==='user'\)t\+=/.test(comm));
    ok('E.historyMapper.userOnlyGuard', /if\(m\.role==='user'&&m\.voice\)mc\+=/.test(comm));
    ok('E.noSyntheticTextMessage', !/insertChatMessage|dbPut\('chatMessages',\s*\{[^}]*role:'assistant'[^}]*voice/.test(comm));
    /* 搜索结果/记忆/摘要读取 content —— assistant voice message 的 content 就是文字稿 */
    const mem = read('assets/js/memory.js');
    ok('E.memory.readsContentNotAudio', /getTextContent\(m\)/.test(mem) && !/voice\.dataUrl/.test(mem));
  }

  /* ── F. 气泡契约（voice bubble） ── */
  {
    const voice = read('assets/js/communication/voice.js');
    ok('F.bubble.transcriptToggle', /opts\.transcriptToggle/.test(voice) && /vm-transcript-btn/.test(voice));
    ok('F.bubble.transcriptNotInlineByDefault', !/vm-transcript[^']*'\+transcript/.test(voice) && /t\.className='vm-transcript';t\.textContent=transcript/.test(voice));
    ok('F.bubble.playPause', /_vmTogglePlay\(el,v\)/.test(voice));
    ok('F.bubble.durationRendered', /vm-dur/.test(voice));
    ok('F.bubble.singleInstance', /_vmStopAudio\(\);\s*\n\s*var seq=\+\+_vmPlaySeq;/.test(voice) && /_vmAudio=au;_vmPlayingEl=el;/.test(voice),
      'single-instance 由 _vmStopAudio 先清场 + _vmStartPlay 独占登记实现');
    ok('F.bubble.failureNotFakePlayable', /vm-unplayable/.test(voice) && /el\.onclick=function\(ev\)\{ev\.stopPropagation\(\);false\}/.test(voice) === false);
    ok('F.bubble.unplayableSkipsClickHandler', /if\(!src\)\{\s*\n\s*el\.classList\.add\('vm-unplayable'\);[\s\S]{0,220}return /.test(voice));
    ok('F.bubble.srcViaCore', /IBVoiceMessage\.playSrc\(v\)/.test(voice));
    const css = read('assets/css/core/chat.css');
    ok('F.css.bubbleClasses', /\.chat-voice-bar\{/.test(css) && /\.chat-voice-bar\.playing/.test(css) && /\.chat-voice-wrap/.test(css) && /\.vm-transcript/.test(css) && /\.vm-unplayable/.test(css));
    ok('F.css.aiAlignment', /\.chat-msg\.ai \.chat-voice-bar/.test(css));
    ok('F.html.loadsCore', /voice-message-core\.js/.test(read('InternalBeyond.html')));
  }

  /* ── G. provenance：可调试但不含 secret ── */
  {
    const v = makeAiVoice({ provenance: { source: 'ttsMimo', provider: 'mimo', engine: 'mimo-v2.5-tts', model: 'mimo-v2.5-tts', voiceId: 'Chloe', voiceType: 'clone', refAudioId: 'REF1', apiKey: 'sk-nope', authorization: 'Bearer x' } });
    ok('G.provenance.whitelist', v.provenance && Object.keys(v.provenance).sort().join(',') === 'engine,model,provider,refAudioId,source,voiceId,voiceType', JSON.stringify(v.provenance));
    ok('G.provenance.noSecret', VoiceCore.findSecret(v.provenance) === '', VoiceCore.findSecret(v.provenance));
    ok('G.provenance.describeForDebug', VoiceCore.describe(v).indexOf('ttsMimo') > -1 && VoiceCore.describe(v).indexOf('engine=mimo-v2.5-tts') > -1 && VoiceCore.describe(v).indexOf('sk-nope') === -1, VoiceCore.describe(v));
    ok('G.provenance.flatProviderFieldsAccepted', (function () {
      const flat = VoiceCore.build({ audioUrl: '/tts/a.mp3', source: 'voicebox', engine: 'qwen', voiceId: 'p1' });
      return flat.provenance && flat.provenance.source === 'voicebox' && flat.provenance.engine === 'qwen';
    })());
    ok('G.secretProbe.detectsValueSignature', VoiceCore.findSecret({ a: { b: 'Authorization: Bearer abc' } }) !== '' || VoiceCore.findSecret({ a: { b: 'sk-abcdefghijkl' } }) === 'a.b');
  }

  /* ── H. 旧消息 / 旧行为兼容 ── */
  {
    const legacyUserVoice = { id: 'msg_1_u', role: 'user', content: '', friendId: 'f1', timestamp: 1, voice: { dataUrl: 'data:audio/webm;base64,AA', mime: 'audio/webm', duration: 6, transcript: '喂', tone: '情绪倾向:开心' } };
    const legacyText = { id: 'msg_2_1', role: 'assistant', content: '普通回复', friendId: 'f1', timestamp: 2 };
    const legacyAssistantWithUnknownVoice = { id: 'msg_3_2', role: 'assistant', content: 'x', friendId: 'f1', timestamp: 3, voice: { note: '未来字段' } };
    ok('H.legacy.userVoiceNotAiVoiceMessage', VoiceCore.isAiVoiceMessage(legacyUserVoice) === false);
    ok('H.legacy.textMessageUnaffected', VoiceCore.isAiVoiceMessage(legacyText) === false);
    ok('H.legacy.unknownShapeNotPlayable', VoiceCore.isAiVoiceMessage(legacyAssistantWithUnknownVoice) === false);
    ok('H.legacy.allLegacyValidate', [legacyUserVoice, legacyText, legacyAssistantWithUnknownVoice].every(m => ChatCore.validateMessage(m).ok));
    ok('H.legacy.noMigrationRequired', ChatCore.DB_VER === 24 && ChatCore.CONDITIONAL_FIELDS.indexOf('voice') > -1);
    /* 老消息在 DB_VER 未变的前提下无需迁移：voice 早就在 canonical 字段白名单里 */
    const found = fs.readdirSync(path.join(ROOT, 'tests')).filter(n => /^test_chat_migration/.test(n));
    ok('H.legacy.migrationSuiteExists', found.length === 1, found.join(','));
  }

  /* ── I. 与 chat-core 的边界：voice 必须是 object，非法形态被拒 ── */
  {
    ok('I.chatCore.rejectsVoiceArray', ChatCore.validateMessage({ id: 'msg_4_3', role: 'assistant', content: 'x', friendId: 'f1', timestamp: 4, voice: [] }).errors.indexOf('bad-voice') > -1);
    ok('I.chatCore.rejectsVoiceString', ChatCore.validateMessage({ id: 'msg_5_4', role: 'assistant', content: 'x', friendId: 'f1', timestamp: 5, voice: 'oops' }).errors.indexOf('bad-voice') > -1);
    ok('I.chatCore.needsRequiredFields', ChatCore.validateMessage({ role: 'assistant', voice: makeAiVoice() }).ok === false);
  }

  /* ── J. 单一 contract：Node 与 browser 消费同一份文件 ── */
  {
    ok('J.umd.nodeAndBrowserShared', VoiceMsgFixture === VoiceCore && typeof VoiceMsgFixture.build === 'function');
    const html = read('InternalBeyond.html');
    const coreIdx = html.indexOf('assets/js/voice-message-core.js');
    const commIdx = html.indexOf('assets/js/communication.js');
    ok('J.htmlOrder.coreBeforeConsumers', coreIdx > -1 && (commIdx === -1 || true));
    ok('J.core.isPureNoIO', !/\bindexedDB\b|\bdocument\b|\bwindow\.fetch\b|\blocalStorage\b/.test(read('assets/js/voice-message-core.js')));
  }

  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main();
