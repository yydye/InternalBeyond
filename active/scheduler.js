/* IB Active · 调度器：任务执行（发送 / 跳过 / 失败 / 落库）、AI 计划二次评估与执行、
   每 15 秒 schedulerTick（含崩溃遗留回收与历史裁剪）、启动宽限期与优雅停机。
   从 active-message-service.js 提取为工厂：state 经 getState() 注入，armedUsers / 持久化 /
   计划域 / 模型客户端函数全部依赖注入；ticking 标志收在工厂闭包（根文件不再持有）。
   原逻辑逐字不变（shutdown 中冗余的 saveQueued 分支按语义化简为单次 saveNow）。 */
'use strict';

/* Proactive Observability v1：无 trace 注入时零行为默认 */
const NULL_TRACE = { enabled: function () { return false; }, begin: function () { return null; }, set: function () {}, append: function () {}, finish: function () { return null; }, recent: function () { return []; } };

function _classifyError(e) {
  const name = String((e && e.name) || '');
  const msg = String((e && e.message) || (e ? String(e) : ''));
  if (name === 'AbortError' || /abort/i.test(msg)) return 'abort';
  if (name === 'TimeoutError' || /超时|timeout/i.test(msg)) return 'timeout';
  if (/invalid JSON|不是JSON|非JSON|does not look like/i.test(msg)) return 'parse';
  if (/no final message/i.test(msg)) return 'invalid_content';
  if (/(\d{3})/.test(msg)) return 'http';
  return 'model';
}

