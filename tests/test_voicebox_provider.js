'use strict';

/* Internal Beyond · Voicebox Local Runtime 适配器专项测试（P23 Phase 1）。
 * 零依赖：直接驱动 bridge/voicebox.js + bridge/tts.js 的 Registry / normalizeVoiceProfile /
 * ttsSynthesize / listVoiceSources，并用本地 mock Voicebox REST 端点捕获请求，
 * 逐条验证上游 contract 的请求 shape、profile 解析、轮询、错误分类与「绝不改写文本」边界。
 * 不发起任何真实外网请求；最后一段用真实 Bridge 子进程验证 offline 不影响其它 TTS 路径。 */

const http = require('http');
const assert = require('assert');
const tls = require('tls');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const createTts = require(path.join(ROOT, 'bridge', 'tts'));
const createVoicebox = require(path.join(ROOT, 'bridge', 'voicebox'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(predicate, timeout = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

/* ─────────────────────────────────────────────────────────────────
   Mock Voicebox：只实现适配器真正调用的 4 个端点。
   行为由 state 控制，用于覆盖 success / 404 / 500 / malformed / failed。
   ───────────────────────────────────────────────────────────────── */
function startMockVoicebox(state) {
  const st = state || {};
  st.generateCalls = [];
  st.audioCalls = [];
  st.cancelCalls = [];
  st.healthCalls = 0;
  st.profileCalls = 0;
  st.pollCount = 0;
  st.profiles = st.profiles || [
    { id: 'prof-uuid-1', name: 'Morgan', language: 'en', voice_type: 'cloned', default_engine: 'qwen' },
    { id: 'prof-uuid-2', name: 'Scarlett', language: 'zh', voice_type: 'preset', default_engine: 'kokoro' }
  ];
  st.audioBytes = st.audioBytes || Buffer.from('RIFF0000WAVEfmt-fake-audio-bytes');
  st.audioMime = st.audioMime || 'audio/wav';
  st.duration = st.duration === undefined ? 3.42 : st.duration;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = String(req.url || '');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url === '/health') {
        st.healthCalls++;
        if (st.healthStatus) { res.writeHead(st.healthStatus, { 'Content-Type': 'text/plain' }); res.end('nope'); return; }
        return json(200, { status: 'healthy', model_loaded: true, gpu_available: true, gpu_type: 'CUDA (RTX)' });
      }
      if (url === '/profiles') {
        st.profileCalls++;
        const sendProfiles = () => { if (!res.destroyed) json(200, st.profiles); };
        if (st.profileDelayMs) { setTimeout(sendProfiles, st.profileDelayMs); return; }
        return sendProfiles();
      }
      if (url === '/generate' && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = null; }
        st.generateCalls.push({ url, method: req.method, ct: req.headers['content-type'] || '', body: parsed });
        if (st.generateStatus) { res.writeHead(st.generateStatus, { 'Content-Type': 'text/plain' }); res.end('boom'); return; }
        if (st.malformedGenerate) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"not":"a generation"}'); return; }
        if (st.generateNotJson) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>nope</html>'); return; }
        const sendGeneration = () => {
          if (!res.destroyed) json(200, { id: 'gen-' + st.generateCalls.length, profile_id: parsed.profile_id, status: 'generating', duration: 0 });
        };
        if (st.holdGenerate) { st.releaseGenerate = sendGeneration; return; }
        if (st.generateDelayMs) { setTimeout(sendGeneration, st.generateDelayMs); return; }
        return sendGeneration();
      }
      const cancel = url.match(/^\/generate\/([^/]+)\/cancel$/);
      if (cancel && req.method === 'POST') {
        st.cancelCalls.push(decodeURIComponent(cancel[1]));
        if (st.cancelStatus) { res.writeHead(st.cancelStatus, { 'Content-Type': 'text/plain' }); res.end(st.cancelStatus === 409 ? 'already completed' : 'cancel unavailable'); return; }
        return json(200, { id: decodeURIComponent(cancel[1]), status: 'cancelled' });
      }
      const hist = url.match(/^\/history\/([^/]+)$/);
      if (hist) {
        st.pollCount++;
        if (st.failedGeneration) return json(200, { id: hist[1], status: 'failed', error: st.failedGeneration });
        if (st.neverCompletes) return json(200, { id: hist[1], status: 'generating', duration: 0 });
        if (st.pollUntil && st.pollCount < st.pollUntil) return json(200, { id: hist[1], status: 'loading_model', duration: 0 });
        return json(200, { id: hist[1], status: 'completed', duration: st.duration, audio_path: 'generations/' + hist[1] + '.wav', engine: 'qwen' });
      }
      const aud = url.match(/^\/audio\/([^/]+)$/);
      if (aud) {
        st.audioCalls.push(aud[1]);
        if (st.audioStatus) { res.writeHead(st.audioStatus, { 'Content-Type': 'text/plain' }); res.end('gone'); return; }
        if (st.emptyAudio) { res.writeHead(200, { 'Content-Type': st.audioMime }); res.end(''); return; }
        const sendAudio = () => {
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': st.audioMime });
          res.end(st.audioBytes);
        };
        if (st.holdAudio) { st.releaseAudio = sendAudio; return; }
        if (st.audioDelayMs) { setTimeout(sendAudio, st.audioDelayMs); return; }
        sendAudio();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'not found' }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state: st }));
  });
}

