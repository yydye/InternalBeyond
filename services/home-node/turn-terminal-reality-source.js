'use strict';
/* ====================================================================
   IB Home Node · Turn Terminal → RealityEvent Source Adapter（P5-B3-D4）
   --------------------------------------------------------------------
   TURN_TERMINAL_FACT_IS_UPSTREAM_TRUTH = YES
   TURN_TERMINAL_FACT != REALITY_EVENT
   REALITY_EVENT_EMISSION_FAILURE MUST_NOT REWRITE TURN_OUTCOME

   唯一映射定义（ONE_MAPPING_DEFINITION）：
     canonical TurnTerminalOutcome
       → DomainEvent input
       → runtimeRealityEvent.ingest(...)      ← 唯一的 RealityEvent authority

   ── Adapter **没有**的 authority ──────────────────────────────────────
     character resolver · conversation resolver · turnId mint ·
     prediction pairing · relation classification · settlement · calibration
   ==================================================================== */

const path = require('path');
const CHAT_CORE = require(path.join(__dirname, '..', '..', 'assets', 'js', 'chat-core.js'));

const SOURCE_ID = 'turn-terminal';
const SOURCE_INSTANCE = 'runtime.turn-execution';
const DOMAIN = 'runtime';
const TYPE = 'turn_terminal';

/* createTurnContext 的字段由 D3 冻结；这里只读，不重算。 */
const REQUIRED_KEYS = Object.freeze(['turnId', 'characterId', 'conversationId', 'outcome', 'occurredAt']);

function text(v) { return v == null ? '' : String(v); }

/** 最小 provenance 校验：只接受由 canonical terminal seam 铸造的终局见证。
 *  · 字段齐备（D3 TurnContext authority fields）
 *  · occurredAt 是有限正数（来自 seam 的 clock()）
 *  · **不得**携带 caller 自行声明的 authority / 语义字段 */
const FORBIDDEN_INPUT_KEYS = Object.freeze([
  'predictionId', 'relation', 'support', 'conflict', 'matched', 'missed',
  'calibrationCounted', 'admissibility', 'settlementState', 'source', 'sourceInstance'
]);

function looksLikeCanonicalTerminalOutcome(v) {
  if (!v || typeof v !== 'object') return false;
  if (Object.isFrozen(v) !== true) return false;
  for (const k of REQUIRED_KEYS) {
    if (v[k] == null || text(v[k]) === '') return false;
  }
  if (!(Number.isFinite(Number(v.occurredAt)) && Number(v.occurredAt) > 0)) return false;
  for (const k of FORBIDDEN_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(v, k)) return false;
  }
  return true;
}

/** ONE mapping：terminal outcome → DomainEvent input（纯函数，无 I/O）。 */
function toRealityEventInput(outcome) {
  const turnId = text(outcome.turnId);
  const outcomeCode = text(outcome.outcome);
  return {
    sourceId: SOURCE_ID,
    sourceEvent: {
      /* event identity = turnId + terminal fact type（不含 predictionId） */
      eventId: 'turn_terminal:' + CHAT_CORE.stableToken(turnId + '|terminal|' + outcomeCode),
      domain: DOMAIN,
      type: TYPE,
      entityId: turnId,                       /* entity identity = turn instance */
      timestamp: Number(outcome.occurredAt),  /* = TurnTerminalOutcome.occurredAt */
      characterId: text(outcome.characterId),
      conversationId: text(outcome.conversationId),
      /* bounded factual payload：机械 settlement 只需 outcomeCode */
      body: { outcomeCode: outcomeCode }
    }
  };
}

/**
 * createTurnTerminalRealitySource({ realityEvent, logger })
 *   emit(outcome) → { ok, status, reasonCode }
 * ★ 绝不抛回上游；绝不改写 turn outcome。
 */
function createTurnTerminalRealitySource(deps) {
  const d = deps || {};
  const realityEvent = d.realityEvent || null;
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const counters = {
    attempted: 0, minted: 0, duplicate: 0, failed: 0, rejectedNotCanonical: 0,
    modelCalls: 0, durableWrites: 0
  };

  function emit(outcome) {
    counters.attempted += 1;
    if (!realityEvent || typeof realityEvent.ingest !== 'function') {
      counters.failed += 1;
      return { ok: false, status: 'failed', reasonCode: 'reality-authority-unavailable' };
    }
    if (!looksLikeCanonicalTerminalOutcome(outcome)) {
      counters.rejectedNotCanonical += 1;
      return { ok: false, status: 'refused', reasonCode: 'not-canonical-terminal-outcome' };
    }
    let res = null;
    try {
      res = realityEvent.ingest(toRealityEventInput(outcome));
    } catch (error) {
      counters.failed += 1;
      if (logger) logger('turn-terminal-reality-failed', { turnId: text(outcome.turnId), error: String((error && error.message) || error).slice(0, 200) });
      return { ok: false, status: 'failed', reasonCode: 'reality-ingest-threw' };
    }
    if (res && res.ok === true && res.status === 'minted') { counters.minted += 1; return { ok: true, status: 'minted', realityEvent: res.realityEvent }; }
    if (res && res.ok === true && res.status === 'duplicate') { counters.duplicate += 1; return { ok: true, status: 'duplicate', realityEvent: res.realityEvent }; }
    counters.failed += 1;
    if (logger) logger('turn-terminal-reality-refused', { turnId: text(outcome.turnId), reason: res && res.reasonCode });
    return { ok: false, status: 'refused', reasonCode: (res && res.reasonCode) || 'reality-ingest-refused' };
  }

  function describe() {
    return {
      sourceId: SOURCE_ID, sourceInstance: SOURCE_INSTANCE, domain: DOMAIN, type: TYPE,
      sourceProvenance: 'CANONICAL_RUNTIME',
      mappingAuthority: 'ONE_MAPPING_DEFINITION',
      acceptsOnlyCanonicalTerminalOutcome: 'YES',
      characterResolver: 'NONE', conversationResolver: 'NONE', turnIdMint: 'NONE',
      predictionPairing: 'NONE', relationClassification: 'NONE', settlement: 'NONE', calibration: 'NONE',
      modelCalls: 0, durableWrites: 0, counters: Object.assign({}, counters)
    };
  }

  return { emit: emit, describe: describe, toRealityEventInput: toRealityEventInput, counters: counters };
}

module.exports = {
  createTurnTerminalRealitySource: createTurnTerminalRealitySource,
  toRealityEventInput: toRealityEventInput,
  looksLikeCanonicalTerminalOutcome: looksLikeCanonicalTerminalOutcome,
  SOURCE_ID: SOURCE_ID,
  SOURCE_INSTANCE: SOURCE_INSTANCE,
  DOMAIN: DOMAIN,
  TYPE: TYPE
};
