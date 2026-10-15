'use strict';

/* P5-B3-K · session-only lifecycle, real user confirmation, and closed report transport. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CANDIDATE = require('../assets/js/free-text-report-candidate.js');

let passed = 0;
function check(name, condition, detail) {
  assert.equal(!!condition, true, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
  passed++;
  console.log('PASS ' + name);
}
function source(id, content, friendId, threadId) {
  return { id: id, role: 'user', content: content, friendId: friendId, threadId: threadId || '' };
}
function makeSession(over) {
  let sequence = 0;
  return CANDIDATE.createSession(Object.assign({
    clock: () => 1000,
    ttlMs: 100,
    candidateIdFactory: () => 'candidate-' + (++sequence),
    requestIdFactory: () => 'request-' + (++sequence)
  }, over || {}));
}
function createPending(session, text, ref, scope) {
  const msg = source(ref, text, scope.characterId, scope.threadId);
  const candidate = CANDIDATE.extractCandidate(text, ref);
  return { msg: msg, created: session.create(candidate, scope, msg) };
}

(async function main() {
  const scope = { characterId: 'char_a', threadId: 'thread_a' };
  const session = makeSession();
  const one = createPending(session, 'I like scifi', 'source-1', scope);
  let submitCalls = 0;
  const actionPayloads = [];
  check('candidate-stays-pending-with-no-canonical-side-effects', one.created.ok === true
    && one.created.status === 'pending' && submitCalls === 0
    && session.describe().durable === false && session.describe().memoryWrites === 0
    && session.describe().relationshipWrites === 0);
  check('candidate-and-action-identities-are-distinct', one.created.candidateId.indexOf('ftpc_') === 0
    && one.created.candidateId !== one.created.candidate.sourceMessageRef
    && !Object.prototype.hasOwnProperty.call(one.created.candidate, 'characterId')
    && !Object.prototype.hasOwnProperty.call(one.created.candidate, 'reportId'));

  const accepted = payload => {
    submitCalls++;
    actionPayloads.push(payload);
    return Promise.resolve({ ok: true, outcome: 'accepted', reportId: 'pref_report_authority_1' });
  };
  const replayed = await Promise.all(Array.from({ length: 100 }, () =>
    session.confirm(one.created.candidateId, scope, one.msg, accepted)));
  const action = actionPayloads[0];
  check('confirm-is-an-explicit-action-and-replays-one-logical-submit', submitCalls === 1
    && replayed.every(x => x.ok === true && x.status === 'confirmed')
    && session.get(one.created.candidateId).status === 'confirmed');
  check('confirmation-builds-only-the-existing-structured-report-envelope', action
    && JSON.stringify(Object.keys(action).sort()) === JSON.stringify(['characterId', 'requestId', 'stance', 'targetKey', 'threadId'])
    && action.characterId === scope.characterId && action.threadId === scope.threadId
    && action.stance === 'like' && action.targetKey === 'scifi'
    && action.requestId.indexOf('ftrq_') === 0
    && action.requestId !== one.created.candidateId
    && !Object.prototype.hasOwnProperty.call(action, 'sourceMessageRef'));

  const declinedSession = makeSession();
  const declined = createPending(declinedSession, 'I dislike scifi', 'source-decline', scope);
  let declinedCalls = 0;
  const dismissal = declinedSession.dismiss(declined.created.candidateId);
  await declinedSession.confirm(declined.created.candidateId, scope, declined.msg, () => { declinedCalls++; });
  check('decline-dismisses-with-zero-report-submissions', dismissal.status === 'dismissed' && declinedCalls === 0);

  let expiryNow = 1000;
  const expirySession = makeSession({ clock: () => expiryNow });
  const expiry = createPending(expirySession, 'I like scifi', 'source-expiry', scope);
  let expiryCalls = 0;
  expiryNow = 1200;
  const expiryState = expirySession.get(expiry.created.candidateId);
  await expirySession.confirm(expiry.created.candidateId, scope, expiry.msg, () => { expiryCalls++; });
  check('expired-candidate-cannot-be-confirmed', expiryState.status === 'expired' && expiryCalls === 0);

  const staleSession = makeSession();
  const stale = createPending(staleSession, 'I like scifi', 'source-stale', scope);
  let staleCalls = 0;
  const staleResult = await staleSession.confirm(stale.created.candidateId,
    { characterId: 'char_b', threadId: 'thread_b' }, stale.msg, () => { staleCalls++; });
  check('wrong-conversation-or-character-fails-closed', staleResult.status === 'expired' && staleCalls === 0);

  const deletedSession = makeSession();
  const deleted = createPending(deletedSession, 'I like scifi', 'source-deleted', scope);
  let deletedCalls = 0;
  const deletedResult = await deletedSession.confirm(deleted.created.candidateId, scope, null, () => { deletedCalls++; });
  check('missing-source-message-fails-closed', deletedResult.status === 'expired' && deletedCalls === 0);

  const changedSession = makeSession();
  const changed = createPending(changedSession, 'I like scifi', 'source-changed', scope);
  let changedCalls = 0;
  const changedResult = await changedSession.confirm(changed.created.candidateId, scope,
    Object.assign({}, changed.msg, { content: 'I dislike scifi' }), () => { changedCalls++; });
  check('changed-source-message-fails-closed', changedResult.status === 'expired' && changedCalls === 0);

  const tamperedSession = makeSession();
  const tamperedCandidate = Object.assign({}, CANDIDATE.extractCandidate('I like scifi', 'source-tampered'), {
    reportId: 'forged', predictionId: 'forged', characterId: 'forged', conversationId: 'forged', explicit: true
  });
  const tamperedSource = source('source-tampered', 'I like scifi', scope.characterId, scope.threadId);
  const tampered = tamperedSession.create(tamperedCandidate, scope, tamperedSource);
  check('candidate-authority-field-attack-is-dropped', tampered.ok === true
    && JSON.stringify(Object.keys(tampered.candidate).sort()) === JSON.stringify(['sourceMessageRef', 'stance', 'targetKey', 'version'])
    && !Object.prototype.hasOwnProperty.call(tampered.candidate, 'reportId'));

  const retrySession = makeSession();
  const retry = createPending(retrySession, 'I dislike scifi', 'source-retry', scope);
  const retryIds = [];
  let attempts = 0;
  await retrySession.confirm(retry.created.candidateId, scope, retry.msg, payload => {
    attempts++; retryIds.push(payload.requestId); return { ok: false, error: 'offline' };
  });
  await retrySession.confirm(retry.created.candidateId, scope, retry.msg, payload => {
    attempts++; retryIds.push(payload.requestId); return { ok: true, outcome: 'accepted', reportId: 'authority-report' };
  });
  check('retry-reuses-the-same-structured-action-idempotency-key', attempts === 2 && retryIds[0] === retryIds[1]);

  const lostSession = makeSession();
  const lost = createPending(lostSession, 'I like scifi', 'source-lost', scope);
  check('candidate-is-session-only', makeSession().get(lost.created.candidateId) === null);

  /* Execute the actual Home Node browser transport with a fake fetch. The
     wrapper must retain its credential path and project a closed five-key body. */
  const clientSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'home-node-client.js'), 'utf8');
  let captured = null;
  const fakeWindow = { IB: {} };
  const context = {
    window: fakeWindow,
    localStorage: { getItem: key => key === 'ib_home_node_token' ? 'desktop-token' : null },
    fetch: (url, init) => {
      captured = { url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, reportId: 'authority-report' })) });
    },
    AbortController: AbortController,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: console,
    URL: URL,
    Promise: Promise,
    Math: Math,
    Date: Date,
    Object: Object,
    String: String,
    Array: Array,
    Number: Number,
    JSON: JSON,
    Error: Error
  };
  vm.runInNewContext(clientSource, context, { filename: 'home-node-client.js' });
  const remote = fakeWindow.IB.createExplicitPreferenceReportRemote({ writeTimeoutMs: 1000 });
  await remote.submit({
    requestId: 'ftrq-test', characterId: 'char_a', targetKey: 'scifi', stance: 'like', threadId: 'thread_a',
    candidateId: 'must-not-cross', sourceMessageRef: 'must-not-cross', confidence: 99, reportId: 'forged', predictionId: 'forged',
    provider: 'must-not-cross', model: 'must-not-cross', endpoint: 'must-not-cross', apiKey: 'must-not-cross'
  });
  check('client-calls-the-existing-report-route-through-credentialed-home-node-transport',
    captured && captured.url.endsWith('/internal/user-reports/preference') && captured.method === 'POST'
    && captured.headers['X-IB-Home-Token'] === 'desktop-token');
  check('client-transport-strips-candidate-and-report-authority-fields', captured
    && JSON.stringify(Object.keys(captured.body).sort()) === JSON.stringify(['characterId', 'requestId', 'stance', 'targetKey', 'threadId'])
    && captured.body.requestId === 'ftrq-test');
  const communication = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'communication.js'), 'utf8');
  const candidateAdapterStart = communication.indexOf('function _ibFreeTextReportAttach');
  const candidateAdapterEnd = communication.indexOf('async function sendChatMessage', candidateAdapterStart);
  const candidateAdapter = candidateAdapterStart >= 0 && candidateAdapterEnd > candidateAdapterStart
    ? communication.slice(candidateAdapterStart, candidateAdapterEnd) : '';
  check('chat-candidate-and-confirm-adapter-has-no-memory-calendar-or-workspace-writer',
    !!candidateAdapter && !/_parseMemOps|_execMemOps|IBCAL\.processReply|_parseWsOps|_execWsOps|\bdbPut\s*\(|\bdbDelete\s*\(/.test(candidateAdapter));

  console.log('FREE TEXT REPORT CONFIRMATION PASSED · ' + passed + ' assertions');
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
