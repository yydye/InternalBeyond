/* ====================================================================
   P11-3D · Mutation / falsification
   --------------------------------------------------------------------
   本文件回答的问题：**上面那条边界是承重的，还是装饰的？**

   做法：对生产源码做一次**故意破坏**，然后跑真实测试；
   每个破坏都必须让测试变红，而且红的必须是"被判据抓住"（明确 FAIL），
   不是"语法错误把整份文件炸了就当作抓住了"。

   判据强度：
     · 契约/指纹类变异用 test_p11_3d_tool_guard_contract.js 判定（快，纯 Node）；
     · 预算/去重/熔断/超时类变异用 test_p11_3d_tool_execution_guard.js 判定
       （真实浏览器 + mock provider）—— 因为这些缺陷的形态就在调用链里，
       只有真实执行才能证伪。
   跑不动的变异（锚点找不到）一律 **UNEXPECTED**：锚点漂移必须被看见。

   ── 安全性质 ────────────────────────────────────────────────────────
   每个变异只在内存里改写文本写入临时文件，随后**按原始字节还原**并校验 SHA-256；
   工作树在结束时必须与开始时逐字节相同。任何退出路径（含异常）都还原。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  guard: 'assets/js/tool-execution-guard.js',
  integ: 'assets/js/integrations.js',
  com: 'assets/js/communication.js'
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const orig = {};
for (const k in FILES) { const p = path.join(ROOT, FILES[k]); orig[k] = { p, bytes: fs.readFileSync(p) }; }

const CONTRACT = 'tests/test_p11_3d_tool_guard_contract.js';
const E2E = 'tests/test_p11_3d_tool_execution_guard.js';

/* 判定器：contract = 快；e2e = 真实执行路径（需要 Chrome/Edge） */
const runSuite = (suite) => {
  const rel = suite === 'contract' ? CONTRACT : E2E;
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, rel)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { IB_CDP_TIMEOUT_MS: '60000' }), timeout: 300000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const MUTATIONS = [
  { id: 'M1', suite: 'e2e', file: 'com',
    label: '摘掉循环顶部的轮预算询问（流式路径的"空轮之后"唯一闸门）',
    from: "    if(round>0&&!(_roundBudgetAllows(_fcCtx,userChunk)))break;\n    var hold='',holding=round>0;",
    to: "    var hold='',holding=round>0;" },

  { id: 'M3', suite: 'contract', file: 'guard',
    label: '指纹不稳定（加入随机成分）',
    from: '    return digest(payload);',
    to: '    return digest(payload + Math.random());' },

  { id: 'M4', suite: 'contract', file: 'guard',
    label: '重复检查恒放行（count 永远从 0 开始）',
    from: '      stat.total += 1;',
    to: '      stat.total = 1;' },

  { id: 'M5', suite: 'e2e', file: 'guard',
    label: '重试计数每次重置（重试预算永远用不完）',
    from: '      if (isRetry) stat.retries += 1;',
    to: '      stat.retries = 0;' },

  { id: 'M6', suite: 'e2e', file: 'integ',
    label: '超时不生效（软截止被摘掉，直接等工具返回）',
    from: '        const _deadline = (g && g.policy) ? g.policy().toolCallTimeoutMs : 0;',
    to: '        const _deadline = 0;' },

  { id: 'M7', suite: 'e2e', file: 'integ',
    label: '熔断后仍继续执行工具（整批已授权即照跑）',
    from: "      if(d.allowed && g && g.tripped()) d = { allowed: false, reason: g.tripInfo().reason };",
    to: '' },

  { id: 'M8', suite: 'e2e', file: 'guard',
    label: '软截止到点不熔断（继续等工具返回）',
    from: "        if (timedOut) trip('cycle-timeout', { fp: preview(fp), name: stat.name, note: 'tool-call-timeout' });",
    to: "        if (false) trip('cycle-timeout', { fp: preview(fp), name: stat.name, note: 'tool-call-timeout' });" },

  { id: 'M9', suite: 'e2e', file: 'integ',
    label: '并发回合可以收掉别人的周期（回到本阶段修掉的缺陷形态）',
    from: '    const owns = !!(ctx && ctx._guard);\n    if(!owns) return null;',
    to: '    const owns = true;' },

  { id: 'M10', suite: 'contract', file: 'guard',
    label: '熔断原因集合被打开（多出一个兜底 unknown）',
    from: "    NO_ACTIVE_CYCLE: 'no-active-cycle'",
    to: "    NO_ACTIVE_CYCLE: 'no-active-cycle',\n    UNKNOWN: 'unknown'" }
];

