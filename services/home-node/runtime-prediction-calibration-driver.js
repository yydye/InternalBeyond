'use strict';
/* ====================================================================
   IB Home Node · P5-B3-J · P3 Settlement → P4 Calibration Driver
   --------------------------------------------------------------------
   Orchestration only:
     canonical sealed P3 SettlementRecord
       → pass through P3's calibrationCounted bit
       → existing P4 ingestSettlement API

   No settlement, eligibility, partition, dedupe, or aggregation policy lives
   here. P4 rechecks provenance and eligibility and owns all ledger state.
   ==================================================================== */

const P3 = require('./runtime-prediction-settlement.js');

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const REASON = Object.freeze({
  calibrationUnavailable: 'calibration-ledger-unavailable',
  settlementUnsealed: 'settlement-not-sealed-by-p3',
  notCalibrationCounted: 'p3-says-not-calibration-counted',
  predictionErrorUnsealed: 'prediction-error-not-sealed-by-p3',
  predictionErrorMismatch: 'prediction-error-does-not-match-settlement',
  settlementTimeMissing: 'p3-settlement-time-missing',
  ledgerIngestThrew: 'calibration-ledger-ingest-threw'
});

function createRuntimePredictionCalibrationDriver(deps) {
  const d = deps || {};
  const calibrationRuntime = d.calibrationRuntime || null;
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const counters = {
    settlementSeen: 0,
    calibrationEligible: 0,
    skippedNotCounted: 0,
    rejectedUnsealedSettlement: 0,
    rejectedPredictionError: 0,
    ledgerAttempts: 0,
    ledgerAccepted: 0,
    ledgerDuplicate: 0,
    ledgerRejected: 0,
    ledgerFailed: 0,
    lastLedgerStatus: null,
    lastLedgerReasonCode: null
  };

  function dispatchSettlement(settlement, predictionError) {
    counters.settlementSeen += 1;
    if (!P3.isSettlementRecord(settlement)) {
      counters.rejectedUnsealedSettlement += 1;
      return { ok: false, status: 'rejected', reasonCode: REASON.settlementUnsealed };
    }

    /* This bit is P3's complete eligibility decision. The driver does not
       inspect state, predictionType, attribution, or self-influence. */
    if (settlement.calibrationCounted !== true) {
      counters.skippedNotCounted += 1;
      return { ok: true, status: 'skipped', reasonCode: REASON.notCalibrationCounted };
    }
    counters.calibrationEligible += 1;

    if (!P3.isPredictionErrorRecord(predictionError)) {
      counters.rejectedPredictionError += 1;
      return { ok: false, status: 'rejected', reasonCode: REASON.predictionErrorUnsealed };
    }
    if (text(predictionError.settlementId) !== text(settlement.settlementId)
      || text(predictionError.predictionId) !== text(settlement.predictionId)) {
      counters.rejectedPredictionError += 1;
      return { ok: false, status: 'rejected', reasonCode: REASON.predictionErrorMismatch };
    }

    if (!calibrationRuntime || typeof calibrationRuntime.ingestSettlement !== 'function') {
      counters.ledgerFailed += 1;
      return { ok: false, status: 'failed', reasonCode: REASON.calibrationUnavailable };
    }
    const settledAt = finite(settlement.settledAt);
    if (settledAt == null) {
      counters.ledgerFailed += 1;
      return { ok: false, status: 'failed', reasonCode: REASON.settlementTimeMissing };
    }

    counters.ledgerAttempts += 1;
    let result = null;
    try {
      result = calibrationRuntime.ingestSettlement(settlement, {
        now: settledAt,
        predictionError: predictionError
      });
    } catch (error) {
      counters.ledgerFailed += 1;
      if (logger) {
        try {
          logger('prediction-calibration-driver-ingest-failed', {
            settlementId: text(settlement.settlementId),
            error: String((error && error.message) || error).slice(0, 180)
          });
        } catch (_) { /* diagnostics do not affect the settlement */ }
      }
      return { ok: false, status: 'failed', reasonCode: REASON.ledgerIngestThrew };
    }

    if (result && result.ok === true && result.status === 'ingested') {
      counters.ledgerAccepted += 1;
      counters.lastLedgerStatus = 'ingested';
      counters.lastLedgerReasonCode = text(result.reasonCode) || 'ok';
      return {
        ok: true, status: 'ingested', reasonCode: result.reasonCode,
        partitionKey: result.partitionKey, entryId: result.entryId
      };
    }
    if (result && result.ok === true && result.status === 'duplicate') {
      counters.ledgerDuplicate += 1;
      counters.lastLedgerStatus = 'duplicate';
      counters.lastLedgerReasonCode = text(result.reasonCode) || 'duplicate-settlement-entry';
      return {
        ok: true, status: 'duplicate', reasonCode: result.reasonCode,
        partitionKey: result.partitionKey, entryId: result.entryId
      };
    }

    counters.ledgerRejected += 1;
    counters.lastLedgerStatus = result && text(result.status) || 'failed';
    counters.lastLedgerReasonCode = text(result && result.reasonCode) || REASON.calibrationUnavailable;
    return {
      ok: false,
      status: result && result.status === 'rejected' ? 'rejected' : 'failed',
      reasonCode: text(result && result.reasonCode) || REASON.calibrationUnavailable,
      partitionKey: result && result.partitionKey || null
    };
  }

  return {
    dispatchSettlement: dispatchSettlement,
    describe: function () {
      return {
        status: calibrationRuntime && typeof calibrationRuntime.ingestSettlement === 'function'
          ? 'LIVE_CAPABLE' : 'UNAVAILABLE',
        owner: 'HOME_NODE_RUNTIME_ASSEMBLY',
        role: 'ORCHESTRATION_ONLY',
        inputAuthority: 'P3_MODULE_PRIVATE_SETTLEMENT_AND_ERROR_SEALS',
        p3EligibilityBit: 'calibrationCounted',
        rejudgesSettlement: 'NO',
        ownsPartitioning: 'NO',
        ownsDedupe: 'NO',
        p4LedgerAuthority: 'YES',
        settlementTimeSource: 'P3_SETTLED_AT',
        routes: 'NONE',
        browserVisible: 'NO',
        durableWrites: 0,
        memoryWrites: 0,
        relationshipWrites: 0,
        counters: Object.assign({}, counters)
      };
    }
  };
}

module.exports.createRuntimePredictionCalibrationDriver = createRuntimePredictionCalibrationDriver;
module.exports.REASON = REASON;
