'use strict';

/* P21-R3-B · Offline, synthetic-only MemoryValue calibration harness.
 *
 * Candidate functions are pure record + now evaluators. The Legacy adapter
 * delegates to the production scoring facade, which delegates to the shared
 * production memory-retrieval-core. This file is tests-only and never feeds
 * production ranking, trace, activation, or storage.
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const CORE = require('../../assets/js/memory-retrieval-core.js');
const SCORING = require('../../assets/js/memory-recall/scoring.js');

const ROOT = path.resolve(__dirname, '../..');
const DAY = 86400000;
const MAX_AGE_DAYS = 365000;
const DEFAULT_NOW = 1750000000000;
const FORMULA_LABEL = Object.freeze({
  phase: 'P21-R3-B', status: 'SHADOW', production: 'NOT PRODUCTION',
  frozen: 'NOT FROZEN', cutover: 'NO CUTOVER'
});
const C_WEIGHTS = Object.freeze({ importance: 0.40, activation: 0.25, decay: 0.20, emotion: 0.15 });

function legacyValue(record, now) {
  return SCORING.computeLegacyMemoryValue(record, now);
}

function own(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function displayRaw(value, present) {
  if (!present) return '<missing>';
  if (value === undefined) return '$undefined';
  if (typeof value === 'number' && Number.isNaN(value)) return '$NaN';
  if (value === Infinity) return '$Infinity';
  if (value === -Infinity) return '$-Infinity';
  return value;
}

function boundedNumber(record, key, fallback, low, high) {
  const present = own(record, key);
  const raw = present ? record[key] : undefined;
  let value = fallback;
  let reason = present ? 'invalid-type-or-nonfinite-default' : 'missing-default';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    value = Math.min(high, Math.max(low, raw));
    reason = value === raw ? 'accepted' : 'clamped-to-domain';
  }
  return {
    value,
    audit: { input: displayRaw(raw, present), effective: value, domain: [low, high], reason }
  };
}

function nonnegativeNumber(record, key, fallback) {
  const present = own(record, key);
  const raw = present ? record[key] : undefined;
  let value = fallback;
  let reason = present ? 'invalid-type-or-nonfinite-default' : 'missing-default';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    value = Math.max(0, raw);
    reason = value === raw ? 'accepted' : 'clamped-to-zero';
  }
  return {
    value,
    audit: { input: displayRaw(raw, present), effective: value, domain: '[0, finite)', reason }
  };
}

function finiteTimestamp(record, key) {
  if (!own(record, key) || record[key] == null) return { value: null, reason: 'missing' };
  const raw = record[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { value: null, reason: 'invalid-type-or-nonfinite' };
  }
  return { value: raw, reason: 'accepted' };
}

function normalizeInputs(record, now) {
  const rec = (record && typeof record === 'object' && !Array.isArray(record)) ? record : {};
  const importance = boundedNumber(rec, 'importance', 5, 1, 10);
  const arousal = boundedNumber(rec, 'arousal', 0.3, 0, 1);
  const activation = nonnegativeNumber(rec, 'activationCount', 0);
  const resolvedPresent = own(rec, 'resolved');
  const resolvedRaw = resolvedPresent ? rec.resolved : undefined;
  const resolved = typeof resolvedRaw === 'boolean' ? resolvedRaw : false;
  const resolvedReason = typeof resolvedRaw === 'boolean'
    ? 'accepted' : (resolvedPresent ? 'invalid-type-default-false' : 'missing-default-false');

  const nowValid = typeof now === 'number' && Number.isFinite(now);
  const effectiveNow = nowValid ? now : 0;
  const nowReason = nowValid ? 'accepted' : (now == null ? 'missing-default-zero' : 'invalid-default-zero');
  const created = finiteTimestamp(rec, 'created');
  const createdAlias = finiteTimestamp(rec, 'createdAt');
  const lastActivated = finiteTimestamp(rec, 'lastActivated');

  let createdAt;
  let createdSource;
  if (created.value != null) { createdAt = created.value; createdSource = 'created'; }
  else if (createdAlias.value != null) { createdAt = createdAlias.value; createdSource = 'createdAt'; }
  else { createdAt = null; createdSource = 'missing'; }

  let referenceAt;
  let timestampReason;
  if (lastActivated.value != null) {
    referenceAt = lastActivated.value;
    timestampReason = 'lastActivated';
  } else if (createdAt != null) {
    referenceAt = createdAt;
    timestampReason = lastActivated.reason === 'missing'
      ? 'fallback-to-' + createdSource : 'invalid-lastActivated-fallback-to-' + createdSource;
  } else {
    referenceAt = effectiveNow;
    timestampReason = 'missing-or-invalid-timestamps-default-age-zero';
  }
  const rawAgeDays = (effectiveNow - referenceAt) / DAY;
  const futureFloored = rawAgeDays < 0;
  const ageDays = Math.min(MAX_AGE_DAYS, Math.max(0, rawAgeDays));
  const ageReason = futureFloored ? 'future-time-floored-to-zero'
    : (rawAgeDays > MAX_AGE_DAYS ? 'past-age-capped-to-finite' : timestampReason);

  return {
    importance: importance.value,
    arousal: arousal.value,
    activationCount: activation.value,
    resolved,
    ageDays,
    now: effectiveNow,
    audit: {
      importance: importance.audit,
      arousal: arousal.audit,
      activationCount: activation.audit,
      resolved: { input: displayRaw(resolvedRaw, resolvedPresent), effective: resolved, reason: resolvedReason },
      now: { input: displayRaw(now, now !== undefined), effective: effectiveNow, reason: nowReason },
      created: { input: displayRaw(rec.created, own(rec, 'created')), effective: created.value, reason: created.reason },
      createdAt: { input: displayRaw(rec.createdAt, own(rec, 'createdAt')), effective: createdAlias.value, reason: createdAlias.reason },
      lastActivated: { input: displayRaw(rec.lastActivated, own(rec, 'lastActivated')), effective: lastActivated.value, reason: lastActivated.reason },
      ageDays: { effective: ageDays, referenceField: timestampReason, reason: ageReason }
    }
  };
}

function decayComponent(fields) {
  const lambda = fields.resolved ? 0.12 : 0.05;
  return Math.exp(-lambda * fields.ageDays);
}

function finishCandidate(name, fields, components, value, extra) {
  if (!Number.isFinite(value) || !Object.values(components).every(Number.isFinite)) {
    throw new Error(name + ' emitted a nonfinite component or value');
  }
  return {
    value,
    components,
    normalized: Object.assign({
      label: FORMULA_LABEL,
      fields: fields.audit,
      pinnedExcludedFromValue: true
    }, extra || {})
  };
}

function candidateA(record, now) {
  const f = normalizeInputs(record, now);
  const activation = 1 + f.activationCount / (f.activationCount + 300);
  const decay = decayComponent(f);
  const emotion = 1 + f.arousal * 0.8;
  const components = { importance: f.importance, activation, decay, emotion };
  const product = f.importance * activation * decay * emotion;
  return finishCandidate('A', f, components, Math.round(product * 100) / 100, {
    candidate: 'A · Normalized Legacy',
    formula: 'round2(importance × legacyActivation × decay × emotion)',
    activationBound: '[1, 2)'
  });
}

function candidateBWithParameters(record, now, parameters) {
  const params = Object.assign({ gain: 0.5, k: 100 }, parameters || {});
  if (!Number.isFinite(params.gain) || params.gain < 0 || !Number.isFinite(params.k) || params.k <= 0) {
    throw new Error('B parameter probe requires finite gain >= 0 and finite k > 0');
  }
  const f = normalizeInputs(record, now);
  const activation = 1 + params.gain * f.activationCount / (f.activationCount + params.k);
  const decay = decayComponent(f);
  const emotion = 1 + f.arousal * 0.8;
  const components = { importance: f.importance, activation, decay, emotion };
  const product = f.importance * activation * decay * emotion;
  return finishCandidate('B', f, components, Math.round(product * 100) / 100, {
    candidate: 'B · Alternative Activation Saturation',
    formula: 'round2(importance × (1 + gain × count/(count+k)) × decay × emotion)',
    activationParameters: { gain: params.gain, k: params.k, frozen: false },
    activationBound: '[1, 1+gain] in finite-precision output; 1+gain is the asymptotic limit'
  });
}

function candidateB(record, now) {
  return candidateBWithParameters(record, now, { gain: 0.5, k: 100 });
}

function candidateCWithWeights(record, now, weights) {
  const w = Object.assign({}, C_WEIGHTS, weights || {});
  const weightKeys = ['importance', 'activation', 'decay', 'emotion'];
  if (!weightKeys.every(key => Number.isFinite(w[key]) && w[key] >= 0)
    || Math.abs(weightKeys.reduce((sum, key) => sum + w[key], 0) - 1) > 1e-12) {
    throw new Error('C parameter probe requires four finite nonnegative weights summing to one');
  }
  const f = normalizeInputs(record, now);
  const importance = (f.importance - 1) / 9;
  const activation = f.activationCount / (f.activationCount + 300);
  const decay = decayComponent(f);
  const emotion = f.arousal;
  const components = { importance, activation, decay, emotion };
  const weighted = w.importance * importance
    + w.activation * activation
    + w.decay * decay
    + w.emotion * emotion;
  return finishCandidate('C', f, components, 1 + 9 * weighted, {
    candidate: 'C · Bounded Components',
    formula: '1 + 9 × weighted normalized components',
    weights: w,
    provisional: 'NOT FROZEN · SHADOW ONLY',
    valueBound: '[1, 10]'
  });
}

function candidateC(record, now) {
  return candidateCWithWeights(record, now, C_WEIGHTS);
}

const CANDIDATES = Object.freeze({ A: candidateA, B: candidateB, C: candidateC });

function materializeSpecial(value) {
  if (value === '$NaN') return NaN;
  if (value === '$Infinity') return Infinity;
  if (value === '$-Infinity') return -Infinity;
  if (value === '$undefined') return undefined;
  if (Array.isArray(value)) return value.map(materializeSpecial);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(key => { out[key] = materializeSpecial(value[key]); });
    return out;
  }
  return value;
}

function loadCases(root) {
  const file = path.join(root || ROOT, 'tests/fixtures/memory-value-v2/cases.json');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  return fixture.cases.map(entry => Object.assign({}, entry, {
    record: materializeSpecial(entry.record),
    now: materializeSpecial(entry.now)
  }));
}

function sourceText(root, relativePath) {
  return fs.readFileSync(path.join(root || ROOT, relativePath), 'utf8');
}

function requirePattern(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match) throw new Error('producer source pattern missing: ' + label);
  return match;
}

function numericCapture(source, pattern, label, group) {
  const match = requirePattern(source, pattern, label);
  const value = Number(match[group || 1]);
  if (!Number.isFinite(value)) throw new Error('producer literal is not finite: ' + label);
  return value;
}

function deriveProducerDefaults(root) {
  const base = root || ROOT;
  const descriptorPath = 'tests/fixtures/memory-value-v2/producer-defaults.json';
  const descriptor = JSON.parse(sourceText(base, descriptorPath));
  const loaded = Object.create(null);
  descriptor.producers.forEach(producer => {
    producer.sourceFiles.forEach(file => {
      if (!loaded[file]) loaded[file] = sourceText(base, file);
    });
    const combined = producer.sourceFiles.map(file => loaded[file]).join('\n');
    producer.anchors.forEach(anchor => {
      if (!combined.includes(anchor)) throw new Error('producer anchor missing: ' + producer.id + ' / ' + anchor);
    });
  });
  const memory = loaded['assets/js/memory.js'] || sourceText(base, 'assets/js/memory.js');
  const diary = loaded['assets/js/active-diary/diary.js'] || sourceText(base, 'assets/js/active-diary/diary.js');
  const activeDiary = loaded['assets/js/active-diary.js'] || sourceText(base, 'assets/js/active-diary.js');
  const activity = loaded['assets/js/activity/activity-runtime.js'] || sourceText(base, 'assets/js/activity/activity-runtime.js');
  const roleDm = loaded['assets/js/role-dm.js'] || sourceText(base, 'assets/js/role-dm.js');
  const roleDmCore = loaded['assets/js/role-dm-core.js'] || sourceText(base, 'assets/js/role-dm-core.js');

  const generatedImportance = requirePattern(memory,
    /const importance=Math\.max\((\d+),Math\.min\((\d+),parseInt\(parsedCandidate\.importance\)\|(\|)(\d+)\)\);/,
    'generated importance normalization');
  const generatedArousal = requirePattern(memory,
    /const arousal=\(v=>isNaN\(v\)\?(\d+(?:\.\d+)?):Math\.max\((\d+(?:\.\d+)?),Math\.min\((\d+(?:\.\d+)?),v\)\)\)\(parseFloat\(parsedCandidate\.arousal\)\);/,
    'generated arousal normalization');
  requirePattern(memory, /const resolved=parsedCandidate\.resolved===true\|\|String\(parsedCandidate\.resolved\)\.includes\('是'\);/,
    'generated resolved normalization');

  const manualImportance = requirePattern(memory,
    /importance:Math\.max\((\d+),Math\.min\((\d+),parseInt\(document\.getElementById\('mem-f-importance'\)\.value\)\|(\|)(\d+)\)\),/,
    'manual importance normalization');
  const manualArousal = requirePattern(memory,
    /arousal:\(v=>isNaN\(v\)\?(\d+(?:\.\d+)?):Math\.max\((\d+(?:\.\d+)?),Math\.min\((\d+(?:\.\d+)?),v\)\)\)\(parseFloat\(document\.getElementById\('mem-f-arousal'\)\.value\)\),/,
    'manual arousal normalization');
  requirePattern(memory, /resolved:document\.getElementById\('mem-f-resolved'\)\.value==='true',/,
    'manual resolved control');

  const quickStart = memory.indexOf('async function quickCreateMemory(data)');
  const quickEnd = memory.indexOf('/* ====================== UNDERSTANDING', quickStart);
  if (quickStart < 0 || quickEnd < 0) throw new Error('quickCreateMemory source boundary missing');
  const quick = memory.slice(quickStart, quickEnd);
  const quickImportanceDefault = numericCapture(quick, /importance:data\.importance\|\|(\d+(?:\.\d+)?)/,
    'quickCreate importance falsey fallback');
  const quickArousalDefault = numericCapture(quick, /arousal:data\.arousal!=null\?data\.arousal:(\d+(?:\.\d+)?)/,
    'quickCreate arousal nullish fallback');
  requirePattern(quick, /resolved:data\.resolved!=null\?!!data\.resolved:false/, 'quickCreate resolved default');
  requirePattern(quick, /activationCount:0,created:Date\.now\(\),lastActivated:Date\.now\(\)/, 'quickCreate initial telemetry');

  const diaryThreshold = numericCapture(diary, /if\(importance<(\d+)\)return null;/,
    'diary writer admission minimum');
  const consolidationThreshold = numericCapture(activeDiary, /if\(importance<(\d+)\)return null;/,
    'consolidation admission minimum');
  const consolidationArousal = numericCapture(activeDiary, /arousal:(\d+(?:\.\d+)?),importance:importance/,
    'consolidation arousal literal');
  const activityMatch = requirePattern(activity,
    /source:activity\.type,sourceId:activity\.id,domain:'陪伴',[\s\S]{0,120}?arousal:(\d+(?:\.\d+)?),importance:(\d+(?:\.\d+)?),resolved:false/,
    'activity producer defaults');
  const roleDmThreshold = numericCapture(roleDmCore, /MEMORY_MIN_IMPORTANCE\s*=\s*(\d+)/,
    'role_dm admission minimum');
  const roleDmImportance = requirePattern(roleDm,
    /importance:\s*Math\.max\((\d+),\s*Math\.min\((\d+),\s*Number\(chosen\.importance\)\s*\|\|\s*(\d+)\)\)/,
    'role_dm importance normalization');
  const roleDmArousal = numericCapture(roleDm, /arousal:\s*(\d+(?:\.\d+)?),/,
    'role_dm arousal literal');
  const generatedSource = requirePattern(memory, /source:isGroup\?'group_chat':'chat'/,
    'chat/group source producer');
  void generatedSource;
  const generatedOutput = {
    importanceDefault: Number(generatedImportance[4]),
    importanceDomain: [Number(generatedImportance[1]), Number(generatedImportance[2])],
    arousalDefault: Number(generatedArousal[1]),
    arousalDomain: [Number(generatedArousal[2]), Number(generatedArousal[3])],
    resolvedDefault: false
  };
  const manualOutput = {
    importanceDefault: Number(manualImportance[4]),
    importanceDomain: [Number(manualImportance[1]), Number(manualImportance[2])],
    arousalDefault: Number(manualArousal[1]),
    arousalDomain: [Number(manualArousal[2]), Number(manualArousal[3])],
    resolvedDefault: false
  };

  const specs = {
    manual: Object.assign({ basis: 'UI defaults', rawSource: 'manual' }, manualOutput),
    chat: Object.assign({ basis: 'shared generated-memory pipeline', rawSource: 'chat' }, generatedOutput),
    group_chat: Object.assign({ basis: 'shared generated-memory pipeline', rawSource: 'group_chat' }, generatedOutput),
    blog: Object.assign({ basis: 'shared generated-memory pipeline', rawSource: 'blog' }, generatedOutput),
    letter: Object.assign({ basis: 'shared generated-memory pipeline', rawSource: 'letter' }, generatedOutput),
    diary: {
      basis: 'admitted writer input; representative is extracted minimum', rawSource: 'diary',
      importanceDefault: diaryThreshold, importanceDomain: [diaryThreshold, 10],
      arousalDefault: null, arousalDomain: null, resolvedDefault: false, arousalFieldWritten: false,
      importanceSource: 'admission threshold'
    },
    consolidation: {
      basis: 'admitted writer input; representative is extracted minimum', rawSource: 'consolidation',
      importanceDefault: consolidationThreshold, importanceDomain: [consolidationThreshold, 10],
      arousalDefault: consolidationArousal, arousalDomain: [0, 1], resolvedDefault: false,
      importanceSource: 'admission threshold'
    },
    coread: {
      basis: 'activity writer literal', rawSource: 'coread',
      importanceDefault: Number(activityMatch[2]), importanceDomain: [Number(activityMatch[2]), Number(activityMatch[2])],
      arousalDefault: Number(activityMatch[1]), arousalDomain: [Number(activityMatch[1]), Number(activityMatch[1])], resolvedDefault: false
    },
    cinema: {
      basis: 'activity writer literal', rawSource: 'cinema',
      importanceDefault: Number(activityMatch[2]), importanceDomain: [Number(activityMatch[2]), Number(activityMatch[2])],
      arousalDefault: Number(activityMatch[1]), arousalDomain: [Number(activityMatch[1]), Number(activityMatch[1])], resolvedDefault: false
    },
    role_dm: {
      basis: 'admitted writer input; representative is extracted minimum', rawSource: 'role_dm',
      importanceDefault: roleDmThreshold, importanceDomain: [roleDmThreshold, Number(roleDmImportance[2])],
      arousalDefault: roleDmArousal, arousalDomain: [roleDmArousal, roleDmArousal], resolvedDefault: false,
      importanceSource: 'admission threshold'
    }
  };

  const quickSemantics = {
    importanceFalseyFallback: quickImportanceDefault,
    arousalMissingFallback: quickArousalDefault,
    roleDmZeroIsAdmitted: 0 >= roleDmThreshold,
    roleDmZeroWouldQuickCreateAs: (0 || quickImportanceDefault)
  };
  return { descriptor, specs, quickSemantics };
}

function makeProducerRecord(spec, now, overrides) {
  const record = {
    id: 'producer-' + spec.rawSource,
    importance: spec.importanceDefault,
    activationCount: 0,
    resolved: spec.resolvedDefault,
    rawSource: spec.rawSource,
    created: now,
    lastActivated: now,
    pinned: false
  };
  if (spec.arousalFieldWritten !== false && spec.arousalDefault != null) record.arousal = spec.arousalDefault;
  return Object.assign(record, overrides || {});
}

function scoreSet(record, now) {
  return {
    legacy: legacyValue(record, now),
    A: candidateA(record, now).value,
    B: candidateB(record, now).value,
    C: candidateC(record, now).value
  };
}

function producerMatrix(root, now) {
  const derived = deriveProducerDefaults(root);
  const at = now == null ? DEFAULT_NOW : now;
  const rows = Object.keys(derived.specs).map(id => {
    const spec = derived.specs[id];
    const record = makeProducerRecord(spec, at);
    return {
      producer: id,
      basis: spec.basis,
      fields: {
        importance: record.importance,
        arousal: own(record, 'arousal') ? record.arousal : '<missing → scorer default>',
        resolved: record.resolved
      },
      legacyAndCandidates: scoreSet(record, at),
      inputDomain: {
        importance: spec.importanceDomain,
        arousal: spec.arousalDomain,
        importanceSource: spec.importanceSource || 'fixed/default'
      }
    };
  });
  const rawDefaultBias = {};
  ['legacy', 'A', 'B', 'C'].forEach(name => {
    const values = rows.map(row => row.legacyAndCandidates[name]).filter(Number.isFinite);
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    rawDefaultBias[name] = { min, max, range: max - min, ratio: min === 0 ? null : max / min };
  });
  const normalizedFieldControl = rows.map(row => {
    const record = {
      id: 'same-source-control-record',
      importance: 5, arousal: 0.3, activationCount: 0, resolved: false,
      created: at, lastActivated: at,
      source: row.producer, rawSource: row.producer, kind: row.producer
    };
    return { producer: row.producer, scores: scoreSet(record, at) };
  });
  return {
    producerCount: rows.length,
    rows,
    RAW_DEFAULT_BIAS: rawDefaultBias,
    NORMALIZED_FIELD_CONTROL: normalizedFieldControl,
    quickCreateSemantics: derived.quickSemantics,
    sourceDescriptors: derived.descriptor.producers.map(p => ({ id: p.id, sourceFiles: p.sourceFiles }))
  };
}

function assertKnownLegacyBehavior(id, observed, details) {
  if (!observed) throw new Error('known Legacy characterization changed: ' + id + ' ' + JSON.stringify(details || {}));
  return { id, status: 'LEGACY_EXPECTED_FAIL', details: details || null };
}

function sign(value) { return value < 0 ? -1 : (value > 0 ? 1 : 0); }

function averageRanks(values) {
  const sorted = values.map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < sorted.length) {
    let end = i + 1;
    while (end < sorted.length && sorted[end].value === sorted[i].value) end++;
    const rank = ((i + 1) + end) / 2;
    for (let j = i; j < end; j++) ranks[sorted[j].index] = rank;
    i = end;
  }
  return ranks;
}

function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / rx.length;
  const my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let numerator = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    const ax = rx[i] - mx, ay = ry[i] - my;
    numerator += ax * ay; dx += ax * ax; dy += ay * ay;
  }
  return dx === 0 || dy === 0 ? null : numerator / Math.sqrt(dx * dy);
}

function rankRows(rows, scoreOf) {
  return rows.map(row => ({ id: row.id, score: scoreOf(row) }))
    .filter(row => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function pairwiseOrderMetrics(rows, scoreA, scoreB) {
  let inversions = 0, orderChanges = 0, comparedPairs = 0, tiesA = 0, tiesB = 0, tiesBoth = 0, concordant = 0;
  const examples = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a1 = scoreA(rows[i]), a2 = scoreA(rows[j]);
      const b1 = scoreB(rows[i]), b2 = scoreB(rows[j]);
      if (![a1, a2, b1, b2].every(Number.isFinite)) continue;
      const left = sign(a1 - a2), right = sign(b1 - b2);
      comparedPairs++;
      if (left === 0) tiesA++;
      if (right === 0) tiesB++;
      if (left === 0 && right === 0) tiesBoth++;
      else if (left !== 0 && left === right) concordant++;
      if (left !== right) {
        orderChanges++;
        if (left !== 0 && right !== 0) inversions++;
        if (examples.length < 12) examples.push({
          pair: [rows[i].id, rows[j].id], orderA: left, orderB: right,
          scoresA: [a1, a2], scoresB: [b1, b2]
        });
      }
    }
  }
  return {
    comparedPairs, inversions, inversionPercent: comparedPairs ? (100 * inversions / comparedPairs) : 0,
    orderChanges, orderChangePercent: comparedPairs ? (100 * orderChanges / comparedPairs) : 0,
    tiesA, tiesB, tiesBoth,
    kendallTau: comparedPairs ? (concordant - inversions) / comparedPairs : null,
    examples
  };
}

function setChanged(a, b) {
  if (a.length !== b.length) return true;
  const right = new Set(b);
  return a.some(item => !right.has(item));
}

function jaccard(a, b) {
  const left = new Set(a), right = new Set(b);
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let intersection = 0;
  left.forEach(value => { if (right.has(value)) intersection++; });
  return intersection / union.size;
}

function topKMetrics(rows, scoreOf, baselineName, candidateName) {
  const baseline = rankRows(rows, row => scoreOf(baselineName, row));
  const candidate = rankRows(rows, row => scoreOf(candidateName, row));
  const candidateScoreById = new Map(candidate.map(row => [row.id, row.score]));
  const top = k => ({
    baseline: baseline.slice(0, k).map(row => row.id),
    candidate: candidate.slice(0, k).map(row => row.id)
  });
  const top1 = top(1), top3 = top(3), top5 = top(5);
  return {
    top1Change: setChanged(top1.baseline, top1.candidate),
    top3SetChange: setChanged(top3.baseline, top3.candidate),
    top5SetChange: setChanged(top5.baseline, top5.candidate),
    top3Jaccard: jaccard(top3.baseline, top3.candidate),
    top5Jaccard: jaccard(top5.baseline, top5.candidate),
    top1, top3, top5,
    spearman: spearman(
      baseline.map(row => row.score),
      baseline.map(row => candidateScoreById.get(row.id))
    ),
    kendallTau: pairwiseOrderMetrics(rows,
      row => scoreOf(baselineName, row),
      row => scoreOf(candidateName, row)).kendallTau
  };
}

function pairwiseComparisons(rows, scorerMap) {
  const names = Object.keys(scorerMap);
  const comparisons = {};
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      comparisons[a + ' ↔ ' + b] = pairwiseOrderMetrics(
        rows,
        row => scorerMap[a](row),
        row => scorerMap[b](row)
      );
    }
  }
  return comparisons;
}

function validRankPool(cases) {
  return cases.filter(entry => entry.tags.includes('rank-pool')
    && !entry.tags.includes('invalid-domain')
    && !(entry.record && entry.record.pinned === true));
}

function makeNeutralRecord(now, changes) {
  return Object.assign({
    id: 'sensitivity', importance: 5, arousal: 0.3, activationCount: 0,
    resolved: false, created: now, lastActivated: now
  }, changes || {});
}

function sensitivityGenerator(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const rows = [];
  const add = (axis, value, record, note) => {
    const legacy = legacyValue(record, at);
    const candidates = {};
    Object.keys(CANDIDATES).forEach(name => { candidates[name] = CANDIDATES[name](record, at).value; });
    rows.push({ axis, input: value, note: note || null, legacy, candidates });
  };
  [0, 1, 2, 5, 10, 11, -1, NaN, Infinity].forEach(value =>
    add('importance', displayRaw(value, true), makeNeutralRecord(at, { importance: value })));
  [0, 1, 5, 10, 50, 100, 300, 500, 1000].forEach(value =>
    add('activationCount', value, makeNeutralRecord(at, { activationCount: value })));
  [365, 180, 30, 7, 1, 0, -1, -30].forEach(value => {
    const ts = at - value * DAY;
    add('ageDays', value, makeNeutralRecord(at, { created: ts, lastActivated: ts }), value < 0 ? 'future timestamp' : null);
  });
  [0, 0.001, 0.01, 0.05, 0.1, 0.2, 0.299, 0.3, 0.5, 1].forEach(value =>
    add('arousal', value, makeNeutralRecord(at, { arousal: value })));
  [false, true].forEach(value => {
    const ts = at - 30 * DAY;
    add('resolved', value, makeNeutralRecord(at, { resolved: value, created: ts, lastActivated: ts }));
  });
  return rows;
}

function monotonicViolationScanner(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const valueFunctions = {
    legacy: record => legacyValue(record, at),
    A: record => candidateA(record, at).value,
    B: record => candidateB(record, at).value,
    C: record => candidateC(record, at).value
  };
  const axes = {
    activation: { values: [0, 1, 5, 10, 50, 100, 300, 1000], record: value => makeNeutralRecord(at, { activationCount: value }) },
    ageDays: { values: [0, 1, 7, 30, 90, 180, 365], record: value => makeNeutralRecord(at, { created: at - value * DAY, lastActivated: at - value * DAY }) },
    arousal: { values: [0, 0.001, 0.01, 0.05, 0.1, 0.2, 0.299, 0.3, 0.5, 1], record: value => makeNeutralRecord(at, { arousal: value }) },
    importance: { values: [1, 2, 5, 10], record: value => makeNeutralRecord(at, { importance: value }) }
  };
  const result = {};
  Object.keys(valueFunctions).forEach(scorer => {
    result[scorer] = {};
    Object.keys(axes).forEach(axis => {
      const spec = axes[axis];
      const scores = spec.values.map(value => ({ input: value, value: valueFunctions[scorer](spec.record(value)) }));
      const violations = [];
      for (let i = 1; i < scores.length; i++) {
        const violates = axis === 'ageDays'
          ? scores[i].value > scores[i - 1].value + 1e-12
          : scores[i].value < scores[i - 1].value - 1e-12;
        if (Number.isFinite(scores[i - 1].value) && Number.isFinite(scores[i].value) && violates) {
          violations.push({ from: scores[i - 1], to: scores[i] });
        }
      }
      result[scorer][axis] = { declaredMonotonic: scorer !== 'legacy' || axis !== 'arousal', scores, violations, violationCount: violations.length };
    });
  });
  return result;
}

function legacyCharacterization(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const arousalSweep = [0, 0.001, 0.01, 0.05, 0.1, 0.2, 0.299, 0.3, 0.5, 1].map(arousal => {
    const productionScore = legacyValue(makeNeutralRecord(at, { arousal }), at);
    /* The large-importance probe makes the existing round2 cent precision
       negligible so the component can be inferred from production output.
       It is diagnostic only and is not a valid producer record. */
    const diagnosticImportance = 100000000;
    const diagnosticScore = legacyValue(makeNeutralRecord(at, { arousal, importance: diagnosticImportance }), at);
    return {
      arousal,
      score: productionScore,
      productionScorerDerivedEmotionFactor: diagnosticScore / diagnosticImportance,
      factorProbe: 'round2 precision probe; importance is outside producer domain'
    };
  });
  const importanceSweep = [0, 1, 2, 5, 10, 11, -1, NaN, Infinity].map(importance => ({
    importance: displayRaw(importance, true),
    classification: Number.isFinite(importance) && importance >= 1 && importance <= 10 ? 'VALID_DOMAIN' : 'INVALID_DOMAIN',
    score: displayRaw(legacyValue(makeNeutralRecord(at, { importance }), at), true)
  }));
  const ages = [365, 180, 30, 7, 1, 0, -1, -30];
  const timestampSweep = ages.map(ageDays => {
    const timestamp = at - ageDays * DAY;
    const record = makeNeutralRecord(at, { created: timestamp, lastActivated: timestamp });
    return {
      ageDays,
      classification: ageDays < 0 ? 'INVALID_DOMAIN_FUTURE' : 'VALID_DOMAIN',
      unresolved: legacyValue(record, at),
      resolved: legacyValue(Object.assign({}, record, { resolved: true }), at)
    };
  });
  const activationSweep = [0, 1, 5, 10, 50, 100, 300, 1000].map(activationCount => {
    const score = legacyValue(makeNeutralRecord(at, { importance: 10, arousal: 1, activationCount }), at);
    const baseline = legacyValue(makeNeutralRecord(at, { importance: 10, arousal: 1, activationCount: 0 }), at);
    return { activationCount, score, scoreRatioToCountZero: baseline === 0 ? null : score / baseline };
  });
  const createdAtOnly = { id: 'createdAt-only', createdAt: at, importance: 5, arousal: 0.3, activationCount: 0, resolved: false };
  const noCreated = { id: 'no-created', importance: 5, arousal: 0.3, activationCount: 0, resolved: false };
  const current = makeNeutralRecord(at, { importance: 5, arousal: 0.3, activationCount: 0 });
  const futureScores = [0, 1, 30].map(days => ({
    futureDays: days,
    score: legacyValue(Object.assign({}, current, { lastActivated: at + days * DAY }), at)
  }));
  const round2Tie = {
    ageDays: [365, 1000],
    scores: [365, 1000].map(days => {
      const stamp = at - days * DAY;
      return legacyValue(makeNeutralRecord(at, { created: stamp, lastActivated: stamp }), at);
    })
  };
  return {
    arousalSweep,
    LEGACY_AROUSAL_MONOTONIC: arousalSweep.every((row, i) => i === 0 || row.score >= arousalSweep[i - 1].score),
    importanceSweep,
    timestampSweep,
    activationSweep,
    resolvedUnresolvedAt30d: timestampSweep.find(row => row.ageDays === 30),
    futureTimestampBoost: {
      baseline: futureScores[0].score,
      plus1d: futureScores[1].score,
      plus30d: futureScores[2].score
    },
    createdAtAlias: {
      createdAtOnly: legacyValue(createdAtOnly, at),
      noCreated: legacyValue(noCreated, at),
      productionTreatsCreatedAtAsAlias: legacyValue(createdAtOnly, at) !== legacyValue(noCreated, at)
    },
    round2ZeroAndTie: round2Tie,
    legacyDebt: [
      'arousal falsey fallback discontinuity at exact zero',
      'importance zero falsey fallback to five',
      'future timestamps amplify exponential decay above one',
      'createdAt-only payload is not read by production scorer',
      'two-decimal rounding collapses sufficiently old scores to zero/ties'
    ]
  };
}

