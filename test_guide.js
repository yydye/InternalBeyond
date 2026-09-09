'use strict';
/* Internal Beyond — P6 零基础使用指南（Zero-Beginner Guide）契约测试
   运行：node test_guide.js      （零网络、零浏览器）

   覆盖：
     A. 文件与编码
     B. HTML 最小挂载（不新增样式表 / 不动内联样式预算 / 不建第二套帮助页）
     C. 章节结构（12 章、每章目标 + 1–4 步、截图引用、目录、版本标识）
     D. 零基础文案纪律（底层术语 / 端口 / 网址一律不出现）
     E. 截图清单（annotations.json ↔ 磁盘上的 PNG ↔ 正文引用 三方一致）
     F. 与 P3 错误文案、P5 诊断路径对齐
     G. 演示数据隔离（管线只用合成数据 + 全新临时浏览器配置）

   说明：DOM 用最小 shim 提供，只为让模块能在 Node 里真实渲染一遍结构。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const JS_PATH = path.join(ROOT, 'assets', 'js', 'guide-beginner.js');
const CSS_PATH = path.join(ROOT, 'assets', 'css', 'guide-beginner.css');
const HTML_PATH = path.join(ROOT, 'InternalBeyond.html');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'guide', 'annotations.json');
const SHOT_DIR = path.join(ROOT, 'docs', 'guide', 'shots');
const CAPTURE_PATH = path.join(ROOT, 'scripts', 'capture-guide-shots.js');
const FIXTURE_PATH = path.join(ROOT, 'scripts', 'guide-fixtures.js');
const ERR_PATH = path.join(ROOT, 'assets', 'js', 'error-catalog.js');

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

/* ═══ A. 文件与编码 ═══════════════════════════════════════════ */
section('文件与编码（与 test_frontend_structure 同一规则）');

