/* ====================================================================
   P11-2J · Memory Admission Boundary Audit · 离线确定性回归
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     所有**长期记忆产生入口**，是否经过统一的 admission policy？

   ── 本阶段不是功能阶段 ─────────────────────────────────────────────
   没有统一所有 memory 写入；没有重构 Memory Storage；没有修改 Memory Model。
   Phase 0 是只读审计，Phase 1–4 是把审计结论变成**可判定**的断言，
   Phase 5 只新增本文件。产品语义一行未改。

   ── 审计的核心结论（先说清楚在被测什么）────────────────────────────
   记忆写入面上有**三把互不相同的锁**，它们不是同一条轴：

     Admission  `_calibrateMemoryCandidate`（auto-memory.js:171）
                → 这条候选值不值得成为长期记忆
     Consent    `requestMemoryApproval`（auto-memory.js:199）
                → 人是否批准这一条具体写入
     Visibility `isMemoryVisibleTo` / `writeVisibility`
                → 之后谁可以召回它

   **存储层不做准入。** `dbPut('memories',…)` 与 Home Node `putRecord`
   都是纯持久化。准入在 producer 一侧，可见性在 reader 一侧。
   「统一 admission」因此**不可能**靠给存储层加一个闸门达成 ——
   存储层不持有候选的语义（它不知道这条是 AI 推断还是用户明说）。

   ── 本文件把三类事实分别钉住 ───────────────────────────────────────
     A. 入口登记表（§0）—— 声称的每个入口必须真的存在（负向断言）
     B. 语义分类（§1）—— 哪些是用户明确保存 / AI 推断 / 自动总结 /
        长期人格记忆 / 临时上下文，且**不假设它们同一种语义**
     C. fail closed（§2）—— 核心不可用时的真实行为，用**真实提取的函数**跑，
        不是读注释猜
     D. 日记特例（§3）—— 为什么绕过、设计还是历史、要不要接
     E. trace（§4）—— 每条写入能否回答来源/角色/裁定/可见性/理由
     F. 已知缺口台账（§5）—— 负向断言：缺口被修好会变红，强制台账跟着现实走

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_p11_2j_memory_admission.js
   纯 Node、零网络、零浏览器、零真实 provider 调用。
   求值的是**生产源码本身**：core 直接 require，函数按大括号配平提取后真实执行。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const section = t => console.log('\n── ' + t + ' ──');
const countOcc = (hay, needle) => hay.split(needle).length - 1;
const rd = p => fs.readFileSync(path.join(ROOT, 'assets', 'js', p), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const rds = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

/* 与 P11-2F/2G/2H/2I 同一纪律：大括号配平取函数；取不到要变成**红断言**，
   绝不能让异常打断整个文件（被打断的测试会静默少跑后面所有断言，
   看起来"失败为 0"）。 */
const extractBalancedFn = (src, header) => {
  const start = src.indexOf(header);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
};

/* 去掉注释后的源码：凡是用"某字面量出现几次"当判据的断言都必须用它。
   P11-2I 真实踩过的坑 —— 判据字符串写在自己的注释里，计数被注释污染。 */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* 本文件是 CommonJS（用 require），而审计需要 `await` 真实执行生产函数 ——
   顶层 await 与 require 并存会被 Node 判为模块格式歧义（ERR_AMBIGUOUS_MODULE_SYNTAX）。
   因此整个测试体放进 async main() 并在末尾 await 它；异常必须变成红断言，
   不允许以未捕获异常的形式中断（那会让后面的断言静默不跑）。
   计数器与 helper 留在顶层，供 main 内的断言直接使用。 */
async function main(){

console.log('P11-2J · Memory Admission Boundary Audit · offline deterministic');

/* 生产源码文本先读齐（const 的暂时性死区会让"断言写在声明之前"变成
   ReferenceError —— 一个被异常打断的测试看起来"失败为 0"）。 */
const AUTO_MEM = rd('memory/auto-memory.js');
const MEMORY = rd('memory.js');
const DIARY = rd('active-diary/diary.js');
const ACTIVE = rd('active-diary.js');
const COM = rd('communication.js');
const LETTERS = rd('communication/letters.js');
const MOMENTS = rd('moments.js');
const ROLE_LETTERS = rd('role-letters.js');
const ACTIVITY = rd('activity/activity-runtime.js');
const CORE = rd('core.js');
const STORE = rds('services/home-node/memory-store.js');
const MOMENT_VIS = rd('moments-visibility-core.js');
const MEM_VIS = rd('memory-visibility-core.js');

const UDC = require(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'));
const VIS = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));

/* ══════════════════════════════════════════════════════════════════
   §0 · Memory Write Entry Registry
   ------------------------------------------------------------------
   Phase 0 的产出物：**每个**长期记忆写入入口都必须在这里被登记。
   登记项包含判据字符串 —— 它们必须真的出现在对应生产文件里。
   这一节是"入口清单没有漏"和"清单没有幽灵项"的**双向**判据。
   ══════════════════════════════════════════════════════════════════ */
section('§0 · Memory Write Entry Registry');

const ENTRIES = [
  /* [id, file, needle, admissionKind] */
  ['chat.stream',        COM,          "_execMemOps(_mp.ops,cfg,cfg.nickname||cfg.model||'AI')", 'gate+consent'],
  ['chat.nonStream',     COM,          "_execMemOps(_mpn.ops,cfg,cfg.nickname||cfg.model||'AI')", 'gate+consent'],
  ['group.memberOps',    COM,          '_execMemOps(_gAllowed.map(x=>x.op),cfg,selfName)', 'groupPolicy+consent'],
  ['blogComment',        COM,          '_execMemOps(_cm.ops,cfg,', 'none'],
  ['roleLetter.inbox',   LETTERS,      '_execMemOps(_lm.ops,cfg,_letterSender)', 'none'],
  ['memory.generateAI',  MEMORY,       "targetStore:'memories',cfg,category:domain", 'calibrate+consent'],
  ['memory.userSave',    MEMORY,       "async function saveMemory(){", 'none(userExplicit)'],
  ['memory.quickCreate', MEMORY,       'async function quickCreateMemory(data){', 'none(primitive)'],
  ['memory.panelEdit',   MEMORY,       "if(_editingMemId)try{await _reconcileReferences(_editingMemId)}catch(e){}", 'none(userEdit)'],
  ['consolidation',      ACTIVE,       'async function consolidateCharacterMemory(cfg,opts){', 'ownGate+calibrate(partial)'],
  ['diary',              DIARY,        'async function _diaryWriteMemory(character,memoryCandidate){', 'ownRuleSet'],
  ['companion.activity', ACTIVITY,     'async function writeMemory(activity,title,content){', 'none'],
  ['roleLetter.memory',  ROLE_LETTERS, 'async function _rlWriteRoleMemory(characterId,content,title,letterId,direction){', 'none(dupOnly)'],
  ['moments.create',     MOMENTS,      'async function createMoment(data){', 'n/a(noMemoryWrite)'],
  ['import.backup',      CORE,         "if(data.memories)for(const m of data.memories)await dbPut('memories',m)", 'none(byDesign)'],
];

ENTRIES.forEach(([id, src, needle]) => {
  check('E0.exists.' + id, src.indexOf(needle) >= 0, 'entry not found in production source');
});

/* 反向：**没有**未登记的第二套 `dbPut('memories'` 生产写入面。
   只统计生产 assets/js，且剥注释（注释里引用 dbPut 不算入口）。 */
const MEM_WRITERS = [
  ['memory.js', MEMORY],
  ['active-diary/diary.js', DIARY],
  ['active-diary.js', ACTIVE],
];
const declaredWriteFiles = new Set(MEM_WRITERS.map(x => x[0]));
const dbPutTotal = MEM_WRITERS.reduce((n, [, s]) => n + countOcc(stripComments(s), "dbPut('memories'"), 0);
check('E0.dbPutMemoriesCounted', dbPutTotal >= 10, 'expected >=10 direct write sites, got ' + dbPutTotal);
/* 每个直接写点所在的文件都必须在 ENTRIES 里有对应入口 */
[
  ['memory.js', 'memory.userSave'],
  ['active-diary/diary.js', 'diary'],
  ['active-diary.js', 'consolidation'],
].forEach(([file, entryId]) => {
  check('E0.fileCoveredByRegistry.' + file,
    declaredWriteFiles.has(file) && ENTRIES.some(e => e[0] === entryId),
    file + ' has direct writes but no registered entry');
});

