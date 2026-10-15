'use strict';

/*
 * P27-C2 v2 candidate contract. This test is additive evidence only: it does
 * not replace or weaken test_p27_closure_guard.js C2 v1. A maintainer must
 * approve the distinction before the RC gate treats it as an authorization.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const REALITY = require(path.join(ROOT, 'services/home-node/runtime-reality-event.js'));

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function stripComments(source) {
  return String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function collectProductionJs(root) {
  const out = [];
  const excludedDirectories = new Set(['.git', '.dsh-tmp', 'node_modules', 'target', 'dist', 'tmp']);
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.js$/i.test(entry.name)) {
        const relative = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
        if (!/^(tests|docs|tools|runtime|game)\//.test(relative)) out.push(relative);
      }
    }
  }
  visit(root);
  return out.sort();
}

const AUTHORIZED_SCHEMA_CONSUMERS = Object.freeze([
  'assets/js/activity/activity-runtime.js',
  'services/home-node/runtime-reality-event.js'
]);

function isExactCandidateConsumerSet(files) {
  const actual = (Array.isArray(files) ? files : []).slice().sort();
  return JSON.stringify(actual) === JSON.stringify(AUTHORIZED_SCHEMA_CONSUMERS.slice().sort());
}

const productionConsumers = collectProductionJs(ROOT).filter(function (relative) {
  if (relative === 'assets/js/domain-event-core.js') return false;
  return /IBDomainEventCore|createDomainEvent/.test(stripComments(read(relative)));
});

assert.deepEqual(productionConsumers, AUTHORIZED_SCHEMA_CONSUMERS.slice().sort(),
  'only Activity lifecycle and the separately sealed RealityEvent authority may consume the shared schema');
assert.equal(isExactCandidateConsumerSet(productionConsumers), true,
  'current production consumers match the candidate inventory');
assert.equal(isExactCandidateConsumerSet(productionConsumers.concat('services/home-node/unreviewed-event.js')), false,
  'an unreviewed consumer must fail closed');

const activityRuntime = stripComments(read('assets/js/activity/activity-runtime.js'));
assert.equal(activityRuntime.split('createDomainEvent({').length - 1, 1,
  'Activity Runtime retains one lifecycle event creation site');
assert.match(activityRuntime, /domain:'activity',type:'created'/,
  'Activity Runtime owns the single activity.created lifecycle event');

const expectedSources = {
  'runtime-activity': {
    source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.activity', domain: 'activity',
    allowedTypes: ['available', 'unavailable']
  },
  'runtime-delivery': {
    source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.delivery', domain: 'delivery',
    allowedTypes: ['queued', 'delivering', 'completed', 'cancelled', 'failed']
  },
  'runtime-memory-store': {
    source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.memory-store', domain: 'memory',
    allowedTypes: ['record-written', 'record-refused']
  },
  'turn-terminal': {
    source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.turn-execution', domain: 'runtime',
    allowedTypes: ['turn_terminal']
  },
  'user-explicit-preference-report': {
    source: 'EXPLICIT_USER_REPORT', sourceInstance: 'user.explicit-preference-report', domain: 'user_preference',
    allowedTypes: ['preference_report']
  }
};

assert.equal(Object.isFrozen(REALITY.REALITY_SOURCES), true, 'RealityEvent source registry remains immutable');
assert.deepEqual(REALITY.ALLOWED_REALITY_SOURCE_CLASSES,
  ['CANONICAL_RUNTIME', 'EXPLICIT_USER_REPORT'], 'source classes remain closed');
assert.deepEqual(Object.keys(REALITY.REALITY_SOURCES).sort(), Object.keys(expectedSources).sort(),
  'RealityEvent source IDs remain a closed set');
for (const sourceId of Object.keys(expectedSources)) {
  const source = REALITY.REALITY_SOURCES[sourceId];
  const expected = expectedSources[sourceId];
  assert.equal(Object.isFrozen(source), true, sourceId + ' source row remains immutable');
  assert.equal(source.source, expected.source, sourceId + ' source class');
  assert.equal(source.sourceInstance, expected.sourceInstance, sourceId + ' source instance');
  assert.equal(source.domain, expected.domain, sourceId + ' domain');
  assert.deepEqual(source.allowedTypes, expected.allowedTypes, sourceId + ' closed type set');
}

const authority = REALITY.createRuntimeRealityEvent({});
assert.equal(typeof authority.registerSource, 'undefined', 'runtime exposes no dynamic source-registration API');
const accepted = authority.ingest({
  sourceId: 'runtime-activity',
  sourceEvent: {
    eventId: 'p27-c2-v2-activity-available', domain: 'activity', type: 'available',
    entityId: 'activity_c2_v2', timestamp: 1791500000000,
    characterId: 'role_c2_v2', conversationId: 'dm:role_c2_v2'
  }
});
assert.equal(accepted.ok, true, 'RealityEvent may canonicalize an allowlisted activity runtime-state fact');
assert.equal(authority.isRealityEvent(accepted.realityEvent), true, 'the result remains a sealed RealityEvent');
assert.equal(accepted.realityEvent.realitySourceId, 'runtime-activity');
assert.equal(accepted.realityEvent.sourceInstance, 'runtime.activity');
assert.equal(accepted.realityEvent.domain, 'activity');
assert.equal(accepted.realityEvent.type, 'available');

const activityCreated = authority.ingest({
  sourceId: 'runtime-activity',
  sourceEvent: {
    eventId: 'p27-c2-v2-forbidden-created', domain: 'activity', type: 'created',
    entityId: 'activity_c2_v2', timestamp: 1791500000001
  }
});
assert.equal(activityCreated.ok, false, 'RealityEvent cannot duplicate the Activity lifecycle event');
assert.equal(activityCreated.reasonCode, REALITY.REASON.typeNotPermitted);

const wrongDomain = authority.ingest({
  sourceId: 'runtime-activity',
  sourceEvent: {
    eventId: 'p27-c2-v2-wrong-domain', domain: 'delivery', type: 'available',
    entityId: 'activity_c2_v2', timestamp: 1791500000002
  }
});
assert.equal(wrongDomain.ok, false);
assert.equal(wrongDomain.reasonCode, REALITY.REASON.domainMismatch);

const unknownSource = authority.ingest({
  sourceId: 'unreviewed-activity',
  sourceEvent: {
    eventId: 'p27-c2-v2-unknown-source', domain: 'activity', type: 'available',
    entityId: 'activity_c2_v2', timestamp: 1791500000003
  }
});
assert.equal(unknownSource.ok, false);
assert.equal(unknownSource.reasonCode, REALITY.REASON.unknownSource);

const describe = authority.describe();
assert.equal(describe.durableWrites, 0, 'RealityEvent remains session-only with no durable event writer');
assert.equal(describe.dynamicSourceRegistration, 'FORBIDDEN');
assert.doesNotMatch(stripComments(read('services/home-node/runtime-reality-event.js')), /\bdbPut\s*\(|\bdbDelete\s*\(/,
  'RealityEvent authority does not write the Activity store or another canonical store');

console.log('P27-C2 v2 candidate contract passed; historical C2 v1 remains unchanged');
