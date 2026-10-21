'use strict';

/* ====================================================================
   IB 主聊天 · Anthropic/Gemini provider wire-format 契约测试
   --------------------------------------------------------------------
   ⚠ 定位：
   （1）它扩展自 test_chat_smoke.js 的骨架（http mock server + 手写 CDP
         + 真实《sendChatMessage → callApiChat → _callApiChatOnce → _ibApiPost》
         主聊天链路），**验证的是真实浏览器主聊天调用链**，而不是
         IBModelCore.parseResponse()（后者另由 test_model_core_contract.js 覆盖，
         其 5 处语义差异 + usage 缺口保持待决策，本文件不判为失败）。

   （2）mock server 按真实存在的 request construction 路由：
           Anthropic → /v1/messages
           非流式 Gemini → .../generateContent ？（见下方判断）
           对照组 OpenAI → /chat/completions
         路由 URL 严格对应当前 communication.js 的 cfg.endpoint 拼法。

   （3）断言目标（契约锁定，全部走真实主聊天链）：
           · 请求确实进入对应 provider 分支（mock 捕获到对应 URL + body）
           · 请求 body 形状（anthropic 顶层 system / gemini contents+system_instruction）
           · assistant 正文最终从真实主聊天链返回（chatMessages 落库）
           · Anthropic cache_read_input_tokens / cache_creation_input_tokens 不丢
           · Gemini cachedContentTokenCount 不丢
         cache 字段通过 window._tkRecord 写入的 ibTokenStats records 断言。

   ⚠ 关于当前环境：本机存在 Chrome，但 remote-debugging 端口无法连通
   （实测 CDP_READY=false）。因此本文件带一个【Node 层辅助预检】通道
   验证 mock 路由 + 请求形状 + 响应解析逻辑正确；CDP 部分若连不上，
   按约定如实报告「环境性失败」，不修改测试绕过。

   运行：node test_chat_smoke_provider_contract.js
   ==================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');


const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

/* ─────────────────────────────────────────────────────────────
   §0 · 请求形状构造（与 communication.js 分支一致地重现，仅供 Node 预检）
   ───────────────────────────────────────────────────────────── */
function buildAnthropicBody(cfg, maxTok, messages) {
  const sysMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));
  const body = { model: cfg.model, max_tokens: maxTok, messages: chatMsgs };
  if (sysMsg) body.system = cfg.promptCache !== false ? [{ type: 'text', text: sysMsg.content, cache_control: { type: 'ephemeral' } }] : sysMsg.content;
  return body;
}
function buildGeminiBody(cfg, maxTok, messages) {
  const sysMsgG = messages.find(m => m.role === 'system');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const gBody = { contents };
  if (sysMsgG) gBody.system_instruction = { parts: [{ text: sysMsgG.content }] };
  gBody.generationConfig = { maxOutputTokens: maxTok };
  return gBody;
}

/* ─────────────────────────────────────────────────────────────
   §1 · mock server（扩展：可在同端口服务 anthropic/gemini/openai）
   ───────────────────────────────────────────────────────────── */
