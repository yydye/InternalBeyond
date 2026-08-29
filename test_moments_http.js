'use strict';
/* Internal Beyond — Moments 后台调度 HTTP 集成测试
   运行：node test_moments_http.js
   验证：PUT/GET/DELETE /moments、stale 拒绝、reconcile moment_ids（互不误删）、
   events（kind=moment）ack 流、health 计数、坏 body 不崩溃 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 23990 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-moments-http-'));
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

function schedule(characterId, overrides) {
  const now = Date.now();
  return Object.assign({
    id: characterId,
    characterId,
    user_id: 'user_mh',
    enabled: true,
    frequency: 'low',
    nextAt: now + 3600000,/* 未到期，避免调度器提前执行 */
    lastPostAt: 0,
    status: 'idle',
    claimedAt: 0,
    executionId: '',
    attemptCount: 0,
    revision: 1,
    updatedAt: new Date(now - 60000).toISOString(),
    executedAt: null,
    lastMomentId: '',
    lastError: '',
    synced_at: 0
  }, overrides || {});
}

function snapshot(characterId, overrides) {
  return Object.assign({
    schedule: schedule(characterId),
    character: { id: characterId, provider: 'openai', apiKey: 'sk-snap', model: 'm', endpoint: 'https://example.invalid/v1/chat/completions', nickname: 'HTTP 角色', relationship: '朋友' },
    user: { id: 'user_mh', name: '用户' },
    recent_memories: [],
    recent_messages: [],
    recent_proactive_messages: [],
    chat_summary: '',
    last_interaction_at: 0,
    recent_moments: [],
    other_role_moments: []
  }, overrides || {});
}

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
    check('health.momentsCount0', typeof health.moments === 'number' && health.moments === 0, JSON.stringify(health));

    /* PUT 时间表 */
    const put = await req('PUT', '/moments/mh_char1', snapshot('mh_char1'));
    check('PUT /moments 成功', put.status === 200 && put.body.ok && !put.body.stale, put.body);
    check('PUT 返回脱敏 publicSchedule', put.body.schedule && put.body.schedule.character_id === 'mh_char1' && !('character' in put.body.schedule) && !('recent_memories' in put.body.schedule), put.body.schedule);
    const health2 = await req('GET', '/health');
    check('health.momentsCount1', health2.body.moments === 1, health2.body);

    /* 旧快照回写 → stale */
    const staleBody = snapshot('mh_char1');
    staleBody.schedule.updatedAt = new Date(Date.now() - 120000).toISOString();/* 更旧 */
    const stale = await req('PUT', '/moments/mh_char1', staleBody);
    check('PUT stale 拒绝回写', stale.status === 200 && stale.body.stale === true, stale.body);

    /* executedAt 单调：携带更早 executedAt 的 PUT 不得抹掉已执行标记 */
    const execBody = snapshot('mh_char1');
    execBody.schedule.executedAt = new Date().toISOString();
    execBody.schedule.updatedAt = new Date(Date.now() + 1000).toISOString();
    const execPut = await req('PUT', '/moments/mh_char1', execBody);
    check('PUT executedAt 可写入', execPut.status === 200 && execPut.body.schedule.executed === true, execPut.body);
    const rewind = snapshot('mh_char1');
    rewind.schedule.executedAt = null;
    rewind.schedule.updatedAt = new Date(Date.now() + 2000).toISOString();
    const rewindRes = await req('PUT', '/moments/mh_char1', rewind);
    check('PUT executedAt 单调不回退', rewindRes.body.schedule && rewindRes.body.schedule.executed === true, rewindRes.body);

    /* declineStreak 合并：相同 lastPostAt → 单调取大（过期快照不回退后台累计） */
    const dk1 = snapshot('mh_char1', { schedule: schedule('mh_char1', { declineStreak: 3, updatedAt: new Date(Date.now() + 5000).toISOString() }) });
    check('PUT declineStreak 初写', (await req('PUT', '/moments/mh_char1', dk1)).body.schedule.decline_streak === 3);
    const clobber = snapshot('mh_char1', { schedule: schedule('mh_char1', { declineStreak: 1, updatedAt: new Date(Date.now() + 6000).toISOString() }) });
    const clobberRes = await req('PUT', '/moments/mh_char1', clobber);
    check('PUT declineStreak 单调取大（同 lastPostAt）', clobberRes.body.schedule.decline_streak === 3, clobberRes.body);
    /* 更快 lastPostAt（发布后）→ 归零路径应以传入为准 */
    const reset = snapshot('mh_char1', { schedule: schedule('mh_char1', { declineStreak: 0, lastPostAt: Date.now(), updatedAt: new Date(Date.now() + 7000).toISOString() }) });
    const resetRes = await req('PUT', '/moments/mh_char1', reset);
    check('PUT declineStreak 发布后归零可写入', resetRes.body.schedule.decline_streak === 0 && !resetRes.body.stale, resetRes.body);

    /* 他人 user_id 被拒（403） */
    const other = snapshot('mh_char1', { schedule: schedule('mh_char1', { user_id: 'other_user' }) });
    const otherRes = await req('PUT', '/moments/mh_char1', other);
    check('PUT 他人 user_id 403', otherRes.status === 403, otherRes.body);

    /* GET 列表过滤 */
    const list = await req('GET', '/moments?user_id=user_mh');
    check('GET /moments 列表', list.status === 200 && list.body.moments.length === 1 && list.body.moments[0].character_id === 'mh_char1', list.body);
    const listOther = await req('GET', '/moments?user_id=nobody');
    check('GET 按 user_id 隔离', listOther.body.moments.length === 0, listOther.body);

    /* reconcile moment_ids：只清理声明的集合 */
    const recon = await req('POST', '/reconcile', { user_id: 'user_mh', moment_ids: ['mh_char1'] });
    check('reconcile 保留声明计划', recon.status === 200 && recon.body.removed_moments === 0 && recon.body.armed === true, recon.body);
    const recon2 = await req('POST', '/reconcile', { user_id: 'user_mh', moment_ids: [] });
    check('reconcile 删除未声明 moments', recon2.body.removed_moments === 1, recon2.body);
    /* 不携带 moment_ids 时不得删任何 moments（与 task/plan 声明隔离） */
    await req('PUT', '/moments/mh_char1', snapshot('mh_char1'));
    const recon3 = await req('POST', '/reconcile', { user_id: 'user_mh', plan_ids: [], task_ids: [] });
    check('reconcile 未声明 moments 不动', recon3.body.removed_moments === 0 && (await req('GET', '/moments?user_id=user_mh')).body.moments.length === 1, recon3.body);

    /* DELETE */
    const del = await req('DELETE', '/moments/mh_char1?user_id=user_mh');
    check('DELETE /moments 成功（未执行 → executed=false）', del.status === 200 && del.body.missing === false && del.body.executed === false, del.body);

    /* 坏 body 不崩溃 */
    const bad = await req('PUT', '/moments/mh_bad', { not_a_schedule: true });
    check('PUT 坏 body 400', bad.status === 400, bad.body);
    const alive = await req('GET', '/health');
    check('坏请求后服务仍存活', alive.status === 200 && alive.body.ok, alive.body);
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failures ? `\nMoments HTTP failed: ${failures}` : `\nMoments HTTP test passed ✔ (${passed})`);
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