function deterministicFuzz(seed, count, now) {
  let state = (seed == null ? 0x21A3B : seed) >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const pool = [undefined, null, 0, -1, 0.001, 1, 5, 10, 11, 1e300, NaN, Infinity, -Infinity, '5', 'bad'];
  const timestamps = [undefined, null, 0, -DAY, now, now + DAY, NaN, Infinity, '1750000000000'];
  const length = count == null ? 512 : count;
  const at = now == null ? DEFAULT_NOW : now;
  const candidateFinite = { A: true, B: true, C: true };
  const deterministic = { A: true, B: true, C: true };
  const explained = { A: true, B: true, C: true };
  let legacyNonfinite = 0;
  const samples = [];
  for (let i = 0; i < length; i++) {
    const record = {
      id: 'fuzz-' + i,
      importance: pool[Math.floor(random() * pool.length)],
      arousal: pool[Math.floor(random() * pool.length)],
      activationCount: pool[Math.floor(random() * pool.length)],
      resolved: pool[Math.floor(random() * pool.length)],
      created: timestamps[Math.floor(random() * timestamps.length)],
      lastActivated: timestamps[Math.floor(random() * timestamps.length)],
      createdAt: timestamps[Math.floor(random() * timestamps.length)],
      query: 'synthetic-only',
      visibility: ['public', 'private', 'only', 'except'][Math.floor(random() * 4)],
      cooldownFactor: random(),
      exposureCount: Math.floor(random() * 50)
    };
    const legacy = legacyValue(record, at);
    if (!Number.isFinite(legacy)) legacyNonfinite++;
    for (const name of Object.keys(CANDIDATES)) {
      const before = JSON.stringify(record, (_k, value) => {
        if (typeof value === 'number' && Number.isNaN(value)) return '$NaN';
        if (value === Infinity) return '$Infinity';
        if (value === -Infinity) return '$-Infinity';
        return value;
      });
      const first = CANDIDATES[name](record, at);
      const second = CANDIDATES[name](record, at);
      const after = JSON.stringify(record, (_k, value) => {
        if (typeof value === 'number' && Number.isNaN(value)) return '$NaN';
        if (value === Infinity) return '$Infinity';
        if (value === -Infinity) return '$-Infinity';
        return value;
      });
      candidateFinite[name] = candidateFinite[name] && Number.isFinite(first.value)
        && Object.values(first.components).every(Number.isFinite);
      deterministic[name] = deterministic[name] && JSON.stringify(first) === JSON.stringify(second);
      explained[name] = explained[name] && !!first.normalized.fields
        && Object.keys(first.normalized.fields).length >= 8;
      if (before !== after) throw new Error(name + ' mutated fuzz record ' + i);
      if (samples.length < 8) samples.push({ id: record.id, candidate: name, value: first.value, normalized: first.normalized.fields });
    }
  }
  return {
    seed: seed == null ? 0x21A3B : seed,
    cases: length,
    candidateFinite,
    deterministic,
    normalizationExplained: explained,
    legacyNonfiniteCases: legacyNonfinite,
    samples
  };
}

