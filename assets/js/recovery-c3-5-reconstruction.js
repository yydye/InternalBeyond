/* P32-W5-R3-C3.5. RecoveryOnly read-only reconstruction preflight UI. */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || root.__IB_RECOVERY_ONLY__ !== true) return;

  doc.documentElement.setAttribute('data-c35-dry-run-only', 'true');
  var legacyControls = doc.getElementById('recovery-controls');
  var approvalControls = doc.getElementById('production-approval-controls');
  var nativeApprovalButton = doc.getElementById('enter-native-approval');
  if (legacyControls) legacyControls.hidden = true;
  if (approvalControls) approvalControls.hidden = true;
  if (nativeApprovalButton) { nativeApprovalButton.hidden = true; nativeApprovalButton.disabled = true; }

  var button = doc.getElementById('reconstruction-dry-run-button');
  var status = doc.getElementById('reconstruction-dry-run-status');
  var summary = doc.getElementById('reconstruction-dry-run-summary');
  var childProbeButton = doc.getElementById('c35-child-boundary-probe-button');
  var childProbeStatus = doc.getElementById('c35-child-boundary-probe-status');
  var childProbeSummary = doc.getElementById('c35-child-boundary-probe-summary');
  var running = false;
  var childProbeRunning = false;
  var dryRunRequestSchema = 'internalbeyond.p32-w5.r3-c3.5-ui-dry-run-request';
  var dryRunRequestVersion = 1;
  var childProbeRequestSchema = 'internalbeyond.p32-w5.r3-c3.5-child-process-boundary-probe-request';
  var childProbeMarkerAllowlist = [
    'C35_CHILD_SPAWN_ATTEMPTED', 'C35_CHILD_PROCESS_STARTED', 'C35_CHILD_EXIT_RECEIVED'
  ];
  var bootstrapMarkerAllowlist = [
    'C35_NODE_ENTRY_REACHED',
    'C35_BOOTSTRAP_STARTED', 'C35_BOOTSTRAP_MODULES_OK', 'C35_BOOTSTRAP_ARGS_OK',
    'C35_BOOTSTRAP_ARGS_REJECTED', 'C35_BOOTSTRAP_ADAPTER_BEGIN', 'C35_BOOTSTRAP_ADAPTER_OK',
    'C35_BOOTSTRAP_ADAPTER_FAILED', 'C35_BOOTSTRAP_PREFLIGHT_BEGIN', 'C35_BOOTSTRAP_PREFLIGHT_OK',
    'C35_BOOTSTRAP_PREFLIGHT_FAILED', 'C35_BOOTSTRAP_REQUEST_REJECTED', 'C35_BOOTSTRAP_MAIN_CAUGHT'
  ];

  function safeReasonCode(value) {
    var code = String(value || 'C35_DRYRUN_FAILED');
    return /^[A-Z][A-Z0-9_]{1,95}$/.test(code) ? code : 'C35_DRYRUN_FAILED';
  }

  function safeStageLabel(value) {
    var label = String(value || 'UNKNOWN_STAGE').replace(/[^A-Za-z0-9_]/g, '').toUpperCase();
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(label) ? label : 'UNKNOWN_STAGE';
  }

  function safeRunnerDiagnostics(value) {
    if (!value || typeof value !== 'object') return null;
    function safeSha(value) { return /^[a-f0-9]{64}$/.test(String(value || '')) ? String(value) : null; }
    function safeNameList(value, allowed) {
      if (!Array.isArray(value)) return [];
      return value.filter(function (name) { return typeof name === 'string' && allowed.indexOf(name) >= 0; });
    }
    function stream(name) {
      var item = value[name];
      if (!item || typeof item !== 'object') return null;
      return {
        byteLength: Number(item.byteLength) || 0,
        sha256: /^[a-f0-9]{64}$/.test(String(item.sha256 || '')) ? String(item.sha256) : null,
        validUtf8: item.validUtf8 === true,
        classification: safeReasonCode(item.classification || 'UNCLASSIFIED'),
        sanitizedKnownCode: item.sanitizedKnownCode ? safeReasonCode(item.sanitizedKnownCode) : null
      };
    }
    var rawHost = value.hostInvocationSnapshot;
    var hostInvocation = null;
    if (rawHost && typeof rawHost === 'object') {
      var envNames = ['PATH', 'NODE_PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS'];
      var envHashes = {};
      var rawEnv = rawHost.selectedEnvironmentPresenceAndHashes;
      if (rawEnv && typeof rawEnv === 'object') envNames.forEach(function (name) {
        var item = rawEnv[name];
        if (item && typeof item.present === 'boolean') envHashes[name] = { present: item.present, sha256: item.present ? safeSha(item.sha256) : null };
      });
      var integrity = ['UNTRUSTED', 'LOW', 'MEDIUM', 'HIGH', 'SYSTEM', 'PROTECTED', 'UNAVAILABLE'];
      hostInvocation = {
        hostPid: Number.isInteger(rawHost.hostPid) ? rawHost.hostPid : null,
        hostExecutableSha256: safeSha(rawHost.hostExecutableSha256),
        hostCwdSha256: safeSha(rawHost.hostCwdSha256),
        nodeExecutableSha256: safeSha(rawHost.nodeExecutableSha256),
        runnerSha256: safeSha(rawHost.runnerSha256),
        childCwdSha256: safeSha(rawHost.childCwdSha256),
        hostArgvCount: Number.isInteger(rawHost.hostArgvCount) ? rawHost.hostArgvCount : null,
        hostArgvCanonicalSha256: safeSha(rawHost.hostArgvCanonicalSha256),
        childArgvCount: Number.isInteger(rawHost.childArgvCount) ? rawHost.childArgvCount : null,
        childArgvCanonicalSha256: safeSha(rawHost.childArgvCanonicalSha256),
        selectedEnvironmentPresenceAndHashes: envHashes,
        sessionId: Number.isInteger(rawHost.sessionId) ? rawHost.sessionId : null,
        integrityLevel: integrity.indexOf(rawHost.integrityLevel) >= 0 ? rawHost.integrityLevel : 'UNAVAILABLE'
      };
    }
    var rawBinding = value.requestBinding;
    var requestBinding = null;
    if (rawBinding && typeof rawBinding === 'object') requestBinding = {
      schema: rawBinding.schema === 'internalbeyond.p32-w5.r3-c3.5-ui-dry-run-request' ? rawBinding.schema : null,
      version: rawBinding.version === 1 ? 1 : null,
      canonicalRequestSha256: safeSha(rawBinding.canonicalRequestSha256),
      fieldNames: safeNameList(rawBinding.fieldNames, ['requestSchema', 'requestVersion']),
      requiredFieldPresence: {
        requestSchema: rawBinding.requiredFieldPresence && rawBinding.requiredFieldPresence.requestSchema === true,
        requestVersion: rawBinding.requiredFieldPresence && rawBinding.requiredFieldPresence.requestVersion === true
      },
      runnerRequestSchema: rawBinding.runnerRequestSchema === 'internalbeyond.p32-w5.r3-c3.5-recovery-only-dry-run-request' ? rawBinding.runnerRequestSchema : null,
      runnerRequestVersion: rawBinding.runnerRequestVersion === 1 ? 1 : null,
      runnerRequestCanonicalSha256: safeSha(rawBinding.runnerRequestCanonicalSha256),
      runnerRequestFieldNames: safeNameList(rawBinding.runnerRequestFieldNames, ['localAppData', 'mode', 'nativeProof', 'schema', 'version']),
      nativeProofFieldNames: safeNameList(rawBinding.nativeProofFieldNames, [
        'activeQuarantined', 'consumedMarkerPresent', 'homeNodeSidecarHolderAudit', 'normalRuntimeStopped',
        'otherHostProcessCount', 'protectedPortListenerCount', 'providerBindingChanged', 'providerCalls',
        'recoveryOnly', 'runtimeBindingChanged', 'secretAccess', 'serviceProcessCount', 'specJsonRead', 'specJsonWrite'
      ])
    };
    return {
      failureStage: safeStageLabel(value.failureStage),
      reasonCode: value.reasonCode ? safeReasonCode(value.reasonCode) : null,
      bootstrapStages: Array.isArray(value.bootstrapStages)
        ? value.bootstrapStages.filter(function (marker) { return bootstrapMarkerAllowlist.indexOf(marker) >= 0; })
        : [],
      hostInvocationSnapshot: hostInvocation,
      requestBinding: requestBinding,
      processExitCode: Number.isInteger(value.processExitCode) ? value.processExitCode : null,
      stdout: stream('stdout'),
      stderr: stream('stderr')
    };
  }

  function safeSidecarAudit(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var entries = Array.isArray(value.entries) ? value.entries.map(function (entry) {
      if (!entry || typeof entry !== 'object' || !['-wal', '-shm'].includes(entry.suffix) ||
          typeof entry.exists !== 'boolean' || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 ||
          !(entry.sha256 === null || /^[a-f0-9]{64}$/.test(String(entry.sha256))) ||
          !/^[A-Z0-9_]{1,64}$/.test(String(entry.structureStatus || ''))) return null;
      return { suffix: entry.suffix, exists: entry.exists, sizeBytes: entry.sizeBytes,
        sha256: entry.sha256, structureStatus: entry.structureStatus };
    }) : [];
    if (entries.length !== 2 || entries.some(function (entry) { return entry === null; })) return null;
    return {
      schema: value.schema === 'internalbeyond.p32-w5.r3-c3.5-sidecar-audit' ? value.schema : null,
      version: value.version === 1 ? 1 : null,
      metadataHash: /^[a-f0-9]{64}$/.test(String(value.metadataHash || '')) ? value.metadataHash : null,
      entries: entries
    };
  }

  function safeBlockerMessage(value) {
    var code = safeReasonCode(value);
    if (code === 'C35_HOME_NODE_SIDECAR_INVALID') {
      return 'Dry-run blocked: C35_HOME_NODE_SIDECAR_INVALID — Home Node SQLite sidecar structure is invalid. No reconstruction was applied.';
    }
    return 'Dry-run blocked: ' + code;
  }

  function render(result) {
    var report = result && result.report ? result.report : result;
    if (!report || typeof report !== 'object') throw new Error('C35_DRYRUN_RESULT_INVALID');
    if (status) status.textContent = 'Gate: ' + String(report.status || 'UNKNOWN') +
      (result && result.reportPath ? ' · report: ' + String(result.reportPath) : '');
    if (summary) {
      var view = {
        ok: report.ok === true ? true : (report.ok === false ? false : null),
        writeAllowed: report.writeAllowed === false ? false : null,
        applyAllowed: report.applyAllowed === false ? false : null,
        executionIdentity: report.executionIdentity || null,
        planIdentity: report.planIdentity || null,
        bundleIdentity: report.bundleIdentity || null,
        writeSetIdentities: report.writeSetIdentities || null,
        targetIdentity: report.targetIdentity || null,
        writeSetA: report.writeSetA || null,
        writeSetB: report.writeSetB || null,
        authorityArtifacts: report.authorityArtifacts || null,
        provenance: report.provenance || null,
        runtimeBoundary: report.runtimeBoundary || null,
        activity: report.activity || null,
        reasonCode: report.reasonCode ? safeReasonCode(report.reasonCode) : null,
        sidecarMetadataHash: /^[a-f0-9]{64}$/.test(String(report.sidecarMetadataHash || '')) ? report.sidecarMetadataHash : null,
        sidecarAudit: safeSidecarAudit(report.sidecarAudit),
        blockers: (report.blockers || []).map(safeReasonCode),
        runnerDiagnostics: safeRunnerDiagnostics(result && result.runnerDiagnostics)
      };
      summary.textContent = JSON.stringify(view, null, 2);
    }
    if (report.status !== 'DRY_RUN_PASS') throw new Error(safeReasonCode(report.failureCode || report.reasonCode || (report.blockers || [])[0] || 'C35_DRYRUN_BLOCKED'));
  }

  async function runDryRun() {
    if (running) return;
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
      if (status) status.textContent = 'Native RecoveryOnly command is unavailable.';
      return;
    }
    running = true;
    if (button) button.disabled = true;
    if (status) status.textContent = 'Running read-only target and write-set preflight…';
    try {
      var result = await tauri.core.invoke('p32_w5_r3_c3_5_reconstruction_dry_run', {
        requestSchema: dryRunRequestSchema,
        requestVersion: dryRunRequestVersion
      });
      render(result);
    } catch (error) {
      if (status) {
        var code = typeof error === 'string' ? error :
          (error && typeof error.message === 'string' ? error.message :
            (error && typeof error.code === 'string' ? error.code : 'C35_DRYRUN_FAILED'));
        status.textContent = safeBlockerMessage(code);
      }
    } finally {
      running = false;
      if (button) button.disabled = false;
      if (approvalControls) approvalControls.hidden = true;
      if (nativeApprovalButton) { nativeApprovalButton.hidden = true; nativeApprovalButton.disabled = true; }
    }
  }

  if (button) button.addEventListener('click', runDryRun);

  function safeSha256(value) {
    return /^[a-f0-9]{64}$/.test(String(value || '')) ? String(value) : null;
  }

  function safeChildProbeView(value) {
    if (!value || typeof value !== 'object' ||
        value.schema !== 'internalbeyond.p32-w5.r3-c3.5-child-process-boundary-probe' ||
        value.version !== 1 || !['PASS', 'FAIL'].includes(value.status)) {
      throw new Error('C35_CHILD_PROBE_REPORT_INVALID');
    }
    var child = value.child && typeof value.child === 'object' ? value.child : {};
    var rawContext = value.spawnContext && typeof value.spawnContext === 'object' ? value.spawnContext : {};
    var rawParent = rawContext.parent && typeof rawContext.parent === 'object' ? rawContext.parent : {};
    var rawEnvironment = rawContext.environmentPresenceAndHashes && typeof rawContext.environmentPresenceAndHashes === 'object'
      ? rawContext.environmentPresenceAndHashes : {};
    var envNames = ['PATH', 'NODE_PATH', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS'];
    var environment = {};
    envNames.forEach(function (name) {
      var item = rawEnvironment[name];
      if (item && typeof item.present === 'boolean') {
        environment[name] = { present: item.present, sha256: item.present ? safeSha256(item.sha256) : null };
      }
    });
    var integrityLevels = ['UNTRUSTED', 'LOW', 'MEDIUM', 'HIGH', 'SYSTEM', 'PROTECTED', 'UNAVAILABLE'];
    var safety = value.safety && typeof value.safety === 'object' ? value.safety : {};
    return {
      schema: value.schema,
      version: value.version,
      status: value.status,
      failureCode: value.failureCode ? safeReasonCode(value.failureCode) : null,
      requestBinding: {
        schema: value.requestBinding && value.requestBinding.schema === childProbeRequestSchema ? childProbeRequestSchema : null,
        version: value.requestBinding && value.requestBinding.version === 1 ? 1 : null,
        fieldNames: ['requestSchema', 'requestVersion'],
        canonicalRequestSha256: safeSha256(value.requestBinding && value.requestBinding.canonicalRequestSha256)
      },
      targetIdentitySha256: safeSha256(value.targetIdentitySha256),
      recoveryOnly: value.recoveryOnly === true,
      activeQuarantined: value.activeQuarantined === true,
      nativeSpawnMarkers: Array.isArray(value.nativeSpawnMarkers)
        ? value.nativeSpawnMarkers.filter(function (marker) { return childProbeMarkerAllowlist.indexOf(marker) >= 0; }) : [],
      child: {
        exitCode: Number.isInteger(child.exitCode) ? child.exitCode : null,
        stdoutBytes: Number.isSafeInteger(child.stdoutBytes) ? child.stdoutBytes : null,
        stdoutSha256: safeSha256(child.stdoutSha256),
        stderrBytes: Number.isSafeInteger(child.stderrBytes) ? child.stderrBytes : null,
        stderrSha256: safeSha256(child.stderrSha256),
        nodeEntryMarkerSeen: child.nodeEntryMarkerSeen === true,
        rawStdoutReturned: child.rawStdoutReturned === true,
        rawStderrReturned: child.rawStderrReturned === true
      },
      spawnContext: {
        executableSha256: safeSha256(rawContext.executableSha256),
        argumentCount: Number.isInteger(rawContext.argumentCount) ? rawContext.argumentCount : null,
        argvCanonicalSha256: safeSha256(rawContext.argvCanonicalSha256),
        argumentContainsSpace: rawContext.argumentContainsSpace === true,
        argumentContainsNonAscii: rawContext.argumentContainsNonAscii === true,
        cwdSha256: safeSha256(rawContext.cwdSha256),
        environmentPresenceAndHashes: environment,
        parent: {
          pid: Number.isInteger(rawParent.pid) ? rawParent.pid : null,
          executableSha256: safeSha256(rawParent.executableSha256),
          sessionId: Number.isInteger(rawParent.sessionId) ? rawParent.sessionId : null,
          integrityLevel: integrityLevels.indexOf(rawParent.integrityLevel) >= 0 ? rawParent.integrityLevel : 'UNAVAILABLE'
        },
        stdio: {
          stdin: rawContext.stdio && rawContext.stdio.stdin === 'piped-empty-then-closed' ? rawContext.stdio.stdin : null,
          stdout: rawContext.stdio && rawContext.stdio.stdout === 'piped-captured' ? rawContext.stdio.stdout : null,
          stderr: rawContext.stdio && rawContext.stdio.stderr === 'piped-captured' ? rawContext.stdio.stderr : null
        },
        environmentInherited: rawContext.environmentInherited === true,
        explicitEnvironmentOverrides: Number.isInteger(rawContext.explicitEnvironmentOverrides) ? rawContext.explicitEnvironmentOverrides : null,
        shell: rawContext.shell === false ? false : null,
        windowsCreationFlags: rawContext.windowsCreationFlags === 'CREATE_NO_WINDOW (0x08000000)' || rawContext.windowsCreationFlags === 'not-applicable'
          ? rawContext.windowsCreationFlags : null,
        argumentEncoding: rawContext.argumentEncoding === 'Rust OsStr to Windows UTF-16 command line' || rawContext.argumentEncoding === 'platform-native OsStr'
          ? rawContext.argumentEncoding : null,
        cwdIdentity: rawContext.cwdIdentity === 'canonical-install-root' ? rawContext.cwdIdentity : null
      },
      safety: {
        databaseOpened: safety.databaseOpened === false,
        businessDataRead: safety.businessDataRead === false,
        credentialRead: safety.credentialRead === false,
        vaultDecrypted: safety.vaultDecrypted === false,
        providerCalls: safety.providerCalls === 0,
        reconstructionWrites: safety.reconstructionWrites === 0,
        homeNodeWrites: safety.homeNodeWrites === 0,
        indexedDbWrites: safety.indexedDbWrites === 0,
        approvalIssued: safety.approvalIssued === 0,
        checkpointCreated: safety.checkpointCreated === 0,
        applyWindowOpened: safety.applyWindowOpened === 0,
        writeAllowed: safety.writeAllowed === false,
        applyAllowed: safety.applyAllowed === false
      }
    };
  }

  async function runChildBoundaryProbe() {
    if (childProbeRunning) return;
    var tauri = root.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
      if (childProbeStatus) childProbeStatus.textContent = 'Native RecoveryOnly probe command is unavailable.';
      return;
    }
    childProbeRunning = true;
    if (childProbeButton) childProbeButton.disabled = true;
    if (childProbeStatus) childProbeStatus.textContent = 'Running one inert synthetic Node child…';
    try {
      var result = await tauri.core.invoke('p32_w5_r3_c3_5_child_process_boundary_probe', {
        requestSchema: childProbeRequestSchema,
        requestVersion: 1
      });
      var view = safeChildProbeView(result);
      if (childProbeStatus) childProbeStatus.textContent = 'Synthetic child boundary: ' + view.status +
        (view.failureCode ? ' · ' + view.failureCode : '');
      if (childProbeSummary) childProbeSummary.textContent = JSON.stringify(view, null, 2);
    } catch (error) {
      var code = typeof error === 'string' ? error :
        (error && typeof error.message === 'string' ? error.message :
          (error && typeof error.code === 'string' ? error.code : 'C35_CHILD_PROBE_FAILED'));
      if (childProbeStatus) childProbeStatus.textContent = 'Synthetic child boundary: ' + safeReasonCode(code);
    } finally {
      childProbeRunning = false;
      if (childProbeButton) childProbeButton.disabled = false;
    }
  }

  if (childProbeButton) childProbeButton.addEventListener('click', runChildBoundaryProbe);
  if (root.__IB_P32W5_C35_DRYRUN_REQUESTED__ === true) runDryRun();
  root.__IB_P32W5_C35_RUN_DRY_RUN__ = runDryRun;
  root.__IB_P32W5_C35_RUN_CHILD_BOUNDARY_PROBE__ = runChildBoundaryProbe;
})(window);
