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
  check('H4. maxLevelForAuthority：人类权威→SECRET，derived→PUBLIC（4B-1.1 起上限只由权威决定）',
    DC.maxLevelForAuthority('human_authoring') === 'SECRET' && DC.maxLevelForAuthority('human_confirmation') === 'SECRET'
    && DC.maxLevelForAuthority('derived') === 'PUBLIC'
    && DC.maxLevelForAuthority('nonsense') === 'PUBLIC');
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
  check('J9. HTML 加载**写入**路径三层，而 Role DM 全链路仍不引用（读取路径不存在）',
    (() => {
      /* ⚠ 本断言在 Phase 4B-1.2 被**有意改写**。4B-1 / 4B-1.1 冻结的是
         "没有任何生产 writer"，所以当时写的是"html 不加载 core"。
         4B-1.2 的目的恰恰是造出第一个人类显式写者，那条断言的前提因此
         已经改变。它原本想保护的性质是"Role DM 读不到"，而那一条由 J5
         （角色私信链路不含 disclosure 字样）与 J8（composeSide 无注入点）
         独立钉住，两者的代码**一个字都没改**。
         这里改成断言新状态：写入三层已加载且顺序正确，读取侧角色仍为零引用。 */
      const html = fs.readdirSync(ROOT).filter(f => /\.html$/i.test(f)).map(f => readSrc(f)).join('\n');
      const tag = (n) => '<script src="assets/js/' + n + '"></script>';
      return html.indexOf(tag('disclosure-core.js')) >= 0
        && html.indexOf(tag('disclosure-authoring-core.js')) >= 0
        && html.indexOf(tag('disclosure-store.js')) >= 0
        && html.indexOf(tag('disclosure-core.js')) < html.indexOf('<script src="assets/js/role-dm.js">')
        && [rd, rdc, socialC, social].every(s => !/IBDisclosureCore/.test(s));
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
      && !DC.isHumanAuthority(r.authority)) r.level = 'SECRET';   /* ← 变异 */
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

/* ══════════════════════════════════════════════════════════════════════════
   L / M / N — Phase 4B-1.1 · Disclosure Writer Authority
   --------------------------------------------------------------------------
   「谁有资格创建一条真正的 PERSONAL / PRIVATE / SECRET disclosure fact？」

   这一组的每一条都对应仓库里一个**真实存在**的写者（file:line 见 docs/DECISIONS.md
   D29 的审计表），不是假想调用方。L = 契约语义，M = 逐写者反例，N = 结构性与变异。
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════ L. writer authority 契约 ══════ */
group('L. writer authority（authority 是独立于 source 的第二维）');
{
  check('L1. 三个权威值是封闭枚举，畸形一律 → derived（fail closed 到"没人负责"）',
    DC.AUTHORITIES.length === 3 && DC.AUTHORITIES.join(',') === 'human_authoring,human_confirmation,derived'
    && [null, undefined, 0, 1, true, [], {}, '', 'HUMAN', 'Human_Authoring', 'human',
      'human_authoring ', ' human_authoring', 'human_authoring\u0000', 'confirmed']
      .every(v => DC.normalizeDisclosureAuthority(v) === 'derived'));
  check('L2. AUTHORITY 与 MAX_LEVEL_FOR_AUTHORITY 一一对应（无第四档、无遗漏键）',
    DC.AUTHORITIES.every(a => typeof DC.MAX_LEVEL_FOR_AUTHORITY[a] === 'string')
    && Object.keys(DC.MAX_LEVEL_FOR_AUTHORITY).length === 3);
  check('L3. isHumanAuthority：两个人类权威 true，derived / 畸形 false',
    DC.isHumanAuthority('human_authoring') && DC.isHumanAuthority('human_confirmation')
    && !DC.isHumanAuthority('derived') && !DC.isHumanAuthority(undefined) && !DC.isHumanAuthority('HUMAN'));

  /* ── 两条路都能得到人类权威，且语义可区分 ── */
  const humanAuthoring = DC.normalizeDisclosureFact({
    ownerCharacterId: 'A', level: 'SECRET', text: '她不愿告诉别人的事',
    source: 'character_authoring', authority: 'human_authoring', authoredBy: 'user'
  });
  const humanConfirm = DC.normalizeDisclosureFact({
    ownerCharacterId: 'A', level: 'SECRET', text: '模型提出的候选被确认',
    source: 'user_correction', authority: 'human_confirmation', authoredBy: 'user'
  });
  check('L4. 显式 human_authoring + 人类通道 + 实名 → 可持 SECRET',
    humanAuthoring && humanAuthoring.level === 'SECRET' && humanAuthoring.authority === 'human_authoring'
    && humanAuthoring.authoredBy === 'user', humanAuthoring);
  check('L5. human_confirmation 是**独立**的动作性质，不等于 human_authoring',
    humanConfirm && humanConfirm.level === 'SECRET' && humanConfirm.authority === 'human_confirmation');
  check('L6. 同一个人、同一段文字，authority 不同 ⇒ 引擎判定为**不同内容**（contentIdentical 对权威敏感）',
    DC.contentIdentical(humanAuthoring, humanConfirm) === false
    && DC.contentIdentical(humanAuthoring, Object.assign({}, humanAuthoring)) === true);
  check('L7. serialize 含 9 个键且 authority / authoredBy 在内（权威是存储的一部分，不是推导出来的）',
    DC.FIELD_ORDER.length === 9 && DC.FIELD_ORDER.indexOf('authority') >= 0 && DC.FIELD_ORDER.indexOf('authoredBy') >= 0
    && Object.keys(JSON.parse(DC.serialize(humanAuthoring))).join(',') === DC.FIELD_ORDER.join(','));

  /* ── 通道与权威必须互相印证（两个方向都要拒） ── */
  check('L8. 畸形/未知 authority → derived → 最高 PUBLIC（不是"不参与契约"，而是"没人负责"）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary', authority: 'trusted' }).level === 'PUBLIC'
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary', authority: 'trusted' }).authority === 'derived');
  check('L9. 非人类通道 + 显式人类权威 → 整体拒绝（跨字段组合不能造出更弱的伪造者没有的权威）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'role_dm_conversation', authority: 'human_authoring', authoredBy: 'user' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary', authority: 'human_confirmation', authoredBy: 'user' }) === null);
  check('L10. 人类通道 + derived 权威 → 整体拒绝（通道说人写的，权威说没人负责 = 自相矛盾）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'user_authoring', authority: 'derived' }) === null);
  check('L11. 人类权威不依赖 authoredBy，但**依赖通道**：非人类通道上的人类权威一律拒绝（无论有没有实名）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary', authority: 'human_authoring' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'generated_inference', authority: 'human_authoring', authoredBy: 'user' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'user_authoring', authority: 'human_authoring', authoredBy: '   ' }).level === 'SECRET');
  check('L12. authoredBy 与 owner 同规则归一：控制字符 / 空白 / 超长 → 视为无效（但**不**因此拒绝人类通道记录）',
    (function () {
      const a = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'user_authoring', authority: 'human_authoring', authoredBy: 'u\u0001ser' });
      const b = DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'user_authoring', authority: 'human_authoring', authoredBy: 'x'.repeat(500) });
      return a && a.authoredBy === '' && b && b.authoredBy === '';
    })());
  check('L13. derived 权威不得携带 authoredBy（自相矛盾，整体拒绝 —— 不静默清空字段）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', source: 'diary', authority: 'derived', authoredBy: 'user' }) === null
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: 'x', source: 'diary' }).authoredBy === '');
  check('L14. explain 对拒因如实消歧（不把"伪造权威"报成"忘了写 owner"）',
    DC.explain({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'role_dm_conversation', authority: 'human_authoring', authoredBy: 'u' }).reason === DC.REJECT.AUTHORITY_SOURCE_CONFLICT
    && DC.explain({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary', authority: 'derived', authoredBy: 'u' }).reason === DC.REJECT.DERIVED_WITH_PRINCIPAL
    && DC.explain({ level: 'SECRET', text: 'x' }).reason === DC.REJECT.MISSING_OWNER);
  check('L15. explain 报告降级是**谁的**责任（authority，不是 source）',
    DC.explain({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'role_dm_conversation' }).downgradedBy === 'authority:derived'
    && DC.explain({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'character_authoring' }).trimmed === false);

  /* ── 兼容适配器：只给 source 时逐字保留 Phase 4B-1 冻结行为 ── */
  check('L16. authorityForSource：authored 通道 → human_authoring，其余 → derived',
    DC.authorityForSource('character_authoring') === 'human_authoring'
    && DC.authorityForSource('user_authoring') === 'human_authoring'
    && DC.authorityForSource('user_correction') === 'human_authoring'
    && DC.authorityForSource('role_dm_conversation') === 'derived'
    && DC.authorityForSource('generated_inference') === 'derived'
    && DC.authorityForSource(undefined) === 'derived');
  check('L17. 只给 source（4B-1 冻结形状）仍逐字等价：authored→SECRET、其余→PUBLIC',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'user_authoring' }).level === 'SECRET'
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'generated_inference' }).level === 'PUBLIC'
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x' }).level === 'PUBLIC');
  check('L18. buildDisclosureFact 同样执行权威上限与通道一致性',
    DC.buildDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary' }).level === 'PUBLIC'
    && DC.buildDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'character_authoring' }).level === 'SECRET'
    && DC.buildDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary', authority: 'human_authoring', authoredBy: 'u' }).level === 'SECRET');
  check('L19. 归一化幂等：normalize(normalize(x)) 与 normalize(x) 逐字节相同（authority 维度参与）',
    (function () {
      const cases = [
        { ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'character_authoring' },
        { ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'diary' },
        { ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'user_authoring', authority: 'human_confirmation', authoredBy: 'u' },
        { ownerCharacterId: 'A', level: 'PERSONAL', text: 'x' }
      ];
      return cases.every(c => {
        const a = DC.normalizeDisclosureFact(c);
        const b = DC.normalizeDisclosureFact(a);
        return a && b && DC.serialize(a) === DC.serialize(b) && b.authoredBy === a.authoredBy;
      });
    })());
  check('L20. 授权仍未实现：authority 只是数据，不存在任何"据此放行"的函数',
    typeof DC.authorize !== 'function' && typeof DC.filter !== 'function'
    && typeof DC.canDisclose !== 'function' && typeof DC.isAuthorized !== 'function'
    && typeof DC.allowedFacts !== 'function' && typeof DC.grantFromAuthority !== 'function');
}

