/* ============================================================================
   IB Home Node · Runtime Memory Association (P21-R3)
   ----------------------------------------------------------------------------
   Produces a bounded, session-derived relationship view after canonical recall.
   It receives records from the Recall wrapper, but has no Memory write methods.
   ============================================================================ */
'use strict';

const crypto = require('crypto');
const CORE = require('../../assets/js/memory-recall/memory-association-core.js');

const DEFAULT_TIMEOUT_MS = 1200;
const SAFETY_CAP_MS = 1800;
const DEFAULT_MAX_TOKENS = 520;
const AUTO_RETRY = 'NONE';
const MAX_MEMO_ENTRIES = 512;
const MEMO_TTL_MS = 15 * 60 * 1000;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value) { return value == null ? '' : String(value); }

function extractText(result) {
  if (typeof result === 'string') return result;
  if (!isPlainObject(result)) return null;
  if (typeof result.text === 'string') return result.text;
  if (typeof result.output === 'string') return result.output;
  if (typeof result.content === 'string') return result.content;
  const choices = Array.isArray(result.choices) ? result.choices : [];
  const message = choices[0] && choices[0].message;
  if (message && typeof message.content === 'string') return message.content;
  if (message && Array.isArray(message.content)) {
    return message.content.map((part) => part && typeof part.text === 'string' ? part.text : '').join('');
  }
  return null;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function pairMemoKey(pair, provider, model) {
  const identity = [
    CORE.SCHEMA_VERSION,
    String(provider || ''),
    String(model || ''),
    String(pair.anchorMemoryId || ''),
    String(pair.relatedMemoryId || ''),
    CORE.recordText(pair.anchor),
    CORE.recordText(pair.related),
    String(pair.anchor && pair.anchor.kind || ''),
    String(pair.related && pair.related.kind || ''),
    String(pair.anchor && (pair.anchor.source || pair.anchor.rawSource) || ''),
    String(pair.related && (pair.related.source || pair.related.rawSource) || ''),
    String(pair.anchor && (pair.anchor.created || pair.anchor.createdAt) || ''),
    String(pair.related && (pair.related.created || pair.related.createdAt) || ''),
    JSON.stringify(CORE.provenanceIds(pair.anchor)),
    JSON.stringify(CORE.provenanceIds(pair.related))
  ];
  return hash(JSON.stringify(identity));
}

function createRuntimeMemoryAssociation(deps) {
  const d = deps || {};
  const core = d.core || CORE;
  const modelPort = d.modelPort || null;
  const registry = d.registry || null;
  const credentialAccess = d.credentialAccess || null;
  const logger = typeof d.logger === 'function' ? d.logger : function () {};
  const clock = typeof d.clock === 'function' ? d.clock : Date.now;
  const enabled = d.enabled !== false;
  const timeoutMs = Number.isFinite(Number(d.timeoutMs)) && Number(d.timeoutMs) > 0
    ? Math.min(Number(d.timeoutMs), SAFETY_CAP_MS) : DEFAULT_TIMEOUT_MS;
  const maxTokens = Number.isFinite(Number(d.maxTokens)) && Number(d.maxTokens) > 0
    ? Math.min(Math.floor(Number(d.maxTokens)), 900) : DEFAULT_MAX_TOKENS;
  const memo = new Map();
  const counters = {
    calls: 0, memoHits: 0, memoStores: 0, memoEvictions: 0,
    failures: 0, invalidOutput: 0, timeouts: 0, transportErrors: 0,
    candidates: 0, classifiedPairs: 0, expanded: 0
  };

  function nowMs() {
    const value = Number(clock());
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  function note(event, fields) {
    try { logger(event, fields || {}); } catch (_) { /* telemetry cannot break Recall */ }
  }

  function sweepMemo(now) {
    for (const [key, entry] of memo) {
      if (!entry || now - entry.at > MEMO_TTL_MS) {
        memo.delete(key);
        counters.memoEvictions += 1;
      }
    }
  }

  function memoGet(key, now) {
    const entry = memo.get(key);
    if (!entry || now - entry.at > MEMO_TTL_MS) {
      if (entry) { memo.delete(key); counters.memoEvictions += 1; }
      return null;
    }
    memo.delete(key);
    memo.set(key, entry);
    counters.memoHits += 1;
    return entry.relation;
  }

  function memoSet(key, relation, now) {
    memo.delete(key);
    memo.set(key, { relation: relation, at: now });
    counters.memoStores += 1;
    while (memo.size > MAX_MEMO_ENTRIES) {
      const oldest = memo.keys().next();
      if (oldest.done) break;
      memo.delete(oldest.value);
      counters.memoEvictions += 1;
    }
  }

  function resolveProviderSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') {
      return { ok: false, reason: 'character-spec-unavailable' };
    }
    let spec = null;
    try { spec = registry.getCharacterSpec(String(characterId)) || null; } catch (_) { spec = null; }
    if (!isPlainObject(spec)) return { ok: false, reason: 'character-spec-unavailable' };
    const provider = text(spec.provider).trim();
    const model = text(spec.model).trim();
    const endpoint = text(spec.endpoint).trim();
    const credentialRef = text(spec.credentialRef).trim();
    if (!provider || !model || !endpoint || !credentialRef) {
      return { ok: false, reason: 'character-spec-incomplete' };
    }
    if (!credentialAccess || typeof credentialAccess.resolve !== 'function') {
      return { ok: false, reason: 'credential-access-unavailable' };
    }
    let resolved = null;
    try { resolved = credentialAccess.resolve(credentialRef); } catch (_) { resolved = null; }
    if (!resolved || resolved.ok !== true || typeof resolved.secret !== 'string' || !resolved.secret) {
      return { ok: false, reason: 'credential-unavailable' };
    }
    return {
      ok: true,
      provider: provider,
      model: model,
      spec: { provider: provider, model: model, endpoint: endpoint, apiKey: resolved.secret }
    };
  }

  async function invokeOnce(pairs, providerSpec, injectedTimeout, outerSignal) {
    if (!modelPort || typeof modelPort.run !== 'function') {
      return { ok: false, reason: 'model-port-unavailable', called: false };
    }
    if (outerSignal && outerSignal.aborted === true) {
      return { ok: false, reason: 'request-aborted', called: false };
    }
    const built = core.buildPrompt(pairs);
    const timeoutRaw = Number(injectedTimeout);
    const effectiveTimeout = Math.min(
      timeoutMs,
      SAFETY_CAP_MS,
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : timeoutMs
    );
    if (effectiveTimeout < 50) return { ok: false, reason: 'deadline-exhausted', called: false };

    let controller = null;
    try { controller = typeof AbortController === 'function' ? new AbortController() : null; } catch (_) { controller = null; }
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let resolveBound = null;
    const bounded = new Promise((resolve) => { resolveBound = resolve; });
    let onAbort = null;
    if (outerSignal && typeof outerSignal.addEventListener === 'function') {
      onAbort = function () {
        aborted = true;
        if (controller) { try { controller.abort(); } catch (_) { /* best effort */ } }
        if (!settled) { settled = true; resolveBound({ __associationAborted: true }); }
      };
      try { outerSignal.addEventListener('abort', onAbort, { once: true }); } catch (_) { onAbort = null; }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (controller) { try { controller.abort(); } catch (_) { /* best effort */ } }
      if (!settled) { settled = true; resolveBound({ __associationTimeout: true }); }
    }, effectiveTimeout);
    const call = Promise.resolve().then(() => modelPort.run({
      spec: providerSpec.spec,
      prompt: { system: built.system, messages: [{ role: 'user', content: built.user }] },
      messages: [{ role: 'user', content: built.user }],
      maxTokens: maxTokens,
      temperature: 0,
      jsonMode: true,
      signal: controller ? controller.signal : undefined
    }));
    let result = null;
    try {
      result = await Promise.race([call, bounded]);
    } catch (_) {
      counters.transportErrors += 1;
      return { ok: false, reason: 'provider-transport-error', called: true };
    } finally {
      clearTimeout(timer);
      if (onAbort && outerSignal) {
        try { outerSignal.removeEventListener('abort', onAbort); } catch (_) { /* ignored */ }
      }
      try { Promise.resolve(call).catch(() => {}); } catch (_) { /* avoid late unhandled rejection */ }
    }
    if (aborted || (result && result.__associationAborted)) {
      return { ok: false, reason: 'request-aborted', called: true };
    }
    if (timedOut || (result && result.__associationTimeout)) {
      counters.timeouts += 1;
      return { ok: false, reason: 'association-timeout', called: true };
    }
    const output = extractText(result);
    if (output == null) return { ok: false, reason: 'provider-output-unavailable', called: true };
    return { ok: true, output: output, called: true };
  }

  async function expand(input, options) {
    const src = isPlainObject(input) ? input : {};
    const opts = isPlainObject(options) ? options : {};
    const directIds = Array.isArray(src.anchorIds) ? src.anchorIds.map(String) : [];
    const directRecords = Array.isArray(src.records) ? src.records : [];
    const fallback = {
      ok: false,
      status: 'fallback-direct',
      reason: null,
      result: null,
      providerCalls: 0,
      memoHits: 0
    };
    if (!enabled) return Object.assign({}, fallback, { status: 'disabled', reason: 'association-disabled' });
    if (!directIds.length || !directRecords.length) {
      return Object.assign({}, fallback, { ok: true, status: 'no-candidates', reason: 'no-anchor-records' });
    }
    if (opts.signal && opts.signal.aborted === true) {
      return Object.assign({}, fallback, { reason: 'request-aborted' });
    }

    let discovery;
    let pairs;
    try {
      discovery = core.discoverCandidates({
        records: directRecords,
        anchorIds: directIds,
        apiId: src.characterId,
        isGroup: src.isGroup === true,
        groupMemEnabled: src.groupMemEnabled === true
      });
      pairs = core.buildClassificationPairs(discovery);
    } catch (_) {
      counters.failures += 1;
      return Object.assign({}, fallback, { reason: 'candidate-discovery-failed' });
    }
    counters.candidates += discovery.candidates.length;
    counters.classifiedPairs += pairs.length;
    if (!pairs.length) {
      const result = core.assembleResult({
        discovery: discovery, pairs: [], relations: new Map(), directIds: directIds,
        currentMessage: src.currentMessage, budgetChars: src.budgetChars
      });
      return { ok: true, status: result.status, reason: null, result: result, providerCalls: 0, memoHits: 0 };
    }

    const relationMap = new Map();
    const semanticPairs = [];
    for (const pair of pairs) {
      const mechanical = typeof core.classifyMechanicalPair === 'function'
        ? core.classifyMechanicalPair(pair) : null;
      if (mechanical) relationMap.set(CORE.pairKey(pair.anchorMemoryId, pair.relatedMemoryId), mechanical);
      else semanticPairs.push(pair);
    }
    if (!semanticPairs.length) {
      const result = core.assembleResult({
        discovery: discovery, pairs: pairs, relations: relationMap, directIds: directIds,
        currentMessage: src.currentMessage, budgetChars: src.budgetChars,
        maxExpansion: src.maxExpansion
      });
      counters.expanded += result.expandedCount;
      return { ok: true, status: result.status, reason: null, result: result, providerCalls: 0, memoHits: 0 };
    }

    const provider = resolveProviderSpec(src.characterId);
    if (!provider.ok) {
      counters.failures += 1;
      return Object.assign({}, fallback, { reason: provider.reason });
    }
    const now = nowMs();
    sweepMemo(now);
    const missing = [];
    const keyByPair = new Map();
    const beforeHits = counters.memoHits;
    for (const pair of semanticPairs) {
      const key = pairMemoKey(pair, provider.provider, provider.model);
      keyByPair.set(CORE.pairKey(pair.anchorMemoryId, pair.relatedMemoryId), key);
      const cached = memoGet(key, now);
      if (cached) relationMap.set(CORE.pairKey(pair.anchorMemoryId, pair.relatedMemoryId), cached);
      else missing.push(pair);
    }
    let providerCalls = 0;
    if (missing.length) {
      counters.calls += 1;
      const called = await invokeOnce(missing, provider, opts.timeoutMs, opts.signal || null);
      providerCalls = called.called ? 1 : 0;
      if (!called.ok) {
        counters.failures += 1;
        return Object.assign({}, fallback, {
          reason: called.reason,
          providerCalls: providerCalls,
          memoHits: counters.memoHits - beforeHits
        });
      }
      const validated = core.parseModelResponse(called.output, missing);
      if (!validated.ok) {
        counters.invalidOutput += 1;
        counters.failures += 1;
        note('memory-association-invalid-output', { reason: validated.reason, pairCount: missing.length });
        return Object.assign({}, fallback, {
          reason: 'invalid-model-output',
          providerCalls: providerCalls,
          memoHits: counters.memoHits - beforeHits
        });
      }
      for (const pair of missing) {
        const relationKey = CORE.pairKey(pair.anchorMemoryId, pair.relatedMemoryId);
        const relation = validated.relations.get(relationKey);
        if (!relation) {
          counters.invalidOutput += 1;
          counters.failures += 1;
          return Object.assign({}, fallback, {
            reason: 'model-relation-missing',
            providerCalls: providerCalls,
            memoHits: counters.memoHits - beforeHits
          });
        }
        relationMap.set(relationKey, relation);
        memoSet(keyByPair.get(relationKey), relation, nowMs());
      }
    }

    let result;
    try {
      result = core.assembleResult({
        discovery: discovery,
        pairs: pairs,
        relations: relationMap,
        directIds: directIds,
        currentMessage: src.currentMessage,
        budgetChars: src.budgetChars,
        maxExpansion: src.maxExpansion
      });
    } catch (_) {
      counters.failures += 1;
      return Object.assign({}, fallback, {
        reason: 'association-assembly-failed',
        providerCalls: providerCalls,
        memoHits: counters.memoHits - beforeHits
      });
    }
    counters.expanded += result.expandedCount;
    return {
      ok: true,
      status: result.status,
      reason: null,
      result: result,
      providerCalls: providerCalls,
      memoHits: counters.memoHits - beforeHits
    };
  }

  function describe() {
    return {
      status: enabled ? 'CAPABILITY_LIVE' : 'CAPABILITY_PRESENT_DISABLED',
      enabled: enabled,
      enabledByDefault: true,
      authority: 'DERIVED_RELATION_VIEW',
      storage: 'RUNTIME_SESSION_ONLY',
      canonicalMemoryWrites: 0,
      canonicalMemoryDeletes: 0,
      canonicalMemoryMerges: 0,
      relationshipWrites: 0,
      predictionErrorWrites: 0,
      selfNarrativeWrites: 0,
      relationSet: core.RELATIONS.slice(),
      maxAnchors: core.MAX_ANCHORS,
      maxCandidates: core.MAX_CANDIDATES,
      maxCandidatePairs: core.MAX_CANDIDATE_PAIRS,
      maxClassificationPairs: core.MAX_CLASSIFICATION_PAIRS,
      maxExpansion: core.MAX_EXPANSION,
      maxDepth: 1,
      maxProviderCallsPerRecall: 1,
      timeoutMs: timeoutMs,
      autoRetry: AUTO_RETRY,
      memo: { entries: memo.size, maxEntries: MAX_MEMO_ENTRIES, ttlMs: MEMO_TTL_MS },
      counters: Object.assign({}, counters)
    };
  }

  return { expand: expand, describe: describe, core: core };
}

module.exports = {
  createRuntimeMemoryAssociation: createRuntimeMemoryAssociation,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  SAFETY_CAP_MS: SAFETY_CAP_MS,
  AUTO_RETRY: AUTO_RETRY
};