function propertyReport(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const base = makeNeutralRecord(at);
  const queries = ['A', 'B', '', 'a long query with unmatched synthetic tokens'];
  const cdCases = [
    { lastExposureTurn: 1, exposureCount: 1, cooldownFactor: 0.2, turnIndex: 2 },
    { lastExposureTurn: 999, exposureCount: 500, cooldownFactor: 1, turnIndex: 999 },
    { lastExposureTurn: null, exposureCount: 0, cooldownFactor: 0.05, turnIndex: 0 }
  ];
  const acl = [
    { visibility: 'public' }, { visibility: 'private' },
    { visibility: 'only', visibleTo: ['role-x'] },
    { visibility: 'except', excludeFrom: ['role-x'] },
    { isGroup: true, groupMemEnabled: false, visibleTo: ['role-y'] }
  ];
  const sourceTypes = ['manual', 'chat', 'group_chat', 'blog', 'letter', 'diary', 'consolidation', 'coread', 'cinema', 'role_dm'];
  const report = {};
  for (const [name, candidate] of Object.entries(CANDIDATES)) {
    const expected = candidate(base, at).value;
    report[name] = {
      P1_queryInvariance: queries.every(() => candidate(base, at).value === expected),
      P2_visibilityInvariance: acl.every(extra => candidate(Object.assign({}, base, extra), at).value === expected),
      P3_cooldownStateInvariance: cdCases.every(extra => candidate(Object.assign({}, base, extra), at).value === expected),
      P4_sourceTypeInvariance: sourceTypes.every(source => candidate(Object.assign({}, base, { source, rawSource: source, kind: source }), at).value === expected),
      P5_validDomainFinite: Number.isFinite(expected),
      P6_activationMonotonicity: [0, 1, 5, 10, 50, 100, 300, 1000].every((value, i, values) =>
        i === 0 || candidate(makeNeutralRecord(at, { activationCount: value }), at).value
          >= candidate(makeNeutralRecord(at, { activationCount: values[i - 1] }), at).value),
      P7_ageMonotonicity: [0, 1, 7, 30, 90, 180, 365].every((value, i, values) => {
        if (i === 0) return true;
        const current = makeNeutralRecord(at, { created: at - value * DAY, lastActivated: at - value * DAY });
        const previous = makeNeutralRecord(at, { created: at - values[i - 1] * DAY, lastActivated: at - values[i - 1] * DAY });
        return candidate(current, at).value <= candidate(previous, at).value;
      }),
      P8_missingValueDeterminism: JSON.stringify(candidate({ id: 'missing' }, at)) === JSON.stringify(candidate({ id: 'missing' }, at)),
      P9_pinnedExcludedFromNormalValue: candidate(Object.assign({}, base, { pinned: true }), at).value === expected,
      P10_noMutation: (() => {
        const record = Object.assign({}, base, { nested: { keep: true } });
        const before = JSON.stringify(record);
        candidate(record, at);
        return JSON.stringify(record) === before;
      })()
    };
  }
  const legacyValueAtBase = legacyValue(base, at);
  report.LEGACY = {
    P1_queryInvariance: queries.every(() => legacyValue(base, at) === legacyValueAtBase),
    P2_visibilityInvariance: acl.every(extra => legacyValue(Object.assign({}, base, extra), at) === legacyValueAtBase),
    P3_cooldownStateInvariance: cdCases.every(extra => legacyValue(Object.assign({}, base, extra), at) === legacyValueAtBase),
    P4_sourceTypeInvariance: sourceTypes.every(source => legacyValue(Object.assign({}, base, { source, rawSource: source, kind: source }), at) === legacyValueAtBase),
    P5_validDomainFinite: Number.isFinite(legacyValue(base, at)),
    P6_activationMonotonicity: [0, 1, 5, 10, 50, 100, 300, 1000].every((value, i, values) =>
      i === 0 || legacyValue(makeNeutralRecord(at, { activationCount: value }), at)
        >= legacyValue(makeNeutralRecord(at, { activationCount: values[i - 1] }), at)),
    P7_ageMonotonicity: [0, 1, 7, 30, 90, 180, 365].every((value, i, values) => {
      if (i === 0) return true;
      const current = makeNeutralRecord(at, { created: at - value * DAY, lastActivated: at - value * DAY });
      const previous = makeNeutralRecord(at, { created: at - values[i - 1] * DAY, lastActivated: at - values[i - 1] * DAY });
      return legacyValue(current, at) <= legacyValue(previous, at);
    }),
    P8_missingValueDeterminism: legacyValue({ id: 'missing' }, at) === legacyValue({ id: 'missing' }, at),
    P9_pinnedExcludedFromNormalValue: legacyValue(Object.assign({}, base, { pinned: true }), at) === legacyValueAtBase,
    P10_noMutation: (() => {
      const record = Object.assign({}, base, { nested: { keep: true } });
      const before = JSON.stringify(record);
      legacyValue(record, at);
      return JSON.stringify(record) === before;
    })()
  };
  return report;
}

