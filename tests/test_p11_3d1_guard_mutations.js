/* ====================================================================
   P11-3D.1 · Mutation / falsification（宿主回合周期所有权）
   --------------------------------------------------------------------
   本文件回答的问题：**上面那条所有权边界是承重的，还是装饰的？**

   做法与 P11-3D 的 mutation 一致：对生产源码做一次**故意破坏**，然后跑真实测试；
   每个破坏都必须让测试变红，而且红的必须是"被判据抓住"（明确 FAIL），
   不是"语法错误把整份文件炸了就当作抓住了"。

   判据：tests/test_p11_3d1_xml_guard_compat.js（真实浏览器 + 真实宿主回合
   sendChatMessage + mock provider/工具端点）。这一组变异**全部**只能在那里判定 ——
   缺陷形态就在"一个宿主回合内两条工具协议 + 并发回合"的调用链里，
   纯离线契约测试看不到它们。

   跑不动的变异（锚点找不到 / 锚点不唯一）一律 **UNEXPECTED**：锚点漂移必须被看见。

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
  com: 'assets/js/communication.js',
  integ: 'assets/js/integrations.js',
  site: 'assets/js/site-operations.js',
  ws: 'assets/js/workspace.js',
  guard: 'assets/js/tool-execution-guard.js'
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const orig = {};
for (const k in FILES) { const p = path.join(ROOT, FILES[k]); orig[k] = { p, bytes: fs.readFileSync(p) }; }

const SUITE = 'tests/test_p11_3d1_xml_guard_compat.js';
const runSuite = () => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, SUITE)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { IB_CDP_TIMEOUT_MS: '60000' }), timeout: 600000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

/* ── 十个变异：一一对应 Phase 7 的清单 ─────────────────────────────────
   每个 from/to 都是**生产源码**里的唯一片段（锚点唯一性由脚本强制检查）。 */
const MUTATIONS = [
  { id: 'M1', file: 'integ', label: '嵌套调用自己开新周期（回到"一次 callApi = 一个周期"的旧模型）',
    from: "    const live = turn.guard;\n    if(live && typeof live.active === 'function' && live.active()){",
    to:   "    const live = turn.guard;\n    if(false){" },

  { id: 'M2', file: 'integ', label: '开周期时不标记 owner ctx（周期真的开了，但宿主不知道自己拥有它）',
    from: '    turn.guard = g;\n    ctx._guardCycle = true;',
    to:   '    turn.guard = g;\n    ctx._guardCycle = false;' },

  { id: 'M3', file: 'ws', label: 'XML 执行点不接收 execution context（guard 传不到工具执行点）',
    from: '      results.push(await _ibExecToolOp(op,authorName,ictx));',
    to:   '      results.push(await _ibExecToolOp(op,authorName));' },

  { id: 'M4', file: 'site', label: 'XML 工具不 beforeCall（授权点被摘掉）',
    from: '  if(_g&&!_replay){ var _deny=_ibGuardAllow(_g,op); if(_deny)return _deny; }',
    to:   '  if(false){ var _deny=_ibGuardAllow(_g,op); if(_deny)return _deny; }' },

  { id: 'M5', file: 'site', label: 'XML 工具不 settleCall（执行不入账：账本显示没发生过）',
    from: '  if(_g&&_settleable&&!_replay)_ibGuardSettle(_g,op,_r);',
    to:   '  if(false&&_settleable&&!_replay)_ibGuardSettle(_g,op,_r);' },

  { id: 'M6', file: 'com', label: '递归续轮重置轮次计数（每层递归重新开始一轮预算）',
    from: '    var _cont=Object.assign({},o,{messages:(o.messages||[]).slice(),round:round,_ibTurn:_turn,guard:_turn.guard});\n    try{',
    to:   '    var _cont=Object.assign({},o,{messages:(o.messages||[]).slice(),round:round,_ibTurn:_turn,guard:_turn.guard});\n    try{ if(_turn&&_turn.guard&&_turn.guard.startCycle)_turn.guard.startCycle({authorized:true});' },

  { id: 'M7', file: 'site', label: 'XML 重复调用恒放行（重复判定被摘掉）',
    from: '  if(d&&d.allowed)return null;',
    to:   '  if(true)return null;' },

  { id: 'M8', file: 'com', label: '后台回合偷走前台的周期实例（归属改由"当前活动周期"推断）',
    from: "    if(turn.guard&&typeof turn.guard.active==='function'&&turn.guard.active())return turn.guard;\n    if(typeof IBFC!=='undefined'&&typeof IBFC.cycleBegin==='function')return IBFC.cycleBegin(turn,null,turn);",
    to:   "    if(typeof IBFC!=='undefined'&&IBFC._tdGuard&&typeof IBFC._tdGuard.active==='function'&&IBFC._tdGuard.active())return IBFC._tdGuard;\n    if(typeof IBFC!=='undefined'&&typeof IBFC.cycleBegin==='function')return IBFC.cycleBegin(turn,null,turn);" },

  { id: 'M9', file: 'guard', label: '工具计数闸门失效：越过 maxToolCalls 仍然执行（限额不再承重）',
    from: "      if (st.ts.length - st.tsCursor >= policy.maxToolCalls) {\n        trip('tool-budget', { used: st.ts.length - st.tsCursor, maxToolCalls: policy.maxToolCalls });\n        return deny(st.trip.reason, { used: st.ts.length - st.tsCursor, maxToolCalls: policy.maxToolCalls });\n      }",
    to:   "      if (false) {\n        trip('tool-budget', { used: st.ts.length - st.tsCursor, maxToolCalls: policy.maxToolCalls });\n        return deny(st.trip.reason, { used: st.ts.length - st.tsCursor, maxToolCalls: policy.maxToolCalls });\n      }" },

  { id: 'M10', file: 'com', label: '外层宿主回合不结束周期（周期悬挂，之后的旧引用仍然可执行）',
    from: 'function _ibTurnCycleEnd(turn){\n  try{',
    to:   'function _ibTurnCycleEnd(turn){\n  if(true)return null;\n  try{' }
];

