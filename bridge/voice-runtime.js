/* InternalBeyond Voice Runtime: audio/ASR/call-state/generation lifecycle only.
   Role context, model calls, tools, history and memory stay in the browser chat runtime.
   Phase 2/3 build-outs (incremental on Phase 1):
     - explicit session state machine (single `call.state` source of truth)
     - streaming ASR session interface (live PCM chunk feed; partial/final; turn-based fallback)
     - streaming TTS chunk pipeline (Edge = true per-frame MP3 stream; other providers =
       whole-clip single chunk) with sentence_id / chunk_id / done ordering
     - monotonic generation + per-capture ASR generation guard so late ASR/TTS/audio
       from an interrupted reply or an old capture is dropped */
'use strict';

const fs = require('fs');
const path = require('path');

const createAsr = require('./asr');

const SAMPLE_RATE = 16000;

/* States the session cycles through. Guards use call.state as the single source
   of truth; the runtime never relies on a pile of booleans to decide behavior. */
const STATES = {
  idle: ['connecting', 'listening', 'error', 'ended'],
  connecting: ['listening', 'error', 'ended'],
  listening: ['listening', 'thinking', 'speaking', 'interrupting', 'error', 'ended'],
  thinking: ['listening', 'speaking', 'interrupting', 'error', 'ended'],
  speaking: ['listening', 'interrupting', 'error', 'ended'],
  interrupting: ['listening', 'error', 'ended'],
  error: ['listening', 'ended'],
  ended: []
};

/* Split a reply into speakable sentences. Keeps terminal punctuation with the
   sentence; a trailing fragment without punctuation is kept as its own unit so
   we never drop text. */
function splitSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.match(/[^。！？!?；;]+[。！？!?；;]+|[^。！？!?；;]+$/g) || [t];
  return parts.map(s => s.trim()).filter(Boolean);
}

