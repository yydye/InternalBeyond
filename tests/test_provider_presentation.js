'use strict';
/* Internal Beyond — P17 Provider Presentation Convergence 防漂移测试
   运行：node test_provider_presentation.js      （零网络、零浏览器）

   锁住的契约（对应 P17 Phase 6 的 13 项）：
     1. Picker provider 列表来自 Provider Directory（不是 HTML、不是 social.js 自带表）
     2. Setup Wizard 不存在第二份 Provider order / hint
     3. API Onboarding 不存在第二份 Provider order / hint
     4. HTML 不再硬编码 canonical provider <option>
     5. 新增 Provider Directory entry 后按 flag 自动出现（含「没有呈现条目也出现」）
     6. display order 正确（picker / setup / onboarding / 分组）
     7. hidden provider 不出现
     8. custom 被识别为 compatibility/custom，而非 official
     9. 编辑已有 API 时 provider selection 正确（含未知 legacy provider）
    10. unknown legacy provider graceful fallback（补占位选项，不静默清空）
    11. Provider Directory 不含重复 endpoint / format / model 真相
    12. boundary guard 不误伤 URL（含 document / navigator 的文档地址）
    13. boundary guard 仍能抓真实 DOM access

   说明：第 9/10 项用「从 social.js 抽出下拉构建函数 + 最小 DOM shim」的方式做真实行为
   验证，而不是只做源码正则断言。 */

const fs = require('fs');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const vm = require('vm');
const os = require('os');
const { spawnSync } = require('child_process');

/* ROOT = 仓库根（本文件位于 tests/）；BOUNDARY_PATH 是同住在 tests/ 的兄弟测试。 */
const DIR_PATH = path.join(ROOT, 'assets', 'js', 'provider-directory.js');
const SOCIAL_PATH = path.join(ROOT, 'assets', 'js', 'social.js');
const WIZ_PATH = path.join(ROOT, 'assets', 'js', 'setup-wizard.js');
const ONB_PATH = path.join(ROOT, 'assets', 'js', 'api-onboarding.js');
const HTML_PATH = path.join(ROOT, 'InternalBeyond.html');
const BOUNDARY_PATH = path.join(__dirname, 'test_harness_boundary.js');

let passed = 0, failures = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

const canon = require(DIR_PATH);
const dirText = fs.readFileSync(DIR_PATH, 'utf8');
const socialText = fs.readFileSync(SOCIAL_PATH, 'utf8');
const wizText = fs.readFileSync(WIZ_PATH, 'utf8');
const onbText = fs.readFileSync(ONB_PATH, 'utf8');
const html = fs.readFileSync(HTML_PATH, 'utf8');

const ALL_PROVIDER_IDS = Object.keys(canon.PROVIDERS);
const PRES_START = dirText.indexOf('var PROVIDER_PRESENTATION');
const PRES_END = dirText.indexOf('var GROUP_ORDER');
const presBlock = dirText.slice(PRES_START, PRES_END);

/* ═══ 0. 目录导出面 ═══════════════════════════════════════════ */
section('0. 目录导出面（P17 presentation 读取函数）');

for (const fn of ['providerPresentation', 'providerList', 'providerPickerList', 'setupProviderList',
  'onboardingProviderList', 'pickerGroups', 'providerDisplayName', 'providerHint',
  'providerBeginnerHint', 'providerCapabilitiesKnown']) {
  check('目录导出 ' + fn, typeof canon[fn] === 'function');
}
check('旧的多份顺序表已从目录删除（不再定义 / 导出 ONBOARDING_ORDER）',
  canon.ONBOARDING_ORDER === undefined && !/\b(?:var|const|let)\s+ONBOARDING_ORDER\b/.test(dirText),
  'ONBOARDING_ORDER 仍被定义');
check('目录仍导出 P16 onboarding 读取面', ['onboardingEntry', 'officialOnboardingEntry', 'thirdPartyEntry',
  'officialList', 'thirdPartyList', 'providerKind'].every(fn => typeof canon[fn] === 'function'));

/* ═══ 1. 顺序 / 分组真源 ══════════════════════════════════════ */
section('1. display order / 分组（唯一真源）');

