'use strict';

/* Internal Beyond · P24-M3.4.1 · Participation Policy Resolver 测试
   （static 组：纯 Node、零浏览器、零网络、零存储；运行：
     node tests/test_group_participation_policy.js）

   本子阶段只交付 **pure policy resolution capability**：
     resolveParticipationPolicy(groupPolicy, userDefaults, systemDefaults)
       → { policy:{maxResponders?,recentSpeakerWindow?}, sources:{…} }
     validateParticipationPolicyFragment(fragment) → { ok, errors[] }

   authority 冻结（Phase 0）：group explicit > user default > system default，**逐字段**判定。
   allowed fields 闭集：maxResponders / recentSpeakerWindow（非负有限整数）。
   absence = 无策略（不物化默认值）；显式 0 是真值；任意非法 fragment ⇒
   PARTICIPATION_POLICY_CONTRACT（fail closed，绝不 fallback 到低优先层）。
   本阶段**不接 production**：communication.js / social.js / planner / recent helper / P23 零修改。 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));

let failures = 0;
let passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function deepFreeze(v) {
  if (v && typeof v === 'object') { Object.getOwnPropertyNames(v).forEach(k => deepFreeze(v[k])); Object.freeze(v); }
  return v;
}
function catches(fn) { try { fn(); return null; } catch (e) { return e; } }

const resolve = Core.resolveParticipationPolicy;
const validate = Core.validateParticipationPolicyFragment;
const FIELDS = ['maxResponders', 'recentSpeakerWindow'];
const EMPTY = { policy: {}, sources: {} };

/* ── P1–P2 · absence（三层都空 ⇒ 空结果，绝不物化默认值）────────────────── */
function absence() {
  ok('P1.allUndefinedYieldsEmpty', (() => {
    const r = resolve(undefined, undefined, undefined);
    return JSON.stringify(r) === JSON.stringify(EMPTY) && Object.keys(r.policy).length === 0 && Object.keys(r.sources).length === 0;
  })());
  ok('P2.allEmptyObjectsYieldEmpty', (() => {
    const r = resolve({}, {}, {});
    return JSON.stringify(r) === JSON.stringify(EMPTY)
      && r.policy.maxResponders === undefined && r.policy.recentSpeakerWindow === undefined;
  })());
  ok('P2b.absenceNeverMaterializesDefaults', (() => {
    const r = resolve(undefined, {}, undefined);
    return !('maxResponders' in r.policy) && !('recentSpeakerWindow' in r.policy)
      && !('maxResponders' in r.sources) && !('recentSpeakerWindow' in r.sources);
  })());
}

/* ── P3–P8 · 单层来源与优先级 ───────────────────────────────────────────── */
function precedence() {
  const g = resolve({ maxResponders: 2 });
  ok('P3.groupMaxRespondersWins', g.policy.maxResponders === 2 && g.sources.maxResponders === 'group'
    && Object.keys(g.policy).length === 1, g);
  const u = resolve(undefined, { maxResponders: 3 });
  ok('P4.userMaxRespondersWins', u.policy.maxResponders === 3 && u.sources.maxResponders === 'user', u);
  const s = resolve(undefined, undefined, { maxResponders: 4 });
  ok('P5.systemMaxRespondersWins', s.policy.maxResponders === 4 && s.sources.maxResponders === 'system', s);
  const gu = resolve({ maxResponders: 2 }, { maxResponders: 3 });
  ok('P6.groupBeatsUser', gu.policy.maxResponders === 2 && gu.sources.maxResponders === 'group', gu);
  const us = resolve(undefined, { maxResponders: 3 }, { maxResponders: 4 });
  ok('P7.userBeatsSystem', us.policy.maxResponders === 3 && us.sources.maxResponders === 'user', us);
  const gs = resolve({ maxResponders: 2 }, undefined, { maxResponders: 4 });
  ok('P8.groupBeatsSystem', gs.policy.maxResponders === 2 && gs.sources.maxResponders === 'group', gs);
}

