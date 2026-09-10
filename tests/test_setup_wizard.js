'use strict';
/* Internal Beyond — P4 首次设置向导（First-Run Setup Wizard）契约测试
   运行：node test_setup_wizard.js      （零网络、零浏览器）

   覆盖两类断言：
     A. 静态契约 —— 文件/编码/HTML 挂载/单一数据源/无第二套保存链/无密钥外泄面
     B. 纯逻辑契约 —— 首启判定矩阵、步骤校验、草稿载荷（不含密钥）、状态读写容错
   DOM 用最小 shim 提供，只为让模块能在 Node 里加载；逻辑断言直接打 __test 钩子。 */

const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');

const JS_PATH = path.join(ROOT, 'assets', 'js', 'setup-wizard.js');
const CSS_PATH = path.join(ROOT, 'assets', 'css', 'setup-wizard.css');
const HTML_PATH = path.join(ROOT, 'InternalBeyond.html');

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

const jsBuf = fs.readFileSync(JS_PATH);
const jsSrc = jsBuf.toString('utf8').replace(/^\uFEFF/, '');
const cssBuf = fs.readFileSync(CSS_PATH);
const html = fs.readFileSync(HTML_PATH, 'utf8');

/* ═══ A. 静态契约 ═══════════════════════════════════════════ */
section('文件与编码（与 test_frontend_structure 同一规则）');
check('setup-wizard.js 存在', fs.existsSync(JS_PATH));
check('setup-wizard.css 存在', fs.existsSync(CSS_PATH));
check('js 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(jsBuf); return true; } catch (e) { return false; } })());
check('css 是合法 UTF-8', (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(cssBuf); return true; } catch (e) { return false; } })());
check('js 带 UTF-8 BOM', jsBuf[0] === 0xef && jsBuf[1] === 0xbb && jsBuf[2] === 0xbf);
check('css 带 UTF-8 BOM', cssBuf[0] === 0xef && cssBuf[1] === 0xbb && cssBuf[2] === 0xbf);
const cssSrc = cssBuf.toString('utf8').replace(/^\uFEFF/, '');
check('无乱码特征', !/\uFFFD|锟斤拷|Ã.|Â.|â(?:€|™|œ|“|”)/.test(jsSrc + cssSrc));
check('js 语法可解析', (() => { try { new vm.Script(jsSrc, { filename: 'setup-wizard.js' }); return true; } catch (e) { return false; } })());

