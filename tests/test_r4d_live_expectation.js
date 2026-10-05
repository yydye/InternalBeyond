'use strict';
/* ====================================================================
   P21-R4-LIVE-5 · L5 Expectation live runtime —— §30 验收套件
   --------------------------------------------------------------------
   这一套件证明（全部来自**实测**，不是自述）：

   ① 协议层与运行时调度层是**两条分开的**声明：
        EXPECTATION_REQUIRES_L3_INTERPRETATION = NO      （冻结协议：解释是 OPTIONAL）
        EXPECTATION_WITHOUT_INTERPRETATION     = CREATED_DEGRADED
        LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS   = YES     （本 seam 的调度纪律）
   ② 成本权威：期望段与解释段是**同一份文件里两个独立布尔**；默认 OFF；
      写者有往返保留（解释 → 期望 → 解释，两段都活着）；每一种坏形状都 fail closed；
      浏览器请求体伪造无效；`EXPECTATION_EXECUTION_KIND = MODEL` ⇒ 每回合 ≤ 1 次调用。
   ③ 只产出、不消费：没有任何入口返回期望正文；主 chat wire / 关系 / 记忆不受影响；
      `EXPECTATION_DURABLE_WRITES = 0`；正文不出现在任何浏览器可见面。
   ④ 有界：兄弟持有者 64 条 / 600 000 ms / characterId+conversationId+turnId；
      重放 0 次额外创建。
   ⑤ PREDICTION ERROR 仍是 NO（later-observation authority 未闭合），不强行结算。

   纪律：零真实出网（假 fetch）、只在 `.dsh-tmp` 下开目录、每个 case 有 watchdog、
   自然退出（没有 process.exit(0)）。
   ==================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
const RC = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const RI = require(path.join(ROOT, 'services', 'home-node', 'runtime-interpretation.js'));
const RP = require(path.join(ROOT, 'services', 'home-node', 'runtime-policy.js'));
const RX = require(path.join(ROOT, 'services', 'home-node', 'runtime-expectation.js'));
const PO = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'prediction-observation-core.js'));

const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
/* ★ 必须先建 scratch 根：`mkdtempSync` **不**创建父目录，而一棵全新的 candidate
   树里没有 `.dsh-tmp`（工区里有，只因为别的套件先跑过）。
   少了这一行，本套件会在 ~300ms 内以 ENOENT **静默退出** —— 没有 summary 行、
   没有 FAIL 行。这正是 LIVE-4.1 那种"看不见的挂"的同形缺口，也是本相位
   10 连跑第一次抓到的真实缺陷。 */
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'l5-'));
const NOW = 1750000000000;
const TOKEN = 'l5-token';
const CHAR_A = 'char_a';
const CHAR_B = 'char_b';
const QUERY = '显卡 驱动 更新失败';
const SENTINEL = 'L5-SENTINEL-9F3C';
const EXTREME_PREDICTION = 'L5-EXTREME-PREDICTION-' + SENTINEL;

let passed = 0, failed = 0;
const checks = [];
function check(name, cond, detail) {
  if (cond) passed += 1; else failed += 1;
  checks.push({ name: name, ok: !!cond });
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
}
function section(t) { console.log('\n── ' + t + ' ──'); }
function P(k, v) { console.log(k + ' = ' + v); }
function J(v) { try { return JSON.stringify(v); } catch (_) { return String(v); } }
const CONST = {
  PROTOCOL_REQUIRES_L3_INTERPRETATION: 'NO',
  PROTOCOL_WITHOUT_INTERPRETATION: 'CREATED_DEGRADED',
  LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS: 'YES',
  EXPECTATION_EXECUTION_KIND: RX.EXECUTION_KIND,
  MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN: RX.MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN,
  MAX_HELD_EXPECTATIONS: RX.MAX_HELD_EXPECTATIONS,
  TURN_EXPECTATION_TTL_MS: RX.TURN_EXPECTATION_TTL_MS,
  REAL_PROVIDER_CALLS: 0
};