function startMockApi() {
  return new Promise((resolve) => {
    const captured = {
      anthropic: { url: null, body: null, seen: false },
      gemini: { url: null, body: null, seen: false },
      openai: { url: null, body: null, seen: false },
      glm: { requests: [], fallbackAborted: false, holdFallback: false, respondWithContent: false, rejectStreaming: false, partialThenError: false }
    };
    const CORS = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      /* 必须列全浏览器实际会发的请求头：Anthropic 分支发 x-api-key / anthropic-version /
         anthropic-dangerous-direct-browser-access（_ccBeta 还可能加 anthropic-beta），
         Gemini 走 ?key= 但仍有 x-goog-api-key 兼容位，OpenAI 系发 Authorization。
         漏列任一项 → 预检失败 → 请求到不了 mock（测试会误报为分支未进入）。 */
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,x-api-key,anthropic-version,anthropic-beta,anthropic-dangerous-direct-browser-access,x-goog-api-key'
    };
    const server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null; try { body = JSON.parse(raw); } catch (e) {}
        const url = req.url || '';

        /* Anthropic：/v1/messages */
        if (req.method === 'POST' && url.includes('/v1/messages')) {
          captured.anthropic = { url, body, seen: true };
          res.writeHead(200, CORS);
          res.end(JSON.stringify({
            id: 'msg_contract_anth',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Claude 回复正文。' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30, cache_creation_input_tokens: 12 }
          }));
          return;
        }

        /* Gemini（非流式）：endpoint 含 generateContent；streamGenerateContent 一并容忍 */
        if (req.method === 'POST' && (url.includes('generateContent'))) {
          captured.gemini = { url, body, seen: true };
          res.writeHead(200, CORS);
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [
              { text: 'Gemini 回复正文。' },
              { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }
            ], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 90,
              candidatesTokenCount: 33,
              thoughtsTokenCount: 6,
              cachedContentTokenCount: 18
            }
          }));
          return;
        }

        /* GLM 5.3: streaming reasoning can arrive before any answer text. The
           first request deliberately ends after reasoning to exercise the
           production non-stream fallback and the shared Stop handle. */
        if (req.method === 'POST' && url.includes('/glm/chat/completions')) {
          captured.glm.requests.push(body || {});
          if (body && body.stream === true) {
            if (captured.glm.rejectStreaming) {
              res.writeHead(400, CORS);
              res.end(JSON.stringify({ error: 'stream not supported by this proxy' }));
              return;
            }
            res.writeHead(200, Object.assign({}, CORS, { 'Content-Type': 'text/event-stream' }));
            if (captured.glm.partialThenError) {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'GLM 部分回答。' } }] }) + '\n\n');
              setTimeout(() => { if (!res.destroyed) res.destroy(); }, 100);
              return;
            }
            const streamEvents = [{ choices: [{ delta: { reasoning_content: 'hidden GLM reasoning' } }] }];
            if (captured.glm.respondWithContent) {
              streamEvents.push({ choices: [{ delta: { content: 'GLM 流式' } }] });
              streamEvents.push({ choices: [{ delta: { content: '回答完成。' } }] });
              streamEvents.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            }
            res.end(streamEvents.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
            return;
          }
          if (captured.glm.holdFallback) {
            res.writeHead(200, CORS);
            const timer = setTimeout(() => {
              if (!res.destroyed) res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '停不掉的 GLM 回复。' }, finish_reason: 'stop' }] }));
            }, 30000);
            res.on('close', () => {
              if (!res.writableEnded) { clearTimeout(timer); captured.glm.fallbackAborted = true; }
            });
            return;
          }
          res.writeHead(200, CORS);
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'GLM 回答正文。', reasoning_content: 'fallback reasoning' }, finish_reason: 'stop' }] }));
          return;
        }

        /* 对照组 OpenAI /chat/completions */
        if (req.method === 'POST' && url.includes('/chat/completions')) {
          captured.openai = { url, body, seen: true };
          res.writeHead(200, CORS);
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OpenAI 回复正文。' }, finish_reason: 'stop' }] }));
          return;
        }

        res.writeHead(404, CORS);
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captured }));
  });
}

/* ─────────────────────────────────────────────────────────────
   §2 · CDP 辅助（照搬 test_chat_smoke.js，零依赖）
   ───────────────────────────────────────────────────────────── */
function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const candidate of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => {});
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const request = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: {
          Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
        }
      });
      request.on('upgrade', (response, socket) => resolve(new Cdp(socket)));
      request.on('error', reject);
      request.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendText({ id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000);
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const shortLength = this.buffer[1] & 0x7f;
      let offset = 2;
      let length = shortLength;
      if (shortLength === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (shortLength === 127) { if (this.buffer.length < 10) return; length = this.buffer.readUInt32BE(6); offset = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        const decoded = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) decoded[i] = payload[i] ^ mask[i & 3];
        payload = decoded;
      }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch (error) { continue; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      } else if (message.method && this.listeners.has(message.method)) {
        for (const listener of this.listeners.get(message.method)) listener(message.params || {});
      }
    }
  }
  close() { try { this.socket.destroy(); } catch (error) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(response.exceptionDetails.exception));
  return response.result && response.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await evaluate(cdp, expression)) return true; } catch (error) { /* still loading */ }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return false;
}

/* 请求是异步发出的：断言 body/url 前必须等 mock 真正收到该分支的请求，
   否则会读到 seen=false 的空快照（旧版直接断言，靠 CDP 往返耗时侥幸通过）。 */