/* ── P9 · per-field merge（不是整对象胜出）─────────────────────────────── */
function perFieldMerge() {
  const r = resolve({ maxResponders: 2 }, { recentSpeakerWindow: 3 }, { maxResponders: 5, recentSpeakerWindow: 1 });
  ok('P9.perFieldMergeNotWholeObject', JSON.stringify(r.policy) === JSON.stringify({ maxResponders: 2, recentSpeakerWindow: 3 })
    && r.sources.maxResponders === 'group' && r.sources.recentSpeakerWindow === 'user', r);
  ok('P9b.groupPresenceDoesNotDiscardUserFields',
    r.policy.recentSpeakerWindow === 3 && r.sources.recentSpeakerWindow === 'user');
  const r2 = resolve(undefined, { recentSpeakerWindow: 3 }, { maxResponders: 5 });
  ok('P9c.systemFillsFieldsUntouchedByHigherLayers',
    r2.policy.maxResponders === 5 && r2.sources.maxResponders === 'system'
    && r2.policy.recentSpeakerWindow === 3 && r2.sources.recentSpeakerWindow === 'user', r2);
}

/* ── P10–P11 · 显式 0（真值，禁止 `||` 回退）────────────────────────────── */
function explicitZero() {
  const r = resolve({ maxResponders: 0 }, { maxResponders: 3 }, { maxResponders: 4 });
  ok('P10.groupZeroOverridesUserAndSystem', r.policy.maxResponders === 0 && r.sources.maxResponders === 'group', r);
  const w = resolve({ recentSpeakerWindow: 0 }, { recentSpeakerWindow: 2 }, { recentSpeakerWindow: 1 });
  ok('P11.groupWindowZeroOverridesUserAndSystem', w.policy.recentSpeakerWindow === 0 && w.sources.recentSpeakerWindow === 'group', w);
  const both = resolve({ maxResponders: 0, recentSpeakerWindow: 0 }, { maxResponders: 9, recentSpeakerWindow: 9 });
  ok('P11b.zeroIsADecisionNotAbsence',
    JSON.stringify(both.policy) === JSON.stringify({ maxResponders: 0, recentSpeakerWindow: 0 }), both);
}

/* ── P12–P13 · 合法正整数 ──────────────────────────────────────────────── */
function validValues() {
  ok('P12.positiveIntegerMaxRespondersAccepted',
    [0, 1, 2, 10, 99999].every(n => {
      const r = resolve({ maxResponders: n });
      return r.policy.maxResponders === n && r.sources.maxResponders === 'group';
    }));
  ok('P13.positiveIntegerWindowAccepted',
    [0, 1, 2, 10].every(n => {
      const r = resolve({ recentSpeakerWindow: n });
      return r.policy.recentSpeakerWindow === n && r.sources.recentSpeakerWindow === 'group';
    }));
  ok('P12b.largeFiniteIntegersAreNotClamped', (() => {
    const big = Number.MAX_SAFE_INTEGER + 2;      /* 仍是非负有限整数：契约不设上限，绝不 clamp */
    const r = resolve({ maxResponders: big, recentSpeakerWindow: big });
    return r.policy.maxResponders === big && r.policy.recentSpeakerWindow === big;
  })());
  ok('P13b.acceptsNullPrototypeFragment', (() => {
    const frag = Object.assign(Object.create(null), { maxResponders: 1 });
    const r = resolve(frag);
    return r.policy.maxResponders === 1 && r.sources.maxResponders === 'group';
  })());
}