const picker = canon.providerPickerList();
const setup = canon.setupProviderList();
const onboarding = canon.onboardingProviderList();

check('picker 列表非空且只含目录成员', picker.length >= 15 && picker.every(p => !!canon.PROVIDERS[p]), picker);
check('picker 顺序 = presentation.order（国内 → 国际 → 兼容）',
  JSON.stringify(picker) === JSON.stringify([
    'deepseek', 'qwen', 'glm', 'minimax', 'moonshot', 'doubao', 'mimo', 'yi', 'baichuan',
    'openai', 'anthropic', 'gemini', 'grok', 'mistral', 'custom']), picker);
check('setup 列表顺序与 picker 一致（同一份 order）', JSON.stringify(setup) === JSON.stringify(picker), setup);
check('onboarding 列表 = 官方且按 order（custom 不在其中）',
  JSON.stringify(onboarding) === JSON.stringify(picker.filter(p => p !== 'custom')), onboarding);
check('order 单调不减', picker.every((p, i) => i === 0
  || canon.providerPresentation(picker[i - 1]).order <= canon.providerPresentation(p).order));
check('custom 恒在最后（order 最大）',
  canon.providerPresentation('custom').order === Math.max.apply(null, picker.map(p => canon.providerPresentation(p).order)));

const groups = canon.pickerGroups();
check('pickerGroups 分组顺序 = domestic → international → compatible',
  JSON.stringify(groups.map(g => g.group)) === JSON.stringify(['domestic', 'international', 'compatible']), groups.map(g => g.group));
check('pickerGroups 分组标签来自目录（唯一一份文案）',
  groups.map(g => g.label).join('|') === [canon.GROUP_LABELS.domestic, canon.GROUP_LABELS.international, canon.GROUP_LABELS.compatible].join('|'),
  groups.map(g => g.label));
check('pickerGroups 展平后与 picker 列表逐项一致',
  JSON.stringify(groups.reduce((a, g) => a.concat(g.providers), [])) === JSON.stringify(picker));

/* ═══ 2. 没有第二份 Provider 顺序 / 文案 ══════════════════════ */
section('2. 消费方不得再维护 Provider 顺序 / 文案表');

check('setup-wizard.js 无 PROVIDER_ORDER / PROVIDER_HINT 字面量',
  !/PROVIDER_ORDER/.test(wizText) && !/PROVIDER_HINT/.test(wizText), '仍存在');
check('api-onboarding.js 无 OFFICIAL_ORDER / PROVIDER_HINT 字面量',
  !/OFFICIAL_ORDER/.test(onbText) && !/PROVIDER_HINT/.test(onbText), '仍存在');
check('api-onboarding.js 无 15 项 provider 数组字面量',
  !/\['(?:deepseek|openai|anthropic)'[^\]]{40,}\]/.test(onbText));

/* 每个 canonical shortHint 只能出现在目录里（消费方零复制）。
   HTML 只做「不存在 provider→hint 映射表」的结构断言：短词（MiniMax / Anthropic 官方）
   本来就可能出现在无关文案里（缓存说明、作者致谢），那不是第二份真源。 */
const hints = picker.map(p => canon.providerHint(p)).filter(Boolean);
const hintLeak = [];
for (const h of hints) {
  if (wizText.indexOf(h) !== -1) hintLeak.push('setup-wizard:' + h);
  if (onbText.indexOf(h) !== -1) hintLeak.push('api-onboarding:' + h);
}
check('所有一句话说明只存在于目录（两个 JS 消费方零复制）', hintLeak.length === 0, hintLeak);
check('HTML 不存在 provider → 说明 映射表', !/(?:deepseek|openai|anthropic|gemini|moonshot|doubao)\s*:\s*['"][^'"]{2,12}['"]/.test(html));

/* 新手说明由 onboarding audience 派生，不得复制成第二份 */
check('providerBeginnerHint 由 onboarding audience 派生（不复制）',
  canon.providerBeginnerHint('deepseek') === canon.onboardingEntry('deepseek').audience
  && canon.providerBeginnerHint('openai') === canon.onboardingEntry('openai').audience);
