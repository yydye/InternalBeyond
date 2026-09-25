/* RecoveryOnly bootstrap. Page load is inert; its explicit UI controls source
 * validation and dry-run while production apply remains disabled. */
(function(root){
  'use strict';
  var status=document.getElementById('status');
  var hostMarked=root.__IB_RECOVERY_ONLY__===true;
  var bootBlocked=root.__IB_RECOVERY_BOOT_BLOCKED__===true;
  var productionApplyEnabled=!!(root.IBProductionRecoveryAdapter&&root.IBProductionRecoveryAdapter.PRODUCTION_APPLY_ENABLED);
  var result={
    mode:bootBlocked?'RECOVERY_BOOT_BLOCKED':(hostMarked?'RECOVERY_ONLY':'UNTRUSTED_ENTRY'),
    normalRuntimeStarted:false,
    productionApplyEnabled:productionApplyEnabled,
    indexedDbOpened:false,
    networkEnabled:false
  };
  if(status){
    status.textContent=bootBlocked
      ?'Recovery state is incomplete or invalid. Services remain stopped; no database or source was opened.'
      :(hostMarked
      ?'RECOVERY_ONLY verified. Services are stopped. Production apply is locked.'
      :'Recovery-only host marker missing. This page is inert and cannot apply data.');
  }
  if(hostMarked&&!bootBlocked&&root.IBRecoveryUI)root.IBRecoveryUI.mount();
  root.IBRecoveryShell=Object.freeze({status:function(){return Object.assign({},result)}});
})(window);
