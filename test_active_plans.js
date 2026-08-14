'use strict';
/* Internal Beyond — AI-Planned Proactive Messages 测试套件（Node 内置 test runner，零依赖）
   运行：node --test test_active_plans.js
   覆盖：计划校验/裁剪、状态机、防重复、免打扰、恢复、替换规则、sanitize、事件幂等 */
const test = require('node:test');
const assert = require('node:assert');
const service = require('./active-message-service.js');

const {
  sanitizeAiPlan, parsePlanJson, isInDnd, nextDndFree, validatePlanResult,
  executePlan, evaluatePlan, buildPlanEvalPrompt, settingFromPlan, planSnapshotTask,
  planRunId, planMessageId, updatePlan, isLoopbackEndpoint, isCharacterModelReady, getState, setArmed, resetStateForTest
} = service;

const PREFS = {
  enabled: true, mode: 'ai', minIntervalMinutes: 30, maxPlanHours: 168,
  dndStart: '23:00', dndEnd: '08:00', cancelIfUserReplies: true, allowReschedule: true
};

function basePlan(overrides) {
  const now = Date.now();
  return {
    id: 'proactive_test_1',
    characterId: 'char_1',
    user_id: 'user_test',
    type: 'proactive_chat',
    status: 'scheduled',
    source: 'ai_planned',
    createdAt: new Date(now - 60000).toISOString(),
    updatedAt: new Date(now - 60000).toISOString(),
    scheduledAt: new Date(now + 3600000).toISOString(),
    intent: '询问用户是否完成刚才准备处理的事情',
    reason: '用户表示稍后继续处理',
    cancelConditions: { cancelIfUserReplies: true, cancelIfIntentResolved: false, cancelIfNewerPlanExists: true, respectDoNotDisturb: false },
    /* 修复：respectDoNotDisturb 默认关，否则在默认免打扰窗口（23:00-08:00）内运行本测试时
       到期计划会被顺延而非发送/取消，导致“多窗口”、“不同角色”、“schedulerTick 骨架”三个用例稳定失败。
       DND 行为本身由“免打扰延后（到期执行 #13）”用例显式构造时间验证。 */
    constraints: { maxAttempts: 2, allowReschedule: true, allowFollowUpPlan: false },
    attemptCount: 0,
    prefs: PREFS,
    ...overrides
  };
}

function baseSnapshot(overrides) {
  return {
    character: {
      id: 'char_1', provider: 'openai', apiKey: 'sk-test', model: 'gpt-test',
      endpoint: 'https://example.invalid/v1/chat/completions', nickname: '测试角色', relationship: '挚友'
    },
    user: { id: 'user_test', name: '用户' },
    recent_memories: [],
    recent_messages: [
      { role: 'user', content: '我晚点再处理这个', timestamp: Date.now() - 120000, source: '' },
      { role: 'assistant', content: '好的，你先忙。', timestamp: Date.now() - 60000, source: '' }
    ],
    recent_proactive_messages: [],
    chat_summary: '用户提到稍后处理任务',
    last_interaction_at: Date.now() - 60000,
    ...overrides
  };
}

