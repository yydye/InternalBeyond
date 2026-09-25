'use strict';

/* Internal Beyond · P24-M3.5.2A · Dynamic Runtime State Foundation 测试
   （static + browser：纯 runtime-state 契约 R1–R28 / 集成 I1–I25 / STATIC-vs-FOUNDATION 差分；
     运行：node tests/test_group_dynamic_runtime.js）

   本阶段只建立 foundation：runtime-only 准入队列 + hard gates + 记账，**无** SILENT / DEFER /
   INTERJECT，**零**额外模型调用；feature 默认关闭 ⇒ 与既有 static runtime 逐字等价。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const A_ID = 'friend_m352_a';
const B_ID = 'friend_m352_b';
const C_ID = 'friend_m352_c';

let failures = 0;
let passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait 200ms */ }
  }
  return false;
}

const GT = 'gturn_abc123';
const E = (id, order) => ({ speakerId: id, order: order, reason: 'active-default' });
const mkState = (entries, cap, status) => Core.createDynamicRuntimeState({ groupTurnId: GT, entries: entries, responderCap: cap, statusById: status || {} });
const snapOf = st => Core.dynamicRuntimeSnapshot(st);
const ctxOf = o => Object.assign({ cancelled: false }, o || {});

/* ── 源码守卫（§57）────────────────────────────────────────────────────── */
function sourceGuards() {
  const comm = read('assets/js/communication.js');
  const code = comm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const core = read('assets/js/group-runtime-core.js');
  const count = (s, t) => s.split(t).length - 1;
  ok('SG1.plannerStillCalledOncePerTurn', count(code, 'planParticipation(_gPlanInput)') === 1);
  ok('SG2.dynamicRuntimeNeverCallsPlanner', (() => {
    const c = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = c.indexOf('function validateDynamicRuntimeInput');
    const j = c.indexOf('return {', i);
    return c.slice(i, j).indexOf('planParticipation') < 0;
  })());
  ok('SG3.p23ZeroDynamicRefs',
    ['delivery-planner', 'multimodal-delivery-policy', 'delivery-sequence-core', 'delivery-runtime', 'voice-message-core']
      .every(f => {
        const s = read('assets/js/' + f + '.js');
        return s.indexOf('DynamicRuntime') < 0 && s.indexOf('dynamicParticipation') < 0;
      }));
  ok('SG4.memoryAndMbZeroDynamicRefs',
    ['assets/js/memory.js', 'assets/js/middle-brain.js']
      .every(f => read(f).indexOf('DynamicRuntime') < 0 && read(f).indexOf('dynamicParticipation') < 0));
  ok('SG5.noGroupBrainImplementation', comm.indexOf('GroupBrain') < 0 && comm.indexOf('groupBrain') < 0
    && core.indexOf('GroupBrain') < 0 && core.indexOf('groupBrain') < 0);
  /* P24-M3.5.2B 更新：SILENT 已实现（词表闭集只有 speak/silent）；DEFER 与 INTERJECT 仍然
     既不进词表也没有任何行为入口（只作为 unsupported decision 被识别并 fallback SPEAK）。 */
  ok('SG6.noDeferInterjectImplementation',
    /* P24-M3.5.2C 更新：DEFER 已实现（词表含 defer）；这里只锁"INTERJECT / resume 仍不存在"。 */
    code.indexOf('interjectEntry') < 0 && code.indexOf('resumeEntry') < 0
    && core.indexOf('DYNAMIC_RUNTIME_DECISIONS.INTERJECT') < 0
    && code.indexOf('runtime-interject') < 0);
  ok('SG7.noTargetingOrRecentMutationInRuntime', (() => {
    const c = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = c.indexOf('function validateDynamicRuntimeInput');
    const j = c.indexOf('return {', i);
    const region = c.slice(i, j);
    return region.indexOf('targetSpeakerIds') < 0 && region.indexOf('recentSpeakerIds') < 0
      && region.indexOf('deriveRecentSpeakerIds') < 0;
  })());
  ok('SG8.policyStillTwoFields',
    /GROUP_POLICY_FIELDS=\['maxResponders','recentSpeakerWindow'\]/.test(read('assets/js/social.js'))
    && /PARTICIPATION_POLICY_FIELDS = Object\.freeze\(\['maxResponders', 'recentSpeakerWindow'\]\)/.test(core));
  ok('SG9.noNewStoreOrQueuePersistence',
    /DB_VER=24/.test(read('assets/js/core.js')) && code.indexOf('dynamicParticipation') < 0
    && code.indexOf('sessionStorage') < 0 && comm.indexOf('queueStore') < 0);
  ok('SG10.noDynamicCanonicalMetadata', count(code, 'extraMetadata:{groupTurnId') === 1
    && code.indexOf('dynamicRuntime') < 0 && code.indexOf('admissionIndex') < 0
    && count(code, 'targetSpeakerIds:') === 1);
  ok('SG11.zeroExtraModelCallsInDynamicLayer', (() => {
    const c = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = c.indexOf('function validateDynamicRuntimeInput');
    const j = c.indexOf('return {', i);
    return c.slice(i, j).indexOf('callApi') < 0;
  })());
  ok('SG12.featureGateDefaultsOff', /IB_DYNAMIC_PARTICIPATION_DEFAULT=false/.test(comm)
    && /_ibDynamicParticipationOn\(\)/.test(code));
  /* P24-M3.5.2C · DEFER source guards（§Source Guards of the stage prompt） */
  ok('SG13.deferHasNoPersistenceOrMetadata', core.indexOf('deferredSpeakerIds') >= 0
    && code.indexOf('deferredSpeakerIds') < 0
    && core.indexOf('deferredSpeakerIds:JSON') < 0
    && code.indexOf('defer:true') < 0);
  ok('SG14.deferNeverTouchesP23OrMbOrBrain',
    /* 用**具体符号**而不是裸词 'defer'：P23 自带 image-deferred / IMAGE_DEFERRED 词表（无关）。 */
    ['delivery-planner', 'multimodal-delivery-policy', 'delivery-sequence-core', 'delivery-runtime', 'voice-message-core']
      .every(f => {
        const s = read('assets/js/' + f + '.js');
        return s.indexOf('deferDynamicRuntimeEntry') < 0 && s.indexOf('deferredSpeakerIds') < 0
          && s.indexOf('DYNAMIC_RUNTIME_DECISIONS') < 0;
      })
    && read('assets/js/memory.js').indexOf('deferDynamicRuntimeEntry') < 0
    && read('assets/js/middle-brain.js').indexOf('deferDynamicRuntimeEntry') < 0
    && comm.indexOf('GroupBrain') < 0 && core.indexOf('GroupBrain') < 0);
  ok('SG15.noInterjectImplementationYet', (() => {
    const coreCode = core.replace(/\/\*[\s\S]*?\*\//g, '');   /* 注释里出现 INTERJECT 属文档，不算实现 */
    return coreCode.indexOf('interjectEntry') < 0 && code.indexOf('interjectEntry') < 0
      && coreCode.indexOf('INTERJECT') < 0 && coreCode.indexOf('DYNAMIC_RUNTIME_DECISIONS.INTERJECT') < 0;
  })());
}

/* ── R1–R28 · 纯 runtime-state 契约 ────────────────────────────────────── */
function pureContract() {
  const V = input => Core.validateDynamicRuntimeInput(input);
  ok('R1.createFromEmptyEntries', (() => {
    const s = snapOf(mkState([]));
    return s.groupTurnId === GT && s.pendingEntries.length === 0 && s.enabled === true;
  })());
  ok('R2.createFromThreeSpeakers', snapOf(mkState([E(A_ID, 0), E(B_ID, 1), E(C_ID, 2)])).pendingEntries.length === 3);
  ok('R3.preservesPlannerEntryOrder', (() => {
    const s = snapOf(mkState([E(C_ID, 2), E(A_ID, 0), E(B_ID, 1)]));
    return s.pendingEntries.map(x => x.speakerId).join(',') === [C_ID, A_ID, B_ID].join(',');
  })());
  ok('R4.preservesGroupOrderHoles', snapOf(mkState([E(A_ID, 0), E(C_ID, 2)])).pendingEntries.map(x => x.order).join(',') === '0,2');
  ok('R5.duplicateSpeakerFailsClosed', V({ groupTurnId: GT, entries: [E(A_ID, 0), E(A_ID, 1)] }).errors.indexOf('duplicate-speaker') >= 0);
  ok('R6.duplicateOrderFailsClosed', V({ groupTurnId: GT, entries: [E(A_ID, 0), E(B_ID, 0)] }).errors.indexOf('duplicate-order') >= 0);
  ok('R7.badSpeakerIdFailsClosed', V({ groupTurnId: GT, entries: [{ speakerId: '', order: 0 }] }).errors.indexOf('bad-speaker-id') >= 0
    && V({ groupTurnId: GT, entries: [{ speakerId: 'sk-abcdefgh12345678', order: 0 }] }).errors.indexOf('bad-speaker-id') >= 0);
  ok('R8.badOrderFailsClosed', V({ groupTurnId: GT, entries: [{ speakerId: A_ID, order: -1 }] }).errors.indexOf('bad-order') >= 0
    && V({ groupTurnId: GT, entries: [{ speakerId: A_ID, order: 1.5 }] }).errors.indexOf('bad-order') >= 0);
  ok('R9.badCapFailsClosed', V({ groupTurnId: GT, entries: [E(A_ID, 0)], responderCap: -1 }).errors.indexOf('bad-cap') >= 0
    && V({ groupTurnId: GT, entries: [E(A_ID, 0)], responderCap: 1.5 }).errors.indexOf('bad-cap') >= 0);
  ok('R9b.badGroupTurnIdFailsClosed', V({ groupTurnId: 'nope', entries: [E(A_ID, 0)] }).errors.indexOf('bad-group-turn-id') >= 0);
  ok('R10.absentCapIsUnlimited', snapOf(mkState([E(A_ID, 0)])).responderCap === null
    && snapOf(mkState([E(A_ID, 0)], null)).responderCap === null
    && snapOf(mkState([E(A_ID, 0)], undefined)).responderCap === null);
  ok('R11.capZeroBlocksStart', (() => {
    const n = Core.nextDynamicRuntimeEntry(mkState([E(A_ID, 0)], 0), ctxOf());
    return n.done === true && n.reason === 'cap-reached';
  })());
  ok('R12.capTwoAllowsTwoThenBlocks', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1), E(C_ID, 2)], 2);
    const n1 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n1.entry, ctxOf());
    Core.markDynamicRuntimeCompleted(s, A_ID);
    const n2 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n2.entry, ctxOf());
    Core.markDynamicRuntimeCompleted(s, B_ID);
    const n3 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n1.entry.speakerId === A_ID && n2.entry.speakerId === B_ID && n3.done === true && n3.reason === 'cap-reached';
  })());
  ok('R13.oneMemberTurnPerSpeaker', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1)]);
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    const again = Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    return again.ok === false && again.reason === 'already-started';
  })());
  ok('R14.initialPendingIsExactPlan', (() => {
    const s = snapOf(mkState([E(A_ID, 0), E(B_ID, 1), E(C_ID, 2)]));
    return JSON.stringify(s.pendingEntries.map(x => x.speakerId + '#' + x.order))
      === JSON.stringify([A_ID + '#0', B_ID + '#1', C_ID + '#2']);
  })());
  ok('R15.startA', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1)]);
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n.done === false && n.entry.speakerId === A_ID && n.entry.order === 0
      && snapOf(s).pendingEntries.length === 1;
  })());
  ok('R16.cannotStartATwice', (() => {
    const s = mkState([E(A_ID, 0)]);
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    const again = Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    return again.ok === false;
  })());
  ok('R17.completeA', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1)]);
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    const done = Core.markDynamicRuntimeCompleted(s, A_ID);
    const snap = snapOf(s);
    return done.ok === true && snap.startedSpeakerIds.join(',') === A_ID && snap.completedSpeakerIds.join(',') === A_ID;
  })());
  ok('R18.failA', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1)]);
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    const failed = Core.markDynamicRuntimeFailed(s, A_ID);
    const snap = snapOf(s);
    return failed.ok === true && snap.failedSpeakerIds.join(',') === A_ID && snap.completedSpeakerIds.length === 0;
  })());
  ok('R19.failedSpeakerCannotBeReAdmitted', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1)]);
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    Core.markDynamicRuntimeFailed(s, A_ID);
    return Core.markDynamicRuntimeStarted(s, E(A_ID, 0), ctxOf()).ok === false;
  })());
  ok('R20.nextIsB', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1), E(C_ID, 2)]);
    const n1 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n1.entry, ctxOf());
    Core.markDynamicRuntimeCompleted(s, A_ID);
    const n2 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n2.entry.speakerId === B_ID && n2.entry.order === 1;
  })());
  ok('R21.cancelBlocksNext', (() => {
    const s = mkState([E(A_ID, 0), E(B_ID, 1)]);
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf({ cancelled: true }));
    return n.done === true && n.reason === 'cancelled' && snapOf(s).pendingEntries.length === 2;
  })());
  ok('R22.removedBlocksStart', (() => {
    const s = mkState([E(B_ID, 0)], undefined, { [B_ID]: 'removed' });
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n.done === true && n.reason === 'removed';
  })());
  ok('R23.mutedPlannedEntryStillAllowed', (() => {
    const s = mkState([E(B_ID, 0)], undefined, { [B_ID]: 'muted' });
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n.done === false && n.entry.speakerId === B_ID;
  })());
  ok('R23b.unknownEntryBlocked', Core.nextDynamicRuntimeEntry(mkState([E(A_ID, 0)]), ctxOf()) &&
    Core.canStartDynamicRuntimeEntry(mkState([E(A_ID, 0)]), E(B_ID, 5), ctxOf()).reason === 'unknown-entry');
  ok('R24.targetingNotInRuntimeState', (() => {
    const s = snapOf(mkState([E(A_ID, 0)]));
    return !('targetSpeakerIds' in s) && JSON.stringify(s).indexOf('targetSpeakerIds') < 0;
  })());
  ok('R25.recentNotInRuntimeState', (() => {
    const s = snapOf(mkState([E(A_ID, 0)]));
    return !('recentSpeakerIds' in s) && JSON.stringify(s).indexOf('recentSpeakerIds') < 0;
  })());
  ok('R26.deterministic', (() => {
    const first = JSON.stringify(snapOf(mkState([E(A_ID, 0), E(B_ID, 1)], 1)));
    for (let i = 0; i < 100; i++) {
      if (JSON.stringify(snapOf(mkState([E(A_ID, 0), E(B_ID, 1)], 1))) !== first) return false;
    }
    return true;
  })());
  ok('R27.inputNotMutated', (() => {
    const entries = [E(A_ID, 0), E(B_ID, 1)];
    const status = { a: 'active' };
    const before = JSON.stringify([entries, status]);
    const s = mkState(entries, 1, status);
    Core.nextDynamicRuntimeEntry(s, ctxOf());
    return JSON.stringify([entries, status]) === before;
  })());
  ok('R28.noDomStorageNetworkTimeRandom', (() => {
    const src = read('assets/js/group-runtime-core.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = code.indexOf('function validateDynamicRuntimeInput');
    const j = code.indexOf('return {', i);
    const region = code.slice(i, j);
    return i > 0 && j > i
      && ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'document', 'fetch(', 'Date.now', 'Math.random', 'setTimeout', 'callApi']
        .every(t => region.indexOf(t) < 0);
  })());
  ok('R28b.errorVocabularyClosed',
    JSON.stringify(Core.DYNAMIC_RUNTIME_ERRORS)
    === JSON.stringify(['bad-group-turn-id', 'bad-entries', 'bad-speaker-id', 'bad-order', 'duplicate-speaker', 'duplicate-order', 'bad-cap'])
    && JSON.stringify(Core.DYNAMIC_GATE_REASONS)
    /* P24-M3.5.2B 更新：silent 是终态 ⇒ 新增 'already-silent' gate reason（词表仍闭集）。 */
    === JSON.stringify(['queue-empty', 'cancelled', 'unknown-entry', 'already-started', 'already-silent', 'removed', 'cap-reached']));
  ok('R28c.createFailsClosedOnCorruptPlan', (() => {
    try { Core.createDynamicRuntimeState({ groupTurnId: GT, entries: [E(A_ID, 0), E(A_ID, 1)] }); return false; }
    catch (e) { return e.code === 'DYNAMIC_RUNTIME_CONTRACT' && e.errors.indexOf('duplicate-speaker') >= 0; }
  })());
}

