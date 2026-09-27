'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const createAsr = require('../bridge/asr');
const createRoutes = require('../bridge/routes');
const createVoiceRuntime = require('../bridge/voice-runtime');

const BASE = 'http://127.0.0.1:17493';
const voicebox = { endpoint: () => BASE, isEnabled: () => true };

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function makeAsr() {
  return createAsr({ voiceAsr: {
    enabled: true,
    provider: 'voicebox',
    voiceboxModel: 'base',
    language: 'zh',
    maxAudioBytes: 1024,
    timeoutMs: 5000
  } }, { voicebox });
}

function makeRoutes(asr, authorize) {
  return createRoutes({
    config: { voiceAsr: {} },
    LAN_EXPOSED: false, configInvalid: false, SERVER_NAME: 'test', VERSION: 'test',
    HOST: '127.0.0.1', PORT: 0, BIND_HOST: '127.0.0.1', DATA_DIR: '', STICKER_DIR: '',
    maxBody: 8 * 1024 * 1024, wsSockets: new Set(), TOOLS: [], listStickers: () => [],
    getWhispers: () => [], setWhispers() {}, healthData: [], getGeoLatest: () => null,
    setGeoLatest() {}, getLetters: () => [], setLetters() {}, sessions: {}, resident: {},
    contextStats: {}, pushHistory: [], withListLock: async fn => fn(), uid: prefix => prefix + '_test',
    todayStr: () => '', saveList() {}, saveGeo() {}, saveSessions() {}, saveResident() {},
    getWeather: async () => ({}), searchMusic: async () => ({}), musicPlayUrl: async () => ({}),
    musicPlayRemote: async () => ({}), searchNetease: async () => ({}), barkPush: async () => ({}),
    ntfyPush: async () => ({}), ttsNormalize: value => value, ttsSynthesize: async () => ({}),
    ttsVoices: {}, ttsSources: () => [], voicebox, asr, sessionGet() {}, sessionSave() {},
    contextAppend() {}, contextSummary() {}, residentList() {}, residentUpsert() {},
    residentSummary() {}, residentChat() {}, residentProactive() {}, broadcast() {},
    recordPush() {}, lanAddresses: () => [], fileSummary: () => ({}), directoryUsage: () => ({}),
    httpAuthorized: authorize || (() => true),
    authRequiredResponse(res) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); },
    parseQuery: () => ({}), corsOrigin: () => null
  });
}

async function callRoute(routes, method, pathname, bytes, mime, length) {
  const req = Readable.from(bytes ? [bytes] : []);
  req.url = pathname;
  req.method = method;
  req.headers = { host: '127.0.0.1', 'content-type': mime || '' };
  if (length != null) req.headers['content-length'] = String(length);
  req.socket = { remoteAddress: '127.0.0.1' };
  const result = { status: 0, body: '' };
  const res = {
    _reqOrigin: null,
    writeHead(status) { result.status = status; },
    end(body) { result.body = String(body || ''); }
  };
  await routes.handleHttp(req, res);
  result.json = result.body ? JSON.parse(result.body) : {};
  return result;
}