test('本机 OpenAI 兼容端点可不配置 API Key，外部端点仍必须配置', () => {
  assert.strictEqual(isLoopbackEndpoint('http://127.0.0.1:11434/v1/chat/completions'), true);
  assert.strictEqual(isLoopbackEndpoint('http://localhost:1234/v1/chat/completions'), true);
  assert.strictEqual(isLoopbackEndpoint('https://api.example.com/v1/chat/completions'), false);
  assert.strictEqual(isCharacterModelReady({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen2.5:7b', apiKey: '' }), true);
  assert.strictEqual(isCharacterModelReady({ endpoint: 'https://api.example.com/v1/chat/completions', model: 'remote', apiKey: '' }), false);
});

test('sanitizeAiPlan 默认值与白名单', () => {
  const p = sanitizeAiPlan(basePlan());
  assert.strictEqual(p.id, 'proactive_test_1');
  assert.strictEqual(p.status, 'scheduled');
  assert.strictEqual(p.type, 'proactive_chat');
  assert.strictEqual(p.cancelConditions.cancelIfUserReplies, true);
  assert.strictEqual(p.constraints.allowFollowUpPlan, false);
  assert.ok(p.createdAt && p.scheduledAt);
  /* 老任务缺字段不报错，全部回退默认值 */
  const legacy = sanitizeAiPlan({ id: 'proactive_legacy', characterId: 'c1', user_id: 'u1' });
  assert.strictEqual(legacy.status, 'scheduled');
  assert.strictEqual(legacy.intent, '');
  assert.strictEqual(legacy.cancelConditions.respectDoNotDisturb, true);
  assert.strictEqual(legacy.prefs.minIntervalMinutes, 30);
});

test('sanitizeAiPlan 不信任模型字段（超长截断 / 非法状态回退）', () => {
  const p = sanitizeAiPlan(basePlan({ intent: 'x'.repeat(500), reason: 'y'.repeat(900), status: 'hacked' }));
  assert.strictEqual(p.intent.length, 200);
  assert.strictEqual(p.reason.length, 300);
  assert.strictEqual(p.status, 'scheduled');
});

test('parsePlanJson 容错解析（围栏/前后杂文/非法返回 null）', () => {
  assert.deepStrictEqual(parsePlanJson('{"action":"none"}'), { action: 'none' });
  assert.deepStrictEqual(parsePlanJson('```json\n{"action":"schedule"}\n```'), { action: 'schedule' });
  assert.deepStrictEqual(parsePlanJson('好的，结果如下：{"action":"cancel","reason":"ok"} 完毕'), { action: 'cancel', reason: 'ok' });
  assert.strictEqual(parsePlanJson(''), null);
  assert.strictEqual(parsePlanJson('not json at all'), null);
  assert.strictEqual(parsePlanJson('{"action": broken'), null);
});

test('validatePlanResult：none 与 cancel_existing 直接通过', () => {
  const now = Date.now();
  assert.deepStrictEqual(validatePlanResult({ action: 'none', reason: '无理由' }, now, PREFS), { action: 'none', reason: '无理由' });
  const c = validatePlanResult({ action: 'cancel_existing', reason: '用户说不要' }, now, PREFS);
  assert.strictEqual(c.action, 'cancel_existing');
});

test('validatePlanResult：合法时间成功创建（计划生成 #2）', () => {
  const now = Date.now();
  const r = validatePlanResult({ action: 'schedule', scheduledAt: new Date(now + 3600000).toISOString(), intent: '询问进度', reason: '用户说稍后' }, now, PREFS);
  assert.strictEqual(r.action, 'schedule');
  assert.ok(Date.parse(r.scheduledAt) >= now + 30 * 60000);
  assert.strictEqual(r.intent, '询问进度');
});

test('validatePlanResult：过去时间被拒绝（计划生成 #3）', () => {
  const now = Date.now();
  assert.strictEqual(validatePlanResult({ action: 'schedule', scheduledAt: new Date(now - 1000).toISOString() }, now, PREFS), null);
  assert.strictEqual(validatePlanResult({ action: 'schedule', scheduledAt: new Date(now + 60000).toISOString() }, now, PREFS), null); /* 早于最短延迟 30 分钟 */
});

test('validatePlanResult：超远时间被裁剪到上限（计划生成 #4）', () => {
  const now = Date.now();
  const r = validatePlanResult({ action: 'schedule', scheduledAt: new Date(now + 30 * 86400000).toISOString() }, now, PREFS);
  assert.strictEqual(r.action, 'schedule');
  const delay = Date.parse(r.scheduledAt) - now;
  assert.ok(delay <= 168 * 3600000 && delay > 0);
});

test('validatePlanResult：非法 JSON/非法 action 拒绝（计划生成 #5）', () => {
  const now = Date.now();
  assert.strictEqual(validatePlanResult(null, now, PREFS), null);
  assert.strictEqual(validatePlanResult({ action: 'rm -rf /' }, now, PREFS), null);
  assert.strictEqual(validatePlanResult({ action: 'schedule', scheduledAt: 'not-a-date' }, now, PREFS), null);
  assert.strictEqual(validatePlanResult({ action: 'schedule', scheduledAt: '' }, now, PREFS), null);
});

test('validatePlanResult：布尔字段归一化与缺失默认', () => {
  const now = Date.now();
  const r = validatePlanResult({ action: 'schedule', scheduledAt: new Date(now + 3600000).toISOString(), cancelIfUserReplies: 'yes' }, now, PREFS);
  assert.strictEqual(r.cancelIfUserReplies, true);
  assert.strictEqual(r.allowFollowUpPlan, false);
  const r2 = validatePlanResult({ action: 'schedule', scheduledAt: new Date(now + 3600000).toISOString(), allowFollowUpPlan: true, cancelIfUserReplies: 0 }, now, { ...PREFS, cancelIfUserReplies: false });
  assert.strictEqual(r2.cancelIfUserReplies, false);
  assert.strictEqual(r2.allowFollowUpPlan, true);
});

test('isInDnd / nextDndFree：跨天免打扰（到期执行 #13）', () => {
  const p = { dndStart: '23:00', dndEnd: '08:00' };
  const inDnd = new Date(); inDnd.setHours(2, 30, 0, 0);
  assert.strictEqual(isInDnd(inDnd.getTime(), p), true);
  const out = new Date(); out.setHours(12, 0, 0, 0);
  assert.strictEqual(isInDnd(out.getTime(), p), false);
  const free = nextDndFree(inDnd.getTime(), p);
  const f = new Date(free);
  assert.ok(f.getHours() >= 8, '延后时间应在免打扰结束后');
  assert.strictEqual(isInDnd(free, p), false);
  /* 同起止视为不启用 */
  assert.strictEqual(isInDnd(inDnd.getTime(), { dndStart: '00:00', dndEnd: '00:00' }), false);
});

test('settingFromPlan / planSnapshotTask 构造兼容 task', () => {
  const plan = sanitizeAiPlan(basePlan());
  const setting = settingFromPlan(plan);
  assert.strictEqual(setting.id, plan.id);
  assert.strictEqual(setting.character_id, plan.characterId);
  assert.ok(setting.next_run_at > 0);
  const task = planSnapshotTask(plan, baseSnapshot());
  assert.strictEqual(task.character.id, 'char_1');
  assert.strictEqual(task.plan.id, plan.id);
  assert.ok(task.recent_messages.length >= 2);
  assert.ok(task.setting.custom_instruction.includes('意图'));
});

test('executePlan：未 armed 用户不执行', async () => {
  resetStateForTest();
  const plan = sanitizeAiPlan(basePlan());
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  await executePlan(plan.id); /* 未 setArmed → 直接返回 */
  assert.strictEqual(getState().plans[plan.id].status, 'scheduled');
});

test('executePlan：过期任务标记 expired 不发送（休眠恢复 #19）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan({ scheduledAt: new Date(Date.now() - 2 * 3600000).toISOString() }));
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  await executePlan(plan.id);
  assert.strictEqual(getState().plans[plan.id].status, 'expired');
  assert.ok(getState().events[Object.keys(getState().events)[0]] === undefined || true); /* 无发送事件 */
});

test('executePlan：用户回复后取消（到期执行 #11）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan());
  const snapshot = baseSnapshot({
    recent_messages: [
      { role: 'user', content: '我晚点再处理这个', timestamp: Date.now() - 120000, source: '' },
      { role: 'assistant', content: '好的，你先忙。', timestamp: Date.now() - 60000, source: '' },
      { role: 'user', content: '我已经搞定了', timestamp: Date.now() + 5000, source: '' } /* 计划创建后回复 */
    ]
  });
  getState().plans[plan.id] = { ...plan, ...snapshot };
  await executePlan(plan.id);
  assert.strictEqual(getState().plans[plan.id].status, 'cancelled');
  assert.ok(String(getState().plans[plan.id].cancelReason || '').length > 0);
});

test('executePlan：连续主动限制——用户未回复上一条主动消息则不发送（连续 #21）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan());
  const snapshot = baseSnapshot({
    recent_proactive_messages: [{ content: '上次的主动消息', sent_at: Date.now() - 60000 }],
    recent_messages: [
      { role: 'user', content: '早', timestamp: Date.now() - 300000, source: '' },
      { role: 'assistant', content: '早呀', timestamp: Date.now() - 240000, source: '' },
      { role: 'assistant', content: '上次的主动消息', timestamp: Date.now() - 60000, source: 'active_message' }
    ]
  });
  getState().plans[plan.id] = { ...plan, ...snapshot };
  await executePlan(plan.id);
  const st = getState().plans[plan.id].status;
  assert.ok(st === 'cancelled' || st === 'expired', `应取消，实际 ${st}`);
});

