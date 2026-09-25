/* P32-W.5 · RecoveryEngine v1 pure planner/projection. No storage, network,
 * runtime, Vault or provider capability is imported by this module. Structured
 * diagnostics are emitted at the same validation sites as the legacy errors. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.IBRecoveryEngine=factory();
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(){
  'use strict';

  var PLAN_SCHEMA='internalbeyond.restore-plan';
  var PLAN_VERSION=1;
  var DIAGNOSTICS_SCHEMA='internalbeyond.recovery-planner-diagnostics';
  var DIAGNOSTICS_VERSION=1;
  var MAX_DIAGNOSTICS=100;
  var DOMAIN_ORDER=['apiConfigs','chatMessages','chatThreads','groups','memories','autoMemory','diary_entries','moments','roleLetters'];
  var CANONICAL_DOMAIN_ORDER=DOMAIN_ORDER.slice().sort(function(a,b){return a<b?-1:a>b?1:0});
  var STORE_BY_DOMAIN=Object.freeze({
    apiConfigs:'apiConfigs',chatMessages:'chatMessages',chatThreads:'chatThreads',groups:'groups',
    memories:'memories',autoMemory:'autoMemory',diary_entries:'diary_entries',moments:'moments',roleLetters:'roleLetters'
  });
  var API_CONFIG_ALLOWLIST=[
    'id','provider','model','endpoint','systemPrompt','nickname','relationship','handle','bio','signature',
    'publicProfile','joinedAt','created','updatedAt','sortOrder','archived','archivedAt','temperature',
    'storyPersonalize','vision','streaming','webSearch','replyStyle','naturalEnding','conversationContinuity',
    'imageGen','imageGenModel','imageGenProvider','imageGenEndpoint','autoMem','autoMemMode','autoMemBudget',
    'amRecordOnly','promptCache','cacheTtl1h','showThinking','thinkingEnabled','sealTimestamp'
  ];

  /* Domain scope is a set with one stable wire representation. Reject repeats
     before sorting so canonicalization can never hide an accidental scope
     expansion or duplicate selection. */
  function canonicalizeDomains(domains){
    if(!Array.isArray(domains))return{ok:false,error:'domain-array-invalid'};
    var seen=new Set();
    for(var domain of domains){
      if(typeof domain!=='string'||DOMAIN_ORDER.indexOf(domain)<0)return{ok:false,error:'unknown-domain'};
      if(seen.has(domain))return{ok:false,error:'duplicate-domain-selection'};
      seen.add(domain);
    }
    var canonical=domains.slice().sort(function(a,b){return a<b?-1:a>b?1:0});
    if(canonical.length!==CANONICAL_DOMAIN_ORDER.length||canonical.some(function(domain,index){return domain!==CANONICAL_DOMAIN_ORDER[index]}))return{ok:false,error:'domain-scope-mismatch'};
    return{ok:true,domains:canonical};
  }
  var VOICE_ALLOWLIST=['enabled','provider','source','voiceId','rate','pitch','autoPlay','model','language','style','voiceType'];
  var SECRET_FIELD_RE=/(?:api.?key|imagegen.?apikey|secret|token|authorization|password|credential.?ref|vault|ciphertext)/i;

  function plainObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value)}
  function cloneJson(value){return JSON.parse(JSON.stringify(value))}
  function own(obj,key){return Object.prototype.hasOwnProperty.call(obj,key)}
  function asArray(value){return Array.isArray(value)?value:[]}
  function keyOf(record){return record&&record.id!=null?String(record.id):''}
  function sourceDescriptor(manifest){
    if(plainObject(manifest)&&manifest.schema==='internalbeyond.p32-w5.r3b.recovery-source-manifest')return manifest.source||{};
    if(plainObject(manifest)&&manifest.schema==='internalbeyond.recovery-manifest'){
      var source=(manifest.sources||[]).filter(function(item){return item&&item.kind==='existing-json-export'})[0]||{};
      return{path:source.path,size:source.bytes,sha256:source.sha256,observedExportVersion:Number(String(source.schema||'').match(/(\d+)$/)?.[1]||0)};
    }
    return{};
  }
  function safeClass(value,present){
    if(!present)return'missing';
    if(value===null)return'null';
    if(Array.isArray(value))return'array';
    return typeof value==='object'?'object':typeof value;
  }
  function recordAlias(domain,index){return String(domain)+'#'+String(Number(index)+1).padStart(6,'0')}
  function diagnostic(code,severity,domain,alias,field,reason,expected,actualClass,referenceType){
    return{
      code:String(code),severity:severity==='INFO'?'INFO':'BLOCKER',domain:String(domain||'plan'),
      recordIdAlias:alias==null?null:String(alias),field:field==null?null:String(field),
      reason:String(reason),referenceType:referenceType==null?null:String(referenceType),
      expected:expected==null?null:String(expected),actualClass:actualClass==null?'unknown':String(actualClass)
    };
  }
  function createDiagnosticCollector(errors){
    var entries=[],categoryCounts={},total=0,blockerCount=0,noticeCount=0,truncated=false;
    function add(item,legacyError){
      if(legacyError)errors.push(String(legacyError));
      total++;categoryCounts[item.code]=(categoryCounts[item.code]||0)+1;
      if(item.severity==='INFO')noticeCount++;else blockerCount++;
      if(entries.length<MAX_DIAGNOSTICS)entries.push(item);else truncated=true;
    }
    function snapshot(){
      return{
        schema:DIAGNOSTICS_SCHEMA,version:DIAGNOSTICS_VERSION,limit:MAX_DIAGNOSTICS,total:total,
        blockerCount:blockerCount,noticeCount:noticeCount,truncated:truncated,
        categoryCounts:Object.assign({},categoryCounts),entries:entries.slice()
      };
    }
    return{add:add,snapshot:snapshot};
  }
  function endpointHasCredentialQuery(value){
    if(typeof value!=='string'||!value)return false;
    try{
      var url=new URL(value);
      if(url.username||url.password)return true;
      var hit=false;
      url.searchParams.forEach(function(_v,key){if(SECRET_FIELD_RE.test(key))hit=true});
      return hit;
    }catch(e){return /[?&](?:api.?key|key|token|access.?token|authorization|secret|password)=/i.test(value)}
  }
  function hasCredentialFieldName(value){
    if(Array.isArray(value))return value.some(hasCredentialFieldName);
    if(!plainObject(value))return false;
    return Object.keys(value).some(function(key){return SECRET_FIELD_RE.test(key)||hasCredentialFieldName(value[key])});
  }
  function hasCredentialBearingApiField(row){
    if(hasCredentialFieldName(row))return true;
    return !!(row&&((own(row,'endpoint')&&endpointHasCredentialQuery(row.endpoint))||(own(row,'imageGenEndpoint')&&endpointHasCredentialQuery(row.imageGenEndpoint))));
  }

  function projectVoice(value){
    if(!plainObject(value))return undefined;
    var out={};
    VOICE_ALLOWLIST.forEach(function(key){if(own(value,key))out[key]=cloneJson(value[key])});
    return out;
  }
  function projectPublicProfile(value){
    if(!plainObject(value))return undefined;
    var out={};
    ['publicIntro','occupation'].forEach(function(key){if(typeof value[key]==='string')out[key]=value[key]});
    ['traits','interests'].forEach(function(key){if(Array.isArray(value[key]))out[key]=value[key].filter(function(item){return typeof item==='string'}).slice()});
    return out;
  }
  function projectApiConfig(row){
    if(!plainObject(row))return{ok:false,error:'record-not-object'};
    var out={};
    API_CONFIG_ALLOWLIST.forEach(function(key){
      if(!own(row,key))return;
      if((key==='endpoint'||key==='imageGenEndpoint')&&endpointHasCredentialQuery(row[key]))return;
      if(key==='publicProfile')out[key]=projectPublicProfile(row[key]);
      else out[key]=cloneJson(row[key]);
    });
    if(own(row,'voice'))out.voice=projectVoice(row.voice);
    if(!out.id||typeof out.id!=='string')return{ok:false,error:'missing-stable-id'};
    return{ok:true,record:out,credentialState:'NEEDS_REBIND',credentialFieldsExcluded:hasCredentialBearingApiField(row)};
  }

  function requiredFieldIssue(row,domain,field,expected,legacyReason,nonEmpty){
    var present=own(row,field),value=present?row[field]:undefined;
    if(!present||value==null||(nonEmpty&&value===''))return diagnostic('MISSING_REQUIRED_FIELD','BLOCKER',domain,null,field,legacyReason,expected,safeClass(value,present));
    if(expected==='string'&&typeof value!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,field,legacyReason,expected,safeClass(value,true));
    return null;
  }
  function recordValidationIssue(domain,row){
    if(!plainObject(row))return{code:'UNSUPPORTED_RECORD',field:'record',reason:'record-not-object',expected:'object',actualClass:safeClass(row,true),legacy:'record-not-object'};
    if(!keyOf(row)){
      var idPresent=own(row,'id');
      return{code:'MISSING_REQUIRED_FIELD',field:'id',reason:'missing-stable-id',expected:'non-empty stable identifier',actualClass:safeClass(row.id,idPresent),legacy:'missing-stable-id'};
    }
    var issue=null;
    if(domain==='chatMessages'){
      issue=requiredFieldIssue(row,domain,'role','string','invalid-chat-message',false);if(issue)return issue;
      issue=requiredFieldIssue(row,domain,'content','string','invalid-chat-message',false);if(issue)return issue;
      issue=requiredFieldIssue(row,domain,'friendId','string','invalid-chat-message',true);if(issue)return issue;
      if(!Number.isFinite(Number(row.timestamp)))return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'timestamp','invalid-chat-message','finite number',safeClass(row.timestamp,own(row,'timestamp')));
      if(row.threadId!=null&&typeof row.threadId!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'threadId','invalid-thread-id','string',safeClass(row.threadId,true));
    }else if(domain==='chatThreads'){
      issue=requiredFieldIssue(row,domain,'friendId','string','invalid-thread-owner',true);if(issue)return issue;
    }else if(domain==='groups'){
      if(!own(row,'members'))return diagnostic('MISSING_REQUIRED_FIELD','BLOCKER',domain,null,'members','invalid-group-members','array',safeClass(undefined,false));
      if(!Array.isArray(row.members))return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'members','invalid-group-members','array',safeClass(row.members,true));
    }else if(domain==='memories'){
      if(row.characterId!=null&&typeof row.characterId!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'characterId','invalid-memory-character','string',safeClass(row.characterId,true));
    }else if(domain==='autoMemory'){
      if(row.friendId!=null&&typeof row.friendId!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'friendId','invalid-auto-memory-owner','string',safeClass(row.friendId,true));
    }else if(domain==='diary_entries'){
      if(row.characterId!=null&&typeof row.characterId!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'characterId','invalid-diary-character','string',safeClass(row.characterId,true));
      if(row.relatedMemoryIds!=null&&!Array.isArray(row.relatedMemoryIds))return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'relatedMemoryIds','invalid-related-memory-ids','array',safeClass(row.relatedMemoryIds,true));
    }else if(domain==='moments'){
      if(row.roleId!=null&&typeof row.roleId!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'roleId','invalid-moment-role','string',safeClass(row.roleId,true));
      if(row.characterId!=null&&typeof row.characterId!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'characterId','invalid-moment-character','string',safeClass(row.characterId,true));
    }else if(domain==='roleLetters'){
      issue=requiredFieldIssue(row,domain,'fromRoleId','string','invalid-role-letter-actors',true);if(issue)return issue;
      issue=requiredFieldIssue(row,domain,'toRoleId','string','invalid-role-letter-actors',true);if(issue)return issue;
      if(row.parentId!=null&&typeof row.parentId!=='string')return diagnostic('TYPE_MISMATCH','BLOCKER',domain,null,'parentId','invalid-role-letter-parent','string',safeClass(row.parentId,true));
    }
    return null;
  }
  function validRecord(domain,row){
    var issue=recordValidationIssue(domain,row);
    return issue?issue.reason:'';
  }

  function buildPlan(input){
    input=input||{};
    var manifest=input.manifest||{},backup=input.backup;
    var selected=Array.isArray(input.selectedDomains)?input.selectedDomains.slice():DOMAIN_ORDER.slice();
    var targetKeys=input.targetKeys||{};
    var errors=[],domains=[],payload={},idsByDomain={},validByDomain={},aliasesByDomain={};
    var diagnostics=createDiagnosticCollector(errors);
    var source=sourceDescriptor(manifest),sourceHash=String(source.sha256||'').toLowerCase();
    if(!['internalbeyond.p32-w5.r3b.recovery-source-manifest','internalbeyond.recovery-manifest'].includes(manifest.schema)||Number(manifest.version)!==1){
      diagnostics.add(diagnostic('SCHEMA_INVALID','BLOCKER','manifest','manifest#000000','schema','manifest-schema-invalid','supported recovery manifest v1',safeClass(manifest.schema,own(manifest,'schema'))),'manifest-schema-invalid');
    }
    if(!/^[a-f0-9]{64}$/.test(sourceHash))diagnostics.add(diagnostic('SCHEMA_INVALID','BLOCKER','source','source#000000','sha256','source-hash-invalid','sha256 hex digest',safeClass(source.sha256,own(source,'sha256'))),'source-hash-invalid');
    var verification=input.sourceVerification||{};
    if(verification.ok!==true||String(verification.sha256||'').toLowerCase()!==sourceHash||Number(verification.size)!==Number(source.size)){
      diagnostics.add(diagnostic('SCHEMA_INVALID','BLOCKER','source','source#000000','verification','source-bytes-not-verified','verified size and sha256',verification.ok===true?'mismatch':'missing'),'source-bytes-not-verified');
    }
    if(!plainObject(backup))diagnostics.add(diagnostic('SCHEMA_INVALID','BLOCKER','source','source#000000','backup','backup-not-object','json object',safeClass(backup,true)),'backup-not-object');
    if(plainObject(backup)&&Number(backup.version)!==8)diagnostics.add(diagnostic('SCHEMA_INVALID','BLOCKER','source','source#000000','version','unsupported-export-version','export version 8',safeClass(backup.version,true)),'unsupported-export-version');
    if(plainObject(backup)&&Number(source.observedExportVersion||0)!==Number(backup.version))diagnostics.add(diagnostic('SCHEMA_INVALID','BLOCKER','source','source#000000','observedExportVersion','manifest-export-version-mismatch','manifest and backup versions equal',safeClass(source.observedExportVersion,own(source,'observedExportVersion'))),'manifest-export-version-mismatch');
    selected.forEach(function(domain){if(DOMAIN_ORDER.indexOf(domain)<0)diagnostics.add(diagnostic('UNKNOWN','BLOCKER','plan','plan#000000','selectedDomains','unknown-domain','approved domain','unknown'),'unknown-domain')});
    if(new Set(selected).size!==selected.length)diagnostics.add(diagnostic('PLAN_INVARIANT_FAILED','BLOCKER','plan','plan#000000','selectedDomains','duplicate-domain-selection','unique domain selection','duplicate'),'duplicate-domain-selection');

    var selectedUnique=DOMAIN_ORDER.filter(function(domain){return selected.indexOf(domain)>=0});
    selectedUnique.forEach(function(domain){
      if(!plainObject(backup)||!own(backup,domain)||!Array.isArray(backup[domain])){
        diagnostics.add(diagnostic('MISSING_REQUIRED_FIELD','BLOCKER',domain,domain+'#section','section','selected-section-missing','array of records','missing'),'selected-section-missing');
        domains.push({domain:domain,store:STORE_BY_DOMAIN[domain],sourceCount:null,validCount:0,rejectedCount:0,sourceDuplicateCount:0,targetCollisionCount:0,referenceConflictCount:0,action:'BLOCKED_MISSING_SECTION'});
        idsByDomain[domain]=new Set();validByDomain[domain]=[];aliasesByDomain[domain]=[];return;
      }
      var raw=backup[domain],records=[],recordAliases=[],ids=new Set(),dups=0,rejected=0,credentialBearingConfigs=0;
      if(plainObject(manifest.recordCounts)&&manifest.recordCounts[domain]!=null&&Number(manifest.recordCounts[domain])!==raw.length){
        diagnostics.add(diagnostic('SCHEMA_INVALID','BLOCKER',domain,domain+'#section','recordCounts','manifest-record-count-mismatch','manifest count equals source section length','count-mismatch'),'manifest-record-count-mismatch');
      }
      raw.forEach(function(row,rowIndex){
        var alias=recordAlias(domain,rowIndex),projected=row;
        if(domain==='apiConfigs'){
          var projection=projectApiConfig(row);
          if(!projection.ok){
            rejected++;
            var code=projection.error==='missing-stable-id'?'MISSING_REQUIRED_FIELD':'UNSUPPORTED_RECORD';
            diagnostics.add(diagnostic(code,'BLOCKER',domain,alias,'record',projection.error,'projectable role/API metadata',safeClass(row,true)),'record-validation-failed');
            return;
          }
          projected=projection.record;
          if(projection.credentialFieldsExcluded){
            credentialBearingConfigs++;
            diagnostics.add(diagnostic('CREDENTIAL_FIELD_REJECTED','INFO',domain,alias,'credential','excluded-by-metadata-allowlist','secret-free metadata projection','credential-bearing-field-name'));
          }
        }else if(hasCredentialFieldName(row)){
          rejected++;
          diagnostics.add(diagnostic('CREDENTIAL_FIELD_REJECTED','BLOCKER',domain,alias,'credential','credential-bearing-field-rejected','no credential-bearing fields','credential-bearing-field-name'),'record-validation-failed');
          return;
        }
        var issue=recordValidationIssue(domain,projected);
        if(issue){rejected++;issue.domain=domain;issue.recordIdAlias=alias;diagnostics.add(issue,'record-validation-failed');return}
        var id=keyOf(projected);
        if(ids.has(id)){
          dups++;
          diagnostics.add(diagnostic('DUPLICATE_ID','BLOCKER',domain,alias,'id','duplicate-source-id','unique stable identifier','duplicate-string'),'duplicate-source-id');
          return;
        }
        ids.add(id);records.push(projected);recordAliases.push(alias);
      });
      idsByDomain[domain]=ids;validByDomain[domain]=records;aliasesByDomain[domain]=recordAliases;
      var targetSet=new Set(asArray(targetKeys[STORE_BY_DOMAIN[domain]]).map(String)),collisions=0;
      records.forEach(function(record,index){if(targetSet.has(keyOf(record))){
        collisions++;
        diagnostics.add(diagnostic('TARGET_CONFLICT','BLOCKER',domain,recordAliases[index],'id','target-key-collision','identifier absent from target','existing-key'),'target-collision');
      }});
      domains.push({domain:domain,store:STORE_BY_DOMAIN[domain],sourceCount:raw.length,validCount:records.length,rejectedCount:rejected,sourceDuplicateCount:dups,targetCollisionCount:collisions,referenceConflictCount:0,credentialBearingConfigCount:credentialBearingConfigs,action:dups||collisions||rejected?'BLOCKED_CONFLICT':'INSERT'});
      payload[domain]=records;
    });

    var roleIds=new Set(),targetRoleIds=new Set(asArray(targetKeys.apiConfigs).map(String));
    asArray(validByDomain.apiConfigs).forEach(function(record){roleIds.add(String(record.id))});
    targetRoleIds.forEach(function(id){roleIds.add(id)});
    var groupIds=new Set(asArray(validByDomain.groups).map(keyOf));
    asArray(targetKeys.groups).forEach(function(id){groupIds.add(String(id))});
    var threadById=new Map();
    asArray(validByDomain.chatThreads).forEach(function(record){threadById.set(String(record.id),record)});
    asArray(targetKeys.chatThreads).forEach(function(id){if(!threadById.has(String(id)))threadById.set(String(id),null)});
    var memoryIds=new Set(asArray(validByDomain.memories).map(keyOf));
    asArray(targetKeys.memories).forEach(function(id){memoryIds.add(String(id))});
    var letterIds=new Set(asArray(validByDomain.roleLetters).map(keyOf));
    asArray(targetKeys.roleLetters).forEach(function(id){letterIds.add(String(id))});
    function roleReference(id){return !id||roleIds.has(String(id))}
    function friendReference(friendId){
      if(typeof friendId!=='string'||!friendId)return false;
      if(friendId.indexOf('group_')===0)return groupIds.has(friendId);
      if(friendId.indexOf('roledm_')===0)return true;
      return roleIds.has(friendId);
    }
    function refConflict(domain){
      var count=0,rows=asArray(validByDomain[domain]),aliases=asArray(aliasesByDomain[domain]);
      function add(index,field,referenceType,reason,actual){
        count++;
        diagnostics.add(diagnostic('DANGLING_REFERENCE','BLOCKER',domain,aliases[index],field,reason,'reference resolves within approved domains',safeClass(actual,actual!==undefined),referenceType),'reference-conflict');
      }
      if(domain==='chatMessages')rows.forEach(function(message,index){
        if(!friendReference(message.friendId))add(index,'friendId','role-or-group','friend-reference-not-found',message.friendId);
        if(message.threadId){var thread=threadById.get(String(message.threadId));if(!threadById.has(String(message.threadId)))add(index,'threadId','chat-thread','thread-reference-not-found',message.threadId);else if(thread&&thread.friendId!==message.friendId)add(index,'threadId','chat-thread','thread-owner-mismatch',message.threadId)}
      });
      if(domain==='chatThreads')rows.forEach(function(thread,index){if(!friendReference(thread.friendId))add(index,'friendId','role-or-group','thread-owner-not-found',thread.friendId)});
      if(domain==='groups')rows.forEach(function(group,index){asArray(group.members).forEach(function(member){if(!member||!roleReference(String(member.characterId||'')))add(index,'members.characterId','role','group-member-not-found',member&&member.characterId)})});
      if(domain==='memories')rows.forEach(function(memory,index){if(!roleReference(String(memory.characterId||'')))add(index,'characterId','role','memory-owner-not-found',memory.characterId)});
      if(domain==='autoMemory')rows.forEach(function(memory,index){if(!roleReference(String(memory.friendId||'')))add(index,'friendId','role','auto-memory-owner-not-found',memory.friendId)});
      if(domain==='diary_entries')rows.forEach(function(entry,index){
        if(!roleReference(String(entry.characterId||'')))add(index,'characterId','role','diary-owner-not-found',entry.characterId);
        asArray(entry.relatedMemoryIds).forEach(function(id){if(!memoryIds.has(String(id)))add(index,'relatedMemoryIds','memory','related-memory-not-found',id)});
      });
      if(domain==='moments')rows.forEach(function(moment,index){var owner=moment.roleId||moment.characterId||'';if(!roleReference(String(owner)))add(index,'roleId','role','moment-owner-not-found',owner)});
      if(domain==='roleLetters')rows.forEach(function(letter,index){
        if(!roleIds.has(String(letter.fromRoleId)))add(index,'fromRoleId','role','letter-sender-not-found',letter.fromRoleId);
        if(!roleIds.has(String(letter.toRoleId)))add(index,'toRoleId','role','letter-recipient-not-found',letter.toRoleId);
        if(letter.parentId&&!letterIds.has(String(letter.parentId)))add(index,'parentId','role-letter','parent-letter-not-found',letter.parentId);
      });
      return count;
    }
    domains.forEach(function(item){
      if(item.action==='BLOCKED_MISSING_SECTION')return;
      item.referenceConflictCount=refConflict(item.domain);
      if(item.referenceConflictCount)item.action='BLOCKED_CONFLICT';
    });
    domains.forEach(function(item){if(item.action==='BLOCKED_CONFLICT')diagnostics.add(diagnostic('DOMAIN_CONFLICT','BLOCKER',item.domain,item.domain+'#section','domain','domain-conflict','zero domain conflicts','blocked'),'domain-conflict')});

    var credentialRecords=asArray(validByDomain.apiConfigs).length;
    var plan={
      schema:PLAN_SCHEMA,version:PLAN_VERSION,mode:'dry-run',
      planId:'r3b2:'+sourceHash+':'+selectedUnique.join(','),
      source:{manifestSchema:String(manifest.schema||''),manifestVersion:Number(manifest.version)||0,sha256:sourceHash,size:Number(source.size)||0,exportVersion:plainObject(backup)?Number(backup.version)||0:null},
      target:{class:String(input.targetClass||'unknown'),origin:String(input.targetOrigin||''),identity:String(input.targetIdentity||''),databaseName:'InternalBeyondDB',schemaVersion:24},
      selectedDomains:selectedUnique,
      domains:domains,
      summary:{sourceRecords:domains.reduce(function(n,d){return n+(Number(d.sourceCount)||0)},0),validRecords:domains.reduce(function(n,d){return n+d.validCount},0),sourceDuplicates:domains.reduce(function(n,d){return n+d.sourceDuplicateCount},0),targetCollisions:domains.reduce(function(n,d){return n+d.targetCollisionCount},0),referenceConflicts:domains.reduce(function(n,d){return n+d.referenceConflictCount},0),rejectedRecords:domains.reduce(function(n,d){return n+(d.rejectedCount||0)},0)},
      credentialBoundary:{bearingConfigCount:credentialRecords,secretValuesProjected:0,credentialState:credentialRecords?'NEEDS_REBIND':'NOT_PRESENT'},
      approval:{required:true,status:'MISSING'},errors:Array.from(new Set(errors)),diagnostics:diagnostics.snapshot(),
      status:errors.length?'BLOCKED':'READY_FOR_EXPLICIT_RESTORE_APPROVAL',
      mutation:{attempted:0,committed:0,productionWrites:0,localStorageWrites:0,providerCalls:0}
    };
    return{plan:plan,payload:payload};
  }

  return Object.freeze({
    PLAN_SCHEMA:PLAN_SCHEMA,PLAN_VERSION:PLAN_VERSION,DIAGNOSTICS_SCHEMA:DIAGNOSTICS_SCHEMA,DIAGNOSTICS_VERSION:DIAGNOSTICS_VERSION,MAX_DIAGNOSTICS:MAX_DIAGNOSTICS,
    DOMAIN_ORDER:DOMAIN_ORDER.slice(),CANONICAL_DOMAIN_ORDER:CANONICAL_DOMAIN_ORDER.slice(),STORE_BY_DOMAIN:STORE_BY_DOMAIN,API_CONFIG_ALLOWLIST:API_CONFIG_ALLOWLIST.slice(),
    canonicalizeDomains:canonicalizeDomains,projectApiConfig:projectApiConfig,validateRecord:validRecord,buildPlan:buildPlan
  });
});
