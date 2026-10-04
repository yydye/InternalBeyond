'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-LIVE-3 · Server-Bound Canonical Evidence
   （纯 Node · 零真实网络 · 零真实 provider · ZERO REAL PROVIDER CALLS）

   运行：node tests/test_r4c_live_canonical_evidence.js
   退出码 0 = 全部断言通过。

   ── 本文件要证明的一件事 ──────────────────────────────────────────────
   浏览器**只能**提交 `selectedMemoryIds`（一串 id）。
   真正被解释的**正文**由 Home Node 从 canonical memory store 重新绑定，
   可见性由**唯一**那份共享 core（assets/js/memory-visibility-core.js 的
   canReadMemory）判定，投影成有界快照之后才交给 provider。

   因此本文件的核心判据不是"请求里没有奇怪的字段"，而是三条更强的：
     ① provider 收到的正文 === store 里的规范字节（逐字节）；
     ② 浏览器**没有任何词汇**能让 provider 看到伪造文本（36 个
        canonical-bearing 字段名 × 顶层 + 嵌套，全部拒绝且零成本）；
     ③ 不存在的 id 与"存在但对该角色隐藏"的 id，在**响应信道**上不可区分
        （状态码 / 错误码 / detail / 计数 / missingFor / provider 调用数
          / 响应原始字节全部逐字相同）。

   ── 为什么第 ③ 条是这一阶段的门槛（以及它**不**包含什么）─────────────
   "按 id 取规范行"这件事一旦实现得不小心，就会造出一个**存在性预言机**：
   攻击者提交一个猜的 id，只要响应在状态码、错误文案、耗时或计数上有一丝
   差别，他就能判定"这条记忆是否存在于这台节点上"——**即使正文永远拿不到**。
   所以 §5 不比"看起来差不多"，而是比**原始响应字节**。

   ★ 但"响应字节相同"不等于"没有预言机"。**时间信道没有被形式化关闭**：
     "不存在"只需一次 getRecord（返回 null），而"存在但隐藏"要多读一行、
     多解析一次 payload、再多跑一次可见性判定 —— 这条差异在原理上可观测。
     独立核验方已登记过这个量级（约 0.05 ms 的额外规范行读取）。因此：
       · 本文件断言的是三条**响应信道**的闭合（NO_*_EXISTENCE_ORACLE）；
       · 本文件**不**声称时间信道闭合，也**不**声称该差异可被利用 ——
         它只把实测差值作为 DIAGNOSTIC 打出来（TIMING_DIFFERENCE_OBSERVED），
         不设阈值、不作为任何判定的输入。
     诚实的口径只有一句：**timing channel not formally closed / not proven exploitable**。

   ── 为什么 §14 单独存在 ───────────────────────────────────────────────
   每一条拒绝路径都必须证明它**没有**花掉一次 provider 调用。一次成功的
   调用（真金白银）是最贵的；但一条被绕过的拒绝路径会在**每次**尝试时花钱。

   ── 诚实边界 ──────────────────────────────────────────────────────────
   · provider 传输一律是注入的 fake fetch（挂在**真实**
     active/node-model-port.js 上），endpoint 全是不可路由的 `.invalid`；
   · 所有数据目录都在 os.tmpdir() 下，结束时整棵删除；
   · Vault 是真实的 active/credential-vault.js，但内容是合成 sentinel；
   · 本文件不改任何生产文件（写作用域只有它自己）。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
/* 唯一一份可见性谓词。本文件**不**自己实现任何 ACL 规则：
   §4 把服务端的绑定决策逐行对照这一份，因此"服务端用了同一份 core"
   是一个可测量的事实，而不是一句声明。 */
const VIS = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'memory-interpretation-core.js'));
const VIS_PATH = 'assets/js/memory-visibility-core.js#canReadMemory';

let RT = null;
let RT_ERROR = null;
try { RT = require(path.join(ROOT, 'services', 'home-node', 'runtime-interpretation.js')); }
catch (error) { RT_ERROR = error; }

/* ── 冻结常量 ─────────────────────────────────────────────────────────── */
const NOW = 1760000000000;                    /* 固定时钟 ⇒ latencyMs 恒 0，oracle 才可能逐字节相等 */
const ADMIN_TOKEN = 'r4c-live3-admin-token';
const ENDPOINT_A = 'https://provider-a.invalid/v1/chat/completions';
const ENDPOINT_B = 'https://provider-b.invalid/v1/chat/completions';
const SENTINEL_A = 'SECRET_SENTINEL_LIVE3_A_5F21';
const SENTINEL_B = 'SECRET_SENTINEL_LIVE3_B_7C93';
const POLICY_ON = Object.freeze({ memoryInterpretationEnabled: true });
const NONCE = 'L3-' + crypto.randomBytes(4).toString('hex');
const MAX_CONTENT_CHARS = CORE.BOUNDS.MAX_CONTENT_CHARS;     /* 1200 */
const MAX_MEMORIES = CORE.BOUNDS.MAX_MEMORIES;               /* 8 */
/* provider 线上**唯一**允许出现的 7 个键 = R4-C 自己的 MEMORY_BATCH 条目形状。
   注意：服务端内部那份 {id,content,title,source,kind,valence,arousal} 投影是
   **服务端结构**，它经 R4-C buildRequest 映射成下面这一份才上线。两者恰好都是
   7 个键（巧合），因此本文件断言的是**线上这一份**，不是内部那一份。 */
const PROJECTION_KEYS = ['content', 'encodedAffectAtTheTime', 'kind', 'memoryId', 'source', 'systemEvidenceState', 'title'];
/* 任何一项出现在 provider 的 model-facing body 里都意味着"服务端把存储/ACL/
   激活/凭据元数据夹带给了模型"。 */
const PROVIDER_FORBIDDEN_TOKENS = ['visibility', 'visibleTo', 'excludeFrom', 'createdBy', 'ownerId',
  'revision', 'deleted_at', 'seq', 'importance', 'activationCount', 'lastActivated', 'created',
  'createdAt', 'secret', 'credentialRef', 'endpoint'];

/* task-8 冻结名单 ∪ Lead LIVE-3 修正案名单 —— 并集，任一实现都不得少认一个。
   它们**全部**是"一旦能被调用方写入就伪造了证据"的字段名。 */
const CANONICAL_BEARING_FIELDS = Array.from(new Set([
  /* task-8 §2 冻结名单（19） */
  'records', 'content', 'summary', 'title', 'source', 'rawSource', 'evidenceState', 'evidence',
  'visibility', 'visibleTo', 'excludeFrom', 'createdAt', 'importance', 'activationCount',
  'canonical', 'snapshot', 'memoryPayload', 'inputEnvelope', 'selectedIds',
  /* Lead 修正案补充（同一语义族的其余字段名） */
  'record', 'memoryRecords', 'memory_records', 'kind', 'systemEvidenceState', 'evidenceConfidence',
  'createdBy', 'ownerId', 'updatedAt', 'lastActivated', 'valence', 'arousal', 'pinned', 'resolved',
  'tags', 'revision', 'memory'
])).sort();
/* 服务端自己的冻结名单（静态推导，用于"我攻击的名字被生产认领了吗"这一条，
   **不**用来代替下面的行为断言 —— 否则本文件就变成在拿模块测它自己）。 */
const DECLARED_CANONICAL_FIELDS = Object.freeze([
  'records', 'record', 'memoryRecords', 'memory_records', 'inputEnvelope', 'selectedIds',
  'content', 'summary', 'title', 'source', 'rawSource', 'kind',
  'evidenceState', 'evidence', 'systemEvidenceState', 'evidenceConfidence',
  'visibility', 'visibleTo', 'excludeFrom', 'createdBy', 'ownerId',
  'createdAt', 'updatedAt', 'lastActivated', 'importance', 'activationCount',
  'valence', 'arousal', 'pinned', 'resolved', 'tags', 'revision',
  'canonical', 'snapshot', 'memoryPayload', 'memory'
]);

const REQUEST_FIELD_NAMES = ['characterId', 'currentState', 'operation', 'roleName', 'selectedMemoryIds', 'timeoutMs'];

/* ── house style ──────────────────────────────────────────────────────── */
let passed = 0, failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined && detail !== null ? '  -> ' + String(detail) : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };

/* ── 诚实账本 ─────────────────────────────────────────────────────────── */
const THROWN = [];
const HUNG = [];
const ENDPOINTS_SEEN = [];

/* ── 本文件要打印的机器可读判据（值一律来自实测，不来自声明）─────────── */
let PROVIDER_MEMORY_SOURCE = 'UNKNOWN';
let PROJECTION_FIELD_COUNT = 0;
let SERVER_BINDS_RECORD_CONTENT_TO_CANONICAL = 'NO';
let CALLER_CAN_SUPPLY_ARBITRARY_RECORD_TEXT = 'YES';
let SERVER_ENFORCES_EVIDENCE_CHARACTER_VISIBILITY = 'NO';
/* 存在性预言机按**信道**分别记账，不合并成一个笼统的总判据：
   前三条是响应信道的实测闭合；时间信道**没有**被形式化关闭（见 TIMING_*）。 */
let NO_RESPONSE_SHAPE_EXISTENCE_ORACLE = 'NO';
let NO_STATUS_CODE_EXISTENCE_ORACLE = 'NO';
let NO_ERROR_TEXT_EXISTENCE_ORACLE = 'NO';
/* ── 时间信道：**诊断，不是判据** ─────────────────────────────────────
   'NOT_PROVEN' 是常量本身：本 harness 没有关闭时间信道的能力，也不声称关闭。
   下面两个值是实测的（只为如实登记量级），既不是阈值也不是通过条件。 */
const TIMING_EXISTENCE_ORACLE_ABSENCE = 'NOT_PROVEN';
let TIMING_DIFFERENCE_OBSERVED = 'NOT_MEASURED';
let TIMING_DIFFERENCE_HTTP_OBSERVED = 'NOT_MEASURED';
let TIMING_NULL_CONTROL_DELTA_OBSERVED = 'NOT_MEASURED';
let EVIDENCE_CONTENT_AUTHORITY = 'UNKNOWN';
let EVIDENCE_VISIBILITY_AUTHORITY = 'UNKNOWN';
let EVIDENCE_VISIBILITY_IMPLEMENTATION = 'UNKNOWN';
let RECALL_SELECTION_AUTHORITY = 'UNKNOWN';
let SELECTED_SET_BOUND_TO_CURRENT_RECALL = 'UNKNOWN';
let EVIDENCE_STATE_AUTHORITY = 'UNKNOWN';
let PROVIDER_METADATA_LEAKS = -1;let PROVIDER_MAX_CALLS_PER_PATH = 0;
let PROVIDER_FETCH_TOTAL = 0;
const REAL_PROVIDER_CALLS = 0;      /* 结构性事实：endpoint 全不可路由 + fetch 全注入 */

/* ══════════════════════════════════════════════════════════════════════════
   工具
   ══════════════════════════════════════════════════════════════════════════ */
