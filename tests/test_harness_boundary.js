/* test_harness_boundary.js — Harness 架构边界守卫（Phase 7B）
   --------------------------------------------------------------------
   静态检查 Harness 核心 4 文件是否保持"runtime-neutral、零 Domain 耦合"的边界：
     assets/js/ib-model-core.js      （纯 provider core）
     active/node-model-port.js       （单次 execution + timeout/abort）
     active/node-model-compat.js     （2 种兼容重试 + legacy <thinking> 归一）
     assets/js/agent-runtime.js      （Browser host；仅记录已知 P1 耦合）
   通过剥离注释后对"代码"做子串/正则扫描，避免被 doc 注释里的"零 window / 零 Proactive 依赖"等字样误报。
   失败时区分：
     REAL VIOLATION   —— 生产代码出现禁止的 Domain/方向依赖 → 测试失败
     KNOWN P1 COUPLING —— agent-runtime.js 的 loadContext/observe 默认（已确认）→ 记录，不判失败
   node tests/test_harness_boundary.js 运行；零依赖。 */
'use strict';

const fs = require('fs');
const path = require('path');

/* 本文件位于 tests/：REPO 是仓库根，ROOT 沿用本文件既有语义（前端脚本目录）。 */
const REPO = path.resolve(__dirname, '..');
const ROOT = path.join(REPO, 'assets', 'js');
const V = path.join(ROOT, 'ib-model-core.js');
const PORT = path.join(REPO, 'active', 'node-model-port.js');
const COMPAT = path.join(REPO, 'active', 'node-model-compat.js');
const RT = path.join(ROOT, 'agent-runtime.js');

