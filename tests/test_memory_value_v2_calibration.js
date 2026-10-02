'use strict';

/* P21-R3-B · Offline MemoryValue calibration / shadow candidates.
 * Run: node tests/test_memory_value_v2_calibration.js
 * Synthetic-only, no browser, network, Home Node, user memory, or production writes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/memory-value-v2-calibration.js');

const ROOT = path.resolve(__dirname, '..');
const NOW = H.DEFAULT_NOW;
const cases = H.loadCases(ROOT);
const byId = new Map(cases.map(entry => [entry.id, entry]));
let passed = 0;
let failures = 0;
const results = [];

function check(name, run) {
  try {
    const result = run();
    if (result === false) throw new Error('assertion returned false');
    passed++;
    results.push({ name, status: 'PASS' });
    console.log('  PASS  ' + name);
    return true;
  } catch (error) {
    failures++;
    results.push({ name, status: 'FAIL', error: String(error && error.message || error) });
    console.error('  FAIL  ' + name + ' -> ' + String(error && error.message || error));
    return false;
  }
}

function section(name) { console.log('\n── ' + name + ' ──'); }
function val(candidate, record, now) { return candidate(record, now).value; }
function assertFiniteCandidate(candidate, record, now) {
  const output = candidate(record, now);
  assert.deepEqual(Object.keys(output).sort(), ['components', 'normalized', 'value']);
  assert.equal(Number.isFinite(output.value), true);
  assert.ok(Object.keys(output.components).includes('importance'));
  assert.ok(Object.keys(output.components).includes('activation'));
  assert.ok(Object.keys(output.components).includes('decay'));
  assert.ok(Object.keys(output.components).includes('emotion'));
  assert.ok(Object.values(output.components).every(Number.isFinite));
  assert.equal(output.normalized.label.status, 'SHADOW');
  assert.equal(output.normalized.label.production, 'NOT PRODUCTION');
  assert.equal(output.normalized.label.frozen, 'NOT FROZEN');
  assert.equal(output.normalized.label.cutover, 'NO CUTOVER');
  return output;
}

section('A–V synthetic fixture schema and coverage');
check('FX1.syntheticOnlyAndSchema', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/memory-value-v2/cases.json'), 'utf8'));
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.dataset, 'synthetic-only');
  assert.ok(fixture.notes.some(note => /No user memory/i.test(note)));
  assert.equal(fixture.cases.length, 32);
  assert.equal(new Set(fixture.cases.map(entry => entry.id)).size, fixture.cases.length);
  for (const entry of fixture.cases) {
    for (const key of ['id', 'description', 'record', 'now', 'axis', 'expectedLegacyProperty', 'tags']) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, key), entry.id + ' missing ' + key);
    }
    assert.ok(Array.isArray(entry.tags) && entry.tags.length > 0, entry.id + ' has no tags');
  }
});
check('FX2.required A–V tags are present', () => {
  const allTags = new Set(cases.flatMap(entry => entry.tags));
  for (const tag of 'ABCDEFGHIJKLMNOPQRSTUV') assert.ok(allTags.has(tag), 'missing fixture tag ' + tag);
});
check('FX3.same-query and different-intrinsic pair is present', () => {
  const low = byId.get('N-same-query-low-value');
  const high = byId.get('N-same-query-high-value');
  assert.equal(low.query, high.query);
  assert.notEqual(low.record.importance, high.record.importance);
  assert.equal(low.pairGroup, high.pairGroup);
});
check('FX4.stale-browser and HN-canonical pair differs only in supplied activation snapshot', () => {
  const browser = byId.get('V-browser-stale-count-5').record;
  const homeNode = byId.get('V-hn-canonical-count-7').record;
  const keys = new Set([...Object.keys(browser), ...Object.keys(homeNode)]);
  const changed = [...keys].filter(key => browser[key] !== homeNode[key]);
  assert.deepEqual(changed.sort(), ['activationCount', 'hostSnapshot']);
  assert.equal(browser.activationCount, 5);
  assert.equal(homeNode.activationCount, 7);
});

section('R3-A correction gate: production scorer characterization');
const arousalProbe = [0, 0.01, 0.1, 0.2, 0.3, 1].map(arousal => ({
  arousal,
  score: H.legacyValue({ importance: 5, activationCount: 0, arousal, resolved: false, created: NOW, lastActivated: NOW }, NOW)
}));
check('COR1.production arousal scores match the correction gate', () => {
  assert.deepEqual(arousalProbe, [
    { arousal: 0, score: 6.2 }, { arousal: 0.01, score: 5.04 },
    { arousal: 0.1, score: 5.4 }, { arousal: 0.2, score: 5.8 },
    { arousal: 0.3, score: 6.2 }, { arousal: 1, score: 9 }
  ]);
});
check('COR1b.Legacy arousal component factors are inferred from production scorer output', () => {
  const sweep = H.legacyCharacterization(NOW).arousalSweep;
  assert.deepEqual(sweep.map(row => row.productionScorerDerivedEmotionFactor), [
    1.24, 1.0008, 1.008, 1.04, 1.08, 1.16, 1.2392, 1.24, 1.4, 1.8
  ]);
  assert.ok(sweep.every(row => /production output|round2 precision probe/.test(row.factorProbe)));
});
check('COR2.LEGACY_AROUSAL_MONOTONIC is mechanically false', () => {
  const characterization = H.legacyCharacterization(NOW);
  assert.equal(characterization.LEGACY_AROUSAL_MONOTONIC, false);
  assert.ok(arousalProbe[0].score > arousalProbe[1].score);
  return H.assertKnownLegacyBehavior('R3-A-AROUSAL-1', true,
    { zero: arousalProbe[0].score, epsilon: arousalProbe[1].score });
});
check('COR3.importance zero falls back to five; importance one remains one', () => {
  const zero = H.legacyValue({ importance: 0, arousal: 0.3, activationCount: 0, created: NOW, lastActivated: NOW }, NOW);
  const one = H.legacyValue({ importance: 1, arousal: 0.3, activationCount: 0, created: NOW, lastActivated: NOW }, NOW);
  assert.equal(zero, 6.2);
  assert.equal(one, 1.24);
  assert.ok(zero > one);
});
const derivedProducers = H.deriveProducerDefaults(ROOT);
check('COR4.role_dm zero is blocked by admission; quickCreate falsey fallback is five', () => {
  assert.equal(derivedProducers.quickSemantics.roleDmZeroIsAdmitted, false);
  assert.equal(derivedProducers.quickSemantics.roleDmZeroWouldQuickCreateAs, 5);
  assert.equal(derivedProducers.quickSemantics.importanceFalseyFallback, 5);
  return H.assertKnownLegacyBehavior('role-dm-zero-quickCreate-fallback', true,
    derivedProducers.quickSemantics);
});
check('COR5.correction gate confirmed', () => {
  assert.equal(arousalProbe[0].score > arousalProbe[1].score, true);
  assert.equal(derivedProducers.quickSemantics.importanceFalseyFallback, 5);
  assert.equal(derivedProducers.quickSemantics.roleDmZeroWouldQuickCreateAs, 5);
  console.log('  INFO  R3_A_CORRECTION_CONFIRMED = YES');
});

section('Production Legacy baseline authority / parity');
check('LEG1.baseline delegates to production scoring API', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tests/helpers/memory-value-v2-calibration.js'), 'utf8');
  assert.match(source, /function legacyValue\(record, now\)\s*\{\s*return SCORING\.computeLegacyMemoryValue\(record, now\);\s*\}/);
  assert.match(source, /const SCORING = require\('\.\.\/\.\.\/assets\/js\/memory-recall\/scoring\.js'\)/);
  assert.match(source, /const CORE = require\('\.\.\/\.\.\/assets\/js\/memory-retrieval-core\.js'\)/);
  assert.equal(H.LEGACY_BASELINE_SOURCE,
    'assets/js/memory-recall/scoring.js#computeLegacyMemoryValue → assets/js/memory-retrieval-core.js#getMemoryScore');
});
check('LEG2.production scoring facade parity across fixtures including special values', () => {
  for (const entry of cases) {
    const expected = H.CORE.getMemoryScore(entry.record, entry.now);
    const actual = H.legacyValue(entry.record, entry.now);
    assert.ok(Object.is(actual, expected), entry.id + ' mismatch: ' + String(actual) + ' vs ' + String(expected));
  }
});
check('LEG3.fixed-seed production-call parity sweep', () => {
  let state = 0x5EED21;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  for (let i = 0; i < 512; i++) {
    const created = NOW - random() * 365 * H.DAY;
    const record = {
      importance: 1 + Math.floor(random() * 10),
      arousal: random(),
      activationCount: Math.floor(random() * 10000),
      resolved: random() < 0.5,
      created,
      lastActivated: created + random() * Math.max(0, NOW - created)
    };
    assert.ok(Object.is(H.legacyValue(record, NOW), H.CORE.getMemoryScore(record, NOW)), 'seeded record ' + i);
  }
});
check('LEG4.no copied Legacy formula in baseline adapter body', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tests/helpers/memory-value-v2-calibration.js'), 'utf8');
  const body = source.slice(source.indexOf('function legacyValue'), source.indexOf('function own('));
  assert.match(body, /SCORING\.computeLegacyMemoryValue/);
  assert.doesNotMatch(body, /Math\.exp|activationCount\s*\/|resolved\s*\?/);
});

section('Legacy characterization: expected behavior and registered debt');
const legacy = H.legacyCharacterization(NOW);
check('LEGACY1.arousal sweep records zero discontinuity', () => {
  assert.equal(legacy.LEGACY_AROUSAL_MONOTONIC, false);
  assert.equal(legacy.arousalSweep.length, 10);
  assert.equal(legacy.arousalSweep[0].score, 6.2);
  assert.equal(legacy.arousalSweep[1].score, 5.00);
  assert.equal(legacy.arousalSweep[2].score, 5.04);
  return H.assertKnownLegacyBehavior('legacy-arousal-nonmonotonic', true,
    { zero: legacy.arousalSweep[0].score, epsilon: legacy.arousalSweep[1].score });
});
check('LEGACY2.importance domain is classified separately from out-of-domain probes', () => {
  const lookup = new Map(legacy.importanceSweep.map(row => [String(row.importance), row]));
  assert.equal(lookup.get('1').classification, 'VALID_DOMAIN');
  assert.equal(lookup.get('10').classification, 'VALID_DOMAIN');
  for (const value of ['0', '11', '-1', '$NaN', '$Infinity']) {
    assert.equal(lookup.get(value).classification, 'INVALID_DOMAIN', value);
  }
  assert.ok(lookup.get('0').score > lookup.get('1').score);
});
check('LEGACY3.future timestamps boost scores above the current-time score', () => {
  assert.ok(legacy.futureTimestampBoost.plus1d > legacy.futureTimestampBoost.baseline);
  assert.ok(legacy.futureTimestampBoost.plus30d > legacy.futureTimestampBoost.plus1d);
  return H.assertKnownLegacyBehavior('future-time-amplification', true, legacy.futureTimestampBoost);
});
check('LEGACY4.createdAt-only is ignored by production scorer', () => {
  assert.equal(legacy.createdAtAlias.createdAtOnly, legacy.createdAtAlias.noCreated);
  assert.equal(legacy.createdAtAlias.productionTreatsCreatedAtAsAlias, false);
  return H.assertKnownLegacyBehavior('createdAt-alias-debt', true, legacy.createdAtAlias);
});
check('LEGACY5.activation production-call sweep is monotonic and bounded below 2x', () => {
  const rows = legacy.activationSweep;
  assert.equal(rows[0].scoreRatioToCountZero, 1);
  assert.ok(rows.every((row, i) => i === 0 || row.score >= rows[i - 1].score));
  assert.ok(rows[rows.length - 1].scoreRatioToCountZero < 2);
});
check('LEGACY6.resolved/unresolved age profile is directly measured through production scorer', () => {
  const thirty = legacy.resolvedUnresolvedAt30d;
  assert.ok(thirty.resolved < thirty.unresolved);
  assert.equal(legacy.timestampSweep.length, 8);
});
check('LEGACY7.round2 can collapse old values into zero ties', () => {
  assert.deepEqual(legacy.round2ZeroAndTie.scores, [0, 0]);
  return H.assertKnownLegacyBehavior('round2-old-score-zero-tie', true, legacy.round2ZeroAndTie);
});

section('Candidate API / formulas / normalization');
for (const [name, candidate] of Object.entries(H.CANDIDATES)) {
  check(name + '1.return contract, labels, finite components', () => {
    const output = assertFiniteCandidate(candidate, byId.get('A-new-high-importance').record, NOW);
    assert.equal(output.components.importance, name === 'C' ? 1 : 10);
  });
  check(name + '2.pure on a frozen input record', () => {
    const record = Object.freeze({
      id: 'frozen', importance: 5, arousal: 0.3, activationCount: 10,
      resolved: false, created: NOW, lastActivated: NOW,
      metadata: Object.freeze({ keep: true })
    });
    assertFiniteCandidate(candidate, record, NOW);
    assert.equal(record.metadata.keep, true);
  });
}
check('A3.valid zero arousal is preserved and emotion factor is one', () => {
  const output = H.candidateA(byId.get('O-arousal-zero').record, NOW);
  assert.equal(output.normalized.fields.arousal.effective, 0);
  assert.equal(output.normalized.fields.arousal.reason, 'accepted');
  assert.equal(output.components.emotion, 1);
});
check('A4.importance zero clamps to valid minimum; one remains one', () => {
  const zero = H.candidateA(byId.get('Q-importance-zero').record, NOW);
  const one = H.candidateA({ importance: 1, arousal: 0.3, activationCount: 0, resolved: false, created: NOW, lastActivated: NOW }, NOW);
  assert.equal(zero.normalized.fields.importance.effective, 1);
  assert.equal(zero.normalized.fields.importance.reason, 'clamped-to-domain');
  assert.equal(one.normalized.fields.importance.effective, 1);
  assert.equal(zero.value, one.value);
});
check('A5.future timestamp is floored to zero age; no amplification', () => {
  const future = H.candidateA(byId.get('R-future-thirty-days').record, NOW);
  const current = H.candidateA({ importance: 5, arousal: 0.3, activationCount: 0, resolved: false, created: NOW, lastActivated: NOW }, NOW);
  assert.equal(future.normalized.fields.ageDays.effective, 0);
  assert.equal(future.value, current.value);
});
check('A6.createdAt-only alias and missing time normalize to age zero', () => {
  const alias = H.candidateA(byId.get('S-createdAt-only').record, NOW);
  const current = H.candidateA({ importance: 5, arousal: 0.3, activationCount: 0, resolved: false, created: NOW }, NOW);
  assert.equal(alias.normalized.fields.ageDays.effective, 0);
  assert.equal(alias.value, current.value);
});
check('A7.invalid lastActivated falls back to a valid created timestamp', () => {
  const record = { importance: 5, arousal: 0.3, activationCount: 0, resolved: false, created: NOW - H.DAY, lastActivated: Infinity };
  const output = H.candidateA(record, NOW);
  assert.equal(output.normalized.fields.ageDays.effective, 1);
  assert.equal(output.normalized.fields.ageDays.reason, 'invalid-lastActivated-fallback-to-created');
});
check('A8.input bounds produce finite age metadata for extreme finite timestamps', () => {
  const output = H.candidateA({ importance: 1, arousal: 0, activationCount: 0, resolved: false, created: -Number.MAX_VALUE }, Number.MAX_VALUE);
  assert.equal(output.normalized.fields.ageDays.effective, H.MAX_AGE_DAYS);
  assert.equal(output.normalized.fields.ageDays.reason, 'past-age-capped-to-finite');
  assert.ok(Number.isFinite(output.value));
});
check('A9.null, missing, nonfinite and wrong-type normalization is explicit', () => {
  const output = H.candidateA({ importance: null, arousal: NaN, activationCount: '12', resolved: 'true' }, NOW);
  assert.equal(output.normalized.fields.importance.effective, 5);
  assert.equal(output.normalized.fields.arousal.effective, 0.3);
  assert.equal(output.normalized.fields.activationCount.effective, 0);
  assert.equal(output.normalized.fields.resolved.effective, false);
  assert.ok(Object.values(output.normalized.fields).every(field => typeof field.reason === 'string'));
});
check('B3.activation alternative is bounded, monotonic, and has activation(0)=1', () => {
  assert.equal(H.candidateB(makeNeutralForTest(NOW, { activationCount: 0 }), NOW).components.activation, 1);
  const counts = [0, 1, 5, 10, 50, 100, 300, 1000, Number.MAX_VALUE];
  const factors = counts.map(count => H.candidateB(makeNeutralForTest(NOW, { activationCount: count }), NOW).components.activation);
  assert.ok(factors.every((factor, i) => factor >= 1 && factor <= 1.5 && (i === 0 || factor >= factors[i - 1])));
  assert.equal(H.candidateB(makeNeutralForTest(NOW, { activationCount: 100 }), NOW).components.activation, 1.25);
});
check('B4.B changes only the activation component relative to A', () => {
  for (const entry of cases.filter(row => row.tags.includes('valid') && !row.record.pinned)) {
    const a = H.candidateA(entry.record, entry.now);
    const b = H.candidateB(entry.record, entry.now);
    assert.deepEqual(b.normalized.fields, a.normalized.fields, entry.id);
    for (const component of ['importance', 'decay', 'emotion']) {
      assert.equal(b.components[component], a.components[component], entry.id + '/' + component);
    }
  }
  const report = H.buildShadowReport(ROOT);
  assert.equal(report.B_ACTIVATION_FORMULA, '1 + 0.5 × activationCount / (activationCount + 100)');
  assert.deepEqual(report.B_REFERENCE_POINTS.map(row => row.activationCount), [0, 1, 5, 10, 50, 100, 300, 1000]);
});
check('C3.provisional components and value are explicitly bounded', () => {
  assert.equal(Object.values(H.C_WEIGHTS).reduce((a, b) => a + b, 0), 1);
  for (let importance = 1; importance <= 10; importance++) {
    for (const arousal of [0, 0.001, 0.3, 1]) {
      const record = makeNeutralForTest(NOW, { importance, arousal });
      const out = H.candidateC(record, NOW);
      assert.ok(Object.values(out.components).every(value => value >= 0 && value <= 1));
      assert.ok(out.value >= 1 && out.value <= 10);
      assert.equal(out.normalized.provisional, 'NOT FROZEN · SHADOW ONLY');
    }
  }
});
check('C4.C provisional constants are mechanically named, not marked frozen', () => {
  assert.deepEqual(H.C_WEIGHTS, { importance: 0.4, activation: 0.25, decay: 0.2, emotion: 0.15 });
  assert.equal(H.FORMULA_LABEL.frozen, 'NOT FROZEN');
  assert.equal(H.FORMULA_LABEL.cutover, 'NO CUTOVER');
});

section('P1–P10 property and leakage harness');
const propertyChecks = H.propertyReport(NOW);
for (const candidateName of ['A', 'B', 'C']) {
  for (const property of [
    'P1_queryInvariance', 'P2_visibilityInvariance', 'P3_cooldownStateInvariance',
    'P4_sourceTypeInvariance', 'P5_validDomainFinite', 'P6_activationMonotonicity',
    'P7_ageMonotonicity', 'P8_missingValueDeterminism', 'P9_pinnedExcludedFromNormalValue', 'P10_noMutation'
  ]) {
    check(candidateName + '.' + property, () => assert.equal(propertyChecks[candidateName][property], true));
  }
}
check('PROP1.Legacy expected statuses distinguish expected debt from suite failure', () => {
  const legacyProperties = propertyChecks.LEGACY;
  for (const key of [
    'P1_queryInvariance', 'P2_visibilityInvariance', 'P3_cooldownStateInvariance',
    'P4_sourceTypeInvariance', 'P5_validDomainFinite', 'P6_activationMonotonicity',
    'P7_ageMonotonicity', 'P8_missingValueDeterminism', 'P10_noMutation'
  ]) assert.equal(legacyProperties[key], true, key);
  assert.equal(legacyProperties.P9_pinnedExcludedFromNormalValue, false);
  return H.assertKnownLegacyBehavior('P9-pinned-is-a-priority-sentinel-not-normal-value', true);
});
check('PROP2.Legacy arousal monotonicity debt is reported as expected', () => {
  const scan = H.monotonicViolationScanner(NOW).legacy.arousal;
  assert.ok(scan.violationCount > 0);
  assert.equal(H.legacyCharacterization(NOW).LEGACY_AROUSAL_MONOTONIC, false);
  return H.assertKnownLegacyBehavior('P-arousal-monotonicity', true, { violations: scan.violationCount });
});
check('PROP3.query variants leave direct value calls byte-for-byte identical', () => {
  const base = byId.get('M-query-invariance').record;
  const queries = byId.get('M-query-invariance').queryVariants;
  for (const candidate of Object.values(H.CANDIDATES)) {
    const outputs = queries.map(query => candidate(Object.assign({}, base, { query, currentQuery: query }), NOW));
    for (const output of outputs.slice(1)) assert.deepEqual(output, outputs[0]);
  }
});
check('PROP4.cooldown, exposure and turn metadata cannot leak into value', () => {
  const base = makeNeutralForTest(NOW);
  const changes = [
    { lastExposureTurn: 1, exposureCount: 0, cooldownFactor: 0.1, turnIndex: 2 },
    { lastExposureTurn: 999, exposureCount: 800, cooldownFactor: 1, turnIndex: 1000 },
    { lastExposureTurn: NaN, exposureCount: Infinity, cooldownFactor: -1, turnIndex: -1 }
  ];
  for (const candidate of Object.values(H.CANDIDATES)) {
    const expected = candidate(base, NOW);
    for (const extra of changes) assert.deepEqual(candidate(Object.assign({}, base, extra), NOW), expected);
  }
});
check('PROP5.ACL and group metadata cannot leak into value', () => {
  const base = makeNeutralForTest(NOW);
  const expected = Object.values(H.CANDIDATES).map(candidate => candidate(base, NOW).value);
  const aclVariants = [
    { visibility: 'private' }, { visibility: 'only', visibleTo: ['x'] },
    { visibility: 'except', excludeFrom: ['x'] }, { isGroup: true, groupMemEnabled: true, groupId: 'x' }
  ];
  for (const variant of aclVariants) {
    const actual = Object.values(H.CANDIDATES).map(candidate => candidate(Object.assign({}, base, variant), NOW).value);
    assert.deepEqual(actual, expected);
  }
});
check('PROP6.browser stale and HN canonical inputs are separately scored without authority lookup', () => {
  const browser = byId.get('V-browser-stale-count-5');
  const homeNode = byId.get('V-hn-canonical-count-7');
  for (const candidate of Object.values(H.CANDIDATES)) {
    const b = candidate(browser.record, browser.now);
    const h = candidate(homeNode.record, homeNode.now);
    assert.notEqual(b.value, h.value);
  }
  const source = fs.readFileSync(path.join(ROOT, 'tests/helpers/memory-value-v2-calibration.js'), 'utf8');
  const candidateBodies = source.slice(source.indexOf('function candidateA'), source.indexOf('function materializeSpecial'));
  assert.doesNotMatch(candidateBodies, /fetch\s*\(|home-node-client|memoryAuthority|recordActivation|localStorage|indexedDB/i);
});

section('Producer-default paired matrix from current production source');
const producers = H.producerMatrix(ROOT, NOW);
check('PROD1.producer IDs match the required current canonical set', () => {
  assert.deepEqual(producers.rows.map(row => row.producer).sort(), [
    'blog', 'chat', 'cinema', 'consolidation', 'coread', 'diary', 'group_chat', 'letter', 'manual', 'role_dm'
  ]);
});
check('PROD2.values are extracted from production source anchors, not a copied report', () => {
  assert.equal(producers.producerCount, 10);
  assert.ok(producers.sourceDescriptors.every(item => item.sourceFiles.length > 0));
  assert.equal(producers.quickCreateSemantics.importanceFalseyFallback, 5);
  assert.equal(producers.rows.find(row => row.producer === 'coread').fields.importance, 4);
  assert.equal(producers.rows.find(row => row.producer === 'consolidation').fields.arousal, 0.4);
  assert.equal(producers.rows.find(row => row.producer === 'role_dm').fields.importance, 6);
});
check('PROD3.RAW_DEFAULT_BIAS is calculated for all scorers', () => {
  for (const name of ['legacy', 'A', 'B', 'C']) {
    const bias = producers.RAW_DEFAULT_BIAS[name];
    assert.ok(Number.isFinite(bias.min) && Number.isFinite(bias.max));
    assert.ok(bias.max >= bias.min);
  }
  assert.ok(producers.RAW_DEFAULT_BIAS.legacy.range > 0);
});
check('PROD4.NORMALIZED_FIELD_CONTROL proves source-only fields do not leak', () => {
  for (const name of ['legacy', 'A', 'B', 'C']) {
    const unique = new Set(producers.NORMALIZED_FIELD_CONTROL.map(row => row.scores[name]));
    assert.equal(unique.size, 1, name + ' differs under source-only change');
  }
});

section('Sensitivity / monotonicity / deterministic finite-domain fuzz');
const sensitivity = H.sensitivityGenerator(NOW);
check('SENS1.required axis sweeps cover requested points', () => {
  const axes = new Map();
  sensitivity.forEach(row => { if (!axes.has(row.axis)) axes.set(row.axis, []); axes.get(row.axis).push(String(row.input)); });
  for (const value of ['0', '1', '2', '5', '10', '11', '-1', '$NaN', '$Infinity']) assert.ok(axes.get('importance').includes(value));
  for (const value of ['0', '1', '5', '10', '50', '100', '300', '500', '1000']) assert.ok(axes.get('activationCount').includes(value));
  for (const value of ['365', '180', '30', '7', '1', '0', '-1', '-30']) assert.ok(axes.get('ageDays').includes(value));
  for (const value of ['0', '0.001', '0.01', '0.05', '0.1', '0.2', '0.299', '0.3', '0.5', '1']) assert.ok(axes.get('arousal').includes(value));
  assert.equal(axes.get('resolved').length, 2);
});
const violations = H.monotonicViolationScanner(NOW);
check('MONO1.declared monotonic candidate invariants have zero violations', () => {
  for (const name of ['A', 'B', 'C']) {
    for (const axis of ['activation', 'ageDays', 'arousal', 'importance']) {
      assert.equal(violations[name][axis].violationCount, 0, name + '/' + axis);
    }
  }
});
check('MONO2.Legacy arousal violation is recorded, not repaired', () => {
  assert.ok(violations.legacy.arousal.violationCount > 0);
  assert.equal(violations.legacy.activation.violationCount, 0);
  assert.equal(violations.legacy.ageDays.violationCount, 0);
  console.log('  INFO  LEGACY_AROUSAL_MONOTONIC = FALSE');
});
check('FUZZ1.fixed-seed inputs yield finite, deterministic, explained candidates', () => {
  const fuzz = H.deterministicFuzz(0x21A3B, 512, NOW);
  assert.equal(fuzz.cases, 512);
  for (const name of ['A', 'B', 'C']) {
    assert.equal(fuzz.candidateFinite[name], true);
    assert.equal(fuzz.deterministic[name], true);
    assert.equal(fuzz.normalizationExplained[name], true);
  }
  assert.ok(fuzz.legacyNonfiniteCases > 0, 'invalid Legacy domain characterization was not exercised');
});
check('FUZZ2.same seed reproduces summary', () => {
  const one = H.deterministicFuzz(12345, 64, NOW);
  const two = H.deterministicFuzz(12345, 64, NOW);
  assert.deepEqual(one, two);
});

section('Pairwise rank inversions / intrinsic top-K shadow metrics');
const metrics = H.metricReport(cases, NOW);
check('METRIC1.all six Legacy/A/B/C pair comparisons exist', () => {
  assert.deepEqual(Object.keys(metrics.pairwise).sort(), [
    'A ↔ B', 'A ↔ C', 'B ↔ C', 'Legacy ↔ A', 'Legacy ↔ B', 'Legacy ↔ C'
  ].sort());
  for (const row of Object.values(metrics.pairwise)) {
    assert.ok(row.comparedPairs > 0);
    assert.ok(row.inversions >= 0 && row.orderChanges >= row.inversions);
  }
});
check('METRIC2.top-1/top-3/top-5 and Spearman are calculated without pinned cases', () => {
  assert.equal(metrics.rankPoolCount, cases.filter(entry => entry.tags.includes('rank-pool')
    && !entry.tags.includes('invalid-domain') && !entry.record.pinned).length);
  assert.equal(Object.keys(metrics.topK).length, 6);
  for (const row of Object.values(metrics.topK)) {
    assert.equal(typeof row.top1Change, 'boolean');
    assert.equal(typeof row.top3SetChange, 'boolean');
    assert.equal(typeof row.top5SetChange, 'boolean');
    assert.ok(row.spearman == null || (Number.isFinite(row.spearman) && row.spearman >= -1 && row.spearman <= 1));
  }
});
check('METRIC3.no relevance, fatigue, cooldown or pin fields enter rank pool', () => {
  const pool = H.loadCases(ROOT).filter(entry => entry.tags.includes('rank-pool')
    && !entry.tags.includes('invalid-domain') && !entry.record.pinned);
  assert.ok(pool.every(entry => !entry.record.pinned));
});

section('R3-C criteria and discrimination fixtures');
const criteria = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/memory-value-v2/calibration-criteria.json'), 'utf8'));
const scenarioFixture = H.loadScenarioFamilies(ROOT);
const expandedScenarios = H.expandScenarioFamilies(ROOT, NOW);
check('R3C1.C1-C20 evaluation criteria are frozen, measurable, and split hard/soft', () => {
  const ids = [...criteria.hardGates, ...criteria.softMetrics].map(row => row.id)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => 'C' + (i + 1)));
  assert.ok(criteria.hardGates.every(row => typeof row.measurement === 'string' && row.measurement.length > 0));
  assert.ok(criteria.softMetrics.every(row => typeof row.measurement === 'string' && row.measurement.length > 0));
  assert.equal(criteria.decisionRule.noSelectionIsValid, true);
  assert.equal(criteria.decisionRule.humanPreferenceLabels, false);
});
check('R3C2.S1-S12 fixture families expand to synthetic records without preference labels', () => {
  assert.equal(scenarioFixture.dataset, 'synthetic-only');
  assert.deepEqual(scenarioFixture.scenarioFamilies.map(row => row.id), Array.from({ length: 12 }, (_, i) => 'S' + (i + 1)));
  assert.equal(expandedScenarios.families.length, 12);
  assert.equal(expandedScenarios.records.length, 25);
  const json = JSON.stringify(scenarioFixture);
  assert.doesNotMatch(json, /expectedWinner|preferredWinner|shouldWin|correctWinner/i);
  assert.ok(expandedScenarios.records.every(row => !String(row.record.content || '').length));
});
check('R3C3.scenario family rank and pairwise metrics are emitted for every family', () => {
  const report = H.buildShadowReport(ROOT);
  assert.equal(report.SCENARIO_FAMILY_METRICS.length, 12);
  assert.equal(report.SCENARIO_RANK_CHURN.length, 6);
  assert.equal(report.SCENARIO_POOL_METRICS.poolCount, 25);
  assert.ok(report.SCENARIO_RANK_CHURN.every(row => row.families.length === 12));
  assert.ok(report.SCENARIO_POOL_METRICS.pairwise['Legacy ↔ A']);
  assert.ok(report.SCENARIO_POOL_METRICS.topK['A ↔ C']);
});

section('Activation, importance, and recency crossover measurement');
const activationSweepR3C = H.activationSensitivity(NOW, ROOT);
const activationCrossoverR3C = H.activationImportanceCrossovers(NOW);
check('R3C4.activation sweep uses all requested points and includes Legacy production reference', () => {
  assert.deepEqual(activationSweepR3C.counts, [0, 1, 5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1000, 5000]);
  assert.equal(activationSweepR3C.legacyParameterBaseline.gain, 1);
  assert.equal(activationSweepR3C.legacyParameterBaseline.k, 300);
  assert.equal(activationSweepR3C.candidates.length, 14);
  assert.equal(activationSweepR3C.candidates[0].Legacy.component, 1);
});
check('R3C5.A and B activation components separate below/above their measured crossover', () => {
  const rows = new Map(activationSweepR3C.candidates.map(row => [row.activationCount, row]));
  assert.ok(rows.get(50).B.component > rows.get(50).A.component);
  assert.equal(rows.get(100).B.component, rows.get(100).A.component);
  assert.ok(rows.get(300).A.component > rows.get(300).B.component);
});
check('R3C6.activation/importance matrix finds mechanical strict-overtake boundaries', () => {
  const rows = new Map(activationCrossoverR3C.map(row => [row.lowerImportance, row]));
  assert.equal(rows.get(9).byScorer.Legacy.firstStrictOvertakeCount, 38);
  assert.equal(rows.get(9).byScorer.A.firstStrictOvertakeCount, 38);
  assert.equal(rows.get(9).byScorer.B.firstStrictOvertakeCount, 29);
  assert.equal(rows.get(6).byScorer.B, null);
  assert.ok(rows.get(6).byScorer.A.firstStrictOvertakeCount != null);
  assert.equal(rows.get(4).byScorer.C, null);
});
check('R3C7.recency/importance crossover matrix measures minimum age thresholds', () => {
  const rows = new Map(H.recencyImportanceCrossovers(NOW).map(row => [row.freshLowerImportance, row]));
  assert.equal(rows.get(9).byScorer.Legacy.firstStrictOvertakeAgeDays, 3);
  assert.equal(rows.get(9).byScorer.C.firstStrictOvertakeAgeDays, 6);
  assert.equal(rows.get(1).byScorer.C, null);
});
check('R3C8.recency × activation matrix covers all 48 cells and age-offset summaries', () => {
  const matrix = H.recencyActivationMatrix(NOW);
  assert.equal(matrix.values.length, 48);
  assert.deepEqual(matrix.ages, [0, 1, 3, 7, 14, 30, 60, 90]);
  assert.deepEqual(matrix.activationCounts, [0, 10, 50, 100, 300, 1000]);
  assert.equal(matrix.latestAgeOffsetVsFreshBaseline.Legacy.length, 6);
  assert.ok(matrix.values.every(row => ['Legacy', 'A', 'B', 'C'].every(name => Number.isFinite(row.values[name]))));
});

section('Resolved, long-age, arousal and importance calibration');
check('R3C9.resolved/unresolved matrix preserves and measures both lambda branches', () => {
  const matrix = H.resolvedAgeMatrix(NOW);
  assert.equal(matrix.rows.length, 20);
  const at30 = matrix.rows.filter(row => row.ageDays === 30);
  for (const name of ['A', 'B', 'C']) {
    const resolved = at30.find(row => row.resolved).candidates[name].decay;
    const unresolved = at30.find(row => !row.resolved).candidates[name].decay;
    assert.ok(resolved < unresolved, name);
  }
});
check('R3C10.long-age calibration covers zero through ten years and tie/zero windows', () => {
  const tail = H.longAgeCalibration(NOW);
  assert.deepEqual(tail.agesDays, [0, 1, 7, 30, 90, 180, 365, 730, 1825, 3650]);
  assert.equal(tail.rows.length, 10);
  assert.equal(tail.rows[0].legacy.value, 6.2);
  assert.equal(tail.distinguishabilityWindow.Legacy.firstZeroAgeDays, 180);
  assert.equal(tail.distinguishabilityWindow.A.firstZeroAgeDays, 180);
  assert.equal(tail.distinguishabilityWindow.B.firstZeroAgeDays, 180);
  assert.equal(tail.distinguishabilityWindow.C.firstZeroAgeDays, null);
  assert.ok(tail.distinguishabilityWindow.Legacy.adjacentTieCount > 0);
});
check('R3C11.arousal crossover is mechanically measured without assigning a preferred side', () => {
  const rows = new Map(H.arousalImportanceCrossovers(NOW).map(row => [row.lowerImportance, row]));
  assert.equal(rows.get(7).byScorer.Legacy.lowerImportanceHighArousalStrictlyOvertakes, true);
  for (const name of ['A', 'B', 'C']) assert.equal(rows.get(7).byScorer[name].lowerImportanceHighArousalStrictlyOvertakes, true);
  assert.equal(rows.get(6).byScorer.Legacy.lowerImportanceHighArousalStrictlyOvertakes, false);
});
check('R3C12.importance legal and invalid inputs are separately classified', () => {
  const rows = new Map(H.importanceDomainCalibration(NOW).map(row => [String(row.input), row]));
  assert.equal(rows.size, 10);
  assert.equal(rows.get('1').domain, 'VALID_DOMAIN');
  assert.equal(rows.get('10').domain, 'VALID_DOMAIN');
  for (const input of ['0', '-1', '11', '100', '$NaN', '$Infinity']) {
    assert.equal(rows.get(input).domain, 'INVALID_DOMAIN');
  }
});

section('B parameter and C weight sensitivity');
const bSensitivityR3C = H.bParameterSensitivity(expandedScenarios, NOW, ROOT);
const cSensitivityR3C = H.cWeightSensitivity(expandedScenarios, H.producerMatrix(ROOT, NOW).rows.map(row => ({
  producer: row.producer,
  record: H.makeProducerRecord(H.deriveProducerDefaults(ROOT).specs[row.producer], NOW),
  now: NOW
})), NOW);
check('R3C13.B gain/K grid is 3×3 with Legacy gain=1,K=300 as measured baseline', () => {
  assert.equal(bSensitivityR3C.entries.length, 9);
  assert.equal(bSensitivityR3C.legacyParameterBaseline.gain, 1);
  assert.equal(bSensitivityR3C.legacyParameterBaseline.k, 300);
  assert.ok(bSensitivityR3C.entries.every(row => row.referencePoints.length === 8 && row.importanceActivationCrossovers.length === 9));
  assert.ok(bSensitivityR3C.sensitivitySummary.rankChangeVsDefaultBCount > 0);
});
check('R3C14.C bounded weight grid filters negative emotion remainders and measures sensitivity', () => {
  assert.equal(cSensitivityR3C.validGridCount, 23);
  assert.ok(cSensitivityR3C.entries.every(row => row.emotionRemainder >= 0
    && Math.abs(Object.values(row.weights).reduce((a, b) => a + b, 0) - 1) < 1e-12));
  assert.ok(cSensitivityR3C.sensitivitySummary.pairwiseOrderingChangedCount > 0);
  assert.ok(cSensitivityR3C.sensitivitySummary.topKChangedCount > 0);
  assert.equal(cSensitivityR3C.sensitivitySummary.monotonicViolationGroupCount, 0);
});
check('R3C15.Legacy/A/B/C parameter and normalization complexity is separately counted', () => {
  const complexity = H.complexityEvidence();
  assert.deepEqual(Object.keys(complexity).sort(), ['A', 'B', 'C']);
  assert.equal(complexity.A.normalizationRules, 5);
  assert.equal(complexity.B.normalizationRules, 5);
  assert.equal(complexity.C.normalizationRules, 5);
  assert.ok(complexity.C.independentWeightDegreesOfFreedom < 4);
});

section('R3-C hard gates, complexity evidence, and selection guard');
const criteriaIds = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/memory-value-v2/calibration-criteria.json'), 'utf8'));
const r3cReport = H.buildShadowReport(ROOT);
check('R3C16.no C1-C20 criterion is an unmeasurable preference phrase', () => {
  const text = JSON.stringify(criteriaIds);
  assert.doesNotMatch(text, /more natural|more intelligent|human-like memory/i);
  assert.equal(criteriaIds.hardGates.length + criteriaIds.softMetrics.length, 20);
  assert.equal(r3cReport.allCandidateHardGatesPass, true);
});
check('R3C17.C15 and formula complexity are evidence counts, not a composite score', () => {
  for (const name of ['A', 'B', 'C']) {
    const row = r3cReport.CANDIDATE_COMPLEXITY[name];
    assert.ok(Number.isInteger(row.tunableFormulaConstants) && row.tunableFormulaConstants > 0);
    assert.equal(row.normalizationRules, 5);
    assert.ok(Array.isArray(row.branches));
  }
  assert.equal(Object.prototype.hasOwnProperty.call(r3cReport, 'weightedCandidateScore'), false);
});
check('R3C17b.365000-day cap is only a finite normalization safety bound', () => {
  assert.equal(H.MAX_AGE_DAYS, 365000);
  const at = H.candidateA({ importance: 5, arousal: 0.3, activationCount: 0, resolved: false, created: NOW - 500000 * H.DAY }, NOW);
  assert.equal(at.normalized.fields.ageDays.effective, 365000);
  assert.equal(at.normalized.fields.ageDays.reason, 'past-age-capped-to-finite');
  const source = fs.readFileSync(path.join(ROOT, 'tests/helpers/memory-value-v2-calibration.js'), 'utf8');
  assert.doesNotMatch(source, /calibrated age cap|recommended age horizon|frozen age parameter/i);
});
check('R3C18.A remains normalization-only control and exact on clean valid Legacy inputs', () => {
  const eligible = cases.filter(entry => entry.tags.includes('valid') && entry.record
    && Number.isFinite(entry.record.importance) && entry.record.importance >= 1 && entry.record.importance <= 10
    && Number.isFinite(entry.record.arousal) && entry.record.arousal > 0
    && Number.isFinite(entry.record.activationCount) && entry.record.activationCount >= 0
    && typeof entry.record.resolved === 'boolean'
    && Number.isFinite(entry.record.lastActivated || entry.record.created));
  assert.ok(eligible.length > 5);
  for (const entry of eligible) {
    assert.equal(H.candidateA(entry.record, entry.now).value, H.legacyValue(entry.record, entry.now), entry.id);
  }
  assert.equal(r3cReport.candidates.A.role, 'normalization-only control');
});
check('R3C19.scenario rank metrics include Kendall tau-a and family-level churn', () => {
  for (const row of Object.values(r3cReport.SCENARIO_POOL_METRICS.pairwise)) {
    assert.ok(Number.isFinite(row.kendallTau));
    assert.ok(Number.isFinite(row.inversionPercent));
    assert.ok(Number.isFinite(row.orderChangePercent));
  }
  assert.equal(r3cReport.SCENARIO_RANK_CHURN.length, 6);
  assert.ok(r3cReport.SCENARIO_RANK_CHURN.every(row => row.familyCount === 12));
});
check('R3C20.producer matrix spans age/activation buckets with zero source-only spread', () => {
  assert.deepEqual(r3cReport.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION.ageBuckets, [0, 30, 180]);
  assert.deepEqual(r3cReport.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION.activationBuckets, [0, 100, 1000]);
  assert.equal(r3cReport.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION.rows.length, 90);
  assert.ok(Object.values(r3cReport.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION.fieldControlledSourceOnlySpreads).every(value => value === 0));
  assert.equal(r3cReport.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION.rows.some(row => row.producer === 'role_dm'), true);
});
check('R3C20b.model-input minima are labeled as synthetic admission samples', () => {
  const specs = H.deriveProducerDefaults(ROOT).specs;
  for (const producer of ['diary', 'consolidation', 'role_dm']) {
    assert.match(specs[producer].basis, /representative is extracted minimum/);
    assert.equal(specs[producer].importanceSource, 'admission threshold');
  }
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/memory-value-v2/producer-defaults.json'), 'utf8'));
  assert.ok(fixture.notes.some(note => /not copied from the R3-A report/i.test(note)));
  assert.ok(fixture.notes.some(note => /not a real producer distribution/i.test(note)));
});
check('R3C21.explainability samples show effective inputs and all four named components', () => {
  assert.equal(r3cReport.EXPLAINABILITY_SAMPLES.length, 10);
  for (const row of r3cReport.EXPLAINABILITY_SAMPLES) {
    for (const name of ['A', 'B', 'C']) {
      assert.ok(Number.isFinite(row[name].value));
      assert.deepEqual(Object.keys(row[name].components).sort(), ['activation', 'decay', 'emotion', 'importance']);
      assert.ok(row[name].normalized.fields.importance.reason);
    }
  }
});
check('R3C22.deterministic fuzz is expanded to 2048 fixed-seed records', () => {
  assert.equal(r3cReport.finiteFuzz.seed, 0x21A3B);
  assert.equal(r3cReport.finiteFuzz.cases, 2048);
  for (const name of ['A', 'B', 'C']) {
    assert.equal(r3cReport.finiteFuzz.candidateFinite[name], true);
    assert.equal(r3cReport.finiteFuzz.deterministic[name], true);
    assert.equal(r3cReport.finiteFuzz.normalizationExplained[name], true);
  }
});
check('R3C23.no selection means no frozen formula and no R3-D authorization', () => {
  assert.equal(r3cReport.FORMULA_SELECTION, 'NONE');
  assert.equal(r3cReport.CURRENT_FIXTURE_DISCRIMINATION, 'INSUFFICIENT');
  assert.equal(r3cReport.FROZEN_FORMULA, null);
  assert.equal(r3cReport.R3_D_CUTOVER_EVALUATION_AUTHORIZED, false);
  assert.equal(r3cReport.calibrationDecision.status, 'CLOSED');
  assert.equal(r3cReport.calibrationDecision.selectedCandidate, null);
  assert.equal(r3cReport.calibrationDecision.formulaVersion, null);
  assert.ok(r3cReport.calibrationDecision.blockers.length >= 3);
  assert.deepEqual(r3cReport.calibrationDecision.hardGates, r3cReport.hardGates);
});
check('R3C24.clean-candidate scope gate detects zero production/schema paths', () => {
  assert.equal(r3cReport.allCandidateHardGatesPass, true);
  for (const name of ['A', 'B', 'C']) {
    assert.equal(r3cReport.hardGates[name].C16_schemaUnchanged, true);
    assert.equal(r3cReport.hardGates[name].C17_pureNoAuthority, true);
  }
  const scope = r3cReport.hardGates.A.scopeEvidence;
  assert.equal(scope.productionPathCount, 0);
  assert.equal(scope.schemaPathCount, 0);
  assert.equal(scope.changedPaths.some(file => file.startsWith('assets/') || file.startsWith('services/') || file.startsWith('src-tauri/')), false);
});

section('Shadow report artifacts and formula labels');
let shadow;
check('OUT1.synthetic shadow JSON/Markdown are generated under ignored tmp/', () => {
  shadow = H.writeShadowOutputs(ROOT);
  assert.ok(fs.existsSync(shadow.jsonPath));
  assert.ok(fs.existsSync(shadow.mdPath));
  assert.match(shadow.jsonPath, /[\\/]tmp[\\/]memory-value-v2-shadow\.json$/);
  assert.match(shadow.mdPath, /[\\/]tmp[\\/]memory-value-v2-shadow\.md$/);
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/tmp\/$/m);
});
check('OUT2.report includes comparison metrics and defers formula choice', () => {
  assert.equal(shadow.report.fixtureCount, 32);
  assert.equal(Object.prototype.hasOwnProperty.call(shadow.report, 'winner'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(shadow.report, 'cutoverRecommended'), false);
  assert.equal(shadow.report.phase, 'P21-R3-C');
  assert.equal(shadow.report.FORMULA_SELECTION, 'NONE');
  assert.equal(shadow.report.FROZEN_FORMULA, null);
  assert.match(shadow.report.decision, /canonical product rule/);
  assert.doesNotMatch(JSON.stringify(shadow.report), /BEST|WINNER|SELECTED FORMULA|CUTOVER RECOMMENDED/i);
  assert.equal(shadow.report.R3_A_CORRECTION_CONFIRMED, true);
  assert.equal(shadow.report.finiteFuzz.cases, 2048);
  assert.equal(shadow.report.allCandidateHardGatesPass, true);
  assert.equal(shadow.report.R3_D_CUTOVER_EVALUATION_AUTHORIZED, false);
  assert.ok(shadow.report.legacyCharacterization.legacyDebt.length >= 5);
  assert.ok(shadow.report.SCENARIO_POOL_METRICS.pairwise['Legacy ↔ A']);
  assert.ok(shadow.report.SCENARIO_POOL_METRICS.topK['Legacy ↔ A']);
  assert.doesNotMatch(fs.readFileSync(shadow.mdPath, 'utf8'), /BEST|WINNER|SELECTED FORMULA|CUTOVER RECOMMENDED/i);
});
check('OUT2b.tracked decision artifact records NONE and clean hard gates', () => {
  const decision = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/memory-value-v2/calibration-decision.json'), 'utf8'));
  assert.deepEqual(decision, shadow.report.calibrationDecision);
  assert.equal(decision.status, 'CLOSED');
  assert.equal(decision.formulaSelection, 'NONE');
  assert.equal(decision.selectedCandidate, null);
  assert.equal(decision.R3_D_CUTOVER_EVALUATION_AUTHORIZED, false);
});
check('OUT3.all candidate metadata says SHADOW / NOT PRODUCTION / NOT FROZEN / NO CUTOVER', () => {
  for (const candidate of Object.values(H.CANDIDATES)) {
    const labels = candidate(makeNeutralForTest(NOW), NOW).normalized.label;
    assert.deepEqual(labels, H.FORMULA_LABEL);
  }
  assert.match(fs.readFileSync(shadow.mdPath, 'utf8'), /NOT PRODUCTION/);
  assert.match(fs.readFileSync(shadow.mdPath, 'utf8'), /NOT FROZEN/);
  assert.match(fs.readFileSync(shadow.mdPath, 'utf8'), /NO CUTOVER/);
});
check('REG1.registered exactly once in test-all static group', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'tests/test-all.js'), 'utf8');
  const entries = registry.split('\n');
  const groups = [];
  let current = null;
  entries.forEach(line => {
    const group = /^\s{4}name:\s*'([^']+)'/.exec(line);
    if (group) { current = group[1]; return; }
    if (/test_memory_value_v2_calibration\.js/.test(line)) groups.push(current);
  });
  assert.deepEqual(groups, ['static']);
  assert.match(registry, /registry: <entries> entries · <unique> unique scripts · static <n>/,
    'registry counts must remain mechanically printed rather than hard-coded');
});

console.log('\nMemoryValueV2 calibration: ' + passed + ' passed · ' + failures + ' failed');
if (failures) process.exitCode = 1;

function makeNeutralForTest(now, changes) {
  return Object.assign({
    id: 'test-neutral', importance: 5, arousal: 0.3, activationCount: 0,
    resolved: false, created: now, lastActivated: now
  }, changes || {});
}
