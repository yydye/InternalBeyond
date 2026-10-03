'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-A.2 · UI Path ↔ Activation Telemetry Coupling Guard
   （Node，零依赖，零浏览器，零网络，不开 Home Node）

   运行：node tests/test_memory_ui_activation_coupling.js

   冻结的问题（R4-A.1 机械发现，R4-A.2 修复）：

     R4A1-ACTIVATION-UI-BYPASS-1
       assets/js/memory.js writeOneLineToMemory(memId)
       在 canonical mode 下也直接改浏览器镜像的
       activationCount / lastActivated —— 绕过 Home Node authority。

     R4A1-ACTIVATION-UI-BYPASS-2
       assets/js/memory.js saveInlineEdit(id)
       把 lastActivated 写成 Date.now()，而 lastActivated 参与
       LegacyMemoryValue 的 recency（decayFactor），于是"编辑内容"被人为
       算成"刚被召回"。

   本测试**不是** regex 断言：它把两个**真实生产函数**抽出来在隔离 vm 里执行
   （helpers/activation-wiring-probe.js），并对结果做行为断言，然后用
   **生产 scorer**（assets/js/memory-recall/scoring.js）证明：
   只编辑内容不得提升 recency score。

   语义前提（R4-A.2 §3/§4 机械审计的结论）：
     · activationCount / lastActivated 的唯一生产写者是
       getMemoryContext → recordMemoryActivation，即"被**召回选中**"的计数；
     · writeOneLineToMemory 的产品语义是**产出内容**（写 mem.oneLine：
       斜体引言 + 随机播放池），不是召回；
     · saveInlineEdit 的产品语义是**编辑表单保存**，不是召回；
     · 仓库里**没有任何** contract / doc / test 要求这两条路径改激活遥测。
   因此两条路径都**不得**触碰 activation 遥测，也不需要走 /memory/activate。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require('./helpers/activation-wiring-probe.js');