/* ── S1–S25 · Runtime SILENT 纯契约（P24-M3.5.2B）──────────────────────── */
function silentContract() {
  const mk = (cap, status) => Core.createDynamicRuntimeState({
    groupTurnId: GT, entries: [E(A_ID, 0), E(B_ID, 1), E(C_ID, 2)],
    responderCap: cap, statusById: status || {}
  });
  const dec = fn => ({ decider: fn });
  /* P24-M3.5.2C 更新：词表扩展为 speak / silent / defer（仍闭集；INTERJECT 仍未加入）。 */
  ok('S1.decisionVocabularyIsSpeakSilentDefer',
    JSON.stringify(Core.DYNAMIC_RUNTIME_DECISIONS) === JSON.stringify({ SPEAK: 'speak', SILENT: 'silent', DEFER: 'defer' })
    && JSON.stringify(Core.DYNAMIC_DECISION_SOURCES) === JSON.stringify(['default', 'injected', 'fallback'])
    && JSON.stringify(Core.DYNAMIC_DECISION_DIAGNOSTICS)
    === JSON.stringify(['decider-threw', 'malformed-result', 'unknown-decision', 'unsupported-decision', 'defer-limit']));
  ok('S2.defaultDecisionIsSpeak', (() => {
    const r = Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), {});
    return r.decision === 'speak' && r.source === 'default';
  })());
  ok('S3.explicitSpeak', Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(() => ({ decision: 'speak' }))).decision === 'speak');
  ok('S4.explicitSilent', Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(() => ({ decision: 'silent' }))).decision === 'silent');
  ok('S5.malformedNullFallsBackToSpeak', (() => {
    const r = Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(() => null));
    return r.decision === 'speak' && r.source === 'fallback' && r.diagnostic === 'malformed-result';
  })());
  ok('S6.unknownDecisionFallsBackToSpeak', (() => {
    const r = Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(() => ({ decision: 'banana' })));
    return r.decision === 'speak' && r.diagnostic === 'unknown-decision';
  })());
  ok('S7.deciderThrowFallsBackToSpeak', (() => {
    const r = Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(() => { throw new Error('boom'); }));
    return r.decision === 'speak' && r.diagnostic === 'decider-threw';
  })());
  /* P24-M3.5.2C 更新：defer 已支持（不再 fallback）；'interject' 仍 unsupported。 */
  ok('S8.deferNowSupported', Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(() => ({ decision: 'defer' }))).decision === 'defer');
  ok('S8b.interjectShapedFallsBackToSpeak',
    Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(() => ({ decision: 'interject' }))).diagnostic === 'unsupported-decision');
  ok('S9.markSilent', (() => {
    const s = mk();
    return Core.markDynamicRuntimeSilent(s, B_ID).ok === true && snapOf(s).silentSpeakerIds.join(',') === B_ID;
  })());
  ok('S10.silentIsNotStarted', (() => {
    const s = mk();
    Core.markDynamicRuntimeSilent(s, B_ID);
    return snapOf(s).startedSpeakerIds.length === 0;
  })());
  ok('S11.silentIsNotCompleted', (() => {
    const s = mk();
    Core.markDynamicRuntimeSilent(s, B_ID);
    return snapOf(s).completedSpeakerIds.length === 0;
  })());
  ok('S12.silentIsNotFailed', (() => {
    const s = mk();
    Core.markDynamicRuntimeSilent(s, B_ID);
    return snapOf(s).failedSpeakerIds.length === 0;
  })());
  ok('S13.silentIsTerminalForQueue', (() => {
    const s = mk();
    const n1 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeSilent(s, n1.entry.speakerId);
    const n2 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n1.entry.speakerId === A_ID && n2.entry.speakerId === B_ID;
  })());
  ok('S14.silentCannotStartLater',
    (() => { const s = mk(); Core.markDynamicRuntimeSilent(s, B_ID); return Core.canStartDynamicRuntimeEntry(s, E(B_ID, 1), ctxOf()).reason; })() === 'already-silent');
  ok('S15.silentCannotBeMarkedTwice', (() => {
    const s = mk();
    Core.markDynamicRuntimeSilent(s, B_ID);
    const again = Core.markDynamicRuntimeSilent(s, B_ID);
    return again.ok === false && again.reason === 'already-silent';
  })());
  ok('S15b.silentCannotBeMarkedAfterStart', (() => {
    const s = mk();
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    return Core.markDynamicRuntimeSilent(s, A_ID).ok === false;
  })());
  ok('S16.snapshotExposesSilent', (() => {
    const s = mk();
    Core.markDynamicRuntimeSilent(s, C_ID);
    return JSON.stringify(snapOf(s).silentSpeakerIds) === JSON.stringify([C_ID]);
  })());
  ok('S17.decisionIsDeterministic', (() => {
    const fn = c => ({ decision: c.speakerId === B_ID ? 'silent' : 'speak' });
    const first = JSON.stringify(Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(fn)));
    for (let i = 0; i < 100; i++) {
      if (JSON.stringify(Core.resolveDynamicRuntimeDecision(mk(), E(B_ID, 1), dec(fn))) !== first) return false;
    }
    return true;
  })());
  ok('S18.decisionCannotMutateState', (() => {
    const s = mk();
    const before = JSON.stringify(snapOf(s));
    Core.resolveDynamicRuntimeDecision(s, E(B_ID, 1), dec(ctx => {
      ctx.completedSpeakerIds.push('hack');
      ctx.silentSpeakerIds.push('hack');
      return { decision: 'silent' };
    }));
    return JSON.stringify(snapOf(s)) === before;
  })());
  ok('S19.removedHardGateBeforeDecision', (() => {
    let calls = 0;
    const s = Core.createDynamicRuntimeState({ groupTurnId: GT, entries: [E(B_ID, 0)], statusById: { [B_ID]: 'removed' } });
    const r = Core.nextDynamicRuntimeEntry(s, { cancelled: false, decider: () => { calls++; return { decision: 'silent' }; } });
    return r.done === true && r.reason === 'removed' && calls === 0;
  })());
  ok('S20.cancelHardGateBeforeDecision', (() => {
    let calls = 0;
    const r = Core.nextDynamicRuntimeEntry(mk(), { cancelled: true, decider: () => { calls++; return { decision: 'silent' }; } });
    return r.done === true && r.reason === 'cancelled' && calls === 0;
  })());
  ok('S21.capHardGateBeforeDecision', (() => {
    let calls = 0;
    const s = Core.createDynamicRuntimeState({ groupTurnId: GT, entries: [E(B_ID, 0)], responderCap: 0 });
    const r = Core.nextDynamicRuntimeEntry(s, { cancelled: false, decider: () => { calls++; return { decision: 'silent' }; } });
    return r.done === true && r.reason === 'cap-reached' && calls === 0;
  })());
  ok('S22.mutedAdmittedReachesDecision', (() => {
    const s = Core.createDynamicRuntimeState({ groupTurnId: GT, entries: [E(B_ID, 0)], statusById: { [B_ID]: 'muted' } });
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    const d = Core.resolveDynamicRuntimeDecision(s, n.entry, dec(() => ({ decision: 'silent' })));
    return n.done === false && d.decision === 'silent';
  })());
  ok('S23.targetingAbsentFromState', JSON.stringify(snapOf(mk())).indexOf('targetSpeakerIds') < 0);
  ok('S24.recentAbsentFromState', JSON.stringify(snapOf(mk())).indexOf('recentSpeakerIds') < 0);
  ok('S25.decisionRegionHasNoImpureApis', (() => {
    const src = read('assets/js/group-runtime-core.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = code.indexOf('function resolveDynamicRuntimeDecision');
    const j = code.indexOf('function markDynamicRuntimeSilent');
    const region = code.slice(i, j);
    return i > 0 && j > i
      && ['dbPut', 'dbGet', 'indexedDB', 'localStorage', 'document', 'fetch(', 'Date.now', 'Math.random', 'setTimeout', 'callApi']
        .every(t => region.indexOf(t) < 0);
  })());
}

