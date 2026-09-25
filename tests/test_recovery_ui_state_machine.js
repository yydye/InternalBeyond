'use strict';

/* Synthetic-only P5.6 RecoveryOnly UI flow tests. No source backup or IndexedDB. */
const assert=require('assert');
const Engine=require('../assets/js/recovery-engine.js');
const UI=require('../assets/js/recovery-ui.js');

const domains=Engine.DOMAIN_ORDER.slice();
const domainCounts={apiConfigs:2,chatMessages:1,chatThreads:1,groups:1,memories:2,autoMemory:1,diary_entries:1,moments:1,roleLetters:1};
const provenanceRanges=[];
domains.forEach(domain=>{
  provenanceRanges.push({domain,source:'PRIMARY_2026_09_02',recordCount:domainCounts[domain]-(domain==='apiConfigs'||domain==='memories'?1:0)});
  if(domain==='apiConfigs')provenanceRanges.push({domain,source:'SUPPLEMENTAL_ROLE_2026_09_03',recordCount:1});
  if(domain==='memories')provenanceRanges.push({domain,source:'SUPPLEMENTAL_MEMORY_2026_08_27',recordCount:1});
});
const hiddenPayload={chatMessages:[{content:'SYNTHETIC_PRIVATE_BODY'}]};
const syntheticPlan={
  schema:'internalbeyond.p32-w5.r3b.composite-recovery-plan',
  planIdentity:{id:'synthetic-frozen-id',sha256:'a'.repeat(64)},
  backup:hiddenPayload
};
const summary={
  primarySource:{fileName:'synthetic-primary.json',size:1,sha256:'b'.repeat(64)},
  supplementalSources:[{kind:'role-metadata',fileName:'synthetic-role.json',size:1,sha256:'c'.repeat(64)},{kind:'memory',fileName:'synthetic-memory.json',size:1,sha256:'d'.repeat(64)}],
  identitySuccession:[{oldId:'old_role',newId:'new_role',authority:'USER_CONFIRMED_IDENTITY_SUCCESSION',status:'EXPLICIT_USER_CONFIRMATION',systemConfirmed:false}],
  selectedDomains:domains,planIdentity:{id:'synthetic-frozen-id',sha256:'a'.repeat(64)},
  summary:{domainCounts:domainCounts},provenance:{recordCount:11,traceDigest:'d'.repeat(64),ranges:provenanceRanges}
};
const compositeApi={
  async buildFromFiles(files){
    if(!files||files.length!==3)return{ok:false,error:'composite-source-count-invalid'};
    return{ok:true,packagePlan:syntheticPlan,summary:summary};
  },
  async validate(plan){return plan===syntheticPlan?{ok:true}:{ok:false,error:'composite-plan-validation-failed'}}
};
function readyPlan(){return{
  mode:'dry-run',status:'READY_FOR_EXPLICIT_RESTORE_APPROVAL',planId:'r3b3:'+ 'e'.repeat(64),transactionId:'r3b3-tx:'+'e'.repeat(64),planHash:'f'.repeat(64),
  compositeBinding:{frozenPlanId:'synthetic-frozen-id',frozenPlanSha256:'a'.repeat(64),identityAuthority:'USER_CONFIRMED_IDENTITY_SUCCESSION',identityStatus:'EXPLICIT_USER_CONFIRMATION'},
  productionBinding:{id:'r3b3:'+'e'.repeat(64),targetSnapshotSha256:'1'.repeat(64),productionPlanHash:'e'.repeat(64)},
  target:{origin:'http://tauri.localhost',identity:'canonical synthetic target',databaseName:'InternalBeyondDB',schemaVersion:24},
  selectedDomains:domains,
  summary:{sourceRecords:11,targetCollisions:0,referenceConflicts:0,sourceDuplicates:0,rejectedRecords:0},
  credentialBoundary:{credentialState:'NEEDS_REBIND',secretValuesProjected:0},
  domains:domains.map(domain=>({domain,sourceCount:domainCounts[domain],validCount:domainCounts[domain],targetCollisionCount:0,referenceConflictCount:0,sourceDuplicateCount:0,rejectedCount:0,action:'INSERT'}))
}}
function adapter(){return{
  PRODUCTION_APPLY_ENABLED:false,inputs:[],dryRuns:0,
  async dryRun(input){this.dryRuns++;this.inputs.push(input);return{plan:readyPlan(),payload:{}}}
}}
function applyExecutor(){return{
  approvals:0,executions:0,pending:null,
  async requestApproval(prepared,request){
    if(request.planId!==prepared.plan.planId)throw new Error('approval-plan-id-mismatch');
    if(request.planHash!==prepared.plan.productionBinding.productionPlanHash)throw new Error('approval-plan-hash-mismatch');
    if(request.confirmation!=='EXECUTE_SYNTHETIC_RESTORE')throw new Error('explicit-approval-required');
    this.approvals++;this.pending={planId:request.planId,planHash:request.planHash};
    return{ok:true,planId:request.planId,planHash:request.planHash,tokenExposed:false};
  },
  async execute(prepared){
    if(!this.pending||this.pending.planId!==prepared.plan.planId)throw new Error('approval-missing');
    this.executions++;this.pending=null;
    return{ok:true,planId:prepared.plan.planId,transactionId:prepared.plan.transactionId,activeQuarantined:true,domains:[]};
  }
}}
function finalConfirmation(view,overrides){
  const model=UI.buildRecoveryPreviewModel(view.plan,view.composite);
  return Object.assign({
    planIdentityReviewed:true,targetSnapshotReviewed:true,identitySuccessionReviewed:true,credentialBoundaryReviewed:true,
    confirmation:UI.FINAL_RESTORE_CONFIRMATION,planId:model.planId,planSha256:model.planSha256,targetSnapshotSha256:model.targetSnapshotSha256,sourceCount:model.sourceCount,provenanceCount:model.provenanceCount,
    oldIdentity:model.identitySuccession.oldId,newIdentity:model.identitySuccession.newId,identityAuthority:model.identitySuccession.authority,identityStatus:model.identitySuccession.status,credentialState:model.credentialBoundary.state
  },overrides||{});
}
const files=[{name:'primary.json'},{name:'role.json'},{name:'memory.json'}];

