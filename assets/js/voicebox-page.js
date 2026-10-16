/* Voicebox product page. Reads shared role/API and ASR/TTS configuration,
 * and delegates preview/binding to the existing Voicebox and role editor flows. */
(function (window) {
  'use strict';

  var page = null;
  var selectedRoleId = '';
  var profiles = [];
  var runtimeAvailable = false;
  var onlineResources = [];
  var onlineManifestStatus = 'unknown';
  var onlineCompatibility = Object.create(null);
  var onlineOperationStatus = Object.create(null);
  var profileProvenance = Object.create(null);
  var lastRefreshAt = 0;
  var refreshPromise = null;
  var runtimeControlPromise = null;
  var runtimeControlBusy = false;
  var runtimeStatusTimer = null;
  var runtimeLastSnapshot = null;
  var runtimePathDirty = false;
  var previewing = false;
  var observer = null;

  function byId(id) { return document.getElementById(id); }
  function manager() { return window.IBVoiceboxProfileManager || null; }
  function libraryCore() { return window.IBVoiceboxLibraryCore || null; }
  function searchQuery() { return String(byId('voicebox-library-search') && byId('voicebox-library-search').value || '').trim().toLocaleLowerCase(); }
  function categoryFilter() { return String(byId('voicebox-library-category') && byId('voicebox-library-category').value || 'all'); }
  function matchesSearch(values) {
    var query = searchQuery();
    return !query || (values || []).join(' ').toLocaleLowerCase().indexOf(query) >= 0;
  }
  function appendMeta(parent, value) { if (value) appendText(parent, 'span', 'voicebox-library-meta', value); }
  function formatBytes(value) {
    var bytes = Number(value) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KiB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
  }
  function setOnlineStatus(value, error) {
    var status = byId('voicebox-online-status');
    if (!status) return;
    status.textContent = String(value || '');
    status.classList.toggle('is-error', !!error);
  }
  async function fetchStaticResource(url, options, timeoutMs) {
    if (typeof AbortController !== 'function') throw new Error('当前浏览器不支持可取消的资源请求。');
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, timeoutMs || 15000);
    try { return await window.fetch(url, Object.assign({}, options || {}, { signal: controller.signal })); }
    catch (error) {
      if (controller.signal.aborted) throw new Error('在线资源请求超时。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function configList() {
    return Array.isArray(window.apiConfigs) ? window.apiConfigs.filter(function (cfg) { return cfg && !cfg.archived; }) : [];
  }
  function roleById(id) {
    var rows = configList(), key = String(id || '');
    for (var i = 0; i < rows.length; i++) if (String(rows[i].id || '') === key) return rows[i];
    return null;
  }
  function selectedRole() { return roleById(selectedRoleId); }
  function text(el, value) { if (el) el.textContent = String(value == null ? '' : value); }
  function setStatus(value, isError) {
    var status = byId('voicebox-page-status');
    if (!status) return;
    status.textContent = String(value || '');
    status.classList.toggle('is-error', !!isError);
  }
  function renderCloneFlow() {
    var api = manager(), caps = api && typeof api.capabilities === 'function' ? api.capabilities() : null;
    var engines = caps && caps.engines && typeof caps.engines === 'object' ? Object.keys(caps.engines).filter(function (key) {
      return caps.engines[key] && caps.engines[key].clone === true;
    }) : [];
    var list = byId('voicebox-clone-engines'), buttonEl = byId('voicebox-clone-open'), note = byId('voicebox-clone-destination');
    var localEndpoint = caps && caps.referenceAudio && caps.referenceAudio.localEndpoint;
    var endpointKnown = typeof localEndpoint === 'boolean';
    text(list, engines.length ? engines.join(' · ') : (runtimeAvailable ? '当前 Provider 未声明可用的克隆 Engine。' : '连接 Voicebox 后读取克隆能力。'));
    if (buttonEl) buttonEl.disabled = !runtimeAvailable || !engines.length || !endpointKnown;
    if (note) {
      note.textContent = localEndpoint === true
        ? '参考音频先留在本机浏览器；确认后只发送到本机 Voicebox，不经过 IB 下载站。'
        : localEndpoint === false
          ? '参考音频先留在本机浏览器；确认后会发送到配置的远程 Voicebox Provider，并离开本机。'
          : '暂时无法确认参考音频的 Provider 位置；为保护样本，当前不能开始克隆。';
    }
    text(byId('voicebox-clone-status'), runtimeAvailable
      ? (engines.length && endpointKnown ? '可用能力来自当前 Bridge 的 Voicebox Provider 声明；模型缺失时不会自动下载。' : engines.length ? 'Provider 能力未提供本地/远程位置；克隆上传已停用。' : '当前 Provider 不支持已登记的参考音频克隆 Engine。')
      : '启动或连接 Voicebox 后可创建克隆 Profile；现有声音库和角色配置仍可浏览。');
  }
  function openCloneFlow() {
    var api = manager();
    if (!runtimeAvailable || !api || typeof api.open !== 'function') {
      setStatus('Voicebox Runtime 当前不可用；没有上传参考音频。', true); return;
    }
    api.open();
  }
  function cancelPreview() {
    var api = manager(), cancel = byId('voicebox-cancel-preview');
    if (!previewing) return;
    if (cancel) cancel.disabled = true;
    setStatus('正在请求 Voicebox 取消生成…');
    if (api && typeof api.cancelPreview === 'function') api.cancelPreview();
  }
  function runtimeStateLabel(state) {
    var labels = {
      checking: '正在检测', 'not-configured': '未定位程序', 'not-installed': '程序不存在',
      'installed-stopped': '已安装 · 未启动', starting: '正在启动', running: '运行中',
      'remote-running': '远端运行中', 'remote-unavailable': '远端不可用',
      'start-failed': '启动失败', stopping: '正在停止', 'stop-failed': '停止未完成',
      'endpoint-conflict': '端口响应不匹配', 'endpoint-error': '本地服务异常', unavailable: '状态暂不可用'
    };
    return labels[String(state || '')] || '状态未知';
  }
  function updateRuntimeButtons(state, snapshot) {
    var start = byId('voicebox-start'), stop = byId('voicebox-stop'), save = byId('voicebox-save-path');
    var live = snapshot || runtimeLastSnapshot || {};
    var remote = state === 'remote-running' || state === 'remote-unavailable';
    if (start) start.disabled = runtimeControlBusy || remote || state === 'running' || state === 'starting' || state === 'stopping' || state === 'endpoint-conflict' || state === 'endpoint-error' || (state === 'start-failed' && live.processOwned === true);
    if (stop) stop.disabled = runtimeControlBusy || remote || !(state === 'running' || state === 'starting' || state === 'stopping' || state === 'stop-failed' || ((state === 'start-failed' || state === 'endpoint-error') && live.processOwned === true));
    if (save) save.disabled = runtimeControlBusy;
  }
  function applyRuntimeSnapshot(snapshot) {
    var value = snapshot && typeof snapshot === 'object' ? snapshot : { state: 'unavailable', message: '无法读取 Voicebox 启动状态。' };
    var state = String(value.state || 'unavailable');
    runtimeLastSnapshot = value;
    var badge = byId('voicebox-process-state'), detail = byId('voicebox-process-detail'), input = byId('voicebox-executable-path');
    if (badge) { badge.textContent = runtimeStateLabel(state); badge.dataset.state = state; }
    if (detail) {
      detail.textContent = String(value.message || 'Voicebox 状态已更新。');
      detail.classList.toggle('is-error', ['start-failed','stop-failed','endpoint-conflict','endpoint-error'].indexOf(state) >= 0);
    }
    if (input && !runtimePathDirty && document.activeElement !== input && typeof value.executablePath === 'string') input.value = value.executablePath;
    updateRuntimeButtons(state, value);
    return value;
  }
  async function runtimeControlRequest(pathname, method, body) {
    if (typeof window.ibBridgeFetch !== 'function' || typeof window.ibBridgeBase !== 'function') throw new Error('IB Bridge 暂不可用。');
    var options = { method: method || 'GET', cache: 'no-store', headers: {} };
    if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    var response = await window.ibBridgeFetch(String(window.ibBridgeBase()).replace(/\/+$/, '') + pathname, options);
    var data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!data || typeof data !== 'object') throw new Error('IB Bridge 返回了无效的 Voicebox 状态。');
    return { response: response, data: data };
  }
  async function refreshRuntimeStatus() {
    if (runtimeControlPromise) return runtimeControlPromise;
    runtimeControlPromise = (async function () {
      var result = await runtimeControlRequest('/api/tts/voicebox/runtime', 'GET');
      return applyRuntimeSnapshot(result.data);
    })().catch(function () {
      return applyRuntimeSnapshot({ state: 'unavailable', message: '本地 Bridge 未连接；Voicebox 和现有 TTS 配置未更改。' });
    }).finally(function () { runtimeControlPromise = null; });
    return runtimeControlPromise;
  }
  function runtimeDelay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  async function saveRuntimePath() {
    if (runtimeControlBusy) return;
    var input = byId('voicebox-executable-path'), save = byId('voicebox-save-path');
    runtimeControlBusy = true; updateRuntimeButtons('checking');
    try {
      var result = await runtimeControlRequest('/api/tts/voicebox/runtime/config', 'POST', { executablePath: String(input && input.value || '').trim() });
      if (!result.data.ok) {
        applyRuntimeSnapshot({ state: result.data.error === 'program-not-found' ? 'not-installed' : 'not-configured',
          executablePath: String(input && input.value || ''), message: result.data.message || '程序路径无效，请填写 Voicebox.exe 的完整路径。' });
        setStatus(result.data.message || 'Voicebox 程序路径无效。', true);
        return;
      }
      runtimePathDirty = false;
      setStatus(result.data.executablePath ? 'Voicebox 程序路径已保存。' : '已清除 Voicebox 程序路径。');
      await refreshRuntimeStatus();
    } catch (error) { setStatus('保存 Voicebox 路径失败：' + String(error && error.message || error), true); }
    finally { runtimeControlBusy = false; updateRuntimeButtons(String(byId('voicebox-process-state') && byId('voicebox-process-state').dataset.state || 'unavailable')); if (save) save.disabled = false; }
  }
  async function runRuntimeAction(action) {
    if (runtimeControlBusy) return;
    runtimeControlBusy = true;
    applyRuntimeSnapshot({ state: action === 'start' ? 'starting' : 'stopping', message: action === 'start' ? '正在启动 Voicebox…' : '正在请求 Voicebox 停止…' });
    try {
      var result = await runtimeControlRequest('/api/tts/voicebox/runtime/' + action, 'POST');
      applyRuntimeSnapshot(result.data);
      if (action === 'start' && result.data.ok && result.data.state === 'starting') {
        var deadline = Date.now() + 60000, latest = result.data;
        while (Date.now() < deadline) {
          await runtimeDelay(900);
          latest = await refreshRuntimeStatus();
          if (!latest || latest.state !== 'starting') break;
        }
        if (latest && latest.state === 'running') setStatus('Voicebox 已连接；可以继续使用本地试听和角色声音。');
        else if (latest && latest.state === 'starting') setStatus('Voicebox 仍在启动；可稍后重新检测。');
      } else if (action === 'stop' && result.data.ok) {
        await refreshRuntimeStatus();
      }
      if (!result.data.ok) setStatus(result.data.message || (action === 'start' ? 'Voicebox 未能启动。' : 'Voicebox 未能停止。'), true);
    } catch (error) {
      setStatus((action === 'start' ? 'Voicebox 启动' : 'Voicebox 停止') + '请求失败：' + String(error && error.message || error), true);
      await refreshRuntimeStatus();
    } finally {
      runtimeControlBusy = false;
      updateRuntimeButtons(String(byId('voicebox-process-state') && byId('voicebox-process-state').dataset.state || 'unavailable'));
    }
  }
  function providerLabel(voice) {
    var source = String(voice && (voice.source || voice.provider) || 'edge').toLowerCase();
    var labels = { voicebox: 'Voicebox Local Runtime', edge: 'Edge TTS', openai: 'OpenAI TTS', mimo: 'MiMo TTS' };
    return labels[source] || '自定义 TTS Provider';
  }
  function voiceTypeLabel(voice) {
    var type = String(voice && voice.voiceType || 'builtin');
    return type === 'clone' ? 'Voice Clone' : type === 'design' ? 'Voice Design' : 'Built-in';
  }
  function profileById(id) {
    var key = String(id || '');
    for (var i = 0; i < profiles.length; i++) if (String(profiles[i] && profiles[i].id || '') === key) return profiles[i];
    return null;
  }
  function appendText(parent, tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(value == null ? '' : value);
    parent.appendChild(node);
    return node;
  }
  function button(parent, label, className, action) {
    var node = document.createElement('button');
    node.type = 'button'; node.className = className || 'btn'; node.textContent = label;
    node.addEventListener('click', function (event) { action(event, node); });
    parent.appendChild(node);
    return node;
  }
  function renderRoleOptions() {
    var select = byId('voicebox-role-select');
    if (!select) return;
    var roles = configList();
    select.innerHTML = '';
    if (!roles.length) {
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = '没有可用角色'; select.appendChild(empty);
      selectedRoleId = '';
      return;
    }
    if (!roleById(selectedRoleId)) selectedRoleId = String(roles.find(function (role) { return role.voice && role.voice.enabled; })?.id || roles[0].id);
    roles.forEach(function (role) {
      var option = document.createElement('option');
      option.value = String(role.id);
      option.textContent = String(role.nickname || role.model || role.id);
      option.selected = option.value === selectedRoleId;
      select.appendChild(option);
    });
  }
  function renderCurrentRole() {
    var role = selectedRole(), voice = role && role.voice && typeof role.voice === 'object' ? role.voice : {};
    if (!role) {
      text(byId('voicebox-tts-provider'), '未选择角色');
      text(byId('voicebox-tts-detail'), '添加角色后可查看其声音配置。');
      text(byId('voicebox-current-profile'), '未配置');
      text(byId('voicebox-profile-detail'), '');
      return;
    }
    var enabled = voice.enabled === true;
    var source = providerLabel(voice);
    text(byId('voicebox-tts-provider'), enabled ? source : '角色语音未启用');
    text(byId('voicebox-tts-detail'), enabled
      ? [voiceTypeLabel(voice), voice.model || '', voice.language || ''].filter(Boolean).join(' · ')
      : '该角色当前没有启用语音合成。');
    var voiceId = String(voice.voiceId || '');
    var profile = voiceId && String(voice.source || voice.provider || '').toLowerCase() === 'voicebox' ? profileById(voiceId) : null;
    if (!enabled) {
      text(byId('voicebox-current-profile'), '未配置');
      text(byId('voicebox-profile-detail'), '启用该角色语音后，这里会显示当前 Voice Profile。');
    } else if (profile) {
      text(byId('voicebox-current-profile'), profile.name || profile.id);
      text(byId('voicebox-profile-detail'), [
        'ID ' + String(profile.id || ''),
        voiceTypeLabel({ voiceType: profile.voiceType || 'builtin' }),
        profile.language || voice.language || '',
        profile.defaultEngine || profile.presetEngine || voice.model || ''
      ].filter(Boolean).join(' · '));
    } else if (voiceId) {
      text(byId('voicebox-current-profile'), voiceId);
      text(byId('voicebox-profile-detail'), source + ' · ' + voiceTypeLabel(voice) + ' · 该 ID 不是当前 Voicebox Profile。');
    } else if (voice.voiceData && voice.voiceData.refAudioId) {
      text(byId('voicebox-current-profile'), voice.voiceData.name || voiceTypeLabel(voice));
      text(byId('voicebox-profile-detail'), source + ' · Reference ID ' + String(voice.voiceData.refAudioId));
    } else {
      text(byId('voicebox-current-profile'), voiceTypeLabel(voice));
      text(byId('voicebox-profile-detail'), source + ' · 尚未设置 Voice ID。');
    }
  }
  function profileIncomplete(profile) {
    return String(profile && profile.voiceType || '') === 'cloned' && Number(profile.sampleCount || 0) < 1;
  }
  async function responseBytesLimited(response, maxBytes) {
    if (response && response.body && typeof response.body.getReader === 'function') {
      var reader = response.body.getReader(), chunks = [], total = 0;
      while (true) {
        var part = await reader.read();
        if (part.done) break;
        var chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value || []);
        total += chunk.byteLength;
        if (total > maxBytes) { try { await reader.cancel(); } catch (e) {} throw new Error('资源超过大小限制。'); }
        chunks.push(chunk);
      }
      var bytes = new Uint8Array(total), offset = 0;
      chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
      return bytes;
    }
    var fallback = new Uint8Array(await response.arrayBuffer());
    if (fallback.byteLength > maxBytes) throw new Error('资源超过大小限制。');
    return fallback;
  }
  async function responseJsonLimited(response, url, maxBytes) {
    if (!response || response.status !== 200 || response.ok !== true) throw new Error('HTTP ' + String(response && response.status || 'network'));
    if (response.redirected === true || (response.url && response.url !== url)) throw new Error('下载地址发生重定向，已停止请求。');
    var contentType = String(response.headers && response.headers.get && response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new Error('Manifest Content-Type 必须是 application/json。');
    var declared = Number(response.headers && response.headers.get && response.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('资源超过大小限制。');
    var bytes = await responseBytesLimited(response, maxBytes), raw;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { throw new Error('Manifest 不是有效 UTF-8。'); }
    try { return JSON.parse(raw); } catch (e) { throw new Error('JSON 格式无效。'); }
  }
  async function loadOnlineManifest() {
    var core = libraryCore();
    onlineResources = [];
    onlineCompatibility = Object.create(null);
    if (!core || typeof window.fetch !== 'function') {
      onlineManifestStatus = 'unavailable';
      setOnlineStatus('在线目录功能不可用；本地 Voice Profile 与角色声音仍可使用。', true);
      return false;
    }
    setOnlineStatus('正在读取 HTTPS Manifest…');
    try {
      var url = core.MANIFEST_URL;
      var response = await fetchStaticResource(url, { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', headers: { Accept: 'application/json' } }, 12000);
      var manifest = await responseJsonLimited(response, url, core.MAX_MANIFEST_BYTES);
      var checked = core.validateManifest(manifest);
      if (!checked.ok) throw new Error('Manifest 校验失败：' + checked.reason);
      onlineResources = checked.manifest.resources;
      onlineManifestStatus = 'ready';
      setOnlineStatus(onlineResources.length ? 'Manifest 已验证 · ' + onlineResources.length + ' 个预设资源。下载前还会核对文件大小与 SHA-256。'
        : 'Manifest 已验证；当前没有可下载资源。');
      return true;
    } catch (error) {
      onlineResources = [];
      onlineManifestStatus = 'unavailable';
      setOnlineStatus('在线目录暂不可用：' + String(error && error.message || error) + '。本地声音功能不受影响。', true);
      return false;
    }
  }
  async function checkResourceCompatibility() {
    var core = libraryCore(), api = manager(), caps = api && typeof api.capabilities === 'function' ? api.capabilities() : null;
    var engines = Array.from(new Set(onlineResources.map(function (resource) { return String(resource.engine || ''); }).filter(Boolean)));
    var voicesByEngine = Object.create(null);
    if (runtimeAvailable && api && typeof api.presetVoices === 'function') {
      await Promise.all(engines.map(async function (engine) {
        try { voicesByEngine[engine] = await api.presetVoices(engine); }
        catch (e) { voicesByEngine[engine] = null; }
      }));
    }
    onlineCompatibility = Object.create(null);
    onlineResources.forEach(function (resource) {
      if (!runtimeAvailable) {
        onlineCompatibility[resource.id] = { ok: false, pending: true, reason: 'voicebox-runtime-unavailable' };
        return;
      }
      if (!core) { onlineCompatibility[resource.id] = { ok: false, reason: 'validator-unavailable' }; return; }
      onlineCompatibility[resource.id] = core.profileCompatibility({
        provider: resource.provider, voiceType: 'preset', name: resource.title, description: resource.description,
        language: resource.language, engine: resource.engine, presetVoiceId: resource.presetVoiceId
      }, caps, voicesByEngine[resource.engine]);
    });
  }
  function profileForResource(resource) {
    var engine = String(resource && resource.engine || ''), voiceId = String(resource && resource.presetVoiceId || '');
    return profiles.find(function (profile) {
      return String(profile && profile.voiceType || '') === 'preset'
        && String(profile.presetEngine || profile.defaultEngine || '') === engine
        && String(profile.presetVoiceId || '') === voiceId;
    }) || null;
  }
  function resourceState(resource) {
    var operation = String(onlineOperationStatus[resource.id] || '');
    if (operation) return operation;
    if (profileForResource(resource)) return '已导入到本地 Voicebox';
    var compatibility = onlineCompatibility[resource.id];
    if (!compatibility || compatibility.pending) return runtimeAvailable ? '正在验证 Provider 兼容性' : '需连接 Voicebox 才能验证并导入';
    return compatibility.ok ? '兼容 · 可下载并导入' : 'Provider 不兼容：' + String(compatibility.reason || 'unknown');
  }
  function updateLibraryLists() {
    renderProfiles();
    renderRoleVoiceList();
    renderOnlineResources();
  }
  async function previewProfile(profile, control) {
    var api = manager();
    if (!api || typeof api.preview !== 'function') { setStatus('Voicebox 试听入口暂不可用。', true); return; }
    var sampleText = String(byId('voicebox-preview-text') && byId('voicebox-preview-text').value || '').trim();
    if (!sampleText) sampleText = '你好，这是一段声音试听。';
    previewing = true;
    var cancel = byId('voicebox-cancel-preview');
    if (cancel) { cancel.hidden = false; cancel.disabled = false; }
    setStatus('Voicebox 正在生成试听；可取消，失败后可以重试。');
    try {
      var result = await api.preview(String(profile.id), null, sampleText, control);
      if (result && result.cancelled) { setStatus('试听已取消；没有创建聊天消息。'); return; }
      var existingStatus = byId('api-voicebox-manager-status');
      setStatus(existingStatus && existingStatus.textContent || '试听已交给 Voicebox Runtime。');
    } catch (error) { setStatus('试听失败：' + String(error && error.message || error), true); }
    finally {
      var stillActive = api && typeof api.isPreviewActive === 'function' && api.isPreviewActive();
      previewing = !!stillActive;
      if (cancel) { cancel.hidden = !stillActive; cancel.disabled = false; if (stillActive) cancel.textContent = '停止试听'; }
    }
  }
  async function bindProfile(profile, control) {
    var role = selectedRole(), api = manager();
    if (!role) { setStatus('请先选择一个角色。', true); return; }
    if (!runtimeAvailable || !api || typeof api.bind !== 'function') { setStatus('Voicebox Runtime 当前不可用，角色配置保持不变。', true); return; }
    if (profileIncomplete(profile)) { setStatus('该 Profile 缺少参考样本，不能绑定。', true); return; }
    setStatus('正在打开角色配置并保存声音变更…');
    if (control) control.disabled = true;
    try {
      if (typeof window.navTo === 'function') window.navTo('api');
      if (typeof window.editApi !== 'function') throw new Error('角色配置编辑入口不可用。');
      window.editApi(String(role.id));
      await api.bind(String(profile.id), control);
      if (typeof window.loadApiConfigs === 'function') await window.loadApiConfigs();
      var saved = roleById(role.id), voice = saved && saved.voice || {};
      var bound = String(voice.source || voice.provider || '').toLowerCase() === 'voicebox'
        && String(voice.voiceId || '') === String(profile.id);
      if (typeof window.navTo === 'function') window.navTo('voicebox');
      selectedRoleId = String(role.id);
      renderRoleOptions(); renderCurrentRole(); updateLibraryLists();
      setStatus(bound ? '已通过现有角色保存流程切换声音。' : (byId('api-voicebox-manager-status')?.textContent || '声音未切换；原角色配置保持不变。'), !bound);
    } catch (error) {
      if (typeof window.navTo === 'function') window.navTo('voicebox');
      setStatus('声音切换失败：' + String(error && error.message || error), true);
    } finally { if (control) control.disabled = false; }
  }
  function renderProfiles() {
    var host = byId('voicebox-profile-list'), category = categoryFilter(), query = searchQuery();
    if (!host) return;
    host.replaceChildren();
    text(byId('voicebox-profile-count'), profiles.length ? profiles.length + ' 个' : '');
    if (category === 'online' || category === 'role') {
      appendText(host, 'p', 'voicebox-empty', '当前分类隐藏本地 Voice Profile。');
      return;
    }
    if (!runtimeAvailable) {
      appendText(host, 'p', 'voicebox-empty', 'Voicebox Runtime 暂不可用；没有修改角色声音配置。');
      return;
    }
    var filtered = profiles.filter(function (profile) {
      return matchesSearch([profile.name, profile.id, profile.voiceType, profile.language, profile.defaultEngine, profile.presetEngine, profile.presetVoiceId, profile.description]);
    });
    if (!filtered.length) {
      appendText(host, 'p', 'voicebox-empty', profiles.length ? '没有符合搜索条件的本地 Profile。' : '当前没有 Voice Profile；可以导入受支持的预设 Profile。');
      return;
    }
    filtered.forEach(function (profile) {
      var row = document.createElement('article'); row.className = 'voicebox-profile-row';
      var copy = document.createElement('div'); copy.className = 'voicebox-profile-copy';
      appendText(copy, 'strong', '', profile.name || profile.id || 'Voice Profile');
      appendText(copy, 'span', '', ['Voicebox 本地 Profile', profile.voiceType || 'Voice Profile', profile.language || '',
        profile.defaultEngine || profile.presetEngine || '', String(profile.voiceType) === 'cloned' ? (Number(profile.sampleCount || 0) + ' 个参考样本') : ''].filter(Boolean).join(' · '));
      if (profile.description) appendText(copy, 'span', '', profile.description);
      var provenance = profileProvenance[String(profile.id || '')] || null;
      if (provenance) appendText(copy, 'span', '', [provenance.source && provenance.source.name, provenance.license && provenance.license.name].filter(Boolean).join(' · '));
      var profileState = manager() && typeof manager().profileStatus === 'function' ? manager().profileStatus(profile.id) : null;
      appendText(copy, 'span', 'voicebox-library-state', profileState ? profileState.label : (profileIncomplete(profile) ? '不完整：缺少参考样本' : '状态由 Voicebox Runtime 管理。'));
      row.appendChild(copy);
      var actions = document.createElement('div'); actions.className = 'voicebox-profile-actions';
      var previewButton = button(actions, '试听', 'btn', function (_event, control) { previewProfile(profile, control); });
      previewButton.disabled = !runtimeAvailable || profileIncomplete(profile) || !!(profileState && profileState.ready === false);
      var switchButton = button(actions, '切换到当前角色', 'btn btn-primary', function (_event, control) { bindProfile(profile, control); });
      switchButton.disabled = !runtimeAvailable || !selectedRole() || profileIncomplete(profile);
      var exportButton = button(actions, '导出 Profile', 'btn', function (_event, control) { exportProfile(profile, control); });
      exportButton.disabled = String(profile.voiceType || '') !== 'preset';
      if (exportButton.disabled) exportButton.title = '克隆 Profile 包含参考样本，不在本版本导出。';
      button(actions, '管理', 'btn', function () { var api = manager(); if (api && typeof api.open === 'function') api.open(); });
      row.appendChild(actions); host.appendChild(row);
    });
  }
  function renderRoleVoiceList() {
    var host = byId('voicebox-role-voice-list'), category = categoryFilter(), query = searchQuery();
    var roles = configList().filter(function (role) { return role.voice && (role.voice.enabled || role.voice.voiceId || role.voice.source || role.voice.provider); });
    if (!host) return;
    host.replaceChildren();
    var filtered = category === 'local' || category === 'online' ? [] : roles.filter(function (role) {
      var voice = role.voice || {};
      return matchesSearch([role.nickname, role.model, role.id, voice.source, voice.provider, voice.voiceId, voice.model, voice.language, voice.voiceType]);
    });
    text(byId('voicebox-role-count'), filtered.length ? filtered.length + ' 个' : (roles.length ? '已筛选' : ''));
    if (!filtered.length) { appendText(host, 'p', 'voicebox-empty', roles.length ? '当前分类或搜索条件没有角色声音。' : '还没有已配置声音的角色。'); return; }
    filtered.forEach(function (role) {
      var voice = role.voice || {}, row = document.createElement('div'); row.className = 'voicebox-role-voice-row';
      var copy = document.createElement('div'); copy.className = 'voicebox-role-voice-copy';
      appendText(copy, 'strong', '', role.nickname || role.model || '角色');
      appendText(copy, 'span', '', [providerLabel(voice), voice.enabled ? '已启用' : '已保存 · 未启用', voiceTypeLabel(voice), voice.voiceId || (voice.voiceData && voice.voiceData.refAudioId) || 'Provider 默认音色', voice.model || '', voice.language || ''].filter(Boolean).join(' · '));
      row.appendChild(copy);
      var choose = button(row, String(role.id) === selectedRoleId ? '当前角色' : '查看', 'btn', function () {
        selectedRoleId = String(role.id);
        var select = byId('voicebox-role-select'); if (select) select.value = selectedRoleId;
        renderCurrentRole(); renderRoleVoiceList(); renderProfiles(); renderOnlineResources();
      });
      choose.setAttribute('aria-pressed', String(String(role.id) === selectedRoleId));
      host.appendChild(row);
    });
  }
  function renderOnlineResources() {
    var host = byId('voicebox-online-list'), category = categoryFilter(), query = searchQuery();
    if (!host) return;
    host.replaceChildren();
    var filtered = category === 'local' || category === 'role' ? [] : onlineResources.filter(function (resource) {
      return matchesSearch([resource.title, resource.description, resource.id, resource.engine, resource.presetVoiceId,
        resource.language, resource.source && resource.source.name, resource.license && resource.license.name]);
    });
    text(byId('voicebox-online-count'), onlineResources.length ? onlineResources.length + ' 个资源' : '');
    if (category === 'local' || category === 'role') { appendText(host, 'p', 'voicebox-empty', '当前分类隐藏在线资源。'); return; }
    if (onlineManifestStatus === 'unavailable' || onlineManifestStatus === 'unknown') {
      appendText(host, 'p', 'voicebox-empty', '在线目录不可用；本地 Profile 与角色声音保持可用。');
      return;
    }
    if (!filtered.length) {
      appendText(host, 'p', 'voicebox-empty', onlineResources.length ? '没有符合搜索条件的在线资源。' : 'Manifest 已验证；目前没有在线资源。');
      return;
    }
    var core = libraryCore();
    filtered.forEach(function (resource) {
      var card = document.createElement('article'); card.className = 'voicebox-online-resource'; card.dataset.resourceId = String(resource.id || '');
      var copy = document.createElement('div'); copy.className = 'voicebox-online-copy';
      appendText(copy, 'strong', '', resource.title);
      if (resource.description) appendText(copy, 'span', '', resource.description);
      var metadata = document.createElement('div'); metadata.className = 'voicebox-online-meta';
      var sourceLink = document.createElement('a'); sourceLink.textContent = '来源：' + resource.source.name;
      var safeSourceUrl = window.IBSafeImage && typeof window.IBSafeImage.normalizeLink === 'function'
        ? window.IBSafeImage.normalizeLink(resource.source.url) : '';
      if (safeSourceUrl) { sourceLink.href = safeSourceUrl; sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer'; }
      metadata.appendChild(sourceLink);
      var licenseText = resource.license.name + (resource.license.id ? ' (' + resource.license.id + ')' : '');
      var safeLicenseUrl = window.IBSafeImage && typeof window.IBSafeImage.normalizeLink === 'function'
        ? window.IBSafeImage.normalizeLink(resource.license.url) : '';
      if (safeLicenseUrl) {
        var licenseLink = document.createElement('a'); licenseLink.href = safeLicenseUrl; licenseLink.target = '_blank'; licenseLink.rel = 'noopener noreferrer'; licenseLink.textContent = '许可证：' + licenseText; metadata.appendChild(licenseLink);
      } else appendText(metadata, 'span', '', '许可证：' + licenseText);
      appendText(metadata, 'span', '', formatBytes(resource.sizeBytes) + ' · SHA-256 已列入 Manifest');
      appendText(metadata, 'span', '', 'Voicebox · ' + resource.engine + ' · ' + resource.language);
      copy.appendChild(metadata);
      var compat = onlineCompatibility[resource.id];
      appendText(copy, 'span', 'voicebox-library-state', compat && compat.ok ? 'Provider 兼容 · 预设音色已在本地 Runtime 验证' : compat && compat.pending ? '待验证：' + (runtimeAvailable ? '读取预设目录' : 'Voicebox Runtime 未连接') : '不可用：' + String(compat && compat.reason || '兼容性未知'));
      var imported = profileForResource(resource);
      var statusText = resourceState(resource);
      appendText(copy, 'span', 'voicebox-online-download-state', statusText);
      card.appendChild(copy);
      var actionWrap = document.createElement('div'); actionWrap.className = 'voicebox-online-actions';
      if (imported) {
        button(actionWrap, '切换到当前角色', 'btn btn-primary', function (_event, control) { bindProfile(imported, control); });
        button(actionWrap, '管理', 'btn', function () { var api = manager(); if (api && typeof api.open === 'function') api.open(); });
      } else {
        var download = button(actionWrap, '下载并导入', 'btn btn-primary', function (_event, control) { downloadAndImportResource(resource, control); });
        download.disabled = !(compat && compat.ok) || /^正在/.test(String(onlineOperationStatus[resource.id] || ''));
        if (!compat || !compat.ok) download.title = '必须连接 Voicebox 并验证精确的预设音色后才能导入。';
      }
      card.appendChild(actionWrap); host.appendChild(card);
    });
  }
  async function exportProfile(profile, control) {
    var core = libraryCore();
    if (!core || !profile || String(profile.voiceType || '') !== 'preset') {
      setStatus('仅支持导出 Voicebox 预设 Profile；克隆样本不会导出。', true); return;
    }
    var source = { name: 'Voicebox 本地预设 Profile' }, license = { id: 'not-declared', name: '本地 Profile 未声明许可证' };
    var remote = onlineResources.find(function (item) { return String(item.engine) === String(profile.presetEngine || profile.defaultEngine) && String(item.presetVoiceId) === String(profile.presetVoiceId); });
    var provenance = profileProvenance[String(profile.id || '')] || null;
    if (remote) { source = remote.source; license = remote.license; }
    else if (provenance) { source = provenance.source || source; license = provenance.license || license; }
    var packaged = core.packageFromProfile(profile, source, license);
    if (!packaged.ok) { setStatus('Profile 导出失败：' + packaged.reason, true); return; }
    var blob = new Blob([JSON.stringify(packaged.package, null, 2) + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = String(profile.name || 'voice-profile').replace(/[^a-z0-9\u4e00-\u9fff._-]+/gi, '-').slice(0, 72) + '.ib-voice-profile.json';
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('已导出预设 Profile 配置；文件不包含音频、API Key 或 Voicebox Profile ID。');
    if (control) control.disabled = false;
  }
  async function compatibleProfile(profile) {
    var core = libraryCore(), api = manager();
    if (!core || !runtimeAvailable || !api || typeof api.capabilities !== 'function' || typeof api.presetVoices !== 'function') {
      return { ok: false, pending: true, reason: 'voicebox-runtime-unavailable' };
    }
    var voices;
    try { voices = await api.presetVoices(profile.engine); }
    catch (e) { return { ok: false, pending: true, reason: 'provider-preset-list-unavailable' }; }
    return core.profileCompatibility(profile, api.capabilities(), voices);
  }
  async function downloadAndImportResource(resource, control) {
    var core = libraryCore(), api = manager();
    if (!core || !api || typeof api.importPresetProfile !== 'function') { setStatus('Profile 导入接口不可用。', true); return; }
    var compat = onlineCompatibility[resource.id];
    if (!runtimeAvailable || !compat || !compat.ok) { setStatus('Provider 兼容性尚未验证；资源未导入。', true); return; }
    onlineOperationStatus[resource.id] = '正在下载'; renderOnlineResources();
    if (control) control.disabled = true;
    try {
      var url = core.resourceUrl(resource);
      if (!url) throw new Error('资源 URL 不在固定 HTTPS 目录内。');
      var response = await fetchStaticResource(url, { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', headers: { Accept: 'application/json' } }, 15000);
      if (!response || response.status !== 200 || response.ok !== true || response.redirected === true || (response.url && response.url !== url)) {
        throw new Error('资源下载失败或发生重定向。');
      }
      var contentType = String(response.headers && response.headers.get && response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new Error('资源 Content-Type 必须是 application/json。');
      var contentLengthValue = response.headers && response.headers.get ? response.headers.get('Content-Length') : null;
      if (contentLengthValue != null && String(contentLengthValue).trim() !== '') {
        var contentLength = Number(contentLengthValue);
        if (!Number.isSafeInteger(contentLength) || contentLength !== resource.sizeBytes) throw new Error('资源 Content-Length 与 Manifest 不一致。');
      }
      onlineOperationStatus[resource.id] = '正在验证大小与 SHA-256'; renderOnlineResources();
      var bytes = await responseBytesLimited(response, core.MAX_PROFILE_BYTES);
      var verified = await core.verifyResourceBytes(resource, bytes, window.crypto);
      if (!verified.ok) {
        if (verified.reason === 'resource-size-mismatch') throw new Error('资源大小与 Manifest 不一致。');
        if (verified.reason === 'sha256-unavailable') throw new Error('当前浏览器无法进行 SHA-256 校验；资源未导入。');
        throw new Error('资源 SHA-256 校验失败。');
      }
      var packageValue;
      try { packageValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch (error) { throw new Error('资源 JSON 无效。'); }
      var checked = core.validateProfilePackage(packageValue);
      if (!checked.ok || !core.packageMatchesResource(checked.package, resource)) throw new Error('资源 Profile 与 Manifest 声明不一致。');
      var providerCheck = await compatibleProfile(checked.package.profile);
      if (!providerCheck.ok) throw new Error('当前 Voicebox Provider 不兼容：' + providerCheck.reason);
      onlineOperationStatus[resource.id] = '正在导入 Voicebox Profile'; renderOnlineResources();
      var created = await api.importPresetProfile(checked.package.profile);
      if (!created || !created.id) throw new Error('Voicebox 没有返回新 Profile。');
      profileProvenance[String(created.id)] = { source: resource.source, license: resource.license };
      onlineOperationStatus[resource.id] = '已导入到本地 Voicebox';
      setStatus('资源已校验并导入为本地 Voicebox 预设 Profile；角色声音尚未更改。');
      await refresh(true);
    } catch (error) {
      onlineOperationStatus[resource.id] = '导入失败：' + String(error && error.message || error);
      setStatus('在线资源未导入：' + String(error && error.message || error), true);
      renderOnlineResources();
    } finally { if (control) control.disabled = false; }
  }
  async function importProfileFile(input) {
    var file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file) return;
    var core = libraryCore(), api = manager();
    try {
      if (!core || file.size > core.MAX_PROFILE_BYTES) throw new Error('Profile 文件超过 64 KiB。');
      var packageValue;
      try { packageValue = JSON.parse(await file.text()); } catch (e) { throw new Error('Profile JSON 无效。'); }
      var checked = core.validateProfilePackage(packageValue);
      if (!checked.ok) throw new Error('Profile 格式无效：' + checked.reason);
      var compatible = await compatibleProfile(checked.package.profile);
      if (!compatible.ok) throw new Error('此 Voicebox 预设在当前 Runtime 不受支持：' + compatible.reason);
      if (!api || typeof api.importPresetProfile !== 'function') throw new Error('Profile 导入接口不可用。');
      var created = await api.importPresetProfile(checked.package.profile);
      if (!created || !created.id) throw new Error('Voicebox 没有返回新 Profile。');
      if (checked.package.source || checked.package.license) profileProvenance[String(created.id)] = { source: checked.package.source, license: checked.package.license };
      setStatus('Profile 已导入到本地 Voicebox；未上传角色数据，也未绑定到角色。');
      await refresh(true);
    } catch (error) { setStatus('Profile 导入失败：' + String(error && error.message || error), true); }
  }
  async function previewCurrentRole() {
    var role = selectedRole();
    if (!role) { setStatus('请先选择一个角色。', true); return; }
    var voice = role.voice || {};
    if (!voice.enabled) { setStatus('该角色没有启用语音合成；可通过「编辑角色声音配置」沿用现有设置流程。'); return; }
    if (String(voice.source || voice.provider || '').toLowerCase() === 'voicebox' && voice.voiceId) {
      var profile = profileById(voice.voiceId);
      if (profile) { await previewProfile(profile, byId('voicebox-preview-current')); return; }
      setStatus('当前 Voicebox Profile 不可用；角色配置未更改。', true); return;
    }
    try {
      if (typeof window.navTo === 'function') window.navTo('api');
      if (typeof window.editApi !== 'function' || typeof window.testCharacterVoice !== 'function') throw new Error('现有角色试听入口不可用。');
      window.editApi(String(role.id));
      await window.testCharacterVoice();
      if (typeof window.navTo === 'function') window.navTo('voicebox');
      setStatus('已调用现有角色 TTS 试听流程；未创建聊天消息。');
    } catch (error) {
      if (typeof window.navTo === 'function') window.navTo('voicebox');
      setStatus('试听失败：' + String(error && error.message || error), true);
    }
  }
  function editRoleVoice() {
    var role = selectedRole();
    if (!role) { setStatus('请先选择一个角色。', true); return; }
    if (typeof window.navTo === 'function') window.navTo('api');
    if (typeof window.editApi === 'function') window.editApi(String(role.id));
    var voice = byId('api-voice-group');
    if (voice && typeof voice.scrollIntoView === 'function') voice.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function readAsrStatus() {
    var bridgeAsr = false, settings = null;
    try { if (typeof window._voiceboxAsrSelected === 'function') bridgeAsr = await window._voiceboxAsrSelected(); } catch (e) {}
    try {
      if (typeof window._vtGet === 'function') settings = await window._vtGet();
      else if (typeof window.getVoiceTransSettings === 'function') settings = await window.getVoiceTransSettings();
    } catch (e) {}
    var hasExternal = !!(settings && settings.endpoint && (settings.credentialRef || settings.apiKey) && settings.model);
    var speechAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    if (bridgeAsr) {
      text(byId('voicebox-asr-provider'), 'Voicebox · Bridge');
      text(byId('voicebox-asr-detail'), '文件转写已启用；录音与 Chat 使用现有 ASR 路径。');
    } else if (hasExternal) {
      text(byId('voicebox-asr-provider'), 'OpenAI-compatible ASR');
      text(byId('voicebox-asr-detail'), String(settings.model || '外部转写服务') + ' · 使用现有语音转写设置。');
    } else if (speechAvailable) {
      text(byId('voicebox-asr-provider'), 'Browser SpeechRecognition');
      text(byId('voicebox-asr-detail'), '未启用外部转写服务；录音沿用浏览器识别。');
    } else {
      text(byId('voicebox-asr-provider'), '暂不可用');
      text(byId('voicebox-asr-detail'), '浏览器未提供内置识别；可在 API 设置中查看语音转写配置。');
    }
  }
  function renderRoleOptions() {
    var select = byId('voicebox-role-select');
    if (!select) return;
    var roles = configList();
    select.innerHTML = '';
    if (!roles.length) {
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = '没有可用角色'; select.appendChild(empty);
      selectedRoleId = '';
      return;
    }
    if (!roleById(selectedRoleId)) selectedRoleId = String(roles.find(function (role) { return role.voice && role.voice.enabled; })?.id || roles[0].id);
    roles.forEach(function (role) {
      var option = document.createElement('option');
      option.value = String(role.id);
      option.textContent = String(role.nickname || role.model || role.id);
      option.selected = option.value === selectedRoleId;
      select.appendChild(option);
    });
  }
  async function refresh(force) {
    if (refreshPromise) return refreshPromise;
    if (!force && lastRefreshAt && Date.now() - lastRefreshAt < 30000) {
      if (typeof window.loadApiConfigs === 'function') await window.loadApiConfigs();
      renderRoleOptions(); renderCurrentRole(); updateLibraryLists();
      return true;
    }
    refreshPromise = (async function () {
      var api = manager();
      text(byId('voicebox-runtime-status'), '正在读取角色与 Voicebox 配置…');
      var tasks = [];
      tasks.push(typeof window.loadApiConfigs === 'function' ? window.loadApiConfigs() : Promise.resolve());
      tasks.push(api && typeof api.refresh === 'function' ? api.refresh() : Promise.resolve(false));
      tasks.push(readAsrStatus());
      tasks.push(loadOnlineManifest());
      tasks.push(refreshRuntimeStatus());
      var result = await Promise.allSettled(tasks);
      runtimeAvailable = result[1] && result[1].status === 'fulfilled' && result[1].value === true;
      profiles = api && typeof api.profiles === 'function' ? api.profiles() : [];
      await checkResourceCompatibility();
      lastRefreshAt = Date.now();
      renderRoleOptions(); renderCurrentRole(); updateLibraryLists();
      var caps = api && typeof api.capabilities === 'function' ? api.capabilities() : null;
      var engines = caps && caps.engines ? Object.keys(caps.engines).join('、') : '';
      text(byId('voicebox-runtime-status'), runtimeAvailable
        ? 'Voicebox Runtime 可用' + (engines ? ' · Engines: ' + engines : '') + '。仅读取安装状态，不会自动下载模型。'
        : 'Voicebox Runtime 不可用；本地 ASR / 其他 TTS 配置仍按现有设置运行。');
      renderCloneFlow();
      return runtimeAvailable;
    })().finally(function () { refreshPromise = null; });
    return refreshPromise;
  }
  function init() {
    page = byId('page-voicebox');
    if (!page) return;
    var select = byId('voicebox-role-select');
    if (select) select.addEventListener('change', function () {
      selectedRoleId = String(select.value || '');
      renderCurrentRole(); updateLibraryLists();
    });
    var refreshButton = byId('voicebox-refresh');
    if (refreshButton) refreshButton.addEventListener('click', function () { refresh(true); });
    var pathSave = byId('voicebox-save-path'), startButton = byId('voicebox-start'), stopButton = byId('voicebox-stop');
    if (pathSave) pathSave.addEventListener('click', saveRuntimePath);
    if (startButton) startButton.addEventListener('click', function () { runRuntimeAction('start'); });
    if (stopButton) stopButton.addEventListener('click', function () { runRuntimeAction('stop'); });
    var executablePathInput = byId('voicebox-executable-path');
    if (executablePathInput) executablePathInput.addEventListener('input', function () { runtimePathDirty = true; });
    var currentPreview = byId('voicebox-preview-current');
    if (currentPreview) currentPreview.addEventListener('click', previewCurrentRole);
    var cloneOpen = byId('voicebox-clone-open');
    if (cloneOpen) cloneOpen.addEventListener('click', openCloneFlow);
    var cancelPreviewButton = byId('voicebox-cancel-preview');
    if (cancelPreviewButton) cancelPreviewButton.addEventListener('click', cancelPreview);
    window.addEventListener('ib:voicebox-preview-state', function (event) {
      var state = event && event.detail || {}, control = byId('voicebox-cancel-preview');
      previewing = state.active === true;
      if (control) { control.hidden = !previewing; control.disabled = false; control.textContent = state.label || '取消生成'; }
    });
    window.addEventListener('ib:voicebox-profiles-changed', function () {
      if (page && page.classList.contains('active')) refresh(true);
    });
    var editButton = byId('voicebox-edit-role');
    if (editButton) editButton.addEventListener('click', editRoleVoice);
    var search = byId('voicebox-library-search');
    if (search) search.addEventListener('input', updateLibraryLists);
    var category = byId('voicebox-library-category');
    if (category) category.addEventListener('change', updateLibraryLists);
    var importButton = byId('voicebox-profile-import'), importFile = byId('voicebox-profile-import-file');
    if (importButton && importFile) importButton.addEventListener('click', function () { importFile.click(); });
    if (importFile) importFile.addEventListener('change', function () { importProfileFile(importFile); });
    var onlineRefresh = byId('voicebox-online-refresh');
    if (onlineRefresh) onlineRefresh.addEventListener('click', async function () {
      onlineRefresh.disabled = true;
      try { await loadOnlineManifest(); await checkResourceCompatibility(); updateLibraryLists(); }
      finally { onlineRefresh.disabled = false; }
    });
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(function () { if (page.classList.contains('active')) refresh(false); });
      observer.observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    if (!runtimeStatusTimer && typeof window.setInterval === 'function') {
      runtimeStatusTimer = window.setInterval(function () {
        if (page && page.classList.contains('active') && document.visibilityState !== 'hidden') refreshRuntimeStatus();
      }, 6000);
    }
    if (page.classList.contains('active')) refresh(false);
  }
  window.IBVoiceboxPage = Object.freeze({ refresh: refresh, refreshOnline: loadOnlineManifest, refreshRuntimeStatus: refreshRuntimeStatus, cancelPreview: cancelPreview });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
