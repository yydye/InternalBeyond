/* IB Bridge · ASR Provider interface.
   Providers:
     - `openai-whisper`: turn-based. Upload one full WAV turn to an OpenAI-compatible
       /audio/transcriptions endpoint, get one final text. Never emits partials.
     - `voicebox`: turn/file-based. Uploads validated audio bytes through the Bridge
       to Voicebox only after a read-only cached-model preflight.
     - a deployer-wired `streaming` provider: createSession() returns a live session
       that the runtime feeds PCM chunks to; the session emits onPartial/onFinal.
   `streaming` is opt-in and explicitly declared (voiceAsr.streaming=true +
   voiceAsr.provider). When no streaming provider is wired, the runtime falls back
   to turn-based transcribe(). Nothing about the old provider changes.

   Separation of concerns:
     - This module owns ASR transport only. It never sees role context, model
       calls, tools, history, or memory (those stay in the browser chat runtime).
     - The runtime receives an `asr` object via deps (composed in
       services/ib-bridge-service.js). For tests we inject a fake `asr`. */
'use strict';

const SAMPLE_RATE = 16000;
const DEFAULT_MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const WHISPER_MODELS = new Set(['tiny', 'base', 'small', 'medium', 'large', 'turbo']);
const AUDIO_EXTENSIONS = Object.freeze({
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aac': 'aac',
  'audio/webm': 'webm', 'audio/opus': 'opus'
});

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

function asrError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status || 400;
  return error;
}

function normalizeVoiceboxAudio(audio, maxBytes) {
  let bytes;
  let mime;
  let filename;
  if (Buffer.isBuffer(audio)) {
    /* Existing Bridge ASR callers supply 16 kHz mono PCM16 turns. */
    if (!audio.length || audio.length % 2 !== 0) {
      throw asrError('INVALID_AUDIO', 'Voicebox ASR expects non-empty PCM16 audio.');
    }
    if (audio.length > maxBytes) {
      throw asrError('AUDIO_TOO_LARGE', 'Audio exceeds the Bridge ASR size limit.', 413);
    }
    bytes = wavFromPcm(audio);
    mime = 'audio/wav';
    filename = 'turn.wav';
  } else if (audio && typeof audio === 'object') {
    bytes = Buffer.isBuffer(audio.bytes) ? audio.bytes : null;
    mime = String(audio.mime || '').split(';')[0].trim().toLowerCase();
    const ext = AUDIO_EXTENSIONS[mime];
    if (!ext) throw asrError('INVALID_AUDIO', 'Unsupported audio content type.');
    if (!bytes || !bytes.length) throw asrError('INVALID_AUDIO', 'Audio bytes are required.');
    if (bytes.length > maxBytes) {
      throw asrError('AUDIO_TOO_LARGE', 'Audio exceeds the Bridge ASR size limit.', 413);
    }
    filename = 'upload.' + ext;
  } else {
    throw asrError('INVALID_AUDIO', 'Audio bytes are required.');
  }
  if (bytes.length > maxBytes) {
    throw asrError('AUDIO_TOO_LARGE', 'Audio exceeds the Bridge ASR size limit.', 413);
  }
  return { bytes, mime, filename };
}

function canonicalWhisperModel(value) {
  return String(value || '').trim().toLowerCase().replace(/^whisper[-_ ]?/, '');
}

function isLoopbackEndpoint(value) {
  try {
    const url = new URL(String(value || ''));
    const host = String(url.hostname || '').toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
  } catch (error) { return false; }
}

