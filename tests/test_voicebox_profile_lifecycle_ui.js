'use strict';

/* Deterministic guards for the Voicebox profile UI and its shared microphone path.
   Runtime profile CRUD and TTS transport are exercised separately in
   test_voicebox_provider.js with a local Voicebox mock. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const voiceSource = fs.readFileSync(path.join(ROOT, 'assets/js/communication/voice.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(ROOT, 'assets/js/voicebox-profile-manager.js'), 'utf8');
const socialSource = fs.readFileSync(path.join(ROOT, 'assets/js/social.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
const voiceboxPageSource = fs.readFileSync(path.join(ROOT, 'assets/js/voicebox-page.js'), 'utf8');
const bridgeRoutesSource = fs.readFileSync(path.join(ROOT, 'bridge/routes.js'), 'utf8');
const voiceboxAdapterSource = fs.readFileSync(path.join(ROOT, 'bridge/voicebox.js'), 'utf8');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (error) { fail++; console.error('  FAIL  ' + name + ' -> ' + (error && error.message || error)); }
}

function makeElement() {
  const nested = { textContent: '' };
  return {
    style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
    hidden: false, innerHTML: '', textContent: '',
    appendChild(child) { this.children.push(child); },
    querySelector() { return nested; },
    remove() { this.removed = true; },
    setAttribute() {}
  };
}

function loadVoice(options) {
  options = options || {};
  const elements = new Map();
  let mediaRequests = 0, dbReads = 0, sends = 0, toasts = [];
  const stream = { getTracks: () => [{ stop() { stream.stopped = (stream.stopped || 0) + 1; } }] };
  class FakeRecorder {
    constructor(_stream, opts) { this.state = 'inactive'; this.mimeType = opts && opts.mimeType || 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
    static isTypeSupported() { return true; }
  }
  const fakeBuffer = {
    sampleRate: 16000, numberOfChannels: 1, length: 32000, duration: 2,
    getChannelData() { return new Float32Array(32000).fill(0.1); }
  };
  class FakeAudioContext {
    decodeAudioData(_buffer, success) { success(fakeBuffer); }
  }
  const win = { MediaRecorder: FakeRecorder, AudioContext: FakeAudioContext, console };
  const ib = {
    expose(name, api) {
      const bits = name.split('.');
      let obj = ib;
      while (bits.length > 1) { const key = bits.shift(); obj = obj[key] || (obj[key] = {}); }
      obj[bits[0]] = api;
    },
    voiceCall: { getCurrent: () => options.activeCall ? { state: 'listening' } : null }
  };
  win.IB = ib;
  const sandbox = {
    window: win, navigator: { mediaDevices: { async getUserMedia() { mediaRequests++; if (options.permissionDenied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); return stream; } } },
    document: {
      getElementById(id) { return elements.get(id) || null; },
      querySelector() { return null; },
      createElement() { return makeElement(); },
      body: { appendChild(el) { if (el.id) elements.set(el.id, el); } }
    },
    MediaRecorder: FakeRecorder, Blob, ArrayBuffer, Uint8Array, Int16Array, Float32Array, DataView,
    Math, Date, Number, String, JSON, Promise, URL, console,
    atob(value) { return Buffer.from(String(value), 'base64').toString('binary'); },
    btoa(value) { return Buffer.from(String(value), 'binary').toString('base64'); },
    setInterval() { return 7; }, clearInterval() {}, setTimeout() { return 8; }, clearTimeout() {},
    dbGet: async function () { dbReads++; return null; },
    toast: function (message) { toasts.push(String(message)); },
    sendChatMessage: function () { sends++; }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(voiceSource, sandbox, { filename: 'voice.js' });
  return { win, sandbox, stream, toasts, counts: () => ({ mediaRequests, dbReads, sends }) };
}

function fakeButton() { return { classList: { add() {}, remove() {} } }; }

async function recorderCaptureCheck() {
  const env = loadVoice();
  let capture = null, error = null;
  const start = env.win._vmStart(fakeButton(), {
    purpose: 'reference',
    onReferenceCapture(value) { capture = value; },
    onReferenceError(value) { error = value; }
  });
  await start;
  const state = env.win._vmSt;
  assert(state && state.purpose === 'reference');
  state.rec.ondataavailable({ data: new Blob(['recorded sample'], { type: 'audio/webm' }) });
  state.start = Date.now() - 2500;
  await env.win._vmFinish(state);
  assert.strictEqual(error, null);
  assert(capture && capture.blob.size > 0);
  assert.strictEqual(capture.mime, 'audio/webm;codecs=opus');
  assert.strictEqual(env.stream.stopped, 1);
  assert.deepStrictEqual(env.counts(), { mediaRequests: 1, dbReads: 0, sends: 0 });
}

async function permissionCheck() {
  const env = loadVoice({ permissionDenied: true });
  let error = null;
  await env.win._vmStart(fakeButton(), { purpose: 'reference', onReferenceError(value) { error = value; } });
  assert(error && /无法访问麦克风|浏览器权限/.test(error.message), String(error && error.message || error));
  assert.strictEqual(env.win._vmSt, null);
  assert.strictEqual(env.counts().sends, 0);
}

async function callOwnershipCheck() {
  const env = loadVoice({ activeCall: true });
  let error = null;
  await env.win._vmStart(fakeButton(), { purpose: 'reference', onReferenceError(value) { error = value; } });
  assert(error && /语音通话正在使用麦克风/.test(error.message));
  assert.strictEqual(env.counts().mediaRequests, 0);
  assert.strictEqual(env.counts().sends, 0);
}

async function shortRecordingCheck() {
  const env = loadVoice();
  let capture = 0, error = '';
  const state = { purpose: 'reference', released: false, timer: null, btn: fakeButton(), rec: { state: 'inactive' },
    stream: { getTracks: () => [{ stop() {} }] }, chunks: [new Blob(['x'])], mime: 'audio/webm', start: Date.now() - 500,
    onReferenceCapture() { capture++; }, onReferenceError(e) { error = e.message; } };
  env.win._vmSt = state;
  await env.win._vmFinish(state);
  assert.strictEqual(capture, 0);
  assert(/至少需要 2 秒/.test(error));
  assert.strictEqual(env.counts().sends, 0);
}

(async function main() {
  await check('reference recorder reuses MediaRecorder and returns a local Blob', () => recorderCaptureCheck());
  await check('reference recording bypasses VoiceTranscription and chat send', () => recorderCaptureCheck());
  await check('microphone permission failure is returned to the UI', () => permissionCheck());
  await check('reference recording refuses to compete with Voice Call microphone', () => callOwnershipCheck());
  await check('reference capture enforces the upstream 2 second minimum', () => shortRecordingCheck());

  await check('recorded WebM converts locally to 16 kHz WAV', async () => {
    const conversion = loadVoice();
    const wav = await conversion.win._vmReferenceBlobToWav(new Blob(['recording'], { type: 'audio/webm' }));
    const header = Buffer.from(await wav.arrayBuffer());
    assert.strictEqual(wav.type, 'audio/wav');
    assert.strictEqual(header.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(header.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(header.readUInt32LE(24), 16000);
  });

  await check('Voicebox clone workflow exposes reference, permission, progress, cancel, preview and bind controls', () => {
    for (const id of ['api-voicebox-manager-backdrop', 'api-voicebox-reference-file', 'api-voicebox-record-btn', 'api-voicebox-reference-preview', 'api-voicebox-create-btn', 'api-voicebox-create-consent', 'api-voicebox-create-cancel-btn', 'api-voicebox-cancel-preview', 'api-voicebox-bind-btn']) assert(htmlSource.includes('id="' + id + '"'), id);
    assert(/accept="\.wav,\.mp3,audio\/wav,audio\/mpeg"/.test(htmlSource));
    assert(htmlSource.includes('我确认有权使用这段声音'));
    assert(htmlSource.includes('Voicebox Provider'));
    assert(managerSource.includes('document.body.appendChild(modal)'));
  });
  await check('Voicebox page has a capability-gated clone entry and destination disclosure', () => {
    assert(htmlSource.includes('data-page="voicebox"'));
    for (const id of ['page-voicebox', 'voicebox-asr-provider', 'voicebox-tts-provider', 'voicebox-current-profile', 'voicebox-profile-list', 'voicebox-role-voice-list', 'voicebox-clone-open', 'voicebox-clone-engines', 'voicebox-clone-destination']) {
      assert(htmlSource.includes('id="' + id + '"'), id);
    }
    assert(voiceboxPageSource.includes('caps.engines[key].clone === true'));
    assert(voiceboxPageSource.includes("api.open()"));
    assert(htmlSource.includes('assets/js/voicebox-page.js'));
    assert(htmlSource.includes('assets/css/voicebox-page.css'));
  });
  await check('Voicebox page delegates audition and role binding to existing Voicebox and API editor paths', () => {
    assert(voiceboxPageSource.includes('api.preview('));
    assert(voiceboxPageSource.includes('api.bind('));
    assert(voiceboxPageSource.includes('window.editApi('));
    assert(voiceboxPageSource.includes('window.testCharacterVoice()'));
    assert(!/request\(['"]\/api\/tts/.test(voiceboxPageSource));
    assert(!/sendChatMessage|chatMessages|Memory|WorkMode|agentRuntime/i.test(voiceboxPageSource));
  });
  await check('Voice Library uses a fixed HTTPS Manifest, verifies downloaded bytes, and imports through the Voicebox Profile owner', () => {
    const library = fs.readFileSync(path.join(ROOT, 'assets/js/voicebox-library-core.js'), 'utf8');
    assert(library.includes('https://dl.chatvault.top/voice-library/voice-library-stable.json'));
    assert(library.includes('resource-size-mismatch') && library.includes('resource-sha256-mismatch'));
    assert(voiceboxPageSource.includes('credentials: \'omit\''));
    assert(voiceboxPageSource.includes('redirect: \'error\''));
    assert(voiceboxPageSource.includes('core.verifyResourceBytes'));
    assert(voiceboxPageSource.includes('api.importPresetProfile('));
    assert(!/audioData|apiKey|credential|chatMessages/i.test(library));
  });
  await check('Voice Profile packages are limited to supported Voicebox preset metadata, excluding clone samples', () => {
    assert(managerSource.includes('async function importPresetVoiceboxProfile'));
    assert(managerSource.includes('listPresetVoiceboxVoices(engine)'));
    assert(managerSource.includes("voiceType: 'preset'"));
    assert(managerSource.includes('presetVoices: listPresetVoiceboxVoices'));
    assert(voiceboxPageSource.includes('profile.voiceType') && voiceboxPageSource.includes("!== 'preset'"));
  });
  await check('clone/preset engine choices derive from Bridge capabilities', () => {
    assert(managerSource.includes('cap.clone === true'));
    assert(managerSource.includes('cap.preset === true'));
    assert(managerSource.includes("request('/api/tts/voicebox/presets/'"));
  });
  await check('reference audio stays local until explicit authorization and remote Providers are disclosed', () => {
    assert(managerSource.includes('function referenceDestinationCopy()'));
    assert(managerSource.includes('reference.localEndpoint'));
    assert(managerSource.includes('远程地址'));
    assert(managerSource.includes('!byId(\'api-voicebox-create-consent\').checked'));
    assert(managerSource.includes('!consent.checked'));
    assert(voiceboxAdapterSource.includes('localEndpoint: endpointIsLoopback(endpoint())'));
    assert(bridgeRoutesSource.includes('referenceAudio: Object.assign({}, caps.referenceAudio'));
  });
  await check('create flow creates, uploads, rolls back, and never silently binds', () => {
    const create = managerSource.slice(managerSource.indexOf('async function createVoiceboxProfile'), managerSource.indexOf('function renderProfileList'));
    const createAt = create.indexOf("request('/api/tts/voicebox/profiles'");
    const uploadAt = create.indexOf("await uploadSample(profile.id, 'create', { signal: cancellation.signal })");
    const rollbackAt = create.indexOf("{ method: 'DELETE' }");
    assert(createAt >= 0 && uploadAt > createAt && rollbackAt > uploadAt);
    assert(create.includes('步骤 2/3') && create.includes('步骤 3/3'));
    assert(managerSource.includes('function cancelVoiceboxProfileCreate()'));
    assert(!/bindVoiceboxProfile|saveCurrentApi/.test(create));
    assert(create.includes('Incomplete Profile 保留') || create.includes('空 Profile 已清理'));
  });
  await check('preview reuses Bridge TTS seam and never enters chat or memory flow', () => {
    assert(managerSource.includes('IB.bridge.ttsPayload(voice, text)'));
    assert(managerSource.includes('payload.preview = true'));
    assert(managerSource.includes('signal: controller.signal'));
    assert(bridgeRoutesSource.includes('context.signal = cancellation.signal'));
    assert(bridgeRoutesSource.includes('clientCancellation(req, res)'));
    assert(managerSource.includes('cancelPreview: cancelVoiceboxPreview'));
    assert(!/sendChatMessage|dbPut\(|middleBrain|MiddleBrain|Memory/.test(managerSource));
  });
  await check('profile binding is explicit and uses the current editor save path', () => {
    const bind = managerSource.slice(managerSource.indexOf('async function bindVoiceboxProfile'), managerSource.indexOf('function bindSelectedVoiceboxProfile'));
    assert(bind.includes("provider.value = 'voicebox'"));
    assert(bind.includes('window.IB && window.IB.social'));
    assert(bind.includes('setVoiceId(profile.id)'));
    assert(bind.includes('saveCurrentApi'));
    assert(bind.includes('saveCurrentApi(null)'));
    assert(!bind.includes('profile.name'));
    assert(socialSource.includes("source:(function(){var p=document.getElementById('api-voice-provider')"));
  });
  await check('role binding preserves non-Voicebox voiceType and voiceData fields', () => {
    assert(socialSource.includes("voiceType:_pvVoicebox?(_pv.voiceType||'builtin'):_pvType"));
    assert(socialSource.includes('voiceData:_pvVoicebox?(_pv.voiceData!=null?_pv.voiceData:null):_pvData'));
  });
  await check('dangling profile IDs stay visible and are never name-matched', () => {
    assert(socialSource.includes("'音色不可用 · '+cur"));
    assert(managerSource.includes("'重新绑定并保存当前角色'"));
    assert(!/profile\.name\s*===|name\s*===\s*profile\.name/.test(managerSource));
  });
  await check('delete warning scans active and archived roles without rewriting their voice', () => {
    const start = managerSource.indexOf('function referencedRoles');
    const end = managerSource.indexOf('async function deleteVoiceboxProfile', start);
    const body = managerSource.slice(start, end);
    assert(body.includes('apiConfigs'));
    assert(body.includes('archivedConfigs'));
    const delStart = managerSource.indexOf('async function deleteVoiceboxProfile');
    const delEnd = managerSource.indexOf('async function openSampleManager', delStart);
    const deleteBody = managerSource.slice(delStart, delEnd);
    assert(deleteBody.includes('window.confirm'));
    assert(!/\.voice\s*=|voiceId\s*=/.test(deleteBody));
  });
  await check('profile and sample responses do not expose Voicebox audio paths', () => {
    assert(/function sanitizeProfile/.test(fs.readFileSync(path.join(ROOT, 'bridge/voicebox.js'), 'utf8')));
    const adapter = fs.readFileSync(path.join(ROOT, 'bridge/voicebox.js'), 'utf8');
    assert(adapter.includes('function sanitizeSample'));
    assert(adapter.includes('referenceText: String(s.reference_text || \'\')'));
    assert(!managerSource.includes('audio_path'));
  });
  await check('Voicebox profile identity stores only source and external voiceId', () => {
    assert(socialSource.includes('voiceId:_voiceGetId()'));
    assert(!socialSource.includes('voiceboxProfileId'));
  });
  await check('sample transcript and audio are never persisted into IB profile storage', () => {
    assert(managerSource.includes("headers: { 'Content-Type': ref.mime }, body: ref.blob"));
    assert(!/dbPut\(|localStorage\.setItem|indexedDB/.test(managerSource));
  });
  await check('stored Voicebox samples play through Bridge without direct localhost access', () => {
    assert(managerSource.includes("'/api/tts/voicebox/samples/' + encodeURIComponent(sample.id) + '/audio'"));
    assert(managerSource.includes('URL.createObjectURL(blob)'));
    assert(!/http:\/\/127\.0\.0\.1:17493|localhost:17493/.test(managerSource));
  });

  console.log('\n' + (fail === 0 ? 'Voicebox profile UI test passed ✔ (' + pass + ')' : 'Voicebox profile UI test FAILED (' + fail + ')'));
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
