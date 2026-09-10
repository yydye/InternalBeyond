'use strict';
/* Internal Beyond — P16 零门槛 API 获取向导（API Onboarding）契约测试
   运行：node test_api_onboarding.js      （零网络、零浏览器）

   覆盖：
     A. 文件与编码（与 test_frontend_structure / test_guide 同一规则）
     B. HTML 挂载（不新增样式表 / 不动内联样式预算 / 复用既有 API 页）
     C. 单一数据源（onboarding metadata 只在 provider-directory.js；不复制 endpoint/format）
     D. 官方 / 第三方分组与风险说明（metadata 决定身份，不猜域名）
     E. 渲染（最小 DOM shim）：入口分流 / 官方卡片 / 第三方卡片 / metadata 缺失时回落
     F. 预填链路：provider → endpoint / model / 能力（复用 onProviderChange，不覆盖用户手改）
     G. 链接安全：https 白名单 / noopener noreferrer / 不接受 URL 里的凭据参数
     H. 回归：既有 API 编辑/保存链路与 HTML 预算不变

   说明：DOM 用最小 shim 提供，只为让模块能在 Node 里真实渲染一遍结构。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const JS_PATH = path.join(ROOT, 'assets', 'js', 'api-onboarding.js');
const CSS_PATH = path.join(ROOT, 'assets', 'css', 'api-onboarding.css');
const DIR_PATH = path.join(ROOT, 'assets', 'js', 'provider-directory.js');
const SOCIAL_PATH = path.join(ROOT, 'assets', 'js', 'social.js');
const HTML_PATH = path.join(ROOT, 'InternalBeyond.html');

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

/* ═══ A. 文件与编码 ═══════════════════════════════════════════ */
section('文件与编码');

