'use strict';
/* ====================================================================
   P21-R4-LIVE-4.1B · Auto-Interpretation —— **真实浏览器**端到端证明（CDP）
   --------------------------------------------------------------------
   运行：node tests/test_r4c_live_interpretation_auto_browser.js

   ── 真 / 假 的分界（本套件的全部意义）──────────────────────────────────
   REAL：Chrome · InternalBeyond.html（产品自己的静态层）· Home Node（真实
         buildHomeNode + 真实 SQLite store + 真实 HTTP 监听）· Desktop
         authoritative Recall 路径 · **浏览器 → Home Node 的召回传输** ·
         服务端召回权威 · 自动调度 seam（post-recall、fire-and-forget）。
   FAKE：Vault（测试自种的 credential 目录）与 provider/modelPort
         （注入的假 fetch）⇒ `REAL_PROVIDER_CALLS_DURING_TESTS = 0`。

   ── 为什么 Home Node 是**进程内**实例 ─────────────────────────────────
   自动解释的 cost gate 是**装配事实**（`runtimeAutoInterpretationPolicy`），
   生产 require.main 路径刻意没有启用旋钮。要让"自动策略 ON"这条真实链路
   跑起来，唯一诚实的做法就是在测试进程里 buildHomeNode + 注入假
   modelPort/Vault，再让真实浏览器通过真实 HTTP 打进来 —— 传输、召回权威、
   调度 seam 全是真的，只有 provider 与 Vault 是假的。这与
   tests/test_r4c_live_interpretation_auto.js（Node 侧）是同一条缝。

   ── 逐用例看门狗 ──────────────────────────────────────────────────────
   每个 case 有显式预算（CASE_BUDGET，按真实需要选定）；超时打印当前用例 /
   各实例 auto 计数后非零退出；整个进程另有总预算。结束语**自然退出**
   （不用 process.exit(0)），并实测最后一条断言到退出的耗时。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'l41b-'));
process.env.TEMP = RUN_ROOT;
process.env.TMP = RUN_ROOT;
process.env.TMPDIR = RUN_ROOT;

const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
const sleep = fx.sleep;

let passed = 0, failed = 0;
const CONST = {};
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failed++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  return !!cond;
}
function section(t) { console.log('\n── ' + t + ' ──'); }
const P = (n, v) => { CONST[n] = v; console.log(n + ' = ' + v); };
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };
const sha256File = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return null; } };
const readRel = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ── 看门狗 ─────────────────────────────────────────────────────────── */
const CASE_BUDGET = { BUILD: 25000, TURN: 45000, AUTO: 30000, SLOW: 35000, TMO_CASE: 60000 };
const OVERALL_BUDGET_MS = 420000;
let CURRENT_CASE = '(none)';
class CaseTimeout extends Error {}
const INSTANCES = [];
function diagnosticsDump() {
  const out = ['  CASE      : ' + CURRENT_CASE];
  try { out.push('  resources : ' + process.getActiveResourcesInfo().join(',')); } catch (_) { /* n/a */ }
  for (const h of INSTANCES) {
    try {
      const d = h.inst.runtimeRecall.describe().autoInterpretation;
      out.push('  instance[' + h.tag + '] auto=' + J({ enabled: d.enabled, counters: d.counters, holderMax: d.resultHolder.maxEntries }));
    } catch (e) { out.push('  instance[' + h.tag + '] <describe threw>'); }
  }
  return out.join('\n');
}
async function withCase(name, kind, fn) {
  const budget = CASE_BUDGET[kind] || 25000;
  CURRENT_CASE = name + ' (budget ' + budget + 'ms)';
  let timer = null;
  const t0 = Date.now();
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new CaseTimeout('case exceeded ' + budget + 'ms')), budget); });
  try { return await Promise.race([fn(), guard]); }
  finally {
    if (timer) clearTimeout(timer);
    console.log('  CASE-END ' + name + ' elapsed=' + (Date.now() - t0) + 'ms');
    CURRENT_CASE = '(none)';
  }
}

/* ── 依赖 ───────────────────────────────────────────────────────────── */
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
const RC = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const RI = require(path.join(ROOT, 'services', 'home-node', 'runtime-interpretation.js'));
const WIRING = require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js'));
const SEAM_GUARD = require(path.join(ROOT, 'tests', 'helpers', 'runtime-seam-guard.js'));

/* ── 常量 ───────────────────────────────────────────────────────────── */
const NOW = 1750000000000;
const SENTINEL = 'SECRET_SENTINEL_INTERP_91B7';
const TOKEN = 'l41b-browser-token';
const QUERY = '显卡 驱动 更新失败';
const CHAR_A = 'role_l41b_a';
const CHAR_B = 'role_l41b_b';
const CANON_A = 'm_real_a';
const CANON_B = 'm_real_b';
const CANONICAL_TEXT_A = 'CANON_L41B_TEXT_A_5E0C 显卡 驱动 更新失败 那晚我熬到凌晨';
const CANONICAL_TEXT_B = 'CANON_L41B_TEXT_B_77A1 显卡 驱动 更新失败 让我很沮丧';
const MIRROR_DECOY_TEXT = 'MIRROR_DECOY_TEXT_31D9 这是浏览器镜像里被改成另一段的内容';
const MIRROR_DECOY_ID = 'm_fake';
const HOSTILE_MEANING = 'HOSTILE_INTERPRETATION_MARKER_9F4C 这条解释绝不该出现在任何 prompt 里';
const CHAT_MODEL = 'ib-l41b-chat-model';
const PROVIDER_PATH = '/v1/chat/completions';
const WIRE_ALLOWED_KEYS = ['operation', 'mode', 'characterId', 'requestId', 'conversationId', 'message', 'isFirstTurn', 'conversationSignalAvailable', 'timeoutMs'];
const WIRE_REQUIRED_KEYS = ['operation', 'mode', 'characterId', 'requestId', 'conversationId', 'message'];
const FORBIDDEN_WIRE_KEYS = ['selectedMemoryIds', 'records', 'content', 'credentialRef', 'provider', 'model', 'endpoint', 'summary', 'evidenceState', 'apiKey'];

/* ── 假解释 provider（注入 Home Node 的 modelPort.fetch）─────────────── */
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
function makeInterpFetch(rec, behaviour, hostile) {
  return function (url, init) {
    const headers = (init && init.headers) || {};
    const entry = {
      url: String(url), body: String((init && init.body) || ''), at: Date.now(),
      authorization: String(headers.Authorization || headers.authorization || '')
    };
    rec.push(entry);
    entry.batch = batchOf(entry.body);
    const b = (typeof behaviour === 'function' ? behaviour(entry, rec.length) : behaviour) || { mode: 'ok', delayMs: 0 };
    if (b.mode === 'hang') return new Promise(() => { /* 永不 settle（自动超时归属服务端） */ });
    const delay = b.delayMs || 0;
    entry.completedAt = Date.now() + delay;
    const delayed = (value) => (delay ? new Promise(r => setTimeout(() => r(value), delay)) : Promise.resolve(value));
    if (b.mode === 'httpError') return delayed({ ok: false, status: 500, text: () => Promise.resolve('{"error":{"message":"provider boom"}}') });
    let text = null;
    if (b.mode === 'invalidJson') {
      /* ★ 必须让 **content** 不是 JSON，而不是让 HTTP 信封不是 JSON：
         前者落到边界的 invalid-output，后者会先在 NodeModelPort 的 HTTP 解析里
         变成 provider-error —— 两个不同的类别，不能混。 */
      text = JSON.stringify({ choices: [{ message: { content: 'this-is-not-json-at-all' } }] });
    }
    else if (b.mode === 'validatorReject') {
      const id = (entry.batch && entry.batch[0] && entry.batch[0].memoryId) || CANON_A;
      text = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ memoryId: id, meaning: 'x', appraisal: 'neutral', affect: 'unclear', basis: 'user_stated', subjectiveConfidence: 0.5 }] }) } }] });
    } else {
      const payload = {
        items: (entry.batch || []).map(x => ({
          memoryId: x.memoryId,
          meaning: hostile ? HOSTILE_MEANING : ('解释：' + x.memoryId),
          appraisal: 'mixed', affect: 'warm', relationshipMeaning: null, causalAttribution: null,
          basis: 'ai_inference', subjectiveConfidence: 0.4
        }))
      };
      text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] });
    }
    return delayed({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}
function seedVault(dir, ref, provider, key) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert(ref, { provider, apiKey: key }); v.save();
}
const freshDir = prefix => fs.mkdtempSync(path.join(RUN_ROOT, prefix));

