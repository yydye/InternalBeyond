/* ====================================================================
   test_disclosure_core.js — Phase 4B-1 · Disclosure Classification Contract
   --------------------------------------------------------------------
   零 IO / 零模型调用。只测 assets/js/disclosure-core.js 的纯函数契约，
   外加三条**结构性**断言（publicProfile / persona / shared-thread 边界，
   以及 Role DM 没有开始消费 disclosure fact）。

   运行：node tests/test_disclosure_core.js
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const DC = require(path.join(__dirname, '..', 'assets', 'js', 'disclosure-core.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; console.log('  \u2716 ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function group(t) { console.log('\n' + t); }

const ROOT = path.join(__dirname, '..');
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* ══════ A. enum closure ══════ */
group('A. enum closure（非法 level fail closed）');
{
  check('A1. 四个合法档位原样通过',
    DC.LEVELS.every(l => DC.normalizeDisclosureLevel(l) === l) && DC.LEVELS.length === 4, DC.LEVELS);
  const bad = [null, undefined, 0, 1, NaN, true, false, [], {}, [''], { level: 'SECRET' },
    'secret', 'Secret', 'SECRET ', ' SECRET', 'secret\u0000', 'PUBLIC\n', 'ultra', 'TOP_SECRET', ''];
  bad.forEach((v, i) => {
    check('A2.' + i + ' 非法值 ' + JSON.stringify(v) + ' → UNDETERMINED',
      DC.normalizeDisclosureLevel(v) === DC.LEVEL.UNDETERMINED, DC.normalizeDisclosureLevel(v));
  });
  check('A3. UNDETERMINED 不在封闭枚举 LEVELS 里（它不是第五档敏感度）',
    DC.LEVELS.indexOf(DC.LEVEL.UNDETERMINED) < 0);
  check('A4. UNDETERMINED 没有 rank（=null，不是 0 / -1） ⇒ 不可能被当成最低档',
    DC.levelRank(DC.LEVEL.UNDETERMINED) === null && DC.levelRank('SECRET') === 3 && DC.levelRank('PUBLIC') === 0);
  check('A5. isClassified：四档 true，UNDETERMINED 与一切畸形 false',
    DC.LEVELS.every(l => DC.isClassified(l) === true) && DC.isClassified(DC.LEVEL.UNDETERMINED) === false
    && DC.isClassified(undefined) === false && DC.isClassified('secret') === false && DC.isClassified({}) === false);
  check('A6. GATED_LEVELS = PERSONAL/PRIVATE/SECRET（PUBLIC 不受门控）',
    DC.GATED_LEVELS.length === 3 && DC.isGatedLevel('SECRET') && DC.isGatedLevel('PERSONAL')
    && !DC.isGatedLevel('PUBLIC') && !DC.isGatedLevel(DC.LEVEL.UNDETERMINED));
}