let unexpected = 0;
const restore = () => { for (const k in orig) fs.writeFileSync(orig[k].p, orig[k].bytes); };

try {
  console.log('── baseline（未变异时必须全绿）──');
  const base = runSuite();
  const green = base.code === 0;
  if (!green) unexpected++;
  console.log('  ' + (green ? 'GREEN' : 'RED  ') + '  ' + SUITE + (green ? '' : '  *** UNEXPECTED ***'));
  if (!green) console.log(base.out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 6).join('\n'));

  console.log('\n── mutations（每个都必须被明确 FAIL 抓住）──');
  for (const m of MUTATIONS) {
    const target = orig[m.file];
    /* 变异落盘必须保留 UTF-8 BOM（这些文件带 BOM，tests/test_frontend_structure.js
       的 encoding.bom 规则会检查；BOM 丢了会把"抓住"变成"文件编码坏了"）。 */
    const raw = target.bytes.toString('utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const norm = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const bom = raw.charCodeAt(0) === 0xFEFF;
    const from = m.from.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const to = m.to.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const hits = norm.split(from).length - 1;
    if (hits !== 1) {
      unexpected++;
      console.log('  ' + m.id + '  *** ANCHOR ' + (hits === 0 ? 'NOT FOUND' : 'AMBIGUOUS(' + hits + ')') + ' ***  ' + m.label);
      continue;
    }
    fs.writeFileSync(target.p, (bom ? '\uFEFF' : '') + norm.replace(from, to).replace(/\n/g, eol));
    let r;
    try { r = runSuite(); } finally { restore(); }
    const fails = (r.out.match(/^\s*FAIL\s/gm) || []).length;
    const syntaxError = /SyntaxError|Unexpected token|Identifier '.*' has already been declared/.test(r.out);
    const harnessError = /HARNESS ERROR/.test(r.out);
    const caught = r.code !== 0 && fails > 0 && !syntaxError && !harnessError;
    if (!caught) unexpected++;
    console.log('  ' + m.id + '  ' + (caught ? 'CAUGHT  ' : '*** MISSED ***') + '  ' + m.label);
    if (caught) {
      const first = (r.out.match(/^\s*FAIL\s.*$/m) || [''])[0].trim();
      console.log('         ' + first.slice(0, 160));
    } else {
      console.log('         exit=' + r.code + ' fails=' + fails + ' syntaxError=' + syntaxError + ' harnessError=' + harnessError);
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