check('guide-beginner.js 存在', fs.existsSync(JS_PATH));
check('guide-beginner.css 存在', fs.existsSync(CSS_PATH));
const jsBuf = fs.readFileSync(JS_PATH);
const cssBuf = fs.readFileSync(CSS_PATH);
const jsSrc = jsBuf.toString('utf8').replace(/^\uFEFF/, '');
const cssSrc = cssBuf.toString('utf8').replace(/^\uFEFF/, '');
check('js 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(jsBuf); return true; } catch (e) { return false; } })());
check('css 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(cssBuf); return true; } catch (e) { return false; } })());
check('js 带 UTF-8 BOM', jsBuf[0] === 0xef && jsBuf[1] === 0xbb && jsBuf[2] === 0xbf);
check('css 带 UTF-8 BOM', cssBuf[0] === 0xef && cssBuf[1] === 0xbb && cssBuf[2] === 0xbf);
check('无乱码特征', !/\uFFFD|锟斤拷|Ã.|Â.|â(?:€|™|œ|“|”)/.test(jsSrc + cssSrc));
check('js 语法可解析', (() => { try { new vm.Script(jsSrc, { filename: 'guide-beginner.js' }); return true; } catch (e) { return false; } })());
check('css 只作用于 #guide-beginner（不污染其它页面）', (() => {
  const selectors = [];
  const stripped = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    selectors.push(sel);
  }
  return selectors.length > 20 && selectors.every(s => s.split(',').every(part => part.trim().startsWith('#guide-beginner')));
})(), (cssSrc.match(/([^{}]+)\{/g) || []).filter(s => !s.trim().startsWith('#guide-beginner') && !s.trim().startsWith('@')).slice(0, 3));

/* ═══ B. HTML 最小挂载 ════════════════════════════════════════ */
section('HTML 最小挂载（不动既有预算 / 不建第二套帮助页）');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptTags = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
const styleTags = [...html.matchAll(/<link[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
check('HTML 只挂载一次 guide-beginner.js', scriptTags.filter(s => s === 'assets/js/guide-beginner.js').length === 1);
check('HTML 没有新增样式表（仍为 20）', styleTags.length === 20, styleTags.length);
check('HTML 没有 guide-beginner.css 的 <link>', !styleTags.includes('assets/css/guide-beginner.css'));
check('HTML 有 #guide-beginner 容器且只有一处', (html.match(/id=["']guide-beginner["']/g) || []).length === 1);
const guidePage = (html.match(/<div class="page" id="page-guide">[\s\S]*?<div class="page" id="page-diy">/) || [''])[0];
check('容器在既有 #page-guide 内（复用而不是新建页面）', guidePage.indexOf('id="guide-beginner"') !== -1);
check('没有新增 page-* 容器', !/id=["']page-guide-beginner["']/.test(html) && !/id=["']page-help["']/.test(html));
check('没有新增导航入口', (html.match(/data-page=["']guide["']/g) || []).length === 1);
check('Guide 目录里加了「零基础使用指南」锚点', /<a href="#guide-beginner">零基础使用指南<\/a>/.test(html));
check('HTML 无 <style> 块', !/<style\b/i.test(html));
check('HTML 无内联 <script>', [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim()).length === 0);
check('HTML 静态内联样式预算未变（<=200）', (html.match(/\bstyle\s*=/gi) || []).length <= 200, (html.match(/\bstyle\s*=/gi) || []).length);
const allJs = ['assets/js/guide-beginner.js', 'scripts/capture-guide-shots.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
check('新模块不新增 style= 属性', (jsSrc.match(/\bstyle\s*=/gi) || []).length === 0);
check('模块运行时注入自己的样式表', /STYLE_HREF\s*=\s*'assets\/css\/guide-beginner\.css'/.test(jsSrc) && /rel\s*=\s*'stylesheet'/.test(jsSrc));
check('模块不发起任何网络请求（正文与截图解耦）', !/\bfetch\s*\(/.test(jsSrc) && !/XMLHttpRequest/.test(jsSrc));
check('模块不改产品行为（不写存储 / 不改导航）', !/dbPut|indexedDB|localStorage|nav-links|classList\.add\('active'/.test(jsSrc));

/* ═══ 渲染（最小 DOM shim） ═══════════════════════════════════ */
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, style: {}, dataset: {}, attributes: {},
    value: '', disabled: false, hidden: false, id: '', type: '', href: '', src: '', alt: '',
    className: '', loading: '', decoding: '', onclick: null, _text: '', _html: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; if (on) this._s.add(c); else this._s.delete(c); return on; }
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener(type, fn) { (this._ev = this._ev || {})[type] = fn; },
    removeEventListener() { },
    scrollIntoView() { }, focus() { },
    click() { if (typeof this.onclick === 'function') this.onclick(); if (this._ev && typeof this._ev.click === 'function') this._ev.click({ preventDefault() { } }); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; }
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
function findAll(node, pred, out) {
  out = out || [];
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}
const hasClass = (n, c) => String(n.className || '').split(/\s+/).indexOf(c) !== -1;

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
const hostEl = makeEl('div'); hostEl.id = 'guide-beginner';
doc.body.appendChild(hostEl);
const PAGE_IDS = ['api', 'chat', 'memory', 'active', 'moments', 'diagnostics'];
const navCalls = [];
for (const p of PAGE_IDS) { const el = makeEl('div'); el.id = 'page-' + p; doc.body.appendChild(el); }

const sandbox = {
  console: { log() { }, warn() { }, error() { } },
  setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, JSON, Date, Error, RegExp, Set, Map,
  document: doc,
  navTo(page) { navCalls.push(String(page)); }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
let loadError = null;
try { new vm.Script(jsSrc, { filename: 'guide-beginner.js' }).runInContext(sandbox); } catch (e) { loadError = e; }

section('模块加载与渲染');
check('模块加载无异常', !loadError, loadError && String(loadError.message));
check('暴露 window.IBGuide', !!sandbox.IBGuide);
check('渲染进 #guide-beginner', !!findById(doc.body, 'guide-beginner'));
check('运行时注入了样式表', !!findById(doc.head, 'ib-guide-style'));
const wrap = findAll(hostEl, n => hasClass(n, 'gb-wrap'))[0] || null;
check('有 .gb-wrap 外壳', !!wrap);
const title = findAll(hostEl, n => hasClass(n, 'gb-title'))[0];
check('标题为「零基础使用指南」', !!title && title.textContent === '零基础使用指南', title && title.textContent);
const meta = findAll(hostEl, n => hasClass(n, 'gb-meta-version'))[0];
check('有版本标识「适用于 InternalBeyond」', !!meta && /适用于 InternalBeyond/.test(meta.textContent), meta && meta.textContent);
check('版本标识带指南版本号', !!meta && /指南版本 \d+\.\d+/.test(meta.textContent), meta && meta.textContent);

/* ═══ C. 章节结构 ═════════════════════════════════════════════ */
section('章节结构（12 章 + 每章目标 + 1–4 步）');

const EXPECTED = [
  ['welcome', '欢迎使用 InternalBeyond'],
  ['setup', '第一次设置'],
  ['ai', '添加 / 配置 AI'],
  ['role', '创建角色'],
  ['chat', '开始聊天'],
  ['memory', 'Memory（记忆库）'],
  ['active', '主动消息'],
  ['moments', '朋友圈 / 动态'],
  ['voice', '语音'],
  ['more', '其他主要功能'],
  ['diagnostics', '系统诊断与故障恢复'],
  ['faq', '常见问题']
];
const chapters = findAll(hostEl, n => hasClass(n, 'gb-chapter'));
check('渲染出 12 章', chapters.length === 12, chapters.length);
const chapterAttr = c => (c.attributes && c.attributes['data-guide-chapter']) || c.dataset.guideChapter || '';
check('章节顺序与信息架构一致', chapters.map(chapterAttr).join(',') === EXPECTED.map(e => e[0]).join(','),
  chapters.map(chapterAttr).join(','));
check('章节标题与信息架构一致', chapters.map(c => (findAll(c, n => hasClass(n, 'gb-chapter-title'))[0] || {}).textContent).join('|') === EXPECTED.map(e => e[1]).join('|'),
  chapters.map(c => (findAll(c, n => hasClass(n, 'gb-chapter-title'))[0] || {}).textContent).join('|'));
for (const [id, label] of EXPECTED) {
  const ch = chapters.filter(c => chapterAttr(c) === id)[0];
  check('章 ' + id + ' 有一句目标', !!ch && !!allText(findAll(ch, n => hasClass(n, 'gb-goal'))[0]));
  check('章 ' + id + ' 有锚点 id', !!ch && ch.id === 'gb-' + id, ch && ch.id);
}
const INDEX = findAll(hostEl, n => hasClass(n, 'gb-index-link'));
check('章节目录列出 12 项', INDEX.length === 12, INDEX.length);
check('目录链接指向章内锚点', INDEX.every(a => /^#gb-/.test(a.href)));
for (const ch of chapters) {
  const steps = findAll(ch, n => n.tagName === 'LI' && n.parentNode && hasClass(n.parentNode, 'gb-steps'));
  const id = chapterAttr(ch);
  if (id === 'faq') {
    check('FAQ 章用问答列表而不是步骤', steps.length === 0);
  } else {
    check('章 ' + id + ' 有 1–4 个步骤', steps.length >= 1 && steps.length <= 4, steps.length);
  }
  const tips = findAll(ch, n => hasClass(n, 'gb-tip'));
  check('章 ' + id + ' 至多一个「遇到问题？」提示', tips.length <= 1, tips.length);
}
check('有「技术说明」折叠区（details）', findAll(hostEl, n => hasClass(n, 'gb-tech')).length === 1);
check('技术说明是 details 元素', (findAll(hostEl, n => hasClass(n, 'gb-tech'))[0] || {}).tagName === 'DETAILS');

/* 深链按钮：只指向真实存在的页面 */
const actions = findAll(hostEl, n => hasClass(n, 'gb-action'));
check('有可点击的深链按钮', actions.length >= 6, actions.length);
check('深链按钮都有 type=button', actions.every(b => b.type === 'button'));
for (const b of actions) b.click();
check('深链按钮只跳到真实存在的页面', navCalls.length === actions.length && navCalls.every(p => PAGE_IDS.indexOf(p) !== -1), navCalls);

/* 缺页时不渲染按钮：另起一个只有 page-api 的环境重新渲染一次 */
function renderWith(pages) {
  const d = {
    readyState: 'complete', head: makeEl('head'), body: makeEl('body'),
    createElement: makeEl,
    getElementById(id) { return findById(this.body, id) || findById(this.head, id); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() { }, removeEventListener() { }
  };
  const host = makeEl('div'); host.id = 'guide-beginner'; d.body.appendChild(host);
  for (const p of pages) { const el = makeEl('div'); el.id = 'page-' + p; d.body.appendChild(el); }
  const calls = [];
  const box = {
    console: { log() { }, warn() { }, error() { } },
    setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, JSON, Date, Error, RegExp, Set, Map,
    document: d, navTo(p) { calls.push(String(p)); }
  };
  box.window = box;
  vm.createContext(box);
  new vm.Script(jsSrc, { filename: 'guide-beginner.js' }).runInContext(box);
  return { host, calls, all: findAll(host, n => hasClass(n, 'gb-action')) };
}
const onlyApi = renderWith(['api']);
check('页面不存在时对应的深链按钮不渲染', onlyApi.all.length === 2 && onlyApi.all.every(b => b.textContent.indexOf('API') !== -1), onlyApi.all.map(b => b.textContent));
check('没有对应页面时点击不会跳到不存在的页', onlyApi.calls.length === 0);

/* ═══ D. 零基础文案纪律 ═══════════════════════════════════════ */
section('零基础文案纪律');

const FORBIDDEN = ['Node.js', 'NodeJS', 'npm', 'PowerShell', 'localhost', '23115', '23114', '23116',
  'WebSocket', 'ws://', 'IndexedDB', 'daemon', '127.0.0.1', '端口', 'API endpoint', 'endpoint'];
const renderedText = allText(hostEl);
const srcHits = FORBIDDEN.filter(t => jsSrc.indexOf(t) !== -1);
const textHits = FORBIDDEN.filter(t => renderedText.indexOf(t) !== -1);
check('模块源码不出现底层术语', srcHits.length === 0, srcHits);
check('渲染文本不出现底层术语', textHits.length === 0, textHits);
check('模块源码不出现 \bprocess\b / \bruntime\b 等概念', !/\bprocess\b|\bruntime\b|\bdaemon\b/.test(jsSrc));
check('正文不出现裸网址', !/https?:\/\//.test(renderedText));
check('正文不出现终端 / 命令行字样', !/终端|命令行|cmd\.exe|PowerShell/.test(renderedText));
check('不要求用户手工检查端口', !/检查端口|查看端口|端口号/.test(renderedText));
check('强调大多数情况不需要开发者工具', /不需要打开任何命令窗口|不需要打开任何命令窗口或开发者工具/.test(renderedText));
check('API Key 安全提示到位', /不要发给别人/.test(renderedText) && /截图/.test(renderedText) && /诊断报告都不会包含它/.test(renderedText));
check('API Key 获取方式不硬编码第三方流程', /官方网站获取/.test(renderedText) && !/控制台|dashboard|后台页面|注册页面/.test(renderedText));
check('首启说明：向导会自动出现', /设置向导会自动出现/.test(renderedText));
check('说明跳过之后如何重新进入向导', /重新运行设置向导/.test(renderedText));
check('说明如何添加第二个角色', /再加一个角色|再加一个/.test(renderedText));

/* ═══ E. 截图清单与图片 ═══════════════════════════════════════ */
section('截图清单（annotations.json ↔ PNG ↔ 正文引用）');

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
check('清单是合法 JSON 且有 schema', manifest.schema === 'ib-guide-shots/1', manifest.schema);
check('清单带 guideVersion', /^\d+\.\d+$/.test(String(manifest.guideVersion || '')), manifest.guideVersion);
check('清单版本与正文版本标识一致', !!meta && meta.textContent.indexOf(String(manifest.guideVersion)) !== -1, manifest.guideVersion);
check('清单声明稳定 viewport', manifest.viewport && manifest.viewport.width === 1440 && manifest.viewport.height === 900, manifest.viewport);
check('清单至少 16 张（P6 首批要求）', Array.isArray(manifest.shots) && manifest.shots.length >= 16, manifest.shots && manifest.shots.length);

const REQUIRED_SHOT_FIELDS = ['id', 'file', 'title', 'chapter', 'prepare', 'region', 'caption'];
for (const s of manifest.shots) {
  const missing = REQUIRED_SHOT_FIELDS.filter(k => !s[k]);
  check('shot ' + s.id + ' 字段完整', missing.length === 0, missing);
  check('shot ' + s.id + ' 文件名稳定（<id>.png）', s.file === s.id + '.png', s.file);
  check('shot ' + s.id + ' 有高亮区域或明确标注', s.region === 'none' || (!!s.target && !!s.label), { target: s.target, label: s.label });
}
check('清单 shot id 唯一', new Set(manifest.shots.map(s => s.id)).size === manifest.shots.length);

/* 正文引用 = 清单条目（双向一致） */
const guideShotIds = findAll(hostEl, n => n.attributes && n.attributes['data-guide-shot']).map(n => n.attributes['data-guide-shot']);
check('正文引用的截图都在清单里', guideShotIds.every(id => manifest.shots.some(s => s.id === id)), guideShotIds.filter(id => !manifest.shots.some(s => s.id === id)));
check('清单里的截图都被正文引用', manifest.shots.every(s => guideShotIds.indexOf(s.id) !== -1), manifest.shots.filter(s => guideShotIds.indexOf(s.id) === -1).map(s => s.id));
check('首批 16 张全部被正文引用', guideShotIds.length >= 16, guideShotIds.length);

/* 图片与清单一致 */
const pngSize = buf => (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
const hashes = new Set();
for (const s of manifest.shots) {
  const f = path.join(SHOT_DIR, s.file);
  const exists = fs.existsSync(f);
  check('图片存在 ' + s.file, exists);
  if (!exists) continue;
  const buf = fs.readFileSync(f);
  const dim = pngSize(buf);
  check('图片是 PNG 且尺寸稳定 ' + s.file, !!dim && dim.w === manifest.viewport.width && dim.h === manifest.viewport.height, dim);
  check('图片不是空白 ' + s.file, buf.length > 6000, buf.length);
  const h = require('crypto').createHash('sha1').update(buf).digest('hex');
  check('图片内容唯一 ' + s.file, !hashes.has(h));
  hashes.add(h);
}
check('磁盘上没有多余的旧图', fs.readdirSync(SHOT_DIR).filter(f => /\.png$/i.test(f)).every(f => manifest.shots.some(s => s.file === f)),
  fs.readdirSync(SHOT_DIR).filter(f => !manifest.shots.some(s => s.file === f)));

/* 图片是辅助：加载失败仍可读 */
const figures = findAll(hostEl, n => hasClass(n, 'gb-figure'));
check('每张引用都渲染成 figure', figures.length === guideShotIds.length, figures.length);
check('每张图有 figcaption 说明', figures.every(f => !!allText(findAll(f, n => hasClass(n, 'gb-caption'))[0])));
check('每张图有 alt 文本', figures.every(f => !!(findAll(f, n => n.tagName === 'IMG')[0] || {}).alt));
check('图片地址指向 docs/guide/shots', figures.every(f => /^docs\/guide\/shots\/.+\.png$/.test((findAll(f, n => n.tagName === 'IMG')[0] || {}).src || '')));
check('每张图带「打不开也不影响文字步骤」的占位', figures.every(f => !!findAll(f, n => hasClass(n, 'gb-shot-missing'))[0]));
check('占位默认隐藏', figures.every(f => (findAll(f, n => hasClass(f, 'gb-shot-missing'))[0] || {}).hidden !== false));
check('模块绑定了图片加载失败回退', /addEventListener\('error'/.test(jsSrc) && /is-missing/.test(jsSrc));
check('正文不依赖图片加载顺序（无 await 图片）', !/await.*gb-shot|await.*figure/.test(jsSrc));

/* 管线可重新生成 */
section('截图管线');
const capSrc = fs.readFileSync(CAPTURE_PATH, 'utf8');
check('管线脚本存在', fs.existsSync(CAPTURE_PATH));
check('管线用真实浏览器打开真实页面', /launchBrowser\(/.test(capSrc) && /InternalBeyond\.html/.test(capSrc));
check('管线用稳定 viewport', /setDeviceMetricsOverride/.test(capSrc) && /VIEWPORT = \{ width: 1440, height: 900/.test(capSrc));
check('管线用全新临时浏览器配置目录', /mkdtempSync/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'cdp-lite.js'), 'utf8')) && /--user-data-dir=/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'cdp-lite.js'), 'utf8')));
check('管线按清单顺序执行', /for \(const shot of shots\)/.test(capSrc) && /PREPARE\[shot\.prepare\]/.test(capSrc));
check('管线画高亮框 + 箭头标注', /a-box/.test(capSrc) && /a-head/.test(capSrc) && /a-chip/.test(capSrc));
check('管线截图后清理标注层', /clearAnnotation/.test(capSrc));
check('管线自检：图片过小 / 重复 / 尺寸不符', /图片过小/.test(capSrc) && /完全相同/.test(capSrc) && /稳定 viewport 不一致/.test(capSrc));
check('管线自检：页面文本不含真实凭据', /疑似真实密钥/.test(capSrc) && /疑似真实邮箱/.test(capSrc));
check('管线只用合成演示数据', /require\('\.\/guide-fixtures\.js'\)/.test(capSrc));
check('清单里的 prepare 都在管线里实现', manifest.shots.every(s => new RegExp("(?:async )?'?" + s.prepare.replace(/[-]/g, '\\-') + "'?\\(|'" + s.prepare + "'\\(\\)").test(capSrc)),
  manifest.shots.map(s => s.prepare).filter(p => capSrc.indexOf("'" + p + "'") === -1));

const fixtures = require(FIXTURE_PATH);
const audit = fixtures.auditDemo();
check('演示数据自检通过（无真实凭据 / 个人信息）', audit.ok, audit.problems);
check('演示密钥是 sk-demo- 全 0 占位', /^sk-demo-0+$/.test(fixtures.DEMO.role.apiKey), fixtures.DEMO.role.apiKey);
check('演示端点指向保留域名', /^https:\/\/api\.example\.com\//.test(fixtures.DEMO.role.endpoint), fixtures.DEMO.role.endpoint);
check('演示数据写进产品自己的存储结构', /dbPut\('apiConfigs'|dbPut\('chatMessages'|dbPut\('memories'|dbPut\('moments'/.test(fixtures.seedSource({ roleId: 'x' })));
check('管线不读取开发者真实浏览器数据', !/LOCALAPPDATA.*Chrome|User Data.*Default/.test(capSrc));

/* ═══ F. 与 P3 / P5 对齐 ══════════════════════════════════════ */
section('与 P3 错误文案、P5 诊断路径对齐');

const errSrc = fs.readFileSync(ERR_PATH, 'utf8');
const P3_TITLES = ['API 密钥无法使用', 'AI 服务暂时拒绝了请求', '连接不上网络', '当前模型不可用', '语音生成失败', '部分本地功能暂时不可用', '后台功能暂时不可用'];
for (const t of P3_TITLES) {
  check('P3 目录里存在文案「' + t + '」', errSrc.indexOf(t) !== -1);
}
check('FAQ 直接引用 P3 文案而不是另写一套', P3_TITLES.filter(t => renderedText.indexOf(t) !== -1).length >= 6,
  P3_TITLES.filter(t => renderedText.indexOf(t) !== -1));
check('FAQ 至少 10 条', findAll(hostEl, n => hasClass(n, 'gb-faq-q')).length >= 10, findAll(hostEl, n => hasClass(n, 'gb-faq-q')).length);
const FAQ_TOPICS = ['密钥', '拒绝', '网络', '本地功能', '主动消息', '语音', '模型', '重新设置', '诊断报告', '第二个角色|再加一个角色'];
for (const t of FAQ_TOPICS) check('FAQ 覆盖：' + t, new RegExp(t).test(renderedText));

check('诊断章复用 P5 操作路径（重新检查）', /重新检查/.test(renderedText));
check('诊断章复用 P5 操作路径（尝试修复）', /尝试修复/.test(renderedText));
check('诊断章复用 P5 操作路径（导出诊断报告）', /导出诊断报告/.test(renderedText));
check('诊断章先讲总体状态再看逐项', /先看最上面那行大字/.test(renderedText));
check('诊断章不教用户手工查端口 / 开终端', !/终端|命令行|端口/.test(renderedText));
check('导航名与实际一致（Diagnostics）', /Diagnostics/.test(renderedText));
check('模块不建第二套错误分类', !/IBERR|error-catalog|errorCatalog/.test(jsSrc));

/* ═══ G. 版本维护 ═════════════════════════════════════════════ */
section('版本维护');
check('版本号只有一处默认值', (jsSrc.match(/VERSION_FALLBACK\s*=\s*'[\d.]+'/g) || []).length === 1);
check('支持宿主注入产品版本', /window\.IB_GUIDE_VERSION/.test(jsSrc));
check('清单与默认版本一致', jsSrc.indexOf("VERSION_FALLBACK = '" + manifest.guideVersion + "'") !== -1);
check('不把发布日期写进正文', !/20\d\d-\d\d-\d\d/.test(renderedText));

/* ═══ H. 阅读位置恢复 ═════════════════════════════════════════ */
section('阅读位置恢复（切页返回 / 显式锚点优先 / clamp）');

/* H1. 与既有导航生命周期对接（静态） */
const coreSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'core.js'), 'utf8').replace(/^\uFEFF/, '');
const atLeave = coreSrc.indexOf('IBGuide.pos.leave');
const atEnter = coreSrc.indexOf('IBGuide.pos.enter');
const atActive = coreSrc.indexOf("classList.add('active')");
const atPage = coreSrc.indexOf('currentPage=page');
check('导航生命周期：离开 Guide 前记录（早于切换 currentPage）', atLeave !== -1 && atPage !== -1 && atLeave < atPage, { atLeave, atPage });
check('导航生命周期：页面激活后恢复（同一 tick，不会先闪顶部）', atEnter !== -1 && atActive !== -1 && atEnter > atActive, { atEnter, atActive });
check('钩子有存在性判断，不依赖模块加载顺序',
  /window\.IBGuide&&IBGuide\.pos&&typeof IBGuide\.pos\.leave==='function'/.test(coreSrc) &&
  /window\.IBGuide&&IBGuide\.pos&&typeof IBGuide\.pos\.enter==='function'/.test(coreSrc));
check('恢复是同步调用，没有包在定时器 / 帧回调里',
  !/setTimeout\([^)]*IBGuide\.pos\.enter/.test(coreSrc) && !/requestAnimationFrame\([^)]*IBGuide\.pos\.enter/.test(coreSrc));
check('状态只用内存 + 会话级 Web Storage，不新增数据库',
  /sessionStorage/.test(jsSrc) && !/indexedDB|openDatabase/i.test(jsSrc) && /POS_KEY = 'ib_guide_readpos'/.test(jsSrc));
check('不接管浏览器全局滚动恢复', !/scrollRestoration/.test(jsSrc) && !/scrollRestoration/.test(coreSrc));
check('恢复不触发平滑滚动（瞬时落点）', /scrollBehavior\s*=\s*'auto'/.test(jsSrc) && /behavior:\s*'instant'/.test(jsSrc));
check('对异常值做 clamp：0 ≤ y ≤ scrollHeight − clientHeight',
  /function clampY/.test(jsSrc) && /Math\.min\(v, maxY\(\)\)/.test(jsSrc) && /Math\.max\(0, h - c\)/.test(jsSrc));
check('只作用于 guide 页，不扩散成全站 scroll 恢复',
  /fromPage === 'guide'/.test(jsSrc) && /toPage !== 'guide'/.test(jsSrc));

/* H2. 定点单元：用最小滚动环境驱动 leave / enter */
function makeScrollEnv(seed) {
  const d = {
    readyState: 'complete', head: makeEl('head'), body: makeEl('body'),
    createElement: makeEl,
    getElementById(id) { return findById(this.body, id) || findById(this.head, id); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() { }, removeEventListener() { }
  };
  const se = { scrollTop: 0, scrollHeight: 6000, clientHeight: 1000, style: {} };
  d.scrollingElement = se;
  d.documentElement = se;

  const pageEl = makeEl('div'); pageEl.id = 'page-guide';
  d.body.appendChild(pageEl);

  /* 章内锚点：#gb-chat 在文档 4200 处，CSS 给了 70px 的 scroll-margin-top */
  const chapter = makeEl('section');
  chapter.id = 'gb-chat';
  chapter.setAttribute('data-guide-chapter', 'chat');
  chapter._abs = 4200; chapter._margin = 70;
  chapter.getBoundingClientRect = () => ({ top: chapter._abs - se.scrollTop, left: 0, width: 900, height: 400 });
  chapter.scrollIntoView = () => { se.scrollTop = Math.max(0, Math.min(chapter._abs - chapter._margin, Math.max(0, se.scrollHeight - se.clientHeight))); };
  pageEl.appendChild(chapter);
  pageEl.querySelectorAll = sel => (sel === '[data-guide-chapter]' ? [chapter] : []);

  /* Guide 页外的锚点（右侧固定目录）——不该被当成章节深链 */
  const outside = makeEl('div'); outside.id = 'guide-toc';
  d.body.appendChild(outside);

  const rafQ = [];
  const mem = Object.assign({}, seed || {});
  const box = {
    console: { log() { }, warn() { }, error() { } },
    setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, JSON, Date, Error, RegExp, Set, Map, isFinite,
    document: d,
    location: { hash: '' },
    innerHeight: 1000,
    requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
    scrollTo(x, y) { se.scrollTop = y; },
    addEventListener(type, fn) { (this._ev = this._ev || {}); (this._ev[type] = this._ev[type] || []).push(fn); },
    sessionStorage: {
      _m: mem,
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
      setItem(k, v) { this._m[k] = String(v); },
      removeItem(k) { delete this._m[k]; }
    }
  };
  box.window = box;
  Object.defineProperty(box, 'pageYOffset', { get() { return se.scrollTop; }, configurable: true });
  vm.createContext(box);
  new vm.Script(jsSrc, { filename: 'guide-beginner.js' }).runInContext(box);
  return {
    box, se, pageEl, chapter, outside,
    pos: box.IBGuide.pos,
    flushRaf() { let n = 0; while (rafQ.length && n++ < 8) { const q = rafQ.splice(0); q.forEach(f => f()); } },
    storage() { return Object.assign({}, mem); }
  };
}
const env = makeScrollEnv();
const pos = env.pos;
const se = env.se;
check('暴露阅读位置接口', !!pos && typeof pos.leave === 'function' && typeof pos.enter === 'function' && typeof pos.clamp === 'function');

/* 场景 1：滚到 60% → 切页 → 返回 */
env.pos.clear();
env.pageEl.classList.add('active');
env.se.scrollTop = 3000;                     /* 可滚范围 0–4000，约 75% */
env.pos.leave('guide');
check('离开 Guide 时记录当前 scrollTop', !!env.pos.read() && env.pos.read().y === 3000, env.pos.read());
env.pageEl.classList.remove('active');       /* 页面隐藏：浏览器把滚动位置夹回 0 */
env.se.scrollTop = 0;
env.pageEl.classList.add('active');
env.pos.enter('guide');
check('回到 Guide 恢复原阅读位置', env.se.scrollTop === 3000, env.se.scrollTop);
env.flushRaf();
check('settle 之后位置不变（无可见跳动）', env.se.scrollTop === 3000, env.se.scrollTop);
check('恢复过程没有留下 inline scroll-behavior', env.se.scrollTop === 3000 && se.style.scrollBehavior === '' , se.style.scrollBehavior);

/* 场景 2：内容变短 / 异常值一律 clamp */
env.pos.clear();
env.pageEl.classList.add('active');
env.se.scrollTop = 3000; env.pos.leave('guide');
env.se.scrollHeight = 1200;                  /* 指南变短：最大可滚 200 */
env.se.scrollTop = 0;
env.pos.enter('guide');
env.flushRaf();
check('内容变更后 clamp 到最大可滚位置', env.se.scrollTop === 200, env.se.scrollTop);
env.se.scrollHeight = 6000;
check('clamp：负值 / NaN → 0，超界 → 最大值',
  env.pos.clamp(-50) === 0 && env.pos.clamp(NaN) === 0 && env.pos.clamp(1e9) === 5000, [env.pos.clamp(-50), env.pos.clamp(NaN), env.pos.clamp(1e9)]);
env.box.sessionStorage.setItem(env.pos.key, JSON.stringify({ y: 'oops' }));
check('存储里的非法值被丢弃', env.pos.stored() === null, env.pos.stored());
env.box.sessionStorage.setItem(env.pos.key, '{broken');
check('存储里的坏 JSON 被丢弃', env.pos.stored() === null);

/* 场景 3：显式章节深链优先于历史位置 */
env.pos.clear();
env.box.location.hash = '';
env.pageEl.classList.add('active');
env.se.scrollTop = 3000; env.pos.leave('guide');
env.pageEl.classList.remove('active');
env.box.location.hash = '#gb-chat';          /* 用户明确点了章节目录 */
env.se.scrollTop = 0;
env.pageEl.classList.add('active');
env.pos.enter('guide');
check('显式章节深链优先，跳到该章节而不是恢复旧位置', env.se.scrollTop === 4130, env.se.scrollTop);
env.flushRaf();
check('深链落点尊重 scroll-margin-top 且保持稳定', env.se.scrollTop === 4130, env.se.scrollTop);

/* 场景 4：URL 上还是同一个锚点（不是新的显式导航）→ 按阅读位置恢复 */
env.pos.clear();
env.box.location.hash = '#gb-chat';
env.pageEl.classList.add('active');
env.se.scrollTop = 4200; env.pos.leave('guide');
check('快照里记下可识别章节', !!env.pos.read() && env.pos.read().anchor === 'gb-chat', env.pos.read());
env.pageEl.classList.remove('active');
env.se.scrollTop = 0;
env.pageEl.classList.add('active');
env.pos.enter('guide');
env.flushRaf();
check('同一个锚点不算新的显式导航，仍按阅读位置恢复', env.se.scrollTop === 4200, env.se.scrollTop);

/* 场景 5：Guide 页外的锚点（右侧固定目录）不触发跳转 */
env.pos.clear();
env.box.location.hash = '';
env.pageEl.classList.add('active');
env.se.scrollTop = 1800; env.pos.leave('guide');
env.pageEl.classList.remove('active');
env.box.location.hash = '#guide-toc';
env.se.scrollTop = 0;
env.pageEl.classList.add('active');
env.pos.enter('guide');
env.flushRaf();
check('#page-guide 之外的锚点不算章节深链', env.se.scrollTop === 1800, env.se.scrollTop);
check('页外锚点识别返回空', env.pos.anchorOf('guide-toc') === '' && env.pos.anchorOf('gb-chat') === 'gb-chat', [env.pos.anchorOf('guide-toc'), env.pos.anchorOf('gb-chat')]);

/* 场景 6：其它页面不参与 */
env.pos.clear();
env.box.location.hash = '';
env.pageEl.classList.remove('active');
env.se.scrollTop = 1200;
env.pos.leave('chat');
check('离开非 Guide 页面不记录', env.pos.read() === null);
env.box.location.hash = '#gb-chat';
env.se.scrollTop = 700;
check('进入非 Guide 页面不恢复', env.pos.enter('chat') === false && env.se.scrollTop === 700, env.se.scrollTop);

/* 场景 7：没有历史位置时保持原地 */
env.pos.clear();
env.box.location.hash = '';
env.pageEl.classList.add('active');
env.se.scrollTop = 640;
check('没有历史位置时保持原地（不强制回顶部）', env.pos.enter('guide') === false && env.se.scrollTop === 640, env.se.scrollTop);

/* 场景 8：误刷新（同会话新实例 + 同一份会话存储） */
env.pos.clear();
env.box.location.hash = '';
env.pageEl.classList.add('active');
env.se.scrollTop = 2200; env.pos.leave('guide');
const seeded = env.storage();
check('会话级存储写入了快照', !!seeded[env.pos.key] && JSON.parse(seeded[env.pos.key]).y === 2200, seeded[env.pos.key]);
const env2 = makeScrollEnv(seeded);
env2.pageEl.classList.add('active');
env2.pos.enter('guide');
env2.flushRaf();
check('刷新后同一会话内仍能恢复阅读位置', env2.se.scrollTop === 2200, env2.se.scrollTop);
check('刷新后仍不触发平滑滚动', env2.se.style.scrollBehavior === '', env2.se.style.scrollBehavior);

/* 场景 9：会话存储不可用时退化为纯内存 */
const env3 = makeScrollEnv();
delete env3.box.sessionStorage;
env3.pageEl.classList.add('active');
env3.se.scrollTop = 1500; env3.pos.leave('guide');
env3.pageEl.classList.remove('active'); env3.se.scrollTop = 0; env3.pageEl.classList.add('active');
env3.pos.enter('guide');
env3.flushRaf();
check('会话存储不可用时用内存仍然恢复', env3.se.scrollTop === 1500, env3.se.scrollTop);

/* 场景 10：刷新后截图尚未占位 —— 先夹到当前可用范围，图片占位后再对齐 */
const env4 = makeScrollEnv();
env4.pageEl.classList.add('active');
env4.se.scrollHeight = 2000;                 /* 截图还没占位：文档比真实高度短 */
env4.box.sessionStorage.setItem(env4.pos.key, JSON.stringify({ v: 1, y: 3000, anchor: 'gb-chat', hash: '', h: 5000, t: 1 }));
env4.pos.restore();
env4.flushRaf();
check('截图未占位时先夹到当前可用范围（不恢复到不存在的位置）', env4.se.scrollTop === 1000, env4.se.scrollTop);
env4.se.scrollHeight = 6000;                 /* 截图占位，文档回到真实高度 */
env4.pos.shotSettled();
check('截图占位后把落点对齐回原目标', env4.se.scrollTop === 3000, env4.se.scrollTop);
env4.se.scrollTop = 800;                     /* 用户自己滚走了 */
env4.se.scrollHeight = 7000;
env4.pos.shotSettled();
check('用户自己滚动后不再纠正（不抢用户的位置）', env4.se.scrollTop === 800, env4.se.scrollTop);

console.log('\n结果: ' + passed + ' 通过, ' + failures + ' 失败');
process.exitCode = failures ? 1 : 0;
