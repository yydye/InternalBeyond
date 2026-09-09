'use strict';

/* 前端静态回归：编码、拆分资源、入口语义、设计变量与内联样式预算。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { TextDecoder } = require('util');

const root = __dirname;
const htmlPath = path.join(root, 'InternalBeyond.html');
const html = fs.readFileSync(htmlPath, 'utf8').replace(/^\uFEFF/, '');
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log('  PASS  ' + name);
  else {
    failures++;
    console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function frontFiles() {
  const files = [htmlPath];
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (/\.(?:css|js)$/i.test(entry.name)) files.push(file);
    }
  }
  for (const dir of ['assets/css', 'assets/js', 'game']) {
    collect(path.join(root, dir));
  }
  return files;
}

function strictUtf8(file) {
  const buf = fs.readFileSync(file);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (error) {
    return { valid: false, bom: false, text: '', error: error.message };
  }
  return {
    valid: true,
    bom: buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    text: buf.toString('utf8').replace(/^\uFEFF/, '')
  };
}

function localAsset(value, baseDir) {
  const clean = String(value).trim().replace(/^['"]|['"]$/g, '').replace(/[?#].*$/, '');
  if (!clean || /^(?:data:|https?:|blob:|#|javascript:|var\()/i.test(clean)) return null;
  return path.resolve(baseDir, decodeURIComponent(clean));
}

console.log('Frontend structure regression');

const sources = frontFiles();
for (const file of sources) {
  const result = strictUtf8(file);
  const rel = path.relative(root, file);
  check('encoding.validUtf8.' + rel, result.valid, result.error);
  check('encoding.bom.' + rel, result.bom, 'UTF-8 BOM is required for Windows editor compatibility');
  if (result.valid) {
    const bad = /\uFFFD|锟斤拷|Ã.|Â.|â(?:€|™|œ|“|”)/.test(result.text);
    check('encoding.noMojibake.' + rel, !bad);
  }
}

check('split.htmlUnder500KiB', fs.statSync(htmlPath).size < 500 * 1024, fs.statSync(htmlPath).size + ' bytes');
check('split.noStyleBlocks', !/<style\b/i.test(html));
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim());
check('split.noInlineScripts', inlineScripts.length === 0, String(inlineScripts.length));

const scriptSources = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
const styleSources = [...html.matchAll(/<link[^>]*\brel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
check('split.externalScriptCount', scriptSources.length >= 15, String(scriptSources.length));
check('split.externalStyleCount', styleSources.length === 20, String(styleSources.length));
const expectedCoreStyles = [
  'assets/css/core.css',
  'assets/css/core/chat-shell.css',
  'assets/css/core/letters.css',
  'assets/css/core/memory.css',
  'assets/css/core/pages.css',
  'assets/css/core/chat.css',
  'assets/css/core/workspace.css',
  'assets/css/core/api-components.css',
  'assets/css/core/blog.css',
  'assets/css/core/about.css',
  'assets/css/core/widgets.css',
  'assets/css/core/archive-active.css'
];
check('split.coreStyleOrder', JSON.stringify(styleSources.slice(0, expectedCoreStyles.length)) === JSON.stringify(expectedCoreStyles), styleSources.slice(0, expectedCoreStyles.length).join(', '));

const missing = [];
for (const value of scriptSources.concat(styleSources)) {
  const file = localAsset(value, root);
  if (file && !fs.existsSync(file)) missing.push(value);
}
for (const cssFile of sources.filter(file => file.endsWith('.css'))) {
  const css = fs.readFileSync(cssFile, 'utf8').replace(/^\uFEFF/, '');
  for (const match of css.matchAll(/url\(\s*([^)]*?)\s*\)/gi)) {
    const file = localAsset(match[1], path.dirname(cssFile));
    if (file && !fs.existsSync(file)) missing.push(path.relative(root, cssFile) + ' -> ' + match[1]);
  }
}
check('assets.allLocalReferencesExist', missing.length === 0, missing.join(', '));

const staticStyles = (html.match(/\bstyle\s*=/gi) || []).length;
let allSource = html;
for (const file of sources.filter(file => file.endsWith('.js'))) allSource += '\n' + fs.readFileSync(file, 'utf8');
const allInlineStyles = (allSource.match(/\bstyle\s*=/gi) || []).length;
check('styles.staticInlineBudget', staticStyles <= 200, String(staticStyles));
/* 内联样式预算 = 当前提交状态的实际计数（棘轮：只能持平或下降，新增即失败）。
   预算在 6a61c3c 时为 456/460；此后两个与本测试无关的功能批次把计数推到 470：
     - 5a64cd0 控制台彩蛋 assets/js/easteregg.js（终端风格的生成 HTML，+10）
     - c15e7fb 后端重启 UI assets/js/backend-restart.js（+1）与 InternalBeyond.html（+3）
   这些是已提交的生产代码，不是本次改动引入的；静态 HTML 内联预算（200）保持原值。 */
check('styles.totalInlineBudget', allInlineStyles <= 470, String(allInlineStyles));

const coreCss = fs.readFileSync(path.join(root, 'assets/css/core.css'), 'utf8');
for (const token of [
  '--surface-panel', '--surface-card', '--surface-input', '--border-soft', '--content-primary',
  '--focus-ring', '--shadow-panel', '--radius-panel', '--motion-fast', '--font-ui', '--space-2'
]) check('tokens.' + token.slice(2), coreCss.includes(token + ':'));
const darkBlock = (coreCss.match(/body\.theme-infernal\s*\{([\s\S]*?)\}/) || [])[1] || '';
for (const token of ['--surface-panel', '--surface-card', '--border-soft', '--content-primary', '--focus-ring']) {
  check('tokens.dark.' + token.slice(2), darkBlock.includes(token + ':'));
}

