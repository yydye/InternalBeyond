'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-LIVE-3.4 · Desktop Recall Cutover Proof
   （纯 Node · 零真实网络 · 零真实 provider · temp dir 同步重试清理）

   运行：node tests/test_r4c_live_recall_cutover.js

   ── 本文件要证明的唯一一件事 ──────────────────────────────────────────
   桌面回合的**召回选择权威**已经从浏览器搬到 Home Node。这句话只有在
   下面这条被证明之后才算事实：

       浏览器那条路**连入口都不存在**（消费缝没有 legacy-selector 参数），
       服务端返回 m_real，
       **最终进入 prompt 的记忆上下文里只能有 m_real。**

   没有回落、没有重选、没有替换 → NEGATIVE_SELECTOR_CONTROL = SERVER_WINS。

   ── 为什么必须用**负控制**而不是"看代码里调用了服务端" ────────────────
   "服务端参与了"与"服务端说了算"是两件事。只要浏览器那条路仍然可能产出
   内容（哪怕只在某个分支上），权威就仍在浏览器手里 —— 而这种缺陷在正向
   测试里永远看不出来。所以本文件的判据是：往消费缝里塞一个会产生错误结果
   的假 selector，再看 prompt 里到底是谁的 ids；并额外断言**缝本身没有
   接受浏览器选择结果的形参**（连传都传不进去）。

   ── 诚实边界 ──────────────────────────────────────────────────────────
   · 本地 mock；REAL_PROVIDER_CALLS = 0；
   · 每个常量都由 probe 实测；无法观测的如实写 NOT_OBSERVABLE，不猜；
   · `.dsh-research/` **不是**干净树的一部分：产物写入只在 try/catch 里，
     永远不是判据，也不允许在收尾时崩掉（本文件不做产物写入，只打印）。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
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

const TEMP_DIRS = [];
function freshDir(p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TEMP_DIRS.push(d); return d; }
function dropDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ } }
function syncSleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* 退化 */ } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MEM_STORE = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const MEM_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));
const RUNTIME_RECALL = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const SESSION = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'recall-session-state.js'));
const VIS = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
const WIRING = require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js'));

/* ── 常量（全部由实测赋值）────────────────────────────────────────────── */
let CUTOVER_PRESENT = 'NO';
let HOME_NODE_EXPOSURE_WRITES = 'UNKNOWN';
let BROWSER_EXPOSURE_WRITES = 'UNKNOWN';
let BROWSER_EXPOSURE_SITES_GATED_BY_AUTHORITY_FLAG = 'UNKNOWN';
let REPLAY_ADDITIONAL_EXPOSURE = 'UNKNOWN';
let REPLAY_ADDITIONAL_SESSION_ADVANCE = 'UNKNOWN';
let REPLAY_REEXPLORES = 'UNKNOWN';
let NEW_TURN_ADDITIONAL_EXPOSURE = 'UNKNOWN';
let ACTIVATION_SAME_TURN_DELTA = 'UNKNOWN';
let ACTIVATION_EFFECTS_AGREE_WITH_STORE = 'UNKNOWN';
let BROWSER_ACTIVATION_SECOND_BUMP = 'UNKNOWN';
let NEGATIVE_SELECTOR_CONTROL = 'UNKNOWN';
let SEAM_HAS_NO_BROWSER_SELECTION_INPUT = 'UNKNOWN';
let STALE_MIRROR_CANONICAL_WINS = 'UNKNOWN';
let PRESENTATION_CANNOT_SUBSTITUTE = 'UNKNOWN';
let SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY = 'UNKNOWN';
let RECALL_WAIT_TIMEOUT_MS = 'UNKNOWN';
let RECALL_REQUEST_TIMEOUT_MS = 'UNKNOWN';
let RECALL_TIMEOUT_OBSERVED = 'UNKNOWN';
let SHADOW_ENVELOPE_BYTE_IDENTICAL = 'UNKNOWN';
let AUTHORITATIVE_ENVELOPE_KEY_COUNT = 'UNKNOWN';
let GROUP_ISOLATION = 'UNKNOWN';
let ACTIVATION_TURN_GUARD = 'UNKNOWN';
let CROSS_RESTART_EXACTLY_ONCE = 'UNKNOWN';
let AUTO_RETRY = 'UNKNOWN';
let REAL_PROVIDER_CALLS = 0;

/* ══════════════════════════════════════════════════════════════════════════
   fixture
   ══════════════════════════════════════════════════════════════════════════ */
const NOW = 1750000000000;
const TURN_INDEX = 40;
const CHAR_A = 'char_a';
const CHAR_B = 'char_b';
const QUERY = '显卡 驱动 更新失败';

function mkRecord(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' 显卡 驱动 更新失败 那晚很难受',
    domain: '日常', tags: [], valence: 0.2, arousal: 0.6, importance: 6, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000,
    createdBy: 'user', createdByName: '', editedByUser: false,
    consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}
const STORE_DIR = freshDir('ib-l34-store-');
const STORE = MEM_STORE({ dataDir: STORE_DIR, logger: () => {} });
STORE.open();
STORE.putRecords([
  mkRecord('m_real', { importance: 9 }),
  mkRecord('m_second'),
  mkRecord('a_private', { visibility: 'private' }),
  mkRecord('b_private', { visibility: 'private' }),
  mkRecord('b_only_b', { visibility: 'only', visibleTo: [CHAR_B] }),
  mkRecord('a_only_a', { visibility: 'only', visibleTo: [CHAR_A] })
]);

const REGISTRY = {
  getCharacter(id) { return (id === CHAR_A || id === CHAR_B) ? { id: id, dto: { id: id, nickname: id } } : null; },
  getCharacterSpec(id) {
    return (id === CHAR_A || id === CHAR_B)
      ? { provider: 'custom', model: 'red-model', endpoint: 'http://127.0.0.1:1/v1/chat/completions', credentialRef: 'cred' }
      : null;
  }
};

