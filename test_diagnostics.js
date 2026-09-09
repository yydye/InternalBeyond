'use strict';
/* Internal Beyond — P5 系统诊断（System Diagnostics / Self-Recovery）契约测试
   运行：node test_diagnostics.js      （零网络、零浏览器）

   覆盖两类断言：
     A. 静态契约 —— 文件 / 编码 / HTML 最小挂载 / 不建第二套 boot state、
        错误目录、组件词表、provider metadata / 一键修复只调用既有恢复动作
     B. 纯逻辑契约 —— 能力状态矩阵（17 个必测场景中的纯逻辑部分）、boot-state
        与实时 probe 合并、探测隔离与超时、修复门控、报告脱敏

   说明：DOM 用最小 shim 提供（仅为让模块能在 Node 里加载并渲染），
   window.IBERR 加载的是真实 assets/js/error-catalog.js，因此 401/429 文案
   断言就是 P3 的最终用户文案。 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = __dirname;
const JS_PATH = path.join(ROOT, 'assets', 'js', 'diagnostics.js');
const CSS_PATH = path.join(ROOT, 'assets', 'css', 'diagnostics.css');
const HTML_PATH = path.join(ROOT, 'InternalBeyond.html');
const ERR_PATH = path.join(ROOT, 'assets', 'js', 'error-catalog.js');

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

const jsBuf = fs.readFileSync(JS_PATH);
const jsSrc = jsBuf.toString('utf8').replace(/^\uFEFF/, '');
/* 去掉注释后的代码：注释里出现「Bridge / 23115 / Node.js」是解释性文字，
   不构成用户可见文案，也不构成端口字面量。 */
const codeOnly = jsSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const cssBuf = fs.readFileSync(CSS_PATH);
const cssSrc = cssBuf.toString('utf8').replace(/^\uFEFF/, '');
const html = fs.readFileSync(HTML_PATH, 'utf8');

