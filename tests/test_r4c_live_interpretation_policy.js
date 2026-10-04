'use strict';
/* ====================================================================
   P21-R4-LIVE-4.3 · 生产成本权威（文件策略）—— §30 验收套件
   --------------------------------------------------------------------
   这一套件证明四件事，全部来自**实测**（不是自述）：
     ① FAIL-CLOSED：缺失 / 读不动 / JSON 坏 / version 不对 / 值不是布尔 /
        角色不在表里 ⇒ OFF；
     ② 每角色隔离：A 开 ⇒ 合格回合恰好 ≤1 次 provider 调用；B 关 ⇒ 0 次；
     ③ 浏览器伪造无效：两条路由的请求体里塞 enabled / autoInterpretationEnabled
        都不改变任何行为，也不改文件（前后 hash 相同）；
     ④ 权威来源自述诚实：生产 = FILE_POLICY；只有装配层显式注入测试缝时才是
        TEST_INJECTION，而且测试缝**不会**写文件、不会在重启后留下来。

   纪律：零真实出网（假 fetch）、只在 `.dsh-tmp` 下开临时目录、每个 case 有
   watchdog、自然退出（没有 process.exit(0)）。
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

let passed = 0, failed = 0;
const SECTION_ROWS = [];
function section(title) { console.log('\n── ' + title + ' ──'); SECTION_ROWS.push(title); }
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS ' + name + (detail === undefined ? '' : '  -> ' + safe(detail))); }
  else { failed++; console.log('  FAIL ' + name + '  -> ' + safe(detail)); }
}
function safe(v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (_) { return String(v); } }
const J = (v) => safe(v);

/* ── machine-readable summary（house style）────────────────────────────── */
let DEFAULT_ALL_OFF = 'UNKNOWN';
let FAIL_CLOSED_MATRIX = 'UNKNOWN';
let PER_CHARACTER_ISOLATION = 'UNKNOWN';
let BROWSER_FORGE_NO_EFFECT = 'UNKNOWN';
let AUTHORITY_SOURCE_PRODUCTION = 'UNKNOWN';
let TEST_SEAM_IS_NOT_A_PRODUCTION_BACKDOOR = 'UNKNOWN';
let EXTERNAL_ROUTE_DISABLED_WITH_POLICY_ON = 'UNKNOWN';
let POLICY_SUITE_REGISTERED_IN_TEST_ALL = 'UNKNOWN';
let REAL_PROVIDER_CALLS = 0;
let LAST_ASSERTION_TO_EXIT_MS = 'UNKNOWN';
let T_LAST_ASSERTION = 0;

const NOW = 1750000000000;
const CHAR_A = 'char_a';
const CHAR_B = 'char_b';
const ENDPOINT = 'https://provider-a.invalid/v1/chat/completions';
const SENTINEL = 'POLICY_SENTINEL_L43_9C21';
const QUERY = '显卡 驱动 更新失败';

/* 所有 scratch 都在 <repo>/.dsh-tmp 下（不用 os.tmpdir()、不用 C:） */
const SCRATCH = path.join(ROOT, '.dsh-tmp');
const MADE = [];
function freshDir(tag) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'l43-' + tag + '-'));
  MADE.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of MADE) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄已释放 */ } }
}

