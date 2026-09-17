'use strict';

/*
 * Release Builder · pure planning layer.
 *
 * NO I/O, NO clock, NO network, NO repository require. Everything in this file
 * is a deterministic function of its arguments, so the whole plan can be
 * counterproofed without touching a disk.
 *
 * What lives here and why it must live in exactly one place:
 *   · the five stages and their legal transitions   (the state machine)
 *   · the top-level status vocabulary                (BLOCKED / READY / PUBLISHED)
 *   · the channel vocabulary                         (Stable is the ONLY channel
 *                                                     the manifest contract knows)
 *   · the only target-version business rules         (MAJOR.MINOR.PATCH, strictly
 *                                                     greater than the current one)
 *
 * What deliberately does NOT live here:
 *   · the installer asset name / tag / URL spelling → canonical adapter only
 *   · the manifest schema                            → canonical adapter only
 *   · the "four equations"                           → canonical adapter only
 *   · the secret vocabulary                          → release-audit.js only
 */

const STAGES = ['CHECK', 'BUILD', 'VERIFY', 'SEAL', 'PUBLISH'];

/* Ordered list a one-click run walks: PUBLISH is deliberately NOT in it. */
const ONE_CLICK_STAGES = ['CHECK', 'BUILD', 'VERIFY', 'SEAL'];

/* Stage status. `warn` is NOT success: it is "a human must read this". */
const STAGE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  OK: 'ok',
  WARN: 'warn',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
  DRY: 'dry'
};

/* The only three top-level states this tool is allowed to report. */
const STATUS = {
  BLOCKED: 'BLOCKED',
  READY: 'READY',
  PUBLISHED: 'PUBLISHED'
};

/* The manifest contract knows exactly one channel (runtime/update-manifest.js
   CHANNELS). The GUI must not offer a second one "for later". */
const CHANNELS = ['stable'];
const CHANNEL_LABELS = { stable: 'Stable' };

/* minimumVersion is what the canonical build has passed since 1.0.2
   (docs/RELEASE.md §1). It is NOT a format rule of the schema, so it is a
   declared policy constant of the canonical invocation — named once, here. */
const CANONICAL_MINIMUM_VERSION = '1.0.1';

/*
 * Ordered stage transitions. A stage may only run when its predecessor is in
 * one of `from`; anything else is a refusal, not a warning.
 *
 * `warn` is accepted on the road to the next stage by design: a warning means
 * "a human must read this" and a blocker means "this is wrong". A permanently
 * non-empty untracked-file list, or a release-notes file that has not been
 * written yet, must not be able to freeze the tool — but it also must not be
 * silently promoted to "clean": it stays visible as a warning, and the
 * top-level status of a run that only has warnings is still not a clean pass.
 * `blocked` and `pending` are never accepted.
 */
const TRANSITIONS = {
  CHECK: { from: [STAGE_STATUS.PENDING, STAGE_STATUS.OK, STAGE_STATUS.WARN, STAGE_STATUS.BLOCKED, STAGE_STATUS.SKIPPED, STAGE_STATUS.DRY] },
  BUILD: { from: [STAGE_STATUS.OK, STAGE_STATUS.WARN] },
  VERIFY: { from: [STAGE_STATUS.OK, STAGE_STATUS.WARN] },
  SEAL: { from: [STAGE_STATUS.OK, STAGE_STATUS.WARN] },
  PUBLISH: { from: [STAGE_STATUS.OK, STAGE_STATUS.WARN] }
};

function isVersionShape(v) {
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v.trim());
}

/*
 * Compare two MAJOR.MINOR.PATCH strings numerically.
 * Returns -1 | 0 | 1, or null when either side is not a version.
 *
 * The repository has exactly ONE semver comparison (runtime/product-version.js,
 * U-D4). This local copy exists only so the pure planning tests can run without
 * a checkout; `lib/check.js` and every run-time decision use the canonical one.
 * `tests/test_release_builder_plan.js` asserts the two agree on the full matrix
 * so this can never become a second opinion.
 */
