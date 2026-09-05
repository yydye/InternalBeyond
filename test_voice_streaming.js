'use strict';

/* Phase 2+ Voice Runtime tests: sentence-level TTS queue, streaming ASR
   protocol, real barge-in (interrupt race), state machine, reconnect. */

const assert = require('assert');
const fs = require('fs');
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* A runtime harness with an injectable fake ASR and a controllable TTS synth. */
function makeRuntime(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-voice-stream-'));
  let ids = 0;
  let synthCalls = 0;
  let gateResolver = null;
  const events = [];
  const conn = { closed: false, sendJson(ev) { events.push(ev); } };
  const runtime = createVoiceRuntime({
    config: {
      voiceAsr: {
        enabled: true,
        endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions',
        apiKey: 'secret', model: 'whisper-test', language: 'zh', maxTurnSeconds: 10
      }
    },
    dataDir: dir,
    uid(prefix) { ids += 1; return prefix + '_' + ids; },
    ttsNormalize(profile) { return profile; },
    async ttsSynthesize(profile) {
      synthCalls += 1;
      const call = synthCalls;
      if (opts.synth) {
        const hooked = await opts.synth(profile, call, { wait: () => new Promise(r => { gateResolver = r; }), isGate: () => !!gateResolver });
        if (hooked !== undefined) return hooked;
      }
      /* Default: write a small fake mp3 and return a url. */
      const name = 'tts_' + call + '.mp3';
      fs.writeFileSync(path.join(dir, name), Buffer.from('audio-' + call));
      return { ok: true, url: '/tts/' + name };
    },
    streamSynthesize: opts.streamSynth || undefined,
    asr: opts.asr
  });
  return {
    runtime, conn, events, dir,
    synthCalls() { return synthCalls; },
    releaseGate() { const r = gateResolver; gateResolver = null; if (r) r(); },
    setGate() { gateResolver = null; },
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  };
}

function byType(events, type) { return events.filter(e => e.type === type); }

async function testSpeechTurn(runtime, conn, asrText) {
  /* Run a full speaking turn ending with a transcript_final event. */
  runtime.handleEvent(conn, { type: 'speech_start' });
  runtime.handleBinary(conn, Buffer.alloc(3200, 3));
  runtime.handleEvent(conn, { type: 'speech_end' });
  return asrText;
}

