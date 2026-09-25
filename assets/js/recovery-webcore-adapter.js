/* P32-W.5 · Recovery-only Web Core IndexedDB adapter.
 * Production writes are intentionally closed in this build. Synthetic tests
 * may use only an explicitly temporary IndexedDB target. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(
    typeof require==='function'?require('./webcore-db-schema.js'):null,
    typeof require==='function'?require('./recovery-engine.js'):null
  );
  else root.IBRecoveryWebCoreAdapter=factory(root.IBWebCoreDbSchema,root.IBRecoveryEngine);
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(schema,engine){
  'use strict';

  var PRODUCTION_APPLY_ENABLED=false;
  var DOMAIN_STORES=engine&&engine.STORE_BY_DOMAIN;

  function req(request){return new Promise(function(resolve,reject){request.onsuccess=function(){resolve(request.result)};request.onerror=function(){reject(request.error||new Error('idb-request-failed'))}})}
  function txDone(transaction){return new Promise(function(resolve,reject){transaction.oncomplete=function(){resolve()};transaction.onabort=function(){reject(transaction.error||new Error('idb-transaction-aborted'))};transaction.onerror=function(){/* onabort supplies the terminal result */}})}
  function sameKeys(a,b){
    var x=(a||[]).map(String).sort(),y=(b||[]).map(String).sort();
    return x.length===y.length&&x.every(function(v,i){return v===y[i]});
  }
  function validProductionApproval(approval,plan){
    if(!approval||approval.kind!=='EXPLICIT_RESTORE_APPROVAL'||!plan)return false;
    if(String(approval.planId||'')!==String(plan.planId||''))return false;
    if(String(approval.sourceSha256||'').toLowerCase()!==String(plan.source&&plan.source.sha256||'').toLowerCase())return false;
    if(String(approval.targetOrigin||'')!==String(plan.target&&plan.target.origin||''))return false;
    if(String(approval.databaseName||'')!==String(plan.target&&plan.target.databaseName||''))return false;
    var approved=(approval.selectedDomains||[]).slice().sort().join('|');
    var selected=(plan.selectedDomains||[]).slice().sort().join('|');
    if(approved!==selected)return false;
    if(!Number.isFinite(Number(approval.expiresAt))||Number(approval.expiresAt)<=Date.now())return false;
    return true;
  }

  function TemporaryIndexedDBAdapter(options){
    options=options||{};
    this.indexedDB=options.indexedDB||null;
    this.schema=options.schema||schema;
    this.engine=options.engine||engine;
    this.targetClass=String(options.targetClass||'unknown');
    this.targetOrigin=String(options.targetOrigin||'');
    this.db=null;
    this.dbWasCreated=false;
    this._testBeforeAdd=typeof options.testBeforeAdd==='function'?options.testBeforeAdd:null;
  }

  TemporaryIndexedDBAdapter.prototype.openTemporaryTarget=async function(){
    if(this.targetClass!=='temporary')throw new Error('temporary-target-required');
    if(!this.indexedDB||!this.schema)throw new Error('recovery-dependencies-unavailable');
    if(typeof this.indexedDB.databases!=='function')throw new Error('idb-databases-enumeration-required');
    var before=await this.indexedDB.databases();
    this.dbWasCreated=!before.some(function(x){return x&&x.name===this.schema.DB_NAME}.bind(this));
    this.db=await this.schema.open(this.indexedDB);
    return {ok:true,name:this.db.name,version:this.db.version,createdForTemporaryTarget:this.dbWasCreated};
  };

  TemporaryIndexedDBAdapter.prototype.validateSchema=function(){
    if(this.targetClass!=='temporary')return Promise.reject(new Error('temporary-target-required'));
    if(!this.db)return Promise.resolve({ok:false,error:'database-not-open'});
    var missing=this.schema.STORE_NAMES.filter(function(name){return !this.db.objectStoreNames.contains(name)}.bind(this));
    return Promise.resolve({ok:missing.length===0&&this.db.name===this.schema.DB_NAME&&this.db.version===this.schema.DB_VERSION,
      databaseName:this.db.name,version:this.db.version,missingStores:missing});
  };

  TemporaryIndexedDBAdapter.prototype.snapshotTarget=async function(selectedDomains){
    if(this.targetClass!=='temporary')throw new Error('temporary-target-required');
    if(!this.db)throw new Error('database-not-open');
    var stores=(selectedDomains||[]).map(function(domain){return DOMAIN_STORES[domain]}).filter(Boolean);
    if(!stores.length)return{databaseName:this.db.name,version:this.db.version,stores:{}};
    var transaction=this.db.transaction(stores,'readonly');
    var result={databaseName:this.db.name,version:this.db.version,stores:{}};
    await Promise.all(stores.map(async function(storeName){
      var objectStore=transaction.objectStore(storeName);
      var keys=await req(objectStore.getAllKeys()).then(function(xs){return xs.map(String).sort()});
      result.stores[storeName]={count:keys.length,keys:keys};
    }));
    await txDone(transaction);
    return result;
  };

  TemporaryIndexedDBAdapter.prototype.dryRun=async function(input){
    if(this.targetClass!=='temporary')throw new Error('temporary-target-required');
    var schemaResult=await this.validateSchema();
    if(!schemaResult.ok)throw new Error('target-schema-invalid');
    var selected=(input&&input.selectedDomains)||this.engine.DOMAIN_ORDER;
    var snapshot=await this.snapshotTarget(selected);
    var targetKeys={};
    Object.keys(snapshot.stores).forEach(function(store){targetKeys[store]=snapshot.stores[store].keys});
    var prepared=this.engine.buildPlan({
      manifest:input&&input.manifest,
      sourceVerification:input&&input.sourceVerification,
      backup:input&&input.backup,
      selectedDomains:selected,
      targetKeys:targetKeys,
      targetClass:this.targetClass,
      targetOrigin:this.targetOrigin
    });
    prepared.targetSnapshot=snapshot;
    return prepared;
  };

  TemporaryIndexedDBAdapter.prototype.apply=function(prepared,approval){
    if(this.targetClass==='production'){
      if(!PRODUCTION_APPLY_ENABLED)return Promise.reject(new Error('production-apply-disabled'));
      if(!validProductionApproval(approval,prepared&&prepared.plan))return Promise.reject(new Error('explicit-restore-approval-invalid'));
    }else if(this.targetClass!=='temporary')return Promise.reject(new Error('unknown-target-class'));
    if(!this.db||!prepared||!prepared.plan||prepared.plan.mode!=='dry-run'||prepared.plan.status!=='READY_FOR_EXPLICIT_RESTORE_APPROVAL')return Promise.reject(new Error('restore-plan-not-applicable'));
    var self=this,selected=prepared.plan.selectedDomains||[],stores=selected.map(function(domain){return DOMAIN_STORES[domain]});
    if(!stores.length)return Promise.reject(new Error('empty-domain-selection'));
    return this.snapshotTarget(selected).then(function(current){
      if(!prepared.targetSnapshot||stores.some(function(store){return !sameKeys(current.stores[store]&&current.stores[store].keys,prepared.targetSnapshot.stores[store]&&prepared.targetSnapshot.stores[store].keys)}))throw new Error('target-changed-after-dry-run');
      return new Promise(function(resolve,reject){
        var transaction;
        var inserted={};
        stores.forEach(function(store){inserted[store]=[]});
        try{
          transaction=self.db.transaction(stores,'readwrite');
          stores.forEach(function(store){
            var domain=selected.find(function(d){return DOMAIN_STORES[d]===store});
            var records=prepared.payload&&prepared.payload[domain]||[];
            var objectStore=transaction.objectStore(store);
            records.forEach(function(record,index){
              if(self._testBeforeAdd)self._testBeforeAdd({store:store,domain:domain,index:index,record:record});
              var request=objectStore.add(record);
              inserted[store].push(String(record.id));
              request.onerror=function(){try{transaction.abort()}catch(e){}};
            });
          });
        }catch(error){try{if(transaction)transaction.abort()}catch(abortError){};reject(error);return}
        transaction.oncomplete=function(){resolve({ok:true,planId:prepared.plan.planId,insertedKeys:inserted,databaseWasCreatedByAdapter:self.dbWasCreated})};
        transaction.onabort=function(){reject(transaction.error||new Error('idb-transaction-aborted'))};
        transaction.onerror=function(){/* onabort is the terminal result */};
      });
    });
  };

  TemporaryIndexedDBAdapter.prototype.verify=async function(prepared,transactionResult){
    if(this.targetClass!=='temporary')throw new Error('temporary-target-required');
    if(!this.db||!transactionResult||transactionResult.planId!==prepared.plan.planId)return{ok:false,error:'transaction-identity-mismatch'};
    var failures=[];
    for(var i=0;i<prepared.plan.selectedDomains.length;i++){
      var domain=prepared.plan.selectedDomains[i],store=DOMAIN_STORES[domain];
      var expected=(prepared.targetSnapshot.stores[store].keys||[]).concat(transactionResult.insertedKeys[store]||[]).map(String).sort();
      var actual=(await req(this.db.transaction([store],'readonly').objectStore(store).getAllKeys())).map(String).sort();
      if(!sameKeys(expected,actual))failures.push({domain:domain,expectedCount:expected.length,actualCount:actual.length});
    }
    return{ok:failures.length===0,failures:failures,planId:prepared.plan.planId};
  };

  TemporaryIndexedDBAdapter.prototype.rollback=async function(transactionResult){
    if(this.targetClass!=='temporary')throw new Error('temporary-target-required');
    if(!this.db||!transactionResult||!transactionResult.insertedKeys)throw new Error('rollback-pointer-invalid');
    var stores=Object.keys(transactionResult.insertedKeys);
    if(stores.length){
      var transaction=this.db.transaction(stores,'readwrite');
      stores.forEach(function(store){transactionResult.insertedKeys[store].forEach(function(key){transaction.objectStore(store).delete(key)})});
      await txDone(transaction);
    }
    if(transactionResult.databaseWasCreatedByAdapter){
      this.db.close();this.db=null;
      await new Promise(function(resolve,reject){
        var request=this.indexedDB.deleteDatabase(this.schema.DB_NAME);
        request.onsuccess=function(){resolve()};request.onerror=function(){reject(request.error||new Error('temporary-db-delete-failed'))};request.onblocked=function(){reject(new Error('temporary-db-delete-blocked'))};
      }.bind(this));
    }
    return{ok:true,rolledBackKeys:transactionResult.insertedKeys};
  };

  TemporaryIndexedDBAdapter.prototype.close=function(){if(this.db){this.db.close();this.db=null}};

  return Object.freeze({TemporaryIndexedDBAdapter:TemporaryIndexedDBAdapter,RecoveryWebCoreAdapter:TemporaryIndexedDBAdapter,PRODUCTION_APPLY_ENABLED:PRODUCTION_APPLY_ENABLED,validProductionApproval:validProductionApproval});
});
