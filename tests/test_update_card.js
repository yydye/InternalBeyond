'use strict';
/* Internal Beyond — U4 Diagnostics 更新卡片契约测试
   运行：node test_update_card.js      （零网络、零浏览器、不安装任何东西）

   覆盖：
     A. 静态契约 —— 不重新实现任何 Node 真源（manifest / semver / 传输 / 回退 /
        SHA-256 / PE / 安装器 spawn / 安装状态机）、只调三个既有端点、
        只提交 { version }、页面不新建第二套设置页或更新页、
        P5 的 diagnostics.js 不被污染（仍然不碰 localStorage 与更新端点）
     B. 纯逻辑 —— 后端状态 → 阶段、一次性判定（成功/未完成/未知）、
        失败分类、字节格式化
     C. 行为（最小 DOM shim + 注入 fetch）—— 八个状态各自的文案与按钮、
        真实字节进度、notes 的 XSS 防护、installing 之后断开不误报失败、
        成功标记只消费一次、旧版本重开显示「更新未完成」、
        POST 体只有 version
     D. 普通用户文案不得出现底层术语（对全部渲染结果逐条扫描）
     E. 相邻回归 —— 子进程跑 test_diagnostics.js 与 test_frontend_structure.js

   说明：真实浏览器 smoke 在 test_update_card_smoke.js（browser 组）。 */

const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');

const JS_PATH = path.join(ROOT, 'assets', 'js', 'update-card.js');
const CSS_PATH = path.join(ROOT, 'assets', 'css', 'update-card.css');
const DIAG_PATH = path.join(ROOT, 'assets', 'js', 'diagnostics.js');
const HTML_PATH = path.join(ROOT, 'InternalBeyond.html');

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

const jsBuf = fs.readFileSync(JS_PATH);
const jsSrc = jsBuf.toString('utf8').replace(/^\uFEFF/, '');
/* 去掉注释后的代码：注释里出现「manifest / SHA-256 / innerHTML」这类词是解释性
   文字，不构成实现，也不构成用户文案。 */
const codeOnly = jsSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
/* 失败分类表里必然出现 'sha256-mismatch' / 'pe-version-mismatch' / 'spawn-failed'
   这些 kind 字面量——它们是「分类」而不是「实现」。做实现类扫描前先把这张表摘掉，
   然后再单独断言这些字面量只出现在分类表里。 */
const KIND_TABLE = (codeOnly.match(/var KIND_CLASS = \{[\s\S]*?\n  \};/) || [''])[0];
const codeNoKinds = codeOnly.replace(KIND_TABLE, ' ');
/* readProductVersion 是复用诊断页的版本读取（同一版本链），不是 PE 资源读取 */
const codeNoDiag = codeNoKinds.replace(/readProductVersion/g, ' ');
const cssBuf = fs.readFileSync(CSS_PATH);
const cssSrc = cssBuf.toString('utf8').replace(/^\uFEFF/, '');
const html = fs.readFileSync(HTML_PATH, 'utf8').replace(/^\uFEFF/, '');
const diagSrc = fs.readFileSync(DIAG_PATH, 'utf8').replace(/^\uFEFF/, '');