/* ── P14–P18 · 值/fragment 非法 ⇒ fail closed ──────────────────────────── */
const BAD_VALUES = [
  ['negative', -1], ['float', 1.5], ['nan', NaN], ['infinity', Infinity],
  ['numericString', '2'], ['null', null], ['true', true], ['object', {}], ['array', []],
  ['undefinedExplicit', undefined]
];
function invalidValues() {
  const maxBad = BAD_VALUES.filter(([, v]) => {
    const e = catches(() => resolve({ maxResponders: v }));
    return e && e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('bad-max-responders') >= 0;
  }).map(([label]) => label);
  ok('P14.invalidMaxRespondersFailClosed', maxBad.length === BAD_VALUES.length, maxBad);
  const winBad = BAD_VALUES.filter(([, v]) => {
    const e = catches(() => resolve({ recentSpeakerWindow: v }));
    return e && e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('bad-recent-speaker-window') >= 0;
  }).map(([label]) => label);
  ok('P15.invalidWindowFailClosed', winBad.length === BAD_VALUES.length, winBad);
  ok('P15b.noNormalizationNoClamp', (() => {
    const e1 = catches(() => resolve({ maxResponders: '2' }));
    const e2 = catches(() => resolve({ recentSpeakerWindow: 1.5 }));
    return !!e1 && !!e2 && e1.errors.indexOf('bad-max-responders') >= 0 && e2.errors.indexOf('bad-recent-speaker-window') >= 0;
  })());
  const badFragments = [['null', null], ['array', []], ['string', 'x'], ['number', 2], ['boolean', true]]
    .map(([label, frag]) => {
      const e = catches(() => resolve(frag));
      return (e && e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('bad-fragment') >= 0) ? null : label;
    }).filter(Boolean);
  ok('P16.fragmentNullInvalid', !!catches(() => resolve(null)));
  ok('P17.fragmentArrayInvalid', !!catches(() => resolve([])));
  ok('P18.fragmentPrimitivesInvalid', badFragments.length === 0, badFragments);
  ok('P18b.validatorReportsClosedResult', (() => {
    const good = validate(undefined);
    const bad = validate(null);
    return good.ok === true && Array.isArray(good.errors) && good.errors.length === 0
      && bad.ok === false && JSON.stringify(bad.errors) === JSON.stringify(['bad-fragment']);
  })());
}

/* ── P19–P23 · unknown field / 非法层不 fallback ───────────────────────── */
function unknownFieldsAndFailClosed() {
  const cases = [
    ['P19', 'Group', (frag) => resolve(frag)],
    ['P20', 'User', (frag) => resolve(undefined, frag)],
    ['P21', 'System', (frag) => resolve(undefined, undefined, frag)]
  ];
  cases.forEach(([id, label, call]) => {
    const e1 = catches(() => call({ maxResponders: 2, suppressionMode: 'hard' }));
    const e2 = catches(() => call({ mentionOverride: true }));
    const e3 = catches(() => call({ apiKey: 'sk-abcdefgh12345678' }));
    ok(id + '.unknown' + label + 'FieldFailClosed',
      !!e1 && !!e2 && !!e3
      && [e1, e2, e3].every(e => e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('unknown-field') >= 0),
      { e1: e1 && e1.errors, e2: e2 && e2.errors, e3: e3 && e3.errors });
  });
  ok('P22.invalidGroupDoesNotFallbackToUser', (() => {
    const e = catches(() => resolve({ maxResponders: -1 }, { maxResponders: 3 }, { maxResponders: 4 }));
    return !!e && e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('bad-max-responders') >= 0;
  })());
  ok('P23.invalidUserDoesNotFallbackToSystem', (() => {
    const e = catches(() => resolve({ maxResponders: 2 }, { maxResponders: -1 }, { maxResponders: 4 }));
    return !!e && e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('bad-max-responders') >= 0;
  })());
  ok('P23b.anyInvalidLayerFailsWholeResolution', (() => {
    const e = catches(() => resolve({ maxResponders: 2 }, undefined, { recentSpeakerWindow: -1 }));
    return !!e && e.errors.indexOf('bad-recent-speaker-window') >= 0;
  })());
  ok('P24.emptyGroupAllowsUser', (() => {
    const r = resolve({}, { maxResponders: 3 });
    return r.policy.maxResponders === 3 && r.sources.maxResponders === 'user';
  })());
  ok('P25.emptyGroupAndUserAllowSystem', (() => {
    const r = resolve({}, {}, { maxResponders: 4, recentSpeakerWindow: 2 });
    return r.policy.maxResponders === 4 && r.policy.recentSpeakerWindow === 2
      && r.sources.maxResponders === 'system' && r.sources.recentSpeakerWindow === 'system';
  })());
}

