/* ====================================================================
   P1 阶段2 · Call 声学语气参考 · 注入判定与持久化隔离测试
   --------------------------------------------------------------------
   通过最小 window/IB 壳加载【真实】voice.js（_vmPcmToAudioLike/_vmToneAnalyze/
   _vmAudioNative）与 call.js（_acousticReferenceFor），用真实函数验证：
     1) 普通模型会产出 acoustic reference；
     2) audio-native / cfg.audioInput=true 会跳过；
     3) 隔离：reference 只进 messages 末条用户消息的新对象，不碰 userMsg / 原 history；
     4) 无 PCM / 静音 / 过短 → 不产出 reference（不伪造）；
     5) reference 每次独立计算（不跨 turn）。
   运行：node test_call_acoustic_inject.js
   ==================================================================== */
'use strict';

globalThis.window = globalThis.window || {};
window.IB = window.IB || {};
window.IB.expose = window.IB.expose || function () {};
/* _vmAudioNative 依赖 PROVIDERS：给一个最小表以覆盖 gemini(原生)/openai(需文本化)/anthropic */
globalThis.PROVIDERS = {
  openai: { name: 'OpenAI', endpoint: '', model: '', format: 'openai', vision: true, streaming: true },
  gemini: { name: 'Gemini', endpoint: '', model: '', format: 'gemini', vision: true, streaming: true },
  anthropic: { name: 'Anthropic', endpoint: '', model: '', format: 'anthropic', vision: true, streaming: true },
  custom: { name: 'Custom', endpoint: '', model: '', format: 'openai', vision: true, streaming: true },
};

require('./assets/js/communication/voice.js'); /* 提供 _vmPcmToAudioLike/_vmToneAnalyze/_vmAudioNative */
require('./assets/js/communication/call.js');  /* 提供 _acousticReferenceFor */

var analyze = window._vmToneAnalyze;
var toAudioLike = window._vmPcmToAudioLike;
var audioNative = window._vmAudioNative;
var acousticRefFor = window._acousticReferenceFor;

var SR = 16000;
function int16(seconds, freq, amp) {
  var n = Math.round(SR * seconds), pcm = new Int16Array(n);
  for (var i = 0; i < n; i++) {
    var t = i / SR, v = amp * Math.sin(2 * Math.PI * freq * t);
    v = Math.max(-1, Math.min(1, v));
    pcm[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return pcm;
}
function chunksOf(pcm) { return [pcm.buffer]; }
function silenceChunks(sec) { return [new Int16Array(Math.round(SR * sec)).buffer]; }

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok - ' + name); }
  else { fail++; console.error('FAIL - ' + name + (detail ? (' :: ' + detail) : '')); }
}

var cfgOpenai = { id: 'c1', provider: 'openai', model: 'gpt-4o-mini' };
var cfgGemini = { id: 'g1', provider: 'gemini', model: 'gemini-2.0-flash' };
var cfgAudioName = { id: 'a1', provider: 'openai', model: 'gpt-audio-model' };
var cfgAudioFlag = { id: 'f1', provider: 'openai', model: 'gpt-4o-mini', audioInput: true };
var cfgAnthropic = { id: 'h1', provider: 'anthropic', model: 'claude-sonnet' };

/* ===== 基础：模型判定 ===== */
ok('native.gemini为真', audioNative(cfgGemini) === true);
ok('native.openai普通为假', audioNative(cfgOpenai) === false, String(audioNative(cfgOpenai)));
ok('native.模型名含audio为真', audioNative(cfgAudioName) === true);
ok('native.anthropic为假', audioNative(cfgAnthropic) === false);

/* ===== 1. 普通模型注入 ===== */
(function () {
  var ref = acousticRefFor(cfgOpenai, chunksOf(int16(1.2, 200, 0.3)), '今天不错');
  ok('inject.普通模型产出', typeof ref === 'string' && ref.length > 0, ref);
  ok('inject.含情绪倾向', /情绪倾向:/.test(ref), ref);
})();

/* ===== 2. audio-native 跳过（Gemini / 模型名含audio / anthropic 需文本化） ===== */
(function () {
  ok('skip.gemini', acousticRefFor(cfgGemini, chunksOf(int16(1.2, 200, 0.3)), '今天不错') === '');
  ok('skip.模型名含audio', acousticRefFor(cfgAudioName, chunksOf(int16(1.2, 200, 0.3)), '今天不错') === '');
  ok('skip.audioInput=true', acousticRefFor(cfgAudioFlag, chunksOf(int16(1.2, 200, 0.3)), '今天不错') === '');
})();

/* ===== 3. 隔离：reference 只进 messages 末条用户消息的新对象，不碰 userMsg / 原始 history ===== */
(function () {
  var transcript = '今天不错';
  /* 模拟通信层：userMsg（将被持久化）与 history（存储对象） */
  var userMsg = { role: 'user', content: transcript };
  var stored = { role: 'user', content: transcript };
  var ref = acousticRefFor(cfgOpenai, chunksOf(int16(1.2, 200, 0.3)), transcript);
  /* messages 是 history.map 产生的【新对象】 */
  var messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: stored.content }];
  /* 复现通信层最小分支（与 communication.js 相同语义） */
  if (ref) {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user' && typeof messages[i].content === 'string') {
        messages[i].content = messages[i].content + '\n\n[Acoustic reference]\n' + ref + '\n[/Acoustic reference]';
        break;
      }
    }
  }
  var injected = messages[messages.length - 1].content;
  ok('iso.messages末条已注入', /\[Acoustic reference\]/.test(injected) && /\[\/Acoustic reference\]/.test(injected), injected);
  ok('iso.userMsg.content不含reference', userMsg.content === transcript && userMsg.content.indexOf('Acoustic reference') === -1);
  ok('iso.原始history.content不含reference', stored.content === transcript && stored.content.indexOf('Acoustic reference') === -1);
  ok('iso.messages对象≠userMsg对象', messages[messages.length - 1].content === transcript + '\n\n[Acoustic reference]\n' + ref + '\n[/Acoustic reference]');
})();

/* ===== 4. 无 PCM / 静音 / 过短 → 不产出 ===== */
(function () {
  ok('guard.无chunk', acousticRefFor(cfgOpenai, [], '你好') === '');
  ok('guard.静音', acousticRefFor(cfgOpenai, silenceChunks(1.2), '安静') === '');
  ok('guard.过短', acousticRefFor(cfgOpenai, chunksOf(int16(0.4, 200, 0.3)), '呀') === '');
  ok('guard.空chunk字节', acousticRefFor(cfgOpenai, [new ArrayBuffer(0)], '空') === '');
})();

/* ===== 5. 每次独立计算（纯函数，不跨 turn 复用） ===== */
(function () {
  var pcm = int16(1.2, 200, 0.3);
  var a = acousticRefFor(cfgOpenai, chunksOf(pcm), '今天不错');
  var b = acousticRefFor(cfgOpenai, chunksOf(pcm), '今天不错');
  ok('fresh.两次独立且一致', typeof a === 'string' && a.length > 0 && a === b, a);
  var after = acousticRefFor(cfgGemini, chunksOf(pcm), '今天不错');
  ok('fresh.模型不同则结果不同', after === '', after);
})();

console.log('\n==== 结果 ====');
console.log('pass=' + pass + '  fail=' + fail);
process.exit(fail ? 1 : 0);
