/* Metadata-only trust anchor for the R3-B.1 accepted business checkpoint.
 * This object intentionally contains no records or credential values. */
(function(root){
  'use strict';
  root.IBRecoverySourceManifest=Object.freeze({
    schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',
    version:1,
    source:Object.freeze({
      fileName:'InternalBeyond_auto_2026-09-02.json',
      size:45062434,
      sha256:'1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401',
      observedExportVersion:8,
      sourceExportDate:'2026-09-02T03:07:15.995Z'
    }),
    dbContractReference:Object.freeze({databaseName:'InternalBeyondDB',schemaVersion:24}),
    recordCounts:Object.freeze({
      apiConfigs:12,
      chatMessages:341,
      chatThreads:2,
      groups:7,
      memories:3,
      autoMemory:3,
      diary_entries:13,
      moments:155,
      roleLetters:1
    }),
    credentialBoundary:Object.freeze({
      credentialBearingRecordCount:12,
      credentialBearingFieldNames:Object.freeze(['apiKey','imageGenApiKey']),
      valuesEmitted:0,
      valuesRestored:0
    })
  });
})(typeof window!=='undefined'?window:globalThis);
