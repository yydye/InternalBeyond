'use strict';

/*
 * R9 staging-only shadow migration transaction layer.
 *
 * This layer is deliberately test-owned. It writes only metadata to the
 * caller-provided temporary staging directory and never knows a secret.
 */

const fs = require('fs');
const path = require('path');

const EXPLICIT_COMMIT_TOKEN = 'R9-STAGING-COMMIT';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class CredentialShadowMigration {
  constructor(options) {
    this.stagingDir = String(options && options.stagingDir || '');
    this.state = clone(options && options.initialState || {});
    this.beforeState = null;
    this.snapshot = null;
    this.committed = false;
    if (!this.stagingDir) throw new Error('staging-dir-required');
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  prepare(candidates) {
    if (this.snapshot) throw new Error('transaction-already-prepared');
    const list = Array.isArray(candidates) ? candidates : [];
    this.beforeState = clone(this.state);
    this.snapshot = {
      schemaVersion: 1,
      transactionClass: 'credential-ref-shadow',
      transactionId: 'r9-staging-transaction',
      rollbackPointer: 'rollback:r9-staging-transaction',
      sourceMode: 'read-only-authority-projection',
      candidates: list.map(candidate => ({
        bindingId: candidate.bindingId,
        consumer: candidate.consumer,
        authorityScope: candidate.authorityScope,
        mappingDecision: candidate.mappingDecision,
        credentialStatus: candidate.credentialStatus,
        legacyPresence: candidate.legacyPresence,
        credentialRefCandidate: candidate.credentialRefCandidate || null,
        conflictState: candidate.conflictState || 'none'
      }))
    };
    fs.writeFileSync(
      path.join(this.stagingDir, 'r9-migration-snapshot.json'),
      JSON.stringify(this.snapshot, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(this.stagingDir, 'r9-shadow-before.json'),
      JSON.stringify(this.state, null, 2),
      'utf8'
    );
    return {
      candidateBindings: list.length,
      resolved: list.filter(item => item.mappingDecision === 'resolved' || item.mappingDecision === 'not-required').length,
      unresolved: list.filter(item => item.mappingDecision === 'unresolved').length,
      conflicts: list.filter(item => item.mappingDecision === 'conflict').length,
      dryRun: true,
      productionWrites: 0
    };
  }

  commit(options) {
    if (!this.snapshot || !this.beforeState) throw new Error('transaction-not-prepared');
    if (!options || options.approvalToken !== EXPLICIT_COMMIT_TOKEN) {
      throw new Error('explicit-commit-required');
    }
    const next = clone(this.state);
    for (const candidate of this.snapshot.candidates) {
      if (candidate.mappingDecision !== 'resolved') continue;
      if (!next[candidate.consumer]) next[candidate.consumer] = {};
      if (!next[candidate.consumer][candidate.bindingId]) {
        next[candidate.consumer][candidate.bindingId] = {};
      }
      const row = next[candidate.consumer][candidate.bindingId];
      row.legacyPresence = candidate.legacyPresence;
      row.credentialRef = candidate.credentialRefCandidate;
      row.credentialStatus = candidate.credentialStatus;
      row.shadow = true;
    }
    this.state = next;
    this.committed = true;
    fs.writeFileSync(
      path.join(this.stagingDir, 'r9-shadow-committed.json'),
      JSON.stringify(this.state, null, 2),
      'utf8'
    );
    return { committed: true, productionWrites: 0 };
  }

  rollback() {
    if (!this.snapshot || !this.beforeState) throw new Error('transaction-not-prepared');
    this.state = clone(this.beforeState);
    this.committed = false;
    fs.writeFileSync(
      path.join(this.stagingDir, 'r9-shadow-rolled-back.json'),
      JSON.stringify(this.state, null, 2),
      'utf8'
    );
    return {
      rolledBack: true,
      restored: JSON.stringify(this.state) === JSON.stringify(this.beforeState),
      productionWrites: 0
    };
  }

  cleanup() {
    fs.rmSync(this.stagingDir, { recursive: true, force: true });
  }
}

module.exports = {
  CredentialShadowMigration,
  EXPLICIT_COMMIT_TOKEN
};