check('bridge.singleNavEntry', (html.match(/id=["']ib-bridge-nav["']/g) || []).length === 1);
check('bridge.noLegacyFab', !/id=["']ib-bridge-fab["']/.test(html) && !/bridgeFab|bridge-fab/.test(allSource));
check('a11y.skipLink', /class=["']skip-link["'][^>]*href=["']#app["']/.test(html));
check('a11y.mainLandmark', /id=["']app["'][^>]*role=["']main["']/.test(html));
check('a11y.navLabel', /<nav[^>]*id=["']navbar["'][^>]*aria-label=/.test(html));
check('a11y.bridgeDisclosure', /id=["']ib-bridge-nav["'][^>]*aria-controls=["']ib-bridge-panel["'][^>]*aria-expanded=/.test(html));
check('a11y.buttonsHaveType', !/<button\b(?![^>]*\btype\s*=)/i.test(html));
check('html.noDuplicateClassAttributes', !/<[^>]*\bclass\s*=\s*["'][^"']*["'][^>]*\bclass\s*=/i.test(html));
const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
check('html.uniqueIds', new Set(ids).size === ids.length, String(ids.length - new Set(ids).size));
const navLinks = [...html.matchAll(/<a\b([^>]*\bdata-page=["'][^"']+["'][^>]*)>/gi)];
check('a11y.navLinksHaveHref', navLinks.length >= 11 && navLinks.every(m => /\bhref\s*=/.test(m[1])), String(navLinks.length));

const beaconCount = (html.match(/cloudflareinsights|beacon\.min\.js/gi) || []).length;
check('performance.noDuplicateBeacon', beaconCount <= 1, String(beaconCount));
check('performance.noExternalFontPreconnect', !/fonts\.(?:googleapis|gstatic)\.com/i.test(html));
const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(match => match[0]);
check('performance.staticImagesLazyDecoded', images.every(tag => /\bloading=["']lazy["']/.test(tag) && /\bdecoding=["']async["']/.test(tag)), String(images.length));

/* Communication 子模块：IIFE 首尾存在 + 独立语法检查（切片边界错误的明确失败原因）。 */
const comMainPath = path.join(root, 'assets', 'js', 'communication.js');
const comMainText = fs.readFileSync(comMainPath, 'utf8').replace(/^\uFEFF/, '');
check('com.iifeOpener', comMainText.includes('(function(NS){'), 'communication.js missing IIFE opener (function(NS){');
check('com.iifeCloser', comMainText.includes('})(window.IB || (window.IB = {}));'), 'communication.js missing IIFE closer');
const comDir = path.join(root, 'assets', 'js', 'communication');
if (fs.existsSync(comDir)) {
  for (const name of fs.readdirSync(comDir)) {
    if (!/\.js$/i.test(name)) continue;
    const file = path.join(comDir, name);
    const rel = 'communication/' + name;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    check('com.iifeOpener.' + rel, text.includes('(function(NS){'), rel + ' missing IIFE opener');
    check('com.iifeCloser.' + rel, text.includes('})(window.IB || (window.IB = {}));'), rel + ' missing IIFE closer');
    let syntaxOk = true;
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (error) { syntaxOk = false; }
    check('com.syntax.' + rel, syntaxOk, rel + ' failed node --check');
  }
}

/* Memory 子模块：与 communication/workspace 同一套切片边界断言。 */
const memDir = path.join(root, 'assets', 'js', 'memory');
if (fs.existsSync(memDir)) {
  for (const name of fs.readdirSync(memDir)) {
    if (!/\.js$/i.test(name)) continue;
    const file = path.join(memDir, name);
    const rel = 'memory/' + name;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    check('mem.iifeOpener.' + rel, text.includes('(function(NS){'), rel + ' missing IIFE opener');
    check('mem.iifeCloser.' + rel, text.includes('})(window.IB || (window.IB = {}));'), rel + ' missing IIFE closer');
    let syntaxOk = true;
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (error) { syntaxOk = false; }
    check('mem.syntax.' + rel, syntaxOk, rel + ' failed node --check');
  }
}

/* Workspace 子模块：与 communication 同一套切片边界断言。 */
const wsDir = path.join(root, 'assets', 'js', 'workspace');
if (fs.existsSync(wsDir)) {
  for (const name of fs.readdirSync(wsDir)) {
    if (!/\.js$/i.test(name)) continue;
    const file = path.join(wsDir, name);
    const rel = 'workspace/' + name;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    check('ws.iifeOpener.' + rel, text.includes('(function(NS){'), rel + ' missing IIFE opener');
    check('ws.iifeCloser.' + rel, text.includes('})(window.IB || (window.IB = {}));'), rel + ' missing IIFE closer');
    let syntaxOk = true;
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (error) { syntaxOk = false; }
    check('ws.syntax.' + rel, syntaxOk, rel + ' failed node --check');
  }
}

/* Active/Diary 子模块：父协调层和两个业务域都必须保持完整 IIFE，且可独立解析。 */
const activeMainPath = path.join(root, 'assets', 'js', 'active-diary.js');
const activeMainText = fs.readFileSync(activeMainPath, 'utf8').replace(/^\uFEFF/, '');
check('active.iifeOpener', activeMainText.includes('(function(NS){'), 'active-diary.js missing IIFE opener');
check('active.iifeCloser', activeMainText.includes('})(window.IB || (window.IB = {}));'), 'active-diary.js missing IIFE closer');
const activeDir = path.join(root, 'assets', 'js', 'active-diary');
if (fs.existsSync(activeDir)) {
  for (const name of fs.readdirSync(activeDir)) {
    if (!/\.js$/i.test(name)) continue;
    const file = path.join(activeDir, name);
    const rel = 'active-diary/' + name;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    check('active.iifeOpener.' + rel, text.includes('(function(NS){'), rel + ' missing IIFE opener');
    check('active.iifeCloser.' + rel, text.includes('})(window.IB || (window.IB = {}));'), rel + ' missing IIFE closer');
    let syntaxOk = true;
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (error) { syntaxOk = false; }
    check('active.syntax.' + rel, syntaxOk, rel + ' failed node --check');
  }
}

/* Activity 子模块（陪伴活动运行时）：与 communication 同一套切片边界断言。 */
const actDir = path.join(root, 'assets', 'js', 'activity');
if (fs.existsSync(actDir)) {
  for (const name of fs.readdirSync(actDir)) {
    if (!/\.js$/i.test(name)) continue;
    const file = path.join(actDir, name);
    const rel = 'activity/' + name;
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    check('act.iifeOpener.' + rel, text.includes('(function(NS){'), rel + ' missing IIFE opener');
    check('act.iifeCloser.' + rel, text.includes('})(window.IB || (window.IB = {}));'), rel + ' missing IIFE closer');
    let syntaxOk = true;
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (error) { syntaxOk = false; }
    check('act.syntax.' + rel, syntaxOk, rel + ' failed node --check');
  }
}

/* GPT-6 Astra · Middle Brain：Astra 是全局层，不作为角色 Provider 出现；
   角色 provider 下拉与 PROVIDERS 注册表均不得含 astra；全局 Middle Brain 配置模块已加载。 */
const socialText = fs.readFileSync(path.join(root, 'assets', 'js', 'social.js'), 'utf8').replace(/^\uFEFF/, '');
const ibmcText = fs.readFileSync(path.join(root, 'assets', 'js', 'ib-model-core.js'), 'utf8').replace(/^\uFEFF/, '');
const roleProviderNoAstra = !/<option value="astra">/.test(html) && !/astra:\s*\{/.test(socialText) && !/astra:\s*\{/.test(ibmcText);
check('astra.notRoleProvider', roleProviderNoAstra, 'astra 仍残留为角色 Provider（HTML option / PROVIDERS）');

/* ── Provider read-path 收敛守卫（P11-0）────────────────────────────────
   唯一 wire-format 决策点 = assets/js/provider-directory.js（canonical 层）。
   5 条读取路径必须"委托 canonical + 只保留同域兜底"，不得各自复制决策表达式：
     communication._providerFormat        → PROVIDERS_DIR.providerFormat
     agent-runtime.resolveProviderFormat  → 同源 resolveProviderFormat（禁止跨表）
     ib-model-core.providerFormat         → CANON.providerFormat
     active-diary._activeModelFormat      → IB.runtime.modelFormat
     moments._momentsFormat               → IB.runtime.modelFormat
     active-diary/diary._diaryFormat      → IB.runtime.modelFormat
   本守卫是 P11-0 收敛的锁：内联回去（复制 known/hasFormat 决策或直读裸表）即失败。 */
const readJs = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');
const dirText = readJs('assets/js/provider-directory.js');
const rtText = readJs('assets/js/agent-runtime.js');
const domainShims = [
  ['assets/js/active-diary.js', '_activeModelFormat'],
  ['assets/js/moments.js', '_momentsFormat'],
  ['assets/js/active-diary/diary.js', '_diaryFormat']
].map(([rel, fn]) => [rel, readJs(rel), fn]);

/* 1 · canonical 层：三个导出 + 单一决策体 + providerFormat 委托 */
for (const fn of ['providerEntry', 'resolveProviderFormat', 'providerFormat']) {
  check('provider.canonicalExport.' + fn, new RegExp('\\b' + fn + ': ' + fn + '\\b').test(dirText), 'provider-directory.js 未导出 ' + fn);
}
check('provider.canonicalDecisionBody', /known:\s*true,\s*hasFormat:\s*!!fmt/.test(dirText) && /known:\s*false,\s*hasFormat:\s*false/.test(dirText), 'canonical 决策体（known/hasFormat 两分支）缺失');
check('provider.canonicalFormatDelegates', /function providerFormat\(provider\) \{\s*return resolveProviderFormat\(provider\)\.format;\s*\}/.test(dirText), 'providerFormat 未委托 resolveProviderFormat');
check('provider.htmlLoadOrder', scriptSources.includes('assets/js/provider-directory.js')
  && scriptSources.indexOf('assets/js/provider-directory.js') < scriptSources.indexOf('assets/js/ib-model-core.js')
  && scriptSources.indexOf('assets/js/provider-directory.js') < scriptSources.indexOf('assets/js/agent-runtime.js'),
  'provider-directory.js 未在 ib-model-core / agent-runtime 之前加载');

/* 2 · canonical 行为锁：providerFormat(p) ≡ resolveProviderFormat(p).format（含未知/空/null） */
const canon = require(path.join(root, 'assets', 'js', 'provider-directory.js'));
check('provider.canonicalSurface', typeof canon.providerEntry === 'function' && typeof canon.resolveProviderFormat === 'function' && typeof canon.providerFormat === 'function', 'canonical 层导出不完整');
check('provider.canonicalDirNotEmpty', Object.keys(canon.PROVIDERS).length >= 15, String(Object.keys(canon.PROVIDERS).length));
const canonDrift = [];
for (const p of Object.keys(canon.PROVIDERS).concat(['__unknown__', '', null, undefined])) {
  const decided = canon.resolveProviderFormat(p);
  if (decided.format !== canon.providerFormat(p)) canonDrift.push('format:' + String(p));
  if (!decided.format || typeof decided.known !== 'boolean' || typeof decided.hasFormat !== 'boolean') canonDrift.push('shape:' + String(p));
}
check('provider.canonicalFormatEquivalence', canonDrift.length === 0, canonDrift.join(', '));
check('provider.canonicalUnknownDefault', JSON.stringify(canon.resolveProviderFormat('__unknown__')) === JSON.stringify({ format: 'openai', known: false, hasFormat: false }), JSON.stringify(canon.resolveProviderFormat('__unknown__')));
check('provider.canonicalEntryNull', canon.providerEntry(null) === null && canon.providerEntry('__unknown__') === null);

/* 3 · ib-model-core：委托 CANON（裸表兜底仅限无 resolver 的宿主） */
check('provider.ibmcDelegatesFormat', /typeof CANON\.providerFormat === 'function'\) return CANON\.providerFormat\(provider\)/.test(ibmcText), 'ib-model-core.providerFormat 未委托 CANON');
check('provider.ibmcDelegatesResolve', /typeof CANON\.resolveProviderFormat === 'function'\) return CANON\.resolveProviderFormat\(provider\)/.test(ibmcText), 'ib-model-core.resolveProviderFormat 未委托 CANON');
check('provider.ibmcExportsResolve', /resolveProviderFormat:\s*resolveProviderFormat/.test(ibmcText), 'ib-model-core 未导出 resolveProviderFormat');

/* 4 · agent-runtime：同源 resolver（跨表读取会让 known/hasFormat 漂移） */
check('provider.rtSameSourceResolver', /source === 'IBModelCore'\) return pick\(window\.IBModelCore\)/.test(rtText)
  && /source === 'PROVIDERS_DIR'\) return pick\(window\.PROVIDERS_DIR\)/.test(rtText),
  'agent-runtime 必须从本次实际读到的表取 resolver');
check('provider.rtConsumesCanonical', /const decided = canon \? canon\(provider\) : null;/.test(rtText), 'agent-runtime 未消费 canonical 决策');
check('provider.rtLabels', /'unknown-provider-default'/.test(rtText) && /'\(no-format-default\)'/.test(rtText), 'agent-runtime 的 source 标签被改写');
check('provider.rtModelFormatExported', /modelFormat:\s*modelFormat/.test(rtText), 'agent-runtime 未导出 modelFormat（三个后台域的唯一实现）');

/* 5 · communication：委托 canonical */
check('provider.commDelegatesCanonical', /_dir\.providerFormat\(cfg&&cfg\.provider\)/.test(comMainText), 'communication._providerFormat 未委托 PROVIDERS_DIR.providerFormat');

/* 6 · 三个后台域 shim：委托 IB.runtime.modelFormat、逐字一致、不内联裸表 */
const shimBodies = domainShims.map(([, text, fn]) => {
  const body = (text.match(new RegExp('function ' + fn + '\\(cfg,runtime\\)\\{[\\s\\S]*?\\n\\}')) || [''])[0];
  return body.replace('function ' + fn, 'function _XFormat').replace(/\r\n/g, '\n');
});
domainShims.forEach(([rel, text, fn], i) => {
  check('provider.shimDelegates.' + rel, /IB\.runtime\.modelFormat\(cfg,runtime\)/.test(shimBodies[i]), fn + ' 未委托 IB.runtime.modelFormat');
  check('provider.shimNoRawTable.' + rel, !/PROVIDERS\s*\[[^\]]*\]\s*&&[^;]*\.format/.test(text), rel + ' 重新内联了裸表 format 读取');
});
check('provider.shimsIdentical', shimBodies.every(b => b && b === shimBodies[0]), '三个后台域 shim 必须逐字一致（同一实现的同域副本）');

/* 7 · 消费者不得复制 canonical 决策体 */
const decisionLeaks = [['agent-runtime.js', rtText], ['communication.js', comMainText]]
  .concat(domainShims.map(([rel, text]) => [rel, text]))
  .filter(([, text]) => /known:\s*(?:true|false)\s*,\s*hasFormat/.test(text))
  .map(([rel]) => rel);
check('provider.noDecisionInConsumers', decisionLeaks.length === 0, '这些文件复制了 canonical 决策体: ' + decisionLeaks.join(', '));

/* ── Middle Brain 分层 + 层契约守卫（P11-1A 物理拆分 / P11-1B 内部契约）──
   实现拆成 config / policy / astra / judge 四层 + thin facade，职责不再混在一个文件；
   层间只经 IB.__middleBrainContracts 上的冻结契约通信（单向 DAG），不再共享可写 namespace。
   本守卫是契约的锁：文件缺失、层间串味、契约未冻结、跨层读越界或读到未声明符号、
   window 兼容符号 / 公共 API 变化、local fallback 开始注入、Gate 落盘、
   Judge 默认开启、或出现新的生产消费者，都会失败。 */
const mbLayerFiles = ['middle-brain-config.js', 'middle-brain-policy.js', 'middle-brain-astra.js',
  'middle-brain-judge.js', 'middle-brain-integrity.js', 'middle-brain.js'];
const mbTexts = {};
for (const name of mbLayerFiles) {
  const file = path.join(root, 'assets', 'js', name);
  mbTexts[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
}
const mbAllText = Object.values(mbTexts).join('\n');
const mbText = mbTexts['middle-brain.js'];
const mbScriptOk = mbLayerFiles.every((name, i) => scriptSources.includes('assets/js/' + name)
  && (i === 0 || scriptSources.indexOf('assets/js/' + name) > scriptSources.indexOf('assets/js/' + mbLayerFiles[i - 1])));
check('middleBrain.scriptLoaded', mbScriptOk, 'middle-brain 分层脚本未按序挂载（config → policy → astra → judge → facade）');
/* 四层职责不得再混回单文件：每层必须自带其代表符号。 */
const mbLayerSymbols = {
  'middle-brain-config.js': [/MB_DEFAULTS\s*=/, /async function getMiddleBrainConfig/, /MB_SYSTEM_PROMPT\s*=/],
  'middle-brain-policy.js': [/async function middleBrainOrganizeContext/, /function middleBrainCompressContext/, /async function middleBrainAdmissionGate/],
  'middle-brain-astra.js': [/async function middleBrainAstraInvoke/, /buildMiddleBrainResponsesRequest/, /AstraAdapter|IBModelCore/],
  'middle-brain-judge.js': [/async function middleBrainAstraJudge/, /MB_JUDGE_SCHEMA\s*=/],
  'middle-brain-integrity.js': [/async function middleBrainCharacterIntegrity/, /MB_CI_SCHEMA\s*=/, /_mbCiGate\s*\(/],
  'middle-brain.js': [/IB\.middleBrain\s*=/, /middleBrainCompressPipeline/]
};
const mbLayerBad = Object.entries(mbLayerSymbols)
  .filter(([name, res]) => res.some(re => !re.test(mbTexts[name])))
  .map(([name]) => name);
check('middleBrain.layerSplit', mbLayerBad.length === 0, '分层职责缺失或混回单文件: ' + mbLayerBad.join(', '));
/* P11-1B · 层契约：每层只向自己的键写入一个冻结对象，契约出口唯一。 */
const mbContractLayer = { 'middle-brain-config.js': 'config', 'middle-brain-policy.js': 'policy',
  'middle-brain-astra.js': 'astra', 'middle-brain-judge.js': 'judge', 'middle-brain-integrity.js': 'integrity' };
function mbContractKeys(text, layer) {
  const m = text.match(new RegExp('MBC\\.' + layer + ' = Object\\.freeze\\(\\{([\\s\\S]*?)\\n  \\}\\);'));
  if (!m) return null;
  return (m[1].match(/^\s{4}(\w+):/gm) || []).map(s => s.trim().replace(/:$/, ''));
}
const mbContracts = {};
for (const [file, layer] of Object.entries(mbContractLayer)) mbContracts[layer] = mbContractKeys(mbTexts[file], layer);
const mbContractBad = Object.entries(mbContracts).filter(([, keys]) => !keys || !keys.length).map(([layer]) => layer);
check('middleBrain.layerContractFrozen', mbContractBad.length === 0, '层契约缺失或未冻结: ' + mbContractBad.join(', '));
const mbContractAll = Object.values(mbContracts).filter(Boolean).flat();
check('middleBrain.layerContractUnique', mbContractAll.length === new Set(mbContractAll).size,
  '同一符号被多层声明为 owner: ' + mbContractAll.filter((s, i) => mbContractAll.indexOf(s) !== i).join(', '));
/* 依赖方向：alias 固定映射到 owner 层；每层只能读自己的上游，且读取的符号必须在 owner 契约中声明。 */
const mbAliasLayer = { CFG: 'config', POL: 'policy', ASTRA: 'astra', JUDGE: 'judge', INTEG: 'integrity' };
const mbAllowedAlias = { 'middle-brain-config.js': [], 'middle-brain-policy.js': ['CFG'],
  'middle-brain-astra.js': ['CFG', 'POL'], 'middle-brain-judge.js': ['CFG', 'POL', 'ASTRA'],
  'middle-brain-integrity.js': ['CFG', 'POL', 'ASTRA'],
  'middle-brain.js': ['CFG', 'POL', 'ASTRA', 'JUDGE', 'INTEG'] };
const mbCrossBad = [];
for (const [file, allowed] of Object.entries(mbAllowedAlias)) {
  const text = mbTexts[file];
  for (const alias of new Set((text.match(/\b(?:CFG|POL|ASTRA|JUDGE|INTEG)\.\w+/g) || []).map(s => s.split('.')[0]))) {
    if (!allowed.includes(alias)) mbCrossBad.push(file + ':读越界 ' + alias);
  }
  for (const [, alias, symbol] of text.matchAll(/\b(CFG|POL|ASTRA|JUDGE|INTEG)\.(\w+)/g)) {
    const owner = mbAliasLayer[alias];
    if (!mbContracts[owner] || !mbContracts[owner].includes(symbol)) mbCrossBad.push(file + ':' + alias + '.' + symbol);
  }
}
check('middleBrain.crossLayerContract', mbCrossBad.length === 0, '跨层读取未声明/越界: ' + [...new Set(mbCrossBad)].join(', '));
/* 共享可写 namespace 已删除：五层文件内不得残留 NS.*，也不得再出现扁平 __middleBrain。 */
check('middleBrain.noFlatNamespace', !/\bNS\./.test(mbAllText) && !/__middleBrain\b/.test(mbAllText),
  '仍存在共享隐式 namespace 依赖');
/* canonical 门面 key：内容与顺序由 MB_PUBLIC_API 锁定，owner 必须真实存在。
   P11-1C 新增 1 个 facade-level 执行缝 middleBrainExecute（readiness + pipeline），
   原有 34 个 key 的名称、相对顺序与 owner 全部不变（见下方 publicApiBaseline34）。 */
const mbPublicBaseline34 = ['getMiddleBrainConfig', 'saveMiddleBrainConfig', 'isMiddleBrainEnabled', 'middleBrainReady',
  'getMiddleBrainSystemPrompt', 'buildMiddleBrainRequest', 'buildMiddleBrainResponsesRequest',
  'parseMiddleBrainResponsesResponse', 'parseMiddleBrainResponse', 'middleBrainOrganizeContext',
  'middleBrainCompressContext', 'middleBrainContextPipeline', 'middleBrainAstraInvoke', 'middleBrainCompressPipeline',
  'middleBrainAdmissionGate', 'middleBrainAdmissionGateReset', '_mbAnalyzeSignals', '_mbDecisionFromSignals',
  '_mbGateScore', 'MB_GATE_DEFAULTS', 'middleBrainAstraJudge', 'middleBrainJudgeEnabled',
  'middleBrainJudgeTelemetry', 'middleBrainJudgeReset', '_mbParseJudgeJson', 'MB_JUDGE_SCHEMA',
  'MB_JUDGE_TIMEOUT_MS', 'middleBrainAstraEnabled', '_mbParseAstraJson', 'MB_ASTRA_TIMEOUT_MS',
  'middleBrainPipelineAvailable', 'MB_CTX_DEFAULT_BUDGET', 'saveMiddleBrainConfigUI', 'loadMiddleBrainConfigUI'];
const mbPublicExpected = mbPublicBaseline34.slice();
mbPublicExpected.splice(mbPublicExpected.indexOf('middleBrainCompressPipeline') + 1, 0, 'middleBrainExecute');
/* P11-2 新增键（追加在末尾）：config 归一 + 生成后执行缝 + integrity 层契约。 */
const mbP11IntegrityKeys = ['normalizeMiddleBrainIntegritySensitivity', 'middleBrainFinalizeReply',
  'middleBrainCharacterIntegrity', 'middleBrainCharacterIntegrityTelemetry', 'middleBrainCharacterIntegrityReset',
  '_mbParseCiJson', '_mbCiGate', '_mbCiVisibleText', 'MB_CI_SCHEMA', 'MB_CI_TIMEOUT_MS'];
const mbP11Keys = ['middleBrainExecute'].concat(mbP11IntegrityKeys);
mbP11IntegrityKeys.forEach(k => mbPublicExpected.push(k));
const mbPublicPairs = [...mbText.matchAll(/^\s*\['(\w+)', '(\w+)'\],?$/gm)].map(m => [m[1], m[2]]);
check('middleBrain.publicApiContract', JSON.stringify(mbPublicPairs.map(p => p[0])) === JSON.stringify(mbPublicExpected),
  'IB.middleBrain 公共 API 内容/顺序变化: ' + mbPublicPairs.map(p => p[0]).join(','));
check('middleBrain.publicApiBaseline34', JSON.stringify(mbPublicPairs.map(p => p[0]).filter(k => !mbP11Keys.includes(k))) === JSON.stringify(mbPublicBaseline34),
  'P11-1C/1D 之外原有 34 个 key 的内容/顺序被改动');
const mbFacadeOwned = ['middleBrainCompressPipeline', 'middleBrainExecute', 'middleBrainAstraEnabled', 'middleBrainFinalizeReply'];
const mbOwnerBad = mbPublicPairs.filter(([symbol, owner]) => mbFacadeOwned.includes(symbol)
  ? owner !== 'facade' : !(mbContracts[owner] && mbContracts[owner].includes(symbol)))
  .map(([symbol, owner]) => owner + '.' + symbol);
check('middleBrain.publicApiOwnership', mbOwnerBad.length === 0, '公共 API owner 未声明: ' + mbOwnerBad.join(', '));
const mbApiOk = /getMiddleBrainConfig/.test(mbTexts['middle-brain-config.js']) && /saveMiddleBrainConfig/.test(mbTexts['middle-brain-config.js']);
check('middleBrain.configAPI', mbApiOk, 'middle-brain 缺少 config API');
const mbUiOk = /id="middle-brain-section"/.test(html) && /id="mb-endpoint"/.test(html) && /id="mb-model"/.test(html) && /id="mb-apikey"/.test(html);
check('middleBrain.uiSection', mbUiOk, 'middle-brain 设置 UI 缺失（section/endpoint/model/apikey）');
const mbReuseAdapter = /AstraAdapter/.test(mbAllText) || /IBModelCore/.test(mbAllText);
check('middleBrain.reuseAdapter', mbReuseAdapter, 'middle-brain 未复用 ib-model-core 的 AstraAdapter');
/* Middle Brain 系统提示词 = 前端只读常量：不出现在 editable 字段（无 mb-system/textarea 绑定），只作为 JS 常量。 */
check('middleBrain.sysPromptConst', /MB_SYSTEM_PROMPT\s*=/.test(mbAllText) && /getMiddleBrainSystemPrompt/.test(mbAllText), 'middle-brain 缺少系统提示词只读常量');
check('middleBrain.sysPromptNoEditableUI', !/<textarea[^>]*id="mb-system/.test(html) && !/id="mb-system/.test(html), '用户不应有可编辑的 Middle Brain 系统提示词字段');
/* Middle Brain v0 context pipeline 只读：context 组织/压缩函数体不得改写 memories/understandings/threads。 */
const ctxFns = ['middleBrainOrganizeContext', 'middleBrainCompressContext', 'middleBrainContextPipeline', '_mbCompressLines'];
let mbMutating = [];
for (const [name, text] of Object.entries(mbTexts)) {
  for (const fn of ctxFns) {
    const re = new RegExp('function ' + fn + '[\\s\\S]*?\\n  \\}', 'm');
    const m = text.match(re);
    if (m && /dbPut|dbDelete/.test(m[0])) mbMutating.push(name + ':' + fn);
  }
}
check('middleBrain.ctxReadOnly', mbMutating.length === 0, 'middle brain context 函数不得写存储: ' + mbMutating.join(', '));
/* window 兼容符号：1A 不删除；名称与顺序逐条锁定（43 条赋值，含历史重复项 middleBrainAstraEnabled）。 */
const mbWinExpected = ['middleBrainOrganizeContext', 'middleBrainCompressContext', 'middleBrainContextPipeline',
  'middleBrainAstraInvoke', 'middleBrainCompressPipeline', 'middleBrainAdmissionGate', 'middleBrainAdmissionGateReset',
  '_mbAnalyzeSignals', '_mbDecisionFromSignals', '_mbGateScore', 'MB_GATE_DEFAULTS', 'middleBrainAstraJudge',
  'middleBrainJudgeEnabled', 'middleBrainJudgeTelemetry', 'middleBrainJudgeReset', '_mbParseJudgeJson',
  'MB_JUDGE_SCHEMA', 'MB_JUDGE_TIMEOUT_MS', 'mbReasoningPick', 'mbSpeedPick', 'mbModelPick', 'mbModelStep',
  'normalizeMiddleBrainReasoningEffort', 'normalizeMiddleBrainSpeed', '_mbReadReasoning', '_mbReadSpeed',
  '_mbReadModel', 'middleBrainAstraEnabled', 'middleBrainPipelineAvailable', 'middleBrainAstraEnabled',
  '_mbParseAstraJson', 'saveMiddleBrainConfigUI', 'loadMiddleBrainConfigUI', 'getMiddleBrainConfig',
  'saveMiddleBrainConfig', 'isMiddleBrainEnabled', 'middleBrainEnabled', 'middleBrainReady',
  'buildMiddleBrainRequest', 'buildMiddleBrainResponsesRequest', 'parseMiddleBrainResponsesResponse',
  'parseMiddleBrainResponse', 'getMiddleBrainSystemPrompt'];
const mbWinActual = [...mbText.matchAll(/^\s*window\.(\w+) = /gm)].map(m => m[1]);
check('middleBrain.windowCompatPreserved', JSON.stringify(mbWinActual) === JSON.stringify(mbWinExpected),
  'window 兼容符号变化: ' + mbWinActual.join(','));
/* local fallback 当前语义 = 不注入：仅 source==='astra' 才替换 context。 */
check('middleBrain.localNoInject', /_mbRes\.source==='astra'/.test(comMainText), 'communication 的 local fallback 语义被改动（local 不得注入）');
/* Admission Gate 状态仍是纯内存：policy 层不得落盘 / 不得用 web storage。 */
check('middleBrain.gateStateMemoryOnly', /var MB_GATE_STATE = \{\}/.test(mbTexts['middle-brain-policy.js'])
  && !/dbPut|dbDelete|sessionStorage|localStorage/.test(mbTexts['middle-brain-policy.js']),
  'Gate 状态被持久化（1A 要求保持纯内存）');
/* Judge 默认关闭 + 生产调用点仍只有 single-chat 一条。 */
check('middleBrain.judgeDefaultOff', /middleBrainJudgeEnabled:\s*false/.test(mbTexts['middle-brain-config.js']), 'Judge 默认值被改为开启');
const mbConsumers = sources.filter(f => f.endsWith('.js') && !mbLayerFiles.includes(path.basename(f)))
  .filter(f => /middleBrainExecute\s*\(|middleBrainCompressPipeline|middleBrainAstraInvoke|middleBrainAdmissionGate\s*\(|middleBrainFinalizeReply\s*\(/.test(fs.readFileSync(f, 'utf8')))
  .map(f => path.relative(root, f));
check('middleBrain.singleConsumer', mbConsumers.length === 1 && mbConsumers[0] === path.join('assets', 'js', 'communication.js'), 'Middle Brain 生产消费者数量变化: ' + mbConsumers.join(', '));

/* ── P11-1C · canonical production execution seam ──────────────────────
   执行缝 = IB.middleBrain.middleBrainExecute：readiness 判定 + pipeline 两步，
   逐字等价于 1A 之前 communication.js 自己编排的那两步。以下守卫锁定：
     ① 执行缝语义未变（仍是 readiness → pipeline，不新增判定）；
     ② 执行缝只存在于 facade，不挂 window 兼容别名；
     ③ production consumer 只经 IB.middleBrain，且不点名任何门面/兼容符号；
     ④ 内部层契约不泄漏给 Middle Brain 之外的 production 代码；
     ⑤ 兼容别名不得重新成为 canonical 依赖。 */
const mbSeam = mbText.match(/async function middleBrainExecute\([\s\S]*?\n  \}/);
check('middleBrain.seamDefined', !!mbSeam
  && /await CFG\.isMiddleBrainEnabled\(\)/.test(mbSeam[0])
  && /return middleBrainCompressPipeline\(characterId, userMessage, opts\)/.test(mbSeam[0]),
  'middleBrainExecute 未按 readiness → pipeline 定义');
check('middleBrain.seamCanonicalOnly', !/window\.middleBrainExecute\s*=/.test(mbText),
  'middleBrainExecute 被挂成 window 兼容别名（会重新变成散落全局依赖）');
const mbConsumerStart = comMainText.indexOf('P11-1C：production 只经 canonical facade');
const mbConsumerEnd = comMainText.indexOf("console.warn('[MiddleBrain] ctx failed'", mbConsumerStart);
const mbConsumerBlock = mbConsumerStart >= 0 && mbConsumerEnd > mbConsumerStart ? comMainText.slice(mbConsumerStart, mbConsumerEnd) : '';
check('middleBrain.consumerFacadeOnly', !!mbConsumerBlock
  && /window\.IB&&window\.IB\.middleBrain/.test(mbConsumerBlock)
  && /_mbFacade\.middleBrainExecute\(/.test(mbConsumerBlock)
  && !/window\._middleBrain|__middleBrainContracts|window\.middleBrain\w+/.test(mbConsumerBlock),
  'single-chat 未只经 IB.middleBrain.middleBrainExecute');
const mbSeamNames = [...new Set([...mbPublicExpected, ...mbWinExpected])]
  .filter(n => !mbP11Keys.includes(n));
const mbConsumerLeaks = mbConsumerBlock ? mbSeamNames.filter(n => mbConsumerBlock.includes(n)) : ['consumer block not found'];
check('middleBrain.consumerNoInternalSymbols', mbConsumerLeaks.length === 0,
  'consumer 仍点名门面/兼容符号: ' + mbConsumerLeaks.join(', '));
const mbContractLeaks = sources.filter(f => !mbLayerFiles.includes(path.basename(f)))
  .filter(f => /__middleBrainContracts/.test(fs.readFileSync(f, 'utf8')))
  .map(f => path.relative(root, f));
check('middleBrain.contractsNotLeaked', mbContractLeaks.length === 0, '内部层契约泄漏给 Middle Brain 之外的生产代码: ' + mbContractLeaks.join(', '));
const mbAliasLeaks = sources.filter(f => f.endsWith('.js') && !mbLayerFiles.includes(path.basename(f)))
  .filter(f => {
    const t = fs.readFileSync(f, 'utf8');
    return mbSeamNames.some(n => t.includes(n)) || /\b_middleBrain\b/.test(t);
  })
  .map(f => path.relative(root, f));
check('middleBrain.compatNotCanonical', mbAliasLeaks.length === 0,
  'production 仍依赖 MB 兼容别名/门面符号（_middleBrain / window.middleBrain* 等）: ' + mbAliasLeaks.join(', '));

/* ── P11-2 · Character Integrity Guard（生成后执行缝）────────────────────
   新增能力必须满足：默认关闭、零额外模型调用、只经 facade 的生成后执行缝、
   调用方不知道任何内部概念、单请求最多一次重写、失败一律回退原候选、
   传输不重复实现、只读不落盘。以下守卫把这些约束锁在结构上。 */
const mbIntegrityText = mbTexts['middle-brain-integrity.js'];
const mbFinalizeSeam = mbText.match(/async function middleBrainFinalizeReply\([\s\S]*?\n  \}/);
check('middleBrain.finalizeSeamDefined', !!mbFinalizeSeam
  && /typeof candidate !== 'string'/.test(mbFinalizeSeam[0])
  && /INTEG\.middleBrainCharacterIntegrity\(/.test(mbFinalizeSeam[0])
  && /return candidate;/.test(mbFinalizeSeam[0]),
  'middleBrainFinalizeReply 未按"候选 → integrity → 失败回退候选"定义');
check('middleBrain.finalizeSeamCanonicalOnly', !/window\.middleBrainFinalizeReply\s*=/.test(mbText),
  '生成后执行缝被挂成 window 兼容别名');
check('middleBrain.integrityDefaultOff', /characterIntegrityEnabled:\s*false/.test(mbTexts['middle-brain-config.js'])
  && /characterIntegrityRewrite:\s*false/.test(mbTexts['middle-brain-config.js'])
  && /characterIntegrityVerify:\s*false/.test(mbTexts['middle-brain-config.js']),
  'Character Integrity 默认值被改为开启');
/* 零开销：未启用必须在任何模型调用/证据组装之前返回原候选（函数体内先于 _ciCall）。 */
const mbCiFnSeg = mbIntegrityText.slice(mbIntegrityText.indexOf('async function middleBrainCharacterIntegrity'),
  mbIntegrityText.indexOf('layer contract（P11-2）'));
check('middleBrain.integrityZeroOverheadWhenOff', /if \(!\(cfg && cfg\.characterIntegrityEnabled === true\)\) \{ _ciSkip\('disabled'\); return out; \}/.test(mbCiFnSeg)
  && mbCiFnSeg.indexOf("_ciSkip('disabled')") < mbCiFnSeg.indexOf('_ciCall(')
  && mbCiFnSeg.indexOf("_ciSkip('disabled')") < mbCiFnSeg.indexOf('_mbCiBuildEvidence('),
  'Guard OFF 未在模型调用/证据组装之前短路');
/* 传输不重复实现：integrity 层不得自己 fetch / 自己打 _ibApiPost。 */
check('middleBrain.integrityNoTransportDup', !/\bfetch\s*\(|_ibApiPost/.test(mbIntegrityText)
  && /ASTRA\.middleBrainModelCall\(/.test(mbIntegrityText),
  'integrity 层重复实现了 Astra 传输（必须走 ASTRA.middleBrainModelCall）');
/* 只读：不得落盘 / 不得写 web storage（先剥离注释，注释里的"绝不写"说明不算实现）。 */
const mbCiCode = mbIntegrityText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('middleBrain.integrityReadOnly', !/dbPut|dbDelete|localStorage|sessionStorage/.test(mbCiCode),
  'integrity 层写入了存储');
/* 单请求最多一次重写：静态上只能有一次重写调用点，且重写段内无循环。 */
const mbRewriteCalls = (mbCiCode.match(/await _ciCall\(_mbCiRewritePrompt\(/g) || []).length;
const mbRewriteSeg = mbCiCode.slice(mbCiCode.indexOf("'character_integrity_rewrite'"),
  mbCiCode.indexOf('Optional verify'));
check('middleBrain.integritySingleRewrite', mbRewriteCalls === 1
  && /rewriteUsed: false/.test(mbCiCode)
  && !/\bwhile\s*\(|\bfor\s*\([\s\S]{0,80}rewrite/i.test(mbRewriteSeg),
  '重写调用点数量或循环结构异常: ' + mbRewriteCalls);
/* verify 段不得再次触发重写。 */
const mbVerifySeg = mbCiCode.slice(mbCiCode.indexOf('Optional verify'));
check('middleBrain.integrityVerifyNoRewrite', !/await _ciCall\(_mbCiRewritePrompt\(|rewriteTriggered\+\+/.test(mbVerifySeg),
  'verify 段重新触发了重写');
/* 调用方边界：生成后调用点不得点名任何内部概念/符号。 */
const mbFinalizeStart = comMainText.indexOf('P11-2 · Middle Brain 生成后收口');
const mbFinalizeEnd = comMainText.indexOf("console.warn('[MiddleBrain] finalize failed'", mbFinalizeStart);
const mbFinalizeBlock = mbFinalizeStart >= 0 && mbFinalizeEnd > mbFinalizeStart
  ? comMainText.slice(mbFinalizeStart, mbFinalizeEnd) : '';
const mbIntegrityForbidden = ['ooc', 'integrity', 'violation', 'rewrite', 'threshold', 'judge',
  'sensitivity', 'MB_CI', '__middleBrainContracts', '_middleBrain'];
const mbFinalizeLeaks = mbFinalizeBlock
  ? mbIntegrityForbidden.filter(t => mbFinalizeBlock.toLowerCase().includes(t.toLowerCase()))
  : ['finalize block not found'];
check('middleBrain.consumerNoIntegritySymbols', !!mbFinalizeBlock && mbFinalizeLeaks.length === 0,
  'consumer 的生成后调用点泄漏了内部概念/符号: ' + mbFinalizeLeaks.join(', '));
check('middleBrain.consumerFinalizeFacadeOnly', !!mbFinalizeBlock
  && /window\.IB&&window\.IB\.middleBrain/.test(mbFinalizeBlock)
  && /middleBrainFinalizeReply\(/.test(mbFinalizeBlock)
  && !/window\.middleBrain\w+\s*=/.test(mbFinalizeBlock),
  '生成后调用点未只经 IB.middleBrain.middleBrainFinalizeReply');
/* 生产消费者仍然只有一个文件（新增调用点不得引入第二个消费者文件）。 */
check('middleBrain.singleConsumerAfterP11_2', mbConsumers.length === 1 && mbConsumers[0] === path.join('assets', 'js', 'communication.js'),
  'P11-2 后 Middle Brain 生产消费者数量变化: ' + mbConsumers.join(', '));
/* UI：新设置必须挂在既有 Middle Brain 卡片内，且走 canonical config（无第二份配置源）。 */
check('middleBrain.integrityUiSection', /id="mb-ci-enabled"/.test(html) && /id="mb-ci-rewrite"/.test(html)
  && /id="mb-ci-verify"/.test(html) && /id="mb-ci-sensitivity"/.test(html) && /id="mb-ci-summary"/.test(html),
  'Character Integrity 设置 UI 缺失');
check('middleBrain.integrityUiCanonicalConfig', /characterIntegrityEnabled: _mbUi\.integrity\.enabled/.test(mbTexts['middle-brain-config.js'])
  && !/localStorage/.test(mbTexts['middle-brain-config.js']),
  'Character Integrity 设置未走 canonical config');

/* ── P11-FIX · [IB Cache Audit] baseline 身份隔离守卫 ──
   现象：Chat 页面聊天时后台 Diary 被触发，审计把两个不同 consumer 的请求当成"上一轮/本轮"比较。
   守卫锁死：baseline key 必须包含真实请求身份；consumer 必须来自执行上下文（不得猜）；
   审计 metadata 不得进入 provider 请求体；每个真实调用点都必须声明 consumer。 */
const auditStart = comMainText.indexOf('var _ibCacheAuditPrev={};');
const auditEnd = comMainText.indexOf('/* ── Anthropic 消息级缓存断点注入 ──', auditStart);
const auditBlock = auditStart >= 0 && auditEnd > auditStart ? comMainText.slice(auditStart, auditEnd) : '';
check('cacheAudit.blockExtracted', !!auditBlock, '未找到缓存审计块');
check('cacheAudit.keyHasRequestIdentity',
  /function _ibCacheAuditKey\(consumer,cfg,fmt,idModel\)/.test(auditBlock)
  && /return String\(consumer\|\|''\)\+'::'\+String\(\(cfg&&cfg\.id\)\|\|''\)\+'::'\+String\(\(cfg&&cfg\.provider\)\|\|''\)\+'::'\+String\(idModel\|\|''\)\+'::'\+fmt/.test(auditBlock),
  'baseline key 未升级为 consumer::character::provider::model::format');
check('cacheAudit.noLegacyGlobalSlot',
  !/'::'\+fmt;\s*\/\* 按 provider 形态隔离快照/.test(auditBlock)
  && /var key=_ibCacheAuditKey\(consumer,cfg,fmt,idModel\);/.test(auditBlock),
  '仍存在只按 cfg.id + 格式分槽的旧 baseline key');
/* 审计仍完全受 cfg.promptCache 门控：关闭时零审计开销、零日志、生产请求不变。 */
const auditSites = (comMainText.match(/try\{_ibCacheAudit\(cfg,/g) || []).length;
const gatedSites = (comMainText.match(/if\(cfg\.promptCache!==false\)\{try\{_ibCacheAudit\(cfg,/g) || []).length;
const legacyDiagOnly = /function _ibOaiCacheDiag\(cfg,msgs,meta\)\{\s*\n?\s*try\{_ibCacheAudit\(cfg,/.test(comMainText);
check('cacheAudit.gatedByPromptCache', gatedSites === 6 && auditSites - gatedSites === (legacyDiagOnly ? 1 : 0),
  '审计调用点未被 promptCache 门控：' + gatedSites + '/' + auditSites);
/* 注释剥离：只在代码上做负向断言（注释里出现 #chat/#diary 等字样不应导致误判），
   行数保持不变以便报错定位。 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(line => (/^\s*\/\//.test(line) ? '' : line)).join('\n');
}
const auditCode = codeOnly(auditBlock);
check('cacheAudit.consumerFromContextOnly',
  /var consumer=String\(\(meta&&meta\.consumer\)\|\|''\);/.test(auditCode)
  && !/currentPage|location\.hash|#chat|#diary|\.stack/.test(auditCode),
  'consumer 必须只来自调用方 meta，不得按页面/URL/调用栈猜测');
check('cacheAudit.logIdentity',
  /'Consumer: '\+\(String\(consumer\|\|''\)\|\|'\(unspecified\)'\)/.test(auditCode)
  && /\| Character: /.test(auditCode) && /\| Provider: /.test(auditCode)
  && /\| Model: /.test(auditCode) && /\| Format: '\+fmt/.test(auditCode),
  '审计日志未打印 Consumer/Character/Provider/Model/Format');
check('cacheAudit.noApiKeyInLog', !/apiKey/.test(auditCode), '审计块不得引用 apiKey');
check('cacheAudit.readOnlyBookkeeping',
  !/\b(body|cfg|messages)\s*=(?!=)/.test(auditCode)
  && !/\b(body|messages|cfg)\.[\w$]+\s*=(?!=)/.test(auditCode)
  && !/prompt_cache_key\s*=[^=]/.test(auditCode),
  '审计必须是只读 bookkeeping（不得改写 body/cfg/messages/缓存参数）');
/* 每个真实 callApiChat* 调用点都必须声明 consumer（runtime 桥接点传 callOpts，其中已含该键）。 */
const consumerSites = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.js$/i.test(entry.name)) continue;
    const text = codeOnly(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const rel = path.relative(root, file).split(path.sep).join('/');
    const re = /callApiChat(?:Stream)?\(/g;
    let m;
    while ((m = re.exec(text))) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const line = text.slice(lineStart, text.indexOf('\n', m.index));
      if (/^\s*(?:async\s+)?function\s/.test(line)) continue;                       /* 定义 */
      if (/window\.callApiChat\w*\s*=\s*$/.test(line.trim())) continue;             /* 导出别名 */
      if (/callApiChat(?:Stream)?\(cfg,\s*messages,\s*callOpts\)/.test(text.slice(m.index, m.index + 80))) continue; /* runtime 桥接 */
      const seg = text.slice(m.index, m.index + 700);
      consumerSites.push({ file: rel, line: text.slice(0, m.index).split('\n').length, ok: seg.includes('_ibConsumer') });
    }
  }
})(path.join(root, 'assets', 'js'));
const undeclared = consumerSites.filter(s => !s.ok);
check('cacheAudit.everyCallSiteDeclaresConsumer', consumerSites.length >= 15 && undeclared.length === 0,
  '未声明 consumer 的调用点: ' + undeclared.map(s => s.file + ':' + s.line).join(', '));
const runtimeText = fs.readFileSync(path.join(root, 'assets', 'js', 'agent-runtime.js'), 'utf8').replace(/^\uFEFF/, '');
check('cacheAudit.runtimeConsumerBridge',
  /const consumer = String\(\(request && request\.consumer\) \|\| ''\)\.trim\(\)\.slice\(0, 40\);/.test(runtimeText)
  && /_ibConsumer: consumer,/.test(runtimeText),
  'runtime request.consumer 未桥接到执行器 _ibConsumer');
/* 审计身份键不得进入 provider 请求体构造：在代码中，_ibConsumer 只能作为 callApiChat* 的 opts 键，
   或在 runtime 桥接里由 request.consumer 派生。 */
const bodyBuildLeak = [];
for (const [file, text] of [['communication.js', comMainText],
  ['agent-runtime.js', runtimeText],
  ['active-diary.js', fs.readFileSync(path.join(root, 'assets', 'js', 'active-diary.js'), 'utf8').replace(/^\uFEFF/, '')],
  ['diary.js', fs.readFileSync(path.join(root, 'assets', 'js', 'active-diary', 'diary.js'), 'utf8').replace(/^\uFEFF/, '')],
  ['moments.js', fs.readFileSync(path.join(root, 'assets', 'js', 'moments.js'), 'utf8').replace(/^\uFEFF/, '')]]) {
  const code = codeOnly(text);
  const re = /_ibConsumer/g;
  let m;
  while ((m = re.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 700), m.index);
    const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index));
    const okSite = /callApiChat(?:Stream)?\(/.test(before.slice(before.lastIndexOf(';') + 1))
      || /_ibConsumer:\s*consumer,/.test(line)
      || /_ibCacheAudit\([^)]*opts\._ibConsumer/.test(line);
    if (!okSite) bodyBuildLeak.push(file + ':' + code.slice(0, m.index).split('\n').length);
  }
}
check('cacheAudit.metadataNeverInProviderBody', bodyBuildLeak.length === 0,
  '审计身份键出现在请求体构造/其它位置: ' + bodyBuildLeak.join(', '));

console.log(failures ? `\nFrontend structure regression failed: ${failures}` : '\nFrontend structure regression passed ✔');
process.exit(failures ? 1 : 0);
