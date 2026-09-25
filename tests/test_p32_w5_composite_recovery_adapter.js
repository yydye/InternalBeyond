'use strict';

/* P5.6 synthetic-only adapter contract tests. IndexedDB is injected and fake. */
const assert=require('assert');
const Engine=require('../assets/js/recovery-engine.js');
const Schema=require('../assets/js/webcore-db-schema.js');
const Composite=require('../assets/js/composite-recovery-plan.js');
const Adapter=require('../assets/js/recovery-production-adapter.js');

const domains=Engine.DOMAIN_ORDER.slice();
const identity=Composite.testOnly.createSyntheticPackage({backup:{version:8,apiConfigs:[],chatMessages:[],chatThreads:[],groups:[],memories:[],autoMemory:[],diary_entries:[],moments:[],roleLetters:[]}});

function role(id){
  const projected=Engine.projectApiConfig({id:id,provider:'synthetic',model:'offline',endpoint:'https://example.invalid/v1',nickname:'synthetic',apiKey:'SYNTHETIC_SECRET_SENTINEL',imageGenApiKey:'SYNTHETIC_IMAGE_SENTINEL'});
  assert.strictEqual(projected.ok,true);
  return projected.record;
}
function backupFixture(){
  const backup={version:8,apiConfigs:[],chatMessages:[],chatThreads:[],groups:[],memories:[],autoMemory:[],diary_entries:[],moments:[],roleLetters:[]};
  for(let i=0;i<12;i++)backup.apiConfigs.push(role('role_'+i));
  backup.apiConfigs.push(role('friend_1788318367937_tcmw0p'));
  backup.chatThreads=[{id:'thread_0',friendId:'role_0'},{id:'thread_1',friendId:'role_0'}];
  for(let i=0;i<341;i++)backup.chatMessages.push({id:'chat_'+i,role:'user',content:'synthetic message',friendId:'role_0',timestamp:1700000000000+i,threadId:'thread_'+(i%2)});
  for(let i=0;i<7;i++)backup.groups.push({id:'group_'+i,members:[{characterId:'role_0'}]});
  for(let i=0;i<3;i++){
    backup.memories.push({id:'memory_'+i,characterId:'role_0',content:'synthetic memory'});
    backup.autoMemory.push({id:'auto_'+i,friendId:'role_0',content:'synthetic auto memory'});
  }
  backup.memories.push({id:'mem_msgemsdp_l4lj76',characterId:'friend_1788318367937_tcmw0p',content:'synthetic supplemental memory'});
  for(let i=0;i<13;i++)backup.diary_entries.push({id:'diary_'+i,characterId:'role_0',relatedMemoryIds:['memory_0']});
  for(let i=0;i<155;i++)backup.moments.push({id:'moment_'+i,roleId:'role_0'});
  backup.roleLetters=[{id:'letter_0',fromRoleId:'role_0',toRoleId:'role_1'}];
  return backup;
}
function compositePackage(){
  const backup=backupFixture();
  return Composite.testOnly.createSyntheticPackage({backup:backup});
}
function confirmedCompositePackage(overrides){
  const legacy=compositePackage();
  const pkg=Object.assign({},legacy,{
    phase:'P32-W.5-R3-B.3-P5.6.2',
    identitySuccession:[{oldId:'friend_1785260690497',newId:'friend_1788318367937_tcmw0p',authority:'USER_CONFIRMED_IDENTITY_SUCCESSION',status:'EXPLICIT_USER_CONFIRMATION',systemConfirmed:false}],
    authorityRevision:{
      identity:{planId:Composite.AUTHORITY_REVISION_ID,planSha256:Composite.AUTHORITY_REVISION_SHA256},
      supersedes:{planId:Composite.PLAN_ID,planSha256:Composite.PLAN_SHA256},
      validation:{oldFrozenPlanModified:false,applyEnabled:false}
    }
  });
  return Object.assign(pkg,overrides||{});
}
function compositeApi(validate){return{async validate(plan){return validate?validate(plan):Composite.testOnly.validateSyntheticPackage(plan)?{ok:true}:{ok:false,error:'synthetic-composite-invalid'}}}}
function fakeIndexedDB(){
  const stats={databaseEnumerations:0,opens:0,readTransactions:0,writeTransactions:0};
  const db={name:Schema.DB_NAME,version:Schema.DB_VERSION,objectStoreNames:{contains:name=>Schema.STORE_NAMES.includes(name)},close(){},transaction(names,mode){
    const stores=Array.isArray(names)?names:[names];
    if(mode==='readwrite')stats.writeTransactions++;else stats.readTransactions++;
    let scheduled=false;const requests=[];
    const tx={error:null,oncomplete:null,onabort:null,onerror:null,objectStore(name){assert.ok(stores.includes(name));return{getAllKeys(){const req={onsuccess:null,onerror:null,result:[]};requests.push(req);if(!scheduled){scheduled=true;setTimeout(()=>{requests.forEach(item=>item.onsuccess&&item.onsuccess({target:item}));tx.oncomplete&&tx.oncomplete({target:tx})},0)}return req},openCursor(){const req={onsuccess:null,onerror:null,result:null};requests.push(req);if(!scheduled){scheduled=true;setTimeout(()=>{requests.forEach(item=>item.onsuccess&&item.onsuccess({target:item}));tx.oncomplete&&tx.oncomplete({target:tx})},0)}return req}}}};
    return tx;
  }};
  return{stats,api:{async databases(){stats.databaseEnumerations++;return[{name:Schema.DB_NAME}]},open(name){stats.opens++;assert.strictEqual(name,Schema.DB_NAME);const req={result:db,onupgradeneeded:null,onsuccess:null,onerror:null};setTimeout(()=>req.onsuccess&&req.onsuccess({target:req}),0);return req}}};
}
const targetIdentity='com.internalbeyond.desktop|canonical-inno|C:\\Synthetic\\InternalBeyond|1.0.6|'+'e'.repeat(64);
function makeAdapter(fake,validator){return new Adapter.ProductionRecoveryAdapter({
  indexedDB:fake.api,schema:Schema,engine:Engine,origin:'http://tauri.localhost',targetIdentity:targetIdentity,trustedHost:true,testOnlySyntheticHost:true,
  checkpointStore:{async read(){return null},async save(){throw new Error('checkpoint forbidden in composite dry-run test')},async openWindow(){throw new Error('apply window forbidden in composite dry-run test')}},
  testOnlyCompositePlanApi:compositeApi(validator)
})}

