'use strict';

/* Internal Beyond · P25-3C-Node · Active Message Companion Runtime Convergence
   （NC1–NC10；纯 Node、零真实网络、零真实 Key、零 OS 通知）

   本套件用**真实 service 执行链**（services/active-message-service.js → active/scheduler.js）
   证明：Node companion 的发送出口（executeTask / executePlan）不再自行判断 send，
   而是把 candidate + 既有 facts 交给与 Browser **共用的同一个** Active Message Authority。

   事实（cooldown / duplicate / quiet-hours / enabled）仍然只有一份实现：
     · quiet-hours ← 既有 BG-AI 闸门 _bgAiGateState()
     · cooldown    ← 既有 adaptiveSkipReason()（12 小时顺延）
     · duplicate   ← 既有 model-client validateProactiveReply()（0.82 + 同开头）

   运行方式与 test_proactive_phase2.js 相同：数据目录隔离 + global.fetch 场景桩。 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').toUpperCase();
const SCHEDULER_SRC = read('active/scheduler.js');
const SERVICE_SRC = read('services/active-message-service.js');

process.env.IB_PROACTIVE_TRACE = 'on';
process.env.IB_ACTIVE_DISABLE_NOTIFICATIONS = '1';
process.env.IB_ACTIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-am-node-'));

/* ── 先在**模块对象**上装权威探针，再 require service：service 的 ctx 拿到的是同一个对象，
      因此调度器运行时的每一次裁决都会经过这里（与生产同一条代码路径）。 ── */
const AUTHORITY = require(path.join(ROOT, 'assets/js/active-message-authority.js'));
const REAL_RUN = AUTHORITY.runActiveMessageSend;
const authorityCalls = [];
let authorityMode = 'real';       /* 'real' | 'deny' | 'missing' */
AUTHORITY.runActiveMessageSend = function (candidate, facts, executor) {
  authorityCalls.push({ candidate: JSON.parse(JSON.stringify(candidate)), facts: Object.assign({}, facts) });
  if (authorityMode === 'deny') {
    return Promise.resolve({ ok: false, decision: 'deny', reason: 'quiet-hours', executed: false,
      actorId: candidate.actorId, targetId: candidate.targetId, message: null, error: '' });
  }
  return REAL_RUN(candidate, facts, executor);
};

/* ── global.fetch 场景桩（service 构建时捕获全局 fetch）── */
global.__scenario = 'send_ok';
global.__fetchCalls = 0;
function okJson(content) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: content, reasoning_content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) };
}
global.fetch = async (url, opts) => {
  global.__fetchCalls += 1;
  const bodyStr = String(opts && opts.body || '');
  const isGen = bodyStr.indexOf('请主动向') >= 0;
  if (!isGen) return okJson('{"action":"send","reason":"可以发送"}');
  if (global.__scenario === 'modelFailure') throw new Error('network down');
  if (global.__scenario === 'dedup') return okJson('完全相同的主动消息文本');
  return okJson('一条主动消息正文');
};

const service = require(path.join(ROOT, 'services', 'active-message-service.js'));
const { sanitizeAiPlan, executePlan, executeTask, getState, setArmed, resetStateForTest, proactiveTrace } = service;

