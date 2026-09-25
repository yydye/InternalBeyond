/* P32-W.5-R3-B.3-P5.6 · pinned composite recovery package builder.
 * Reads only three explicitly selected source files, projects credentials out,
 * and returns an immutable in-memory plan. It has no storage or network access. */
(function(root,factory){
  'use strict';
  var common=typeof module==='object'&&module.exports;
  var api=factory(common&&typeof require==='function'?require('./recovery-engine.js'):(root.IBRecoveryEngine||null),root,common);
  if(common)module.exports=Object.freeze(Object.assign({},api.publicApi,{testOnly:api.testOnly}));
  else root.IBCompositeRecoveryPlan=api.publicApi;
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(engine,root,commonJs){
  'use strict';

  var SCHEMA='internalbeyond.p32-w5.r3b.composite-recovery-plan';
  var VERSION=1;
  var P5_5_PLAN_ID='p32-w5-r3b3-p5.5:f99b6f236ecd78d3c111d106';
  var P5_5_PLAN_SHA256='f99b6f236ecd78d3c111d106d3c1714b9790f65f09c34937de62ba21a9aea117';
  var P5_5_ARTIFACT_SHA256='5b8431c9899a820ceaf4e3e5533110aac9fca7542fa2d6f5380991f4b89e22a4';
  var P5_6_2_REVISION_ID='p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca';
  var P5_6_2_REVISION_SHA256='f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7';
  var P5_6_2_HIBIT_BACKUP_SHA256='8fb1f17a8b99028774d2decbb13aa3779c4df2c793c190017fdbc632dfc3db82';
  var P5_6_2_HIBIT_REPORT_SHA256='517c663692de479b76fb2fc06b777022af2c8d227b6a1109e3fbd7e2eee1b876';
  var P5_6_2_ROLE_REPORT_SHA256='02203167deef66b374d77a7945a4199d6870094e54f89ab3b92a236d4adb4c43';
  var OLD_ROLE_ID='friend_1785260690497';
  var NEW_ROLE_ID='friend_1788318367937_tcmw0p';
  var MEMORY_ID='mem_msgemsdp_l4lj76';
  var MEMORY_RECORD_SHA256='ba4bdf6303e815cb2e23191f1f2b988020a77a294760c03f4f0cac5eb5037d9d';
  var CREDENTIAL_POLICY='apiConfigs-positive-allowlist-v1; secret values excluded; NEEDS_REBIND';
  var DOMAIN_ORDER=engine&&engine.DOMAIN_ORDER||[];
  var SECRET_NAME=/(?:api.?key|imagegen.?apikey|secret|token|authorization|password|credential.?ref|vault|ciphertext)/i;
  var issuedPackages=typeof WeakSet==='function'?new WeakSet():null;

  var SOURCE_SPECS=Object.freeze({
    primary:Object.freeze({kind:'primary',fileName:'InternalBeyond_auto_2026-09-02.json',size:45062434,sha256:'1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401',exportVersion:8,exportDate:'2026-09-02T03:07:15.995Z',counts:Object.freeze({apiConfigs:12,chatMessages:341,chatThreads:2,groups:7,memories:3,autoMemory:3,diary_entries:13,moments:155,roleLetters:1})}),
    role:Object.freeze({kind:'supplemental-role',fileName:'IB_backup_2026-09-03.json',size:44861782,sha256:'37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d',exportVersion:8,exportDate:'2026-09-03T00:01:36.224Z',apiConfigsCount:13}),
    memory:Object.freeze({kind:'supplemental-memory',fileName:'InternalBeyond_auto_2026-08-27.json',size:6263200,sha256:'5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84',exportVersion:8,exportDate:'2026-08-27T00:00:10.299Z',memoriesCount:4,memoryId:MEMORY_ID,recordSha256:MEMORY_RECORD_SHA256})
  });
  var REFERENCE_FIELDS=Object.freeze([
    'chatMessages.friendId','chatThreads.friendId','groups.members[].characterId',
    'memories.characterId','autoMemory.friendId','diary_entries.characterId',
    'moments.roleId','moments.characterId','roleLetters.fromRoleId','roleLetters.toRoleId'
  ]);
  var EXPECTED_MAPPING_COUNTS=Object.freeze({
    'chatMessages.friendId':6,'chatThreads.friendId':0,'groups.members[].characterId':0,
    'memories.characterId':1,'autoMemory.friendId':0,'diary_entries.characterId':1,
    'moments.roleId':18,'moments.characterId':0,'roleLetters.fromRoleId':0,'roleLetters.toRoleId':0
  });

  function isObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value)}
  function clone(value){return JSON.parse(JSON.stringify(value))}
  function own(value,key){return Object.prototype.hasOwnProperty.call(value,key)}
  function stableValue(value){
    if(Array.isArray(value))return value.map(stableValue);
    if(!isObject(value))return value;
    var result={};Object.keys(value).sort().forEach(function(key){result[key]=stableValue(value[key])});return result;
  }
  function stableJson(value){return JSON.stringify(stableValue(value))}
  function hex(bytes){return Array.from(new Uint8Array(bytes)).map(function(byte){return byte.toString(16).padStart(2,'0')}).join('')}
  async function digestBytes(bytes){
    if(!root.crypto||!root.crypto.subtle)throw new Error('composite-hash-unavailable');
    return hex(await root.crypto.subtle.digest('SHA-256',bytes));
  }
  async function digestText(value){return digestBytes(new TextEncoder().encode(String(value)))}
  async function stableHash(value){return digestText(stableJson(value))}
  function authorityRevisionPayload(traceDigest){
    return{
      schema:'internalbeyond.p32-w5.r3b.composite-recovery-authority-revision',version:1,
      phase:'P32-W.5-R3-B.3-P5.6.2',revision:2,
      supersedes:{planId:P5_5_PLAN_ID,planSha256:P5_5_PLAN_SHA256,artifactSha256:P5_5_ARTIFACT_SHA256},
      authority:{
        previous:'USER_ASSERTED',current:'USER_CONFIRMED_IDENTITY_SUCCESSION',status:'EXPLICIT_USER_CONFIRMATION',
        confirmationSource:'current user instruction in P32-W.5-R3-B.3-P5.6.2',
        identitySuccession:{oldId:OLD_ROLE_ID,newId:NEW_ROLE_ID},
        mappingReferenceFields:['chatMessages.friendId','diary_entries.characterId','moments.roleId','memories.characterId']
      },
      sources:{
        primary:{fileName:SOURCE_SPECS.primary.fileName,sizeBytes:SOURCE_SPECS.primary.size,sha256:SOURCE_SPECS.primary.sha256},
        supplementalRole:{fileName:SOURCE_SPECS.role.fileName,sizeBytes:SOURCE_SPECS.role.size,sha256:SOURCE_SPECS.role.sha256},
        supplementalMemorySource:{fileName:SOURCE_SPECS.memory.fileName,sizeBytes:SOURCE_SPECS.memory.size,sha256:SOURCE_SPECS.memory.sha256},
        supplementalMemoryRecord:{id:MEMORY_ID,sha256:MEMORY_RECORD_SHA256}
      },
      provenance:{recordCount:539,traceSha256:traceDigest},
      selectedDomains:DOMAIN_ORDER.slice(),
      credentialPolicy:{credentialBearingFieldsImported:0,secretValuesProjected:0,postRestoreState:'NEEDS_REBIND'},
      priorIdentityEvidence:{
        hiBit:{backupSha256:P5_6_2_HIBIT_BACKUP_SHA256,reportSha256:P5_6_2_HIBIT_REPORT_SHA256,evidenceClass:'B_TEMPORAL_COEXISTENCE_ONLY',explicitTransitionFound:false},
        roleContinuity:{reportSha256:P5_6_2_ROLE_REPORT_SHA256,evidenceClass:'B_PARTIAL_ROLE_SIMILARITY',matchedMetadata:['nickname','relationship'],personaHashMatch:false,avatarMatch:false,stableIdentityFieldMatch:false}
      },
      schemaVersion:24,targetBinding:{status:'NOT_BOUND_UNTIL_READ_ONLY_PRODUCTION_DRY_RUN'}
    };
  }
  function deepFreeze(value){
    if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
    Object.keys(value).forEach(function(key){deepFreeze(value[key])});
    return Object.freeze(value);
  }
  function deeplyFrozen(value){
    if(!value||typeof value!=='object')return true;
    return Object.isFrozen(value)&&Object.keys(value).every(function(key){return deeplyFrozen(value[key])});
  }
  function containsSecretField(value){
    if(Array.isArray(value))return value.some(containsSecretField);
    if(!isObject(value))return false;
    return Object.keys(value).some(function(key){return SECRET_NAME.test(key)||containsSecretField(value[key])});
  }
  function countsFor(backup){
    var counts={};DOMAIN_ORDER.forEach(function(domain){counts[domain]=Array.isArray(backup&&backup[domain])?backup[domain].length:null});return counts;
  }
  function exactCounts(actual,expected){
    return Object.keys(expected).every(function(key){return Number(actual&&actual[key])===Number(expected[key])});
  }
  function alias(domain,index){return domain+'#'+String(index+1).padStart(6,'0')}
  function referenceTrace(primaryCounts,compositeCounts,roleAlias,memoryAlias){
    var trace=[];
    DOMAIN_ORDER.forEach(function(domain){
      for(var index=0;index<compositeCounts[domain];index++){
        var source='PRIMARY_2026_09_02',sourceAlias=alias(domain,index);
        if(domain==='apiConfigs'&&index>=primaryCounts[domain]){source='SUPPLEMENTAL_ROLE_2026_09_03';sourceAlias=roleAlias}
        else if(domain==='memories'&&index>=primaryCounts[domain]){source='SUPPLEMENTAL_MEMORY_2026_08_27';sourceAlias=memoryAlias}
        trace.push({domain:domain,compositeRecordAlias:alias(domain,index),source:source,sourceRecordAlias:sourceAlias});
      }
    });
    return trace;
  }
  function compressTrace(trace){
    var ranges=[];
    trace.forEach(function(item){
      var targetIndex=Number(item.compositeRecordAlias.split('#').pop()),sourceIndex=Number(item.sourceRecordAlias.split('#').pop()),last=ranges[ranges.length-1];
      if(last&&last.domain===item.domain&&last.source===item.source&&Number(last.compositeLastAlias.split('#').pop())+1===targetIndex&&Number(last.sourceLastAlias.split('#').pop())+1===sourceIndex){
        last.compositeLastAlias=item.compositeRecordAlias;last.sourceLastAlias=item.sourceRecordAlias;last.recordCount++;
      }else ranges.push({domain:item.domain,compositeFirstAlias:item.compositeRecordAlias,compositeLastAlias:item.compositeRecordAlias,source:item.source,sourceFirstAlias:item.sourceRecordAlias,sourceLastAlias:item.sourceRecordAlias,recordCount:1});
    });
    return ranges;
  }
  function applySuccession(backup){
    var changed={};REFERENCE_FIELDS.forEach(function(field){changed[field]=0});
    function rows(domain,field){(backup[domain]||[]).forEach(function(row){if(row&&row[field]===OLD_ROLE_ID){row[field]=NEW_ROLE_ID;changed[domain+'.'+field]++}})}
    rows('chatMessages','friendId');rows('chatThreads','friendId');rows('memories','characterId');rows('autoMemory','friendId');rows('diary_entries','characterId');rows('moments','roleId');rows('moments','characterId');rows('roleLetters','fromRoleId');rows('roleLetters','toRoleId');
    (backup.groups||[]).forEach(function(group){(group&&Array.isArray(group.members)?group.members:[]).forEach(function(member){if(member&&member.characterId===OLD_ROLE_ID){member.characterId=NEW_ROLE_ID;changed['groups.members[].characterId']++}})});
    return{changedByField:changed,total:Object.keys(changed).reduce(function(sum,key){return sum+changed[key]},0)};
  }
  async function readFile(file,spec){
    if(!file||typeof file.arrayBuffer!=='function')throw new Error('composite-source-file-required');
    if(String(file.name)!==spec.fileName)throw new Error('composite-source-filename-mismatch');
    if(Number(file.size)!==spec.size)throw new Error('composite-source-size-mismatch');
    var bytes=new Uint8Array(await file.arrayBuffer()),hash;
    try{
      hash=await digestBytes(bytes);
      if(hash!==spec.sha256)throw new Error('composite-source-sha256-mismatch');
      var backup=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(!isObject(backup)||Number(backup.version)!==spec.exportVersion||String(backup.exportDate||'')!==spec.exportDate)throw new Error('composite-source-schema-mismatch');
      return{backup:backup,sha256:hash,size:bytes.length,exportVersion:Number(backup.version),exportDate:String(backup.exportDate)};
    }catch(error){
      var message=String(error&&error.message||'');
      if(/composite-source-/.test(message))throw error;
      throw new Error('composite-source-json-invalid');
    }finally{bytes.fill(0)}
  }
  function fileMap(files){
    var list=Array.from(files||[]);
    if(list.length!==3)throw new Error('composite-source-count-invalid');
    var map=new Map();
    list.forEach(function(file){if(map.has(String(file.name)))throw new Error('composite-source-duplicate-filename');map.set(String(file.name),file)});
    var names=[SOURCE_SPECS.primary.fileName,SOURCE_SPECS.role.fileName,SOURCE_SPECS.memory.fileName];
    names.forEach(function(name){if(!map.has(name))throw new Error('composite-source-required-file-missing')});
    return map;
  }
  async function buildFromFiles(files){
    try{
      if(!engine)throw new Error('composite-recovery-engine-unavailable');
      var filesByName=fileMap(files);
      var primaryLoaded=await readFile(filesByName.get(SOURCE_SPECS.primary.fileName),SOURCE_SPECS.primary),primary=primaryLoaded.backup;
      if(!exactCounts(countsFor(primary),SOURCE_SPECS.primary.counts))throw new Error('composite-primary-count-mismatch');
      var roleLoaded=await readFile(filesByName.get(SOURCE_SPECS.role.fileName),SOURCE_SPECS.role),roleExport=roleLoaded.backup;
      if(!Array.isArray(roleExport.apiConfigs)||roleExport.apiConfigs.length!==SOURCE_SPECS.role.apiConfigsCount)throw new Error('composite-role-source-count-mismatch');
      var memoryLoaded=await readFile(filesByName.get(SOURCE_SPECS.memory.fileName),SOURCE_SPECS.memory),memoryExport=memoryLoaded.backup;
      if(!Array.isArray(memoryExport.memories)||memoryExport.memories.length!==SOURCE_SPECS.memory.memoriesCount)throw new Error('composite-memory-source-count-mismatch');
      var roleMatches=[];roleExport.apiConfigs.forEach(function(record,index){if(record&&record.id===NEW_ROLE_ID)roleMatches.push({record:record,index:index})});
      if(roleMatches.length!==1||roleMatches[0].index!==12)throw new Error('composite-supplemental-role-missing-or-ambiguous');
      var memoryMatches=[];memoryExport.memories.forEach(function(record,index){if(record&&record.id===MEMORY_ID)memoryMatches.push({record:record,index:index})});
      if(memoryMatches.length!==1||memoryMatches[0].index!==0)throw new Error('composite-supplemental-memory-missing-or-ambiguous');
      var projectedRole=engine.projectApiConfig(roleMatches[0].record);
      if(!projectedRole||projectedRole.ok!==true||projectedRole.credentialFieldsExcluded!==true)throw new Error('composite-role-projection-failed');
      var memoryRecord=clone(memoryMatches[0].record);
      if(memoryRecord.characterId!==OLD_ROLE_ID||engine.validateRecord('memories',memoryRecord))throw new Error('composite-memory-record-invalid');
      if(await stableHash(memoryRecord)!==MEMORY_RECORD_SHA256)throw new Error('composite-memory-record-hash-mismatch');
      roleLoaded.backup=null;memoryLoaded.backup=null;roleExport=null;memoryExport=null;roleMatches=null;memoryMatches=null;

      var primaryCopy=clone(primary),primaryCredentialBearing=0;
      primaryCopy.apiConfigs=primary.apiConfigs.map(function(record){
        var projection=engine.projectApiConfig(record);
        if(!projection||projection.ok!==true)throw new Error('composite-primary-role-projection-failed');
        if(projection.credentialFieldsExcluded)primaryCredentialBearing++;
        return projection.record;
      });
      for(var domain of DOMAIN_ORDER){if(domain==='apiConfigs')continue;if(containsSecretField(primaryCopy[domain]))throw new Error('composite-secret-field-outside-api-configs')}
      if(primaryCopy.apiConfigs.some(function(record){return record.id===NEW_ROLE_ID}))throw new Error('composite-role-already-in-primary');
      if(primaryCopy.memories.some(function(record){return record&&record.id===MEMORY_ID}))throw new Error('composite-memory-already-in-primary');
      var primaryCounts=countsFor(primary),beforeManifest={schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',version:1,source:{path:SOURCE_SPECS.primary.fileName,size:primaryLoaded.size,sha256:primaryLoaded.sha256,observedExportVersion:primaryLoaded.exportVersion},recordCounts:primaryCounts};
      var before=engine.buildPlan({manifest:beforeManifest,sourceVerification:{ok:true,size:primaryLoaded.size,sha256:primaryLoaded.sha256},backup:primaryCopy,selectedDomains:DOMAIN_ORDER,targetKeys:{},targetClass:'source-only',targetOrigin:'synthetic://source-only'});
      var beforeDangling=Number(before.plan.diagnostics.categoryCounts.DANGLING_REFERENCE)||0,beforeConflicts=Number(before.plan.diagnostics.categoryCounts.DOMAIN_CONFLICT)||0,beforeBlockers=before.plan.diagnostics.blockerCount;
      if(beforeDangling!==26||beforeConflicts!==3||beforeBlockers!==29)throw new Error('composite-baseline-planner-not-reproduced');
      before=null;primaryLoaded.backup=null;primary=null;
      primaryCopy.apiConfigs.push(projectedRole.record);
      primaryCopy.memories.push(clone(memoryRecord));
      var succession=applySuccession(primaryCopy);
      if(succession.total!==26||Object.keys(EXPECTED_MAPPING_COUNTS).some(function(field){return succession.changedByField[field]!==EXPECTED_MAPPING_COUNTS[field]}))throw new Error('composite-identity-succession-count-mismatch');

      var compositeCounts=countsFor(primaryCopy);
      var trace=referenceTrace(primaryCounts,compositeCounts,'apiConfigs#000013','memories#000001');
      var traceDigest=await stableHash(trace),ranges=compressTrace(trace);
      var identityData={
        primarySourceSha256:primaryLoaded.sha256,
        supplementalRoleSourceSha256:roleLoaded.sha256,
        supplementalMemorySourceSha256:memoryLoaded.sha256,
        supplementalMemoryId:MEMORY_ID,
        supplementalMemoryRecordSha256:MEMORY_RECORD_SHA256,
        oldRoleId:OLD_ROLE_ID,
        newRoleId:NEW_ROLE_ID,
        mappingAuthority:'USER_ASSERTED',
        mappingStatus:'EXPLICIT_USER_ASSERTION',
        selectedDomains:DOMAIN_ORDER.slice(),
        schemaVersion:24,
        credentialFirewallPolicy:CREDENTIAL_POLICY,
        provenanceDigest:traceDigest,
        afterBlockerCount:0
      };
      var identityHash=await stableHash(identityData);
      if(identityHash!==P5_5_PLAN_SHA256||'p32-w5-r3b3-p5.5:'+identityHash.slice(0,24)!==P5_5_PLAN_ID)throw new Error('composite-frozen-plan-identity-mismatch');
      var authorityData=authorityRevisionPayload(traceDigest),authorityHash=await stableHash(authorityData);
      if(authorityHash!==P5_6_2_REVISION_SHA256||'p32-w5-r3b3-p5.6.2:'+authorityHash.slice(0,24)!==P5_6_2_REVISION_ID)throw new Error('composite-authority-revision-identity-mismatch');
      var authorityRevision=clone(authorityData);
      authorityRevision.identity={planId:P5_6_2_REVISION_ID,planSha256:P5_6_2_REVISION_SHA256,identityBasis:'SOURCE_BOUND_AUTHORITY_REVISION_NOT_PRODUCTION_BOUND'};
      authorityRevision.validation={sourceHashesReverified:true,provenancePreserved:true,priorEvidencePreserved:true,oldFrozenPlanModified:false,productionTargetValidated:false,productionBoundPlanId:null,productionBoundPlanSha256:null,applyEnabled:false};

      var manifest={schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',version:1,source:clone(beforeManifest.source),recordCounts:compositeCounts,dbContractReference:{databaseName:'InternalBeyondDB',schemaVersion:24},compositePlanIdentity:{id:P5_5_PLAN_ID,sha256:P5_5_PLAN_SHA256},authorityRevisionIdentity:{id:P5_6_2_REVISION_ID,sha256:P5_6_2_REVISION_SHA256}};
      var after=engine.buildPlan({manifest:manifest,sourceVerification:{ok:true,size:primaryLoaded.size,sha256:primaryLoaded.sha256},backup:primaryCopy,selectedDomains:DOMAIN_ORDER,targetKeys:{},targetClass:'source-only',targetOrigin:'synthetic://source-only'});
      var afterReady=after.plan.status==='READY_FOR_EXPLICIT_RESTORE_APPROVAL'&&after.plan.diagnostics.blockerCount===0;
      after=null;
      if(!afterReady)throw new Error('composite-source-only-planner-not-ready');

      var packagePlan={
        schema:SCHEMA,version:VERSION,phase:'P32-W.5-R3-B.3-P5.6.2',
        primarySource:{kind:'primary',fileName:SOURCE_SPECS.primary.fileName,size:primaryLoaded.size,sha256:primaryLoaded.sha256,exportVersion:primaryLoaded.exportVersion,exportDate:primaryLoaded.exportDate,counts:primaryCounts},
        supplementalSources:[
          {kind:'role-metadata',fileName:SOURCE_SPECS.role.fileName,size:roleLoaded.size,sha256:roleLoaded.sha256,exportVersion:roleLoaded.exportVersion,exportDate:roleLoaded.exportDate,domain:'apiConfigs',sourceRecordAlias:'apiConfigs#000013',recordId:NEW_ROLE_ID,recordCount:1,credentialFieldsExcluded:true},
          {kind:'memory',fileName:SOURCE_SPECS.memory.fileName,size:memoryLoaded.size,sha256:memoryLoaded.sha256,exportVersion:memoryLoaded.exportVersion,exportDate:memoryLoaded.exportDate,domain:'memories',sourceRecordAlias:'memories#000001',stableId:MEMORY_ID,recordSha256:MEMORY_RECORD_SHA256,recordCount:1}
        ],
        identitySuccession:[{oldId:OLD_ROLE_ID,newId:NEW_ROLE_ID,authority:'USER_CONFIRMED_IDENTITY_SUCCESSION',status:'EXPLICIT_USER_CONFIRMATION',systemConfirmed:false}],
        authorityRevision:authorityRevision,
        selectedDomains:DOMAIN_ORDER.slice(),credentialPolicy:{id:CREDENTIAL_POLICY,credentialBearingFieldsImported:0,secretValuesProjected:0,postRestoreState:'NEEDS_REBIND'},
        provenance:{recordCount:trace.length,traceDigest:traceDigest,ranges:ranges},
        planIdentity:{id:P5_5_PLAN_ID,sha256:P5_5_PLAN_SHA256,artifactSha256:P5_5_ARTIFACT_SHA256},
        schemaContract:{databaseName:'InternalBeyondDB',schemaVersion:24},
        sourceOnlyDryRun:{baselineDanglingReferences:26,baselineDomainConflicts:3,afterDanglingReferences:0,afterDomainConflicts:0,otherBlockers:0},
        summary:{domainCounts:compositeCounts,referenceUpdatesByField:succession.changedByField,totalReferenceUpdates:succession.total,credentialBearingRecordsDetectedAndStripped:primaryCredentialBearing+1,apiConfigsStatus:'NEEDS_REBIND'},
        manifest:manifest,backup:primaryCopy
      };
      deepFreeze(packagePlan);
      if(issuedPackages)issuedPackages.add(packagePlan);
      return{ok:true,packagePlan:packagePlan,summary:{primarySource:packagePlan.primarySource,supplementalSources:packagePlan.supplementalSources,identitySuccession:packagePlan.identitySuccession,authorityRevision:packagePlan.authorityRevision,selectedDomains:packagePlan.selectedDomains,planIdentity:packagePlan.planIdentity,summary:packagePlan.summary,provenance:{recordCount:trace.length,traceDigest:traceDigest,ranges:ranges}}};
    }catch(error){
      var code=String(error&&error.message||'composite-package-validation-failed');
      if(!/^composite-[a-z0-9-]+$/.test(code))code='composite-package-validation-failed';
      return{ok:false,error:code};
    }
  }
  async function validate(packagePlan){
    if(!packagePlan||!issuedPackages||!issuedPackages.has(packagePlan)||!deeplyFrozen(packagePlan))return{ok:false,error:'composite-package-not-issued-or-not-frozen'};
    if(packagePlan.schema!==SCHEMA||packagePlan.version!==VERSION||!['P32-W.5-R3-B.3-P5.5','P32-W.5-R3-B.3-P5.6.2'].includes(packagePlan.phase))return{ok:false,error:'composite-package-schema-invalid'};
    if(packagePlan.planIdentity.id!==P5_5_PLAN_ID||packagePlan.planIdentity.sha256!==P5_5_PLAN_SHA256||packagePlan.planIdentity.artifactSha256!==P5_5_ARTIFACT_SHA256)return{ok:false,error:'composite-frozen-plan-identity-mismatch'};
    var canonicalSelection=engine.canonicalizeDomains(packagePlan.selectedDomains);
    if(!canonicalSelection.ok)return{ok:false,error:'composite-domain-selection-invalid'};
    if(!exactCounts(countsFor(packagePlan.backup),{apiConfigs:13,chatMessages:341,chatThreads:2,groups:7,memories:4,autoMemory:3,diary_entries:13,moments:155,roleLetters:1}))return{ok:false,error:'composite-domain-count-mismatch'};
    if(containsSecretField(packagePlan.backup.apiConfigs)||packagePlan.backup.apiConfigs.some(function(record){return !record||record.id===undefined}))return{ok:false,error:'composite-credential-firewall-failed'};
    if(!Array.isArray(packagePlan.identitySuccession)||packagePlan.identitySuccession.length!==1||packagePlan.identitySuccession[0].oldId!==OLD_ROLE_ID||packagePlan.identitySuccession[0].newId!==NEW_ROLE_ID)return{ok:false,error:'composite-identity-succession-invalid'};
    var succession=packagePlan.identitySuccession[0],legacyAuthority=packagePlan.phase==='P32-W.5-R3-B.3-P5.5'&&succession.authority==='USER_ASSERTED'&&succession.status==='EXPLICIT_USER_ASSERTION';
    var confirmedAuthority=packagePlan.phase==='P32-W.5-R3-B.3-P5.6.2'&&succession.authority==='USER_CONFIRMED_IDENTITY_SUCCESSION'&&succession.status==='EXPLICIT_USER_CONFIRMATION';
    if(!legacyAuthority&&!confirmedAuthority)return{ok:false,error:'composite-identity-succession-invalid'};
    if(packagePlan.supplementalSources.length!==2||!packagePlan.provenance||packagePlan.provenance.recordCount!==539||!Array.isArray(packagePlan.provenance.ranges)||!packagePlan.provenance.ranges.length)return{ok:false,error:'composite-provenance-or-source-missing'};
    var digest=await stableHash(packagePlan.provenance.ranges?referenceTrace(packagePlan.primarySource.counts,countsFor(packagePlan.backup),'apiConfigs#000013','memories#000001'):[]);
    if(digest!==packagePlan.provenance.traceDigest)return{ok:false,error:'composite-provenance-digest-mismatch'};
    var identityData={primarySourceSha256:packagePlan.primarySource.sha256,supplementalRoleSourceSha256:packagePlan.supplementalSources[0].sha256,supplementalMemorySourceSha256:packagePlan.supplementalSources[1].sha256,supplementalMemoryId:MEMORY_ID,supplementalMemoryRecordSha256:MEMORY_RECORD_SHA256,oldRoleId:OLD_ROLE_ID,newRoleId:NEW_ROLE_ID,mappingAuthority:'USER_ASSERTED',mappingStatus:'EXPLICIT_USER_ASSERTION',selectedDomains:DOMAIN_ORDER.slice(),schemaVersion:24,credentialFirewallPolicy:CREDENTIAL_POLICY,provenanceDigest:digest,afterBlockerCount:0};
    if(await stableHash(identityData)!==P5_5_PLAN_SHA256)return{ok:false,error:'composite-plan-hash-mismatch'};
      if(confirmedAuthority){
      var revision=packagePlan.authorityRevision;
      if(!revision||!revision.identity||revision.identity.planId!==P5_6_2_REVISION_ID)return{ok:false,error:'composite-authority-revision-id-mismatch'};
      if(revision.identity.planSha256!==P5_6_2_REVISION_SHA256||revision.identity.identityBasis!=='SOURCE_BOUND_AUTHORITY_REVISION_NOT_PRODUCTION_BOUND')return{ok:false,error:'composite-authority-revision-hash-mismatch'};
      if(!revision.authority||revision.authority.current!=='USER_CONFIRMED_IDENTITY_SUCCESSION'||revision.authority.status!=='EXPLICIT_USER_CONFIRMATION'||!revision.authority.identitySuccession||revision.authority.identitySuccession.oldId!==OLD_ROLE_ID||revision.authority.identitySuccession.newId!==NEW_ROLE_ID)return{ok:false,error:'composite-authority-revision-confirmation-invalid'};
      if(!revision.validation||revision.validation.oldFrozenPlanModified!==false||revision.validation.applyEnabled!==false||revision.validation.productionTargetValidated!==false)return{ok:false,error:'composite-authority-revision-safety-invalid'};
      var revisionPayload=clone(revision);delete revisionPayload.identity;delete revisionPayload.validation;
      if(stableJson(revisionPayload)!==stableJson(authorityRevisionPayload(digest))||await stableHash(revisionPayload)!==P5_6_2_REVISION_SHA256)return{ok:false,error:'composite-authority-revision-payload-mismatch'};
      if(!packagePlan.manifest.authorityRevisionIdentity||packagePlan.manifest.authorityRevisionIdentity.id!==P5_6_2_REVISION_ID||packagePlan.manifest.authorityRevisionIdentity.sha256!==P5_6_2_REVISION_SHA256)return{ok:false,error:'composite-authority-revision-manifest-mismatch'};
    }else if(packagePlan.phase==='P32-W.5-R3-B.3-P5.5'&&packagePlan.authorityRevision)return{ok:false,error:'legacy-plan-authority-must-remain-frozen'};
    return{ok:true,planId:P5_5_PLAN_ID,planHash:P5_5_PLAN_SHA256};
  }

  function createSyntheticPackage(spec){
    if(!commonJs)throw new Error('test-only-api-unavailable');
    spec=spec||{};
    var backup=spec.backup||{version:8,apiConfigs:[],chatMessages:[],chatThreads:[],groups:[],memories:[],autoMemory:[],diary_entries:[],moments:[],roleLetters:[]};
    var counts=countsFor(backup),source={path:SOURCE_SPECS.primary.fileName,size:SOURCE_SPECS.primary.size,sha256:SOURCE_SPECS.primary.sha256,observedExportVersion:8};
    var pkg={schema:SCHEMA,version:VERSION,phase:'synthetic',primarySource:{kind:'primary',fileName:SOURCE_SPECS.primary.fileName,size:SOURCE_SPECS.primary.size,sha256:SOURCE_SPECS.primary.sha256,exportVersion:8,counts:counts},supplementalSources:[{kind:'role-metadata',fileName:SOURCE_SPECS.role.fileName,size:SOURCE_SPECS.role.size,sha256:SOURCE_SPECS.role.sha256,exportVersion:8,domain:'apiConfigs',recordId:NEW_ROLE_ID,recordCount:1,credentialFieldsExcluded:true},{kind:'memory',fileName:SOURCE_SPECS.memory.fileName,size:SOURCE_SPECS.memory.size,sha256:SOURCE_SPECS.memory.sha256,exportVersion:8,domain:'memories',stableId:MEMORY_ID,recordSha256:MEMORY_RECORD_SHA256,recordCount:1}],identitySuccession:[{oldId:OLD_ROLE_ID,newId:NEW_ROLE_ID,authority:'USER_ASSERTED',status:'EXPLICIT_USER_ASSERTION',systemConfirmed:false}],selectedDomains:DOMAIN_ORDER.slice(),credentialPolicy:{id:CREDENTIAL_POLICY,credentialBearingFieldsImported:0,secretValuesProjected:0,postRestoreState:'NEEDS_REBIND'},provenance:{recordCount:539,traceDigest:'e'.repeat(64),ranges:[{domain:'apiConfigs',recordCount:13}]},planIdentity:{id:P5_5_PLAN_ID,sha256:P5_5_PLAN_SHA256,artifactSha256:P5_5_ARTIFACT_SHA256},schemaContract:{databaseName:'InternalBeyondDB',schemaVersion:24},manifest:{schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',version:1,source:source,recordCounts:counts},summary:{domainCounts:counts},backup:backup};
    deepFreeze(pkg);if(issuedPackages)issuedPackages.add(pkg);return pkg;
  }
  function validateSyntheticPackage(pkg){
    return !!(commonJs&&pkg&&issuedPackages&&issuedPackages.has(pkg)&&deeplyFrozen(pkg)&&pkg.schema===SCHEMA&&pkg.supplementalSources&&pkg.supplementalSources.length===2&&pkg.identitySuccession&&pkg.identitySuccession.length===1&&pkg.provenance&&pkg.provenance.recordCount>0&&pkg.planIdentity&&/^[a-f0-9]{64}$/.test(pkg.planIdentity.sha256));
  }

  var publicApi=Object.freeze({SCHEMA:SCHEMA,VERSION:VERSION,PLAN_ID:P5_5_PLAN_ID,PLAN_SHA256:P5_5_PLAN_SHA256,PLAN_ARTIFACT_SHA256:P5_5_ARTIFACT_SHA256,AUTHORITY_REVISION_ID:P5_6_2_REVISION_ID,AUTHORITY_REVISION_SHA256:P5_6_2_REVISION_SHA256,DOMAIN_ORDER:Object.freeze(DOMAIN_ORDER.slice()),SOURCE_SPECS:SOURCE_SPECS,buildFromFiles:buildFromFiles,validate:validate});
  var testOnly=Object.freeze({createSyntheticPackage:createSyntheticPackage,validateSyntheticPackage:validateSyntheticPackage,stableJson:stableJson,stableHash:stableHash,authorityRevisionPayload:authorityRevisionPayload,applySuccession:applySuccession,REFERENCE_FIELDS:REFERENCE_FIELDS});
  return{publicApi:publicApi,testOnly:testOnly};
});
