'use strict';

/* Internal Beyond · P24-M3.4.2 · Participation Policy Adapter Integration 测试
   （browser 组：真实页面 + 真实 sendChatMessage + 真实 IndexedDB + mock provider；
     运行：node tests/test_group_participation_policy_integration.js）

   本阶段只接 **adapter seam**（没有 policy storage / user defaults / system defaults）：
     真实输入 = (undefined, undefined, undefined) ⇒ resolved policy 必为 {policy:{},sources:{}}。
   为未来 storage（M3.4.3）**预验证**映射路径，本套件用最小 monkey-patch 让 resolver 返回
   假 policy，然后证明：
     F1 maxResponders:2  ⇒ planner input 出现 cap=2，**由 planner 裁剪** 3 eligible → 2 planned
     F2 recentSpeakerWindow:0 ⇒ derive window=0、recentSpeakerIds=[]
     F3 maxResponders:0  ⇒ planner 空计划、0 provider 调用（**不是** runtime skip）
     F4 window:5 + max:2 ⇒ window=5 且 cap=2
   plus 失败注入：resolver 抛 PARTICIPATION_POLICY_CONTRACT ⇒ 走既有 fail-closed（derive/planner
   都不被调用），且 GroupTurn 干净退出（后续回合仍能正常进行）。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const A_ID = 'friend_m342_a';
const B_ID = 'friend_m342_b';
const C_ID = 'friend_m342_c';
const NAME_A = 'Alpha342';
const NAME_B = 'Beta342';
const NAME_C = 'Gamma342';

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
  const raw = read('assets/js/communication.js');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('S1.resolverCallSiteExactlyOnce', (code.match(/resolveParticipationPolicy\(/g) || []).length === 1,
    (code.match(/resolveParticipationPolicy\(/g) || []).length);
  const iSnap = code.indexOf("dbGetByIndex('chatMessages','byFriend',_targetFriend)");
  const iPolicy = code.indexOf('resolveParticipationPolicy(');
  const iDerive = code.indexOf('deriveRecentSpeakerIds(');
  const iPlan = code.indexOf('planParticipation(_gPlanInput)');
  /* P24-M3.5.2A 更新：循环头改为 queue 驱动，游标变量作为成员循环起点锚点。 */
  const iLoop = code.indexOf('_gRtCursor');
  ok('S2.pipelineOrderSnapshotPolicyDerivePlanLoop',
    iSnap > 0 && iSnap < iPolicy && iPolicy < iDerive && iDerive < iPlan && iPlan < iLoop,
    { iSnap, iPolicy, iDerive, iPlan, iLoop });
  /* P24-M3.4.3 更新：M3.4.3 起 production **合法**从已加载的 group object 读
     `group.participationPolicy`（读 seam）。守卫改为"只读一处 + 不写 + 无第二套 store"：
     adapter 里不得出现 policy 写入、cache/store 命名或 user/system defaults。 */
  ok('S3.adapterReadsGroupPolicyOnceWithoutWriting', (code.match(/participationPolicy/g) || []).length === 1
    && code.indexOf('participationDefaults') < 0 && raw.indexOf('apiSettings.participation') < 0
    && raw.indexOf('ib_participation') < 0 && raw.indexOf('participationPolicyStore') < 0
    && raw.indexOf('participationPolicyCache') < 0 && raw.indexOf('groupPolicyDB') < 0);
  ok('S4.noFakeSystemDefaults', !/systemDefaults=\{[^}]*\}/.test(code)
    && !/recentSpeakerWindow\s*[:=]\s*\d/.test(code)
    && (code.match(/maxResponders:/g) || []).length === 0
    && (code.match(/\.maxResponders=/g) || []).length === 1);
  ok('S5.windowFallbackStillTwoInSource', /const GROUP_RECENT_SPEAKER_WINDOW=2;/.test(raw));
  const social = read('assets/js/social.js');
  /* P24-M3.4.3 更新：social.js 现在是**唯一** group policy storage authority（set/clear helpers），
     且必须仍然没有第二套 store / cache；同时 adapter 侧不得出现任何 policy 写 API。 */
  ok('S6.socialIsTheOnlyPolicyStorageAuthority',
    social.indexOf('function setGroupParticipationPolicy(') >= 0
    && social.indexOf('function clearGroupParticipationPolicy(') >= 0
    && social.indexOf('participationPolicyStore') < 0 && social.indexOf('groupPolicyDB') < 0
    && code.indexOf('setGroupParticipationPolicy') < 0 && code.indexOf('clearGroupParticipationPolicy') < 0);
  const p23 = ['assets/js/delivery-planner.js', 'assets/js/multimodal-delivery-policy.js',
    'assets/js/delivery-sequence-core.js', 'assets/js/delivery-runtime.js', 'assets/js/voice-message-core.js'];
  ok('S7.p23HasNoPolicyReferences',
    p23.every(f => read(f).indexOf('PARTICIPATION_POLICY') < 0 && read(f).indexOf('participationPolicy') < 0));
  /* core resolver 契约未改（group > user > system / per-field / 0 explicit / null invalid） */
  ok('S8.coreResolverContractIntact', (() => {
    const r = Core.resolveParticipationPolicy({ maxResponders: 2 }, { recentSpeakerWindow: 3 }, { maxResponders: 5, recentSpeakerWindow: 1 });
    const zero = Core.resolveParticipationPolicy({ maxResponders: 0 }, { maxResponders: 3 });
    let nullInvalid = false;
    try { Core.resolveParticipationPolicy({ maxResponders: null }); } catch (e) { nullInvalid = e.code === 'PARTICIPATION_POLICY_CONTRACT'; }
    return r.policy.maxResponders === 2 && r.policy.recentSpeakerWindow === 3
      && r.sources.maxResponders === 'group' && r.sources.recentSpeakerWindow === 'user'
      && zero.policy.maxResponders === 0 && zero.sources.maxResponders === 'group'
      && nullInvalid && Core.PARTICIPATION_PLAN_VERSION === 3;
  })());
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

