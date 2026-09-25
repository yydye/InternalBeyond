'use strict';

const assert=require('assert');
const crypto=require('crypto');
const Composite=require('../assets/js/composite-recovery-plan.js');

const TRACE='420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5';
const expectedId='p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca';
const expectedHash='f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7';

const revision=Composite.testOnly.authorityRevisionPayload(TRACE);
const hash=crypto.createHash('sha256').update(Composite.testOnly.stableJson(revision),'utf8').digest('hex');
assert.strictEqual(hash,expectedHash,'authority revision hash stays bound to its frozen inputs and evidence');
assert.strictEqual('p32-w5-r3b3-p5.6.2:'+hash.slice(0,24),expectedId);
assert.strictEqual(Composite.PLAN_ID,'p32-w5-r3b3-p5.5:f99b6f236ecd78d3c111d106');
assert.strictEqual(Composite.PLAN_SHA256,'f99b6f236ecd78d3c111d106d3c1714b9790f65f09c34937de62ba21a9aea117');
assert.strictEqual(Composite.AUTHORITY_REVISION_ID,expectedId);
assert.strictEqual(Composite.AUTHORITY_REVISION_SHA256,expectedHash);
assert.strictEqual(revision.authority.previous,'USER_ASSERTED');
assert.strictEqual(revision.authority.current,'USER_CONFIRMED_IDENTITY_SUCCESSION');
assert.strictEqual(revision.authority.identitySuccession.oldId,'friend_1785260690497');
assert.strictEqual(revision.authority.identitySuccession.newId,'friend_1788318367937_tcmw0p');
assert.strictEqual(revision.priorIdentityEvidence.hiBit.evidenceClass,'B_TEMPORAL_COEXISTENCE_ONLY');
assert.strictEqual(revision.priorIdentityEvidence.hiBit.explicitTransitionFound,false);
assert.strictEqual(revision.priorIdentityEvidence.roleContinuity.evidenceClass,'B_PARTIAL_ROLE_SIMILARITY');
assert.strictEqual(revision.provenance.recordCount,539);
assert.strictEqual(revision.credentialPolicy.credentialBearingFieldsImported,0);
assert.strictEqual(revision.credentialPolicy.secretValuesProjected,0);
assert.strictEqual(revision.targetBinding.status,'NOT_BOUND_UNTIL_READ_ONLY_PRODUCTION_DRY_RUN');
assert.strictEqual(Composite.testOnly.createSyntheticPackage().identitySuccession[0].authority,'USER_ASSERTED','legacy authority remains supported');

const legacy=Composite.testOnly.createSyntheticPackage();
assert.strictEqual(legacy.identitySuccession[0].authority,'USER_ASSERTED','legacy authority remains supported');

console.log('PASS P5.6.2 authority revision identity and frozen P5.5 compatibility');