/* ── P26–P29 · sources 诊断 / 输出闭集 / 不泄漏 ────────────────────────── */
function sourcesAndOutput() {
  const r = resolve({ maxResponders: 2 }, { recentSpeakerWindow: 3 }, { maxResponders: 5, recentSpeakerWindow: 1 });
  ok('P26.sourcesCorrectPerField', r.sources.maxResponders === 'group' && r.sources.recentSpeakerWindow === 'user');
  const onlyMax = resolve({ maxResponders: 2 });
  ok('P27.sourcesOmittedForAbsentField',
    Object.keys(onlyMax.sources).length === 1 && !('recentSpeakerWindow' in onlyMax.sources)
    && !('recentSpeakerWindow' in onlyMax.policy), onlyMax);
  ok('P28.outputShapeClosed', (() => {
    const keys = Object.keys(r).sort().join(',');
    const policyKeys = Object.keys(r.policy).every(k => FIELDS.indexOf(k) >= 0);
    const sourceKeys = Object.keys(r.sources).every(k => FIELDS.indexOf(k) >= 0);
    const sourceValues = Object.keys(r.sources).every(k => Core.PARTICIPATION_POLICY_SOURCES.indexOf(r.sources[k]) >= 0);
    return keys === 'policy,sources' && policyKeys && sourceKeys && sourceValues;
  })(), Object.keys(r));
  ok('P28b.vocabulariesClosed',
    JSON.stringify(Core.PARTICIPATION_POLICY_ERRORS)
    === JSON.stringify(['bad-fragment', 'unknown-field', 'bad-max-responders', 'bad-recent-speaker-window'])
    && JSON.stringify(Core.PARTICIPATION_POLICY_FIELDS) === JSON.stringify(FIELDS)
    && JSON.stringify(Core.PARTICIPATION_POLICY_SOURCES) === JSON.stringify(['group', 'user', 'system']));
  ok('P29.noRawFragmentLeak', (() => {
    const json = JSON.stringify(r);
    return ['groupPolicy', 'userDefaults', 'systemDefaults', 'raw', 'reason', 'fragment', 'participants', 'messages']
      .every(t => json.indexOf(t) < 0);
  })(), JSON.stringify(r));
  ok('P29b.errorMessageDoesNotEchoFragment', (() => {
    const secret = 'sk-abcdefgh12345678';
    const e = catches(() => resolve({ [secret]: 1 }));
    return !!e && e.message.indexOf(secret) < 0 && e.code === 'PARTICIPATION_POLICY_CONTRACT';
  })());
  ok('P29c.secretShapedValuesCannotEnterPolicy', (() => {
    const e1 = catches(() => resolve({ maxResponders: 'sk-abcdefgh12345678' }));
    const e2 = catches(() => resolve({ recentSpeakerWindow: 'Bearer abc.def.ghi' }));
    return !!e1 && !!e2 && e1.errors.indexOf('bad-max-responders') >= 0 && e2.errors.indexOf('bad-recent-speaker-window') >= 0;
  })());
}

/* ── P30–P31 · immutability / determinism ─────────────────────────────── */
function purity() {
  ok('P30.deepFrozenFragmentsStillResolve', (() => {
    const g = deepFreeze({ maxResponders: 2 });
    const u = deepFreeze({ recentSpeakerWindow: 3 });
    const s = deepFreeze({ maxResponders: 5, recentSpeakerWindow: 1 });
    const snapshot = JSON.stringify([g, u, s]);
    const r = resolve(g, u, s);
    return r.policy.maxResponders === 2 && r.policy.recentSpeakerWindow === 3 && JSON.stringify([g, u, s]) === snapshot;
  })());
  ok('P30b.outputIsNewObjectNotInputReference', (() => {
    const g = { maxResponders: 2 };
    const r = resolve(g);
    return r.policy !== g && r.sources !== g && r.policy !== r.sources;
  })());
  ok('P31.sameInputHundredTimesDeepEqual', (() => {
    const g = { maxResponders: 2 }, u = { recentSpeakerWindow: 3 }, s = { maxResponders: 5, recentSpeakerWindow: 1 };
    const first = resolve(g, u, s);
    for (let i = 0; i < 100; i++) {
      try { assert.deepStrictEqual(resolve(g, u, s), first); } catch (e) { return false; }
    }
    return true;
  })());
  ok('P31b.keyOrderDeterministic', (() => {
    const a = Object.keys(resolve({ recentSpeakerWindow: 1, maxResponders: 2 }).policy).join(',');
    const b = Object.keys(resolve({ maxResponders: 2, recentSpeakerWindow: 1 }).policy).join(',');
    return a === b && a === 'maxResponders,recentSpeakerWindow';
  })());
}

