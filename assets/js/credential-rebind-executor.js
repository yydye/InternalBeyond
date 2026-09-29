/* CREDENTIAL-REBIND-R1 · minimal production apply executor.
 *
 * Scope is frozen to a single operation: INSERT exactly 13 non-secret
 * `apiConfigs` rows into the RecoveryOnly host's WebView IndexedDB
 * (origin http://tauri.localhost, InternalBeyondDB v24). UPDATE, DELETE,
 * secret fields and a non-empty target are all refused; the Vault is never
 * read, decrypted or written, and no provider/network call is made.
 *
 * This module adds no new recovery system. It reuses the RecoveryOnly host
 * (same origin/IndexedDB) and the shared Web Core schema module.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(typeof globalThis!=='undefined'?globalThis:{});
  else root.IBCredentialRebindExecutor=factory(root);
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(root){
  'use strict';

  var commonJs=typeof module==='object'&&!!module.exports;

  var FROZEN_WRITE_SET_HASH='71e4ded955b90823d4530f59c5c16827a4245ad5759b1b7bc6b9809f7896171b';
  var FROZEN_CONFIG_ID_SET_HASH='75ed7e4984df9b67f65f92408d359135465dae64d634c20770d3103d039c2de8';
  var PLANNED_INSERT=13;
  var CONFIRMATION='执行 CREDENTIAL-REBIND-R1 apiConfigs 13 条 INSERT';
  var TARGET=Object.freeze({
    origin:'http://tauri.localhost',
    databaseName:'InternalBeyondDB',
    schemaVersion:24,
    store:'apiConfigs'
  });
  /* Mirrors assets/js/core.js::_ibCredentialFreeApiConfig blocked-key set. */
  var SECRET_KEY_RE=/^(?:apiKey|api_key|imageGenApiKey|image_gen_api_key|authorization|bearer|accessToken|refreshToken|token|secret|password)$/i;

  function fail(code,detail){
    var error=new Error(detail?code+':'+detail:code);
    error.code=code;
    return error;
  }

  function sha256Hex(text){
    if(commonJs){
      var crypto=require('crypto');
      return Promise.resolve(crypto.createHash('sha256').update(text,'utf8').digest('hex'));
    }
    var subtle=root&&root.crypto&&root.crypto.subtle;
    if(!subtle||typeof TextEncoder!=='function')return Promise.reject(fail('credential-rebind-sha256-unavailable'));
    return subtle.digest('SHA-256',new TextEncoder().encode(text)).then(function(buffer){
      var bytes=new Uint8Array(buffer),hex='';
      for(var i=0;i<bytes.length;i++)hex+=('00'+bytes[i].toString(16)).slice(-2);
      return hex;
    });
  }

  function stableJson(value){
    if(value===null||typeof value!=='object')return JSON.stringify(value===undefined?null:value);
    if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
    var keys=Object.keys(value).sort();
    return '{'+keys.map(function(key){return JSON.stringify(key)+':'+stableJson(value[key])}).join(',')+'}';
  }

  /* Returns the paths of every forbidden (secret) key found anywhere in a row. */
  function findSecretFields(value,path,found){
    found=found||[];
    path=path||'';
    if(value===null||typeof value!=='object')return found;
    if(Array.isArray(value)){
      for(var i=0;i<value.length;i++)findSecretFields(value[i],path+'['+i+']',found);
      return found;
    }
    Object.keys(value).forEach(function(key){
      var here=path?path+'.'+key:key;
      if(SECRET_KEY_RE.test(key))found.push(here);
      findSecretFields(value[key],here,found);
    });
    return found;
  }

  /* Deep copy dropping any forbidden key (belt-and-braces after validation). */
  function nonSecretProjection(value){
    if(value===null||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(nonSecretProjection);
    var out={};
    Object.keys(value).forEach(function(key){if(!SECRET_KEY_RE.test(key))out[key]=nonSecretProjection(value[key])});
    return out;
  }

  function req(request){
    return new Promise(function(resolve,reject){
      request.onsuccess=function(){resolve(request.result)};
      request.onerror=function(){reject(request.error||fail('credential-rebind-idb-request-failed'))};
    });
  }
  function txDone(transaction){
    return new Promise(function(resolve,reject){
      transaction.oncomplete=function(){resolve()};
      transaction.onabort=function(){reject(transaction.error||fail('credential-rebind-idb-transaction-aborted'))};
      transaction.onerror=function(){/* onabort is the terminal result */};
    });
  }

  /* Frozen WriteSet validation. Returns the validated rows + recomputed ID-set digest. */
  async function assertWriteSet(writeSet,options){
    options=options||{};
    var expectedHash=options.expectedWriteSetHash||FROZEN_WRITE_SET_HASH;
    var expectedIdSetHash=options.expectedIdSetHash||FROZEN_CONFIG_ID_SET_HASH;
    if(!writeSet||typeof writeSet!=='object')throw fail('credential-rebind-write-set-missing');
    if(String(writeSet.hash||'').toLowerCase()!==String(expectedHash).toLowerCase())throw fail('credential-rebind-write-set-hash-mismatch');
    var ops=writeSet.operations||{};
    if(Number(ops.INSERT)!==PLANNED_INSERT||Number(ops.UPDATE)!==0||Number(ops.DELETE)!==0)throw fail('credential-rebind-write-set-operations-invalid');
    var rows=Array.isArray(writeSet.rows)?writeSet.rows:[];
    if(rows.length!==PLANNED_INSERT)throw fail('credential-rebind-row-count-invalid',String(rows.length));
    var ids=[],seen=Object.create(null);
    for(var i=0;i<rows.length;i++){
      var row=rows[i];
      if(!row||typeof row!=='object')throw fail('credential-rebind-row-invalid',String(i));
      var id=String(row.id==null?'':row.id);
      if(!id)throw fail('credential-rebind-row-id-missing',String(i));
      if(seen[id])throw fail('credential-rebind-row-id-duplicate',id);
      seen[id]=true;
      ids.push(id);
      var binding=String(row.vaultBindingId==null?row.id:row.vaultBindingId);
      if(binding!==id)throw fail('credential-rebind-binding-mismatch',id);
      if(row.secretProjected===true)throw fail('credential-rebind-secret-projected',id);
      var secrets=findSecretFields(row,'',[]);
      if(secrets.length)throw fail('credential-rebind-secret-field-forbidden',id+' -> '+secrets.join(','));
    }
    var idSetSha256=await sha256Hex(JSON.stringify(ids.slice().sort()));
    if(idSetSha256!==expectedIdSetHash)throw fail('credential-rebind-config-id-set-mismatch');
    return {rows:rows,ids:ids,idSetSha256:idSetSha256};
  }

  class CredentialRebindExecutor{
    constructor(options){
      options=options||{};
      this.writeSet=options.writeSet||null;
      this.expectedWriteSetHash=options.expectedWriteSetHash||FROZEN_WRITE_SET_HASH;
      this.expectedIdSetHash=options.expectedIdSetHash||FROZEN_CONFIG_ID_SET_HASH;
      this.confirmation=options.confirmationPhrase||CONFIRMATION;
      this.schema=options.schema||(root&&root.IBWebCoreDbSchema)||null;
      this.indexedDB=options.indexedDB||(root&&root.indexedDB)||null;
      this.location=options.location||(root&&root.location)||null;
      this.testOnlySyntheticHost=commonJs&&options.testOnlySyntheticHost===true;
      this.hostTrusted=this.testOnlySyntheticHost
        ?options.trustedHost===true
        :!!(root&&root.__IB_TAURI_HOST__===true&&root.__IB_RECOVERY_ONLY__===true);
      this.db=null;
      this.executing=false;
      this.lastVerification=null;
    }

    _requireHost(){
      if(!this.hostTrusted)throw fail('credential-rebind-recoveryonly-host-required');
      if(this.location&&typeof this.location.origin==='string'&&this.location.origin&&this.location.origin!==TARGET.origin){
        throw fail('credential-rebind-origin-mismatch',this.location.origin);
      }
    }

    async _openTarget(){
      if(!this.indexedDB||!this.schema)throw fail('credential-rebind-dependencies-unavailable');
      if(!this.db)this.db=await this.schema.open(this.indexedDB);
      if(this.db.name!==TARGET.databaseName||Number(this.db.version)!==TARGET.schemaVersion)throw fail('credential-rebind-schema-version-mismatch');
      if(!this.db.objectStoreNames.contains(TARGET.store))throw fail('credential-rebind-store-missing',TARGET.store);
      return this.db;
    }

    async _readKeys(){
      var db=await this._openTarget();
      var transaction=db.transaction([TARGET.store],'readonly');
      var keys=await req(transaction.objectStore(TARGET.store).getAllKeys());
      await txDone(transaction);
      return (keys||[]).map(String);
    }

    /* Validates the frozen WriteSet, opens the target and requires an empty store. */
    async preflight(){
      this._requireHost();
      var validated=await assertWriteSet(this.writeSet,{
        expectedWriteSetHash:this.expectedWriteSetHash,
        expectedIdSetHash:this.expectedIdSetHash
      });
      var keys=await this._readKeys();
      return {ok:true,planned:PLANNED_INSERT,currentCount:keys.length,empty:keys.length===0,idSetSha256:validated.idSetSha256};
    }

    /* INSERT-only, scoped to apiConfigs. Aborts (atomic rollback) on any failure;
     * a post-commit verification failure triggers an explicit delete rollback. */
    async execute(confirmation){
      this._requireHost();
      if(this.executing)throw fail('credential-rebind-already-running');
      if(String(confirmation||'')!==this.confirmation)throw fail('credential-rebind-confirmation-required');
      var validated=await assertWriteSet(this.writeSet,{
        expectedWriteSetHash:this.expectedWriteSetHash,
        expectedIdSetHash:this.expectedIdSetHash
      });
      var db=await this._openTarget();
      var current=await this._readKeys();
      if(current.length!==0)throw fail('credential-rebind-target-not-empty',String(current.length));

      this.executing=true;
      var inserted=[];
      try{
        await new Promise(function(resolve,reject){
          var transaction;
          try{transaction=db.transaction([TARGET.store],'readwrite')}
          catch(error){reject(error);return}
          var objectStore=transaction.objectStore(TARGET.store);
          transaction.oncomplete=function(){resolve()};
          transaction.onabort=function(){reject(transaction.error||fail('credential-rebind-idb-transaction-aborted'))};
          transaction.onerror=function(){/* onabort is the terminal result */};
          for(var i=0;i<validated.rows.length;i++){
            var record=nonSecretProjection(validated.rows[i]);
            var request;
            try{request=objectStore.add(record)}
            catch(error){try{transaction.abort()}catch(abortError){};reject(error);return}
            inserted.push(String(record.id));
            request.onerror=function(){try{transaction.abort()}catch(abortError){}};
          }
        });

        var verification=await this.verify(validated.ids);
        if(!verification.ok){
          try{
            await this.rollback(inserted);
          }catch(rollbackError){
            var critical=fail('CREDENTIAL_REBIND_CRITICAL_STOP:rollback-failed',String(rollbackError&&rollbackError.message||rollbackError));
            critical.cause=verification;
            throw critical;
          }
          var rolled=fail('CREDENTIAL_REBIND_FAILED_ROLLED_BACK',JSON.stringify(verification.failures||[]));
          rolled.verification=verification;
          throw rolled;
        }
        return {
          ok:true,
          planned:PLANNED_INSERT,
          actual:verification.actual,
          secretPersisted:0,
          providerCalls:0,
          target:{origin:TARGET.origin,databaseName:TARGET.databaseName,schemaVersion:TARGET.schemaVersion,store:TARGET.store},
          idSetSha256:validated.idSetSha256,
          verification:verification
        };
      }catch(error){
        var alreadyWrapped=!!(error&&/^(CREDENTIAL_REBIND_FAILED_ROLLED_BACK|CREDENTIAL_REBIND_CRITICAL_STOP)/.test(String(error.message||'')));
        if(!alreadyWrapped){
          try{
            var remaining=await this._readKeys();
            if(remaining.length!==0)await this.rollback(inserted);
          }catch(cleanupError){/* the scoped transaction abort already provided atomic rollback */}
        }
        if(alreadyWrapped)throw error;
        var rolled=fail('CREDENTIAL_REBIND_FAILED_ROLLED_BACK',String(error&&error.message||error));
        rolled.cause=error;
        throw rolled;
      }finally{
        this.executing=false;
      }
    }

    /* Readback: every expected id present, count == 13, no secret field stored. */
    async verify(expectedIds){
      var ids=(expectedIds&&expectedIds.length?expectedIds.slice():[]);
      if(!ids.length&&this.writeSet&&Array.isArray(this.writeSet.rows))ids=this.writeSet.rows.map(function(r){return String(r.id)});
      var db=await this._openTarget();
      var failures=[];
      var transaction=db.transaction([TARGET.store],'readonly');
      var objectStore=transaction.objectStore(TARGET.store);
      var keysRequest=objectStore.getAllKeys();
      var rowsRequest=objectStore.getAll();
      var keys=((await req(keysRequest))||[]).map(String);
      var rows=await req(rowsRequest);
      await txDone(transaction);
      var present=Object.create(null);
      keys.forEach(function(key){present[key]=true});
      var missing=ids.filter(function(id){return !present[id]});
      if(missing.length)failures.push({reason:'missing-ids',ids:missing});
      if(keys.length!==PLANNED_INSERT&&!ids.length)failures.push({reason:'count-mismatch',actual:keys.length});
      var secretHits=[];
      (rows||[]).forEach(function(row){
        var found=findSecretFields(row,'',[]);
        if(found.length)secretHits.push({id:String(row&&row.id),fields:found});
      });
      if(secretHits.length)failures.push({reason:'secret-field-persisted',rows:secretHits});
      var result={ok:failures.length===0,planned:PLANNED_INSERT,actual:keys.length,expectedIdsPresent:ids.length-missing.length,failures:failures,secretPersisted:secretHits.length?secretHits.length:0};
      this.lastVerification=result;
      return result;
    }

    /* Deletes only the keys inserted by this run. */
    async rollback(insertedKeys){
      var keys=(insertedKeys||[]).map(String);
      if(!keys.length)return {ok:true,rolledBackKeys:[]};
      var db=await this._openTarget();
      var transaction=db.transaction([TARGET.store],'readwrite');
      var objectStore=transaction.objectStore(TARGET.store);
      keys.forEach(function(key){objectStore.delete(key)});
      await txDone(transaction);
      return {ok:true,rolledBackKeys:keys};
    }

    close(){if(this.db){this.db.close();this.db=null}}
  }

  return Object.freeze({
    CredentialRebindExecutor:CredentialRebindExecutor,
    assertWriteSet:assertWriteSet,
    findSecretFields:findSecretFields,
    nonSecretProjection:nonSecretProjection,
    stableJson:stableJson,
    sha256Hex:sha256Hex,
    FROZEN_WRITE_SET_HASH:FROZEN_WRITE_SET_HASH,
    FROZEN_CONFIG_ID_SET_HASH:FROZEN_CONFIG_ID_SET_HASH,
    PLANNED_INSERT:PLANNED_INSERT,
    CONFIRMATION:CONFIRMATION,
    TARGET:TARGET
  });
});