function createScheduler(ctx) {
  const {
    getState, armedUsers, saveNow, queueSave,
    ensureTaskMetadata, replaceTaskRuntime, currentForRun, cancelRun, nextRun,
    runId, messageId, trimText, deepClone, mergeRecentProactiveMessages,
    sanitizeAiPlan, PLAN_STATUSES, PLAN_DEFAULT_MAX_ATTEMPTS,
    PLAN_MIN_DELAY_MS, PLAN_MAX_DELAY_MS, PLAN_MAX_LATE_MS,
    isInDnd, nextDndFree, planRunId, planMessageId, planSnapshotTask,
    generateProactiveMessage, windowsNotify, proactiveLog,
    callCharacterModel, contentText, parsePlanJson, isCharacterModelReady,
    terminalRun, sameRunRevision, momentsTick,
    startDelayMs, closeServer, proactiveTrace
  } = ctx;

  const _trace = proactiveTrace || NULL_TRACE;
  /* Credential Vault v1：运行时以 vault 为 authoritative 凭证来源；无记录时回退旧 snapshot 的 character.apiKey。 */
  const _vault = ctx.credentialVault;
  function _applyCredential(character, characterId) {
    if (!character || typeof character !== 'object') return character;
    const vid = String(character.id || characterId || '');
    const cred = (_vault && typeof _vault.get === 'function') ? _vault.get(vid) : null;
    if (cred && String(cred.apiKey || '').trim()) return Object.assign({}, character, { apiKey: cred.apiKey });
    return character;
  }
  function _enrichTask(task) {
    if (!task || typeof task !== 'object') return task;
    const c = task.character || {};
    const id = String(c.id || (task.setting && task.setting.character_id) || task.characterId || '');
    const enriched = _applyCredential(c, id);
    return enriched !== c ? Object.assign({}, task, { character: enriched }) : task;
  }
  let ticking = false;
  let schedulerInterval = null;
  let schedulerStartTimer = null;

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
    const rawTask = getState().tasks[taskId];
    if (!rawTask) return;
    const preparedTask = ensureTaskMetadata(rawTask);
    if (preparedTask !== rawTask) getState().tasks[taskId] = preparedTask;
    const task = _enrichTask(deepClone(preparedTask));
    const setting = task.setting || {};
    const userId = String(setting.user_id || '');
    if (!userId || !armedUsers.has(userId) || !setting.enabled || !setting.background_enabled) return;
    const character = task.character || {};
    proactiveLog('task triggered', { taskId, characterId: setting.character_id || '', scheduledFor });
    proactiveLog('character loaded', { taskId, characterId: character.id || setting.character_id || '', name: character.nickname || character.model || 'AI' });
    proactiveLog('provider/model selected', { taskId, characterId: character.id || setting.character_id || '', apiConfigId: character.id || setting.character_id || '', provider: character.provider || 'custom', model: character.model || '' });
    proactiveLog('memories loaded', { taskId, characterId: character.id || setting.character_id || '', count: Array.isArray(task.recent_memories) ? task.recent_memories.length : 0 });
    const id = runId(taskId, scheduledFor);
    const previous = getState().history[id];
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

    getState().history[id] = {
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
    const traceId = _trace.begin({
      kind: 'task',
      trigger: 'scheduled',
      taskId,
      characterId: setting.character_id,
      characterName,
      provider: String(character.provider || 'custom'),
      model: String(character.model || ''),
      scheduledFor,
      settings: { frequency: setting.frequency, message_type: setting.message_type }
    });
    const skipReason = adaptiveSkipReason(task);
    if (skipReason) {
      const currentCheck = currentForRun(taskId, task);
      if (!currentCheck.current) {
        cancelRun(id, task, currentCheck.reason);
        _trace.finish(traceId, 'cancelled', { trigger: 'adaptive_skip', reason: currentCheck.reason });
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
      const s = getState();
      s.history[id] = { ...s.history[id], ...event };
      s.events[event.id] = event;
      saveNow();
      console.log(`[Active] ${event.character_name} was postponed because the conversation was recently active.`);
      _trace.finish(traceId, 'skipped', { trigger: 'adaptive_skip', reason: skipReason });
      return;
    }

    let output = null;
    let callError = null;
    try {
      output = await generateProactiveMessage(task, { currentTime: Date.now(), traceId });
      if (!String(output && output.content || '').trim()) throw new Error('Model returned no final message');
    } catch (error) {
      callError = error;
    }

    const currentCheck = currentForRun(taskId, task);
    if (!currentCheck.current) {
      cancelRun(id, task, currentCheck.reason);
      console.log(`[Active] Discarded an obsolete result for ${characterName}: ${currentCheck.reason}`);
      _trace.finish(traceId, 'cancelled', { reason: currentCheck.reason });
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
      const s = getState();
      s.history[id] = { ...s.history[id], ...event };
      s.events[event.id] = event;
      saveNow();
      console.error(`[Active] Scheduled message failed for ${event.character_name}: ${event.error}`);
      _trace.finish(traceId, 'failed', { errorType: _classifyError(callError), reason: trimText(callError && callError.message || callError, 200) });
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
    getState().tasks[taskId] = updatedTask;
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
    const s2 = getState();
    s2.history[id] = { ...s2.history[id], ...event };
    s2.events[event.id] = event;
    saveNow(); // persist the queue before showing an OS notification
    windowsNotify(event.character_name, content);
    proactiveLog('message saved', { taskId, characterId: setting.character_id || '', messageId: event.message_id, provider: event.provider, model: event.model, generatedByFallback: event.generatedByFallback });
    _trace.finish(traceId, 'sent', { sentMessageId: event.message_id, sentAt });
    console.log(`[Active] ${event.character_name} sent a scheduled message at ${new Date(sentAt).toLocaleString()}`);
  }

  function buildPlanEvalPrompt(task, plan) {
    const character = task.character || {};
    const user = task.user || {};
    const characterName = character.nickname || character.model || 'AI';
    const userName = user.name || '用户';
    const memories = Array.isArray(task.recent_memories) ? task.recent_memories.slice(0, 8) : [];
    const messages = Array.isArray(task.recent_messages) ? task.recent_messages.slice(-16) : [];
    const proactive = Array.isArray(task.recent_proactive_messages) ? task.recent_proactive_messages.slice(-10) : [];
    const memoryText = memories.length
      ? memories.map(m => `- ${trimText(m.title, 100)}${m.title ? '：' : ''}${trimText(m.content || m.summary, 420)}`).join('\n')
      : '（没有可用的长期记忆）';
    const chatText = messages.length
      ? messages.map(m => `- ${m.role === 'user' ? userName : characterName}：${trimText(m.content, 650)}`).join('\n')
      : '（还没有最近对话）';
    const proactiveText = proactive.length
      ? proactive.map((m, i) => `${i + 1}. ${trimText(m.content || m, 650)}`).join('\n')
      : '（还没有发送过主动消息）';
    const now = new Date();
    const system = `你是「${characterName}」的到期评估器。你只输出严格 JSON，不输出任何其他文字。`;
    const prompt = [
      '【当前日期和时间】', now.toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      '', '【任务意图】', plan.intent || '未说明',
      '', '【任务创建原因】', plan.reason || '未说明',
      '', '【任务创建时间】', plan.createdAt || '',
      '', '【计划发送时间】', plan.scheduledAt || '',
      '', '【最近聊天内容】', chatText,
      '', '【最近主动消息】', proactiveText,
      '', '【相关长期记忆】', memoryText,
      '', '【输出格式】只输出一个 JSON 对象：{"action":"send"}，或 {"action":"reschedule","scheduledAt":"ISO8601带时区时间","reason":"..."}，或 {"action":"cancel","reason":"..."}。禁止输出任何其他文字。',
      '', '【评估规则】',
      '1. 原意图已完成、用户已说明不需要或消息已失去意义 → cancel。',
      '2. 用户已在计划创建后回复且 cancelIfUserReplies=true → 应 cancel（程序通常已处理）。',
      '3. 时机不合适（如深夜）但意图仍有意义 → reschedule 到合适时间。',
      '4. 没有把握时倾向 cancel，不要为了发送而发送。',
      '5. reschedule 时间必须晚于当前时间，且不超过 168 小时后。'
    ];
    return { system, messages: [{ role: 'user', content: prompt.join('\n') }] };
  }

  function updatePlan(planId, patch) {
    const raw = getState().plans[planId];
    if (!raw) return null;
    const current = sanitizeAiPlan(raw);
    const mergedPatch = { ...patch };
    if (patch.status && !PLAN_STATUSES.includes(patch.status)) delete mergedPatch.status; /* 非法状态保留当前值 */
    const merged = { ...raw, ...sanitizeAiPlan({ ...current, ...mergedPatch }), updatedAt: mergedPatch.updatedAt || new Date().toISOString() };
    getState().plans[planId] = merged;
    return sanitizeAiPlan(merged);
  }

  function planEvent(plan, status, extra) {
    const now = Date.now();
    return {
      id: `event_plan_${plan.id}_${now}_${Math.random().toString(36).slice(2, 6)}`,
      run_id: planRunId(plan.id, now),
      plan_id: plan.id,
      setting_id: plan.id,
      user_id: plan.user_id || '',
      character_id: plan.characterId,
      character_name: (extra && extra.character_name) || '',
      scheduled_for: Date.parse(plan.scheduledAt) || now,
      sent_at: now,
      task_revision: 0,
      setting_updated_at: 0,
      status,
      ...(extra || {})
    };
  }

  async function evaluatePlan(plan, task, nowMsOverride, traceId) {
    const now = Number(nowMsOverride) || Date.now();
    const prefs = plan.prefs || {};
    /* ── 程序端硬规则（不依赖模型） ── */
    if (!plan.characterId) return { action: 'cancel', reason: 'plan has no character' };
    if (!['scheduled', 'evaluating'].includes(plan.status)) return { action: 'cancel', reason: 'plan no longer executable' };
    if (plan.cancelledAt) return { action: 'cancel', reason: 'plan already cancelled' };
    if (prefs.enabled === false) return { action: 'cancel', reason: 'user disabled proactive messages' };
    const character = task.character || {};
    if (!isCharacterModelReady(character)) {
      return { action: 'failed', reason: 'Character API configuration is incomplete' };
    }
    const messages = Array.isArray(task.recent_messages) ? task.recent_messages : [];
    const planCreatedAt = Date.parse(plan.createdAt) || 0;
    const userRepliedSince = messages.some(m => m && m.role === 'user' && !m.source && Number(m.timestamp) > planCreatedAt);
    if (plan.cancelConditions && plan.cancelConditions.cancelIfUserReplies && userRepliedSince) {
      return { action: 'cancel', reason: 'user replied after the plan was created' };
    }
    if ((plan.attemptCount || 0) >= Math.max(1, (plan.constraints && plan.constraints.maxAttempts) || PLAN_DEFAULT_MAX_ATTEMPTS)) {
      return { action: 'cancel', reason: 'max attempts reached' };
    }
    /* 连续主动限制：最近主动消息后用户未回复 → 不再发送 */
    const recentProactive = Array.isArray(task.recent_proactive_messages) ? task.recent_proactive_messages : [];
    const lastProactive = recentProactive.length ? recentProactive[recentProactive.length - 1] : null;
    if (lastProactive) {
      const lastUserMsg = messages.filter(m => m && m.role === 'user' && !m.source)
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0];
      const userRepliedAfter = (lastUserMsg && Number(lastUserMsg.timestamp) || 0) > (Number(lastProactive.sent_at || lastProactive.timestamp) || 0);
      if (!userRepliedAfter) return { action: 'cancel', reason: 'user has not replied to the last proactive message' };
    }
    /* 免打扰 → 直接延后（不消耗模型调用） */
    if (plan.cancelConditions && plan.cancelConditions.respectDoNotDisturb && isInDnd(now, prefs)) {
      return { action: 'reschedule', scheduledAt: new Date(nextDndFree(now, prefs)).toISOString(), reason: 'do-not-disturb window' };
    }
    /* ── 模型二次评估：send / reschedule / cancel ── */
    try {
      const prompt = buildPlanEvalPrompt(task, plan);
      const out = await callCharacterModel(task, prompt, { jsonMode: true, traceId });
      const raw = contentText(out && out.content);
      const parsed = parsePlanJson(raw);
      if (parsed && ['send', 'reschedule', 'cancel'].includes(String(parsed.action || ''))) {
        if (parsed.action === 'send') return { action: 'send', reason: trimText(parsed.reason, 300) };
        if (parsed.action === 'cancel') return { action: 'cancel', reason: trimText(parsed.reason || 'model evaluation cancelled', 300) };
        const t = Date.parse(parsed.scheduledAt);
        if (Number.isFinite(t)) {
          const minMs = Math.max(PLAN_MIN_DELAY_MS, (prefs.minIntervalMinutes || 30) * 60000);
          const maxMs = Math.min(PLAN_MAX_DELAY_MS, (prefs.maxPlanHours || 168) * 3600000);
          let delay = t - now;
          if (delay < minMs) delay = minMs;
          if (delay > maxMs) delay = maxMs;
          return { action: 'reschedule', scheduledAt: new Date(now + delay).toISOString(), reason: trimText(parsed.reason || 'model suggested reschedule', 300) };
        }
        return { action: 'cancel', reason: 'model returned an invalid reschedule time' };
      }
      return { action: 'send', reason: 'model evaluation output was not parseable; proceeding with scheduled send' };
    } catch (error) {
      return { action: 'send', reason: `model evaluation failed (${trimText(error && error.message || error, 120)}); proceeding with scheduled send` };
    }
  }

  async function executePlan(planId, nowMsOverride) {
    const raw = getState().plans[planId];
    if (!raw) return;
    const plan = sanitizeAiPlan(raw);
    const userId = String(plan.user_id || '');
    if (!userId || !armedUsers.has(userId)) return;
    if (plan.status !== 'scheduled') return;
    if (!plan.characterId) return;
    const now = Number(nowMsOverride) || Date.now();
    const due = Date.parse(plan.scheduledAt) || 0;
    const rawCharacter = (raw && raw.character) || {};
    const characterName = rawCharacter.nickname || rawCharacter.model || 'AI';
    const traceId = _trace.begin({
      kind: 'plan',
      trigger: 'due',
      planId,
      characterId: plan.characterId,
      characterName,
      provider: String(rawCharacter.provider || ''),
      model: String(rawCharacter.model || ''),
      scheduledFor: plan.scheduledAt,
      intent: plan.intent,
      reason: plan.reason,
      settings: { status: plan.status, source: plan.source }
    });
    if (!due) {
      updatePlan(planId, { status: 'failed', lastError: 'invalid scheduledAt', updatedAt: new Date().toISOString() });
      saveNow();
      _trace.finish(traceId, 'failed', { errorType: 'invalid', reason: 'invalid scheduledAt' });
      return;
    }
    proactiveLog('plan triggered', { planId, characterId: plan.characterId, scheduledAt: plan.scheduledAt });
    const late = now - due;
    /* 休眠/重启恢复：过期太久的任务不批量发送，直接标记过期 */
    if (late > PLAN_MAX_LATE_MS) {
      updatePlan(planId, { status: 'expired', cancelReason: `missed trigger window by ${Math.round(late / 60000)} min`, updatedAt: new Date().toISOString() });
      saveNow();
      proactiveLog('plan expired', { planId, lateMs: late });
      _trace.finish(traceId, 'expired', { reason: 'missed trigger window' });
      return;
    }
    /* 原子抢占：单进程内同步执行天然互斥；executionId 持久化用于跨实例识别 */
    const claim = sanitizeAiPlan({
      ...plan,
      status: 'evaluating',
      executionId: `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    getState().plans[planId] = { ...raw, ...claim };
    saveNow();
    const task = _enrichTask(planSnapshotTask(claim, raw));
    const evalResult = await evaluatePlan(claim, task, now, traceId);
    proactiveLog('plan evaluation result', { planId, action: evalResult.action, reason: evalResult.reason });
    if (traceId) {
      _trace.append(traceId, 'eval', true, 'eval', String(evalResult.action || '') + (evalResult.reason ? ' | ' + evalResult.reason : ''));
      _trace.set(traceId, { evalAction: evalResult.action, evalReason: evalResult.reason });
    }
    if (evalResult.action === 'cancel') {
      const cancelledAt = new Date().toISOString();
      updatePlan(planId, { status: 'cancelled', cancelledAt, cancelReason: evalResult.reason, updatedAt: cancelledAt });
      const event = planEvent(claim, 'canceled', { reason: evalResult.reason, character_name: characterName });
      getState().events[event.id] = event;
      saveNow();
      _trace.finish(traceId, 'cancelled', { evalAction: 'cancel', reason: evalResult.reason });
      return;
    }
    if (evalResult.action === 'reschedule') {
      updatePlan(planId, { status: 'scheduled', scheduledAt: evalResult.scheduledAt, updatedAt: new Date().toISOString() });
      saveNow();
      proactiveLog('plan rescheduled', { planId, to: evalResult.scheduledAt, reason: evalResult.reason });
      _trace.finish(traceId, 'rescheduled', { evalAction: 'reschedule', reason: evalResult.reason });
      return;
    }
    if (evalResult.action === 'failed') {
      updatePlan(planId, { status: 'failed', lastError: evalResult.reason, updatedAt: new Date().toISOString() });
      const event = planEvent(claim, 'failed', { error: evalResult.reason, character_name: characterName });
      getState().events[event.id] = event;
      saveNow();
      _trace.finish(traceId, 'failed', { evalAction: 'failed', errorType: 'eval', reason: evalResult.reason });
      return;
    }
    /* send */
    updatePlan(planId, { status: 'sending', updatedAt: new Date().toISOString() });
    let output = null;
    let callError = null;
    try {
      output = await generateProactiveMessage(task, { currentTime: Date.now(), traceId });
      if (!String(output && output.content || '').trim()) throw new Error('Model returned no final message');
    } catch (error) {
      callError = error;
    }
    const current = getState().plans[planId] ? sanitizeAiPlan(getState().plans[planId]) : null;
    if (!current || current.status !== 'sending') {
      /* 执行期间计划被浏览器取消/替换 → 丢弃结果 */
      proactiveLog('plan discarded during generation', { planId, reason: current ? current.status : 'plan deleted' });
      _trace.finish(traceId, 'cancelled', { reason: current ? current.status : 'plan deleted' });
      return;
    }
    if (callError) {
      const attemptCount = (current.attemptCount || 0) + 1;
      const maxAttempts = Math.max(1, (current.constraints && current.constraints.maxAttempts) || PLAN_DEFAULT_MAX_ATTEMPTS);
      const failedAt = new Date().toISOString();
      if (attemptCount >= maxAttempts) {
        updatePlan(planId, { status: 'failed', attemptCount, lastError: trimText(callError && callError.message || callError, 300), updatedAt: failedAt });
        const event = planEvent(claim, 'failed', { error: trimText(callError && callError.message || callError, 1400), character_name: characterName });
        getState().events[event.id] = event;
        saveNow();
        proactiveLog('plan failed', { planId, error: String(callError && callError.message || callError).slice(0, 200) });
        _trace.finish(traceId, 'failed', { errorType: _classifyError(callError), reason: trimText(callError && callError.message || callError, 200) });
      } else {
        const retryAt = new Date(Date.now() + 15 * 60000).toISOString();
        updatePlan(planId, { status: 'scheduled', attemptCount, lastError: trimText(callError && callError.message || callError, 300), scheduledAt: retryAt, updatedAt: failedAt });
        saveNow();
        proactiveLog('plan will retry', { planId, at: retryAt });
        _trace.finish(traceId, 'error', { errorType: _classifyError(callError), reason: trimText(callError && callError.message || callError, 200), retryAt });
      }
      return;
    }
    const content = String(output.content || '').trim();
    const sentAt = Date.now();
    const messageId = planMessageId(planId, sentAt);
    const sentIso = new Date(sentAt).toISOString();
    updatePlan(planId, {
      status: 'waiting_for_user',
      executedAt: sentIso,
      attemptCount: (current.attemptCount || 0) + 1,
      lastError: null,
      updatedAt: sentIso
    });
    /* 跨计划连续抑制：把刚发送的消息并入该角色所有计划快照的 recent_proactive_messages，
       使后续到期计划能正确判定“用户未回复上一条主动消息 → 不发送” */
    const sentRecord = { content, sent_at: sentAt, generatedByFallback: !!output.generatedByFallback };
    const s = getState();
    Object.keys(s.plans).forEach(id => {
      const other = s.plans[id];
      if (!other) return;
      if (id !== planId && String(other.characterId || other.character_id || '') !== plan.characterId) return;
      s.plans[id] = {
        ...other,
        recent_proactive_messages: mergeRecentProactiveMessages(other.recent_proactive_messages || [], [sentRecord])
      };
    });
    /* 连续主动限制：allowFollowUpPlan 默认 false；waiting_for_user 保持到用户回复，由浏览器取消 */
    const event = planEvent(claim, 'sent', {
      character_name: characterName,
      provider: task.character && task.character.provider || '',
      model: task.character && task.character.model || '',
      showThinking: false,
      message_id: messageId,
      content,
      reasoning_content: '',
      generatedByFallback: !!output.generatedByFallback,
      generation_attempts: Number(output.generationAttempts || 1),
      generation_error: trimText(output.generationError || '', 500),
      next_run_at: null,
      acknowledged: false
    });
    const s2 = getState();
    s2.history[event.run_id] = { ...event, status: 'sent' };
    s2.events[event.id] = event;
    saveNow();
    windowsNotify(event.character_name, content);
    proactiveLog('plan message saved', { planId, characterId: plan.characterId, messageId, provider: event.provider, model: event.model, generatedByFallback: event.generatedByFallback });
    _trace.finish(traceId, 'sent', { sentMessageId: messageId, sentAt });
    console.log(`[Active] ${event.character_name} sent an AI-planned message at ${new Date(sentAt).toLocaleString()}`);
  }

  async function schedulerTick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const s = getState();
      const ids = Object.keys(s.tasks);
      for (const id of ids) {
        const rawTask = s.tasks[id];
        let task = ensureTaskMetadata(rawTask);
        if (task && task !== rawTask) s.tasks[id] = task;
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
      /* AI 计划：到期 → 二次评估 → 发送（companion 独占执行，浏览器在线时已跳过） */
      const planIds = Object.keys(s.plans);
      const staleWindow = 10 * 60 * 1000;
      for (const id of planIds) {
        const rawPlan = s.plans[id];
        const plan = sanitizeAiPlan(rawPlan);
        /* 崩溃恢复：evaluating/sending 停留超过 10 分钟 → 回收为 scheduled（尊重 maxAttempts） */
        if ((plan.status === 'evaluating' || plan.status === 'sending') && plan.claimedAt) {
          const claimedTs = typeof plan.claimedAt === 'number' ? plan.claimedAt : (Date.parse(plan.claimedAt) || 0); /* 兼容数字与 ISO 两种历史格式 */
          if (claimedTs > 0 && now - claimedTs > staleWindow) {
            const maxAttempts = Math.max(1, (plan.constraints && plan.constraints.maxAttempts) || PLAN_DEFAULT_MAX_ATTEMPTS);
            const attemptCount = (plan.attemptCount || 0) + 1;
            if (attemptCount >= maxAttempts) {
              updatePlan(id, { status: 'failed', attemptCount, lastError: 'execution timed out too many times (executor may have crashed)', updatedAt: new Date().toISOString() });
              proactiveLog('stale plan execution failed', { planId: id });
            } else {
              const patched = updatePlan(id, { status: 'scheduled', attemptCount, lastError: 'execution timed out (executor may have crashed); recovered', updatedAt: new Date().toISOString() });
              if (patched && (Date.parse(patched.scheduledAt) || 0) <= now) {
                updatePlan(id, { scheduledAt: new Date(now + 15 * 60000).toISOString() });
              }
              proactiveLog('stale plan execution recovered', { planId: id });
            }
            saveNow();
          }
          continue;
        }
        if (plan.status !== 'scheduled') continue;
        if (!plan.characterId) continue;
        const userId = String(plan.user_id || '');
        if (!userId || !armedUsers.has(userId)) continue;
        const due = Date.parse(plan.scheduledAt) || 0;
        if (!due) continue;
        if (due > now + 500) continue;
        await executePlan(id);
      }
      /* Moments：后台朋友圈调度（浏览器离线时执行；与任务/计划共用同一个 tick，不另起定时器）。
         单次失败只记录，绝不让 tick 整体停止。 */
      if (typeof momentsTick === 'function') {
        try {
          await momentsTick(now);
        } catch (error) {
          console.error('[Active] Moments tick failed:', error && error.message || error);
        }
      }
      const historyIds = Object.keys(s.history).sort((a, b) =>
        Number(s.history[b].sent_at || s.history[b].started_at || 0) -
        Number(s.history[a].sent_at || s.history[a].started_at || 0));
      let retainedHistory = historyIds.length;
      for (let index = historyIds.length - 1; index >= 0 && retainedHistory > 1000; index -= 1) {
        const historyId = historyIds[index];
        if (s.history[historyId] && s.history[historyId].status === 'processing') continue;
        delete s.history[historyId];
        retainedHistory -= 1;
      }
      queueSave();
    } finally {
      ticking = false;
    }
  }

  function startScheduler() {
    /* No interval exists before the startup grace period, and schedulerTick also requires an armed user. */
    schedulerStartTimer = setTimeout(() => {
      schedulerStartTimer = null;
      schedulerTick().catch(error => console.error('[Active] Scheduler tick failed:', error.message));
      schedulerInterval = setInterval(() => {
        schedulerTick().catch(error => console.error('[Active] Scheduler tick failed:', error.message));
      }, 15000);
    }, startDelayMs);
  }

  function shutdown() {
    if (schedulerStartTimer) clearTimeout(schedulerStartTimer);
    if (schedulerInterval) clearInterval(schedulerInterval);
    try { saveNow(); } catch (_) {}
    closeServer(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200).unref();
  }

  return {
    adaptiveSkipReason, executeTask, buildPlanEvalPrompt, updatePlan, planEvent,
    evaluatePlan, executePlan, schedulerTick, startScheduler, shutdown
  };
}

module.exports = createScheduler;