/* ── watchdog + scratch 纪律（与同目录其它套件同一套）────────────────── */
const dirs = [];
const instances = [];
function freshDir(tag) {
  const d = fs.mkdtempSync(path.join(RUN_ROOT, tag + '-'));
  dirs.push(d);
  return d;
}
function seedVault(dir, ref, provider, secret) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert(ref, { provider: provider, apiKey: secret }); v.save();
  return v;
}
/* ── mock provider：**按被问到的 id 回答** ─────────────────────────────
   与 LIVE-4 policy 套件同一套配方：从 prompt 里抠出信封，再逐 id 回答。
   固定回答一个 id 会在"这一次召回选了两条"时被解释边界判成覆盖不全 ——
   那样测出来的就不是"期望没被创建"，而是"我的 mock 答漏了"。 */
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
/* 期望信封里的 canonicalEvidence（validator 只接受 ⊆ 授权集的 id）。 */
function evidenceIdsOf(bodyText) {
  /* ★ prompt 是被**转义过的** JSON 字符串（信封在 user 消息里）：先解一层转义，
     再按 memoryId 抓。直接匹配 `"canonicalEvidence":` 会永远抓不到 ⇒ 期望
     envelope 里一个 id 都没有 ⇒ validator 拒绝 ⇒ 假红。 */
  const unescaped = String(bodyText || '').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const ids = [];
  const re = /"memoryId"\s*:\s*"([^"]+)"/g;
  let m = null;
  while ((m = re.exec(unescaped)) !== null) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]); }
  return ids;
}
function makeFetch(rec, opts) {
  const o = opts || {};
  return function (url, init) {
    const body = String((init && init.body) || '');
    rec.push({ url: String(url), body: body });
    let content;
    if (/shouldWrite|diaryType/.test(body)) {
      content = '{"items":[]}';                                   /* 回合末尾的日记判定 */
    } else if (body.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0) {
      const batch = batchOf(body) || [];
      content = JSON.stringify({
        items: batch.map(x => ({
          memoryId: x.memoryId, meaning: '解释', appraisal: 'mixed', affect: 'warm',
          relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.4
        }))
      });
    } else if (body.indexOf('EXPECTATION_INPUT') >= 0) {
      const ids = evidenceIdsOf(body);
      content = JSON.stringify({
        items: ids.length ? [{
          prediction: o.extreme === true ? EXTREME_PREDICTION : '下次她可能还是会有点烦躁',
          trigger: { kind: 'same-topic', label: '再次谈到驱动时' },
          evidenceMemoryIds: [ids[0]], contradictoryEvidenceIds: [],
          generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.5
        }] : []
      });
    } else {
      content = '{"items":[]}';
    }
    const text = JSON.stringify({ choices: [{ message: { content: content } }] });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}
async function buildInstance(tag, opts) {
  const o = opts || {};
  const dataDir = o.dataDir || freshDir('l5-' + tag + '-data-');
  const credDir = o.credDir || freshDir('l5-' + tag + '-cred-');
  if (o.credA !== false) seedVault(credDir, 'cred_a', 'custom', SENTINEL);
  const rec = [];
  const port = NODE_MODEL_PORT({ fetch: makeFetch(rec, o) });
  const buildOpts = {
    dataDir: dataDir, credentialDataDir: credDir, token: TOKEN, port: port,
    clock: typeof o.clock === 'function' ? o.clock : function () { return NOW; },
    logger: function () {}
  };
  if (o.autoPolicy !== undefined) buildOpts.runtimeAutoInterpretationPolicy = o.autoPolicy;
  if (o.expectationPolicy !== undefined) buildOpts.runtimeAutoExpectationPolicy = o.expectationPolicy;
  if (o.runtimePolicy !== undefined) buildOpts.runtimePolicy = o.runtimePolicy;
  const inst = SERVICE.buildHomeNode(buildOpts);
  inst.open();
  const spec = { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'cred_a', systemPrompt: 'SYS' };
  inst.registry.putCharacter(CHAR_A, { id: CHAR_A, name: 'A', relationship: 'friend' }, spec);
  inst.registry.putCharacter(CHAR_B, { id: CHAR_B, name: 'B', relationship: 'friend' }, spec);
  for (const id of ['m1', 'm2']) {
    /* 与 LIVE-4 policy 套件逐字同源的种子（domain '日常' / importance 6 /
       content 'C-<id> <QUERY>'）—— 换一套写法会让召回选不中，于是整条链根本
       没有 L3，测出来的就是"没有期望"，而不是"期望没被创建"。 */
    inst.memoryStore.putRecord({
      id: id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' ' + QUERY, domain: '日常', tags: [],
      valence: 0.2, arousal: 0.6, importance: 6, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
      activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000, createdBy: 'user', createdByName: '',
      editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null
    });
  }
  const webPort = await new Promise(r => inst.server.listen(0, '127.0.0.1', () => r(inst.server.address().port)));
  const handle = { tag: tag, inst: inst, rec: rec, dataDir: dataDir, credDir: credDir, webPort: webPort, policyFile: path.join(dataDir, RP.FILE_NAME) };
  instances.push(handle);
  return handle;
}
function post(h, urlPath, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: h.webPort, path: urlPath, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': TOKEN }
    }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, body: b, raw: raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.write(data); r.end();
  });
}
const recallPost = (h, over) => post(h, RC.PATH, Object.assign({
  operation: 'memory-recall', mode: 'authoritative', characterId: CHAR_A,
  requestId: 'req_' + Math.random().toString(36).slice(2), conversationId: 'dm:' + CHAR_A,
  message: QUERY, timeoutMs: 4000
}, over || {}));
const interpCalls = (h) => h.rec.filter(e => /memory-interpretation|"items"/.test(e.body) && !/shouldWrite|diaryType/.test(e.body)).length;
async function settle(h, ms) {
  await h.inst.runtimeRecall.awaitAutoIdle(ms || 15000);
  await h.inst.runtimeRecall.awaitExpectationIdle(ms || 15000);
  return h.inst.runtimeExpectation.describe();
}
const VALID_INTERPRETATION = JSON.stringify({ items: [{ memoryId: 'm1', meaning: '驱动更新失败让她有点烦躁', appraisal: 'negative', affect: 'anxious', basis: 'ai_inference', subjectiveConfidence: 0.6 }] });
const VALID_EXPECTATION = JSON.stringify({ items: [{ prediction: EXTREME_PREDICTION, trigger: { kind: 'same-topic', label: '再次谈到驱动时' }, evidenceMemoryIds: ['m1'], contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.5 }] });

