'use strict';

/* Synthetic RecoveryEngine/Recovery UI diagnostics tests; no source export or storage is opened. */
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const Engine=require('../assets/js/recovery-engine.js');
const UI=require('../assets/js/recovery-ui.js');
const Adapter=require('../assets/js/recovery-production-adapter.js');
const ROOT=path.resolve(__dirname,'..');
const SOURCE_HASH='a'.repeat(64);

function fixture(){return{
  version:8,
  apiConfigs:[{id:'role_1',provider:'synthetic',model:'offline',endpoint:'https://example.invalid/v1',apiKey:'SYNTHETIC_API_KEY',imageGenApiKey:'SYNTHETIC_IMAGE_KEY'}],
  chatMessages:[{id:'message_1',role:'user',content:'SYNTHETIC_CHAT_BODY',friendId:'role_1',timestamp:1700000000000,threadId:'thread_1'}],
  chatThreads:[{id:'thread_1',friendId:'role_1'}],
  groups:[{id:'group_1',members:[{characterId:'role_1'}]}],
  memories:[{id:'memory_1',characterId:'role_1',content:'SYNTHETIC_MEMORY_BODY'}],
  autoMemory:[{id:'auto_1',friendId:'role_1',content:'synthetic'}],
  diary_entries:[{id:'diary_1',characterId:'role_1',relatedMemoryIds:['memory_1'],content:'SYNTHETIC_DIARY_BODY'}],
  moments:[{id:'moment_1',roleId:'role_1',content:'synthetic'}],
  roleLetters:[{id:'letter_1',fromRoleId:'role_1',toRoleId:'role_1',content:'synthetic'}]
}}
function manifestFor(backup){
  const recordCounts=Object.fromEntries(Engine.DOMAIN_ORDER.filter(domain=>Array.isArray(backup[domain])).map(domain=>[domain,backup[domain].length]));
  return{schema:'internalbeyond.p32-w5.r3b.recovery-source-manifest',version:1,source:{fileName:'synthetic.json',size:1234,sha256:SOURCE_HASH,observedExportVersion:8},recordCounts};
}
function planFor(backup,options){
  options=options||{};
  return Engine.buildPlan({manifest:options.manifest||manifestFor(backup),sourceVerification:{ok:true,size:1234,sha256:SOURCE_HASH},backup,selectedDomains:options.selectedDomains||Engine.DOMAIN_ORDER,targetKeys:options.targetKeys||{},targetClass:'temporary',targetOrigin:'http://127.0.0.1:49123'}).plan;
}
function diagnostics(plan){return plan.diagnostics.entries}
let passed=0;
function check(name,fn){fn();passed++;process.stdout.write('✓ '+name+'\n')}

console.log('P32-W.5 Recovery Planner Diagnostics synthetic tests');

check('duplicate IDs report bounded alias and DUPLICATE_ID category, never the raw ID',()=>{
  const backup=fixture();backup.chatMessages.push(Object.assign({},backup.chatMessages[0],{content:'SYNTHETIC_DUPLICATE_BODY'}));
  const plan=planFor(backup),item=diagnostics(plan).find(d=>d.code==='DUPLICATE_ID');
  assert.strictEqual(plan.status,'BLOCKED');assert.strictEqual(item.domain,'chatMessages');assert.strictEqual(item.recordIdAlias,'chatMessages#000002');assert.strictEqual(item.field,'id');
  assert.strictEqual(item.expected,'unique stable identifier');
  assert.ok(!JSON.stringify(plan.diagnostics).includes('message_1'));
  assert.ok(!JSON.stringify(plan.diagnostics).includes('SYNTHETIC_DUPLICATE_BODY'));
});

