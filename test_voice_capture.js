'use strict';

/* Regression test for the VoiceCall mic-capture chain.
   The AudioWorklet posts {pcm:ArrayBuffer, rms:number}, but MessagePort delivers a
   MessageEvent whose payload sits on `.data`. onCapture used to read `.pcm` straight
   off that event, so pcm was undefined and `pcm.byteLength` threw on the first frame
   — capture never started. These cases lock in the real callback shape plus explicit
   handling of malformed chunks. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCall() {
  const warnings = [];
  const elements = new Map();
  function el() { return { style: {}, textContent: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [], hidden: false, setAttribute() {} }; }
  for (const id of ['voice-call-modal', 'voice-call-state', 'voice-call-meter-fill', 'voice-call-wave']) elements.set(id, el());

  const win = {};
  const sandbox = {
    window: win,
    document: { getElementById: (id) => elements.get(id) || null },
    performance: { now: () => Date.now() },
    console: { warn: (m) => warnings.push(String(m)), log() {}, error() {} },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function () {}, Audio: function () { return { addEventListener() {}, play: () => Promise.resolve(), pause() {} }; },
    ArrayBuffer, Uint8Array, Int16Array, Math, Date, Number, String, JSON, isFinite
  };
  win.IB = { expose(name, api) { win.IB[name] = api; } };
  win.MediaSource = { isTypeSupported: () => true };
  sandbox.MediaSource = win.MediaSource;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/js/communication/call.js'), 'utf8'), sandbox, { filename: 'call.js' });
  return { VoiceCall: win.IB.voiceCall.VoiceCall, warnings, sandbox };
}

function makeCall(VoiceCall) {
  const call = new VoiceCall({ roleId: 'r1', conversationId: 'main:r1', role: {} });
  const sent = [];
  call.ws = { readyState: 1, send: (b) => sent.push(b), close() {} };
  call.sent = sent;
  return call;
}

/* Build the exact payload the worklet posts for one 128-frame render quantum. */
function workletPayload(rms, samples) {
  const pcm = new Int16Array(samples == null ? 320 : samples);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 1000;
  return { pcm: pcm.buffer, rms };
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
}

const { VoiceCall } = loadCall();

/* ── 1. The real MessagePort shape: payload wrapped in a MessageEvent ── */
check('MessageEvent-wrapped payload starts capture without throwing', () => {
  const { VoiceCall: V, warnings } = loadCall();
  const call = makeCall(V);
  /* This is what port.onmessage actually receives. */
  call.onCapture({ data: workletPayload(0.002), type: 'message', ports: [] });
  assert.strictEqual(warnings.length, 0, 'valid chunk must not warn: ' + warnings.join(' | '));
  assert.strictEqual(call.preRoll.length, 1, 'pcm must be buffered into preRoll');
  assert.strictEqual(call.preRollBytes, 640, 'byteLength must be readable');
  assert(call._wave.length === 1, 'rms must feed the waveform');
});

/* ── 2. Loud speech over a MessageEvent drives VAD into speaking + ws frames ── */
check('sustained loud MessageEvent frames trigger speechStart and send PCM', () => {
  const { VoiceCall: V } = loadCall();
  const call = makeCall(V);
  for (let i = 0; i < 8; i++) call.onCapture({ data: workletPayload(0.5) });
  assert.strictEqual(call.speaking, true, 'VAD should have entered speech');
  /* The same socket carries JSON control frames and binary PCM; split them. */
  const control = call.sent.filter(b => typeof b === 'string').map(JSON.parse);
  const binary = call.sent.filter(b => typeof b !== 'string');
  assert.deepStrictEqual(control.map(c => c.type), ['speech_start'], 'speech_start must be announced');
  assert.strictEqual(typeof call.sent[0], 'string', 'speech_start must precede any PCM');
  assert(binary.length > 0, 'PCM must reach the websocket');
  assert(binary.every(b => b instanceof ArrayBuffer), 'binary frames must be ArrayBuffers');
  assert(binary.every(b => b.byteLength === 640), 'each frame must carry its full PCM window');
});

/* ── 3. A bare payload (direct call, no MessageEvent) still works ── */
check('bare {pcm,rms} payload is accepted', () => {
  const { VoiceCall: V, warnings } = loadCall();
  const call = makeCall(V);
  call.onCapture(workletPayload(0.002));
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(call.preRollBytes, 640);
});

/* ── 4. A typed-array pcm is normalised to an ArrayBuffer window ── */
check('Int16Array pcm is normalised to its own byte window', () => {
  const { VoiceCall: V, warnings } = loadCall();
  const call = makeCall(V);
  const backing = new Int16Array(1000);
  const view = backing.subarray(100, 420); /* 320 samples = 640 bytes */
  call.onCapture({ data: { pcm: view, rms: 0.002 } });
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(call.preRollBytes, 640, 'must use the view window, not the whole buffer');
  assert(call.preRoll[0] instanceof ArrayBuffer);
});

/* ── 5. Malformed chunks are dropped explicitly, with a diagnostic log ── */
check('malformed chunks are dropped and logged, never thrown', () => {
  const { VoiceCall: V, warnings } = loadCall();
  const call = makeCall(V);
  const bad = [
    undefined, null, 'noise', 42,
    { data: undefined },                       /* event with no payload */
    { pcm: undefined, rms: 0.01 },             /* the original crash shape */
    { data: { pcm: null, rms: 0.01 } },
    { data: { pcm: new ArrayBuffer(0), rms: 0.01 } },
    { data: { pcm: new ArrayBuffer(64), rms: NaN } },
    { data: { pcm: new ArrayBuffer(64), rms: -1 } }
  ];
  for (const b of bad) call.onCapture(b); /* must not throw */
  assert.strictEqual(call.preRoll.length, 0, 'no bad chunk may enter preRoll');
  assert.strictEqual(call.preRollBytes, 0);
  assert.strictEqual(call._captureBad, bad.length, 'every bad chunk must be counted');
  assert(warnings.length >= 1, 'the first bad chunk must be reported');
  assert(/\[IB Voice\] dropped capture chunk/.test(warnings[0]), 'log must be diagnosable: ' + warnings[0]);
  assert(/undefined/.test(warnings.join(' ')), 'log must name the offending shape');
});

/* ── 6. A bad chunk does not poison a subsequent good one ── */
check('capture recovers after a malformed chunk', () => {
  const { VoiceCall: V } = loadCall();
  const call = makeCall(V);
  call.onCapture({ pcm: undefined, rms: 0.01 });
  call.onCapture({ data: workletPayload(0.002) });
  assert.strictEqual(call.preRollBytes, 640);
});

/* ── 7. The worklet contract itself still posts {pcm, rms} ── */
check('voice-worklet.js posts the {pcm,rms} contract onCapture expects', () => {
  const src = fs.readFileSync(path.join(__dirname, 'assets/js/voice-worklet.js'), 'utf8');
  assert(/port\.postMessage\(\s*\{\s*pcm:\s*pcm\.buffer\s*,\s*rms:/.test(src), 'worklet payload shape changed');
});

console.log('\n' + (fail === 0 ? 'Voice capture test passed ✔ (' + pass + ')' : 'Voice capture test FAILED (' + fail + ')'));
process.exit(fail ? 1 : 0);
