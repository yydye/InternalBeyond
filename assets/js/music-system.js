/* Music desktop experience: one Audio element, one IndexedDB library and the
   existing Chat / Credential APIs. The audio files stay local to this device. */
(function (root) {
  'use strict';

  if (!root || !root.document) return;
  const STORE = 'music';
  const STATE_KEY = 'ib_music_player_state_v1';
  const LYRIC_ACCEPT = '.lrc,.srt,.vtt,text/plain,text/vtt,application/x-subrip';
  const SVG_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 5.7v12.6L18.8 12z"/></svg>';
  const SVG_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.2" height="14" rx="1"/><rect x="13.8" y="5" width="3.2" height="14" rx="1"/></svg>';
  const MODE_LABELS = { list: '列表循环', single: '单曲循环', random: '随机播放' };
  let libraryReady = null;
  let activeUrl = '';
  let activeUrlTrackId = '';
  let restorePosition = null;
  let state = loadState();
  let chatRoles = [];
  let shouldOfferResume = !!state.wasPlaying;
  let pendingShare = null;
  let lastStateWrite = 0;
  let pairedTick = 0;
  let lastLyricIndex = -1;

  function audio() { return root.audioEl || null; }
  function queue() { return Array.isArray(root.playlist) ? root.playlist : []; }
  function currentIndex() { return Number.isInteger(root.currentTrackIdx) ? root.currentTrackIdx : -1; }
  function currentTrack() { return queue()[currentIndex()] || null; }
  function setQueue(items) { root.playlist = items; }
  function setIndex(value) { root.currentTrackIdx = value; }
  function setMode(value) { root.playMode = value; state.mode = value; }
  function getConversation() {
    try {
      const api = root.IB && root.IB.chat;
      if (api && typeof api.getActiveConversation === 'function') return api.getActiveConversation() || {};
    } catch (_) { }
    return { friendId: '', threadId: '' };
  }
  function trackId(track) { return String(track && track.id || ''); }
  function trackName(track) {
    return String(track && (track.title || track.name) || '未命名音频').replace(/\.[a-z0-9]{1,5}$/i, '');
  }
  function trackDetail(track) {
    return String(track && [track.artist, track.album].filter(Boolean).join(' · ') || '本地音频');
  }
  function freshId() {
    try { if (root.crypto && typeof root.crypto.randomUUID === 'function') return 'msong_' + root.crypto.randomUUID(); } catch (_) { }
    return 'msong_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }
  function loadState() {
    const initial = { mode: 'list', volume: 0.8, currentId: '', position: 0, wasPlaying: false, mateId: '', controlRoleId: '', mateTime: {} };
    try {
      const parsed = JSON.parse(root.localStorage.getItem(STATE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return initial;
      return {
        mode: ['list', 'single', 'random'].includes(parsed.mode) ? parsed.mode : initial.mode,
        volume: Number.isFinite(Number(parsed.volume)) ? Math.max(0, Math.min(1, Number(parsed.volume))) : initial.volume,
        currentId: String(parsed.currentId || ''), position: Math.max(0, Number(parsed.position) || 0),
        wasPlaying: !!parsed.wasPlaying, mateId: String(parsed.mateId || ''), controlRoleId: String(parsed.controlRoleId || ''),
        mateTime: parsed.mateTime && typeof parsed.mateTime === 'object' ? parsed.mateTime : {}
      };
    } catch (_) { return initial; }
  }
  function saveState(force) {
    const a = audio(), now = Date.now();
    if (!force && now - lastStateWrite < 3500) return;
    lastStateWrite = now;
    const track = currentTrack();
    if (a) {
      state.position = track ? Math.max(0, Number(a.currentTime) || state.position || 0) : 0;
      state.wasPlaying = !!track && !a.paused;
      state.volume = Math.max(0, Math.min(1, Number(a.volume)));
    }
    state.currentId = trackId(track) || state.currentId || '';
    try { root.localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_) { }
  }
  function durationLabel(value) {
    if (!Number.isFinite(value) || value < 0) return '--:--';
    const seconds = Math.round(value);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }
  function safeRecords(items) {
    return (Array.isArray(items) ? items : []).filter(function (record) {
      return record && record.id !== STATE_KEY && ((typeof Blob !== 'undefined' && record.blob instanceof Blob) || typeof record.data === 'string');
    }).sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
  }
  async function loadLibrary() {
    try { setQueue(safeRecords(await root.dbGetAll(STORE))); }
    catch (error) { setQueue([]); console.warn('[Music] local library unavailable', error); }
    if (currentIndex() >= queue().length) setIndex(queue().length ? queue().length - 1 : -1);
    renderPlaylist();
    renderCurrent();
    return queue();
  }
  async function ensureLibrary() {
    if (!libraryReady) libraryReady = loadLibrary().catch(function (error) { libraryReady = null; throw error; });
    return libraryReady;
  }
  function sourceFor(record) {
    if (!record) return '';
    const a = audio();
    if (record.blob instanceof Blob) {
      if (activeUrl && activeUrlTrackId === trackId(record)) return activeUrl;
      releaseObjectUrl();
      activeUrl = URL.createObjectURL(record.blob);
      activeUrlTrackId = trackId(record);
      return activeUrl;
    }
    releaseObjectUrl();
    return String(record.data || '');
  }
  function releaseObjectUrl() {
    if (activeUrl) { try { URL.revokeObjectURL(activeUrl); } catch (_) { } }
    activeUrl = '';
    activeUrlTrackId = '';
  }
  function updateMini() {
    const mini = root.document.getElementById('mini-title');
    const track = currentTrack();
    if (mini) mini.textContent = track ? trackName(track) : '未播放';
    const count = root.document.getElementById('music-track-count');
    if (count) count.textContent = queue().length + ' 首歌曲';
    const summary = root.document.getElementById('music-library-summary');
    if (summary) summary.textContent = '本地曲库 · ' + queue().length + ' 首 · 音频只保存在这台设备';
  }
  function renderPlaylist() {
    const host = root.document.getElementById('playlist');
    if (!host) return;
    const query = String((root.document.getElementById('music-search') || {}).value || '').trim().toLocaleLowerCase();
    const visible = queue().map(function (track, index) { return { track: track, index: index }; }).filter(function (row) {
      return !query || (trackName(row.track) + ' ' + trackDetail(row.track)).toLocaleLowerCase().includes(query);
    });
    host.replaceChildren();
    if (!visible.length) {
      const empty = root.document.createElement('div'); empty.className = 'music-empty-library';
      const label = root.document.createElement('span');
      label.textContent = queue().length ? '没有找到匹配的歌曲。' : '曲库还空着。添加本地音频后，就能在这里搜索和排队播放。';
      empty.appendChild(label);
      if (!queue().length) {
        const add = root.document.createElement('button'); add.type = 'button'; add.textContent = '添加本地音乐';
        add.addEventListener('click', pickMusicFiles); empty.appendChild(add);
      }
      host.appendChild(empty); updateMini(); return;
    }
    visible.forEach(function (row) {
      const track = row.track, index = row.index;
      const item = root.document.createElement('div');
      item.className = 'music-track-row' + (index === currentIndex() ? ' active' : '');
      item.dataset.trackIndex = String(index);
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', index === currentIndex() ? 'true' : 'false');
      item.tabIndex = 0;
      const number = root.document.createElement('span'); number.className = 'music-track-index'; number.textContent = index === currentIndex() && audio() && !audio().paused ? '♫' : String(index + 1);
      const copy = root.document.createElement('span'); copy.className = 'music-track-copy';
      const name = root.document.createElement('span'); name.className = 'music-track-name'; name.textContent = trackName(track);
      const detail = root.document.createElement('span'); detail.className = 'music-track-detail'; detail.textContent = trackDetail(track) + (track.size ? ' · ' + byteLabel(track.size) : '');
      copy.append(name, detail);
      const remove = root.document.createElement('button'); remove.type = 'button'; remove.className = 'music-track-delete'; remove.title = '从曲库移除'; remove.setAttribute('aria-label', '从曲库移除 ' + trackName(track)); remove.textContent = '×';
      item.addEventListener('click', function () { playTrack(index); });
      item.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); playTrack(index); } });
      remove.addEventListener('click', function (event) { event.stopPropagation(); removeTrack(index); });
      item.append(number, copy, remove); host.appendChild(item);
    });
    updateMini();
  }
  function byteLabel(value) {
    const size = Math.max(0, Number(value) || 0);
    if (size < 1024 * 1024) return Math.max(1, Math.round(size / 1024)) + ' KB';
    return (size / 1024 / 1024).toFixed(1) + ' MB';
  }
  function renderMode() {
    const button = root.document.getElementById('mode-btn');
    if (!button) return;
    button.title = MODE_LABELS[state.mode] || MODE_LABELS.list;
    button.setAttribute('aria-label', '播放模式：' + button.title);
    const paths = {
      list: '<path d="M4 6h16M4 12h16M4 18h10"/><path d="m17 16 3 2-3 2"/>',
      single: '<path d="M4 6h16M4 12h16M4 18h10"/><text x="12" y="15" text-anchor="middle" font-size="8" fill="currentColor" stroke="none">1</text>',
      random: '<path d="M4 7h3c4 0 6 10 10 10h3M4 17h3c2 0 3-2 4-3M17 7h3M17 5l3 2-3 2M17 15l3 2-3 2"/>'
    };
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[state.mode] || paths.list) + '</svg>';
  }
  function renderLyrics() {
    const host = root.document.getElementById('music-lyrics'), track = currentTrack();
    if (!host) return;
    host.replaceChildren(); lastLyricIndex = -1;
    const segments = track && track.lyrics && Array.isArray(track.lyrics.segments) ? track.lyrics.segments.slice() : [];
    if (!segments.length) {
      const empty = root.document.createElement('div'); empty.className = 'music-lyric-empty';
      empty.textContent = track ? '这首歌还没有歌词。可以导入 .lrc、.srt 或 .vtt 文件。' : '导入 .lrc / .srt / .vtt 歌词后，这里会随播放进度滚动。';
      host.appendChild(empty); return;
    }
    segments.sort(function (a, b) { return Number(a.start) - Number(b.start); });
    segments.forEach(function (segment, index) {
      const line = root.document.createElement('div'); line.className = 'music-lyric-line';
      line.dataset.start = String(Math.max(0, Number(segment.start) || 0)); line.textContent = String(segment.text || '');
      line.addEventListener('click', function () { const a = audio(); if (!a) return; a.currentTime = Number(line.dataset.start) || 0; if (a.paused) a.play().catch(function () { }); saveState(true); });
      host.appendChild(line);
    });
  }
  function renderCurrent() {
    const track = currentTrack(), a = audio(), panel = root.document.getElementById('music-panel');
    const title = root.document.getElementById('now-playing');
    const subtitle = root.document.getElementById('music-track-subtitle');
    const turntable = root.document.getElementById('music-turntable');
    const recordLabel = root.document.getElementById('music-record-label');
    const play = root.document.getElementById('play-btn');
    const restoreNote = root.document.getElementById('music-restore-note');
    const playing = !!(track && a && !a.paused);
    if (title) title.textContent = track ? trackName(track) : '未选择音乐';
    if (subtitle) subtitle.textContent = track ? trackDetail(track) : (queue().length ? '从曲库选择一首开始播放' : '从曲库添加本地音频，或选择已添加的歌曲');
    if (turntable) turntable.classList.toggle('playing', playing);
    if (recordLabel) recordLabel.textContent = track ? (track.artist ? track.artist.slice(0, 1) : '♪') : '♪';
    if (play) { play.innerHTML = playing ? SVG_PAUSE : SVG_PLAY; play.setAttribute('aria-label', playing ? '暂停' : '播放'); }
    if (restoreNote) restoreNote.hidden = !(track && shouldOfferResume && a && a.paused);
    if (panel) panel.setAttribute('aria-hidden', panel.classList.contains('show') ? 'false' : 'true');
    renderMode(); renderLyrics(); updateProgress(); updateMini(); updateTogetherStatus();
    const rows = root.document.querySelectorAll('.music-track-row');
    rows.forEach(function (row) { const selected = row.getAttribute('aria-selected') === 'true'; row.querySelector('.music-track-index').textContent = selected && playing ? '♫' : String(Number(row.dataset.trackIndex) + 1); });
  }
  function updateProgress() {
    const a = audio(), bar = root.document.getElementById('progress-bar'), fill = root.document.getElementById('progress-fill');
    const current = root.document.getElementById('music-current-time'), duration = root.document.getElementById('music-duration');
    const pos = a && Number.isFinite(a.currentTime) ? a.currentTime : state.position;
    const dur = a && Number.isFinite(a.duration) ? a.duration : 0;
    if (fill) fill.style.width = (dur > 0 ? Math.max(0, Math.min(100, pos / dur * 100)) : 0) + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(dur > 0 ? Math.round(pos / dur * 100) : 0));
    if (current) current.textContent = durationLabel(pos);
    if (duration) duration.textContent = durationLabel(dur);
    updateLyricHighlight(pos);
  }
  function updateLyricHighlight(position) {
    const host = root.document.getElementById('music-lyrics');
    if (!host || !host.firstElementChild || !host.firstElementChild.classList.contains('music-lyric-line')) return;
    const lines = host.querySelectorAll('.music-lyric-line'); let active = -1;
    for (let i = 0; i < lines.length; i++) { if (Number(lines[i].dataset.start) <= position + 0.12) active = i; else break; }
    if (active === lastLyricIndex) return;
    if (lastLyricIndex >= 0 && lines[lastLyricIndex]) lines[lastLyricIndex].classList.remove('active');
    lastLyricIndex = active;
    if (active >= 0 && lines[active]) { lines[active].classList.add('active'); try { host.scrollTo({ top: lines[active].offsetTop - host.clientHeight / 2 + lines[active].offsetHeight / 2, behavior: 'smooth' }); } catch (_) { } }
  }
  function seekAt(clientX) {
    const a = audio(), bar = root.document.getElementById('progress-bar');
    if (!a || !bar || !Number.isFinite(a.duration) || a.duration <= 0) return;
    const rect = bar.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))) * a.duration;
    updateProgress(); saveState(true);
  }
  function releaseCurrentSource() {
    const a = audio(); if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (_) { } }
    releaseObjectUrl();
  }
  async function playTrack(index) {
    await ensureLibrary();
    const list = queue();
    if (!list.length) { root.toast && root.toast('曲库为空，先添加本地音乐'); return; }
    const nextIndex = ((Number(index) % list.length) + list.length) % list.length;
    const track = list[nextIndex], a = audio();
    if (!a || !track) return;
    setIndex(nextIndex); state.currentId = trackId(track); state.position = 0; state.wasPlaying = false; shouldOfferResume = false; restorePosition = null;
    a.volume = state.volume;
    const src = sourceFor(track);
    a.pause(); a.src = src; a.load();
    try { await a.play(); state.wasPlaying = true; if (typeof root.initAudioContext === 'function') root.initAudioContext(); }
    catch (error) { state.wasPlaying = false; root.toast && root.toast('浏览器暂未允许播放；点击播放按钮继续。'); }
    renderPlaylist(); renderCurrent(); saveState(true);
  }
  async function togglePlay() {
    await ensureLibrary();
    const a = audio(); if (!a) return;
    if (currentIndex() < 0) { if (queue().length) await playTrack(0); return; }
    if (a.paused) {
      try { await a.play(); state.wasPlaying = true; if (typeof root.initAudioContext === 'function') root.initAudioContext(); }
      catch (_) { root.toast && root.toast('播放失败，请检查音频文件格式。'); }
    } else a.pause();
    renderPlaylist(); renderCurrent(); saveState(true);
  }
  async function previousTrack() {
    if (!queue().length) return;
    await playTrack(currentIndex() <= 0 ? queue().length - 1 : currentIndex() - 1);
  }
  async function nextTrack() {
    const list = queue(); if (!list.length) return;
    if (state.mode === 'random' && list.length > 1) {
      let index = currentIndex(); while (index === currentIndex()) index = Math.floor(Math.random() * list.length);
      await playTrack(index); return;
    }
    await playTrack(currentIndex() >= list.length - 1 ? 0 : currentIndex() + 1);
  }
  function cycleMode() {
    const modes = ['list', 'single', 'random'];
    state.mode = modes[(modes.indexOf(state.mode) + 1) % modes.length]; setMode(state.mode);
    renderMode(); saveState(true); root.toast && root.toast('播放模式：' + MODE_LABELS[state.mode]);
  }
  function updateNowPlaying() { renderCurrent(); }
  async function removeTrack(index) {
    await ensureLibrary(); const track = queue()[index]; if (!track) return;
    const ask = typeof root.confirmDlg === 'function' ? await root.confirmDlg('从本机曲库移除「' + trackName(track) + '」？音频文件会从 IB 本地数据库删除。', '移除歌曲') : root.confirm('从本机曲库移除「' + trackName(track) + '」？');
    if (!ask) return;
    const wasCurrent = index === currentIndex(), id = trackId(track);
    try { await root.dbDelete(STORE, id); } catch (_) { root.toast && root.toast('移除失败'); return; }
    const list = queue().slice(); list.splice(index, 1); setQueue(list);
    if (wasCurrent) {
      releaseCurrentSource(); setIndex(-1); state.currentId = ''; state.position = 0; state.wasPlaying = false;
      if (list.length) { setIndex(Math.min(index, list.length - 1)); await playTrack(currentIndex()); }
    } else if (index < currentIndex()) setIndex(currentIndex() - 1);
    renderPlaylist(); renderCurrent(); saveState(true);
  }
  async function addFiles(files) {
    await ensureLibrary();
    const list = Array.from(files || []).filter(function (file) { return file && file.size > 0 && !isLyricFile(file.name); });
    if (!list.length) { root.toast && root.toast('没有可添加的音频文件'); return; }
    let added = 0; const startIndex = queue().length;
    for (const file of list) {
      const record = { id: freshId(), name: file.name || '音频', title: file.name || '音频', type: file.type || '', size: file.size || 0, addedAt: Date.now() + added, src: 'desktop-local', blob: file };
      try { await root.dbPut(STORE, record); added++; } catch (error) { console.warn('[Music] could not store selected audio', error); }
    }
    await loadLibrary();
    if (added) {
      root.toast && root.toast('已添加 ' + added + ' 首音乐');
      if (currentIndex() < 0) await playTrack(startIndex);
    } else root.toast && root.toast('添加失败：本地曲库无法写入。');
  }
  function addMusicFiles(event) {
    const input = event && event.target, files = input ? Array.from(input.files || []) : [];
    if (input) input.value = '';
    return addFiles(files);
  }
  function parseTimestamp(value) {
    const raw = String(value || '').trim();
    const lrc = raw.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (!lrc) return NaN;
    const hour = Number(lrc[1] || 0), minute = Number(lrc[2] || 0), second = Number(lrc[3] || 0), fraction = String(lrc[4] || '0').padEnd(3, '0');
    return hour * 3600 + minute * 60 + second + Number(fraction) / 1000;
  }
  function parseLrcTimestamp(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/);
    if (!match) return NaN;
    const fraction = String(match[3] || '0');
    const divisor = fraction.length === 1 ? 10 : (fraction.length === 2 ? 100 : 1000);
    return Number(match[1]) * 60 + Number(match[2]) + Number(fraction) / divisor;
  }
  function parseLyrics(text) {
    const segments = [], lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    lines.forEach(function (line) {
      const lrcTimes = Array.from(line.matchAll(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g));
      if (lrcTimes.length) {
        const lyric = line.replace(/\[(?:\d{1,2}:\d{2}(?:[.:]\d{1,3})?|[a-z]+:[^\]]*)\]/gi, '').trim();
        if (lyric) lrcTimes.forEach(function (match) { const time = parseLrcTimestamp(match[1]); if (Number.isFinite(time)) segments.push({ start: time, text: lyric }); });
        return;
      }
      const srt = line.match(/(?:^|\s)(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
      if (srt) { const t = parseTimestamp(srt[1].replace(',', '.')); if (Number.isFinite(t)) segments.push({ start: t, text: '' }); return; }
      if (line.trim() && segments.length && !/^\d+$/.test(line.trim()) && !/^WEBVTT$/i.test(line.trim())) {
        const previous = segments[segments.length - 1];
        previous.text = previous.text ? previous.text + '\n' + line.trim() : line.trim();
      }
    });
    return segments.filter(function (segment) { return segment.text; }).sort(function (a, b) { return a.start - b.start; });
  }
  function isLyricFile(name) { return /\.(?:lrc|srt|vtt)$/i.test(String(name || '')); }
  async function importLyrics(event) {
    const input = event && event.target, file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file) return;
    await ensureLibrary();
    const track = currentTrack(); if (!track) { root.toast && root.toast('先选择一首歌曲，再导入歌词。'); return; }
    if (isLyricFile(file.name)) {
      const lyrics = parseLyrics(await file.text());
      if (!lyrics.length) { root.toast && root.toast('没有识别到带时间轴的歌词。'); return; }
      track.lyrics = { source: String(file.name).split('.').pop().toLowerCase(), segments: lyrics, importedAt: Date.now() };
      try { await root.dbPut(STORE, track); renderLyrics(); root.toast && root.toast('歌词已绑定到「' + trackName(track) + '」'); }
      catch (_) { root.toast && root.toast('歌词保存失败'); }
    }
  }
  function pickMusicFiles() { const input = root.document.getElementById('musicInput'); if (input) { input.value = ''; input.click(); } }
  function pickLyrics() { const input = root.document.getElementById('musicLyricsInput'); if (input) { input.accept = LYRIC_ACCEPT; input.value = ''; input.click(); } }
  async function openMusicPanel() {
    try { await ensureLibrary(); } catch (_) { }
    const panel = root.document.getElementById('music-panel'), mini = root.document.getElementById('music-mini');
    if (!panel) return;
    panel.classList.add('show'); panel.setAttribute('aria-hidden', 'false');
    if (mini) mini.style.display = 'none';
    renderPlaylist(); renderCurrent();
    const search = root.document.getElementById('music-search'); if (search) search.focus({ preventScroll: true });
  }
  function closeMusicPanel() {
    const panel = root.document.getElementById('music-panel'), mini = root.document.getElementById('music-mini');
    if (panel) { panel.classList.remove('show'); panel.setAttribute('aria-hidden', 'true'); }
    if (mini) mini.style.display = 'flex';
  }
  function canShareWithRole(friendId) { return !state.mateId || (String(friendId || '') === state.mateId && !String(friendId || '').startsWith('group_')); }
  function chatContext(track, friendId) {
    if (!track || !canShareWithRole(friendId)) return '';
    const who = [trackName(track), track.artist, track.album].filter(Boolean).join(' · ');
    return '用户此刻正在听《' + who + '》。音频文件没有发给你；请不要声称听见歌词、乐器或具体内容。可以根据歌曲名和艺人自然回应，用户若想找相似歌曲可以给出建议。';
  }
  function updateTogetherStatus() {
    const host = root.document.getElementById('music-together-status'), select = root.document.getElementById('music-together-select');
    if (!host || !select) return;
    const name = select.selectedOptions && select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
    if (state.mateId) {
      const elapsed = Number(state.mateTime[state.mateId] || 0);
      host.textContent = '自动上下文仅向 ' + name + ' 分享曲目 · 需开启 API 页 Sing · 一起听 ' + durationLabel(elapsed / 1000);
    } else host.textContent = '自动上下文按 API 页 Sing 开关分享';
  }
  async function loadChatRoles() {
    const select = root.document.getElementById('music-together-select');
    const controlSelect = root.document.getElementById('music-control-role-select');
    let roles = [];
    try { roles = await root.dbGetAll('apiConfigs'); } catch (_) { }
    chatRoles = (roles || []).filter(function (role) { return role && role.id && !String(role.id).startsWith('group_') && !role.archived && role.roleSelectable !== false && role.providerProfileOnly !== true; });
    if (!select && !controlSelect) return;
    const current = state.mateId;
    if (select) {
      select.replaceChildren();
      const none = root.document.createElement('option'); none.value = ''; none.textContent = '按现有 Sing 设置分享'; select.appendChild(none);
      chatRoles.forEach(function (role) {
        const option = root.document.createElement('option'); option.value = String(role.id); option.textContent = String(role.nickname || role.model || '未命名角色'); select.appendChild(option);
      });
      if (Array.from(select.options).some(function (option) { return option.value === current; })) select.value = current;
    }
    else if (current) { state.mateId = ''; saveState(true); }
    if (select && current && !Array.from(select.options).some(function (option) { return option.value === current; })) { state.mateId = ''; saveState(true); }
    if (controlSelect) {
      controlSelect.replaceChildren();
      const choose = root.document.createElement('option'); choose.value = ''; choose.textContent = '选择角色'; controlSelect.appendChild(choose);
      chatRoles.forEach(function (role) {
        const option = root.document.createElement('option'); option.value = String(role.id); option.textContent = String(role.nickname || role.model || '未命名角色'); controlSelect.appendChild(option);
      });
      const active = getConversation().friendId;
      const wanted = state.controlRoleId || (chatRoles.some(function (role) { return String(role.id) === active; }) ? active : '');
      controlSelect.value = Array.from(controlSelect.options).some(function (option) { return option.value === wanted; }) ? wanted : '';
      state.controlRoleId = controlSelect.value;
    }
    updateTogetherStatus();
    await refreshControlPermission();
  }
  function eligibleRoleId(roleId) {
    const id = String(roleId || '');
    return !!id && !id.startsWith('group_') && chatRoles.some(function (role) { return String(role.id) === id; });
  }
  async function refreshControlPermission() {
    const select = root.document.getElementById('music-control-role-select');
    const checkbox = root.document.getElementById('music-control-enabled');
    const status = root.document.getElementById('music-control-status');
    if (!select || !checkbox) return false;
    const roleId = String(select.value || '');
    checkbox.disabled = !eligibleRoleId(roleId);
    checkbox.checked = false;
    if (!eligibleRoleId(roleId)) { if (status) status.textContent = '选择一对一角色后可授权'; return false; }
    try {
      const role = await root.dbGet('apiConfigs', roleId);
      const allowed = !!(role && role.id === roleId && role.musicControlEnabled === true);
      checkbox.checked = allowed;
      if (status) { status.textContent = allowed ? '已授权 · 按你的明确指令操作' : '未授权 · 角色仍可正常聊天'; status.title = allowed ? '该角色只能根据你明确提出的本地音乐请求操作播放器。' : '未授权该角色控制本地播放器。'; }
      return allowed;
    } catch (_) {
      checkbox.disabled = true;
      if (status) status.textContent = '暂时无法读取角色权限';
      return false;
    }
  }
  async function setControlPermission(allowed) {
    const select = root.document.getElementById('music-control-role-select');
    const checkbox = root.document.getElementById('music-control-enabled');
    const status = root.document.getElementById('music-control-status');
    const roleId = String(select && select.value || '');
    if (!eligibleRoleId(roleId)) { if (checkbox) checkbox.checked = false; return false; }
    try {
      const changed = await root.dbUpdate('apiConfigs', roleId, function (role) {
        if (!role || String(role.id) !== roleId || String(role.id).startsWith('group_')) return null;
        return Object.assign({}, role, { musicControlEnabled: allowed === true });
      });
      if (!changed) throw new Error('角色配置没有更新');
      if (status) { status.textContent = allowed ? '已授权 · 仅执行你的明确请求' : '已撤销播放器控制权限'; status.title = allowed ? '该角色只能根据你明确提出的本地音乐请求操作播放器。' : '已撤销该角色控制本地播放器的权限。'; }
      if (root.toast) root.toast(allowed ? '已允许该角色控制本地播放器' : '已撤销该角色的音乐控制权限');
      return true;
    } catch (error) {
      if (checkbox) checkbox.checked = !allowed;
      if (status) status.textContent = '权限保存失败，未更改播放器授权';
      return false;
    }
  }
  function explicitMusicIntent(action, text, query) {
    const value = String(text || '').toLocaleLowerCase().replace(/[\u3000\s]+/g, ' ').trim();
    if (!value) return false;
    const deny = /(?:不要|別|别|不想|不必|不用|无需|無需|先不|先别|先別|暂时不|暫時不|取消|别再|別再)[^。！？!?，,；;]{0,12}(?:播放|点播|點播|放歌|听歌|聽歌|暂停|暫停|停止播放|切歌|下一首|上一首|搜索|搜尋|推荐|推薦|找歌)/i;
    if (deny.test(value)) return false;
    const patterns = {
      play: /(?:播放|点播|點播|放(?:一首|首|这首|這首|歌曲|歌|音乐|音樂)|来(?:一首|点|點)|(?:想|要|想要)听(?:一首|这首|這首|歌|音乐|音樂)|(?:想|要|想要)聽(?:一首|這首|歌|音樂)|听(?:一首|这首|這首)|聽(?:一首|這首)|继续播放|繼續播放|接着播放|接著播放|开始播放|開始播放)/i,
      pause: /(?:暂停|暫停|停一下|停一会|停一會|先停|停止播放|pause)/i,
      next: /(?:下一首|换一首|換一首|切一首|切歌|跳过当前|跳過當前|next track)/i,
      prev: /(?:上一首|前一首|退回上一首|prev(?:ious)? track)/i,
      search: /(?:搜索|搜尋|推荐|推薦|找(?:一首|歌|歌曲|点|點|些)|找.{0,16}(?:歌|歌曲|音乐|音樂)|听点|聽點|有什么.{0,12}(?:歌|歌曲|音乐|音樂)|有沒有.{0,12}(?:歌|歌曲|音樂)|有没有.{0,12}(?:歌|歌曲|音乐)|类似.{0,12}(?:歌|歌曲|音乐|音樂)|相似.{0,12}(?:歌|歌曲|音乐|音樂)|适合.{0,12}(?:歌|歌曲|音乐|音樂)|適合.{0,12}(?:歌|歌曲|音樂))/i
    };
    if (!patterns[action] || !patterns[action].test(value)) return false;
    if ((action === 'search' || action === 'play') && String(query || '').trim()) {
      const q = normalizedTrackText(query), user = normalizedTrackText(value);
      if (q.length > 1 && !user.includes(q)) return false; /* the model may not retarget a user's named song or search phrase */
    }
    return true;
  }
  function normalizedTrackText(value) {
    return String(value || '').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  }
  function findLocalMatches(query) {
    const q = normalizedTrackText(query);
    if (!q) return [];
    return queue().map(function (track, index) {
      const title = normalizedTrackText(trackName(track));
      const detail = normalizedTrackText(trackDetail(track));
      const whole = normalizedTrackText([trackName(track), track.artist, track.album].filter(Boolean).join(' '));
      let score = 0;
      if (q === title) score = 100;
      else if (q === whole) score = 110;
      else if (title && title.includes(q)) score = 80;
      else if (whole.includes(q)) score = 65;
      else if (q.includes(title) && title.length >= 2) score = 55;
      else if (detail && detail.includes(q)) score = 40;
      return { track: track, index: index, score: score };
    }).filter(function (row) { return row.score > 0; }).sort(function (a, b) { return b.score - a.score; });
  }
  async function executeChatCommand(op, cfg, context) {
    op = op || {}; context = context || {};
    const action = String(op.action || '').toLowerCase();
    const query = String(op.query || '').trim().slice(0, 120);
    const fail = function (reason, extra) { return Object.assign({ type: 'music', action: action, query: query, ok: false, permissionGranted: false, intentAccepted: false, executionKnown: true, reason: reason }, extra || {}); };
    const friendId = String(context.friendId || '');
    if (context.source !== 'chat' || !cfg || !cfg.id || cfg._group || String(cfg.id).startsWith('group_') || friendId !== String(cfg.id) || friendId.startsWith('group_')) return fail('音乐控制只适用于当前一对一角色对话。');
    if (op.malformed || op.truncated || !['search', 'play', 'pause', 'next', 'prev'].includes(action)) return fail('音乐指令格式不完整或操作不受支持。');
    let role;
    try { role = await root.dbGet('apiConfigs', String(cfg.id)); } catch (_) { return fail('无法读取该角色的音乐权限；操作未执行。'); }
    if (!role || String(role.id) !== String(cfg.id) || role.musicControlEnabled !== true) return fail('该角色尚未获得音乐控制权限。');
    if (!explicitMusicIntent(action, context.userMessage, query)) return fail('没有从这条用户消息中确认对应的音乐请求或曲目；播放器未改变。', { permissionGranted: true });
    await ensureLibrary();
    let result = { ok: false, reason: '未知的音乐操作。' };
    if (action === 'search') {
      if (!query) result = { ok: false, reason: '缺少要搜索的歌曲、艺人或风格。' };
      else {
        const rows = findLocalMatches(query).slice(0, 8);
        const matches = rows.map(function (row) { return { title: trackName(row.track), artist: String(row.track.artist || ''), album: String(row.track.album || '') }; });
        result = matches.length
          ? { ok: true, found: true, matches: matches, summary: '本机曲库中找到 ' + matches.length + ' 首匹配歌曲。', response: '本机曲库匹配结果：' + matches.map(function (item) { return item.title + (item.artist ? ' — ' + item.artist : ''); }).join('；') + '。这些结果只来自本机曲库。' }
          : { ok: false, found: false, matches: [], reason: '本机曲库中没有找到匹配项；没有访问在线曲库。' };
      }
    } else if (action === 'play') {
      let index = currentIndex();
      if (query) {
        const rows = findLocalMatches(query);
        if (!rows.length) result = { ok: false, reason: '本机曲库没有找到「' + query + '」；没有访问在线曲库。' };
        else if (rows.length > 1 && rows[0].score === rows[1].score) result = { ok: false, reason: '本机曲库有多首同等匹配的歌曲，请补充艺人或专辑名称。', matches: rows.slice(0, 5).map(function (row) { return { title: trackName(row.track), artist: String(row.track.artist || '') }; }) };
        else index = rows[0].index;
      } else if (index < 0 && queue().length) index = 0;
      if (!result.ok && result.reason === '未知的音乐操作。') {
        if (index < 0) result = { ok: false, reason: '本机曲库为空，请先添加音频文件。' };
        else if (!query && index === currentIndex() && audio() && !audio().paused) result = { ok: true, summary: '《' + trackName(currentTrack()) + '》已经在播放。', response: '《' + trackName(currentTrack()) + '》正在播放。' };
        else {
          if (!query && index === currentIndex() && audio() && audio().paused) await togglePlay();
          else await playTrack(index);
          const track = currentTrack(), playing = !!(audio() && !audio().paused);
          result = playing ? { ok: true, summary: '正在播放《' + trackName(track) + '》' + (track.artist ? ' — ' + track.artist : '') + '。', response: '实际播放器已开始播放《' + trackName(track) + '》' + (track.artist ? ' — ' + track.artist : '') + '。' }
            : { ok: false, reason: '播放器没有开始播放；可能是音频格式不受支持或系统阻止了播放。' };
        }
      }
    } else if (action === 'pause') {
      const a = audio();
      if (!currentTrack() || !a) result = { ok: false, reason: '目前没有正在播放的本地歌曲。' };
      else if (a.paused) result = { ok: true, summary: '当前歌曲已经暂停。', response: '播放器本来就处于暂停状态。' };
      else { a.pause(); renderPlaylist(); renderCurrent(); saveState(true); result = { ok: a.paused, summary: a.paused ? '已暂停《' + trackName(currentTrack()) + '》。' : '', response: a.paused ? '已暂停《' + trackName(currentTrack()) + '》。' : '', reason: a.paused ? '' : '播放器没有进入暂停状态。' }; }
    } else if (action === 'next' || action === 'prev') {
      if (!queue().length) result = { ok: false, reason: '本机曲库为空，无法切歌。' };
      else {
        if (action === 'next') await nextTrack(); else await previousTrack();
        const track = currentTrack(), playing = !!(track && audio() && !audio().paused);
        result = playing ? { ok: true, summary: '现在播放《' + trackName(track) + '》' + (track.artist ? ' — ' + track.artist : '') + '。', response: '播放器已切到《' + trackName(track) + '》' + (track.artist ? ' — ' + track.artist : '') + '。' }
          : { ok: false, reason: '切歌后播放器没有开始播放。' };
      }
    }
    return Object.assign({ type: 'music', action: action, query: query, permissionGranted: true, intentAccepted: true, executionKnown: true }, result);
  }
  async function controlInstruction(friendId) {
    const id = String(friendId || '');
    if (!id || id.startsWith('group_')) return '';
    try {
      const role = await root.dbGet('apiConfigs', id);
      if (!role || String(role.id) !== id || role.archived || role.roleSelectable === false || role.providerProfileOnly === true || role.musicControlEnabled !== true) return '';
      return '【Music 本地播放器】用户已单独授权你在当前一对一对话中操作本地曲库。只有当用户这条消息明确要求搜索/推荐本机曲库、播放指定曲目、暂停、下一首或上一首时才输出一个自闭合动作；一般闲聊、询问能力、假设句、否定句都正常交谈，不要操作。动作完成后依据执行结果反馈再自然回应，不要提前声称成功。只可访问本机曲库；不能搜索互联网、读取外部账号或发送音频。格式：<ws_music op="search|play|pause|next|prev" q="歌曲/艺人/风格"/>；播放指定曲目时 q 填用户要求的曲名；暂停/切歌时 q 留空。搜索与推荐只返回本机曲库匹配项，找不到就直说。';
    } catch (_) { return ''; }
  }
  function queueChatShare() {
    const track = currentTrack(), conversation = getConversation();
    if (!track) { root.toast && root.toast('先选一首歌曲，再分享到 Chat。'); return; }
    const friendId = String(conversation.friendId || '');
    if (!friendId || friendId.startsWith('group_')) { root.toast && root.toast('先打开一对一 Chat 并选择角色，再分享曲目。'); return; }
    const snap = { trackId: trackId(track), title: trackName(track), artist: String(track.artist || ''), album: String(track.album || ''), atSec: audio() ? Number(audio().currentTime) || 0 : state.position, duration: audio() && Number.isFinite(audio().duration) ? audio().duration : 0 };
    const sentence = '我现在在听《' + snap.title + '》' + (snap.artist ? '（' + snap.artist + '）' : '') + '，想和你聊聊这首歌。';
    pendingShare = { friendId: friendId, threadId: String(conversation.threadId || ''), card: snap, expiresAt: Date.now() + 30 * 60 * 1000 };
    closeMusicPanel();
    if (root.currentPage !== 'chat' && typeof root.navTo === 'function') root.navTo('chat');
    setTimeout(function () {
      const input = root.document.getElementById('chat-full-input') || root.document.getElementById('chat-input');
      if (!input) { pendingShare = null; root.toast && root.toast('无法打开 Chat 草稿'); return; }
      input.value = String(input.value || '').trim() ? String(input.value).replace(/\s+$/, '') + '\n' + sentence : sentence;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof root.autoResizeInput === 'function') root.autoResizeInput(input);
      input.focus();
      root.toast && root.toast('曲目和音乐卡已放入 Chat 草稿，检查后由你发送。');
    }, 180);
  }
  function pendingForChat(friendId, threadId) {
    if (!pendingShare) return null;
    if (Date.now() > pendingShare.expiresAt) { pendingShare = null; return null; }
    if (String(friendId || '') !== pendingShare.friendId || String(threadId || '') !== pendingShare.threadId || String(friendId || '').startsWith('group_')) {
      pendingShare = null;
      return { error: 'scope-mismatch' };
    }
    return { card: Object.assign({}, pendingShare.card) };
  }
  function clearPendingShare() { pendingShare = null; }
  function renderChatCard(snap) {
    if (!snap || !snap.trackId) return null;
    const card = root.document.createElement('button'); card.type = 'button'; card.className = 'chat-music-card';
    const art = root.document.createElement('span'); art.className = 'chat-music-card-art'; art.textContent = '♪';
    const copy = root.document.createElement('span'); copy.className = 'chat-music-card-copy';
    const title = root.document.createElement('span'); title.className = 'chat-music-card-title'; title.textContent = '《' + String(snap.title || 'Music') + '》';
    const subtitle = root.document.createElement('span'); subtitle.className = 'chat-music-card-sub'; subtitle.textContent = String(snap.artist || '来自 Music 的曲目分享') + ' · ' + durationLabel(Number(snap.atSec) || 0);
    copy.append(title, subtitle);
    const play = root.document.createElement('span'); play.className = 'chat-music-card-play'; play.innerHTML = SVG_PLAY; play.setAttribute('aria-hidden', 'true');
    card.append(art, copy, play);
    card.addEventListener('click', async function () {
      await ensureLibrary();
      const index = queue().findIndex(function (record) { return trackId(record) === String(snap.trackId); });
      if (index < 0) { root.toast && root.toast('这首歌只在发送方的本地曲库中；此设备没有对应音频。'); return; }
      closeMusicPanel(); await playTrack(index);
    });
    return card;
  }
  function attachPendingCardToComposerInput(input) {
    if (!input) return;
    input.addEventListener('input', function () { if (!String(input.value || '').trim()) pendingShare = null; });
  }
  function bind() {
    const add = root.document.getElementById('music-add-button'); if (add) add.addEventListener('click', pickMusicFiles);
    const lyrics = root.document.getElementById('music-lyrics-add'); if (lyrics) lyrics.addEventListener('click', pickLyrics);
    const lyricsInput = root.document.getElementById('musicLyricsInput'); if (lyricsInput) lyricsInput.addEventListener('change', importLyrics);
    const search = root.document.getElementById('music-search'); if (search) search.addEventListener('input', renderPlaylist);
    const share = root.document.getElementById('music-share-chat'); if (share) share.addEventListener('click', queueChatShare);
    const mate = root.document.getElementById('music-together-select');
    if (mate) mate.addEventListener('change', function () { state.mateId = String(mate.value || ''); updateTogetherStatus(); saveState(true); });
    const controlRole = root.document.getElementById('music-control-role-select');
    if (controlRole) controlRole.addEventListener('change', function () { state.controlRoleId = String(controlRole.value || ''); saveState(true); refreshControlPermission(); });
    const controlAllowed = root.document.getElementById('music-control-enabled');
    if (controlAllowed) controlAllowed.addEventListener('change', function () { setControlPermission(controlAllowed.checked); });
    const volume = root.document.getElementById('music-volume');
    if (volume) { volume.value = String(state.volume); volume.addEventListener('input', function () { const a = audio(); if (a) a.volume = Math.max(0, Math.min(1, Number(volume.value))); state.volume = Number(volume.value); saveState(true); }); }
    const bar = root.document.getElementById('progress-bar');
    if (bar) {
      bar.addEventListener('pointerdown', function (event) { event.preventDefault(); bar.setPointerCapture(event.pointerId); seekAt(event.clientX); });
      bar.addEventListener('pointermove', function (event) { if (event.buttons) seekAt(event.clientX); });
      bar.addEventListener('keydown', function (event) { const a = audio(); if (!a || !Number.isFinite(a.duration)) return; if (event.key === 'ArrowRight') a.currentTime = Math.min(a.duration, a.currentTime + 5); else if (event.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 5); else return; updateProgress(); saveState(true); });
    }
    const a = audio();
    if (a) {
      a.preload = 'metadata'; a.addEventListener('timeupdate', function () { updateProgress(); saveState(false); });
      a.addEventListener('loadedmetadata', function () {
        if (restorePosition != null && Number.isFinite(a.duration)) { try { a.currentTime = Math.min(restorePosition, Math.max(0, a.duration - 0.1)); } catch (_) { } restorePosition = null; updateProgress(); }
      });
      ['play', 'pause', 'loadedmetadata'].forEach(function (eventName) { a.addEventListener(eventName, function () { renderPlaylist(); renderCurrent(); saveState(eventName === 'pause'); }); });
      a.addEventListener('ended', function () {
        renderPlaylist(); renderCurrent();
        /* core.js advances or restarts the shared Audio element in its earlier
           ended listener. Persist after that handler so a loop never records
           the stale duration as the resume position. */
        setTimeout(function () { saveState(true); }, 80);
      });
      a.addEventListener('play', function () { shouldOfferResume = false; pairedTick = Date.now(); });
      a.addEventListener('pause', function () { shouldOfferResume = false; pairedTick = 0; });
      setInterval(function () {
        if (!state.mateId || !a || a.paused) { pairedTick = 0; return; }
        const now = Date.now(); if (pairedTick && now - pairedTick < 5000) state.mateTime[state.mateId] = Number(state.mateTime[state.mateId] || 0) + now - pairedTick;
        pairedTick = now; updateTogetherStatus(); saveState(false);
      }, 1000);
    }
    ['chat-full-input', 'chat-input'].forEach(function (id) { attachPendingCardToComposerInput(root.document.getElementById(id)); });
    root.addEventListener('pagehide', function () { saveState(true); });
    root.document.addEventListener('visibilitychange', function () { if (root.document.hidden) saveState(true); });
  }
  async function restore() {
    await ensureLibrary();
    const a = audio(); if (!a) return;
    setMode(state.mode); a.volume = state.volume;
    const volume = root.document.getElementById('music-volume'); if (volume) volume.value = String(state.volume);
    const index = queue().findIndex(function (record) { return trackId(record) === state.currentId; });
    if (index >= 0) {
      setIndex(index);
      const record = queue()[index]; a.src = sourceFor(record); a.load(); restorePosition = state.position;
    } else { setIndex(-1); state.currentId = ''; state.position = 0; state.wasPlaying = false; shouldOfferResume = false; }
    await loadChatRoles(); renderPlaylist(); renderCurrent();
  }

  root.openMusicPanel = openMusicPanel;
  root.closeMusicPanel = closeMusicPanel;
  root.addMusicFiles = addMusicFiles;
  root.renderPlaylist = renderPlaylist;
  root.removeTrack = removeTrack;
  root.playTrack = playTrack;
  root.togglePlay = togglePlay;
  root.prevTrack = previousTrack;
  root.nextTrack = nextTrack;
  root.seekMusic = function (event) { if (event && Number.isFinite(event.clientX)) seekAt(event.clientX); };
  root.cycleMode = cycleMode;
  root.updateNowPlaying = updateNowPlaying;
  root.IBMusic = {
    open: openMusicPanel,
    playTrack: playTrack,
    canShareWithRole: canShareWithRole,
    chatContext: chatContext,
    controlInstruction: controlInstruction,
    executeChatCommand: executeChatCommand,
    setControlPermission: setControlPermission,
    refreshControlPermission: refreshControlPermission,
    pendingForChat: pendingForChat,
    clearPendingShare: clearPendingShare,
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    refresh: function () { libraryReady = null; return loadLibrary(); }
  };
  root.IBMusicChatCard = { render: renderChatCard };
  try {
    if (root.IB && root.IB.core) Object.assign(root.IB.core, {
      openMusicPanel: openMusicPanel, closeMusicPanel: closeMusicPanel, addMusicFiles: addMusicFiles,
      renderPlaylist: renderPlaylist, removeTrack: removeTrack, playTrack: playTrack, togglePlay: togglePlay,
      prevTrack: previousTrack, nextTrack: nextTrack, cycleMode: cycleMode, updateNowPlaying: updateNowPlaying
    });
  } catch (_) { }

  bind();
  restore().catch(function (error) { console.warn('[Music] restore failed', error); });
})(typeof window !== 'undefined' ? window : null);
