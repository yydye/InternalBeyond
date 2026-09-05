/* ====================================================================
   voice.js 声学语气 · Call 路径 Int16→AudioBuffer-like 适配与复用测试
   --------------------------------------------------------------------
   焦点：不重新验证算法，而是证明
     1) Call 的 Int16 PCM 能进入现有 _vmToneAnalyze（经 _vmPcmToAudioLike 适配）；
     2) 同一 16kHz 采样经「适配路径」与「AudioBuffer 等价路径」，tone 一致/等价；
     3) 静音 / 过短输入被正确拒绝（tone 为空）；
     4) 适配器是纯函数、零副作用、不复制 _vmToneAnalyze 算法。
   运行：node test_voice_pcm_adapter.js
   ==================================================================== */
'use strict';

/* 以最小 window/IB 壳加载 voice.js，拿到【真实】_vmToneAnalyze 与适配器（不复制算法） */
globalThis.window = globalThis.window || {};
window.IB = window.IB || {};
window.IB.expose = window.IB.expose || function () {};
require('./assets/js/communication/voice.js');
var analyze = window._vmToneAnalyze;
var toAudioLike = window._vmPcmToAudioLike;

var SR = 16000; /* worklet 输出 16kHz 单声道 */

function int16(seconds, freq, amp, sampleRate) {
  var sr = sampleRate || SR, n = Math.round(sr * seconds);
  var pcm = new Int16Array(n);
  for (var i = 0; i < n; i++) {
    var t = i / sr;
    var v = amp * Math.sin(2 * Math.PI * freq * t);
    v = Math.max(-1, Math.min(1, v));
    pcm[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return pcm;
}

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok - ' + name); }
  else { fail++; console.error('FAIL - ' + name + (detail ? (' :: ' + detail) : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ===== 1. 适配器结构：_vmToneAnalyze 所需的元数据 ===== */
(function () {
  var pcm = int16(1.2, 200, 0.3);
  var ab = toAudioLike(pcm, SR);
  ok('adapter.非空', !!ab);
  ok('adapter.sampleRate', ab.sampleRate === SR, 'sampleRate=' + ab.sampleRate);
  ok('adapter.length', ab.length === pcm.length, 'length=' + ab.length);
  ok('adapter.channels==1', ab.numberOfChannels === 1);
  ok('adapter.duration≈1.2', approx(ab.duration, 1.2, 0.02), 'duration=' + ab.duration);
  ok('adapter.getChannelData.长度', ab.getChannelData(0).length === pcm.length);
  ok('adapter.首样本转换正确', approx(ab.getChannelData(0)[0], pcm[0] / 32768, 1e-6),
    'first=' + ab.getChannelData(0)[0]);
})();

/* ===== 2. 复用：适配器输出可被真实 _vmToneAnalyze 消费 ===== */
(function () {
  var pcm = int16(1.2, 200, 0.3);
  var ab = toAudioLike(pcm, SR);
  var tone = analyze(ab, '今天不错');
  ok('reuse.analyzer.返回非空', typeof tone === 'string' && tone.length > 0, tone);
  ok('reuse.analyzer.含情绪倾向', /情绪倾向:/.test(tone), tone);
  ok('reuse.analyzer.含语速', /语速/.test(tone), tone);
})();

/* ===== 3. 等价：同一 16kHz 采样，适配路径 vs AudioBuffer 等价路径 tone 一致 ===== */
(function () {
  var pcm = int16(1.2, 200, 0.3);
  var txt = '今天不错';
  var ab = toAudioLike(pcm, SR);
  /* 模拟 voice.js 录音路径：一个带相同 Float32 样本 + 元数据的 AudioBuffer 等价对象 */
  var ch = new Float32Array(pcm.length);
  for (var i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  var ref = { sampleRate: SR, numberOfChannels: 1, length: pcm.length, _ch: [ch] };
  Object.defineProperty(ref, 'duration', { get: function () { return pcm.length / SR; } });
  ref.getChannelData = function (c) { return ref._ch[c] || ref._ch[0]; };
  var tAdapt = analyze(ab, txt);
  var tRef = analyze(ref, txt);
  ok('equiv.tone一致', tAdapt === tRef, 'adapt=[' + tAdapt + '] ref=[' + tRef + ']');
})();

/* ===== 4. 静音 → 空 ===== */
(function () {
  var sil = new Int16Array(Math.round(SR * 1.2));
  var ab = toAudioLike(sil, SR);
  ok('mute.earray非空', !!ab);
  ok('mute.tone为空', analyze(ab, '安静') === '', analyze(ab, '安静'));
})();

/* ===== 5. 过短（0.4s < 0.6s）→ 空 ===== */
(function () {
  var pcm = int16(0.4, 200, 0.3);
  var ab = toAudioLike(pcm, SR);
  ok('short.tone为空', analyze(ab, '呀') === '', analyze(ab, '呀'));
})();

/* ===== 6. 适配器边界：null / 空 → null ===== */
(function () {
  ok('adapter.null→null', toAudioLike(null, SR) === null);
  ok('adapter.空→null', toAudioLike(new Int16Array(0), SR) === null);
})();

console.log('\n==== 结果 ====');
console.log('pass=' + pass + '  fail=' + fail);
process.exit(fail ? 1 : 0);
