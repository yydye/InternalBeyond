'use strict';

/*
 * Internal Beyond — local Active Messages companion
 *
 * Runs a durable scheduler outside the browser. The browser explicitly syncs
 * only schedules whose "background_enabled" switch is on. Generated results
 * remain queued here until InternalBeyond.html imports and acknowledges them.
 *
 * Node.js 18+ is required (uses the built-in fetch implementation).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

if (typeof fetch !== 'function') {
  console.error('Internal Beyond Active Messages requires Node.js 18 or newer.');
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.IB_ACTIVE_PORT) || 23114));
const START_DELAY_MS = Math.max(500, Number(process.env.IB_ACTIVE_START_DELAY_MS) || 35000);
const DATA_DIR = process.env.IB_ACTIVE_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
    : path.join(os.homedir(), '.internal-beyond'));
const DATA_FILE = path.join(DATA_DIR, 'active-message-service.json');
const DATA_TEMP_FILE = `${DATA_FILE}.tmp`;
const DATA_BACKUP_FILE = `${DATA_FILE}.bak`;
const MAX_BODY = 4 * 1024 * 1024;
const PROACTIVE_MAX_ATTEMPTS = 3; // initial request + at most two regeneration attempts
const PROACTIVE_SIMILARITY_LIMIT = 0.82;

fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyData() {
  return { version: 2, tasks: {}, events: {}, history: {} };
}

function parseDataFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('State root is not an object');
  }
  return {
    version: 2,
    tasks: parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks) ? parsed.tasks : {},
    events: parsed.events && typeof parsed.events === 'object' && !Array.isArray(parsed.events) ? parsed.events : {},
    history: parsed.history && typeof parsed.history === 'object' && !Array.isArray(parsed.history) ? parsed.history : {}
  };
}

function loadData() {
  const candidates = [DATA_FILE, DATA_TEMP_FILE, DATA_BACKUP_FILE];
  let sawInvalid = false;
  for (const file of candidates) {
    try {
      const loaded = parseDataFile(file);
      if (file !== DATA_FILE) {
        console.warn(`[Active] Recovered state from ${path.basename(file)} because the main state file was unavailable.`);
      }
      return loaded;
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      sawInvalid = true;
      console.warn(`[Active] Could not read ${path.basename(file)}:`, error.message);
    }
  }
  if (sawInvalid) console.warn('[Active] No valid state copy remains; starting with an empty queue.');
  return emptyData();
}

let state = loadData();
let saveQueued = false;
let saveTimer = null;
let ticking = false;
/* Deliberately process-local: every service restart requires a fresh browser reconcile. */
const armedUsers = new Set();

function fsyncFile(file) {
  const handle = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function fsyncDataDirectory() {
  try {
    const handle = fs.openSync(DATA_DIR, 'r');
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  } catch (_) {
    // Directory fsync is not available on every Windows/filesystem combination.
  }
}

function saveNow() {
  saveQueued = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const handle = fs.openSync(DATA_TEMP_FILE, 'w', 0o600);
  try {
    fs.writeFileSync(handle, JSON.stringify(state, null, 2), 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    if (fs.existsSync(DATA_FILE)) {
      if (fs.existsSync(DATA_BACKUP_FILE)) fs.unlinkSync(DATA_BACKUP_FILE);
      fs.renameSync(DATA_FILE, DATA_BACKUP_FILE);
    }
    fs.renameSync(DATA_TEMP_FILE, DATA_FILE);
    try { fs.chmodSync(DATA_FILE, 0o600); } catch (_) {}
    fsyncDataDirectory();
  } catch (error) {
    /* Keep at least one readable main copy if the final rename fails. */
    try {
      if (!fs.existsSync(DATA_FILE) && fs.existsSync(DATA_BACKUP_FILE)) {
        fs.copyFileSync(DATA_BACKUP_FILE, DATA_FILE);
        fsyncFile(DATA_FILE);
      }
    } catch (_) {}
    throw error;
  }
}

function queueSave() {
  if (saveQueued) return;
  saveQueued = true;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveNow();
    } catch (error) {
      saveQueued = false;
      console.error('[Active] Could not persist queued state:', error.message);
    }
  }, 50);
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function timeParts(setting) {
  const raw = String(setting && setting.schedule && setting.schedule.time || '09:00').split(':');
  return {
    hour: Math.max(0, Math.min(23, Number.parseInt(raw[0], 10) || 0)),
    minute: Math.max(0, Math.min(59, Number.parseInt(raw[1], 10) || 0))
  };
}

function atConfiguredTime(base, setting) {
  const parts = timeParts(setting);
  const date = new Date(base);
  date.setHours(parts.hour, parts.minute, 0, 0);
  return date;
}

function intervalMs(setting) {
  const schedule = setting.schedule || {};
  const value = Math.max(1, Number.parseInt(schedule.interval_value, 10) || 1);
  if (schedule.interval_unit === 'days') return value * 86400000;
  if (schedule.interval_unit === 'minutes') return value * 60000;
  return value * 3600000;
}

