'use strict';
/* ====================================================================
   IB Home Node · Explicit User Preference Report Authority（Prediction Error P5-B3-E-R1）
   --------------------------------------------------------------------
   EXPLICITNESS_AUTHORITY = DEDICATED_STRUCTURED_USER_REPORT_ACTION
   RAW_CHAT_TEXT_IS_EXPLICIT_REPORT = NO
   MODEL_MAY_DECLARE_EXPLICITNESS = NO · MATCHER_MAY_DECLARE_EXPLICITNESS = NO

   本模块是**唯一**能铸造 canonical ExplicitUserPreferenceReport 的地方。
   它只做一件事：

     already-validated structured action（stance + canonical target + scope）
       → sealed / deepFrozen canonical report

   ── 它**没有**的职责（禁止越界）──────────────────────────────────────
     Prediction lookup · relation classification · OutcomeObservation ·
     Settlement · Calibration · Memory · Relationship · HTTP · auth。
   它不知道 prediction 的存在，也不判断自己的报告"会不会命中"什么。

   ── provenance：schema-valid != authoritative ────────────────────────
   普通对象 / JSON 克隆 / Object.assign 克隆 / 复制 brand / 另一个 loaded
   实例**全部**不是 report。唯一判据是 module 级 WeakSet 身份 + WeakMap 封存
   指纹（与 RealityEvent / Settlement / EvidenceMatch 同一纪律）。

   ── 身份三层分离（§6/§7）────────────────────────────────────────────
     REQUEST_IDENTITY        = HTTP requestId              （transport；幂等/重试）
     CANONICAL_ACTION_IDENTITY = pref_action_<stableToken(requestId)>（transport 派生）
     REPORT_FACT_IDENTITY    = pref_report_<stableToken(actionId|scope|targetKey|stance)>
   ★ report identity **不含** predictionId，也**不**等于 requestId。
   ★ replay 同一 requestId ⇒ 同一 reportId ⇒ 一个逻辑 report（有界去重）。
   ★ 同一 proposition 换一次 action ⇒ **新的** fact（T1 LIKE / T3 LIKE 不塌缩）。

   ── 时间 ─────────────────────────────────────────────────────────────
   REPORT_OCCURRED_AT = SERVER_ACCEPTED_REPORT_TIME（clock()，**不**读客户端）。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const CHAT_CORE = require(path.join(ASSETS_JS, 'chat-core.js'));
const PREF = require(path.join(ASSETS_JS, 'memory-recall', 'preference-proposition-core.js'));

const SCHEMA_VERSION = 'explicit-user-preference-report/v1';
const ID_PREFIX = 'pref_report_';
const ACTION_PREFIX = 'pref_action_';
const ID_LIFETIME = 'SESSION_ONLY';
const ENTRY = 'mintPreferenceReport';
const REPORT_SOURCE = 'EXPLICIT_USER_REPORT';
const REPORT_BRAND = 'ib.explicit-user-preference-report.v1';

const BOUNDS = Object.freeze({
  MAX_HELD_REPORTS: 256,
  MAX_ID_CHARS: 200
});

const REASON = Object.freeze({
  ok: 'ok',
  malformedAction: 'structured-action-malformed',
  missingActionId: 'structured-action-identity-missing',
  missingScope: 'structured-action-scope-missing',
  targetKeyNotCanonical: 'preference-target-key-not-canonical',
  stanceNotInClosedSet: 'preference-stance-not-in-closed-set',
  badOccurredAt: 'server-accepted-time-missing',
  reportIdUnderivable: 'report-identity-underivable',
  duplicateSuppressed: 'duplicate-structured-report-suppressed'
});

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }

/* ── capability seal（module-private · **module 级**）────────────────── */
const REPORT_IDENTITY = new WeakSet();
const REPORT_SEAL = new WeakMap();

function fingerprintOf(v) { try { return JSON.stringify(v); } catch (e) { return null; } }
function sealReport(report) {
  REPORT_IDENTITY.add(report);
  REPORT_SEAL.set(report, Object.freeze({ brand: REPORT_BRAND, fingerprint: fingerprintOf(report) }));
  return report;
}
/** 只有本模块铸造、仍然冻结、且未被篡改的报告才是 canonical report。 */
function isExplicitPreferenceReport(x) {
  if (!x || typeof x !== 'object') return false;
  if (!REPORT_IDENTITY.has(x)) return false;
  if (!Object.isFrozen(x)) return false;
  const s = REPORT_SEAL.get(x);
  if (!s || s.brand !== REPORT_BRAND) return false;
  if (typeof x.reportId !== 'string' || x.reportId.indexOf(ID_PREFIX) !== 0) return false;
  if (text(x.source) !== REPORT_SOURCE) return false;
  if (!text(x.characterId) || !text(x.conversationId)) return false;
  if (PREF.isStance(x.stance) !== true) return false;
  if (PREF.isCanonicalPreferenceToken(x.preferenceToken) !== true) return false;
  if (!(Number.isFinite(Number(x.occurredAt)) && Number(x.occurredAt) > 0)) return false;
  if (Object.prototype.hasOwnProperty.call(x, 'predictionId')) return false;
  return fingerprintOf(x) === s.fingerprint;
}

