'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const createVoiceRuntime = require(path.join(ROOT, 'bridge', 'voice-runtime'));


function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error('timed out'));
      setTimeout(poll, 10);
    })();
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-voice-runtime-'));
  let sawWav = false;
  const asr = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      sawWav = body.includes(Buffer.from('RIFF')) && req.headers.authorization === 'Bearer asr-secret';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '你好，角色。' }));
    });
  });
  await new Promise(resolve => asr.listen(0, '127.0.0.1', resolve));
  const port = asr.address().port;

  let ids = 0;
  let synthCalls = 0;
  const synthContexts = [];
  let releaseDelayed;
  const runtime = createVoiceRuntime({
    config: {
      voiceAsr: {
        enabled: true,
        endpoint: 'http://127.0.0.1:' + port + '/v1/audio/transcriptions',
        apiKey: 'asr-secret',
        model: 'whisper-test',
        language: 'zh',
        maxTurnSeconds: 10
      }
    },
    dataDir: dir,
    uid(prefix) { ids += 1; return prefix + '_' + ids; },
    ttsNormalize(profile) { return profile; },
     async ttsSynthesize(profile, ctx) {
       synthCalls += 1;
       synthContexts.push(ctx);
      if (synthCalls === 2) await new Promise(resolve => { releaseDelayed = resolve; });
      const name = 'tts_' + synthCalls + '.mp3';
      fs.writeFileSync(path.join(dir, name), Buffer.from('audio-' + synthCalls));
      return { ok: true, url: '/tts/' + name };
    }
  });
  const events = [];
  const conn = { closed: false, sendJson(event) { events.push(event); } };

  assert.strictEqual(runtime.handleEvent(conn, { type: 'start', roleId: '', conversationId: '' }), true);
  assert(events.some(event => event.type === 'error' && event.stage === 'start'));

  runtime.handleEvent(conn, { type: 'start', roleId: 'role-1', conversationId: 'thread:topic-1', voice: { provider: 'edge' } });
  const started = events.find(event => event.type === 'call_started');
  assert(started && started.roleId === 'role-1' && started.conversationId === 'thread:topic-1');
  assert.strictEqual(started.generation, 0);
  assert.strictEqual(started.state, 'listening');

  runtime.handleEvent(conn, { type: 'speech_start' });
  runtime.handleBinary(conn, Buffer.alloc(3200, 7));
  runtime.handleEvent(conn, { type: 'speech_end' });
  await waitFor(() => events.some(event => event.type === 'transcript'));
  assert.strictEqual(sawWav, true);
  const transcript = events.find(event => event.type === 'transcript');
  assert.strictEqual(transcript.text, '你好，角色。');

  runtime.handleEvent(conn, { type: 'adapter_reply', turn_id: transcript.turn_id, text: '我在这里。' });
  await waitFor(() => events.some(event => event.type === 'generation_end' && event.generation_id === 1));
  assert(events.some(event => event.type === 'reply_text' && event.generation_id === 1));
  assert(events.some(event => event.type === 'audio' && event.generation_id === 1));

  runtime.handleEvent(conn, { type: 'text', text: '第二轮' });
  await waitFor(() => events.filter(event => event.type === 'transcript').length === 2);
  const second = events.filter(event => event.type === 'transcript')[1];
  runtime.handleEvent(conn, { type: 'adapter_reply', turn_id: second.turn_id, text: '这段音频不该播放。' });
  await waitFor(() => typeof releaseDelayed === 'function');
  assert(events.some(event => event.type === 'reply_text' && event.generation_id === 2));
  runtime.handleEvent(conn, { type: 'interrupt' });
  runtime.handleEvent(conn, { type: 'interrupt' });
  assert.strictEqual(events.filter(event => event.type === 'interrupted' && event.generation_id === 2).length, 1);
  assert.strictEqual(synthContexts[1].signal.aborted, true);
  assert.strictEqual(runtime.publicSession(conn.session).generation, 3);
  runtime.handleEvent(conn, { type: 'text', text: '第三轮用户语音' });
  await waitFor(() => events.filter(event => event.type === 'transcript').length === 3);
  const third = events.filter(event => event.type === 'transcript')[2];
  runtime.handleEvent(conn, { type: 'adapter_reply', turn_id: third.turn_id, text: '新回复第一句。新回复第二句。' });
   await waitFor(() => events.some(event => event.type === 'generation_end' && event.generation_id === 4));
   assert.strictEqual(synthCalls, 4, 'new generation must synthesize both sentences before the old provider promise settles');
   assert(events.some(event => event.type === 'audio' && event.generation_id === 4));
  releaseDelayed();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert(!events.some(event => event.type === 'audio' && event.generation_id === 2));
  assert.strictEqual(runtime.publicSession(conn.session).state, 'listening', 'late stale completion must not mutate the new generation');
  assert(events.some(event => event.type === 'interrupted' && event.generation_id === 2 && event.next_generation_id === 3));

  runtime.handleEvent(conn, { type: 'hangup' });
  assert(events.some(event => event.type === 'hangup' && event.state === 'ended'));
  runtime.close(conn);

  /* Generation-scoped drain ownership: a stale, non-cancellable provider promise
     must not consume the new generation's queued sentence or hold its drain lock. */
  let queueIds = 0;
  let releaseOld, releaseNewFirst;
  const queueCalls = [];
  const queueRuntime = createVoiceRuntime({
    config: { voiceAsr: {} },
    dataDir: dir,
    uid(prefix) { queueIds += 1; return prefix + '_' + queueIds; },
    ttsNormalize(profile) { return profile; },
    ttsSynthesize() { throw new Error('the injected stream path should be used'); },
    streamSynthesize(profile, ctx, handlers) {
      queueCalls.push({ profile, ctx });
      if (ctx.generationId === 1) {
        return new Promise(resolve => {
          releaseOld = () => { handlers.onChunk(Buffer.from('old-audio'), 'audio/mpeg'); handlers.onDone(); resolve(); };
        });
      }
      if (ctx.generationId === 3 && ctx.sentenceId === 1) {
        return new Promise(resolve => {
          releaseNewFirst = () => { handlers.onChunk(Buffer.from('new-first'), 'audio/mpeg'); handlers.onDone(); resolve(); };
        });
      }
      if (ctx.generationId === 4) {
        return new Promise(() => {});
      }
      handlers.onChunk(Buffer.from('new-second'), 'audio/mpeg');
      handlers.onDone();
      return Promise.resolve();
    },
    asr: { configured: false, streaming: false, transcribe: async () => '', createSession: () => null }
  });
  const queueEvents = [];
  const queueConn = { closed: false, sendJson(event) { queueEvents.push(event); } };
  queueRuntime.handleEvent(queueConn, { type: 'start', roleId: 'role-q', conversationId: 'main:q', voice: { provider: 'voicebox' } });
  queueRuntime.handleEvent(queueConn, { type: 'text', text: 'old turn' });
  await waitFor(() => queueEvents.some(event => event.type === 'transcript'));
  const oldTurn = queueEvents.find(event => event.type === 'transcript');
  queueRuntime.handleEvent(queueConn, { type: 'adapter_reply', turn_id: oldTurn.turn_id, text: 'old sentence.' });
  await waitFor(() => typeof releaseOld === 'function');
  queueRuntime.handleEvent(queueConn, { type: 'interrupt' });
  assert.strictEqual(queueCalls[0].ctx.signal.aborted, true);

  queueRuntime.handleEvent(queueConn, { type: 'text', text: 'new turn' });
  await waitFor(() => queueEvents.filter(event => event.type === 'transcript').length === 2);
  const newTurn = queueEvents.filter(event => event.type === 'transcript')[1];
  queueRuntime.handleEvent(queueConn, { type: 'adapter_reply_sentence', turn_id: newTurn.turn_id, text: 'new first.', done: false });
  await waitFor(() => queueCalls.length === 2);
  queueRuntime.handleEvent(queueConn, { type: 'adapter_reply_sentence', turn_id: newTurn.turn_id, text: 'new second.', done: true });
  releaseOld();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(queueCalls.length, 2, 'old drain must not take the queued second sentence');
  assert(!queueEvents.some(event => event.type === 'audio' && event.generation_id === 1));
  releaseNewFirst();
  await waitFor(() => queueCalls.length === 3);
  assert.strictEqual(queueCalls[2].ctx.generationId, 3);
  assert.strictEqual(queueCalls[2].ctx.sentenceId, 2);
  await waitFor(() => queueEvents.some(event => event.type === 'generation_end' && event.generation_id === 3));

  /* WebSocket/session close aborts any still-active provider request. */
  queueRuntime.handleEvent(queueConn, { type: 'greeting', text: 'closing' });
  await waitFor(() => queueCalls.length === 4);
  const closeSignal = queueCalls[3].ctx.signal;
  queueRuntime.close(queueConn);
  assert.strictEqual(closeSignal.aborted, true);

  await new Promise(resolve => asr.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Voice runtime test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
