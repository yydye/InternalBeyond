/* ====================================================================
   P11-2 · Middle Brain Character Integrity / OOC Guard · CDP 回归
   --------------------------------------------------------------------
   本阶段唯一新增能力：检测候选回复是否**明显**偏离当前角色，仅在高置信度强 OOC 时
   做最多一次 targeted rewrite（保留原意/事实/信息量），默认关闭且关闭时零额外调用。
   验证（真实 localhost 页面 + CDP + mock 角色端点 + mock Astra 端点）：
     A. 契约与边界：integrity 层契约冻结、门面键位、无 window 兼容别名、调用方不知道内部概念
     B. Guard OFF：行为与 P11-1C 等价（原回复、零 Astra 请求、零 judge/rewrite）
     C. 确定性解析：Judge/Rewrite JSON 白名单、clamp、malformed → null
     D. Rewrite Gate：阈值化门控（纯函数），只有强 OOC 才重写
     E. 运行语义（mock 模型）：pass / fail / malformed / HTTP / timeout / rewrite 各种失败
        → 一律回退原候选；rewrite 次数恒 ≤1；verify 不触发第二次 rewrite
     F. 反误杀：正常生气/冷淡/玩笑/用户要求正式/技术讨论/上下文有依据的变化 → 不判 OOC
     G. 端到端（真实 sendChatMessage）：pass → 原文；强 OOC → 改写；OFF → 原文；控制标签 → 不改写
   运行：node test_middle_brain_integrity.js
   ==================================================================== */
'use strict';

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');


let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, ROOT);

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); }));

/* ── mock：一个端点同时充当 角色模型（chat/completions）与 Astra（responses）──
   按请求体里的 schema 名区分 judge / rewrite / MB 压缩；全部计数，供"零调用"断言。 */
const CANDIDATE = 'CANDIDATE_REPLY_原文';
const REWRITTEN = 'REWRITTEN_REPLY_已修正';
const mock = {
  judge: 0, rewrite: 0, compress: 0, char: 0,
  judgeMode: 'ok', rewriteMode: 'ok', judgeFailAfterFirst: false,
  judgePayload: JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] }),
  rewritePayload: JSON.stringify({ reply: REWRITTEN }),
  charPayload: CANDIDATE,
  lastJudgePrompt: '', lastRewritePrompt: '', lastCharBody: ''
};
const STRONG_OOC = JSON.stringify({
  pass: false, score: 0.12, confidence: 0.95,
  violations: [{ dimension: 'persona', severity: 0.9, evidence: '我是AI助手', reason: '与角色人格实质冲突' }]
});
const SLIGHT = JSON.stringify({
  pass: false, score: 0.42, confidence: 0.70,
  violations: [{ dimension: 'speech_style', severity: 0.55, evidence: '嗯', reason: '措辞略有差异' }]
});

function responsesBody(text) {
  return JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } });
}
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' };
const api = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.method !== 'POST') { res.writeHead(404, CORS); res.end('{}'); return; }
  if (/character_integrity_report/.test(raw)) {
    mock.judge++; mock.lastJudgePrompt = raw;
    if (mock.judgeMode === 'fail') { res.writeHead(500, CORS); res.end('{}'); return; }
    if (mock.judgeFailAfterFirst && mock.judge > 1) { res.writeHead(500, CORS); res.end('{}'); return; }
    if (mock.judgeMode === 'slow') { setTimeout(() => { res.writeHead(200, CORS); res.end(responsesBody(mock.judgePayload)); }, 3000); return; }
    res.writeHead(200, CORS); res.end(responsesBody(mock.judgePayload)); return;
  }
  if (/character_integrity_rewrite/.test(raw)) {
    mock.rewrite++; mock.lastRewritePrompt = raw;
    if (mock.rewriteMode === 'fail') { res.writeHead(500, CORS); res.end('{}'); return; }
    if (mock.rewriteMode === 'slow') { setTimeout(() => { res.writeHead(200, CORS); res.end(responsesBody(mock.rewritePayload)); }, 3000); return; }
    res.writeHead(200, CORS); res.end(responsesBody(mock.rewritePayload)); return;
  }
  if (/middle_brain_result/.test(raw)) { mock.compress++; res.writeHead(200, CORS); res.end(responsesBody(JSON.stringify({ keep: [], merge: [], drop: [], compressedContext: 'MB_COMPRESSED', currentKept: true }))); return; }
  mock.char++; mock.lastCharBody = raw;
  res.writeHead(200, CORS);
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: mock.charPayload }, finish_reason: 'stop' }] }));
});