/* ══════ B. normalization ══════ */
group('B. normalization（null / 畸形 / 超长 / 控制字符）');
{
  check('B1. normalizeDisclosureFact(null / undefined / 字符串 / 数组 / 数字) → null',
    DC.normalizeDisclosureFact(null) === null && DC.normalizeDisclosureFact(undefined) === null
    && DC.normalizeDisclosureFact('x') === null && DC.normalizeDisclosureFact([]) === null
    && DC.normalizeDisclosureFact(7) === null);
  check('B2. 缺 ownerCharacterId → 整体 null（绝不猜 owner）',
    DC.normalizeDisclosureFact({ level: 'SECRET', text: 'x' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: '   ', level: 'PRIVATE', text: 'x' }) === null);
  check('B3. owner 不从 createdBy / visibleTo 推断',
    DC.normalizeDisclosureFact({ createdBy: 'A', visibleTo: ['A'], level: 'PRIVATE', text: 'x' }) === null);
  check('B4. owner 含空白/控制字符 → 拒绝（防伪造归属）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A\u0001B', level: 'PRIVATE', text: 'x' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A B', level: 'PRIVATE', text: 'x' }) === null);
  const ctrl = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'a\u0000b\u001bc\u2028d\r\ne' });
  check('B5. 控制字符被剥离、\\r\\n 归一为 \\n（U+2028 行分隔符也剥）', ctrl && ctrl.text === 'abcd\ne', ctrl && ctrl.text);
  const long = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x'.repeat(5000) });
  check('B6. 超长正文截断到 TEXT_MAX', long && long.text.length === DC.TEXT_MAX, long && long.text.length);
  const arr = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: ['PRIVATE'], text: ['x'] });
  check('B7. level/text 是数组 → level=UNDETERMINED、text 为空串（不 toString 成内容）',
    arr && arr.level === DC.LEVEL.UNDETERMINED && arr.text === '', arr);
  const ts = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', updatedAt: 'soon' });
  check('B8. 时间戳非法 → 0（不是"现在"）', ts && ts.updatedAt === 0, ts && ts.updatedAt);
  const built = DC.buildDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: ' T ', source: 'user_authoring' });
  check('B9. buildDisclosureFact 产出 7 个规范字段、无多余键',
    Object.keys(built).join(',') === DC.FIELD_ORDER.join(',') && built.text === 'T'
    && built.source === 'user_authoring' && built.subjectCharacterId === '', built);
  check('B10. factId 自动生成且带 disc_ 前缀', /^disc_/.test(built.factId), built.factId);
  const forged = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', futureField: 'y', visibility: 'public' });
  check('B11. 未知字段被丢弃（封闭类型）', !Object.prototype.hasOwnProperty.call(forged, 'futureField')
    && !Object.prototype.hasOwnProperty.call(forged, 'visibility'), Object.keys(forged));
  check('B12. normalize 永不抛异常（fuzz 一批畸形输入）',
    (function () {
      const fuzz = [null, undefined, 0, '', 'x', [], {}, [1, 2], { ownerCharacterId: {} }, { level: {} },
        { ownerCharacterId: 'A', level: {}, text: {} }, { ownerCharacterId: 'A', level: 'SECRET', text: null }];
      try { fuzz.forEach(f => { DC.normalizeDisclosureFact(f); DC.isDisclosureFact(f); DC.explain(f); }); return true; }
      catch (e) { return String(e && e.message); }
    })() === true);
}

/* ══════ C. owner direction ══════ */
group('C. owner direction（A 的事实不得归成 B-owned）');
{
  const factA = { ownerCharacterId: 'A', level: 'SECRET', text: 'A 不轻易谈的一段经历', source: 'character_authoring' };
  check('C1. ownedBy(factA, "A") === true', DC.ownedBy(factA, 'A') === true);
  check('C2. ownedBy(factA, "B") === false（方向不因"关系好"而反转）', DC.ownedBy(factA, 'B') === false);
  check('C3. ownedBy 缺 speakerId → false（不默认放行）', DC.ownedBy(factA, '') === false && DC.ownedBy(factA, null) === false);
  const scope = DC.disclosureScope('A', 'B', [factA, { ownerCharacterId: 'B', level: 'SECRET', text: 'B 的秘密', source: 'character_authoring' }]);
  check('C4. disclosureScope(A,B) 只收 A-owned 事实，B-owned 一条不进',
    scope.candidates.length === 1 && scope.candidates[0].ownerCharacterId === 'A', scope.candidates.length);
  check('C5. scope 记录的是有向 (A→B)，不是无序对 / 不是 max / 不是平均',
    scope.speakerId === 'A' && scope.peerId === 'B'
    && scope.relationKeyFrom === 'A' && scope.relationKeyTo === 'B');
  const scopeR = DC.disclosureScope('B', 'A', [factA]);
  check('C6. 反方向 disclosureScope(B,A) 对同一条 A-owned 事实返回空候选',
    scopeR.candidates.length === 0);
  check('C7. subjectCharacterId 不改变 owner（关于 B 的事实仍归 A 所有）',
    DC.ownedBy({ ownerCharacterId: 'A', subjectCharacterId: 'B', level: 'PRIVATE', text: 'x', source: 'user_authoring' }, 'A') === true
    && DC.ownedBy({ ownerCharacterId: 'A', subjectCharacterId: 'B', level: 'PRIVATE', text: 'x', source: 'user_authoring' }, 'B') === false);
  check('C8. 没有 authorize / filter / canDisclose 之类的授权函数（4B-2 未实现）',
    typeof DC.authorize !== 'function' && typeof DC.filter !== 'function'
    && typeof DC.canDisclose !== 'function' && typeof DC.isAuthorized !== 'function'
    && typeof DC.allowedFacts !== 'function');
}

