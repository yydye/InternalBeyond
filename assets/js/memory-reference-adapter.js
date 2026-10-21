/* Memory UI data adapter · current Runtime read only */
(function(root){
  'use strict';
  var NS=root.IB||(root.IB={});
  var viewState={scene:{lib:'coast',fathom:'sky'}};
  var fathomRemote=null;
  function safeText(value){return value==null?'':String(value)}
  function finite(value,fallback){var n=Number(value);return Number.isFinite(n)?n:fallback}
  function coastlineRecord(row){
    if(!row||typeof row!=='object'||row.id==null||String(row.id)==='')return null;
    var summary=safeText(row.summary).trim();
    var content=summary||safeText(row.content).replace(/\s+/g,' ').trim().slice(0,160);
    return {
      id:String(row.id),
      title:safeText(row.title).slice(0,40),
      domain:safeText(row.domain),
      importance:finite(row.importance,5),
      pinned:row.pinned===true,
      created:finite(row.eventTime,finite(row.created,finite(row.createdAt,0))),
      summary:summary,
      content:content
    };
  }
  function readMemories(){
    if(typeof root.dbGetAll!=='function')return Promise.resolve({status:'unavailable',items:[],reason:'memory-reader-unavailable'});
    try{
      return Promise.resolve(root.dbGetAll('memories')).then(function(rows){
        if(!Array.isArray(rows))return{status:'unavailable',items:[],reason:'memory-reader-returned-no-list'};
        return{status:'ok',items:rows.map(coastlineRecord).filter(Boolean)};
      },function(){return{status:'unavailable',items:[],reason:'memory-read-failed'}});
    }catch(e){return Promise.resolve({status:'unavailable',items:[],reason:'memory-read-failed'})}
  }
  function currentScope(){
    var id='';
    try{if(typeof activeFriendId!=='undefined'&&activeFriendId)id=String(activeFriendId)}catch(e){}
    var group=id.indexOf('group_')===0;
    var roles=[];try{roles=Array.isArray(apiConfigs)?apiConfigs:[]}catch(e){roles=Array.isArray(root.apiConfigs)?root.apiConfigs:[]}
    if(!id&&roles.length)id=String(roles[0].id||'');
    var cfg=roles.find(function(row){return row&&String(row.id||'')===id})||null;
    return{id:id,group:group,name:cfg?safeText(cfg.nickname||cfg.model):'',ok:!!id};
  }
  function fathomFailure(snapshot,scope,fallback){
    snapshot=snapshot&&typeof snapshot==='object'?snapshot:{};
    var reason=safeText(snapshot.error||snapshot.reason||fallback||'fathom-read-failed');
    var status=finite(snapshot.status,0),kind='request';
    if(reason==='role-scope-unavailable')kind='scope';
    else if(status===401||status===403||/unauthenticated|forbidden|desktop-token-required/i.test(reason))kind='authorization';
    else if(status===503||/store-closed|store-unavailable|fathom-storage-unavailable|fathom-unavailable/i.test(reason))kind='not-ready';
    else if(status===404||status===501||/fathom-reader-unavailable|fathom-history-unavailable|unsupported/i.test(reason))kind='unsupported';
    else if(status===0&&/timeout/i.test(reason))kind='timeout';
    else if(status===0&&/offline|unreachable|network|transport/i.test(reason))kind='unreachable';
    return{status:'unavailable',failureKind:kind,httpStatus:status>0?status:null,reason:reason,error:reason,scope:scope||null};
  }
  function readFathom(){
    var scope=currentScope();
    if(!scope.ok)return Promise.resolve(fathomFailure(null,scope,'role-scope-unavailable'));
    if(!fathomRemote){try{var create=NS.createMemoryRemote||root.createMemoryRemote;if(typeof create==='function')fathomRemote=create({})}catch(e){}}
    if(!fathomRemote||typeof fathomRemote.fathomSnapshot!=='function')return Promise.resolve(fathomFailure(null,scope,'fathom-reader-unavailable'));
    return Promise.resolve(fathomRemote.fathomSnapshot(scope.id,{limit:80})).then(function(snapshot){
      if(!snapshot||snapshot.ok!==true)return fathomFailure(snapshot,scope,'fathom-read-failed');
      return Object.assign({},snapshot,{status:'ok',scope:scope});
    },function(error){return fathomFailure(null,scope,error&&error.name==='AbortError'?'timeout':'home-node-transport-error')});
  }
  function benchmark(query,expectedIds){
    var scope=currentScope(),runtime=NS.homeNode&&NS.homeNode.runtime;
    query=String(query||'').trim().slice(0,1200);
    expectedIds=Array.isArray(expectedIds)?Array.from(new Set(expectedIds.map(String))):[];
    if(!scope.ok)return Promise.resolve({ok:false,error:'role-scope-unavailable'});
    if(!query)return Promise.resolve({ok:false,error:'query-required'});
    if(!runtime||typeof runtime.runMemoryRecall!=='function')return Promise.resolve({ok:false,error:'recall-unavailable'});
    var requestId='fathom-benchmark-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    return Promise.resolve(runtime.runMemoryRecall({
      mode:'shadow',characterId:scope.id,requestId:requestId,conversationId:'fathom-benchmark',
      message:query,isGroup:scope.group
    },{timeoutMs:5000})).then(function(result){
      if(!result||result.ok!==true||!Array.isArray(result.selectedIds))return{ok:false,error:result&&result.error||'recall-failed'};
      var boundary=result.boundary||{};
      if(boundary.pureShadow!==true||Number(boundary.activationWrites||0)!==0
        ||Number(boundary.exposureWrites||0)!==0||Number(boundary.providerCalls||0)!==0
        ||String(boundary.sessionMutation||'')!=='NONE')return{ok:false,error:'shadow-boundary-not-confirmed'};
      var actual=Array.from(new Set(result.selectedIds.map(String)));
      var expected=new Set(expectedIds);
      return{
        ok:true,scope:scope,channel:result.channel||null,
        counts:result.counts||null,
        actual:actual,expected:Array.from(expected),
        hits:actual.filter(function(id){return expected.has(id)}),
        missed:Array.from(expected).filter(function(id){return actual.indexOf(id)<0}),
        falseRecalls:actual.filter(function(id){return !expected.has(id)})
      };
    },function(){return{ok:false,error:'recall-failed'}});
  }
  var api={
    version:'memory-reference-adapter-1.0.0',
    role:'READ_ONLY_PRESENTATION_ADAPTER',
    writes:0,
    readMemories:readMemories,
    readFathom:readFathom,
    benchmark:benchmark,
    currentScope:currentScope,
    setScene:function(view,scene){view=view==='fathom'?'fathom':'lib';viewState.scene[view]=scene==='coast'?'coast':'sky';return viewState.scene[view]},
    scene:function(view){view=view==='fathom'?'fathom':'lib';return viewState.scene[view]},
    capabilities:function(){return{memories:'READ_ONLY',strands:'UNAVAILABLE_EMPTY_STATE',tidebook:'UNAVAILABLE_EMPTY_STATE',writes:false}}
  };
  if(typeof NS.expose==='function')NS.expose('memoryReferenceAdapter',api);else NS.memoryReferenceAdapter=api;
})(window);
