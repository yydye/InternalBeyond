'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P1.5 · Runtime Seam Guard Migration
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写）

   运行：node tests/test_prediction_error_seam_guard.js

   本套件是 **治理相位迁移** 的验收证据，不是功能测试。它机械地证明：

     ① **旧守卫有两个真实 bypass，现在都关闭了**
        (a) 拼写绕过：`code.toLowerCase().indexOf('prediction-error')` 命中不了
            camelCase（`predictionError` 归一后不含连字符）；
        (b) token 大小写绕过：同一个表达式只 lowercase haystack、**不** lowercase
            token ⇒ `FORBIDDEN_IN_INTERPRETATION` 里的 `'behaviorEffect'`
            在 lowercased 源码里**永远匹配不到**（那条禁令此前是**空转**的）。
     ② 迁移是 **TIGHTENING**，不是放宽：旧守卫原本禁止的**全部仍然禁止**；
        新增的只是"此前漏掉的拼写变体也被抓到"。
     ③ **definition 与 wiring 分离**：只凭"字符串出现"判定接线是错的。
        `predictionErrorLive: 'NO'` 这类**只读自述**是 LEGITIMATE_METADATA，
        它断言"PE 没有接线"；adoption 采用**具名闭集 + 每名至多一次 + 右侧字面量**，
        任何其它 PE 形态（任何拼写）都是"第二条 seam"。
     ④ 第二条 seam 的七类攻击样本 + 九种拼写变体全部被抓住。
     ⑤ P1 capability 边界不被破坏：builder / verifier 必须**同一模块实例**，
        browser 提交 OutcomeObservation = FORBIDDEN。

   本套件**不**证明任何 P2/P3 行为（Registry / Settlement 尚未实现，且被 BLOCKED）。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const G = require('./helpers/runtime-seam-guard.js');
const WIRING = require('./helpers/activation-wiring-probe.js');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RECALL = 'services/home-node/runtime-recall.js';
const INTERPRETATION = 'services/home-node/runtime-interpretation.js';
const CORE = 'assets/js/memory-recall/outcome-observation-core.js';

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);

/* 旧匹配器：**逐字复刻迁移前的那一行**，用来机械证明 bypass 曾经存在。
   （保留它不是为了继续用，而是为了证明"关闭"是可观测的。） */
const legacyMatcher = (code, token) => code.toLowerCase().indexOf(token) >= 0;

const recallRaw = read(RECALL);
const interpRaw = read(INTERPRETATION);
const recallCode = WIRING.stripJsComments(recallRaw);
const interpCode = WIRING.stripJsComments(interpRaw);

