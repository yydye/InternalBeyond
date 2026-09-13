/* ====================================================================
   P11-2F · Group Runtime Integrity & Memory Boundary · 离线确定性回归
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     群聊回合里，**每个参与角色**的记忆写入与身份边界，有没有一个
     可执行的判据在拦？还是只靠注释维持？

   ── 必须先说清楚的事实（本阶段不掩盖它）─────────────────────────────
   P11-2C 的既有边界原文：群聊/博客留言等路径**拿不到 verdict**，
   "属存量行为"。因此群聊的 mem_* 既不经过裁定，也不经过副作用闸门。

   本阶段**没有**改变这条边界 —— 没有给群聊加 Character Integrity
   （那需要先解决 Home Node 凭据边界，是用户已明确决定的另一件事）。
   本阶段做的是把"群聊记忆写入政策"从**注释**升级为**可执行判据**：
     · 目标是发言成员自己的私有长期记忆（autoMemory，按角色 id 存储）
     · 任何其它目标域一律拒，并留下 blockedReason
     · 群 id 冒充角色域一律拒（否则全部成员私有记忆塌缩进同一 friendId）

   ── 被冻结的契约（本阶段唯一新增的东西）────────────────────────────
     MB_GROUP_MEMORY_SCOPE          { session, private_role, group_shared, hidden_system }
     MB_GROUP_MEMORY_WRITABLE_SCOPE = private_role（群聊唯一允许的写入目标）
     MB_GROUP_MEMORY_DENY           稳定拒止原因枚举
     middleBrainGroupMemoryPolicy(verdict, scope, kind, characterId)
       → { allowed, policyDecision, blockedReason, scope, category }
       policyDecision ∈ { allow, deny, unverified }

   trace 新增 5 个字段（§4）：groupId / participants / memoryScope /
   policyDecision / blockedReason。全部是元数据：不含记忆正文、条目 id、
   昵称、路径或密钥。

   ── 硬边界（本阶段一律未触碰）──────────────────────────────────────
   不修改 Provider Adapter；不绕过 MiddleBrainPolicy；不恢复前端直接
   prompt 拼接；不给 Android 增加运行时或凭据；不新增 /mobile/v1 动词。
   auto-memory 的存储布局、审批 UI、calibration 准入、群聊摘要存储
   （chatSummaries）全部未动。

   ── 运行 ────────────────────────────────────────────────────────────
     node tests/test_p11_2f_android_group_integrity.js
   纯 Node、零网络、零浏览器、零真实 provider 调用。
   求值的是**生产源码本身**。
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
const rd = p => fs.readFileSync(path.join(ROOT, 'assets', 'js', p), 'utf8').replace(/\r\n/g, '\n');
const rds = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const COM = rd('communication.js');
/* 从源码里按**大括号配平**取出一个函数的完整文本。
   为什么不用正则：`function f(...) { ... }` 的收尾缩进既取决于嵌套层级，也受行尾
   空格影响 —— 本文件最初两次尝试都因此失败（一次切在 `for` 的闭括号上导致函数少一个
   `}`，一次因尾随空格完全匹配不到）。配平法只依赖花括号计数。
   调用方必须对"取不到"负责：取到 null 要变成红断言，绝不能让异常打断整个文件。 */
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

console.log('P11-2F · Group Runtime Integrity & Memory Boundary · offline deterministic');

/* ══════════════════════════════════════════════════════════════════
   0 · 生产装配（与 P11-2E notice 同一条路径）
   ══════════════════════════════════════════════════════════════════ */
globalThis.window = globalThis;
globalThis.IBModelCore = globalThis.IBModelCore || {};
/* 本阶段不发起任何模型调用；astra 层只需可加载。
   这个计数器是本文件的"零调用"证明：任何一次真实 provider 请求都会让它非零。 */
const model = { calls: 0 };
globalThis._ibApiPost = async function () { model.calls++; throw new Error('P11-2F must not call any provider'); };