/* ═══ A. 静态契约 ═══════════════════════════════════════════ */
section('文件与编码（与 test_frontend_structure 同一规则）');
check('diagnostics.js 存在', fs.existsSync(JS_PATH));
check('diagnostics.css 存在', fs.existsSync(CSS_PATH));
check('js 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(jsBuf); return true; } catch (e) { return false; } })());
check('css 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(cssBuf); return true; } catch (e) { return false; } })());
check('js 带 UTF-8 BOM', jsBuf[0] === 0xef && jsBuf[1] === 0xbb && jsBuf[2] === 0xbf);
check('css 带 UTF-8 BOM', cssBuf[0] === 0xef && cssBuf[1] === 0xbb && cssBuf[2] === 0xbf);
check('无乱码特征', !/\uFFFD|锟斤拷|Ã.|Â.|â(?:€|™|œ|“|”)/.test(jsSrc + cssSrc));
check('js 语法可解析', (() => { try { new vm.Script(jsSrc, { filename: 'diagnostics.js' }); return true; } catch (e) { return false; } })());

section('HTML 最小挂载（不动样式表 / 内联样式预算）');
const scriptTags = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
const styleTags = [...html.matchAll(/<link[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
check('HTML 只挂载一次 diagnostics.js', scriptTags.filter(s => s === 'assets/js/diagnostics.js').length === 1);
check('HTML 没有新增样式表', styleTags.length === 20, styleTags.length);
check('HTML 没有 diagnostics.css 的 <link>', !styleTags.includes('assets/css/diagnostics.css'));
check('HTML 有独立导航入口', /<a[^>]*data-page=["']diagnostics["'][^>]*>/.test(html));
check('导航入口带 href（与其它导航一致）', /<a[^>]*href=["']#diagnostics["'][^>]*data-page=["']diagnostics["']/.test(html));
check('HTML 有 page-diagnostics 容器', (html.match(/id=["']page-diagnostics["']/g) || []).length === 1);
check('HTML 无 <style> 块', !/<style\b/i.test(html));
check('HTML 无内联 <script>', [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim()).length === 0);
check('HTML 静态内联样式预算未变（<=200）', (html.match(/\bstyle\s*=/gi) || []).length <= 200, (html.match(/\bstyle\s*=/gi) || []).length);
check('新模块不新增 style= 属性', (jsSrc.match(/\bstyle\s*=/gi) || []).length === 0);
check('模块运行时注入自己的样式表', /STYLE_HREF\s*=\s*'assets\/css\/diagnostics\.css'/.test(jsSrc) && /rel\s*=\s*'stylesheet'/.test(jsSrc));

section('不建立第二套 boot state / 错误目录 / 组件词表 / provider metadata');
check('只读 P2 /__boot-state', /BOOT_URL\s*=\s*'\/__boot-state'/.test(jsSrc));
check('不自己写 boot-state 文件 / 不建第二套 schema', jsSrc.indexOf('internalbeyond.boot-state') === -1 && !/buildBootState|writeBootState/.test(jsSrc));
check('用户文案走 P3 IBERR', /window\.IBERR\.present/.test(jsSrc) && /window\.IBERR\.redact/.test(jsSrc) && /window\.IBERR\.redactUrl/.test(jsSrc));
check('不新建错误分类表（无 category 字面量表）', !/var\s+CATEGORIES\s*=\s*\[/.test(jsSrc) && !/COPY\s*=\s*\{/.test(jsSrc));
check('组件词表 = P2 的 static/bridge/active/restart/vision', /\[.static.,\s*.bridge.,\s*.active.,\s*.restart.,\s*.vision.\]/.test(jsSrc));
check('不复制 provider endpoint', jsSrc.indexOf('api.openai.com') === -1 && jsSrc.indexOf('api.anthropic.com') === -1 && jsSrc.indexOf('generativelanguage.googleapis.com') === -1);
check('不复制 provider 默认模型', jsSrc.indexOf('gpt-4o-mini') === -1 && jsSrc.indexOf('claude-sonnet-4-6') === -1);
check('端口唯一来源是 boot-state（代码里没有端口字面量）', !/23115|23114|23116|23120|8765/.test(codeOnly), (codeOnly.match(/23115|23114|23116|23120|8765/g) || []).slice(0, 3));

section('复用既有探测 / 恢复 / 调用链（不建第二套）');
check('复用 ibBridgeBase + ibBridgeFetch', /window\.ibBridgeBase/.test(jsSrc) && /window\.ibBridgeFetch/.test(jsSrc));
check('复用 _activeCompanionRequest（Active 客户端）', /window\._activeCompanionRequest/.test(jsSrc));
check('复用 backendRestart.getStatus / trigger', /backendRestart\.getStatus/.test(jsSrc) && /ibRestartBackend/.test(jsSrc));
check('AI 测试走既有 callApiChat', /window\.callApiChat\s*\(/.test(jsSrc));
check('不自建 fetch 之外的请求层', (jsSrc.match(/\bfetch\s*\(/g) || []).length === 1);
check('复用 _ibApiReady 判定配置可用性', /window\._ibApiReady/.test(jsSrc));
check('修复不碰用户配置 / 数据库 / 缓存', !/dbPut|dbDelete|clearCache|localStorage|sessionStorage|apiKey\s*=/.test(jsSrc));
check('修复不换端口 / 不无限重试', !/while\s*\(\s*true/.test(jsSrc) && !/port\s*\+\s*\d/.test(jsSrc) && !/for\s*\([^)]*;\s*;\s*\)/.test(jsSrc));

section('用户可见文案不含开发者术语（技术详情除外）');
const CAP_TEXT = ['基础运行', 'AI 聊天', '本地增强功能', '后台主动功能', '语音功能', '视觉功能'];
const STATUS_TEXT = ['正常', '需要注意', '不可用', '未安装（可选）', '检查中', '状态未知'];
check('能力层词表 = 6 项', CAP_TEXT.every(t => jsSrc.indexOf(t) !== -1));
check('状态词表 = 6 种', STATUS_TEXT.every(t => jsSrc.indexOf(t) !== -1));
/* 文案段落 = 去掉注释后的代码；技术详情由 bootLines/probeLines 单独构造，
   不在「用户文案」范围内（它们本来就该出现组件名与端口）。 */
check('文案表本身不含开发者术语', (() => {
  const dev = ['Bridge', 'Active', 'WebSocket', 'ws://', '127.0.0.1', 'Node.js', 'localhost', '端口'];
  const text = CAP_TEXT.concat(STATUS_TEXT).join(' ');
  return dev.every(w => text.indexOf(w) === -1);
})());
check('用户文案里的字符串字面量不含开发者术语', (() => {
  const copyStart = codeOnly.indexOf('function deriveCaps');
  const copyEnd = codeOnly.indexOf('function bootLines');
  const seg = codeOnly.slice(copyStart, copyEnd);
  const literals = [...seg.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)]
    .map(m => (m[1] !== undefined ? m[1] : m[2]))
    .filter(s => s && !/^[a-z0-9_./-]+$/i.test(s));
  const dev = ['Bridge', 'Active', 'WebSocket', 'ws://', '127.0.0.1', 'Node.js', 'localhost'];
  const dirty = [];
  literals.forEach(s => dev.forEach(w => { if (s.indexOf(w) !== -1) dirty.push(w + ' @ ' + s.slice(0, 40)); }));
  return dirty.length === 0;
})(), '能力推导段落含开发者术语');

section('一键修复的真实动作面');
check('只调用 backend-restart（23116 控制面）', /ibRestartBackend/.test(jsSrc) && jsSrc.indexOf('spawn') === -1);
check('修复后重新 probe', /服务重启后重新 probe/.test(jsSrc) && /runChecks\(\)/.test(jsSrc.slice(jsSrc.indexOf('function runRepair'))));
check('成功文案 = 本地功能已经恢复。', jsSrc.indexOf('本地功能已经恢复。') !== -1);
check('失败文案 = 自动修复没有成功。你仍然可以继续使用可用功能。', jsSrc.indexOf('自动修复没有成功。你仍然可以继续使用可用功能。') !== -1);
check('明确「此问题无法自动修复」', jsSrc.indexOf('此问题无法自动修复') !== -1);

section('报告：白名单 + 二次脱敏');
check('导出前经 IBERR.redact', /return redact\(L\.join\('\\n'\), 60000\)/.test(jsSrc));
check('技术详情经 IBERR.redact', /return redact\(L\.join\('\\n'\), 20000\)/.test(jsSrc));
check('不导出本地日志文件', jsSrc.indexOf('logs/') === -1 && /不导出/.test(jsSrc));
check('只输出 reason.category（不输出自由文本 message）', /reason\.category/.test(jsSrc) && !/reason\.message/.test(jsSrc));

/* ═══ B. 模块加载（最小 DOM shim） ═══════════════════════════ */
section('模块加载与渲染（最小 DOM shim）');

function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attributes: {},
    value: '',
    disabled: false,
    selected: false,
    id: '',
    type: '',
    href: '',
    download: '',
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
    set innerHTML(v) { this._html = String(v); this.children = []; },
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
const appEl = makeEl('div'); appEl.id = 'app';
const apiPageEl = makeEl('div'); apiPageEl.id = 'page-api';
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
doc.body.appendChild(appEl);
doc.body.appendChild(apiPageEl);

const navCalls = [];
const store = { apiConfigs: [] };
const sandbox = {
  console: { log() { }, warn() { }, error() { } },
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Object, Array, String, Number, Math, JSON, Date, Error, RegExp, Set, Map, AbortController, TextDecoder,
  document: doc,
  location: { origin: 'http://127.0.0.1:23120', hash: '' },
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) TestChrome/120', platform: 'Win32', language: 'zh-CN' },
  screen: { width: 1920, height: 1080 },
  navTo(page) { navCalls.push(String(page)); },
  Blob: function Blob(parts) { this.parts = parts; },
  URL: {
    createObjectURL(b) { sandbox.__lastBlob = b; return 'blob:test'; },
    revokeObjectURL() { }
  },
  IB: { expose(n, o) { this[n] = o; return o; } },
  addEventListener() { },
  removeEventListener() { }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
Object.defineProperty(sandbox, 'apiConfigs', { get() { return store.apiConfigs; }, set(v) { store.apiConfigs = v; }, configurable: true });
vm.createContext(sandbox);

/* 真实 P3 错误目录：401 / 429 文案断言就是最终用户文案 */
vm.runInContext(fs.readFileSync(ERR_PATH, 'utf8').replace(/^\uFEFF/, ''), sandbox, { filename: 'error-catalog.js' });
check('真实 IBERR 已加载（P3）', !!(sandbox.window.IBERR && sandbox.window.IBERR.present && sandbox.window.IBERR.redact));

sandbox._ibApiReady = function (cfg) { return !!(cfg && String(cfg.endpoint || '').trim() && String(cfg.model || '').trim() && String(cfg.apiKey || '').trim()); };
vm.runInContext(jsSrc, sandbox, { filename: 'diagnostics.js' });

const D = sandbox.window.IBDiagnostics;
const T = D && D.__test;
check('window.IBDiagnostics 已挂载', !!D && typeof D.refresh === 'function');
check('IB.diagnostics 命名空间已挂载', !!(sandbox.IB && sandbox.IB.diagnostics));
check('模块加载后自动创建 page-diagnostics', !!doc.getElementById('page-diagnostics'));
check('API 设置页已注入「系统诊断」入口', !!doc.getElementById('ib-diag-entry'));
check('加载后主页面渲染完成（无异常）', /系统诊断/.test(allText(doc.getElementById('page-diagnostics'))));

/* ═══ C. 能力状态矩阵（必测场景的纯逻辑部分） ═══════════════ */
section('场景矩阵');

function pOk(extra) { return Object.assign({ state: 'done', ok: true, healthy: true, responding: true, httpStatus: 200, latencyMs: 5, json: {}, endpoint: 'probe' }, extra || {}); }
function pDown() { return { state: 'done', ok: false, healthy: false, responding: false, httpStatus: 0, latencyMs: 2500, error: 'unreachable', json: null, endpoint: 'probe' }; }
function pConflict() { return { state: 'done', ok: true, healthy: false, responding: true, httpStatus: 200, latencyMs: 4, json: { ok: true, server: 'Other' }, endpoint: 'probe' }; }
function pUnavail(r) { return { state: 'done', ok: false, healthy: false, responding: false, unavailable: true, error: r || 'client-missing', httpStatus: 0, latencyMs: 0, json: null, endpoint: '' }; }
function bootOf(overall, comps, stale) {
  return {
    present: true, stale: !!stale, staleReason: stale ? 'age' : '', ageMs: 60 * 1000,
    path: 'C:/Users/x/AppData/Local/InternalBeyond/boot-state.json',
    state: {
      overall, phase: 'complete', bootId: '20260909T000000000Z-abc123',
      generatedAt: new Date(Date.now() - 60000).toISOString(),
      components: comps || {},
      launcher: {
        node: { version: 'v24.18.0', source: 'bundled', path: 'C:/ib/runtime/node/node.exe', ok: true, requiredMajor: 18 },
        platform: 'win32', arch: 'x64', root: 'C:/ib', serviceManager: { state: 'up', wasRunning: true, startedByLauncher: false }
      },
      warnings: [{ code: 'runner-unavailable' }]
    }
  };
}
const HEALTHY_COMPS = {
  static: { healthy: true, state: 'healthy', probed: true, port: 23120, identity: 'InternalBeyond Web' },
  bridge: { healthy: true, state: 'healthy', probed: true, port: 23115, version: '1.0.0' },
  active: { healthy: true, state: 'healthy', probed: true, port: 23114 },
  restart: { healthy: true, state: 'healthy', probed: true, port: 23116, affectsOverall: false },
  vision: { healthy: false, state: 'not-enabled', probed: false, port: 8765, affectsOverall: false }
};
function probesAllOk(extra) {
  return Object.assign({
    static: pOk(), bridge: pOk({ identity: 'IB Bridge' }), active: pOk(),
    restart: pOk({ json: { service: 'InternalBeyond Restart', state: 'idle' } }),
    bridgeStatus: pOk({ json: { ok: true, tts: true } }),
    vision: pOk(), visionInstall: pOk({ installed: true })
  }, extra || {});
}
function rolesReady(restartOk) { return { roles: [{ id: 'r1', label: '小明' }], currentRole: { id: 'r1', label: '小明', ready: true, reason: '' }, aiTest: null, restartOk: restartOk !== false, clientMissing: {} }; }
function st(res, id) { const r = res.rows.filter(x => x.id === id)[0] || {}; return r.status; }
function rowOf(res, id) { return res.rows.filter(x => x.id === id)[0] || {}; }

/* 1. 全部正常 */
const S1 = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk(), rolesReady());
check('1) 全部正常 → overall=ok / 标题=系统运行正常', S1.overall === 'ok' && S1.headline === '系统运行正常', S1.headline);
check('1) 六项能力全部「正常」', ['base', 'chat', 'bridge', 'active', 'voice', 'vision'].every(id => st(S1, id) === 'ok'), S1.rows.map(r => r.id + ':' + r.status));

/* 2. boot-state stale */
const S2 = T.deriveCaps(bootOf('degraded', HEALTHY_COMPS, true), probesAllOk(), rolesReady());
check('2) boot-state 过期 → 当前状态仍按实时 probe 判定（overall=ok）', S2.overall === 'ok', S2.overall);
check('2) 明确标注「启动记录已过期，以当前检查为准」', /启动记录已过期/.test(rowOf(S2, 'base').note || ''), rowOf(S2, 'base').note);

/* 3. 启动 degraded、当前已恢复 */
const degradedComps = JSON.parse(JSON.stringify(HEALTHY_COMPS));
degradedComps.bridge = { healthy: false, state: 'offline', probed: true, port: 23115, reason: { category: 'offline', message: 'Bridge is not answering /health on port 23115' } };
const S3 = T.deriveCaps(bootOf('degraded', degradedComps), probesAllOk(), rolesReady());
check('3) 启动 degraded + 当前恢复 → 本地增强功能=正常', st(S3, 'bridge') === 'ok', st(S3, 'bridge'));
check('3) 说明「启动时降级，现在已恢复」', /启动时这项功能曾经降级，现在已经恢复/.test(rowOf(S3, 'bridge').note || ''), rowOf(S3, 'bridge').note);
const T3 = (() => { T.setBoot(bootOf('degraded', degradedComps)); T.setProbes(probesAllOk()); T.setAiTest(null); return T.technicalText(); })();
check('3) 技术详情保留启动时 degraded + 组件 reason.category', /启动结果：degraded/.test(T3) && /bridge：.*reason\.category=offline/.test(T3), T3.slice(0, 260));
check('3) 技术详情不含自由文本 message（避免把日志/提示词带出去）', T3.indexOf('not answering /health') === -1, T3);

/* 4/5/6. Bridge / Active / 双 down */
const S4 = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ bridge: pDown() }), rolesReady());
check('4) Bridge 当前 down → 本地增强功能=不可用', st(S4, 'bridge') === 'down', st(S4, 'bridge'));
check('4) 总体=部分功能暂时不可用 + 仍可正常聊天', S4.overall === 'down' && /仍然可以正常聊天/.test(S4.sub), S4.sub);
check('4) 文案只讲能力层（不含 Bridge / 端口）', !/Bridge|23115|127\.0\.0\.1/.test(rowOf(S4, 'bridge').detail + rowOf(S4, 'bridge').hint), rowOf(S4, 'bridge'));
const S5 = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ active: pDown() }), rolesReady());
check('5) Active 当前 down → 后台主动功能=不可用', st(S5, 'active') === 'down', st(S5, 'active'));
check('5) 文案 = 「后台主动功能暂时不可用。」', rowOf(S5, 'active').detail === '后台主动功能暂时不可用。', rowOf(S5, 'active').detail);
const S6 = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ bridge: pDown(), active: pDown() }), rolesReady());
check('6) 双 down → 两行都不可用且总体 down', st(S6, 'bridge') === 'down' && st(S6, 'active') === 'down' && S6.overall === 'down', S6.overall);
check('6) 语音功能随本地增强功能一起不可用', st(S6, 'voice') === 'down', st(S6, 'voice'));

/* 7. Vision 未安装 */
const S7 = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ vision: pDown(), visionInstall: { state: 'done', ok: false, installed: false, httpStatus: 404, endpoint: 'venv' } }), rolesReady());
check('7) Vision 未安装 → 未安装（可选），不进入 degraded', st(S7, 'vision') === 'optional' && S7.overall === 'ok', S7.overall);
check('7) 未安装文案不含错误口吻', /没有安装/.test(rowOf(S7, 'vision').detail) && rowOf(S7, 'vision').fixable !== true, rowOf(S7, 'vision'));
const S7b = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ vision: pDown(), visionInstall: pOk({ installed: true }) }), rolesReady());
check('7) 已安装但起不来 → 暂不可用，但仍不影响总体', st(S7b, 'vision') === 'down' && S7b.overall === 'ok', [st(S7b, 'vision'), S7b.overall]);