async function main() {
  const previousFetch = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/models/status')) {
        return response(200, { models: [{ model_name: 'whisper-base', downloaded: true }] });
      }
      assert(String(url).endsWith('/transcribe'));
      const fields = Object.fromEntries(options.body.entries());
      assert.strictEqual(fields.model, 'base');
      assert.strictEqual(fields.language, 'zh');
      assert.strictEqual(fields.file.type, 'audio/wav');
      return response(200, { text: '识别结果', duration: 1.25 });
    };

    const asr = makeAsr();
    assert.deepStrictEqual(asr.capabilities(), {
      streaming: false, partialResults: false, cancellation: false, timestamps: false
    });
    assert.strictEqual(asr.provider, 'voicebox');
    assert.strictEqual(asr.configured, true);
    assert.strictEqual(asr.streaming, false);
    assert.strictEqual(asr.createSession({}), null);

    const result = await asr.transcribe(Buffer.from([0, 0, 1, 0]), { requestId: 'turn-1' });
    assert.deepStrictEqual(result, {
      text: '识别结果', provider: 'voicebox', model: 'base', duration: 1.25, language: 'zh'
    });
    assert.strictEqual(calls.length, 2);
    assert(calls[0].url.endsWith('/models/status'));
    assert(calls[1].url.endsWith('/transcribe'));

    await assert.rejects(
      asr.transcribe({ bytes: Buffer.from('not-audio'), mime: 'application/octet-stream' }),
      error => error.code === 'INVALID_AUDIO'
    );
    await assert.rejects(
      asr.transcribe({ bytes: Buffer.alloc(1025), mime: 'audio/webm' }),
      error => error.code === 'AUDIO_TOO_LARGE'
    );
    assert.strictEqual(calls.length, 2, 'invalid or oversized input must not reach Voicebox');

    /* Offline and uncached model cases fail before POST /transcribe. */
    global.fetch = async url => {
      calls.push({ url: String(url) });
      throw new Error('offline');
    };
    await assert.rejects(asr.transcribe(Buffer.from([0, 0])), error => error.code === 'ASR_UNAVAILABLE');
    assert.strictEqual(calls.at(-1).url.endsWith('/models/status'), true);

    global.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, { models: [{ model_name: 'whisper-base', downloaded: false }] });
    };
    const beforeUnavailable = calls.length;
    await assert.rejects(asr.transcribe(Buffer.from([0, 0])), error => error.code === 'ASR_MODEL_UNAVAILABLE');
    assert.strictEqual(calls.length, beforeUnavailable + 1);
    assert(calls.at(-1).url.endsWith('/models/status'), 'uncached model must not call /transcribe');

    /* Provider selection preserves the existing OpenAI default and has no API-key requirement for Voicebox. */
    const openai = createAsr({ voiceAsr: { enabled: true, endpoint: 'http://asr.test', apiKey: 'k', model: 'm' } });
    assert.strictEqual(openai.provider, 'openai-whisper');
    assert.strictEqual(openai.configured, true);

    /* Raw file upload is validated and proxied by the Bridge; no endpoint/path is returned. */
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/models/status')) {
        return response(200, { models: [{ model_name: 'base', downloaded: true }] });
      }
      return response(200, { text: '上传转写', duration: 2 });
    };
    const routes = makeRoutes(asr);
    const capabilities = await callRoute(routes, 'GET', '/api/asr/capabilities');
    assert.strictEqual(capabilities.status, 200);
    assert.strictEqual(capabilities.json.provider, 'voicebox');
    assert.strictEqual(capabilities.json.capabilities.streaming, false);
    assert(!capabilities.body.includes(BASE));
    const unauthorized = await callRoute(makeRoutes(asr, () => false), 'POST', '/api/asr/transcriptions', Buffer.from('ignored'), 'audio/webm');
    assert.strictEqual(unauthorized.status, 401, 'upload route must retain Bridge authentication');
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]);
    const upload = await callRoute(routes, 'POST', '/api/asr/transcriptions', webm, 'audio/webm');
    assert.strictEqual(upload.status, 200, upload.body);
    assert.strictEqual(upload.json.text, '上传转写');
    assert.strictEqual(upload.json.provider, 'voicebox');
    const transcribeCall = calls.at(-1);
    assert(transcribeCall.url.startsWith(BASE + '/transcribe'));
    const uploadedFile = transcribeCall.options.body.get('file');
    assert.strictEqual(uploadedFile.type, 'audio/webm');
    assert.strictEqual(uploadedFile.size, webm.length);

    const wrongType = await callRoute(routes, 'POST', '/api/asr/transcriptions', webm, 'application/octet-stream');
    assert.strictEqual(wrongType.status, 415);
    const pathPayload = await callRoute(routes, 'POST', '/api/asr/transcriptions', Buffer.from('{"path":"C:\\\\temp\\\\voice.wav"}'), 'application/json');
    assert.strictEqual(pathPayload.status, 415, 'browser filesystem paths must not be accepted');
    const wrongSignature = await callRoute(routes, 'POST', '/api/asr/transcriptions', Buffer.from('xxxx'), 'audio/webm');
    assert.strictEqual(wrongSignature.status, 400);
    const oversized = await callRoute(routes, 'POST', '/api/asr/transcriptions', Buffer.alloc(1025), 'audio/webm', 1025);
    assert.strictEqual(oversized.status, 413);

    /* Logical cancellation: a late, non-cancellable provider result is discarded by turn identity. */
    let resolveAsr;
    let asrStarted;
    const started = new Promise(resolve => { asrStarted = resolve; });
    const runtimeEvents = [];
    const runtime = createVoiceRuntime({
      config: { voiceAsr: { maxTurnSeconds: 5 } },
      dataDir: '.', uid: prefix => prefix + '_test', ttsNormalize: value => value,
      ttsSynthesize: async () => ({ ok: false, error: 'unused' }),
      asr: {
        configured: true, streaming: false, createSession: () => null,
        transcribe(audio, options) {
          assert(options.requestId);
          asrStarted();
          return new Promise(resolve => { resolveAsr = resolve; });
        }
      }
    });
    const conn = { closed: false, sendJson(event) { runtimeEvents.push(event); } };
    runtime.handleEvent(conn, { type: 'start', roleId: 'r', conversationId: 'c' });
    runtime.handleEvent(conn, { type: 'speech_start' });
    runtime.handleBinary(conn, Buffer.alloc(3200));
    runtime.handleEvent(conn, { type: 'speech_end' });
    await started;
    runtime.handleEvent(conn, { type: 'interrupt' });
    resolveAsr({ text: '迟到结果', provider: 'voicebox' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert(!runtimeEvents.some(event => event.type === 'transcript_final' || event.type === 'transcript'));
    runtime.close(conn);

    console.log('Voicebox ASR provider / Bridge upload / fail-closed / stale-result tests passed');
  } finally {
    global.fetch = previousFetch;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