function setupPlan(o, snapO) {
  const now = Date.now();
  const plan = sanitizeAiPlan(Object.assign({
    id: 'p_node', characterId: 'char_1', user_id: 'user_test',
    status: 'scheduled', source: 'ai_planned',
    createdAt: new Date(now - 60000).toISOString(), updatedAt: new Date(now - 60000).toISOString(),
    scheduledAt: new Date(now - 1000).toISOString(),
    intent: '询问任务进度', reason: '用户表示稍后处理',
    cancelConditions: { cancelIfUserReplies: false, cancelIfIntentResolved: false, cancelIfNewerPlanExists: true, respectDoNotDisturb: false },
    constraints: { maxAttempts: 1, allowReschedule: true, allowFollowUpPlan: false },
    attemptCount: 0,
    prefs: { enabled: true, mode: 'ai', minIntervalMinutes: 30, maxPlanHours: 168, dndStart: '23:00', dndEnd: '08:00' }
  }, o || {}));
  getState().plans[plan.id] = Object.assign({}, plan, Object.assign({
    character: { id: 'char_1', provider: 'openai', apiKey: 'sk', model: 'gpt-test', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', nickname: '测试角色', relationship: '挚友' },
    user: { id: 'user_test', name: '用户' },
    recent_memories: [], recent_messages: [], recent_proactive_messages: [], chat_summary: '', last_interaction_at: now - 60000
  }, snapO || {}));
  return plan.id;
}
function setupTask(o, snapO) {
  const now = Date.now();
  const task = Object.assign({
    setting: Object.assign({ id: 't1', user_id: 'user_test', character_id: 'char_1', enabled: true, background_enabled: true,
      frequency: 'interval', schedule: { time: '09:00', days: [], interval_value: 24, interval_unit: 'hours', timezone: 'local' },
      message_type: 'greeting', custom_instruction: '', adaptive_enabled: false,
      next_run_at: now - 1000, last_sent: null, created_at: now, updated_at: now }, o || {}),
    character: { id: 'char_1', provider: 'openai', apiKey: 'sk', model: 'gpt-test', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', nickname: '测试角色', relationship: '挚友' },
    user: { id: 'user_test', name: '用户' },
    recent_memories: [], recent_messages: [], recent_proactive_messages: [], chat_summary: '', last_interaction_at: now - 60000, task_revision: 1
  }, snapO || {});
  getState().tasks['t1'] = task;
  return 't1';
}
function reset(scenario) {
  global.__scenario = scenario || 'send_ok';
  global.__fetchCalls = 0;
  resetStateForTest();
  setArmed('user_test');
  proactiveTrace.reset();
  authorityCalls.length = 0;
  authorityMode = 'real';
}
const sentEvents = () => Object.values(getState().events).filter(e => e.status === 'sent');
const skippedEvents = () => Object.values(getState().events).filter(e => e.status === 'skipped');
const canceledEvents = () => Object.values(getState().events).filter(e => e.status === 'canceled');
const failedEvents = () => Object.values(getState().events).filter(e => e.status === 'failed');

console.log('== P25-3C-Node · Active Message Companion Runtime Convergence ==');

/* ── NC1 Node trigger reaches authority（任务 + 计划两条触发）──────────── */
test('NC1: TASK 触发经共享权威，candidate/facts 来自既有身份与既有闸门', async () => {
  reset('send_ok');
  const taskId = setupTask();
  await executeTask(taskId, Date.now() - 1000);
  assert.strictEqual(authorityCalls.length, 1, '一次发送必须恰好一次权威裁决');
  const call = authorityCalls[0];
  assert.strictEqual(call.candidate.actorId, 'char_1');
  assert.strictEqual(call.candidate.targetId, 'user_test');
  assert.strictEqual(call.candidate.source, 'schedule');
  assert.strictEqual(call.candidate.trigger, 'schedule');
  assert.ok(call.candidate.triggerRef.indexOf('t1') >= 0, 'triggerRef 是既有 run id');
  /* Node 侧只组装原始字段；candidateId 由**共享**权威确定性派生（同一契约、同一算法）。 */
  const derived = AUTHORITY.buildActiveMessageCandidate(call.candidate);
  assert.ok(derived.ok === true && derived.candidate.candidateId.indexOf('amc_') === 0, JSON.stringify(derived));
  assert.strictEqual(derived.candidate.candidateId, AUTHORITY.buildActiveMessageCandidate(call.candidate).candidate.candidateId, '身份确定性');
  assert.strictEqual(call.facts.actorKnown, true);
  assert.strictEqual(call.facts.targetKnown, true);
  assert.strictEqual(call.facts.enabled, true);
  assert.strictEqual(call.facts.quietHours, false);
  assert.strictEqual(call.facts.duplicate, false);
});

test('NC1b: PLAN 触发经共享权威，source=plan / trigger=ai_plan', async () => {
  reset('send_ok');
  const planId = setupPlan({ id: 'p_node1' });
  await executePlan(planId);
  assert.strictEqual(authorityCalls.length, 1);
  assert.strictEqual(authorityCalls[0].candidate.source, 'plan');
  assert.strictEqual(authorityCalls[0].candidate.trigger, 'ai_plan');
  assert.strictEqual(authorityCalls[0].candidate.triggerRef, planId);
  assert.strictEqual(authorityCalls[0].candidate.actorId, 'char_1');
  assert.strictEqual(authorityCalls[0].candidate.targetId, 'user_test');
});

/* ── NC2 authority deny blocks send ──────────────────────────────────── */
test('NC2: DENY ⇒ 任务不发送（skipped 事件 + next_run 前进 + 零 retry）', async () => {
  reset('send_ok');
  const taskId = setupTask();
  const before = getState().tasks[taskId].setting.next_run_at;
  authorityMode = 'deny';
  await executeTask(taskId, Date.now() - 1000);
  const st = getState();
  assert.strictEqual(sentEvents().length, 0, 'DENY 不得产生 sent 事件');
  assert.strictEqual(skippedEvents().length, 1);
  assert.ok(String(skippedEvents()[0].reason).indexOf('quiet-hours') >= 0);
  assert.strictEqual(st.history[skippedEvents()[0].run_id].status, 'skipped');
  assert.ok(st.tasks[taskId].setting.next_run_at > before, 'next_run_at 照常前进（既有策略跳过形状）');
  assert.strictEqual(st.tasks[taskId].setting.last_sent, null, 'DENY 不得更新 last_sent');
  assert.strictEqual(global.__fetchCalls, 1, 'DENY 不触发额外模型调用（生成已发生，接缝后不 retry）');
});

test('NC2b: DENY ⇒ 计划标记 cancelled + canceled 事件（不发送、不 retry）', async () => {
  reset('send_ok');
  const planId = setupPlan({ id: 'p_node2' });
  authorityMode = 'deny';
  await executePlan(planId);
  const plan = getState().plans[planId];
  assert.strictEqual(plan.status, 'cancelled');
  assert.ok(String(plan.cancelReason || '').indexOf('主动消息被拒绝') >= 0);
  assert.strictEqual(canceledEvents().length, 1);
  assert.strictEqual(sentEvents().length, 0);
  assert.strictEqual(failedEvents().length, 0, 'DENY 不是失败');
});

/* ── NC3 authority allow sends once ──────────────────────────────────── */
test('NC3: ALLOW ⇒ 任务恰好发送一次（sent 事件 + history + last_sent）', async () => {
  reset('send_ok');
  const taskId = setupTask();
  await executeTask(taskId, Date.now() - 1000);
  const st = getState();
  assert.strictEqual(sentEvents().length, 1);
  const ev = sentEvents()[0];
  assert.strictEqual(ev.status, 'sent');
  assert.strictEqual(ev.character_id, 'char_1');
  assert.strictEqual(ev.user_id, 'user_test');
  assert.ok(ev.message_id);
  assert.strictEqual(st.history[ev.run_id].status, 'sent');
  assert.strictEqual(st.tasks[taskId].setting.last_sent > 0, true);
  assert.strictEqual(authorityCalls.length, 1, 'ALLOW 只裁决一次、只发送一次');
});

test('NC3b: ALLOW ⇒ 计划进入 waiting_for_user 且恰好一次 sent 事件', async () => {
  reset('send_ok');
  const planId = setupPlan({ id: 'p_node3' });
  await executePlan(planId);
  const plan = getState().plans[planId];
  assert.strictEqual(plan.status, 'waiting_for_user');
  assert.strictEqual(sentEvents().length, 1);
  assert.strictEqual(authorityCalls.length, 1);
});

/* ── NC4 no direct send bypass（静态 + fail closed 动态）─────────────── */
test('NC4: 无直发旁路（唯一接缝 + 权威缺席 fail closed）', async () => {
  /* 静态：只有接缝调用共享权威；'sent' 事件只在 auth.ok 之后构造 */
  assert.strictEqual(SCHEDULER_SRC.split('_sendRequest(').length - 1, 3, '接缝定义 + 任务 + 计划共三处');
  assert.strictEqual(SCHEDULER_SRC.split('_authorizeSend(').length - 1, 2, '唯一裁决入口（定义 + 接缝内调用）');
  assert.strictEqual(SCHEDULER_SRC.split('runActiveMessageSend').length - 1, 2, '权威面只有"能力探测 + 一个调用点"两处');
  assert.strictEqual(SCHEDULER_SRC.split('authority.runActiveMessageSend(').length - 1, 1, '权威调用点唯一');
  const authCallAt = SCHEDULER_SRC.indexOf('authority.runActiveMessageSend(');
  assert.ok(authCallAt > SCHEDULER_SRC.indexOf('async function _authorizeSend(')
    && authCallAt < SCHEDULER_SRC.indexOf('async function _sendRequest('), '唯一调用点在 _authorizeSend 内（其它路径无法绕过）');
  assert.ok(SCHEDULER_SRC.indexOf("require('../assets/js/active-message-authority.js')") >= 0, '复用共享模块（不复制 Node 版权威）');
  assert.ok(SCHEDULER_SRC.indexOf('NodeActiveMessageAuthority') < 0 && SCHEDULER_SRC.indexOf('function _nodeAuthority') < 0);
  /* 每个 "status: 'sent'" 都必须在 auth 检查之后 */
  const taskAuth = SCHEDULER_SRC.indexOf('const auth = await _sendRequest({');
  const planAuth = SCHEDULER_SRC.indexOf('const auth = await _sendRequest({', taskAuth + 10);
  const taskSent = SCHEDULER_SRC.indexOf("status: 'sent'");
  const planSent = SCHEDULER_SRC.indexOf("planEvent(claim, 'sent'");
  assert.ok(taskAuth >= 0 && taskAuth < taskSent, '任务的 sent 事件在授权之后');
  assert.ok(planAuth >= 0 && planAuth < planSent, '计划的 sent 事件在授权之后');
  /* 动态：权威面不可用 ⇒ fail closed（零发送） */
  reset('send_ok');
  const taskId = setupTask();
  const saved = AUTHORITY.runActiveMessageSend;
  delete AUTHORITY.runActiveMessageSend;
  try {
    await executeTask(taskId, Date.now() - 1000);
  } finally {
    AUTHORITY.runActiveMessageSend = saved;
  }
  assert.strictEqual(sentEvents().length, 0, '权威缺席不得发送');
  assert.strictEqual(skippedEvents().length, 1);
  assert.ok(String(skippedEvents()[0].reason).indexOf('authority-missing') >= 0, String(skippedEvents()[0].reason));
  /* 计划同一条接缝 */
  reset('send_ok');
  const planId = setupPlan({ id: 'p_node4' });
  const saved2 = AUTHORITY.runActiveMessageSend;
  delete AUTHORITY.runActiveMessageSend;
  try {
    await executePlan(planId);
  } finally {
    AUTHORITY.runActiveMessageSend = saved2;
  }
  assert.strictEqual(sentEvents().length, 0);
  assert.strictEqual(getState().plans[planId].status, 'cancelled');
  assert.ok(String(getState().plans[planId].cancelReason).indexOf('authority-missing') >= 0);
});

/* ── NC5 cooldown preserved ─────────────────────────────────────────── */
test('NC5: 冷却仍然是既有 12 小时规则（生成前生效；接缝喂同一事实）', async () => {
  reset('send_ok');
  const taskId = setupTask({ adaptive_enabled: true }, {
    recent_messages: [{ role: 'user', content: '刚说了话', timestamp: Date.now() - 60 * 60 * 1000 }]
  });
  assert.ok(service.adaptiveSkipReason(getState().tasks[taskId]).indexOf('12 小时') >= 0);
  await executeTask(taskId, Date.now() - 1000);
  assert.strictEqual(sentEvents().length, 0, '既有顺延仍然阻止发送');
  assert.strictEqual(authorityCalls.length, 0, '既有闸门在生成之前就命中（无需走权威）');
  assert.strictEqual(global.__fetchCalls, 0, '不消耗模型调用');
  assert.ok(SCHEDULER_SRC.indexOf('cooldown: !!adaptiveSkipReason(task)') >= 0, '接缝把同一规则作为事实喂给权威');
  assert.ok(SCHEDULER_SRC.indexOf('function adaptiveSkipReason(task) {') >= 0, '冷却实现未被改写');
  assert.ok(SCHEDULER_SRC.indexOf('12 * 3600000') >= 0);
});

/* ── NC6 duplicate preserved（没有第二套实现）────────────────────────── */
test('NC6: 去重仍然是既有规则（0.82 + 同开头），Node 不新增第二套', async () => {
  /* 静态：调度器内没有任何相似度实现；duplicate 只来自 ctx.validateProactiveReply */
  const SCHEDULER_CODE = SCHEDULER_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(SCHEDULER_SRC.indexOf('validateProactiveReply') >= 0);
  assert.ok(SCHEDULER_CODE.indexOf('proactiveTextSimilarity') < 0 && SCHEDULER_CODE.indexOf('0.82') < 0,
    'scheduler 不得自带相似度实现');
  assert.ok(SCHEDULER_CODE.indexOf('similarityLimit') < 0, '相似度阈值仍然只有一份（model-client）');
  /* 既有 dedup 场景：生成期重试 + 兜底后仍然发送（语义未变） */
  reset('dedup');
  const taskId = setupTask({}, { recent_proactive_messages: [{ content: '完全相同的主动消息文本', sent_at: Date.now() - 3600000 }] });
  await executeTask(taskId, Date.now() - 1000);
  assert.strictEqual(sentEvents().length, 1, '既有生成期去重/兜底流程照常发送');
  assert.strictEqual(authorityCalls.length, 1);
  assert.strictEqual(authorityCalls[0].facts.duplicate, false, '兜底文案不是重复（既有语义）');
  /* 探针缺席时的 fail closed 分支存在（源码守卫；动态由 NC4 覆盖同一条 fail-closed 路径） */
  assert.ok(SCHEDULER_SRC.indexOf("reason: 'duplicate-probe-missing'") >= 0);
});

/* ── NC7 identity preserved ─────────────────────────────────────────── */
test('NC7: 身份只用 canonical id（不是昵称 / displayName）', async () => {
  reset('send_ok');
  const taskId = setupTask({}, { character: { id: 'char_1', provider: 'openai', apiKey: 'sk', model: 'gpt-test',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions', nickname: '测试角色（不是 id）' } });
  await executeTask(taskId, Date.now() - 1000);
  const call = authorityCalls[0];
  assert.strictEqual(call.candidate.actorId, 'char_1');
  assert.ok(call.candidate.actorId.indexOf('测试角色') < 0);
  assert.ok(call.candidate.targetId.indexOf('用户') < 0 && call.candidate.targetId === 'user_test');
  assert.ok(SCHEDULER_SRC.indexOf('actorId: setting.character_id') >= 0);
  assert.ok(SCHEDULER_SRC.indexOf('targetId: userId') >= 0);
  assert.ok(SCHEDULER_SRC.indexOf('actorId: plan.characterId') >= 0);
});

/* ── NC8 failure semantics preserved ────────────────────────────────── */
test('NC8: failure ≠ deny（模型失败走既有兜底；不可用状态走既有 failed 且不经权威）', async () => {
  /* (a) 任务：模型失败 → 既有兜底文案 → 仍然经权威（ALLOW）后发送；不产生 failed 事件 */
  reset('modelFailure');
  const taskId = setupTask();
  await executeTask(taskId, Date.now() - 1000);
  assert.strictEqual(sentEvents().length, 1, '既有兜底流程照常发送');
  assert.strictEqual(sentEvents()[0].generatedByFallback, true);
  assert.strictEqual(authorityCalls.length, 1, '兜底文案同样要过权威');
  assert.strictEqual(failedEvents().length, 0);
  /* (b) 计划：角色 API 配置不完整 → 既有 failed（发生在接缝之前）⇒ 不经权威、不产生 deny */
  reset('send_ok');
  const planId = setupPlan({ id: 'p_node8', constraints: { maxAttempts: 1, allowReschedule: true, allowFollowUpPlan: false } },
    { character: { id: 'char_1', provider: 'openai', apiKey: '', model: '', endpoint: '', nickname: '测试角色' } });
  await executePlan(planId);
  assert.strictEqual(getState().plans[planId].status, 'failed');
  assert.strictEqual(failedEvents().length, 1);
  assert.strictEqual(authorityCalls.length, 0, '失败发生在接缝之外 ⇒ 不产生 deny（失败 ≠ 拒绝）');
  assert.strictEqual(sentEvents().length, 0);
  assert.ok(SERVICE_SRC.indexOf('validateProactiveReply') >= 0 && SERVICE_SRC.indexOf('recentProactiveMessages') >= 0,
    '事实探针由 service 注入（与 Browser 共享同一权威对象）');
});

/* ── NC9 scheduler unchanged ────────────────────────────────────────── */
test('NC9: 调度时序 / claim / retry / 免打扰语义未改', async () => {
  for (const needle of [
    'if (aiHibernate) break;',
    'const s2 = getState();',
    'missed trigger window by',
    'executionId: `exec_',
    'const retryAt = new Date(Date.now() + 15 * 60000).toISOString();',
    'if (plan.cancelConditions && plan.cancelConditions.respectDoNotDisturb && isInDnd(now, prefs)) {',
    'schedulerInterval = setInterval(() => {',
    '}, 15000);',
    'prefillSeed: (out && out.prefillSeed)'
  ]) {
    assert.ok(SCHEDULER_SRC.indexOf(needle) >= 0, '调度器语义缺失: ' + needle);
  }
  /* ALLOW 路径的时间语义与既有实现一致（next_run_at 基于 sentAt） */
  reset('send_ok');
  const taskId = setupTask();
  const beforeNext = getState().tasks[taskId].setting.next_run_at;
  await executeTask(taskId, Date.now() - 1000);
  const after = getState().tasks[taskId].setting;
  assert.ok(after.last_sent > 0 && after.next_run_at > after.last_sent, 'last_sent / next_run_at 语义不变');
  assert.ok(after.next_run_at > beforeNext);
});

/* ── NC10 Browser behavior unchanged（守卫）─────────────────────────── */
test('NC10: Browser 侧与共享权威逐字节未变，Browser 套件仍登记', () => {
  const expect = (file, head, tail) => {
    const h = sha(file);
    assert.ok(h.startsWith(head) && h.endsWith(tail), file + ' 必须逐字节未变：' + h);
  };
  expect('assets/js/active-message-authority.js', 'CC2A8BF9', 'AE3892C4');
  expect('assets/js/active-diary.js', 'D14D4AC6', '89ADE8CA');
  expect('assets/js/active-diary/active-plans.js', '7975ADBD', '245CE860');
  expect('assets/js/agent-orchestration-active-message-adapter.js', 'C1984C7F', '988C0DEE');
  const testAll = read('tests/test-all.js');
  assert.ok(testAll.indexOf("['test_active_message_authority.js']") >= 0);
  assert.ok(testAll.indexOf("['test_agent_orchestration_active_message_adapter.js']") >= 0);
  assert.ok(testAll.indexOf("['test_active_message_node_convergence.js']") >= 0);
});