function compareShape(a, b) {
  if (!isVersionShape(a) || !isVersionShape(b)) return null;
  const pa = a.trim().split('.').map(Number);
  const pb = b.trim().split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function bumpPatch(v) {
  if (!isVersionShape(v)) return null;
  const p = v.trim().split('.').map(Number);
  return p[0] + '.' + p[1] + '.' + (p[2] + 1);
}

/*
 * The version plan: the single place that decides whether a target version is
 * allowed to be built. Pure — it encodes policy, not facts.
 *
 * `published` (optional) is what an external read-only probe learned about the
 * version already being on the Release channel:
 *   null                                  → not probed
 *   { exists: false }                     → probed, nothing published
 *   { exists: true, sha256, tag, draft, prerelease }
 *
 * Returns { ok, blockers:[{code,field,expected,actual,why}], blockersRequiringAcknowledgement:[],
 *           warnings:[], target, current, changed }
 */
function versionPlan(opts) {
  const o = opts || {};
  const current = typeof o.current === 'string' ? o.current.trim() : '';
  const target = typeof o.target === 'string' ? o.target.trim() : '';
  const channel = o.channel || 'stable';
  const ack = o.acknowledge || {};
  const blockers = [];
  const needsAck = [];
  const warnings = [];
  const block = function (code, field, expected, actual, why) {
    blockers.push({ code: code, field: field, expected: expected, actual: actual, why: why });
  };

  if (!isVersionShape(current)) {
    block('current-version-invalid', 'VERSION', 'MAJOR.MINOR.PATCH', JSON.stringify(current),
      'the repository VERSION file did not parse as a product version');
  }
  if (!isVersionShape(target)) {
    block('target-version-invalid', 'targetVersion', 'MAJOR.MINOR.PATCH', JSON.stringify(target),
      'a target version must be exactly MAJOR.MINOR.PATCH (same shape the manifest schema and the tag rule accept)');
  }
  if (channel !== 'stable') {
    block('channel-unsupported', 'channel', CHANNELS.join(', '), JSON.stringify(channel),
      'the frozen manifest contract (runtime/update-manifest.js CHANNELS) knows the Stable channel only; ' +
      'offering a prerelease channel here would create a second release truth');
  }

  let order = null;
  if (isVersionShape(current) && isVersionShape(target)) {
    order = compareShape(target, current);
    if (order < 0) {
      block('target-not-greater', 'targetVersion', '> ' + current, target,
        'a release must move forward: the update channel compares versions numerically and a lower target ' +
        'would offer a downgrade to every client');
    }
  }

  /*
   * Same version == same installer file name. Rebuilding it would overwrite the
   * bytes, and the build script does not refuse that — it exits 0. The published
   * contract says a release's bytes are the bytes that were verified, and that a
   * rebuilt artifact must never replace them (docs/RELEASE.md §6). So this is a
   * refusal that only an explicit acknowledgement may lift.
   */
  if (order === 0) {
    if (ack.sameVersionRebuild === true) {
      warnings.push({
        code: 'same-version-rebuild-acknowledged', field: 'targetVersion',
        why: 'rebuilding ' + target + ' was explicitly acknowledged: the existing ' +
          'dist/' + ' artifact for this version will be overwritten and the previously verified bytes are lost'
      });
    } else {
      block('same-version-rebuild-unacknowledged', 'targetVersion', 'a strictly newer version', target,
        'target equals the current VERSION: the installer file name is the same, the build would ' +
        'silently overwrite already-verified bytes and still exit 0 (audit §10.1). ' +
        'Bump VERSION, or acknowledge the rebuild explicitly.');
    }
  }

  const published = o.published || null;
  if (published && published.exists === true) {
    const pubSha = String(published.sha256 || '').toLowerCase();
    warnings.push({
      code: 'published-release-exists', field: 'release',
      why: 'a release for ' + target + ' already exists' +
        (published.tag ? ' (tag ' + published.tag + ')' : '') +
        (published.draft === true ? ' and is a DRAFT' : '') +
        (published.prerelease === true ? ' and is marked PRERELEASE' : '') +
        '; publishing again would either fail or replace published assets'
    });
    if (published.draft === true || published.prerelease === true) {
      needsAck.push({
        code: 'published-release-not-live', field: 'release',
        why: 'the existing release is not proven live (draft/prerelease), so it cannot be on the Stable ' +
          'channel: the client-side rules refuse it (U2/U3)'
      });
    }
    if (pubSha && o.artifactSha256 && String(o.artifactSha256).toLowerCase() !== pubSha) {
      needsAck.push({
        code: 'published-sha-differs', field: 'release.sha256',
        why: 'the locally built artifact has a different sha256 from the published asset for the same ' +
          'version (' + String(o.artifactSha256).slice(0, 16) + '… vs ' + pubSha.slice(0, 16) + '…): ' +
          'this is exactly the "rebuilt bytes replacing verified bytes" hazard'
      });
    }
  }

  const changed = isVersionShape(current) && isVersionShape(target) && current !== target;
  return {
    ok: blockers.length === 0,
    current: current,
    target: target,
    channel: channel,
    channelLabel: CHANNEL_LABELS[channel] || channel,
    order: order,
    changed: changed,
    patchBumpFrom: bumpPatch(current),
    minimumVersion: CANONICAL_MINIMUM_VERSION,
    blockers: blockers,
    blockersRequiringAcknowledgement: needsAck,
    warnings: warnings
  };
}

/*
 * May `stage` run right now? Pure; takes the current map of stage → status.
 *
 * The gate is the PREDECESSOR's status, not this stage's: BUILD must not run
 * before CHECK is green, VERIFY must not run before BUILD is green, and so on.
 * CHECK has no predecessor.
 *
 * Returns { ok, why, requires }.
 */
const PREDECESSOR = { CHECK: null, BUILD: 'CHECK', VERIFY: 'BUILD', SEAL: 'VERIFY', PUBLISH: 'SEAL' };

function canRun(stage, statuses) {
  if (STAGES.indexOf(stage) < 0) return { ok: false, why: 'unknown stage: ' + stage, requires: null };
  const prev = PREDECESSOR[stage];
  if (!prev) return { ok: true, why: null, requires: null };
  const t = TRANSITIONS[stage];
  const cur = (statuses || {})[prev] || STAGE_STATUS.PENDING;
  if (t.from.indexOf(cur) < 0) {
    return {
      ok: false,
      requires: prev,
      why: stage + ' cannot run: ' + prev + ' is "' + cur + '" (allowed: ' + t.from.join(', ') + ')'
    };
  }
  return { ok: true, why: null, requires: prev };
}

/*
 * One-click = CHECK → BUILD → VERIFY → SEAL, then STOP.
 *
 * PUBLISH is never in this list. There is no code path in this tool that pushes,
 * tags, creates a release or uploads an asset without a separate, explicit,
 * confirmed PUBLISH action (audit §13, user requirement §6).
 */
function oneClickStages() { return ONE_CLICK_STAGES.slice(); }

/*
 * The top-level status. Pure.
 *   PUBLISHED  only when PUBLISH actually completed.
 *   READY      SEAL ok and every blocker resolved.
 *   BLOCKED    anything else — including "unknown" and including a dry run,
 *              which by construction leaves SEAL pending and can never be
 *              reported as ready or published.
 */
function topStatus(state) {
  const s = state || {};
  const stageOf = function (n) { return (s.stages && s.stages[n] && s.stages[n].status) || STAGE_STATUS.PENDING; };
  if (s.blockers && s.blockers.length) return STATUS.BLOCKED;
  if (stageOf('PUBLISH') === STAGE_STATUS.OK) return STATUS.PUBLISHED;
  /* A DRY SEAL is not a seal: a dry run leaves the work outstanding, so it can
     never be reported as ready. */
  if (stageOf('SEAL') === STAGE_STATUS.OK) return STATUS.READY;
  if (stageOf('SEAL') === STAGE_STATUS.WARN) return STATUS.READY;
  return STATUS.BLOCKED;
}

/*
 * Roll a stage's item results up into a stage status. Pure.
 * BLOCKED beats WARN beats OK; an empty item list can never be OK, because a
 * stage that checked nothing has proven nothing.
 */
function rollUp(items) {
  const list = items || [];
  if (!list.length) return { status: STAGE_STATUS.BLOCKED, why: 'stage produced no results' };
  if (list.some(function (i) { return i.status === STAGE_STATUS.BLOCKED; })) return { status: STAGE_STATUS.BLOCKED, why: null };
  if (list.some(function (i) { return i.status === STAGE_STATUS.WARN; })) return { status: STAGE_STATUS.WARN, why: null };
  return { status: STAGE_STATUS.OK, why: null };
}

module.exports = {
  STAGES,
  ONE_CLICK_STAGES,
  STAGE_STATUS,
  STATUS,
  CHANNELS,
  CHANNEL_LABELS,
  CANONICAL_MINIMUM_VERSION,
  TRANSITIONS,
  isVersionShape,
  compareShape,
  bumpPatch,
  versionPlan,
  canRun,
  oneClickStages,
  topStatus,
  rollUp
};