function metricReport(cases, now) {
  const pool = validRankPool(cases);
  const scorers = {
    Legacy: row => legacyValue(row.record, row.now == null ? now : row.now),
    A: row => candidateA(row.record, row.now == null ? now : row.now).value,
    B: row => candidateB(row.record, row.now == null ? now : row.now).value,
    C: row => candidateC(row.record, row.now == null ? now : row.now).value
  };
  const pairwise = pairwiseComparisons(pool, scorers);
  const topK = {};
  for (const name of ['A', 'B', 'C']) {
    topK['Legacy ↔ ' + name] = topKMetrics(pool, (candidateName, row) => scorers[candidateName](row), 'Legacy', name);
  }
  for (const [a, b] of [['A', 'B'], ['A', 'C'], ['B', 'C']]) {
    topK[a + ' ↔ ' + b] = topKMetrics(pool, (candidateName, row) => scorers[candidateName](row), a, b);
  }
  return { rankPoolCount: pool.length, pairwise, topK };
}

function loadScenarioFamilies(root) {
  return JSON.parse(sourceText(root || ROOT, 'tests/fixtures/memory-value-v2/scenario-families.json'));
}

function expandScenarioFamilies(root, now) {
  const fixture = loadScenarioFamilies(root);
  const at = now == null ? fixture.now : now;
  const families = fixture.scenarioFamilies.map(family => ({
    id: family.id,
    name: family.name,
    mode: family.mode,
    members: family.members.map(member => {
      const record = Object.assign({ id: family.id + ':' + member.id }, member.fields || {});
      if (member.timestampMode === 'future-last-activated') {
        record.created = at - Number(member.ageDays || 0) * DAY;
        record.lastActivated = at + Number(member.futureDays || 0) * DAY;
      } else if (member.timestampMode === 'createdAt-only') {
        record.createdAt = at - Number(member.ageDays || 0) * DAY;
      } else if (member.timestampMode === 'omit-times') {
        /* Sparse imported record: intentionally omit all timestamp fields. */
      } else {
        const timestamp = at - Number(member.ageDays || 0) * DAY;
        record.created = timestamp;
        record.lastActivated = timestamp;
      }
      return { id: record.id, record, now: at };
    })
  }));
  return { now: at, families, records: families.flatMap(family => family.members) };
}

function scorerFunction(name, options) {
  const opts = options || {};
  if (name === 'Legacy') return row => legacyValue(row.record || row, row.now == null ? DEFAULT_NOW : row.now);
  if (name === 'A') return row => candidateA(row.record || row, row.now == null ? DEFAULT_NOW : row.now).value;
  if (name === 'B') return row => candidateB(row.record || row, row.now == null ? DEFAULT_NOW : row.now).value;
  if (name === 'C') return row => candidateC(row.record || row, row.now == null ? DEFAULT_NOW : row.now).value;
  if (name === 'B-param') return row => candidateBWithParameters(row.record || row, row.now == null ? DEFAULT_NOW : row.now, opts).value;
  if (name === 'C-weight') return row => candidateCWithWeights(row.record || row, row.now == null ? DEFAULT_NOW : row.now, opts).value;
  throw new Error('unknown shadow scorer: ' + name);
}

function scenarioFamilyMetrics(expanded) {
  const names = ['Legacy', 'A', 'B', 'C'];
  return expanded.families.map(family => {
    const scoreRows = family.members.map(member => {
      const scores = {};
      for (const name of names) scores[name] = scorerFunction(name)(member);
      return { id: member.id, scores };
    });
    const pairwise = {};
    for (const [left, right] of [['Legacy', 'A'], ['Legacy', 'B'], ['Legacy', 'C'], ['A', 'B'], ['A', 'C'], ['B', 'C']]) {
      pairwise[left + ' ↔ ' + right] = pairwiseOrderMetrics(
        family.members,
        row => scorerFunction(left)(row),
        row => scorerFunction(right)(row)
      );
    }
    const orderings = {};
    for (const name of names) {
      orderings[name] = rankRows(family.members, row => scorerFunction(name)(row)).map(row => row.id);
    }
    return { id: family.id, name: family.name, mode: family.mode, scoreRows, orderings, pairwise };
  });
}

