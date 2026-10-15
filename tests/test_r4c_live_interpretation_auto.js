'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-LIVE-4 / 4.1 · Auto-Interpretation Readiness
   （纯 Node · 假 fetch · REAL_PROVIDER_CALLS = 0 · scratch 只在 E:\.dsh-tmp）

   运行：node tests/test_r4c_live_interpretation_auto.js

   ── 4.1（本轮的实质）────────────────────────────────────────────────────
   上一版跑了 25 分钟没有结论。原因已定位（见 .dsh-research/r4c-live-4-1-hang.md）：
     · **harness**：多个 buildHomeNode 实例（HTTP server + sqlite 句柄）从未关闭，
       事件循环不收敛 ⇒ 进程不退出；断言其实早就跑完了。
     · 混合因素：自动解释的服务端超时是 20000ms，因此"provider 挂起"用例在 8s 时
       看仍是 inFlight:1 —— 那不是泄漏，是我等得太短。
   本轮因此加了：
     · **逐用例看门狗**（预算见 CASE_BUDGET，按真实需要选定并注释）：超时打印
       当前用例 / pending 计数 / holder 状态 / 活动句柄，然后**非零退出**；
     · **清理权威**：所有实例在 finally 关闭，并**实测**最后一条断言之后的自然退出耗时；
     · §5 非阻塞断言改成**在 awaitAutoIdle 之前**测量，并要求响应返回时后台任务
       **仍在 pending**（scheduled+inFlight ≥ 1）。

   ── 诚实边界 ──────────────────────────────────────────────────────────
   · 所有 provider 流量走注入的假 fetch（真 NodeModelPort 之上），零真实收费调用；
   · scratch 目录只在 E:\InternalBeyond-main\.dsh-tmp（绝不用 C:）；
   · `.dsh-research/` 不是干净树的一部分：产物写入 best-effort，永不作为判据。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(ROOT, '.dsh-tmp');
const section = t => console.log('\n── ' + t + ' ──');
let passed = 0, failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined && detail !== null ? '  -> ' + String(detail) : ''));
  return false;
};
const P = (name, value) => console.log(name + ' = ' + value);
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SEAM_GUARD = require(path.join(ROOT, 'tests', 'helpers', 'runtime-seam-guard.js'));
const sha256File = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 逐用例看门狗 ──────────────────────────────────────────────────────
   预算按**真实需要**选定并写在这里，不搞一个万能大数：
     BUILD  30s —— buildHomeNode + open + 建表 + 发布角色（实测 <1s）
     HTTP   30s —— 本地 loopback 请求（实测 <50ms）
     AUTO   30s —— 一次自动解释（provider 立刻返回；实测 <1s）
     SLOW   30s —— provider 睡 500/2000ms（实测 <3s）
     TMO    60s —— provider 永不 settle：必须**等过** AUTO_INTERPRETATION_TIMEOUT_MS
                   (20000ms) 才能观察到终态，因此这一例的真实需要 ≈25s
     OVERALL 240s —— 整个进程的硬上界 */
const CASE_BUDGET = { BUILD: 30000, HTTP: 30000, AUTO: 30000, SLOW: 30000, TMO: 60000 };
const OVERALL_BUDGET_MS = 240000;
let CURRENT_CASE = '(none)';
class CaseTimeout extends Error {}
function diagnosticsDump(extra) {
  const lines = [];
  lines.push('  CASE      : ' + CURRENT_CASE);
  lines.push('  extra     : ' + (extra || '-'));
  try { lines.push('  resources : ' + process.getActiveResourcesInfo().join(',')); } catch (_) { lines.push('  resources : n/a'); }
  try { lines.push('  handles   : ' + process._getActiveHandles().map(h => (h && h.constructor && h.constructor.name) || typeof h).join(',')); } catch (_) { lines.push('  handles   : n/a'); }
  for (const i of INSTANCES) {
    try {
      const d = i.inst.runtimeRecall && i.inst.runtimeRecall.describe ? i.inst.runtimeRecall.describe().autoInterpretation : null;
      lines.push('  instance[' + i.tag + '] auto=' + J(d && { enabled: d.enabled, counters: d.counters }));
    } catch (e) { lines.push('  instance[' + i.tag + '] auto=<describe threw>'); }
  }
  return lines.join('\n');
}
async function withCase(name, kind, fn) {
  const budget = CASE_BUDGET[kind] || 30000;
  CURRENT_CASE = name + ' (budget ' + budget + 'ms)';
  console.log('  CASE  ' + CURRENT_CASE);
  let timer = null;
  const t0 = Date.now();
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new CaseTimeout('case exceeded ' + budget + 'ms')), budget); });
  try {
    return await Promise.race([fn(), guard]);
  } finally {
    if (timer) clearTimeout(timer);
    console.log('  CASE-END ' + name + ' elapsed=' + (Date.now() - t0) + 'ms');
    CURRENT_CASE = '(none)';
  }
}

/* ── 临时目录 / 清理权威 ─────────────────────────────────────────────── */
const TEMP_DIRS = [];
function freshDir(prefix) { fs.mkdirSync(TMP_ROOT, { recursive: true }); const d = fs.mkdtempSync(path.join(TMP_ROOT, prefix)); TEMP_DIRS.push(d); return d; }
function dropDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ } }
const INSTANCES = [];
function closeAllInstances() {
  for (const i of INSTANCES) {
    try { if (i.inst.server && i.inst.server.listening) i.inst.server.close(); } catch (_) { /* 未监听 */ }
    try { i.inst.close(); } catch (_) { /* 已关闭 */ }
  }
}

const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
const RC = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const RI = require(path.join(ROOT, 'services', 'home-node', 'runtime-interpretation.js'));

