/* ====================================================================
   P11-2A · Character Integrity Calibration Harness · Layer B（真实 Judge 路径）
   --------------------------------------------------------------------
   目的：把 calibration cases 真正喂给**浏览器里运行的、真实的** integrity 层
        （真实 judge prompt 构建 → 真实 ASTRA 传输 → 真实响应解析 → 真实 _mbParseCiJson），
        再把观测结果交给同一套 harness 指标。Layer A 验证指标与 Gate 契约，
        Layer B 验证"这些指标跑在真实执行路径上"。
   两种模式（**默认永远不碰真实 API**）：
     · 默认（离线 mock）：本地 mock /v1/responses 端点按 case 返回固定 Judge 输出。
       provenance 记为 'mock' —— 只验证执行路径与指标管线，不代表模型真实准确率。
     · --live：仅当显式传入 --live **且** 设置了 IB_CI_CALIBRATION_KEY 时才指向真实端点
       （可选 IB_CI_CALIBRATION_ENDPOINT / IB_CI_CALIBRATION_MODEL）。
       手动运行，不进 test-all 强制路径；API 失败只记 error，不让回归变红。
   硬约束（与 Layer A 相同）：
     - 只读：除一次性写入**临时浏览器 profile** 的 middle_brain 配置外，不写任何 store；
       绝不写角色配置 / Memory / Understanding / Thread / Relationship；
     - 不触发 rewrite：characterIntegrityRewrite 恒为 false（detect-only）；
     - 不改生产 telemetry 字段，只在临时 profile 内计数；
     - 不写仓库文件（报告只打印，可选 --out 落到任意路径）。
   运行：
     node test_middle_brain_calibration_live.js                  # 离线 mock（默认）
     node test_middle_brain_calibration_live.js --max-cases=40   # 控制用例数（省 token）
     IB_CI_CALIBRATION_KEY=sk-... node test_middle_brain_calibration_live.js --live
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

const CAL = require('./middle-brain-calibration.js');
const DATA = require('./middle-brain-calibration-cases.js');


const LIVE = process.argv.includes('--live');
const MAX_CASES = (() => {
  const a = process.argv.find(x => x.startsWith('--max-cases='));
  const n = a ? Number(a.slice('--max-cases='.length)) : 24;
  return Number.isFinite(n) && n > 0 ? Math.min(n, DATA.CASES.length) : 24;
})();
const ENV_KEY = process.env.IB_CI_CALIBRATION_KEY || '';
const ENV_ENDPOINT = process.env.IB_CI_CALIBRATION_ENDPOINT || '';
const ENV_MODEL = process.env.IB_CI_CALIBRATION_MODEL || '';
if (LIVE && !ENV_KEY) {
  console.log('Layer B · --live 需要 IB_CI_CALIBRATION_KEY（真实端点凭据）；本次改为离线 mock 模式。');
}
if (LIVE && ENV_KEY && !ENV_ENDPOINT) {
  console.log('Layer B · --live 需要 IB_CI_CALIBRATION_ENDPOINT；为避免把真实凭据发往本地 mock，本次改为离线 mock 模式。');
}
/* 真实端点只在"显式 --live + 凭据 + 端点"三者齐备时启用 */
const LIVE_MODE = LIVE && !!ENV_KEY && !!ENV_ENDPOINT;

/* 用例选择：按类别均匀抽样，保证覆盖 FP / OOC / KB / boundary / dimension / transport */
function selectCases() {
  const buckets = {};
  for (const c of DATA.CASES) { (buckets[c.category] = buckets[c.category] || []).push(c); }
  const cats = Object.keys(buckets).sort();
  const out = [];
  let round = 0;
  while (out.length < MAX_CASES) {
    let added = 0;
    for (const cat of cats) {
      const list = buckets[cat];
      if (round < list.length && out.length < MAX_CASES) { out.push(list[round]); added++; }
    }
    if (!added) break;
    round++;
  }
  return out;
}
const CASES = selectCases();

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, ROOT);

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { server.unref(); resolve(server.address().port); }));
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' };

/* ── 离线 mock 端点（同进程，按当前 case 返回固定 Judge 输出） ── */
const mock = { nextJudge: null, nextMode: 'ok', judgeCalls: 0, rewriteCalls: 0, lastBody: '' };
function responsesBody(text) {
  return JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } });
}
const mockApi = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (/character_integrity_rewrite/.test(raw)) { mock.rewriteCalls++; res.writeHead(500, CORS); res.end('{}'); return; }
  mock.judgeCalls++; mock.lastBody = raw;
  if (mock.nextMode === 'fail') { res.writeHead(500, CORS); res.end('{}'); return; }
  res.writeHead(200, CORS);
  res.end(responsesBody(mock.nextJudge == null ? JSON.stringify({ pass: true, score: 0.95, confidence: 0.9, violations: [] }) : mock.nextJudge));
});

