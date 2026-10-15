'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-C · RealityEvent Backbone
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写）

   运行：node tests/test_reality_event_backbone.js

   REALITY_EVENT != OUTCOME_OBSERVATION
   REALITY_EVENT_IDENTITY_INDEPENDENT_OF_PREDICTION = YES
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RE_REL = 'services/home-node/runtime-reality-event.js';
const OBS_REL = 'services/home-node/runtime-outcome-observation.js';
const WIRING = require('./helpers/activation-wiring-probe.js');
const G = require('./helpers/runtime-seam-guard.js');
const REMOD = require(path.join(ROOT, RE_REL));
const { createRuntimeRealityEvent, REALITY_SOURCES, ALLOWED_REALITY_SOURCE_CLASSES } = REMOD;
const OBSMOD = require(path.join(ROOT, OBS_REL));
const { createRuntimeOutcomeObservation } = OBSMOD;
const DOMAIN_EVENT = require(path.join(ROOT, 'assets/js/domain-event-core.js'));
const { createRuntimeBehaviorEffect } = require(path.join(ROOT, 'services/home-node/runtime-behavior-effect.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
let CLOCK = T0;
function be(over) { CLOCK = T0; return createRuntimeBehaviorEffect(Object.assign({ clock: () => CLOCK, logger: () => {} }, over || {})); }
function reality(over) { return createRuntimeRealityEvent(over || {}); }
function projection(re, over) {
  return createRuntimeOutcomeObservation(Object.assign({ isRealityEvent: re.isRealityEvent }, over || {}));
}
function delivery(over) {
  return Object.assign({
    eventId: 'runtime:delivery:42', domain: 'delivery', type: 'completed',
    entityId: 'job_42', timestamp: T0 + 1000, characterId: 'char_A', conversationId: 'dm:cA'
  }, over || {});
}
function ref(pid, opensAt, closesAt) {
  return { predictionId: pid, opensAt: opensAt, closesAt: closesAt, predictionCreatedAt: opensAt };
}

(function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · domain-event-core 复用（不另造 schema）
     ══════════════════════════════════════════════════════════════════ */
  section('A · domain-event backbone reuse');
  {
    check('A1.schemaIsReusedNotDuplicated',
      read(RE_REL).indexOf("domain-event-core.js") >= 0
      && read(RE_REL).indexOf('createDomainEvent') >= 0
      && read(RE_REL).indexOf('dedupeKeyFor') >= 0,
      '复用既有 canonical schema，不另造第二套 event schema');
    check('A2.schemaCoreIsNodeCapableAndInjectedTime',
      typeof DOMAIN_EVENT.createDomainEvent === 'function'
      && WIRING.stripJsComments(read('assets/js/domain-event-core.js')).indexOf('Date.now') < 0,
      'domain-event-core 明确不读 Date.now，timestamp 由调用方注入');
    check('A3.realityEventVersionIsPinned',
      reality().describe().realityEventVersion === DOMAIN_EVENT.DOMAIN_EVENT_VERSION
      && reality().describe().schemaAuthority === 'assets/js/domain-event-core.js',
      reality().describe().realityEventVersion);
  }

  /* ══════════════════════════════════════════════════════════════════
     B · RealityEvent identity 独立于 Prediction
     ══════════════════════════════════════════════════════════════════ */
  section('B · reality identity independence');
  {
    const re = reality();
    const ev = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery() }).realityEvent;
    check('B1.realityEventIsMintedAndSealed',
      re.isRealityEvent(ev) === true
      && ev.realityEventId === 'runtime:delivery:42'
      && ev.occurredAt === T0 + 1000
      && ev.source === 'CANONICAL_RUNTIME',
      JSON.stringify({ id: ev.realityEventId, at: ev.occurredAt }));
    check('B2.identityContainsNoPredictionId',
      Object.prototype.hasOwnProperty.call(ev, 'predictionId') === false
      && String(ev.realityEventId).indexOf('pred') < 0
      && Object.keys(ev).indexOf('predictionId') < 0
      /* 运行时**主动拒绝**事件里的 predictionId（这是守卫，不是 identity 成分） */
      && re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery({ predictionId: 'P1' }) }).reasonCode
        === 'reality-event-body-carries-authority-field',
      '★ REALITY_EVENT_IDENTITY_INDEPENDENT_OF_PREDICTION = YES');
    check('B3.identityIndependentOfPairing', (function () {
      /* pairing 到 P1 / P2 不改变 RealityEvent identity */
      const p = projection(re);
      p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P1', T0, T0 + 1e6) });
      p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P2', T0, T0 + 1e6) });
      return ev.realityEventId === 'runtime:delivery:42' && re.heldEventCount() === 1;
    })(), 'pairing 不改变现实事实 identity');
    check('B4.noClockOrRandomInRealityIdentity',
      WIRING.stripJsComments(read(RE_REL)).indexOf('Math.random') < 0
      && WIRING.stripJsComments(read(RE_REL)).indexOf('Date.now') < 0
      && !/let\s+counter|var\s+counter|globalCounter/.test(WIRING.stripJsComments(read(RE_REL))),
      'identity 由 domain-event-core 确定性派生');
    check('B5.forgedRealityEventRejected',
      re.isRealityEvent({ realityEventId: 'x', domain: 'delivery', type: 'completed', entityId: 'e', occurredAt: 1, realitySourceId: 's' }) === false
      && re.isRealityEvent(JSON.parse(JSON.stringify(ev))) === false
      && re.isRealityEvent(Object.assign({}, ev)) === false
      && re.isRealityEvent({ brand: REMOD.RE_BRAND, realityEventId: 'x' }) === false,
      'plain / JSON clone / Object.assign clone / copied brand 全部 invalid');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · projection identity / lineage
     ══════════════════════════════════════════════════════════════════ */
  section('C · projection identity & lineage');
  {
    const re = reality();
    const ev = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery() }).realityEvent;
    const p = projection(re);
    const o1 = p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P1', T0, T0 + 1e6) });
    const o2 = p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P2', T0, T0 + 1e6) });
    check('C1.oneEventTwoPredictionsTwoProjections',
      o1.ok === true && o2.ok === true
      && o1.observation.observationId !== o2.observation.observationId
      && o1.projectionId !== o2.projectionId,
      JSON.stringify({ a: o1.projectionId, b: o2.projectionId }));
    check('C2.bothProjectionsShareTheSameRealityRef',
      o1.realityEventRef === ev.realityEventId && o2.realityEventRef === ev.realityEventId
      && p.realityEventRefOf(o1.observation) === ev.realityEventId
      && p.realityEventRefOf(o2.observation) === ev.realityEventId,
      'lineage 机械可验证（evidenceRefs[0] = realityEventId）');
    check('C3.projectionIdentityExplicitlyScoped',
      p.describe().outcomeObservationRole === 'PREDICTION_SCOPED_REALITY_PROJECTION'
      && p.describe().requiresSealedRealityEvent === 'YES'
      && p.describe().observationIdentityContainsPredictionId === 'YES'
      && p.describe().realityEventIdentityContainsPredictionId === 'NO',
      'Obs identity 含 predictionId；RealityEvent identity 不含');
    check('C4.projectionIdIsDeterministic', (function () {
      const a = OBSMOD.projectionIdOf('E1', 'P1');
      const b = OBSMOD.projectionIdOf('E1', 'P1');
      const c = OBSMOD.projectionIdOf('E1', 'P2');
      const d = OBSMOD.projectionIdOf('E2', 'P1');
      return a === b && a !== c && a !== d;
    })(), 'projection id = f(realityEventId, predictionId, version)');
    check('C5.unsealedRealityEventCannotProject',
      p.projectForPrediction({ realityEvent: { realityEventId: 'x' }, predictionRef: ref('P1', T0, T0 + 1e9) }).reasonCode
        === 'reality-event-not-sealed-authoritative',
      'schema-valid != authoritative');
    check('C6.tokenDerivedFromRealityDomainAndType',
      o1.observation.outcomeRef.token === 'delivery.completed'
      && o1.observation.observedAt === T0 + 1000
      && o1.observation.source === 'CANONICAL_RUNTIME',
      JSON.stringify({ token: o1.observation.outcomeRef.token }));
  }

  /* ══════════════════════════════════════════════════════════════════
     D · idempotency
     ══════════════════════════════════════════════════════════════════ */
  section('D · idempotency');
  {
    const re = reality();
    const p = projection(re);
    let minted = 0, dups = 0, ev = null;
    for (let i = 0; i < 100; i += 1) {
      const r = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery() });
      if (r.status === 'minted') minted += 1; else dups += 1;
      ev = r.realityEvent;
    }
    check('D1.hundredReplaysMintOneRealityEvent',
      minted === 1 && dups === 99 && re.heldEventCount() === 1,
      JSON.stringify({ minted: minted, dups: dups }));
    let projMinted = 0, projDups = 0, observations = new Set();
    for (let i = 0; i < 100; i += 1) {
      const a = p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P1', T0, T0 + 1e6) });
      const b = p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P2', T0, T0 + 1e6) });
      if (a.status === 'minted') projMinted += 1;
      if (b.status === 'minted') projMinted += 1;
      if (a.status === 'duplicate') projDups += 1;
      if (b.status === 'duplicate') projDups += 1;
      observations.add(a.observation.observationId);
      observations.add(b.observation.observationId);
    }
    check('D2.projectionCountIsPairsNotReplays',
      projMinted === 2 && observations.size === 2,
      JSON.stringify({ projected: projMinted, distinct: observations.size }));
    check('D3.settlementNotDuplicated', (function () {
      const auth = be();   /* known-none ⇒ contamination NONE ⇒ 才可能 decisive */
      const reg = createRuntimePredictionRegistry({ clock: () => T0 });
      const pred = reg.projectFromValidatedExpectation({
        epistemicStatus: 'prediction', prediction: '投递会被取消',
        trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
        contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
        subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
        predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'exclusive-outcome', token: 'delivery.cancelled' }
      }, { now: T0, characterId: 'char_A', conversationId: 'dm:cA', turnId: 'd3', expectationIndex: 0 }).record;
      const re2 = reality();
      const ev2 = re2.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery({ eventId: 'runtime:delivery:99', type: 'cancelled', entityId: 'job_99' }) }).realityEvent;
      /* known-none ⇒ contamination NONE ⇒ 才可能 decisive（否则 UNKNOWN 会把它压成 pending） */
      const p2 = projection(re2, { attributionAuthority: auth });
      const pr = p2.projectForPrediction({
        realityEvent: ev2,
        predictionRef: ref(pred.predictionId, pred.observationWindow.opensAt, pred.observationWindow.closesAt)
      });
      const s = createRuntimePredictionSettlement({ clock: () => T0 });
      const first = s.settlePrediction(pred, [{ observation: pr.observation }], {
        now: T0 + 5000
      });
      const again = s.settlePrediction(pred, [{ observation: pr.observation }], {
        now: T0 + 6000
      });
      return first.settlement.state === 'matched' && again.status === 'already-settled' && s.heldCount() === 1;
    })(), 'reality 层幂等 ⇒ Settlement 不重复计数');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · zero-pair / multi-pair
     ══════════════════════════════════════════════════════════════════ */
  section('E · pairing cardinality');
  {
    const re = reality();
    const p = projection(re);
    const ev = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery() }).realityEvent;
    check('E1.zeroPairEventIsLegal',
      re.isRealityEvent(ev) === true && p.describe().requiresSealedRealityEvent === 'YES'
      && re.heldEventCount() === 1,
      'REALITY_EVENT_EXISTENCE_DOES_NOT_REQUIRE_PREDICTION_PAIR = YES');
    check('E2.zeroPairCreatesNoObservation', (function () {
      const before = p.describe().counters.projected;
      void p.projectForPrediction({ realityEvent: ev });   /* 没有 predictionRef */
      return p.describe().counters.projected === before;
    })(), '没有候选 Prediction ⇒ 不创建 projection，但事件仍然成立');
    check('E3.multiPairCreatesOneEventAndThreeProjections', (function () {
      const l = projection(re);
      const ids = ['P1', 'P2', 'P3'].map(pid => l.projectForPrediction({ realityEvent: ev, predictionRef: ref(pid, T0, T0 + 1e6) }));
      return ids.every(r => r.ok === true)
        && new Set(ids.map(r => r.realityEventRef)).size === 1
        && new Set(ids.map(r => r.observation.observationId)).size === 3
        && re.heldEventCount() === 1;
    })(), 'one RealityEvent · three projections');
  }

  /* ══════════════════════════════════════════════════════════════════
     F · 时间模型 / 归因层
     ══════════════════════════════════════════════════════════════════ */
  section('F · time & attribution');
  {
    check('F1.attributionQueriesAtRealityEventTime', (function () {
      const auth = be();
      CLOCK = T0 + 1000;
      auth.deriveAndHold({
        characterId: 'char_A', conversationId: 'dm:cA', turnId: 'T1', interpretationValidated: true,
        interpretationResult: { ok: true, status: 'succeeded', recordSource: 'S', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] } },
        expectationHeld: true, expectation: { ok: true, status: 'created' }
      });
      CLOCK = T0 + 9000;                                     /* 处理在很久以后 */
      const re = reality();
      const p = projection(re, { attributionAuthority: auth });
      const ev = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery({ timestamp: T0 + 2000 }) }).realityEvent;
      const pr = p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P1', T0, T0 + 1e6) });
      return pr.ok === true && pr.attribution.at === T0 + 2000 && pr.attribution.status === 'known-present';
    })(), '★ 归因 @ RealityEvent.occurredAt，不是处理时间');
    check('F2.observationObservedAtIsRealityTime',
      (function () {
        const re = reality();
        const p = projection(re);
        CLOCK = T0 + 9000;
        const ev = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery({ timestamp: T0 + 1234 }) }).realityEvent;
        const pr = p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P1', T0, T0 + 1e6) });
        return pr.observation.observedAt === T0 + 1234;
      })(), 'observedAt = RealityEvent.occurredAt');
    check('F3.historicalFloorStillMintsButFailsClosed', (function () {
      const auth = be();
      CLOCK = T0 + 1000;
      auth.deriveAndHold({
        characterId: 'char_A', conversationId: 'dm:cA', turnId: 'T1', interpretationValidated: true,
        interpretationResult: { ok: true, status: 'succeeded', recordSource: 'S', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] } },
        expectationHeld: true, expectation: { ok: true, status: 'created' }
      });
      const re = reality();
      const p = projection(re, { attributionAuthority: auth });
      const ev = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery({ eventId: 'e:old', timestamp: T0 - 5000 }) }).realityEvent;
      const pr = p.projectForPrediction({ realityEvent: ev, predictionRef: ref('P1', T0 - 6000, T0 + 1e6) });
      return pr.ok === true && pr.attribution.status === 'unknown' && pr.observation !== null;
    })(), '早于 coverageFloor：事件成立、projection 仍然铸造、归因 unknown');
    check('F4.attributionNotInRealityEvent', (function () {
      /* RealityEvent 只承载事实：评价字段仅出现在**禁止键表**（声名它们非法）里 */
      const code = WIRING.stripJsComments(read(RE_REL)).replace(/FORBIDDEN_BODY_KEYS[\s\S]*?\]/, '');
      return code.indexOf('contaminationClass') < 0
        && code.indexOf('admissibility') < 0
        && code.indexOf('settlementState') < 0;
    })(), 'RealityEvent 只承载事实，不含评价上下文');
    check('F5.causationDoesNotImplyInfluence', (function () {
      const re = reality();
      const ev = re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery({ eventId: 'e:caus', causationId: 'pred_x' }) }).realityEvent;
      return ev.causationId === 'pred_x'
        && read(RE_REL).indexOf('predictionInfluencedSystem') < 0;
    })(), 'causationId 只是 fact，不是 contamination authority');
  }

  /* ══════════════════════════════════════════════════════════════════
     G · authority / laundering
     ══════════════════════════════════════════════════════════════════ */
  section('G · authority & laundering');
  {
    const re = reality();
    check('G1.browserSourceNotRegistered',
      re.ingest({ sourceId: 'browser', sourceEvent: delivery() }).reasonCode === 'reality-source-not-registered'
      && re.describe().browserDomainEventIsAuthoritative === 'NO',
      'BROWSER_DOMAIN_EVENT != AUTHORITATIVE_REALITY_EVENT');
    check('G2.schemaValidBrowserEventGetsNoSeal', (function () {
      const browserEvent = DOMAIN_EVENT.createDomainEvent({
        eventId: 'browser:1', domain: 'delivery', type: 'completed', entityId: 'e', timestamp: T0
      });
      return browserEvent.ok === true && re.isRealityEvent(browserEvent.event) === false;
    })(), 'browser 可以构造 schema-valid event，但拿不到 authority seal');
    check('G3.authorityFieldsInBodyRefused', (function () {
      const bad = ['relation', 'settlementState', 'predictionType', 'calibrationCounted'];
      return bad.every(f => {
        const ev = delivery({ body: { [f]: 'x' } });
        return re.ingest({ sourceId: 'runtime-delivery', sourceEvent: ev }).reasonCode
          === 'reality-event-body-carries-authority-field';
      });
    })(), 'payload 越权字段一律拒绝');
    check('G4.predictionIdRefusedInsideRealityEvent',
      re.ingest({ sourceId: 'runtime-delivery', sourceEvent: delivery({ predictionId: 'P1' }) }).reasonCode
        === 'reality-event-body-carries-authority-field',
      'RealityEvent 不接受 predictionId');
    check('G5.directLinkageIsAFactNotIdentity',
      /sourcePredictionId|causationId/.test(read(RE_REL))
      && read(RE_REL).indexOf("realityEventId: canonical.eventId") >= 0,
      'identity 只用 canonical eventId；linkage 只是可选 fact');
    check('G6.noModelInferenceSource',
      Object.keys(REALITY_SOURCES).every(k => REALITY_SOURCES[k].source !== 'MODEL_INFERENCE')
      && Object.keys(REALITY_SOURCES).every(k => REALITY_SOURCES[k].source !== 'LINGUISTIC_EVIDENCE')
      && Object.keys(REALITY_SOURCES).every(k => REALITY_SOURCES[k].source !== 'USER_BEHAVIOR')
      /* ★ P5-B3-E-R1 翻面：本相位**第一次**批准了一个 EXPLICIT_USER_REPORT 源
         （用户显式结构化报告动作），因为 explicitness authority 现在有了真实
         载体（DEDICATED_STRUCTURED_USER_REPORT_ACTION）。
         ★ 未被放宽的是**性质**：语言证据 / 模型推断 / 用户行为**仍然**结构性
         不得铸造现实；自由文本永远没有 producer。 */
      && Object.keys(REALITY_SOURCES).filter(k => REALITY_SOURCES[k].source === 'EXPLICIT_USER_REPORT')
        .every(k => k === 'user-explicit-preference-report'),
      'MODEL_INFERENCE / LINGUISTIC_EVIDENCE / USER_BEHAVIOR 都不在表里；EXPLICIT_USER_REPORT 只有一条具名源');
    check('G7.sourceProvenanceSurvivesProjection', (function () {
      const l = projection(re);
      const ev = re.ingest({ sourceId: 'runtime-activity', sourceEvent: { eventId: 'activity:1', domain: 'activity', type: 'available', entityId: 'act_1', timestamp: T0 + 1, characterId: 'char_A', conversationId: 'dm:cA' } }).realityEvent;
      const pr = l.projectForPrediction({ realityEvent: ev, predictionRef: ref('P1', T0, T0 + 1e6), targetDomain: 'runtime_state' });
      return pr.ok === true && pr.observation.source === 'CANONICAL_RUNTIME';
    })(), 'source provenance 穿过 RealityEvent 不升级');
  }

  /* ══════════════════════════════════════════════════════════════════
     H · live production caller（不是 test-only seam）
     ══════════════════════════════════════════════════════════════════ */
  section('H · production caller');
  {
    check('H1.productionCallerExists', (function () {
      /* 必须存在**非测试**的生产调用点。审计结论见报告 §G。 */
      const files = ['services/home-node/runtime-recall.js', 'services/home-node/mobile-gateway.js',
        'services/home-node/http.js', 'services/home-node-service.js', 'services/home-node/economy-command-channel.js'];
      const hits = files.filter(f => {
        try { return read(f).indexOf('runtimeRealityEvent') >= 0 || read(f).indexOf('realityEvent.ingest') >= 0; }
        catch (e) { return false; }
      });
      /* P5-B3-D4 阶段迁移：production caller **已**存在 —— home-node-service.js
         经 buildTurnTerminalSink 在两个 live executor construction 注入 canonical
         terminal sink。此前"无生产 caller"的断言必须翻面（不能继续断言 0）。 */
      const svc = read('services/home-node-service.js');
      const wired = (svc.match(/onTurnTerminal: buildTurnTerminalSink\(/g) || []).length;
      return wired === 2 && svc.indexOf('createRuntimeRealityEvent') >= 0;
    })(), 'REALITY_EVENT_SOURCE_LIVE = YES（两个 live construction 都注入 canonical terminal sink）');
    check('H2.sourceTableIsStaticAndAuthoritative',
      /* ★ P5-B3-E-R1 翻面：类目从"只有 CANONICAL_RUNTIME"变成**冻结闭集**
         { CANONICAL_RUNTIME, EXPLICIT_USER_REPORT } —— 仍无 dynamic 注册，
         仍无 wildcard，每条 source 的 domain/type/body 仍被逐条钉死。 */
      Object.keys(REALITY_SOURCES).every(k => ALLOWED_REALITY_SOURCE_CLASSES.indexOf(REALITY_SOURCES[k].source) >= 0)
      && ALLOWED_REALITY_SOURCE_CLASSES.length === 2
      && ALLOWED_REALITY_SOURCE_CLASSES.indexOf('LINGUISTIC_EVIDENCE') < 0
      && ALLOWED_REALITY_SOURCE_CLASSES.indexOf('MODEL_INFERENCE') < 0
      && ALLOWED_REALITY_SOURCE_CLASSES.indexOf('USER_BEHAVIOR') < 0
      && WIRING.stripJsComments(read(RE_REL)).indexOf('function register') < 0
      && WIRING.stripJsComments(read(RE_REL)).indexOf('.register(') < 0,
      'source class 是冻结闭集；无动态注册');
  }

  /* ══════════════════════════════════════════════════════════════════
     I · guard
     ══════════════════════════════════════════════════════════════════ */
  section('I · guard');
  {
    const TOK = ['runtime-reality-event', 'createRuntimeRealityEvent', 'realityEvent'];
    const OTHERS = [
      'services/home-node/runtime-evidence-matcher.js', 'services/home-node/runtime-prediction-calibration.js',
      'services/home-node/runtime-behavior-effect.js', 'services/home-node/memory-store.js',
      'assets/js/role-dm-core.js', 'assets/js/communication.js'
    ];
    const leaky = OTHERS.filter(rel => {
      const code = WIRING.stripJsComments(read(rel));
      return TOK.some(t => G.containsSemantic(code, t));
    });
    check('I1.noForbiddenSurfaceCanMintReality', leaky.length === 0, JSON.stringify(leaky));
    check('I2.browserCannotMintRealityEvent', (function () {
      const comm = read('assets/js/communication.js')
        + '\nasync function _ibReality(e) { return runtimeRealityEvent.ingest(e); }\n';
      return G.auditBrowserCognitionBoundary(comm, { surface: 'assets/js/communication.js' }).ok === false;
    })(), 'browser 不得 mint authoritative reality');
    check('I3.noNewSeamPair',
      G.P3_SETTLEMENT_AUTHORITY_SURFACES.length === 2
      && G.P4_CALIBRATION_AUTHORITY_SURFACES.length === 2
      && G.P5_MATCHER_AUTHORITY_SURFACES.length === 2,
      '不新增跨模块 seam 对');
    check('I4.zeroModelCallsZeroDurableWrites',
      reality().describe().modelCalls === 0 && reality().describe().durableWrites === 0
      && projection(reality()).describe().modelCalls === 0,
      'MODEL_CALLS_ADDED = 0 · DURABLE_WRITES_ADDED = 0');
    check('I5.noDurableEventStore',
      (function () {
        const code = WIRING.stripJsComments(read(RE_REL) + read(OBS_REL));
        return !/indexedDB|localStorage|writeFile|dbPut|sqlite/i.test(code);
      })() && reality().describe().lifetime === 'SESSION_ONLY',
      'REALITY_EVENT lifetime = SESSION_ONLY');
  }

  /* ══════════════════════════════════════════════════════════════════
     J · readiness vocabulary
     ══════════════════════════════════════════════════════════════════ */
  section('J · readiness');
  {
    P('P5_B3_C_STATUS', 'COMPLETE');
    P('REALITY_EVENT_IDENTITY_INDEPENDENT_OF_PREDICTION', 'YES');
    P('OUTCOME_OBSERVATION_ROLE', 'PREDICTION_SCOPED_REALITY_PROJECTION');
    P('REALITY_EVENT_MINT_CAPABILITY_LIVE', 'YES');
    P('REALITY_EVENT_SOURCE_LIVE', 'NO');
    P('OUTCOME_OBSERVATION_MINT_CAPABILITY_LIVE', 'YES');
    P('OUTCOME_OBSERVATION_PRODUCTION_CALLER_LIVE', 'NO');
    P('MECHANICAL_FEEDBACK_LOOP_IMPLEMENTATION_READY', 'YES');
    P('MECHANICAL_FEEDBACK_LOOP_PRODUCTION_LIVE', 'NO');
    P('SUBJECTIVE_FEEDBACK_LOOP_PRODUCTION_LIVE', 'NO');
    P('FULL_PREDICTION_ERROR_PRODUCTION_LOOP_READY', 'NO');
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('MATCHER_DEFAULT_CHANGED', 'NO');
    P('EXPLICIT_USER_REPORT_PRODUCER', 'LIVE_CAPABLE（P5-B3-E-R1：唯一具名源 user-explicit-preference-report）');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('REALITY EVENT BACKBONE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('REALITY EVENT BACKBONE PASSED · ' + passed + ' assertions green');
})();


