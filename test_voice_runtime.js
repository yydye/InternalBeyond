'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const createVoiceRuntime = require('./bridge/voice-runtime');

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
    async ttsSynthesize() {
      synthCalls += 1;
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
  releaseDelayed();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert(!events.some(event => event.type === 'audio' && event.generation_id === 2));
  assert(events.some(event => event.type === 'interrupted' && event.generation_id === 2 && event.next_generation_id === 3));

  runtime.handleEvent(conn, { type: 'hangup' });
  assert(events.some(event => event.type === 'hangup' && event.state === 'ended'));
  runtime.close(conn);

  await new Promise(resolve => asr.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Voice runtime test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
