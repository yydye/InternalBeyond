'use strict';

/* P32-W.5-R3-B.2.2 RecoveryEngine pure tests. Synthetic records only. */
const assert=require('assert');
const path=require('path');
const Engine=require(path.join(__dirname,'..','assets','js','recovery-engine.js'));

const domains=Engine.DOMAIN_ORDER.slice();
const SOURCE_HASH='a'.repeat(64);
function manifestFor(backup){
  const recordCounts={};
  for(const d of Engine.DOMAIN_ORDER)if(Array.isArray(backup[d]))recordCounts[d]=backup[d].length;
  return{schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',version:1,source:{
    path:'synthetic://recovery-source.json',size:1234,sha256:SOURCE_HASH,observedExportVersion:8
  },recordCounts:recordCounts};
}
const role={id:'role_1',provider:'custom',model:'synthetic-model',endpoint:'https://example.invalid/v1',nickname:'Synthetic Role',systemPrompt:'fixture only',apiKey:'SENTINEL_SECRET',imageGenApiKey:'SENTINEL_IMAGE_SECRET'};
function fixture(){return{
  version:8,
  apiConfigs:[Object.assign({},role)],
  chatMessages:[{id:'msg_1',role:'user',content:'synthetic',friendId:'role_1',timestamp:1700000000000,threadId:'thread_1'}],
  chatThreads:[{id:'thread_1',friendId:'role_1',name:'Synthetic'}],
  groups:[{id:'group_1',name:'Synthetic group',members:[{characterId:'role_1',status:'active'}]}],
  memories:[{id:'memory_1',characterId:'role_1',content:'synthetic memory'}],
  autoMemory:[{id:'auto_1',friendId:'role_1',content:'synthetic auto memory'}],
  diary_entries:[{id:'diary_1',characterId:'role_1',title:'synthetic',relatedMemoryIds:['memory_1']}],
  moments:[{id:'moment_1',roleId:'role_1',content:'synthetic moment'}],
  roleLetters:[{id:'letter_1',fromRoleId:'role_1',toRoleId:'role_1',content:'synthetic letter'}]
}}
function prepare(backup,selected, targetKeys){return Engine.buildPlan({manifest:manifestFor(backup),sourceVerification:{ok:true,size:1234,sha256:SOURCE_HASH},backup:backup,selectedDomains:selected||domains,targetKeys:targetKeys||{},targetClass:'temporary',targetOrigin:'http://127.0.0.1:49123'})}
let pass=0;
function check(name,fn){fn();pass++;console.log('✓ '+name)}

console.log('P32-W.5 RecoveryEngine unit tests');

check('valid synthetic backup creates metadata plan and secret-free payload',()=>{
  const p=prepare(fixture());
  assert.strictEqual(p.plan.status,'READY_FOR_EXPLICIT_RESTORE_APPROVAL');
  assert.strictEqual(p.plan.domains.length,9);
  assert.deepStrictEqual(p.plan.domains.map(d=>d.validCount),new Array(9).fill(1));
  const serialized=JSON.stringify({plan:p.plan,payload:p.payload});
  assert.ok(!serialized.includes('SENTINEL_SECRET'));
  assert.ok(!serialized.includes('SENTINEL_IMAGE_SECRET'));
  assert.strictEqual(p.payload.apiConfigs[0].apiKey,undefined);
  assert.strictEqual(p.payload.apiConfigs[0].imageGenApiKey,undefined);
  assert.strictEqual(p.plan.credentialBoundary.credentialState,'NEEDS_REBIND');
});

check('all nine approved business domains map to the canonical store names',()=>{
  assert.deepStrictEqual(domains.map(d=>Engine.STORE_BY_DOMAIN[d]),domains);
});

check('missing unselected optional domain is not an error',()=>{
  const b=fixture();delete b.autoMemory;
  const selected=domains.filter(d=>d!=='autoMemory');
  const p=prepare(b,selected);
  assert.strictEqual(p.plan.status,'READY_FOR_EXPLICIT_RESTORE_APPROVAL');
  assert.ok(!p.plan.domains.some(d=>d.domain==='autoMemory'));
});