function firstIntegerCrossover(predicate, maximum) {
  const max = maximum == null ? 10000000 : maximum;
  if (!predicate(max)) return null;
  let low = 0, high = max;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (predicate(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

function activationImportanceCrossovers(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const lowerImportanceValues = [9, 8, 7, 6, 5, 4, 3, 2, 1];
  const scorers = ['Legacy', 'A', 'B', 'C'];
  const rows = [];
  for (const lowerImportance of lowerImportanceValues) {
    const high = { record: makeNeutralRecord(at, { importance: 10, activationCount: 0 }), now: at };
    const byScorer = {};
    for (const name of scorers) {
      const score = scorerFunction(name);
      const threshold = firstIntegerCrossover(count => score({
        record: makeNeutralRecord(at, { importance: lowerImportance, activationCount: count }), now: at
      }) > score(high));
      byScorer[name] = threshold == null ? null : {
        firstStrictOvertakeCount: threshold,
        valueAtThreshold: score({ record: makeNeutralRecord(at, { importance: lowerImportance, activationCount: threshold }), now: at }),
        highImportanceBaseline: score(high),
        valueImmediatelyBefore: threshold === 0 ? null : score({ record: makeNeutralRecord(at, { importance: lowerImportance, activationCount: threshold - 1 }), now: at })
      };
    }
    rows.push({ highImportance: 10, lowerImportance, importanceDifference: 10 - lowerImportance, activationAgeDays: 0, byScorer });
  }
  return rows;
}

function recencyImportanceCrossovers(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const rows = [];
  for (const recentImportance of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    const recent = { record: makeNeutralRecord(at, { importance: recentImportance, activationCount: 0 }), now: at };
    const byScorer = {};
    for (const name of ['Legacy', 'A', 'B', 'C']) {
      const score = scorerFunction(name);
      const ageDays = firstIntegerCrossover(age => score(recent) > score({
        record: makeNeutralRecord(at, { importance: 10, activationCount: 0, created: at - age * DAY, lastActivated: at - age * DAY }), now: at
      }), 36500);
      byScorer[name] = ageDays == null ? null : {
        firstStrictOvertakeAgeDays: ageDays,
        recentValue: score(recent),
        olderHighImportanceValue: score({
          record: makeNeutralRecord(at, { importance: 10, activationCount: 0, created: at - ageDays * DAY, lastActivated: at - ageDays * DAY }), now: at
        })
      };
    }
    rows.push({ freshLowerImportance: recentImportance, ageZeroActivationCount: 0, byScorer });
  }
  return rows;
}

function recencyActivationMatrix(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const ages = [0, 1, 3, 7, 14, 30, 60, 90];
  const counts = [0, 10, 50, 100, 300, 1000];
  const scorers = ['Legacy', 'A', 'B', 'C'];
  const records = [];
  for (const ageDays of ages) {
    for (const activationCount of counts) {
      const stamp = at - ageDays * DAY;
      const row = {
        id: 'age-' + ageDays + '-count-' + activationCount,
        record: makeNeutralRecord(at, { importance: 5, arousal: 0.3, resolved: false, activationCount, created: stamp, lastActivated: stamp }),
        now: at,
        ageDays,
        activationCount
      };
      const values = {};
      for (const name of scorers) values[name] = scorerFunction(name)(row);
      records.push(Object.assign(row, { values }));
    }
  }
  const freshBaseline = Object.fromEntries(scorers.map(name => [name, scorerFunction(name)({ record: makeNeutralRecord(at), now: at })]));
  const offset = {};
  for (const name of scorers) {
    offset[name] = counts.map(activationCount => {
      const eligible = records.filter(row => row.activationCount === activationCount && row.values[name] >= freshBaseline[name]);
      return { activationCount, freshCountZeroBaseline: freshBaseline[name], latestAgeAtOrAboveBaseline: eligible.length ? Math.max(...eligible.map(row => row.ageDays)) : null };
    });
  }
  return { ages, activationCounts: counts, freshCountZeroBaseline: freshBaseline, values: records.map(row => ({ ageDays: row.ageDays, activationCount: row.activationCount, values: row.values })), latestAgeOffsetVsFreshBaseline: offset };
}

function resolvedAgeMatrix(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const ages = [0, 1, 7, 30, 90, 180, 365, 730, 1825, 3650];
  const rows = [];
  for (const ageDays of ages) {
    for (const resolved of [false, true]) {
      const stamp = at - ageDays * DAY;
      const record = makeNeutralRecord(at, { importance: 5, arousal: 0.3, activationCount: 0, resolved, created: stamp, lastActivated: stamp });
      rows.push({ ageDays, resolved, legacy: legacyValue(record, at), A: candidateA(record, at), B: candidateB(record, at), C: candidateC(record, at) });
    }
  }
  return { ages, rows: rows.map(row => ({
    ageDays: row.ageDays, resolved: row.resolved, legacy: row.legacy,
    candidates: Object.fromEntries(['A', 'B', 'C'].map(name => [name, { value: row[name].value, decay: row[name].components.decay }]))
  })) };
}

function longAgeCalibration(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const ages = [0, 1, 7, 30, 90, 180, 365, 730, 1825, 3650];
  const recordAtZero = makeNeutralRecord(at, { importance: 5, arousal: 0.3, activationCount: 0, resolved: false });
  const legacyAtZero = legacyValue(recordAtZero, at);
  const rows = ages.map(ageDays => {
    const stamp = at - ageDays * DAY;
    const record = makeNeutralRecord(at, { importance: 5, arousal: 0.3, activationCount: 0, resolved: false, created: stamp, lastActivated: stamp });
    const legacy = legacyValue(record, at);
    const a = candidateA(record, at), b = candidateB(record, at), c = candidateC(record, at);
    return {
      ageDays,
      legacy: { value: legacy, productionScoreRatioToAgeZero: legacyAtZero === 0 ? null : legacy / legacyAtZero },
      candidates: {
        A: { value: a.value, decay: a.components.decay },
        B: { value: b.value, decay: b.components.decay },
        C: { value: c.value, decay: c.components.decay }
      }
    };
  });
  const distinguishability = {};
  const scorerValues = {
    Legacy: row => row.legacy.value,
    A: row => row.candidates.A.value,
    B: row => row.candidates.B.value,
    C: row => row.candidates.C.value
  };
  for (const [name, valueOf] of Object.entries(scorerValues)) {
    const vals = rows.map(valueOf);
    const distinctAdjacent = [];
    for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1]) distinctAdjacent.push(ages[i]);
    const zero = vals.findIndex(value => value === 0);
    distinguishability[name] = {
      adjacentTieCount: vals.length - 1 - distinctAdjacent.length,
      distinctTransitionAges: distinctAdjacent,
      firstZeroAgeDays: zero < 0 ? null : ages[zero],
      lastDistinctTransitionAgeDays: distinctAdjacent.length ? distinctAdjacent[distinctAdjacent.length - 1] : null
    };
  }
  return { agesDays: ages, rows, distinguishabilityWindow: distinguishability };
}

function arousalImportanceCrossovers(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const highImportanceLowArousal = makeNeutralRecord(at, { importance: 10, arousal: 0, activationCount: 0 });
  const rows = [];
  for (const importance of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    const highEmotion = makeNeutralRecord(at, { importance, arousal: 1, activationCount: 0 });
    const byScorer = {};
    for (const name of ['Legacy', 'A', 'B', 'C']) {
      const score = scorerFunction(name);
      const lowEmotionValue = score({ record: highImportanceLowArousal, now: at });
      const highEmotionValue = score({ record: highEmotion, now: at });
      byScorer[name] = {
        highImportanceLowArousal: lowEmotionValue,
        lowerImportanceHighArousal: highEmotionValue,
        lowerImportanceHighArousalStrictlyOvertakes: highEmotionValue > lowEmotionValue,
        relation: highEmotionValue > lowEmotionValue ? 'high-emotion-record-higher' : (highEmotionValue < lowEmotionValue ? 'high-importance-record-higher' : 'tie')
      };
    }
    rows.push({ highImportance: 10, lowerImportance: importance, arousalPair: [0, 1], byScorer });
  }
  return rows;
}

function importanceDomainCalibration(now) {
  const at = now == null ? DEFAULT_NOW : now;
  const values = [0, 1, 2, 5, 10, 11, -1, 100, NaN, Infinity];
  return values.map(importance => {
    const record = makeNeutralRecord(at, { importance });
    return {
      input: displayRaw(importance, true),
      domain: Number.isFinite(importance) && importance >= 1 && importance <= 10 ? 'VALID_DOMAIN' : 'INVALID_DOMAIN',
      legacy: displayRaw(legacyValue(record, at), true),
      candidates: Object.fromEntries(Object.entries(CANDIDATES).map(([name, candidate]) => {
        const output = candidate(record, at);
        return [name, { value: output.value, effectiveImportance: output.normalized.fields.importance.effective, reason: output.normalized.fields.importance.reason }];
      }))
    };
  });
}

function importanceRecencyCrossovers(now) {
  /* Delegates to recencyImportanceCrossovers: its input dimension is the fresh
     record's importance and its measured threshold is the older high-value age. */
  return recencyImportanceCrossovers(now);
}

function legacyActivationParameters(root) {
  const source = sourceText(root || ROOT, 'assets/js/memory-retrieval-core.js');
  const match = requirePattern(source,
    /var activationFactor\s*=\s*1\s*\+\s*activationCount\s*\/\s*\(activationCount\s*\+\s*(\d+(?:\.\d+)?)\s*\)\s*;/,
    'production Legacy activation literal');
  return { gain: 1, k: Number(match[1]), source: 'assets/js/memory-retrieval-core.js#getMemoryScore', method: 'extracted production literal; values still measured by production scorer' };
}

function activationSensitivity(now, root) {
  const at = now == null ? DEFAULT_NOW : now;
  const counts = [0, 1, 5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1000, 5000];
  const diagnosticImportance = 100000000;
  const legacyBaseline = legacyValue(makeNeutralRecord(at, { importance: diagnosticImportance, arousal: 0.3, activationCount: 0 }), at);
  const legacyRows = counts.map(activationCount => {
    const record = makeNeutralRecord(at, { importance: diagnosticImportance, arousal: 0.3, activationCount });
    const productionScore = legacyValue(record, at);
    const factor = productionScore / legacyBaseline;
    return { activationCount, productionScore, component: factor, deltaFromZero: factor - 1, percentGain: (factor - 1) * 100 };
  });
  const rows = counts.map(activationCount => {
    const record = makeNeutralRecord(at, { importance: 5, arousal: 0.3, activationCount });
    const item = { activationCount, Legacy: legacyRows[counts.indexOf(activationCount)] };
    for (const name of ['A', 'B', 'C']) {
      const output = CANDIDATES[name](record, at);
      const zero = CANDIDATES[name](makeNeutralRecord(at, { importance: 5, arousal: 0.3, activationCount: 0 }), at);
      item[name] = {
        component: output.components.activation,
        value: output.value,
        deltaFromZero: output.value - zero.value,
        percentGain: zero.value === 0 ? null : 100 * (output.value - zero.value) / zero.value
      };
    }
    return item;
  });
  const params = legacyActivationParameters(root);
  return {
    counts,
    legacyParameterBaseline: params,
    legacyPrecisionProbeImportance: diagnosticImportance,
    candidates: rows,
    formulaLabels: {
      Legacy: 'production authority; gain=1, K extracted from production',
      A: 'inherits Legacy gain=1, K=300',
      B: 'gain=0.5, K=100 (provisional reference)',
      C: 'activation component=count/(count+300); weight=0.25 provisional'
    }
  };
}

function scenarioChurnSummary(expanded) {
  const rows = [];
  for (const [left, right] of [['Legacy', 'A'], ['Legacy', 'B'], ['Legacy', 'C'], ['A', 'B'], ['A', 'C'], ['B', 'C']]) {
    const perFamily = expanded.families.map(family => {
      const score = name => scorerFunction(name);
      const pairwise = pairwiseOrderMetrics(family.members, row => score(left)(row), row => score(right)(row));
      const top = topKMetrics(family.members, (name, row) => score(name)(row), left, right);
      return {
        family: family.id,
        mode: family.mode,
        pairwiseInversions: pairwise.inversions,
        orderChanges: pairwise.orderChanges,
        top1Changed: top.top1Change,
        top3Jaccard: top.top3Jaccard,
        top5Jaccard: top.top5Jaccard,
        spearman: top.spearman,
        kendallTau: top.kendallTau
      };
    });
    const totalPairs = perFamily.reduce((sum, row) => sum + row.orderChanges * 0 + 1, 0);
    rows.push({
      comparison: left + ' ↔ ' + right,
      families: perFamily,
      familyCount: perFamily.length,
      familiesWithPairwiseChanges: perFamily.filter(row => row.orderChanges > 0).length,
      top1ChangePercent: 100 * perFamily.filter(row => row.top1Changed).length / perFamily.length,
      meanTop3Jaccard: perFamily.reduce((sum, row) => sum + row.top3Jaccard, 0) / perFamily.length,
      meanTop5Jaccard: perFamily.reduce((sum, row) => sum + row.top5Jaccard, 0) / perFamily.length,
      meanSpearman: perFamily.reduce((sum, row) => sum + (row.spearman == null ? 0 : row.spearman), 0) / perFamily.length,
      meanKendallTau: perFamily.reduce((sum, row) => sum + (row.kendallTau == null ? 0 : row.kendallTau), 0) / perFamily.length
    });
  }
  return rows;
}

function scenarioPoolMetricReport(expanded) {
  const names = ['Legacy', 'A', 'B', 'C'];
  const scorerMap = Object.fromEntries(names.map(name => [name, row => scorerFunction(name)(row)]));
  const pairwise = pairwiseComparisons(expanded.records, scorerMap);
  const topK = {};
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const left = names[i], right = names[j];
      topK[left + ' ↔ ' + right] = topKMetrics(expanded.records,
        (name, row) => scorerMap[name](row), left, right);
    }
  }
  return { poolCount: expanded.records.length, pairwise, topK };
}

function producerBucketMatrix(root, now) {
  const at = now == null ? DEFAULT_NOW : now;
  const producers = deriveProducerDefaults(root);
  const ageBuckets = [0, 30, 180];
  const activationBuckets = [0, 100, 1000];
  const rows = [];
  for (const [producer, spec] of Object.entries(producers.specs)) {
    for (const ageDays of ageBuckets) {
      for (const activationCount of activationBuckets) {
        const stamp = at - ageDays * DAY;
        const record = makeProducerRecord(spec, at, { activationCount, created: stamp, lastActivated: stamp });
        const rawScores = scoreSet(record, at);
        const controlled = Object.assign({}, record, {
          importance: 5,
          arousal: 0.3,
          resolved: false,
          source: producer,
          rawSource: producer,
          kind: producer
        });
        rows.push({
          producer, ageDays, activationCount,
          producerDefaultFields: {
            importance: record.importance,
            arousal: own(record, 'arousal') ? record.arousal : '<missing → .3 effective default>',
            resolved: record.resolved
          },
          rawDefaultScores: rawScores,
          fieldControlledSourceOnlyScores: scoreSet(controlled, at)
        });
      }
    }
  }
  const controlledSpreads = {};
  for (const scorer of ['legacy', 'A', 'B', 'C']) {
    for (const ageDays of ageBuckets) {
      for (const activationCount of activationBuckets) {
        const matching = rows.filter(row => row.ageDays === ageDays && row.activationCount === activationCount);
        const vals = matching.map(row => row.fieldControlledSourceOnlyScores[scorer]);
        const spread = Math.max(...vals) - Math.min(...vals);
        controlledSpreads[scorer + '/age' + ageDays + '/count' + activationCount] = spread;
      }
    }
  }
  return { ageBuckets, activationBuckets, rows, fieldControlledSourceOnlySpreads: controlledSpreads };
}

function enumerateCWeightGrid() {
  const weights = [];
  const importance = [0.30, 0.40, 0.50];
  const activation = [0.15, 0.25, 0.35];
  const decay = [0.15, 0.20, 0.30];
  for (const wi of importance) {
    for (const wa of activation) {
      for (const wd of decay) {
        const we = Number((1 - wi - wa - wd).toFixed(12));
        if (we < -1e-12) continue;
        weights.push({ importance: wi, activation: wa, decay: wd, emotion: Math.max(0, we) });
      }
    }
  }
  return weights;
}

function candidateMonotonicCounts(candidate, now) {
  const at = now == null ? DEFAULT_NOW : now;
  const axes = {
    activation: [0, 1, 5, 10, 50, 100, 300, 1000],
    ageDays: [0, 1, 7, 30, 90, 180, 365],
    arousal: [0, 0.001, 0.01, 0.05, 0.1, 0.2, 0.299, 0.3, 0.5, 1],
    importance: [1, 2, 5, 10]
  };
  const violations = {};
  for (const [axis, values] of Object.entries(axes)) {
    const scores = values.map(value => {
      let record = makeNeutralRecord(at);
      if (axis === 'ageDays') record = makeNeutralRecord(at, { created: at - value * DAY, lastActivated: at - value * DAY });
      else record = makeNeutralRecord(at, { [axis === 'activation' ? 'activationCount' : axis]: value });
      return candidate(record, at).value;
    });
    let count = 0;
    for (let i = 1; i < scores.length; i++) {
      const violates = axis === 'ageDays' ? scores[i] > scores[i - 1] + 1e-12 : scores[i] < scores[i - 1] - 1e-12;
      if (violates) count++;
    }
    violations[axis] = count;
  }
  return violations;
}