function nextRun(setting, fromMs) {
  const from = new Date(fromMs == null ? Date.now() : fromMs);
  const frequency = setting.frequency || 'daily';
  if (frequency === 'interval') {
    const step = intervalMs(setting);
    if (setting.last_sent) {
      let candidate = Number(setting.last_sent) + step;
      while (candidate <= from.getTime()) candidate += step;
      return candidate;
    }
    const first = atConfiguredTime(from, setting).getTime();
    return first > from.getTime() ? first : from.getTime() + step;
  }
  if (frequency === 'weekly') {
    const configured = Array.isArray(setting.schedule && setting.schedule.days)
      ? setting.schedule.days.map(Number)
      : [];
    const allowed = new Set(configured.length ? configured : [from.getDay()]);
    for (let add = 0; add <= 7; add += 1) {
      const day = new Date(from);
      day.setDate(from.getDate() + add);
      const candidate = atConfiguredTime(day, setting);
      if (allowed.has(candidate.getDay()) && candidate.getTime() > from.getTime() + 500) {
        return candidate.getTime();
      }
    }
  }
  const candidate = atConfiguredTime(from, setting);
  if (candidate.getTime() <= from.getTime() + 500) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

function safePart(value) {
  return String(value || '').replace(/[^\w.-]/g, '_');
}

function runId(settingId, scheduledFor) {
  return `active_run_${safePart(settingId)}_${Math.floor(Number(scheduledFor) || 0)}`;
}

function messageId(settingId, scheduledFor) {
  return `active_msg_${safePart(settingId)}_${Math.floor(Number(scheduledFor) || 0)}`;
}

function trimText(value, limit) {
  return String(value == null ? '' : value).slice(0, limit);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/* A scheduled task stores instructions and timing only. Legacy message/content fields are
 * migrated to custom_instruction and are never treated as the final message to send. */
function sanitizeActiveSetting(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sourceSchedule = source.schedule && typeof source.schedule === 'object' ? source.schedule : {};
  const customInstruction = source.custom_instruction != null
    ? source.custom_instruction
    : source.customInstruction != null
      ? source.customInstruction
      : source.message != null
        ? source.message
        : '';
  const days = Array.isArray(sourceSchedule.days)
    ? sourceSchedule.days
    : Array.isArray(source.weekdays)
      ? source.weekdays
      : [];
  const schedule = {
    time: trimText(sourceSchedule.time || source.sendTime || source.send_time || '09:00', 16),
    days: days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6).slice(0, 7),
    interval_value: Math.max(1, Number(sourceSchedule.interval_value || source.intervalValue || 24) || 24),
    interval_unit: ['minutes', 'hours', 'days'].includes(sourceSchedule.interval_unit || source.intervalUnit)
      ? (sourceSchedule.interval_unit || source.intervalUnit)
      : 'hours',
    timezone: trimText(sourceSchedule.timezone || source.timezone || 'local', 100)
  };
  return {
    id: trimText(source.id, 180),
    user_id: trimText(source.user_id || source.userId, 180),
    character_id: trimText(source.character_id || source.characterId, 180),
    enabled: !!source.enabled,
    schedule,
    frequency: trimText(source.frequency || source.scheduleType || source.schedule_type || 'daily', 32),
    message_type: trimText(source.message_type || source.messageMode || source.message_mode || 'greeting', 32),
    custom_instruction: trimText(customInstruction, 500).trim(),
    background_enabled: !!(source.background_enabled != null ? source.background_enabled : source.backgroundEnabled),
    adaptive_enabled: !!(source.adaptive_enabled != null ? source.adaptive_enabled : source.adaptiveEnabled),
    last_sent: finiteTimestamp(source.last_sent || source.lastSentAt) || null,
    next_run_at: finiteTimestamp(source.next_run_at || source.nextRunAt) || null,
    created_at: finiteTimestamp(source.created_at || source.createdAt) || Date.now(),
    updated_at: finiteTimestamp(source.updated_at || source.updatedAt) || Date.now()
  };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24);
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function settingControl(setting) {
  const source = setting && typeof setting === 'object' ? setting : {};
  const copy = {};
  Object.keys(source).forEach(key => {
    if (key === 'last_sent' || key === 'next_run_at' || key === 'processing_until' ||
        key === 'processing_run_id' || key === 'updated_at' || key === 'created_at') return;
    copy[key] = source[key];
  });
  return copy;
}

function taskFingerprints(setting, character) {
  const control = settingControl(setting);
  return {
    setting: hashValue(control),
    task: hashValue({ setting: control, character: character || {} })
  };
}

function ensureTaskMetadata(task) {
  if (!task || typeof task !== 'object') return null;
  const setting = task.setting && typeof task.setting === 'object' ? task.setting : {};
  const fingerprints = taskFingerprints(setting, task.character || {});
  const revision = Math.max(1, Number.parseInt(task.task_revision, 10) || 1);
  const settingUpdatedAt = finiteTimestamp(task.setting_updated_at || setting.updated_at);
  if (task.task_revision === revision && task.task_fingerprint === fingerprints.task &&
      task.setting_fingerprint === fingerprints.setting && task.setting_updated_at === settingUpdatedAt) {
    return task;
  }
  return {
    ...task,
    task_revision: revision,
    task_fingerprint: fingerprints.task,
    setting_fingerprint: fingerprints.setting,
    setting_updated_at: settingUpdatedAt
  };
}

function recordUserId(record) {
  if (!record) return '';
  if (record.user_id) return String(record.user_id);
  const task = state.tasks[record.setting_id];
  return String(task && task.setting && task.setting.user_id || '');
}

function sameRunRevision(record, revision) {
  return !record || record.task_revision == null || Number(record.task_revision) === Number(revision);
}

function terminalRun(record, revision) {
  if (!record) return false;
  if (record.status === 'sent') return true;
  return sameRunRevision(record, revision) &&
    (record.status === 'skipped' || record.status === 'failed' || record.status === 'canceled');
}

function replaceTaskRuntime(taskId, current, settingPatch) {
  const now = Date.now();
  const replacement = {
    ...current,
    setting: { ...current.setting, ...settingPatch },
    updated_by_service_at: now
  };
  state.tasks[taskId] = replacement;
  return replacement;
}

function currentForRun(taskId, snapshot) {
  const raw = state.tasks[taskId];
  if (!raw) return { current: null, reason: 'task deleted while generation was running' };
  const current = ensureTaskMetadata(raw);
  if (current !== raw) state.tasks[taskId] = current;
  const setting = current.setting || {};
  const expected = snapshot.setting || {};
  if (Number(current.task_revision) !== Number(snapshot.task_revision) ||
      current.task_fingerprint !== snapshot.task_fingerprint) {
    return { current: null, reason: 'task configuration changed while generation was running' };
  }
  if (String(setting.character_id || '') !== String(expected.character_id || '')) {
    return { current: null, reason: 'task character changed while generation was running' };
  }
  if (String(setting.user_id || '') !== String(expected.user_id || '')) {
    return { current: null, reason: 'task owner changed while generation was running' };
  }
  if (!setting.enabled || !setting.background_enabled) {
    return { current: null, reason: 'task was disabled while generation was running' };
  }
  if (!armedUsers.has(String(setting.user_id || ''))) {
    return { current: null, reason: 'task owner is no longer armed' };
  }
  return { current, reason: '' };
}

function cancelRun(historyId, snapshot, reason) {
  const now = Date.now();
  const setting = snapshot.setting || {};
  state.history[historyId] = {
    ...(state.history[historyId] || {}),
    id: historyId,
    run_id: historyId,
    setting_id: setting.id,
    user_id: setting.user_id,
    character_id: setting.character_id,
    scheduled_for: state.history[historyId] && state.history[historyId].scheduled_for,
    task_revision: snapshot.task_revision,
    setting_updated_at: snapshot.setting_updated_at,
    status: 'canceled',
    canceled_at: now,
    completed_at: now,
    reason: trimText(reason || 'task changed before delivery', 500)
  };
  saveNow();
}

function mergeRecentProactiveMessages(...sources) {
  const merged = [];
  const seen = new Set();
  sources.flat().filter(Boolean).forEach(item => {
    const record = typeof item === 'string' ? { content: item } : deepClone(item);
    const content = trimText(record && record.content, 1600).trim();
    if (!content) return;
    const key = content.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ ...record, content });
  });
  merged.sort((left, right) => Number(left.sent_at || left.timestamp || 0) - Number(right.sent_at || right.timestamp || 0));
  return merged.slice(-10);
}

