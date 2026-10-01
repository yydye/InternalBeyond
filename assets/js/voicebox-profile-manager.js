/* Voicebox-owned profile lifecycle UI. Profile bytes and records stay in Voicebox;
   this file keeps only a per-page discovery cache and a local pending sample. */
(function (root) {
  'use strict';

  var profiles = [];
  var capabilities = null;
  var models = null;
  var available = false;
  var runtimeChecked = false;
  var capabilityRequest = null;
  var capabilitiesAttempted = false;
  var sampleProfileId = '';
  var pending = { create: null, sample: null };
  var previewUrls = { create: '', sample: '' };
  var storedSampleUrls = [];
  var recording = null;
  var previewAudio = null;

  function byId(id) { return document.getElementById(id); }
  function setText(id, value) { var el = byId(id); if (el) el.textContent = String(value || ''); }
  function setHidden(el, hidden) { if (el) { el.hidden = !!hidden; if (!hidden && el.style.display === 'none') el.style.display = ''; } }
  function button(label, action, disabled) {
    var el = document.createElement('button');
    el.type = 'button'; el.className = 'btn'; el.textContent = label; el.disabled = !!disabled;
    el.addEventListener('click', action);
    return el;
  }
  function bridgeUrl(path) { return String(ibBridgeBase()).replace(/\/+$/, '') + path; }
  async function request(path, options) {
    var response = await ibBridgeFetch(bridgeUrl(path), options || {});
    var data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok || !data || data.ok === false) {
      throw new Error(String(data && data.error || ('Bridge request failed (' + (response && response.status || 'network') + ')')));
    }
    return data;
  }
  function idProfiles() {
    return Array.isArray(window._ibVoiceboxProfiles) ? window._ibVoiceboxProfiles : profiles;
  }
  function findProfile(id) {
    return idProfiles().find(function (p) { return String(p.id) === String(id); }) || null;
  }
  function engineCapabilities(engine) {
    return capabilities && capabilities.engines && capabilities.engines[engine] || null;
  }
  function defaultModel(profile) {
    var engine = String(profile && (profile.defaultEngine || profile.presetEngine) || '');
    var cap = engineCapabilities(engine);
    return cap && Array.isArray(cap.models) ? cap.models.find(function (m) { return m.ibDefault === true && m.ibSelectable !== false; }) || null : null;
  }
  function modelState(profile) {
    var required = defaultModel(profile);
    if (!runtimeChecked || !Array.isArray(models)) return { label: '模型状态未知', ready: false, known: false };
    if (!required) return { label: '模型映射未知', ready: false, known: false };
    var model = models.find(function (m) { return m.name === required.name; });
    if (!model) return { label: '模型状态未知', ready: false, known: false };
    if (model.downloading) return { label: '模型正在下载', ready: false, known: true };
    return model.downloaded
      ? { label: '模型已安装', ready: true, known: true }
      : { label: '模型未安装', ready: false, known: true };
  }
  function profileIncomplete(profile) {
    return String(profile && profile.voiceType) === 'cloned' && Number(profile.sampleCount || 0) < 1;
  }
  function setCachedProfiles(list, status) {
    profiles = Array.isArray(list) ? list : [];
    try { window._ibVoiceboxProfiles = profiles; window._ibVoiceboxProfilesStatus = status; } catch (e) {}
    var select = byId('api-voice-select');
    if (select && typeof window._voiceSyncVoiceboxProfiles === 'function') window._voiceSyncVoiceboxProfiles(select);
    syncRoleControls();
  }
  function ensureCapabilities() {
    if (capabilities || capabilityRequest || capabilitiesAttempted) return;
    capabilitiesAttempted = true;
    capabilityRequest = request('/api/tts/voicebox/capabilities').then(function (data) {
      capabilities = data;
      capabilityRequest = null;
      fillCreateEngines();
      if (typeof window._voiceSyncCapabilityFields === 'function') window._voiceSyncCapabilityFields();
    }).catch(function () { capabilityRequest = null; });
  }
  function syncRoleControls() {
    var profileStatus = String(window._ibVoiceboxProfilesStatus || 'unknown');
    if (profileStatus === 'ready' || profileStatus === 'empty') { runtimeChecked = true; available = true; }
    else if (profileStatus === 'unavailable') { runtimeChecked = true; available = false; }
    var provider = byId('api-voice-provider');
    if (!provider || provider.value !== 'voicebox') return;
    ensureCapabilities();
    var select = byId('api-voice-select');
    var id = String(select && select.value || '');
    var profile = findProfile(id);
    var status = byId('api-voicebox-role-status');
    var preview = byId('api-voicebox-preview-btn');
    var bind = byId('api-voicebox-bind-btn');
    var ready = !!profile && available && !profileIncomplete(profile) && modelState(profile).ready;
    if (preview) preview.disabled = !ready;
    if (bind) {
      bind.disabled = !profile || profileIncomplete(profile) || !available;
      bind.textContent = id && !profile ? '重新绑定并保存当前角色' : '绑定并保存当前角色';
    }
    if (status) {
      if (!runtimeChecked) status.textContent = 'Voicebox 状态尚未检测；可打开本地音色管理重新检测。';
      else if (!available) status.textContent = 'Voicebox runtime unavailable；保留当前角色的 profile ID。';
      else if (!id) status.textContent = '请选择一个 Voicebox profile。';
      else if (!profile) status.textContent = '音色不可用：已保存的 profile ID ' + id + ' 当前不存在。请从列表显式重新绑定。';
      else if (profileIncomplete(profile)) status.textContent = '克隆音色不完整：还没有有效参考样本，请修复或删除。';
      else {
        var state = modelState(profile);
        status.textContent = state.label === '模型已安装' ? 'Voicebox 可用 · ' + state.label : 'Voicebox 可用 · ' + state.label + '；不会自动下载模型。';
      }
    }
  }
  async function refreshVoiceboxProfileManager(buttonEl) {
    if (buttonEl) buttonEl.disabled = true;
    setText('api-voicebox-manager-status', '正在通过 IB Bridge 检测 Voicebox…');
    runtimeChecked = true; available = false;
    var results = await Promise.allSettled([
      request('/api/tts/voicebox/health'),
      request('/api/tts/voicebox/profiles'),
      request('/api/tts/voicebox/capabilities'),
      request('/api/tts/voicebox/models')
    ]);
    var health = results[0].status === 'fulfilled' ? results[0].value : null;
    var profileResult = results[1].status === 'fulfilled' ? results[1].value : null;
    capabilities = results[2].status === 'fulfilled' ? results[2].value : null;
    capabilitiesAttempted = true;
    models = results[3].status === 'fulfilled' && Array.isArray(results[3].value.models) ? results[3].value.models : null;
    available = !!(health && health.ok && profileResult && profileResult.ok && Array.isArray(profileResult.profiles));
    if (available) {
      setCachedProfiles(profileResult.profiles, profileResult.profiles.length ? 'ready' : 'empty');
      setText('api-voicebox-manager-status', 'Voicebox runtime 可用。IB 只读取模型安装状态，不会启动下载。');
    } else {
      setCachedProfiles([], 'unavailable');
      var failed = results.find(function (r) { return r.status === 'rejected'; });
      setText('api-voicebox-manager-status', 'Voicebox runtime unavailable' + (failed ? '：' + String(failed.reason && failed.reason.message || failed.reason) : '。角色配置与已保存 profile ID 未更改。'));
    }
    fillCreateEngines();
    renderProfileList();
    if (sampleProfileId) await openSampleManager(sampleProfileId, true);
    syncRoleControls();
    if (buttonEl) buttonEl.disabled = false;
    return available;
  }
  function openVoiceboxProfileManager() {
    var modal = byId('api-voicebox-manager-backdrop');
    if (modal) { modal.hidden = false; modal.style.display = 'flex'; }
    fillCreateEngines();
    refreshVoiceboxProfileManager();
  }
  function closeVoiceboxProfileManager() {
    var modal = byId('api-voicebox-manager-backdrop');
    if (recording) stopReferenceRecording();
    clearStoredSamplePreviews();
    if (modal) { modal.hidden = true; modal.style.display = 'none'; }
  }
  function clearStoredSamplePreviews() {
    storedSampleUrls.forEach(function (url) { try { URL.revokeObjectURL(url); } catch (e) {} });
    storedSampleUrls = [];
    var panel = byId('api-voicebox-sample-manager');
    if (panel) Array.prototype.slice.call(panel.querySelectorAll('audio[data-voicebox-sample-preview]')).forEach(function (audio) { try { audio.pause(); } catch (e) {} });
  }
  function fillSelect(el, values, selected, labelOf) {
    if (!el) return;
    el.textContent = '';
    (values || []).forEach(function (value) {
      var option = document.createElement('option');
      option.value = typeof value === 'string' ? value : value.id;
      option.textContent = labelOf ? labelOf(value) : String(value);
      el.appendChild(option);
    });
    if (selected && (values || []).some(function (v) { return (typeof v === 'string' ? v : v.id) === selected; })) el.value = selected;
  }
  function fillCreateEngines() {
    var type = byId('api-voicebox-create-type');
    var engineSelect = byId('api-voicebox-create-engine');
    var profileType = String(type && type.value || 'cloned');
    var old = String(engineSelect && engineSelect.value || '');
    var engines = capabilities && capabilities.engines || {};
    var choices = Object.keys(engines).filter(function (engine) {
      var cap = engines[engine];
      return profileType === 'cloned' ? cap.clone === true : cap.preset === true;
    });
    fillSelect(engineSelect, choices, old);
    voiceboxCreateTypeChanged(false);
  }
  function voiceboxCreateTypeChanged(reload) {
    var type = byId('api-voicebox-create-type');
    var preset = String(type && type.value || 'cloned') === 'preset';
    var presetWrap = byId('api-voicebox-preset-wrap');
    var ref = byId('api-voicebox-reference-fields');
    if (presetWrap) presetWrap.style.display = preset ? '' : 'none';
    if (ref) ref.style.display = preset ? 'none' : '';
    if (reload !== false) fillCreateEngines();
    else voiceboxCreateEngineChanged();
  }
  async function voiceboxCreateEngineChanged() {
    var type = byId('api-voicebox-create-type');
    var engine = String(byId('api-voicebox-create-engine') && byId('api-voicebox-create-engine').value || '');
    var cap = engineCapabilities(engine);
    var languages = cap && Array.isArray(cap.languages) ? cap.languages : [];
    fillSelect(byId('api-voicebox-create-language'), languages, languages[0] || '');
    var presetSelect = byId('api-voicebox-preset-voice');
    if (String(type && type.value) !== 'preset' || !engine) { fillSelect(presetSelect, [], ''); return; }
    try {
      var data = await request('/api/tts/voicebox/presets/' + encodeURIComponent(engine));
      var voices = Array.isArray(data.voices) ? data.voices : [];
      fillSelect(presetSelect, voices, '', function (voice) { return voice.name + (voice.language ? ' · ' + voice.language : ''); });
      var language = byId('api-voicebox-create-language');
      if (voices.length && voices[0].language && languages.indexOf(voices[0].language) >= 0) language.value = voices[0].language;
    } catch (error) {
      fillSelect(presetSelect, [], '');
      setText('api-voicebox-create-state', '无法读取 Voicebox 预设音色：' + error.message);
    }
  }
  async function localHeaderCheck(blob, ext) {
    var bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4096)).arrayBuffer());
    if (ext === 'wav') return bytes.length >= 44 && String.fromCharCode.apply(null, bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode.apply(null, bytes.slice(8, 12)) === 'WAVE';
    if (ext !== 'mp3') return false;
    var start = 0;
    if (bytes.length >= 10 && String.fromCharCode.apply(null, bytes.slice(0, 3)) === 'ID3') {
      var tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
      start = 10 + tagSize + ((bytes[5] & 0x10) ? 10 : 0);
      bytes = new Uint8Array(await blob.slice(start, start + 4).arrayBuffer());
      start = 0;
    }
    for (var i = start; i + 3 < bytes.length; i++) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) continue;
      var version = (b1 >> 3) & 3, layer = (b1 >> 1) & 3;
      var bitrateIndex = (b2 >> 4) & 15, sampleIndex = (b2 >> 2) & 3;
      if (version !== 1 && layer === 1 && bitrateIndex > 0 && bitrateIndex < 15 && sampleIndex !== 3) return true;
    }
    return false;
  }
  async function setPendingReference(scope, blob, name, declaredMime) {
    var filename = String(name || 'reference.wav');
    var ext = (filename.match(/\.([^.]+)$/) || [])[1];
    ext = String(ext || '').toLowerCase();
    if (ext !== 'wav' && ext !== 'mp3') throw new Error('仅接受 WAV 或 MP3 参考音频。');
    if (!blob || !Number(blob.size)) throw new Error('参考音频为空。');
    if (blob.size > 10 * 1024 * 1024) throw new Error('参考音频超过 10 MiB。');
    var mime = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
    var given = String(declaredMime || blob.type || '').toLowerCase().split(';')[0];
    var allowed = ext === 'wav' ? ['', 'audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'] : ['', 'audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'application/octet-stream'];
    if (allowed.indexOf(given) < 0) throw new Error('音频 MIME 与文件扩展名不匹配。');
    if (!await localHeaderCheck(blob, ext)) throw new Error('参考音频格式头无效或文件已损坏。');
    var audioId = scope === 'sample' ? 'api-voicebox-sample-preview' : 'api-voicebox-reference-preview';
    var audio = byId(audioId);
    if (!audio) throw new Error('本地参考音频预览器不可用。');
    if (previewUrls[scope]) URL.revokeObjectURL(previewUrls[scope]);
    var url = URL.createObjectURL(blob);
    previewUrls[scope] = url;
    audio.src = url; audio.hidden = false; audio.style.display = 'block';
    var duration = await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { cleanup(); reject(new Error('浏览器无法验证音频时长或解码音频。')); }, 8000);
      function cleanup() { clearTimeout(timer); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); }
      function loaded() { cleanup(); resolve(Number(audio.duration)); }
      function failed() { cleanup(); reject(new Error('浏览器无法解码该音频；请转换为可播放的 WAV 或 MP3。')); }
      audio.addEventListener('loadedmetadata', loaded, { once: true });
      audio.addEventListener('error', failed, { once: true });
      audio.load();
    });
    if (!Number.isFinite(duration) || duration < 2 || duration > 30) throw new Error('参考音频必须为 2–30 秒。');
    pending[scope] = { blob: blob, name: filename, mime: mime, durationSeconds: duration };
    setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', '本地预览就绪 · ' + duration.toFixed(1) + ' 秒 · ' + (blob.size / 1024).toFixed(0) + ' KiB。确认后才会发送到 Voicebox。');
  }
  function discardVoiceboxReference(scope) {
    scope = scope || 'create';
    pending[scope] = null;
    var audio = byId(scope === 'sample' ? 'api-voicebox-sample-preview' : 'api-voicebox-reference-preview');
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.hidden = true; audio.style.display = 'none'; }
    if (previewUrls[scope]) URL.revokeObjectURL(previewUrls[scope]);
    previewUrls[scope] = '';
    setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', '已清除本地待上传音频。');
  }
  function referenceFileChanged(scope, input) {
    var file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file) return;
    setPendingReference(scope, file, file.name, file.type).catch(function (error) {
      discardVoiceboxReference(scope);
      setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', error.message);
    });
  }
  function toggleVoiceboxReferenceRecording(buttonEl, scope) {
    scope = scope || 'create';
    var api = window.IB && window.IB.chat && window.IB.chat.voice;
    if (!api || typeof api.startReferenceCapture !== 'function' || typeof api.referenceBlobToWav !== 'function') {
      setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', '当前录音组件不可用。'); return;
    }
    if (recording) {
      if (recording.scope !== scope) { setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', '另一段参考录音正在进行。'); return; }
      if (buttonEl) buttonEl.textContent = '录制参考音频';
      recording = null;
      api.startReferenceCapture(buttonEl, function () {}, function () {});
      return;
    }
    recording = { scope: scope, button: buttonEl };
    if (buttonEl) buttonEl.textContent = '停止录制';
    setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', '正在录制；最多 30 秒。停止后只生成本地预览，不会自动上传。');
    api.startReferenceCapture(buttonEl, async function (capture) {
      recording = null;
      if (buttonEl) buttonEl.textContent = '录制参考音频';
      try {
        var wav = await api.referenceBlobToWav(capture.blob);
        await setPendingReference(scope, wav, 'reference.wav', 'audio/wav');
      } catch (error) {
        discardVoiceboxReference(scope);
        setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', '录音转换失败：' + error.message);
      }
    }, function (error) {
      recording = null;
      if (buttonEl) buttonEl.textContent = '录制参考音频';
      setText(scope === 'sample' ? 'api-voicebox-sample-status' : 'api-voicebox-reference-status', error && error.message || '录音失败。');
    });
  }
  function sampleText(scope) {
    var el = byId(scope === 'sample' ? 'api-voicebox-sample-text' : 'api-voicebox-reference-text');
    return String(el && el.value || '').trim();
  }
  async function uploadSample(profileId, scope) {
    var ref = pending[scope];
    var transcript = sampleText(scope);
    if (!ref) throw new Error('请先选择或录制参考音频，并在本地试听。');
    if (!transcript || transcript.length > 1000) throw new Error('参考音频文本必填，最多 1000 个字符。');
    var query = new URLSearchParams({ filename: ref.name, reference_text: transcript });
    return request('/api/tts/voicebox/profiles/' + encodeURIComponent(profileId) + '/samples?' + query.toString(), {
      method: 'POST', headers: { 'Content-Type': ref.mime }, body: ref.blob
    });
  }
  async function createVoiceboxProfile(buttonEl) {
    var type = String(byId('api-voicebox-create-type') && byId('api-voicebox-create-type').value || 'cloned');
    var engine = String(byId('api-voicebox-create-engine') && byId('api-voicebox-create-engine').value || '');
    var language = String(byId('api-voicebox-create-language') && byId('api-voicebox-create-language').value || '');
    var name = String(byId('api-voicebox-create-name') && byId('api-voicebox-create-name').value || '').trim();
    var description = String(byId('api-voicebox-create-description') && byId('api-voicebox-create-description').value || '').trim();
    var cap = engineCapabilities(engine);
    if (!available || !cap) { setText('api-voicebox-create-state', 'Voicebox 或所选 engine capability 不可用。'); return; }
    if (!name || name.length > 100) { setText('api-voicebox-create-state', '名称必填，最多 100 个字符。'); return; }
    var body = { name: name, description: description, language: language, voiceType: type, engine: engine };
    if (type === 'preset') {
      body.presetVoiceId = String(byId('api-voicebox-preset-voice') && byId('api-voicebox-preset-voice').value || '');
      if (!body.presetVoiceId) { setText('api-voicebox-create-state', '请选择 Voicebox 返回的预设音色。'); return; }
    } else {
      if (!pending.create) { setText('api-voicebox-create-state', '请先选择或录制参考音频，并本地试听。'); return; }
      if (!sampleText('create')) { setText('api-voicebox-create-state', '参考音频文本必填。'); return; }
    }
    if (buttonEl) buttonEl.disabled = true;
    setText('api-voicebox-create-state', '正在创建 Voicebox Profile…');
    var profile = null;
    try {
      var created = await request('/api/tts/voicebox/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      profile = created.profile;
      if (!profile || !profile.id) throw new Error('Voicebox did not return a profile ID.');
      if (type === 'cloned') {
        setText('api-voicebox-create-state', 'Profile 已创建；Voicebox 正在验证并处理参考音频…');
        try {
          await uploadSample(profile.id, 'create');
        } catch (uploadError) {
          setText('api-voicebox-create-state', '参考样本失败；正在尝试删除空 Profile…');
          var rollback = null;
          try { rollback = await request('/api/tts/voicebox/profiles/' + encodeURIComponent(profile.id), { method: 'DELETE' }); } catch (e) {}
          if (rollback && rollback.ok) {
            setText('api-voicebox-create-state', '创建失败，空 Profile 已清理：' + uploadError.message);
          } else {
            profile.sampleCount = 0;
            profiles = profiles.filter(function (p) { return p.id !== profile.id; });
            profiles.unshift(profile);
            setCachedProfiles(profiles, 'ready');
            setText('api-voicebox-create-state', 'Incomplete profile 保留，ID ' + profile.id + '。可在列表中修复或删除。失败原因：' + uploadError.message);
          }
          renderProfileList();
          return;
        }
        profile.sampleCount = 1;
      }
      profiles = profiles.filter(function (p) { return p.id !== profile.id; });
      profiles.unshift(profile);
      setCachedProfiles(profiles, 'ready');
      discardVoiceboxReference('create');
      setText('api-voicebox-create-state', 'Ready · Profile 已创建；当前角色没有改变。请在 profile 列表中显式绑定。');
      byId('api-voicebox-create-name').value = '';
      await refreshVoiceboxProfileManager();
    } catch (error) {
      setText('api-voicebox-create-state', 'Failed：' + error.message);
    } finally { if (buttonEl) buttonEl.disabled = false; }
  }
  function renderProfileList() {
    var list = byId('api-voicebox-profile-list');
    if (!list) return;
    list.textContent = '';
    if (!available) { list.textContent = 'Voicebox runtime unavailable。页面仍可打开，角色引用不会被清除。'; return; }
    if (!profiles.length) { list.textContent = 'Voicebox 当前没有 Profile。'; return; }
    profiles.forEach(function (profile) {
      var card = document.createElement('div');
      card.style.cssText = 'padding:12px;margin:8px 0;border:1px solid var(--border-soft);border-radius:var(--radius-control)';
      var title = document.createElement('strong');
      title.textContent = profile.name + ' · ' + (profile.voiceType === 'cloned' ? '克隆音色' : '预设音色');
      card.appendChild(title);
      var meta = document.createElement('div'); meta.className = 'field-hint';
      meta.textContent = [profile.language, profile.defaultEngine || profile.presetEngine, profile.voiceType === 'cloned' ? ('样本 ' + (profile.sampleCount || 0)) : 'Voicebox 预设'].filter(Boolean).join(' · ');
      card.appendChild(meta);
      var state = document.createElement('div'); state.className = 'field-hint';
      state.textContent = profileIncomplete(profile) ? '不完整：缺少参考样本' : modelState(profile).label;
      card.appendChild(state);
      var actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
      actions.appendChild(button('试听', function (event) { previewVoiceboxProfile(profile.id, null, null, event.currentTarget); }, !available || profileIncomplete(profile) || !modelState(profile).ready));
      actions.appendChild(button('绑定并保存当前角色', function (event) { bindVoiceboxProfile(profile.id, event.currentTarget); }, profileIncomplete(profile)));
      actions.appendChild(button('管理参考样本', function () { openSampleManager(profile.id, false); }, profile.voiceType !== 'cloned'));
      actions.appendChild(button('删除', function () { deleteVoiceboxProfile(profile); }, false));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }
  function referencedRoles(profileId) {
    var all = [];
    try { all = (Array.isArray(apiConfigs) ? apiConfigs : []).map(function (c) { return { config: c, archived: false }; }).concat((Array.isArray(archivedConfigs) ? archivedConfigs : []).map(function (c) { return { config: c, archived: true }; })); } catch (e) {}
    return all.filter(function (item) {
      var voice = item.config && item.config.voice || {};
      var source = String(voice.source || voice.provider || '');
      return source === 'voicebox' && String(voice.voiceId || '') === String(profileId);
    }).map(function (item) { return { name: String(item.config.nickname || item.config.model || item.config.id || '未命名角色'), archived: item.archived }; });
  }
  async function deleteVoiceboxProfile(profile) {
    var roles = referencedRoles(profile.id);
    var warning = roles.length
      ? '该音色仍被 ' + roles.length + ' 个角色引用：\n' + roles.map(function (r) { return '• ' + r.name + (r.archived ? '（已归档）' : ''); }).join('\n') + '\n\n删除后这些角色保留原 ID，但会显示“音色不可用”，不会自动切换。仍要删除吗？'
      : '确定删除 Voicebox 音色“' + profile.name + '”？';
    if (!window.confirm(warning)) return;
    try {
      await request('/api/tts/voicebox/profiles/' + encodeURIComponent(profile.id), { method: 'DELETE' });
      setText('api-voicebox-manager-status', 'Profile 已删除；角色配置没有修改。');
      await refreshVoiceboxProfileManager();
    } catch (error) { setText('api-voicebox-manager-status', '删除失败：' + error.message); }
  }
  async function openSampleManager(profileId, preserveStatus) {
    var panel = byId('api-voicebox-sample-manager');
    var profile = findProfile(profileId);
    if (!panel || !profile) return;
    clearStoredSamplePreviews();
    sampleProfileId = profileId;
    panel.hidden = false; panel.textContent = '';
    var heading = document.createElement('h4'); heading.textContent = '参考样本 · ' + profile.name; panel.appendChild(heading);
    var note = document.createElement('div'); note.className = 'field-hint';
    note.textContent = 'Voicebox 保存并管理参考音频；既存样本通过 IB Bridge 本地代理试听，不暴露 Voicebox 文件路径。新样本仍可在上传前本地试听。'; panel.appendChild(note);
    var rows = document.createElement('div'); panel.appendChild(rows);
    try {
      var data = await request('/api/tts/voicebox/profiles/' + encodeURIComponent(profileId) + '/samples');
      var samples = Array.isArray(data.samples) ? data.samples : [];
      profile.sampleCount = samples.length;
      samples.forEach(function (sample, index) {
        var row = document.createElement('div'); row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border-soft)';
        var label = document.createElement('div'); label.className = 'field-hint'; label.textContent = '参考样本 ' + String(index + 1).padStart(2, '0'); row.appendChild(label);
        row.appendChild(button('试听样本', async function (event) {
          event.currentTarget.disabled = true;
          try {
            var response = await ibBridgeFetch(bridgeUrl('/api/tts/voicebox/samples/' + encodeURIComponent(sample.id) + '/audio'), { cache: 'no-store' });
            if (!response.ok) {
              var failure = null; try { failure = await response.json(); } catch (e) {}
              throw new Error(String(failure && failure.error || ('Bridge request failed (' + response.status + ')')));
            }
            var blob = await response.blob();
            if (!blob.size) throw new Error('Voicebox returned empty sample audio.');
            var url = URL.createObjectURL(blob); storedSampleUrls.push(url);
            var player = document.createElement('audio'); player.controls = true; player.preload = 'none'; player.src = url; player.setAttribute('data-voicebox-sample-preview', '1');
            row.appendChild(player); setText('api-voicebox-sample-status', '参考样本从 Voicebox 经 Bridge 本地代理读取。');
          } catch (error) { setText('api-voicebox-sample-status', '样本试听失败：' + error.message); }
          finally { event.currentTarget.disabled = false; }
        }));
        var transcript = document.createElement('textarea'); transcript.className = 'ibv-input'; transcript.rows = 2; transcript.maxLength = 1000; transcript.value = sample.referenceText || ''; row.appendChild(transcript);
        var save = button('保存文本', async function (event) {
          event.currentTarget.disabled = true;
          try { await request('/api/tts/voicebox/samples/' + encodeURIComponent(sample.id) + '/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ referenceText: transcript.value }) }); setText('api-voicebox-sample-status', '参考文本已保存。'); }
          catch (error) { setText('api-voicebox-sample-status', '文本保存失败：' + error.message); }
          finally { event.currentTarget.disabled = false; }
        }); row.appendChild(save);
        row.appendChild(button('删除样本', async function (event) {
          var last = samples.length <= 1;
          if (!window.confirm(last ? '删除最后一个参考样本后，此克隆 Profile 将变为不完整。继续？' : '删除这个 Voicebox 参考样本？')) return;
          event.currentTarget.disabled = true;
          try { await request('/api/tts/voicebox/samples/' + encodeURIComponent(sample.id), { method: 'DELETE' }); await openSampleManager(profileId, true); await refreshVoiceboxProfileManager(); }
          catch (error) { setText('api-voicebox-sample-status', '删除样本失败：' + error.message); event.currentTarget.disabled = false; }
        }));
        rows.appendChild(row);
      });
      if (!samples.length) { var empty = document.createElement('div'); empty.className = 'field-hint'; empty.textContent = '还没有参考样本；该 Profile 不可试听或绑定，添加样本后恢复。'; rows.appendChild(empty); }
    } catch (error) { rows.textContent = '无法读取 Voicebox 参考样本：' + error.message; }
    var addHeading = document.createElement('h4'); addHeading.textContent = '添加参考样本'; panel.appendChild(addHeading);
    var transcriptInput = document.createElement('textarea'); transcriptInput.id = 'api-voicebox-sample-text'; transcriptInput.className = 'ibv-input'; transcriptInput.rows = 2; transcriptInput.maxLength = 1000; transcriptInput.placeholder = '准确填写音频中说出的内容'; panel.appendChild(transcriptInput);
    var file = document.createElement('input'); file.type = 'file'; file.id = 'api-voicebox-sample-file'; file.accept = '.wav,.mp3,audio/wav,audio/mpeg'; file.setAttribute('aria-label', '选择 WAV 或 MP3 参考样本');
    file.addEventListener('change', function () { referenceFileChanged('sample', file); }); panel.appendChild(file);
    var recordBtn = button('录制参考音频', function (event) { toggleVoiceboxReferenceRecording(event.currentTarget, 'sample'); }); panel.appendChild(recordBtn);
    var status = document.createElement('div'); status.id = 'api-voicebox-sample-status'; status.className = 'field-hint'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.appendChild(status);
    var audio = document.createElement('audio'); audio.id = 'api-voicebox-sample-preview'; audio.controls = true; audio.hidden = true; audio.style.cssText = 'display:none;width:100%;margin-top:8px'; panel.appendChild(audio);
    panel.appendChild(button('清除本地待上传音频', function () { discardVoiceboxReference('sample'); }));
    panel.appendChild(button('添加到此 Profile', async function (event) {
      event.currentTarget.disabled = true;
      try {
        setText('api-voicebox-sample-status', 'Voicebox 正在接收并验证参考样本…');
        await uploadSample(profileId, 'sample');
        discardVoiceboxReference('sample');
        setText('api-voicebox-sample-status', '参考样本已添加。');
        await refreshVoiceboxProfileManager();
      } catch (error) { setText('api-voicebox-sample-status', '添加失败：' + error.message); }
      finally { event.currentTarget.disabled = false; }
    }));
    if (!preserveStatus) setText('api-voicebox-manager-status', '样本操作通过 IB Bridge 代理到 Voicebox。');
  }
  async function previewVoiceboxProfile(profileId, engineOverride, textOverride, buttonEl) {
    var profile = findProfile(profileId);
    if (!profile) { setText('api-voicebox-manager-status', '音色不可用：Profile ID 不在 Voicebox 当前列表中。'); return; }
    if (profileIncomplete(profile)) { setText('api-voicebox-manager-status', '该克隆 Profile 缺少参考样本，不能试听。'); return; }
    var state = modelState(profile);
    if (!state.ready) { setText('api-voicebox-manager-status', state.label + '；试听不会自动下载模型。'); return; }
    var text = String(textOverride || byId('api-voicebox-preview-text') && byId('api-voicebox-preview-text').value || '你好，这是一段本地音色试听。').trim();
    if (!text) text = '你好，这是一段本地音色试听。';
    if (text.length > 300) { setText('api-voicebox-manager-status', '试听文本最多 300 个字符。'); return; }
    if (buttonEl) buttonEl.disabled = true;
    var engine = String(engineOverride || profile.defaultEngine || profile.presetEngine || '');
    var voice = { enabled: true, source: 'voicebox', provider: 'voicebox', voiceId: profile.id, model: engine, language: profile.language || '', rate: 1, pitch: '+0Hz', style: '', voiceType: 'builtin', voiceData: null };
    try {
      var payload = IB.bridge.ttsPayload(voice, text); payload.preview = true;
      var result = await request('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!result.url) throw new Error('Bridge did not return an audio URL.');
      if (previewAudio) { try { previewAudio.pause(); } catch (e) {} }
      var play = function (url, revoke) {
        previewAudio = new Audio(url);
        previewAudio.play().catch(function () {});
        if (revoke) previewAudio.addEventListener('ended', function () { try { URL.revokeObjectURL(url); } catch (e) {} });
      };
      ibBridgeLoadAudio(result.url, play, function () { play(bridgeUrl(result.url), false); });
      setText('api-voicebox-manager-status', '试听生成完成；没有创建聊天消息。');
    } catch (error) { setText('api-voicebox-manager-status', '试听失败：' + error.message); }
    finally { if (buttonEl) buttonEl.disabled = false; }
  }
  async function bindVoiceboxProfile(profileId, buttonEl) {
    var profile = findProfile(profileId);
    if (!profile || !available) { setText('api-voicebox-role-status', 'Profile 当前不可用；角色绑定保持不变。'); return; }
    if (profileIncomplete(profile)) { setText('api-voicebox-role-status', '该 Profile 缺少参考样本，不能绑定。'); return; }
    if (typeof editingApiId === 'undefined' || !editingApiId) { setText('api-voicebox-role-status', '请先打开并保存一个当前角色，再绑定 Voicebox 音色。'); return; }
    var provider = byId('api-voice-provider');
    if (!provider) return;
    if (typeof window._voiceSyncProviderOptions === 'function') window._voiceSyncProviderOptions();
    if (typeof provider.querySelector === 'function' && !provider.querySelector('option[value="voicebox"]')) {
      var option = document.createElement('option'); option.value = 'voicebox'; option.textContent = 'Voicebox Local Runtime'; provider.appendChild(option);
    }
    provider.value = 'voicebox';
    if (typeof window._voiceToggleDetail === 'function') window._voiceToggleDetail();
    if (typeof window._voiceSetId === 'function') window._voiceSetId(profile.id);
    var select = byId('api-voice-select'); if (select) select.value = profile.id;
    var toggle = byId('api-voice-toggle'); if (toggle) toggle.checked = true;
    syncRoleControls();
    if (buttonEl) buttonEl.disabled = true;
    try {
      if (typeof window.saveCurrentApi !== 'function') throw new Error('Role editor save action is unavailable.');
      await window.saveCurrentApi(buttonEl || null);
      setText('api-voicebox-manager-status', '已显式绑定并保存当前角色；只保存 Voicebox profile ID。');
    } catch (error) {
      setText('api-voicebox-manager-status', '角色未保存：' + error.message);
    } finally { if (buttonEl) buttonEl.disabled = false; }
  }
  function bindSelectedVoiceboxProfile(buttonEl) {
    var select = byId('api-voice-select');
    return bindVoiceboxProfile(String(select && select.value || ''), buttonEl);
  }
  function stopReferenceRecording() {
    if (!recording) return;
    var ctx = recording, api = window.IB && window.IB.chat && window.IB.chat.voice;
    recording = null;
    if (ctx.button) ctx.button.textContent = '录制参考音频';
    if (api && typeof api.startReferenceCapture === 'function') api.startReferenceCapture(ctx.button, function () {}, function () {});
  }
  function init() {
    var file = byId('api-voicebox-reference-file');
    if (file) file.addEventListener('change', function () { referenceFileChanged('create', file); });
  }
  var api = {
    open: openVoiceboxProfileManager,
    close: closeVoiceboxProfileManager,
    refresh: refreshVoiceboxProfileManager,
    syncRoleControls: syncRoleControls,
    preview: previewVoiceboxProfile,
    bind: bindVoiceboxProfile,
    capabilities: function () { return capabilities; },
    styleSupported: function (profileId) {
      var profile = findProfile(profileId);
      var cap = profile && engineCapabilities(String(profile.defaultEngine || profile.presetEngine || ''));
      return !!(cap && cap.instruct === true);
    },
    profiles: function () { return profiles.slice(); },
    isAvailable: function () { return available; }
  };
  root.IBVoiceboxProfileManager = api;
  root.openVoiceboxProfileManager = openVoiceboxProfileManager;
  root.closeVoiceboxProfileManager = closeVoiceboxProfileManager;
  root.refreshVoiceboxProfileManager = refreshVoiceboxProfileManager;
  root.voiceboxCreateTypeChanged = voiceboxCreateTypeChanged;
  root.voiceboxCreateEngineChanged = voiceboxCreateEngineChanged;
  root.createVoiceboxProfile = createVoiceboxProfile;
  root.toggleVoiceboxReferenceRecording = toggleVoiceboxReferenceRecording;
  root.discardVoiceboxReference = discardVoiceboxReference;
  root.previewSelectedVoiceboxProfile = function (buttonEl) {
    var select = byId('api-voice-select');
    var text = byId('api-voicebox-preview-text');
    return previewVoiceboxProfile(String(select && select.value || ''), null, text && text.value, buttonEl);
  };
  root.previewVoiceboxProfile = previewVoiceboxProfile;
  root.bindSelectedVoiceboxProfile = bindSelectedVoiceboxProfile;
  root.bindVoiceboxProfile = bindVoiceboxProfile;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})(window);