/* ── P32 · 纯度（resolver 区块内无随机/时钟/网络/存储/DOM）──────────────── */
function sourcePurity() {
  const raw = read('assets/js/group-runtime-core.js');
  /* 先剥注释再按**代码标识**切块：用注释里的标题定位会把注释正文也算进来。 */
  const code = stripComments(raw);
  const start = code.indexOf('var PARTICIPATION_POLICY_FIELDS');
  const end = code.indexOf('var MENTION_PREFIXES');
  const region = code.slice(start, end);
  const forbidden = ['Math.random', 'Date.now', 'performance.now', 'crypto.randomUUID', 'fetch(',
    'dbPut', 'indexedDB', 'document', 'setTimeout', 'setInterval', 'localStorage', 'XMLHttpRequest'];
  const hits = forbidden.filter(t => region.indexOf(t) >= 0);
  ok('P32.resolverRegionHasNoImpureApis', start > 0 && end > start && region.length > 0 && hits.length === 0, hits);
  ok('P32b.resolverIsExported', typeof resolve === 'function' && typeof validate === 'function');
}

/* ── P33–P37 · 不变量：planner / helper / production / P23 零修改 ───────── */
function nonRegression() {
  ok('P33.planVersionRemainsThree',
    Core.PARTICIPATION_PLAN_VERSION === 3 && Core.PARTICIPATION_PLANNER_ID === 'group-rule-v1');
  const raw = read('assets/js/group-runtime-core.js');
  const plannerRegion = stripComments(raw.slice(raw.indexOf('function planParticipation(input)'),
    raw.indexOf('P24-M3.4.1 · Group Participation Policy Resolution')));
  ok('P34.plannerNeverCallsResolver', plannerRegion.length > 0
    && plannerRegion.indexOf('resolveParticipationPolicy') < 0
    && plannerRegion.indexOf('PARTICIPATION_POLICY_') < 0);
  ok('P34b.plannerBehaviorUnchanged', (() => {
    const base = {
      groupTurnId: 'gturn_abc123', trigger: { userMessageId: 'msg_1700000000200_u', text: 'x' },
      participants: [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }, { id: 'c', status: 'active', mentioned: true }]
    };
    const unlimited = Core.planParticipation(base);
    const capped = Core.planParticipation(Object.assign({}, base, { maxResponders: 2, recentSpeakerIds: ['a'] }));
    return unlimited.planVersion === 3 && unlimited.entries.length === 3
      && unlimited.entries.map(e => e.speakerId + '#' + e.order).join(',') === 'a#0,b#1,c#2'
      && capped.entries.length === 2 && capped.entries.map(e => e.speakerId).join(',') === 'c,b'
      && capped.omitted.length === 1 && capped.omitted[0].reason === 'budget-limit';
  })());
  ok('P35.recentHelperUnchanged', (() => {
    const hist = [
      { id: 'msg_1', role: 'assistant', senderName: 'Alpha', content: 'p1', timestamp: 1, metadata: { speakerId: 'friend_a', turnId: 'turn_aaaaaaaa' } },
      { id: 'msg_2', role: 'assistant', senderName: 'Alpha', content: 'p2', timestamp: 2, metadata: { speakerId: 'friend_a', turnId: 'turn_aaaaaaaa' } },
      { id: 'msg_3', role: 'assistant', senderName: 'Beta', content: 'b', timestamp: 3, metadata: { speakerId: 'friend_b', turnId: 'turn_bbbbbbbb' } }
    ];
    const r = Core.deriveRecentSpeakerIds(hist,
      [{ id: 'friend_a', name: 'Alpha' }, { id: 'friend_b', name: 'Beta' }], { window: 2 });
    return JSON.stringify(r.recentSpeakerIds) === JSON.stringify(['friend_b', 'friend_a']);
  })());
  const comm = read('assets/js/communication.js');
  /* P24-M3.4.3 更新：production adapter 合法接线 resolver（M3.4.2），并在 M3.4.3 起从
     **已加载的 group object** 读取 group.participationPolicy（读 seam，不再是 undefined 常量）。
     本守卫因此锁"接线唯一 + 读一次 + 无 storage/默认值"：resolver 调用 1、policy 引用 1
     （就是那一处读）、无 participationDefaults / user defaults / 第二套 store。 */
  /* 计数在**去注释**的源码上做（注释里也会提到该字段名，不算接线）。 */
  const commCode = stripComments(comm);
  ok('P36.productionWiresResolverOnceAndReadsGroupPolicyOnce', (commCode.match(/resolveParticipationPolicy\(/g) || []).length === 1
    && (commCode.match(/participationPolicy/g) || []).length === 1
    && commCode.indexOf('participationDefaults') < 0 && commCode.indexOf('PARTICIPATION_POLICY_FIELDS') < 0
    && comm.indexOf('participationPolicyStore') < 0 && comm.indexOf('participationPolicyCache') < 0, {
    resolverCalls: (commCode.match(/resolveParticipationPolicy\(/g) || []).length,
    policyRefs: (commCode.match(/participationPolicy/g) || []).length
  });
  const social = read('assets/js/social.js');
  /* P24-M3.4.3 更新：social.js 现在是**唯一** group policy storage authority（阶段边界推进）。
     守卫改为锁"写入面只在这里、且没有第二套 store/cache"；resolver 本体仍然不被 social.js 调用。 */
  ok('P36b.socialIsTheOnlyPolicyStorageAuthority',
    social.indexOf('function setGroupParticipationPolicy(') >= 0
    && social.indexOf('function clearGroupParticipationPolicy(') >= 0
    && social.indexOf('participationPolicyStore') < 0 && social.indexOf('groupPolicyDB') < 0
    && social.indexOf('resolveParticipationPolicy') < 0);
  const p23 = ['assets/js/delivery-planner.js', 'assets/js/multimodal-delivery-policy.js',
    'assets/js/delivery-sequence-core.js', 'assets/js/delivery-runtime.js', 'assets/js/voice-message-core.js'];
  const p23Hits = p23.filter(f => {
    const s = read(f);
    return s.indexOf('resolveParticipationPolicy') >= 0 || s.indexOf('participationPolicy') >= 0
      || s.indexOf('PARTICIPATION_POLICY') >= 0;
  });
  ok('P37.p23HasNoPolicyReferences', p23Hits.length === 0, p23Hits);
}

/* ── P38–P39 · prototype 处理（明示选择：只接受 Object.prototype / null）── */
function prototypeHandling() {
  ok('P38.inheritedFieldsAreNotExplicitPolicy', (() => {
    const e = catches(() => resolve(Object.create({ maxResponders: 2 })));
    return !!e && e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('bad-fragment') >= 0;
  })());
  /* 明示选择（与 core 注释一致）：own property 一律验证、一律可作显式值。
     因此 non-enumerable 的**白名单字段**会被采纳（不是被静默忽略）…… */
  ok('P38b.nonEnumerableOwnKnownFieldIsValidatedAndHonored', (() => {
    const frag = Object.create(Object.prototype);
    Object.defineProperty(frag, 'maxResponders', { value: 2, enumerable: false });
    const r = resolve(frag);
    return r.policy.maxResponders === 2 && r.sources.maxResponders === 'group';
  })());
  /* ……而 non-enumerable 的**非白名单字段**必须 fail closed（否则就是 fail-open 缺口：
     校验看不见它、取值却能命中它）。 */
  ok('P38c.nonEnumerableOwnUnknownFieldFailsClosed', (() => {
    const frag = Object.create(Object.prototype);
    Object.defineProperty(frag, 'apiKey', { value: 'sk-abcdefgh12345678', enumerable: false });
    const e = catches(() => resolve(frag));
    return !!e && e.code === 'PARTICIPATION_POLICY_CONTRACT' && e.errors.indexOf('unknown-field') >= 0;
  })());
  ok('P38d.validationAndResolutionUseSameOwnPropertySet', (() => {
    const frag = Object.create(Object.prototype);
    Object.defineProperty(frag, 'maxResponders', { value: -1, enumerable: false });
    const e = catches(() => resolve(frag));
    return !!e && e.errors.indexOf('bad-max-responders') >= 0;   /* 隐藏的非法值也绝不进入 policy */
  })());
  ok('P39.nullPrototypeFragmentAccepted', (() => {
    const r = resolve(Object.assign(Object.create(null), { recentSpeakerWindow: 2 }));
    return r.policy.recentSpeakerWindow === 2 && r.sources.recentSpeakerWindow === 'group';
  })());
}

function main() {
  console.log('== P24-M3.4.1 · Participation Policy Resolver 测试 ==');
  absence();
  precedence();
  perFieldMerge();
  explicitZero();
  validValues();
  invalidValues();
  unknownFieldsAndFailClosed();
  sourcesAndOutput();
  purity();
  sourcePurity();
  nonRegression();
  prototypeHandling();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main();
