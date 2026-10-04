'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-LIVE-3 · Runtime Interpretation Boundary
   （纯 Node · 零真实网络 · 零真实 provider · ZERO REAL PROVIDER CALLS）

   运行：node tests/test_r4c_live_runtime_boundary.js

   ── 本文件要证明的 ────────────────────────────────────────────────────
   在 Home Node 上存在**唯一**一条运行时解释执行面：
       POST /internal/runtime/memory-interpretation

   它的权威链是**一条**：角色 runtime spec（registry.getCharacterSpec）
     → **服务端 canonical rebinding**（memoryStore.getRecord → 共享可见性
       谓词 canReadMemory → 7 键投影）
     → 该角色自己的 Vault 绑定（services/home-node/credential-access.js）
     → 单次 provider 调用（active/node-model-port.js，单次、不重试）
     → R4-C 核心（assets/js/memory-recall/memory-interpretation-core.js）的
       同一份 validator。

   ── LIVE-3 相对 LIVE-2.1 的唯一行为变化（请求契约）────────────────────
   浏览器**不再提交 canonical 记忆内容**。请求是 6 键扁平闭集：
     { operation, characterId, timeoutMs, selectedMemoryIds, currentState?, roleName? }
   它只能表达"要解释哪几条"；`content` / `title` / `source` / `visibility`
   / `evidenceState` / 旧的 `inputEnvelope` 载体一律**指名拒绝**
   （caller-attempted-to-supply-canonical-evidence），绝不静默忽略。
   因此"调用方送什么正文"这件事在类型上不再存在 —— §D/§K 逐条证明。

   而且它**永远不持久化**：一次成功调用前后，记忆库 / 理解库 / 聊天库 /
   Vault 文件逐字节不变。

   ── cancellation 的诚实口径 ──────────────────────────────────────────
   只断言**可观测**的三件事，绝不合并：
     · SIGNAL_FORWARDING_PROVEN —— 边界把 AbortSignal 转发到了端口；
     · FETCH_ABORT_PROVEN      —— 注入的 fake fetch 真的观察到 abort；
     · PROVIDER_COST_STOP_PROVEN = NOT_PROVEN —— 本 harness **无法**观测
       "上游是否停止了计费"，因此不作任何主张。

   ── 传输真值 ──────────────────────────────────────────────────────────
   RUNTIME_BOUNDARY_TRANSPORT_SCOPE = DESKTOP_ONLY
   ANDROID_COMPATIBILITY = NOT_PROVEN（本文件任何地方都不得声称安卓兼容）

   ── §N · 跨文件哈希一致性 ─────────────────────────────────────────────
   路径 / 操作名 / **请求闭集键**在三处各有一份字面量（Node 服务、浏览器客户端、
   传输层路由判定）。本节把三者钉在一起，并打印：
     PATH_LITERAL_SOURCES_CONSISTENT / AUTO_INVOCATION_ABSENT /
     SERVER_ENABLE_PATH_ABSENT
   任何一处不一致都转红 —— 不改成"差不多的断言"。

   ── 静态计数的范围说明（诚实口径）────────────────────────────────────
   `function validateResponse` 与 `SYSTEM_INSTRUCTIONS` 在本仓库里**本来**
   就有三份（counterfactual / expectation / interpretation 三个兄弟影子核心，
   各自一份，见 §45 的相位切换记录）。本阶段的冻结要求是"本边界不得再写
   第二份"。因此：
     · VALIDATOR_IMPLEMENTATION_COUNT —— 统计**本边界相关文件**里的
       `function validateResponse` 定义数（必须 === 1，且在 R4-C 核心）；
     · REPO_VALIDATOR_DEFINITIONS —— 统计全仓库的定义数，必须仍恰好是
       那三个既有兄弟文件（证明本阶段**没有**新增第四份）。
   二者都打印，读者不必相信任何一个隐含前提。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'memory-interpretation-core.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_ACCESS = require(path.join(ROOT, 'services', 'home-node', 'credential-access.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
/* LIVE-3：内容权威在 canonical store 里，因此直接构造的边界实例也必须拿到
   **真实** store（真实 SQLite + 真实 store API），而不是一份手写对象。 */
const MEMORY_STORE = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));

/* ── 冻结常量 ─────────────────────────────────────────────────────────── */
const SENTINEL = 'SECRET_SENTINEL_INTERP_91B7';
const NOW = 1760000000000;
const ENDPOINT_A = 'https://provider-a.invalid/v1/chat/completions';
const ENDPOINT_B = 'https://provider-b.invalid/v1/chat/completions';
const ADMIN_TOKEN = 'r4c-interp-admin-token';
const POLICY_ON = Object.freeze({ memoryInterpretationEnabled: true });
const POLICY_OFF = Object.freeze({ memoryInterpretationEnabled: false });

/* ── house style ──────────────────────────────────────────────────────── */
let passed = 0, failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined && detail !== null ? '  -> ' + String(detail) : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const readFile = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── 诚实账本：任何一次"本不该抛出"的调用抛了都记在这里 ─────────────── */
const THROWN = [];
const HUNG = [];
const REAL_PROVIDER_ENDPOINTS = [];
const FETCH_RECORDERS = [];

let INVOKE_SURFACE = null;
let VALIDATOR_IMPLEMENTATION_COUNT = null;
let REPO_VALIDATOR_DEFINITIONS = null;
let SYSTEM_INSTRUCTIONS_DEFINITION_COUNT = null;
let REPO_SYSTEM_INSTRUCTIONS = null;
let SIGNAL_FORWARDING_PROVEN = false;
let FETCH_ABORT_PROVEN = false;
const PROVIDER_COST_STOP_PROVEN = 'NOT_PROVEN';
let TRANSPORT_SCOPE_OBSERVED = null;
let ANDROID_COMPAT_OBSERVED = null;
let PATH_LITERAL_SOURCES_CONSISTENT = false;
let AUTO_INVOCATION_ABSENT = false;
let SERVER_ENABLE_PATH_ABSENT = false;
let HTTP_SECOND_PATH_LITERAL = null;

/* ── LIVE-3 · canonical evidence 的实测裁决（全部先 UNKNOWN/NO，量到了才赋值）──
   这些常量与 §D/§K 的断言**共享同一个测量**：打印出来的每一个字母都必须是
   一次真实观测的结果，而不是注释里的一句话。 */
let CANONICAL_REBINDING_PROVEN = false;          /* provider 收到的是 store 里的正文 */
let CALLER_CANONICAL_EVIDENCE_REFUSED = false;   /* 22 个 canonical 名字逐个被指名拒绝 */
let SELECTED_ID_ORDER_PRESERVED = false;         /* 批内顺序 == selectedMemoryIds 顺序 */
let MISSING_AND_HIDDEN_INDISTINGUISHABLE = false;/* 缺失与隐藏除 id 外无任何差别 */
let SELECTED_SET_BOUND_ENFORCED = false;         /* 0..8，重复拒绝、超界拒绝 */
let PROJECTION_FIELD_COUNT = null;               /* 投影恰好 7 键 */
let PROJECTION_FIELDS_OBSERVED = null;
let EVIDENCE_BLOCK_SOURCE = null;                /* SERVER_CANONICAL_PROJECTION */
let CANONICAL_REVISION_REPORTED = null;
let SYSTEM_EVIDENCE_STATE_IS_NULL = false;       /* 服务端不声称 MetaMemory 证据态 */
const CANONICAL_BEARING_NAMES = Object.freeze([
  'records', 'record', 'memoryRecords', 'memory_records', 'content', 'summary',
  'title', 'source', 'rawSource', 'evidenceState', 'evidence', 'visibility',
  'visibleTo', 'excludeFrom', 'createdAt', 'importance', 'activationCount',
  'canonical', 'snapshot', 'memoryPayload', 'inputEnvelope', 'selectedIds'
]);

/* ── 深扫描工具：结果信封的形状由服务拥有，测试只读它 ─────────────────── */
function deepGet(node, key, maxDepth) {
  const limit = maxDepth == null ? 4 : maxDepth;
  const seen = new Set();
  const walk = (cur, depth) => {
    if (!cur || typeof cur !== 'object' || depth > limit) return { found: false };
    if (seen.has(cur)) return { found: false };
    seen.add(cur);
    if (!Array.isArray(cur) && Object.prototype.hasOwnProperty.call(cur, key)) {
      return { found: true, value: cur[key] };
    }
    for (const k of Object.keys(cur)) {
      const child = cur[k];
      if (child && typeof child === 'object') {
        const hit = walk(child, depth + 1);
        if (hit.found) return hit;
      }
    }
    return { found: false };
  };
  return walk(node, 0);
}
function collectStringArrays(node, key, out, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 5) return;
  if (!Array.isArray(node)) {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === key && Array.isArray(v)) {
        for (const entry of v) {
          const s = typeof entry === 'string' ? entry : (entry && typeof entry.reason === 'string' ? entry.reason : null);
          if (s && out.indexOf(s) < 0) out.push(s);
        }
      } else if (v && typeof v === 'object') collectStringArrays(v, key, out, (depth || 0) + 1);
    }
  }
}
function codesOf(r) {
  const out = [];
  const push = v => { if (typeof v === 'string' && v && out.indexOf(v) < 0) out.push(v); };
  for (const key of ['error', 'reasonCode', 'reason', 'code']) {
    const hit = deepGet(r, key, 2);
    if (hit.found) push(hit.value);
  }
  collectStringArrays(r, 'reasonCodes', out, 0);
  collectStringArrays(r, 'rejected', out, 0);
  return out;
}
function primaryCode(r) {
  if (!r || typeof r !== 'object') return null;
  for (const key of ['error', 'reasonCode', 'reason', 'code']) {
    if (typeof r[key] === 'string' && r[key]) return r[key];
  }
  return null;
}
const hasCode = (r, code) => codesOf(r).indexOf(code) >= 0;
const codeMatches = (r, code) => primaryCode(r) === code || hasCode(r, code);
function itemsOf(r) {
  const hit = deepGet(r, 'items', 3);
  return hit.found && Array.isArray(hit.value) ? hit.value : [];
}
function rejectedOf(r) {
  const hit = deepGet(r, 'rejected', 3);
  return hit.found && Array.isArray(hit.value) ? hit.value : [];
}
function boundaryOf(r) {
  const hit = deepGet(r, 'boundary', 3);
  return hit.found && hit.value && typeof hit.value === 'object' ? hit.value : {};
}

/* ── 服务调用适配器（冻结面是 svc.run(body, { signal })）──────────────── */
function invoke(svc, body, options) {
  if (typeof svc === 'function') { if (!INVOKE_SURFACE) INVOKE_SURFACE = 'callable'; return svc(body, options); }
  for (const name of ['run', 'dispatch', 'handle', 'execute']) {
    if (svc && typeof svc[name] === 'function') {
      if (!INVOKE_SURFACE) INVOKE_SURFACE = name;
      return svc[name](body, options);
    }
  }
  throw new Error('runtime-interpretation service exposes no invocable entry (run/dispatch/handle/execute)');
}
async function call(svc, body, options) {
  try { return await invoke(svc, body, options); }
  catch (e) {
    const msg = String((e && e.message) || e);
    THROWN.push(msg);
    return { ok: false, error: 'THREW', __threw: msg, durable: false, items: [], rejected: [], reasonCodes: [] };
  }
}
async function callGuarded(svc, body, options, guardMs) {
  const p = call(svc, body, options);
  let timer = null;
  const guard = new Promise(resolve => {
    timer = setTimeout(() => { HUNG.push('bounded-guard'); resolve({ __hung: true, ok: false, error: 'HUNG' }); }, guardMs);
    if (timer.unref) timer.unref();
  });
  const out = await Promise.race([p, guard]);
  if (timer) clearTimeout(timer);
  return out;
}

/* ── deterministic fake port（记录它**收到的一切**）────────────────────── */
function fakePort(behaviour) {
  const calls = { n: 0, last: null, requests: [], options: [] };
  return {
    calls,
    run(request, options) {
      calls.n += 1;
      calls.last = request;
      calls.requests.push(request);
      calls.options.push(options || {});
      if (request && request.spec && request.spec.endpoint) REAL_PROVIDER_ENDPOINTS.push(String(request.spec.endpoint));
      const b = typeof behaviour === 'function' ? behaviour(request, options, calls.n) : behaviour;
      if (b && typeof b.then === 'function') return b; /* behaviour may return its own promise */
      if (b === 'throw') return Promise.reject(new Error('provider boom'));
      if (b === 'network') {
        return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      }
      if (b === 'hang') return new Promise(() => {});
      if (b === 'null') return Promise.resolve(null);
      if (b === 'empty') return Promise.resolve({ text: '' });
      if (typeof b === 'string') return Promise.resolve({ text: b });
      return Promise.resolve({ text: JSON.stringify(b) });
    }
  };
}

/* ── deterministic fake registry / credential access ─────────────────── */
function fakeRegistry(specs) {
  const calls = { getCharacterSpec: [], getCharacter: [], listCharacters: 0 };
  return {
    calls,
    getCharacterSpec(id) {
      calls.getCharacterSpec.push(String(id));
      const spec = specs[String(id)];
      return spec ? JSON.parse(JSON.stringify(spec)) : null;
    },
    getCharacter(id) {
      calls.getCharacter.push(String(id));
      return specs[String(id)] ? { id: String(id), dto: { id: String(id), name: 'Char ' + id } } : null;
    },
    listCharacters() {
      calls.listCharacters += 1;
      return Object.keys(specs).map(id => ({ id: id, dto: { id: id } }));
    }
  };
}
function fakeCredentialAccess(secrets) {
  const calls = { resolve: [] };
  return {
    calls,
    resolve(ref) {
      calls.resolve.push(String(ref));
      const secret = secrets[String(ref)];
      if (!secret) return { ok: false, reason: 'not-allowed' };
      return { ok: true, provider: 'custom', secret: secret };
    }
  };
}

/* ── 真实 vault fixture（合成数据目录，绝不碰生产目录）────────────────── */
function seedVault(dataDir, bindingId, provider, apiKey) {
  const vault = CREDENTIAL_VAULT({ dataDir: dataDir });
  vault.load();
  const ok = vault.upsert(bindingId, { provider: provider, apiKey: apiKey });
  vault.save();
  return ok;
}