/* 10. 不可自动修复的问题不出假修复按钮 */
const S10a = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ bridge: pConflict() }), rolesReady());
check('10) 端口被占用 → 不提供自动修复', rowOf(S10a, 'bridge').fixable !== true && /无法自动修复/.test(rowOf(S10a, 'bridge').hint), rowOf(S10a, 'bridge'));
const S10b = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ bridge: pDown(), restart: pDown() }), rolesReady(false));
check('10) 重启控制面也 down → 不提供自动修复', rowOf(S10b, 'bridge').fixable !== true && /无法自动修复/.test(rowOf(S10b, 'bridge').hint), rowOf(S10b, 'bridge'));
const S10c = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ bridge: pDown() }), rolesReady());
check('10) 可恢复场景才提供自动修复', rowOf(S10c, 'bridge').fixable === true && /可以尝试自动修复/.test(rowOf(S10c, 'bridge').hint), rowOf(S10c, 'bridge'));
const S10d = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ vision: pDown(), visionInstall: pOk({ installed: true }) }), rolesReady());
check('10) 视觉功能不提供自动修复（P5 不实现 installer）', rowOf(S10d, 'vision').fixable !== true, rowOf(S10d, 'vision'));

/* 12. 单 probe 异常 → 状态未知，不拖垮整页 */
const S12 = T.deriveCaps(bootOf('normal', HEALTHY_COMPS), probesAllOk({ active: pUnavail('probe-error') }), rolesReady());
check('12) probe 异常 → 状态未知（不是红色故障）', st(S12, 'active') === 'unknown', st(S12, 'active'));
check('12) 其它行仍然正常渲染', st(S12, 'bridge') === 'ok' && st(S12, 'chat') === 'ok', S12.rows.map(r => r.id + ':' + r.status));

