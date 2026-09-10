'use strict';

/* VoiceCall 重连契约回归（P2-01）。纯 Node + vm 执行 call.js 的真实片段，无浏览器、无网络。
   覆盖四条路径（每条都必须让 connect() 的 Promise 有确定结局，绝不悬挂）：
     A 握手前断线（首次连接）      → reject，voiceKind='connect'
     B 重连成功（hello_ack）        → resolve，并发出 {type:'start'}
     C 重连失败（握手前 close/error）→ reject，voiceKind='handshake'，由 scheduleReconnect 继续退避重试
     D 主动挂断（ended/destroyed）  → reject，voiceKind='cancelled'，不再重试
   另覆盖：达到 VS_MAX_RECONNECT 后停止并进入 error；只有 onerror 没有 onclose 的对端同样能结束。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const vm = require('node:vm');


const SOURCE = 'assets/js/communication/call.js';
const text = fs.readFileSync(path.join(ROOT, SOURCE), 'utf8');
function fragment(begin, end) {
  const start = text.indexOf(begin);
  assert.ok(start >= 0, 'source boundary missing: ' + begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start, 'source boundary missing: ' + end);
  return text.slice(start, stop);
}
/* 真实片段：_voiceConnError + connect + scheduleReconnect（不含 DOM/音频部分）。 */
const VOICE_FRAGMENT = fragment('function _voiceConnError(kind){', '/* The worklet posts');

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

function makeContext() {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close(code, reason) { this.readyState = 3; if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' }); }
    /* 对端主动断开（握手前） */
    drop(code) { this.readyState = 3; if (this.onclose) this.onclose({ code: code || 1006, reason: 'peer' }); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    ack() { if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: 'hello_ack' }) }); }
    failError() { if (this.onerror) this.onerror({}); }
  }
  const timers = [];
  const context = {
    console, Date, JSON, Promise, Math, Error, Object, Array, String, Number, isFinite, AbortController,
    WebSocket: FakeSocket,
    VS_MAX_RECONNECT: 5,
    wsUrl: () => 'ws://voice.test/voice',
    token: () => '',
    setTimeout: (fn, ms) => { const id = realSetTimeout(fn, 0); timers.push({ id, ms: ms || 0 }); return id; },
    clearTimeout: id => realClearTimeout(id)
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext('function VoiceCall(){this.destroyed=false;this.state="idle";this.reconnectAttempts=0;this.reconnecting=false;this.reconnectTimer=null;this.role={voice:{}};this.roleId="role-1";this.conversationId="conv-1";this.states=[];this.sent=[];this.messages=[];}'
    + 'VoiceCall.prototype.setState=function(s){this.state=s;this.states.push(s)};'
    + 'VoiceCall.prototype.showError=function(m){this.lastError=m};'
    + 'VoiceCall.prototype.send=function(o){this.sent.push(o)};'
    + 'VoiceCall.prototype.onMessage=function(m){this.messages.push(m)};', context);
  vm.runInContext(VOICE_FRAGMENT, context);
  return { context, sockets, timers, FakeSocket };
}

const settleWithin = (promise, ms = 200) => Promise.race([
  promise.then(() => 'resolved', () => 'rejected'),
  new Promise(r => realSetTimeout(() => r('pending'), ms))
]);

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); }
  catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
}