/* ══════ M. 逐写者反例（每个真实 writer 一条）══════ */
group('M. 逐 writer 反例（仓库里真实存在的产生路径，file:line 见 D29）');
{
  /* M-A role-dm.js:1364 emitMemories —— 角色在私聊里的自我陈述。 */
  check('M-A. Role DM 自主对话文本（source=role_dm_conversation）不可能变 SECRET/PRIVATE',
    ['SECRET', 'PRIVATE', 'PERSONAL'].every(l =>
      DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: l, text: '我可能其实很怕打雷', source: 'role_dm_conversation' }).level === 'PUBLIC'));
  /* M-B active-diary.js:831 日记/consolidation 产物。 */
  check('M-B. diary 与 consolidation 产物同样被限在 PUBLIC',
    ['diary', 'consolidation'].every(s =>
      DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: s }).level === 'PUBLIC'));
  /* M-C memory.js:1494–1538 模型抽取候选（模型自己在 JSON 里选 visibility）。 */
  check('M-C. memory_extraction（模型抽取）不可能自行升级',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'memory_extraction' }).level === 'PUBLIC');
  /* M-D moment.js / role-letters.js:236 主动写动态 / 主动写信。 */
  check('M-D. 主动生成的动态与信件（无 disclosure 通道）→ unknown → PUBLIC',
    ['unknown', 'moment', 'role_letter', 'blog', 'letter'].every(s =>
      DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: s }).level === 'PUBLIC'));
  /* M-E Role DM 自动 intent（role-dm-social.js）不产生任何角色事实。 */
  check('M-E. 自动 social intent 不是 self-fact：它没有等级可给（source 不识别 → derived）',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'role_dm_autonomous_intent' }).authority === 'derived');
}