/* ── S26–S46 · Runtime DEFER 纯契约（P24-M3.5.2C）──────────────────────── */
function deferContract() {
  const mk = (cap, status) => Core.createDynamicRuntimeState({
    groupTurnId: GT, entries: [E(A_ID, 0), E(B_ID, 1), E(C_ID, 2)],
    responderCap: cap, statusById: status || {}
  });
  const dec = fn => ({ decider: fn });
  const deferA = () => { const s = mk(); const n = Core.nextDynamicRuntimeEntry(s, ctxOf()); Core.deferDynamicRuntimeEntry(s, n.entry); return s; };
  ok('S26.decisionVocabularyIncludesDefer',
    JSON.stringify(Core.DYNAMIC_RUNTIME_DECISIONS) === JSON.stringify({ SPEAK: 'speak', SILENT: 'silent', DEFER: 'defer' })
    && Core.DYNAMIC_DECISION_DIAGNOSTICS.indexOf('defer-limit') >= 0
    && JSON.stringify(Core.DYNAMIC_DEFER_ERRORS)
    === JSON.stringify(['unknown-entry', 'already-started', 'already-silent', 'already-deferred', 'not-in-queue']));
  ok('S27.deferOnlyAcceptedStrictly', (() => {
    const s = mk();
    const okExact = Core.resolveDynamicRuntimeDecision(s, E(A_ID, 0), dec(() => ({ decision: 'defer' }))).decision === 'defer';
    const badPad = Core.resolveDynamicRuntimeDecision(s, E(A_ID, 0), dec(() => ({ decision: ' defer ' })));
    const badNum = Core.resolveDynamicRuntimeDecision(s, E(A_ID, 0), dec(() => ({ decision: 1 })));
    return okExact && badPad.decision === 'speak' && badPad.diagnostic === 'unknown-decision'
      && badNum.decision === 'speak' && badNum.diagnostic === 'unknown-decision';
  })());
  ok('S28.deferTransition', (() => {
    const s = mk();
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    const r = Core.deferDynamicRuntimeEntry(s, n.entry);
    return r.ok === true && JSON.stringify(snapOf(s).deferredSpeakerIds) === JSON.stringify([A_ID]);
  })());
  ok('S29.queueMovesToTail', JSON.stringify(snapOf(deferA()).pendingEntries.map(e => e.speakerId + '#' + e.order))
    === JSON.stringify([B_ID + '#1', C_ID + '#2', A_ID + '#0']));
  ok('S30.deferAddsNoStarted', snapOf(deferA()).startedSpeakerIds.length === 0);
  ok('S31.deferAddsNoCompleted', snapOf(deferA()).completedSpeakerIds.length === 0
    && snapOf(deferA()).failedSpeakerIds.length === 0);
  ok('S32.deferAddsNoSilent', snapOf(deferA()).silentSpeakerIds.length === 0);
  ok('S33.deferKeepsOrderOnLaterSpeak', (() => {
    const s = deferA();
    const seq = [];
    for (;;) {
      const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
      if (n.done) break;
      seq.push(n.entry.speakerId + '#' + n.entry.order);
      Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
      Core.markDynamicRuntimeCompleted(s, n.entry.speakerId);
    }
    return JSON.stringify(seq) === JSON.stringify([B_ID + '#1', C_ID + '#2', A_ID + '#0']);
  })());
  ok('S34.deferOnceOnlyFallsBackToSpeak', (() => {
    const s = deferA();
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());   /* B */
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    const n2 = Core.nextDynamicRuntimeEntry(s, ctxOf());  /* C */
    Core.markDynamicRuntimeStarted(s, n2.entry, ctxOf());
    const n3 = Core.nextDynamicRuntimeEntry(s, ctxOf());  /* A again */
    const d = Core.resolveDynamicRuntimeDecision(s, n3.entry, dec(() => ({ decision: 'defer' })));
    return n3.entry.speakerId === A_ID && d.decision === 'speak' && d.diagnostic === 'defer-limit'
      && Core.deferDynamicRuntimeEntry(s, n3.entry).reason === 'already-deferred';
  })());
  ok('S35.deferPlusSilentSequence', (() => {
    const s = mk();
    const n1 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.deferDynamicRuntimeEntry(s, n1.entry);
    const n2 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeSilent(s, n2.entry.speakerId);
    const n3 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    const n4 = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n2.entry.speakerId === B_ID && n3.entry.speakerId === C_ID && n4.entry.speakerId === A_ID
      && // 说明：A 的 SPEAK 尚未执行
      snapOf(s).silentSpeakerIds.join(',') === B_ID;
  })());
  ok('S36.deferPlusFailure', (() => {
    const s = deferA();
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.markDynamicRuntimeStarted(s, n.entry, ctxOf());
    Core.markDynamicRuntimeFailed(s, n.entry.speakerId);
    const snap = snapOf(s);
    return snap.failedSpeakerIds.join(',') === B_ID && snap.deferredSpeakerIds.join(',') === A_ID;
  })());
  ok('S37.deferThenCancelStopsQueue', (() => {
    const s = deferA();
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf({ cancelled: true }));
    /* defer 把 A 追加回队尾 ⇒ 队列仍是 3 项（B,C,A）；cancel 后不再被取出（length 不变）。 */
    return n.done === true && n.reason === 'cancelled' && snapOf(s).pendingEntries.length === 3;
  })());
  ok('S38.removedNeverReachesDeferDecision', (() => {
    let calls = 0;
    const s = Core.createDynamicRuntimeState({ groupTurnId: GT, entries: [E(B_ID, 0)], statusById: { [B_ID]: 'removed' } });
    const r = Core.nextDynamicRuntimeEntry(s, { cancelled: false, decider: () => { calls++; return { decision: 'defer' }; } });
    return r.done === true && r.reason === 'removed' && calls === 0;
  })());
  ok('S39.capNotRefilledByDefer', (() => {
    const s = Core.createDynamicRuntimeState({ groupTurnId: GT, entries: [E(A_ID, 0), E(B_ID, 1)], responderCap: 2, statusById: {} });
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    Core.deferDynamicRuntimeEntry(s, n.entry);
    const seq = [];
    for (;;) { const x = Core.nextDynamicRuntimeEntry(s, ctxOf()); if (x.done) break; seq.push(x.entry.speakerId); Core.markDynamicRuntimeStarted(s, x.entry, ctxOf()); }
    return JSON.stringify(seq) === JSON.stringify([B_ID, A_ID]) && JSON.stringify(snapOf(s).deferredSpeakerIds) === JSON.stringify([A_ID]);
  })());
  ok('S40.targetedSpeakerMayDefer', (() => {
    const s = mk();
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    const d = Core.resolveDynamicRuntimeDecision(s, n.entry, dec(() => ({ decision: 'defer' })));
    return d.decision === 'defer' && Core.deferDynamicRuntimeEntry(s, n.entry).ok === true;
  })());
  ok('S41.mutedTargetedMayDefer', (() => {
    const s = Core.createDynamicRuntimeState({ groupTurnId: GT, entries: [E(B_ID, 0)], statusById: { [B_ID]: 'muted' } });
    const n = Core.nextDynamicRuntimeEntry(s, ctxOf());
    return n.done === false && Core.deferDynamicRuntimeEntry(s, n.entry).ok === true;
  })());
  ok('S42.deferIsDeterministic', (() => {
    const first = JSON.stringify(snapOf(deferA()));
    for (let i = 0; i < 100; i++) if (JSON.stringify(snapOf(deferA())) !== first) return false;
    return true;
  })());
  ok('S43.deferNeverPersisted', (() => {
    const coreSrc = read('assets/js/group-runtime-core.js');
    const coreCode = coreSrc.replace(/\/\*[\s\S]*?\*\//g, '');   /* 注释里提到 localStorage 不算引用 */
    const commSrc = read('assets/js/communication.js');
    return coreSrc.indexOf('deferredSpeakerIds') >= 0
      && commSrc.indexOf('deferredSpeakerIds') < 0
      && coreCode.indexOf('localStorage') < 0 && coreCode.indexOf('sessionStorage') < 0
      && coreCode.indexOf('deferredSpeakerIds:JSON') < 0;
  })());
  ok('S44.deferAddsNoCanonicalOrP23Refs', (() => {
    const src = read('assets/js/communication.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const count = (s, t) => s.split(t).length - 1;
    return count(code, "extraMetadata:{groupTurnId") === 1
      && ['delivery-planner', 'multimodal-delivery-policy', 'delivery-sequence-core', 'delivery-runtime', 'voice-message-core']
        .every(f => {
          const s = read('assets/js/' + f + '.js');
          return s.indexOf('deferDynamicRuntimeEntry') < 0 && s.indexOf('deferredSpeakerIds') < 0
            && s.indexOf('DYNAMIC_RUNTIME_DECISIONS') < 0;
        });
  })());
  ok('S45.deferHasNoModelCalls', (() => {
    const code = read('assets/js/group-runtime-core.js').replace(/\/\*[\s\S]*?\*\//g, '');
    const i = code.indexOf('function deferDynamicRuntimeEntry');
    const region = code.slice(i, i + 1400);
    return i > 0 && ['callApi', 'dbPut', 'fetch(', 'Date.now', 'Math.random'].every(t => region.indexOf(t) < 0);
  })());
  ok('S46.noInterjectOrResumeEntry', (() => {
    const code = read('assets/js/group-runtime-core.js') + read('assets/js/communication.js');
    return code.indexOf('interjectEntry') < 0 && code.indexOf('resumeEntry') < 0
      && Core.DYNAMIC_RUNTIME_DECISIONS.INTERJECT === undefined;
  })());
}

/* ── C1–C15 · INTERJECT Contract Design（P24-M3.5.2D · **contract only**）─────
   本阶段不实现 INTERJECT：这些断言只证明"未实现 + 边界未被动过 + 契约已文档化"。 */
function interjectContractDesign() {
  const comm = read('assets/js/communication.js');
  const core = read('assets/js/group-runtime-core.js');
  const coreCode = core.replace(/\/\*[\s\S]*?\*\//g, '');
  const commCode = comm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const doc = read('docs/P24-M3.5-DYNAMIC-PARTICIPATION.md');
  const count = (s, t) => s.split(t).length - 1;
  const P23 = ['delivery-planner', 'multimodal-delivery-policy', 'delivery-sequence-core', 'delivery-runtime', 'voice-message-core'];
  ok('C1.interjectNotImplemented',
    count(coreCode, 'interjectEntry') === 0 && count(commCode, 'interjectEntry') === 0
    && count(coreCode, 'resumeEntry') === 0 && count(commCode, 'resumeEntry') === 0
    && count(coreCode, 'admissionPool') === 0 && count(commCode, 'admissionPool') === 0);
  ok('C2.noRuntimeSymbolForInterject',
    Core.DYNAMIC_RUNTIME_DECISIONS.INTERJECT === undefined
    && JSON.stringify(Core.DYNAMIC_RUNTIME_DECISIONS) === JSON.stringify({ SPEAK: 'speak', SILENT: 'silent', DEFER: 'defer' })
    && coreCode.indexOf('DYNAMIC_RUNTIME_DECISIONS.INTERJECT') < 0);
  ok('C3.noQueueMutationApiForInterject',
    count(commCode, 'insertEntry') === 0 && count(commCode, 'priorityInsert') === 0
    && count(coreCode, 'insertEntry') === 0 && count(coreCode, 'priorityInsert') === 0
    && /pendingEntries\.push\(/.test(coreCode)   /* 唯一 push 仍是 DEFER 的"移尾" */
    && count(coreCode, 'pendingEntries.push(') === 1);
  ok('C4.plannerUnchanged', /PARTICIPATION_PLAN_VERSION = 3/.test(core)
    && /'group-rule-v1'/.test(core) && count(commCode, 'planParticipation(_gPlanInput)') === 1
    && JSON.stringify(Core.PARTICIPATION_REASONS.SKIP) === JSON.stringify(['muted-not-mentioned', 'removed', 'budget-limit']));
  ok('C5.policyFieldsUnchanged',
    /GROUP_POLICY_FIELDS=\['maxResponders','recentSpeakerWindow'\]/.test(read('assets/js/social.js'))
    && /PARTICIPATION_POLICY_FIELDS = Object\.freeze\(\['maxResponders', 'recentSpeakerWindow'\]\)/.test(core)
    && count(core, 'allowInterject') === 0 && count(core, 'interjectBudget') === 0);
  ok('C6.targetingUnchanged',
    count(commCode, 'targetSpeakerIds:') === 1
    /* communication.js 里出现的都是"读取/投影/校验"符号（resolveTargetSpeakerIds 等）或那唯一一处写入；
       不存在任何 interject 相关的 targeting 写入/改写。 */
    && commCode.indexOf('targetSpeakerIds.push') < 0
    && commCode.indexOf('targetSpeakerIds =') < 0
    && coreCode.indexOf('targetSpeakerIds.push') < 0);
  ok('C7.recentUnchanged',
    count(coreCode, 'function deriveRecentSpeakerIds(') === 1
    && count(commCode, 'deriveRecentSpeakerIds(') === 1
    && commCode.indexOf('recentSpeakerIds.push') < 0);
  ok('C8.p23HasNoInterjectReference',
    P23.every(f => {
      const s = read('assets/js/' + f + '.js');
      return s.indexOf('interject') < 0 && s.indexOf('admissionPool') < 0 && s.indexOf('DYNAMIC_RUNTIME_DECISIONS') < 0;
    }));
  ok('C9.memoryHasNoInterjectAuthority',
    read('assets/js/memory.js').indexOf('interject') < 0
    && read('assets/js/memory.js').indexOf('DYNAMIC_RUNTIME_DECISIONS') < 0);
  ok('C10.middleBrainHasNoInterjectAuthority',
    read('assets/js/middle-brain.js').indexOf('interject') < 0
    && read('assets/js/middle-brain.js').indexOf('DYNAMIC_RUNTIME_DECISIONS') < 0);
  ok('C11.noGroupBrainImplementation',
    commCode.indexOf('GroupBrain') < 0 && coreCode.indexOf('GroupBrain') < 0
    && count(commCode, 'groupBrain') === 0 && count(coreCode, 'groupBrain') === 0);
  ok('C12.identityRequirementDocumented',
    doc.indexOf('canonical memberId') >= 0 && doc.indexOf('apiConfigs.id') >= 0
    && doc.indexOf('不得**创建新的 participant') >= 0 || doc.indexOf('不得') >= 0 && doc.indexOf('新的 participant') >= 0);
  ok('C13.turnIdRequirementDocumented',
    doc.indexOf('memberTurnId') >= 0 && doc.indexOf('不得修改') >= 0 && doc.indexOf('memberTurnIdFor') >= 0);
  ok('C14.groupOrderRequirementDocumented',
    doc.indexOf('groupOrder contract') >= 0 && doc.indexOf('未冻结') >= 0
    && doc.indexOf('绝不重编号') >= 0);
  ok('C15.capQuestionDocumented',
    doc.indexOf('INTERJECT 不得增加实际 responder 数超过 cap') >= 0
    && doc.indexOf('不得实现') >= 0);
}

function startMock() {
  const requests = [];
  const delays = { 'm352-slow': 1500 };
  const server = http.createServer((req, res) => {
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
      const model = String(body.model || '');
      requests.push({ model, messages: Array.isArray(body.messages) ? body.messages : [] });
      if (model === 'm352-fail') {
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: { message: 'injected member failure' } }));
        return;
      }
      const send = () => {
        res.writeHead(200, headers);
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'reply-from:' + model }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
        }));
      };
      const d = delays[model] || 0;
      if (d) setTimeout(send, d); else send();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

