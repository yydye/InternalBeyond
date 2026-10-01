/* P32-W.5 · Production Recovery Adapter.
 * Production reads are pinned to the installed Tauri origin and an already
 * initialized v24 database. Global apply stays disabled; an exact native-issued
 * approval can open one RecoveryOnly-scoped window for the frozen plan only. */
(function(root,factory){
  'use strict';
  var common=typeof module==='object'&&module.exports;
  var nodeCrypto=common&&typeof require==='function'?require('crypto'):null;
  var api=factory(
    common&&typeof require==='function'?require('./webcore-db-schema.js'):(root.IBWebCoreDbSchema||null),
    common&&typeof require==='function'?require('./recovery-engine.js'):(root.IBRecoveryEngine||null),
    common&&typeof require==='function'?require('./composite-recovery-plan.js'):(root.IBCompositeRecoveryPlan||null),
    root,nodeCrypto,common
  );
  if(common)module.exports=Object.freeze(Object.assign({},api.publicApi,{testOnly:api.testOnly}));
  else root.IBProductionRecoveryAdapter=api.publicApi;
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(schema,engine,compositePlanApi,root,nodeCrypto,commonJs){
  'use strict';

  var PRODUCTION_APPLY_ENABLED=false;
  var APPROVAL_PHRASE='执行 R3-B.3 production restore';
  var PRODUCTION_APPROVAL_KIND='EXPLICIT_PRODUCTION_RESTORE_APPROVAL';
  var SYNTHETIC_APPROVAL_KIND='SYNTHETIC_TEST_APPROVAL';
  var APPROVED_SOURCE_SHA256='1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401';
  var APPROVED_SOURCE_SIZE=45062434;
  var APPROVED_EXPORT_VERSION=8;
  var APPROVED_DOMAIN_COUNTS=Object.freeze({apiConfigs:13,chatMessages:341,chatThreads:2,groups:7,memories:4,autoMemory:3,diary_entries:13,moments:155,roleLetters:1});
  var APPROVED_COMPOSITE_PLAN_ID='p32-w5-r3b3-p5.5:f99b6f236ecd78d3c111d106';
  var APPROVED_COMPOSITE_PLAN_SHA256='f99b6f236ecd78d3c111d106d3c1714b9790f65f09c34937de62ba21a9aea117';
  var APPROVED_COMPOSITE_ARTIFACT_SHA256='5b8431c9899a820ceaf4e3e5533110aac9fca7542fa2d6f5380991f4b89e22a4';
  var APPROVED_AUTHORITY_REVISION_ID='p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca';
  var APPROVED_AUTHORITY_REVISION_SHA256='f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7';
  var APPROVED_ROLE_SOURCE_SHA256='37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d';
  var APPROVED_MEMORY_SOURCE_SHA256='5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84';
  var TARGET_ORIGIN_RE=/^https?:\/\/tauri\.localhost(?::\d+)?$/i;
  var SECRET_FIELD_RE=/(?:api.?key|imagegen.?apikey|secret|token|authorization|password|credential.?ref|vault|ciphertext)/i;
  var DOMAIN_STORES=engine&&engine.STORE_BY_DOMAIN||{};
  var TARGET_SNAPSHOT_MANIFEST_SCHEMA='internalbeyond.target-snapshot-manifest';
  var TARGET_SNAPSHOT_MANIFEST_VERSION=1;
  var SNAPSHOT_METADATA_FIELDS=Object.freeze({
    chatMessages:Object.freeze(['role','friendId','threadId']),
    chatThreads:Object.freeze(['friendId']),
    memories:Object.freeze(['characterId']),
    autoMemory:Object.freeze(['friendId']),
    diary_entries:Object.freeze(['characterId']),
    moments:Object.freeze(['roleId','characterId']),
    roleLetters:Object.freeze(['fromRoleId','toRoleId','parentId'])
  });
  var issuedApprovals=new Map();
  var activeApplyPermit=null;

  function requestPromise(request){return new Promise(function(resolve,reject){request.onsuccess=function(){resolve(request.result)};request.onerror=function(){reject(request.error||new Error('indexeddb-request-failed'))}})}
  function transactionPromise(transaction){return new Promise(function(resolve,reject){transaction.oncomplete=function(){resolve()};transaction.onabort=function(){reject(transaction.error||new Error('indexeddb-transaction-aborted'))};transaction.onerror=function(){/* abort is the terminal result */}})}
  function sameStrings(left,right){var a=(left||[]).map(String).sort(),b=(right||[]).map(String).sort();return a.length===b.length&&a.every(function(value,index){return value===b[index]})}
  function canonicalDomains(domains){
    if(!engine||typeof engine.canonicalizeDomains!=='function')throw new Error('recovery-domain-canonicalizer-unavailable');
    var result=engine.canonicalizeDomains(domains);
    if(!result||result.ok!==true)throw new Error('recovery-domain-canonicalization-failed:'+String(result&&result.error||'invalid-domain-array'));
    return result.domains.slice();
  }
  function sameCanonicalDomains(left,right){
    if(!engine||typeof engine.canonicalizeDomains!=='function')return false;
    var a=engine.canonicalizeDomains(left),b=engine.canonicalizeDomains(right);
    return !!(a&&a.ok===true&&b&&b.ok===true&&sameStrings(a.domains,b.domains));
  }
  function hasValidDomainScope(domains){
    if(!engine||typeof engine.canonicalizeDomains!=='function')return false;
    var result=engine.canonicalizeDomains(domains);
    return !!(result&&result.ok===true);
  }
  function canonicalDomainRows(rows){
    if(!Array.isArray(rows))throw new Error('recovery-domain-rows-invalid');
    var byDomain=new Map();
    rows.forEach(function(row){
      if(!row||typeof row.domain!=='string'||byDomain.has(row.domain))throw new Error('recovery-domain-rows-invalid');
      byDomain.set(row.domain,row);
    });
    return canonicalDomains(rows.map(function(row){return row.domain})).map(function(domain){return byDomain.get(domain)});
  }
  function hasValidDomainRows(rows){
    try{return canonicalDomainRows(rows).length===rows.length}catch(error){return false}
  }
  function canonicalProvenanceRanges(ranges){
    if(!Array.isArray(ranges))throw new Error('recovery-provenance-ranges-invalid');
    var domains=canonicalDomains(engine.DOMAIN_ORDER),rank=new Map();
    domains.forEach(function(domain,index){rank.set(domain,index)});
    var decorated=ranges.map(function(range,index){
      if(!range||typeof range.domain!=='string'||!rank.has(range.domain))throw new Error('recovery-provenance-range-domain-invalid');
      return{range:range,index:index};
    });
    decorated.sort(function(left,right){return rank.get(left.range.domain)-rank.get(right.range.domain)||left.index-right.index});
    return decorated.map(function(item){return item.range});
  }
  function validAuthorityBinding(composite){
    if(!composite)return false;
    if(composite.identityAuthority==='USER_ASSERTED'&&composite.identityStatus==='EXPLICIT_USER_ASSERTION')return !composite.authorityRevisionId&&!composite.authorityRevisionSha256;
    return composite.identityAuthority==='USER_CONFIRMED_IDENTITY_SUCCESSION'&&composite.identityStatus==='EXPLICIT_USER_CONFIRMATION'&&composite.authorityRevisionId===APPROVED_AUTHORITY_REVISION_ID&&composite.authorityRevisionSha256===APPROVED_AUTHORITY_REVISION_SHA256;
  }
  function canonicalOrigin(value){
    try{
      var url=new URL(String(value||''));
      return TARGET_ORIGIN_RE.test(url.origin)&&!url.username&&!url.password&&(url.pathname===''||url.pathname==='/')&&!url.search&&!url.hash&&(!url.port||Number(url.port)>0&&Number(url.port)<=65535);
    }catch(error){return false}
  }
  function canonicalTargetIdentity(value){
    var parts=String(value||'').split('|');
    if(parts.length!==5||parts[0]!=='com.internalbeyond.desktop'||parts[1]!=='canonical-inno')return false;
    if(!/^[A-Za-z]:\\[^|]+$/.test(parts[2])||/(?:^|\\)(?:\.|\.\.)($|\\)/.test(parts[2]))return false;
    if(parts[2].split('\\').some(function(segment){return /^(?:tmp|temp|staging|forensic|workspace|internalbeyond-main)$/i.test(segment)}))return false;
    if(!/^\d+\.\d+\.\d+$/.test(parts[3])||! /^[a-f0-9]{64}$/i.test(parts[4]))return false;
    return true;
  }
  function stableValue(value){
    if(Array.isArray(value))return value.map(stableValue);
    if(value&&typeof value==='object'){
      var out={};Object.keys(value).sort().forEach(function(key){out[key]=stableValue(value[key])});return out;
    }
    return value;
  }
  function stableJson(value){return JSON.stringify(stableValue(value))}
  function safeMetadataScalar(value,field){
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='string'){
      if(value.length>4096)throw new Error('target-snapshot-metadata-field-too-large:'+String(field));
      return value;
    }
    if(typeof value==='number'&&Number.isFinite(value))return Object.is(value,-0)?0:value;
    throw new Error('target-snapshot-metadata-field-invalid:'+String(field));
  }
  function canonicalIdbKey(value){
    if(typeof value==='string')return{type:'string',value:value};
    if(typeof value==='number'&&Number.isFinite(value))return{type:'number',value:Object.is(value,-0)?0:value};
    if(value instanceof Date&&!Number.isNaN(value.getTime()))return{type:'date',value:value.toISOString()};
    if(Array.isArray(value))return{type:'array',value:value.map(canonicalIdbKey)};
    if(typeof ArrayBuffer!=='undefined'&&value instanceof ArrayBuffer)return{type:'binary',value:Array.from(new Uint8Array(value)).map(function(byte){return byte.toString(16).padStart(2,'0')}).join('')};
    if(typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView(value))return{type:'binary',value:Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)).map(function(byte){return byte.toString(16).padStart(2,'0')}).join('')};
    throw new Error('target-snapshot-key-type-unsupported');
  }
  function canonicalIdbKeyJson(value){return stableJson(canonicalIdbKey(value))}
  function endpointIdentity(value){
    if(typeof value!=='string')return{configured:false};
    try{
      var url=new URL(value);
      if(url.protocol!=='http:'&&url.protocol!=='https:')return{configured:true,kind:'unsupported-scheme'};
      return{configured:true,kind:'http-origin',origin:url.origin};
    }catch(error){return{configured:true,kind:'invalid-url'};}
  }
  function copyMetadataFields(record,fields){
    var out={};
    fields.forEach(function(field){if(Object.prototype.hasOwnProperty.call(record,field))out[field]=safeMetadataScalar(record[field],field)});
    return out;
  }
  function projectReference(value,field){
    if(value===null)return null;
    if(typeof value==='string'||typeof value==='number')return safeMetadataScalar(value,field);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('target-snapshot-reference-invalid:'+String(field));
    var out={},fields=['id','characterId','roleId','friendId'];
    fields.forEach(function(name){if(Object.prototype.hasOwnProperty.call(value,name))out[name]=safeMetadataScalar(value[name],field+'.'+name)});
    if(!Object.keys(out).length)throw new Error('target-snapshot-reference-identity-missing:'+String(field));
    return out;
  }
  function projectSnapshotRecord(storeName,record){
    if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('target-snapshot-record-invalid:'+String(storeName));
    if(storeName==='apiConfigs'){
      var api={},apiFields=['id','provider','model','imageGenProvider','imageGenModel','archived'];
      apiFields.forEach(function(field){if(Object.prototype.hasOwnProperty.call(record,field))api[field]=safeMetadataScalar(record[field],field)});
      if(Object.prototype.hasOwnProperty.call(record,'endpoint'))api.endpoint=endpointIdentity(record.endpoint);
      if(Object.prototype.hasOwnProperty.call(record,'imageGenEndpoint'))api.imageGenEndpoint=endpointIdentity(record.imageGenEndpoint);
      if(Object.prototype.hasOwnProperty.call(record,'voice')){
        var voice=record.voice;
        if(voice===null)api.voice=null;
        else if(!voice||typeof voice!=='object'||Array.isArray(voice))throw new Error('target-snapshot-voice-metadata-invalid');
        else api.voice=copyMetadataFields(voice,['enabled','provider','source','voiceId','model']);
      }
      return api;
    }
    if(storeName==='groups'){
      var group={};
      if(Object.prototype.hasOwnProperty.call(record,'members')){
        if(!Array.isArray(record.members))throw new Error('target-snapshot-group-members-invalid');
        group.members=record.members.map(function(member){return projectReference(member,'members')});
      }
      return group;
    }
    if(storeName==='diary_entries'){
      var diary=copyMetadataFields(record,SNAPSHOT_METADATA_FIELDS.diary_entries);
      if(Object.prototype.hasOwnProperty.call(record,'relatedMemoryIds')){
        if(!Array.isArray(record.relatedMemoryIds))throw new Error('target-snapshot-related-memory-ids-invalid');
        diary.relatedMemoryIds=record.relatedMemoryIds.map(function(value){return projectReference(value,'relatedMemoryIds')});
      }
      return diary;
    }
    var fields=SNAPSHOT_METADATA_FIELDS[storeName];
    if(!fields)throw new Error('target-snapshot-store-projection-unsupported:'+String(storeName));
    return copyMetadataFields(record,fields);
  }
  async function buildTargetSnapshotManifest(targetIdentity,targetOrigin,snapshot,recordEntriesByStore){
    if(typeof targetIdentity!=='string'||!targetIdentity||typeof targetOrigin!=='string'||!targetOrigin)throw new Error('target-snapshot-target-binding-missing');
    if(!snapshot||!snapshot.stores||typeof snapshot.databaseName!=='string'||!Number.isFinite(Number(snapshot.version)))throw new Error('target-snapshot-database-binding-invalid');
    recordEntriesByStore=recordEntriesByStore||{};
    var storeNames=Object.keys(snapshot.stores).sort(),stores=[],components=[];
    async function addRootComponent(name,value){components.push({name:name,sha256:await sha256Text(stableJson({name:name,value:value}))})}
    await addRootComponent('manifestSchema',TARGET_SNAPSHOT_MANIFEST_SCHEMA);
    await addRootComponent('manifestVersion',TARGET_SNAPSHOT_MANIFEST_VERSION);
    await addRootComponent('targetIdentity',targetIdentity);
    await addRootComponent('origin',targetOrigin);
    await addRootComponent('databaseName',snapshot.databaseName);
    await addRootComponent('schemaVersion',Number(snapshot.version));
    components.push({name:'storeList',sha256:await sha256Text(stableJson(storeNames))});
    for(var name of storeNames){
      var source=snapshot.stores[name],entries=(recordEntriesByStore[name]||[]).slice().sort(function(a,b){return a.keyCanonical<b.keyCanonical?-1:(a.keyCanonical>b.keyCanonical?1:0)});
      if(!source||!Number.isInteger(source.count)||source.count<0||entries.length!==source.count)throw new Error('target-snapshot-store-count-invalid:'+name);
      var canonicalKeys=entries.map(function(entry){return entry.keyCanonical}).sort();
      var recordProjection=entries.map(function(entry){return{key:entry.keyCanonical,metadata:entry.metadata}});
      var keySetSha256=await sha256Text(stableJson(canonicalKeys));
      var recordProjectionSha256=await sha256Text(stableJson(recordProjection));
      var countSha256=await sha256Text(stableJson({store:name,count:source.count}));
      var storeComponentSha256=await sha256Text(stableJson({name:name,count:source.count,keySetSha256:keySetSha256,recordProjectionSha256:recordProjectionSha256}));
      stores.push({name:name,count:source.count,keySetSha256:keySetSha256,recordProjectionSha256:recordProjectionSha256,componentSha256:storeComponentSha256});
      components.push({name:'store:'+name+':count',sha256:countSha256});
      components.push({name:'store:'+name+':keySet',sha256:keySetSha256});
      components.push({name:'store:'+name+':recordProjection',sha256:recordProjectionSha256});
      components.push({name:'store:'+name,sha256:storeComponentSha256});
    }
    var manifest={
      schema:TARGET_SNAPSHOT_MANIFEST_SCHEMA,version:TARGET_SNAPSHOT_MANIFEST_VERSION,
      targetIdentity:targetIdentity,origin:targetOrigin,databaseName:snapshot.databaseName,schemaVersion:Number(snapshot.version),
      stores:stores,components:components
    };
    manifest.aggregateSha256=await sha256Text(stableJson(manifest));
    return manifest;
  }
  async function sha256Text(value){
    var text=String(value);
    if(root.crypto&&root.crypto.subtle){var digest=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(digest)).map(function(byte){return byte.toString(16).padStart(2,'0')}).join('')}
    if(nodeCrypto)return nodeCrypto.createHash('sha256').update(text,'utf8').digest('hex');
    throw new Error('sha256-unavailable');
  }
  function defaultInvoke(){
    var tauri=root&&root.__TAURI__,invoke=tauri&&tauri.core&&tauri.core.invoke;
    if(typeof invoke!=='function')throw new Error('tauri-recovery-bridge-unavailable');
    return invoke.bind(tauri.core);
  }
  function productionPlanHash(plan){return String(plan&&plan.productionBinding&&plan.productionBinding.productionPlanHash||'').toLowerCase()}
  function approvalBindingForPlan(plan){
    var composite=plan.compositeBinding||{},production=plan.productionBinding||{};
    return{
      planId:String(plan.planId),planHash:productionPlanHash(plan),
      frozenPlanId:String(composite.frozenPlanId||''),frozenPlanHash:String(composite.frozenPlanSha256||'').toLowerCase(),
      frozenArtifactSha256:String(composite.frozenArtifactSha256||'').toLowerCase(),
      transactionId:String(plan.transactionId),
      sourceSha256:String(plan.source.sha256).toLowerCase(),sourceSize:Number(plan.source.size),exportVersion:Number(plan.source.exportVersion),
      supplementalRoleSourceSha256:String(composite.supplementalRoleSourceSha256||'').toLowerCase(),
      supplementalMemorySourceSha256:String(composite.supplementalMemorySourceSha256||'').toLowerCase(),
      authorityType:String(composite.identityAuthority||''),authorityStatus:String(composite.identityStatus||''),
      authorityRevisionId:String(composite.authorityRevisionId||''),authorityRevisionSha256:String(composite.authorityRevisionSha256||'').toLowerCase(),
      provenanceDigest:String(composite.provenanceDigest||'').toLowerCase(),provenanceRecordCount:Number(composite.provenanceRecordCount),
      targetSnapshotSha256:String(production.targetSnapshotSha256||'').toLowerCase(),
      executionPhase:String(plan.executionPhase),targetOrigin:String(plan.target.origin),targetIdentity:String(plan.target.identity),
      databaseName:String(plan.target.databaseName),schemaVersion:Number(plan.target.schemaVersion),selectedDomains:canonicalDomains(plan.selectedDomains)
    };
  }
  function defaultCheckpointStore(){
    return{
      read:async function(){return defaultInvoke()('read_recovery_checkpoint')},
      issue:async function(request){return defaultInvoke()('issue_recovery_restore_approval',{request:request})},
      openWindow:async function(approval,plan){return defaultInvoke()('open_recovery_apply_window',{request:{approval:approval,plan:approvalBindingForPlan(plan)}})},
      closeWindow:async function(approval){return defaultInvoke()('close_recovery_apply_window',{request:{planId:approval.planId,token:approval.token}})},
      save:async function(checkpoint,approval){return defaultInvoke()('write_recovery_checkpoint',{request:{checkpoint:checkpoint,approval:approval}})},
      abort:async function(approval,plan){return defaultInvoke()('abort_recovery_checkpoint_before_apply',{request:{approval:approval,plan:approvalBindingForPlan(plan)}})},
      markVerified:async function(planId){return defaultInvoke()('mark_recovery_checkpoint_verified',{request:{planId:planId}})},
      clear:async function(planId){return defaultInvoke()('clear_recovery_checkpoint_after_rollback',{request:{planId:planId,rollbackVerified:true}})}
    };
  }
  function randomToken(cryptoProvider){
    var provider=cryptoProvider||root.crypto;
    if(provider&&typeof provider.getRandomValues==='function'){
      var bytes=new Uint8Array(32);provider.getRandomValues(bytes);return Array.from(bytes).map(function(byte){return byte.toString(16).padStart(2,'0')}).join('');
    }
    if(nodeCrypto)return nodeCrypto.randomBytes(32).toString('hex');
    throw new Error('secure-random-unavailable');
  }
  function issueSyntheticTestApproval(confirmation,plan,options){
    if(String(confirmation||'')!==APPROVAL_PHRASE)throw new Error('explicit-restore-approval-required');
    if(!plan||plan.mode!=='dry-run'||plan.status!=='READY_FOR_EXPLICIT_RESTORE_APPROVAL'||plan.executionPhase!=='R3-B.3'||!plan.planId||!plan.transactionId||! /^[a-f0-9]{64}$/i.test(String(plan.planHash||''))||!plan.target||!canonicalTargetIdentity(plan.target.identity)||!canonicalOrigin(plan.target.origin)||Number(plan.target.schemaVersion)!==24||plan.target.databaseName!=='InternalBeyondDB'||String(plan.source&&plan.source.sha256||'').toLowerCase()!==APPROVED_SOURCE_SHA256||Number(plan.source&&plan.source.size)!==APPROVED_SOURCE_SIZE||Number(plan.source&&plan.source.exportVersion)!==APPROVED_EXPORT_VERSION||!sameCanonicalDomains(plan.selectedDomains,Object.keys(APPROVED_DOMAIN_COUNTS))||!plan.compositeBinding||plan.compositeBinding.frozenPlanId!==APPROVED_COMPOSITE_PLAN_ID||plan.compositeBinding.frozenPlanSha256!==APPROVED_COMPOSITE_PLAN_SHA256||!plan.productionBinding||! /^[a-f0-9]{64}$/i.test(String(plan.productionBinding.productionPlanHash||'')))throw new Error('restore-plan-not-ready');
    if(!planSummaryApplyReady(plan))throw new Error('restore-plan-preflight-not-passed');
    options=options||{};
    var token=randomToken(options.crypto),expiresAt=Date.now()+Math.min(Math.max(Number(options.ttlMs)||600000,1000),600000);
    var lifecycleId=randomToken(options.crypto).slice(0,32);
    var binding=approvalBindingForPlan(plan);
    var approval=Object.freeze({
      kind:SYNTHETIC_APPROVAL_KIND,confirmation:APPROVAL_PHRASE,token:token,lifecycleId:lifecycleId,
      planId:binding.planId,planHash:binding.planHash,frozenPlanId:binding.frozenPlanId,frozenPlanHash:binding.frozenPlanHash,
      frozenArtifactSha256:binding.frozenArtifactSha256,transactionId:binding.transactionId,
      sourceSha256:binding.sourceSha256,sourceSize:binding.sourceSize,exportVersion:binding.exportVersion,
      supplementalRoleSourceSha256:binding.supplementalRoleSourceSha256,supplementalMemorySourceSha256:binding.supplementalMemorySourceSha256,
      authorityType:binding.authorityType,authorityStatus:binding.authorityStatus,authorityRevisionId:binding.authorityRevisionId,
      authorityRevisionSha256:binding.authorityRevisionSha256,provenanceDigest:binding.provenanceDigest,
      provenanceRecordCount:binding.provenanceRecordCount,targetSnapshotSha256:binding.targetSnapshotSha256,
      executionPhase:binding.executionPhase,targetOrigin:binding.targetOrigin,targetIdentity:binding.targetIdentity,
      schemaVersion:binding.schemaVersion,databaseName:binding.databaseName,
      selectedDomains:Object.freeze(binding.selectedDomains.slice()),expiresAt:expiresAt
    });
    issuedApprovals.set(token,{approval:approval,consumed:false,synthetic:true});
    return approval;
  }
  function approvalMatches(approval,plan,consume){
    var expectedKind=commonJs&&approval&&approval.kind===SYNTHETIC_APPROVAL_KIND?SYNTHETIC_APPROVAL_KIND:PRODUCTION_APPROVAL_KIND;
    if(!approval||approval.kind!==expectedKind||approval.confirmation!==APPROVAL_PHRASE||!plan)return false;
    var record=issuedApprovals.get(String(approval.token||''));
    var active=activeApplyPermit===String(approval.token||'');
    if(!record||record.approval!==approval||(record.consumed&&!active)||Number(approval.expiresAt)<=Date.now()||!/^[a-f0-9]{32}$/i.test(String(approval.lifecycleId||'')))return false;
    var expected;
    try{expected=approvalBindingForPlan(plan)}catch(error){return false}
    if(plan.planId!=='r3b3:'+expected.planHash||plan.transactionId!=='r3b3-tx:'+expected.planHash||
      String(plan.planHash||'').toLowerCase()!==String(plan.compositeBinding&&plan.compositeBinding.frozenPlanSha256||'').toLowerCase())return false;
    if(String(approval.planId)!==expected.planId||String(approval.transactionId)!==expected.transactionId||String(approval.planHash).toLowerCase()!==expected.planHash)return false;
    for(var key of ['frozenPlanId','frozenPlanHash','frozenArtifactSha256','sourceSha256','supplementalRoleSourceSha256','supplementalMemorySourceSha256','authorityType','authorityStatus','authorityRevisionId','authorityRevisionSha256','provenanceDigest','provenanceRecordCount','targetSnapshotSha256','targetOrigin','targetIdentity','databaseName','schemaVersion','executionPhase']){
      if(String(approval[key]).toLowerCase()!==String(expected[key]).toLowerCase())return false;
    }
    if(Number(approval.sourceSize)!==expected.sourceSize||Number(approval.exportVersion)!==expected.exportVersion)return false;
    if(!sameCanonicalDomains(approval.selectedDomains,expected.selectedDomains))return false;
    if(consume)record.consumed=true;
    return true;
  }
  function validateApprovalRequest(prepared,request){
    var plan=prepared&&prepared.plan;
    if(!plan||!request||request.confirmation!==APPROVAL_PHRASE)return{ok:false,error:'explicit-restore-approval-required'};
    var binding;
    try{binding=approvalBindingForPlan(plan)}catch(error){return{ok:false,error:'restore-domain-selection-invalid'}}
    var typedId=String(request.planId||''),typedHash=String(request.planHash||'').toLowerCase();
    if(typedId!==binding.planId)return{ok:false,error:'approval-plan-id-mismatch'};
    if(typedHash!==binding.planHash)return{ok:false,error:'approval-plan-hash-mismatch'};
    if(!validatePrepared(prepared))return{ok:false,error:'restore-plan-not-ready'};
    return{ok:true,binding:binding};
  }
  function validatePrepared(prepared){
    var gateChecks=preparedGateDiagnostics(prepared);
    return Object.keys(gateChecks).every(function(key){return gateChecks[key]===true});
  }
  /* superseded inline validation expression; named checks above are authoritative
      composite&&composite.schema==='internalbeyond.p32-w5.r3b.composite-plan-binding'&&composite.frozenPlanId===APPROVED_COMPOSITE_PLAN_ID&&composite.frozenPlanSha256===APPROVED_COMPOSITE_PLAN_SHA256&&composite.frozenArtifactSha256===APPROVED_COMPOSITE_ARTIFACT_SHA256&&composite.supplementalRoleSourceSha256===APPROVED_ROLE_SOURCE_SHA256&&composite.supplementalMemorySourceSha256===APPROVED_MEMORY_SOURCE_SHA256&&composite.identityAuthority==='USER_ASSERTED'&&composite.provenanceRecordCount===539&&/^[a-f0-9]{64}$/i.test(String(composite.provenanceDigest||''))&&
      production&&production.schema==='internalbeyond.recovery-production-binding'&&production.targetIdentity===plan.target.identity&&production.targetOrigin===plan.target.origin&&/^[a-f0-9]{64}$/i.test(String(production.targetSnapshotSha256||''))&&/^[a-f0-9]{64}$/i.test(String(production.descriptorSha256||''))&&production.executionPlanHash===String(plan.planHash).toLowerCase()&&plan.planId==='r3b3:'+production.descriptorSha256&&plan.transactionId==='r3b3-tx:'+production.descriptorSha256);
  }
  */
  function preparedGateDiagnostics(prepared){
    var plan=prepared&&prepared.plan,composite=plan&&plan.compositeBinding,production=plan&&plan.productionBinding;
    return{
      mode:!!plan&&plan.mode==='dry-run',status:!!plan&&plan.status==='READY_FOR_EXPLICIT_RESTORE_APPROVAL',phase:!!plan&&plan.executionPhase==='R3-B.3',planHash:!!plan&&/^[a-f0-9]{64}$/i.test(String(plan.planHash||'')),transaction:!!plan&&typeof plan.transactionId==='string'&&plan.transactionId.length>=24,
      selectedDomains:!!plan&&hasValidDomainScope(plan.selectedDomains),domainRows:!!plan&&hasValidDomainRows(plan.domains),
      targetClass:!!plan&&!!plan.target&&plan.target.class==='production',targetIdentity:!!plan&&!!plan.target&&canonicalTargetIdentity(plan.target.identity),databaseName:!!plan&&!!plan.target&&plan.target.databaseName==='InternalBeyondDB',schemaVersion:!!plan&&!!plan.target&&Number(plan.target.schemaVersion)===24,targetOrigin:!!plan&&!!plan.target&&canonicalOrigin(plan.target.origin),
      targetSnapshot:!!(prepared&&prepared.targetSnapshot&&prepared.targetSnapshot.manifest&&plan&&plan.targetSnapshotManifest&&prepared.targetSnapshot.manifest.aggregateSha256===plan.targetSnapshotManifest.aggregateSha256),payload:!!(prepared&&prepared.payload),summary:planSummaryApplyReady(plan),compositeSchema:!!composite&&composite.schema==='internalbeyond.p32-w5.r3b3.composite-plan-binding',frozenPlanId:!!composite&&composite.frozenPlanId===APPROVED_COMPOSITE_PLAN_ID,
      frozenPlanSha256:!!composite&&composite.frozenPlanSha256===APPROVED_COMPOSITE_PLAN_SHA256,frozenArtifactSha256:!!composite&&composite.frozenArtifactSha256===APPROVED_COMPOSITE_ARTIFACT_SHA256,roleSourceSha256:!!composite&&composite.supplementalRoleSourceSha256===APPROVED_ROLE_SOURCE_SHA256,memorySourceSha256:!!composite&&composite.supplementalMemorySourceSha256===APPROVED_MEMORY_SOURCE_SHA256,
      identityAuthority:validAuthorityBinding(composite),authorityRevisionBound:validAuthorityBinding(composite),provenanceCount:!!composite&&composite.provenanceRecordCount===539,provenanceDigest:!!composite&&/^[a-f0-9]{64}$/i.test(String(composite.provenanceDigest||'')),productionSchema:!!production&&production.schema==='internalbeyond.recovery-production-binding',productionTargetIdentity:!!production&&!!plan&&production.targetIdentity===plan.target.identity,productionTargetOrigin:!!production&&!!plan&&production.targetOrigin===plan.target.origin,
      targetSnapshotSha256:!!production&&/^[a-f0-9]{64}$/i.test(String(production.targetSnapshotSha256||'')),descriptorSha256:!!production&&/^[a-f0-9]{64}$/i.test(String(production.descriptorSha256||'')),frozenPlanHash:!!plan&&plan.planHash===APPROVED_COMPOSITE_PLAN_SHA256,productionPlanHash:!!production&&/^[a-f0-9]{64}$/i.test(String(production.productionPlanHash||'')),productionPlanId:!!production&&!!plan&&production.id===plan.planId&&plan.planId==='r3b3:'+production.productionPlanHash,productionTransactionId:!!production&&!!plan&&plan.transactionId==='r3b3-tx:'+production.productionPlanHash
    };
  }
  function planSummaryApplyReady(plan){
    if(!plan||!plan.summary||!plan.credentialBoundary||String(plan.source&&plan.source.sha256||'').toLowerCase()!==APPROVED_SOURCE_SHA256||Number(plan.source&&plan.source.size)!==APPROVED_SOURCE_SIZE||Number(plan.source&&plan.source.exportVersion)!==APPROVED_EXPORT_VERSION)return false;
    if(!plan.compositeBinding||plan.compositeBinding.frozenPlanId!==APPROVED_COMPOSITE_PLAN_ID||plan.compositeBinding.frozenPlanSha256!==APPROVED_COMPOSITE_PLAN_SHA256||plan.compositeBinding.frozenArtifactSha256!==APPROVED_COMPOSITE_ARTIFACT_SHA256)return false;
    if(!sameCanonicalDomains(plan.selectedDomains,Object.keys(APPROVED_DOMAIN_COUNTS)))return false;
    if(Number(plan.summary.targetCollisions)!==0||Number(plan.summary.referenceConflicts)!==0||Number(plan.summary.sourceDuplicates)!==0||Number(plan.summary.rejectedRecords)!==0||Number(plan.credentialBoundary.secretValuesProjected)!==0||plan.credentialBoundary.credentialState!=='NEEDS_REBIND')return false;
    if(!Array.isArray(plan.domains)||plan.domains.length!==Object.keys(APPROVED_DOMAIN_COUNTS).length)return false;
    return plan.domains.every(function(item){var expected=APPROVED_DOMAIN_COUNTS[item.domain];return expected!=null&&item.action==='INSERT'&&Number(item.sourceCount)===expected&&Number(item.validCount)===expected&&Number(item.targetCollisionCount)===0&&Number(item.referenceConflictCount)===0&&Number(item.sourceDuplicateCount)===0&&Number(item.rejectedCount||0)===0});
  }
  function containsSecretField(value){
    if(Array.isArray(value))return value.some(containsSecretField);
    if(!value||typeof value!=='object')return false;
    return Object.keys(value).some(function(key){return SECRET_FIELD_RE.test(key)||containsSecretField(value[key])});
  }

  async function openExistingDatabase(indexedDBApi,dbSchema){
    if(!indexedDBApi||typeof indexedDBApi.databases!=='function')throw new Error('production-db-enumeration-required');
    var existing=await indexedDBApi.databases();
    if(!existing.some(function(item){return item&&item.name===dbSchema.DB_NAME}))throw new Error('production-db-not-initialized');
    return new Promise(function(resolve,reject){
      var request,settled=false;
      function fail(error){if(settled)return;settled=true;reject(error)}
      try{request=indexedDBApi.open(dbSchema.DB_NAME)}catch(error){fail(error);return}
      request.onupgradeneeded=function(event){try{event.target.transaction.abort()}catch(error){};fail(new Error('production-schema-migration-forbidden'))};
      request.onerror=function(){fail(request.error||new Error('production-db-open-failed'))};
      request.onsuccess=function(){
        if(settled){try{request.result.close()}catch(error){};return}
        settled=true;resolve(request.result);
      };
    });
  }

  async function snapshotDatabase(db,selectedDomains,targetIdentity,targetOrigin){
    var stores=(selectedDomains||[]).map(function(domain){return DOMAIN_STORES[domain]});
    if(!stores.length||stores.some(function(name){return!name}))throw new Error('restore-domain-selection-invalid');
    var transaction=db.transaction(stores,'readonly'),done=transactionPromise(transaction),snapshot={databaseName:db.name,version:db.version,stores:{}},recordEntriesByStore={};
    await Promise.all(stores.map(async function(name){
      var objectStore=transaction.objectStore(name),entries=await new Promise(function(resolve,reject){
        var collected=[],request;
        try{request=objectStore.openCursor()}catch(error){reject(error);return}
        request.onerror=function(){reject(request.error||new Error('indexeddb-cursor-failed'))};
        request.onsuccess=function(event){
          var cursor=event.target.result;
          if(!cursor){resolve(collected);return}
          try{
            var key=cursor.primaryKey;
            collected.push({key:key,keyCanonical:canonicalIdbKeyJson(key),metadata:projectSnapshotRecord(name,cursor.value)});
            cursor.continue();
          }catch(error){reject(error)}
        };
      });
      snapshot.stores[name]={count:entries.length,keys:entries.map(function(entry){return String(entry.key)}).sort()};
      recordEntriesByStore[name]=entries.map(function(entry){return{keyCanonical:entry.keyCanonical,metadata:entry.metadata}});
    }));
    await done;
    snapshot.manifest=await buildTargetSnapshotManifest(targetIdentity,targetOrigin,snapshot,recordEntriesByStore);
    return snapshot;
  }

  function validateSchema(db,dbSchema){
    var missing=dbSchema.STORE_NAMES.filter(function(name){return!db.objectStoreNames.contains(name)});
    if(db.name!==dbSchema.DB_NAME||db.version!==dbSchema.DB_VERSION||missing.length)throw new Error('production-schema-invalid');
  }

  async function plannedWriteManifest(prepared){
    var plan=prepared.plan,writes=[];
    for(var domain of canonicalDomains(plan.selectedDomains)){
      var store=DOMAIN_STORES[domain],rows=prepared.payload&&prepared.payload[domain]||[];
      if(!store)throw new Error('restore-domain-selection-invalid');
      for(var row of rows){
        if(containsSecretField(row))throw new Error('credential-bearing-record-blocked');
        writes.push({store:store,key:String(row.id),recordSha256:await sha256Text(stableJson(row))});
      }
    }
    return writes.sort(function(a,b){return a.store.localeCompare(b.store)||a.key.localeCompare(b.key)});
  }
  async function computePlanHash(prepared){
    if(!prepared||!prepared.plan||!prepared.targetSnapshot)throw new Error('production-snapshot-missing');
    var plan=Object.assign({},prepared.plan);delete plan.planHash;
    plan.selectedDomains=canonicalDomains(plan.selectedDomains);
    plan.domains=canonicalDomainRows(plan.domains);
    if(plan.compositeBinding&&Array.isArray(plan.compositeBinding.provenanceRanges)){
      plan.compositeBinding=Object.assign({},plan.compositeBinding);
      plan.compositeBinding.provenanceRanges=canonicalProvenanceRanges(plan.compositeBinding.provenanceRanges);
    }
    if(plan.productionBinding){
      plan.productionBinding=Object.assign({},plan.productionBinding);
      plan.planId='r3b3:'+plan.productionBinding.descriptorSha256;
      plan.transactionId='r3b3-tx:'+plan.productionBinding.descriptorSha256;
      plan.productionBinding.id=plan.planId;
      delete plan.productionBinding.productionPlanHash;
    }
    return sha256Text(stableJson({plan:plan,targetSnapshot:prepared.targetSnapshot,projectedWrites:await plannedWriteManifest(prepared)}));
  }
  async function targetSnapshotHash(plan,snapshot){
    var manifest=snapshot&&snapshot.manifest;
    if(!manifest||manifest.schema!==TARGET_SNAPSHOT_MANIFEST_SCHEMA||manifest.version!==TARGET_SNAPSHOT_MANIFEST_VERSION||manifest.targetIdentity!==plan.target.identity||manifest.origin!==plan.target.origin||manifest.databaseName!==snapshot.databaseName||Number(manifest.schemaVersion)!==Number(snapshot.version))throw new Error('target-snapshot-manifest-binding-invalid');
    var unsigned=Object.assign({},manifest);delete unsigned.aggregateSha256;
    var actual=await sha256Text(stableJson(unsigned));
    if(actual!==String(manifest.aggregateSha256||'').toLowerCase())throw new Error('target-snapshot-manifest-integrity-invalid');
    if(preparedManifestHash(plan)!==String(manifest.aggregateSha256).toLowerCase())throw new Error('target-snapshot-manifest-plan-binding-invalid');
    return String(manifest.aggregateSha256).toLowerCase();
  }
  function preparedManifestHash(plan){return String(plan&&plan.targetSnapshotManifest&&plan.targetSnapshotManifest.aggregateSha256||'').toLowerCase()}
  function productionDescriptor(plan,snapshotHash){
    var composite=plan.compositeBinding||{};
    return{
      frozenPlanId:composite.frozenPlanId,frozenPlanSha256:composite.frozenPlanSha256,frozenArtifactSha256:composite.frozenArtifactSha256,
      primarySourceSha256:composite.primarySourceSha256,supplementalRoleSourceSha256:composite.supplementalRoleSourceSha256,supplementalMemorySourceSha256:composite.supplementalMemorySourceSha256,
      identityAuthority:composite.identityAuthority,identityStatus:composite.identityStatus,oldRoleId:composite.oldRoleId,newRoleId:composite.newRoleId,
      authorityRevisionId:composite.authorityRevisionId||null,authorityRevisionSha256:composite.authorityRevisionSha256||null,
      selectedDomains:canonicalDomains(plan.selectedDomains),schemaVersion:Number(plan.target&&plan.target.schemaVersion),databaseName:String(plan.target&&plan.target.databaseName||''),targetOrigin:String(plan.target&&plan.target.origin||''),targetIdentity:String(plan.target&&plan.target.identity||''),
      credentialPolicyId:composite.credentialPolicyId,provenanceDigest:composite.provenanceDigest,provenanceRecordCount:Number(composite.provenanceRecordCount),targetSnapshotSha256:snapshotHash
    };
  }
  async function checkpointIntegrity(checkpoint){
    var copy=Object.assign({},checkpoint);delete copy.integritySha256;
    return sha256Text(stableJson(copy));
  }
  async function checkpointMetadata(prepared,approval){
    var plan=prepared.plan,binding=approvalBindingForPlan(plan),selectedDomains=canonicalDomains(plan.selectedDomains),stores=selectedDomains.map(function(domain){return DOMAIN_STORES[domain]});
    var writes=await plannedWriteManifest(prepared);
    if(!prepared.targetSnapshot)throw new Error('production-snapshot-missing');
    if(!approval||!/^[a-f0-9]{32}$/i.test(String(approval.lifecycleId||'')))throw new Error('checkpoint-lifecycle-id-required');
    var checkpoint={
        schema:'internalbeyond.recovery-checkpoint',version:1,phase:'PREPARED',
        planId:binding.planId,planHash:binding.planHash,frozenPlanId:binding.frozenPlanId,frozenPlanHash:binding.frozenPlanHash,frozenArtifactSha256:binding.frozenArtifactSha256,
        transactionId:binding.transactionId,lifecycleId:String(approval.lifecycleId),sourceSha256:binding.sourceSha256,sourceSize:binding.sourceSize,exportVersion:binding.exportVersion,
        supplementalRoleSourceSha256:binding.supplementalRoleSourceSha256,supplementalMemorySourceSha256:binding.supplementalMemorySourceSha256,
        authorityType:binding.authorityType,authorityStatus:binding.authorityStatus,authorityRevisionId:binding.authorityRevisionId,authorityRevisionSha256:binding.authorityRevisionSha256,
        provenanceDigest:binding.provenanceDigest,provenanceRecordCount:binding.provenanceRecordCount,targetSnapshotSha256:binding.targetSnapshotSha256,
        executionPhase:binding.executionPhase,targetOrigin:binding.targetOrigin,targetIdentity:binding.targetIdentity,databaseName:binding.databaseName,schemaVersion:binding.schemaVersion,
        selectedDomains:selectedDomains,stores:stores,
        beforeStores:Object.keys(prepared.targetSnapshot.stores).sort().map(function(name){return{name:name,count:prepared.targetSnapshot.stores[name].count,keys:prepared.targetSnapshot.stores[name].keys.slice().sort()}}),
        plannedWrites:writes,
        firstBootPending:true,activeQuarantined:true,
        createdAt:new Date().toISOString()
    };
    checkpoint.integritySha256=await checkpointIntegrity(checkpoint);
    return checkpoint;
  }
  function checkpointMatchesPlan(checkpoint,prepared,expectedLifecycleId){
    if(!checkpoint||!prepared||!prepared.plan)return false;
    var binding=approvalBindingForPlan(prepared.plan);
    return checkpoint.schema==='internalbeyond.recovery-checkpoint'&&checkpoint.version===1&&checkpoint.phase==='PREPARED'&&
      /^[a-f0-9]{32}$/i.test(String(checkpoint.lifecycleId||''))&&(!expectedLifecycleId||checkpoint.lifecycleId===expectedLifecycleId)&&
      checkpoint.planId===binding.planId&&checkpoint.planHash===binding.planHash&&checkpoint.frozenPlanId===binding.frozenPlanId&&
      checkpoint.frozenPlanHash===binding.frozenPlanHash&&checkpoint.frozenArtifactSha256===binding.frozenArtifactSha256&&
      checkpoint.transactionId===binding.transactionId&&checkpoint.sourceSha256===binding.sourceSha256&&
      checkpoint.sourceSize===binding.sourceSize&&checkpoint.exportVersion===binding.exportVersion&&
      checkpoint.supplementalRoleSourceSha256===binding.supplementalRoleSourceSha256&&checkpoint.supplementalMemorySourceSha256===binding.supplementalMemorySourceSha256&&
      checkpoint.authorityType===binding.authorityType&&checkpoint.authorityStatus===binding.authorityStatus&&
      checkpoint.authorityRevisionId===binding.authorityRevisionId&&checkpoint.authorityRevisionSha256===binding.authorityRevisionSha256&&
      checkpoint.provenanceDigest===binding.provenanceDigest&&checkpoint.provenanceRecordCount===binding.provenanceRecordCount&&
      checkpoint.targetSnapshotSha256===binding.targetSnapshotSha256&&checkpoint.executionPhase===binding.executionPhase&&
      checkpoint.targetOrigin===binding.targetOrigin&&checkpoint.targetIdentity===binding.targetIdentity&&
      checkpoint.databaseName===binding.databaseName&&checkpoint.schemaVersion===binding.schemaVersion&&
      sameCanonicalDomains(checkpoint.selectedDomains,binding.selectedDomains)&&sameCanonicalDomains(checkpoint.stores,binding.selectedDomains)&&checkpoint.firstBootPending===true&&checkpoint.activeQuarantined===true;
  }

  async function applyTransactionCore(db,prepared){
    var selected=canonicalDomains(prepared.plan.selectedDomains),stores=selected.map(function(domain){return DOMAIN_STORES[domain]});
    if(!stores.length||stores.some(function(name){return!name}))throw new Error('restore-domain-selection-invalid');
    var transaction=db.transaction(stores,'readwrite'),done=transactionPromise(transaction),inserted={};
    stores.forEach(function(name){inserted[name]=[]});
    try{
      for(var i=0;i<selected.length;i++){
        var domain=selected[i],store=DOMAIN_STORES[domain],records=prepared.payload&&prepared.payload[domain]||[],objectStore=transaction.objectStore(store);
        for(var j=0;j<records.length;j++){
          var record=records[j];
          if(containsSecretField(record))throw new Error('credential-bearing-record-blocked');
          objectStore.add(record);inserted[store].push(String(record.id));
        }
      }
      await done;
    }catch(error){
      try{transaction.abort()}catch(abortError){}
      try{await done}catch(abortError){}
      throw error
    }
    return{ok:true,planId:prepared.plan.planId,insertedKeys:inserted};
  }

  async function getRecord(db,store,key){var tx=db.transaction([store],'readonly'),done=transactionPromise(tx);var value=await requestPromise(tx.objectStore(store).get(key));await done;return value}
  async function rollbackTransactionCore(db,checkpoint){
    if(!checkpoint||checkpoint.schema!=='internalbeyond.recovery-checkpoint'||!['PREPARED','APPLIED','VERIFIED','ROLLBACK_REQUIRED'].includes(checkpoint.phase))throw new Error('rollback-checkpoint-invalid');
    if(!/^[a-f0-9]{64}$/i.test(String(checkpoint.integritySha256||''))||await checkpointIntegrity(checkpoint)!==String(checkpoint.integritySha256).toLowerCase())throw new Error('rollback-checkpoint-integrity-invalid');
    var byStore={};(checkpoint.plannedWrites||[]).forEach(function(item){(byStore[item.store]||(byStore[item.store]=[])).push(item)});
    for(var store of Object.keys(byStore)){
      for(var row of byStore[store]){
        var current=await getRecord(db,store,row.key);
        if(current==null)continue;
        if(await sha256Text(stableJson(current))!==row.recordSha256)throw new Error('rollback-row-no-longer-owned');
      }
    }
    var stores=Object.keys(byStore);
    if(stores.length){
      var tx=db.transaction(stores,'readwrite'),done=transactionPromise(tx);
      stores.forEach(function(store){byStore[store].forEach(function(row){tx.objectStore(store).delete(row.key)})});
      await done;
    }
    for(var snapshot of checkpoint.beforeStores||[]){
      var name=snapshot.name,check=db.transaction([name],'readonly'),checkDone=transactionPromise(check),keys=await requestPromise(check.objectStore(name).getAllKeys());await checkDone;
      if(!sameStrings(keys,snapshot.keys))throw new Error('rollback-snapshot-mismatch');
    }
    return{ok:true,planId:checkpoint.planId,deletedKeys:byStore};
  }

  class ProductionRecoveryAdapter{
    constructor(options){
      options=options||{};this.indexedDB=options.indexedDB||(root&&root.indexedDB);this.schema=options.schema||schema;this.engine=options.engine||engine;
      this.compositePlanApi=(commonJs&&options.testOnlyCompositePlanApi)||compositePlanApi;
      this.checkpointStore=options.checkpointStore||defaultCheckpointStore();
      this.db=null;this.targetOrigin=commonJs&&options.origin?String(options.origin):String(root&&root.location&&root.location.origin||'');
      this.targetIdentity=commonJs&&options.targetIdentity?String(options.targetIdentity):String(root&&root.__IB_RECOVERY_TARGET_IDENTITY__||'');
      this.syntheticTestMode=commonJs&&options.testOnlySyntheticHost===true;
      this.hostTrusted=commonJs?this.syntheticTestMode&&options.trustedHost===true:!!(root&&root.__IB_TAURI_HOST__===true&&root.__IB_RECOVERY_ONLY__===true&&root.__IB_RECOVERY_TARGET_IDENTITY__===this.targetIdentity);
    }
    get PRODUCTION_APPLY_ENABLED(){return PRODUCTION_APPLY_ENABLED}
    async _openExistingTarget(){
      if(!canonicalOrigin(this.targetOrigin))throw new Error('canonical-tauri-origin-required');
      if(!this.hostTrusted||!canonicalTargetIdentity(this.targetIdentity))throw new Error('canonical-production-target-identity-required');
      if(!this.schema||!this.engine)throw new Error('recovery-dependencies-unavailable');
      this.db=await openExistingDatabase(this.indexedDB,this.schema);validateSchema(this.db,this.schema);
      return{ok:true,targetClass:'production',origin:this.targetOrigin,targetIdentity:this.targetIdentity,databaseName:this.db.name,schemaVersion:this.db.version};
    }
    async prepareProductionTarget(){
      if(this.checkpointStore&&typeof this.checkpointStore.read==='function'){
        var pending=await this.checkpointStore.read();
        if(pending)throw new Error('unresolved-recovery-checkpoint-present');
      }
      return this._openExistingTarget();
    }
    async snapshot(selectedDomains){
      if(!this.db)throw new Error('production-target-not-prepared');
      return snapshotDatabase(this.db,selectedDomains||this.engine.DOMAIN_ORDER,this.targetIdentity,this.targetOrigin);
    }
    async dryRun(input){
      input=input||{};
      if(!input.compositePlan||Object.prototype.hasOwnProperty.call(input,'backup')||Object.prototype.hasOwnProperty.call(input,'manifest'))throw new Error('composite-plan-required-single-backup-rejected');
      if(!this.compositePlanApi||typeof this.compositePlanApi.validate!=='function')throw new Error('composite-plan-validator-unavailable');
      var compositeValidation=await this.compositePlanApi.validate(input.compositePlan);
      if(!compositeValidation||compositeValidation.ok!==true)throw new Error(compositeValidation&&compositeValidation.error||'composite-plan-validation-failed');
      var compositePlan=input.compositePlan;
      if(input.selectedDomains&&!sameCanonicalDomains(input.selectedDomains,compositePlan.selectedDomains))throw new Error('composite-selected-domains-immutable');
      if(!compositePlan.manifest||!compositePlan.backup||!sameCanonicalDomains(compositePlan.selectedDomains,this.engine.DOMAIN_ORDER))throw new Error('composite-plan-contract-invalid');
      if(!Array.isArray(compositePlan.supplementalSources)||compositePlan.supplementalSources.length!==2)throw new Error('composite-supplemental-source-missing');
      if(!Array.isArray(compositePlan.identitySuccession)||compositePlan.identitySuccession.length!==1)throw new Error('composite-identity-succession-evidence-missing');
      var succession=compositePlan.identitySuccession[0],legacyAuthority=succession.authority==='USER_ASSERTED'&&succession.status==='EXPLICIT_USER_ASSERTION';
      var authorityRevision=compositePlan.authorityRevision,confirmedAuthority=succession.authority==='USER_CONFIRMED_IDENTITY_SUCCESSION'&&succession.status==='EXPLICIT_USER_CONFIRMATION'&&compositePlan.phase==='P32-W.5-R3-B.3-P5.6.2'&&authorityRevision&&authorityRevision.identity&&authorityRevision.identity.planId===APPROVED_AUTHORITY_REVISION_ID&&authorityRevision.identity.planSha256===APPROVED_AUTHORITY_REVISION_SHA256&&authorityRevision.supersedes&&authorityRevision.supersedes.planId===APPROVED_COMPOSITE_PLAN_ID&&authorityRevision.supersedes.planSha256===APPROVED_COMPOSITE_PLAN_SHA256&&authorityRevision.validation&&authorityRevision.validation.oldFrozenPlanModified===false&&authorityRevision.validation.applyEnabled===false;
      if(!legacyAuthority&&!confirmedAuthority)throw new Error('composite-identity-succession-evidence-missing');
      if(!compositePlan.provenance||compositePlan.provenance.recordCount!==539||!Array.isArray(compositePlan.provenance.ranges)||!compositePlan.provenance.traceDigest)throw new Error('composite-provenance-missing');
      if(!compositePlan.planIdentity||compositePlan.planIdentity.id!==APPROVED_COMPOSITE_PLAN_ID||compositePlan.planIdentity.sha256!==APPROVED_COMPOSITE_PLAN_SHA256||compositePlan.planIdentity.artifactSha256!==APPROVED_COMPOSITE_ARTIFACT_SHA256)throw new Error('composite-plan-hash-mismatch');
      if(!compositePlan.credentialPolicy||compositePlan.credentialPolicy.credentialBearingFieldsImported!==0||compositePlan.credentialPolicy.secretValuesProjected!==0||compositePlan.credentialPolicy.postRestoreState!=='NEEDS_REBIND')throw new Error('composite-credential-policy-invalid');
      if(String(compositePlan.primarySource.sha256).toLowerCase()!==APPROVED_SOURCE_SHA256||Number(compositePlan.primarySource.size)!==APPROVED_SOURCE_SIZE||Number(compositePlan.primarySource.exportVersion)!==APPROVED_EXPORT_VERSION)throw new Error('composite-primary-source-not-approved');
      if(compositePlan.supplementalSources.length!==2||String(compositePlan.supplementalSources[0].sha256).toLowerCase()!==APPROVED_ROLE_SOURCE_SHA256||String(compositePlan.supplementalSources[1].sha256).toLowerCase()!==APPROVED_MEMORY_SOURCE_SHA256)throw new Error('composite-supplemental-source-not-approved');
      if(containsSecretField(compositePlan.backup.apiConfigs))throw new Error('composite-credential-firewall-failed');
      if(!this.db)await this.prepareProductionTarget();
      var selected=compositePlan.selectedDomains.slice(),snapshot=await this.snapshot(selected),targetKeys={};
      Object.keys(snapshot.stores).forEach(function(store){targetKeys[store]=snapshot.stores[store].keys});
      var prepared=this.engine.buildPlan({manifest:compositePlan.manifest,sourceVerification:{ok:true,size:compositePlan.primarySource.size,sha256:compositePlan.primarySource.sha256},backup:compositePlan.backup,selectedDomains:selected,targetKeys:targetKeys,targetClass:'production',targetOrigin:this.targetOrigin,targetIdentity:this.targetIdentity});
      prepared.targetSnapshot=snapshot;
      prepared.plan.targetSnapshotManifest=snapshot.manifest;
      prepared.plan.executionPhase='R3-B.3';
      prepared.plan.selectedDomains=canonicalDomains(prepared.plan.selectedDomains);
      prepared.plan.domains=canonicalDomainRows(prepared.plan.domains);
      prepared.plan.compositeBinding={
        schema:'internalbeyond.p32-w5.r3b3.composite-plan-binding',
        frozenPlanId:compositePlan.planIdentity.id,frozenPlanSha256:compositePlan.planIdentity.sha256,frozenArtifactSha256:compositePlan.planIdentity.artifactSha256,
        primarySourceSha256:compositePlan.primarySource.sha256,supplementalRoleSourceSha256:compositePlan.supplementalSources[0].sha256,supplementalMemorySourceSha256:compositePlan.supplementalSources[1].sha256,
        identityAuthority:compositePlan.identitySuccession[0].authority,identityStatus:compositePlan.identitySuccession[0].status,oldRoleId:compositePlan.identitySuccession[0].oldId,newRoleId:compositePlan.identitySuccession[0].newId,
        authorityRevisionId:confirmedAuthority?authorityRevision.identity.planId:null,authorityRevisionSha256:confirmedAuthority?authorityRevision.identity.planSha256:null,
        credentialPolicyId:compositePlan.credentialPolicy.id,provenanceDigest:compositePlan.provenance.traceDigest,provenanceRecordCount:compositePlan.provenance.recordCount,
        provenanceRanges:canonicalProvenanceRanges(compositePlan.provenance.ranges),domainCounts:compositePlan.summary.domainCounts
      };
      var snapshotHash=await targetSnapshotHash(prepared.plan,snapshot);
      var descriptor=productionDescriptor(prepared.plan,snapshotHash),descriptorSha256=await sha256Text(stableJson(descriptor));
      prepared.plan.transactionId='r3b3-tx:'+descriptorSha256;
      prepared.plan.planId='r3b3:'+descriptorSha256;
      prepared.plan.productionBinding={schema:'internalbeyond.recovery-production-binding',id:prepared.plan.planId,descriptorSha256:descriptorSha256,targetSnapshotSha256:snapshotHash,targetIdentity:prepared.plan.target.identity,targetOrigin:prepared.plan.target.origin};
      prepared.plan.planHash=compositePlan.planIdentity.sha256;
      prepared.plan.productionBinding.productionPlanHash=await computePlanHash(prepared);
      prepared.plan.planId='r3b3:'+prepared.plan.productionBinding.productionPlanHash;
      prepared.plan.transactionId='r3b3-tx:'+prepared.plan.productionBinding.productionPlanHash;
      prepared.plan.productionBinding.id=prepared.plan.planId;
      return prepared;
    }
    async issueExplicitProductionRestoreApproval(prepared,request){
      var stage='CAPABILITY';
      try{
        if(commonJs||!this.hostTrusted||PRODUCTION_APPLY_ENABLED)throw new Error('production-approval-issuer-recoveryonly-required');
        if(!this.checkpointStore||typeof this.checkpointStore.issue!=='function')throw new Error('native-approval-issuer-unavailable');
        stage='REQUEST_VALIDATION';
        var gate=validateApprovalRequest(prepared,request);
        if(!gate.ok)throw new Error(gate.error);
        stage='PLAN_REVALIDATION';
        await this.verifyPlanBinding(prepared);
        stage='CHECKPOINT_READ';
        var pending=await this.checkpointStore.read();
        if(pending)throw new Error('unresolved-recovery-checkpoint-present');
        stage='NATIVE_CONFIRMATION';
        var approval=await this.checkpointStore.issue({
          kind:PRODUCTION_APPROVAL_KIND,
          confirmation:APPROVAL_PHRASE,
          enteredPlanId:String(request.planId),
          enteredPlanHash:String(request.planHash).toLowerCase(),
          plan:gate.binding
        });
        stage='NATIVE_RESPONSE_VALIDATION';
        if(!approval||approval.kind!==PRODUCTION_APPROVAL_KIND||approval.confirmation!==APPROVAL_PHRASE||
          !/^[a-f0-9]{64}$/i.test(String(approval.token||''))||Number(approval.expiresAt)<=Date.now()||
          Number(approval.expiresAt)>Date.now()+600000){
          throw new Error('native-production-approval-response-invalid');
        }
        issuedApprovals.set(String(approval.token),{approval:approval,consumed:false,synthetic:false});
        if(!approvalMatches(approval,prepared.plan,false)){
          issuedApprovals.delete(String(approval.token));
          throw new Error('native-production-approval-binding-mismatch');
        }
        return approval;
      }catch(error){
        /* The UI maps the embedded reason through an allowlist; never render this
           raw transport detail, which may contain platform-specific diagnostics. */
        throw new Error('APPROVAL_TRACE_STAGE_'+stage+':'+String(error&&error.message||error));
      }
    }
    async verifyPlanBinding(prepared){
      if(!validatePrepared(prepared))throw new Error('production-plan-invalid');
      var snapshotHash=await targetSnapshotHash(prepared.plan,prepared.targetSnapshot);
      if(snapshotHash!==prepared.plan.productionBinding.targetSnapshotSha256)throw new Error('production-target-snapshot-binding-mismatch');
      var descriptorSha256=await sha256Text(stableJson(productionDescriptor(prepared.plan,snapshotHash)));
      if(descriptorSha256!==prepared.plan.productionBinding.descriptorSha256||prepared.plan.planId!=='r3b3:'+prepared.plan.productionBinding.productionPlanHash||prepared.plan.productionBinding.id!==prepared.plan.planId||prepared.plan.transactionId!=='r3b3-tx:'+prepared.plan.productionBinding.productionPlanHash)throw new Error('production-composite-binding-mismatch');
      var actual=await computePlanHash(prepared);
      if(actual!==String(prepared.plan.productionBinding.productionPlanHash||'').toLowerCase())throw new Error('restore-plan-hash-mismatch');
      return true;
    }
    validateBeforeApply(prepared,approval,mode){
      if(!validatePrepared(prepared))return{ok:false,error:'production-plan-invalid',writeAllowed:false};
      if(mode==='dry-run')return{ok:true,error:null,writeAllowed:false};
      if(mode!=='apply')return{ok:false,error:'recovery-mode-invalid',writeAllowed:false};
      if(!this.hostTrusted||(commonJs&&!this.syntheticTestMode))return{ok:false,error:'recoveryonly-production-host-required',writeAllowed:false};
      if(!approvalMatches(approval,prepared.plan,false))return{ok:false,error:'explicit-restore-approval-required',writeAllowed:false};
      if(activeApplyPermit===String(approval.token||''))return{ok:true,error:null,writeAllowed:true};
      if(!PRODUCTION_APPLY_ENABLED&&(!this.hostTrusted||typeof this.checkpointStore.openWindow!=='function'))return{ok:false,error:'production-apply-disabled',writeAllowed:false};
      if(!PRODUCTION_APPLY_ENABLED)return{ok:true,error:null,writeAllowed:false,requiresScopedWindow:true};
      return{ok:true,error:null,writeAllowed:true};
    }
    validateBeforeCheckpoint(prepared,approval){
      if(!this.hostTrusted||(commonJs&&!this.syntheticTestMode))return{ok:false,error:'recoveryonly-production-host-required'};
      if(PRODUCTION_APPLY_ENABLED)return{ok:false,error:'scoped-checkpoint-static-enable-invalid'};
      if(!validatePrepared(prepared))return{ok:false,error:'production-plan-invalid'};
      if(!approvalMatches(approval,prepared.plan,false))return{ok:false,error:'explicit-production-restore-approval-required'};
      if(activeApplyPermit)return{ok:false,error:'checkpoint-must-precede-apply-window'};
      return{ok:true};
    }
    canRequestApprovedApply(){return !commonJs&&!!(this.hostTrusted&&this.checkpointStore&&typeof this.checkpointStore.openWindow==='function')||PRODUCTION_APPLY_ENABLED}
    async createRollbackCheckpoint(prepared,approval){
      var gate=this.validateBeforeCheckpoint(prepared,approval);if(!gate.ok)throw new Error(gate.error);
      await this.verifyPlanBinding(prepared);
      var freshSnapshot=await this.snapshot(prepared.plan.selectedDomains);
      if(await targetSnapshotHash(prepared.plan,freshSnapshot)!==prepared.plan.productionBinding.targetSnapshotSha256)throw new Error('target-changed-after-dry-run');
      for(var store of Object.keys(prepared.targetSnapshot.stores)){
        if(!freshSnapshot.stores[store]||freshSnapshot.stores[store].count!==prepared.targetSnapshot.stores[store].count||!sameStrings(freshSnapshot.stores[store].keys,prepared.targetSnapshot.stores[store].keys))throw new Error('target-changed-after-dry-run');
      }
      prepared.targetSnapshot=freshSnapshot;
      await this.verifyPlanBinding(prepared);
      var checkpoint=await checkpointMetadata(prepared,approval);
      if(await checkpointIntegrity(checkpoint)!==checkpoint.integritySha256)throw new Error('rollback-checkpoint-integrity-invalid');
      await this.checkpointStore.save(checkpoint,approval);
      var durable=await this.checkpointStore.read();
      if(!checkpointMatchesPlan(durable,prepared,approval.lifecycleId)||durable.integritySha256!==checkpoint.integritySha256||await checkpointIntegrity(durable)!==durable.integritySha256)throw new Error('durable-rollback-checkpoint-readback-invalid');
      this.checkpoint=durable;return durable;
    }
    async abortRollbackCheckpoint(prepared,approval){
      if(!this.hostTrusted||(commonJs&&!this.syntheticTestMode))throw new Error('recoveryonly-production-host-required');
      if(!validatePrepared(prepared)||!approvalMatches(approval,prepared.plan,false))throw new Error('checkpoint-abort-approval-binding-invalid');
      if(!this.checkpoint||!checkpointMatchesPlan(this.checkpoint,prepared,approval.lifecycleId))throw new Error('checkpoint-abort-owned-lifecycle-required');
      if(!this.checkpointStore||typeof this.checkpointStore.abort!=='function')throw new Error('checkpoint-lifecycle-abort-unavailable');
      var result=await this.checkpointStore.abort(approval,prepared.plan);
      if(!result||result.ok!==true)throw new Error(result&&result.error||'checkpoint-lifecycle-abort-denied');
      this.checkpoint=null;
      return result;
    }
    async verifyRollbackCheckpoint(prepared,checkpoint){
      if(!validatePrepared(prepared)||!checkpointMatchesPlan(checkpoint,prepared))return{ok:false,error:'rollback-checkpoint-plan-binding-invalid'};
      if(await checkpointIntegrity(checkpoint)!==String(checkpoint.integritySha256||'').toLowerCase())return{ok:false,error:'rollback-checkpoint-integrity-invalid'};
      var current=await this.snapshot(prepared.plan.selectedDomains);
      if(await targetSnapshotHash(prepared.plan,current)!==prepared.plan.productionBinding.targetSnapshotSha256)return{ok:false,error:'rollback-checkpoint-prestate-mismatch'};
      for(var snapshot of checkpoint.beforeStores||[]){
        var store=current.stores[snapshot.name];
        if(!store||store.count!==snapshot.count||!sameStrings(store.keys,snapshot.keys))return{ok:false,error:'rollback-checkpoint-prestate-mismatch'};
      }
      var currentKeys=new Set();
      Object.keys(current.stores).forEach(function(name){(current.stores[name].keys||[]).forEach(function(key){currentKeys.add(name+'|'+String(key))})});
      if((checkpoint.plannedWrites||[]).some(function(row){return currentKeys.has(row.store+'|'+String(row.key))}))return{ok:false,error:'rollback-checkpoint-write-key-already-present'};
      return{ok:true,checkpointPlanId:checkpoint.planId,beforeStoreCount:checkpoint.beforeStores.length,plannedWriteCount:checkpoint.plannedWrites.length,preStateRestorableByInsertRollback:true};
    }
    async applyTransaction(prepared,approval){
      var gate=this.validateBeforeApply(prepared,approval,'apply');if(!gate.ok)throw new Error(gate.error);
      if(activeApplyPermit!==String(approval.token||''))throw new Error('approved-apply-window-required');
      await this.verifyPlanBinding(prepared);
      if(!this.checkpoint||!checkpointMatchesPlan(this.checkpoint,prepared,approval.lifecycleId))throw new Error('rollback-checkpoint-required');
      if(this.checkpoint.lifecycleId!==approval.lifecycleId||this.checkpoint.transactionId!==prepared.plan.transactionId||this.checkpoint.planHash!==productionPlanHash(prepared.plan)||await checkpointIntegrity(this.checkpoint)!==this.checkpoint.integritySha256)throw new Error('rollback-checkpoint-binding-invalid');
      if(!sameCanonicalDomains(approval.selectedDomains,prepared.plan.selectedDomains))throw new Error('approval-domain-mismatch');
      var current=await this.snapshot(prepared.plan.selectedDomains);
      if(await targetSnapshotHash(prepared.plan,current)!==prepared.plan.productionBinding.targetSnapshotSha256)throw new Error('target-changed-after-checkpoint');
      for(var snapshot of this.checkpoint.beforeStores){if(!sameStrings(current.stores[snapshot.name]&&current.stores[snapshot.name].keys,snapshot.keys))throw new Error('target-changed-after-checkpoint')}
      return applyTransactionCore(this.db,prepared);
    }
    async verifyAfterApply(prepared,transactionResult,approval){
      if(!approval||activeApplyPermit!==String(approval.token||''))return{ok:false,error:'approved-apply-window-required',failures:[]};
      if(!this.db||!transactionResult||transactionResult.planId!==prepared.plan.planId)return{ok:false,error:'transaction-identity-mismatch'};
      var failures=[],domainResults=[];
      for(var domain of prepared.plan.selectedDomains){
        var store=DOMAIN_STORES[domain],expected=(prepared.targetSnapshot.stores[store].keys||[]).concat(transactionResult.insertedKeys[store]||[]).map(String).sort();
        var tx=this.db.transaction([store],'readonly'),done=transactionPromise(tx),keys=await requestPromise(tx.objectStore(store).getAllKeys());await done;
        if(!sameStrings(expected,keys))failures.push({domain:domain,expectedCount:expected.length,actualCount:keys.length});
        var planDomain=prepared.plan.domains.find(function(item){return item.domain===domain});
        domainResults.push({domain:domain,sourceCount:Number(planDomain&&planDomain.sourceCount)||0,insertedCount:(transactionResult.insertedKeys[store]||[]).length,beforeCount:(prepared.targetSnapshot.stores[store].keys||[]).length,afterCount:keys.length,stableIdsVerified:sameStrings(expected,keys),referencesVerified:Number(planDomain&&planDomain.referenceConflictCount)===0});
      }
      if(this.checkpoint){
        for(var row of this.checkpoint.plannedWrites){var actual=await getRecord(this.db,row.store,row.key);if(!actual||containsSecretField(actual)||await sha256Text(stableJson(actual))!==row.recordSha256)failures.push({domain:row.store,error:containsSecretField(actual)?'credential-field-present':'record-hash-mismatch'})}
      }
      if(failures.length)return{ok:false,failures:failures,domainResults:domainResults,planId:prepared.plan.planId};
      await this.checkpointStore.markVerified(prepared.plan.planId);
      return{ok:true,failures:[],domainResults:domainResults,credentialState:'NEEDS_REBIND',credentialBearingFieldsRestored:0,planId:prepared.plan.planId};
    }
    async rollback(planId){
      if(!activeApplyPermit)throw new Error('approved-apply-window-required');
      var checkpoint=await this.checkpointStore.read();
      if(!checkpoint||checkpoint.schema!=='internalbeyond.recovery-checkpoint'||checkpoint.planId!==String(planId||''))throw new Error('rollback-checkpoint-not-found');
      if(!this.db)await this._openExistingTarget();
      var result=await rollbackTransactionCore(this.db,checkpoint);
      await this.checkpointStore.clear(checkpoint.planId);this.checkpoint=null;return result;
    }
    async withApprovedApplyWindow(prepared,approval,operation){
      var gate=this.validateBeforeApply(prepared,approval,'apply');if(!gate.ok)throw new Error(gate.error);
      if(typeof operation!=='function')throw new Error('approved-apply-operation-required');
      if(activeApplyPermit)throw new Error('approved-apply-window-already-open');
      if(!this.checkpoint||!checkpointMatchesPlan(this.checkpoint,prepared,approval.lifecycleId))throw new Error('rollback-checkpoint-required-before-apply-window');
      var checkpointCheck=await this.verifyRollbackCheckpoint(prepared,this.checkpoint);
      if(!checkpointCheck.ok)throw new Error(checkpointCheck.error||'rollback-checkpoint-prestate-invalid');
      await this.verifyPlanBinding(prepared);
      var openAttempted=false,nativeWindow=false,result,error,closeError=null,token=String(approval.token);
      try{
        if(PRODUCTION_APPLY_ENABLED)throw new Error('static-production-apply-path-forbidden');
        openAttempted=true;
        var opened=await this.checkpointStore.openWindow(approval,prepared.plan);
        if(!opened||opened.ok!==true)throw new Error(opened&&opened.error||'native-scoped-apply-window-denied');
        nativeWindow=true;
        activeApplyPermit=token;
        if(!approvalMatches(approval,prepared.plan,true))throw new Error('production-approval-consumption-failed');
        result=await operation();
      }catch(caught){error=caught}
      finally{
        activeApplyPermit=null;
        if(openAttempted){
          try{
            await this.checkpointStore.closeWindow(approval);
          }catch(caughtClose){
            var invoke=root&&root.__TAURI__&&root.__TAURI__.core&&root.__TAURI__.core.invoke;
            if(typeof invoke==='function'){
              try{await invoke('close_recovery_apply_window',{request:{planId:approval.planId,token:approval.token}})}
              catch(retryError){closeError=retryError}
            }else closeError=caughtClose;
          }
        }
        issuedApprovals.delete(token);
      }
      if(closeError)throw new Error('RECOVERY_CRITICAL_STOP:apply-window-close-failed:'+String(closeError&&closeError.message||closeError));
      if(error)throw error;
      return result;
    }
    close(){if(this.db){this.db.close();this.db=null}}
  }

  var publicApi=Object.freeze({ProductionRecoveryAdapter:ProductionRecoveryAdapter,PRODUCTION_APPLY_ENABLED:PRODUCTION_APPLY_ENABLED,APPROVED_SOURCE_SHA256:APPROVED_SOURCE_SHA256,APPROVED_SOURCE_SIZE:APPROVED_SOURCE_SIZE,APPROVED_EXPORT_VERSION:APPROVED_EXPORT_VERSION,APPROVED_DOMAIN_COUNTS:APPROVED_DOMAIN_COUNTS});
  var testOnly=Object.freeze({APPROVAL_PHRASE:APPROVAL_PHRASE,TARGET_SNAPSHOT_MANIFEST_SCHEMA:TARGET_SNAPSHOT_MANIFEST_SCHEMA,TARGET_SNAPSHOT_MANIFEST_VERSION:TARGET_SNAPSHOT_MANIFEST_VERSION,SNAPSHOT_METADATA_FIELDS:SNAPSHOT_METADATA_FIELDS,issueSyntheticTestApproval:issueSyntheticTestApproval,validateApprovalRequest:validateApprovalRequest,approvalBindingForPlan:approvalBindingForPlan,canonicalProvenanceRanges:canonicalProvenanceRanges,applyTransactionCore:applyTransactionCore,rollbackTransactionCore:rollbackTransactionCore,checkpointMetadata:checkpointMetadata,checkpointMatchesPlan:checkpointMatchesPlan,snapshotDatabase:snapshotDatabase,buildTargetSnapshotManifest:buildTargetSnapshotManifest,projectSnapshotRecord:projectSnapshotRecord,canonicalIdbKeyJson:canonicalIdbKeyJson,canonicalOrigin:canonicalOrigin,canonicalTargetIdentity:canonicalTargetIdentity,stableJson:stableJson,computePlanHash:computePlanHash,checkpointIntegrity:checkpointIntegrity,validateApproval:approvalMatches,validatePrepared:validatePrepared,preparedGateDiagnostics:preparedGateDiagnostics,planSummaryApplyReady:planSummaryApplyReady});
  return{publicApi:publicApi,testOnly:testOnly};
});
