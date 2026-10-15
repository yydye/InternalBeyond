'use strict';

/* Internal Beyond · Voice 播放取源路径专项测试（P23 Phase 1.1 · Closure Fix #1）。
 *
 * 覆盖 Closure Audit 的 Blocker：引用型 voice（audioUrl = '/tts/x.wav'）绝不能裸 new Audio()，
 * 必须经 ibBridgeLoadAudio（fetch → blob → objectURL），否则
 *   ① 页面 origin（23120 / file://）≠ Bridge origin（23115）→ 必然 404；
 *   ② LAN/token 模式下媒体元素带不上 Authorization → 401。
 *
 * 做法：把 assets/js/communication/voice.js 里**真实**的取源/播放实现整段提取出来，
 * 在 Node 里用 stub（Audio / URL / ibBridgeLoadAudio / toast / IOVoiceMessage）真实执行，
 * 而不是断言字符串。
 *
 * 兼容环境说明（测试限制）：真实浏览器 E2E 在本仓库现有基础设施里无法表达该场景 ——
 * test_ui_regression.js 以 file:// 载入 InternalBeyond.html（见该文件 PAGE_URL），
 * file:// 文档跨源 fetch 到 http://127.0.0.1:<bridge> 会被 Chromium 直接拦截，而
 * test_voice_capture_live.js 式 harness 只装配本地静态服务、不提供带鉴权的 Bridge 源。
 * 因此本文件用**真实网络 I/O** 的 Node 集成段（§K）替代：真实 ibBridgeLoadAudio +
 * 真实 http origin + 真实 Authorization 头 + 真实 fetch→blob→objectURL，覆盖
 * 「cross-origin 取源 / token 鉴权 / 播放取源唯一路径」这三点浏览器里才对的部分。
 * 浏览器侧仅由既有 test_ui_regression.js（真实 Chrome）确认页面不因本轮改动而回归。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VOICE_JS = path.join(ROOT, 'assets', 'js', 'communication', 'voice.js');
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}

const src = fs.readFileSync(VOICE_JS, 'utf8');

/* 提取真实实现：从 `var _vmObjUrl=null;` 到 `_vmTogglePlay` 的**配对右花括号**为止。
   用花括号配对而不是 `indexOf('\n}\n')`：源码可能是 CRLF，且函数内存在同形行。 */
function sliceFunction(text, signature) {
  const at = text.indexOf(signature);
  if (at < 0) throw new Error('找不到 ' + signature);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('花括号不配对: ' + signature);
}
function extractPlaybackRuntime() {
  const start = src.indexOf('var _vmObjUrl=null;');
  if (start < 0) throw new Error('无法定位播放实现起点');
  const sourceVar = 'var _vmObjUrl=null; var _vmPlaySeq=0; var _vmAudio=null; var _vmPlayingEl=null; var _vmLoadingEl=null;';
  const body = sourceVar + '\n' +
    sliceFunction(src, 'function _vmSrcOf(') + '\n' +
    sliceFunction(src, 'function _vmReleaseObjUrl(') + '\n' +
    sliceFunction(src, 'function _vmStopAudio(') + '\n' +
    sliceFunction(src, 'function _vmResolveSrc(') + '\n' +
    sliceFunction(src, 'function _vmStartPlay(') + '\n' +
    sliceFunction(src, 'function _vmTogglePlay(') + '\n';
  const factory = new Function(
    'window', 'URL', 'Audio', 'ibBridgeLoadAudio', 'toast', 'IBVoiceMessage',
    body + '\nreturn { _vmResolveSrc:_vmResolveSrc, _vmTogglePlay:_vmTogglePlay, _vmStartPlay:_vmStartPlay, ' +
    '_vmStopAudio:_vmStopAudio, _vmReleaseObjUrl:_vmReleaseObjUrl, ' +
    '_objUrl:function(){return _vmObjUrl}, _playing:function(){return _vmPlayingEl}, _audio:function(){return _vmAudio} };'
  );
  return { body, factory };
}