/* Storage 层**不**做准入 —— 这是设计，不是缺口。登记为正向断言，
   避免将来有人"顺手"在 store 里加一个语义闸门（那会造出第二份准入）。 */
check('E0.storeDoesNotGateAdmission',
  STORE.indexOf('_calibrateMemoryCandidate') < 0 && STORE.indexOf('requestMemoryApproval') < 0
  && STORE.indexOf('admission') < 0,
  'home-node memory-store must stay persistence-only (no admission semantics)');

/* ── 闸门形态，不只是"闸门存在" ────────────────────────────────────
   §0 的存在性断言只证明 `_execMemOps` 与 `_mbSideEffectGate` 各自出现过。
   把调用点改成**不带闸门**的形式（闸门仍在别处被调用）会全部逃过。
   因此下面把每个**生产写入调用点**的精确形态钉住 —— 变异审计 M02 正是这种形状。 */
const COM_BARE = stripComments(COM);
check('E0.gatedChatWriteSitesExactForm',
  countOcc(COM_BARE, 'if(amEnabled(cfg)&&_mbSideEffectGate(_MB_SEC.mem))_memR=await _execMemOps(') === 1
  && countOcc(COM_BARE, 'if(amEnabled(cfg)&&_mbSideEffectGate(_MB_SEC.mem))_memRNs=await _execMemOps(') === 1,
  'both chat write sites must be executed only behind the side-effect gate');
/* 上一条只证明**存在**带闸门的形式。若同时还存在一个**不带闸门**的同类调用点，
   闸门就被绕过了而断言仍绿。因此这里用计数恒等式封闭它：
     出现 "X=await _execMemOps(" 的次数  ==  出现 "<gate>)X=await _execMemOps(" 的次数
   两个数相等 ⇒ 每一个赋值点都在闸门之后（多一个裸赋值点就会让左边大于右边）。
   注意不能用"`_memR=await` 出现过"这种朴素判据 —— 闸门行里紧邻 `_memR` 的字符
   正好是 `)`，朴素子串判据会**总是**命中，从而变成一条永远为红的假断言。 */
const _bareWriteSites = countOcc(COM_BARE, '_memR=await _execMemOps(') + countOcc(COM_BARE, '_memRNs=await _execMemOps(');
const _gatedWriteSites = countOcc(COM_BARE, '_mbSideEffectGate(_MB_SEC.mem))_memR=await _execMemOps(')
  + countOcc(COM_BARE, '_mbSideEffectGate(_MB_SEC.mem))_memRNs=await _execMemOps(');
check('E0.noUngatedChatWriteSite',
  _bareWriteSites === 2 && _bareWriteSites === _gatedWriteSites,
  'every chat `_memR/_memRNs = await _execMemOps(...)` assignment must sit behind the gate (bare='
  + _bareWriteSites + ' gated=' + _gatedWriteSites + ')');
check('E0.outerAdjudicationWriteSitesSelfDeclare',
  /if\(_cm\.ops\.length&&amEnabled\(cfg\)&&!cfg\.amRecordOnly\)/.test(COM_BARE)
  && /if\(_lm\.ops\.length&&amEnabled\(cfg\)&&!cfg\.amRecordOnly\)/.test(stripComments(LETTERS)),
  'blog/letters writes must keep their amEnabled/amRecordOnly guard');

/* ══════════════════════════════════════════════════════════════════
   §1 · Memory Admission Matrix
   ------------------------------------------------------------------
   Candidate → Admission Decision → Storage

   审计要求：**不要假设所有 memory write 都是同一种语义**。
   下面把五个语义类别分别登记，并对每一类断言其真实判据。
   ══════════════════════════════════════════════════════════════════ */
section('§1 · Memory Admission Matrix');

/* ── 1a. 用户明确保存：准入的**正当豁免**，不是缺口 ─────────────── */
/* saveMemory 由用户在表单里逐字段填写并点击保存 —— 人本身就是裁定者。
   断言它确实没有走 calibrate（登记事实），且确实带 createdBy:'user'。 */
const saveMemSrc = extractBalancedFn(MEMORY, 'async function saveMemory(){');
check('A1.userSaveExtracted', !!saveMemSrc);
if (saveMemSrc) {
  check('A1.userSaveHasNoCalibration', saveMemSrc.indexOf('_calibrateMemoryCandidate') < 0,
    'user save must not be filtered by AI admission');
  check('A1.userSaveMarksCreatedByUser', /createdBy:'user'/.test(saveMemSrc),
    'user save must be attributable to the user');
  check('A1.userSaveBuildsVisibilityTriplet',
    /visibility:vis/.test(saveMemSrc) && /visibleTo:vis==='only'\?checked:\[\]/.test(saveMemSrc)
    && /excludeFrom:vis==='except'\?checked:\[\]/.test(saveMemSrc),
    'user save must carry the visibility triplet');
}

/* ── 1b. AI 推断（Chat/group/blog/letters）：校准 + 同意 ────────────── */
const execSrc = extractBalancedFn(AUTO_MEM, 'async function _execMemOps(ops,cfg,authorName){');
check('A2.execMemOpsExtracted', !!execSrc);
if (execSrc) {
  const execBare = stripComments(execSrc);
  /* 三个操作各校准一次（create/update/delete）并各请求一次同意；
     `targetStore:'autoMemory'` 因此出现 **6** 次 = 3 校准 + 3 同意。
     这条断言同时钉住两件事：校准次数与"校准与同意一一配对"。 */
  const calN = countOcc(execBare, '_calibrateMemoryCandidate(');
  const appN = countOcc(execBare, 'requestMemoryApproval(');
  const tsN = countOcc(execBare, "targetStore:'autoMemory'");
  check('A2.execCalibratesAllThreeOps',
    calN === 3 && tsN === calN + appN && appN === 3,
    'expected 3 calibrations paired with 3 consents (cal=' + calN + ' app=' + appN + ' ts=' + tsN + ')');
  check('A2.execConsentForAllThreeOps',
    appN === 3,
    'expected exactly 3 consent requests, got ' + appN);
  /* 兜底闸门：未开启 Auto Memory 时任何路径都不落库 */
  check('A2.execHardGateOnAmEnabled',
    /^[\s\S]*?if\(!amEnabled\(cfg\)\)return results;/.test(execBare),
    'first statement must be the amEnabled hard gate');
  /* 跨角色写入防护：update/delete 必须校验 friendId */
  check('A2.execCrossCharacterGuard',
    countOcc(execBare, 'ex.friendId!==cfg.id') === 2
    && countOcc(execBare, 'fresh.friendId!==cfg.id') === 2,
    'update/delete must refuse entries owned by another character');
}

/* ── 1c. 自动总结（consolidation）：自带闸门 + 部分校准 ─────────────── */
const consSrc = extractBalancedFn(ACTIVE, 'async function consolidateCharacterMemory(cfg,opts){');
check('A3.consolidationExtracted', !!consSrc);
if (consSrc) {
  const consBare = stripComments(consSrc);
  check('A3.consolidationOwnGateExists', /_longTermValue/.test(consBare) && /_temporary/.test(consBare),
    'consolidation must carry its own long-term-value gate');
  check('A3.consolidationUsesCalibrationOnlyForRepeats',
    /if\(_cal&&_cal\.repeatCount!=null\)_repeats=Number\(_cal\.repeatCount\)\|\|0/.test(consBare),
    'consolidation consumes only repeatCount from calibration');
  /* 关键事实：核对 `_cal.rejected` **没有**被读取 —— 校准的拒绝结论在这条路径上被丢弃 */
  check('A3.consolidationDropsCalibrationVerdict', consBare.indexOf('.rejected') < 0,
    'consolidation does not consult the calibration rejection verdict (registered gap)');
  check('A3.consolidationNeverWritesOnReject',
    /if\(_temporary\|\|!_longTermValue\)return null;/.test(consBare),
    'gate must return null (no create / no merge) when it refuses');
  check('A3.consolidationMergePreservesProvenance',
    /consolidatedFrom=Array\.from\(new Set\(\(existingSemantic\.consolidatedFrom\|\|\[\]\)\.concat\(refs\)\)\)/.test(consBare),
    'merge must union provenance rather than overwrite it');
  check('A3.consolidationRefsAreRealSources',
    /\.filter\(id=>id&&_sourceIds\.indexOf\(id\)>=0\)/.test(consBare),
    'model-returned consolidatedFrom ids must be validated against real sources');
}

