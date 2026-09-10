'use strict';
/* ====================================================================
   后台 AI 总开关贯穿 companion（P1-07）回归测试。
   运行：node test_bgai_propagation.js
   覆盖：
     A. /bg-ai HTTP 路由：浏览器把 enabled/sleep 推到 companion 并持久化。
     B. companion 调度器 gate：总关（enabled=false）时已同步的到期任务/计划
        不得执行（无 history/events 产生），朋友圈仍作为例外继续；恢复开启后
        任务仍存在（不删除、不制造重复），并恢复执行语义。
   ==================================================================== */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const fs = require('fs');

const PORT = 23200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-bgai-prop-'));

/* 本进程的数据目录隔离（P7 测试隔离契约）：partB() 在**同进程内**
   require(path.join(ROOT, 'services', 'active-message-service.js'))（见下方 bgAi gate 用例），而 service 在
   require 时即从 IB_ACTIVE_DATA_DIR 计算 DATA_DIR。启动子进程的那一处已单独注入
   DATA_DIR，但同进程这次 require 仍会落到真实的 %LOCALAPPDATA%\InternalBeyond\ 并
   经 schedulerTick → saveNow 写盘。故这里必须给本进程另设一个隔离目录，且刻意与
   子进程的 DATA_DIR 分开——否则两个进程会并发写同一个 JSON（EPERM unlink）。 */
process.env.IB_ACTIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-bgai-prop-proc-'));

let failures = 0;
let passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`✔ ${name}`); }
  else { failures++; console.error(`✖ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(BASE + urlPath, { method, headers: data ? { 'Content-Type': 'application/json' } : {} }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { let parsed = null; try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; } resolve({ status: res.statusCode, body: parsed }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function waitForHealth(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await req('GET', '/health'); if (r.status === 200 && r.body.ok) return r.body; } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

/* ---- Part B：直接用 module 驱动 schedulerTick（不启动 HTTP，快速、确定） ---- */
async function partB() {
  const service = require(path.join(ROOT, 'services', 'active-message-service.js'));

  const { resetStateForTest, getState, setArmed, schedulerTick } = service;
  resetStateForTest();
  setArmed('user_bgai');
  const s0 = getState();
  /* 到期任务（已同步到 companion 的 background 手动任务） */
  s0.tasks['task_bgai'] = {
    setting: {
      id: 'task_bgai', user_id: 'user_bgai', character_id: 'char_bgai', enabled: true,
      schedule: { time: '09:00', days: [], interval_value: 24, interval_unit: 'hours', timezone: 'local' },
      frequency: 'daily', message_type: 'greeting', custom_instruction: '',
      background_enabled: true, adaptive_enabled: false, last_sent: null,
      next_run_at: Date.now() - 2000, created_at: Date.now(), updated_at: Date.now()
    },
    character: { id: 'char_bgai', provider: 'custom', apiKey: '', model: 'm', endpoint: 'http://127.0.0.1:1/v1/chat/completions', nickname: 'BG' }
  };
  /* 到期 AI 计划 */
  s0.plans['plan_bgai'] = {
    id: 'plan_bgai', characterId: 'char_bgai', user_id: 'user_bgai', type: 'proactive_chat',
    status: 'scheduled', source: 'ai_planned', createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(), scheduledAt: new Date(Date.now() - 2000).toISOString(),
    intent: '测试计划', reason: '测试', cancelConditions: { cancelIfUserReplies: false, cancelIfIntentResolved: false, cancelIfNewerPlanExists: false, respectDoNotDisturb: false },
    constraints: { maxAttempts: 1, allowReschedule: false, allowFollowUpPlan: false }, attemptCount: 0,
    prefs: { enabled: true, mode: 'ai', minIntervalMinutes: 30, maxPlanHours: 168, dndStart: '23:00', dndEnd: '08:00' },
    character: { id: 'char_bgai', provider: 'custom', apiKey: '', model: 'm', endpoint: 'http://127.0.0.1:1/v1/chat/completions', nickname: 'BG' },
    user: { id: 'user_bgai', name: '用户' }, recent_memories: [], recent_messages: [], recent_proactive_messages: [], chat_summary: ''
  };

  /* ① 总关：schedulerTick 不得执行任务/计划（无 history、无事件），任务仍保留 */
  getState().bgAi = { enabled: false, sleepStart: '', sleepEnd: '' };
  await schedulerTick();
  check('off.noTaskExecuted', Object.keys(getState().history).length === 0 && Object.keys(getState().events).length === 0, { history: Object.keys(getState().history), events: Object.keys(getState().events) });
  check('off.taskRetained', !!getState().tasks['task_bgai'] && !!getState().plans['plan_bgai'], '关闭不删除已同步任务/计划');

  /* ② 恢复开启：schedulerTick 恢复执行语义（history 出现执行/失败记录 → 确实尝试了 AI 调用） */
  getState().bgAi = { enabled: true, sleepStart: '', sleepEnd: '' };
  await schedulerTick();
  check('on.resumesExecution', Object.keys(getState().history).length > 0, { history: Object.keys(getState().history) });
  check('on.taskStillPresent', !!getState().tasks['task_bgai'] && !!getState().plans['plan_bgai'], '恢复后不制造重复（任务仍为同一份）');
}

/* ---- Part A：子进程 HTTP 路由验证 ---- */
(async () => {
  const child = spawn(process.execPath, ['services/active-message-service.js'], {
    env: { ...process.env, IB_ACTIVE_PORT: String(PORT), IB_ACTIVE_START_DELAY_MS: '500', IB_ACTIVE_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childOut = '';
  child.stdout.on('data', c => childOut += c);
  child.stderr.on('data', c => childOut += c);
  try {
    const health = await waitForHealth(15000);
    check('companion 启动并响应 /health', !!health, { childOut: childOut.slice(-500) });
    if (health) {
      /* A① 默认启用 */
      let g = await req('GET', '/bg-ai');
      check('route.defaultEnabled', g.status === 200 && g.body.enabled === true);
      /* A② 关闭传播 + 持久化 */
      let p = await req('POST', '/bg-ai', { enabled: false, sleepStart: '23:00', sleepEnd: '08:00' });
      check('route.postOff', p.status === 200 && p.body.ok === true && p.body.bgAi.enabled === false);
      g = await req('GET', '/bg-ai');
      check('route.getOff', g.status === 200 && g.body.enabled === false && g.body.sleepStart === '23:00' && g.body.sleepEnd === '08:00');
      /* A③ 恢复开启 */
      p = await req('POST', '/bg-ai', { enabled: true, sleepStart: '', sleepEnd: '' });
      g = await req('GET', '/bg-ai');
      check('route.getOn', g.status === 200 && g.body.enabled === true && g.body.sleepStart === '');
    }
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 300));
  }
  /* Part B 在 HTTP 检查后执行（模块级，独立于子进程） */
  try { await partB(); } catch (e) { failures++; console.error('✖ partB 抛错 — ' + String(e && e.message || e)); }
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
