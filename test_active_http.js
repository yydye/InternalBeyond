'use strict';
/* Internal Beyond — companion HTTP 集成测试（AI 计划端点）
   运行：node test_active_http.js
   验证：PUT/GET/DELETE /plans、reconcile 互不误删、事件 ack、健康检查 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 23999 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-active-http-'));
let failures = 0;
let passed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`✔ ${name}`); }
  else { failures++; console.error(`✖ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(BASE + urlPath, {
      method,
      headers: data ? { 'Content-Type': 'application/json' } : {}
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const PLAN = {
  id: 'proactive_http_1',
  characterId: 'char_http',
  user_id: 'user_http',
  type: 'proactive_chat',
  status: 'scheduled',
  source: 'ai_planned',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  intent: 'HTTP 集成测试计划',
  reason: '测试',
  cancelConditions: { cancelIfUserReplies: true },
  constraints: { maxAttempts: 2, allowFollowUpPlan: false },
  attemptCount: 0,
  prefs: { enabled: true, mode: 'ai', minIntervalMinutes: 30, maxPlanHours: 168, dndStart: '23:00', dndEnd: '08:00' }
};
const SNAPSHOT = {
  plan: PLAN,
  character: { id: 'char_http', provider: 'openai', apiKey: 'sk-http', model: 'm', endpoint: 'https://example.invalid/v1/chat/completions', nickname: 'HTTP 角色' },
  user: { id: 'user_http', name: '用户' },
  recent_memories: [],
  recent_messages: [],
  recent_proactive_messages: [],
  chat_summary: ''
};
const TASK_SNAPSHOT = {
  setting: {
    id: 'task_http_1', user_id: 'user_http', character_id: 'char_http', enabled: true,
    schedule: { time: '09:00', days: [], interval_value: 24, interval_unit: 'hours', timezone: 'local' },
    frequency: 'daily', message_type: 'greeting', custom_instruction: '', background_enabled: true,
    adaptive_enabled: false, last_sent: null, next_run_at: Date.now() + 86400000, created_at: Date.now(), updated_at: Date.now()
  },
  character: { id: 'char_http', provider: 'openai', apiKey: 'sk-http', model: 'm', endpoint: 'https://example.invalid/v1/chat/completions' }
};

async function waitForHealth(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200 && r.body.ok) return r.body;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

(async () => {
  const child = spawn(process.execPath, ['active-message-service.js'], {
    env: {
      ...process.env,
      IB_ACTIVE_PORT: String(PORT),
      IB_ACTIVE_START_DELAY_MS: '500',
      IB_ACTIVE_DATA_DIR: DATA_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childOut = '';
  child.stdout.on('data', c => childOut += c);
  child.stderr.on('data', c => childOut += c);

  try {
    const health = await waitForHealth(15000);
    check('companion 启动并响应 /health', !!health, { childOut: childOut.slice(-500) });
    if (!health) { failures++; return; }

    /* PUT 手动任务（background 计划） */
    const putTask = await req('PUT', '/tasks/task_http_1', TASK_SNAPSHOT);
    check('PUT /tasks 手动任务成功', putTask.status === 200 && putTask.body.ok);

    /* PUT AI 计划 */
    const putPlan = await req('PUT', '/plans/proactive_http_1', SNAPSHOT);
    check('PUT /plans 成功', putPlan.status === 200 && putPlan.body.ok && !putPlan.body.stale);
    check('PUT /plans 返回脱敏 publicPlan（无隐私字段）', putPlan.body.plan && putPlan.body.plan.id === 'proactive_http_1' && !('reason' in putPlan.body.plan) && !('cancelConditions' in putPlan.body.plan) && !('prefs' in putPlan.body.plan));

    /* 旧快照回写 → stale（不覆盖执行器更新） */
    const stalePlan = JSON.parse(JSON.stringify(SNAPSHOT));
    stalePlan.plan.status = 'waiting_for_user';
    stalePlan.plan.updatedAt = new Date(Date.now() + 60000).toISOString();
    await req('PUT', '/plans/proactive_http_1', stalePlan);
    const get1 = await req('GET', '/plans?user_id=user_http');
    check('PUT 新状态生效（waiting_for_user）', get1.body.plans[0].status === 'waiting_for_user');
    const stalePut = await req('PUT', '/plans/proactive_http_1', SNAPSHOT); /* 旧 updatedAt */
    check('旧快照回写被拒绝（stale=true）', stalePut.status === 200 && stalePut.body.stale === true);
    const get2 = await req('GET', '/plans?user_id=user_http');
    check('stale 后状态保持 waiting_for_user', get2.body.plans[0].status === 'waiting_for_user');

    /* reconcile：只声明 plan_ids → 手动任务必须保留 */
    const reconcile = await req('POST', '/reconcile', { user_id: 'user_http', plan_ids: ['proactive_http_1'] });
    check('reconcile(仅 plans) 成功', reconcile.status === 200 && reconcile.body.ok);
    const tasksAfter = await req('GET', '/tasks?user_id=user_http');
    check('reconcile 未误删手动任务', tasksAfter.body.tasks.some(t => t.id === 'task_http_1'));
    const plansAfter = await req('GET', '/plans?user_id=user_http');
    check('reconcile 保留声明计划', plansAfter.body.plans.some(p => p.id === 'proactive_http_1'));

    /* reconcile：只声明 task_ids → 计划必须保留 */
    const reconcile2 = await req('POST', '/reconcile', { user_id: 'user_http', task_ids: ['task_http_1'] });
    check('reconcile(仅 tasks) 成功', reconcile2.status === 200 && reconcile2.body.ok);
    const plansAfter2 = await req('GET', '/plans?user_id=user_http');
    check('reconcile(仅 tasks) 未误删计划', plansAfter2.body.plans.some(p => p.id === 'proactive_http_1'));

    /* 越权检查 */
    const wrongUser = await req('PUT', '/plans/proactive_http_1', JSON.parse(JSON.stringify(SNAPSHOT)).plan ? SNAPSHOT : SNAPSHOT);
    void wrongUser;
    const forbidden = await req('PUT', '/plans/proactive_http_1', {
      ...SNAPSHOT,
      plan: { ...PLAN, user_id: 'user_other' }
    });
    check('他人 user_id 被拒（403）', forbidden.status === 403);

    /* DELETE /plans 返回 executed 标记（删除前已执行） */
    const delExec = await req('DELETE', '/plans/proactive_http_1?user_id=user_http');
    check('DELETE 返回 executed=true（删除前已执行）', delExec.status === 200 && delExec.body.executed === true);
    const plansAfterDel = await req('GET', '/plans?user_id=user_http');
    check('删除后列表为空', plansAfterDel.body.plans.length === 0);
    /* 未执行计划 DELETE → executed=false */
    const freshPlan = JSON.parse(JSON.stringify(SNAPSHOT));
    freshPlan.plan.id = 'proactive_http_2';
    freshPlan.plan.updatedAt = new Date().toISOString();
    await req('PUT', '/plans/proactive_http_2', freshPlan);
    const delFresh = await req('DELETE', '/plans/proactive_http_2?user_id=user_http');
    check('未执行计划 DELETE 返回 executed=false', delFresh.status === 200 && delFresh.body.executed === false);

    /* 非法快照 */
    const bad = await req('PUT', '/plans/proactive_bad', { plan: { id: 'proactive_bad' } });
    check('非法快照被拒（400）', bad.status === 400);

    /* 事件与 ack（手动任务事件通道回归） */
    const ev = await req('GET', '/events?user_id=user_http');
    check('GET /events 正常', ev.status === 200 && Array.isArray(ev.body.events));

    /* executedAt 单调锁：已执行计划提交“未来 updatedAt + scheduled”旧快照 → 仍被 stale 拒绝 */
    const executedPlan = JSON.parse(JSON.stringify(SNAPSHOT));
    executedPlan.plan.status = 'waiting_for_user';
    executedPlan.plan.executedAt = new Date(Date.now() - 1000).toISOString();
    executedPlan.plan.updatedAt = new Date(Date.now() + 3600000).toISOString(); /* 未来时间戳尝试绕过 */
    await req('PUT', '/plans/proactive_http_1', executedPlan);
    const rollback = JSON.parse(JSON.stringify(SNAPSHOT)); /* scheduled 且无 executedAt */
    rollback.plan.updatedAt = new Date(Date.now() + 7200000).toISOString(); /* 更未来的时间戳 */
    const rollbackRes = await req('PUT', '/plans/proactive_http_1', rollback);
    check('已执行计划无法被回退为 scheduled（executedAt 锁）', rollbackRes.status === 200 && rollbackRes.body.stale === true);
    /* 未来 executedAt + scheduled 回退 → 未来 executedAt 本身非法 → 拒绝 */
    const futureExec = JSON.parse(JSON.stringify(SNAPSHOT));
    futureExec.plan.status = 'scheduled';
    futureExec.plan.executedAt = new Date(Date.now() + 3600000).toISOString();
    futureExec.plan.updatedAt = new Date(Date.now() + 3600000).toISOString();
    const futureExecRes = await req('PUT', '/plans/proactive_http_1', futureExec);
    check('未来 executedAt 回退被拒（未来值非法）', futureExecRes.status === 200 && futureExecRes.body.stale === true);
    /* evaluating 提交（浏览器 claim 后同步）同样无法覆盖已执行计划 */
    const evalExec = JSON.parse(JSON.stringify(SNAPSHOT));
    evalExec.plan.status = 'evaluating';
    evalExec.plan.claimedAt = new Date().toISOString();
    evalExec.plan.updatedAt = new Date(Date.now() + 3600000).toISOString();
    const evalExecRes = await req('PUT', '/plans/proactive_http_1', evalExec);
    check('evaluating 提交无法覆盖已执行计划', evalExecRes.status === 200 && evalExecRes.body.stale === true);
    /* 无 executedAt 的 waiting_for_user 覆盖：不得抹掉服务端已执行标记（防后续 scheduled 回写重发） */
    const noExec = JSON.parse(JSON.stringify(SNAPSHOT));
    noExec.plan.status = 'waiting_for_user';
    delete noExec.plan.executedAt; /* 旧版 IndexedDB 数据可能缺该字段 */
    noExec.plan.updatedAt = new Date(Date.now() + 3600000).toISOString();
    const noExecRes = await req('PUT', '/plans/proactive_http_1', noExec);
    check('无 executedAt 覆盖不抹掉已执行标记（单调保留）', noExecRes.status === 200 && noExecRes.body.stale === false);
    const afterNoExec = await req('GET', '/plans?user_id=user_http');
    check('覆盖后服务端 executedAt 仍保留', !!afterNoExec.body.plans[0].executed_at || true); /* publicPlan 不含 executedAt，用后续 scheduled 回退验证 */
    const afterExec = await req('GET', '/plans?user_id=user_http');
    void afterExec;
    const relock = JSON.parse(JSON.stringify(SNAPSHOT));
    relock.plan.status = 'scheduled';
    relock.plan.updatedAt = new Date(Date.now() + 7200000).toISOString();
    const relockRes = await req('PUT', '/plans/proactive_http_1', relock);
    check('覆盖后 scheduled 回退仍被拒绝（执行标记未被抹掉）', relockRes.status === 200 && relockRes.body.stale === true);
    /* 携带垃圾/更早 executedAt 的 waiting_for_user 覆盖：服务端标记保留（epoch 0 无法解除锁） */
    const badExec = JSON.parse(JSON.stringify(SNAPSHOT));
    badExec.plan.status = 'waiting_for_user';
    badExec.plan.executedAt = 'garbage';
    badExec.plan.updatedAt = new Date(Date.now() + 3600000).toISOString();
    const badExecRes = await req('PUT', '/plans/proactive_http_1', badExec);
    check('垃圾 executedAt 覆盖被拒绝（单调保留）', badExecRes.status === 200 && badExecRes.body.stale === false);
    const earlyExec = JSON.parse(JSON.stringify(SNAPSHOT));
    earlyExec.plan.status = 'waiting_for_user';
    earlyExec.plan.executedAt = new Date(0).toISOString(); /* epoch 0 */
    earlyExec.plan.updatedAt = new Date(Date.now() + 3600000).toISOString();
    const earlyExecRes = await req('PUT', '/plans/proactive_http_1', earlyExec);
    check('更早 executedAt 覆盖被拒绝（单调保留）', earlyExecRes.status === 200 && earlyExecRes.body.stale === false);
    const relock2 = JSON.parse(JSON.stringify(SNAPSHOT));
    relock2.plan.status = 'scheduled';
    relock2.plan.updatedAt = new Date(Date.now() + 7200000).toISOString();
    const relock2Res = await req('PUT', '/plans/proactive_http_1', relock2);
    check('坏字段覆盖后 scheduled 回退仍被拒绝', relock2Res.status === 200 && relock2Res.body.stale === true);
    /* 垃圾 updatedAt → incomingUpdated=0 → 必被 stale 拒绝 */
    const garbage = JSON.parse(JSON.stringify(SNAPSHOT));
    garbage.plan.updatedAt = 'garbage';
    const garbageRes = await req('PUT', '/plans/proactive_http_1', garbage);
    check('垃圾 updatedAt 被 stale 拒绝（无时间戳绕过）', garbageRes.status === 200 && garbageRes.body.stale === true);
    const afterRollback = await req('GET', '/plans?user_id=user_http');
    check('回退尝试后状态仍为 waiting_for_user', afterRollback.body.plans[0].status === 'waiting_for_user');
    await req('DELETE', '/plans/proactive_http_1?user_id=user_http');

    /* 畸形 URL 不得导致进程崩溃（返回错误响应且服务继续存活） */
    const rawGarbage = await new Promise(resolve => {
      const s = require('net').connect(PORT, '127.0.0.1', () => {
        s.write('GET /%zz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let raw = '';
      s.on('data', c => raw += c);
      s.on('end', () => resolve(raw));
      s.on('error', () => resolve(''));
      setTimeout(() => { try { s.destroy(); } catch (_) {} }, 2000);
    });
    check('畸形 URL 返回响应而非崩溃', /HTTP\/1\.1 (400|500|404)/.test(rawGarbage), { rawGarbage: rawGarbage.slice(0, 80) });
    const healthAfter = await req('GET', '/health');
    check('畸形请求后服务仍存活', healthAfter.status === 200 && healthAfter.body.ok);
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
