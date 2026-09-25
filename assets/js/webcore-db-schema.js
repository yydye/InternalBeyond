/* Shared Web Core IndexedDB schema. Normal startup and the recovery adapter
 * must use the same store/index declaration. This module performs no open or
 * write until its open() function is explicitly called. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.IBWebCoreDbSchema=factory();
})(typeof self!=='undefined'?self:(typeof globalThis!=='undefined'?globalThis:this),function(){
  'use strict';

  var DB_NAME='InternalBeyondDB';
  var DB_VERSION=24;
  var STORE_NAMES=[
    'posts','categories','about','music','apiSettings','chatMessages','letters',
    'apiConfigs','groups','blogComments','memories','chatThreads','chatSummaries',
    'uploadedFiles','blogAnnotations','projects','projectFiles','autoMemory',
    'calEvents','calNotes','calLedger','active_message_settings',
    'active_message_history','active_message_plans','diary_entries','moments',
    'roleLetters','roleLetterMemories','activities','favorites','understandings',
    'threads','disclosureFacts'
  ];
  var INDEXES=[
    ['chatMessages','byFriend','friendId'],
    ['projectFiles','byProject','projectId'],
    ['autoMemory','byFriend','friendId'],
    ['understandings','byCharacter','characterId'],
    ['threads','byCharacter','characterId'],
    ['active_message_settings','byCharacter','character_id'],
    ['active_message_history','bySetting','setting_id'],
    ['active_message_plans','byCharacter','characterId'],
    ['diary_entries','byCharacter','characterId'],
    ['diary_entries','byDate','date'],
    ['moments','byRole','roleId'],
    ['moments','byCreated','createdAt'],
    ['roleLetters','byTo','toRoleId'],
    ['roleLetters','byFrom','fromRoleId'],
    ['roleLetterMemories','byCharacter','characterId'],
    ['activities','byRole','roleId'],
    ['activities','byType','type'],
    ['favorites','byRole','roleId'],
    ['favorites','byType','type']
  ];

  function keyPathFor(store){
    if(store==='categories')return 'name';
    if(store==='disclosureFacts')return 'factId';
    return 'id';
  }

  function upgrade(db,transaction){
    STORE_NAMES.forEach(function(name){
      if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:keyPathFor(name),autoIncrement:false});
    });
    INDEXES.forEach(function(spec){
      var store=transaction.objectStore(spec[0]);
      if(!store.indexNames.contains(spec[1]))store.createIndex(spec[1],spec[2],{unique:false});
    });
  }

  function open(indexedDBApi,options){
    options=options||{};
    var api=indexedDBApi;
    if(!api||typeof api.open!=='function')return Promise.reject(new Error('indexeddb-unavailable'));
    return new Promise(function(resolve,reject){
      var request;
      try{request=api.open(DB_NAME,DB_VERSION)}catch(error){reject(error);return}
      request.onupgradeneeded=function(event){
        try{upgrade(event.target.result,event.target.transaction)}
        catch(error){try{event.target.transaction.abort()}catch(abortError){};reject(error)}
      };
      request.onblocked=function(event){if(typeof options.onblocked==='function')options.onblocked(event)};
      request.onsuccess=function(){resolve(request.result)};
      request.onerror=function(){reject(request.error||new Error('indexeddb-open-failed'))};
    });
  }

  return Object.freeze({
    DB_NAME:DB_NAME,
    DB_VERSION:DB_VERSION,
    STORE_NAMES:STORE_NAMES.slice(),
    INDEXES:INDEXES.map(function(v){return v.slice()}),
    keyPathFor:keyPathFor,
    upgrade:upgrade,
    open:open
  });
});