/* ═══ A. 静态契约 ═══════════════════════════════════════════ */
section('文件与编码（与 test_frontend_structure 同一规则）');
check('update-card.js 存在', fs.existsSync(JS_PATH));
check('update-card.css 存在', fs.existsSync(CSS_PATH));
check('js 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(jsBuf); return true; } catch (e) { return false; } })());
check('css 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(cssBuf); return true; } catch (e) { return false; } })());
check('js 带 UTF-8 BOM', jsBuf[0] === 0xef && jsBuf[1] === 0xbb && jsBuf[2] === 0xbf);
check('css 带 UTF-8 BOM', cssBuf[0] === 0xef && cssBuf[1] === 0xbb && cssBuf[2] === 0xbf);
check('无乱码特征', !/\uFFFD|锟斤拷|Ã.|Â.|â(?:€|™|œ|“|”)/.test(jsSrc + cssSrc));
check('js 语法可解析', (() => { try { new vm.Script(jsSrc, { filename: 'update-card.js' }); return true; } catch (e) { return false; } })());

section('HTML 挂载：一个脚本、零新样式表、零内联样式');
const scriptTags = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
const styleTags = [...html.matchAll(/<link[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
check('HTML 只挂载一次 update-card.js', scriptTags.filter(s => s === 'assets/js/update-card.js').length === 1);
check('HTML 样式表数量未变（20）', styleTags.length === 20, styleTags.length);
check('HTML 没有 update-card.css 的 <link>', !styleTags.includes('assets/css/update-card.css'));
check('HTML 无 <style> 块', !/<style\b/i.test(html));
check('HTML 无内联 <script>', [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim()).length === 0);
check('HTML 静态内联样式预算未变（<=200）', (html.match(/\bstyle\s*=/gi) || []).length <= 200, (html.match(/\bstyle\s*=/gi) || []).length);
check('卡片不新增 style= 属性（用 style 属性赋值而不是内联字符串）', (jsSrc.match(/\bstyle\s*=/gi) || []).length === 0);
check('模块运行时注入自己的样式表', /STYLE_HREF\s*=\s*'assets\/css\/update-card\.css'/.test(jsSrc) && /rel\s*=\s*'stylesheet'/.test(jsSrc));
check('样式只用 core.css 的 token（无硬编码颜色）', !/#[0-9a-fA-F]{3,8}\b/.test(cssSrc) && !/rgba?\(/.test(cssSrc));

section('不重新实现任何 Node 真源（U4 只渲染）');
check('没有第二份 HTTPS / 传输实现', !/https?:\/\//.test(codeOnly) && codeOnly.indexOf('XMLHttpRequest') === -1);
check('没有 SHA-256 / 哈希实现', !/sha-?256|createHash|digest|subtle/i.test(codeNoKinds));
check('没有 PE / 版本资源读取', !/\bPE\b|ProductVersion|FileVersion|VS_FIXEDFILEINFO|pe-version/.test(codeNoDiag));
check('版本只从诊断页读（唯一版本链）', /api\.readProductVersion\(\)/.test(codeOnly));
/* UI 的等待上限必须容得下服务端自己能花的时间（primary + API 版本 + API 资产），
   否则「还在查」会被自己的超时显示成「查不了」。 */
check('检查超时 ≥ 服务端三段网络往返', (() => {
  const transportTimeout = require(path.join(ROOT, 'runtime', 'update-transport.js')).REQUEST_TIMEOUT_MS;
  const m = codeOnly.match(/var CHECK_TIMEOUT_MS = (\d+)/);
  return !!m && Number(m[1]) > 3 * transportTimeout;
})(), codeOnly.match(/var CHECK_TIMEOUT_MS = \d+/));
check('没有 semver 比较 / 版本解析', !/semver|compareVersion|parseVersion|major\s*[<>]/.test(codeNoKinds));
check('不读 VERSION 文件', codeNoKinds.indexOf('VERSION') === -1 && codeNoKinds.indexOf('/VERSION') === -1);
check('不 spawn / 不碰子进程', !/require\(|child_process|spawn|execFile|shell/.test(codeNoKinds));
check('不碰安装器的参数或路径', !/installer|\.exe|silent|IBRELAUNCH/i.test(codeNoKinds));
check('不自己实现 24h 缓存 / 时间戳过期判断', !/CACHE_TTL|86400|24\s*\*\s*60\s*\*\s*60|isCacheValid/.test(codeNoKinds));
check('分类表里没有实现（只有 kind → 类别的映射）', /var KIND_CLASS = \{[\s\S]*?\};/.test(codeOnly) && !/function|=>/.test(KIND_TABLE));
check('端点只有三个既有端点', (() => {
  const urls = [...codeOnly.matchAll(/'(\/[^']*)'/g)].map(m => m[1]);
  return urls.length === 3 &&
    urls.indexOf('/__update-check') >= 0 && urls.indexOf('/__update/status') >= 0 && urls.indexOf('/__update/start') >= 0;
})());
/* 这三个路径必须逐字等于服务端真实实现的路由——文档里曾经把状态端点写成
   /__update-status，UI 照着文档写就会 404（真实浏览器 smoke 抓到过这个坑）。 */
check('三个路径逐字等于服务端实现的路由', (() => {
  const srv = fs.readFileSync(path.join(ROOT, 'services', 'internal-beyond-server.js'), 'utf8');
  return ['/__update-check', '/__update/start', '/__update/status']
    .every(u => srv.indexOf("pathname === '" + u + "'") >= 0);
})());
check('UI 的三个常量与服务端路由一一对应', (() => {
  const srv = fs.readFileSync(path.join(ROOT, 'services', 'internal-beyond-server.js'), 'utf8');
  const want = { CHECK_URL: '/__update-check', STATUS_URL: '/__update/status', START_URL: '/__update/start' };
  return Object.keys(want).every(k => {
    const m = codeOnly.match(new RegExp('var ' + k + " = '([^']+)'"));
    return !!m && m[1] === want[k] && srv.indexOf("pathname === '" + m[1] + "'") >= 0;
  });
})());
check('检查端点只用 GET + force 语义', /CHECK_URL\s*\+\s*\(force\s*\?\s*'\?force=1'\s*:\s*''\)/.test(codeOnly));
check('POST 体只有 version', /JSON\.stringify\(\s*\{\s*version:\s*version\s*\}\s*\)/.test(codeOnly) && codeOnly.indexOf('url:') === -1 && codeOnly.indexOf('sha256:') === -1);
check('没有第二套 notes 渲染（只有 textContent）', /notes\.textContent\s*=/.test(codeOnly) && codeOnly.indexOf('innerHTML') === -1);
check('notes 渲染点在 available 阶段之外被清空', /else\s+n\.notes\.textContent\s*=\s*''/.test(codeOnly));

section('页面归属：不新建第二个页面 / 不碰设置页');
check('不引用 API 设置页的容器或区块', codeOnly.indexOf('page-api') === -1 && codeOnly.indexOf('api-section') === -1);
check('只挂到 page-diagnostics', (codeOnly.match(/page-diagnostics/g) || []).length >= 1 && codeOnly.indexOf("'page-") === codeOnly.indexOf("'page-diagnostics'"));
check('通过诊断页的扩展卡位注册（不自己抢宿主）', /registerCard\(renderInto\)/.test(codeOnly) && /api\.registerCard/.test(codeOnly));
check('P5 的 diagnostics.js 提供卡位但没有被更新逻辑污染', /registerCard/.test(diagSrc) && diagSrc.indexOf('__update') === -1 && !/localStorage|sessionStorage/.test(diagSrc));
check('diagnostics.js 仍然只读 P2 的 /__boot-state', /BOOT_URL\s*=\s*'\/__boot-state'/.test(diagSrc));

section('本地存储只用于两件事');
check('只写两个键（一次性标记 + 自动检查开关）', (() => {
  const keys = [...codeOnly.matchAll(/storeSet\(([A-Z_]+)/g)].map(m => m[1]);
  return keys.length === 2 && keys.every(k => k === 'MARKER_KEY' || k === 'AUTO_KEY');
})());
check('标记带 schema 版本，认不出来就丢掉', /MARKER_SCHEMA\s*=\s*'internalbeyond\.update-pending'/.test(codeOnly) && /parsed\.schema\s*!==\s*MARKER_SCHEMA/.test(codeOnly));
check('不把用户配置写进本地存储', !/apiKey|apiConfigs|token|Authorization/i.test(codeOnly));

section('不在启动关键路径上');
check('launcher 不引用更新卡片', fs.readFileSync(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'), 'utf8').indexOf('update-card') === -1);
check('服务管理器不引用更新卡片', fs.readFileSync(path.join(ROOT, 'runtime', 'local-services-runner.js'), 'utf8').indexOf('update-card') === -1);
check('新增资源随包发布（assets 目录整体入包）', /from:\s*'assets',\s*dir:\s*true/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'release-manifest.js'), 'utf8')));

/* ═══ B/C. 最小 DOM shim + 注入 fetch ═══════════════════════ */
section('模块加载与渲染（最小 DOM shim + 注入 fetch）');

let innerHTMLUses = 0;
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attributes: {},
    value: '',
    checked: false,
    disabled: false,
    id: '',
    type: '',
    className: '',
    onclick: null,
    onchange: null,
    _text: '',
    _html: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; if (on) this._s.add(c); else this._s.delete(c); return on; }
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener() { },
    removeEventListener() { },
    scrollIntoView() { },
    focus() { },
    click() { if (typeof this.onclick === 'function') this.onclick(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set innerHTML(v) { innerHTMLUses++; this._html = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    get firstChild() { return this.children[0] || null; }
  };
  return node;
}
function findById(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) { const hit = findById(c, id); if (hit) return hit; }
  return null;
}
function allText(node) {
  if (!node) return '';
  let s = node._text || '';
  for (const c of node.children || []) s += ' ' + allText(c);
  return s;
}
function visible(node) { return !!node && !node.classList.contains('is-hidden'); }

const flush = async (n) => { for (let i = 0; i < (n || 5); i++) await new Promise(r => setImmediate(r)); };

/*
 * 每个场景一个沙箱：模块在加载时就会 boot（注册卡片 + 读版本 + 读状态 + 可能自动检查），
 * 所以路由必须在加载前就位。fetch 是本测试唯一注入的边界——它同时记录每一次调用的
 * URL 与方法/正文，U4 的「不得提交 url/hash/path/asset/command」就是在这里断言的。
 */
function makeBox(opts) {
  const o = opts || {};
  const net = { check: null, status: null, start: null, calls: [] };
  const lsData = Object.assign({}, o.storage || {});
  const doc = {
    readyState: 'complete',
    head: makeEl('head'),
    body: makeEl('body'),
    createElement: makeEl,
    getElementById(id) { return findById(this.body, id) || findById(this.head, id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() { },
    removeEventListener() { }
  };
  const host = makeEl('div');
  host.id = 'page-diagnostics';
  doc.body.appendChild(host);

  const cards = [];
  const prod = { version: o.version === undefined ? '1.0.0' : o.version };

  function routeFor(url) {
    if (url.indexOf('/__update-check') === 0) return net.check;
    if (url.indexOf('/__update/status') === 0) return net.status;
    if (url.indexOf('/__update/start') === 0) return net.start;
    return null;
  }
  function fetchStub(url, init) {
    const target = String(url);
    net.calls.push({ url: target, method: (init && init.method) || 'GET', body: String((init && init.body) || '') });
    return new Promise(function (resolve, reject) {
      const r = routeFor(target);
      /* 没有路由 / down:true 都表示「服务读不到」——这正是 installing 阶段会发生的事 */
      const deliver = function () {
        if (r.down) { const e = new Error('Failed to fetch'); e.name = 'TypeError'; reject(e); return; }
        resolve({
          ok: r.ok !== false,
          status: r.status || 200,
          text: function () { return Promise.resolve(JSON.stringify(r.json === undefined ? {} : r.json)); }
        });
      };
      if (!r || r.down) { const e = new Error('Failed to fetch'); e.name = 'TypeError'; reject(e); return; }
      if (r.defer) { r.settle = function () { delete r.defer; deliver(); }; return; }
      deliver();
    });
  }

  const sandbox = {
    console: { log() { }, warn() { }, error() { } },
    /* 定时器：unref 掉，避免测试进程被挂起的轮询/超时拖住 */
    setTimeout: function (fn, ms) { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; },
    clearTimeout: function (t) { clearTimeout(t); },
    setInterval, clearInterval, Promise, Object, Array, String, Number, Math, JSON, Date, Error, RegExp, Set, Map, AbortController, TextDecoder,
    document: doc,
    location: { origin: 'http://127.0.0.1:23120', hash: '' },
    navigator: { userAgent: 'Mozilla/5.0 TestChrome/120' },
    fetch: fetchStub,
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null; },
      setItem(k, v) { lsData[k] = String(v); },
      removeItem(k) { delete lsData[k]; }
    },
    IB: {
      expose(n, ob) { this[n] = ob; return ob; },
      diagnostics: o.noDiagnostics ? undefined : {
        registerCard(fn) { cards.push(fn); fn(host); return true; },
        productVersion() { return prod.version; },
        readProductVersion() { return Promise.resolve(prod.version); }
      }
    },
    addEventListener() { },
    removeEventListener() { }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(jsSrc, sandbox, { filename: 'update-card.js' });

  const api = sandbox.IBUpdateCard;
  const T = api && api.__test;
  return {
    sandbox, doc, host, net, lsData, cards, api, T, prod,
    id: (i) => doc.getElementById(i),
    text: (i) => allText(doc.getElementById(i)),
    state: () => (doc.getElementById('ib-update-state') || {}).dataset ? doc.getElementById('ib-update-state').dataset.state : '',
    /* 模拟诊断页重渲染：清空宿主后重新调用注册的卡片函数 */
    rerenderPage() { while (host.firstChild) host.removeChild(host.firstChild); cards.forEach(fn => fn(host)); },
    dispose() { try { T.reset(); } catch (e) { } }
  };
}

const CHECK_AVAILABLE = {
  json: {
    ok: true, status: 'update-available', updateAvailable: true,
    currentVersion: '1.0.0', latestVersion: '1.2.0', fromCache: false, transport: 'direct',
    checkedAt: new Date().toISOString(), error: null,
    update: { version: '1.2.0', releasedAt: '2026-09-01T00:00:00Z', minimumVersion: '1.0.0', notes: '修复了若干问题。\n新增了更新功能。', notesUrl: '', sizeBytes: 52638515, sha256: 'a'.repeat(64) }
  }
};
const CHECK_UPTODATE = {
  json: {
    ok: true, status: 'up-to-date', updateAvailable: false,
    currentVersion: '1.0.0', latestVersion: '1.0.0', fromCache: true, transport: 'direct',
    checkedAt: new Date().toISOString(), error: null, update: null
  }
};
const CHECK_NOINFO = {
  json: {
    ok: true, status: 'no-information', updateAvailable: false,
    currentVersion: '1.0.0', latestVersion: '', fromCache: false, transport: '',
    checkedAt: '', error: { kind: 'dns', message: 'getaddrinfo ENOTFOUND github.com' }, update: null
  }
};
const STATUS_IDLE = { json: { ok: true, state: 'idle', active: false, version: '', transport: '', bytes: 0, totalBytes: 0, startedAt: '', updatedAt: '', finishedAt: '', error: null } };

/* ── 以下为异步部分：DOM shim + 注入 fetch 驱动真实模块 ──
   （保留原本的缩进层级，整体放进一个 async 函数里，方便顺序驱动与收尾统计） */
(async function behavior() {

/* ── 结构 / idle ── */
section('卡片结构（idle）');
const boxIdle = makeBox({ storage: { ibUpdateAutoCheckV1: '0' }, version: '1.0.0' });
{
  const b = boxIdle;
  b.net.status = STATUS_IDLE;
  await flush();
  const ids = ['ib-update-card', 'ib-update-current', 'ib-update-channel', 'ib-update-auto', 'ib-update-auto-text',
    'ib-update-state', 'ib-update-status', 'ib-update-sub-status', 'ib-update-progress', 'ib-update-bar', 'ib-update-bar-fill',
    'ib-update-bytes', 'ib-update-notes-box', 'ib-update-notes', 'ib-update-check', 'ib-update-later', 'ib-update-install', 'ib-update-retry'];
  check('卡片挂在诊断页宿主里（只挂一次）', !!b.id('ib-update-card') && b.id('ib-update-card').parentNode === b.host, b.host.children.length);
  check('全部结构 id 都在', ids.every(i => !!b.id(i)), ids.filter(i => !b.id(i)));
  check('当前版本来自唯一版本链', b.text('ib-update-current') === '1.0.0', b.text('ib-update-current'));
  check('更新通道显示 Stable', b.text('ib-update-channel') === 'Stable', b.text('ib-update-channel'));
  check('自动检查更新开关反映状态（关）', b.id('ib-update-auto').checked === false && b.text('ib-update-auto-text') === '关');
  check('idle 文案与按钮', b.state() === 'idle' && /还没有检查过更新/.test(b.text('ib-update-status')), b.text('ib-update-status'));
  check('idle 只显示「检查更新」', visible(b.id('ib-update-check')) && !visible(b.id('ib-update-install')) && !visible(b.id('ib-update-later')) && !visible(b.id('ib-update-retry')));
  check('idle 不显示进度与说明', !visible(b.id('ib-update-progress')) && !visible(b.id('ib-update-notes-box')));
  check('样式表由模块注入（HTML 不动）', !!b.doc.getElementById('ib-update-style') && b.doc.getElementById('ib-update-style').href === 'assets/css/update-card.css');
  check('卡片注册到诊断页（扩展卡位）', b.cards.length === 1);
  b.dispose();
}
{
  /* 诊断页模块缺失/尚未就绪时的兜底：卡片自己挂上去，而不是消失 */
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' }, noDiagnostics: true });
  b.net.status = STATUS_IDLE;
  await flush();
  check('诊断页 api 缺失时卡片仍挂到诊断页', !!b.id('ib-update-card') && b.id('ib-update-card').parentNode === b.host);
  check('兜底路径不产生虚假注册', b.cards.length === 0);
  b.dispose();
}

/* ── 自动检查 / 手动检查 ── */
section('检查：自动走缓存语义，手动才 force');
{
  const b = makeBox({});
  b.net.status = STATUS_IDLE;
  b.net.check = Object.assign({}, CHECK_UPTODATE);
  await flush();
  const checks = b.net.calls.filter(c => c.url.indexOf('/__update-check') === 0);
  check('打开页面即自动检查（默认开）', checks.length === 1, checks);
  check('自动检查不带 force（缓存与 force 语义属于 U2）', checks[0] && checks[0].url === '/__update-check', checks[0] && checks[0].url);
  check('自动检查用的是 GET', checks[0] && checks[0].method === 'GET');
  check('up-to-date 文案', b.state() === 'up-to-date' && b.text('ib-update-status') === '已是最新版本', b.text('ib-update-status'));
  b.dispose();
}
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  b.net.check = { defer: true };
  await flush();
  check('关闭自动检查后打开页面不发检查请求', b.net.calls.filter(c => c.url.indexOf('/__update-check') === 0).length === 0);
  b.id('ib-update-check').click();
  await flush();
  check('手动检查进入 checking 且按钮禁用', b.state() === 'checking' && b.text('ib-update-status') === '正在检查更新…' && b.id('ib-update-check').disabled === true, b.text('ib-update-status'));
  const manual = b.net.calls.filter(c => c.url.indexOf('/__update-check') === 0);
  check('手动检查带 force=1', manual.length === 1 && manual[0].url === '/__update-check?force=1', manual);
  Object.assign(b.net.check, CHECK_AVAILABLE);
  b.net.check.settle();
  await flush();
  check('检查结果回来后进入 available', b.state() === 'available', b.state());
  b.dispose();
}

/* ── available + notes（含 XSS） ── */
section('available：发现新版本 / notes 纯文本');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  b.net.check = JSON.parse(JSON.stringify(CHECK_AVAILABLE));
  b.api.check();
  await flush();
  check('发现新版本文案带版本号', b.state() === 'available' && b.text('ib-update-status') === '发现新版本 1.2.0', b.text('ib-update-status'));
  check('notes 原样展示（保留换行）', b.text('ib-update-notes') === CHECK_AVAILABLE.json.update.notes, b.text('ib-update-notes'));
  check('展示安装包大小（真实字节换算）', /安装包约 50\.2 MB/.test(b.text('ib-update-sub-status')), b.text('ib-update-sub-status'));
  check('available 显示 [稍后] [下载并安装]', visible(b.id('ib-update-later')) && visible(b.id('ib-update-install')));
  check('available 不显示进度', !visible(b.id('ib-update-progress')));
  b.rerenderPage();
  check('诊断页重渲染后卡片回来且状态不丢', b.state() === 'available' && b.text('ib-update-status') === '发现新版本 1.2.0', b.state());
  check('重渲染后仍然只有一张卡片', b.host.children.filter(c => c.id === 'ib-update-card').length === 1, b.host.children.length);
  b.dispose();
}
{
  const hostile = '<img src=x onerror="window.__ibXss=1"><script>window.__ibXss=2<\/script>';
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  b.net.check = JSON.parse(JSON.stringify(CHECK_AVAILABLE));
  b.net.check.json.update.notes = hostile;
  b.api.check();
  await flush();
  const notes = b.id('ib-update-notes');
  check('notes 用 textContent 写入（原文可见）', notes.textContent === hostile, notes.textContent);
  check('notes 没有生成任何子节点（注入失败）', notes.children.length === 0, notes.children.length);
  check('模块从未调用 innerHTML', innerHTMLUses === 0, innerHTMLUses);
  check('页面没有因此执行注入代码', b.sandbox.__ibXss === undefined);
  b.dispose();
}

/* ── 稍后 ── */
section('稍后：本次会话暂缓，手动检查重新提供');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  b.net.check = JSON.parse(JSON.stringify(CHECK_AVAILABLE));
  b.api.check();
  await flush();
  b.id('ib-update-later').click();
  await flush();
  check('「稍后」回到 idle 并有提示', b.state() === 'idle' && /1\.2\.0/.test(b.text('ib-update-status')), b.text('ib-update-status'));
  b.T.applyCheck({ ok: true, json: JSON.parse(JSON.stringify(CHECK_AVAILABLE.json)) });
  check('暂缓期间自动检查不再弹同样的新版本', b.state() === 'idle', b.state());
  b.net.check = { json: JSON.parse(JSON.stringify(CHECK_AVAILABLE.json)) };
  b.api.check();
  await flush();
  check('用户再次手动检查 → 重新提供更新', b.state() === 'available', b.state());
  b.dispose();
}

/* ── 下载并安装：POST 体 ── */
section('下载并安装：只提交 { version }');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  b.net.check = JSON.parse(JSON.stringify(CHECK_AVAILABLE));
  b.api.check();
  await flush();
  b.net.start = { defer: true };
  b.net.status = STATUS_IDLE;
  b.id('ib-update-install').click();
  await flush();
  const posts = b.net.calls.filter(c => c.method === 'POST');
  check('只有一个 POST 请求', posts.length === 1, posts.length);
  check('POST 目标是既有端点', posts[0].url === '/__update/start', posts[0].url);
  check('POST 体只有 version 一个字段', JSON.stringify(Object.keys(JSON.parse(posts[0].body))) === '["version"]', posts[0].body);
  check('POST 体的版本来自后端检查结果', JSON.parse(posts[0].body).version === '1.2.0');
  ['url', 'hash', 'path', 'asset', 'command'].forEach(word => {
    check('POST 体不含 ' + word, posts[0].body.toLowerCase().indexOf(word) === -1, posts[0].body);
  });
  check('点击后进入「正在准备下载」（还没有真实字节就不显示数字）', b.state() === 'downloading' && b.text('ib-update-status') === '正在准备下载更新…', b.text('ib-update-status'));
  check('准备阶段不显示进度条（禁止假进度）', !visible(b.id('ib-update-progress')));
  Object.assign(b.net.start, { json: { ok: true, accepted: true, version: '1.2.0', state: 'starting' } });
  b.net.start.settle();
  await flush();
  check('服务端接受后写下一次性标记', !!b.lsData.ibUpdatePendingV1 && JSON.parse(b.lsData.ibUpdatePendingV1).version === '1.2.0', b.lsData);
  check('接受后开始轮询安装状态', b.T.state().polling === true);
  b.dispose();
}
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  b.net.check = JSON.parse(JSON.stringify(CHECK_AVAILABLE));
  b.api.check();
  await flush();
  b.net.start = { ok: false, status: 503, json: { ok: false, error: 'update-module-unavailable' } };
  b.id('ib-update-install').click();
  await flush();
  check('被拒绝时不写标记（安装器没起来就不算开始）', !b.lsData.ibUpdatePendingV1, b.lsData);
  check('被拒绝时显示可读失败文案 + 重试', b.state() === 'failed' && visible(b.id('ib-update-retry')) && b.text('ib-update-status') === '暂时无法完成更新，请稍后再试。', b.text('ib-update-status'));
  b.dispose();
}

/* ── 真实进度 ── */
section('downloading / verifying：真实字节');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  await flush();
  b.T.applyStatus({ ok: true, state: 'downloading', active: true, version: '1.2.0', bytes: 13631488, totalBytes: 52638515, updatedAt: new Date().toISOString(), error: null });
  check('downloading 文案', b.state() === 'downloading' && b.text('ib-update-status') === '正在下载更新…', b.text('ib-update-status'));
  check('字节换算成人类可读 MB（真实比例）', b.text('ib-update-bytes') === '13.0 MB / 50.2 MB · 26%', b.text('ib-update-bytes'));
  check('进度条宽度就是真实比例', b.id('ib-update-bar-fill').style.width === '26%', b.id('ib-update-bar-fill').style.width);
  check('进度条带无障碍数值', b.id('ib-update-bar').getAttribute('aria-valuenow') === '26');
  check('下载中不显示安装与稍后按钮', !visible(b.id('ib-update-install')) && !visible(b.id('ib-update-later')) && !visible(b.id('ib-update-check')));
  b.T.applyStatus({ ok: true, state: 'downloading', active: true, version: '1.2.0', bytes: 52638515, totalBytes: 52638515, updatedAt: new Date().toISOString(), error: null });
  check('字节到齐即「正在验证更新文件…」', b.state() === 'verifying' && b.text('ib-update-status') === '正在验证更新文件…', b.text('ib-update-status'));
  check('校验阶段仍然是真实比例（100%）', b.text('ib-update-bytes') === '50.2 MB / 50.2 MB · 100%', b.text('ib-update-bytes'));
  b.dispose();
}
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  await flush();
  b.T.applyStatus({ ok: true, state: 'downloading', active: true, bytes: 13631488, totalBytes: 0, updatedAt: new Date().toISOString(), error: null });
  check('没有总字节数时不显示百分比（只报已下载）', b.text('ib-update-bytes') === '13.0 MB', b.text('ib-update-bytes'));
  check('没有总字节数时进度条为 0 宽（不编造比例）', b.id('ib-update-bar-fill').style.width === '0%');
  b.dispose();
}

/* ── installing 与「断开 ≠ 失败」 ── */
section('installing：固定说明、无百分比、断开不误报');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  b.net.status = STATUS_IDLE;
  await flush();
  b.T.applyStatus({ ok: true, state: 'downloading', active: true, bytes: 52638515, totalBytes: 52638515, updatedAt: new Date().toISOString(), error: null });
  b.T.applyStatus({ ok: true, state: 'launching', active: true, version: '1.2.0', bytes: 52638515, totalBytes: 52638515, updatedAt: new Date().toISOString(), error: null });
  check('launching → installing 固定说明', b.state() === 'installing' && /正在安装更新。InternalBeyond 会暂时关闭，并在完成后自动重新打开。/.test(b.text('ib-update-status')), b.text('ib-update-status'));
  check('installing 后不再显示百分比', !visible(b.id('ib-update-progress')) && b.text('ib-update-bytes') === '', b.text('ib-update-bytes'));
  check('installing 不显示任何动作按钮', !visible(b.id('ib-update-install')) && !visible(b.id('ib-update-later')) && !visible(b.id('ib-update-check')) && !visible(b.id('ib-update-retry')));
  check('installing 保留手动打开的兜底提示', /如果没有自动重新打开/.test(b.text('ib-update-sub-status')), b.text('ib-update-sub-status'));
  /* 服务被安装器停掉：这是预期行为 */
  b.net.status = { down: true };
  await b.T.pollOnce();
  await flush();
  check('服务消失后仍然显示安装说明（不报失败）', b.state() === 'installing' && b.text('ib-update-status') === '正在安装更新。InternalBeyond 会暂时关闭，并在完成后自动重新打开。', b.text('ib-update-status'));
  check('服务消失后没有出现重试按钮', !visible(b.id('ib-update-retry')));
  await b.T.pollOnce();
  await flush();
  check('连续读不到也不改判（锁住 installing）', b.state() === 'installing' && b.T.state().installing === true);
  /* 边界：后端明确写下 failed —— 这不是「读不到」，是事实 */
  b.net.status = { json: { ok: true, state: 'failed', active: false, version: '1.2.0', bytes: 0, totalBytes: 0, updatedAt: new Date(Date.now() + 1000).toISOString(), error: { kind: 'spawn-failed', message: 'x' } } };
  b.T.state().attempt = true;
  await b.T.pollOnce();
  await flush();
  check('后端明确 failed（安装器没起来）时才如实汇报', b.state() === 'failed' && visible(b.id('ib-update-retry')), b.state());
  b.dispose();
}

/* ── 失败分类 ── */
section('failed：稳定分类的用户文案');
{
  const cases = [
    ['sha256-mismatch', '更新文件没有通过安全校验，已取消这次更新。请稍后重试。'],
    ['dns', '网络连接不可用，暂时无法完成更新。请检查网络后重试。'],
    ['already-in-progress', '已有一个更新正在进行，请稍候。'],
    ['version-mismatch', '更新信息已经变化，请重新检查更新。'],
    ['start-failed', '暂时无法完成更新，请稍后再试。'],
    ['完全没见过的 kind', '更新没有完成，请稍后再试。']
  ];
  for (const [kind, want] of cases) {
    const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
    b.net.status = STATUS_IDLE;
    await flush();
    b.T.state().attempt = true;
    b.T.state().attemptAt = Date.now();
    b.T.state().latest = '1.2.0';
    b.T.applyStatus({ ok: true, state: 'failed', active: false, version: '1.2.0', bytes: 0, totalBytes: 0, updatedAt: new Date(Date.now() + 1000).toISOString(), error: { kind: kind, message: 'raw internal detail' } });
    check('失败分类 ' + kind, b.state() === 'failed' && b.text('ib-update-status') === want, b.text('ib-update-status'));
    check('失败文案不含原始内部细节 ' + kind, b.text('ib-update-card').indexOf('raw internal detail') === -1);
    b.dispose();
  }
  {
    const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
    b.net.status = STATUS_IDLE;
    b.net.check = JSON.parse(JSON.stringify(CHECK_NOINFO));
    b.api.check();
    await flush();
    check('查不到更新信息 → 温和文案 + 重试', b.state() === 'failed' && b.text('ib-update-status') === '网络连接不可用，暂时无法检查更新。' && visible(b.id('ib-update-retry')), b.text('ib-update-status'));
    check('检查失败不会显示成「更新失败」', b.text('ib-update-card').indexOf('更新失败') === -1);
    b.dispose();
  }
}

/* ── 成功标记：只消费一次 ── */
section('成功提示：只有版本真的变了才算，且只显示一次');
{
  const marker = JSON.stringify({ schema: 'internalbeyond.update-pending', version: '1.2.0', at: Date.now() - 5 * 60 * 1000 });
  const b = makeBox({ storage: { ibUpdatePendingV1: marker }, version: '1.2.0' });
  b.net.status = { json: { ok: true, state: 'launched', active: false, version: '1.2.0', bytes: 1, totalBytes: 1, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null } };
  /* 即使此刻联不上网，本地版本也足以证明「装上了」 */
  b.net.check = { down: true };
  await flush(10);
  check('新实例启动后显示一次「已更新到 InternalBeyond 1.2.0」', b.state() === 'updated' && b.text('ib-update-status') === '已更新到 InternalBeyond 1.2.0', b.state() + ' / ' + b.text('ib-update-status'));
  check('成功标记被消费（不留下一次）', !b.lsData.ibUpdatePendingV1, b.lsData);
  check('判定只做一次', b.T.state().judged === true && b.T.state().verdict === 'updated');
  /* 第二次启动：标记已经没了，不能重复显示 */
  b.T.reset();
  b.T.state().marker = b.T.readMarker();
  b.T.maybeJudge(b.net.status.json);
  b.T.render();
  check('第二次启动不再显示成功提示', b.state() !== 'updated' && b.T.readMarker() === null, b.state());
  b.dispose();
}
{
  /* 安装器起来了但版本没变（旧版本被重新打开） */
  const marker = JSON.stringify({ schema: 'internalbeyond.update-pending', version: '1.2.0', at: Date.now() - 5 * 60 * 1000 });
  const b = makeBox({ storage: { ibUpdatePendingV1: marker }, version: '1.0.0' });
  b.net.status = { json: { ok: true, state: 'launched', active: false, version: '1.2.0', bytes: 1, totalBytes: 1, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null } };
  b.net.check = { down: true };
  await flush(10);
  check('旧版本重开 → 更新未完成 + 重试', b.state() === 'incomplete' && b.text('ib-update-status') === '更新未完成，当前仍为 1.0.0' && visible(b.id('ib-update-retry')), b.state() + ' / ' + b.text('ib-update-status'));
  check('未完成也消费标记（只提醒一次）', !b.lsData.ibUpdatePendingV1);
  b.dispose();
}
{
  const marker = JSON.stringify({ schema: 'internalbeyond.update-pending', version: '1.2.0', at: Date.now() - 5 * 60 * 1000 });
  const b = makeBox({ storage: { ibUpdatePendingV1: marker }, version: '1.0.0' });
  b.net.status = { json: { ok: true, state: 'failed', active: false, version: '1.2.0', bytes: 0, totalBytes: 0, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: { kind: 'size-mismatch', message: 'x' } } };
  b.net.check = { down: true };
  await flush(10);
  check('后端明确失败 → 更新未完成', b.state() === 'incomplete' && /更新未完成，当前仍为 1\.0\.0/.test(b.text('ib-update-status')), b.text('ib-update-status'));
  b.dispose();
}
{
  /* 版本读不到：既不能报成功也不能报失败 */
  const marker = JSON.stringify({ schema: 'internalbeyond.update-pending', version: '1.2.0', at: Date.now() - 10 * 60 * 1000 });
  const b = makeBox({ storage: { ibUpdatePendingV1: marker, ibUpdateAutoCheckV1: '0' }, version: '' });
  b.net.status = STATUS_IDLE;
  await flush(10);
  const txt = b.text('ib-update-card');
  check('版本读不到时不下结论（标记静默消费）', !b.lsData.ibUpdatePendingV1 && txt.indexOf('已更新到') === -1 && txt.indexOf('更新未完成') === -1, txt);
  check('版本读不到时状态回到 idle', b.state() === 'idle', b.state());
  b.dispose();
}

section('一次性判定的纯逻辑边界');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  const T = b.T;
  const now = Date.now();
  const fresh = { schema: 'internalbeyond.update-pending', version: '1.2.0', at: now - 5000 };
  const old = { schema: 'internalbeyond.update-pending', version: '1.2.0', at: now - 10 * 60 * 1000 };
  const st = (o) => Object.assign({ ok: true, state: 'idle', active: false, version: '', bytes: 0, totalBytes: 0, updatedAt: '', finishedAt: '', error: null }, o || {});
  check('版本一致 → updated', T.judgeStartup(fresh, '1.2.0', st(), now).kind === 'updated');
  check('正在下载 → 不判定（等）', T.judgeStartup(fresh, '1.0.0', st({ state: 'downloading', active: true, version: '1.2.0', bytes: 10, totalBytes: 100, updatedAt: new Date(now).toISOString() }), now) === null);
  check('安装中 → 不判定（等）', T.judgeStartup(fresh, '1.0.0', st({ state: 'launching', version: '1.2.0', updatedAt: new Date(now).toISOString() }), now) === null);
  check('刚点完、helper 还没写状态 → 等待，不误报', T.judgeStartup(fresh, '1.0.0', st(), now) === null);
  check('超过宽限期仍无状态 → incomplete', T.judgeStartup(old, '1.0.0', st(), now).kind === 'incomplete');
  check('上次失败的同版本记录不算这次的失败', T.judgeStartup(fresh, '1.0.0', st({ state: 'failed', version: '1.2.0', updatedAt: new Date(now - 10 * 60 * 1000).toISOString() }), now) === null);
  check('别的版本的 launched 不算这次', T.judgeStartup(fresh, '1.0.0', st({ state: 'launched', version: '1.1.0', updatedAt: new Date(now - 10 * 60 * 1000).toISOString() }), now) === null);
  check('版本读不到 → unknown（不报成功也不报失败）', T.judgeStartup(old, '', st(), now).kind === 'unknown');
  check('没有标记 → 不判定', T.judgeStartup(null, '1.0.0', st(), now) === null);
  b.dispose();
}

section('后端状态 → 阶段（纯逻辑）');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  const T = b.T;
  const now = Date.now();
  const st = (o) => Object.assign({ ok: true, state: 'idle', active: false, version: '1.2.0', bytes: 0, totalBytes: 0, updatedAt: new Date(now).toISOString(), error: null }, o || {});
  check('downloading + active → downloading', T.statusPhase(st({ state: 'downloading', active: true, bytes: 1, totalBytes: 10 }), now) === 'downloading');
  check('downloading 但 helper 已经死了 → idle（不是「正在下载」）', T.statusPhase(st({ state: 'downloading', active: false, bytes: 1, totalBytes: 10 }), now) === 'idle');
  check('downloading + 字节到齐 → verifying', T.statusPhase(st({ state: 'downloading', active: true, bytes: 10, totalBytes: 10 }), now) === 'verifying');
  check('verifying → verifying', T.statusPhase(st({ state: 'verifying', active: true }), now) === 'verifying');
  check('launching / launched → installing', T.statusPhase(st({ state: 'launching' }), now) === 'installing' && T.statusPhase(st({ state: 'launched' }), now) === 'installing');
  check('failed → failed', T.statusPhase(st({ state: 'failed' }), now) === 'failed');
  check('idle → idle', T.statusPhase(st(), now) === 'idle');
  check('读不到 → null（保持现状，不改判）', T.statusPhase(null, now) === null);
  check('未知状态 → null', T.statusPhase(st({ state: 'wat' }), now) === null);
  b.dispose();
}

