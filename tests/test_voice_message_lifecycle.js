'use strict';

/* Internal Beyond · Voice message 生命周期测试（P23 Phase 1.1 · Closure Fix #2/#3）。
 *
 * 冻结的不变量：**voice 与 content 只能有一个真相。**
 *   · content 被人为改写（撤回 / 续写 / 编辑 / 重新生成）⇒ voice 必须消失；
 *   · 即使某个路径忘了删，渲染层也必须拒绝把陈旧音频画成这条消息的语音。
 *
 * 覆盖 Closure Audit 的两个 High：
 *   High-1 撤回只清 images/wsSearches/memOps，voice（音频 + transcript + provenance）留在记录与导出里；
 *   High-3 续写改写 content 却不处理 voice ⇒ content 增长而 transcript/音频长度分叉。
 *
 * 做法：契约部分 require 真实模块；两条生产路径用**真实函数体**执行（stub store）；
 * 未来的编辑/重新生成路径用渲染层防御覆盖。零依赖、零网络、零浏览器。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
/* CRLF 安全的花括号配对提取器（源码可能是 CRLF）。 */
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
const AUDIO = 'data:audio/wav;base64,' + Buffer.from('RIFF0000WAVEfmt-payload').toString('base64');
function aiRecord(content, extra) {
  const msg = Object.assign({
    id: 'msg_1700000000200_9', role: 'assistant', content: content,
    friendId: 'friend_1', timestamp: 1700000000200, metadata: { model: 'gpt-4o', config_id: 'friend_1' }
  }, extra || {});
  msg.voice = VoiceCore.build({
    dataUrl: AUDIO, audioUrl: '/tts/tts_lc.wav', mime: 'audio/wav', duration: 4,
    transcript: content, content: content,
    provenance: { source: 'voicebox', provider: 'voicebox', engine: 'qwen', voiceId: 'p1', voiceType: 'builtin' }
  });
  return msg;
}

/* ── 契约：指纹 / 陈旧 / 生命周期原语 ── */
function contract() {
  const a = VoiceCore.contentFingerprint('今晚早点睡。');
  ok('C1.fingerprint.deterministic', a === VoiceCore.contentFingerprint('今晚早点睡。'));
  ok('C1.fingerprint.changesOnEdit', a !== VoiceCore.contentFingerprint('今晚早点睡！'));
  ok('C1.fingerprint.prefixDiffers', VoiceCore.contentFingerprint('abc') !== VoiceCore.contentFingerprint('abcd'));
  ok('C1.fingerprint.whitespaceSensitive', VoiceCore.contentFingerprint('a b') !== VoiceCore.contentFingerprint('ab'));
  ok('C1.fingerprint.nonStringSafe', VoiceCore.contentFingerprint(null) === VoiceCore.contentFingerprint('') && VoiceCore.contentFingerprint(undefined) === VoiceCore.contentFingerprint(''));

  const m = aiRecord('今晚早点睡。');
  ok('C2.build.recordsContentHash', typeof m.voice.contentHash === 'string' && m.voice.contentHash.length > 0, JSON.stringify(m.voice.contentHash));
  ok('C2.fresh.notStale', VoiceCore.isStale(m) === false);
  ok('C2.fresh.isAiVoiceMessage', VoiceCore.isAiVoiceMessage(m) === true);

  m.content = '今晚早点睡。记得关窗。';
  ok('C3.editedContent.isStale', VoiceCore.isStale(m) === true);
  ok('C3.editedContent.notRenderedAsVoice', VoiceCore.isAiVoiceMessage(m) === false, '渲染层必须拒绝陈旧音频');
  ok('C3.editedContent.playSrcStillAvailableButUnused', VoiceCore.playSrc(m.voice) !== '');

  /* dropVoice 是唯一生命周期原语：删干净、幂等、返回是否发生 */
  const d = aiRecord('x');
  ok('C4.dropVoice.removesField', VoiceCore.dropVoice(d) === true && !('voice' in d));
  ok('C4.dropVoice.idempotent', VoiceCore.dropVoice(d) === false);
  ok('C4.dropVoice.survivesJsonRoundTrip', !('voice' in JSON.parse(JSON.stringify(d))));
  /* 没有 contentHash 的早期记录不得被误判为陈旧（fail open 渲染） */
  const legacy = { role: 'assistant', content: 'hello', voice: { dataUrl: AUDIO, duration: 2, transcript: 'hello' } };
  ok('C5.legacy.noHashNotStale', VoiceCore.isStale(legacy) === false && VoiceCore.isAiVoiceMessage(legacy) === true);
  /* 用户录音消息不受陈旧判定影响（它们没有 contentHash，也不走这条判定） */
  const userVoice = { role: 'user', content: '', voice: { dataUrl: AUDIO, mime: 'audio/webm', duration: 5, transcript: '喂' } };
  ok('C5.userVoice.neverAiVoiceMessage', VoiceCore.isAiVoiceMessage(userVoice) === false && VoiceCore.isStale(userVoice) === false);
}