function buildTaskReplacement(body, taskId, existingRaw) {
  const incomingSetting = sanitizeActiveSetting(body.setting || {});
  if (!incomingSetting.id) incomingSetting.id = trimText(taskId, 180);
  const incomingCharacter = deepClone(body.character || {});
  const incomingUpdatedAt = finiteTimestamp(incomingSetting.updated_at);
  const incomingFingerprints = taskFingerprints(incomingSetting, incomingCharacter);
  const existing = ensureTaskMetadata(existingRaw);

  if (existing && incomingUpdatedAt < finiteTimestamp(existing.setting_updated_at)) {
    return { task: existing, stale: true };
  }

  const now = Date.now();
  const existingRevision = existing ? Number(existing.task_revision) : 0;
  const settingChanged = !!existing && incomingFingerprints.setting !== existing.setting_fingerprint;
  const taskChanged = !existing || incomingFingerprints.task !== existing.task_fingerprint;
  const explicitNewVersion = !!existing && incomingUpdatedAt > finiteTimestamp(existing.setting_updated_at);
  const incomingLastSent = finiteTimestamp(incomingSetting.last_sent);
  const existingLastSent = finiteTimestamp(existing && existing.setting && existing.setting.last_sent);
  const laterIncomingRuntime = !!existing && incomingLastSent > existingLastSent;

  if (!existing) {
    if (!incomingSetting.next_run_at) incomingSetting.next_run_at = nextRun(incomingSetting, now);
  } else if (explicitNewVersion || settingChanged || laterIncomingRuntime) {
    incomingSetting.last_sent = Math.max(incomingLastSent, existingLastSent) || null;
    incomingSetting.next_run_at = nextRun(incomingSetting, now);
  } else {
    incomingSetting.last_sent = existing.setting.last_sent || incomingSetting.last_sent || null;
    incomingSetting.next_run_at = existing.setting.next_run_at || incomingSetting.next_run_at || nextRun(incomingSetting, now);
  }

  const revision = existing
    ? (explicitNewVersion || taskChanged ? existingRevision + 1 : existingRevision)
    : 1;
  const replacement = {
    ...(existing || {}),
    setting: incomingSetting,
    character: incomingCharacter,
    user: deepClone(body.user || {}),
    recent_memories: Array.isArray(body.recent_memories) ? deepClone(body.recent_memories.slice(0, 8)) : [],
    recent_messages: Array.isArray(body.recent_messages) ? deepClone(body.recent_messages.slice(-16)) : [],
    recent_proactive_messages: mergeRecentProactiveMessages(
      existing && existing.recent_proactive_messages || [],
      Array.isArray(body.recent_proactive_messages) ? body.recent_proactive_messages : []
    ),
    chat_summary: trimText(body.chat_summary, 1200),
    last_interaction_at: finiteTimestamp(body.last_interaction_at),
    random_characters: Array.isArray(body.random_characters) ? deepClone(body.random_characters.slice(0, 10)) : [],
    random_character: deepClone(body.random_character || null),
    task_revision: revision,
    task_fingerprint: incomingFingerprints.task,
    setting_fingerprint: incomingFingerprints.setting,
    setting_updated_at: incomingUpdatedAt,
    synced_at: now
  };
  return { task: replacement, stale: false };
}

function proactiveLog(step, detail) {
  console.log(`[ProactiveMessage] ${step}`, detail || '');
}

function currentTimeText(setting, currentTime) {
  const timezone = setting && setting.schedule && setting.schedule.timezone;
  const options = timezone && timezone !== 'local' ? { timeZone: timezone } : {};
  try {
    return new Date(currentTime || Date.now()).toLocaleString('zh-CN', {
      ...options,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_) {
    return new Date(currentTime || Date.now()).toLocaleString('zh-CN');
  }
}

function elapsedText(timestamp, now) {
  const elapsed = Number(now || Date.now()) - Number(timestamp || 0);
  if (!timestamp || !Number.isFinite(elapsed) || elapsed < 0) return '未知';
  if (elapsed < 60 * 1000) return '不到 1 分钟';
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / 60000)} 分钟`;
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)} 小时`;
  return `${Math.floor(elapsed / 86400000)} 天`;
}

function recentProactiveMessages(task) {
  const setting = task && task.setting || {};
  const userId = String(setting.user_id || '');
  const characterId = String(setting.character_id || '');
  const durable = Object.values(state.history).filter(item =>
    item && item.status === 'sent' && item.content &&
    String(item.user_id || '') === userId && String(item.character_id || '') === characterId
  ).map(item => ({
    content: item.content,
    sent_at: item.sent_at || item.completed_at || 0,
    generatedByFallback: !!item.generatedByFallback
  }));
  return mergeRecentProactiveMessages(task && task.recent_proactive_messages || [], durable);
}

function proactiveModeGuide(mode) {
  return ({
    greeting: '从此刻真实情境出发自然开口，不套用“早上好”“在吗”“今天过得怎么样”“记得休息”等固定问候。',
    memory: '从相关长期记忆中选择值得延续的一件事自然提起，不要说自己读取了 Memory。',
    time: '结合当前日期、星期与时段开启此刻才适合的话题，不编造天气、新闻或用户行程。',
    random: '带一点偶发地想起对方的感觉；可以由另一位角色触发联想，但绝不替其他角色发言。'
  })[mode] || '根据角色设定、当前时间和最近上下文自然开启一次私聊。';
}

