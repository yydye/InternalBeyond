/* P32-W.5 · RecoveryOnly-only production apply orchestrator.
 * This module does not enable global apply. Every mutation is scoped by the
 * native one-use approval window and the durable plan-bound checkpoint. */
(function(root,factory){
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.IBRecoveryApplyExecutor=api;
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(root){
  'use strict';

  var commonJs=typeof module==='object'&&!!module.exports;
  var APPROVAL_KIND='EXPLICIT_PRODUCTION_RESTORE_APPROVAL';
  var CONFIRMATION='执行 R3-B.3 production restore';

  class RecoveryOnlyApplyExecutor{
    constructor(adapter,options){
      options=options||{};
      this.adapter=adapter||null;
      this.testOnlySyntheticHost=commonJs&&options.testOnlySyntheticHost===true;
      this.hostTrusted=this.testOnlySyntheticHost
        ?options.trustedHost===true
        :!!(root&&root.__IB_TAURI_HOST__===true&&root.__IB_RECOVERY_ONLY__===true&&
          this.adapter&&this.adapter.hostTrusted===true&&
          root.__IB_RECOVERY_TARGET_IDENTITY__===this.adapter.targetIdentity);
      this.approval=null;
      this.executing=false;
      this.lastCheckpoint=null;
      this.lastRollback=null;
    }

    _requireRecoveryOnly(){
      if(!this.adapter||!this.hostTrusted||!this.adapter.hostTrusted||
        this.adapter.PRODUCTION_APPLY_ENABLED!==false){
        throw new Error('recoveryonly-scoped-executor-required');
      }
    }

    async requestApproval(prepared,request){
      this._requireRecoveryOnly();
      if(this.executing||this.approval)throw new Error('production-approval-already-pending');
      if(!prepared||!prepared.plan||prepared.plan.mode!=='dry-run'||
        prepared.plan.status!=='READY_FOR_EXPLICIT_RESTORE_APPROVAL'||
        prepared.plan.executionPhase!=='R3-B.3'){
        throw new Error('production-dry-run-plan-required');
      }
      request=request||{};
      const expectedHash=String(prepared.plan.productionBinding&&prepared.plan.productionBinding.productionPlanHash||'').toLowerCase();
      if(String(request.planId||'')!==String(prepared.plan.planId||''))throw new Error('approval-plan-id-mismatch');
      if(String(request.planHash||'').toLowerCase()!==expectedHash)throw new Error('approval-plan-hash-mismatch');
      if(String(request.confirmation||'')!==CONFIRMATION)throw new Error('explicit-production-restore-approval-required');

      const issued=await this.adapter.issueExplicitProductionRestoreApproval(prepared,request);
      if(!issued||issued.kind!==APPROVAL_KIND||issued.planId!==prepared.plan.planId||
        String(issued.planHash||'').toLowerCase()!==expectedHash||!issued.token){
        throw new Error('native-approval-binding-invalid');
      }
      this.approval=issued;
      return Object.freeze({
        ok:true,
        planId:issued.planId,
        planHash:issued.planHash,
        expiresAt:issued.expiresAt,
        tokenExposed:false,
        applyWindowOpened:false,
        checkpointCreated:false
      });
    }

    async execute(prepared){
      this._requireRecoveryOnly();
      if(this.executing)throw new Error('recovery-apply-already-running');
      if(!this.approval)throw new Error('explicit-production-restore-approval-required');
      if(!prepared||!prepared.plan||prepared.plan.planId!==this.approval.planId||
        String(prepared.plan.productionBinding&&prepared.plan.productionBinding.productionPlanHash||'').toLowerCase()!==String(this.approval.planHash||'').toLowerCase()){
        throw new Error('approval-plan-binding-mismatch');
      }
      this.executing=true;
      const approval=this.approval;
      let checkpoint=null;
      this.lastRollback=null;
      try{
        checkpoint=await this.adapter.createRollbackCheckpoint(prepared,approval);
        this.lastCheckpoint=checkpoint;
        const checkpointVerification=await this.adapter.verifyRollbackCheckpoint(prepared,checkpoint);
        if(!checkpointVerification||checkpointVerification.ok!==true){
          const reason='rollback-checkpoint-prestate-verification-failed:'+
            String(checkpointVerification&&checkpointVerification.error||'unknown');
          if(typeof this.adapter.abortRollbackCheckpoint!=='function'){
            throw new Error('RECOVERY_CRITICAL_STOP:checkpoint-lifecycle-abort-unavailable');
          }
          try{
            const aborted=await this.adapter.abortRollbackCheckpoint(prepared,approval);
            if(!aborted||aborted.ok!==true)throw new Error('native-checkpoint-abort-not-confirmed');
            this.lastCheckpoint=null;
          }catch(abortError){
            throw new Error('RECOVERY_CRITICAL_STOP:checkpoint-lifecycle-abort-failed:'+
              String(abortError&&abortError.message||abortError));
          }
          throw new Error(reason);
        }

        const transactionResult=await this.adapter.withApprovedApplyWindow(prepared,approval,async()=>{
          let applied=null;
          try{
            applied=await this.adapter.applyTransaction(prepared,approval);
            const verification=await this.adapter.verifyAfterApply(prepared,applied,approval);
            if(!verification||verification.ok!==true){
              throw new Error('post-restore-verification-failed:'+
                JSON.stringify(verification&&verification.failures||[]));
            }
            return{applied:applied,verification:verification};
          }catch(error){
            try{
              const rollback=await this.adapter.rollback(prepared.plan.planId);
              if(!rollback||rollback.ok!==true)throw new Error('rollback-returned-not-ok');
              this.lastRollback=rollback;
              this.lastCheckpoint=null;
              const rolled=new Error('PRODUCTION_RESTORE_FAILED_ROLLED_BACK:'+String(error&&error.message||error));
              rolled.rollback=rollback;
              throw rolled;
            }catch(rollbackError){
              if(String(rollbackError&&rollbackError.message||'').startsWith('PRODUCTION_RESTORE_FAILED_ROLLED_BACK:'))throw rollbackError;
              const critical=new Error('RECOVERY_CRITICAL_STOP:rollback-failed:'+String(rollbackError&&rollbackError.message||rollbackError));
              critical.cause=error;
              throw critical;
            }
          }
        });
        const report={
          ok:true,
          planId:prepared.plan.planId,
          planHash:prepared.plan.productionBinding.productionPlanHash,
          transactionId:prepared.plan.transactionId,
          checkpoint:{planId:checkpoint.planId,integritySha256:checkpoint.integritySha256,createdAt:checkpoint.createdAt},
          domains:transactionResult.verification.domainResults,
          credentialState:transactionResult.verification.credentialState,
          credentialBearingFieldsRestored:transactionResult.verification.credentialBearingFieldsRestored,
          applyWindowClosed:true,
          activeQuarantined:true
        };
        this.approval=null;
        return report;
      }catch(error){
        this.approval=null;
        throw error;
      }finally{
        this.executing=false;
      }
    }

    close(){
      if(!this.executing)this.approval=null;
    }
  }

  return Object.freeze({
    RecoveryOnlyApplyExecutor:RecoveryOnlyApplyExecutor,
    APPROVAL_KIND:APPROVAL_KIND,
    CONFIRMATION:CONFIRMATION
  });
});
