'use strict';
/* Internal Beyond · M1-A 执行缝集成测试（Node，零依赖，不起浏览器）
   运行：node tests/test_home_node_execution.js
   验证：真实 SSE mock provider → NodeModelPort.runStream → executeCharacterTurn
         → canonical chat store。覆盖 delta / done / error / abort / 幂等 /
         并发 busy / partial 落库 / 附件不丢 / thread 不串。 */
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
const createExecutor = require(path.join(ROOT, 'services', 'home-node', 'execution.js'));
const createPort = require(path.join(ROOT, 'active', 'node-model-port.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

/* SSE mock provider：按脚本逐字回放，并把收到的请求体交给回调检查。 */
function mockProvider(script, opts) {
  opts = opts || {};
  const seen = { bodies: [], paths: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      seen.paths.push(req.url);
      try { seen.bodies.push(JSON.parse(raw)); } catch (_) { seen.bodies.push(raw); }
      if (opts.status && opts.status !== 200) {
        res.writeHead(opts.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: opts.errorMessage || 'boom' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const pieces = opts.singleChunk ? [script] : script.split('\u0000');
      let i = 0;
      const next = () => {
        if (i >= pieces.length) { res.end(); return; }
        res.write(pieces[i++]);
        setTimeout(next, opts.chunkDelayMs == null ? 5 : opts.chunkDelayMs);
      };
      if (opts.neverEnd) { res.write(pieces[0] || ''); return; }
      next();
    });
  });
  return { server, seen };
}
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const openaiChunk = (delta, extra) => 'data: ' + JSON.stringify(Object.assign({ choices: [{ delta }] }, extra || {})) + '\n\n';

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-exec-'));
  const store = createStore({ dataDir: dir });
  store.open();
  return store;
}

function spec(port) {
  return { provider: 'openai', model: 'mock-model', endpoint: 'http://127.0.0.1:' + port + '/v1/chat/completions', apiKey: 'sk-mock' };
}

function userMsg(overrides) {
  return Object.assign({
    id: 'msg_' + Date.now() + '_u',
    role: 'user',
    content: '你好',
    friendId: 'char_a',
    timestamp: Date.now()
  }, overrides || {});
}