function buildProactivePrompt(task, options) {
  const opts = options || {};
  const setting = task.setting || {};
  const character = task.character || {};
  const user = task.user || {};
  const userName = trimText(user.name || '用户', 80);
  const characterName = trimText(character.nickname || character.model || 'AI', 80);
  const memories = Array.isArray(task.recent_memories) ? task.recent_memories.slice(0, 8) : [];
  const messages = Array.isArray(task.recent_messages) ? task.recent_messages.slice(-16) : [];
  const proactive = Array.isArray(opts.recentProactiveMessages)
    ? opts.recentProactiveMessages.slice(-10)
    : recentProactiveMessages(task);
  const memoryText = memories.length
    ? memories.map(item => `- ${trimText(item.title, 100)}${item.title ? '：' : ''}${trimText(item.content || item.summary, 420)}`).join('\n')
    : '（没有可用的长期记忆）';
  const chatText = messages.length
    ? messages.map(item => `- ${item.role === 'user' ? userName : characterName}：${trimText(item.content, 650)}`).join('\n')
    : '（还没有最近对话）';
  const proactiveText = proactive.length
    ? proactive.map((item, index) => `${index + 1}. ${trimText(item.content || item, 650)}`).join('\n')
    : '（还没有发送过主动消息）';
  const interactionAt = Math.max(
    finiteTimestamp(task.last_interaction_at),
    ...messages.filter(item => item && item.source !== 'active_message').map(item => finiteTimestamp(item.timestamp))
  );
  const now = Number(opts.currentTime || Date.now());
  const randomPool = Array.isArray(task.random_characters) ? task.random_characters.filter(Boolean) : [];
  const randomCharacter = randomPool.length ? randomPool[Math.floor(Math.random() * randomPool.length)] : task.random_character;

  let system = trimText(character.systemPrompt, 50000);
  system += `${system ? '\n\n' : ''}你正在扮演角色「${characterName}」。以上原始设定定义了你的性格、经历与说话方式，必须完整保持。`;
  system += `\n你与${userName}的关系：${trimText(character.relationship || '尚未单独设定，请依据既有对话自然判断', 500)}。`;
  system += '\n这是一条由你自然发起的私聊。不要说明自己是 AI，不要提系统提示词、任务、定时器、主动消息或生成过程；不要输出 analysis、thinking、reasoning、工具、Memory 或 XML 标签；只输出最终正文。';

  const prompt = [
    '【角色姓名】', characterName,
    '', '【角色原始设定 / 性格 / 说话方式】', '已完整放在 system 消息中；必须保持其全部约束。',
    '', '【用户与角色关系】', character.relationship || '尚未单独设定，请依据既有对话自然判断',
    '', '【当前日期和时间】', currentTimeText(setting, now),
    '', '【距离上次聊天】', elapsedText(interactionAt, now),
    '', '【最近聊天摘要】', trimText(task.chat_summary || '（暂无摘要）', 1200),
    '', '【最近聊天内容】', chatText,
    '', '【相关长期记忆】', memoryText,
    '', '【最近已经发送过的主动消息】', proactiveText,
    '', '【本次主动消息目的】', proactiveModeGuide(setting.message_type),
    '', '【用户附加要求】', trimText(setting.custom_instruction || setting.customInstruction || '（无）', 500)
  ];
  if (randomCharacter) prompt.push('', '【可选联想角色】', `${trimText(randomCharacter.name, 80)}。只能把这当作话题灵感，不能替 TA 发言。`);
  if (opts.retryInstruction) prompt.push('', '【重新生成要求】', trimText(opts.retryInstruction, 1000));
  prompt.push(
    '',
    `请主动向${userName}发送一条自然、具体、符合角色原作语气的消息。严格要求：`,
    '1. 长度为 1 至 4 个自然段。',
    '2. 不要总以“早上好”“在吗”“今天过得怎么样”等统一问候开头。',
    '3. 根据当前时段、最近聊天与记忆选择这一次独有的内容。',
    '4. 避免与最近主动消息相同的开头、话题、句式、问候或近义复述。',
    '5. 可以延续之前的话题，也可以自然开启新话题。',
    '6. 不要复读最近回复，只输出最终可见正文。'
  );

  return {
    system,
    messages: [{ role: 'user', content: prompt.join('\n') }],
    recentProactiveMessages: proactive
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      return part && (part.text || part.content) || '';
    }).join('');
  }
  return content == null ? '' : String(content);
}