const HOOK = "(function(){"
  + "window.__m352={chatWrites:0,userWrites:0,reads:[],planner:0,derive:0,project:0,"
  + "rtCreate:0,rtNext:[],rtStarted:[],rtCompleted:[],rtFailed:[],decisions:0,deciderCalls:[],rtState:null};"
  + "if(!window.__m352Hooked){window.__m352Hooked=true;"
  + "window.__m352Orig={put:window.dbPut,g:window.dbGetByIndex,p:window.IBGroupRuntime.planParticipation,"
  + "d:window.IBGroupRuntime.deriveRecentSpeakerIds,pr:window.IBGroupRuntime.projectTargetedParticipants,"
  + "c:window.IBGroupRuntime.createDynamicRuntimeState,n:window.IBGroupRuntime.nextDynamicRuntimeEntry,"
  + "s:window.IBGroupRuntime.markDynamicRuntimeStarted,co:window.IBGroupRuntime.markDynamicRuntimeCompleted,"
  + "fa:window.IBGroupRuntime.markDynamicRuntimeFailed,dec:window.IBGroupRuntime.resolveDynamicRuntimeDecision};"
  + "window.dbPut=function(store,d){if(store==='chatMessages'){window.__m352.chatWrites++;if(d&&d.role==='user')window.__m352.userWrites++}return window.__m352Orig.put.apply(this,arguments)};"
  + "window.dbGetByIndex=function(store,index,key){if(store==='chatMessages'&&index==='byFriend')window.__m352.reads.push(String(key));return window.__m352Orig.g.apply(this,arguments)};"
  + "window.IBGroupRuntime.planParticipation=function(){window.__m352.planner++;return window.__m352Orig.p.apply(this,arguments)};"
  + "window.IBGroupRuntime.deriveRecentSpeakerIds=function(){window.__m352.derive++;return window.__m352Orig.d.apply(this,arguments)};"
  + "window.IBGroupRuntime.projectTargetedParticipants=function(){window.__m352.project++;return window.__m352Orig.pr.apply(this,arguments)};"
  + "window.IBGroupRuntime.createDynamicRuntimeState=function(){window.__m352.rtCreate++;var st=window.__m352Orig.c.apply(this,arguments);window.__m352.rtState=st;return st};"
  /* 决策调用计数 + 记录每个进入 decision 的 speaker（S19–S21/I50/I53 用它证明 "hard gate 之前不调用"）。 */
  + "window.IBGroupRuntime.resolveDynamicRuntimeDecision=function(st,e,ctx){window.__m352.decisions=window.__m352.decisions+1;"
  + "window.__m352.deciderCalls.push(String(e&&e.speakerId));return window.__m352Orig.dec.apply(this,arguments)};"
  + "window.IBGroupRuntime.nextDynamicRuntimeEntry=function(st,ctx){var r=window.__m352Orig.n.apply(this,arguments);"
  + "if(r&&r.done===false)window.__m352.rtNext.push(r.entry.speakerId+'#'+r.entry.order);return r};"
  + "window.IBGroupRuntime.markDynamicRuntimeStarted=function(st,e){window.__m352.rtStarted.push(String(e&&e.speakerId));return window.__m352Orig.s.apply(this,arguments)};"
  + "window.IBGroupRuntime.markDynamicRuntimeCompleted=function(st,id){window.__m352.rtCompleted.push(String(id));"
  /* 取消注入两种模式：async（默认，2A 的"B 在飞行中取消"用例）/ sync（P24-M3.5.2B 的
     "A 完成后立刻取消、silent 候选连 decision 都不能进"用例）。 */
  + "if(window.__m352StopOnFirstDone){window.__m352StopOnFirstDone=false;"
  + "if(window.__m352StopSync){try{stopStreaming()}catch(e){}}else{setTimeout(function(){try{stopStreaming()}catch(e){}},0)}}"
  + "return window.__m352Orig.co.apply(this,arguments)};"
  + "window.IBGroupRuntime.markDynamicRuntimeFailed=function(st,id){window.__m352.rtFailed.push(String(id));return window.__m352Orig.fa.apply(this,arguments)};"
  + "}return true})()";
