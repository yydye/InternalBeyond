'use strict';
/* ====================================================================
   P21-R4-F.1 · BehaviorEffect Server Runtime Closure —— 验收套件
   --------------------------------------------------------------------
   这一套件证明（全部来自**实测**，不是自述）：

   ① 真实 service path：validated L3 + validated L5 → 确定性派生 →
      turn-local 持有者 → authoritative Recall 第 17 键 → **下一个**合格回合
      一次性消费。Turn A（源）· Turn B（目标）· Turn C（之后）三步实测。
   ② 输入权威 = `VALIDATED_L3_AND_L5`：Recall-only / L3-only / L5-only /
      裸 shadow clone / 结构伪造 L3 / 伪造 L5 / 浏览器提交 ⇒ **一律无效果**，
      主 Recall 与主聊天都不失败、**绝不**回落到浏览器提示。
   ③ 零模型调用 / 零凭据读取 / 零持久化写入；`effects` 仍是召回生命周期块，
      行为语义**不**混进去。
   ④ schema 是**闭集 7 键**：非法枚举 / 缺字段 / 多字段 / 免费文本隧道 /
      情绪轴 / `derivedFrom != 'L3_AND_L5'` / `ttlTurns != 1` 全部 fail closed。
   ⑤ `NO_SIGNAL` 是**一等**合法结果（结构化中性效果），**不是** null + fallback。
   ⑥ 持有者有界（64 / 600 000 ms）+ 按 character+conversation 隔离 +
      源回合取不到自己的效果；重放保护**受淘汰限制**（不声称永久 exactly-once）。
   ⑦ PE / Counterfactual 隔离：`PREDICTION_ERROR_LIVE = NO`、
      `COUNTERFACTUAL_AUTO_CALLS = 0`。
   ⑧ seam 守卫从"词是否出现"升级为"精确位置 + 调用关系"，并有 5 个
      **对抗样本**证明它真的看得见第二个 seam。

   纪律：零真实出网（假 fetch + *.invalid）、只在 `.dsh-tmp` 下开目录、
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
const BE = require(path.join(ROOT, 'services', 'home-node', 'runtime-behavior-effect.js'));
const INTERP_CORE = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'memory-interpretation-core.js'));
const SEAM = require(path.join(ROOT, 'tests', 'helpers', 'runtime-seam-guard.js'));

const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'r4f-'));
const NOW = 1750000000000;
const TOKEN = 'r4f-token';
const CHAR_A = 'char_a';
const CHAR_B = 'char_b';
const QUERY = '显卡 驱动 更新失败';
const SENTINEL = 'R4F-SENTINEL-7B21';
const FREE_TEXT_PROBE = 'R4F-FREE-TEXT-PROBE-DO-NOT-INJECT';

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
function sha256File(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (_) { return null; } }
const readRel = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CONST = {
  BEHAVIOR_EFFECT_EXECUTION_KIND: BE.EXECUTION_KIND,
  MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN: BE.MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN,
  R4_F_LIVE_MEDIATOR_REQUIREMENT: BE.MEDIATOR_REQUIREMENT,
  BEHAVIOR_EFFECT_INPUT_AUTHORITY: BE.INPUT_AUTHORITY,
  BEHAVIOR_EFFECT_DURABLE_WRITES: 0,
  BEHAVIOR_EFFECT_PROVIDER_CALLS: 0,
  BEHAVIOR_EFFECT_CREDENTIAL_READS: 0,
  MAX_HELD_BEHAVIOR_EFFECTS: BE.MAX_HELD_BEHAVIOR_EFFECTS,
  HOLDER_TTL_MS: BE.HOLDER_TTL_MS,
  HOLDER_SCOPE: BE.HOLDER_SCOPE,
  MAX_COGNITIVE_EXTRA_MODEL_CALLS_PER_CHARACTER_TURN: 2,
  R4F_BEHAVIOR_EFFECT_RUNTIME_READY: 'NO',
  R4F_BEHAVIOR_EFFECT_LIVE: 'NO'
};

/* ── scratch / 实例纪律（与 LIVE-5 套件同一套）────────────────────────── */
const dirs = [];
const instances = [];
function freshDir(tag) { const d = fs.mkdtempSync(path.join(RUN_ROOT, tag + '-')); dirs.push(d); return d; }
function seedVault(dir, ref, provider, secret) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert(ref, { provider: provider, apiKey: secret }); v.save();
  return v;
}
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
function evidenceIdsOf(bodyText) {
  const unescaped = String(bodyText || '').replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const ids = [];
  const re = /"memoryId"\s*:\s*"([^"]+)"/g;
  let m = null;
  while ((m = re.exec(unescaped)) !== null) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]); }
  return ids;
}
/* 假 provider：解释的 appraisal 由 opts.appraisal 决定（本相位只改这一个自由度）。 */
function makeFetch(rec, opts) {
  const o = opts || {};
  return function (url, init) {
    const body = String((init && init.body) || '');
    rec.push({ url: String(url), body: body });
    let content;
    if (/shouldWrite|diaryType/.test(body)) {
      content = '{"items":[]}';
    } else if (body.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0) {
      const batch = batchOf(body) || [];
      content = JSON.stringify({
        items: batch.map(x => ({
          memoryId: x.memoryId, meaning: o.meaning || '解释', appraisal: o.appraisal || 'negative',
          affect: 'warm', relationshipMeaning: null, causalAttribution: null,
          basis: 'ai_inference', subjectiveConfidence: 0.4
        }))
      });
    } else if (body.indexOf('EXPECTATION_INPUT') >= 0) {
      const ids = evidenceIdsOf(body);
      content = JSON.stringify({
        items: ids.length ? [{
          prediction: '下次她可能还是会有点烦躁',
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
  const dataDir = o.dataDir || freshDir('r4f-' + tag + '-data-');
  const credDir = o.credDir || freshDir('r4f-' + tag + '-cred-');
  seedVault(credDir, 'cred_a', 'custom', SENTINEL);
  const rec = [];
  const port = NODE_MODEL_PORT({ fetch: makeFetch(rec, o) });
  const buildOpts = {
    dataDir: dataDir, credentialDataDir: credDir, token: TOKEN, port: port,
    clock: typeof o.clock === 'function' ? o.clock : function () { return NOW; },
    logger: function () {}
  };
  if (o.autoPolicy !== undefined) buildOpts.runtimeAutoInterpretationPolicy = o.autoPolicy;
  if (o.expectationPolicy !== undefined) buildOpts.runtimeAutoExpectationPolicy = o.expectationPolicy;
  const inst = SERVICE.buildHomeNode(buildOpts);
  inst.open();
  const spec = { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'cred_a', systemPrompt: 'SYS' };
  inst.registry.putCharacter(CHAR_A, { id: CHAR_A, name: 'A', relationship: 'friend' }, spec);
  inst.registry.putCharacter(CHAR_B, { id: CHAR_B, name: 'B', relationship: 'friend' }, spec);
  for (const id of ['m1', 'm2']) {
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
const convOf = (id) => 'dm:' + id;
const recallPost = (h, over) => post(h, RC.PATH, Object.assign({
  operation: 'memory-recall', mode: 'authoritative', characterId: CHAR_A,
  requestId: 'req_' + Math.random().toString(36).slice(2), conversationId: convOf(CHAR_A),
  message: QUERY, timeoutMs: 4000
}, over || {}));
async function settle(h, ms) {
  await h.inst.runtimeRecall.awaitAutoIdle(ms || 15000);
  await h.inst.runtimeRecall.awaitExpectationIdle(ms || 15000);
  return h.inst.runtimeBehaviorEffect.describe();
}
/* 一个"LIVE"装配：解释 ON（测试缝）+ 期望 ON（同一份 policy 文件的期望段）。 */
async function liveInstance(tag, opts) {
  const o = opts || {};
  const h = await buildInstance(tag, Object.assign({ autoPolicy: { autoInterpretationEnabled: true } }, o));
  h.inst.runtimePolicy.setExpectation(o.character || CHAR_A, true);
  return h;
}
const EFFECT_KEYS_SORTED = BE.EFFECT_KEYS.slice().sort().join(',');
function effectKeysOf(e) { return Object.keys(e || {}).sort().join(','); }
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const hh = sha256File(p); if (hh) out[path.relative(dir, p)] = hh; }
    }
  };
  walk(dir);
  return out;
}

(async function main() {
  console.log('P21-R4-F.1 · BehaviorEffect server runtime closure（真实 Home Node 装配 + mock provider）');
  console.log('scratch root = ' + RUN_ROOT);

  /* ══════════════════════════════════════════════════════════════════ 0 · 冻结值 */
  section('0 · frozen values + module purity + vocabulary authority');
  {
    const d = BE.createRuntimeBehaviorEffect({}).describe();
    check('0.1 §5 执行种类是确定性规则、每回合额外模型调用 0、中介要求 L3_AND_L5、输入权威 VALIDATED_L3_AND_L5',
      BE.EXECUTION_KIND === 'DETERMINISTIC_RULES'
      && BE.MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN === 0
      && BE.MEDIATOR_REQUIREMENT === 'L3_AND_L5'
      && BE.INPUT_AUTHORITY === 'VALIDATED_L3_AND_L5',
      { kind: BE.EXECUTION_KIND, calls: BE.MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN, mediator: BE.MEDIATOR_REQUIREMENT });
    check('0.2 §1 derivedFrom 的闭集**只有一个**值 L3_AND_L5（L3 / L5 / L3+L5 一律不是效果）',
      BE.DERIVED_FROM.length === 1 && BE.DERIVED_FROM[0] === 'L3_AND_L5' && d.derivedFromIsSingleton === true,
      BE.DERIVED_FROM);
    check('0.3 §9 持有者 64 条 / 600 000 ms / character+conversation+turn；非持久、无路由',
      BE.MAX_HELD_BEHAVIOR_EFFECTS === 64 && BE.HOLDER_TTL_MS === 600000
      && BE.HOLDER_SCOPE === 'character+conversation+turn'
      && d.holder.durability === 'NONE' && d.holder.routeExposed === false && d.holder.persistentLedger === 'NONE',
      d.holder);
    check('0.4 §26 运行时**就绪**但**不**live：live=NO + 具名 blocker（Browser prompt placement 需要用户 own 的文件）',
      d.status === 'RUNTIME_READY' && d.live === 'NO'
      && d.liveBlocker === 'BROWSER_PROMPT_PLACEMENT_REQUIRES_USER_OWNED_FILE',
      { status: d.status, live: d.live, blocker: d.liveBlocker });
    check('0.5 §6 零 provider 调用 / 零凭据读取 / 零持久写（模块自述 + 成本链 2 = 1+1+0）',
      d.cost.providerCalls === 0 && d.cost.credentialReads === 0 && d.isolation.durableWrites === 0
      && d.cost.chainBreakdown.interpretation === 1 && d.cost.chainBreakdown.expectation === 1
      && d.cost.chainBreakdown.behaviorEffect === 0
      && d.cost.chainMaxAdditionalModelCallsPerCharacterTurn === 2
      && d.cost.shippedDefaultAdditionalModelCalls === 0,
      d.cost);
    check('0.6 §8 免费文本通道结构性不存在；情绪轴被逐名拒绝；neutral 是一等结果',
      d.freeTextChannel === 'ABSENT_BY_SCHEMA' && d.neutralIsFirstClass === true
      && BE.FREE_TEXT_FIELDS.length === 6 && BE.FORBIDDEN_AXES.length === 8,
      { freeText: BE.FREE_TEXT_FIELDS, axes: BE.FORBIDDEN_AXES });
    /* 静态纯度：本模块不得有**任何**出网 / 落盘 / 凭据解析 / 模型端口面。
       只扫"能力"模式，不扫自述文字（describe() 里如实写着 credentialReads: 0、
       predictionErrorCalls: 0、counterfactualAutoCalls: 0 —— 那些是**声明**，
       不是调用）。因此禁止域只在**去掉 describe() 之后的逻辑代码**里扫。 */
    const src = readRel('services/home-node/runtime-behavior-effect.js');
    const code = SEAM_CODE_STRIP(src);
    const describeRegion = SEAM.regionOf(code, 'function describe()');
    const logic = describeRegion ? (code.slice(0, describeRegion.start) + code.slice(describeRegion.end)) : code;
    check('0.7 §6/§18 模块静态纯度：没有 fs/http/sqlite/fetch/localStorage/indexedDB，没有凭据解析面，没有模型端口，逻辑代码里没有 PE/counterfactual 域',
      !/require\(\s*['"](fs|http|https|net|child_process|sqlite3?)['"]/.test(code)
      && !/indexedDB|localStorage|sessionStorage|\bfetch\s*\(|XMLHttpRequest/.test(code)
      && !/credential-vault|credential-access|resolveCredential|apiKey/i.test(code)
      && !/node-model-port|modelPort/.test(code)
      && !/prediction-error|counterfactual/i.test(logic),
      { describeRegionFound: !!describeRegion, logicHasForbidden: /prediction-error|counterfactual/i.test(logic) });
    check('0.8 §S 词表只有一个出处：模块 require R4-C 纯核心，且 APPRAISALS 逐值一致（没有第二份枚举）',
      /require\(path\.join\(ASSETS_JS, 'memory-recall', 'memory-interpretation-core\.js'\)\)/.test(src)
      && J(BE.L3_APPRAISALS) === J((INTERP_CORE.APPRAISALS || []).map(String)),
      { module: BE.L3_APPRAISALS, core: INTERP_CORE.APPRAISALS });
    const httpSrc = readRel('services/home-node/http.js');
    check('0.9 §18 没有任何路由指向 BehaviorEffect 运行时（http.js 零引用）',
      httpSrc.indexOf('behaviorEffect') < 0 && httpSrc.indexOf('runtimeBehaviorEffect') < 0
      && httpSrc.indexOf('runtime-behavior-effect') < 0,
      'http.js references: 0');
    P('R4F_BEHAVIOR_EFFECT_EXECUTION_KIND', BE.EXECUTION_KIND);
    P('MAX_HELD_BEHAVIOR_EFFECTS', BE.MAX_HELD_BEHAVIOR_EFFECTS);
    P('HOLDER_TTL_MS', BE.HOLDER_TTL_MS);
    P('HOLDER_SCOPE', BE.HOLDER_SCOPE);
  }

  /* ══════════════════════════════════════════════════════════════════ 1 · 真实 service path */
  section('1 · real service path — Turn A (source) → Turn B (target) → Turn C (later)');
  let turnIdA = null;
  let turnIdB = null;
  {
    const H = await liveInstance('path');
    const reqA = { requestId: 'r4f_a', conversationId: convOf(CHAR_A), message: QUERY };
    const reqB = { requestId: 'r4f_b', conversationId: convOf(CHAR_A), message: QUERY + ' 再聊一次' };
    const reqC = { requestId: 'r4f_c', conversationId: convOf(CHAR_A), message: QUERY + ' 第三次' };
    turnIdA = RC.deriveStableTurnId(reqA.requestId, reqA.conversationId);
    turnIdB = RC.deriveStableTurnId(reqB.requestId, reqB.conversationId);

    const tA = await recallPost(H, reqA);
    const keysA = tA.body && tA.body.ok === true ? Object.keys(tA.body) : [];
    check('1.1 Turn A：authoritative 信封恰好 17 个顶层键，第 17 键 behaviorEffect **在场**',
      tA.status === 200 && keysA.length === 17 && keysA.indexOf('behaviorEffect') >= 0,
      { status: tA.status, keys: keysA.length, hasKey: keysA.indexOf('behaviorEffect') >= 0 });
    check('1.2 §15 current-turn isolation：Turn A 的响应**不含**它自己刚派生给未来的效果（值为 null）',
      tA.body && tA.body.behaviorEffect === null,
      { turnAEffect: tA.body && tA.body.behaviorEffect });

    const dA = await settle(H);
    check('1.3 §5 派生只在 L3 验证成功**且** L5 成立之后发生（Turn A 后 derived=1，额外模型调用 0）',
      dA.counters.derived === 1 && dA.cost.providerCalls === 0 && dA.holder.entries === 1,
      { derived: dA.counters.derived, holderEntries: dA.holder.entries });

    /* ★ 为了让 §14 的"Turn C 不再消费"成为**决定性的**观测，Turn A 之后把期望
       关掉：Turn B 仍然消费 Turn A 的效果（消费不看策略），但它**不会**派生一条
       属于自己的新效果 —— 否则 Turn C 收到的会是 Turn B 的新效果，"陈旧重消费"
       与"正常交付"就分不开了。B 的"每回合都能派生"另在 §1b 单独测。 */
    H.inst.runtimePolicy.setExpectation(CHAR_A, false);
    const tB = await recallPost(H, reqB);
    const eB = tB.body && tB.body.behaviorEffect ? tB.body.behaviorEffect : null;
    check('1.4 §14 Turn B：authoritative Recall 的 behaviorEffect 就是那条预期效果（7 键闭合对象）',
      tB.status === 200 && !!eB && effectKeysOf(eB) === EFFECT_KEYS_SORTED,
      { effect: eB, keys: eB ? effectKeysOf(eB) : null });
    check('1.5 §13/§14 derivedFrom = L3_AND_L5、sourceTurn = Turn A、ttlTurns = 1、target semantics = Turn B',
      !!eB && eB.derivedFrom === 'L3_AND_L5' && eB.sourceTurn === turnIdA && eB.ttlTurns === 1
      && eB.sourceTurn !== turnIdB && eB.rationaleCode === 'derived-from-negative-interpretation'
      && eB.stance === 'guarded' && eB.strategy === 'ask_clarifying' && eB.initiativeTendency === 'low',
      { effect: eB, turnIdA: turnIdA, turnIdB: turnIdB });
    const dB = H.inst.runtimeBehaviorEffect.describe();
    check('1.6 §10 Turn B consume = 1（单次消费：取走即删除）',
      dB.counters.consumed === 1 && dB.holder.entries === 0,
      { consumed: dB.counters.consumed, entries: dB.holder.entries });

    const tBReplay = await recallPost(H, reqB);
    const dBr = H.inst.runtimeBehaviorEffect.describe();
    check('1.7 §10 Turn B 重放：0 次额外消费（重放不触碰状态），值为 null',
      tBReplay.status === 200 && tBReplay.body && tBReplay.body.behaviorEffect === null
      && dBr.counters.consumed === 1,
      { replayEffect: tBReplay.body && tBReplay.body.behaviorEffect, consumed: dBr.counters.consumed });

    const tC = await recallPost(H, reqC);
    check('1.8 §14 Turn C：同一源回合的效果**不会**被再次消费（没有陈旧效果）⇒ behaviorEffect = null',
      tC.status === 200 && tC.body && tC.body.behaviorEffect === null
      && H.inst.runtimeBehaviorEffect.describe().counters.consumed === 1
      && H.inst.runtimeBehaviorEffect.describe().holder.entries === 0,
      { turnCEffect: tC.body && tC.body.behaviorEffect });
    /* 成本：整条链每回合 ≤ 2 次模型调用（解释 1 + 期望 1），行为层 0 */
    const cognitiveWire = H.rec.filter(e => e.body.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0 || e.body.indexOf('EXPECTATION_INPUT') >= 0).length;
    check('1.9 §0 整链成本 = 解释 1 + 期望 1 + BehaviorEffect 0；行为层实测 0 次 provider 调用',
      H.inst.runtimeBehaviorEffect.describe().cost.providerCalls === 0
      && cognitiveWire >= 1 && cognitiveWire <= 6,
      { cognitiveWireCalls: cognitiveWire, note: 'interpretation and expectation each contribute at most one per live turn' });
  }

  /* ══════════════════════════════════════════════════════════════════ 1b · 链式诚实边界 */
  section('1b · chained turns — every eligible turn can derive; no effect is ever consumed twice');
  {
    const H = await liveInstance('chain');
    const reqA = { requestId: 'r4f_chain_a', conversationId: convOf(CHAR_A), message: QUERY };
    const reqB = { requestId: 'r4f_chain_b', conversationId: convOf(CHAR_A), message: QUERY + ' chain-b' };
    const reqC = { requestId: 'r4f_chain_c', conversationId: convOf(CHAR_A), message: QUERY + ' chain-c' };
    const idA = RC.deriveStableTurnId(reqA.requestId, reqA.conversationId);
    const idB = RC.deriveStableTurnId(reqB.requestId, reqB.conversationId);
    await recallPost(H, reqA);
    await settle(H);
    const tB = await recallPost(H, reqB);
    await settle(H);
    const tC = await recallPost(H, reqC);
    await settle(H);
    const eB = tB.body && tB.body.behaviorEffect ? tB.body.behaviorEffect : null;
    const eC = tC.body && tC.body.behaviorEffect ? tC.body.behaviorEffect : null;
    check('1b.1 每个合格回合各自派生一条给**下一轮**的效果：B 收到 A 的，C 收到 B 的（每一条都只交付一次）',
      !!eB && eB.sourceTurn === idA && !!eC && eC.sourceTurn === idB
      && H.inst.runtimeBehaviorEffect.describe().counters.consumed === 2
      && H.inst.runtimeBehaviorEffect.describe().counters.derived === 3,
      { eB: eB && eB.sourceTurn, eC: eC && eC.sourceTurn, idA: idA, idB: idB, counters: H.inst.runtimeBehaviorEffect.describe().counters });
    check('1b.2 任何一回合都**没有**收到已经被消费过的旧效果（A 的效果不在 C 上，B 的效果不在 B 自己身上）',
      (!eC || eC.sourceTurn !== idA) && (!eB || eB.sourceTurn !== idB),
      { note: 'single consumption holds per chain link' });
  }

  /* ══════════════════════════════════════════════════════════════════ 2 · 信封形状 */
  section('2 · authoritative envelope — 17 keys, effects untouched, caller may not submit');
  {
    /* 递进时钟（+1 ms/次）：让"deadline-exceeded"这条**知道 mode** 的失败路径
       可被真实触达（固定时钟下 latencyMs 恒为 0，永远命不中那条分支），
       同时默认 2000 ms 窗口下的正常请求不受影响。 */
    let tick = NOW;
    const H = await liveInstance('envelope', { clock: function () { tick += 1; return tick; } });
    const ok = await recallPost(H, { requestId: 'r4f_env_ok' });
    await settle(H);
    const keysOk = Object.keys(ok.body || {});
    check('2.1 §12 成功信封 17 键，且 behaviorEffect 是 server-owned / 结构化 / 可空',
      ok.status === 200 && keysOk.length === 17 && keysOk.indexOf('behaviorEffect') >= 0 && ok.body.behaviorEffect === null,
      { keys: keysOk });
    const beforeDerived = H.inst.runtimeBehaviorEffect.describe().counters.derived;
    const fail = await recallPost(H, { requestId: 'r4f_env_fail', timeoutMs: 1 });
    const keysFail = Object.keys(fail.body || {});
    check('2.2 §12 知道 mode 的失败路径与成功**同一套**键（17 键超集：多出的只是 error/reasonCode 类字段）',
      fail.status !== 200 && fail.body && fail.body.behaviorEffect === null
      && keysOk.every(k => keysFail.indexOf(k) >= 0),
      { status: fail.status, error: fail.body && fail.body.error, missingFromFailure: keysOk.filter(k => keysFail.indexOf(k) < 0) });
    const effects = ok.body && ok.body.effects ? ok.body.effects : {};
    check('2.3 §12 既有 `effects` 逐字仍是召回生命周期块（turnBegun/activation/exposure/turnEnded），行为语义没有混进去',
      J(Object.keys(effects).sort()) === J(['activation', 'exposure', 'turnBegun', 'turnEnded'])
      && J(effects).indexOf('stance') < 0 && J(effects).indexOf('strategy') < 0,
      Object.keys(effects));
    const forge = await recallPost(H, {
      requestId: 'r4f_forge_effect',
      behaviorEffect: { stance: 'warm', strategy: 'answer_directly', initiativeTendency: 'normal', rationaleCode: 'no-signal', sourceTurn: 'x', derivedFrom: 'L3_AND_L5', ttlTurns: 1 },
      interpretationValidated: true,
      interpretation: { items: [{ memoryId: 'm1', appraisal: 'positive' }] }
    });
    await settle(H);
    check('2.4 §12 浏览器/调用方**不得提交** behaviorEffect（闭集请求 ⇒ 400，零派生、零状态改变）',
      forge.status === 400 && H.inst.runtimeBehaviorEffect.describe().counters.derived === beforeDerived,
      { status: forge.status, code: forge.body && (forge.body.error || forge.body.reasonCode), before: beforeDerived });
    const badMode = await recallPost(H, { requestId: 'r4f_env_badmode', mode: 'not-a-mode' });
    const keysBad = Object.keys(badMode.body || {});
    const FROZEN_14 = ['ok', 'durable', 'operation', 'characterId', 'turnIdentity', 'selectedIds', 'activationPolicy', 'channel', 'reason', 'fingerprint', 'counts', 'chars', 'boundary', 'status'];
    const FAILURE_EXTRAS = ['error', 'reasonCode', 'detail', 'field', 'requestedOperation'];
    check('2.5 §12 校验期失败（还没有可信的 mode）仍是**冻结的 14 键基座**：不含 behaviorEffect / context / effects，也不含任何新键',
      badMode.status === 400 && keysBad.indexOf('behaviorEffect') < 0
      && keysBad.indexOf('context') < 0 && keysBad.indexOf('effects') < 0
      && keysBad.every(k => FROZEN_14.indexOf(k) >= 0 || FAILURE_EXTRAS.indexOf(k) >= 0),
      { keys: keysBad });
  }

  /* ══════════════════════════════════════════════════════════════════ 3 · 输入权威负例 */
  section('3 · input authority negatives — Recall-only / L3-only / L5-only / clone / forged / browser');
  {
    /* (a) 只有 Recall（解释 OFF）⇒ 没有 L3 ⇒ 零派生、下一轮 null */
    const Ha = await buildInstance('recall-only');
    Ha.inst.runtimePolicy.setExpectation(CHAR_A, true);
    const a1 = await recallPost(Ha, { requestId: 'r4f_recall_only_a' });
    await settle(Ha);
    const a2 = await recallPost(Ha, { requestId: 'r4f_recall_only_b' });
    check('3.1 Recall-only（解释 OFF、期望 ON）⇒ 0 次派生、下一轮 behaviorEffect = null、0 次模型调用',
      a1.status === 200 && a2.body.behaviorEffect === null
      && Ha.inst.runtimeBehaviorEffect.describe().counters.derived === 0 && Ha.rec.length === 0,
      { derived: Ha.inst.runtimeBehaviorEffect.describe().counters.derived, providerSeen: Ha.rec.length });
    /* (b) 只有 L3（期望 OFF）⇒ 零派生 */
    const Hb = await buildInstance('l3-only', { autoPolicy: { autoInterpretationEnabled: true } });
    const b1 = await recallPost(Hb, { requestId: 'r4f_l3_only_a' });
    await settle(Hb);
    const b2 = await recallPost(Hb, { requestId: 'r4f_l3_only_b' });
    check('3.2 L3-only（解释成功、期望 OFF）⇒ 0 次派生、下一轮 null（L3-only 仍是 bypass）',
      b1.status === 200 && b2.body.behaviorEffect === null
      && Hb.inst.runtimeBehaviorEffect.describe().counters.derived === 0
      && Hb.inst.runtimeRecall.describe().expectation.counters.skippedNoL3 === 0,
      { derived: Hb.inst.runtimeBehaviorEffect.describe().counters.derived });
    /* (c) 模块级：只有 L5 / 裸 clone / 结构伪造 L3 / 伪造 L5 */
    const m = BE.createRuntimeBehaviorEffect({});
    const L3_OK = { ok: true, status: 'succeeded', recordSource: 'SERVER_CANONICAL_REBIND', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] } };
    const L5_OK = { ok: true, status: 'created' };
    const base = { characterId: 'A', conversationId: 'c', turnId: 'T', interpretationValidated: true, interpretationResult: L3_OK, expectationHeld: true, expectation: L5_OK };
    const rL5Only = m.deriveAndHold({ characterId: 'A', conversationId: 'c', turnId: 'T', expectationHeld: true, expectation: L5_OK });
    const rNoFlags = m.deriveAndHold({ characterId: 'A', conversationId: 'c', turnId: 'T', interpretationResult: L3_OK, expectation: L5_OK });
    const rClone = m.deriveAndHold(Object.assign({}, base, { interpretationResult: JSON.parse(JSON.stringify(L3_OK.interpretation)) }));
    const rBadAppraisal = m.deriveAndHold(Object.assign({}, base, { interpretationResult: { ok: true, status: 'succeeded', recordSource: 'SERVER_CANONICAL_REBIND', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'ecstatic' }] } } }));
    const rBadL5 = m.deriveAndHold(Object.assign({}, base, { expectation: { ok: true, status: 'not-created' } }));
    const rNoL5 = m.deriveAndHold(Object.assign({}, base, { expectationHeld: false }));
    check('3.3 L5-only ⇒ expectation-absent / l3-not-validated（运行时上不可能出现，模块也拒绝）',
      rL5Only.status === 'none' && rL5Only.reason === 'l3-not-validated'
      && rNoFlags.status === 'none' && rNoFlags.reason === 'l3-not-validated',
      { l5Only: rL5Only, noFlags: rNoFlags });
    check('3.4 裸 L3 shadow **clone** ⇒ l3-not-a-server-result（不是服务端结果对象 ⇒ 无效果）',
      rClone.status === 'none' && rClone.reason === 'l3-not-a-server-result', rClone);
    check('3.5 结构伪造的 L3（appraisal 不在 R4-C 闭集）⇒ l3-shape-invalid（fail closed）',
      rBadAppraisal.status === 'none' && rBadAppraisal.reason === 'l3-shape-invalid', rBadAppraisal);
    check('3.6 伪造 L5（status != created）⇒ expectation-malformed；L5 缺席 ⇒ expectation-absent',
      rBadL5.status === 'none' && rBadL5.reason === 'expectation-malformed'
      && rNoL5.status === 'none' && rNoL5.reason === 'expectation-absent',
      { badL5: rBadL5, noL5: rNoL5 });
    check('3.7 合法输入仍然派生（负例不是"全都拒绝"的空断言）',
      m.deriveAndHold(base).status === 'derived', m.deriveAndHold(base));
    check('3.8 乱输入永不抛：deriveAndHold / consumeForTurn / validateEffect 对 null·字符串·数组·Proxy 都不抛',
      (function () {
        try {
          for (const junk of [null, undefined, 'x', 3, [], function () {}, { interpretation: 'x' }, { items: {} }]) {
            m.deriveAndHold(junk); m.consumeForTurn(junk); BE.validateEffect(junk); BE.renderLine(junk);
          }
          return true;
        } catch (_) { return false; }
      })(),
      'garbage inputs return fail-closed results');
    P('CLONE_OF_SERVER_RESULT_IN_PROCESS', 'NOT_DISTINGUISHABLE');
    P('BROWSER_SUPPLIED_L3_L5_EFFECT', 'REJECTED_BY_CLOSED_REQUEST_SCHEMA');
  }

  /* ══════════════════════════════════════════════════════════════════ 4 · schema */
  section('4 · schema validation — closed 7 keys, fail closed');
  {
    const good = { stance: 'warm', strategy: 'answer_directly', initiativeTendency: 'normal', rationaleCode: 'derived-from-positive-interpretation', sourceTurn: 't1', derivedFrom: 'L3_AND_L5', ttlTurns: 1 };
    check('4.1 全部允许的枚举值都被接受（每条枚举逐值走一遍）',
      BE.STANCES.every(v => BE.validateEffect(Object.assign({}, good, { stance: v })).ok)
      && BE.STRATEGIES.every(v => BE.validateEffect(Object.assign({}, good, { strategy: v })).ok)
      && BE.INITIATIVE_TENDENCIES.every(v => BE.validateEffect(Object.assign({}, good, { initiativeTendency: v })).ok)
      && BE.RATIONALE_CODES.every(v => BE.validateEffect(Object.assign({}, good, { rationaleCode: v })).ok),
      { stances: BE.STANCES, strategies: BE.STRATEGIES });
    const illegal = [
      ['stance', 'angry'], ['strategy', 'shout'], ['initiativeTendency', 'extreme'],
      ['rationaleCode', 'derived-from-guess'], ['derivedFrom', 'L3'], ['derivedFrom', 'L5'],
      ['derivedFrom', 'L3+L5'], ['derivedFrom', null], ['ttlTurns', 2], ['ttlTurns', null],
      ['sourceTurn', ''], ['sourceTurn', 'x'.repeat(300)],
      ['stance', null], ['stance', 1]
    ];
    let allRejected = true; const seen = [];
    for (const [k, v] of illegal) {
      const r = BE.validateEffect(Object.assign({}, good, { [k]: v }));
      seen.push(k + '=' + J(v) + ':' + r.reason);
      if (r.ok) allRejected = false;
    }
    check('4.2 非法枚举 / 坏 derivedFrom / 坏 ttlTurns / 坏 sourceTurn 全部 fail closed', allRejected, seen.join(' · '));
    let missingRejected = true; const missing = [];
    for (const k of BE.EFFECT_KEYS) {
      const copy = Object.assign({}, good); delete copy[k];
      const r = BE.validateEffect(copy);
      missing.push(k + ':' + r.reason);
      if (r.ok || r.reason !== 'missing-field:' + k) missingRejected = false;
    }
    check('4.3 缺任一必需字段 ⇒ missing-field:<name>（逐个字段实测）', missingRejected, missing.join(' · '));
    check('4.4 多一个未知字段 ⇒ unknown-field:<name>（闭集键白名单）',
      !BE.validateEffect(Object.assign({}, good, { extra: 1 })).ok
      && BE.validateEffect(Object.assign({}, good, { extra: 1 })).reason === 'unknown-field:extra',
      BE.validateEffect(Object.assign({}, good, { extra: 1 })));
    let tunnelsRejected = true; const tunnels = [];
    for (const k of BE.FREE_TEXT_FIELDS) {
      const r = BE.validateEffect(Object.assign({}, good, { [k]: FREE_TEXT_PROBE }));
      tunnels.push(k + ':' + r.reason);
      if (r.ok || r.reason !== 'free-text-field-present:' + k) tunnelsRejected = false;
    }
    check('4.5 §1 免费文本隧道（promptText/instruction/fragment/guidance/text/prompt）逐名拒绝', tunnelsRejected, tunnels.join(' · '));
    let axesRejected = true; const axes = [];
    for (const k of BE.FORBIDDEN_AXES) {
      const r = BE.validateEffect(Object.assign({}, good, { [k]: 0.5 }));
      axes.push(k + ':' + r.reason);
      if (r.ok || r.reason !== 'forbidden-axis-present:' + k) axesRejected = false;
    }
    check('4.6 §1 不得新增的情绪/关系轴（warmth/patience/openness/guardedness/protectiveness/trust/familiarity/affinity）逐名拒绝', axesRejected, axes.join(' · '));
    check('4.7 冻结的 7 键就是全部：EFFECT_KEYS 与 shape 逐字一致',
      J(BE.EFFECT_KEYS) === J(['stance', 'strategy', 'initiativeTendency', 'rationaleCode', 'sourceTurn', 'derivedFrom', 'ttlTurns'])
      && BE.validateEffect(good).ok,
      BE.EFFECT_KEYS);
    /* 固定渲染器只吃闭合对象、只输出模板；绝不把原文写进 prompt */
    const line = BE.render(Object.assign({}, good, { stance: 'warm' }));
    check('4.8 §28 渲染器输出是**固定模板**（服务端自有表），绝不插入 L3/L5 原文或 rationale 自由文本',
      typeof line === 'string' && line.indexOf('低优先级') >= 0 && line.indexOf(FREE_TEXT_PROBE) < 0
      && Object.keys(BE.RENDER_TABLE).every(k => typeof BE.RENDER_TABLE[k] === 'string' && BE.RENDER_TABLE[k].indexOf('低优先级') >= 0),
      { line: line, rows: Object.keys(BE.RENDER_TABLE).length });
    check('4.9 渲染器对未知组合 fail closed（REFUSED），对中性走 NO_PLACEMENT',
      BE.renderLine(Object.assign({}, good, { stance: 'focused', strategy: 'hold_back', initiativeTendency: 'high' })).kind === 'REFUSED'
      && BE.renderLine(Object.assign({}, good, { stance: 'neutral', strategy: 'answer_directly', initiativeTendency: 'normal', rationaleCode: 'no-signal' })).kind === 'NO_PLACEMENT',
      'renderer contract = PLACEMENT | NO_PLACEMENT | REFUSED');
  }

  /* ══════════════════════════════════════════════════════════════════ 5 · NO_SIGNAL */
  section('5 · NO_SIGNAL is a first-class structured result (not null + fallback)');
  {
    const m = BE.createRuntimeBehaviorEffect({});
    const L3_OK = { ok: true, status: 'succeeded', recordSource: 'SERVER_CANONICAL_REBIND', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'unclear' }] } };
    const r = m.deriveAndHold({ characterId: 'A', conversationId: 'c', turnId: 'T1', interpretationValidated: true, interpretationResult: L3_OK, expectationHeld: true, expectation: { ok: true, status: 'created' } });
    check('5.1 无显著行为信号 ⇒ **结构化中性效果**（不是 null、不是自然语言解释）',
      r.status === 'derived' && !!r.effect && r.effect.stance === 'neutral'
      && r.effect.rationaleCode === 'no-signal' && r.effect.derivedFrom === 'L3_AND_L5'
      && r.effect.strategy === 'answer_directly' && r.effect.initiativeTendency === 'normal',
      r);
    check('5.2 中性效果通过 validateEffect（一等合法性），但固定渲染器**不放置**任何一行',
      BE.validateEffect(r.effect).ok && BE.renderLine(r.effect).kind === 'NO_PLACEMENT' && BE.render(r.effect) === null,
      BE.renderLine(r.effect));
    check('5.3 不得要求"每个 L3+L5 必然改变行为"：中性 appraisal 的投影就是中性基调（不因缺少负面而变暖）',
      r.effect.stance !== 'warm' && r.effect.rationaleCode !== 'derived-from-positive-interpretation'
      && r.effect.rationaleCode === 'no-signal',
      { stance: r.effect.stance, rationaleCode: r.effect.rationaleCode });
    /* 服务端实测：中性 L3 的那一轮之后，下一回合收到结构化中性效果 */
    const H = await liveInstance('neutral', { appraisal: 'neutral' });
    const tA = await recallPost(H, { requestId: 'r4f_neutral_a' });
    await settle(H);
    const tB = await recallPost(H, { requestId: 'r4f_neutral_b', message: QUERY + ' 中性' });
    const e = tB.body && tB.body.behaviorEffect ? tB.body.behaviorEffect : null;
    check('5.4 服务端实测：中性 L3 的那一轮 ⇒ 下一回合 behaviorEffect 是结构化中性效果（rationaleCode = no-signal）',
      tA.status === 200 && !!e && e.stance === 'neutral' && e.rationaleCode === 'no-signal'
      && e.derivedFrom === 'L3_AND_L5' && e.sourceTurn === RC.deriveStableTurnId('r4f_neutral_a', convOf(CHAR_A)),
      { effect: e });
  }

  /* ══════════════════════════════════════════════════════════════════ 6 · 持有者生命周期 + 隔离 */
  section('6 · holder lifecycle — 64 / 600 000 ms / character+conversation / source-turn guard');
  {
    let fake = NOW;
    const m = BE.createRuntimeBehaviorEffect({ clock: () => fake });
    const L3_OK = { ok: true, status: 'succeeded', recordSource: 'SERVER_CANONICAL_REBIND', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'negative' }] } };
    const derive = (turnId, characterId, conversationId) => m.deriveAndHold({
      characterId: characterId || CHAR_A, conversationId: conversationId || 'c', turnId: turnId,
      interpretationValidated: true, interpretationResult: L3_OK, expectationHeld: true, expectation: { ok: true, status: 'created' }
    });
    let derived = 0;
    for (let i = 0; i < 70; i++) { if (derive('turn_' + i).status === 'derived') derived += 1; }
    check('6.1 容量上限 64：派生继续成功，但持有条数封顶（最早被淘汰）',
      derived === 70 && m.heldCount() === 64 && m.describe().holder.maxEntries === 64,
      { derived: derived, held: m.heldCount(), evicted: m.describe().counters.evicted });
    check('6.2 §16 源回合取不到自己的效果；同角色同会话的**下一个**回合可以取到',
      m.consumeForTurn({ characterId: CHAR_A, conversationId: 'c', turnId: 'turn_69' }).reason === 'source-turn-cannot-consume'
      && m.consumeForTurn({ characterId: CHAR_A, conversationId: 'c', turnId: 'turn_next' }).status === 'applied',
      'source-turn guard + next-turn consumption');
    check('6.3 §16 跨角色隔离：A 的待取效果在 B 的回合取不到',
      (function () {
        derive('iso_a', CHAR_A, 'conv_a');
        const b = m.consumeForTurn({ characterId: CHAR_B, conversationId: 'conv_a', turnId: 'b1' });
        const a = m.consumeForTurn({ characterId: CHAR_A, conversationId: 'conv_a', turnId: 'a2' });
        return b.status === 'none' && b.reason === 'no-effect-held' && a.status === 'applied';
      })(),
      'different character ⇒ different pending effect');
    check('6.4 §16 跨会话隔离：同一角色另一个会话取不到',
      (function () {
        derive('iso_c1', CHAR_A, 'conv_c1');
        const other = m.consumeForTurn({ characterId: CHAR_A, conversationId: 'conv_c2', turnId: 'x1' });
        const own = m.consumeForTurn({ characterId: CHAR_A, conversationId: 'conv_c1', turnId: 'x2' });
        return other.status === 'none' && own.status === 'applied';
      })(),
      'different conversation ⇒ different pending effect');
    check('6.5 TTL 清理：过期条目在下次访问时被丢弃（+600 001 ms ⇒ 0 条，且每条都被计成 expired）',
      (function () {
        const before = m.heldCount();
        fake = NOW + 600001;
        const after = m.heldCount();
        const expired = m.describe().counters.expired;
        fake = NOW;
        return before >= 1 && after === 0 && expired === before;
      })(),
      { expired: m.describe().counters.expired });
    check('6.6 无身份证（缺 turnId / 缺角色 / 缺会话）⇒ 无消费',
      m.consumeForTurn({ characterId: CHAR_A, conversationId: 'c', turnId: '' }).reason === 'turn-identity-missing'
      && m.consumeForTurn({ characterId: '', conversationId: 'c', turnId: 't' }).reason === 'identity-incomplete',
      'identity required');
    /* 服务端持久化探针 */
    const H = await liveInstance('durable');
    const before = snapshotTree(H.dataDir);
    await new Promise(r => setTimeout(r, 60));
    const control = snapshotTree(H.dataDir);
    const controlChanged = Object.keys(control).filter(k => before[k] !== undefined && before[k] !== control[k]);
    await recallPost(H, { requestId: 'r4f_durable_a' });
    await settle(H);
    await recallPost(H, { requestId: 'r4f_durable_b', message: QUERY + ' durable' });
    await settle(H);
    const after = snapshotTree(H.dataDir);
    const newFiles = Object.keys(after).filter(k => before[k] === undefined);
    const changed = Object.keys(after).filter(k => before[k] !== undefined && before[k] !== after[k]);
    const attributable = changed.filter(k => controlChanged.indexOf(k) < 0);
    const VOLATILE = /-(shm|wal|journal)$/;
    const stateChanged = attributable.filter(k => !VOLATILE.test(k));
    check('6.7 §18 BEHAVIOR_EFFECT_DURABLE_WRITES = 0（没有新文件、没有状态文件变化；派生确实发生过）',
      newFiles.length === 0 && stateChanged.length === 0
      && H.inst.runtimeBehaviorEffect.describe().counters.derived >= 1,
      { newFiles: newFiles, stateChanged: stateChanged, engineSidecarChurn: attributable.filter(k => VOLATILE.test(k)), derived: H.inst.runtimeBehaviorEffect.describe().counters.derived });
    CONST.BEHAVIOR_EFFECT_DURABLE_WRITES = 0;
  }

  /* ══════════════════════════════════════════════════════════════════ 7 · replay / eviction truth */
  section('7 · replay / eviction truth — no permanent ledger');
  {
    const m = BE.createRuntimeBehaviorEffect({});
    const L3_OK = { ok: true, status: 'succeeded', recordSource: 'SERVER_CANONICAL_REBIND', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'mixed' }] } };
    const derive = (turnId) => m.deriveAndHold({ characterId: CHAR_A, conversationId: 'c', turnId: turnId, interpretationValidated: true, interpretationResult: L3_OK, expectationHeld: true, expectation: { ok: true, status: 'created' } });
    derive('ev_1');
    const first = m.consumeForTurn({ characterId: CHAR_A, conversationId: 'c', turnId: 'ev_target' });
    derive('ev_1');                                   /* 同一源回合再次派生：持有者**没有**账本 */
    const again = m.consumeForTurn({ characterId: CHAR_A, conversationId: 'c', turnId: 'ev_target_2' });
    check('7.1 §11 CROSS_EVICTION_EXACTLY_ONCE = NO：消费后同一源回合可以再次派生并被再次消费',
      first.status === 'applied' && again.status === 'applied' && m.describe().counters.derived === 2,
      { first: first.status, again: again.status, derived: m.describe().counters.derived });
    check('7.2 §11 replayBound = EVICTION_BOUNDED_NO_LEDGER，且自述里没有"永久 exactly-once"的说法',
      m.describe().holder.replayBound === 'EVICTION_BOUNDED_NO_LEDGER'
      && m.describe().holder.crossEvictionExactlyOnce === 'NO'
      && m.describe().holder.persistentLedger === 'NONE'
      && J(m.describe()).indexOf('exactly-once') < 0,
      m.describe().holder);
    check('7.3 同一源回合在持有者仍持有时重复派生 ⇒ replaced 计数增长（覆盖，不是第二个账本）',
      (function () {
        const before = m.describe().counters.replaced;
        derive('ev_same');
        derive('ev_same');
        return m.describe().counters.replaced === before + 1;
      })(), m.describe().counters);
  }

  /* ══════════════════════════════════════════════════════════════════ 8 · PE / Counterfactual 隔离 */
  section('8 · R4-D / R4-E isolation — no Prediction Error, no Counterfactual, no other writes');
  {
    const H = await liveInstance('isolation');
    const before = {
      mem: H.inst.memoryStore.getRevision(),
      cnt: H.inst.memoryStore.countRecords(),
      chat: J(H.inst.store.meta()),
      und: J({ w: H.inst.understandingStore.getWatermark(CHAR_A), a: H.inst.understandingStore.getActive(CHAR_A) }),
      character: J(H.inst.registry.getCharacter(CHAR_A))
    };
    const tA = await recallPost(H, { requestId: 'r4f_iso_a' });
    await settle(H);
    await recallPost(H, { requestId: 'r4f_iso_b', message: QUERY + ' iso' });
    await settle(H);
    const after = {
      mem: H.inst.memoryStore.getRevision(),
      cnt: H.inst.memoryStore.countRecords(),
      chat: J(H.inst.store.meta()),
      und: J({ w: H.inst.understandingStore.getWatermark(CHAR_A), a: H.inst.understandingStore.getActive(CHAR_A) }),
      character: J(H.inst.registry.getCharacter(CHAR_A))
    };
    check('8.1 派生确实发生了（隔离探针不是空的），且关系/记忆/chat/understanding 在行为层之外逐字不变',
      tA.status === 200 && H.inst.runtimeBehaviorEffect.describe().counters.derived >= 1
      && before.mem === after.mem && before.cnt === after.cnt && before.chat === after.chat
      && before.und === after.und && before.character === after.character,
      { derived: H.inst.runtimeBehaviorEffect.describe().counters.derived, before: before, after: after });
    const d = H.inst.runtimeBehaviorEffect.describe();
    check('8.2 §19 PREDICTION_ERROR_LIVE = NO / PREDICTION_ERROR_CALLS = 0 / COUNTERFACTUAL_AUTO_CALLS = 0',
      d.isolation.predictionErrorLive === 'NO' && d.isolation.predictionErrorCalls === 0
      && d.isolation.counterfactualAutoCalls === 0,
      d.isolation);
    check('8.3 模块没有任何"结算 / 反事实 / 观察"入口（不导出 settle/counterfactual/observe/confirm）',
      ['settle', 'settleExpectation', 'counterfactual', 'observe', 'confirm', 'contradict', 'revision']
        .every(k => H.inst.runtimeBehaviorEffect[k] === undefined),
      Object.keys(H.inst.runtimeBehaviorEffect).join(','));
    check('8.4 期望本体没有被改写：期望运行时的自述仍然是 MODEL / ≤1 调用（行为层没有碰它）',
      H.inst.runtimeExpectation.describe().executionKind === 'MODEL'
      && H.inst.runtimeExpectation.describe().maxAdditionalModelCallsPerCharacterTurn === 1
      && H.inst.runtimeExpectation.describe().predictionErrorLive === 'NO',
      { kind: H.inst.runtimeExpectation.describe().executionKind });
    const recallSrc = readRel('services/home-node/runtime-recall.js');
    check('8.5 召回边界仍无 counterfactual / prediction-error 域（LIVE-4/5 的禁止项一个字都没放宽）',
      !/counterfactual/i.test(SEAM_CODE_STRIP(recallSrc)) && !/prediction-error/i.test(SEAM_CODE_STRIP(recallSrc)),
      'forbidden domains still absent from the recall boundary');
  }

  /* ══════════════════════════════════════════════════════════════════ 9 · 守卫锐化 + 对抗样本 */
  section('9 · LIVE-5 guard sharpening — pinned seam + adversarial controls');
  {
    const recallSrc = readRel('services/home-node/runtime-recall.js');
    const interpSrc = readRel('services/home-node/runtime-interpretation.js');
    const audit = SEAM.auditRecallSeam(recallSrc);
    const auditInterp = SEAM.auditInterpretationSeam(interpSrc);
    check('9.1 召回边界：behaviorEffect 只出现在 5 个具名位置，dep 注入一次，derive/consume 各一次且位置精确',
      audit.ok && audit.facts.depLineCount === 1 && audit.facts.deriveSites.length === 1
      && audit.facts.consumeSites.length === 1 && audit.facts.regions.expectationRunTask === true,
      { reasons: audit.reasons, facts: audit.facts });
    check('9.2 解释边界：expectation / counterfactual / prediction-error / behaviorEffect 四域**全部**仍然禁止',
      auditInterp.ok, auditInterp.reasons);
    check('9.3 守卫不是空断言：撤销 dep 注入这一行就会被抓住（正例之外还有反例）',
      (function () {
        const broken = recallSrc.replace('const behaviorEffect = deps.behaviorEffect || null;', 'const behaviorEffect = null;');
        const r = SEAM.auditRecallSeam(broken);
        return broken !== recallSrc && r.ok === false && r.reasons.some(x => x.indexOf('dep-line-count') >= 0);
      })(),
      'negative control for the guard itself');
    let caught = 0; const caughtKinds = [];
    for (const kind of SEAM.FORGERY_KINDS) {
      const forged = SEAM.forgeRecallSeam(recallSrc, kind);
      const r = forged ? SEAM.auditRecallSeam(forged) : null;
      if (r && r.ok === false) { caught += 1; caughtKinds.push(kind + ':' + r.reasons[0]); }
      else caughtKinds.push(kind + ':NOT-CAUGHT');
    }
    check('9.4 §23 五个对抗样本（第二个 seam / 直接构造 / 错误函数读 holder / selector 阶段派生 / 源回合直接消费）**全部**被抓',
      caught === SEAM.FORGERY_KINDS.length,
      caughtKinds);
    check('9.5 两个 LIVE-5 套件都**引用同一份**守卫（不是各写一份会漂移的正则）',
      readRel('tests/test_r4c_live_interpretation_auto.js').indexOf('runtime-seam-guard.js') >= 0
      && readRel('tests/test_r4c_live_interpretation_auto_browser.js').indexOf('runtime-seam-guard.js') >= 0,
      'both LIVE-5 suites import tests/helpers/runtime-seam-guard.js');
  }

  /* ══════════════════════════════════════════════════════════════════ 10 · 判词 */
  section('10 · verdict');
  {
    CONST.R4F_BEHAVIOR_EFFECT_RUNTIME_READY = failed === 0 ? 'YES' : 'NO';
    CONST.R4F_BEHAVIOR_EFFECT_LIVE = 'NO';
    CONST.REPLAY_BOUND = BE.createRuntimeBehaviorEffect({}).describe().holder.replayBound;
    CONST.SOURCE_TURN_RETROACTIVE_EFFECT = 'NO';
    CONST.NO_SIGNAL_IS_FIRST_CLASS = 'YES';
    CONST.PREDICTION_ERROR_LIVE = 'NO';
    CONST.COUNTERFACTUAL_AUTO = 'NO';
    check('10.1 冻结判词自洽：RUNTIME_READY=YES / LIVE=NO / blocker 具名 / 成本 0+2',
      CONST.R4F_BEHAVIOR_EFFECT_RUNTIME_READY === 'YES' && CONST.R4F_BEHAVIOR_EFFECT_LIVE === 'NO'
      && CONST.BEHAVIOR_EFFECT_EXECUTION_KIND === 'DETERMINISTIC_RULES'
      && CONST.BEHAVIOR_EFFECT_INPUT_AUTHORITY === 'VALIDATED_L3_AND_L5'
      && CONST.MAX_COGNITIVE_EXTRA_MODEL_CALLS_PER_CHARACTER_TURN === 2
      && CONST.REPLAY_BOUND === 'EVICTION_BOUNDED_NO_LEDGER',
      { ready: CONST.R4F_BEHAVIOR_EFFECT_RUNTIME_READY, live: CONST.R4F_BEHAVIOR_EFFECT_LIVE });
    const urls = instances.flatMap(h => h.rec.map(e => String(e.url)));
    const hosts = Array.from(new Set(urls.map(u => {
      if (/^https?:\/\//i.test(u)) { try { return new URL(u).host; } catch (_) { return 'unparsable:' + u.slice(0, 40); } }
      return 'relative:' + u.split('?')[0];
    })));
    const foreign = hosts.filter(h => !/^relative:\/|^127\.0\.0\.1|^localhost|\.invalid$/.test(h));
    check('10.2 零真实出网：每一次 provider 请求都走注入的假端口（列出的 host 无一外来）',
      foreign.length === 0, { calls: urls.length, hosts: hosts, foreign: foreign });
  }

  console.log('');
  for (const k of Object.keys(CONST)) P(k, CONST[k]);
  console.log('R4F_BEHAVIOR_EFFECT_COUNTS passed=' + passed + ' failed=' + failed);
  console.log('NATURAL_EXIT = YES code=' + (failed === 0 ? 0 : 1));

  for (const h of instances) { try { h.inst.server.close(); } catch (_) {} try { h.inst.close(); } catch (_) {} }
  await new Promise(r => setTimeout(r, 300));
  for (const d of dirs.slice().reverse()) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(error => {
  console.log('SUITE_THREW: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});

/* ── helpers（放最后，避免与主体争注意力）────────────────────────────── */
function SEAM_CODE_STRIP(src) {
  return require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js')).stripJsComments(src);
}