function cWeightSensitivity(expanded, producerRows, now) {
  const at = now == null ? DEFAULT_NOW : now;
  const grid = enumerateCWeightGrid();
  const defaultCandidate = row => candidateCWithWeights(row.record, row.now, C_WEIGHTS).value;
  const entries = grid.map(weights => {
    const candidate = row => candidateCWithWeights(row.record, row.now, weights).value;
    const pairwise = pairwiseOrderMetrics(expanded.records, defaultCandidate, candidate);
    const top = topKMetrics(expanded.records, (name, row) => name === 'base'
      ? defaultCandidate(row) : candidate(row), 'base', 'variant');
    const rawValues = producerRows.map(row => candidateCWithWeights(row.record, at, weights).value);
    const producerSpread = Math.max(...rawValues) - Math.min(...rawValues);
    const monotonic = candidateMonotonicCounts((record, timestamp) => candidateCWithWeights(record, timestamp, weights), at);
    return {
      weights,
      emotionRemainder: weights.emotion,
      pairwise: { inversions: pairwise.inversions, orderChanges: pairwise.orderChanges, orderChangePercent: pairwise.orderChangePercent, kendallTau: pairwise.kendallTau },
      topK: { top1Change: top.top1Change, top3SetChange: top.top3SetChange, top5SetChange: top.top5SetChange, top3Jaccard: top.top3Jaccard, top5Jaccard: top.top5Jaccard, spearman: top.spearman },
      producerDefaultSpread: producerSpread,
      monotonicViolations: monotonic
    };
  });
  const defaultRow = entries.find(row => JSON.stringify(row.weights) === JSON.stringify(C_WEIGHTS));
  return {
    gridDefinition: {
      importance: [0.30, 0.40, 0.50], activation: [0.15, 0.25, 0.35], decay: [0.15, 0.20, 0.30],
      emotion: '1 - sum(other weights)', validRule: 'emotion remainder >= 0'
    },
    validGridCount: entries.length,
    entries,
    sensitivitySummary: {
      pairwiseOrderingChangedCount: entries.filter(row => row.pairwise.orderChanges > 0).length,
      topKChangedCount: entries.filter(row => row.topK.top1Change || row.topK.top3SetChange || row.topK.top5SetChange).length,
      producerSpreadDistinctCount: new Set(entries.map(row => row.producerDefaultSpread)).size,
      monotonicViolationGroupCount: entries.filter(row => Object.values(row.monotonicViolations).some(value => value > 0)).length,
      defaultWeights: defaultRow ? defaultRow.weights : C_WEIGHTS
    }
  };
}

function bParameterSensitivity(expanded, now, root) {
  const at = now == null ? DEFAULT_NOW : now;
  const legacyParameters = legacyActivationParameters(root);
  const gains = [0.25, 0.5, 0.75];
  const ks = [50, 100, 300];
  const counts = [0, 1, 5, 10, 50, 100, 300, 1000];
  const baseline = row => candidateBWithParameters(row.record, row.now, { gain: 0.5, k: 100 }).value;
  const entries = [];
  for (const gain of gains) {
    for (const k of ks) {
      const candidate = row => candidateBWithParameters(row.record, row.now, { gain, k }).value;
      const pairwise = pairwiseOrderMetrics(expanded.records, baseline, candidate);
      const top = topKMetrics(expanded.records, (name, row) => name === 'base' ? baseline(row) : candidate(row), 'base', 'variant');
      const referencePoints = counts.map(activationCount => {
        const record = makeNeutralRecord(at, { importance: 5, arousal: 0.3, activationCount });
        return { activationCount, factor: 1 + gain * activationCount / (activationCount + k), value: candidateBWithParameters(record, at, { gain, k }).value };
      });
      const crossoverRows = [9, 8, 7, 6, 5, 4, 3, 2, 1].map(lowerImportance => {
        const high = { record: makeNeutralRecord(at, { importance: 10, activationCount: 0 }), now: at };
        const threshold = firstIntegerCrossover(count => candidate({
          record: makeNeutralRecord(at, { importance: lowerImportance, activationCount: count }), now: at
        }) > candidate(high));
        return { lowerImportance, firstStrictOvertakeCount: threshold };
      });
      entries.push({
        gain, k,
        formula: '1 + gain × activationCount / (activationCount + k)',
        activationBound: '[1, 1+gain] finite precision; asymptotic upper limit 1+gain',
        referencePoints,
        rankChangeVsDefaultB: { inversions: pairwise.inversions, orderChanges: pairwise.orderChanges, orderChangePercent: pairwise.orderChangePercent, kendallTau: pairwise.kendallTau },
        topKVsDefaultB: { top1Change: top.top1Change, top3SetChange: top.top3SetChange, top5SetChange: top.top5SetChange, top3Jaccard: top.top3Jaccard, top5Jaccard: top.top5Jaccard, spearman: top.spearman },
        importanceActivationCrossovers: crossoverRows
      });
    }
  }
  const legacyCounts = counts.map(activationCount => {
    const diagnosticImportance = 100000000;
    const baselineScore = legacyValue(makeNeutralRecord(at, { importance: diagnosticImportance, activationCount: 0 }), at);
    const score = legacyValue(makeNeutralRecord(at, { importance: diagnosticImportance, activationCount }), at);
    return { activationCount, productionScorerDerivedFactor: score / baselineScore };
  });
  return {
    gridDefinition: { gain: gains, k: ks },
    legacyParameterBaseline: legacyParameters,
    legacyReferencePoints: legacyCounts,
    entries,
    sensitivitySummary: {
      gridCount: entries.length,
      rankChangeVsDefaultBCount: entries.filter(row => row.rankChangeVsDefaultB.orderChanges > 0).length,
      topKChangeVsDefaultBCount: entries.filter(row => row.topKVsDefaultB.top1Change || row.topKVsDefaultB.top3SetChange || row.topKVsDefaultB.top5SetChange).length,
      distinctCrossoverSignatures: new Set(entries.map(row => row.importanceActivationCrossovers.map(item => item.firstStrictOvertakeCount).join(','))).size
    }
  };
}

function complexityEvidence() {
  return {
    A: {
      tunableFormulaConstants: 4,
      formulaConstants: ['activation K=300 (inherited)', 'resolved lambda=.12 (inherited)', 'unresolved lambda=.05 (inherited)', 'emotion weight=.8 (inherited)'],
      normalizationRules: 5,
      branches: ['resolved/unresolved decay']
    },
    B: {
      tunableFormulaConstants: 5,
      formulaConstants: ['activation gain=.5', 'activation K=100', 'resolved lambda=.12', 'unresolved lambda=.05', 'emotion weight=.8'],
      normalizationRules: 5,
      branches: ['resolved/unresolved decay']
    },
    C: {
      tunableFormulaConstants: 6,
      independentWeightDegreesOfFreedom: 3,
      formulaConstants: ['four nonnegative weights summing to one', 'activation K=300', 'resolved lambda=.12', 'unresolved lambda=.05'],
      normalizationRules: 5,
      branches: ['resolved/unresolved decay']
    }
  };
}

function hardGateAssessment(properties, parameters) {
  const p = properties;
  const result = {};
  for (const name of ['A', 'B', 'C']) {
    result[name] = {
      C1_finiteDeterministic: p[name].P5_validDomainFinite && p[name].P8_missingValueDeterminism,
      C2_queryLeakage: p[name].P1_queryInvariance,
      C3_cooldownLeakage: p[name].P3_cooldownStateInvariance,
      C4_aclLeakage: p[name].P2_visibilityInvariance,
      C5_validZero: name === 'C' ? parameters.zeroArousalEffective === 0 : parameters.zeroArousalEffective === 0,
      C6_activationMonotonic: p[name].P6_activationMonotonicity,
      C7_ageMonotonic: p[name].P7_ageMonotonicity,
      C8_activationBounded: parameters.activationBounds[name].finite && parameters.activationBounds[name].bounded,
      C9_emotionBounded: parameters.emotionBounds[name].finite && parameters.emotionBounds[name].bounded,
      C10_missingSemantics: parameters.normalizationReasons[name],
      C11_createdAlias: parameters.createdAlias[name],
      C12_noFutureAmplification: parameters.futureFloor[name],
      C13_sourceNeutral: p[name].P4_sourceTypeInvariance,
      C14_explainableComponents: parameters.explainable[name],
      C16_schemaUnchanged: parameters.scopeEvidence.productionPathCount === 0
        && parameters.scopeEvidence.schemaPathCount === 0,
      C17_pureNoAuthority: p[name].P10_noMutation && parameters.noAuthorityIO[name],
      scopeEvidence: parameters.scopeEvidence
    };
    result[name].passed = Object.entries(result[name]).filter(([key]) => key.startsWith('C'))
      .every(([, value]) => value === true || (value && typeof value === 'object' && value.status === true));
  }
  return result;
}

