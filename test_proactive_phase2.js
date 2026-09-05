'use strict';
/* Internal Beyond — Proactive Phase 2 实战审计 + 一致性回归测试
   运行：IB_PROACTIVE_TRACE=on node --test test_proactive_phase2.js
   覆盖（Phase 1）：
     1) PLAN→send   2) PLAN→reschedule  3) PLAN→cancel  4) model failure→fallback
     5) validation failure  6) dedup  7) compat retry  8) TASK execution
   覆盖（Phase 2）：
     状态机一致性：cancel 不再 send / reschedule 不重复 / failed 不误重试 /
     events·history·last_sent 一致 / trace outcome 与计划状态一致
   所有场景经 service 真实执行链（global.fetch 驱动），不伪造 outcome。 */
const test = require('node:test');
const assert = require('node:assert');

/* trace 必须在 service 构建前开启；通知关闭避免测试触发 OS 通知 */
process.env.IB_PROACTIVE_TRACE = 'on';
process.env.IB_ACTIVE_DISABLE_NOTIFICATIONS = '1';

/* ── global.fetch 场景调度器（service 构建时捕获全局 fetch） ── */
global.__scenario = 'send_ok';
global.__genCall = 0;
function okJson(content) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: content, reasoning_content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) };
}
global.fetch = async (url, opts) => {
  const bodyStr = String(opts && opts.body || '');
  const isGen = bodyStr.indexOf('请主动向') >= 0; /* 生成 prompt 独有的标记 */
  const scn = global.__scenario;
  if (!isGen) {
    /* 二次评估调用 */
    if (scn === 'reschedule') return okJson('{"action":"reschedule","scheduledAt":"' + new Date(Date.now() + 7200000).toISOString() + '","reason":"时机不合适"}');
    if (scn === 'cancel') return okJson('{"action":"cancel","reason":"用户已不需要"}');
    return okJson('{"action":"send","reason":"可以发送"}');
  }
  /* 生成调用 */
  if (scn === 'modelFailure') throw new Error('network down');
  if (scn === 'validationFail') return okJson(''); /* 空正文 → validation 拒绝 */
  if (scn === 'dedup') return okJson('完全相同的主动消息文本');
  if (scn === 'compatRetry') {
    global.__genCall += 1;
    if (global.__genCall === 1) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'max_tokens is not supported, use max_completion_tokens' } }) };
    return okJson('compat ok 正文');
  }
  return okJson('一条主动消息正文'); /* 默认 send_ok */
};

const service = require('./active-message-service.js');
const createProactiveTrace = require('./active/proactive-trace.js');
const { sanitizeAiPlan, executePlan, executeTask, getState, setArmed, resetStateForTest, proactiveTrace } = service;

function basePlan(o) {
  const now = Date.now();
  return sanitizeAiPlan(Object.assign({
    id: 'p_t2', characterId: 'char_1', user_id: 'user_test',
    status: 'scheduled', source: 'ai_planned',
    createdAt: new Date(now - 60000).toISOString(), updatedAt: new Date(now - 60000).toISOString(),
    scheduledAt: new Date(now - 1000).toISOString(),
    intent: '询问任务进度', reason: '用户表示稍后处理',
    cancelConditions: { cancelIfUserReplies: false, cancelIfIntentResolved: false, cancelIfNewerPlanExists: true, respectDoNotDisturb: false },
    constraints: { maxAttempts: 1, allowReschedule: true, allowFollowUpPlan: false },
    attemptCount: 0,
    prefs: { enabled: true, mode: 'ai', minIntervalMinutes: 30, maxPlanHours: 168, dndStart: '23:00', dndEnd: '08:00' }
  }, o || {}));
}
function baseSnapshot(o) {
  return Object.assign({
    character: { id: 'char_1', provider: 'openai', apiKey: 'sk', model: 'gpt-test', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', nickname: '测试角色', relationship: '挚友' },
    user: { id: 'user_test', name: '用户' },
    recent_memories: [], recent_messages: [], recent_proactive_messages: [],
    chat_summary: '', last_interaction_at: Date.now() - 60000
  }, o || {});
}
function setupPlan(o, snapO) {
  resetStateForTest();
  setArmed('user_test');
  proactiveTrace.reset();
  global.__genCall = 0;
  const plan = basePlan(o);
  getState().plans[plan.id] = Object.assign({}, plan, baseSnapshot(snapO));
  return plan.id;
}

/* ── 1. PLAN → send ── */
test('Phase1/2: PLAN→send —— trace 解释为何发送，plan 进入 waiting_for_user，事件一致', async () => {
  global.__scenario = 'send_ok';
  const planId = setupPlan();
  await executePlan(planId);
  const plan = getState().plans[planId];
  assert.strictEqual(plan.status, 'waiting_for_user');
  assert.ok(plan.executedAt);
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.outcome, 'sent');
  assert.strictEqual(rec.kind, 'plan');
  assert.strictEqual(rec.evalAction, 'send');
  assert.strictEqual(rec.fallback, false);
  assert.strictEqual(rec.compatRetry, undefined);
  assert.ok(rec.sentMessageId);
  /* 事件/history 一致 */
  const ev = Object.values(getState().events).find(e => e.status === 'sent' && e.character_name === '测试角色');
  assert.ok(ev, '存在 sent 事件');
  assert.strictEqual(ev.message_id, rec.sentMessageId);
  const h = getState().history[ev.run_id];
  assert.strictEqual(h.status, 'sent');
  assert.ok(rec.steps.some(s => s.stage === 'validation' && s.ok === true));
});

