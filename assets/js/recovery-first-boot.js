/* P32-W.5 · recovery first-boot policy shared by Host-facing Web Core and tests.
 * It carries metadata only; it never reads Active plans, credentials or IDB. */
(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.IBRecoveryFirstBoot=api;
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(root){
  'use strict';
  var CHECKPOINT_SCHEMA='internalbeyond.recovery-checkpoint';
  var CONSUMED_SCHEMA='internalbeyond.recovery-first-boot-consumed';
  var ACTIVE_PHASES=['PREPARED','APPLIED','VERIFIED','ROLLBACK_REQUIRED'];
  var ACTIVE_REARM_ENABLED=false;
  var ACTIVE_REARM_PHRASE='EXPLICIT_ACTIVE_REARM';
  var activeRearmApprovals=new Map();

  function blocked(reason){return Object.freeze({mode:'BLOCKED',reason:reason||'recovery-state-invalid',suppressServices:true,suppressActive:true,firstBootPending:false,activeQuarantined:true})}
  function resolvePolicy(checkpoint,consumed,verified){
    if(checkpoint==null&&consumed==null)return Object.freeze({mode:'NORMAL',reason:null,suppressServices:false,suppressActive:false,firstBootPending:false,activeQuarantined:false});
    if(!checkpoint||typeof checkpoint!=='object'||Array.isArray(checkpoint))return blocked('checkpoint-missing-or-invalid');
    if(checkpoint.schema!==CHECKPOINT_SCHEMA||Number(checkpoint.version)!==1||typeof checkpoint.planId!=='string'||!checkpoint.planId)return blocked('checkpoint-schema-invalid');
    if(!ACTIVE_PHASES.includes(String(checkpoint.phase||'')))return blocked('checkpoint-phase-invalid');
    if(!verified||verified.schema!=='internalbeyond.recovery-checkpoint-verified'||Number(verified.version)!==1||verified.planId!==checkpoint.planId||typeof verified.verifiedAt!=='string')return blocked('restore-not-verified');
    if(!consumed)return Object.freeze({mode:'FIRST_BOOT_PENDING',reason:null,suppressServices:true,suppressActive:true,firstBootPending:true,activeQuarantined:true,planId:checkpoint.planId});
    if(consumed.schema!==CONSUMED_SCHEMA||Number(consumed.version)!==1||consumed.planId!==checkpoint.planId||typeof consumed.consumedAt!=='string')return blocked('first-boot-consumed-marker-invalid');
    return Object.freeze({mode:'ACTIVE_QUARANTINE',reason:null,suppressServices:true,suppressActive:true,firstBootPending:false,activeQuarantined:true,planId:checkpoint.planId});
  }

  function consumeFirstBoot(policy,now){
    if(!policy||policy.mode!=='FIRST_BOOT_PENDING'||!policy.planId)throw new Error('first-boot-marker-not-pending');
    return Object.freeze({schema:CONSUMED_SCHEMA,version:1,planId:policy.planId,consumedAt:new Date(Number(now)||Date.now()).toISOString()});
  }

  function shouldSuppressActive(policy){return !policy||policy.suppressActive!==false}
  function shouldSuppressServices(policy){return !policy||policy.suppressServices===true}

  function activeRearmReadiness(input){
    input=input||{};var reasons=[];
    if(input.recoveryStatus!=='COMPLETE')reasons.push('recovery-not-complete');
    if(input.databaseVerification!=='PASS'||!/^([a-f0-9]{64})$/i.test(String(input.databaseVerificationSha256||'')))reasons.push('restored-database-not-verified');
    if(input.r3cMigrationState!=='COMPLETE')reasons.push('r3-c-migration-incomplete');
    if(!['NEEDS_REBIND','PROVIDER_READY','NOT_REQUIRED'].includes(String(input.credentialProviderState||'')))reasons.push('credential-provider-boundary-unresolved');
    if(input.staleActiveEventsCleared!==true)reasons.push('stale-active-events-not-cleared');
    var parts=String(input.targetIdentity||'').split('|');
    if(typeof input.planId!=='string'||!input.planId||parts.length!==5||parts[0]!=='com.internalbeyond.desktop'||parts[1]!=='canonical-inno'||!/^\d+\.\d+\.\d+$/.test(parts[3])||! /^[a-f0-9]{64}$/i.test(parts[4])||! /^[A-Za-z]:\\[^|]+$/.test(parts[2]))reasons.push('recovery-target-identity-invalid');
    return Object.freeze({state:'ACTIVE_QUARANTINED',validated:reasons.length===0,reasons:Object.freeze(reasons)});
  }
  function activeRearmToken(cryptoProvider){
    var provider=cryptoProvider||root.crypto;
    if(!provider||typeof provider.getRandomValues!=='function')throw new Error('active-rearm-secure-random-unavailable');
    var bytes=new Uint8Array(32);provider.getRandomValues(bytes);
    return Array.from(bytes).map(function(byte){return byte.toString(16).padStart(2,'0')}).join('');
  }
  function issueExplicitActiveRearm(input,confirmation,options){
    var readiness=activeRearmReadiness(input);
    if(!readiness.validated)throw new Error(readiness.reasons[0]);
    if(String(confirmation||'')!==ACTIVE_REARM_PHRASE)throw new Error('explicit-active-rearm-required');
    options=options||{};
    var token=activeRearmToken(options.crypto),approval=Object.freeze({
      kind:'EXPLICIT_ACTIVE_REARM',token:token,planId:String(input.planId),targetIdentity:String(input.targetIdentity),
      databaseVerificationSha256:String(input.databaseVerificationSha256).toLowerCase(),r3cMigrationState:String(input.r3cMigrationState),
      credentialProviderState:String(input.credentialProviderState),staleActiveEventsCleared:true,
      expiresAt:Date.now()+Math.min(Math.max(Number(options.ttlMs)||300000,1000),600000)
    });
    activeRearmApprovals.set(token,{approval:approval,consumed:false});
    return approval;
  }
  function requestExplicitActiveRearm(input,approval){
    var readiness=activeRearmReadiness(input);
    if(!readiness.validated)return Object.freeze({state:'ACTIVE_QUARANTINED',ok:false,reason:readiness.reasons[0]});
    var record=approval&&activeRearmApprovals.get(String(approval.token||''));
    if(!record||record.consumed||record.approval!==approval||Number(approval.expiresAt)<=Date.now()||approval.kind!=='EXPLICIT_ACTIVE_REARM'||approval.planId!==input.planId||approval.targetIdentity!==input.targetIdentity||approval.databaseVerificationSha256!==String(input.databaseVerificationSha256).toLowerCase()||approval.r3cMigrationState!==input.r3cMigrationState||approval.credentialProviderState!==input.credentialProviderState||approval.staleActiveEventsCleared!==true)return Object.freeze({state:'ACTIVE_QUARANTINED',ok:false,reason:'explicit-active-rearm-required'});
    record.consumed=true;activeRearmApprovals.delete(String(approval.token));
    if(!ACTIVE_REARM_ENABLED)return Object.freeze({state:'ACTIVE_QUARANTINED',ok:false,reason:'active-rearm-disabled-in-r3b3.2'});
    return Object.freeze({state:'ACTIVE_READY',ok:true,planId:String(input.planId)});
  }

  function policyFromWindow(hostWindow){
    var w=hostWindow||{};
    if(w.__IB_RECOVERY_BOOT_BLOCKED__===true)return blocked('host-recovery-state-blocked');
    if(w.__IB_RECOVERY_FIRST_BOOT__===true)return Object.freeze({mode:'FIRST_BOOT_PENDING',reason:null,suppressServices:true,suppressActive:true,firstBootPending:true,activeQuarantined:true});
    if(w.__IB_RECOVERY_ACTIVE_HOLD__===true)return Object.freeze({mode:'ACTIVE_QUARANTINE',reason:null,suppressServices:true,suppressActive:true,firstBootPending:false,activeQuarantined:true});
    return resolvePolicy(null,null);
  }

  async function acknowledgeFirstBoot(policy,invoke){
    if(!policy||policy.mode!=='FIRST_BOOT_PENDING')return{ok:true,skipped:true,mode:policy&&policy.mode||'NORMAL'};
    if(typeof invoke!=='function')return{ok:false,error:'first-boot-ack-unavailable'};
    try{
      var result=await invoke('acknowledge_recovery_first_boot',{planId:policy.planId});
      return result&&result.ok===true?result:{ok:false,error:'first-boot-ack-rejected'};
    }catch(error){return{ok:false,error:'first-boot-ack-failed'}}
  }

  return Object.freeze({
    CHECKPOINT_SCHEMA:CHECKPOINT_SCHEMA,
    CONSUMED_SCHEMA:CONSUMED_SCHEMA,
    resolvePolicy:resolvePolicy,
    consumeFirstBoot:consumeFirstBoot,
    shouldSuppressActive:shouldSuppressActive,
    shouldSuppressServices:shouldSuppressServices,
    policyFromWindow:policyFromWindow,
    acknowledgeFirstBoot:acknowledgeFirstBoot,
    ACTIVE_REARM_ENABLED:ACTIVE_REARM_ENABLED,
    ACTIVE_REARM_PHRASE:ACTIVE_REARM_PHRASE,
    activeRearmReadiness:activeRearmReadiness,
    issueExplicitActiveRearm:issueExplicitActiveRearm,
    requestExplicitActiveRearm:requestExplicitActiveRearm
  });
});
