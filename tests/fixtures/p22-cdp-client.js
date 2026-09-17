'use strict';
/* ====================================================================
   P22-24 · 真实浏览器验收的共享夹具（最小 CDP 客户端 + 三个小工具）
   --------------------------------------------------------------------
   这一份**逐字复制**自 tests/test_p22_23_first_run_acceptance.js 的
   84–158 行（Cdp）与 39–81 行（freePort / chromePath / request / sleep）。
   为什么抽出来而不是复制第三遍：P22-24 的验收要开一个真实浏览器，而
   "同一个 CDP 子集抄三份"会让三份各自漂移 —— 抽出来之后，那两条测试
   与它们的老祖宗在同一个实现上跑。

   ★ 本文件**不**改 P22-23 那条测试（它仍然用自己那一份内联实现）。
   ★ 没有产品依赖：它只被 tests/ 引用，`require` 它不会碰任何产品路径。

   用法：
     const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
     const port = await fx.freePort();
     const cdp = await fx.connectFirstPage(cdpPort);
   ==================================================================== */

const http = require('http');
const net = require('net');
const crypto = require('crypto');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}

/* 真实 Chromium：优先 CHROME_PATH，其次 Chrome，再其次 Edge。 */
function chromePath() {
  const fs = require('fs');
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(c)) return c;
  return null;
}

function request(port, method, urlPath, body, headers) {
  return new Promise(resolve => {
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h, timeout: 8000 }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let j = null; try { j = raw ? JSON.parse(raw) : {}; } catch (_) { j = null; } resolve({ status: res.statusCode, body: j, raw: raw }); });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0 }); });
    r.on('error', () => resolve({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}

/* ── 最小 CDP 客户端（与 P22-16/17/18/22/23 同一子集）────────────────── */
class Cdp {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0;
    this.pending = new Map(); this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => { });
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => resolve(new Cdp(socket)));
      req.on('error', reject);
      req.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, 25000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.sendText({ id, method, params });
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    /* 64 位长度（RFC 6455：8 个字节的长度字段，高位在前）。
       ★ 本文件的验收只用 `Runtime.evaluate`（< 65536 字节），因此这一支
         只作为"完整的客户端"存在；它的字节序按协议写对，而不是靠"用不到"。 */
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6); }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], second = this.buffer[1];
      const opcode = first & 0x0f;
      let offset = 2, length = second & 0x7f;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const masked = (second & 0x80) !== 0;
      let text;
      if (masked) {
        const mask = payload.subarray(0, 4);
        const data = Buffer.alloc(payload.length - 4);
        for (let i = 4; i < payload.length; i++) data[i - 4] = payload[i] ^ mask[(i - 4) & 3];
        text = data.toString('utf8');
      } else text = payload.toString('utf8');
      if (opcode === 0x8) { this.socket.destroy(); return; }
      if (opcode !== 0x1) continue;
      let msg = null;
      try { msg = JSON.parse(text); } catch (_) { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error('cdp ' + JSON.stringify(msg.error))); else p.resolve(msg.result || {});
        continue;
      }
      const ls = this.listeners.get(msg.method) || [];
      for (const l of ls) { try { l(msg.params || {}); } catch (_) { } }
    }
  }
}

/* 起一个 headless Chromium 并连上它第一个 page target。
   ★ 返回的对象带一个 `close()`：它把 CDP socket **销毁**、并且**连子进程树
     一起**结束 Chromium。只调 child.kill() 在 Windows 上不够 —— Chromium
     会留下 renderer/GPU 子进程，而它们的句柄会让一个已经打印完结果的
     Node 测试进程永远不退出（P22-24 实测：结果打印完之后挂到超时）。 */
async function launchChrome(exe, options) {
  const o = options || {};
  const { spawn, execFile } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cdpprofile-'));
  const cdpPort = await freePort();
  const args = [
    '--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--disable-gpu', '--force-device-scale-factor=1',
    '--disable-features=Translate,BackForwardCache'
  ].concat(o.args || []).concat([o.startUrl || 'about:blank']);
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  let cdp = null;
  for (let i = 0; i < 80 && !cdp; i++) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: cdpPort, path: '/json/list' }, res => {
          let raw = ''; res.on('data', c => { raw += c; });
          res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      const target = list.filter(t => t.type === 'page')[0];
      if (target && target.webSocketDebuggerUrl) cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    } catch (_) { /* 还没起来 */ }
    if (!cdp) await sleep(250);
  }
  if (!cdp) {
    try { child.kill(); } catch (_) { }
    throw new Error('CDP 连接超时');
  }
  function close() {
    return new Promise(resolve => {
      try { if (cdp && cdp.socket) cdp.socket.destroy(); } catch (_) { }
      const done = () => resolve();
      if (process.platform === 'win32' && child.pid) {
        try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => done()); }
        catch (_) { try { child.kill(); } catch (__) { } done(); }
      } else {
        try { child.kill('SIGKILL'); } catch (_) { }
        done();
      }
    });
  }
  return { child: child, cdp: cdp, profile: profile, cdpPort: cdpPort, close: close };
}

module.exports = {
  Cdp: Cdp,
  sleep: sleep,
  freePort: freePort,
  chromePath: chromePath,
  request: request,
  launchChrome: launchChrome
};