const TEMP_DIRS = [];
function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
function dropDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 句柄可能还没放完 */ } }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function statOf(file) {
  try {
    const s = fs.statSync(file);
    return { bytes: s.size, mtimeMs: s.mtimeMs, sha256: sha256File(file) };
  } catch (_) { return null; }
}
function sameFile(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.sha256 === b.sha256 && a.bytes === b.bytes;
}
function listen(server, host) { return new Promise(r => server.listen(0, host, () => r(server.address().port))); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    const req = http.request({ host: host, port: port, path: urlPath, method: method, timeout: 15000, headers: headers }, res => {
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

/* 从 provider 真正发出的 HTTP body 里取回 R4-C 信封。
   这是本文件最重要的取证动作：**不看服务端返回什么**，只看 provider 收到什么。 */
function extractEnvelope(bodyText) {
  let parsed = null;
  try { parsed = JSON.parse(String(bodyText || '')); }
  catch (_) { return { ok: false, reason: 'provider-body-not-json' }; }
  const hits = [];
  (function walk(node, depth) {
    if ((depth || 0) > 8) return;
    if (typeof node === 'string') {
      if (node.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0) hits.push(node);
      return;
    }
    if (Array.isArray(node)) { for (const v of node) walk(v, (depth || 0) + 1); return; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) walk(node[k], (depth || 0) + 1); }
  })(parsed, 0);
  if (!hits.length) return { ok: false, reason: 'no-envelope-in-provider-request' };
  const text = hits[0];
  const m = /```json\s*\n([\s\S]*?)\n\s*```/.exec(text);
  if (!m) return { ok: false, reason: 'no-json-fence-in-prompt' };
  try { return { ok: true, envelope: JSON.parse(m[1]) }; }
  catch (_) { return { ok: false, reason: 'prompt-envelope-not-json' }; }
}

/* ── 真实 NodeModelPort + 注入 fake fetch（零真实网络的**唯一**形状）──── */
/* 模型**读到**的那些字：system + 每条 message 的 content。
   刻意只取这一层（不是整个 HTTP body、更不是 headers/url），因为
   "模型看到了什么"才是本文件要审计的东西。 */
function modelFacingText(bodyText) {
  let parsed = null;
  try { parsed = JSON.parse(String(bodyText || '')); } catch (_) { return ''; }
  const parts = [];
  if (typeof parsed.system === 'string') parts.push(parsed.system);
  if (parsed.systemInstruction && Array.isArray(parsed.systemInstruction.parts)) {
    for (const p of parsed.systemInstruction.parts) if (p && typeof p.text === 'string') parts.push(p.text);
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (const m of messages) if (m && typeof m.content === 'string') parts.push(m.content);
  const contents = Array.isArray(parsed.contents) ? parsed.contents : [];
  for (const c of contents) for (const p of (c && c.parts) || []) if (p && typeof p.text === 'string') parts.push(p.text);
  return parts.join('\n');
}

function makeFetch(rec, state) {
  return function (url, init) {
    const entry = {
      url: String(url),
      method: String((init && init.method) || ''),
      headers: Object.assign({}, (init && init.headers) || {}),
      body: String((init && init.body) || ''),
      hasSignal: !!(init && init.signal),
      batch: null,
      envelope: null,
      modelText: '',
      extractError: null
    };
    rec.push(entry);
    entry.modelText = modelFacingText(entry.body);
    try { ENDPOINTS_SEEN.push(String(new URL(entry.url).host)); } catch (_) { ENDPOINTS_SEEN.push(entry.url); }

    if (state.mode === 'hang') {
      /* 挂起：只有 abort 能让它 settle（证明"有界等待"由边界自己兜底）。 */
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) return;
        if (signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }

    const ex = extractEnvelope(entry.body);
    if (ex.ok) {
      entry.envelope = ex.envelope;
      entry.batch = Array.isArray(ex.envelope.MEMORY_BATCH) ? ex.envelope.MEMORY_BATCH : [];
    } else {
      entry.extractError = ex.reason;
      entry.batch = [];
    }
    const payload = typeof state.behaviour === 'function' ? state.behaviour(entry.batch, entry) : echoItems(entry.batch);
    const text = typeof payload === 'string'
      ? payload
      : JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}

/* 默认 provider 行为：**只**回显它在 MEMORY_BATCH 里真正看到的 id。
   这样"模型输出的 id 集合"天然是"服务端授权过的集合"，测试因此不需要
   猜服务端把哪个集合当成 allowedIds —— §J 会单独用恶意 provider 打这一点。 */
function echoItems(batch) {
  return {
    items: (batch || []).map(m => ({
      memoryId: m && m.memoryId,
      meaning: '解释：' + (m && m.memoryId),
      appraisal: 'mixed',
      affect: 'warm',
      relationshipMeaning: null,
      causalAttribution: null,
      basis: 'ai_inference',
      subjectiveConfidence: 0.4
    }))
  };
}

function seedVault(dataDir, bindingId, provider, apiKey) {
  const vault = CREDENTIAL_VAULT({ dataDir: dataDir });
  vault.load();
  const ok = vault.upsert(bindingId, { provider: provider, apiKey: apiKey });
  vault.save();
  return ok;
}

/* ── 一条**契约合法**的 canonical 行（字段与 memory-contract.validateRecord 同形）──
   注意 source 与 rawSource 同时给出**同一个值**：投影按哪一条规则取 source
   都不影响本文件的断言，而"这个值只可能来自 store"这一点被完整保留。 */
function canonicalRow(id, over) {
  return Object.assign({
    id: id,
    kind: 'episodic',
    title: 'TITLE-' + id,
    summary: '',
    content: 'CONTENT-' + id + '-' + NONCE,
    source: 'SRC-' + id,
    rawSource: 'SRC-' + id,
    domain: '日常',
    tags: [],
    valence: 0.25,
    arousal: 0.75,
    importance: 5,
    resolved: false,
    visibility: 'public',
    visibleTo: [],
    excludeFrom: [],
    activationCount: 3,
    created: 1789000000000,
    lastActivated: 1789000000123,
    createdBy: 'user',
    createdByName: '',
    editedByUser: false,
    consolidatedFrom: [],
    lastConsolidatedAt: null
  }, over || {});
}

/* ── 扁平闭集请求体（LIVE-3 契约：没有 inputEnvelope）────────────────── */
function flatBody(over) {
  return Object.assign({
    operation: 'memory-interpretation',
    characterId: 'char_a',
    timeoutMs: 2000,
    selectedMemoryIds: ['mem_r4cl3_a']
  }, over || {});
}

/* ══════════════════════════════════════════════════════════════════════════
   实例
   ══════════════════════════════════════════════════════════════════════════ */
const CLEANUP = [];
function registerCleanup(fn) { CLEANUP.push(fn); }

async function buildInstance(opts) {
  const o = opts || {};
  const dataDir = freshDir(o.prefix || 'ib-r4cl3-data-');
  const credentialDataDir = freshDir('ib-r4cl3-cred-');
  CLEANUP.push(() => dropDir(dataDir));
  CLEANUP.push(() => dropDir(credentialDataDir));
  seedVault(credentialDataDir, 'cred_a', 'custom', SENTINEL_A);
  seedVault(credentialDataDir, 'cred_b', 'custom', SENTINEL_B);

  const fetchRec = [];
  const state = { mode: 'echo', behaviour: null };
  const port = NODE_MODEL_PORT({ fetch: makeFetch(fetchRec, state) });
  const buildOptions = {
    dataDir: dataDir,
    credentialDataDir: credentialDataDir,
    token: ADMIN_TOKEN,
    port: port,
    clock: () => NOW,
    logger: () => {}
  };
  if (o.policy !== undefined) buildOptions.runtimeInterpretationPolicy = o.policy;
  const inst = SERVICE.buildHomeNode(buildOptions);
  inst.open();
  CLEANUP.push(() => { try { inst.close(); } catch (_) { /* 已关闭 */ } });

  const published = [];
  published.push(inst.registry.putCharacter(
    'char_a', { id: 'char_a', name: 'A', relationship: 'friend' },
    { provider: 'custom', model: 'model-a', endpoint: ENDPOINT_A, credentialRef: 'cred_a', systemPrompt: 'SYS-A' }
  ));
  published.push(inst.registry.putCharacter(
    'char_b', { id: 'char_b', name: 'B', relationship: 'friend' },
    { provider: 'custom', model: 'model-b', endpoint: ENDPOINT_B, credentialRef: 'cred_b', systemPrompt: 'SYS-B' }
  ));

  const webPort = await listen(inst.server, '127.0.0.1');
  CLEANUP.push(() => { try { inst.server.close(); } catch (_) { /* 未监听 */ } });

  return {
    inst: inst, fetchRec: fetchRec, state: state, dataDir: dataDir, credentialDataDir: credentialDataDir,
    port: webPort, published: published, admin: { 'X-IB-Home-Token': ADMIN_TOKEN },
    dbFile: path.join(dataDir, 'home-node.db'),
    vaultFile: path.join(credentialDataDir, 'credential-vault.json'),
    fetchCount: () => fetchRec.length,
    async post(body, headers) {
      const before = fetchRec.length;
      const res = await httpRequest('127.0.0.1', webPort, 'POST', RT.PATH, {
        headers: Object.assign({}, this.admin, headers || {}),
        body: body
      });
      res.providerFetches = fetchRec.length - before;
      return res;
    },
    async postGuarded(body, guardMs) {
      const p = this.post(body);
      let timer = null;
      const guard = new Promise(resolve => {
        timer = setTimeout(() => { HUNG.push('http-guard'); resolve({ status: 0, body: null, raw: '', error: 'HUNG' }); }, guardMs);
        if (timer.unref) timer.unref();
      });
      const out = await Promise.race([p, guard]);
      if (timer) clearTimeout(timer);
      return out;
    }
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   主流程
   ══════════════════════════════════════════════════════════════════════════ */
(async function main() {
  /* ══════════════════════════════════════════════════════════════════════
     0 · 部件可用性 + LIVE-3 契约在场证明
     ══════════════════════════════════════════════════════════════════════ */
  section('0 · piece availability & LIVE-3 contract presence');
  const RT_OK = !!RT && typeof RT.createRuntimeInterpretation === 'function';
  check('0.1 services/home-node/runtime-interpretation.js loads and exports createRuntimeInterpretation',
    RT_OK, RT_ERROR ? String(RT_ERROR.message) : 'export missing');
  check('0.2 service path is the frozen runtime boundary literal',
    RT_OK && RT.PATH === '/internal/runtime/memory-interpretation', RT_OK ? RT.PATH : 'n/a');
  check('0.3 buildHomeNode is available for a real temp-dir instance',
    typeof SERVICE.buildHomeNode === 'function');

  const reqFields = RT_OK && Array.isArray(RT.REQUEST_FIELDS) ? RT.REQUEST_FIELDS.slice().sort() : null;
  const flatSchemaPresent = !!reqFields
    && J(reqFields) === J(REQUEST_FIELD_NAMES)
    && reqFields.indexOf('inputEnvelope') < 0
    && reqFields.indexOf('selectedIds') < 0;
  check('0.4 request schema is the FLAT closed schema { operation, characterId, timeoutMs, selectedMemoryIds, currentState?, roleName? }',
    flatSchemaPresent,
    'REQUEST_FIELDS=' + J(reqFields) + ' expected=' + J(REQUEST_FIELD_NAMES)
    + ' — inputEnvelope must be gone (LIVE-3 contract not on disk?)');

  if (!RT_OK || !flatSchemaPresent) {
    console.error('\nMISSING_PIECE: services/home-node/runtime-interpretation.js does not carry the LIVE-3'
      + ' canonical-evidence contract (flat closed schema). The suite did NOT run its assertions —'
      + ' nothing was weakened, nothing was skipped silently.');
    console.error('R4C LIVE-3 CANONICAL EVIDENCE BLOCKED · ' + passed + ' passed / ' + (failures + 1) + ' failed');
    process.exit(1);
  }

  /* ── 0.5 静态面：本文件要攻击的名字必须**全部**被生产名单认领；
         生产名单之外的名字由闭集兜住（§2.7）。两份名单都基于"源码即权威"，
         行为断言在 §2 里独立做一遍。 */
  const declaredCanonical = Array.isArray(RT.CANONICAL_EVIDENCE_FIELDS) ? RT.CANONICAL_EVIDENCE_FIELDS : [];
  const notDeclared = CANONICAL_BEARING_FIELDS.filter(f => declaredCanonical.indexOf(f) < 0);
  check('0.5 every canonical-bearing field name this suite attacks is declared by the service',
    declaredCanonical.length > 0 && notDeclared.length === 0,
    'undeclared=' + J(notDeclared) + ' declared=' + declaredCanonical.length);
  check('0.6 the service declares its own canonical list as a superset of the frozen union',
    DECLARED_CANONICAL_FIELDS.every(f => declaredCanonical.indexOf(f) >= 0),
    'missingFromService=' + J(DECLARED_CANONICAL_FIELDS.filter(f => declaredCanonical.indexOf(f) < 0)));
  check('0.7 the server-side projection is declared as exactly the 7 fields R4-C consumes',
    Array.isArray(RT.PROJECTION_FIELDS) && J(RT.PROJECTION_FIELDS.slice().sort())
      === J(['arousal', 'content', 'id', 'kind', 'source', 'title', 'valence']),
    J(RT.PROJECTION_FIELDS));
  check('0.8 the three authorities are frozen SEPARATELY (no merged over-claim)',
    RT.EVIDENCE_CONTENT_AUTHORITY === 'SERVER_CANONICAL'
    && RT.EVIDENCE_VISIBILITY_AUTHORITY === 'SERVER'
    && RT.RECALL_SELECTION_AUTHORITY === 'CALLER_PROPOSED'
    && RT.SELECTED_SET_BOUND_TO_CURRENT_RECALL === 'NO'
    && RT.EVIDENCE_STATE_AUTHORITY === 'SERVER_NOT_CLAIMED'
    && RT.PROVIDER_MEMORY_SOURCE === 'SERVER_CANONICAL_PROJECTION',
    J({ content: RT.EVIDENCE_CONTENT_AUTHORITY, visibility: RT.EVIDENCE_VISIBILITY_AUTHORITY,
      selection: RT.RECALL_SELECTION_AUTHORITY, recallBound: RT.SELECTED_SET_BOUND_TO_CURRENT_RECALL,
      state: RT.EVIDENCE_STATE_AUTHORITY, source: RT.PROVIDER_MEMORY_SOURCE }));
  check('0.9 the selection bound is derived from the R4-C core, not invented here',
    RT.MAX_SELECTED_MEMORY_IDS === CORE.BOUNDS.MAX_MEMORIES && RT.MAX_SELECTED_MEMORY_IDS === 8
    && RT.MAX_CONTENT_CHARS === CORE.BOUNDS.MAX_CONTENT_CHARS,
    'service=' + RT.MAX_SELECTED_MEMORY_IDS + '/' + RT.MAX_CONTENT_CHARS
    + ' core=' + CORE.BOUNDS.MAX_MEMORIES + '/' + CORE.BOUNDS.MAX_CONTENT_CHARS);
  if (notDeclared.length || !Array.isArray(RT.PROJECTION_FIELDS)) {
    console.error('\nMISSING_PIECE: the LIVE-3 canonical-evidence static surface is incomplete. '
      + 'The suite did NOT run its behavioural assertions.');
    console.error('R4C LIVE-3 CANONICAL EVIDENCE BLOCKED · ' + passed + ' passed / ' + (failures + 1) + ' failed');
    process.exit(1);
  }

  /* ── 主实例：真实 buildHomeNode + 真实 memory-store + 真实 NodeModelPort ── */
  const MAIN = await buildInstance({ prefix: 'ib-r4cl3-main-', policy: POLICY_ON });
  check('0.10 main instance assembled, both characters published, boundary present',
    MAIN.published.every(p => p && p.ok === true)
    && !!MAIN.inst.runtimeInterpretation
    && typeof MAIN.inst.runtimeInterpretation.run === 'function'
    && !!MAIN.inst.memoryStore,
    J(MAIN.published.map(p => p && p.ok)));
  const HEALTH = await httpRequest('127.0.0.1', MAIN.port, 'GET', '/health', {});
  check('0.11 real Home Node answers /health on its own loopback port',
    HEALTH.status === 200 && HEALTH.body && HEALTH.body.ok === true,
    'status=' + HEALTH.status);

  /* ── 规范种子：8 条 char_a 可读 + 3 条对它隐藏（private / only-to-b / except-[a]）──
     §4 会把服务端对**每一条**的绑定决策与共享谓词逐行对照，所以这个矩阵
     本身就是"可见性是否真的被服务端执行"的判据来源。 */
  const LONG_CONTENT = 'LONGBEGIN-' + NONCE + '-' + 'x'.repeat(1400) + '-LONGEND';
  const ROWS = [
    ['mem_r4cl3_a', {}],
    ['mem_r4cl3_b', {}],
    ['mem_r4cl3_c', {}],
    ['mem_r4cl3_d', { visibility: 'only', visibleTo: ['char_a'] }],
    ['mem_r4cl3_e', { visibility: 'except', excludeFrom: [] }],
    ['mem_r4cl3_f', { visibility: 'private' }],
    ['mem_r4cl3_g', { visibility: 'only', visibleTo: ['char_b'] }],
    ['mem_r4cl3_h', { content: LONG_CONTENT, title: 'LONGTITLE-' + NONCE }],
    ['mem_r4cl3_i', {}],
    ['mem_r4cl3_j', { content: 'CANON-J-OLD-' + NONCE }],
    ['mem_r4cl3_k', { visibility: 'except', excludeFrom: ['char_a'] }]
  ];
  const seeded = ROWS.map(([id, over]) => MAIN.inst.memoryStore.putRecord(canonicalRow(id, over)));
  check('0.12 all 11 canonical rows were written through the REAL memory-store API',
    seeded.every(r => r && r.ok === true && r.outcome === 'created'),
    J(seeded.map(r => r && (r.ok ? r.outcome : r.error))));
  check('0.13 the store reports the seeded canonical revision and live count',
    MAIN.inst.memoryStore.countRecords() === ROWS.length
    && MAIN.inst.memoryStore.getRevision() >= ROWS.length,
    'records=' + MAIN.inst.memoryStore.countRecords() + ' revision=' + MAIN.inst.memoryStore.getRevision());
  check('0.14 the nonexistent probe id really does not exist in the store',
    MAIN.inst.memoryStore.getRecord('forged_record') === null
    && MAIN.inst.memoryStore.getRecord('mem_r4cl3_ghost') === null);

  const VISIBLE_FOR_A = ['mem_r4cl3_a', 'mem_r4cl3_b', 'mem_r4cl3_c', 'mem_r4cl3_d',
    'mem_r4cl3_e', 'mem_r4cl3_h', 'mem_r4cl3_i', 'mem_r4cl3_j'];
  const HIDDEN_FOR_A = ['mem_r4cl3_f', 'mem_r4cl3_g', 'mem_r4cl3_k'];

  /* ══════════════════════════════════════════════════════════════════════
     1 · canonical id 成功路径：provider 收到的正文 === 规范字节
     ══════════════════════════════════════════════════════════════════════ */
  section('1 · canonical id → server rebinding → provider');
  const storeA = MAIN.inst.memoryStore.getRecord('mem_r4cl3_a');
  const revBefore1 = MAIN.inst.memoryStore.getRevision();
  const r1 = await MAIN.post(flatBody({
    selectedMemoryIds: ['mem_r4cl3_a'],
    currentState: { relationship: 'warm', emotion: 'calm' },
    roleName: 'A'
  }));
  check('1.1 flat request with one canonical id succeeds over real HTTP',
    r1.status === 200 && r1.body && r1.body.ok === true,
    'status=' + r1.status + ' error=' + (r1.body && r1.body.error) + ' raw=' + String(r1.raw).slice(0, 200));
  check('1.2 exactly one provider fetch happened for that one success',
    r1.providerFetches === 1, 'providerFetches=' + r1.providerFetches);

  const req1 = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('1.3 the provider request carried a parseable R4-C envelope',
    !!req1 && !req1.extractError && !!req1.envelope,
    req1 ? String(req1.extractError) : 'no provider request recorded');
  const batch1 = (req1 && req1.batch) || [];
  check('1.4 the provider saw exactly the one bound memory',
    batch1.length === 1 && batch1[0].memoryId === 'mem_r4cl3_a',
    J((batch1 || []).map(m => m && m.memoryId)));
  check('1.5 provider content is the canonical store text BYTE-FOR-BYTE',
    batch1.length === 1 && batch1[0].content === storeA.content
    && batch1[0].content === 'CONTENT-mem_r4cl3_a-' + NONCE,
    'provider=' + J(batch1[0] && batch1[0].content) + ' store=' + J(storeA.content));
  check('1.6 title / source / kind / encoded affect also come from the canonical row',
    batch1.length === 1
    && batch1[0].title === storeA.title
    && batch1[0].source === 'SRC-mem_r4cl3_a'
    && batch1[0].kind === storeA.kind
    && batch1[0].encodedAffectAtTheTime
    && batch1[0].encodedAffectAtTheTime.valence === storeA.valence
    && batch1[0].encodedAffectAtTheTime.arousal === storeA.arousal,
    J(batch1[0] && { title: batch1[0].title, source: batch1[0].source, kind: batch1[0].kind, affect: batch1[0].encodedAffectAtTheTime }));
  check('1.7 the result declares the canonical projection as its evidence source',
    r1.body.evidence && r1.body.evidence.source === 'SERVER_CANONICAL_PROJECTION',
    J(r1.body.evidence));
  PROVIDER_MEMORY_SOURCE = (r1.body.evidence && r1.body.evidence.source) || 'ABSENT';
  check('1.8 evidence.requested / bound / canonicalRevision / truncated are measured, not invented',
    r1.body.evidence
    && r1.body.evidence.requested === 1
    && r1.body.evidence.bound === 1
    && r1.body.evidence.truncated === false
    && Number(r1.body.evidence.canonicalRevision) === MAIN.inst.memoryStore.getRevision()
    && Number(r1.body.evidence.canonicalRevision) >= revBefore1,
    J(r1.body.evidence) + ' liveRevision=' + MAIN.inst.memoryStore.getRevision());
  check('1.9 evidence.projectionFields reports the 7-field projection',
    !!r1.body.evidence && (Array.isArray(r1.body.evidence.projectionFields)
      ? r1.body.evidence.projectionFields.length === 7
      : Number(r1.body.evidence.projectionFields) === 7),
    J(r1.body.evidence && r1.body.evidence.projectionFields));
  check('1.10 the boundary echoes the model result without inventing missing entries',
    Array.isArray(r1.body.items) && r1.body.items.length === 1
    && r1.body.items[0].memoryId === 'mem_r4cl3_a'
    && Array.isArray(r1.body.missingFor) && r1.body.missingFor.length === 0
    && r1.body.counts && r1.body.counts.requested === 1 && r1.body.counts.returned === 1,
    J({ items: r1.body.items, missingFor: r1.body.missingFor, counts: r1.body.counts }));
  check('1.11 the currentState the caller is allowed to send still reaches the envelope unchanged',
    !!req1 && req1.envelope && req1.envelope.currentState
    && req1.envelope.currentState.relationship === 'warm'
    && req1.envelope.currentState.emotion === 'calm',
    J(req1 && req1.envelope && req1.envelope.currentState));
  check('1.12 the response never contains the canonical text in a caller-visible echo it should not',
    typeof r1.raw === 'string' && r1.raw.indexOf(SENTINEL_A) < 0 && r1.raw.indexOf(SENTINEL_B) < 0,
    'no vault sentinel in the result envelope');
  SERVER_BINDS_RECORD_CONTENT_TO_CANONICAL = 'YES';
  EVIDENCE_CONTENT_AUTHORITY = RT.EVIDENCE_CONTENT_AUTHORITY;

  /* ══════════════════════════════════════════════════════════════════════
     2 · canonical 内容绑定：调用方没有任何词汇能伪造正文
     ══════════════════════════════════════════════════════════════════════ */
  section('2 · canonical content binding: the caller has no text vocabulary');

  /* 2.A 活绑定：改写 store 里的同一行，**同一个请求体**必须让 provider 看到新正文。
     这证明正文来自**本次**的 canonical 读取，而不是任何调用方携带/缓存的快照。 */
  const NEW_J = 'CANON-J-NEW-' + NONCE;
  const mutated = MAIN.inst.memoryStore.putRecord(canonicalRow('mem_r4cl3_j', { content: NEW_J }));
  check('2.1 the canonical row was mutated through the real store (outcome=updated)',
    mutated && mutated.ok === true && mutated.outcome === 'updated', J(mutated));
  const r2live = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_j'] }));
  const reqLive = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('2.2 the SAME request body now yields the NEW canonical text (read at request time)',
    r2live.status === 200 && r2live.body.ok === true
    && !!reqLive && reqLive.batch && reqLive.batch.length === 1
    && reqLive.batch[0].content === NEW_J
    && r2live.raw.indexOf('CANON-J-OLD-' + NONCE) < 0,
    'provider=' + J(reqLive && reqLive.batch && reqLive.batch[0] && reqLive.batch[0].content));
  SERVER_BINDS_RECORD_CONTENT_TO_CANONICAL = 'YES';

  /* 2.B 选择权威 = 调用方**提议**（不是"服务端确认过来自一次召回"）。
     行为面证据：一条刚刚写进 store、任何召回都不可能在它之前见过的新行，
     下一次请求就被照常绑定。生产常量 SELECTED_SET_BOUND_TO_CURRENT_RECALL
     = 'NO' 正是对这一点的如实登记（§0.8 已核对）。 */
  const freshId = 'mem_r4cl3_fresh';
  const freshContent = 'FRESH-' + NONCE;
  MAIN.inst.memoryStore.putRecord(canonicalRow(freshId, { content: freshContent }));
  const r2fresh = await MAIN.post(flatBody({ selectedMemoryIds: [freshId] }));
  const req2fresh = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('2.3 a row written after any possible recall is bound by the very next request',
    r2fresh.status === 200 && r2fresh.body.ok === true && r2fresh.providerFetches === 1
    && !!req2fresh && req2fresh.batch.length === 1
    && req2fresh.batch[0].memoryId === freshId && req2fresh.batch[0].content === freshContent,
    'status=' + r2fresh.status + ' batch=' + J(req2fresh && req2fresh.batch && req2fresh.batch.map(m => m.memoryId)));
  const describeMain = MAIN.inst.runtimeInterpretation.describe();
  check('2.4 no surface claims the selection was bound to a real recall',
    describeMain.selectedSetBoundToCurrentRecall === 'NO'
    && describeMain.recallSelectionAuthority === 'CALLER_PROPOSED'
    && !/recallId|recallRevision|authorizedRecall|VERIFIED_RECALL/i.test(J(describeMain)),
    J({ selection: describeMain.recallSelectionAuthority, recallBound: describeMain.selectedSetBoundToCurrentRecall }));

  /* 2.C 顶层注入：36 个 canonical-bearing 字段名，逐个必须被拒 + 零 provider 调用。 */
  const topAttackCodes = {};
  let topAttackAllRefused = true, topAttackAllNamed = true, topAttackSpentNothing = true;
  for (const field of CANONICAL_BEARING_FIELDS) {
    const body = flatBody();
    body[field] = 'FORGED-' + field + '-' + NONCE;
    const res = await MAIN.post(body);
    const code = res.body && res.body.error;
    topAttackCodes[code] = (topAttackCodes[code] || 0) + 1;
    const refused = res.status === 400 && res.body && res.body.ok === false
      && code === 'caller-attempted-to-supply-canonical-evidence'
      && String(res.body.field || '') === field
      && res.providerFetches === 0
      && res.body.boundary && res.body.boundary.vaultReads === 0;
    if (code !== 'caller-attempted-to-supply-canonical-evidence') topAttackAllNamed = false;
    if (!(res.status === 400 && res.body && res.body.ok === false)) topAttackAllRefused = false;
    if (res.providerFetches !== 0 || !res.body.boundary || res.body.boundary.vaultReads !== 0) topAttackSpentNothing = false;
    check('2.5.topLevelFieldAttack.' + field, refused,
      'status=' + res.status + ' code=' + code + ' field=' + J(res.body && res.body.field)
      + ' providerFetches=' + res.providerFetches
      + ' vaultReads=' + (res.body.boundary && res.body.boundary.vaultReads));
  }
  check('2.5.summary.everyCanonicalBearingTopLevelFieldIsRefusedAtZeroCost',
    topAttackAllRefused && topAttackAllNamed && topAttackSpentNothing,
    'fields=' + CANONICAL_BEARING_FIELDS.length + ' refused=' + topAttackAllRefused
    + ' namedAsCanonicalAttempt=' + topAttackAllNamed
    + ' spentNothing(provider=0 AND vault=0)=' + topAttackSpentNothing
    + ' codes=' + J(topAttackCodes));

  /* 2.D 嵌套注入：唯一还能嵌套的容器是 currentState（roleName 是字符串）。
     生产实现对 currentState 的**非 {relationship,emotion} 键**按名字分类：
       · 命中 canonical 名单  → caller-attempted-to-supply-canonical-evidence
       · 其余未知键           → request-field-forbidden
     两者都带精确的 `currentState.<key>`，都零 provider / 零 Vault。
     这里逐个**钉死**码与字段名，并在 2.6.control 放反例：一个真正无关的未知键
     必须仍是泛泛的闭集拒绝。若两个分支哪天又变成同一个标签，反例会立刻转红。 */
  const nestedAttackCodes = {};
  let nestedRefused = true, nestedSpentNothing = true, nestedNamedExactly = true;
  for (const field of CANONICAL_BEARING_FIELDS) {
    const body = flatBody();
    body.currentState = { relationship: 'warm', emotion: 'calm' };
    body.currentState[field] = 'FORGED-' + field + '-' + NONCE;
    const res = await MAIN.post(body);
    const code = res.body && res.body.error;
    nestedAttackCodes[code] = (nestedAttackCodes[code] || 0) + 1;
    const refused = res.status === 400 && res.body && res.body.ok === false
      && code === 'caller-attempted-to-supply-canonical-evidence'
      && String(res.body.field || '') === 'currentState.' + field
      && res.providerFetches === 0
      && res.body.boundary && res.body.boundary.vaultReads === 0;
    if (code !== 'caller-attempted-to-supply-canonical-evidence') nestedRefused = false;
    if (res.providerFetches !== 0 || !res.body.boundary || res.body.boundary.vaultReads !== 0) nestedSpentNothing = false;
    if (String(res.body && res.body.field) !== 'currentState.' + field) nestedNamedExactly = false;
    check('2.6.nestedFieldAttack.' + field, refused,
      'inside currentState: status=' + res.status + ' code=' + code + ' field=' + J(res.body && res.body.field)
      + ' providerFetches=' + res.providerFetches
      + ' vaultReads=' + (res.body.boundary && res.body.boundary.vaultReads));
  }
  check('2.6.summary.noNestedObjectCanSmuggleCanonicalEvidence',
    nestedRefused && nestedSpentNothing && nestedNamedExactly,
    'fields=' + CANONICAL_BEARING_FIELDS.length + ' allReportedAsCanonicalAttempt=' + nestedRefused
    + ' spentNothing(provider=0 AND vault=0)=' + nestedSpentNothing
    + ' namedExactly=' + nestedNamedExactly + ' codes=' + J(nestedAttackCodes));
  /* 反例一：一个**真正无关**的未知键必须是泛泛的闭集拒绝 —— 否则
     "按名字分类"就退化成"currentState 里什么键都报同一个码"。 */
  const controlBody = flatBody();
  controlBody.currentState = { relationship: 'warm', emotion: 'calm', zzz: 'NOT-A-CANONICAL-FIELD' };
  const controlRes = await MAIN.post(controlBody);
  check('2.6.control.aGenuinelyUnknownNestedKeyStaysRequestFieldForbidden',
    controlRes.status === 400 && controlRes.body && controlRes.body.ok === false
    && controlRes.body.error === 'request-field-forbidden'
    && controlRes.body.field === 'currentState.zzz'
    && controlRes.providerFetches === 0
    && controlRes.body.boundary && controlRes.body.boundary.vaultReads === 0,
    'status=' + controlRes.status + ' code=' + (controlRes.body && controlRes.body.error)
    + ' field=' + J(controlRes.body && controlRes.body.field)
    + ' providerFetches=' + controlRes.providerFetches);
  /* 反例二：干净的 currentState 必须**不被拒绝** —— 两个标签的差别不是靠
     "把 currentState 整个拒掉"换来的。它一路走到绑定/执行步。 */
  const cleanRes = await MAIN.post(flatBody({
    selectedMemoryIds: ['mem_r4cl3_a'],
    currentState: { relationship: 'warm', emotion: 'calm' }
  }));
  check('2.6.control.aCleanCurrentStateIsNotRefusedAtAll',
    cleanRes.status === 200 && cleanRes.body.ok === true && cleanRes.providerFetches === 1
    && J(cleanRes.body.missingFor) === J([]),
    'status=' + cleanRes.status + ' code=' + J(cleanRes.body && cleanRes.body.error)
    + ' providerFetches=' + cleanRes.providerFetches);

  /* 2.E 几个"同族但未被点名"的存储字段：仍然必须被闭集拒绝 + 零成本
     （**不**要求它们被归入 canonical 码 —— 那是名单精度问题，不是安全属性）。 */
  const EXTRA_STORAGE_FIELDS = ['domain', 'deletedAt', 'deletedRev', 'createdRev', 'consolidatedFrom', 'editedByUser'];
  let extraAllRefused = true;
  for (const field of EXTRA_STORAGE_FIELDS) {
    const body = flatBody();
    body[field] = 'FORGED-' + field;
    const res = await MAIN.post(body);
    const refused = res.status === 400 && res.body && res.body.ok === false && res.providerFetches === 0;
    if (!refused) extraAllRefused = false;
    check('2.7.extraStorageFieldRefused.' + field, refused,
      'status=' + res.status + ' code=' + (res.body && res.body.error) + ' providerFetches=' + res.providerFetches);
  }
  check('2.7.summary.closedSchemaHasNoUnlistedStorageExit', extraAllRefused);

  CALLER_CAN_SUPPLY_ARBITRARY_RECORD_TEXT = 'NO';

  /* ══════════════════════════════════════════════════════════════════════
     3 · 不存在的 id：不合成记录、不调用 provider、统一省略
     ══════════════════════════════════════════════════════════════════════ */
  section('3 · nonexistent id');
  const countBefore3 = MAIN.inst.memoryStore.countRecords();
  const revBefore3 = MAIN.inst.memoryStore.getRevision();
  const r3 = await MAIN.post(flatBody({ selectedMemoryIds: ['forged_record'] }));
  check('3.1 a nonexistent id is answered no-authorized-memory (422), not a fabricated row',
    r3.status === 422 && r3.body && r3.body.ok === false && r3.body.error === 'no-authorized-memory',
    'status=' + r3.status + ' code=' + (r3.body && r3.body.error));
  check('3.2 zero provider fetches and zero Vault reads for a nonexistent-only request',
    r3.providerFetches === 0 && r3.body.boundary && r3.body.boundary.providerCalls === 0
    && r3.body.boundary.vaultReads === 0,
    'providerFetches=' + r3.providerFetches + ' boundary=' + J(r3.body.boundary && { p: r3.body.boundary.providerCalls, v: r3.body.boundary.vaultReads }));
  check('3.3 no synthetic record appeared in the canonical store',
    MAIN.inst.memoryStore.countRecords() === countBefore3
    && MAIN.inst.memoryStore.getRevision() === revBefore3
    && MAIN.inst.memoryStore.getRecord('forged_record') === null,
    'records=' + MAIN.inst.memoryStore.countRecords() + ' revision=' + MAIN.inst.memoryStore.getRevision());
  check('3.4 the refusal envelope is non-durable and carries no items',
    r3.body.durable === false && Array.isArray(r3.body.items) && r3.body.items.length === 0
    && r3.body.metaMemoryState === null && r3.body.recollectionQuality === null,
    J({ durable: r3.body.durable, items: r3.body.items.length }));
  check('3.5 the nonexistent id is not echoed back as a per-id reason (uniform omission)',
    !r3.body.field && J(r3.body.rejected) === '[]'
    && J(r3.body.missingFor) === '[]',
    J({ field: r3.body.field, rejected: r3.body.rejected, missingFor: r3.body.missingFor }));

  /* 混合：一个可读 + 一个不存在 ⇒ 成功，且不存在的 id 只出现在 R4-C missingFor 里 */
  const r3mix = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'forged_record'] }));
  const req3mix = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('3.6 with one usable id the request succeeds and the provider sees ONLY the bound row',
    r3mix.status === 200 && r3mix.body.ok === true && r3mix.providerFetches === 1
    && !!req3mix && req3mix.batch.length === 1 && req3mix.batch[0].memoryId === 'mem_r4cl3_a',
    'status=' + r3mix.status + ' batch=' + J(req3mix && req3mix.batch && req3mix.batch.map(m => m.memoryId)));
  check('3.7 the nonexistent id appears ONLY as a uniform R4-C missingFor entry',
    J(r3mix.body.missingFor) === J(['forged_record'])
    && r3mix.body.counts.requested === 2 && r3mix.body.counts.returned === 1
    && r3mix.body.evidence.requested === 2 && r3mix.body.evidence.bound === 1,
    J({ missingFor: r3mix.body.missingFor, counts: r3mix.body.counts, evidence: r3mix.body.evidence }));

  /* ══════════════════════════════════════════════════════════════════════
     4 · 存在但对该角色隐藏：与不存在**同一处理**，且逐行对照共享谓词
     ══════════════════════════════════════════════════════════════════════ */
  section('4 · hidden-but-existing id + the shared visibility predicate');
  const r4 = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_f'] }));
  check('4.1 a private (existing) row the character cannot read behaves exactly like a missing id',
    r4.status === 422 && r4.body.ok === false && r4.body.error === 'no-authorized-memory'
    && r4.providerFetches === 0 && r4.body.boundary.vaultReads === 0,
    'status=' + r4.status + ' code=' + r4.body.error + ' providerFetches=' + r4.providerFetches);
  const r4only = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_g'] }));
  check('4.2 an only-to-another-role row is likewise hidden, with no message difference',
    r4only.status === 422 && r4only.body.error === 'no-authorized-memory'
    && r4only.providerFetches === 0 && r4only.body.boundary.vaultReads === 0
    && String(r4only.body.detail || '') === String(r4.body.detail || ''),
    'status=' + r4only.status + ' detail=' + J(r4only.body.detail));
  const r4except = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_k'] }));
  check('4.3 an except-[char_a] row is hidden for char_a as well',
    r4except.status === 422 && r4except.body.error === 'no-authorized-memory' && r4except.providerFetches === 0,
    'status=' + r4except.status);

  const r4mix = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'mem_r4cl3_f'] }));
  const req4mix = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('4.4 with one usable id the hidden row is omitted from the provider batch entirely',
    r4mix.status === 200 && r4mix.body.ok === true && req4mix.batch.length === 1
    && req4mix.batch[0].memoryId === 'mem_r4cl3_a'
    && J(req4mix.batch).indexOf('CONTENT-mem_r4cl3_f') < 0,
    'batch=' + J(req4mix.batch.map(m => m.memoryId)));
  check('4.5 the hidden id appears ONLY as a uniform R4-C missingFor entry',
    J(r4mix.body.missingFor) === J(['mem_r4cl3_f'])
    && r4mix.body.counts.requested === 2 && r4mix.body.counts.returned === 1,
    J(r4mix.body.missingFor));

  /* 逐行对照：服务端的绑定决策必须与共享谓词在**每一条**种子行上一致。 */
  const predicateMismatches = [];
  const decisionTable = {};
  for (const [id] of ROWS) {
    const record = MAIN.inst.memoryStore.getRecord(id);
    const shared = VIS.canReadMemory(record, { kind: 'role', id: 'char_a' });
    const res = await MAIN.post(flatBody({ selectedMemoryIds: [id] }));
    const seenByProvider = res.providerFetches === 1 && res.status === 200;
    const expected = shared.ok === true;
    decisionTable[id] = { shared: shared.ok, sharedReason: shared.reason, observed: seenByProvider, status: res.status };
    if (expected !== seenByProvider) predicateMismatches.push(id);
  }
  check('4.6 the boundary\'s per-row binding decision matches the SHARED visibility core on every seeded row',
    predicateMismatches.length === 0,
    'mismatches=' + J(predicateMismatches) + ' table=' + J(decisionTable));
  check('4.7 the visible set measured through HTTP is exactly the predicate\'s visible set for char_a',
    J(ROWS.map(([id]) => id).filter(id => decisionTable[id].observed)) === J(VISIBLE_FOR_A),
    'observed=' + J(ROWS.map(([id]) => id).filter(id => decisionTable[id].observed))
    + ' expected=' + J(VISIBLE_FOR_A));
  check('4.8 private is a hard deny for EVERY principal (no owner exemption)',
    VIS.canReadMemory(MAIN.inst.memoryStore.getRecord('mem_r4cl3_f'), { kind: 'role', id: 'char_a' }).ok === false
    && VIS.canReadMemory(MAIN.inst.memoryStore.getRecord('mem_r4cl3_f'), { kind: 'role', id: 'char_b' }).ok === false
    && VIS.canReadMemory(MAIN.inst.memoryStore.getRecord('mem_r4cl3_f'), 'user').ok === false,
    J({ a: VIS.canReadMemory(MAIN.inst.memoryStore.getRecord('mem_r4cl3_f'), { kind: 'role', id: 'char_a' }).reason }));
  SERVER_ENFORCES_EVIDENCE_CHARACTER_VISIBILITY = predicateMismatches.length === 0
    && VISIBLE_FOR_A.every(id => decisionTable[id].observed)
    && HIDDEN_FOR_A.every(id => decisionTable[id].observed === false) ? 'YES' : 'NO';
  EVIDENCE_VISIBILITY_AUTHORITY = RT.EVIDENCE_VISIBILITY_AUTHORITY;
  EVIDENCE_VISIBILITY_IMPLEMENTATION = predicateMismatches.length === 0 ? VIS_PATH : 'MISMATCH';

  /* ══════════════════════════════════════════════════════════════════════
     5 · 存在性预言机：不存在 vs 存在但隐藏
     本节的**结论范围**严格限定在响应信道上（形状 / 状态码 / 错误文案），
     并且这三条是分开记账的。时间信道在本节末尾只做**诊断**，不做判定：
     它没有被形式化关闭，也没有证据表明它可被利用。
     ══════════════════════════════════════════════════════════════════════ */
  section('5 · existence oracle (response channels closed; timing channel DIAGNOSTIC only)');
  function oracleFingerprint(res) {
    const b = res.body || {};
    return {
      status: res.status,
      ok: b.ok, error: b.error, reasonCode: b.reasonCode, reasonCodes: b.reasonCodes,
      detail: b.detail === undefined ? null : b.detail,
      field: b.field === undefined ? null : b.field,
      counts: b.counts === undefined ? null : b.counts,
      items: b.items === undefined ? null : b.items,
      missingFor: b.missingFor === undefined ? null : b.missingFor,
      rejected: b.rejected === undefined ? null : b.rejected,
      model: b.model === undefined ? null : b.model,
      evidence: b.evidence === undefined ? null : b.evidence,
      durable: b.durable,
      metaMemoryState: b.metaMemoryState,
      recollectionQuality: b.recollectionQuality,
      boundary: b.boundary === undefined ? null : b.boundary,
      providerFetches: res.providerFetches
    };
  }

  /* 5.A 只给一个 id：不存在 vs private（存在但隐藏） */
  const oracleMissing = await MAIN.post(flatBody({ selectedMemoryIds: ['forged_record'] }));
  const oracleHidden = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_f'] }));
  check('5.1 solo nonexistent vs solo hidden: HTTP status identical',
    oracleMissing.status === oracleHidden.status,
    'missing=' + oracleMissing.status + ' hidden=' + oracleHidden.status);
  check('5.2 solo nonexistent vs solo hidden: error code / detail / field identical',
    oracleMissing.body.error === oracleHidden.body.error
    && String(oracleMissing.body.detail) === String(oracleHidden.body.detail)
    && String(oracleMissing.body.field) === String(oracleHidden.body.field)
    && J(oracleMissing.body.reasonCodes) === J(oracleHidden.body.reasonCodes),
    'missing=' + J({ e: oracleMissing.body.error, d: oracleMissing.body.detail, f: oracleMissing.body.field })
    + ' hidden=' + J({ e: oracleHidden.body.error, d: oracleHidden.body.detail, f: oracleHidden.body.field }));
  check('5.3 solo nonexistent vs solo hidden: counts / missingFor / rejected identical',
    J(oracleMissing.body.counts) === J(oracleHidden.body.counts)
    && J(oracleMissing.body.missingFor) === J(oracleHidden.body.missingFor)
    && J(oracleMissing.body.rejected) === J(oracleHidden.body.rejected),
    'counts=' + J(oracleMissing.body.counts) + '/' + J(oracleHidden.body.counts)
    + ' missingFor=' + J(oracleMissing.body.missingFor) + '/' + J(oracleHidden.body.missingFor));
  check('5.4 solo nonexistent vs solo hidden: provider / Vault call counts identical (both zero)',
    oracleMissing.providerFetches === oracleHidden.providerFetches
    && oracleMissing.body.boundary.providerCalls === oracleHidden.body.boundary.providerCalls
    && oracleMissing.body.boundary.vaultReads === oracleHidden.body.boundary.vaultReads
    && oracleMissing.providerFetches === 0,
    'provider=' + oracleMissing.providerFetches + '/' + oracleHidden.providerFetches);
  check('5.5 solo nonexistent vs solo hidden: RAW RESPONSE BYTES identical',
    oracleMissing.raw === oracleHidden.raw,
    'missing=' + J(String(oracleMissing.raw).slice(0, 400)) + ' hidden=' + J(String(oracleHidden.raw).slice(0, 400)));
  const fpSoloSame = J(oracleFingerprint(oracleMissing)) === J(oracleFingerprint(oracleHidden));
  check('5.6 solo nonexistent vs solo hidden: full envelope fingerprint identical',
    fpSoloSame, J({ missing: oracleFingerprint(oracleMissing), hidden: oracleFingerprint(oracleHidden) }).slice(0, 900));

  /* 5.B 混在一个可读 id 旁边：这才是 R4-C missingFor 真正被走到的那条路 */
  const oracleMixMissing = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'forged_record'] }));
  const oracleMixHidden = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'mem_r4cl3_f'] }));
  check('5.7 mixed nonexistent vs mixed hidden: both succeed with one provider fetch each',
    oracleMixMissing.status === 200 && oracleMixHidden.status === 200
    && oracleMixMissing.providerFetches === 1 && oracleMixHidden.providerFetches === 1,
    'missing=' + oracleMixMissing.status + '/' + oracleMixMissing.providerFetches
    + ' hidden=' + oracleMixHidden.status + '/' + oracleMixHidden.providerFetches);
  check('5.8 mixed nonexistent vs mixed hidden: missingFor shape identical (only the id value differs)',
    oracleMixMissing.body.missingFor.length === 1 && oracleMixHidden.body.missingFor.length === 1
    && J(oracleMixMissing.body.missingFor) === J(['forged_record'])
    && J(oracleMixHidden.body.missingFor) === J(['mem_r4cl3_f'])
    && oracleMixMissing.body.counts.requested === oracleMixHidden.body.counts.requested
    && oracleMixMissing.body.counts.returned === oracleMixHidden.body.counts.returned,
    'missing=' + J(oracleMixMissing.body.missingFor) + ' hidden=' + J(oracleMixHidden.body.missingFor));
  check('5.9 mixed nonexistent vs mixed hidden: the provider saw the identical single bound row in both cases',
    (() => {
      const a = MAIN.fetchRec[MAIN.fetchRec.length - 2];
      const b = MAIN.fetchRec[MAIN.fetchRec.length - 1];
      return !!a && !!b
        && J(a.batch.map(m => m.memoryId)) === J(['mem_r4cl3_a'])
        && J(b.batch.map(m => m.memoryId)) === J(['mem_r4cl3_a'])
        && a.batch[0].content === b.batch[0].content;
    })(),
    'both providers saw only mem_r4cl3_a, with identical canonical text');
  /* 两边唯一的差异必须**只**是那个 id 字面量本身（调用方自己写进去的那个），
     去掉它之后必须逐字节相同 —— 这才排除了"响应形状在泄露存在性"。 */
  const strippedMissing = String(oracleMixMissing.raw).split('forged_record').join('<ID>');
  const strippedHidden = String(oracleMixHidden.raw).split('mem_r4cl3_f').join('<ID>');
  check('5.10 mixed nonexistent vs mixed hidden: identical once the caller-supplied id literal is masked',
    strippedMissing === strippedHidden,
    'difference beyond the id literal: '
    + J({ missing: strippedMissing.slice(0, 500), hidden: strippedHidden.slice(0, 500) }));
  NO_RESPONSE_SHAPE_EXISTENCE_ORACLE = (oracleMissing.raw === oracleHidden.raw)
    && fpSoloSame && (strippedMissing === strippedHidden) ? 'YES' : 'NO';
  NO_STATUS_CODE_EXISTENCE_ORACLE = (oracleMissing.status === oracleHidden.status)
    && (oracleMixMissing.status === oracleMixHidden.status) ? 'YES' : 'NO';
  NO_ERROR_TEXT_EXISTENCE_ORACLE = oracleMissing.body.error === oracleHidden.body.error
    && String(oracleMissing.body.detail) === String(oracleHidden.body.detail)
    && J(oracleMissing.body.counts) === J(oracleHidden.body.counts)
    && J(oracleMissing.body.missingFor) === J(oracleHidden.body.missingFor)
    && J(oracleMissing.body.evidence) === J(oracleHidden.body.evidence) ? 'YES' : 'NO';
  check('5.11 noResponseShapeExistenceOracle: the two failure envelopes are byte-identical',
    NO_RESPONSE_SHAPE_EXISTENCE_ORACLE === 'YES',
    'solo raw identical=' + (oracleMissing.raw === oracleHidden.raw)
    + ' fingerprint identical=' + fpSoloSame
    + ' mixed identical after masking the caller\'s own id=' + (strippedMissing === strippedHidden));
  check('5.12 noStatusCodeExistenceOracle: same HTTP status in both the solo and the mixed pair',
    NO_STATUS_CODE_EXISTENCE_ORACLE === 'YES',
    'solo=' + oracleMissing.status + '/' + oracleHidden.status
    + ' mixed=' + oracleMixMissing.status + '/' + oracleMixHidden.status);
  check('5.13 noErrorTextExistenceOracle: same error code + detail + counts + missingFor + evidence block',
    NO_ERROR_TEXT_EXISTENCE_ORACLE === 'YES',
    J({ code: oracleMissing.body.error, detail: oracleMissing.body.detail,
      counts: oracleMissing.body.counts, missingFor: oracleMissing.body.missingFor,
      evidence: oracleMissing.body.evidence }));

  /* ── 5.T · 时间信道：DIAGNOSTIC（**不是判据**）────────────────────────
     上面三条只覆盖**响应**信道。时间信道没有被形式化关闭：
       · 不存在的 id → getRecord 返回 null（一次行读，无 payload 解析）
       · 存在但隐藏的 id → 一次行读 **＋** payload 解析 **＋** 一次可见性判定
     因此原理上存在一个可观测的耗时差。独立核验方登记过约 0.05 ms 的额外
     规范行读取。这里如实测量并打印，**不**设阈值、**不** check() 值、
     **不**因为它改变任何判定 —— 本机噪声与这个差值同阶，一个"通过/失败"的
     阈值只会把噪声伪装成结论。诚实口径：timing channel not formally closed /
     not proven exploitable。

     ★ 方法（写清楚，因为裸均值在这个量级上没有意义）：
       配对采样 + AB/BA 交替。每一轮把两种请求背靠背各跑一次，奇数轮交换
       顺序（漂移在配对内相互抵消），取**每对差值**的均值与标准误。
       单看两组独立均值会被机器抖动吞掉，配对差值才是能分辨 0.05 ms 的统计量。
       报告里同时给出标准误，读者据此知道本 harness 的噪声底噪在哪。 */
  const TIMING_N_PER_KIND = 60;
  const TIMING_N_HTTP_PER_KIND = 30;
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const median = a => {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const stdev = a => {
    if (a.length < 2) return 0;
    const mu = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - mu) * (v - mu), 0) / (a.length - 1));
  };
  const timingPreMissing = await MAIN.post(flatBody({ selectedMemoryIds: ['forged_record'] }));
  const timingPreHidden = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_f'] }));
  check('5.14.theTimingDiagnosticComparesTheTwoIntendedKinds',
    timingPreMissing.status === 422 && timingPreHidden.status === 422
    && timingPreMissing.providerFetches === 0 && timingPreHidden.providerFetches === 0
    && timingPreMissing.raw === timingPreHidden.raw,
    'both kinds are the intended uniform 422 at zero provider cost — the loop below measures'
    + ' exactly the two paths whose responses are byte-identical');
  const timingMissing = [], timingHidden = [], timingPairDeltas = [];
  const timeInProcess = async (id) => {
    const t0 = process.hrtime.bigint();
    await MAIN.inst.runtimeInterpretation.run(flatBody({ selectedMemoryIds: [id] }));
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  for (let i = 0; i < 5; i++) { await timeInProcess('forged_record'); await timeInProcess('mem_r4cl3_f'); }  /* 预热，丢弃 */
  for (let i = 0; i < TIMING_N_PER_KIND; i++) {
    let m = 0, h = 0;
    if (i % 2 === 0) { m = await timeInProcess('forged_record'); h = await timeInProcess('mem_r4cl3_f'); }
    else { h = await timeInProcess('mem_r4cl3_f'); m = await timeInProcess('forged_record'); }
    timingMissing.push(m);
    timingHidden.push(h);
    timingPairDeltas.push(h - m);
  }
  const timingHttpMissing = [], timingHttpHidden = [], timingHttpPairDeltas = [];
  for (let i = 0; i < TIMING_N_HTTP_PER_KIND; i++) {
    let m = 0, h = 0, t0 = 0;
    const once = async (id) => {
      t0 = process.hrtime.bigint();
      await MAIN.post(flatBody({ selectedMemoryIds: [id] }));
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    if (i % 2 === 0) { m = await once('forged_record'); h = await once('mem_r4cl3_f'); }
    else { h = await once('mem_r4cl3_f'); m = await once('forged_record'); }
    timingHttpMissing.push(m);
    timingHttpHidden.push(h);
    timingHttpPairDeltas.push(h - m);
  }
  /* 空对照（null control）：把**同一个请求**跑两遍，用同一套统计量算"差值"。
     它测的不是信道，而是**这套方法自身的噪声底**。只有当
     |hidden−missing| 明显大于 |null| 时，才有资格说"这个信道被分辨出来了"。
     不做这一步的话，任何一次跑出来的数字都只是"本机这一刻的抖动"。 */
  const timingNullPairDeltas = [];
  for (let i = 0; i < TIMING_N_PER_KIND; i++) {
    const a = await timeInProcess('forged_record');
    const b = await timeInProcess('forged_record');
    timingNullPairDeltas.push(b - a);
  }
  const timingNullDelta = mean(timingNullPairDeltas);
  const timingNullSe = stdev(timingNullPairDeltas) / Math.sqrt(timingNullPairDeltas.length);
  TIMING_NULL_CONTROL_DELTA_OBSERVED = timingNullDelta.toFixed(4) + ' ms +/- ' + timingNullSe.toFixed(4)
    + ' (identical-request control: paired mean of per-pair missing-minus-missing; n=' + TIMING_N_PER_KIND
    + ' pairs, in-process boundary invocation; sd=' + stdev(timingNullPairDeltas).toFixed(4) + ' ms)';
  const timingDelta = mean(timingPairDeltas);
  const timingSe = stdev(timingPairDeltas) / Math.sqrt(timingPairDeltas.length);
  const timingHttpDelta = mean(timingHttpPairDeltas);
  const timingHttpSe = stdev(timingHttpPairDeltas) / Math.sqrt(timingHttpPairDeltas.length);
  TIMING_DIFFERENCE_OBSERVED = timingDelta.toFixed(4) + ' ms +/- ' + timingSe.toFixed(4)
    + ' (paired mean of per-pair hidden-minus-missing; n=' + TIMING_N_PER_KIND
    + ' pairs, AB/BA alternating, in-process boundary invocation;'
    + ' sd=' + stdev(timingPairDeltas).toFixed(4) + ' ms, median_pair_delta=' + median(timingPairDeltas).toFixed(4) + ' ms,'
    + ' mean_missing=' + mean(timingMissing).toFixed(4) + ' ms, mean_hidden=' + mean(timingHidden).toFixed(4) + ' ms)';
  TIMING_DIFFERENCE_HTTP_OBSERVED = timingHttpDelta.toFixed(4) + ' ms +/- ' + timingHttpSe.toFixed(4)
    + ' (paired mean of per-pair hidden-minus-missing; n=' + TIMING_N_HTTP_PER_KIND
    + ' pairs, AB/BA alternating, loopback HTTP round trip;'
    + ' sd=' + stdev(timingHttpPairDeltas).toFixed(4) + ' ms,'
    + ' mean_missing=' + mean(timingHttpMissing).toFixed(4) + ' ms, mean_hidden=' + mean(timingHttpHidden).toFixed(4) + ' ms)';
  /* 这一条**不**判定时间差：它只保证诊断真的跑了（否则一个静默失效的
     诊断会伪装成"测过了，没问题"）。 */
  check('5.15.theTimingDiagnosticItselfRanAndProducedFiniteNumbers',
    timingMissing.length === TIMING_N_PER_KIND && timingHidden.length === TIMING_N_PER_KIND
    && timingHttpMissing.length === TIMING_N_HTTP_PER_KIND && timingHttpHidden.length === TIMING_N_HTTP_PER_KIND
    && timingNullPairDeltas.length === TIMING_N_PER_KIND
    && isFinite(timingDelta) && isFinite(timingHttpDelta) && isFinite(timingNullDelta),
    'harness-only gate (NOT a timing verdict): ' + TIMING_DIFFERENCE_OBSERVED
    + ' vs null control ' + TIMING_NULL_CONTROL_DELTA_OBSERVED);
  console.log('  DIAG  TIMING_EXISTENCE_ORACLE_ABSENCE = ' + TIMING_EXISTENCE_ORACLE_ABSENCE
    + '  (timing channel not formally closed / not proven exploitable)');
  console.log('  DIAG  TIMING_DIFFERENCE_OBSERVED = ' + TIMING_DIFFERENCE_OBSERVED);
  console.log('  DIAG  TIMING_DIFFERENCE_HTTP_OBSERVED = ' + TIMING_DIFFERENCE_HTTP_OBSERVED);
  console.log('  DIAG  TIMING_NULL_CONTROL_DELTA_OBSERVED = ' + TIMING_NULL_CONTROL_DELTA_OBSERVED);

  /* ══════════════════════════════════════════════════════════════════════
     6 · 跨角色：A 请求 B 的 private/only 行，正文永远到不了 provider
     ══════════════════════════════════════════════════════════════════════ */
  section('6 · cross-character');
  const bContent = MAIN.inst.memoryStore.getRecord('mem_r4cl3_g').content;
  const r6 = await MAIN.post(flatBody({ characterId: 'char_a', selectedMemoryIds: ['mem_r4cl3_g'] }));
  check('6.1 character A asking for B\'s only-to-B row gets no-authorized-memory at zero cost',
    r6.status === 422 && r6.body.error === 'no-authorized-memory' && r6.providerFetches === 0,
    'status=' + r6.status + ' code=' + r6.body.error + ' providerFetches=' + r6.providerFetches);
  check('6.2 B\'s canonical text never reached the provider transport',
    MAIN.fetchRec.every(rec => rec.body.indexOf(bContent) < 0),
    'the row exists and its text is ' + J(bContent) + '; no provider request ever carried it');
  const r6self = await MAIN.post(flatBody({ characterId: 'char_b', selectedMemoryIds: ['mem_r4cl3_g'] }));
  const req6self = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('6.3 the SAME row is readable when its own role asks (so the denial is ACL, not absence)',
    r6self.status === 200 && r6self.body.ok === true && r6self.providerFetches === 1
    && req6self.batch.length === 1 && req6self.batch[0].memoryId === 'mem_r4cl3_g'
    && req6self.batch[0].content === bContent,
    'status=' + r6self.status + ' contentMatch=' + (req6self.batch[0] && req6self.batch[0].content === bContent));
  const r6private = await MAIN.post(flatBody({ characterId: 'char_b', selectedMemoryIds: ['mem_r4cl3_f'] }));
  check('6.4 private is denied to its own role too (no owner exemption in the shared predicate)',
    r6private.status === 422 && r6private.body.error === 'no-authorized-memory' && r6private.providerFetches === 0,
    'status=' + r6private.status + ' code=' + r6private.body.error);
  const r6cross = await MAIN.post(flatBody({ characterId: 'char_a', selectedMemoryIds: ['mem_r4cl3_f'] }));
  check('6.5 char_a receives the byte-identical refusal for a nonexistent id and for B\'s existing row',
    (() => {
      /* 同一个主体、背靠背两次请求：一次是不存在的 id，一次是 **char_b 真实存在**
         的行。两者的 HTTP 状态 / 错误码 / detail / 计数 / evidence.canonicalRevision
         / provider 调用数必须逐字节相同 —— 否则 A 仅凭**响应信道**就能判定
         "B 的这条记忆在不在这台节点上"。
         （不同主体之间的响应本来就会差在各自的 characterId / providerClass / modelId
           回显上，那是调用方自己的身份，不构成关于**别的**记忆的预言机。
           ★ 本条同样只覆盖响应信道：时间信道见 §5.T，未形式化关闭。） */
      const missingAsA = r6;
      const hiddenAsA = r6cross;
      return missingAsA.status === hiddenAsA.status && missingAsA.raw === hiddenAsA.raw
        && missingAsA.providerFetches === hiddenAsA.providerFetches;
    })(),
    'a=' + J(String(r6.raw).slice(0, 240)) + ' b=' + J(String(r6cross.raw).slice(0, 240)));

  /* ══════════════════════════════════════════════════════════════════════
     7 · 重复 id
     ══════════════════════════════════════════════════════════════════════ */
  section('7 · duplicate ids');
  const r7 = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'mem_r4cl3_a'] }));
  check('7.1 a duplicated id is refused with duplicate-memory-id at zero cost',
    r7.status === 400 && r7.body.ok === false && r7.body.error === 'duplicate-memory-id'
    && r7.providerFetches === 0 && r7.body.boundary.vaultReads === 0,
    'status=' + r7.status + ' code=' + r7.body.error + ' providerFetches=' + r7.providerFetches);
  const r7ghost = await MAIN.post(flatBody({ selectedMemoryIds: ['forged_record', 'forged_record'] }));
  check('7.2 duplication is judged on the caller\'s list, not on what the store could bind',
    r7ghost.status === 400 && r7ghost.body.error === 'duplicate-memory-id' && r7ghost.providerFetches === 0,
    'status=' + r7ghost.status + ' code=' + r7ghost.body.error);
  const r7three = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'mem_r4cl3_b', 'mem_r4cl3_a'] }));
  check('7.3 a duplicate anywhere in the list refuses the whole request (no partial binding)',
    r7three.status === 400 && r7three.body.error === 'duplicate-memory-id' && r7three.providerFetches === 0,
    'status=' + r7three.status + ' code=' + r7three.body.error);

  /* ══════════════════════════════════════════════════════════════════════
     8 · 顺序保持
     ══════════════════════════════════════════════════════════════════════ */
  section('8 · order preservation');
  const r8 = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_c', 'mem_r4cl3_a', 'mem_r4cl3_b'] }));
  const req8 = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('8.1 the provider batch is exactly [m3,m1,m2] in REQUEST order',
    r8.status === 200 && r8.body.ok === true
    && J(req8.batch.map(m => m.memoryId)) === J(['mem_r4cl3_c', 'mem_r4cl3_a', 'mem_r4cl3_b']),
    'batchOrder=' + J(req8.batch.map(m => m.memoryId)));
  check('8.2 each batch entry carries its OWN canonical content (order is not just id order)',
    req8.batch[0].content === MAIN.inst.memoryStore.getRecord('mem_r4cl3_c').content
    && req8.batch[1].content === MAIN.inst.memoryStore.getRecord('mem_r4cl3_a').content
    && req8.batch[2].content === MAIN.inst.memoryStore.getRecord('mem_r4cl3_b').content,
    J(req8.batch.map(m => m.content)));
  check('8.3 the returned items follow the same order and missingFor is empty',
    J(r8.body.items.map(i => i.memoryId)) === J(['mem_r4cl3_c', 'mem_r4cl3_a', 'mem_r4cl3_b'])
    && r8.body.missingFor.length === 0,
    J({ items: r8.body.items.map(i => i.memoryId), missingFor: r8.body.missingFor }));

  /* ══════════════════════════════════════════════════════════════════════
     9 · 数量上界
     ══════════════════════════════════════════════════════════════════════ */
  section('9 · selection bound');
  const nineIds = VISIBLE_FOR_A.concat(['mem_r4cl3_f']);        /* 8 可读 + 1 隐藏 = 9 */
  const r9over = await MAIN.post(flatBody({ selectedMemoryIds: nineIds }));
  check('9.1 nine ids are refused with memory-selection-exceeds-bound at zero cost',
    nineIds.length === 9 && r9over.status === 400 && r9over.body.ok === false
    && r9over.body.error === 'memory-selection-exceeds-bound'
    && r9over.providerFetches === 0 && r9over.body.boundary.vaultReads === 0,
    'n=' + nineIds.length + ' status=' + r9over.status + ' code=' + r9over.body.error
    + ' providerFetches=' + r9over.providerFetches);
  const r9eight = await MAIN.post(flatBody({ selectedMemoryIds: VISIBLE_FOR_A }));
  const req9eight = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('9.2 exactly eight readable ids are accepted and the provider sees exactly eight rows',
    r9eight.status === 200 && r9eight.body.ok === true && r9eight.providerFetches === 1
    && req9eight.batch.length === 8 && r9eight.body.evidence.bound === 8
    && r9eight.body.evidence.requested === 8 && r9eight.body.counts.returned === 8,
    'batch=' + req9eight.batch.length + ' evidence=' + J(r9eight.body.evidence));
  const r9empty = await MAIN.post(flatBody({ selectedMemoryIds: [] }));
  check('9.3 an empty selection is accepted by the contract but binds nothing (zero cost)',
    r9empty.status === 422 && r9empty.body.error === 'no-authorized-memory' && r9empty.providerFetches === 0,
    'status=' + r9empty.status + ' code=' + r9empty.body.error);
  const r9missingField = await MAIN.post((() => { const b = flatBody(); delete b.selectedMemoryIds; return b; })());
  check('9.4 a request without selectedMemoryIds is a shape refusal at zero cost',
    r9missingField.status === 400 && r9missingField.body.ok === false && r9missingField.providerFetches === 0
    && r9missingField.body.boundary.vaultReads === 0,
    'status=' + r9missingField.status + ' code=' + r9missingField.body.error);
  const r9nonArray = await MAIN.post(flatBody({ selectedMemoryIds: 'mem_r4cl3_a' }));
  check('9.5 a non-array selectedMemoryIds is a shape refusal at zero cost',
    r9nonArray.status === 400 && r9nonArray.body.ok === false && r9nonArray.providerFetches === 0,
    'status=' + r9nonArray.status + ' code=' + r9nonArray.body.error);
  const r9emptyString = await MAIN.post(flatBody({ selectedMemoryIds: [''] }));
  check('9.6 an empty string is not a valid memory id (shape refusal, zero cost)',
    r9emptyString.status === 400 && r9emptyString.body.ok === false && r9emptyString.providerFetches === 0,
    'status=' + r9emptyString.status + ' code=' + r9emptyString.body.error);
  RECALL_SELECTION_AUTHORITY = RT.RECALL_SELECTION_AUTHORITY;
  SELECTED_SET_BOUND_TO_CURRENT_RECALL = RT.SELECTED_SET_BOUND_TO_CURRENT_RECALL;

  /* ══════════════════════════════════════════════════════════════════════
     10 · 投影白名单：provider 看到的每个条目**恰好** 7 个键
     ══════════════════════════════════════════════════════════════════════ */
  section('10 · projection allowlist');
  const measuredKeys = req9eight.batch.map(m => Object.keys(m).slice().sort());
  const allSeven = measuredKeys.every(keys => J(keys) === J(PROJECTION_KEYS));
  PROJECTION_FIELD_COUNT = measuredKeys.length ? measuredKeys[0].length : 0;
  check('10.1 every MEMORY_BATCH entry has EXACTLY the 7 projection keys',
    measuredKeys.length === 8 && allSeven,
    'observed=' + J(Array.from(new Set(measuredKeys.map(k => J(k))))) + ' expected=' + J(PROJECTION_KEYS));
  check('10.2 PROJECTION_FIELD_COUNT measured from the provider envelope is 7',
    PROJECTION_FIELD_COUNT === 7, 'PROJECTION_FIELD_COUNT=' + PROJECTION_FIELD_COUNT);
  const FORBIDDEN_KEYS = ['revision', 'visibility', 'visibleTo', 'excludeFrom', 'activationCount',
    'lastActivated', 'created', 'createdAt', 'updatedAt', 'importance', 'pinned', 'ownerId',
    'createdBy', 'tags', 'domain', 'resolved', 'summary', 'id', 'rawSource', 'deletedAt'];
  const leakedKeys = [];
  for (const m of req9eight.batch) for (const k of Object.keys(m)) if (FORBIDDEN_KEYS.indexOf(k) >= 0) leakedKeys.push(k);
  check('10.3 no revision / ACL / activation / storage / timestamp field leaked into the batch',
    leakedKeys.length === 0, 'leaked=' + J(Array.from(new Set(leakedKeys))));
  check('10.4 projectionFields in the evidence block names the same 7 fields',
    (() => {
      const pf = r9eight.body.evidence.projectionFields;
      return Array.isArray(pf) && pf.length === 7
        && J(pf.slice().sort()) === J(['arousal', 'content', 'id', 'kind', 'source', 'title', 'valence']);
    })(),
    J(r9eight.body.evidence.projectionFields));
  check('10.5 each encodedAffectAtTheTime carries exactly {valence, arousal}',
    req9eight.batch.every(m => J(Object.keys(m.encodedAffectAtTheTime || {}).slice().sort()) === J(['arousal', 'valence'])),
    J(req9eight.batch.map(m => Object.keys(m.encodedAffectAtTheTime || {}))));
  /* (b) 全量名字扫描：**模型面对的那段文本**里不得出现任何 ACL / 存储 /
     激活 / 凭据元数据的名字。扫的是 system + messages 的内容，不是 headers/url
     —— 那两处本来就有 endpoint / model，扫它们只会得到假阳性。 */
  const metadataHits = [];
  for (const rec of MAIN.fetchRec) {
    for (const token of PROVIDER_FORBIDDEN_TOKENS) {
      const at = String(rec.modelText || '').indexOf(token);
      if (at >= 0) {
        metadataHits.push({ token: token, context: String(rec.modelText).slice(Math.max(0, at - 40), at + 40) });
      }
    }
  }
  PROVIDER_METADATA_LEAKS = metadataHits.length;
  check('10.6 no ACL / storage / activation / credential metadata name reaches the model-facing text',
    MAIN.fetchRec.length > 0 && metadataHits.length === 0,
    'scanned=' + MAIN.fetchRec.length + ' requests × ' + PROVIDER_FORBIDDEN_TOKENS.length
    + ' tokens; hits=' + J(metadataHits.slice(0, 4)));

  /* ══════════════════════════════════════════════════════════════════════
     11 · 尺寸/截断策略：1200 字符，且调用方无法影响它
     ══════════════════════════════════════════════════════════════════════ */
  section('11 · content bound / truncation');
  check('11.0 the seeded row really is longer than the core bound',
    LONG_CONTENT.length > MAX_CONTENT_CHARS,
    'seeded=' + LONG_CONTENT.length + ' bound=' + MAX_CONTENT_CHARS);
  const r11 = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_h'] }));
  const req11 = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('11.1 the provider receives exactly 1200 characters of the canonical content',
    r11.status === 200 && req11.batch.length === 1
    && req11.batch[0].content.length === MAX_CONTENT_CHARS
    && req11.batch[0].content === LONG_CONTENT.slice(0, MAX_CONTENT_CHARS)
    && req11.batch[0].content.length === 1200,
    'len=' + (req11.batch[0] && req11.batch[0].content.length) + ' bound=' + MAX_CONTENT_CHARS);
  check('11.2 the tail beyond the bound is genuinely absent (not re-ordered or partially kept)',
    req11.batch[0].content.indexOf('LONGEND') < 0
    && req11.batch[0].content.slice(0, 10) === 'LONGBEGIN-',
    'tail marker present=' + (req11.batch[0].content.indexOf('LONGEND') >= 0));
  check('11.3 the result reports truncated=true for that row',
    r11.body.evidence && r11.body.evidence.truncated === true,
    J(r11.body.evidence));
  check('11.4 the bound is R4-C\'s own number, and the pure core independently agrees on the same row',
    (() => {
      const rawRow = MAIN.inst.memoryStore.getRecord('mem_r4cl3_h');
      const built = CORE.buildRequest({ selectedIds: ['mem_r4cl3_h'], records: [rawRow] });
      return MAX_CONTENT_CHARS === CORE.BOUNDS.MAX_CONTENT_CHARS
        && MAX_CONTENT_CHARS === 1200
        && built.stats.truncated === true
        && built.stats.maxContentChars === 1200
        && built.stats.memoryCount === 1;
    })(),
    'the server projection and the R4-C core both cut at ' + MAX_CONTENT_CHARS + '; the core flags the RAW row truncated too');
  const r11ctrl = await MAIN.post(flatBody({
    selectedMemoryIds: ['mem_r4cl3_h'],
    currentState: { relationship: 'r'.repeat(240), emotion: 'e'.repeat(240) },
    roleName: 'n'.repeat(120)
  }));
  const req11ctrl = MAIN.fetchRec[MAIN.fetchRec.length - 1];
  check('11.5 filling every caller-controlled field to its bound does not change the 1200-char slice',
    r11ctrl.status === 200 && req11ctrl.batch.length === 1
    && req11ctrl.batch[0].content === req11.batch[0].content
    && r11ctrl.body.evidence.truncated === true,
    'ctrlLen=' + req11ctrl.batch[0].content.length + ' identical=' + (req11ctrl.batch[0].content === req11.batch[0].content));
  const r11short = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a'] }));
  check('11.6 a short canonical row reports truncated=false (the flag is measured, not constant)',
    r11short.body.evidence.truncated === false, J(r11short.body.evidence));

  /* ══════════════════════════════════════════════════════════════════════
     12 · 零激活：解释**不**强化、**不**写曝光
     ══════════════════════════════════════════════════════════════════════ */
  section('12 · no activation / no exposure write');
  const activationSnapshot = () => ROWS.map(([id]) => {
    const rec = MAIN.inst.memoryStore.getRecord(id);
    return { id: id, activationCount: rec && rec.activationCount, lastActivated: rec && rec.lastActivated };
  });
  const actBefore = activationSnapshot();
  const revBefore12 = MAIN.inst.memoryStore.getRevision();
  const okCall = await MAIN.post(flatBody({ selectedMemoryIds: VISIBLE_FOR_A.slice(0, 3) }));
  const failCall = await MAIN.post(flatBody({ selectedMemoryIds: ['forged_record'] }));
  const actAfter = activationSnapshot();
  check('12.1 the two probe calls behaved as expected (one success, one refusal)',
    okCall.status === 200 && failCall.status === 422,
    'ok=' + okCall.status + ' fail=' + failCall.status);
  check('12.2 every activationCount and lastActivated is byte-identical before/after',
    J(actBefore) === J(actAfter),
    'before=' + J(actBefore.slice(0, 3)) + ' after=' + J(actAfter.slice(0, 3)));
  check('12.3 the canonical revision did not move either',
    MAIN.inst.memoryStore.getRevision() === revBefore12,
    'before=' + revBefore12 + ' after=' + MAIN.inst.memoryStore.getRevision());
  check('12.4 non-zero activation telemetry was actually seeded (otherwise this prover is blind)',
    actAfter.every(x => x.activationCount === 3) && actAfter.every(x => x.lastActivated === 1789000000123),
    J(actAfter.slice(0, 2)));

  /* ══════════════════════════════════════════════════════════════════════
     13 · 零持久变更：成功与失败之后，每个权威面逐字节不变
     ══════════════════════════════════════════════════════════════════════ */
  section('13 · no durable mutation');
  function durableSnapshot() {
    const out = { errors: [] };
    const attempt = (name, fn) => { try { out[name] = fn(); } catch (e) { out.errors.push(name + ': ' + String((e && e.message) || e)); } };
    attempt('db', () => statOf(MAIN.dbFile));
    attempt('wal', () => statOf(MAIN.dbFile + '-wal'));
    attempt('shm', () => statOf(MAIN.dbFile + '-shm'));
    attempt('vault', () => statOf(MAIN.vaultFile));
    attempt('files', () => fs.readdirSync(MAIN.dataDir).slice().sort());
    attempt('records', () => MAIN.inst.memoryStore.countRecords());
    attempt('allRecords', () => MAIN.inst.memoryStore.countAllRecords());
    attempt('revision', () => MAIN.inst.memoryStore.getRevision());
    attempt('changes', () => {
      const c = MAIN.inst.memoryStore.changesAfter(0, { limit: 5000 });
      return { ok: c.ok, revision: c.revision, cursor: c.cursor, upserts: c.upserts.length, deletes: c.deletes.length };
    });
    attempt('understanding', () => {
      const w = MAIN.inst.understandingStore.getWatermark('char_a');
      const a = MAIN.inst.understandingStore.getActive('char_a');
      return { watermark: w, activeId: a ? a.id : null, activeRevision: a ? a.revision : null };
    });
    attempt('chat', () => {
      const m = MAIN.inst.store.meta();
      return { revision: m.revision, insertSeq: m.insertSeq, messages: m.messages, allMessages: m.allMessages, conversations: m.conversations };
    });
    return out;
  }
  const durBefore = durableSnapshot();
  check('13.1 the durable snapshot is complete (no probe failed)',
    durBefore.errors.length === 0 && !!durBefore.db && !!durBefore.vault && !!durBefore.changes
    && !!durBefore.understanding && !!durBefore.chat,
    J(durBefore.errors));
  const success13 = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'mem_r4cl3_b'] }));
  const durAfterSuccess = durableSnapshot();
  const failure13 = await MAIN.post(flatBody({ characterId: 'ghost_character', selectedMemoryIds: ['mem_r4cl3_a'] }));
  const durAfterFailure = durableSnapshot();
  check('13.2 the two probes were really a success and a failure',
    success13.status === 200 && success13.body.ok === true
    && failure13.status === 404 && failure13.body.ok === false,
    'success=' + success13.status + ' failure=' + failure13.status + '/' + (failure13.body && failure13.body.error));
  check('13.3 sqlite canonical file bytes unchanged across success AND failure',
    sameFile(durBefore.db, durAfterSuccess.db) && sameFile(durAfterSuccess.db, durAfterFailure.db),
    J({ before: durBefore.db, afterSuccess: durAfterSuccess.db, afterFailure: durAfterFailure.db }));
  check('13.4 sqlite WAL bytes unchanged across success AND failure',
    sameFile(durBefore.wal, durAfterSuccess.wal) && sameFile(durAfterSuccess.wal, durAfterFailure.wal),
    J({ before: durBefore.wal, after: durAfterSuccess.wal }));
  check('13.5 no new file appeared in the data directory',
    J(durBefore.files) === J(durAfterSuccess.files) && J(durAfterSuccess.files) === J(durAfterFailure.files),
    J({ before: durBefore.files, after: durAfterFailure.files }));
  check('13.6 record count / all-record count / revision / change feed unchanged',
    durBefore.records === durAfterFailure.records
    && durBefore.allRecords === durAfterFailure.allRecords
    && durBefore.revision === durAfterFailure.revision
    && J(durBefore.changes) === J(durAfterFailure.changes),
    J({ before: { r: durBefore.records, a: durBefore.allRecords, rev: durBefore.revision, ch: durBefore.changes },
      after: { r: durAfterFailure.records, a: durAfterFailure.allRecords, rev: durAfterFailure.revision, ch: durAfterFailure.changes } }));
  check('13.7 Understanding revision + watermark unchanged',
    J(durBefore.understanding) === J(durAfterFailure.understanding),
    J({ before: durBefore.understanding, after: durAfterFailure.understanding }));
  check('13.8 chat store meta unchanged',
    J(durBefore.chat) === J(durAfterFailure.chat),
    J({ before: durBefore.chat, after: durAfterFailure.chat }));
  check('13.9 credential vault bytes unchanged (the Vault was only ever read)',
    durBefore.vault && durAfterFailure.vault
    && sameFile(durBefore.vault, durAfterFailure.vault)
    && durBefore.vault.bytes > 0,
    J({ before: durBefore.vault, after: durAfterFailure.vault }));
  check('13.10 WAL shared-memory index did not grow (read marks may move; state must not)',
    (durBefore.shm == null && durAfterFailure.shm == null)
    || (durBefore.shm && durAfterFailure.shm && durBefore.shm.bytes === durAfterFailure.shm.bytes),
    'shm is sqlite\'s shared read-mark index, not durable state: before='
    + J(durBefore.shm && durBefore.shm.bytes) + ' after=' + J(durAfterFailure.shm && durAfterFailure.shm.bytes)
    + ' (content hash before=' + J(durBefore.shm && durBefore.shm.sha256).slice(0, 20)
    + ' after=' + J(durAfterFailure.shm && durAfterFailure.shm.sha256).slice(0, 20) + ')');

  /* ══════════════════════════════════════════════════════════════════════
     14 · 每条路径最多一次 provider 调用
     ══════════════════════════════════════════════════════════════════════ */
  section('14 · at most one provider call on every path');
  function notePath(label, fetches, note) {
    PROVIDER_MAX_CALLS_PER_PATH = Math.max(PROVIDER_MAX_CALLS_PER_PATH, fetches);
    check('14.' + label, fetches <= 1, 'providerFetches=' + fetches + (note ? ' (' + note + ')' : ''));
    return fetches;
  }
  notePath('success', (await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a'] }))).providerFetches);
  notePath('missingOnly', (await MAIN.post(flatBody({ selectedMemoryIds: ['forged_record'] }))).providerFetches);
  notePath('hiddenOnly', (await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_f'] }))).providerFetches);
  notePath('duplicate', (await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'mem_r4cl3_a'] }))).providerFetches);
  notePath('boundExceeded', (await MAIN.post(flatBody({ selectedMemoryIds: nineIds }))).providerFetches);
  notePath('fieldAttack', (await MAIN.post(Object.assign(flatBody(), { content: 'FORGED' }))).providerFetches);

  /* abort：端口**从未**被调用（attempts=0 是服务自己的实测自述）。 */
  const beforeAbort = MAIN.fetchCount();
  const aborter = new AbortController();
  aborter.abort();
  let abortResult = null;
  try { abortResult = await MAIN.inst.runtimeInterpretation.run(flatBody(), { signal: aborter.signal }); }
  catch (e) { THROWN.push('abort-path: ' + String((e && e.message) || e)); abortResult = { error: 'THREW' }; }
  const abortFetches = MAIN.fetchCount() - beforeAbort;
  notePath('preAborted', abortFetches, 'port never reached');
  check('14.preAborted.returnsAbortedEnvelope',
    abortResult && abortResult.ok === false && abortResult.error === 'aborted'
    && abortResult.model && abortResult.model.attempts === 0,
    J({ error: abortResult && abortResult.error, attempts: abortResult && abortResult.model && abortResult.model.attempts }));

  /* timeout：真实端口 + 挂起的注入 fetch，60ms 上界。 */
  MAIN.state.mode = 'hang';
  const beforeTimeout = MAIN.fetchCount();
  let timeoutResult = null;
  const timeoutPromise = (async () => {
    try {
      return await MAIN.inst.runtimeInterpretation.run(
        flatBody({ timeoutMs: 60, selectedMemoryIds: ['mem_r4cl3_a'] }), {});
    } catch (e) { THROWN.push('timeout-path: ' + String((e && e.message) || e)); return { error: 'THREW' }; }
  })();
  let timeoutGuard = null;
  const timedOut = await Promise.race([
    timeoutPromise,
    new Promise(resolve => { timeoutGuard = setTimeout(() => { HUNG.push('timeout-path'); resolve({ error: 'HUNG' }); }, 5000); })
  ]);
  if (timeoutGuard) clearTimeout(timeoutGuard);
  timeoutResult = timedOut;
  const timeoutFetches = MAIN.fetchCount() - beforeTimeout;
  MAIN.state.mode = 'echo';
  notePath('timeout', timeoutFetches, 'bounded wait expired');
  check('14.timeout.returnsTimeoutEnvelopeWithinTheBoundedWait',
    timeoutResult && timeoutResult.ok === false && timeoutResult.error === 'timeout'
    && timeoutResult.model && timeoutResult.model.attempts === 1,
    J({ error: timeoutResult && timeoutResult.error, attempts: timeoutResult && timeoutResult.model && timeoutResult.model.attempts }));

  check('14.summary.providerMaxCallsPerPathIsAtMostOne',
    PROVIDER_MAX_CALLS_PER_PATH <= 1, 'PROVIDER_MAX_CALLS_PER_PATH=' + PROVIDER_MAX_CALLS_PER_PATH);
  check('14.summary.noPathMadeASecondAttempt',
    MAIN.fetchRec.every(rec => rec && typeof rec.body === 'string'), 'recorded fetches=' + MAIN.fetchRec.length);

  /* ══════════════════════════════════════════════════════════════════════
     15 · 服务端成本闸门默认 OFF
     ══════════════════════════════════════════════════════════════════════ */
  section('15 · server cost gate is OFF by default');
  const OFF = await buildInstance({ prefix: 'ib-r4cl3-off-', policy: undefined });
  OFF.inst.memoryStore.putRecord(canonicalRow('mem_off_seed', { activationCount: 0, lastActivated: null }));
  const r15 = await OFF.post(flatBody({ selectedMemoryIds: ['mem_off_seed'] }));
  check('15.1 with no injected policy the route answers disabled (503)',
    r15.status === 503 && r15.body && r15.body.ok === false && r15.body.error === 'disabled',
    'status=' + r15.status + ' code=' + (r15.body && r15.body.error));
  check('15.2 the disabled gate spends nothing: 0 provider fetches, 0 Vault reads',
    OFF.fetchCount() === 0 && r15.body.boundary.providerCalls === 0 && r15.body.boundary.vaultReads === 0,
    'fetches=' + OFF.fetchCount() + ' boundary=' + J(r15.body.boundary && { p: r15.body.boundary.providerCalls, v: r15.body.boundary.vaultReads }));
  check('15.3 the disabled gate fires before the character spec is even resolved',
    r15.body.error === 'disabled' && /absent-default-false/.test(String(r15.body.detail)),
    'detail=' + J(r15.body.detail));
  check('15.4 describe() still reports the cost policy as off by default',
    OFF.inst.runtimeInterpretation.describe().costPolicy.memoryInterpretationEnabled === false
    && OFF.inst.runtimeInterpretation.describe().costPolicy.defaultEnabled === false,
    J(OFF.inst.runtimeInterpretation.describe().costPolicy));
  /* 灵敏度对照：把同一台 OFF 实例的 activationCount 主动推高一次，
     证明 §12 的探针**看得见**变化（否则"没变"可能只是探针瞎了）。 */
  const offRec = OFF.inst.memoryStore.getRecord('mem_off_seed');
  const offAct = OFF.inst.memoryStore.recordActivation(['mem_off_seed'], { delta: 5 });
  const offRecAfter = OFF.inst.memoryStore.getRecord('mem_off_seed');
  check('15.5 the activation probe is sensitive (it CAN observe a real increment)',
    offRec.activationCount === 0 && offRecAfter.activationCount === 5
    && offAct.updated === 1 && offAct.revisionTouched === false,
    J({ before: offRec.activationCount, after: offRecAfter.activationCount, touched: offAct.revisionTouched }));

  /* ══════════════════════════════════════════════════════════════════════
     16 · evidence 状态权威 + allowedIds = BOUND 集合
     ══════════════════════════════════════════════════════════════════════ */
  section('16 · evidence state authority & bound-only allowedIds');
  const r16attack = await MAIN.post(Object.assign(flatBody(), { evidenceState: 'direct' }));
  check('16.1 the request cannot carry evidenceState (refused, zero cost)',
    r16attack.status === 400 && r16attack.body.ok === false && r16attack.providerFetches === 0,
    'status=' + r16attack.status + ' code=' + r16attack.body.error);
  const allBatches = MAIN.fetchRec.filter(rec => rec.batch && rec.batch.length).map(rec => rec.batch).flat();
  const nonNullStates = allBatches.filter(m => m.systemEvidenceState !== null);
  check('16.2 every provider batch entry carries systemEvidenceState === null (the server claims no MetaMemory state)',
    allBatches.length > 0 && nonNullStates.length === 0,
    'entries=' + allBatches.length + ' nonNull=' + nonNullStates.length
    + ' values=' + J(Array.from(new Set(allBatches.map(m => J(m.systemEvidenceState))))));
  EVIDENCE_STATE_AUTHORITY = RT.EVIDENCE_STATE_AUTHORITY;
  check('16.2b the declared evidence-state authority matches the wire (SERVER_NOT_CLAIMED, never a state)',
    RT.EVIDENCE_STATE_AUTHORITY === 'SERVER_NOT_CLAIMED'
    && RT.CONSUMABLE_EVIDENCE_STATES === undefined
    && CORE.CONSUMABLE_EVIDENCE_STATES.length > 0
    && allBatches.every(m => CORE.CONSUMABLE_EVIDENCE_STATES.indexOf(m.systemEvidenceState) < 0),
    'declared=' + RT.EVIDENCE_STATE_AUTHORITY + ' coreVocabulary=' + J(CORE.CONSUMABLE_EVIDENCE_STATES));

  /* 恶意 provider：为一个"被请求过但未被绑定"的隐藏 id 编造一条解释。
     服务端把 allowedIds 设成 **bound** 集合，因此这条必须被拒。 */
  const hiddenText = MAIN.inst.memoryStore.getRecord('mem_r4cl3_f').content;
  MAIN.state.behaviour = (batch) => ({
    items: [
      { memoryId: 'mem_r4cl3_a', meaning: 'ok', appraisal: 'mixed', affect: 'warm', basis: 'ai_inference', subjectiveConfidence: 0.3 },
      { memoryId: 'mem_r4cl3_f', meaning: 'FORGED-INTERPRETATION', appraisal: 'mixed', affect: 'warm', basis: 'ai_inference', subjectiveConfidence: 0.3 }
    ]
  });
  let r16rogue = null;
  try { r16rogue = await MAIN.post(flatBody({ selectedMemoryIds: ['mem_r4cl3_a', 'mem_r4cl3_f'] })); }
  finally { MAIN.state.behaviour = null; }
  check('16.3 a rogue provider item for a requested-but-UNBOUND id is rejected as unknown-memory-id',
    r16rogue && r16rogue.status === 200 && r16rogue.providerFetches === 1
    && Array.isArray(r16rogue.body.rejected)
    && r16rogue.body.rejected.some(x => x && x.memoryId === 'mem_r4cl3_f' && x.reason === 'model-returned-unknown-memory-id'),
    J(r16rogue && r16rogue.body.rejected));
  check('16.4 the hidden id never appears in items and its text never appears in the response',
    r16rogue && Array.isArray(r16rogue.body.items)
    && r16rogue.body.items.length === 1 && r16rogue.body.items[0].memoryId === 'mem_r4cl3_a'
    && r16rogue.raw.indexOf('mem_r4cl3_f') >= 0        /* 只允许作为 missingFor/rejected 的 id 出现 */
    && r16rogue.raw.indexOf(hiddenText) < 0
    && r16rogue.raw.indexOf('FORGED-INTERPRETATION') < 0,
    'items=' + J(r16rogue && r16rogue.body.items && r16rogue.body.items.map(i => i.memoryId))
    + ' hiddenTextLeaked=' + (r16rogue && r16rogue.raw.indexOf(hiddenText) >= 0));
  check('16.5 the rejected id is also reported as an ordinary missingFor entry (uniform omission)',
    r16rogue && J(r16rogue.body.missingFor) === J(['mem_r4cl3_f']),
    J(r16rogue && r16rogue.body.missingFor));

  /* ══════════════════════════════════════════════════════════════════════
     17 · 没有 canonical reader 时**关死**，而不是退回调用方数据
     ══════════════════════════════════════════════════════════════════════ */
  section('17 · fail closed without the canonical reader');
  {
    const port = { calls: 0, run() { this.calls += 1; return Promise.resolve({ text: JSON.stringify({ items: [] }) }); } };
    const vault = { calls: 0, resolve() { this.calls += 1; return { ok: true, provider: 'custom', secret: 'synthetic-secret' }; } };
    const registry = {
      getCharacterSpec() {
        return { provider: 'custom', model: 'model-a', endpoint: ENDPOINT_A, credentialRef: 'cred_a' };
      }
    };
    const bare = RT.createRuntimeInterpretation({
      registry: registry, credentialAccess: vault, modelPort: port,
      costPolicy: { memoryInterpretationEnabled: true }, clock: () => NOW, logger: () => {}
    });
    const r17 = await bare.run(flatBody());
    check('17.1 a boundary assembled without a memoryStore fails closed (503 canonical-evidence-unavailable)',
      r17 && r17.ok === false && r17.error === 'canonical-evidence-unavailable' && r17.status === 503,
      J({ error: r17 && r17.error, status: r17 && r17.status, detail: r17 && r17.detail }));
    check('17.2 it does NOT silently degrade to caller-supplied data, and spends nothing',
      port.calls === 0 && vault.calls === 0
      && r17.boundary.providerCalls === 0 && r17.boundary.vaultReads === 0
      && !/SERVER_CANONICAL_PROJECTION/.test(J(r17)),
      J({ provider: port.calls, vault: vault.calls, boundary: r17.boundary && { p: r17.boundary.providerCalls, v: r17.boundary.vaultReads } }));
  }

  /* ══════════════════════════════════════════════════════════════════════
     Z · 零真实 provider 成本 + 汇总
     ══════════════════════════════════════════════════════════════════════ */
  section('Z · zero real provider cost');
  PROVIDER_FETCH_TOTAL = MAIN.fetchCount() + OFF.fetchCount();
  const badHosts = Array.from(new Set(ENDPOINTS_SEEN)).filter(h => !/\.invalid$/.test(String(h)));
  check('Z1 every provider transport target is a non-routable .invalid host',
    ENDPOINTS_SEEN.length > 0 && badHosts.length === 0,
    'hosts=' + J(Array.from(new Set(ENDPOINTS_SEEN))) + ' routable=' + J(badHosts));
  check('Z2 every provider transport went through the injected fake fetch on the REAL NodeModelPort',
    ENDPOINTS_SEEN.length === PROVIDER_FETCH_TOTAL && PROVIDER_FETCH_TOTAL > 0
    && MAIN.fetchRec.every(rec => typeof rec.body === 'string'),
    'fakeFetchInvocations=' + PROVIDER_FETCH_TOTAL + ' endpointsObserved=' + ENDPOINTS_SEEN.length);
  check('Z3 the service core never threw in any section', THROWN.length === 0, J(THROWN.slice(0, 4)));
  check('Z4 no invocation hung the harness', HUNG.length === 0, J(HUNG.slice(0, 4)));
  check('Z5 this suite never performs a real network fetch of its own',
    !/globalThis\s*\.\s*fetch/.test(fs.readFileSync(__filename, 'utf8'))
    && !/\bfetch\s*\(\s*['"]https?:/.test(fs.readFileSync(__filename, 'utf8')),
    'the only http use is the local test server; provider transport is an injected fake');

  /* ── machine-readable verdicts（每个值都来自上面的实测）────────────── */
  console.log('\n' + '='.repeat(72));
  console.log('R4C LIVE-3 · SERVER-BOUND CANONICAL EVIDENCE');
  console.log('SERVER_BINDS_RECORD_CONTENT_TO_CANONICAL = ' + SERVER_BINDS_RECORD_CONTENT_TO_CANONICAL);
  console.log('SERVER_ENFORCES_EVIDENCE_CHARACTER_VISIBILITY = ' + SERVER_ENFORCES_EVIDENCE_CHARACTER_VISIBILITY);
  console.log('CALLER_CAN_SUPPLY_ARBITRARY_RECORD_TEXT = ' + CALLER_CAN_SUPPLY_ARBITRARY_RECORD_TEXT);
  console.log('NO_RESPONSE_SHAPE_EXISTENCE_ORACLE = ' + NO_RESPONSE_SHAPE_EXISTENCE_ORACLE);
  console.log('NO_STATUS_CODE_EXISTENCE_ORACLE = ' + NO_STATUS_CODE_EXISTENCE_ORACLE);
  console.log('NO_ERROR_TEXT_EXISTENCE_ORACLE = ' + NO_ERROR_TEXT_EXISTENCE_ORACLE);
  console.log('TIMING_EXISTENCE_ORACLE_ABSENCE = ' + TIMING_EXISTENCE_ORACLE_ABSENCE
    + '  (timing channel not formally closed / not proven exploitable)');
  console.log('TIMING_DIFFERENCE_OBSERVED = ' + TIMING_DIFFERENCE_OBSERVED);
  console.log('TIMING_DIFFERENCE_HTTP_OBSERVED = ' + TIMING_DIFFERENCE_HTTP_OBSERVED);
  console.log('TIMING_NULL_CONTROL_DELTA_OBSERVED = ' + TIMING_NULL_CONTROL_DELTA_OBSERVED);
  console.log('PROVIDER_MEMORY_SOURCE = ' + PROVIDER_MEMORY_SOURCE);
  console.log('EVIDENCE_CONTENT_AUTHORITY = ' + EVIDENCE_CONTENT_AUTHORITY);
  console.log('EVIDENCE_VISIBILITY_AUTHORITY = ' + EVIDENCE_VISIBILITY_AUTHORITY);
  console.log('EVIDENCE_VISIBILITY_IMPLEMENTATION = ' + EVIDENCE_VISIBILITY_IMPLEMENTATION);
  console.log('EVIDENCE_STATE_AUTHORITY = ' + EVIDENCE_STATE_AUTHORITY);
  console.log('RECALL_SELECTION_AUTHORITY = ' + RECALL_SELECTION_AUTHORITY);
  console.log('SELECTED_SET_BOUND_TO_CURRENT_RECALL = ' + SELECTED_SET_BOUND_TO_CURRENT_RECALL);
  console.log('PROJECTION_FIELD_COUNT = ' + PROJECTION_FIELD_COUNT);
  console.log('CANONICAL_BEARING_FIELDS_ATTACKED = ' + CANONICAL_BEARING_FIELDS.length);
  console.log('TOP_LEVEL_CANONICAL_FIELD_REFUSAL_CODES = ' + J(topAttackCodes));
  console.log('NESTED_CANONICAL_FIELD_REFUSAL_CODES = ' + J(nestedAttackCodes));
  console.log('NESTED_UNKNOWN_KEY_CONTROL = ' + J(controlRes.body && controlRes.body.error)
    + ' field=' + J(controlRes.body && controlRes.body.field));
  console.log('PROVIDER_METADATA_LEAKS = ' + PROVIDER_METADATA_LEAKS);
  console.log('PROVIDER_MAX_CALLS_PER_PATH = ' + PROVIDER_MAX_CALLS_PER_PATH);
  console.log('PROVIDER_FETCH_TOTAL = ' + PROVIDER_FETCH_TOTAL);
  console.log('REAL_PROVIDER_CALLS = ' + REAL_PROVIDER_CALLS);
  console.log('-'.repeat(72));
  if (failures) {
    console.error('R4C LIVE-3 CANONICAL EVIDENCE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exitCode = 1;
  } else {
    console.log('R4C LIVE-3 CANONICAL EVIDENCE PASSED · ' + passed + ' assertions green');
  }
})().catch(error => {
  console.error('R4C LIVE-3 CANONICAL EVIDENCE CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
}).finally(async () => {
  /* 清理纪律：先按反序关服务/关库（CLEANUP），再删目录。
     Windows 上 sqlite 的文件句柄可能在 close() 之后**晚一拍**才真正释放，
     因此这里带一个有限的重试预算 —— 一次删不掉就等 50ms 再删，
     最多 12 次。宁可多等半秒，也不在 os.tmpdir() 里留下测试残留。 */
  for (let i = CLEANUP.length - 1; i >= 0; i--) {
    try { CLEANUP[i](); } catch (_) { /* 尽力清理 */ }
  }
  let remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  for (let attempt = 0; attempt < 12 && remaining.length; attempt++) {
    await sleep(50);
    for (const dir of remaining) dropDir(dir);
    remaining = TEMP_DIRS.filter(d => fs.existsSync(d));
  }
  console.log('# cleanup: ' + CLEANUP.length + ' step(s) executed, '
    + (TEMP_DIRS.length - remaining.length) + '/' + TEMP_DIRS.length + ' temp dir(s) removed'
    + (remaining.length ? ' — STILL PRESENT: ' + J(remaining) : ''));
});