/* file:// 直开（无本地页面服务）：不能报成故障 */
const Sfile = T.deriveCaps(null, probesAllOk({ static: pUnavail('file-origin') }), rolesReady());
check('12) file:// 直开 → 基础运行不报故障', st(Sfile, 'base') === 'ok' && /未参与/.test(rowOf(Sfile, 'base').detail || ''), rowOf(Sfile, 'base'));

/* 17. 页面不暴露技术概念，除非展开详情 */
T.setBoot(bootOf('degraded', degradedComps));
T.setProbes(probesAllOk({ bridge: pDown(), active: pDown() }));
T.setAiTest(null);
T.compute();
const pageText = allText(doc.getElementById('page-diagnostics'));
check('17) 主页面含能力层文案', /本地增强功能/.test(pageText) && /后台主动功能/.test(pageText) && /部分功能暂时不可用/.test(pageText));
check('17) 主页面不含 Bridge / Active / 端口 / 127.0.0.1 / Node', ['Bridge', 'Active', '23115', '23114', '127.0.0.1', 'Node', '端口', 'WebSocket'].every(w => pageText.indexOf(w) === -1), pageText.slice(0, 400));
const tech = T.technicalText();
check('17) 技术详情才出现组件名 / 端口 / bootId / Node 版本', /bridge：/.test(tech) && /port=23115/.test(tech) && /bootId：/.test(tech) && /v24\.18\.0/.test(tech), tech.slice(0, 300));

