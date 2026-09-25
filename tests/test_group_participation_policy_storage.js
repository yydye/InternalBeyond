'use strict';

/* Internal Beyond · P24-M3.4.3 · Group Participation Policy Storage 测试
   （browser 组：真实页面 + 真实 social.js storage helpers + 真实 IndexedDB +
     mock provider；运行：node tests/test_group_participation_policy_storage.js）

   本阶段只建立 **group-owned** participation policy 的存储契约：
     · canonical owner = group object（groups store，keyPath='id'，schemaless）；
     · shape = { maxResponders?, recentSpeakerWindow? }（非负有限整数；0 是显式值）；
     · 字段缺失 = 未配置；两字段都缺 ⇒ 删除整个键（绝不存 {}、绝不 backfill 老群）；
     · 唯一 validation authority = IBGroupRuntime.validateParticipationPolicyFragment；
     · 唯一 storage authority = social.js 的 set/clear helpers（无第二套 store/cache）；
     · production 只从**已加载**的 group object 读取，不新增 policy DB 读。
   覆盖用户给定 ST1–ST40。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const A_ID = 'friend_m343_a';
const B_ID = 'friend_m343_b';
const C_ID = 'friend_m343_c';
const NAME_A = 'Alpha343';
const NAME_B = 'Beta343';
const NAME_C = 'Gamma343';

let failures = 0;
let passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { failures++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : '')); }
}
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait 200ms */ }
  }
  return false;
}

/* ── 静态守卫（无浏览器）──────────────────────────────────────────────── */
function sourceGuards() {
  const comm = read('assets/js/communication.js');
  const commCode = comm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const social = read('assets/js/social.js');
  const html = read('InternalBeyond.html');
  const core = read('assets/js/group-runtime-core.js');
  const count = (s, t) => s.split(t).length - 1;

  /* P24-M3.4.4 更新：同一 storage authority 新增 replace（exact replace）与 reset（显式清掉
     非法 policy），因此"删除键"的合法位置从 2 处变为 3 处（clear 的 merge 分支 / replace 之外的
     clear-empty 分支 / reset）；写入面仍然**只**在这一个文件、仍然没有第二套 store/cache。 */
  ok('S1.singleStorageAuthorityInSocial', count(social, 'function setGroupParticipationPolicy(') === 1
    && count(social, 'function clearGroupParticipationPolicy(') === 1
    && count(social, 'function replaceGroupParticipationPolicy(') === 1
    && count(social, 'function resetGroupParticipationPolicy(') === 1
    && count(social, 'delete group.participationPolicy') === 3);
  ok('S2.noSecondPolicyStoreOrCache',
    ['participationPolicyCache', 'participationPolicyStore', 'groupPolicyDB', 'participationPolicyDB']
      .every(t => comm.indexOf(t) < 0 && social.indexOf(t) < 0));
  ok('S3.communicationReadsGroupPolicyOnce',
    count(commCode, 'participationPolicy') === 1 && count(commCode, 'group.participationPolicy') === 1
    && count(commCode, 'participationPolicy||{}') === 0 && count(commCode, 'participationPolicy || {}') === 0);
  ok('S4.communicationAddsNoPolicyDbRead',
    count(commCode, "dbGet('groups'") === 0 && count(commCode, "dbGetAll('groups'") === 0
    && count(commCode, 'resolveParticipationPolicy(') === 1);
  ok('S5.noUserOrSystemDefaultsInProduction',
    count(commCode, 'participationDefaults') === 0 && count(commCode, 'userParticipationPolicy') === 0
    && count(commCode, 'globalGroupPolicy') === 0
    && /_gUserDefaults=undefined/.test(commCode.replace(/\s+/g, ''))
    && /_gSystemDefaults=undefined/.test(commCode.replace(/\s+/g, '')));
  ok('S6.noUiSurfaceAdded', html.indexOf('participationPolicy') < 0
    && html.indexOf('group-participation') < 0 && html.indexOf('max-responders') < 0);
  ok('S7.plannerStillHasNoPolicyStorageAwareness', (() => {
    const code = core.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = code.indexOf('function planParticipation(input)');
    const j = code.indexOf('var PARTICIPATION_POLICY_FIELDS');
    const region = code.slice(i, j);
    return i > 0 && j > i && region.indexOf('participationPolicy') < 0
      && region.indexOf('setGroupParticipationPolicy') < 0 && region.indexOf('ibGroupPolicy') < 0;
  })());
  ok('S8.p23HasNoPolicyStorageReferences',
    ['assets/js/delivery-planner.js', 'assets/js/multimodal-delivery-policy.js', 'assets/js/delivery-sequence-core.js',
      'assets/js/delivery-runtime.js', 'assets/js/voice-message-core.js']
      .every(f => read(f).indexOf('participationPolicy') < 0));
  ok('S9.exportImportCarriesWholeGroupObjects',
    /groups:await loadGroups\(\)/.test(read('assets/js/core.js'))
    && /data\.groups\)for\(const g of data\.groups\)await dbPut\('groups',g\)/.test(read('assets/js/core.js')));
  ok('S10.noDbVersionBump', /DB_VER=24/.test(read('assets/js/core.js')) && /var DB_VER = 24;/.test(read('assets/js/chat-core.js')));
}