/* 说明（本阶段实测的**鲁棒性**结论，不是遗漏）：
   另有两条"看起来该被抓住"的变异，实测**不是承重代码**，因此不作为判据：
     · 把 `const rd = g.beforeRound()` 换成恒放行 → 循环顶部那次询问仍然拦截，
       且 runRound 返回 done 后回程本就结束（R1/R5/R6 全绿）；
     · 把 runRound 内部 `beforeRound` 的拒绝分支改成"照旧继续"（done:false）
       → 下一轮在循环顶部就被同一条闸门拦下，只是拒绝而不是熔断，回程照样结束
       （provider 调用次数不变，只是 breaker 从"那一次熔断"退回"下一次拒绝"）。
   它们是同一不变的**冗余实现**，删掉任何一条都不会让边界消失 ——
   把这种变异写成"必须 FAIL"，只会逼测试去断言实现细节而不是不变量。
   （这两条是本 harness 自己跑出来的结论：最初它们真的被判成 MISSED，
     追下去才发现是"变异打在了冗余代码上"，而不是"测试不够敏感"。） */

let unexpected = 0;
const restore = () => { for (const k in orig) fs.writeFileSync(orig[k].p, orig[k].bytes); };

try {
  console.log('── baseline（未变异时必须全绿）──');
  for (const suite of ['contract', 'e2e']) {
    const r = runSuite(suite);
    const green = r.code === 0;
    if (!green) unexpected++;
    console.log('  ' + (green ? 'GREEN' : 'RED  ') + '  ' + suite + (green ? '' : '  *** UNEXPECTED ***'));
    if (!green) console.log(r.out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 5).join('\n'));
  }

  console.log('\n── mutations（每个都必须被明确 FAIL 抓住）──');
  for (const m of MUTATIONS) {
    const target = orig[m.file];
    const raw = target.bytes.toString('utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const norm = raw.replace(/\r\n/g, '\n');
    const from = m.from.replace(/\r\n/g, '\n');
    const to = m.to.replace(/\r\n/g, '\n');
    /* 锚点定位：默认要求唯一。允许显式 occurrence（0 基）用于**同一片段在
       文件里合法出现多次**的情形 —— 不做这件事的代价是实测到的：
       `return { done: true, breaker: t }` 在回程与 MCP 轮上限两处都存在，
       而变异脚本改的是第一处，于是"熔断后照旧继续"这条变异永远不会被发现。 */
    const needle = typeof m.occurrence === 'number' ? from : from;
    const hits = norm.split(needle).length - 1;
    if (hits < 1) { unexpected++; console.log('  ' + m.id + '  *** ANCHOR NOT FOUND ***  ' + m.label); continue; }
    if (hits > 1 && typeof m.occurrence !== 'number') { unexpected++; console.log('  ' + m.id + '  *** ANCHOR AMBIGUOUS (' + hits + ') ***  ' + m.label); continue; }
    const occ = typeof m.occurrence === 'number' ? m.occurrence : 0;
    if (occ >= hits) { unexpected++; console.log('  ' + m.id + '  *** OCCURRENCE OUT OF RANGE ***  ' + m.label); continue; }
    let seen = -1, at = -1;
    for (let i = 0; i <= occ; i++) { at = norm.indexOf(needle, seen + 1); seen = at; }
    if (at < 0) { unexpected++; console.log('  ' + m.id + '  *** OCCURRENCE NOT FOUND ***  ' + m.label); continue; }
    fs.writeFileSync(target.p, (norm.slice(0, at) + to + norm.slice(at + needle.length)).replace(/\n/g, eol));
    let r;
    try { r = runSuite(m.suite); } finally { restore(); }
    const fails = (r.out.match(/^\s*FAIL\s/gm) || []).length;
    const syntaxError = /SyntaxError|Unexpected token|Identifier '.*' has already been declared/.test(r.out);
    const caught = r.code !== 0 && fails > 0 && !syntaxError;
    if (!caught) unexpected++;
    console.log('  ' + m.id + '  ' + (caught ? 'CAUGHT  ' : '*** MISSED ***') + '  [' + m.suite + '] ' + m.label);
    if (caught) {
      const first = (r.out.match(/^\s*FAIL\s.*$/m) || [''])[0].trim();
      console.log('         ' + first.slice(0, 150));
    } else {
      console.log('         exit=' + r.code + ' fails=' + fails + ' syntaxError=' + syntaxError);
      console.log(r.out.split('\n').slice(-8).join('\n'));
    }
  }
} finally {
  restore();
}

/* 还原校验：工作树必须与开始时逐字节相同 */
const drift = Object.keys(FILES).filter(k => sha(fs.readFileSync(orig[k].p)) !== sha(orig[k].bytes));
if (drift.length) { unexpected++; console.log('\n*** WORKTREE DRIFT ***  ' + drift.join(',')); }

console.log('\n' + (unexpected ? 'UNEXPECTED: ' + unexpected : 'ALL MUTATIONS CAUGHT'));
process.exitCode = unexpected ? 1 : 0;
