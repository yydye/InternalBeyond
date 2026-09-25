'use strict';

/* Internal Beyond · P24-M3.2／M3.3.3.3 · Participation Planner Production Integration 测试
   （browser 组：先跑纯 mention resolver 契约，再跑真实页面群聊 integration；
     运行：node tests/test_group_participation_integration.js）

   覆盖用户给定 §33（pure mention resolver 1–15）与 §34（production integration A–S），
  以及 §35 的真实浏览器 E2E 场景：
     A active / B muted / C active
      Round 1 普通消息 → provider calls = A, C（B 无 assistant 行）
      Round 2 @B 精确唯一 → provider calls = A, B, C
    再加同名 muted 对：@X → 两者都不被调用（ambiguous ⇒ 不点名任何角色）。

   P24-M3.3.3.3 追加（recentAdapterContracts + M3333 浏览器块）：
     ONE CANONICAL SNAPSHOT PER GROUP TURN —— 每回合 chatMessages/byFriend 只读一次，
     该快照同时喂 deriveRecentSpeakerIds 与 prompt history；derive/plan 每回合各一次；
     production 仍不传预算上限（unlimited）⇒ 用户可见参与行为不变。

   本阶段的生产权威 = planParticipation（communication.js 内）；旧 `speakingCfgs`
   filter 与 nickname 子串 mention 均已下线（源码级断言见 §37 的 source guards）。 */

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
const GROUP_ID = 'group_1700000000000';
const A_ID = 'friend_m32_a';
const B_ID = 'friend_m32_b';
const C_ID = 'friend_m32_c';
const NAME_A = 'Alpha';
const NAME_B = 'Beta';
const NAME_C = 'Gamma';

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
const R = (text, candidates) => Core.resolveMentionTargets(text, candidates);
const CANDS = [{ id: A_ID, name: NAME_A }, { id: B_ID, name: NAME_B }, { id: C_ID, name: NAME_C }];
const DUP_CANDS = [{ id: A_ID, name: 'X' }, { id: B_ID, name: 'X' }, { id: C_ID, name: NAME_C }];

/* ── §33 · pure mention resolver（1–15）────────────────────────────────── */
function mentionResolver() {
  ok('1.exactTokenUniqueId', JSON.stringify(R('@' + NAME_B + ' 在吗', CANDS).targets) === JSON.stringify([B_ID]));
  ok('2.fullwidthPrefix', JSON.stringify(R('＠' + NAME_B + '，在吗', CANDS).targets) === JSON.stringify([B_ID]));
  ok('3.spaceAfterName', JSON.stringify(R('@' + NAME_B + ' ok', CANDS).targets) === JSON.stringify([B_ID]));
  ok('4.punctuationAfterName', JSON.stringify(R('@' + NAME_A + '，你好', CANDS).targets) === JSON.stringify([A_ID]));
  ok('5.endOfMessage', JSON.stringify(R('请问 @' + NAME_A, CANDS).targets) === JSON.stringify([A_ID])
    && JSON.stringify(R('@' + NAME_A, CANDS).targets) === JSON.stringify([A_ID]));
  ok('5b.cjkPrefixWithoutSpace', JSON.stringify(R('请问@' + NAME_A + ' 在吗', CANDS).targets) === JSON.stringify([A_ID]));
  ok('6.partialTokenDoesNotMatch', R('@Al', CANDS).targets.length === 0 && R('@Al', CANDS).unresolved.indexOf('Al') >= 0
    && R('@' + NAME_A + 'xyz', CANDS).targets.length === 0);
  ok('7.sameNameAmbiguousNoTarget', (() => {
    const r = R('@X 你好', DUP_CANDS);
    return r.targets.length === 0 && r.ambiguous.length === 1;
  })());
  ok('8.unknownNameNoTarget', R('@Nobody 你好', CANDS).targets.length === 0 && R('@Nobody 你好', CANDS).unresolved.length === 1);
  ok('9.removedCanStillResolveForPlanner', (() => {
    const r = R('@' + NAME_C + ' 你好', CANDS);
    const plan = Core.planParticipation({
      groupTurnId: 'gturn_abc123',
      trigger: { userMessageId: 'msg_1700000000200_u', text: '@' + NAME_C },
      participants: [{ id: C_ID, status: 'removed', mentioned: r.targets.indexOf(C_ID) >= 0 }]
    });
    return r.targets.indexOf(C_ID) >= 0 && plan.entries.length === 0 && plan.omitted[0].reason === 'removed';
  })());
  ok('10.mutedUniqueMentionSpeaks', (() => {
    const r = R('@' + NAME_B, CANDS);
    const plan = Core.planParticipation({
      groupTurnId: 'gturn_abc123', trigger: { userMessageId: 'msg_1700000000200_u', text: '@' + NAME_B },
      participants: [{ id: B_ID, status: 'muted', mentioned: r.targets.indexOf(B_ID) >= 0 }]
    });
    return plan.entries.length === 1 && plan.entries[0].reason === 'mentioned';
  })());
  ok('11.activeUniqueMentionSpeaks', (() => {
    const r = R('@' + NAME_A, CANDS);
    const plan = Core.planParticipation({
      groupTurnId: 'gturn_abc123', trigger: { userMessageId: 'msg_1700000000200_u', text: '@' + NAME_A },
      participants: [{ id: A_ID, status: 'active', mentioned: r.targets.indexOf(A_ID) >= 0 }]
    });
    return plan.entries.length === 1 && plan.entries[0].reason === 'mentioned';
  })());
  ok('12.noMentionAllBehavior', R('@所有人 开会', CANDS).targets.length === 0
    && R('@all', CANDS).targets.length === 0 && R('@全体', CANDS).targets.length === 0);
  ok('13.searchesOnlyGivenParticipants', R('@' + NAME_B, [{ id: A_ID, name: NAME_A }]).targets.length === 0);
  ok('14.renamedDisplayTokenUsesCurrentNames', JSON.stringify(R('@NewName', [{ id: A_ID, name: 'NewName' }]).targets) === JSON.stringify([A_ID])
    && R('@' + NAME_A, [{ id: A_ID, name: 'NewName' }]).targets.length === 0);
  ok('15.noPickFirstOnAmbiguity', (() => {
    const r = R('@X', DUP_CANDS);
    return r.targets.length === 0;
  })());
  ok('16.emailShapeIsNotAMention', R('mail a@' + NAME_A + '.com', CANDS).targets.length === 0);
}

/* ── §24 · Recent Speaker adapter 契约（纯 Node，无浏览器）──────────────────
   production adapter 只是把"同一份 canonical 快照 + canonical participant ids"交给
   helper；这里锁定 helper 侧的边界（空历史 / 歧义 legacy / MemberTurn 单位 / window 值）。 */