/* ══════ N. 结构与变异（本轮的鉴别力证明）══════ */
group('N. 结构性 + mutation sensitivity（4B-1.1）');
{
  check('N1. 核心仍未读 trust / relationship / 任何 Memory store（authority 不是从这些推出来的）',
    (function () {
      const d = readSrc('assets/js/disclosure-core.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return !/\btrust\b/.test(d) && !/relationship/i.test(d) && !/\bmemories\b/.test(d) && !/createdBy/.test(d);
    })());
  check('N2. 核心仍无任何 IO / 定时器（本轮没有新增写者）',
    (function () {
      const d = readSrc('assets/js/disclosure-core.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return !/\bfetch\s*\(/.test(d) && !/indexedDB/i.test(d) && !/localStorage/.test(d) && !/setTimeout|setInterval/.test(d);
    })());
  check('N3. 引用 IBDisclosureCore 的文件**恰好**是白名单四个，且模型侧消费链一个都没有',
    (function () {
      /* ⚠ 本断言被**有意改写两次**，两次方向都是加强：
         ① 4B-1.2：原话是"没有生产 writer 接入：只有 core 自己提到
            IBDisclosureCore" —— 那在造出第一个显式写者之后不再成立。
         ② 4B-2A：`disclosure-authorization-core.js`（纯函数授权判定核）也
            引用 core（要它的形状与封闭枚举）。它**不读盘、不进 prompt**，
            因此把它加进白名单不是放宽 —— 白名单仍然是**封闭**的，
            多一个文件就红，所以"顺手接个消费者"依然会被拦住；
            而反向断言（模型上下文链零引用）一个字没动。 */
      const WRITERS = ['disclosure-core.js', 'disclosure-authoring-core.js',
        'disclosure-store.js', 'disclosure-authorization-core.js'];
      const files = fs.readdirSync(path.join(ROOT, 'assets', 'js')).filter(f => /\.js$/.test(f));
      const refs = files.filter(f => readSrc(path.join('assets', 'js', f)).indexOf('IBDisclosureCore') >= 0);
      const consumers = ['memory.js', 'active-diary.js', 'moments.js', 'communication.js', 'role-letters.js',
        'role-dm.js', 'role-dm-core.js', 'role-dm-social.js', 'role-dm-social-core.js', 'role-dm-ui.js',
        'middle-brain.js', 'agent-runtime.js', 'understanding-authority.js'];
      /* 4B-2A：授权核必须**自己也没有消费者** —— 它引用 core 是为了形状与
         封闭枚举，但任何模型侧文件都不得引用它。这一条与上面那条合起来
         才能钉住"授权存在、消费不存在"。 */
      const noConsumersOfAuthz = consumers.every(f =>
        readSrc(path.join('assets', 'js', f)).indexOf('IBDisclosureAuthorizationCore') < 0);
      return refs.length === WRITERS.length && refs.every(f => WRITERS.indexOf(f) >= 0)
        && consumers.every(f => readSrc(path.join('assets', 'js', f)).indexOf('IBDisclosureCore') < 0)
        && noConsumersOfAuthz;
    })());
  check('N4. 加载顺序：disclosure-core → authoring-core → store → authorization-core',
    (function () {
      /* ⚠ 本断言同样被有意改写：它此前是"HTML 仍未加载 disclosure-core.js"。
         现在要保护的是**顺序** —— authoring-core 的 UMD 工厂期就执行
         `factory(root.IBDisclosureCore)`，authorization-core 也是；
         store 则是在调用时才解析。顺序错了在浏览器里就是静默 undefined
         （本仓库反复记录过的坑），所以这条必须由 HTML 的真实顺序来钉。
         4B-2A 追加的是最后一个位置：授权核在 store 之后、role-dm 之前 ——
         位置本身就是"它在两侧之间但不属于任何一侧"的书面记录。 */
      /* 按**完整 script 标签**定位，不按裸文件名：HTML 里的说明注释也会提到
         这些文件名，裸匹配会让"注释在标签之前"被误读成"标签在标签之前"。
         这条断言本身就被这个坑绊过一次。 */
      const html = fs.readdirSync(ROOT).filter(f => /\.html$/i.test(f)).map(f => readSrc(f)).join('\n');
      const tag = (n) => '<script src="assets/js/' + n + '"></script>';
      const i0 = html.indexOf(tag('disclosure-core.js'));
      const i1 = html.indexOf(tag('disclosure-authoring-core.js'));
      const i2 = html.indexOf(tag('disclosure-store.js'));
      const i3 = html.indexOf(tag('disclosure-authorization-core.js'));
      const i4 = html.indexOf('<script src="assets/js/role-dm-core.js"></script>');
      return i0 > 0 && i0 < i1 && i1 < i2 && i2 < i3 && i3 < i4;
    })());

  /* ── MUT-A：authority 上限变异 —— derived 也能 SECRET ── */
  const MUT_A_DERIVED_SECRET = (input) => {
    const r = DC.normalizeDisclosureFact(input);
    if (r && r.authority === 'derived' && DC.normalizeDisclosureLevel(input.level) === 'SECRET') r.level = 'SECRET';
    return r;
  };
  check('MUT-A. 变异「derived 允许 SECRET」被 L1/L8/M-A 的断言捕获',
    MUT_A_DERIVED_SECRET({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'role_dm_conversation' }).level === 'SECRET'
    && DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'role_dm_conversation' }).level === 'PUBLIC');

  /* ── MUT-B：把 Memory ACL 映射成披露等级 —— 必须红 ── */
  const MUT_B_ACL_TO_LEVEL = (mem) => {
    const level = mem && mem.visibility === 'private' ? 'SECRET'      /* ← 变异：ACL → 等级 */
      : (mem && mem.visibility === 'only' ? 'PRIVATE' : 'PUBLIC');
    return DC.normalizeDisclosureFact({
      ownerCharacterId: mem && mem.ownerCharacterId, level: level, text: mem && mem.text,
      source: 'memory_extraction', authority: 'derived'
    });
  };
  check('MUT-B. 变异「visibility:private → SECRET」被契约捕获：映射出来的 SECRET 仍被降为 PUBLIC',
    MUT_B_ACL_TO_LEVEL({ visibility: 'private', ownerCharacterId: 'A', text: 'x' }).level === 'PUBLIC'
    && DC.explain({ ownerCharacterId: 'A', level: 'SECRET', text: 'x', source: 'memory_extraction' }).level === 'PUBLIC');
  check('MUT-B2. 无任何自动映射：visibility 不是本契约的输入，等级也不由它决定',
    (() => {
      const base = { ownerCharacterId: 'A', text: 'x', source: 'memory_extraction' };
      const a = DC.normalizeDisclosureFact(Object.assign({}, base, { level: 'PUBLIC', visibility: 'private' }));
      const b = DC.normalizeDisclosureFact(Object.assign({}, base, { level: 'PUBLIC', visibility: 'public' }));
      return a.level === b.level && a.authority === b.authority && !Object.prototype.hasOwnProperty.call(a, 'visibility');
    })());

  /* ── MUT-C：createdBy → ownerCharacterId 回退 —— 必须红 ── */
  const MUT_C_CREATEDBY_OWNER = (input) => {
    const c = Object.assign({}, input);
    if (!c.ownerCharacterId && c.createdBy) c.ownerCharacterId = c.createdBy;   /* ← 变异 */
    return DC.normalizeDisclosureFact(c);
  };
  check('MUT-C. 变异「createdBy 冒充 owner」被 B3/C 的断言捕获',
    MUT_C_CREATEDBY_OWNER({ createdBy: 'A', level: 'PRIVATE', text: 'x', source: 'user_authoring' }) !== null
    && DC.normalizeDisclosureFact({ createdBy: 'A', level: 'PRIVATE', text: 'x', source: 'user_authoring' }) === null);
  check('MUT-C2. 同样地，visibleTo / subjectCharacterId / nickname 都不能冒充 owner',
    ['visibleTo', 'subjectCharacterId', 'nickname'].every(k => {
      const o = { level: 'PRIVATE', text: 'x', source: 'user_authoring' };
      o[k] = 'A';
      return DC.normalizeDisclosureFact(o) === null;
    }));

  /* ── MUT-D：candidate 未确认却成为 canonical PRIVATE —— 必须红 ── */
  const MUT_D_UNCONFIRMED_CANDIDATE = (candidate) => {
    /* 变异：跳过"人类确认"这一步，直接把模型 candidate 当 canonical。
       注意它**仍然**经过门槛；被捕获的原因不是忘了校验，而是权威维度错了。 */
    return DC.normalizeDisclosureFact({
      ownerCharacterId: candidate.ownerCharacterId, level: 'PRIVATE',
      text: candidate.text, source: 'generated_inference',
      authority: 'human_authoring', authoredBy: 'user'                 /* ← 变异：伪造人类权威 */
    });
  };
  check('MUT-D. 变异「未确认的 candidate → canonical PRIVATE」被通道校验捕获',
    MUT_D_UNCONFIRMED_CANDIDATE({ ownerCharacterId: 'A', text: '模型猜的' }) === null);
  check('MUT-D1b. 同一变异若同时伪造通道，仍需第三个字段才成立 —— 三个维度都得对上',
    DC.normalizeDisclosureFact({
      ownerCharacterId: 'A', level: 'PRIVATE', text: '模型猜的',
      source: 'generated_inference', authority: 'human_confirmation', authoredBy: 'user'
    }) === null
    && DC.normalizeDisclosureFact({
      ownerCharacterId: 'A', level: 'PRIVATE', text: '模型猜的',
      source: 'user_authoring', authority: 'human_confirmation', authoredBy: 'user'
    }) !== null);
  check('MUT-D2. 确认之后才合法：同一段文字 + 人类通道 + 实名 ⇒ PRIVATE 成立',
    DC.normalizeDisclosureFact({ ownerCharacterId: 'A', level: 'PRIVATE', text: '模型猜的', source: 'user_authoring', authority: 'human_confirmation', authoredBy: 'user' }).level === 'PRIVATE');

  /* ── MUT-E：把 owner 从 writer context 换成"当前位置" ── */
  const MUT_E_LAST_SPEAKER_OWNER = (input, lastSpeakerId) => {
    const c = Object.assign({}, input);
    if (!c.ownerCharacterId) c.ownerCharacterId = lastSpeakerId;   /* ← 变异：用当前说话人兜底 */
    return DC.normalizeDisclosureFact(c);
  };
  check('MUT-E. 变异「owner 回落到当前说话人」被 L/E 的"UNKNOWN OWNER → REJECT"捕获',
    MUT_E_LAST_SPEAKER_OWNER({ level: 'SECRET', text: 'x', source: 'character_authoring' }, 'B') !== null
    && DC.normalizeDisclosureFact({ level: 'SECRET', text: 'x', source: 'character_authoring' }) === null);
}

console.log('\n' + (failed === 0 ? 'ALL GREEN' : 'FAILURES') + ' — passed=' + passed + ' failed=' + failed);
process.exitCode = failed === 0 ? 0 : 1;