/* Native reasoning fields are authoritative; tag parsing exists only for legacy relays/models. */
function responseParts(content, nativeReasoning) {
  let text = contentText(content);
  const native = contentText(nativeReasoning);
  if (native.trim()) return { content: text, reasoning_content: native };

  let thinking = '';
  const leadingClose = text.match(/^\s*<\/think(?:ing)?>\s*/i);
  if (leadingClose) {
    text = text.slice(leadingClose[0].length);
    const orphanClose = text.match(/<\/think(?:ing)?>/i);
    if (orphanClose && text.slice(orphanClose.index + orphanClose[0].length).trim()) {
      thinking = text.slice(0, orphanClose.index).replace(/^\s*(?:思考|thinking)\s*[:：]\s*/i, '').trim();
      text = text.slice(orphanClose.index + orphanClose[0].length);
    }
  }
  const opening = text.match(/^\s*<think(?:ing)?>/i);
  if (opening) {
    const rest = text.slice(opening[0].length);
    const closing = rest.match(/<\/think(?:ing)?>/i);
    if (closing) {
      thinking = rest.slice(0, closing.index).trim();
      text = rest.slice(closing.index + closing[0].length);
    } else {
      const splitAt = rest.search(/\n\s*\n/);
      if (splitAt > 0) {
        thinking = rest.slice(0, splitAt).trim();
        text = rest.slice(splitAt);
      } else {
        text = rest;
      }
    }
  }
  return { content: text.trim(), reasoning_content: thinking };
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (_) {
      if (!response.ok) throw new Error(`${response.status}: ${trimText(raw, 1200)}`);
      throw new Error('API returned a non-JSON response');
    }
    if (!response.ok) {
      const detail = parsed && parsed.error
        ? (parsed.error.message || JSON.stringify(parsed.error))
        : raw;
      const error = new Error(`${response.status}: ${trimText(detail, 1200)}`);
      error.status = response.status;
      throw error;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function callCharacterModel(task, preparedPrompt) {
  const character = task.character || {};
  if (!character.apiKey || !character.endpoint || !character.model) {
    throw new Error('Character API configuration is incomplete');
  }
  const prompt = preparedPrompt || buildProactivePrompt(task);
  const provider = String(character.provider || 'custom').toLowerCase();

  if (provider === 'anthropic') {
    const body = {
      model: character.model,
      max_tokens: 512,
      system: prompt.system,
      messages: prompt.messages
    };
    if (Number.isFinite(Number(character.temperature))) body.temperature = Number(character.temperature);
    const data = await fetchJson(character.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': character.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const blocks = Array.isArray(data.content) ? data.content : [];
    return responseParts(
      blocks.filter(block => block && block.type === 'text').map(block => block.text || '').join(''),
      blocks.filter(block => block && block.type === 'thinking').map(block => block.thinking || block.text || '').join('\n')
    );
  }

  if (provider === 'gemini') {
    let endpoint = String(character.endpoint);
    endpoint = endpoint.includes('{model}')
      ? endpoint.replace('{model}', encodeURIComponent(character.model))
      : endpoint;
    const url = new URL(endpoint);
    if (!url.searchParams.has('key')) url.searchParams.set('key', character.apiKey);
    const body = {
      system_instruction: { parts: [{ text: prompt.system }] },
      contents: prompt.messages.map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      })),
      generationConfig: { maxOutputTokens: 512 }
    };
    if (Number.isFinite(Number(character.temperature))) body.generationConfig.temperature = Number(character.temperature);
    const data = await fetchJson(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const candidate = data.candidates && data.candidates[0] || {};
    const parts = candidate.content && candidate.content.parts || [];
    return responseParts(
      parts.filter(part => !part.thought).map(part => part.text || '').join(''),
      parts.filter(part => part.thought).map(part => part.text || '').join('\n')
    );
  }

  const baseMessages = [{ role: 'system', content: prompt.system }, ...prompt.messages];
  const body = {
    model: character.model,
    messages: baseMessages,
    max_tokens: 512
  };
  if (Number.isFinite(Number(character.temperature))) body.temperature = Number(character.temperature);
  const request = tokenParam => {
    const payload = { ...body };
    if (tokenParam === 'max_completion_tokens') {
      delete payload.max_tokens;
      payload.max_completion_tokens = 512;
    }
    return fetchJson(character.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${character.apiKey}`
      },
      body: JSON.stringify(payload)
    });
  };

  let data;
  try {
    data = await request('max_tokens');
  } catch (error) {
    if (/max_completion_tokens/i.test(String(error.message)) && /max_tokens|unsupported|not supported/i.test(String(error.message))) {
      data = await request('max_completion_tokens');
    } else {
      throw error;
    }
  }
  const choice = data.choices && data.choices[0] || {};
  const message = choice.message || {};
  return responseParts(message.content, message.reasoning_content || message.reasoning || message.analysis || message.thinking || '');
}

function visibleProactiveReply(output) {
  let text = contentText(output && output.content).trim();
  /* Native reasoning was already separated by the provider adapter. Tag removal is only a
   * compatibility fallback for legacy relays that incorrectly place reasoning in content. */
  text = text.replace(/<(?:think|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis)>/gi, '').trim();
  text = text.replace(/^\s*<\/(?:think|thinking|analysis)>\s*/i, '').trim();
  return text;
}

function proactiveTextKey(value) {
  return String(value || '').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function proactiveTextSimilarity(left, right) {
  const a = proactiveTextKey(left);
  const b = proactiveTextKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = value => {
    if (value.length < 2) return [value];
    const out = [];
    for (let index = 0; index < value.length - 1; index += 1) out.push(value.slice(index, index + 2));
    return out;
  };
  const pool = new Map();
  grams(a).forEach(gram => pool.set(gram, (pool.get(gram) || 0) + 1));
  let overlap = 0;
  const bGrams = grams(b);
  bGrams.forEach(gram => {
    const count = pool.get(gram) || 0;
    if (!count) return;
    overlap += 1;
    pool.set(gram, count - 1);
  });
  return 2 * overlap / (grams(a).length + bGrams.length);
}

function validateProactiveReply(content, recent) {
  const text = String(content || '').trim();
  const key = proactiveTextKey(text);
  if (!key) return { ok: false, reason: '模型返回空内容或只有标点' };
  if (/<\/?(?:think|thinking|analysis|reasoning)\b/i.test(text) ||
      /^\s*(?:analysis|thinking|reasoning|思考)\s*[:：]/i.test(text)) {
    return { ok: false, reason: '模型返回了 thinking 或 analysis，而不是纯最终正文' };
  }
  const rows = Array.isArray(recent) ? recent : [];
  for (const item of rows) {
    const old = String(item && item.content != null ? item.content : item || '').trim();
    if (!old) continue;
    const similarity = proactiveTextSimilarity(text, old);
    if (similarity >= PROACTIVE_SIMILARITY_LIMIT) {
      return { ok: false, reason: `与最近主动消息相似度过高（${Math.round(similarity * 100)}%）` };
    }
    const opening = key.slice(0, 12);
    if (opening.length >= 8 && proactiveTextKey(old).startsWith(opening)) {
      return { ok: false, reason: '与最近主动消息使用了相同开头' };
    }
  }
  return { ok: true, reason: '' };
}

function proactiveFallbackMessage(character, recent, currentTime) {
  const profile = `${character && character.nickname || ''} ${character && character.systemPrompt || ''}`.toLocaleLowerCase();
  const hour = new Date(currentTime || Date.now()).getHours();
  const timeWord = hour < 6 ? '这个安静得过分的时刻' : hour < 12 ? '上午这段时间' : hour < 18 ? '午后' : '今晚';
  let variants;
  if (/(活泼|元气|开朗|歌|音乐|陪伴|可爱)/u.test(profile)) {
    variants = [`${timeWord}忽然冒出一个想和你分享的小念头。等你有空时，来告诉我此刻最想听见什么吧。`, `我刚刚想到你啦——${timeWord}有没有哪件小事，让你忍不住想哼两句？`];
  } else if (/(研究|学者|实验|理性|高傲|冷静|科学)/u.test(profile)) {
    variants = [`${timeWord}我想到一个值得观察的问题：最近有什么细节，悄悄改变了你的判断？`, `我暂时从手边的思绪里分出一点注意力给你。若要记录${timeWord}最有价值的一个发现，你会选什么？`];
  } else if (/(安静|疏离|故事|温和|沉静|寡言)/u.test(profile)) {
    variants = [`${timeWord}很安静，我便想起了你。若你愿意，可以把今天尚未说完的一小段故事留在这里。`, `有些话不必急着说完。${timeWord}如果你正好想找个人听，我在。`];
  } else {
    variants = [`${timeWord}我忽然想起了你。等你有空，告诉我最近最值得记住的一件小事吧。`, `刚才有个念头拐到了你这里。${timeWord}你若想聊点什么，我愿意听。`];
  }
  const recentKeys = new Set((recent || []).map(item => proactiveTextKey(item && item.content || item)));
  return variants.find(item => !recentKeys.has(proactiveTextKey(item))) || variants[0];
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function generateProactiveMessage(task, options) {
  const opts = options || {};
  const character = task.character || {};
  const setting = task.setting || {};
  const recent = recentProactiveMessages(task);
  const currentTime = Number(opts.currentTime || Date.now());
  let lastError = null;
  let retryInstruction = '';
  for (let attempt = 1; attempt <= PROACTIVE_MAX_ATTEMPTS; attempt += 1) {
    const preparedPrompt = buildProactivePrompt(task, {
      currentTime,
      recentProactiveMessages: recent,
      retryInstruction
    });
    proactiveLog('requesting model', {
      taskId: setting.id || '',
      characterId: character.id || setting.character_id || '',
      provider: character.provider || 'custom',
      model: character.model || '',
      attempt
    });
    try {
      const output = await callCharacterModel(task, preparedPrompt);
      const content = visibleProactiveReply(output);
      const check = validateProactiveReply(content, recent);
      if (check.ok) {
        proactiveLog('generated successfully', {
          taskId: setting.id || '',
          characterId: character.id || setting.character_id || '',
          provider: character.provider || 'custom',
          model: character.model || '',
          attempt
        });
        return {
          content,
          reasoning_content: '',
          generatedByFallback: false,
          generationAttempts: attempt,
          provider: character.provider || 'custom',
          model: character.model || ''
        };
      }
      lastError = new Error(check.reason);
      retryInstruction = `${check.reason}。上一条被拒绝的正文是：${trimText(content, 600)}。请换一个开头、话题和句式，完整重写，不要解释原因。`;
    } catch (error) {
      lastError = error;
      retryInstruction = '上一次模型调用失败或没有产生可用正文。请重新生成，只返回最终消息。';
      console.warn('[ProactiveMessage] model attempt failed', {
        taskId: setting.id || '',
        characterId: character.id || setting.character_id || '',
        provider: character.provider || 'custom',
        model: character.model || '',
        attempt,
        error: trimText(error && error.message || error, 300)
      });
    }
    if (attempt < PROACTIVE_MAX_ATTEMPTS) await delay(250 * attempt);
  }
  const generationError = trimText(lastError && lastError.message || lastError || 'unknown', 500);
  console.warn('[ProactiveMessage] using fallback after model attempts failed', {
    taskId: setting.id || '',
    characterId: character.id || setting.character_id || '',
    provider: character.provider || 'custom',
    model: character.model || '',
    error: generationError
  });
  return {
    content: proactiveFallbackMessage(character, recent, currentTime),
    reasoning_content: '',
    generatedByFallback: true,
    generationAttempts: PROACTIVE_MAX_ATTEMPTS,
    generationError,
    provider: character.provider || 'custom',
    model: character.model || ''
  };
}

function windowsNotify(title, body) {
  if (process.platform !== 'win32' || process.env.IB_ACTIVE_DISABLE_NOTIFICATIONS === '1') return;
  const quote = value => String(value || '').replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$n=New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon=[System.Drawing.SystemIcons]::Information',
    `$n.BalloonTipTitle='${quote(trimText(title, 64))}'`,
    `$n.BalloonTipText='${quote(trimText(body, 220))}'`,
    '$n.Visible=$true',
    '$n.ShowBalloonTip(7000)',
    'Start-Sleep -Seconds 8',
    '$n.Dispose()'
  ].join(';');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    }).unref();
  } catch (_) {
    // The message remains in the durable queue even if an OS notification fails.
  }
}

function adaptiveSkipReason(task) {
  const setting = task && task.setting || {};
  if (!setting.adaptive_enabled) return '';
  const messages = Array.isArray(task.recent_messages) ? task.recent_messages : [];
  const users = messages
    .filter(message => message && message.role === 'user' && Number(message.timestamp))
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  if (!users.length) return '';
  const elapsed = Date.now() - Number(users[0].timestamp);
  return elapsed >= 0 && elapsed < 12 * 3600000
    ? '最近 12 小时内刚互动过，本次计划已顺延'
    : '';
}

async function executeTask(taskId, scheduledFor) {
  const rawTask = state.tasks[taskId];
  if (!rawTask) return;
  const preparedTask = ensureTaskMetadata(rawTask);
  if (preparedTask !== rawTask) state.tasks[taskId] = preparedTask;
  const task = deepClone(preparedTask);
  const setting = task.setting || {};
  const userId = String(setting.user_id || '');
  if (!userId || !armedUsers.has(userId) || !setting.enabled || !setting.background_enabled) return;
  const character = task.character || {};
  proactiveLog('task triggered', { taskId, characterId: setting.character_id || '', scheduledFor });
  proactiveLog('character loaded', { taskId, characterId: character.id || setting.character_id || '', name: character.nickname || character.model || 'AI' });
  proactiveLog('provider/model selected', { taskId, characterId: character.id || setting.character_id || '', apiConfigId: character.id || setting.character_id || '', provider: character.provider || 'custom', model: character.model || '' });
  proactiveLog('memories loaded', { taskId, characterId: character.id || setting.character_id || '', count: Array.isArray(task.recent_memories) ? task.recent_memories.length : 0 });
  const id = runId(taskId, scheduledFor);
  const previous = state.history[id];
  if (terminalRun(previous, task.task_revision)) {
    if (Number(setting.next_run_at) <= scheduledFor) {
      const currentCheck = currentForRun(taskId, task);
      if (currentCheck.current) {
        const next = nextRun(currentCheck.current.setting, Date.now() + 1000);
        replaceTaskRuntime(taskId, currentCheck.current, { next_run_at: next });
        queueSave();
      }
    }
    return;
  }
  if (previous && previous.status === 'processing' && sameRunRevision(previous, task.task_revision) &&
      Date.now() - Number(previous.started_at || 0) < 5 * 60000) return;

  state.history[id] = {
    ...(previous || {}),
    id,
    run_id: id,
    setting_id: taskId,
    user_id: userId,
    character_id: setting.character_id,
    scheduled_for: scheduledFor,
    task_revision: task.task_revision,
    setting_updated_at: task.setting_updated_at,
    status: 'processing',
    started_at: Date.now(),
    attempts: Number(previous && previous.attempts || 0) + 1
  };
  saveNow();

  const characterName = task.character && (task.character.nickname || task.character.model) || 'AI';
  const skipReason = adaptiveSkipReason(task);
  if (skipReason) {
    const currentCheck = currentForRun(taskId, task);
    if (!currentCheck.current) {
      cancelRun(id, task, currentCheck.reason);
      return;
    }
    const skippedAt = Date.now();
    const next = nextRun({ ...currentCheck.current.setting }, skippedAt + 1000);
    replaceTaskRuntime(taskId, currentCheck.current, { next_run_at: next });
    const event = {
      id: `event_${id}`,
      run_id: id,
      setting_id: taskId,
      user_id: userId,
      character_id: setting.character_id,
      character_name: characterName,
      scheduled_for: scheduledFor,
      sent_at: skippedAt,
      next_run_at: next,
      task_revision: task.task_revision,
      setting_updated_at: task.setting_updated_at,
      status: 'skipped',
      reason: skipReason,
      acknowledged: false
    };
    state.history[id] = { ...state.history[id], ...event };
    state.events[event.id] = event;
    saveNow();
    console.log(`[Active] ${event.character_name} was postponed because the conversation was recently active.`);
    return;
  }

  let output = null;
  let callError = null;
  try {
    output = await generateProactiveMessage(task, { currentTime: Date.now() });
    if (!String(output && output.content || '').trim()) throw new Error('Model returned no final message');
  } catch (error) {
    callError = error;
  }

  const currentCheck = currentForRun(taskId, task);
  if (!currentCheck.current) {
    cancelRun(id, task, currentCheck.reason);
    console.log(`[Active] Discarded an obsolete result for ${characterName}: ${currentCheck.reason}`);
    return;
  }

  if (callError) {
    const failedAt = Date.now();
    const next = nextRun({ ...currentCheck.current.setting }, failedAt + 1000);
    replaceTaskRuntime(taskId, currentCheck.current, { next_run_at: next });
    const event = {
      id: `event_${id}`,
      run_id: id,
      setting_id: taskId,
      user_id: userId,
      character_id: setting.character_id,
      character_name: characterName,
      scheduled_for: scheduledFor,
      sent_at: failedAt,
      next_run_at: next,
      task_revision: task.task_revision,
      setting_updated_at: task.setting_updated_at,
      status: 'failed',
      error: trimText(callError && callError.message || callError, 1400),
      acknowledged: false
    };
    state.history[id] = { ...state.history[id], ...event };
    state.events[event.id] = event;
    saveNow();
    console.error(`[Active] Scheduled message failed for ${event.character_name}: ${event.error}`);
    return;
  }

  const content = String(output.content || '').trim();
  const sentAt = Date.now();
  const settingAfterSend = { ...currentCheck.current.setting, last_sent: sentAt };
  const next = nextRun(settingAfterSend, sentAt + 1000);
  const updatedTask = replaceTaskRuntime(taskId, currentCheck.current, { last_sent: sentAt, next_run_at: next });
  updatedTask.recent_proactive_messages = mergeRecentProactiveMessages(
    currentCheck.current.recent_proactive_messages || [],
    [{ content, sent_at: sentAt, generatedByFallback: !!output.generatedByFallback }]
  );
  state.tasks[taskId] = updatedTask;
  const event = {
    id: `event_${id}`,
    run_id: id,
    setting_id: taskId,
    user_id: userId,
    character_id: setting.character_id,
    character_name: characterName,
    provider: task.character && task.character.provider || '',
    model: task.character && task.character.model || '',
    showThinking: false,
    scheduled_for: scheduledFor,
    sent_at: sentAt,
    next_run_at: next,
    message_id: messageId(taskId, scheduledFor),
    task_revision: task.task_revision,
    setting_updated_at: task.setting_updated_at,
    status: 'sent',
    content,
    reasoning_content: '',
    generatedByFallback: !!output.generatedByFallback,
    generation_attempts: Number(output.generationAttempts || 1),
    generation_error: trimText(output.generationError || '', 500),
    acknowledged: false
  };
  state.history[id] = { ...state.history[id], ...event };
  state.events[event.id] = event;
  saveNow(); // persist the queue before showing an OS notification
  windowsNotify(event.character_name, content);
  proactiveLog('message saved', { taskId, characterId: setting.character_id || '', messageId: event.message_id, provider: event.provider, model: event.model, generatedByFallback: event.generatedByFallback });
  console.log(`[Active] ${event.character_name} sent a scheduled message at ${new Date(sentAt).toLocaleString()}`);
}

async function schedulerTick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const ids = Object.keys(state.tasks);
    for (const id of ids) {
      const rawTask = state.tasks[id];
      let task = ensureTaskMetadata(rawTask);
      if (task && task !== rawTask) state.tasks[id] = task;
      let setting = task && task.setting;
      if (!setting || !setting.enabled || !setting.background_enabled) continue;
      const userId = String(setting.user_id || '');
      if (!userId || !armedUsers.has(userId)) continue;
      if (!setting.next_run_at) {
        const next = nextRun(setting, now);
        task = replaceTaskRuntime(id, task, { next_run_at: next });
        setting = task.setting;
      }
      if (Number(setting.next_run_at) <= now + 500) {
        await executeTask(id, Number(setting.next_run_at));
      }
    }
    const historyIds = Object.keys(state.history).sort((a, b) =>
      Number(state.history[b].sent_at || state.history[b].started_at || 0) -
      Number(state.history[a].sent_at || state.history[a].started_at || 0));
    let retainedHistory = historyIds.length;
    for (let index = historyIds.length - 1; index >= 0 && retainedHistory > 1000; index -= 1) {
      const historyId = historyIds[index];
      if (state.history[historyId] && state.history[historyId].status === 'processing') continue;
      delete state.history[historyId];
      retainedHistory -= 1;
    }
    queueSave();
  } finally {
    ticking = false;
  }
}

function originAllowed(origin) {
  return !origin || origin === 'null' || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin);
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (!originAllowed(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin || 'null');
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  return true;
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function publicTask(task) {
  const setting = task && task.setting || {};
  const character = task && task.character || {};
  return {
    id: setting.id,
    character_id: setting.character_id,
    character_name: character.nickname || character.model || 'AI',
    enabled: !!setting.enabled,
    next_run_at: setting.next_run_at || null,
    last_sent: setting.last_sent || null,
    task_revision: task && task.task_revision || 1,
    setting_updated_at: task && task.setting_updated_at || finiteTimestamp(setting.updated_at)
  };
}

const server = http.createServer(async (request, response) => {
  if (!applyCors(request, response)) {
    json(response, 403, { error: 'Origin is not allowed' });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, {
        ok: true,
        service: 'internal-beyond-active-messages',
        version: 2,
        tasks: Object.keys(state.tasks).length,
        pending_events: Object.values(state.events).filter(event => !event.acknowledged).length,
        armed_users: armedUsers.size,
        now: Date.now()
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/tasks') {
      const userId = String(url.searchParams.get('user_id') || '');
      if (!userId) {
        json(response, 400, { error: 'user_id is required' });
        return;
      }
      json(response, 200, {
        tasks: Object.values(state.tasks)
          .filter(task => String(task && task.setting && task.setting.user_id || '') === userId)
          .map(publicTask)
      });
      return;
    }
    if (request.method === 'PUT' && parts[0] === 'tasks' && parts[1]) {
      const taskId = decodeURIComponent(parts.slice(1).join('/'));
      const body = await readBody(request);
      if (!body || !body.setting || body.setting.id !== taskId || !body.setting.user_id || !body.character) {
        json(response, 400, { error: 'Invalid task snapshot' });
        return;
      }
      const existingOwner = String(state.tasks[taskId] && state.tasks[taskId].setting && state.tasks[taskId].setting.user_id || '');
      const incomingOwner = String(body.setting.user_id || '');
      if (existingOwner && existingOwner !== incomingOwner) {
        json(response, 403, { error: 'Task does not belong to this user' });
        return;
      }
      const built = buildTaskReplacement(body, taskId, state.tasks[taskId]);
      state.tasks[taskId] = built.task;
      saveNow();
      json(response, 200, { ok: true, stale: built.stale, task: publicTask(state.tasks[taskId]) });
      return;
    }
    if (request.method === 'DELETE' && parts[0] === 'tasks' && parts[1]) {
      const taskId = decodeURIComponent(parts.slice(1).join('/'));
      const userId = String(url.searchParams.get('user_id') || '');
      if (!userId) {
        json(response, 400, { error: 'user_id is required' });
        return;
      }
      const existing = state.tasks[taskId];
      if (existing && String(existing.setting && existing.setting.user_id || '') !== userId) {
        json(response, 403, { error: 'Task does not belong to this user' });
        return;
      }
      if (existing) {
        delete state.tasks[taskId];
        saveNow();
      }
      json(response, 200, { ok: true, missing: !existing });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/reconcile') {
      const body = await readBody(request);
      const userId = String(body && body.user_id || '');
      const keep = new Set(Array.isArray(body && body.task_ids) ? body.task_ids.map(String) : []);
      if (!userId) {
        json(response, 400, { error: 'user_id is required' });
        return;
      }
      let removed = 0;
      Object.keys(state.tasks).forEach(taskId => {
        const taskUser = String(state.tasks[taskId] && state.tasks[taskId].setting && state.tasks[taskId].setting.user_id || '');
        if (taskUser === userId && !keep.has(taskId)) {
          delete state.tasks[taskId];
          removed += 1;
        }
      });
      if (removed) saveNow();
      /* Arming is intentionally last and process-local: a failed reconcile never enables scheduling. */
      armedUsers.add(userId);
      json(response, 200, { ok: true, removed, armed: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      const userId = String(url.searchParams.get('user_id') || '');
      if (!userId) {
        json(response, 400, { error: 'user_id is required' });
        return;
      }
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
      const events = Object.values(state.events)
        .filter(event => !event.acknowledged && recordUserId(event) === userId)
        .sort((a, b) => Number(a.sent_at || 0) - Number(b.sent_at || 0))
        .slice(0, limit);
      json(response, 200, { events });
      return;
    }
    if (request.method === 'POST' && parts[0] === 'events' && parts[1] && parts[2] === 'ack') {
      const eventId = decodeURIComponent(parts[1]);
      const body = await readBody(request);
      const userId = String(body && body.user_id || '');
      if (!userId) {
        json(response, 400, { error: 'user_id is required' });
        return;
      }
      const event = state.events[eventId];
      if (event && recordUserId(event) !== userId) {
        json(response, 403, { error: 'Event does not belong to this user' });
        return;
      }
      if (event) {
        const acknowledgedAt = Date.now();
        event.acknowledged = true;
        event.acknowledged_at = acknowledgedAt;
        if (event.run_id && state.history[event.run_id] && recordUserId(state.history[event.run_id]) === userId) {
          state.history[event.run_id] = {
            ...state.history[event.run_id],
            acknowledged: true,
            acknowledged_at: acknowledgedAt
          };
        }
        delete state.events[eventId];
        queueSave();
      }
      json(response, 200, { ok: true, missing: !event });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/history') {
      const userId = String(url.searchParams.get('user_id') || '');
      if (!userId) {
        json(response, 400, { error: 'user_id is required' });
        return;
      }
      const history = Object.values(state.history)
        .filter(item => recordUserId(item) === userId)
        .sort((a, b) => Number(b.sent_at || b.started_at || 0) - Number(a.sent_at || a.started_at || 0))
        .slice(0, 200)
        .map(item => ({ ...item, reasoning_content: item.reasoning_content ? '[stored]' : '' }));
      json(response, 200, { history });
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/history') {
      const userId = String(url.searchParams.get('user_id') || '');
      if (!userId) {
        json(response, 400, { error: 'user_id is required' });
        return;
      }
      const removable = new Set();
      let removedHistory = 0;
      Object.keys(state.history).forEach(historyId => {
        const item = state.history[historyId];
        if (recordUserId(item) !== userId || item.status === 'processing') return;
        removable.add(historyId);
        delete state.history[historyId];
        removedHistory += 1;
      });
      let removedEvents = 0;
      Object.keys(state.events).forEach(eventId => {
        const event = state.events[eventId];
        if (recordUserId(event) !== userId) return;
        /* Clearing delivery history also discards its queued delivery receipt, preventing it from reappearing. */
        if (event.acknowledged || removable.has(event.run_id)) {
          delete state.events[eventId];
          removedEvents += 1;
        }
      });
      if (removedHistory || removedEvents) saveNow();
      json(response, 200, { ok: true, removed_history: removedHistory, removed_events: removedEvents });
      return;
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) {
    json(response, 500, { error: trimText(error && error.message || error, 1200) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('Internal Beyond Active Messages companion is running.');
  console.log(`Listening: http://${HOST}:${PORT}`);
  console.log(`State:     ${DATA_FILE}`);
  console.log('');
  console.log('Keep this window open for schedules to run after the browser closes.');
  console.log('After each service restart, open Internal Beyond once so it can reconcile and arm your schedules.');
  console.log('Only plans explicitly marked "浏览器关闭后继续运行" are synced here.');
  console.log('The local state file contains the API credentials required by those plans.');
  console.log('');
});

let schedulerInterval = null;
let schedulerStartTimer = null;
/* No interval exists before the startup grace period, and schedulerTick also requires an armed user. */
schedulerStartTimer = setTimeout(() => {
  schedulerStartTimer = null;
  schedulerTick().catch(error => console.error('[Active] Scheduler tick failed:', error.message));
  schedulerInterval = setInterval(() => {
    schedulerTick().catch(error => console.error('[Active] Scheduler tick failed:', error.message));
  }, 15000);
}, START_DELAY_MS);

function shutdown() {
  if (schedulerStartTimer) clearTimeout(schedulerStartTimer);
  if (schedulerInterval) clearInterval(schedulerInterval);
  try {
    if (saveQueued) saveNow();
    else saveNow();
  } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
