'use strict';
/* ============================================================================
   Internal Beyond · UI-P1 · Memory World browser-test harness
   ----------------------------------------------------------------------------
   只属于测试侧的 CDP 助手。三个 Memory World 套件共用它，避免把同一段
   Chrome 启动 / CDP 客户端 / 数据播种代码复制三遍（仓库既有做法见
   tests/fixtures/p22-cdp-client.js 与 tests/test_memory_smoke.js）。

   它不做任何产品断言；断言留在各自的 test_memory_world_*.js 里。
   ============================================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      /* 大载荷（例如播种几百条记忆）必须走 64 位长度形态。 */
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  parse() {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      const len = this.buffer[1] & 0x7f;
      let offset = 2;
      let length = len;
      if (len === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);
      if (opcode === 0x8) { try { this.socket.end(); } catch (error) { /* closed */ } return; }
      if (opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch (error) { continue; }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
        else entry.resolve(message.result);
        continue;
      }
      const handlers = this.listeners.get(message.method) || [];
      handlers.forEach(handler => { try { handler(message.params); } catch (error) { /* listener */ } });
    }
  }
  close() { try { this.socket.end(); } catch (error) { /* closed */ } }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(description || result.exceptionDetails.text || 'evaluate failed');
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evaluate(cdp, expression)) return true; } catch (error) { /* keep polling */ }
    await sleep(120);
  }
  return false;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/* 播种 / 清理 memory 行：直接走既有 IndexedDB 连接（ensureDB/db 是 core.js 的
   全局绑定），绕开生产写包装器，因此播种本身不经过任何 memory authority 策略。 */
const SEED_FN = `
window.__mwSeed = function (rows) {
  return ensureDB().then(function () {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('memories', 'readwrite');
      var store = tx.objectStore('memories');
      for (var i = 0; i < rows.length; i++) store.put(rows[i]);
      tx.oncomplete = function () { resolve(rows.length); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
};
window.__mwClear = function () {
  return ensureDB().then(function () {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('memories', 'readwrite');
      tx.objectStore('memories').clear();
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
};
window.__mwSnapshot = function () {
  return dbGetAll('memories').then(function (rows) {
    return rows.map(function (r) {
      var keys = Object.keys(r).sort();
      var parts = [];
      for (var i = 0; i < keys.length; i++) parts.push(keys[i] + '=' + JSON.stringify(r[keys[i]]));
      return parts.join('&');
    }).sort().join('\\n');
  });
};
window.__mwWrapWriters = function () {
  if (window.__mwWriters) return true;
  var counters = {
    dbPut: 0, dbPutMemories: 0,
    dbDelete: 0, dbDeleteMemories: 0,
    dbUpdate: 0, dbUpdateMemories: 0,
    activate: 0
  };
  window.__mwWriters = counters;
  var names = ['dbPut', 'dbDelete', 'dbUpdate'];
  names.forEach(function (name) {
    var original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function (store) {
      counters[name] += 1;
      if (store === 'memories') counters[name + 'Memories'] += 1;
      return original.apply(this, arguments);
    };
  });
  var activate = window.recordMemoryActivation;
  if (typeof activate === 'function') {
    window.recordMemoryActivation = function () {
      counters.activate += 1;
      return activate.apply(this, arguments);
    };
  }
  return true;
};
window.__mwResetWriters = function () {
  var c = window.__mwWriters;
  if (!c) return null;
  Object.keys(c).forEach(function (k) { c[k] = 0; });
  return c;
};
window.__mwReadWriters = function () {
  return window.__mwWriters ? JSON.parse(JSON.stringify(window.__mwWriters)) : null;
};
window.__mwStorageKeys = function () {
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return keys.sort();
};
`;

const DOMAINS = ['情感', '日常', '创作', '思考'];
const SOURCES = ['manual', 'chat', 'letter', 'blog'];

function makeRecords(count, prefix) {
  const tag = prefix || 'mw';
  const rows = [];
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i++) {
    const importance = 1 + ((i * 7) % 10);
    rows.push({
      id: tag + '_mem_' + i,
      title: tag + ' 记忆 ' + i,
      summary: '第 ' + i + ' 条记忆的摘要。',
      content: '第 ' + i + ' 条记忆的正文，用于验证 Memory World 只读既有事实。',
      oneLine: i % 3 === 0 ? '第 ' + i + ' 条的一句话。' : '',
      domain: DOMAINS[i % DOMAINS.length],
      tags: ['测试', 'mw' + (i % 5)],
      valence: ((i % 10) / 10),
      arousal: (((i * 3) % 10) / 10),
      importance: importance,
      resolved: i % 4 === 0,
      pinned: i % 11 === 0,
      visibility: 'public',
      visibleTo: [],
      excludeFrom: [],
      kind: i % 5 === 0 ? 'semantic' : 'episodic',
      rawSource: SOURCES[i % SOURCES.length],
      sourceId: '',
      createdBy: 'user',
      createdByName: '',
      editedByUser: false,
      activationCount: i % 13,
      lastActivated: base + i * 3600000,
      created: base + i * 86400000,
      consolidatedFrom: [],
      lastConsolidatedAt: null
    });
  }
  return rows;
}