section('失败分类与字节格式化（纯逻辑）');
{
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  const T = b.T;
  const kinds = Object.keys(T.KIND_CLASS);
  check('分类表覆盖 U2/U3 的全部 kind', kinds.length >= 30, kinds.length);
  check('每个 kind 都能得到一个已知类别', kinds.every(k => Object.keys(T.CLASS).map(x => T.CLASS[x]).indexOf(T.classify(k)) >= 0));
  check('未知 kind → unknown', T.classify('nonsense') === 'unknown');
  check('只有 HTTP 状态码 → server', T.classify('', 500) === 'server');
  check('签名不符 → corrupt', T.classify('sha256-mismatch') === 'corrupt');
  check('网络类 → network', T.classify('reset') === 'network' && T.classify('connect-timeout') === 'network');
  check('已经在装 → busy', T.classify('already-in-progress') === 'busy');
  check('两类文案表都齐全', Object.keys(T.CLASS).map(k => T.CLASS[k]).every(c => !!T.USER_TEXT.install[c] && !!T.USER_TEXT.check[c]));
  check('formatBytes: 0 → 0 B', T.formatBytes(0) === '0 B');
  check('formatBytes: 1024 → 1 KB', T.formatBytes(1024) === '1 KB');
  check('formatBytes: 512 KiB → 512 KB', T.formatBytes(512 * 1024) === '512 KB');
  check('formatBytes: 13 MiB → 13.0 MB', T.formatBytes(13 * 1024 * 1024) === '13.0 MB');
  check('formatBytes: 100 MiB → 100 MB', T.formatBytes(100 * 1024 * 1024) === '100 MB');
  check('formatBytes: 1.5 GiB → 1.50 GB', T.formatBytes(1.5 * 1024 * 1024 * 1024) === '1.50 GB');
  check('formatBytes: 负数/垃圾 → 空', T.formatBytes(-1) === '' && T.formatBytes('x') === '');
  check('percentOf 钳在 0–100', T.percentOf(0, 0) === 0 && T.percentOf(5, 10) === 50 && T.percentOf(12, 10) === 100);
  b.dispose();
}