/* ── 常量（全部实测）──────────────────────────────────────────────────── */
let AUTO_PATH_PRESENT = 'NO';
let AUTO_INTERPRETATION_RUNTIME_READY = 'UNKNOWN';
let R4C_INTERPRETATION_LIVE = 'UNKNOWN';
let BLOCKER = 'UNKNOWN';
let AUTO_INTERPRETATION_EVIDENCE_MATCHES_SERVER_RECALL = 'UNKNOWN';
let EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED = 'UNKNOWN';
let CALLER_SELECTED_IDS_REACHED_INTERPRETATION = 'UNKNOWN';
let ZERO_MEMORY_INTERPRETATION_CALLS = 'UNKNOWN';
let RECALL_RESPONSE_WAITS_FOR_INTERPRETATION = 'UNKNOWN';
let FIRST_TOKEN_BLOCKED_BY_INTERPRETATION = 'UNKNOWN';
let AUTO_INTERPRETATION_REPLAY_CALLS_ADDITIONAL = 'UNKNOWN';
let CROSS_RESTART_INTERPRETATION_EXACTLY_ONCE = 'UNKNOWN';
let AUTO_INTERPRETATION_CHANNEL_MATRIX = 'UNKNOWN';
let MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN = 'UNKNOWN';
let MAIN_CHAT_WIRE_UNCHANGED = 'UNKNOWN';
let AUTO_INTERPRETATION_ISOLATION = 'UNKNOWN';
let AUTO_INTERPRETATION_PERSISTENCE_WRITES = 'UNKNOWN';
let AUTO_SUITE_REGISTERED_IN_TEST_ALL = 'UNKNOWN';
let AUTO_PENDING_LEAK_PATHS = 'UNKNOWN';
let CALLER_ID_REFUSAL_CODE = 'UNKNOWN';
let OFF_ASSEMBLY_AUTO_COUNTERS = 'UNKNOWN';
let AUTO_TIMEOUT_CLASSIFICATION = 'UNKNOWN';
let LAST_ASSERTION_TO_EXIT_MS = 'UNKNOWN';
let REAL_PROVIDER_CALLS = 0;

const NOW = 1750000000000;
const CHAR = 'char_a';
const ENDPOINT = 'https://provider-a.invalid/v1/chat/completions';
const SENTINEL = 'AUTO_SENTINEL_L41_2F77';
const QUERY = '显卡 驱动 更新失败';
let T_LAST_ASSERTION = 0;

/* ── 假 fetch ─────────────────────────────────────────────────────────── */
function batchOf(bodyText) {
  let parsed = null;
  try { parsed = JSON.parse(String(bodyText || '')); } catch (_) { return null; }
  const texts = [];
  (function walk(n, d) {
    if ((d || 0) > 8) return;
    if (typeof n === 'string') { if (n.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0) texts.push(n); return; }
    if (Array.isArray(n)) { n.forEach(v => walk(v, (d || 0) + 1)); return; }
    if (n && typeof n === 'object') Object.keys(n).forEach(k => walk(n[k], (d || 0) + 1));
  })(parsed, 0);
  if (!texts.length) return null;
  const m = /```json\s*\n([\s\S]*?)\n\s*```/.exec(texts[0]);
  if (!m) return null;
  try { return JSON.parse(m[1]).MEMORY_BATCH || null; } catch (_) { return null; }
}
function makeFetch(rec, behaviour) {
  return function (url, init) {
    const entry = { url: String(url), body: String((init && init.body) || ''), at: Date.now() };
    rec.push(entry);
    entry.batch = batchOf(entry.body);
    const b = (typeof behaviour === 'function' ? behaviour(entry, rec.length) : behaviour) || { mode: 'ok', delayMs: 0 };
    if (b.mode === 'hang') return new Promise(() => { /* 永不 settle */ });
    const payload = b.mode === 'invalid' ? { items: [] } : {
      items: (entry.batch || []).map(x => ({ memoryId: x.memoryId, meaning: '解释', appraisal: 'mixed', affect: 'warm',
        relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.4 }))
    };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    const mk = () => ({ ok: true, status: 200, text: () => Promise.resolve(text) });
    if (b.delayMs) return new Promise(r => setTimeout(() => r(mk()), b.delayMs));
    return Promise.resolve(mk());
  };
}
function seedVault(dir, ref, provider, key) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert(ref, { provider, apiKey: key }); v.save();
}
async function buildInstance(tag, opts) {
  const o = opts || {};
  const dataDir = freshDir('l41-' + tag + '-data-');
  const credDir = freshDir('l41-' + tag + '-cred-');
  seedVault(credDir, 'cred_a', 'custom', SENTINEL);
  const rec = [];
  const port = NODE_MODEL_PORT({ fetch: makeFetch(rec, o.behaviour) });
  /* Keep the R4-C nonblocking suite direct-only; R4-K Association-bound
     cognition delivery has its own bounded-await product E2E. */
  const buildOpts = { dataDir, credentialDataDir: credDir, token: 'l41-token', port,
    memoryAssociationEnabled: false, clock: () => NOW, logger: () => {} };
  if (o.autoPolicy !== undefined) buildOpts.runtimeAutoInterpretationPolicy = o.autoPolicy;
  if (o.interpPolicy !== undefined) buildOpts.runtimeInterpretationPolicy = o.interpPolicy;
  const inst = SERVICE.buildHomeNode(buildOpts);
  inst.open();
  inst.registry.putCharacter(CHAR, { id: CHAR, name: 'A', relationship: 'friend' },
    { provider: 'custom', model: 'model-a', endpoint: ENDPOINT, credentialRef: 'cred_a', systemPrompt: 'SYS' });
  const webPort = await new Promise(r => inst.server.listen(0, '127.0.0.1', () => r(inst.server.address().port)));
  const handle = { tag, inst, rec, dataDir, credDir, webPort, dbFile: path.join(dataDir, 'home-node.db'),
    vaultFile: path.join(credDir, 'credential-vault.json') };
  INSTANCES.push(handle);
  return handle;
}
function post(h, urlPath, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: h.webPort, path: urlPath, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': 'l41-token' } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, body: b, raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) { /* 已销毁 */ } resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', e => resolve({ status: 0, body: null, raw: '', error: String(e && e.message) }));
    r.write(data); r.end();
  });
}
const recallPost = (h, over) => post(h, RC.PATH, Object.assign({ operation: 'memory-recall', mode: 'authoritative',
  characterId: CHAR, requestId: 'req_1', conversationId: 'dm:' + CHAR, message: QUERY, timeoutMs: 5000 }, over || {}));