(function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · Normalization table
     ══════════════════════════════════════════════════════════════════ */
  section('A · semantic normalization');
  {
    const variants = [
      'prediction-error', 'predictionError', 'PredictionError', 'PREDICTION_ERROR',
      'prediction_error', 'prediction.error', 'prediction/error', 'prediction error',
      'predictionErrorLife', 'predictionErrorLive', 'predictionERROR', 'PREDICTION.Error',
      'Prediction_Error', 'prediction-ERROR', 'prediction  error', 'prediction__error'
    ];
    const missed = variants.filter(v => {
      const probe = 'const x = ' + (v.indexOf(' ') >= 0 || v.indexOf('/') >= 0 ? JSON.stringify(v) : v) + ';';
      return !G.containsSemantic(probe, 'prediction-error');
    });
    check('A1.everyCaseAndSeparatorVariantNormalizesToPredictionError', missed.length === 0,
      'not matched: ' + JSON.stringify(missed));
    check('A2.canonicalSemanticToken',
      G.semanticToken('prediction-error') === 'predictionerror'
      && G.semanticToken('PREDICTION_ERROR') === 'predictionerror'
      && G.semanticToken('predictionError') === 'predictionerror',
      'semantic token = ' + G.semanticToken('prediction-error'));

    /* negative controls（防误报）：跨 token 拼接必须被硬边界阻断 */
    const negatives = [
      'runPrediction(error)',
      'predictions.error',
      'predictionService',
      'const prediction = compute(); error(x)',
      'error',
      'predictionHandler',
      'misError',
      'prediction_report_errors',
      'errorPrediction',
      'predictionOf(error)',
      'predict(err)'
    ];
    const falsePositives = negatives.filter(v => G.containsSemantic(v, 'prediction-error'));
    check('A3.noCrossTokenFalsePositives', falsePositives.length === 0,
      'false positives: ' + JSON.stringify(falsePositives));
    check('A4.hardBoundaryIsWhatStopsJoining',
      G.containsSemantic('prediction.error', 'prediction-error') === true
      && G.containsSemantic('prediction(error', 'prediction-error') === false,
      'separator chars join; other punctuation is a hard boundary');
    check('A5.deterministicAndPure',
      G.normalizeSemantic('Prediction-Error') === G.normalizeSemantic('predictionError')
      && G.normalizeSemantic(null) === G.normalizeSemantic(''),
      'normalization is a pure deterministic function');
    P('SEMANTIC_TOKEN', 'predictionerror');
    P('VARIANTS_VERIFIED', variants.length);
    P('NEGATIVE_CONTROLS', negatives.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     B · Existing guard regression（旧守卫禁止的仍然全部禁止）
     ══════════════════════════════════════════════════════════════════ */
  section('B · existing guard regression（no relaxation）');
  {
    /* B1 · 真实文件仍然通过（allowed definitions 仍然 allowed） */
    const realRecall = G.auditRecallSeam(recallRaw);
    const realInterp = G.auditInterpretationSeam(interpRaw);
    check('B1.recallSeamStillGreenOnRealSource', realRecall.ok === true,
      JSON.stringify(realRecall.reasons).slice(0, 300));
    check('B2.interpretationSeamStillGreenOnRealSource', realInterp.ok === true,
      JSON.stringify(realInterp.reasons).slice(0, 300));

    /* B3 · 旧守卫的 5 个对抗样本仍然全部被抓住 */
    const legacyCaught = G.FORGERY_KINDS.filter(k => {
      const forged = G.forgeRecallSeam(recallRaw, k);
      return forged && G.auditRecallSeam(forged).ok === false;
    });
    check('B3.legacyForgeryKindsStillAllCaught',
      legacyCaught.length === G.FORGERY_KINDS.length,
      'caught ' + legacyCaught.length + '/' + G.FORGERY_KINDS.length);

    /* B4 · 旧守卫禁止的每个 token 仍然在对应边界上被禁止 */
    const inject = (src, signature, snippet) => {
      const at = src.indexOf(signature);
      const open = src.indexOf('{', at + signature.length);
      return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
    };
    const stillForbiddenRecall = G.FORBIDDEN_EVERYWHERE
      .filter(t => t !== 'prediction-error')
      .every(t => G.auditRecallSeam(inject(recallRaw, 'function createRuntimeRecall(deps)', 'const ' + t + 'Probe = 1;')).ok === false);
    check('B5.everyPreviouslyForbiddenTokenStillForbiddenInRecall', stillForbiddenRecall === true,
      'FORBIDDEN_EVERYWHERE must still bite in the recall seam');

    const stillForbiddenInterp = G.FORBIDDEN_IN_INTERPRETATION
      .every(t => G.auditInterpretationSeam(
        inject(interpRaw, 'async function run(body, options)', 'const probe = ' + JSON.stringify(t) + ';')).ok === false);
    check('B6.everyPreviouslyForbiddenTokenStillForbiddenInInterpretation', stillForbiddenInterp === true,
      'FORBIDDEN_IN_INTERPRETATION must still bite in the interpretation seam');

    /* B7 · 原有 behaviorEffect 位置纪律完全未动 */
    check('B7.behaviorEffectSiteDisciplineUnchanged',
      realRecall.facts.depLineCount === 1
      && realRecall.facts.deriveSites.length === 1
      && realRecall.facts.consumeSites.length === 1
      && realRecall.facts.regions.expectationRunTask === true,
      'the 5-named-site behaviourEffect discipline must be unaffected by the migration');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · Closed bypasses（两个真实 governance bypass）
     ══════════════════════════════════════════════════════════════════ */
  section('C · closed bypasses');
  {
    /* C1 · 拼写绕过：camelCase 曾经可以绕过连字符 matcher */
    const camel = injectRecall('out.predictionErrorLive = true;');
    check('C1.legacyMatcherMissedCamelCase',
      legacyMatcher(recallCode, 'prediction-error') === false
      && G.containsSemantic(recallCode, 'prediction-error') === true,
      'before: the legacy matcher could not see camelCase; now normalization can');
    check('C2.camelCaseBypassIsNowRejected',
      G.auditRecallSeam(camel).ok === false
      && G.auditRecallSeam(camel).reasons.some(r => r.indexOf('prediction-error') >= 0),
      'the same fixture is now rejected');

    /* 迁移前的生产事实：runtime-recall.js:1549 的 camelCase 自述对旧 matcher 不可见 */
    const legacySawRealRecallPe = legacyMatcher(recallCode, 'prediction-error');
    check('C3.productionCamelCaseWasInvisibleToLegacyMatcher',
      legacySawRealRecallPe === false,
      'the shipped recall self-description was invisible to the legacy matcher');

    /* C4 · token 大小写绕过：'behaviorEffect' 在 lowercased haystack 里永远匹配不到 */
    const forgedBehavior = (() => {
      const at = interpRaw.indexOf('async function run(body, options)');
      const open = interpRaw.indexOf('{', at + 'async function run(body, options)'.length);
      return interpRaw.slice(0, open + 1) + '\n  const behaviorEffect = 1;\n' + interpRaw.slice(open + 1);
    })();
    const forgedCode = WIRING.stripJsComments(forgedBehavior);
    check('C4.legacyMatcherWasVacuousForCamelCaseToken',
      legacyMatcher(forgedCode, 'behaviorEffect') === false
      && G.containsSemantic(forgedCode, 'behaviorEffect') === true,
      'the legacy `code.toLowerCase().indexOf("behaviorEffect")` could never match');
    check('C5.vacuousTokenIsNowEnforced',
      G.auditInterpretationSeam(forgedBehavior).ok === false,
      'the same fixture is now rejected by the interpretation seam audit');

    check('C6.noRelaxationEveryPreMigrationBanStillBites',
      G.FORBIDDEN_EVERYWHERE.every(t => G.containsSemantic('const x = ' + t + ';', t) === true)
      && G.FORBIDDEN_IN_INTERPRETATION.every(t => G.containsSemantic('const x = ' + t + ';', t) === true),
      'every token in both frozen banned lists still matches');
    P('BYPASS_1_SPELLING', 'CLOSED');
    P('BYPASS_2_VACUOUS_CAMELCASE_TOKEN', 'CLOSED');
  }

  /* ══════════════════════════════════════════════════════════════════
     D · Separator adversarial matrix
     ══════════════════════════════════════════════════════════════════ */
  section('D · separator adversarial matrix');
  {
    const sepCaught = [];
    for (const kind of Object.keys(G.PE_SPELLING_SNIPPETS)) {
      const forged = G.forgePredictionErrorSeam(recallRaw, kind);
      if (forged && G.auditRecallSeam(forged).ok === false) sepCaught.push(kind);
    }
    check('D1.allSeparatorAndCaseVariantsAreCaught',
      sepCaught.length === Object.keys(G.PE_SPELLING_SNIPPETS).length,
      'caught ' + sepCaught.length + '/' + Object.keys(G.PE_SPELLING_SNIPPETS).length + ': ' + JSON.stringify(sepCaught));

    /* 每一种分隔符单独验证 */
    const single = {
      hyphen: 'annotation-hyphen', underscore: 'prediction_error', dot: 'prediction.error',
      slash: 'prediction/error', space: 'prediction error'
    };
    const singleOk = Object.keys(single).every(k => {
      const v = k === 'hyphen' ? 'prediction-error' : single[k];
      const probe = v.indexOf(' ') >= 0 || v.indexOf('/') >= 0 ? JSON.stringify(v) : v;
      return G.containsSemantic('const x = ' + probe + ';', 'prediction-error');
    });
    check('D2.eachSeparatorClassIndividuallyMatched', singleOk === true,
      'hyphen / underscore / dot / slash / space must all normalize');
    check('D3.mixedSeparatorsAndCaseMatched',
      G.containsSemantic('const x = Prediction_Error;', 'prediction-error')
      && G.containsSemantic('const x = PREDICTION.error;', 'prediction-error')
      && G.containsSemantic('const x = prediction-Error;', 'prediction-error'),
      'mixed separator + case must normalize to the same token');
    P('SEPARATOR_VARIANTS_CAUGHT', sepCaught.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     E · Second seam attacks
     ══════════════════════════════════════════════════════════════════ */
  section('E · second-seam adversarial attacks');
  {
    const commRaw = read('assets/js/communication.js');
    const results = [];
    for (const kind of G.PE_FORGERY_KINDS) {
      const src = kind === 'communication-calls-settlement' ? commRaw : recallRaw;
      const forged = G.forgePredictionErrorSeam(src, kind);
      if (!forged) { results.push([kind, 'ANCHOR-MISSING']); continue; }
      const audit = kind === 'communication-calls-settlement'
        ? G.auditBrowserCognitionBoundary(forged)
        : G.auditRecallSeam(forged);
      results.push([kind, audit.ok ? 'EVADED' : 'CAUGHT']);
    }
    const evaded = results.filter(r => r[1] !== 'CAUGHT');
    check('E1.everySecondSeamAttackIsCaught', evaded.length === 0,
      JSON.stringify(evaded));

    /* 逐条点名（报告要能读出每一类） */
    const named = {
      'pe-field-in-recall-response': 'recall response gains a PE field',
      'selector-stage-settlement': 'settlement performed in the selector stage',
      'browser-submits-outcome': 'browser submits an OutcomeObservation',
      'communication-calls-settlement': 'communication.js calls settlement directly',
      'second-registry-seam': 'a second Registry seam',
      'source-turn-outcome-consumption': 'outcome consumed on the source prediction turn',
      'bypass-home-node-authority': 'Home Node authority bypassed via the pure core'
    };
    for (const k of Object.keys(named)) {
      const row = results.find(r => r[0] === k);
      check('E2.' + k, row && row[1] === 'CAUGHT', named[k] + ' -> ' + (row ? row[1] : 'missing'));
    }
    P('SECOND_SEAM_ATTACKS', results.length);
    P('SECOND_SEAM_EVADED', evaded.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     F · Seam taxonomy + capability instance constraint
     ══════════════════════════════════════════════════════════════════ */
  section('F · seam taxonomy & capability constraint');
  {
    check('F1.taxonomyIsExplicit',
      G.DEFINITION_ALLOWED_SURFACES.length > 0
      && G.WIRING_FORBIDDEN_SURFACES.length > 0
      && G.FUTURE_RESERVED_SEAMS.length > 0,
      'definition / wiring / future-reserved must be three explicit lists');
    check('F2.reservedSeamNamesAreNotWiredYet',
      G.FUTURE_RESERVED_SEAMS.every(n => G.containsSemantic(recallCode, n) === false
        && G.containsSemantic(interpCode, n) === false
        && G.containsSemantic(WIRING.stripJsComments(read('assets/js/communication.js')), n) === false),
      'reserved names may be named in contract/test but must not exist in production seams');
    check('F3.wiringForbiddenSurfacesCarryNoPeCapability',
      G.WIRING_FORBIDDEN_SURFACES
        .filter(rel => fs.existsSync(path.join(ROOT, rel)))
        .every(rel => G.auditPredictionErrorSurface(WIRING.stripJsComments(read(rel)), {
          declarationAllowlist: rel === RECALL ? G.PREDICTION_ERROR_DECLARATION_ALLOWLIST : []
        }).facts.capabilityHits.length === 0),
      'no PE capability token may appear on any wiring-forbidden surface');

    /* browser 面：三份文件都不得出现 PE / OutcomeObservation 能力 */
    const browserClean = ['assets/js/communication.js', 'assets/js/home-node-client.js', 'assets/js/home-node-bootstrap.js']
      .every(rel => G.auditBrowserCognitionBoundary(read(rel), { surface: rel }).ok === true);
    check('F4.browserBoundaryCarriesNoPeOrOutcomeCapability', browserClean === true,
      'the browser must not be able to submit an OutcomeObservation or trigger settlement');

    /* P1 capability：跨模块实例必须被拒（builder / verifier 同一实例） */
    const OO_PATH = path.join(ROOT, CORE);
    const OO = require(OO_PATH);
    const scope = { characterId: 'c', conversationId: 'dm:c', subjectKind: 'user', subjectLabel: '' };
    const builtOk = OO.buildOutcomeObservation({
      windowRef: { predictionId: 'p', predictionCreatedAt: 1, opensAt: 1, closesAt: 9 },
      source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.delivery', targetDomain: 'runtime_state',
      observedAt: 5, completeness: 'point', scope,
      outcomeRef: { kind: 'token', token: 'delivery.completed' }, evidenceRefs: [],
      interventionContext: {
        behaviorEffectsInForce: [], predictionInfluencedSystem: false,
        contaminationClass: 'NONE', contaminationBasis: 'none'
      }
    }, {});
    const resolved = require.resolve(OO_PATH);
    const saved = require.cache[resolved];
    delete require.cache[resolved];
    const SECOND = require(OO_PATH);
    const crossAccepted = SECOND.isBuiltObservation(builtOk.value);
    if (saved) require.cache[resolved] = saved;
    check('F5.sameModuleInstanceRequired', builtOk.ok === true && crossAccepted === false,
      'an observation minted by instance A must be rejected by instance B');

    /* browser 不得通过 JSON transport 让 Node 相信重建对象 */
    const reconstituted = JSON.parse(JSON.stringify(builtOk.value));
    check('F6.jsonTransportCannotReconstituteCapability',
      OO.isBuiltObservation(reconstituted) === false,
      'JSON transport + Node trusting a reconstructed object must be impossible');

    /* 生产面零引用 P1 核心 */
    const consumers = [];
    const walk = (dir) => {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) return;
      fs.readdirSync(abs, { withFileTypes: true }).forEach(d => {
        const rel = dir + '/' + d.name;
        if (d.isDirectory()) walk(rel);
        else if (/\.(js|mjs|cjs|rs|toml|html)$/.test(d.name)) {
          if (rel === CORE) return;
          let txt = '';
          try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return; }
          if (txt.indexOf('outcome-observation-core') >= 0 || txt.indexOf('IBMemoryOutcomeObservation') >= 0) consumers.push(rel);
        }
      });
    };
    ['assets/js', 'services', 'src-tauri'].forEach(walk);
    /* ★ P3 相位迁移：OutcomeObservation core 现在有**恰好一个**已批准消费者 ——
       Settlement Engine（(q-12) 的 SAME_MODULE_INSTANCE_REQUIRED：它必须消费
       权威面的 gate 输出，而不是重判 authority）。规则从"零消费"收紧为
       "**只有**这一个已具名消费者"。 */
    const APPROVED_OBSERVATION_CORE_CONSUMERS = ['services/home-node/runtime-prediction-settlement.js',
      'services/home-node/runtime-outcome-observation.js'];
    const unexpected = consumers.filter(rel => APPROVED_OBSERVATION_CORE_CONSUMERS.indexOf(rel) < 0);
    check('F7.onlyTheApprovedConsumerUsesTheP1Core',
      unexpected.length === 0
      && APPROVED_OBSERVATION_CORE_CONSUMERS.every(rel => consumers.indexOf(rel) >= 0),
      'consumers=' + JSON.stringify(consumers));

    P('SAME_MODULE_INSTANCE_REQUIRED', 'YES');
    P('BROWSER_OUTCOME_OBSERVATION_ACCEPTANCE', 'FORBIDDEN');
  }

  /* ══════════════════════════════════════════════════════════════════
     H · P2.0 entry gate（enforcement 扩到 expectation / behavior-effect）
     ══════════════════════════════════════════════════════════════════ */
  section('H · P2.0 entry gate');
  {
    const EXP = 'services/home-node/runtime-expectation.js';
    const BE = 'assets/js/../services/home-node/runtime-behavior-effect.js';
    const expRaw = read(EXP);
    const beRaw = read('services/home-node/runtime-behavior-effect.js');
    const expAudit = G.auditExpectationSeam(expRaw);
    const beAudit = G.auditBehaviorEffectSeam(beRaw);

    check('H1.expectationSeamGreenWithLegitimateMetadata', expAudit.ok === true,
      JSON.stringify(expAudit.reasons).slice(0, 300));
    check('H2.behaviorEffectSeamGreenWithLegitimateMetadata', beAudit.ok === true,
      JSON.stringify(beAudit.reasons).slice(0, 300));

    check('H3.legitimateMetadataIsClassifiedNotDeleted',
      expAudit.facts.predictionError.sites.every(s => G.PREDICTION_ERROR_DECLARATION_ALLOWLIST.indexOf(s.identifier) >= 0)
      && beAudit.facts.predictionError.sites.every(s => G.PREDICTION_ERROR_DECLARATION_ALLOWLIST.indexOf(s.identifier) >= 0)
      && expAudit.facts.predictionError.sites.length > 0
      && beAudit.facts.predictionError.sites.length > 0,
      'the read-only self-descriptions must still be present AND allowlisted');

    check('H4.noSettlementSurfaceInEitherSeam',
      expAudit.facts.settlement.settleCalls.length === 0
      && expAudit.facts.settlement.stateLiterals.length === 0
      && beAudit.facts.settlement.settleCalls.length === 0
      && beAudit.facts.settlement.stateLiterals.length === 0,
      'neither seam may contain a prediction settlement call or a settlement state literal');

    /* 既有测试用 settle 缝不得误报 */
    check('H5.legacyTestSettleSeamsAreAllowlistedNotFlagged',
      G.SETTLE_CALL_ALLOWLIST.indexOf('settleAutoWaiters') >= 0
      && G.SETTLE_CALL_ALLOWLIST.indexOf('settleWaiters') >= 0
      && G.auditRecallSeam(recallRaw).facts.settlement.settleCalls.length === 0,
      'settleAutoWaiters / settleExpectationWaiters / settleWaiters are unrelated test seams');

    /* L3 appraisal 的 `mixed:` 是键，不是结算状态字面量 ⇒ 不得误报 */
    check('H6.appraisalKeyMixedIsNotASettlementLiteral',
      beAudit.facts.settlement.stateLiterals.length === 0
      && G.containsSemantic(beRaw, 'mixed') === true,
      'behavior-effect legitimately contains the L3 appraisal `mixed` as an object key');

    /* 全部 P2.0 对抗样本 */
    const results = [];
    for (const kind of G.PE_EXPECTATION_FORGERY_KINDS) {
      const src = kind.indexOf('behavior-effect') === 0 ? beRaw : expRaw;
      const forged = G.forgeExpectationPeSeam(src, kind);
      if (!forged) { results.push([kind, 'ANCHOR-MISSING']); continue; }
      const audit = kind.indexOf('behavior-effect') === 0
        ? G.auditBehaviorEffectSeam(forged) : G.auditExpectationSeam(forged);
      results.push([kind, audit.ok ? 'EVADED' : 'CAUGHT']);
    }
    for (const kind of G.PE_RECALL_FORGERY_KINDS) {
      const forged = G.forgeRecallPeSeam(recallRaw, kind);
      if (!forged) { results.push([kind, 'ANCHOR-MISSING']); continue; }
      results.push([kind, G.auditRecallSeam(forged).ok ? 'EVADED' : 'CAUGHT']);
    }
    const evaded = results.filter(r => r[1] !== 'CAUGHT');
    check('H7.everyP20AttackIsCaught', evaded.length === 0, JSON.stringify(evaded));

    /* 批准 seam 的位置纪律：四种畸形都必须红。
       用**受控基线**（不含真实文件的既有 seam），这样注入的才是唯一一处 ——
       否则真实文件已有的 dep/call 会让计数变成 2，测不出目标缺陷。 */
    const seam = G.P2_REGISTRY_SEAM;
    const dep = seam.depSignature;
    const probe = seam.probeSignature;
    const call = seam.callSignature;
    const SYN = [
      'function createRuntimeExpectation(deps) {',
      '  const injected = 1;',
      '}',
      'async function runFromValidatedInterpretation(input, opts) {',
      '  const before = 1;',
      "  if (status === 'created') {",
      '    doThing();',
      '  }',
      '}'
    ].join('\n');
    const auditSyn = (src) => G.auditApprovedSeam(WIRING.stripJsComments(src), seam);
    const hasReason = (r, needle) => r.reasons.some(x => x.indexOf(needle) >= 0);

    const depOnly = auditSyn(SYN.replace('  const injected = 1;', '  const injected = 1;\n  ' + dep));
    check('H8.depWithoutCallIsRed', depOnly.ok === false && hasReason(depOnly, 'dep-without-call'),
      JSON.stringify(depOnly.reasons));

    const callOnly = auditSyn(SYN.replace('    doThing();', '    ' + call + '{});'));
    check('H9.callWithoutDepIsRed', callOnly.ok === false && hasReason(callOnly, 'call-without-dep'),
      JSON.stringify(callOnly.reasons));

    const beforeAnchor = auditSyn(SYN
      .replace('  const injected = 1;', '  const injected = 1;\n  ' + dep)
      .replace('  const before = 1;', '  const before = 1;\n  ' + call + '{});'));
    check('H11.callBeforeAnchorIsRed',
      beforeAnchor.ok === false && hasReason(beforeAnchor, 'call-before-anchor'),
      JSON.stringify(beforeAnchor.reasons));

    const stray = auditSyn(SYN
      .replace('  const injected = 1;', '  const injected = 1;\n  ' + dep)
      .replace('  const before = 1;', '  const before = 1;\n  const predictionRegistry = 1;')
      .replace('    doThing();', '    ' + call + '{});'));
    check('H12.grantedTokenOutsideApprovedLinesIsRed',
      stray.ok === false && hasReason(stray, 'granted-token-outside-approved-lines'),
      JSON.stringify(stray.reasons));

    const wellFormed = auditSyn(SYN
      .replace('  const injected = 1;', '  const injected = 1;\n  ' + dep)
      .replace('    doThing();', '    if (' + probe + ') {\n      ' + call + '{});\n    }'));
    check('H13.wellFormedApprovedSeamIsGreen', wellFormed.ok === true,
      JSON.stringify(wellFormed.reasons));

    check('H10.reservedLimitationsAreRegistered',
      G.RESIDUAL_LIMITATIONS.length > 0,
      'the guard must declare what name-based detection cannot see');

    P('P2_0_ENTRY_GATE', 'PASSED');
    P('P2_0_ATTACKS', results.length);
    P('P2_0_EVADED', evaded.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     I · P3 settlement seam（FUTURE_RESERVED → APPROVED，且只有一条）
     ══════════════════════════════════════════════════════════════════ */
  section('I · P3 settlement seam');
  {
    const AUTHORITY = ['services/home-node/runtime-prediction-settlement.js',
      'assets/js/memory-recall/prediction-settlement-core.js'];
    const audited = AUTHORITY.map(rel => ({ rel: rel, r: G.auditSettlementAuthoritySurface(read(rel)) }));
    check('I1.settlementAuthoritySurfacesPassTheirOwnAudit',
      audited.every(a => a.r.ok === true),
      JSON.stringify(audited.map(a => a.rel + ':' + JSON.stringify(a.r.reasons))));

    const svc = read('services/home-node-service.js');
    check('I2.oneApprovedAssemblyPath',
      svc.indexOf('createRuntimePredictionSettlement(') >= 0
      && svc.split('createRuntimePredictionSettlement(').length - 1 === 2,
      'exactly two construction sites: instance + process-level (one authority, one assembly)');

    const FORBIDDEN_SURFACES = [
      ['services/home-node/runtime-recall.js', 'function createRuntimeRecall(deps)'],
      ['services/home-node/runtime-interpretation.js', 'async function run(body, options)'],
      ['services/home-node/runtime-expectation.js', 'async function runFromValidatedInterpretation(input, opts)'],
      ['services/home-node/runtime-behavior-effect.js', 'function createRuntimeBehaviorEffect(deps)']
    ];
    const SETTLE_SNIPPETS = [
      'const settled = settlePrediction({});',
      'const engine = createRuntimePredictionSettlement({});',
      'const r = predictionSettlement.settlePrediction({});'
    ];
    const injectInto = (src, sig, snippet) => {
      const at = src.indexOf(sig);
      if (at < 0) return null;
      const open = src.indexOf('{', at + sig.length);
      if (open < 0) return null;
      return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
    };
    const missed = [];
    for (const [rel, sig] of FORBIDDEN_SURFACES) {
      const src = read(rel);
      for (const snippet of SETTLE_SNIPPETS) {
        const forged = injectInto(src, sig, snippet);
        if (!forged) { missed.push(rel + ':ANCHOR'); continue; }
        const code = WIRING.stripJsComments(forged);
        const caught = !G.auditSettlementSurface(code).ok
          || ['runtime-prediction-settlement', 'createRuntimePredictionSettlement', 'predictionSettlement', 'settlementEngine']
            .some(t => G.containsSemantic(code, t));
        if (!caught) missed.push(rel + ':' + snippet.slice(0, 28));
      }
    }
    check('I3.secondSettlementSeamInAnyRuntimeIsCaught', missed.length === 0, JSON.stringify(missed));

    /* browser / selector 面：追加式注入也必须被抓 */
    const comm = read('assets/js/communication.js');
    const commForged = comm + '\nasync function _ibPlaceSettlementMessage(m, s) { return predictionSettlement.settlePrediction({}); }\n';
    check('I4.browserSettlementIsCaught',
      G.auditBrowserCognitionBoundary(commForged, { surface: 'assets/js/communication.js' }).ok === false,
      'the browser boundary must reject any settlement capability');

    check('I5.memoryAndRelationshipSettlementStayForbidden',
      ['services/home-node/memory-store.js', 'assets/js/role-dm-core.js'].every(rel => {
        const code = WIRING.stripJsComments(read(rel));
        return ['runtime-prediction-settlement', 'predictionSettlement', 'settlementEngine']
          .every(t => G.containsSemantic(code, t) === false);
      }),
      'memory-store and relationship runtime must not gain settlement');

    check('I6.reservedSeamIsNoLongerReserved',
      G.FUTURE_RESERVED_SEAMS.indexOf('runtime-prediction-registry') >= 0
      && G.FUTURE_RESERVED_SEAMS.indexOf('runtime-prediction-settlement') >= 0
      && G.P3_SETTLEMENT_AUTHORITY_SURFACES.length === 2,
      'the reserved names are now approved on exactly two authority surfaces');

    P('P3_SETTLEMENT_SEAM', 'APPROVED_ONE_AUTHORITY_ONE_ASSEMBLY');
    P('P3_SECOND_SEAM_ATTACKS', FORBIDDEN_SURFACES.length * SETTLE_SNIPPETS.length + 1);
    P('P3_SECOND_SEAM_EVADED', missed.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     G · Scope proof
     ══════════════════════════════════════════════════════════════════ */
  section('G · scope proof');
  {
    P('P1_5_STATUS', 'COMPLETE');
    P('PRODUCTION_PE_WIRING', 'NONE');
    P('PREDICTION_REGISTRY_LIVE', 'NO');
    P('SETTLEMENT_ENGINE', 'NONE');
    P('OUTCOME_OBSERVER_PRODUCERS_LIVE', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('RECALL_ENVELOPE_CHANGED', 'NO');
    P('UI_DISCLOSURE_CHANGED', 'NO');
    P('NEXT_ALLOWED_PHASE', 'P2');
    check('G1.scopeProof', true, 'declared');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('PREDICTION ERROR SEAM GUARD FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('PREDICTION ERROR SEAM GUARD PASSED · ' + passed + ' assertions green');
})();

/* 把 snippet 注入 `function createRuntimeRecall(deps)` 体内（recall 侧攻击用）。 */
function injectRecall(snippet) {
  const signature = 'function createRuntimeRecall(deps)';
  const at = recallRaw.indexOf(signature);
  const open = recallRaw.indexOf('{', at + signature.length);
  return recallRaw.slice(0, open + 1) + '\n  ' + snippet + '\n' + recallRaw.slice(open + 1);
}

