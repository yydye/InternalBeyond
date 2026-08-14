/* IB Active · 计划域：调度计算（nextRun / 免打扰）、setting 与 AI 计划净化器、
   指纹 / 任务元数据 / 任务运行时替换与取消。从 active-message-service.js 提取为工厂。
   state 由 composition root 持有（测试钩子会重新赋值），所有读写经注入的 getState()；
   armedUsers 集合与 saveNow 亦注入。原逻辑逐字不变。 */
'use strict';

const crypto = require('crypto');

function createPlanDomain(deps) {
  const getState = deps.getState;
  const armedUsers = deps.armedUsers;
  const saveNow = deps.saveNow;

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

  /* ══════════ AI-PLANNED PROACTIVE MESSAGES (companion side) ══════════
     The browser plans after each chat round; this service executes due plans when
     the browser is closed. The same state machine and limits apply here so both
     executors behave identically. Plans are synced via PUT /plans/:id. */
  const PLAN_MIN_DELAY_MS = 5 * 60 * 1000;
  const PLAN_MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
  const PLAN_MAX_LATE_MS = 30 * 60 * 1000;
  const PLAN_DEFAULT_MAX_ATTEMPTS = 2;
  const PLAN_STATUSES = ['scheduled', 'evaluating', 'sending', 'waiting_for_user', 'completed', 'cancelled', 'expired', 'failed'];

  function sanitizeAiPlan(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const cc = source.cancelConditions && typeof source.cancelConditions === 'object' ? source.cancelConditions : {};
    const cs = source.constraints && typeof source.constraints === 'object' ? source.constraints : {};
    const prefs = source.prefs && typeof source.prefs === 'object' ? source.prefs : {};
    /* 时间/标识字段仅做长度截断（不改写语义）：非法/未来值由 PUT stale 与 executedLock
       在服务端权威边界拒绝，避免“替换为当前时间”使非法快照获得新时间戳从而绕过 stale 判定 */
    return {
      id: trimText(source.id, 180),
      characterId: trimText(source.characterId || source.character_id, 180),
      user_id: trimText(source.user_id || source.userId, 180),
      type: source.type === 'hard_reminder' ? 'hard_reminder' : 'proactive_chat',
      status: PLAN_STATUSES.includes(source.status) ? source.status : 'scheduled',
      source: source.source === 'user_reminder' ? 'user_reminder' : 'ai_planned',
      createdAt: trimText(source.createdAt || source.created_at || new Date().toISOString(), 40),
      updatedAt: trimText(source.updatedAt || source.updated_at || new Date().toISOString(), 40),
      scheduledAt: trimText(source.scheduledAt || source.scheduled_at || '', 40),
      intent: trimText(source.intent, 200),
      reason: trimText(source.reason, 300),
      cancelConditions: {
        cancelIfUserReplies: cc.cancelIfUserReplies != null ? !!cc.cancelIfUserReplies : true,
        cancelIfIntentResolved: !!cc.cancelIfIntentResolved,
        cancelIfNewerPlanExists: cc.cancelIfNewerPlanExists !== false,
        respectDoNotDisturb: cc.respectDoNotDisturb !== false
      },
      constraints: {
        maxAttempts: Math.max(1, Math.min(5, Number(cs.maxAttempts) || PLAN_DEFAULT_MAX_ATTEMPTS)),
        allowReschedule: cs.allowReschedule != null ? !!cs.allowReschedule : true,
        allowFollowUpPlan: !!cs.allowFollowUpPlan
      },
      attemptCount: Math.max(0, Number(source.attemptCount) || 0),
      executionId: source.executionId ? trimText(source.executionId, 120) : null,
      claimedAt: source.claimedAt == null ? null : (typeof source.claimedAt === 'number' ? source.claimedAt : trimText(source.claimedAt, 40)),
      sourceConversationId: trimText(source.sourceConversationId, 180),
      sourceMessageId: trimText(source.sourceMessageId, 180),
      lastError: source.lastError || null,
      executedAt: source.executedAt == null ? null : (typeof source.executedAt === 'number' ? source.executedAt : trimText(source.executedAt, 40)),
      cancelledAt: source.cancelledAt == null ? null : (typeof source.cancelledAt === 'number' ? source.cancelledAt : trimText(source.cancelledAt, 40)),
      cancelReason: trimText(source.cancelReason, 300),
      prefs: {
        enabled: prefs.enabled !== false,
        mode: ['fixed', 'ai', 'hybrid'].includes(prefs.mode) ? prefs.mode : 'ai',
        minIntervalMinutes: Math.max(5, Math.min(1440, Number(prefs.minIntervalMinutes) || 30)),
        maxPlanHours: Math.max(1, Math.min(720, Number(prefs.maxPlanHours) || 168)),
        maxConsecutive: Math.max(1, Math.min(5, Number(prefs.maxConsecutive) || 1)),
        dndStart: trimText(prefs.dndStart || '23:00', 5),
        dndEnd: trimText(prefs.dndEnd || '08:00', 5),
        cancelIfUserReplies: prefs.cancelIfUserReplies !== false,
        allowReschedule: prefs.allowReschedule !== false
      }
    };
  }

  function parsePlanJson(text) {
    let s = String(text || '').trim();
    if (!s) return null;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1] && fence[1].trim()) s = fence[1].trim();
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
  }

  function isInDnd(nowMs, prefs) {
    const p = prefs || {};
    const d = new Date(nowMs || Date.now());
    const hm = d.getHours() * 60 + d.getMinutes();
    const toMin = t => {
      const a = String(t || '23:00').split(':');
      return (Math.max(0, Math.min(23, parseInt(a[0], 10) || 0)) * 60 + Math.max(0, Math.min(59, parseInt(a[1], 10) || 0)));
    };
    const s = toMin(p.dndStart), e = toMin(p.dndEnd);
    if (s === e) return false;
    return s < e ? hm >= s && hm < e : hm >= s || hm < e;
  }

  function nextDndFree(nowMs, prefs) {
    const now = new Date(nowMs || Date.now()).getTime();
    let probe = now;
    for (let i = 0; i < 96; i++) {
      if (!isInDnd(probe, prefs)) return probe;
      probe += 15 * 60 * 1000;
    }
    return now + 12 * 3600000;
  }

  function planRunId(planId, ts) {
    return `plan_run_${safePart(planId)}_${Math.floor(Number(ts) || 0)}`;
  }
  function planMessageId(planId, ts) {
    return `active_msg_${safePart(planId)}_${Math.floor(Number(ts) || 0)}`;
  }
  function publicPlan(plan) {
    return {
      id: plan && plan.id || '',
      character_id: plan && plan.characterId || '',
      status: plan && plan.status || 'scheduled',
      scheduled_at: plan && plan.scheduledAt || null,
      intent: plan && plan.intent || '',
      source: plan && plan.source || 'ai_planned',
      updated_at: plan && plan.updatedAt || null
    };
  }
  /* 构造与计划匹配的最小 setting 形状，供现有生成链路复用 */
  function settingFromPlan(plan) {
    return {
      id: plan.id,
      user_id: plan.user_id || '',
      character_id: plan.characterId,
      enabled: plan.status === 'scheduled' || plan.status === 'waiting_for_user',
      background_enabled: true,
      adaptive_enabled: false,
      frequency: 'interval',
      message_type: 'greeting',
      schedule: {
        time: '09:00',
        days: [],
        interval_value: 24,
        interval_unit: 'hours',
        timezone: 'local'
      },
      custom_instruction: trimText(`意图：${plan.intent || ''}${plan.reason ? '；原由：' + plan.reason : ''}`, 500),
      last_sent: null,
      next_run_at: Date.parse(plan.scheduledAt) || 0,
      created_at: Date.parse(plan.createdAt) || Date.now(),
      updated_at: Date.parse(plan.updatedAt) || Date.now()
    };
  }
  function planSnapshotTask(plan, snapshot) {
    const setting = settingFromPlan(plan);
    return {
      setting,
      character: deepClone(snapshot.character || {}),
      user: deepClone(snapshot.user || {}),
      recent_memories: Array.isArray(snapshot.recent_memories) ? deepClone(snapshot.recent_memories.slice(0, 8)) : [],
      recent_messages: Array.isArray(snapshot.recent_messages) ? deepClone(snapshot.recent_messages.slice(-16)) : [],
      recent_proactive_messages: Array.isArray(snapshot.recent_proactive_messages) ? deepClone(snapshot.recent_proactive_messages.slice(-10)) : [],
      chat_summary: trimText(snapshot.chat_summary, 1200),
      last_interaction_at: finiteTimestamp(snapshot.last_interaction_at),
      task_revision: 1,
      plan: plan
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
    const task = getState().tasks[record.setting_id];
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
    getState().tasks[taskId] = replacement;
    return replacement;
  }

  function currentForRun(taskId, snapshot) {
    const raw = getState().tasks[taskId];
    if (!raw) return { current: null, reason: 'task deleted while generation was running' };
    const current = ensureTaskMetadata(raw);
    if (current !== raw) getState().tasks[taskId] = current;
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
    const s = getState();
    s.history[historyId] = {
      ...(s.history[historyId] || {}),
      id: historyId,
      run_id: historyId,
      setting_id: setting.id,
      user_id: setting.user_id,
      character_id: setting.character_id,
      scheduled_for: s.history[historyId] && s.history[historyId].scheduled_for,
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

  return {
    pad, timeParts, atConfiguredTime, intervalMs, nextRun, safePart, runId, messageId,
    trimText, deepClone, sanitizeActiveSetting,
    PLAN_MIN_DELAY_MS, PLAN_MAX_DELAY_MS, PLAN_MAX_LATE_MS, PLAN_DEFAULT_MAX_ATTEMPTS, PLAN_STATUSES,
    sanitizeAiPlan, parsePlanJson, isInDnd, nextDndFree, planRunId, planMessageId, publicPlan,
    settingFromPlan, planSnapshotTask, stableJson, hashValue, finiteTimestamp, settingControl,
    taskFingerprints, ensureTaskMetadata, recordUserId, sameRunRevision, terminalRun,
    replaceTaskRuntime, currentForRun, cancelRun, mergeRecentProactiveMessages, buildTaskReplacement
  };
}

module.exports = createPlanDomain;