/* ── 2. PLAN → reschedule ── */
test('Phase1/2: PLAN→reschedule —— 计划保持 scheduled，未被误发送，attemptCount 不变', async () => {
  global.__scenario = 'reschedule';
  const planId = setupPlan();
  await executePlan(planId);
  const plan = getState().plans[planId];
  assert.strictEqual(plan.status, 'scheduled');       /* 仍可执行，未消耗 attempt */
  assert.strictEqual(plan.attemptCount, 0);
  assert.ok(Date.parse(plan.scheduledAt) > Date.now()); /* 被延后 */
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.outcome, 'rescheduled');
  assert.strictEqual(rec.evalAction, 'reschedule');
  assert.strictEqual(rec.fallback, undefined);
  assert.strictEqual(Object.values(getState().events).filter(e => e.status === 'sent').length, 0);
});

/* ── 3. PLAN → cancel ── */
test('Phase1/2: PLAN→cancel —— cancelled 后不会 send，事件无 sent', async () => {
  global.__scenario = 'cancel';
  const planId = setupPlan();
  await executePlan(planId);
  const plan = getState().plans[planId];
  assert.strictEqual(plan.status, 'cancelled');
  assert.ok(plan.cancelReason);
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.outcome, 'cancelled');
  assert.strictEqual(rec.evalAction, 'cancel');
  assert.strictEqual(rec.fallback, undefined);
  assert.strictEqual(Object.values(getState().events).filter(e => e.status === 'sent').length, 0);
});

/* ── 4. model failure → fallback ── */
test('Phase1/2: model failure→fallback —— 所有 model_call 失败，走 fallback，仍发送', async () => {
  global.__scenario = 'modelFailure';
  const planId = setupPlan({ constraints: { maxAttempts: 3, allowReschedule: true, allowFollowUpPlan: false } });
  await executePlan(planId);
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.outcome, 'sent');
  assert.strictEqual(rec.fallback, true);
  assert.strictEqual(rec.errorType, 'model');
  assert.strictEqual(rec.generationAttempts, 3);
  assert.ok(rec.steps.filter(s => s.stage === 'model_call' && s.ok === false).length >= 3);
  assert.ok(rec.steps.some(s => s.stage === 'fallback'));
});

/* ── 5. validation failure ── */
test('Phase1/2: validation failure —— validation 拒绝，走 fallback（fallback 绕过 validation 属现有语义）', async () => {
  global.__scenario = 'validationFail';
  const planId = setupPlan({ constraints: { maxAttempts: 1, allowReschedule: true, allowFollowUpPlan: false } });
  await executePlan(planId);
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.outcome, 'sent');
  assert.strictEqual(rec.fallback, true);
  const valSteps = rec.steps.filter(s => s.stage === 'validation');
  assert.ok(valSteps.length >= 1);
  assert.strictEqual(valSteps[valSteps.length - 1].ok, false);
});