/* ── 文案禁止底层术语 ── */
section('普通用户文案：禁止底层术语');
const FORBIDDEN = [
  '127.0.0.1', 'localhost', 'http://', 'https://', 'github', 'node', 'pid', 'shell',
  'manifest', 'sha256', 'sha-256', 'econn', 'etimedout', 'enotfound', '端口', '终端',
  '命令行', '进程', '哈希', '校验和', 'exe', '.json'
];
{
  const rendered = [];
  const texts = [];
  const scenarios = [
    ['idle', null, null],
    ['checking', null, null],
    ['up-to-date', CHECK_UPTODATE, null],
    ['available', CHECK_AVAILABLE, null],
    ['no-information', CHECK_NOINFO, null]
  ];
  for (const [label, checkRoute] of scenarios) {
    const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
    b.net.status = STATUS_IDLE;
    b.net.check = { defer: true };
    await flush();
    if (label === 'checking') b.api.check();
    else if (checkRoute) { b.net.check = JSON.parse(JSON.stringify(checkRoute)); b.api.check(); }
    await flush(6);
    rendered.push([label, allText(b.id('ib-update-card'))]);
    b.dispose();
  }
  {
    const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
    b.net.status = STATUS_IDLE;
    await flush();
    b.T.applyStatus({ ok: true, state: 'downloading', active: true, bytes: 13631488, totalBytes: 52638515, updatedAt: new Date().toISOString(), error: null });
    rendered.push(['downloading', allText(b.id('ib-update-card'))]);
    b.T.applyStatus({ ok: true, state: 'launching', bytes: 52638515, totalBytes: 52638515, updatedAt: new Date().toISOString(), error: null });
    rendered.push(['installing', allText(b.id('ib-update-card'))]);
    b.T.state().attempt = true;
    b.T.applyStatus({ ok: true, state: 'failed', version: '1.2.0', updatedAt: new Date(Date.now() + 1000).toISOString(), error: { kind: 'dns', message: 'getaddrinfo ENOTFOUND' } });
    rendered.push(['failed', allText(b.id('ib-update-card'))]);
    b.dispose();
  }
  for (const [label, txt] of rendered) {
    const low = txt.toLowerCase();
    const hits = FORBIDDEN.filter(w => low.indexOf(w) >= 0);
    check('渲染文本（' + label + '）无底层术语', hits.length === 0, hits);
    texts.push(txt);
  }
  /* 所有分类文案也要单独过一遍（含没被渲染到的类别） */
  const b = makeBox({ storage: { ibUpdateAutoCheckV1: '0' } });
  for (const where of ['install', 'check']) {
    for (const cls of Object.keys(b.T.CLASS).map(k => b.T.CLASS[k])) {
      const txt = b.T.USER_TEXT[where][cls].toLowerCase();
      const hits = FORBIDDEN.filter(w => txt.indexOf(w) >= 0);
      check('文案表 ' + where + '/' + cls + ' 无底层术语', hits.length === 0, hits);
    }
  }
  b.dispose();
  check('至少渲染过全部主要状态', rendered.length >= 8, rendered.map(r => r[0]));
}

/* ═══ E. 相邻回归 ═══════════════════════════════════════════ */
section('相邻回归（子进程）');
for (const [label, file] of [['test_diagnostics.js', 'test_diagnostics.js'], ['test_frontend_structure.js', 'test_frontend_structure.js']]) {
  let ok = true, out = '';
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ok = false;
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  check(label + ' 仍然全绿', ok, ok ? '' : out.slice(-800));
}

console.log('\n结果: ' + passed + ' 通过, ' + failures + ' 失败');
process.exit(failures ? 1 : 0);

})();