/* ── 撤回：执行真实函数体，观察真正写进 store 的记录 ── */
function withdraw() {
  const src = read('assets/js/communication.js');
  const fnSrc = sliceFunction(src, 'async function _chatWithdrawMsg(');
  const store = {};
  const fn = new Function(
    'dbGet', 'dbPut', 'toast', 'document', '_chatCfgById', '_resolveShowThinking', 'window',
    'return (' + fnSrc + ')'
  )(
    async () => JSON.parse(JSON.stringify(record)),
    async (s, d) => { store[s] = JSON.parse(JSON.stringify(d)) },
    () => {},
    { querySelectorAll: () => ({ forEach: () => {} }) },
    () => ({ nickname: 'X' }),
    () => true,
    { IBVoiceMessage: VoiceCore }
  );
  const record = aiRecord('今晚早点睡。', { images: [{ dataUrl: 'data:image/png;base64,AA' }], wsSearches: [{ q: 'x' }], memOps: [{ ok: true }] });
  return fn('msg_1700000000200_9').then(() => {
    const w = store.chatMessages;
    ok('W1.withdraw.persisted', !!w);
    ok('W1.withdraw.contentTombstoned', /撤回了一条消息/.test(w.content), w.content);
    ok('W1.withdraw.imagesGone', !('images' in w));
    ok('W1.withdraw.wsSearchesGone', !('wsSearches' in w));
    ok('W1.withdraw.memOpsGone', !('memOps' in w));
    ok('W2.withdraw.voiceGone', !('voice' in w), '仍存在: ' + JSON.stringify(Object.keys(w.voice || {})));
    ok('W2.withdraw.transcriptGone', JSON.stringify(w).indexOf('今晚早点睡') === -1, JSON.stringify(w).slice(0, 200));
    ok('W2.withdraw.audioGone', JSON.stringify(w).indexOf('data:audio') === -1);
    ok('W2.withdraw.provenanceGone', JSON.stringify(w).indexOf('voicebox') === -1);
    /* 导出面：撤回记录不得再带音频/文字稿 */
    const exported = JSON.stringify({ version: 9, chatMessages: [w] });
    ok('W3.export.noAudio', exported.indexOf('data:audio') === -1 && exported.indexOf('/tts/') === -1, exported.slice(0, 200));
    ok('W3.export.noTranscript', exported.indexOf('今晚早点睡') === -1);
    ok('W3.export.stillCanonical', ChatCore.validateMessage(w).ok === true, JSON.stringify(ChatCore.validateMessage(w).errors));
    /* 非语音消息的撤回行为不被改变 */
    return null;
  });
}