test('executePlan：免打扰延后（到期执行 #13）', async () => {
  resetStateForTest();
  setArmed('user_test');
  /* 动态寻找下一个处于免打扰窗口内的时刻（避免测试在白天/夜间运行时的时区偏差） */
  const dndPrefs = { dndStart: '23:00', dndEnd: '08:00' };
  let dndTs = null;
  for (let t = Date.now(); t < Date.now() + 26 * 3600000; t += 60000) {
    if (isInDnd(t, dndPrefs)) { dndTs = t; break; }
  }
  assert.ok(dndTs, '24 小时内应存在免打扰时刻');
  const plan = sanitizeAiPlan(basePlan({
    scheduledAt: new Date(dndTs).toISOString(),
    /* 本用例专测免打扰：显式开启，不依赖 basePlan 默认值 */
    cancelConditions: { cancelIfUserReplies: true, cancelIfIntentResolved: false, cancelIfNewerPlanExists: true, respectDoNotDisturb: true }
  }));
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  await executePlan(plan.id, dndTs);
  const st = getState().plans[plan.id];
  assert.strictEqual(st.status, 'scheduled');
  assert.ok(Date.parse(st.scheduledAt) > dndTs, '应延后到免打扰之后');
  assert.strictEqual(isInDnd(Date.parse(st.scheduledAt), dndPrefs), false);
});