const ADAPTER_PS = [{ id: A_ID, name: NAME_A }, { id: B_ID, name: NAME_B }, { id: C_ID, name: NAME_C }];

function recentAdapterContracts() {
  /* I16 · 空历史 ⇒ recent = []（合法空结果，不是失败） */
  ok('I16.emptyHistoryYieldsEmptyRecent', (() => {
    const r = Core.deriveRecentSpeakerIds([], ADAPTER_PS, { window: 2 });
    return Array.isArray(r.recentSpeakerIds) && r.recentSpeakerIds.length === 0;
  })());
  ok('I16b.userAndSystemOnlyYieldEmptyRecent', (() => {
    const r = Core.deriveRecentSpeakerIds([
      { id: 'msg_1700000000300_u', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'msg_1700000000301_s', role: 'system', content: 'sys', timestamp: 2 }
    ], ADAPTER_PS, { window: 2 });
    return r.recentSpeakerIds.length === 0;
  })());

  /* I17 · legacy 同名歧义 ⇒ 忽略（绝不猜是谁） */
  ok('I17.ambiguousLegacyIgnored', (() => {
    const dup = [{ id: A_ID, name: 'X' }, { id: B_ID, name: 'X' }, { id: C_ID, name: NAME_C }];
    const hist = [
      { id: 'msg_1700000000310', role: 'assistant', senderName: 'X', content: 'a', timestamp: 10 },
      { id: 'msg_1700000000311', role: 'assistant', senderName: NAME_C, content: 'c', timestamp: 11 }
    ];
    const r = Core.deriveRecentSpeakerIds(hist, dup, { window: 2 });
    return JSON.stringify(r.recentSpeakerIds) === JSON.stringify([C_ID]);
  })());

  /* window 单位 = MemberTurn：同一 turnId 的多条 canonical 消息只占 1 个 slot */
  ok('I16c.windowIsMemberTurnNotMessage', (() => {
    const hist = [
      { id: 'msg_1700000000320', role: 'assistant', senderName: NAME_A, content: 'p1', timestamp: 20, metadata: { speakerId: A_ID, turnId: 'turn_aaaaaaaa' } },
      { id: 'msg_1700000000321', role: 'assistant', senderName: NAME_A, content: 'p2', timestamp: 21, metadata: { speakerId: A_ID, turnId: 'turn_aaaaaaaa' } },
      { id: 'msg_1700000000322', role: 'assistant', senderName: NAME_B, content: 'b', timestamp: 22, metadata: { speakerId: B_ID, turnId: 'turn_bbbbbbbb' } }
    ];
    const r = Core.deriveRecentSpeakerIds(hist, ADAPTER_PS, { window: 2 });
    return JSON.stringify(r.recentSpeakerIds) === JSON.stringify([B_ID, A_ID]);
  })());

  /* adapter 的 v1 window policy：局部常量 = 2（MemberTurn），且与调用点一起写死可审计 */
  /* P24-M3.4.2 更新：window 现在是 adapter 的 **effective window**（resolver 显式值优先，
     否则回落到 GROUP_RECENT_SPEAKER_WINDOW=2 这个临时 fallback），因此原先"逐字调用"的守卫
     改为锁**回落语义**：常量仍是 2、derive 收到的是 `_gRecentWindow`、且用 hasOwnProperty 判定。 */
  ok('I1b.recentWindowIsAdapterFallbackNotSystemPolicy', (() => {
    const src = read('assets/js/communication.js');
    return /const GROUP_RECENT_SPEAKER_WINDOW=2;/.test(src)
      && /deriveRecentSpeakerIds\(gMsgs,memberCfgs\.map\(c=>c\.id\),\{window:_gRecentWindow\}\)/.test(src)
      && /Object\.prototype\.hasOwnProperty\.call\(_gResolvedPolicy\.policy,'recentSpeakerWindow'\)/.test(src)
      && /: GROUP_RECENT_SPEAKER_WINDOW;/.test(src)
      && !/systemDefaults=\{[^}]*recentSpeakerWindow/.test(src)
      && !/recentSpeakerWindow:GROUP_RECENT_SPEAKER_WINDOW/.test(src);
  })());
}