function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
      const model = String(body.model || '');
      requests.push({ model, messages: Array.isArray(body.messages) ? body.messages : [] });
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'reply-from:' + model }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

const HOOK = "(function(){"
  + "window.__m343={policy:[],derive:[],plan:[],seq:[],reads:[]};"
  + "if(!window.__m343Hooked){window.__m343Hooked=true;"
  + "window.__m343Orig={g:window.dbGetByIndex,d:window.IBGroupRuntime.deriveRecentSpeakerIds,"
  + "p:window.IBGroupRuntime.planParticipation,r:window.IBGroupRuntime.resolveParticipationPolicy};"
  + "window.dbGetByIndex=function(store,index,key){if(store==='chatMessages'&&index==='byFriend')window.__m343.reads.push(String(key));return window.__m343Orig.g.apply(this,arguments)};"
  /* 先记录**输入**再调用原函数：resolver 抛错（fail-closed 用例）时输入仍然可观测。 */
  + "window.IBGroupRuntime.resolveParticipationPolicy=function(){window.__m343.seq.push('policy');"
  + "var rec={argc:arguments.length,group:(arguments[0]===undefined?'undefined':JSON.parse(JSON.stringify(arguments[0]))),"
  + "user:String(arguments[1]),system:String(arguments[2]),threw:false,policy:{},sources:{}};"
  + "window.__m343.policy.push(rec);"
  + "var out;try{out=window.__m343Orig.r.apply(this,arguments)}catch(e){rec.threw=true;throw e}"
  + "rec.policy=JSON.parse(JSON.stringify((out&&out.policy)||{}));rec.sources=JSON.parse(JSON.stringify((out&&out.sources)||{}));"
  + "return out};"
  + "window.IBGroupRuntime.deriveRecentSpeakerIds=function(h,p,o){window.__m343.seq.push('derive');"
  + "var out=window.__m343Orig.d.apply(this,arguments);"
  + "window.__m343.derive.push({win:(o||{}).window,result:(out&&out.recentSpeakerIds)||[],"
  + "assistants:(h||[]).map(function(m){return m&&m.role==='assistant'?String(m.content||''):''}).filter(Boolean)});"
  + "return out};"
  + "window.IBGroupRuntime.planParticipation=function(i){window.__m343.seq.push('plan');"
  + "var out=window.__m343Orig.p.apply(this,arguments);"
  + "window.__m343.plan.push({hasCap:Object.prototype.hasOwnProperty.call(i||{},'maxResponders'),cap:(i||{}).maxResponders,"
  + "entries:((out&&out.entries)||[]).map(function(e){return e.speakerId+'#'+e.order}),"
  + "omitted:((out&&out.omitted)||[]).map(function(o2){return o2.speakerId+':'+o2.reason})});"
  + "return out};"
  + "}return true})()";
const RESET = "(function(){window.__m343.policy=[];window.__m343.derive=[];window.__m343.plan=[];window.__m343.seq=[];window.__m343.reads=[];return true})()";