require(path.join(ROOT, 'assets', 'js', 'middle-brain-config.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-policy.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-astra.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-judge.js'));
require(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'));

const MBC = globalThis.IB && globalThis.IB.__middleBrainContracts;
if (!MBC || !MBC.integrity) throw new Error('canonical integrity layer unavailable');
const INTEG = MBC.integrity;
const VERDICT = INTEG.MB_CI_VERDICT;
const SCOPE = INTEG.MB_GROUP_MEMORY_SCOPE;
const DENY = INTEG.MB_GROUP_MEMORY_DENY;

let cfgOverride = {};
const baseCfg = () => Object.assign({
  enabled: true, characterIntegrityEnabled: true,
  endpoint: 'http://127.0.0.1:9/never-called', model: 'p11-2f-model', apiKey: 'p11-2f-local'
}, cfgOverride);
globalThis.__ibMiddleBrainConfigReader = async () => baseCfg();

require(path.join(ROOT, 'assets', 'js', 'middle-brain.js'));
const FACADE = globalThis.IB.middleBrain;
if (!FACADE) throw new Error('facade unavailable');

/* 政策本体：唯一判据来源。 */
const POLICY = FACADE.middleBrainGroupMemoryPolicy;
const PRIVATE = SCOPE.PRIVATE_ROLE;

/* ══════════════════════════════════════════════════════════════════
   1 · 契约冻结：枚举只读、词表与解析器同源
   ══════════════════════════════════════════════════════════════════ */
section('1 · 契约冻结（S1–S4）');

check('S1.policyIsExposedOnTheFacadeOnly',
  typeof POLICY === 'function' && FACADE.MB_GROUP_MEMORY_SCOPE === SCOPE
  && FACADE.MB_GROUP_MEMORY_WRITABLE_SCOPE === PRIVATE && FACADE.MB_GROUP_MEMORY_DENY === DENY);

/* 枚举必须真冻结：P11-2C 曾在"只写了冻结而对象没被 freeze"上踩过一次。 */
check('S2.enumsAreActuallyFrozen',
  Object.isFrozen(SCOPE) && Object.isFrozen(DENY)
  && Object.keys(SCOPE).length === 4
  && Object.keys(DENY).length === 5,
  JSON.stringify({ scopes: Object.keys(SCOPE), deny: Object.keys(DENY) }));
/* 冻结不是"可以改一个值试试"—— 改写必须静默失败且原值不变。 */
{
  const before = SCOPE.PRIVATE_ROLE;
  try { SCOPE.PRIVATE_ROLE = 'tampered'; } catch (e) { /* 严格模式抛错也是正确结果 */ }
  check('S2b.frozenEnumsCannotBeRewritten', SCOPE.PRIVATE_ROLE === before && before === 'private_role', String(SCOPE.PRIVATE_ROLE));
}

/* 唯一可写域只能是 private_role（群聊不允许写共享群记忆 / 系统记忆）。 */
check('S3.writableScopeIsPrivateRoleOnly',
  INTEG.MB_GROUP_MEMORY_WRITABLE_SCOPE === SCOPE.PRIVATE_ROLE
  && INTEG.MB_GROUP_MEMORY_WRITABLE_SCOPE !== SCOPE.GROUP_SHARED
  && INTEG.MB_GROUP_MEMORY_WRITABLE_SCOPE !== SCOPE.HIDDEN_SYSTEM);

/* kind 词表必须与 auto-memory.js 的真实解析器同源 —— 两处漂移会让
   政策放行一个解析器根本不会产出的 kind，或拒掉一个它真会产出的 kind。 */
{
  const AM = rd('memory/auto-memory.js');
  const re = AM.match(/const re=\/<mem_\(([^)]*)\)/);
  const parsedKinds = re ? re[1].split('|').map(s => s.trim()).sort() : [];
  /* 政策本体里的词表是源码中的 _MB_GROUP_MEM_OPS 字面量。 */
  const lit = rd('middle-brain-integrity.js').match(/_MB_GROUP_MEM_OPS\s*=\s*Object\.freeze\(\[([^\]]*)\]/);
  const policyKinds = lit ? lit[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort() : [];
  check('S4.kindVocabularyMatchesTheRealParser',
    parsedKinds.length === 3 && JSON.stringify(parsedKinds) === JSON.stringify(policyKinds),
    JSON.stringify({ parsedKinds, policyKinds }));
  /* 三种 kind 都必须能被真实解析器解析出来（证词表不是凭空写的）。 */
  const parseSrc = AM.match(/function _parseMemOps\(text\)\{[\s\S]*?\n\}/);
  const parse = parseSrc ? new Function(parseSrc[0] + '; return _parseMemOps;')() : null;
  const probed = parse ? parse('<mem_create category="work_context">{"content":"a"}</mem_create>'
    + '<mem_update id="am_1">{"content":"b"}</mem_update>'
    + '<mem_delete id="am_2"/>').ops.map(o => o.kind).sort() : [];
  check('S4b.policyKindsAreExactlyWhatTheParserProduces',
    JSON.stringify(probed) === JSON.stringify(policyKinds), JSON.stringify({ probed, policyKinds }));
}

/* ══════════════════════════════════════════════════════════════════
   2 · 分类器行为（P1–P8）
   ══════════════════════════════════════════════════════════════════ */
section('2 · 群聊记忆写入分类器');

const KIND = 'create';
const ROLE = 'friend_alice';

/* —— PASS 侧：唯一可写目标域 —— */
{
  const d = POLICY(null, PRIVATE, KIND, ROLE);
  check('P1.privateRoleMemoryIsAllowed', d.allowed === true && d.policyDecision === 'allow' && d.blockedReason === null,
    JSON.stringify(d));
  check('P1b.noVerdictDoesNotTurnIntoADeny',
    d.policyDecision !== 'deny' && d.blockedReason === null, JSON.stringify(d));
  /* 三种 kind 在合法域下都必须放行 —— 只放行 create 会让 update/delete 静默失效。 */
  const all = ['create', 'update', 'delete'].map(k => POLICY(null, PRIVATE, k, ROLE).allowed);
  check('P1c.allThreeKindsAllowedInTheWritableScope', all.every(v => v === true), JSON.stringify(all));
}

/* —— 其它三个域一律拒（可写清单的直接对偶面）—— */
{
  const bad = [SCOPE.SESSION, SCOPE.GROUP_SHARED, SCOPE.HIDDEN_SYSTEM];
  const res = bad.map(s => POLICY(null, s, KIND, ROLE));
  check('P2.nonWritableScopesAreDenied',
    res.every(r => r.allowed === false && r.policyDecision === 'deny' && r.blockedReason === DENY.OUT_OF_SCOPE),
    JSON.stringify(res));
  /* 共享群记忆本阶段**不存在**群侧写入路径：如实拒绝，而不是假装允许。 */
  check('P2b.groupSharedWritesAreDeniedNotSilentlyAllowed',
    POLICY(null, SCOPE.GROUP_SHARED, KIND, ROLE).allowed === false);
}

/* —— 群 id 冒充角色域：本函数存在的首要理由 —— */
{
  const d = POLICY(null, PRIVATE, KIND, 'group_1760000000000');
  check('P3.groupIdAsCharacterIsDenied',
    d.allowed === false && d.blockedReason === DENY.GROUP_AS_CHARACTER, JSON.stringify(d));
  /* 任何 group_ 前缀都必须拒，不只看一个样本。 */
  const many = ['group_1', 'group_', 'group_abc123'].map(g => POLICY(null, PRIVATE, KIND, g).allowed);
  check('P3b.anyGroupPrefixedIdIsDenied', many.every(v => v === false), JSON.stringify(many));
  /* 反证：正常角色 id 绝不能被这条守卫误杀（含 friend_ 前缀与纯数字 id）。 */
  const ok = ['friend_alice', '1730000000000', 'api_1', 'role-x'].map(r => POLICY(null, PRIVATE, KIND, r).allowed);
  check('P3c.normalRoleIdsAreNotCaughtByTheGroupGuard', ok.every(v => v === true), JSON.stringify(ok));
}

/* —— 缺角色域 / 未知 kind / 非法 scope：一律拒，且原因各不相同 —— */
{
  const noChar = [null, undefined, '', '   '].map(c => POLICY(null, PRIVATE, KIND, c));
  check('P4.missingCharacterDomainIsDenied',
    noChar.every(d => d.allowed === false && d.blockedReason === DENY.NO_CHARACTER), JSON.stringify(noChar));

  const badKind = ['rename', 'create_shared', 'MEM_CREATE_GROUP', 'promote', ''].map(k => POLICY(null, PRIVATE, k, ROLE));
  check('P5.unknownKindsAreDenied',
    badKind.every(d => d.allowed === false && d.blockedReason === DENY.UNKNOWN_KIND), JSON.stringify(badKind));
  /* 大小写不是绕过途径：'CREATE' 归一化后是真 kind，必须放行而不是被当成未知。 */
  check('P5b.kindNormalizationIsNotABypassInEitherDirection',
    POLICY(null, PRIVATE, 'CREATE', ROLE).allowed === true
    && POLICY(null, PRIVATE, 'Create', ROLE).allowed === true
    && POLICY(null, PRIVATE, 'creates', ROLE).allowed === false);

  const badScope = ['', 'public', 'shared', 'PRIVATE_ROLE', 'private-role', null, undefined].map(s => POLICY(null, s, KIND, ROLE));
  check('P6.unknownOrMisspelledScopesAreDenied', badScope.every(d => d.allowed === false), JSON.stringify(badScope));
  /* 刻意：scope 不做大小写归一 —— 一个拼错的域不能被"猜"成合法域。 */
  check('P6b.scopeIsNotGuessedFromNearMisses',
    POLICY(null, PRIVATE.toUpperCase(), KIND, ROLE).allowed === false);
}

/* —— 裁定状态的效果：scope 合法时是否被标成 unverified —— */
{
  const cases = [
    [VERDICT.PASS, 'allow'], [VERDICT.OOC, 'allow'], [VERDICT.BYPASSED, 'allow'],
    [VERDICT.UNDECIDED, 'unverified'], [null, 'allow'], ['NONSENSE', 'allow']
  ];
  const got = cases.map(([v]) => POLICY(v, PRIVATE, KIND, ROLE).policyDecision);
  check('P7.onlyUndecidedIsMarkedUnverified',
    JSON.stringify(got) === JSON.stringify(cases.map(c => c[1])), JSON.stringify(got));
  /* unverified 仍 allowed=true：群聊不经过裁定，本阶段**不改变**既有执行行为。 */
  check('P7b.unverifiedDoesNotBlockByItself',
    POLICY(VERDICT.UNDECIDED, PRIVATE, KIND, ROLE).allowed === true);
}

/* —— scope 合法性优先于裁定状态（顺序不可颠倒）—— */
{
  /* 一个"已判定通过"的越界写入仍然是越界写入。 */
  const d = POLICY(VERDICT.PASS, SCOPE.GROUP_SHARED, KIND, ROLE);
  check('P8.scopeLegalityOutranksVerdict',
    d.allowed === false && d.policyDecision === 'deny' && d.blockedReason === DENY.OUT_OF_SCOPE,
    JSON.stringify(d));
  /* 群 id 冒充域在 UNDECIDED 下也照样是 deny，而不是 unverified。 */
  const d2 = POLICY(VERDICT.UNDECIDED, PRIVATE, KIND, 'group_9');
  check('P8b.undecidedDoesNotDowngradeABlockToUnverified',
    d2.policyDecision === 'deny' && d2.blockedReason === DENY.GROUP_AS_CHARACTER, JSON.stringify(d2));
}

/* —— 纯函数：无副作用、判定不依赖调用次数 —— */
{
  const a = POLICY(null, PRIVATE, KIND, ROLE);
  const b = POLICY(null, PRIVATE, KIND, ROLE);
  check('P9.classifierIsPureAndDeterministic',
    JSON.stringify(a) === JSON.stringify(b) && model.calls === 0);
  check('P9b.classifierNeverCallsTheModel', model.calls === 0, String(model.calls));
}

/* ══════════════════════════════════════════════════════════════════
   3 · 群聊路径的真实护栏（G1–G5）
   ══════════════════════════════════════════════════════════════════ */
section('3 · communication.js 群聊调用点');

/* 群聊 mem_* 必须先经政策判定，再决定执行哪些 —— 且只能执行被放行的那些。 */
check('G1.groupPathConsultsThePolicyBeforeExecuting',
  /const _d=_mbGroupMemPolicy\(_gScopeOf\(_op\),\(_op&&_op\.kind\)\|\|'',cfg&&cfg\.id\);/.test(COM)
  && /if\(_d\.allowed===true\)_gAllowed\.push/.test(COM));
/* 落库的必须正是被放行的那批，而不是原始 ops。 */
check('G2.onlyAllowedOpsReachTheExecutor',
  /_execMemOps\(_gAllowed\.map\(x=>x\.op\),cfg,selfName\)/.test(COM)
  && countOcc(COM, '_execMemOps(_gmp.ops,cfg,selfName)') === 0,
  String(countOcc(COM, '_execMemOps(_gmp.ops,cfg,selfName)')));
/* 每一批被拒的指令都要留下 trace。 */
check('G3.everyBlockedOpLeavesATrace',
  /_gBlocked\.forEach\(function\(_d\)\{_mbGroupTraceBlock\(cfg\.id,_d\)\}\)/.test(COM));
/* 群聊政策只有一个判定入口，且它不复制政策本体（只转发到门面）。 */
check('G4.policyHasExactlyOneAdapterEntryPoint',
  countOcc(COM, 'function _mbGroupMemPolicy(') === 1
  && countOcc(COM, '_mbGroupMemPolicy(') === 2 /* 1 定义 + 1 调用 */
  && /_f\.middleBrainGroupMemoryPolicy\(_mbVerdict,scope,kind,characterId\)/.test(COM));
/* 政策本体不可用时 fail closed（与 calibration 准入同一纪律）。 */
check('G5.policyUnavailableFailsClosed',
  /if\(!_f\|\|typeof _f\.middleBrainGroupMemoryPolicy!=='function'\)\{[\s\S]{0,180}?blockedReason:'policy_unavailable'/.test(COM));
/* 适配层**不得**自带 scope 字面量 —— 那会是第二份政策实现。 */
{
  const helperBlock = COM.match(/function _mbSecGroupScope\(\)\{[\s\S]*?\n\}/);
  const src = helperBlock ? helperBlock[0] : '';
  check('G5b.adapterDoesNotHardcodeScopeLiterals',
    src.length > 0 && src.indexOf("'private_role'") < 0 && src.indexOf("'group_shared'") < 0
    && src.indexOf('MB_GROUP_MEMORY_SCOPE') >= 0, src);
}

/* ══════════════════════════════════════════════════════════════════
   4 · trace 字段（§4，T1–T6）
   ══════════════════════════════════════════════════════════════════ */
section('4 · Runtime trace 字段');

/* 需求点名的 5 个字段必须真的在字段表里，且是**追加**（既有 23 个顺序未动）。
   提取方式刻意做成**结构化**的：注释块就写在数组字面量内部，因此"取所有带引号的词"
   必然把注释里的枚举值（'allow' / 'deny' / 'unverified' / 'private_role'）也算进来。
   这里改为按"是否为已知字段名"过滤，再按出现顺序排序 —— 于是断言仍然能抓住
   「字段被删」「字段被挪到前面」「注释被误当字段」三种回归，而不会被注释本身带偏。 */
{
  const MB = rd('middle-brain.js');
  const arr = MB.match(/_MB_TRACE_FIELDS\s*=\s*\[([\s\S]*?)\];/);
  const body = arr ? arr[1] : '';
  const PRE_EXISTING = ['consumer', 'character', 'enabled', 'executeEntered', 'configApplied', 'policyApplied',
    'astraApplied', 'judgeApplied', 'oocGuardApplied', 'integrityVerdict', 'integrityReason', 'judgeAttempted',
    'integrityRewritten', 'sideEffectsSuppressed', 'sideEffectCategories', 'inputMessages', 'outputMessages',
    'systemChanged', 'requestParamsChanged', 'executor', 'model', 'source', 'messagesChanged'];
  const REQUIRED = ['groupId', 'participants', 'memoryScope', 'policyDecision', 'blockedReason'];
  const KNOWN = PRE_EXISTING.concat(REQUIRED);
  const hits = [];
  KNOWN.forEach(k => {
    /* 只匹配 `'name'` 形态的数组元素，避免把别处的同名标识符算进来 */
    const at = body.indexOf("'" + k + "'");
    if (at >= 0) hits.push({ k, at });
  });
  hits.sort((a, b) => a.at - b.at);
  const names = hits.map(h => h.k);

  check('T1.allFiveRequiredTraceFieldsDeclared',
    REQUIRED.every(k => names.indexOf(k) >= 0), JSON.stringify(names));
  check('T2.existingFieldsKeepTheirOriginalOrderAndCount',
    JSON.stringify(names.slice(0, 23)) === JSON.stringify(PRE_EXISTING) && names.length === 28,
    JSON.stringify({ n: names.length, head: names.slice(0, 23) }));
  check('T3.newFieldsAreAppendedAtTheEnd',
    JSON.stringify(names.slice(23)) === JSON.stringify(REQUIRED), JSON.stringify(names.slice(23)));
}

/* 行为：真实 trace 记录里，5 个字段初始值必须是"没有群聊语义"，而不是伪造的群值。 */
{
  const _mbTrace = globalThis.IB.__mbTrace;
  const rec = _mbTrace.begin('chat', 'p11_2f_trace_probe');
  check('T4.traceRecordStartsWithNoGroupSemantics',
    rec && rec.groupId === null && Array.isArray(rec.participants) && rec.participants.length === 0
    && rec.memoryScope === null && rec.policyDecision === null && rec.blockedReason === null,
    JSON.stringify(rec && { g: rec.groupId, p: rec.participants, m: rec.memoryScope, d: rec.policyDecision, b: rec.blockedReason }));
  /* 单聊回合不得因为新增字段而带上群聊语义。 */
  check('T4b.singleChatTurnsStayFreeOfGroupFields',
    rec && rec.participants.length === 0 && rec.groupId === null);
  /* blockedReason 默认 null = "本回合没有拦截"，绝不是 false。 */
  check('T4c.blockedReasonDefaultsToNullNotFalse', rec.blockedReason === null && rec.blockedReason !== false);
  _mbTrace.finish('p11_2f_trace_probe', {});
}

/* 文本渲染：5 个字段都必须打印**实际值**，不能退化成恒 false。 */
{
  const MB = rd('middle-brain.js');
  const hasArrayBranch = /k === 'participants'\) lines\.push\(k \+ ': ' \+ \(Array\.isArray\(v\) \? v\.join\(','\)/.test(MB);
  const hasTextBranch = /k === 'groupId' \|\| k === 'memoryScope' \|\| k === 'policyDecision' \|\| k === 'blockedReason'\)/.test(MB);
  check('T5.traceTextPrintsActualValuesForNewFields', hasArrayBranch && hasTextBranch);
}
/* 断言渲染行为本身（不是文本匹配）：装模块、造记录、看输出行。 */
{
  const MB_SRC = rd('middle-brain.js');
  /* 用**大括号配平**切函数，而不是靠"闭括号的缩进"—— 后者对尾随空格与
     嵌套层级都过于敏感（本段最初两次都栽在这里：一次切在 `for` 的闭括号上，
     一次因为行尾空格而完全匹配不到）。配平法只依赖花括号计数，且对
     "字符串里出现花括号"这种情况在本函数里不存在（没有字符串常量含 `{` / `}`）。 */
  const textFnSrc = extractBalancedFn(MB_SRC, 'function _mbTraceText(rec) {');
  check('T5b.traceTextRendererIsExtractable', !!textFnSrc, String(textFnSrc && textFnSrc.length));
  if (textFnSrc) {
    /* 必须匹配**数组字面量的收尾** `'];'`，不能用惰性的 `[\s\S]*?\];` ——
       后者会在函数体内 `_MB_TRACE_FIELDS[i]` 的 `]` 处提前收尾，把 `[i];` 一起
       截进表达式里，于是 new Function 直接 SyntaxError。 */
    const fieldsSrc = MB_SRC.match(/_MB_TRACE_FIELDS\s*=\s*\[[\s\S]*?'\];/)[0];
    /* 提取失败必须变成一条**红断言**，而不是让 new Function 抛出去把整个文件打断 ——
       被异常打断的测试会静默少跑后面所有断言，看起来"只有 N 条、失败为 0"。
       这是本文件自己的 harness 纪律：任何"从源码里取函数"的步骤都要能被证伪。 */
    let fn = null, compileErr = '';
    try { fn = new Function('rec', fieldsSrc + '\n' + textFnSrc + '\nreturn _mbTraceText(rec);'); }
    catch (e) { compileErr = String(e && e.message || e); }
    check('T5b2.extractedTraceRendererCompiles', !!fn && !compileErr, compileErr);
    if (fn) {
      const out = fn({ groupId: 'group_7', participants: ['friend_a', 'friend_b'], memoryScope: 'private_role',
        policyDecision: 'deny', blockedReason: 'group_as_character' });
      check('T5c.renderedTraceCarriesGroupIdentityAndDecision',
        out.indexOf('groupId: group_7') >= 0 && out.indexOf('participants: friend_a,friend_b') >= 0
        && out.indexOf('memoryScope: private_role') >= 0 && out.indexOf('policyDecision: deny') >= 0
        && out.indexOf('blockedReason: group_as_character') >= 0, out);
      /* null 必须打印 null —— 一个恒为 false 的 blockedReason 无法回答"拦没拦"。 */
      const out2 = fn({});
      check('T5d.renderedTracePrintsNullNotFalse',
        out2.indexOf('policyDecision: null') >= 0 && out2.indexOf('blockedReason: null') >= 0
        && out2.indexOf('blockedReason: false') < 0, out2);
    }
  }
}

/* 群聊路径必须真的写这些字段。 */
check('T6.groupPathWritesGroupIdParticipantsAndScope',
  /function _mbGroupTraceContext\(groupId,traceKey,cfgs\)\{[\s\S]*?trace\.note\(key,'groupId'/.test(COM)
  && /trace\.note\(key,'participants',_mbGroupParticipants\(cfgs\)\)/.test(COM)
  && /trace\.note\(key,'memoryScope',_mbSecGroupScope\(\)\)/.test(COM));
/* 顺序纪律：群聊的 trace 字段必须在**该成员记录 begin 之后**写。
   `_mbTraceNote` 在没有 begin 过的记录上是静默 no-op，因此"写在 begin 之前"
   会让整片字段无声消失 —— 这正是本段最初的真实缺陷（当时把 context 写在循环前，
   群聊路径根本没有 trace 记录，5 个字段一个都没落地）。
   这里断言的是**代码里的相对顺序**：begin 调用点必须早于 context 写入调用点。 */
{
  const beginIdx = COM.indexOf("_mbTrace.begin('group',cfg.id)");
  const ctxIdx = COM.indexOf('_mbGroupTraceContext(_targetFriend,cfg.id,memberCfgs,selfName)');
  const loopIdx = COM.indexOf('for(const cfg of speakingCfgs)');
  check('T6b.groupTraceBeginsBeforeItsContextFieldsAreWritten',
    beginIdx > 0 && ctxIdx > 0 && loopIdx > 0 && loopIdx < beginIdx && beginIdx < ctxIdx,
    JSON.stringify({ loopIdx, beginIdx, ctxIdx }));
  /* 每个发言成员各收尾一次（与单聊 finish 同一纪律：finish 是唯一推进 ring 的点）。 */
  check('T6b2.eachSpeakngMemberFinishesItsOwnTrace',
    /_mbGroupTraceFinish\(cfg\.id,_mbVerdict\);/.test(COM)
    && /function _mbGroupTraceFinish\(traceKey,verdict\)\{/.test(COM));
  /* 群聊 trace 不写抑制字段：群聊不经过副作用闸门，绝不假装这里有抑制。 */
  const fin = COM.match(/function _mbGroupTraceFinish\(traceKey,verdict\)\{[\s\S]*?\n\}/);
  check('T6b3.groupFinishDoesNotClaimSuppression',
    !!fin && fin[0].indexOf('sideEffectsSuppressed') < 0,
    fin ? fin[0] : 'not found');
}
/* participants 只放 id、去重、稳定排序（顺序稳定是可观测性要求）。 */
{
  const fnSrc = COM.match(/function _mbGroupParticipants\(cfgs\)\{[\s\S]*?\n\}/);
  check('T6c.participantsHelperIsExtractable', !!fnSrc);
  if (fnSrc) {
    const f = new Function(fnSrc[0] + '; return _mbGroupParticipants;')();
    const a = f([{ id: 'friend_b' }, { id: 'friend_a' }, { id: 'friend_b' }, { id: '' }, null]);
    const b = f([{ id: 'friend_a' }, { id: 'friend_b' }]);
    check('T6d.participantsAreDedupedSortedAndIdOnly',
      JSON.stringify(a) === JSON.stringify(['friend_a', 'friend_b'])
      && JSON.stringify(a) === JSON.stringify(b), JSON.stringify({ a, b }));
    check('T6e.participantsCarryNoNicknamesOrPersona',
      f([{ id: 'friend_a', nickname: '爱丽丝', systemPrompt: 'PERSONA' }]).indexOf('爱丽丝') < 0);
  }
}

/* ══════════════════════════════════════════════════════════════════
   4b · trace 字段的**行为**验证（不是文本匹配）
   ══════════════════════════════════════════════════════════════════
   上面 T6b 断言的是源码里的相对顺序；这一段真的把 communication.js 的
   trace 辅助函数取出来跑一遍，证明字段**确实落进了记录**。

   为什么必须有这一段：本段最初的真实缺陷正是"顺序错了" —— context 写在
   成员循环 begin 之前，而 `_mbTraceNote` 在没有 begin 过的记录上是静默 no-op，
   于是 5 个字段一个都没落地，而所有文本匹配断言**全绿**。
   只有真正跑一遍才能把这种缺陷钉住。 */
section('4b · trace 字段落地（行为）');

{
  const MEMBER_A = { id: 'friend_alice', nickname: '爱丽丝' };
  const MEMBER_B = { id: 'friend_bob', nickname: '鲍勃' };

  const helpers = [
    extractBalancedFn(COM, 'function _mbSecGroupScope(){'),
    extractBalancedFn(COM, 'function _mbGroupParticipants(cfgs){'),
    extractBalancedFn(COM, 'function _mbGroupTraceContext(groupId,traceKey,cfgs){'),
    extractBalancedFn(COM, 'function _mbGroupTraceFinish(traceKey,verdict){'),
    extractBalancedFn(COM, 'function _mbGroupTraceBlock(traceKey,decision){')
  ];
  check('H1.allGroupTraceHelpersAreExtractable', helpers.every(Boolean),
    JSON.stringify(helpers.map(h => h ? h.length : null)));

  if (helpers.every(Boolean)) {
    const SCOPE_VAL = PRIVATE;
    /* 与生产同一形状：绑定到 window，并给出 MB_GROUP_MEMORY_SCOPE 词表。 */
    const win = {
      IB: {
        __mbTrace: globalThis.IB.__mbTrace,
        middleBrain: { MB_GROUP_MEMORY_SCOPE: { PRIVATE_ROLE: SCOPE_VAL } }
      }
    };
    const body = helpers.join('\n') + '\nreturn {ctx:_mbGroupTraceContext,fin:_mbGroupTraceFinish,blk:_mbGroupTraceBlock,part:_mbGroupParticipants,scope:_mbSecGroupScope};';
    const api = new Function('window', body)(win);

    check('H2.scopeComesFromTheIntegrityLayerNotALiteral', api.scope() === SCOPE_VAL);

    /* —— 生产顺序：begin → context → finish —— */
    const trace = win.IB.__mbTrace;
    trace.begin('group', MEMBER_A.id);
    api.ctx('group_1760000000000', MEMBER_A.id, [MEMBER_A, MEMBER_B], '爱丽丝');
    api.fin('friend_alice', null);
    const rec = trace.recent(1)[0];

    check('H3.fieldsActuallyLandInTheRecord',
      rec && rec.groupId === 'group_1760000000000'
      && JSON.stringify(rec.participants) === JSON.stringify(['friend_alice', 'friend_bob'])
      && rec.memoryScope === SCOPE_VAL,
      JSON.stringify(rec && { g: rec.groupId, p: rec.participants, m: rec.memoryScope }));
    check('H4.noMemoryInstructionLeavesDecisionNullNotAllow',
      rec.policyDecision === null && rec.blockedReason === null,
      JSON.stringify(rec && { d: rec.policyDecision, b: rec.blockedReason }));
    check('H5.participantNicknamesNeverReachTheTrace',
      rec && String(rec.participants).indexOf('爱丽丝') < 0 && String(rec.participants).indexOf('鲍勃') < 0);

    /* —— 反证：把 context 写在 begin 之前（本段修掉的真实缺陷形状）—— */
    trace.begin('group', MEMBER_B.id);
    /* 先 finish 掉，让记录进入 ring；随后在没有记录的情况下写 context，再 begin 一次。 */
    const helpersBefore = new Function('window', helpers.join('\n') + '\nreturn {ctx:_mbGroupTraceContext};')(win);
    helpersBefore.ctx('group_MUST_NOT_SURVIVE', MEMBER_B.id, [MEMBER_B], '鲍勃');
    trace.begin('group', MEMBER_B.id);   /* begin 重建记录 ⇒ 之前那次写入被丢弃 */
    trace.finish(MEMBER_B.id, {});
    const rec2 = trace.recent(1)[0];
    check('H6.writingContextBeforeBeginIsSilentlyLost_whichIsWhyOrderIsAsserted',
      rec2 && rec2.groupId === null,
      JSON.stringify(rec2 && { g: rec2.groupId }));

    /* —— 拦截路径：blockedReason 必须落进记录 —— */
    trace.begin('group', MEMBER_A.id);
    api.ctx('group_9', MEMBER_A.id, [MEMBER_A], '爱丽丝');
    api.blk(MEMBER_A.id, POLICY(null, PRIVATE, KIND, 'group_9'));
    trace.finish(MEMBER_A.id, {});
    const rec3 = trace.recent(1)[0];
    check('H7.blockedDecisionLandsInTheRecord',
      rec3 && rec3.policyDecision === 'deny' && rec3.blockedReason === DENY.GROUP_AS_CHARACTER,
      JSON.stringify(rec3 && { d: rec3.policyDecision, b: rec3.blockedReason }));
    /* 群聊 finish 不写抑制字段：绝不假装群聊发生过抑制。 */
    check('H8.groupFinishNeverClaimsSuppression',
      rec3 && rec3.sideEffectsSuppressed === null,
      JSON.stringify(rec3 && { s: rec3.sideEffectsSuppressed }));
  }
}

/* ══════════════════════════════════════════════════════════════════
   5 · Group Identity Boundary（§1，I1–I4）
   ══════════════════════════════════════════════════════════════════ */
section('5 · Group Identity Boundary');

/* §1 点名的 5 个维度必须各自有**既有**的 canonical 来源 ——
   本阶段不新增第二套角色表（P4 契约：apiConfigs 是唯一事实源）。 */
{
  /* P11-2H 修正（本段原先的红是**假红**，原因是提取方式而不是行为）：
     这里原来用 `COM.match(/async function _buildGroupChatContext\(cfg,opts\)\{[\s\S]*?\n\}/)`
     —— 惰性匹配到**第一个** `\n}`，而函数体内部（for / if / try 块）出现
     `\n  }` 的位置远早于函数真正的收尾，因此 `src` 一直只是函数的一小段前缀。
     I2 之所以一直绿，是因为 `if(cfg.relationship)` 恰好落在前缀里；
     一旦那行被改写（P11-2H 把它改成经过消毒的 `_rel`），前缀匹配随之失败，
     于是报了一条"persona 或 relationship 不再来自 cfg"——而真实情况恰恰相反。
     改用**大括号配平**提取完整函数（与 P11-2H 的 extractBalancedFn 同一纪律，
     见 test_p11_2h_group_prompt_boundary.js），让这一段的判据覆盖整个函数体。 */
  const ctxFn = extractBalancedFn(COM, 'async function _buildGroupChatContext(cfg,opts){');
  const src = ctxFn || '';
  check('I1.groupContextBuilderIsExtractable', src.length > 0);
  /* persona ← cfg.systemPrompt；relationship ← cfg.relationship
     （P11-2H 起 relationship 先经 canonical 消毒再插值，来源未变）。 */
  check('I2.personaAndRelationshipComeFromTheCharacterConfig',
    /let sysContent=cfg\.systemPrompt\|\|''/.test(src)
    && /_rel=_pbSanitize\(cfg\.relationship\|\|'','group\.relationship'\)/.test(src)
    && /if\(_rel\)sysContent=/.test(src));
  /* speech_style ← IB.brevity（按本成员 cfg 独立组合） */
  check('I3.speechStyleIsPerMemberAndNotSharedState',
    /IB\.brevity\.apply\(sysContent,\{mode:'text'[\s\S]{0,220}?concise:!!\(cfg&&cfg\.replyStyle==='concise'\)/.test(src));
  /* emotional_continuity ← Auto Memory 注入（按 cfg 独立） */
  check('I4.emotionalContinuityComesFromPerMemberAutoMemory',
    /if\(amEnabled\(cfg\)\)\{try\{_gAmInj=await amBuildInject\(cfg,_ctxText\)\}catch\(e\)\{\}\}/.test(src));
  /* 群聊规则必须显式禁止代其他成员发言（"不得覆盖原角色身份"的提示面） */
  check('I4b.groupRulesForbidSpeakingForOtherMembers',
    /绝对不要替其他成员或用户发言、代答、补写他们的台词或动作/.test(src));
  /* 临时上下文（时间 / 备忘 / 记忆）必须进 tail，不得污染长期 persona（system）。 */
  check('I4c.transientContextGoesToTailNotPersona',
    /let _gTailCtx='';[\s\S]{0,120}_gTailCtx\+='当前时间：'/.test(src)
    && /if\(gSummaryText\)_gTailCtx\+=/.test(src)
    && /if\(group\.memoryEnabled\)\{[\s\S]{0,200}?_gTailCtx\+=/.test(src));
}

/* 群名字段直接进 system prompt —— 换行/控制字符可以伪造"群聊规则"后续行。
   本阶段把它钉成一个可断言的事实（是否消毒是后续决策，不在本阶段改）。 */
{
  /* 同 I1 的提取方式（配平），理由见上。 */
  const ctxFn = extractBalancedFn(COM, 'async function _buildGroupChatContext(cfg,opts){') || '';
  const usesRawGroupName = /'【群聊规则】你是群聊"'\+group\.name\+'"中的成员"'\+selfName\+'"。'/.test(ctxFn);
  /* P11-2H 已实现这条边界（见 tests/test_p11_2h_group_prompt_boundary.js），
     因此本断言从"记录未消毒"改为"记录已消毒" —— 语义相反，但**不是放宽**：
     它现在检查的是同一处插值必须经过 canonical 消毒。
     保留 $ctxFn 的提取是为了让"群名到底怎么进去"这件事仍然在这份文件里可见。 */
  const sanitisesGroupName = /_gName=_pbSanitize\(group\.name\|\|'','group\.name'\)/.test(ctxFn)
    && ctxFn.indexOf("你是群聊\"'+_gName+'\"中的成员") >= 0;
  check('I5.groupNameEntersTheSystemPromptThroughTheCanonicalSanitizer',
    usesRawGroupName === false && sanitisesGroupName && ctxFn.length > 0,
    JSON.stringify({ raw: usesRawGroupName, san: sanitisesGroupName, n: ctxFn.length }));
  /* 但成员名与群名不得进入 trace（trace 是元数据面）。 */
  check('I5b.traceNeverCarriesGroupOrMemberNames',
    /trace\.note\(key,'participants',_mbGroupParticipants\(cfgs\)\)/.test(COM)
    && countOcc(COM, "trace.note(key,'groupName'") === 0);
}

/* ══════════════════════════════════════════════════════════════════
   6 · Group Memory Policy（§2，M1–M5）
   ══════════════════════════════════════════════════════════════════ */
section('6 · Group Memory Policy（写入域 × 读取域）');

/* —— 写入域：每条落库记录都以发言成员自己的 id 为键 —— */
{
  const AM = rd('memory/auto-memory.js');
  const execFn = AM.match(/async function _execMemOps\(ops,cfg,authorName\)\{[\s\S]*?\n\}/)[0];
  check('M1.createWritesToTheSpeakingMembersOwnStore',
    /const entry=\{id:_amNewId\(\),friendId:cfg\.id,/.test(execFn));
  /* update / delete 必须校验目标条目属于本成员 —— 这是"不读/不改 B 的私有记忆"的写侧闸门。 */
  check('M2.updateAndDeleteAreScopedToTheMembersOwnEntries',
    countOcc(execFn, 'ex.friendId!==cfg.id') >= 2, String(countOcc(execFn, 'ex.friendId!==cfg.id')));
  /* 未开启 Auto Memory 时任何路径都不落库（既有兜底，本阶段未动）。 */
  check('M3.executorRefusesWhenAutoMemoryIsOff',
    /if\(!amEnabled\(cfg\)\)return results;/.test(execFn));
}

/* —— 反证：把 scope 当成"共享群桶"来传时，落库键必须不是群 id ——
   这一段证明 M1 测的是真实行为，而不是一条恒真断言。 */
{
  const AM = rd('memory/auto-memory.js');
  const spawn = AM.match(/function _amNewId\(\)\{[\s\S]*?\n\}/)[0];
  const newId = new Function(spawn + '; return _amNewId;')();
  const groupCfg = { id: 'group_1760000000000', autoMem: true };
  const roleCfg = { id: 'friend_alice', autoMem: true };
  const rowFor = (cfg) => ({ id: newId(), friendId: cfg.id, content: 'x' });
  check('M4.groupScopedConfigWouldCollapseMemoryIntoOneBucket',
    rowFor(groupCfg).friendId === 'group_1760000000000');
  /* 这正是 P3 必须拒掉 group_ 前缀的原因：政策把这条路封死。 */
  check('M4b.whichIsExactlyWhatThePolicyBlocks',
    POLICY(null, PRIVATE, KIND, groupCfg.id).allowed === false
    && POLICY(null, PRIVATE, KIND, roleCfg.id).allowed === true);
}

/* —— 读取域：群聊只看得见 public —— */
{
  const VIS = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
  const mem = (v, extra) => Object.assign({ id: 'm_' + v, visibility: v, content: 'c' }, extra || {});
  const othersPrivate = mem('private', { visibleTo: ['friend_bob'] });
  const roleOnly = mem('only', { visibleTo: ['friend_bob'] });
  check('M5.privateMemoryIsInvisibleToAGroupMemberEvenWhenNamed',
    VIS.isMemoryVisibleTo(othersPrivate, 'friend_alice', true, true) === false);
  check('M5b.onlyAddressedToAnotherRoleIsInvisibleInGroup',
    VIS.isMemoryVisibleTo(roleOnly, 'friend_alice', true, true) === false);
  check('M5c.publicMemoryIsVisibleInGroupWhenSharedMemoryEnabled',
    VIS.isMemoryVisibleTo(mem('public'), 'friend_alice', true, true) === true);
  /* 群共享记忆未开启时，连 public 也不可见（既有门控）。 */
  check('M5d.groupSharedMemoryGateIsStillHonored',
    VIS.isMemoryVisibleTo(mem('public'), 'friend_alice', true, false) === false);
  /* fail closed：无 visibility 的旧数据在群里不可见。 */
  check('M5e.missingVisibilityFailsClosedInGroup',
    VIS.isMemoryVisibleTo({ id: 'm_legacy', content: 'c' }, 'friend_alice', true, true) === false);
}

/* ══════════════════════════════════════════════════════════════════
   7 · UNDECIDED 语义（§Task · 模型提出但无法确认的长期记忆）
   ══════════════════════════════════════════════════════════════════ */
section('7 · UNDECIDED · 无法确认的长期记忆');

/* 群聊**没有**裁定状态可交（P11-2C 既有边界，本阶段未改变）。
   因此"模型提出但无法确认"在群聊里的正确表达是 unverified —— 如实标出，
   而不是伪装成 allow，也不是越权替裁定做决定。 */
{
  const d = POLICY(VERDICT.UNDECIDED, PRIVATE, KIND, ROLE);
  check('U1.unconfirmableProposalIsMarkedUnverified',
    d.policyDecision === 'unverified' && d.category === 'unadjudicated', JSON.stringify(d));
  /* 但它**没有**被静默当成 deny —— 二者是不同的东西。 */
  check('U2.unverifiedIsNotDeny',
    d.blockedReason === null && d.policyDecision !== 'deny');
  /* 群聊路径的 _mbVerdict 恒为 null（无 CI）。null 必须落在 allow 而不是 unverified，
     否则每次群聊记忆写入都会被误标成"尝试过但没确认"。 */
  check('U3.nullVerdictIsNotUndecided',
    POLICY(null, PRIVATE, KIND, ROLE).policyDecision === 'allow');
  /* 真正的 UNDECIDED 只可能来自显式传入的状态。 */
  check('U4.undecidedRequiresAnExplicitState',
    POLICY(VERDICT.UNDECIDED, PRIVATE, KIND, ROLE).policyDecision === 'unverified'
    && POLICY(undefined, PRIVATE, KIND, ROLE).policyDecision === 'allow');
}

/* 本阶段没有给群聊引入 Character Integrity —— 钉住这条边界，防止将来
   "顺手"接上去而绕过 Home Node 凭据边界的既定决策。 */
{
  const ciSrc = rd('middle-brain-integrity.js');
  check('U5.groupPathStillDoesNotRunCharacterIntegrity',
    /opts\.voice === true/.test(ciSrc)
    && !/isGroup/.test(ciSrc.match(/async function middleBrainCharacterIntegrity\([\s\S]*?\n  \}/)[0]),
    'integrity layer must not gain a group branch in this phase');
  /* 群聊也不得调用 side-effect gate 的记忆类别（那会需要 verdict）。 */
  check('U6.groupPathDoesNotFakeAVerdictThroughTheSideEffectGate',
    countOcc(COM, '_mbSideEffectGate(_MB_SEC.mem)') === 2 /* 仅单聊两条路径 */
    && countOcc(COM, '_mbSideEffectsOk(_MB_SEC.mem') === 0);
}

/* ══════════════════════════════════════════════════════════════════
   8 · 硬边界未触碰（B1–B4）
   ══════════════════════════════════════════════════════════════════ */
section('8 · 硬边界');

/* 不修改 Provider Adapter：provider 面文件未被本阶段编辑。 */
check('B1.providerAdapterUntouched',
  fs.existsSync(path.join(ROOT, 'assets', 'js', 'provider-directory.js')));
/* 不新增 /mobile/v1 动词、不碰 Android、不给节点加凭据。 */
{
  const GW = rds('services/home-node/mobile-gateway.js');
  check('B2.noGroupVerbsWereAddedToTheMobileGateway',
    GW.indexOf('group') < 0 || countOcc(GW, "'group") === 0, 'gateway must stay group-free');
  const ANDROID = rds('android/app/src/main/java/com/internalbeyond/mobile/data/repository/ChatRepository.kt');
  check('B3.androidRemainsAThinClientWithoutGroupRuntime',
    ANDROID.indexOf('group') < 0 && ANDROID.indexOf('Group') < 0);
}
/* 不绕过 MiddleBrainPolicy：群聊政策经门面取用，且门面键是追加的。 */
{
  const GW = rd('middle-brain.js');
  check('B4.groupPolicyIsReachedThroughTheFacadeNotInternals',
    /'middleBrainGroupMemoryPolicy', 'integrity'/.test(GW)
    && COM.indexOf('IB.__middleBrainContracts') < 0);
  /* 不得为群聊政策新增 window 兼容别名（与 P11-1C / 2C / 2D 同一纪律）。 */
  check('B4b.noNewWindowCompatibilityAliasForGroupPolicy',
    GW.indexOf('window.middleBrainGroupMemoryPolicy') < 0);
}

/* 本文件全程零 provider 调用。 */
check('B5.zeroProviderCallsAcrossTheWholeSuite', model.calls === 0, String(model.calls));

console.log('\nP11-2F · Android/Group Runtime Integrity: ' + failures + ' failed');
process.exitCode = failures ? 1 : 0;