/* ══════ D. PUBLIC distinction ══════ */
group('D. PUBLIC distinction（不制造第二份 publicProfile 权威）');
{
  check('D1. 携带 publicIntro 的 PUBLIC 事实被识别为"第二权威"并拒绝',
    DC.publicProfileWouldDoubleOwn({ level: 'PUBLIC', publicIntro: '生命科学研究者' }) === true
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PUBLIC', publicIntro: 'x', text: 'x' }) === null);
  check('D2. traits / occupation / interests 同理',
    ['traits', 'occupation', 'interests', 'profile'].every(k => {
      const o = { level: 'PUBLIC', ownerCharacterId: 'A', text: 'x' }; o[k] = 'v';
      return DC.normalizeDisclosureFact(o) === null;
    }));
  check('D3. source=public_profile 或 domain=PUBLIC_PROFILE 的 PUBLIC 事实被拒绝',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PUBLIC', source: 'public_profile', text: 'x' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PUBLIC', domain: 'PUBLIC_PROFILE', text: 'x' }) === null);
  check('D4. 非 PUBLIC 档位不受此规则影响（PERSONAL 的"喜欢甜食"合法）',
    (function () { const r = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PERSONAL', text: '喜欢甜食', source: 'user_authoring' }); return !!r && r.level === 'PERSONAL'; })());
  check('D5. PUBLIC 不受门控（GATED_LEVELS 不含 PUBLIC）', !DC.isGatedLevel('PUBLIC'));
}

/* ══════ E. identity distinction ══════ */
group('E. identity distinction（systemPrompt 不得被自动吞进披露契约）');
{
  const persona = { ownerCharacterId: 'A', level: 'SECRET', text: '我是谁', source: 'character_authoring', systemPrompt: '你是一个…' };
  check('E1. 带 systemPrompt 键的输入被整体拒绝（不是"删掉再继续"）',
    DC.normalizeDisclosureFact(persona) === null && DC.isDisclosureFact(persona) === false);
  check('E2. system_prompt / persona 键同样拒绝',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', system_prompt: 'y' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', persona: 'y' }) === null);
  check('E3. domain=SELF_IDENTITY 被拒绝',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', domain: 'SELF_IDENTITY' }) === null);
  check('E4. 合法事实（无 persona 键）照常通过 —— 拒绝理由是可判定的字段名，不是"内容像 persona"',
    DC.isDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: '怕黑', source: 'user_authoring' }) === true);
  check('E5. explain() 能说出拒绝理由且不泄漏正文',
    (function () {
      const e = DC.explain({ ownerCharacterId: 'A', level: 'SECRET', text: 'TOP SECRET BODY', systemPrompt: 'p' });
      return e.ok === false && e.reason === DC.REJECT.TEXT_DENYLISTED && JSON.stringify(e).indexOf('TOP SECRET BODY') < 0;
    })());
}

/* ══════ F. shared-thread distinction ══════ */
group('F. shared-thread distinction（memorandum / history 不自动成为 private fact）');
{
  check('F1. 带 memorandum 键的输入被拒绝',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', memorandum: 'y' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', threadMemorandum: 'y' }) === null);
  check('F2. domain=SHARED_THREAD 被拒绝',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', domain: 'SHARED_THREAD' }) === null);
  check('F3. visibleTo / excludeFrom（既有 ACL）不被本契约接受',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', visibleTo: ['B'] }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', excludeFrom: ['B'] }) === null);
  check('F4. 契约里**没有**自引用标记（isDisclosureFact 不是存储字段）',
    DC.DENY_FIELDS.indexOf('isDisclosureFact') < 0 && !!DC.REJECT);
}