let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name)}
async function run(){
  console.log('P32-W.5-P5.6 composite adapter synthetic tests');
  await check('single backup input is rejected before any target access',async()=>{
    const fake=fakeIndexedDB(),adapter=makeAdapter(fake);
    await assert.rejects(adapter.dryRun({manifest:{},backup:{version:8}}),/single-backup-rejected/);
    assert.strictEqual(fake.stats.databaseEnumerations,0);
  });
  await check('missing supplemental source is rejected before target access',async()=>{
    const fake=fakeIndexedDB(),adapter=makeAdapter(fake,()=>({ok:true})),pkg=Object.assign({},compositePackage(),{supplementalSources:[]});
    await assert.rejects(adapter.dryRun({compositePlan:pkg}),/supplemental-source-missing/);
    assert.strictEqual(fake.stats.databaseEnumerations,0);
  });
  await check('missing identity succession evidence is rejected before target access',async()=>{
    const fake=fakeIndexedDB(),adapter=makeAdapter(fake,()=>({ok:true})),pkg=Object.assign({},compositePackage(),{identitySuccession:[]});
    await assert.rejects(adapter.dryRun({compositePlan:pkg}),/identity-succession-evidence-missing/);
    assert.strictEqual(fake.stats.databaseEnumerations,0);
  });
  await check('missing provenance is rejected before target access',async()=>{
    const fake=fakeIndexedDB(),adapter=makeAdapter(fake,()=>({ok:true})),pkg=Object.assign({},compositePackage(),{provenance:null});
    await assert.rejects(adapter.dryRun({compositePlan:pkg}),/provenance-missing/);
    assert.strictEqual(fake.stats.databaseEnumerations,0);
  });
  await check('frozen P5.5 plan hash mismatch is rejected before target access',async()=>{
    const fake=fakeIndexedDB(),adapter=makeAdapter(fake,()=>({ok:true})),pkg=Object.assign({},compositePackage(),{planIdentity:{id:Composite.PLAN_ID,sha256:'0'.repeat(64),artifactSha256:Composite.PLAN_ARTIFACT_SHA256}});
    await assert.rejects(adapter.dryRun({compositePlan:pkg}),/composite-plan-hash-mismatch/);
    assert.strictEqual(fake.stats.databaseEnumerations,0);
  });
  await check('supplemental source hash mismatch is rejected before target access',async()=>{
    const fake=fakeIndexedDB(),adapter=makeAdapter(fake,()=>({ok:true})),pkg=Object.assign({},compositePackage(),{supplementalSources:[{sha256:'0'.repeat(64)},{sha256:Composite.SOURCE_SPECS.memory.sha256}]});
    await assert.rejects(adapter.dryRun({compositePlan:pkg}),/supplemental-source-not-approved/);
    assert.strictEqual(fake.stats.databaseEnumerations,0);
  });
  await check('credential-bearing API fields are rejected before target access',async()=>{
    const fake=fakeIndexedDB(),adapter=makeAdapter(fake,()=>({ok:true})),backup=backupFixture();
    backup.apiConfigs[0].apiKey='SYNTHETIC_FIREWALL_SENTINEL';
    const pkg=Object.assign({},compositePackage(),{backup:backup});
    await assert.rejects(adapter.dryRun({compositePlan:pkg}),/credential-firewall-failed/);
    assert.strictEqual(fake.stats.databaseEnumerations,0);
  });
  let prepared,fake,adapter,pkg;
  await check('validated composite plan is accepted and production binding is deterministic data',async()=>{
    fake=fakeIndexedDB();adapter=makeAdapter(fake);pkg=compositePackage();prepared=await adapter.dryRun({compositePlan:pkg});
    assert.strictEqual(prepared.plan.status,'READY_FOR_EXPLICIT_RESTORE_APPROVAL',JSON.stringify(prepared.plan.errors));
    assert.strictEqual(prepared.plan.compositeBinding.frozenPlanId,Composite.PLAN_ID);
    assert.strictEqual(prepared.plan.compositeBinding.frozenPlanSha256,Composite.PLAN_SHA256);
    assert.strictEqual(prepared.plan.productionBinding.targetIdentity,targetIdentity);
    assert.match(prepared.plan.productionBinding.targetSnapshotSha256,/^[a-f0-9]{64}$/);
    assert.strictEqual(prepared.plan.planHash,Composite.PLAN_SHA256);
    assert.match(prepared.plan.productionBinding.productionPlanHash,/^[a-f0-9]{64}$/);
    assert.strictEqual(prepared.plan.planId,'r3b3:'+prepared.plan.productionBinding.productionPlanHash);
    assert.strictEqual(prepared.plan.transactionId,'r3b3-tx:'+prepared.plan.productionBinding.productionPlanHash);
    assert.strictEqual(prepared.plan.productionBinding.id,prepared.plan.planId);
    assert.notStrictEqual(prepared.plan.productionBinding.productionPlanHash,Composite.PLAN_SHA256);
    assert.strictEqual(await adapter.verifyPlanBinding(prepared),true);
  });
  await check('P5.8.7 approval, checkpoint, token and plan bindings share the canonical domain array',async()=>{
    const planOrder=Engine.DOMAIN_ORDER.slice(),canonical=Engine.canonicalizeDomains(planOrder);
    assert.strictEqual(canonical.ok,true);
    const expected=Engine.CANONICAL_DOMAIN_ORDER.slice();
    assert.deepStrictEqual(canonical.domains,expected);
    const planInPlanOrder=Object.assign({},prepared.plan,{selectedDomains:planOrder.slice()});
    const preparedInPlanOrder=Object.assign({},prepared,{plan:planInPlanOrder});
    const approvalBinding=Adapter.testOnly.approvalBindingForPlan(planInPlanOrder);
    const checkpoint=await Adapter.testOnly.checkpointMetadata(preparedInPlanOrder,{lifecycleId:'a'.repeat(32)});
    assert.deepStrictEqual(approvalBinding.selectedDomains,expected,'approval binding is sorted');
    assert.deepStrictEqual(checkpoint.selectedDomains,expected,'checkpoint selected domains are canonicalized from plan order');
    assert.deepStrictEqual(checkpoint.stores,expected.map(domain=>Engine.STORE_BY_DOMAIN[domain]));
    assert.deepStrictEqual(checkpoint.selectedDomains,approvalBinding.selectedDomains,'checkpoint and approval bindings match');
    const legacyOrderCheckpoint=Object.assign({},checkpoint,{selectedDomains:planOrder.slice(),stores:planOrder.map(domain=>Engine.STORE_BY_DOMAIN[domain])});
    assert.strictEqual(Adapter.testOnly.checkpointMatchesPlan(legacyOrderCheckpoint,preparedInPlanOrder,'a'.repeat(32)),true,'checkpoint comparison canonicalizes plan-order arrays');
    const syntheticToken=Adapter.testOnly.issueSyntheticTestApproval(Adapter.testOnly.APPROVAL_PHRASE,planInPlanOrder);
    assert.deepStrictEqual(syntheticToken.selectedDomains,expected,'synthetic token binding is canonical');
    assert.strictEqual(Adapter.testOnly.validateApproval(syntheticToken,planInPlanOrder,false),true);
    assert.strictEqual(await Adapter.testOnly.computePlanHash(preparedInPlanOrder),await Adapter.testOnly.computePlanHash(prepared),'production plan hash is independent of input domain order');
    assert.strictEqual(fake.stats.writeTransactions,0);
  });
  await check('P5.8.7 canonical domain validation rejects duplicate, missing and extra domains',async()=>{
    const duplicate=Engine.canonicalizeDomains(domains.concat(domains[0]));
    const missing=Engine.canonicalizeDomains(domains.slice(1));
    const extra=Engine.canonicalizeDomains(domains.concat('unexpectedDomain'));
    assert.strictEqual(duplicate.ok,false);assert.strictEqual(duplicate.error,'duplicate-domain-selection');
    assert.strictEqual(missing.ok,false);assert.strictEqual(missing.error,'domain-scope-mismatch');
    assert.strictEqual(extra.ok,false);assert.strictEqual(extra.error,'unknown-domain');
    assert.deepStrictEqual(Engine.CANONICAL_DOMAIN_ORDER.slice(),Object.keys(Adapter.APPROVED_DOMAIN_COUNTS).sort());
    assert.strictEqual(Object.values(Adapter.APPROVED_DOMAIN_COUNTS).reduce((sum,count)=>sum+count,0),539);
    assert.strictEqual(fake.stats.writeTransactions,0);
  });
  await check('P5.8.7 provenance domain ranges canonicalize by domain while preserving all source ranges',async()=>{
    const ranges=[{domain:'groups',source:'primary',recordCount:7},{domain:'apiConfigs',source:'primary',recordCount:12},{domain:'apiConfigs',source:'supplemental-role',recordCount:1}];
    const canonicalRanges=Adapter.testOnly.canonicalProvenanceRanges(ranges);
    assert.deepStrictEqual(canonicalRanges,[ranges[1],ranges[2],ranges[0]]);
    assert.strictEqual(canonicalRanges.reduce((sum,range)=>sum+range.recordCount,0),20);
    assert.deepStrictEqual(ranges[0],{domain:'groups',source:'primary',recordCount:7},'source provenance input remains unchanged');
    assert.strictEqual(prepared.plan.compositeBinding.provenanceRecordCount,539);
    assert.strictEqual(prepared.plan.compositeBinding.provenanceDigest,pkg.provenance.traceDigest);
    assert.strictEqual(fake.stats.writeTransactions,0);
  });
  await check('source provenance and user-asserted succession are bound into production plan',async()=>{
    assert.strictEqual(prepared.plan.compositeBinding.supplementalRoleSourceSha256,Composite.SOURCE_SPECS.role.sha256);
    assert.strictEqual(prepared.plan.compositeBinding.supplementalMemorySourceSha256,Composite.SOURCE_SPECS.memory.sha256);
    assert.strictEqual(prepared.plan.compositeBinding.identityAuthority,'USER_ASSERTED');
    assert.strictEqual(prepared.plan.compositeBinding.provenanceRecordCount,539);
    assert.strictEqual(prepared.plan.compositeBinding.provenanceDigest,pkg.provenance.traceDigest);
  });
  await check('USER_CONFIRMED authority revision is accepted while frozen P5.5 parent remains unchanged',async()=>{
    const fakeConfirmed=fakeIndexedDB(),confirmedAdapter=makeAdapter(fakeConfirmed,()=>({ok:true}));
    const confirmed=confirmedCompositePackage(),confirmedPrepared=await confirmedAdapter.dryRun({compositePlan:confirmed});
    assert.strictEqual(confirmedPrepared.plan.compositeBinding.frozenPlanId,Composite.PLAN_ID);
    assert.strictEqual(confirmedPrepared.plan.compositeBinding.frozenPlanSha256,Composite.PLAN_SHA256);
    assert.strictEqual(confirmedPrepared.plan.compositeBinding.identityAuthority,'USER_CONFIRMED_IDENTITY_SUCCESSION');
    assert.strictEqual(confirmedPrepared.plan.compositeBinding.identityStatus,'EXPLICIT_USER_CONFIRMATION');
    assert.strictEqual(confirmedPrepared.plan.compositeBinding.authorityRevisionId,Composite.AUTHORITY_REVISION_ID);
    assert.strictEqual(confirmedPrepared.plan.compositeBinding.authorityRevisionSha256,Composite.AUTHORITY_REVISION_SHA256);
    assert.match(confirmedPrepared.plan.productionBinding.productionPlanHash,/^[a-f0-9]{64}$/);
    assert.strictEqual(fakeConfirmed.stats.writeTransactions,0);
    assert.strictEqual(Adapter.PRODUCTION_APPLY_ENABLED,false);
  });
  await check('USER_CONFIRMED authority revision mismatch is rejected before target access',async()=>{
    const fakeConfirmed=fakeIndexedDB(),confirmedAdapter=makeAdapter(fakeConfirmed,()=>({ok:true}));
    const bad=confirmedCompositePackage({authorityRevision:{identity:{planId:Composite.AUTHORITY_REVISION_ID,planSha256:'0'.repeat(64)},supersedes:{planId:Composite.PLAN_ID,planSha256:Composite.PLAN_SHA256},validation:{oldFrozenPlanModified:false,applyEnabled:false}}});
    await assert.rejects(confirmedAdapter.dryRun({compositePlan:bad}),/identity-succession-evidence-missing/);
    assert.strictEqual(fakeConfirmed.stats.databaseEnumerations,0);
  });
  await check('credential firewall survives dry-run and never projects secret sentinel',async()=>{
    assert.strictEqual(prepared.plan.credentialBoundary.credentialState,'NEEDS_REBIND');
    assert.strictEqual(prepared.plan.credentialBoundary.secretValuesProjected,0);
    assert.ok(!JSON.stringify(prepared.payload).includes('SYNTHETIC_SECRET_SENTINEL'));
    assert.ok(!JSON.stringify(prepared.payload).includes('SYNTHETIC_IMAGE_SENTINEL'));
    assert.strictEqual(prepared.plan.mutation.providerCalls,0);
  });
  await check('production apply and approval issuance remain closed',async()=>{
    assert.strictEqual(Adapter.PRODUCTION_APPLY_ENABLED,false);
    assert.strictEqual(Adapter.issueExplicitRestoreApproval,undefined);
    assert.strictEqual(adapter.validateBeforeApply(prepared,null,'apply').ok,false);
    assert.strictEqual(fake.stats.writeTransactions,0);
    assert.strictEqual(fake.stats.readTransactions>0,true);
  });
  await check('all target access in this suite is injected synthetic IndexedDB only',async()=>{
    assert.strictEqual(fake.stats.opens,1);assert.strictEqual(fake.stats.databaseEnumerations,1);
    assert.strictEqual(fake.stats.writeTransactions,0);
    assert.strictEqual(global.indexedDB,undefined);
  });
  console.log('PASS '+passed+' P5.6 composite adapter synthetic checks');
}
run().catch(error=>{console.error(error&&error.stack||error);process.exitCode=1});
