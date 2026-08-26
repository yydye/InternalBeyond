'use strict';
/* Internal Beyond — Moments 后台调度（companion）测试套件（Node 内置 test runner，零依赖）
   运行：node --test test_moments_companion.js
   覆盖：sanitize/解析/去重、executeMomentSchedule（发布/不发布/去重/最小间隔/未 armed）、
   schedulerTick 集成（因 moments 失败不停止）、崩溃回收、事件与 executedAt 单调。 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
/* 隔离状态文件：在 require 之前指向临时目录，避免测试污染用户真实 companion 状态 */
process.env.IB_ACTIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-moments-cmp-'));
const service = require('./active-message-service.js');

const {
  sanitizeMomentSchedule, publicMomentSchedule, parseMomentOutput, buildMomentPrompt,
  executeMomentSchedule, momentsTick, schedulerTick, getState, setArmed, resetStateForTest
} = service;

/* ── mock 模型端点（按请求体 model 区分行为） ── */
let mockPort = 0;
let mockRequests = 0;
function startMockModel() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      mockRequests += 1;
      let model = '';
      try { model = String(JSON.parse(body || '{}').model || ''); } catch (_) { /* ignore */ }
      let content;
      if (model === 'c2-dec') content = JSON.stringify({ publish: false, reason: '今天没有值得分享的事', content: '' });
      else if (model === 'c3-dup') content = JSON.stringify({ publish: true, content: '同一句话重复发布的测试。', visibility: 'all' });
      else content = JSON.stringify({ publish: true, content: '后台生成的动态内容。', visibility: 'all', includeImage: true, imagePrompt: 'a casual photo' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function snapshot(overrides) {
  return Object.assign({
    schedule: undefined,
    character: {
      id: 'c1', provider: 'openai', apiKey: 'sk-mock', model: 'c1-ok',
      endpoint: `http://127.0.0.1:${mockPort}/v1/chat/completions`, nickname: '测试角色', relationship: '朋友'
    },
    user: { id: 'u1', name: '用户' },
    recent_memories: [],
    recent_messages: [
      { role: 'user', content: '今天加班到很晚', timestamp: Date.now() - 3600000, source: '' },
      { role: 'assistant', content: '辛苦了', timestamp: Date.now() - 3500000, source: '' }
    ],
    recent_proactive_messages: [],
    chat_summary: '用户今天加班',
    last_interaction_at: Date.now() - 3600000,
    recent_moments: [],
    other_role_moments: []
  }, overrides || {});
}

function seedSchedule(characterId, extra) {
  const now = Date.now();
  return {
    id: characterId,
    characterId,
    user_id: 'u1',
    enabled: true,
    frequency: 'low',
    nextAt: now - 1000,
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
    synced_at: 0,
    ...(extra || {})
  };
}

test.before(async () => {
  const mock = await startMockModel();
  mockPort = mock.port;
  test.mockServer = mock.server;
});

test.after(() => {
  try { if (test.mockServer) test.mockServer.close(); } catch (_) {}
});

test.beforeEach(() => {
  resetStateForTest();
  setArmed('u1');
  mockRequests = 0;
});

test('sanitizeMomentSchedule 默认值与白名单', () => {
  const s = sanitizeMomentSchedule(seedSchedule('c1'));
  assert.strictEqual(s.id, 'c1');
  assert.strictEqual(s.characterId, 'c1');
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.frequency, 'low');
  assert.ok(s.nextAt > 0);
  const legacy = sanitizeMomentSchedule({ character_id: 'legacy', user_id: 'u9' });
  assert.strictEqual(legacy.characterId, 'legacy');
  assert.strictEqual(legacy.frequency, 'medium');
  assert.strictEqual(legacy.status, 'idle');
});

test('publicMomentSchedule 脱敏（无 snapshot/密钥字段）', () => {
  const s = sanitizeMomentSchedule(seedSchedule('c1'));
  const pub = publicMomentSchedule(s);
  assert.strictEqual(pub.character_id, 'c1');
  assert.ok('next_at' in pub);
  assert.ok('executed' in pub);
  assert.ok(!('character' in pub) && !('recent_memories' in pub));
});

test('parseMomentOutput：发布/不发布/非法/容错', () => {
  assert.deepStrictEqual(parseMomentOutput('{"publish":true,"content":"路边看到一只猫","visibility":"all"}'), {
    publish: true, content: '路边看到一只猫', visibility: 'all', visibleRoleIds: [], reason: ''
  });
  assert.deepStrictEqual(parseMomentOutput('```json\n{"publish":false,"reason":"无事可记"}\n```'), { publish: false, reason: '无事可记' });
  assert.strictEqual(parseMomentOutput('{"publish":true}'), null);
  assert.strictEqual(parseMomentOutput(''), null);
  assert.strictEqual(parseMomentOutput('not json'), null);
  /* includeImage 字段被忽略（后台纯文字），不崩溃 */
  const withImg = parseMomentOutput('{"publish":true,"content":"猫","visibility":"all","includeImage":true,"imagePrompt":"x"}');
  assert.strictEqual(withImg.content, '猫');
  assert.ok(!('includeImage' in withImg));
});

test('buildMomentPrompt 包含角色/时间/上下文与"纯文字"约束', () => {
  const snap = snapshot();
  snap.schedule = seedSchedule('c1');
  const built = buildMomentPrompt({ character: snap.character, user: snap.user, ...snap });
  assert.ok(built.messages.length === 2);
  const userContent = built.messages[1].content;
  assert.ok(userContent.includes('测试角色'));
  assert.ok(userContent.includes('今天加班到很晚'));
  assert.ok(userContent.includes('只输出一个 JSON 对象'));
  assert.ok(userContent.includes('纯文字'));
});

test('executeMomentSchedule：发布成功 → 事件/moment/nextAt/executedAt', async () => {
  const snap = snapshot();
  getState().moments.c1 = { ...snap, ...seedSchedule('c1') };
  const res = await executeMomentSchedule('c1');
  assert.strictEqual(res.published, true);
  const moment = res.moment;
  assert.ok(/^mom_/.test(moment.id));
  assert.strictEqual(moment.content, '后台生成的动态内容。');
  assert.strictEqual(moment.source, 'proactive');
  assert.deepStrictEqual(moment.images, []);/* 后台纯文字 */
  const state = getState();
  assert.ok(state.moments.c1.nextAt > Date.now());
  assert.ok(state.moments.c1.executedAt);
  assert.strictEqual(state.moments.c1.lastMomentId, moment.id);
  const events = Object.values(state.events).filter(e => e.kind === 'moment' && e.status === 'moment_sent');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].moment.id, moment.id);
  assert.strictEqual(events[0].user_id, 'u1');
});