async function launch(options = {}) {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mem-world-'));
  const width = options.width || 1440;
  const height = options.height || 900;
  const extra = options.mobile ? ['--force-device-scale-factor=1'] : [];
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--force-color-profile=srgb',
    '--window-size=' + width + ',' + height,
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, 'about:blank'
  ].concat(extra), { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) { ready = true; break; }
    } catch (error) { /* browser is starting */ }
    await sleep(100);
  }
  if (!ready) {
    try { browser.kill(); } catch (error) { /* noop */ }
    throw new Error('Chrome DevTools 未就绪');
  }

  const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(options.url || PAGE_URL), { method: 'PUT' })).json();
  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const exceptions = [];
  cdp.on('Runtime.exceptionThrown', params => {
    const d = params.exceptionDetails || {};
    exceptions.push(String((d.exception && d.exception.description) || d.text || ''));
  });
  const consoleErrors = [];
  cdp.on('Runtime.consoleAPICalled', params => {
    if (params.type === 'error') {
      consoleErrors.push((params.args || []).map(a => a.value || a.description || '').join(' '));
    }
  });
  await evaluate(cdp, "window.confirm = function(){ return true; };");

  return {
    cdp, browser, profile, port, exceptions, consoleErrors,
    async setViewport(w, h, mobile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
      await settle(cdp);
    },
    async reload() {
      await cdp.send('Page.reload', { ignoreCache: false });
      await settle(cdp);
    },
    async close() {
      try { cdp.close(); } catch (error) { /* noop */ }
      try { browser.kill(); } catch (error) { /* noop */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* noop */ }
    }
  };
}