function createRuntimeExplicitPreferenceReport(deps) {
  const d = deps || {};
  const clock = typeof d.clock === 'function' ? d.clock : (() => Date.now());
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const maxHeld = Number.isFinite(Number(d.maxHeldReports)) && Number(d.maxHeldReports) > 0
    ? Number(d.maxHeldReports) : BOUNDS.MAX_HELD_REPORTS;

  const held = new Map();
  const heldOrder = [];
  const counters = {
    attempts: 0, minted: 0, duplicatesSuppressed: 0,
    rejectedMalformed: 0, rejectedActionId: 0, rejectedScope: 0,
    rejectedTargetKey: 0, rejectedStance: 0, rejectedTime: 0, evicted: 0,
    modelCalls: 0, durableWrites: 0,
    predictionLookups: 0, settlementCalls: 0, memoryWrites: 0, relationshipWrites: 0
  };

  function evict() {
    while (held.size > maxHeld && heldOrder.length) {
      const k = heldOrder.shift();
      if (held.has(k)) { held.delete(k); counters.evicted += 1; }
    }
  }
  function refuse(reasonCode, extra) {
    return Object.assign({ ok: false, status: 'refused', reasonCode: reasonCode, report: null }, extra || {});
  }

  /**
   * submit({ actionId, characterId, conversationId, targetKey, stance })
   *   · actionId        —— transport 派生的 canonical action 身份（非原始 requestId）
   *   · characterId     —— **已由 ingress 经 server registry 绑定**（这里只判存在）
   *   · conversationId  —— **已由 ingress 从 canonical character 派生**
   *   · targetKey       —— 客户端原文；规范化（小写 + 受限字符集）在这里发生
   *   · stance          —— 闭集 like | dislike（transport 归一后的 canonical 词）
   * ★ 绝不抛回上游；绝不做 prediction lookup。
   */
  function submit(action) {
    counters.attempts += 1;
    const a = isPlainObject(action) ? action : null;
    if (!a) { counters.rejectedMalformed += 1; return refuse(REASON.malformedAction); }

    const actionId = text(a.actionId).trim();
    if (!actionId || actionId.length > BOUNDS.MAX_ID_CHARS || actionId.indexOf(ACTION_PREFIX) !== 0) {
      counters.rejectedActionId += 1;
      return refuse(REASON.missingActionId);
    }
    const characterId = text(a.characterId).trim();
    const conversationId = text(a.conversationId).trim();
    if (!characterId || !conversationId) { counters.rejectedScope += 1; return refuse(REASON.missingScope); }

    const targetKey = PREF.canonicalTargetKey(a.targetKey);
    if (targetKey == null) { counters.rejectedTargetKey += 1; return refuse(REASON.targetKeyNotCanonical); }
    const stance = text(a.stance);
    if (PREF.isStance(stance) !== true) {
      counters.rejectedStance += 1;
      return refuse(REASON.stanceNotInClosedSet, { acceptedStances: PREF.STANCES.slice() });
    }
    const preferenceToken = PREF.buildPreferenceToken(stance, targetKey);
    if (preferenceToken == null) { counters.rejectedTargetKey += 1; return refuse(REASON.targetKeyNotCanonical); }

    const occurredAt = Number(clock());
    if (!Number.isFinite(occurredAt) || occurredAt <= 0) { counters.rejectedTime += 1; return refuse(REASON.badOccurredAt); }

    /* REPORT_FACT_IDENTITY：request/action 身份 + canonical proposition。
       ★ 不含 predictionId；★ 不等于 requestId（它是它的稳定摘要之一部分）。 */
    const seed = [actionId, characterId, conversationId, targetKey, stance].join('|');
    const digest = (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function')
      ? CHAT_CORE.stableToken(seed) : null;
    if (!digest) { counters.rejectedActionId += 1; return refuse(REASON.reportIdUnderivable); }
    const reportId = ID_PREFIX + digest;

    if (held.has(reportId)) {
      counters.duplicatesSuppressed += 1;
      return {
        ok: true, status: 'duplicate', reasonCode: REASON.duplicateSuppressed,
        report: held.get(reportId), reportId: reportId, reused: true
      };
    }

    const report = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      reportId: reportId,
      source: REPORT_SOURCE,
      /* ── scope（全部由 ingress 从 canonical runtime 派生/绑定，非 caller 自报）── */
      characterId: characterId,
      conversationId: conversationId,
      /* ── canonical proposition ── */
      targetKey: targetKey,
      stance: stance,
      /* 由 (stance, targetKey) **派生**的唯一表示（derivable, not authority） */
      preferenceToken: preferenceToken,
      /* ── 身份与时间 ── */
      sourceActionId: actionId,
      occurredAt: Math.trunc(occurredAt),
      /* 审计指向：schema-valid != authoritative，这个标记只说明 seal 来源 */
      sealedBy: 'EXPLICIT_USER_PREFERENCE_REPORT_AUTHORITY',
      idLifetime: ID_LIFETIME
    });
    sealReport(report);
    held.set(reportId, report);
    heldOrder.push(reportId);
    counters.minted += 1;
    evict();
    /* ★ 到这一行为止，canonical report 已经成立（upstream truth）。
       下游（RealityEvent / feedback）由 ingress 在**看到 minted 之后**调用，
       并且它失败**不会**回滚、改写或删除这条 report。 */
    if (logger) {
      try {
        logger('explicit-preference-report-minted', {
          reportId: reportId, stance: stance,
          /* ★ 审计只记 canonical key 与闭合枚举；**绝不**记原始用户文本。 */
          targetKey: targetKey, characterId: characterId, conversationId: conversationId
        });
      } catch (_) { /* diagnostics 不得影响 mint */ }
    }
    return { ok: true, status: 'minted', reasonCode: REASON.ok, report: report, reportId: reportId, reused: false };
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      schemaVersion: SCHEMA_VERSION,
      explicitnessAuthority: 'DEDICATED_STRUCTURED_USER_REPORT_ACTION',
      rawChatTextIsExplicitReport: 'NO',
      modelMayDeclareExplicitness: 'NO',
      matcherMayDeclareExplicitness: 'NO',
      reportSource: REPORT_SOURCE,
      reportIdentityContainsPredictionId: 'NO',
      reportIdentityEqualsRequestId: 'NO',
      reportOccurredAt: 'SERVER_ACCEPTED_REPORT_TIME',
      capabilityMintAuthority: 'EXPLICIT_USER_PREFERENCE_REPORT_AUTHORITY',
      oneCanonicalMintPath: 'YES',
      dynamicRegistration: 'FORBIDDEN',
      immutability: 'DEEP_FROZEN',
      stanceEnum: PREF.STANCES.slice(),
      targetKeyGrammar: 'lowercase [a-z0-9][a-z0-9._:-]{0,47}',
      tokenGrammar: 'pref.<stance>.<targetKey>',
      holder: { maxEntries: maxHeld, current: held.size, durability: 'NONE' },
      idLifetime: ID_LIFETIME,
      predictionLookups: 0, settlementCalls: 0,
      memoryWrites: 0, relationshipWrites: 0,
      modelCalls: 0, durableWrites: 0,
      counters: Object.assign({}, counters)
    };
  }

  return {
    ENTRY: ENTRY,
    submit: submit,
    describe: describe,
    isExplicitPreferenceReport: isExplicitPreferenceReport,
    heldReportCount: function () { return held.size; },
    counters: counters,
    dispose: function () { held.clear(); heldOrder.length = 0; }
  };
}

module.exports = {
  createRuntimeExplicitPreferenceReport: createRuntimeExplicitPreferenceReport,
  isExplicitPreferenceReport: isExplicitPreferenceReport,
  actionIdOf: function (requestId) {
    const t = (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') ? CHAT_CORE.stableToken(text(requestId)) : null;
    return t ? (ACTION_PREFIX + t) : null;
  },
  SCHEMA_VERSION: SCHEMA_VERSION,
  ID_PREFIX: ID_PREFIX,
  ACTION_PREFIX: ACTION_PREFIX,
  REPORT_SOURCE: REPORT_SOURCE,
  REPORT_BRAND: REPORT_BRAND,
  ID_LIFETIME: ID_LIFETIME,
  ENTRY: ENTRY,
  REASON: REASON,
  BOUNDS: BOUNDS
};
