/*
 * Data-presence policy shared by Browser and Tauri.
 *
 * A runtime/boot/settings marker is not evidence that user business data ever
 * existed.  This module is deliberately pure so the policy can be tested
 * without opening a browser profile or IndexedDB.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.IBDataPresence=factory();
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(){
  'use strict';

  var MARKER_KEY='ib_hasEverHadBusinessData_v1';
  var BUSINESS_STORES=[
    'posts','chatMessages','letters','apiConfigs','groups','blogComments',
    'memories','chatThreads','chatSummaries','uploadedFiles','blogAnnotations',
    'projectFiles','autoMemory','calEvents','calNotes','calLedger',
    'diary_entries','moments','roleLetters','roleLetterMemories','activities',
    'favorites','understandings','threads','disclosureFacts'
  ];

  function isBusinessRecord(store,record){
    if(BUSINESS_STORES.indexOf(String(store||''))<0)return false;
    if(!record||typeof record!=='object')return false;
    /* letters has a built-in sample; it must not create user-history evidence. */
    if(store==='letters'&&(record.isDemo===true||record.id==='__demo_deleted__'))return false;
    return true;
  }

  function markerPresent(value){return value===true||value===1||value==='1'}

  function decide(input){
    var o=input||{};
    if(o.resetRecently)return{warn:false,reason:'recent-reset'};
    if(Number(o.businessCount)>0)return{warn:false,reason:'business-data-present'};
    if(!markerPresent(o.marker))return{warn:false,reason:'no-business-history'};
    if(o.muted)return{warn:false,reason:'guard-muted'};
    return{warn:true,reason:'business-history-but-empty'};
  }

  return Object.freeze({
    MARKER_KEY:MARKER_KEY,
    BUSINESS_STORES:BUSINESS_STORES.slice(),
    isBusinessRecord:isBusinessRecord,
    markerPresent:markerPresent,
    decide:decide
  });
});