async function browserIntegration() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m343-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { /* starting */ }
      await new Promise(r => setTimeout(r, 100));
    }
    ok('browser.ready', ready);
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', p => exceptions.push(String(
      (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description)
      || (p.exceptionDetails && p.exceptionDetails.text) || '')));
    ok('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && typeof window.setGroupParticipationPolicy==='function' && typeof window.clearGroupParticipationPolicy==='function'", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mkCfg = (id, name, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + name + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mkCfg(A_ID, NAME_A, 'm343-a'));
    await evaluate(cdp, mkCfg(B_ID, NAME_B, 'm343-b'));
    await evaluate(cdp, mkCfg(C_ID, NAME_C, 'm343-c'));
    await evaluate(cdp, "loadApiConfigs()");
    const G = {
      legacy: 'group_1700000000350', max2: 'group_1700000000351', max0: 'group_1700000000352',
      win0: 'group_1700000000353', win5: 'group_1700000000354', combo: 'group_1700000000355',
      invalid: 'group_1700000000356', unknown: 'group_1700000000357', midturn: 'group_1700000000358'
      , replaceA: 'group_1700000000359', replaceB: 'group_1700000000360'
    };
    const mkGroup = gid => "(function(){return dbPut('groups',{id:'" + gid + "',name:'M343 " + gid.slice(-3) + "',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()";
    for (const k of Object.keys(G)) await evaluate(cdp, mkGroup(G[k]));
    ok('fixtures.ready', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.legacy + "');return !!g&&g.members.length===3&&!('participationPolicy' in g)})()"));

    const requestsFor = tag => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(tag) >= 0);
    const groupRow = gid => "(async function(){return await dbGet('groups','" + gid + "')})()";
    const botCount = gid => "(async function(){var all=await window.__m343Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length})()";
    const userCount = gid => "(async function(){var all=await window.__m343Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='user'}).length})()";
    const botsAtLeast = (gid, min) => "(async function(){var all=await window.__m343Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + min + "})()";
    const setPolicy = (gid, frag) => evaluate(cdp, "(async function(){return await window.setGroupParticipationPolicy(" + JSON.stringify(gid) + "," + JSON.stringify(frag) + ")})()");
    const clearPolicy = (gid, field) => evaluate(cdp, "(async function(){return await window.clearGroupParticipationPolicy(" + JSON.stringify(gid) + (field === undefined ? '' : ',' + JSON.stringify(field)) + ")})()");
    const replacePolicy = (gid, policy) => evaluate(cdp, "(async function(){return await window.replaceGroupParticipationPolicy(" + JSON.stringify(gid) + "," + (policy === undefined ? 'undefined' : JSON.stringify(policy)) + ")})()");
    const readPolicy = async gid => (await evaluate(cdp, groupRow(gid))).participationPolicy;
    const sendTo = async (gid, tag) => {
      await evaluate(cdp, "(function(){activeFriendId='" + gid + "';activeThreadId=null;openChatPanel();return true})()");
      await evaluate(cdp, RESET);
      mock.requests.length = 0;
      await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value=" + JSON.stringify(tag) + ";return sendChatMessage()})()");
    };

    /* ══ A · storage 语义（ST1–ST24）══════════════════════════════════════ */
    ok('ST1.legacyGroupHasNoPolicy', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.legacy + "');return !('participationPolicy' in g)})()"));
    ok('ST2.newGroupDefaultsToNoPolicy', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.max2 + "');return !('participationPolicy' in g)})()"));
    ok('ST21.legacyReadStaysUndefined', await evaluate(cdp,
      "window.getGroupParticipationPolicy({id:'x',members:[]})===undefined && window.getGroupParticipationPolicy(null)===undefined"));

    const st3 = await setPolicy(G.max2, { maxResponders: 2 });
    ok('ST3.validMaxStored', st3.ok === true && (await readPolicy(G.max2)).maxResponders === 2);
    const st4 = await setPolicy(G.win5, { recentSpeakerWindow: 5 });
    ok('ST4.validWindowStored', st4.ok === true && (await readPolicy(G.win5)).recentSpeakerWindow === 5
      && !('maxResponders' in (await readPolicy(G.win5))));
    const st5 = await setPolicy(G.combo, { maxResponders: 2, recentSpeakerWindow: 5 });
    ok('ST5.combinedStored', st5.ok === true && (await readPolicy(G.combo)).maxResponders === 2
      && (await readPolicy(G.combo)).recentSpeakerWindow === 5);
    const st6 = await setPolicy(G.max0, { maxResponders: 0 });
    ok('ST6.zeroMaxStoredAsExplicitZero', st6.ok === true && (await readPolicy(G.max0)).maxResponders === 0);
    const st7 = await setPolicy(G.win0, { recentSpeakerWindow: 0 });
    ok('ST7.zeroWindowStoredAsExplicitZero', st7.ok === true && (await readPolicy(G.win0)).recentSpeakerWindow === 0);

    const st8 = await setPolicy(G.legacy, { maxResponders: null });
    const st9 = await setPolicy(G.legacy, { maxResponders: -1 });
    const st10 = await setPolicy(G.legacy, { recentSpeakerWindow: 1.5 });
    const st11 = await setPolicy(G.legacy, { maxResponders: '2' });
    const st12 = await setPolicy(G.legacy, { maxResponders: 2, hiddenFutureFlag: true });
    ok('ST8.nullRejected', st8.ok === false && st8.error === 'invalid-policy', st8);
    ok('ST9.negativeRejected', st9.ok === false && st9.error === 'invalid-policy', st9);
    ok('ST10.fractionRejected', st10.ok === false && st10.error === 'invalid-policy', st10);
    ok('ST11.stringRejected', st11.ok === false && st11.error === 'invalid-policy', st11);
    ok('ST12.unknownFieldRejected', st12.ok === false && st12.error === 'invalid-policy'
      && (st12.errors || []).indexOf('unknown-field') >= 0, st12);
    ok('ST12b.rejectionsLeftStorageUntouched',
      await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.legacy + "');return !('participationPolicy' in g)})()"));

    /* ST13 · 空 policy 规范化为"键不存在"（含对已存在的 {} 的规范化） */
    await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.invalid + "');g.participationPolicy={};return dbPut('groups',g)})()");
    const st13 = await clearPolicy(G.invalid);
    ok('ST13.emptyPolicyCanonicalizesToAbsence', st13.ok === true
      && await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.invalid + "');return !('participationPolicy' in g)})()"));

    /* ST14–ST19 · update/clear 语义 */
    const st14 = await setPolicy(G.midturn, { maxResponders: 2 });
    const st15 = await setPolicy(G.midturn, { recentSpeakerWindow: 3 });
    ok('ST14.setFirstField', st14.ok === true && (await readPolicy(G.midturn)).maxResponders === 2);
    ok('ST15.addSecondFieldKeepsFirst', st15.ok === true
      && (await readPolicy(G.midturn)).maxResponders === 2 && (await readPolicy(G.midturn)).recentSpeakerWindow === 3);
    const st16 = await clearPolicy(G.midturn, 'maxResponders');
    ok('ST16.clearOneFieldKeepsOther', st16.ok === true && (await readPolicy(G.midturn)).maxResponders === undefined
      && (await readPolicy(G.midturn)).recentSpeakerWindow === 3);
    const st17 = await clearPolicy(G.midturn, 'recentSpeakerWindow');
    ok('ST17.clearLastFieldRemovesObject', st17.ok === true && (await readPolicy(G.midturn)) === undefined
      && await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.midturn + "');return !('participationPolicy' in g)})()"));
    const st18 = await setPolicy(G.max2, { maxResponders: 4 });
    ok('ST18.replaceValue', st18.ok === true && (await readPolicy(G.max2)).maxResponders === 4);
    const st19before = JSON.stringify(await readPolicy(G.max2));
    const st19 = await setPolicy(G.max2, { recentSpeakerWindow: -1 });
    ok('ST19.invalidUpdateIsAtomic', st19.ok === false && JSON.stringify(await readPolicy(G.max2)) === st19before,
      { before: st19before, after: await readPolicy(G.max2) });
    await setPolicy(G.max2, { maxResponders: 2 });   /* 复原成 cap=2 供生产用例使用 */
    const st20 = await evaluate(cdp, "(async function(){var frag=Object.freeze({maxResponders:3});var r=await window.setGroupParticipationPolicy('" + G.combo + "',frag);return r})()");
    ok('ST20.deepFrozenInputCanBeStored', st20.ok === true && (await readPolicy(G.combo)).maxResponders === 3);
    await setPolicy(G.combo, { maxResponders: 2 });
    ok('ST22.noDbVersionBumpAtRuntime', await evaluate(cdp, "window.DB_VER===24"));
    ok('ST23.noSecondPolicyStoreAtRuntime',
      await evaluate(cdp, "(function(){return !Object.getOwnPropertyNames(window).some(function(k){return /participationPolicy(Store|Cache)|groupPolicyDB/.test(k)})})()")
      && await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.combo + "');return Object.keys(g).filter(function(k){return /policy/i.test(k)}).length===1})()"));
    const st24 = await evaluate(cdp, "(async function(){var rows=await dbGetAll('groups');var medium=JSON.parse(JSON.stringify(rows));var target=medium.filter(function(g){return g.id==='" + G.combo + "'})[0];await dbPut('groups',target);var back=await dbGet('groups','" + G.combo + "');return JSON.stringify(back.participationPolicy)})()");
    ok('ST24.exportImportRoundtripPreservesPolicy', st24 === JSON.stringify({ maxResponders: 2, recentSpeakerWindow: 5 }),
      st24);

    /* ── R1–R11 · replace（exact replace）语义 ─────────────────────────── */
    const r1 = await replacePolicy(G.replaceA, { maxResponders: 2 });
    ok('R1.replaceAbsentToMax', r1.ok === true && (await readPolicy(G.replaceA)).maxResponders === 2);
    const r2 = await replacePolicy(G.replaceA, { recentSpeakerWindow: 3 });
    ok('R2.replaceIsExactNotMerge', r2.ok === true && (await readPolicy(G.replaceA)).recentSpeakerWindow === 3
      && !('maxResponders' in (await readPolicy(G.replaceA))), await readPolicy(G.replaceA));
    const r3 = await replacePolicy(G.replaceA, { maxResponders: 2, recentSpeakerWindow: 5 });
    ok('R3.replaceCombined', r3.ok === true && (await readPolicy(G.replaceA)).maxResponders === 2
      && (await readPolicy(G.replaceA)).recentSpeakerWindow === 5);
    const r4 = await replacePolicy(G.replaceB, { maxResponders: 0 });
    ok('R4.replaceZeroMax', r4.ok === true && (await readPolicy(G.replaceB)).maxResponders === 0);
    const r5 = await replacePolicy(G.replaceB, { recentSpeakerWindow: 0 });
    ok('R5.replaceZeroWindow', r5.ok === true && (await readPolicy(G.replaceB)).recentSpeakerWindow === 0
      && !('maxResponders' in (await readPolicy(G.replaceB))));
    const r6before = JSON.stringify(await readPolicy(G.replaceA));
    const r6 = await replacePolicy(G.replaceA, { maxResponders: 3, recentSpeakerWindow: -1 });
    ok('R6.invalidReplaceIsAtomic', r6.ok === false && r6.error === 'invalid-policy'
      && JSON.stringify(await readPolicy(G.replaceA)) === r6before, { r6, after: await readPolicy(G.replaceA) });
    const r7 = await replacePolicy(G.replaceA, { maxResponders: 2, hiddenFlag: true });
    ok('R7.unknownFieldFailClosed', r7.ok === false && (r7.errors || []).indexOf('unknown-field') >= 0
      && JSON.stringify(await readPolicy(G.replaceA)) === r6before, r7);
    ok('R8.emptyFragmentRejected', await (async () => {
      const r = await replacePolicy(G.replaceA, {});
      return r.ok === false && r.error === 'empty-fragment' && JSON.stringify(await readPolicy(G.replaceA)) === r6before;
    })());
    ok('R8b.undefinedReplacesWithClear', await (async () => {
      const r = await replacePolicy(G.replaceB, undefined);
      return r.ok === true && (await readPolicy(G.replaceB)) === undefined
        && await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.replaceB + "');return !('participationPolicy' in g)})()");
    })());
    ok('R9.deepFrozenDesiredIsStoredVerbatim', await evaluate(cdp, "(async function(){var frag=Object.freeze({recentSpeakerWindow:4});"
      + "var r=await window.replaceGroupParticipationPolicy('" + G.replaceB + "',frag);"
      + "var g=await dbGet('groups','" + G.replaceB + "');return r.ok===true&&g.participationPolicy.recentSpeakerWindow===4&&Object.keys(frag).length===1})()"));
    ok('R9b.replaceDoesNotMutateCaller', await evaluate(cdp, "(async function(){var frag={maxResponders:2};"
      + "await window.replaceGroupParticipationPolicy('" + G.replaceB + "',frag);"
      + "return JSON.stringify(frag)==='{\"maxResponders\":2}'})()"));
    /* R12 · 显式 reset（唯一能清掉**非法** stored policy 的路径；不做任何修复） */
    await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.replaceB + "');g.participationPolicy={maxResponders:-1};return dbPut('groups',g)})()");
    ok('R12a.clearRefusesInvalidStored', await evaluate(cdp, "(async function(){var r=await window.clearGroupParticipationPolicy('" + G.replaceB + "');"
      + "var g=await dbGet('groups','" + G.replaceB + "');return r.ok===false&&r.error==='invalid-stored-policy'&&g.participationPolicy.maxResponders===-1})()"));
    ok('R12b.resetRemovesInvalidStoredWithoutRepair', await evaluate(cdp, "(async function(){var r=await window.resetGroupParticipationPolicy('" + G.replaceB + "');"
      + "var g=await dbGet('groups','" + G.replaceB + "');return r.ok===true&&!('participationPolicy' in g)})()"));
    ok('R12c.resetIsNoopWhenAbsent', await evaluate(cdp, "(async function(){var r=await window.resetGroupParticipationPolicy('" + G.replaceB + "');"
      + "var g=await dbGet('groups','" + G.replaceB + "');return r.ok===true&&r.noop===true&&!('participationPolicy' in g)})()"));
    /* R10/R11 · set 的 patch 语义与 clear 语义未被 replace 影响 */
    await setPolicy(G.replaceB, { maxResponders: 2 });
    const r10 = await setPolicy(G.replaceB, { recentSpeakerWindow: 3 });
    ok('R10.setPatchSemanticsUnchanged', r10.ok === true && (await readPolicy(G.replaceB)).maxResponders === 2
      && (await readPolicy(G.replaceB)).recentSpeakerWindow === 3);
    const r11 = await clearPolicy(G.replaceB, 'maxResponders');
    ok('R11.clearSemanticsUnchanged', r11.ok === true && !('maxResponders' in (await readPolicy(G.replaceB)))
      && (await readPolicy(G.replaceB)).recentSpeakerWindow === 3);
    await clearPolicy(G.replaceB);

    /* ══ B · production 证明（ST25–ST40）══════════════════════════════════ */
    await evaluate(cdp, HOOK);

    /* ST25 · 真 stored maxResponders:2 ⇒ planner cap=2、2 次 provider 调用、groupOrder 由 planner 决定 */
    await sendTo(G.max2, 'M343 max2 probe');
    ok('ST25.roundCompletes', await waitFor(cdp, botsAtLeast(G.max2, 2), 30000));
    const p25 = await evaluate(cdp, "({policy:window.__m343.policy.slice(),derive:window.__m343.derive.slice(),plan:window.__m343.plan.slice(),seq:window.__m343.seq.slice()})");
    ok('ST25b.storedPolicyReachesResolver', !!p25.policy[0] && p25.policy[0].group
      && p25.policy[0].group.maxResponders === 2 && p25.policy[0].policy.maxResponders === 2
      && p25.policy[0].sources.maxResponders === 'group', p25.policy[0]);
    ok('ST25c.plannerReceivesCapAndTruncates', !!p25.plan[0] && p25.plan[0].hasCap === true && p25.plan[0].cap === 2
      && p25.plan[0].entries.length === 2 && p25.plan[0].omitted.join(',') === C_ID + ':budget-limit', p25.plan[0]);
    ok('ST25d.twoProviderCallsOnly', requestsFor('M343 max2 probe').length === 2
      && requestsFor('M343 max2 probe').map(r => r.model).sort().join(',') === 'm343-a,m343-b',
      requestsFor('M343 max2 probe').map(r => r.model));
    ok('ST25e.windowStillFallbackTwo', !!p25.derive[0] && p25.derive[0].win === 2, p25.derive[0]);
    ok('ST25f.resolverOnceAndOrderPolicyDerivePlan', p25.seq.join(',') === 'policy,derive,plan', p25.seq);
    ok('ST25g.chatSnapshotStillOneRead',
      (await evaluate(cdp, "window.__m343.reads.slice()")).filter(k => k === G.max2).length === 1);

    /* ST26 · maxResponders:0 ⇒ planner 空计划、0 provider 调用（不是 runtime skip） */
    await sendTo(G.max0, 'M343 max0 probe');
    ok('ST26.emptyPlanNotice', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮无人回应')>=0})()", 20000));
    await new Promise(r => setTimeout(r, 700));
    const p26 = await evaluate(cdp, "({plan:window.__m343.plan.slice(),derive:window.__m343.derive.slice()})");
    ok('ST26b.plannerGetsZeroCapAndReturnsEmptyPlan', !!p26.plan[0] && p26.plan[0].hasCap === true
      && p26.plan[0].cap === 0 && p26.plan[0].entries.length === 0, p26.plan[0]);
    ok('ST26c.zeroProviderCalls', requestsFor('M343 max0 probe').length === 0, requestsFor('M343 max0 probe').length);
    ok('ST26d.deriveStillRanBeforePlanner', !!p26.derive[0] && p26.derive[0].win === 2);
    ok('ST26e.userMessagePersisted', (await evaluate(cdp, userCount(G.max0))) === 1);
    ok('ST26f.noAssistantRows', (await evaluate(cdp, botCount(G.max0))) === 0);

    /* ST27 · recentSpeakerWindow:0 ⇒ derive window=0、recent=[]、不裁人 */
    await sendTo(G.win0, 'M343 win0 probe');
    ok('ST27.roundCompletes', await waitFor(cdp, botsAtLeast(G.win0, 3), 30000));
    const p27 = await evaluate(cdp, "({derive:window.__m343.derive.slice(),plan:window.__m343.plan.slice()})");
    ok('ST27b.zeroWindowReachesDerive', !!p27.derive[0] && p27.derive[0].win === 0 && p27.derive[0].result.length === 0, p27.derive[0]);
    ok('ST27c.noCapApplied', !!p27.plan[0] && p27.plan[0].hasCap === false && p27.plan[0].entries.length === 3, p27.plan[0]);
    ok('ST27d.threeProviderCalls', requestsFor('M343 win0 probe').length === 3, requestsFor('M343 win0 probe').map(r => r.model));

    /* ST28 · recentSpeakerWindow:5 ⇒ derive 实收 5 */
    await sendTo(G.win5, 'M343 win5 probe');
    ok('ST28.roundCompletes', await waitFor(cdp, botsAtLeast(G.win5, 3), 30000));
    const p28 = await evaluate(cdp, "window.__m343.derive.slice()");
    ok('ST28b.fiveReachesDerive', !!p28[0] && p28[0].win === 5, p28[0]);
    /* ST35 · roundExtras 不变：本轮（无人被裁）里 B 看得到 A 的本轮回复，
       而该回复不在冻结快照里（快照冻结在本轮开始前）⇒ 它只能经 roundExtras 传递。 */
    ok('ST35.roundExtrasUnchanged', (() => {
      const reqB = requestsFor('M343 win5 probe').find(r => r.model === 'm343-b');
      const snapHasA = ((p28[0] && p28[0].assistants) || []).indexOf('reply-from:m343-a') >= 0;
      return !!reqB && JSON.stringify(reqB.messages).indexOf('reply-from:m343-a') >= 0 && !snapHasA;
    })(), { models: requestsFor('M343 win5 probe').map(r => r.model) });

    /* ST29 · combined：两条同时生效（互不覆盖） */
    await sendTo(G.combo, 'M343 combo probe');
    ok('ST29.roundCompletes', await waitFor(cdp, botsAtLeast(G.combo, 2), 30000));
    const p29 = await evaluate(cdp, "({derive:window.__m343.derive.slice(),plan:window.__m343.plan.slice()})");
    ok('ST29b.bothFieldsApply', !!p29.derive[0] && p29.derive[0].win === 5
      && !!p29.plan[0] && p29.plan[0].cap === 2, { d: p29.derive[0], p: p29.plan[0] });
    ok('ST29c.twoProviderCalls', requestsFor('M343 combo probe').length === 2, requestsFor('M343 combo probe').map(r => r.model));
    ok('ST38.userDefaultsStayUndefined', await evaluate(cdp, "window.__m343.policy.slice().every(function(p){return p.user==='undefined'})"));
    ok('ST39.systemDefaultsStayUndefined', await evaluate(cdp, "window.__m343.policy.slice().every(function(p){return p.system==='undefined'})"));
    ok('ST36.groupOrderFromPlannerEntries', await evaluate(cdp, "(async function(){var all=await window.__m343Orig.g('chatMessages','byFriend','" + G.combo + "');var bots=all.filter(function(m){return m.role==='assistant'&&m.metadata&&m.metadata.groupTurnId});if(!bots.length)return false;var last=bots[bots.length-1].metadata.groupTurnId;var mine=bots.filter(function(m){return m.metadata.groupTurnId===last});return mine.map(function(m){return m.metadata.speakerId+'#'+m.metadata.groupOrder}).sort().join(',')==='" + [A_ID + '#0', B_ID + '#1'].sort().join(',') + "'})()"));
    ok('ST40.sourcesNoLeak', await evaluate(cdp, "(async function(){var all=await window.__m343Orig.g('chatMessages','byFriend','" + G.combo + "');return all.every(function(m){var k=Object.keys(m.metadata||{}).join(',');return k.indexOf('policy')<0&&k.indexOf('sources')<0})})()")
      && ['maxResponders', 'recentSpeakerWindow', 'participationPolicy', 'sources'].every(t => JSON.stringify(mock.requests).indexOf(t) < 0));

    /* ══ C · 非法 stored policy（ST30/ST31）与 mid-turn 快照（ST33/ST32）══ */
    await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.invalid + "');g.participationPolicy={maxResponders:-1};return dbPut('groups',g)})()");
    const invUsers = await evaluate(cdp, userCount(G.invalid));
    await sendTo(G.invalid, 'M343 invalid stored probe');
    ok('ST30.failClosedNotice', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0})()", 20000));
    await new Promise(r => setTimeout(r, 700));
    const p30 = await evaluate(cdp, "({seq:window.__m343.seq.slice(),policy:window.__m343.policy.slice()})");
    ok('ST30b.invalidStoredPolicyReachesResolver', !!p30.policy[0] && p30.policy[0].group && p30.policy[0].group.maxResponders === -1, p30.policy[0]);
    ok('ST30c.deriveAndPlannerNotCalled', p30.seq.indexOf('derive') < 0 && p30.seq.indexOf('plan') < 0, p30.seq);
    ok('ST30d.zeroProviderCalls', requestsFor('M343 invalid stored probe').length === 0, requestsFor('M343 invalid stored probe').length);
    ok('ST30e.noAssistantRows', (await evaluate(cdp, botCount(G.invalid))) === 0);
    ok('ST30f.userMessagePersisted', (await evaluate(cdp, userCount(G.invalid))) === invUsers + 1);
    ok('ST30g.noFallbackToUnlimited', requestsFor('M343 invalid stored probe').length !== 3);
    ok('ST30h.storedGarbageNotAutoRepaired', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.invalid + "');return g.participationPolicy.maxResponders===-1})()"));

    await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.unknown + "');g.participationPolicy={maxResponders:2,hiddenFutureFlag:true};return dbPut('groups',g)})()");
    await sendTo(G.unknown, 'M343 unknown field probe');
    ok('ST31.failClosedOnUnknownStoredField', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0})()", 20000));
    await new Promise(r => setTimeout(r, 700));
    ok('ST31b.zeroProviderCalls', requestsFor('M343 unknown field probe').length === 0, requestsFor('M343 unknown field probe').length);
    ok('ST31c.unknownFieldNotStripped', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.unknown + "');return g.participationPolicy.hiddenFutureFlag===true&&g.participationPolicy.maxResponders===2})()"));

    /* ST32/ST33 · POLICY SNAPSHOT PER GROUP TURN：本回合内改 policy 不影响本回合（下一回合才生效） */
    await setPolicy(G.midturn, { maxResponders: 3 });
    /* 注入：本回合 derive 被调用时（resolver 之后、planner 之前）**改写 stored policy**。
       契约要求本回合仍用旧 policy（POLICY SNAPSHOT PER GROUP TURN），下一回合才生效。 */
    await evaluate(cdp, "(function(){window.__m343Mut=0;"
      + "var orig=window.IBGroupRuntime.deriveRecentSpeakerIds;"
      + "window.IBGroupRuntime.deriveRecentSpeakerIds=function(h,p,o){"
      + "var args=arguments,self=this;"
      + "if(window.__m343Mut)return orig.apply(self,args);"
      + "window.__m343Mut=1;"
      + "try{window.setGroupParticipationPolicy('" + G.midturn + "',{maxResponders:2})}catch(e){}"
      + "return orig.apply(self,args)};return true})()");
    await sendTo(G.midturn, 'M343 midturn probe');
    ok('ST33.roundCompletesWithOldPolicy', await waitFor(cdp, botsAtLeast(G.midturn, 3), 30000));
    const p33 = await evaluate(cdp, "window.__m343.plan.slice()");
    ok('ST32.resolverOncePerGroupTurn', (await evaluate(cdp, "window.__m343.seq.slice()")).filter(x => x === 'policy').length === 1);
    ok('ST33b.midTurnMutationDoesNotAffectCurrentTurn', !!p33[0] && p33[0].hasCap === true && p33[0].cap === 3
      && p33[0].entries.length === 3, p33[0]);
    /* 轮内写是 fire-and-forget（测试注入用）：给 IndexedDB 写一点时间落库，再断言。 */
    let midStored = null;
    for (let i = 0; i < 25; i++) {
      midStored = await readPolicy(G.midturn);
      if (midStored && midStored.maxResponders === 2) break;
      await new Promise(r => setTimeout(r, 120));
    }
    ok('ST33c.newPolicyTakesEffectNextTurn', !!midStored && midStored.maxResponders === 2, midStored);
    await sendTo(G.midturn, 'M343 nextturn probe');
    ok('ST33d.nextTurnUsesStoredPolicy', await waitFor(cdp, botsAtLeast(G.midturn, 5), 30000)
      && requestsFor('M343 nextturn probe').length === 2, requestsFor('M343 nextturn probe').map(r => r.model));

    /* ST37 · 单聊不受影响 */
    await evaluate(cdp, RESET);
    mock.requests.length = 0;
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M343 single';return sendChatMessage()})()");
    ok('ST37.singleChatStillWorks', await waitFor(cdp, "(async function(){var all=await window.__m343Orig.g('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=1})()", 25000));
    ok('ST37b.singleChatNeverCallsResolver', (await evaluate(cdp, "window.__m343.policy.length")) === 0);

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M3.4.3 · Group Participation Policy Storage 测试 ==');
  sourceGuards();
  await browserIntegration();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