check('dangling friendId and threadId identify reference type and safe field only',()=>{
  const friend=fixture();friend.chatMessages[0].friendId='PRIVATE_ROLE_ID';
  const friendPlan=planFor(friend),friendDiag=diagnostics(friendPlan).find(d=>d.code==='DANGLING_REFERENCE');
  assert.strictEqual(friendDiag.field,'friendId');assert.strictEqual(friendDiag.referenceType,'role-or-group');assert.strictEqual(friendDiag.actualClass,'string');
  assert.ok(!JSON.stringify(friendPlan.diagnostics).includes('PRIVATE_ROLE_ID'));
  const thread=fixture();thread.chatMessages[0].threadId='PRIVATE_THREAD_ID';
  const threadPlan=planFor(thread),threadDiag=diagnostics(threadPlan).find(d=>d.code==='DANGLING_REFERENCE');
  assert.strictEqual(threadDiag.field,'threadId');assert.strictEqual(threadDiag.referenceType,'chat-thread');
  assert.ok(!JSON.stringify(threadPlan.diagnostics).includes('PRIVATE_THREAD_ID'));
});

check('missing required fields and type mismatches are distinct classifications',()=>{
  const missing=fixture();delete missing.chatMessages[0].content;
  const missingDiag=diagnostics(planFor(missing)).find(d=>d.code==='MISSING_REQUIRED_FIELD');
  assert.strictEqual(missingDiag.field,'content');assert.strictEqual(missingDiag.actualClass,'missing');
  const mismatch=fixture();mismatch.chatMessages[0].content=[];
  const mismatchDiag=diagnostics(planFor(mismatch)).find(d=>d.code==='TYPE_MISMATCH');
  assert.strictEqual(mismatchDiag.field,'content');assert.strictEqual(mismatchDiag.actualClass,'array');
});

check('credential-bearing input is redacted into field-name-only diagnostics',()=>{
  const backup=fixture();backup.chatMessages[0].credentialToken='SYNTHETIC_CREDENTIAL_VALUE';
  const plan=planFor(backup),json=JSON.stringify(plan.diagnostics);
  const item=diagnostics(plan).find(d=>d.code==='CREDENTIAL_FIELD_REJECTED');
  assert.ok(item);assert.strictEqual(item.field,'credential');assert.strictEqual(item.actualClass,'credential-bearing-field-name');
  assert.ok(!json.includes('SYNTHETIC_CREDENTIAL_VALUE'));assert.ok(!json.includes('credentialToken'));
  const apiPlan=planFor(fixture());
  assert.ok(diagnostics(apiPlan).some(d=>d.code==='CREDENTIAL_FIELD_REJECTED'&&d.severity==='INFO'));
  assert.ok(!JSON.stringify(apiPlan.diagnostics).includes('SYNTHETIC_API_KEY'));
  assert.strictEqual(apiPlan.credentialBoundary.credentialState,'NEEDS_REBIND');
});

check('chat, diary and memory bodies never enter planner diagnostics',()=>{
  const plan=planFor(fixture()),json=JSON.stringify(plan.diagnostics);
  for(const secret of ['SYNTHETIC_CHAT_BODY','SYNTHETIC_DIARY_BODY','SYNTHETIC_MEMORY_BODY'])assert.ok(!json.includes(secret));
});

check('diagnostic collection is bounded while category counts remain complete',()=>{
  const backup=fixture();backup.chatMessages=[];
  for(let i=0;i<140;i++)backup.chatMessages.push({id:'private-id-'+i,role:'user',content:'PRIVATE_BODY_'+i,friendId:'missing-role-'+i,timestamp:1700000000000+i});
  const plan=planFor(backup),d=plan.diagnostics;
  assert.strictEqual(plan.status,'BLOCKED');assert.strictEqual(d.limit,Engine.MAX_DIAGNOSTICS);assert.strictEqual(d.entries.length,Engine.MAX_DIAGNOSTICS);
  assert.strictEqual(d.categoryCounts.DANGLING_REFERENCE,140);assert.strictEqual(d.truncated,true);
  const json=JSON.stringify(d);assert.ok(!json.includes('private-id-'));assert.ok(!json.includes('PRIVATE_BODY_'));assert.ok(!json.includes('missing-role-'));
});

