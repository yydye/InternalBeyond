'use strict';
/* ====================================================================
   IB Home Node · Explicit Preference Report → RealityEvent Source Adapter
   （Prediction Error P5-B3-E-R1）
   --------------------------------------------------------------------
   REPORT_FACT_IS_UPSTREAM_TRUTH = YES
   REPORT_FACT != REALITY_EVENT
   REALITY_EVENT_EMISSION_FAILURE MUST NOT REWRITE THE REPORT

   唯一映射定义（ONE_MAPPING_DEFINITION）：
     canonical ExplicitUserPreferenceReport
       → DomainEvent input（domain=user_preference / type=preference_report）
       → runtimeRealityEvent.ingest(...)        ← 唯一的 RealityEvent authority

   ── Adapter **没有**的 authority ──────────────────────────────────────
     report mint · character/conversation resolver · prediction pairing ·
     relation classification · settlement · calibration · memory · relationship

   ── 时间与身份（§27/§28）────────────────────────────────────────────
     RealityEvent.eventId     = stableToken(reportId | MAPPING_VERSION)   （不含 predictionId）
     RealityEvent.entityId    = reportId                                   （source reference）
     RealityEvent.occurredAt  = report.occurredAt                          （**不**重新 clock）
     body                     = { targetKey, stance, reportId }            （结构化事实，无正文）
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const CHAT_CORE = require(path.join(ASSETS_JS, 'chat-core.js'));
const PREF = require(path.join(ASSETS_JS, 'memory-recall', 'preference-proposition-core.js'));
const REPORT_MODULE = require(path.join(__dirname, 'runtime-explicit-preference-report.js'));

const SOURCE_ID = 'user-explicit-preference-report';
const SOURCE_INSTANCE = 'user.explicit-preference-report';
const DOMAIN = 'user_preference';
const TYPE = 'preference_report';
const MAPPING_VERSION = 'explicit-preference-report->reality/v1';

function text(v) { return v == null ? '' : String(v); }

/** ONE mapping：sealed report → DomainEvent input（纯函数，无 I/O）。 */
function toRealityEventInput(report) {
  const reportId = text(report && report.reportId);
  return {
    sourceId: SOURCE_ID,
    sourceEvent: {
      /* event identity = reportId + mapping version（**不含** predictionId） */
      eventId: 'explicit_preference_report:' + CHAT_CORE.stableToken(reportId + '|' + MAPPING_VERSION),
      domain: DOMAIN,
      type: TYPE,
      entityId: reportId,                          /* entity identity = report instance */
      timestamp: Number(report && report.occurredAt), /* = report.occurredAt（不重 clock） */
      characterId: text(report && report.characterId),
      conversationId: text(report && report.conversationId),
      /* bounded structured facts：settlement 只需 stance + targetKey */
      body: {
        targetKey: text(report && report.targetKey),
        stance: text(report && report.stance),
        reportId: reportId
      }
    }
  };
}

/**
 * createExplicitPreferenceReportRealitySource({ realityEvent, logger })
 *   emit(report) → { ok, status, reasonCode }
 * ★ 只接受 **sealed** canonical report（capability，不信任 shape）。
 * ★ 绝不抛回上游；绝不改写 report。
 */
function createExplicitPreferenceReportRealitySource(deps) {
  const d = deps || {};
  const realityEvent = d.realityEvent || null;
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const counters = {
    attempted: 0, minted: 0, duplicate: 0, failed: 0, rejectedNotCanonical: 0,
    modelCalls: 0, durableWrites: 0
  };

  function emit(report) {
    counters.attempted += 1;
    if (!realityEvent || typeof realityEvent.ingest !== 'function') {
      counters.failed += 1;
      return { ok: false, status: 'failed', reasonCode: 'reality-authority-unavailable' };
    }
    /* capability check：普通对象 / 伪造 seal 一律拒绝（不是"看起来像"） */
    if (typeof REPORT_MODULE.isExplicitPreferenceReport !== 'function'
      || REPORT_MODULE.isExplicitPreferenceReport(report) !== true) {
      counters.rejectedNotCanonical += 1;
      return { ok: false, status: 'refused', reasonCode: 'not-canonical-explicit-preference-report' };
    }
    /* 映射前再核一次 proposition：RealityEvent body 必须是 canonical 的 */
    if (PREF.buildPreferenceToken(text(report.stance), text(report.targetKey)) == null) {
      counters.rejectedNotCanonical += 1;
      return { ok: false, status: 'refused', reasonCode: 'report-proposition-not-canonical' };
    }
    let res = null;
    try {
      res = realityEvent.ingest(toRealityEventInput(report));
    } catch (error) {
      counters.failed += 1;
      if (logger) {
        logger('explicit-preference-report-reality-failed', {
          reportId: text(report.reportId),
          error: String((error && error.message) || error).slice(0, 200)
        });
      }
      return { ok: false, status: 'failed', reasonCode: 'reality-ingest-threw' };
    }
    if (res && res.ok === true && res.status === 'minted') {
      counters.minted += 1;
      return { ok: true, status: 'minted', reasonCode: 'ok', realityEvent: res.realityEvent };
    }
    if (res && res.ok === true && res.status === 'duplicate') {
      counters.duplicate += 1;
      return { ok: true, status: 'duplicate', reasonCode: 'duplicate-source-event-suppressed', realityEvent: res.realityEvent };
    }
    counters.failed += 1;
    if (logger) {
      logger('explicit-preference-report-reality-refused', {
        reportId: text(report.reportId), reason: res && res.reasonCode
      });
    }
    return { ok: false, status: 'refused', reasonCode: (res && res.reasonCode) || 'reality-ingest-refused' };
  }

  function describe() {
    return {
      sourceId: SOURCE_ID, sourceInstance: SOURCE_INSTANCE, domain: DOMAIN, type: TYPE,
      sourceClass: 'EXPLICIT_USER_REPORT',
      mappingAuthority: 'ONE_MAPPING_DEFINITION',
      mappingVersion: MAPPING_VERSION,
      acceptsOnlySealedCanonicalReport: 'YES',
      realityEventIdentityIndependentOfPrediction: 'YES',
      occurredAtSource: 'REPORT_OCCURRED_AT_NO_RECLOCK',
      bodyIsStructuredFactsOnly: 'YES',
      predictionPairing: 'NONE', relationClassification: 'NONE', settlement: 'NONE', calibration: 'NONE',
      memoryWrites: 0, relationshipWrites: 0, modelCalls: 0, durableWrites: 0,
      counters: Object.assign({}, counters)
    };
  }

  return { emit: emit, describe: describe, toRealityEventInput: toRealityEventInput, counters: counters };
}

module.exports = {
  createExplicitPreferenceReportRealitySource: createExplicitPreferenceReportRealitySource,
  toRealityEventInput: toRealityEventInput,
  SOURCE_ID: SOURCE_ID,
  SOURCE_INSTANCE: SOURCE_INSTANCE,
  DOMAIN: DOMAIN,
  TYPE: TYPE,
  MAPPING_VERSION: MAPPING_VERSION
};
