/* ====================================================================
   IB Role DM UI — 角色私信（角色 ↔ 角色）的显示层
   --------------------------------------------------------------------
   边界（本文件**只**做显示与交互，不做任何判定）：
     · 唯一的执行入口是 IB.roleDm.start / IB.roleDm.clearThread /
       IB.roleDm.deleteThread —— 本文件绝不自己调用模型、绝不自己写存储。
     · 本文件不渲染用户输入框：用户不是角色私信的 participant。
       用户能做的三件事被明确做成三个独立按钮：让她们聊一会儿 / 停止 /
       给话题（可选，只作为本次 run 的 trigger context，绝不写进 persona）。
     · 本文件不订阅 DOM 事件之外的东西：scheduler 若以后要驱动 run，
       它调用 IB.roleDm.startAutonomous（canonical trigger API），
       **绝不**碰 DOM；本层只通过 IB.roleDmEmit 的轻量事件重绘。
   ==================================================================== */
(function (NS) {
  'use strict';

  var activeThreadId = null;
  var _currentAbort = null;
  var _busy = false;
  var _unsub = null;
  var _detailRenderSequence = 0;
  var _apiConfigRefreshPromise = null;
  var _apiConfigRefreshAt = 0;
  var _replay = null;
  var _replaySequence = 0;
  var _replayStatusText = '就绪';
  var _currentSubview = 'list';
  var _returnToGallery = false;
  var _galleryScenes = [];
  var _galleryRenderSequence = 0;

  var RUN_STOP_TEXT = {
    'max-turns': '聊到本轮的轮数上限，自然停下来了。',
    'run-complete': '这一轮聊完了。',
    'natural-end': '她们自然地把话停在这里了。',
    'silent-stall': '两边都选择了先听一听，本轮就停在这里。',
    'consecutive-cap': '上一位角色已经连续完成两次模型生成，这次先交给对方。',
    'duplicate-stall': '两边开始重复同一件事，已停下（没有把重复的话写进记录）。',
    'low-info-stall': '对话变得空洞重复，已停下。',
    'aborted': '已停止。',
    'provider-failed': '有一方没能回应（模型请求失败），本轮已安全停止；已经聊过的内容都保留着。',
    /* 输出类失败（Phase 3.1）：请求是成功的，模型只是没生成可用正文。
       文案**只**说这件事 —— 绝不写"API 请求失败 / 检查密钥 / 网络错误 /
       模型不可用"：这些都没有证据，而它们会把用户引去查三个没坏的东西
       （实测到的形态是思考把输出预算吃光了，见 docs/DECISIONS.md D24/D25）。 */
    'output-truncated': '有一方的模型没来得及写出正文（输出被思考占满了），本轮已停止；已经聊过的内容都保留着。可以稍后重试，或调低该角色模型的思考档位、提高输出上限。',
    'empty-output': '有一方的模型这一轮没有给出正文，本轮已停止；已经聊过的内容都保留着。可以稍后重试。',
    'provider-not-ready': '有一方的模型配置不完整，本轮无法开始。请到 API 页面补全。',
    'missing-character': '参与的一方已经不在站点里了，本轮无法继续。',
    'persist-failed': '消息没能保存下来，本轮已停止。',
    'delivery-unavailable': '消息交付暂时不可用，本轮已安全停止。',
    'delivery-failed': '消息交付未能完成；已经保存的消息会保留。',
    'bad-delivery-sequence': '本轮消息格式无法交付，已安全停止。',
    'pair-cooldown': '刚聊过，稍等一会儿再继续。',
    'role-daily-cap': '今天聊得够多了，明天再继续。',
    'thread-busy': '这段私聊正在聊，请等它结束。',
    'character-busy': '有一方正在别处回复，稍后再试。',
    'bad-message': '这一轮的内容没能通过校验，已停止。',
    'run-error': '本轮遇到意外错误，已安全停止。'
  };

  function el(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function sceneCreatedLabel(timestamp) {
    var value = Number(timestamp) || 0;
    if (!value) return '时间未知';
    try { return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return new Date(value).toLocaleString(); }
  }
  function sceneTagsHtml(tags) {
    var list = Array.isArray(tags) ? tags : [];
    if (!list.length) return '<span class="roledm-scene-empty">暂无标签</span>';
    return list.map(function (tag) { return '<span class="roledm-scene-tag">' + esc(tag) + '</span>'; }).join('');
  }
  function scenePanelHtml(scene) {
    var data = scene && typeof scene === 'object' ? scene : {};
    var participants = Array.isArray(data.participants) ? data.participants : [];
    var names = participants.map(function (participant) {
      return esc(participant && participant.name || '角色') + (participant && participant.missing ? '（已删除）' : '');
    }).join(' · ') || '角色信息不可用';
    var playback = data.playback && typeof data.playback === 'object' ? data.playback : {};
    var title = String(data.title || 'Role DM Scene');
    var tags = Array.isArray(data.tags) ? data.tags : [];
    return '<section class="roledm-scene-panel" id="roledm-scene-panel" aria-label="当前 Scene 信息">'
      + '<div class="roledm-scene-summary">'
      + '<span class="roledm-scene-label">SCENE</span><strong class="roledm-scene-title" id="roledm-scene-title-display">' + esc(title) + '</strong>'
      + '<span class="roledm-scene-participants" id="roledm-scene-participants">' + names + '</span>'
      + '<span class="roledm-scene-created" id="roledm-scene-created">创建于 ' + esc(sceneCreatedLabel(data.createdAt)) + '</span>'
      + '<div class="roledm-scene-tags" id="roledm-scene-tags">' + sceneTagsHtml(tags) + '</div></div>'
      + '<details class="roledm-scene-edit"><summary>场景设置</summary><div class="roledm-scene-fields">'
      + '<label>场景标题<input id="roledm-scene-title" type="text" maxlength="80" value="' + esc(title) + '"></label>'
      + '<label>标签<input id="roledm-scene-tags-input" type="text" maxlength="240" value="' + esc(tags.join(', ')) + '" placeholder="例如：排练、周末" aria-describedby="roledm-scene-tags-hint"></label>'
      + '<span id="roledm-scene-tags-hint" class="roledm-scene-hint">用逗号分隔，最多 8 个标签。</span>'
      + '<label>语音<select id="roledm-scene-voice-mode"><option value="auto"' + (playback.voiceMode === 'text' ? '' : ' selected') + '>自动使用角色声音</option><option value="text"' + (playback.voiceMode === 'text' ? ' selected' : '') + '>文字回放</option></select></label>'
      + '<label>文字节奏<select id="roledm-scene-text-pacing"><option value="natural"' + (playback.textPacing === 'fast' ? '' : ' selected') + '>自然</option><option value="fast"' + (playback.textPacing === 'fast' ? ' selected' : '') + '>较快</option></select></label>'
      + '</div><div class="roledm-scene-actions"><button type="button" class="btn" id="roledm-scene-save">保存场景</button>'
      + '<span class="roledm-scene-save-state" id="roledm-scene-save-state" role="status" aria-live="polite"></span></div></details></section>';
  }
  function updateScenePanel(scene, saveStatus) {
    var data = scene && typeof scene === 'object' ? scene : {};
    var participants = Array.isArray(data.participants) ? data.participants : [];
    var names = participants.map(function (participant) {
      return String(participant && participant.name || '角色') + (participant && participant.missing ? '（已删除）' : '');
    }).join(' · ') || '角色信息不可用';
    var playback = data.playback && typeof data.playback === 'object' ? data.playback : {};
    var title = String(data.title || 'Role DM Scene'), tags = Array.isArray(data.tags) ? data.tags : [];
    var titleDisplay = el('roledm-scene-title-display'), participantDisplay = el('roledm-scene-participants');
    var createdDisplay = el('roledm-scene-created'), tagDisplay = el('roledm-scene-tags');
    var titleInput = el('roledm-scene-title'), tagsInput = el('roledm-scene-tags-input');
    var voiceInput = el('roledm-scene-voice-mode'), pacingInput = el('roledm-scene-text-pacing');
    var status = el('roledm-scene-save-state');
    if (titleDisplay) titleDisplay.textContent = title;
    if (participantDisplay) participantDisplay.textContent = names;
    if (createdDisplay) createdDisplay.textContent = '创建于 ' + sceneCreatedLabel(data.createdAt);
    if (tagDisplay) tagDisplay.innerHTML = sceneTagsHtml(tags);
    if (titleInput) titleInput.value = title;
    if (tagsInput) tagsInput.value = tags.join(', ');
    if (voiceInput) voiceInput.value = playback.voiceMode === 'text' ? 'text' : 'auto';
    if (pacingInput) pacingInput.value = playback.textPacing === 'fast' ? 'fast' : 'natural';
    if (status) { status.textContent = saveStatus || ''; status.dataset.state = saveStatus ? 'saved' : ''; }
  }
  async function onSaveScene() {
    var api = rd(), threadId = activeThreadId;
    var saveButton = el('roledm-scene-save'), status = el('roledm-scene-save-state');
    if (!api || typeof api.updateSceneMetadata !== 'function' || !threadId || !saveButton) return;
    var title = el('roledm-scene-title'), tags = el('roledm-scene-tags-input');
    var voiceMode = el('roledm-scene-voice-mode'), textPacing = el('roledm-scene-text-pacing');
    var rawTags = tags ? String(tags.value || '').split(/[,，]/) : [];
    saveButton.disabled = true;
    if (status) { status.textContent = '正在保存…'; status.dataset.state = 'saving'; }
    var result = null;
    try {
      result = await api.updateSceneMetadata(threadId, {
        title: title ? String(title.value || '') : '',
        tags: rawTags,
        playback: {
          voiceMode: voiceMode ? String(voiceMode.value || 'auto') : 'auto',
          textPacing: textPacing ? String(textPacing.value || 'natural') : 'natural'
        }
      });
    } catch (e) { result = null; }
    if (saveButton.isConnected) saveButton.disabled = false;
    if (threadId !== activeThreadId) return;
    if (!result || result.ok !== true || !result.scene) {
      if (status) { status.textContent = '场景信息未能保存'; status.dataset.state = 'failed'; }
      return;
    }
    updateScenePanel(result.scene, _replay ? '已保存，将用于下一次回放' : '已保存');
  }
  function rd() { try { return NS.roleDm || null; } catch (e) { return null; } }
  /* Startup routing can open Role DM before active-diary.js finishes its async
     IndexedDB/API-config bootstrap. A missing in-memory config at that moment is
     not evidence of deletion; refresh the canonical config list before resolving
     thread participant labels and readiness. */
  function refreshApiConfigs(force) {
    var loader = null;
    try { loader = window && window.loadApiConfigs; } catch (e) { loader = null; }
    if (typeof loader !== 'function') return Promise.resolve(false);
    if (_apiConfigRefreshPromise) return _apiConfigRefreshPromise;
    if (!force && _apiConfigRefreshAt && Date.now() - _apiConfigRefreshAt < 2500) return Promise.resolve(true);
    _apiConfigRefreshPromise = Promise.resolve().then(function () { return loader(); }).then(function () {
      _apiConfigRefreshAt = Date.now();
      return true;
    }, function () { return false; }).then(function (result) {
      _apiConfigRefreshPromise = null;
      return result;
    }, function () {
      _apiConfigRefreshPromise = null;
      return false;
    });
    return _apiConfigRefreshPromise;
  }
  /* 自主社交层（Phase 3）。**可能不存在** —— 它是可选能力，本文件必须在
     它缺席时完整可用（手动角色私信不依赖自主调度）。
     注意本文件绝不 import 它：UI 只是它的一个消费者。 */
  function soc() { try { return NS.roleDmSocial || null; } catch (e) { return null; } }
  function isDevCalibrationContext() {
    try { return window.__IB_DEV_MODE__ === true; } catch (e) { return false; }
  }

  function timeLabel(ts) {
    var t = Number(ts) || 0;
    if (!t) return '';
    var d = new Date(t), now = new Date(), pad = function (n) { return String(n).padStart(2, '0'); };
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    var yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return '昨天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    var days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    if (now - d < 7 * 86400000) return days[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function voiceProfileForRole(roleId) {
    var configs = [];
    try { configs = Array.isArray(window.apiConfigs) ? window.apiConfigs : []; } catch (e) { configs = []; }
    var config = null;
    for (var i = 0; i < configs.length; i++) {
      if (configs[i] && String(configs[i].id || '') === String(roleId || '')) { config = configs[i]; break; }
    }
    var voice = config && config.voice;
    return voice && voice.enabled === true ? voice : null;
  }
  function roleDmVoiceState(value) {
    if (value === 'generating' || value === 'loading') return 'thinking';
    if (value === 'playing') return 'speaking';
    if (value === 'paused' || value === 'interrupted' || value === 'cancelled' || value === 'stopped') return 'interrupted';
    if (value === 'failed') return 'error';
    return 'idle';
  }
  function setRoleDmVoiceExpression(roleId, messageId, bubble, voiceState, text) {
    var expressions = window.IBExpressionPacks;
    if (!expressions || typeof expressions.decorateMessage !== 'function') return;
    var state = String(voiceState || 'idle');
    var override = state === 'speaking' ? 'voiceExpression' : (state === 'thinking' ? 'typingExpression' : (state === 'error' ? 'errorExpression' : (state === 'interrupted' ? 'neutralExpression' : '')));
    var options = { text: String(text || '') };
    if (override) options.stateOverride = override;
    expressions.decorateMessage(roleId, messageId, bubble, options);
  }
  function updateRoleDmVoiceStatus(row, message, bubble, button, status, state) {
    if (!row || !row.isConnected) {
      if (state === 'playing') {
        var detachedAudio = bubble && bubble.querySelector('.ib-tts-bar');
        try { if (window.IB && window.IB.bridge && typeof window.IB.bridge.stopVoicePlayback === 'function') window.IB.bridge.stopVoicePlayback(row || bubble); } catch (e) { }
        try { if (detachedAudio && detachedAudio._au) detachedAudio._au.pause(); } catch (e) { }
      }
      return;
    }
    var value = String(state || '');
    if (row._ibRoleDmVoiceState === value) return;
    row._ibRoleDmVoiceState = value;
    var voiceState = roleDmVoiceState(value);
    row.dataset.voiceStatus = voiceState;
    setRoleDmVoiceExpression(message.senderId, message.id, bubble, voiceState, message.content);
    if (!status) return;
    status.dataset.state = value;
    if (value === 'generating') status.textContent = '正在生成语音…';
    else if (value === 'loading') status.textContent = '正在加载语音…';
    else if (value === 'playing') status.textContent = '正在播放';
    else if (value === 'paused') status.textContent = '已暂停';
    else if (value === 'interrupted' || value === 'cancelled' || value === 'stopped') status.textContent = '语音已中断';
    else if (value === 'ended') status.textContent = '播放结束，可点语音条重播';
    else if (value === 'failed') status.textContent = '语音播放失败；文字回复仍可阅读。';
    if (button && button.isConnected) {
      button.disabled = !!(_replay && !_replay.stopped) || value === 'generating' || value === 'loading' || value === 'playing';
      if (value === 'failed') button.textContent = '重试语音';
      else if (value === 'paused' || value === 'ended' || value === 'interrupted' || value === 'cancelled' || value === 'stopped') button.textContent = '播放语音';
      else if (value === 'generating' || value === 'loading') button.textContent = '准备语音…';
    }
  }
  function playRoleDmVoice(row, message, voice, button) {
    var bridge = window.IB && window.IB.bridge;
    var bubble = row && row.querySelector('.roledm-bubble');
    var status = row && row.querySelector('.roledm-voice-state');
    if (!bridge || typeof bridge.speakText !== 'function' || !bubble) {
      updateRoleDmVoiceStatus(row, message, bubble, button, status, 'failed');
      if (status) status.textContent = '语音播放暂不可用；文字回复仍可阅读。';
      return;
    }
    row._ibRoleDmVoiceMessage = message;
    var started = false;
    try { started = bridge.speakText(String(message.content || ''), voice, bubble, button, function (state) {
      updateRoleDmVoiceStatus(row, message, bubble, button, status, state);
    }) === true; } catch (e) { started = false; }
    if (started !== true) updateRoleDmVoiceStatus(row, message, bubble, button, status, 'failed');
  }
  function stopRoleDmAudioIn(host) {
    if (!host || !host.querySelectorAll) return;
    try { if (window.IB && window.IB.bridge && typeof window.IB.bridge.stopVoicePlayback === 'function') window.IB.bridge.stopVoicePlayback(host); } catch (e) { }
    Array.prototype.forEach.call(host.querySelectorAll('.ib-tts-bar'), function (bar) {
      try { if (bar._au && !bar._au.paused) bar._au.pause(); } catch (e) { }
    });
    Array.prototype.forEach.call(host.querySelectorAll('.roledm-msg'), function (row) {
      var message = row._ibRoleDmVoiceMessage, bubble = row.querySelector('.roledm-bubble');
      if (message && (row._ibRoleDmVoiceState === 'generating' || row._ibRoleDmVoiceState === 'loading' || row._ibRoleDmVoiceState === 'playing' || row._ibRoleDmVoiceState === 'paused')) {
        updateRoleDmVoiceStatus(row, message, bubble, row.querySelector('.roledm-voice-btn'), row.querySelector('.roledm-voice-state'), 'interrupted');
      }
    });
  }

  /* Scene Replay is an in-memory observer of the current thread. It snapshots the
     existing read-only detail response and never writes messages or audio. */
  function isCurrentReplay(state) { return !!state && _replay === state && !state.stopped; }
  function setReplayStatus(text, state) {
    _replayStatusText = String(text || '');
    var status = el('roledm-replay-status');
    if (status) status.textContent = _replayStatusText;
    if (status) status.dataset.state = state || (_replay && _replay.phase) || 'idle';
  }
  function replayVoiceButtonsLocked() { return !!(_replay && !_replay.stopped); }
  function syncReplayControls() {
    var state = _replay && !_replay.stopped ? _replay : null;
    var start = el('roledm-replay-start'), pause = el('roledm-replay-pause');
    var resume = el('roledm-replay-resume'), stop = el('roledm-replay-stop');
    if (start) start.disabled = !!state || !activeThreadId || start.dataset.hasMessages === 'false';
    if (pause) pause.disabled = !state || state.preparing || state.phase !== 'playing';
    if (resume) resume.disabled = !state || state.phase !== 'paused';
    if (stop) stop.disabled = !state;
    var runStart = el('roledm-start-btn');
    if (runStart) runStart.disabled = !!state || runStart.dataset.baseDisabled === 'true';
    var body = el('roledm-detail-body');
    if (body) Array.prototype.forEach.call(body.querySelectorAll('.roledm-voice-btn'), function (button) {
      var row = button.closest ? button.closest('.roledm-msg') : null;
      var voiceState = row && row._ibRoleDmVoiceState;
      button.disabled = replayVoiceButtonsLocked() || voiceState === 'generating' || voiceState === 'loading' || voiceState === 'playing';
    });
    var status = el('roledm-replay-status');
    if (status && !state) status.textContent = _replayStatusText;
  }
  function findReplayRow(body, messageId) {
    if (!body || !body.querySelectorAll) return null;
    var rows = body.querySelectorAll('.roledm-msg[data-message-id]');
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].getAttribute('data-message-id') || '') === String(messageId || '')) return rows[i];
    }
    return null;
  }
  function clearReplayHighlight(state) {
    if (!state || !state.currentRow) return;
    state.currentRow.classList.remove('roledm-replay-current');
    state.currentRow.removeAttribute('aria-current');
    state.currentRow = null;
  }
  function setReplayHighlight(state, row) {
    clearReplayHighlight(state);
    state.currentRow = row;
    if (!row) return;
    row.classList.add('roledm-replay-current');
    row.setAttribute('aria-current', 'step');
    var behavior = 'smooth';
    try { if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) behavior = 'auto'; } catch (e) { }
    try { row.scrollIntoView({ behavior: behavior, block: 'center' }); } catch (e) { try { row.scrollIntoView(); } catch (ignored) { } }
  }
  function replayDelayMs(message, playback) {
    var length = String(message && message.content || '').trim().length;
    if (playback && playback.textPacing === 'fast') return Math.max(350, Math.min(1600, 260 + length * 9));
    return Math.max(1100, Math.min(5200, 480 + length * 28));
  }
  function armReplayDelay(state, waiter) {
    if (!isCurrentReplay(state) || state.phase === 'paused' || waiter.timer) return;
    waiter.startedAt = Date.now();
    waiter.timer = setTimeout(function () {
      waiter.timer = null;
      if (state.waiter === waiter) state.waiter = null;
      waiter.resolve();
    }, Math.max(0, waiter.remaining));
  }
  function waitReplayDelay(state, duration) {
    return new Promise(function (resolve) {
      var waiter = { kind: 'delay', remaining: duration, startedAt: 0, timer: null, resolve: resolve };
      state.waiter = waiter;
      armReplayDelay(state, waiter);
    });
  }
  function waitReplayResume(state) {
    if (!isCurrentReplay(state) || state.phase !== 'paused') return Promise.resolve();
    return new Promise(function (resolve) { state.resumeWaiters.push(resolve); });
  }
  function wakeReplayResumeWaiters(state) {
    if (!state || !state.resumeWaiters) return;
    var waiters = state.resumeWaiters.splice(0);
    waiters.forEach(function (resolve) { try { resolve(); } catch (e) { } });
  }
  function settleReplayVoice(state, result) {
    var waiter = state && state.voiceWait;
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    state.voiceWait = null;
    waiter.resolve(result);
  }
  function replayVoice(state, row, message, voice) {
    return new Promise(function (resolve) {
      var bridge = window.IB && window.IB.bridge;
      var bubble = row && row.querySelector('.roledm-bubble');
      var button = row && row.querySelector('.roledm-voice-btn');
      var status = row && row.querySelector('.roledm-voice-state');
      if (!bridge || typeof bridge.speakText !== 'function' || !bubble || !button) { resolve('failed'); return; }
      var waiter = { resolve: resolve, settled: false };
      state.voiceWait = waiter;
      state.activeBubble = bubble;
      state.activeVoiceControl = { cancelled: false };
      state.activeAudio = null;
      state.browserSpeech = false;
      state.voiceStarted = false;
      var onStatus = function (rawState) {
        if (!isCurrentReplay(state) || state.currentRow !== row) return;
        var value = String(rawState || '');
        updateRoleDmVoiceStatus(row, message, bubble, button, status, value);
        if (value === 'generating' || value === 'loading') {
          state.activeAudio = null;
          state.browserSpeech = false;
          setReplayStatus('正在回放 ' + (state.index + 1) + ' / ' + state.messages.length + ' · ' + message.senderName + ' 正在准备语音', 'playing');
        } else if (value === 'playing') {
          state.voiceStarted = true;
          var bar = bubble.querySelector('.ib-tts-bar');
          state.activeAudio = bar && bar._au || null;
          state.browserSpeech = !state.activeAudio;
          setReplayStatus('正在回放 ' + (state.index + 1) + ' / ' + state.messages.length + ' · ' + message.senderName + ' 正在发言', 'playing');
          if (state.phase === 'paused') {
            if (state.activeAudio) { try { state.activeAudio.pause(); } catch (e) { } }
            else if (state.browserSpeech) { try { if (window.speechSynthesis) window.speechSynthesis.pause(); } catch (e) { } }
          }
        } else if (value === 'paused') {
          if (state.phase === 'playing') settleReplayVoice(state, 'failed');
          else setReplayStatus('已暂停 · ' + (state.index + 1) + ' / ' + state.messages.length, 'paused');
        } else if (value === 'ended') {
          settleReplayVoice(state, 'ended');
        } else if (value === 'failed') {
          settleReplayVoice(state, 'failed');
        } else if (value === 'interrupted' || value === 'cancelled') {
          settleReplayVoice(state, 'cancelled');
        }
      };
      var started = false;
      try { started = bridge.speakText(String(message.content || ''), voice, bubble, button, onStatus, state.activeVoiceControl) === true; } catch (e) { started = false; }
      if (!started) settleReplayVoice(state, 'failed');
    });
  }
  function cancelReplayVoice(state) {
    if (!state) return;
    if (state.activeVoiceControl) state.activeVoiceControl.cancelled = true;
    try { if (window.IB && window.IB.bridge && typeof window.IB.bridge.stopVoicePlayback === 'function') window.IB.bridge.stopVoicePlayback(state.currentRow || null); } catch (e) { }
    try { if (state.activeAudio && !state.activeAudio.paused) state.activeAudio.pause(); } catch (e) { }
    if (state.browserSpeech) { try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { } }
    settleReplayVoice(state, 'cancelled');
    if (state.currentRow && state.currentMessage) {
      var bubble = state.currentRow.querySelector('.roledm-bubble');
      var button = state.currentRow.querySelector('.roledm-voice-btn');
      var status = state.currentRow.querySelector('.roledm-voice-state');
      setRoleDmVoiceExpression(state.currentMessage.senderId, state.currentMessage.id, bubble, 'interrupted', state.currentMessage.content);
      state.currentRow._ibRoleDmVoiceState = 'stopped';
      state.currentRow.dataset.voiceStatus = 'interrupted';
      if (status) { status.dataset.state = 'stopped'; status.textContent = '回放已停止'; }
      if (button) { button.disabled = false; button.textContent = '播放语音'; }
    }
  }
  function stopReplay(reason) {
    var state = _replay;
    if (!state) return false;
    state.stopped = true;
    state.phase = 'stopped';
    _replay = null;
    if (state.waiter) {
      var waiter = state.waiter;
      state.waiter = null;
      if (waiter.timer) { clearTimeout(waiter.timer); waiter.timer = null; }
      try { waiter.resolve(); } catch (e) { }
    }
    cancelReplayVoice(state);
    clearReplayHighlight(state);
    wakeReplayResumeWaiters(state);
    setReplayStatus(reason === 'view-refresh' ? '回放已结束（对话刷新）' : '回放已停止', 'stopped');
    syncReplayControls();
    return true;
  }
  function pauseReplay() {
    var state = _replay;
    if (!state || state.stopped || state.preparing || state.phase !== 'playing') return false;
    state.phase = 'paused';
    if (state.waiter && state.waiter.kind === 'delay' && state.waiter.timer) {
      var delay = state.waiter;
      clearTimeout(delay.timer);
      delay.timer = null;
      delay.remaining = Math.max(0, delay.remaining - (Date.now() - delay.startedAt));
    }
    if (state.activeAudio && !state.activeAudio.paused) { try { state.activeAudio.pause(); } catch (e) { } }
    else if (state.browserSpeech && state.voiceStarted) { try { if (window.speechSynthesis) window.speechSynthesis.pause(); } catch (e) { } }
    setReplayStatus('已暂停 · ' + Math.min(state.index + 1, state.messages.length) + ' / ' + state.messages.length, 'paused');
    syncReplayControls();
    return true;
  }
  function resumeReplay() {
    var state = _replay;
    if (!state || state.stopped || state.phase !== 'paused') return false;
    state.phase = 'playing';
    if (state.waiter && state.waiter.kind === 'delay') armReplayDelay(state, state.waiter);
    if (state.activeAudio && state.activeAudio.paused && !state.activeAudio.ended) {
      try { state.activeAudio.play().catch(function () { settleReplayVoice(state, 'failed'); }); } catch (e) { settleReplayVoice(state, 'failed'); }
    } else if (state.browserSpeech && state.voiceStarted) { try { if (window.speechSynthesis) window.speechSynthesis.resume(); } catch (e) { } }
    wakeReplayResumeWaiters(state);
    setReplayStatus('正在回放 ' + Math.min(state.index + 1, state.messages.length) + ' / ' + state.messages.length, 'playing');
    syncReplayControls();
    return true;
  }
  async function runReplay(state) {
    try {
      for (var i = 0; i < state.messages.length; i++) {
        if (!isCurrentReplay(state)) return false;
        state.index = i;
        var message = state.messages[i];
        state.currentMessage = message;
        var row = findReplayRow(el('roledm-detail-body'), message.id);
        if (!row) continue;
        setReplayHighlight(state, row);
        var voice = state.scene.playback.voiceMode === 'text' ? null : (state.voiceByRole[String(message.senderId || '')] || null);
        setReplayStatus('正在回放 ' + (i + 1) + ' / ' + state.messages.length + ' · ' + message.senderName, 'playing');
        if (voice && window.IB && window.IB.bridge && typeof window.IB.bridge.speakText === 'function') {
          var result = 'failed';
          try { result = await replayVoice(state, row, message, voice); } catch (e) { result = 'failed'; }
          if (!isCurrentReplay(state)) return false;
          if (result === 'failed') {
            setRoleDmVoiceExpression(message.senderId, message.id, row.querySelector('.roledm-bubble'), 'idle', message.content);
            setReplayStatus('语音不可用，正在显示文字 ' + (i + 1) + ' / ' + state.messages.length, 'playing');
            await waitReplayDelay(state, replayDelayMs(message, state.scene.playback));
          }
        } else {
          setReplayStatus('正在回放 ' + (i + 1) + ' / ' + state.messages.length + ' · 文字显示', 'playing');
          await waitReplayDelay(state, replayDelayMs(message, state.scene.playback));
        }
        if (!isCurrentReplay(state)) return false;
        await waitReplayResume(state);
        if (!isCurrentReplay(state)) return false;
      }
    } catch (e) {
      if (isCurrentReplay(state)) {
        stopReplay('error');
        setReplayStatus('回放遇到问题，已安全停止', 'failed');
      }
      return false;
    }
    if (!isCurrentReplay(state)) return false;
    state.stopped = true;
    state.phase = 'complete';
    _replay = null;
    clearReplayHighlight(state);
    wakeReplayResumeWaiters(state);
    setReplayStatus('回放完成 · ' + state.messages.length + ' 条消息', 'complete');
    syncReplayControls();
    return true;
  }
  async function startReplay() {
    if (_replay) stopReplay('restarted');
    var api = rd(), threadId = activeThreadId;
    if (!api || !threadId) return false;
    var body = el('roledm-detail-body');
    stopRoleDmAudioIn(body);
    var state = {
      id: ++_replaySequence, threadId: threadId, phase: 'playing', preparing: true,
      stopped: false, index: -1, messages: [], voiceByRole: Object.create(null),
      currentRow: null, currentMessage: null, activeBubble: null, activeAudio: null,
      activeVoiceControl: null, browserSpeech: false, voiceStarted: false,
      waiter: null, voiceWait: null, resumeWaiters: []
    };
    _replay = state;
    setReplayStatus('正在读取当前对话…', 'playing');
    syncReplayControls();
    var detail = null;
    try { detail = await api.threadDetail(threadId); } catch (e) { detail = null; }
    if (!isCurrentReplay(state) || activeThreadId !== threadId) return false;
    if (!detail || !Array.isArray(detail.messages)) {
      state.stopped = true; _replay = null; setReplayStatus('无法读取当前对话', 'failed'); syncReplayControls(); return false;
    }
    state.messages = detail.messages.filter(function (message) {
      return !!message && !!String(message.id || '') && !!String(message.senderId || '') && !!String(message.content || '').trim();
    }).map(function (message) {
      return { id: String(message.id), senderId: String(message.senderId), senderName: String(message.senderName || '角色'), content: String(message.content || '') };
    });
    state.scene = detail.scene && detail.scene.playback ? detail.scene : {
      playback: { voiceMode: 'auto', textPacing: 'natural' }
    };
    (detail.participants || []).forEach(function (participant) {
      var voice = participant && voiceProfileForRole(participant.id);
      if (!voice) return;
      try { state.voiceByRole[String(participant.id)] = JSON.parse(JSON.stringify(voice)); }
      catch (e) { state.voiceByRole[String(participant.id)] = voice; }
    });
    state.preparing = false;
    if (!state.messages.length) {
      state.stopped = true; _replay = null; setReplayStatus('当前对话没有可回放的文字消息', 'idle'); syncReplayControls(); return false;
    }
    syncReplayControls();
    state.promise = runReplay(state);
    return state.promise;
  }

  /* ── 列表 ─────────────────────────────────────────────────────── */
  async function renderList() {
    var host = el('roledm-list');
    if (!host) return;
    var api = rd();
    if (!api) { host.innerHTML = '<div class="empty-state"><span>✉</span>角色私信模块未就绪。</div>'; return; }
    await refreshApiConfigs(true);
    var threads = await api.listThreads();
    if (!threads.length) {
      host.innerHTML = '<div class="empty-state"><span>✉</span>还没有角色之间的私聊 — 点「+ 新建角色私信」开始。</div>';
      return;
    }
    host.innerHTML = threads.map(function (t) {
      var avatarA = avatarHtml(t.participants[0]);
      var avatarB = avatarHtml(t.participants[1]);
      var last = t.lastPreview ? esc(t.lastPreview) + (String(t.lastPreview).length >= 60 ? '…' : '') : '<span class="roledm-muted">（还没有消息）</span>';
      var badges = [];
      if (t.running) badges.push('<span class="roledm-badge running">正在聊</span>');
      if (t.state === 'archived') badges.push('<span class="roledm-badge archived">已归档</span>');
      var missing = t.participants.filter(function (p) { return p.missing; });
      if (missing.length) badges.push('<span class="roledm-badge warn">' + esc(missing.map(function (p) { return p.name; }).join('、')) + ' 已删除</span>');
      /* 「谁主动发起的」：来自 thread 上的 lastInitiatedBy（角色 id）。
         这是 autonomous 唯一的**事后**可见证据，且它是既成事实而不是推测
         —— 没有它，用户看到一次自主私聊时无法分辨那是不是自己点过。 */
      var initiator = String(t.lastInitiatedBy || '');
      if (initiator) {
        var iniName = '';
        for (var pi = 0; pi < t.participants.length; pi++) if (String(t.participants[pi].id) === initiator) iniName = t.participants[pi].name;
        if (iniName) badges.push('<span class="roledm-badge auto">' + esc(iniName) + ' 主动发起</span>');
      }
      return '<div class="roledm-item glass-card" data-thread="' + esc(t.threadId) + '">'
        + '<div class="roledm-item-top">'
        + '<span class="roledm-pair">' + avatarA + '<span class="roledm-name">' + esc(t.participants[0].name) + '</span>'
        + '<span class="roledm-arrow">↔</span>'
        + avatarB + '<span class="roledm-name">' + esc(t.participants[1].name) + '</span></span>'
        + '<span class="roledm-time">' + esc(timeLabel(t.lastMessageAt || t.createdAt)) + '</span>'
        + '</div>'
        + '<div class="roledm-preview">' + last + '</div>'
        + '<div class="roledm-item-foot"><span class="roledm-count">' + Number(t.messageCount || 0) + ' 条</span>' + badges.join('') + '</div>'
        + '</div>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.roledm-item'), function (node) {
      node.addEventListener('click', function () { openThread(node.getAttribute('data-thread')); });
    });
  }

  function galleryPlaybackLabel(scene) {
    var playback = scene && scene.playback || {};
    return (playback.voiceMode === 'text' ? '文字回放' : '角色声音')
      + ' · ' + (playback.textPacing === 'fast' ? '较快节奏' : '自然节奏');
  }
  function galleryTagsHtml(tags) {
    var list = Array.isArray(tags) ? tags : [];
    return list.length ? list.map(function (tag) { return '<span class="roledm-gallery-tag">' + esc(tag) + '</span>'; }).join('')
      : '<span class="roledm-gallery-muted">暂无标签</span>';
  }
  function galleryCardHtml(thread) {
    var scene = thread && thread.scene || {};
    var participants = Array.isArray(scene.participants) ? scene.participants : (thread && thread.participants || []);
    var names = participants.map(function (participant) {
      return esc(participant && participant.name || '角色') + (participant && participant.missing ? '（已删除）' : '');
    }).join(' ↔ ') || '角色信息不可用';
    var tags = Array.isArray(scene.tags) ? scene.tags : [];
    var threadId = String(thread && thread.threadId || '');
    var replayDisabled = Number(thread && thread.messageCount || 0) < 1 ? ' disabled' : '';
    var archived = thread && thread.state === 'archived' ? '<span class="roledm-gallery-state">已归档</span>' : '';
    return '<article class="roledm-gallery-card" data-scene-thread="' + esc(threadId) + '">'
      + '<div class="roledm-gallery-card-head"><div><span class="roledm-gallery-label">SCENE</span>'
      + '<h3>' + esc(scene.title || 'Role DM Scene') + '</h3></div>' + archived + '</div>'
      + '<div class="roledm-gallery-participants">' + names + '</div>'
      + '<div class="roledm-gallery-meta"><span>创建于 ' + esc(sceneCreatedLabel(scene.createdAt)) + '</span>'
      + '<span>' + Number(thread && thread.messageCount || 0) + ' 条消息</span></div>'
      + '<div class="roledm-gallery-tags">' + galleryTagsHtml(tags) + '</div>'
      + '<div class="roledm-gallery-playback">播放配置：' + esc(galleryPlaybackLabel(scene)) + '</div>'
      + '<details class="roledm-gallery-details"><summary>Scene 详情</summary><div class="roledm-gallery-detail-body">'
      + '<span>参与角色：' + names + '</span><span>创建时间：' + esc(sceneCreatedLabel(scene.createdAt)) + '</span>'
      + '<span>标签：' + esc(tags.join('、') || '暂无') + '</span><span>播放配置：' + esc(galleryPlaybackLabel(scene)) + '</span></div></details>'
      + '<div class="roledm-gallery-actions"><button type="button" class="btn" data-gallery-open="' + esc(threadId) + '">打开 Role DM</button>'
      + '<button type="button" class="btn" data-gallery-export="' + esc(threadId) + '">导出 Scene</button>'
      + '<button type="button" class="btn btn-primary" data-gallery-replay="' + esc(threadId) + '"' + replayDisabled + '>直接回放</button></div>'
      + '<span class="roledm-gallery-card-status" data-gallery-export-status role="status" aria-live="polite"></span>'
      + '</article>';
  }
  function setGalleryImportStatus(message, state) {
    var status = el('roledm-gallery-import-status');
    if (!status) return;
    status.textContent = String(message || '');
    status.dataset.state = String(state || '');
  }
  async function exportGalleryScene(threadId, card) {
    var api = rd(), status = card && card.querySelector('[data-gallery-export-status]');
    if (!api || typeof api.exportSceneData !== 'function') return;
    if (status) { status.textContent = '正在准备 Scene 文件…'; status.dataset.state = 'busy'; }
    try {
      var exported = api.exportSceneData(threadId);
      if (!exported || exported.ok !== true || !exported.data) throw new Error('scene-export-failed');
      if (typeof Blob !== 'function' || !window.URL || typeof window.URL.createObjectURL !== 'function') throw new Error('download-unavailable');
      var blob = new Blob([JSON.stringify(exported.data, null, 2)], { type: 'application/json;charset=utf-8' });
      var url = window.URL.createObjectURL(blob);
      var title = String((exported.data.scene && exported.data.scene.title) || 'role-dm-scene');
      var filename = title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 64) || 'role-dm-scene';
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename + '.json';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { try { window.URL.revokeObjectURL(url); } catch (e) { } }, 1000);
      if (status) { status.textContent = 'Scene 配置已导出（不含聊天消息）'; status.dataset.state = 'saved'; }
    } catch (e) {
      if (status) { status.textContent = 'Scene 导出失败'; status.dataset.state = 'failed'; }
    }
  }
  function readSceneImportFile(file) {
    return new Promise(function (resolve, reject) {
      try {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(new Error('scene-file-read-failed')); };
        reader.readAsText(file);
      } catch (e) { reject(e); }
    });
  }
  async function onGalleryImportFileChange() {
    var input = el('roledm-gallery-import-file'), file = input && input.files && input.files[0];
    var api = rd();
    if (!file || !api || typeof api.importSceneData !== 'function') return;
    if (file.size > 256 * 1024) {
      setGalleryImportStatus('Scene 文件过大；只支持轻量配置文件。', 'failed');
      input.value = '';
      return;
    }
    setGalleryImportStatus('正在校验并导入 Scene…', 'busy');
    var result = null;
    try {
      var text = await readSceneImportFile(file);
      result = await api.importSceneData(JSON.parse(text));
    } catch (e) { result = { ok: false, reason: 'bad-scene-file' }; }
    input.value = '';
    if (!result || result.ok !== true) {
      var failureText = result && result.reason === 'thread-exists'
        ? '这两个角色已有 Role DM thread；为保护现有对话与 Scene，未覆盖。'
        : result && result.reason === 'unsupported-scene-version' ? '不支持这个 Scene 文件版本。'
          : result && result.reason === 'message-data-not-allowed' ? 'Scene 文件包含聊天消息数据，已拒绝导入。'
            : result && result.reason === 'message-store-unavailable' ? '暂时无法检查现有对话；未导入文件。'
              : 'Scene 文件格式或角色引用无效，未导入。';
      setGalleryImportStatus(failureText, 'failed');
      return;
    }
    var warnings = [];
    if (result.missingRoles && result.missingRoles.length) warnings.push('缺少角色：' + result.missingRoles.join('、'));
    if (result.missingVoiceProfiles && result.missingVoiceProfiles.length) warnings.push('缺少声音配置，Replay 将使用文字');
    var search = el('roledm-gallery-search'), tagFilter = el('roledm-gallery-tag-filter');
    if (search) search.value = '';
    if (tagFilter) tagFilter.value = '';
    await renderGallery();
    setGalleryImportStatus(warnings.length
      ? 'Scene 已导入（空 thread，未导入聊天消息）。' + warnings.join('；')
      : 'Scene 已导入为新 thread（未导入聊天消息）。', warnings.length ? 'warning' : 'saved');
  }
  function updateGalleryTagFilter() {
    var select = el('roledm-gallery-tag-filter');
    if (!select) return;
    var current = String(select.value || ''), tags = [];
    _galleryScenes.forEach(function (thread) {
      (thread.scene && Array.isArray(thread.scene.tags) ? thread.scene.tags : []).forEach(function (tag) {
        if (tags.indexOf(String(tag)) < 0) tags.push(String(tag));
      });
    });
    tags.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    select.innerHTML = '<option value="">全部标签</option>' + tags.map(function (tag) {
      return '<option value="' + esc(tag) + '">' + esc(tag) + '</option>';
    }).join('');
    if (tags.indexOf(current) >= 0) select.value = current;
  }
  function renderGalleryCards() {
    var host = el('roledm-gallery-list'), count = el('roledm-gallery-count');
    if (!host) return;
    var search = el('roledm-gallery-search'), filter = el('roledm-gallery-tag-filter');
    var query = String(search && search.value || '').trim().toLocaleLowerCase();
    var selectedTag = String(filter && filter.value || '');
    var filtered = _galleryScenes.filter(function (thread) {
      var scene = thread.scene || {};
      var participants = Array.isArray(scene.participants) ? scene.participants : [];
      var searchable = [scene.title].concat(participants.map(function (participant) { return participant.name; }))
        .concat(Array.isArray(scene.tags) ? scene.tags : []).join(' ').toLocaleLowerCase();
      var tags = Array.isArray(scene.tags) ? scene.tags : [];
      return (!query || searchable.indexOf(query) >= 0) && (!selectedTag || tags.indexOf(selectedTag) >= 0);
    });
    if (count) count.textContent = '显示 ' + filtered.length + ' / ' + _galleryScenes.length + ' 个 Scene';
    if (!_galleryScenes.length) {
      host.innerHTML = '<div class="roledm-gallery-empty"><span class="roledm-gallery-label">NO SCENES</span><p>还没有可浏览的 Scene。建立 Role DM thread 后，场景会出现在这里。</p></div>';
      return;
    }
    if (!filtered.length) {
      host.innerHTML = '<div class="roledm-gallery-empty"><p>没有匹配的 Scene。</p><button type="button" class="btn" id="roledm-gallery-clear-filter">清除筛选</button></div>';
      var clear = el('roledm-gallery-clear-filter');
      if (clear) clear.addEventListener('click', function () {
        var input = el('roledm-gallery-search'), tag = el('roledm-gallery-tag-filter');
        if (input) input.value = '';
        if (tag) tag.value = '';
        renderGalleryCards();
      });
      return;
    }
    host.innerHTML = '<div class="roledm-gallery-grid">' + filtered.map(galleryCardHtml).join('') + '</div>';
    Array.prototype.forEach.call(host.querySelectorAll('[data-gallery-open]'), function (button) {
      button.addEventListener('click', function () { openGalleryScene(button.getAttribute('data-gallery-open'), false); });
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-gallery-replay]'), function (button) {
      button.addEventListener('click', function () { openGalleryScene(button.getAttribute('data-gallery-replay'), true); });
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-gallery-export]'), function (button) {
      button.addEventListener('click', function () {
        var card = button.closest ? button.closest('.roledm-gallery-card') : null;
        exportGalleryScene(button.getAttribute('data-gallery-export'), card);
      });
    });
  }
  function bindGalleryControls() {
    var open = el('roledm-gallery-open'), back = el('roledm-gallery-back');
    var search = el('roledm-gallery-search'), filter = el('roledm-gallery-tag-filter');
    var importButton = el('roledm-gallery-import'), importFile = el('roledm-gallery-import-file');
    if (open && !open._ibGalleryBound) { open._ibGalleryBound = true; open.addEventListener('click', openGallery); }
    if (back && !back._ibGalleryBound) { back._ibGalleryBound = true; back.addEventListener('click', backToList); }
    if (search && !search._ibGalleryBound) { search._ibGalleryBound = true; search.addEventListener('input', renderGalleryCards); }
    if (filter && !filter._ibGalleryBound) { filter._ibGalleryBound = true; filter.addEventListener('change', renderGalleryCards); }
    if (importButton && !importButton._ibGalleryBound) {
      importButton._ibGalleryBound = true;
      importButton.addEventListener('click', function () { if (importFile) importFile.click(); });
    }
    if (importFile && !importFile._ibGalleryBound) {
      importFile._ibGalleryBound = true;
      importFile.addEventListener('change', onGalleryImportFileChange);
    }
  }
  async function renderGallery() {
    var api = rd(), host = el('roledm-gallery-list');
    if (!api || !host || _currentSubview !== 'gallery') return;
    bindGalleryControls();
    var renderSequence = ++_galleryRenderSequence;
    host.innerHTML = '<div class="roledm-gallery-empty">正在读取 Scene…</div>';
    var threads = [];
    try { threads = await api.listThreads(); } catch (e) { threads = []; }
    if (renderSequence !== _galleryRenderSequence || _currentSubview !== 'gallery') return;
    _galleryScenes = (Array.isArray(threads) ? threads : []).filter(function (thread) { return !!(thread && thread.scene); });
    updateGalleryTagFilter();
    renderGalleryCards();
  }
  async function openGalleryScene(threadId, replay) {
    await openThread(threadId, { fromGallery: true });
    if (!replay || String(activeThreadId || '') !== String(threadId || '')) return;
    var replayButton = el('roledm-replay-start');
    if (replayButton && !replayButton.disabled) replayButton.click();
  }
  async function openGallery() {
    if (_replay) stopReplay('view-refresh');
    stopRoleDmAudioIn(el('roledm-detail-body'));
    activeThreadId = null;
    _returnToGallery = false;
    _currentSubview = 'gallery';
    showSubview('gallery');
    await renderGallery();
  }
  function showSubview(view) {
    var listView = el('roledm-view-list'), galleryView = el('roledm-view-gallery'), detailView = el('roledm-view-detail');
    if (listView) listView.style.display = view === 'list' ? '' : 'none';
    if (galleryView) galleryView.style.display = view === 'gallery' ? '' : 'none';
    if (detailView) detailView.style.display = view === 'detail' ? '' : 'none';
  }

  function avatarHtml(p) {
    var name = String((p && p.name) || 'AI');
    var ch = name.slice(0, 1) || 'A';
    var cls = p && p.missing ? ' roledm-avatar missing' : '';
    return '<span class="roledm-avatar' + cls + '" aria-hidden="true">' + esc(ch) + '</span>';
  }

  function replyQuoteHtml(message, messages, threadId) {
    var Q = window.IBMessageQuoteCore || null;
    var ref = message && message.replyQuote;
    if (!ref) return '';
    var resolved = Q && typeof Q.resolveReference === 'function'
      ? Q.resolveReference(ref, messages, message, {
        friendId: String(threadId || ''), threadId: String(threadId || ''),
        replySenderKey: Q.senderKey(message)
      })
      : { ok: false };
    if (!resolved.ok) {
      return '<div class="ib-reply-quote-card is-unavailable" aria-label="引用的原消息已不可用">'
        + '<span class="ib-reply-quote-card__sender">原消息不可用</span>'
        + '<span class="ib-reply-quote-card__text">已删除、撤回或无法通过引用校验</span></div>';
    }
    var excerpt = String(resolved.snippet || '');
    if (excerpt.length > 220) excerpt = excerpt.slice(0, 220) + '…';
    return '<button type="button" class="ib-reply-quote-card" data-quote-target="' + esc(ref.sourceMessageId) + '"'
      + ' aria-label="定位到 ' + esc(resolved.senderName || '原发送者') + ' 的原消息">'
      + '<span class="ib-reply-quote-card__sender">' + esc(resolved.senderName || '原发送者') + '</span>'
      + '<span class="ib-reply-quote-card__text">' + esc(excerpt) + '</span></button>';
  }

  /* ── 详情 ─────────────────────────────────────────────────────── */
  async function openThread(threadId, options) {
    var api = rd();
    if (!api) return;
    if (_replay && String(_replay.threadId || '') !== String(threadId || '')) stopReplay('view-refresh');
    if (String(activeThreadId || '') !== String(threadId || '')) stopRoleDmAudioIn(el('roledm-detail-body'));
    activeThreadId = String(threadId);
    _returnToGallery = !!(options && options.fromGallery === true);
    _currentSubview = 'detail';
    await refreshApiConfigs(true);
    showSubview('detail');
    await renderDetail();
  }
  function backToList() {
    if (_replay) stopReplay('view-refresh');
    stopRoleDmAudioIn(el('roledm-detail-body'));
    activeThreadId = null;
    if (_returnToGallery) {
      _returnToGallery = false;
      _currentSubview = 'gallery';
      showSubview('gallery');
      renderGallery();
      return;
    }
    _currentSubview = 'list';
    showSubview('list');
    renderList();
  }

  async function renderDetail() {
    var api = rd();
    if (!api || !activeThreadId) return;
    if (_replay) stopReplay('view-refresh');
    var renderSequence = ++_detailRenderSequence;
    await refreshApiConfigs(false);
    var d = await api.threadDetail(activeThreadId);
    if (renderSequence !== _detailRenderSequence) return;
    var headEl = el('roledm-detail-head'), bodyEl = el('roledm-detail-body'), ctlEl = el('roledm-detail-controls'), noteEl = el('roledm-detail-note');
    if (!d) {
      if (headEl) headEl.innerHTML = '<div class="roledm-muted">这段私聊已经不存在了。</div>';
      if (bodyEl) bodyEl.innerHTML = '';
      if (ctlEl) ctlEl.innerHTML = '';
      return;
    }
    var a = d.participants[0], b = d.participants[1];
    if (headEl) {
      headEl.innerHTML = avatarHtml(a) + '<span class="roledm-name">' + esc(a.name) + '</span>'
        + '<button type="button" class="btn ib-expression-manage" data-expression-role-id="' + esc(a.id) + '">表情包</button>'
        + '<span class="roledm-arrow">↔</span>' + avatarHtml(b) + '<span class="roledm-name">' + esc(b.name) + '</span>'
        + '<button type="button" class="btn ib-expression-manage" data-expression-role-id="' + esc(b.id) + '">表情包</button>';
      if (window.IBExpressionPacks && typeof window.IBExpressionPacks.applyRoleState === 'function') {
        window.IBExpressionPacks.applyRoleState(a.id, 'greetingExpression', headEl);
        window.IBExpressionPacks.applyRoleState(b.id, 'greetingExpression', headEl);
      }
    }
    if (bodyEl) {
      stopRoleDmAudioIn(bodyEl);
      if (!d.messages.length) {
        bodyEl.innerHTML = '<div class="roledm-empty">还没有消息。点下面的「让她们聊一会儿」开始。</div>';
      } else {
        bodyEl.innerHTML = d.messages.map(function (m) {
          var side = (m.senderId === a.id) ? 'left' : 'right';
          return '<div class="roledm-msg ' + side + '" data-message-id="' + esc(m.id) + '">'
            + '<div class="roledm-msg-meta">' + esc(m.senderName) + '<span class="roledm-msg-time">' + esc(timeLabel(m.timestamp)) + '</span></div>'
            + '<div class="roledm-bubble">' + replyQuoteHtml(m, d.messages, d.thread.threadId) + esc(m.content) + '</div>'
            + '<div class="roledm-msg-model">' + esc([m.provider, m.model].filter(Boolean).join(' · ')) + '</div>'
            + '</div>';
        }).join('');
        Array.prototype.forEach.call(bodyEl.querySelectorAll('.ib-reply-quote-card[data-quote-target]'), function (button) {
          button.addEventListener('click', function () {
            var targetId = String(button.getAttribute('data-quote-target') || '');
            var rows = bodyEl.querySelectorAll('.roledm-msg[data-message-id]'), target = null;
            for (var ti = 0; ti < rows.length; ti++) if (String(rows[ti].getAttribute('data-message-id') || '') === targetId) { target = rows[ti]; break; }
            if (!target) { button.disabled = true; button.classList.add('is-unavailable'); return; }
            try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { target.scrollIntoView(); }
            target.classList.add('ib-reply-quote-target');
            setTimeout(function () { try { target.classList.remove('ib-reply-quote-target'); } catch (e) {} }, 1800);
          });
        });
        var messageById = Object.create(null);
        d.messages.forEach(function (message) { messageById[String(message.id || '')] = message; });
        Array.prototype.forEach.call(bodyEl.querySelectorAll('.roledm-msg[data-message-id]'), function (row) {
          var message = messageById[String(row.getAttribute('data-message-id') || '')];
          var bubble = row.querySelector('.roledm-bubble');
          if (message && bubble && window.IBExpressionPacks && typeof window.IBExpressionPacks.decorateMessage === 'function') {
            window.IBExpressionPacks.decorateMessage(message.senderId, message.id, bubble, { text: message.content });
          }
          var voice = message && voiceProfileForRole(message.senderId);
          var meta = voice && row.querySelector('.roledm-msg-meta');
          if (meta) {
            var button = document.createElement('button');
            button.type = 'button'; button.className = 'btn roledm-voice-btn';
            button.textContent = '播放语音'; button.setAttribute('aria-label', '播放' + String(message.senderName || '角色') + '的语音');
            var status = document.createElement('span');
            status.className = 'roledm-voice-state'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            button.addEventListener('click', function () { playRoleDmVoice(row, message, voice, button); });
            meta.appendChild(button); meta.appendChild(status);
          }
        });
        bodyEl.scrollTop = bodyEl.scrollHeight;
      }
    }
    if (noteEl) {
      var notes = [];
      /* provider 不可用时**明确展示** degraded / error，而不是静默什么都不说。 */
      var bad = d.participants.filter(function (p) { return p.missing || !p.ready; });
      if (bad.length) {
        notes.push('<div class="roledm-note warn">' + esc(bad.map(function (p) { return p.name + (p.missing ? '（角色已删除）' : '（模型配置不完整）'); }).join('、'))
          + '：本轮无法开始。请到 API 页面处理后再来。</div>');
      }
      if (d.state === 'archived') notes.push('<div class="roledm-note">这段私聊已归档：历史保留，但不能继续聊。</div>');
      if (d.stopReason && RUN_STOP_TEXT[d.stopReason]) notes.push('<div class="roledm-note">' + esc(RUN_STOP_TEXT[d.stopReason]) + '</div>');
      noteEl.innerHTML = notes.join('');
      var warning = noteEl.querySelector('.roledm-note.warn');
      if (warning && window.IBExpressionPacks && typeof window.IBExpressionPacks.applyRoleState === 'function') {
        bad.forEach(function (participant) { window.IBExpressionPacks.applyRoleState(participant.id, 'errorExpression', warning); });
      }
    }
    if (ctlEl) {
      var runDisabled = (!a.ready || !b.ready || d.state === 'archived' || d.running);
      var disabled = runDisabled ? ' disabled' : '';
      ctlEl.innerHTML = scenePanelHtml(d.scene) + '<div class="roledm-replay-controls" aria-label="当前对话回放">'
        + '<span class="roledm-replay-label">SCENE REPLAY</span>'
        + '<button type="button" class="btn" id="roledm-replay-start" data-has-messages="' + (d.messages.some(function (message) { return !!String(message && message.content || '').trim(); }) ? 'true' : 'false') + '">回放对话</button>'
        + '<button type="button" class="btn" id="roledm-replay-pause" disabled>暂停</button>'
        + '<button type="button" class="btn" id="roledm-replay-resume" disabled>继续</button>'
        + '<button type="button" class="btn" id="roledm-replay-stop" disabled>停止回放</button>'
        + '<span class="roledm-replay-status" id="roledm-replay-status" role="status" aria-live="polite">' + esc(_replayStatusText) + '</span>'
        + '</div>'
        + '<button type="button" class="btn btn-primary" id="roledm-start-btn" data-base-disabled="' + (runDisabled ? 'true' : 'false') + '"' + disabled + '>让她们聊一会儿</button>'
        + '<button type="button" class="btn" id="roledm-stop-btn"' + (d.running ? '' : ' disabled') + '>停止</button>'
        + '<input class="btn roledm-topic" id="roledm-topic" type="text" maxlength="120" placeholder="给话题（可选，仅这一次）" autocomplete="off">'
        + '<span class="roledm-ctl-right">'
        + '<button type="button" class="btn" id="roledm-clear-btn">清空聊天记录</button>'
        + '<button type="button" class="btn" id="roledm-del-btn">删除这段私聊</button>'
        + '</span>';
      bindDetailControls();
      syncReplayControls();
    }
  }

  function bindDetailControls() {
    var sceneSave = el('roledm-scene-save');
    if (sceneSave) sceneSave.addEventListener('click', onSaveScene);
    var replayStart = el('roledm-replay-start');
    if (replayStart) replayStart.addEventListener('click', function () { startReplay(); });
    var replayPause = el('roledm-replay-pause');
    if (replayPause) replayPause.addEventListener('click', pauseReplay);
    var replayResume = el('roledm-replay-resume');
    if (replayResume) replayResume.addEventListener('click', resumeReplay);
    var replayStop = el('roledm-replay-stop');
    if (replayStop) replayStop.addEventListener('click', function () { stopReplay('user'); });
    var startBtn = el('roledm-start-btn');
    if (startBtn) startBtn.addEventListener('click', onStart);
    var stopBtn = el('roledm-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', onStop);
    var clearBtn = el('roledm-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', onClear);
    var delBtn = el('roledm-del-btn');
    if (delBtn) delBtn.addEventListener('click', onDelete);
  }

  /* ── 交互 ─────────────────────────────────────────────────────── */
  async function onStart() {
    var api = rd();
    if (!api || !activeThreadId || _busy) return;
    _busy = true;
    var startBtn = el('roledm-start-btn');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = '正在聊…'; }
    var noteEl = el('roledm-detail-note');
    if (noteEl) noteEl.innerHTML = '<div class="roledm-note">正在让她们聊一会儿…</div>';
    var topicEl = el('roledm-topic');
    var topic = topicEl ? String(topicEl.value || '').trim() : '';
    var d = await api.threadDetail(activeThreadId);
    _currentAbort = (typeof AbortController === 'function') ? new AbortController() : null;
    var res = null;
    try {
      res = await api.start(d.participants[0].id, d.participants[1].id, {
        topic: topic,
        turns: 4,
        signal: _currentAbort ? _currentAbort.signal : null
      });
    } catch (e) {
      res = { ok: false, reason: 'run-error' };
    } finally {
      _busy = false;
      _currentAbort = null;
    }
    if (topicEl) topicEl.value = '';
    /* 如实回报停止原因；绝不假装聊过（res.turns === 0 时明说没有产生消息）。 */
    if (!res || !res.ok) {
      var why = (res && (RUN_STOP_TEXT[res.reason] || RUN_STOP_TEXT[res.stopReason])) || '本轮没有产生新的消息。';
      if (noteEl) noteEl.innerHTML = '<div class="roledm-note warn">' + esc(why) + '</div>';
    }
    await renderDetail();
    await renderList();
    /* Dev-only, run-local calibration evidence. Keep it to enums and aggregate shape
       counts; never surface message text, prompts, Memory content, or credentials. */
    if (isDevCalibrationContext() && res) {
      var stats = res.calibration || {};
      var promptStats = stats.prompts || {};
      var intents = stats.intents || {};
      var byIntent = intents.byIntent || {};
      var fallbackReasons = intents.fallbackReasons || {};
      var messageStats = stats.messages || {};
      var deliveryStats = stats.delivery || {};
      var deliveryFallbackReasons = deliveryStats.formatFallbackReasons || {};
      var quoteStats = stats.quotes || {};
      var quoteRejectReasons = quoteStats.rejectedByReason || {};
      var parseRate = intents.total ? Math.round((Number(intents.parsed) / Number(intents.total)) * 100) + '%' : 'n/a';
      var repeatRate = Number(messageStats.transitions) > 0
        ? Math.round((Number(messageStats.sameSpeakerRate) || 0) * 100) + '%'
        : 'n/a';
      var fallbackSummary = Object.keys(fallbackReasons).map(function (reason) {
        return esc(reason) + ' ' + Number(fallbackReasons[reason] || 0);
      }).join(', ') || '无';
      var deliveryFallbackSummary = Object.keys(deliveryFallbackReasons).map(function (reason) {
        return esc(reason) + ' ' + Number(deliveryFallbackReasons[reason] || 0);
      }).join(', ') || '无';
      var quoteRejectSummary = Object.keys(quoteRejectReasons).map(function (reason) {
        return esc(reason) + ' ' + Number(quoteRejectReasons[reason] || 0);
      }).join(', ') || '无';
      var quoteNotRun = Math.max(0, Number(quoteStats.candidateSets || 0) - Number(quoteStats.parseTotal || 0));
      noteEl = el('roledm-detail-note');
      if (noteEl) noteEl.innerHTML += '<div class="roledm-note">Dev 校准（仅统计）' + (res.calibration ? '' : '：本次回合没有返回校准对象。')
        + '意图解析 ' + Number(intents.parsed || 0) + '/' + Number(intents.total || 0)
        + '（' + parseRate + '，回退 ' + Number(intents.fallback || 0) + '；speak ' + Number(byIntent.speak || 0)
        + ' / continue_self ' + Number(byIntent.continue_self || 0) + ' / yield ' + Number(byIntent.yield || 0) + ' / end ' + Number(byIntent.end || 0)
        + '；回退原因 ' + fallbackSummary + '）；提示词覆盖 brevity ' + Number(promptStats.roleDmBrevity || 0) + '/' + Number(promptStats.total || 0)
        + '、short-format ' + Number(promptStats.ordinaryShortFormat || 0) + '/' + Number(promptStats.total || 0)
        + '、system-intent ' + Number(promptStats.intentContract || 0) + '/' + Number(promptStats.total || 0)
        + '、final-frame ' + Number(promptStats.finalUserIntentContract || 0) + '/' + Number(promptStats.total || 0)
        + '、multi-message ' + Number(promptStats.messageProtocol || 0) + '/' + Number(promptStats.total || 0)
        + '；新消息 ' + Number(messageStats.count || 0) + ' 条，平均 ' + (Number(messageStats.avgChars || 0)).toFixed(1)
        + ' 字、' + (Number(messageStats.avgParagraphs || 0)).toFixed(2) + ' 段，多段 ' + Number(messageStats.multiParagraph || 0)
        + ' 条；同次生成多消息 ' + Number(deliveryStats.multiMessageTurns || 0) + '/' + Number(deliveryStats.generatedTurns || 0)
        + ' 次，生成 ' + Number(deliveryStats.messagesGenerated || 0) + ' 条、交付 ' + Number(deliveryStats.messagesDelivered || 0)
        + ' 条；格式回退 ' + Number(deliveryStats.formatFallbacks || 0) + '（' + deliveryFallbackSummary + '）'
        + '，重复/低信息过滤 ' + Number(deliveryStats.duplicateFiltered || 0) + '/' + Number(deliveryStats.lowInfoFiltered || 0)
        + '，Stop 截断序列 ' + Number(deliveryStats.stoppedSequences || 0)
        + ' 条；连续发言率 ' + repeatRate + '；停止 ' + esc(stats.stopReason || 'unknown') + '。</div>';
      if (noteEl) noteEl.innerHTML += '<div class="roledm-note">引用诊断（仅统计）：候选 ' + Number(quoteStats.candidateCount || 0)
        + ' 条/' + Number(quoteStats.candidateSets || 0) + ' 轮（单轮最多 ' + Number(quoteStats.maxCandidatesPerTurn || 0)
        + ' 个来源、' + Number(quoteStats.quoteOptionCount || 0) + ' 个可选键（单轮最多 ' + Number(quoteStats.maxQuoteOptionsPerTurn || 0) + '）'
        + '）；提示到达 ' + Number(promptStats.quoteGuidance || 0) + '/' + Number(promptStats.total || 0)
        + '；解析 有效 ' + Number(quoteStats.accepted || 0) + ' / 未选择 ' + Number(quoteStats.noDirective || 0)
        + ' / 拒绝 ' + Number(quoteStats.rejected || 0) + ' / 未运行 ' + quoteNotRun
        + ' / 核心不可用 ' + Number(quoteStats.coreUnavailable || 0)
        + '；拒绝原因 ' + quoteRejectSummary + '；成功应用 ' + Number(quoteStats.applied || 0) + '。</div>';
    }
  }

  function onStop() {
    if (_currentAbort) { try { _currentAbort.abort(); } catch (e) { } }
    var api = rd();
    if (api && activeThreadId && !api.isRunning(activeThreadId)) {
      /* 没有正在跑的 run：如实说明，而不是让按钮看起来"点了但没反应"。 */
      var noteEl = el('roledm-detail-note');
      if (noteEl) noteEl.innerHTML = '<div class="roledm-note">这会儿没有正在进行的对话。</div>';
    }
  }

  async function onClear() {
    var api = rd();
    if (!api || !activeThreadId) return;
    if (!confirm('清空这段私聊的聊天记录？\n\n两个角色之间的这段对话、当前话题状态，以及由这段对话形成的「共同经历备忘」都会被删除。但「他们对彼此的看法」以及已经沉淀到长期记忆里的事不会被一起删掉 —— 本版本不做也无法做记忆级联删除。')) return;
    await api.clearThread(activeThreadId);
    await renderDetail();
    renderList();
  }

  async function onDelete() {
    var api = rd();
    if (!api || !activeThreadId) return;
    if (!confirm('删除整段私聊？\n\n聊天记录、当前话题状态、由这段对话形成的「共同经历备忘」，以及这段私聊本身都会被删除；两个角色对彼此的关系状态会保留（关系不是聊天记录的附属品）。已经沉淀到长期记忆里的事同样不会被删除。')) return;
    await api.deleteThread(activeThreadId);
    backToList();
  }

  /* ── 新建 ─────────────────────────────────────────────────────── */
  function openCreate() {
    var ov = el('roledm-create-overlay');
    if (!ov) return;
    var api = rd();
    var chars = api ? api.listCharacters() : [];
    var selA = el('roledm-create-a'), selB = el('roledm-create-b');
    var opts = chars.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.ready ? '' : '（模型配置不完整）') + '</option>';
    }).join('');
    if (selA) selA.innerHTML = '<option value="">选择角色…</option>' + opts;
    if (selB) selB.innerHTML = '<option value="">选择角色…</option>' + opts;
    var msg = el('roledm-create-msg');
    if (msg) msg.textContent = chars.length < 2 ? '至少需要两个角色才能建立角色私信。' : '';
    ov.classList.add('show');
  }
  function closeCreate() {
    var ov = el('roledm-create-overlay');
    if (ov) ov.classList.remove('show');
  }
  async function confirmCreate() {
    var api = rd();
    if (!api) return;
    var a = el('roledm-create-a'), b = el('roledm-create-b'), msg = el('roledm-create-msg');
    var aid = a ? String(a.value || '') : '', bid = b ? String(b.value || '') : '';
    if (!aid || !bid) { if (msg) msg.textContent = '请选择两个角色。'; return; }
    if (aid === bid) { if (msg) msg.textContent = '两个角色不能是同一个人。'; return; }
    var res = await api.resolveThread(aid, bid);
    if (!res || !res.ok) { if (msg) msg.textContent = '无法建立这段私聊（' + esc((res && res.reason) || 'unknown') + '）。'; return; }
    closeCreate();
    /* 已存在则直接打开（不重复创建）。 */
    await openThread(res.thread.threadId);
    renderList();
  }

  /* ── 自主发起设置（Phase 3）───────────────────────────────────────
     设计原则：**默认全关**，而且"关"必须是一眼可见的（summary 上带状态字），
     不允许出现"看起来开着其实没开"的模糊状态。

     两个开关是**AND**关系，UI 必须如实呈现这一点 —— 只开总开关时，
     角色行仍然是关闭态，行尾状态字会说"未开启"，而不是假装它在工作。 */
  function initiativeLabel(v) {
    var n = Number(v) || 0;
    if (n < 0.2) return '很安静';
    if (n < 0.45) return '偏安静';
    if (n < 0.7) return '一般';
    if (n < 0.9) return '偏活跃';
    return '很活跃';
  }
  function renderAuto() {
    var host = el('roledm-auto-body');
    var stateEl = el('roledm-auto-state');
    if (!host) return;
    var api = rd(), s = soc();
    if (!api) { host.innerHTML = '<div class="roledm-note">角色私信模块未就绪。</div>'; return; }
    if (!s) {
      /* 能力缺席时如实说明，不隐藏这一块（隐藏会让用户以为功能被移除，
         而实际是脚本没加载）。 */
      host.innerHTML = '<div class="roledm-note warn">自主调度模块未加载，主动角色私信当前不可用。手动「让她们聊一会儿」不受影响。</div>';
      if (stateEl) stateEl.textContent = '不可用';
      return;
    }
    var g = s.prefs().global;
    var on = g.enabled === true;
    if (stateEl) stateEl.textContent = on ? '总开关已打开' : '未开启';
    var chars = api.listCharacters();
    var rows = chars.map(function (ch) {
      var p = s.characterPrefs(ch.id);
      var ready = ch.ready !== false;
      return '<div class="roledm-auto-row" data-char="' + esc(ch.id) + '">'
        + '<label class="roledm-auto-name"><input type="checkbox" data-role="enabled"' + (p.enabled ? ' checked' : '') + (ready ? '' : ' disabled') + '> '
        + esc(ch.name) + (ready ? '' : '<span class="roledm-muted">（模型配置不完整）</span>') + '</label>'
        + '<div class="roledm-auto-ctl">'
        + '<span class="roledm-auto-lab">主动程度</span>'
        + '<input type="range" min="0" max="1" step="0.05" value="' + esc(String(p.initiative)) + '" data-role="initiative">'
        + '<span class="roledm-auto-val" data-role="initiative-label">' + esc(initiativeLabel(p.initiative)) + '</span>'
        + '</div>'
        + '<div class="roledm-auto-ctl">'
        + '<span class="roledm-auto-lab">每日上限</span>'
        + '<input type="number" min="1" max="20" step="1" value="' + esc(String(p.dailyLimit)) + '" data-role="dailyLimit">'
        + '<label class="roledm-auto-sub"><input type="checkbox" data-role="allowStrangers"' + (p.allowStrangers ? ' checked' : '') + '> 允许主动联系还不熟悉的角色</label>'
        + '</div>'
        + '</div>';
    }).join('');
    host.innerHTML = '<div class="roledm-auto-master">'
      + '<label><input type="checkbox" id="roledm-auto-global"' + (on ? ' checked' : '') + '> 允许角色主动联系其他角色（总开关）</label>'
      + '<div class="roledm-muted">关掉后立刻不再产生新的主动私聊；正在进行的会自然聊完。默认关闭。</div>'
      + '</div>'
      + (rows || '<div class="roledm-note">还没有可用的角色。</div>')
      + '<div class="roledm-note">主动私聊是低频的：大多数时候角色不会联系任何人。它只会在有明确社会理由（聊过、久未联系、关系够近）时才发生，并且受每日上限与冷却限制。'
      + '角色自己找谁聊天**不会**改变她们对彼此的关系 —— 只有真正聊过之后才会。</div>';
    bindAutoControls();
  }
  function bindAutoControls() {
    var s = soc();
    if (!s) return;
    var gEl = el('roledm-auto-global');
    if (gEl) {
      gEl.addEventListener('change', function () {
        s.setGlobalEnabled(!!gEl.checked);
        renderAuto();
      });
    }
    var host = el('roledm-auto-body');
    if (!host) return;
    var rows = host.querySelectorAll('.roledm-auto-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var cid = String(row.getAttribute('data-char') || '');
        if (!cid) return;
        var pairs = [
          ['enabled', 'change'],
          ['initiative', 'input'],
          ['dailyLimit', 'change'],
          ['allowStrangers', 'change']
        ];
        for (var k = 0; k < pairs.length; k++) {
          var input = row.querySelector('[data-role="' + pairs[k][0] + '"]');
          if (!input) continue;
          (function (inp, role, evName) {
            inp.addEventListener(evName, function () {
              var patch = {};
              if (role === 'enabled') patch.enabled = !!inp.checked;
              else if (role === 'allowStrangers') patch.allowStrangers = !!inp.checked;
              else if (role === 'initiative') patch.initiative = Number(inp.value);
              else if (role === 'dailyLimit') patch.dailyLimit = parseInt(inp.value, 10);
              var next = s.setCharacterPrefs(cid, patch);
              /* 滑块的**值文字**必须跟着动，但不重绘整块 ——
                 重绘会在拖动过程中把 range 的焦点丢掉。 */
              if (role === 'initiative') {
                var lab = row.querySelector('[data-role="initiative-label"]');
                if (lab) lab.textContent = initiativeLabel(next.initiative);
              } else {
                renderAuto();
              }
            });
          })(input, pairs[k][0], pairs[k][1]);
        }
      })(rows[i]);
    }
  }

  /* ── 回复内主动表达（只配置手动 Role DM 回复；与自主调度分离）── */
  function renderReplyInitiative() {
    var host = el('roledm-reply-initiative-body');
    var stateEl = el('roledm-reply-initiative-state');
    var api = rd();
    if (!host) return;
    if (!api || typeof api.replyInitiativePrefs !== 'function') {
      host.innerHTML = '<div class="roledm-note warn">回复主动表达设置暂不可用。</div>';
      if (stateEl) stateEl.textContent = '不可用';
      return;
    }
    var chars = api.listCharacters();
    var enabledCount = 0;
    var rows = chars.map(function (ch) {
      var p = api.replyInitiativePrefs(ch.id);
      if (p.enabled) enabledCount++;
      var types = p.types || {};
      return '<div class="roledm-auto-row roledm-reply-initiative-row" data-char="' + esc(ch.id) + '">'
        + '<label class="roledm-auto-name"><input type="checkbox" data-role="enabled"' + (p.enabled ? ' checked' : '') + '> '
        + esc(ch.name) + ' 可以在回复中主动补充</label>'
        + '<div class="roledm-auto-ctl">'
        + '<label class="roledm-auto-sub"><input type="checkbox" data-role="supplement"' + (types.supplement ? ' checked' : '') + '> 补充想法或轻微反问</label>'
        + '<label class="roledm-auto-sub"><input type="checkbox" data-role="contextLink"' + (types.contextLink ? ' checked' : '') + '> 关联当前私聊上下文</label>'
        + '<label class="roledm-auto-sub"><input type="checkbox" data-role="careNudge"' + (types.careNudge ? ' checked' : '') + '> 轻量关心或提醒</label>'
        + '</div>'
        + '<div class="roledm-auto-ctl"><label class="roledm-auto-lab" for="roledm-reply-frequency-' + esc(ch.id) + '">机会频率</label>'
        + '<select id="roledm-reply-frequency-' + esc(ch.id) + '" data-role="frequency">'
        + '<option value="low"' + (p.frequency === 'low' ? ' selected' : '') + '>低频 · 约 1/4 次会话</option>'
        + '<option value="occasional"' + (p.frequency === 'occasional' ? ' selected' : '') + '>偶尔 · 约 1/2 次会话</option>'
        + '</select></div>'
        + '</div>';
    }).join('');
    host.innerHTML = (rows || '<div class="roledm-note">还没有可配置的角色。</div>')
      + '<div class="roledm-note">仅在用户手动开始的 Role DM 回复中生效，不新建消息或定时任务；每个角色每次会话最多获得一次机会。只有当前私聊上下文明确支持时才会补充，下方的后台主动私聊调度保持独立。</div>';
    if (stateEl) stateEl.textContent = enabledCount ? enabledCount + ' 个角色已启用' : '默认关闭';
    bindReplyInitiativeControls();
  }
  function bindReplyInitiativeControls() {
    var api = rd();
    var host = el('roledm-reply-initiative-body');
    if (!api || typeof api.setReplyInitiativePrefs !== 'function' || !host) return;
    var rows = host.querySelectorAll('.roledm-reply-initiative-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var roleId = String(row.getAttribute('data-char') || '');
        var controls = row.querySelectorAll('[data-role]');
        for (var j = 0; j < controls.length; j++) {
          (function (input) {
            input.addEventListener('change', function () {
              var field = String(input.getAttribute('data-role') || '');
              var patch = {};
              if (field === 'enabled') patch.enabled = !!input.checked;
              else if (field === 'frequency') patch.frequency = String(input.value || 'low');
              else if (field === 'supplement' || field === 'contextLink' || field === 'careNudge') {
                patch.types = {};
                patch.types[field] = !!input.checked;
              } else return;
              api.setReplyInitiativePrefs(roleId, patch);
              var count = api.listCharacters().filter(function (ch) { return api.replyInitiativePrefs(ch.id).enabled; }).length;
              var stateEl = el('roledm-reply-initiative-state');
              if (stateEl) stateEl.textContent = count ? count + ' 个角色已启用' : '默认关闭';
            });
          })(controls[j]);
        }
      })(rows[i]);
    }
  }

  /* ── 样式表（运行时注入，不占用 HTML 的样式表预算）──
     与 assets/js/diagnostics.js:175-183 同一做法：功能模块自己的 CSS 由模块注入，
     HTML 只保留既有那批 <link>（见 tests/test_setup_wizard.js 的
     「HTML 没有新增样式表」与 test_frontend_structure.js 的
     split.externalStyleCount —— 两处都锁着这个预算）。 */
  var STYLE_ID = 'ib-role-dm-style';
  var STYLE_HREF = 'assets/css/core/role-dm.css';
  function injectStyles() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var link = document.createElement('link');
      link.id = STYLE_ID;
      link.rel = 'stylesheet';
      link.href = STYLE_HREF;
      document.head.appendChild(link);
    } catch (e) { }
  }

  /* ── 挂载 ─────────────────────────────────────────────────────── */
  async function render() {
    var api = rd();
    if (!api) return;
    injectStyles();
    bindGalleryControls();
    await renderList();
    renderAuto();
    renderReplyInitiative();
    if (_currentSubview === 'gallery' && !activeThreadId) {
      showSubview('gallery');
      await renderGallery();
    } else if (activeThreadId) {
      _currentSubview = 'detail';
      showSubview('detail');
      await renderDetail();
    } else {
      _currentSubview = 'list';
      showSubview('list');
    }
  }
  /* 轻量事件：runtime 在 run 的每个回合与结束时各发一次，本层只重绘。
     （scheduler 因此**不需要**碰 DOM：它触发 run，本层通过事件自然刷新。） */
  NS.roleDmEmit = function (kind, payload) {
    try {
      if (kind === 'turn' && activeThreadId && payload && payload.threadId === activeThreadId) {
        renderDetail();
      } else if (kind === 'delivery' && activeThreadId && payload && payload.threadId === activeThreadId) {
        var noteEl = el('roledm-detail-note');
        if (noteEl) {
          noteEl.innerHTML = '<div class="roledm-note">'
          + (payload.typing ? (esc(payload.speakerName || '角色') + ' 正在输入…') : '正在让她们聊一会儿…')
          + '</div>';
          if (payload.typing && payload.speakerId && window.IBExpressionPacks && typeof window.IBExpressionPacks.applyRoleState === 'function') {
            window.IBExpressionPacks.applyRoleState(payload.speakerId, 'typingExpression', noteEl.querySelector('.roledm-note'));
          }
        }
      } else if (kind === 'run') {
        /* A manual run's owner (onStart) performs the final detail render and
           appends Dev calibration afterward. Avoid a delayed config refresh in
           this event from clearing that summary; autonomous runs still get a full
           render because they have no onStart owner. */
        if (_busy) { renderList(); renderAuto(); }
        else render();
      }
    } catch (e) { }
  };
  NS.roleDmUI = {
    render: render,
    renderList: renderList,
    renderDetail: renderDetail,
    renderAuto: renderAuto,
    openThread: openThread,
    backToList: backToList,
    openCreate: openCreate,
    closeCreate: closeCreate,
    confirmCreate: confirmCreate,
    renderReplyInitiative: renderReplyInitiative,
    openGallery: openGallery,
    renderGallery: renderGallery,
    openGalleryScene: openGalleryScene,
    startReplay: startReplay,
    pauseReplay: pauseReplay,
    resumeReplay: resumeReplay,
    stopReplay: function () { return stopReplay('user'); },
    stopVoicePlayback: function () {
      if (_replay) stopReplay('view-refresh');
      stopRoleDmAudioIn(el('roledm-detail-body'));
      return true;
    },
    setActiveThread: function (id) {
      var next = id ? String(id) : null;
      if (_replay && next !== String(_replay.threadId || '')) stopReplay('view-refresh');
      if (next !== String(activeThreadId || '')) stopRoleDmAudioIn(el('roledm-detail-body'));
      activeThreadId = next;
    },
    activeThreadId: function () { return activeThreadId; },
    runStopText: function (reason) { return RUN_STOP_TEXT[reason] || ''; }
  };
  NS.expose('roleDmUI', NS.roleDmUI);
  /* HTML 内联 onclick 用（与既有页面同款约定）。 */
  window.IBRoleDmUI = NS.roleDmUI;
  window.roleDmBack = backToList;
  window.roleDmOpenCreate = openCreate;
  window.roleDmCloseCreate = closeCreate;
  window.roleDmConfirmCreate = confirmCreate;
})(window.IB || (window.IB = {}));
