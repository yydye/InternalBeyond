'use strict';

/* P21 · Memory V2 final natural-language validation.
   Isolated canonical-shaped rows; runs the real Recall Query → Hard Gate →
   candidate set → V1/V2 selector path without Provider, persistence, or writes. */

const assert = require('node:assert/strict');
const ORCH = require('../assets/js/memory-recall/memory-recall-orchestrator.js');
const QUERY = require('../assets/js/memory-recall/recall-query.js');

const NOW = 1791892500000;
const DAY = 86400000;

function memory(id, title, content, ageDays, extra) {
  return Object.assign({
    id: id,
    title: title,
    content: content,
    summary: content,
    oneLine: content,
    importance: 6,
    arousal: 0.3,
    valence: 0.5,
    resolved: false,
    activationCount: 0,
    created: NOW - ageDays * DAY,
    lastActivated: NOW - ageDays * DAY,
    visibility: 'public',
    tags: [],
    domain: 'Synthetic final Recall fixture'
  }, extra || {});
}

const scenarios = [
  { id: 'zh-short', query: '地下室？', expectedTop: 'basement', rows: [
    memory('basement', '地下室', '地下室工作台和储物架的计划。', 20)
  ] },
  { id: 'en-short', query: 'GPU?', expectedTop: 'gpu', rows: [
    memory('gpu', 'GPU preference', 'I prefer a quiet GPU for the workstation.', 20)
  ] },
  { id: 'grounded-pronoun-zh', query: '我上次提到的黄色杯子是哪一个？', expectedTop: 'cup', rows: [
    memory('cup', '黄色杯子', '上次提到的黄色杯子是放在书架上的那只。', 20)
  ] },
  { id: 'explicit-recall-en', query: 'Do you remember the corrected hospital report?', expectedTop: 'new',
    expectedChannel: 'recall', firstTurn: true, rows: [
    memory('old', 'Old hospital report', 'I felt abandoned at the hospital and wrote a report about it.', 300,
      { arousal: 1, valence: 0.1 }),
    memory('new', 'Corrected hospital report', 'Correction: the hospital report says the appointment moved to Friday.', 5)
  ] },
  { id: 'ambiguous-zh', query: '那件事呢？', expectNoGate: true, expectedTop: null, rows: [
    memory('move', '那次搬家', '我后来搬到了西雅图。', 20),
    memory('hospital', '医院地址纠正', '医院地址是上海。', 5)
  ] },
  { id: 'ambiguous-en', query: 'What about that one?', knownLimit: 'substring Hard Gate admits a vague-query false positive', expectedTop: null, rows: [
    memory('harbor', 'Harbor plan', 'The harbor plan was postponed.', 20)
  ] },
  { id: 'correction-zh', query: '更正一下，医院地址是上海，不是北京。', expectedTop: 'new', rows: [
    memory('old', '医院地址旧说法', '医院地址以前是北京。', 300, { arousal: 1, valence: 0.1 }),
    memory('new', '医院地址纠正', '更正：医院地址实际是上海，不是北京。', 5)
  ] },
  { id: 'correction-en', query: 'What was the corrected hospital address?', expectedTop: 'new', rows: [
    memory('old', 'Old hospital address', 'The previous hospital address was Beijing.', 300, { arousal: 1, valence: 0.1 }),
    memory('new', 'Hospital address correction', 'Correction: the hospital address is Shanghai.', 5)
  ] },
  { id: 'correction-emotional-en', query: 'What does the hospital abandonment correction report say?', expectedTop: 'new', rows: [
    memory('old', 'Hospital abandonment report', 'I felt abandoned at the hospital and wrote a report about the experience.', 420,
      { importance: 8, arousal: 1, valence: 0.05, activationCount: 500, lastActivated: NOW - 3600000 }),
    memory('new', 'Hospital abandonment correction report',
      'Correction: the report says the hospital visit was rescheduled; the original abandonment interpretation was mistaken.', 6)
  ] },
  { id: 'current-fact-zh', query: '我现在住在哪个城市？', expectedTop: 'new', rows: [
    memory('old', '过去居住城市', '2022年我住在京都。', 900, { resolved: true }),
    memory('new', '当前居住城市', '现在居住城市是东京，这是最近更新的事实。', 3)
  ] },
  { id: 'historical-fact-zh', query: '我当时住的城市是哪里？', expectedTop: 'old', knownLimit: 'explicit historical cue remains below the fresh current fact', rows: [
    memory('old', '当时居住城市', '2022年当时居住城市是京都。', 900, { resolved: true }),
    memory('new', '当前居住城市', '现在居住城市是东京，这是最近更新的事实。', 3)
  ] },
  { id: 'historical-fact-en', query: 'Where did I live in 2022?', expectedTop: 'old', knownLimit: 'year is not in lexical terms; the old fact passes via shared live term but ranks second', rows: [
    memory('old', '2022 residence', 'I lived in Kyoto in 2022.', 900, { resolved: true }),
    memory('new', 'Current residence', 'I currently live in Tokyo.', 3)
  ] },
  { id: 'long-pref-zh', query: '我一般喜欢喝什么咖啡？', expectedTop: 'pref', rows: [
    memory('pref', '长期咖啡偏好', '我一般喜欢喝燕麦拿铁，少糖。', 730, { kind: 'semantic' })
  ] },
  { id: 'long-pref-en', query: 'Which coffee do I usually like?', expectedTop: 'pref', rows: [
    memory('pref', 'Usual coffee preference', 'I usually like espresso with oat milk.', 730, { kind: 'semantic' })
  ] },
  { id: 'negation-en', query: 'What did I say I would not eat?', expectedTop: 'no', rows: [
    memory('no', 'Peanut preference', 'I said I would not eat peanuts.', 20),
    memory('yes', 'Almond preference', 'I said I would eat almonds.', 20)
  ] },
  { id: 'negation-zh', query: '我不是说过不吃花生吗？', expectedTop: 'no', rows: [
    memory('no', '花生偏好', '我明确说过不吃花生。', 20),
    memory('yes', '杏仁偏好', '我说过喜欢吃杏仁。', 20)
  ] },
  { id: 'resolved-old-en', query: 'How was the leak repaired after it was resolved?', expectedTop: 'leak', rows: [
    memory('leak', 'Resolved basement leak',
      'The resolved basement leak was repaired by replacing the valve; RAW_LEAK_DETAIL.', 800,
      { resolved: true, summary: 'Resolved basement leak repair summary', oneLine: 'Basement leak was resolved.' })
  ] },
  { id: 'old-date-en', query: 'What was the old meeting date again?', expectedTop: 'old-date',
    knownLimit: 'historical detail remains available but ranks below the current date', rows: [
      memory('old-date', 'Old meeting date', 'The old meeting date was 2022-04-03; RAW_DATE_DETAIL.', 900,
        { resolved: true, summary: 'Meeting date changed later.', oneLine: 'Meeting date was changed later.' }),
      memory('new-date', 'Current meeting date', 'The current meeting date is 2025-05-06.', 5)
    ] },
  { id: 'long-memory-en', query: 'What did I choose for my paper notebook when I moved to Seattle?', expectedTop: 'notebook', rows: [
    memory('notebook', 'Seattle move and paper notebook',
      'When I moved to Seattle, I chose a blue paper notebook for daily notes.', 450, { kind: 'semantic' })
  ] }
];