check('presentation 区块不复制 audience 文案',
  !presBlock.includes(canon.onboardingEntry('deepseek').audience));
check('presentation 区块不重复 display name（没有 name / label 字段）',
  !/\b(name|label)\s*:/.test(presBlock));
check('显示名统一取自 PROVIDERS',
  canon.providerDisplayName('anthropic') === canon.PROVIDERS.anthropic.name
  && canon.providerDisplayName('custom') === canon.PROVIDERS.custom.name);

/* ═══ 3. HTML 不再硬编码 canonical provider 选项 ══════════════ */
section('3. HTML provider 下拉（仅保留最小 fallback）');

const selBlock = html.slice(Math.max(0, html.indexOf('<!-- P17：选项由')), html.indexOf('</select>', html.indexOf('id="api-provider"')) + 9);
const selMatch = (html.match(/<select id="api-provider"[\s\S]*?<\/select>/) || [''])[0];
const htmlOptionVals = [...selMatch.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
check('#api-provider 仍存在', selMatch.length > 0);
check('HTML 静态 <option> 至多 1 个（最小 fallback）', htmlOptionVals.length <= 1, htmlOptionVals);
check('HTML 唯一 fallback 是兼容模式 custom', htmlOptionVals.length === 0 || htmlOptionVals[0] === 'custom', htmlOptionVals);
check('HTML 不再出现其它 canonical provider 选项',
  ALL_PROVIDER_IDS.filter(id => id !== 'custom').every(id => htmlOptionVals.indexOf(id) === -1), htmlOptionVals);
check('HTML 保留了目录驱动注释', /provider-directory\.js/.test(selBlock), selBlock.slice(0, 80));
check('custom 仍然可选', picker.indexOf('custom') !== -1 && !!canon.PROVIDERS.custom);
check('HTML 提供兼容模式说明位 #ibo-provider-note', /id="ibo-provider-note"/.test(html));

/* ═══ 4. social.js 下拉构建（真实行为） ═══════════════════════ */
section('4. API 编辑器下拉由目录构建（抽出真实函数 + 最小 DOM shim）');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let depth = 0, seen = false;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') { depth++; seen = true; }
    else if (src[j] === '}') { depth--; if (seen && depth === 0) return src.slice(start, j + 1); }
  }
  return '';
}
function makeEl(tag) {
  const t = String(tag).toUpperCase();
  const el = {
    tagName: t, children: [], attrs: {}, dataset: {}, style: {},
    label: '', _text: '', value: '', parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() { }, removeEventListener() { },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') this.children = []; },
    get options() {
      const out = [];
      for (const c of this.children) {
        if (c.tagName === 'OPTION') out.push(c);
        else for (const o of (c.children || [])) if (o.tagName === 'OPTION') out.push(o);
      }
      return out;
    }
  };
  /* 只有 <select> 的 value 具备浏览器语义：赋一个不存在的值 → ''。 */
  if (t === 'SELECT') {
    let value = '';
    Object.defineProperty(el, 'value', {
      get() { return value; },
      set(nv) {
        nv = String(nv == null ? '' : nv);
        if (!nv) { value = ''; return; }
        value = el.options.some(o => o.value === nv) ? nv : '';
      }
    });
  }
  return el;
}
function makePickerEnv(directory, providerTable) {
  const select = makeEl('select');
  const fallback = makeEl('option');
  fallback.value = 'custom';
  fallback.textContent = '自定义 / OpenAI Compatible';
  select.appendChild(fallback);
  const doc = {
    getElementById(id) { return id === 'api-provider' ? select : null; },
    createElement: makeEl,
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() { }
  };
  const sandbox = {
    document: doc,
    window: { PROVIDERS_DIR: directory },
    PROVIDERS: providerTable !== undefined ? providerTable : ((directory && directory.PROVIDERS) || {})
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = ['_ibDir', '_ibProviderPickerIds', '_ibProviderLabel', '_ibProviderGroups',
    '_ibSyncProviderOptions', '_ibHasProviderOption', '_ibDefaultProvider', '_ibSetProviderSelection']
    .map(n => extractFn(socialText, n)).join('\n');
  vm.runInContext(src, sandbox, { filename: 'social-picker-extract.js' });
  return { sandbox, select, src };
}

const envOk = makePickerEnv(canon);
check('social.js 下拉构建函数可完整抽出（8 个）',
  ['_ibDir', '_ibProviderPickerIds', '_ibProviderLabel', '_ibProviderGroups',
    '_ibSyncProviderOptions', '_ibHasProviderOption', '_ibDefaultProvider', '_ibSetProviderSelection']
    .every(n => envOk.src.indexOf('function ' + n + '(') !== -1));
check('目录可用时构建成功', envOk.sandbox._ibSyncProviderOptions() === true);

const builtOptions = envOk.select.options.map(o => o.value);
check('下拉选项 = 目录 picker 列表（顺序逐项一致）',
  JSON.stringify(builtOptions) === JSON.stringify(picker), builtOptions);
check('下拉选项文案来自 PROVIDERS.name',
  envOk.select.options.every(o => o.textContent === canon.providerDisplayName(o.value)),
  envOk.select.options.map(o => o.value + '=' + o.textContent));
check('下拉按目录分组渲染 optgroup',
  envOk.select.children.filter(c => c.tagName === 'OPTGROUP').map(c => c.label).join('|')
  === groups.map(g => g.label).join('|'),
  envOk.select.children.filter(c => c.tagName === 'OPTGROUP').map(c => c.label));

check('默认选中仍是 anthropic（历史默认，目录里存在）', envOk.sandbox._ibDefaultProvider() === 'anthropic');
check('编辑既有 API：选中既有 provider',
  envOk.sandbox._ibSetProviderSelection('gemini') === 'gemini' && envOk.select.value === 'gemini');
check('编辑既有 API：未知 legacy provider 补占位选项且不清空',
  envOk.sandbox._ibSetProviderSelection('astra') === 'astra' && envOk.select.value === 'astra'
  && envOk.select.options.some(o => o.value === 'astra' && /未知服务商/.test(o.textContent)),
  envOk.select.options.map(o => o.value));
check('未知 legacy provider 占位选项只补一次（幂等）', (() => {
  envOk.sandbox._ibSetProviderSelection('astra');
  return envOk.select.options.filter(o => o.value === 'astra').length === 1;
})());
check('重建下拉后仍保留当前选中值', (() => {
  envOk.sandbox._ibSetProviderSelection('grok');
  envOk.sandbox._ibSyncProviderOptions();
  return envOk.select.value === 'grok';
})());
check('空 id 退到默认 provider', envOk.sandbox._ibSetProviderSelection('') === 'anthropic');

const envBroken = makePickerEnv(null, {});
check('目录缺失：构建返回 false 且保留 HTML fallback',
  envBroken.sandbox._ibSyncProviderOptions() === false
  && envBroken.select.options.map(o => o.value).join('|') === 'custom',
  envBroken.select.options.map(o => o.value));
check('目录缺失：选中请求仍不抛错', (() => {
  try { envBroken.sandbox._ibSetProviderSelection('deepseek'); return true; } catch (e) { return false; }
})());

/* ═══ 5. Setup Wizard / Onboarding 的真实取数行为 ═════════════ */
section('5. Setup Wizard / API Onboarding 从目录取数（无本地顺序表）');

function runWizardList(directory) {
  const sandbox = { window: { PROVIDERS_DIR: directory }, Object, Array, String };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(['providers', 'presentationDir', 'setupProviderIds'].map(n => extractFn(wizText, n)).join('\n'),
    sandbox, { filename: 'wizard-extract.js' });
  return sandbox.setupProviderIds();
}
check('向导列表 = 目录 setupProviderList()',
  JSON.stringify(runWizardList(canon)) === JSON.stringify(canon.setupProviderList()), runWizardList(canon));
check('向导列表跟随目录（目录只给 3 项时不会补出本地顺序）',
  JSON.stringify(runWizardList({ PROVIDERS: canon.PROVIDERS, setupProviderList: () => ['mistral', 'deepseek', 'custom'] }))
  === JSON.stringify(['mistral', 'deepseek', 'custom']));
check('旧版目录（无 presentation 函数）退到键序且 custom 在最后', (() => {
  const list = runWizardList({ PROVIDERS: canon.PROVIDERS });
  return list.length === ALL_PROVIDER_IDS.length && list[list.length - 1] === 'custom';
})());

function runOnboardingList(directory) {
  const sandbox = { window: { PROVIDERS_DIR: directory }, Object, Array, String };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(['dir', 'providers', 'officialIds'].map(n => extractFn(onbText, n)).join('\n'),
    sandbox, { filename: 'onboarding-extract.js' });
  return sandbox.officialIds();
}
check('获取向导官方卡片 = 目录 onboardingProviderList()',
  JSON.stringify(runOnboardingList(canon)) === JSON.stringify(canon.onboardingProviderList()), runOnboardingList(canon));
check('获取向导跟随目录（不重排）',
  JSON.stringify(runOnboardingList({ PROVIDERS: canon.PROVIDERS, onboardingProviderList: () => ['gemini', 'deepseek'] }))
  === JSON.stringify(['gemini', 'deepseek']));
check('旧版目录退到键序且排除 custom', (() => {
  const list = runOnboardingList({ PROVIDERS: canon.PROVIDERS });
  return list.indexOf('custom') === -1 && list.length === ALL_PROVIDER_IDS.length - 1;
})());

/* ═══ 6. 新增 / 隐藏 provider（临时目录副本） ══════════════════ */
section('6. 新增 / 隐藏 provider 的自动出现与隐藏');

let tmpDir = null;
function buildTempDirectory() {
  const providersAnchor = "    custom: { name: '自定义 / OpenAI Compatible'";
  const presAnchor = '    /* 兼容 / 自定义（不是一家服务） */';
  if (dirText.indexOf(providersAnchor) === -1 || dirText.indexOf(presAnchor) === -1) return null;
  let src = dirText.replace(providersAnchor,
    "    zzshown: { name: 'ZZ Shown', endpoint: 'https://zz.example.com/v1/chat/completions', model: 'zz-1', format: 'openai', vision: false, streaming: true },\n"
    + "    zzhidden: { name: 'ZZ Hidden', endpoint: 'https://zz2.example.com/v1/chat/completions', model: 'zz-2', format: 'openai', vision: false, streaming: true },\n"
    + "    zzdefault: { name: 'ZZ Default', endpoint: 'https://zz3.example.com/v1/chat/completions', model: 'zz-3', format: 'openai', vision: false, streaming: true },\n"
    + providersAnchor);
  src = src.replace(presAnchor,
    "    zzshown: { order: 15, group: 'domestic', shortHint: 'ZZ 已登记', showInPicker: true, showInSetup: true, showInOnboarding: true },\n"
    + "    zzhidden: { order: 16, group: 'domestic', shortHint: 'ZZ 隐藏', showInPicker: false, showInSetup: false, showInOnboarding: false },\n"
    + presAnchor);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p17-'));
  const file = path.join(dir, 'provider-directory.js');
  fs.writeFileSync(file, src, 'utf8');
  return file;
}

const tmpFile = buildTempDirectory();
check('可生成临时目录副本（新增 3 个 provider）', !!tmpFile);
let tmpCanon = null;
if (tmpFile) { tmpCanon = require(tmpFile); tmpDir = path.dirname(tmpFile); }

check('新增 provider 按 order 插到正确位置（15 在 10 与 20 之间）', !!tmpCanon
  && tmpCanon.providerPickerList().indexOf('zzshown') === 1, tmpCanon && tmpCanon.providerPickerList());
check('新增 provider 出现在 picker / setup / onboarding',
  !!tmpCanon && ['providerPickerList', 'setupProviderList', 'onboardingProviderList']
    .every(fn => tmpCanon[fn]().indexOf('zzshown') !== -1));
check('showIn* = false 的 provider 不出现在任何列表', !!tmpCanon
  && ['providerPickerList', 'setupProviderList', 'onboardingProviderList']
    .every(fn => tmpCanon[fn]().indexOf('zzhidden') === -1));
check('hidden provider 仍存在于 PROVIDERS（只是不展示）', !!tmpCanon && !!tmpCanon.PROVIDERS.zzhidden);
check('includeHidden 可取出 hidden provider', !!tmpCanon
  && tmpCanon.providerList({ where: 'picker', includeHidden: true }).indexOf('zzhidden') !== -1);
check('没有呈现条目的新增 provider 默认出现在所有列表（目录才是名单）', !!tmpCanon
  && ['providerPickerList', 'setupProviderList', 'onboardingProviderList']
    .every(fn => tmpCanon[fn]().indexOf('zzdefault') !== -1));
check('没有呈现条目的 provider 排在国际之后、custom 之前', !!tmpCanon && (() => {
  const l = tmpCanon.providerPickerList();
  return l.indexOf('zzdefault') > l.indexOf('mistral') && l.indexOf('zzdefault') < l.indexOf('custom');
})(), tmpCanon && tmpCanon.providerPickerList());
check('临时副本的 picker 仍可由 social.js 下拉构建（按 flag 自动出现）', (() => {
  if (!tmpCanon) return false;
  const env = makePickerEnv(tmpCanon);
  env.sandbox._ibSyncProviderOptions();
  const vals = env.select.options.map(o => o.value);
  return vals.indexOf('zzshown') !== -1 && vals.indexOf('zzhidden') === -1 && vals.indexOf('zzdefault') !== -1;
})());
check('临时副本的向导列表也自动包含新增项（按 flag）', !!tmpCanon
  && runWizardList(tmpCanon).indexOf('zzshown') !== -1
  && runWizardList(tmpCanon).indexOf('zzhidden') === -1);

/* ═══ 7. custom 语义 ══════════════════════════════════════════ */
section('7. custom = Generic / OpenAI Compatible（不是某家服务）');

const customPres = canon.providerPresentation('custom');
check('providerKind(custom) = compatible（不是 official）', canon.providerKind('custom') === 'compatible', canon.providerKind('custom'));
check('providerKind 仍能区分 official / thirdparty / unknown',
  canon.providerKind('deepseek') === 'official' && canon.providerKind('openrouter') === 'thirdparty'
  && canon.providerKind('example.com') === 'unknown');
check('custom 的 group = compatible', customPres.group === 'compatible');
check('custom 不进官方列表 / 获取向导官方区',
  canon.officialList().indexOf('custom') === -1 && canon.onboardingProviderList().indexOf('custom') === -1);
check('custom 没有官方 onboarding 条目（不给它官方站点）',
  canon.officialOnboardingEntry('custom') === null && canon.onboardingEntry('custom') === null);
check('custom 端点默认为空', canon.PROVIDERS.custom.endpoint === '');
check('custom 不假装有 canonical 官方模型', canon.PROVIDERS.custom.model === '');
check('custom 的显示名直说兼容模式',
  /自定义/.test(canon.providers ? '' : canon.providerDisplayName('custom'))
  && /OpenAI Compatible/.test(canon.providerDisplayName('custom')), canon.providerDisplayName('custom'));
check('custom 被标记为不声明能力（capabilitiesKnown=false）',
  canon.providerCapabilitiesKnown('custom') === false && canon.providerCapabilitiesKnown('deepseek') === true);
check('底层 vision/streaming 旧默认未改动（兼容风险为零）',
  canon.PROVIDERS.custom.vision === true && canon.PROVIDERS.custom.streaming === true);
check('能力未知时由 UI 说明位提示（api-onboarding 提供 renderProviderNote）',
  /renderProviderNote/.test(onbText) && /不声明这个服务的能力/.test(onbText));
check('兼容模式说明位由 social.js 在切换 provider 时刷新',
  /_ibRefreshProviderNote/.test(socialText) && /renderProviderNote/.test(socialText));

/* ═══ 8. 目录不含重复协议真相 ════════════════════════════════ */
section('8. 目录不含重复 endpoint / format / model 真相');

const PROTOCOL_FIELDS = ['endpoint', 'format', 'model', 'vision', 'streaming'];
check('presentation 区块不含协议配置字段',
  !new RegExp('\\b(' + PROTOCOL_FIELDS.join('|') + ')\\s*:').test(presBlock), PROTOCOL_FIELDS);
const ENDPOINTS = ['api.anthropic.com', 'api.openai.com', 'api.x.ai', 'api.deepseek.com',
  'generativelanguage.googleapis.com', 'open.bigmodel.cn', 'dashscope.aliyuncs.com',
  'ark.cn-beijing.volces.com', 'api.moonshot.cn', 'api.xiaomimimo.com', 'api.minimax.chat',
  'api.lingyiwanwu.com', 'api.baichuan-ai.com', 'api.mistral.ai'];
check('presentation 区块不含任何 provider endpoint 主机名', ENDPOINTS.every(e => presBlock.indexOf(e) === -1));
/* P18：默认模型从目录派生，不再硬编码（换默认值 / 新增 provider 自动跟随）。 */
const MODELS = Object.keys(canon.PROVIDERS).map(id => canon.PROVIDERS[id].model).filter(Boolean);
check('presentation 区块不含任何默认模型 id', MODELS.every(m => presBlock.indexOf(m) === -1));
check('presentation 的 key 都是 canonical provider id',
  Object.keys(canon.PROVIDER_PRESENTATION).every(id => !!canon.PROVIDERS[id]));
check('每个 canonical provider 都能取到归一化呈现元数据',
  ALL_PROVIDER_IDS.every(id => { const p = canon.providerPresentation(id); return !!p && typeof p.order === 'number' && !!p.group; }));
check('未知 id 的呈现元数据为 null', canon.providerPresentation('__nope__') === null && canon.providerPresentation(null) === null);
check('presentation 是纯数据（无函数 / 无 DOM）',
  Object.keys(canon.PROVIDER_PRESENTATION).every(id => typeof canon.PROVIDER_PRESENTATION[id] === 'object')
  && !/document|navigator|querySelector|innerHTML/.test(presBlock));

/* ═══ 9. boundary guard（真实子进程） ═════════════════════════ */
section('9. harness boundary guard：不误伤 URL，仍抓真实 DOM');

const guard = spawnSync(process.execPath, [BOUNDARY_PATH], { encoding: 'utf8', cwd: ROOT });
const guardOut = String(guard.stdout || '') + String(guard.stderr || '');
check('test_harness_boundary.js 全绿', guard.status === 0, guardOut.slice(-400));
check('guard 负例存在并通过（URL 含 document / navigator 不报错）',
  (guardOut.match(/DOM 守卫不误伤/g) || []).length >= 6, (guardOut.match(/DOM 守卫不误伤/g) || []).length);
check('guard 正例存在并通过（真实 DOM access 仍报错）',
  (guardOut.match(/DOM 守卫仍抓得到/g) || []).length >= 8, (guardOut.match(/DOM 守卫仍抓得到/g) || []).length);
check('guard 仍保留原有五词检测（document/querySelector/getElementById/innerHTML/navigator）',
  /document\|querySelector\|getElementById\|innerHTML\|navigator/.test(fs.readFileSync(BOUNDARY_PATH, 'utf8')));

/* ═══ 10. 编码 / 语法 ═════════════════════════════════════════ */
section('10. 文件编码与语法');

for (const [name, file] of [['provider-directory.js', DIR_PATH], ['social.js', SOCIAL_PATH],
  ['setup-wizard.js', WIZ_PATH], ['api-onboarding.js', ONB_PATH], ['test_harness_boundary.js', BOUNDARY_PATH]]) {
  const buf = fs.readFileSync(file);
  const src = buf.toString('utf8').replace(/^\uFEFF/, '');
  let ok = true;
  try { new vm.Script(src, { filename: name }); } catch (e) { ok = false; }
  check(name + ' 语法可解析', ok);
  check(name + ' 是合法 UTF-8', (() => {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (e) { return false; }
  })());
  check(name + ' 无乱码特征', !/\uFFFD|锟斤拷/.test(src));
}

if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { } }

console.log('\n结果: ' + passed + ' 通过, ' + failures + ' 失败');
process.exitCode = failures ? 1 : 0;