/* ── 真实 active/node-model-port.js + 注入 fake fetch（零真实网络）────── */
function jsonProviderFetch(rec, payload) {
  const record = (url, init) => {
    rec.push({
      url: String(url),
      method: String((init && init.method) || ''),
      headers: Object.assign({}, (init && init.headers) || {}),
      body: String((init && init.body) || '')
    });
  };
  return function (url, init) {
    record(url, init);
    const text = typeof payload === 'string'
      ? payload
      : JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}
function failingProviderFetch(rec, error) {
  return function (url, init) {
    rec.push({ url: String(url), headers: Object.assign({}, (init && init.headers) || {}) });
    return Promise.reject(error);
  };
}
function hangingProviderFetch(rec, observation) {
  return function (url, init) {
    rec.push({ url: String(url), headers: Object.assign({}, (init && init.headers) || {}), hasSignal: !!(init && init.signal) });
    const signal = init && init.signal;
    return new Promise((resolve, reject) => {
      if (!signal) return; /* 永不 settle：用来证明"上界等待"由服务端自己兜底 */
      if (signal.aborted) { observation.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      signal.addEventListener('abort', () => {
        observation.aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  };
}

/* ── 输入构造 ─────────────────────────────────────────────────────────── */
/* 一条 **canonical** 记忆行（memory-store 的合法形状）。LIVE-3 起正文只能来自
   这里：服务端自己读 store、自己投影。下面 memoryRecord() 保留的唯一用途是
   "调用方试图夹带 canonical 正文"的那些**拒绝**用例 —— 它们必须在到达核心
   之前就被指名拒绝，而不是被静默忽略。 */
function canonicalRow(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: 'T-' + id, summary: '', content: 'CANON-' + id,
    domain: '日常', tags: [], valence: 0.2, arousal: 0.7, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW, lastActivated: NOW,
    createdBy: 'user', createdByName: '', editedByUser: false,
    consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}
function memoryRecord(over) {
  return Object.assign({
    id: 'm1', title: '显卡', content: '显卡 驱动 更新失败，我熬到凌晨', rawSource: 'chat',
    kind: 'episodic', valence: 0.2, arousal: 0.7
  }, over || {});
}
/* 请求体 = **扁平 6 键闭集**。`selectedMemoryIds` 是唯一的内容指涉方式：
   它只说明"要解释哪几条"，不带任何正文、可见性或证据状态。 */
function requestBody(over) {
  return Object.assign({
    operation: 'memory-interpretation',
    characterId: 'char_a',
    timeoutMs: 1000,
    selectedMemoryIds: ['m1'],
    currentState: { relationship: 'warm', emotion: 'calm' },
    roleName: 'A'
  }, over || {});
}

/* ── 共享的真实 canonical store（临时目录）──────────────────────────────
   每一个直接构造的边界实例都注入**同一个** store。这里刻意用真实 SQLite +
   真实 store API，而不是一份手写替身：本阶段的核心事实就是"正文来自 canonical
   store"，如果 store 是假的，那条事实就退化成"正文来自测试写的一个对象"。 */
let CANON_DIR = null;
let CANON_STORE = null;
function canonStore() {
  if (CANON_STORE) return CANON_STORE;
  CANON_DIR = freshDir('ib-interp-canon-');
  CANON_STORE = MEMORY_STORE({ dataDir: CANON_DIR, logger: () => {} });
  const opened = CANON_STORE.open();
  if (!opened || opened.ok !== true) throw new Error('canonical store failed to open: ' + JSON.stringify(opened));
  /* 三条可见行 + 一条"对 char_a 隐藏"的行。没有 m_missing 这一行 ——
     "缺失"必须是**真的**不存在，而不是被测试标记成不存在。 */
  const seeds = [
    canonicalRow('m1', { content: '显卡 驱动 更新失败，我熬到凌晨' }),
    canonicalRow('m2', { content: 'CANON-M2' }),
    canonicalRow('m3', { content: 'CANON-M3' }),
    canonicalRow('m_hidden', { content: 'CANON-HIDDEN', visibility: 'only', visibleTo: ['char_b'] })
  ];
  for (const row of seeds) {
    const wrote = CANON_STORE.putRecord(row);
    if (!wrote || wrote.ok !== true) throw new Error('canonical seed failed: ' + JSON.stringify(wrote));
  }
  return CANON_STORE;
}
function closeCanonStore() {
  if (CANON_STORE) { try { CANON_STORE.close(); } catch (_) { /* 已关闭 */ } CANON_STORE = null; }
  if (CANON_DIR) {
    dropDir(CANON_DIR);
    CANON_DIR_CLEANED = !fs.existsSync(CANON_DIR);
    CANON_DIR = null;
  }
}
let CANON_DIR_CLEANED = null;

/* ── wire 观测（provider 真正收到了什么）────────────────────────────────
   LIVE-3 要证明的是"投影后的 canonical 内容到达了 provider"，而 projection
   只存在于 USER 消息的 JSON 块里 —— 因此必须把 wire 解析出来看，而不是相信
   边界自己的自述。 */
function wireEnvelope(wire) {
  const messages = (wire && Array.isArray(wire.messages)) ? wire.messages : [];
  const user = messages.filter(m => m && m.role === 'user')[0];
  const text = user && typeof user.content === 'string' ? user.content : '';
  const m = /```json\r?\n([\s\S]*?)\r?\n```/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}
function wireBatch(wire) {
  const env = wireEnvelope(wire);
  return env && Array.isArray(env.MEMORY_BATCH) ? env.MEMORY_BATCH : [];
}
/* 真实 NodeModelPort + 记录型 fake fetch：应答按**它自己收到的批次**生成，
   因此"投影顺序"与"模型被要求解释的顺序"是同一份证据。 */
function recordingProviderFetch(rec) {
  return function (url, init) {
    const bodyText = String((init && init.body) || '');
    let wire = null;
    try { wire = JSON.parse(bodyText); } catch (_) { wire = null; }
    rec.push({
      url: String(url), method: String((init && init.method) || ''),
      headers: Object.assign({}, (init && init.headers) || {}),
      bodyText: bodyText, wire: wire, hasSignal: !!(init && init.signal)
    });
    const batch = wireBatch(wire);
    const payload = { items: batch.map(m => validItem(String(m.memoryId))) };
    return Promise.resolve({
      ok: true, status: 200,
      text: function () { return Promise.resolve(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] })); }
    });
  };
}
function validItem(id) {
  return {
    memoryId: id, meaning: '那次失败现在更像是一次共同的努力', appraisal: 'mixed',
    affect: 'warm', relationshipMeaning: '让我更愿意靠近', causalAttribution: null,
    basis: 'ai_inference', subjectiveConfidence: 0.4
  };
}
const validBatch = ids => ({ items: ids.map(validItem) });

function specA(over) {
  return Object.assign({
    provider: 'custom', model: 'model-a', endpoint: ENDPOINT_A,
    credentialRef: 'cred_a', systemPrompt: 'SYS-A'
  }, over || {});
}
function specB(over) {
  return Object.assign({
    provider: 'custom', model: 'model-b', endpoint: ENDPOINT_B,
    credentialRef: 'cred_b', systemPrompt: 'SYS-B'
  }, over || {});
}

function makeService(over) {
  const o = over || {};
  const logs = o.logs || [];
  const registry = o.registry === undefined ? fakeRegistry({ char_a: specA(), char_b: specB() }) : o.registry;
  const credentialAccess = o.credentialAccess === undefined
    ? fakeCredentialAccess({ cred_a: SENTINEL, cred_b: SENTINEL + '_B' }) : o.credentialAccess;
  const modelPort = o.modelPort === undefined ? fakePort(validBatch(['m1'])) : o.modelPort;
  /* LIVE-3：canonical store 是**第五个**依赖（registry / credentialAccess /
     modelPort / core / memoryStore）。默认注入真实 store；显式传 null 用来
     证明"store 缺席 ⇒ 明确失败"，而不是静默解释一个空集合。 */
  const memoryStore = o.memoryStore === undefined ? canonStore() : o.memoryStore;
  const svc = RUNTIME.createRuntimeInterpretation({
    registry: registry,
    credentialAccess: credentialAccess,
    modelPort: modelPort,
    memoryStore: memoryStore,
    costPolicy: o.costPolicy,
    clock: o.clock || (() => NOW),
    logger: (event, fields) => {
      try { logs.push({ event: String(event), fields: JSON.parse(JSON.stringify(fields || {})) }); }
      catch (_) { logs.push({ event: String(event) }); }
    }
  });
  return { svc: svc, registry: registry, credentialAccess: credentialAccess, modelPort: modelPort, memoryStore: memoryStore, logs: logs };
}

/* ── repo 静态扫描 ────────────────────────────────────────────────────── */
function walkRepo(roots) {
  const files = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') walk(q);
        continue;
      }
      if (/\.(js|rs|toml|html)$/.test(e.name)) files.push(q);
    }
  };
  roots.forEach(walk);
  return files;
}
const REPO_ROOTS = ['assets', 'services', 'bridge', 'src-tauri']
  .map(d => path.join(ROOT, d)).filter(d => fs.existsSync(d));
const REPO_FILES = walkRepo(REPO_ROOTS);
const relOf = f => path.relative(ROOT, f).replace(/\\/g, '/');

/* ── HTTP helpers（只连本机测试服务器）────────────────────────────────── */
function httpRequest(host, port, method, urlPath, options) {
  options = options || {};
  return new Promise(resolve => {
    const data = options.rawBody !== undefined ? options.rawBody
      : (options.body == null ? null : JSON.stringify(options.body));
    const headers = Object.assign({}, options.headers || {});
    if (data != null) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: host, port: port, path: urlPath, method: method, timeout: 8000, headers: headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, raw: raw, headers: res.headers });
      });
      res.on('error', e => resolve({ status: 0, body: null, raw: '', error: String(e && e.message) }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) { /* 已销毁 */ } resolve({ status: 0, body: null, raw: '', error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: null, raw: '', error: String((e && e.code) || (e && e.message)) }));
    if (data != null) req.write(data);
    req.end();
  });
}
function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
}
function listen(server, host) {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}
function canSelfConnect(address) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    server.on('error', () => resolve(false));
    server.listen(0, address, () => {
      const port = server.address().port;
      let settled = false;
      const finish = value => { if (settled) return; settled = true; server.close(() => resolve(value)); };
      const req = http.request({ host: address, port: port, path: '/', timeout: 3000 }, res => {
        res.resume();
        res.on('end', () => finish(true));
      });
      req.on('error', () => finish(false));
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.end();
    });
  });
}
/* 与 tests/test_home_node_lan_gate.js 同一套"扮演远端"的技术：优先真实 LAN
   IPv4，否则用 127.0.0.2 别名 —— 服务端的 isLoopback() 只认 127.0.0.1，
   因此两者都是真实的非 loopback 来源。用哪一条会打印出来。 */
async function pickRemoteAddress() {
  const candidates = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const entry of ifaces[name] || []) {
      const family = String(entry.family);
      if ((family === 'IPv4' || family === '4') && !entry.internal) candidates.push(entry.address);
    }
  }
  for (const address of candidates) if (await canSelfConnect(address)) return { address: address, kind: 'lan' };
  if (await canSelfConnect('127.0.0.2')) return { address: '127.0.0.2', kind: 'loopback-alias' };
  return null;
}
function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function dropDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 句柄可能还没放完 */ }
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
/* 取出 `marker { ... }` 这一整块（按花括号配平，跳过字符串与注释）。
   用来把"运行时面"这一块从其余一千多行里切出来 —— 只有切出来，
   "这一块里没有定时器"才是一句有范围的话。 */
function sliceObjectBlock(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let mode = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === '//') { if (ch === '\n') mode = null; continue; }
    if (mode === '/*') { if (ch === '*' && next === '/') { mode = null; i++; } continue; }
    if (mode === "'" || mode === '"' || mode === '`') {
      if (ch === '\\') { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '/' && next === '/') { mode = '//'; i++; continue; }
    if (ch === '/' && next === '*') { mode = '/*'; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { mode = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(open, i + 1); }
  }
  return null;
}
/* 收集一段代码里所有 process.env 读取（注释已剥离）。 */
function envKeysOf(code) {
  const keys = [];
  const re = /process\.env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]*)['"]\s*\])/g;
  let m;
  while ((m = re.exec(code))) keys.push(m[1] || m[2]);
  return Array.from(new Set(keys));
}

/* ══════════════════════════════════════════════════════════════════════════
   0 · 装配件可用性（缺失就如实报出是**哪一件**，不弱化任何断言）
   ══════════════════════════════════════════════════════════════════════════ */
let RUNTIME = null;
let RUNTIME_LOAD_ERROR = null;
try { RUNTIME = require(path.join(ROOT, 'services', 'home-node', 'runtime-interpretation.js')); }
catch (error) { RUNTIME_LOAD_ERROR = error; }