(async () => {
  console.log('Voice reconnect contract regression（P2-01）');

  /* A：握手前断线（首次连接） */
  await check('A 握手前断线（首次连接）→ reject voiceKind=connect', async () => {
    const { context, sockets } = makeContext();
    const call = new context.VoiceCall();
    let error = null;
    const p = call.connect(false).catch(e => { error = e; });
    assert.equal(sockets.length, 1, '应建立一条 WebSocket');
    sockets[0].drop(1006);
    assert.equal(await settleWithin(p), 'resolved', 'catch 后必须已结束');
    assert.ok(error, '必须 reject');
    assert.equal(error.voiceKind, 'connect');
    assert.equal(error.voiceCancelled, false);
  });

  /* B：重连成功 */
  await check('B 重连成功：hello_ack → resolve 且发出 start', async () => {
    const { context, sockets } = makeContext();
    const call = new context.VoiceCall();
    call.state = 'error';
    const p = call.connect(true);
    sockets[0].open();
    assert.ok(call.sent.some(x => x && x.type === 'hello'), 'onopen 应发送 hello');
    sockets[0].ack();
    assert.equal(await settleWithin(p), 'resolved', 'hello_ack 必须 resolve');
    assert.ok(call.sent.some(x => x && x.type === 'start' && x.roleId === 'role-1' && x.conversationId === 'conv-1'), '握手后必须发送 start');
    /* 握手后再断开 → 走统一的断线重连路径（不是 reject 悬挂） */
    call.state = 'connected';
    sockets[0].drop(1006);
    assert.equal(call.state, 'error', '握手后断开应进入 error 并调度重连');
    assert.equal(call.reconnecting, true, '应开始重连');
  });

  /* C：重连失败（握手前） */
  await check('C 重连失败（握手前 close）→ reject voiceKind=handshake', async () => {
    const { context, sockets } = makeContext();
    const call = new context.VoiceCall();
    call.state = 'error';
    let error = null;
    const p = call.connect(true).catch(e => { error = e; });
    sockets[0].drop(1006);
    assert.equal(await settleWithin(p), 'resolved', 'catch 后必须已结束');
    assert.ok(error, '必须 reject 而不是永久 pending');
    assert.equal(error.voiceKind, 'handshake');
    assert.equal(error.voiceCancelled, false);
  });

  await check('C2 只有 onerror 没有 onclose 也能结束', async () => {
    const { context, sockets } = makeContext();
    const call = new context.VoiceCall();
    call.state = 'error';
    let error = null;
    const p = call.connect(true).catch(e => { error = e; });
    sockets[0].failError();
    assert.equal(await settleWithin(p), 'resolved');
    assert.ok(error && error.voiceKind === 'handshake');
  });

  /* D：主动挂断 */
  await check('D 主动挂断：握手前挂断 → reject voiceKind=cancelled', async () => {
    const { context, sockets } = makeContext();
    const call = new context.VoiceCall();
    call.state = 'error';
    let error = null;
    const p = call.connect(true).catch(e => { error = e; });
    call.destroyed = true; call.state = 'ended';
    sockets[0].drop(1000);
    assert.equal(await settleWithin(p), 'resolved');
    assert.ok(error && error.voiceKind === 'cancelled' && error.voiceCancelled === true);
  });

  await check('D2 已结束状态再次 connect 直接 cancelled', async () => {
    const { context } = makeContext();
    const call = new context.VoiceCall();
    call.destroyed = true;
    await assert.rejects(() => call.connect(true), e => e.voiceCancelled === true && e.voiceKind === 'cancelled');
  });

  await check('D3 握手完成后才挂断：hello_ack 后 end 不产生 start/resolve 混乱', async () => {
    const { context, sockets } = makeContext();
    const call = new context.VoiceCall();
    const p = call.connect(true);
    call.destroyed = true; call.state = 'ended';
    sockets[0].ack();
    await assert.rejects(() => p, e => e.voiceCancelled === true);
    assert.equal(call.sent.filter(x => x && x.type === 'start').length, 0, '挂断后不得发送 start');
  });

  /* scheduleReconnect 集成 */
  await check('E scheduleReconnect：失败后继续退避重试，成功后 attempts 归零', async () => {
    const { context, timers } = makeContext();
    const call = new context.VoiceCall();
    let attempts = 0;
    call.connect = async function (isReconnect) {
      attempts++;
      assert.equal(isReconnect, true, '重连必须用 connect(true)');
      if (attempts === 1) { const e = new Error('x'); e.voiceKind = 'handshake'; throw e; }
    };
    call.scheduleReconnect();
    assert.equal(call.reconnectAttempts, 1);
    for (let i = 0; i < 6; i++) await new Promise(r => realSetTimeout(r, 5));
    assert.equal(attempts, 2, '第一次失败后应再重试一次');
    assert.equal(call.reconnectAttempts, 0, '成功后 attempts 归零');
    assert.equal(call.state, 'connecting');
    assert.deepEqual(timers.map(t => t.ms), [1000, 2000], '退避应为 1s、2s');
  });

  await check('F scheduleReconnect：cancelled 后不再重试', async () => {
    const { context } = makeContext();
    const call = new context.VoiceCall();
    let attempts = 0;
    call.connect = async function () { attempts++; const e = new Error('ended'); e.voiceKind = 'cancelled'; e.voiceCancelled = true; throw e; };
    call.scheduleReconnect();
    for (let i = 0; i < 6; i++) await new Promise(r => realSetTimeout(r, 5));
    assert.equal(attempts, 1, '取消后不得再重试');
    assert.equal(call.reconnectAttempts, 1);
  });

  await check('G 达到 VS_MAX_RECONNECT 后停止并报错', async () => {
    const { context } = makeContext();
    const call = new context.VoiceCall();
    call.connect = async function () { const e = new Error('x'); e.voiceKind = 'handshake'; throw e; };
    call.scheduleReconnect();
    for (let i = 0; i < 40; i++) await new Promise(r => realSetTimeout(r, 3));
    assert.equal(call.reconnectAttempts, 5, '最多 5 次');
    assert.equal(call.reconnecting, false);
    assert.equal(call.state, 'error');
    assert.match(String(call.lastError || ''), /could not be re-established/);
  });

  await check('H 挂断后 scheduleReconnect 不再启动', async () => {
    const { context } = makeContext();
    const call = new context.VoiceCall();
    call.destroyed = true;
    call.scheduleReconnect();
    assert.equal(call.reconnectAttempts, 0);
    assert.equal(call.reconnectTimer, null);
  });

  console.log(failures ? '\nVoice reconnect regression failed: ' + failures : '\nVoice reconnect regression passed ✔');
  process.exitCode = failures ? 1 : 0;
})();
