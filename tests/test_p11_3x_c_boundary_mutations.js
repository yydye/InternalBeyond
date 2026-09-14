/* ====================================================================
   P11-3X-C · Mutation / falsification（Context Budget / Turn-scoped reads / Idle lifecycle）
   --------------------------------------------------------------------
   本文件回答：上面那些性能判据是**被执行钉住的**，还是只是注释？

   做法与 P11-3D / P11-3D.1 / P11-3X-A / P11-3X-B 的 mutation 一致：对生产源码做一次
   **故意的行为破坏**（不是制造语法错误），然后跑真实测试；每个破坏都必须让某一条
   指名判据明确变红。

   变异目标是本阶段的承重决策：
     唯一估算器（M1）、注入归属（M2）、超预算梯子（M3/M4）、
     不可丢块不得被裁（M5）、申报不得超过实测（M6）、
     收藏读取单飞（M7）、线索存证不得退回 N+1（M8）、
     记忆激活读-改-写单事务（M9）、posts 每回合只读一次（M10/M11）、
     引导轮询必须有界（M12/M13）。

   跑不动的变异（锚点找不到 / 不唯一）一律 **UNEXPECTED**：锚点漂移必须被看见。

   ── 安全性质 ────────────────────────────────────────────────────────
   每个变异只在内存里改写文本、写回原文件，随后**按原始字节还原**并校验 SHA-256；
   工作树在结束时必须与开始时逐字节相同（含 BOM 与行尾）。任何退出路径都还原。

   运行：node tests/test_p11_3x_c_boundary_mutations.js
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  core: 'assets/js/context-budget-core.js',
  comm: 'assets/js/communication.js',
  fav: 'assets/js/favorites.js',
  mem: 'assets/js/memory.js',
  site: 'assets/js/site-operations.js',
  base: 'assets/js/basement.js',
  room: 'game/game_room.js'
};
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const orig = {};
for (const k in FILES) { const p = path.join(ROOT, FILES[k]); orig[k] = { p, bytes: fs.readFileSync(p) }; }

const SUITE = 'tests/test_p11_3x_c_context_budget.js';
const runSuite = sections => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, SUITE)], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { P11_3X_C_SECTIONS: sections }),
      timeout: 900000
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const MUTATIONS = [
  { id: 'M1', file: 'core', sections: 'CORE', expect: 'core.singleEstimatorMatchesLegacyModel',
    label: '估算口径被改成"1 字符 = 1 token"（第二套口径悄悄生效）',
    from: "      t += (c >= 0x4e00 && c <= 0x9fff) ? 1 : 0.33;",
    to: "      t += 1;" },

  { id: 'M2', file: 'core', sections: 'CORE', expect: 'core.injectedAttributionExcludesCurrentMessage',
    label: '注入的 tail 不再从"当前用户消息"里扣出来（可压缩块永远压不动）',
    from: "      inj = Math.min(inj, parts.current);\n      parts.current -= inj;\n      parts.injected = inj;",
    to: "      inj = Math.min(inj, parts.current);\n      parts.injected = inj;" },

  { id: 'M3', file: 'core', sections: 'CORE', expect: 'core.overBudgetLadderFires',
    label: '超预算时梯子被旁路（分数恒为 1：有预算之名，无裁剪之实）',
    from: "    if (over && !irreducible && reducible > 0) {",
    to: "    if (false) {" },

  { id: 'M4', file: 'core', sections: 'CORE', expect: 'core.ladderNeverZero',
    label: '阶梯下限被放到 0（"压缩"退化成"整块消失"）',
    from: "    history: 0.2, memory: 0.25, moments: 0.2, thread: 0.2, activity: 0.2, understanding: 0.2",
    to: "    history: 0, memory: 0, moments: 0, thread: 0, activity: 0, understanding: 0" },

  { id: 'M5', file: 'core', sections: 'CORE', expect: 'core.toolsAndSystemNotInLadder',
    label: '不可丢的块被放进可压缩梯子（persona / 当前消息 / 工具定义可被裁）',
    from: "  var LADDER = ['history', 'memory', 'moments', 'thread', 'activity', 'understanding'];",
    to: "  var LADDER = ['system', 'tools', 'history', 'memory', 'moments', 'thread', 'activity', 'understanding'];" },

  { id: 'M6', file: 'core', sections: 'CORE', expect: 'core.declaredCompressibleClampedToMeasured',
    label: '申报值不再按实测值回缩（错误的申报能把 available 算宽）',
    from: "    if (measuredCompressible >= 0 && declared > measuredCompressible && declared > 0) {",
    to: "    if (false) {" },

  { id: 'M7', file: 'fav', sections: 'FIX1', expect: 'fix1.favoritesReadsCoalesced',
    label: 'favorites 读取的单飞被摘掉（每条渲染的气泡各扫一次全表）',
    from: "    if(_favReadP)return _favReadP;",
    to: "    if(false)return _favReadP;" },

  { id: 'M8', file: 'mem', sections: 'FIX2', expect: 'fix2.threadAttestationIsNotNPlusOne',
    label: '线索存证退回每条线索各读一次 memories（N+1 回归）',
    from: "      const att=await _ibAttestDerived(t.visibility,t.evidenceIds||[],characterId,_rows);",
    to: "      const att=await _ibAttestDerived(t.visibility,t.evidenceIds||[],characterId,null);" },

  { id: 'M9', file: 'mem', sections: 'FIX3', expect: 'fix3.activationIsReadModifyWriteInOneTransaction',
    label: '记忆激活退回"先 dbGet 再 dbPut"两步（每条记录两个事务）',
    from: "  const _upd=(typeof window!=='undefined'&&typeof window.dbUpdate==='function')?window.dbUpdate:null;",
    to: "  const _upd=null;" },

  { id: 'M10', file: 'comm', sections: 'FIX4', expect: 'fix4.postsReadOncePerTurn',
    label: 'posts 的预读结果不再传给 buildSiteContext（每回合读两次全表）',
    from: "  const _siteRes=await buildSiteContext(_signals,_postsForSite?{posts:_postsForSite}:null);",
    to: "  const _siteRes=await buildSiteContext(_signals);" },

  { id: 'M11', file: 'site', sections: 'FIX4', expect: 'fix4.postsReadOncePerTurn',
    label: 'buildSiteContext 忽略调用方给的 posts（"复用同一查询结果"被摘掉）',
    from: "    const posts=(opts&&Array.isArray(opts.posts))?opts.posts:await dbGetAll('posts');",
    to: "    const posts=await dbGetAll('posts');" },

  { id: 'M12', file: 'base', sections: 'IDLE', expect: 'idle.noUnboundedSubSecondBootstrapPoll',
    label: 'basement 的引导轮询退回无上限的 400ms（整场会话空转）',
    from: "          t = setInterval(function () { attach(); if (_attached) { settle(); clearInterval(t); } }, 3000);",
    to: "          t = setInterval(function () { attach(); if (_attached) { settle(); clearInterval(t); } }, 400);" },

  { id: 'M13', file: 'room', sections: 'IDLE', expect: 'idle.noUnboundedSubSecondBootstrapPoll',
    label: 'game_room 的引导轮询退回无上限的 500ms（整场会话空转）',
    from: "    _spSlow = setInterval(_onSplashHidden, 3000);",
    to: "    _spSlow = setInterval(_onSplashHidden, 500);" }
];

let unexpected = 0;
const restore = () => { for (const k in orig) fs.writeFileSync(orig[k].p, orig[k].bytes); };

try {
  console.log('── baseline（未变异时必须全绿）──');
  const base = runSuite('');
  const green = base.code === 0;
  if (!green) unexpected++;
  console.log('  ' + (green ? 'GREEN' : 'RED  ') + '  ' + SUITE + (green ? '' : '  *** UNEXPECTED ***'));
  if (!green) console.log(base.out.split('\n').filter(l => /FAIL/.test(l)).slice(0, 8).join('\n'));

  console.log('\n── mutations（每个都必须让**指名的**判据变红）──');
  for (const m of MUTATIONS) {
    const target = orig[m.file];
    const raw = target.bytes.toString('utf8');
    const eol = raw.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const bom = raw.charCodeAt(0) === 0xFEFF;
    const norm = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const from = m.from.replace(/\r\n/g, '\n');
    const to = m.to.replace(/\r\n/g, '\n');
    const hits = norm.split(from).length - 1;
    if (hits !== 1) {
      unexpected++;
      console.log('  ' + m.id + '  *** ANCHOR ' + (hits === 0 ? 'NOT FOUND' : 'AMBIGUOUS(' + hits + ')') + ' ***  ' + m.label);
      continue;
    }
    fs.writeFileSync(target.p, (bom ? '\uFEFF' : '') + norm.replace(from, to).replace(/\n/g, eol));
    let r;
    try { r = runSuite(m.sections); } finally { restore(); }
    const expectedFail = new RegExp('FAIL\\s+' + m.expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(r.out);
    const failCount = (r.out.match(/FAIL  /g) || []).length;
    const syntaxError = /SyntaxError|Unexpected token|Unexpected end of input/.test(r.out);
    const harnessError = /FAIL  harness/.test(r.out);
    const caught = r.code !== 0 && expectedFail && !syntaxError && !harnessError;
    if (!caught) unexpected++;
    console.log('  ' + m.id + '  ' + (caught ? 'CAUGHT  ' : '*** MISSED ***') + '  [' + m.sections + ']  ' + m.label);
    if (caught) {
      console.log('         期望判据变红：' + m.expect + '（该节共 ' + failCount + ' 条 FAIL）');
    } else {
      console.log('         exit=' + r.code + ' expectedFail=' + expectedFail + ' fails=' + failCount
        + ' syntaxError=' + syntaxError + ' harnessError=' + harnessError);
      console.log(r.out.split('\n').slice(-14).join('\n'));
    }
  }
} finally {
  restore();
}

const drift = Object.keys(FILES).filter(k => sha(fs.readFileSync(orig[k].p)) !== sha(orig[k].bytes));
if (drift.length) { unexpected++; console.log('\n*** WORKTREE DRIFT ***  ' + drift.join(',')); }
else console.log('\n工作树逐字节无漂移（' + Object.keys(FILES).length + ' 个文件 SHA-256 全部一致）');

console.log('\n' + (unexpected ? 'UNEXPECTED: ' + unexpected : 'ALL MUTATIONS CAUGHT'));
process.exitCode = unexpected ? 1 : 0;