test('executeMomentSchedule：模型选择不发布', async () => {
  const snap = snapshot();
  snap.character.model = 'c2-dec';
  getState().moments.c2 = { ...snap, ...seedSchedule('c2') };
  const res = await executeMomentSchedule('c2');
  assert.strictEqual(res.published, false);
  assert.ok(/没有值得分享/.test(res.reason));
  assert.ok(getState().moments.c2.nextAt > Date.now());/* 按频率重排 */
  assert.strictEqual(Object.values(getState().events).filter(e => e.kind === 'moment').length, 0);
});

test('executeMomentSchedule：去重（同内容二次 → 失败，只产出一条）', async () => {
  const snap = snapshot();
  snap.character.model = 'c3-dup';
  getState().moments.c3 = { ...snap, ...seedSchedule('c3') };
  const first = await executeMomentSchedule('c3');
  assert.strictEqual(first.published, true);
  const s1 = getState().moments.c3;
  s1.nextAt = Date.now() - 1000;/* 立即到期再跑 */
  s1.lastPostAt = 0;/* 专门验证去重：绕开最短间隔保护（真实场景中间隔保护会优先拦截） */
  const second = await executeMomentSchedule('c3');
  assert.strictEqual(second.failed, true);
  assert.ok(/相似/.test(second.error));
  const produced = getState().events && Object.values(getState().events).filter(e => e.kind === 'moment' && e.status === 'moment_sent');
  assert.strictEqual(produced.length, 1);
});

test('executeMomentSchedule：最短发布间隔 → 跳过', async () => {
  const snap = snapshot();
  getState().moments.c1 = { ...snap, ...seedSchedule('c1', { lastPostAt: Date.now() - 60000 }) };
  const res = await executeMomentSchedule('c1');
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.reason, 'min interval');
  assert.strictEqual(Object.values(getState().events).filter(e => e.kind === 'moment').length, 0);
});

test('executeMomentSchedule：未 armed 用户不执行', async () => {
  const snap = snapshot();
  getState().moments.c1 = { ...snap, ...seedSchedule('c1', { user_id: 'someone_else' }) };
  const res = await executeMomentSchedule('c1');
  assert.strictEqual(res, null);
});

