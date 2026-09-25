'use strict';

/* Internal Beyond · P29-0 · Identity Read-Path Closure 测试
   （browser 组：先跑纯契约 + 源码守卫，再跑真实浏览器断言；运行：
     node tests/test_identity_read_path_closure.js）

   本阶段冻结的是**身份读路径的闭合性**：撤回 / 拍一拍这类 "这是不是我上一条消息"
   的判定 = **ownership 判断**，只能由 canonical id 回答。`senderName` 只允许留在
   UI 文案与 legacy 显示。

   覆盖用户给定的 I1–I6：
     I1 同名角色撤回：A（speakerId=A）只能撤回 A 的消息，同名 B 的消息不动
     I2 speakerId 优先：speakerId 与 senderName / config_id 冲突时 speakerId 生效
     I3 legacy message：没有 speakerId 的旧消息保持既有 fallback（单聊唯一精确名）
     I4 group identity degradation：`_gMember === null` 有可诊断信息，fallback 语义不变
     I5 无新 authority：没有 IdentityManager / SpeakerAuthority / 新 store
     I6 P24 不回归：planner / memberTurnId / groupOrder / 动态词表均未改

   本文件不依赖模型（除 I4 的一次真实群回合，用最小 mock provider）。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Core = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');
const GROUP_ID = 'group_1700000002000';
const A_ID = 'friend_p290_a';
const B_ID = 'friend_p290_b';
const DUP = '希儿';                 /* 两个角色**同名**（缺陷场景） */
const OTHER_NAME = '另一个显示名';   /* I2：与 speakerId 冲突的显示名 */
const MODEL_A = 'p290-model-a';
const MODEL_B = 'p290-model-b';

let failures = 0;
let passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else {
    failures++;
    console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 320) : ''));
  }
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function count(hay, needle) { return String(hay).split(needle).length - 1; }
function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (e) { /* retry */ }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy-wait 200ms */ }
  }
  return false;
}
/* 取某个函数体的源码切片（到下一个顶层 function 为止；只用于语义守卫，不用行号）。 */
function fnBody(code, name) {
  const i = code.indexOf('function ' + name);
  if (i < 0) return '';
  const tail = code.slice(i);
  const m = /\n(?:async )?function /.exec(tail.slice(1));   /* 跳过声明自身 */
  return m ? tail.slice(0, m.index + 1) : tail;
}

/* ── A · 纯契约：撤回路径现在委派的那个判定函数（M2 resolver）──────────────── */
function resolverContract() {
  const PARTS_SAME = [{ id: A_ID, name: DUP }, { id: B_ID, name: DUP }];

  /* I2 · speakerId 优先于 senderName（同名场景） */
  const canonicalA = Core.resolveSpeakerId({ role: 'assistant', senderName: DUP, metadata: { speakerId: A_ID } }, { participants: PARTS_SAME });
  ok('I2.speakerIdWinsOverSameName', canonicalA.speakerId === A_ID && canonicalA.source === 'metadata' && canonicalA.confidence === 'canonical', canonicalA);

  /* I2 · speakerId 优先于 config_id（两者冲突时不信 config_id / 名字） */
  const conflict = Core.resolveSpeakerId({ role: 'assistant', senderName: DUP, metadata: { speakerId: B_ID, config_id: A_ID } }, { participants: PARTS_SAME });
  ok('I2.speakerIdWinsOverConfigIdAndName', conflict.speakerId === B_ID && conflict.source === 'metadata', conflict);

  /* I1（纯层）· 同名 B 的消息在 A 视角下必须是 OTHER，绝不是 SELF */
  const clsBA = Core.classifyMessageForSpeaker({ role: 'assistant', senderName: DUP, metadata: { speakerId: B_ID } }, A_ID, PARTS_SAME);
  ok('I1.sameNameOtherIsNeverSelf', clsBA === 'OTHER', clsBA);
  const clsAA = Core.classifyMessageForSpeaker({ role: 'assistant', senderName: OTHER_NAME, metadata: { speakerId: A_ID } }, A_ID, PARTS_SAME);
  ok('I2.ownRowWithUnrelatedDisplayNameIsSelf', clsAA === 'SELF', clsAA);

  /* I3 · legacy（无 speakerId）唯一精确名仍可解析；同名歧义 ⇒ 永不 SELF */
  const legacyUnique = Core.resolveSpeakerId({ role: 'assistant', senderName: DUP }, { participants: [{ id: A_ID, name: DUP }] });
  ok('I3.legacyUniqueExactNameStillResolves', legacyUnique.speakerId === A_ID && legacyUnique.confidence === 'legacy', legacyUnique);
  const legacyAmbiguous = Core.resolveSpeakerId({ role: 'assistant', senderName: DUP }, { participants: PARTS_SAME });
  ok('I3.legacyAmbiguousNeverSelf', legacyAmbiguous.confidence === 'none'
    && Core.classifyMessageForSpeaker({ role: 'assistant', senderName: DUP }, A_ID, PARTS_SAME) === 'UNKNOWN', legacyAmbiguous);

  /* 说明：resolver 缺席（核心未加载）时 adapter 的 fail-closed 形状由源码守卫 A8 覆盖
     （`_ibGroupClassifyMessage` 返回 'UNKNOWN'），不在这里伪造一个"缺核心"的全局环境。 */
}