async function voiceboxWhisperTranscribe(asr, audio, options, voicebox) {
  const maxBytes = Math.max(1024, Number(asr.maxAudioBytes) || DEFAULT_MAX_AUDIO_BYTES);
  const input = normalizeVoiceboxAudio(audio, maxBytes);
  const model = String((options && options.model) || asr.voiceboxModel || 'base').trim().toLowerCase();
  if (!WHISPER_MODELS.has(model)) {
    throw asrError('ASR_MODEL_UNAVAILABLE', 'Unsupported Voicebox Whisper model: ' + model, 503);
  }
  if (voicebox && typeof voicebox.isEnabled === 'function' && !voicebox.isEnabled()) {
    throw asrError('ASR_UNAVAILABLE', 'Voicebox is disabled in Bridge configuration.', 503);
  }
  const base = voicebox && typeof voicebox.endpoint === 'function'
    ? String(voicebox.endpoint() || '')
    : String(asr.voiceboxEndpoint || '');
  if (!isLoopbackEndpoint(base)) {
    throw asrError('ASR_UNAVAILABLE', 'Voicebox ASR is restricted to a localhost runtime.', 503);
  }
  const timeoutMs = Math.max(5000, Number(asr.timeoutMs) || 60000);

  /* REST /transcribe starts an asynchronous model download on a cache miss.
     Never call it until /models/status confirms the selected model is cached. */
  let statusResponse;
  let statusTimer;
  const statusController = new AbortController();
  try {
    statusTimer = setTimeout(() => statusController.abort(), timeoutMs);
    statusResponse = await fetch(base.replace(/\/+$/, '') + '/models/status', {
      method: 'GET', signal: statusController.signal
    });
  } catch (error) {
    throw asrError('ASR_UNAVAILABLE', 'Voicebox model status is unavailable.', 503);
  } finally {
    clearTimeout(statusTimer);
  }
  if (!statusResponse || !statusResponse.ok) {
    throw asrError('ASR_UNAVAILABLE', 'Voicebox model status is unavailable.', 503);
  }
  let status;
  try { status = await statusResponse.json(); }
  catch (error) { throw asrError('ASR_UNAVAILABLE', 'Voicebox model status returned invalid JSON.', 503); }
  const models = Array.isArray(status && status.models) ? status.models : [];
  const cached = models.some(function (item) {
    return item && item.downloaded === true && canonicalWhisperModel(item.model_name) === model;
  });
  if (!cached) {
    throw asrError('ASR_MODEL_UNAVAILABLE', 'Voicebox Whisper model is not cached: ' + model, 503);
  }

  const form = new FormData();
  form.append('file', new Blob([input.bytes], { type: input.mime }), input.filename);
  form.append('model', model);
  const language = String((options && options.language) || asr.language || '').trim();
  if (language && language.toLowerCase() !== 'auto') form.append('language', language);

  let response;
  let timer;
  const controller = new AbortController();
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    response = await fetch(base.replace(/\/+$/, '') + '/transcribe', {
      method: 'POST', body: form, signal: controller.signal
    });
  } catch (error) {
    throw asrError('ASR_UNAVAILABLE', 'Voicebox transcription request failed.', 503);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 202) {
    /* Defensive handling for a cache/status race. This should not be reached
       for a cached model; do not treat the background download as success. */
    throw asrError('ASR_MODEL_UNAVAILABLE', 'Voicebox began downloading the selected model; transcription was rejected.', 503);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw asrError('ASR_UNAVAILABLE', 'Voicebox transcription failed (HTTP ' + response.status + '): ' + String(detail || '').slice(0, 160), 502);
  }
  let result;
  try { result = await response.json(); }
  catch (error) { throw asrError('ASR_UNAVAILABLE', 'Voicebox transcription returned invalid JSON.', 502); }
  if (!result || typeof result.text !== 'string') {
    throw asrError('ASR_UNAVAILABLE', 'Voicebox transcription response did not contain text.', 502);
  }
  const output = { text: result.text.trim(), provider: 'voicebox', model };
  if (Number.isFinite(Number(result.duration))) output.duration = Number(result.duration);
  if (language && language.toLowerCase() !== 'auto') output.language = language;
  return output;
}

/* Registry of available ASR providers. `streaming` is a capability; the
   `openai-whisper` provider is not streamable and createSession returns null. */
const ASR_PROVIDER_REGISTRY = {
  'openai-whisper': {
    streaming: false,
    capabilities: { streaming: false, partialResults: false, cancellation: false, timestamps: false },
    transcribe: (asr, audio) => openaiWhisperTranscribe(asr, audio),
    createSession: () => null
  },
  voicebox: {
    streaming: false,
    capabilities: { streaming: false, partialResults: false, cancellation: false, timestamps: false },
    transcribe: (asr, audio, options, deps) => voiceboxWhisperTranscribe(asr, audio, options, deps.voicebox),
    createSession: () => null
  }
};

function createAsr(config, deps) {
  const asr = (config && config.voiceAsr) || {};
  const provider = String(asr.provider || 'openai-whisper').toLowerCase();
  const impl = ASR_PROVIDER_REGISTRY[provider] || null;
  const configured = !!(asr.enabled && impl && (provider === 'voicebox'
    ? (!!(deps && deps.voicebox) && (typeof deps.voicebox.isEnabled !== 'function' || deps.voicebox.isEnabled()))
    : provider === 'openai-whisper'
      ? (asr.endpoint && asr.apiKey && asr.model)
      : true));
  /* streaming only when explicitly declared AND the provider actually streams */
  const streaming = asr.streaming === true && !!(impl && impl.streaming);

  return {
    provider,
    configured,
    streaming,
    maxAudioBytes: Math.max(1024, Number(asr.maxAudioBytes) || DEFAULT_MAX_AUDIO_BYTES),
    supportedAudioTypes: Object.keys(AUDIO_EXTENSIONS),

    capabilities() {
      if (!impl) return { streaming: false, partialResults: false, cancellation: false, timestamps: false };
      return Object.assign({}, impl.capabilities || {
        streaming: !!impl.streaming,
        partialResults: !!impl.streaming,
        cancellation: !!impl.streaming,
        timestamps: false
      });
    },

    /* Turn-based transcription. Throws when not configured so callers surface a
       consistent error. */
    transcribe(audio, options) {
      if (!impl) throw asrError('ASR_PROVIDER_UNAVAILABLE', 'Unknown ASR provider: ' + provider, 503);
      if (!configured) throw new Error('Voice ASR is not configured in bridge config.json');
      return impl.transcribe(asr, audio, options || {}, deps || {});
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
createAsr.normalizeVoiceboxAudio = normalizeVoiceboxAudio;
createAsr.DEFAULT_MAX_AUDIO_BYTES = DEFAULT_MAX_AUDIO_BYTES;
createAsr.AUDIO_EXTENSIONS = AUDIO_EXTENSIONS;
createAsr.isLoopbackEndpoint = isLoopbackEndpoint;

module.exports = createAsr;
