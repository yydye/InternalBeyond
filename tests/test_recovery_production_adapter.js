'use strict';

/* Synthetic-only tests for the ProductionRecoveryAdapter contract and its
   transaction core. No Tauri profile, real IndexedDB, provider, or Vault is used. */
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const ROOT=path.resolve(__dirname,'..');
const Schema=require(path.join(__dirname,'..','assets','js','webcore-db-schema.js'));
const Engine=require(path.join(__dirname,'..','assets','js','recovery-engine.js'));
const CompositePlan=require(path.join(__dirname,'..','assets','js','composite-recovery-plan.js'));
const AdapterModule=require(path.join(__dirname,'..','assets','js','recovery-production-adapter.js'));
const Boot=require(path.join(__dirname,'..','assets','js','recovery-first-boot.js'));
const APPROVAL=AdapterModule.testOnly.APPROVAL_PHRASE;
const SOURCE_SHA=AdapterModule.APPROVED_SOURCE_SHA256;
const ROLE_SHA=CompositePlan.SOURCE_SPECS.role.sha256;
const MEMORY_SHA=CompositePlan.SOURCE_SPECS.memory.sha256;
const COMPOSITE_ID=CompositePlan.PLAN_ID;
const COMPOSITE_HASH=CompositePlan.PLAN_SHA256;
const COMPOSITE_ARTIFACT=CompositePlan.PLAN_ARTIFACT_SHA256;