function candidateCalibrationGates(now, root) {
  const at = now == null ? DEFAULT_NOW : now;
  const base = root || ROOT;
  const properties = propertyReport(at);
  const tracked = childProcess.execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: base, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map(value => value.replace(/\\/g, '/'));
  const untracked = childProcess.execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: base, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map(value => value.replace(/\\/g, '/'));
  const changedPaths = [...new Set(tracked.concat(untracked))];
  const productionPaths = changedPaths.filter(file => /^(assets|services|src-tauri)\//.test(file));
  const schemaPaths = changedPaths.filter(file => /(?:schema|migration|DB_VER|MEMORY_SCHEMA_VERSION)/i.test(file)
    && !file.startsWith('tests/'));
  const parameters = {
    zeroArousalEffective: candidateA({ importance: 5, arousal: 0, activationCount: 0, resolved: false, created: at, lastActivated: at }, at).normalized.fields.arousal.effective,
    activationBounds: {}, emotionBounds: {}, normalizationReasons: {}, createdAlias: {}, futureFloor: {}, explainable: {}, noAuthorityIO: {},
    scopeEvidence: {
      changedPathCount: changedPaths.length,
      changedPaths,
      productionPathCount: productionPaths.length,
      productionPaths,
      schemaPathCount: schemaPaths.length,
      schemaPaths
    }
  };
  const source = sourceText(base, 'tests/helpers/memory-value-v2-calibration.js');
  const body = source.slice(source.indexOf('function candidateA'), source.indexOf('function materializeSpecial'));
  for (const name of ['A', 'B', 'C']) {
    const candidate = CANDIDATES[name];
    const values = [0, 1, 10, 100, 1000, Number.MAX_VALUE].map(count => candidate(makeNeutralRecord(at, { activationCount: count }), at).components.activation);
    const arousals = [0, 0.001, 0.3, 1].map(arousal => candidate(makeNeutralRecord(at, { arousal }), at).components.emotion);
    const noMeta = candidate({ id: 'gate-missing' }, at);
    const alias = candidate({ importance: 5, arousal: 0.3, activationCount: 0, resolved: false, createdAt: at }, at);
    const future = candidate(makeNeutralRecord(at, { created: at + DAY, lastActivated: at + DAY }), at);
    const zero = candidate(makeNeutralRecord(at, { arousal: 0 }), at);
    parameters.activationBounds[name] = {
      finite: values.every(Number.isFinite),
      bounded: name === 'C' ? values.every(value => value >= 0 && value <= 1)
        : values.every(value => value >= 1 && value <= (name === 'B' ? 1.5 : 2))
    };
    parameters.emotionBounds[name] = {
      finite: arousals.every(Number.isFinite),
      bounded: name === 'C' ? arousals.every(value => value >= 0 && value <= 1)
        : arousals.every(value => value >= 1 && value <= 1.8)
    };
    parameters.normalizationReasons[name] = Object.keys(noMeta.normalized.fields).length >= 9;
    parameters.createdAlias[name] = alias.normalized.fields.ageDays.effective === 0;
    parameters.futureFloor[name] = future.normalized.fields.ageDays.effective === 0
      && future.components.decay === 1 && zero.normalized.fields.arousal.effective === 0;
    parameters.explainable[name] = ['importance', 'activation', 'decay', 'emotion'].every(key => Object.prototype.hasOwnProperty.call(noMeta.components, key));
    const fnName = name === 'A' ? 'candidateA' : (name === 'B' ? 'candidateBWithParameters' : 'candidateCWithWeights');
    const fnStart = body.indexOf('function ' + fnName);
    const fnEnd = body.indexOf('\nfunction ', fnStart + 1);
    const fnBody = body.slice(fnStart, fnEnd < 0 ? body.length : fnEnd);
    parameters.noAuthorityIO[name] = !/fetch\s*\(|home-node-client|recordActivation|indexedDB|localStorage|callApi/i.test(fnBody);
  }
  return { properties, parameters, hardGates: hardGateAssessment(properties, parameters) };
}

function buildCalibrationDecision(report) {
  return {
    schemaVersion: 1,
    phase: 'P21-R3-C',
    status: 'CLOSED',
    formulaSelection: 'NONE',
    currentFixtureDiscrimination: 'INSUFFICIENT',
    measuredCandidateDivergence: true,
    selectedCandidate: null,
    formulaVersion: null,
    frozenFormula: null,
    candidates: {
      A: 'CONTROL ONLY · SHADOW · NOT PRODUCTION · NOT FROZEN · NO CUTOVER',
      B: 'NOT SELECTED · SHADOW · NOT PRODUCTION · NOT FROZEN · NO CUTOVER',
      C: 'NOT SELECTED · SHADOW · NOT PRODUCTION · NOT FROZEN · NO CUTOVER'
    },
    hardGates: report.hardGates,
    blockers: [
      {
        id: 'activation-importance-tradeoff-has-no-canonical-direction',
        evidence: 'The expanded crossover matrix shows candidate-specific count thresholds, but no canonical product rule says which side of those pairs must rank higher.'
      },
      {
        id: 'B-parameter-choice-is-not-evidenced',
        evidence: 'The gain/K grid changes crossover boundaries; selecting a point would encode a tradeoff preference not present in the product contract.'
      },
      {
        id: 'C-provisional-weights-have-calibration-cost',
        evidence: 'The bounded weight grid measures pairwise/top-K/source-spread movement; the synthetic grid does not justify a preferred weight vector.'
      },
      {
        id: 'synthetic-source-shapes-are-not-population-distribution',
        evidence: 'Producer rows are source-derived synthetic representatives; no real producer population or preference labels were read.'
      }
    ],
    knownTradeoffs: {
      A: 'Normalization-only control; keeps Legacy activation/decay/emotion structure and round2 behavior.',
      B: 'Changes only activation gain/saturation; diverges from A around activation/importance crossovers.',
      C: 'Uses bounded provisional components; weight grid reports sensitivity without choosing weights.'
    },
    rejectedCandidates: [],
    evidenceRefs: [
      'tests/fixtures/memory-value-v2/calibration-criteria.json',
      'tests/fixtures/memory-value-v2/scenario-families.json',
      'tmp/memory-value-v2-shadow.json',
      'tmp/memory-value-v2-shadow.md'
    ],
    productionLegacyRemainsAuthority: true,
    R3_D_CUTOVER_EVALUATION_AUTHORIZED: false
  };
}

function buildShadowReport(root) {
  const base = root || ROOT;
  const cases = loadCases(base);
  const now = JSON.parse(fs.readFileSync(path.join(base, 'tests/fixtures/memory-value-v2/cases.json'), 'utf8')).now;
  const criteria = JSON.parse(fs.readFileSync(path.join(base, 'tests/fixtures/memory-value-v2/calibration-criteria.json'), 'utf8'));
  const expanded = expandScenarioFamilies(base, now);
  const caseValues = cases.map(entry => {
    const legacy = legacyValue(entry.record, entry.now);
    const candidateValues = {};
    const components = {};
    Object.keys(CANDIDATES).forEach(name => {
      const output = CANDIDATES[name](entry.record, entry.now);
      candidateValues[name] = output.value;
      components[name] = output.components;
    });
    return {
      id: entry.id, description: entry.description, axis: entry.axis,
      expectedLegacyProperty: entry.expectedLegacyProperty, tags: entry.tags,
      legacy: displayRaw(legacy, true), candidates: candidateValues, components
    };
  });
  const matrix = producerMatrix(base, now);
  const producerBuckets = producerBucketMatrix(base, now);
  const producerSpecs = deriveProducerDefaults(base).specs;
  const producerRecords = Object.keys(producerSpecs).map(producer => ({
    producer,
    record: makeProducerRecord(producerSpecs[producer], now),
    now
  }));
  const values = {
    Legacy: entry => legacyValue(entry.record, entry.now),
    A: entry => candidateA(entry.record, entry.now).value,
    B: entry => candidateB(entry.record, entry.now).value,
    C: entry => candidateC(entry.record, entry.now).value
  };
  const arousalSweep = [0, 0.001, 0.01, 0.05, 0.1, 0.2, 0.299, 0.3, 0.5, 1].map(arousal => {
    const record = makeNeutralRecord(now, { arousal });
    const diagnosticImportance = 100000000;
    const factorRecord = makeNeutralRecord(now, { arousal, importance: diagnosticImportance });
    const row = {
      arousal,
      legacy: legacyValue(record, now),
      legacyEmotionFactor: legacyValue(factorRecord, now) / diagnosticImportance
    };
    Object.keys(CANDIDATES).forEach(name => { row[name] = CANDIDATES[name](record, now).value; });
    return row;
  });
  const legacy = legacyCharacterization(now);
  const fuzz = deterministicFuzz(0x21A3B, 2048, now);
  const metrics = metricReport(cases, now);
  const violations = monotonicViolationScanner(now);
  const properties = propertyReport(now);
  const sensitivities = sensitivityGenerator(now);
  const scenarioComparisons = scenarioFamilyMetrics(expanded);
  const scenarioChurn = scenarioChurnSummary(expanded);
  const scenarioPoolMetrics = scenarioPoolMetricReport(expanded);
  const activationCrossovers = activationImportanceCrossovers(now);
  const recencyImportance = recencyImportanceCrossovers(now);
  const ageActivation = recencyActivationMatrix(now);
  const resolvedAges = resolvedAgeMatrix(now);
  const longAge = longAgeCalibration(now);
  const arousalImportance = arousalImportanceCrossovers(now);
  const importanceDomain = importanceDomainCalibration(now);
  const activationSweep = activationSensitivity(now, base);
  const bSensitivity = bParameterSensitivity(expanded, now, base);
  const cSensitivity = cWeightSensitivity(expanded, producerRecords, now);
  const complexity = complexityEvidence();
  const gates = candidateCalibrationGates(now);
  const scenarioExplainability = expanded.records.slice(0, 10).map(row => ({
    family: row.id.split(':')[0],
    id: row.id,
    legacy: legacyValue(row.record, row.now),
    A: candidateA(row.record, row.now),
    B: candidateB(row.record, row.now),
    C: candidateC(row.record, row.now)
  }));
  const legacyExpectedFail = [
    assertKnownLegacyBehavior('arousal-zero-discontinuity', legacy.arousalSweep[0].score > legacy.arousalSweep[1].score,
      { atZero: legacy.arousalSweep[0].score, atEpsilon: legacy.arousalSweep[1].score }),
    assertKnownLegacyBehavior('importance-zero-fallback', legacy.importanceSweep[0].score > legacy.importanceSweep[1].score,
      { importanceZero: legacy.importanceSweep[0].score, importanceOne: legacy.importanceSweep[1].score }),
    assertKnownLegacyBehavior('pinned-is-priority-sentinel', properties.LEGACY.P9_pinnedExcludedFromNormalValue === false),
    assertKnownLegacyBehavior('createdAt-only-is-not-created-alias', legacy.createdAtAlias.productionTreatsCreatedAtAsAlias === false)
  ];
  const scorerMap = { Legacy: values.Legacy, A: values.A, B: values.B, C: values.C };
  const output = {
    phase: 'P21-R3-C',
    artifactVersion: 1,
    candidateLabels: FORMULA_LABEL,
    FORMULA_SELECTION: 'NONE',
    FROZEN_FORMULA: null,
    fixtureCount: cases.length,
    scenarioFamilyCount: expanded.families.length,
    scenarioMemberCount: expanded.records.length,
    evaluationCriteria: criteria,
    hardGates: gates.hardGates,
    allCandidateHardGatesPass: Object.values(gates.hardGates).every(candidate => candidate.passed),
    softMetrics: {
      C15_parameterComplexity: complexity,
      C18_longAgeStability: 'see LONG_AGE_CALIBRATION.distinguishabilityWindow',
      C19_rankChurn: 'see scenarioChurn and scenarioPoolMetrics; report by family and combined synthetic pool',
      C20_discrimination: 'see crossover matrices; tradeoff direction is not labeled as a preference'
    },
    softMetricPolicy: 'report each metric; no weighted aggregate score and no preference label',
    candidates: {
      A: { version: 'R3-C-A1', name: 'Normalized Legacy control', formula: 'round2(importance × (1 + count/(count+300)) × decay × emotion)', role: 'normalization-only control', status: FORMULA_LABEL },
      B: { version: 'R3-C-B1-probe', name: 'Alternative Activation Saturation', formula: 'round2(importance × (1 + gain × count/(count+k)) × decay × emotion)', defaultProbeParameters: { gain: 0.5, k: 100 }, bound: '[1, 1.5] finite-precision output at default probe', status: FORMULA_LABEL },
      C: { version: 'R3-C-C1-probe', name: 'Bounded Components', formula: '1 + 9 × weighted normalized components', weights: C_WEIGHTS, valueBound: '[1, 10]', provisional: 'NOT FROZEN · SHADOW ONLY', status: FORMULA_LABEL }
    },
    B_ACTIVATION_FORMULA: '1 + 0.5 × activationCount / (activationCount + 100)',
    B_BOUND: '[1, 1.5] in finite-precision output; 1.5 is the asymptotic limit',
    B_REFERENCE_POINTS: [0, 1, 5, 10, 50, 100, 300, 1000].map(activationCount => ({
      activationCount,
      factor: 1 + 0.5 * activationCount / (activationCount + 100)
    })),
    R3_A_CORRECTION_CONFIRMED: true,
    LEGACY_BASELINE_SOURCE: 'assets/js/memory-recall/scoring.js#computeLegacyMemoryValue → assets/js/memory-retrieval-core.js#getMemoryScore',
    cases: caseValues,
    scenarioFamilies: scenarioComparisons,
    scenarioChurn,
    scenarioPoolMetrics,
    ACTIVATION_IMPORTANCE_CROSSOVER_MATRIX: activationCrossovers,
    RECENCY_IMPORTANCE_CROSSOVER_MATRIX: recencyImportance,
    RECENCY_ACTIVATION_MATRIX: ageActivation,
    RESOLVED_UNRESOLVED_MATRIX: resolvedAges,
    LONG_AGE_CALIBRATION: longAge,
    AROUSAL_IMPORTANCE_CROSSOVERS: arousalImportance,
    IMPORTANCE_DOMAIN_CALIBRATION: importanceDomain,
    producerMatrix: matrix,
    producerMatrixByAgeAndActivation: producerBuckets,
    arousalSweep,
    activationSensitivity: activationSweep,
    candidateBParameterSensitivity: bSensitivity,
    candidateCWeightSensitivity: cSensitivity,
    candidateComplexity: complexity,
    explainabilitySamples: scenarioExplainability,
    sensitivities,
    legacyCharacterization: legacy,
    propertyChecks: properties,
    finiteFuzz: fuzz,
    monotonicViolations: violations,
    pairwiseMetrics: metrics.pairwise,
    topKMetrics: metrics.topK,
    rankPoolCount: metrics.rankPoolCount,
    legacyExpectedFail,
    CURRENT_FIXTURE_DISCRIMINATION: 'INSUFFICIENT',
    discriminationEvidence: 'Candidate divergences and crossovers are measured; the product contract provides no preferred tradeoff direction.',
    FORMULA_SELECTION: 'NONE',
    FROZEN_FORMULA: null,
    decision: 'No formula choice: the measured tradeoffs lack a canonical product rule for direction.',
    note: 'Behavioral comparison only. A/B/C remain shadow candidates and are not connected to production.'
  };
  output.activationSensitivity = activationSweep;
  output.ACTIVATION_IMPORTANCE_CROSSOVER_MATRIX = activationCrossovers;
  output.RECENCY_IMPORTANCE_CROSSOVER_MATRIX = recencyImportance;
  output.RECENCY_ACTIVATION_MATRIX = ageActivation;
  output.RESOLVED_UNRESOLVED_MATRIX = resolvedAges;
  output.LONG_AGE_CALIBRATION = longAge;
  output.AROUSAL_IMPORTANCE_CROSSOVERS = arousalImportance;
  output.IMPORTANCE_DOMAIN_CALIBRATION = importanceDomain;
  output.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION = producerBuckets;
  output.CANDIDATE_B_PARAMETER_SENSITIVITY = bSensitivity;
  output.CANDIDATE_C_WEIGHT_SENSITIVITY = cSensitivity;
  output.SCENARIO_FAMILY_METRICS = scenarioComparisons;
  output.SCENARIO_RANK_CHURN = scenarioChurn;
  output.SCENARIO_POOL_METRICS = scenarioPoolMetrics;
  output.CANDIDATE_COMPLEXITY = complexity;
  output.EXPLAINABILITY_SAMPLES = scenarioExplainability;
  output.R3_D_CUTOVER_EVALUATION_AUTHORIZED = false;
  output.calibrationDecision = buildCalibrationDecision(output);
  return output;
}

function thresholdText(result) {
  if (result == null) return 'none';
  if (typeof result === 'number') return String(result);
  const value = result.firstStrictOvertakeCount == null ? result.firstStrictOvertakeAgeDays : result.firstStrictOvertakeCount;
  return value == null ? 'none' : String(value);
}

function markdownReport(report) {
  const lines = [
    '# P21-R3-C Candidate Calibration', '',
    '- Legacy baseline: ' + report.LEGACY_BASELINE_SOURCE,
    '- R3-A correction confirmed: ' + report.R3_A_CORRECTION_CONFIRMED,
    '- Discrimination fixtures: ' + report.fixtureCount + ' R3-B cases + ' + report.scenarioFamilyCount + ' scenario families / ' + report.scenarioMemberCount + ' members',
    '- Candidate labels: SHADOW · NOT PRODUCTION · NOT FROZEN · NO CUTOVER',
    '- Formula selection: NONE; tradeoff evidence has no canonical direction',
    '- R3-D cutover evaluation authorized: ' + report.R3_D_CUTOVER_EVALUATION_AUTHORIZED, '',
    '## Evaluation criteria', '',
    '| Gate | Hard / soft | Measurement |', '|---|---|---|'
  ];
  report.evaluationCriteria.hardGates.forEach(row => lines.push('| ' + row.id + ' | HARD | ' + row.measurement + ' |'));
  report.evaluationCriteria.softMetrics.forEach(row => lines.push('| ' + row.id + ' | SOFT | ' + row.measurement + ' |'));
  lines.push('', '## Activation discrimination', '', '| count | Legacy factor* | A factor | B factor | C activation component |', '|---:|---:|---:|---:|---:|');
  report.activationSensitivity.candidates.forEach(row => lines.push('| ' + row.activationCount + ' | '
    + row.Legacy.component.toFixed(6) + ' | ' + row.A.component.toFixed(6) + ' | '
    + row.B.component.toFixed(6) + ' | ' + row.C.component.toFixed(6) + ' |'));
  lines.push('', '*Legacy factor is inferred from production scorer output with a high-importance precision probe; the probe is not a producer sample.*');
  lines.push('', '## Activation / importance crossover', '', '| Lower importance vs 10 | Legacy | A | B | C |', '|---:|---:|---:|---:|---:|');
  report.ACTIVATION_IMPORTANCE_CROSSOVER_MATRIX.forEach(row => lines.push('| ' + row.lowerImportance + ' | '
    + thresholdText(row.byScorer.Legacy) + ' | ' + thresholdText(row.byScorer.A) + ' | '
    + thresholdText(row.byScorer.B) + ' | ' + thresholdText(row.byScorer.C) + ' |'));
  lines.push('', '## Recency / importance crossover age (days)', '', '| Fresh lower importance vs 10 | Legacy | A | B | C |', '|---:|---:|---:|---:|---:|');
  report.RECENCY_IMPORTANCE_CROSSOVER_MATRIX.forEach(row => lines.push('| ' + row.freshLowerImportance + ' | '
    + thresholdText(row.byScorer.Legacy) + ' | ' + thresholdText(row.byScorer.A) + ' | '
    + thresholdText(row.byScorer.B) + ' | ' + thresholdText(row.byScorer.C) + ' |'));
  lines.push('', '## Recency × activation', '', '| age | count | Legacy | A | B | C |', '|---:|---:|---:|---:|---:|---:|');
  report.RECENCY_ACTIVATION_MATRIX.values.forEach(row => lines.push('| ' + row.ageDays + ' | ' + row.activationCount + ' | '
    + row.values.Legacy + ' | ' + row.values.A + ' | ' + row.values.B + ' | ' + row.values.C + ' |'));
  lines.push('', '### Highest tested age still at or above fresh/count-zero value', '', '| count | Legacy | A | B | C |', '|---:|---:|---:|---:|---:|');
  for (let i = 0; i < report.RECENCY_ACTIVATION_MATRIX.activationCounts.length; i++) {
    const rows = ['Legacy', 'A', 'B', 'C'].map(name => report.RECENCY_ACTIVATION_MATRIX.latestAgeOffsetVsFreshBaseline[name][i].latestAgeAtOrAboveBaseline);
    lines.push('| ' + report.RECENCY_ACTIVATION_MATRIX.activationCounts[i] + ' | ' + rows.map(value => value == null ? 'none' : value).join(' | ') + ' |');
  }
  lines.push('', '## Resolved / unresolved and long-age tail', '', '| age days | resolved | Legacy | A | B | C |', '|---:|---|---:|---:|---:|---:|');
  report.RESOLVED_UNRESOLVED_MATRIX.rows.forEach(row => lines.push('| ' + row.ageDays + ' | ' + row.resolved + ' | '
    + row.legacy + ' | ' + row.candidates.A.value + ' | ' + row.candidates.B.value + ' | ' + row.candidates.C.value + ' |'));
  lines.push('', '### Distinguishability window', '', '| Scorer | adjacent ties | first zero age | last distinct transition age |', '|---|---:|---:|---:|');
  Object.keys(report.LONG_AGE_CALIBRATION.distinguishabilityWindow).forEach(name => {
    const row = report.LONG_AGE_CALIBRATION.distinguishabilityWindow[name];
    lines.push('| ' + name + ' | ' + row.adjacentTieCount + ' | ' + (row.firstZeroAgeDays == null ? 'none' : row.firstZeroAgeDays)
      + ' | ' + (row.lastDistinctTransitionAgeDays == null ? 'none' : row.lastDistinctTransitionAgeDays) + ' |');
  });
  lines.push('', '## Arousal and importance', '', '| arousal | Legacy score | Legacy factor* | A | B | C |', '|---:|---:|---:|---:|---:|---:|');
  report.arousalSweep.forEach(row => lines.push('| ' + [row.arousal, row.legacy, row.legacyEmotionFactor, row.A, row.B, row.C].join(' | ') + ' |'));
  lines.push('', '| importance input | domain | Legacy | A effective/value | B effective/value | C effective/value |', '|---:|---|---:|---:|---:|---:|');
  report.IMPORTANCE_DOMAIN_CALIBRATION.forEach(row => lines.push('| ' + row.input + ' | ' + row.domain + ' | ' + row.legacy
    + ' | ' + row.candidates.A.effectiveImportance + '/' + row.candidates.A.value
    + ' | ' + row.candidates.B.effectiveImportance + '/' + row.candidates.B.value
    + ' | ' + row.candidates.C.effectiveImportance + '/' + row.candidates.C.value + ' |'));
  lines.push('', '## Candidate parameter sensitivity', '', 'B: ' + report.CANDIDATE_B_PARAMETER_SENSITIVITY.sensitivitySummary.gridCount + ' gain/K combinations; '
    + report.CANDIDATE_B_PARAMETER_SENSITIVITY.sensitivitySummary.rankChangeVsDefaultBCount + ' change pair order vs default B; '
    + report.CANDIDATE_B_PARAMETER_SENSITIVITY.sensitivitySummary.topKChangeVsDefaultBCount + ' change top-K sets.', '',
    'C: ' + report.CANDIDATE_C_WEIGHT_SENSITIVITY.sensitivitySummary.validGridCount + ' valid weight combinations; '
    + report.CANDIDATE_C_WEIGHT_SENSITIVITY.sensitivitySummary.pairwiseOrderingChangedCount + ' change pair order; '
    + report.CANDIDATE_C_WEIGHT_SENSITIVITY.sensitivitySummary.topKChangedCount + ' change top-K; '
    + report.CANDIDATE_C_WEIGHT_SENSITIVITY.sensitivitySummary.producerSpreadDistinctCount + ' distinct producer spreads; '
    + report.CANDIDATE_C_WEIGHT_SENSITIVITY.sensitivitySummary.monotonicViolationGroupCount + ' monotonic-violation groups.', '',
    '## Scenario-family rank churn', '', '| comparison | families with pair change | top-1 change % | mean top-3 Jaccard | mean Spearman | mean Kendall tau-a |', '|---|---:|---:|---:|---:|---:|');
  report.SCENARIO_RANK_CHURN.forEach(row => lines.push('| ' + row.comparison + ' | ' + row.familiesWithPairwiseChanges + ' | '
    + row.top1ChangePercent.toFixed(1) + ' | ' + row.meanTop3Jaccard.toFixed(3) + ' | '
    + row.meanSpearman.toFixed(3) + ' | ' + row.meanKendallTau.toFixed(3) + ' |'));
  lines.push('', '## Synthetic source defaults / age / activation', '', '| producer | age | count | Legacy raw | A | B | C | source-only control spread |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  report.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION.rows.forEach(row => {
    const control = report.PRODUCER_MATRIX_BY_AGE_AND_ACTIVATION.fieldControlledSourceOnlySpreads;
    const spread = Math.max(...['legacy', 'A', 'B', 'C'].map(name => control[name + '/age' + row.ageDays + '/count' + row.activationCount]));
    lines.push('| ' + row.producer + ' | ' + row.ageDays + ' | ' + row.activationCount + ' | '
      + row.rawDefaultScores.legacy + ' | ' + row.rawDefaultScores.A + ' | ' + row.rawDefaultScores.B + ' | '
      + row.rawDefaultScores.C + ' | ' + spread + ' |');
  });
  lines.push('', '## Complexity evidence', '', '| Candidate | tunable formula constants | independent C weights | normalization rules | branches |', '|---|---:|---:|---:|---|');
  for (const name of ['A', 'B', 'C']) {
    const row = report.CANDIDATE_COMPLEXITY[name];
    lines.push('| ' + name + ' | ' + row.tunableFormulaConstants + ' | ' + (row.independentWeightDegreesOfFreedom || 0)
      + ' | ' + row.normalizationRules + ' | ' + row.branches.join(', ') + ' |');
  }
  lines.push('', '## Deterministic fuzz / hard gates', '', '- Seed: ' + report.finiteFuzz.seed + '; cases: ' + report.finiteFuzz.cases,
    '- Candidate finite: ' + JSON.stringify(report.finiteFuzz.candidateFinite),
    '- Candidate deterministic: ' + JSON.stringify(report.finiteFuzz.deterministic),
    '- All candidate hard gates pass: ' + report.allCandidateHardGatesPass,
    '- Legacy arousal monotonic: ' + report.legacyCharacterization.LEGACY_AROUSAL_MONOTONIC,
    '- Current fixture discrimination for formula choice: ' + report.CURRENT_FIXTURE_DISCRIMINATION,
    '- Measured divergence: ' + report.discriminationEvidence, '',
    '## Decision', '',
    'FORMULA_SELECTION = NONE. Crossover and sensitivity behavior is measured, but no canonical product rule supplies the required tradeoff direction. The decision artifact records the blockers. A/B/C remain shadow-only; Legacy remains production authority.', '',
    'All input records are synthetic. No query relevance, cooldown, ACL, activation authority, or user content is used in candidate rankings.', '');
  return lines.join('\n');
}

function writeShadowOutputs(root) {
  const base = root || ROOT;
  const report = buildShadowReport(base);
  const outputDir = path.join(base, 'tmp');
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'memory-value-v2-shadow.json');
  const mdPath = path.join(outputDir, 'memory-value-v2-shadow.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, markdownReport(report) + '\n', 'utf8');
  return { report, jsonPath, mdPath };
}

module.exports = {
  ROOT, DAY, MAX_AGE_DAYS, DEFAULT_NOW, FORMULA_LABEL, C_WEIGHTS, LEGACY_BASELINE_SOURCE: 'assets/js/memory-recall/scoring.js#computeLegacyMemoryValue → assets/js/memory-retrieval-core.js#getMemoryScore',
  CORE, SCORING, CANDIDATES, legacyValue, candidateA, candidateB, candidateC,
  candidateBWithParameters, candidateCWithWeights,
  materializeSpecial, loadCases, normalizeInputs, deriveProducerDefaults,
  makeProducerRecord, scoreSet, producerMatrix, assertKnownLegacyBehavior,
  spearman, rankRows, pairwiseOrderMetrics, topKMetrics, pairwiseComparisons,
  sensitivityGenerator, monotonicViolationScanner, legacyCharacterization,
  deterministicFuzz, propertyReport, metricReport, buildShadowReport,
  markdownReport, writeShadowOutputs, loadScenarioFamilies, expandScenarioFamilies,
  scenarioFamilyMetrics, scenarioChurnSummary, scenarioPoolMetricReport,
  activationImportanceCrossovers, recencyImportanceCrossovers, importanceRecencyCrossovers,
  recencyActivationMatrix, resolvedAgeMatrix, longAgeCalibration, arousalImportanceCrossovers,
  importanceDomainCalibration, legacyActivationParameters, activationSensitivity,
  producerBucketMatrix, enumerateCWeightGrid, candidateMonotonicCounts,
  cWeightSensitivity, bParameterSensitivity, complexityEvidence,
  hardGateAssessment, candidateCalibrationGates, buildCalibrationDecision
};