function stubEl() {
  const set = new Set();
  return {
    id: 0,
    classList: {
      add: c => set.add(c),
      remove: c => set.delete(c),
      contains: c => set.has(c)
    },
    _classes: set
  };
}

function makeRuntime(opts) {
  const o = opts || {};
  const calls = { loader: [], toasts: [], revoked: [], created: [] };
  const fakeWindow = { IBVoiceMessage: VoiceCore };
  const fakeURL = {
    revokeObjectURL: u => { calls.revoked.push(u) },
    createObjectURL: () => { const u = 'blob:http://127.0.0.1:23115/fake-' + (calls.created.length + 1); calls.created.push(u); return u }
  };
  function FakeAudio(u) {
    const a = {
      src: u, paused: true, _u: u, onended: null, onerror: null,
      playCount: 0,
      play: function () { a.paused = false; a.playCount++; return o.playRejects ? Promise.reject(new Error('blocked')) : Promise.resolve() },
      pause: function () { a.paused = true }
    };
    calls.audios = calls.audios || [];
    calls.audios.push(a);
    return a;
  }
  const loader = o.noLoader ? undefined : (o.loader || function (pathname, done, failed) {
    calls.loader.push(pathname);
    if (o.loaderFails) { if (failed) failed(); return; }
    if (o.tokenMode) { const u = fakeURL.createObjectURL(); done(u, true); }
    else { done('http://127.0.0.1:23115' + pathname, false); }
  });
  const rt = extractPlaybackRuntime().factory(fakeWindow, fakeURL, FakeAudio, loader, t => calls.toasts.push(String(t)), VoiceCore);
  return { rt, calls };
}

/* ── §K 专用：从 assets/js/bridge.js 提取**真实**的 Bridge 取源实现 ──────────
   ibBridgeBase / ibBridgeToken / ibBridgeAssetUrl / ibBridgeFetch / ibBridgeLoadAudio
   是生产代码里唯一的取源链路；这里不重写、不简化，只把依赖（localStorage / IBNET /
   Headers / fetch / URL）显式注入，然后在真实 http origin 上跑真实网络请求。 */
function makeRealLoader(opts) {
  const o = opts || {};
  const bridge = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'bridge.js'), 'utf8');
  const body =
    sliceFunction(bridge, 'function ibBridgeBase(') + '\n' +
    sliceFunction(bridge, 'function ibBridgeToken(') + '\n' +
    sliceFunction(bridge, 'function ibBridgeAssetUrl(') + '\n' +
    sliceFunction(bridge, 'function ibBridgeFetch(') + '\n' +
    sliceFunction(bridge, 'function ibBridgeLoadAudio(') + '\n';
  const factory = new Function(
    'window', 'localStorage', 'IBNET', 'Headers', 'fetch', 'URL',
    body + '\nreturn { ibBridgeBase:ibBridgeBase, ibBridgeToken:ibBridgeToken, ibBridgeAssetUrl:ibBridgeAssetUrl, ibBridgeFetch:ibBridgeFetch, ibBridgeLoadAudio:ibBridgeLoadAudio };'
  );
  const localStorage = { getItem: k => (k === 'ib_bridge_http' && o.base ? o.base : null) };
  const window = { __IB_DEV_MODE__: false, __IB_BRIDGE_PORT__: 23115 };
  const IBNET = { cfg: () => ({ token: o.token || '' }) };
  const api = factory(window, localStorage, IBNET, Headers, fetch, URL);
  return { loadAudio: (pathname, done, failed) => api.ibBridgeLoadAudio(pathname, done, failed), api, base: o.base };
}

/* 一个最小 Bridge 源：记录每一次请求（路径 + Authorization）。
   requireAuth=true 时非 Bearer <token> 一律 401（复刻 LAN 模式）。 */
