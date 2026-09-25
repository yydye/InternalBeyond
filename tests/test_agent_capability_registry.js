'use strict';

/* Internal Beyond · P25-3A · Agent Capability Registry 测试（R1–R12；纯 Node） */

const fs = require('fs');
const path = require('path');
const R = require(path.join(__dirname, '..', 'assets', 'js', 'agent-capability-registry.js'));

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const REG_SRC = stripComments(read('assets/js/agent-capability-registry.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2714 ' + name); }
  else { failed++; failures.push(name); console.log('  \u2716 ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 300))); }
}
const descriptor = (patch) => Object.assign({
  id: 'moment.post', domain: 'moment', kind: 'write', description: '发布一条动态',
  sideEffect: 'local', authorityType: 'autonomy', binding: 'moments.autonomy.pipeline'
}, patch || {});

console.log('== P25-3A · Capability Registry 测试 ==');
const reg = R.createCapabilityRegistry();

/* R1 valid capability register */
const r1 = reg.register(descriptor());
check('R1.validCapabilityRegister', r1.ok === true && r1.capability.id === 'moment.post' && reg.size() === 1, r1);

/* R2 duplicate id rejected */
check('R2.duplicateIdRejected', reg.register(descriptor()).ok === false && reg.register(descriptor()).errors.indexOf('duplicate-id') >= 0);

/* R3 malformed id rejected */
check('R3.malformedIdRejected',
  reg.register(descriptor({ id: 'Moment.Post' })).errors.indexOf('bad-id') >= 0
  && reg.register(descriptor({ id: 'moment' })).errors.indexOf('bad-id') >= 0
  && reg.register(descriptor({ id: 'moment.post!' })).errors.indexOf('bad-id') >= 0
  && reg.register(descriptor({ id: 'other.post' })).errors.indexOf('id-domain-mismatch') >= 0
  && reg.register(descriptor({ id: 'moment.comment.delete', binding: 'moments.mutation.comment.delete' })).ok === true);

/* R4 unknown capability */
check('R4.unknownCapability', reg.get('moment.nope') === null && reg.has('moment.nope') === false && reg.list({ domain: 'nope' }).length === 0);

/* R5 stable enumeration */
reg.register(descriptor({ id: 'diary.write', domain: 'diary', kind: 'write', authorityType: 'domain', binding: 'diary.write' }));
reg.register(descriptor({ id: 'moment.read', domain: 'moment', kind: 'read', sideEffect: 'none', authorityType: 'read-only', binding: 'moments.read' }));
const list1 = reg.list().map(d => d.id).join(',');
const list2 = reg.list().map(d => d.id).join(',');
check('R5.stableEnumeration',
  list1 === list2 && list1 === ['diary.write', 'moment.comment.delete', 'moment.post', 'moment.read'].join(',')
  && JSON.stringify(reg.snapshot().capabilities.map(d => d.id)) === JSON.stringify(reg.list().map(d => d.id)), list1);

/* R6 descriptor immutable */
check('R6.descriptorImmutable', (() => {
  const d = reg.get('moment.post');
  try { d.kind = 'read'; } catch (e) { /* strict 抛错也接受 */ }
  return Object.isFrozen(d) && d.kind === 'write' && Object.isFrozen(d.notes);
})());

/* R7 secret fields rejected */
check('R7.secretFieldsRejected',
  reg.register(descriptor({ id: 'moment.a1', apiKey: 'sk-abcdefgh12345678' })).ok === false
  && reg.validate(descriptor({ id: 'moment.a3', endpoint: 'http://x' })).errors.join(',').indexOf('forbidden-field') >= 0
  && reg.validate(descriptor({ id: 'moment.a4', description: 'Bearer abcdefghijklmn' })).errors.join(',').indexOf('secret-value') >= 0);

/* R8 function leakage rejected（metadata 必须可序列化） */
check('R8.functionLeakageRejected',
  reg.validate(descriptor({ id: 'moment.a5', notes: ['ok', () => {}] })).errors.join(',').indexOf('function-not-allowed') >= 0
  && reg.validate(descriptor({ id: 'moment.a5b', handler: () => {} })).errors.join(',').indexOf('forbidden-field:handler') >= 0
  && reg.validate(descriptor({ id: 'moment.a6', notes: ['ok'] })).ok === true
  && JSON.stringify(reg.snapshot()).indexOf('function') < 0);

/* R9/R10/R11/R12 纯度与边界（源码守卫） */
check('R9.noDb', !/indexedDB|dbPut|dbGet|localStorage|DB\./.test(REG_SRC));
check('R10.noDom', !/document|window\.|querySelector|createElement|window!==/.test(REG_SRC));
check('R11.noModel', !/callApiChat|fetch\(|provider|model|_momentsModelCall/i.test(REG_SRC.replace(/FORBIDDEN_DESCRIPTOR_KEYS[\s\S]*?\]\);/g, '')));
check('R12.noAuthorityDecision',
  !/\.decide|decideMoment|authorize\(|runAutonomyAction|runMomentMutation|routeImageRequest|decision\s*[:=]/i.test(REG_SRC)
  && !/\bexecutorRegistry|executeCapability/.test(REG_SRC)
  && typeof reg.register === 'function' && reg.decide === undefined && reg.execute === undefined);
check('R12b.readCapabilityNeedsNoAuthorityButNoSideEffect',
  R.buildCapabilityDescriptor(descriptor({ id: 'moment.b1', kind: 'read', sideEffect: 'none', authorityType: 'read-only', binding: 'moments.read' })).ok === true
  && R.buildCapabilityDescriptor(descriptor({ id: 'moment.b2', kind: 'read', sideEffect: 'local', authorityType: 'read-only', binding: 'x' })).ok === false
  && R.buildCapabilityDescriptor(descriptor({ id: 'moment.b3', kind: 'write', sideEffect: 'local', authorityType: 'read-only', binding: 'x' })).errors.indexOf('side-effect-capability-needs-authority') >= 0);

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')));
console.log('P25-3A · capability registry: ' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