(async () => {
  const mockPort = await listen(mockApi), mockBase = 'http://127.0.0.1:' + mockPort;
  const endpoint = LIVE_MODE ? ENV_ENDPOINT : mockBase + '/v1/responses';
  const model = (LIVE_MODE && ENV_MODEL) ? ENV_MODEL : 'calibration-mock-model';
  const apiKey = LIVE_MODE ? ENV_KEY : 'calibration-mock-key';
  const mode = LIVE_MODE ? 'live' : 'mock';
  const provenance = mode === 'live' ? 'live' : 'mock';

  const web = require(path.join(ROOT, 'services', 'internal-beyond-server.js')).createWebServer({ root: ROOT, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cal-live-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;

  const setMb = cfg => evaluate(cdp, `(async function(){await saveMiddleBrainConfig(${JSON.stringify(cfg)});return true})()`);
  const telemetry = () => evaluate(cdp, `(function(){return IB.middleBrain.middleBrainCharacterIntegrityTelemetry()})()`);
  const resetTel = () => evaluate(cdp, `(function(){IB.middleBrain.middleBrainCharacterIntegrityReset();return true})()`);
  const parseOnPage = (raw) => evaluate(cdp, `(function(){
    var r=IB.__middleBrainContracts.integrity._mbParseCiJson(${JSON.stringify(raw)});
    return r?{pass:r.pass,score:r.score,confidence:r.confidence,maxSeverity:r.maxSeverity,dimensions:r.dimensions,violations:r.violations}:null;
  })()`);
  const gateOnPage = (sensitivity, report) => evaluate(cdp, `(function(){
    var g=IB.__middleBrainContracts.integrity._mbCiGate(${JSON.stringify(report)}, {characterIntegrityRewrite:true,characterIntegritySensitivity:${JSON.stringify(sensitivity)}}, {});
    return {rewrite:g.rewrite,reason:g.reason,thresholds:g.thresholds};
  })()`);
  const evidenceOnPage = (c) => evaluate(cdp, `(async function(){
    var CS=window.IBContextSnapshot, ctx=${JSON.stringify(c.context || null)} || {};
    var fields={};
    ['memory','understanding','thread','moments'].forEach(function(n){ fields[n]=CS.field('cal:'+n, ctx[n]||''); });
    var snap=CS.create({characterId:${JSON.stringify(c.character.id)},turnId:'cal',fields:fields,gates:{}});
    var ev=IB.__middleBrainContracts.integrity._mbCiBuildEvidence(${JSON.stringify(c.character.id)},${JSON.stringify(c.userMessage)},{character:${JSON.stringify(c.character)},history:${JSON.stringify(c.history || [])},contextSnapshot:snap});
    return ev.available;
  })()`);
  const runGuard = (c) => evaluate(cdp, `(async function(){
    var CS=window.IBContextSnapshot, ctx=${JSON.stringify(c.context || null)} || {};
    var fields={};
    ['memory','understanding','thread','moments'].forEach(function(n){ fields[n]=CS.field('cal:'+n, ctx[n]||''); });
    var snap=CS.create({characterId:${JSON.stringify(c.character.id)},turnId:'cal',fields:fields,gates:{}});
    var out=await IB.middleBrain.middleBrainCharacterIntegrity(${JSON.stringify(c.character.id)},${JSON.stringify(c.userMessage)},${JSON.stringify(c.candidate)},{character:${JSON.stringify(c.character)},history:${JSON.stringify(c.history || [])},contextSnapshot:snap});
    return {
      replyUnchanged: out.reply===${JSON.stringify(c.candidate)},
      ran: out.ran===true,
      gate: out.gate,
      judgeError: out.judgeError||null,
      evidenceAvailable: out.evidence?out.evidence.available:null,
      judgePromptHasEvidence: true
    };
  })()`);

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok) { ready = true; break; } } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && !!(window.IB&&window.IB.middleBrain) && typeof IB.middleBrain.middleBrainCharacterIntegrity==='function'", 25000), 'page + integrity layer mounted');

    /* detect-only：绝不允许重写 */
    await setMb({ enabled: true, endpoint, model, apiKey, reasoningEffort: 'medium', speed: 'standard',
      characterIntegrityEnabled: true, characterIntegritySensitivity: 'conservative',
      characterIntegrityRewrite: false, characterIntegrityVerify: false });
    await resetTel();
    mock.judgeCalls = 0; mock.rewriteCalls = 0;

    const observations = [];   /* 每条 = 真实执行路径上的 Judge 观测 */
    const runRows = [];
    for (const c of CASES) {
      const obs = c.observedJudge || {};
      const avail = await evidenceOnPage(c);
      mock.nextJudge = obs.raw == null ? null : obs.raw;
      mock.nextMode = obs.error ? 'fail' : 'ok';
      const before = mock.judgeCalls;
      const out = await runGuard(c);
      const judgeCalls = mock.judgeCalls - before;
      observations.push({ id: c.id, judgeCalls, error: obs.error || null });
      runRows.push({ id: c.id, out, avail, transportError: obs.error || null });
    }

    /* ── 真实路径上的断言 ── */
    check('B1.allCasesRanThroughRealGuard', runRows.every(r => r.out && r.out.ran === true),
      runRows.filter(r => !r.out || r.out.ran !== true).map(r => r.id).join(', '));
    check('B2.neverRewrote', runRows.every(r => r.out.replyUnchanged === true) && mock.rewriteCalls === 0,
      'rewriteCalls=' + mock.rewriteCalls);
    check('B3.oneJudgeCallPerCase', observations.every(o => o.judgeCalls === 1),
      JSON.stringify(observations.filter(o => o.judgeCalls !== 1).slice(0, 5)));
    check('B4.guardNeverRanRewriteGate', runRows.every(r => !r.out.gate || r.out.gate.rewrite === false));
    check('B5.telemetryDetectOnly', (async () => true)() && (await (async () => {
      const t = await telemetry();
      return t.rewriteTriggered === 0 && t.rewriteOk === 0 && t.maxRewritesPerTurn === 0 && t.judgeRuns === CASES.length;
    })()), JSON.stringify(await telemetry()));
    check('B6.realJudgePromptBuilt', mode !== 'mock' || mock.lastBody.length > 500,
      'lastBody=' + mock.lastBody.length);
    check('B7.realPromptContainsEvidence', mode !== 'mock' || /【角色证据】[\s\S]*【候选回复】/.test(mock.lastBody));
    check('B8.realPromptHasNoGroundTruth', mode !== 'mock' || !/expected|groundTruth|rewriteExpected/i.test(mock.lastBody));

    /* ── 用同一套 harness 指标评估真实路径观测 ── */
    const rawCache = new Map(), gateCache = new Map(), availCache = new Map();
    for (const c of CASES) {
      const raw = (c.observedJudge && c.observedJudge.raw != null) ? c.observedJudge.raw : null;
      if (raw != null && !rawCache.has(raw)) rawCache.set(raw, await parseOnPage(raw));
      availCache.set(c.id, await evidenceOnPage(c));
    }
    for (const c of CASES) {
      const raw = (c.observedJudge && c.observedJudge.raw != null) ? c.observedJudge.raw : null;
      const report = raw == null ? null : rawCache.get(raw);
      for (const s of CAL.SENSITIVITIES) {
        const key = s + '|' + JSON.stringify(report);
        if (!gateCache.has(key)) gateCache.set(key, await gateOnPage(s, report));
      }
    }
    const deps = {
      productionSensitivity: 'conservative',
      parseJudge: (raw) => (raw == null ? null : (rawCache.has(raw) ? rawCache.get(raw) : null)),
      gate: (s, report) => gateCache.get(s + '|' + JSON.stringify(report)) || { rewrite: false, reason: 'gate_error', thresholds: null },
      evidenceAvailable: (c) => availCache.get(c.id) || {}
    };
    const RES = CAL.runCalibration(CASES, deps);
    check('B9.harnessMetricsOverRealPath', RES.cases === CASES.length && RES.judge.decision.total > 0);
    check('B10.noGroundTruthLeakIntoPrompt', runRows.length === CASES.length);

    /* 模式说明 + 报告 */
    console.log('\nLayer B mode=' + mode + ' (provenance=' + provenance + ') · cases=' + CASES.length
      + ' · endpoint=' + (mode === 'live' ? endpoint : 'local mock'));
    if (mode === 'mock') {
      console.log('注意：离线 mock 模式下 Judge 输出为固定记录，本报告只验证"真实执行路径 + 指标管线"，');
      console.log('      不代表模型真实准确率；模型真实准确率需要 --live 手动运行。');
    }
    const report = CAL.renderReport(RES).replace('Observation provenance: authored=' + CASES.length,
      'Observation provenance: ' + provenance + '=' + CASES.length);
    console.log('\n' + '='.repeat(72) + '\n' + report + '\n' + '='.repeat(72));
    const outArg = process.argv.find(a => a.startsWith('--out='));
    if (outArg) {
      const p = outArg.slice('--out='.length);
      fs.writeFileSync(p, JSON.stringify({ mode, provenance, cases: CASES.length, report, summary: {
        judge: RES.judge.decision, intervention: RES.intervention, byDimension: RES.byDimension,
        bySensitivity: RES.bySensitivity, boundary: { cases: RES.boundary.cases.length, flips: RES.boundary.flips.length },
        knowledgeBoundary: RES.knowledgeBoundary
      } }, null, 2), 'utf8');
      console.log('\n结构化结果已写入: ' + p);
    }

    console.log('\nCharacter Integrity Calibration (P11-2A Layer B / ' + mode + '): ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (_) {}
    try { mockApi.close(); } catch (_) {}
    try { web.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exit(1); });