/* ── 续写：路径契约 + 同一原语的行为 ── */
function continuation() {
  const ws = read('assets/js/workspace.js');
  const fn = sliceFunction(ws, 'async function continueTruncatedMsg(');
  ok('N1.continuation.mutatesContent', /m\.content=newContent/.test(fn));
  ok('N1.continuation.persists', /await dbPut\('chatMessages',m\)/.test(fn));
  ok('N1.continuation.dropsVoice', /IBVoiceMessage\.dropVoice\(m\)/.test(fn) || /delete m\.voice/.test(fn));
  ok('N1.continuation.dropBeforePersist', fn.indexOf('m.content=newContent') < fn.indexOf('IBVoiceMessage.dropVoice(m)') || fn.indexOf('m.content=newContent') < fn.indexOf('delete m.voice'));
  /* 行为：把续写实际做的两件事照做一遍，结果必须是「voice 不存在」 */
  const m = aiRecord('今晚早点睡。');
  m.content = m.content + '记得关窗。';            /* workspace.js:1034 的等价操作 */
  VoiceCore.dropVoice(m);                          /* workspace.js:1038 的等价操作 */
  ok('N2.continuation.result.voiceGone', !('voice' in m));
  ok('N2.continuation.result.contentKept', m.content === '今晚早点睡。记得关窗。');
  ok('N2.continuation.result.noStaleAudioInExport', JSON.stringify(m).indexOf('data:audio') === -1);
  /* 即使漏删，也绝不能被渲染成语音 */
  const forgot = aiRecord('今晚早点睡。');
  forgot.content = forgot.content + '（漏删 path）';
  ok('N3.continuation.forgotDrop.stillNotRenderedAsVoice', VoiceCore.isAiVoiceMessage(forgot) === false);
  /* truncated 消息一律不语音化：不制造注定要被续写超越的音频 */
  const b = read('assets/js/bridge.js');
  const persist = sliceFunction(b, 'async function _ibPersistAiVoice(');
  ok('N4.persist.skipsTruncated', /m\.truncated/.test(persist) && /return null/.test(persist));
  ok('N4.persist.earlyReturnBeforeFetch', persist.indexOf('m.truncated') < persist.indexOf('_ibFetchAiVoiceDataUrl('));
}

/* ── 编辑 / 重新生成：生产实现不存在，但渲染层防御必须成立 ── */
function editAndRegenerate() {
  const cases = [
    ['edit', m => { m.content = '用户改写的文本' }],
    ['regenerate', m => { m.content = '重新生成的完全不同的回复' }],
    ['retry', m => { m.content = '' }],
    ['bulkRewrite', m => { m.content = m.content.replace(/。/g, '！') }],
    ['truncateContent', m => { m.content = m.content.slice(0, 2) }]
  ];
  let allSafe = true, detail = '';
  cases.forEach(([name, mutate]) => {
    const m = aiRecord('今晚早点睡。');
    mutate(m);
    const stillRenderable = VoiceCore.isAiVoiceMessage(m);
    const stale = VoiceCore.isStale(m);
    if (stillRenderable || !stale) { allSafe = false; detail += name + ' ' }
  });
  ok('E1.unknownMutationPaths.cannotRenderStaleVoice', allSafe, detail);
  /* 反向：未改动的记录必须仍然可渲染（不能因为防御而整体失效） */
  const untouched = aiRecord('今晚早点睡。');
  ok('E2.untouched.stillRenderable', VoiceCore.isAiVoiceMessage(untouched) === true);
  /* transcript 本身不是判定依据（TTS 前会剥离标记与截断，transcript 与 content 本来就不保证逐字相等）；
     判定依据是 content 指纹 —— content 一变立即判陈旧。 */
  const mismatch = aiRecord('原始文本');
  mismatch.voice.transcript = '被手改成另一个文本';
  ok('E3.transcriptOnlyTamper.notDetectedByDesign', VoiceCore.isStale(mismatch) === false);
  ok('E3.transcriptOnlyTamper.contentStillAuthoritative', VoiceCore.isAiVoiceMessage(mismatch) === true);
  mismatch.content = '原始文本（已变）';
  ok('E3.contentChange.detected', VoiceCore.isStale(mismatch) === true && VoiceCore.isAiVoiceMessage(mismatch) === false);
}