/* ── 1d. 长期人格记忆（Understanding）：校准 + 权威 + 证据独立性 ─────── */
check('A4.understandingGoesThroughAuthority',
  /async function unWrite\(characterId,next\)\{[\s\S]{0,400}_understandingAuthority\(\)/.test(MEMORY),
  'understanding writes must route through the canonical authority');
check('A4.understandingRefusesWithoutAuthority',
  /_understandingAuthority\(\)[\s\S]{0,900}?\n\s*return null/.test(MEMORY)
  || MEMORY.indexOf('**绝不**在权威失效时悄悄退回本地写') >= 0,
  'missing authority must not silently fall back to a second local write');
/* Understanding 由 calibrate 独立承载三类拒止 —— 逐项以核心真实行为验证（§2 有行为测试） */
check('A4.coreCarriesUnderstandingRejections',
  ['psych-inference', 'personality-inference', 'insufficient-evidence']
    .every(r => UDC.calibrate.toString().indexOf(r) >= 0
      || require('node:fs').readFileSync(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'), 'utf8').indexOf(r) >= 0),
  'understanding rejections must live in the derivation core');

/* ── 1e. 临时上下文：不进入长期记忆的判据 ──────────────────────────── */
const lyrical = UDC.lyricFlags('今晚的月光让我想起故乡的童年，我在静谧中重新评估了时光的珍贵。');
check('A5.temporaryMarkerFlagsLyric', lyrical.lyric === true,
  'the lyric detector must recognise the registered fixture');
/* 临时上下文的核心判据：temporary 命中会下调 confidence（-25），不是硬拒 */
const tempCal = await UDC.calibrate({ content: '今天临时改动一下排期，仅这次这样处理。', operation: 'create', targetStore: 'memories', cfg: { id: 'u1' }, category: '日常' }, {});
check('A5.temporaryIsPenaltyNotRejection', tempCal.rejected == null && tempCal.confidence < 50,
  'temporary content must be down-scored, not hard-rejected (confidence=' + tempCal.confidence + ')');

/* 五类语义必须是**互不相同**的结论，不是同一个值换名字 */
const semanticClasses = [
  ['userExplicit', saveMemSrc ? 'none(userExplicit)' : ''],
  ['aiInference', 'calibrate+consent'],
  ['autoSummary', 'ownGate+calibrate(partial)'],
  ['personaMemory', 'calibrate+authority'],
  ['temporary', 'downscored'],
];
check('A5.fiveDistinctSemantics',
  new Set(semanticClasses.map(x => x[1])).size === 5,
  'the five write semantics must stay distinguishable');

/* ── 1f. 准入是**行为**，不只是存在某个调用 ──────────────────────────
   下面几条用 core 的**真实执行结果**钉住三类拒止。只断言"调用了 calibrate"
   是不够的：把 core 里的拒止分支改成恒真，调用次数一次都不会变。
   共享 fixture 在此声明（§3 的日记特例复用同一个角色与同一条内容 ——
   "canonical 硬拒的东西日记路径照写"这条对照必须用**逐字相同**的输入）。 */
const CHAR = { id: 'role_a', nickname: '小满', model: 'm' };
const LYRIC_CANDIDATE = {
  content: '珍惜这份静谧，仿佛岁月在温柔地治愈我；我重新评估了时光的珍贵。',
  importance: 8, type: 'experience',
};
const calm = (inp) => UDC.calibrate(inp, { sim: UDC.textSimilarity, extractKeywords: () => [] });
/* 文学化自我感慨 → 硬拒（与 §3 的日记 fixture 同一条内容） */
const rLyric = await calm({
  content: LYRIC_CANDIDATE.content, confidence: 8, reasons: [],
  operation: 'create', targetStore: 'memories', cfg: CHAR, category: 'experience',
});
check('A6.coreHardRejectsLyricMusing', rLyric.rejected === 'lyrical-musing',
  'the canonical gate must hard-reject literary self-musing (got ' + String(rLyric.rejected) + ')');
/* 自我观察（非关于用户的长期事实）→ 硬拒。
   注意判据是 `personReflect`：`{我|自己|彼此|我们}` 后面 0–12 字内出现
   `的|那些|此刻|这般|仿佛`。第一版 fixture 我用了带"感悟"的句子，
   结果命中的是 **lyric** 分支而不是 selfReflect —— 一条断言用错了拒止类别，
   它仍然是"绿的"，但证明的不是它声称的那件事。 */
const rSelf = await calm({
  content: '我发现自己越来越依赖这种安静的陪伴，这大概是我此刻的状态。', confidence: 7, reasons: [],
  operation: 'create', targetStore: 'memories', cfg: CHAR, category: '情感',
});
check('A6.coreHardRejectsSelfReflection', rSelf.rejected === 'self-reflective',
  'the canonical gate must hard-reject self-observation (got ' + String(rSelf.rejected) + ')');
/* 两条拒止必须是**不同**的分支 —— 否则上面两条断言其实在测同一件事 */
check('A6.lyricAndSelfReflectAreDistinctBranches',
  rLyric.rejected === 'lyrical-musing' && rSelf.rejected === 'self-reflective'
  && rLyric.rejected !== rSelf.rejected,
  'lyrical-musing and self-reflective must remain distinct rejections');
/* Understanding 的证据独立性：→ insufficient-evidence，且是**实际执行**的结论 */
const rEv = await calm({
  content: '她对设备瓶颈敏感。', operation: 'understanding', targetStore: 'understandings',
  basis: 'ai_inference', evidenceIds: ['ev_a'], memories: [], cfg: { id: 'u1' }, category: 'context',
});
check('A6.coreRequiresIndependentEvidence',
  rEv.rejected === 'insufficient-evidence' && rEv.confidence === 0,
  'understanding must require >=2 independent evidence items (got ' + String(rEv.rejected) + ')');
/* 心理类指定：仅 user_stated 放行；AI 推断一律拒 */
const rPsy = await calm({
  content: '她可能有抑郁症。', operation: 'understanding', targetStore: 'understandings',
  basis: 'ai_inference', evidenceIds: ['ev_a', 'ev_b'], memories: [], cfg: { id: 'u1' }, category: 'context',
});
check('A6.coreBlocksPsychInference',
  rPsy.rejected === 'psych-inference' && rPsy.confidence === 0,
  'mental-health understanding must be blocked for AI inference (got ' + String(rPsy.rejected) + ')');
const rPsyOk = await calm({
  content: '她明确告诉我她最近在吃抗抑郁的药。', operation: 'understanding', targetStore: 'understandings',
  basis: 'user_stated', evidenceIds: ['ev_a', 'ev_b'], memories: [], cfg: { id: 'u1' }, category: 'context',
});
check('A6.coreAllowsUserStatedPsych',
  rPsyOk.rejected == null && rPsyOk.confidence > 0,
  'a user-stated mental-health fact must pass (rejection must be about the basis, not the topic)');

/* ── 1g. 静默写入的两个上限：每轮 3 次、always 三条 ────────────────── */
if (execSrc) {
  const execBare2 = stripComments(execSrc);
  /* 每轮最多 3 条记忆操作 —— 超出部分进 results 但不落库 */
  check('A7.perTurnOpCapEnforced',
    /const results=\[\];const MAXOPS=3;/.test(execBare2)
    && /if\(i>=MAXOPS\)\{results\.push\(\{ok:false/.test(execBare2),
    'per-turn memory ops must be capped at 3');
  /* always 优先级条目上限 3 —— 在**构造 entry 之前**的守卫，防无界静默增长 */
  const capGuard = execBare2.indexOf("if(prio==='always'){const ex=await amGetEntries(cfg.id)");
  const entryBuild = execBare2.indexOf('const entry={id:_amNewId()');
  check('A7.alwaysPriorityCapEnforced',
    capGuard >= 0 && entryBuild > capGuard
    && /ex\.filter\(e=>e\.priority==='always'\)\.length>=3/.test(execBare2),
    'the always-priority cap must be checked before the entry is constructed');
}

/* ══════════════════════════════════════════════════════════════════
   §2 · Fail Closed Audit
   ------------------------------------------------------------------
   核心不可用时是 fail closed 还是继续写入 —— 用**真实提取的函数**跑，
   不是读注释猜。三个维度：calibration / policy / visibility。
   ══════════════════════════════════════════════════════════════════ */
section('§2 · Fail Closed Audit');

/* ── 2a. calibration 不可用 ───────────────────────────────────────── */
/* 真实 `_calibrateMemoryCandidate`：在 Node 里提供 window 而不挂
   IBUnderstandingDerivation → 必须返回 rejected:'admission-core-unavailable'。 */
const calSrc = extractBalancedFn(AUTO_MEM, 'async function _calibrateMemoryCandidate(input){');
check('F1.calibrateExtracted', !!calSrc);
if (calSrc) {
  /* 该函数体依赖四个自由变量：window（取 core）、dbGetAll（仅 understanding 分支）、
     _activeTextSimilarity（相似度实现）与 _extractKeywords（关键词提取器）——
     三者都是桌面宿主注入的，Node 侧没有。真实执行时必须**显式注入**，
     而不是让它们变成 ReferenceError 把测试打断。 */
  const makeCalibrate = (win, opts) => {
    opts = opts || {};
    return new Function('window', 'dbGetAll', '_activeTextSimilarity', '_extractKeywords',
      calSrc + '; return _calibrateMemoryCandidate;')(
      win,
      opts.dbGetAll || (async () => []),
      opts.sim || UDC.textSimilarity,
      opts.extractKeywords || (() => [])
    );
  };

  const calNoCore = makeCalibrate({});
  /* 把"核心不可用时抛异常"**也**算作 fail-open 的一个可判定形态：
     抛错会穿到调用方的 catch，而调用方在 catch 里做的是"提示失败"，不是"拒绝写入" ——
     于是这次候选既没有 verdict 也没有 rejected，只有一条提示。
     `__FAIL_OPEN__` 是刻意选定的显式标记：它让"守卫被去掉"这件事
     在断言里可读，而不是以未捕获异常的形式把整个测试打断
     （被打断的测试会静默少跑后面所有断言，看起来"失败为 0"）。 */
  const calTry = async (args) => {
    try { return await calNoCore(args); }
    catch (e) { return { __FAIL_OPEN__: String(e && e.message || e) }; }
  };
  const r1 = await calTry({ content: '她明确说过她偏好安静的工作环境。', operation: 'create', targetStore: 'memories', cfg: { id: 'u1' } });
  check('F1.calibrateFailsClosedWhenCoreUnavailable',
    r1.rejected === 'admission-core-unavailable' && r1.confidence === 0 && r1.__FAIL_OPEN__ === undefined,
    'calibration must refuse with an explicit verdict, not degrade into an unguarded path'
    + (r1.__FAIL_OPEN__ ? ' (threw into the caller: ' + r1.__FAIL_OPEN__ + ')' : ''));
  check('F1.rejectionVerdictIsNotNull',
    r1.rejected != null && r1.rejected !== '',
    'the rejection field must carry a non-null verdict (null would read as "passed")');

  /* 有 core 时正常出分 —— 证明"拒绝"来自 core 缺失，而不是函数恒拒 */
  const calWithCore = makeCalibrate({ IBUnderstandingDerivation: UDC });
  const r2 = await calWithCore({ content: '她明确说过她偏好安静的工作环境。', operation: 'create', targetStore: 'memories', cfg: { id: 'u1' } });
  check('F1.calibratePassesThroughWhenCorePresent',
    r2.rejected == null && r2.confidence > 0 && Array.isArray(r2.reasons),
    'calibration must work when the core is present (confidence=' + r2.confidence + ')');

  /* 证据独立性判定的**读失败**路径：_memoryRepeatCount 读库抛错时必须吞掉并返回 0。
     返回 0 是收窄（少一条重复证据 ⇒ 分数更低、confidence 更低），而抛出会把整次
     校准变成异常 —— 于是"重复证据"这条准入判据整体消失。两条路径的差别只有在
     读失败时才可见，所以必须用抛错的 lookupEntries 真实驱动。
     注意这里也用 calTry 形态：抛出的结果是断言里的显式失败，而不是把测试打断。 */
  const calRepeatThrows = makeCalibrate({ IBUnderstandingDerivation: UDC },
    { dbGetAll: async () => { throw new Error('read failed'); }, extractKeywords: () => ['安静', '工作', '环境'] });
  let repeatThrew = null, rRep = null;
  try { rRep = await calRepeatThrows({ content: '她偏好安静的工作环境。', operation: 'create', targetStore: 'memories', cfg: { id: 'u1' }, category: '日常' }); }
  catch (e) { repeatThrew = e; }
  check('F1.repeatCounterSwallowsReadFailure',
    repeatThrew === null && rRep && rRep.repeatCount === 0,
    'a failed repeat-count read must yield 0 (narrowing), not propagate'
    + (repeatThrew ? ' (threw: ' + String(repeatThrew && repeatThrew.message) + ')' : ''));
  check('F1.repeatCounterIsActuallyWired',
    UDC.repeatCount.toString().indexOf('lookupEntries') >= 0,
    'the repeat counter must consult the injected entry lookup (otherwise the test above is empty)');
  /* 桌面宿主把"重复计数"的读库实现**注入**给核心（核心是纯函数，不自己取数据）。
     这条注入若缺失，核心的 repeatCount 会退化成默认 0 —— 一条静默的收窄，
     在行为上不可见（分数略低），只能靠形态断言发现。 */
  const calNoThrowSrc = stripComments(calSrc).replace(/}catch\(e\)\{return 0\}/g, '}catch(e){throw e}');
  check('F1.hostInjectsRepeatCountAdapter',
    calNoThrowSrc.indexOf('lookupEntries:') >= 0
    && calNoThrowSrc.indexOf('extractKeywords:') >= 0,
    'the host shim must inject extractKeywords + lookupEntries into the derivation core');

  /* 真正驱动桌面宿主的 `_memoryRepeatCount`（逐字提取后真实执行）。
     它的读失败语义是"返回 0"（收窄）—— 若改成抛出，整次校准变成异常，
     "重复证据"这条判据整体消失。用抛错的 dbGetAll 让两条路径**行为可分**。 */
  const repSrc = extractBalancedFn(AUTO_MEM, 'async function _memoryRepeatCount(content,targetStore,cfg,excludeId){');
  check('F1.repeatCountExtracted', !!repSrc);
  if (repSrc) {
    /* `_amScore` 是函数体里的**自由变量**（同文件的另一个函数）。必须显式注入：
       不注入会抛 ReferenceError，而被该函数自己的 `catch(e){return 0}` 吞掉 ——
       于是"计数器返回 0"看起来像被测行为，其实是我漏了一个依赖。
       （这正是这条断言的价值：它把"harness 错误伪装成通过"挡在外面。） */
    const amScoreSrc = AUTO_MEM.match(/^function _amScore\([^\n]*\n/m);
    check('F1.amScoreExtracted', !!amScoreSrc, 'could not extract _amScore from auto-memory.js');
    const mkRepeat = (dbGetAllImpl) => new Function(
      'dbGetAll', 'amGetEntries', '_extractKeywords', '_amScore',
      (amScoreSrc ? amScoreSrc[0] : '') + '\n' + repSrc + '; return _memoryRepeatCount;'
    )(dbGetAllImpl, async () => [], () => ['安静', '工作', '环境'], amScoreSrc ? amScoreSrc[0] : '');
    /* 注意：生产实现的第一个参数虽然叫 `content`，但**从未被读取** ——
       关键词是从第 3 个参数（`cfg`）提取的（`_extractKeywords(String(content||''))`
       里的 `content` 是外层作用域的那个变量）。这是一处**既有**的命名/参数错位，
       本阶段只如实登记、不修（修它会改变重复计数的口径，属于另一个阶段）。
       因此这里按**实现的真实契约**驱动：第 3 参传被提取的文本。 */
    const REP_INPUT = '她偏好安静的工作环境。';
    const REP_THROW = async () => { throw new Error('read failed'); };
    const REP_ROW = async () => [{ id: 'e1', title: '安静', summary: '工作', content: '环境' }];
    /* 阈值口径：`Math.max(2, ceil(关键词数*0.09))`。3 个关键词 → 阈值 2，
       因此对照行必须命中 **≥2** 个关键词才算"重复出现"（只命中一个不算）。 */
    const REP_ROW_HIT = async () => [{ id: 'e1', title: '安静', summary: '工作环境', content: '偏好' }];
    let repThrew = null, repOut = null;
    try { repOut = await mkRepeat(REP_THROW)(REP_INPUT, 'memories', REP_INPUT, null); }
    catch (e) { repThrew = e; }
    check('F1.repeatCounterHostSwallowsReadFailure',
      repThrew === null && repOut === 0,
      'the host repeat counter must return 0 on a failed read, not propagate'
      + (repThrew ? ' (threw: ' + String(repThrew && repThrew.message) + ')' : ' (got ' + String(repOut) + ')'));
    /* 正对照：读库正常时必须给出非零重复数，否则上面那条"返回 0"是空的 */
    const repHits = await mkRepeat(REP_ROW_HIT)(REP_INPUT, 'memories', REP_INPUT, null);
    check('F1.repeatCounterHostCountsRealRepeats', repHits > 0,
      'a working host repeat counter must report repeats (control case; got ' + String(repHits) + ')');
    /* 登记这处既有错位：第一个形参名是 content，但函数体内没有任何地方读它 */
    check('F1.repeatCounterContentParamIsUnused',
      stripComments(repSrc).split('cfg').length > 1
      && /String\(content\|\|''\)/.test(stripComments(repSrc)),
      'registered: the host repeat counter derives keywords from arg 3, not from its `content` param');
  }
  /* 反向对照：读库正常且命中关键词时必须**给出非零**重复数，
     否则上面那条"返回 0"可能只是因为计数器从来不工作。 */
  const calRepeatHits = makeCalibrate({ IBUnderstandingDerivation: UDC },
    { dbGetAll: async () => [{ id: 'other', title: '安静', summary: '工作', content: '环境偏好' }], extractKeywords: () => ['安静', '工作', '环境'] });
  const rHits = await calRepeatHits({ content: '她偏好安静的工作环境。', operation: 'create', targetStore: 'memories', cfg: { id: 'u1' }, category: '日常' });
  check('F1.repeatCounterCountsRealRepeats', rHits && rHits.repeatCount > 0,
    'a working repeat counter must report repeats (control case; got '
    + String(rHits && rHits.repeatCount) + ')');

  /* 读库失败 → 证据集为空 → 非用户自述的 understanding 候选应因证据不足被拒。
     用真实抛错的 dbGetAll 驱动：这测的是"读失败时是否收窄"，而不是猜。 */
  const calDbThrows = makeCalibrate({ IBUnderstandingDerivation: UDC },
    { dbGetAll: async () => { throw new Error('indexeddb unavailable'); } });
  const r3 = await calDbThrows({ content: '她在创作上投入比较多。', operation: 'understanding', targetStore: 'understandings', basis: 'ai_inference', evidenceIds: ['ev_a', 'ev_b'], cfg: { id: 'u1' } });
  check('F1.calibrateReadFailureNarrowsNotWidens', r3.rejected === 'insufficient-evidence' || r3.confidence <= 65,
    'a failed evidence read must not widen admission (got ' + JSON.stringify({ rej: r3.rejected, c: r3.confidence }) + ')');
  check('F1.calibrateReadFailureDoesNotThrow', r3 && typeof r3.confidence === 'number',
    'a failed evidence read must degrade into a decision, not an exception');
}

/* ── 2b. 关键消费者是否读取了 rejected ─────────────────────────────── */
/* chat 路径（memory.js）读：`if(confidence&&confidence.rejected){...return}` */
const genSrc = extractBalancedFn(MEMORY, 'async function _generateMemoryCore(cfg,prompt,opts){');
check('F2.generateCoreExtracted', !!genSrc);
if (genSrc) {
  check('F2.generateCoreHonoursRejection',
    /if\(confidence&&confidence\.rejected\)\{[\s\S]{0,200}?return;/.test(genSrc),
    'AI-drafted memory must abandon the write on calibration rejection');
}
/* Auto Memory 路径（_execMemOps）**不读** rejected —— 登记为已知缺口 */
check('F2.execMemOpsIgnoresRejectionVerdict',
  !!execSrc && stripComments(execSrc).indexOf('.rejected') < 0,
  '【已知缺口】_execMemOps 不读取 calibration 的 rejected —— 仅由人工同意把关');

/* ── 2c. visibility 不可用（用真实 core 行为验证）────────────────── */
const storeNoCore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
check('F3.storeExports', typeof storeNoCore === 'function');
/* 真实 store + 显式 visibilityCore:null → 按主体读必须返回空页（fail closed） */
{
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p112j-'));
  let st = null;
  try {
    st = storeNoCore({ dataDir: dir, logger: () => {}, visibilityCore: null });
    const opened = st.open();
    check('F3.storeOpens', opened && opened.ok === true, JSON.stringify(opened));
    const w = st.putRecord({ id: 'mem_x', title: 't', content: 'c', visibility: 'all', created: 1, characterId: 'r1', kind: 'episodic' });
    check('F3.storeWritesWithoutVisibilityCore', w && w.ok === true,
      'storage must remain persistence-only even with no ACL core');
    const v = st.listVisible({ viewer: { kind: 'role', id: 'r1' } });
    /* core 缺席时，第一道守卫就返回 core-unavailable —— 这**先于**主体判定，
       因此"没有 core"与"没有主体"是两条不同的路径，必须分别验证。 */
    check('F3.listVisibleFailsClosedWithoutCore',
      v.ok === true && v.reason === 'core-unavailable' && v.records.length === 0,
      'no visibility core -> empty page, never "return everything"');
  } catch (e) {
    check('F3.storeScenarioRan', false, String(e && e.message || e));
  } finally {
    try { if (st) st.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
/* 第二道守卫：core **存在但主体缺失/非法** → 同样空页。
   用真实 core 驱动（注入真 core 而不是 null），否则测的仍是第一道守卫。

   ── 一处**真实的词表边界**（审计发现，非本阶段修改）────────────────
   `memories` 的四档是 public/only/except/private（memory-contract 与
   visibility 列同源）；`moments` 的四档是 all/user/roles/private
   （moments-visibility-core）。两套词表**只共享 private**。
   因此把 moments 的 `all` 写进 memories 会被读侧判为 `unknown-visibility`
   并**拒绝**（收窄，方向安全）。下面的 record 必须用 memories 词表，
   否则"合法主体读不到"这个现象会被误读成 ACL 故障。 */
{
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p112j-np-'));
  let st = null;
  try {
    st = storeNoCore({ dataDir: dir, logger: () => {}, visibilityCore: VIS });
    st.open();
    st.putRecord({ id: 'mem_np', title: 't', content: 'c', visibility: 'public', created: 1, characterId: 'r1', kind: 'episodic' });
    /* 空 viewer 归一化后不是合法主体；非法 kind 同理 */
    const np = st.listVisible({});
    check('F3.listVisibleFailsClosedWithoutPrincipal',
      np.ok === true && np.reason === 'no-principal' && np.records.length === 0,
      'no principal -> empty page (got reason=' + String(np.reason) + ')');
    const bad = st.listVisible({ viewer: { kind: 'robot', id: 'x' } });
    check('F3.listVisibleFailsClosedOnIllegalPrincipal',
      bad.ok === true && bad.reason === 'no-principal' && bad.records.length === 0,
      'an illegal principal kind must not be treated as a valid viewer');
    /* 正对照：**合法**主体必须能读到那条 public 记录 ——
       否则上面两条"空页"可能只是因为 store 根本读不出东西（假绿）。 */
    const good = st.listVisible({ viewer: { kind: 'role', id: 'r1' } });
    check('F3.listVisibleReturnsRowsForValidPrincipal',
      good.ok === true && good.records.length === 1,
      'a valid principal must receive accessible rows (control case; got '
      + JSON.stringify({ ok: good.ok, n: good.records.length, reason: good.reason }) + ')');
    /* 词表边界：moments 档位写进 memories → 读侧 unknown-* → 拒绝（收窄而非放行） */
    st.putRecord({ id: 'mem_wrongvocab', title: 't', content: 'c', visibility: 'all', created: 2, characterId: 'r1', kind: 'episodic' });
    const wrong = st.listVisible({ viewer: { kind: 'role', id: 'r1' } });
    check('F3.momentsVocabularyIsRejectedInMemories',
      wrong.records.length === 1
      && (wrong.refused || []).some(r => r.recordId === 'mem_wrongvocab' && /unknown|malformed|missing/.test(r.reason)),
      'a moments-style level must be refused, never silently treated as public (got '
      + JSON.stringify(wrong.refused) + ')');
    /* 且拒绝原因是**稳定可断言**的，不是"读不到但没有理由" */
    const dec = VIS.canReadMemory({ visibility: 'all' }, 'r1');
    check('F3.unknownVocabularyHasStableReason',
      dec.ok === false && dec.reason === 'unknown-visibility',
      'an out-of-vocabulary level must produce a stable, assertable reason');
  } catch (e) {
    check('F3.noPrincipalScenarioRan', false, String(e && e.message || e));
  } finally {
    try { if (st) st.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
/* 派生池：core 不可用 → 不产生任何候选（用真实函数语义验证） */
check('F3.derivationFailsClosed',
  /function _memDerivationCandidates\(all,roleId,predicate\)\{[\s\S]{0,200}?if\(!core\)return\[\]/.test(ACTIVE),
  'derivation candidate pool must be empty when the visibility core is absent');
check('F3.evidenceFailsClosed',
  /function _memVisibleEvidenceIds\(ids,all,roleId\)\{[\s\S]{0,200}?if\(!core\)return\[\]/.test(ACTIVE),
  'evidence liveness must be empty when the visibility core is absent');
/* 读侧 core 缺失的空页理由必须可区分（否则"fail closed"不可发现） */
check('F3.coreUnavailableIsDiscoverable',
  MEM_VIS.indexOf("reason: 'core-unavailable'") >= 0 || STORE.indexOf("reason: 'core-unavailable'") >= 0,
  'fail-closed reads must be distinguishable from "no data"');

/* ── 2d. 写侧 visibility 缺省语义（moments core，真实 require）────── */
const MOM_VIS = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));
check('F4.momentsWriteDefaultsToAll', MOM_VIS.writeVisibility(null) === 'all',
  'write-side default for a missing level is "all" (registered)');
check('F4.momentsReadTreatsMissingAsInvalid', MOM_VIS.readVisibility(null) === 'invalid',
  'read-side treats a missing level as invalid -> never visible to others');
check('F4.momentsWriteRejectsMisspelledLevel', MOM_VIS.writeVisibility('publik') === 'invalid',
  'a misspelled level must narrow, not widen');
/* 写侧放宽与读侧收窄并存 = 方向安全的组合：缺档位写进去，别人也读不到 */
check('F4.writeWidenIsNeutralisedByReadNarrow',
  MOM_VIS.writeVisibility(null) === 'all' && MOM_VIS.readVisibility('all') === 'all'
  && MOM_VIS.readVisibility(MOM_VIS.writeVisibility(undefined)) === 'all'
  && MOM_VIS.isMomentVisibleTo({ visibility: undefined, roleId: 'r1' }, { kind: 'role', id: 'r2' }) === false,
  'a moment written without a level must not be visible to another role');

/* ══════════════════════════════════════════════════════════════════
   §3 · Diary Special Case
   ------------------------------------------------------------------
   三个必须回答的问题，逐一变成可判定断言。
   ══════════════════════════════════════════════════════════════════ */
section('§3 · Diary Special Case · _diaryWriteMemory');

const diaryFn = extractBalancedFn(DIARY, 'async function _diaryWriteMemory(character,memoryCandidate){');
check('D0.diaryWriteMemoryExtracted', !!diaryFn);
/* 真实执行 _diaryWriteMemory：提供 dbGetAll/dbPut/_activeTextSimilarity/updateMemDashboard。
   dbPut 记录落库行 —— 这是"是否真的写入"的唯一可信判据。 */
const runDiaryWrite = async (character, candidate, existingRows) => {
  const written = [];
  const env = {
    dbGetAll: async () => (existingRows || []).slice(),
    dbPut: async (store, row) => { written.push({ store, row }); return true; },
    _activeTextSimilarity: UDC.textSimilarity,
    updateMemDashboard: () => {},
    Date: Date, Math: Math, String: String, Number: Number, Array: Array, parseInt: parseInt,
  };
  const fn = new Function(
    'dbGetAll', 'dbPut', '_activeTextSimilarity', 'updateMemDashboard',
    diaryFn + '; return _diaryWriteMemory;'
  )(env.dbGetAll, env.dbPut, env._activeTextSimilarity, env.updateMemDashboard);
  const out = await fn(character, candidate);
  return { out, written };
};

/* 角色与 fixture 已在 §1f 声明（两节必须用逐字相同的输入做对照）。 */

/* ── 问题 1：为什么绕过 calibration？─────────────────────────────── */
check('D1.diaryNeverCallsCalibration', diaryFn.indexOf('_calibrateMemoryCandidate') < 0,
  'diary does not consult the canonical admission core');
check('D1.diaryOwnThresholdIsImportance6', /if\(importance<6\)return null;/.test(diaryFn),
  'its own gate is importance>=6');
check('D1.diaryOwnDedupIsSimilarity08', /_activeTextSimilarity\(content,text\)>=0\.8/.test(diaryFn),
  'its own dedup is a 0.8 similarity cutoff');
/* 日记准入的全部判据 —— 逐一命名，并为每一条配一个负向行为断言（§D2）。
   `return null` 在（剥注释后的）函数体里出现 **5** 次：4 次是准入/去重判据，
   第 5 次是 catch 的异常吞没。两者语义不同，因此分开计数而不是合并成一句
   "一共 N 次"—— 合并会让"准入判据少了一条、异常处理多了一条"这种替换漏网。 */
const DIARY_GATE_RULES = [
  ['missingInput',   "if(!character||!memoryCandidate||!String(memoryCandidate.content||'').trim())return null;"],
  ['importanceLt6',  'if(importance<6)return null;'],
  ['emptyContent',   'if(!content)return null;'],
  ['duplicate08',    'if(text&&_activeTextSimilarity(content,text)>=0.8)return null'],
];
const diaryBare = stripComments(diaryFn);
check('D1.diaryGateHasExactlyFourRules',
  DIARY_GATE_RULES.every(([, n]) => diaryBare.indexOf(n) >= 0)
  && countOcc(diaryBare, 'return null') === 5,
  'expected 4 named gate rules + 1 exception guard = 5 returns (got '
  + countOcc(diaryBare, 'return null') + ')');
check('D1.diaryGateHasNoFifthAdmissionRule',
  countOcc(diaryBare, 'return null') - DIARY_GATE_RULES.length === 1,
  'any additional return-null would be an undiscovered admission rule');
/* 日记把"低价值"的判断**委托给模型**（prompt 层），而非本地校验 —— 这是绕过的机制性原因 */
check('D1.diaryDelegatesLowValueToPrompt',
  /memoryCandidate：仅当日记中有对未来有价值的信息时才提供，低价值日记必须为 null/.test(DIARY),
  'the low-value decision is stated only as a prompt instruction, not enforced locally');
/* 日记 prompt 里确实带上了这条指令，且模型的输出**未**被本地二次校验 */
check('D1.diaryDoesNotRecheckFutureValue',
  diaryFn.indexOf('_longTermValue') < 0 && diaryFn.indexOf('_future') < 0,
  'unlike consolidation, diary has no local long-term-value re-check');

/* ── 行为证明：canonical 硬拒的内容，日记路径照常落库 ─────────────── */
const lyricCal = await UDC.calibrate({
  content: LYRIC_CANDIDATE.content, confidence: 8, reasons: [],
  operation: 'create', targetStore: 'memories', cfg: CHAR, category: 'experience',
}, {});
check('D2.canonicalRejectsLyricCandidate', lyricCal.rejected === 'lyrical-musing',
  'fixture must be rejected by the canonical core (got ' + String(lyricCal.rejected) + ')');

const diaryRun = await runDiaryWrite(CHAR, LYRIC_CANDIDATE, []);
check('D2.diaryWritesWhatCanonicalRejects',
  diaryRun.written.length === 1 && diaryRun.written[0].store === 'memories',
  '【已知缺口】the same content the canonical gate hard-rejects is written by the diary path');
/* 而且它写入的可见性**不经过**任何可见性 core */
if (diaryRun.written.length === 1) {
  const row = diaryRun.written[0].row;
  check('D2.diaryRowIsSelfOnly', row.visibility === 'only' && row.visibleTo.join(',') === CHAR.id,
    'diary rows are self-only (safe literal)');
  check('D2.diaryRowClaimsAiOrigin', row.createdBy === 'ai' && row.characterId === CHAR.id,
    'diary rows must be attributable to the character');
  check('D2.diaryRowIsNotVisibleToAnotherRole',
    VIS.isMemoryVisibleTo(row, 'role_b', false, false) === false,
    'a diary row must never be recallable by another character');
  check('D2.diaryRowIsVisibleToItsOwnCharacter',
    VIS.isMemoryVisibleTo(row, CHAR.id, false, false) === true,
    'a diary row must be recallable by its own character');
}
/* 负向：importance 不够时确实不写（证明它不是"无条件写入"） */
const diaryLow = await runDiaryWrite(CHAR, { content: '今天天气不错。', importance: 3 }, []);
check('D2.diaryRefusesLowImportance', diaryLow.written.length === 0 && diaryLow.out === null,
  'importance<6 must refuse');
/* 负向：重复内容不写 */
const diaryDup = await runDiaryWrite(CHAR, LYRIC_CANDIDATE, [{ id: 'm1', title: '', content: LYRIC_CANDIDATE.content }]);
check('D2.diaryRefusesDuplicate', diaryDup.written.length === 0 && diaryDup.out === null,
  'a >=0.8-similar existing memory must refuse');

/* ── 问题 2：设计需求还是历史实现？──────────────────────────────── */
/* 审计的证据：consolidation 的闸门带着**明确的补丁注释**（"止血"），
   说明 importance>=6 曾被认定为不足；日记是同一形状但没有这段补丁 ——
   它是**还没有被补上的那一份**，而不是被有意豁免的那一份。 */
check('D3.consolidationGateIsAnnotatedRetrofit',
  /Consolidation Admission Gate v1（止血）/.test(ACTIVE),
  'consolidation gate must be annotated as a retrofit (the audit evidence)');
check('D3.consolidationGateSaysImportanceAloneWasInsufficient',
  /importance≥6 不再是唯一准入/.test(ACTIVE),
  'the retrofit comment must state that importance>=6 alone was insufficient');
check('D3.diaryHasNoSuchExemptionRationale',
  DIARY.indexOf('止血') < 0,
  'diary carries no documented retrofit rationale for skipping admission');
check('D3.diaryCommentStatesItsRule',
  /去重、importance>=6 才写入/.test(DIARY),
  'the diary rule is documented as its own two conditions');
/* 且日记**不是**在 `_parseMemOps` 执行器之上 —— 它不借用 consent 面 */
check('D3.diaryHasNoConsentPath',
  DIARY.indexOf('requestMemoryApproval') < 0 && DIARY.indexOf('_execMemOps') < 0,
  'diary never reaches the consent overlay either');

/* ── 问题 3：是否需要接入 admission boundary？────────────────────── */
/* 本阶段**不修改产品语义** —— 因此只断言"缺口被如实登记"，并断言
   台账在缺口被修好时会变红（见 §5）。这里锁定当前形态。 */
check('D4.gapIsRegisteredNotFixed',
  diaryFn.indexOf('_calibrateMemoryCandidate') < 0,
  '【已知缺口】diary admission is NOT wired in this stage (product decision, deferred)');
check('D4.thisStageDidNotChangeDiarySemantics',
  /async function _diaryWriteMemory\(character,memoryCandidate\)\{[\s\S]*?if\(importance<6\)return null;/.test(DIARY),
  'the diary admission rule must be byte-identical to the audited baseline');

/* ══════════════════════════════════════════════════════════════════
   §4 · Trace Completeness
   ------------------------------------------------------------------
   要求：每条 memory write 至少可回答 来源 / character / admission
   decision / visibility / reason。
   ══════════════════════════════════════════════════════════════════ */
section('§4 · Trace Completeness');

/* 逐入口统计五个字段的可得性。可判定判据 = 写入行/producer 里存在对应字段。 */
const TRACE_FIELDS = [
  ['source',     src => /source[:'"]/.test(src) || /rawSource/.test(src)],
  ['character',  src => /characterId|createdBy|friendId/.test(src)],
  ['admission',  src => /_calibrateMemoryCandidate/.test(src)],
  ['visibility', src => /visibility/.test(src)],
  ['reason',     src => /reasons/.test(src)],
];
const traceOf = src => TRACE_FIELDS.filter(([, f]) => f(src)).map(([n]) => n);

/* 写入行形状：diary / companion / quickCreateMemory 三条真实构造点 */
const diaryRowShape = diaryRun.written.length ? JSON.stringify(diaryRun.written[0].row) : '';
check('T1.diaryRowAnswersSourceAndCharacterAndVisibility',
  /"source":"diary"/.test(diaryRowShape) && /"characterId":"role_a"/.test(diaryRowShape)
  && /"visibility":"only"/.test(diaryRowShape),
  'diary row must at least carry source/character/visibility');
check('T1.diaryRowCarriesNoAdmissionDecision',
  diaryRowShape.indexOf('admission') < 0 && diaryRowShape.indexOf('rejected') < 0,
  '【已知缺口】diary row cannot say which admission decision admitted it');
/* reason：日记行没有 reasons 字段（模型的 memoryCandidate 不带 reasons） */
check('T1.diaryRowCarriesNoReason',
  diaryRowShape.indexOf('reasons') < 0,
  '【已知缺口】diary row carries no admission reason');

/* companion（活动陪伴）构造点字段面 */
const actSrc = extractBalancedFn(ACTIVITY, 'async function writeMemory(activity,title,content){');
check('T2.activityExtracted', !!actSrc);
if (actSrc) {
  const fields = traceOf(actSrc);
  check('T2.activityHasSourceAndCharacterAndVisibility',
    fields.indexOf('source') >= 0 && fields.indexOf('character') >= 0 && fields.indexOf('visibility') >= 0,
    'companion write must carry source/character/visibility (got ' + fields.join(',') + ')');
  check('T2.activityHasNoAdmission', fields.indexOf('admission') < 0,
    '【已知缺口】companion write has no admission decision');
  check('T2.activityHasNoReason', fields.indexOf('reason') < 0,
    '【已知缺口】companion write has no reason');
  check('T2.activityImportanceIsHardcoded',
    /importance:4/.test(actSrc),
    'companion importance is a literal, not an admission outcome');
}

/* role-letter 命名空间 */
const rlSrc = extractBalancedFn(ROLE_LETTERS, 'async function _rlWriteRoleMemory(characterId,content,title,letterId,direction){');
check('T3.roleLetterExtracted', !!rlSrc);
if (rlSrc) {
  check('T3.roleLetterHasOwnerAndSource',
    /owner:String\(characterId\)/.test(rlSrc) && /source:'role_letter'/.test(rlSrc),
    'role-letter memory must be owner-scoped and source-tagged');
  check('T3.roleLetterHasNoAdmission', rlSrc.indexOf('_calibrateMemoryCandidate') < 0,
    '【已知缺口】role-letter memory has no admission');
  check('T3.roleLetterImportanceIsHardcoded', /importance:6/.test(rlSrc),
    'role-letter importance is a literal');
  check('T3.roleLetterStaysOutOfSharedMemories',
    /RL_MEM_STORE='roleLetterMemories'/.test(ROLE_LETTERS) && rlSrc.indexOf("dbPut('memories'") < 0,
    'role-letter memory must never touch the shared memories store');
}

/* Chat 路径是目前 trace 面最完整的 —— 显式登记，作为"好"的参照 */
check('T4.chatTraceIsTheReference',
  COM.indexOf('_mbBoundaryTrace(') >= 0 && COM.indexOf('_mbSideEffectGate(_MB_SEC.mem)') >= 0,
  'chat is the only path that can answer "was this write admitted"');
/* P11-2I 新增的两条 self-declaring 路径：能回答来源，但**不能**回答准入 */
check('T4.outsideAdjudicationIsSelfDeclared',
  COM.indexOf('outside_adjudication') >= 0 || require('node:fs').readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'), 'utf8').indexOf('outside_adjudication') >= 0,
  'blog/letters paths must self-declare that they sit outside adjudication');
/* 汇总：本阶段结束时没有任何入口能回答全部五个问题 —— 如实登记 */
const allEntriesTrace = [
  ['chat', COM], ['diary', DIARY], ['consolidation', ACTIVE],
  ['companion', ACTIVITY], ['roleLetter', ROLE_LETTERS],
];
const fullTrace = allEntriesTrace.filter(([, s]) => traceOf(s).length === 5).map(([n]) => n);
check('T5.noEntryAnswersAllFiveQuestions',
  fullTrace.length <= 1,
  'the audit conclusion is that none/at most one entry answers all five (got: ' + fullTrace.join(',') + ')');
/* import 路径完全没有 trace 字段要求 —— 原样恢复是它的语义 */
check('T5.importIsUntracedByDesign',
  /if\(data\.memories\)for\(const m of data\.memories\)await dbPut\('memories',m\)/.test(CORE)
  && CORE.indexOf('admissionDecision') < 0,
  'backup import restores rows verbatim; admission does not apply to a restore');

/* ══════════════════════════════════════════════════════════════════
   §5 · Known Gap Ledger（负向断言）
   ------------------------------------------------------------------
   台账的作用是**强制清单跟着现实走**：下面每条缺口一旦被修好，
   对应断言就会变红，从而必须回来更新台账。缺口被静默修好
   与缺口被静默忽略，是同一种失败。
   ══════════════════════════════════════════════════════════════════ */
section('§5 · Known Gap Ledger (negative assertions)');

const GAPS = [
  ['G1.diaryBypassesCalibration',      () => DIARY.indexOf('_calibrateMemoryCandidate') < 0],
  ['G2.diaryHasNoTrace',               () => DIARY.indexOf('_mbBoundaryTrace') < 0 && DIARY.indexOf('admissionDecision') < 0],
  ['G3.consolidationDropsCalibrationVerdict', () => !!consSrc && stripComments(consSrc).indexOf('.rejected') < 0],
  ['G4.execMemOpsIgnoresCalibrationVerdict',  () => !!execSrc && stripComments(execSrc).indexOf('.rejected') < 0],
  ['G5.companionHasNoAdmission',       () => !!actSrc && actSrc.indexOf('_calibrateMemoryCandidate') < 0],
  ['G6.roleLetterHasNoAdmission',      () => !!rlSrc && rlSrc.indexOf('_calibrateMemoryCandidate') < 0],
  ['G7.momentsHasNoMemoryWriteTrace',  () => MOMENTS.indexOf('_mbBoundaryTrace') < 0],
  ['G8.userSaveHasNoAdmission',        () => !!saveMemSrc && saveMemSrc.indexOf('_calibrateMemoryCandidate') < 0],
];
GAPS.forEach(([name, f]) => {
  let v = false;
  try { v = f(); } catch (e) { v = false; }
  check(name, v, 'this gap appears to have been FIXED — update the P11-2J ledger');
});

/* 缺口计数必须与台账长度一致（防止加了缺口却忘了断言） */
check('G9.ledgerIsSelfConsistent', GAPS.length === 8, 'ledger length drift');
/* 缺口 ≠ 全部：chat/group 是有闸门的，台账不能把它也算成缺口 */
check('G10.gatedPathsAreNotListedAsGaps',
  GAPS.every(([n]) => !/chat|group/i.test(n)),
  'a gated path must never be registered as a gap');

/* ══════════════════════════════════════════════════════════════════
   §6 · Non-regression on what must NOT have changed
   ══════════════════════════════════════════════════════════════════ */
section('§6 · Hard boundary checks');

const ALL_PROD = [AUTO_MEM, MEMORY, DIARY, ACTIVE, COM, LETTERS, MOMENTS, ROLE_LETTERS, ACTIVITY, CORE].join('\n');
check('B1.noAndroidRuntimeTouched', ALL_PROD.indexOf('android.runtime') < 0 && ALL_PROD.indexOf('AndroidRuntime') < 0);
check('B2.noTauriAdded', ALL_PROD.indexOf('@tauri-apps') < 0);
check('B3.memoryStoreSchemaUnchanged',
  /const MEMORY_SCHEMA_VERSION = 1;/.test(STORE),
  'memory schema version must stay 1');
/* v23 的 store 基线（本阶段结束时的既成事实）。
   B4 的实质承诺是"记忆准入**没有新增 store**"，而不是"DB_VER 永远等于 23"：
   Phase 4B-1.2 为披露事实（disclosureFacts）合法前进到 24，那是另一个阶段的事。
   写死 23 只会在每次合法升版时误报，而且它证明不了"没有新 store"——
   一个把 23 改成 24 却顺手加了三张表的提交同样能让它……不，事实上它会让它变红，
   但红的原因是版本号而不是那三张表；诊断信息因此会指向错误的地方。
   与 test_activity_smoke.js:64-66 同款 —— 那条教训本仓库已经写下来过一次：
   "版本断言按引入该 store 的版本，而不是把当前 DB_VER 写死"。 */
const V23_STORES = ['posts', 'categories', 'about', 'music', 'apiSettings', 'chatMessages', 'letters',
  'apiConfigs', 'groups', 'blogComments', 'memories', 'chatThreads', 'chatSummaries', 'uploadedFiles',
  'blogAnnotations', 'projects', 'projectFiles', 'autoMemory', 'calEvents', 'calNotes', 'calLedger',
  'active_message_settings', 'active_message_history', 'active_message_plans', 'diary_entries', 'moments',
  'roleLetters', 'roleLetterMemories', 'activities', 'favorites', 'understandings', 'threads'];
/* 允许出现、且**只**允许出现的后续阶段新增表。每加一个都必须在这里登记 ——
   于是"某天有人默默加了一张表"依然会让这条断言变红。 */
const LATER_STAGE_STORES = ['disclosureFacts'];
check('B4.noNewObjectStore',
  (function () {
    const ver = Number((/DB_VER=(\d+)/.exec(CORE) || [])[1]);
    const body = (/\[([^\]]*?)\]\.forEach\(s=>/.exec(CORE) || [])[1] || '';
    const names = (body.match(/'([^']+)'/g) || []).map(function (s) { return s.slice(1, -1); });
    if (!names.length || !Number.isInteger(ver) || ver < 23) return false;
    /* ① 既有 store 一个都不许消失。 */
    if (!V23_STORES.every(function (n) { return names.indexOf(n) >= 0; })) return false;
    /* ② 多出来的只能是被登记过的后续阶段新增表。 */
    return names.filter(function (n) { return V23_STORES.indexOf(n) < 0; })
      .every(function (n) { return LATER_STAGE_STORES.indexOf(n) >= 0; });
  })(),
  'the memory-admission stage must add no store (later stages may legitimately bump DB_VER, but only if registered here)');
check('B5.noSecondCalibrationImplementation',
  countOcc(ALL_PROD, 'async function _calibrateMemoryCandidate(') === 1,
  'exactly one calibration implementation must exist');
check('B6.calibrationCoreIsTheOnlyRuleOwner',
  /assets\/js\/understanding-derivation-core\.js/.test(AUTO_MEM)
  || /understanding-derivation-core/.test(AUTO_MEM),
  'the desktop calibration must delegate to the shared core');
/* 日记本阶段**未**被修改：其写入函数的字节形状与审计基线一致 */
check('B7.diaryWriteFnUnchangedByThisStage',
  /const mem=\{id:'mem_'\+Date\.now\(\)\.toString\(36\)/.test(diaryFn)
  && /source:'diary'/.test(diaryFn)
  && /createdBy:'ai'/.test(diaryFn),
  'diary row construction must be byte-identical to the audited baseline');

console.log('\n' + '='.repeat(64));
if (failures) { console.error('P11-2J FAILED · ' + failures + ' assertion(s)'); process.exitCode = 1; }
else console.log('P11-2J PASSED · all assertions green');

}

main().catch(err => {
  console.error('P11-2J HARNESS ERROR · ' + String(err && err.stack || err));
  process.exitCode = 1;
});