function createVoiceRuntime(deps) {
  const config = deps.config;
  const ttsNormalize = deps.ttsNormalize;
  const ttsSynthesize = deps.ttsSynthesize;
  const streamSynthesize = deps.streamSynthesize || defaultStreamSynthesize;
  const dataDir = deps.dataDir;
  const uid = deps.uid;
  const asr = deps.asr || createAsr(config);
  const sessions = new WeakMap();

  const debugOn = !!(config.voiceAsr && config.voiceAsr.debug);
  function debugLog(msg) { if (debugOn) try { console.debug('[IB Voice] ' + msg); } catch (e) { /* ignore */ } }

  function send(conn, event) {
    if (conn && !conn.closed) conn.sendJson(event);
  }

  function publicSession(call) {
    return {
      callSessionId: call.callSessionId,
      roleId: call.roleId,
      conversationId: call.conversationId,
      generation: call.generation,
      state: call.state
    };
  }

  function setState(conn, call, state, extra) {
    if (!call || call.state === 'ended') return;
    const previous = call.state;
    const allowed = STATES[previous] || STATES.idle;
    const to = (allowed.indexOf(state) !== -1) ? state : (state === 'interrupting' ? 'interrupting' : 'listening');
    call.state = to;
    send(conn, Object.assign({ type: 'state', mode: to }, publicSession(call), extra || {}));
  }

  function beginTurn(call) {
    const turn = { turnId: uid('voice_turn'), cancelled: false };
    call.pendingTurn = turn;
    return turn;
  }

  function readTtsFile(result) {
    const fileName = path.basename(String(result.url || ''));
    const file = path.join(dataDir, fileName);
    if (!fileName || !file.startsWith(dataDir) || !fs.existsSync(file)) {
      throw new Error('TTS audio file is unavailable');
    }
    return {
      audio: fs.readFileSync(file),
      mime: /\.wav$/i.test(fileName) ? 'audio/wav' : 'audio/mpeg'
    };
  }

  /* Default streaming synth used when the composition root does not inject a
     provider-level streamer (e.g. in unit tests): synth the whole sentence via
     the normal entry, then emit it as a single chunk + done. This is the
     honest "sentence-level streaming" fallback. */
  async function defaultStreamSynthesize(profile, ctx, handlers) {
    try {
      const result = await ttsSynthesize(ttsNormalize(profile), ctx || {});
      if (!result || !result.ok) { handlers.onError((result && result.error) || 'TTS failed'); return; }
      const loaded = readTtsFile(result);
      handlers.onChunk(loaded.audio, loaded.mime);
      handlers.onDone();
    } catch (e) {
      handlers.onError(String(e && e.message || e).slice(0, 200));
    }
  }

  /* ── Interrupt / barge-in ──
     Everything that ends the current speech is channelled here: it bumps the
     monotonic reply generation AND the per-capture ASR generation, cancels the
     pending turn, clears the TTS queue and nulls the active reply + ASR session.
     Any ASR transcript / TTS chunk / audio whose captured generation no longer
     equals the current one is discarded — including a TTS request that resolves
     after the interrupt and an ASR partial that arrives after a barge-in. */
  function interrupt(conn, call, reason) {
    const oldGeneration = call.generation;
    const previousState = call.state;
    call.generation += 1;
    call.asrGeneration += 1; /* invalidate any in-flight ASR capture */
    if (call.pendingTurn) call.pendingTurn.cancelled = true;
    call.pendingTurn = null;
    call.capturing = false;
    if (call.asrSession) { try { call.asrSession.cancel && call.asrSession.cancel(); call.asrSession.close && call.asrSession.close(); } catch (e) { /* ignore */ } call.asrSession = null; }
    call.ttsQueue = [];
    call.activeReply = null;
    call.lastSpokenGeneration = null;
    setState(conn, call, 'interrupting', { reason: reason || 'user' });
    send(conn, {
      type: 'interrupted',
      call_session_id: call.callSessionId,
      generation_id: oldGeneration,
      next_generation_id: call.generation,
      reason: reason || 'user'
    });
    if (oldGeneration > 0 && (previousState === 'speaking' || previousState === 'thinking')) {
      send(conn, { type: 'generation_end', call_session_id: call.callSessionId, generation_id: oldGeneration, interrupted: true });
    }
    setState(conn, call, 'listening');
  }

  function sendAudio(conn, call, generationId, sentenceId, chunkId, buf, mime, done) {
    send(conn, {
      type: 'audio',
      call_session_id: call.callSessionId,
      generation_id: generationId,
      sentence_id: sentenceId,
      chunk_id: chunkId,
      seq: sentenceId, /* backwards-compat alias */
      mime: mime || 'audio/mpeg',
      data: buf.toString('base64'),
      done: !!done
    });
  }

  /* Synthesize one sentence through the streaming provider, emitting its audio
     chunks in order. We hold the most-recent chunk back by one so the final
     chunk of the sentence can carry the correct `done` flag (which for the last
     sentence equals the reply-done state). A deferred chunk costs one MP3 frame
     of latency (~tens of ms) and is what makes end-of-reply detection correct. */
  function synthesizeSentence(conn, call, item, replyDoneFlag) {
    return new Promise(function (resolve) {
      let pending = null;
      let chunkId = 0;
      const emit = function (chunk, doneFlag) {
        if (item.generation !== call.generation || call.state === 'ended' || item.cancelled) return false;
        if (!call.turnTimings.ttsFirstChunkMs && call.replyStartMs) call.turnTimings.ttsFirstChunkMs = Date.now() - call.replyStartMs;
        sendAudio(conn, call, item.generation, item.seq, chunk.chunkId, chunk.buf, chunk.mime, doneFlag);
        call.lastSpokenGeneration = item.generation;
        return true;
      };
      const handlers = {
        onChunk: function (buf, mime) {
          if (item.generation !== call.generation || call.state === 'ended' || item.cancelled) { pending = null; return; }
          chunkId++;
          if (pending) emit(pending, false);
          pending = { chunkId: chunkId, buf: buf, mime: mime };
        },
        onDone: function () {
          if (pending) { emit(pending, replyDoneFlag); pending = null; }
          resolve();
        },
        onError: function (err) {
          pending = null;
          if (item.generation === call.generation && call.state !== 'ended') {
            send(conn, { type: 'error', stage: 'tts', generation_id: item.generation, sentence_id: item.seq, error: String(err || 'TTS failed').slice(0, 300) });
          }
          resolve();
        }
      };
      const profile = Object.assign({}, call.voice || {}, { text: item.text });
      const ctx = { callSessionId: call.callSessionId, generation: item.generation, sentenceId: item.seq };
      Promise.resolve(streamSynthesize(ttsNormalize(profile), ctx, handlers)).catch(function (e) {
        if (item.generation === call.generation && call.state !== 'ended') {
          send(conn, { type: 'error', stage: 'tts', generation_id: item.generation, sentence_id: item.seq, error: String(e && e.message || e).slice(0, 300) });
        }
        resolve();
      });
    });
  }

  /* ── TTS queue ──
     Sentences for a generation are appended to call.ttsQueue. drainQueue
     synthesizes them serially (so sentence order is preserved) and pushes each
     audio chunk as soon as it is ready, so playback can start on the first
     sentence without waiting for the rest. */
  async function drainQueue(conn, call) {
    if (call.ttsDraining || call.state === 'ended') return;
    call.ttsDraining = true;
    try {
      while (call.ttsQueue.length) {
        const item = call.ttsQueue[0];
        if (item.generation !== call.generation || call.state === 'ended' || item.cancelled) { call.ttsQueue.shift(); continue; }
        call.ttsQueue.shift();
        const replyDone = !!(call.activeReply && call.activeReply.done);
        const isLastSent = call.ttsQueue.length === 0;
        await synthesizeSentence(conn, call, item, replyDone && isLastSent);
      }
      if (call.state !== 'ended' && call.ttsQueue.length === 0 && call.activeReply && call.activeReply.done) {
        const gen = call.activeReply.generation;
        call.activeReply = null;
        if (call.pendingTurn) call.pendingTurn = null;
        debugLog('generation_end gen=' + gen + (call.turnTimings.ttsFirstChunkMs != null ? ' tts_first_chunk_ms=' + call.turnTimings.ttsFirstChunkMs : ''));
        send(conn, { type: 'generation_end', call_session_id: call.callSessionId, generation_id: gen });
        setState(conn, call, 'listening');
      }
    } finally {
      call.ttsDraining = false;
    }
  }

  /* Submit a reply (whole or incremental) into the TTS queue. */
  function submitReply(conn, call, msg, opts) {
    const turn = call.pendingTurn;
    if (!turn || turn.cancelled || String(msg.turn_id || '') !== turn.turnId) return;    const text = String(msg.text || '').trim();
    const done = opts.done !== false;
    if (!call.activeReply || call.state === 'ended') {
      if (!text) return;
      call.generation += 1;
      call.activeReply = { generation: call.generation, done: done, turnId: turn.turnId };
      call.sentenceSeq = 0;
      call.replyStartMs = Date.now();
      call.turnTimings = {};
      send(conn, { type: 'reply_text', call_session_id: call.callSessionId, turn_id: turn.turnId, generation_id: call.activeReply.generation, text: text });
      setState(conn, call, 'speaking');
    } else {
      call.activeReply.done = call.activeReply.done || done;
    }
    if (text) {
      const sentences = splitSentences(text);
      for (const sentence of sentences) {
        call.ttsQueue.push({ generation: call.activeReply.generation, seq: ++call.sentenceSeq, text: sentence, cancelled: false });
      }
    }
    if (done) {
      call.activeReply.done = true;
      if (call.pendingTurn) call.pendingTurn = null;
    }
    void drainQueue(conn, call);
  }

  /* Standalone assistant utterance (incoming-call opening line): no pending user turn.
     Bundled through the same TTS queue + generation guards so barge-in/interrupt and
     stale-audio protection apply unchanged. */
  function speakGreeting(conn, call, msg) {
    const text = String(msg && msg.text || '').trim();
    if (!text || call.state === 'ended') return true;
    call.generation += 1;
    call.activeReply = { generation: call.generation, done: true, turnId: String(msg.turn_id || 'greeting') };
    call.sentenceSeq = 0;
    call.replyStartMs = Date.now();
    call.turnTimings = {};
    send(conn, { type: 'reply_text', call_session_id: call.callSessionId, turn_id: call.activeReply.turnId, generation_id: call.generation, text: text });
    setState(conn, call, 'speaking');
    const sentences = splitSentences(text);
    for (const sentence of sentences) {
      call.ttsQueue.push({ generation: call.generation, seq: ++call.sentenceSeq, text: sentence, cancelled: false });
    }
    void drainQueue(conn, call);
    return true;
  }

  function startAsrSession(conn, call) {
    let session = null;
    try {
      session = asr.createSession({
        onPartial: function (text) {
          if (call.asrSession !== session) return;
          send(conn, { type: 'transcript_partial', call_session_id: call.callSessionId, generation_id: call.asrGeneration, text: String(text || '') });
        },
        onFinal: function () { /* final handled by finalize() */ },
        onError: function (e) {
          if (call.asrSession !== session || call.state === 'ended') return;
          send(conn, { type: 'error', stage: 'asr', error: String(e && e.message || e).slice(0, 300) });
        }
      });
    } catch (e) { session = null; }
    call.asrSession = session;
    return session;
  }

  /* ── Speech / ASR ── */
  async function finishSpeech(conn, call, suppliedText) {
    if (call.state === 'ended') return;
    const turn = beginTurn(call);
    const pcm = Buffer.concat(call.audio);
    call.audio = [];
    call.audioBytes = 0;
    call.capturing = false;
    const asrStart = Date.now();
    send(conn, { type: 'speech_end', call_session_id: call.callSessionId, turn_id: turn.turnId });
    setState(conn, call, 'thinking');
    try {
      let transcript = suppliedText || '';
      let streaming = false;
      if (!transcript) {
        if (call.asrSession) {
          streaming = true;
          transcript = await call.asrSession.finalize();
          call.asrSession = null;
        } else {
          transcript = await asr.transcribe(pcm);
        }
      }
      if (turn.cancelled || call.pendingTurn !== turn || call.state === 'ended') return;
      transcript = String(transcript || '').trim();
      call.turnTimings.asrFinalMs = Date.now() - asrStart;
      debugLog('speech_end gen_asr=' + call.asrGeneration + ' asr_final_ms=' + call.turnTimings.asrFinalMs + ' streaming=' + streaming);
      if (!transcript) {
        call.pendingTurn = null;
        send(conn, { type: 'nothing_heard', call_session_id: call.callSessionId, turn_id: turn.turnId });
        setState(conn, call, 'listening');
        return;
      }
      turn.transcript = transcript;
      const payload = {
        call_session_id: call.callSessionId,
        turn_id: turn.turnId,
        roleId: call.roleId,
        conversationId: call.conversationId,
        text: transcript,
        generation_id: call.asrGeneration
      };
      if (streaming) payload.streaming = true;
      send(conn, Object.assign({ type: 'transcript_final', final: true }, payload));
      /* Legacy alias: Phase 1 client/test fire on `transcript`. */
      send(conn, Object.assign({ type: 'transcript' }, payload));
    } catch (error) {
      if (turn.cancelled || call.state === 'ended') return;
      call.pendingTurn = null;
      if (call.asrSession) { try { call.asrSession.cancel && call.asrSession.cancel(); call.asrSession.close && call.asrSession.close(); } catch (e) { /* ignore */ } call.asrSession = null; }
      send(conn, { type: 'error', stage: 'asr', error: String(error && error.message || error).slice(0, 300) });
      setState(conn, call, 'listening');
    }
  }

  function start(conn, msg) {
    const roleId = String(msg.roleId || '').trim();
    const conversationId = String(msg.conversationId || '').trim();
    if (!roleId || !conversationId) {
      send(conn, { type: 'error', stage: 'start', error: 'roleId and conversationId are required' });
      return true;
    }
    const call = {
      callSessionId: uid('voice_call'),
      roleId,
      conversationId,
      generation: 0,
      asrGeneration: 0,
      state: 'listening',
      voice: msg.voice && typeof msg.voice === 'object' ? msg.voice : {},
      audio: [],
      audioBytes: 0,
      capturing: false,
      pendingTurn: null,
      ttsQueue: [],
      ttsDraining: false,
      activeReply: null,
      sentenceSeq: 0,
      lastSpokenGeneration: null,
      asrSession: null,
      replyStartMs: null,
      turnTimings: {}
    };
    sessions.set(conn, call);
    conn.session = call;
    send(conn, Object.assign({
      type: 'call_started',
      call_session_id: call.callSessionId,
      asr: { configured: asr.configured, streaming: asr.streaming }
    }, publicSession(call)));
    setState(conn, call, 'listening');
    return true;
  }

  function handleEvent(conn, msg) {
    if (msg.type === 'start') return start(conn, msg);
    const call = sessions.get(conn);
    if (!call) return false;
    if (call.state === 'ended' && msg.type !== 'hangup') return false;

    if (msg.type === 'speech_start') {
      if (call.state === 'thinking' || call.state === 'speaking') interrupt(conn, call, 'barge_in');
      call.asrGeneration += 1;
      call.audio = [];
      call.audioBytes = 0;
      call.capturing = true;
      startAsrSession(conn, call);
      send(conn, { type: 'speech_start', call_session_id: call.callSessionId, generation_id: call.asrGeneration });
      setState(conn, call, 'listening');
      return true;
    }
    if (msg.type === 'speech_end') {
      if (!call.capturing) return true;
      void finishSpeech(conn, call, '');
      return true;
    }
    if (msg.type === 'text') {
      void finishSpeech(conn, call, String(msg.text || '').trim());
      return true;
    }
    if (msg.type === 'greeting') {
      return speakGreeting(conn, call, msg);
    }
    if (msg.type === 'adapter_reply') {
      submitReply(conn, call, msg, { done: true });
      return true;
    }
    if (msg.type === 'adapter_reply_sentence') {
      submitReply(conn, call, msg, { done: msg.done === true });
      return true;
    }
    if (msg.type === 'interrupt') {
      interrupt(conn, call, 'user');
      return true;
    }
    if (msg.type === 'metrics') {
      if (debugOn) debugLog('client metrics: ' + JSON.stringify(msg));
      return true;
    }
    if (msg.type === 'hangup') {
      interrupt(conn, call, 'hangup');
      call.state = 'ended';
      send(conn, Object.assign({ type: 'hangup', call_session_id: call.callSessionId }, publicSession(call)));
      sessions.delete(conn);
      if (conn.session === call) conn.session = null;
      return true;
    }
    return false;
  }

  function handleBinary(conn, payload) {
    const call = sessions.get(conn);
    if (!call || !call.capturing || call.state === 'ended') return false;
    const maxSeconds = Math.max(5, Number(config.voiceAsr && config.voiceAsr.maxTurnSeconds) || 60);
    const maxBytes = SAMPLE_RATE * 2 * maxSeconds;
    if (call.audioBytes < maxBytes) {
      const chunk = payload.slice(0, maxBytes - call.audioBytes);
      call.audio.push(chunk);
      call.audioBytes += chunk.length;
      if (call.asrSession) { try { call.asrSession.pushAudio(chunk); } catch (e) { /* ignore per-chunk errors */ } }
    }
    return true;
  }

  function close(conn) {
    const call = sessions.get(conn);
    if (call) {
      call.state = 'ended';
      if (call.pendingTurn) call.pendingTurn.cancelled = true;
      call.capturing = false;
      call.ttsQueue = [];
      call.activeReply = null;
      call.ttsDraining = false;
      if (call.asrSession) { try { call.asrSession.cancel && call.asrSession.cancel(); call.asrSession.close && call.asrSession.close(); } catch (e) { /* ignore */ } call.asrSession = null; }
      sessions.delete(conn);
      if (conn.session === call) conn.session = null;
    }
  }

  return {
    handleEvent,
    handleBinary,
    close,
    publicSession,
    /* Exposed for diagnostics / tests. */
    splitSentences
  };
}

createVoiceRuntime.splitSentences = splitSentences;

module.exports = createVoiceRuntime;