/* 页面侧探针：记录 resolver / derive / planner 的调用与参数（只包一层，不改语义）。 */
const HOOK = "(function(){"
  + "window.__m342={policy:[],derive:[],plan:[],seq:[],reads:[]};"
  + "if(!window.__m342Hooked){window.__m342Hooked=true;"
  + "window.__m342Orig={g:window.dbGetByIndex,d:window.IBGroupRuntime.deriveRecentSpeakerIds,"
  + "p:window.IBGroupRuntime.planParticipation,r:window.IBGroupRuntime.resolveParticipationPolicy};"
  + "window.dbGetByIndex=function(store,index,key){if(store==='chatMessages'&&index==='byFriend')window.__m342.reads.push(String(key));return window.__m342Orig.g.apply(this,arguments)};"
  + "window.IBGroupRuntime.resolveParticipationPolicy=function(){window.__m342.seq.push('policy');"
  + "var out=window.__m342Orig.r.apply(this,arguments);"
  + "window.__m342.policy.push({argc:arguments.length,group:String(arguments[0]),user:String(arguments[1]),system:String(arguments[2]),"
  + "policy:JSON.parse(JSON.stringify((out&&out.policy)||{})),sources:JSON.parse(JSON.stringify((out&&out.sources)||{}))});"
  + "return out};"
  + "window.__m342Wrapper=window.IBGroupRuntime.resolveParticipationPolicy;"   /* 探针本体（必须在包装**之后**取） */
  + "window.IBGroupRuntime.deriveRecentSpeakerIds=function(h,p,o){window.__m342.seq.push('derive');"
  + "var out=window.__m342Orig.d.apply(this,arguments);"
  + "window.__m342.derive.push({win:(o||{}).window,result:(out&&out.recentSpeakerIds)||[],ids:(p||[]).map(function(x){return String((x&&x.id)||x)})});"
  + "return out};"
  + "window.IBGroupRuntime.planParticipation=function(i){window.__m342.seq.push('plan');"
  + "var out=window.__m342Orig.p.apply(this,arguments);"
  + "window.__m342.plan.push({keys:Object.keys(i||{}),hasCap:Object.prototype.hasOwnProperty.call(i||{},'maxResponders'),"
  + "cap:(i||{}).maxResponders,hasRecent:Object.prototype.hasOwnProperty.call(i||{},'recentSpeakerIds'),"
  + "entries:((out&&out.entries)||[]).map(function(e){return e.speakerId+'#'+e.order}),omitted:((out&&out.omitted)||[]).map(function(o2){return o2.speakerId+':'+o2.reason})});"
  + "return out};"
  + "}return true})()";
const RESET = "(function(){window.__m342.policy=[];window.__m342.derive=[];window.__m342.plan=[];window.__m342.seq=[];window.__m342.reads=[];return true})()";

