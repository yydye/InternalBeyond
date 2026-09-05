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

    /* ── ownership 403 → 显式 reown 单角色自愈（本机 user_id churn 接管）── */
    const rn = snapshot('mh_reown', { schedule: schedule('mh_reown', { user_id: 'user_old' }) });
    check('reown: 先以 owner-A 创建', (await req('PUT', '/moments/mh_reown', rn)).status === 200);
    const rnOther = snapshot('mh_reown', { schedule: schedule('mh_reown', { user_id: 'user_new' }) });
    const rn403 = await req('PUT', '/moments/mh_reown', rnOther);
    check('reown: 不带 reown 的 owner 不一致仍 403', rn403.status === 403 && rn403.body.error === 'Moment schedule does not belong to this user', rn403.body);
    const rnOwn = snapshot('mh_reown', { schedule: schedule('mh_reown', { user_id: 'user_new', updatedAt: new Date(Date.now() + 1000).toISOString() }) });
    rnOwn.reown = true;
    const rnOk = await req('PUT', '/moments/mh_reown', rnOwn);
    check('reown: 显式 reown 接管成功', rnOk.status === 200 && rnOk.body.schedule && rnOk.body.schedule.character_id === 'mh_reown', rnOk.body);
    /* 接管后：新 owner 不带 reown 也能正常回写（owner 已切换） */
    const rnAfter = snapshot('mh_reown', { schedule: schedule('mh_reown', { user_id: 'user_new', updatedAt: new Date(Date.now() + 2000).toISOString() }) });
    check('reown: 接管后新 owner 正常 PUT', (await req('PUT', '/moments/mh_reown', rnAfter)).status === 200);
    /* 其他角色不受影响：owner-A 的 mh_char1 已删，owner-A 仍能创建/写其他角色 */
    check('reown: 不影响其他角色（新 owner 写另一角色成功）', (await req('PUT', '/moments/mh_other', snapshot('mh_other'))).status === 200);
    /* Origin 禁止：伪造非 loopback Origin 即使带 reown 也一律 403（不可被自愈绕过） */
    const originForbid = await new Promise((resolve, reject) => {
      const data = JSON.stringify(rnOwn);
      const r = http.request(BASE + '/moments/mh_reown', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example.com' } }, res => {
        let raw = ''; res.on('data', c => raw += c);
        res.on('end', () => { let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch (_) { b = { raw }; } resolve({ status: res.statusCode, body: b }); });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
    check('reown: Origin 禁止仍 403 不可绕过', originForbid.status === 403 && originForbid.body.error === 'Origin is not allowed', originForbid.body);
    /* cleanup 本轮自愈测试角色 */
    await req('DELETE', '/moments/mh_reown?user_id=user_new');
    await req('DELETE', '/moments/mh_other?user_id=user_mh');

    /* ── Credential Vault v1：独立 /credentials sync + 业务剥离 + Origin ── */
    const creds = await req('POST', '/credentials', { credentials: [
      { characterId: 'cv_a', provider: 'deepseek', apiKey: 'sk-cv-a-AAAA', endpoint: 'https://e', model: 'm-a' },
      { characterId: 'friend_1785260690497', provider: 'qwen', apiKey: 'sk-p7LH', model: 'qwen-plus' },
      { characterId: 'friend_1788318367937', provider: 'qwen', apiKey: 'sk-jJag', model: 'qwen3.8-max' }
    ] });
    check('POST /credentials 存储 3 个', creds.status === 200 && creds.body.stored === 3, creds.body);
    check('POST /credentials 响应不回传完整 Key', !JSON.stringify(creds.body).match(/sk-(cv-a-AAAA|p7LH|jJag)/), creds.body);
    const credOrigin = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ credentials: [{ characterId: 'cv_o', apiKey: 'sk-o' }] });
      const r = http.request(BASE + '/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example.com' } }, res => {
        let raw = ''; res.on('data', c => raw += c);
        res.on('end', () => { let b = {}; try { b = raw ? JSON.parse(raw) : {}; } catch (_) { b = { raw }; } resolve({ status: res.statusCode, body: b }); });
      });
      r.on('error', reject); r.write(data); r.end();
    });
    check('POST /credentials Origin 仍被拒（403，不可绕过）', credOrigin.status === 403 && credOrigin.body.error === 'Origin is not allowed', credOrigin.body);
    /* 业务 snapshot 即使携带 apiKey，落盘也不含明文 key（strip 纵深防御） */
    const sp = snapshot('cv_probe');
    sp.character.apiKey = 'sk-CV-PLAINTEXT-PROBE';
    await req('PUT', '/moments/cv_probe', sp);
    const persisted = fs.readFileSync(path.join(DATA_DIR, 'active-message-service.json'), 'utf8');
    check('23114 业务 JSON 不持久化明文 apiKey', persisted.indexOf('sk-CV-PLAINTEXT-PROBE') === -1, 'plaintext leak in business state');
    /* vault 文件存在且不含明文 key */
    const vaultRaw = fs.existsSync(path.join(DATA_DIR, 'credential-vault.json')) ? fs.readFileSync(path.join(DATA_DIR, 'credential-vault.json'), 'utf8') : '';
    check('credential-vault.json 已生成且不含明文', vaultRaw !== '' && vaultRaw.indexOf('sk-cv-a-AAAA') === -1, 'plaintext vault');
    await req('DELETE', '/moments/cv_probe?user_id=user_mh');

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