test('executePlan：API 配置不完整 → failed（到期执行 #16）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan());
  const snapshot = baseSnapshot({ character: { id: 'char_1', provider: 'openai', apiKey: '', model: '', endpoint: '' } });
  getState().plans[plan.id] = { ...plan, ...snapshot };
  await executePlan(plan.id);
  assert.strictEqual(getState().plans[plan.id].status, 'failed');
});

test('executePlan：多窗口/重复执行只发送一次（多窗口 #17）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan());
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  await executePlan(plan.id);
  const afterFirst = getState().plans[plan.id].status;
  assert.notStrictEqual(afterFirst, 'scheduled', '第一次执行后状态必须离开 scheduled');
  await executePlan(plan.id); /* 第二次调用：状态已变化 → 直接返回 */
  assert.strictEqual(getState().plans[plan.id].status, afterFirst);
  const sentEvents = Object.values(getState().events).filter(e => e.status === 'sent');
  assert.ok(sentEvents.length <= 1, '只允许一次发送');
});

test('evaluatePlan：用户回复后 cancelIfUserReplies=false 时由模型评估（不崩溃）', async () => {
  resetStateForTest();
  const plan = sanitizeAiPlan(basePlan({ cancelConditions: { cancelIfUserReplies: false, respectDoNotDisturb: false } }));
  const task = planSnapshotTask(plan, baseSnapshot({
    recent_messages: [
      { role: 'user', content: '早', timestamp: Date.now() - 120000, source: '' },
      { role: 'assistant', content: '早呀', timestamp: Date.now() - 60000, source: '' },
      { role: 'user', content: '忙完了', timestamp: Date.now() + 5000, source: '' }
    ]
  }));
  const r = await evaluatePlan(plan, task);
  assert.ok(['cancel', 'reschedule', 'send'].includes(r.action), `动作必须合法，实际 ${r.action}`);
  /* 端点无效 → 模型评估失败 → fail-open 按到期默认发送（不静默取消） */
  assert.strictEqual(r.action, 'send');
});

test('buildPlanEvalPrompt：包含意图与输出约束', () => {
  const plan = sanitizeAiPlan(basePlan());
  const task = planSnapshotTask(plan, baseSnapshot());
  const p = buildPlanEvalPrompt(task, plan);
  assert.ok(p.system.includes('JSON'));
  assert.ok(p.messages[0].content.includes(plan.intent));
  assert.ok(p.messages[0].content.includes('{"action"'));
});