test('schedulerTick：集成 moments 段（到期执行 + 失败不停止）', async () => {
  /* 一个正常到期角色 + 一个 endpoint 不可达的角色（mock 端口关闭的假象用坏 URL 代替） */
  const snap = snapshot();
  snap.character.model = 'c1-ok';
  getState().moments.c1 = { ...snap, ...seedSchedule('c1') };
  const bad = snapshot();
  bad.character.endpoint = 'http://127.0.0.1:1/v1/chat/completions';/* 拒绝连接 */
  bad.character.model = 'c1-ok';
  getState().moments.c_bad = { ...bad, ...seedSchedule('c_bad') };
  await schedulerTick();/* 不应抛异常 */
  assert.ok(getState().moments.c_bad.nextAt > Date.now());/* 失败后重排 */
  assert.ok(/failed|missed/i.test(getState().moments.c_bad.status) || getState().moments.c_bad.lastError);
  await schedulerTick();/* 再次运行不停止 */
  assert.ok(true);
});

test('momentsTick：running 崩溃回收（>10 分钟）', async () => {
  getState().moments.c4 = {
    ...snapshot(),
    ...seedSchedule('c4', { status: 'running', claimedAt: Date.now() - 11 * 60000 })
  };
  await momentsTick(Date.now());
  const s = getState().moments.c4;
  assert.ok(s.nextAt > Date.now());
  assert.ok(s.status === 'failed');
  assert.ok(/timed out/i.test(s.lastError));
});

test('schedulerTick 不影响既有计划/任务（regression 骨架）', async () => {
  /* 有 moments 调度在场时，scheduleTick 对空 tasks/plans 正常执行 */
  await schedulerTick();
  assert.deepStrictEqual(Object.keys(getState().tasks), []);
  assert.deepStrictEqual(Object.keys(getState().plans), []);
});

/* ══════════ 第三阶段：长期运行稳定性 ══════════ */

test('momentsTick 连续两次不重复发布（nextAt 前进 + 幂等）', async () => {
  const snap = snapshot();
  getState().moments.c1 = { ...snap, ...seedSchedule('c1') };
  await momentsTick(Date.now());
  const first = Object.values(getState().events).filter(e => e.kind === 'moment' && e.status === 'moment_sent');
  assert.strictEqual(first.length, 1);
  const s = getState().moments.c1;
  assert.ok(s.nextAt > Date.now() + 60000, 'nextAt 必须被推到未来');
  assert.strictEqual(s.status, 'idle');
  await momentsTick(Date.now());
  await momentsTick(Date.now());
  const total = Object.values(getState().events).filter(e => e.kind === 'moment' && e.status === 'moment_sent');
  assert.strictEqual(total.length, 1, '重复 tick 不得追加发布');
  assert.strictEqual(mockRequests, 1);
});

test('错过触发窗口过久（休眠/重启）→ 不补发，按频率重排', async () => {
  const snap = snapshot();
  getState().moments.c9 = { ...snap, ...seedSchedule('c9', { nextAt: Date.now() - 2 * 3600000 }) };
  const before = mockRequests;
  const res = await executeMomentSchedule('c9');
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.reason, 'missed window');
  assert.ok(getState().moments.c9.nextAt > Date.now());
  assert.strictEqual(getState().moments.c9.status, 'idle');
  assert.strictEqual(mockRequests, before, '错窗不得调用模型补发');
  const events = Object.values(getState().events).filter(e => e.kind === 'moment');
  assert.strictEqual(events.length, 0);
});

test('API 失败退避有界（30 分钟量级，非永久停止/无限重试）', async () => {
  const snap = snapshot();
  snap.character.endpoint = 'http://127.0.0.1:1/v1/chat/completions';
  getState().moments.c_bad = { ...snap, ...seedSchedule('c_bad') };
  const res = await executeMomentSchedule('c_bad');
  assert.strictEqual(res.failed, true);
  const s = getState().moments.c_bad;
  const backoff = s.nextAt - Date.now();
  assert.ok(backoff > 20 * 60000 && backoff <= 35 * 60000, `退避应在 ~30min，实际 ${Math.round(backoff / 60000)}min`);
  assert.notStrictEqual(s.status, 'running');
  /* 再次到期前 tick 不应反复打模型 */
  const before = mockRequests;
  await momentsTick(Date.now());
  assert.strictEqual(mockRequests - before, 0);
});

test('buildMomentPrompt 反空泛模板与 publish:false 正常化（与浏览器端镜像）', () => {
  const snap = snapshot();
  snap.schedule = seedSchedule('c1');
  const built = buildMomentPrompt({ character: snap.character, user: snap.user, ...snap });
  const text = built.messages[1].content;
  assert.ok(text.includes('拒绝空泛模板'));
  assert.ok(text.includes('今天阳光很好'));
  assert.ok(text.includes('publish:false'));
  assert.ok(text.includes('碎片化'));
});
