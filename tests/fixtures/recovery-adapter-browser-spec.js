(async function(){
  'use strict';
  var checks=[];
  var externalCalls=0;
  var nativeFetch=window.fetch.bind(window);
  window.fetch=function(url,options){
    try{if(new URL(String(url),location.href).origin!==location.origin)externalCalls++}catch(e){externalCalls++}
    return nativeFetch(url,options);
  };
  function check(name,ok,detail){checks.push({name:name,ok:!!ok,detail:detail||''})}
  function request(req){return new Promise(function(resolve,reject){req.onsuccess=function(){resolve(req.result)};req.onerror=function(){reject(req.error||new Error('request-failed'))}})}
  async function keys(db,store){var tx=db.transaction([store],'readonly');var result=await request(tx.objectStore(store).getAllKeys());return result.map(String)}
  async function storeCount(db,store){return(await keys(db,store)).length}
  function fixture(){return{
    version:8,
    apiConfigs:[{id:'role_1',provider:'custom',model:'synthetic',endpoint:'https://example.invalid/v1',nickname:'Synthetic',systemPrompt:'fixture',apiKey:'SENTINEL_SECRET',imageGenApiKey:'SENTINEL_IMAGE_SECRET'}],
    chatMessages:[{id:'msg_1',role:'user',content:'synthetic chat',friendId:'role_1',timestamp:1700000000000,threadId:'thread_1'}],
    chatThreads:[{id:'thread_1',friendId:'role_1',name:'synthetic thread'}],
    groups:[{id:'group_1',name:'synthetic group',members:[{characterId:'role_1',status:'active'}]}],
    memories:[{id:'memory_1',characterId:'role_1',content:'synthetic memory'}],
    autoMemory:[{id:'auto_1',friendId:'role_1',content:'synthetic auto memory'}],
    diary_entries:[{id:'diary_1',characterId:'role_1',title:'synthetic diary',relatedMemoryIds:['memory_1']}],
    moments:[{id:'moment_1',roleId:'role_1',content:'synthetic moment'}],
    roleLetters:[{id:'letter_1',fromRoleId:'role_1',toRoleId:'role_1',content:'synthetic letter'}]
  }}
  function planInput(){
    var backup=fixture(),recordCounts={};
    IBRecoveryEngine.DOMAIN_ORDER.forEach(function(d){recordCounts[d]=backup[d].length});
    var sourceHash='a'.repeat(64);
    return{
      manifest:{schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',version:1,source:{path:'synthetic://backup.json',size:1234,sha256:sourceHash,observedExportVersion:8},recordCounts:recordCounts},
      sourceVerification:{ok:true,size:1234,sha256:sourceHash},
      backup:backup,selectedDomains:IBRecoveryEngine.DOMAIN_ORDER.slice()
    };
  }
  async function report(){
    var localBefore=JSON.stringify(Object.keys(localStorage).sort().map(function(k){return[k,localStorage.getItem(k)]}));
    localStorage.clear();localStorage.setItem('synthetic-local-storage-sentinel','preserve');
    localBefore=JSON.stringify(Object.keys(localStorage).sort().map(function(k){return[k,localStorage.getItem(k)]}));
    var prodOpenCalls=0;
    var prod=new IBRecoveryWebCoreAdapter.RecoveryWebCoreAdapter({targetClass:'production',indexedDB:{databases:function(){prodOpenCalls++;return Promise.resolve([])},open:function(){prodOpenCalls++;throw new Error('must-not-open')}}});
    var prodOpenDenied=false,prodApplyDenied=false;
    try{await prod.openTemporaryTarget()}catch(e){prodOpenDenied=e.message==='temporary-target-required'}
    try{await prod.apply(null,null)}catch(e){prodApplyDenied=e.message==='production-apply-disabled'}
    check('production adapter cannot open or apply',prodOpenDenied&&prodApplyDenied&&prodOpenCalls===0,prodOpenCalls);

    var adapter=new IBRecoveryWebCoreAdapter.RecoveryWebCoreAdapter({indexedDB:indexedDB,schema:IBWebCoreDbSchema,engine:IBRecoveryEngine,targetClass:'temporary',targetOrigin:location.origin});
    var open=await adapter.openTemporaryTarget();
    check('target is explicitly temporary and schema v24',open.ok&&open.version===24&&open.createdForTemporaryTarget===true,open);
    var schema=await adapter.validateSchema();
    check('shared schema contains all recovery stores',schema.ok&&schema.missingStores.length===0,schema.missingStores);

    var prepared=await adapter.dryRun(planInput());
    check('valid synthetic dry-run covers all nine domains',prepared.plan.status==='READY_FOR_EXPLICIT_RESTORE_APPROVAL'&&prepared.plan.domains.length===9&&prepared.plan.summary.validRecords===9,{status:prepared.plan.status,summary:prepared.plan.summary,errors:prepared.plan.errors,domains:prepared.plan.domains});
    check('dry-run plan contains no record body or secret sentinel',!JSON.stringify(prepared.plan).includes('synthetic chat')&&!JSON.stringify(prepared.plan).includes('SENTINEL_SECRET'),prepared.plan.schema);

    /* Cause an add() failure after earlier store requests have been queued.
       IndexedDB must abort the whole temporary multi-store transaction. */
    adapter._testBeforeAdd=function(info){if(info.store==='moments')throw new Error('synthetic-mid-apply-failure')};
    var midApplyFailed=false;
    try{await adapter.apply(prepared,null)}catch(e){midApplyFailed=String(e&&e.message||e).indexOf('synthetic-mid-apply-failure')>=0}
    var emptyAfterAbort=true;
    for(var i=0;i<IBRecoveryEngine.DOMAIN_ORDER.length;i++)if(await storeCount(adapter.db,IBRecoveryEngine.STORE_BY_DOMAIN[IBRecoveryEngine.DOMAIN_ORDER[i]])!==0)emptyAfterAbort=false;
    check('mid-apply failure rolls back every queued domain',midApplyFailed&&emptyAfterAbort,{midApplyFailed:midApplyFailed,empty:emptyAfterAbort});

    adapter._testBeforeAdd=null;
    prepared=await adapter.dryRun(planInput());
    var applied=await adapter.apply(prepared,null);
    check('temporary apply writes all nine domains in one transaction',applied.ok&&Object.keys(applied.insertedKeys).length===9,applied.insertedKeys);
    var verified=await adapter.verify(prepared,applied);
    check('post-commit verification passes for valid target',verified.ok,verified.failures);
    var apiRows=await request(adapter.db.transaction(['apiConfigs'],'readonly').objectStore('apiConfigs').getAll());
    var serializedApi=JSON.stringify(apiRows);
    check('API config projection strips credential sentinels',!serializedApi.includes('SENTINEL_SECRET')&&!serializedApi.includes('SENTINEL_IMAGE_SECRET')&&apiRows[0].apiKey===undefined&&apiRows[0].imageGenApiKey===undefined,apiRows[0]&&apiRows[0].id);
    var activeCount=await storeCount(adapter.db,'active_message_history');
    var planCount=await storeCount(adapter.db,'active_message_plans');
    check('Active history and plans remain empty',activeCount===0&&planCount===0,{activeCount:activeCount,planCount:planCount});

    /* Force a post-commit verification mismatch, then exercise compensating rollback. */
    var deleteTx=adapter.db.transaction(['groups'],'readwrite');deleteTx.objectStore('groups').delete('group_1');
    await new Promise(function(resolve,reject){deleteTx.oncomplete=resolve;deleteTx.onerror=function(){reject(deleteTx.error)}});
    var verifyFailed=await adapter.verify(prepared,applied);
    check('verification mismatch is detected',!verifyFailed.ok,verifyFailed.failures);
    var rolled=await adapter.rollback(applied);
    var dbList=await indexedDB.databases();
    var noRowsAfterRollback=!dbList.some(function(item){return item&&item.name==='InternalBeyondDB'});
    check('compensating rollback removes only inserted target keys',rolled.ok&&noRowsAfterRollback,{rolledBack:rolled.ok,empty:noRowsAfterRollback});

    var localAfter=JSON.stringify(Object.keys(localStorage).sort().map(function(k){return[k,localStorage.getItem(k)]}));
    check('adapter leaves localStorage unchanged',localBefore===localAfter,localAfter);
    check('no provider or external network request was made',externalCalls===0,externalCalls);
    check('no Home Node SQLite or service process is part of this target',!document.documentElement.innerHTML.includes('home-node.db')&&!document.documentElement.innerHTML.includes('local-services-runner'),location.origin);
    adapter.close();
    var result={ok:checks.every(function(x){return x.ok}),checks:checks,profileOrigin:location.origin,temporaryTarget:'InternalBeyondDB v24',productionProfileAccessed:false,providerCalls:externalCalls,activeStarted:false,bridgeStarted:false,homeNodeStarted:false};
    await nativeFetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  }
  report().catch(async function(error){
    var result={ok:false,error:String(error&&error.stack||error),checks:checks,profileOrigin:location.origin};
    try{await nativeFetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)})}catch(e){}
  });
})();