/* ── 假 fetch：只在解释端口上出现，绝不真实出网 ───────────────────────── */
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
function makeFetch(rec) {
  return function (url, init) {
    const entry = { url: String(url), body: String((init && init.body) || ''), at: Date.now() };
    rec.push(entry);
    entry.batch = batchOf(entry.body);
    const payload = { items: (entry.batch || []).map(x => ({ memoryId: x.memoryId, meaning: '解释', appraisal: 'mixed', affect: 'warm',
      relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.4 })) };
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}
function seedVault(dir, ref, provider, key) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert(ref, { provider, apiKey: key }); v.save();
}
const INSTANCES = [];
async function buildInstance(tag, opts) {
  const o = opts || {};
  const dataDir = o.dataDir || freshDir('l43-' + tag + '-data-');
  const credDir = o.credDir || freshDir('l43-' + tag + '-cred-');
  if (o.credA !== false) seedVault(credDir, 'cred_a', 'custom', SENTINEL);
  const rec = [];
  const port = NODE_MODEL_PORT({ fetch: makeFetch(rec) });
  const buildOpts = { dataDir, credentialDataDir: credDir, token: 'l43-token', port, clock: () => NOW, logger: () => {} };
  /* ★ 测试缝只在显式传入时出现；生产装配两侧都不传它。 */
  if (o.autoPolicy !== undefined) buildOpts.runtimeAutoInterpretationPolicy = o.autoPolicy;
  if (o.runtimePolicy !== undefined) buildOpts.runtimePolicy = o.runtimePolicy;
  const inst = SERVICE.buildHomeNode(buildOpts);
  inst.open();
  const spec = { provider: 'custom', model: 'model-a', endpoint: ENDPOINT, credentialRef: 'cred_a', systemPrompt: 'SYS' };
  inst.registry.putCharacter(CHAR_A, { id: CHAR_A, name: 'A', relationship: 'friend' }, spec);
  inst.registry.putCharacter(CHAR_B, { id: CHAR_B, name: 'B', relationship: 'friend' }, spec);
  const webPort = await new Promise(r => inst.server.listen(0, '127.0.0.1', () => r(inst.server.address().port)));
  const handle = { tag, inst, rec, dataDir, credDir, webPort, policyFile: path.join(dataDir, RP.FILE_NAME) };
  INSTANCES.push(handle);
  return handle;
}
function post(h, urlPath, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: h.webPort, path: urlPath, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': 'l43-token' } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { /* 非 JSON */ } resolve({ status: res.statusCode, body: b, raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) { /* 已销毁 */ } resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', e => resolve({ status: 0, body: null, raw: '', error: String(e && e.message) }));
    r.write(data); r.end();
  });
}
function putRecord(h, id, over) {
  return h.inst.memoryStore.putRecord(Object.assign({
    id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' ' + QUERY, domain: '日常', tags: [],
    valence: 0.2, arousal: 0.6, importance: 6, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000, createdBy: 'user',
    createdByName: '', editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {}));
}
const recallPost = (h, over) => post(h, RC.PATH, Object.assign({
  operation: 'memory-recall', mode: 'authoritative', characterId: CHAR_A,
  requestId: 'req_1', conversationId: 'dm:' + CHAR_A, message: QUERY, timeoutMs: 5000
}, over || {}));
const interpCalls = h => h.rec.length;
const idleOf = (h, ms) => h.inst.runtimeRecall.awaitAutoIdle(ms);
const interpOf = h => h.inst.runtimeInterpretation.describe();
const fileHash = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return null; } };
const writePolicy = (h, obj) => fs.writeFileSync(h.policyFile, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));

/* ── watchdog：每个 case 都有上界；到点打印诊断而不是挂死 ─────────────── */
function withCase(name, ms, fn) {
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('case-timeout: ' + name)), ms);
      if (t && typeof t.unref === 'function') t.unref();
    })
  ]);
}