const RESET = "(function(){window.__m352.chatWrites=0;window.__m352.userWrites=0;window.__m352.reads=[];window.__m352.planner=0;"
  + "window.__m352.derive=0;window.__m352.project=0;window.__m352.rtCreate=0;window.__m352.rtNext=[];window.__m352.rtStarted=[];"
  + "window.__m352.rtCompleted=[];window.__m352.rtFailed=[];window.__m352.decisions=0;window.__m352.deciderCalls=[];"
  + "window.__m352.rtState=null;return true})()";

async function browserIntegration() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m352-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { /* starting */ }
      await new Promise(r => setTimeout(r, 100));
    }
    ok('browser.ready', ready);
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(String(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description)
      || (p.exceptionDetails && p.exceptionDetails.text) || '')));
    ok('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && typeof window.IBGroupRuntime.createDynamicRuntimeState==='function'", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mkCfg = (id, name, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + name + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mkCfg(A_ID, 'Alpha352', 'm352-a'));
    await evaluate(cdp, mkCfg(B_ID, 'Beta352', 'm352-b'));
    await evaluate(cdp, mkCfg(C_ID, 'Gamma352', 'm352-c'));
    await evaluate(cdp, "loadApiConfigs()");
    const G = {
      staticG: 'group_1700000000400', foundG: 'group_1700000000401', failG: 'group_1700000000402',
      cancelG: 'group_1700000000403', mutedG: 'group_1700000000404', capG: 'group_1700000000405',
      cap0G: 'group_1700000000406', slowG: 'group_1700000000407', removedG: 'group_1700000000408'
    };
    const active = (id, st) => "{characterId:'" + id + "',status:'" + st + "',joinedAt:1}";
    const mkGroup = (gid, members) => "(function(){return dbPut('groups',{id:'" + gid + "',name:'M352 " + gid.slice(-3) + "',members:[" + members + "],memoryEnabled:false,created:1})})()";
    const allActive = [active(A_ID, 'active'), active(B_ID, 'active'), active(C_ID, 'active')].join(',');
    for (const k of ['staticG', 'foundG', 'failG', 'cancelG', 'capG', 'cap0G', 'slowG']) await evaluate(cdp, mkGroup(G[k], allActive));
    await evaluate(cdp, mkGroup(G.mutedG, [active(A_ID, 'active'), active(B_ID, 'muted'), active(C_ID, 'active')].join(',')));
    await evaluate(cdp, mkGroup(G.removedG, [active(A_ID, 'active'), active(B_ID, 'removed'), active(C_ID, 'active')].join(',')));
    ok('fixtures.ready', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.staticG + "');return !!g&&g.members.length===3})()"));
    await evaluate(cdp, HOOK);

    const requestsFor = tag => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(tag) >= 0);
    const rowsOf = gid => evaluate(cdp, "(async function(){var all=await window.__m352Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).map(function(m){return {c:m.content,s:(m.metadata||{}).speakerId,o:(m.metadata||{}).groupOrder,t:(m.metadata||{}).turnId,g:(m.metadata||{}).groupTurnId,k:Object.keys(m.metadata||{}).sort().join('|')}})})()");
    const counters = () => evaluate(cdp, "({chatWrites:window.__m352.chatWrites,userWrites:window.__m352.userWrites,reads:window.__m352.reads.length,planner:window.__m352.planner,derive:window.__m352.derive,project:window.__m352.project,rtCreate:window.__m352.rtCreate,rtNext:window.__m352.rtNext,rtStarted:window.__m352.rtStarted,rtCompleted:window.__m352.rtCompleted,rtFailed:window.__m352.rtFailed,decisions:window.__m352.decisions,deciderCalls:window.__m352.deciderCalls.slice()})");
    const botsAtLeast = (gid, min) => "(async function(){var all=await window.__m352Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + min + "})()";
    const setSwitch = on => evaluate(cdp, "window.IB_DYNAMIC_PARTICIPATION=" + (on ? 'true' : 'false'));
    const setPolicy = (gid, frag) => evaluate(cdp, "(async function(){return await window.setGroupParticipationPolicy(" + JSON.stringify(gid) + "," + JSON.stringify(frag) + ")})()");
    const sendTo = async (gid, text) => {
      await evaluate(cdp, "(function(){activeFriendId='" + gid + "';activeThreadId=null;openChatPanel();return true})()");
      await evaluate(cdp, RESET);
      mock.requests.length = 0;
      await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value=" + JSON.stringify(text) + ";return sendChatMessage()})()");
    };

    /* ── I1–I9 · feature DISABLED：与既有 static runtime 等价 ─────────────── */
    await setSwitch(false);
    await sendTo(G.staticG, 'M352 static round');
    ok('I1.disabledRoundCompletes', await waitFor(cdp, botsAtLeast(G.staticG, 3), 30000));
    const cStatic = await counters();
    ok('I2.disabledProviderCallsExactlyThree', requestsFor('M352 static round').length === 3
      && requestsFor('M352 static round').map(r => r.model).join(',') === 'm352-a,m352-b,m352-c',
      requestsFor('M352 static round').map(r => r.model));
    ok('I3.disabledAssistantRowsExactlyThree', (await rowsOf(G.staticG)).length === 3);
    ok('I4.disabledZeroExtraRuntimeState', cStatic.rtCreate === 0 && cStatic.rtNext.length === 0
      && cStatic.rtStarted.length === 0, cStatic);
    ok('I5.disabledOneUserWriteOneSnapshotRead', cStatic.userWrites === 1 && cStatic.reads === 1, cStatic);
    ok('I6.disabledChatWritesAreFour', cStatic.chatWrites === 4, cStatic);
    ok('I7.disabledPlannerCalledOnce', cStatic.planner === 1);
    ok('I8.disabledRecentDerivedOnce', cStatic.derive === 1);
    ok('I9.disabledProjectionOnce', cStatic.project === 1);

    /* ── I10–I14 + 差分基线：feature ENABLED（foundation，无 dynamic decision）── */
    await setSwitch(true);
    await sendTo(G.foundG, 'M352 static round');
    ok('I10.enabledFoundationRoundCompletes', await waitFor(cdp, botsAtLeast(G.foundG, 3), 30000));
    const cFound = await counters();
    const rowsStatic = await rowsOf(G.staticG);
    const rowsFound = await rowsOf(G.foundG);
    ok('I11.enabledSameProviderCount', requestsFor('M352 static round').length === 3
      && requestsFor('M352 static round').map(r => r.model).join(',') === 'm352-a,m352-b,m352-c',
      requestsFor('M352 static round').map(r => r.model));
    ok('I12.enabledSameCanonicalRows',
      JSON.stringify(rowsFound.map(r => r.s + '|' + r.o + '|' + r.c)) === JSON.stringify(rowsStatic.map(r => r.s + '|' + r.o + '|' + r.c)),
      { rowsFound, rowsStatic });
    ok('I13.sameGroupOrderZeroOneTwo',
      rowsFound.map(r => r.s + '#' + r.o).join(',') === [A_ID + '#0', B_ID + '#1', C_ID + '#2'].join(','));
    ok('I14.sameTurnIdDerivation', rowsFound.every(r => r.t === Core.memberTurnIdFor(r.g, r.s, r.o)));
    ok('I14b.differentialCountersMatch',
      JSON.stringify({ w: cFound.chatWrites, u: cFound.userWrites, r: cFound.reads, p: cFound.planner, d: cFound.derive, pr: cFound.project })
      === JSON.stringify({ w: cStatic.chatWrites, u: cStatic.userWrites, r: cStatic.reads, p: cStatic.planner, d: cStatic.derive, pr: cStatic.project }),
      { cFound, cStatic });
    ok('I14c.differentialMetadataKeysMatch',
      JSON.stringify(rowsFound.map(r => r.k)) === JSON.stringify(rowsStatic.map(r => r.k)), { found: rowsFound.map(r => r.k) });
    ok('I14d.enabledRuntimeQueueDrainedInPlanOrder',
      cFound.rtCreate === 1 && cFound.rtNext.join(',') === [A_ID + '#0', B_ID + '#1', C_ID + '#2'].join(',')
      && cFound.rtStarted.join(',') === [A_ID, B_ID, C_ID].join(',')
      && cFound.rtCompleted.join(',') === [A_ID, B_ID, C_ID].join(','), cFound);
    ok('I23.roundExtrasSemanticsUnchanged', (() => {
      const reqB = requestsFor('M352 static round').find(r => r.model === 'm352-b');
      return !!reqB && JSON.stringify(reqB.messages).indexOf('reply-from:m352-a') >= 0;
    })());

    /* ── I15–I18 · 失败隔离与取消（enabled foundation 下同样成立）────────── */
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='m352-fail';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");
    await sendTo(G.failG, 'M352 failure round');
    ok('I15.failureRoundCallsAllThree', await waitFor(cdp, botsAtLeast(G.failG, 2), 30000)
      && requestsFor('M352 failure round').length === 3, requestsFor('M352 failure round').map(r => r.model));
    const cFail = await counters();
    ok('I16.failedSpeakerNotRetried', requestsFor('M352 failure round').filter(r => r.model === 'm352-fail').length === 1
      && cFail.rtFailed.join(',') === A_ID && cFail.rtCompleted.join(',') === [B_ID, C_ID].join(','), cFail);
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='m352-a';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});c.model='m352-slow';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");
    /* 确定性取消：A 完成的那一刻（markDynamicRuntimeCompleted 挂钩）触发一次 stopStreaming，
       此时 B（1500ms 慢响应）仍在飞行 ⇒ C 必须永不启动、A/B 的已完成消息保留。 */
    await evaluate(cdp, "window.__m352StopOnFirstDone=true");
    await sendTo(G.cancelG, 'M352 cancel round');
    await waitFor(cdp, botsAtLeast(G.cancelG, 1), 25000);
    await new Promise(r => setTimeout(r, 3500));
    const cCancel = await counters();
    ok('I17.cancelAfterABlocksLaterMembers',
      requestsFor('M352 cancel round').length === 2
      && requestsFor('M352 cancel round').map(r => r.model).join(',') === 'm352-a,m352-slow'
      && cCancel.rtStarted.join(',') === [A_ID, B_ID].join(',')
      && cCancel.rtStarted.indexOf(C_ID) < 0, cCancel);
    ok('I18.completedMessagePreservedOnCancel', await (async () => {
      const rows = await rowsOf(G.cancelG);
      return rows.length === 2 && rows[0].s === A_ID && rows[1].s === B_ID;
    })());
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});c.model='m352-b';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");

    /* ── I19–I22 · muted / removed / cap 语义（planner 权威不变）─────────── */
    await sendTo(G.mutedG, '@Beta352 M352 muted targeted');
    ok('I19.mutedTargetedSpeakerStillExecutes', await waitFor(cdp, botsAtLeast(G.mutedG, 3), 30000)
      && requestsFor('M352 muted targeted').length === 3, requestsFor('M352 muted targeted').map(r => r.model));
    await sendTo(G.removedG, '@Beta352 M352 removed probe');
    ok('I20.removedNeverExecutes', await waitFor(cdp, botsAtLeast(G.removedG, 2), 30000)
      && requestsFor('M352 removed probe').every(r => r.model !== 'm352-b')
      && requestsFor('M352 removed probe').length === 2, requestsFor('M352 removed probe').map(r => r.model));
    await setPolicy(G.capG, { maxResponders: 2 });
    await sendTo(G.capG, 'M352 cap probe');
    ok('I21.capRespected', await waitFor(cdp, botsAtLeast(G.capG, 2), 30000)
      && requestsFor('M352 cap probe').length === 2, requestsFor('M352 cap probe').map(r => r.model));
    await setPolicy(G.cap0G, { maxResponders: 0 });
    await sendTo(G.cap0G, 'M352 cap0 probe');
    ok('I22.capZeroEmptyPlanPathUnchanged',
      await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮无人回应')>=0})()", 20000)
      && requestsFor('M352 cap0 probe').length === 0, requestsFor('M352 cap0 probe').length);

    /* ── I24 · typing 语义不变（只有真正开始的 MemberTurn 才有 typing）────── */
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='m352-slow';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");
    await sendTo(G.slowG, 'M352 typing probe');
    ok('I24.typingAppearsOnlyWhileMemberRuns', await waitFor(cdp, "(function(){return document.querySelectorAll('.chat-typing').length>=1})()", 10000));
    await waitFor(cdp, botsAtLeast(G.slowG, 3), 30000);
    /* 成功路径会把 typing 元素改成 "N秒" 结果并在 1000ms 后移除 ⇒ 轮询等待清空。 */
    let typingLeft = -1;
    for (let i = 0; i < 25; i++) {
      typingLeft = await evaluate(cdp, "document.querySelectorAll('.chat-typing').length");
      if (typingLeft === 0) break;
      await new Promise(r => setTimeout(r, 200));
    }
    ok('I24b.typingClearedAfterRound', typingLeft === 0, typingLeft);
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='m352-a';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");

    /* ── I25 · 单聊不受影响 ─────────────────────────────────────────────── */
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M352 single';return sendChatMessage()})()");
    ok('I25.singleChatUnaffected', await waitFor(cdp, "(async function(){var all=await window.__m352Orig.g('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=1})()", 25000)
      && (await counters()).rtCreate === 0);

    /* ══ P24-M3.5.2B · Runtime SILENT（I26–I58 + 三组差分基线）══════════════ */
    const SG = {
      baseOff: 'group_1700000000410', baseFound: 'group_1700000000411', baseSpeak: 'group_1700000000412',
      mixed: 'group_1700000000413', allSil: 'group_1700000000414', firstSil: 'group_1700000000415',
      lastSil: 'group_1700000000416', failSil: 'group_1700000000417', cancelSil: 'group_1700000000418',
      targetSil: 'group_1700000000419', mutedSil: 'group_1700000000420', capSil: 'group_1700000000421',
      removedSil: 'group_1700000000422'
    };
    for (const k of Object.keys(SG)) {
      if (k === 'mutedSil') await evaluate(cdp, mkGroup(SG[k], [active(A_ID, 'active'), active(B_ID, 'muted'), active(C_ID, 'active')].join(',')));
      else if (k === 'removedSil') await evaluate(cdp, mkGroup(SG[k], [active(A_ID, 'active'), active(B_ID, 'removed'), active(C_ID, 'active')].join(',')));
      else await evaluate(cdp, mkGroup(SG[k], allActive));
    }
    /* decider 注入（仅测试；runtime-only）+ 记录被询问的 speaker */
    const setDecider = map => evaluate(cdp, "(function(){window.__m352.deciderCalls=[];window.__m352.decisions=0;"
      + "window.IB_DYNAMIC_PARTICIPATION_DECIDER=function(ctx){var m=" + JSON.stringify(map) + ";return {decision:m[ctx.speakerId]||'speak'}};return true})()");
    const clearDecider = () => evaluate(cdp, "(function(){try{delete window.IB_DYNAMIC_PARTICIPATION_DECIDER}catch(e){};return true})()");
    const rtState = () => evaluate(cdp, "(function(){return window.__m352.rtState?window.IBGroupRuntime.dynamicRuntimeSnapshot(window.__m352.rtState):null})()");
    const silentDeciderB = () => setDecider({ [B_ID]: 'silent' });

    /* I26/I27 · disabled + B=SILENT hook ⇒ 不调用 hook、三人全部 SPEAK（BASELINE A 的一部分） */
    await setSwitch(false);
    await silentDeciderB();
    await sendTo(SG.baseOff, 'M352 silent-off round');
    ok('I26.disabledIgnoresSilentHook', await waitFor(cdp, botsAtLeast(SG.baseOff, 3), 30000)
      && requestsFor('M352 silent-off round').length === 3, requestsFor('M352 silent-off round').map(r => r.model));
    ok('I27.disabledNeverCallsDecider', (await counters()).decisions === 0 && (await counters()).rtCreate === 0, await counters());
    const rowsOff = await rowsOf(SG.baseOff);
    const cOff = await counters();

    /* I28/I29 · enabled 无 decider（BASELINE B）与 enabled all-SPEAK（BASELINE C） */
    await setSwitch(true);
    await clearDecider();
    await sendTo(SG.baseFound, 'M352 silent-off round');
    ok('I28.enabledNoDeciderAllSpeak', await waitFor(cdp, botsAtLeast(SG.baseFound, 3), 30000)
      && requestsFor('M352 silent-off round').length === 3, requestsFor('M352 silent-off round').map(r => r.model));
    const rowsFound2 = await rowsOf(SG.baseFound);
    const cFound2 = await counters();
    /* BASELINE B：enabled + 无 decider 与 disabled 的可观测输出全等
       （decision seam 会被咨询一次/成员，但无 hook ⇒ 全部 SPEAK ⇒ 行为不变）。 */
    ok('I28b.baselineBMatchesDisabled', JSON.stringify(rowsFound2.map(r => r.s + '#' + r.o + '|' + r.c))
      === JSON.stringify(rowsOff.map(r => r.s + '#' + r.o + '|' + r.c))
      && JSON.stringify({ w: cFound2.chatWrites, u: cFound2.userWrites, r: cFound2.reads, p: cFound2.planner, d: cFound2.derive, pr: cFound2.project })
      === JSON.stringify({ w: cOff.chatWrites, u: cOff.userWrites, r: cOff.reads, p: cOff.planner, d: cOff.derive, pr: cOff.project })
      && cFound2.decisions === 3 && cOff.decisions === 0,
      { off: rowsOff.map(r => r.s + '#' + r.o + '|' + r.c), found: rowsFound2.map(r => r.s + '#' + r.o + '|' + r.c), cOff, cFound2 });
    await setDecider({});
    await sendTo(SG.baseSpeak, 'M352 silent-off round');
    ok('I29.enabledAllSpeakEqualsNoDecider', await waitFor(cdp, botsAtLeast(SG.baseSpeak, 3), 30000));
    const rowsSpeak = await rowsOf(SG.baseSpeak);
    ok('I29b.baselineCMatchesNoDecider', JSON.stringify(rowsSpeak.map(r => r.s + '#' + r.o + '|' + r.c))
      === JSON.stringify(rowsFound2.map(r => r.s + '#' + r.o + '|' + r.c)), { rowsSpeak, rowsFound2 });

    /* I30–I41 · mixed：A SPEAK / B SILENT / C SPEAK */
    await silentDeciderB();
    await sendTo(SG.mixed, 'M352 mixed round');
    ok('I30.mixedProviderCallsAreAandC', await waitFor(cdp, botsAtLeast(SG.mixed, 2), 30000)
      && requestsFor('M352 mixed round').length === 2
      && requestsFor('M352 mixed round').map(r => r.model).join(',') === 'm352-a,m352-c',
      requestsFor('M352 mixed round').map(r => r.model));
    const rowsMixed = await rowsOf(SG.mixed);
    const cMixed = await counters();
    const snapMixed = await rtState();
    ok('I31.mixedAssistantRowsAreAandC', rowsMixed.length === 2 && rowsMixed[0].s === A_ID && rowsMixed[1].s === C_ID,
      rowsMixed.map(r => r.s));
    ok('I32.groupOrderHolePreserved', rowsMixed.map(r => r.s + '#' + r.o).join(',') === [A_ID + '#0', C_ID + '#2'].join(','),
      rowsMixed.map(r => r.s + '#' + r.o));
    ok('I33.turnIdsDerivedFromPlannedOrder', rowsMixed.every(r => r.t === Core.memberTurnIdFor(r.g, r.s, r.o))
      && rowsMixed[1].o === 2);
    ok('I34.plannedCountStaysThree', !!snapMixed && snapMixed.pendingEntries.length === 0
      && snapMixed.completedSpeakerIds.length + snapMixed.silentSpeakerIds.length + snapMixed.failedSpeakerIds.length === 3);
    ok('I35.startedExcludesSilent', !!snapMixed && snapMixed.startedSpeakerIds.join(',') === [A_ID, C_ID].join(',')
      && requestsFor('M352 mixed round').length === 2);
    ok('I36.runtimeSilentEqualsB', !!snapMixed && JSON.stringify(snapMixed.silentSpeakerIds) === JSON.stringify([B_ID])
      && JSON.stringify(snapMixed.completedSpeakerIds) === JSON.stringify([A_ID, C_ID])
      && snapMixed.failedSpeakerIds.length === 0, snapMixed);
    ok('I37.noTypingForSilentSpeaker', (await evaluate(cdp, "String(window.__m352TypingSeen||'').indexOf('Beta352')<0"))
      || (await evaluate(cdp, "(function(){return document.querySelectorAll('.chat-typing').length===0})()")));
    ok('I38.silentSpeakerHasNoCanonicalRow', rowsMixed.every(r => r.s !== B_ID));
    ok('I40.laterSpeakerStillSeesEarlierReply', (() => {
      const reqC = requestsFor('M352 mixed round').find(r => r.model === 'm352-c');
      return !!reqC && JSON.stringify(reqC.messages).indexOf('reply-from:m352-a') >= 0;
    })());
    ok('I41.noSilentArtifactInProviderContext', (() => {
      const reqC = requestsFor('M352 mixed round').find(r => r.model === 'm352-c');
      const wire = JSON.stringify(reqC && reqC.messages || []);
      return wire.indexOf('[Beta352]') < 0 && wire.indexOf('（沉默）') < 0 && wire.indexOf('silent') < 0;
    })());
    ok('I55.plannerCalledOnceInMixedRound', cMixed.planner === 1);
    ok('I56.recentDerivedOnceInMixedRound', cMixed.derive === 1);
    ok('I57.targetProjectionOnceInMixedRound', cMixed.project === 1);
    await clearDecider();

    /* I42–I46 · all SILENT */
    await setDecider({ [A_ID]: 'silent', [B_ID]: 'silent', [C_ID]: 'silent' });
    await sendTo(SG.allSil, 'M352 all silent round');
    await new Promise(r => setTimeout(r, 2500));
    const rowsAll = await rowsOf(SG.allSil);
    const snapAll = await rtState();
    ok('I42.allSilentZeroProviderCalls', requestsFor('M352 all silent round').length === 0);
    ok('I43.allSilentZeroAssistantRows', rowsAll.length === 0);
    ok('I44.allSilentUserRowPreserved', await evaluate(cdp, "(async function(){var all=await window.__m352Orig.g('chatMessages','byFriend','" + SG.allSil + "');return all.filter(function(m){return m.role==='user'&&String(m.content).indexOf('M352 all silent round')>=0}).length===1})()"));
    ok('I45.allSilentTurnCompletes', !!snapAll && JSON.stringify(snapAll.silentSpeakerIds.sort()) === JSON.stringify([A_ID, B_ID, C_ID].sort())
      && snapAll.startedSpeakerIds.length === 0);
    ok('I46.allSilentNoFakeMessage', await evaluate(cdp, "(async function(){var all=await window.__m352Orig.g('chatMessages','byFriend','" + SG.allSil + "');"
      + "return all.every(function(m){return String(m.content||'').indexOf('沉默')<0})})()")
      && await evaluate(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return String(m.textContent||'').indexOf('本轮无人回应')<0})()"));
    await clearDecider();

    /* I47/I48 · first / last silent */
    await setDecider({ [A_ID]: 'silent' });
    await sendTo(SG.firstSil, 'M352 first silent');
    ok('I47.firstSpeakerSilent', await waitFor(cdp, botsAtLeast(SG.firstSil, 2), 30000)
      && requestsFor('M352 first silent').map(r => r.model).join(',') === 'm352-b,m352-c', requestsFor('M352 first silent').map(r => r.model));
    await clearDecider();
    await setDecider({ [C_ID]: 'silent' });
    await sendTo(SG.lastSil, 'M352 last silent');
    ok('I48.lastSpeakerSilent', await waitFor(cdp, botsAtLeast(SG.lastSil, 2), 30000)
      && requestsFor('M352 last silent').map(r => r.model).join(',') === 'm352-a,m352-b', requestsFor('M352 last silent').map(r => r.model));
    await clearDecider();

    /* I49 · failure + silent + speak */
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='m352-fail';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");
    await silentDeciderB();
    await sendTo(SG.failSil, 'M352 fail silent round');
    ok('I49.failureAndSilentCoexist', await waitFor(cdp, botsAtLeast(SG.failSil, 1), 30000)
      && requestsFor('M352 fail silent round').map(r => r.model).join(',') === 'm352-fail,m352-c',
      requestsFor('M352 fail silent round').map(r => r.model));
    const snapFail = await rtState();
    ok('I49b.failedSilentCompletedDistinct', !!snapFail
      && JSON.stringify(snapFail.failedSpeakerIds) === JSON.stringify([A_ID])
      && JSON.stringify(snapFail.silentSpeakerIds) === JSON.stringify([B_ID])
      && JSON.stringify(snapFail.completedSpeakerIds) === JSON.stringify([C_ID]), snapFail);
    await clearDecider();
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='m352-a';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");

    /* I50 · cancel 在 silent 候选之前 ⇒ decider 不会被询问 */
    await silentDeciderB();
    await evaluate(cdp, "window.__m352StopSync=true;window.__m352StopOnFirstDone=true");
    await sendTo(SG.cancelSil, 'M352 cancel silent round');
    await waitFor(cdp, botsAtLeast(SG.cancelSil, 1), 25000);
    await new Promise(r => setTimeout(r, 2500));
    ok('I50.cancelBeforeSilentCandidateSkipsDecider', (await evaluate(cdp, "window.__m352.deciderCalls.slice()")).indexOf(B_ID) < 0
      && (await evaluate(cdp, "window.__m352.deciderCalls.slice()")).indexOf(C_ID) < 0,
      { calls: await evaluate(cdp, "window.__m352.deciderCalls.slice()"),
        flag: await evaluate(cdp, "window.__m352StopOnFirstDone"),
        completed: await evaluate(cdp, "window.__m352.rtCompleted.slice()"),
        models: requestsFor('M352 cancel silent round').map(r => r.model) });
    await clearDecider();

    /* I51/I52 · targeted（含 muted+targeted）可以 SILENT，且 targeting 事实不变 */
    await silentDeciderB();
    await sendTo(SG.targetSil, '@Beta352 M352 targeted silent');
    await waitFor(cdp, botsAtLeast(SG.targetSil, 2), 30000);
    ok('I51.targetedSpeakerMayStillBeSilent', requestsFor('M352 targeted silent').length === 2
      && (await rowsOf(SG.targetSil)).every(r => r.s !== B_ID)
      && await evaluate(cdp, "(async function(){var all=await window.__m352Orig.g('chatMessages','byFriend','" + SG.targetSil + "');var us=all.filter(function(m){return m.role==='user'});return JSON.stringify(us[us.length-1].metadata.targetSpeakerIds)===JSON.stringify(['" + B_ID + "'])})()"),
      requestsFor('M352 targeted silent').map(r => r.model));
    await clearDecider();
    await silentDeciderB();
    await sendTo(SG.mutedSil, '@Beta352 M352 muted silent');
    await waitFor(cdp, botsAtLeast(SG.mutedSil, 2), 30000);
    ok('I52.mutedTargetedSpeakerMayBeSilent', requestsFor('M352 muted silent').length === 2
      && (await rowsOf(SG.mutedSil)).every(r => r.s !== B_ID), requestsFor('M352 muted silent').map(r => r.model));
    await clearDecider();

    /* I53 · removed 永不进入 decision（hard gate 在前） */
    await silentDeciderB();
    await sendTo(SG.removedSil, 'M352 removed silent round');
    await waitFor(cdp, botsAtLeast(SG.removedSil, 2), 30000);
    ok('I53.removedNeverReachesDecider', (await evaluate(cdp, "window.__m352.deciderCalls.slice()")).indexOf(B_ID) < 0
      && requestsFor('M352 removed silent round').length === 2, await evaluate(cdp, "window.__m352.deciderCalls.slice()"));
    await clearDecider();

    /* I54 · cap 不因 SILENT 被补位（cap 是 maximum，不是 fill target） */
    await setPolicy(SG.capSil, { maxResponders: 2 });
    await silentDeciderB();
    await sendTo(SG.capSil, 'M352 cap silent round');
    await new Promise(r => setTimeout(r, 2500));
    ok('I54.capNotRefilledAfterSilent', requestsFor('M352 cap silent round').map(r => r.model).join(',') === 'm352-a',
      requestsFor('M352 cap silent round').map(r => r.model));
    await clearDecider();

    /* I58 · 单聊不受影响（含 hook 存在时） */
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M352 single 2';return sendChatMessage()})()");
    ok('I58.singleChatUnaffectedWithSilentLayer', await waitFor(cdp, "(async function(){var all=await window.__m352Orig.g('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=2})()", 25000)
      && (await counters()).decisions === 0 && (await counters()).rtCreate === 0, await counters());

    /* ══ P24-M3.5.2C · Runtime DEFER（I59–I71）══════════════════════════════ */
    const DG = {
      deferG: 'group_1700000000430', deferLimitG: 'group_1700000000431', allDeferG: 'group_1700000000432',
      deferCancelG: 'group_1700000000433', deferTargetG: 'group_1700000000434'
    };
    for (const k of Object.keys(DG)) await evaluate(cdp, mkGroup(DG[k], allActive));
    const deferredB = () => setDecider({ [A_ID]: 'defer' });
    const rowsOrder = rows => rows.map(r => r.s + '#' + r.o).join(' | ');

    /* I59/I60/I61/I62/I63/I64/I65/I66/I67 · A DEFER ⇒ 顺序 B,C,A（且 A 只执行一次） */
    await deferredB();
    await sendTo(DG.deferG, 'M352 defer round');
    ok('I59.deferRunsLater', await waitFor(cdp, botsAtLeast(DG.deferG, 3), 30000)
      && requestsFor('M352 defer round').map(r => r.model).join(',') === 'm352-b,m352-c,m352-a',
      requestsFor('M352 defer round').map(r => r.model));
    const cDef = await counters();
    const snapDef = await rtState();
    const rowsDef = await rowsOf(DG.deferG);
    ok('I60.deferredRecorded', !!snapDef && JSON.stringify(snapDef.deferredSpeakerIds) === JSON.stringify([A_ID]), snapDef);
    ok('I61.deferHappensOnceAndConverges', requestsFor('M352 defer round').length === 3
      && requestsFor('M352 defer round').filter(r => r.model === 'm352-a').length === 1);
    ok('I62.turnIdUnchangedAcrossDefer', rowsDef.every(r => r.t === Core.memberTurnIdFor(r.g, r.s, r.o))
      && (rowsDef.find(r => r.s === A_ID) || {}).o === 0);
    ok('I63.groupOrderUnchangedByDefer', rowsOrder(rowsDef.slice().sort((x, y) => x.o - y.o)) === [A_ID + '#0', B_ID + '#1', C_ID + '#2'].join(' | '),
      rowsOrder(rowsDef));
    ok('I64.plannedCountUnchangedByDefer', !!snapDef && snapDef.pendingEntries.length === 0
      && snapDef.completedSpeakerIds.length === 3 && snapDef.silentSpeakerIds.length === 0);
    ok('I65.startedExcludesDeferPass', !!snapDef && snapDef.startedSpeakerIds.join(',') === [B_ID, C_ID, A_ID].join(',')
      && cDef.planner === 1 && cDef.derive === 1);
    ok('I66.roundExtrasHasNoDeferArtifact', (() => {
      const reqB = requestsFor('M352 defer round').find(r => r.model === 'm352-b');
      const reqA = requestsFor('M352 defer round').find(r => r.model === 'm352-a');
      const wireB = JSON.stringify(reqB && reqB.messages || []);
      const wireA = JSON.stringify(reqA && reqA.messages || []);
      return wireB.indexOf('reply-from:m352-a') < 0        /* A 尚未发言 ⇒ B 看不到 */
        && wireA.indexOf('reply-from:m352-b') >= 0 && wireA.indexOf('reply-from:m352-c') >= 0;
    })());
    ok('I67.recentStillPreTurnSnapshot', !!snapDef && cDef.derive === 1
      && cDef.reads === 1 && cDef.chatWrites === 4);
    await clearDecider();

    /* I68 · defer 之后 cancel ⇒ 后续（含被 defer 的 A）不再执行 */
    await deferredB();
    await evaluate(cdp, "window.__m352StopSync=true;window.__m352StopOnFirstDone=true");
    await sendTo(DG.deferCancelG, 'M352 defer cancel round');
    await new Promise(r => setTimeout(r, 2500));
    ok('I68.cancelAfterDeferStopsQueue', requestsFor('M352 defer cancel round').map(r => r.model).join(',') === 'm352-b'
      && (await rtState()) && (await rtState()).silentSpeakerIds.length === 0,
      { models: requestsFor('M352 defer cancel round').map(r => r.model), snap: await rtState() });
    await clearDecider();

    /* I69 · 全员 defer ⇒ 第二轮 defer-limit 全部 fallback SPEAK（收敛、确定性） */
    await setDecider({ [A_ID]: 'defer', [B_ID]: 'defer', [C_ID]: 'defer' });
    await sendTo(DG.allDeferG, 'M352 all defer round');
    ok('I69.allDeferEventuallySpeaks', await waitFor(cdp, botsAtLeast(DG.allDeferG, 3), 30000)
      && requestsFor('M352 all defer round').map(r => r.model).join(',') === 'm352-a,m352-b,m352-c',
      requestsFor('M352 all defer round').map(r => r.model));
    const snapAllDef = await rtState();
    ok('I69b.allDeferConvergesDeterministically', !!snapAllDef
      && JSON.stringify(snapAllDef.deferredSpeakerIds.sort()) === JSON.stringify([A_ID, B_ID, C_ID].sort())
      && snapAllDef.startedSpeakerIds.length === 3 && snapAllDef.silentSpeakerIds.length === 0, snapAllDef);
    await clearDecider();

    /* I70/I71 · baseline 不变；defer-only 只允许"顺序"差异（集合与内容相同） */
    const rowsOffFinal = await rowsOf(SG.baseOff);
    const rowsFoundFinal = await rowsOf(SG.baseFound);
    ok('I70.disabledBaselineStillExact', rowsOrder(rowsOffFinal.slice().sort((x, y) => x.o - y.o))
      === [A_ID + '#0', B_ID + '#1', C_ID + '#2'].join(' | '));
    ok('I71.enabledNoDeciderBaselineStillExact', rowsOrder(rowsFoundFinal.slice().sort((x, y) => x.o - y.o))
      === rowsOrder(rowsOffFinal.slice().sort((x, y) => x.o - y.o)));
    ok('I71b.deferOnlyDiffersOnlyByOrder', (() => {
      const norm = rows => rows.slice().sort((x, y) => x.o - y.o).map(r => r.s + '#' + r.o + '|' + r.c).join(' | ');
      return norm(rowsDef) === norm(rowsFoundFinal);
    })(), { defer: rowsDef.map(r => r.s + '|' + r.c), base: rowsFoundFinal.map(r => r.s + '|' + r.c) });

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M3.5.2A · Dynamic Runtime State Foundation 测试 ==');
  sourceGuards();
  pureContract();
  silentContract();
  deferContract();
  interjectContractDesign();
  await browserIntegration();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