function makeTts(cfg, voiceboxInstance) {
  const ttsDir = cfg.__ttsDir;
  return createTts({ config: cfg, uid: p => p + '_uid' + Math.floor(Math.random() * 1e6), ttsDir, ttsVoices: { getRefAudioMeta: () => null }, voicebox: voiceboxInstance });
}

function voiceboxConfig(endpoint) {
  return { tts: {}, ttsMimo: {}, voicebox: { enabled: true, endpoint } };
}

async function main() {
  console.log('== Internal Beyond · Voicebox Local Runtime 适配器测试 ==');

  /* ── A. Registry / 常量：默认地址与 engine 清单只有一份 ── */
  {
    const src = fs.readFileSync(path.join(ROOT, 'bridge', 'voicebox.js'), 'utf8');
    ok('A.defaultEndpoint.17493', createVoicebox.DEFAULT_ENDPOINT === 'http://127.0.0.1:17493', createVoicebox.DEFAULT_ENDPOINT);
    /* 默认端点全仓库只允许出现在 voicebox.js 一处（config.json 的 voicebox.endpoint 默认留空，
       运行期回落到这里）—— 两处声明会漂移，且会让「唯一权威」的断言形同虚设。 */
    const litHits = [];
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'target' || e.name.startsWith('.')) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        if (!/\.(js|html|css)$/.test(e.name)) return;
        if (full.replace(/\\/g, '/').indexOf('/tests/') > -1) return;   /* 测试自身不算生产声明 */
        if (fs.readFileSync(full, 'utf8').indexOf('127.0.0.1:17493') > -1) litHits.push(path.relative(ROOT, full));
      });
    })(ROOT);
    ok('A.defaultEndpoint.singleOccurrenceRepoWide', litHits.length === 1 && /voicebox\.js$/.test(litHits[0]), JSON.stringify(litHits));
    ok('A.defaultEndpoint.configDefaultIsEmpty', !/endpoint:\s*'http:\/\/127/.test(fs.readFileSync(path.join(ROOT, 'bridge', 'config.js'), 'utf8')));
    ok('A.engines.noUpstreamEnumDuplication', Array.isArray(createVoicebox.ENGINES) && createVoicebox.ENGINES.indexOf('chatterbox_turbo') > -1 && createVoicebox.ENGINES.length === 7, JSON.stringify(createVoicebox.ENGINES));
    const repoFiles = ['bridge/tts.js', 'assets/js/social.js', 'assets/js/bridge.js'];
    let dup = '';
    repoFiles.forEach(f => {
      const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (t.indexOf('chatterbox_turbo') > -1) dup += f + ' ';
    });
    ok('A.engines.notDuplicatedElsewhere', dup === '', 'engine 枚举还出现在: ' + dup);
  }

  const ttsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-voicebox-'));
  const cfg0 = voiceboxConfig('http://127.0.0.1:1');
  cfg0.__ttsDir = ttsDir;
  const vb0 = createVoicebox({ config: cfg0 });

  /* ── B. Registry 形态 ── */
  {
    const t = makeTts(cfg0, vb0);
    const sources = t.listVoiceSources();
    const vb = sources.filter(s => s.id === 'voicebox')[0];
    ok('B.source.listed', !!vb, JSON.stringify(sources.map(s => s.id)));
    ok('B.source.capabilities', vb && vb.capabilities.builtin === true && vb.capabilities.clone === false && vb.capabilities.design === false && vb.capabilities.style === true && vb.capabilities.language === true && vb.capabilities.prosody === false, JSON.stringify(vb && vb.capabilities));
    ok('B.source.isLocal', vb && vb.isLocal === true);
    ok('B.source.credentialIsDescriptor', vb && vb.credential === 'local-runtime');
    ok('B.source.modelsAreEngines', vb && vb.models.length === 7 && vb.models.indexOf('qwen') > -1);
    /* 目录里绝不能出现 credential 值本身的字段 */
    const dump = JSON.stringify(sources);
    ok('B.source.noSecretFields', !/apiKey|api_key|token|secret|authorization|bearer/i.test(dump), dump);
    ok('B.source.allFourPresent', sources.length === 4 && sources.map(s => s.id).sort().join(',') === 'edge,tts,ttsMimo,voicebox', JSON.stringify(sources.map(s => s.id)));
    ok('B.source.legacyProvidersIntact', !!t.normalizeVoiceProfile({ text: 'x', provider: 'edge' }).provider);
  }

  /* ── C. Source → provider 解析（canonical source 引用） ── */
  {
    const t = makeTts(cfg0, vb0);
    const bySource = t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'p1' });
    ok('C.source.voiceboxToProvider', bySource.provider === 'voicebox' && bySource.source === 'voicebox', JSON.stringify([bySource.provider, bySource.source]));
    const ttsSrc = t.normalizeVoiceProfile({ text: 'x', source: 'tts' });
    ok('C.source.ttsToOpenai', ttsSrc.provider === 'openai' && ttsSrc.source === 'tts', JSON.stringify([ttsSrc.provider, ttsSrc.source]));
    const mimoSrc = t.normalizeVoiceProfile({ text: 'x', source: 'ttsMimo' });
    ok('C.source.ttsMimoToMimo', mimoSrc.provider === 'mimo' && mimoSrc.source === 'ttsMimo', JSON.stringify([mimoSrc.provider, mimoSrc.source]));
    const edgeSrc = t.normalizeVoiceProfile({ text: 'x', source: 'edge' });
    ok('C.source.edgeToEdge', edgeSrc.provider === 'edge' && edgeSrc.source === 'edge', JSON.stringify([edgeSrc.provider, edgeSrc.source]));
    /* 历史 wire 参数（只有 provider）：source 由 provider 反推，provider 行为逐字不变 */
    const legacy = t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceId: 'Chloe' });
    ok('C.legacy.providerWinsAndSourceDerived', legacy.provider === 'mimo' && legacy.source === 'ttsMimo' && legacy.voice.id === 'Chloe', JSON.stringify(legacy));
    /* 未知 source：不崩、不猜新 provider，回落历史缺省规则（tts 未配 ⇒ edge） */
    const bogus = t.normalizeVoiceProfile({ text: 'x', source: 'nope-not-a-source' });
    ok('C.unknown.sourceFallsBack', bogus.provider === 'edge' && bogus.source === 'edge', JSON.stringify([bogus.provider, bogus.source]));
    /* 未配置 tts 时，无 provider / 无 source ⇒ edge（历史行为） */
    const bare = t.normalizeVoiceProfile({ text: 'x' });
    ok('C.bare.legacyDefaultEdge', bare.provider === 'edge', bare.provider);
    const withTts = makeTts({ tts: { enabled: true, endpoint: 'http://127.0.0.1:1/v1/audio/speech', apiKey: 'k' }, ttsMimo: {}, voicebox: { enabled: true, endpoint: 'http://127.0.0.1:1' }, __ttsDir: ttsDir }, vb0);
    ok('C.bareWithOpenaiConfigured.legacyDefaultOpenai', withTts.normalizeVoiceProfile({ text: 'x' }).provider === 'openai');
  }

  /* ── D. Endpoint 解析：可配置、可被环境变量覆盖 ── */
  {
    const c = { voicebox: { enabled: true, endpoint: 'http://127.0.0.1:19999/' } };
    const v = createVoicebox({ config: c });
    ok('D.endpoint.configWins+tralingSlashStripped', v.endpoint() === 'http://127.0.0.1:19999', v.endpoint());
    const prev = process.env.IB_VOICEBOX_ENDPOINT;
    delete process.env.IB_VOICEBOX_ENDPOINT;
    const v3 = createVoicebox({ config: {} });
    ok('D.endpoint.defaultWhenNothingSet', v3.endpoint() === 'http://127.0.0.1:17493', v3.endpoint());
    process.env.IB_VOICEBOX_ENDPOINT = 'http://127.0.0.1:18888';
    const v2 = createVoicebox({ config: { voicebox: {} } });
    ok('D.endpoint.envOverride', v2.endpoint() === 'http://127.0.0.1:18888', v2.endpoint());
    if (prev === undefined) delete process.env.IB_VOICEBOX_ENDPOINT; else process.env.IB_VOICEBOX_ENDPOINT = prev;
  }

  /* ── E. 请求 contract：POST /generate 的 shape 与「IB 是说什么的 authority」 ── */
  {
    const mock = await startMockVoicebox({ pollUntil: 2 });
    const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port);
    cfg.__ttsDir = ttsDir;
    const vb = createVoicebox({ config: cfg });
    const t = makeTts(cfg, vb);

    const r = await t.ttsSynthesize(t.normalizeVoiceProfile({
      text: '这是 IB 决定的文本，Voicebox 不得改写。',
      source: 'voicebox', voiceId: 'Morgan', model: 'qwen', language: 'zh', style: '轻声一点'
    }));
    ok('E.success.ok', r.ok === true, JSON.stringify(r));
    ok('E.success.url', String(r.url || '').indexOf('/tts/') === 0 && /\.wav$/.test(String(r.url)), r.url);
    ok('E.success.bytes', Number(r.bytes) > 0);
    ok('E.success.ext/mime', r.ext === 'wav' && r.mime === 'audio/wav', JSON.stringify([r.ext, r.mime]));
    ok('E.success.durationFromHistory', r.duration === 3.42, r.duration);

    const call = mock.state.generateCalls[0];
    ok('E.request.oneCall', mock.state.generateCalls.length === 1 && call.method === 'POST' && call.url === '/generate');
    ok('E.request.ct', call.ct.indexOf('application/json') === 0);
    ok('E.request.profileResolvedToId', call.body.profile_id === 'prof-uuid-1', JSON.stringify(call.body));
    ok('E.request.textVerbatim', call.body.text === '这是 IB 决定的文本，Voicebox 不得改写。', call.body.text);
    ok('E.request.personalityHardFalse', call.body.personality === false, JSON.stringify(call.body.personality));
    ok('E.request.enginePassed', call.body.engine === 'qwen', call.body.engine);
    ok('E.request.languagePassed', call.body.language === 'zh', call.body.language);
    ok('E.request.styleToInstruct', call.body.instruct === '轻声一点', call.body.instruct);
    ok('E.request.noCredentialShape', !/apikey|api_key|authorization|bearer|token/i.test(JSON.stringify(call.body)), JSON.stringify(call.body));
    ok('E.poll.untilCompleted', mock.state.pollCount === 2, mock.state.pollCount);
    ok('E.audio.fetchedOnce', mock.state.audioCalls.length === 1 && mock.state.audioCalls[0] === 'gen-1', JSON.stringify(mock.state.audioCalls));
    await new Promise(r2 => mock.server.close(r2));
  }

  /* ── F. Profile 解析：id 或 name（大小写不敏感）；engine 留空则不发 ── */
  {
    const mock = await startMockVoicebox({});
    const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port);
    cfg.__ttsDir = ttsDir;
    const t = makeTts(cfg, createVoicebox({ config: cfg }));
    await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'scarlett' }));
    const b = mock.state.generateCalls[0].body;
    ok('F.profileNameCaseInsensitive', b.profile_id === 'prof-uuid-2', JSON.stringify(b));
    ok('F.engineOmittedWhenEmpty', !('engine' in b), JSON.stringify(b));
    ok('F.languageOmittedWhenEmpty', !('language' in b), JSON.stringify(b));
    ok('F.instructOmittedWhenEmpty', !('instruct' in b), JSON.stringify(b));
    await new Promise(r2 => mock.server.close(r2));
  }

  /* ── G. 本地失败：不发请求 ── */
  {
    const mock = await startMockVoicebox({});
    const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port);
    cfg.__ttsDir = ttsDir;
    const t = makeTts(cfg, createVoicebox({ config: cfg }));
    const noVoice = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox' }));
    ok('G.noProfile.localFailure', noVoice.ok === false && noVoice.error.indexOf('Voice Profile') > -1, noVoice.error);
    const unknown = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'no-such-profile' }));
    ok('G.unknownProfile.localFailure', unknown.ok === false && unknown.error.indexOf('未找到') > -1, unknown.error);
    ok('G.localFailure.noGenerateCall', mock.state.generateCalls.length === 0, mock.state.generateCalls.length);
    ok('G.localFailure.noAudioCall', mock.state.audioCalls.length === 0);
    /* 空文本沿用统一入口的既有语义 */
    const empty = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '   ', source: 'voicebox', voiceId: 'Morgan' }));
    ok('G.emptyText', empty.ok === false && empty.error === 'No text to speak', empty.error);
    /* 适配器未注入 ⇒ 可见失败，绝不静默回落别的 provider */
    const tNoVb = makeTts(cfg, null);
    const noAdapter = await tNoVb.ttsSynthesize(tNoVb.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
    ok('G.noAdapter.visibleFailure', noAdapter.ok === false && noAdapter.error.indexOf('not configured') > -1, noAdapter.error);
    /* enabled:false ⇒ 明确提示，不发请求 */
    const cfgOff = voiceboxConfig('http://127.0.0.1:' + mock.port); cfgOff.voicebox.enabled = false; cfgOff.__ttsDir = ttsDir;
    const tOff = makeTts(cfgOff, createVoicebox({ config: cfgOff }));
    const disabled = await tOff.ttsSynthesize(tOff.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
    ok('G.disabled.visibleFailure', disabled.ok === false && disabled.error.indexOf('未启用') > -1, disabled.error);
    await new Promise(r2 => mock.server.close(r2));
  }

  /* ── H. 错误分类：HTTP / malformed / failed / offline / 空音频 ── */
  {
    async function withMock(state, fn) {
      const mock = await startMockVoicebox(state);
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port);
      cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      try { await fn(t, mock); } finally { await new Promise(r2 => mock.server.close(r2)); }
    }

    await withMock({ generateStatus: 500 }, async (t) => {
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
      ok('H.http500', r.ok === false && r.error.indexOf('HTTP 500') > -1, r.error);
    });
    await withMock({ generateNotJson: true }, async (t) => {
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
      ok('H.malformedJson', r.ok === false && r.error.indexOf('malformed') > -1, r.error);
    });
    await withMock({ malformedGenerate: true }, async (t) => {
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
      ok('H.missingGenerationId', r.ok === false && r.error.indexOf('generation id') > -1, r.error);
    });
    await withMock({ failedGeneration: 'CUDA out of memory' }, async (t) => {
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
      ok('H.generationFailed', r.ok === false && r.error.indexOf('CUDA out of memory') > -1, r.error);
    });
    await withMock({ audioStatus: 404 }, async (t) => {
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
      ok('H.audio404', r.ok === false && r.error.indexOf('/audio') > -1 && r.error.indexOf('404') > -1, r.error);
    });
    await withMock({ emptyAudio: true }, async (t) => {
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
      ok('H.emptyAudio', r.ok === false && r.error.indexOf('空音频') > -1, r.error);
    });
    await withMock({ healthStatus: 500 }, async (t, mock) => {
      const h = await createVoicebox({ config: voiceboxConfig('http://127.0.0.1:' + mock.port) }).health();
      ok('H.healthHttpError', h.ok === false && h.error.indexOf('HTTP 500') > -1, h.error);
    });
    /* 连接被拒绝：可见的「未连接」，不是静默 */
    {
      const cfg = voiceboxConfig('http://127.0.0.1:1');
      cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'Morgan' }));
      ok('H.offline.visibleFailure', r.ok === false && r.error.indexOf('未连接') > -1, r.error);
      const h = await createVoicebox({ config: cfg }).health();
      ok('H.offline.healthFalse', h.ok === false);
      const p = await createVoicebox({ config: cfg }).profiles();
      ok('H.offline.profilesFalse', p.ok === false);
    }
    /* 轮询超时：把生成永远停在 generating，适配器必须在有限时间内失败 */
    {
      const mock = await startMockVoicebox({ neverCompletes: true });
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port);
      const vb = createVoicebox({ config: cfg });
      const src = fs.readFileSync(path.join(ROOT, 'bridge', 'voicebox.js'), 'utf8');
      ok('H.pollTimeout.declared', /GENERATE_TIMEOUT_MS\s*=\s*\d+/.test(src));
      /* 不等待真实 180s：只断言状态机对非终态持续轮询且不误判成功 */
      const race = await Promise.race([
        vb.synthesize({ text: 'x', voice: { id: 'Morgan' } }, () => ({ ok: true })),
        sleep(2500).then(() => 'still-running')
      ]);
      ok('H.pollTimeout.noFalseSuccess', race === 'still-running' && mock.state.pollCount >= 2, JSON.stringify([race, mock.state.pollCount]));
      await new Promise(r2 => mock.server.close(r2));
    }
  }

  /* ── J. Provider cancellation races: local HTTP mock only; no Voicebox runtime/model ── */
  {
    const profile = { text: 'cancel me', source: 'voicebox', voiceId: 'Morgan' };
    const artifactCount = () => fs.readdirSync(ttsDir).filter(name => /^tts_/.test(name)).length;

    /* Race A: abort while /generate is pending. Keep the bounded handshake alive,
       capture the accepted ID, then cancel without polling or saving audio. */
    {
      const mock = await startMockVoicebox({ holdGenerate: true });
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port); cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      const controller = new AbortController();
      const diagnostics = [];
      const before = artifactCount();
      const pending = t.ttsSynthesize(t.normalizeVoiceProfile(profile), {
        signal: controller.signal, callId: 'call-A', sessionId: 'session-A', generationId: 4,
        sentenceId: 1, requestId: 'request-A', onDiagnostic: d => diagnostics.push(d)
      });
      await waitFor(() => mock.state.generateCalls.length === 1);
      controller.abort();
      const result = await pending;
      ok('J.raceA.returnedCancelledBeforeLateId', result.cancelled === true && result.ok === false, JSON.stringify(result));
      ok('J.raceA.noPollingOrAudio', mock.state.pollCount === 0 && mock.state.audioCalls.length === 0);
      ok('J.raceA.noBridgeArtifact', artifactCount() === before);
      mock.state.releaseGenerate();
      await waitFor(() => mock.state.cancelCalls.length === 1);
      ok('J.raceA.lateIdCancelled', mock.state.cancelCalls[0] === 'gen-1' && mock.state.pollCount === 0, JSON.stringify(mock.state.cancelCalls));
      await waitFor(() => diagnostics.some(d => d.event === 'cancel_acknowledged'));
      await new Promise(resolve => mock.server.close(resolve));
    }

    /* Abort after the ID is captured but before polling starts. */
    {
      const mock = await startMockVoicebox({});
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port); cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      const controller = new AbortController();
      const diagnostics = [];
      const before = artifactCount();
      const result = await t.ttsSynthesize(t.normalizeVoiceProfile(profile), {
        signal: controller.signal, callId: 'call-B', sessionId: 'session-B', generationId: 5,
        sentenceId: 1, requestId: 'request-B', onDiagnostic: d => {
          diagnostics.push(d);
          if (d.event === 'generation_created') controller.abort();
        }
      });
      await waitFor(() => mock.state.cancelCalls.length === 1);
      ok('J.raceB.abortAfterIdNoPoll', result.cancelled === true && mock.state.pollCount === 0 && mock.state.audioCalls.length === 0);
      ok('J.raceB.cancelAcknowledged', diagnostics.some(d => d.event === 'cancel_acknowledged'));
      ok('J.raceB.noBridgeArtifact', artifactCount() === before);
      await new Promise(resolve => mock.server.close(resolve));
    }

    /* Abort during polling exits without the next 400 ms wait and is a stream cancel,
       not an onError. */
    {
      const mock = await startMockVoicebox({ neverCompletes: true });
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port); cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      const controller = new AbortController();
      const before = artifactCount();
      let cancelled = 0, errors = 0;
      const streaming = t.streamSynthesize(t.normalizeVoiceProfile(profile), {
        signal: controller.signal, callId: 'call-C', sessionId: 'session-C', generationId: 6,
        sentenceId: 1, requestId: 'request-C'
      }, { onCancel: () => cancelled++, onError: () => errors++ });
      await waitFor(() => mock.state.pollCount > 0);
      controller.abort();
      await streaming;
      await waitFor(() => mock.state.cancelCalls.length === 1);
      const pollsAtReturn = mock.state.pollCount;
      await sleep(30);
      ok('J.raceC.pollAbortNoNextPoll', mock.state.pollCount === pollsAtReturn);
      ok('J.raceC.cancelNotError', cancelled === 1 && errors === 0, JSON.stringify({ cancelled, errors }));
      ok('J.raceC.noAudioOrBridgeArtifact', mock.state.audioCalls.length === 0 && artifactCount() === before);
      await new Promise(resolve => mock.server.close(resolve));
    }

    /* Race C: upstream generation is complete but audio is still being downloaded.
       Even an already-completed cancel response remains logically cancelled. */
    {
      const mock = await startMockVoicebox({ holdAudio: true, cancelStatus: 409 });
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port); cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      const controller = new AbortController();
      const diagnostics = [];
      const before = artifactCount();
      const pending = t.ttsSynthesize(t.normalizeVoiceProfile(profile), {
        signal: controller.signal, callId: 'call-D', sessionId: 'session-D', generationId: 7,
        sentenceId: 1, requestId: 'request-D', onDiagnostic: d => diagnostics.push(d)
      });
      await waitFor(() => mock.state.audioCalls.length === 1);
      controller.abort();
      const result = await pending;
      await waitFor(() => mock.state.cancelCalls.length === 1);
      await waitFor(() => diagnostics.some(d => d.event === 'cancel_failed'));
      ok('J.raceD.alreadyCompletedStillCancelled', result.cancelled === true && diagnostics.some(d => d.event === 'cancel_failed' && d.status === 409));
      ok('J.raceD.audioNotPersisted', artifactCount() === before);
      if (mock.state.releaseAudio) mock.state.releaseAudio();
      await new Promise(resolve => mock.server.close(resolve));
    }

    /* Race D: cancellation endpoint failure is diagnostic only; stale safety holds. */
    {
      const mock = await startMockVoicebox({ neverCompletes: true, cancelStatus: 500 });
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port); cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      const controller = new AbortController();
      const diagnostics = [];
      const before = artifactCount();
      const pending = t.ttsSynthesize(t.normalizeVoiceProfile(profile), {
        signal: controller.signal, callId: 'call-E', sessionId: 'session-E', generationId: 8,
        sentenceId: 1, requestId: 'request-E', onDiagnostic: d => diagnostics.push(d)
      });
      await waitFor(() => mock.state.pollCount > 0);
      controller.abort();
      const result = await pending;
      await waitFor(() => diagnostics.some(d => d.event === 'cancel_failed'));
      ok('J.raceE.failureStillCancelled', result.cancelled === true && mock.state.audioCalls.length === 0);
      ok('J.raceE.cancelFailureDiagnosticSafe', diagnostics.some(d => d.event === 'cancel_failed' && d.stage === 'cancel'));
      ok('J.raceE.noBridgeArtifact', artifactCount() === before);
      await new Promise(resolve => mock.server.close(resolve));
    }

    /* Per-request identity: cancelling call A must not cancel call B in the same
       Voicebox runtime/adapter instance. */
    {
      const mock = await startMockVoicebox({ neverCompletes: true });
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port); cfg.__ttsDir = ttsDir;
      const t = makeTts(cfg, createVoicebox({ config: cfg }));
      const a = new AbortController(), b = new AbortController();
      const before = artifactCount();
      const pendingA = t.ttsSynthesize(t.normalizeVoiceProfile(profile), {
        signal: a.signal, callId: 'call-A', sessionId: 'session-A', generationId: 10,
        sentenceId: 1, requestId: 'request-A'
      });
      const pendingB = t.ttsSynthesize(t.normalizeVoiceProfile(profile), {
        signal: b.signal, callId: 'call-B', sessionId: 'session-B', generationId: 2,
        sentenceId: 1, requestId: 'request-B'
      });
      await waitFor(() => mock.state.generateCalls.length === 2 && mock.state.pollCount >= 2);
      a.abort();
      const resultA = await pendingA;
      await waitFor(() => mock.state.cancelCalls.length === 1);
      const bStillRunning = await Promise.race([pendingB.then(() => 'settled'), sleep(30).then(() => 'pending')]);
      ok('J.requestIdentity.cancelAOnly', resultA.cancelled === true && bStillRunning === 'pending' &&
        mock.state.cancelCalls[0] === 'gen-1' && mock.state.cancelCalls.indexOf('gen-2') === -1, JSON.stringify(mock.state.cancelCalls));
      b.abort();
      const resultB = await pendingB;
      await waitFor(() => mock.state.cancelCalls.length === 2);
      ok('J.requestIdentity.cancelBSeparately', resultB.cancelled === true && mock.state.cancelCalls.indexOf('gen-2') !== -1);
      ok('J.requestIdentity.noArtifacts', artifactCount() === before);
      await new Promise(resolve => mock.server.close(resolve));
    }

    /* Timeout is a provider failure, distinct from caller cancellation. */
    {
      const mock = await startMockVoicebox({ profileDelayMs: 100 });
      const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port); cfg.__ttsDir = ttsDir;
      const vb = createVoicebox({ config: cfg, timeouts: { requestMs: 20 } });
      const result = await vb.synthesize({ text: 'x', voice: { id: 'Morgan' } }, () => ({ ok: true }));
      ok('J.timeoutNotCancelled', result.ok === false && result.cancelled !== true && result.error.indexOf('请求超时') !== -1, JSON.stringify(result));
      await sleep(110);
      await new Promise(resolve => mock.server.close(resolve));
    }

    /* A provider without cancellation remains compatible: OpenAI finishes its
       in-flight request, while the contract reports cancellation unsupported. */
    {
      let received = false;
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          received = true;
          setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
            res.end(Buffer.from('openai-audio'));
          }, 60);
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const cfg = {
        tts: { enabled: true, endpoint: 'http://127.0.0.1:' + server.address().port + '/speech', apiKey: 'test-key' },
        ttsMimo: {}, voicebox: {}, __ttsDir: ttsDir
      };
      const t = makeTts(cfg, null);
      const controller = new AbortController();
      const diagnostics = [];
      const pending = t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'ordinary chat', source: 'tts' }), {
        signal: controller.signal, onDiagnostic: d => diagnostics.push(d)
      });
      await waitFor(() => received);
      controller.abort();
      const result = await pending;
      ok('J.providerWithoutCancellationRemainsCompatible', result.ok === true && result.cancelled !== true);
      ok('J.providerWithoutCancellationDiagnostic', diagnostics.some(d => d.event === 'cancel_unsupported' && d.provider === 'openai'));
      await new Promise(resolve => server.close(resolve));
    }

    /* Edge's true frame-stream path remains intact. Fake the TLS/WebSocket peer so
       this regression check is local and deterministic. */
    {
      const originalConnect = tls.connect;
      const t = makeTts({ tts: {}, ttsMimo: {}, voicebox: {}, __ttsDir: ttsDir }, null);
      const controller = new AbortController();
      const chunks = [], diagnostics = [];
      tls.connect = (options, onSecureConnect) => {
        const socket = new EventEmitter();
        socket.destroyed = false;
        socket.write = data => {
          if (typeof data === 'string') {
            setImmediate(() => socket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n')));
          } else {
            setImmediate(() => {
              const audio = Buffer.from([0x82, 0x02, 0x41, 0x42]);
              const terminal = Buffer.from('Path:turn.end');
              const end = Buffer.concat([Buffer.from([0x81, terminal.length]), terminal]);
              socket.emit('data', Buffer.concat([audio, end]));
            });
          }
          return true;
        };
        socket.end = () => { setImmediate(() => socket.emit('close')); };
        socket.destroy = () => { socket.destroyed = true; setImmediate(() => socket.emit('close')); };
        setImmediate(() => onSecureConnect.call(socket));
        return socket;
      };
      try {
        await t.streamSynthesize(t.normalizeVoiceProfile({ text: 'edge smoke', source: 'edge' }), {
          signal: controller.signal, onDiagnostic: d => diagnostics.push(d)
        }, { onChunk: (buf, mime) => chunks.push({ buf, mime }), onDone: () => {}, onError: err => { throw new Error(err); } });
        ok('J.edgeTrueFrameStreamUnaffected', chunks.length === 1 && chunks[0].buf.toString('utf8') === 'AB' && chunks[0].mime === 'audio/mpeg');
        ok('J.edgeNormalStreamNoCancellationNoise', diagnostics.length === 0);
      } finally {
        tls.connect = originalConnect;
      }
    }
  }

  /* ── I. 兼容：Test Voice 与生产共用同一个 adapter（同一个 ttsSynthesize 入口） ── */
  {
    const mock = await startMockVoicebox({});
    const cfg = voiceboxConfig('http://127.0.0.1:' + mock.port);
    cfg.__ttsDir = ttsDir;
    const t = makeTts(cfg, createVoicebox({ config: cfg }));
    await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '生产路径', source: 'voicebox', voiceId: 'Morgan' }));
    await t.ttsGenerate('Test Voice 路径', 'Morgan', 'voicebox');
    ok('I.singleAdapter.bothPathsReachVoicebox', mock.state.generateCalls.length === 2, mock.state.generateCalls.length);
    ok('I.singleAdapter.legacyWrapperMapsVoiceToProfile', mock.state.generateCalls[1].body.profile_id === 'prof-uuid-1', JSON.stringify(mock.state.generateCalls[1].body));
    ok('I.singleAdapter.sameShape', Object.keys(mock.state.generateCalls[0].body).sort().join(',') === Object.keys(mock.state.generateCalls[1].body).sort().join(','),
      Object.keys(mock.state.generateCalls[0].body).sort().join(',') + ' vs ' + Object.keys(mock.state.generateCalls[1].body).sort().join(','));
    await new Promise(r2 => mock.server.close(r2));
  }

  /* ── J. 真实 Bridge 子进程集成：offline 不污染其它 TTS / 目录不含 secret ── */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-bridge-vb-'));
    /* voicebox 指向一个必然连不上的端口；tts 指向本地 mock OpenAI TTS */
    let openaiHit = 0;
    const mockOpenai = http.createServer((req, res) => {
      let b = ''; req.on('data', c => { b += c; });
      req.on('end', () => { openaiHit++; void b; res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from('MP3FAKE')); });
    });
    await new Promise(r => mockOpenai.listen(0, '127.0.0.1', r));
    const oaPort = mockOpenai.address().port;
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      voicebox: { enabled: true, endpoint: 'http://127.0.0.1:1' },
      tts: { enabled: true, endpoint: 'http://127.0.0.1:' + oaPort + '/v1/audio/speech', apiKey: 'openai-secret-key', model: 'tts-1', voice: 'alloy' }
    }, null, 2), 'utf8');
    const port = 23000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, [path.join(ROOT, 'services', 'ib-bridge-service.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { IB_BRIDGE_PORT: String(port), IB_BRIDGE_HOST: '127.0.0.1', IB_BRIDGE_DATA_DIR: dataDir }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let healthy = false;
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) { healthy = true; break; } } catch (e) { /* retry */ } await sleep(200); }
    ok('J.bridge.healthy', healthy);
    try {
      /* 1) source 目录：四个来源，credential 只是说明，绝无密钥值 */
      const srcRes = await (await fetch('http://127.0.0.1:' + port + '/api/tts/sources')).json();
      ok('J.sources.ok', srcRes.ok === true && Array.isArray(srcRes.sources) && srcRes.sources.length === 4, JSON.stringify(srcRes).slice(0, 200));
      ok('J.sources.noSecretLeak', JSON.stringify(srcRes).indexOf('openai-secret-key') === -1 && !/apiKey/i.test(JSON.stringify(srcRes.sources)));
      ok('J.sources.ttsConfiguredTrue', srcRes.sources.filter(s => s.id === 'tts')[0].configured === true);
      ok('J.sources.voiceboxListed', srcRes.sources.filter(s => s.id === 'voicebox')[0].isLocal === true);

      /* 2) Voicebox offline：状态接口可见失败，不是 500 也不是假成功 */
      const hRes = await fetch('http://127.0.0.1:' + port + '/api/tts/voicebox/health');
      const hJson = await hRes.json();
      ok('J.voiceboxHealth.offlineVisible', hRes.status === 200 && hJson.ok === false && String(hJson.error).indexOf('未连接') > -1, JSON.stringify(hJson));
      const pRes = await fetch('http://127.0.0.1:' + port + '/api/tts/voicebox/profiles');
      const pJson = await pRes.json();
      ok('J.voiceboxProfiles.offlineVisible', pRes.status === 200 && pJson.ok === false, JSON.stringify(pJson));

      /* 3) offline 下选 voicebox 的角色：可见失败，绝不回落别的 provider */
      const vbTts = await (await fetch('http://127.0.0.1:' + port + '/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi', source: 'voicebox', voiceId: 'Morgan' })
      })).json();
      ok('J.voiceboxSynth.offlineFailsVisible', vbTts.ok === false && String(vbTts.error).indexOf('未连接') > -1, JSON.stringify(vbTts));
      ok('J.voiceboxSynth.noFallbackToOpenai', openaiHit === 0, openaiHit);

      /* 4) 旧 TTS 路径完全不受影响 */
      const oaTts = await (await fetch('http://127.0.0.1:' + port + '/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', provider: 'openai', voice: 'alloy' })
      })).json();
      ok('J.openai.unaffected', oaTts.ok === true && openaiHit === 1 && String(oaTts.url).indexOf('/tts/') === 0, JSON.stringify(oaTts));
      /* 5) 合成音频可被取回（wav 扩展名的新路由） */
      const wav = await fetch('http://127.0.0.1:' + port + '/tts/fake.wav');
      const mp3 = await fetch('http://127.0.0.1:' + port + '/tts/' + String(oaTts.url).split('/').pop());
      ok('J.ttsAudio.mp3Served', mp3.status === 200 && (mp3.headers.get('content-type') || '').indexOf('audio/mpeg') === 0);
      ok('J.ttsAudio.wavRouteRejects404', wav.status === 404, wav.status);
      /* 6) 目录路由不接受非法文件名（回归保护：wav 不能打开遍历面） */
      const bad = await fetch('http://127.0.0.1:' + port + '/tts/..%2Fconfig.json');
      ok('J.ttsAudio.traversalStillRejected', bad.status === 400 || bad.status === 404, bad.status);
    } finally {
      try { child.kill(); } catch (e) { /* 忽略 */ }
      await new Promise(r => mockOpenai.close(r));
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  }

  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
  try { fs.rmSync(ttsDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

main().catch(e => { console.error('test_voicebox_provider fatal:', e && e.stack || e); process.exit(1); });