async function waitCaptured(capture, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (capture && capture.seen) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   §3 · Node 层辅助预检（不依赖 CDP；明确标记为「辅助验证」）
   验证：mock 路由能按 URL 正确分流；请求体构造符合 communication.js
   分支；响应解析逻辑与真实 chain 一致。此段只是"自检"，不代表主聊天链。
   ═══════════════════════════════════════════════════════════════ */

/* §3.1 响应解析逻辑（与 communication.js 3628/3679/3711 一致的转录，仅用于自检） */
function parseAnthropicForPrecheck(wire) {
  const textParts = (wire.content || []).filter(c => c.type !== 'thinking');
  const out = textParts.map(c => c.text || '').join('');
  let usage = null;
  if (wire.usage) usage = { cr: wire.usage.cache_read_input_tokens || 0, cw: wire.usage.cache_creation_input_tokens || 0 };
  return { out, usage, truncated: wire.stop_reason === 'max_tokens' };
}
function parseGeminiForPrecheck(wire) {
  const cand = (wire.candidates && wire.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const out = parts.filter(p => !p.thought).map(p => p.text || '').join('');
  let cr = 0;
  if (wire.usageMetadata) cr = wire.usageMetadata.cachedContentTokenCount || 0;
  return { out, cr, truncated: cand.finishReason === 'MAX_TOKENS' };
}

/* §3.2 Node 预检主体：起 mock，直接 POST，断言路由与形状 */
async function nodePrecheck() {
  const mock = await startMockApi();
  const pass = [];
  const fail = [];
  const check = (name, cond, detail) => {
    (cond ? pass : fail).push(name + (cond ? '' : '  -> ' + (detail || '')));
  };
  try {
    /* --- Anthropic 路由自检 --- */
    const anthBody = buildAnthropicBody({ model: 'claude-sonnet-4-6', promptCache: false }, 2048, [
      { role: 'system', content: '你是测试。' },
      { role: 'user', content: '你好' }
    ]);
    const anthRes = await fetch('http://127.0.0.1:' + mock.port + '/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify(anthBody)
    });
    const anthJson = await anthRes.json();
    check('precheck.anth.routeHit', mock.captured.anthropic.seen === true);
    check('precheck.anth.bodyShape', !!mock.captured.anthropic.body && mock.captured.anthropic.body.model === 'claude-sonnet-4-6'
      && mock.captured.anthropic.body.max_tokens === 2048
      && Array.isArray(mock.captured.anthropic.body.messages)
      && mock.captured.anthropic.body.messages.every(m => m.role !== 'system')
      && !Array.isArray(mock.captured.anthropic.body.system)); /* promptCache:false → system 为字符串 */
    const anthParsed = parseAnthropicForPrecheck(anthJson);
    check('precheck.anth.content', anthParsed.out === 'Claude 回复正文。');
    check('precheck.anth.cacheKept', anthParsed.usage && anthParsed.usage.cr === 30 && anthParsed.usage.cw === 12);

    /* --- Gemini 路由自检 --- */
    const gemBody = buildGeminiBody({ model: 'gemini-2.0-flash' }, 1024, [
      { role: 'system', content: '你是测试。' },
      { role: 'user', content: '你好' }
    ]);
    const gemUrl = 'http://127.0.0.1:' + mock.port + '/v1beta/models/gemini-2.0-flash:generateContent?key=k';
    const gemRes = await fetch(gemUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gemBody)
    });
    const gemJson = await gemRes.json();
    check('precheck.gem.routeHit', mock.captured.gemini.seen === true);
    check('precheck.gem.bodyShape', !!mock.captured.gemini.body && Array.isArray(mock.captured.gemini.body.contents)
      && mock.captured.gemini.body.contents[0].role === 'user'
      && mock.captured.gemini.body.contents[0].parts[0].text === '你好'
      && mock.captured.gemini.body.system_instruction.parts[0].text === '你是测试。'
      && mock.captured.gemini.body.generationConfig.maxOutputTokens === 1024);
    const gemParsed = parseGeminiForPrecheck(gemJson);
    check('precheck.gem.content', gemParsed.out === 'Gemini 回复正文。');
    check('precheck.gem.cacheKept', gemParsed.cr === 18);

    /* --- 对照组 OpenAI 路由自检 --- */
    const oaiBody = { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] };
    const oaiRes = await fetch('http://127.0.0.1:' + mock.port + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(oaiBody)
    });
    await oaiRes.json();
    check('precheck.oai.routeHit', mock.captured.openai.seen === true);
  } finally {
    mock.server.close();
  }
  return { pass, fail };
}

/* ═══════════════════════════════════════════════════════════════
   §4 · 浏览器主聊天链测试（依赖 CDP；当前环境若连不上则如实报告）
   ═══════════════════════════════════════════════════════════════ */