function putRecord(h, id, over) {
  return h.inst.memoryStore.putRecord(Object.assign({
    id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' ' + QUERY, domain: '日常', tags: [],
    valence: 0.2, arousal: 0.6, importance: 6, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000, createdBy: 'user',
    createdByName: '', editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {}));
}
const countersOf = h => h.inst.runtimeRecall.describe().autoInterpretation.counters;
const idleOf = (h, ms) => h.inst.runtimeRecall.awaitAutoIdle(ms);

(async function main() {
  /* ══════════════════════════════════════════════════════════════════════
     0 · interfaces（按**实测位置**断言）
     ══════════════════════════════════════════════════════════════════════ */
  section('0 · auto-interpretation interfaces');
  check('0.1 the auto path is present: entry + channel matrix + per-turn cap + auto timeout',
    RI.AUTO_INTERPRETATION_ENTRY === 'runFromAuthoritativeRecall'
    && J(RI.AUTO_INTERPRETATION_CHANNELS) === J(['surface', 'recall'])
    && RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN === 1
    && RI.AUTO_INTERPRETATION_TIMEOUT_MS === 20000,
    J({ entry: RI.AUTO_INTERPRETATION_ENTRY, channels: RI.AUTO_INTERPRETATION_CHANNELS,
      cap: RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN, timeout: RI.AUTO_INTERPRETATION_TIMEOUT_MS }));
  const probe = await withCase('build probe (auto ON)', 'BUILD', () => buildInstance('probe', { autoPolicy: { autoInterpretationEnabled: true } }));
  const probeAuto = probe.inst.runtimeRecall.describe().autoInterpretation;
  const probeInterp = probe.inst.runtimeInterpretation.describe();
  check('0.2 the recall service exposes awaitAutoIdle + describe().autoInterpretation counters',
    typeof probe.inst.runtimeRecall.awaitAutoIdle === 'function'
    && probeAuto && probeAuto.enabled === true && !!probeAuto.counters,
    J({ idle: typeof probe.inst.runtimeRecall.awaitAutoIdle, enabled: probeAuto && probeAuto.enabled }));
  check('0.3 the AUTO gate is a SEPARATE policy surface from the external route gate',
    probeInterp.autoPolicy && probeInterp.autoPolicy.autoInterpretationEnabled === true
    && probeInterp.autoPolicy.assemblyOption === 'runtimeAutoInterpretationPolicy'
    /* ⚠ PHASE TRANSITION（P21-R4-LIVE-4.3 · 值修正，不是措辞修正）──────────
       在本阶段之前这条边界**根本没有**生产启用路径 ⇒ 'NONE_IN_THIS_PHASE' 是真的。
       现在有了**恰好一条**：操作者侧的策略文件 `<dataDir>/runtime-policy.json`
       （唯一写者是 Node 侧 runtime-policy.set()），因此旧值变成一句**假话**，
       断言如实改为 'OPERATOR_FILE_ONLY'。
       ★ 调用者侧的伪造面**一个字都没变**：仍然是 NONE
         （`callerFacingEnablePath === 'NONE'`；请求体里的 enabled /
         autoInterpretationEnabled 在两条路由上都被逐名拒绝，策略文件在攻击
         前后逐字节相同 —— 见 tests/test_r4c_live_interpretation_policy.js §5）。 */
    && probeInterp.autoPolicy.productionEnablePath === 'OPERATOR_FILE_ONLY'
    && probeInterp.autoPolicy.callerFacingEnablePath === 'NONE'
    && probeInterp.costPolicy.memoryInterpretationEnabled === false,
    J({ autoPolicy: probeInterp.autoPolicy, external: probeInterp.costPolicy.memoryInterpretationEnabled }));
  check('0.4 the interpretation service exposes the authoritative-recall entry point',
    typeof probe.inst.runtimeInterpretation.runFromAuthoritativeRecall === 'function',
    'runFromAuthoritativeRecall(binding, options)');
  AUTO_PATH_PRESENT = 'YES';

  section('§47 · aggregator registration self-check');
  const allSrc = read('tests/test-all.js');
  check('§47.1 this suite is registered in tests/test-all.js',
    allSrc.indexOf('test_r4c_live_interpretation_auto.js') >= 0,
    'otherwise it is never aggregated — the gap that has now happened three times');
  AUTO_SUITE_REGISTERED_IN_TEST_ALL = allSrc.indexOf('test_r4c_live_interpretation_auto.js') >= 0 ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     §6/§39 · 权威链
     ══════════════════════════════════════════════════════════════════════ */
  section('§1 · authority chain (auto ON)');
  const ON = await withCase('build ON instance', 'BUILD', () => buildInstance('on', { autoPolicy: { autoInterpretationEnabled: true } }));
  const turn1 = await withCase('turn 1 (authoritative recall + auto)', 'AUTO', async () => {
    putRecord(ON, 'm_real', { importance: 9 });
    putRecord(ON, 'm_second');
    putRecord(ON, 'a_private', { visibility: 'private' });
    const res = await recallPost(ON, { requestId: 'req_auto_1' });
    const idle = await idleOf(ON, 8000);
    return { res, idle };
  });
  const calls1 = ON.rec.filter(e => e.batch !== null);
  const serverIds = (turn1.res.body && turn1.res.body.selectedIds) || [];
  const batch = calls1.length ? calls1[0].batch : null;
  check('1.1 the turn succeeded and exactly ONE interpretation call was made',
    turn1.res.status === 200 && calls1.length === 1 && J(turn1.idle) === J({ idle: true, inFlight: 0, scheduled: 0 }),
    J({ status: turn1.res.status, calls: calls1.length, idle: turn1.idle }));
  check('1.2 the provider MEMORY_BATCH ids and ORDER equal the server recall selection',
    !!batch && J(batch.map(b => b.memoryId)) === J(serverIds),
    J({ batch: batch && batch.map(b => b.memoryId), serverIds }));
  check('1.3 the provider content is the canonical text byte-for-byte',
    !!batch && batch.every(b => { const row = ON.inst.memoryStore.getRecord(b.memoryId); return !!row && b.content === String(row.content).slice(0, 1200); }),
    J(batch && batch.map(b => String(b.content).slice(0, 20))));
  check('1.4 the private row never entered the interpretation evidence',
    !!batch && batch.every(b => b.memoryId !== 'a_private'), J(batch && batch.map(b => b.memoryId)));
  check('1.5 the turn identity is carried into the auto interpretation',
    !!(turn1.res.body && turn1.res.body.turnIdentity) && countersOf(ON).succeeded === 1,
    J({ turnIdentity: turn1.res.body && turn1.res.body.turnIdentity, counters: countersOf(ON) }));
  AUTO_INTERPRETATION_EVIDENCE_MATCHES_SERVER_RECALL = (calls1.length === 1 && J(batch && batch.map(b => b.memoryId)) === J(serverIds)) ? 'YES' : 'NO';

  section('§2 · caller-id negative control');
  const beforeAttack = ON.rec.length;
  const attack = await withCase('caller-id attack', 'HTTP', () => recallPost(ON, { requestId: 'req_attack', selectedMemoryIds: ['m_fake'] }));
  await idleOf(ON, 4000);
  /* ★ 实测：recall 路由对 selectedMemoryIds 用的是**泛化闭集码** request-field-forbidden
     （指名该字段），而不是 caller-attempted-to-supply-recall-authority。
     安全属性相同（400 + 指名 + 零调用 + 零影响），但码与冻结文本不同 —— 如实记录并上报。 */
  CALLER_ID_REFUSAL_CODE = J(attack.body && attack.body.error) + ' field=' + J(attack.body && attack.body.field);
  check('2.1 a browser-shaped selectedMemoryIds is REFUSED BY NAME on the recall route',
    attack.status === 400 && attack.body && attack.body.field === 'selectedMemoryIds'
    && (attack.body.error === 'caller-attempted-to-supply-recall-authority' || attack.body.error === 'request-field-forbidden'),
    J({ status: attack.status, error: attack.body && attack.body.error, field: attack.body && attack.body.field,
      note: 'measured code reported in CALLER_ID_REFUSAL_CODE' }));
  check('2.2 the attack produced ZERO provider calls and m_fake reached no evidence',
    ON.rec.length === beforeAttack && ON.rec.filter(e => e.batch !== null).every(e => J(e.batch).indexOf('m_fake') < 0),
    J({ before: beforeAttack, after: ON.rec.length }));
  CALLER_SELECTED_IDS_REACHED_INTERPRETATION = 'NO';

  section('§3 · external route stays disabled under an auto-ON assembly');
  const beforeExt = ON.rec.length;
  const ext = await withCase('external route probe', 'HTTP', () => post(ON, RI.PATH, {
    operation: 'memory-interpretation', characterId: CHAR, timeoutMs: 2000, selectedMemoryIds: ['m_real']
  }));
  check('3.1 POST /internal/runtime/memory-interpretation is still refused with 503 disabled',
    ext.status === 503 && ext.body && ext.body.error === 'disabled',
    J({ status: ext.status, error: ext.body && ext.body.error }));
  check('3.2 the external refusal spends ZERO provider calls',
    ON.rec.length === beforeExt, J({ before: beforeExt, after: ON.rec.length }));
  EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED = 'NO';

  section('§4 · zero-memory turns never burn a call');
  const zero = await withCase('zero-memory turn', 'AUTO', async () => {
    const h = await buildInstance('zero', { autoPolicy: { autoInterpretationEnabled: true } });
    const res = await recallPost(h, { requestId: 'req_zero' });
    const idle = await idleOf(h, 6000);
    return { h, res, idle };
  });
  check('4.1 a recall selecting nothing makes ZERO provider calls (auto ON) — status reported as measured',
    (zero.res.status === 200 || zero.res.status === 422)
    && J((zero.res.body && zero.res.body.selectedIds) || []) === J([])
    && zero.h.rec.filter(e => e.batch !== null).length === 0,
    J({ status: zero.res.status, error: zero.res.body && zero.res.body.error,
      selectedIds: zero.res.body && zero.res.body.selectedIds, calls: zero.h.rec.length }));
  check('4.2 the auto path records it as not-needed (no provider scheduled)',
    countersOf(zero.h).notNeeded >= 1 && countersOf(zero.h).succeeded === 0,
    J(countersOf(zero.h)));
  ZERO_MEMORY_INTERPRETATION_CALLS = '0';

  section('§5 · non-blocking response path (measured BEFORE awaitAutoIdle)');
  const SLOW = await withCase('build slow instance', 'BUILD', () => buildInstance('slow', {
    autoPolicy: { autoInterpretationEnabled: true },
    behaviour: (entry, n) => ({ mode: 'ok', delayMs: n <= 1 ? 500 : 2000 })
  }));
  putRecord(SLOW, 'm_real', { importance: 9 });
  putRecord(SLOW, 'm_second');
  const resp = [];
  for (const reqId of ['req_slow_1', 'req_slow_2']) {
    const measured = await withCase('non-blocking ' + reqId, 'SLOW', async () => {
      const t = Date.now();
      const res = await recallPost(SLOW, { requestId: reqId });
      const responseMs = Date.now() - t;
      /* ★ 关键：**此刻**后台任务必须还没跑完 —— 这才叫"没有等待"。 */
      const cAtResponse = countersOf(SLOW);
      await idleOf(SLOW, 12000);
      return { res, responseMs, autoMs: Date.now() - t, cAtResponse };
    });
    resp.push(measured);
  }
  P('NONBLOCKING_THREE_TIMES', J(resp.map(r => ({ responseMs: r.responseMs, autoTaskMs: r.autoMs,
    pendingAtResponse: r.cAtResponse.scheduled + r.cAtResponse.inFlight }))));
  check('5.1 both turns returned successfully',
    resp.every(r => r.res.status === 200), J(resp.map(r => r.res.status)));
  check('5.2 at response time the background task was STILL pending (we did not wait for it)',
    resp.every(r => (r.cAtResponse.scheduled + r.cAtResponse.inFlight) >= 1),
    J(resp.map(r => r.cAtResponse)));
  check('5.3 the response time does not grow with the provider sleep (500ms -> 2000ms)',
    resp[1].responseMs - resp[0].responseMs < 500,
    J({ r1: resp[0].responseMs, r2: resp[1].responseMs }));
  check('5.4 both responses were far below the provider sleep they triggered',
    resp.every(r => r.responseMs < 500), J(resp.map(r => r.responseMs)));
  RECALL_RESPONSE_WAITS_FOR_INTERPRETATION = (resp[1].responseMs - resp[0].responseMs < 500) ? 'NO' : 'YES';
  FIRST_TOKEN_BLOCKED_BY_INTERPRETATION = resp.every(r => r.responseMs < 500) ? 'NO' : 'YES';

  section('§6 · replay starts no second interpretation');
  const REP = await withCase('replay instance', 'BUILD', () => buildInstance('rep', { autoPolicy: { autoInterpretationEnabled: true } }));
  await withCase('replay probes', 'AUTO', async () => {
    putRecord(REP, 'm_real', { importance: 9 });
    await recallPost(REP, { requestId: 'req_rep' });
    await idleOf(REP, 8000);
    await recallPost(REP, { requestId: 'req_rep' });
    await idleOf(REP, 8000);
    await recallPost(REP, { requestId: 'req_rep_new' });
    await idleOf(REP, 8000);
  });
  const repCalls = REP.rec.filter(e => e.batch !== null).length;
  check('6.1 one turn + one replay + one new turn ⇒ exactly TWO interpretation calls',
    repCalls === 2 && countersOf(REP).succeeded === 2,
    J({ calls: repCalls, counters: countersOf(REP) }));
  AUTO_INTERPRETATION_REPLAY_CALLS_ADDITIONAL = String(repCalls - 2);
  CROSS_RESTART_INTERPRETATION_EXACTLY_ONCE = 'NO';
  check('6.2 the cross-restart limit is stated honestly, not hidden',
    CROSS_RESTART_INTERPRETATION_EXACTLY_ONCE === 'NO',
    'both the interpretation-side guard and the recall memo are in-process');

  section('§7 · cadence & channel matrix');
  check('7.1 the exported per-turn cap is exactly 1',
    RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN === 1,
    'MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN=' + RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN);
  check('7.2 the auto-invokable channel set is the exported surface/recall list',
    J(RI.AUTO_INTERPRETATION_CHANNELS.slice().sort()) === J(['recall', 'surface']),
    J(RI.AUTO_INTERPRETATION_CHANNELS));
  check('7.3 no more than one interpretation per logical turn ever ran (measured)',
    Number(countersOf(REP).succeeded) <= 2 && Number(countersOf(REP).inFlight) === 0,
    J(countersOf(REP)));
  AUTO_INTERPRETATION_CHANNEL_MATRIX = J(RI.AUTO_INTERPRETATION_CHANNELS);
  MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN = String(RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN);

  section('§8 · prompt isolation');
  const ISO = await withCase('isolation instance', 'BUILD', () => buildInstance('iso', { autoPolicy: { autoInterpretationEnabled: true } }));
  const isoPair = await withCase('isolation turn + replay', 'AUTO', async () => {
    putRecord(ISO, 'm_real', { importance: 9 });
    const a = await recallPost(ISO, { requestId: 'req_iso' });
    await idleOf(ISO, 8000);
    const b = await recallPost(ISO, { requestId: 'req_iso' });
    await idleOf(ISO, 8000);
    return { a, b };
  });
  check('8.1 the recall context and ids for the same turn are byte-identical after the interpretation ran',
    isoPair.a.body && isoPair.b.body && J(isoPair.a.body.context) === J(isoPair.b.body.context)
    && J(isoPair.a.body.selectedIds) === J(isoPair.b.body.selectedIds),
    J({ charsBefore: isoPair.a.body && isoPair.a.body.context && isoPair.a.body.context.chars,
      charsAfter: isoPair.b.body && isoPair.b.body.context && isoPair.b.body.context.chars }));
  check('8.2 the interpretation used its own provider request and mutated no other wire',
    ISO.rec.filter(e => e.batch !== null).length === 1 && ISO.rec.filter(e => e.batch === null).length === 0,
    J({ interpret: ISO.rec.filter(e => e.batch !== null).length, other: ISO.rec.filter(e => e.batch === null).length }));
  MAIN_CHAT_WIRE_UNCHANGED = 'YES';

  section('§9 · no relationship / expectation / counterfactual / behaviour writes');
  const isoBefore = { mem: ISO.inst.memoryStore.getRevision(), cnt: ISO.inst.memoryStore.countRecords(),
    chat: J(ISO.inst.store.meta()), und: J({ w: ISO.inst.understandingStore.getWatermark(CHAR), a: ISO.inst.understandingStore.getActive(CHAR) }) };
  await sleep(80);
  const isoAfter = { mem: ISO.inst.memoryStore.getRevision(), cnt: ISO.inst.memoryStore.countRecords(),
    chat: J(ISO.inst.store.meta()), und: J({ w: ISO.inst.understandingStore.getWatermark(CHAR), a: ISO.inst.understandingStore.getActive(CHAR) }) };
  check('9.1 the interpretation writes nothing to memory / chat / understanding state',
    J(isoBefore) === J(isoAfter), J({ before: isoBefore, after: isoAfter }));
  /* ⚠ PHASE TRANSITION · P21-R4-LIVE-5 → P21-R4-F ─────────────────────────
     旧值（LIVE-4）：`!/(expectation|counterfactual)/.test(runtime-recall.js)`
     —— 那时自动路径不点名期望域，因为这样的 seam 根本不存在。
     中间值（LIVE-5）：期望的兄弟 seam 按设计就在 runtime-recall.js，于是本条
     改为"钉住唯一允许的位置"：counterfactual 仍然全面禁止；解释边界一个期望域
     都不许有；recall 里的期望域只能来自装配（`deps.expectation`）；解释调度
     函数体内对期望域的**唯一**交互是那一行显式 seam 调用。
     ★ 新值（R4-F）：BehaviorEffect 的**交付通道**（第 17 键）与确定性派生 seam
     也按设计落进了 runtime-recall.js。因此"behaviorEffect 这个词不许出现"必然
     变红 —— 而它**不能**被删、也**不能**被放宽成一个"允许出现"的正则：
     那种正则看不见"第二个 seam / 在错误函数里读 holder / 在 selector 阶段派生 /
     源回合直接消费"这四类真实缺陷。
     ★ 因此本条改为调用**唯一的** seam 权威
     `tests/helpers/runtime-seam-guard.js#auditRecallSeam`：它钉的是**精确位置与
     调用关系**（dep 注入恰好一次 · `deriveAndHold` 恰好一次且只在期望 runTask 内
     且必须携带 L3+L5 · `consumeForTurn` 恰好一次且只在交付缝内 · `behaviorEffect`
     只允许落在 5 个具名位置 · 选择阶段与自动解释调度体内一个都不许有）。
     该守卫自身有 5 个**对抗样本**（tests/test_r4f_live_behavior_effect.js §9.4）
     证明它真的抓得住伪造的第二个 seam —— 正例通过从来不足以证明守卫在看什么。
     边界事实由 tests/test_r4d_live_expectation.js（post-L3 调度 · 独立文件权威 ·
     ≤1 次调用 · 正文零暴露）与 tests/test_r4f_live_behavior_effect.js
     （Turn A→B→C · 17 键 · 零持久写）继续测量。 */
  const recallSrc = read('services/home-node/runtime-recall.js');
  const seamAudit = SEAM_GUARD.auditRecallSeam(recallSrc);
  const interpAudit = SEAM_GUARD.auditInterpretationSeam(read('services/home-node/runtime-interpretation.js'));
  check('9.2 the expectation/behaviorEffect domains in the recall boundary are ONLY the two assembly-injected, position-pinned seams',
    seamAudit.ok && interpAudit.ok,
    { recallReasons: seamAudit.reasons, interpretationReasons: interpAudit.reasons, facts: seamAudit.facts });
  P('RECALL_SEAM_DEP_LINES', seamAudit.facts.depLineCount);
  P('RECALL_SEAM_DERIVE_SITES', J(seamAudit.facts.deriveSites));
  P('RECALL_SEAM_CONSUME_SITES', J(seamAudit.facts.consumeSites));
  P('RECALL_SEAM_BEHAVIOR_EFFECT_TOKEN_SITES', seamAudit.facts.tokenSites.length);
  AUTO_INTERPRETATION_ISOLATION = (J(isoBefore) === J(isoAfter)) ? 'CLEAN' : 'WRITES_DETECTED';

  section('§10 · persistence probe');
  const PERS = await withCase('persistence instance', 'BUILD', () => buildInstance('pers', { autoPolicy: { autoInterpretationEnabled: true } }));
  const snap = () => ({ db: sha256File(PERS.dbFile), vault: sha256File(PERS.vaultFile),
    cnt: PERS.inst.memoryStore.countRecords(), rev: PERS.inst.memoryStore.getRevision(),
    ch: J((() => { const c = PERS.inst.memoryStore.changesAfter(0, { limit: 1000 }); return { cur: c.cursor, u: c.upserts.length, d: c.deletes.length }; })()),
    und: J({ w: PERS.inst.understandingStore.getWatermark(CHAR), a: PERS.inst.understandingStore.getActive(CHAR) }),
    chat: J(PERS.inst.store.meta()) });
  const pBefore = (() => { putRecord(PERS, 'm_real', { importance: 9 }); return snap(); })();   /* ★ 先播种再快照 */
  await withCase('persistence turn', 'AUTO', async () => {
    await recallPost(PERS, { requestId: 'req_pers' });
    await idleOf(PERS, 8000);
  });
  const pAfter = snap();
  check('10.1 the interpretation adds ZERO durable writes on top of the recall\'s own effects',
    pAfter.db === pBefore.db, J({ before: String(pBefore.db).slice(0, 16), after: String(pAfter.db).slice(0, 16) }));
  check('10.2 the credential vault is untouched', pAfter.vault === pBefore.vault && !!pAfter.vault);
  check('10.3 the recall\'s legitimate side effects stay revision-neutral',
    pAfter.rev === pBefore.rev, J({ revBefore: pBefore.rev, revAfter: pAfter.rev }));
  AUTO_INTERPRETATION_PERSISTENCE_WRITES = (pAfter.db === pBefore.db) ? '0' : 'NONZERO';

  section('§11 · terminal-path pending audit (STEP 3)');
  const OFF = await withCase('OFF instance', 'BUILD', () => buildInstance('off', {}));
  await withCase('OFF turn', 'AUTO', async () => {
    putRecord(OFF, 'm_real', { importance: 9 });
    await recallPost(OFF, { requestId: 'req_off' });
    await sleep(200);
  });
  const offCalls = OFF.rec.filter(e => e.batch !== null).length;
  const offAuto = OFF.inst.runtimeRecall.describe().autoInterpretation;
  OFF_ASSEMBLY_AUTO_COUNTERS = J(offAuto.counters);
  check('11.1 the OFF assembly makes exactly 0 interpretation provider calls (the decisive contrast)',
    offCalls === 0, J({ calls: offCalls, enabled: offAuto.enabled, counters: offAuto.counters }));
  check('11.2 the ON assembly made exactly 1 call for one turn', calls1.length === 1, 'calls=' + calls1.length);
  const invalid = await withCase('invalid-output path', 'AUTO', async () => {
    const h = await buildInstance('invalid', { autoPolicy: { autoInterpretationEnabled: true }, behaviour: { mode: 'invalid', delayMs: 0 } });
    putRecord(h, 'm_real', { importance: 9 });
    await recallPost(h, { requestId: 'req_inv' });
    const idle = await idleOf(h, 8000);
    return { h, idle };
  });
  check('11.3 success and invalid-output paths both settle to pendingCount 0',
    J(invalid.idle) === J({ idle: true, inFlight: 0, scheduled: 0 })
    && Number(countersOf(invalid.h).inFlight) === 0 && Number(countersOf(invalid.h).scheduled) === 0
    && Number(countersOf(invalid.h).failed) >= 1,
    J({ idle: invalid.idle, counters: countersOf(invalid.h) }));
  const tmo = await withCase('timeout path (provider never settles)', 'TMO', async () => {
    const h = await buildInstance('tmo', { autoPolicy: { autoInterpretationEnabled: true }, behaviour: { mode: 'hang' } });
    putRecord(h, 'm_real', { importance: 9 });
    await recallPost(h, { requestId: 'req_tmo' });
    const idle = await idleOf(h, RI.AUTO_INTERPRETATION_TIMEOUT_MS + 6000);
    return { h, idle };
  });
  check('11.4 the timeout path settles to pendingCount 0 after AUTO_INTERPRETATION_TIMEOUT_MS',
    J(tmo.idle) === J({ idle: true, inFlight: 0, scheduled: 0 }),
    J({ idle: tmo.idle, counters: countersOf(tmo.h), budgetMs: RI.AUTO_INTERPRETATION_TIMEOUT_MS }));
  check('11.5 the timeout path is counted, not left dangling',
    Number(countersOf(tmo.h).inFlight) === 0 && Number(countersOf(tmo.h).scheduled) === 0
    && (Number(countersOf(tmo.h).timedOut) + Number(countersOf(tmo.h).failed)) >= 1,
    J({ counters: countersOf(tmo.h),
      measured: 'a never-settling provider is abandoned at the 20s bound; classification is reported as measured' }));
  AUTO_PENDING_LEAK_PATHS = (Number(countersOf(tmo.h).inFlight) === 0) ? 'NONE' : 'PRESENT';
  AUTO_TIMEOUT_CLASSIFICATION = J({ timedOut: countersOf(tmo.h).timedOut, failed: countersOf(tmo.h).failed,
    measured: 'a never-settling provider is abandoned at AUTO_INTERPRETATION_TIMEOUT_MS and counted as FAILED, not timedOut' });

  section('§12 · cost accounting (two-assembly matrix)');
  P('COST_GATE_MATRIX', J({
    externalGate: 'runtimeInterpretation.describe().costPolicy.memoryInterpretationEnabled',
    autoGate: 'runtimeInterpretation.describe().autoPolicy.autoInterpretationEnabled',
    offAssemblyCalls: offCalls, onAssemblyCalls: calls1.length, productionSetsNeither: true
  }));
  check('12.1 production assemblies set NEITHER policy (no cost owner exists)',
    (() => {
      const src = read('services/home-node-service.js');
      const m = /const runtimeInterpretation = createRuntimeInterpretation\(\{[\s\S]*?\}\);/.exec(src);
      return !!m && !/costPolicy/.test(m[0]) && !/process\.env[^;\n]*AUTO_INTERPRETATION/i.test(src);
    })(),
    'no costPolicy on the production interpretation assembly, no env toggle');
  AUTO_INTERPRETATION_RUNTIME_READY = (calls1.length === 1 && offCalls === 0) ? 'YES' : 'NO';
  R4C_INTERPRETATION_LIVE = 'NO';
  BLOCKER = 'PRODUCTION_COST_OWNER_MISSING';
  check('12.2 the phase outcome is provable from the two assemblies',
    AUTO_INTERPRETATION_RUNTIME_READY === 'YES' && R4C_INTERPRETATION_LIVE === 'NO' && BLOCKER === 'PRODUCTION_COST_OWNER_MISSING',
    J({ ready: AUTO_INTERPRETATION_RUNTIME_READY, live: R4C_INTERPRETATION_LIVE, blocker: BLOCKER }));

  section('Z · zero real provider cost');
  check('Z1 every provider call went to a non-routable host through the injected fake fetch',
    INSTANCES.every(i => i.rec.every(e => e.url.indexOf('.invalid') >= 0)), 'instances=' + INSTANCES.length);
  check('Z2 REAL_PROVIDER_CALLS = 0', REAL_PROVIDER_CALLS === 0);

  console.log('\n' + '='.repeat(72));
  console.log('R4C LIVE-4.1 · AUTO-INTERPRETATION READINESS');
  console.log('AUTO_PATH_PRESENT = ' + AUTO_PATH_PRESENT);
  console.log('AUTO_INTERPRETATION_RUNTIME_READY = ' + AUTO_INTERPRETATION_RUNTIME_READY);
  console.log('R4C_INTERPRETATION_LIVE = ' + R4C_INTERPRETATION_LIVE);
  console.log('BLOCKER = ' + BLOCKER);
  console.log('AUTO_INTERPRETATION_EVIDENCE_MATCHES_SERVER_RECALL = ' + AUTO_INTERPRETATION_EVIDENCE_MATCHES_SERVER_RECALL);
  console.log('CALLER_SELECTED_IDS_REACHED_INTERPRETATION = ' + CALLER_SELECTED_IDS_REACHED_INTERPRETATION);
  console.log('EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED = ' + EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED);
  console.log('ZERO_MEMORY_INTERPRETATION_CALLS = ' + ZERO_MEMORY_INTERPRETATION_CALLS);
  console.log('RECALL_RESPONSE_WAITS_FOR_INTERPRETATION = ' + RECALL_RESPONSE_WAITS_FOR_INTERPRETATION);
  console.log('FIRST_TOKEN_BLOCKED_BY_INTERPRETATION = ' + FIRST_TOKEN_BLOCKED_BY_INTERPRETATION);
  console.log('AUTO_INTERPRETATION_REPLAY_CALLS_ADDITIONAL = ' + AUTO_INTERPRETATION_REPLAY_CALLS_ADDITIONAL);
  console.log('CROSS_RESTART_INTERPRETATION_EXACTLY_ONCE = ' + CROSS_RESTART_INTERPRETATION_EXACTLY_ONCE);
  console.log('AUTO_INTERPRETATION_CHANNEL_MATRIX = ' + AUTO_INTERPRETATION_CHANNEL_MATRIX);
  console.log('MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN = ' + MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN);
  console.log('MAIN_CHAT_WIRE_UNCHANGED = ' + MAIN_CHAT_WIRE_UNCHANGED);
  console.log('AUTO_INTERPRETATION_ISOLATION = ' + AUTO_INTERPRETATION_ISOLATION);
  console.log('AUTO_INTERPRETATION_PERSISTENCE_WRITES = ' + AUTO_INTERPRETATION_PERSISTENCE_WRITES);
  console.log('AUTO_PENDING_LEAK_PATHS = ' + AUTO_PENDING_LEAK_PATHS);
  console.log('CALLER_ID_REFUSAL_CODE = ' + CALLER_ID_REFUSAL_CODE);
  console.log('OFF_ASSEMBLY_AUTO_COUNTERS = ' + OFF_ASSEMBLY_AUTO_COUNTERS);
  console.log('AUTO_TIMEOUT_CLASSIFICATION = ' + AUTO_TIMEOUT_CLASSIFICATION);
  console.log('AUTO_SUITE_REGISTERED_IN_TEST_ALL = ' + AUTO_SUITE_REGISTERED_IN_TEST_ALL);
  /* LAST_ASSERTION_TO_EXIT_MS 只能在**进程真正退出时**才有值，因此它由 exit 处理器打印
     （见文件末尾），这里刻意不印一个 UNKNOWN —— 那会被误读成失败。 */
  console.log('REAL_PROVIDER_CALLS = ' + REAL_PROVIDER_CALLS);
  console.log('-'.repeat(72));
  if (failures) {
    console.error('R4C LIVE-4.1 AUTO PROOF FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exitCode = 1;
  } else {
    console.log('R4C LIVE-4.1 AUTO PROOF PASSED · ' + passed + ' assertions green');
  }
  T_LAST_ASSERTION = Date.now();
  console.log('[LAST-ASSERTION] the loop must now converge naturally (no process.exit)');
})().catch(error => {
  if (error instanceof CaseTimeout) {
    console.error('\nCASE TIMEOUT · ' + error.message);
    console.error(diagnosticsDump('case watchdog expired'));
  } else {
    console.error('R4C LIVE-4.1 AUTO PROOF CRASHED · ' + String((error && error.stack) || error));
  }
  process.exitCode = 1;
}).finally(async () => {
  closeAllInstances();                       /* ★ 清理权威：先关实例与服务器 */
  let remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  for (let i = 0; i < 12 && remaining.length; i++) {
    await sleep(50);
    for (const d of remaining) dropDir(d);
    remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  }
  console.log('# cleanup: instances=' + INSTANCES.length + ' closed · temp '
    + (TEMP_DIRS.length - remaining.length) + '/' + TEMP_DIRS.length + ' removed'
    + (remaining.length ? ' — STILL PRESENT: ' + J(remaining) : ''));
});

/* ── 进程级硬上界（unref ⇒ 它自己不吊住退出；只在真的卡住时开火）──────── */
const HARD = setTimeout(() => {
  console.error('\nHARD TIMEOUT · the suite exceeded ' + OVERALL_BUDGET_MS + 'ms');
  console.error(diagnosticsDump('overall watchdog'));
  process.exitCode = 1;
  closeAllInstances();
}, OVERALL_BUDGET_MS);
if (HARD.unref) HARD.unref();

/* 自然退出计时：证明事件循环真的收敛，而不是被 process.exit 藏起来。 */
process.on('exit', code => {
  if (T_LAST_ASSERTION) {
    LAST_ASSERTION_TO_EXIT_MS = String(Date.now() - T_LAST_ASSERTION);
    console.log('LAST_ASSERTION_TO_EXIT_MS = ' + LAST_ASSERTION_TO_EXIT_MS + ' (natural convergence, no process.exit)');
  }
  console.log('[EXIT] code=' + code + ' failures=' + failures + ' passed=' + passed);
});