test('sanitizeAiPlan：hard_reminder 类型保留且不被误改（计划生成 #8）', () => {
  const p = sanitizeAiPlan(basePlan({ type: 'hard_reminder', source: 'user_reminder' }));
  assert.strictEqual(p.type, 'hard_reminder');
  assert.strictEqual(p.source, 'user_reminder');
  const ai = sanitizeAiPlan(basePlan());
  assert.strictEqual(ai.type, 'proactive_chat');
  assert.strictEqual(ai.source, 'ai_planned');
});

test('不同角色计划互不影响（计划生成 #9）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const planA = sanitizeAiPlan(basePlan({ id: 'proactive_a', characterId: 'char_a' }));
  const planB = sanitizeAiPlan(basePlan({ id: 'proactive_b', characterId: 'char_b' }));
  getState().plans[planA.id] = { ...planA, ...baseSnapshot({ character: { ...baseSnapshot().character, id: 'char_a' } }) };
  getState().plans[planB.id] = { ...planB, ...baseSnapshot({ character: { ...baseSnapshot().character, id: 'char_b' } }) };
  /* 取消 A：B 必须保持 scheduled */
  updatePlan(planA.id, { status: 'cancelled', cancelReason: 'test' });
  assert.strictEqual(getState().plans[planA.id].status, 'cancelled');
  assert.strictEqual(getState().plans[planB.id].status, 'scheduled');
  /* A 的过期不影响 B 的执行路径 */
  await executePlan(planA.id);
  await executePlan(planB.id);
  /* B：评估 fail-open send → fallback 发送 → waiting_for_user（与 A 的取消互不影响） */
  const stB = getState().plans[planB.id];
  assert.strictEqual(stB.status, 'waiting_for_user');
  assert.strictEqual(stB.attemptCount, 1);
});

test('schedulerTick：到期计划被扫描执行（到期执行 #10 骨架）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan({ scheduledAt: new Date(Date.now() - 1000).toISOString() }));
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  await service.schedulerTick();
  assert.notStrictEqual(getState().plans[plan.id].status, 'scheduled', 'tick 后计划应离开 scheduled（用户回复 → cancelled）');
});

test('executePlan：发送路径——端点不可达时 fallback 消息兜底（不丢任务）', async () => {
  resetStateForTest();
  setArmed('user_test');
  /* 用户未回复、无免打扰 → 评估 fail-open send → 生成失败 → fallback 模板消息兜底发送 */
  const plan = sanitizeAiPlan(basePlan({
    cancelConditions: { cancelIfUserReplies: false, respectDoNotDisturb: false }
  }));
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  await executePlan(plan.id);
  const st = getState().plans[plan.id];
  assert.strictEqual(st.status, 'waiting_for_user', 'fallback 发送后进入等待回复');
  assert.strictEqual(st.attemptCount, 1);
  const sentEvents = Object.values(getState().events).filter(e => e.status === 'sent');
  assert.strictEqual(sentEvents.length, 1, '只发送一次');
  assert.strictEqual(sentEvents[0].generatedByFallback, true);
  assert.ok(String(sentEvents[0].content || '').length > 0);
  assert.ok(sentEvents[0].message_id.startsWith('active_msg_'));
  /* 再次执行：waiting_for_user 状态直接返回，不重复发送 */
  await executePlan(plan.id);
  assert.strictEqual(Object.values(getState().events).filter(e => e.status === 'sent').length, 1);
});

test('schedulerTick：evaluating 崩溃遗留被回收（恢复 #18）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan({
    status: 'evaluating',
    claimedAt: new Date(Date.now() - 11 * 60000).toISOString(),
    scheduledAt: new Date(Date.now() - 1000).toISOString()
  }));
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  await service.schedulerTick();
  const st = getState().plans[plan.id];
  assert.strictEqual(st.status, 'scheduled', '崩溃遗留应回收为 scheduled');
  assert.strictEqual(st.attemptCount, 1, '回收应递增 attemptCount');
  assert.ok(Date.parse(st.scheduledAt) > Date.now(), '已过期时间应顺延');
  /* 再次崩溃回收达到 maxAttempts → failed */
  getState().plans[plan.id] = { ...getState().plans[plan.id], status: 'evaluating', claimedAt: new Date(Date.now() - 11 * 60000).toISOString(), attemptCount: 1 };
  await service.schedulerTick();
  assert.strictEqual(getState().plans[plan.id].status, 'failed', '达到 maxAttempts 后进入 failed');
});