const SCORING = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'scoring.js'));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1700000000000;

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const PROBE = JSON.parse(execFileSync(
  process.execPath,
  [path.join(__dirname, 'helpers', 'activation-wiring-probe.js')],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).ui;
const S = PROBE.scenarios;
const MODES = ['canonical', 'mirror', 'off'];

/* ══════════════════════════════════════════════════════════════════════
   §1 · 探针覆盖
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · 探针覆盖');

check('U1.probeCoversBothUiPathsInEveryMode',
  PROBE.probe === 'P21-R4-A.4'
  && MODES.every(m => S['saveInlineEdit@' + m] && S['writeOneLineToMemory@' + m])
  && S.saveInlineEditContentWriteFailure && S.saveInlineEditContentOnly,
  'the vm probe must execute both UI paths in all three modes plus the failure and content-only cases');

/* ══════════════════════════════════════════════════════════════════════
   §2 · writeOneLineToMemory（BYPASS-1）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · writeOneLineToMemory（BYPASS-1 closed）');

MODES.forEach(mode => {
  const row = S['writeOneLineToMemory@' + mode];
  check('U2.writeOneLine' + mode + 'PersistsContent',
    row.oneLine === '雨声让人安心' && row.content === '原始内容' && row.dbPutCalls === 1,
    'the one-liner must still be persisted as content (oneLine written, other content untouched)');
  check('U2.writeOneLine' + mode + 'LeavesActivationTelemetryUntouched',
    row.activationCount === 7 && row.lastActivated === 1600000000000,
    'writing a one-liner must not change activationCount / lastActivated in any mode');
  check('U2.writeOneLine' + mode + 'NeverCallsAuthority',
    row.authorityCalls === 0,
    'writing a one-liner is not an activation event: it must not call the activation authority either');
});

/* ══════════════════════════════════════════════════════════════════════
   §3 · saveInlineEdit（BYPASS-2）
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · saveInlineEdit（BYPASS-2 closed）');

MODES.forEach(mode => {
  const row = S['saveInlineEdit@' + mode];
  check('U3.saveInlineEdit' + mode + 'PersistsContent',
    row.content === '改后的正文' && row.title === '改后的标题' && row.oneLine === '改后的引言'
    && row.dbPutCalls === 1 && row.reconciled === 1 && row.rendered === 1,
    'the edit must still persist content and keep the reference reconciliation / UI refresh');
  check('U3.saveInlineEdit' + mode + 'LeavesActivationTelemetryUntouched',
    row.activationCount === 7 && row.lastActivated === 1600000000000,
    'editing content must not change activationCount / lastActivated in any mode');
  check('U3.saveInlineEdit' + mode + 'NeverCallsAuthority',
    row.authorityCalls === 0,
    'editing content is not an activation event: it must not call the activation authority either');
});

check('U3.contentWriteFailureIsNotSwallowedByTelemetryRewrite',
  S.saveInlineEditContentWriteFailure.outcome === 'mirror-write-failed'
  && S.saveInlineEditContentWriteFailure.activationCount === 7
  && S.saveInlineEditContentWriteFailure.lastActivated === 1600000000000
  && S.saveInlineEditContentWriteFailure.authorityCalls === 0,
  'a failing content write must surface as a failure (pre-existing path, unchanged) '
  + 'and must not leave any activation-telemetry mutation behind');

/* ══════════════════════════════════════════════════════════════════════
   §4 · MemoryValue recency 保护（§13）—— 用**生产 scorer**，不复制公式
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · MemoryValue recency 保护（生产 scorer）');

const contentOnly = S.saveInlineEditContentOnly;
/* 让探针记录的种子 uses 30 天前 activated，这样"把 lastActivated 刷成 now"
   会显著抬高 decayFactor —— 否则这条测试会因为两次都接近 1 而失去分辨力。 */
const beforeRecord = Object.assign({}, contentOnly.before, {
  created: NOW - 60 * DAY,
  lastActivated: NOW - 30 * DAY
});
const afterRecord = Object.assign({}, contentOnly.after, {
  created: beforeRecord.created,
  lastActivated: beforeRecord.lastActivated
});
const oldBehaviour = Object.assign({}, afterRecord, { lastActivated: NOW });

const scoreBefore = SCORING.computeLegacyMemoryValue(beforeRecord, NOW);
const scoreAfter = SCORING.computeLegacyMemoryValue(afterRecord, NOW);
const scoreOldBehaviour = SCORING.computeLegacyMemoryValue(oldBehaviour, NOW);

check('U4.scorerIsProductionScorer',
  typeof SCORING.computeLegacyMemoryValue === 'function'
  && SCORING.computeLegacyMemoryValue({ pinned: true }, NOW) === 999,
  'this guard must use the production scorer (pinned sentinel proves it is the real one)');

check('U4.contentOnlyEditLeavesRecencyScoreIdentical',
  scoreBefore === scoreAfter,
  'editing content only must not change the LegacyMemoryValue (before=' + scoreBefore + ', after=' + scoreAfter + ')');

check('U4.counterproofOldBehaviourWouldInflateTheScore',
  scoreOldBehaviour > scoreAfter,
  'counterproof: if the edit had stamped lastActivated=now the score would rise '
  + '(after=' + scoreAfter + ', old-behaviour=' + scoreOldBehaviour + ') — the removed coupling was real');

check('U4.telemetryFieldsAreTheOnlyDifferenceInTheCounterproof',
  JSON.stringify(Object.keys(beforeRecord).sort()) === JSON.stringify(Object.keys(afterRecord).sort())
  && afterRecord.activationCount === beforeRecord.activationCount,
  'the only mutated field between before/after must be content, never telemetry');

/* ══════════════════════════════════════════════════════════════════════
   §5 · 生产面结构断言（防止回归以其它形状回来）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · 生产面结构断言');

const SOURCE = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory.js'), 'utf8');
const CODE = WIRING.stripJsComments(SOURCE);
const oneLineBody = WIRING.sliceTopLevelFunction(CODE, 'async function writeOneLineToMemory(memId)');
const saveBody = WIRING.sliceTopLevelFunction(CODE, 'async function saveInlineEdit(id)');

check('U5.oneLineWriterHasNoTelemetryAssignment',
  !!oneLineBody
  && !/\.activationCount\s*=/.test(oneLineBody)
  && !/\.lastActivated\s*=(?!=)/.test(oneLineBody),
  'writeOneLineToMemory must contain no activation-telemetry assignment at all');
check('U5.inlineEditHasNoTelemetryAssignment',
  !!saveBody
  && !/\.activationCount\s*=/.test(saveBody)
  && !/\.lastActivated\s*=(?!=)/.test(saveBody),
  'saveInlineEdit must contain no activation-telemetry assignment at all');
check('U5.oneLineWriterStillPersistsContent',
  !!oneLineBody && /mem\.oneLine\s*=/.test(oneLineBody) && /await dbPut\('memories',mem\)/.test(oneLineBody),
  'the fix must remove only the telemetry coupling, not the content write');
check('U5.inlineEditStillPersistsContent',
  !!saveBody && /m\.content\s*=/.test(saveBody) && /await dbPut\('memories',m\)/.test(saveBody)
  && /_reconcileReferences/.test(saveBody),
  'the fix must keep content persistence, reconciliation and UI refresh intact');

/* ══════════════════════════════════════════════════════════════════════
   §6 · 注册
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · 注册');

const TEST_ALL = fs.readFileSync(path.join(ROOT, 'tests', 'test-all.js'), 'utf8');
check('U6.registeredInTestAll',
  TEST_ALL.indexOf("'test_memory_ui_activation_coupling.js'") >= 0
  && TEST_ALL.split("'test_memory_ui_activation_coupling.js'").length - 1 === 1,
  'this guard must be registered exactly once in tests/test-all.js');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY UI ACTIVATION COUPLING FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exit(1);
}
console.log('MEMORY UI ACTIVATION COUPLING PASSED · ' + passed + ' assertions green');