/* ── 安全：生命周期操作后记录里不得出现任何凭据 ── */
function security() {
  const m = aiRecord('今晚早点睡。');
  ok('S1.record.noSecret', VoiceCore.findSecret(m) === '');
  ok('S1.contentHash.isNotSecret', VoiceCore.findSecret({ voice: { contentHash: m.voice.contentHash } }) === '');
  /* 模拟「角色的 apiKey 被误塞进 voice / provenance」也必须被清洗 */
  const dirty = VoiceCore.build({
    audioUrl: '/tts/a.wav', duration: 1, transcript: 't', content: 't',
    provenance: { source: 'tts', apiKey: 'sk-should-not-persist', authorization: 'Bearer x', token: 't' }
  });
  ok('S2.dirtyProvenance.cleaned', VoiceCore.findSecret(dirty) === '' && !('apiKey' in (dirty.provenance || {})), JSON.stringify(dirty.provenance));
  const rec = aiRecord('今晚早点睡。');
  rec.voice = dirty;
  ok('S2.recordAfterClean.noSecret', VoiceCore.findSecret(rec) === '');
  /* 撤回后导出依旧干净 */
  const w = aiRecord('今晚早点睡。');
  VoiceCore.dropVoice(w);
  ok('S3.withdrawn.exportClean', VoiceCore.findSecret(JSON.parse(JSON.stringify({ chatMessages: [w] }))) === '');
  /* 全文扫描：四个生命周期写入点都不含凭据字面量 */
  const sites = [
    ['assets/js/communication.js', 'async function _chatWithdrawMsg('],
    ['assets/js/workspace.js', 'async function continueTruncatedMsg('],
    ['assets/js/bridge.js', 'async function _ibPersistAiVoice(']
  ];
  let bad = '';
  sites.forEach(([f, sig]) => {
    const body = sliceFunction(read(f), sig).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    if (/apiKey|authorization|Bearer\s/i.test(body)) bad += f + ' ';
  });
  ok('S4.lifecycleWriters.noCredentialLiteral', bad === '', bad);
}