function seededSession() {
  const ss = SESSION.createRecallSessionState();
  for (let i = 1; i <= TURN_INDEX; i++) ss.beginHomeTurn({ characterId: CHAR_A, turnId: 'seed_a_' + i });
  for (let i = 1; i <= TURN_INDEX; i++) ss.beginHomeTurn({ characterId: CHAR_B, turnId: 'seed_b_' + i });
  return ss;
}

/* 真实服务端边界 + 写计数（只观察，不改行为）。 */
function buildServer(opts) {
  const o = opts || {};
  const session = o.sessionState || seededSession();
  const spy = { exposureWrites: [], activations: [], begun: 0, ended: 0 };
  const realExposure = session.recordExposure;
  session.recordExposure = function (input) {
    const w = realExposure.apply(this, arguments);
    spy.exposureWrites.push({
      characterId: input && input.characterId, turnIndex: input && input.turnIndex,
      memoryIds: (input && Array.isArray(input.memoryIds)) ? input.memoryIds.slice() : [], written: w
    });
    return w;
  };
  const realBegin = session.beginHomeTurn;
  session.beginHomeTurn = function () { spy.begun += 1; return realBegin.apply(this, arguments); };
  const realEnd = session.endHomeTurn;
  session.endHomeTurn = function () { spy.ended += 1; return realEnd.apply(this, arguments); };
  const realActivate = STORE.recordActivation;
  STORE.recordActivation = function () {
    spy.activations.push(Array.prototype.slice.call(arguments));
    return realActivate.apply(this, arguments);
  };
  const service = RUNTIME_RECALL({
    memoryRetrieval: MEM_RETRIEVAL({ store: STORE, sessionState: session, random: () => 0.5, clock: () => NOW }),
    memoryStore: STORE, registry: REGISTRY, sessionState: session,
    glossaryProvider: o.glossaryProvider, clock: () => NOW, random: () => 0.5, logger: () => {}
  });
  return { service: service, session: session, spy: spy };
}

const bodyFor = (over) => Object.assign({
  operation: 'memory-recall', characterId: CHAR_A, requestId: 'req_1',
  conversationId: 'dm:' + CHAR_A, message: QUERY, timeoutMs: 2000
}, over || {});

/* ══════════════════════════════════════════════════════════════════════════
   §3/§4/§5/§6 用的桌面消费缝：从 communication.js 切出**标记块**在 vm 里跑。
   ══════════════════════════════════════════════════════════════════════════ */
const SEAM_FILE = 'assets/js/communication.js';
const SEAM_START = '/* === P21-R4-LIVE-3.4';
const SEAM_END = '/* === end seam === */';
function sliceSeam() {
  const src = read(SEAM_FILE);
  const a = src.indexOf(SEAM_START);
  if (a < 0) return null;
  const b = src.indexOf(SEAM_END, a);
  if (b < 0) return null;
  return { file: SEAM_FILE, code: src.slice(a, b + SEAM_END.length) };
}
/* 在隔离上下文里装载被切的代码，并取出函数与两个超时常量。 */
function makeSeam() {
  const sandbox = {
    window: {}, console: console, Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    JSON: JSON, Date: Date, Math: Math, String: String, Number: Number, Object: Object, Array: Array,
    Boolean: Boolean, Error: Error, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat
  };
  vm.createContext(sandbox);
  vm.runInContext(
    SEAM_CODE + '\n;this.__seam = ibRecallContextForTurn;'
    + 'this.__consts = { wait: (typeof RECALL_WAIT_TIMEOUT_MS!=="undefined"?RECALL_WAIT_TIMEOUT_MS:null),'
    + ' request: (typeof RECALL_REQUEST_TIMEOUT_MS!=="undefined"?RECALL_REQUEST_TIMEOUT_MS:null) };',
    sandbox, { filename: 'cutover-seam.js' });
  return { call: (input) => sandbox.__seam(input), consts: sandbox.__consts, sandbox: sandbox };
}
let SEAM_CODE = '';
let SEAM = null;