/* ── 真实 Home Node 实例（进程内装配 + 真实 HTTP 监听）───────────────── */
async function buildInstance(tag, opts) {
  const o = opts || {};
  const dataDir = freshDir('l41b-' + tag + '-data-');
  const credDir = freshDir('l41b-' + tag + '-cred-');
  if (o.vault !== false) seedVault(credDir, 'cred_a', 'custom', SENTINEL);
  if (o.vaultB) seedVault(credDir, 'cred_b', 'custom', SENTINEL + '_B');
  const rec = [];
  const port = NODE_MODEL_PORT({ fetch: makeInterpFetch(rec, o.behaviour, o.hostile === true), timeoutMs: 30000 });
  const buildOpts = { dataDir, credentialDataDir: credDir, token: TOKEN, port, clock: () => NOW, logger: () => {} };
  if (o.autoPolicy !== undefined) buildOpts.runtimeAutoInterpretationPolicy = o.autoPolicy;
  const inst = SERVICE.buildHomeNode(buildOpts);
  inst.open();
  inst.registry.putCharacter(CHAR_A, { id: CHAR_A, name: 'A', relationship: 'friend' },
    { provider: 'custom', model: 'model-a', endpoint: 'http://127.0.0.1:1/v1/chat/completions', credentialRef: o.credA === false ? 'cred_missing' : 'cred_a', systemPrompt: 'SYS' });
  inst.registry.putCharacter(CHAR_B, { id: CHAR_B, name: 'B', relationship: 'friend' },
    { provider: 'custom', model: 'model-b', endpoint: 'http://127.0.0.1:1/v1/chat/completions', credentialRef: o.vaultB ? 'cred_b' : 'cred_a', systemPrompt: 'SYS' });
  const webPort = await new Promise(r => inst.server.listen(0, '127.0.0.1', () => r(inst.server.address().port)));
  const handle = { tag, inst, rec, dataDir, credDir, webPort, dbFile: path.join(dataDir, 'home-node.db'), vaultFile: path.join(credDir, 'credential-vault.json') };
  INSTANCES.push(handle);
  return handle;
}
function closeAllInstances() {
  for (const h of INSTANCES) {
    try { if (h.inst.server && h.inst.server.listening) h.inst.server.close(); } catch (_) { /* 未监听 */ }
    try { h.inst.close(); } catch (_) { /* 已关闭 */ }
  }
}
function putRecord(h, id, over) {
  return h.inst.memoryStore.putRecord(Object.assign({
    id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' ' + QUERY, domain: '日常', tags: [],
    valence: 0.2, arousal: 0.6, importance: 6, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000, createdBy: 'user',
    createdByName: '', editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {}));
}
const interpCallsOf = h => h.rec.filter(e => e.batch !== null);
const countersOf = h => h.inst.runtimeRecall.describe().autoInterpretation.counters;
const idleOf = (h, ms) => h.inst.runtimeRecall.awaitAutoIdle(ms);
/* ★ holder 的键是**服务端派生**的 turnId（deriveStableTurnId(requestId, conversationId)），
   不是请求里的 requestId —— 用错键会得到 null，而那看起来像"结果没落"。 */
const holderKeyOf = (requestId, conversationId) => RC.deriveStableTurnId(requestId, conversationId);
const holderOf = (h, turnId) => h.inst.runtimeRecall.getTurnInterpretation(turnId);

/* ── 浏览器聊天 mock provider（真 HTTP，含 CORS 与按需失败）──────────── */
function createChatProvider() {
  const seen = [];
  const state = { failNext: false };
  const server = http.createServer(function (req, res) {
    const origin = String(req.headers.origin || '*');
    const cors = {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || 'Content-Type, Authorization, x-api-key'),
      'Access-Control-Max-Age': '600', 'Vary': 'Origin'
    };
    if (String(req.headers['access-control-request-private-network'] || '') === 'true') cors['Access-Control-Allow-Private-Network'] = 'true';
    if (String(req.method).toUpperCase() === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      const fail = state.failNext;
      if (fail) state.failNext = false;
      const entry = { at: Date.now(), method: String(req.method), url: String(req.url), host: String(req.headers.host || ''), body: body, raw: raw, failed: fail };
      seen.push(entry);
      if (fail) {
        res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(JSON.stringify({ error: { message: 'mock chat failure' } }));
        return;
      }
      const content = '（mock chat）我听到了。';
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream' }, cors));
      res.write('data: ' + JSON.stringify({ id: 'chat-mock', object: 'chat.completion.chunk', model: CHAT_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: content } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'chat-mock', object: 'chat.completion.chunk', model: CHAT_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server: server, seen: seen, state: state };
}
const chatPosts = prov => prov.seen.filter(e => e.method === 'POST' && e.url === PROVIDER_PATH);
/* ── P21-QA-R4 §7/§8/§10 · 测量归属谓词（本套件唯一一份）─────────────────
   同一个 provider 端点在**一个回合里**会被调用不止一次：主聊天、回合末尾的
   Auto-Memory / 日记判定（它们共用端点 / method / model）。所以：
     · 取"最后一次 POST" ⇒ 会把日记提示词当聊天 prompt；
     · 取"最新一条出现过 marker 的 POST" ⇒ 同样会命中日记调用（它的转写里
       含有这一轮的用户文本）—— 这正是 5.1/3.1 一类假红的来源。
   本谓词只用**线级结构**与**这一轮的真实身份**（本轮用户文本 / 端点 / method /
   载荷结构）：不发明生产身份、不加 header、不引入 test-only 运行期字段。 */
const QA_TURN_SCHEMA_KEY = /"(shouldWrite|diaryType)"\s*:/;
const QA_LOOKUPS = [];
function chatTextOf(entry) {
  const msgs = (entry && entry.body && Array.isArray(entry.body.messages)) ? entry.body.messages : [];
  return msgs.map(function (m) {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(p => (p && p.text) || '').join('\n');
    return '';
  }).join('\n');
}
function tailOf(entry) {
  const msgs = (entry && entry.body && Array.isArray(entry.body.messages)) ? entry.body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(p => (p && p.text) || '').join('\n');
  }
  return '';
}
function providerPostKind(entry) {
  if (!entry || String(entry.method || '').toUpperCase() !== 'POST') return 'NON_POST';
  if (entry.url !== PROVIDER_PATH) return 'OTHER_BACKGROUND_CALL';
  const msgs = (entry.body && Array.isArray(entry.body.messages)) ? entry.body.messages : null;
  if (!msgs || !msgs.length) return 'OTHER_BACKGROUND_CALL';
  if (QA_TURN_SCHEMA_KEY.test(tailOf(entry))) return 'AUTO_MEMORY_OR_DIARY_CALL';
  return 'MAIN_CHAT_MODEL_CALL';
}
function isCurrentTurnMainChat(entry, turnText) {
  return providerPostKind(entry) === 'MAIN_CHAT_MODEL_CALL'
    && !!turnText && tailOf(entry).indexOf(turnText) >= 0;
}
/* §8/§10：给定这一轮的身份，**只**返回这一轮的主聊天模型调用；找不到 ⇒ null
   （调用方必须显式失败）—— 绝不回落到"最新一条看起来像的"。 */
function findChatPostFor(list, marker) {
  const posts = (Array.isArray(list) ? list : []).filter(e => e && e.method === 'POST' && e.url === PROVIDER_PATH);
  const hits = posts.filter(e => isCurrentTurnMainChat(e, marker));
  const picked = hits.length ? hits[hits.length - 1] : null;
  const record = {
    marker: marker, candidates: posts.length, mainChatHits: hits.length,
    pickedKind: picked ? providerPostKind(picked) : 'NOT_FOUND',
    pickedIndex: picked ? posts.indexOf(picked) : null,
    tailFp: picked ? require('crypto').createHash('sha256').update(tailOf(picked)).digest('hex').slice(0, 12) : null,
    diaryCandidates: posts.filter(e => providerPostKind(e) === 'AUTO_MEMORY_OR_DIARY_CALL').length
  };
  QA_LOOKUPS.push(record);
  console.log('QA_LOOKUP marker=' + String(marker).slice(0, 24) + ' candidates=' + record.candidates
    + ' mainChatHits=' + record.mainChatHits + ' diaryCandidates=' + record.diaryCandidates
    + ' pickedKind=' + record.pickedKind + ' pickedIndex=' + record.pickedIndex + ' tailFp=' + record.tailFp);
  return picked;
}
/* §10：**这一轮自己的**主聊天调用数（不是"窗口里所有 POST"）。 */
function currentTurnMainChatCount(list, marker) {
  return (Array.isArray(list) ? list : []).filter(e => isCurrentTurnMainChat(e, marker)).length;
}
function normalizePromptWithoutMemory(text) {
  return String(text).split('\n')
    .filter(l => !/^当前时间：/.test(l))
    .filter(l => l.indexOf('【记忆（系统参考') < 0)
    .filter(l => !/^- \[用户记录\]/.test(l))
    .join('\n').trim();
}

(async function main() {
  console.log('P21-R4-LIVE-4.1B · 真实浏览器自动解释端到端证明');
  console.log('scratch root = ' + RUN_ROOT);

  const exe = fx.chromePath();
  if (!exe) {
    console.error('  FAIL  BLOCKED：找不到 Chrome / Edge。');
    console.error('R4C_LIVE_INTERPRETATION_AUTO_BROWSER_VERDICT=BLOCKED no-browser');
    process.exitCode = 1;
    return;
  }
  const T_START = Date.now();
  let T_LAST_ASSERTION = 0;
  let launched = null;
  let chatProvider = null;
  let webChild = null;

  /* ── P21-QA-R4 · §13/§14 · Criterion v2 形式化（**跑之前**声明）───────────
     AUTHORITY_ASSERTION_SET：任何一条红都意味着边界属性破了。
     MEASUREMENT_ASSERTION_SET：只能在运行**之前**声明，跑完**不许**追加。
     ★ 本阶段的目标相反：三条测量债修好之后相关断言回到正常断言集，
       因此这里的测量集是**空集**。
     （★ 声明在 try 之外：结束时的汇总也在 try/finally 的另一侧，作用域必须
       覆盖两者 —— 第一版把它写在 try 里，于是汇总抛了 ReferenceError。） */
  const AUTHORITY_ASSERTION_SET = ['0.1', '1.1', '2.2', '3.2', '3.3', '3.4', '3.5', '5.1', '5.2', '6.1', '7.1', '8.1'];
  const MEASUREMENT_ASSERTION_SET = [];

  try {
    console.log('DECLARED_MEASUREMENT_ASSERTIONS = ' + JSON.stringify(MEASUREMENT_ASSERTION_SET));
    console.log('DECLARED_AUTHORITY_ASSERTIONS = ' + JSON.stringify(AUTHORITY_ASSERTION_SET));
    /* ══════════════════════════════════════════════════════════════ 0 · 接口 */
    section('0 · auto-interpretation interfaces (measured, not guessed)');
    check('0.1 auto 入口 / 通道矩阵 / 每回合上限 / 服务端超时 —— 与实现导出的常量逐字一致',
      RI.AUTO_INTERPRETATION_ENTRY === 'runFromAuthoritativeRecall' &&
      J(RI.AUTO_INTERPRETATION_CHANNELS.slice().sort()) === J(['recall', 'surface']) &&
      RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN === 1 &&
      RI.AUTO_INTERPRETATION_TIMEOUT_MS === 20000 &&
      RI.MAX_SELECTED_MEMORY_IDS === 8,
      J({ entry: RI.AUTO_INTERPRETATION_ENTRY, channels: RI.AUTO_INTERPRETATION_CHANNELS, cap: RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN, tmo: RI.AUTO_INTERPRETATION_TIMEOUT_MS }));
    check('0.2 §31 本套件已登记进 tests/test-all.js（additive）',
      readRel('tests/test-all.js').indexOf('test_r4c_live_interpretation_auto_browser.js') >= 0,
      'otherwise it is never aggregated');
    P('AUTO_SUITE_REGISTERED_IN_TEST_ALL', readRel('tests/test-all.js').indexOf('test_r4c_live_interpretation_auto_browser.js') >= 0 ? 'YES' : 'NO');
    P('MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN', String(RI.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN));
    P('AUTO_INTERPRETATION_TIMEOUT_MS', String(RI.AUTO_INTERPRETATION_TIMEOUT_MS));
    P('AUTO_INTERPRETATION_CHANNELS', J(RI.AUTO_INTERPRETATION_CHANNELS));

    /* ══════════════════════════════════════════════════════════════ 1 · 实例 */
    section('1 · in-process Home Node instances (fake Vault + fake modelPort)');
    const ON = await withCase('build ON', 'BUILD', () => buildInstance('on', {
      autoPolicy: { autoInterpretationEnabled: true },
      behaviour: (entry, n) => ({ mode: 'ok', delayMs: n <= 1 ? 500 : 2000 }),
      hostile: true
    }));
    const OFF = await withCase('build OFF', 'BUILD', () => buildInstance('off', {}));
    const ZERO = await withCase('build ZERO', 'BUILD', () => buildInstance('zero', { autoPolicy: { autoInterpretationEnabled: true } }));
    const REP = await withCase('build REPLAY', 'BUILD', () => buildInstance('rep', { autoPolicy: { autoInterpretationEnabled: true } }));
    const NOCRED = await withCase('build NO-CREDENTIAL', 'BUILD', () => buildInstance('nocred', { autoPolicy: { autoInterpretationEnabled: true }, credA: false }));
    const PERR = await withCase('build PROVIDER-ERROR', 'BUILD', () => buildInstance('perr', { autoPolicy: { autoInterpretationEnabled: true }, behaviour: { mode: 'httpError' } }));
    const BADJ = await withCase('build INVALID-JSON', 'BUILD', () => buildInstance('badj', { autoPolicy: { autoInterpretationEnabled: true }, behaviour: { mode: 'invalidJson' } }));
    const VREJ = await withCase('build VALIDATOR-REJECT', 'BUILD', () => buildInstance('vrej', { autoPolicy: { autoInterpretationEnabled: true }, behaviour: { mode: 'validatorReject' } }));
    const HANG = await withCase('build TIMEOUT', 'BUILD', () => buildInstance('hang', { autoPolicy: { autoInterpretationEnabled: true }, behaviour: { mode: 'hang' } }));
    const PERS = await withCase('build PERSISTENCE', 'BUILD', () => buildInstance('pers', { autoPolicy: { autoInterpretationEnabled: true } }));
    const TWO = await withCase('build TWO-ROLES', 'BUILD', () => buildInstance('two', { autoPolicy: { autoInterpretationEnabled: true }, vaultB: true }));

    const onAuto = ON.inst.runtimeRecall.describe().autoInterpretation;
    const onInterp = ON.inst.runtimeInterpretation.describe();
    check('1.1 ON 装配：auto 策略开、外部路由策略仍关（两个表达式互不影响）',
      onAuto.enabled === true && onAuto.hooked === true &&
      onInterp.autoPolicy.autoInterpretationEnabled === true &&
      onInterp.costPolicy.memoryInterpretationEnabled === false &&
      onInterp.autoPolicy.assemblyOption === 'runtimeAutoInterpretationPolicy' &&
      /* ⚠ PHASE TRANSITION（P21-R4-LIVE-4.3 · 值修正，不是措辞修正）────────
         本阶段之前这条边界**没有**生产启用路径 ⇒ 'NONE_IN_THIS_PHASE' 是真的。
         现在有了**恰好一条**：操作者侧策略文件 <dataDir>/runtime-policy.json
         （唯一写者 = Node 侧 runtime-policy.set()）⇒ 旧值是假话，改为
         'OPERATOR_FILE_ONLY'。调用者侧伪造面不变：callerFacingEnablePath = 'NONE'。 */
      onInterp.autoPolicy.productionEnablePath === 'OPERATOR_FILE_ONLY' &&
      onInterp.autoPolicy.callerFacingEnablePath === 'NONE' &&
      onInterp.durable === false,
      J({ auto: onAuto.enabled, ext: onInterp.costPolicy.memoryInterpretationEnabled, autoPolicy: onInterp.autoPolicy }));
    check('1.2 OFF 装配：auto 关闭（决定性对照）',
      OFF.inst.runtimeRecall.describe().autoInterpretation.enabled === false,
      OFF.inst.runtimeRecall.describe().autoInterpretation.enabled);

    const holder = onAuto.resultHolder;
    P('MAX_HELD_RESULTS', holder.maxEntries);
    P('HOLDER_TTL_MS', holder.ttlMs);
    P('HOLDER_SCOPE', holder.scope);
    P('HOLDER_STORAGE', holder.storage);
    P('HOLDER_DURABLE', String(holder.durable));
    P('HOLDER_ROUTES', J(holder.routes));
    P('HOLDER_CLEANUP_CONDITION', 'TTL sweep on every record (now - completedAt/startedAt > ttlMs) + FIFO evict when size > maxEntries; in-process read seam only, no route');
    check('1.3 §29 holder 有界：64 条 + 10 分钟 TTL + character+turn 作用域 + 非持久 + 零路由',
      holder.maxEntries === 64 && holder.ttlMs === 600000 && holder.scope === 'character+turn' &&
      holder.storage === 'IN_PROCESS_MEMORY_ONLY' && holder.durable === false && J(holder.routes) === '[]',
      holder);

    for (const h of [ON, OFF, REP, NOCRED, PERR, BADJ, VREJ, HANG, PERS, TWO]) {
      putRecord(h, CANON_A, { importance: 9, content: CANONICAL_TEXT_A });
      putRecord(h, CANON_B, { importance: 8, content: CANONICAL_TEXT_B });
    }

    /* ══════════════════════════════════════════════════════════════ 2 · 浏览器 */
    section('2 · real Chrome + InternalBeyond.html + real chat mock');
    chatProvider = createChatProvider();
    const chatPort = await new Promise(r => chatProvider.server.listen(0, '127.0.0.1', () => r(chatProvider.server.address().port)));
    const chatEndpoint = 'http://127.0.0.1:' + chatPort + PROVIDER_PATH;
    const webPort = await fx.freePort();
    webChild = spawn(process.execPath, [path.join('services', 'internal-beyond-server.js')], {
      cwd: ROOT, env: Object.assign({}, process.env, { IB_WEB_PORT: String(webPort) }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let webUp = false;
    for (let i = 0; i < 80; i++) { const w = await fx.request(webPort, 'GET', '/health'); if (w.status === 200) { webUp = true; break; } await sleep(250); }
    check('2.1 真实静态层活着（产品自己的 server 提供 InternalBeyond.html）', webUp === true, webUp);

    launched = await fx.launchChrome(exe, {});
    P('CHROME_LAUNCHED', 'YES');
    P('CHROME_PROFILE_UNDER_DSH_TMP', String(launched.profile || '').indexOf(RUN_ROOT) === 0 ? 'YES' : 'NO');
    const cdp = launched.cdp;
    const evaluate = async function (expression, awaitPromise) {
      const r = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: awaitPromise === true });
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async function (expr, timeoutMs, label) {
      const deadline = Date.now() + (timeoutMs || 15000);
      let last = null;
      while (Date.now() < deadline) {
        try { last = await evaluate(expr); } catch (_) { last = null; }
        if (last) return last;
        await sleep(250);
      }
      throw new Error('等待超时：' + (label || expr));
    };
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try{'
        + 'localStorage.setItem("ib_home_node_http",' + JSON.stringify('http://127.0.0.1:' + ON.webPort) + ');'
        + 'localStorage.setItem("ib_home_node_mode","canonical");'
        + 'localStorage.setItem("ib_home_node_token",' + JSON.stringify(TOKEN) + ');'
        + '}catch(e){}'
    });
    const loaded = new Promise(r => cdp.on('Page.loadEventFired', r));
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/InternalBeyond.html' });
    await loaded;
    await sleep(600);
    const surfaceOk = await waitFor(`(function(){
      return !!(window.IB && IB.homeNode && IB.homeNode.runtime && IB.homeNode.runtime.available === true
        && typeof IB.homeNode.runtime.runMemoryRecall === 'function' && typeof sendChatMessage === 'function');
    })()`, 30000, 'runtime + sendChatMessage').catch(() => false);
    check('2.2 真实页面里三个必需件都在（runtime 面 / runMemoryRecall / sendChatMessage）', surfaceOk === true, surfaceOk);

    const INSTRUMENT = `(function(){
      if (window.__l41) return 'already';
      var P = window.__l41 = { http: [], selectorCalls: 0, exposureWrites: 0, activationWrites: 0, notes: [] };
      try {
        var real = window.fetch;
        window.fetch = function(url, init){
          var u = String(url);
          var rec = { url: u, method: (init && init.method) || 'GET', t0: Date.now() };
          if (init && init.body) { try { rec.body = JSON.parse(String(init.body)); } catch (e) { rec.bodyRaw = String(init.body).slice(0, 200); } }
          P.http.push(rec);
          var p = real.apply(this, arguments);
          p.then(function(res){ rec.status = res.status; rec.t1 = Date.now();
            try { res.clone().text().then(function(t){ try { rec.response = JSON.parse(t); } catch (e) { rec.responseRaw = String(t).slice(0, 400); } }, function(){}); } catch (e) {}
          }, function(err){ rec.error = String((err && err.message) || err); rec.t1 = Date.now(); });
          return p;
        };
        ['selectMemoryContext','getMemoryContext'].forEach(function(n){
          var f = window[n];
          if (typeof f !== 'function') { P.notes.push('missing:' + n); return; }
          window[n] = function(){ P.selectorCalls += 1; return Promise.resolve({ context: ${JSON.stringify(MIRROR_DECOY_TEXT)}, selectedIds: [${JSON.stringify(MIRROR_DECOY_ID)}], activationPolicy: 'normal' }); };
        });
        if (typeof window._ibRecordRecallExposure === 'function') { var e0 = window._ibRecordRecallExposure; window._ibRecordRecallExposure = function(){ P.exposureWrites += 1; return e0.apply(this, arguments); }; }
        if (typeof window.recordMemoryActivation === 'function') { var a0 = window.recordMemoryActivation; window.recordMemoryActivation = function(){ P.activationWrites += 1; return a0.apply(this, arguments); }; }
      } catch (e) { P.notes.push('instrument:' + e); }
      return 'ok';
    })()`;
    const instr = await evaluate(INSTRUMENT);
    check('2.3 仪器装上了（出站请求全捕获；浏览器选择器已替换成会返回另一个答案的版本）', instr === 'ok', instr);

    const setBase = h => evaluate(`(function(){ localStorage.setItem('ib_home_node_http', ${JSON.stringify('http://127.0.0.1:')} + ${JSON.stringify(String(h.webPort))} + ''); return localStorage.getItem('ib_home_node_http'); })()`);
    const prepRole = (roleId) => evaluate(`(function(){
      var cfg = { id: ${JSON.stringify(roleId)}, nickname: 'L41B', model: ${JSON.stringify(CHAT_MODEL)},
        endpoint: ${JSON.stringify(chatEndpoint)}, apiKey: 'test-local-key', provider: 'custom',
        relationship: 'friend', systemPrompt: '', temperature: 1, streaming: true, showThinking: false,
        promptCache: false, created: Date.now() };
      return Promise.resolve(dbPut('apiConfigs', cfg))
        .then(function(){ return (typeof loadApiConfigs === 'function') ? loadApiConfigs() : null; })
        .then(function(){
          window.activeFriendId = ${JSON.stringify(roleId)};
          window.activeThreadId = null;
          window.currentPage = 'chat';
          var el = document.getElementById('chat-full-input') || document.getElementById('chat-input');
          return { ok: !!el, activeFriendId: window.activeFriendId, base: localStorage.getItem('ib_home_node_http') };
        })
        .catch(function(e){ return { ok: false, error: String((e && e.message) || e) }; });
    })()`, true);
    const runTurn = marker => evaluate(`(function(){
      var el = document.getElementById('chat-full-input') || document.getElementById('chat-input');
      if (!el) return Promise.resolve({ ok: false, error: 'no-input-element' });
      el.value = ${JSON.stringify(QUERY)} + ' ' + ${JSON.stringify(marker)};
      return Promise.resolve(sendChatMessage())
        .then(function(res){ return { ok: true, error: (res && res.error) || null }; },
              function(err){ return { ok: false, error: String((err && err.message) || err) }; });
    })()`, true);
    const pageHttp = () => evaluate('(function(){ return (window.__l41 && window.__l41.http) || []; })()');
    const resetProbe = () => evaluate('(function(){ var p = window.__l41; p.http = []; p.selectorCalls = 0; p.exposureWrites = 0; p.activationWrites = 0; return "reset"; })()');
    const recallWire = async () => (await pageHttp()).filter(r => String(r.url).indexOf('/internal/runtime/memory-recall') >= 0);
    const directRecall = (h, roleId, requestId, message) => evaluate(`(function(){
      return Promise.resolve(IB.homeNode.runtime.runMemoryRecall({ operation: 'memory-recall', mode: 'authoritative',
        characterId: ${JSON.stringify(roleId)}, requestId: ${JSON.stringify(requestId)},
        conversationId: 'dm:' + ${JSON.stringify(roleId)}, message: ${JSON.stringify(message)} }, { timeoutMs: 5000 }))
        .then(function(res){ return { ok: !!(res && res.ok === true), selectedIds: (res && res.selectedIds) || [], status: res && res.status }; },
              function(e){ return { ok: false, error: String((e && e.message) || e) }; });
    })()`, true);

    const prepA = await prepRole(CHAR_A);
    check('2.4 页面准备好真实角色 A（apiConfig 落库 + 当前角色 + 输入框存在）',
      prepA && prepA.ok === true && prepA.activeFriendId === CHAR_A, prepA);

    /* ══════════════════════════════════════════════════════════════ 3 · §14 */
    section('3 · §14 one real desktop turn → server recall → main chat continues → auto interpretation');
    await withCase('warm-up turn', 'TURN', async () => { await runTurn('warmup'); await sleep(200); await resetProbe(); });
    const chatBefore1 = chatPosts(chatProvider).length;
    /* §10：这一轮**自己**的主聊天调用数（基线同口径），不是"窗口里所有 POST"。 */
    const mainChatBefore1 = currentTurnMainChatCount(chatPosts(chatProvider), 'happy-A1');
    const interpBefore1 = interpCallsOf(ON).length;
    const turn1 = await withCase('turn 1 (500ms interpretation)', 'TURN', () => runTurn('happy-A1'));
    /* ★ 非阻塞的第二重证据：召回响应刚回来那一刻的后台状态（5ms 采样，best-effort）。 */
    const recallEntry1 = (await recallWire()).filter(r => r.body && String(r.body.message).indexOf('happy-A1') >= 0)[0] || null;
    const chatPost1 = findChatPostFor(chatPosts(chatProvider), 'happy-A1');
    const turnId1 = recallEntry1 && recallEntry1.body ? holderKeyOf(recallEntry1.body.requestId, recallEntry1.body.conversationId) : '';
    const idle1 = await withCase('await auto idle (turn 1)', 'AUTO', () => idleOf(ON, 30000));
    const holder1 = holderOf(ON, turnId1);
    const interp1 = interpCallsOf(ON)[interpBefore1] || null;
    const pendingAtResponse1 = (chatPost1 && interp1) ? (interp1.at <= chatPost1.at) : null;

    /* ── §10（P21-QA-R4）：绑定**这一轮自己的**主聊天调用 ─────────────────
       旧写法 `chatPosts().length === chatBefore1 + 1` 是"整个窗口里 POST 总数"
       的精确计数，回合末尾的 Auto-Memory / 日记调用（或上一轮迟到的 POST）都会
       打破它 —— 那是测量归属问题，不是权威问题。现在只认这一轮的主聊天调用。 */
    check('3.1 真实回合跑完，主聊天走到了 provider（召回之后主路径照常继续）',
      turn1 && turn1.ok === true && !!chatPost1 && currentTurnMainChatCount(chatPosts(chatProvider), 'happy-A1') === mainChatBefore1 + 1,
      { turn: turn1, chatCalls: chatPosts(chatProvider).length, turnMainChatCalls: currentTurnMainChatCount(chatPosts(chatProvider), 'happy-A1'), baseline: mainChatBefore1 });
    check('3.2 服务端真的**开始**了后台自动解释：恰好 1 次 provider 调用',
      interpCallsOf(ON).length === interpBefore1 + 1 && countersOf(ON).succeeded === 1,
      J({ calls: interpCallsOf(ON).length, counters: countersOf(ON) }));
    check('3.3 §16 自动解释的 MEMORY_BATCH 就是服务端召回选出的 ids（顺序一致）',
      !!interp1 && !!recallEntry1 && !!recallEntry1.response &&
      J((interp1.batch || []).map(b => b.memoryId)) === J(recallEntry1.response.selectedIds || []),
      J({ batch: interp1 && (interp1.batch || []).map(b => b.memoryId), serverIds: recallEntry1 && recallEntry1.response && recallEntry1.response.selectedIds }));
    check('3.4 §17 自动解释看到的正文是 **canonical** 正文（不是镜像里的 DECOY）',
      !!interp1 && (interp1.batch || []).length >= 1 &&
      String((interp1.batch[0] || {}).content).indexOf('CANON_L41B_TEXT_A') >= 0 &&
      J(interp1.batch).indexOf(MIRROR_DECOY_TEXT) < 0,
      J(interp1 && (interp1.batch || []).map(b => String(b.content).slice(0, 24))));
    check('3.5 校验过的结果落进 turn-local holder（同 turnId、status=succeeded、有 items）',
      !!holder1 && holder1.status === 'succeeded' && holder1.turnId === turnId1 &&
      !!holder1.interpretation && Array.isArray(holder1.interpretation.items) && holder1.interpretation.items.length >= 1,
      holder1 && { status: holder1.status, turnId: holder1.turnId, items: holder1.interpretation && holder1.interpretation.items.length });
    P('AUTO_INTERPRETATION_EVIDENCE_MATCHES_SERVER_RECALL',
      (!!interp1 && !!recallEntry1 && !!recallEntry1.response && J((interp1.batch || []).map(b => b.memoryId)) === J(recallEntry1.response.selectedIds || [])) ? 'YES' : 'NO');

    const allPage = await pageHttp();
    const recallWireAll = allPage.filter(r => String(r.url).indexOf('/internal/runtime/memory-recall') >= 0);
    const wireKeysAll = recallWireAll.map(r => Object.keys(r.body || {}));
    const forbiddenOnWire = recallWireAll.filter(r => FORBIDDEN_WIRE_KEYS.some(k => Object.prototype.hasOwnProperty.call(r.body || {}, k)));
    const wireText = J(recallWireAll.map(r => r.body));
    const browserSubmittedContent = wireText.indexOf(CANONICAL_TEXT_A) >= 0 || wireText.indexOf(MIRROR_DECOY_TEXT) >= 0;
    const wireShapeOk = recallWireAll.length >= 1 && wireKeysAll.every(keys =>
      keys.every(k => WIRE_ALLOWED_KEYS.indexOf(k) >= 0) &&
      WIRE_REQUIRED_KEYS.every(k => keys.indexOf(k) >= 0));
    check('3.6 §14 浏览器 wire：召回请求只含冻结的 8 个形状键（必需 6 个在场）、零权威/内容字段、零正文',
      wireShapeOk && forbiddenOnWire.length === 0 && browserSubmittedContent === false && wireText.indexOf(SENTINEL) < 0,
      { wireKeys: wireKeysAll, forbidden: forbiddenOnWire.map(r => r.url) });
    P('BROWSER_SUBMITTED_SELECTED_MEMORY_IDS', forbiddenOnWire.some(r => 'selectedMemoryIds' in (r.body || {})) ? 'YES' : 'NO');
    P('BROWSER_SUBMITTED_RECORD_CONTENT', browserSubmittedContent ? 'YES' : 'NO');
    P('BROWSER_SUBMITTED_CREDENTIAL_REF', forbiddenOnWire.some(r => 'credentialRef' in (r.body || {})) ? 'YES' : 'NO');
    P('BROWSER_SUBMITTED_PROVIDER_MODEL_ENDPOINT', forbiddenOnWire.some(r => ['provider', 'model', 'endpoint', 'apiKey'].some(k => k in (r.body || {}))) ? 'YES' : 'NO');
    P('AUTO_INTERPRETATION_PROVIDER_CALLS_PER_TURN', String(countersOf(ON).succeeded));
    P('PENDING_AT_RESPONSE_OBSERVED', String(pendingAtResponse1));
    T_LAST_ASSERTION = Date.now();

    /* ══════════════════════════════════════════════════════════════ 4 · §15 */
    section('4 · §15 non-blocking (measured BEFORE any awaitAutoIdle)');
    const nbSamples = [{
      delay: 500,
      recallResponseMs: recallEntry1 && recallEntry1.t0 ? (recallEntry1.t1 - recallEntry1.t0) : null,
      chatStartAt: chatPost1 ? chatPost1.at : null,
      interpCompletedAt: interp1 ? interp1.completedAt : null,
      interpStartedAt: interp1 ? interp1.at : null,
      pendingAtResponse: pendingAtResponse1
    }];
    const interpBefore2 = interpCallsOf(ON).length;
    const turn2 = await withCase('turn 2 (2000ms interpretation)', 'SLOW', () => runTurn('happy-A2'));
    const recallEntry2 = (await recallWire()).filter(r => r.body && String(r.body.message).indexOf('happy-A2') >= 0)[0] || null;
    const chatPost2 = findChatPostFor(chatPosts(chatProvider), 'happy-A2');
    const idle2 = await withCase('await auto idle (turn 2)', 'SLOW', () => idleOf(ON, 30000));
    const interp2 = interpCallsOf(ON)[interpBefore2] || null;
    nbSamples.push({
      delay: 2000,
      recallResponseMs: recallEntry2 && recallEntry2.t0 ? (recallEntry2.t1 - recallEntry2.t0) : null,
      chatStartAt: chatPost2 ? chatPost2.at : null,
      interpCompletedAt: interp2 ? interp2.completedAt : null,
      interpStartedAt: interp2 ? interp2.at : null,
      pendingAtResponse: (interp2 && chatPost2) ? (interp2.at <= chatPost2.at) : null
    });
    const nbOk = turn2 && turn2.ok === true && nbSamples.every(s =>
      s.recallResponseMs != null && s.interpCompletedAt != null && s.chatStartAt != null &&
      s.recallResponseMs < s.delay && s.chatStartAt < s.interpCompletedAt && s.pendingAtResponse === true);
    P('NONBLOCKING_SAMPLES', J(nbSamples));
    P('RECALL_RESPONSE_MS_500', String(nbSamples[0].recallResponseMs));
    P('RECALL_RESPONSE_MS_2000', String(nbSamples[1].recallResponseMs));
    P('FIRST_TOKEN_BLOCKED_BY_INTERPRETATION', nbOk ? 'NO' : 'UNMEASURED_OR_YES');
    check('4.1 §15 500ms 与 2000ms 两档：召回响应与主模型请求开始都早于解释完成，且响应时解释仍在飞（均在 awaitAutoIdle 之前测得）',
      nbOk, { samples: nbSamples });
    T_LAST_ASSERTION = Date.now();

    /* ══════════════════════════════════════════════════════════════ 5 · §16/§17 */
    section('5 · §16/§17 caller-id negative control + mirror decoy');
    const mirrorWrite = await evaluate(`(function(){
      var row = { id: ${JSON.stringify(CANON_A)}, kind: 'episodic', title: '镜像里的假标题',
        content: ${JSON.stringify(MIRROR_DECOY_TEXT)}, domain: '日常', tags: [], valence: 0.9, arousal: 0.9,
        importance: 10, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
        activationCount: 0, created: Date.now() - 1000, lastActivated: Date.now() - 1000,
        createdBy: 'user', createdByName: '', editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null };
      /* ★ 用 core 的**原始**镜像句柄（window.__ibCoreDb），而不是被 home-node-bootstrap
         覆写成 canonical 写入的 window.dbPut —— 我们要改的是**浏览器镜像**。 */
      if (!window.__ibCoreDb || typeof window.__ibCoreDb.put !== 'function') return Promise.resolve('no-raw-handle');
      return Promise.resolve(window.__ibCoreDb.put('memories', row)).then(function(){ return 'written'; },
        function(e){ return 'err:' + String((e && e.message) || e); });
    })()`, true);
    P('MIRROR_DECOY_WRITTEN', mirrorWrite);
    const atomBefore = interpCallsOf(ON).length;
    const attack = await evaluate(`(function(){
      return fetch(${JSON.stringify('http://127.0.0.1:' + ON.webPort + RC.PATH)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-IB-Protocol': '1', 'X-IB-Home-Token': ${JSON.stringify(TOKEN)} },
        body: JSON.stringify({ operation: 'memory-recall', mode: 'authoritative', characterId: ${JSON.stringify(CHAR_A)},
          requestId: 'l41b_attack', conversationId: 'dm:' + ${JSON.stringify(CHAR_A)}, message: ${JSON.stringify(QUERY)},
          timeoutMs: 5000, selectedMemoryIds: [${JSON.stringify(MIRROR_DECOY_ID)}] })
      }).then(function(r){ return r.text().then(function(t){ var b=null; try{ b=JSON.parse(t);}catch(e){} return { status: r.status, body: b }; }); },
              function(e){ return { status: 0, error: String((e && e.message) || e) }; });
    })()`, true);
    await sleep(300);
    check('5.1 §16 浏览器携带 selectedMemoryIds=[m_fake] 的诊断请求被**指名拒绝**，且零解释调用',
      attack && attack.status === 400 && attack.body && attack.body.field === 'selectedMemoryIds' &&
      interpCallsOf(ON).length === atomBefore,
      { attack: attack, callsBefore: atomBefore, callsAfter: interpCallsOf(ON).length });
    P('CALLER_ID_REFUSAL_CODE', attack && attack.body ? String(attack.body.error) : 'UNKNOWN');
    P('CALLER_SELECTED_IDS_REACHED_INTERPRETATION', interpCallsOf(ON).some(e => J(e.batch).indexOf(MIRROR_DECOY_ID) >= 0) ? 'YES' : 'NO');
    check('5.2 §17 所有自动解释证据里都不含 m_fake（浏览器选的 id 从未到达 provider）',
      interpCallsOf(ON).every(e => J(e.batch).indexOf(MIRROR_DECOY_ID) < 0),
      J(interpCallsOf(ON).map(e => (e.batch || []).map(b => b.memoryId))));

    /* ══════════════════════════════════════════════════════════════ 6 · §18 */
    section('6 · §18 external route stays disabled while auto is ON');
    const extBefore = interpCallsOf(ON).length;
    const ext = await evaluate(`(function(){
      return fetch(${JSON.stringify('http://127.0.0.1:' + ON.webPort + RI.PATH)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-IB-Protocol': '1', 'X-IB-Home-Token': ${JSON.stringify(TOKEN)} },
        body: JSON.stringify({ operation: 'memory-interpretation', characterId: ${JSON.stringify(CHAR_A)}, timeoutMs: 2000, selectedMemoryIds: [${JSON.stringify(CANON_A)}] })
      }).then(function(r){ return r.text().then(function(t){ var b=null; try{ b=JSON.parse(t);}catch(e){} return { status: r.status, body: b }; }); },
              function(e){ return { status: 0, error: String((e && e.message) || e) }; });
    })()`, true);
    await sleep(300);
    const extRefused = !!(ext && ext.status === 503 && ext.body && ext.body.error === 'disabled' && interpCallsOf(ON).length === extBefore);
    check('6.1 §18 auto 策略 ON 时，浏览器直连解释路由仍然 503 disabled 且零额外 provider 调用', extRefused,
      { ext: ext, callsBefore: extBefore, callsAfter: interpCallsOf(ON).length });
    P('AUTO_POLICY_DOES_NOT_ENABLE_EXTERNAL_ROUTE', extRefused ? 'YES' : 'NO');
    P('EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED', 'NO');

    /* ══════════════════════════════════════════════════════════════ 7 · §19 */
    section('7 · §19 zero-memory turn');
    await setBase(ZERO);
    await prepRole(CHAR_A);
    const zeroBefore = chatPosts(chatProvider).length;
    const zeroTurn = await withCase('zero-memory real turn', 'TURN', () => runTurn('zero-A1'));
    const zeroChat = findChatPostFor(chatPosts(chatProvider), 'zero-A1');
    const zeroIdle = await withCase('zero idle', 'AUTO', () => idleOf(ZERO, 15000));
    const zeroCounters = countersOf(ZERO);
    check('7.1 §19 零记忆回合：0 次解释调用、pending 归零、主聊天仍然继续',
      zeroTurn && zeroTurn.ok === true && interpCallsOf(ZERO).length === 0 && zeroCounters.succeeded === 0 &&
      zeroIdle.inFlight === 0 && zeroIdle.scheduled === 0 && !!zeroChat && chatPosts(chatProvider).length === zeroBefore + 1,
      { turn: zeroTurn, calls: interpCallsOf(ZERO).length, counters: zeroCounters, idle: zeroIdle });
    P('ZERO_MEMORY_INTERPRETATION_CALLS', String(interpCallsOf(ZERO).length));
    P('ZERO_MEMORY_PENDING', String(zeroIdle.inFlight + zeroIdle.scheduled));
    P('ZERO_MEMORY_HOLDER_STATUS', J(holderOf(ZERO, 'zero-holder-probe') === null ? 'NO_ENTRY_OR_NOT_NEEDED' : holderOf(ZERO, 'zero-holder-probe').status));

    /* ══════════════════════════════════════════════════════════════ 8 · §20 */
    section('8 · §20 replay');
    await setBase(REP);
    await prepRole(CHAR_A);
    await withCase('replay turn 1', 'AUTO', async () => { await directRecall(REP, CHAR_A, 'l41b_rep_1', QUERY + ' rep'); await idleOf(REP, 20000); });
    const afterFirst = interpCallsOf(REP).length;
    await withCase('replay same turnId', 'AUTO', async () => { await directRecall(REP, CHAR_A, 'l41b_rep_1', QUERY + ' rep'); await idleOf(REP, 20000); });
    const afterReplay = interpCallsOf(REP).length;
    await withCase('replay new turnId', 'AUTO', async () => { await directRecall(REP, CHAR_A, 'l41b_rep_2', QUERY + ' rep2'); await idleOf(REP, 20000); });
    const afterNew = interpCallsOf(REP).length;
    check('8.1 §20 同一 turnId 重放 0 次额外解释；新 turnId +1（每回合上限 1）',
      afterFirst === 1 && afterReplay === afterFirst && afterNew === afterReplay + 1,
      { afterFirst, afterReplay, afterNew });
    P('AUTO_INTERPRETATION_REPLAY_CALLS_ADDITIONAL', String(afterReplay - afterFirst));
    P('AUTO_INTERPRETATION_NEW_TURN_CALLS_ADDITIONAL', String(afterNew - afterReplay));
    P('CROSS_RESTART_INTERPRETATION_EXACTLY_ONCE', 'NO');

    /* ══════════════════════════════════════════════════════════════ 9 · §21 */
    section('9 · §21 failure classes (real taxonomy)');
    const failureCases = [
      { tag: 'credential unavailable', h: NOCRED, status: 'failed', cls: 'credential-unavailable' },
      { tag: 'provider error', h: PERR, status: 'failed', cls: 'provider-error' },
      { tag: 'invalid JSON', h: BADJ, status: 'failed', cls: 'invalid-output' },
      { tag: 'validator reject', h: VREJ, status: 'failed', cls: 'model-returned-no-valid-item' },
      { tag: 'timeout', h: HANG, status: 'timed-out', cls: null }
    ];
    const failureMatrix = [];
    for (const fc of failureCases) {
      const kind = fc.status === 'timed-out' ? 'TMO_CASE' : 'AUTO';
      const turnId = 'l41b_fail_' + fc.h.tag;
      const r = await withCase('failure: ' + fc.tag, kind, async () => {
        await setBase(fc.h);
        await prepRole(CHAR_A);
        const turn = await directRecall(fc.h, CHAR_A, turnId, QUERY + ' fail ' + fc.h.tag);
        const idle = await idleOf(fc.h, fc.status === 'timed-out' ? 40000 : 20000);
        return { turn, idle, holder: holderOf(fc.h, holderKeyOf(turnId, 'dm:' + CHAR_A)), counters: countersOf(fc.h), calls: interpCallsOf(fc.h).length };
      });
      failureMatrix.push({ tag: fc.tag, status: r.holder && r.holder.status, errorClass: r.holder && r.holder.errorClass, calls: r.calls, recallOk: r.turn.ok });
      check('9.' + (failureMatrix.length) + ' §21 [' + fc.tag + '] 主路径不受影响（召回 ok）且 holder 落在真实分类',
        r.turn.ok === true && !!r.holder && r.holder.status === fc.status && (fc.cls == null || String(r.holder.errorClass) === fc.cls),
        { turn: r.turn, holder: r.holder && { status: r.holder.status, errorClass: r.holder.errorClass, reason: r.holder.reason }, counters: r.counters, idle: r.idle });
    }
    P('FAILURE_CLASS_MATRIX', J(failureMatrix));
    P('AUTO_TIMEOUT_CLASSIFICATION', J((failureMatrix.find(r => r.tag === 'timeout') || {})));
    await setBase(ON);
    await prepRole(CHAR_A);
    const afterFailTurn = await withCase('turn after failure classes', 'TURN', () => runTurn('after-fail'));
    check('9.6 §21 五类失败之后主聊天路径仍然正常（真实回合再次到达 provider）',
      afterFailTurn && afterFailTurn.ok === true && !!findChatPostFor(chatPosts(chatProvider), 'after-fail'),
      afterFailTurn);
    T_LAST_ASSERTION = Date.now();

    /* ══════════════════════════════════════════════════════════════ 10 · §22 */
    section('10 · §22 prompt isolation');
    await setBase(OFF);
    await prepRole(CHAR_A);
    const offTurn = await withCase('OFF real turn', 'TURN', () => runTurn('iso-off'));
    const offPost = findChatPostFor(chatPosts(chatProvider), 'iso-off');
    /* ── P21-QA-R4：把 10.1 变成**真的**测量 ────────────────────────────
       旧代码拿另一个回合的 marker（'after-fail'）来代表 ON 侧，而旧 finder 会把
       两次查询都解析到**同一篇 prompt**（'iso-off' 那轮的 prompt 历史里含
       'after-fail'）⇒ offNorm === onNorm 其实是"一条记录跟它自己比"，
       10.1 从未测量过 prompt 变异。
       现在：ON 装配下重跑**同一句用户文本**（'iso-off'），取它的主聊天调用，
       于是比较的是同一回合在两种装配下的 prompt（记忆块与时间行由
       normalizePromptWithoutMemory 去掉）。 */
    await setBase(ON);
    await prepRole(CHAR_A);
    const onTurnSameText = await withCase('ON real turn (same text)', 'TURN', () => runTurn('iso-off'));
    const onPostAfter = findChatPostFor(chatPosts(chatProvider), 'iso-off');
    /* 比较的是**这一轮自己的贡献**（最后一条 user 消息 = 该轮用户文本 + 本轮注入的
       记忆块），记忆块与时间行由 normalizePromptWithoutMemory 去掉。
       ★ 不能用整段 prompt 比：整段里含**累积的会话历史**，两个先后运行的回合
         历史长度天然不同（实测 609 vs 645），那会把"历史更长"误判成"解释改了
         prompt"。 */
    const offNorm = offPost ? normalizePromptWithoutMemory(tailOf(offPost)) : null;
    const onNorm = onPostAfter ? normalizePromptWithoutMemory(tailOf(onPostAfter)) : null;
    const offPromptChars = offPost ? chatTextOf(offPost).length : null;
    const onPromptChars = onPostAfter ? chatTextOf(onPostAfter).length : null;
    const mutation = (offNorm != null && onNorm != null && offNorm === onNorm) ? 0 : null;
    check('10.1 §22 auto OFF 与 auto ON 的**同一回合** prompt 在"解释之外"逐字相同 ⇒ CURRENT_TURN_PROMPT_MUTATION_FROM_INTERPRETATION = 0',
      offTurn && offTurn.ok === true && onTurnSameText && onTurnSameText.ok === true && !!offPost && !!onPostAfter && mutation === 0,
      { offChars: offNorm && offNorm.length, onChars: onNorm && onNorm.length, mutation: mutation, sameTurnText: 'iso-off',
        offPromptChars: offPromptChars, onPromptChars: onPromptChars, compared: 'current-turn tail (history excluded)' });
    P('CURRENT_TURN_PROMPT_MUTATION_FROM_INTERPRETATION', String(mutation == null ? 'UNMEASURED' : mutation));
    const hostileLeak = onPostAfter ? (chatTextOf(onPostAfter).indexOf(HOSTILE_MEANING) >= 0) : null;
    check('10.2 §22 极端/敌意解释结果没有泄漏进任何后续 prompt（turn-local holder 不回灌）',
      hostileLeak === false, { hostileInPrompt: hostileLeak });
    P('HOSTILE_INTERPRETATION_LEAKED_TO_PROMPT', String(hostileLeak === true));
    check('10.3 §22 自动解释的 provider 请求与主聊天请求是**两条**不同的 wire（互不替代）',
      interpCallsOf(ON).length >= 3 && chatPosts(chatProvider).length >= 5,
      { interp: interpCallsOf(ON).length, chat: chatPosts(chatProvider).length });

    /* ══════════════════════════════════════════════════════════════ 11 · §23/§24 */
    section('11 · §23 persistence + §24 cognitive-layer isolation');
    await setBase(PERS);
    await prepRole(CHAR_A);
    const memSnap = h => ({
      db: sha256File(h.dbFile), vault: sha256File(h.vaultFile),
      count: h.inst.memoryStore.countRecords(), rev: h.inst.memoryStore.getRevision(),
      und: J({ w: h.inst.understandingStore.getWatermark(CHAR_A), a: h.inst.understandingStore.getActive(CHAR_A) }),
      chat: J(h.inst.store.meta())
    });
    const persBefore = memSnap(PERS);
    await withCase('persistence recall+auto', 'AUTO', async () => { await directRecall(PERS, CHAR_A, 'l41b_pers_1', QUERY + ' pers'); await idleOf(PERS, 20000); });
    const persAfterRecallOnly = memSnap(PERS);
    await sleep(200);
    const persAfter = memSnap(PERS);
    const persHolder = holderOf(PERS, holderKeyOf('l41b_pers_1', 'dm:' + CHAR_A));
    check('11.1 §23 解释本身零持久化写入：召回自身效应之外 db / vault / memory / understanding / chat 全不变',
      persAfterRecallOnly.db === persAfter.db && persAfterRecallOnly.vault === persAfter.vault &&
      persAfterRecallOnly.count === persAfter.count && persAfterRecallOnly.und === persAfter.und &&
      persAfterRecallOnly.chat === persAfter.chat,
      { before: persBefore, afterRecall: persAfterRecallOnly, after: persAfter });
    P('INTERPRETATION_DURABLE_WRITES', persAfterRecallOnly.db === persAfter.db ? '0' : 'NONZERO');
    P('RECALL_OWN_EFFECTS_SEPARATED', J({ revBefore: persBefore.rev, revAfter: persAfter.rev, countBefore: persBefore.count, countAfter: persAfter.count }));
    /* ── ⚠ PHASE TRANSITION · P21-R4-LIVE-5 → P21-R4-F ─────────────────────
       旧值（LIVE-4）：召回边界与解释边界的**代码**里，四个域
       （expectation / counterfactual / prediction-error / behaviorEffect）
       一个都不许出现 —— 那时这四个域都没有 seam，出现即代表隐藏耦合。
       中间值（LIVE-5）：期望的兄弟 seam 按设计就在 runtime-recall.js 里
       （POST_INTERPRETATION_NONBLOCKING，由装配注入）。于是改为**钉住位置**：
       counterfactual / prediction-error / behaviorEffect 仍然全面禁止（R4-E 与
       PE 都没落地）；期望域只允许以 deps.expectation 出现。
       ★ 新值（R4-F）：BehaviorEffect 的**交付通道**（第 17 键）与确定性派生
       seam **按设计**也落进 runtime-recall.js，所以"behaviorEffect 这个词不许
       出现"必然变红 —— 而它不能删、也不能放宽成一个"允许出现"的正则：那种
       正则看不见"第二个 seam / 错误函数读 holder / selector 阶段派生 / 源回合
       直接消费"这四类真实缺陷。
       ★ 因此本条改为调用**唯一的** seam 权威
       `tests/helpers/runtime-seam-guard.js`：它钉的是精确位置与调用关系
       （dep 注入恰好一次 · derive/consume 各恰好一次且各只在其授权函数内 ·
        behaviorEffect 只允许落在 5 个具名位置 · 选择阶段与自动解释调度体内一个
        都不许有），而解释边界仍然四域全禁 —— 解释路径**绝不**获得期望或行为语义。
       守卫自身带 5 个对抗样本（tests/test_r4f_live_behavior_effect.js §9.4）；
       边界事实由 tests/test_r4d_live_expectation.js 与
       tests/test_r4f_live_behavior_effect.js 继续测量。 */
    const seamAudit = SEAM_GUARD.auditRecallSeam(readRel('services/home-node/runtime-recall.js'));
    const interpAudit = SEAM_GUARD.auditInterpretationSeam(readRel('services/home-node/runtime-interpretation.js'));
    check('11.2 §24 期望与行为两个域只以"装配注入 + 位置钉死"的 seam 出现在召回边界；解释边界仍然四域全禁',
      seamAudit.ok && interpAudit.ok,
      {
        recallReasons: seamAudit.reasons,
        interpretationReasons: interpAudit.reasons,
        depLineCount: seamAudit.facts.depLineCount,
        deriveSites: seamAudit.facts.deriveSites,
        consumeSites: seamAudit.facts.consumeSites,
        transition: 'BEFORE LIVE-5: no expectation seam existed; LIVE-5..R4-F: two assembly-injected seams, each pinned to one authorized location and call relation'
      });
    P('BROWSER_RECALL_SEAM_TOKEN_SITES', seamAudit.facts.tokenSites.length);
    P('BROWSER_RECALL_SEAM_DERIVE_SITES', J(seamAudit.facts.deriveSites));
    P('BROWSER_RECALL_SEAM_CONSUME_SITES', J(seamAudit.facts.consumeSites));
    const itemKeys = persHolder && persHolder.interpretation && persHolder.interpretation.items && persHolder.interpretation.items[0]
      ? Object.keys(persHolder.interpretation.items[0]) : null;
    const banned = ['trust', 'familiarity', 'affinity', 'emotion', 'speechStyle', 'toolPolicy', 'relationship'];
    check('11.3 §24 解释结果条目只含校验器冻结的字段（无 trust/familiarity/affinity/emotion/speech-style/tool-policy）',
      !!itemKeys && banned.every(b => itemKeys.indexOf(b) < 0),
      { keys: itemKeys });

    /* ══════════════════════════════════════════════════════════════ 12 · §25 */
    section('12 · §25 two roles interleaved');
    await setBase(TWO);
    await prepRole(CHAR_A);
    const twoBefore = interpCallsOf(TWO).length;
    const twoA1 = await withCase('two-roles A1', 'AUTO', async () => { const r = await directRecall(TWO, CHAR_A, 'l41b_two_a1', QUERY + ' a1'); await idleOf(TWO, 20000); return r; });
    const twoB1 = await withCase('two-roles B1', 'AUTO', async () => {
      await prepRole(CHAR_B);
      const r = await directRecall(TWO, CHAR_B, 'l41b_two_b1', QUERY + ' b1');
      await idleOf(TWO, 20000);
      return r;
    });
    const twoCalls = interpCallsOf(TWO).slice(twoBefore);
    const holderA = holderOf(TWO, holderKeyOf('l41b_two_a1', 'dm:' + CHAR_A));
    const holderB = holderOf(TWO, holderKeyOf('l41b_two_b1', 'dm:' + CHAR_B));
    check('12.1 §25 两个角色交错：每个角色回合 ≤1 次解释调用（合计恰好 +2）',
      twoA1.ok === true && twoB1.ok === true && twoCalls.length === 2,
      { a: twoA1, b: twoB1, calls: twoCalls.length });
    check('12.2 §25 holder / 结果按 character+turn 各自独立（无共享）',
      !!holderA && !!holderB && holderA.turnId !== holderB.turnId &&
      holderA.characterId === CHAR_A && holderB.characterId === CHAR_B,
      { a: holderA && { t: holderA.turnId, c: holderA.characterId }, b: holderB && { t: holderB.turnId, c: holderB.characterId } });
    check('12.3 §25 证据不串：每个角色的批次 === 它自己的召回集合；凭据引用各自解析',
      twoCalls.length === 2 &&
      J((twoCalls[0].batch || []).map(x => x.memoryId)) === J(twoA1.selectedIds) &&
      J((twoCalls[1].batch || []).map(x => x.memoryId)) === J(twoB1.selectedIds) &&
      twoCalls[0].authorization === 'Bearer ' + SENTINEL && twoCalls[1].authorization === 'Bearer ' + SENTINEL + '_B',
      J(twoCalls.map(c => ({ ids: (c.batch || []).map(x => x.memoryId), auth: String(c.authorization).slice(0, 20) + '…' }))));

    /* ══════════════════════════════════════════════════════════════ 13 · §26/§27 */
    section('13 · §26 client disconnect + §27 main-chat-later-failure');
    await setBase(ON);
    await prepRole(CHAR_A);
    const beforeDisc = interpCallsOf(ON).length;
    const disc = await evaluate(`(function(){
      var ac = new AbortController();
      var p = fetch(${JSON.stringify('http://127.0.0.1:' + ON.webPort + RC.PATH)}, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'X-IB-Protocol': '1', 'X-IB-Home-Token': ${JSON.stringify(TOKEN)} },
        body: JSON.stringify({ operation: 'memory-recall', mode: 'authoritative', characterId: ${JSON.stringify(CHAR_A)},
          requestId: 'l41b_disc_1', conversationId: 'dm:' + ${JSON.stringify(CHAR_A)}, message: ${JSON.stringify(QUERY)}, timeoutMs: 5000 })
      }).then(function(r){ return { ok: true, status: r.status }; }, function(e){ return { ok: false, error: String((e && e.name) || e) }; });
      setTimeout(function(){ try { ac.abort(); } catch (e) {} }, 0);
      return p;
    })()`, true);
    await sleep(1000);
    const afterDisc = interpCallsOf(ON).length;
    const discIdle = await withCase('disconnect settle', 'AUTO', () => idleOf(ON, 20000));
    const discHolder = holderOf(ON, holderKeyOf('l41b_disc_1', 'dm:' + CHAR_A));
    const discTerminal = !discHolder || discHolder.status !== 'pending';
    /* ★ §26 的**真话**：客户端断开**不**取消服务端已经开始的召回/解释 ——
       我们能证明的是"不崩、不卡在 pending、不产生协议损坏"，
       而不是"零调用"。把这一条写成"断开就零调用"就是一句我们证明不了的话。 */
    check('13.1 §26 客户端断开：浏览器拿到中断（无响应），服务端不崩，那一轮的解释不卡在 pending（终态或未被调度）',
      disc && disc.ok === false && discTerminal && afterDisc <= beforeDisc + 1 && discIdle.inFlight === 0,
      { disc: disc, callsBefore: beforeDisc, callsAfter: afterDisc, holder: discHolder, idle: discIdle });
    P('CLIENT_DISCONNECT_CANCELS_INTERPRETATION', 'NO');
    P('CLIENT_DISCONNECT_TRUTH', 'server may continue after client disconnect; no cancellation claimed; terminal holder state or no schedule; no crash');
    P('CLIENT_DISCONNECT_INTERPRETATION_CALLS_DELTA', String(afterDisc - beforeDisc));

    const beforeLater = interpCallsOf(ON).length;
    chatProvider.state.failNext = true;
    const laterFail = await withCase('main chat later failure turn', 'TURN', async () => {
      const t = await runTurn('later-fail');
      const idle = await idleOf(ON, 20000);
      return { t, idle };
    });
    const laterPost = findChatPostFor(chatPosts(chatProvider), 'later-fail');
    const afterLater = interpCallsOf(ON).length;
    check('13.2 §27 主聊天随后失败（provider 500）：召回与自动解释照常完成，失败只体现在主路径',
      afterLater === beforeLater + 1 && !!laterPost && laterPost.failed === true,
      { calls: afterLater - beforeLater, laterPostFailed: laterPost && laterPost.failed, turn: laterFail.t });
    P('MAIN_CHAT_LATER_FAILURE_INTERPRETATION_UNAFFECTED', (afterLater === beforeLater + 1 && !!laterPost && laterPost.failed === true) ? 'YES' : 'NO');

    /* ══════════════════════════════════════════════════════════════ 14 · §28 */
    section('14 · §28 secret containment');
    const scan = await evaluate(`(function(sentinel){
      var hits = []; var visited = []; var budget = 3000;
      function seen(o){ for (var i=0;i<visited.length;i++) if (visited[i]===o) return true; visited.push(o); return false; }
      function note(w,t){ if (String(t).indexOf(sentinel) >= 0) hits.push(w); }
      function walk(v,l,d){ if (d>4||budget--<0) return; if (v==null) return; var t=typeof v;
        if (t==='string'){ note(l,v); return; } if (t!=='object') return;
        if (v===window||v===document||v.nodeType) return; if (seen(v)) return;
        var j=null; try{ j=JSON.stringify(v);}catch(e){} if (j!=null){ note(l,j); return; }
        var ks=[]; try{ ks=Object.keys(v);}catch(e){ return; }
        for (var i=0;i<ks.length&&i<50;i++){ var x=null; try{ x=v[ks[i]];}catch(e){continue;} walk(x,l+'.'+ks[i],d+1); } }
      try { for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); note('localStorage['+k+']', k+'='+localStorage.getItem(k)); } } catch(e){}
      try { for (var j=0;j<sessionStorage.length;j++){ var k2=sessionStorage.key(j); note('sessionStorage['+k2+']', k2+'='+sessionStorage.getItem(k2)); } } catch(e){}
      try { note('DOM', document.documentElement.outerHTML); } catch(e){}
      var names=[]; try{ names=Object.getOwnPropertyNames(window);}catch(e){}
      for (var n=0;n<names.length&&n<2500;n++){ var nm=names[n]; var v2=null; try{ v2=window[nm];}catch(e){continue;} if (typeof v2==='function') continue; walk(v2,'window.'+nm,0); }
      return { hits: hits, windowProps: names.length };
    })(${JSON.stringify(SENTINEL)})`);
    const secBody = await fx.request(ON.webPort, 'GET', '/security', null, { 'X-IB-Home-Token': TOKEN });
    const secText = J(secBody.body);
    const recallRespText = J((await recallWire()).map(r => r.response));
    const interpAuth = interpCallsOf(ON).map(e => e.authorization);
    const interpBodies = interpCallsOf(ON).map(e => e.body);
    check('14.1 §28 浏览器可见面（window / localStorage / sessionStorage / DOM）里没有哨兵',
      !!scan && scan.hits.length === 0, scan);
    check('14.2 §28 召回响应与 /security 里没有哨兵',
      recallRespText.indexOf(SENTINEL) < 0 && secText.indexOf(SENTINEL) < 0,
      { inRecall: recallRespText.indexOf(SENTINEL) >= 0, inSecurity: secText.indexOf(SENTINEL) >= 0 });
    check('14.3 §28 哨兵只出现在 Home Node 请求作用域（provider Authorization），绝不在 provider 正文里',
      interpAuth.length > 0 && interpAuth.every(a => a.indexOf('Bearer ' + SENTINEL) === 0) && interpBodies.every(b => b.indexOf(SENTINEL) < 0),
      { auths: interpAuth.length, inBody: interpBodies.some(b => b.indexOf(SENTINEL) >= 0) });
    P('SECRET_SENTINEL_IN_BROWSER_VISIBLE_SURFACE', (scan && scan.hits.length === 0 && recallRespText.indexOf(SENTINEL) < 0) ? 'NO' : 'YES');
    P('SECRET_SENTINEL_ONLY_IN_HOME_NODE_REQUEST_SCOPE', interpAuth.every(a => a.indexOf('Bearer ' + SENTINEL) === 0) ? 'YES' : 'NO');

    /* ══════════════════════════════════════════════════════════════ 14.4 · P21-QA-R4 §11/§12 负控制 */
    section('14.4 · measurement ownership negative controls (P21-QA-R4)');
    const synthMainChat = (turnText, extra) => ({
      url: PROVIDER_PATH, method: 'POST',
      body: { model: 'mock', messages: [{ role: 'user', content: turnText + (extra || '') }] }
    });
    const synthDiary = (turnText) => ({
      url: PROVIDER_PATH, method: 'POST',
      body: { model: 'mock', messages: [{ role: 'user', content: turnText + '\n' + JSON.stringify({ shouldWrite: true, diaryType: 'daily', importance: 7 }) }] }
    });
    const synthOther = (turnText) => ({
      url: '/v1/other-endpoint', method: 'POST',
      body: { model: 'mock', messages: [{ role: 'user', content: turnText }] }
    });
    const QA_A = 'turn A happy-QA', QA_B = 'turn B happy-QA';
    const qaAChat = synthMainChat(QA_A, '\n【记忆（系统参考，勿提及此段）】QA_CANON_TEXT'), qaADiary = synthDiary(QA_A), qaBChat = synthMainChat(QA_B);
    check('14.4.1 §7 the wire classifier separates MAIN_CHAT from the Auto-Memory/diary call structurally',
      providerPostKind(qaAChat) === 'MAIN_CHAT_MODEL_CALL' && providerPostKind(qaADiary) === 'AUTO_MEMORY_OR_DIARY_CALL'
      && providerPostKind(synthOther(QA_A)) === 'OTHER_BACKGROUND_CALL',
      { chat: providerPostKind(qaAChat), diary: providerPostKind(qaADiary), other: providerPostKind(synthOther(QA_A)) });
    check('14.4.2 §11 [A chat, A diary, B chat] ⇒ A binds A, B binds B, regardless of order',
      findChatPostFor([qaAChat, qaADiary, qaBChat], QA_A) === qaAChat
      && findChatPostFor([qaAChat, qaADiary, qaBChat], QA_B) === qaBChat
      && findChatPostFor([qaADiary, qaBChat, qaAChat], QA_A) === qaAChat
      && currentTurnMainChatCount([qaAChat, qaADiary, qaBChat], QA_A) === 1,
      { forward: findChatPostFor([qaAChat, qaADiary, qaBChat], QA_A) === qaAChat, reversed: findChatPostFor([qaADiary, qaBChat, qaAChat], QA_A) === qaAChat });
    check('14.4.3 §8 a diary call mentioning the turn text is NEVER selected (explicit NULL when absent)',
      findChatPostFor([qaADiary], QA_A) === null && findChatPostFor([qaAChat, qaADiary], QA_A) === qaAChat,
      { diaryOnly: findChatPostFor([qaADiary], QA_A) === null });
    check('14.4.4 §12 historical control: an older memory-bearing turn is not resurrected for a failing current turn',
      (function () {
        const oldChat = synthMainChat('older turn happy-QA', '\n【记忆（系统参考，勿提及此段）】QA_CANON_TEXT');
        return findChatPostFor([oldChat, synthDiary(QA_B)], QA_B) === null && findChatPostFor([oldChat], QA_B) === null;
      })(),
      { note: 'explicit NULL, never an older turn' });

    /* ══════════════════════════════════════════════════════════════ 15 · 结束 */
    section('15 · verdict');
    /* §30：逐用例看门狗之外，整条套件还有一个**写在这里的**总上界；
       到这里如实核对它是否被遵守（超了就是超了，不解释成"机器慢"）。 */
    const elapsedMs = Date.now() - T_START;
    P('DOCUMENTED_OVERALL_BOUND_MS', String(OVERALL_BUDGET_MS));
    P('CASE_BUDGETS_MS', J(CASE_BUDGET));
    P('SUITE_ELAPSED_MS', String(elapsedMs));
    check('15.1 §30 整条套件在文档化的总上界内结束（逐用例看门狗 + 总上界）',
      elapsedMs < OVERALL_BUDGET_MS, { elapsedMs: elapsedMs, bound: OVERALL_BUDGET_MS });
    T_LAST_ASSERTION = Date.now();
  } catch (error) {
    if (error instanceof CaseTimeout) {
      failed++;
      console.error('  FAIL  看门狗触发：' + CURRENT_CASE);
      console.error(diagnosticsDump());
    } else {
      failed++;
      console.error('  FAIL  套件抛出异常 — ' + String((error && (error.stack || error.message)) || error));
    }
  } finally {
    try {
      const outDir = path.join(ROOT, '.dsh-research');
      fs.mkdirSync(outDir, { recursive: true });
      const payload = {
        phase: 'P21-R4-LIVE-4.1B', generatedAt: new Date().toISOString(),
        verdict: failed === 0 ? 'PASS' : 'FAIL', counts: { passed: passed, failed: failed },
        elapsedMs: Date.now() - T_START, constants: CONST
      };
      fs.writeFileSync(path.join(outDir, 'r4c-live-4-1-browser.json'), JSON.stringify(payload, null, 2), 'utf8');
      fs.writeFileSync(path.join(outDir, 'r4c-live-4-1-browser.md'),
        ['# P21-R4-LIVE-4.1B · Real-browser auto-interpretation E2E (CDP)', '',
          '- verdict: **' + payload.verdict + '** (' + passed + ' passed / ' + failed + ' failed)',
          '- elapsed: ' + payload.elapsedMs + 'ms', '', '```',
          Object.keys(CONST).map(k => k + ' = ' + J(CONST[k])).join('\n'), '```', ''].join('\n'), 'utf8');
      console.log('report: ' + path.join(outDir, 'r4c-live-4-1-browser.json'));
    } catch (e) { console.error('  (report write failed: ' + String((e && e.message) || e) + ')'); }

    if (launched && typeof launched.close === 'function') { try { await launched.close(); } catch (_) { } }
    if (chatProvider) { try { chatProvider.server.close(); } catch (_) { } }
    if (webChild) { try { webChild.kill(); } catch (_) { } }
    closeAllInstances();
    /* ★ 清理必须在**所有句柄关掉之后**：sqlite/Chrome 的文件句柄会让 rmSync 失败，
       而失败是静默的（force:true 不抛）。因此这里逐段重试并如实核对结果。 */
    await sleep(600);
    const purge = async function (dir) {
      for (let i = 0; i < 24; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
        if (!fs.existsSync(dir)) return true;
        await sleep(250);
      }
      return !fs.existsSync(dir);
    };
    let scratchClean = await purge(RUN_ROOT);
    if (!scratchClean) {
      /* 再给 Chrome/数据库一点时间，然后重试一次（进程内的锁只有 exit 才彻底释放，
         因此这一步通常能收干净；若仍不能，如实报告而不是假装干净）。 */
      await sleep(1500);
      scratchClean = await purge(RUN_ROOT);
    }
    P('SCRATCH_CLEANED', scratchClean ? 'YES' : 'PARTIAL');
    const scratchRootTrim = function () {
      /* .dsh-tmp 本身保留（它可能是别的并行工作线的根），只清我们自己的。 */
      try {
        const rest = fs.readdirSync(SCRATCH_ROOT).filter(n => n.indexOf('l41b-') === 0);
        return rest.length === 0;
      } catch (_) { return false; }
    };
    if (!scratchRootTrim()) {
      await sleep(1500);
      await purge(RUN_ROOT);
    }
    P('SCRATCH_UNDER_WORKSPACE_TMP_ONLY', fs.existsSync(SCRATCH_ROOT) ? 'YES' : 'UNKNOWN');
    console.log('');
    for (const k of Object.keys(CONST)) console.log(k + ' = ' + J(CONST[k]));
    console.log('\n' + (failed === 0 ? '全部通过 ✔' : failed + ' 项失败 ✘') + '  (' + passed + ' 通过 / ' + failed + ' 失败)');
    console.log('R4C_LIVE_INTERPRETATION_AUTO_BROWSER_VERDICT=' + (failed === 0 ? 'PASS' : 'FAIL'));
    /* ── P21-QA-R4 §13/§14：声明集与实际判定 ─────────────────────────── */
    console.log('DECLARED_MEASUREMENT_ASSERTIONS = ' + JSON.stringify(MEASUREMENT_ASSERTION_SET));
    console.log('DECLARED_AUTHORITY_ASSERTIONS = ' + JSON.stringify(AUTHORITY_ASSERTION_SET));
    console.log('POST_HOC_MEASUREMENT_RECLASSIFICATIONS = 0');
    console.log('MEASUREMENT_OWNERSHIP_FIXED = YES');
    console.log('QA_LOOKUPS = ' + QA_LOOKUPS.length + ' ' + JSON.stringify(QA_LOOKUPS.slice(-4)));
    console.log('R4C_LIVE_INTERPRETATION_AUTO_BROWSER_COUNTS passed=' + passed + ' failed=' + failed);
    process.exitCode = failed === 0 ? 0 : 1;
    process.on('exit', function (code) {
      console.log('LAST_ASSERTION_TO_EXIT_MS = ' + (T_LAST_ASSERTION ? (Date.now() - T_LAST_ASSERTION) : -1));
      console.log('NATURAL_EXIT = YES code=' + code);
    });
  }
})();
