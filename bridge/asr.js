/* IB Bridge · ASR Provider interface.
   Two providers:
     - `openai-whisper`: turn-based. Upload one full WAV turn to an OpenAI-compatible
       /audio/transcriptions endpoint, get one final text. Never emits partials.
     - a deployer-wired `streaming` provider: createSession() returns a live session
       that the runtime feeds PCM chunks to; the session emits onPartial/onFinal.
   `streaming` is opt-in and explicitly declared (voiceAsr.streaming=true +
   voiceAsr.provider). When no streaming provider is wired, the runtime falls back
   to turn-based transcribe(). Nothing about the old provider changes.

   Separation of concerns:
     - This module owns ASR transport only. It never sees role context, model
       calls, tools, history, or memory (those stay in the browser chat runtime).
     - The runtime receives an `asr` object via deps (composed in
       ib-bridge-service.js). For tests we inject a fake `asr`. */
'use strict';

const SAMPLE_RATE = 16000;

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/* Turn-based default provider (OpenAI-compatible Whisper). */
async function openaiWhisperTranscribe(asr, pcm) {
  const form = new FormData();
  form.append('file', new Blob([wavFromPcm(pcm)], { type: 'audio/wav' }), 'turn.wav');
  form.append('model', String(asr.model));
  if (asr.language) form.append('language', String(asr.language));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(5000, Number(asr.timeoutMs) || 60000));
  try {
    const response = await fetch(String(asr.endpoint), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(asr.apiKey) },
      body: form,
      signal: ctrl.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('ASR failed (HTTP ' + response.status + '): ' + detail.slice(0, 160));
    }
    const data = await response.json();
    return String(data && data.text || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/* Registry of available ASR providers. `streaming` is a capability; the
   `openai-whisper` provider is not streamable and createSession returns null. */
const ASR_PROVIDER_REGISTRY = {
  'openai-whisper': {
    streaming: false,
    transcribe: (asr, pcm) => openaiWhisperTranscribe(asr, pcm),
    createSession: () => null
  }
};

function createAsr(config) {
  const asr = (config && config.voiceAsr) || {};
  const configured = !!(asr.enabled && asr.endpoint && asr.apiKey && asr.model);
  const provider = String(asr.provider || 'openai-whisper').toLowerCase();
  const impl = ASR_PROVIDER_REGISTRY[provider] || ASR_PROVIDER_REGISTRY['openai-whisper'];
  /* streaming only when explicitly declared AND the provider actually streams */
  const streaming = asr.streaming === true && !!impl.streaming;

  return {
    provider,
    configured,
    streaming,

    /* Turn-based transcription. Throws when not configured so callers surface a
       consistent error. */
    transcribe(pcm) {
      if (!configured) throw new Error('Voice ASR is not configured in bridge config.json');
      return impl.transcribe(asr, pcm);
    },

    /* Streaming session factory. Returns null when not supported (the default).
       When a deployer wires a real streaming provider they register it in
       ASR_PROVIDER_REGISTRY; its createSession returns a session shaped as:
         {
           pushAudio(pcm) -> void,          // feed 16k mono PCM16 chunks
           finalize() -> Promise<string>,   // flush and resolve the final transcript
           cancel() -> void,                // discard partials / abort the stream
           close() -> void                  // tear down the transport
         }
       plus onPartial/onFinal/onError callbacks passed to createSession. */
    createSession(callbacks) {
      if (!streaming) return null;
      const s = impl.createSession(asr, callbacks);
      return s || null;
    }
  };
}

/* Register a streaming provider adapter (used by deployers / tests). */
createAsr.register = function register(providerId, spec) {
  ASR_PROVIDER_REGISTRY[String(providerId).toLowerCase()] = spec;
};

createAsr.wavFromPcm = wavFromPcm;

module.exports = createAsr;