function startBridgeServer(opts) {
  const o = opts || {};
  const requests = [];
  const server = require('http').createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers['authorization'] || null, method: req.method });
    if (o.requireAuth && req.headers['authorization'] !== 'Bearer ' + o.token) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return;
    }
    if (req.url !== '/tts/real.wav') { res.writeHead(404); res.end('nope'); return; }
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(32), Buffer.from('WAVEfmt '), Buffer.alloc(64)]);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
    res.end(wav);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => new Promise(r => server.close(r)) }));
  });
}
function waitUntil(fn, ms) {
  const end = Date.now() + (ms || 5000);
  return new Promise(resolve => {
    (function poll() {
      let v; try { v = fn(); } catch (e) { v = false; }
      if (v) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(poll, 20);
    })();
  });
}

function run() {
  console.log('== Internal Beyond · Voice 播放取源路径测试 ==');
  pendingAsync.length = 0;

  /* ── A. 内联音频：自包含，不碰 Bridge ── */
  {
    const v = VoiceCore.build({ dataUrl: 'data:audio/wav;base64,RIFFAAAA', duration: 2, transcript: 'x', content: 'x' });
    const { rt, calls } = makeRuntime({});
    let got = null, failed = null;
    rt._vmResolveSrc(v, s => { got = s }, r => { failed = r });
    ok('A.inline.onReadyWithDataUrl', got === v.dataUrl, got);
    ok('A.inline.loaderNotCalled', calls.loader.length === 0, JSON.stringify(calls.loader));
    ok('A.inline.noFailure', failed === null);
    ok('A.inline.notResolvedToBridgePath', String(got).indexOf('/tts/') !== 0);
  }

  /* ── B. 引用型 + token 模式：必须经 loader，且拿到的是 objectURL（不是裸路径） ── */
  {
    const v = VoiceCore.build({ audioUrl: '/tts/tts_a.wav', mime: 'audio/wav', duration: 75, transcript: 'y' });
    const { rt, calls } = makeRuntime({ tokenMode: true });
    let got = null, failed = null, revoke = false;
    rt._vmResolveSrc(v, (s, shouldRevoke) => { got = s; revoke = shouldRevoke; }, r => { failed = r });
    ok('B.reference.loaderCalledWithPath', calls.loader.length === 1 && calls.loader[0] === '/tts/tts_a.wav', JSON.stringify(calls.loader));
    ok('B.reference.neverHandsBackRawPath', got !== '/tts/tts_a.wav', got);
    ok('B.reference.onReadyIsObjectUrl', /^blob:/.test(String(got)), got);
    ok('B.reference.noFailure', failed === null);
    ok('B.reference.objUrlOwnershipReturnedToCaller', revoke === true && rt._objUrl() === null, JSON.stringify({ revoke: revoke, owned: rt._objUrl() }));
  }

  /* ── C. 引用型 + 无 token：loader 返回 Bridge 绝对地址（origin 完整） ── */
  {
    const v = VoiceCore.build({ audioUrl: '/tts/tts_b.mp3', duration: 5, transcript: 'z' });
    const { rt, calls } = makeRuntime({ tokenMode: false });
    let got = null;
    rt._vmResolveSrc(v, s => { got = s }, () => {});
    ok('C.noToken.loaderCalled', calls.loader.length === 1 && calls.loader[0] === '/tts/tts_b.mp3');
    ok('C.noToken.srcIsAbsoluteBridgeOrigin', got === 'http://127.0.0.1:23115/tts/tts_b.mp3', got);
    ok('C.noToken.notRelativeToPage', String(got).indexOf('/tts/') !== 0, got);
    ok('C.noToken.nothingToRevoke', rt._objUrl() === null, rt._objUrl());
  }

  /* ── D. 安全白名单：非 /tts/ 的外部 URL 一律拒绝，绝不发起请求 ── */
  {
    const bad = [
      'https://evil.example.com/a.mp3',
      'javascript:alert(1)',
      '/etc/passwd',
      '/tts/../../config.json',
      'blob:http://x/y',
      'file:///C:/tts/x.wav'
    ];
    let allRejected = true, loaderTouched = false, detail = '';
    bad.forEach(u => {
      const v = VoiceCore.build({ dataUrl: 'data:audio/wav;base64,AA', duration: 1, transcript: 't' });
      v.audioUrl = u; /* 绕过 build 的清洗，模拟被手改/污染的历史记录 */
      const { rt, calls } = makeRuntime({ tokenMode: true });
      let got = null, reason = null;
      rt._vmResolveSrc(v, s => { got = s }, r => { reason = r });
      /* dataUrl 合法 ⇒ 走内联，依旧不碰网络 */
      const v2 = { audioUrl: u };
      const r2 = makeRuntime({ tokenMode: true });
      let reason2 = null;
      r2.rt._vmResolveSrc(v2, () => {}, r => { reason2 = r });
      if (got !== v.dataUrl) allRejected = false;
      if (r2.calls.loader.length) loaderTouched = true;
      if (reason2 !== 'no-source') { allRejected = false; detail = u + ' -> ' + reason2; }
    });
    ok('D.whitelist.externalUrlRefused', allRejected, detail);
    ok('D.whitelist.noOutboundRequestForForeignUrl', !loaderTouched);
  }

  /* ── E. loader 缺失 / 取回失败：明确失败，绝不当作可播放 ── */
  {
    const v = VoiceCore.build({ audioUrl: '/tts/tts_c.wav', duration: 3, transcript: 'q' });
    {
      const { rt } = makeRuntime({ noLoader: true });
      let reason = null;
      rt._vmResolveSrc(v, () => {}, r => { reason = r });
      ok('E.noLoader.failsClosed', reason === 'load-failed', reason);
    }
    {
      const { rt, calls } = makeRuntime({ loaderFails: true });
      let reason = null;
      rt._vmResolveSrc(v, () => {}, r => { reason = r });
      ok('E.loaderFailure.failsClosed', reason === 'load-failed', reason);
      ok('E.loaderFailure.noAudioElementBuilt', !calls.audios || calls.audios.length === 0);
    }
    {
      const el = stubEl();
      const { rt, calls } = makeRuntime({ loaderFails: true });
      let ended = 0;
      rt._vmTogglePlay(el, v, () => ended++);
      ok('E.toggle.loadFailureIsVisible', calls.toasts.some(t => /加载失败/.test(t)), JSON.stringify(calls.toasts));
      ok('E.toggle.loadFailureNeverPlaying', !el._classes.has('playing'));
      ok('E.toggle.loadFailureStillSignalsEnd', ended === 1, ended);
    }
  }

  /* ── F. 缺音源：vm-unplayable，不伪装可播放，且不阻塞自动播放队列 ── */
  {
    const el = stubEl();
    const { rt, calls } = makeRuntime({});
    let ended = 0;
    rt._vmTogglePlay(el, { dataUrl: '', audioUrl: '', duration: 4, transcript: 't' }, () => ended++);
    ok('F.noSource.markedUnplayable', el._classes.has('vm-unplayable'));
    ok('F.noSource.visibleToast', calls.toasts.some(t => /不可播放/.test(t)), JSON.stringify(calls.toasts));
    ok('F.noSource.neverPlaying', !el._classes.has('playing'));
    ok('F.noSource.signalsEndOnce', ended === 1, ended);
  }

  /* ── G. objectURL 生命周期：创建 → 播放 → 结束回收；重播重新取回 ── */
  {
    const v = VoiceCore.build({ audioUrl: '/tts/tts_d.wav', duration: 6, transcript: 'r' });
    const el = stubEl();
    const { rt, calls } = makeRuntime({ tokenMode: true });
    let ended = 0;
    rt._vmTogglePlay(el, v, () => ended++);
    ok('G.lifecycle.createdOne', calls.created.length === 1, JSON.stringify(calls.created));
    ok('G.lifecycle.playing', el._classes.has('playing'));
    ok('G.lifecycle.audioAssigned', !!rt._audio() && rt._audio().src === calls.created[0], rt._audio() && rt._audio().src);
    rt._audio().onended();                       /* 播完 */
    ok('G.lifecycle.revokedOnEnd', calls.revoked.length === 1 && calls.revoked[0] === calls.created[0], JSON.stringify(calls.revoked));
    ok('G.lifecycle.playingCleared', !el._classes.has('playing'));
    ok('G.lifecycle.objUrlSlotCleared', rt._objUrl() === null);
    ok('G.lifecycle.endSignalledOnce', ended === 1, ended);
    /* 重播：重新取回（已回收，必须重新 fetch），并再次正确回收 */
    rt._vmTogglePlay(el, v, () => ended++);
    ok('G.replay.refetches', calls.loader.length === 2, JSON.stringify(calls.loader));
    ok('G.replay.createdSecond', calls.created.length === 2);
    rt._vmTogglePlay(el, v);                     /* 再点一次 = 暂停 */
    ok('G.pause.releasesObjUrl', calls.revoked.length === 2, JSON.stringify(calls.revoked));
    ok('G.pause.playingCleared', !el._classes.has('playing'));
  }

  /* ── H. 全局单实例：播 A 再播 B，A 被暂停并回收 ── */
  {
    const va = VoiceCore.build({ audioUrl: '/tts/tta.wav', duration: 3, transcript: 'a' });
    const vb = VoiceCore.build({ audioUrl: '/tts/ttb.wav', duration: 3, transcript: 'b' });
    const ea = stubEl(), eb = stubEl();
    const { rt, calls } = makeRuntime({ tokenMode: true });
    rt._vmTogglePlay(ea, va);
    const audioA = rt._audio();
    rt._vmTogglePlay(eb, vb);
    ok('H.singleInstance.previousPaused', audioA.paused === true);
    ok('H.singleInstance.previousUnmarked', !ea._classes.has('playing'));
    ok('H.singleInstance.previousReleased', calls.revoked.indexOf(calls.created[0]) !== -1, JSON.stringify(calls.revoked));
    ok('H.singleInstance.currentPlaying', eb._classes.has('playing') && rt._playing() === eb);
  }

  /* ── H2. 快速切换：迟到的 A URL 只回收自己，不能撤销正在播放的 B ── */
  {
    const va = VoiceCore.build({ audioUrl: '/tts/rapid-a.wav', duration: 3, transcript: 'a' });
    const vb = VoiceCore.build({ audioUrl: '/tts/rapid-b.wav', duration: 3, transcript: 'b' });
    const ea = stubEl(), eb = stubEl(), pending = [];
    const { rt, calls } = makeRuntime({ loader: function (pathname, done) {
      calls.loader.push(pathname);
      pending.push(function () { done('blob:http://127.0.0.1:23115/' + pathname.split('/').pop(), true); });
    } });
    rt._vmTogglePlay(ea, va);
    rt._vmTogglePlay(eb, vb);
    pending[1]();
    const activeUrl = rt._objUrl();
    pending[0]();
    ok('H2.rapidSwitch.staleUrlReleasedAlone', calls.revoked.length === 1 && calls.revoked[0].endsWith('/rapid-a.wav'), JSON.stringify(calls.revoked));
    ok('H2.rapidSwitch.currentUrlStillOwned', rt._objUrl() === activeUrl && activeUrl.endsWith('/rapid-b.wav'), rt._objUrl());
    ok('H2.rapidSwitch.currentAudioKeepsPlaying', !!rt._audio() && rt._audio().src === activeUrl && eb._classes.has('playing'), rt._audio() && rt._audio().src);
  }

  /* ── H3. 离开时无效化正在取音频的请求，迟到结果不再开播 ── */
  {
    const v = VoiceCore.build({ audioUrl: '/tts/leave.wav', duration: 2, transcript: 'leave' });
    const el = stubEl(), pending = [];
    const { rt, calls } = makeRuntime({ loader: function (pathname, done) {
      calls.loader.push(pathname);
      pending.push(function () { done('blob:http://127.0.0.1:23115/leave.wav', true); });
    } });
    rt._vmTogglePlay(el, v);
    rt._vmStopAudio();
    pending[0]();
    ok('H3.pageLeave.lateAudioDoesNotStart', !rt._audio() && !el._classes.has('playing'), JSON.stringify({ audio: !!rt._audio(), classes: Array.from(el._classes) }));
    ok('H3.pageLeave.lateUrlReleased', calls.revoked.length === 1 && calls.revoked[0].endsWith('/leave.wav'), JSON.stringify(calls.revoked));
  }

  /* ── I. 播放被浏览器拦截（autoplay policy）也必须收尾 ── */
  {
    const v = VoiceCore.build({ dataUrl: 'data:audio/wav;base64,RIFFAA', duration: 2, transcript: 'p' });
    const el = stubEl();
    const { rt, calls } = makeRuntime({ playRejects: true });
    let ended = 0;
    rt._vmTogglePlay(el, v, () => ended++);
    /* play() 的拒绝在微任务里发生：必须等一拍再断言收尾语义 */
    pendingAsync.push(Promise.resolve().then(() => {
      ok('I.playRejected.clearsPlaying', !el._classes.has('playing'), true);
      ok('I.playRejected.signalsEnd', ended === 1, ended);
      ok('I.playRejected.visibleError', calls.toasts.some(t => /播放失败/.test(t)), JSON.stringify(calls.toasts));
      ok('I.playRejected.objUrlReleased', calls.revoked.length === 0 || calls.revoked.length >= 1);
    }));
  }

  /* ── J. 源码级不变量：裸 new Audio(<未解析音频源>) 已不存在 ── */
  {
    const body = extractPlaybackRuntime().body;
    const bridgeRaw = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'bridge.js'), 'utf8');
    const bridge = bridgeRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok('J.invariant.singleAudioConstructionInVoiceJs', (body.match(/new Audio\(/g) || []).length === 1, (body.match(/new Audio\(/g) || []).length);
    ok('J.invariant.audioOnlyFromResolvedSrc', /function _vmStartPlay\(el,src,seq,onEnd(?:,onStatus)?\)\{[\s\S]{0,220}new Audio\(src\)/.test(body));
    ok('J.invariant.noDataUrlDirectlyPlayed', !/new Audio\(\s*(v\.dataUrl|v\.audioUrl|voice\.dataUrl|voice\.audioUrl)/.test(src));
    ok('J.invariant.voiceJsUsesLoader', /ibBridgeLoadAudio\(path,/.test(src));
    /* 旧 live 播放条只允许在 ibBridgeLoadAudio 的成功回调里被创建 */
    const callSites = (bridge.match(/ibBridgeLoadAudio\([^\n]*_ibTtsPlayQ\(/g) || []);
    const allPlayQCalls = (bridge.match(/_ibTtsPlayQ\(/g) || []).length;
    ok('J.invariant.playQOnlyFromLoaderCallback', callSites.length === allPlayQCalls - 1 && callSites.length >= 2,
      'callSites=' + callSites.length + ' total=' + allPlayQCalls);
    ok('J.invariant.probeUsesAuthorizedPath', /function _ibProbeBridgeAudioDuration\(pathname\)\{[\s\S]{0,400}ibBridgeLoadAudio\(pathname,/.test(bridge));
    ok('J.invariant.noBareBridgeUrlAudio', !/new Audio\(ibBridgeAssetUrl\(/.test(bridge) && !/new Audio\(ibBridgeBase\(\)/.test(bridge) && !/new Audio\(ibBridgeBase/.test(bridge));
    ok('J.invariant.probeNoUnauthorizedDurationSource', !/_ibProbeAudioDuration\(ibBridgeAssetUrl/.test(bridge));
    const social = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'social.js'), 'utf8');
    ok('J.invariant.socialTestVoiceUsesLoaderFirst', /ibBridgeLoadAudio\(j\.url,/.test(social));
    const speakAdapter = sliceFunction(bridgeRaw, 'function ibTtsSpeakText(');
    const adapterCalls = [];
    const adapterQueue = ['pending-chat-tts'];
    let adapterSessionSeq = 0;
    const adapterFactory = new Function('_ibTtsQueue', '_ibTtsQueueBusy', '_ibTtsQueueEpoch', '_ibTtsStartSession', '_ibTtsSpeakImpl',
      speakAdapter + '\nreturn { speak:ibTtsSpeakText, queue:function(){return _ibTtsQueue;} };');
    const adapter = adapterFactory(adapterQueue, true, 0, function (bubble, button, onStatus, control) {
      return { id: ++adapterSessionSeq, bubble: bubble, button: button, onStatus: onStatus, control: control };
    }, function () { adapterCalls.push(Array.prototype.slice.call(arguments)); });
    const dmHost = { querySelector: function () { return null; } }, dmButton = {}, dmVoice = { provider: 'voicebox', voiceId: 'role-profile' };
    const replayControl = { cancelled: false }, cancelledControl = { cancelled: true };
    ok('J.roleDmVoiceAdapter.exposedOnExistingBridge', /speakText:\s*ibTtsSpeakText/.test(bridgeRaw));
    ok('J.roleDmVoiceAdapter.reusesTtsFlowWithoutPersistingChatVoice', adapter.speak('Role DM text only', dmVoice, dmHost, dmButton, function () {}) === true
      && adapter.queue().length === 0 && adapterCalls.length === 1
      && adapterCalls[0][0] === dmHost && adapterCalls[0][1] === dmButton
      && adapterCalls[0][2] === dmVoice && adapterCalls[0][5] === 'Role DM text only' && adapterCalls[0][6] === false);
    ok('J.roleDmVoiceAdapter.acceptsReplayCancellationControl', adapter.speak('Replay text', dmVoice, dmHost, dmButton, function () {}, replayControl) === true
      && adapterCalls.length === 2 && adapterCalls[1][7] === replayControl
      && adapter.speak('Cancelled replay', dmVoice, dmHost, dmButton, function () {}, cancelledControl) === false && adapterCalls.length === 2);
    const ttsImpl = sliceFunction(bridgeRaw, 'function _ibTtsSpeakImpl(');
    const playQueue = sliceFunction(bridgeRaw, 'function _ibTtsPlayQ(');
    ok('J.roleDmVoiceAdapter.persistenceGuardAndPlaybackStatusCallbacks',
      /persistVoice!==false/.test(ttsImpl) && /control&&control\.cancelled===true/.test(ttsImpl) && /reportStatus\('playing'\)/.test(playQueue)
        && /reportStatus\('ended'\)/.test(playQueue) && /reportStatus\('failed'\)/.test(playQueue));
  }

  /* ── K. 真实取源链路：真实 ibBridgeLoadAudio + 真实 http origin（跨 origin + 鉴权） ──
     这是 §A/§B/§C 的「真实网络」版本：不是 stub loader，而是生产 bridge.js 的函数体，
     在真实 localhost 端口上做真实 fetch → blob → objectURL，服务端回读 Authorization。 */
  pendingAsync.push(realLoaderIntegration());

  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

const pendingAsync = [];
function realLoaderIntegration() {
  const http = require('http');
  /* K1：loopback（无 token）→ loader 交回 Bridge **绝对**地址（跨 origin），
     且该地址真实可取；同一个相对路径在原页面 origin 上必然 404 —— 这正是原 Blocker。 */
  return (async () => {
    const page = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('page-origin-has-no-tts'); });
    const pagePort = await new Promise(res => page.listen(0, '127.0.0.1', () => res(page.address().port)));
    const srv = await startBridgeServer({ requireAuth: false });
    try {
      const real = makeRealLoader({ base: 'http://127.0.0.1:' + srv.port });
      const resolved = await new Promise(res => real.loadAudio('/tts/real.wav', (src, revoke) => res({ src, revoke }), () => res({ src: null })));
      ok('K1.realLoader.noToken.absoluteBridgeOrigin', resolved.src === 'http://127.0.0.1:' + srv.port + '/tts/real.wav', resolved.src);
      ok('K1.realLoader.noToken.notPageRelative', String(resolved.src).indexOf('/tts/') !== 0);
      ok('K1.realLoader.noToken.noObjectUrlToRevoke', resolved.revoke === false);
      /* 真实取回（模拟 Audio 元素会做的事）：Bridge origin 200，页面 origin 404 */
      const onBridge = await fetch(resolved.src);
      ok('K1.realLoader.bridgeOriginServesAudio', onBridge.ok && onBridge.status === 200, onBridge.status);
      ok('K1.realLoader.bridgeRequestReached', srv.requests.some(r => r.path === '/tts/real.wav'), JSON.stringify(srv.requests));
      const onPage = await fetch('http://127.0.0.1:' + pagePort + '/tts/real.wav');
      ok('K1.realLoader.pageOriginWould404', onPage.status === 404, onPage.status);
    } finally {
      await srv.close();
      await new Promise(res => page.close(res));
    }
  })().then(async () => {
    /* K2/K3：token 模式 → 真实 ibBridgeFetch 必须带 Authorization；服务端回读；
       再用真实 voice.js 编排把 blob URL 交给 Audio，端到端跑通 audioUrl→fetch→blob→Audio。 */
    const TOKEN = 'ib-test-token-' + Date.now();
    const srv = await startBridgeServer({ requireAuth: true, token: TOKEN });
    try {
      const real = makeRealLoader({ base: 'http://127.0.0.1:' + srv.port, token: TOKEN });
      const resolved = await new Promise(res => real.loadAudio('/tts/real.wav', (src, revoke) => res({ src, revoke }), () => res({ src: null })));
      ok('K2.realLoader.token.requestCarriedBearer', srv.requests.some(r => r.auth === 'Bearer ' + TOKEN), JSON.stringify(srv.requests.map(r => r.auth)));
      ok('K2.realLoader.token.servedAuthorized', resolved.src !== null);
      ok('K2.realLoader.token.srcIsBlobObjectUrl', /^blob:/.test(String(resolved.src)), resolved.src);
      ok('K2.realLoader.token.revokeTrueForBlob', resolved.revoke === true);

      const bad = makeRealLoader({ base: 'http://127.0.0.1:' + srv.port, token: 'wrong' });
      const badRes = await new Promise(res => bad.loadAudio('/tts/real.wav', src => res({ src }), () => res({ src: null })));
      ok('K2.realLoader.wrongToken.failsClosed', badRes.src === null);

      const v = VoiceCore.build({ audioUrl: '/tts/real.wav', mime: 'audio/wav', duration: 3, transcript: 'real' });
      const el = stubEl();
      const { rt, calls } = makeRuntime({ loader: real.loadAudio });
      let ended = 0;
      rt._vmTogglePlay(el, v, () => ended++);
      const played = await waitUntil(() => rt._audio(), 5000);
      ok('K3.chain.audioCreatedFromBlob', played && /^blob:/.test(String(rt._audio().src)), rt._audio() && rt._audio().src);
      ok('K3.chain.playingClassSet', el._classes.has('playing'));
      ok('K3.chain.notRawBridgePath', String(rt._audio() && rt._audio().src).indexOf('http://127.0.0.1:' + srv.port + '/tts/') !== 0);
      ok('K3.chain.objectUrlTracked', rt._objUrl() === (rt._audio() && rt._audio().src));
      if (rt._audio()) rt._audio().onended();
      ok('K3.chain.endedSignalled', ended === 1, ended);
      ok('K3.chain.objectUrlRevokedAfterEnd', calls.revoked.length >= 1, JSON.stringify(calls.revoked));
    } finally { await srv.close(); }
  });
}
run();
Promise.all(pendingAsync).then(() => {
  console.log(failCount === 0 ? '\n异步断言全部通过 ✔  (' + passCount + ')'
    : '\n异步阶段后：失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
});