/* ── 重复语音 UI：同一消息只能有一个 voice UI（Closure Audit High-3） ── */
function duplicateUi() {
  const b = read('assets/js/bridge.js');
  const swapSrc = sliceFunction(b, 'function _ibSwapLiveVoiceBubble(');
  /* 源码级：守卫必须查**整条消息容器**，而不是只查 .r-text */
  ok('U1.swapGuardsWholeMessage',
    /el\.querySelector\('\.chat-voice-bar,\.chat-voice-wrap,\.ib-tts-bar'\)/.test(swapSrc),
    swapSrc.slice(0, 120));
  ok('U2.swapDoesNotGuardOnlyText',
    !/txt\.querySelector\('\.chat-voice-bar/.test(swapSrc));
  /* 成功分支必须把播放权交给原生气泡，且不得再创建 live 播放条 */
  const speak = sliceFunction(b, 'function _ibTtsSpeakImpl(');
  ok('U3.speak.ownedBubbleTakesPlayback',
    /if\(owned&&owned\.el\)\{[\s\S]{0,400}_vmTogglePlay\(owned\.el,owned\.voice/.test(speak));
  ok('U4.speak.removesLiveBtnOnOwnership',
    /if\(owned&&owned\.el\)\{[\s\S]{0,400}btn\.remove\(\)/.test(speak));
  ok('U5.speak.noSecondPlayBarWhenOwned',
    speak.slice(speak.indexOf('if(owned&&owned.el){'), speak.indexOf('ibBridgeLoadAudio(j.url,')).indexOf('_ibTtsPlayQ(') === -1);

  /* 行为：执行真实 _ibSwapLiveVoiceBubble，观察是否真的只留一个语音 UI */
  const built = [];
  function fakeBuild(voice) {
    const bar = { classList: { contains: c => c === 'chat-voice-bar' }, _voice: voice };
    built.push(bar);
    return bar;
  }
  const swapFactory = new Function('document', '_buildVoiceEl', 'return (' + swapSrc + ')');

  function makeDom(hasExistingVoice, hasRich) {
    const txt = {
      innerHTML: '旧内容', _children: [],
      appendChild(n) { this._children.push(n); },
      querySelector(sel) { return hasRich ? { tag: 'button' } : null; }
    };
    const msg = {
      dataset: { msgId: 'm1' },
      querySelector(sel) {
        if (sel === '.r-text') return txt;
        if (sel.indexOf('chat-voice-bar') !== -1) return hasExistingVoice ? { tag: 'bar' } : null;
        return null;
      }
    };
    const document = { querySelectorAll() { return { forEach: cb => cb(msg) }; } };
    return { document, msg, txt };
  }

  const clean = makeDom(false, false);
  const r1 = swapFactory(clean.document, fakeBuild)('m1', { duration: 3, transcript: 'x' });
  ok('U6.behavior.cleanMessage.swaps', !!r1 && built.length === 1, JSON.stringify(r1));
  ok('U7.behavior.cleanMessage.exactlyOneVoiceUi', clean.txt._children.length === 1 && clean.txt.innerHTML === '');

  const existing = makeDom(true, false);
  const r2 = swapFactory(existing.document, fakeBuild)('m1', { duration: 3, transcript: 'x' });
  ok('U8.behavior.existingVoiceUi.noSecondBubble', r2 === null && existing.txt.innerHTML === '旧内容');

  const rich = makeDom(false, true);
  const r3 = swapFactory(rich.document, fakeBuild)('m1', { duration: 3, transcript: 'x' });
  ok('U9.behavior.richContent.notReplaced', r3 === null && rich.txt.innerHTML === '旧内容');

  const missing = swapFactory({ querySelectorAll() { return { forEach: () => {} } } }, fakeBuild)('m1', {});
  ok('U10.behavior.missingMessage.returnsNull', missing === null);
}

/* ── 本地运行时失败语义：Voicebox 失败 ⇒ 明确报错，绝不代读（Closure Audit Medium） ── */
function localRuntime() {
  const b = read('assets/js/bridge.js');
  const speak = sliceFunction(b, 'function _ibTtsSpeakImpl(');
  ok('R1.guard.exists', /function _ibTtsLocalRuntimeSource\(vc\)/.test(b));
  /* 两条失败路径（j.ok=false 与 .catch）都必须先判本地运行时 */
  const guards = (speak.match(/if\(_ibTtsLocalRuntimeSource\(vcSafe\)\)\{ ibErrLocal\(/g) || []).length;
  ok('R2.bothFailurePathsGuarded', guards >= 2, 'guards=' + guards);
  ok('R3.nonLocalKeepsHistoricalFallback',
    (speak.match(/else ibTtsFallback\(text,btn/g) || []).length >= 2);
  /* 行为：真实函数体判定哪些 source 属于不可替代的本地运行时 */
  const fnSrc = sliceFunction(b, 'function _ibTtsLocalRuntimeSource(');
  const fn = new Function('return (' + fnSrc + ')')();
  ok('R4.voicebox.isLocalRuntime', fn({ source: 'voicebox' }) === true);
  ok('R5.voiceboxByProvider.isLocalRuntime', fn({ provider: 'Voicebox' }) === true);
  ok('R6.edge.notLocalRuntime', fn({ source: 'edge' }) === false);
  ok('R7.openai.notLocalRuntime', fn({ provider: 'openai' }) === false);
  ok('R8.empty.notLocalRuntime', fn({}) === false && fn(null) === false);
  /* 两条失败路径的「系统语音代读」都必须挂在守卫的 else 上：本地运行时绝不代读 */
  ok('R9.fallbackOnlyAttachedToGuardElse',
    (speak.match(/if\(_ibTtsLocalRuntimeSource\(vcSafe\)\)\{ ibErrLocal\([\s\S]{0,220}?else ibTtsFallback\(text,btn/g) || []).length >= 2);
}

async function main() {
  console.log('== Internal Beyond · Voice message 生命周期测试 ==');
  contract();
  editAndRegenerate();
  continuation();
  duplicateUi();
  localRuntime();
  security();
  await withdraw();
  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main();