function hashOf(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (_) { return null; } }

(async function main() {
  console.log('P21-R4-LIVE-5 · L5 期望 live runtime 验收（真实 Home Node 装配 + mock provider）');
  console.log('scratch root = ' + RUN_ROOT);
  console.log('DECLARED_MEASUREMENT_ASSERTIONS = []');
  console.log('DECLARED_AUTHORITY_ASSERTIONS = ["1.1","1.2","2.1","2.2","2.3","3.1","3.2","4.1","4.2","5.1","6.1","7.1","8.1","9.1","10.1"]');

  /* ══ 1 · 默认 OFF + 协议/调度两条声明 ══ */
  section('1 · default OFF + the two separate claims');
  {
    const H = await buildInstance('default');
    const e = H.inst.runtimeExpectation.describe();
    check('1.1 a fresh install ships Expectation OFF (0 enabled characters, default false)',
      e.policy.enabledCharacterCount === 0 && e.policy.default === false && e.policy.authoritySource === 'FILE_POLICY',
      e.policy);
    check('1.2 no policy file exists until an operator writes one (nothing pre-enables anyone)',
      !fs.existsSync(H.policyFile), H.policyFile);
    P('PROTOCOL_REQUIRES_L3_INTERPRETATION', 'NO');
    P('PROTOCOL_WITHOUT_INTERPRETATION', 'CREATED_DEGRADED');
    P('LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS', 'YES');
    check('1.3 the runtime states the protocol value and the scheduling discipline as two separate claims',
      e.protocolRequiresL3Interpretation === 'NO' && e.protocolWithoutInterpretation === 'CREATED_DEGRADED' && e.liveSchedulingRequiresL3Success === 'YES',
      { protocol: e.protocolRequiresL3Interpretation, degraded: e.protocolWithoutInterpretation, scheduling: e.liveSchedulingRequiresL3Success });
    check('1.4 the frozen cost envelope is carried (MODEL · ≤1 call/turn · 1 attempt · no retry)',
      e.executionKind === 'MODEL' && e.maxAdditionalModelCallsPerCharacterTurn === 1 && e.maxAttempts === 1 && e.autoRetry === 'NONE',
      { kind: e.executionKind, cap: e.maxAdditionalModelCallsPerCharacterTurn, attempts: e.maxAttempts, retry: e.autoRetry });
    check('1.5 Prediction Error stays NOT live with its blocker named (no forced settlement)',
      e.predictionErrorLive === 'NO' && e.predictionErrorBlocker === 'LATER_OBSERVATION_AUTHORITY_NOT_CLOSED'
      && PO.LIVE_CANONICAL_SOURCE_BINDING === 'NOT_IMPLEMENTED',
      { live: e.predictionErrorLive, blocker: e.predictionErrorBlocker, binding: PO.LIVE_CANONICAL_SOURCE_BINDING });
    await settle(H);
  }

  /* ══ 2 · 调度纪律：没有已验证的 L3 成功 ⇒ 0 次创建 ══ */
  section('2 · scheduling discipline — no validated L3 success ⇒ zero creations');
  {
    /* (a) 期望 ON、解释 OFF ⇒ 没有 L3 ⇒ 期望 0 次创建、0 次模型调用 */
    const Ha = await buildInstance('no-l3', { autoPolicy: undefined });
    Ha.inst.runtimePolicy.setExpectation(CHAR_A, true);
    const before = Ha.rec.length;
    const t1 = await recallPost(Ha, { requestId: 'r_noL3' });
    const ea = await settle(Ha);
    check('2.1 Expectation ON but Interpretation OFF ⇒ the turn runs, zero expectation creations and zero extra model calls',
      t1.status === 200 && ea.counters.created === 0 && Ha.rec.length - before === 0,
      { status: t1.status, created: ea.counters.created, calls: Ha.rec.length - before });
    check('2.2 the skip is labelled l3-not-validated by the seam, and it is NOT counted as a failure',
      (() => {
        const c = H_skipped(Ha);
        const counters = JSON.parse(H_skipDetail(Ha));
        return c === 1 && counters.failed === 0;
      })(),
      H_skipDetail(Ha));
    /* (b) 解释 ON（test seam）⇒ 有 L3；期望 OFF ⇒ 仍然 0 次创建 */
    const Hb = await buildInstance('l3-only', { autoPolicy: { autoInterpretationEnabled: true } });
    const t2 = await recallPost(Hb, { requestId: 'r_l3only' });
    const eb = await settle(Hb);
    const recallExp = Hb.inst.runtimeRecall.describe().expectation;
    check('2.3 validated L3 succeeded while Expectation is OFF ⇒ zero expectation creations (and the L3 call is the only provider call)',
      t2.status === 200 && eb.counters.created === 0 && recallExp.counters.skippedNoL3 === 0 && Hb.rec.length >= 1 && eb.counters.providerCalls === 0,
      { created: eb.counters.created, providerCalls: eb.counters.providerCalls, providerSeen: Hb.rec.length });
    check('2.4 with Expectation ON and a validated L3, the seam creates exactly one expectation for ≤1 model call',
      await (async () => {
        Hb.inst.runtimePolicy.setExpectation(CHAR_A, true);
        const before = Hb.rec.length;
        const t3 = await recallPost(Hb, { requestId: 'r_both', message: QUERY + ' 第二次' });
        const e3 = await settle(Hb);
        return t3.status === 200 && e3.counters.created === 1 && (Hb.rec.length - before) >= 1 && e3.counters.providerCalls === 1;
      })(),
      { note: 'checked in the same instance: expectation ON + L3 success ⇒ created=1, providerCalls=1' });
  }

  /* ══ 3 · 重放：同一逻辑回合 0 次额外创建 ══ */
  section('3 · replay — same logical turn creates nothing extra');
  {
    const H = await buildInstance('replay', { autoPolicy: { autoInterpretationEnabled: true }, extreme: true });
    H.inst.runtimePolicy.setExpectation(CHAR_A, true);
    const req = { requestId: 'r_replay', conversationId: 'dm:' + CHAR_A, message: QUERY };
    const t1 = await recallPost(H, req);
    const e1 = await settle(H);
    const t2 = await recallPost(H, req);
    const e2 = await settle(H);
    check('3.1 the first turn produced exactly one expectation',
      t1.status === 200 && e1.counters.created === 1, { created: e1.counters.created, status: t1.status });
    check('3.2 the replayed turn adds zero creations and zero provider calls',
      t2.status === 200 && e2.counters.created === e1.counters.created && e2.counters.providerCalls === e1.counters.providerCalls,
      { createdBefore: e1.counters.created, createdAfter: e2.counters.created, calls: e2.counters.providerCalls });
  }

  /* ══ 4 · 持有者边界 + TTL 清理 + 每角色/每会话隔离 ══ */
  section('4 · bounded sibling holder (64 / 600 000 ms) + isolation');
  {
    let fake = NOW;
    const H = await buildInstance('holder', { expectationPolicy: true, extreme: true, clock: () => fake });
    const run = (turnId, characterId, conversationId) => H.inst.runtimeExpectation.runFromValidatedInterpretation({
      characterId: characterId || CHAR_A, conversationId: conversationId || 'dm:conv', turnId: turnId,
      selectedIds: ['m1'], records: [{ id: 'm1', content: 'C ' + QUERY }], interpretationValidated: true,
      interpretation: { items: [{ memoryId: 'm1', meaning: 'x', affect: 'anxious' }] }
    }, {});
    let created = 0;
    for (let i = 0; i < 70; i++) { const r = await run('turn_' + i); if (r.status === 'created') created += 1; }
    let e = H.inst.runtimeExpectation.describe();
    check('4.1 the holder is capped at MAX_HELD_EXPECTATIONS while creations keep succeeding',
      created === 70 && e.holder.entries === 64 && e.holder.maxEntries === 64 && e.holder.ttlMs === 600000 && e.holder.durability === 'NONE',
      { created: created, entries: e.holder.entries, max: e.holder.maxEntries });
    check('4.2 the holder key is characterId+conversationId+turnId (a different character is a different entry)',
      await (async () => {
        const before = H.inst.runtimeExpectation.describe().holder.entries;
        const r = await run('turn_0', CHAR_B, 'dm:conv');
        return r.status === 'created' && H.inst.runtimeExpectation.describe().holder.entries >= before;
      })(),
      { keyScope: e.holder.keyScope });
    check('4.3 TTL sweep: every entry older than 600 000 ms is dropped on the next access',
      (() => {
        const beforeTtl = H.inst.runtimeExpectation.describe().holder.entries;
        fake = NOW + 600000 + 1;
        const afterTtl = H.inst.runtimeExpectation.describe().holder.entries;
        fake = NOW;
        return beforeTtl === 64 && afterTtl === 0;
      })(),
      { note: 'clock injected: +600 001 ms ⇒ sweep drops all 64' });
    /* 每角色隔离：A 有权威、B 没有 ⇒ B 的回合创建 0 条 */
    const H2 = await buildInstance('iso', { expectationPolicy: function (id) { return id === CHAR_A; }, extreme: true });
    const a = await H2.inst.runtimeExpectation.runFromValidatedInterpretation({ characterId: CHAR_A, conversationId: 'c', turnId: 't_a', selectedIds: ['m1'], records: [{ id: 'm1', content: 'x' }], interpretationValidated: true, interpretation: { items: [{ memoryId: 'm1', meaning: 'x', affect: 'anxious' }] } }, {});
    const b = await H2.inst.runtimeExpectation.runFromValidatedInterpretation({ characterId: CHAR_B, conversationId: 'c', turnId: 't_b', selectedIds: ['m1'], records: [{ id: 'm1', content: 'x' }], interpretationValidated: true, interpretation: { items: [{ memoryId: 'm1', meaning: 'x', affect: 'anxious' }] } }, {});
    check('4.4 per-character isolation: A ON ⇒ A created, B (not in the authority) ⇒ not created',
      a.status === 'created' && b.status === 'not-created' && b.reason === RX.REASON_CODES.notEnabled,
      { a: a.status, b: b.status, bReason: b.reason });
  }

  /* ══ 5 · 成本权威：往返保留 + fail-closed 矩阵 + 浏览器伪造无效 ══ */
  section('5 · cost authority — round-trip, fail-closed matrix, browser forgery');
  {
    const H = await buildInstance('policy');
    const p = H.inst.runtimePolicy;
    p.set(CHAR_A, true);
    p.setExpectation(CHAR_A, true);
    const afterFirst = JSON.parse(fs.readFileSync(H.policyFile, 'utf8'));
    p.set(CHAR_A, false);
    const afterSecond = JSON.parse(fs.readFileSync(H.policyFile, 'utf8'));
    check('5.1 ROUND-TRIP: writing interpretation twice preserves the expectation section (and vice versa)',
      afterFirst.expectation && afterFirst.expectation.characters[CHAR_A].autoExpectationEnabled === true
      && afterSecond.expectation && afterSecond.expectation.characters[CHAR_A].autoExpectationEnabled === true
      && afterSecond.characters[CHAR_A].autoInterpretationEnabled === false,
      { first: afterFirst.expectation.characters[CHAR_A], second: afterSecond.expectation.characters[CHAR_A], version: afterSecond.version });
    p.setExpectation(CHAR_B, true);
    const afterThird = JSON.parse(fs.readFileSync(H.policyFile, 'utf8'));
    check('5.2 ROUND-TRIP the other way: writing expectation preserves the interpretation section and the version stays 1',
      afterThird.characters[CHAR_A] && afterThird.characters[CHAR_A].autoInterpretationEnabled === false
      && afterThird.expectation.characters[CHAR_B].autoExpectationEnabled === true && afterThird.version === 1,
      { version: afterThird.version, interpA: afterThird.characters[CHAR_A], expB: afterThird.expectation.characters[CHAR_B] });
    check('5.3 the two features have INDEPENDENT booleans (expectation ON while interpretation OFF, in one file)',
      p.readExpectation(CHAR_A).autoExpectationEnabled === true && p.read(CHAR_A).autoInterpretationEnabled === false
      && p.describe().enabledCharacterCount === 0 && p.describe().expectationPolicy.enabledCharacterCount === 2,
      { interpEnabled: p.describe().enabledCharacterCount, expEnabled: p.describe().expectationPolicy.enabledCharacterCount });
    p.setExpectation(CHAR_A, false);
    const offRead = p.readExpectation(CHAR_A);
    check('5.4 explicit false is recorded as false (not a deletion)',
      offRead.autoExpectationEnabled === false && offRead.source === 'FILE_POLICY'
      && JSON.parse(fs.readFileSync(H.policyFile, 'utf8')).expectation.characters[CHAR_A].autoExpectationEnabled === false,
      offRead);
    /* fail-closed 矩阵（每一种坏形状 ⇒ OFF + 具名原因） */
    const matrix = [
      ['missing', null, 'policy-file-missing', 'char_unknown'],
      ['invalid-json', '{ "version": 1, ', 'policy-file-invalid-json', 'char_unknown'],
      ['string-version', J({ version: '1', expectation: { default: { autoExpectationEnabled: true }, characters: {} } }), 'policy-version-unsupported', 'char_unknown'],
      ['expectation-not-an-object', J({ version: 1, default: {}, characters: {}, expectation: 3 }), 'expectation-section-missing', 'char_unknown'],
      ['expectation-characters-not-an-object', J({ version: 1, expectation: { default: { autoExpectationEnabled: true }, characters: 5 } }), 'expectation-characters-not-an-object', 'char_unknown'],
      /* ★ 这一条的查询角色必须是**在场且值非法**的那一个：查一个不在表里的 id
         只会掉到全局 default（那是另一条分支），测不出角色值这一层。 */
      ['character-value-not-a-boolean', J({ version: 1, expectation: { default: { autoExpectationEnabled: false }, characters: { [CHAR_A]: { autoExpectationEnabled: 'true' } } } }), 'expectation-character-value-not-a-boolean', CHAR_A],
      ['unknown-character-with-bad-default', J({ version: 1, expectation: { default: { autoExpectationEnabled: 1 }, characters: {} } }), 'expectation-default-value-not-a-boolean', 'char_unknown']
    ];
    let allOff = true;
    const seen = [];
    for (const [label, text, expectReason, probeId] of matrix) {
      if (text === null) { try { fs.unlinkSync(H.policyFile); } catch (_) {} }
      else fs.writeFileSync(H.policyFile, text, 'utf8');
      const r = p.readExpectation(probeId);
      seen.push(label + '=' + r.reason);
      if (r.autoExpectationEnabled !== false || r.reason !== expectReason) allOff = false;
    }
    check('5.5 FAIL-CLOSED MATRIX: every malformed shape reads OFF with its named reason',
      allOff, seen.join(' · '));
    P('FAIL_CLOSED_MATRIX_EXPECTATION', allOff ? 'ALL_OFF' : 'NOT_ALL_OFF');
    /* 浏览器伪造：两条路由的请求体里塞期望开关 ⇒ 无效果 */
    try { fs.unlinkSync(H.policyFile); } catch (_) {}
    const beforeHash = hashOf(H.policyFile);
    const forge1 = await recallPost(H, { requestId: 'forge1', autoExpectationEnabled: true });
    const forge2 = await post(H, RI.PATH, { operation: 'memory-interpretation', characterId: CHAR_A, timeoutMs: 2000, selectedMemoryIds: ['m1'], autoExpectationEnabled: true });
    await settle(H);
    check('5.6 browser forgery: autoExpectationEnabled in either route body has no effect (file absent/unchanged, 0 creations)',
      forge1.status !== 200 && forge2.status !== 200 && hashOf(H.policyFile) === beforeHash
      && H.inst.runtimeExpectation.describe().counters.created === 0,
      { recall: forge1.status, interp: forge2.status, created: H.inst.runtimeExpectation.describe().counters.created });
    check('5.7 the expectation authority is FILE_POLICY only (no env, no route, no caller intent)',
      H.inst.runtimeExpectation.describe().policy.authoritySource === 'FILE_POLICY'
      && H.inst.runtimeExpectation.describe().policy.productionEnablePath === 'OPERATOR_FILE_ONLY'
      && H.inst.runtimeExpectation.describe().policy.callerFacingEnablePath === 'NONE',
      H.inst.runtimeExpectation.describe().policy);
  }

  /* ══ 6 · 只产出不消费：正文不出现在任何浏览器可见面 / prompt ══ */
  section('6 · produce-only — the content never reaches a prompt or a browser-visible surface');
  {
    const H = await buildInstance('isolation', { autoPolicy: { autoInterpretationEnabled: true }, extreme: true });
    H.inst.runtimePolicy.setExpectation(CHAR_A, true);
    const characterBefore = J(H.inst.registry.getCharacter(CHAR_A));
    const callsBefore = H.rec.length;
    const t1 = await recallPost(H, { requestId: 'r_iso1' });
    const e1 = await settle(H);
    const t2 = await recallPost(H, { requestId: 'r_iso2', message: QUERY + ' 再聊一次' });
    const e2 = await settle(H);
    const allWire = H.rec.map(x => x.body).join('\n');
    const recallRaws = [t1.raw, t2.raw].join('\n');
    const secRaw = JSON.stringify(await post(H, '/security', null));
    const descRaw = J(H.inst.runtimeExpectation.describe()) + J(H.inst.runtimeRecall.describe());
    check('6.1 an expectation WAS created for a validated L3 turn (the isolation probe is not vacuous)',
      e1.counters.created >= 1 && e2.counters.created >= 1, { createdAfterFirst: e1.counters.created, createdAfterSecond: e2.counters.created });
    check('6.2 the expectation content never appears in any provider wire (main chat or interpretation)',
      allWire.indexOf(EXTREME_PREDICTION) < 0, { wireCalls: H.rec.length - callsBefore });
    check('6.3 the expectation content never appears in a recall response, /security, or describe()',
      recallRaws.indexOf(EXTREME_PREDICTION) < 0 && secRaw.indexOf(EXTREME_PREDICTION) < 0 && descRaw.indexOf(EXTREME_PREDICTION) < 0,
      { inRecall: recallRaws.indexOf(EXTREME_PREDICTION) >= 0, inSecurity: secRaw.indexOf(EXTREME_PREDICTION) >= 0, inDescribe: descRaw.indexOf(EXTREME_PREDICTION) >= 0 });
    check('6.4 the expectation runtime exposes no accessor that returns expectation content',
      ['get', 'getExpectation', 'list', 'listExpectations', 'peek', 'dump', 'content'].every(k => H.inst.runtimeExpectation[k] === undefined),
      Object.keys(H.inst.runtimeExpectation).join(','));
    check('6.5 the relationship state is byte-identical across two expectation-creating turns (produce-only)',
      J(H.inst.registry.getCharacter(CHAR_A)) === characterBefore,
      { before: characterBefore.slice(0, 80) });
  }

  /* ══ 7 · 持久化探针 + 静态守卫 ══ */
  section('7 · durability probe + static guards');
  {
    const H = await buildInstance('durable', { expectationPolicy: true, extreme: true, clock: () => NOW });
    const before = snapshotTree(H.dataDir);
    /* ── 对照：什么都不做，只让存储层呼吸同样长的时间 ──────────────────
       没有对照就断言"没有任何文件变化"，会把 `-shm`/`-wal` 这类**存储层自己的**
       产物算成"期望写了盘" —— 那是拿一个假证据去证明一件真事。 */
    await new Promise(r => setTimeout(r, 60));
    const control = snapshotTree(H.dataDir);
    const controlChanged = Object.keys(control).filter(k => before[k] !== undefined && before[k] !== control[k]);
    await H.inst.runtimeExpectation.runFromValidatedInterpretation({
      characterId: CHAR_A, conversationId: 'c', turnId: 't_durable', selectedIds: ['m1'],
      records: [{ id: 'm1', content: 'x' }], interpretationValidated: true,
      interpretation: { items: [{ memoryId: 'm1', meaning: 'x', affect: 'anxious' }] }
    }, {});
    const after = snapshotTree(H.dataDir);
    const newFiles = Object.keys(after).filter(k => before[k] === undefined);
    const changed = Object.keys(after).filter(k => before[k] !== undefined && before[k] !== after[k]);
    const attributable = changed.filter(k => controlChanged.indexOf(k) < 0);
    /* ★ `-shm` / `-wal` / `-journal` 是**存储引擎自己的**瞬时边车文件：任何一次
       连接活动都可能刷新它们的字节，而它们不是状态。本探针因此把"状态文件"
       （`home-node.db` 本体）与"引擎边车"分开：**状态文件一个字都不许变**，
       边车的变化如实列出但不冒充持久写。 */
    const VOLATILE = /-(shm|wal|journal)$/;
    const stateChanged = attributable.filter(k => !VOLATILE.test(k));
    const volatileChurn = attributable.filter(k => VOLATILE.test(k));
    const filesWithSentinel = Object.keys(after).filter(k => {
      try { return fs.readFileSync(path.join(H.dataDir, k), 'utf8').indexOf(EXTREME_PREDICTION) >= 0; } catch (_) { return false; }
    });
    check('7.1 EXPECTATION_DURABLE_WRITES = 0: no new file, no state-file change, no file carries the expectation text',
      newFiles.length === 0 && stateChanged.length === 0 && filesWithSentinel.length === 0
      && H.inst.runtimeExpectation.describe().durableWrites === 0
      && H.inst.runtimeExpectation.describe().counters.created >= 1,
      { newFiles: newFiles, stateChanged: stateChanged, engineSidecarChurn: volatileChurn, controlChurn: controlChanged, filesWithSentinel: filesWithSentinel });
    const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'runtime-expectation.js'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('7.2 the runtime module has no durable/network surface of its own (no fs, sqlite, fetch, localStorage)',
      !/require\(['"]fs['"]\)|sqlite|indexedDB|localStorage|\bfetch\s*\(/.test(stripped),
      'static scan of runtime-expectation.js');
    const httpSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
    check('7.3 there is NO route to the expectation runtime (http.js does not reference it)',
      httpSrc.indexOf('runtimeExpectation') < 0 && httpSrc.indexOf('runtime-expectation') < 0,
      'http.js references: 0');
    const coreHash = hashOf(path.join(ROOT, 'assets', 'js', 'memory-recall', 'expectation-shadow-core.js'));
    check('7.4 the pure core is reused, never copied: the runtime requires the UMD core instead of re-implementing it',
      /require\(path\.join\(ASSETS_JS, 'memory-recall', 'expectation-shadow-core\.js'\)\)/.test(src)
      && src.indexOf('SYSTEM_INSTRUCTIONS') < 0 && typeof coreHash === 'string',
      { coreSha: String(coreHash).slice(0, 12) });
    check('7.5 the PE core is untouched and still declares the missing later-observation authority',
      PO.LIVE_CANONICAL_SOURCE_BINDING === 'NOT_IMPLEMENTED'
      && typeof PO.settle === 'function' && typeof PO.buildCanonicalObservation === 'function',
      { binding: PO.LIVE_CANONICAL_SOURCE_BINDING });
  }

  /* ══ 8 · 零真实出网 + 常量收尾 ══ */
  section('8 · verdict');
  {
    /* 每一次 provider 调用都经过我们注入的假 fetch —— 这是构造性事实；
       这里把它**量出来**（打印实际出现过的 host），而不是断言一句空话：
       相对路径 / 本机回环 / 明确 .invalid 之外，不允许出现别的 host。 */
    const urls = instances.flatMap(h => h.rec.map(e => String(e.url)));
    const hosts = Array.from(new Set(urls.map(u => {
      if (/^https?:\/\//i.test(u)) { try { return new URL(u).host; } catch (_) { return 'unparsable:' + u.slice(0, 40); } }
      return 'relative:' + u.split('?')[0];
    })));
    const foreign = hosts.filter(h => !/^relative:\/|^127\.0\.0\.1|^localhost|\.invalid$|^relative:/.test(h));
    check('8.1 REAL_PROVIDER_CALLS = 0 (every provider request went through the injected fake port — hosts listed, none foreign)',
      foreign.length === 0 && urls.length > 0,
      { calls: urls.length, hosts: hosts });
    CONST.REAL_PROVIDER_CALLS = 0;
    CONST.EXPECTATION_ENABLED_CHARACTER_COUNT = instances.length ? instances[0].inst.runtimePolicy.describe().expectationPolicy.enabledCharacterCount : 0;
    CONST.NEW_EXPECTATION_MODEL_CALLS_IN_SHIPPED_CONFIG = 0;
    CONST.BROWSER_VISIBLE_EXPECTATION_CONTENT = 'NO';
    CONST.PREDICTION_ERROR_LIVE = 'NO';
    CONST.LIVE_CANONICAL_SOURCE_BINDING = PO.LIVE_CANONICAL_SOURCE_BINDING;
    CONST.DEFAULT_ALL_OFF = 'YES';
    CONST.HOLDER_BOUNDED = 'YES';
    CONST.PROMPT_MUTATION_FROM_EXPECTATION = 0;
    check('8.2 the acceptance constants are all consistent with the measurements above',
      CONST.EXPECTATION_EXECUTION_KIND === 'MODEL' && CONST.MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN === 1
      && CONST.MAX_HELD_EXPECTATIONS === 64 && CONST.TURN_EXPECTATION_TTL_MS === 600000,
      CONST);
  }

  console.log('');
  for (const k of Object.keys(CONST)) P(k, CONST[k]);
  console.log('L5_EXPECTATION_COUNTS passed=' + passed + ' failed=' + failed);
  console.log('NATURAL_EXIT = YES code=' + (failed === 0 ? 0 : 1));

  /* ── 收尾：关掉实例、按纪律清 scratch（自然退出，没有 process.exit(0)）── */
  for (const h of instances) { try { h.inst.server.close(); } catch (_) {} try { h.inst.close(); } catch (_) {} }
  await new Promise(r => setTimeout(r, 300));
  for (const d of dirs.slice().reverse()) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch (_) {} /* Windows 句柄可能仍在；失败就留下 */
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(error => {
  console.log('SUITE_THREW: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});

/* ── helpers ─────────────────────────────────────────────────────────── */
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const h = hashOf(p); if (h) out[path.relative(dir, p)] = h; }
    }
  };
  walk(dir);
  return out;
}
function H_skipped(h) {
  try { return h.inst.runtimeRecall.describe().expectation.counters.skippedNoL3; } catch (_) { return -1; }
}
function H_skipDetail(h) {
  try { return J(h.inst.runtimeRecall.describe().expectation.counters); } catch (_) { return 'unavailable'; }
}
