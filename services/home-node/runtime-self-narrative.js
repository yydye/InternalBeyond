/* ====================================================================
   IB Home Node · P21-R4-L Self Narrative Runtime
   --------------------------------------------------------------------
   One internal consumer of validated R3/R4-K derived evidence. It owns a
   bounded session-only narrative state, one provider call per changed evidence
   fingerprint, runtime-minted identity/version, and closed output validation.
   It has no route and no Memory / relationship / persona / behavior writer.
   ==================================================================== */
'use strict';

const crypto = require('crypto');
const path = require('path');
const DEFAULT_CORE = require(path.join(__dirname, '..', '..', 'assets', 'js', 'memory-recall', 'self-narrative-core.js'));

const SCHEMA_VERSION = DEFAULT_CORE.SCHEMA_VERSION;
const MAX_SESSION_STATES = 64;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_VERSIONS_PER_SESSION = 32;
const FAILURE_RETRY_SUPPRESSION_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 1200;
const MAX_CHARACTER_ID_CHARS = 180;
const MAX_CONVERSATION_ID_CHARS = 240;
const MAX_TURN_ID_CHARS = 200;
const MAX_REASON_CHARS = 160;
const AUTO_RETRY = 'NONE';

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function extractText(result) {
  if (typeof result === 'string') return result;
  if (isPlainObject(result)) {
    if (typeof result.text === 'string') return result.text;
    if (typeof result.content === 'string') return result.content;
  }
  return null;
}
function narrativeContent(narrative) {
  const out = {};
  for (const key of DEFAULT_CORE.NARRATIVE_SECTIONS) {
    out[key] = (Array.isArray(narrative && narrative[key]) ? narrative[key] : []).map((claim) => ({
      scope: String(claim.scope || ''),
      statement: String(claim.statement || '')
    }));
  }
  out.uncertainty = String(narrative && narrative.uncertainty || 'unresolved');
  return out;
}
function claimKey(claim) { return String(claim.scope || '') + '\u0000' + String(claim.statement || ''); }
function diffClaims(previous, current) {
  const oldSet = new Set((Array.isArray(previous) ? previous : []).map(claimKey));
  const newSet = new Set((Array.isArray(current) ? current : []).map(claimKey));
  return {
    added: (Array.isArray(current) ? current : []).filter((claim) => !oldSet.has(claimKey(claim)))
      .map((claim) => claim.statement),
    removed: (Array.isArray(previous) ? previous : []).filter((claim) => !newSet.has(claimKey(claim)))
      .map((claim) => claim.statement)
  };
}
  function addClaimProvenance(narrative, input) {
    const out = stableNarrativeCopy(narrative);
    for (const section of DEFAULT_CORE.NARRATIVE_SECTIONS) {
      out[section] = (Array.isArray(out[section]) ? out[section] : []).map((claim) => {
        const refs = new Set(claim.evidenceMemoryIds || []);
        const relationRefs = input.associationRelations.filter((edge) =>
          refs.has(edge.anchorMemoryId) && refs.has(edge.relatedMemoryId));
        const tensionRefs = input.tensionsUsed.filter((set) => {
          if (!refs.has(set.anchorMemoryId)) return false;
          return DEFAULT_CORE.RELATIONS.some((relation) =>
            Array.isArray(set[relation]) && set[relation].some((id) => refs.has(id)));
        });
        return Object.assign({}, claim, {
          interpretationRefs: input.interpretationRefs.slice(),
          associationRelationRefs: relationRefs,
          tensionRefs: tensionRefs
        });
      });
    }
    return out;
  }
  function baseNarrativeForPrompt(narrative) {
    const out = {};
    for (const key of DEFAULT_CORE.NARRATIVE_SECTIONS) {
      out[key] = (Array.isArray(narrative && narrative[key]) ? narrative[key] : []).map((claim) => ({
        scope: String(claim.scope || ''),
        statement: String(claim.statement || ''),
        evidenceMemoryIds: Array.isArray(claim.evidenceMemoryIds) ? claim.evidenceMemoryIds.slice(0, 1) : []
      }));
    }
    out.uncertainty = String(narrative && narrative.uncertainty || 'unresolved');
    return out;
  }