/* 等应用壳起来（启动页会自己 navTo）。 */
async function waitForApp(cdp, timeoutMs = 25000) {
  return waitFor(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')", timeoutMs);
}

/* 进入应用壳。
   两代启动行为都要能走通：新树有一个总是 bypassWelcome 的 startup route；
   HEAD-era 树则停在欢迎页上，必须走它自己的入口（enterSite）。
   找不到任何入口时，只把欢迎页让开（测试环境脚手架，不改产品代码）。 */
async function enterAppShell(cdp, timeoutMs = 30000) {
  await waitFor(cdp, "typeof window.navTo === 'function' && !!document.getElementById('page-memory')", timeoutMs);
  const already = await evaluate(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')");
  if (already) return true;
  await evaluate(cdp, `(function(){
    try {
      if (typeof window._ibResolveStartupRoute === 'function' && typeof window._ibOpenStartupRoute === 'function') {
        window._ibOpenStartupRoute();
        return 'startup-route';
      }
      if (typeof window.enterSite === 'function') { window.enterSite('memory'); return 'enter-site'; }
    } catch (e) {}
    return 'none';
  })()`);
  if (await waitFor(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')", 12000)) return true;
  await evaluate(cdp, `(function(){
    var sp = document.getElementById('splash');
    if (sp) { sp.classList.add('hidden'); sp.classList.add('dissolving'); }
    ['app', 'navbar', 'music-mini', 'fab-dock'].forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.classList.add('visible');
    });
    return true;
  })()`);
  return waitFor(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')", 10000);
}

/* 全新 profile 会触发首次引导（#ib-setup）。它是一层覆盖全屏的 overlay，
   会吃掉指针事件；更麻烦的是它在 document 上以 capture 阶段绑定 Escape 并
   stopPropagation —— 只要它处于打开状态，任何别的对话框都拿不到 Escape。
   处理顺序必须是「先让它真的打开 → 走产品自己的 skip → 重新加载」：
   boot() 是异步的（waitForAppVisible 之后才 open()），过早 skip 会被 boot()
   的 open() 再开一次；而 skip 写下的完成记录会让重载后的 boot() 直接判定
   existing-user，从此不再挂载它的全局监听。 */
async function dismissSetupWizard(cdp) {
  const alreadyDone = await evaluate(cdp, `(async function(){
    try { var r = await dbGet('apiSettings', 'ibSetupV1Done'); return !!(r && r.done); }
    catch (e) { return false; }
  })()`);
  if (alreadyDone) return 'already-done';

  const appeared = await waitFor(cdp, "!!document.getElementById('ib-setup') && document.getElementById('ib-setup').classList.contains('is-open')", 12000);
  if (!appeared) return 'absent';

  await evaluate(cdp, "(function(){ try { if (window.IBSetup) window.IBSetup.skip(); } catch (e) {} return true; })()");
  await sleep(900);
  await cdp.send('Page.reload', { ignoreCache: false });
  await settle(cdp);
  const back = await enterAppShell(cdp);
  const stillOpen = await evaluate(cdp, "!!document.getElementById('ib-setup') && document.getElementById('ib-setup').classList.contains('is-open')");
  if (!back) return 'reload-timeout';
  if (!stillOpen) return 'skipped+reloaded';
  await evaluate(cdp, "(function(){ var o = document.getElementById('ib-setup'); if (o) o.classList.remove('is-open'); return true; })()");
  return 'forced';
}

/* 等 Memory World 模块（由 memory-sky.js 运行时注入）挂载完成。
   mounted = 模块已挂载到 DOM；ready = 已读完既有 memory 事实。 */
async function waitForWorld(cdp, timeoutMs = 25000) {
  return waitFor(cdp, "typeof window.IB === 'object' && window.IB.memoryWorld && window.IB.memoryWorld.stats().mounted === true", timeoutMs);
}

async function waitForWorldReady(cdp, timeoutMs = 25000) {
  return waitFor(cdp, "typeof window.IB === 'object' && window.IB.memoryWorld && window.IB.memoryWorld.stats().mounted === true && window.IB.memoryWorld.stats().ready === true", timeoutMs);
}

async function settle(cdp) {
  try {
    await evaluate(cdp, 'new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(true)})})})');
  } catch (error) { /* page may be mid-navigation */ }
}

async function seedMemories(cdp, rows) {
  await evaluate(cdp, SEED_FN);
  /* 分块：单条 evaluate 表达式保持小尺寸，避免超大 CDP 载荷。 */
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await evaluate(cdp, 'window.__mwSeed(' + JSON.stringify(rows.slice(i, i + CHUNK)) + ')');
  }
  return rows.length;
}

async function clearMemories(cdp) {
  await evaluate(cdp, SEED_FN);
  return evaluate(cdp, 'window.__mwClear()');
}

async function snapshotMemories(cdp) {
  await evaluate(cdp, SEED_FN);
  return evaluate(cdp, 'window.__mwSnapshot()');
}

async function goToMemoryPage(cdp) {
  await dismissSetupWizard(cdp);
  await evaluate(cdp, "navTo('memory')");
  await settle(cdp);
  const mounted = await waitFor(cdp, "document.getElementById('page-memory').classList.contains('active') && !!document.getElementById('mem-world-entry')", 20000);
  if (!mounted) return false;
  return waitForWorldReady(cdp, 20000);
}

/* 画布平均亮度（用于 light/dark 的真实渲染差异取证，不是肉眼结论）。 */
async function canvasBrightness(cdp, selector) {
  return evaluate(cdp, `(function(){
    var c = document.querySelector(${JSON.stringify(selector)});
    if (!c || !c.width || !c.height) return -1;
    var ctx = c.getContext('2d');
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var sum = 0, n = 0;
    for (var i = 0; i < d.length; i += 4000) { sum += d[i] + d[i + 1] + d[i + 2]; n += 3; }
    return n ? sum / n : -1;
  })()`);
}

async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await settle(cdp);
}

/* 真实键盘事件（不是合成 KeyboardEvent）：Escape 关闭契约必须经浏览器输入栈验证。 */
async function pressKey(cdp, key) {
  const map = { Escape: { code: 'Escape', vk: 27 }, Tab: { code: 'Tab', vk: 9 }, Enter: { code: 'Enter', vk: 13 } };
  const meta = map[key] || { code: key, vk: 0 };
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code: meta.code, windowsVirtualKeyCode: meta.vk, nativeVirtualKeyCode: meta.vk
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: meta.code, windowsVirtualKeyCode: meta.vk, nativeVirtualKeyCode: meta.vk
  });
  await settle(cdp);
}

function makeChecker(label) {
  let failures = 0;
  let passed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed += 1; console.log('  PASS  ' + name); return true; }
    failures += 1;
    console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
    return false;
  };
  const info = message => console.log('  INFO  ' + message);
  const finish = () => {
    console.log('\n' + '='.repeat(64));
    if (failures) {
      console.error(label + ' FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
      process.exit(1);
    }
    console.log(label + ' PASSED · ' + passed + ' assertions green');
    process.exit(0);
  };
  return { check, info, finish, counts: () => ({ failures, passed }) };
}

module.exports = {
  ROOT, PAGE_URL, chromePath, Cdp, evaluate, waitFor, sleep, freePort,
  launch, waitForApp, enterAppShell, waitForWorld, waitForWorldReady, dismissSetupWizard, settle, seedMemories, clearMemories,
  snapshotMemories, goToMemoryPage, canvasBrightness, clickAt, pressKey, makeRecords,
  makeChecker, SEED_FN
};
