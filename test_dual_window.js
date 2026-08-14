'use strict';

/*
 * 双窗口同步测试（Node 18+，零依赖）
 *
 * 通过 Chrome DevTools 协议打开两个真实标签页：
 *  - 标签 A 模拟聊天写入（写入 localStorage 同步信号，对应 dbPut 包装器）
 *  - 标签 B 应通过 storage 事件触发同步逻辑（window.__ibSyncCount 增加）
 *
 * 用法： node test_dual_window.js
 * 依赖：本机安装 Chrome / Edge（可用 CHROME_PATH 指定）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this._id = 0;
    this._pending = new Map();
    socket.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on('error', () => {});
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const u = new URL(wsUrl);
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13'
        }
      });
      req.on('upgrade', (res, socket) => resolve(new Cdp(socket)));
      req.on('error', reject);
      req.end();
    });
  }

  send(method, params) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._sendText({ id, method, params: params || {} });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 15000);
    });
  }

  _sendText(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    header[0] = 0x81;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  _parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], len0 = this.buf[1] & 0x7f;
      let off = 2, len = len0;
      if (len0 === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len0 === 127) {
        if (this.buf.length < 10) return;
        len = this.buf.readUInt32BE(6);
        off = 10;
      }
      const masked = (this.buf[1] & 0x80) !== 0;
      let maskKey = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        maskKey = this.buf.slice(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (maskKey) {
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      const op = b0 & 0x0f;
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this._sendFrame(0xA, payload); continue; }
      if (op !== 0x1) continue;
      let m;
      try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      if (m.id && this._pending.has(m.id)) {
        const p = this._pending.get(m.id);
        this._pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result || {});
      }
    }
  }

  _sendFrame(op, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    header[0] = 0x80 | op;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    try { this.socket.destroy(); } catch (e) { /* 忽略 */ }
  }
}

async function cdpEval(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result && r.result.value;
}

async function waitFor(cdp, expression, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await cdpEval(cdp, expression)) return true;
    } catch (e) { /* 页面尚未就绪 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const chrome = chromePath();
  if (!chrome) {
    console.error('未找到 Chrome/Edge，请设置 CHROME_PATH');
    process.exit(1);
  }
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dual-'));
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let failures = 0;
  const ok = (name, cond, extra) => {
    if (cond) console.log('  PASS  ' + name);
    else { failures++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  };

  try {
    const end = Date.now() + 15000;
    let ready = false;
    while (Date.now() < end) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (r.ok) { ready = true; break; }
      } catch (e) { /* 未就绪 */ }
      await new Promise(r => setTimeout(r, 250));
    }
    ok('cdp.chromeReady', ready);
    if (!ready) throw new Error('Chrome DevTools 未就绪');

    const mkTab = async () => {
      const r = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' });
      return r.json();
    };
    const tabA = await mkTab();
    const tabB = await mkTab();
    const cdpA = await Cdp.connect(tabA.webSocketDebuggerUrl);
    const cdpB = await Cdp.connect(tabB.webSocketDebuggerUrl);

    ok('tabA.ready', await waitFor(cdpA, "document.readyState==='complete' && document.documentElement.getAttribute('data-ib-wrapped')==='1'", 20000));
    ok('tabB.ready', await waitFor(cdpB, "document.readyState==='complete' && document.documentElement.getAttribute('data-ib-wrapped')==='1'", 20000));

    await cdpEval(cdpB, 'navTo("chat")');
    await new Promise(r => setTimeout(r, 400));
    ok('tabB.onChatPage', await cdpEval(cdpB, 'typeof currentPage!=="undefined" && currentPage==="chat"'));

    /* 重复初始化保护：手动再调两次 boot，不应重复创建面板/定时器 */
    await cdpEval(cdpB, 'window.__ibBootFn(); window.__ibBootFn();');
    const bootCount = await cdpEval(cdpB, 'window.__ibBootCount');
    const fabCount = await cdpEval(cdpB, 'document.querySelectorAll("#ib-bridge-fab").length');
    const navCount = await cdpEval(cdpB, 'document.querySelectorAll("#ib-bridge-nav").length');
    const panelCount = await cdpEval(cdpB, 'document.querySelectorAll("#ib-bridge-panel").length');
    ok('repeatInit.guarded', bootCount === 3 && fabCount === 0 && navCount === 1 && panelCount === 1, 'boot=' + bootCount + ' fab=' + fabCount + ' nav=' + navCount + ' panel=' + panelCount);

    const before = await cdpEval(cdpB, 'window.__ibSyncCount');
    await cdpEval(cdpA, "localStorage.setItem('ib_chat_sync', String(Date.now()))");
    await new Promise(r => setTimeout(r, 1200));
    const after = await cdpEval(cdpB, 'window.__ibSyncCount');
    ok('dualWindow.storageSync', typeof after === 'number' && after >= (before || 0) + 1, 'before=' + before + ' after=' + after);

    cdpA.close();
    cdpB.close();
  } catch (e) {
    failures++;
    console.error('  异常：' + (e && e.message || e));
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log(failures === 0 ? '\n双窗口测试全部通过 ✔' : '\n双窗口测试失败 ' + failures + ' 项 ✘');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