/* ── §26 · Source guards（静态）────────────────────────────────────────── */
function recentSourceGuards() {
  const raw = read('assets/js/communication.js');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* 注意：注释剥离会删掉分界注释本身，所以先用 **原文** 定位群聊分支，再对切片剥注释。 */
  const groupBranch = raw.slice(raw.indexOf('if(isGroup){'), raw.indexOf('/* ===== NORMAL 1-ON-1 CHAT ===== */'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const snapshotReads = groupBranch.match(/dbGetByIndex\('chatMessages','byFriend',_targetFriend\)/g) || [];

  ok('S1.deriveCalledExactlyOnceFromProduction', (code.match(/deriveRecentSpeakerIds\(/g) || []).length === 1,
    (code.match(/deriveRecentSpeakerIds\(/g) || []).length);
  ok('S2.recentKeyPassedToPlannerExactlyOnce', (code.match(/recentSpeakerIds:/g) || []).length === 1,
    (code.match(/recentSpeakerIds:/g) || []).length);
  ok('S3.productionPlanCallIsSingle', (code.match(/planParticipation\(_gPlanInput\)/g) || []).length === 1,
    (code.match(/planParticipation\(_gPlanInput\)/g) || []).length);
  ok('S4.groupBranchReadsSnapshotOnce', snapshotReads.length === 1, snapshotReads.length);
  /* P24-M3.4.2 更新：adapter 现在合法引用 maxResponders（resolver → planner input 的条件映射）。
     守卫改为**形状约束**：无字面 cap 键、无硬编码数值、恰好一处条件赋值；budget-limit 仍只在 planner。 */
  ok('S5.noHardcodedCapInProduction', code.indexOf('budget-limit') < 0
    && (code.match(/maxResponders:/g) || []).length === 0
    && !/maxResponders\s*[:=]\s*\d/.test(code)
    && (code.match(/\.maxResponders=/g) || []).length === 1, {
    literals: (code.match(/maxResponders:/g) || []).length,
    rawHasWord: raw.indexOf('maxResponders') >= 0
  });
  ok('S6.noRecentInCanonicalWritesOrPrompt',
    !/metadata[^\n]{0,60}recentSpeakerIds/.test(code)
    && !/dbPut\([^\n]{0,160}recentSpeakerIds/.test(code)
    && !/recentSpeakerIds[^\n]{0,40}(system|sysContent)/.test(code)
    && !/extraMetadata[^\n]{0,60}recent/i.test(code));
  /* 顺序：快照读取 → recent 派生 → 规划 → 成员循环 */
  const iRead = code.indexOf("dbGetByIndex('chatMessages','byFriend',_targetFriend)");
  const iDerive = code.indexOf('deriveRecentSpeakerIds(');
  const iPlan = code.indexOf('planParticipation(_gPlanInput)');
  /* P24-M3.5.2A 更新：循环头改为 queue 驱动，用其游标变量作为"成员循环起点"锚点。 */
  const iLoop = code.indexOf('_gRtCursor');
  ok('S7.snapshotBeforeDeriveBeforePlanBeforeLoop',
    iRead > 0 && iRead < iDerive && iDerive < iPlan && iPlan < iLoop, { iRead, iDerive, iPlan, iLoop });
  /* P23 五核心与 recent 无关（零 diff 由人工审计确认；这里锁"零引用"） */
  const p23Files = ['assets/js/delivery-planner.js', 'assets/js/multimodal-delivery-policy.js',
    'assets/js/delivery-sequence-core.js', 'assets/js/delivery-runtime.js', 'assets/js/voice-message-core.js'];
  ok('S8.p23CoresHaveNoRecentCoupling',
    p23Files.every((f, i) => read(f).indexOf('recentSpeakerIds') < 0 && read(f).indexOf('GROUP_RECENT_SPEAKER_WINDOW') < 0),
    p23Files.filter(f => read(f).indexOf('recentSpeakerIds') >= 0));
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
      if (model === 'm32-fail') {                     /* H · 成员运行期失败注入 */
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: { message: 'injected member failure' } }));
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'reply-from:' + model }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

async function browserIntegration() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-m32-'));
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
    ok('page.chatReady', await waitFor(cdp, "typeof window.sendChatMessage==='function' && typeof window.apiConfigs!=='undefined' && !!(window.IBGroupRuntime&&window.IBGroupRuntime.planParticipation)", 25000));
    await evaluate(cdp, "window.confirm=function(){return true};");
    await evaluate(cdp, "(function(){window.__m32Errs=[];var o=window.IBERR&&window.IBERR.report;if(o&&!window.__m32Hooked){window.__m32Hooked=true;window.IBERR.report=function(e){try{window.__m32Errs.push(String((e&&e.stack)||e))}catch(x){};return o.apply(this,arguments)}}})()");

    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const mkCfg = (id, name, model) => "(function(){return dbPut('apiConfigs',{id:'" + id + "',nickname:'" + name + "',model:'" + model + "',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()";
    await evaluate(cdp, mkCfg(A_ID, NAME_A, 'm32-a'));
    await evaluate(cdp, mkCfg(B_ID, NAME_B, 'm32-b'));
    await evaluate(cdp, mkCfg(C_ID, NAME_C, 'm32-c'));
    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + GROUP_ID + "',name:'M32 Group',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'muted',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()");
    await evaluate(cdp, "loadApiConfigs()");
    ok('fixtures.ready', await evaluate(cdp, "(function(){return apiConfigs.some(function(a){return a.id==='" + B_ID + "'})})()"));

    const send = t => "(function(){activeFriendId='" + GROUP_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value=" + JSON.stringify(t) + ";return sendChatMessage()})()";
    const groupBots = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).map(function(m){return {content:m.content,md:m.metadata||{}}})})()";
    const groupUsers = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='user'}).length})()";
    const chatRequests = tag => mock.requests.filter(r => JSON.stringify(r.messages).indexOf(tag) >= 0);

    /* ── §35 Round 1：普通消息 ⇒ 只有 A、C 被调用（B muted 未点名）── */
    mock.requests.length = 0;
    await evaluate(cdp, send('M32 round one'));
    ok('A.round1ProviderCallsAreAandC', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=2;})()", 25000));
    const r1 = chatRequests('M32 round one');
    const r1Models = r1.map(x => x.model).sort();
    ok('A.round1ExactlyTwoMembers', r1.length === 2 && r1Models.join(',') === 'm32-a,m32-c', { r1Models, all: mock.requests.map(x => x.model) });
    const bots1 = await evaluate(cdp, groupBots);
    ok('A.round1SpeakerIdsAndOrder', bots1.map(b => b.md.speakerId + '#' + b.md.groupOrder).sort().join(',') === [A_ID + '#0', C_ID + '#1'].sort().join(','),
      bots1.map(b => [b.md.speakerId, b.md.groupOrder]));
    ok('A.round1OmittedProducesNoAssistantRow', bots1.every(b => b.md.speakerId !== B_ID));
    ok('A.round1UserMessageSingleRow', (await evaluate(cdp, groupUsers)) === 1);

    /* ── §35 Round 2：@B 精确唯一 ⇒ A、B、C 全部被调用 ── */
    mock.requests.length = 0;
    await evaluate(cdp, send('@' + NAME_B + ' M32 round two'));
    ok('C.round2ProviderCallsAreAllThree', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=5;})()", 25000));
    const r2 = chatRequests('M32 round two');
    ok('C.round2ExactlyThreeMembers', r2.length === 3 && r2.map(x => x.model).sort().join(',') === 'm32-a,m32-b,m32-c', r2.map(x => x.model));
    const bots2 = await evaluate(cdp, groupBots);
    const round2 = bots2.filter(b => b.md.groupTurnId && bots1.every(x => x.md.groupTurnId !== b.md.groupTurnId));
    ok('C.round2GroupOrderFromPlan', round2.map(b => b.md.speakerId + '#' + b.md.groupOrder).sort().join(',') === [A_ID + '#0', B_ID + '#1', C_ID + '#2'].sort().join(','),
      round2.map(b => [b.md.speakerId, b.md.groupOrder]));
    ok('G.groupOrderComesFromPlanEntry', round2.every(b => typeof b.md.groupOrder === 'number' && typeof b.md.turnId === 'string' && b.md.turnId.indexOf('turn_') === 0));
    ok('R.m1IdentityUnchanged', round2.every(b => /^gturn_/.test(String(b.md.groupTurnId)) && String(b.md.speakerId).length > 0 && b.md.sequenceIndex === 0));
    ok('R2.singleGroupTurnIdPerRound', new Set(round2.map(b => b.md.groupTurnId)).size === 1);
    ok('P.roundExtrasABeforeCVisible', (() => {
      const reqC = r2.find(x => x.model === 'm32-c');
      const reqB = r2.find(x => x.model === 'm32-b');
      if (!reqC || !reqB) return false;
      const aText = (bots2.find(b => b.md.speakerId === A_ID && round2.indexOf(b) >= 0) || {}).content || '';
      const rolesB = (reqB.messages || []).filter(m => typeof m.content === 'string' && aText && m.content.indexOf(aText) >= 0).map(m => m.role);
      return reqC.messages.length >= 2 && rolesB.length > 0 && rolesB.every(x => x === 'user');
    })());
    ok('Q.m2IdentityUnchanged', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');var bots=all.filter(function(m){return m.role==='assistant'});var last=bots[bots.length-1];return !!last&&!!last.metadata&&!!last.metadata.speakerId;})()"));
    ok('userMessageStillSingleRowAfterRound2', (await evaluate(cdp, groupUsers)) === 2);

    /* ── §35 追加：同名 muted 对，@X ⇒ 两者都不被调用 ── */
    const DUP_GROUP = 'group_1700000000099';
    await evaluate(cdp, "(function(){return dbPut('apiConfigs',{id:'friend_m32_d',nickname:'X',model:'m32-d',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'x',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()");
    await evaluate(cdp, "(function(){return dbPut('apiConfigs',{id:'friend_m32_e',nickname:'X',model:'m32-e',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'x',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + DUP_GROUP + "',name:'M32 Dup',members:[{characterId:'friend_m32_d',status:'muted',joinedAt:1},{characterId:'friend_m32_e',status:'muted',joinedAt:1}],memoryEnabled:false,created:1})})()");
    mock.requests.length = 0;
    await evaluate(cdp, "(function(){activeFriendId='" + DUP_GROUP + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='@X hello';return sendChatMessage()})()");
    ok('E.sameNameMentionCallsNobody', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮无人回应')>=0;})()", 20000));
    ok('E.sameNameMentionZeroProviderCalls', chatRequests('@X hello').length === 0, chatRequests('@X hello').length);
    ok('E.sameNameMentionZeroAssistantRows', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + DUP_GROUP + "');return all.filter(function(m){return m.role==='assistant'}).length===0;})()"));

    /* ── F · partial mention 不误唤醒（muted 成员不被调用）── */
    mock.requests.length = 0;
    await evaluate(cdp, send('@' + NAME_B.slice(0, 2) + ' M32 partial'));
    await new Promise(r => setTimeout(r, 1500));
    ok('F.partialMentionDoesNotWakeMuted', chatRequests('M32 partial').length === 2, chatRequests('M32 partial').map(x => x.model));

    /* ── H · A 成功 / B 运行期失败 / C 成功 ⇒ canonical 只应有 A#0 与 C#2（空洞合法）── */
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});c.model='m32-fail';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");
    /* 以**探测前的最新快照**为基线（E/F 两轮也在此前发生，不能被算作本轮新增）。 */
    const preHole = await evaluate(cdp, groupBots);
    const knownTurnIds = preHole.map(b => b.md.groupTurnId);
    const knownBotsCount = preHole.length;
    mock.requests.length = 0;
    await evaluate(cdp, send('@' + NAME_B + ' M32 hole probe'));
    ok('H.holeProbeReplies', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + (knownBotsCount + 2) + ";})()", 30000));
    const bots3 = await evaluate(cdp, groupBots);
    /* 只看**本轮新出现的 groupTurnId**（不靠数组切片算术）。 */
    const holeTurnIds = [];
    bots3.forEach(b => { if (knownTurnIds.indexOf(b.md.groupTurnId) < 0 && holeTurnIds.indexOf(b.md.groupTurnId) < 0) holeTurnIds.push(b.md.groupTurnId); });
    const bots3New = bots3.filter(b => holeTurnIds.indexOf(b.md.groupTurnId) >= 0);
    ok('H.onlySuccessfulMembersProduceMessages', bots3New.every(b => b.md.speakerId !== B_ID), bots3New.map(b => b.md.speakerId));
    ok('H.groupOrderKeepsPlanHole', bots3New.map(b => b.md.speakerId + '#' + b.md.groupOrder).sort().join(',') === [A_ID + '#0', C_ID + '#2'].sort().join(','),
      bots3New.map(b => [b.md.speakerId, b.md.groupOrder]));
    ok('H.noRenumberingAfterFailure', bots3New.length === 2 && new Set(bots3New.map(b => b.md.groupTurnId)).size === 1);
    ok('H.failedMemberStillPlannedInRequestOrder', (() => {
      const r = chatRequests('M32 hole probe');
      return r.length === 3;
    })(), chatRequests('M32 hole probe').map(x => x.model));
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + B_ID + "'});c.model='m32-b';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");

    /* ── N · invalid API guard 只看 plan.entries ── */
    await evaluate(cdp, "(function(){return dbPut('apiConfigs',{id:'friend_m32_z',nickname:'Zeta',model:'m32-z',endpoint:'',apiKey:'',provider:'custom',systemPrompt:'x',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + GROUP_ID + "',name:'M32 Group',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'muted',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1},{characterId:'friend_m32_z',status:'muted',joinedAt:2}],memoryEnabled:false,created:1})})()");
    mock.requests.length = 0;
    await evaluate(cdp, send('M32 guard probe unmentioned'));
    ok('N1.unplannedUnreadyMemberDoesNotBlock', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + (bots3.length + 2) + ";})()", 30000));
    ok('N1.onlyPlannedMembersCalled', chatRequests('M32 guard probe unmentioned').length === 2, chatRequests('M32 guard probe unmentioned').map(x => x.model));
    mock.requests.length = 0;
    await evaluate(cdp, send('@Zeta M32 guard probe mentioned'));
    ok('N2.plannedUnreadyMemberAbortsRound', await waitFor(cdp, "(function(){return !document.querySelector('.chat-typing');})()", 8000));
    await new Promise(r => setTimeout(r, 1200));
    ok('N2.zeroProviderCallsWhenPlannedMemberUnready', chatRequests('M32 guard probe mentioned').length === 0, chatRequests('M32 guard probe mentioned').length);
    await evaluate(cdp, "(function(){var g=null;return dbGet('groups','" + GROUP_ID + "').then(function(x){g=x;g.members=g.members.filter(function(m){return m.characterId!=='friend_m32_z'});return dbPut('groups',g)})})()");

    /* ── D · removed 成员永不入选（即使被点名），且不占 order ── */
    const REM_GROUP = 'group_1700000000088';
    await evaluate(cdp, "(function(){return dbPut('apiConfigs',{id:'friend_m32_r',nickname:'Rho',model:'m32-r',endpoint:'" + ep + "',apiKey:'',provider:'custom',systemPrompt:'x',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()})})()");
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + REM_GROUP + "',name:'M32 Removed',members:[{characterId:'friend_m32_r',status:'removed',joinedAt:1},{characterId:'" + A_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()");
    mock.requests.length = 0;
    await evaluate(cdp, "(function(){activeFriendId='" + REM_GROUP + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='@Rho M32 removed probe';return sendChatMessage()})()");
    ok('D.removedProbeRepliesFromActiveOnly', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + REM_GROUP + "');return all.filter(function(m){return m.role==='assistant'}).length>=1;})()", 25000));
    ok('D.removedNeverCalledEvenMentioned', chatRequests('M32 removed probe').length === 1 && chatRequests('M32 removed probe')[0].model === 'm32-a',
      chatRequests('M32 removed probe').map(x => x.model));
    ok('D.removedProducesNoAssistantRowAndNoOrder', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + REM_GROUP + "');var bots=all.filter(function(m){return m.role==='assistant'});return bots.every(function(m){return m.metadata.speakerId!=='friend_m32_r'})&&bots[0].metadata.groupOrder===0;})()"));

    /* ── L/M · planner validation failure / planner throw ⇒ FAIL CLOSED（无 legacy 回退）── */
    const usersBeforeL = await evaluate(cdp, groupUsers);
    const botsBeforeL = (await evaluate(cdp, groupBots)).length;
    await evaluate(cdp, "(function(){window.__m32SavedValidate=window.IBGroupRuntime.validateParticipationInput;window.IBGroupRuntime.validateParticipationInput=function(){return {ok:false,errors:['injected-invalid-input']}};return true})()");
    mock.requests.length = 0;
    await evaluate(cdp, send('M32 invalid input probe'));
    ok('L.plannerValidationFailureShowsNonCanonicalNotice', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0;})()", 15000));
    await new Promise(r => setTimeout(r, 800));
    ok('L.validationFailureZeroProviderCalls', chatRequests('M32 invalid input probe').length === 0, chatRequests('M32 invalid input probe').length);
    ok('L.validationFailureNoAssistantRows', (await evaluate(cdp, groupBots)).length === botsBeforeL);
    ok('L.validationFailureKeepsUserMessage', (await evaluate(cdp, groupUsers)) === usersBeforeL + 1);
    await evaluate(cdp, "(function(){window.IBGroupRuntime.validateParticipationInput=window.__m32SavedValidate;return true})()");

    await evaluate(cdp, "(function(){window.__m32SavedPlan=window.IBGroupRuntime.planParticipation;window.IBGroupRuntime.planParticipation=function(){throw new Error('injected-planner-throw')};return true})()");
    const botsBeforeM = (await evaluate(cdp, groupBots)).length;
    mock.requests.length = 0;
    await evaluate(cdp, send('M32 planner throw probe'));
    ok('M.plannerThrowShowsNonCanonicalNotice', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0;})()", 15000));
    await new Promise(r => setTimeout(r, 800));
    ok('M.plannerThrowZeroProviderCalls', chatRequests('M32 planner throw probe').length === 0, chatRequests('M32 planner throw probe').length);
    ok('M.plannerThrowNoAssistantRows', (await evaluate(cdp, groupBots)).length === botsBeforeM);
    ok('M.noLegacyFallbackOnPlannerFailure', await evaluate(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!(m&&m.textContent.indexOf('本轮无人回应')>=0)})()") === false);
    await evaluate(cdp, "(function(){window.IBGroupRuntime.planParticipation=window.__m32SavedPlan;return true})()");

    /* ── O · 单聊不跑 planner ── */
    /* ── N · production 默认仍 unlimited（M3.3.2：planner 支持 cap，但 adapter 不传）── */
    const FREE_GROUP = 'group_1700000000066';
    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + FREE_GROUP + "',name:'M332 Free',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()");
    mock.requests.length = 0;
    await evaluate(cdp, "(function(){activeFriendId='" + FREE_GROUP + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M332 unlimited probe';return sendChatMessage()})()");
    ok('N.productionDefaultUnlimited', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + FREE_GROUP + "');return all.filter(function(m){return m.role==='assistant'}).length>=3;})()", 30000));
    ok('N.threeActiveMembersAllCalled', chatRequests('M332 unlimited probe').length === 3, chatRequests('M332 unlimited probe').map(r => r.model));
    ok('N.ordersFollowParticipantOrder', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + FREE_GROUP + "');var bots=all.filter(function(m){return m.role==='assistant'});return bots.map(function(m){return m.metadata.speakerId+'#'+m.metadata.groupOrder}).sort().join(',')==='" + [A_ID + '#0', B_ID + '#1', C_ID + '#2'].sort().join(',')+"';})()"));
    /* P24-M3.4.2 更新：本阶段 adapter 已接 resolver（cap 只能**条件**来自 resolved policy），
       因此这条从"源码里不得出现该词"改为**运行期**断言：默认 planner input 无 cap 自有键。
       运行期证据见下方 A9（探针捕获 planner input 的 own keys）。 */
    ok('N.productionAdapterDoesNotPassCap', (() => {
      const src = read('assets/js/communication.js');
      return (src.match(/maxResponders:/g) || []).length === 0 && !/maxResponders\s*[:=]\s*\d/.test(src);
    })());

    /* ══ P24-M3.3.3.3 · Recent Speaker 生产适配器（真实页面 + 计数探针）══════════
       探针只**包一层**既有函数（dbGetByIndex / deriveRecentSpeakerIds / planParticipation），
       不改写它们的语义：用来证明"每 GroupTurn 只读一次快照 / 只派生一次 / 只规划一次"。 */
    const M3333_GROUP = FREE_GROUP;
    const M3333_TAG = 'M3333 recent probe';
    const M3333_A_MODEL = 'm3333-a';
    const HOOK = "(function(){"
      + "window.__m3333={reads:[],derive:[],plan:[],policy:[],seq:[],thrown:0};"
      + "if(!window.__m3333Hooked){window.__m3333Hooked=true;"
      + "window.__m3333Orig={g:window.dbGetByIndex,d:window.IBGroupRuntime.deriveRecentSpeakerIds,p:window.IBGroupRuntime.planParticipation,r:window.IBGroupRuntime.resolveParticipationPolicy};"
      + "window.dbGetByIndex=function(store,index,key){if(store==='chatMessages'&&index==='byFriend')window.__m3333.reads.push(String(key));return window.__m3333Orig.g.apply(this,arguments)};"
      + "window.IBGroupRuntime.resolveParticipationPolicy=function(g,u,s){window.__m3333.seq.push('policy');"
      + "var out=window.__m3333Orig.r.apply(this,arguments);"
      + "window.__m3333.policy.push({argc:arguments.length,group:String(g),user:String(u),system:String(s),"
      + "policy:JSON.parse(JSON.stringify((out&&out.policy)||{})),sources:JSON.parse(JSON.stringify((out&&out.sources)||{}))});"
      + "return out};"
      + "window.IBGroupRuntime.deriveRecentSpeakerIds=function(h,p,o){var out;try{out=window.__m3333Orig.d.apply(this,arguments)}catch(e){window.__m3333.thrown++;throw e}"
      + "window.__m3333.seq.push('derive');"
      + "window.__m3333.derive.push({ids:(p||[]).map(function(x){return String((x&&x.id)||x)}),win:o&&o.window,result:(out&&out.recentSpeakerIds)||[],"
      + "seq:(h||[]).map(function(m){return String(m&&m.role)+':'+String(m&&m.id)}),"
      + "users:(h||[]).map(function(m){return m&&m.role==='user'?String(m.id):''}).filter(Boolean),"
      + "assistants:(h||[]).map(function(m){return m&&m.role==='assistant'?String(m.content||''):''}).filter(Boolean)});"
      + "return out};"
      + "window.IBGroupRuntime.planParticipation=function(i){window.__m3333.seq.push('plan');window.__m3333.plan.push({keys:Object.keys(i||{}),hasRecent:Object.prototype.hasOwnProperty.call(i||{},'recentSpeakerIds'),recent:(i||{}).recentSpeakerIds,hasCap:Object.prototype.hasOwnProperty.call(i||{},'maxResponders')});return window.__m3333Orig.p.apply(this,arguments)};"
      + "}return true})()";
    const PROBE_RESET = "(function(){window.__m3333.reads=[];window.__m3333.derive=[];window.__m3333.plan=[];window.__m3333.policy=[];window.__m3333.seq=[];window.__m3333.thrown=0;return true})()";
    const botsViaOrig = (group, min) => "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + group + "');return all.filter(function(m){return m.role==='assistant'}).length>=" + min + "})()";
    const botsCountViaOrig = group => "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + group + "');return all.filter(function(m){return m.role==='assistant'}).length})()";
    const usersCountViaOrig = group => "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + group + "');return all.filter(function(m){return m.role==='user'}).length})()";
    const probeSend = async (group, text) => {
      await evaluate(cdp, "(function(){activeFriendId='" + group + "';activeThreadId=null;openChatPanel();return true})()");
      await evaluate(cdp, PROBE_RESET);
      await evaluate(cdp, "(function(){var i=document.getElementById('chat-input');i.value=" + JSON.stringify(text) + ";return sendChatMessage()})()");
    };
    /* A 换一个**本轮唯一**的模型名 ⇒ 它的本轮回复在历史里绝不会重复出现，
       这样才能证明"后续成员看到的是本轮 A 的回复（roundExtras），而不是历史里的旧回复"。 */
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='" + M3333_A_MODEL + "';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");
    /* 注意：groupBots/groupUsers 是**写死 GROUP_ID** 的旧助手；探针组必须自己数一次。 */
    const botsBeforeProbe = await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + M3333_GROUP + "');return all.filter(function(m){return m.role==='assistant'}).length})()");
    await evaluate(cdp, HOOK);

    /* ── 主探针：FREE_GROUP（A/B/C 全 active，历史里有上几轮的回复）── */
    mock.requests.length = 0;
    await probeSend(M3333_GROUP, M3333_TAG);
    const probeReady = await waitFor(cdp, botsViaOrig(M3333_GROUP, botsBeforeProbe + 3), 30000);
    const probeReqs = chatRequests(M3333_TAG);
    const reads = await evaluate(cdp, "window.__m3333.reads.slice()");
    const derive = await evaluate(cdp, "window.__m3333.derive.slice()");
    const plan = await evaluate(cdp, "window.__m3333.plan.slice()");
    const policyCalls = await evaluate(cdp, "window.__m3333.policy.slice()");
    const callSeq = await evaluate(cdp, "window.__m3333.seq.slice()");
    const newestUserId = await evaluate(cdp, "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + M3333_GROUP + "');var us=all.filter(function(m){return m.role==='user'&&String(m.content)===" + JSON.stringify(M3333_TAG) + "});return us.length===1?String(us[0].id):('bad:'+us.length)})()");
    const seqOrder = await evaluate(cdp, "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + M3333_GROUP + "');var core=window.IBDeliverySequence;var ord=(core&&typeof core.orderMessages==='function')?core.orderMessages(all):all;return ord.map(function(m){return String(m.role)+':'+String(m.id)})})()");
    const probeBots = await evaluate(cdp, "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + M3333_GROUP + "');var bots=all.filter(function(m){return m.role==='assistant'&&m.metadata&&m.metadata.groupTurnId});if(!bots.length)return [];var last=bots[bots.length-1].metadata.groupTurnId;return bots.filter(function(m){return m.metadata.groupTurnId===last}).map(function(m){return m.metadata.speakerId+'#'+m.metadata.groupOrder})})()");

    /* I12 · 3 个 active 成员在本轮全部被调用（recent 接线不改变参与人数） */
    ok('I12.threeActiveMembersStillAllCalled', probeReady, {
      probeReady, botsBeforeProbe, models: probeReqs.map(r => r.model),
      reads, deriveCount: derive.length, planCount: plan.length, exceptions: exceptions.slice(0, 2)
    });
    /* I4/I19 · ONE CANONICAL SNAPSHOT：本回合 chatMessages/byFriend 恰好读 1 次 */
    ok('I4.oneByFriendReadPerGroupTurn', reads.filter(k => k === M3333_GROUP).length === 1, reads);
    /* 窗口内其它 key 的读取只可能来自**无关的后台刷新**（如被打开过的好友列表）；
       本回合要证明的是：被规划的群在本轮（含三个成员的 prompt 构建）只被读一次。 */
    ok('I19.noSecondHistoryReadInGroupTurn', reads.filter(k => k === M3333_GROUP).length === 1
      && reads.indexOf(M3333_GROUP) >= 0, reads);
    /* I1/I2/I3 · derive 恰好 1 次、canonical participants、recent 进 planner、仍不传 cap */
    ok('I1.productionCallsDeriveRecentSpeakerIdsOnce', derive.length === 1, derive.length);
    ok('I1b.deriveGetsCanonicalParticipantIdsAndWindow', !!derive[0]
      && JSON.stringify(derive[0].ids) === JSON.stringify([A_ID, B_ID, C_ID]) && derive[0].win === 2, derive[0]);
    ok('I2.productionPassesRecentSpeakerIdsToPlanner', plan.length === 1 && plan[0].hasRecent === true
      && Array.isArray(plan[0].recent), plan[0]);
    ok('I3.productionDoesNotPassMaxResponders', plan.length === 1 && plan[0].hasCap === false
      && plan[0].keys.indexOf('maxResponders') < 0, plan[0] && plan[0].keys);
    /* ── P24-M3.4.2 · A 系列：真实 resolver 接缝（**不使用 mock**）── */
    ok('A1.realResolverCalledOncePerGroupTurn', policyCalls.length === 1, policyCalls.length);
    ok('A2.realResolverReceivesThreeUndefined', !!policyCalls[0] && policyCalls[0].argc === 3
      && policyCalls[0].group === 'undefined' && policyCalls[0].user === 'undefined'
      && policyCalls[0].system === 'undefined', policyCalls[0]);
    ok('A3.realResolverResultPolicyEmpty', !!policyCalls[0]
      && Object.keys(policyCalls[0].policy).length === 0, policyCalls[0] && policyCalls[0].policy);
    ok('A4.realResolverResultSourcesEmpty', !!policyCalls[0]
      && Object.keys(policyCalls[0].sources).length === 0, policyCalls[0] && policyCalls[0].sources);
    ok('A5.resolverRunsBeforeRecentDerivation',
      callSeq.indexOf('policy') >= 0 && callSeq.indexOf('derive') >= 0
      && callSeq.indexOf('policy') < callSeq.indexOf('derive'), callSeq);
    ok('A6.recentDerivationRunsBeforePlanner',
      callSeq.indexOf('derive') < callSeq.indexOf('plan'), callSeq);
    ok('A7.effectiveRecentWindowIsTwo', !!derive[0] && derive[0].win === 2, derive[0] && derive[0].win);
    ok('A8.deriveGetsEffectiveWindowFromAdapter', !!derive[0] && derive[0].win === 2
      && callSeq.filter(x => x === 'derive').length === 1, callSeq);
    ok('A9.plannerInputHasNoCapOwnKey', plan.length === 1 && plan[0].hasCap === false, plan[0]);
    ok('A10.plannerInputCarriesRecentSpeakerIds', plan.length === 1 && plan[0].hasRecent === true
      && Array.isArray(plan[0].recent), plan[0]);
    /* I5/I6 · 快照在 user dbPut 之后（用户消息在内），但用户永不成为 recent */
    ok('I5.snapshotTakenAfterUserDbPut', !!newestUserId && newestUserId.indexOf('bad:') < 0
      && !!derive[0] && derive[0].users.indexOf(newestUserId) >= 0, { newestUserId, users: derive[0] && derive[0].users });
    ok('I6.currentUserIsIgnoredByRecentHelper', !!derive[0]
      && derive[0].result.every(id => [A_ID, B_ID, C_ID].indexOf(id) >= 0)
      && derive[0].result.indexOf(newestUserId) < 0, derive[0] && derive[0].result);
    /* I6b/I9 · 本轮回复不在快照里（快照冻结在本轮开始前），只经 roundExtras 传给后续成员 */
    const snapHasCurrentA = !!derive[0] && derive[0].assistants.indexOf('reply-from:' + M3333_A_MODEL) >= 0;
    const reqB = probeReqs.find(r => r.model === 'm32-b');
    ok('I6b.currentTurnRepliesNotFedBackIntoRecent', !snapHasCurrentA, { snapHasCurrentA });
    ok('I9.roundExtrasCarriesCurrentTurnReplyIntoLaterMembers',
      !!reqB && JSON.stringify(reqB.messages).indexOf('reply-from:' + M3333_A_MODEL) >= 0, { snapHasCurrentA });
    /* I7 · 当前用户输入在 provider 的 user 消息里只出现一次（按 role=user 计数，不用全文 substring） */
    const dupCounts = probeReqs.map(r => (r.messages || []).filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content.split(M3333_TAG).length - 1 : 0))
      .reduce((a, b) => a + b, 0));
    ok('I7.currentUserAppearsOnceInProviderUserMessages', probeReqs.length === 3
      && dupCounts.length === 3 && dupCounts.every(n => n === 1), { models: probeReqs.map(r => r.model), dupCounts });
    /* I8/I13b · 同一份快照：相对顺序不变，且是本回合 canonical 顺序的前缀（= 没有被二次读取破坏） */
    ok('I8.snapshotPreservesCanonicalHistoryOrder', !!derive[0] && derive[0].seq.length > 0
      && derive[0].seq.every(x => seqOrder.indexOf(x) >= 0)
      && derive[0].seq.every((v, i) => i === 0 || seqOrder.indexOf(derive[0].seq[i - 1]) < seqOrder.indexOf(v)),
      { snap: derive[0] && derive[0].seq.length, all: seqOrder.length });
    ok('I13b.sameSnapshotIsPrefixOfCurrentCanonicalOrder', !!derive[0]
      && derive[0].seq.every((v, i) => seqOrder[i] === v), { snap: derive[0] && derive[0].seq, all: seqOrder });
    /* I12/I13/I14 · 用户可见兼容：3 次调用、participant order、groupOrder 0..2 */
    const probeModels = probeReqs.map(r => r.model).sort();
    ok('I12b.roundCallsAllThreeActiveMembers',
      probeModels.join(',') === [M3333_A_MODEL, 'm32-b', 'm32-c'].sort().join(','), probeModels);
    ok('I13.participantOrderPreservedInPlan', probeBots.slice().sort().join(',')
      === [A_ID + '#0', B_ID + '#1', C_ID + '#2'].sort().join(','), probeBots);
    ok('I14.groupOrderMatchesPlanEntries', new Set(probeBots).size === 3, probeBots);
    /* I18 · 不泄漏：prompt 与 canonical metadata 里都没有 recent/plan 内部字段 */
    const probeWire = JSON.stringify(probeReqs);
    ok('I18.noRecentOrBudgetLeakIntoPrompt', probeWire.indexOf('recentSpeakerIds') < 0
      && probeWire.indexOf('budget-limit') < 0 && probeWire.indexOf('GROUP_RECENT_SPEAKER_WINDOW') < 0
      && probeWire.indexOf('plannerId') < 0);
    ok('I18b.noRecentInCanonicalMetadata', await evaluate(cdp, "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + M3333_GROUP + "');return all.every(function(m){var k=Object.keys(m.metadata||{});return k.indexOf('recentSpeakerIds')<0&&k.indexOf('recent')<0})})()"));
    /* A19/A20 · policy & sources 只允许是 runtime 局部量：metadata 与 provider prompt 里都不许出现 */
    ok('A19.noPolicyLeakIntoCanonicalMetadata', await evaluate(cdp, "(async function(){var all=await window.__m3333Orig.g('chatMessages','byFriend','" + M3333_GROUP + "');return all.every(function(m){var k=Object.keys(m.metadata||{}).join(',');return k.indexOf('policy')<0&&k.indexOf('sources')<0&&k.indexOf('maxResponders')<0&&k.indexOf('recentSpeakerWindow')<0})})()"));
    ok('A20.noPolicyLeakIntoProviderPrompt',
      ['recentSpeakerWindow', 'maxResponders', 'participationPolicy', 'resolvedPolicy']
        .every(t => probeWire.indexOf(t) < 0), probeWire.slice(0, 160));

    /* ── I16d · 空历史（新群第一条消息）⇒ recent=[] 仍然 unlimited ── */
    const EMPTY_GROUP = 'group_1700000000055';
    await evaluate(cdp, "(function(){return dbPut('groups',{id:'" + EMPTY_GROUP + "',name:'M3333 Empty',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},{characterId:'" + B_ID + "',status:'active',joinedAt:1},{characterId:'" + C_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1})})()");
    mock.requests.length = 0;
    await probeSend(EMPTY_GROUP, 'M3333 empty probe');
    ok('I16d.emptyRecentStillPlansUnlimited', await waitFor(cdp, botsViaOrig(EMPTY_GROUP, 3), 30000));
    const emptyDerive = await evaluate(cdp, "window.__m3333.derive.slice()");
    const emptyReads = await evaluate(cdp, "window.__m3333.reads.slice()");
    ok('I16e.emptyHistorySnapshotHasNoAssistantRows', emptyDerive.length === 1
      && emptyDerive[0].assistants.length === 0 && emptyDerive[0].result.length === 0, emptyDerive);
    ok('I16g.emptyGroupTurnAlsoReadsSnapshotOnce',
      emptyDerive.length === 1 && emptyReads.filter(k => k === EMPTY_GROUP).length === 1, emptyReads);
    ok('I16f.emptyRecentRoundCallsAllThree', chatRequests('M3333 empty probe').length === 3,
      chatRequests('M3333 empty probe').map(r => r.model));

    /* ── I15 · mention 兼容：muted 群 @Beta ⇒ 仍三人全被调用（recent 不改变 mention 语义）── */
    mock.requests.length = 0;
    await probeSend(GROUP_ID, '@' + NAME_B + ' M3333 mention probe');
    ok('I15.mentionBehaviorUnchangedWithRecentWiring',
      await waitFor(cdp, botsViaOrig(GROUP_ID, 3), 30000)
      && chatRequests('M3333 mention probe').length === 3
      && chatRequests('M3333 mention probe').map(r => r.model).sort().join(',') === [M3333_A_MODEL, 'm32-b', 'm32-c'].sort().join(','),
      chatRequests('M3333 mention probe').map(r => r.model));

    /* ── I11 · 派生失败（adapter 输入错误）⇒ GroupTurn planning fail closed（无 recent=[] 回退）── */
    const preFailBots = await evaluate(cdp, botsCountViaOrig(M3333_GROUP));
    const preFailUsers = await evaluate(cdp, usersCountViaOrig(M3333_GROUP));
    await evaluate(cdp, "(function(){window.__m3333SavedDerive=window.IBGroupRuntime.deriveRecentSpeakerIds;window.IBGroupRuntime.deriveRecentSpeakerIds=function(){throw new Error('injected-recent-derive-failure')};return true})()");
    mock.requests.length = 0;
    await probeSend(M3333_GROUP, 'M3333 derive fail probe');
    ok('I11.failClosedNoticeWhenRecentDerivationFails', await waitFor(cdp, "(function(){var m=document.getElementById('chat-messages')||document.getElementById('chat-full-messages');return !!m&&m.textContent.indexOf('本轮参与计划不可用')>=0;})()", 15000));
    await new Promise(r => setTimeout(r, 900));
    ok('I11b.zeroProviderCallsWhenRecentDerivationFails', chatRequests('M3333 derive fail probe').length === 0,
      chatRequests('M3333 derive fail probe').map(r => r.model));
    ok('I11c.noAssistantRowsWhenRecentDerivationFails',
      (await evaluate(cdp, botsCountViaOrig(M3333_GROUP))) === preFailBots);
    ok('I11d.userMessageStillPersisted', (await evaluate(cdp, usersCountViaOrig(M3333_GROUP))) === preFailUsers + 1);
    await evaluate(cdp, "(function(){window.IBGroupRuntime.deriveRecentSpeakerIds=window.__m3333SavedDerive;return true})()");

    /* 还原 A 的模型：后续用例（单聊 O）必须回到 m32-a */
    await evaluate(cdp, "(function(){var c=apiConfigs.find(function(a){return a.id==='" + A_ID + "'});c.model='m32-a';return dbPut('apiConfigs',c)})()");
    await evaluate(cdp, "loadApiConfigs()");

    await evaluate(cdp, PROBE_RESET);
    mock.requests.length = 0;
    await evaluate(cdp, "(function(){activeFriendId='" + A_ID + "';activeThreadId=null;openChatPanel();var i=document.getElementById('chat-input');i.value='M32 single';return sendChatMessage()})()");
    ok('O.singleChatStillWorks', await waitFor(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).length>=1;})()", 25000));
    ok('O.singleChatHasNoGroupIdentity', await evaluate(cdp, "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');return all.filter(function(m){return m.role==='assistant'}).every(function(m){var md=m.metadata||{};return !('groupTurnId' in md)&&!('groupOrder' in md)})})()"));

    /* I20 · 单聊路径完全不碰 participation runtime（derive / plan 零调用） */
    const singleChatCalls = await evaluate(cdp, "({derive:window.__m3333.derive.length,plan:window.__m3333.plan.length,policy:window.__m3333.policy.length})");
    ok('I20.singleChatNeverTouchesParticipationRuntime', !!singleChatCalls
      && singleChatCalls.derive === 0 && singleChatCalls.plan === 0 && singleChatCalls.policy === 0, singleChatCalls);
    ok('A18.singleChatNeverCallsResolver', !!singleChatCalls && singleChatCalls.policy === 0, singleChatCalls);
    await evaluate(cdp, "(function(){if(window.__m3333Hooked){window.dbGetByIndex=window.__m3333Orig.g;window.IBGroupRuntime.deriveRecentSpeakerIds=window.__m3333Orig.d;window.IBGroupRuntime.planParticipation=window.__m3333Orig.p;window.__m3333Hooked=false}return true})()");

    ok('runtime.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
    ok('S.p23FieldsNotPolluted', (() => {
      const bots = JSON.stringify(mock.requests);
      return bots.indexOf('plannerId') < 0 && bots.indexOf('active-default') < 0 && bots.indexOf('muted-not-mentioned') < 0;
    })());
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P24-M3.2／M3.3.3.3 · Participation Planner Production Integration 测试 ==');
  mentionResolver();
  recentAdapterContracts();
  recentSourceGuards();
  await browserIntegration();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')' : '\n失败 ' + failures + ' 项（通过 ' + passes + '）');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
