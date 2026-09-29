'use strict';

/*
 * IB Home Node · Credential Access Layer (P34.3-B, ADR P34.3-A.1 Decision 1 = Option A)
 *
 * Thin, read-only, request-scoped seam that lets the Home Node resolve a role's
 * provider secret from the canonical encrypted Vault, reusing the existing
 * `active/credential-resolver.js` bridge (the same Node module the Tauri
 * `credential_resolve` bridge wraps).
 *
 * Invariants (ADR Decision 3 / 5):
 *   · least privilege  : only binding ids explicitly allowed by `isAllowed()` are resolved;
 *   · fail-closed      : any miss/error returns ok:false — never a plaintext fallback;
 *   · request-scoped   : the returned secret must be used for one provider request only;
 *                        nothing is cached, persisted or logged here.
 */

const createCredentialResolver = require('../../active/credential-resolver.js');

function createCredentialAccess(options) {
  options = options || {};
  const dataDir = String(options.dataDir || '').trim();
  const isAllowed = typeof options.isAllowed === 'function' ? options.isAllowed : function () { return false; };
  const resolver = createCredentialResolver({ dataDir: dataDir });

  /* Returns { ok:true, provider, secret } or { ok:false, reason }.
     `secret` is request-scoped: callers must not cache or persist it. */
  function resolve(bindingId) {
    const id = String(bindingId == null ? '' : bindingId).trim();
    if (!id) return { ok: false, reason: 'no-ref' };
    let allowed = false;
    try { allowed = !!isAllowed(id); } catch (_) { allowed = false; }
    if (!allowed) return { ok: false, reason: 'not-allowed' };
    let credential = null;
    try { credential = resolver.resolve(id); } catch (_) { credential = null; }
    if (!credential || typeof credential.apiKey !== 'string' || !credential.apiKey.trim()) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, provider: credential.provider, secret: credential.apiKey };
  }

  return Object.freeze({ resolve: resolve });
}

module.exports = createCredentialAccess;