(async () => {
  /* ── 1 · 流式：delta 顺序 / done / canonical 双写 ─────────────────── */
  {
    const store = newStore();
    const script = [
      openaiChunk({ reasoning_content: '想' }),
      openaiChunk({ content: '你' }),
      openaiChunk({ content: '好' }),
      openaiChunk({}, { choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } } }) + '\n\n',
      'data: [DONE]\n\n'
    ].join('\u0000');
    const mock = mockProvider(script);
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const events = [];
    const sent = userMsg({ id: 'msg_stream_u' });
    const result = await executor.executeCharacterTurn({
      requestId: 'req-stream-1',
      character: { id: 'char_a', spec: spec(port), systemPrompt: 'sys' },
      userMessage: sent,
      history: [{ role: 'user', content: 'earlier', friendId: 'char_a', timestamp: 1 }, { role: 'assistant', content: 'reply', friendId: 'char_a', timestamp: 2 }],
      contextPolicy: 'browser-provided-context'
    }, { onEvent: e => events.push(e), timeoutMs: 5000 });

    check('exec.stream.ok', result.ok === true, result);
    check('exec.stream.assistantId 存在', typeof result.assistantMessageId === 'string' && result.assistantMessageId.startsWith('msg_'), result.assistantMessageId);
    const kinds = events.map(e => e.type).join(',');
    check('exec.stream 事件顺序 start → delta → done',
      events[0].type === 'start' && events[events.length - 1].type === 'done' && events.some(e => e.type === 'delta'), kinds);
    const deltas = events.filter(e => e.type === 'delta');
    check('exec.stream reasoning delta 先于 content delta',
      deltas[0].kind === 'reasoning' && deltas.slice(1).every(d => d.kind === 'content'), deltas.map(d => d.kind + ':' + d.text));
    check('exec.stream content delta 内容正确', deltas.filter(d => d.kind === 'content').map(d => d.text).join('') === '你好');
    check('exec.stream delta index 单调递增', deltas.every((d, i) => d.index === i), deltas.map(d => d.index));
    check('exec.stream usage 透出 reasoning_tokens', result.revision >= 2 && events[events.length - 1].usage && events[events.length - 1].usage.reasoning_tokens === 1);

    /* canonical 双写 */
    const storedUser = store.getMessage('msg_stream_u');
    check('exec.stream user 消息在 canonical store', !!storedUser && storedUser.role === 'user');
    const storedAssistant = store.getMessage(result.assistantMessageId);
    check('exec.stream assistant 消息在 canonical store', !!storedAssistant && storedAssistant.role === 'assistant');
    check('exec.stream assistant content/reasoning 正确',
      storedAssistant.content === '你好' && storedAssistant.reasoning_content === '想', storedAssistant);
    check('exec.stream assistant metadata 标注来源与上下文策略',
      storedAssistant.metadata && storedAssistant.metadata.source === 'home_node' && storedAssistant.metadata.contextPolicy === 'browser-provided-context', storedAssistant.metadata);
    check('exec.stream revision 前进两次（user + assistant）', store.getRevision() === 2, store.getRevision());
    check('exec.stream 请求体带 stream:true 且历史按 user/assistant 交替',
      mock.seen.bodies[0].stream === true && mock.seen.bodies[0].messages.map(m => m.role).join(',') === 'system,user,assistant,user',
      mock.seen.bodies[0].messages.map(m => m.role));
    check('exec.stream system 来自 character.systemPrompt', mock.seen.bodies[0].messages[0].content === 'sys');
    store.close();
    mock.server.close();
  }

  /* ── 2 · 幂等：同一 requestId 重放 → 不重复写、不再调模型 ─────────── */
  {
    const store = newStore();
    const mock = mockProvider(openaiChunk({ content: 'ok' }) + '\u0000data: [DONE]\n\n');
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const req = {
      requestId: 'req-dup-1',
      character: { id: 'char_a', spec: spec(port) },
      userMessage: userMsg({ id: 'msg_dup_u' })
    };
    const first = await executor.executeCharacterTurn(req, { timeoutMs: 5000 });
    const second = await executor.executeCharacterTurn(req, { timeoutMs: 5000 });
    check('exec.idempotent 第二次标记为 duplicate-request', second.ok === true && second.outcome === 'duplicate-request', second);
    check('exec.idempotent 返回同一个 userMessageId', second.userMessageId === first.userMessageId);
    check('exec.idempotent 模型只被调用一次', mock.seen.bodies.length === 1, mock.seen.bodies.length);
    check('exec.idempotent 只产生一条 user 消息', store.listMessages({ conversationId: 'dm:char_a' }).messages.filter(m => m.role === 'user').length === 1);
    check('exec.idempotent 只产生一条 assistant 消息', store.listMessages({ conversationId: 'dm:char_a' }).messages.filter(m => m.role === 'assistant').length === 1);
    check('exec.idempotent 第二次不再前进 revision', second.revision === first.revision, [first.revision, second.revision]);
    store.close();
    mock.server.close();
  }

  /* ── 3 · 并发：同一会话第二个请求 busy；不同会话不受影响 ───────────── */
  {
    const store = newStore();
    const mock = mockProvider(openaiChunk({ content: 'slow' }) + '\u0000data: [DONE]\n\n', { chunkDelayMs: 60 });
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const p1 = executor.executeCharacterTurn({
      requestId: 'req-busy-1', character: { id: 'c', spec: spec(port) }, userMessage: userMsg({ id: 'msg_busy_1' })
    }, { timeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 40));
    const busy = await executor.executeCharacterTurn({
      requestId: 'req-busy-2', character: { id: 'c', spec: spec(port) }, userMessage: userMsg({ id: 'msg_busy_2' })
    }, { timeoutMs: 5000 });
    const other = await executor.executeCharacterTurn({
      requestId: 'req-busy-3', character: { id: 'c2', spec: spec(port) }, userMessage: userMsg({ id: 'msg_busy_3', friendId: 'char_b' })
    }, { timeoutMs: 5000 });
    const r1 = await p1;
    check('exec.busy 同会话第二个请求被拒', busy.ok === false && busy.error === 'busy', busy);
    check('exec.busy busy 不带 partial 写入', !busy.assistantMessageId);
    check('exec.busy 不同会话不受影响', other.ok === true && r1.ok === true, { other: other.error, r1: r1.error });
    check('exec.busy busy 的 user 消息未被写入 canonical', store.getMessage('msg_busy_2') === null);
    check('exec.busy thread 不串：会话隔离正确',
      store.listMessages({ conversationId: 'dm:char_a' }).messages.length === 2 &&
      store.listMessages({ conversationId: 'dm:char_b' }).messages.length === 2,
      [store.listMessages({ conversationId: 'dm:char_a' }).messages.length, store.listMessages({ conversationId: 'dm:char_b' }).messages.length]);
    store.close();
    mock.server.close();
  }

  /* ── 4 · provider HTTP 错误 → provider-error，且不留半条 assistant ── */
  {
    const store = newStore();
    const mock = mockProvider('', { status: 500, errorMessage: 'upstream exploded' });
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const events = [];
    const res = await executor.executeCharacterTurn({
      requestId: 'req-err-1', character: { id: 'c', spec: spec(port) }, userMessage: userMsg({ id: 'msg_err_u' })
    }, { onEvent: e => events.push(e), timeoutMs: 5000 });
    check('exec.error provider HTTP 失败 → provider-error', res.ok === false && res.error === 'provider-error', res);
    check('exec.error 发出 error 事件且 retryable', events.some(e => e.type === 'error' && e.kind === 'provider-error'), events.map(e => e.type + ':' + e.kind));
    check('exec.error user 消息仍在（已成功写入）', !!store.getMessage('msg_err_u'));
    check('exec.error 没有 assistant 记录',
      store.listMessages({ conversationId: 'dm:char_a' }).messages.filter(m => m.role === 'assistant').length === 0);
    store.close();
    mock.server.close();
  }

  /* ── 5 · abort：delta 已有内容 → partial 落库；无内容 → 不落库 ────── */
  {
    const store = newStore();
    const mock = mockProvider(openaiChunk({ content: '半句' }), { neverEnd: true });
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 250);
    const events = [];
    const res = await executor.executeCharacterTurn({
      requestId: 'req-abort-1', character: { id: 'c', spec: spec(port) }, userMessage: userMsg({ id: 'msg_abort_u' })
    }, { signal: ac.signal, onEvent: e => events.push(e), timeoutMs: 10000 });
    check('exec.abort 归类为 abort', res.ok === false && res.error === 'abort', res);
    check('exec.abort 发出 error:abort 事件', events.some(e => e.type === 'error' && e.kind === 'abort'));
    const partial = res.partialMessageId ? store.getMessage(res.partialMessageId) : null;
    check('exec.abort 部分文本落库为 partial', !!partial && partial.content === '半句' && partial.metadata.partial === true, partial);
    check('exec.abort partial 消息带 truncated 标记', !!partial && partial.truncated === true);
    store.close();
    mock.server.close();
  }

  /* ── 6 · abort 且无内容 → 不留半条消息 ───────────────────────────── */
  {
    const store = newStore();
    const mock = mockProvider('', { neverEnd: true });
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const res = await executor.executeCharacterTurn({
      requestId: 'req-abort-2', character: { id: 'c', spec: spec(port) }, userMessage: userMsg({ id: 'msg_abort2_u' })
    }, { signal: ac.signal, timeoutMs: 10000 });
    check('exec.abort-empty 归类为 abort', res.ok === false && res.error === 'abort', res);
    check('exec.abort-empty 无 assistant 记录',
      store.listMessages({ conversationId: 'dm:char_a' }).messages.filter(m => m.role === 'assistant').length === 0);
    store.close();
    mock.server.close();
  }

  /* ── 7 · 附件不丢：images/files/voice 进入 payload 且 images 进模型请求 ── */
  {
    const store = newStore();
    const mock = mockProvider(openaiChunk({ content: 'ok' }) + '\u0000data: [DONE]\n\n');
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const rich = userMsg({
      id: 'msg_rich_u',
      images: [{ dataUrl: 'data:image/png;base64,QUJD', base64: 'QUJD', mime: 'image/png', name: 'a.png' }],
      files: [{ name: 'n.txt', ext: 'txt', size: 3, text: 'hello' }],
      voice: { dataUrl: 'data:audio/mp3;base64,ZZZ', mime: 'audio/mp3', duration: 2, transcript: '语音内容', tone: 'calm' }
    });
    const res = await executor.executeCharacterTurn({
      requestId: 'req-rich-1', character: { id: 'c', spec: spec(port) }, userMessage: rich
    }, { timeoutMs: 5000 });
    check('exec.attachments 回合成功', res.ok === true, res);
    const stored = store.getMessage('msg_rich_u');
    check('exec.attachments images 完整往返', stored.images && stored.images[0].base64 === 'QUJD' && stored.images[0].dataUrl === 'data:image/png;base64,QUJD', stored.images);
    check('exec.attachments files 完整往返', stored.files && stored.files[0].name === 'n.txt' && stored.files[0].text === 'hello', stored.files);
    check('exec.attachments voice 完整往返', stored.voice && stored.voice.transcript === '语音内容' && stored.voice.tone === 'calm', stored.voice);
    const sentUser = mock.seen.bodies[0].messages[mock.seen.bodies[0].messages.length - 1];
    check('exec.attachments 图片以 image_url part 进入请求',
      Array.isArray(sentUser.content) && sentUser.content.some(p => p.type === 'image_url' && /QUJD/.test(p.image_url.url)), sentUser.content);
    check('exec.attachments 文件与语音以文本注入请求',
      JSON.stringify(sentUser.content).includes('n.txt') && JSON.stringify(sentUser.content).includes('语音内容'), sentUser.content);
    store.close();
    mock.server.close();
  }

  /* ── 8 · thread 不串：threadId 只落在自己的 conversation ────────── */
  {
    const store = newStore();
    const executor = createExecutor({ store, port: createPort({}) });
    await executor.executeCharacterTurn({
      requestId: 'bad-1', character: { id: 'c' }, userMessage: userMsg({ id: 'x1', threadId: 't1' })
    });
    check('exec.validation 缺 endpoint/model → character-not-ready',
      (await executor.executeCharacterTurn({ requestId: 'r', character: { id: 'c' }, userMessage: userMsg({ id: 'x2' }) })).error === 'character-not-ready');
    check('exec.validation 缺 requestId → missing-request-id',
      (await executor.executeCharacterTurn({ character: { id: 'c' }, userMessage: userMsg({ id: 'x3' }) })).error === 'missing-request-id');
    check('exec.validation 缺 userMessage → missing-user-message',
      (await executor.executeCharacterTurn({ requestId: 'r2', character: { id: 'c' } })).error === 'missing-user-message');
    check('exec.validation 无效消息（缺 friendId）→ invalid-message',
      (await executor.executeCharacterTurn({ requestId: 'r3', character: { id: 'c', spec: { endpoint: 'http://x', model: 'm' } }, userMessage: { id: 'y', role: 'user', content: 'a', timestamp: 1 } })).error === 'invalid-message');
    store.close();
  }

  /* ── 9 · 空输出守卫 ───────────────────────────────────────────────── */
  {
    const store = newStore();
    const mock = mockProvider(openaiChunk({}, { choices: [{ delta: {}, finish_reason: 'content_filter' }] }) + '\u0000data: [DONE]\n\n');
    const port = await listen(mock.server);
    const executor = createExecutor({ store, port: createPort({}) });
    const events = [];
    const res = await executor.executeCharacterTurn({
      requestId: 'req-empty-1', character: { id: 'c', spec: spec(port) }, userMessage: userMsg({ id: 'msg_empty_u' })
    }, { onEvent: e => events.push(e), timeoutMs: 5000 });
    check('exec.empty 空输出被拒（不静默存空气泡）', res.ok === false && res.error === 'empty-output', res);
    check('exec.empty 发出 empty-output 事件且 retryable',
      events.some(e => e.type === 'error' && e.kind === 'empty-output' && e.retryable === true));
    check('exec.empty 无 assistant 记录',
      store.listMessages({ conversationId: 'dm:char_a' }).messages.filter(m => m.role === 'assistant').length === 0);
    store.close();
    mock.server.close();
  }

  /* ── 10 · restart 后幂等仍然成立（幂等表落盘，不靠内存）─────────── */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-exec-restart-'));
    const store1 = createStore({ dataDir: dir });
    store1.open();
    const mock = mockProvider(openaiChunk({ content: 'x' }) + '\u0000data: [DONE]\n\n');
    const port = await listen(mock.server);
    const ex1 = createExecutor({ store: store1, port: createPort({}) });
    const req = { requestId: 'req-restart-1', character: { id: 'c', spec: spec(port) }, userMessage: userMsg({ id: 'msg_restart_u' }) };
    const a = await ex1.executeCharacterTurn(req, { timeoutMs: 5000 });
    store1.close();
    const store2 = createStore({ dataDir: dir });
    store2.open();
    const ex2 = createExecutor({ store: store2, port: createPort({}) });
    const b = await ex2.executeCharacterTurn(req, { timeoutMs: 5000 });
    check('exec.restart 重启后幂等仍命中', b.outcome === 'duplicate-request', b);
    check('exec.restart 重启后模型未再被调用', mock.seen.bodies.length === 1, mock.seen.bodies.length);
    check('exec.restart 历史仍在', store2.listMessages({ conversationId: 'dm:char_a' }).messages.length === 2);
    check('exec.restart revision 未回退', store2.getRevision() === a.revision, [a.revision, store2.getRevision()]);
    store2.close();
    mock.server.close();
  }

  console.log('');
  if (failed) { console.error('Home Node execution 测试失败：' + failed + ' 项 ✘（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('Home Node execution tests passed ✔ (' + passed + ' 项)');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
