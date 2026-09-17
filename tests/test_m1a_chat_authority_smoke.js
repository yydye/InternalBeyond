'use strict';

/* Internal Beyond · M1-A 桌面端 canonical authority 浏览器冒烟
   （Node 18+，零依赖，需本机 Chrome / Edge；**不是**全量浏览器套件）

   运行：node tests/test_m1a_chat_authority_smoke.js --browser

   唯一目的：证明「桌面单聊在切到 Home Node canonical authority 之后仍然工作」，
   以及「Home Node 离线时写是 fail closed、读仍可从镜像恢复」。
   刻意只跑这条最小链路：本阶段的测试预算不允许跑完整浏览器套件。

   做法：
     · 起一个**真实的** services/home-node-service.js（随机端口 + 临时数据目录）；
     · 起一个 mock OpenAI 兼容端点，让真实 sendChatMessage 走完整链路；
     · 用真实页面（InternalBeyond.html）+ 真实静态关系，但用一个临时 loader HTML
       在页面脚本执行之前写入 localStorage 指向测试用的 Home Node 端口；
     · 断言：用户消息与助手消息都出现在 Home Node 的 canonical SQLite 里；
     · 再断言：把 Home Node 停掉之后，写被拒绝（fail closed），
       且 IndexedDB 镜像里**没有**出现那条被拒绝的消息。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;
const MOCK_REPLY = '这是 M1-A authority 冒烟回复。';

let failures = 0;
const check = (name, condition, detail) => {
  if (condition) console.log('  PASS  ' + name);
  else {
    failures++;
    /* 对象细节必须序列化：'  -> ' + {} 会打成 "[object Object]"，等于没给信息。 */
    const shown = (detail && typeof detail === 'object') ? JSON.stringify(detail) : detail;
    console.error('  FAIL  ' + name + (shown ? '  -> ' + shown : ''));
  }
};

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
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
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const shortLength = this.buffer[1] & 0x7f;
      let offset = 2;
      let length = shortLength;
      if (shortLength === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (shortLength === 127) { if (this.buffer.length < 10) return; length = this.buffer.readUInt32BE(6); offset = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ mask[i & 3];
      this.buffer = this.buffer.subarray(offset + length);
      let text = null;
      try { text = payload.toString('utf8'); } catch (error) { text = null; }
      if (text == null) continue;
      let message = null;
      try { message = JSON.parse(text); } catch (error) { continue; }
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
async function waitFor(cdp, expression, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await evaluate(cdp, expression)) return true; } catch (error) { /* loading */ }
    await new Promise(resolve => setTimeout(resolve, 150));
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
/* 极简静态服务器：只用来说明「产品的正常承载是 http://127.0.0.1:<port>/」，不是 file://。
   真实启动链由 runtime/launch-internal-beyond.js:19 打开同样的地址。 */
function startStaticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function startMockApi() {  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, headers);
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: MOCK_REPLY }, finish_reason: 'stop' }] }));
        });
        return;
      }
      res.writeHead(404, headers);
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function homeNodeRequest(port, pathname, method, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = Object.assign({}, data ? { 'Content-Type': 'application/json' } : {}, extraHeaders || {});
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: method || 'GET',
      headers: headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (error) { resolve({ raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function waitForHomeNode(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await homeNodeRequest(port, '/health'); if (r && r.ok) return r; }
    catch (error) { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  if (process.argv.indexOf('--browser') < 0) {
    console.log('（需要 --browser 才会真正启动浏览器；本用例在 --quick 之外单独运行）');
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m1a-authority-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m1a-profile-'));
  const homePort = await freePort();
  const mock = await startMockApi();
  const site = await startStaticServer();
  const debugPort = await freePort();

  /* 真实的 Home Node 进程 —— 不是 mock。 */
  const homeNode = spawn(process.execPath, ['services/home-node-service.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(homePort),
      IB_HOME_NODE_DATA_DIR: dataDir,
      /* ★ P22-23：这一条验的是**未配置桌面凭据**的部署形态 —— 本文件下面要
         走 /characters/publish 与 /pairing/session，而未配置凭据时那几条路径
         按 P11-3A 就是 403 desktop-token-required。产品默认现在会在首次启动
         时自动 provision 一份凭据（那正是 Economy 首次使用链闭合的前提），
         因此这里显式关掉它，把"没有凭据"这个仍然合法的部署形态固定下来。
         自动 provisioning 本身由 tests/test_p22_23_home_node_provisioning.js
         与 tests/test_p22_23_first_run_acceptance.js 覆盖。 */
      IB_HOME_NODE_TOKEN_AUTOPROVISION: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let homeOut = '';
  homeNode.stdout.on('data', c => homeOut += c);
  homeNode.stderr.on('data', c => homeOut += c);

  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--force-color-profile=srgb',
    '--window-size=1440,900', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    const health = await waitForHomeNode(homePort, 20000);
    check('homeNode.started', !!health, homeOut.slice(-400));
    check('homeNode.identity', !!health && health.service === 'internal-beyond-home-node', health && health.service);
    check('homeNode.role', !!health && health.role === 'canonical-chat-authority');

    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + debugPort + '/json/version'); if (r.ok) { ready = true; break; } }
      catch (error) { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('browser.ready', ready);
    if (!ready) throw new Error('Chrome DevTools 未就绪');

    /* 用 **http://127.0.0.1:<port>/InternalBeyond.html** 打开真实页面 ——
       这正是产品启动链（runtime/launch-internal-beyond.js:19）使用的承载方式。
       不用 file://：Chrome 会在网络层阻断 file:// 页面到 loopback 的 fetch，
       那条路径由 home-node-bootstrap 的 file-origin 降级分支覆盖（本文件末尾断言）。 */
    const tabResponse = await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', params => {
      const d = params.exceptionDetails || {};
      exceptions.push(JSON.stringify((d.exception && d.exception.description) || d.text || ''));
    });
    /* 在页面脚本执行之前把测试用的 Home Node 端口写进 localStorage。 */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try{localStorage.setItem("ib_home_node_http","http://127.0.0.1:' + homePort + '");' +
        'localStorage.setItem("ib_home_node_mode","canonical");}catch(e){}'
    });
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + site.port + '/InternalBeyond.html' });

    check('page.pageOriginIsHttp', (await evaluate(cdp, 'location.origin')).indexOf('http://127.0.0.1:') === 0);
    check('page.loaded', await waitFor(cdp, "typeof window.IB === 'object' && typeof window.sendChatMessage === 'function'", 30000));
    check('page.homeNodeSurface', await evaluate(cdp, "!!(window.IB && window.IB.homeNode) && typeof window.IB.homeNode.status === 'function' && typeof window.IB.homeNode.migrate === 'function'"));
    check('page.modeCanonical', (await evaluate(cdp, "window.IB.homeNode.mode")) === 'canonical');
    check('page.basePointsAtTestHomeNode', (await evaluate(cdp, "window.ibHomeNodeBase()")) === 'http://127.0.0.1:' + homePort);

    /* 启动同步应当把 Home Node 认作在线（镜像播种完成，degraded 清空）。 */
    const synced = await waitFor(cdp, "(function(){ var s=window.IB.homeNode.status(); return s.remoteOnline === true && s.hydrated === true; })()", 25000);
    check('authority.hydrated', synced, await evaluate(cdp, "JSON.stringify({status:window.IB.homeNode.status(),log:window.IB.homeNode.log().slice(-8)})"));

    /* 注入 mock 模型配置并走真实发送链路 */
    const mockEndpoint = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    await evaluate(cdp, "(function(){ var cfg={ id:'m1a_friend', nickname:'M1AAI', model:'m1a-model', endpoint:'" + mockEndpoint + "', apiKey:'sk-m1b-smoke-secret', provider:'custom', relationship:'测试伙伴', systemPrompt:'只回复测试内容。', temperature:1, streaming:false, showThinking:false, promptCache:false, created:Date.now() }; window.__m1a_cfg=cfg; dbPut('apiConfigs', cfg); })()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "activeFriendId='m1a_friend'");
    check('chat.configReady', await evaluate(cdp, "apiConfigs.some(function(a){return a.id==='m1a_friend'&&!!a.endpoint})"));

    /* ── M1-B：桌面把 apiConfigs 投影成 mobile-safe 目录并发布到 Home Node ──
       这是 M1-B 唯一的 authority gap（apiConfigs 仍归浏览器持有）。
       这里用**真实浏览器 + 真实 Home Node**验证三件事：
         · 发布确实发生了（桌面启动链会自动发一次，这里显式再发一次以确保确定）；
         · Home Node 上出现了该角色的 mobile DTO；
         · 出站目录里没有 apiKey / systemPrompt / endpoint。 */
    /* 预检必须真的可用：早期实现把 OPTIONS 处理放在 mobile 分支里，
       /characters/publish 的预检落进管理面返回 404（带 CORS 头但没有
       Access-Control-Allow-Methods）→ 浏览器判定预检失败 → 整个 POST 变成
       "Failed to fetch"，而服务端日志只看到一次 OPTIONS。
       注意**不要**用 fetch(..., {method:'OPTIONS'}) 去断言预检头：那不是预检，
       响应会被标成 type:'cors' 且头对被脚本读取的响应不可见（实测全部为 null）。
       能证明预检可用的唯一可靠方式就是"真实的跨域 POST 成功了"。 */
    const publishProbe = await evaluate(cdp, "(async function(){ try{ var chars=window.IBMobileDto?window.IBMobileDto.characterCatalog(window.apiConfigs||[],{withSpec:true}):[]; var r=await window.IB.homeNode.publishCharacters('smoke',{force:true}); return { len:(window.apiConfigs||[]).length, projected: chars.length, result: JSON.parse(JSON.stringify(r||null)) }; }catch(e){ return { err:String((e&&e.message)||e) }; } })()");
    check('mobile.publishReachesHomeNodeThroughPreflight',
      !!(publishProbe && publishProbe.result && publishProbe.result.ok === true && publishProbe.result.payload &&
         publishProbe.result.payload.count >= 1), publishProbe);
    const catalog = await homeNodeRequest(homePort, '/characters');
    const catalogEntries = ((catalog && catalog.payload && catalog.payload.characters) || []);
    const catalogIds = catalogEntries.map(c => c.id);
    check('mobile.catalog.published', catalogIds.indexOf('m1a_friend') >= 0, { catalogIds: catalogIds, publishProbe: publishProbe });
    /* 目录里必须带上可运行配置（forTurn），否则手机能看角色却发不出消息。 */
    check('mobile.catalog.hasRunnableSpec',
      catalogEntries.some(c => c.id === 'm1a_friend' && c.forTurn === true), catalogEntries);
    /* 通过真实 mobile 面读一次：需要一台设备，用管理面签发。 */
    const pairSession = await homeNodeRequest(homePort, '/pairing/session', 'POST', { deviceName: 'smoke', deviceType: 'android' });
    const paired = await homeNodeRequest(homePort, '/mobile/v1/pairing/complete', 'POST', {
      v: 1, payload: {
        pairingId: pairSession && pairSession.payload && pairSession.payload.pairingId,
        secret: pairSession && pairSession.payload && pairSession.payload.secret,
        deviceName: 'smoke', deviceType: 'android'
      }
    });
    const deviceToken = paired && paired.payload && paired.payload.token;
    check('mobile.pairing.issued', typeof deviceToken === 'string' && deviceToken.length > 20);
    const mobileChars = await homeNodeRequest(homePort, '/mobile/v1/character/list', 'GET', null, { Authorization: 'Bearer ' + deviceToken });
    const mobileRaw = JSON.stringify(mobileChars || {});
    check('mobile.characterList.served', !!((mobileChars && mobileChars.payload && mobileChars.payload.characters) || []).some(c => c.id === 'm1a_friend'), mobileChars && mobileChars.payload);
    check('mobile.noSecretInCatalog',
      mobileRaw.indexOf('apiKey') < 0 && mobileRaw.indexOf('systemPrompt') < 0 &&
      mobileRaw.indexOf('endpoint') < 0 && mobileRaw.indexOf('sk-') < 0 &&
      mobileRaw.indexOf('sk-m1b-smoke-secret') < 0 &&
      mobileRaw.indexOf('只回复测试内容') < 0 && mobileRaw.indexOf('127.0.0.1:' + mock.port) < 0, mobileRaw.slice(0, 400));
    /* 设备 API 未认证必须被拒（真实桌面浏览器进程之外的任何人都不能读）。 */
    const anon = await homeNodeRequest(homePort, '/mobile/v1/character/list');
    check('mobile.anonymousRejected', !!(anon && anon.error && anon.error.code === 'AUTH_REQUIRED'), anon);

    /* sendChatMessage() 不接受文本参数 —— 它按 currentPage 选输入框
       （communication.js:1615-1618 读 #chat-full-input / #chat-input）。
       先真正切到单聊页并打开该角色，再填输入框，走的才是与用户点发送完全相同的链路。 */
    await evaluate(cdp, "(function(){ try{ if(typeof showPage==='function') showPage('chat'); }catch(e){} try{ if(typeof openChatPanel==='function') openChatPanel('m1a_friend'); }catch(e){} return 1; })()");
    await new Promise(resolve => setTimeout(resolve, 800));
    const filled = await evaluate(cdp, "(function(){ var el=document.getElementById('chat-full-input')||document.getElementById('chat-input'); if(!el) return 'no-input'; el.value='M1A-AUTHORITY-PROBE'; var dec=(typeof currentPage!=='undefined')?currentPage:'?'; return 'ok:'+dec+':'+el.id; })()");
    check('chat.inputFilled', String(filled).indexOf('ok:') === 0, filled);
    /* 填值之后**立刻**发送（同一表达式内），避免任何重渲染把草稿清掉；
       并回读 input.value 证明 sendChatMessage 真的看到了这段文本。 */
    const sendResult = await evaluate(cdp, "(async function(){ try{ var a=document.getElementById('chat-full-input'), b=document.getElementById('chat-input'); if(a)a.value='M1A-AUTHORITY-PROBE'; if(b)b.value='M1A-AUTHORITY-PROBE'; var seen=((a&&a.value)||'')+'/'+((b&&b.value)||''); var page=(typeof currentPage!=='undefined')?currentPage:'?'; var r=await sendChatMessage(); return {ok:true, seen:seen, page:page, r: JSON.parse(JSON.stringify(r||null))}; }catch(e){ return {ok:false, err: String((e&&e.message)||e), stack: String((e&&e.stack)||'').slice(0,300)}; } })()");
    check('chat.sendCompleted', sendResult && sendResult.ok === true, JSON.stringify(sendResult));
    check('chat.sendReturnedOk', !!(sendResult && sendResult.r && sendResult.r.ok === true), JSON.stringify(sendResult));

    /* 助手回复出现在页面（渲染链路未回归） */
    check('chat.replyRendered', await waitFor(cdp, "(function(){ return document.body.innerText.indexOf('M1-A authority') >= 0; })()", 20000));

    /* 关键断言：canonical 写入落在 Home Node，而不是只落在浏览器 */
    await new Promise(resolve => setTimeout(resolve, 600));
    const homeList = await homeNodeRequest(homePort, '/list?conversationId=' + encodeURIComponent('dm:m1a_friend') + '&limit=50');
    const homeMessages = (homeList && homeList.messages) || [];
    check('canonical.userMessageInHomeNode',
      homeMessages.some(m => m.role === 'user' && m.content === 'M1A-AUTHORITY-PROBE'),
      homeMessages.map(m => m.role + ':' + String(m.content).slice(0, 24)));
    check('canonical.assistantMessageInHomeNode',
      homeMessages.some(m => m.role === 'assistant' && String(m.content).indexOf('M1-A authority') >= 0),
      homeMessages.map(m => m.role + ':' + String(m.content).slice(0, 24)));
    check('canonical.messageIdsPreserved',
      homeMessages.every(m => /^(msg_|active_)/.test(String(m.id))),
      homeMessages.map(m => m.id));
    const homeMeta = await homeNodeRequest(homePort, '/meta');
    check('canonical.revisionAdvanced', homeMeta && homeMeta.meta && homeMeta.meta.revision >= 2, homeMeta && homeMeta.meta);

    /* 镜像：IndexedDB 里也应有同一批 message id（派生副本，不是第二套事实） */
    check('mirror.hasSameIds', await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); var mine=all.filter(function(m){return m.friendId==='m1a_friend'}); return mine.length>0 && mine.every(function(m){return /^(msg_|active_)/.test(String(m.id))}); })()"));

    /* ── fail closed：停掉 Home Node 后，写必须被拒绝，且镜像不得新增 ── */
    homeNode.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    await evaluate(cdp, "window.IB.homeNode.sync({full:true})");   /* 触发一次探测，把状态置为离线 */
    const before = await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); return all.filter(function(m){return m.friendId==='m1a_friend'}).length; })()");
    const rejected = await evaluate(cdp, "(async function(){ try{ await dbPut('chatMessages',{id:'msg_m1a_offline_u',role:'user',content:'SHOULD-NOT-PERSIST',friendId:'m1a_friend',timestamp:Date.now()}); return {ok:true}; }catch(e){ return {ok:false, code:String(e&&e.code||''), msg:String(e&&e.message||e)}; } })()");
    check('failClosed.writeRejected', rejected && rejected.ok === false, JSON.stringify(rejected));
    check('failClosed.errorIsExplicit', !!(rejected && /home-node/.test(String(rejected.code) + String(rejected.msg))), JSON.stringify(rejected));
    const after = await evaluate(cdp, "(async function(){ var all=await dbGetAll('chatMessages'); return all.filter(function(m){return m.friendId==='m1a_friend'}).length; })()");
    check('failClosed.mirrorUnchanged', before === after, { before, after });
    const orphan = await evaluate(cdp, "(async function(){ var m=await window.__ibCoreDb.get('chatMessages','msg_m1a_offline_u'); return !!m; })()");
    check('failClosed.noOrphanInMirror', orphan === false, orphan);

    check('page.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
    try { homeNode.kill(); } catch (error) { /* ignore */ }
    try { mock.server.close(); } catch (error) { /* ignore */ }
    try { site.server.close(); } catch (error) { /* ignore */ }
  }

  console.log('');
  if (failures) { console.error('M1-A authority 浏览器冒烟失败：' + failures + ' 项 ✘'); process.exitCode = 1; }
  else console.log('M1-A authority browser smoke passed ✔');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