async function browserIntegration() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m342-'));
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
    ok('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && !!(window.IBGroupRuntime&&window.IBGroupRuntime.resolveParticipationPolicy)", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mkCfg = (id, name, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + name + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mkCfg(A_ID, NAME_A, 'm342-a'));
    await evaluate(cdp, mkCfg(B_ID, NAME_B, 'm342-b'));
    await evaluate(cdp, mkCfg(C_ID, NAME_C, 'm342-c'));
    await evaluate(cdp, "loadApiConfigs()");
    /* 每个 case 一个**全新群**（无历史）⇒ recent=[] ⇒ cap 截断结果完全确定（A,B 先于 C）。 */
    const mkGroup = (gid, mid) => "(function(){return dbPut('groups',{id:'" + gid + "',name:'M342 " + mid + "',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()";
    const groups = {
      real: 'group_1700000000340', cap2: 'group_1700000000341', win0: 'group_1700000000342',
      cap0: 'group_1700000000343', combo: 'group_1700000000344', fail: 'group_1700000000345'
    };
    for (const k of Object.keys(groups)) await evaluate(cdp, mkGroup(groups[k], k));
    ok('fixtures.ready', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + groups.real + "');return !!g&&g.members.length===3})()"));

    const requestsFor = tag => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(tag) >= 0);
    const sendTo = async (gid, tag) => {
      await evaluate(cdp, "(function(){activeFriendId='" + gid + "';activeThreadId=null;openChatPanel();return true})()");
      await evaluate(cdp, RESET);
      mock.requests.length = 0;
      await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value=" + JSON.stringify(tag) + ";return sendChatMessage()})()");
    };
    const botsOf = gid => "(async function(){var all=await window.__m342Orig.g('chatMessages','byFriend','" + gid + "');var bots=all.filter(function(m){return m.role==='assistant'});var last=bots.length?bots[bots.length-1].metadata.groupTurnId:'';return bots.filter(function(m){return last&&m.metadata&&m.metadata.groupTurnId===last}).map(function(m){return m.metadata.speakerId+'#'+m.metadata.groupOrder})})()";
    const newBotCount = gid => "(async function(){var all=await window.__m342Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length})()";
    const userCount = gid => "(async function(){var all=await window.__m342Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='user'}).length})()";
    const botsAtLeast = (gid, min) => "(async function(){var all=await window.__m342Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + min + "})()";
    /* 让 resolver 返回假 policy（=M3.4.3 之后 storage 会给的形状）；不落任何 storage。 */
    /* 注意：恢复**必须回到探针本体**（`__m342Wrapper`），而不是"当前值" —— 否则连续两次 fake
       会把上一次的 fake 当成"原始值"存下来（本套件第一版就是这样把 fake 泄漏进恢复轮的）。 */
    const fakePolicy = obj => "(function(){window.IBGroupRuntime.resolveParticipationPolicy=function(){return " + JSON.stringify(obj) + "};return true})()";
    const restorePolicy = "(function(){window.IBGroupRuntime.resolveParticipationPolicy=window.__m342Wrapper;return true})()";

    await evaluate(cdp, HOOK);

    /* ── C0 · 真实路径（**不 mock resolver**）：输入 3×undefined ⇒ 空 policy、window=2、3 次调用 ── */
    await sendTo(groups.real, 'M342 real probe');
    ok('C0.realResolverPathCompletes', await waitFor(cdp, botsAtLeast(groups.real, 3), 30000)
      && requestsFor('M342 real probe').length === 3, requestsFor('M342 real probe').map(r => r.model));
    const realPolicy = await evaluate(cdp, "window.__m342.policy.slice()");
    const realDerive = await evaluate(cdp, "window.__m342.derive.slice()");
    const realSeq = await evaluate(cdp, "window.__m342.seq.slice()");
    ok('C0b.realResolverGetsThreeUndefinedAndReturnsEmpty', realPolicy.length === 1 && realPolicy[0].argc === 3
      && realPolicy[0].group === 'undefined' && realPolicy[0].user === 'undefined' && realPolicy[0].system === 'undefined'
      && Object.keys(realPolicy[0].policy).length === 0 && Object.keys(realPolicy[0].sources).length === 0, realPolicy);
    ok('C0c.orderIsPolicyThenDeriveThenPlan', realSeq.join(',') === 'policy,derive,plan', realSeq);
    ok('C0d.realWindowIsFallbackTwo', realDerive.length === 1 && realDerive[0].win === 2, realDerive);
    ok('C0e.oneSnapshotReadPerTurn', (await evaluate(cdp, "window.__m342.reads.slice()")).filter(k => k === groups.real).length === 1);
    ok('C0f.noCanonicalLeak', await evaluate(cdp, "(async function(){var all=await window.__m342Orig.g('chatMessages','byFriend','" + groups.real + "');return all.every(function(m){var k=Object.keys(m.metadata||{}).join(',');return k.indexOf('policy')<0&&k.indexOf('sources')<0&&k.indexOf('maxResponders')<0&&k.indexOf('recentSpeakerWindow')<0})})()"));

    /* ── F1 · resolver 返回 maxResponders:2 ⇒ planner input 出现 cap=2，**planner** 裁到 2 人 ── */
    await evaluate(cdp, fakePolicy({ policy: { maxResponders: 2 }, sources: { maxResponders: 'group' } }));
    await sendTo(groups.cap2, 'M342 cap2 probe');
    ok('F1.roundCompletesWithTwoReplies', await waitFor(cdp, botsAtLeast(groups.cap2, 2), 30000));
    const f1Plan = await evaluate(cdp, "window.__m342.plan.slice()");
    const f1Derive = await evaluate(cdp, "window.__m342.derive.slice()");
    ok('F1b.plannerInputReceivesResolvedCap', f1Plan.length === 1 && f1Plan[0].hasCap === true && f1Plan[0].cap === 2, f1Plan);
    ok('F1c.plannerTruncatesThreeEligibleToTwo',
      f1Plan[0] && f1Plan[0].entries.join(',') === A_ID + '#0,' + B_ID + '#1'
      && f1Plan[0].omitted.join(',') === C_ID + ':budget-limit', f1Plan[0]);
    ok('F1d.twoProviderCallsOnly', requestsFor('M342 cap2 probe').length === 2
      && requestsFor('M342 cap2 probe').map(r => r.model).sort().join(',') === 'm342-a,m342-b',
      requestsFor('M342 cap2 probe').map(r => r.model));
    ok('F1e.groupOrderFromPlannerEntries',
      (await evaluate(cdp, botsOf(groups.cap2))).slice().sort().join(',') === [A_ID + '#0', B_ID + '#1'].sort().join(','),
      await evaluate(cdp, botsOf(groups.cap2)));
    ok('F1f.windowUnaffectedByCapCase', f1Derive.length === 1 && f1Derive[0].win === 2, f1Derive);

    /* ── F2 · resolver 返回 recentSpeakerWindow:0 ⇒ derive window=0、recent=[]（但**不**裁人）── */
    await evaluate(cdp, fakePolicy({ policy: { recentSpeakerWindow: 0 }, sources: { recentSpeakerWindow: 'group' } }));
    await sendTo(groups.win0, 'M342 win0 probe');
    ok('F2.roundCompletesWithThreeReplies', await waitFor(cdp, botsAtLeast(groups.win0, 3), 30000));
    const f2Derive = await evaluate(cdp, "window.__m342.derive.slice()");
    const f2Plan = await evaluate(cdp, "window.__m342.plan.slice()");
    ok('F2b.deriveReceivesExplicitZero', f2Derive.length === 1 && f2Derive[0].win === 0, f2Derive);
    ok('F2c.zeroWindowYieldsEmptyRecent', f2Derive[0] && f2Derive[0].result.length === 0, f2Derive[0]);
    ok('F2d.zeroWindowDoesNotTruncate', f2Plan[0] && f2Plan[0].hasCap === false && f2Plan[0].entries.length === 3, f2Plan[0]);
    ok('F2e.threeProviderCalls', requestsFor('M342 win0 probe').length === 3, requestsFor('M342 win0 probe').map(r => r.model));

    /* ── F3 · resolver 返回 maxResponders:0 ⇒ planner 空计划、0 调用（**不是** runtime skip）── */
    await evaluate(cdp, fakePolicy({ policy: { maxResponders: 0 }, sources: { maxResponders: 'group' } }));
    await sendTo(groups.cap0, 'M342 cap0 probe');
    ok('F3.emptyPlanNoticeShown', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮无人回应')>=0})()", 20000));
    await new Promise(r => setTimeout(r, 800));
    const f3Plan = await evaluate(cdp, "window.__m342.plan.slice()");
    ok('F3b.plannerReceivesZeroCapAndReturnsEmptyPlan', f3Plan.length === 1 && f3Plan[0].hasCap === true
      && f3Plan[0].cap === 0 && f3Plan[0].entries.length === 0, f3Plan[0]);
    ok('F3c.zeroProviderCalls', requestsFor('M342 cap0 probe').length === 0, requestsFor('M342 cap0 probe').length);
    ok('F3d.noAssistantRows', (await evaluate(cdp, newBotCount(groups.cap0))) === 0);
    ok('F3e.userMessagePersisted', (await evaluate(cdp, userCount(groups.cap0))) === 1);

    /* ── F4 · window:5 + max:2 ⇒ window=5 且 planner cap=2 ── */
    await evaluate(cdp, fakePolicy({ policy: { recentSpeakerWindow: 5, maxResponders: 2 }, sources: { recentSpeakerWindow: 'group', maxResponders: 'group' } }));
    await sendTo(groups.combo, 'M342 combo probe');
    ok('F4.roundCompletesWithTwoReplies', await waitFor(cdp, botsAtLeast(groups.combo, 2), 30000));
    const f4Derive = await evaluate(cdp, "window.__m342.derive.slice()");
    const f4Plan = await evaluate(cdp, "window.__m342.plan.slice()");
    ok('F4b.bothResolvedFieldsMapped', f4Derive.length === 1 && f4Derive[0].win === 5
      && f4Plan.length === 1 && f4Plan[0].hasCap === true && f4Plan[0].cap === 2, { f4Derive, f4Plan });
    ok('F4c.twoProviderCalls', requestsFor('M342 combo probe').length === 2, requestsFor('M342 combo probe').map(r => r.model));

    /* ── 失败注入 · resolver 抛 PARTICIPATION_POLICY_CONTRACT ⇒ 既有 fail-closed，derive/planner 都不跑 ── */
    await evaluate(cdp, restorePolicy);
    const failUsersBefore = await evaluate(cdp, userCount(groups.fail));
    await evaluate(cdp, "(function(){window.__m342SavedR=window.IBGroupRuntime.resolveParticipationPolicy;"
      + "window.IBGroupRuntime.resolveParticipationPolicy=function(){var e=new Error('injected-policy-contract');e.code='PARTICIPATION_POLICY_CONTRACT';e.errors=['bad-fragment'];throw e};return true})()");
    await sendTo(groups.fail, 'M342 policy fail probe');
    ok('G1.failClosedNoticeShown', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0})()", 20000));
    await new Promise(r => setTimeout(r, 800));
    const failSeq = await evaluate(cdp, "window.__m342.seq.slice()");
    ok('G2.deriveAndPlannerNotCalledAfterResolverFailure', failSeq.indexOf('derive') < 0 && failSeq.indexOf('plan') < 0, failSeq);
    ok('G3.zeroProviderCallsOnResolverFailure', requestsFor('M342 policy fail probe').length === 0, requestsFor('M342 policy fail probe').length);
    ok('G4.noAssistantRowsOnResolverFailure', (await evaluate(cdp, newBotCount(groups.fail))) === 0);
    ok('G5.userMessagePersistedOnResolverFailure', (await evaluate(cdp, userCount(groups.fail))) === failUsersBefore + 1);
    /* GroupTurn 干净退出：恢复真实 resolver 后，同一群仍能正常完成一整轮 */
    await evaluate(cdp, restorePolicy);
    await sendTo(groups.fail, 'M342 recover probe');
    ok('G6b.recoverRoundCallsRealResolverAgain', await evaluate(cdp, "window.__m342.policy.length") === 1);
    ok('G6.groupTurnNotStuckAfterFailure', await waitFor(cdp, botsAtLeast(groups.fail, 3), 30000)
      && requestsFor('M342 recover probe').length === 3, requestsFor('M342 recover probe').map(r => r.model));
    const recovered = await evaluate(cdp, "window.__m342.policy.slice()");
    ok('G7.recoveredTurnUsesRealResolverAgain', recovered.length === 1
      && Object.keys(recovered[0].policy).length === 0 && Object.keys(recovered[0].sources).length === 0, recovered);

    /* ── 单聊：resolver 零调用 ── */
    await evaluate(cdp, RESET);
    mock.requests.length = 0;
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M342 single';return sendChatMessage()})()");
    ok('H1.singleChatStillWorks', await waitFor(cdp, "(async function(){var all=await window.__m342Orig.g('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=1})()", 25000));
    ok('H2.singleChatNeverCallsResolver', (await evaluate(cdp, "window.__m342.policy.length")) === 0);

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M3.4.2 · Participation Policy Adapter Integration 测试 ==');
  sourceGuards();
  await browserIntegration();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