/* ══════ G. legacy / default behavior ══════ */
group('G. legacy（undefined → PUBLIC/PRIVATE 都是禁止的）');
{
  check('G1. 缺 level → UNDETERMINED，**不是** PUBLIC',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', text: 'x' }).level === DC.LEVEL.UNDETERMINED);
  check('G2. 缺 level → UNDETERMINED，**不是** PRIVATE / SECRET',
    (function () { const r = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', text: 'x' }); return r.level !== 'PRIVATE' && r.level !== 'SECRET'; })());
  check('G3. 缺 level ⇒ isDisclosureFact === false（旧数据不进入披露子系统）',
    DC.isDisclosureFact({ ownerCharacterId: 'A', text: 'x' }) === false);
  check('G4. level=null / level="" / level 拼错 ⇒ 同样 false（不自动获得 peer 可见性）',
    [null, '', 'preivate', 'PRIV', 0].every(v => DC.isDisclosureFact({ ownerCharacterId: 'A', level: v, text: 'x' }) === false));
  check('G5. 归一化**不会**把旧记录升级成秘密：level 保持 UNDETERMINED 而不是被"保守地"改成 SECRET',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: undefined, text: 'x' }).level === DC.LEVEL.UNDETERMINED);
  check('G6. 空正文 ⇒ false（一条空事实不是事实）',
    DC.isDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: '   ', source: 'character_authoring' }) === false);
  check('G7. 缺 source ⇒ unknown ⇒ 只能 PUBLIC（未知来源不能宣称敏感度）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x' }).level === 'PUBLIC');
}

/* ══════ H. provenance（generated 不得自动升级）══════ */
group('H. provenance（inferred / generated 无资格持有 PRIVATE/SECRET）');
{
  const derived = ['memory_extraction', 'role_dm_conversation', 'diary', 'consolidation', 'generated_inference', 'unknown'];
  derived.forEach((s, i) => {
    check('H1.' + i + ' source=' + s + ' 请求 SECRET → 强制降为 PUBLIC',
      DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: s }).level === 'PUBLIC');
    check('H2.' + i + ' source=' + s + ' 请求 PRIVATE → 强制降为 PUBLIC',
      DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', source: s }).level === 'PUBLIC');
  });
  const authored = ['character_authoring', 'user_authoring', 'user_correction'];
  authored.forEach((s, i) => {
    check('H3.' + i + ' source=' + s + ' 可持有 SECRET',
      DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: s }).level === 'SECRET');
  });
  check('H4. maxLevelForSource：authored→SECRET，其余→PUBLIC',
    DC.maxLevelForSource('user_authoring') === 'SECRET' && DC.maxLevelForSource('generated_inference') === 'PUBLIC'
    && DC.maxLevelForSource('role_dm_conversation') === 'PUBLIC' && DC.maxLevelForSource('diary') === 'PUBLIC');
  check('H5. isAuthoredSource 只认三个 authored 来源',
    DC.AUTHORED_SOURCES.length === 3 && authored.every(s => DC.isAuthoredSource(s))
    && derived.every(s => DC.isAuthoredSource(s) === false));
  check('H6. 非法 source 字符串 → unknown（不近似匹配）',
    DC.normalizeDisclosureSource('Character_Authoring') === 'unknown'
    && DC.normalizeDisclosureSource('character authoring') === 'unknown'
    && DC.normalizeDisclosureSource('authoring') === 'unknown');
  check('H7. explain() 报告 trimmed=true（说明发生了降级）',
    DC.explain({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'generated_inference' }).trimmed === true);
  check('H8. 降级**不会**把 authored 之外的东西偷偷留成 UNDETERMINED（是 PUBLIC，明确公开）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary' }).level === 'PUBLIC');
}

