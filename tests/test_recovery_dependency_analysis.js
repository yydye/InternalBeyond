/* Synthetic-only classification policy tests for the P32-W.5 dependency audit.
 * No recovery source, filesystem, IndexedDB, Host, or provider is opened here. */
'use strict';

const assert = require('node:assert/strict');

function classifyReference(fixture) {
  if (fixture.targetExistsInBackup && !fixture.targetDomainSelected) {
    return 'TARGET_NOT_SELECTED_IN_RESTORE_SCOPE';
  }
  if (fixture.targetExistsInBackup && fixture.targetDomainSelected && !fixture.targetIndexedBeforeCheck) {
    return 'RESTORE_ORDER_PROBLEM';
  }
  if (fixture.targetExistsInBackup && fixture.targetDomainSelected && fixture.targetIndexedBeforeCheck &&
      !fixture.canonicalIdMatches && fixture.legacyIdMappingExists) {
    return 'LEGACY_ID_MAPPING_REQUIRED';
  }
  if (!fixture.targetExistsInBackup && !fixture.targetExistsInCurrentTarget) {
    return 'TARGET_MISSING_FROM_BACKUP';
  }
  if (fixture.canonicalIdMatches) return 'RESOLVED';
  return 'UNCLASSIFIED';
}

function classifyDomainConflict(fixture) {
  if (fixture.category !== 'DOMAIN_CONFLICT') return 'NOT_A_DOMAIN_CONFLICT';
  return fixture.underlyingReferenceBlockers > 0
    ? 'DOMAIN_CONFLICT_AGGREGATE'
    : 'UNEXPLAINED_DOMAIN_CONFLICT';
}

const checks = [
  ['missing target is a backup-missing reference', () => {
    assert.equal(classifyReference({
      targetExistsInBackup: false,
      targetExistsInCurrentTarget: false,
      targetDomainSelected: true,
      targetIndexedBeforeCheck: true,
      canonicalIdMatches: false,
      legacyIdMappingExists: false
    }), 'TARGET_MISSING_FROM_BACKUP');
  }],
  ['present target outside allowlist is scope-excluded', () => {
    assert.equal(classifyReference({
      targetExistsInBackup: true,
      targetExistsInCurrentTarget: false,
      targetDomainSelected: false,
      targetIndexedBeforeCheck: false,
      canonicalIdMatches: true,
      legacyIdMappingExists: false
    }), 'TARGET_NOT_SELECTED_IN_RESTORE_SCOPE');
  }],
  ['selected target checked before indexing is an order problem', () => {
    assert.equal(classifyReference({
      targetExistsInBackup: true,
      targetExistsInCurrentTarget: false,
      targetDomainSelected: true,
      targetIndexedBeforeCheck: false,
      canonicalIdMatches: false,
      legacyIdMappingExists: false
    }), 'RESTORE_ORDER_PROBLEM');
  }],
  ['legacy-only identity requires an explicit mapping', () => {
    assert.equal(classifyReference({
      targetExistsInBackup: true,
      targetExistsInCurrentTarget: false,
      targetDomainSelected: true,
      targetIndexedBeforeCheck: true,
      canonicalIdMatches: false,
      legacyIdMappingExists: true
    }), 'LEGACY_ID_MAPPING_REQUIRED');
  }],
  ['canonical identity in selected indexed target is resolved', () => {
    assert.equal(classifyReference({
      targetExistsInBackup: true,
      targetExistsInCurrentTarget: false,
      targetDomainSelected: true,
      targetIndexedBeforeCheck: true,
      canonicalIdMatches: true,
      legacyIdMappingExists: false
    }), 'RESOLVED');
  }],
  ['domain conflict is only an aggregate when row blockers exist', () => {
    assert.equal(classifyDomainConflict({ category: 'DOMAIN_CONFLICT', underlyingReferenceBlockers: 2 }), 'DOMAIN_CONFLICT_AGGREGATE');
    assert.equal(classifyDomainConflict({ category: 'DOMAIN_CONFLICT', underlyingReferenceBlockers: 0 }), 'UNEXPLAINED_DOMAIN_CONFLICT');
  }]
];

console.log('P32-W.5 synthetic dependency classification tests');
for (const [name, check] of checks) {
  check();
  console.log(`✓ ${name}`);
}
console.log(`PASS ${checks.length} synthetic dependency checks`);