check('api-onboarding.js 存在', fs.existsSync(JS_PATH));
check('api-onboarding.css 存在', fs.existsSync(CSS_PATH));
const jsBuf = fs.readFileSync(JS_PATH);
const cssBuf = fs.readFileSync(CSS_PATH);
const jsSrc = jsBuf.toString('utf8').replace(/^\uFEFF/, '');
const cssSrc = cssBuf.toString('utf8').replace(/^\uFEFF/, '');
check('js 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(jsBuf); return true; } catch (e) { return false; } })());
check('css 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(cssBuf); return true; } catch (e) { return false; } })());
check('js 带 UTF-8 BOM', jsBuf[0] === 0xef && jsBuf[1] === 0xbb && jsBuf[2] === 0xbf);
check('css 带 UTF-8 BOM', cssBuf[0] === 0xef && cssBuf[1] === 0xbb && cssBuf[2] === 0xbf);
check('无乱码特征', !/\uFFFD|锟斤拷|Ã.|Â.|â(?:€|™|œ|“|”)/.test(jsSrc + cssSrc));
check('js 语法可解析', (() => { try { new vm.Script(jsSrc, { filename: 'api-onboarding.js' }); return true; } catch (e) { return false; } })());
check('css 只作用于 #api-onboarding-entry / #ib-onboarding / #api-editor 的 ibo-* 元素', (() => {
  const stripped = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [];
  for (const m of stripped.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    sels.push(sel);
  }
  const KF = new Set(['from', 'to']);
  return sels.length > 20 && sels.every(s => s.split(',').every(part => {
    const t = part.trim();
    if (KF.has(t) || /^\d+%$/.test(t)) return true;   /* @keyframes 关键帧 */
    return t.startsWith('#api-onboarding-entry') || t.startsWith('.ibo-') || t.startsWith('#api-editor');
  }));
})(), '选择器越界');

/* ═══ B. HTML 挂载 ════════════════════════════════════════════ */
section('HTML 挂载（复用既有 API 页，不动预算）');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptTags = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
const styleTags = [...html.matchAll(/<link[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
check('HTML 只挂载一次 api-onboarding.js', scriptTags.filter(s => s === 'assets/js/api-onboarding.js').length === 1);
check('HTML 没有新增样式表（仍为 20）', styleTags.length === 20, styleTags.length);
check('HTML 没有 api-onboarding.css 的 <link>', !styleTags.includes('assets/css/api-onboarding.css'));
check('入口容器在既有 #page-api 内', (() => {
  const page = (html.match(/<div class="page" id="page-api">[\s\S]*?<div class="page" id="page-/) || [''])[0];
  return page.indexOf('id="api-onboarding-entry"') !== -1;
})());
check('入口容器只有一处', (html.match(/id=["']api-onboarding-entry["']/g) || []).length === 1);
check('没有新增 page-* 容器 / 导航入口', !/id=["']page-onboarding["']/.test(html) && (html.match(/data-page=["']api["']/g) || []).length === 1);
check('HTML 无 <style> 块 / 内联 <script>', !/<style\b/i.test(html)
  && [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim()).length === 0);
check('HTML 静态内联样式预算未变（<=200）', (html.match(/\bstyle\s*=/gi) || []).length <= 200, (html.match(/\bstyle\s*=/gi) || []).length);
check('新模块不新增 style= 属性', (jsSrc.match(/\bstyle\s*=/gi) || []).length === 0);
check('模块运行时注入自己的样式表', /STYLE_HREF\s*=\s*'assets\/css\/api-onboarding\.css'/.test(jsSrc) && /rel\s*=\s*'stylesheet'/.test(jsSrc));
check('HTML 提供 Key 获取提示位与兼容导入提示位', /id="ibo-key-help"/.test(html) && /id="ibo-compatible-hint"/.test(html));
check('脚本加载顺序：provider-directory → social → api-onboarding', (() => {
  const i1 = scriptTags.indexOf('assets/js/provider-directory.js');
  const i2 = scriptTags.indexOf('assets/js/social.js');
  const i3 = scriptTags.indexOf('assets/js/api-onboarding.js');
  return i1 !== -1 && i2 !== -1 && i3 !== -1 && i1 < i2 && i2 < i3;
})());

/* ═══ C. 单一数据源 ═══════════════════════════════════════════ */
section('单一数据源（provider-directory.js 是唯一 canonical 真源）');

const canon = require(DIR_PATH);
const dirText = fs.readFileSync(DIR_PATH, 'utf8');
check('目录导出 onboarding 读取面', ['onboardingEntry', 'officialOnboardingEntry', 'thirdPartyEntry', 'officialList', 'thirdPartyList', 'providerKind']
  .every(fn => typeof canon[fn] === 'function'), '导出不完整');
check('目录导出 onboarding 元数据表', !!canon.OFFICIAL_ONBOARDING && Array.isArray(canon.THIRD_PARTY_SITES) && Array.isArray(canon.THIRD_PARTY_RISK));

/* provider-directory.js 是 harness 级纯数据模块（test_harness_boundary 锁死）：
   onboarding metadata 只能加数据，不得引入 DOM 属性名 / window / fetch。 */
/* P17：纯数据守卫已收紧为「真实 DOM 访问」（见 test_harness_boundary.js）：
   字符串字面量里的 document / navigator（例如官方文档 URL）不再算违规。
   这里用同一语义自查：先挖空字符串，再找 DOM 访问。 */
const stripStringsForGuard = (src) => src
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');
const DOM_ACCESS_RE = /\b(?:document|navigator)\s*[.\[]|\b(?:querySelector|querySelectorAll|getElementById|innerHTML)\b/;
check('目录仍是纯数据模块（无 DOM 访问 / window / fetch / require）', (() => {
  const c = stripStringsForGuard(dirText.replace(/\/\*[\s\S]*?\*\//g, ''));
  return !DOM_ACCESS_RE.test(c)
    && !/\bwindow\b/.test(c) && !/\bfetch\s*\(/.test(c) && !/\brequire\s*\(/.test(c);
})(), '目录被污染');
check('onboarding 条目不携带 DOM 访问代码（文档 URL 里的同名单词不算）', (() => {
  const values = [];
  for (const id of Object.keys(canon.OFFICIAL_ONBOARDING)) {
    const e = canon.OFFICIAL_ONBOARDING[id];
    Object.keys(e).forEach(k => {
      const v = e[k];
      if (typeof v === 'string') values.push(v);
      else if (Array.isArray(v)) v.forEach(x => values.push(String(x)));
    });
  }
  canon.THIRD_PARTY_SITES.forEach(s => Object.keys(s).forEach(k => {
    const v = s[k];
    if (typeof v === 'string') values.push(v);
    else if (Array.isArray(v)) v.forEach(x => values.push(String(x)));
  }));
  return values.every(v => !DOM_ACCESS_RE.test(v));
})(), 'onboarding 值里出现 DOM 访问');

/* onboarding 条目不得复制 provider 核心协议配置 */
const PROTOCOL_FIELDS = ['endpoint', 'format', 'model', 'vision', 'streaming'];
const onboardingLeak = [];
for (const id of Object.keys(canon.OFFICIAL_ONBOARDING)) {
  const e = canon.OFFICIAL_ONBOARDING[id];
  for (const f of PROTOCOL_FIELDS) if (Object.prototype.hasOwnProperty.call(e, f)) onboardingLeak.push(id + '.' + f);
  if (!canon.PROVIDERS[id]) onboardingLeak.push(id + ':not-in-canonical-providers');
}
check('官方 onboarding 条目只挂在 canonical provider 上，且不含协议配置字段', onboardingLeak.length === 0, onboardingLeak);

/* onboarding 条目不得内联 endpoint 字符串 */
const dirOnboardingBlock = dirText.slice(dirText.indexOf('OFFICIAL_ONBOARDING'), dirText.indexOf('THIRD_PARTY_SITES'));
check('onboarding 区块内不出现任何 provider endpoint 主机名', !/api\.[a-z0-9.-]+|dashscope|generativelanguage|open\.bigmodel/.test(dirOnboardingBlock.replace(/https:\/\/platform\.[a-z.]+|https:\/\/open\.bigmodel\.cn|https:\/\/bailian\.console\.aliyun\.com|https:\/\/console\.[a-z.]+|https:\/\/aistudio\.[a-z.]+|https:\/\/help\.aliyun\.com|https:\/\/api-docs\.[a-z.]+|https:\/\/docs\.[a-z.]+|https:\/\/ai\.google\.dev|https:\/\/www\.volcengine\.com/g, '')), 'onboarding 区块疑似复制了 provider 接口地址');

/* 模块不维护第二份 provider / URL 表 */
check('模块读取 window.PROVIDERS_DIR', /window\.PROVIDERS_DIR/.test(jsSrc));
check('模块不新建第二份 PROVIDERS 字面量', !/(?:var|const|let)\s+PROVIDERS\s*=\s*\{/.test(jsSrc));
check('模块不复制任何 provider endpoint', ['api.anthropic.com', 'api.openai.com', 'api.x.ai', 'api.deepseek.com',
  'generativelanguage.googleapis.com', 'open.bigmodel.cn', 'dashscope.aliyuncs.com', 'ark.cn-beijing.volces.com',
  'api.moonshot.cn', 'api.xiaomimimo.com', 'api.minimax.chat', 'api.lingyiwanwu.com', 'api.baichuan-ai.com',
  'api.mistral.ai'].every(e => jsSrc.indexOf(e) === -1));
/* P18：默认模型一律从目录派生——改默认值 / 新增 provider 时本守卫自动跟随，
   不再需要人工同步第二份清单（旧的硬编码清单在 P18 换默认值时已失效）。 */
const CANON_DEFAULT_MODELS = Object.keys(canon.PROVIDERS).map(id => canon.PROVIDERS[id].model).filter(Boolean);
check('模块不复制任何 provider 默认模型', CANON_DEFAULT_MODELS.every(m => jsSrc.indexOf(m) === -1),
  CANON_DEFAULT_MODELS.filter(m => jsSrc.indexOf(m) !== -1));
check('模块不复制任何官方平台 URL（URL 只在目录里）', (() => {
  const urls = [];
  for (const id of Object.keys(canon.OFFICIAL_ONBOARDING)) {
    const e = canon.OFFICIAL_ONBOARDING[id];
    [e.signupUrl, e.apiKeyUrl, e.docsUrl].forEach(u => { if (u) urls.push(u); });
  }
  for (const s of canon.THIRD_PARTY_SITES) [s.siteUrl, s.apiKeyUrl, s.docsUrl].forEach(u => { if (u) urls.push(u); });
  const hits = urls.filter(u => jsSrc.indexOf(u) !== -1);
  return hits.length === 0 && urls.length >= 20;
})(), '模块里出现了 onboarding URL');
check('模块不写存储 / 不碰 apiConfigs', !/dbPut|indexedDB|localStorage|sessionStorage|_persistApiConfig|createObjectStore/.test(jsSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
check('模块复用既有编辑链路（addNewApi + onProviderChange）', /window\.addNewApi/.test(jsSrc) && /window\.onProviderChange/.test(jsSrc));
check('模块不新增保存按钮 / 保存逻辑', !/saveCurrentApi/.test(jsSrc) || !/function\s+saveCurrentApi/.test(jsSrc));

/* ═══ D. 官方 / 第三方分组与风险说明 ══════════════════════════ */
section('官方 / 第三方分区（身份由 metadata 决定）');

const official = canon.officialList();
const third = canon.thirdPartyList();
check('官方卡片含任务要求的 8 家', ['deepseek', 'qwen', 'glm', 'minimax', 'moonshot', 'openai', 'anthropic', 'gemini']
  .every(p => official.indexOf(p) !== -1), official);
check('官方条目都指向真实 canonical provider', official.every(p => !!canon.PROVIDERS[p]), official.filter(p => !canon.PROVIDERS[p]));
check('第三方站点表非空且与官方严格分置', third.length >= 1 && third.every(s => official.indexOf(s) === -1), third);
check('第三方条目 kind 恒为 thirdparty', third.every(s => canon.thirdPartyEntry(s).kind === 'thirdparty'));
check('第三方条目的接入 provider 必须存在于 canonical 目录', third.every(s => !!canon.PROVIDERS[canon.thirdPartyEntry(s).provider]), third.map(s => s + ':' + canon.thirdPartyEntry(s).provider));
check('第三方站点不进入 PROVIDERS（不污染 Provider Core）', third.every(s => !canon.PROVIDERS[s]));
check('providerKind 只依据 metadata', canon.providerKind('deepseek') === 'official' && canon.providerKind('openrouter') === 'thirdparty' && canon.providerKind('example.com') === 'unknown');
check('第三方风险说明三条齐全', canon.THIRD_PARTY_RISK.length === 3
  && /模型、价格和可用性由第三方决定/.test(canon.THIRD_PARTY_RISK[0])
  && /API Key 和请求内容可能会经过第三方服务器/.test(canon.THIRD_PARTY_RISK[1])
  && /不为第三方余额、服务稳定性、安全性或数据处理方式背书/.test(canon.THIRD_PARTY_RISK[2]), canon.THIRD_PARTY_RISK);
check('「IB 已验证兼容」措辞不暗示官方 / 安全 / 可信背书', canon.TAG_LABELS.verified === 'IB 已验证兼容'
  && !/官方|安全|可信|推荐/.test(canon.TAG_LABELS.verified));
check('官方条目字段齐备（入口 / Key 页 / 地区 / 充值 / 适合谁 / 3–5 步）', official.every(p => {
  const e = canon.onboardingEntry(p);
  return !!e && !!e.signupUrl && !!e.apiKeyUrl && !!e.regionHint && !!e.billingHint && !!e.audience
    && Array.isArray(e.guideSteps) && e.guideSteps.length >= 3 && e.guideSteps.length <= 5;
}), official.filter(p => { const e = canon.onboardingEntry(p); return !e || !e.signupUrl || !e.apiKeyUrl || !e.regionHint || !e.billingHint || !e.audience || !e.guideSteps || e.guideSteps.length < 3 || e.guideSteps.length > 5; }));
check('所有 onboarding 外链都是 https', (() => {
  const urls = [];
  official.forEach(p => { const e = canon.onboardingEntry(p); [e.signupUrl, e.apiKeyUrl, e.docsUrl].forEach(u => { if (u) urls.push(u); }); });
  third.forEach(s => { const e = canon.onboardingEntry(s); [e.signupUrl, e.apiKeyUrl, e.docsUrl].forEach(u => { if (u) urls.push(u); }); });
  return urls.length >= 20 && urls.every(u => /^https:\/\//.test(u));
})(), '存在非 https 外链');
check('教程步骤是极简人话（每步 <= 60 字，不含长篇文档）', official.every(p => canon.onboardingEntry(p).guideSteps.every(s => s.length <= 60)));

/* ═══ E/F/G. 渲染与预填（最小 DOM shim） ══════════════════════ */
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, style: {}, dataset: {}, attributes: {},
    value: '', disabled: false, hidden: false, id: '', type: '', href: '', src: '', alt: '',
    className: '', loading: '', decoding: '', onclick: null, _text: '', _html: '',
    _classSet: null,
    _syncClass() { this.className = [...this._classSet].join(' '); },
    classList: {
      get _s() { if (!this._owner._classSet) this._owner._classSet = new Set(String(this._owner.className || '').split(/\s+/).filter(Boolean)); return this._owner._classSet; },
      add(c) { this._s.add(c); this._owner._syncClass(); },
      remove(c) { this._s.delete(c); this._owner._syncClass(); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; if (on) this._s.add(c); else this._s.delete(c); this._owner._syncClass(); return on; }
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'href') this.href = String(v); },
    getAttribute(k) { this._reflect(); return this.attributes[k]; },
    /* 真实 DOM 的属性/特性反射：模块用 a.href / a.rel / a.target 赋值，测试按特性读取 */
    _reflect() {
      if (this.id) this.attributes.id = this.id;
      if (this.href) this.attributes.href = this.href;
      if (this.rel) this.attributes.rel = this.rel;
      if (this.target) this.attributes.target = this.target;
      if (this.src) this.attributes.src = this.src;
    },
    addEventListener(type, fn) { (this._ev = this._ev || {})[type] = fn; },
    removeEventListener() { },
    scrollIntoView() { }, focus() { this._focused = true; },
    click() {
      if (this._ev && typeof this._ev.click === 'function') this._ev.click({ preventDefault() { }, target: this });
      else if (typeof this.onclick === 'function') this.onclick({ target: this });
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; }
  };
  node.classList._owner = node;
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
  if (typeof node._reflect === 'function') node._reflect();
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}
const hasClass = (n, c) => String(n.className || '').split(/\s+/).indexOf(c) !== -1;

/* 既有 API 编辑器 / 页面结构（真实 id 子集，够预填链路跑通） */
const EDITOR_FIELDS = ['api-ai-name', 'api-key', 'api-model', 'api-endpoint', 'api-provider',
  'api-vision-toggle', 'api-streaming-toggle', 'api-thinking-toggle'];
const PROVIDER_SELECT_IDS = ['anthropic', 'openai', 'grok', 'deepseek', 'gemini', 'glm', 'qwen', 'doubao',
  'moonshot', 'mimo', 'minimax', 'yi', 'baichuan', 'mistral', 'custom'];

function buildEnv(opts) {
  opts = opts || {};
  const doc = {
    readyState: 'complete', head: makeEl('head'), body: makeEl('body'),
    createElement: makeEl,
    getElementById(id) { return findById(this.body, id) || findById(this.head, id); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() { }, removeEventListener() { }
  };
  const entry = makeEl('div'); entry.id = 'api-onboarding-entry'; doc.body.appendChild(entry);
  const apiPage = makeEl('div'); apiPage.id = 'page-api'; apiPage.classList.add('active'); doc.body.appendChild(apiPage);
  for (const p of ['chat', 'guide', 'diagnostics']) { const e = makeEl('div'); e.id = 'page-' + p; doc.body.appendChild(e); }

  const editor = makeEl('div'); editor.id = 'api-editor'; editor.style.display = 'none'; doc.body.appendChild(editor);
  const keyHelp = makeEl('span'); keyHelp.id = 'ibo-key-help'; doc.body.appendChild(keyHelp);
  const compatHint = makeEl('div'); compatHint.id = 'ibo-compatible-hint'; doc.body.appendChild(compatHint);
  const guidedHint = makeEl('div'); guidedHint.id = 'ibo-guided-hint'; doc.body.appendChild(guidedHint);
  const fields = {};
  for (const id of EDITOR_FIELDS) {
    const n = makeEl('input'); n.id = id; fields[id] = n; doc.body.appendChild(n);
  }
  /* provider 下拉：真实 option 集合（与 InternalBeyond.html 一致） */
  const sel = fields['api-provider'];
  for (const pid of PROVIDER_SELECT_IDS) { const o = makeEl('option'); o.value = pid; sel.appendChild(o); }
  /* 其余非字段元素（编辑器容器等） */
  const title = makeEl('h3'); title.id = 'api-editor-title'; doc.body.appendChild(title);

  /* 被测模块的依赖：既有的 addNewApi / onProviderChange（这里用等价的最小实现，
     它们与 social.js 的行为一致：从 canonical 目录取 endpoint / model / 能力） */
  const calls = { addNewApi: 0, onProviderChange: [], navTo: [], toast: [], confirm: 0, confirmAnswer: opts.confirmAnswer !== false };
  const PROVIDERS = canon.PROVIDERS;
  function addNewApi() {
    calls.addNewApi++;
    fields['api-ai-name'].value = ''; fields['api-key'].value = '';
    fields['api-provider'].value = 'anthropic';
    editor.style.display = 'block';
    onProviderChange();
  }
  function onProviderChange() {
    const p = fields['api-provider'].value;
    calls.onProviderChange.push(p);
    const cfg = PROVIDERS[p];
    if (!cfg) return;
    fields['api-endpoint'].value = cfg.endpoint;
    fields['api-endpoint'].dataset.ibAutoFilled = '1';
    fields['api-model'].value = cfg.model;
    fields['api-model'].dataset.ibAutoFilled = '1';
    fields['api-vision-toggle'].checked = !!cfg.vision;
    fields['api-streaming-toggle'].checked = !!cfg.streaming;
    if (box.IBOnboarding && typeof box.IBOnboarding.renderKeyHelp === 'function') box.IBOnboarding.renderKeyHelp(p);
  }

  const box = {
    console: { log() { }, warn() { }, error() { } },
    setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, JSON, Date, Error, RegExp, Set, Map,
    document: doc,
    PROVIDERS_DIR: canon,
    addNewApi, onProviderChange,
    navTo(p) { calls.navTo.push(String(p)); },
    toast(m) { calls.toast.push(String(m)); },
    confirm() { calls.confirm++; return calls.confirmAnswer; }
  };
  box.window = box;
  vm.createContext(box);
  let loadError = null;
  try { new vm.Script(jsSrc, { filename: 'api-onboarding.js' }).runInContext(box); } catch (e) { loadError = e; }
  return { doc, box, entry, editor, fields, keyHelp, compatHint, guidedHint, calls, loadError, apiPage };
}

section('入口分流（#page-api 顶部）');
const env = buildEnv();
check('模块加载无异常', !env.loadError, env.loadError && String(env.loadError.message));
check('暴露 window.IBOnboarding', !!env.box.IBOnboarding);
check('渲染进 #api-onboarding-entry', env.entry.children.length > 0);
check('运行时注入了样式表', !!findById(env.doc.head, 'ib-onboarding-style'));
const entryCards = findAll(env.entry, n => hasClass(n, 'ibo-entry-card'));
check('入口有三张卡片', entryCards.length === 3, entryCards.length);
const entryText = allText(env.entry);
check('入口文案覆盖三种分流', /我还没有 API Key/.test(entryText) && /我已经有 API Key/.test(entryText) && /导入 OpenAI Compatible API/.test(entryText), entryText.slice(0, 200));
check('「我还没有 API」是主按钮（btn-primary）', (() => {
  const b = findAll(env.entry, n => hasClass(n, 'ibo-entry-btn'))[0];
  return !!b && hasClass(b, 'btn-primary') && b.textContent === '带我获取';
})());
check('入口不出现协议术语（Base URL / wire format / endpoint）', !/Base URL|wire format|endpoint|Endpoint/.test(entryText), entryText);

section('获取向导：官方 / 第三方分组');
const entryBtns = findAll(env.entry, n => hasClass(n, 'ibo-entry-btn'));
entryBtns[0].click();
const ov = findById(env.doc.body, 'ib-onboarding');
check('点「带我获取」打开获取向导', !!ov && ov.classList.contains('is-open'));
check('向导是 dialog 且带 aria-modal', ov.getAttribute('role') === 'dialog' && ov.getAttribute('aria-modal') === 'true');
const secs = findAll(ov, n => hasClass(n, 'ibo-sec'));
check('向导分成官方 / 第三方两区', secs.length === 2 && secs[0].id === 'ibo-sec-official' && secs[1].id === 'ibo-sec-third', secs.map(s => s.id));
const offCards = findAll(secs[0], n => hasClass(n, 'ibo-card-item'));
const thirdCards = findAll(secs[1], n => hasClass(n, 'ibo-card-item'));
check('官方区渲染出全部官方卡片', offCards.length === official.length, offCards.length + '/' + official.length);
check('第三方区渲染出全部第三方卡片', thirdCards.length === third.length, thirdCards.length + '/' + third.length);
check('官方卡片带 data-kind=official / data-provider', offCards.every(c => c.getAttribute('data-kind') === 'official' && !!c.getAttribute('data-provider')));
check('第三方卡片带 data-kind=thirdparty 且显示「第三方」标签', thirdCards.every(c => c.getAttribute('data-kind') === 'thirdparty'
  && allText(c).indexOf('第三方聚合 / 中转服务，并非模型官方运营。') !== -1));
check('第三方区显示统一风险说明三条', (() => {
  const t = allText(secs[1]);
  return canon.THIRD_PARTY_RISK.every(l => t.indexOf(l) !== -1);
})());
check('官方区不出现第三方风险说明', allText(secs[0]).indexOf('并非模型官方运营') === -1);
check('第三方卡片带状态标签（OpenAI Compatible / 未验证）', (() => {
  const t = allText(thirdCards[0]);
  return /OpenAI Compatible/.test(t) && /未验证/.test(t);
})());
check('每张卡片都有「打开官网」与「配置到 IB」两个动作', offCards.every(c => {
  const acts = findAll(c, n => n.tagName === 'A' || n.tagName === 'BUTTON');
  return acts.some(a => /打开官网/.test(a.textContent)) && acts.some(a => a.textContent === '配置到 IB');
}));
check('卡片显示人话说明（地区 / 充值 / 适合谁）', (() => {
  const t = allText(offCards[0]);
  return /国内通常可直接访问|可能受地区或网络环境影响/.test(t) && /充值|免费额度/.test(t);
})());
check('教程是 3–5 步折叠块（不是长篇文档）', (() => {
  const det = findAll(offCards[0], n => n.tagName === 'DETAILS');
  if (!det.length) return false;
  const steps = findAll(det[0], n => n.tagName === 'LI');
  return steps.length >= 3 && steps.length <= 5;
})());

section('metadata 缺失时 graceful fallback');
const savedGemini = canon.OFFICIAL_ONBOARDING.gemini;
/* 就地清空（保持同一个数组引用：被测模块持有的是这个引用，不是副本） */
const savedThirdEntries = canon.THIRD_PARTY_SITES.splice(0, canon.THIRD_PARTY_SITES.length);
try {
  /* 抽掉一家官方 metadata */
  delete canon.OFFICIAL_ONBOARDING.gemini;
  const env2 = buildEnv();
  findAll(env2.entry, n => hasClass(n, 'ibo-entry-btn'))[0].click();
  const ov2 = findById(env2.doc.body, 'ib-onboarding');
  const cards2 = findAll(ov2, n => hasClass(n, 'ibo-card-item'));
  check('metadata 缺失时服务仍然在列表里（目录才是 canonical 名单）', cards2.some(c => c.getAttribute('data-provider') === 'gemini'), cards2.map(c => c.getAttribute('data-provider')));
  check('缺 metadata 的卡片给出兜底说明而不是空白', (() => {
    const g = cards2.filter(c => c.getAttribute('data-provider') === 'gemini')[0];
    return !!g && /官方入口待补充/.test(allText(g)) && /配置到 IB/.test(allText(g));
  })());
  check('缺 metadata 时预填链路仍然可用', (() => {
    env2.box.IBOnboarding.configure('gemini');
    return env2.fields['api-provider'].value === 'gemini' && env2.fields['api-endpoint'].value === canon.PROVIDERS.gemini.endpoint;
  })(), env2.fields['api-endpoint'].value);
  check('第三方表为空时不报错且分区仍在', !!findById(env2.doc.body, 'ibo-sec-third'));
} finally {
  canon.OFFICIAL_ONBOARDING.gemini = savedGemini;
  for (const e of savedThirdEntries) canon.THIRD_PARTY_SITES.push(e);
}
check('恢复后官方列表完整（不含 custom）', canon.officialList().length === Object.keys(canon.PROVIDERS).length - 1 && canon.officialList().indexOf('custom') === -1, canon.officialList());

section('预填链路（provider → endpoint / model / 能力）');
const env3 = buildEnv();
env3.box.IBOnboarding.configure('deepseek');
check('「配置到 IB」调用了既有 addNewApi（不新建保存链）', env3.calls.addNewApi === 1, env3.calls.addNewApi);
check('provider 选中 deepseek', env3.fields['api-provider'].value === 'deepseek', env3.fields['api-provider'].value);
check('endpoint 预填为 canonical 目录值', env3.fields['api-endpoint'].value === canon.PROVIDERS.deepseek.endpoint, env3.fields['api-endpoint'].value);
check('model 预填为 canonical 目录值', env3.fields['api-model'].value === canon.PROVIDERS.deepseek.model, env3.fields['api-model'].value);
check('能力开关按目录设定', env3.fields['api-vision-toggle'].checked === !!canon.PROVIDERS.deepseek.vision
  && env3.fields['api-streaming-toggle'].checked === !!canon.PROVIDERS.deepseek.streaming);
check('预填字段被标记为「自动填入」', env3.fields['api-endpoint'].dataset.ibAutoFilled === '1' && env3.fields['api-model'].dataset.ibAutoFilled === '1');
check('API Key 输入框保持为空（绝不预填 / 生成 Key）', env3.fields['api-key'].value === '');
check('光标落在 Key 输入框', env3.fields['api-key']._focused === true);
check('新手模式收起协议字段', hasClass(env3.editor, 'ibo-guided'));
check('新手模式给出人话提示', !!findById(env3.doc.body, 'ibo-guided-hint') && /接口地址已经帮你填好/.test(allText(findById(env3.doc.body, 'ibo-guided-hint'))));
check('Key 获取提示链接已渲染', env3.keyHelp.children.length === 1 && env3.keyHelp.children[0].href === canon.onboardingEntry('deepseek').apiKeyUrl);
check('「Key 在哪里获取？」外链安全属性', (() => {
  const a = env3.keyHelp.children[0];
  return a.target === '_blank' && /noopener/.test(a.getAttribute('rel')) && /noreferrer/.test(a.getAttribute('rel'));
})());
check('切换官方 provider 会刷新 Key 获取链接', (() => {
  env3.fields['api-provider'].value = 'openai';
  env3.box.onProviderChange();
  return env3.keyHelp.children[0].href === canon.onboardingEntry('openai').apiKeyUrl;
})());

section('不覆盖用户已经手工编辑的配置');
const env4 = buildEnv();
/* 用户先手动改了 endpoint（去掉自动标记） */
env4.fields['api-endpoint'].value = 'https://my-relay.example.com/v1/chat/completions';
env4.fields['api-endpoint'].dataset.ibAutoFilled = '';
env4.fields['api-model'].value = 'my-model';
env4.fields['api-model'].dataset.ibAutoFilled = '';
env4.box.IBOnboarding.configure('deepseek');
check('用户手改过的 endpoint 不被覆盖', env4.fields['api-endpoint'].value === 'https://my-relay.example.com/v1/chat/completions', env4.fields['api-endpoint'].value);
check('用户手改过的 model 不被覆盖', env4.fields['api-model'].value === 'my-model', env4.fields['api-model'].value);
check('不覆盖时给出明确提示', env4.calls.toast.length === 1 && /没有覆盖/.test(env4.calls.toast[0]), env4.calls.toast);

/* 编辑器里已有正在编辑的内容 → 先确认，用户拒绝就什么都不动 */
const env5 = buildEnv({ confirmAnswer: false });
env5.box.addNewApi();
env5.fields['api-endpoint'].dataset.ibAutoFilled = '1';   /* 新建时目录自动填入，不算用户手改 */
env5.fields['api-model'].dataset.ibAutoFilled = '1';
env5.fields['api-ai-name'].value = '正在编辑的角色';
env5.box.IBOnboarding.configure('glm');
check('编辑器里已有内容时先询问用户', env5.calls.confirm === 1, env5.calls.confirm);
/* 拒绝后：不按推荐值预填（provider 仍是 addNewApi 的默认值，不是 glm），也不二次新建 */
check('用户拒绝后不预填、不新建', env5.fields['api-provider'].value !== 'glm' && env5.calls.addNewApi === 1, env5.fields['api-provider'].value);

/* 自动填过的字段可以再次预填（换服务时不会卡住） */
const env6 = buildEnv();
env6.box.IBOnboarding.configure('deepseek');
env6.box.IBOnboarding.configure('glm');
check('自动填入的字段可被再次预填', env6.fields['api-provider'].value === 'glm' && env6.fields['api-endpoint'].value === canon.PROVIDERS.glm.endpoint, env6.fields['api-endpoint'].value);

section('第三方 / 兼容导入路径');
const env7 = buildEnv();
findAll(env7.entry, n => hasClass(n, 'ibo-entry-btn'))[2].click();
check('「导入 OpenAI Compatible API」走 custom provider', env7.fields['api-provider'].value === 'custom', env7.fields['api-provider'].value);
check('兼容导入不进入新手模式（保留完整手动能力）', !hasClass(env7.editor, 'ibo-guided'));
check('兼容导入给出填写提示', allText(env7.compatHint).indexOf('完整路径') !== -1, allText(env7.compatHint));
check('兼容导入的接口地址留空（不猜第三方地址）', env7.fields['api-endpoint'].value === '', env7.fields['api-endpoint'].value);
const env8 = buildEnv();
env8.box.IBOnboarding.configure('custom-relay');
check('自建/别家中转卡片直接进手动填写（不绑定具体第三方）', env8.fields['api-provider'].value === 'custom' && env8.calls.addNewApi === 1);
const env8b = buildEnv();
env8b.box.IBOnboarding.configure('openrouter');
check('第三方卡片预填 custom provider + 保留完整手动能力', env8b.fields['api-provider'].value === 'custom' && !hasClass(env8b.editor, 'ibo-guided'));
check('第三方卡片不猜测接口地址（留给用户填）', env8b.fields['api-endpoint'].value === '' && !!env8b.fields['api-endpoint'].dataset.ibAutoFilled);

section('「我已经有 API Key」路径');
const env9 = buildEnv();
env9.box.IBOnboarding.openManualEditor();
check('直接打开编辑器并预选第一个官方服务', env9.calls.addNewApi === 1 && !!env9.fields['api-provider'].value, env9.fields['api-provider'].value);
check('自动填好接口地址与模型', !!env9.fields['api-endpoint'].value && !!env9.fields['api-model'].value);
check('Key 输入框为空', env9.fields['api-key'].value === '');
check('刷新了 Key 获取提示', env9.keyHelp.children.length === 1);

/* 从首次设置向导里进来的场景：预填前必须收起向导，否则用户看不到编辑器 */
const envW = buildEnv();
const setupOv = makeEl('div'); setupOv.id = 'ib-setup'; setupOv.classList.add('is-open'); envW.doc.body.appendChild(setupOv);
envW.box.IBOnboarding.configure('deepseek');
check('预填时收起仍打开的设置向导', !setupOv.classList.contains('is-open') && envW.fields['api-provider'].value === 'deepseek');

/* ═══ G. 链接安全 ═════════════════════════════════════════════ */
section('链接安全');
const envL = buildEnv();
const safe = envL.box.IBOnboarding.safeUrl;
check('只接受 https / http', safe('https://example.com/x') === 'https://example.com/x'
  && safe('http://example.com/x') === 'http://example.com/x'
  && safe('javascript:alert(1)') === '' && safe('data:text/html,x') === '' && safe('') === '');
check('URL 携带凭据参数时直接拒绝', safe('https://example.com/?api_key=abc') === ''
  && safe('https://example.com/?apikey=abc') === ''
  && safe('https://example.com/?token=abc') === ''
  && safe('https://example.com/?secret=abc') === ''
  && safe('https://example.com/?key=abc') === '', '凭据参数未被拒绝');
check('模块源码不读取 / 不生成 API Key', !/api-key['"]\s*\)\s*\.value|getElementById\('api-key'\)\.value/.test(jsSrc)
  && !/generateKey|randomKey|createApiKey/.test(jsSrc));
check('外链一律 target=_blank + rel=noopener noreferrer', /a\.target\s*=\s*'_blank'/.test(jsSrc) && /a\.rel\s*=\s*'noopener noreferrer'/.test(jsSrc));
check('模块不发任何网络请求', !/\bfetch\s*\(/.test(jsSrc) && !/XMLHttpRequest|navigator\.sendBeacon/.test(jsSrc));

/* 全站外链审计（HTML）：安全属性 + 不含凭据参数 */
const htmlLinks = [...html.matchAll(/<a\b[^>]*href="(https?:\/\/[^"]*)"[^>]*>/gi)];
check('HTML 外链都存在', htmlLinks.length >= 9, htmlLinks.length);
check('HTML 外链都带 rel=noopener noreferrer', htmlLinks.every(m => /rel="noopener noreferrer"/.test(m[0])), htmlLinks.filter(m => !/rel="noopener noreferrer"/.test(m[0])).map(m => m[1]));
check('HTML 外链不含凭据参数', htmlLinks.every(m => !/(?:[?&#])(?:api[-_]?key|apikey|key|token|secret|password|auth)=/i.test(m[1])), htmlLinks.map(m => m[1]).filter(u => /(?:[?&#])(?:api[-_]?key|apikey|key|token|secret|password|auth)=/i.test(u)));
check('HTML 外链都是 target=_blank', htmlLinks.every(m => /target="_blank"/.test(m[0])));

/* ═══ H. 回归 ═════════════════════════════════════════════════ */
section('回归：既有 API 编辑 / 保存链路');
const socialSrc = fs.readFileSync(SOCIAL_PATH, 'utf8').replace(/^\uFEFF/, '');
check('social.js 仍提供既有入口函数', ['addNewApi', 'editApi', 'saveCurrentApi', 'cancelApiEdit', 'onProviderChange']
  .every(fn => new RegExp('function\\s+' + fn + '\\s*\\(').test(socialSrc)), '既有函数缺失');
check('既有编辑器字段 id 全部保留', ['api-ai-name', 'api-key', 'api-provider', 'api-model', 'api-endpoint',
  'api-vision-toggle', 'api-streaming-toggle', 'api-thinking-toggle', 'api-imagegen-toggle', 'api-voice-toggle']
  .every(id => html.indexOf('id="' + id + '"') !== -1), '字段 id 被改动');
check('保存路径仍然只走 _persistApiConfig', /_persistApiConfig\(cfg\)/.test(socialSrc) && !/dbPut\(\s*['"]apiConfigs['"]\s*,\s*cfg/.test(socialSrc));
check('onProviderChange 仍从 canonical PROVIDERS 取 endpoint / model', /document\.getElementById\('api-endpoint'\)\.value=cfg\.endpoint/.test(socialSrc)
  && /document\.getElementById\('api-model'\)\.value=cfg\.model/.test(socialSrc));
check('onProviderChange 只新增来源标记，不改填值行为', /_ibMarkAutoFilled\('api-endpoint',!!cfg\.endpoint\)/.test(socialSrc)
  && /_ibMarkAutoFilled\('api-model',!!cfg\.model\)/.test(socialSrc));
check('编辑既有配置时不把用户数据标记为自动填入', /_ibMarkAutoFilled\('api-endpoint',false\)/.test(socialSrc)
  && /_ibMarkAutoFilled\('api-model',false\)/.test(socialSrc));
check('social.js 仍是唯一 provider 目录消费者（未新增第二份表）', !/(?:var|const)\s+PROVIDERS\s*=\s*\{\s*[a-z]+:\s*\{\s*name:/.test(socialSrc));
/* P17：HTML 只保留最小 fallback（兼容模式），完整服务商列表由目录驱动构建。 */
check('provider 下拉改由目录驱动（HTML 仅留最小 fallback）', (() => {
  const sel = (html.match(/<select id="api-provider"[\s\S]*?<\/select>/) || [''])[0];
  const vals = [...sel.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  return vals.length <= 1 && (vals.length === 0 || vals[0] === 'custom');
})(), (html.match(/<select id="api-provider"[\s\S]*?<\/select>/) || [''])[0].length);
check('P17：模块不再维护第二份 provider 顺序 / 说明表', !/OFFICIAL_ORDER/.test(jsSrc) && !/PROVIDER_HINT/.test(jsSrc)
  && /onboardingProviderList|officialList/.test(jsSrc));
check('P17：官方卡片取数委托目录（providerHint / onboardingProviderList）',
  /d\.providerHint\(/.test(jsSrc) && /onboardingProviderList/.test(jsSrc));

section('移动端布局可用');
check('有窄屏断点（1040 / 860 / 640）', /@media \(max-width: 1040px\)/.test(cssSrc) && /@media \(max-width: 860px\)/.test(cssSrc) && /@media \(max-width: 640px\)/.test(cssSrc));
check('窄屏下卡片改单列', /@media \(max-width: 860px\)[\s\S]*?\.ibo-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(cssSrc)
  && /@media \(max-width: 640px\)[\s\S]*?\.ibo-entry-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(cssSrc));
check('弹层卡片宽度自适应且有最大高度', /\.ibo-card \{[\s\S]*?width: min\(760px, 100%\)/.test(cssSrc) && /max-height: min\(92vh, 880px\)/.test(cssSrc));
check('按钮 / 卡片允许换行不溢出', /\.ibo-card-acts \{ display: flex; flex-wrap: wrap;/.test(cssSrc) && /\.ibo-tags \{ display: flex; flex-wrap: wrap;/.test(cssSrc));
check('触控目标不过小（按钮字号 >= 0.76rem）', /\.ibo-card-acts \.btn \{ font-size: 0\.78rem/.test(cssSrc));

console.log('\n结果: ' + passed + ' 通过, ' + failures + ' 失败');
process.exitCode = failures ? 1 : 0;