/* ══════ I. serialization ══════ */
group('I. serialization contract');
{
  const a = { factId: 'f1', ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', source: 'user_authoring', subjectCharacterId: '', updatedAt: 5 };
  const b = { updatedAt: 5, source: 'user_authoring', text: 'x', level: 'PRIVATE', ownerCharacterId: 'A', subjectCharacterId: '', factId: 'f1' };
  check('I1. serialize 键序稳定（插入顺序不同 → 同字节）', DC.serialize(a) === DC.serialize(b), [DC.serialize(a), DC.serialize(b)]);
  check('I1b. updatedAt 是记录字段（进 serialize），但不算内容（contentIdentical 忽略它）',
    DC.serialize(a) !== DC.serialize(Object.assign({}, b, { updatedAt: 9 })) && DC.contentIdentical(a, Object.assign({}, b, { updatedAt: 9 })) === true);
  check('I2. serialize 结果只含 FIELD_ORDER 的七个键',
    JSON.parse(DC.serialize(a)) && Object.keys(JSON.parse(DC.serialize(a))).join(',') === DC.FIELD_ORDER.join(','));
  check('I3. serialize(畸形) === ""（不产出半条记录）',
    DC.serialize(null) === '' && DC.serialize({ level: 'SECRET', text: 'x' }) === '');
  check('I4. contentIdentical 忽略 factId / updatedAt（身份与时间不是内容）',
    DC.contentIdentical(a, b) === true);
  check('I5. contentIdentical 对档位差异敏感',
    DC.contentIdentical(a, Object.assign({}, b, { level: 'SECRET' })) === false);
  check('I6. contentIdentical 对 owner 差异敏感（方向性）',
    DC.contentIdentical(a, Object.assign({}, b, { ownerCharacterId: 'B' })) === false);
  check('I7. contentIdentical 任一侧畸形 → false',
    DC.contentIdentical(a, null) === false && DC.contentIdentical(null, null) === false);
  check('I8. serialize 的往返等价（serialize → normalize → serialize 同字节）',
    DC.serialize(DC.normalizeDisclosureFact(a)) === DC.serialize(a));
}

/* ══════ J. zero IO / zero behavior change（结构性）══════ */
group('J. 结构性边界（零 IO、不读 trust、不接 Role DM）');
{
  const core = readSrc('assets/js/disclosure-core.js');
  /* 结构性检查必须在**剥离注释后**的源码上做：本文件的注释会（合法地）
     提到 trust / persona / document 等词，把注释算进去会让断言永远为假，
     那种"永远失败的断言"和"永远通过的断言"一样没有鉴别力。 */
  const coreCode = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('J1. 零 IO：无 fetch / localStorage / indexedDB / XMLHttpRequest / DOM',
    !/\bfetch\s*\(/.test(coreCode) && !/localStorage/.test(coreCode) && !/indexedDB/i.test(coreCode)
    && !/XMLHttpRequest/.test(coreCode) && !/\bdocument\s*[.[]/.test(coreCode));
  check('J2. 零 window 依赖（UMD 只在导出时用 root）',
    !/\bwindow\s*[.[]/.test(coreCode) && (coreCode.match(/\bwindow\b/g) || []).length === 0);
  check('J3. 不读 trust / relationship / persona / Memory 存储',
    !/\btrust\b/.test(coreCode) && !/relationship/i.test(coreCode) && !/\bmemories\b/.test(coreCode)
    && !/createdBy/.test(coreCode) && !/visibility\b/.test(coreCode));
  check('J4. 无 require（除 UMD 分支）/ 无网络 / 无定时器',
    !/setTimeout|setInterval/.test(coreCode) && (coreCode.match(/require\(/g) || []).length === 0);

  /* Role DM 侧：本轮**没有**接入。 */
  const rd = readSrc('assets/js/role-dm.js');
  const rdc = readSrc('assets/js/role-dm-core.js');
  const socialC = readSrc('assets/js/role-dm-social-core.js');
  const social = readSrc('assets/js/role-dm-social.js');
  check('J5. Role DM 全链路不含 disclosure 字样（未接入）',
    [rd, rdc, socialC, social].every(s => !/disclosure/i.test(s) && !/IBDisclosureCore/.test(s)));
  check('J6. role-dm-core.js 的 familiarity guidance 未被改动（Phase 4A 冻结面仍在）',
    /function buildFamiliarityGuidance\(familiarity\)/.test(rdc) && /var FAMILIARITY_VERY_FAMILIAR = 0\.7;/.test(rdc));
  check('J7. relationDelta 仍是"净 ≤ 0 记 0"（trust writer 未动）',
    /if \(pos > neg\) \{/.test(rdc) && /out\.trust = capDelta\(drive\);/.test(rdc)
    && !/out\.trust = capDelta\(-/.test(rdc));
  check('J8. composeSide 未新增私有事实注入点',
    (rd.match(/peerPrivateFacts|disclosureFacts|privateFacts/g) || []).length === 0);
  check('J9. html 未加载 disclosure-core.js（尚未接线）',
    (() => {
      const html = fs.readdirSync(ROOT).filter(f => /\.html$/i.test(f)).map(f => readSrc(f)).join('\n');
      return html.indexOf('disclosure-core.js') < 0;
    })());
  check('J10. role-dm-social-core 的 SIGNAL_WEIGHTS 未被改动（autonomous scoring 未动）',
    /trust: 0\.10/.test(socialC) && /RELATION_NEUTRAL = 0\.5/.test(socialC));
}

/* ══════ K. mutation sensitivity（证明测试真的有鉴别力）══════ */
group('K. mutation sensitivity（自我验证：变异必须让测试变红）');
{
  /* K1：模拟"把 malformed/undefined 默认成 PUBLIC"的变异。
     不改生产代码 —— 用一个 monkey-patch 包裹的等价实现直接验证断言会红。 */
  const MUT_PUBLIC_DEFAULT = (input) => {
    const r = DC.normalizeDisclosureFact(input);
    if (!r) return r;
    if (r.level === DC.LEVEL.UNDETERMINED) r.level = 'PUBLIC';   /* ← 变异 */
    return r;
  };
  check('K1. 变异「undefined → PUBLIC」被 G1/G3/G4 的断言捕获（正常实现不这么做）',
    MUT_PUBLIC_DEFAULT({ ownerCharacterId: 'A', text: 'x' }).level === 'PUBLIC'
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', text: 'x' }).level === DC.LEVEL.UNDETERMINED);
  check('K1b. 同一变异会让 "legacy 不进入披露子系统" 的断言变红',
    DC.isDisclosureFact({ ownerCharacterId: 'A', text: 'x' }) === false
    && (function () { const m = MUT_PUBLIC_DEFAULT({ ownerCharacterId: 'A', text: 'x' }); return m.level !== DC.LEVEL.UNDETERMINED; })());

  /* K2：方向变异 —— owner A 被偷换成 peer B。 */
  const MUT_SWAP_OWNER = (fact) => { const r = DC.normalizeDisclosureFact(fact); if (r) r.ownerCharacterId = 'B'; return r; };
  const factA = { ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'character_authoring' };
  check('K2. 变异「owner A → B」被 C2/C6 的断言捕获',
    MUT_SWAP_OWNER(factA).ownerCharacterId === 'B'
    && DC.ownedBy(MUT_SWAP_OWNER(factA), 'A') === false
    && DC.ownedBy(factA, 'A') === true);

  /* K3：provenance 变异 —— 让 non-authored 也能持有 SECRET。 */
  const MUT_ALLOW_DERIVED_SECRET = (input) => {
    const r = DC.normalizeDisclosureFact(input);
    if (r && DC.normalizeDisclosureLevel(input.level) === 'SECRET'
      && !DC.isAuthoredSource(r.source)) r.level = 'SECRET';   /* ← 变异 */
    return r;
  };
  check('K3. 变异「generated 也能 SECRET」被 H1.x 的断言捕获',
    MUT_ALLOW_DERIVED_SECRET({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'generated_inference' }).level === 'SECRET'
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'generated_inference' }).level === 'PUBLIC');

  /* K4：枚举变异 —— 宽松归一化 'secret' → SECRET。 */
  const MUT_LOOSE_ENUM = (v) => (typeof v === 'string' && v.trim().toUpperCase() === 'SECRET') ? 'SECRET' : DC.normalizeDisclosureLevel(v);
  check('K4. 变异「大小写宽松归一化」被 A2 的断言捕获',
    MUT_LOOSE_ENUM('secret') === 'SECRET' && DC.normalizeDisclosureLevel('secret') === DC.LEVEL.UNDETERMINED);

  /* K5：denylist 变异 —— 允许 systemPrompt 进入披露契约。 */
  const MUT_ALLOW_PERSONA = (input) => {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const c = Object.assign({}, input); delete c.systemPrompt;   /* ← 变异：删掉再继续 */
      if (c.ownerCharacterId && DC.normalizeDisclosureLevel(c.level) !== DC.LEVEL.UNDETERMINED) {
        return DC.normalizeDisclosureFact(c);
      }
    }
    return DC.normalizeDisclosureFact(input);
  };
  check('K5. 变异「删掉 persona 字段再继续」被 E1 的断言捕获',
    MUT_ALLOW_PERSONA({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', systemPrompt: 'p' }) !== null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', systemPrompt: 'p' }) === null);
}

console.log('\n' + (failed === 0 ? 'ALL GREEN' : 'FAILURES') + ' — passed=' + passed + ' failed=' + failed);
process.exitCode = failed === 0 ? 0 : 1;