check('schema, unknown domain, unsupported row, target and domain conflicts are categorized',()=>{
  const malformed=fixture();malformed.chatMessages[0]=17;
  const unsupported=planFor(malformed);assert.ok(unsupported.diagnostics.categoryCounts.UNSUPPORTED_RECORD>0);
  const missing=fixture();delete missing.moments;
  assert.ok(planFor(missing).diagnostics.categoryCounts.MISSING_REQUIRED_FIELD>0);
  const collision=planFor(fixture(),{targetKeys:{chatMessages:['message_1']}});
  assert.ok(collision.diagnostics.categoryCounts.TARGET_CONFLICT>0);assert.ok(collision.diagnostics.categoryCounts.DOMAIN_CONFLICT>0);
  const unknown=planFor(fixture(),{selectedDomains:Engine.DOMAIN_ORDER.concat(['runtime'])});
  assert.ok(unknown.diagnostics.categoryCounts.UNKNOWN>0);
  const duplicate=planFor(fixture(),{selectedDomains:Engine.DOMAIN_ORDER.concat(['chatMessages'])});
  assert.ok(duplicate.diagnostics.categoryCounts.PLAN_INVARIANT_FAILED>0);
  const badManifest=manifestFor(fixture());badManifest.version=99;
  assert.ok(planFor(fixture(),{manifest:badManifest}).diagnostics.categoryCounts.SCHEMA_INVALID>0);
});

check('RecoveryOnly UI formats structured category and safe alias without record content',()=>{
  const backup=fixture();backup.chatMessages[0].friendId='private-role-name';
  const plan=planFor(backup);plan.planId='synthetic-plan';plan.transactionId='synthetic-transaction';plan.planHash='c'.repeat(64);
  const output=UI.formatDiagnostics(plan,{size:1234,sha256:SOURCE_HASH,exportVersion:8});
  assert.ok(output.includes('DANGLING_REFERENCE'));assert.ok(output.includes('chatMessages#000001'));assert.ok(output.includes('friendId'));
  assert.ok(!output.includes('private-role-name'));assert.ok(!output.includes('SYNTHETIC_CHAT_BODY'));
  const parsed=JSON.parse(output);assert.strictEqual(parsed.schema,'internalbeyond.p32-w5.r3b.planner-diagnostics');assert.strictEqual(parsed.source.sha256,SOURCE_HASH);
});

check('blocked plan cannot issue approval; static apply switches and mutation counters remain closed',()=>{
  const bad=fixture();bad.chatMessages[0].friendId='missing-role';
  const plan=planFor(bad);plan.executionPhase='R3-B.3';plan.target={class:'production',origin:'http://tauri.localhost',identity:'com.internalbeyond.desktop|canonical-inno|C:\\Install|1.0.6|'+'d'.repeat(64),databaseName:'InternalBeyondDB',schemaVersion:24};
  assert.strictEqual(plan.status,'BLOCKED');
  assert.strictEqual(Adapter.issueExplicitProductionRestoreApproval,undefined);
  assert.throws(()=>Adapter.testOnly.issueSyntheticTestApproval(Adapter.testOnly.APPROVAL_PHRASE,plan),/restore-plan-not-ready/);
  assert.strictEqual(Adapter.PRODUCTION_APPLY_ENABLED,false);assert.strictEqual(plan.mutation.productionWrites,0);assert.strictEqual(plan.mutation.providerCalls,0);
  const rust=fs.readFileSync(path.join(ROOT,'src-tauri','src','lib.rs'),'utf8');
  assert.ok(rust.includes('const PRODUCTION_RESTORE_ENABLED: bool = false'));
});

process.stdout.write('PASS '+passed+' Recovery Planner Diagnostics synthetic checks\n');