let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name)}
async function run(){
  console.log('P32-W.5-P5.6 RecoveryOnly UI synthetic tests');
  const stub=adapter(),executor=applyExecutor();
  const machine=UI.createStateMachine({domains:domains,compositePlanApi:compositeApi,adapter:stub,executor:executor});
  await check('single backup selection is rejected',async()=>{
    const result=await machine.selectSource({name:'single.json'});
    assert.strictEqual(result.state,'FAILED');
    assert.strictEqual(stub.dryRuns,0);
  });
  await check('missing supplemental files fail before production target access',async()=>{
    const result=await machine.selectCompositeFiles(files.slice(0,2));
    assert.strictEqual(result.state,'FAILED');
    assert.strictEqual(stub.dryRuns,0);
  });
  await check('valid composite package is accepted as an immutable read-only summary',async()=>{
    const result=await machine.selectCompositeFiles(files);
    assert.strictEqual(result.ok,true);assert.strictEqual(result.state,'PLAN');
    assert.strictEqual(machine.view().composite.planIdentity.id,'synthetic-frozen-id');
    assert.ok(!JSON.stringify(machine.view()).includes('SYNTHETIC_PRIVATE_BODY'));
    assert.strictEqual(machine.view().approvalReady,false);
  });
  await check('production dry-run receives only the validated composite package',async()=>{
    const result=await machine.dryRun();
    assert.strictEqual(result.ok,true);assert.strictEqual(result.state,'APPROVAL_REQUIRED');
    assert.deepStrictEqual(Object.keys(stub.inputs[0]),['compositePlan']);
    assert.strictEqual(stub.inputs[0].compositePlan,syntheticPlan);
    assert.strictEqual(machine.view().checkpointCreated,false);
  });
  await check('production plan dry-run never auto-issues approval or opens apply',async()=>{
    assert.strictEqual(executor.approvals,0);assert.strictEqual(executor.executions,0);
    assert.strictEqual(machine.view().approvalReady,false);
    assert.strictEqual(machine.view().checkpointCreated,false);
    assert.strictEqual(machine.view().productionApplyEnabled,false);
  });
  await check('final restore confirmation is bound, explicit, and does not issue native approval',async()=>{
    const view=machine.view(),model=UI.buildRecoveryPreviewModel(view.plan,view.composite);
    assert.strictEqual(model.ok,true);assert.strictEqual(model.complete,true);
    assert.strictEqual(model.sourceCount,11);assert.strictEqual(model.provenanceCount,11);
    assert.ok(model.domains.some(row=>row.domain==='autoMemory'));
    assert.ok(!JSON.stringify(model).includes('SYNTHETIC_PRIVATE_BODY'));
    const blocked=await machine.approve({planId:view.plan.planId,planHash:view.plan.productionBinding.productionPlanHash,confirmation:'EXECUTE_SYNTHETIC_RESTORE'});
    assert.strictEqual(blocked.error,'final-restore-confirmation-required');assert.strictEqual(executor.approvals,0);
    const denied=machine.confirmFinalRestore(finalConfirmation(view,{targetSnapshotReviewed:false}));
    assert.strictEqual(denied.ok,false);assert.strictEqual(executor.approvals,0);
    const confirmed=machine.confirmFinalRestore(finalConfirmation(view));
    assert.strictEqual(confirmed.ok,true);assert.strictEqual(confirmed.finalRestoreConfirmationComplete,true);
    assert.strictEqual(confirmed.state,'APPROVAL_REQUIRED');assert.strictEqual(confirmed.approvalReady,false);
    assert.strictEqual(confirmed.checkpointCreated,false);assert.strictEqual(executor.approvals,0);assert.strictEqual(executor.executions,0);
    assert.strictEqual((await machine.apply()).error,'explicit-production-restore-approval-required');
  });
  await check('approval rejects a wrong plan id or hash and keeps current plan pending',async()=>{
    const wrongId=await machine.approve({planId:'other',planHash:'e'.repeat(64),confirmation:'EXECUTE_SYNTHETIC_RESTORE'});
    assert.strictEqual(wrongId.ok,false);assert.strictEqual(machine.view().state,'APPROVAL_REQUIRED');
    const wrongHash=await machine.approve({planId:preparedPlanId(machine.view()),planHash:'0'.repeat(64),confirmation:'EXECUTE_SYNTHETIC_RESTORE'});
    assert.strictEqual(wrongHash.ok,false);assert.strictEqual(machine.view().state,'APPROVAL_REQUIRED');
    const wrongPhrase=await machine.approve({planId:preparedPlanId(machine.view()),planHash:'e'.repeat(64),confirmation:'wrong phrase'});
    assert.strictEqual(wrongPhrase.ok,false);assert.strictEqual(machine.view().state,'APPROVAL_REQUIRED');
    assert.strictEqual(executor.approvals,0);
  });
  await check('typed approval is one-time and restore runs only after the separate execute action',async()=>{
    const current=machine.view().plan;
    const issued=await machine.approve({planId:current.planId,planHash:current.productionBinding.productionPlanHash,confirmation:'EXECUTE_SYNTHETIC_RESTORE'});
    assert.strictEqual(issued.ok,true);assert.strictEqual(issued.state,'APPROVED');assert.strictEqual(issued.tokenExposed,false);
    assert.strictEqual(executor.approvals,1);assert.strictEqual(executor.executions,0);
    const result=await machine.apply();
    assert.strictEqual(result.ok,true);assert.strictEqual(result.state,'RESTORED');
    assert.strictEqual(executor.executions,1);assert.strictEqual(machine.view().restoreReport.activeQuarantined,true);
  });
  await check('approval denials expose only an allowlisted reason code and cannot enable apply',async()=>{
    const deniedExecutor={async requestApproval(){throw new Error('APPROVAL_TRACE_STAGE_NATIVE_CONFIRMATION:APPROVAL_NATIVE_CONFIRMATION_UNAVAILABLE secret=do-not-render')}};
    const deniedMachine=UI.createStateMachine({domains:domains,compositePlanApi:compositeApi,adapter:adapter(),executor:deniedExecutor});
    await deniedMachine.selectCompositeFiles(files);
    await deniedMachine.dryRun();
    const plan=deniedMachine.view().plan;
    deniedMachine.confirmFinalRestore(finalConfirmation(deniedMachine.view()));
    const denied=await deniedMachine.approve({planId:plan.planId,planHash:plan.productionBinding.productionPlanHash,confirmation:UI.APPROVAL_TEXT});
    assert.strictEqual(denied.ok,false);
    assert.strictEqual(denied.state,'APPROVAL_REQUIRED');
    assert.strictEqual(denied.error.code,'APPROVAL_NATIVE_CONFIRMATION_UNAVAILABLE');
    assert.strictEqual(denied.error.stage,'NATIVE_CONFIRMATION');
    assert.ok(!JSON.stringify(denied).includes('do-not-render'));
    assert.strictEqual(deniedMachine.view().approvalReady,false);
    assert.strictEqual(deniedMachine.view().checkpointCreated,false);
    assert.strictEqual(deniedMachine.view().productionApplyEnabled,false);
    const unknown=new Error('APPROVAL_TRACE_STAGE_PLAN_REVALIDATION:private business body');
    assert.strictEqual(UI.approvalDenialReason(unknown),'APPROVAL_INTERNAL_DENIAL');
    assert.strictEqual(UI.approvalDenialStage(unknown),'PLAN_REVALIDATION');
    assert.strictEqual(UI.approvalDenialReason(new Error('APPROVAL_TOKEN_PROVENANCE_DIGEST_MISMATCH')),'APPROVAL_TOKEN_PROVENANCE_DIGEST_MISMATCH');
    assert.strictEqual(UI.approvalDenialReason(new Error('CHECKPOINT_LIFECYCLE_CLEANUP_FAILED')),'CHECKPOINT_LIFECYCLE_CLEANUP_FAILED');
    assert.strictEqual(UI.approvalDiagnosticCode(new Error('APPROVAL_TRACE_STAGE_CHECKPOINT_WRITE:APPROVAL_ISSUED_BINDING_TARGET_IDENTITY_MISMATCH token=synthetic-secret')),'APPROVAL_ISSUED_BINDING_TARGET_IDENTITY_MISMATCH');
  });
  await check('apply failure surfaces only the safe predicate code, never token or attached payload text',async()=>{
    const failedExecutor={
      async requestApproval(prepared,request){return{ok:true,planId:request.planId,planHash:request.planHash,tokenExposed:false}},
      async execute(){throw new Error('APPROVAL_TOKEN_PROVENANCE_DIGEST_MISMATCH token=synthetic-secret body=SYNTHETIC_PRIVATE_BODY')}
    };
    const failedMachine=UI.createStateMachine({domains:domains,compositePlanApi:compositeApi,adapter:adapter(),executor:failedExecutor});
    await failedMachine.selectCompositeFiles(files);
    await failedMachine.dryRun();
    const plan=failedMachine.view().plan;
    failedMachine.confirmFinalRestore(finalConfirmation(failedMachine.view()));
    await failedMachine.approve({planId:plan.planId,planHash:plan.productionBinding.productionPlanHash,confirmation:UI.APPROVAL_TEXT});
    const result=await failedMachine.apply();
    assert.strictEqual(result.state,'FAILED');
    assert.strictEqual(result.error.code,'production-restore-execution-failed');
    assert.strictEqual(result.error.diagnosticCode,'APPROVAL_TOKEN_PROVENANCE_DIGEST_MISMATCH');
    assert.strictEqual(result.error.detail,'APPROVAL_TOKEN_PROVENANCE_DIGEST_MISMATCH');
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_BODY'));
  });
  console.log('PASS '+passed+' RecoveryOnly UI synthetic checks');
}
function preparedPlanId(view){return view&&view.plan&&view.plan.planId||''}
run().catch(error=>{console.error(error&&error.stack||error);process.exitCode=1});