async function main() {
  /* ── 1. Sentence-level TTS queue: multi-sentence reply → ordered audio + done ── */
  {
    const h = makeRuntime({
      asr: { configured: true, streaming: false, transcribe: async () => '你好。' }
    });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1', voice: { provider: 'edge' } });
    await testSpeechTurn(h.runtime, h.conn);
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    const tf = byType(h.events, 'transcript_final')[0];
    assert.strictEqual(tf.text, '你好。');
    assert.strictEqual(tf.final, true);
    /* Legacy `transcript` alias must also be emitted (Phase 1 contract). */
    assert.strictEqual(byType(h.events, 'transcript').length, 1);

    h.runtime.handleEvent(h.conn, { type: 'adapter_reply', turn_id: tf.turn_id, text: '第一句。第二句。第三句。' });
    await waitFor(() => byType(h.events, 'generation_end').length >= 1);
    const audios = byType(h.events, 'audio');
    assert.strictEqual(audios.length, 3);
    assert.deepStrictEqual(audios.map(a => a.seq), [1, 2, 3]);
    assert.deepStrictEqual(audios.map(a => a.generation_id), [1, 1, 1]);
    assert.strictEqual(audios[audios.length - 1].done, true);
    assert.strictEqual(audios[0].done, false);
    const genEnd = byType(h.events, 'generation_end')[0];
    assert.strictEqual(genEnd.generation_id, 1);
    /* state transitions for the turn */
    const modes = byType(h.events, 'state').map(e => e.mode);
    assert.strictEqual(modes[modes.length - 1], 'listening');
    h.cleanup();
  }

  /* ── 2. Streaming ASR protocol: partial + final via injected streaming asr ── */
  {
    const partials = [];
    const h = makeRuntime({
      asr: {
        configured: true, streaming: true,
        transcribe: async () => 'turn-based-fallback',
        createSession(handlers) {
          return {
            pushAudio() { handlers.onPartial('部分转写'); partials.push('push'); },
            finalize: async () => '流式最终文本。',
            cancel() {}, close() {}
          };
        }
      }
    });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    h.runtime.handleEvent(h.conn, { type: 'speech_start' });
    assert(partials.length === 0);
    h.runtime.handleBinary(h.conn, Buffer.alloc(3200, 3));
    await waitFor(() => byType(h.events, 'transcript_partial').length >= 1);
    const partial = byType(h.events, 'transcript_partial')[0];
    assert.strictEqual(partial.text, '部分转写');
    h.runtime.handleEvent(h.conn, { type: 'speech_end' });
    await waitFor(() => byType(h.events, 'transcript_final').length >= 1);
    const tf = byType(h.events, 'transcript_final')[0];
    assert.strictEqual(tf.text, '流式最终文本。');
    assert.strictEqual(tf.streaming, true);
    h.cleanup();
  }

  /* ── 3. State machine guards: interrupt during thinking is legal; late ASR ok ── */
  {
    const h = makeRuntime({ asr: { configured: true, streaming: false, transcribe: async () => '快就行。' } });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    h.runtime.handleEvent(h.conn, { type: 'speech_start' });
    h.runtime.handleBinary(h.conn, Buffer.alloc(3200, 3));
    h.runtime.handleEvent(h.conn, { type: 'speech_end' });
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    /* Interrupt while in thinking state (auto model still resolving). */
    h.runtime.handleEvent(h.conn, { type: 'interrupt' });
    const interrupted = byType(h.events, 'interrupted').pop();
    assert(interrupted && interrupted.reason === 'user');
    assert(interrupted.next_generation_id > interrupted.generation_id);
    const lastState = byType(h.events, 'state').pop();
    assert.strictEqual(lastState.mode, 'listening');
    h.cleanup();
  }

  /* ── 4. Interrupt race: delayed TTS that resolves after barge-in is dropped ── */
  {
    let delayed = null;
    const h = makeRuntime({
      asr: { configured: true, streaming: false, transcribe: async () => '第一句。' },
      synth: async (profile, call) => {
        if (call === 1) { await new Promise(r => { delayed = r; }); }
        const name = 'tts_' + call + '.mp3';
        fs.writeFileSync(path.join(h.dir, name), Buffer.from('audio-' + call));
        return { ok: true, url: '/tts/' + name };
      }
    });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    await testSpeechTurn(h.runtime, h.conn);
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    const tf = byType(h.events, 'transcript_final')[0];
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply', turn_id: tf.turn_id, text: '第一句。' });
    await waitFor(() => typeof delayed === 'function');
    /* Barge-in while generation 1 is synthesizing. */
    h.runtime.handleEvent(h.conn, { type: 'interrupt' });
    delayed();
    await new Promise(r => setTimeout(r, 60));
    assert(!byType(h.events, 'audio').some(a => a.generation_id === 1));
    const interrupted = byType(h.events, 'interrupted').pop();
    assert.strictEqual(interrupted.generation_id, 1);
    assert.strictEqual(interrupted.next_generation_id, 2);
    h.cleanup();
  }

  /* ── 5. Barge-in via speech_start while speaking: clears the whole TTS queue ── */
  {
    let delayed = null;
    const h = makeRuntime({
      asr: { configured: true, streaming: false, transcribe: async () => '一。二。三。' },
      synth: async (profile, call) => {
        if (call === 1) { await new Promise(r => { delayed = r; }); }
        const name = 'tts_' + call + '.mp3';
        fs.writeFileSync(path.join(h.dir, name), Buffer.from('audio-' + call));
        return { ok: true, url: '/tts/' + name };
      }
    });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    await testSpeechTurn(h.runtime, h.conn);
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    const tf = byType(h.events, 'transcript_final')[0];
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply', turn_id: tf.turn_id, text: '一。二。三。' });
    await waitFor(() => typeof delayed === 'function');
    /* User starts talking while AI is speaking → barge_in interrupt. */
    h.runtime.handleEvent(h.conn, { type: 'speech_start' });
    const interrupt = byType(h.events, 'interrupted').pop();
    assert(interrupt && interrupt.reason === 'barge_in');
    delayed();
    await new Promise(r => setTimeout(r, 60));
    /* No generation-1 audio may have been emitted, and the session is in listening. */
    assert(!byType(h.events, 'audio').some(a => a.generation_id === 1));
    const lastState = byType(h.events, 'state').pop();
    assert.strictEqual(lastState.mode, 'listening');
    h.cleanup();
  }

  /* ── 6. Incremental adapter_reply_sentence (streaming model → TTS queue) ── */
  {
    const h = makeRuntime({ asr: { configured: true, streaming: false, transcribe: async () => '开始。' } });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    await testSpeechTurn(h.runtime, h.conn);
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    const tf = byType(h.events, 'transcript_final')[0];
    const turnId = tf.turn_id;
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply_sentence', turn_id: turnId, text: '第一句。', done: false });
    await waitFor(() => byType(h.events, 'audio').length === 1);
    assert.strictEqual(byType(h.events, 'generation_end').length, 0);
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply_sentence', turn_id: turnId, text: '第二句。', done: true });
    await waitFor(() => byType(h.events, 'generation_end').length === 1);
    const audios = byType(h.events, 'audio');
    assert.strictEqual(audios.length, 2);
    assert.strictEqual(audios[0].done, false);
    assert.strictEqual(audios[1].done, true);
    assert.strictEqual(audios[1].generation_id, 1);
    assert.strictEqual(byType(h.events, 'reply_text').length, 1);
    h.cleanup();
  }

  /* ── 6b. Streaming completion: an empty-text done signal ends the generation ── */
  {
    const h = makeRuntime({ asr: { configured: true, streaming: false, transcribe: async () => '开始。' } });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    await testSpeechTurn(h.runtime, h.conn);
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    const tf = byType(h.events, 'transcript_final')[0];
    const turnId = tf.turn_id;
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply_sentence', turn_id: turnId, text: '第一句。', done: false });
    await waitFor(() => byType(h.events, 'audio').length === 1);
    assert.strictEqual(byType(h.events, 'generation_end').length, 0);
    /* Client flushes an empty done signal (nothing more to say). */
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply_sentence', turn_id: turnId, text: '', done: true });
    await waitFor(() => byType(h.events, 'generation_end').length === 1);
    const audios = byType(h.events, 'audio');
    assert.strictEqual(audios.length, 1);
    /* The single sentence was queued before the done signal, so its audio.done is
       false; completion is signalled by the generation_end event, which tells the
       client to stop the stream and return to listening. */
    assert.strictEqual(audios[0].done, false);
    assert.strictEqual(byType(h.events, 'generation_end')[0].generation_id, 1);
    h.cleanup();
  }

  /* ── 7. Reconnect: a new connection yields a fresh, independent CallSession ── */
  {
    const h = makeRuntime({ asr: { configured: true, streaming: false, transcribe: async () => '重连。' } });
    const conn1 = h.conn;
    h.runtime.handleEvent(conn1, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    const s1 = byType(h.events, 'call_started')[0].callSessionId;
    /* Simulate an explicit hangup then transport close, then a fresh connection. */
    h.runtime.handleEvent(conn1, { type: 'hangup' });
    h.runtime.close(conn1);
    const eventsB = [];
    const conn2 = { closed: false, sendJson(ev) { eventsB.push(ev); } };
    h.runtime.handleEvent(conn2, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    const s2 = eventsB.find(e => e.type === 'call_started');
    assert(s2 && s2.callSessionId !== s1);
    h.cleanup();
  }

  /* ── 8. Streaming TTS chunk ordering: sentence_id + chunk_id + done ── */
  {
    let chunkCalls = 0;
    const turnAsr = { configured: true, streaming: false, transcribe: async () => '开始。' };
    const h = makeRuntime({
      asr: turnAsr,
      streamSynth: async (profile, ctx, handlers) => {
        chunkCalls += 1;
        const s = chunkCalls;
        handlers.onChunk(Buffer.from('A' + s + '-1'), 'audio/mpeg');
        handlers.onChunk(Buffer.from('A' + s + '-2'), 'audio/mpeg');
        handlers.onDone();
      }
    });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    await testSpeechTurn(h.runtime, h.conn);
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    const tf = byType(h.events, 'transcript_final')[0];
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply', turn_id: tf.turn_id, text: '一。二。' });
    await waitFor(() => byType(h.events, 'generation_end').length === 1);
    const audios = byType(h.events, 'audio');
    assert.strictEqual(audios.length, 4);
    assert.deepStrictEqual(audios.map(a => [a.sentence_id, a.chunk_id]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
    assert.deepStrictEqual(audios.map(a => a.done), [false, false, false, true]);
    /* sequence stays per-sentence: no cross-sentence chunk overlap */
    assert.strictEqual(audios[audios.length - 1].generation_id, 1);
    h.cleanup();
  }

  /* ── 9. Barge-in during a streaming TTS: late chunks of the interrupted generation are dropped ── */
  {
    let delayed = null;
    const turnAsr = { configured: true, streaming: false, transcribe: async () => '一。' };
    const h = makeRuntime({
      asr: turnAsr,
      streamSynth: async (profile, ctx, handlers) => {
        for (let i = 1; i <= 5; i++) handlers.onChunk(Buffer.from('c' + i), 'audio/mpeg');
        await new Promise(r => { delayed = r; });
        handlers.onChunk(Buffer.from('c6'), 'audio/mpeg');
        handlers.onChunk(Buffer.from('c7'), 'audio/mpeg');
        handlers.onDone();
      }
    });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    await testSpeechTurn(h.runtime, h.conn);
    await waitFor(() => byType(h.events, 'transcript_final').length === 1);
    const tf = byType(h.events, 'transcript_final')[0];
    h.runtime.handleEvent(h.conn, { type: 'adapter_reply', turn_id: tf.turn_id, text: '一。' });
    await waitFor(() => byType(h.events, 'audio').length >= 1);
    assert(byType(h.events, 'audio').length === 4); /* chunks 1-4 emitted so far (chunk 5 held back) */
    h.runtime.handleEvent(h.conn, { type: 'interrupt' });
    delayed && delayed();
    await sleep(60);
    const earlyChunks = byType(h.events, 'audio');
    /* The last sent chunk before barge-in is chunk 4; chunks 5/6/7 are dropped. */
    assert.strictEqual(earlyChunks.length, 4);
    assert.deepStrictEqual(earlyChunks.map(a => a.chunk_id), [1, 2, 3, 4]);
    assert(byType(h.events, 'interrupted').some(e => e.next_generation_id === 2));
    h.cleanup();
  }

  /* ── 10. ASR race: an old capture's late partial is dropped after interrupt ── */
  {
    let sessionRef = null;
    let partialGen = [];
    const h = makeRuntime({
      asr: {
        configured: true, streaming: true,
        transcribe: async () => 'fallback',
        createSession(handlers) {
          const s = {
            pushAudio() { handlers.onPartial('旧partial'); },
            finalize: async () => '新最终。',
            cancel() {}, close() {}
          };
          sessionRef = s;
          return s;
        }
      }
    });
    h.runtime.handleEvent(h.conn, { type: 'start', roleId: 'r1', conversationId: 'main:r1' });
    h.runtime.handleEvent(h.conn, { type: 'speech_start' }); /* capture gen 1 */
    h.runtime.handleBinary(h.conn, Buffer.alloc(3200, 3));   /* fires partial gen1 */
    await waitFor(() => byType(h.events, 'transcript_partial').length === 1);
    partialGen.push(byType(h.events, 'transcript_partial')[0].generation_id);
    /* Interrupt: invalidates capture gen1 and nulls the session. */
    h.runtime.handleEvent(h.conn, { type: 'interrupt' });
    /* A late partial from the old (cancelled) session must be dropped. */
    sessionRef.pushAudio();
    await sleep(30);
    assert.strictEqual(byType(h.events, 'transcript_partial').length, 1);
    /* A fresh capture receives generation 2 and its partial is accepted. */
    h.runtime.handleEvent(h.conn, { type: 'speech_start' });
    h.runtime.handleBinary(h.conn, Buffer.alloc(3200, 3));
    await waitFor(() => byType(h.events, 'transcript_partial').length === 2);
    const gens = byType(h.events, 'transcript_partial').map(p => p.generation_id);
    /* Gen 1 (capture) then gen 3 (new capture; gen 2 was consumed by the
       interrupt marker). The old gen-1 partial never duplicated or leaked. */
    assert.deepStrictEqual(gens, [1, 3]);
    h.cleanup();
  }

  /* ── 11. ASR provider abstraction: streaming capability gates createSession ── */
  {
    const createAsr = require('./bridge/asr');
    createAsr.register('mock-stream', {
      streaming: true,
      transcribe: async () => 't',
      createSession: (cfg, cb) => ({ pushAudio() { cb && cb.onPartial('p'); }, finalize: async () => 'f', cancel() {}, close() {} })
    });
    const a1 = createAsr({ voiceAsr: { enabled: true, endpoint: 'http://x', apiKey: 'k', model: 'm', streaming: true, provider: 'mock-stream' } });
    assert.strictEqual(a1.streaming, true);
    const s1 = a1.createSession({ onPartial() {}, onFinal() {}, onError() {} });
    assert(s1 && typeof s1.pushAudio === 'function' && typeof s1.finalize === 'function');
    /* Without an explicit streaming provider we stay turn-based and never fake it. */
    const a2 = createAsr({ voiceAsr: { enabled: true, endpoint: 'http://x', apiKey: 'k', model: 'm' } });
    assert.strictEqual(a2.streaming, false);
    assert.strictEqual(a2.createSession({}), null);
  }

  console.log('Voice streaming / interrupt / TTS-queue test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