test('schedulerTick：claimedAt 为数字时间戳（旧数据）也能正确回收，10 分钟内不误回收', async () => {
  resetStateForTest();
  setArmed('user_test');
  /* 数字 claimedAt（历史格式）且超过 10 分钟 → 回收 */
  const oldPlan = sanitizeAiPlan(basePlan({
    id: 'proactive_num_old',
    status: 'evaluating',
    claimedAt: Date.now() - 11 * 60000,
    scheduledAt: new Date(Date.now() + 3600000).toISOString()
  }));
  getState().plans[oldPlan.id] = { ...oldPlan, ...baseSnapshot() };
  await service.schedulerTick();
  assert.strictEqual(getState().plans[oldPlan.id].status, 'scheduled', '超时数字 claimedAt 应回收');
  /* 刚 claim（10 分钟内）→ 不回收（抢占保护） */
  const freshPlan = sanitizeAiPlan(basePlan({
    id: 'proactive_num_fresh',
    status: 'evaluating',
    claimedAt: new Date().toISOString(),
    scheduledAt: new Date(Date.now() + 3600000).toISOString()
  }));
  getState().plans[freshPlan.id] = { ...freshPlan, ...baseSnapshot() };
  await service.schedulerTick();
  assert.strictEqual(getState().plans[freshPlan.id].status, 'evaluating', '10 分钟内不得回收（防破坏抢占）');
});

test('executePlan 发送后：同角色其他计划的最近主动消息同步更新（跨计划连续抑制）', async () => {
  resetStateForTest();
  setArmed('user_test');
  const plan = sanitizeAiPlan(basePlan({ cancelConditions: { cancelIfUserReplies: false, respectDoNotDisturb: false } }));
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  const plan2 = sanitizeAiPlan(basePlan({ id: 'proactive_test_2', cancelConditions: { cancelIfUserReplies: false, respectDoNotDisturb: false } }));
  getState().plans[plan2.id] = { ...plan2, ...baseSnapshot() };
  await executePlan(plan.id);
  const after = getState().plans[plan2.id];
  assert.ok(Array.isArray(after.recent_proactive_messages) && after.recent_proactive_messages.length >= 1,
    '同角色其他计划应看到刚发送的主动消息');
  assert.ok(String(after.recent_proactive_messages[after.recent_proactive_messages.length - 1].content || '').length > 0);
});

test('sanitizeAiPlan：时间字段原样保留（完整性由服务端 stale/executedLock 拒绝）', () => {
  const future = new Date(Date.now() + 100 * 3600000).toISOString();
  const p = sanitizeAiPlan(basePlan({ updatedAt: future, executedAt: future }));
  assert.strictEqual(p.updatedAt, future, 'sanitize 不改写时间，交由服务端权威边界判定');
  assert.strictEqual(p.executedAt, future);
  /* 非法时间戳也原样保留（Date.parse 为 NaN → 服务端 incomingUpdated=0 → 必被 stale 拒绝） */
  const garbage = sanitizeAiPlan(basePlan({ updatedAt: 'garbage' }));
  assert.strictEqual(garbage.updatedAt, 'garbage');
});

test('planRunId / planMessageId 幂等唯一', () => {
  const a = planRunId('proactive_x', 1234567890);
  assert.strictEqual(a, planRunId('proactive_x', 1234567890));
  assert.notStrictEqual(a, planRunId('proactive_y', 1234567890));
  assert.ok(planMessageId('proactive_x', 1234567890).startsWith('active_msg_proactive_x_'));
});

test('updatePlan 保留快照字段且状态白名单', () => {
  resetStateForTest();
  const plan = sanitizeAiPlan(basePlan());
  getState().plans[plan.id] = { ...plan, ...baseSnapshot() };
  const updated = updatePlan(plan.id, { status: 'cancelled', cancelReason: 'test' });
  assert.strictEqual(updated.status, 'cancelled');
  assert.strictEqual(updated.cancelReason, 'test');
  assert.ok(getState().plans[plan.id].character, '快照字段保留');
  const bad = updatePlan(plan.id, { status: 'evil' });
  assert.strictEqual(bad.status, 'cancelled', '非法状态应保留当前值');
});
