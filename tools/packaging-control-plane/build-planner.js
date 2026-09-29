'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const contract = require('./contract.js');
const environmentInspector = require('./environment-inspector.js');

function readCanonicalVersion(root) {
  let version;
  try { version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); }
  catch (_) { throw new contract.PackagingContractError('CANONICAL_VERSION_UNAVAILABLE', 'VERSION'); }
  if (!contract.VERSION_PATTERN.test(version)) {
    throw new contract.PackagingContractError('CANONICAL_VERSION_INVALID', 'VERSION');
  }
  return version;
}

function planDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 20);
}

function unsupportedPlan(job, reason) {
  return Object.freeze({
    schema: 'internalbeyond.build-plan',
    schemaVersion: 1,
    planId: 'plan-' + planDigest({ job: job, reason: reason }),
    target: job.target,
    mode: job.mode,
    channel: job.channel,
    version: job.version,
    sourceRevision: null,
    sourceDirty: null,
    status: 'UNSUPPORTED',
    releaseEligible: false,
    executes: false,
    publication: 'not-included',
    reason: reason,
    steps: []
  });
}

function validateInspection(inspection, target) {
  if (!inspection || typeof inspection.ready !== 'boolean' || !Array.isArray(inspection.checks)) {
    throw new contract.PackagingContractError('INVALID_INSPECTION_RESULT', 'inspection');
  }
  if (inspection.target && inspection.target !== target) {
    throw new contract.PackagingContractError('INSPECTION_TARGET_MISMATCH', 'inspection.target');
  }
  for (const item of inspection.checks) {
    if (!item || typeof item.name !== 'string' || !['PASS', 'WARN', 'FAIL'].includes(item.status)) {
      throw new contract.PackagingContractError('INVALID_INSPECTION_CHECK', 'inspection.checks');
    }
  }
}

function createBuildPlan(input, options) {
  const o = options || {};
  const job = contract.validatePackagingJob(input);
  if (job.targetState !== 'supported') {
    return unsupportedPlan(job, 'Target is reserved for a future phase and has no executable plan.');
  }
  if (job.mode === 'debug') {
    return unsupportedPlan(job, 'The current Windows Installer contract has no debug artifact path.');
  }

  const root = path.resolve(o.root || path.resolve(__dirname, '..', '..'));
  const canonicalVersion = readCanonicalVersion(root);
  const resolvedJob = contract.resolveJobVersion(input, canonicalVersion);
  const inspection = o.inspection || environmentInspector.inspectEnvironment({
    root: root,
    target: resolvedJob.target,
    mode: resolvedJob.mode,
    adapters: o.adapters,
    minimumFreeBytes: o.minimumFreeBytes
  });
  validateInspection(inspection, resolvedJob.target);

  const repository = inspection.repository || {};
  const revision = typeof repository.revision === 'string' ? repository.revision : 'unknown';
  const dirty = repository.dirty === true;
  const warnings = inspection.checks.filter((item) => item.status === 'WARN').length;
  const requiredFailure = inspection.checks.some((item) => item.status === 'FAIL' && item.required !== false);
  const ready = inspection.ready && !requiredFailure;
  const testMode = resolvedJob.mode === 'test';
  const scriptArguments = testMode ? ['-TestMode'] : [];
  const outputRoot = testMode ? 'tmp/installer-smoke-build' : 'dist';
  const status = !ready ? 'BLOCKED' : (warnings > 0 ? 'READY_WITH_WARNINGS' : 'READY');
  const releaseEligible = ready && !testMode && !dirty;
  const planned = ready ? 'PLANNED' : 'BLOCKED';
  const identity = {
    job: {
      id: resolvedJob.id,
      target: resolvedJob.target,
      version: resolvedJob.version,
      channel: resolvedJob.channel,
      mode: resolvedJob.mode,
      options: resolvedJob.options
    },
    revision: revision,
    dirty: dirty,
    checks: inspection.checks.map((item) => ({ name: item.name, status: item.status }))
  };

  return Object.freeze({
    schema: 'internalbeyond.build-plan',
    schemaVersion: 1,
    planId: 'plan-' + planDigest(identity),
    jobId: resolvedJob.id,
    target: resolvedJob.target,
    mode: resolvedJob.mode,
    channel: resolvedJob.channel,
    version: resolvedJob.version,
    sourceRevision: revision,
    sourceDirty: dirty,
    status: status,
    releaseEligible: releaseEligible,
    executes: false,
    publication: 'not-included',
    artifact: {
      outputRoot: outputRoot,
      manifestSchema: 'internalbeyond.artifact-manifest@1',
      validated: false
    },
    steps: Object.freeze([
      Object.freeze({
        id: 'environment-check',
        type: 'inspection',
        authority: 'Packaging Control Plane Environment Inspector',
        status: ready ? 'PASS' : 'FAIL'
      }),
      Object.freeze({
        id: 'prepare-staging',
        type: 'delegated-substep',
        owner: 'scripts/build-installer.ps1',
        authority: 'scripts/release-manifest.js',
        status: planned,
        note: 'The control plane does not stage files; this step is performed only inside the canonical build script.'
      }),
      Object.freeze({
        id: 'stage-tauri-host',
        type: 'delegated-substep',
        owner: 'scripts/build-installer.ps1',
        authority: 'scripts/stage-tauri-host.ps1',
        status: planned
      }),
      Object.freeze({
        id: 'audit-staged-payload',
        type: 'delegated-substep',
        owner: 'scripts/build-installer.ps1',
        authority: 'scripts/release-audit.js',
        status: planned
      }),
      Object.freeze({
        id: 'compile-inno-installer',
        type: 'delegated-substep',
        owner: 'scripts/build-installer.ps1',
        authority: 'installer/InternalBeyond.iss via Inno Setup ISCC',
        status: planned
      }),
      Object.freeze({
        id: 'build-installer',
        type: 'delegate',
        command: Object.freeze({
          executable: 'powershell.exe',
          arguments: Object.freeze(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-installer.ps1'].concat(scriptArguments))
        }),
        authority: 'Existing Inno pipeline',
        status: planned,
        outputRoot: outputRoot
      }),
      Object.freeze({
        id: 'validate-artifact',
        type: 'verification',
        authority: Object.freeze([
          'scripts/build-installer.ps1 compiled identity/hash/version gates',
          'runtime/update-manifest.js canonical validation',
          'tests/test_installer.js static contract'
        ]),
        status: planned,
        note: testMode
          ? 'Test-only identity; no Stable manifest, install audit or publish step is planned.'
          : 'Build validation is planned; the Packaging Control Plane does not execute tests or install the artifact.'
      })
    ])
  });
}

module.exports = {
  createBuildPlan: createBuildPlan
};