(async function main() {
  section('0 · piece availability');
  const RUNTIME_OK = !!RUNTIME && typeof RUNTIME.createRuntimeInterpretation === 'function';
  check('0.1 services/home-node/runtime-interpretation.js loads and exports createRuntimeInterpretation',
    RUNTIME_OK,
    RUNTIME_LOAD_ERROR ? String(RUNTIME_LOAD_ERROR.message) : 'export createRuntimeInterpretation missing');
  check('0.2 services/home-node/http.js carries the runtime route',
    /runtimeInterpretation/.test(readFile('services/home-node/http.js')),
    'http wiring missing');
  check('0.3 services/home-node-service.js injects the service at assembly',
    /createRuntimeInterpretation/.test(readFile('services/home-node-service.js')),
    'assembly wiring missing');
  if (!RUNTIME_OK) {
    console.error('\nMISSING_PIECE: services/home-node/runtime-interpretation.js (owner: lead). '
      + 'The suite did NOT run its assertions — nothing is weakened, nothing is faked.');
    console.error('RUNTIME BOUNDARY SUITE BLOCKED · ' + passed + ' passed / ' + (failures + 1) + ' failed');
    process.exit(1);
  }
  const RT = RUNTIME.createRuntimeInterpretation;

  /* ══════════════════════════════════════════════════════════════════════
     A · static authority surface
     ══════════════════════════════════════════════════════════════════════ */
  section('A · static authority surface');
  {
    check('A1.pathIsTheInternalRuntimeBoundary',
      RT.PATH === '/internal/runtime/memory-interpretation' && RT.PATH.indexOf('/internal/') === 0,
      'path = ' + RT.PATH);

    const opsStatic = RT.OPERATIONS !== undefined ? RT.OPERATIONS : RT.ALLOWED_RUNTIME_DERIVATIONS;
    check('A2.moduleAllowlistIsExactlyOneOperation',
      Array.isArray(opsStatic) && opsStatic.length === 1 && opsStatic[0] === 'memory-interpretation',
      'allowlist = ' + JSON.stringify(opsStatic) + ' (exported as '
      + (RT.OPERATIONS !== undefined ? '.OPERATIONS' : '.ALLOWED_RUNTIME_DERIVATIONS')
      + '; frozen interface named .OPERATIONS)');

    const inst = makeService({ costPolicy: POLICY_ON });
    check('A3.instanceSurfaceIsClosedAndFrozen',
      inst.svc.path === RT.PATH
      && Array.isArray(inst.svc.operations) && inst.svc.operations.length === 1
      && inst.svc.operations[0] === 'memory-interpretation'
      && typeof inst.svc.run === 'function' && typeof inst.svc.describe === 'function'
      && Object.isFrozen(inst.svc),
      'public surface = { path, operations, run, describe }, nothing else');
    INVOKE_SURFACE = 'run';

    check('A4.timeoutAuthorityIsDeclaredAndEvidenceBased',
      RT.SAFETY_CAP_MS === 120000 && RT.MAX_ATTEMPTS === 1 && RT.AUTO_RETRY === 'NONE'
      && /understanding-derivation\.js:70/.test(String(RT.SAFETY_CAP_SOURCE))
      && /UNDERSTANDING_TIMEOUT_MS = 120000/.test(readFile('services/home-node/understanding-derivation.js')),
      'cap=' + RT.SAFETY_CAP_MS + ' attempts=' + RT.MAX_ATTEMPTS + ' retry=' + RT.AUTO_RETRY
      + ' source=' + RT.SAFETY_CAP_SOURCE);

    const rtCode = WIRING.stripJsComments(readFile('services/home-node/runtime-interpretation.js'));
    check('A5.getCharacterSpecIsTheOnlyCharacterConfigLookup',
      /getCharacterSpec\s*\(/.test(rtCode)
      && !/\.getCharacter\s*\(/.test(rtCode)
      && !/listCharacters\s*\(/.test(rtCode)
      && !/require\([^)]*sqlite[^)]*\)/.test(rtCode),
      'no second lookup (no getCharacter DTO read, no catalog scan, no sqlite)');

    /* LIVE-3：证据读取只有**一条**路 —— 注入的 store 上的 getRecord(id)。
       不重跑 recall、不列全表、不自己开 sqlite；"服务端只按 id 取那几行"
       这句话因此是可机械核对的。 */
    check('A5b.canonicalEvidenceReadIsGetRecordOnly',
      /memoryStore/.test(rtCode) && /\.getRecord\s*\(/.test(rtCode)
      && !/\.listRecords\s*\(/.test(rtCode)
      && !/\.listVisible\s*\(/.test(rtCode)
      && !/memoryRetrieval|Orchestrator|\.retrieve\s*\(/i.test(rtCode),
      'evidence read = memoryStore.getRecord(id) only; no recall rerun, no table scan');

    check('A6.credentialResolutionDelegatesToCredentialAccess',
      /credentialAccess/.test(rtCode) && /\.resolve\s*\(/.test(rtCode)
      && !/credential-vault|createCredentialResolver/.test(rtCode)
      && !/spec\s*\.\s*apiKey/.test(rtCode)
      && /createCredentialAccess\s*\(/.test(readFile('services/home-node-service.js')),
      'no local resolver copy, no plaintext spec.apiKey fallback, assembly binds credential-access.js');

    check('A7.serviceReusesTheR4CValidatorAndBuilder',
      /memory-interpretation-core\.js/.test(rtCode)
      && /core\s*\.\s*validateResponse\s*\(/.test(rtCode)
      && /core\s*\.\s*buildRequest\s*\(/.test(rtCode)
      && !/function\s+validateResponse/.test(rtCode),
      'core.validateResponse + core.buildRequest are called; no local validator');

    /* 静态计数：边界相关文件必须恰好一份 validator 定义，且必须是 R4-C 核心。 */
    const BOUNDARY_FILES = [
      'assets/js/memory-recall/memory-interpretation-core.js',
      'assets/js/memory-recall/memory-interpretation-runner.js',
      'services/home-node/runtime-interpretation.js',
      'services/home-node/http.js',
      'services/home-node-service.js'
    ];
    const VALIDATOR_RE = new RegExp('function\\s+validateResponse\\s*\\(');
    const boundaryValidators = BOUNDARY_FILES.filter(rel =>
      fs.existsSync(path.join(ROOT, rel)) && VALIDATOR_RE.test(readFile(rel)));
    VALIDATOR_IMPLEMENTATION_COUNT = boundaryValidators.length;
    const repoValidators = REPO_FILES
      .filter(f => VALIDATOR_RE.test(fs.readFileSync(f, 'utf8')))
      .map(relOf).sort();
    REPO_VALIDATOR_DEFINITIONS = repoValidators.length;
    const SIBLING_VALIDATORS = [
      'assets/js/memory-recall/counterfactual-shadow-core.js',
      'assets/js/memory-recall/expectation-shadow-core.js',
      'assets/js/memory-recall/memory-interpretation-core.js'
    ].sort();
    check('A8.validatorImplementationCountIsOneInsideTheBoundary',
      VALIDATOR_IMPLEMENTATION_COUNT === 1
      && boundaryValidators[0] === 'assets/js/memory-recall/memory-interpretation-core.js',
      'VALIDATOR_IMPLEMENTATION_COUNT=' + VALIDATOR_IMPLEMENTATION_COUNT
      + ' in ' + JSON.stringify(boundaryValidators));
    check('A9.noFourthValidatorImplementationAppearedInTheRepo',
      REPO_VALIDATOR_DEFINITIONS === 3
      && JSON.stringify(repoValidators) === JSON.stringify(SIBLING_VALIDATORS),
      'repo-wide definitions (' + REPO_VALIDATOR_DEFINITIONS + ') must stay exactly the three '
      + 'pre-existing sibling cores: ' + JSON.stringify(repoValidators));

    const SI_RE = new RegExp('SYSTEM_INSTRUCTIONS\\s*=');
    const boundarySI = BOUNDARY_FILES.filter(rel =>
      fs.existsSync(path.join(ROOT, rel)) && SI_RE.test(readFile(rel)));
    SYSTEM_INSTRUCTIONS_DEFINITION_COUNT = boundarySI.length;
    REPO_SYSTEM_INSTRUCTIONS = REPO_FILES
      .filter(f => SI_RE.test(fs.readFileSync(f, 'utf8')))
      .map(relOf).sort();
    check('A10.systemInstructionsHaveASingleDefinitionInTheInterpretationCore',
      SYSTEM_INSTRUCTIONS_DEFINITION_COUNT === 1
      && boundarySI[0] === 'assets/js/memory-recall/memory-interpretation-core.js'
      && REPO_SYSTEM_INSTRUCTIONS.length === 3
      && REPO_SYSTEM_INSTRUCTIONS.indexOf('assets/js/memory-recall/memory-interpretation-core.js') >= 0,
      'SYSTEM_INSTRUCTIONS_DEFINITION_COUNT=' + SYSTEM_INSTRUCTIONS_DEFINITION_COUNT
      + ' in ' + JSON.stringify(boundarySI) + '; repo-wide=' + JSON.stringify(REPO_SYSTEM_INSTRUCTIONS));

    const FROZEN_BOUNDARY_CODES = ['disabled', 'operation-forbidden', 'request-shape-invalid',
      'request-field-forbidden', 'runtime-spec-unavailable', 'credential-unavailable',
      'timeout-authority-missing', 'timeout', 'provider-error', 'network', 'invalid-output',
      'aborted', 'model-port-unavailable',
      /* LIVE-3 新增（全部来自冻结契约，逐字） */
      'caller-attempted-to-supply-canonical-evidence', 'duplicate-memory-id',
      'memory-selection-exceeds-bound', 'canonical-evidence-unavailable'];
    const declaredCodes = Object.keys(RT.REASON || {}).map(k => RT.REASON[k]);
    check('A11.everyFrozenBoundaryReasonCodeIsDeclared',
      FROZEN_BOUNDARY_CODES.every(c => declaredCodes.indexOf(c) >= 0),
      'missing: ' + JSON.stringify(FROZEN_BOUNDARY_CODES.filter(c => declaredCodes.indexOf(c) < 0)));
    /* 新码必须有 HTTP 权威（否则"同一个失败两个状态码"就会重新出现）。 */
    check('A11b.everyLIVE3CodeHasADeclaredStatus',
      RT.STATUS_BY_REASON['caller-attempted-to-supply-canonical-evidence'] === 400
      && RT.STATUS_BY_REASON['duplicate-memory-id'] === 400
      && RT.STATUS_BY_REASON['memory-selection-exceeds-bound'] === 400
      && RT.STATUS_BY_REASON['canonical-evidence-unavailable'] === 503
      && RT.STATUS_BY_REASON['no-authorized-memory'] === 422,
      JSON.stringify({
        callerCanonical: RT.STATUS_BY_REASON['caller-attempted-to-supply-canonical-evidence'],
        duplicate: RT.STATUS_BY_REASON['duplicate-memory-id'],
        exceeds: RT.STATUS_BY_REASON['memory-selection-exceeds-bound'],
        unavailable: RT.STATUS_BY_REASON['canonical-evidence-unavailable'],
        noAuthorized: RT.STATUS_BY_REASON['no-authorized-memory']
      }));

    const FROZEN_CORE_CODES = ['model-shape-invalid', 'model-returned-unknown-memory-id',
      'model-returned-duplicate-memory-id', 'model-field-exceeds-bound', 'model-enum-out-of-vocabulary',
      'model-confidence-out-of-range', 'model-missing-required-field', 'model-returned-no-valid-item',
      'model-json-invalid'];
    const coreCodeValues = Object.keys(CORE.REASON_CODES).map(k => CORE.REASON_CODES[k]);
    check('A12.r4cCoreCodesAreTheCoresOwnVocabulary',
      FROZEN_CORE_CODES.every(c => coreCodeValues.indexOf(c) >= 0),
      'missing from core.REASON_CODES: '
      + JSON.stringify(FROZEN_CORE_CODES.filter(c => coreCodeValues.indexOf(c) < 0)));

    const desc = inst.svc.describe();
    check('A13.describeIsSecretFreeMetadata',
      desc && desc.runtimeOnly === true && desc.durable === false
      && desc.attempts === 1 && desc.autoRetry === 'NONE'
      && desc.credentialLayer === 'services/home-node/credential-access.js'
      && JSON.stringify(desc).indexOf(SENTINEL) < 0
      && desc.costPolicy && desc.costPolicy.memoryInterpretationEnabled === true,
      JSON.stringify({ transportScope: desc.transportScope, android: desc.androidCompatibility }));
  }

  /* ══════════════════════════════════════════════════════════════════════
     B · server cost gate（CALLER_INTENT != SERVER_COST_POLICY）
     ══════════════════════════════════════════════════════════════════════ */
  section('B · server cost gate');
  {
    const cases = [
      ['B1.defaultPolicyAbsentIsDisabled', undefined, 'absent-default-false'],
      ['B2.policyObjectOffIsDisabled', POLICY_OFF, 'assembly-policy-object'],
      ['B3.policyBooleanFalseIsDisabled', false, 'injected-boolean']
    ];
    for (const [name, policy, expectedSource] of cases) {
      const s = makeService({ costPolicy: policy });
      const r = await call(s.svc, requestBody());
      check(name,
        r.ok === false && r.error === 'disabled' && r.status === 503
        && s.modelPort.calls.n === 0 && s.credentialAccess.calls.resolve.length === 0
        && boundaryOf(r).providerCalls === 0 && boundaryOf(r).vaultReads === 0
        && r.durable === false,
        'policy=' + JSON.stringify(policy) + ' -> ' + primaryCode(r) + ' status=' + r.status
        + ' providerCalls=' + s.modelPort.calls.n + ' vaultReads=' + s.credentialAccess.calls.resolve.length);
      const d = s.svc.describe();
      check(name + '.policySourceIsReported',
        d.costPolicy.source === expectedSource,
        'source=' + d.costPolicy.source + ' expected=' + expectedSource);
    }
    const on = makeService({ costPolicy: POLICY_ON });
    const okr = await call(on.svc, requestBody());
    check('B4.enablingPolicyProceeds',
      okr.ok === true && okr.status === 200 && on.modelPort.calls.n === 1
      && on.credentialAccess.calls.resolve.length === 1
      && boundaryOf(okr).providerCalls === 1 && boundaryOf(okr).vaultReads === 1,
      'ok=' + okr.ok + ' providerCalls=' + on.modelPort.calls.n + ' vaultReads=' + on.credentialAccess.calls.resolve.length);
    const boolOn = makeService({ costPolicy: true });
    const boolr = await call(boolOn.svc, requestBody());
    check('B5.policyBooleanTrueAlsoProceeds',
      boolr.ok === true && boolOn.modelPort.calls.n === 1,
      'ok=' + boolr.ok + ' providerCalls=' + boolOn.modelPort.calls.n);
    const fn = makeService({ costPolicy: () => ({ memoryInterpretationEnabled: true }) });
    const fnr = await call(fn.svc, requestBody());
    check('B6.policyFunctionIsEvaluatedPerCall',
      fnr.ok === true && fn.modelPort.calls.n === 1,
      'ok=' + fnr.ok);
    const thrower = makeService({ costPolicy: () => { throw new Error('policy exploded'); } });
    const throwr = await call(thrower.svc, requestBody());
    check('B7.throwingPolicyFailsClosed',
      throwr.ok === false && throwr.error === 'disabled' && thrower.modelPort.calls.n === 0,
      primaryCode(throwr) + ' providerCalls=' + thrower.modelPort.calls.n);
    const callerIntent = makeService({ costPolicy: undefined });
    const intent = await call(callerIntent.svc, requestBody({ enabled: true }));
    check('B8.callerIntentIsNotAuthority',
      intent.ok === false && intent.error === 'request-field-forbidden' && callerIntent.modelPort.calls.n === 0,
      'a body-level enabled:true must be refused as an unknown field, never read as policy (' + primaryCode(intent) + ')');

    /* 生产（进程级）装配路径：**刻意不传** costPolicy ⇒ 默认关，且本阶段没有 env/UI 开关。 */
    const serviceSrc = readFile('services/home-node-service.js');
    const processAssembly = /const runtimeInterpretation = createRuntimeInterpretation\(\{[\s\S]*?\}\);/.exec(serviceSrc);
    const instanceAssembly = /const instanceRuntimeInterpretation = options\.runtimeInterpretation \|\| createRuntimeInterpretation\(\{[\s\S]*?\}\);/.exec(serviceSrc);
    check('B9.productionAssemblyHasNoEnablePath',
      !!processAssembly && !/costPolicy/.test(processAssembly[0])
      && !!instanceAssembly && /costPolicy:\s*options\.runtimeInterpretationPolicy/.test(instanceAssembly[0]),
      'process-level assembly omits costPolicy (default OFF); instance assembly forwards the explicit '
      + 'options.runtimeInterpretationPolicy only');
    check('B10.noEnvOrUiToggleCanEnableIt',
      serviceSrc.indexOf('runtimeInterpretationPolicy') >= 0
      && !/runtimeInterpretationPolicy\s*[:=][^;]*process\.env/.test(serviceSrc)
      && !/process\.env[^;\n]*runtimeInterpretation/i.test(serviceSrc),
      'the only enable input is the explicit assembly option');
  }

  /* ══════════════════════════════════════════════════════════════════════
     C · operation allowlist
     ══════════════════════════════════════════════════════════════════════ */
  section('C · operation allowlist');
  {
    const cases = [
      ['expectation', 'expectation'], ['counterfactual', 'counterfactual'], ['chat', 'chat'],
      ['understanding', 'understanding'], ['empty string', ''], ['null', null],
      ['trailing space', 'memory-interpretation '], ['leading space', ' memory-interpretation'],
      ['uppercase', 'MEMORY-INTERPRETATION'], ['unknown', 'memory-interpretation-2'],
      ['missing field', undefined]
    ];
    const s = makeService({ costPolicy: POLICY_ON });
    for (const [label, value] of cases) {
      const b = requestBody();
      if (value === undefined) delete b.operation; else b.operation = value;
      const r = await call(s.svc, b);
      check('C1.operationForbidden.' + label,
        r.ok === false && r.error === 'operation-forbidden' && r.status === 403,
        'value=' + JSON.stringify(value) + ' -> ' + primaryCode(r) + ' status=' + r.status);
    }
    check('C2.forbiddenOperationsSpendNothing',
      s.modelPort.calls.n === 0 && s.credentialAccess.calls.resolve.length === 0,
      'providerCalls=' + s.modelPort.calls.n + ' vaultReads=' + s.credentialAccess.calls.resolve.length);
    const ok = makeService({ costPolicy: POLICY_ON });
    const r2 = await call(ok.svc, requestBody({ operation: 'memory-interpretation' }));
    check('C3.theOneAllowedOperationProceeds', r2.ok === true && ok.modelPort.calls.n === 1,
      'ok=' + r2.ok);
  }

  /* ══════════════════════════════════════════════════════════════════════
     D · request contract
        （扁平 6 键闭集 + canonical 证据指名拒绝 + 选择集边界 + 超时权威 + clamp）
     ══════════════════════════════════════════════════════════════════════ */
  section('D · request contract');
  {
    const s = makeService({ costPolicy: POLICY_ON });

    /* ① 形状：characterId / selectedMemoryIds / timeoutMs 是必填的有界值。
          selectedMemoryIds 是**唯一**指向内容的字段，它自己也被严格定型。 */
    const shapeCases = [
      ['missing characterId', (() => { const b = requestBody(); delete b.characterId; return b; })()],
      ['empty characterId', requestBody({ characterId: '' })],
      ['whitespace characterId', requestBody({ characterId: '   ' })],
      ['non-string characterId', requestBody({ characterId: 42 })],
      ['missing selectedMemoryIds', (() => { const b = requestBody(); delete b.selectedMemoryIds; return b; })()],
      ['non-array selectedMemoryIds', requestBody({ selectedMemoryIds: 'm1' })],
      ['object selectedMemoryIds', requestBody({ selectedMemoryIds: { m1: true } })],
      ['null selectedMemoryIds', requestBody({ selectedMemoryIds: null })],
      ['non-string id entry', requestBody({ selectedMemoryIds: [42] })],
      ['empty-string id entry', requestBody({ selectedMemoryIds: [''] })],
      ['blank id entry', requestBody({ selectedMemoryIds: ['   '] })],
      ['object id entry', requestBody({ selectedMemoryIds: [{ id: 'm1' }] })],
      ['non-object currentState', requestBody({ currentState: 'warm' })],
      ['array currentState', requestBody({ currentState: [] })],
      ['non-string roleName', requestBody({ roleName: 7 })]
    ];
    for (const [label, b] of shapeCases) {
      const r = await call(s.svc, b);
      check('D1.shapeInvalid.' + label,
        r.ok === false && r.error === 'request-shape-invalid' && r.status === 400,
        primaryCode(r) + ' status=' + r.status);
    }
    /* ①b currentState 也是闭集（2 键）：它是仅存的两个非 canonical 输入之一，
           "把内容藏进 currentState"必须同样被指名拒绝 —— 而且嵌套里的
           canonical 名字走**同一个**证据拒绝码，不是笼统的未知字段。 */
    const stateCanonical = await call(s.svc, requestBody({
      currentState: { relationship: 'warm', content: 'HIDDEN-IN-STATE' }
    }));
    check('D1b.nestedCanonicalNameInsideCurrentStateIsRefusedAsCanonicalEvidence',
      stateCanonical.ok === false
      && stateCanonical.error === 'caller-attempted-to-supply-canonical-evidence'
      && stateCanonical.field === 'currentState.content' && stateCanonical.status === 400,
      primaryCode(stateCanonical) + ' field=' + stateCanonical.field);
    const stateUnknown = await call(s.svc, requestBody({
      currentState: { relationship: 'warm', emotion: 'calm', injectedPrompt: 'hi' }
    }));
    check('D1c.anyOtherNestedKeyInsideCurrentStateIsRefusedByTheClosedSchema',
      stateUnknown.ok === false && stateUnknown.error === 'request-field-forbidden'
      && stateUnknown.field === 'currentState.injectedPrompt' && stateUnknown.status === 400,
      primaryCode(stateUnknown) + ' field=' + stateUnknown.field);

    /* ② 执行权威字段注入 → request-field-forbidden（指名该字段），且零成本 */
    const forbidden = ['apiKey', 'secret', 'credentialRef', 'provider', 'model', 'endpoint',
      'systemPrompt', 'prompt', 'messages', 'developerPrompt', 'instructions', 'developer',
      'baseURL', 'token', 'authorization', 'headers', 'spec', 'config'];
    for (const field of forbidden) {
      const b = requestBody();
      b[field] = 'INJECTED';
      const r = await call(s.svc, b);
      check('D2.authorityFieldForbidden.' + field,
        r.ok === false && r.error === 'request-field-forbidden' && r.field === field && r.status === 400,
        'field=' + field + ' -> ' + primaryCode(r) + ' reportedField=' + r.field);
    }
    const harmless = requestBody();
    harmless.harmless = 1;
    const hr = await call(s.svc, harmless);
    check('D3.unknownHarmlessKeyIsRefusedByClosedSchema',
      hr.ok === false && hr.error === 'request-field-forbidden' && hr.field === 'harmless'
      && /closed-schema/.test(String(hr.detail)),
      primaryCode(hr) + ' field=' + hr.field + ' detail=' + hr.detail);

    /* ③ ★ LIVE-3 的核心安全属性：每一个 canonical 证据名字都**指名**拒绝。
          不是 ignore、不是静默丢弃 —— 请求会得到稳定的码 + 那个字段名，
          因此"我到底哪里越权了"不需要调用方去猜。 */
    let canonicalRefusedAll = true;
    for (const field of CANONICAL_BEARING_NAMES) {
      const b = requestBody();
      b[field] = (field === 'inputEnvelope')
        ? { selectedIds: ['m1'], records: [memoryRecord()] }
        : 'INJECTED_CANONICAL';
      const r = await call(s.svc, b);
      const ok = r.ok === false
        && r.error === 'caller-attempted-to-supply-canonical-evidence'
        && r.field === field && r.status === 400;
      if (!ok) canonicalRefusedAll = false;
      check('D4.canonicalEvidenceRefused.' + field, ok,
        'field=' + field + ' -> ' + primaryCode(r) + ' reportedField=' + r.field + ' status=' + r.status);
    }
    CALLER_CANONICAL_EVIDENCE_REFUSED = canonicalRefusedAll;

    /* ③b 证据权威**先于**执行权威：连 operation 都不看，就先报越权字段。
            （否则"送一个 records 再顺手把 operation 写错"会得到两种码，
             调用方据此就能推断服务端内部检查顺序 —— 那不是本阶段的事实。） */
    const wrongOpWithRecords = requestBody({ operation: 'chat', records: [memoryRecord()] });
    const wor = await call(s.svc, wrongOpWithRecords);
    check('D4b.canonicalEvidenceRefusalPrecedesTheOperationAllowlist',
      wor.ok === false && wor.error === 'caller-attempted-to-supply-canonical-evidence'
      && wor.field === 'records',
      primaryCode(wor) + ' field=' + wor.field);

    /* ③c 静态对照：这 22 个名字既不在请求白名单里，也全在拒绝名单里。 */
    const declaredCanonical = Array.isArray(RT.CANONICAL_EVIDENCE_FIELDS) ? RT.CANONICAL_EVIDENCE_FIELDS : [];
    check('D4c.theRequestSchemaIsFlat6AndCarriesNoCanonicalName',
      RT.REQUEST_FIELDS.length === 6
      && JSON.stringify(RT.REQUEST_FIELDS.slice()) === JSON.stringify(
        ['operation', 'characterId', 'timeoutMs', 'selectedMemoryIds', 'currentState', 'roleName'])
      && CANONICAL_BEARING_NAMES.every(n => RT.REQUEST_FIELDS.indexOf(n) < 0)
      && CANONICAL_BEARING_NAMES.every(n => declaredCanonical.indexOf(n) >= 0)
      && declaredCanonical.indexOf('inputEnvelope') >= 0
      && declaredCanonical.indexOf('selectedIds') >= 0,
      'REQUEST_FIELDS=' + JSON.stringify(RT.REQUEST_FIELDS.slice())
      + ' CANONICAL_EVIDENCE_FIELDS(' + declaredCanonical.length + ')');

    /* ④ 原型污染：__proto__ 是**自有**键，因此闭集先抓住它 */
    const polluted = JSON.parse('{"operation":"memory-interpretation","characterId":"char_a","timeoutMs":1000,'
      + '"selectedMemoryIds":["m1"],"__proto__":{"provider":"evil"}}');
    const pr = await call(s.svc, polluted);
    check('D5.prototypePollutionIsRefusedAsAnUnknownOwnKey',
      pr.ok === false && pr.error === 'request-field-forbidden' && pr.field === '__proto__'
      && s.modelPort.calls.requests.every(q => !q.spec || q.spec.provider !== 'evil'),
      primaryCode(pr) + ' field=' + pr.field);

    /* ⑤ 选择集边界：0..8 由服务端强制，重复 id 不当"同一件事"处理。
          刻意**不**静默去重：去重会让调用方以为它提交的集合被接受了。 */
    const dupPort = fakePort(validBatch(['m1']));
    const dupVault = fakeCredentialAccess({ cred_a: SENTINEL });
    const dupSvc = makeService({ costPolicy: POLICY_ON, modelPort: dupPort, credentialAccess: dupVault });
    const dup = await call(dupSvc.svc, requestBody({ selectedMemoryIds: ['m1', 'm1'] }));
    check('D6.duplicateMemoryIdIsRefusedByName',
      dup.ok === false && dup.error === 'duplicate-memory-id' && dup.status === 400
      && dupPort.calls.n === 0 && dupVault.calls.resolve.length === 0,
      primaryCode(dup) + ' status=' + dup.status + ' providerCalls=' + dupPort.calls.n
      + ' vaultReads=' + dupVault.calls.resolve.length);

    const nine = Array.from({ length: 9 }, (_, i) => 'm' + i);
    const ninePort = fakePort(validBatch(['m0']));
    const nineSvc = makeService({ costPolicy: POLICY_ON, modelPort: ninePort });
    const nineRes = await call(nineSvc.svc, requestBody({ selectedMemoryIds: nine }));
    check('D7.selectionOverTheR4CMaximumIsRefused',
      nineRes.ok === false && nineRes.error === 'memory-selection-exceeds-bound' && nineRes.status === 400
      && ninePort.calls.n === 0,
      primaryCode(nineRes) + ' status=' + nineRes.status + ' providerCalls=' + ninePort.calls.n);

    const eight = Array.from({ length: 8 }, (_, i) => 'ghost' + i);
    const eightPort = fakePort(validBatch(['m1']));
    const eightVault = fakeCredentialAccess({ cred_a: SENTINEL });
    const eightSvc = makeService({ costPolicy: POLICY_ON, modelPort: eightPort, credentialAccess: eightVault });
    const eightRes = await call(eightSvc.svc, requestBody({ selectedMemoryIds: eight }));
    check('D8.eightIsInsideTheBoundAndFailsForContentNotForShape',
      eightRes.ok === false && eightRes.error === 'no-authorized-memory' && eightRes.status === 422
      && eightPort.calls.n === 0 && eightVault.calls.resolve.length === 0,
      '8 unique-but-unknown ids must pass the SHAPE gate and fail as no-authorized-memory ('
      + primaryCode(eightRes) + ' status=' + eightRes.status + ')');
    check('D8b.theDeclaredBoundComesFromTheR4CCore',
      RT.MAX_SELECTED_MEMORY_IDS === CORE.BOUNDS.MAX_MEMORIES && CORE.BOUNDS.MAX_MEMORIES === 8,
      'RT.MAX_SELECTED_MEMORY_IDS=' + RT.MAX_SELECTED_MEMORY_IDS
      + ' CORE.BOUNDS.MAX_MEMORIES=' + CORE.BOUNDS.MAX_MEMORIES);

    const emptyPort = fakePort(validBatch(['m1']));
    const emptyVault = fakeCredentialAccess({ cred_a: SENTINEL });
    const emptySvc = makeService({ costPolicy: POLICY_ON, modelPort: emptyPort, credentialAccess: emptyVault });
    const emptyRes = await call(emptySvc.svc, requestBody({ selectedMemoryIds: [] }));
    check('D8c.anEmptySelectionIsLegalButHasNothingToInterpret',
      emptyRes.ok === false && emptyRes.error === 'no-authorized-memory' && emptyRes.status === 422
      && emptyPort.calls.n === 0 && emptyVault.calls.resolve.length === 0,
      primaryCode(emptyRes) + ' status=' + emptyRes.status);
    SELECTED_SET_BOUND_ENFORCED = CALLER_CANONICAL_EVIDENCE_REFUSED
      && dup.error === 'duplicate-memory-id' && nineRes.error === 'memory-selection-exceeds-bound'
      && eightRes.error === 'no-authorized-memory' && emptyRes.error === 'no-authorized-memory'
      && RT.MAX_SELECTED_MEMORY_IDS === CORE.BOUNDS.MAX_MEMORIES;

    /* ⑥ 超时权威（与 LIVE-2.1 逐字相同：调用方显式给出，服务端不发明默认值） */
    const timeoutCases = [
      ['missing', undefined], ['zero', 0], ['negative', -1], ['NaN', NaN],
      ['numeric string', '10'], ['Infinity', Infinity], ['null', null], ['boolean', true]
    ];
    for (const [label, value] of timeoutCases) {
      const b = requestBody();
      if (value === undefined) delete b.timeoutMs; else b.timeoutMs = value;
      const r = await call(s.svc, b);
      check('D9.timeoutAuthorityMissing.' + label,
        r.ok === false && r.error === 'timeout-authority-missing' && r.status === 400,
        'value=' + String(value) + ' -> ' + primaryCode(r) + ' status=' + r.status);
    }
    check('D10.everyRefusalAboveSpentNothing',
      s.modelPort.calls.n === 0 && s.credentialAccess.calls.resolve.length === 0,
      'providerCalls=' + s.modelPort.calls.n + ' vaultReads=' + s.credentialAccess.calls.resolve.length);

    /* clamp：调用方超过安全上界时，端口看到的是 clamp 后的值 */
    const capPort = fakePort(validBatch(['m1']));
    const capSvc = makeService({ costPolicy: POLICY_ON, modelPort: capPort });
    const capRes = await call(capSvc.svc, requestBody({ timeoutMs: 10 * 60 * 1000 }));
    const effective = capPort.calls.options[0] && capPort.calls.options[0].timeoutMs;
    check('D11.overCapTimeoutIsClampedServerSide',
      capRes.ok === true && typeof effective === 'number' && effective <= RT.SAFETY_CAP_MS
      && capRes.timeoutClamped === true,
      'caller=600000 effective=' + effective + ' timeoutClamped=' + capRes.timeoutClamped);
    const exactPort = fakePort(validBatch(['m1']));
    const exactSvc = makeService({ costPolicy: POLICY_ON, modelPort: exactPort });
    await call(exactSvc.svc, requestBody({ timeoutMs: 4321 }));
    check('D12.timeoutIsNotServerInvented',
      exactPort.calls.options[0] && exactPort.calls.options[0].timeoutMs === 4321,
      'port saw ' + (exactPort.calls.options[0] && exactPort.calls.options[0].timeoutMs) + ' for caller 4321');

    /* ══ ⑦ canonical rebinding（真实 store + 真实行 · 直接面）══════════
       LIVE-3 的正文权威在这里被机械证明：调用方只给 id，provider 收到的是
       store 里那一行的内容；隐藏与缺失都只是"这一条没有被绑定"。 */
    const bindPort = fakePort(request => {
      const batch = wireBatch({ messages: request.messages });
      return { items: batch.map(m => validItem(String(m.memoryId))) };
    });
    const bindSvc = makeService({ costPolicy: POLICY_ON, modelPort: bindPort });
    const bindRes = await call(bindSvc.svc, requestBody({
      selectedMemoryIds: ['m3', 'm_missing', 'm1', 'm_hidden']
    }));
    const bindBatch = wireBatch({ messages: (bindPort.calls.requests[0] || {}).messages });
    const storeM3 = canonStore().getRecord('m3');
    const storeM1 = canonStore().getRecord('m1');
    check('D13.providerReceivesTheStoredCanonicalContentNotAnythingTheCallerWrote',
      bindRes.ok === true && bindBatch.length === 2
      && String(bindBatch[0].memoryId) === 'm3' && String(bindBatch[0].content) === String(storeM3.content)
      && String(bindBatch[1].memoryId) === 'm1' && String(bindBatch[1].content) === String(storeM1.content),
      'wireBatch=' + JSON.stringify(bindBatch.map(m => ({ memoryId: m.memoryId, content: m.content }))).slice(0, 300));
    CANONICAL_REBINDING_PROVEN = bindRes.ok === true && bindBatch.length === 2
      && String(bindBatch[0].content) === String(storeM3.content)
      && String(bindBatch[1].content) === String(storeM1.content);
    SELECTED_ID_ORDER_PRESERVED = JSON.stringify(bindBatch.map(m => String(m.memoryId))) === JSON.stringify(['m3', 'm1']);

    check('D14.selectedIdOrderIsPreservedEndToEnd',
      SELECTED_ID_ORDER_PRESERVED,
      'caller=[m3,m_missing,m1,m_hidden] bound/ordered=[' + bindBatch.map(m => m.memoryId).join(',') + ']');

    /* 隐藏（m_hidden 对 char_a 不可读）与缺失（m_missing 根本不存在）在结果里
       必须是**同一件事**：都只出现在 missingFor，都是裸字符串，没有 reason。 */
    const missingFor = Array.isArray(bindRes.missingFor) ? bindRes.missingFor : [];
    check('D15.missingAndHiddenIdsAreUniformlyOmittedIntoMissingFor',
      JSON.stringify(missingFor) === JSON.stringify(['m_missing', 'm_hidden'])
      && missingFor.every(x => typeof x === 'string')
      && JSON.stringify(bindRes.items.map(i => i.memoryId)) === JSON.stringify(['m3', 'm1']),
      'missingFor=' + JSON.stringify(missingFor) + ' items=' + JSON.stringify(bindRes.items.map(i => i.memoryId)));

    /* 只有缺失 / 只有隐藏：两次响应除 id 本身之外必须逐字相同。 */
    const shapeOf = r => JSON.stringify(Object.keys(r || {}).sort());
    const stripIds = r => JSON.stringify(r).split('m_missing').join('<ID>').split('m_hidden').join('<ID>');
    const onlyMissing = await call(makeService({ costPolicy: POLICY_ON, modelPort: fakePort(validBatch(['m1'])) }).svc,
      requestBody({ selectedMemoryIds: ['m_missing'] }));
    const onlyHidden = await call(makeService({ costPolicy: POLICY_ON, modelPort: fakePort(validBatch(['m1'])) }).svc,
      requestBody({ selectedMemoryIds: ['m_hidden'] }));
    MISSING_AND_HIDDEN_INDISTINGUISHABLE = shapeOf(onlyMissing) === shapeOf(onlyHidden)
      && stripIds(onlyMissing) === stripIds(onlyHidden)
      && onlyMissing.error === 'no-authorized-memory' && onlyHidden.error === 'no-authorized-memory'
      && onlyMissing.status === 422 && onlyHidden.status === 422;
    check('D16.missingAndHiddenAreIndistinguishableEvenWhenNothingRemains',
      MISSING_AND_HIDDEN_INDISTINGUISHABLE,
      'missing=' + primaryCode(onlyMissing) + '/' + onlyMissing.status + ' hidden='
      + primaryCode(onlyHidden) + '/' + onlyHidden.status);

    /* 零成本：没有可绑定的行 ⇒ 连 Vault 都不读（rebinding 排在 Vault 之前）。 */
    const nonePort = fakePort(validBatch(['m1']));
    const noneVault = fakeCredentialAccess({ cred_a: SENTINEL });
    const noneRes = await call(makeService({ costPolicy: POLICY_ON, modelPort: nonePort, credentialAccess: noneVault }).svc,
      requestBody({ selectedMemoryIds: ['m_hidden', 'm_missing'] }));
    check('D17.noAuthorizedMemoryReadsNoCredentialAndCallsNoProvider',
      noneRes.ok === false && noneRes.error === 'no-authorized-memory' && noneRes.status === 422
      && nonePort.calls.n === 0 && noneVault.calls.resolve.length === 0
      && boundaryOf(noneRes).providerCalls === 0 && boundaryOf(noneRes).vaultReads === 0,
      primaryCode(noneRes) + ' providerCalls=' + nonePort.calls.n
      + ' vaultReads=' + noneVault.calls.resolve.length + ' boundary=' + JSON.stringify(boundaryOf(noneRes)));

    /* 证据自述块 + 投影形状：服务端必须说明"这几条是我从 canonical 投出来的"。 */
    const evidence = bindRes.evidence && typeof bindRes.evidence === 'object' ? bindRes.evidence : {};
    const projectionFields = Array.isArray(evidence.projectionFields) ? evidence.projectionFields.map(String) : null;
    PROJECTION_FIELD_COUNT = projectionFields ? projectionFields.length : null;
    PROJECTION_FIELDS_OBSERVED = projectionFields ? projectionFields.slice() : null;
    EVIDENCE_BLOCK_SOURCE = evidence.source === undefined ? null : String(evidence.source);
    CANONICAL_REVISION_REPORTED = evidence.canonicalRevision === undefined ? null : evidence.canonicalRevision;
    check('D18.successCarriesTheServerCanonicalProjectionEvidenceBlock',
      EVIDENCE_BLOCK_SOURCE === 'SERVER_CANONICAL_PROJECTION'
      && evidence.requested === 4 && evidence.bound === 2
      && PROJECTION_FIELD_COUNT === 7
      && JSON.stringify(PROJECTION_FIELDS_OBSERVED)
        === JSON.stringify(['id', 'content', 'title', 'source', 'kind', 'valence', 'arousal'])
      && typeof CANONICAL_REVISION_REPORTED === 'number' && CANONICAL_REVISION_REPORTED >= 1
      && evidence.truncated === false,
      JSON.stringify(evidence));

    /* 投影里**不得**出现任何存储 / ACL / 激活元数据：正面看 wire 的字节。 */
    const bindWireText = String(((bindPort.calls.requests[0] || {}).messages || [])
      .map(m => m && m.content).join('\n'));
    const EXCLUDED_METADATA = ['visibleTo', 'excludeFrom', 'activationCount', 'importance',
      'createdBy', 'lastConsolidatedAt', 'CANON-HIDDEN', 'm_hidden'];
    check('D19.projectionCarriesNoStorageAclOrActivationMetadata',
      EXCLUDED_METADATA.every(tok => bindWireText.indexOf(tok) < 0)
      && bindWireText.indexOf(String(storeM1.content)) >= 0,
      'leaked=' + JSON.stringify(EXCLUDED_METADATA.filter(tok => bindWireText.indexOf(tok) >= 0)));

    /* 证据状态：服务端**不**声称 MetaMemory 证据态（evidence map 不存在），
       因此核心给出的 systemEvidenceState 恒为 null —— 调用方也再无法提供它。 */
    SYSTEM_EVIDENCE_STATE_IS_NULL = bindBatch.every(m => m.systemEvidenceState === null);
    check('D20.systemEvidenceStateIsNullBecauseTheServerClaimsNoEvidenceState',
      SYSTEM_EVIDENCE_STATE_IS_NULL
      && CANONICAL_BEARING_NAMES.indexOf('evidenceState') >= 0,
      'wire systemEvidenceState=' + JSON.stringify(bindBatch.map(m => m.systemEvidenceState)));
  }

  /* ══════════════════════════════════════════════════════════════════════
     E · character runtime spec authority + cross-character
     ══════════════════════════════════════════════════════════════════════ */
  section('E · runtime spec authority');
  {
    const port = fakePort(validBatch(['m1']));
    const registry = fakeRegistry({ char_a: specA(), char_b: specB() });
    const vault = fakeCredentialAccess({ cred_a: SENTINEL, cred_b: SENTINEL + '_B' });
    const s = makeService({ costPolicy: POLICY_ON, modelPort: port, registry: registry, credentialAccess: vault });

    const ra = await call(s.svc, requestBody({ characterId: 'char_a' }));
    const specSeenA = port.calls.requests[0] && port.calls.requests[0].spec;
    check('E1.characterASpecReachedThePort',
      ra.ok === true && specSeenA && specSeenA.provider === 'custom'
      && specSeenA.model === 'model-a' && specSeenA.endpoint === ENDPOINT_A,
      JSON.stringify(specSeenA));

    const rb = await call(s.svc, requestBody({ characterId: 'char_b' }));
    const specSeenB = port.calls.requests[1] && port.calls.requests[1].spec;
    check('E2.crossCharacterRequestResolvesItsOwnSpec',
      rb.ok === true && specSeenB && specSeenB.model === 'model-b' && specSeenB.endpoint === ENDPOINT_B
      && specSeenB.endpoint !== specSeenA.endpoint
      && JSON.stringify(port.calls.requests[1]).indexOf(ENDPOINT_A) < 0,
      JSON.stringify(specSeenB));
    check('E3.specLookupIsOnlyViaGetCharacterSpec',
      registry.calls.getCharacterSpec.indexOf('char_a') >= 0
      && registry.calls.getCharacterSpec.indexOf('char_b') >= 0
      && registry.calls.listCharacters === 0,
      'lookups=' + JSON.stringify(registry.calls.getCharacterSpec)
      + ' listCharacters=' + registry.calls.listCharacters);

    const beforeUnknown = port.calls.n;
    const ru = await call(s.svc, requestBody({ characterId: 'ghost' }));
    check('E4.unknownCharacterIsRuntimeSpecUnavailable',
      ru.ok === false && ru.error === 'runtime-spec-unavailable' && ru.status === 404
      && port.calls.n === beforeUnknown,
      primaryCode(ru) + ' status=' + ru.status + ' providerCalls=' + (port.calls.n - beforeUnknown));

    const apiKeyOnly = fakeRegistry({ char_a: specA({ credentialRef: undefined, apiKey: 'sk-plaintext-should-not-be-honored' }) });
    const apiKeyPort = fakePort(validBatch(['m1']));
    const apiKeySvc = makeService({ costPolicy: POLICY_ON, modelPort: apiKeyPort, registry: apiKeyOnly });
    const rk = await call(apiKeySvc.svc, requestBody());
    check('E5.plaintextApiKeySpecIsRefusedNoFallback',
      rk.ok === false && rk.error === 'runtime-spec-unavailable' && apiKeyPort.calls.n === 0,
      primaryCode(rk) + ' providerCalls=' + apiKeyPort.calls.n);

    const unauthorized = fakeCredentialAccess({});
    const unauthorizedPort = fakePort(validBatch(['m1']));
    const unauthorizedSvc = makeService({
      costPolicy: POLICY_ON, modelPort: unauthorizedPort,
      registry: fakeRegistry({ char_a: specA({ credentialRef: 'ref_not_allowed' }) }),
      credentialAccess: unauthorized
    });
    const rc = await call(unauthorizedSvc.svc, requestBody());
    check('E6.unauthorizedBindingFailsClosedWithCredentialUnavailable',
      rc.ok === false && rc.error === 'credential-unavailable' && rc.status === 503
      && unauthorizedPort.calls.n === 0 && unauthorized.calls.resolve.length === 1
      && JSON.stringify(rc).indexOf('ref_not_allowed') < 0,
      primaryCode(rc) + ' vaultReads=' + unauthorized.calls.resolve.length + ' providerCalls=' + unauthorizedPort.calls.n);

    const noVaultPort = fakePort(validBatch(['m1']));
    const noVault = makeService({ costPolicy: POLICY_ON, modelPort: noVaultPort, credentialAccess: null });
    const rv = await call(noVault.svc, requestBody());
    check('E7.missingCredentialAccessFailsClosedWithoutThrowing',
      rv.ok === false && rv.error === 'credential-unavailable' && noVaultPort.calls.n === 0,
      primaryCode(rv) + ' providerCalls=' + noVaultPort.calls.n);

    const noReg = makeService({ costPolicy: POLICY_ON, registry: null });
    const rr = await call(noReg.svc, requestBody());
    check('E8.missingRegistryIsRuntimeSpecUnavailable',
      rr.ok === false && rr.error === 'runtime-spec-unavailable' && noReg.modelPort.calls.n === 0,
      primaryCode(rr));

    const noPort = makeService({ costPolicy: POLICY_ON, modelPort: null });
    const rp = await call(noPort.svc, requestBody());
    check('E9.missingModelPortIsCaughtBeforeAnySpecOrVaultRead',
      rp.ok === false && rp.error === 'model-port-unavailable' && rp.status === 503
      && boundaryOf(rp).vaultReads === 0 && noPort.credentialAccess.calls.resolve.length === 0,
      primaryCode(rp) + ' vaultReads=' + boundaryOf(rp).vaultReads);

    /* 浏览器能表达的东西**结构上**改不了端口收到什么 */
    const evilTop = requestBody({ provider: 'evil', model: 'evil-model', endpoint: 'https://evil.invalid' });
    const re = await call(s.svc, evilTop);
    check('E10.browserSuppliedAuthorityCanNeverReachThePort',
      re.ok === false && re.error === 'request-field-forbidden'
      && port.calls.requests.every(q => JSON.stringify(q).indexOf('evil.invalid') < 0),
      primaryCode(re));
  }

  /* ══════════════════════════════════════════════════════════════════════
     F · Vault + sentinel containment（真实 Vault + 真实 NodeModelPort）
     ══════════════════════════════════════════════════════════════════════ */
  section('F · vault + sentinel containment');
  let fDir = null;
  try {
    fDir = freshDir('ib-interp-f-');
    const vaultFile = path.join(fDir, 'credential-vault.json');
    seedVault(fDir, 'cred_a', 'custom', SENTINEL);
    const vaultBefore = { sha256: sha256File(vaultFile), mtimeMs: fs.statSync(vaultFile).mtimeMs, bytes: fs.statSync(vaultFile).size };
    const credAccess = CREDENTIAL_ACCESS({ dataDir: fDir, isAllowed: id => id === 'cred_a' });
    const rec = [];
    const port = NODE_MODEL_PORT({ fetch: jsonProviderFetch(rec, validBatch(['m1'])) });
    const logs = [];
    const s = makeService({ costPolicy: POLICY_ON, modelPort: port, credentialAccess: credAccess, logs: logs });
    const r = await call(s.svc, requestBody());
    check('F1.successfulCallThroughTheRealProviderPort',
      r.ok === true && rec.length === 1,
      'ok=' + r.ok + ' fetchCalls=' + rec.length + ' error=' + primaryCode(r));

    const transportText = JSON.stringify(rec);
    const hits = transportText.split(SENTINEL).length - 1;
    check('F2.sentinelAppearsExactlyOnceInTheProviderRequest',
      hits === 1 && transportText.indexOf(ENDPOINT_A) >= 0,
      'occurrences=' + hits + ' (url+headers+body of the ONE fetch call)');
    check('F3.theOnePlaceIsTheAuthorizationHeader',
      rec[0] && rec[0].headers && rec[0].headers.Authorization === 'Bearer ' + SENTINEL
      && rec[0].url.indexOf(SENTINEL) < 0,
      'Authorization=' + (rec[0] && rec[0].headers && String(rec[0].headers.Authorization).replace(SENTINEL, '<sentinel>')));

    check('F4.sentinelAbsentFromTheServiceResult',
      JSON.stringify(r).indexOf(SENTINEL) < 0, 'service result leaks the secret');
    check('F5.sentinelAbsentFromTheRecordedLogs',
      JSON.stringify(logs).indexOf(SENTINEL) < 0, JSON.stringify(logs).slice(0, 300));
    check('F6.sentinelAbsentFromDescribe',
      typeof s.svc.describe === 'function' && JSON.stringify(s.svc.describe()).indexOf(SENTINEL) < 0);
    check('F7.sentinelAbsentFromTheSpecEchoColumns',
      JSON.stringify(r).indexOf('cred_a') < 0 && JSON.stringify(r).indexOf('SYS-A') < 0,
      'spec credentialRef / systemPrompt must not be echoed; observed result keys='
      + JSON.stringify(Object.keys(r || {})));

    /* provider-error 路径：provider 把 secret 抄回错误文本时必须掩码 */
    const errRec = [];
    const errPort = NODE_MODEL_PORT({ fetch: failingProviderFetch(errRec, new Error('upstream echoed ' + SENTINEL + ' and ' + ENDPOINT_A)) });
    const errSvc = makeService({ costPolicy: POLICY_ON, modelPort: errPort, credentialAccess: credAccess });
    const er = await call(errSvc.svc, requestBody());
    check('F8.providerErrorEnvelopeCarriesNoSentinel',
      er.ok === false && er.error === 'provider-error'
      && JSON.stringify(er).indexOf(SENTINEL) < 0,
      primaryCode(er) + ' detail=' + String(er.detail).slice(0, 120));

    /* timeout 路径（真实端口 + 挂起的 fake fetch：secret 已经到达 provider）*/
    const timeoutRec = [];
    const observe = { aborted: false };
    const hangPort = NODE_MODEL_PORT({ fetch: hangingProviderFetch(timeoutRec, observe) });
    const timeoutSvc = makeService({ costPolicy: POLICY_ON, modelPort: hangPort, credentialAccess: credAccess });
    const tr = await callGuarded(timeoutSvc.svc, requestBody({ timeoutMs: 60 }), undefined, 4000);
    check('F9.timeoutEnvelopeCarriesNoSentinel',
      tr.ok === false && tr.error === 'timeout'
      && JSON.stringify(tr).indexOf(SENTINEL) < 0
      && timeoutRec.length === 1
      && timeoutRec[0].headers.Authorization === 'Bearer ' + SENTINEL,
      primaryCode(tr) + ' fetchCalls=' + timeoutRec.length);

    /* credential-unavailable 路径 */
    const cuSvc = makeService({ costPolicy: POLICY_ON, credentialAccess: CREDENTIAL_ACCESS({ dataDir: fDir, isAllowed: () => false }) });
    const cu = await call(cuSvc.svc, requestBody());
    check('F10.credentialUnavailableEnvelopeCarriesNoSentinel',
      cu.ok === false && cu.error === 'credential-unavailable' && JSON.stringify(cu).indexOf(SENTINEL) < 0,
      primaryCode(cu));
    const vaultAfter = { sha256: sha256File(vaultFile), mtimeMs: fs.statSync(vaultFile).mtimeMs, bytes: fs.statSync(vaultFile).size };
    check('F11.vaultFileWasOnlyEverRead',
      vaultBefore.bytes > 0 && vaultAfter.sha256 === vaultBefore.sha256
      && vaultAfter.mtimeMs === vaultBefore.mtimeMs,
      JSON.stringify({ before: vaultBefore, after: vaultAfter }));
  } finally {
    if (fDir) dropDir(fDir);
  }

  /* ══════════════════════════════════════════════════════════════════════
     G · one call / no retry
     ══════════════════════════════════════════════════════════════════════ */
  section('G · one call · no retry');
  {
    check('G1.autoRetryIsNone',
      RT.AUTO_RETRY === 'NONE' && RT.MAX_ATTEMPTS === 1,
      'AUTO_RETRY=' + RT.AUTO_RETRY + ' MAX_ATTEMPTS=' + RT.MAX_ATTEMPTS);

    const rtCode = WIRING.stripJsComments(readFile('services/home-node/runtime-interpretation.js'));
    check('G2.serviceModuleContainsNoRetryLoop',
      !/while\s*\(/.test(rtCode)
      && !/\bfor\s*\([^)]*attempt/i.test(rtCode)
      && !/\bretry\b/i.test(rtCode)
      && !/attempts\s*\+\+/.test(rtCode)
      && (rtCode.match(/attempts\s*=\s*1\s*;/g) || []).length === 1,
      'no while-loop, no attempt-driven for-loop, no retry identifier, one `attempts = 1` site');

    const successes = [['success', validBatch(['m1'])]];
    for (const [label, payload] of successes) {
      const p = fakePort(payload);
      const s = makeService({ costPolicy: POLICY_ON, modelPort: p });
      const r = await call(s.svc, requestBody());
      check('G3.oneCallFor.' + label,
        r.ok === true && p.calls.n === 1 && boundaryOf(r).providerCalls === 1
        && s.svc.describe().counters.providerCalls === 1,
        'providerCalls=' + p.calls.n + ' boundary=' + boundaryOf(r).providerCalls);
    }

    const failurePorts = [
      ['providerThrows', fakePort('throw')],
      ['invalidJson', fakePort('{not json')],
      ['validatorRejectsEverything', fakePort({ items: [] })],
      ['network', fakePort('network')]
    ];
    for (const [label, p] of failurePorts) {
      const s = makeService({ costPolicy: POLICY_ON, modelPort: p });
      const r = await call(s.svc, requestBody());
      check('G4.atMostOneCallFor.' + label,
        r.ok === false && p.calls.n <= 1,
        label + ' providerCalls=' + p.calls.n + ' code=' + primaryCode(r));
    }
    const hang = fakePort('hang');
    const hangSvc = makeService({ costPolicy: POLICY_ON, modelPort: hang });
    const hr = await callGuarded(hangSvc.svc, requestBody({ timeoutMs: 60 }), undefined, 4000);
    check('G5.atMostOneCallFor.timeout',
      hr.ok === false && hang.calls.n <= 1,
      'providerCalls=' + hang.calls.n);

    const aborted = new AbortController();
    aborted.abort();
    const prePort = fakePort(validBatch(['m1']));
    const preSvc = makeService({ costPolicy: POLICY_ON, modelPort: prePort });
    const pr = await call(preSvc.svc, requestBody(), { signal: aborted.signal });
    check('G6.preAbortedCallNeverReachesTheProvider',
      pr.ok === false && pr.error === 'aborted' && prePort.calls.n === 0,
      primaryCode(pr) + ' providerCalls=' + prePort.calls.n);
  }

  /* ══════════════════════════════════════════════════════════════════════
     H · timeout authority（有界等待）
     ══════════════════════════════════════════════════════════════════════ */
  section('H · timeout');
  {
    const port = fakePort('hang');
    const s = makeService({ costPolicy: POLICY_ON, modelPort: port });
    const t0 = Date.now();
    const r = await callGuarded(s.svc, requestBody({ timeoutMs: 60 }), undefined, 4000);
    const elapsed = Date.now() - t0;
    check('H1.hangingPortTimesOutInABoundedWindow',
      r.ok === false && r.error === 'timeout' && r.status === 504 && elapsed >= 30 && elapsed < 3000,
      primaryCode(r) + ' status=' + r.status + ' elapsedMs=' + elapsed);
    check('H2.portSawTheCallersTimeoutVerbatim',
      port.calls.n === 1 && port.calls.options[0] && port.calls.options[0].timeoutMs === 60,
      'port saw ' + (port.calls.options[0] && port.calls.options[0].timeoutMs) + ' for caller 60');
    check('H3.timeoutIsNotRetried',
      port.calls.n === 1 && r.model && r.model.attempts === 1,
      'providerCalls=' + port.calls.n + ' attempts=' + (r.model && r.model.attempts));
    check('H4.timeoutIsTheServersBoundedWaitNotAProviderClaim',
      (r.detail === 'bounded-wait-expired' || r.detail === 'provider-timeout')
      && !/cost[_ -]?stop/i.test(JSON.stringify(r)),
      'detail=' + r.detail + ' (the boundary claims only that ITS wait ended)');

    const capPort = fakePort('hang');
    const capSvc = makeService({ costPolicy: POLICY_ON, modelPort: capPort });
    const capOuter = new AbortController();
    const capPending = call(capSvc.svc, requestBody({ timeoutMs: 999999 }), { signal: capOuter.signal });
    await new Promise(r => setTimeout(r, 40));
    capOuter.abort();
    const capResult = await capPending;
    check('H5.overCapTimeoutIsClampedBeforeThePort',
      capPort.calls.options[0] && capPort.calls.options[0].timeoutMs === RT.SAFETY_CAP_MS
      && capResult.ok === false,
      'port saw ' + (capPort.calls.options[0] && capPort.calls.options[0].timeoutMs)
      + ' (caller 999999) result=' + primaryCode(capResult));
  }

  /* ══════════════════════════════════════════════════════════════════════
     I · failure semantics（每个失败都是 ok:false + 稳定码 + durable:false）
     ══════════════════════════════════════════════════════════════════════ */
  section('I · failure semantics');
  {
    const cases = [];
    const mk = (label, code, extra) => cases.push(Object.assign({ label: label, code: code }, extra || {}));

    mk('disabled', 'disabled', { service: () => makeService({ costPolicy: undefined }) });
    mk('operationForbidden', 'operation-forbidden', {
      service: () => makeService({ costPolicy: POLICY_ON }),
      body: () => requestBody({ operation: 'chat' })
    });
    mk('runtimeSpecUnavailable', 'runtime-spec-unavailable', {
      service: () => makeService({ costPolicy: POLICY_ON, registry: fakeRegistry({}) })
    });
    mk('credentialUnavailable', 'credential-unavailable', {
      service: () => makeService({ costPolicy: POLICY_ON, credentialAccess: fakeCredentialAccess({}) })
    });
    mk('timeoutAuthorityMissing', 'timeout-authority-missing', {
      service: () => makeService({ costPolicy: POLICY_ON }),
      body: () => { const b = requestBody(); delete b.timeoutMs; return b; }
    });
    mk('timeout', 'timeout', {
      service: () => makeService({ costPolicy: POLICY_ON, modelPort: fakePort('hang') }),
      body: () => requestBody({ timeoutMs: 60 }), guard: 4000
    });
    mk('providerError', 'provider-error', {
      service: () => makeService({ costPolicy: POLICY_ON, modelPort: fakePort('throw') })
    });
    mk('network', 'network', {
      service: () => makeService({ costPolicy: POLICY_ON, modelPort: fakePort('network') })
    });
    mk('invalidOutput', 'invalid-output', {
      service: () => makeService({ costPolicy: POLICY_ON, modelPort: fakePort('{not json') })
    });
    mk('modelPortUnavailable', 'model-port-unavailable', {
      service: () => makeService({ costPolicy: POLICY_ON, modelPort: null })
    });
    mk('noAuthorizedMemory', 'no-authorized-memory', {
      service: () => makeService({ costPolicy: POLICY_ON }),
      body: () => requestBody({ selectedMemoryIds: ['ghost-id'] })
    });

    for (const c of cases) {
      const s = c.service();
      const r = c.guard
        ? await callGuarded(s.svc, (c.body || requestBody)(), undefined, c.guard)
        : await call(s.svc, (c.body || requestBody)());
      check('I1.failureCode.' + c.label,
        r.ok === false && primaryCode(r) === c.code,
        'expected=' + c.code + ' actual=' + primaryCode(r) + ' codes=' + JSON.stringify(codesOf(r).slice(0, 6)));
      check('I2.nonDurableEnvelope.' + c.label,
        r.durable === false && boundaryOf(r).durable === false
        && itemsOf(r).length === 0
        && r.metaMemoryState === null && r.recollectionQuality === null,
        'durable=' + r.durable + ' boundary.durable=' + boundaryOf(r).durable
        + ' items=' + itemsOf(r).length);
      check('I3.statusMatchesTheDeclaredTable.' + c.label,
        r.status === RT.STATUS_BY_REASON[c.code] || r.status === 502,
        'status=' + r.status + ' declared=' + RT.STATUS_BY_REASON[c.code]);
    }

    const netPort = fakePort('network');
    const netSvc = makeService({ costPolicy: POLICY_ON, modelPort: netPort });
    const nr = await call(netSvc.svc, requestBody());
    check('I4.econnrefusedShapeIsClassifiedAsNetwork',
      nr.error === 'network' && hasCode(nr, 'model-transport-error'),
      primaryCode(nr) + ' codes=' + JSON.stringify(codesOf(nr)));
    check('I5.networkIsNotProviderError',
      nr.error !== 'provider-error' && nr.detail === 'transport-network',
      'detail=' + nr.detail);

    const strictErr = makeService({
      costPolicy: POLICY_ON,
      modelPort: fakePort(() => Promise.reject(new Error('plain provider failure')))
    });
    const strictRes = await call(strictErr.svc, requestBody());
    check('I6.plainProviderFailureIsNotMisclassifiedAsNetwork',
      strictRes.error === 'provider-error' && strictRes.error !== 'network',
      primaryCode(strictRes));

    check('I7.serverCoreNeverThrows', THROWN.length === 0,
      'observed throws: ' + JSON.stringify(THROWN.slice(0, 5)));
    check('I8.noInvocationHungTheGuardedWait', HUNG.length === 0,
      'guarded waits that timed out: ' + HUNG.length);
  }

  /* ══════════════════════════════════════════════════════════════════════
     J · structured output attacks（同一份 R4-C validator）
     ══════════════════════════════════════════════════════════════════════ */
  section('J · structured output attacks');
  {
    const attacks = [
      ['forgedEvidenceConfidence', { items: [Object.assign(validItem('m1'), { evidenceConfidence: 0.9 })] },
        'model-shape-invalid', 'model-returned-no-valid-item'],
      ['oversizedMeaning', { items: [Object.assign(validItem('m1'), { meaning: 'x'.repeat(601) })] },
        'model-field-exceeds-bound', 'model-returned-no-valid-item'],
      ['partialObjectMissingMeaning', { items: [{ memoryId: 'm1', appraisal: 'mixed', basis: 'ai_inference' }] },
        'model-missing-required-field', 'model-returned-no-valid-item'],
      ['enumOutOfVocabulary', { items: [Object.assign(validItem('m1'), { appraisal: 'ecstatic' })] },
        'model-enum-out-of-vocabulary', 'model-returned-no-valid-item'],
      ['confidenceOutOfRange', { items: [Object.assign(validItem('m1'), { subjectiveConfidence: 1.4 })] },
        'model-confidence-out-of-range', 'model-confidence-out-of-range'],
      ['emptyBatch', { items: [] }, 'model-returned-no-valid-item', 'model-returned-no-valid-item']
    ];
    for (const [label, payload, expectedItemReason, expectedPrimary] of attacks) {
      const p = fakePort(payload);
      const s = makeService({ costPolicy: POLICY_ON, modelPort: p });
      const r = await call(s.svc, requestBody());
      const rejected = rejectedOf(r);
      check('J1.validatorRejects.' + label,
        r.ok === false && itemsOf(r).length === 0
        && (hasCode(r, expectedItemReason) || rejected.some(x => x.reason === expectedItemReason))
        && primaryCode(r) === expectedPrimary
        && p.calls.n === 1 && r.durable === false,
        'primary=' + primaryCode(r) + ' codes=' + JSON.stringify(codesOf(r).slice(0, 6))
        + ' rejected=' + JSON.stringify(rejected.map(x => x.reason)));
    }

    /* unknown id：伪造 id 必须被拒，且**绝不**进入 items */
    const unknown = fakePort({ items: [Object.assign(validItem('ghost'), { memoryId: 'ghost' })] });
    const unknownSvc = makeService({ costPolicy: POLICY_ON, modelPort: unknown });
    const ur = await call(unknownSvc.svc, requestBody());
    check('J2.forgedMemoryIdIsRejected',
      ur.ok === false && ur.error === 'model-returned-unknown-memory-id'
      && itemsOf(ur).length === 0
      && rejectedOf(ur).some(x => x.reason === 'model-returned-unknown-memory-id'),
      primaryCode(ur) + ' rejected=' + JSON.stringify(rejectedOf(ur).map(x => x.reason)));

    /* duplicate：R4-C 语义 = 保留第一条、拒绝其余（因此**不是** ok:false） */
    const dup = fakePort({ items: [validItem('m1'), validItem('m1')] });
    const dupSvc = makeService({ costPolicy: POLICY_ON, modelPort: dup });
    const dr = await call(dupSvc.svc, requestBody());
    check('J3.duplicateIdKeepsFirstAndRejectsTheRest',
      dr.ok === true && itemsOf(dr).length === 1 && itemsOf(dr)[0].memoryId === 'm1'
      && rejectedOf(dr).some(x => x.reason === 'model-returned-duplicate-memory-id')
      && dup.calls.n === 1,
      'ok=' + dr.ok + ' items=' + itemsOf(dr).length
      + ' rejected=' + JSON.stringify(rejectedOf(dr).map(x => x.reason)));

    /* 校验器复用：核心对同一份 payload 的结论必须与服务一致 */
    const crossCheck = CORE.validateResponse({ items: [Object.assign(validItem('m1'), { appraisal: 'ecstatic' })] }, { allowedIds: ['m1'] });
    const crossPort = fakePort({ items: [Object.assign(validItem('m1'), { appraisal: 'ecstatic' })] });
    const crossSvc = makeService({ costPolicy: POLICY_ON, modelPort: crossPort });
    const cross = await call(crossSvc.svc, requestBody());
    check('J4.boundaryAgreesWithTheSingleCoreValidator',
      crossCheck.ok === false && cross.ok === false
      && crossCheck.rejected[0].reason === 'model-enum-out-of-vocabulary'
      && rejectedOf(cross).some(x => x.reason === crossCheck.rejected[0].reason),
      'core=' + JSON.stringify(crossCheck.rejected.map(x => x.reason))
      + ' boundary=' + JSON.stringify(rejectedOf(cross).map(x => x.reason)));

    check('J5.providerTextNeverReachesTheCallerVerbatim',
      JSON.stringify(cross).indexOf('ecstatic') < 0
      && rejectedOf(cross).every(x => x.item === undefined && x.raw === undefined && x.payload === undefined)
      && JSON.stringify(cross).indexOf('"items":[{"memoryId"') < 0,
      'the rejected model item is reported as a reason, never echoed as raw provider payload');
    check('J6.serverCoreNeverThrewDuringAttacks', THROWN.length === 0, JSON.stringify(THROWN.slice(0, 5)));
  }

  /* ══════════════════════════════════════════════════════════════════════
     K/L · real tmp-dir Home Node instance：非持久探针 + HTTP 传输
     ══════════════════════════════════════════════════════════════════════ */
  const remote = await pickRemoteAddress();
  console.log('\n# remote posture address: '
    + (remote ? remote.address + ' (' + remote.kind + ')' : 'UNAVAILABLE'));

  let probe = null;
  try {
    section('K · non-durable probe (real tmp-dir Home Node)');
    const dataDir = freshDir('ib-interp-data-');
    const credentialDataDir = freshDir('ib-interp-cred-');
    const vaultFile = path.join(credentialDataDir, 'credential-vault.json');
    seedVault(credentialDataDir, 'cred_a', 'custom', SENTINEL);
    const fetchRec = [];
    /* ★ 记录型 fake fetch：应答按**它自己收到的批次**生成，因此
       "服务端投影了什么、按什么顺序"是可从 wire 直接读出的证据。 */
    const probePort = NODE_MODEL_PORT({ fetch: recordingProviderFetch(fetchRec) });
    const inst = SERVICE.buildHomeNode({
      dataDir: dataDir,
      credentialDataDir: credentialDataDir,
      token: ADMIN_TOKEN,
      port: probePort,
      runtimeInterpretationPolicy: POLICY_ON,
      logger: () => {}
    });
    inst.open();
    const published = inst.registry.putCharacter(
      'char_a',
      { id: 'char_a', name: 'A', relationship: 'friend' },
      { provider: 'custom', model: 'model-a', endpoint: ENDPOINT_A, credentialRef: 'cred_a', systemPrompt: 'SYS-A' }
    );
    check('K1.instanceAssembledWithTheBoundaryEnabled',
      published && published.ok === true && !!inst.runtimeInterpretation
      && typeof inst.runtimeInterpretation.run === 'function',
      JSON.stringify(published));

    /* ★ 真实 canonical 行由**这个实例自己的 store** 写入。LIVE-3 的正文权威
       就落在这一行数据上 —— 它不能来自请求体（请求体里已经没有那个通道）。 */
    const seededRows = [
      canonicalRow('m1', { content: 'K-CANON-M1' }),
      canonicalRow('m2', { content: 'K-CANON-M2' }),
      canonicalRow('m3', { content: 'K-CANON-M3' }),
      canonicalRow('m_b', { content: 'K-CANON-B-ONLY', visibility: 'only', visibleTo: ['char_b'] })
    ].map(row => inst.memoryStore.putRecord(row));
    check('K1b.realCanonicalRowsAreInThisInstancesOwnStore',
      seededRows.every(r => r && r.ok === true)
      && !!inst.memoryStore.getRecord('m1') && inst.memoryStore.getRecord('m1').content === 'K-CANON-M1'
      && !!inst.memoryStore.getRecord('m_b'),
      JSON.stringify(seededRows.map(r => r && r.outcome)));

    const port = await listen(inst.server, '127.0.0.1');
    probe = { inst: inst, dataDir: dataDir, credentialDataDir: credentialDataDir, vaultFile: vaultFile, port: port, fetchRec: fetchRec };

    const snapshot = () => {
      const out = { errors: [] };
      const attempt = (name, fn) => { try { out[name] = fn(); } catch (e) { out.errors.push(name + ': ' + String((e && e.message) || e)); } };
      attempt('memory', () => {
        const p = inst.memoryStore.listRecords({});
        return { ok: p.ok, count: p.count, revision: p.revision, ids: (p.records || []).map(r => r.id) };
      });
      attempt('memoryChanges', () => {
        const c = inst.memoryStore.changesAfter(0, { limit: 1000 });
        return { revision: c.revision, cursor: c.cursor, upserts: (c.upserts || []).length, deletes: (c.deletes || []).length };
      });
      attempt('memoryMeta', () => {
        const m = inst.memoryStore.meta();
        return { revision: m.revision, records: m.records, allRecords: m.allRecords, owners: m.owners };
      });
      attempt('understanding', () => {
        const w = inst.understandingStore.getWatermark('char_a');
        const a = inst.understandingStore.getActive('char_a');
        return { watermark: w, activeId: a ? a.id : null, activeRevision: a ? a.revision : null };
      });
      attempt('chat', () => {
        const m = inst.store.meta();
        return { revision: m.revision, insertSeq: m.insertSeq, messages: m.messages, allMessages: m.allMessages, conversations: m.conversations };
      });
      attempt('vault', () => {
        const stat = fs.statSync(vaultFile);
        return { bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256File(vaultFile) };
      });
      return out;
    };

    const before = snapshot();
    check('K2.snapshotIsComplete',
      before.errors.length === 0 && !!before.memory && !!before.memoryChanges
      && !!before.understanding && !!before.chat && !!before.vault,
      JSON.stringify(before.errors));

    const admin = { 'X-IB-Home-Token': ADMIN_TOKEN };
    const okRes = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin,
      body: requestBody({ timeoutMs: 2000 })
    });
    const after = snapshot();

    check('K3.httpCallSucceededThroughTheRealBoundary',
      okRes.status === 200 && okRes.body && okRes.body.ok === true,
      'status=' + okRes.status + ' error=' + (okRes.body && okRes.body.error));
    check('K4.resultIsAlwaysNonDurable',
      okRes.body.durable === false && okRes.body.metaMemoryState === null
      && okRes.body.recollectionQuality === null
      && okRes.body.model && okRes.body.model.attempts === 1
      && okRes.body.boundary && okRes.body.boundary.durable === false,
      JSON.stringify({ durable: okRes.body.durable, metaMemoryState: okRes.body.metaMemoryState, attempts: okRes.body.model && okRes.body.model.attempts }));
    check('K5.credentialWasActuallyReadFromTheRealVault',
      fetchRec.length === 1
      && fetchRec[0].headers.Authorization === 'Bearer ' + SENTINEL
      && okRes.body.boundary.vaultReads === 1,
      'fetchCalls=' + fetchRec.length + ' vaultReads=' + (okRes.body.boundary && okRes.body.boundary.vaultReads));
    check('K6.vaultFileBytesAndMtimeUnchanged',
      before.vault.sha256 === after.vault.sha256 && before.vault.mtimeMs === after.vault.mtimeMs,
      JSON.stringify({ before: before.vault, after: after.vault }));
    check('K7.memoryRecordsCountAndRevisionUnchanged',
      JSON.stringify(before.memory) === JSON.stringify(after.memory)
      && JSON.stringify(before.memoryMeta) === JSON.stringify(after.memoryMeta),
      JSON.stringify({ before: before.memory, after: after.memory }));
    check('K8.memoryChangeFeedUnchanged',
      JSON.stringify(before.memoryChanges) === JSON.stringify(after.memoryChanges),
      JSON.stringify({ before: before.memoryChanges, after: after.memoryChanges }));
    check('K9.understandingRevisionAndWatermarkUnchanged',
      JSON.stringify(before.understanding) === JSON.stringify(after.understanding),
      JSON.stringify({ before: before.understanding, after: after.understanding }));
    check('K10.chatStoreMetaUnchanged',
      JSON.stringify(before.chat) === JSON.stringify(after.chat),
      JSON.stringify({ before: before.chat, after: after.chat }));

    /* 失败调用同样零持久变更 */
    const failRes = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin,
      body: requestBody({ characterId: 'ghost', timeoutMs: 2000 })
    });
    const afterFailure = snapshot();
    check('K11.failingCallMutatesNothingEither',
      failRes.status === 404 && failRes.body.error === 'runtime-spec-unavailable'
      && JSON.stringify(after) === JSON.stringify(afterFailure),
      'status=' + failRes.status + ' diff=' + JSON.stringify({
        memory: JSON.stringify(after.memory) !== JSON.stringify(afterFailure.memory),
        vault: JSON.stringify(after.vault) !== JSON.stringify(afterFailure.vault)
      }));

    /* F 的 HTTP 面：整段响应文本里没有 secret */
    check('K12.httpResponseTextCarriesNoSentinel',
      okRes.raw.indexOf(SENTINEL) < 0 && failRes.raw.indexOf(SENTINEL) < 0,
      'raw response bytes scanned');
    check('K13.serviceResultCarriesNoSentinel',
      JSON.stringify(okRes.body).indexOf(SENTINEL) < 0
      && JSON.stringify(inst.runtimeInterpretation.describe()).indexOf(SENTINEL) < 0);

    /* ══ K14 · HTTP 面 canonical rebinding（真实实例 + 真实 store + 真实路由）══
       这是本阶段最强的一条证据：请求里**只有 id**，而 wire 上是 canonical 正文
       —— 并且顺序就是 selectedMemoryIds 的顺序。 */
    const beforeRebind = fetchRec.length;
    const rebindRes = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin,
      body: requestBody({ timeoutMs: 2000, selectedMemoryIds: ['m3', 'm_missing', 'm1', 'm_b'] })
    });
    const rebindWire = fetchRec.length > beforeRebind ? fetchRec[fetchRec.length - 1].wire : null;
    const rebindBatch = wireBatch(rebindWire);
    const rebindEvidence = (rebindRes.body && rebindRes.body.evidence) || {};
    check('K14.httpRequestWithIdsOnlyIsReboundToRealCanonicalRows',
      rebindRes.status === 200 && rebindRes.body.ok === true
      && JSON.stringify(rebindBatch.map(m => String(m.memoryId))) === JSON.stringify(['m3', 'm1'])
      && String(rebindBatch[0].content) === 'K-CANON-M3'
      && String(rebindBatch[1].content) === 'K-CANON-M1'
      && rebindEvidence.source === 'SERVER_CANONICAL_PROJECTION'
      && rebindEvidence.requested === 4 && rebindEvidence.bound === 2,
      'status=' + rebindRes.status + ' batch='
      + JSON.stringify(rebindBatch.map(m => ({ id: m.memoryId, content: m.content }))).slice(0, 300)
      + ' evidence=' + JSON.stringify(rebindEvidence));

    check('K15.missingAndHiddenIdsAreOmittedUniformlyIntoMissingFor',
      JSON.stringify(rebindRes.body.missingFor) === JSON.stringify(['m_missing', 'm_b'])
      && rebindRes.body.missingFor.every(x => typeof x === 'string')
      && rebindBatch.every(m => String(m.content).indexOf('K-CANON-B-ONLY') < 0)
      && String((fetchRec[fetchRec.length - 1] || {}).bodyText || '').indexOf('K-CANON-B-ONLY') < 0,
      'missingFor=' + JSON.stringify(rebindRes.body.missingFor)
      + ' (m_b is a REAL row that char_a may not read; m_missing does not exist)');

    /* 只选一条"对 char_a 隐藏"的**真实**行：没有任何可解释的行 ⇒ 在 Vault 之前
       就以 no-authorized-memory 结束，零 provider 调用、零 Vault 读取。 */
    const beforeHiddenOnly = fetchRec.length;
    const hiddenOnly = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin, body: requestBody({ timeoutMs: 2000, selectedMemoryIds: ['m_b'] })
    });
    check('K16.selectingOnlyAHiddenRowIsRefusedBeforeTheVaultAtZeroCost',
      hiddenOnly.status === 422 && hiddenOnly.body.error === 'no-authorized-memory'
      && hiddenOnly.body.boundary.providerCalls === 0 && hiddenOnly.body.boundary.vaultReads === 0
      && fetchRec.length === beforeHiddenOnly,
      'status=' + hiddenOnly.status + ' error=' + hiddenOnly.body.error
      + ' fetchCallsDelta=' + (fetchRec.length - beforeHiddenOnly)
      + ' boundary=' + JSON.stringify(hiddenOnly.body.boundary));

    /* 同一件事在 HTTP 面上再证一次：调用方夹带的正文得到的不是"被忽略"，
       而是**指名字段**的拒绝，且那段文本一个字节都没到 wire。 */
    const forgedHttp = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin,
      body: requestBody({ timeoutMs: 2000, records: [memoryRecord({ id: 'm1', content: 'FORGED-HTTP-TEXT' })] })
    });
    check('K17.aForgedRecordSmuggledOverHttpIsRefusedByNameAndNeverReachesTheWire',
      forgedHttp.status === 400
      && forgedHttp.body.error === 'caller-attempted-to-supply-canonical-evidence'
      && forgedHttp.body.field === 'records'
      && forgedHttp.raw.indexOf('FORGED-HTTP-TEXT') < 0
      && fetchRec.every(r => String(r.bodyText || '').indexOf('FORGED-HTTP-TEXT') < 0),
      'status=' + forgedHttp.status + ' error=' + forgedHttp.body.error + ' field=' + forgedHttp.body.field);

    /* ══════════════════════════════════════════════════════════════════
       L · HTTP transport
       ══════════════════════════════════════════════════════════════════ */
    section('L · HTTP transport');
    const noToken = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, { body: requestBody() });
    check('L1.postWithoutDesktopTokenIs401',
      noToken.status === 401 && noToken.body && noToken.body.error === 'unauthenticated',
      'status=' + noToken.status + ' error=' + (noToken.body && noToken.body.error));

    const wrongMethod = await httpRequest('127.0.0.1', port, 'GET', RT.PATH, { headers: admin });
    check('L2.getIs405RuntimeInterpretationIsPostOnly',
      wrongMethod.status === 405 && wrongMethod.body
      && wrongMethod.body.error === 'runtime-interpretation-is-post-only'
      && Array.isArray(wrongMethod.body.allowedMethods)
      && wrongMethod.body.allowedMethods.indexOf('POST') >= 0,
      'status=' + wrongMethod.status + ' error=' + (wrongMethod.body && wrongMethod.body.error));

    const badJson = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin, rawBody: '{not json'
    });
    check('L3.malformedJsonBodyIs400',
      badJson.status === 400 && badJson.body && badJson.body.ok === false,
      'status=' + badJson.status + ' error=' + (badJson.body && badJson.body.error));

    /* 超界的选择集：**指名**的 memory-selection-exceeds-bound（不是笼统的
       request-shape-invalid —— 调用方需要知道它撞的是哪一条边界）。 */
    const oversized = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin,
      body: requestBody({ timeoutMs: 2000, selectedMemoryIds: Array.from({ length: 500 }, (_, i) => 'm' + i) })
    });
    check('L4.oversizedSelectionIsRefusedWithTheNamedBoundCode',
      oversized.status === 400 && oversized.body && oversized.body.ok === false
      && oversized.body.error === 'memory-selection-exceeds-bound'
      && oversized.status === RT.STATUS_BY_REASON['memory-selection-exceeds-bound'],
      'status=' + oversized.status + ' error=' + (oversized.body && oversized.body.error));

    /* 同一个传输面上的 canonical 证据拒绝：与 K17 同形，但走"扁平字段"而不是
       旧信封载体 —— 两条路径都必须指名。 */
    const canonicalHttp = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, {
      headers: admin,
      body: Object.assign(requestBody({ timeoutMs: 2000 }), { content: 'SMUGGLED_OVER_HTTP' })
    });
    check('L4b.canonicalBearingFieldOverHttpIsRefusedByName',
      canonicalHttp.status === 400
      && canonicalHttp.body.error === 'caller-attempted-to-supply-canonical-evidence'
      && canonicalHttp.body.field === 'content'
      && canonicalHttp.raw.indexOf('SMUGGLED_OVER_HTTP') < 0,
      'status=' + canonicalHttp.status + ' error=' + (canonicalHttp.body && canonicalHttp.body.error)
      + ' field=' + (canonicalHttp.body && canonicalHttp.body.field));

    const absent = await httpRequest('127.0.0.1', port, 'POST', RT.PATH, { headers: admin });
    check('L5.absentBodyIsAStructuredRefusalNotACrash',
      absent.status >= 400 && absent.status < 500 && absent.body && absent.body.ok === false,
      'observed status=' + absent.status + ' error=' + (absent.body && absent.body.error)
      + ' (task literal says 400; closed-schema refusal is reported with the real status)');

    const health = await httpRequest('127.0.0.1', port, 'GET', '/health', {});
    check('L6.serverStillAliveAfterAllRefusals',
      health.status === 200 && health.body && health.body.ok === true,
      'status=' + health.status);

    check('L7.pathIsUnderTheInternalPrefix',
      RT.PATH.indexOf('/internal/') === 0 && okRes.body.boundary.transportScope === 'DESKTOP_ONLY',
      RT.PATH);

    const httpCode = WIRING.stripJsComments(readFile('services/home-node/http.js'));
    const guardMatch = /const isDesktopOnlyPath = [\s\S]*?;/.exec(httpCode);
    check('L8.desktopOnlyGuardCoversTheInternalPrefix',
      !!guardMatch && guardMatch[0].indexOf("'/internal/'") >= 0,
      guardMatch ? guardMatch[0].slice(0, 260) : 'isDesktopOnlyPath declaration not found');

    const security = await httpRequest('127.0.0.1', port, 'GET', '/security', { headers: admin });
    const secBlock = security.body && security.body.runtimeInterpretation;
    check('L9.securityDeclaresTheSameDesktopOnlyTruth',
      security.status === 200 && secBlock && secBlock.transportScope === 'DESKTOP_ONLY'
      && secBlock.androidCompatibility === 'NOT_PROVEN'
      && secBlock.autoRetry === 'NONE' && secBlock.maxAttempts === 1
      && secBlock.durable === false && secBlock.runtimeOnly === true,
      JSON.stringify(secBlock));

    /* 回归锁：/security 声明的路径必须**逐字**等于服务自己的 path ——
       这正是刚修掉的那个缺陷（http.js 里曾有一份独立字面量）。它比 N3 的
       "字面量搜索"更强：即便有人换一个变量名重新引入常量，这里也会转红。 */
    check('L15.securityReportsTheServicePathNotASecondLiteral',
      secBlock && secBlock.assembled === true && secBlock.path === RT.PATH
      && security.raw.indexOf(RT.PATH) >= 0,
      'security.path=' + JSON.stringify(secBlock && secBlock.path) + ' service.path=' + JSON.stringify(RT.PATH));

    /* ── 远端姿态：非 loopback 请求必须被拒绝（两种真实姿态各证一次）── */
    if (!remote) {
      check('L10.remotePostureProven', false,
        'no self-connectable non-loopback address on this host — cannot produce a remote source');
    } else {
      const socketRefused = await httpRequest(remote.address, port, 'POST', RT.PATH, {
        headers: admin, body: requestBody({ timeoutMs: 2000 })
      });
      check('L10.loopbackBoundServerIsUnreachableFromARemoteAddress',
        socketRefused.status === 0
        && /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|EADDRNOTAVAIL|timeout/i.test(String(socketRefused.error)),
        'remote=' + remote.address + ' status=' + socketRefused.status + ' error=' + socketRefused.error);

      /* 姿态二：显式 0.0.0.0 绑定 + 设备鉴权未就绪（真实故障注入：
         devices_schema 比本版新 —— 与 test_home_node_lan_gate.js C 段同款）。 */
      const remoteDir = freshDir('ib-interp-remote-');
      let remoteInst = null;
      let remoteServer = null;
      try {
        const primer = SERVICE.buildHomeNode({ dataDir: remoteDir, host: '0.0.0.0', logger: () => {}, port: fakePort(validBatch(['m1'])) });
        primer.open();
        primer.close();
        const { DatabaseSync } = require('node:sqlite');
        const raw = new DatabaseSync(path.join(remoteDir, 'home-node.db'));
        raw.prepare("INSERT INTO meta (key, value) VALUES ('devices_schema', '99') "
          + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run();
        raw.close();
        remoteInst = SERVICE.buildHomeNode({
          dataDir: remoteDir, host: '0.0.0.0', token: ADMIN_TOKEN,
          port: fakePort(validBatch(['m1'])),
          runtimeInterpretationPolicy: POLICY_ON, logger: () => {}
        });
        let openError = null;
        try { remoteInst.open(); } catch (error) { openError = error; }
        check('L11.testPreconditionDeviceAuthIsNotReady',
          SERVICE.deviceAuthReady(remoteInst.registry).ready === false,
          'openError=' + (openError && openError.code) + ' auth=' + JSON.stringify(SERVICE.deviceAuthReady(remoteInst.registry)));
        const remotePort = await listen(remoteInst.server, '0.0.0.0');
        remoteServer = remoteInst.server;
        const remoteTry = await httpRequest(remote.address, remotePort, 'POST', RT.PATH, {
          headers: admin, body: requestBody({ timeoutMs: 2000 })
        });
        check('L12.nonLoopbackRequestIsRefusedWhileTheLanGateIsClosed',
          remoteTry.status === 403 && remoteTry.body && remoteTry.body.error === 'loopback-only',
          'status=' + remoteTry.status + ' error=' + (remoteTry.body && remoteTry.body.error));
      } catch (error) {
        check('L12.nonLoopbackRequestIsRefusedWhileTheLanGateIsClosed', false, String((error && error.message) || error));
      } finally {
        if (remoteServer) { try { remoteServer.close(); } catch (_) { /* 未监听 */ } }
        if (remoteInst) { try { remoteInst.close(); } catch (_) { /* 已关闭 */ } }
        dropDir(remoteDir);
      }
    }

    TRANSPORT_SCOPE_OBSERVED = RT.TRANSPORT_SCOPE;
    ANDROID_COMPAT_OBSERVED = RT.ANDROID_COMPATIBILITY;
    const selfSource = fs.readFileSync(__filename, 'utf8');
    check('L13.transportScopeIsDesktopOnly',
      RT.TRANSPORT_SCOPE === 'DESKTOP_ONLY'
      && okRes.body.boundary.transportScope === 'DESKTOP_ONLY'
      && inst.runtimeInterpretation.describe().transportScope === 'DESKTOP_ONLY',
      'TRANSPORT_SCOPE=' + RT.TRANSPORT_SCOPE);
    check('L14.androidCompatibilityIsNotProven',
      RT.ANDROID_COMPATIBILITY === 'NOT_PROVEN'
      && okRes.body.boundary.androidCompatibility === 'NOT_PROVEN'
      && inst.runtimeInterpretation.describe().androidCompatibility === 'NOT_PROVEN'
      && secBlock.androidCompatibility === 'NOT_PROVEN'
      && !/android[-\s]?(compatible|compatibility\s*[:=]\s*(yes|proven|true)|parity|supported)/i.test(selfSource),
      'ANDROID_COMPATIBILITY=' + RT.ANDROID_COMPATIBILITY + ' (no Android claim anywhere in this suite)');
  } catch (error) {
    check('K/L.harnessCompleted', false, String((error && error.stack) || error));
  } finally {
    if (probe) {
      try {
        await httpRequest('127.0.0.1', probe.port, 'GET', '/health', {});
      } catch (_) { /* 尽力而为 */ }
      try { probe.inst.close(); } catch (_) { /* 已关闭 */ }
      dropDir(probe.dataDir);
      dropDir(probe.credentialDataDir);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     M · cancellation truth（只说观测到的）
     ══════════════════════════════════════════════════════════════════════ */
  section('M · cancellation truth');
  {
    /* ① signal forwarding：端口**真的**收到了一个 AbortSignal */
    const spyPort = fakePort(validBatch(['m1']));
    const spySvc = makeService({ costPolicy: POLICY_ON, modelPort: spyPort });
    const outer = new AbortController();
    const r1 = await call(spySvc.svc, requestBody(), { signal: outer.signal });
    const seen = spyPort.calls.options[0] && spyPort.calls.options[0].signal;
    SIGNAL_FORWARDING_PROVEN = !!(seen && typeof seen.aborted === 'boolean'
      && typeof seen.addEventListener === 'function');
    check('M1.abortSignalIsForwardedToThePort',
      r1.ok === true && SIGNAL_FORWARDING_PROVEN,
      'port received signal: ' + (seen ? ('aborted=' + seen.aborted) : 'NONE'));

    /* ② forwarding 的**联系**：中止调用方 signal 会让端口看到的 signal 真的中止 */
    const linkPort = fakePort('hang');
    const linkSvc = makeService({ costPolicy: POLICY_ON, modelPort: linkPort });
    const linkOuter = new AbortController();
    const linkPromise = call(linkSvc.svc, requestBody({ timeoutMs: 3000 }), { signal: linkOuter.signal });
    await new Promise(r => setTimeout(r, 30));
    linkOuter.abort();
    const linkResult = await Promise.race([linkPromise, new Promise(r => setTimeout(() => r({ __slow: true }), 2000))]);
    const linkSeen = linkPort.calls.options[0] && linkPort.calls.options[0].signal;
    check('M2.abortingTheCallerSignalAbortsThePortsSignal',
      linkSeen && linkSeen.aborted === true && linkResult && linkResult.ok === false
      && linkResult.error === 'aborted',
      'portSignal.aborted=' + (linkSeen && linkSeen.aborted) + ' result=' + primaryCode(linkResult));

    /* ③ FETCH_ABORT_PROVEN：真实 NodeModelPort + 注入的挂起 fetch 观察到 abort */
    const rec = [];
    const observation = { aborted: false };
    const sigPort = NODE_MODEL_PORT({ fetch: hangingProviderFetch(rec, observation) });
    const sigSvc = makeService({ costPolicy: POLICY_ON, modelPort: sigPort });
    const sigOuter = new AbortController();
    const sigPromise = call(sigSvc.svc, requestBody({ timeoutMs: 3000 }), { signal: sigOuter.signal });
    await new Promise(r => setTimeout(r, 40));
    sigOuter.abort();
    const sigResult = await Promise.race([sigPromise, new Promise(r => setTimeout(() => r({ __slow: true }), 2500))]);
    FETCH_ABORT_PROVEN = observation.aborted === true;
    check('M3.theFakeProviderObservedTheAbort',
      FETCH_ABORT_PROVEN && sigResult && sigResult.ok === false && sigResult.error === 'aborted',
      'fakeFetchObservedAbort=' + observation.aborted + ' result=' + primaryCode(sigResult));
    check('M4.theProviderRequestReallyCarriedASignal',
      rec.length === 1 && rec[0].hasSignal === true,
      'fetchCalls=' + rec.length + ' hasSignal=' + (rec[0] && rec[0].hasSignal));

    /* ④ 不做超出观测的主张 */
    check('M5.providerCostStopIsNotClaimed',
      PROVIDER_COST_STOP_PROVEN === 'NOT_PROVEN'
      && !/COST_STOPPED\s*=\s*true|costStopped\s*=\s*true/i.test(
        WIRING.stripJsComments(readFile('services/home-node/runtime-interpretation.js'))),
      'this harness observes signal forwarding and a fetch abort; it cannot observe provider-side spend');
    check('M6.autoRetryNoneIsTheCostBoundary',
      RT.AUTO_RETRY === 'NONE' && RT.MAX_ATTEMPTS === 1,
      'one request costs at most one provider call');
  }

  /* ══════════════════════════════════════════════════════════════════════
     N · cross-file hash consistency（浏览器 / 传输 / 服务三处不得各写一份）

     浏览器读不了 Node 模块，因此路径 / 操作名 / 信封键在三处各有一份字面量：
       · services/home-node/runtime-interpretation.js（权威）；
       · assets/js/home-node-client.js（要寻址的那一份）；
       · services/home-node/http.js（路由判定）。
     三者一旦漂移，浏览器会安静地打一条服务端不服务的路径。本节的唯一目的
     就是把这个"未证伪的哈希"钉住 —— 任何一处不一致都必须转红，而不是被适配。
     ══════════════════════════════════════════════════════════════════════ */
  section('N · cross-file path & auto-invocation consistency');
  {
    const rtPath = RT.PATH;
    const clientSrc = readFile('assets/js/home-node-client.js');
    const clientPath = (/var\s+RUNTIME_PATH\s*=\s*'([^']*)'\s*;/.exec(clientSrc) || [])[1] || null;
    const clientOperation = (/var\s+RUNTIME_OPERATION\s*=\s*'([^']*)'\s*;/.exec(clientSrc) || [])[1] || null;
    /* ★ 客户端**能发**的顶层键：从运行面的构造代码里读出来（body 字面量的键
       + 后续 `payload.X = ...` 赋值）。这里刻意不看注释 —— 运行面里有一大段
       解释"为什么不再有 records 通道"，把注释算进来会让一条**安全的**实现
       因为文档而转红。 */
    const clientCode = WIRING.stripJsComments(clientSrc);
    const clientRuntimeBlock = sliceObjectBlock(clientCode, 'function createRuntimeRemote');
    const clientSentKeys = (() => {
      const out = [];
      if (!clientRuntimeBlock) return out;
      const literal = /\bvar\s+payload\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(clientRuntimeBlock);
      if (literal) {
        const re = /^\s*([A-Za-z_$][\w$]*)\s*:/gm;
        let m;
        while ((m = re.exec(literal[1]))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
      }
      const reAssign = /\bpayload\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g;
      let a;
      while ((a = reAssign.exec(clientRuntimeBlock))) if (out.indexOf(a[1]) < 0) out.push(a[1]);
      return out;
    })();
    /* currentState 的嵌套闭集（客户端侧的第二个白名单）。 */
    const clientStateKeys = (() => {
      const m = /var\s+RUNTIME_STATE_KEYS\s*=\s*(\[[^\]]*\])/.exec(clientCode);
      if (!m) return null;
      try { return JSON.parse(m[1].replace(/'/g, '"')); } catch (_) { return null; }
    })();

    const httpRaw = readFile('services/home-node/http.js');
    const httpCode = WIRING.stripJsComments(httpRaw);
    const pathLiteral = "'" + rtPath + "'";
    const secondLiteralAt = httpCode.indexOf(pathLiteral);
    const secondLiteralLine = httpRaw.split('\n').findIndex(l => l.indexOf(pathLiteral) >= 0) + 1;
    HTTP_SECOND_PATH_LITERAL = secondLiteralAt < 0 ? null
      : 'services/home-node/http.js:' + (secondLiteralLine || 0);
    const routingDerivesFromServicePath = /path\s*===\s*runtimeInterpretation\.path/.test(httpCode);

    check('N1.modulePathIsTheFrozenLiteral',
      rtPath === '/internal/runtime/memory-interpretation', rtPath);
    check('N2.browserClientPathLiteralIsIdentical',
      !!clientPath && clientPath === rtPath,
      'client=' + JSON.stringify(clientPath) + ' server=' + JSON.stringify(rtPath));
    check('N3.httpLayerHasNoSecondPathLiteral',
      secondLiteralAt < 0,
      secondLiteralAt < 0 ? 'no second literal in services/home-node/http.js'
        : 'a SECOND literal exists at ' + HTTP_SECOND_PATH_LITERAL
          + ' (used only as the not-assembled /security declaration, not for routing) — it can drift '
          + 'from the path the server actually serves');
    check('N4.httpLayerRoutesViaTheServicePath',
      routingDerivesFromServicePath,
      'routing must be `path === runtimeInterpretation.path`, never a literal');
    check('N5.browserClientOperationLiteralIsIdentical',
      !!clientOperation && clientOperation === RT.OPERATION,
      'client=' + JSON.stringify(clientOperation) + ' server=' + JSON.stringify(RT.OPERATION));
    /* ★ LIVE-3 的双向锁（比旧 ENVELOPE_FIELDS 等值断言更强，且能活过将来的
       服务端字段新增）：
         (a) 客户端**能发**的每一个顶层键都在服务端 REQUEST_FIELDS 里；
         (b) 客户端能发的键没有一个落在 CANONICAL_EVIDENCE_FIELDS 里；
         (c) 旧的 inputEnvelope 载体与 records 通道在运行面里**彻底消失**；
         (d) 它确实还能发 selectedMemoryIds / currentState / roleName
             （否则"锁住了"只是因为客户端坏了，而不是因为契约一致）。
       任何一条不成立 → 浏览器与服务端已经在说两种协议，必须转红。 */
    check('N6.browserClientClosedKeyListIsSubsetOfTheServerRequestSchema',
      clientSentKeys.length > 0
      && clientSentKeys.every(k => RT.REQUEST_FIELDS.indexOf(k) >= 0)
      && clientSentKeys.indexOf('selectedMemoryIds') >= 0,
      'clientSent=' + JSON.stringify(clientSentKeys)
      + ' server REQUEST_FIELDS=' + JSON.stringify(RT.REQUEST_FIELDS.slice())
      + ' runtimeBlock=' + (clientRuntimeBlock ? clientRuntimeBlock.length + ' chars' : 'NOT FOUND'));
    check('N6b.browserClientCannotExpressAnyCanonicalEvidence',
      clientSentKeys.length > 0
      && clientSentKeys.every(k => (RT.CANONICAL_EVIDENCE_FIELDS || []).indexOf(k) < 0)
      && ['selectedMemoryIds', 'currentState', 'roleName'].every(k => clientSentKeys.indexOf(k) >= 0)
      && Array.isArray(clientStateKeys)
      && JSON.stringify(clientStateKeys.slice().sort()) === JSON.stringify(['emotion', 'relationship'])
      && !!clientRuntimeBlock
      && clientRuntimeBlock.indexOf('inputEnvelope') < 0
      && clientRuntimeBlock.indexOf('records') < 0
      && !/RUNTIME_ENVELOPE_KEYS/.test(clientCode),
      'clientSent=' + JSON.stringify(clientSentKeys)
      + ' clientStateKeys=' + JSON.stringify(clientStateKeys)
      + ' legacyInputEnvelopeLiteral=' + (clientCode.indexOf('RUNTIME_ENVELOPE_KEYS') >= 0)
      + ' recordsInRuntimeBlock=' + (!!clientRuntimeBlock && clientRuntimeBlock.indexOf('records') >= 0));

    PATH_LITERAL_SOURCES_CONSISTENT = rtPath === '/internal/runtime/memory-interpretation'
      && clientPath === rtPath && secondLiteralAt < 0;

    /* ── F13 · 自动调用 / 定时器 / per-turn hook 必须缺席 ─────────────── */
    const commSrc = readFile('assets/js/communication.js');
    const commHits = ['memory-interpretation', 'runMemoryInterpretation', '/internal/runtime/']
      .filter(s => commSrc.indexOf(s) >= 0);
    check('N7.turnPathCarriesNoRuntimeInterpretationReference',
      commHits.length === 0,
      'assets/js/communication.js hits=' + JSON.stringify(commHits));

    const bootSrc = readFile('assets/js/home-node-bootstrap.js');
    const runtimeBlock = sliceObjectBlock(bootSrc, 'runtime: {');
    check('N8.bootstrapRuntimeSurfaceIsLocatable', !!runtimeBlock,
      'home-node-bootstrap.js runtime surface block not found');
    const blockKeys = [];
    if (runtimeBlock) {
      for (const line of runtimeBlock.split('\n')) {
        const m = /^ {4}([A-Za-z_$][\w$]*)\s*:/.exec(line);
        if (m) blockKeys.push(m[1]);
      }
    }
    blockKeys.sort();
    check('N9.bootstrapRuntimeSurfaceDeclaresNoTimer',
      !!runtimeBlock && !/set(?:Interval|Timeout)\s*\(/.test(runtimeBlock)
      && !/setInterval\s*\(/.test(bootSrc),
      'no setInterval/setTimeout inside the runtime surface, and no setInterval anywhere in the bootstrap');
    check('N10.bootstrapRuntimeSurfaceExportsExactlyOneVerb',
      JSON.stringify(blockKeys) === JSON.stringify(['available', 'instance', 'runMemoryInterpretation']),
      'runtime surface keys = ' + JSON.stringify(blockKeys));

    AUTO_INVOCATION_ABSENT = commHits.length === 0
      && !!runtimeBlock && !/set(?:Interval|Timeout)\s*\(/.test(runtimeBlock)
      && !/setInterval\s*\(/.test(bootSrc)
      && JSON.stringify(blockKeys) === JSON.stringify(['available', 'instance', 'runMemoryInterpretation']);

    /* ── 生产启用路径必须缺席（本阶段冻结：没有 env、没有 UI 开关）──── */
    const svcCode = WIRING.stripJsComments(readFile('services/home-node-service.js'));
    const processAssembly = /const runtimeInterpretation = createRuntimeInterpretation\(\{[\s\S]*?\}\);/.exec(svcCode);
    const policyOccurrences = (svcCode.match(/runtimeInterpretationPolicy/g) || []).length;
    const policyPassThrough = /costPolicy:\s*options\.runtimeInterpretationPolicy/.test(svcCode);
    const interpEnv = envKeysOf(svcCode).concat(envKeysOf(httpCode)).filter(k => /INTERPRETATION/i.test(k));
    check('N11.productionAssemblyPassesNoCostPolicy',
      !!processAssembly && !/costPolicy/.test(processAssembly[0]),
      processAssembly ? processAssembly[0].slice(0, 160).replace(/\s+/g, ' ') : 'process assembly not found');
    check('N12.onlyRuntimeInterpretationPolicyOccurrenceIsTheAssemblyPassThrough',
      policyOccurrences === 1 && policyPassThrough,
      'occurrences=' + policyOccurrences + ' passThrough=' + policyPassThrough);
    check('N13.noEnvVarCanEnableTheBoundary',
      interpEnv.length === 0,
      'INTERPRETATION env reads=' + JSON.stringify(interpEnv));

    SERVER_ENABLE_PATH_ABSENT = !!processAssembly && !/costPolicy/.test(processAssembly[0])
      && policyOccurrences === 1 && policyPassThrough && interpEnv.length === 0;
  }

  /* ══════════════════════════════════════════════════════════════════════
     Z · 零真实成本 + 汇总
     ══════════════════════════════════════════════════════════════════════ */
  section('Z · zero real provider cost');
  {
    const badEndpoints = REAL_PROVIDER_ENDPOINTS.filter(e => !/^https:\/\/provider-[ab]\.invalid\//.test(e));
    check('Z1.everyProviderEndpointUsedIsNonRoutable',
      REAL_PROVIDER_ENDPOINTS.length > 0 && badEndpoints.length === 0,
      'endpoints=' + JSON.stringify(Array.from(new Set(REAL_PROVIDER_ENDPOINTS)).slice(0, 4)));
    check('Z2.noRealProviderClientIsRequiredByThisSuite',
      !/require\(['"](?:node:)?https['"]\)/.test(fs.readFileSync(__filename, 'utf8'))
      && !/globalThis\s*\.\s*fetch/.test(fs.readFileSync(__filename, 'utf8'))
      && !/\bfetch\s*\(\s*['"]https?:/.test(fs.readFileSync(__filename, 'utf8')),
      'the only http/net use is the local test server; every provider transport is an injected fake fetch');
    check('Z3.serverCoreNeverThrewInAnySection',
      THROWN.length === 0, JSON.stringify(THROWN.slice(0, 5)));
  }

  /* 临时目录清理：共享的 canonical store 也要关掉。Windows 上未释放的 SQLite
     句柄会让目录删除失败 —— 那会留下一个"看起来通过但脏"的运行。 */
  closeCanonStore();
  check('Z4.sharedCanonicalStoreTempDirIsCleaned', CANON_DIR_CLEANED === true,
    'canonical temp dir cleaned=' + String(CANON_DIR_CLEANED));

  /* ── machine-readable verdicts ────────────────────────────────────────── */
  console.log('\n' + '='.repeat(72));
  console.log('R4C LIVE RUNTIME BOUNDARY · sections A–N · Z');
  console.log('VALIDATOR_IMPLEMENTATION_COUNT = ' + VALIDATOR_IMPLEMENTATION_COUNT);
  console.log('REPO_VALIDATOR_DEFINITIONS = ' + REPO_VALIDATOR_DEFINITIONS
    + ' ' + JSON.stringify(REPO_VALIDATOR_DEFINITIONS === 3 ? 'UNCHANGED_SIBLING_CORES' : 'UNEXPECTED'));
  console.log('SYSTEM_INSTRUCTIONS_DEFINITION_COUNT = ' + SYSTEM_INSTRUCTIONS_DEFINITION_COUNT);
  console.log('SIGNAL_FORWARDING_PROVEN = ' + (SIGNAL_FORWARDING_PROVEN ? 'YES' : 'NO'));
  console.log('FETCH_ABORT_PROVEN = ' + (FETCH_ABORT_PROVEN ? 'YES' : 'NO'));
  console.log('PROVIDER_COST_STOP_PROVEN = ' + PROVIDER_COST_STOP_PROVEN
    + ' (not observable in this harness)');
  console.log('RUNTIME_BOUNDARY_TRANSPORT_SCOPE = ' + (TRANSPORT_SCOPE_OBSERVED || 'UNKNOWN'));
  console.log('ANDROID_COMPATIBILITY = ' + (ANDROID_COMPAT_OBSERVED || 'UNKNOWN'));
  console.log('PATH_LITERAL_SOURCES_CONSISTENT = ' + (PATH_LITERAL_SOURCES_CONSISTENT ? 'YES' : 'NO')
    + (HTTP_SECOND_PATH_LITERAL ? ' (second literal: ' + HTTP_SECOND_PATH_LITERAL + ')' : ''));
  console.log('AUTO_INVOCATION_ABSENT = ' + (AUTO_INVOCATION_ABSENT ? 'YES' : 'NO'));
  console.log('SERVER_ENABLE_PATH_ABSENT = ' + (SERVER_ENABLE_PATH_ABSENT ? 'YES' : 'NO'));
  /* ── LIVE-3 · canonical evidence 的实测裁决 ───────────────────────────── */
  console.log('REQUEST_SCHEMA_KEYS = ' + JSON.stringify((RT.REQUEST_FIELDS || []).slice()));
  console.log('CANONICAL_EVIDENCE_FIELDS_REJECTED = ' + ((RT.CANONICAL_EVIDENCE_FIELDS || []).length));
  console.log('CALLER_CANONICAL_EVIDENCE_REFUSED = ' + (CALLER_CANONICAL_EVIDENCE_REFUSED ? 'YES' : 'NO')
    + ' (all ' + CANONICAL_BEARING_NAMES.length + ' canonical names rejected by name)');
  console.log('CANONICAL_REBINDING_PROVEN = ' + (CANONICAL_REBINDING_PROVEN ? 'YES' : 'NO'));
  console.log('SELECTED_ID_ORDER_PRESERVED = ' + (SELECTED_ID_ORDER_PRESERVED ? 'YES' : 'NO'));
  console.log('MISSING_AND_HIDDEN_INDISTINGUISHABLE = ' + (MISSING_AND_HIDDEN_INDISTINGUISHABLE ? 'YES' : 'NO'));
  console.log('SELECTED_SET_BOUND_ENFORCED = ' + (SELECTED_SET_BOUND_ENFORCED ? 'YES' : 'NO')
    + ' (0..' + (RT.MAX_SELECTED_MEMORY_IDS === undefined ? 'UNKNOWN' : RT.MAX_SELECTED_MEMORY_IDS) + ')');
  console.log('SERVER_PROJECTION_FIELD_COUNT = ' + String(PROJECTION_FIELD_COUNT)
    + ' ' + JSON.stringify(PROJECTION_FIELDS_OBSERVED));
  console.log('EVIDENCE_BLOCK_SOURCE = ' + String(EVIDENCE_BLOCK_SOURCE));
  console.log('SERVER_CANONICAL_REVISION_REPORTED = ' + String(CANONICAL_REVISION_REPORTED));
  console.log('SYSTEM_EVIDENCE_STATE_IS_NULL = ' + (SYSTEM_EVIDENCE_STATE_IS_NULL ? 'YES' : 'NO'));
  console.log('REAL_PROVIDER_CALLS = 0');
  console.log('-'.repeat(72));
  if (failures) {
    console.error('RUNTIME INTERPRETATION BOUNDARY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('RUNTIME INTERPRETATION BOUNDARY PASSED · ' + passed + ' assertions green');
})().catch(error => {
  console.error('RUNTIME INTERPRETATION BOUNDARY CRASHED · ' + String((error && error.stack) || error));
  try { closeCanonStore(); } catch (_) { /* 尽力而为 */ }
  process.exit(1);
});