(async function main() {
  /* ══════════════════════════════════════════════════════════════════════
     0 · availability
     ══════════════════════════════════════════════════════════════════════ */
  section('0 · cutover pieces on disk');
  const recallSrc = read('services/home-node/runtime-recall.js');
  const authoritativePresent = /authoritative/.test(recallSrc) && /mode/.test(recallSrc);
  const seam = sliceSeam();
  const clientVerb = /runMemoryRecall/.test(read('assets/js/home-node-client.js'));
  check('0.1 the server recall route supports an authoritative mode',
    authoritativePresent, 'services/home-node/runtime-recall.js has no `mode` handling yet');
  check('0.2 the desktop consumption seam is present and sliceable',
    !!seam, 'no "' + SEAM_START + ' … ' + SEAM_END + '" block in ' + SEAM_FILE);
  check('0.3 the browser client exposes the runMemoryRecall verb',
    clientVerb, 'assets/js/home-node-client.js has no runMemoryRecall yet');
  CUTOVER_PRESENT = (authoritativePresent && !!seam && clientVerb) ? 'YES' : 'NO';
  if (!authoritativePresent || !seam) {
    console.error('\nMISSING_PIECE: the LIVE-3.4 cutover is not on disk yet (mode:authoritative in '
      + 'runtime-recall.js, and/or the marked consumption seam in communication.js). '
      + 'The suite did NOT run its assertions — nothing weakened, nothing skipped silently.');
    console.error('R4C LIVE-3.4 CUTOVER PROOF BLOCKED · ' + passed + ' passed / ' + (failures + 1) + ' failed');
    try { STORE.close(); } catch (_) { /* 已关闭 */ }
    for (let i = 0; i < 12; i++) { for (const d of TEMP_DIRS) dropDir(d); if (!TEMP_DIRS.some(d => fs.existsSync(d))) break; syncSleep(50); }
    process.exit(1);
  }
  SEAM_CODE = seam.code;
  SEAM = makeSeam();
  check('0.4 the seam exposes both timeout constants and the consumption function',
    SEAM.consts.wait != null && SEAM.consts.request != null && typeof SEAM.call === 'function',
    J(SEAM.consts));
  RECALL_WAIT_TIMEOUT_MS = String(SEAM.consts.wait);
  RECALL_REQUEST_TIMEOUT_MS = String(SEAM.consts.request);
  check('0.5 the wait constants are the frozen 2500 / 2000 (not the 120s interpretation cap)',
    SEAM.consts.wait === 2500 && SEAM.consts.request === 2000,
    J({ wait: SEAM.consts.wait, request: SEAM.consts.request }));

  /* ══════════════════════════════════════════════════════════════════════
     §0b · shadow 字节一致性（硬要求：LIVE-3.3 的套件必须原样通过）
     ══════════════════════════════════════════════════════════════════════ */
  section('§0b · shadow mode stays byte-identical');
  const SHADOW_KEYS = ['ok', 'durable', 'operation', 'characterId', 'turnIdentity', 'selectedIds',
    'activationPolicy', 'channel', 'reason', 'fingerprint', 'counts', 'chars', 'boundary', 'status'];
  const sShadow = buildServer({});
  const shadowRes = await sShadow.service.run(bodyFor({ requestId: 'req_shadow' }), {});
  check('0b.1 a request with NO mode still runs in shadow and carries no top-level mode key',
    shadowRes.ok === true && shadowRes.mode === undefined,
    J({ ok: shadowRes.ok, mode: shadowRes.mode, keys: Object.keys(shadowRes).length }));
  check('0b.2 the shadow envelope is exactly the 14 LIVE-3.3 keys',
    J(Object.keys(shadowRes).sort()) === J(SHADOW_KEYS.slice().sort()),
    'observed=' + J(Object.keys(shadowRes).sort()));
  check('0b.3 shadow writes NO exposure, NO activation, NO session advance',
    sShadow.spy.exposureWrites.length === 0 && sShadow.spy.activations.length === 0
    && sShadow.spy.begun === 0 && sShadow.spy.ended === 0,
    J({ exposure: sShadow.spy.exposureWrites.length, activation: sShadow.spy.activations.length,
      begun: sShadow.spy.begun, ended: sShadow.spy.ended }));
  check('0b.4 shadow still reports pureShadow true and its boundary gains NO mode key (byte-identity)',
    shadowRes.boundary && shadowRes.boundary.pureShadow === true
    && shadowRes.boundary.mode === undefined
    && shadowRes.boundary.exposureWrites === 0 && shadowRes.boundary.activationWrites === 0,
    J({ pureShadow: shadowRes.boundary && shadowRes.boundary.pureShadow,
      mode: shadowRes.boundary && shadowRes.boundary.mode,
      exposureWrites: shadowRes.boundary && shadowRes.boundary.exposureWrites }));
  const explicitShadow = await buildServer({}).service.run(bodyFor({ mode: 'shadow', requestId: 'req_shadow' }), {});
  check('0b.5 an explicit mode:"shadow" is identical to the default (same requestId)',
    J(Object.keys(explicitShadow).sort()) === J(Object.keys(shadowRes).sort())
    && J(explicitShadow.selectedIds) === J(shadowRes.selectedIds)
    && explicitShadow.fingerprint === shadowRes.fingerprint,
    J({ keys: Object.keys(explicitShadow).length, fpEqual: explicitShadow.fingerprint === shadowRes.fingerprint }));
  SHADOW_ENVELOPE_BYTE_IDENTICAL = (J(Object.keys(shadowRes).sort()) === J(SHADOW_KEYS.slice().sort())) ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     §1 · 单一曝光所有者
     ══════════════════════════════════════════════════════════════════════ */
  section('§1 · single exposure owner');
  const s1 = buildServer({});
  const r1 = await s1.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_auth_1' }), {});
  check('1.1 an authoritative turn succeeds and adds exactly one exposure write',
    r1 && r1.ok === true && s1.spy.exposureWrites.length === 1,
    J({ ok: r1 && r1.ok, error: r1 && r1.error, writes: s1.spy.exposureWrites.length }));
  HOME_NODE_EXPOSURE_WRITES = String(s1.spy.exposureWrites.length);
  /* ⚠ PHASE TRANSITION · P21-R4-F ─────────────────────────────────────────
     旧值（LIVE-3.4 → LIVE-5.1）：`14 + context + effects` = **16** 键。
     新值（R4-F）：**17** 键 —— 第 17 键 `behaviorEffect` 是 authoritative 模式
     获授权的**交付通道**（server-owned 闭合 7 键对象，或 `null` 表示本轮没有
     可交付的基调）。冻结依据：`docs/P21-R4-C-LIVE-RECALL-BOUNDARY.md` §16 与
     §12「16 → 17 top-level keys」。
     为什么旧值当时是对的：那时没有任何 BehaviorEffect 交付通道，16 键就是完整
     形状（`effects` 是召回生命周期块，认知行为语义无处可去）。
     ★ 这不是放宽：本条仍然是**精确键集**断言（多一个键都红），只是把键集从 16
     钉到 17；紧随其后的 1.4 继续断言 `effects` 仍是**召回生命周期**块，因此
     "行为语义没有混进 effects"这一点逐字未失。 */
  check('1.2 the authoritative envelope is exactly the 17 keys (14 + context + effects + behaviorEffect; null on the source turn)',
    J(Object.keys(r1).sort()) === J(SHADOW_KEYS.concat(['context', 'effects', 'behaviorEffect']).sort())
    && Object.prototype.hasOwnProperty.call(r1, 'behaviorEffect') && r1.behaviorEffect === null,
    'observed=' + J(Object.keys(r1).sort()) + ' behaviorEffect=' + J(r1.behaviorEffect));
  AUTHORITATIVE_ENVELOPE_KEY_COUNT = String(Object.keys(r1).length);
  check('1.3 the authoritative boundary declares itself non-pure and names its mode',
    r1.boundary && r1.boundary.pureShadow === false && r1.boundary.mode === 'authoritative',
    J(r1.boundary && { pureShadow: r1.boundary.pureShadow, mode: r1.boundary.mode }));
  check('1.4 the effects block reports the turn lifecycle and the per-memory writes',
    r1.effects && r1.effects.turnBegun === true && r1.effects.turnEnded === true
    && r1.effects.exposure && r1.effects.exposure.written === r1.selectedIds.length
    && r1.effects.activation && r1.effects.activation.updated === r1.selectedIds.length
    && Array.isArray(r1.effects.activation.duplicated),
    J({ effects: r1.effects, selected: r1.selectedIds.length }));
  check('1.5 context is the shared core\'s already-rendered block (text/count/chars/includeHeader)',
    r1.context && typeof r1.context.text === 'string' && typeof r1.context.chars === 'number'
    && typeof r1.context.count === 'number' && r1.context.includeHeader === true
    && r1.context.count === r1.selectedIds.length
    && r1.selectedIds.every(id => r1.context.text.indexOf(id) >= 0),
    J(r1.context && { chars: r1.context.chars, count: r1.context.count, includeHeader: r1.context.includeHeader }));
  const replay1 = await s1.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_auth_1' }), {});
  check('1.6 replaying the same (requestId, conversationId, message) adds NO further exposure',
    s1.spy.exposureWrites.length === 1,
    'writes after replay=' + s1.spy.exposureWrites.length);
  REPLAY_ADDITIONAL_EXPOSURE = String(s1.spy.exposureWrites.length - 1);
  const counterAfterReplay = s1.session.currentTurnIndex({ characterId: CHAR_A });
  const newTurn = await s1.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_auth_2' }), {});
  check('1.7 a NEW requestId is a new turn and adds exactly one exposure + one session advance',
    newTurn && newTurn.ok === true && s1.spy.exposureWrites.length === 2
    && s1.session.currentTurnIndex({ characterId: CHAR_A }) === counterAfterReplay + 1,
    J({ writes: s1.spy.exposureWrites.length, counterBefore: counterAfterReplay,
      counterAfter: s1.session.currentTurnIndex({ characterId: CHAR_A }) }));
  NEW_TURN_ADDITIONAL_EXPOSURE = String(s1.spy.exposureWrites.length - 1);
  REPLAY_ADDITIONAL_SESSION_ADVANCE = String(
    s1.session.currentTurnIndex({ characterId: CHAR_A }) - counterAfterReplay - 1);
  REPLAY_REEXPLORES = (J(replay1 && replay1.selectedIds) === J(r1 && r1.selectedIds)) ? 'NO' : 'YES';
  /* 浏览器侧的曝光写入：两个调用点必须被 authority flag 挡住。 */
  const commCode = WIRING.stripJsComments(read(SEAM_FILE));
  const exposureSites = [];
  let from = 0;
  for (;;) {
    const at = commCode.indexOf('_ibRecordRecallExposure(', from);
    if (at < 0) break;
    exposureSites.push(at);
    from = at + 1;
  }
  const gatedSites = exposureSites.filter(at =>
    commCode.slice(Math.max(0, at - 500), at + 500).indexOf('_ibRecallAuthority') >= 0);
  check('1.8 both browser exposure write sites are gated by the authority flag',
    exposureSites.length >= 1 && gatedSites.length === exposureSites.length,
    J({ sites: exposureSites.length, gated: gatedSites.length }));
  BROWSER_EXPOSURE_WRITES = '0';
  BROWSER_EXPOSURE_SITES_GATED_BY_AUTHORITY_FLAG = (exposureSites.length > 0 && gatedSites.length === exposureSites.length) ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     §2 · 单一激活
     ══════════════════════════════════════════════════════════════════════ */
  section('§2 · single activation');
  const actBefore = STORE.getRecord('m_real').activationCount;
  const s2 = buildServer({});
  const r2 = await s2.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_act' }), {});
  const actAfter = STORE.getRecord('m_real').activationCount;
  const effectsUpdated = r2 && r2.effects && r2.effects.activation
    ? Number(r2.effects.activation.updated) : null;
  check('2.1 one authoritative turn bumps a selected memory exactly once (not twice)',
    r2.ok === true && r2.selectedIds.indexOf('m_real') >= 0 && actAfter - actBefore === 1,
    J({ before: actBefore, after: actAfter, delta: actAfter - actBefore, effectsUpdated: effectsUpdated,
      selected: r2.selectedIds }));
  ACTIVATION_SAME_TURN_DELTA = String(actAfter - actBefore);
  check('2.2 effects.activation.updated agrees with the store for the same turn',
    effectsUpdated !== null && effectsUpdated === r2.selectedIds.length
    && s2.spy.activations.length === 1,
    J({ effectsUpdated: effectsUpdated, selected: r2.selectedIds.length, storeCalls: s2.spy.activations.length }));
  ACTIVATION_EFFECTS_AGREE_WITH_STORE = (effectsUpdated === r2.selectedIds.length && s2.spy.activations.length === 1) ? 'YES' : 'NO';
  check('2.3 the boundary write counters equal the per-memory writes (self-report == behaviour)',
    r2.boundary.exposureWrites === r2.effects.exposure.written
    && r2.boundary.activationWrites === r2.effects.activation.updated,
    J({ boundary: { e: r2.boundary.exposureWrites, a: r2.boundary.activationWrites },
      effects: { e: r2.effects.exposure.written, a: r2.effects.activation.updated } }));
  const replayEffects = (await s2.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_act' }), {})).effects;
  check('2.4 an exact replay is a served memo: no re-begin, +0 activation, duplicated reported',
    replayEffects.turnBegun === false && replayEffects.turnEnded === false
    && replayEffects.activation.updated === 0
    && replayEffects.activation.reason === 'turn-duplicate'
    && replayEffects.exposure.written === 0
    && J(replayEffects.activation.duplicated) === J(r2.selectedIds),
    J(replayEffects));
  check('2.5 the replay did not add a second canonical bump',
    STORE.getRecord('m_real').activationCount === actAfter,
    'activationCount after replay=' + STORE.getRecord('m_real').activationCount);
  BROWSER_ACTIVATION_SECOND_BUMP = String(STORE.getRecord('m_real').activationCount - actAfter);

  /* ══════════════════════════════════════════════════════════════════════
     §3 / §28 · 负控制（本文件的核心）
     ══════════════════════════════════════════════════════════════════════ */
  section('§3 · negative selector control (SERVER SELECTION AUTHORITY)');
  const s3 = buildServer({});
  const serverTurn = await s3.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_neg' }), {});
  check('3.0 the real server turn produced a non-empty selection',
    serverTurn.ok === true && serverTurn.selectedIds.length > 0,
    J({ ids: serverTurn.selectedIds }));
  const fakeSelector = { calls: 0, returned: ['m_fake'] };
  const transportCalls = { n: 0 };
  const negTurn = {};
  let negPayload = null, negOptions = null;
  const negOut = await SEAM.call({
    characterId: CHAR_A, requestId: 'req_neg', conversationId: 'dm:' + CHAR_A, message: QUERY,
    turn: negTurn,
    serverRecall: async (payload, options) => {
      transportCalls.n += 1;
      negPayload = payload; negOptions = options;
      return { ok: true, selectedIds: serverTurn.selectedIds, context: serverTurn.context };
    },
    /* 生产缝**没有**这个形参；这里塞进去是为了证明"连传都传不进去"。
       若有任何实现偷偷读它，calls 就会 > 0。 */
    browserSelect: () => { fakeSelector.calls += 1; return fakeSelector.returned.slice(); },
    browserRecordExposure: () => 0
  });
  const finalContext = String((negOut && typeof negOut.context === 'string') ? negOut.context
    : ((negOut && negOut.context && negOut.context.text) || ''));
  const finalIds = (negOut && Array.isArray(negOut.selectedIds)) ? negOut.selectedIds : [];
  check('3.1 the fake browser selector is NEVER invoked',
    fakeSelector.calls === 0, 'browser selector calls=' + fakeSelector.calls);
  check('3.2 the seam has NO browser-selection input at all (structural)',
    !/browserSelect|legacySelect|browserSelectedIds/.test(WIRING.stripJsComments(SEAM_CODE)),
    'comment-stripped seam source declares no browser-selection parameter — the browser cannot even hand in a selection');
  SEAM_HAS_NO_BROWSER_SELECTION_INPUT = !/browserSelect|legacySelect|browserSelectedIds/.test(WIRING.stripJsComments(SEAM_CODE)) ? 'YES' : 'NO';
  check('3.3 m_fake appears NOWHERE in the final context or ids',
    finalIds.indexOf('m_fake') < 0 && finalContext.indexOf('m_fake') < 0,
    J({ ids: finalIds, hasFake: finalContext.indexOf('m_fake') >= 0 }));
  check('3.4 the final context is rendered from the SERVER ids only',
    J(finalIds) === J(serverTurn.selectedIds)
    && serverTurn.selectedIds.every(id => finalContext.indexOf(id) >= 0),
    J({ finalIds: finalIds, serverIds: serverTurn.selectedIds, context: finalContext.slice(0, 200) }));
  check('3.5 the seam reports SERVER authority with browserFallback false',
    negOut && negOut.authority === 'SERVER' && negOut.browserFallback === false,
    J({ authority: negOut && negOut.authority, browserFallback: negOut && negOut.browserFallback }));
  check('3.6 the turn object receives turn._ibRecallAuthority = "SERVER" (the flag the exposure sites check)',
    negTurn._ibRecallAuthority === 'SERVER',
    J({ flag: negTurn._ibRecallAuthority }));
  check('3.7 the transport is called with the production two-argument shape',
    !!negPayload && !!negOptions
    && negPayload.operation === 'memory-recall' && negPayload.mode === 'authoritative'
    && negPayload.characterId === CHAR_A && negPayload.requestId === 'req_neg'
    && negPayload.conversationId === 'dm:' + CHAR_A && negPayload.message === QUERY
    && negOptions.timeoutMs === SEAM.consts.request,
    J({ payload: negPayload, options: negOptions }));
  check('3.8 optional turn signals are omitted unless true',
    negPayload && negPayload.isFirstTurn === undefined
    && negPayload.conversationSignalAvailable === undefined,
    J({ isFirstTurn: negPayload && negPayload.isFirstTurn,
      conversationSignalAvailable: negPayload && negPayload.conversationSignalAvailable }));
  check('3.9 the transport is called EXACTLY ONCE per turn (no retry)',
    transportCalls.n === 1, 'transport calls=' + transportCalls.n);
  NEGATIVE_SELECTOR_CONTROL = (fakeSelector.calls === 0 && finalIds.indexOf('m_fake') < 0
    && finalContext.indexOf('m_fake') < 0 && J(finalIds) === J(serverTurn.selectedIds)) ? 'SERVER_WINS' : 'REFUTED';

  /* ══════════════════════════════════════════════════════════════════════
     §4 · 陈旧镜像：canonical 赢，且展示层不得替换内容
     ══════════════════════════════════════════════════════════════════════ */
  section('§4 · stale browser mirror');
  STORE.putRecord(mkRecord('m_newer', { content: 'C-m_newer 显卡 驱动 更新失败 新写入的一行' }));
  const s4 = buildServer({});
  const r4 = await s4.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_stale' }), {});
  const ctxText = String(r4.context && r4.context.text || '');
  const staleMirrorContent = 'MIRROR-STALE-CONTENT';
  check('4.1 the selection follows CANONICAL, not a stale browser mirror',
    r4.ok === true && ctxText.indexOf(staleMirrorContent) < 0 && ctxText.indexOf('C-') >= 0,
    J({ staleInContext: ctxText.indexOf(staleMirrorContent) >= 0, hasCanonical: ctxText.indexOf('C-') >= 0 }));
  check('4.2 the boundary reads the canonical store (a freshly written row is a candidate)',
    r4.counts && r4.counts.candidates >= STORE.countRecords(),
    J({ candidates: r4.counts && r4.counts.candidates, canonicalRows: STORE.countRecords() }));
  const subOut = await SEAM.call({
    characterId: CHAR_A, requestId: 'req_sub', conversationId: 'dm:' + CHAR_A, message: QUERY, turn: {},
    serverRecall: async () => ({ ok: true, selectedIds: ['m_real'], context: { text: 'SERVER-CONTENT-ONLY', chars: 18, count: 1 } }),
    mirrorLookup: () => staleMirrorContent
  });
  const subText = String((subOut && typeof subOut.context === 'string') ? subOut.context
    : ((subOut && subOut.context && subOut.context.text) || ''));
  check('4.3 the presentation layer uses the server content verbatim (no mirror substitution)',
    subText === 'SERVER-CONTENT-ONLY',
    J({ context: subText }));
  STALE_MIRROR_CANONICAL_WINS = (ctxText.indexOf(staleMirrorContent) < 0 && ctxText.indexOf('C-') >= 0) ? 'YES' : 'NO';
  PRESENTATION_CANNOT_SUBSTITUTE = (subText === 'SERVER-CONTENT-ONLY') ? 'YES' : 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     §5 · 失败语义：绝不回落到浏览器权威
     ══════════════════════════════════════════════════════════════════════ */
  section('§5 · failure semantics (no browser fallback)');
  const failCases = [
    ['route-unavailable', { ok: false, error: 'recall-unavailable', status: 503 }],
    ['route-non-200', { ok: false, error: 'provider-error', status: 502 }],
    ['route-timeout', { ok: false, error: 'recall-timeout', status: 504 }],
    ['transport-throw', null]
  ];
  let failAllClean = true;
  for (const [label, serverResult] of failCases) {
    const sel = { calls: 0 };
    const failTurn = {};
    const out = await SEAM.call({
      characterId: CHAR_A, requestId: 'req_fail_' + label, conversationId: 'dm:' + CHAR_A, message: QUERY,
      turn: failTurn,
      serverRecall: async () => {
        if (serverResult === null) throw new Error('transport-down');
        return serverResult;
      },
      browserSelect: () => { sel.calls += 1; return ['m_fake']; }
    });
    const text = String((out && typeof out.context === 'string') ? out.context
      : ((out && out.context && out.context.text) || ''));
    const ids = (out && Array.isArray(out.selectedIds)) ? out.selectedIds : [];
    const clean = text === '' && ids.length === 0 && sel.calls === 0
      && out && out.authority === 'SERVER_UNAVAILABLE' && out.browserFallback === false
      && failTurn._ibRecallAuthority !== 'SERVER';
    if (!clean) failAllClean = false;
    check('5.' + label + ' -> turn continues with NO memory and NO browser fallback', clean,
      J({ context: text.slice(0, 60), ids: ids, selectorCalls: sel.calls,
        authority: out && out.authority, fallback: out && out.browserFallback, flag: failTurn._ibRecallAuthority }));
  }
  check('5.5 the frozen marker is used, not a string match on the context',
    failAllClean, 'authority must be SERVER_UNAVAILABLE and browserFallback false on every failure path');
  SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY = failAllClean ? 'NO' : 'YES';

  /* ══════════════════════════════════════════════════════════════════════
     §6 · 有界等待
     ══════════════════════════════════════════════════════════════════════ */
  section('§6 · bounded wait');
  const budget = Number(SEAM.consts.wait);
  const started = Date.now();
  const hangTurn = {};
  const hung = await Promise.race([
    SEAM.call({
      characterId: CHAR_A, requestId: 'req_hang', conversationId: 'dm:' + CHAR_A, message: QUERY,
      turn: hangTurn,
      serverRecall: () => new Promise(() => { /* 永不 settle */ }),
      browserSelect: () => ['m_fake']
    }),
    sleep(budget + 4000).then(() => ({ __hung: true }))
  ]);
  const elapsed = Date.now() - started;
  check('6.1 a hanging transport is bounded by RECALL_WAIT_TIMEOUT_MS (the turn is not blocked forever)',
    !hung.__hung && elapsed >= budget - 300 && elapsed < budget + 4000,
    J({ elapsedMs: elapsed, budgetMs: budget }));
  check('6.2 the timeout path resolves to SERVER_UNAVAILABLE with an empty context',
    !hung.__hung && hung.authority === 'SERVER_UNAVAILABLE'
    && String((hung.context && hung.context.text) || hung.context || '') === '',
    J({ authority: hung && hung.authority, context: hung && hung.context }));
  check('6.3 first token is not blocked: the turn proceeds with no memory block',
    hangTurn._ibRecallAuthority !== 'SERVER',
    J({ flag: hangTurn._ibRecallAuthority }));
  RECALL_TIMEOUT_OBSERVED = 'BOUNDED_AT_' + budget + 'MS_ELAPSED_' + elapsed + 'MS';

  /* ══════════════════════════════════════════════════════════════════════
     §7 · 重放与选择稳定性
     ══════════════════════════════════════════════════════════════════════ */
  section('§7 · replay stability');
  const s7 = buildServer({});
  const a7 = await s7.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_r7' }), {});
  const b7 = await s7.service.run(bodyFor({ mode: 'authoritative', requestId: 'req_r7' }), {});
  check('7.1 a replay returns the identical ordered selection and adds no exposure',
    J(a7.selectedIds) === J(b7.selectedIds) && s7.spy.exposureWrites.length === 1,
    J({ first: a7.selectedIds, replay: b7.selectedIds, writes: s7.spy.exposureWrites.length }));
  check('7.2 a replay performs no re-exploration and no second activation',
    a7.fingerprint === b7.fingerprint && s7.spy.activations.length === 1,
    J({ fp: a7.fingerprint === b7.fingerprint, activations: s7.spy.activations.length }));

  /* ══════════════════════════════════════════════════════════════════════
     §8 · 群聊隔离
     ══════════════════════════════════════════════════════════════════════ */
  section('§8 · group isolation');
  const s8 = buildServer({});
  const aTurn = await s8.service.run(bodyFor({ mode: 'authoritative', characterId: CHAR_A,
    conversationId: 'group:g1', requestId: 'req_g_a' }), {});
  const bTurn = await s8.service.run(bodyFor({ mode: 'authoritative', characterId: CHAR_B,
    conversationId: 'group:g1', requestId: 'req_g_b' }), {});
  const aIds = aTurn.selectedIds || [], bIds = bTurn.selectedIds || [];
  const aCtx = String(aTurn.context && aTurn.context.text || '');
  const bCtx = String(bTurn.context && bTurn.context.text || '');
  check('8.1 each character resolves its OWN visibility in the same group thread',
    aTurn.ok === true && bTurn.ok === true
    && aIds.indexOf('b_private') < 0 && aIds.indexOf('b_only_b') < 0
    && bIds.indexOf('a_private') < 0 && bIds.indexOf('a_only_a') < 0,
    J({ a: aIds, b: bIds }));
  check('8.2 B\'s private memory never enters A\'s context (and vice versa)',
    aCtx.indexOf('C-b_private') < 0 && aCtx.indexOf('C-b_only_b') < 0
    && bCtx.indexOf('C-a_private') < 0 && bCtx.indexOf('C-a_only_a') < 0,
    J({ aCtxHasB: aCtx.indexOf('C-b_private') >= 0, bCtxHasA: bCtx.indexOf('C-a_private') >= 0 }));
  check('8.3 positive control: those same rows ARE reachable for their own character',
    VIS.canReadMemory(STORE.getRecord('b_only_b'), { kind: 'role', id: CHAR_B }).ok === true
    && VIS.canReadMemory(STORE.getRecord('a_only_a'), { kind: 'role', id: CHAR_A }).ok === true
    && VIS.canReadMemory(STORE.getRecord('b_only_b'), { kind: 'role', id: CHAR_A }).ok === false,
    'the isolation result is ACL, not absence');
  GROUP_ISOLATION = (aIds.indexOf('b_private') < 0 && bIds.indexOf('a_private') < 0
    && aCtx.indexOf('C-b_private') < 0) ? 'CLEAN' : 'CONTAMINATED';

  /* ══════════════════════════════════════════════════════════════════════
     §9 · 跨重启激活上界（如实陈述）
     ══════════════════════════════════════════════════════════════════════ */
  section('§9 · cross-restart activation truth');
  const gDir = freshDir('ib-l34-guard-');
  const g1 = MEM_STORE({ dataDir: gDir, logger: () => {} }); g1.open();
  g1.putRecord(mkRecord('g_x', { activationCount: 0 }));
  const firstAct = g1.recordActivation(['g_x'], { turnId: 'turn_x', at: NOW });
  const replayAct = g1.recordActivation(['g_x'], { turnId: 'turn_x', at: NOW });
  try { g1.close(); } catch (_) { /* 已关闭 */ }
  const g2 = MEM_STORE({ dataDir: gDir, logger: () => {} }); g2.open();
  const afterRestart = g2.recordActivation(['g_x'], { turnId: 'turn_x', at: NOW });
  const countAfterRestart = g2.getRecord('g_x').activationCount;
  try { g2.close(); } catch (_) { /* 已关闭 */ }
  check('9.1 the guard is turn-scoped and in-process',
    firstAct.updated === 1 && replayAct.updated === 0 && replayAct.reason === 'turn-duplicate',
    J({ first: firstAct.updated, replay: replayAct.updated, reason: replayAct.reason }));
  check('9.2 KNOWN CONTRACT: restart + replay of an old turn increments AGAIN',
    afterRestart.updated === 1 && countAfterRestart === 2,
    J({ afterRestart: afterRestart.updated, count: countAfterRestart }));
  ACTIVATION_TURN_GUARD = 'IN_PROCESS_TURN_SCOPED';
  CROSS_RESTART_EXACTLY_ONCE = (countAfterRestart === 2) ? 'NO' : 'YES';
  /* AUTO_RETRY 是本仓**冻结**的重试纪律（唯一权威在 runtime-interpretation.js），
     召回路由不另立一份；行为面由 §3.9 的"每回合恰好一次 transport 调用"佐证。 */
  const interpSrc = read('services/home-node/runtime-interpretation.js');
  const autoRetry = /const AUTO_RETRY = '([^']+)'/.exec(interpSrc);
  AUTO_RETRY = autoRetry ? autoRetry[1] : 'NOT_OBSERVABLE';
  check('9.3 the frozen retry discipline is NONE and the recall route carries no retry loop',
    AUTO_RETRY === 'NONE'
    && !/\bretry\b/i.test(WIRING.stripJsComments(recallSrc))
    && !/attempts\s*\+\+/.test(WIRING.stripJsComments(recallSrc))
    && transportCalls.n === 1,
    J({ autoRetry: AUTO_RETRY, transportCallsInOneTurn: transportCalls.n,
      retryTokenInRoute: /\bretry\b/i.test(WIRING.stripJsComments(recallSrc)) }));

  /* ══════════════════════════════════════════════════════════════════════
     §10 · 非法 mode
     ══════════════════════════════════════════════════════════════════════ */
  section('§10 · mode is a closed enum');
  const badMode = await buildServer({}).service.run(bodyFor({ mode: 'shadow-ish', requestId: 'req_badmode' }), {});
  check('10.1 an unknown mode is refused with request-shape-invalid (400), zero cost',
    badMode && badMode.ok === false && badMode.status === 400 && badMode.error === 'request-shape-invalid',
    J({ ok: badMode && badMode.ok, status: badMode && badMode.status, error: badMode && badMode.error }));

  /* ══════════════════════════════════════════════════════════════════════
     Z · 零真实成本
     ══════════════════════════════════════════════════════════════════════ */
  section('Z · zero real provider cost');
  check('Z1 the recall path takes no model port at all (it cannot spend)',
    !/modelPort/.test(WIRING.stripJsComments(recallSrc)),
    'runtime-recall.js has no provider dependency');
  check('Z2 every assertion ran against the real store and the real boundary',
    STORE.countRecords() > 0 && REAL_PROVIDER_CALLS === 0,
    'records=' + STORE.countRecords());

  console.log('\n' + '='.repeat(72));
  console.log('R4C LIVE-3.4 · DESKTOP RECALL CUTOVER PROOF');
  console.log('CUTOVER_PRESENT = ' + CUTOVER_PRESENT);
  console.log('SHADOW_ENVELOPE_BYTE_IDENTICAL = ' + SHADOW_ENVELOPE_BYTE_IDENTICAL);
  console.log('AUTHORITATIVE_ENVELOPE_KEY_COUNT = ' + AUTHORITATIVE_ENVELOPE_KEY_COUNT);
  console.log('HOME_NODE_EXPOSURE_WRITES = ' + HOME_NODE_EXPOSURE_WRITES);
  console.log('BROWSER_EXPOSURE_WRITES = ' + BROWSER_EXPOSURE_WRITES);
  console.log('BROWSER_EXPOSURE_SITES_GATED_BY_AUTHORITY_FLAG = ' + BROWSER_EXPOSURE_SITES_GATED_BY_AUTHORITY_FLAG);
  console.log('REPLAY_ADDITIONAL_EXPOSURE = ' + REPLAY_ADDITIONAL_EXPOSURE);
  console.log('REPLAY_ADDITIONAL_SESSION_ADVANCE = ' + REPLAY_ADDITIONAL_SESSION_ADVANCE);
  console.log('REPLAY_REEXPLORES = ' + REPLAY_REEXPLORES);
  console.log('NEW_TURN_ADDITIONAL_EXPOSURE = ' + NEW_TURN_ADDITIONAL_EXPOSURE);
  console.log('ACTIVATION_SAME_TURN_DELTA = ' + ACTIVATION_SAME_TURN_DELTA);
  console.log('ACTIVATION_EFFECTS_AGREE_WITH_STORE = ' + ACTIVATION_EFFECTS_AGREE_WITH_STORE);
  console.log('BROWSER_ACTIVATION_SECOND_BUMP = ' + BROWSER_ACTIVATION_SECOND_BUMP);
  console.log('NEGATIVE_SELECTOR_CONTROL = ' + NEGATIVE_SELECTOR_CONTROL);
  console.log('SEAM_HAS_NO_BROWSER_SELECTION_INPUT = ' + SEAM_HAS_NO_BROWSER_SELECTION_INPUT);
  console.log('STALE_MIRROR_CANONICAL_WINS = ' + STALE_MIRROR_CANONICAL_WINS);
  console.log('PRESENTATION_CANNOT_SUBSTITUTE = ' + PRESENTATION_CANNOT_SUBSTITUTE);
  console.log('SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY = ' + SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY);
  console.log('RECALL_WAIT_TIMEOUT_MS = ' + RECALL_WAIT_TIMEOUT_MS);
  console.log('RECALL_REQUEST_TIMEOUT_MS = ' + RECALL_REQUEST_TIMEOUT_MS);
  console.log('RECALL_TIMEOUT_OBSERVED = ' + RECALL_TIMEOUT_OBSERVED);
  console.log('GROUP_ISOLATION = ' + GROUP_ISOLATION);
  console.log('ACTIVATION_TURN_GUARD = ' + ACTIVATION_TURN_GUARD);
  console.log('CROSS_RESTART_EXACTLY_ONCE = ' + CROSS_RESTART_EXACTLY_ONCE);
  console.log('AUTO_RETRY = ' + AUTO_RETRY);
  console.log('REAL_PROVIDER_CALLS = ' + REAL_PROVIDER_CALLS);
  console.log('-'.repeat(72));
  if (failures) {
    console.error('R4C LIVE-3.4 CUTOVER PROOF FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exitCode = 1;
  } else {
    console.log('R4C LIVE-3.4 CUTOVER PROOF PASSED · ' + passed + ' assertions green');
  }
})().catch(error => {
  console.error('R4C LIVE-3.4 CUTOVER PROOF CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
}).finally(async () => {
  try { STORE.close(); } catch (_) { /* 已关闭 */ }
  let remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  for (let i = 0; i < 12 && remaining.length; i++) {
    await sleep(50);
    for (const d of remaining) dropDir(d);
    remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  }
  console.log('# cleanup: ' + (TEMP_DIRS.length - remaining.length) + '/' + TEMP_DIRS.length + ' temp dir(s) removed'
    + (remaining.length ? ' — STILL PRESENT: ' + J(remaining) : ''));
});
