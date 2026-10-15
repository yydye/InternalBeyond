'use strict';

/* ====================================================================
   IB Home Node · P21-R4-M Memory-Driven Behavior Modulation
   --------------------------------------------------------------------
   Consumes only validated R4-K current meaning + R4-L narrative and their
   Association provenance. Produces an ordinal, temporary turn posture and
   one response-guidance-v1 entry. Never stores canonical or authority state.
   ==================================================================== */
const crypto = require('crypto');
const DEFAULT_CORE = require('../../assets/js/memory-recall/behavior-modulation-core.js');
const RESPONSE_GUIDANCE = require('../../assets/js/response-guidance-core.js');

const MAX_TIMEOUT_MS = 800;
const MAX_CACHE_ENTRIES = 128;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SOURCE_KIND = 'memory_behavior_modulation';

function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return value == null ? '' : String(value); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function extractText(result) {
  if (typeof result === 'string') return result;
  if (!isPlainObject(result)) return null;
  if (typeof result.text === 'string') return result.text;
  if (typeof result.content === 'string') return result.content;
  const choices = Array.isArray(result.choices) ? result.choices : [];
  const message = choices[0] && choices[0].message;
  return message && typeof message.content === 'string' ? message.content : null;
}

function createRuntimeBehaviorModulation(deps) {
  const d = deps || {};
  const core = d.core || DEFAULT_CORE;
  const modelPort = d.modelPort || null;
  const registry = d.registry || null;
  const credentialAccess = d.credentialAccess || null;
  const attributionAuthority = d.attributionAuthority || null;
  const clock = typeof d.clock === 'function' ? d.clock : Date.now;
  const logger = typeof d.logger === 'function' ? d.logger : function () {};
  const maxTimeoutMs = Number.isFinite(Number(d.timeoutMs)) && Number(d.timeoutMs) >= 50
    ? Math.min(Math.floor(Number(d.timeoutMs)), MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
  const cache = new Map();
  const inFlight = new Map();
  const counters = { cycles: 0, modelCalls: 0, cacheHits: 0, invalidEvidence: 0, invalidOutput: 0,
    providerFailures: 0, timeouts: 0, baselineFallbacks: 0, guidanceBuilt: 0 };

  function nowMs() {
    const value = Number(clock());
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
  function note(event, fields) { try { logger(event, fields || {}); } catch (_) { /* telemetry is non-authoritative */ } }
  function sweep(now) {
    for (const [key, record] of cache) {
      if (!record || now - record.at > CACHE_TTL_MS) cache.delete(key);
    }
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  function remember(key, value) {
    cache.delete(key);
    cache.set(key, { at: nowMs(), value: value });
    sweep(nowMs());
  }
  function baseline(reason, providerCalls, fingerprint) {
    counters.baselineFallbacks += 1;
    return {
      ok: true,
      status: 'baseline',
      reason: text(reason || 'baseline-posture').slice(0, 120),
      posture: Object.assign({}, core.BASELINE_POSTURE),
      postureIdentity: null,
      evidenceFingerprint: fingerprint || null,
      providerCalls: Number(providerCalls) || 0,
      responseGuidance: null,
      durable: false
    };
  }
  function resolveSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') return { ok: false, reason: 'registry-unavailable' };
    let spec = null;
    try { spec = registry.getCharacterSpec(characterId) || null; } catch (_) { spec = null; }
    if (!isPlainObject(spec)) return { ok: false, reason: 'runtime-spec-unavailable' };
    const provider = text(spec.provider).trim(), model = text(spec.model).trim();
    const endpoint = text(spec.endpoint).trim(), credentialRef = text(spec.credentialRef).trim();
    if (!provider || !model || !endpoint || !credentialRef) return { ok: false, reason: 'runtime-spec-incomplete' };
    return { ok: true, spec: { provider: provider, model: model, endpoint: endpoint, credentialRef: credentialRef } };
  }
  async function invokeOnce(spec, secret, prompt, timeoutMs) {
    if (!modelPort || typeof modelPort.run !== 'function') return { ok: false, reason: 'model-port-unavailable', called: false };
    if (timeoutMs < 50) return { ok: false, reason: 'posture-budget-exhausted', called: false };
    let controller = null;
    try { controller = typeof AbortController === 'function' ? new AbortController() : null; } catch (_) { controller = null; }
    let settled = false, timedOut = false, resolveBound = null;
    const bounded = new Promise((resolve) => { resolveBound = resolve; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (controller) { try { controller.abort(); } catch (_) { /* best effort */ } }
      if (!settled) { settled = true; resolveBound({ __behaviorModulationTimeout: true }); }
    }, timeoutMs);
    counters.modelCalls += 1;
    const call = Promise.resolve().then(() => modelPort.run({
      spec: { provider: spec.provider, model: spec.model, endpoint: spec.endpoint, apiKey: secret },
      prompt: { system: prompt.system, messages: [{ role: 'user', content: prompt.user }] },
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: 300,
      temperature: 0,
      jsonMode: true,
      timeoutMs: timeoutMs,
      signal: controller ? controller.signal : undefined
    }));
    let result;
    try { result = await Promise.race([call, bounded]); }
    catch (_) {
      clearTimeout(timer);
      try { Promise.resolve(call).catch(() => {}); } catch (_) { /* late rejection ignored */ }
      return { ok: false, reason: 'provider-error', called: true };
    }
    clearTimeout(timer);
    try { Promise.resolve(call).catch(() => {}); } catch (_) { /* late rejection ignored */ }
    if (timedOut || (result && result.__behaviorModulationTimeout)) return { ok: false, reason: 'timeout', called: true };
    const output = extractText(result);
    if (output == null || output.length > 3000) return { ok: false, reason: 'provider-output-invalid', called: true };
    return { ok: true, text: output, called: true };
  }
  async function calculatePosture(evidence, binding, fingerprint, timeoutMs) {
    if (!modelPort || typeof modelPort.run !== 'function') return baseline('model-port-unavailable', 0, fingerprint);
    const resolved = resolveSpec(binding.characterId);
    if (!resolved.ok) return baseline(resolved.reason, 0, fingerprint);
    if (!credentialAccess || typeof credentialAccess.resolve !== 'function') return baseline('credential-access-unavailable', 0, fingerprint);
    let credential = null;
    try { credential = credentialAccess.resolve(resolved.spec.credentialRef); } catch (_) { credential = null; }
    if (!credential || credential.ok !== true || typeof credential.secret !== 'string' || !credential.secret) {
      return baseline('credential-unavailable', 0, fingerprint);
    }
    const cap = Math.min(maxTimeoutMs, Number.isFinite(Number(timeoutMs))
      ? Math.max(0, Math.floor(Number(timeoutMs))) : maxTimeoutMs);
    const prompt = core.buildPrompt(evidence);
    const called = await invokeOnce(resolved.spec, credential.secret, prompt, cap);
    if (!called.ok) {
      if (called.reason === 'timeout') counters.timeouts += 1;
      else counters.providerFailures += 1;
      return baseline(called.reason, called.called ? 1 : 0, fingerprint);
    }
    let parsed = null;
    try { parsed = JSON.parse(called.text); } catch (_) { parsed = null; }
    const validated = core.validateResponse(parsed);
    if (!validated.ok) {
      counters.invalidOutput += 1;
      return baseline('invalid-posture-schema', 1, fingerprint);
    }
    if (core.isBaseline(validated.posture)) {
      return Object.assign(baseline('evidence-supports-baseline', 1, fingerprint), { posture: validated.posture });
    }
    return {
      ok: true, status: 'derived', reason: null, posture: validated.posture,
      postureIdentity: 'sha256-v1:' + fingerprint, evidenceFingerprint: fingerprint,
      providerCalls: 1, responseGuidance: null, durable: false
    };
  }
  function buildGuidance(result, binding, provenance, fingerprint) {
    if (!result || result.status !== 'derived' || core.isBaseline(result.posture)) return result;
    if (!attributionAuthority || typeof attributionAuthority.registerExternalInfluence !== 'function') {
      return baseline('attribution-owner-unavailable', result.providerCalls, fingerprint);
    }
    let registered = null;
    try {
      registered = attributionAuthority.registerExternalInfluence({
        characterId: binding.characterId,
        conversationId: binding.conversationId,
        turnId: binding.turnId,
        sourceKind: SOURCE_KIND
      });
    } catch (_) { registered = null; }
    const participationId = registered && registered.ok === true && registered.participation
      ? text(registered.participation.participationId) : '';
    if (!participationId) return baseline('attribution-registration-failed', result.providerCalls, fingerprint);
    const identity = {
      characterId: binding.characterId,
      conversationId: binding.conversationId,
      requestId: binding.requestId,
      turnId: binding.turnId
    };
    const entry = {
      entryId: 'bm-' + sha256(JSON.stringify([identity, fingerprint])).slice(0, 32),
      sourceKind: SOURCE_KIND,
      guidanceKind: 'memory-behavior-posture-v1',
      payload: { schemaVersion: core.SCHEMA_VERSION, posture: result.posture },
      provenance: {
        sourceTurn: binding.turnId,
        memoryRefs: provenance.memoryRefs,
        interpretationRefs: provenance.interpretationRefs,
        narrativeRefs: provenance.narrativeRefs
      },
      participationId: participationId
    };
    const built = RESPONSE_GUIDANCE.buildEnvelope(identity, [entry]);
    if (!built.ok) return baseline('response-guidance-build-failed', result.providerCalls, fingerprint);
    counters.guidanceBuilt += 1;
    return Object.assign({}, result, { responseGuidance: built.envelope });
  }
  async function derive(input, options) {
    counters.cycles += 1;
    const src = isPlainObject(input) ? input : {};
    const binding = {
      characterId: text(src.characterId).trim(),
      conversationId: text(src.conversationId).trim(),
      requestId: text(src.requestId).trim(),
      turnId: text(src.turnId).trim()
    };
    if (!binding.characterId || !binding.conversationId || !binding.requestId || !binding.turnId) {
      return baseline('turn-identity-invalid', 0, null);
    }
    let built = null;
    try { built = core.buildEvidence(src); }
    catch (_) {
      counters.invalidEvidence += 1;
      return baseline('evidence-validation-failed', 0, null);
    }
    if (!built.ok) {
      counters.invalidEvidence += 1;
      return baseline(built.reason, 0, null);
    }
    const fingerprint = sha256(JSON.stringify([
      core.SCHEMA_VERSION, built.evidence,
      built.provenance.interpretationIdentity, built.provenance.narrativeIdentity
    ]));
    const cached = cache.get(fingerprint);
    let result = null;
    if (cached && cached.value) {
      counters.cacheHits += 1;
      cache.delete(fingerprint); cache.set(fingerprint, cached);
      result = Object.assign({}, cached.value, { responseGuidance: null });
    } else if (inFlight.has(fingerprint)) {
      counters.cacheHits += 1;
      result = Object.assign({}, await inFlight.get(fingerprint), { responseGuidance: null });
    } else {
      const task = calculatePosture(built.evidence, binding, fingerprint,
        options && options.remainingBudgetMs);
      inFlight.set(fingerprint, task);
      try { result = await task; }
      catch (_) { result = baseline('posture-runtime-failed', 0, fingerprint); }
      finally { inFlight.delete(fingerprint); }
      remember(fingerprint, result);
    }
    let withGuidance = null;
    try { withGuidance = buildGuidance(result, binding, built.provenance, fingerprint); }
    catch (_) { withGuidance = baseline('response-guidance-build-failed', result.providerCalls, fingerprint); }
    if (withGuidance.status === 'baseline') note('memory-behavior-modulation-baseline', {
      characterId: binding.characterId, turnId: binding.turnId, reason: withGuidance.reason,
      providerCalls: withGuidance.providerCalls
    });
    else note('memory-behavior-modulation-derived', {
      characterId: binding.characterId, turnId: binding.turnId,
      providerCalls: withGuidance.providerCalls, postureIdentity: withGuidance.postureIdentity
    });
    return withGuidance;
  }
  function describe() {
    const ready = !!(modelPort && typeof modelPort.run === 'function'
      && registry && typeof registry.getCharacterSpec === 'function'
      && credentialAccess && typeof credentialAccess.resolve === 'function'
      && attributionAuthority && typeof attributionAuthority.registerExternalInfluence === 'function');
    return {
      status: ready ? 'CAPABILITY_LIVE' : 'CAPABILITY_PRESENT_DISABLED',
      runtime: ready ? 'LIVE' : 'NOT_LIVE',
      schemaVersion: core.SCHEMA_VERSION,
      dimensions: core.POSTURE_KEYS.slice(),
      values: Object.keys(core.VALUES).reduce((out, key) => { out[key] = core.VALUES[key].slice(); return out; }, {}),
      derived: true, temporary: true, turnScoped: true, bounded: true,
      authorityWrites: {
        canonicalMemory: 0, relationship: 0, persona: 0, emotionalState: 0,
        selfNarrative: 0, predictionError: 0, activeMessageSchedule: 0
      },
      maxModelCallsPerCognitionCycle: 1,
      maxTimeoutMs: maxTimeoutMs,
      replay: { scope: 'EVIDENCE_AND_CURRENT_CONTEXT_FINGERPRINT', storage: 'IN_PROCESS_ONLY', maxEntries: MAX_CACHE_ENTRIES, ttlMs: CACHE_TTL_MS },
      output: 'response-guidance-v1',
      renderer: 'assets/js/response-guidance-core.js#renderBehaviorPosture',
      counters: Object.assign({}, counters),
      cacheEntries: cache.size,
      inFlight: inFlight.size
    };
  }
  return Object.freeze({ derive: derive, describe: describe });
}

module.exports = createRuntimeBehaviorModulation;
module.exports.createRuntimeBehaviorModulation = createRuntimeBehaviorModulation;
module.exports.SOURCE_KIND = SOURCE_KIND;
module.exports.MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;
module.exports.MAX_CACHE_ENTRIES = MAX_CACHE_ENTRIES;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