/* ── B · 源码守卫：身份判定点必须走 canonical 分类器 ────────────────────────── */
function sourceGuards() {
  const raw = read('assets/js/communication.js');
  const code = stripComments(raw);

  const withdraw = fnBody(code, '_chatWithdrawSelf');
  const pat = fnBody(code, '_maybePatWithdraw');
  const classify = fnBody(code, '_ibGroupClassifyMessage');

  ok('A1.withdrawUsesCanonicalClassifier', withdraw.indexOf('_ibGroupClassifyMessage') >= 0, withdraw.slice(0, 160));
  ok('A2.patUsesCanonicalClassifier', pat.indexOf('_ibGroupClassifyMessage') >= 0, pat.slice(0, 160));
  ok('A3.noNameEqualityInWithdraw', !/senderName\s*[!=]==/.test(withdraw) && !/senderName\s*\)\s*===/.test(withdraw));
  ok('A4.noNameEqualityInPat', !/senderName\s*[!=]==/.test(pat));
  /* 旧缺陷的精确签名：`String(x.senderName||'')===String(senderName||'')` 必须消失 */
  ok('A5.legacyNameCompareSignatureGone', code.indexOf("String(x.senderName||'')===") < 0
    && code.indexOf("String(cur.senderName||'')===") < 0);
  /* 群聊调用点必须把本轮已有的 participants 透传下去（不新建 authority / 不重读成员表） */
  ok('A6.groupCallSitePassesParticipants', /_applyWithdraw\(cfg,reply,_targetFriend,selfName,_gParticipants\)/.test(code));
  /* 单聊退化路径：省略 participants ⇒ 只认当前角色一个参与者（唯一精确名语义保持） */
  ok('A7.singleChatParticipantsDefault', withdraw.indexOf('Array.isArray(participants)&&participants.length') >= 0);
  /* adapter 的 fail-closed 形状未变：解析不出 canonical id ⇒ UNKNOWN（永不 SELF） */
  ok('A8.classifierFailClosed', classify.indexOf("'UNKNOWN'") >= 0 && classify.indexOf('return') >= 0);
  /* senderName 仍然存在（显示层），本阶段不删除 */
  ok('A9.senderNameStillPresentForDisplay', count(raw, 'senderName') > 20);

  /* I5 · 无新 authority / 新 store / 新 resolver */
  ok('I5.noIdentityManager', code.indexOf('IdentityManager') < 0 && count(raw, 'IdentityManager') === 0);
  ok('I5.noSpeakerAuthority', code.indexOf('SpeakerAuthority') < 0 && code.indexOf('speakerAuthority') < 0);
  ok('I5.noNewResolver', code.indexOf('newIdentityResolver') < 0 && code.indexOf('speakerMatcher') < 0 && code.indexOf('newSpeakerMatcher') < 0);
  /* I5 · 无新 store：修改面（撤回/拍一拍）零持久化；DB schema 仍冻结在 DB_VER=24。
     注：communication.js 既有 localStorage 用法（显示偏好）不在本阶段改动面内，
     因此这里断言的是"新改动没有引入 store / 持久身份"，而不是"文件里没有 localStorage"。 */
  ok('I5.noNewStore', code.indexOf('createObjectStore') < 0
    && withdraw.indexOf('localStorage') < 0 && pat.indexOf('localStorage') < 0
    && withdraw.indexOf('dbPut(') < 0   /* 撤回自身的写点仍在既有的 _chatWithdrawMsg 里 */
    && /DB_VER\s*=\s*24/.test(read('assets/js/core.js')));
  ok('I5.noNewPersistedIdentityField', code.indexOf('identityDegraded:') < 0 && code.indexOf('"identityDegraded"') < 0);
}