check('selected missing domain blocks the plan',()=>{
  const b=fixture();delete b.autoMemory;
  const p=prepare(b,domains);
  assert.strictEqual(p.plan.status,'BLOCKED');
  assert.ok(p.plan.errors.includes('selected-section-missing'));
});

check('duplicate stable source ID blocks the plan',()=>{
  const b=fixture();b.chatMessages.push(Object.assign({},b.chatMessages[0]));
  const p=prepare(b);
  assert.strictEqual(p.plan.status,'BLOCKED');
  assert.ok(p.plan.domains.find(d=>d.domain==='chatMessages').sourceDuplicateCount>0);
});

check('dangling friendId blocks the plan',()=>{
  const b=fixture();b.chatMessages[0].friendId='role_missing';
  const p=prepare(b);
  assert.strictEqual(p.plan.status,'BLOCKED');
  assert.ok(p.plan.errors.includes('reference-conflict'));
});

check('dangling threadId blocks the plan',()=>{
  const b=fixture();b.chatMessages[0].threadId='thread_missing';
  const p=prepare(b);
  assert.strictEqual(p.plan.status,'BLOCKED');
  assert.ok(p.plan.domains.find(d=>d.domain==='chatMessages').referenceConflictCount>0);
});

check('group, diary memory, and role-letter references are validated',()=>{
  const b=fixture();b.groups[0].members[0].characterId='role_missing';
  const p=prepare(b);
  assert.strictEqual(p.plan.status,'BLOCKED');
});

check('target ID collision is reported and never becomes overwrite',()=>{
  const p=prepare(fixture(),domains,{chatMessages:['msg_1']});
  assert.strictEqual(p.plan.status,'BLOCKED');
  assert.strictEqual(p.plan.domains.find(d=>d.domain==='chatMessages').targetCollisionCount,1);
  assert.ok(p.plan.domains.find(d=>d.domain==='chatMessages').action==='BLOCKED_CONFLICT');
});

check('unknown API config fields and media references are omitted',()=>{
  const c=Object.assign({},role,{avatar:'data:image/png;base64,AAA',banner:'data:image/png;base64,BBB',unknownPrivateField:'DROP'});
  const p=Engine.projectApiConfig(c);
  assert.strictEqual(p.ok,true);
  assert.strictEqual(p.record.avatar,undefined);
  assert.strictEqual(p.record.banner,undefined);
  assert.strictEqual(p.record.unknownPrivateField,undefined);
});

check('credential-like URL query is omitted from metadata projection',()=>{
  const p=Engine.projectApiConfig(Object.assign({},role,{endpoint:'https://example.invalid/v1?api_key=SENTINEL_SECRET'}));
  assert.strictEqual(p.ok,true);
  assert.strictEqual(p.record.endpoint,undefined);
  assert.ok(!JSON.stringify(p).includes('SENTINEL_SECRET'));
});

check('endpoint URL userinfo is omitted from metadata projection',()=>{
  const p=Engine.projectApiConfig(Object.assign({},role,{endpoint:'https://user:SENTINEL_SECRET@example.invalid/v1'}));
  assert.strictEqual(p.ok,true);
  assert.strictEqual(p.record.endpoint,undefined);
  assert.ok(!JSON.stringify(p).includes('SENTINEL_SECRET'));
});

check('plan contains no message or private business bodies',()=>{
  const b=fixture();b.chatMessages[0].content='PRIVATE_SENTINEL';b.memories[0].content='MEMORY_SENTINEL';
  const p=prepare(b);
  const planJson=JSON.stringify(p.plan);
  assert.ok(!planJson.includes('PRIVATE_SENTINEL'));
  assert.ok(!planJson.includes('MEMORY_SENTINEL'));
});

check('production apply approval is represented as missing in every plan',()=>{
  const p=prepare(fixture());
  assert.deepStrictEqual(p.plan.approval,{required:true,status:'MISSING'});
  assert.strictEqual(p.plan.mutation.productionWrites,0);
});

console.log('PASS '+pass+' RecoveryEngine unit checks');
