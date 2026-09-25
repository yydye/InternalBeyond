'use strict';

/* Internal Beyond · P24-M3.4.4 · Group Participation Settings UI 测试
   （browser 组：真实页面 + 真实成员管理弹窗 + 真实 IndexedDB + mock provider；
     运行：node tests/test_group_participation_policy_ui.js）

   本阶段只交付 **UI + canonical mutation adapter**：
     · section 放在既有成员管理弹窗（#member-mgr-overlay）里，不新建页面/管理器；
     · 保存模型 = 与成员操作一致的**即时保存**：两个下拉的每次 change 都是一次
       **原子 desired-state 保存**（desired 空 ⇒ clear；否则 ⇒ replace）；
     · UI 不直接 dbPut / 不直接改 group.participationPolicy / 不复制 validation；
     · 未设置 ≠ 0：0 必须能显示/保存/重开恢复；fallback 2 只显示、不写库；
     · 非法 stored policy：显示"参与策略数据无效" + 「重置参与策略」（显式动作）。
   覆盖用户给定 U1–U30、E1–E7。 */

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
const A_ID = 'friend_m344_a';
const B_ID = 'friend_m344_b';
const C_ID = 'friend_m344_c';

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
  const social = read('assets/js/social.js');
  const html = read('InternalBeyond.html');
  const comm = read('assets/js/communication.js');
  const core = read('assets/js/group-runtime-core.js');
  const count = (s, t) => s.split(t).length - 1;
  /* 精确取函数体：从声明处到**下一个顶层函数声明**为止（避免把后面的函数算进来）。 */
  const body = name => {
    const i = social.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const rest = social.slice(i + 10);
    const m = rest.search(/\n(?:async )?function [A-Za-z_$]/);
    return m < 0 ? rest : rest.slice(0, m);
  };
  const commCode = comm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const coreCode = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('S1.uiSectionLivesInExistingMemberManager', count(html, 'group-policy-section') === 1
    && count(html, 'id="group-policy-max"') === 1 && count(html, 'id="group-policy-window"') === 1
    && html.indexOf('member-mgr-overlay') >= 0);
  ok('S2.uiHasNoDirectDbWrite',
    body('saveGroupParticipationPolicyFromUI').indexOf("dbPut('groups'") < 0
    && body('onGroupParticipationPolicyChange').indexOf("dbPut('groups'") < 0
    && body('resetGroupParticipationPolicyUI').indexOf("dbPut('groups'") < 0);
  ok('S3.uiHasNoDirectPolicyMutation',
    count(body('saveGroupParticipationPolicyFromUI'), 'group.participationPolicy=') === 0
    && count(body('saveGroupParticipationPolicyFromUI'), 'delete group.participationPolicy') === 0
    && count(body('resetGroupParticipationPolicyUI'), 'group.participationPolicy=') === 0
    && count(body('renderGroupParticipationPolicy'), 'group.participationPolicy=') === 0);
  ok('S4.uiUsesCanonicalStorageApisOnly',
    body('saveGroupParticipationPolicyFromUI').indexOf('clearGroupParticipationPolicy(') >= 0
    && body('saveGroupParticipationPolicyFromUI').indexOf('replaceGroupParticipationPolicy(') >= 0
    && body('resetGroupParticipationPolicyUI').indexOf('resetGroupParticipationPolicy(') >= 0);
  ok('S5.renderNeverWritesPolicy', (() => {
    const r = body('renderGroupParticipationPolicy');
    return r.indexOf('dbPut') < 0 && r.indexOf('setGroupParticipationPolicy') < 0
      && r.indexOf('replaceGroupParticipationPolicy') < 0 && r.indexOf('clearGroupParticipationPolicy') < 0;
  })());
  ok('S6.noUserOrSystemDefaultsAdded',
    social.indexOf('participationDefaults') < 0 && html.indexOf('participationDefaults') < 0
    && social.indexOf('userParticipationPolicy') < 0 && social.indexOf('globalGroupPolicy') < 0
    && html.indexOf('systemDefaults') < 0);
  ok('S7.noUiPolicyCacheOrSecondStore',
    social.indexOf('participationPolicyCache') < 0 && social.indexOf('participationPolicyStore') < 0
    && html.indexOf('participationPolicyCache') < 0);
  ok('S8.runtimeFilesUntouchedByUiWork',
    comm.indexOf('group-policy-') < 0 && core.indexOf('group-policy-') < 0
    && count(commCode, 'participationPolicy') === 1
    && count(coreCode, 'group-policy-') === 0);
  ok('S9.p23HasNoUiOrPolicyRefs',
    ['assets/js/delivery-planner.js', 'assets/js/multimodal-delivery-policy.js', 'assets/js/delivery-sequence-core.js',
      'assets/js/delivery-runtime.js', 'assets/js/voice-message-core.js']
      .every(f => read(f).indexOf('participationPolicy') < 0 && read(f).indexOf('group-policy-') < 0));
  ok('S10.labelsBoundAndButtonsTyped', count(html, 'for="group-policy-max"') === 1
    && count(html, 'for="group-policy-window"') === 1
    && /id="group-policy-reset"[^>]*type="button"|type="button"[^>]*id="group-policy-reset"/.test(html));
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
  + "window.__m344={policy:[],derive:[],plan:[],seq:[],reads:[],canonicalCalls:[]};"
  + "if(!window.__m344Hooked){window.__m344Hooked=true;"
  + "window.__m344Orig={g:window.dbGetByIndex,d:window.IBGroupRuntime.deriveRecentSpeakerIds,"
  + "p:window.IBGroupRuntime.planParticipation,r:window.IBGroupRuntime.resolveParticipationPolicy,"
  + "put:window.dbPut};"
  + "window.dbGetByIndex=function(store,index,key){if(store==='chatMessages'&&index==='byFriend')window.__m344.reads.push(String(key));return window.__m344Orig.g.apply(this,arguments)};"
  /* 记录 storage 层真正落库的 groups 写次数：UI 一次 change 必须**恰好 1 次**（= 原子保存，无 partial save）。 */
  + "window.dbPut=function(store){if(store==='groups')window.__m344.canonicalCalls.push('dbPut:groups');return window.__m344Orig.put.apply(this,arguments)};"
  + "window.IBGroupRuntime.resolveParticipationPolicy=function(){window.__m344.seq.push('policy');"
  + "var rec={group:(arguments[0]===undefined?'undefined':JSON.parse(JSON.stringify(arguments[0]))),threw:false,policy:{},sources:{}};"
  + "window.__m344.policy.push(rec);var out;try{out=window.__m344Orig.r.apply(this,arguments)}catch(e){rec.threw=true;throw e}"
  + "rec.policy=JSON.parse(JSON.stringify((out&&out.policy)||{}));rec.sources=JSON.parse(JSON.stringify((out&&out.sources)||{}));return out};"
  + "window.IBGroupRuntime.deriveRecentSpeakerIds=function(){window.__m344.seq.push('derive');"
  + "var out=window.__m344Orig.d.apply(this,arguments);"
  + "window.__m344.derive.push({win:(arguments[2]||{}).window,result:(out&&out.recentSpeakerIds)||[]});return out};"
  + "window.IBGroupRuntime.planParticipation=function(i){window.__m344.seq.push('plan');"
  + "var out=window.__m344Orig.p.apply(this,arguments);"
  + "window.__m344.plan.push({hasCap:Object.prototype.hasOwnProperty.call(i||{},'maxResponders'),cap:(i||{}).maxResponders,"
  + "entries:((out&&out.entries)||[]).map(function(e){return e.speakerId+'#'+e.order})});return out};"
  + "}return true})()";