async function browserChatContractTest() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const mock = await startMockApi();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chat-prov-contract-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--force-color-profile=srgb',
    '--window-size=1440,900', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let failures = 0;
  const check = (name, condition, detail = '') => {
    if (condition) console.log('  PASS  ' + name);
    else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  };
  let cdp;

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (response.ok) { ready = true; break; }
      } catch (error) { /* browser is starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('browser.ready', ready);
    if (!ready) return { cdpReady: false, failures };

    const tabResponse = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    check('page.chatReady', await waitFor(cdp, "typeof window.IB === 'object' && window.IB.chat && typeof window.sendChatMessage === 'function' && typeof window.apiConfigs !== 'undefined' && typeof window._tkRecord === 'function'", 20000));
    await evaluate(cdp, "window.confirm = function(){ return true; };");

    const mockBase = 'http://127.0.0.1:' + mock.port;

    /* 注入 provider Friend（含遗留 streaming:false 的 GLM 5.3），全部指向 mock */
    const friendCfgs = [
      { id: 'contract_anth', nickname: 'ClaudeC', model: 'claude-sonnet-4-6', endpoint: mockBase + '/v1/messages', apiKey: 'anth-key', provider: 'anthropic', relationship: '测试伙伴', systemPrompt: '你是 Claude 契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() },
      { id: 'contract_gem', nickname: 'GemC', model: 'gemini-2.0-flash', endpoint: mockBase + '/v1beta/models/{model}:generateContent', apiKey: 'gem-key', provider: 'gemini', relationship: '测试伙伴', systemPrompt: '你是 Gemini 契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() },
      { id: 'contract_oai', nickname: 'OaiC', model: 'gpt-4o-mini', endpoint: mockBase + '/v1/chat/completions', apiKey: '', provider: 'custom', relationship: '测试伙伴', systemPrompt: '你是 OpenAI 契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() },
      { id: 'contract_glm', nickname: 'GlmC', model: 'glm-5.3-flash', endpoint: mockBase + '/glm/chat/completions', apiKey: '', provider: 'glm', relationship: '测试伙伴', systemPrompt: '你是 GLM 流式契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() },
      { id: 'contract_glm_stream', nickname: 'GlmStream', model: 'glm-5.3-flash', endpoint: mockBase + '/glm/chat/completions', apiKey: '', provider: 'glm', relationship: '测试伙伴', systemPrompt: '你是 GLM 流式契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() },
      { id: 'contract_glm_partial', nickname: 'GlmPartial', model: 'glm-5.3-flash', endpoint: mockBase + '/glm/chat/completions', apiKey: '', provider: 'glm', relationship: '测试伙伴', systemPrompt: '你是 GLM 部分流契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() },
      { id: 'contract_glm_error', nickname: 'GlmError', model: 'glm-5.3-flash', endpoint: mockBase + '/glm/chat/completions', apiKey: '', provider: 'glm', relationship: '测试伙伴', systemPrompt: '你是 GLM 回退契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() },
      { id: 'contract_glm_stop', nickname: 'GlmStop', model: 'glm-5.3-flash', endpoint: mockBase + '/glm/chat/completions', apiKey: '', provider: 'glm', relationship: '测试伙伴', systemPrompt: '你是 GLM 停止契约测试。', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() }
    ];
    await evaluate(cdp, "(function(){ " + friendCfgs.map(c => 'dbPut(\'apiConfigs\',' + JSON.stringify(c) + ');').join(' ') + " })()");
    await evaluate(cdp, "loadApiConfigs()");
    const qqMediaCfg = {
      id: 'contract_gem_media', nickname: 'GemMedia', model: 'gemini-2.0-flash',
      endpoint: mockBase + '/v1beta/models/{model}:generateContent', apiKey: 'gem-key', provider: 'gemini',
      systemPrompt: 'QQ 官方媒体契约测试。', temperature: 1, streaming: false, showThinking: false,
      promptCache: false, imageGen: true, vision: true, created: Date.now()
    };
    const qqLocalVisionCfg = {
      id: 'contract_qq_local_vision', nickname: 'QQLocalVision', model: 'deepseek-chat',
      endpoint: mockBase + '/v1/chat/completions', apiKey: 'oai-key', provider: 'deepseek',
      systemPrompt: 'QQ 本地视觉契约测试。', temperature: 1, streaming: false, showThinking: false,
      promptCache: false, vision: true, created: Date.now()
    };
    await evaluate(cdp, "(async function(){ await dbPut('apiConfigs'," + JSON.stringify(qqMediaCfg) + "); await dbPut('apiConfigs'," + JSON.stringify(qqLocalVisionCfg) + "); await loadApiConfigs(); })()");

    /* 先清理任一残留 token 记录，便于精确断言 */
    await evaluate(cdp, "(async function(){ try{ var r=await dbGet('apiSettings','ibTokenStats'); if(r&&r.data)r.data.records=[]; await dbPut('apiSettings',{id:'ibTokenStats',data:r?(r.data||{records:[]}):{records:[]}}); }catch(e){} })()");

    /* ═══ Anthropic 主聊天链 ═══ */
    mock.captured.anthropic.seen = false;
    await evaluate(cdp, "activeFriendId='contract_anth'");
    await evaluate(cdp, "openChatPanel()");
    await evaluate(cdp, "document.getElementById('chat-input').value='你好 Claude。'; sendChatMessage();");
    check('anth.friendReady', await waitFor(cdp, "(function(){ var c=apiConfigs.find(function(a){return a.id==='contract_anth'}); return !!(c&&c.provider==='anthropic'); })()", 8000));
    await waitCaptured(mock.captured.anthropic);
    check('anth.branchEntered', mock.captured.anthropic.seen === true, mock.captured.anthropic.url || '(unreached)');
    check('anth.bodyModel', mock.captured.anthropic.body && mock.captured.anthropic.body.model === 'claude-sonnet-4-6');
    check('anth.bodyMaxTokens', mock.captured.anthropic.body && mock.captured.anthropic.body.max_tokens > 0);
    check('anth.bodyMessagesNoSystem', mock.captured.anthropic.body && mock.captured.anthropic.body.messages
      && mock.captured.anthropic.body.messages.every(m => m.role !== 'system'));
    check('anth.bodySystemTopLevel', mock.captured.anthropic.body && typeof mock.captured.anthropic.body.system === 'string'
      && String(mock.captured.anthropic.body.system).indexOf('Claude 契约测试') !== -1, JSON.stringify(mock.captured.anthropic.body && mock.captured.anthropic.body.system));
    check('anth.replyRendered', await waitFor(cdp, "(function(){ var m=document.getElementById('chat-messages'); return !!m && m.textContent.indexOf('Claude 回复正文。')!==-1; })()", 15000));
    check('anth.replyStored', await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); return all.some(function(m){return m.friendId==='contract_anth'&&m.role==='assistant'&&m.content==='Claude 回复正文。';}); })()"));
    /* cache 字段不丢：读 ibTokenStats records 中 cid=contract_anth 的次数 */
    check('anth.crNotLost', await evaluate(cdp, "(async function(){ var r=await dbGet('apiSettings','ibTokenStats'); var recs=(r&&r.data&&r.data.records)||[]; var hit=recs.find(function(x){return x.cid==='contract_anth'&&x.cr>0;}); return !!hit && hit.cr===30; })()"));
    check('anth.cwNotLost', await evaluate(cdp, "(async function(){ var r=await dbGet('apiSettings','ibTokenStats'); var recs=(r&&r.data&&r.data.records)||[]; var hit=recs.find(function(x){return x.cid==='contract_anth'&&x.cw>0;}); return !!hit && hit.cw===12; })()"));

    /* ═══ Gemini 主聊天链 ═══ */
    mock.captured.gemini.seen = false;
    await evaluate(cdp, "activeFriendId='contract_gem'");
    await evaluate(cdp, "openChatPanel()");
    await evaluate(cdp, "document.getElementById('chat-input').value='你好 Gemini。'; sendChatMessage();");
    await waitCaptured(mock.captured.gemini);
    check('gem.branchEntered', mock.captured.gemini.seen === true, mock.captured.gemini.url || '(unreached)');
    check('gem.urlGenerateContent', mock.captured.gemini.url && /generateContent/.test(mock.captured.gemini.url), mock.captured.gemini.url || '');
    check('gem.bodyContents', mock.captured.gemini.body && Array.isArray(mock.captured.gemini.body.contents)
      && mock.captured.gemini.body.contents.some(function(c){return c.role==='user';}));
    check('gem.bodySystemInstruction', mock.captured.gemini.body && mock.captured.gemini.body.system_instruction
      && mock.captured.gemini.body.system_instruction.parts[0].text.indexOf('Gemini 契约测试') !== -1);
    check('gem.bodyMaxOutputTokens', mock.captured.gemini.body && mock.captured.gemini.body.generationConfig
      && mock.captured.gemini.body.generationConfig.maxOutputTokens > 0);
    check('gem.replyRendered', await waitFor(cdp, "(function(){ var m=document.getElementById('chat-messages'); return !!m && m.textContent.indexOf('Gemini 回复正文。')!==-1; })()", 15000));
    check('gem.replyStored', await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); return all.some(function(m){return m.friendId==='contract_gem'&&m.role==='assistant'&&m.content==='Gemini 回复正文。';}); })()"));
    check('gem.cachedTokenCountNotLost', await evaluate(cdp, "(async function(){ var r=await dbGet('apiSettings','ibTokenStats'); var recs=(r&&r.data&&r.data.records)||[]; var hit=recs.find(function(x){return x.cid==='contract_gem'&&x.cr>0;}); return !!hit && hit.cr===18; })()"));

    /* QQ Official media seam: existing Gemini Provider receives an inline image
       part and its native image output is returned as request-local media. */
    mock.captured.gemini.seen = false;
    const mediaResult = await evaluate(cdp, "(async function(){ var r=await window.IB.chat.callExternalReplyMedia('contract_gem_media',[{role:'system',content:'role system'},{role:'user',content:[{type:'text',text:'请描述这张图片。'},{type:'_image',mime:'image/png',base64:'iVBORw0KGgo='}]}],'qq-official:mock:c2c:user'); return {text:r.text,imageCount:(r.images||[]).length,imageMime:r.images&&r.images[0]&&r.images[0].mime,imageBase64Length:r.images&&r.images[0]&&r.images[0].base64.length}; })()");
    await waitCaptured(mock.captured.gemini);
    const mediaUserParts = mock.captured.gemini.body && mock.captured.gemini.body.contents
      .filter(function (message) { return message.role === 'user'; }).flatMap(function (message) { return message.parts || []; });
    check('qq.mediaInputSentAsInlineData', mediaUserParts && mediaUserParts.some(function (part) {
      return part.inlineData && part.inlineData.mimeType === 'image/png' && part.inlineData.data === 'iVBORw0KGgo=';
    }));
    check('qq.mediaOutputCaptured', mediaResult && mediaResult.text === 'Gemini 回复正文。'
      && mediaResult.imageCount === 1 && mediaResult.imageMime === 'image/png'
      && mediaResult.imageBase64Length === 'iVBORw0KGgo='.length);

    mock.captured.anthropic.seen = false;
    const anthropicMediaResult = await evaluate(cdp, "(async function(){ var r=await window.IB.chat.callExternalReplyMedia('contract_anth',[{role:'system',content:'role system'},{role:'user',content:[{type:'text',text:'请看图。'},{type:'_image',mime:'image/png',base64:'iVBORw0KGgo='}]}],'qq-official:mock:c2c:user'); return {text:r.text,imageCount:(r.images||[]).length}; })()");
    await waitCaptured(mock.captured.anthropic);
    const anthropicUser = mock.captured.anthropic.body && mock.captured.anthropic.body.messages
      .find(function (message) { return message.role === 'user'; });
    check('qq.anthropicImageInput', anthropicMediaResult && anthropicMediaResult.text === 'Claude 回复正文。'
      && anthropicMediaResult.imageCount === 0 && anthropicUser && Array.isArray(anthropicUser.content)
      && anthropicUser.content.some(function (part) { return part.type === 'image' && part.source
        && part.source.media_type === 'image/png' && part.source.data === 'iVBORw0KGgo='; }));

    mock.captured.openai.seen = false;
    const openAiMediaResult = await evaluate(cdp, "(async function(){ var r=await window.IB.chat.callExternalReplyMedia('contract_oai',[{role:'system',content:'role system'},{role:'user',content:[{type:'text',text:'请看图。'},{type:'_image',mime:'image/png',base64:'iVBORw0KGgo='}]}],'qq-official:mock:c2c:user'); return {text:r.text,imageCount:(r.images||[]).length}; })()");
    await waitCaptured(mock.captured.openai);
    const openAiUser = mock.captured.openai.body && mock.captured.openai.body.messages
      .find(function (message) { return message.role === 'user'; });
    check('qq.openAiImageInput', openAiMediaResult && openAiMediaResult.text === 'OpenAI 回复正文。'
      && openAiMediaResult.imageCount === 0 && openAiUser && Array.isArray(openAiUser.content)
      && openAiUser.content.some(function (part) { return part.type === 'image_url'
        && part.image_url && part.image_url.url === 'data:image/png;base64,iVBORw0KGgo='; }));

    mock.captured.openai.seen = false;
    const localVisionResult = await evaluate(cdp, "(async function(){ var originalFetch=window.fetch; window.fetch=function(url,options){ if(String(url)==='http://127.0.0.1:8765/vision')return Promise.resolve({ok:true,json:async function(){return {result:'图片包含一只猫和一把蓝色椅子。'}}}); return originalFetch.apply(this,arguments); }; try{ var r=await window.IB.chat.callExternalReplyMedia('contract_qq_local_vision',[{role:'system',content:'role system'},{role:'user',content:[{type:'text',text:'请描述图片。'},{type:'_image',mime:'image/png',base64:'iVBORw0KGgo='}]}],'qq-official:mock:c2c:user'); return {text:r.text,imageCount:(r.images||[]).length}; } finally {window.fetch=originalFetch;} })()");
    await waitCaptured(mock.captured.openai);
    const localVisionUser = mock.captured.openai.body && mock.captured.openai.body.messages
      .filter(function (message) { return message.role === 'user'; }).pop();
    check('qq.deepseekUsesExistingLocalVision', localVisionResult && localVisionResult.text === 'OpenAI 回复正文。'
      && localVisionResult.imageCount === 0 && localVisionUser && typeof localVisionUser.content === 'string'
      && localVisionUser.content.indexOf('图片包含一只猫和一把蓝色椅子') !== -1
      && localVisionUser.content.indexOf('image_url') === -1);
    mock.captured.openai.seen = false;
    const visionFailure = await evaluate(cdp, "(async function(){ var originalFetch=window.fetch; window.fetch=function(url,options){ if(String(url)==='http://127.0.0.1:8765/vision')return Promise.reject(new Error('private vision failure detail')); return originalFetch.apply(this,arguments); }; try{ await window.IB.chat.callExternalReplyMedia('contract_qq_local_vision',[{role:'system',content:'role system'},{role:'user',content:[{type:'text',text:'请描述图片。'},{type:'_image',mime:'image/png',base64:'iVBORw0KGgo='}]}],'qq-official:mock:c2c:user'); return 'unexpected-success'; }catch(error){return String(error&&error.code||'');}finally{window.fetch=originalFetch;} })()");
    check('qq.visualFailureIsSafeAndStopsBeforeProvider', visionFailure === 'QQ_VISION_UNAVAILABLE' && mock.captured.openai.seen !== true);

    /* ═══ 对照组 OpenAI 主聊天链（确认未回归） ═══ */
    mock.captured.openai.seen = false;
    await evaluate(cdp, "activeFriendId='contract_oai'");
    await evaluate(cdp, "openChatPanel()");
    await evaluate(cdp, "document.getElementById('chat-input').value='你好 OpenAI。'; sendChatMessage();");
    await waitCaptured(mock.captured.openai);
    check('oai.branchEntered', mock.captured.openai.seen === true, mock.captured.openai.url || '(unreached)');
    check('oai.replyRendered', await waitFor(cdp, "(function(){ var m=document.getElementById('chat-messages'); return !!m && m.textContent.indexOf('OpenAI 回复正文。')!==-1; })()", 15000));

    /* ═══ GLM-5.3: stale stream-off config, reasoning-first SSE, fallback, Stop ═══ */
    mock.captured.glm.respondWithContent = true;
    const glmNormalStart = mock.captured.glm.requests.length;
    await evaluate(cdp, "activeFriendId='contract_glm_stream'; openChatPanel(); document.getElementById('chat-input').value='请简短回答。'; sendChatMessage();");
    const glmNormalWait = Date.now() + 15000;
    while (mock.captured.glm.requests.length < glmNormalStart + 1 && Date.now() < glmNormalWait) await new Promise(resolve => setTimeout(resolve, 50));
    check('glm.normalReplyUsesOneStreamingRequest', mock.captured.glm.requests.length === glmNormalStart + 1
      && mock.captured.glm.requests[glmNormalStart] && mock.captured.glm.requests[glmNormalStart].stream === true);
    check('glm.reasoningStaysOutOfVisibleReply', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages');return !!m&&m.textContent.indexOf('GLM 流式回答完成。')!==-1&&m.textContent.indexOf('hidden GLM reasoning')<0})()", 15000));
    check('glm.streamedAnswerIsStoredWithSeparateReasoning', await waitFor(cdp, "(async function(){var a=(await dbGetAll('chatMessages')).filter(function(m){return m.friendId==='contract_glm_stream'&&m.role==='assistant'}).pop();return !!a&&a.content==='GLM 流式回答完成。'&&String(a.reasoning_content||'').indexOf('hidden GLM reasoning')>=0})()", 15000));

    mock.captured.glm.partialThenError = true;
    const glmPartialStart = mock.captured.glm.requests.length;
    await evaluate(cdp, "activeFriendId='contract_glm_partial'; openChatPanel(); document.getElementById('chat-input').value='保留已有流式内容。'; sendChatMessage();");
    check('glm.partialStreamIsPreservedWithoutDuplicateRetry', await waitFor(cdp, "(async function(){var a=(await dbGetAll('chatMessages')).filter(function(m){return m.friendId==='contract_glm_partial'&&m.role==='assistant'}).pop();return !!a&&a.content==='GLM 部分回答。'})()", 15000)
      && mock.captured.glm.requests.length === glmPartialStart + 1);
    mock.captured.glm.partialThenError = false;

    mock.captured.glm.respondWithContent = false;
    const glmFallbackStart = mock.captured.glm.requests.length;
    await evaluate(cdp, "activeFriendId='contract_glm'; openChatPanel(); document.getElementById('chat-input').value='请简短回答。'; sendChatMessage();");
    const glmFirstWait = Date.now() + 15000;
    while (mock.captured.glm.requests.length < glmFallbackStart + 2 && Date.now() < glmFirstWait) await new Promise(resolve => setTimeout(resolve, 50));
    check('glm.legacyDisabledConfigStillSendsStreamingRequest', mock.captured.glm.requests[glmFallbackStart] && mock.captured.glm.requests[glmFallbackStart].stream === true);
    check('glm53ThinkingModeIsExplicitlyEnabled', mock.captured.glm.requests[glmFallbackStart] && mock.captured.glm.requests[glmFallbackStart].thinking
      && mock.captured.glm.requests[glmFallbackStart].thinking.type === 'enabled');
    check('glm.reasoningOnlyStreamFallsBackToNonStreaming', mock.captured.glm.requests[glmFallbackStart + 1] && mock.captured.glm.requests[glmFallbackStart + 1].stream !== true);
    check('glm.fallbackReplyIsStoredWithoutProtocolLeak', await waitFor(cdp, "(async function(){var a=(await dbGetAll('chatMessages')).filter(function(m){return m.friendId==='contract_glm'&&m.role==='assistant'}).pop();return !!a&&a.content==='GLM 回答正文。'&&a.content.indexOf('<ws_mem_write>')<0&&String(a.reasoning_content||'').indexOf('hidden GLM reasoning')>=0})()", 15000));

    mock.captured.glm.rejectStreaming = true;
    const glmErrorStart = mock.captured.glm.requests.length;
    await evaluate(cdp, "activeFriendId='contract_glm_error'; openChatPanel(); document.getElementById('chat-input').value='流式端点异常回退。'; sendChatMessage();");
    const glmErrorWait = Date.now() + 15000;
    while (mock.captured.glm.requests.length < glmErrorStart + 2 && Date.now() < glmErrorWait) await new Promise(resolve => setTimeout(resolve, 50));
    check('glm.streamHttpErrorFallsBackToNonStreaming', mock.captured.glm.requests.length >= glmErrorStart + 2
      && mock.captured.glm.requests[glmErrorStart].stream === true
      && mock.captured.glm.requests[glmErrorStart + 1].stream !== true);
    check('glm.httpFallbackAnswerIsStored', await waitFor(cdp, "(async function(){var a=(await dbGetAll('chatMessages')).filter(function(m){return m.friendId==='contract_glm_error'&&m.role==='assistant'}).pop();return !!a&&a.content==='GLM 回答正文。'})()", 15000));
    mock.captured.glm.rejectStreaming = false;

    mock.captured.glm.holdFallback = true;
    const glmStopStart = mock.captured.glm.requests.length;
    await evaluate(cdp, "(function(){activeFriendId='contract_glm_stop'; openChatPanel(); document.getElementById('chat-input').value='测试停止回退。'; sendChatMessage(); return true;})()");
    const glmStopWait = Date.now() + 15000;
    while (mock.captured.glm.requests.length < glmStopStart + 2 && Date.now() < glmStopWait) await new Promise(resolve => setTimeout(resolve, 50));
    check('glm.fallbackRequestStartedForStopTest', mock.captured.glm.requests.length >= glmStopStart + 2);
    await evaluate(cdp, "stopStreaming()");
    const glmStopEnd = Date.now() + 10000;
    let glmStopDone = false;
    while (!glmStopDone && Date.now() < glmStopEnd) {
      glmStopDone = await evaluate(cdp, "!window._chatCallStates||!window._chatCallStates[activeFriendId]");
      if (!glmStopDone) await new Promise(resolve => setTimeout(resolve, 50));
    }
    check('glm.nonStreamingFallbackRemainsStopCancellable', glmStopDone);
    check('glm.stoppedFallbackDoesNotPersistAssistantReply', await evaluate(cdp, "(async function(){var a=await dbGetAll('chatMessages');return !a.some(function(m){return m.friendId==='contract_glm_stop'&&m.role==='assistant'&&m.content==='停不掉的 GLM 回复。'})})()"));

    return { cdpReady: true, failures };
  } finally {
    if (cdp) cdp.close();
    mock.server.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
  }
}

/* ═══════════════════════════════════════════════════════════════
   §5 · 主入口
   ═══════════════════════════════════════════════════════════════ */
async function main() {
  let precheckFailures = 0;
  const precheckFail = [];

  /* Node 层辅助预检（不依赖 CDP） */
  console.log('\n[NODE-PRECHECK] mock 路由 + 请求形状 + 响应解析 辅助自检');
  console.log('  （说明：此段仅验证 mock server 与请求/响应形状构造逻辑正确，');
  console.log('    不代表真实浏览器主聊天链；真实链见下方 [BROWSER] 段）');
  try {
    const r = await nodePrecheck();
    r.pass.forEach(x => console.log('  PASS  ' + x));
    if (r.fail.length) r.fail.forEach(x => console.error('  FAIL  ' + x));
    precheckFailures = r.fail.length;
    if (r.fail.length) precheckFail.push(...r.fail);
  } catch (e) {
    console.error('  FAIL  precheck.crashed  -> ' + e.message);
    precheckFailures = 1;
    precheckFail.push('precheck.crashed: ' + e.message);
  }

  /* 浏览器主聊天链 */
  console.log('\n[BROWSER] 真实主聊天链契地测试（sendChatMessage → callApiChat → _ibApiPost）');
  let cdpReady = null;
  let browserFailures = 0;
  try {
    const r = await browserChatContractTest();
    cdpReady = r.cdpReady;
    browserFailures = r.failures;
  } catch (e) {
    console.error('  FAIL  browser.crashed  -> ' + e.message);
    cdpReady = false;
    browserFailures = 1;
  }

  /* 汇总 */
  console.log('\n' + '─'.repeat(72));
  console.log('Node 预检：' + (precheckFailures === 0 ? '全部通过 ✔' : precheckFailures + ' 失败 ✘'));
  console.log('CDP 可用性：' + (cdpReady === true ? 'READY（可执行浏览器链）' : 'NOT_READY（当前环境阻止 CDP，浏览器链未实际执行）'));
  if (cdpReady === true) {
    console.log('浏览器链：' + (browserFailures === 0 ? '全部通过 ✔' : browserFailures + ' 失败 ✘'));
  } else {
    console.log('浏览器链：未执行（CDP_READY=false，环境性失败，非测试逻辑问题）');
  }
  console.log('─'.repeat(72));

  /* 退出码语义：
     - exit 0：Node 预检 + 浏览器链全部通过（仅当 CDP READY 且无失败）
     - exit 1：测试逻辑失败（预检断言失败，或 CDP READY 但浏览器链断言失败）
     - exit 2：环境性失败（CDP 未就绪，浏览器链未能执行；测试代码本身无 bug） */
  let exitCode;
  let summary;
  if (cdpReady !== true) {
    exitCode = 2;
    summary = '环境性失败：CDP 未就绪，浏览器主聊天链未能执行（Node 预检已通过 ✔）。此非测试逻辑问题，需在具备可用 CDP 的环境运行。';
  } else if (precheckFailures === 0 && browserFailures === 0) {
    exitCode = 0;
    summary = 'Provider wire-format 契约测试通过 ✔（Node 预检 + 浏览器主聊天链）';
  } else {
    exitCode = 1;
    summary = 'Provider wire-format 契约测试：' + (precheckFailures + browserFailures) + ' 项断言失败（见上）';
  }
  console.log('\n' + summary);
  process.exit(exitCode);
}

main().catch(error => { console.error(error); process.exit(1); });
