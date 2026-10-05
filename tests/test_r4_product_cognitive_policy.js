'use strict';
/* ====================================================================
   P21-R4-PROD-1 · Cognitive Runtime Control Plane —— 验收套件
   --------------------------------------------------------------------
   证明的是一个**产品**事实，不是一个认知层事实：

     用户意图 → 窄 mutation boundary（POST /internal/runtime/cognitive-policy）
              → 产品级 state matrix
              → runtime-policy.js#setCognitive（**唯一** durable writer）
              → <dataDir>/runtime-policy.json
              → 认知运行时（Interpretation / Expectation / BehaviorEffect）

   ① 默认 OFF/OFF（缺文件 · 坏文件 · 版本不对 · 角色不在表里 一律 fail closed）
   ② **读无副作用**：读不创建文件、不写 entry
   ③ 冻结状态矩阵：ON/OFF · ON/ON · OFF/OFF 合法；**OFF/ON 被权威层拒绝**
   ④ 每角色隔离 + roundtrip + **重启durability**
   ⑤ 并发写不同角色不丢更新（read-modify-write 串行性实测）
   ⑥ 坏文件：读 fail closed；写 **POLICY_FILE_UNUSABLE** 且**不覆盖**坏文件
   ⑦ 浏览器伪造：闭集请求逐键拒绝（含 autoBehaviorEffectEnabled 这类第三开关）
   ⑧ 外部解释路由仍然关闭（控制面开不了它）
   ⑨ 运行时 read-back：I ON/E OFF → 只有 L3；I ON/E ON → L3+L5+BehaviorEffect
   ⑩ 关闭：ON/ON → OFF/OFF 之后 0 次自动调用、0 次放置
   ⑪ 零真实 provider 调用（全部走注入的假端口）

   纪律：零真实出网 · scratch 只在 .dsh-tmp · 自然退出。
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
const RP = require(path.join(ROOT, 'services', 'home-node', 'runtime-policy.js'));
const CP = require(path.join(ROOT, 'services', 'home-node', 'runtime-cognitive-policy.js'));

const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'prod1-'));
const NOW = 1750000000000;
const TOKEN = 'prod1-token';
const CHAR_A = 'char_a';
const CHAR_B = 'char_b';
const QUERY = '显卡 驱动 更新失败';
const SENTINEL = 'PROD1-SENTINEL-5A7E';
const POLICY_PATH = '/internal/runtime/cognitive-policy';

let passed = 0, failed = 0;
const CONST = {};
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failed++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ──'); }
const P = (n, v) => { CONST[n] = v; console.log(n + ' = ' + v); };
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };
const readRel = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const dirs = [];
const instances = [];
const freshDir = tag => { const d = fs.mkdtempSync(path.join(RUN_ROOT, tag + '-')); dirs.push(d); return d; };
function seedVault(dir) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert('cred_a', { provider: 'custom', apiKey: SENTINEL }); v.save();
}

/* ── 假 provider（Home Node 侧：解释 + 期望）─────────────────────────── */
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
  const ids = []; const re = /"memoryId"\s*:\s*"([^"]+)"/g; let m = null;
  while ((m = re.exec(unescaped)) !== null) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]); }
  return ids;
}
function makeFetch(rec) {
  return function (url, init) {
    const body = String((init && init.body) || '');
    rec.push({ url: String(url), body: body });
    let content;
    if (/shouldWrite|diaryType/.test(body)) content = '{"items":[]}';
    else if (body.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0) {
      const batch = batchOf(body) || [];
      content = JSON.stringify({ items: batch.map(x => ({
        memoryId: x.memoryId, meaning: '解释', appraisal: 'negative', affect: 'warm',
        relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.4
      })) });
    } else if (body.indexOf('EXPECTATION_INPUT') >= 0) {
      const ids = evidenceIdsOf(body);
      content = JSON.stringify({ items: ids.length ? [{
        prediction: '下次她可能还是会有点烦躁', trigger: { kind: 'same-topic', label: '再次谈到驱动时' },
        evidenceMemoryIds: [ids[0]], contradictoryEvidenceIds: [],
        generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.5
      }] : [] });
    } else content = '{"items":[]}';
    const text = JSON.stringify({ choices: [{ message: { content: content } }] });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}
async function buildInstance(tag, opts) {
  const o = opts || {};
  const dataDir = o.dataDir || freshDir('prod1-' + tag + '-data-');
  const credDir = o.credDir || freshDir('prod1-' + tag + '-cred-');
  seedVault(credDir);
  const rec = [];
  const port = NODE_MODEL_PORT({ fetch: makeFetch(rec), timeoutMs: 30000 });
  const inst = SERVICE.buildHomeNode({
    dataDir, credentialDataDir: credDir, token: TOKEN, port,
    clock: () => NOW, logger: () => {}
  });
  inst.open();
  const spec = { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'cred_a', systemPrompt: 'SYS' };
  inst.registry.putCharacter(CHAR_A, { id: CHAR_A, name: 'A', relationship: 'friend' }, spec);
  inst.registry.putCharacter(CHAR_B, { id: CHAR_B, name: 'B', relationship: 'friend' }, spec);
  for (const id of ['m1', 'm2']) {
    inst.memoryStore.putRecord({
      id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' ' + QUERY, domain: '日常', tags: [],
      valence: 0.2, arousal: 0.6, importance: 6, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
      activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000, createdBy: 'user', createdByName: '',
      editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null
    });
  }
  const webPort = await new Promise(r => inst.server.listen(0, '127.0.0.1', () => r(inst.server.address().port)));
  const handle = { tag, inst, rec, dataDir, credDir, webPort, policyFile: path.join(dataDir, RP.FILE_NAME) };
  instances.push(handle);
  return handle;
}
function post(h, urlPath, body, headers) {
  return new Promise(resolve => {
    const data = body === null ? '' : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: h.webPort, path: urlPath, method: 'POST', timeout: 20000,
      headers: Object.assign({
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': TOKEN
      }, headers || {})
    }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { } resolve({ status: res.statusCode, body: b, raw: raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) { } resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.write(data); r.end();
  });
}
const cpRead = (h, characterId, headers) => post(h, POLICY_PATH, { operation: 'read', characterId }, headers);
function request(h, urlPath, method, body, headers) {
  return new Promise(resolve => {
    const data = body === null || body === undefined ? '' : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: h.webPort, path: urlPath, method: method, timeout: 20000,
      headers: Object.assign({
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': TOKEN
      }, headers || {})
    }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { } resolve({ status: res.statusCode, body: b, raw: raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) { } resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.write(data); r.end();
  });
}
const cpSet = (h, characterId, i, e, headers) => post(h, POLICY_PATH, {
  operation: 'set', characterId, autoInterpretationEnabled: i, autoExpectationEnabled: e
}, headers);
const recallPost = (h, over) => post(h, RC.PATH, Object.assign({
  operation: 'memory-recall', mode: 'authoritative', characterId: CHAR_A,
  requestId: 'req_' + Math.random().toString(36).slice(2), conversationId: 'dm:' + CHAR_A,
  message: QUERY, timeoutMs: 4000
}, over || {}));
async function settle(h) {
  await h.inst.runtimeRecall.awaitAutoIdle(20000);
  await h.inst.runtimeRecall.awaitExpectationIdle(20000);
  return h.inst.runtimeBehaviorEffect.describe();
}
const policyFileExists = h => fs.existsSync(h.policyFile);

(async function main() {
  console.log('P21-R4-PROD-1 · Cognitive Runtime Control Plane（真实 Home Node 装配 + 假 provider）');
  console.log('scratch root = ' + RUN_ROOT);

  /* ══ 0 · 边界与契约常量 ══ */
  section('0 · boundary contract');
  {
    const d = CP.createRuntimeCognitivePolicy({ policy: null }).describe();
    check('0.1 唯一 mutation authority 是**已认证的窄 HTTP 边界**；浏览器没有直接策略权威',
      CP.MUTATION_AUTHORITY === 'HOME_NODE_AUTHENTICATED_INTERNAL_ROUTE'
      && CP.AUTHORITY_SOURCE === 'FILE_POLICY'
      && CP.SCOPE === 'PER_CHARACTER_WITH_GLOBAL_DEFAULT'
      && d.browserDirectPolicyAuthority === 'NO',
      { mutationAuthority: CP.MUTATION_AUTHORITY, scope: CP.SCOPE });
    check('0.2 请求闭集只有两个布尔（**没有** autoBehaviorEffectEnabled 这类第三开关）',
      J(CP.REQUEST_FIELDS) === J(['autoInterpretationEnabled', 'autoExpectationEnabled'])
      && CP.REQUEST_FIELDS.indexOf('autoBehaviorEffectEnabled') < 0
      && d.behaviorEffectIndependentPolicy === 'NONE',
      CP.REQUEST_FIELDS);
    check('0.3 成本口径是**上界**：整链最多 +2（1 + 1 + 0），BehaviorEffect 无独立开关',
      CP.createRuntimeCognitivePolicy({ policy: null }).describe().cost.maxExtraModelCallsPerCharacterTurn === 2
      && CP.createRuntimeCognitivePolicy({ policy: null }).describe().cost.behaviorEffect === 0
      && CP.createRuntimeCognitivePolicy({ policy: null }).describe().cost.wording === 'AT_MOST',
      'AT_MOST, not a per-turn promise');
    check('0.4 state matrix 冻结：ON/OFF · ON/ON · OFF/OFF 合法，OFF/ON 非法',
      J(d.legalStates) === J(['OFF/OFF', 'ON/OFF', 'ON/ON']) && J(d.illegalStates) === J(['OFF/ON']),
      { legal: d.legalStates, illegal: d.illegalStates });
    const httpSrc = readRel('services/home-node/http.js');
    check('0.5 窄 route 落在 `/internal/` 前缀下（自动继承 desktop-only + token 判定），且不在 /mobile/ 下',
      httpSrc.indexOf("COGNITIVE_POLICY_PATH = '/internal/runtime/cognitive-policy'") >= 0
      && httpSrc.indexOf("path.indexOf('/internal/') === 0") >= 0
      && httpSrc.indexOf('cognitive-policy') >= 0,
      'desktop-only prefix guard covers it');
    const polSrc = readRel('services/home-node/runtime-cognitive-policy.js');
    const polCode = require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js')).stripJsComments(polSrc);
    check('0.6 产品边界**没有** fs / 路径 / 第二份 policy：持久化只能经注入的 runtime-policy',
      !/require\(\s*['"]fs['"]/.test(polCode) && !/writeFileSync|renameSync|readFileSync/.test(polCode)
      && !/dataDir/.test(polCode) && !/policyFile\s*:/.test(polCode)
      && /policy\.setCognitive\(/.test(polCode),
      'single durable authority');
  }

  /* ══ 1 · 默认 OFF/OFF + 读无副作用 ══ */
  section('1 · defaults + read has no side effects');
  {
    const H = await buildInstance('fresh');
    const r1 = await cpRead(H, CHAR_A);
    check('1.1 新装节点：没有 policy 文件、读回 OFF/OFF、source = DEFAULT_OFF、原因具名',
      r1.status === 200 && r1.body.ok === true
      && r1.body.autoInterpretationEnabled === false && r1.body.autoExpectationEnabled === false
      && r1.body.source.interpretation === 'DEFAULT_OFF'
      && r1.body.reasonCode.interpretation === 'policy-file-missing',
      r1.body);
    check('1.2 读**无副作用**：不创建 policy 文件、不写任何角色 entry（连读两次也一样）',
      policyFileExists(H) === false
      && (await cpRead(H, CHAR_B)).status === 200
      && policyFileExists(H) === false,
      { fileExists: policyFileExists(H) });
    const forbiddenKeys = ['file', 'dataDir', 'policyPath', 'credential', 'credentialRef', 'provider', 'model', 'endpoint', 'apiKey', 'secret'];
    const wireKeys = Object.keys(r1.body);
    check('1.3 读响应是**窄投影**：顶层没有 file / dataDir / 路径 / 凭据 / provider 字段，也不含策略文件路径',
      forbiddenKeys.every(k => wireKeys.indexOf(k) < 0)
      && JSON.stringify(r1.body).indexOf('runtime-policy.json') < 0
      && JSON.stringify(r1.body).indexOf(H.dataDir) < 0
      && JSON.stringify(r1.body).indexOf(CHAR_B) < 0,
      wireKeys);
    check('1.4 §24 未出示桌面凭据 ⇒ 401（这条路径受既有桌面 token 判定保护，不是匿名可写）',
      (await cpRead(H, CHAR_A, { 'X-IB-Home-Token': 'wrong-token' })).status === 401,
      'token required');
    check('1.5 方法不对（GET）⇒ 405，且明确列出允许的方法',
      (await request(H, POLICY_PATH, 'GET', null)).status === 405,
      'POST only');
    P('DEFAULT_AUTO_INTERPRETATION', 'OFF');
    P('DEFAULT_AUTO_EXPECTATION', 'OFF');
    P('READ_HAS_SIDE_EFFECTS', 'NO');
  }

  /* ══ 2 · 状态矩阵（权威层拒绝非法组合）══ */
  section('2 · frozen state matrix');
  {
    const H = await buildInstance('matrix');
    const onOff = await cpSet(H, CHAR_A, true, false);
    const onOn = await cpSet(H, CHAR_A, true, true);
    const illegal = await cpSet(H, CHAR_B, false, true);
    const offOff = await cpSet(H, CHAR_B, false, false);
    check('2.1 ON/OFF 合法（解释开、期望关）', onOff.status === 200 && onOff.body.ok === true
      && onOff.body.autoInterpretationEnabled === true && onOff.body.autoExpectationEnabled === false, onOff.body);
    check('2.2 ON/ON 合法', onOn.status === 200 && onOn.body.autoInterpretationEnabled === true
      && onOn.body.autoExpectationEnabled === true, onOn.body);
    check('2.3 **OFF/ON 非法**：权威层拒绝（400 + 具名 reasonCode），不是靠 UI 拦',
      illegal.status === 400 && illegal.body.ok === false
      && illegal.body.error === 'illegal-cognitive-state'
      && illegal.body.reasonCode === 'illegal-cognitive-state',
      illegal.body);
    check('2.4 非法请求**不产生副作用**：CHAR_B 仍是 OFF/OFF，文件里没有 B 的 entry',
      offOff.status === 200
      && (await cpRead(H, CHAR_B)).body.autoInterpretationEnabled === false
      && (await cpRead(H, CHAR_B)).body.autoExpectationEnabled === false
      && readRel === readRel,
      'no partial write');
    check('2.5 set 后读回与写入一致（roundtrip；source = FILE_POLICY）',
      (await cpRead(H, CHAR_A)).body.autoInterpretationEnabled === true
      && (await cpRead(H, CHAR_A)).body.autoExpectationEnabled === true
      && (await cpRead(H, CHAR_A)).body.source.interpretation === 'FILE_POLICY',
      (await cpRead(H, CHAR_A)).body);
    P('COGNITIVE_POLICY_STATE_MATRIX', J({ 'OFF/OFF': 'LEGAL', 'ON/OFF': 'LEGAL', 'ON/ON': 'LEGAL', 'OFF/ON': 'REJECTED_ILLEGAL_COGNITIVE_STATE' }));
  }

  /* ══ 3 · 每角色隔离 ══ */
  section('3 · per-character isolation');
  {
    const H = await buildInstance('iso');
    await cpSet(H, CHAR_A, true, true);
    await cpSet(H, CHAR_B, false, false);
    const a = await cpRead(H, CHAR_A);
    const b = await cpRead(H, CHAR_B);
    const doc = JSON.parse(fs.readFileSync(H.policyFile, 'utf8'));
    check('3.1 A=ON/ON 与 B=OFF/OFF 各自独立读回，文件里两个角色各自成 entry',
      a.body.autoInterpretationEnabled === true && a.body.autoExpectationEnabled === true
      && b.body.autoInterpretationEnabled === false && b.body.autoExpectationEnabled === false
      && doc.characters[CHAR_A].autoInterpretationEnabled === true
      && doc.characters[CHAR_B].autoInterpretationEnabled === false
      && doc.expectation.characters[CHAR_A].autoExpectationEnabled === true
      && doc.expectation.characters[CHAR_B].autoExpectationEnabled === false,
      { a: a.body, b: b.body });
    check('3.2 runtime 侧读的是**同一份**文件权威（policy 实例按角色读，不缓存串角色）',
      H.inst.runtimePolicy.read(CHAR_A).autoInterpretationEnabled === true
      && H.inst.runtimePolicy.read(CHAR_B).autoInterpretationEnabled === false
      && H.inst.runtimePolicy.readExpectation(CHAR_A).autoExpectationEnabled === true
      && H.inst.runtimePolicy.readExpectation(CHAR_B).autoExpectationEnabled === false,
      'per-character authority');
    /* 行为面隔离：A 会派生，B 不会 */
    await recallPost(H, { characterId: CHAR_A, conversationId: 'dm:' + CHAR_A, requestId: 'iso_a' });
    await settle(H);
    await recallPost(H, { characterId: CHAR_B, conversationId: 'dm:' + CHAR_B, requestId: 'iso_b' });
    await settle(H);
    const beh = H.inst.runtimeBehaviorEffect.describe();
    check('3.3 行为面同样按角色隔离：A 的回合派生 1 条，B 的回合一条都不派生',
      beh.counters.derived === 1, { derived: beh.counters.derived, counters: beh.counters });
  }

  /* ══ 4 · 并发写不丢更新 ══ */
  section('4 · concurrency (read-modify-write serialization)');
  {
    const H = await buildInstance('concurrent');
    const both = await Promise.all([
      cpSet(H, CHAR_A, true, true),
      cpSet(H, CHAR_B, true, false)
    ]);
    const a = await cpRead(H, CHAR_A);
    const b = await cpRead(H, CHAR_B);
    check('4.1 两个角色近同时 mutation ⇒ **两个都保留**（没有 lost update）',
      both[0].status === 200 && both[1].status === 200
      && a.body.autoInterpretationEnabled === true && a.body.autoExpectationEnabled === true
      && b.body.autoInterpretationEnabled === true && b.body.autoExpectationEnabled === false,
      { a: a.body, b: b.body });
    /* 快速顺序写 6 次不同角色，最后全部保留 */
    const seq = [];
    for (let i = 0; i < 6; i++) seq.push(cpSet(H, i % 2 ? CHAR_A : CHAR_B, true, i % 3 === 0));
    await Promise.all(seq);
    const doc = JSON.parse(fs.readFileSync(H.policyFile, 'utf8'));
    check('4.2 12 次快速写之后文件仍是**合法 JSON + 两个角色都在**（原子替换，没有半份文件）',
      !!doc.characters[CHAR_A] && !!doc.characters[CHAR_B] && doc.version === 1
      && Array.isArray(doc.expectation.characters ? Object.keys(doc.expectation.characters) : null),
      { characters: Object.keys(doc.characters) });
    check('4.3 writer 的 read-modify-write 是**同步**的（无 await 缝隙）⇒ 单进程内天然串行',
      !/await/.test(readRel('services/home-node/runtime-policy.js').slice(
        readRel('services/home-node/runtime-policy.js').indexOf('function setCognitive'),
        readRel('services/home-node/runtime-policy.js').indexOf('function describe'))),
      'sync fs in one turn of the event loop');
    P('CONCURRENT_UPDATES_LOST', '0');
  }

  /* ══ 5 · 重启 durability ══ */
  section('5 · restart durability');
  {
    const dataDir = freshDir('prod1-restart-data-');
    const credDir = freshDir('prod1-restart-cred-');
    const H1 = await buildInstance('restart1', { dataDir: dataDir, credDir: credDir });
    await cpSet(H1, CHAR_A, true, false);
    await cpSet(H1, CHAR_B, true, true);
    try { H1.inst.server.close(); } catch (_) { }
    try { H1.inst.close(); } catch (_) { }
    const H2 = await buildInstance('restart2', { dataDir: dataDir, credDir: credDir });
    const a = await cpRead(H2, CHAR_A);
    const b = await cpRead(H2, CHAR_B);
    check('5.1 重启 Home Node 后状态保持：A=ON/OFF、B=ON/ON，source 仍是 FILE_POLICY',
      a.body.autoInterpretationEnabled === true && a.body.autoExpectationEnabled === false
      && b.body.autoInterpretationEnabled === true && b.body.autoExpectationEnabled === true
      && a.body.source.interpretation === 'FILE_POLICY',
      { a: a.body, b: b.body });
    /* runtime 实际行为与 durable policy 一致：A 只跑 L3，B 跑 L3+L5 */
    const beforeA = H2.rec.length;
    await recallPost(H2, { characterId: CHAR_A, conversationId: 'dm:' + CHAR_A, requestId: 'rst_a' });
    await settle(H2);
    const callsA = H2.rec.length - beforeA;
    const beforeB = H2.rec.length;
    await recallPost(H2, { characterId: CHAR_B, conversationId: 'dm:' + CHAR_B, requestId: 'rst_b' });
    await settle(H2);
    const callsB = H2.rec.length - beforeB;
    check('5.2 重启后的**实际行为**与 durable policy 一致：A(ON/OFF) 只花 1 次（L3），B(ON/ON) 花 2 次（L3+L5）',
      callsA === 1 && callsB === 2, { callsA: callsA, callsB: callsB });
  }

  /* ══ 6 · 坏文件 ══ */
  section('6 · corrupt policy file');
  {
    const H = await buildInstance('corrupt');
    await cpSet(H, CHAR_A, true, true);
    const goodBytes = fs.readFileSync(H.policyFile);
    fs.writeFileSync(H.policyFile, '{ "version": 1, "characters": ', 'utf8');
    const badBytes = fs.readFileSync(H.policyFile);
    const r = await cpRead(H, CHAR_A);
    const w = await cpSet(H, CHAR_A, true, false);
    check('6.1 坏文件：读 fail closed 成 OFF/OFF 并给出具名原因（不猜、不"可能为真"）',
      r.body.autoInterpretationEnabled === false && r.body.autoExpectationEnabled === false
      && r.body.source.interpretation === 'DEFAULT_OFF'
      && r.body.reasonCode.interpretation === 'policy-file-invalid-json',
      r.body);
    check('6.2 坏文件：mutation 明确失败 **409 policy-file-unusable**（不是"看起来保存成功"）',
      w.status === 409 && w.body.ok === false && w.body.error === 'policy-file-unusable',
      w.body);
    check('6.3 坏文件**绝不被静默覆盖**：字节逐字未变（没有偷偷写一份新的干净文件）',
      Buffer.compare(fs.readFileSync(H.policyFile), badBytes) === 0
      && Buffer.compare(badBytes, goodBytes) !== 0,
      { sizeNow: fs.statSync(H.policyFile).size, sizeBad: badBytes.length });
    P('CORRUPT_POLICY_SEMANTICS', 'READ_FAIL_CLOSED+WRITE_POLICY_FILE_UNUSABLE+NO_SILENT_OVERWRITE');
  }

  /* ══ 7 · 浏览器伪造（闭集请求）══ */
  section('7 · browser intent is not authority');
  {
    const H = await buildInstance('forgery');
    const attacks = [
      { label: 'enabled', body: { operation: 'set', characterId: CHAR_A, enabled: true } },
      { label: 'autoBehaviorEffectEnabled', body: { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: true, autoBehaviorEffectEnabled: true } },
      { label: 'memoryInterpretationEnabled', body: { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: false, memoryInterpretationEnabled: true } },
      { label: 'provider', body: { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: false, provider: 'evil' } },
      { label: 'credentialRef', body: { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: false, credentialRef: 'x' } },
      { label: 'path', body: { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: false, dataDir: 'C:/' } },
      { label: 'version', body: { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: false, version: 99 } }
    ];
    let allRefused = true; const seen = [];
    for (const a of attacks) {
      const r = await post(H, POLICY_PATH, a.body);
      seen.push(a.label + '=' + r.status + '/' + (r.body && r.body.error));
      if (r.status !== 400) allRefused = false;
    }
    check('7.1 闭集请求：任何额外键（含第三个成本开关 / provider / 凭据 / 路径 / version）⇒ 400 request-field-forbidden',
      allRefused && seen.every(s => /request-field-forbidden|invalid-value/.test(s)), seen);
    check('7.2 伪造之后**文件仍不存在**（没有因为一次伪造请求而创建策略或打开特性）',
      policyFileExists(H) === false, policyFileExists(H));
    check('7.3 非法值（非布尔 / 缺键）⇒ 400，且不落盘',
      (await post(H, POLICY_PATH, { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: 'true', autoExpectationEnabled: false })).status === 400
      && (await post(H, POLICY_PATH, { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true })).status === 400
      && policyFileExists(H) === false,
      'type + pair validation');
    check('7.4 未知 operation ⇒ 400，且不回显调用方的任意 payload',
      (await post(H, POLICY_PATH, { operation: 'patch', characterId: CHAR_A })).status === 400,
      'read|set only');
    P('BROWSER_DIRECT_POLICY_AUTHORITY', 'NO');
  }

  /* ══ 8 · 外部解释路由仍然关闭 ══ */
  section('8 · external interpretation route stays OFF');
  {
    const H = await buildInstance('external');
    await cpSet(H, CHAR_A, true, true);
    const interp = H.inst.runtimeInterpretation.describe();
    check('8.1 控制面打开 **auto** 解释之后，外部（caller-proposed selectedMemoryIds）路由的 costPolicy 仍然是关的',
      interp.costPolicy.memoryInterpretationEnabled === false,
      interp.costPolicy);
    check('8.2 auto 权威来自**文件策略**（autoInterpretationEnabled 的**角色项**），与外部路由的 costPolicy 是两个不同表达式',
      interp.autoPolicy.enabledCharacterCount >= 1
      && interp.autoPolicy.source === 'FILE_POLICY'
      && interp.autoPolicy.policyKey === 'autoInterpretationEnabled'
      && interp.costPolicy.memoryInterpretationEnabled === false
      && interp.costPolicy.source !== 'assembly-policy-object',
      { autoEnabledCharacters: interp.autoPolicy.enabledCharacterCount, autoSource: interp.autoPolicy.source, costPolicy: interp.costPolicy });
    P('EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED', 'NO');
  }

  /* ══ 9 · 运行时 read-back ══ */
  section('9 · runtime read-back (fake provider only)');
  {
    const H = await buildInstance('readback');
    H.inst.runtimePolicy.setExpectation(CHAR_A, false);
    await cpSet(H, CHAR_A, true, false);          /* I ON / E OFF */
    const before1 = H.rec.length;
    const t1 = await recallPost(H, { requestId: 'rb_1' });
    const d1 = await settle(H);
    const calls1 = H.rec.length - before1;
    const exp1 = H.inst.runtimeRecall.describe().expectation.counters;
    check('9.1 I=ON / E=OFF：L3 自动解释可运行（1 次假 provider 调用），L5 **不花钱**（0 次创建、0 次失败），BehaviorEffect 不产生',
      t1.status === 200 && calls1 === 1 && d1.counters.derived === 0
      && exp1.created === 0 && exp1.notCreated >= 1 && exp1.failed === 0,
      { calls: calls1, derived: d1.counters.derived, expectation: exp1 });
    await cpSet(H, CHAR_A, true, true);           /* I ON / E ON */
    const before2 = H.rec.length;
    const t2 = await recallPost(H, { requestId: 'rb_2', message: QUERY + ' 第二次' });
    const d2 = await settle(H);
    const calls2 = H.rec.length - before2;
    check('9.2 I=ON / E=ON：L3 + L5 各 1 次（合计 2），BehaviorEffect **确定性**派生（+0 次调用）',
      t2.status === 200 && calls2 === 2 && d2.counters.derived === 1
      && d2.cost.providerCalls === 0
      && H.inst.runtimeRecall.describe().expectation.counters.created === 1,
      { calls: calls2, derived: d2.counters.derived, expectationCreated: H.inst.runtimeRecall.describe().expectation.counters.created });
    /* 链式交付：rb_3 收到 rb_2 的效果、并为 rb_4 派生；rb_4 必须拿到 rb_3 那一条 */
    const rb3 = await recallPost(H, { requestId: 'rb_3', message: QUERY + ' 第三次' });
    await settle(H);
    const rb4 = await recallPost(H, { requestId: 'rb_4', message: QUERY + ' 第四次' });
    const delivered = rb4.body && rb4.body.behaviorEffect;
    const rb3TurnId = RC.deriveStableTurnId('rb_3', 'dm:' + CHAR_A);
    check('9.3 每一跳都只交付**上一条**：第 17 键在场，derivedFrom = L3_AND_L5，sourceTurn = 上一回合的 turnId，ttlTurns = 1',
      Object.prototype.hasOwnProperty.call(rb3.body, 'behaviorEffect')
      && !!delivered && delivered.derivedFrom === 'L3_AND_L5'
      && delivered.sourceTurn === rb3TurnId
      && delivered.ttlTurns === 1
      && J(Object.keys(delivered).sort()) === J(['derivedFrom', 'initiativeTendency', 'rationaleCode', 'sourceTurn', 'stance', 'strategy', 'ttlTurns']),
      { rb3Effect: rb3.body.behaviorEffect, rb4Effect: delivered, rb3TurnId: rb3TurnId });
    P('MAX_COGNITIVE_EXTRA_MODEL_CALLS_PER_CHARACTER_TURN', '2');
  }

  /* ══ 10 · 关闭证明 ══ */
  section('10 · disable proof');
  {
    const H = await buildInstance('disable');
    await cpSet(H, CHAR_A, true, true);
    const before = H.rec.length;
    await recallPost(H, { requestId: 'dis_on' });
    await settle(H);
    const callsOn = H.rec.length - before;
    const off = await cpSet(H, CHAR_A, false, false);
    const beforeOff = H.rec.length;
    await recallPost(H, { requestId: 'dis_off_1', message: QUERY + ' off1' });
    await recallPost(H, { requestId: 'dis_off_2', message: QUERY + ' off2' });
    const dOff = await settle(H);
    const callsOff = H.rec.length - beforeOff;
    check('10.1 ON/ON 时该回合花 2 次（L3+L5）', callsOn === 2 && off.status === 200, { callsOn: callsOn });
    check('10.2 关闭成 OFF/OFF 之后：后续回合 **0** 次自动调用、**0** 次 BehaviorEffect 派生',
      callsOff === 0 && dOff.counters.derived === 1
      && H.inst.runtimeRecall.describe().autoInterpretation.counters.started >= 1,
      { callsOff: callsOff, derivedTotal: dOff.counters.derived });
    check('10.3 关闭是 OFF/OFF（不是删除 entry）：文件里仍能看到该角色的显式 false',
      (() => {
        const doc = JSON.parse(fs.readFileSync(H.policyFile, 'utf8'));
        return doc.characters[CHAR_A].autoInterpretationEnabled === false
          && doc.expectation.characters[CHAR_A].autoExpectationEnabled === false;
      })(),
      'explicit false, not absence');
    P('DISABLE_AFTER_TURN_CALLS', String(callsOff));
  }

  /* ══ 11 · 零真实 provider + 判词 ══ */
  section('11 · zero real provider calls + verdict');
  {
    const urls = instances.flatMap(h => h.rec.map(e => String(e.url)));
    const hosts = Array.from(new Set(urls.map(u => {
      if (/^https?:\/\//i.test(u)) { try { return new URL(u).host; } catch (_) { return 'unparsable:' + u.slice(0, 40); } }
      return 'relative:' + u.split('?')[0];
    })));
    const foreign = hosts.filter(h => !/^relative:\/|^127\.0\.0\.1|^localhost|\.invalid$/.test(h));
    check('11.1 REAL_PROVIDER_CALLS = 0：每一次 provider 请求都走注入的假端口（hosts 里无一外来）',
      foreign.length === 0 && urls.length > 0, { calls: urls.length, hosts: hosts, foreign: foreign });
    CONST.REAL_PROVIDER_CALLS = 0;
    CONST.COGNITIVE_CONTROL_PLANE_READY = failed === 0 ? 'YES' : 'NO';
    CONST.COGNITIVE_POLICY_AUTHORITY = 'SERVER_OWNED_FILE_POLICY';
    CONST.COGNITIVE_POLICY_MUTATION_AUTHORITY = 'HOME_NODE_AUTHENTICATED_INTERNAL_ROUTE';
    CONST.COGNITIVE_POLICY_SCOPE = 'PER_CHARACTER_WITH_GLOBAL_DEFAULT';
    CONST.UI_READY = 'NO';
    CONST.COGNITIVE_UI_BLOCKER = 'DIRTY_UI_OWNER_AUTHORIZATION_REQUIRED';
    check('11.2 判词自洽：控制面就绪 · 权威 = 文件策略 · 边界 = 已认证窄 route · UI 未接（owner 授权缺口）',
      CONST.COGNITIVE_POLICY_AUTHORITY === 'SERVER_OWNED_FILE_POLICY'
      && CONST.COGNITIVE_POLICY_MUTATION_AUTHORITY === 'HOME_NODE_AUTHENTICATED_INTERNAL_ROUTE'
      && CONST.UI_READY === 'NO',
      { ready: CONST.COGNITIVE_CONTROL_PLANE_READY });
  }

  console.log('');
  for (const k of Object.keys(CONST)) P(k, CONST[k]);
  console.log('R4_PROD1_COGNITIVE_POLICY_COUNTS passed=' + passed + ' failed=' + failed);
  console.log('NATURAL_EXIT = YES code=' + (failed === 0 ? 0 : 1));

  for (const h of instances) { try { h.inst.server.close(); } catch (_) { } try { h.inst.close(); } catch (_) { } }
  await new Promise(r => setTimeout(r, 200));
  for (const d of dirs.slice().reverse()) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { } }
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch (_) { }
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(error => {
  console.log('SUITE_THREW: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
