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
check('split.externalStyleCount', styleSources.length === 18, String(styleSources.length));
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
check('styles.totalInlineBudget', allInlineStyles <= 460, String(allInlineStyles));

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

console.log(failures ? `\nFrontend structure regression failed: ${failures}` : '\nFrontend structure regression passed ✔');
process.exit(failures ? 1 : 0);
