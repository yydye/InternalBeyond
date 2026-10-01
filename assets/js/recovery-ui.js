/* P32-W.5 · explicit RecoveryOnly UI state machine.
 * No source is opened, no IndexedDB is touched and no approval is minted until
 * the corresponding user action. Production apply remains governed by the
 * adapter's immutable false kill switch. */
(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.IBRecoveryUI=api;
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(root){
  'use strict';
  var canonicalizeDomains=root&&root.IBRecoveryEngine&&root.IBRecoveryEngine.canonicalizeDomains;
  if(typeof canonicalizeDomains!=='function'&&typeof module==='object'&&module.exports&&typeof require==='function')canonicalizeDomains=require('./recovery-engine.js').canonicalizeDomains;
  var STATES=Object.freeze(['SOURCE_SELECT','SOURCE_VALIDATE','PLAN','DRY_RUN','APPROVAL_REQUIRED','APPROVED','APPLYING','RESTORED','FAILED']);
  var APPROVAL_TEXT='执行 R3-B.3 production restore';
  var FINAL_RESTORE_CONFIRMATION='FINAL_RESTORE_CONFIRMATION';
  var PREVIEW_DOMAIN_ORDER=Object.freeze(['apiConfigs','groups','chatThreads','chatMessages','memories','autoMemory','diary_entries','moments','roleLetters']);
  var SECRET_FIELD_RE=/(?:api.?key|imagegen.?apikey|secret|token|authorization|password|credential.?ref|vault|ciphertext)/i;
  var MAX_VISIBLE_DIAGNOSTICS=25;
  var APPROVAL_DENIAL_ALIASES=Object.freeze({
    'approval-plan-id-mismatch':'APPROVAL_PLAN_MISMATCH',
    'approval-plan-hash-mismatch':'APPROVAL_HASH_MISMATCH',
    'explicit-production-restore-approval-required':'APPROVAL_CONFIRMATION_PHRASE_MISMATCH',
    'restore-plan-not-ready':'APPROVAL_PLAN_BINDING_INVALID',
    'production-plan-invalid':'APPROVAL_PLAN_BINDING_INVALID',
    'production-target-snapshot-binding-mismatch':'APPROVAL_TARGET_SNAPSHOT_MISMATCH',
    'production-composite-binding-mismatch':'APPROVAL_PLAN_BINDING_INVALID',
    'restore-plan-hash-mismatch':'APPROVAL_HASH_MISMATCH',
    'production-approval-issuer-recoveryonly-required':'APPROVAL_RECOVERYONLY_REQUIRED',
    'native-approval-issuer-unavailable':'APPROVAL_NATIVE_AUTHORITY_UNAVAILABLE',
    'unresolved-recovery-checkpoint-present':'APPROVAL_RECOVERY_STATE_BLOCKED',
    'native-production-approval-response-invalid':'APPROVAL_NATIVE_RESPONSE_INVALID',
    'native-production-approval-binding-mismatch':'APPROVAL_NATIVE_BINDING_INVALID'
  });
  var APPROVAL_DENIAL_CODES=Object.freeze([
    'APPROVAL_PLAN_MISMATCH','APPROVAL_HASH_MISMATCH','APPROVAL_CONFIRMATION_PHRASE_MISMATCH',
    'APPROVAL_AUTHORITY_MISMATCH','APPROVAL_TARGET_BINDING_MISMATCH','APPROVAL_TARGET_SNAPSHOT_MISMATCH',
    'APPROVAL_PLAN_BINDING_INVALID','APPROVAL_RECOVERY_STATE_BLOCKED','APPROVAL_RECOVERYONLY_REQUIRED',
    'APPROVAL_KIND_INVALID','APPROVAL_STATIC_APPLY_FLAG_INVALID','APPROVAL_WINDOW_INVALID','APPROVAL_WINDOW_ALREADY_OPEN',
    'APPROVAL_FOREGROUND_UNAVAILABLE','APPROVAL_NATIVE_AUTHORITY_UNAVAILABLE','APPROVAL_NATIVE_RESPONSE_INVALID',
    'APPROVAL_NATIVE_BINDING_INVALID','APPROVAL_NATIVE_CONFIRMATION_UNAVAILABLE',
    'APPROVAL_NATIVE_CONFIRMATION_REJECTED','APPROVAL_NATIVE_CONFIRMATION_CANCELLED',
    'APPROVAL_NATIVE_CONFIRMATION_FAILED','APPROVAL_DUPLICATE_ISSUANCE','APPROVAL_TOKEN_EXPIRED',
    'APPROVAL_TOKEN_REPLAYED','APPROVAL_TOKEN_BINDING_INVALID','APPROVAL_TOKEN_NOT_ISSUED_HERE',
    'APPROVAL_TOKEN_STATE_INVALID','APPROVAL_CHECKPOINT_NOT_VERIFIED','APPROVAL_INTERNAL_DENIAL'
  ]);

  function clone(value){return JSON.parse(JSON.stringify(value))}
  function approvalErrorText(error){
    if(typeof error==='string')return error;
    if(error&&typeof error.message==='string')return error.message;
    try{return JSON.stringify(error||'')}catch(_){return''}
  }
  function approvalDiagnosticCode(error){
    var matches=approvalErrorText(error).match(/\b(?:APPROVAL|CHECKPOINT|RECOVERY_CHECKPOINT)_[A-Z0-9_]+\b/g)||[];
    for(var code of matches){if(code.indexOf('APPROVAL_TRACE_STAGE_')!==0)return code}
    return'';
  }
  function approvalDenialStage(error){
    var match=approvalErrorText(error).match(/APPROVAL_TRACE_STAGE_([A-Z_]+):/);
    return match?match[1]:'APPROVAL_SUBMIT';
  }
  function approvalDenialReason(error){
    var message=approvalErrorText(error);
    var precise=approvalDiagnosticCode(error);
    if(precise)return precise;
    for(var code of APPROVAL_DENIAL_CODES){if(message.indexOf(code)>=0)return code}
    var lower=message.toLowerCase();
    for(var legacy of Object.keys(APPROVAL_DENIAL_ALIASES)){if(lower.indexOf(legacy)>=0)return APPROVAL_DENIAL_ALIASES[legacy]}
    return'APPROVAL_INTERNAL_DENIAL';
  }
  function hex(bytes){return Array.from(new Uint8Array(bytes)).map(function(byte){return byte.toString(16).padStart(2,'0')}).join('')}
  async function sha256(bytes){
    if(!root.crypto||!root.crypto.subtle)throw new Error('source-hash-unavailable');
    return hex(await root.crypto.subtle.digest('SHA-256',bytes));
  }
  function countSections(backup,domains){
    var counts={};
    domains.forEach(function(domain){counts[domain]=Array.isArray(backup&&backup[domain])?backup[domain].length:null});
    return counts;
  }
  function validateMetadataCounts(backup,manifest,domains){
    var counts=countSections(backup,domains);
    for(var i=0;i<domains.length;i++){
      var domain=domains[i];
      if(counts[domain]===null)return{ok:false,error:'checkpoint-section-missing',counts:counts};
      if(Number(manifest.recordCounts[domain])!==counts[domain])return{ok:false,error:'checkpoint-record-count-mismatch',counts:counts};
    }
    return{ok:true,counts:counts};
  }
  function hasForbiddenSecretField(value){
    if(Array.isArray(value))return value.some(hasForbiddenSecretField);
    if(!value||typeof value!=='object')return false;
    return Object.keys(value).some(function(key){return SECRET_FIELD_RE.test(key)||hasForbiddenSecretField(value[key])});
  }
  function diagnosticsEvidence(plan,source){
    if(!plan)return null;
    var diagnostics=plan.diagnostics||{};
    return{
      schema:'internalbeyond.p32-w5.r3b.planner-diagnostics',version:1,
      source:{sha256:String(source&&source.sha256||plan.source&&plan.source.sha256||''),size:Number(source&&source.size||plan.source&&plan.source.size||0),exportVersion:Number(source&&source.exportVersion||plan.source&&plan.source.exportVersion||0)},
      plan:{planId:String(plan.planId||''),transactionId:String(plan.transactionId||''),planHash:String(plan.planHash||''),status:String(plan.status||''),targetIdentity:String(plan.target&&plan.target.identity||''),schemaVersion:Number(plan.target&&plan.target.schemaVersion||0)},
      domainCounts:(plan.domains||[]).map(function(item){return{domain:String(item.domain||''),sourceCount:item.sourceCount==null?null:Number(item.sourceCount),validCount:Number(item.validCount)||0,targetConflictCount:Number(item.targetCollisionCount)||0,referenceConflictCount:Number(item.referenceConflictCount)||0,action:String(item.action||'')}}),
      blockerCount:Number(diagnostics.blockerCount)||0,noticeCount:Number(diagnostics.noticeCount)||0,
      categoryCounts:Object.assign({},diagnostics.categoryCounts||{}),totalDiagnostics:Number(diagnostics.total)||0,
      diagnostics:(diagnostics.entries||[]).slice(0,MAX_VISIBLE_DIAGNOSTICS),
      displayLimit:MAX_VISIBLE_DIAGNOSTICS,truncated:!!diagnostics.truncated||(diagnostics.entries||[]).length>MAX_VISIBLE_DIAGNOSTICS
    };
  }
  function formatDiagnostics(plan,source){var evidence=diagnosticsEvidence(plan,source);return evidence?JSON.stringify(evidence):''}
  function buildRecoveryPreviewModel(plan,composite){
    if(!plan||plan.mode!=='dry-run'||plan.status!=='READY_FOR_EXPLICIT_RESTORE_APPROVAL'||!plan.productionBinding)return{ok:false,error:'recovery-preview-plan-invalid'};
    var id=String(plan.productionBinding.id||plan.planId||''),hash=String(plan.productionBinding.productionPlanHash||'').toLowerCase(),snapshotHash=String(plan.productionBinding.targetSnapshotSha256||'').toLowerCase();
    if(!/^r3b3:[a-f0-9]{64}$/.test(id)||id!=='r3b3:'+hash||!/^[a-f0-9]{64}$/.test(hash)||!/^[a-f0-9]{64}$/.test(snapshotHash))return{ok:false,error:'recovery-preview-plan-binding-invalid'};
    composite=composite||{};
    var identity=Array.isArray(composite.identitySuccession)&&composite.identitySuccession.length===1?composite.identitySuccession[0]:null;
    var provenance=composite.provenance||{},ranges=Array.isArray(provenance.ranges)?provenance.ranges:[];
    var domains=Array.isArray(plan.domains)?plan.domains:[],domainByName={};
    domains.forEach(function(item){domainByName[item.domain]=item});
    var primary=composite.primarySource||{},supplemental=Array.isArray(composite.supplementalSources)?composite.supplementalSources:[];
    function sourceName(sourceCode){
      if(sourceCode==='PRIMARY_2026_09_02')return String(primary.fileName||'Primary source');
      if(sourceCode==='SUPPLEMENTAL_ROLE_2026_09_03'){
        var role=supplemental.find(function(item){return item.kind==='role-metadata'});return String(role&&role.fileName||'Supplemental role source');
      }
      if(sourceCode==='SUPPLEMENTAL_MEMORY_2026_08_27'){
        var memory=supplemental.find(function(item){return item.kind==='memory'});return String(memory&&memory.fileName||'Supplemental memory source');
      }
      return'Unmapped source';
    }
    var domainRows=PREVIEW_DOMAIN_ORDER.map(function(domain){
      var item=domainByName[domain];
      if(!item)return{domain:domain,plannedRestoreCount:0,source:'Missing from plan',provenanceRecordCount:0,provenanceStatus:'UNBOUND'};
      var planned=Number(item.validCount==null?item.sourceCount:item.validCount)||0;
      var domainRanges=ranges.filter(function(range){return range&&range.domain===domain});
      var boundCount=domainRanges.reduce(function(total,range){return total+(Number(range.recordCount)||0)},0);
      var mappedSources=domainRanges.map(function(range){return sourceName(String(range.source||''))});
      var names=Array.from(new Set(mappedSources));
      var bound=domainRanges.length>0&&mappedSources.every(function(name){return name!=='Unmapped source'})&&boundCount===planned&&planned===Number(item.sourceCount);
      return{
        domain:domain,plannedRestoreCount:planned,source:names.length?names.join(' + '):'No provenance source',
        provenanceRecordCount:boundCount,provenanceStatus:bound?'BOUND':'UNBOUND'
      };
    });
    var sourceCount=Number(plan.summary&&plan.summary.sourceRecords)||domainRows.reduce(function(total,row){return total+row.plannedRestoreCount},0);
    var provenanceCount=Number(provenance.recordCount)||0;
    var totalPlanned=domainRows.reduce(function(total,row){return total+row.plannedRestoreCount},0);
    var identityOk=!!identity&&identity.authority==='USER_CONFIRMED_IDENTITY_SUCCESSION'&&identity.status==='EXPLICIT_USER_CONFIRMATION'&&typeof identity.oldId==='string'&&identity.oldId.length>0&&typeof identity.newId==='string'&&identity.newId.length>0;
    var provenanceComplete=provenanceCount===sourceCount&&sourceCount===totalPlanned&&domainRows.every(function(row){return row.provenanceStatus==='BOUND'});
    var credential=plan.credentialBoundary||{};
    var credentialSafe=credential.credentialState==='NEEDS_REBIND'&&Number(credential.secretValuesProjected)===0;
    var selected=Array.isArray(plan.selectedDomains)?plan.selectedDomains:[],canonicalSelection=typeof canonicalizeDomains==='function'?canonicalizeDomains(selected):{ok:false};
    var selectedDomainsComplete=canonicalSelection.ok===true;
    return{
      ok:true,complete:identityOk&&provenanceComplete&&credentialSafe&&selectedDomainsComplete,selectedDomainsComplete:selectedDomainsComplete,
      planId:id,planSha256:hash,targetSnapshotSha256:snapshotHash,
      sourceCount:sourceCount,provenanceCount:provenanceCount,
      sourceFiles:[primary.fileName].concat(supplemental.map(function(item){return item.fileName})).filter(Boolean),
      domains:domainRows,
      identitySuccession:identity?{
        oldId:identity.oldId,newId:identity.newId,authority:identity.authority,status:identity.status,
        systemConfirmed:identity.systemConfirmed===true,
        explanation:'用户确认的身份继承关系，不是自动迁移发现。'
      }:null,
      credentialBoundary:{
        restoredApiConfigMetadata:true,plannedApiConfigCount:Number((domainByName.apiConfigs||{}).validCount)||0,
        apiKeysRestored:false,secretValuesRestored:false,credentialVaultRestored:false,
        state:String(credential.credentialState||'NEEDS_REBIND'),secretValuesProjected:Number(credential.secretValuesProjected)||0
      },
      excludedData:['cache','WebView session','WAL/SHM physical files','logs','runtime state']
    };
  }
  async function validateSourceFile(file,manifest,domains,projectApiConfig){
    if(!file||typeof file.arrayBuffer!=='function')return{ok:false,error:'checkpoint-file-required'};
    if(file.name!==manifest.source.fileName)return{ok:false,error:'checkpoint-filename-mismatch'};
    if(Number(file.size)!==Number(manifest.source.size))return{ok:false,error:'checkpoint-size-mismatch'};
    var bytes=new Uint8Array(await file.arrayBuffer()),actualHash=await sha256(bytes),byteLength=bytes.length;
    if(actualHash!==String(manifest.source.sha256).toLowerCase()){bytes.fill(0);return{ok:false,error:'checkpoint-sha256-mismatch',size:byteLength,sha256:actualHash}}
    var backup;
    try{backup=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch(error){bytes.fill(0);return{ok:false,error:'checkpoint-json-invalid',size:byteLength,sha256:actualHash}}
    bytes.fill(0);
    if(!backup||Number(backup.version)!==Number(manifest.source.observedExportVersion))return{ok:false,error:'checkpoint-export-version-mismatch',size:byteLength,sha256:actualHash};
    if(String(backup.exportDate||'')!==String(manifest.source.sourceExportDate))return{ok:false,error:'checkpoint-export-date-mismatch',size:byteLength,sha256:actualHash};
    var sectionCheck=validateMetadataCounts(backup,manifest,domains);
    if(!sectionCheck.ok)return Object.assign({size:byteLength,sha256:actualHash},sectionCheck);
    if(typeof projectApiConfig!=='function')return{ok:false,error:'credential-projection-unavailable'};
    if(!Array.isArray(backup.apiConfigs))return{ok:false,error:'checkpoint-section-missing'};
    var projectedConfigs=[];
    for(var row of backup.apiConfigs){var projection=projectApiConfig(row);if(!projection||projection.ok!==true)return{ok:false,error:'api-config-metadata-projection-failed'};projectedConfigs.push(projection.record)}
    backup.apiConfigs=projectedConfigs;
    for(var domain of domains){if(domain==='apiConfigs')continue;if(hasForbiddenSecretField(backup[domain]))return{ok:false,error:'credential-bearing-business-field-blocked'}}
    return{ok:true,size:byteLength,sha256:actualHash,exportVersion:Number(backup.version),exportDate:String(backup.exportDate),counts:sectionCheck.counts,backup:backup};
  }

  function createStateMachine(options){
    options=options||{};
    var compositeApi=options.compositePlanApi||root.IBCompositeRecoveryPlan||null,domains=(options.domains||root.IBRecoveryEngine&&root.IBRecoveryEngine.DOMAIN_ORDER||[]).slice(),adapter=options.adapter||null,executor=options.executor||null;
    var state='SOURCE_SELECT',compositePlan=null,packageSummary=null,prepared=null,lastError=null,checkpointCreated=false,transactionCommitted=false,verification=null,restoreReport=null,finalConfirmationBinding='';
    function fail(code,detail){lastError={code:String(code||'recovery-failed'),detail:String(detail||'')};state='FAILED';return Object.assign({},view(),{ok:false,state:state,error:lastError})}
    function confirmationFingerprint(plan,composite){
      var preview=buildRecoveryPreviewModel(plan,composite);
      if(!preview.ok||!preview.complete)return'';
      return[preview.planId,preview.planSha256,preview.targetSnapshotSha256,preview.sourceCount,preview.provenanceCount,preview.identitySuccession.oldId,preview.identitySuccession.newId,preview.identitySuccession.authority,preview.identitySuccession.status,preview.credentialBoundary.state].join('|');
    }
    function finalConfirmationComplete(){return !!finalConfirmationBinding&&finalConfirmationBinding===confirmationFingerprint(prepared&&prepared.plan,packageSummary)}
    function view(){return Object.freeze({state:state,error:lastError?Object.assign({},lastError):null,composite:packageSummary?clone(packageSummary):null,plan:prepared?prepared.plan:null,approvalReady:state==='APPROVED',finalRestoreConfirmationComplete:finalConfirmationComplete(),checkpointCreated:checkpointCreated,transactionCommitted:transactionCommitted,verification:verification?clone(verification):null,restoreReport:restoreReport?clone(restoreReport):null,productionApplyEnabled:!!(adapter&&adapter.PRODUCTION_APPLY_ENABLED)})}
    async function selectCompositeFiles(files){
      if(state==='APPLYING'||state==='RESTORED')return fail('recovery-state-locked','A restore execution has already started in this RecoveryOnly session');
      state='SOURCE_VALIDATE';lastError=null;compositePlan=null;packageSummary=null;prepared=null;checkpointCreated=false;transactionCommitted=false;verification=null;restoreReport=null;finalConfirmationBinding='';
      try{
        if(!compositeApi||typeof compositeApi.buildFromFiles!=='function'||typeof compositeApi.validate!=='function')return fail('composite-validator-unavailable');
        var result=await compositeApi.buildFromFiles(files);
        if(!result||result.ok!==true||!result.packagePlan)return fail(result&&result.error||'composite-source-validation-failed');
        var validation=await compositeApi.validate(result.packagePlan);
        if(!validation||validation.ok!==true)return fail(validation&&validation.error||'composite-plan-validation-failed');
        compositePlan=result.packagePlan;packageSummary=result.summary;state='PLAN';return{ok:true,state:state,composite:view().composite};
      }catch(error){return fail('composite-source-validation-failed',error&&error.message||error)}
    }
    async function dryRun(){
      if(state!=='PLAN'||!compositePlan||!adapter)return fail('composite-plan-validation-required');
      state='DRY_RUN';lastError=null;finalConfirmationBinding='';
      try{
        prepared=await adapter.dryRun({compositePlan:compositePlan});
        if(!prepared||!prepared.plan||prepared.plan.status!=='READY_FOR_EXPLICIT_RESTORE_APPROVAL')return fail('restore-plan-blocked',JSON.stringify(prepared&&prepared.plan&&prepared.plan.errors||[]));
        state='APPROVAL_REQUIRED';return{ok:true,state:state,plan:prepared.plan};
      }catch(error){return fail('dry-run-failed',error&&error.message||error)}
    }
    function confirmFinalRestore(acknowledgement){
      acknowledgement=acknowledgement||{};
      if(state!=='APPROVAL_REQUIRED'||!prepared)return{ok:false,state:state,error:'production-plan-required-for-final-confirmation'};
      var preview=buildRecoveryPreviewModel(prepared.plan,packageSummary);
      if(!preview.ok||!preview.complete)return{ok:false,state:state,error:'recovery-preview-incomplete'};
      if(acknowledgement.planIdentityReviewed!==true||acknowledgement.targetSnapshotReviewed!==true||acknowledgement.identitySuccessionReviewed!==true||acknowledgement.credentialBoundaryReviewed!==true||acknowledgement.confirmation!==FINAL_RESTORE_CONFIRMATION)return{ok:false,state:state,error:'final-restore-confirmation-incomplete'};
      if(String(acknowledgement.planId||'')!==preview.planId||String(acknowledgement.planSha256||'').toLowerCase()!==preview.planSha256||String(acknowledgement.targetSnapshotSha256||'').toLowerCase()!==preview.targetSnapshotSha256||Number(acknowledgement.sourceCount)!==preview.sourceCount||Number(acknowledgement.provenanceCount)!==preview.provenanceCount||String(acknowledgement.oldIdentity||'')!==preview.identitySuccession.oldId||String(acknowledgement.newIdentity||'')!==preview.identitySuccession.newId||String(acknowledgement.identityAuthority||'')!==preview.identitySuccession.authority||String(acknowledgement.identityStatus||'')!==preview.identitySuccession.status||String(acknowledgement.credentialState||'')!==preview.credentialBoundary.state)return{ok:false,state:state,error:'final-restore-confirmation-binding-mismatch'};
      finalConfirmationBinding=confirmationFingerprint(prepared.plan,packageSummary);
      lastError=null;
      return Object.assign({},view(),{ok:true,state:state,approvalIssued:false,checkpointCreated:false,applyWindowOpened:false});
    }
    async function approve(request){
      if(state!=='APPROVAL_REQUIRED'||!prepared||!executor)return{ok:false,state:state,error:'production-plan-and-recoveryonly-executor-required'};
      if(!finalConfirmationComplete())return{ok:false,state:state,error:'final-restore-confirmation-required'};
      lastError=null;
      try{
        var issued=await executor.requestApproval(prepared,request||{});
        if(!issued||issued.ok!==true||issued.planId!==prepared.plan.planId||String(issued.planHash||'').toLowerCase()!==String(prepared.plan.productionBinding.productionPlanHash||'').toLowerCase())return{ok:false,state:state,error:'approval-binding-response-invalid'};
        state='APPROVED';return Object.assign({},view(),{ok:true,state:state,approvalIssued:true,tokenExposed:false});
      }catch(error){
        lastError={code:approvalDenialReason(error),stage:approvalDenialStage(error),detail:''};
        return Object.assign({},view(),{ok:false,state:state,error:lastError});
      }
    }
    async function apply(){
      if(state!=='APPROVED'||!prepared||!executor)return{ok:false,state:state,error:'explicit-production-restore-approval-required'};
      state='APPLYING';lastError=null;
      try{
        restoreReport=await executor.execute(prepared);
        if(!restoreReport||restoreReport.ok!==true)throw new Error('recovery-apply-executor-result-invalid');
        checkpointCreated=true;transactionCommitted=true;verification=restoreReport;
        state='RESTORED';return Object.assign({},view(),{ok:true,state:state});
      }catch(error){
        checkpointCreated=!!(executor.lastCheckpoint&&executor.lastCheckpoint.planId===prepared.plan.planId);
        transactionCommitted=false;
        var diagnosticCode=approvalDiagnosticCode(error)||'RECOVERY_APPLY_FAILED';
        lastError={code:'production-restore-execution-failed',diagnosticCode:diagnosticCode,detail:diagnosticCode};
        state='FAILED';return Object.assign({},view(),{ok:false,state:state,error:lastError});
      }
    }
    function selectSource(){return fail('single-backup-rejected','Select the complete frozen composite source set')}
    return Object.freeze({selectCompositeFiles:selectCompositeFiles,selectSource:selectSource,dryRun:dryRun,confirmFinalRestore:confirmFinalRestore,approve:approve,apply:apply,view:view});
  }

  function mount(options){
    options=options||{};var doc=options.document||root.document,host=doc&&doc.getElementById('recovery-controls');
    if(!doc||!host)return null;
    var engine=root.IBRecoveryEngine,compositeApi=root.IBCompositeRecoveryPlan,adapterApi=root.IBProductionRecoveryAdapter,executorApi=root.IBRecoveryApplyExecutor;
    if(!engine||!compositeApi||!adapterApi||!executorApi){var error=doc.getElementById('status');if(error)error.textContent='Recovery payload incomplete. Production apply remains locked.';return null}
    var adapter=new adapterApi.ProductionRecoveryAdapter(),executor=new executorApi.RecoveryOnlyApplyExecutor(adapter),machine=createStateMachine({domains:engine.DOMAIN_ORDER,compositePlanApi:compositeApi,adapter:adapter,executor:executor});
    var status=doc.getElementById('status'),fileInput=doc.getElementById('composite-files'),validateButton=doc.getElementById('validate-composite'),dryRunButton=doc.getElementById('dry-run'),summary=doc.getElementById('composite-summary'),details=doc.getElementById('recovery-details');
    var sourceWorkflow=doc.getElementById('recovery-source-workflow'),preview=doc.getElementById('recovery-preview'),previewRows=doc.getElementById('preview-domain-rows'),previewSources=doc.getElementById('preview-source-files'),previewExcluded=doc.getElementById('preview-excluded-data');
    var finalConfirmationInputs=['final-confirm-plan','final-confirm-snapshot','final-confirm-identity','final-confirm-credentials'].map(function(id){return doc.getElementById(id)}),finalConfirmationToken=doc.getElementById('final-restore-confirmation'),enterNativeApproval=doc.getElementById('enter-native-approval'),finalConfirmationStatus=doc.getElementById('final-confirmation-status');
    var approvalControls=doc.getElementById('production-approval-controls'),approvalPlanId=doc.getElementById('approval-plan-id'),approvalPlanHash=doc.getElementById('approval-plan-hash'),approvalConfirmation=doc.getElementById('approval-confirmation'),approvalUnderstands=doc.getElementById('approval-understands-production-write'),issueApprovalButton=doc.getElementById('issue-production-approval'),executeButton=doc.getElementById('execute-production-restore'),approvalStatus=doc.getElementById('approval-status');
    var confirmationText=executorApi.CONFIRMATION,nativeApprovalEntered=false,activePreviewFingerprint='';
    function elementText(id,value){var element=doc.getElementById(id);if(element)element.textContent=String(value==null?'':value)}
    function resetFinalConfirmation(){
      finalConfirmationInputs.forEach(function(input){if(input){input.checked=false;input.disabled=false}});
      if(finalConfirmationToken){finalConfirmationToken.value='';finalConfirmationToken.disabled=false}
      if(finalConfirmationStatus)finalConfirmationStatus.textContent='';
      if(approvalPlanId)approvalPlanId.value='';if(approvalPlanHash)approvalPlanHash.value='';if(approvalConfirmation)approvalConfirmation.value='';if(approvalUnderstands)approvalUnderstands.checked=false;
    }
    function previewFingerprint(model){return model&&model.ok?[model.planId,model.planSha256,model.targetSnapshotSha256,model.identitySuccession&&model.identitySuccession.oldId,model.identitySuccession&&model.identitySuccession.newId,model.identitySuccession&&model.identitySuccession.authority,model.credentialBoundary&&model.credentialBoundary.state].join('|'):''}
    function renderPreviewModel(model){
      if(!model||!model.ok)return;
      elementText('preview-plan-id',model.planId);elementText('preview-plan-hash',model.planSha256);elementText('preview-target-snapshot-hash',model.targetSnapshotSha256);
      elementText('preview-source-count',model.sourceCount);elementText('preview-provenance-count',model.provenanceCount);
      elementText('preview-provenance-state',model.complete?'Provenance bound':'Provenance incomplete');
      elementText('preview-sources-label',model.sourceFiles.join(' · '));
      elementText('preview-identity-old',model.identitySuccession&&model.identitySuccession.oldId||'Unavailable');
      elementText('preview-identity-new',model.identitySuccession&&model.identitySuccession.newId||'Unavailable');
      elementText('preview-identity-authority',model.identitySuccession&&model.identitySuccession.authority||'UNBOUND');
      elementText('preview-identity-explanation',model.identitySuccession&&model.identitySuccession.explanation||'Identity succession is not bound to this plan.');
      elementText('preview-api-metadata-count',model.credentialBoundary.plannedApiConfigCount);
      elementText('preview-credential-state',model.credentialBoundary.state);
      if(previewRows){previewRows.replaceChildren();model.domains.forEach(function(row){
        var tr=doc.createElement('tr');
        [row.domain,String(row.plannedRestoreCount),row.source,row.provenanceStatus+' · '+String(row.provenanceRecordCount)+'/'+String(row.plannedRestoreCount)].forEach(function(value,index){var td=doc.createElement('td');td.textContent=value;if(index===1)td.className='preview-count';tr.appendChild(td)});
        previewRows.appendChild(tr);
      })}
      if(previewSources){previewSources.replaceChildren();model.sourceFiles.forEach(function(name){var li=doc.createElement('li');li.textContent=name;previewSources.appendChild(li)})}
      if(previewExcluded){previewExcluded.replaceChildren();model.excludedData.forEach(function(name){var li=doc.createElement('li');li.textContent=name;previewExcluded.appendChild(li)})}
    }
    function updateApprovalGate(info){
      var current=info||machine.view(),plan=current.plan,previewModel=buildRecoveryPreviewModel(plan,current.composite);
      var finalComplete=current.finalRestoreConfirmationComplete===true;
      finalConfirmationInputs.forEach(function(input){if(input)input.disabled=finalComplete});
      if(finalConfirmationToken)finalConfirmationToken.disabled=finalComplete;
      var finalReady=!!previewModel.ok&&previewModel.complete&&finalConfirmationInputs.every(function(input){return!!input&&input.checked})&&!!finalConfirmationToken&&finalConfirmationToken.value===FINAL_RESTORE_CONFIRMATION;
      if(enterNativeApproval)enterNativeApproval.disabled=current.state!=='APPROVAL_REQUIRED'||!finalReady||finalComplete;
      if(approvalControls)approvalControls.hidden=!(nativeApprovalEntered&&finalComplete&&plan&&['APPROVAL_REQUIRED','APPROVED','APPLYING','RESTORED','FAILED'].includes(current.state));
      if(issueApprovalButton){
        var exact=!!plan&&finalComplete&&approvalPlanId.value===String(plan.planId)&&approvalPlanHash.value===String(plan.productionBinding.productionPlanHash)&&approvalConfirmation.value===confirmationText&&approvalUnderstands.checked;
        issueApprovalButton.disabled=current.state!=='APPROVAL_REQUIRED'||!exact;
      }
      if(executeButton)executeButton.disabled=current.state!=='APPROVED';
      if(approvalStatus){
        if(current.state==='APPROVAL_REQUIRED'&&!current.finalRestoreConfirmationComplete)approvalStatus.textContent='Preview 完成后还需 FINAL_RESTORE_CONFIRMATION；此时尚未进入原生审批。';
        else if(current.state==='APPROVAL_REQUIRED')approvalStatus.textContent=current.error?'审批未签发。安全诊断码：'+current.error.code+'；阶段：'+(current.error.stage||'APPROVAL_SUBMIT'):'已进入原生审批步骤；尚未签发审批。请核对并手动输入当前 plan ID、production-bound SHA-256 和确认短语。';
        else if(current.state==='APPROVED')approvalStatus.textContent='一次性审批已绑定当前 plan，token 仅保存在 RecoveryOnly 内存；尚未创建 checkpoint。';
        else if(current.state==='APPLYING')approvalStatus.textContent='正在执行已批准的单事务恢复；普通运行时仍关闭。';
        else if(current.state==='RESTORED')approvalStatus.textContent='恢复与验证已完成。Apply window 已关闭；Active 仍 quarantine。';
        else if(current.state==='FAILED')approvalStatus.textContent=current.error&&current.error.detail?String(current.error.detail):'执行失败；请保留 recovery state 并停止。';
        else approvalStatus.textContent='';
      }
    }
    function render(result){
      var current=machine.view(),info=result?Object.assign({},current,result,{plan:result.plan||current.plan,composite:result.composite||current.composite}):current;
      var previewModel=buildRecoveryPreviewModel(info.plan,info.composite),binding=previewFingerprint(previewModel);
      if(binding!==activePreviewFingerprint){activePreviewFingerprint=binding;nativeApprovalEntered=false;resetFinalConfirmation()}
      if(preview)preview.hidden=!previewModel.ok;
      if(sourceWorkflow)sourceWorkflow.hidden=!!previewModel.ok;
      var technicalDetails=doc.getElementById('technical-plan-details');if(technicalDetails)technicalDetails.hidden=!previewModel.ok;
      if(previewModel.ok)renderPreviewModel(previewModel);
      var errorText=typeof info.error==='string'?info.error:(info.error&&info.error.code||'');
      if(status)status.textContent='State: '+info.state+(errorText?' — '+errorText+(info.error&&info.error.stage?' ['+info.error.stage+']':''):(info.plan?' — read-only recovery preview ready; final confirmation required before native approval':' — production apply is closed'));
      if(summary){summary.replaceChildren();summary.hidden=!info.composite;if(info.composite){
        function addTerm(label,value,mono){var dt=doc.createElement('dt'),dd=doc.createElement('dd');dt.textContent=label;if(mono){var code=doc.createElement('code');code.textContent=String(value);dd.appendChild(code)}else dd.textContent=String(value);summary.appendChild(dt);summary.appendChild(dd)}
        addTerm('Primary source',info.composite.primarySource.fileName+' · '+info.composite.primarySource.size+' bytes');
        addTerm('Primary SHA-256',info.composite.primarySource.sha256,true);
        info.composite.supplementalSources.forEach(function(source){addTerm(source.kind==='role-metadata'?'Supplemental role':'Supplemental memory',source.fileName+' · '+source.size+' bytes');addTerm(source.kind==='role-metadata'?'Role source SHA-256':'Memory source SHA-256',source.sha256,true)});
        addTerm('Identity succession',info.composite.identitySuccession[0].oldId+' → '+info.composite.identitySuccession[0].newId);
        addTerm('Authority',info.composite.identitySuccession[0].authority+' / '+info.composite.identitySuccession[0].status);
        if(info.composite.authorityRevision&&info.composite.authorityRevision.identity){addTerm('Authority revision ID',info.composite.authorityRevision.identity.planId,true);addTerm('Authority revision SHA-256',info.composite.authorityRevision.identity.planSha256,true);addTerm('HiBit identity evidence',info.composite.authorityRevision.priorIdentityEvidence.hiBit.evidenceClass+' · explicit transition='+info.composite.authorityRevision.priorIdentityEvidence.hiBit.explicitTransitionFound);addTerm('Role continuity evidence',info.composite.authorityRevision.priorIdentityEvidence.roleContinuity.evidenceClass)}
        addTerm('Frozen composite plan ID',info.composite.planIdentity.id,true);
        addTerm('Frozen composite plan SHA-256',info.composite.planIdentity.sha256,true);
        addTerm('Composite records',info.composite.summary.domainCounts.apiConfigs+' role configs · '+info.composite.summary.domainCounts.memories+' memories · '+info.composite.provenance.recordCount+' total');
      }}
      if(details){var rows=[];if(info.plan){rows.push('Frozen P5.5 plan ID: '+info.plan.compositeBinding.frozenPlanId);rows.push('Frozen P5.5 plan SHA-256: '+info.plan.compositeBinding.frozenPlanSha256);rows.push('Composite planHash (unchanged): '+info.plan.planHash);rows.push('Authority: '+info.plan.compositeBinding.identityAuthority+' / '+info.plan.compositeBinding.identityStatus);rows.push('Identity authority: '+info.plan.compositeBinding.identityAuthority);rows.push('Authority revision ID: '+String(info.plan.compositeBinding.authorityRevisionId||''));rows.push('Authority revision SHA-256: '+String(info.plan.compositeBinding.authorityRevisionSha256||''));rows.push('Authority provenance: '+JSON.stringify({recordCount:info.plan.compositeBinding.provenanceRecordCount,traceDigest:info.plan.compositeBinding.provenanceDigest}));var evidence=info.composite&&info.composite.authorityRevision&&info.composite.authorityRevision.priorIdentityEvidence;if(evidence)rows.push('Authority evidence: '+JSON.stringify({hiBit:evidence.hiBit,roleContinuity:evidence.roleContinuity}));rows.push('Production-bound plan ID: '+info.plan.productionBinding.id);rows.push('Production-bound plan SHA-256: '+info.plan.productionBinding.productionPlanHash);rows.push('Target identity: '+JSON.stringify(info.plan.target));rows.push('Target snapshot SHA-256: '+info.plan.productionBinding.targetSnapshotSha256);rows.push('Preflight: '+JSON.stringify({targetCollisions:info.plan.summary.targetCollisions,danglingReferences:info.plan.summary.referenceConflicts,duplicates:info.plan.summary.sourceDuplicates,rejected:info.plan.summary.rejectedRecords,credentialState:info.plan.credentialBoundary.credentialState,secretValuesProjected:info.plan.credentialBoundary.secretValuesProjected}));rows.push('Domains: '+JSON.stringify(info.plan.domains.map(function(item){return{domain:item.domain,count:item.sourceCount,valid:item.validCount,action:item.action}})));rows.push('Planner diagnostics JSON: '+formatDiagnostics(info.plan,info.composite&&info.composite.primarySource))}details.textContent=rows.join('\n')}
      if(details&&info.plan&&info.plan.targetSnapshotManifest)details.textContent+='\nTarget snapshot manifest JSON: '+JSON.stringify(info.plan.targetSnapshotManifest);
      if(details&&info.plan)details.textContent+='\nMutation counters: '+JSON.stringify({productionWrites:info.plan.mutation.productionWrites,localStorageWrites:info.plan.mutation.localStorageWrites,providerCalls:info.plan.mutation.providerCalls})+'\nApproval token: '+(current.state==='APPROVED'||current.state==='APPLYING'||current.state==='RESTORED'?'ACCEPTED_IN_RECOVERYONLY_MEMORY':'NOT_ACCEPTED')+'\nApply window: '+(current.state==='APPLYING'?'SCOPED_WINDOW_PENDING_OR_OPEN':'CLOSED');
      if(validateButton)validateButton.disabled=!(fileInput&&fileInput.files&&fileInput.files.length===3);
      if(dryRunButton)dryRunButton.disabled=info.state!=='PLAN';
      updateApprovalGate(info);
    }
    if(fileInput)fileInput.addEventListener('change',function(){render(machine.view())});
    if(validateButton)validateButton.addEventListener('click',async function(){render(await machine.selectCompositeFiles(fileInput&&fileInput.files||[]))});
    if(dryRunButton)dryRunButton.addEventListener('click',async function(){render(await machine.dryRun())});
    finalConfirmationInputs.forEach(function(input){if(input)input.addEventListener('change',function(){updateApprovalGate(machine.view())})});
    if(finalConfirmationToken)finalConfirmationToken.addEventListener('input',function(){updateApprovalGate(machine.view())});
    if(enterNativeApproval)enterNativeApproval.addEventListener('click',function(){
      var current=machine.view(),model=buildRecoveryPreviewModel(current.plan,current.composite);
      var result=machine.confirmFinalRestore({
        planIdentityReviewed:!!(finalConfirmationInputs[0]&&finalConfirmationInputs[0].checked),
        targetSnapshotReviewed:!!(finalConfirmationInputs[1]&&finalConfirmationInputs[1].checked),
        identitySuccessionReviewed:!!(finalConfirmationInputs[2]&&finalConfirmationInputs[2].checked),
        credentialBoundaryReviewed:!!(finalConfirmationInputs[3]&&finalConfirmationInputs[3].checked),
        confirmation:finalConfirmationToken&&finalConfirmationToken.value,
        planId:model.ok?model.planId:'',planSha256:model.ok?model.planSha256:'',targetSnapshotSha256:model.ok?model.targetSnapshotSha256:'',sourceCount:model.ok?model.sourceCount:0,provenanceCount:model.ok?model.provenanceCount:0,
        oldIdentity:model.ok&&model.identitySuccession?model.identitySuccession.oldId:'',newIdentity:model.ok&&model.identitySuccession?model.identitySuccession.newId:'',
        identityAuthority:model.ok&&model.identitySuccession?model.identitySuccession.authority:'',identityStatus:model.ok&&model.identitySuccession?model.identitySuccession.status:'',credentialState:model.ok?model.credentialBoundary.state:''
      });
      if(result.ok){nativeApprovalEntered=true;if(finalConfirmationStatus)finalConfirmationStatus.textContent='FINAL_RESTORE_CONFIRMATION recorded for this plan. The native approval step is now available; no approval has been issued.'}
      else if(finalConfirmationStatus)finalConfirmationStatus.textContent='Final confirmation is incomplete or does not match the displayed plan.';
      render(result);
    });
    [approvalPlanId,approvalPlanHash,approvalConfirmation,approvalUnderstands].forEach(function(input){if(input)input.addEventListener('input',function(){updateApprovalGate(machine.view())});if(input&&input.type==='checkbox')input.addEventListener('change',function(){updateApprovalGate(machine.view())})});
    if(issueApprovalButton)issueApprovalButton.addEventListener('click',async function(){
      var out=await machine.approve({planId:approvalPlanId.value,planHash:approvalPlanHash.value,confirmation:approvalConfirmation.value});
      render(out);
    });
    if(executeButton)executeButton.addEventListener('click',async function(){render(await machine.apply())});
    render();
    return machine;
  }

  return Object.freeze({STATES:STATES,APPROVAL_TEXT:APPROVAL_TEXT,FINAL_RESTORE_CONFIRMATION:FINAL_RESTORE_CONFIRMATION,PREVIEW_DOMAIN_ORDER:PREVIEW_DOMAIN_ORDER,MAX_VISIBLE_DIAGNOSTICS:MAX_VISIBLE_DIAGNOSTICS,approvalDenialReason:approvalDenialReason,approvalDiagnosticCode:approvalDiagnosticCode,approvalDenialStage:approvalDenialStage,validateSourceFile:validateSourceFile,buildRecoveryPreviewModel:buildRecoveryPreviewModel,diagnosticsEvidence:diagnosticsEvidence,formatDiagnostics:formatDiagnostics,createStateMachine:createStateMachine,mount:mount});
});