section('HTML 挂载（最小改动，不动内联样式预算）');
const scriptTags = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
const styleTags = [...html.matchAll(/<link[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
check('HTML 只挂载一次 setup-wizard.js', scriptTags.filter(s => s === 'assets/js/setup-wizard.js').length === 1);
check('HTML 没有新增样式表（样式由模块运行时注入）', styleTags.length === 20, styleTags.length);
check('HTML 没有 setup-wizard.css 的 <link>', !styleTags.includes('assets/css/setup-wizard.css'));
check('HTML 无 <style> 块', !/<style\b/i.test(html));
check('HTML 无内联 <script>', [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim()).length === 0);
check('HTML 静态内联样式预算未变（<=200）', (html.match(/\bstyle\s*=/gi) || []).length <= 200, (html.match(/\bstyle\s*=/gi) || []).length);
check('新模块不新增 style= 属性', (jsSrc.match(/\bstyle\s*=/gi) || []).length === 0);
check('模块运行时注入样式表', /STYLE_HREF\s*=\s*'assets\/css\/setup-wizard\.css'/.test(jsSrc) && /rel\s*=\s*'stylesheet'/.test(jsSrc));

section('单一数据源（provider-directory.js）');
check('读取 window.PROVIDERS_DIR.PROVIDERS', /window\.PROVIDERS_DIR\s*&&\s*window\.PROVIDERS_DIR\.PROVIDERS/.test(jsSrc));
check('不新建第二份 PROVIDERS 字面量', !/var\s+PROVIDERS\s*=\s*\{/.test(jsSrc) && !/const\s+PROVIDERS\s*=\s*\{/.test(jsSrc));
const endpoints = [
  'api.anthropic.com', 'api.openai.com', 'api.x.ai', 'api.deepseek.com',
  'generativelanguage.googleapis.com', 'open.bigmodel.cn', 'dashscope.aliyuncs.com',
  'ark.cn-beijing.volces.com', 'api.moonshot.cn', 'api.xiaomimimo.com',
  'api.minimax.chat', 'api.lingyiwanwu.com', 'api.baichuan-ai.com', 'api.mistral.ai'
];
check('不复制任何 provider endpoint', endpoints.every(e => jsSrc.indexOf(e) === -1), endpoints.filter(e => jsSrc.indexOf(e) !== -1));
/* P18：默认模型从目录派生，不再硬编码（换默认值 / 新增 provider 自动跟随）。 */
const canonDir = require(path.join(ROOT, 'assets', 'js', 'provider-directory.js'));
const models = Object.keys(canonDir.PROVIDERS).map(id => canonDir.PROVIDERS[id].model).filter(Boolean);
check('不复制任何 provider 默认模型', models.every(m => jsSrc.indexOf(m) === -1), models.filter(m => jsSrc.indexOf(m) !== -1));

section('不新建第二套保存链 / 角色表');
check('复用 addNewApi + saveCurrentApi', /window\.addNewApi/.test(jsSrc) && /window\.saveCurrentApi/.test(jsSrc));
check('不直接写 apiConfigs 存储', !/dbPut\s*\(\s*['"]apiConfigs['"]/.test(jsSrc));
check('不绕过编辑器直接调用 _persistApiConfig', jsSrc.indexOf('_persistApiConfig') === -1);
check('不新增角色相关 store', !/objectStore|createObjectStore/.test(jsSrc));
check('不升 DB_VER（core.js 仍为 23）', /DB_VER=23/.test(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'core.js'), 'utf8')));
check('向导状态只用 apiSettings 两个私有 key', /DONE_KEY\s*=\s*'ibSetupV1Done'/.test(jsSrc) && /DRAFT_KEY\s*=\s*'ibSetupV1Draft'/.test(jsSrc));
check('不使用 localStorage / sessionStorage', jsSrc.indexOf('localStorage') === -1 && jsSrc.indexOf('sessionStorage') === -1);

section('P3 错误契约（不新写错误字符串）');
check('使用 IBERR.present', /IBERR\.present/.test(jsSrc));
check('使用 IBERR.model（本地服务降级提示）', /IBERR\.model/.test(jsSrc));
check('使用 IBERR.detailsText 渲染「查看详情」', /IBERR\.detailsText/.test(jsSrc));
check('不把原始错误 message 拼进界面', !/\b(e|err|error|ex)\.message\b/.test(jsSrc));
check('测试连接走现有 callApiChat 链', /window\.callApiChat\s*\(/.test(jsSrc));
check('不自建 fetch 请求（仅读启动状态）', (jsSrc.match(/fetch\s*\(/g) || []).length === 1);

section('密钥安全面');
check('console 调用不出现 apiKey', jsSrc.split('\n').filter(l => /console\./.test(l)).every(l => l.indexOf('apiKey') === -1));
check('草稿载荷函数不含 apiKey 字段', !/draftPayload[\s\S]{0,900}?apiKey/.test(jsSrc.slice(jsSrc.indexOf('function draftPayload'), jsSrc.indexOf('function decide'))));
check('密钥输入为 password 且可切换显示', /input\.type\s*=\s*'password'/.test(jsSrc) && /input\.type\s*=\s*show\s*\?\s*'text'\s*:\s*'password'/.test(jsSrc));

section('首启文案（普通用户可读）');
const literals = [...jsSrc.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)]
  .map(m => (m[1] !== undefined ? m[1] : m[2]))
  .filter(s => s && !/^[a-z0-9_./-]+$/i.test(s)); /* 丢掉纯标识符/路径 */
const FORBIDDEN = ['Node.js', 'Bridge', '端口', 'localhost', 'IndexedDB', 'WebSocket', 'ws://', '127.0.0.1', 'Bearer'];
const dirty = [];
literals.forEach(s => FORBIDDEN.forEach(w => { if (s.indexOf(w) !== -1) dirty.push(w + ' @ ' + s.slice(0, 40)); }));
check('用户可见文案不含开发者术语', dirty.length === 0, dirty);
check('第 1 步文案 = 「几分钟完成第一次设置，不需要编程知识。」', literals.includes('几分钟完成第一次设置，不需要编程知识。'));

/* ═══ 模块加载（最小 DOM shim） ═══════════════════════════ */
function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attributes: {},
    value: '',
    files: null,
    disabled: false,
    scrollTop: 0,
    id: '',
    type: '',
    placeholder: '',
    _text: '',
    _html: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !this._s.has(c) : !!force;
        if (on) this._s.add(c); else this._s.delete(c);
        return on;
      }
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener() {},
    removeEventListener() {},
    focus() { doc.activeElement = this; },
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
const doc = {
  readyState: 'complete',
  activeElement: null,
  head: makeEl('head'),
  body: makeEl('body'),
  createElement: makeEl,
  getElementById(id) { return findById(this.body, id) || findById(this.head, id); },
  addEventListener() {},
  removeEventListener() {}
};

const store = new Map();          /* apiSettings 内存替身 */
let dbBroken = false;
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, JSON, Date, Error, RegExp, Set, Map,
  document: doc,
  fetch: () => Promise.reject(new Error('offline in test')),
  dbGet: async (s, k) => { if (dbBroken) throw new Error('db down'); return store.get(k) || null; },
  dbPut: async (s, v) => { if (dbBroken) throw new Error('db down'); store.set(v.id, v); },
  dbDelete: async (s, k) => { store.delete(k); },
  loadApiConfigs: async () => {},
  apiConfigs: [],
  getDefaultPromptForTheme: () => '你是 InternalBeyond 中的角色。',
  PROVIDERS_DIR: {
    PROVIDERS: {
      openai: { name: 'GPT', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', format: 'openai', vision: true, streaming: true },
      anthropic: { name: 'Claude', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6', format: 'anthropic', vision: true, streaming: true },
      custom: { name: 'Custom', endpoint: '', model: '', format: 'openai', vision: true, streaming: true }
    }
  },
  IBERR: {
    present: () => ({ code: 'IBERR.AUTH.401', title: 'T', message: 'M', suggestion: 'S', technicalDetails: {} }),
    model: () => ({ code: 'IBERR.LOCAL_SERVICE.BRIDGE', title: '本地增强暂时不可用', message: '不影响聊天。', suggestion: '', technicalDetails: {} }),
    detailsText: () => 'detail'
  }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
/* 与生产一致的最小 IB 命名空间（ib-namespace.js 的 expose 语义） */
sandbox.IB = { expose(name, obj) { this[name] = obj; return obj; } };
vm.createContext(sandbox);
vm.runInContext(jsSrc, sandbox, { filename: 'setup-wizard.js' });

const IBSetup = sandbox.window.IBSetup;
const T = IBSetup && IBSetup.__test;

section('模块导出');
check('window.IBSetup 已挂载', !!IBSetup && typeof IBSetup.open === 'function');
check('IB.setup 命名空间已注册', !!(sandbox.window.IB && sandbox.window.IB.setup === IBSetup));
check('__test 钩子可用', !!T);
if (!T) {
  console.log('\nsetup-wizard test failed: 模块未正确导出 __test');
  process.exit(1);
}

section('步骤结构（7 步，含全部要求步骤）');
check('共 7 步', T.STEPS.length === 7 && T.TOTAL_STEPS === 7, T.STEPS.map(s => s.id));
check('步骤顺序 = 欢迎/选服务/密钥/模型/测试/角色/完成',
  JSON.stringify(T.STEPS.map(s => s.id)) === JSON.stringify(['welcome', 'provider', 'key', 'model', 'test', 'role', 'done']),
  T.STEPS.map(s => s.id));

section('首启判定矩阵');
check('无记录 + 无角色 → 自动进入（首次）', T.decide({ done: false }, null, 0).open === true && T.decide({ done: false }, null, 0).reason === 'first-run');
check('无记录 + 有角色 → 不打扰（老用户升级）', T.decide({ done: false }, null, 2).open === false && T.decide({ done: false }, null, 2).reason === 'existing-user');
check('已完成 → 不重复出现', T.decide({ done: true, skipped: false }, null, 0).open === false);
check('已跳过 → 不强制再次弹出', T.decide({ done: true, skipped: true }, null, 0).open === false && T.decide({ done: true, skipped: true }, null, 0).reason === 'skipped');
check('有草稿 + 未完成 → 继续（resume）', T.decide({ done: false }, { step: 3 }, 0).open === true && T.decide({ done: false }, { step: 3 }, 0).reason === 'resume');
check('状态损坏（done 非布尔）→ 按未完成处理', T.decide({ done: 'yes' }, null, 0).open === true);
check('状态读取失败 → 不打开（不阻塞主界面）', T.decide({ done: false, unreadable: true }, null, 0).open === false);

section('草稿载荷（密钥绝不落盘）');
T.setState({ provider: 'openai', apiKey: 'sk-SECRET-123', model: 'm', endpoint: 'https://e', nickname: '小雾', step: 3, systemPrompt: 'sys', promptDirty: true });
const payload = T.draftPayload(IBSetup.state());
check('草稿不含 apiKey 字段', !Object.prototype.hasOwnProperty.call(payload, 'apiKey'), Object.keys(payload));
check('草稿 JSON 里找不到密钥值', JSON.stringify(payload).indexOf('sk-SECRET-123') === -1);
check('草稿不含头像 dataURL', !Object.prototype.hasOwnProperty.call(payload, 'avatar'));
check('草稿保留非敏感进度', payload.provider === 'openai' && payload.nickname === '小雾' && payload.step === 3);
check('草稿 step 被夹紧在 0..6', T.draftPayload({ step: 99 }).step === 6 && T.draftPayload({ step: -5 }).step === 0);

section('applyDraft（resume 不回填密钥）');
const restored = T.applyDraft(Object.assign({}, payload, { apiKey: 'should-be-ignored' }));
check('恢复 provider/昵称/步骤', restored.provider === 'openai' && restored.nickname === '小雾' && restored.step === 3);
check('恢复后 apiKey 仍为空', restored.apiKey === '', restored.apiKey);
check('标记 draftRestored', restored.draftRestored === true);

section('步骤校验（就地报错，不清空已填内容）');
check('未选服务 → 报错', !!T.validateStep('provider', {}, []));
check('已选服务 → 通过', T.validateStep('provider', { provider: 'openai' }, []) === null);
check('无密钥且非本机 → 报错', !!T.validateStep('key', { apiKey: '' }, []));
check('有密钥 → 通过', T.validateStep('key', { apiKey: 'sk-x' }, []) === null);
check('选择本机模型 → 免密钥通过', T.validateStep('key', { apiKey: '', noKey: true }, []) === null);
check('模型为空 → 报错', !!T.validateStep('model', { model: '' }, []));
check('接口地址为空 → 报错', !!T.validateStep('model', { model: 'm', endpoint: '' }, []));
check('模型+地址齐备 → 通过', T.validateStep('model', { model: 'm', endpoint: 'https://e' }, []) === null);
check('角色名为空 → 报错', !!T.validateStep('role', { nickname: '' }, []));
check('角色名超长 → 报错', !!T.validateStep('role', { nickname: 'x'.repeat(17) }, []));
check('角色名重复 → 报错', !!T.validateStep('role', { nickname: '小雾' }, [{ id: 'a', nickname: '小雾' }]));
check('角色名唯一 → 通过', T.validateStep('role', { nickname: '小雾' }, [{ id: 'a', nickname: '别人' }]) === null);
check('重名判定覆盖空昵称回落到模型名', T.roleNameTaken('gpt-4o-mini', [{ id: 'a', model: 'gpt-4o-mini' }]) === true);

section('测试连接配置（走现有链路，不落盘）');
const tcfg = T.testConfig({ provider: 'openai', apiKey: 'sk-x', model: 'm', endpoint: 'https://e' });
check('配置 id 使用保留测试 id', tcfg.id === T.TEST_CFG_ID);
check('只含必要字段（无 messages/prompt 等请求体）', !('messages' in tcfg) && !('prompt' in tcfg) && !('systemPrompt' in tcfg), Object.keys(tcfg));
check('关闭 streaming/promptCache（最小请求）', tcfg.streaming === false && tcfg.promptCache === false);
check('保留用户填写值', tcfg.provider === 'openai' && tcfg.model === 'm' && tcfg.endpoint === 'https://e' && tcfg.apiKey === 'sk-x');

section('角色描述 → 系统提示词');
check('描述追加在默认设定之后', T.composePrompt('BASE', '描述') === 'BASE\n\n描述');
check('只有描述时直接使用描述', T.composePrompt('', '描述') === '描述');
check('都为空 → 空（不写系统提示词）', T.composePrompt('', '') === '');

section('状态读写（IndexedDB apiSettings）');
(async () => {
  await T.writeDone(true);
  const rec = await T.readSetupRecord();
  check('跳过写入 done:true + skipped:true', rec.done === true && rec.skipped === true, rec);

  T.setState({ apiKey: 'sk-SECRET-123', nickname: '小雾', step: 2, provider: 'openai' });
  await T.writeDraft();
  const draft = await T.readDraft();
  check('草稿已写入且不含密钥', !!draft && JSON.stringify(draft).indexOf('sk-SECRET-123') === -1, draft && Object.keys(draft));
  check('草稿记录本身没有 apiKey 键', !!draft && !Object.prototype.hasOwnProperty.call(draft, 'apiKey'));

  await T.clearDraft();
  check('清除草稿', (await T.readDraft()) === null);

  /* 损坏 / 不可读的容错 */
  store.set(T.DONE_KEY, { id: T.DONE_KEY, done: 'yes' });
  check('损坏记录 → 视为未完成', (await T.readSetupRecord()).done === false);
  store.set(T.DRAFT_KEY, { id: T.DRAFT_KEY, step: 1, apiKey: 'sk-LEGACY' });
  check('旧草稿里若含密钥 → 直接丢弃', (await T.readDraft()) === null);
  dbBroken = true;
  const broken = await T.readSetupRecord();
  check('数据库不可读 → unreadable 且不打开向导', broken.unreadable === true && T.decide(broken, null, 0).open === false);
  check('数据库不可读时写 done 不抛异常', (await T.writeDone(true)) === false);
  dbBroken = false;

  console.log(failures ? `\nsetup-wizard test failed: ${failures}` : `\nsetup-wizard test passed ✔ (${passed})`);
  if (failures) process.exitCode = 1;
})();