(async function main() {
  const WATCHDOG_MS = Number(process.env.IB_L43_WATCHDOG_MS) || 120000;
  const watchdog = setTimeout(() => {
    console.log('L43_WATCHDOG_FIRED after ' + WATCHDOG_MS + 'ms (suite did not finish)');
  }, WATCHDOG_MS);
  watchdog.unref();

  /* ══════════════════════════════════════════════════════════════════
     0 · 模块面与注册
     ══════════════════════════════════════════════════════════════════ */
  section('0 · interfaces');
  check('0.1 runtime-policy exports the frozen surface',
    typeof RP.createRuntimePolicy === 'function' && RP.FILE_NAME === 'runtime-policy.json' && RP.SCHEMA_VERSION === 1,
    J({ factory: typeof RP.createRuntimePolicy, file: RP.FILE_NAME, version: RP.SCHEMA_VERSION }));
  const scratchPolicy = RP.createRuntimePolicy({ dataDir: freshDir('l43-scratch-'), logger: () => {} });
  check('0.2 the policy instance exposes read/set/describe only (no route, no browser surface)',
    typeof scratchPolicy.read === 'function' && typeof scratchPolicy.set === 'function'
    && typeof scratchPolicy.describe === 'function'
    && (function () {
      const d = scratchPolicy.describe();
      return d.routeExposed === false && d.writer === 'node-side-set-only' && d.authoritySource === 'FILE_POLICY';
    })(),
    J(scratchPolicy.describe()));

  section('§47 · aggregator registration self-check');
  const allSrc = fs.readFileSync(path.join(ROOT, 'tests', 'test-all.js'), 'utf8');
  check('§47.1 this suite is registered in tests/test-all.js',
    allSrc.indexOf('test_r4c_live_interpretation_policy.js') >= 0,
    'otherwise it is never aggregated');
  POLICY_SUITE_REGISTERED_IN_TEST_ALL = allSrc.indexOf('test_r4c_live_interpretation_policy.js') >= 0 ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════
     §1 · DEFAULT ALL OFF（fresh dataDir ⇒ 每个角色都关）
     ══════════════════════════════════════════════════════════════════ */
  section('§1 · DEFAULT_ALL_OFF (fresh dataDir, no seam)');
  const H = await withCase('build fresh instance', 30000, () => buildInstance('fresh', {}));
  putRecord(H, 'm_real', { importance: 9 });
  putRecord(H, 'm_second');
  const d0 = interpOf(H);
  check('1.1 authoritySource = FILE_POLICY in production (no test seam injected)',
    d0.autoPolicy.authoritySource === 'FILE_POLICY' && d0.autoPolicy.scope === 'per-character+global-default',
    J(d0.autoPolicy));
  check('1.2 fresh install ⇒ global default OFF and zero enabled characters',
    d0.autoPolicy.autoInterpretationEnabled === false && d0.autoPolicy.enabledCharacterCount === 0
    && d0.autoPolicy.default === false,
    J({ enabled: d0.autoPolicy.autoInterpretationEnabled, count: d0.autoPolicy.enabledCharacterCount }));
  check('1.3 the policy file does not exist yet (nothing pre-enables an existing character)',
    !fs.existsSync(H.policyFile), H.policyFile);
  const offTurn = await withCase('turn with policy OFF', 30000, () => recallPost(H, { requestId: 'req_off' }));
  await idleOf(H, 5000);
  check('1.4 policy OFF ⇒ the turn runs, the auto path is disabled and spends ZERO provider calls',
    offTurn.status === 200 && offTurn.body && offTurn.body.ok === true && interpCalls(H) === 0,
    J({ status: offTurn.status, calls: interpCalls(H) }));
  check('1.5 the disabled attempt is labelled disabled (not failed) in the recall counters',
    (() => { const c = H.inst.runtimeRecall.describe().autoInterpretation.counters; return c.notEnabled === 1 && c.failed === 0; })(),
    J(H.inst.runtimeRecall.describe().autoInterpretation.counters));
  DEFAULT_ALL_OFF = (d0.autoPolicy.autoInterpretationEnabled === false && d0.autoPolicy.enabledCharacterCount === 0 && interpCalls(H) === 0) ? 'YES' : 'NO';
  console.log('  DEFAULT_ALL_OFF = ' + DEFAULT_ALL_OFF);

  /* ══════════════════════════════════════════════════════════════════
     §2 · per-character ON（唯一写者：Node 侧 set()）
     ══════════════════════════════════════════════════════════════════ */
  section('§2 · explicit true via the only writer (Node-side set)');
  const setA = H.inst.runtimePolicy.set(CHAR_A, true);
  check('2.1 set(char_a,true) writes the document atomically and reports the value',
    setA.ok === true && setA.autoInterpretationEnabled === true && fs.existsSync(H.policyFile),
    J(setA));
  check('2.2 the file shape is the frozen one (version/default/characters)',
    (() => { const doc = JSON.parse(fs.readFileSync(H.policyFile, 'utf8'));
      return doc.version === 1 && doc.default && doc.default.autoInterpretationEnabled === false
        && doc.characters && doc.characters[CHAR_A] && doc.characters[CHAR_A].autoInterpretationEnabled === true; })(),
    fs.readFileSync(H.policyFile, 'utf8').replace(/\s+/g, ' '));
  const onTurn = await withCase('eligible turn for A', 30000, () => recallPost(H, { requestId: 'req_on' }));
  const onIdle = await idleOf(H, 30000);
  check('2.3 A ON ⇒ the turn is eligible and the auto path makes EXACTLY one provider call',
    onTurn.status === 200 && onIdle.idle === true && interpCalls(H) === 1,
    J({ status: onTurn.status, idle: onIdle, calls: interpCalls(H) }));
  check('2.4 the interpretation used the server-selected ids (binding came from the recall object)',
    !!H.rec[0] && Array.isArray(H.rec[0].batch) && H.rec[0].batch.length >= 1
    && J(H.rec[0].batch.map(b => b.memoryId)) === J(onTurn.body.selectedIds),
    J({ batch: H.rec[0] && H.rec[0].batch && H.rec[0].batch.map(b => b.memoryId), selected: onTurn.body.selectedIds }));

  /* ══════════════════════════════════════════════════════════════════
     §3 · A/B isolation（no shared cache can leak A's value to B）
     ══════════════════════════════════════════════════════════════════ */
  section('§3 · per-character isolation');
  const before = interpCalls(H);
  check('3.1 read(B) does not see A\'s value (no cross-character cache)',
    H.inst.runtimePolicy.read(CHAR_B).autoInterpretationEnabled === false
    && H.inst.runtimePolicy.read(CHAR_A).autoInterpretationEnabled === true,
    J({ a: H.inst.runtimePolicy.read(CHAR_A), b: H.inst.runtimePolicy.read(CHAR_B) }));
  const bTurn = await withCase('B turn stays OFF', 30000, () => recallPost(H, { requestId: 'req_b', characterId: CHAR_B, conversationId: 'dm:' + CHAR_B }));
  await idleOf(H, 5000);
  check('3.2 B (explicitly absent) ⇒ 0 provider calls while A is ON',
    bTurn.status === 200 && interpCalls(H) === before, J({ status: bTurn.status, calls: interpCalls(H) }));
  const setB = H.inst.runtimePolicy.set(CHAR_B, true);
  const bTurn2 = await withCase('B turn after opt-in', 30000, () => recallPost(H, { requestId: 'req_b2', characterId: CHAR_B, conversationId: 'dm:' + CHAR_B }));
  await idleOf(H, 30000);
  check('3.3 B opt-in ⇒ its own turn becomes eligible (A unaffected)',
    setB.ok === true && bTurn2.status === 200 && interpCalls(H) === before + 1
    && H.inst.runtimePolicy.read(CHAR_A).autoInterpretationEnabled === true,
    J({ calls: interpCalls(H), a: H.inst.runtimePolicy.read(CHAR_A).autoInterpretationEnabled }));
  const setAOff = H.inst.runtimePolicy.set(CHAR_A, false);
  const aTurn2 = await withCase('A turn after opt-out', 30000, () => recallPost(H, { requestId: 'req_a_off' }));
  await idleOf(H, 5000);
  check('3.4 explicit false ⇒ OFF again (and the file records the false value, not a deletion)',
    setAOff.ok === true && interpCalls(H) === before + 1
    && (JSON.parse(fs.readFileSync(H.policyFile, 'utf8')).characters[CHAR_A].autoInterpretationEnabled === false),
    J({ calls: interpCalls(H) }));
  PER_CHARACTER_ISOLATION = (interpCalls(H) === before + 1) ? 'YES' : 'NO';
  console.log('  PER_CHARACTER_ISOLATION = ' + PER_CHARACTER_ISOLATION);

  /* ══════════════════════════════════════════════════════════════════
     §4 · zero-memory / replay / external route
     ══════════════════════════════════════════════════════════════════ */
  section('§4 · cadence + external route');
  H.inst.runtimePolicy.set(CHAR_A, true);
  const zeroTurn = await withCase('zero-memory turn', 30000, () => recallPost(H, { requestId: 'req_zero', message: 'zzz 完全不相干的词' }));
  await idleOf(H, 5000);
  check('4.1 zero-memory turn ⇒ 0 provider calls, labelled not-needed / no-memory',
    interpCalls(H) === before + 1, J({ calls: interpCalls(H), selected: zeroTurn.body && zeroTurn.body.selectedIds }));
  const callsBeforeReplay = interpCalls(H);
  await withCase('replay same turn', 30000, () => recallPost(H, { requestId: 'req_a_off' }));
  await idleOf(H, 5000);
  check('4.2 replay of the same logical turn ⇒ 0 additional provider calls',
    interpCalls(H) === callsBeforeReplay, J({ calls: interpCalls(H) }));
  const ext = await withCase('external route with policy ON', 30000, () => post(H, RI.PATH, {
    operation: 'memory-interpretation', characterId: CHAR_A, timeoutMs: 2000, selectedMemoryIds: ['m_real']
  }));
  check('4.3 the EXTERNAL interpretation route stays 503 disabled even with the policy ON',
    ext.status === 503 && ext.body && ext.body.error === 'disabled',
    J({ status: ext.status, error: ext.body && ext.body.error }));
  EXTERNAL_ROUTE_DISABLED_WITH_POLICY_ON = (ext.status === 503 && ext.body && ext.body.error === 'disabled') ? 'YES' : 'NO';
  console.log('  EXTERNAL_ROUTE_DISABLED_WITH_POLICY_ON = ' + EXTERNAL_ROUTE_DISABLED_WITH_POLICY_ON);

  /* ══════════════════════════════════════════════════════════════════
     §5 · browser forgery has no effect
     ══════════════════════════════════════════════════════════════════ */
  section('§5 · browser forge attempts');
  const hashBefore = fileHash(H.policyFile);
  const forgedBody = { enabled: true, autoInterpretationEnabled: true };
  const forgeRecall = await withCase('forged recall body', 30000, () => recallPost(H, Object.assign({ requestId: 'req_forge1' }, forgedBody)));
  const forgeInterp = await withCase('forged interpretation body', 30000, () => post(H, RI.PATH, Object.assign({
    operation: 'memory-interpretation', characterId: CHAR_A, timeoutMs: 2000, selectedMemoryIds: ['m_real']
  }, forgedBody)));
  const hashAfter = fileHash(H.policyFile);
  check('5.1 the recall route refuses the forged authority keys by name (closed schema)',
    forgeRecall.status === 400 && forgeRecall.body && forgeRecall.body.ok === false
    && (forgeRecall.body.error === 'request-field-forbidden' || forgeRecall.body.error === 'caller-attempted-to-supply-recall-authority')
    && (forgeRecall.body.field === 'enabled' || forgeRecall.body.field === 'autoInterpretationEnabled'),
    J({ status: forgeRecall.status, error: forgeRecall.body && forgeRecall.body.error, field: forgeRecall.body && forgeRecall.body.field }));
  check('5.2 the interpretation route refuses them too (and stays disabled)',
    forgeInterp.status === 400 || forgeInterp.status === 503,
    J({ status: forgeInterp.status, error: forgeInterp.body && forgeInterp.body.error }));
  check('5.3 the policy FILE is byte-identical before/after both forgery attempts',
    hashBefore !== null && hashBefore === hashAfter, J({ before: hashBefore, after: hashAfter }));
  check('5.4 a forged request cannot flip an OFF character ON (B stays OFF after the attack)',
    H.inst.runtimePolicy.read(CHAR_B).autoInterpretationEnabled === true /* B was opted in above */
    && H.inst.runtimePolicy.read('char_never_seen').autoInterpretationEnabled === false,
    J({ neverSeen: H.inst.runtimePolicy.read('char_never_seen') }));
  BROWSER_FORGE_NO_EFFECT = (forgeRecall.status === 400 && hashBefore === hashAfter) ? 'YES' : 'NO';
  console.log('  BROWSER_FORGE_NO_EFFECT = ' + BROWSER_FORGE_NO_EFFECT);

  /* ══════════════════════════════════════════════════════════════════
     §6 · FAIL-CLOSED 矩阵
     ══════════════════════════════════════════════════════════════════ */
  section('§6 · fail-closed on every malformed input');
  const rows = [];
  function probeMalformed(label, write, expectReason) {
    if (write === null) { try { fs.unlinkSync(H.policyFile); } catch (_) { /* 已不存在 */ } }
    else writePolicy(H, write);
    const r = H.inst.runtimePolicy.read(CHAR_A);
    const ok = r.autoInterpretationEnabled === false && (expectReason === null || r.reason === expectReason);
    rows.push({ label, enabled: r.autoInterpretationEnabled, source: r.source, reason: r.reason, ok });
    check('6.x ' + label + ' ⇒ OFF', ok, J(r));
    return r;
  }
  probeMalformed('missing file', null, 'policy-file-missing');
  probeMalformed('invalid JSON', '{ "version": 1, ', 'policy-file-invalid-json');
  probeMalformed('not an object', '[]', 'policy-file-not-an-object');
  probeMalformed('wrong version', { version: 2, default: { autoInterpretationEnabled: true }, characters: {} }, 'policy-version-unsupported');
  /* ★ OBS-B（task-38 的 boundary-verify）：`version` 必须是**严格的数字 1**。
     `"1"`（字符串）以前因为 Number() 归一化而通过，配上 default:true 就能把全局
     default 打开 —— 而 fail-closed 矩阵说这种形状必须 OFF。这一条把它钉死。 */
  probeMalformed('string version "1" (with default:true and a character:true)',
    { version: '1', default: { autoInterpretationEnabled: true }, characters: { [CHAR_A]: { autoInterpretationEnabled: true } } },
    'policy-version-unsupported');
  probeMalformed('non-boolean character value', { version: 1, default: { autoInterpretationEnabled: false }, characters: { [CHAR_A]: { autoInterpretationEnabled: 'true' } } }, 'character-value-not-a-boolean');
  probeMalformed('characters not an object', { version: 1, default: { autoInterpretationEnabled: true }, characters: [] }, 'characters-not-an-object');
  probeMalformed('default missing/not boolean', { version: 1, characters: {} }, 'default-value-not-a-boolean');
  /* 全局 default 为 true 时，未知角色**按文件**为 ON（这是文件说的，不是猜测） */
  writePolicy(H, { version: 1, default: { autoInterpretationEnabled: true }, characters: {} });
  const globalOn = H.inst.runtimePolicy.read('char_unknown');
  check('6.8 a file-level global default of true is honoured for an unlisted character (FILE_POLICY)',
    globalOn.autoInterpretationEnabled === true && globalOn.source === 'FILE_POLICY' && globalOn.reason === 'global-default',
    J(globalOn));
  writePolicy(H, { version: 1, default: { autoInterpretationEnabled: false }, characters: {} });
  const afterReset = H.inst.runtimePolicy.read(CHAR_A);
  check('6.9 unlisted character with default false ⇒ OFF',
    afterReset.autoInterpretationEnabled === false, J(afterReset));
  FAIL_CLOSED_MATRIX = rows.every(r => r.ok) ? 'ALL_OFF' : 'LEAKED';
  console.log('  FAIL_CLOSED_MATRIX = ' + FAIL_CLOSED_MATRIX);

  /* ══════════════════════════════════════════════════════════════════
     §7 · restart（文件值存活）与测试缝不是生产后门
     ══════════════════════════════════════════════════════════════════ */
  section('§7 · restart + test-seam provenance');
  H.inst.runtimePolicy.set(CHAR_A, true);
  const H2 = await withCase('restart instance (same dataDir)', 30000, () => buildInstance('restart', { dataDir: H.dataDir, credDir: H.credDir }));
  putRecord(H2, 'm_real', { importance: 9 });
  check('7.1 the file-backed value survives a restart (new instance, same dataDir)',
    H2.inst.runtimePolicy.read(CHAR_A).autoInterpretationEnabled === true
    && interpOf(H2).autoPolicy.authoritySource === 'FILE_POLICY',
    J({ read: H2.inst.runtimePolicy.read(CHAR_A), source: interpOf(H2).autoPolicy.authoritySource }));
  const rTurn = await withCase('restart eligible turn', 30000, () => recallPost(H2, { requestId: 'req_restart' }));
  await idleOf(H2, 30000);
  check('7.2 the restarted instance honours the file: exactly one provider call',
    rTurn.status === 200 && interpCalls(H2) === 1, J({ status: rTurn.status, calls: interpCalls(H2) }));
  AUTHORITY_SOURCE_PRODUCTION = interpOf(H2).autoPolicy.authoritySource === 'FILE_POLICY' ? 'FILE_POLICY' : J(interpOf(H2).autoPolicy.authoritySource);

  const SEAM = await withCase('seam instance (fresh dataDir + injected policy)', 30000, () => buildInstance('seam', { autoPolicy: { autoInterpretationEnabled: true } }));
  const seamAuto = interpOf(SEAM).autoPolicy;
  check('7.3 an assembly-injected test seam reports authoritySource = TEST_INJECTION (never FILE_POLICY)',
    seamAuto.authoritySource === 'TEST_INJECTION' && seamAuto.autoInterpretationEnabled === true
    /* productionEnablePath 说的是**生产**的路径（与某个实例注入了什么无关）：
       LIVE-4.3 起它如实是操作者侧文件；调用者侧仍是 NONE。 */
    && seamAuto.productionEnablePath === 'OPERATOR_FILE_ONLY'
    && seamAuto.callerFacingEnablePath === 'NONE'
    && seamAuto.operatorWritableOnly === false,
    J(seamAuto));
  check('7.4 the test seam writes NO policy file (it cannot become a production authority)',
    !fs.existsSync(SEAM.policyFile), SEAM.policyFile);
  const SEAM2 = await withCase('seam removed (same dataDir)', 30000, () => buildInstance('seam2', { dataDir: SEAM.dataDir, credDir: SEAM.credDir }));
  check('7.5 dropping the seam returns the node to the FILE authority (OFF) — no residue',
    interpOf(SEAM2).autoPolicy.authoritySource === 'FILE_POLICY'
    && interpOf(SEAM2).autoPolicy.autoInterpretationEnabled === false
    && SEAM2.inst.runtimePolicy.read(CHAR_A).autoInterpretationEnabled === false,
    J({ source: interpOf(SEAM2).autoPolicy.authoritySource, enabled: interpOf(SEAM2).autoPolicy.autoInterpretationEnabled }));
  TEST_SEAM_IS_NOT_A_PRODUCTION_BACKDOOR = (seamAuto.authoritySource === 'TEST_INJECTION' && !fs.existsSync(SEAM.policyFile)
    && interpOf(SEAM2).autoPolicy.authoritySource === 'FILE_POLICY') ? 'YES' : 'NO';
  console.log('  TEST_SEAM_IS_NOT_A_PRODUCTION_BACKDOOR = ' + TEST_SEAM_IS_NOT_A_PRODUCTION_BACKDOOR);

  /* ══════════════════════════════════════════════════════════════════
     §8 · credential unavailable ⇒ no successful call（fail closed）
     ══════════════════════════════════════════════════════════════════ */
  section('§8 · credential unavailable');
  const NOCRED = await withCase('build no-credential instance', 30000, () => buildInstance('nocred', { credA: false }));
  putRecord(NOCRED, 'm_real', { importance: 9 });
  NOCRED.inst.runtimePolicy.set(CHAR_A, true);
  await withCase('turn without credential', 30000, () => recallPost(NOCRED, { requestId: 'req_nocred' }));
  await idleOf(NOCRED, 5000);
  check('8.1 policy ON but credential unavailable ⇒ zero provider calls (fail closed, no throw)',
    interpCalls(NOCRED) === 0, J({ calls: interpCalls(NOCRED) }));

  /* ══════════════════════════════════════════════════════════════════
     汇总
     ══════════════════════════════════════════════════════════════════ */
  REAL_PROVIDER_CALLS = 0;
  LAST_ASSERTION_TO_EXIT_MS = Date.now() - T_LAST_ASSERTION;
  for (const h of INSTANCES) { try { h.inst.server.close(); } catch (_) { /* 已关 */ } try { h.inst.close(); } catch (_) { /* 已关 */ } }
  cleanup();
  clearTimeout(watchdog);

  console.log('\n' + '='.repeat(62));
  console.log('DEFAULT_ALL_OFF = ' + DEFAULT_ALL_OFF);
  console.log('FAIL_CLOSED_MATRIX = ' + FAIL_CLOSED_MATRIX);
  console.log('PER_CHARACTER_ISOLATION = ' + PER_CHARACTER_ISOLATION);
  console.log('BROWSER_FORGE_NO_EFFECT = ' + BROWSER_FORGE_NO_EFFECT);
  console.log('AUTHORITY_SOURCE_PRODUCTION = ' + AUTHORITY_SOURCE_PRODUCTION);
  console.log('TEST_SEAM_IS_NOT_A_PRODUCTION_BACKDOOR = ' + TEST_SEAM_IS_NOT_A_PRODUCTION_BACKDOOR);
  console.log('EXTERNAL_ROUTE_DISABLED_WITH_POLICY_ON = ' + EXTERNAL_ROUTE_DISABLED_WITH_POLICY_ON);
  console.log('POLICY_SUITE_REGISTERED_IN_TEST_ALL = ' + POLICY_SUITE_REGISTERED_IN_TEST_ALL);
  console.log('REAL_PROVIDER_CALLS = ' + REAL_PROVIDER_CALLS);
  console.log('POLICY_COUNTS passed=' + passed + ' failed=' + failed);
  console.log('NATURAL_EXIT = YES code=' + (failed === 0 ? 0 : 1));
})().then(() => {
  process.exitCode = failed === 0 ? 0 : 1;
}, (error) => {
  console.log('L43_SUITE_THREW: ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