/* ── 6. dedup ── */
test('Phase1/2: dedup —— 与最近主动消息相似，标记 dedup 并走 fallback', async () => {
  global.__scenario = 'dedup';
  const now = Date.now();
  const planId = setupPlan(
    { id: 'p_dedup', constraints: { maxAttempts: 1, allowReschedule: true, allowFollowUpPlan: false } },
    {
      recent_proactive_messages: [{ content: '完全相同的主动消息文本', sent_at: now - 2000, generatedByFallback: false }],
      recent_messages: [{ role: 'user', content: '好的，我知道啦', timestamp: now - 1000, source: '', timerEnabled: false }]
    }
  );
  await executePlan(planId);
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.dedup, true);
  assert.strictEqual(rec.fallback, true);
  assert.ok(rec.steps.some(s => s.stage === 'dedup'));
  /* 发送未携带重复正文（用 fallback） */
  assert.strictEqual(rec.outcome, 'sent');
});

/* ── 7. compat retry ── */
test('Phase1/2: compat retry —— max_tokens 被拒后切 max_completion_tokens，trace 记 compatRetry', async () => {
  global.__scenario = 'compatRetry';
  const planId = setupPlan({ id: 'p_compat', constraints: { maxAttempts: 1, allowReschedule: true, allowFollowUpPlan: false } });
  await executePlan(planId);
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.compatRetry, true);
  assert.strictEqual(rec.compatRetryKind, 'max_completion_tokens');
  assert.strictEqual(global.__genCall, 2); /* 请求体第二次才成功 */
  assert.strictEqual(rec.outcome, 'sent');
});

/* ── 8. TASK execution ── */
test('Phase1/2: TASK execution —— kind=task，发送更新 last_sent 与 history', async () => {
  global.__scenario = 'send_ok';
  resetStateForTest();
  setArmed('user_test');
  proactiveTrace.reset();
  const now = Date.now();
  const task = {
    setting: { id: 't1', user_id: 'user_test', character_id: 'char_1', enabled: true, background_enabled: true, frequency: 'interval', schedule: { time: '09:00', days: [], interval_value: 24, interval_unit: 'hours', timezone: 'local' }, message_type: 'greeting', custom_instruction: '', next_run_at: now - 1000, last_sent: null, created_at: now, updated_at: now },
    character: { id: 'char_1', provider: 'openai', apiKey: 'sk', model: 'gpt-test', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', nickname: '测试角色', relationship: '挚友' },
    user: { id: 'user_test', name: '用户' },
    recent_memories: [], recent_messages: [], recent_proactive_messages: [], chat_summary: '', last_interaction_at: now - 60000, task_revision: 1
  };
  getState().tasks['t1'] = task;
  await executeTask('t1', now - 1000);
  const rec = proactiveTrace.recent(1)[0];
  assert.strictEqual(rec.kind, 'task');
  assert.strictEqual(rec.outcome, 'sent');
  assert.ok(rec.sentMessageId);
  /* last_sent 已更新 */
  assert.strictEqual(getState().tasks['t1'].setting.last_sent > 0, true);
  const ev = Object.values(getState().events).find(e => e.status === 'sent' && e.setting_id === 't1');
  assert.ok(ev);
  assert.strictEqual(getState().history[ev.run_id].status, 'sent');
});

/* ── Phase 4：outcome observation（record-only，不伪造） ── */
test('Phase4: observeOutcome —— 可靠 traceId 挂 laterOutcome；未知 traceId 返回 null 不伪造', () => {
  const t = createProactiveTrace({ enabled: true, limit: 5 });
  const id = t.begin({ kind: 'plan', planId: 'p1' });
  t.finish(id, 'sent', { sentMessageId: 'm1' });
  const r = t.observeOutcome(id, 'replied');
  assert.ok(r, '匹配到已完结 trace');
  assert.strictEqual(r.laterOutcome, 'replied');
  assert.ok(r.laterOutcomeAt);
  const after = t.recent(1)[0];
  assert.strictEqual(after.laterOutcome, 'replied');
  /* 无可靠来源（未知 traceId / 已淘汰）→ 不伪造 */
  assert.strictEqual(t.observeOutcome('pt_missing', 'ignored'), null);
});