const RESET = "(function(){window.__m344.policy=[];window.__m344.derive=[];window.__m344.plan=[];window.__m344.seq=[];window.__m344.reads=[];window.__m344.canonicalCalls=[];return true})()";

async function browserIntegration() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m344-'));
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
    ok('page.chatReady', await waitFor(cdp, "typeof window.openMemberManager==='function' && typeof window.onGroupParticipationPolicyChange==='function' && typeof window.replaceGroupParticipationPolicy==='function'", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mkCfg = (id, name, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + name + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mkCfg(A_ID, 'Alpha344', 'm344-a'));
    await evaluate(cdp, mkCfg(B_ID, 'Beta344', 'm344-b'));
    await evaluate(cdp, mkCfg(C_ID, 'Gamma344', 'm344-c'));
    await evaluate(cdp, "loadApiConfigs()");
    const G = {
      legacy: 'group_1700000000370', max2: 'group_1700000000371', max0: 'group_1700000000372',
      win0: 'group_1700000000373', combo: 'group_1700000000374', reset: 'group_1700000000375',
      invalid: 'group_1700000000376', untouched: 'group_1700000000377'
    };
    const mkGroup = gid => "(function(){return dbPut('groups',{id:'" + gid + "',name:'M344 " + gid.slice(-3) + "',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()";
    for (const k of Object.keys(G)) await evaluate(cdp, mkGroup(G[k]));
    ok('fixtures.ready', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.legacy + "');return !!g&&g.members.length===3&&!('participationPolicy' in g)})()"));

    const requestsFor = tag => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(tag) >= 0);
    const policyOf = async gid => (await evaluate(cdp, "(async function(){return await dbGet('groups','" + gid + "')})()")).participationPolicy;
    const keyPresent = gid => evaluate(cdp, "(async function(){var g=await dbGet('groups','" + gid + "');return 'participationPolicy' in g})()");
    const botsAtLeast = (gid, min) => "(async function(){var all=await window.__m344Orig.g('chatMessages','byFriend','" + gid + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + min + "})()";
    const openSettings = gid => evaluate(cdp, "(async function(){activeFriendId='" + gid + "';activeThreadId=null;openChatPanel();await openMemberManager();return !!document.querySelector('.group-policy-section')})()");
    const closeSettings = () => evaluate(cdp, "(function(){closeMemberManager();return true})()");
    const uiState = () => evaluate(cdp, "(function(){var m=document.getElementById('group-policy-max'),w=document.getElementById('group-policy-window'),i=document.getElementById('group-policy-invalid');"
      + "return {max:m?m.value:null,win:w?w.value:null,maxDisabled:m?m.disabled:null,winDisabled:w?w.disabled:null,invalidHidden:i?i.hidden:null,"
      + "maxOptions:m?m.options.length:0,maxHasUnset:m?Array.prototype.some.call(m.options,function(o){return o.value==='unset'}):false}})()");
    const pick = async (id, val) => {
      await evaluate(cdp, "(function(){var el=document.getElementById('" + id + "');el.value=" + JSON.stringify(val) + ";el.dispatchEvent(new Event('change'));return true})()");
      await new Promise(r => setTimeout(r, 450));   /* 即时保存（IDB 写）+ 重新 hydrate */
    };
    const sendTo = async (gid, tag) => {
      await evaluate(cdp, "(function(){closeMemberManager();activeFriendId='" + gid + "';activeThreadId=null;openChatPanel();return true})()");
      await evaluate(cdp, RESET);
      mock.requests.length = 0;
      await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value=" + JSON.stringify(tag) + ";return sendChatMessage()})()");
    };
    await evaluate(cdp, HOOK);

    /* ── U1–U5 · 打开与 hydrate ────────────────────────────────────────── */
    ok('U1.settingsOpens', await openSettings(G.legacy));
    const u2 = await uiState();
    ok('U2.legacyHydratesUnsetUnset', u2.max === 'unset' && u2.win === 'unset'
      && u2.maxHasUnset === true && u2.maxOptions === 12, u2);
    ok('U23.labelInputBinding', await evaluate(cdp, "(function(){var l=document.querySelector('label[for=\"group-policy-max\"]');"
      + "var l2=document.querySelector('label[for=\"group-policy-window\"]');"
      + "return !!l&&!!l2&&!!document.getElementById('group-policy-max')&&!!document.getElementById('group-policy-window')})()"));
    ok('U24.selectsAreKeyboardOperable', await evaluate(cdp, "(function(){var m=document.getElementById('group-policy-max');m.focus();"
      + "var okFocus=document.activeElement===m;var r=document.getElementById('group-policy-reset');"
      + "return okFocus&&m.tagName==='SELECT'&&!!r&&r.getAttribute('type')==='button'})()"));
    await closeSettings();
    ok('U12.untouchedOpenDoesNotMaterialize', (await keyPresent(G.legacy)) === false);
    await openSettings(G.max0);
    await evaluate(cdp, "(async function(){await window.setGroupParticipationPolicy('" + G.max0 + "',{maxResponders:0});await openMemberManager();return true})()");
    const u3 = await uiState();
    ok('U3.maxZeroHydratesExplicit', u3.max === '0' && u3.win === 'unset', u3);
    await evaluate(cdp, "(async function(){await window.setGroupParticipationPolicy('" + G.win0 + "',{recentSpeakerWindow:0});await openMemberManager();return true})()");
    await evaluate(cdp, "(async function(){activeFriendId='" + G.win0 + "';await openMemberManager();return true})()");
    const u4 = await uiState();
    ok('U4.windowZeroHydratesExplicit', u4.win === '0' && u4.max === 'unset', u4);
    await evaluate(cdp, "(async function(){activeFriendId='" + G.combo + "';await window.setGroupParticipationPolicy('" + G.combo + "',{maxResponders:2,recentSpeakerWindow:5});await openMemberManager();return true})()");
    const u5 = await uiState();
    ok('U5.combinedHydratesExact', u5.max === '2' && u5.win === '5', u5);

    /* ── U6–U12 · 保存语义（即时保存 + 原子 desired state）───────────────── */
    await openSettings(G.legacy);
    await evaluate(cdp, RESET);
    await pick('group-policy-max', '2');
    ok('U6.maxExplicitSave', (await policyOf(G.legacy)).maxResponders === 2
      && (await evaluate(cdp, "window.__m344.canonicalCalls.slice()")).join(',') === 'dbPut:groups',
      await evaluate(cdp, "window.__m344.canonicalCalls.slice()"));
    await pick('group-policy-window', '3');
    ok('U7.windowExplicitSave', (await policyOf(G.legacy)).maxResponders === 2
      && (await policyOf(G.legacy)).recentSpeakerWindow === 3);
    await pick('group-policy-window', '5');
    ok('U8.combinedSave', (await policyOf(G.legacy)).maxResponders === 2
      && (await policyOf(G.legacy)).recentSpeakerWindow === 5);
    await pick('group-policy-max', 'unset');
    ok('U9.maxUnlimitedClearsField', !('maxResponders' in (await policyOf(G.legacy)))
      && (await policyOf(G.legacy)).recentSpeakerWindow === 5);
    await pick('group-policy-window', 'unset');
    ok('U10.windowUnsetClearsField', (await policyOf(G.legacy)) === undefined, await policyOf(G.legacy));
    ok('U11.lastFieldClearRemovesPolicyObject', (await keyPresent(G.legacy)) === false);
    await openSettings(G.legacy);
    await evaluate(cdp, RESET);
    await pick('group-policy-window', '4');
    await pick('group-policy-window', 'unset');
    ok('U30.saveNeverMaterializesEmptyPolicy', (await keyPresent(G.legacy)) === false
      && (await policyOf(G.legacy)) === undefined);
    const u25 = await evaluate(cdp, "window.__m344.canonicalCalls.slice()");
    /* 两次 change（set window=4 / unset window）= 两次**单次** groups 写（每次恰好 1 次 = 原子） */
    ok('U25.uiChangeWritesGroupsExactlyOncePerAction',
      u25.length === 2 && u25.every(x => x === 'dbPut:groups'), u25);
    ok('U26.noDirectPolicyMutationFromUi', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.legacy + "');return !('participationPolicy' in g)})()"));
    ok('U27.canonicalStorageApisOnly', (await evaluate(cdp, "window.__m344.canonicalCalls.slice()")).every(x => x === 'dbPut:groups'));

    /* ── U13–U16 · 非法输入：拒绝、不 clamp、旧策略不变 ───────────────── */
    await evaluate(cdp, "(async function(){await window.replaceGroupParticipationPolicy('" + G.legacy + "',{maxResponders:2});await openMemberManager();return true})()");
    const u13 = await evaluate(cdp, "(async function(){return await window.saveGroupParticipationPolicyFromUI('" + G.legacy + "',{maxResponders:-1})})()");
    const u14 = await evaluate(cdp, "(async function(){return await window.saveGroupParticipationPolicyFromUI('" + G.legacy + "',{recentSpeakerWindow:1.5})})()");
    const u15 = await evaluate(cdp, "(async function(){return await window.saveGroupParticipationPolicyFromUI('" + G.legacy + "',{maxResponders:Number('abc')})})()");
    ok('U13.invalidNegativeRejected', u13.ok === false && u13.error === 'invalid-policy', u13);
    ok('U14.invalidFractionRejected', u14.ok === false && u14.error === 'invalid-policy', u14);
    ok('U15.invalidTextRejectedNoClamp', u15.ok === false && u15.error === 'invalid-policy', u15);
    ok('U16.invalidSaveLeavesOldPolicyUnchanged', (await policyOf(G.legacy)).maxResponders === 2
      && !('recentSpeakerWindow' in (await policyOf(G.legacy))), await policyOf(G.legacy));
    await closeSettings();
    await openSettings(G.legacy);
    const u18 = await uiState();
    ok('U18.reopenReflectsCanonical', u18.max === '2' && u18.win === 'unset', u18);
    await pick('group-policy-max', 'unset');
    ok('U17.closingWithoutChangeLeavesCanonicalStable', (await keyPresent(G.legacy)) === false);

    /* ── U19–U22 · 非法 stored policy：检测 + 显式重置 ─────────────────── */
    await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.invalid + "');g.participationPolicy={maxResponders:-1};return dbPut('groups',g)})()");
    await openSettings(G.invalid);
    const u19 = await uiState();
    ok('U19.invalidStoredDetected', u19.invalidHidden === false && u19.maxDisabled === true && u19.winDisabled === true, u19);
    ok('U20.invalidStoredNotAutoFixed', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.invalid + "');return g.participationPolicy.maxResponders===-1})()"));
    await evaluate(cdp, RESET);
    await evaluate(cdp, "(async function(){await window.resetGroupParticipationPolicyUI();return true})()");
    ok('U21.resetIsExplicitActionViaCanonicalApi',
      (await evaluate(cdp, "window.__m344.canonicalCalls.slice()")).join(',') === 'dbPut:groups');
    ok('U22.resetRemovesKeyAndRecoversUi', (await keyPresent(G.invalid)) === false
      && (await policyOf(G.invalid)) === undefined
      && (await uiState()).invalidHidden === true
      && (await uiState()).max === 'unset');
    await closeSettings();

    /* ── U28/U29 · 无 user/system defaults；无 policy cache ────────────── */
    ok('U28.noUserDefaultsUi', await evaluate(cdp, "(function(){return !document.querySelector('[id*=\"user-participation\"],[id*=\"participation-defaults\"]')})()"));
    ok('U29.noSystemDefaultsUi', await evaluate(cdp, "(function(){return !document.querySelector('[id*=\"system-defaults\"]')})()"));

    /* ── E1–E7 · UI → canonical storage → 既有 production chain（不 mock UI 写库）── */
    await openSettings(G.max2);
    await pick('group-policy-max', '2');
    ok('E1.uiSaveMax2Stored', (await policyOf(G.max2)).maxResponders === 2);
    await sendTo(G.max2, 'M344 max2 probe');
    ok('E1b.nextGroupTurnTwoCalls', await waitFor(cdp, botsAtLeast(G.max2, 2), 30000)
      && requestsFor('M344 max2 probe').length === 2, requestsFor('M344 max2 probe').map(r => r.model));
    const e1 = await evaluate(cdp, "({plan:window.__m344.plan.slice(),policy:window.__m344.policy.slice(),seq:window.__m344.seq.slice()})");
    ok('E1c.plannerOwnsTruncation', !!e1.plan[0] && e1.plan[0].hasCap === true && e1.plan[0].cap === 2
      && e1.plan[0].entries.length === 2, e1.plan[0]);
    ok('E1d.resolverOnceInOrder', e1.seq.join(',') === 'policy,derive,plan'
      && !!e1.policy[0] && e1.policy[0].group.maxResponders === 2 && e1.policy[0].sources.maxResponders === 'group');

    await openSettings(G.max0);
    await pick('group-policy-max', '0');
    ok('E2.uiSaveMax0Stored', (await policyOf(G.max0)).maxResponders === 0);
    await sendTo(G.max0, 'M344 max0 probe');
    ok('E2b.nextGroupTurnZeroCalls', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮无人回应')>=0})()", 20000)
      && requestsFor('M344 max0 probe').length === 0, requestsFor('M344 max0 probe').length);

    await openSettings(G.win0);
    await pick('group-policy-window', '0');
    ok('E3.uiSaveWindow0Stored', (await policyOf(G.win0)).recentSpeakerWindow === 0
      && !('maxResponders' in (await policyOf(G.win0))));
    await sendTo(G.win0, 'M344 win0 probe');
    ok('E3b.deriveGetsZeroAndThreeCalls', await waitFor(cdp, botsAtLeast(G.win0, 3), 30000)
      && (await evaluate(cdp, "window.__m344.derive.slice()"))[0].win === 0
      && requestsFor('M344 win0 probe').length === 3, (await evaluate(cdp, "window.__m344.derive.slice()")));

    await openSettings(G.combo);
    await pick('group-policy-max', '2');
    await pick('group-policy-window', '5');
    ok('E4.uiSaveCombinedStored', (await policyOf(G.combo)).maxResponders === 2
      && (await policyOf(G.combo)).recentSpeakerWindow === 5);
    await sendTo(G.combo, 'M344 combo probe');
    ok('E4b.deriveFiveAndTwoCalls', await waitFor(cdp, botsAtLeast(G.combo, 2), 30000)
      && (await evaluate(cdp, "window.__m344.derive.slice()"))[0].win === 5
      && requestsFor('M344 combo probe').length === 2,
      { derive: await evaluate(cdp, "window.__m344.derive.slice()"), models: requestsFor('M344 combo probe').map(r => r.model) });

    await openSettings(G.reset);
    await pick('group-policy-max', '1');
    await pick('group-policy-max', 'unset');
    await pick('group-policy-window', 'unset');
    ok('E5.uiUnsetRemovesPolicyKey', (await keyPresent(G.reset)) === false);
    await sendTo(G.reset, 'M344 unset probe');
    ok('E5b.fallbackWindowTwoAndThreeCalls', await waitFor(cdp, botsAtLeast(G.reset, 3), 30000)
      && (await evaluate(cdp, "window.__m344.derive.slice()"))[0].win === 2
      && requestsFor('M344 unset probe').length === 3,
      { derive: await evaluate(cdp, "window.__m344.derive.slice()"), models: requestsFor('M344 unset probe').map(r => r.model) });
    ok('E5c.noFallbackMaterialized', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.reset + "');return !('participationPolicy' in g)})()"));

    /* E6/E7 · 非法 stored → fail closed；UI 显式 reset → 下一轮恢复正常 */
    await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.invalid + "');g.participationPolicy={maxResponders:-1};return dbPut('groups',g)})()");
    await sendTo(G.invalid, 'M344 invalid probe');
    ok('E6.invalidStoredFailsClosed', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0})()", 20000)
      && requestsFor('M344 invalid probe').length === 0, requestsFor('M344 invalid probe').length);
    await openSettings(G.invalid);
    await evaluate(cdp, "(async function(){await window.resetGroupParticipationPolicyUI();return true})()");
    await closeSettings();
    await sendTo(G.invalid, 'M344 recovered probe');
    ok('E7.resetRestoresDefaultBehaviour', await waitFor(cdp, botsAtLeast(G.invalid, 3), 30000)
      && requestsFor('M344 recovered probe').length === 3, requestsFor('M344 recovered probe').map(r => r.model));

    /* ── 既有群设置回归：成员操作仍走原路径 ───────────────────────────── */
    await openSettings(G.max2);
    const beforeMembers = await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.max2 + "');return g.members.map(function(m){return m.characterId+':'+m.status}).join(',')})()");
    await evaluate(cdp, "(async function(){await window.memberAction('" + G.max2 + "','" + B_ID + "','mute');return true})()");
    const afterMute = await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.max2 + "');return g.members.filter(function(m){return m.characterId==='" + B_ID + "'})[0].status})()");
    await evaluate(cdp, "(async function(){await window.memberAction('" + G.max2 + "','" + B_ID + "','unmute');return true})()");
    const afterUnmute = await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.max2 + "');return g.members.filter(function(m){return m.characterId==='" + B_ID + "'})[0].status})()");
    ok('R0.existingMemberSettingsStillWork', beforeMembers.indexOf(B_ID + ':active') >= 0
      && afterMute === 'muted' && afterUnmute === 'active'
      && (await policyOf(G.max2)).maxResponders === 2);
    ok('R0b.groupNameAndFlagsUntouched', await evaluate(cdp, "(async function(){var g=await dbGet('groups','" + G.max2 + "');return typeof g.name==='string'&&g.name.length>0&&g.memoryEnabled===false})()"));
    await closeSettings();

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M3.4.4 · Group Participation Settings UI 测试 ==');
  sourceGuards();
  await browserIntegration();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