/* 剥离块注释 /* *​/ 与行注释 //（尊重字符串，避免 http:// 被误剪） */
function stripComments(code) {
  let out = '', i = 0, n = code.length, inStr = null;
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += code[i + 1] || ''; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; i++; continue; }
    if (c === '/' && d === '*') { let e = code.indexOf('*/', i + 2); if (e < 0) break; i = e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { let e = code.indexOf('\n', i); if (e < 0) break; i = e; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}

/* 剥离字符串字面量内容（保留长度与换行，模板字面量里的 ${...} 仍按代码扫描）。
   P17：URL / 文案里出现 document、navigator 是**纯数据**，不是 DOM 访问；
   只有把它们挖空后再扫描，守卫才不会把
   `https://platform.example.com/document/guides` 误判成 DOM 访问。 */
function stripStrings(code) {
  let out = '', i = 0, n = code.length;
  const stack = [];                       /* '`' = 模板字面量；'{' = 模板表达式；引号 = 字符串 */
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const c = code[i], d = code[i + 1];
    const t = top();
    if (t === '{') {                      /* 模板表达式内部：按代码扫描（含嵌套字符串 / 模板） */
      if (c === '{') { stack.push('{'); out += c; i++; continue; }
      if (c === '}') { stack.pop(); out += (top() === '`' ? ' ' : '}'); i++; continue; }
      if (c === '"' || c === "'") { stack.push(c); out += c; i++; continue; }
      if (c === '`') { stack.push('`'); out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (t === '"' || t === "'") {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === t) { stack.pop(); out += c; i++; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    if (t === '`') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { stack.pop(); out += c; i++; continue; }
      if (c === '$' && d === '{') { stack.push('{'); out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { stack.push(c); out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

const DOMAIN_RE = /\b(_momentsContext|_parseMemOps|_activeParsePlanJson|proactive|moments|letters|social|plan|dnd|dedup|fallback|memory)\b/i;
const WINDOW_RE = /\bwindow\b/;
/* DOM 访问检测（P17 收紧）：
   ① 主检测在「注释 + 字符串字面量内容都挖空」的代码上跑，保留原来的五个保留词，
      检测能力不降低（真实的 document / navigator / querySelector / getElementById /
      innerHTML 仍会被抓到），但 URL 与文案里的同名单词不再误报；
   ② 另外单列「用字符串下标绕过」的形态：window['document'] / self["navigator"]，
      它在 ① 里会被挖空，所以单独用注释剥离后的源码匹配。 */
const DOM_RE = /\b(document|querySelector|getElementById|innerHTML|navigator)\b/;
const DOM_BRACKET_RE = /\b(?:window|self|globalThis|global)\s*\[\s*['"](?:document|navigator)['"]\s*\]/;

function domScan(src) {
  const data = stripStrings(stripComments(String(src)));
  const hits = [];
  const re = new RegExp(DOM_RE.source, 'g');
  let m;
  while ((m = re.exec(data)) !== null) hits.push(m[1]);
  if (DOM_BRACKET_RE.test(stripComments(String(src)))) hits.push("window['document']");
  return hits;
}
const FETCH_RE = /\bfetch\s*\(/;
const FORBID_REQ_RE = /(active\/scheduler|plan-domain|active\/model-client|active-plans|active\/moment|active\/letters|assets\/js\/agent-runtime)/;

let pass = 0, fail = 0, knownP1 = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail != null && detail !== '' ? ' — ' + detail : '')); }
}
function known(name, present) {
  if (present) { knownP1.push(name); console.log('  ◐ KNOWN P1 ' + name); }
  else { fail++; console.log('  ✗ [KNOWN P1 缺失] ' + name); }
}
function read(f) { return fs.readFileSync(f, 'utf8'); }
function code(f) { return stripComments(read(f)); }
function domHits(f) { return domScan(read(f)); }
function domFree(f) { return domHits(f).length === 0; }

console.log('Harness 边界守卫测试\n');

/* ── 1. IBModelCore：纯 runtime-neutral ── */
{
  const c = code(V);
  check('IBModelCore 不引用 window', !WINDOW_RE.test(c));
  check('IBModelCore 不引用 DOM', domFree(V), domHits(V).join(','));
  check('IBModelCore 不引用 fetch()', !FETCH_RE.test(c));
  check('IBModelCore 无 Domain 域符号', !DOMAIN_RE.test(c), (c.match(DOMAIN_RE) || [])[0] || '');
  /* provider metadata 目录（assets/js/provider-directory.js）是 harness 级纯数据模块：
     零 require / 无 window / 无 DOM / 无 fetch / 无 Domain，允许 IBModelCore 依赖它，
     但依赖边界仍被白名单锁死——不得再 require 其它任何模块。 */
  const requires = (c.match(/require\s*\([^)]*\)/g) || []);
  const allowed = requires.every(r => /^require\s*\(\s*['"]\.\/provider-directory\.js['"]\s*\)$/.test(r));
  check('IBModelCore 仅可 require provider-directory（纯 metadata）', allowed && !FORBID_REQ_RE.test(c), requires.join('; '));
  const dir = code(path.join(ROOT, 'provider-directory.js'));
  check('provider-directory 零 require', !/require\s*\(/.test(dir), (dir.match(/require\s*\([^)]*\)/g) || []).join('; '));
  check('provider-directory 不引用 window', !WINDOW_RE.test(dir));
  check('provider-directory 不引用 DOM', domFree(path.join(ROOT, 'provider-directory.js')), domHits(path.join(ROOT, 'provider-directory.js')).join(','));
  check('provider-directory 不引用 fetch()', !FETCH_RE.test(dir));
  check('provider-directory 无 Domain 域符号', !DOMAIN_RE.test(dir), (dir.match(DOMAIN_RE) || [])[0] || '');
}

/* ── 2. NodeModelPort：单次执行 + timeout/abort，无 Domain ── */
{
  const c = code(PORT);
  check('NodeModelPort 不引用 window', !WINDOW_RE.test(c));
  check('NodeModelPort 不引用 DOM', domFree(PORT), domHits(PORT).join(','));
  check('NodeModelPort 无 Domain 域符号', !DOMAIN_RE.test(c), (c.match(DOMAIN_RE) || [])[0] || '');
  const reqs = (c.match(/require\s*\([^)]*\)/g) || []);
  check('NodeModelPort 仅 require Harness(ib-model-core)', reqs.length === 1 && /ib-model-core/.test(reqs[0]), reqs.join('; '));
  check('NodeModelPort 不 require Domain 模块', !FORBID_REQ_RE.test(c));
  check('NodeModelPort 具备 AbortController（abort 能力）', /\bAbortController\b/.test(c));
  check('NodeModelPort 具备 setTimeout（timeout 能力）', /\bsetTimeout\s*\(/.test(c));
  check('NodeModelPort 无重试循环（单次执行）', !/\b(for\s*\(|while\s*\()/.test(c), '出现 for/while 循环');
  check('NodeModelPort 无 jsonMode 降级重试动作', !/jsonMode\s*[=:]\s*false/.test(c));
}

/* ── 3. NodeModelCompat：仅锁定的 2 种重试 + legacy 归一 ── */
{
  const c = code(COMPAT);
  check('ModelCompat 不 require Domain 模块', !FORBID_REQ_RE.test(c) && !/require\s*\(/.test(c), (c.match(/require\s*\([^)]*\)/g) || []).join('; '));
  check('ModelCompat 无 scheduler/state/DND/dedup/fallback 域符号', !/\b(scheduler|state\s*machine|plan-domain|armedUsers|isInDnd|dedup|fallback)\b/i.test(c));
  check('ModelCompat 保留 max_completion_tokens 重试', /max_completion_tokens/i.test(c));
  check('ModelCompat 保留 jsonMode 降级重试', /jsonMode\s*[=:]\s*false/.test(c));
  check('ModelCompat 保留 legacy <thinking> 归一', /<\s*think(?:ing)?\s*>|reasoning_content/i.test(c));
}

/* ── 4. AgentRuntime（Browser host）：无 Domain 依赖；记录 KNOWN P1 ── */
{
  const c = code(RT);
  check('AgentRuntime 不 require 任何模块（浏览器 IIFE）', !/require\s*\(/.test(c), (c.match(/require\s*\([^)]*\)/g) || []).join('; '));
  check('AgentRuntime 不引用 active/*/scheduler/plan-domain', !/active\/|scheduler|plan-domain|plan_schema/.test(c));
  /* KNOWN P1：loadContext/observe 默认指向 Domain 符号 —— 记录为已知，不判失败 */
  known('loadContext → window._momentsContext（KNOWN P1）', /_momentsContext/.test(c));
  known('observe → window._parseMemOps（KNOWN P1）', /_parseMemOps/.test(c));
  known('observe → window._activeParsePlanJson（KNOWN P1）', /_activeParsePlanJson/.test(c));
}

/* ── 5. 依赖方向：Harness 文件不得 require Domain ── */
{
  let bad = [];
  const dirs = [['IBModelCore', code(V)], ['NodeModelPort', code(PORT)], ['ModelCompat', code(COMPAT)], ['AgentRuntime', code(RT)]];
  for (const [name, c] of dirs) {
    if (FORBID_REQ_RE.test(c)) bad.push(name);
  }
  check('Harness→Domain 依赖方向为零（4 文件）', bad.length === 0, bad.join(', '));
}

/* ── 6. 守卫自身的正 / 负测试（P17）──
   负例：URL / 文案里的 document、navigator 是纯数据，不得误判为 DOM 访问。
   正例：真实 DOM 访问（含字符串下标绕过）必须仍然被抓到。
   这一节保护的是「守卫」本身，防止它被改松或被改回裸文本匹配。 */
{
  const negatives = [
    ['URL 路径含 document', 'var u = "https://example.com/documentation";'],
    ['URL 路径段恰为 document', 'var u = "https://platform.example.com/document/guides";'],
    ['URL 文件名含 navigator', 'var u = "https://example.com/navigator.js";'],
    ['文案里出现 DOM 术语', 'var t = "document.querySelector 就是 DOM 访问";'],
    ['模板字面量 URL', 'var t = `https://a.io/document/navigator.html`;'],
    ['模板字面量文案', 'var t = `别写 document.getElementById`;']
  ];
  const positives = [
    ['document.querySelector', 'document.querySelector("#a");'],
    ['document.getElementById', 'document.getElementById("a");'],
    ['window.document', 'window.document.title = "x";'],
    ['navigator', 'var ua = navigator.userAgent;'],
    ['innerHTML', 'el.innerHTML = "";'],
    ['document[...]', 'document["getElementById"]("a");'],
    ['window["document"]', 'window["document"].querySelector("a");'],
    ['模板表达式内 DOM', 'var t = `x${document.title}y`;']
  ];
  for (const [name, src] of negatives) {
    check('DOM 守卫不误伤：' + name, domScan(src).length === 0, domScan(src).join(','));
  }
  for (const [name, src] of positives) {
    check('DOM 守卫仍抓得到：' + name, domScan(src).length > 0, src);
  }
  /* 反向验证：把一个合法的文档 URL 放进 provider-directory 风格的代码里，守卫仍判干净 */
  const withDocUrl = 'var ONBOARDING = { docsUrl: "https://example.com/document/api-navigator", steps: ["打开官网"] };\n';
  check('纯数据模块可安全登记含 document / navigator 的文档 URL', domScan(withDocUrl).length === 0, domScan(withDocUrl).join(','));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败' + (knownP1.length ? ('；KNOWN P1: ' + knownP1.join(', ')) : ''));
process.exit(fail ? 1 : 0);
