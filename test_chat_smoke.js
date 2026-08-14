'use strict';

/* SUI'S ROOM — Chat/Communication 冒烟测试（Node 18+，零依赖，需本机 Chrome / Edge）。
   用本地 mock OpenAI 兼容端点驱动真实发送链路（sendChatMessage → callApiChat），
   覆盖：聊天发送与回复渲染、信件加载/打开/删除、批注打开/输入/提交（mock 模型）、
   摘要设置往返、window 与 IB.chat 双挂载、全程未捕获异常收集。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
const MOCK_REPLY = '这是一条 mock 回复。';

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

function freePort() {
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

function startMockApi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: MOCK_REPLY }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const mock = await startMockApi();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chat-smoke-'));
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
    if (!ready) throw new Error('Chrome DevTools 未就绪');

    const tabResponse = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', params => {
      const d = params.exceptionDetails || {};
      exceptions.push(JSON.stringify(d.exception && d.exception.description || d.text || ''));
    });

    check('page.chatReady', await waitFor(cdp, "typeof window.IB === 'object' && window.IB.chat && typeof window.sendChatMessage === 'function' && typeof window.apiConfigs !== 'undefined'", 20000));
    /* headless 下 confirm() 会永久阻塞 CDP 调用：测试期间统一放行 */
    await evaluate(cdp, "window.confirm = function(){ return true; };");

    /* 0. 双挂载抽样（Codex 清单里的窗口件） */
    check('dual.sendChatMessage', await evaluate(cdp, "typeof window.sendChatMessage === 'function' && typeof window.IB.chat.sendChatMessage === 'function'"));
    check('dual.letters', await evaluate(cdp, "typeof window.loadLetters === 'function' && window.IB.chat.letters && typeof window.IB.chat.letters.loadLetters === 'function' && typeof window.IB.chat.letters.openLetter === 'function' && typeof window.IB.chat.letters.deleteLetter === 'function' && typeof window.openLetter === 'function' && typeof window.deleteLetter === 'function'"));
    check('dual.anno', await evaluate(cdp, "typeof window._annoSend === 'function' && window.IB.chat.annotations && typeof window.IB.chat.annotations._annoSend === 'function' && typeof window.IB.chat.annotations._renderAnnotationsForPost === 'function'"));
    check('dual.summary', await evaluate(cdp, "typeof window.saveSummarySettings === 'function' && window.IB.chat.summary && typeof window.IB.chat.summary.saveSummarySettings === 'function' && typeof window.IB.chat.summary.generateSummary === 'function'"));

    /* 1. 注入 mock API 配置并发送消息（真实 sendChatMessage → callApiChat 链路） */
    const mockEndpoint = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    /* openChatPanel 会从 IndexedDB 重载 apiConfigs（直接 push 会被冲掉）：先落库再 loadApiConfigs */
    await evaluate(cdp, "(function(){ var cfg={ id:'smoke_friend', nickname:'SmokeAI', model:'smoke-model', endpoint:'" + mockEndpoint + "', apiKey:'', provider:'custom', relationship:'测试伙伴', systemPrompt:'你是测试助手，只回复测试内容。', temperature:1, streaming:false, showThinking:false, promptCache:false, created:Date.now() }; window.__smoke_cfg=cfg; dbPut('apiConfigs', cfg); })()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "activeFriendId='smoke_friend'");
    check('chat.configReady', await evaluate(cdp, "apiConfigs.length > 0 && apiConfigs.some(function(a){return a.id==='smoke_friend' && !!a.endpoint})"));
    await evaluate(cdp, "openChatPanel()");
    check('chat.panelOpen', await waitFor(cdp, "!!document.getElementById('chat-input')", 8000));
    await evaluate(cdp, "document.getElementById('chat-input').value = '你好，SmokeAI。'; sendChatMessage();");
    check('chat.userBubble', await waitFor(cdp, "(function(){ var m=document.getElementById('chat-messages'); return !!m && m.textContent.includes('你好，SmokeAI。'); })()", 8000));
    check('chat.assistantReply', await waitFor(cdp, "(function(){ var m=document.getElementById('chat-messages'); return !!m && m.textContent.includes('" + MOCK_REPLY + "'); })()", 15000));
    check('chat.stored', await evaluate(cdp, "(async function(){ var all = await dbGetAll('chatMessages'); return all.some(m => m.friendId === 'smoke_friend' && m.role === 'assistant'); })()"));

    /* 2. 信件：落库 → loadLetters 渲染 → openLetter → deleteLetter */
    await evaluate(cdp, "dbPut('letters', { id:'smoke_letter', to:'Sui', from:'测试者', content:'这是一封测试信。', reply_to:'', read:false, created:Date.now() })");
    await evaluate(cdp, "loadLetters()");
    check('letters.card', await waitFor(cdp, "!!document.getElementById('letter-smoke_letter')", 8000));
    await evaluate(cdp, "openLetter('smoke_letter')");
    check('letters.open', await evaluate(cdp, "document.getElementById('letter-smoke_letter').style.display !== 'none'"));
    await evaluate(cdp, "deleteLetter('smoke_letter')");
    check('letters.delete', await waitFor(cdp, "!document.getElementById('letter-smoke_letter')", 8000));

    /* 3. 批注：种子日志 → _annoPickAI 打开输入条 → 填写 → _annoSend（mock 模型） */
    await evaluate(cdp, "dbPut('posts', { id:'smoke_post', title:'测试日志', content:'第一段内容。', category:'日志', locked:false, created:Date.now(), updated:Date.now() })");
    await evaluate(cdp, "_annoPickAI('smoke_friend')");
    check('anno.barOpen', await waitFor(cdp, "document.getElementById('anno-input-bar') && document.getElementById('anno-input-bar').classList.contains('show')", 8000));
    await evaluate(cdp, "(function(){ _annoPostId='smoke_post'; _annoSelText='第一段内容。'; _annoParaIdx=0; document.getElementById('anno-inp-field').value='写点什么吧。'; })()");
    await evaluate(cdp, "_annoSend()");
    check('anno.saved', await waitFor(cdp, "(async function(){ var all = await dbGetAll('blogAnnotations'); return all.some(a => a.postId === 'smoke_post' && a.aiId === 'smoke_friend'); })()", 15000));
    /* 关闭输入条 → 重新渲染 → 批注仍在（Codex 要求的持久化覆盖） */
    await evaluate(cdp, "_annoHideAll()");
    check('anno.close', await evaluate(cdp, "document.getElementById('anno-input-bar') && !document.getElementById('anno-input-bar').classList.contains('show')"));
    await evaluate(cdp, "_renderAnnotationsForPost('smoke_post')");
    check('anno.rerenderPersists', await evaluate(cdp, "(async function(){ var all = await dbGetAll('blogAnnotations'); return all.some(a => a.postId === 'smoke_post' && a.aiId === 'smoke_friend' && typeof a.content === 'string'); })()"));

    /* 4. 摘要设置往返（DOM 表单 → save → get）+ 设置 UI 无异常 */
    await evaluate(cdp, "(function(){ var t=document.getElementById('api-summary-toggle'); if(t) t.checked = true; })()");
    await evaluate(cdp, "saveSummarySettings()");
    check('summary.roundtrip', await evaluate(cdp, "(async function(){ var s = await getSummarySettings(); return s && s.enabled === true && s.keepCount >= 1; })()"));
    await evaluate(cdp, "loadSummarySettingsUI()");
    check('summary.ui', await evaluate(cdp, "typeof document.getElementById('summary-mgmt-list') === 'object'"));
    /* 摘要存档往返 + mock 模型真实生成（提取后的 summary.js 全链路） */
    await evaluate(cdp, "saveChatSummary('smoke_friend', null, 'smoke-summary-text', Date.now())");
    check('summary.saveGet', await evaluate(cdp, "(async function(){ var s = await getChatSummary('smoke_friend', null); return !!s && s.summary === 'smoke-summary-text'; })()"));
    await evaluate(cdp, "(function(){ var cfg=apiConfigs.find(function(a){return a.id==='smoke_friend'}); return generateSummary(cfg, null, [{role:'user',content:'你好'},{role:'assistant',content:'回复'}], 200).then(function(r){ window.__summaryResult = r; }); })()");
    check('summary.generate', await waitFor(cdp, "typeof window.__summaryResult === 'string' && window.__summaryResult.indexOf('mock') >= 0", 15000));

    /* 4.5 语音模块 mock 行为断言（无真实麦克风/扬声器：状态机与 DOM 接触面） */
    check('voice.dualAttach', await evaluate(cdp, "typeof window._vmInit === 'function' && window.IB.chat.voice && typeof window.IB.chat.voice._vmInit === 'function' && typeof window._buildVoiceEl === 'function' && typeof window.IB.chat.voice._buildVoiceEl === 'function'"));
    check('voice.supported', await evaluate(cdp, "(function(){ var v = _vmSupported(); return typeof v === 'boolean'; })()"));
    check('voice.errorMsg', await evaluate(cdp, "String(_vmRecogErrMsg('no-speech')).indexOf('未检测到人声') >= 0"));
    check('voice.apiLine', await evaluate(cdp, "String(_voiceApiLine({ duration: 5 })).indexOf('语音消息') >= 0"));
    check('voice.buildEl', await evaluate(cdp, "(function(){ var el = _buildVoiceEl({ duration: 3, dataUrl: 'data:audio/wav;base64,AAA=' }); return el.className === 'chat-voice-bar' && el.title === '点击播放语音' && el.innerHTML.indexOf('3\u2033') >= 0 && typeof el.onclick === 'function'; })()"));
    check('voice.togglePlay', await evaluate(cdp, "(function(){ var el = _buildVoiceEl({ duration: 1, dataUrl: 'data:audio/wav;base64,AAA=' }); _vmTogglePlay(el, { duration: 1, dataUrl: 'data:audio/wav;base64,AAA=' }); var ok = !!_vmAudio && _vmPlayingEl === el && el.classList.contains('playing'); _vmAudio = null; _vmPlayingEl = null; el.classList.remove('playing'); return ok; })()"));
    check('voice.initNoThrow', await evaluate(cdp, "(function(){ try { _vmInit(); return true; } catch(e) { return false; } })()"));

    /* 5. 全程无未捕获异常 */
    const gameOrChatErrors = exceptions.filter(text => /game_|communication|ReferenceError|TypeError/.test(text));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' || ').slice(0, 400));
    console.log('  INFO  exceptions captured: ' + exceptions.length);
  } finally {
    if (cdp) cdp.close();
    mock.server.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
  }

  console.log(failures === 0 ? '\nChat smoke test passed ✔' : '\nChat smoke test FAILED ✘');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