function stableNarrativeCopy(value) { return JSON.parse(JSON.stringify(value)); }

function createRuntimeSelfNarrative(deps) {
  const d = deps || {};
  const registry = d.registry || null;
  const credentialAccess = d.credentialAccess || null;
  const modelPort = d.modelPort || null;
  const clock = typeof d.clock === 'function' ? d.clock : () => Date.now();
  const logger = typeof d.logger === 'function' ? d.logger : () => {};
  const core = d.core || DEFAULT_CORE;
  const sessions = new Map();
  const inFlight = new Map();
  const counters = { refreshes: 0, calls: 0, created: 0, revised: 0, unchanged: 0, failed: 0, timedOut: 0, reused: 0, retrySuppressed: 0 };

  function note(event, fields) {
    try { logger(event, fields || {}); } catch (_) { /* diagnostics cannot affect a turn */ }
  }
  function sweep(now) {
    for (const [key, state] of sessions) {
      if (!state || now - Number(state.lastAccessAt || state.updatedAt || 0) > SESSION_TTL_MS) sessions.delete(key);
    }
  }
  function sessionKey(characterId, conversationId) {
    return String(characterId) + '\u0000' + String(conversationId);
  }
  function putSession(key, state) {
    sessions.delete(key);
    sessions.set(key, state);
    while (sessions.size > MAX_SESSION_STATES) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  }
  function resolveSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') return { ok: false, reason: 'registry-unavailable' };
    let spec = null;
    try { spec = registry.getCharacterSpec(characterId) || null; } catch (_) { spec = null; }
    if (!isPlainObject(spec)) return { ok: false, reason: 'spec-missing' };
    const provider = text(spec.provider).trim(), model = text(spec.model).trim();
    const endpoint = text(spec.endpoint).trim(), credentialRef = text(spec.credentialRef).trim();
    if (!provider || !model || !endpoint || !credentialRef) return { ok: false, reason: 'spec-incomplete' };
    return { ok: true, spec: { provider: provider, model: model, endpoint: endpoint, credentialRef: credentialRef } };
  }
  async function invokeOnce(spec, secret, built, timeoutMs) {
    if (!modelPort || typeof modelPort.run !== 'function') return { ok: false, reason: 'model-port-unavailable', called: false };
    if (timeoutMs < 50) return { ok: false, reason: 'narrative-budget-exhausted', called: false };
    let controller = null;
    try { controller = typeof AbortController === 'function' ? new AbortController() : null; } catch (_) { controller = null; }
    let settled = false, timedOut = false, resolveBound = null;
    const bounded = new Promise((resolve) => { resolveBound = resolve; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (controller) { try { controller.abort(); } catch (_) { /* best effort */ } }
      if (!settled) { settled = true; resolveBound({ __selfNarrativeTimeout: true }); }
    }, timeoutMs);
    counters.calls += 1;
    const call = Promise.resolve().then(() => modelPort.run({
      spec: { provider: spec.provider, model: spec.model, endpoint: spec.endpoint, apiKey: secret },
      prompt: { system: built.system, messages: [{ role: 'user', content: built.user }] },
      messages: [{ role: 'user', content: built.user }],
      maxTokens: 1400,
      temperature: 0,
      jsonMode: true,
      timeoutMs: timeoutMs,
      signal: controller ? controller.signal : undefined
    }));
    let result;
    try { result = await Promise.race([call, bounded]); }
    catch (_) {
      clearTimeout(timer);
      try { Promise.resolve(call).catch(() => {}); } catch (_) { /* late rejection is ignored */ }
      return { ok: false, reason: 'provider-error', called: true };
    }
    clearTimeout(timer);
    try { Promise.resolve(call).catch(() => {}); } catch (_) { /* late rejection is ignored */ }
    if (timedOut || (result && result.__selfNarrativeTimeout)) return { ok: false, reason: 'timeout', called: true };
    const output = extractText(result);
    if (output == null) return { ok: false, reason: 'provider-output-unavailable', called: true };
    if (output.length > core.BOUNDS.MAX_MODEL_OUTPUT_CHARS) return { ok: false, reason: 'provider-output-over-bound', called: true };
    return { ok: true, text: output, called: true };
  }
  function evidenceFingerprint(normalized) {
    return 'sha256-v1:' + hash({
      schemaVersion: SCHEMA_VERSION,
      directMemoryIds: normalized.directMemoryIds,
      associatedMemoryIds: normalized.associatedMemoryIds,
      activationReasonsByMemoryId: normalized.activationReasonsByMemoryId,
      interpretationRefs: normalized.interpretationRefs,
      associationRelations: normalized.associationRelations,
      tensionsUsed: normalized.tensionsUsed,
      currentMeaning: normalized.currentMeaning
    });
  }
  function narrativeIdentity(characterId, conversationId, evidenceFp, previousVersion) {
    const identityInput = {
      schemaVersion: SCHEMA_VERSION,
      subjectDomains: core.SCOPES,
      characterId: characterId,
      conversationId: conversationId,
      evidenceFingerprint: evidenceFp,
      previousNarrativeVersion: Number(previousVersion) || 0
    };
    return {
      schemaVersion: SCHEMA_VERSION,
      value: 'sha256-v1:' + hash(identityInput),
      evidenceFingerprint: evidenceFp,
      previousNarrativeVersion: Number(previousVersion) || 0
    };
  }
  function makeView(identity, version, narrative, input, previousVersion, now) {
    return {
      schemaVersion: SCHEMA_VERSION,
      authority: core.AUTHORITY,
      durability: core.DURABILITY,
      subjectDomains: core.SCOPES.slice(),
      narrativeId: identity.value,
      version: version,
      identity: identity,
      narrative: narrative,
      evidenceMemoryIds: input.memoryIds.slice(),
      interpretationRefs: input.interpretationRefs.slice(),
      relationsUsed: input.associationRelations.slice(),
      tensionsUsed: input.tensionsUsed.slice(),
      updatedAt: now,
      previousVersion: previousVersion || null
    };
  }
  function makeTrace(status, input, state, extra) {
    const current = state && state.current ? state.current : null;
    const priorVersionValue = state && state.previousVersion != null ? Number(state.previousVersion) : 0;
    const currentVersion = current ? Number(current.version) : null;
    const narrative = current ? current.narrative : null;
    const noRevision = ['no-change', 'revision-cap-reached', 'failed', 'timed-out', 'retry-suppressed', 'disabled', 'not-needed'].indexOf(String(status)) >= 0;
    const previousVersion = noRevision && current ? currentVersion : (priorVersionValue > 0 ? priorVersionValue : null);
    const prevNarrative = noRevision ? narrative
      : (state && state.previousNarrative ? state.previousNarrative.narrative : null);
    const changes = {};
    for (const section of ['themes', 'currentBeliefs', 'relationshipBeliefs']) {
      changes[section] = diffClaims(prevNarrative && prevNarrative[section], narrative && narrative[section]);
    }
    const priorUnresolved = prevNarrative && prevNarrative.unresolvedTensions || [];
    const currentUnresolved = narrative && narrative.unresolvedTensions || [];
    const priorTensionKeys = new Set(priorUnresolved.map(claimKey));
    const currentTensionKeys = new Set(currentUnresolved.map(claimKey));
    const resolvedByModel = narrative && Array.isArray(narrative.resolvedTensions) ? narrative.resolvedTensions : [];
    const trace = {
      schemaVersion: SCHEMA_VERSION,
      status: status,
      subjectDomains: core.SCOPES.slice(),
      evidenceMemoryIds: input ? input.memoryIds.slice() : [],
      interpretationRefs: input ? input.interpretationRefs.slice() : [],
      relationsUsed: input ? input.associationRelations.slice() : [],
      tensionsUsed: input ? input.tensionsUsed.slice() : [],
      previousNarrativeVersion: previousVersion,
      newNarrativeVersion: currentVersion,
      changedThemes: changes.themes,
      changedBeliefs: { self: changes.currentBeliefs, relationship: changes.relationshipBeliefs },
      turningPointsAdded: narrative && Array.isArray(narrative.turningPoints) ? diffClaims(prevNarrative && prevNarrative.turningPoints, narrative.turningPoints).added : [],
      tensionsResolved: resolvedByModel.map((claim) => claim.statement),
      tensionsPreserved: currentUnresolved.filter((claim) => priorTensionKeys.has(claimKey(claim))).map((claim) => claim.statement),
      uncertainty: narrative ? narrative.uncertainty : 'unresolved',
      identity: current ? current.identity : null,
      narrativeId: current ? current.narrativeId : null,
      narrative: narrative,
      durability: core.DURABILITY,
      providerCalls: 0,
      fallbackReason: null
    };
    return Object.assign(trace, extra || {});
  }
  function previousNarrativeInput(state) {
    if (!state || !state.current) return null;
    return {
      version: state.current.version,
      narrativeId: state.current.narrativeId,
      narrative: baseNarrativeForPrompt(state.current.narrative)
    };
  }

  async function runFromValidatedInterpretation(binding, options) {
    const b = isPlainObject(binding) ? binding : null;
    const opts = isPlainObject(options) ? options : {};
    const startedAt = Number(clock());
    if (!b) return { ok: false, status: 'failed', reason: 'binding-not-an-object', providerCalls: 0, narrative: null };
    const characterId = text(b.characterId).trim().slice(0, MAX_CHARACTER_ID_CHARS);
    const conversationId = text(b.conversationId).trim().slice(0, MAX_CONVERSATION_ID_CHARS);
    const turnId = text(b.turnId).trim().slice(0, MAX_TURN_ID_CHARS);
    if (!characterId || !conversationId || !turnId) {
      return { ok: false, status: 'not-needed', reason: 'narrative-session-identity-unavailable', providerCalls: 0, narrative: null };
    }
    if (b.policyAuthorized !== true) {
      return { ok: false, status: 'disabled', reason: 'existing-auto-interpretation-policy-off', providerCalls: 0, narrative: null };
    }
    const key = sessionKey(characterId, conversationId);
    const now = Number(clock());
    sweep(now);
    let prior = sessions.get(key) || null;
    if (prior) { prior.lastAccessAt = now; sessions.delete(key); sessions.set(key, prior); }
    let built = null, normalized = null, evidenceFp = '';
    try {
      built = core.buildRequest({
        directMemoryIds: b.directMemoryIds,
        associatedMemoryIds: b.associatedMemoryIds,
        activationReasonsByMemoryId: b.activationReasonsByMemoryId,
        interpretationRefs: b.interpretationRefs,
        associationRelations: b.associationRelations,
        tensionsUsed: b.tensionsUsed,
        currentMeaning: b.currentMeaning,
        previousNarrative: previousNarrativeInput(prior)
      });
      normalized = built.normalized;
      evidenceFp = evidenceFingerprint(normalized);
    } catch (error) {
      counters.failed += 1;
      const trace = makeTrace('failed', null, prior, { fallbackReason: text(error && error.message || error).slice(0, MAX_REASON_CHARS) });
      return { ok: false, status: 'failed', reason: trace.fallbackReason, providerCalls: 0,
        narrative: prior ? prior.current : null, trace: trace, durable: false };
    }
    if (prior && prior.evidenceFingerprint === evidenceFp) {
      counters.unchanged += 1;
      const trace = makeTrace('no-change', normalized, prior, { providerCalls: 0 });
      return { ok: true, status: 'no-change', reason: 'narrative-evidence-unchanged', providerCalls: 0,
        narrative: prior.current, trace: trace, durable: false };
    }
    if (prior && prior.lastAttemptEvidenceFingerprint === evidenceFp
      && ['failed', 'timed-out'].indexOf(String(prior.lastAttemptStatus || '')) >= 0
      && now >= Number(prior.lastAttemptAt || 0)
      && now - Number(prior.lastAttemptAt || 0) < FAILURE_RETRY_SUPPRESSION_MS) {
      counters.retrySuppressed += 1;
      const trace = makeTrace('retry-suppressed', normalized, prior, {
        fallbackReason: 'same-evidence-retry-suppressed', providerCalls: 0
      });
      return { ok: false, status: 'retry-suppressed', reason: 'same-evidence-retry-suppressed',
        providerCalls: 0, narrative: prior.current || null, trace: trace, durable: false };
    }
    if (prior && prior.revisions.length >= MAX_VERSIONS_PER_SESSION) {
      const trace = makeTrace('revision-cap-reached', normalized, prior, {
        fallbackReason: 'session-revision-cap-reached', providerCalls: 0
      });
      counters.reused += 1;
      return { ok: true, status: 'revision-cap-reached', reason: 'session-revision-cap-reached', providerCalls: 0,
        narrative: prior.current, trace: trace, durable: false };
    }
    const currentFlight = inFlight.get(key);
    if (currentFlight) {
      if (currentFlight.evidenceFingerprint === evidenceFp) return currentFlight.promise;
      const trace = makeTrace('refresh-in-flight', normalized, prior, {
        providerCalls: 0, fallbackReason: 'different-evidence-refresh-already-in-flight'
      });
      return { ok: false, status: 'refresh-in-flight', reason: 'different-evidence-refresh-already-in-flight',
        providerCalls: 0, narrative: prior ? prior.current : null, trace: trace, durable: false };
    }
    const task = executeRefresh({
      key: key, characterId: characterId, conversationId: conversationId, turnId: turnId,
      prior: prior, input: normalized, built: built, evidenceFingerprint: evidenceFp,
      remainingBudgetMs: opts.remainingBudgetMs
    });
    inFlight.set(key, { evidenceFingerprint: evidenceFp, promise: task });
    try { return await task; }
    finally { inFlight.delete(key); }
  }

  async function executeRefresh(ctx) {
    counters.refreshes += 1;
    const startedAt = Number(clock());
    const fail = (status, reason, calls, code, timeoutMs) => {
      if (status === 'timed-out') counters.timedOut += 1; else counters.failed += 1;
      const priorState = ctx.prior;
      if (ctx.providerAttemptMarked === true && priorState
        && priorState.lastAttemptEvidenceFingerprint === ctx.evidenceFingerprint) {
        priorState.lastAttemptStatus = status;
        priorState.lastAttemptReason = String(reason || '').slice(0, MAX_REASON_CHARS);
        priorState.lastAttemptAt = Number(clock());
        priorState.updatedAt = priorState.lastAttemptAt;
        priorState.lastAccessAt = priorState.lastAttemptAt;
        putSession(ctx.key, priorState);
      }
      const trace = makeTrace(status, ctx.input, priorState, {
        providerCalls: calls || 0,
        fallbackReason: reason,
        errorClass: code || null
      });
      note('runtime-self-narrative-failed', {
        characterId: ctx.characterId, turnId: ctx.turnId, status: status,
        reason: String(reason || '').slice(0, MAX_REASON_CHARS), providerCalls: calls || 0
      });
      return { ok: false, status: status, reason: reason, errorClass: code || null,
        providerCalls: calls || 0, narrative: priorState ? priorState.current : null,
        trace: trace, durable: false,
        ...(Number.isFinite(Number(timeoutMs)) ? { timeoutMs: Number(timeoutMs) } : {}) };
    };
    if (!modelPort || typeof modelPort.run !== 'function') return fail('failed', 'model-port-unavailable', 0, 'model-port-unavailable');
    const resolvedSpec = resolveSpec(ctx.characterId);
    if (!resolvedSpec.ok) return fail('failed', resolvedSpec.reason, 0, 'runtime-spec-unavailable');
    if (!credentialAccess || typeof credentialAccess.resolve !== 'function') return fail('failed', 'credential-access-unavailable', 0, 'credential-unavailable');
    let credential = null;
    try { credential = credentialAccess.resolve(resolvedSpec.spec.credentialRef); } catch (_) { credential = null; }
    if (!credential || credential.ok !== true || typeof credential.secret !== 'string' || !credential.secret) {
      return fail('failed', 'credential-unavailable', 0, 'credential-unavailable');
    }
    const remaining = Number(ctx.remainingBudgetMs);
    const timeoutMs = Math.min(MAX_TIMEOUT_MS,
      Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : MAX_TIMEOUT_MS);
    if (timeoutMs < 50) return fail('timed-out', 'narrative-budget-exhausted', 0, 'timeout');
    const attemptAt = Number(clock());
    const attemptState = ctx.prior || {
      characterId: ctx.characterId,
      conversationId: ctx.conversationId,
      current: null,
      revisions: [],
      evidenceFingerprint: null,
      previousNarrative: null,
      previousVersion: null,
      updatedAt: attemptAt,
      lastAccessAt: attemptAt
    };
    attemptState.lastAttemptEvidenceFingerprint = ctx.evidenceFingerprint;
    attemptState.lastAttemptStatus = 'in-flight';
    attemptState.lastAttemptReason = null;
    attemptState.lastAttemptAt = attemptAt;
    attemptState.updatedAt = attemptAt;
    attemptState.lastAccessAt = attemptAt;
    ctx.prior = attemptState;
    ctx.providerAttemptMarked = true;
    putSession(ctx.key, attemptState);
    const called = await invokeOnce(resolvedSpec.spec, credential.secret, ctx.built, timeoutMs);
    if (!called.ok) return fail(called.reason === 'timeout' ? 'timed-out' : 'failed', called.reason, called.called ? 1 : 0,
      called.reason === 'timeout' ? 'timeout' : called.reason, timeoutMs);
    let parsed = null;
    try { parsed = JSON.parse(called.text); } catch (_) { parsed = null; }
    if (!isPlainObject(parsed)) return fail('failed', 'invalid-json', 1, 'invalid-output', timeoutMs);
    const validated = core.validateResponse(parsed, { allowedMemoryIds: ctx.input.memoryIds });
    if (!validated.ok) return fail('failed', validated.reason || 'validator-rejected', 1, 'invalid-output', timeoutMs);
    const previous = ctx.prior && ctx.prior.current ? ctx.prior.current : null;
    const priorContent = previous ? hash(narrativeContent(previous.narrative)) : null;
    const nextContent = hash(narrativeContent(validated.narrative));
    const now = Number(clock());
    if (previous && priorContent === nextContent) {
      ctx.prior.evidenceFingerprint = ctx.evidenceFingerprint;
      ctx.prior.lastAttemptStatus = 'success';
      ctx.prior.lastAttemptReason = null;
      ctx.prior.lastAccessAt = now;
      ctx.prior.updatedAt = now;
      putSession(ctx.key, ctx.prior);
      counters.unchanged += 1;
      const trace = makeTrace('no-change', ctx.input, {
        current: previous, previousNarrative: previous, previousVersion: previous.version
      }, { providerCalls: 1, fallbackReason: null });
      note('runtime-self-narrative-no-change', { characterId: ctx.characterId, turnId: ctx.turnId, version: previous.version });
      return { ok: true, status: 'no-change', reason: 'narrative-content-unchanged', providerCalls: 1,
        narrative: previous, trace: trace, durable: false, timeoutMs: timeoutMs };
    }
    const previousVersion = previous ? Number(previous.version) : 0;
    const version = previousVersion + 1;
    const identityInput = {
      schemaVersion: SCHEMA_VERSION,
      subjectDomains: core.SCOPES,
      evidenceFingerprint: ctx.evidenceFingerprint,
      previousNarrativeVersion: previousVersion
    };
    const identity = {
      schemaVersion: SCHEMA_VERSION,
      value: 'sha256-v1:' + hash(identityInput),
      subjectDomains: core.SCOPES.slice(),
      evidenceFingerprint: ctx.evidenceFingerprint,
      previousNarrativeVersion: previousVersion
    };
    const narrativeId = 'sn-' + identity.value.slice('sha256-v1:'.length, 'sha256-v1:'.length + 32);
    const narrativeWithProvenance = addClaimProvenance(validated.narrative, ctx.input);
    const view = {
      schemaVersion: SCHEMA_VERSION,
      authority: core.AUTHORITY,
      durability: core.DURABILITY,
      subjectDomains: core.SCOPES.slice(),
      narrativeId: narrativeId,
      version: version,
      identity: identity,
      narrative: narrativeWithProvenance,
      evidenceFingerprint: ctx.evidenceFingerprint,
      evidenceMemoryIds: ctx.input.memoryIds.slice(),
      interpretationRefs: ctx.input.interpretationRefs.slice(),
      relationsUsed: ctx.input.associationRelations.slice(),
      tensionsUsed: ctx.input.tensionsUsed.slice(),
      updatedAt: now,
      previousVersion: previousVersion || null
    };
    const revisions = ctx.prior && Array.isArray(ctx.prior.revisions) ? ctx.prior.revisions.slice() : [];
    revisions.push(view);
    const state = {
      characterId: ctx.characterId,
      conversationId: ctx.conversationId,
      current: view,
      revisions: revisions,
      evidenceFingerprint: ctx.evidenceFingerprint,
      previousNarrative: previous,
      previousVersion: previousVersion || null,
      lastAttemptEvidenceFingerprint: ctx.evidenceFingerprint,
      lastAttemptStatus: 'success',
      lastAttemptReason: null,
      lastAttemptAt: attemptAt,
      updatedAt: now,
      lastAccessAt: now
    };
    putSession(ctx.key, state);
    if (!previous) counters.created += 1; else counters.revised += 1;
    const trace = makeTrace(previous ? 'revised' : 'created', ctx.input, state, {
      previousNarrativeVersion: previousVersion || null,
      newNarrativeVersion: version,
      providerCalls: 1,
      fallbackReason: null
    });
    note('runtime-self-narrative-ok', {
      characterId: ctx.characterId, turnId: ctx.turnId,
      status: previous ? 'revised' : 'created', version: version, providerCalls: 1,
      evidenceMemoryCount: ctx.input.memoryIds.length,
      durationMs: Math.max(0, now - startedAt)
    });
    return { ok: true, status: previous ? 'revised' : 'created', reason: null,
      providerCalls: 1, narrative: view, trace: trace, durable: false, timeoutMs: timeoutMs };
  }

  function describe() {
    const storedVersions = Array.from(sessions.values()).reduce((sum, state) =>
      sum + (Array.isArray(state && state.revisions) ? state.revisions.length : 0), 0);
    const ready = !!(registry && typeof registry.getCharacterSpec === 'function'
      && credentialAccess && typeof credentialAccess.resolve === 'function'
      && modelPort && typeof modelPort.run === 'function');
    return {
      status: ready ? 'CAPABILITY_LIVE' : 'CAPABILITY_PRESENT_DISABLED',
      internalOnly: true,
      routeExposed: false,
      callers: ['services/home-node/runtime-recall.js#runSelfNarrative'],
      costAuthority: 'VALIDATED_R4K_PER_CHARACTER_POLICY',
      providerReady: !!(modelPort && typeof modelPort.run === 'function'),
      authority: core.AUTHORITY,
      durability: core.DURABILITY,
      storage: 'IN_PROCESS_SESSION_STATE',
      sessionScope: 'character+conversation',
      maxSessionStates: MAX_SESSION_STATES,
      sessionTtlMs: SESSION_TTL_MS,
      maxVersionsPerSession: MAX_VERSIONS_PER_SESSION,
      maxModelCallsPerRefresh: 1,
      maxTimeoutMs: MAX_TIMEOUT_MS,
      failureRetrySuppressionMs: FAILURE_RETRY_SUPPRESSION_MS,
      maxMemories: core.BOUNDS.MAX_MEMORY_REFS,
      maxPromptChars: core.BOUNDS.MAX_PROMPT_CHARS,
      maxModelOutputChars: core.BOUNDS.MAX_MODEL_OUTPUT_CHARS,
      autoRetry: AUTO_RETRY,
      canonicalMemoryWrites: 0,
      relationshipWrites: 0,
      personaWrites: 0,
      emotionalStateWrites: 0,
      behaviorEffectWrites: 0,
      predictionErrorWrites: 0,
      sharedMemoryWrites: 0,
      counters: Object.assign({}, counters),
      inFlight: inFlight.size,
      sessionCount: sessions.size,
      storedNarrativeVersions: storedVersions
    };
  }

  return Object.freeze({
    runFromValidatedInterpretation: runFromValidatedInterpretation,
    describe: describe
  });
}

module.exports = createRuntimeSelfNarrative;
module.exports.createRuntimeSelfNarrative = createRuntimeSelfNarrative;
module.exports.MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;
module.exports.MAX_SESSION_STATES = MAX_SESSION_STATES;
module.exports.MAX_VERSIONS_PER_SESSION = MAX_VERSIONS_PER_SESSION;
