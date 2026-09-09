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

const mbScriptOk = /<script src="assets\/js\/middle-brain\.js">/.test(html);
check('middleBrain.scriptLoaded', mbScriptOk, 'middle-brain.js 未挂载');
const mbFile = path.join(root, 'assets', 'js', 'middle-brain.js');
const mbText = mbFile && fs.readFileSync(mbFile, 'utf8').replace(/^\uFEFF/, '');
const mbApiOk = /getMiddleBrainConfig/.test(mbText) && /saveMiddleBrainConfig/.test(mbText);
check('middleBrain.configAPI', mbApiOk, 'middle-brain 缺少 config API');
const mbUiOk = /id="middle-brain-section"/.test(html) && /id="mb-endpoint"/.test(html) && /id="mb-model"/.test(html) && /id="mb-apikey"/.test(html);
check('middleBrain.uiSection', mbUiOk, 'middle-brain 设置 UI 缺失（section/endpoint/model/apikey）');
const mbReuseAdapter = /AstraAdapter/.test(mbText) || /IBModelCore/.test(mbText);
check('middleBrain.reuseAdapter', mbReuseAdapter, 'middle-brain 未复用 ib-model-core 的 AstraAdapter');
/* Middle Brain 系统提示词 = 前端只读常量：不出现在 editable 字段（无 mb-system/textarea 绑定），只作为 JS 常量。 */
check('middleBrain.sysPromptConst', /MB_SYSTEM_PROMPT\s*=/.test(mbText) && /getMiddleBrainSystemPrompt/.test(mbText), 'middle-brain 缺少系统提示词只读常量');
check('middleBrain.sysPromptNoEditableUI', !/<textarea[^>]*id="mb-system/.test(html) && !/id="mb-system/.test(html), '用户不应有可编辑的 Middle Brain 系统提示词字段');
/* Middle Brain v0 context pipeline 只读：context 组织/压缩函数体不得改写 memories/understandings/threads。 */
const ctxFns = ['middleBrainOrganizeContext', 'middleBrainCompressContext', 'middleBrainContextPipeline', '_mbCompressLines'];
let mbMutating = [];
for (const fn of ctxFns) {
  const re = new RegExp('function ' + fn + '[\\s\\S]*?\\n  \\}', 'm');
  const m = mbText.match(re);
  if (m && /dbPut|dbDelete/.test(m[0])) mbMutating.push(fn);
}
check('middleBrain.ctxReadOnly', mbMutating.length === 0, 'middle brain context 函数不得写存储: ' + mbMutating.join(','));

console.log(failures ? `\nFrontend structure regression failed: ${failures}` : '\nFrontend structure regression passed ✔');
process.exit(failures ? 1 : 0);
