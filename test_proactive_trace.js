'use strict';
/* Internal Beyond — Proactive Observability Trace 测试套件（Node 内置 test runner，零依赖）
   运行：node --test test_proactive_trace.js
   覆盖：ring buffer / 脱敏 / disabled no-op / begin-append-set-finish / compat-retry 观测、
         model_call 步骤记录。 */
const test = require('node:test');
const assert = require('node:assert');
const createProactiveTrace = require('./active/proactive-trace.js');
const createModelClient = require('./active/model-client.js');

/* ── 纯 trace 模块单测 ── */

test('trace：ring buffer 限制与 recent(n) 新→旧排序', () => {
  const t = createProactiveTrace({ enabled: true, limit: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(t.begin({ kind: 'plan', planId: 'p' + i, traceId: 'trace__' + i }));
  for (const id of ids) t.finish(id, 'sent', {});
  assert.strictEqual(t.count(), 3);
  const all = t.recent(10);
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[0].planId, 'p4');    /* 最新在前 */
  assert.strictEqual(all[2].planId, 'p2');    /* 最旧（被裁剪）排在最后 */
  const two = t.recent(2);
  assert.strictEqual(two.length, 2);
  assert.strictEqual(two[0].planId, 'p4');
});

test('trace：disabled 时 begin 返回 null，append/set/finish/recent 全部无副作用', () => {
  const t = createProactiveTrace({ enabled: false, limit: 10 });
  const id = t.begin({ kind: 'plan', planId: 'p1' });
  assert.strictEqual(id, null);
  t.append(null, 'model_call', true, 'success', '');
  t.set(null, { compatRetry: true });
  t.finish(null, 'sent', {});
  assert.strictEqual(t.recent(10).length, 0);
  assert.strictEqual(t.count(), 0);
  assert.strictEqual(t.enabled(), false);
});

test('trace：脱敏——丢弃 apiKey，截断长字符串与 validation.reason', () => {
  const t = createProactiveTrace({ enabled: true, limit: 10 });
  const id = t.begin({
    kind: 'plan',
    planId: 'p1',
    characterId: 'c1',
    apiKey: 'SECRET-KEY-123',       /* 必须被丢弃 */
    apiKeyHeader: 'Bearer SECRET',   /* 必须被丢弃 */
    intent: 'x'.repeat(500),
    reason: 'y'.repeat(500),
    validation: { ok: false, reason: 'r'.repeat(500) },
    content: '完整消息不应保存',      /* 非白名单，应被丢弃 */
    messages: [{ role: 'user', content: 'full prompt' }] /* 非白名单，应被丢弃 */
  });
  t.append(id, 'validation', false, 'invalid', 'z'.repeat(500));
  t.set(id, { compatRetry: true, compatRetryKind: 'jsonMode' });
  t.finish(id, 'failed', { errorType: 'http', retryAt: '2026-01-01T00:00:00.000Z' });
  const rec = t.recent(1)[0];
  assert.strictEqual(rec.apiKey, undefined);
  assert.strictEqual(rec.apiKeyHeader, undefined);
  assert.strictEqual(rec.content, undefined);
  assert.strictEqual(rec.messages, undefined);
  assert.ok(rec.intent.length <= 200);
  assert.ok(rec.reason.length <= 200);
  assert.strictEqual(rec.compatRetry, true);
  assert.strictEqual(rec.compatRetryKind, 'jsonMode');
  assert.strictEqual(rec.errorType, 'http');
  /* steps detail 截断 */
  const step = rec.steps.find(s => s.stage === 'validation');
  assert.ok(step.detail.length <= 200);
});

test('trace：begin/append/set/finish 记录步骤、durationMs、outcome', () => {
  const t = createProactiveTrace({ enabled: true, limit: 10 });
  const id = t.begin({ kind: 'task', taskId: 'task1', characterName: '角色A' });
  t.append(id, 'context', true, 'counts', 'mem:2,msg:5,proactive:1');
  t.append(id, 'model_call', true, 'success', '');
  t.set(id, { compatRetry: false, generationAttempts: 1 });
  t.finish(id, 'sent', { sentMessageId: 'msg_1' });
  const rec = t.recent(1)[0];
  assert.strictEqual(rec.kind, 'task');
  assert.strictEqual(rec.outcome, 'sent');
  assert.strictEqual(rec.sentMessageId, 'msg_1');
  assert.strictEqual(rec.generationAttempts, 1);
  assert.strictEqual(rec.steps.length, 2);
  assert.strictEqual(rec.steps[0].stage, 'context');
  assert.strictEqual(rec.steps[0].ok, true);
  assert.ok(rec.durationMs >= 0);
  assert.ok(rec.finishedAt != null);
});

/* ── compat-retry 观测（经 model-client → port 计数装饰器，不改 Harness 契约） ── */

test('compat-retry：第一次 jsonMode 被拒 → 第二次降级，trace 记 compatRetry=jsonMode', async () => {
  let calls = 0;
  const stubFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'response_format unsupported json mode' } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok', reasoning_content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) };
  };
  const trace = createProactiveTrace({ enabled: true, limit: 10 });
  const mc = createModelClient({
    getState: () => ({ history: {} }),
    trimText: (v, l) => String(v == null ? '' : v).slice(0, l),
    finiteTimestamp: v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; },
    mergeRecentProactiveMessages: () => [],
    maxAttempts: 3,
    similarityLimit: 0.82,
    fetch: stubFetch,
    proactiveTrace: trace
  });
  const traceId = trace.begin({ kind: 'plan', planId: 'p1', characterId: 'c1', apiKey: 'SECRET' });
  const task = { character: { provider: 'openai', model: 'gpt-test', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', apiKey: '' } };
  const prompt = { system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
  const out = await mc.callCharacterModel(task, prompt, { jsonMode: true, traceId });
  assert.strictEqual(out.content, 'ok');
  assert.strictEqual(calls, 2); /* 触发了一次降级重试 */
  trace.finish(traceId, 'sent', {});
  const rec = trace.recent(1)[0];
  assert.strictEqual(rec.compatRetry, true);
  assert.strictEqual(rec.compatRetryKind, 'jsonMode');
  assert.strictEqual(rec.apiKey, undefined);
  assert.ok(rec.steps.some(s => s.stage === 'model_call' && s.ok === true));
});