/* 所有场景产生的用户文案统一扫描（比只查一个页面更强） */
const allCopy = [];
[S1, S2, S3, S4, S5, S6, S7, S7b, S10a, S10b, S10c, S10d, S12].forEach(function (res) {
  res.rows.forEach(function (r) { allCopy.push(r.label, r.detail, r.note, r.hint); });
});
const DEV_TERMS = ['Bridge', 'Active', 'WebSocket', 'ws://', '127.0.0.1', 'Node.js', 'localhost', '端口', '23115', '23114', '23116'];
const copyLeaks = [];
DEV_TERMS.forEach(function (w) { if (allCopy.join(' | ').indexOf(w) !== -1) copyLeaks.push(w); });
check('17) 全部场景的能力层文案都不含开发者术语', copyLeaks.length === 0, copyLeaks);

/* ═══ D. 探测：超时 / 隔离 / 不重复风暴 ═════════════════════ */
section('一键检查：超时 / 隔离 / 去重');

const origFetch = sandbox.fetch;
let fetchCalls = 0;

(async () => {
  /* 超时：fetch 永不返回，只响应 abort */
  sandbox.fetch = function (url, init) {
    fetchCalls++;
    return new Promise((res, rej) => {
      const sig = init && init.signal;
      if (sig && typeof sig.addEventListener === 'function') {
        sig.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      }
    });
  };
  const t0 = Date.now();
  const rows = await D.refresh();
  const dt = Date.now() - t0;
  check('11) probe 超时后检查仍然结束（不挂死）', Array.isArray(rows) && rows.length === 6, rows && rows.length);
  check('11) 超时被识别为 timeout 而不是未捕获异常', (T.state().probes.static || {}).error === 'timeout', T.state().probes.static && T.state().probes.static.error);
  check('11) 超时用时在 2.5s~6s 之间（有硬超时）', dt >= 2400 && dt < 6000, dt + 'ms');
  check('11) 每个 probe 只发一次请求（无请求风暴）', fetchCalls >= 2 && fetchCalls <= 10, fetchCalls);

  /* 去重：并发调用只跑一轮 */
  let calls2 = 0;
  sandbox.fetch = function () { calls2++; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}') }); };
  const before = calls2;
  const [a, b] = await Promise.all([D.refresh(), D.refresh()]);
  check('5) 并发「重新检查」只执行一轮 probe', calls2 - before <= 10 && Array.isArray(a) && Array.isArray(b), calls2 - before);

  /* 单 probe 抛异常：整页仍完成 */
  sandbox.fetch = function () { return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }); };
  const origBridge = T.PROBES.bridge;
  T.PROBES.bridge = function () { return Promise.reject(new Error('boom')); };
  const rows2 = await D.refresh();
  T.PROBES.bridge = origBridge;
  check('12) 单个 probe 抛异常 → 检查仍完成', Array.isArray(rows2) && rows2.length === 6, rows2 && rows2.length);
  check('12) 该行状态未知而不是整页报错', rowOf({ rows: rows2 }, 'bridge').status === 'unknown', rowOf({ rows: rows2 }, 'bridge').status);

  /* ═══ E. 一键修复（restart 成功 / 失败） ═══════════════════ */
  section('一键修复：restart 成功 / 失败 / 不可修复时不触发');

  sandbox.fetch = function () { return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') }); };
  let restartState = 'idle';
  let triggerCalls = 0;
  sandbox.ibRestartBackend = function () { triggerCalls++; restartState = 'restarting'; setTimeout(() => { restartState = sandbox.__nextRestart; }, 10); };
  sandbox.IB.backendRestart = { state: () => restartState, trigger: sandbox.ibRestartBackend, getStatus: () => Promise.resolve(null) };

  /* 8. restart 成功 */
  T.setBoot(bootOf('normal', HEALTHY_COMPS));
  T.setProbes(probesAllOk({ bridge: pDown(), restart: pOk({ json: { service: 'InternalBeyond Restart', state: 'idle' } }) }));
  T.compute();
  check('8) 检测到可修复（提供「尝试修复」）', /可以尝试自动修复/.test((rowOf({ rows: T.state().rows }, 'bridge').hint) || ''), rowOf({ rows: T.state().rows }, 'bridge'));
  sandbox.__nextRestart = 'ready';
  const ok8 = await D.repair();
  check('8) restart 成功 → 返回 true 且文案 = 本地功能已经恢复。', ok8 === true && T.state().repairMsg && T.state().repairMsg.text === '本地功能已经恢复。', T.state().repairMsg);
  check('8) 修复记录写入（restart-local-services → ok）', T.state().repairLog[0] && T.state().repairLog[0].result === 'ok', T.state().repairLog[0]);
  check('8) 修复后重新 probe（最近检查时间已更新）', T.state().lastCheckAt > 0, T.state().lastCheckAt);

  /* 9. restart 失败 */
  T.setProbes(probesAllOk({ bridge: pDown(), restart: pOk({ json: { service: 'InternalBeyond Restart', state: 'idle' } }) }));
  T.compute();
  sandbox.__nextRestart = 'failed';
  const ok9 = await D.repair();
  check('9) restart 失败 → 返回 false 且文案 = 自动修复没有成功…', ok9 === false && T.state().repairMsg && T.state().repairMsg.text === '自动修复没有成功。你仍然可以继续使用可用功能。', T.state().repairMsg);
  check('9) 失败记录写入（result=failed）', T.state().repairLog[0] && T.state().repairLog[0].result === 'failed', T.state().repairLog[0]);

  /* 10. 不可修复时不触发任何动作 */
  const callsBefore = triggerCalls;
  T.setProbes(probesAllOk({ bridge: pConflict(), restart: pOk({ json: { service: 'InternalBeyond Restart' } }) }));
  T.compute();
  const ok10 = await D.repair();
  check('10) 端口冲突时「尝试修复」不会触发 restart', ok10 === false && triggerCalls === callsBefore, { ok10, triggerCalls, callsBefore });

  /* ═══ F. AI 连接测试（复用 P3 文案） ═══════════════════════ */
  section('AI 连接测试');

  store.apiConfigs = [{
    id: 'r1', nickname: '小明', provider: 'openai', model: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'sk-test-abcdef123456'
  }];
  T.setProbes(probesAllOk());
  T.compute();

  let captured = null;
  sandbox.callApiChat = function (cfg, messages, opts) { captured = { cfg, messages, opts }; return Promise.resolve('好的'); };
  const okAi = await D.testAi();
  check('13) AI 连接测试成功 → state=ok', okAi === true && T.state().aiTest.state === 'ok', T.state().aiTest);
  check('13) 走既有 callApiChat 链（1 条 user 消息 / 小请求 / 禁用工具）',
    !!captured && captured.messages.length === 1 && captured.messages[0].role === 'user' && captured.opts.maxTokens === 16 && captured.opts.disableTools === true && captured.opts._noWebSearch === true,
    captured && captured.opts);
  check('13) 测试只针对当前角色（不遍历所有角色发收费请求）', captured && captured.cfg.id === 'r1', captured && captured.cfg.id);
  check('13) 明确提示会实际发送一个很小的请求', jsSrc.indexOf('测试会实际向 AI 服务发送一个很小的请求') !== -1);

  sandbox.callApiChat = function () { return Promise.reject(new Error('401: Incorrect API key provided')); };
  await D.testAi();
  const ai401 = T.state().aiTest;
  check('14) 401 → 复用 P3 文案（title=API 密钥无法使用）', ai401.state === 'fail' && ai401.code === 'IBERR.AUTH.401' && ai401.title === 'API 密钥无法使用', ai401);
  check('14) 401 用户文案不含状态码 / 地址 / 密钥', ['401', 'sk-', 'https://', 'api.openai.com'].every(x => String(ai401.title + ai401.message + ai401.suggestion).indexOf(x) === -1), ai401.message);
  check('14) 401 详情含 HTTP 状态但无密钥', /HTTP 状态：401/.test(sandbox.window.IBERR.detailsText(ai401)) && sandbox.window.IBERR.detailsText(ai401).indexOf('sk-test-abcdef123456') === -1, sandbox.window.IBERR.detailsText(ai401));
  T.compute();
  check('14) 401 后 AI 聊天行 = 需要注意', st({ rows: T.state().rows }, 'chat') === 'attention', st({ rows: T.state().rows }, 'chat'));

  sandbox.callApiChat = function () { return Promise.reject(new Error('429: rate limit exceeded')); };
  await D.testAi();
  const ai429 = T.state().aiTest;
  check('14) 429 → 复用 P3 文案（不武断写成余额不足）', ai429.code === 'IBERR.RATE_LIMIT.429' && ai429.title === 'AI 服务暂时拒绝了请求' && /额度|频率/.test(ai429.message), ai429);

  /* ═══ G. 导出报告（成功 + 密钥扫描） ═══════════════════════ */
  section('导出诊断报告');

  const SECRETS = {
    sk: 'sk-live-DEADBEEF0123456789',
    bearer: 'Bearer eyABCDEFGHIJ0123456789',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    query: 'https://api.example.com/v1/chat/completions?key=SECRET-QUERY-VALUE',
    cookie: 'Cookie: session=SECRETCOOKIEVALUE123',
    prompt: '我的系统提示词是：你是一个秘密角色，不要告诉任何人。',
    chat: '聊天正文：昨天我们去海边看了日落，这句话只应该留在本地。'
  };
  /* 把敏感串注入到所有真实数据源（包括自由文本字段） */
  const hostileBoot = bootOf('degraded', {
    static: { healthy: true, state: 'healthy', probed: true, port: 23120 },
    bridge: { healthy: false, state: 'offline', probed: true, port: 23115, reason: { category: 'offline', message: SECRETS.prompt + ' ' + SECRETS.chat + ' ' + SECRETS.sk + ' ' + SECRETS.bearer + ' ' + SECRETS.cookie } },
    active: { healthy: false, state: 'offline', probed: true, port: 23114, reason: { category: 'offline', message: SECRETS.jwt } }
  });
  hostileBoot.state.warnings = [{ code: 'launcher-error', message: SECRETS.chat + ' ' + SECRETS.cookie }];
  hostileBoot.path = 'C:/Users/x/' + SECRETS.sk + '/boot-state.json';
  const hostileProbes = probesAllOk({
    bridge: pDown(),
    bridgeStatus: pOk({ json: { ok: true, tts: true, version: SECRETS.jwt, connections: 3 } }),
    bridgeDiagnostics: pOk({ json: { ok: true, service: { name: SECRETS.bearer, version: SECRETS.sk, port: 23115 }, data: { records: { whispers: 2 } }, warnings: [SECRETS.cookie] } })
  });
  hostileProbes.static.endpoint = SECRETS.query;
  T.setBoot(hostileBoot);
  T.setProbes(hostileProbes);
  T.setAiTest({ state: 'fail', at: Date.now(), code: 'IBERR.AUTH.401', title: 'API 密钥无法使用', message: '密钥无效', suggestion: '检查密钥', roleId: 'r1', latencyMs: 120 });
  store.apiConfigs = [{
    id: 'r1', nickname: SECRETS.prompt, provider: 'openai', model: 'gpt-4o-mini',
    endpoint: SECRETS.query, apiKey: SECRETS.sk, systemPrompt: SECRETS.prompt
  }];
  T.state().errorLog = [{ code: 'IBERR.LOCAL_SERVICE.BRIDGE', category: 'local_service', at: Date.now() }];
  T.compute();

  const report = D.reportText();
  check('15) 报告可生成且包含版本 / 时间 / 启动快照 / 当前状态', /InternalBeyond 诊断报告/.test(report) && /生成时间：/.test(report) && /v24\.18\.0/.test(report) && /【当前功能状态】/.test(report) && /【当前探测】/.test(report));
  check('15) 报告含 P3 错误码与修复记录结构', /IBERR\.LOCAL_SERVICE\.BRIDGE/.test(report) && /【AI 连接测试】/.test(report));
  check('15) 报告含安全健康摘要（数字/布尔，不含 token）', /\/status：/.test(report) && /tts=true/.test(report));
  const leaks = Object.keys(SECRETS).filter(k => report.indexOf(SECRETS[k]) !== -1);
  check('16) 密钥扫描：sk-* / Bearer / JWT / query key / Cookie / prompt / 聊天正文 全部不存在', leaks.length === 0, leaks.map(k => k + '=' + SECRETS[k].slice(0, 24)));
  check('16) 报告不含 apiKey 字段值 / Authorization 头值', !/\bapiKey\b/.test(report) && !/Authorization:\s*\S/i.test(report), (report.match(/\bapiKey\b|Authorization:\s*\S/gi) || []).slice(0, 3));
  check('16) 报告说明未导出本地日志文件', /未导出本地日志文件/.test(report));

  let downloaded = null;
  const origAppend = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = function (n) { if (n && n.tagName === 'A') downloaded = n; return origAppend(n); };
  const exported = D.exportReport();
  doc.body.appendChild = origAppend;
  check('15) 导出成功并生成 .txt 文件名', exported === true && downloaded && /^InternalBeyond-诊断报告-.*\.txt$/.test(downloaded.download), downloaded && downloaded.download);
  const blobText = String((sandbox.__lastBlob && sandbox.__lastBlob.parts && sandbox.__lastBlob.parts[0]) || '');
  check('16) 导出的文件内容同样经过脱敏', blobText.length > 200 && Object.keys(SECRETS).every(k => blobText.indexOf(SECRETS[k]) === -1), Object.keys(SECRETS).filter(k => blobText.indexOf(SECRETS[k]) !== -1));

  /* ═══ H. 入口与 P3 错误卡片动作 ════════════════════════════ */
  section('入口与 P3 错误卡片动作');

  const errSrc = fs.readFileSync(ERR_PATH, 'utf8');
  check('P3 错误卡片支持 open_page 动作（不新增第二套 seam）', /m\.action\.type === 'open_page'/.test(errSrc));
  check('本地服务错误卡片带「系统诊断」动作', /label: '系统诊断'/.test(errSrc) && /type: 'open_page', target: 'diagnostics'/.test(errSrc));
  const bridgeModel = sandbox.window.IBERR.model('local_service', { component: 'bridge' });
  check('bridge 错误模型 → action 指向 diagnostics', bridgeModel.action && bridgeModel.action.type === 'open_page' && bridgeModel.action.target === 'diagnostics' && bridgeModel.action.label === '系统诊断', bridgeModel.action);
  check('vision 错误模型 → 不提供诊断动作（无可自助恢复项）', sandbox.window.IBERR.model('local_service', { component: 'vision' }).action === null);
  check('auth 错误模型 → 仍指向 API 设置（未被改动）', sandbox.window.IBERR.model('auth', { reason: 'missing-key' }).action.target === 'api');

  navCalls.length = 0;
  D.go();
  check('「打开系统诊断」走既有 navTo（不重排导航）', navCalls.indexOf('diagnostics') !== -1, navCalls);

  sandbox.fetch = origFetch;
  clearTimeout();

  console.log('\n结果: ' + passed + ' 通过, ' + failures + ' 失败');
  process.exitCode = failures ? 1 : 0;
})().catch(e => {
  console.error('UNEXPECTED FAILURE: ' + (e && e.stack || e));
  process.exitCode = 1;
});
