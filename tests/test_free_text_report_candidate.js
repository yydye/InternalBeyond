'use strict';

/* P5-B3-K · deterministic candidate-only parser. No report, HTTP, DOM, or Memory IO. */
const assert = require('node:assert/strict');
const CANDIDATE = require('../assets/js/free-text-report-candidate.js');

let passed = 0;
function check(name, condition, detail) {
  assert.equal(!!condition, true, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
  passed++;
  console.log('PASS ' + name);
}

const like = CANDIDATE.extractCandidate('I like SciFi.', 'chat-msg-1');
const dislike = CANDIDATE.extractCandidate('I dislike scifi', 'chat-msg-2');
check('exact-current-first-person-like-creates-candidate', !!like && like.stance === 'like' && like.targetKey === 'scifi');
check('exact-current-first-person-dislike-creates-candidate', !!dislike && dislike.stance === 'dislike' && dislike.targetKey === 'scifi');
check('candidate-reuses-existing-target-canonicalizer', like && like.targetKey === 'scifi'
  && CANDIDATE.extractCandidate('I like bad key', 'chat-msg-3') === null);
check('candidate-shape-has-no-report-or-scope-authority', like
  && JSON.stringify(Object.keys(like).sort()) === JSON.stringify(['sourceMessageRef', 'stance', 'targetKey', 'version'])
  && !['reportId', 'predictionId', 'characterId', 'conversationId', 'occurredAt', 'source', 'sourceInstance',
    'settlementState', 'calibrationCounted', 'validated', 'explicit'].some(k => Object.prototype.hasOwnProperty.call(like, k)));
check('chinese-exact-current-first-person-is-candidate-only',
  CANDIDATE.extractCandidate('我不喜欢 scifi。', 'chat-msg-4').stance === 'dislike');

const rejected = [
  '"I like scifi"', '“I like scifi”', "'I like scifi'", 'If I like scifi',
  'I used to like scifi', 'She says I like scifi', 'She likes scifi',
  'I might like scifi', 'I maybe like scifi', 'I kind of like scifi',
  'As the wizard, I like scifi', 'I like scifi?', '我可能喜欢 scifi', '我以前喜欢 scifi',
  '她说我喜欢 scifi', '如果我喜欢 scifi', 'I like sci fi'
];
check('quoted-hypothetical-historical-third-person-uncertain-roleplay-and-ambiguous-text-rejected',
  rejected.every(s => CANDIDATE.extractCandidate(s, 'chat-msg-negative') === null), rejected);
check('candidate-requires-a-source-message-reference', CANDIDATE.extractCandidate('I like scifi', '') === null);
check('candidate-parser-rejects-non-text-model-payload', CANDIDATE.extractCandidate({ stance: 'like', targetKey: 'scifi' }, 'chat-msg-5') === null);

console.log('FREE TEXT REPORT CANDIDATE PASSED · ' + passed + ' assertions');
