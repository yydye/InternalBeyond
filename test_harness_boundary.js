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
   node test_harness_boundary.js 运行；零依赖。 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'assets', 'js');
const V = path.join(ROOT, 'ib-model-core.js');
const PORT = path.join(__dirname, 'active', 'node-model-port.js');
const COMPAT = path.join(__dirname, 'active', 'node-model-compat.js');
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

const DOMAIN_RE = /\b(_momentsContext|_parseMemOps|_activeParsePlanJson|proactive|moments|letters|social|plan|dnd|dedup|fallback|memory)\b/i;
const WINDOW_RE = /\bwindow\b/;
const DOM_RE = /\b(document|querySelector|getElementById|innerHTML|navigator)\b/;
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

console.log('Harness 边界守卫测试\n');

/* ── 1. IBModelCore：纯 runtime-neutral ── */
{
  const c = code(V);
  check('IBModelCore 不引用 window', !WINDOW_RE.test(c));
  check('IBModelCore 不引用 DOM', !DOM_RE.test(c));
  check('IBModelCore 不引用 fetch()', !FETCH_RE.test(c));
  check('IBModelCore 无 Domain 域符号', !DOMAIN_RE.test(c), (c.match(DOMAIN_RE) || [])[0] || '');
  const requires = (c.match(/require\s*\([^)]*\)/g) || []);
  check('IBModelCore 零 require（纯模块/UMD）', requires.length === 0, requires.join('; '));
}

/* ── 2. NodeModelPort：单次执行 + timeout/abort，无 Domain ── */
{
  const c = code(PORT);
  check('NodeModelPort 不引用 window', !WINDOW_RE.test(c));
  check('NodeModelPort 不引用 DOM', !DOM_RE.test(c));
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

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败' + (knownP1.length ? ('；KNOWN P1: ' + knownP1.join(', ')) : ''));
process.exit(fail ? 1 : 0);