function fixture(){
  const backup={version:8,apiConfigs:[],chatMessages:[],chatThreads:[],groups:[],memories:[],autoMemory:[],diary_entries:[],moments:[],roleLetters:[]};
  for(let i=0;i<12;i++)backup.apiConfigs.push(Engine.projectApiConfig({id:'role_'+i,provider:'custom',model:'synthetic',endpoint:'https://example.invalid/v1',nickname:'Synthetic role '+i,systemPrompt:'synthetic only',apiKey:'SYNTHETIC_SECRET',imageGenApiKey:'SYNTHETIC_IMAGE_SECRET'}).record);
  backup.apiConfigs.push(Engine.projectApiConfig({id:'friend_1788318367937_tcmw0p',provider:'custom',model:'synthetic',nickname:'synthetic successor',apiKey:'SYNTHETIC_ROLE_SECRET'}).record);
  backup.chatThreads=[{id:'thread_0',friendId:'role_0'},{id:'thread_1',friendId:'role_0'}];
  for(let i=0;i<341;i++)backup.chatMessages.push({id:'chat_'+i,role:'user',content:'synthetic body '+i,friendId:'role_0',timestamp:1700000000000+i,threadId:'thread_'+(i%2)});
  for(let i=0;i<7;i++)backup.groups.push({id:'group_'+i,members:[{characterId:'role_0'}]});
  for(let i=0;i<3;i++){
    backup.memories.push({id:'memory_'+i,characterId:'role_0',content:'synthetic memory'});
    backup.autoMemory.push({id:'auto_'+i,friendId:'role_0',content:'synthetic auto'});
  }
  backup.memories.push({id:'mem_msgemsdp_l4lj76',characterId:'friend_1788318367937_tcmw0p',content:'synthetic supplemental memory'});
  for(let i=0;i<13;i++)backup.diary_entries.push({id:'diary_'+i,characterId:'role_0',relatedMemoryIds:['memory_0']});
  for(let i=0;i<155;i++)backup.moments.push({id:'moment_'+i,roleId:'role_0',content:'synthetic moment'});
  backup.roleLetters=[{id:'letter_0',fromRoleId:'role_0',toRoleId:'role_1',content:'synthetic letter'}];
  const manifest={schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',version:1,source:{path:'InternalBeyond_auto_2026-09-02.json',fileName:'InternalBeyond_auto_2026-09-02.json',size:AdapterModule.APPROVED_SOURCE_SIZE,sha256:SOURCE_SHA,observedExportVersion:8},recordCounts:{}};
  for(const domain of Engine.DOMAIN_ORDER)manifest.recordCounts[domain]=backup[domain].length;
  const compositePlan=CompositePlan.testOnly.createSyntheticPackage({backup:backup});
  return{backup,manifest,sourceVerification:{ok:true,size:AdapterModule.APPROVED_SOURCE_SIZE,sha256:SOURCE_SHA},compositePlan};
}

const testCompositePlanApi={async validate(plan){return CompositePlan.testOnly.validateSyntheticPackage(plan)?{ok:true}:{ok:false,error:'composite-plan-validation-failed'}}};

function fakeIndexedDB(initial){
  const data=new Map();
  for(const name of Schema.STORE_NAMES)data.set(name,new Map(Object.entries((initial&&initial[name])||{})));
  const stats={readTransactions:0,writeTransactions:0,abortedTransactions:0};
  const db={name:Schema.DB_NAME,version:Schema.DB_VERSION,objectStoreNames:{contains:name=>data.has(name)},close(){},
    transaction(names,mode){
      const selected=Array.isArray(names)?names:[names];
      if(selected.some(name=>!data.has(name)))throw new Error('fake-store-missing');
      if(mode==='readwrite')stats.writeTransactions++;else stats.readTransactions++;
      let scheduled=false,aborted=false,completeSent=false,ops=[];const requests=[];
      const tx={error:null,oncomplete:null,onabort:null,onerror:null,
        abort(){if(aborted)return;aborted=true;stats.abortedTransactions++;setTimeout(()=>{if(tx.onabort)tx.onabort({target:tx})},0)},
        objectStore(name){
          if(!selected.includes(name))throw new Error('fake-store-not-in-transaction');
          return{
            getAllKeys(){const req={onsuccess:null,onerror:null};requests.push({req,type:'keys',store:name});schedule();return req},
            get(key){const req={onsuccess:null,onerror:null};requests.push({req,type:'get',store:name,key:String(key)});schedule();return req},
            openCursor(){const req={onsuccess:null,onerror:null,result:null};requests.push({req,type:'cursor',store:name,done:false});schedule();return req},
            add(record){if(mode!=='readwrite')throw new Error('fake-readonly-add');const req={onsuccess:null,onerror:null};ops.push({type:'add',store:name,key:String(record.id),value:record,req:req});schedule();return req},
            delete(key){if(mode!=='readwrite')throw new Error('fake-readonly-delete');ops.push({type:'delete',store:name,key:String(key)});schedule()}
          };
        }
      };
      function schedule(){
        if(scheduled)return;scheduled=true;
        setTimeout(()=>{
          scheduled=false;
          if(aborted)return;
          const clone=new Map();for(const name of selected)clone.set(name,new Map(data.get(name)));
          if(mode==='readwrite'){
            for(const op of ops){const rows=clone.get(op.store);if(op.type==='add'&&rows.has(op.key)){tx.error=new Error('constraint');if(op.req&&op.req.onerror)op.req.onerror({target:{error:tx.error}});if(!aborted){aborted=true;stats.abortedTransactions++;if(tx.onabort)tx.onabort({target:tx})}return}if(op.type==='add')rows.set(op.key,op.value);else if(op.type==='delete')rows.delete(op.key)}
            for(const name of selected)data.set(name,clone.get(name));
          }
          for(const item of requests){
            if(item.type==='cursor'||item.done)continue;
            if(!item.req.onsuccess){item.done=true;continue}
            const rows=data.get(item.store);item.req.result=item.type==='keys'?Array.from(rows.keys()):rows.get(item.key);item.req.onsuccess({target:item.req});item.done=true;
          }
          for(const item of requests)if(item.type==='cursor'&&!item.started){item.started=true;dispatchCursor(item,0)}
          finishIfComplete();
        },0);
      }
      function finishIfComplete(){
        if(!completeSent&&requests.every(item=>item.done)){
          completeSent=true;
          if(tx.oncomplete)tx.oncomplete({target:tx});
        }
      }
      function dispatchCursor(item,index){
        setTimeout(()=>{
          if(aborted)return;
          const rows=Array.from(data.get(item.store).entries()).sort((a,b)=>String(a[0])<String(b[0])?-1:(String(a[0])>String(b[0])?1:0));
          if(index>=rows.length){item.req.result=null;if(item.req.onsuccess)item.req.onsuccess({target:item.req});item.done=true;finishIfComplete();return}
          const row=rows[index];let advanced=false;
          item.req.result={primaryKey:row[0],value:row[1],continue(){if(advanced)throw new Error('fake-cursor-continued-twice');advanced=true;dispatchCursor(item,index+1)}};
          if(item.req.onsuccess)item.req.onsuccess({target:item.req});
          if(!advanced){item.done=true;finishIfComplete()}
        },0);
      }
      return tx;
    },
    exportRows(){const out={};for(const [name,rows] of data)out[name]=Array.from(rows.values());return out;}
  };
  const api={databases:async()=>[{name:Schema.DB_NAME}],open(name){assert.strictEqual(name,Schema.DB_NAME);const req={result:db,onupgradeneeded:null,onsuccess:null,onerror:null};setTimeout(()=>req.onsuccess&&req.onsuccess({target:req}),0);return req}};
  return{api,db,stats};
}

let pass=0;
async function check(name,fn){await fn();pass++;console.log('✓ '+name)}

async function main(){
  console.log('P32-W.5 Production Recovery Adapter synthetic tests');
  const source=fixture(),fake=fakeIndexedDB();
  const targetIdentity='com.internalbeyond.desktop|canonical-inno|C:\\Synthetic\\InternalBeyond|1.0.6|'+ 'e'.repeat(64);
  const checkpointMemory={value:null,saves:0,clears:0,async read(){return this.value},async issue(){throw new Error('synthetic native approval issue is not wired')},async openWindow(){return{ok:true}},async closeWindow(){return{ok:true}},async save(value){this.value=value;this.saves++},async markVerified(){},async clear(){this.value=null;this.clears++}};
  const adapter=new AdapterModule.ProductionRecoveryAdapter({indexedDB:fake.api,schema:Schema,engine:Engine,origin:'https://tauri.localhost:43127',targetIdentity:targetIdentity,trustedHost:true,testOnlySyntheticHost:true,checkpointStore:checkpointMemory,testOnlyCompositePlanApi:testCompositePlanApi});

  await check('production target is canonical Tauri origin and opens only an existing v24 DB',async()=>{
    const result=await adapter.prepareProductionTarget();
    assert.strictEqual(result.targetClass,'production');assert.strictEqual(result.origin,'https://tauri.localhost:43127');
    assert.strictEqual(result.targetIdentity,targetIdentity);
    assert.strictEqual(result.databaseName,'InternalBeyondDB');assert.strictEqual(result.schemaVersion,24);
    assert.strictEqual(fake.stats.writeTransactions,0);
  });
  await check('non-Tauri origin and missing DB fail closed without schema creation',async()=>{
    const noDb={databases:async()=>[],open(){throw new Error('must-not-open')}};
    const absent=new AdapterModule.ProductionRecoveryAdapter({indexedDB:noDb,schema:Schema,engine:Engine,origin:'http://127.0.0.1:23120',trustedHost:true,checkpointStore:checkpointMemory});
    await assert.rejects(absent.prepareProductionTarget(),/canonical-tauri-origin-required/);
    const canonicalAbsent=new AdapterModule.ProductionRecoveryAdapter({indexedDB:noDb,schema:Schema,engine:Engine,origin:'http://tauri.localhost',targetIdentity:targetIdentity,trustedHost:true,testOnlySyntheticHost:true,checkpointStore:checkpointMemory});
    await assert.rejects(canonicalAbsent.prepareProductionTarget(),/production-db-not-initialized/);
    let migrationAborted=false;
    const needsUpgrade={databases:async()=>[{name:Schema.DB_NAME}],open(){const req={result:null,onupgradeneeded:null,onsuccess:null,onerror:null};setTimeout(()=>{const transaction={abort(){migrationAborted=true}};req.onupgradeneeded&&req.onupgradeneeded({target:{transaction}})},0);return req}};
    const migration=new AdapterModule.ProductionRecoveryAdapter({indexedDB:needsUpgrade,schema:Schema,engine:Engine,origin:'http://tauri.localhost',targetIdentity:targetIdentity,trustedHost:true,testOnlySyntheticHost:true,checkpointStore:checkpointMemory});
    await assert.rejects(migration.prepareProductionTarget(),/production-schema-migration-forbidden/);
    assert.strictEqual(migrationAborted,true);
  });
  let prepared;
  await check('dry-run targets the production contract but performs read-only key snapshots',async()=>{
    prepared=await adapter.dryRun({compositePlan:source.compositePlan});
    assert.strictEqual(prepared.plan.status,'READY_FOR_EXPLICIT_RESTORE_APPROVAL',JSON.stringify(prepared.plan.errors));
    assert.strictEqual(prepared.plan.target.class,'production');
    assert.strictEqual(prepared.plan.target.origin,'https://tauri.localhost:43127');
    assert.strictEqual(prepared.plan.target.identity,targetIdentity);
    assert.match(prepared.plan.planHash,/^[a-f0-9]{64}$/);
    assert.strictEqual(fake.stats.writeTransactions,0);
    assert.ok(!JSON.stringify(prepared).includes('SYNTHETIC_SECRET'));
  });
  await check('target identity and trust marker reject arbitrary, temporary, and workspace paths',async()=>{
    assert.strictEqual(AdapterModule.testOnly.canonicalTargetIdentity(targetIdentity),true);
    assert.strictEqual(AdapterModule.testOnly.canonicalTargetIdentity('com.internalbeyond.desktop|canonical-inno|E:\\InternalBeyond-main\\dist\\staging|1.0.6|'+'e'.repeat(64)),false);
    assert.strictEqual(AdapterModule.testOnly.canonicalTargetIdentity('com.internalbeyond.desktop|canonical-inno|not-absolute|1.0.6|'+'e'.repeat(64)),false);
    const untrusted=new AdapterModule.ProductionRecoveryAdapter({indexedDB:fake.api,schema:Schema,engine:Engine,origin:'http://tauri.localhost',targetIdentity:targetIdentity,checkpointStore:checkpointMemory});
    await assert.rejects(untrusted.prepareProductionTarget(),/canonical-production-target-identity-required/);
    assert.strictEqual(AdapterModule.testOnly.canonicalOrigin('http://user@tauri.localhost'),false);
  });
  await check('missing approval denies checkpoint/apply before any write',async()=>{
    const gate=adapter.validateBeforeApply(prepared,null,'apply');
    assert.deepStrictEqual(gate,{ok:false,error:'explicit-restore-approval-required',writeAllowed:false});
    await assert.rejects(adapter.createRollbackCheckpoint(prepared,null),/explicit-production-restore-approval-required/);
    await assert.rejects(adapter.applyTransaction(prepared,null),/explicit-restore-approval-required/);
    assert.strictEqual(checkpointMemory.saves,0);assert.strictEqual(fake.stats.writeTransactions,0);
  });
  let approval;
  await check('production issuer is not reachable from CommonJS; scoped execution requires a native RecoveryOnly approval',async()=>{
    assert.strictEqual(AdapterModule.issueExplicitProductionRestoreApproval,undefined);
    await assert.rejects(adapter.issueExplicitProductionRestoreApproval(prepared,{planId:prepared.plan.planId,planHash:prepared.plan.productionBinding.productionPlanHash,confirmation:APPROVAL}),/production-approval-issuer-recoveryonly-required/);
    assert.throws(()=>AdapterModule.testOnly.issueSyntheticTestApproval('not the approval phrase',prepared.plan),/explicit-restore-approval-required/);
    approval=AdapterModule.testOnly.issueSyntheticTestApproval(APPROVAL,prepared.plan,{crypto:globalThis.crypto});
    assert.strictEqual(approval.kind,'SYNTHETIC_TEST_APPROVAL');
    assert.strictEqual(adapter.validateBeforeApply(prepared,approval,'dry-run').ok,true);
    assert.deepStrictEqual(adapter.validateBeforeApply(prepared,approval,'apply'),{ok:true,error:null,writeAllowed:false,requiresScopedWindow:true});
    await assert.rejects(adapter.applyTransaction(prepared,approval),/approved-apply-window-required/);
    await assert.rejects(adapter.rollback(prepared.plan.planId),/approved-apply-window-required/);
    assert.deepStrictEqual(await adapter.verifyAfterApply(prepared,{planId:prepared.plan.planId}),{ok:false,error:'approved-apply-window-required',failures:[]});
    assert.strictEqual(checkpointMemory.saves,0);assert.strictEqual(fake.stats.writeTransactions,0);
  });
  await check('approval is bound to source, plan, target, schema and selected domains; tokens are one-shot',async()=>{
    const makeApproval=()=>AdapterModule.testOnly.issueSyntheticTestApproval(APPROVAL,prepared.plan);
    const one=makeApproval(),plan=prepared.plan;
    for(const mutate of [
      p=>{p.source.sha256='c'.repeat(64)},
      p=>{p.planId='different-plan'},
      p=>{p.planHash='f'.repeat(64)},
      p=>{p.source.size=1},
      p=>{p.source.exportVersion=9},
      p=>{p.compositeBinding.identityAuthority='TAMPERED_AUTHORITY'},
      p=>{p.compositeBinding.supplementalMemorySourceSha256='0'.repeat(64)},
      p=>{p.target.identity='com.internalbeyond.desktop|canonical-inno|C:\\Other\\Root|1.0.6|'+'e'.repeat(64)},
      p=>{p.target.origin='http://tauri.localhost:4444'},
      p=>{p.target.schemaVersion=23},
      p=>{p.selectedDomains=p.selectedDomains.slice(1)}
    ]){
      const changed=JSON.parse(JSON.stringify(plan));mutate(changed);
      assert.strictEqual(AdapterModule.testOnly.validateApproval(one,changed,false),false,mutate.toString());
    }
    const once=makeApproval();
    assert.strictEqual(AdapterModule.testOnly.validateApproval(once,plan,false),true);
    assert.strictEqual(AdapterModule.testOnly.validateApproval(once,plan,true),true);
    assert.strictEqual(AdapterModule.testOnly.validateApproval(once,plan,false),false);
  });
  await check('scoped apply window opens only around the approved callback and closes afterward',async()=>{
    const used=new Set(),scopedFake=fakeIndexedDB();let opens=0,closes=0,inside=false,saved=null,verified=0;
    const scopedStore={async read(){return saved},async issue(){throw new Error('test-only issuer must not call native IPC')},async openWindow(approval,plan){assert.strictEqual(approval.planHash,plan.productionBinding.productionPlanHash);assert.strictEqual(approval.sourceSha256,SOURCE_SHA);if(used.has(approval.token))return{ok:false,error:'approval-replayed'};used.add(approval.token);opens++;inside=true;return{ok:true}},async closeWindow(approval){assert.ok(used.has(approval.token));inside=false;closes++;return{ok:true}},async save(checkpoint){saved=checkpoint},async markVerified(){verified++},async clear(){saved=null}};
    const scoped=new AdapterModule.ProductionRecoveryAdapter({indexedDB:scopedFake.api,schema:Schema,engine:Engine,origin:'https://tauri.localhost:43127',targetIdentity:targetIdentity,trustedHost:true,testOnlySyntheticHost:true,checkpointStore:scopedStore,testOnlyCompositePlanApi:testCompositePlanApi});
    const scopedPlan=await scoped.dryRun({compositePlan:source.compositePlan});
    const scopedApproval=AdapterModule.testOnly.issueSyntheticTestApproval(APPROVAL,scopedPlan.plan);
    assert.strictEqual(AdapterModule.PRODUCTION_APPLY_ENABLED,false);
    assert.strictEqual(scoped.canRequestApprovedApply(),false);
    let transactionResult,verification;
    const checkpoint=await scoped.createRollbackCheckpoint(scopedPlan,scopedApproval);
    assert.strictEqual(checkpoint.lifecycleId,scopedApproval.lifecycleId);
    assert.strictEqual(AdapterModule.testOnly.checkpointMatchesPlan(checkpoint,scopedPlan,scopedApproval.lifecycleId),true);
    assert.strictEqual(AdapterModule.testOnly.checkpointMatchesPlan(checkpoint,scopedPlan,'f'.repeat(32)),false);
    const rollbackReady=await scoped.verifyRollbackCheckpoint(scopedPlan,checkpoint);
    assert.strictEqual(rollbackReady.ok,true);assert.strictEqual(opens,0);assert.strictEqual(inside,false);
    await scoped.withApprovedApplyWindow(scopedPlan,scopedApproval,async()=>{
      inside=true;assert.strictEqual(scoped.validateBeforeApply(scopedPlan,scopedApproval,'apply').writeAllowed,true);
      assert.match(checkpoint.integritySha256,/^[a-f0-9]{64}$/);
      transactionResult=await scoped.applyTransaction(scopedPlan,scopedApproval);
      verification=await scoped.verifyAfterApply(scopedPlan,transactionResult,scopedApproval);
      assert.strictEqual(verification.ok,true);
    });
    assert.strictEqual(inside,false);assert.strictEqual(opens,1);assert.strictEqual(closes,1);
    assert.strictEqual(transactionResult.insertedKeys.chatMessages.length,341);
    assert.strictEqual(verification.credentialState,'NEEDS_REBIND');
    assert.strictEqual(verification.credentialBearingFieldsRestored,0);
    assert.strictEqual(verification.domainResults.length,9);
    assert.ok(verification.domainResults.every(row=>row.stableIdsVerified&&row.referencesVerified));
    assert.strictEqual(verified,1);assert.strictEqual(scopedFake.stats.writeTransactions,1);
    assert.deepStrictEqual(scoped.validateBeforeApply(scopedPlan,scopedApproval,'apply'),{ok:false,error:'explicit-restore-approval-required',writeAllowed:false});
    await assert.rejects(scoped.withApprovedApplyWindow(scopedPlan,scopedApproval,async()=>{}),/explicit-restore-approval-required/);
  });
  await check('RecoveryOnly pre-apply abort clears only its synthetic lifecycle and leaves apply closed',async()=>{
    const abortFake=fakeIndexedDB();let saved=null,aborts=0,opens=0;
    const abortStore={
      async read(){return saved},
      async save(value){saved=value},
      async abort(approval,plan){assert.strictEqual(saved.lifecycleId,approval.lifecycleId);assert.strictEqual(plan.productionBinding.productionPlanHash,approval.planHash);saved=null;aborts++;return{ok:true,aborted:true}},
      async issue(){throw new Error('synthetic abort flow must not invoke native approval')},
      async openWindow(){opens++;return{ok:true}},
      async closeWindow(){return{ok:true}},
      async markVerified(){},
      async clear(){saved=null}
    };
    const abortAdapter=new AdapterModule.ProductionRecoveryAdapter({indexedDB:abortFake.api,schema:Schema,engine:Engine,origin:'https://tauri.localhost:43127',targetIdentity:targetIdentity,trustedHost:true,testOnlySyntheticHost:true,checkpointStore:abortStore,testOnlyCompositePlanApi:testCompositePlanApi});
    const abortPrepared=await abortAdapter.dryRun({compositePlan:source.compositePlan});
    const abortApproval=AdapterModule.testOnly.issueSyntheticTestApproval(APPROVAL,abortPrepared.plan);
    await abortAdapter.createRollbackCheckpoint(abortPrepared,abortApproval);
    const result=await abortAdapter.abortRollbackCheckpoint(abortPrepared,abortApproval);
    assert.strictEqual(result.ok,true);assert.strictEqual(aborts,1);assert.strictEqual(saved,null);
    assert.strictEqual(abortAdapter.checkpoint,null);assert.strictEqual(opens,0);assert.strictEqual(abortFake.stats.writeTransactions,0);
  });
  await check('plan hash changes when payload, domain, or target snapshot changes',async()=>{
    const tampered=JSON.parse(JSON.stringify(prepared));
    tampered.payload.chatMessages[0].content='tampered synthetic body';
    await assert.rejects(adapter.verifyPlanBinding(tampered),/restore-plan-hash-mismatch/);
    assert.strictEqual(await adapter.verifyPlanBinding(prepared),true);
  });
  await check('transaction core is atomic across selected stores and uses insert-only operations',async()=>{
    const writeFake=fakeIndexedDB();
    const result=await AdapterModule.testOnly.applyTransactionCore(writeFake.db,prepared);
    assert.strictEqual(result.ok,true);assert.strictEqual(result.planId,prepared.plan.planId);
    const rows=writeFake.db.exportRows();
    assert.strictEqual(rows.chatMessages.length,341);assert.strictEqual(rows.apiConfigs.length,13);assert.strictEqual(rows.memories.length,4);assert.strictEqual(rows.active_message_history.length,0);
    assert.strictEqual(writeFake.stats.writeTransactions,1);
    assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_SECRET'));
  });
  await check('rollback checkpoint contains metadata/key hashes only and rollback restores the synthetic baseline',async()=>{
    const rollbackFake=fakeIndexedDB({posts:{kept_row:{id:'kept_row',text:'synthetic baseline'}}});
    const rollbackPrepared=Object.assign({},prepared,{targetSnapshot:{databaseName:Schema.DB_NAME,version:Schema.DB_VERSION,stores:{}}});
    const snap=await AdapterModule.testOnly.snapshotDatabase(rollbackFake.db,prepared.plan.selectedDomains,targetIdentity,'https://tauri.localhost:43127');
    rollbackPrepared.targetSnapshot=snap;
    const checkpointApproval=AdapterModule.testOnly.issueSyntheticTestApproval(APPROVAL,prepared.plan);
    const checkpoint=await AdapterModule.testOnly.checkpointMetadata(rollbackPrepared,checkpointApproval);
    assert.strictEqual(checkpoint.transactionId,prepared.plan.transactionId);
    assert.match(checkpoint.integritySha256,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(checkpoint).includes('synthetic body'));
    assert.ok(!JSON.stringify(checkpoint).includes('SYNTHETIC_SECRET'));
    const corrupted=Object.assign({},checkpoint,{beforeStores:checkpoint.beforeStores.map(store=>Object.assign({},store,{keys:['tampered']}))});
    await assert.rejects(AdapterModule.testOnly.rollbackTransactionCore(rollbackFake.db,corrupted),/rollback-checkpoint-integrity-invalid/);
    const applied=await AdapterModule.testOnly.applyTransactionCore(rollbackFake.db,rollbackPrepared);
    assert.strictEqual(applied.ok,true);
    const rolled=await AdapterModule.testOnly.rollbackTransactionCore(rollbackFake.db,checkpoint);
    assert.strictEqual(rolled.ok,true);
    const after=rollbackFake.db.exportRows();
    assert.deepStrictEqual(after.posts,[{id:'kept_row',text:'synthetic baseline'}]);
    assert.strictEqual(after.chatMessages.length,0);assert.strictEqual(after.apiConfigs.length,0);
  });
  await check('a key conflict aborts the entire multi-store transaction',async()=>{
    const conflictFake=fakeIndexedDB({chatMessages:{chat_0:{id:'chat_0',content:'existing synthetic'}}});
    await assert.rejects(AdapterModule.testOnly.applyTransactionCore(conflictFake.db,prepared));
    const rows=conflictFake.db.exportRows();
    assert.strictEqual(rows.chatMessages.length,1);assert.strictEqual(rows.apiConfigs.length,0);assert.strictEqual(rows.groups.length,0);
    assert.strictEqual(conflictFake.stats.abortedTransactions,1);
  });
  await check('first-boot policy is fail-closed, one-shot, and keeps Active quarantined after consumption',async()=>{
    const checkpoint={schema:Boot.CHECKPOINT_SCHEMA,version:1,phase:'PREPARED',planId:'synthetic-plan'};
    const verified={schema:'internalbeyond.recovery-checkpoint-verified',version:1,planId:'synthetic-plan',verifiedAt:'synthetic'};
    assert.strictEqual(Boot.resolvePolicy(checkpoint,null).mode,'BLOCKED');
    const pending=Boot.resolvePolicy(checkpoint,null,verified);
    assert.strictEqual(pending.mode,'FIRST_BOOT_PENDING');assert.strictEqual(Boot.shouldSuppressServices(pending),true);assert.strictEqual(Boot.shouldSuppressActive(pending),true);
    const consumed=Boot.consumeFirstBoot(pending,1700000000000);
    const later=Boot.resolvePolicy(checkpoint,consumed,verified);
    assert.strictEqual(later.mode,'ACTIVE_QUARANTINE');assert.strictEqual(Boot.shouldSuppressServices(later),true);assert.strictEqual(Boot.shouldSuppressActive(later),true);
    assert.strictEqual(Boot.resolvePolicy(null,null).mode,'NORMAL');
    assert.strictEqual(Boot.resolvePolicy(checkpoint,{schema:'bad'}).mode,'BLOCKED');
  });
  await check('Active explicit re-arm requires approval and R3-C and remains disabled in this phase',async()=>{
    const input={recoveryStatus:'COMPLETE',databaseVerification:'PASS',databaseVerificationSha256:'1'.repeat(64),r3cMigrationState:'NOT_STARTED',credentialProviderState:'NEEDS_REBIND',staleActiveEventsCleared:true,planId:'synthetic-plan',targetIdentity};
    assert.strictEqual(Boot.ACTIVE_REARM_ENABLED,false);
    assert.strictEqual(Boot.requestExplicitActiveRearm(input,null).reason,'r3-c-migration-incomplete');
    input.r3cMigrationState='COMPLETE';
    assert.strictEqual(Boot.requestExplicitActiveRearm(input,null).reason,'explicit-active-rearm-required');
    const approvalInput=Object.assign({},input);
    const approval=Boot.issueExplicitActiveRearm(approvalInput,Boot.ACTIVE_REARM_PHRASE,{crypto:{getRandomValues(bytes){bytes.fill(7);return bytes}}});
    const result=Boot.requestExplicitActiveRearm(approvalInput,approval);
    assert.deepStrictEqual(result,{state:'ACTIVE_QUARANTINED',ok:false,reason:'active-rearm-disabled-in-r3b3.2'});
    assert.strictEqual(Boot.requestExplicitActiveRearm(approvalInput,approval).reason,'explicit-active-rearm-required');
  });
  await check('Active/scheduler/provider/stale-event gates execute zero callbacks during recovery hold',async()=>{
    const checkpoint={schema:Boot.CHECKPOINT_SCHEMA,version:1,phase:'PREPARED',planId:'synthetic-plan'};
    const verified={schema:'internalbeyond.recovery-checkpoint-verified',version:1,planId:'synthetic-plan',verifiedAt:'synthetic'};
    const pending=Boot.resolvePolicy(checkpoint,null,verified);
    let active=0,scheduler=0,provider=0,staleEvents=0;
    if(!Boot.shouldSuppressActive(pending)){active++;scheduler++;provider++;staleEvents++}
    assert.deepStrictEqual({active,scheduler,provider,staleEvents},{active:0,scheduler:0,provider:0,staleEvents:0});
    const normal=Boot.resolvePolicy(null,null);
    assert.strictEqual(Boot.shouldSuppressActive(normal),false);
  });
  await check('Host suppresses launcher before spawn and Web Core guards Active entry points before timers or requests',async()=>{
    const host=fs.readFileSync(path.join(ROOT,'src-tauri/src/lib.rs'),'utf8');
    const active=fs.readFileSync(path.join(ROOT,'assets/js/active-diary.js'),'utf8');
    const html=fs.readFileSync(path.join(ROOT,'InternalBeyond.html'),'utf8');
    assert.ok(host.includes('if !recovery_policy.suppress_services() {\n                spawn_existing_launcher(&lifecycle);'));
    assert.ok(host.includes('window.__IB_RECOVERY_FIRST_BOOT__ = {}; window.__IB_RECOVERY_ACTIVE_HOLD__ = {};'));
    assert.ok(host.includes('let restricted_recovery_page = recovery_only || recovery_policy.blocked();'));
    assert.ok(host.includes('window.__IB_RECOVERY_BOOT_BLOCKED__ = {};'));
    assert.ok(html.indexOf('assets/js/recovery-first-boot.js')<html.indexOf('assets/js/active-diary.js'));
    assert.ok(active.indexOf('if(_recoveryActiveHeld())return{ok:false,reason:\'recovery-active-hold\'}')<active.indexOf('async function _activeCompanionRequest'));
    const init=active.slice(active.indexOf('function initActiveMessages()'),active.indexOf('async function init()'));
    assert.ok(init.indexOf('if(_recoveryActiveHeld())')<init.indexOf('setInterval(_activeTick'));
    const tick=active.slice(active.indexOf('async function _activeTick()'),active.indexOf('function _activeNotify'));
    assert.ok(tick.indexOf('if(_recoveryActiveHeld())')<tick.indexOf('_activePullCompanionEvents'));
  });
  console.log('PASS '+pass+' ProductionRecoveryAdapter synthetic checks');
}

main().catch(error=>{console.error(error&&error.stack||error);process.exitCode=1});
