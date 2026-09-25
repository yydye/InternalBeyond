'use strict';

/*
 * Versioned approval contract for a future C3 composite apply. C3.5 only
 * implements verification; no production issuer or approval UI is exposed.
 * Production verification is bound to a RecoveryOnly host session and an
 * in-memory nonce set. A host restart changes the session key and invalidates
 * outstanding approvals.
 */
const crypto = require('crypto');

const SCHEMA = 'internalbeyond.p32-w5.r3-c3.explicit-composite-reconstruction-approval';
const TYPE = 'EXPLICIT_COMPOSITE_RECONSTRUCTION_APPROVAL';
const MAX_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(key => { if (value[key] !== undefined) out[key] = stableValue(value[key]); });
    return out;
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function hmac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(stableJson(payload), 'utf8').digest('hex');
}
function fail(code) { return Object.assign(new Error(code), { code: code }); }
function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left || '')) || !/^[a-f0-9]{64}$/i.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(String(left).toLowerCase(), 'hex'), Buffer.from(String(right).toLowerCase(), 'hex'));
}

function createCompositeReconstructionApprovalVerifier(options) {
  options = options || {};
  const secret = Buffer.isBuffer(options.secretKey) ? Buffer.from(options.secretKey) : Buffer.from(String(options.secretKey || ''), 'hex');
  const hostSessionId = String(options.hostSessionId || '');
  const consumedNonces = options.consumedNonces || new Set();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  if (secret.length < 32 || !hostSessionId || !consumedNonces || typeof consumedNonces.has !== 'function' ||
      typeof consumedNonces.add !== 'function') throw fail('C35_APPROVAL_VERIFIER_CONFIGURATION_INVALID');

  function verifyAndConsume(approval, expectedBindings) {
    if (!approval || typeof approval !== 'object' || Array.isArray(approval) ||
        approval.schema !== SCHEMA || Number(approval.version) !== 1 || approval.type !== TYPE ||
        approval.oneUse !== true || approval.hostSessionId !== hostSessionId ||
        !/^[a-f0-9]{32,128}$/i.test(String(approval.nonce || '')) ||
        !Number.isSafeInteger(Number(approval.issuedAtUnixMs)) || !Number.isSafeInteger(Number(approval.expiresAtUnixMs)) ||
        !expectedBindings || stableJson(approval.bindings) !== stableJson(expectedBindings)) throw fail('C35_APPROVAL_BINDING_INVALID');

    const current = Number(now());
    const issuedAt = Number(approval.issuedAtUnixMs);
    const expiresAt = Number(approval.expiresAtUnixMs);
    if (!Number.isFinite(current) || issuedAt > current + CLOCK_SKEW_MS || expiresAt <= current ||
        expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) throw fail('C35_APPROVAL_EXPIRED_OR_INVALID_TTL');

    const nonce = String(approval.nonce).toLowerCase();
    if (consumedNonces.has(nonce)) throw fail('C35_APPROVAL_REPLAY_REJECTED');
    const unsigned = Object.assign({}, approval);
    delete unsigned.signature;
    if (!timingSafeHexEqual(approval.signature, hmac(unsigned, secret))) throw fail('C35_APPROVAL_SIGNATURE_INVALID');
    /* Mark consumed only after the complete scope, lifetime, and signature pass. */
    consumedNonces.add(nonce);
    return Object.freeze({
      ok: true,
      consumed: true,
      nonce: nonce,
      expiresAtUnixMs: expiresAt,
      bindingSha256: crypto.createHash('sha256').update(stableJson(expectedBindings), 'utf8').digest('hex')
    });
  }

  return Object.freeze({ verifyAndConsume: verifyAndConsume });
}

const testOnly = Object.freeze({
  issueSyntheticApproval: function (bindings, options) {
    if (process.env.IB_P32_W5_C35_SYNTHETIC_TESTS !== '1') throw fail('C35_SYNTHETIC_ISSUER_DISABLED');
    options = options || {};
    const secret = Buffer.isBuffer(options.secretKey) ? Buffer.from(options.secretKey) : Buffer.from(String(options.secretKey || ''), 'hex');
    if (secret.length < 32) throw fail('C35_SYNTHETIC_KEY_INVALID');
    const issuedAt = Number(options.issuedAtUnixMs == null ? Date.now() : options.issuedAtUnixMs);
    const expiresAt = Number(options.expiresAtUnixMs == null ? issuedAt + 60 * 1000 : options.expiresAtUnixMs);
    const approval = {
      schema: SCHEMA,
      version: 1,
      type: TYPE,
      oneUse: true,
      bundleHash: String(bindings.bundleSha256 || ''),
      writeSetAHash: String(bindings.writeSetAHash || ''),
      writeSetBHash: String(bindings.writeSetBHash || ''),
      planId: String(bindings.plan && bindings.plan.planId || ''),
      targetSnapshotSha256: String(bindings.plan && bindings.plan.targetSnapshotSha256 || ''),
      hostSessionId: String(options.hostSessionId || 'synthetic-host-session'),
      nonce: String(options.nonce || crypto.randomBytes(16).toString('hex')),
      issuedAtUnixMs: issuedAt,
      expiresAtUnixMs: expiresAt,
      bindings: stableValue(bindings)
    };
    approval.signature = hmac(approval, secret);
    return approval;
  }
});

module.exports = Object.freeze({
  SCHEMA: SCHEMA,
  TYPE: TYPE,
  MAX_TTL_MS: MAX_TTL_MS,
  createCompositeReconstructionApprovalVerifier: createCompositeReconstructionApprovalVerifier,
  testOnly: testOnly
});
