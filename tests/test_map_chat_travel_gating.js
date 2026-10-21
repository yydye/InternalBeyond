'use strict';

/* Focused policy-boundary regression for Chat -> Map tool execution.
 * Map's own ticket/role-permission checks remain authoritative; an UNDECIDED
 * generic ICode Workspace verdict must not suppress an explicitly ticketed trip. */
const fs = require('node:fs');
const assert = require('node:assert/strict');

const source = fs.readFileSync('assets/js/communication.js', 'utf8');
function grab(re, label) {
  const match = source.match(re);
  assert.ok(match, 'missing source helper: ' + label);
  return match[0];
}
const helpers = [
  grab(/var _MB_SEC=\{[^\n]*\}/, '_MB_SEC'),
  grab(/function _mbSecWsCat\(op\)\{[\s\S]*?\n\}/, '_mbSecWsCat'),
  grab(/function _mbSecWsCats\(ops\)\{[\s\S]*?\n\}/, '_mbSecWsCats'),
  grab(/function _mbSecWsCount\(ops,fileCount\)\{[\s\S]*?\n\}/, '_mbSecWsCount'),
  grab(/function _ibIsMapWsOp\(op\)\{[\s\S]*?\n\}/, '_ibIsMapWsOp'),
  grab(/async function _ibExecChatWsOps\(ops,authorName,cfg,ictx\)\{[\s\S]*?\n\}/, '_ibExecChatWsOps'),
  grab(/function _ibShouldContinueWsOps\(ops,files,results\)\{[\s\S]*?\n\}/, '_ibShouldContinueWsOps'),
  grab(/function _ibMapWorkspaceResultSnapshot\(ops,results\)\{[\s\S]*?\n\}/, '_ibMapWorkspaceResultSnapshot')
].join('\n');

const executed = [];
const gateCalls = [];
const gate = (cats, count) => {
  gateCalls.push({ cats: (cats || []).slice(), count });
  return !cats || !cats.includes('workspace');
};
const runWsOps = async ops => {
  ops.forEach(op => executed.push(op.type));
  return ops.map(op => ({ type: op.type, ok: true, detail: op.type === 'trip' ? '巴黎 · Mock' : '' }));
};
const api = new Function('_execWsOps', '_mbSideEffectGateCats', '"use strict";'
  + helpers
  + '\nreturn {cats:_mbSecWsCats,mapOp:_ibIsMapWsOp,exec:_ibExecChatWsOps,continueAllowed:_ibShouldContinueWsOps,snapshot:_ibMapWorkspaceResultSnapshot};'
)(runWsOps, gate);

(async () => {
  const ops = [
    { type: 'trip' },
    { type: 'create', path: 'unapproved.txt', content: 'should remain gated' },
    { type: 'trip_note', body: 'synthetic travel note' }
  ];
  assert.deepEqual(api.cats([{ type: 'trip' }, { type: 'trip_note' }, { type: 'traces' }]), []);
  assert.deepEqual(api.cats([{ type: 'create' }]), ['workspace']);
  const results = await api.exec(ops, 'Synthetic Role', { id: 'synthetic-role' }, {});
  assert.deepEqual(executed, ['trip', 'trip_note']);
  assert.equal(results.length, ops.length, 'result positions must stay aligned with parsed operations');
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].executionSkipped, true);
  assert.equal(results[2].ok, true);
  assert.deepEqual(gateCalls, [{ cats: ['workspace'], count: 1 }]);
  assert.equal(api.continueAllowed(ops, [], results), true,
    'a successful Map-owned operation can finish its ticketed continuation while unrelated ICode remains blocked');
  assert.equal(api.continueAllowed([ops[1]], [], [results[1]]), false,
    'a blocked generic Workspace operation must not trigger a continuation call');
  const unknown = api.snapshot([{ type: 'trip' }], [])[0];
  assert.equal(unknown.ok, false);
  assert.equal(unknown.executionKnown, false);
  assert.match(unknown.reason, /不能据此认定旅行/);
  const saved = api.snapshot([{ type: 'trip' }], [{ type: 'trip', ok: true, detail: '巴黎 · Mock', response: 'not persisted', trip: { lat: 48.8, lon: 2.3 } }])[0];
  assert.deepEqual(saved, { type: 'trip', ok: true, executionKnown: true, reason: '', detail: '巴黎 · Mock', mode: '' },
    'history keeps a bounded execution receipt without persisting provider payload or coordinates');
  console.log('PASS Map travel stays in its ticketed authority; generic Workspace remains gated; unknown results never render success.');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
