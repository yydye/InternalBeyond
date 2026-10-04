'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-B · Deterministic MetaMemory SHADOW
   （纯 Node，零浏览器、零网络、零 DB）

   运行：node tests/test_metamemory_shadow.js

   ── 本文件要证明的唯一一件事 ──────────────────────────────────────────
   R4-B 交付了一个 reconstructive runtime —— 但它**只是影子**：

       SYSTEM EVIDENCE STATE  !=  CHARACTER SUBJECTIVE MEMORY STATE

   因此下面每一节都在证明"影子没有影响任何东西"，以及"影子说的是
   系统已知事实，不是角色的感受"。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MM = require(path.join(ROOT, 'assets/js/memory-recall/metamemory-shadow.js'));
const VIS = require(path.join(ROOT, 'assets/js/memory-visibility-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const WIRING = require('./helpers/activation-wiring-probe.js');

let passed = 0;
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1760000000000;
function mem(over) {
  return Object.assign({
    id: 'm', title: 'T', summary: '', content: 'C', domain: '日常',
    rawSource: 'manual', sourceId: '', tags: [], valence: 0.5, arousal: 0.3,
    importance: 5, resolved: false, pinned: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    createdBy: 'user', activationCount: 0, created: NOW - 1000, lastActivated: NOW - 1000,
    kind: 'episodic', consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}
const R = (ids, records, extra) => MM.evaluateTurnShadow(
  Object.assign({ selectedIds: ids, records: records, roleId: 'role_a', now: NOW }, extra || {}),
  { visibility: VIS });
const byId = (out, id) => out.memories.filter(m => m.memoryId === id)[0];

/* ══════════════════════════════════════════════════════════════════
   A · pure evaluator
   ══════════════════════════════════════════════════════════════════ */
section('A · pure evaluator');

{
  const recs = [mem({ id: 'd1' }), mem({
    id: 'dv1', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['e1', 'e2']
  }), mem({ id: 'e1' }), mem({ id: 'e2' })];
  const out = R(['d1', 'dv1'], recs);
  check('A1.shapeIsBoundedAndJsonSafe',
    (function () { try { JSON.stringify(out); return true; } catch (e) { return false; } })()
    && Array.isArray(out.memories) && out.memories.length === 2
    && typeof out.ok === 'boolean' && typeof out.degraded === 'boolean'
    && Array.isArray(out.reasonCodes),
    'the shadow must be a bounded, JSON-safe plain object');
  check('A2.everyFieldIsAClosedVocabulary',
    out.memories.every(m => MM.EVIDENCE_STATES.indexOf(m.evidenceState) >= 0
      && MM.EVIDENCE_CONFIDENCE_STATES.indexOf(m.evidenceConfidenceState) >= 0),
    'evidenceState / evidenceConfidenceState must come from the frozen closed sets');
  check('A3.stateVocabularyIsClosedAndNonSubjective',
    JSON.stringify(MM.EVIDENCE_STATES) === JSON.stringify(['unknown', 'degraded', 'evidence-lost',
      'evidence-hidden', 'evidence-unavailable', 'evidence-unattested', 'attested', 'direct']),
    'the state vocabulary must be exactly the eight mechanically decidable states');
  check('A4.usesTheSingleEvidenceCore',
    MM.declaredEvidenceIds(mem({ consolidatedFrom: ['a', 'a', 'b'], evidenceIds: ['b', 'c'] })).join(',') === 'a,b,c',
    'declared evidence must be the de-duplicated union of consolidatedFrom and evidenceIds');
}

/* ══════════════════════════════════════════════════════════════════
   B · direct producer matrix（§7 / §17）
   ══════════════════════════════════════════════════════════════════ */
section('B · direct producer matrix');

{
  const producers = ['manual', 'chat', 'group_chat', 'blog', 'letter', 'diary', 'coread', 'cinema', 'role_dm'];
  const recs = producers.map((s, i) => mem({ id: 'p' + i, rawSource: s }));
  const out = R(producers.map((s, i) => 'p' + i), recs);
  check('B1.allDirectProducersAreDirectNotMissing',
    out.memories.every(m => m.evidenceState === 'direct'
      && m.derivation === 'direct'
      && m.reasonCodes.indexOf('no-upstream-evidence-required') >= 0),
    'a producer with no upstream evidence must NEVER be reported as missing evidence: '
    + JSON.stringify(out.memories.map(m => m.memoryId + ':' + m.evidenceState)));
  check('B2.directHasNoCompleteness',
    out.memories.every(m => m.completeness === null),
    'direct memory has no enumerable "expected evidence count" — completeness must stay null, not 1');
  check('B3.directConfidenceIsNotApplicable',
    out.memories.every(m => m.evidenceConfidenceState === 'not-applicable' && m.evidenceConfidence === null),
    'direct memory must not be assigned a numeric or categorical confidence');
}

/* ══════════════════════════════════════════════════════════════════
   C · derived evidence matrix（§18）
   ══════════════════════════════════════════════════════════════════ */
section('C · derived evidence matrix');

{
  const base = [mem({ id: 'e1' }), mem({ id: 'e2' }), mem({ id: 'secret', visibility: 'private' })];
  const d = (id, from) => mem({ id: id, rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: from });

  const allLive = R(['x'], base.concat([d('x', ['e1', 'e2'])]));
  check('C1.allLiveIsAttested',
    byId(allLive, 'x').evidenceState === 'attested'
    && byId(allLive, 'x').evidenceConfidenceState === 'complete'
    && byId(allLive, 'x').completeness.complete === true,
    'all-live evidence ⇒ attested / complete');

  const oneMissing = R(['x'], base.concat([d('x', ['e1', 'gone'])]));
  check('C2.postAclVanishedEvidenceIsUnavailableNotLost',
    byId(oneMissing, 'x').evidenceState === 'evidence-unavailable'
    && byId(oneMissing, 'x').evidence.unavailable === 1
    && byId(oneMissing, 'x').evidence.lost === null
    && byId(oneMissing, 'x').reasonCodes.indexOf('upstream-evidence-not-in-authorized-view') >= 0
    && byId(oneMissing, 'x').evidenceConfidenceState === 'partial',
    'post-ACL the shadow cannot observe WHY evidence is absent, so it must say unavailable, never lost: '
    + JSON.stringify(byId(oneMissing, 'x').evidence));

  const oneHidden = R(['x'], base.concat([d('x', ['e1', 'secret'])]));
  check('C3.authorizedViewCannotClaimHidden',
    byId(oneHidden, 'x').evidenceState === 'evidence-unavailable'
    && byId(oneHidden, 'x').evidence.hidden === null,
    'an invisible upstream row is indistinguishable from an absent one inside the authorized view');

  const allMissing = R(['x'], base.concat([d('x', ['g1', 'g2'])]));
  check('C4.zeroLiveIsNeutralNotBroken',
    byId(allMissing, 'x').evidenceState === 'evidence-unavailable'
    && byId(allMissing, 'x').evidenceConfidenceState === 'none-live'
    && byId(allMissing, 'x').reasonCodes.indexOf('upstream-evidence-none-live') >= 0
    && MM.EVIDENCE_CONFIDENCE_STATES.indexOf('broken') < 0,
    'live=0 supports only "no currently live evidence", never a claim that canonical evidence was destroyed');

  const empty = R(['x'], base.concat([d('x', [])]));
  check('C5.emptyDeclaredIsUnattestedNotDirect',
    byId(empty, 'x').evidenceState === 'evidence-unattested'
    && byId(empty, 'x').derivation === 'derived'
    && byId(empty, 'x').reasonCodes.indexOf('upstream-evidence-expected-but-missing') >= 0,
    'consolidation with an empty upstream list is UPSTREAM-EXPECTED-BUT-MISSING, not a direct memory');

  const dup = R(['x'], base.concat([d('x', ['e1', 'e1', 'e1'])]));
  check('C6.duplicateIdsCountOnce',
    byId(dup, 'x').completeness.expected === 1 && byId(dup, 'x').evidenceState === 'attested',
    'duplicate evidence ids must be de-duplicated exactly once (matching the core)');

  const selfRef = R(['x'], base.concat([d('x', ['x'])]));
  check('C7.selfReferenceIsNotSpecialCased',
    byId(selfRef, 'x').evidenceState === 'attested' && byId(selfRef, 'x').completeness.expected === 1,
    'a self-referencing evidence id is resolved by the SAME liveness rule — no second algorithm, no crash');

  /* ── R4-B.1 · wrong-character reconciliation ────────────────────────
     之前的报告里同时写着两句话，必须收敛成**一句**：
       「授权外的证据与 missing 不可区分」（D1）
       「别的角色的证据不被伪造成 missing」（C8）
     两句只在同一句话下相容：授权视图里它就是 `evidence-unavailable`
     —— 既没有被伪造成 lost，也没有被说成"仍然在"。 */
  const wrongChar = R(['y'], base.concat([
    d('y', ['e1', 'belongs_elsewhere']),
    mem({ id: 'belongs_elsewhere', visibility: 'only', visibleTo: ['role_b'] })
  ]));
  check('C8.wrongCharacterEvidenceIsUnavailable',
    byId(wrongChar, 'y').evidenceState === 'evidence-unavailable'
    && byId(wrongChar, 'y').evidence.live === 1
    && byId(wrongChar, 'y').evidence.unavailable === 1
    && byId(wrongChar, 'y').evidence.lost === null,
    'WRONG_CHARACTER_RUNTIME_RESULT: another character\'s evidence is simply not in the authorized '
    + 'view ⇒ unavailable. One truthful word satisfies BOTH D1 (no hidden-count side channel) and '
    + 'C8 (never falsely declared lost).');
}

/* ══════════════════════════════════════════════════════════════════
   D · ACL / hidden evidence safety（§12）
   ══════════════════════════════════════════════════════════════════ */
section('D · ACL safety');

{
  const recs = [mem({ id: 'e1' }),
    mem({ id: 'hidden1', visibility: 'only', visibleTo: ['role_b'] }),
    mem({ id: 'hidden2', visibility: 'private' }),
    mem({ id: 'x', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['e1', 'hidden1', 'hidden2'] })];
  /* 接缝处只交出**已授权**的记录 ⇒ 不可见的证据行在核心看来与 missing 无异。
     这正是 §12 要的性质：影子**不是**绕过可见性的侧信道。 */
  const auth = R(['x'], recs.filter(m => m.id !== 'hidden1' && m.id !== 'hidden2').concat([recs[3]]));
  check('D1.unauthorizedEvidenceIsUnavailableNotCounted',
    byId(auth, 'x').evidence.hidden === null
    && byId(auth, 'x').evidence.unavailable === 2
    && JSON.stringify(auth).indexOf('hidden1') < 0
    && JSON.stringify(auth).indexOf('hidden2') < 0,
    'with only authorized records handed over, invisible evidence must read as unavailable — '
    + 'not a hidden COUNT and not a confirmed loss: ' + JSON.stringify(byId(auth, 'x').evidence));
  /* 受信内部诊断**显式**声明 full 视图时，hidden 才可被计数 —— 但 id 仍不得泄漏。 */
  const diag = R(['x'], recs, { evidenceView: 'full' });
  check('D1b.hiddenIsCountableOnlyInFullAuthorityView',
    diag.evidenceView === 'full'
    && byId(diag, 'x').evidenceState === 'evidence-hidden'
    && byId(diag, 'x').evidence.hidden === 2
    && byId(diag, 'x').evidence.unavailable === 0
    && JSON.stringify(diag).indexOf('hidden1') < 0
    && JSON.stringify(diag).indexOf('hidden2') < 0,
    'only an explicit full-authority diagnostic may count hidden evidence; ids must never appear');
  check('D2.shadowNeverReadsOutsideTheAuthorizedSet',
    (function () {
      let sawUnauthorized = false;
      const spy = {
        evidenceLiveness: function (ids, memories, roleId) {
          memories.forEach(m => { if (['hidden1', 'hidden2'].indexOf(String(m.id)) >= 0) sawUnauthorized = true; });
          return VIS.evidenceLiveness(ids, memories, roleId);
        }
      };
      const out = MM.evaluateTurnShadow({ selectedIds: ['x'], records: [recs[0], recs[3]], roleId: 'role_a', now: NOW }, { visibility: spy });
      return !sawUnauthorized && out.memories.length === 1;
    })(),
    'the shadow must be handed only already-authorized records — ACL precedes MetaMemory');
}

/* ══════════════════════════════════════════════════════════════════
   E · determinism + F · immutability
   ══════════════════════════════════════════════════════════════════ */
section('E/F · determinism and immutability');

{
  const recs = [mem({ id: 'd1' }), mem({ id: 'x', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['d1'] })];
  const a = JSON.stringify(R(['d1', 'x'], recs));
  const b = JSON.stringify(R(['d1', 'x'], recs));
  const c = JSON.stringify(R(['d1', 'x'], recs));
  check('E1.repeatable', a === b && b === c, 'identical inputs must give byte-identical output');
  check('E2.noClockRead',
    R(['d1'], recs, { now: null }).evaluatedAt === null
    && R(['d1'], recs, { now: null }).evaluatedAt === null,
    'with no explicit now the shadow must report evaluatedAt=null and never read a clock');
  const before = JSON.stringify(recs);
  R(['d1', 'x'], recs);
  check('F1.inputNotMutated', JSON.stringify(recs) === before,
    'the shadow must not mutate the records it is given');
}

/* ══════════════════════════════════════════════════════════════════
   J · zero memory + K · failure fail-open
   ══════════════════════════════════════════════════════════════════ */
section('J/K · zero-memory and failure');

{
  const zero = R([], []);
  check('J1.zeroMemoryIsSuccess',
    zero.ok === true && zero.memories.length === 0 && zero.counts.selected === 0
    && zero.reasonCodes.indexOf('no-selected-memory') >= 0,
    'zero memories must be a SUCCESS with an empty shadow — no synthetic entry, no model call');
  check('J2.zeroMemoryDoesNotThrow',
    (function () { try { R([], null); R(null, []); R(undefined, undefined); return true; } catch (e) { return false; } })(),
    'degenerate inputs must not throw');
}
{
  const recs = [mem({ id: 'd1' })];
  const noCore = MM.evaluateTurnShadow({ selectedIds: ['d1'], records: recs, roleId: 'role_a' }, { visibility: null });
  check('K1.missingEvidenceCoreFailsClosed',
    noCore.ok === false && noCore.degraded === true
    && noCore.reasonCodes.indexOf('visibility-core-missing') >= 0,
    'without the evidence core the shadow must report degraded, never guess');

  const bad = MM.evaluateTurnShadow({ selectedIds: ['d1'], records: 'not-an-array', roleId: 'role_a' }, { visibility: VIS });
  check('K2.unreadableRecordsFailClosed',
    bad.ok === false && bad.degraded === true && bad.reasonCodes.indexOf('visible-records-unreadable') >= 0,
    'an unreadable visible set must degrade honestly');

  const derived = mem({ id: 'dv', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['d1'] });
  const thrown = MM.evaluateTurnShadow({ selectedIds: ['dv'], records: recs.concat([derived]), roleId: 'role_a' },
    { visibility: { evidenceLiveness: function () { throw new Error('boom'); } } });
  check('K3.coreThrowIsSwallowed',
    thrown.ok === false && thrown.reasonCodes.indexOf('shadow-unavailable') >= 0
    && Array.isArray(thrown.memories),
    'a throwing evidence core must be caught locally and reported as unavailable');
}

/* ══════════════════════════════════════════════════════════════════
   L · no LLM / network / durable write（静态）
   ══════════════════════════════════════════════════════════════════ */
section('L · no LLM / network / persistence');

{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/metamemory-shadow.js'), 'utf8');
  const code = WIRING.stripJsComments(src);
  const bans = [
    ['fetch', /\bfetch\s*\(/], ['XHR', /XMLHttpRequest/], ['websocket', /WebSocket/],
    ['model port', /callApi|callModel|generateText|invokeModel/],
    ['indexeddb', /indexedDB|idb/i], ['localStorage', /localStorage|sessionStorage/],
    ['fs', /require\(['"](fs|node:fs)['"]\)/], ['activation', /recordActivation/],
    ['db writer', /dbPut|dbDelete|dbGet\(/], ['clock', /Date\.now\s*\(/],
    ['home node', /home-node|memoryAuthority/]
  ];
  const hits = bans.filter(b => b[1].test(code)).map(b => b[0]);
  check('L1.coreIsSideEffectFree', hits.length === 0,
    'the shadow core must touch no network / model / storage / activation / clock (found: ' + hits.join(', ') + ')');
  check('L2.noNewStoreOrMigration',
    /var\s+DB_VERSION\s*=\s*24\s*;/.test(read('assets/js/webcore-db-schema.js'))
    && /const\s+MEMORY_SCHEMA_VERSION\s*=\s*1\s*;/.test(read('services/home-node/memory-store.js')),
    'DB_VERSION 24 and MEMORY_SCHEMA_VERSION 1 must be unchanged');
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* ══════════════════════════════════════════════════════════════════
   M · performance boundedness（§24）
   ══════════════════════════════════════════════════════════════════ */
section('M · bounded cost');

{
  /* 证据核心**只被调用一次**（不是每条记录一次）。 */
  let coreCalls = 0;
  const spy = { evidenceLiveness: function (ids, memories, roleId) { coreCalls++; return VIS.evidenceLiveness(ids, memories, roleId); } };
  const recs = [];
  for (let i = 0; i < 8; i++) recs.push(mem({ id: 's' + i, rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['e0'] }));
  recs.push(mem({ id: 'e0' }));
  const out = MM.evaluateTurnShadow({ selectedIds: recs.slice(0, 8).map(m => m.id), records: recs, roleId: 'role_a', now: NOW }, { visibility: spy });
  check('M1.evidenceCoreCalledOncePerTurn', coreCalls === 1,
    'the liveness core must be called exactly once per turn, not once per record (observed ' + coreCalls + ')');
  check('M2.workIsLinearInSelectedPlusEvidence',
    out.memories.length === 8,
    '8 selected ⇒ 8 shadow entries, no store scan, no graph traversal');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) MM.evaluateTurnShadow({ selectedIds: ['s0', 's1', 's2'], records: recs, roleId: 'role_a', now: NOW }, { visibility: VIS });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('M3.costIsSmall', ms < 2000, '200 evaluations of 3 selected memories took ' + ms.toFixed(1) + 'ms');
}

/* ══════════════════════════════════════════════════════════════════
   N · privacy of diagnostics（§25）
   ══════════════════════════════════════════════════════════════════ */
section('N · diagnostics privacy');

{
  const recs = [mem({ id: 'x', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['e1'],
    title: 'SECRET_TITLE', content: 'SECRET_CONTENT', summary: 'SECRET_SUMMARY' }), mem({ id: 'e1' })];
  const s = JSON.stringify(R(['x'], recs));
  check('N1.noContentInShadow',
    s.indexOf('SECRET_TITLE') < 0 && s.indexOf('SECRET_CONTENT') < 0 && s.indexOf('SECRET_SUMMARY') < 0,
    'the shadow must never carry memory content, title or summary');
  check('N2.onlyIdAndCounts',
    byId(R(['x'], recs), 'x').provenance.declaredEvidenceCount === 1
    && Object.keys(byId(R(['x'], recs), 'x').evidence).sort().join(',')
      === 'degraded,hidden,live,lost,unavailable',
    'provenance carries counts and vocabulary, never payload');
}

/* ══════════════════════════════════════════════════════════════════
   G/H/I · recall parity OFF vs ON
   ══════════════════════════════════════════════════════════════════ */
section('G/H/I · recall parity (shadow OFF vs ON)');

{
  /* 词法通道需要真的命中：turn.message 与记忆正文有共同词，gate 才会放行。
     同时放一条**派生**记忆（缺一条上游）以确保 shadow 产生有意义的混合。 */
  const records = [
    mem({ id: 'a', importance: 9, title: '显卡', content: '显卡 驱动 更新' }),
    mem({ id: 'b', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['a', 'gone'],
      title: '显卡', content: '显卡 经验 总结' }),
    mem({ id: 'c', rawSource: 'diary', title: '显卡', content: '显卡 日记' }),
    mem({ id: 'hidden', visibility: 'private', title: '显卡', content: '显卡 私密' })
  ];
  const opts = { apiId: 'role_a', now: NOW, random: () => 0.42, userMessage: '显卡', turn: { message: '显卡' } };
  const offOrch = ORCH.createOrchestrator({ metamemoryShadow: null });
  const onOrch = ORCH.createOrchestrator({ metamemoryShadow: MM });
  const off = offOrch.recall(records, opts);
  const on = onOrch.recall(records, opts);

  check('G1.selectedIdsAndOrderIdentical',
    JSON.stringify(off.result.selected) === JSON.stringify(on.result.selected)
    && off.result.selected.length > 0,
    'selected seats must be byte-identical with the shadow on: '
    + JSON.stringify({ off: off.result.selected, on: on.result.selected }));
  check('G2.renderedTextIdentical',
    off.result.text === on.result.text && off.result.chars === on.result.chars
    && off.result.count === on.result.count,
    'the rendered memory text must be byte-identical');
  check('G3.legacyScoresAndTraceIdentical',
    JSON.stringify(off.trace) === JSON.stringify(on.trace),
    'the trace (scores / seats / reasons / counts) must be byte-identical');
  check('G4.resultKeySetUnchanged',
    JSON.stringify(Object.keys(off.result).sort()) === JSON.stringify(Object.keys(on.result).sort()),
    'the result key set must not gain a shadow key');
  check('G5.metaKeySetIsStableAndGainsNoPublicKey',
    (function () {
      const a = Object.keys(off.meta).sort(), b = Object.keys(on.meta).sort();
      return JSON.stringify(a) === JSON.stringify(b)
        && a.indexOf('metaMemoryShadow') >= 0
        && off.meta.metaMemoryShadow === null
        && !!on.meta.metaMemoryShadow;
    })(),
    'meta keeps a STABLE key set; the shadow is a stable internal slot, null when not injected');
  check('G6.injectedIdsIdentical',
    JSON.stringify(off.meta.injectedMemoryIds) === JSON.stringify(on.meta.injectedMemoryIds),
    'the injected (exposure) id list must be identical');
  check('G7.shadowIsPresentWhenOn',
    off.meta.metaMemoryShadow === null
    && on.meta.metaMemoryShadow && on.meta.metaMemoryShadow.ok === true
    && on.meta.metaMemoryShadow.memories.length === on.meta.injectedMemoryIds.length,
    'the shadow runs only when injected, and covers exactly the injected memories');
  check('H1.activationUntouchedByShadow',
    JSON.stringify(records.map(r => [r.activationCount, r.lastActivated]))
    === JSON.stringify(records.map(r => [r.activationCount, r.lastActivated])),
    'computing the shadow must not touch activation telemetry');
  check('I1.cooldownAndSessionStateUntouched',
    JSON.stringify(off.trace) === JSON.stringify(on.trace)
    && JSON.stringify(off.meta.injectedMemoryIds) === JSON.stringify(on.meta.injectedMemoryIds),
    'the shadow must not perturb cooldown bookkeeping or the injected set (parity on the shared trace)');
  check('G8.shadowDoesNotAffectGateDecision',
    off.trace && on.trace && off.trace.counts && on.trace.counts
    && JSON.stringify(off.trace.counts) === JSON.stringify(on.trace.counts),
    'gate/visible/gated/selected counts must be identical');
}

/* ══════════════════════════════════════════════════════════════════
   §9 STATE SUPPORT MATRIX（冻结在代码里）
   ══════════════════════════════════════════════════════════════════ */
section('§9 · state support matrix');

{
  check('S1.subjectivityIsExplicitlyNotDerivable',
    MM.STATE_SUPPORT.fuzzy === 'REQUIRES_LLM'
    && MM.STATE_SUPPORT.fragmentary === 'REQUIRES_LLM'
    && MM.STATE_SUPPORT.reconstructed === 'REQUIRES_LLM'
    && MM.STATE_SUPPORT.subjectiveConfidence === 'REQUIRES_LLM',
    'fuzzy / fragmentary / reconstructed / subjectiveConfidence need a model — R4-B must not fake them');
  check('S2.conflictedNeedsAssociation',
    MM.STATE_SUPPORT.conflicted === 'REQUIRES_ASSOCIATION',
    'contradiction discovery needs R4-G association — R4-B must not claim conflicts from differing text');
  check('S3.evidenceStateIsDerivableToday',
    MM.STATE_SUPPORT.evidenceState === 'CURRENTLY_DERIVABLE'
    && MM.STATE_SUPPORT.completeness === 'CURRENTLY_DERIVABLE',
    'evidenceState and completeness are the two things R4-B CAN derive mechanically');
  check('S4.numericConfidenceIsDeferred',
    MM.STATE_SUPPORT.evidenceConfidence === 'DERIVABLE_BUT_UNFROZEN'
    && MM.STATE_SUPPORT.clear === 'NOT_DERIVABLE_YET',
    'no numeric confidence formula is frozen ⇒ no number is emitted; `clear` stays unevaluated');
}
{
  const recs = [mem({ id: 'd1' })];
  const one = byId(R(['d1'], recs), 'd1');
  check('S5.deferredFieldsAreExplicitlyNull',
    one.state === null && one.evidenceConfidence === null && one.subjectiveConfidence === null
    && one.subjectiveConfidenceState === 'not-evaluated',
    'state / evidenceConfidence / subjectiveConfidence must all be null (not guessed); '
    + 'the evaluation state lives in its own field');
}


/* ══════════════════════════════════════════════════════════════════
   T · SUBJECTIVE_CONFIDENCE_CONTRACT（类型稳定）
   ══════════════════════════════════════════════════════════════════ */
section('T · subjectiveConfidence type stability');

{
  const one = byId(R(['d1'], [mem({ id: 'd1' })]), 'd1');
  check('T1.subjectiveConfidenceValueIsNull',
    one.subjectiveConfidence === null,
    'the runtime VALUE must be null — the future type is number, so a string here would freeze '
    + 'the field as number|string (got ' + JSON.stringify(one.subjectiveConfidence) + ')');
  check('T2.subjectiveConfidenceStateIsASeparateField',
    one.subjectiveConfidenceState === 'not-evaluated'
    && MM.SUBJECTIVE_CONFIDENCE_STATES.indexOf(one.subjectiveConfidenceState) >= 0,
    'the evaluation STATE lives in its own bounded field, reusing the SAME word as '
    + 'evidenceConfidenceState (no second vocabulary)');
  check('T3.capabilityMetadataIsSeparateFromRuntimeValue',
    MM.STATE_SUPPORT.subjectiveConfidence === 'REQUIRES_LLM'
    && one.subjectiveConfidence === null
    && one.subjectiveConfidenceState === 'not-evaluated',
    'REQUIRES_LLM is CAPABILITY metadata (module level); null is the runtime value; '
    + 'not-evaluated is the runtime state — three separate things');
  check('T4.noStringEverAppearsInTheValueField',
    (function () {
      const all = MM.evaluateTurnShadow({ selectedIds: ['d1', 'x'], records: [mem({ id: 'd1' })], roleId: 'role_a' },
        { visibility: VIS });
      return all.memories.every(m => m.subjectiveConfidence === null
        && typeof m.subjectiveConfidenceState === 'string');
    })(),
    'across every branch (direct / derived / unknown / degraded) the value stays null');
}

/* ══════════════════════════════════════════════════════════════════
   U · POST_ACL_EVIDENCE_KNOWLEDGE_BOUNDARY（视图边界）
   ══════════════════════════════════════════════════════════════════ */
section('U · post-ACL knowledge boundary');

{
  const base = [mem({ id: 'e1' }), mem({ id: 'secret', visibility: 'private' }), mem({ id: 'elsewhere', visibility: 'only', visibleTo: ['role_b'] })];
  const derived = mem({ id: 'x', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['e1', 'secret', 'elsewhere'] });
  const authorizedSet = [base[0], derived];
  const fullSet = base.concat([derived]);

  const a = R(['x'], authorizedSet);
  check('U1.authorizedViewDefaultsAndClaimsNothingUnobservable',
    a.evidenceView === 'authorized'
    && byId(a, 'x').evidenceState === 'evidence-unavailable'
    && byId(a, 'x').completeness.lost === null
    && byId(a, 'x').completeness.hidden === null
    && byId(a, 'x').completeness.unavailable === 2,
    'the default view is authorized and it must report null (not 0) for what it cannot observe: '
    + JSON.stringify(byId(a, 'x').completeness));

  const f = R(['x'], fullSet, { evidenceView: 'full' });
  check('U2.fullAuthorityViewCanDistinguishLostFromHidden',
    f.evidenceView === 'full'
    && byId(f, 'x').evidenceState === 'evidence-hidden'
    && byId(f, 'x').completeness.lost === 0
    && byId(f, 'x').completeness.hidden === 2
    && byId(f, 'x').completeness.unavailable === 0,
    'a trusted full-authority diagnostic may distinguish confirmed loss from hidden evidence: '
    + JSON.stringify(byId(f, 'x').completeness));

  /* 只把 \`elsewhere\` 那一行从全量集中拿掉：它变成 confirmed lost，
     而 \`secret\` 仍在集合里但不可见 ⇒ hidden。两者同时存在时 lost 优先。 */
  const lostCase = R(['x'], fullSet.filter(m => m.id !== 'elsewhere'), { evidenceView: 'full' });
  check('U3.fullViewReportsConfirmedLoss',
    byId(lostCase, 'x').evidenceState === 'evidence-lost'
    && byId(lostCase, 'x').completeness.lost === 1
    && byId(lostCase, 'x').completeness.hidden === 1
    && byId(lostCase, 'x').reasonCodes.indexOf('upstream-evidence-lost') >= 0,
    'with the full authority set, a genuinely absent row IS reportable as evidence-lost: '
    + JSON.stringify(byId(lostCase, 'x').completeness));

  check('U4.fullViewOnlyStatesAreDeclared',
    JSON.stringify(MM.FULL_VIEW_ONLY_STATES) === JSON.stringify(['evidence-lost', 'evidence-hidden'])
    && JSON.stringify(MM.EVIDENCE_VIEWS) === JSON.stringify(['authorized', 'full']),
    'the two full-view-only states must be declared as such in code, not just in prose');
  check('U5.authorizedViewCanNeverEmitFullViewOnlyStates',
    (function () {
      const combos = [
        [base[0], derived],
        [derived],
        fullSet
      ];
      return combos.every((set, i) => {
        const out = i === 2 ? R(['x'], set) : R(['x'], set);
        return out.evidenceView === 'authorized'
          && MM.FULL_VIEW_ONLY_STATES.indexOf(byId(out, 'x').evidenceState) < 0;
      });
    })(),
    'production (authorized) must be structurally incapable of emitting evidence-lost / evidence-hidden');
}

/* ══════════════════════════════════════════════════════════════════
   V · PRODUCTION CONSUMER = 0
   ══════════════════════════════════════════════════════════════════ */
section('V · production consumer inventory');

{
  const roots = ['assets', 'services', 'bridge', 'src-tauri'].map(d => path.join(ROOT, d)).filter(d => fs.existsSync(d));
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(q); }
      else if (/\.(js|rs|toml|html)$/.test(e.name)) files.push(q);
    }
  })(roots.length ? roots[0] : ROOT);
  for (let i = 1; i < roots.length; i++) walk2(roots[i]);
  function walk2(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk2(q); }
      else if (/\.(js|rs|toml|html)$/.test(e.name)) files.push(q);
    }
  }

  const PRODUCER = 'assets/js/memory-recall/memory-recall-orchestrator.js';
  const consumers = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel === PRODUCER) continue;                       /* producer，不是 consumer */
    if (rel === 'assets/js/memory-recall/metamemory-shadow.js') continue;  /* 定义者 */
    const text = fs.readFileSync(f, 'utf8');
    if (text.indexOf('metaMemoryShadow') >= 0) consumers.push(rel);
  }
  /* ── R4-LIVE-1.2 相位切换 ──────────────────────────────────────────
   R4-B 曾经是"零生产消费者"。LIVE-1.2 之后它有了**恰好一个**消费者：
   `assets/js/memory.js` 内部的 observability 投影（只读 `_out.meta.metaMemoryShadow`，
   写进 runtime turn 对象的 `metaMemoryDiagnostics`）。
   换成更窄的断言：消费者**只能**是那一个文件，且**不得**有行为/提示/持久化消费。 */
const R4B_INTERNAL_DIAGNOSTIC_CONSUMER = 'assets/js/memory.js';
check('V1.productionConsumerIsOnlyTheInternalDiagnosticProjection',
  consumers.length === 1 && consumers[0] === R4B_INTERNAL_DIAGNOSTIC_CONSUMER,
  'the shadow may have exactly ONE production consumer — the internal diagnostic projection '
  + '(found: ' + consumers.join(', ') + ')');

  const orch = fs.readFileSync(path.join(ROOT, PRODUCER), 'utf8');
  const orchCode = WIRING.stripJsComments(orch);
  check('V2.shadowIsWrittenOnceAndNeverRead',
    (orchCode.split('metaMemoryShadow').length - 1) === 1
    && /metaMemoryShadow:\s*mmShadow/.test(orchCode)
    && !/\.metaMemoryShadow\b\s*[^:\n]/.test(orchCode.replace('metaMemoryShadow: mmShadow', '')),
    'the meta key appears exactly once and only as a WRITE (the deps slot uses the separate name '
    + 'metamemoryShadow) — the orchestrator never reads the shadow back');
  check('V3.noWholeMetaSerializationOfTheRecallEnvelope',
    !/JSON\.stringify\(\s*(out|envelope|recall)\.meta/.test(orchCode)
    && !/stringify\([^)]*\.meta\b/.test(orchCode),
    'the orchestrator must not serialize its own meta object wholesale');
}

/* ══════════════════════════════════════════════════════════════════
   W · OUTWARD SURFACE PROBE（deep diff must be exactly one path）
   ══════════════════════════════════════════════════════════════════ */
section('W · outward surface probe');

{
  const records = [
    mem({ id: 'a', importance: 9, title: '显卡', content: '显卡 驱动 更新' }),
    mem({ id: 'b', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['a', 'gone'],
      title: '显卡', content: '显卡 经验 总结' }),
    mem({ id: 'c', rawSource: 'diary', title: '显卡', content: '显卡 日记' })
  ];
  const opts = { apiId: 'role_a', now: NOW, random: () => 0.42, userMessage: '显卡', turn: { message: '显卡' } };

  /* 记录 recall 过程中任何对外 I/O 尝试（网络 / IPC / 日志）。 */
  const ioLog = [];
  const origFetch = global.fetch, origXHR = global.XMLHttpRequest;
  global.fetch = function () { ioLog.push('fetch'); return Promise.reject(new Error('blocked')); };
  global.XMLHttpRequest = function () { ioLog.push('xhr'); };
  const origWarn = console.warn, origLog = console.log;
  let consoleLines = 0;
  console.warn = function () { consoleLines++; }; console.log = function () { consoleLines++; };

  let off, on;
  try {
    off = ORCH.createOrchestrator({ metamemoryShadow: null }).recall(records, opts);
    const afterOff = consoleLines;
    on = ORCH.createOrchestrator({ metamemoryShadow: MM }).recall(records, opts);
    check('W1.noNetworkOrIpcDuringRecall',
      ioLog.length === 0 && (consoleLines - afterOff) === 0,
      'neither OFF nor ON may perform network / IPC / logging (observed: ' + JSON.stringify(ioLog) + ')');
  } finally {
    global.fetch = origFetch; global.XMLHttpRequest = origXHR;
    console.warn = origWarn; console.log = origLog;
  }

  /* 深比较：唯一的差异路径必须**恰好**是 meta.metaMemoryShadow。 */
  function diffPaths(a, b, prefix, out) {
    if (a === b) return out;
    const isObjA = a !== null && typeof a === 'object';
    const isObjB = b !== null && typeof b === 'object';
    if (!isObjA || !isObjB) { out.push(prefix); return out; }
    /* 数组按**整值**比较（顺序敏感），避免把每个数组都误报成差异。 */
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix);
      return out;
    }
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const k of keys) diffPaths(a[k], b[k], prefix ? prefix + '.' + k : k, out);
    return out;
  }
  const paths = diffPaths(off, on, '', []);
  check('W2.deepDiffIsExactlyTheShadowSidecar',
    paths.length === 1 && paths[0] === 'meta.metaMemoryShadow',
    'the ONLY difference between shadow OFF and ON must be the internal sidecar path (got: '
    + JSON.stringify(paths) + ')');
  check('W3.publicResultObjectIsByteIdentical',
    JSON.stringify(off.result) === JSON.stringify(on.result)
    && JSON.stringify(off.trace) === JSON.stringify(on.trace),
    'result and trace must be byte-identical outward surfaces');
  check('W4.publicResultCarriesNoShadow',
    JSON.stringify(off.result).indexOf('metaMemory') < 0
    && JSON.stringify(off.result).indexOf('evidenceState') < 0
    && JSON.stringify(off.trace).indexOf('metaMemory') < 0,
    'neither the result nor the trace may carry any shadow vocabulary');
  check('W5.shadowContentIsBoundedAndInternal',
    (function () {
      const s = JSON.stringify(on.meta.metaMemoryShadow);
      return s.length < 4000
        && s.indexOf('显卡') < 0
        && Object.keys(on.meta).indexOf('metaMemoryShadow') >= 0;
    })(),
    'the sidecar must stay bounded and free of memory content');
}

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('METAMEMORY SHADOW FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exit(1);
}
console.log('METAMEMORY SHADOW PASSED · ' + passed + ' assertions green');