(async () => {
  const apiPort = await listen(api), apiBase = 'http://127.0.0.1:' + apiPort;
  const ep = apiBase + '/v1/responses';
  const charEp = apiBase + '/v1/chat/completions';
  const web = require(path.join(ROOT, 'services', 'internal-beyond-server.js')).createWebServer({ root: ROOT, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ci-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;

  const setMb = cfg => evaluate(cdp, `(async function(){await saveMiddleBrainConfig(${JSON.stringify(cfg)});return true})()`);
  const resetMock = () => { mock.judge = 0; mock.rewrite = 0; mock.compress = 0; mock.char = 0; mock.lastJudgePrompt = ''; mock.lastRewritePrompt = ''; mock.judgeFailAfterFirst = false; };
  /* 直接调用生成后执行缝（等价于 production 调用点） */
  const finalize = (candidate, opts) => evaluate(cdp, `(async function(){
    return await IB.middleBrain.middleBrainFinalizeReply('ci_role','CI_USER_MESSAGE',${JSON.stringify(candidate)},${JSON.stringify(opts || {})});
  })()`);
  const telemetry = () => evaluate(cdp, `(function(){return IB.middleBrain.middleBrainCharacterIntegrityTelemetry()})()`);
  const resetTel = () => evaluate(cdp, `(function(){IB.middleBrain.middleBrainCharacterIntegrityReset();return true})()`);
  const evidenceOpts = { character: { nickname: '泠', relationship: '熟悉的伙伴', systemPrompt: '你是冷淡、话少、偶尔毒舌的猫娘「泠」。' }, history: [{ role: 'user', content: '今天好累' }, { role: 'assistant', content: '嗯。' }] };

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok) { ready = true; break; } } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && !!(window.IB&&window.IB.middleBrain) && typeof IB.middleBrain.middleBrainFinalizeReply==='function' && typeof IB.middleBrain.middleBrainCharacterIntegrity==='function'", 25000), 'page + integrity layer mounted');

    await evaluate(cdp, `(async function(){
      await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:false,welcomeInterval:2,musicEnabled:false,summaryApiId:'',summaryWindow:60});
      return true})()`);

    /* ═══════════════ A. 契约与边界 ═══════════════ */
    check('A1.layerContractFrozen', await evaluate(cdp, `(function(){
      var C=IB.__middleBrainContracts;
      return !!C && Object.isFrozen(C.integrity) && typeof C.integrity.middleBrainCharacterIntegrity==='function'
        && typeof C.integrity._mbCiGate==='function' && typeof C.integrity.MB_CI_SCHEMA==='object';
    })()`));
    check('A2.publicKeys45', await evaluate(cdp, `(function(){
      /* P11-2 之后 45 个门面 key；P12 追加 Image Router 决策键（middleBrainImageMode /
         normalizeMiddleBrainImageMode）→ 47；P21 追加统一思考深度读取键
         （middleBrainReasoningEffort）→ 48。数量变化必须是有意的契约扩展。 */
      var k=Object.keys(IB.middleBrain);
      return k.length===48 && k.indexOf('middleBrainFinalizeReply')>=0 && k.indexOf('middleBrainCharacterIntegrity')>=0
        && k.indexOf('_mbParseCiJson')>=0 && k.indexOf('MB_CI_SCHEMA')>=0
        && k.indexOf('middleBrainImageMode')>=0;
    })()`), await evaluate(cdp, `(function(){return Object.keys(IB.middleBrain).length})()`));
    check('A3.noWindowAliasForNewKeys', await evaluate(cdp, `(function(){
      return typeof window.middleBrainFinalizeReply==='undefined' && typeof window.middleBrainCharacterIntegrity==='undefined'
        && typeof window._mbParseCiJson==='undefined' && typeof window.MB_CI_SCHEMA==='undefined'
        && typeof window._mbCiGate==='undefined' && typeof window.mbIntegrityToggle==='undefined';
    })()`));
    check('A4.windowCompatStill43', await evaluate(cdp, `(function(){
      var n=0;['middleBrainOrganizeContext','middleBrainCompressPipeline','middleBrainAstraJudge','getMiddleBrainConfig','loadMiddleBrainConfigUI'].forEach(function(k){if(k in window)n++});
      return n===5 && typeof window.middleBrainCompressPipeline==='function';
    })()`));
    check('A5.integrityNotOnFacadeAsLayer', await evaluate(cdp, `(function(){
      return !('integrity' in IB.middleBrain) && !('config' in IB.middleBrain) && !('__middleBrainContracts' in IB.middleBrain);
    })()`));
    const comText = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'communication.js'), 'utf8');
    const hookBlocks = [...comText.matchAll(/P11-2 · Middle Brain 生成后收口[\s\S]*?finalize failed'[^\n]*\n/g)].map(m => m[0]);
    check('A6.consumerTwoHooks', hookBlocks.length === 2, 'call sites=' + hookBlocks.length);
    check('A7.consumerNoInternalConcepts', hookBlocks.every(b => !/ooc|integrity|violation|rewrite|threshold|judge|sensitivity|MB_CI|__middleBrainContracts/i.test(b)));
    check('A8.consumerFacadeOnly', hookBlocks.every(b => /window\.IB&&window\.IB\.middleBrain/.test(b) && /middleBrainFinalizeReply\(/.test(b)));
    check('A9.noGroupWiring', !/isGroup[\s\S]{0,400}middleBrainFinalizeReply/.test(comText) && !/_buildGroupChatContext[\s\S]{0,2000}middleBrainFinalizeReply/.test(comText));
    check('A10.noOtherConsumer', !fs.readdirSync(path.join(ROOT, 'assets', 'js')).filter(f => f.endsWith('.js'))
      .filter(f => !/^middle-brain/.test(f) && f !== 'communication.js').some(f => /middleBrainFinalizeReply\s*\(/.test(fs.readFileSync(path.join(ROOT, 'assets', 'js', f), 'utf8'))));

    /* ═══════════════ B. Guard OFF ═══════════════ */
    await setMb({ enabled: true, endpoint: ep, model: 'gpt-6-astra', apiKey: 'sk-x', characterIntegrityEnabled: false, characterIntegrityRewrite: false });
    await resetMock(); await resetTel();
    let r = await finalize(CANDIDATE, evidenceOpts);
    check('B1.offReturnsCandidate', r === CANDIDATE, String(r));
    check('B2.offZeroRequests', mock.judge === 0 && mock.rewrite === 0 && mock.compress === 0, JSON.stringify(mock));
    let t = await telemetry();
    check('B3.offZeroTelemetry', t.checked === 0 && t.judgeRuns === 0 && t.rewriteTriggered === 0 && (t.skipped.disabled || 0) === 1, JSON.stringify(t.skipped));
    check('B4.offRewriteEvenIfGated', await (async () => {
      mock.judgePayload = STRONG_OOC;
      const out = await finalize(CANDIDATE, evidenceOpts);
      return out === CANDIDATE && mock.judge === 0;
    })());
    /* 无 Astra 就绪（无 apiKey）→ 不发起任何请求 */
    await setMb({ characterIntegrityEnabled: true, characterIntegrityRewrite: true, apiKey: '' });
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('B5.notReadyNoRequest', r === CANDIDATE && mock.judge === 0 && mock.rewrite === 0, JSON.stringify(mock));
    t = await telemetry();
    check('B6.notReadyTelemetry', (t.skipped.astra_not_ready || 0) === 1, JSON.stringify(t.skipped));
    /* voice 轮不接（本阶段范围外） */
    await setMb({ enabled: true, endpoint: ep, model: 'gpt-6-astra', apiKey: 'sk-x', characterIntegrityEnabled: true, characterIntegrityRewrite: true });
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, Object.assign({ voice: true }, evidenceOpts));
    check('B7.voiceSkipped', r === CANDIDATE && mock.judge === 0, JSON.stringify(mock));
    t = await telemetry();
    check('B8.voiceTelemetry', (t.skipped.voice_surface || 0) === 1, JSON.stringify(t.skipped));
    /* 空候选 / 非字符串：直接原样返回，不进入 Guard */
    await resetMock(); await resetTel();
    check('B9.emptyCandidate', await finalize('', evidenceOpts) === '' && mock.judge === 0);
    check('B10.nonStringCandidate', await evaluate(cdp, `(async function(){return (await IB.middleBrain.middleBrainFinalizeReply('ci_role','m',null,{}))===null})()`) && mock.judge === 0);

    /* ═══════════════ C. 确定性解析 ═══════════════ */
    check('C1.parseNormal', await evaluate(cdp, `(function(){
      var j=IB.middleBrain._mbParseCiJson(JSON.stringify({pass:false,score:0.2,confidence:0.9,violations:[{dimension:'persona',severity:0.88,evidence:'e',reason:'r'}]}));
      return !!j && j.pass===false && j.score===0.2 && j.confidence===0.9 && j.violations.length===1 && j.violations[0].dimension==='persona' && j.maxSeverity===0.88;
    })()`));
    check('C2.parseMalformedNull', await evaluate(cdp, `(function(){
      return IB.middleBrain._mbParseCiJson('垃圾')===null && IB.middleBrain._mbParseCiJson('{"bad"')===null && IB.middleBrain._mbParseCiJson('')===null
        && IB.middleBrain._mbParseCiJson(JSON.stringify({score:0.5,violations:[]}))===null
        && IB.middleBrain._mbParseCiJson(JSON.stringify({pass:true,violations:[]}))===null
        && IB.middleBrain._mbParseCiJson(JSON.stringify({pass:true,score:0.5}))===null;
    })()`));
    check('C3.parseClampAndWhitelist', await evaluate(cdp, `(function(){
      var j=IB.middleBrain._mbParseCiJson(JSON.stringify({pass:false,score:7,confidence:-1,violations:[
        {dimension:'persona',severity:9,evidence:'e',reason:'r'},
        {dimension:'invented_dimension',severity:0.9,evidence:'e',reason:'r'}]}));
      return j.score===1 && j.confidence===0 && j.violations.length===1 && j.violations[0].severity===1;
    })()`));
    check('C4.parseConfidenceMissingIsZero', await evaluate(cdp, `(function(){
      var j=IB.middleBrain._mbParseCiJson(JSON.stringify({pass:false,score:0.1,violations:[]}));
      return !!j && j.confidence===0;
    })()`));
    check('C5.parseViolationCap', await evaluate(cdp, `(function(){
      var v=[];for(var i=0;i<30;i++)v.push({dimension:'behavior',severity:0.9,evidence:'e',reason:'r'});
      var j=IB.middleBrain._mbParseCiJson(JSON.stringify({pass:false,score:0.1,confidence:0.9,violations:v}));
      return j.violations.length===8;
    })()`));
    const BT = String.fromCharCode(96).repeat(3);   /* ``` —— 避免在模板字符串里写反引号 */
    check('C6.parseRewrite', await evaluate(cdp, `(function(){
      return IB.__middleBrainContracts.integrity._mbParseCiRewriteJson('{"reply":"ok"}')==='ok'
        && IB.__middleBrainContracts.integrity._mbParseCiRewriteJson(${JSON.stringify(BT + 'json\n{"reply":"ok2"}\n' + BT)})==='ok2'
        && IB.__middleBrainContracts.integrity._mbParseCiRewriteJson('{"reply":""}')===null && IB.__middleBrainContracts.integrity._mbParseCiRewriteJson('not json')===null;
    })()`));
    check('C7.visibleTextStripsControlTags', await evaluate(cdp, `(function(){
      var v=IB.middleBrain._mbCiVisibleText('你好<withdraw/><ws_read path="a"/>世界<mem_op>x</mem_op>');
      return v.indexOf('withdraw')<0 && v.indexOf('ws_read')<0 && v.indexOf('mem_op')<0 && v.indexOf('你好')>=0 && v.indexOf('世界')>=0;
    })()`));
    check('C8.controlTagDetect', await evaluate(cdp, `(function(){
      return IB.__middleBrainContracts.integrity._mbCiHasControlTags('<withdraw/>')===true && IB.__middleBrainContracts.integrity._mbCiHasControlTags('a<ws_read path="x"/>b')===true
        && IB.__middleBrainContracts.integrity._mbCiHasControlTags(${JSON.stringify(BT + 'file:a.txt\nhi\n' + BT)})===true && IB.__middleBrainContracts.integrity._mbCiHasControlTags('普通回复，带 <b>html</b>')===false;
    })()`));

    /* ═══════════════ D. Rewrite Gate（纯函数） ═══════════════ */
    const gate = (report, cfg, opts) => evaluate(cdp, `(function(){
      return IB.middleBrain._mbCiGate(${JSON.stringify(report)}, ${JSON.stringify(cfg)}, ${JSON.stringify(opts || {})});
    })()`);
    const CFG_ON = { characterIntegrityEnabled: true, characterIntegrityRewrite: true, characterIntegritySensitivity: 'conservative' };
    const strong = JSON.parse(STRONG_OOC);
    check('D1.passNoRewrite', (await gate({ pass: true, score: 0.95, confidence: 0.9, violations: [], maxSeverity: 0 })).reason === 'judge_pass');
    check('D2.rewriteDisabled', (await gate(strong, { characterIntegrityEnabled: true, characterIntegrityRewrite: false })).reason === 'rewrite_disabled');
    check('D3.lowConfidence', (await gate(Object.assign({}, strong, { confidence: 0.5 }), CFG_ON)).reason === 'low_confidence');
    check('D4.scoreAbove', (await gate(Object.assign({}, strong, { score: 0.9 }), CFG_ON)).reason === 'score_above_threshold');
    check('D5.severityBelow', (await gate(Object.assign({}, strong, { maxSeverity: 0.3 }), CFG_ON)).reason === 'severity_below_threshold');
    check('D6.controlTags', (await gate(strong, CFG_ON, { controlTags: true })).reason === 'control_tags_present');
    check('D7.rewriteUsed', (await gate(strong, CFG_ON, { rewriteUsed: true })).reason === 'rewrite_already_used');
    const ok = await gate(strong, CFG_ON);
    check('D8.strongOocRewrites', ok.rewrite === true && ok.reason === 'strong_ooc', JSON.stringify(ok));
    const cons = (await gate(strong, CFG_ON)).thresholds, strict = (await gate(strong, Object.assign({}, CFG_ON, { characterIntegritySensitivity: 'strict' }))).thresholds;
    check('D9.sensitivityOrdered', cons.confidence > strict.confidence && cons.score < strict.score && cons.severity > strict.severity, JSON.stringify({ cons, strict }));
    check('D10.slightDeviationNoRewrite', (await gate(JSON.parse(SLIGHT), CFG_ON)).rewrite === false);
    check('D11.unknownSensitivityConservative', (await gate(strong, Object.assign({}, CFG_ON, { characterIntegritySensitivity: 'bogus' }))).thresholds.confidence === cons.confidence);

    /* ═══════════════ E. 运行语义（mock 模型） ═══════════════ */
    /* E1 · Judge PASS → 原候选，judge 1 次、rewrite 0 次 */
    mock.judgePayload = JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] });
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E1.judgePassUnchanged', r === CANDIDATE && mock.judge === 1 && mock.rewrite === 0, JSON.stringify(mock));
    t = await telemetry();
    check('E2.passTelemetry', t.checked === 1 && t.judgeRuns === 1 && t.judgePass === 1 && t.judgeFail === 0 && t.rewriteTriggered === 0 && t.last.judgeResult === 'pass', JSON.stringify(t.last));
    check('E3.judgePromptHasEvidence', /泠/.test(mock.lastJudgePrompt) && /今天好累/.test(mock.lastJudgePrompt) && /CANDIDATE_REPLY_原文/.test(mock.lastJudgePrompt));

    /* E4 · 强 OOC → 一次重写 */
    mock.judgePayload = STRONG_OOC; mock.rewritePayload = JSON.stringify({ reply: REWRITTEN });
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E4.strongOocRewritten', r === REWRITTEN && mock.judge === 1 && mock.rewrite === 1, JSON.stringify({ r, judge: mock.judge, rewrite: mock.rewrite }));
    t = await telemetry();
    check('E5.rewriteTelemetry', t.judgeFail === 1 && t.rewriteTriggered === 1 && t.rewriteOk === 1 && t.rewriteError === 0 && t.last.rewriteTriggered === true && t.last.rewriteOk === true, JSON.stringify(t.last));
    check('E6.rewritePromptPreservesIntent', /必须保留/.test(mock.lastRewritePrompt) && /严禁/.test(mock.lastRewritePrompt) && /不要.*重新回答用户|不是\*\*重新回答用户/.test(mock.lastRewritePrompt) && /persona/.test(mock.lastRewritePrompt));
    check('E7.rewriteCountAtMostOne', t.maxRewritesPerTurn <= 1 && mock.rewrite === 1);

    /* E8 · 轻微偏差 → 不重写 */
    mock.judgePayload = SLIGHT;
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E8.slightNoRewrite', r === CANDIDATE && mock.judge === 1 && mock.rewrite === 0, JSON.stringify(mock));
    t = await telemetry();
    check('E9.slightTelemetry', t.judgeFail === 1 && t.rewriteTriggered === 0 && t.rewriteSkipped === 1, JSON.stringify(t.skipped));

    /* E10 · Judge malformed → 原候选 */
    mock.judgePayload = '这不是 JSON';
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E10.judgeMalformed', r === CANDIDATE && mock.judge === 1 && mock.rewrite === 0, JSON.stringify(mock));
    t = await telemetry();
    check('E11.malformedTelemetry', t.judgeMalformed === 1 && t.last.judgeResult === 'malformed', JSON.stringify(t.last));

    /* E12 · Judge HTTP 500 → 原候选 */
    mock.judgePayload = STRONG_OOC; mock.judgeMode = 'fail';
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E12.judgeHttp500', r === CANDIDATE && mock.rewrite === 0, JSON.stringify(mock));
    t = await telemetry();
    check('E13.judgeErrorTelemetry', t.judgeError === 1 && t.last.judgeResult === 'error', JSON.stringify(t.last));

    /* E14 · Judge timeout → 原候选 */
    mock.judgeMode = 'slow';
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, Object.assign({ judgeTimeoutMs: 400 }, evidenceOpts));
    check('E14.judgeTimeout', r === CANDIDATE && mock.rewrite === 0, JSON.stringify(mock));
    t = await telemetry();
    check('E15.timeoutTelemetry', t.judgeError === 1 && (t.skipped.judge_timeout || 0) === 1, JSON.stringify(t.skipped));
    mock.judgeMode = 'ok';

    /* E16 · rewrite HTTP 500 → 原候选 */
    mock.rewriteMode = 'fail';
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E16.rewriteHttp500', r === CANDIDATE && mock.judge === 1 && mock.rewrite === 1, JSON.stringify({ r, j: mock.judge, w: mock.rewrite }));
    t = await telemetry();
    check('E17.rewriteErrorTelemetry', t.rewriteError === 1 && t.rewriteOk === 0 && t.last.rewriteOk === false, JSON.stringify(t.last));

    /* E18 · rewrite timeout → 原候选 */
    mock.rewriteMode = 'slow';
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, Object.assign({ rewriteTimeoutMs: 400 }, evidenceOpts));
    check('E18.rewriteTimeout', r === CANDIDATE && mock.rewrite === 1, JSON.stringify({ r, w: mock.rewrite }));

    /* E19 · rewrite malformed → 原候选 */
    mock.rewriteMode = 'ok'; mock.rewritePayload = '不是 JSON';
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E19.rewriteMalformed', r === CANDIDATE, String(r));

    /* E20 · rewrite 试图注入控制标签 → 原候选 */
    mock.rewritePayload = JSON.stringify({ reply: REWRITTEN + '<ws_read path="x"/>' });
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E20.rewriteControlTagRejected', r === CANDIDATE, String(r));
    t = await telemetry();
    check('E21.rewriteControlTagTelemetry', (t.skipped.rewrite_control_tags || 0) === 1, JSON.stringify(t.skipped));

    /* E22 · rewrite 长度漂移（编剧情）→ 原候选 */
    mock.rewritePayload = JSON.stringify({ reply: REWRITTEN + '新增剧情'.repeat(200) });
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E22.rewriteTooLongRejected', r === CANDIDATE, String(r).slice(0, 40));

    /* E23 · rewrite 过短（截断）→ 原候选 */
    const LONG_CANDIDATE = '这是一段足够长的角色回复，包含若干完整句子与信息量，用来验证截断保护。'.repeat(3);
    mock.rewritePayload = JSON.stringify({ reply: '嗯。' });
    await resetMock(); await resetTel();
    r = await finalize(LONG_CANDIDATE, evidenceOpts);
    check('E23.rewriteTooShortRejected', r === LONG_CANDIDATE, String(r).slice(0, 40));

    /* E24 · verify 开启：即使 verify 仍判 fail，也绝不第二次重写 */
    mock.rewritePayload = JSON.stringify({ reply: REWRITTEN });
    mock.judgePayload = STRONG_OOC;   /* 每次 judge 都 fail（包括 verify） */
    await setMb({ characterIntegrityVerify: true });
    await resetMock(); await resetTel();
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E24.verifyNoSecondRewrite', r === REWRITTEN && mock.rewrite === 1 && mock.judge === 2, JSON.stringify({ r, j: mock.judge, w: mock.rewrite }));
    t = await telemetry();
    check('E25.verifyTelemetry', t.verifyRuns === 1 && t.verifyFail === 1 && t.maxRewritesPerTurn <= 1 && t.rewriteTriggered === 1, JSON.stringify(t));
    const ciSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-integrity.js'), 'utf8');
    check('E26.verifyNeverRewritesStatically', !/⑦ Optional verify[\s\S]*await _ciCall\(_mbCiRewritePrompt\(/.test(ciSrc));
    /* verify 也失败（HTTP 500）→ 不影响已生效的改写 */
    await resetMock(); await resetTel();
    mock.judgeFailAfterFirst = true;
    r = await finalize(CANDIDATE, evidenceOpts);
    check('E27.verifyErrorKeepsRewrite', r === REWRITTEN && mock.rewrite === 1, JSON.stringify({ r, w: mock.rewrite }));
    t = await telemetry();
    check('E28.verifyErrorTelemetry', t.verifyError === 1 && t.rewriteOk === 1, JSON.stringify(t.last));
    mock.judgeFailAfterFirst = false;
    await setMb({ characterIntegrityVerify: false });

    /* E29 · 控制标签候选：仍然判定，但不重写（工具副作用不可安全重建） */
    const TAG_CANDIDATE = CANDIDATE + '<ws_read path="a.txt"/>';
    await resetMock(); await resetTel();
    r = await finalize(TAG_CANDIDATE, evidenceOpts);
    check('E29.controlTagCandidateNotRewritten', r === TAG_CANDIDATE && mock.judge === 1 && mock.rewrite === 0, JSON.stringify({ r, w: mock.rewrite }));
    t = await telemetry();
    check('E30.controlTagTelemetry', (t.skipped.gate_control_tags_present || 0) === 1, JSON.stringify(t.skipped));

    /* E31 · 内部异常安全：证据组装抛错 → 原候选（Guard 绝不影响聊天） */
    await resetMock(); await resetTel();
    r = await evaluate(cdp, `(async function(){
      var bad={};Object.defineProperty(bad,'nickname',{get:function(){throw new Error('boom')}});
      try{return await IB.middleBrain.middleBrainFinalizeReply('ci_role','m','SAFE_CANDIDATE',{character:bad,history:null})}
      catch(e){return 'THREW:'+e.message}
    })()`);
    check('E31.internalErrorSafe', r === 'SAFE_CANDIDATE', String(r));

    /* E32 · 上下文证据（canonical snapshot）进入 judge prompt，且缺失维度被标注 */
    mock.judgePayload = JSON.stringify({ pass: true, score: 0.9, confidence: 0.9, violations: [] });
    await resetMock(); await resetTel();
    r = await evaluate(cdp, `(async function(){
      var CS=window.IBContextSnapshot;
      var snap=CS.create({characterId:'ci_role',turnId:'t',fields:{
        memory:CS.field('getMemoryContext','MEMORY_EVIDENCE_她讨厌被人叫姐姐'),
        understanding:CS.field('getUnderstandingContext',''),
        thread:CS.field('getThreadContext',''),
        moments:CS.field('getMomentsContext','')
      },gates:{threadMemoryEnabled:true}});
      return await IB.middleBrain.middleBrainFinalizeReply('ci_role','m','CANDIDATE_REPLY_原文',{character:{nickname:'泠',systemPrompt:'冷淡猫娘'},history:[],contextSnapshot:snap});
    })()`);
    check('E32.snapshotEvidenceInPrompt', r === CANDIDATE && /MEMORY_EVIDENCE_她讨厌被人叫姐姐/.test(mock.lastJudgePrompt), JSON.stringify({r, prompt: (mock.lastJudgePrompt||'').slice(0,120), snap: await evaluate(cdp, "(function(){var CS=window.IBContextSnapshot;var s=CS.create({characterId:'x',turnId:'t',fields:{memory:CS.field('getMemoryContext','MEM')},gates:{}});return {hasCS:!!CS, state:CS.state(s,'memory'), value:CS.value(s,'memory')}})()")}).slice(0,600));
    check('E33.evidenceAvailability', await evaluate(cdp, `(function(){
      var ev=IB.__middleBrainContracts.integrity._mbCiBuildEvidence('x','m',{character:{nickname:'a'},history:[]});
      return ev.available.knowledge_boundary===false && ev.available.emotional_continuity===false && ev.available.persona===true;
    })()`));

    /* ═══════════════ F. 反误杀 ═══════════════ */
    /* F1 · Judge prompt 必须内建"上下文变化 > 静态人设"原则 + 缺证据维度禁判 */
    const promptChecks = {
      'F1.contextOverStereotype': /当前上下文中的明确变化证据 > 静态人设刻板印象/.test(mock.lastJudgePrompt || ''),
      'F2.userRequestedChangeNotOoc': /按用户要求暂时正式\/冷淡\/生气\/开玩笑 → 不是 OOC/.test(mock.lastJudgePrompt || ''),
      'F3.normalAngerNotOoc': /角色正常生气、正常冷淡、正常开玩笑 → 不是 OOC/.test(mock.lastJudgePrompt || ''),
      'F4.technicalNotOoc': /讨论技术\/事实问题、语气变平实 → 不是 OOC/.test(mock.lastJudgePrompt || ''),
      'F5.modelVoiceNotOoc': /不同底层模型本来就该有不同的声音/.test(mock.lastJudgePrompt || ''),
      'F6.substantiveConflictOnly': /实质冲突/.test(mock.lastJudgePrompt || ''),
      'F7.noChainOfThought': /不要 chain-of-thought/.test(mock.lastJudgePrompt || '')
    };
    Object.keys(promptChecks).forEach(k => check(k, promptChecks[k]));
    /* F8 · 六个 adversarial fixture：真实 prompt 中带上对应上下文，Judge 判 pass → 一律不干预 */
    const fixtures = [
      { name: 'F8.normalAnger', user: '你怎么突然生气了？', hist: [{ role: 'assistant', content: '我说了别碰我的东西！' }], reply: '我很生气。' },
      { name: 'F9.coldNormal', user: '在吗', hist: [], reply: '嗯。' },
      { name: 'F10.joking', user: '讲个笑话', hist: [], reply: '哈，你比我还好笑。' },
      { name: 'F11.userRequestedFormal', user: '请用正式语气回答我的合同问题', hist: [], reply: '好的，以下为正式说明：…' },
      { name: 'F12.technical', user: '解释一下事件循环', hist: [], reply: '事件循环是…（技术说明）' },
      { name: 'F13.contextJustifiedShift', user: '我今天很难过', hist: [{ role: 'assistant', content: '我在。' }], reply: '我在，慢慢说。' }
    ];
    mock.judgePayload = JSON.stringify({ pass: true, score: 0.9, confidence: 0.88, violations: [] });
    for (const f of fixtures) {
      await resetMock(); await resetTel();
      const out = await finalize(f.reply, { character: evidenceOpts.character, history: f.hist });
      t = await telemetry();
      check(f.name, out === f.reply && mock.rewrite === 0 && t.rewriteTriggered === 0 && mock.lastJudgePrompt.includes(f.user === '在吗' ? 'CI_USER_MESSAGE' : 'CI_USER_MESSAGE'), JSON.stringify({ out, w: mock.rewrite }));
    }

    /* ═══════════════ G. 端到端（真实 sendChatMessage） ═══════════════ */
    await evaluate(cdp, `(function(){ var cfg={ id:'ci_friend', nickname:'CI', model:'ci-model', endpoint:'${charEp}', apiKey:'', provider:'custom', relationship:'测试伙伴', systemPrompt:'你是冷淡话少的猫娘「泠」。', temperature:1, streaming:false, showThinking:false, promptCache:false, created:Date.now() }; dbPut('apiConfigs', cfg); })()`);
    await evaluate(cdp, 'loadApiConfigs()');
    await evaluate(cdp, "activeFriendId='ci_friend'");
    await evaluate(cdp, 'openChatPanel()');
    check('G0.chatReady', await waitFor(cdp, "!!document.getElementById('chat-input') && apiConfigs.some(function(a){return a.id==='ci_friend'})", 10000));
    const send = async (text) => {
      await evaluate(cdp, `(async function(){ document.getElementById('chat-input').value = ${JSON.stringify(text)}; window.__ciRes = await sendChatMessage(); return true; })()`);
      return evaluate(cdp, `(function(){ return window.__ciRes && { ok: window.__ciRes.ok, replyText: window.__ciRes.replyText, messageId: window.__ciRes.messageId }; })()`);
    };
    /* G1 · Guard OFF：原候选、零 Astra 请求 */
    await setMb({ enabled: true, endpoint: ep, model: 'gpt-6-astra', apiKey: 'sk-x', characterIntegrityEnabled: false, characterIntegrityRewrite: false });
    await resetMock(); mock.charPayload = CANDIDATE;
    let sent = await send('GUARD_OFF_TURN');
    check('G1.offEndToEnd', sent && sent.ok && sent.replyText === CANDIDATE && mock.judge === 0 && mock.rewrite === 0, JSON.stringify({ sent, j: mock.judge, w: mock.rewrite }));
    /* G2 · Guard ON + PASS：原候选 */
    mock.judgePayload = JSON.stringify({ pass: true, score: 0.93, confidence: 0.9, violations: [] });
    await setMb({ characterIntegrityEnabled: true, characterIntegrityRewrite: true });
    await resetMock();
    sent = await send('GUARD_PASS_TURN');
    check('G2.passEndToEnd', sent && sent.replyText === CANDIDATE && mock.judge === 1 && mock.rewrite === 0, JSON.stringify({ sent, j: mock.judge }));
    /* G3 · Guard ON + 强 OOC：落库与返回均为改写结果 */
    mock.judgePayload = STRONG_OOC; mock.rewritePayload = JSON.stringify({ reply: REWRITTEN });
    await resetMock();
    sent = await send('GUARD_OOC_TURN');
    check('G3.oocEndToEnd', sent && sent.replyText === REWRITTEN && mock.judge === 1 && mock.rewrite === 1, JSON.stringify({ sent, j: mock.judge, w: mock.rewrite }));
    check('G4.oocPersisted', await evaluate(cdp, `(async function(){ var m=await dbGet('chatMessages',${JSON.stringify(sent.messageId)}); return !!m && m.content===${JSON.stringify(REWRITTEN)}; })()`));
    check('G5.oocRendered', await evaluate(cdp, `(function(){ var el=document.querySelector('[data-msg-id=${JSON.stringify(sent.messageId)}]'); return !!el && el.textContent.indexOf('REWRITTEN_REPLY_已修正')>=0; })()`));
    /* G6 · 控制标签候选：不重写，标签原样保留（既有解析链不受影响） */
    mock.charPayload = CANDIDATE + '<ws_read path="no_such.txt"/>';
    await resetMock();
    sent = await send('GUARD_TAG_TURN');
    check('G6.tagsEndToEnd', sent && sent.replyText === mock.charPayload && mock.rewrite === 0 && mock.judge === 1, JSON.stringify({ r: sent && sent.replyText, w: mock.rewrite }));
    /* G7 · 每轮最多一次重写：连续 3 轮强 OOC */
    mock.charPayload = CANDIDATE;
    await resetMock(); await resetTel();
    await send('OOC_TURN_1'); await send('OOC_TURN_2'); await send('OOC_TURN_3');
    t = await telemetry();
    check('G7.rewritePerTurnBounded', mock.judge === 3 && mock.rewrite === 3 && t.maxRewritesPerTurn <= 1 && t.rewriteTriggered === 3, JSON.stringify({ j: mock.judge, w: mock.rewrite, max: t.maxRewritesPerTurn }));

    console.log('\nCharacter Integrity / OOC Guard (P11-2): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (_) {}
    try { api.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})();