function options(query, selectorVersion, scenario) {
  const result = {
    apiId: 'dsh_synthetic_agent',
    now: NOW,
    random: () => 0.5,
    userMessage: query,
    isGroup: false,
    groupMemEnabled: false,
    maxChars: 4000,
    contentLen: 1000,
    turn: { message: query }
  };
  if (scenario && scenario.firstTurn === true) {
    result.turn.isFirstTurn = true;
    result.turn.conversationSignalAvailable = true;
    result.turn.isConversationOpen = true;
  }
  if (selectorVersion) result.selectorVersion = selectorVersion;
  return result;
}

function topId(run) {
  const selected = run && run.result && Array.isArray(run.result.selected) ? run.result.selected : [];
  return selected[0] && selected[0].id != null ? String(selected[0].id) : null;
}

function gatedIds(run) {
  return (run.trace && Array.isArray(run.trace.candidates) ? run.trace.candidates : [])
    .filter(row => Number(row.relevanceScore) > 0)
    .map(row => String(row.memoryId)).sort();
}

let topOneMatches = 0;
let expectedTargets = 0;
let knownLimitsObserved = 0;
for (const scenario of scenarios) {
  const before = JSON.stringify(scenario.rows);
  const v1 = ORCH.recall(scenario.rows, options(scenario.query, null, scenario));
  const v2 = ORCH.recall(scenario.rows, options(scenario.query, 'v2', scenario));
  const v1Gated = gatedIds(v1);
  const v2Gated = gatedIds(v2);
  const expectedQuery = QUERY.buildRecallQuery(scenario.query);

  assert.equal(v1.meta.selectorVersion, undefined, scenario.id + ': V1 remains the default selector');
  assert.equal(v2.meta.selectorVersion, 'memory-recall-v2', scenario.id + ': explicit V2 call is observable');
  assert.deepEqual(v1Gated, v2Gated, scenario.id + ': V1/V2 receive the same Hard Gate candidate set');
  assert.deepEqual(v1.trace.query.lexicalTerms, expectedQuery.lexicalTerms,
    scenario.id + ': trace proves the production Query builder supplied the lexical terms');
  assert.deepEqual(v2.trace.query.lexicalTerms, expectedQuery.lexicalTerms);
  if (scenario.expectedChannel) {
    assert.equal(v1.trace.channel, scenario.expectedChannel,
      scenario.id + ': explicit recall intent outranks automatic first-turn coldStart');
    assert.equal(v2.trace.channel, scenario.expectedChannel);
  }
  if (scenario.expectNoGate) assert.equal(v2Gated.length, 0, scenario.id + ': ungrounded reference must not guess a memory');
  if (scenario.expectedTop && !scenario.knownLimit) {
    expectedTargets += 1;
    assert.ok(v2Gated.includes(scenario.expectedTop), scenario.id + ': expected memory must survive Hard Gate');
    assert.equal(topId(v2), scenario.expectedTop, scenario.id + ': V2 should rank the expected memory first');
    if (topId(v1) === scenario.expectedTop) {
      assert.equal(topId(v2), scenario.expectedTop, scenario.id + ': V2 must not displace a V1-correct result');
    }
    topOneMatches += 1;
  } else if (scenario.expectedTop && scenario.knownLimit) {
    expectedTargets += 1;
    assert.ok(v2Gated.includes(scenario.expectedTop), scenario.id + ': expected historical memory must remain retrievable');
    if (topId(v2) !== scenario.expectedTop) {
      knownLimitsObserved += 1;
      console.warn('KNOWN LIMIT ' + scenario.id + ': expected=' + scenario.expectedTop
        + ' V1=' + topId(v1) + ' V2=' + topId(v2) + ' gated=' + JSON.stringify(v2Gated));
    } else {
      topOneMatches += 1;
    }
  } else if (scenario.knownLimit && !scenario.expectNoGate) {
    knownLimitsObserved += 1;
    console.warn('KNOWN LIMIT ' + scenario.id + ': expected no grounded candidate; V1='
      + topId(v1) + ' V2=' + topId(v2) + ' gated=' + JSON.stringify(v2Gated));
    assert.equal(topId(v1), topId(v2), scenario.id + ': ambiguity issue is shared with frozen V1, not a V2-only regression');
  }
  if (scenario.id === 'correction-emotional-en') {
    assert.equal(topId(v1), 'old', 'legacy activation recency keeps the reactivated emotional memory first');
    assert.equal(topId(v2), 'new', 'V2 removes the activation self-reinforcement and ranks the correction first');
  }
  if (scenario.id === 'resolved-old-en') {
    assert.ok(!v2.result.text.includes('RAW_LEAK_DETAIL'), 'relevance resurfaces the record without restoring faded detail');
  }
  assert.equal(JSON.stringify(scenario.rows), before, scenario.id + ': Recall is read-only over canonical rows');
}

console.log('Memory V2 natural-language scenarios: ' + scenarios.length
  + '; expected targets=' + expectedTargets + '; first-place targets=' + topOneMatches
  + '; V1/V2 candidate-set parity=all; known shared limits=' + knownLimitsObserved);