/* ── C · I6 · P24 不回归（源码 + 纯函数，独立于既有 P24 套件）──────────────── */
function p24NonRegression() {
  const core = read('assets/js/group-runtime-core.js');
  const coreCode = stripComments(core);
  const comm = read('assets/js/communication.js');

  ok('I6.plannerVersionStill3', /PARTICIPATION_PLAN_VERSION = 3/.test(core));
  ok('I6.plannerIdUnchanged', /'group-rule-v1'/.test(core) && /PARTICIPATION_PLANNER_ID = 'group-rule-v1'/.test(core));
  ok('I6.reasonVocabularyUnchanged', JSON.stringify(Core.PARTICIPATION_REASONS.SKIP) === JSON.stringify(['muted-not-mentioned', 'removed', 'budget-limit']));
  ok('I6.decisionVocabularyUnchanged', JSON.stringify(Core.DYNAMIC_RUNTIME_DECISIONS) === JSON.stringify({ SPEAK: 'speak', SILENT: 'silent', DEFER: 'defer' }));
  ok('I6.gateReasonsUnchanged', JSON.stringify(Core.DYNAMIC_GATE_REASONS)
    === JSON.stringify(['queue-empty', 'cancelled', 'unknown-entry', 'already-started', 'already-silent', 'removed', 'cap-reached']));
  ok('I6.pendingPushStillOnlyDefer', count(coreCode, 'pendingEntries.push(') === 1 && coreCode.indexOf('interjectEntry') < 0 && coreCode.indexOf('admissionPool') < 0);
  ok('I6.memberTurnIdFormulaUnchanged',
    Core.memberTurnIdFor('gturn_p290x', A_ID, 0) === ('turn_' + ChatCore.stableToken('gturn_p290x:' + A_ID + ':0')));
  ok('I6.plannerCalledOncePerTurn', /planParticipation\(_gPlanInput\)/.test(comm) && count(stripComments(comm), 'planParticipation(_gPlanInput)') === 1);
  ok('I6.identityCoreUntouchedByP29', core.indexOf('_ibGroupIdentityDegraded') < 0
    && core.indexOf('withdraw') < 0
    && count(coreCode, 'function resolveSpeakerId(') === 1
    && count(coreCode, 'function classifyMessageForSpeaker(') === 1
    && count(coreCode, 'function memberTurnIdFor(') === 1
    && count(coreCode, 'function planParticipation(') === 1);
  /* _gMember 的构造与写入形状未变（fallback 语义 = M1 既有行为） */
  ok('I6.memberIdentityStillUsesEntryOrder', /_ibGroupMemberIdentity\(_gIdentity,cfg\.id,entry\.order\)/.test(comm));
  ok('I6.legacyFallbackShapeUnchanged', /const aiMsg=\(_gBuilt&&_gBuilt\.length===1\)\?_gBuilt\[0\]:\{id:'msg_'\+Date\.now\(\)/.test(comm));
  ok('I6.noMetadataAddedByDegradePath', /metadata:\{model:cfg\.provider\|\|cfg\.model\|\|'',model_id:cfg\.model\|\|'',config_id:cfg\.id,showThinking:_resolveShowThinking\(cfg\)\}/.test(comm));
}

/* ── 最小 mock provider（只为 I4 的一次真实群回合）──────────────────────────── */
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
        choices: [{ message: { role: 'assistant', content: 'p290-reply-from:' + model }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

/* ── D · 真实浏览器：I1 / I2 / I3 / I4 ─────────────────────────────────────── */
async function browserE2E() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) return;
  const mock = await startMock();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p290-e2e-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
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

    const pageReady = await waitFor(cdp,
      "typeof window._chatWithdrawSelf==='function' && typeof window.dbPut==='function' && typeof window.apiConfigs!=='undefined'"
      + " && !!(window.IBGroupRuntime&&window.IBGroupRuntime.resolveSpeakerId)"
      + " && typeof window._ibGroupIdentityDegradedSnapshot==='function'", 25000);
    ok('page.identitySeamsReady', pageReady);
    await evaluate(cdp, "window.confirm=function(){return true};");

    /* ── fixtures：两个同名角色 + 一个群 + 一组消息 ── */
    const ep = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    const seed = "(async function(){"
      + "var mk=function(id,model){return {id:id,nickname:'" + DUP + "',model:model,endpoint:'" + ep + "',apiKey:'',provider:'custom',"
      + "systemPrompt:'你是测试角色。',temperature:1,streaming:false,showThinking:false,promptCache:false,created:Date.now()}};"
      + "await dbPut('apiConfigs',mk('" + A_ID + "','" + MODEL_A + "'));"
      + "await dbPut('apiConfigs',mk('" + B_ID + "','" + MODEL_B + "'));"
      + "await dbPut('groups',{id:'" + GROUP_ID + "',name:'P29-0 group',members:[{characterId:'" + A_ID + "',status:'active',joinedAt:1},"
      + "{characterId:'" + B_ID + "',status:'active',joinedAt:1}],memoryEnabled:false,created:1});"
      + "var put=function(id,extra){return dbPut('chatMessages',Object.assign({id:id,role:'assistant',content:'body-'+id,friendId:'" + GROUP_ID + "',"
      + "senderName:'" + DUP + "',timestamp:extra.t||1000},extra.m?{metadata:extra.m}:{}))};"
      + "await put('p290_b1',{t:1000,m:{speakerId:'" + B_ID + "',config_id:'" + B_ID + "',turnId:'turn_p290_b',sequenceIndex:0}});"
      + "await put('p290_conf',{t:1001,m:{speakerId:'" + B_ID + "',config_id:'" + A_ID + "',turnId:'turn_p290_c',sequenceIndex:0}});"
      + "await put('p290_a1',{t:1002,m:{speakerId:'" + A_ID + "',config_id:'" + A_ID + "',turnId:'turn_p290_a1',sequenceIndex:0}});"
      + "await dbPut('chatMessages',{id:'p290_a2',role:'assistant',content:'body-p290_a2',friendId:'" + GROUP_ID + "',senderName:'" + OTHER_NAME + "',"
      + "timestamp:1003,metadata:{speakerId:'" + A_ID + "',config_id:'" + A_ID + "',turnId:'turn_p290_a2',sequenceIndex:0}});"
      + "await dbPut('chatMessages',{id:'p290_lg1',role:'assistant',content:'legacy group',friendId:'" + GROUP_ID + "',senderName:'" + DUP + "',timestamp:1004});"
      + "await dbPut('chatMessages',{id:'p290_l1',role:'assistant',content:'legacy 1-1',friendId:'" + A_ID + "',senderName:'" + DUP + "',timestamp:1005,"
      + "metadata:{config_id:'" + A_ID + "'}});"
      + "return 'seeded'})()";
    ok('fixtures.seeded', (await evaluate(cdp, seed)) === 'seeded');
    await evaluate(cdp, "loadApiConfigs()");
    await evaluate(cdp, "activeFriendId='';activeThreadId=null;");

    const rowState = "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');"
      + "var one=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');"
      + "var m={};(all||[]).concat(one||[]).forEach(function(x){m[x.id]=!!x.withdrawn});return m})()";
    const withdrawCall = "window._chatWithdrawSelf(apiConfigs.find(function(c){return c.id==='" + A_ID + "'}),'" + GROUP_ID + "','" + DUP + "',"
      + "[{id:'" + A_ID + "',name:'" + DUP + "'},{id:'" + B_ID + "',name:'" + DUP + "'}])";

    /* ── I1 / I2：同名群聊里 A 只能撤回自己的消息 ── */
    const first = await evaluate(cdp, withdrawCall);
    ok('I1.firstWithdrawReturnsTrue', first === true, first);
    let st = await evaluate(cdp, rowState);
    ok('I1.sameNameB_untouched', st.p290_b1 === false, st);
    ok('I1.conflictRowUntouched', st.p290_conf === false, st);
    ok('I2.newestOwnRowWithdrawableDespiteOtherDisplayName', st.p290_a2 === true, st);
    ok('I1.onlyOneRowWithdrawnPerCall', Object.keys(st).filter(k => st[k]).length === 1, st);

    const second = await evaluate(cdp, withdrawCall);
    st = await evaluate(cdp, rowState);
    ok('I1.secondCallWithdrawsOlderOwnRow', second === true && st.p290_a1 === true, { second, st });
    ok('I1.sameNameB_stillUntouched', st.p290_b1 === false && st.p290_conf === false, st);

    const third = await evaluate(cdp, withdrawCall);
    ok('I1.thirdCallFindsNothingOwn', third === false, third);
    st = await evaluate(cdp, rowState);
    ok('I3.legacyAmbiguousGroupNeverWithdrawnBySelf', st.p290_lg1 === false, st);

    /* ── I3：legacy 单聊（无 speakerId，config_id + 唯一显示名）保持可撤回 ── */
    const legacyOut = await evaluate(cdp,
      "window._applyWithdraw(apiConfigs.find(function(c){return c.id==='" + A_ID + "'}),'前一句 <withdraw/>','" + A_ID + "','" + DUP + "')");
    st = await evaluate(cdp, rowState);
    ok('I3.legacySingleChatStillWithdrawable', legacyOut === '前一句' && st.p290_l1 === true, { legacyOut, st });
    ok('I3.legacyGroupRowStillUntouched', st.p290_lg1 === false, st);

    /* ── I4：身份退化可诊断，且 fallback 语义不变 ── */
    ok('I4.diagnosticSurfaceEmptyBeforeDegrade', JSON.stringify(await evaluate(cdp, 'window._ibGroupIdentityDegradedSnapshot()')) === '{}');
    await evaluate(cdp,
      "(function(){window.__p290OrigCreate=window.IBGroupRuntime.createMemberIdentity;"
      + "window.IBGroupRuntime.createMemberIdentity=function(){return null};return true})()");
    const send = "(function(){activeFriendId='" + GROUP_ID + "';activeThreadId=null;openChatPanel();"
      + "var i=document.getElementById('chat-input');i.value='P29-0 degraded turn';return sendChatMessage()})()";
    await evaluate(cdp, send);
    const degradedRows = await waitFor(cdp,
      "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');"
      + "var r=(all||[]).filter(function(m){return m.role==='assistant'&&String(m.content||'').indexOf('p290-reply-from:')===0});return r.length>=2})()", 30000);
    const snap = await evaluate(cdp, 'window._ibGroupIdentityDegradedSnapshot()');
    ok('I4.degradationIsDiagnosable', Number(snap && snap['member-identity-unavailable'] || 0) >= 2, snap);
    const degradedMeta = await evaluate(cdp,
      "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + GROUP_ID + "');"
      + "return (all||[]).filter(function(m){return m.role==='assistant'&&String(m.content||'').indexOf('p290-reply-from:')===0})"
      + ".map(function(m){return m.metadata||{}})})()");
    ok('I4.degradedTurnStillProducesReplies', degradedRows === true && degradedMeta.length >= 2, degradedMeta.length);
    ok('I4.fallbackWritesLegacyShapeNoP24Keys',
      degradedMeta.every(m => !('groupTurnId' in m) && !('speakerId' in m) && !('groupOrder' in m)), degradedMeta);
    ok('I4.noDiagnosticKeyLeaksIntoCanonical',
      degradedMeta.every(m => !('identityDegraded' in m) && !('degraded' in m)), degradedMeta);
    await evaluate(cdp,
      "(function(){window.IBGroupRuntime.createMemberIdentity=window.__p290OrigCreate;delete window.__p290OrigCreate;return true})()");

    /* ── 边界：单聊路径未被污染 + 无未捕获异常 ── */
    ok('boundary.singleChatRowsUnaffectedByGroupIdentity', (await evaluate(cdp,
      "(async function(){var all=await dbGetByIndex('chatMessages','byFriend','" + A_ID + "');"
      + "return (all||[]).every(function(m){return !m.metadata||(!('groupTurnId' in m.metadata)&&!('groupOrder' in m.metadata))})})()")) === true);
    ok('boundary.noUncaughtExceptions', exceptions.length === 0, exceptions.slice(0, 3));
  } finally {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { mock.server.close(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== P29-0 · Identity Read-Path Closure 测试 ==');
  resolverContract();
  sourceGuards();
  p24NonRegression();
  await browserE2E();
  console.log(failures === 0 ? '\n全部通过 ✔  (' + passes + ')'
    : '\n失败 ' + failures + ' 项');
  process.exitCode = failures ? 1 : 0;
}

main().catch(e => { console.error('harness error: ' + (e && e.message)); process.exitCode = 2; });
