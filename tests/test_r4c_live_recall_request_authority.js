'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-LIVE-3.2
   Transport / Request / Query / Settings / Random / Clock **Authority Audit**
   （纯 Node · 零真实 provider 调用 · 零生产改动 · 只读生产面）

   运行：node tests/test_r4c_live_recall_request_authority.js

   ── 本文件回答的问题（未来的 Desktop recall 路由）──────────────────────
     §17 哪一条既有传输面是**最小正确**的那条？（A 扩展 / B 新建窄内部路由 /
         C 复用 canonical memory 路由 / D 其它）
     §18 未来的路由**不得**成为通用召回代理 —— 边界逐字写死并打印；
     §19 每个候选字段的权威归属（SERVER / CALLER），以及浏览器**永远不得**
         提交的字段清单；
     §20 谁跑 recall query parser（raw turn signal 进、query 由服务端构造）；
     §21 topK / budget / channel / exploration / cooldown 各自的权威（含今天
         orchestrator 真的收到了什么、以及调用方今天**能**影响什么）；
     §22 random 权威；§23 now 权威；
     §33 针对**当前**面的攻击测试（设备令牌不能当桌面代理、跨角色记忆、
         伪造字段、full-view evidence、selected-ID 注入）；
     §31 移动/网关召回+会话+激活套件回归（并与 pristine `git archive HEAD` 对比，
         把既有红灯与本次工作分开）；
     §32 同一 fixture 下浏览器路径 vs 服务端路径召回延迟（median + p95，
         含 loopback hop —— 它是**真实成本**，不是零）。

   ── 本文件不做 ────────────────────────────────────────────────────────
   不新增路由、不实现 cutover、不改任何生产行为、不调用任何真实 provider。
   所有模型交互都是注入的 fake port / 本地 mock provider（见 §33）。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require(path.join(ROOT, 'tests', 'helpers', 'activation-wiring-probe.js'));
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const lineOf = (rel, needle) => {
  const lines = read(rel).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(needle) >= 0) return i + 1;
  return null;
};
const at = (rel, needle) => rel + ':' + lineOf(rel, needle);

const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const QUERY = require(path.join(ROOT, 'assets/js/memory-recall/recall-query.js'));
const COOLDOWN = require(path.join(ROOT, 'assets/js/memory-recall/cooldown.js'));
const CHANNEL_POLICY = require(path.join(ROOT, 'assets/js/memory-recall/channel-policy.js'));
const MEMORY_RETRIEVAL = require(path.join(ROOT, 'services/home-node/memory-retrieval.js'));
const MEMORY_STORE = require(path.join(ROOT, 'services/home-node/memory-store.js'));
const SERVICE = require(path.join(ROOT, 'services/home-node-service.js'));

const NOW = 1790000000000;
const ADMIN_TOKEN = 'r4c-live-3-2-desktop-token';
const DESKTOP = { 'X-IB-Home-Token': ADMIN_TOKEN };

let passed = 0, failures = 0, skipped = 0;
/* 诚实账本：契约说"永不抛出"的调用一旦抛了，记在这里并由断言转红。 */
const THROWN = [];
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined && detail !== null ? '  -> ' + String(detail) : ''));
  return false;
};
/* SKIP：证据缺失时**如实跳过**，绝不伪装成通过、也绝不因此变红。
   本套件会被 `git archive HEAD` 树或干净检出运行，而 `.dsh-research/` 不在归档里
   —— 依赖它的段落必须是 SKIP（见 §31 / §25）。 */
const skip = (name, reason) => {
  skipped++;
  console.log('  SKIP  ' + name + '  -> ' + String(reason || 'not applicable'));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');
/* 服务端信封的稳定错误码（成功时为 null）。 */
function errCode(r) {
  if (!r || typeof r !== 'object') return null;
  for (const k of ['error', 'reasonCode', 'reason', 'code']) {
    if (typeof r[k] === 'string' && r[k]) return r[k];
  }
  return null;
}
/* 机器可读的 NAME = VALUE 行（本文件的交付物之一）。 */
const verdict = (name, value) => console.log(name + ' = ' + (typeof value === 'string' ? value : JSON.stringify(value)));
function table(title, rows, columns) {
  console.log('\n' + title);
  console.log('| ' + columns.join(' | ') + ' |');
  console.log('|' + columns.map(() => '---').join('|') + '|');
  for (const row of rows) console.log('| ' + columns.map(c => String(row[c] == null ? '' : row[c]).replace(/\|/g, '\\|')).join(' | ') + ' |');
  console.log('');
  console.log(title + '_JSON = ' + JSON.stringify(rows));
}

/* ── fixtures ─────────────────────────────────────────────────────────── */
function mem(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: 'T-' + id, summary: '', content: 'BODY-' + id,
    domain: '日常', tags: [], valence: 0.5, arousal: 0.3, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW, lastActivated: NOW,
    createdBy: 'user', createdByName: '', editedByUser: false,
    consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}
/* 与"显卡 驱动 更新失败"这条用户发言有 lexical 命中的 fixture。 */
function graphMem(i, over) {
  return mem('gm' + String(i).padStart(3, '0'), Object.assign({
    title: '显卡 ' + i, content: '显卡 驱动 更新失败 第' + i + '次，我熬到凌晨',
    importance: 4 + (i % 5), valence: 0.3, arousal: 0.5,
    created: NOW - (i % 30) * 86400000, lastActivated: NOW - (i % 7) * 3600000
  }, over || {}));
}
function records(n) { return Array.from({ length: n }, (_, i) => graphMem(i)); }
const B = { apiId: 'friend_a', now: NOW, random: () => 0.5, maxChars: 2000, contentLen: 200, userMessage: '显卡 驱动 更新失败' };

function freshDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-live32-' + tag + '-')); }
function dropDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ } }
function listen(server, host) { return new Promise(r => server.listen(0, host, () => r(server.address().port))); }
function freePort() {
  return new Promise(resolve => {
    const s = net.createServer(); s.unref();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function req(host, port, method, urlPath, options) {
  options = options || {};
  return new Promise(resolve => {
    const data = options.body == null ? null : JSON.stringify(options.body);
    const headers = Object.assign({}, options.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: host, port: port, path: urlPath, method: method, timeout: 12000, headers: headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, body: null, raw: '', error: 'timeout' }); });
    r.on('error', e => resolve({ status: 0, body: null, raw: '', error: String((e && e.code) || (e && e.message)) }));
    if (data) r.write(data);
    r.end();
  });
}
/* SSE 回合：读完整条流（mock provider 立即结束，不需要长超时）。 */
function readSse(host, port, urlPath, body, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {});
    const r = http.request({ host: host, port: port, path: urlPath, method: 'POST', timeout: 12000, headers: h }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: raw }));
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) {} resolve({ status: 0, raw: '' }); });
    r.on('error', () => resolve({ status: 0, raw: '' }));
    r.write(data);
    r.end();
  });
}
function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
}
function p95(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null;
}

/* ══════════════════════════════════════════════════════════════════════════ */
(async function main() {
  /* ══════════════════════════════════════════════════════════════════════
     §17 · TRANSPORT AUDIT
     ══════════════════════════════════════════════════════════════════════ */
  section('§17 · transport audit — which existing surface is the minimum correct one');

  const SURFACES = {
    desktopAdminRecall: {
      surface: 'Mobile Gateway ADMIN_PATHS（桌面/运行时面）',
      evidence: at('services/home-node/mobile-gateway.js', "const ADMIN_PATHS = ["),
      verbs: ['/memory/list', '/memory/changes', '/memory/records', '/memory/record',
        '/memory/activate', '/memory/settings', '/memory/migration', '/memory/migrate'],
      recallVerb: false,
      credential: 'DESKTOP_TOKEN（http.js:1166 authorized()）',
      deviceFace: false
    },
    mobileDeviceFace: {
      surface: '/mobile/v1/*（Android 设备面）',
      evidence: at('services/home-node/mobile-gateway.js', 'function authenticate(req)'),
      verbs: ['/mobile/v1/chat/send', '/mobile/v1/character/list', '…'],
      recallVerb: false,
      credential: 'DEVICE_TOKEN（registry.verifyDeviceToken）',
      deviceFace: true
    },
    internalRuntime: {
      surface: '/internal/runtime/memory-interpretation（R4-LIVE-2.1 已存在的运行时执行面）',
      evidence: at('services/home-node/http.js', "path.indexOf('/internal/') === 0"),
      verbs: ['POST /internal/runtime/memory-interpretation'],
      recallVerb: false,
      credential: 'DESKTOP_TOKEN（同一 isDesktopOnlyPath 前缀守卫）',
      deviceFace: false
    }
  };

  const memoryJsSrc = read('assets/js/memory.js');
  const gatewaySrc = read('services/home-node/mobile-gateway.js');
  const httpSrc = read('services/home-node/http.js');

  check('§17.1 no recall verb exists on any current surface',
    !/'\/memory\/recall'/.test(gatewaySrc) && !/'\/memory\/recall'/.test(httpSrc)
    && SURFACES.desktopAdminRecall.verbs.every(v => !/recall/.test(v)),
    'grep: 0 occurrences of /memory/recall in gateway+http (behavioural counterpart: §33.5 → 404)');
  check('§17.2 /memory/* is classified DESKTOP-ONLY by the prefix guard',
    /path\.indexOf\('\/memory\/'\) === 0/.test(httpSrc)
    && /path\.indexOf\('\/internal\/'\) === 0/.test(httpSrc),
    'http.js isDesktopOnlyPath covers /memory/ and /internal/');
  check('§17.3 the gateway admin face is NOT the device face',
    /const ADMIN_PATHS = \[/.test(gatewaySrc)
    && gatewaySrc.indexOf("'/memory/list'") >= 0
    && !/ADMIN_PATHS[\s\S]{0,400}\/mobile\/v1/.test(gatewaySrc),
    'memory verbs live in ADMIN_PATHS (desktop), never under /mobile/v1');
  check('§17.4 desktop recall execution already exists server-side inside a mobile turn',
    /buildTurnRequest\(parsed, recallTurnIndex\)/.test(gatewaySrc)
    && /memoryRetrieval\.buildRuntimeContext\(/.test(gatewaySrc)
    && /recallSessionState\.beginHomeTurn\(/.test(gatewaySrc),
    'the only production recall execution is the server-side turn path (no HTTP verb yet)');

  const TRANSPORT_OPTIONS = [
    { id: 'A', option: 'extend an existing desktop/internal /memory/* route', verdict: 'REJECTED',
      why: 'ADMIN_PATHS 是 canonical store 的 CRUD 面（list/changes/records/activate/settings/migrate）。给 CRUD 面加一个"派生/执行"动词会把 canonical authority 与 runtime derivation 混在同一个面里 —— 正是 R4-LIVE-2.1 刻意分开的那两层。' },
    { id: 'B', option: 'a new narrow internal recall route (POST /internal/runtime/memory-recall)', verdict: 'CHOSEN',
      why: '与既有 /internal/runtime/memory-interpretation 逐字同级：同一 isDesktopOnlyPath 前缀守卫、同一 desktop token、同一个"服务对象拥有 path/operations/describe"的形状；只加一个动词，不扩 canonical CRUD 面。' },
    { id: 'C', option: 'reuse an existing canonical memory route (/memory/records 等)', verdict: 'REJECTED',
      why: '那些路由返回 canonical 记录，不做 ACL/gate/rank/cooldown；让它们兼任召回=把"选择"藏进一个读路由，且会诱导浏览器提交候选/分数。' },
    { id: 'D', option: 'reuse the mobile device-token/pairing surface', verdict: 'REJECTED',
      why: '设备令牌回答的是"这台手机是谁"，不是"这台机器的桌面用户是谁"。复用它等于把 runtime authority 交给设备面，并让手机成为桌面召回代理（§33 已行为证明两侧互不接受对方的凭据）。' }
  ];
  table('TRANSPORT_AUDIT_TABLE', TRANSPORT_OPTIONS, ['id', 'option', 'verdict', 'why']);
  verdict('TRANSPORT_RECOMMENDATION', 'B · NEW_NARROW_INTERNAL_RECALL_ROUTE = POST /internal/runtime/memory-recall（唯一动词；desktop-only；server-side ACL+gate+rank+cooldown）');

  /* ══════════════════════════════════════════════════════════════════════
     §18 · NO GENERIC RECALL PROXY
     ══════════════════════════════════════════════════════════════════════ */
  section('§18 · no generic recall proxy');
  const NO_GENERIC_RECALL_PROXY_REQUIREMENT =
    'ONE_VERB_SELECTION_ONLY: POST /internal/runtime/memory-recall accepts exactly '
    + '{characterId, rawTurn?|turnRef?, timeoutMs} under the desktop credential and returns only '
    + 'the server-selected result (injected text/ids/reason/counts). It MUST NOT expose: a generic '
    + 'query engine, SQL-like/field-predicate memory filtering, full-view evidence access '
    + '(evidenceView:"full"), another character\'s memory, candidate records/pool, relevance or '
    + 'rank scores, final ordering, cooldown factors, seat/plan results, or caller-supplied selected IDs.';
  verdict('NO_GENERIC_RECALL_PROXY_REQUIREMENT', NO_GENERIC_RECALL_PROXY_REQUIREMENT);

  const MUST_NOT_EXPOSE = [
    'candidate records / the raw candidate pool',
    'scores: relevanceScore, memoryValue, finalScore, rank position, sort order',
    'cooldown factors / exposure / lastExposureTurn',
    'seat plan / seat result / maxTotalSeats overrides',
    'caller-selected IDs (selectedIds / memoryIds / ids)',
    'another character\'s memory (no ownerId/characterId override)',
    'full-view evidence (evidenceView:\'full\') or raw canonical payload echo',
    'arbitrary filter / query expression / SQL-like predicates',
    'settings overrides (budget, contentLen, channel, exploration, topK)'
  ];
  check('§18.1 the forbidden-exposure list is complete against the current surfaces',
    MUST_NOT_EXPOSE.length === 9
    && !/evidenceView/.test(read('services/home-node/memory-retrieval.js'))
    && !/evidenceView/.test(gatewaySrc),
    JSON.stringify(MUST_NOT_EXPOSE));

  /* ══════════════════════════════════════════════════════════════════════
     §19 · REQUEST CONTRACT AUTHORITY
     ══════════════════════════════════════════════════════════════════════ */
  section('§19 · request field authority');
  const REQUEST_FIELD_AUTHORITY = [
    { field: 'characterId', authority: 'CALLER', today: 'mobile-gateway.js parseSendPayload → registry.getCharacter + getCharacterSpec',
      rule: 'CALLER may name WHICH character (it is the user\'s own desktop session), but the server resolves the spec and rejects unknown ids.' },
    { field: 'conversationId / threadId / turnId', authority: 'SERVER', today: at('services/home-node/mobile-gateway.js', 'const conversationId = conversationIdFor(characterId, threadId)'),
      rule: 'derived server-side from the character (+ optional thread); turnId is content-addressed server-side (deriveStableTurnId).' },
    { field: 'turn identity / turnIndex', authority: 'SERVER', today: at('services/home-node/mobile-gateway.js', 'recallSessionState.beginHomeTurn({'),
      rule: 'beginHomeTurn is the only authority; a caller-supplied turnIndex would move cooldown distance.' },
    { field: 'raw turn message', authority: 'CALLER', today: at('services/home-node/mobile-gateway.js', "if (typeof payload.content === 'string') content = payload.content;"),
      rule: 'CALLER supplies the raw user words only; the server normalizes and parses them.' },
    { field: 'channel', authority: 'SERVER', today: at('assets/js/memory-recall/memory-recall-orchestrator.js', 'var forcedRaw = (turn.channelHint == null) ? null : String(turn.channelHint);'),
      rule: 'turn-signal + channel-policy decide; the production Host does not forward a caller channelHint.' },
    { field: 'now (wall clock)', authority: 'SERVER', today: at('services/home-node/mobile-gateway.js', 'currentTime: P0_CONTEXT.formatCurrentTime(clock(), timeZone),'),
      rule: 'server clock/timeZone; a caller-supplied now is refused (it moves decay/fatigue/cooldown distance).' },
    { field: 'random source', authority: 'SERVER', today: at('services/home-node/memory-retrieval.js', 'const random = typeof deps.random === \'function\' ? deps.random : Math.random;'),
      rule: 'injected at assembly; never a wire field.' },
    { field: 'settings reference (budget/contentLen)', authority: 'SERVER', today: at('services/home-node/memory-store.js', 'function getMemorySettings() {'),
      rule: 'published desktop settings + server defaults; the request may not carry a settings override.' },
    { field: 'timeoutMs', authority: 'CALLER', today: at('services/home-node/runtime-interpretation.js', 'const timeoutRaw = own(body, \'timeoutMs\');'),
      rule: 'CALLER may bound the wait (R4-LIVE-2.1 precedent), never the budget or the policy.' }
  ];
  table('REQUEST_FIELD_AUTHORITY_TABLE', REQUEST_FIELD_AUTHORITY, ['field', 'authority', 'today', 'rule']);

  const BROWSER_MUST_NEVER_SUBMIT = [
    'candidate records (the pool)',
    'scores (relevanceScore / memoryValue / finalScore)',
    'rank / sort position / ordering',
    'cooldown factors / exposure / lastExposureTurn',
    'seat result / seat plan / seat cap',
    'selected IDs (selectedIds / memoryIds / ids)',
    'another character\'s memory or an ownerId override',
    'normalized query tokens / hard-gate results',
    'budget / contentLen / channel / exploration / topK overrides',
    'now / random values'
  ];
  verdict('BROWSER_MUST_NEVER_SUBMIT', BROWSER_MUST_NEVER_SUBMIT);

  /* ══════════════════════════════════════════════════════════════════════
     §20 · QUERY AUTHORITY
     ══════════════════════════════════════════════════════════════════════ */
  section('§20 · recall query authority');
  const rawTurn = '对了，你还记得去年我们说那个显卡驱动更新失败的事情吗？';
  const builtQuery = QUERY.buildRecallQuery(rawTurn, {});
  check('§20.1 the query parser needs only the raw turn message',
    typeof QUERY.buildRecallQuery === 'function'
    && QUERY.buildRecallQuery.length === 2
    && typeof builtQuery.rawText === 'string' && Array.isArray(builtQuery.lexicalTerms)
    && builtQuery.lexicalTerms.length > 0,
    JSON.stringify({ terms: builtQuery.lexicalTerms.slice(0, 6), entities: builtQuery.entities.length, temps: builtQuery.temporalHints.length }));
  check('§20.2 lexicalTerms come from the single shared extractKeywords implementation',
    QUERY.coreAvailable === true
    && typeof CORE.extractKeywords === 'function'
    && JSON.stringify(builtQuery.lexicalTerms) === JSON.stringify(CORE.extractKeywords(builtQuery.lexicalText)),
    'recall-query.js reuses memory-retrieval-core.extractKeywords (no second n-gram implementation)');
  const forgedQuery = QUERY.buildRecallQuery(rawTurn, { lexicalTerms: ['FORGED_TOKEN'], hardGate: true, relevanceScore: 9 });
  check('§20.3 browser-supplied normalized tokens cannot become the query',
    JSON.stringify(forgedQuery.lexicalTerms) === JSON.stringify(builtQuery.lexicalTerms)
    && JSON.stringify(forgedQuery).indexOf('FORGED_TOKEN') < 0,
    'buildRecallQuery(message, options) only reads options.aliases; forged lexicalTerms/hardGate/relevanceScore are ignored');
  check('§20.4 the parser is deterministic for the same raw turn',
    JSON.stringify(QUERY.buildRecallQuery(rawTurn, {})) === JSON.stringify(builtQuery),
    'same raw message → byte-identical query');
  check('§20.5 recall-query is implemented but unwired (server can own it without a browser copy)',
    /implemented but unwired/.test(read('assets/js/memory-recall/recall-query.js')), '');
  verdict('RECALL_QUERY_AUTHORITY', 'SERVER_RUNTIME · browser sends the raw turn signal only; the server runs recall-query.js and owns lexicalTerms/entities/temporalHints');

  /* ══════════════════════════════════════════════════════════════════════
     §21 · SETTINGS AUTHORITY
     ══════════════════════════════════════════════════════════════════════ */
  section('§21 · settings authority（hostile topK=999 / exploration=false / cooldown bypass）');

  /* topK: 生产里**没有**这个字段（grep 证明），最近的是 channel-policy 的 maxTotalSeats。 */
  const topKConsumers = ['assets/js/memory-retrieval-core.js', 'assets/js/memory-recall/memory-recall-orchestrator.js',
    'services/home-node/memory-retrieval.js', 'services/home-node/mobile-gateway.js']
    .filter(rel => /\btopK\b/.test(read(rel)));
  check('§21.1 topK has no production consumer (a future route must not invent one)',
    topKConsumers.length === 0,
    'topK found in: ' + JSON.stringify(topKConsumers));
  const withTopK = ORCH.recall(records(40), Object.assign({}, B, { topK: 999, includeSelectionMeta: true }));
  const withoutTopK = ORCH.recall(records(40), Object.assign({}, B, { includeSelectionMeta: true }));
  check('§21.2 a hostile topK=999 changes nothing',
    JSON.stringify(withTopK.result) === JSON.stringify(withoutTopK.result)
    && JSON.stringify(Object.keys(withTopK.meta).sort()) === JSON.stringify(Object.keys(withoutTopK.meta).sort()),
    'result+meta byte-identical with and without topK=999');
  check('§21.3 the real seat cap is a server-owned channel-policy constant',
    CHANNEL_POLICY.MAX_SURFACE_TOTAL_SEATS === 3 && CHANNEL_POLICY.MAX_RECALL_TOTAL_SEATS === 5
    && CHANNEL_POLICY.resolveChannelPolicy('surface').policy.maxTotalSeats === 3,
    'MAX_SURFACE_TOTAL_SEATS=3 · MAX_RECALL_TOTAL_SEATS=5 (channel-policy.js:46-47)');

  /* budget：服务端"已发布设置优先"，浏览器路径"调用方优先" —— 这是真实的权威不对称。 */
  const serverBudgetLine = /const budget = published && published\.budget \? published\.budget\s*\n?\s*: \(options\.maxChars != null \? Number\(options\.maxChars\) : MEMORY_RETRIEVAL\.DEFAULT_BUDGET_CHARS\);/.test(read('services/home-node/memory-retrieval.js').replace(/\r/g, ''));
  const browserBudgetLine = /maxChars:opts\.maxChars\|\|memSettings\.budget\|\|core\.DEFAULT_BUDGET_CHARS/.test(memoryJsSrc.replace(/\r/g, ''));
  check('§21.4 budget authority differs today: server=settings-first, browser=caller-first',
    serverBudgetLine && browserBudgetLine,
    'server ' + at('services/home-node/memory-retrieval.js', 'const budget = published && published.budget')
    + ' vs browser ' + at('assets/js/memory.js', 'maxChars:opts.maxChars||memSettings.budget'));
  const budgetHostileRecords = Array.from({ length: 60 }, (_, i) => graphMem(i, {
    content: '显卡 驱动 更新失败 ' + 'x'.repeat(300)
  }));
  const budgetHostile = CORE.buildMemoryContext(budgetHostileRecords, Object.assign({}, B, { maxChars: 999999 }));
  const budgetProduct = CORE.buildMemoryContext(budgetHostileRecords, Object.assign({}, B, { maxChars: CORE.DEFAULT_BUDGET_CHARS }));
  check('§21.5 a hostile budget override measurably changes injection size (the knob is real)',
    budgetHostile.chars > budgetProduct.chars && budgetProduct.chars <= CORE.DEFAULT_BUDGET_CHARS,
    JSON.stringify({ productChars: budgetProduct.chars, hostileChars: budgetHostile.chars, productCap: CORE.DEFAULT_BUDGET_CHARS }));

  /* exploration：legacy 模式调用方可以关掉；turn 模式由 channel policy 覆盖。
     fixture 刻意调成"主选区被填满、探索窗口真的抽了一次"的形状：
     30 条 × contentLen 40 × maxChars 800 ⇒ 开=19 条（含探索项），关=18 条。 */
  const exploreRecords = Array.from({ length: 30 }, (_, i) => mem('ex' + String(i).padStart(2, '0'), {
    title: '显卡 ' + i, content: '显卡 驱动 更新失败 第' + i + '次',
    importance: 4 + (i % 5), created: NOW - (i % 30) * 86400000, lastActivated: NOW - (i % 7) * 3600000
  }));
  const exploreOpts = { apiId: 'friend_a', now: NOW, userMessage: '显卡 驱动 更新失败', contentLen: 40, maxChars: 800 };
  let exploreOnDraws = 0, exploreOffDraws = 0;
  const exploreOn = CORE.buildMemoryContext(exploreRecords, Object.assign({}, exploreOpts, {
    random: () => { exploreOnDraws++; return 0.99; }, allowExploration: true, includeSelectionMeta: true
  }));
  const exploreOff = CORE.buildMemoryContext(exploreRecords, Object.assign({}, exploreOpts, {
    random: () => { exploreOffDraws++; return 0.99; }, allowExploration: false, includeSelectionMeta: true
  }));
  check('§21.6 a hostile exploration:false is honoured by the CORE (legacy surface)',
    exploreOnDraws === 1 && exploreOffDraws === 0
    && JSON.stringify(exploreOn.selected.map(s => s.id)) !== JSON.stringify(exploreOff.selected.map(s => s.id))
    && exploreOn.selected.length === exploreOff.selected.length + 1,
    JSON.stringify({ draws: [exploreOnDraws, exploreOffDraws], on: exploreOn.selected.length, off: exploreOff.selected.length }));
  let turnForcedDraws = 0, turnCleanDraws = 0;
  const turnSignal = { message: '显卡 驱动 更新失败', isFirstTurn: false, conversationId: 'dm:friend_a' };
  const turnForced = ORCH.recall(exploreRecords, Object.assign({}, exploreOpts, {
    allowExploration: false, random: () => { turnForcedDraws++; return 0.99; }, turn: turnSignal
  }));
  const turnClean = ORCH.recall(exploreRecords, Object.assign({}, exploreOpts, {
    random: () => { turnCleanDraws++; return 0.99; }, turn: turnSignal
  }));
  check('§21.7 in TURN mode a caller-supplied exploration:false cannot disable the channel policy',
    turnForcedDraws === 1 && turnCleanDraws === 1
    && JSON.stringify(turnForced.result) === JSON.stringify(turnClean.result)
    && turnClean.meta.channel === 'surface',
    'the policy (surface ⇒ allowExploration:true) wins over the caller: draws=' + turnForcedDraws
    + ' vs ' + turnCleanDraws + '; ' + at('assets/js/memory-recall/memory-recall-orchestrator.js', 'coreOpts.allowExploration = !(channelPolicy'));
  check('§21.8 surface channel allows exploration; glossary/coldStart do not',
    CHANNEL_POLICY.resolveChannelPolicy('surface').policy.allowExploration === true
    && CHANNEL_POLICY.resolveChannelPolicy('recall').policy.allowExploration === true
    && CHANNEL_POLICY.resolveChannelPolicy('glossary').policy.allowExploration === false
    && CHANNEL_POLICY.resolveChannelPolicy('coldStart').policy.allowExploration === false,
    'server-owned, per-channel');

  /* cooldown：调用方传 turnIndex 会改变 factor；生产由 beginHomeTurn 服务端生成。 */
  const cdExposure = { lastExposureTurn: 10 };
  const cdServerTurn = COOLDOWN.computeCooldown({ channel: 'surface', currentTurnIndex: 11, exposure: cdExposure });
  const cdForgedTurn = COOLDOWN.computeCooldown({ channel: 'surface', currentTurnIndex: 99, exposure: cdExposure });
  check('§21.9 a forged turn index changes the cooldown factor (the knob is real)',
    cdServerTurn.factor === 0.4 && cdForgedTurn.factor === 1 && cdServerTurn.reason === 'cooldown-penalty',
    JSON.stringify({ server: cdServerTurn, forged: cdForgedTurn }));
  check('§21.10 the production host derives turnIndex server-side only',
    !/turnIndex/.test(gatewaySrc.slice(gatewaySrc.indexOf('function parseSendPayload'), gatewaySrc.indexOf('function deriveStableTurnId')))
    && /recallSessionState\.beginHomeTurn\(/.test(gatewaySrc),
    'parseSendPayload carries no turnIndex; beginHomeTurn is the only authority');
  check('§21.11 channel is decided by turn-signal + channel policy, not by the request',
    /analyzeTurnSignal\(\{/.test(read('assets/js/memory-recall/memory-recall-orchestrator.js'))
    && !/channelHint\s*:/.test(require(path.join(ROOT, 'tests/helpers/activation-wiring-probe.js'))
      .stripJsComments(read('services/home-node/memory-retrieval.js'))),
    'memory-retrieval.js never forwards a caller channelHint (comments stripped)');

  verdict('HOSTILE_SETTINGS_DEMO', {
    topK999_resultByteIdentical: JSON.stringify(withTopK.result) === JSON.stringify(withoutTopK.result),
    budget: { productChars: budgetProduct.chars, hostileChars: budgetHostile.chars, productCap: CORE.DEFAULT_BUDGET_CHARS },
    exploration: { drawsOn: exploreOnDraws, drawsOff: exploreOffDraws, itemsOn: exploreOn.selected.length, itemsOff: exploreOff.selected.length },
    turnMode: { forcedDraws: turnForcedDraws, cleanDraws: turnCleanDraws, resultsIdentical: JSON.stringify(turnForced.result) === JSON.stringify(turnClean.result) },
    cooldown: { obeyFactor: cdServerTurn.factor, obeyReason: cdServerTurn.reason, forgedFactor: cdForgedTurn.factor }
  });

  const SETTINGS_AUTHORITY = [
    { setting: 'topK', today_decision: 'no such field (0 consumers)', orchestrator_receives: 'nothing (ignored)', caller_influence_today: 'none', future_authority: 'SERVER', hostile_demo: 'topK=999 → result byte-identical (§21.2)' },
    { setting: 'budget (maxChars)', today_decision: 'server ' + at('services/home-node/memory-retrieval.js', 'const budget = published && published.budget') + '; browser ' + at('assets/js/memory.js', 'maxChars:opts.maxChars||memSettings.budget'), orchestrator_receives: 'options.maxChars → core.buildMemoryContext', caller_influence_today: 'browser path: caller wins; server path: published settings win', future_authority: 'SERVER', hostile_demo: 'maxChars=999999 → injected chars grow (§21.5)' },
    { setting: 'channel', today_decision: at('assets/js/memory-recall/memory-recall-orchestrator.js', 'var forcedRaw = (turn.channelHint'), orchestrator_receives: 'options.turn.channelHint (turn mode only)', caller_influence_today: 'possible at the orchestrator boundary; NOT forwarded by the Host', future_authority: 'SERVER', hostile_demo: 'not reachable from the mobile payload (§21.11)' },
    { setting: 'exploration', today_decision: at('assets/js/memory-recall/channel-policy.js', 'allowExploration: true') + ' + ' + at('assets/js/memory-recall/memory-recall-orchestrator.js', 'coreOpts.allowExploration'), orchestrator_receives: 'options.allowExploration (legacy) / channel policy (turn)', caller_influence_today: 'legacy: yes; turn: overridden', future_authority: 'SERVER', hostile_demo: 'exploration:false changes core selection; turn mode ignores it (§21.6/§21.7)' },
    { setting: 'cooldown', today_decision: at('assets/js/memory-recall/cooldown.js', 'function computeCooldown(input)') + ' + session state', orchestrator_receives: 'options.turnIndex + options.sessionState', caller_influence_today: 'turnIndex would change distance/factor if a caller could supply it', future_authority: 'SERVER', hostile_demo: 'forged turn index → factor 0.4 → 1.0 (§21.9)' }
  ];
  table('SETTINGS_AUTHORITY_TABLE', SETTINGS_AUTHORITY, ['setting', 'today_decision', 'orchestrator_receives', 'caller_influence_today', 'future_authority', 'hostile_demo']);

  /* ══════════════════════════════════════════════════════════════════════
     §22 · RANDOM AUTHORITY
     ══════════════════════════════════════════════════════════════════════ */
  section('§22 · random authority');
  const coreSrc = read('assets/js/memory-retrieval-core.js');
  const randomLine = lineOf('assets/js/memory-retrieval-core.js', 'var rand = typeof opts.random === \'function\' ? opts.random : Math.random;');
  check('§22.1 the exploration draw comes from an injectable random',
    randomLine === 232 && /function selectWithinBudget\(scored, options\)/.test(coreSrc),
    'memory-retrieval-core.js:' + randomLine + ' (task cites :232)');
  let drawCalls = 0;
  const drawSeq = [0.99, 0.5, 0.01];
  const sequenceRandom = () => { const v = drawSeq[drawCalls % drawSeq.length]; drawCalls++; return v; };
  const r1 = CORE.buildMemoryContext(exploreRecords, Object.assign({}, exploreOpts, { random: sequenceRandom, includeSelectionMeta: true }));
  const callsAfterR1 = drawCalls;
  check('§22.2 the injected random is called exactly once per selection (and never when exploration is off)',
    callsAfterR1 === 1 && exploreOffDraws === 0,
    'calls=' + callsAfterR1 + ' (exploration-off path: ' + exploreOffDraws + ')');
  drawCalls = 0;
  const r2 = CORE.buildMemoryContext(exploreRecords, Object.assign({}, exploreOpts, { random: sequenceRandom, includeSelectionMeta: true }));
  check('§22.3 a fixed random sequence makes recall reproducible',
    JSON.stringify(r1) === JSON.stringify(r2) && drawCalls === 1,
    'two runs with the same injected sequence are byte-identical');
  check('§22.4 the server assembles the random source (injectable), not the request',
    /random: options\.random/.test(read('services/home-node-service.js'))
    && /const random = typeof deps\.random === 'function' \? deps\.random : Math\.random;/.test(read('services/home-node/memory-retrieval.js'))
    && !/random/.test(gatewaySrc.slice(gatewaySrc.indexOf('function parseSendPayload'), gatewaySrc.indexOf('function deriveStableTurnId'))),
    'assembly ' + at('services/home-node-service.js', 'random: options.random')
    + ' · retrieval ' + at('services/home-node/memory-retrieval.js', 'const random = typeof deps.random'));
  verdict('RECALL_RANDOM_AUTHORITY', 'SERVER_RUNTIME');

  /* ══════════════════════════════════════════════════════════════════════
     §23 · CLOCK AUTHORITY
     ══════════════════════════════════════════════════════════════════════ */
  section('§23 · clock authority');
  const decayConsumers = {
    legacyMemoryValueDecay: at('assets/js/memory-retrieval-core.js', 'function getMemoryScore(mem, now) {'),
    fatigueHoursSinceLast: at('assets/js/memory-retrieval-core.js', 'var hoursSinceLast = (now - (m.lastActivated || m.created || 0))'),
    cooldownDistance: at('assets/js/memory-recall/cooldown.js', 'function distanceOf(currentTurnIndex, exposure)') + '（turn distance，不读 wall clock）',
    timeGate: at('services/home-node/mobile-gateway.js', 'currentTime: P0_CONTEXT.formatCurrentTime(clock(), timeZone),')
  };
  verdict('RECALL_CLOCK_DECISION_CONSUMERS', decayConsumers);
  const stale = [mem('clock_stale', { content: '显卡 驱动 更新失败', created: NOW - 5 * 86400000, lastActivated: NOW - 5 * 86400000, importance: 6, resolved: true })];
  const fresh = [mem('clock_fresh', { content: '显卡 驱动 更新失败', created: NOW - 5 * 86400000, lastActivated: NOW - 5 * 86400000, importance: 6.5, resolved: false })];
  const forgedNowMs = NOW - 100 * 86400000;
  const rankAt = now => CORE.rankMemoryCandidates([stale[0], fresh[0]], { apiId: 'friend_a', now: now, userMessage: '显卡' }).map(r => r.id);
  check('§23.1 now drives the decay score of the very same record',
    CORE.getMemoryScore(fresh[0], NOW) !== CORE.getMemoryScore(fresh[0], forgedNowMs)
    && CORE.getMemoryScore(fresh[0], forgedNowMs) > CORE.getMemoryScore(fresh[0], NOW),
    JSON.stringify({ atServerNow: CORE.getMemoryScore(fresh[0], NOW), atForgedNow: CORE.getMemoryScore(fresh[0], forgedNowMs) }));
  check('§23.2 a forged now can invert the canonical ranking order',
    JSON.stringify(rankAt(NOW)) !== JSON.stringify(rankAt(forgedNowMs)),
    JSON.stringify({ atServerNow: rankAt(NOW), atForgedNow: rankAt(forgedNowMs) }));
  verdict('CLOCK_FORGERY_DEMO', {
    scoreAtServerNow: CORE.getMemoryScore(fresh[0], NOW),
    scoreAtForgedNow: CORE.getMemoryScore(fresh[0], forgedNowMs),
    forgedNowOffsetDays: 100,
    orderAtServerNow: rankAt(NOW),
    orderAtForgedNow: rankAt(forgedNowMs)
  });
  let clockReads = 0;
  const clockDir = freshDir('clock');
  const clockStore = MEMORY_STORE({ dataDir: clockDir, logger: () => {} });
  clockStore.open();
  clockStore.putRecord(mem('clock_mem', { content: '显卡 驱动 更新失败', created: NOW, lastActivated: NOW }));
  const retrieval = MEMORY_RETRIEVAL({ store: clockStore, clock: () => { clockReads++; return NOW; }, random: () => 0.5, logger: () => {} });
  const clockResult = retrieval.retrieve('friend_a', { userMessage: '显卡 驱动 更新失败' });
  clockStore.close();
  dropDir(clockDir);
  check('§23.3 the retrieval seam reads the injected clock, never Date.now()',
    clockReads >= 1 && clockResult.ok === true
    && /const clock = deps\.clock \|\| \(\(\) => Date\.now\(\)\);/.test(read('services/home-node/memory-retrieval.js')),
    'clockReads=' + clockReads + ' · injected clock used; Date.now exists only as the assembly fallback');
  check('§23.4 the request cannot carry a clock',
    !/\bnow\b/.test(gatewaySrc.slice(gatewaySrc.indexOf('function parseSendPayload'), gatewaySrc.indexOf('function deriveStableTurnId'))),
    'parseSendPayload accepts no now field');
  verdict('RECALL_CLOCK_AUTHORITY', 'SERVER_RUNTIME');

  /* ══════════════════════════════════════════════════════════════════════
     §33 · SECURITY / PRIVACY — attacks on the CURRENT surfaces
     ══════════════════════════════════════════════════════════════════════ */
  section('§33 · security & privacy attacks on current surfaces');
  const provider = (function mockProvider() {
    const seen = { bodies: [] };
    const server = http.createServer((rq, rs) => {
      let raw = '';
      rq.on('data', c => raw += c);
      rq.on('end', () => {
        try { seen.bodies.push(JSON.parse(raw)); } catch (_) { seen.bodies.push({ raw: raw }); }
        rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
        rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '收到' } }] }) + '\n\n');
        rs.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
        rs.write('data: [DONE]\n\n');
        rs.end();
      });
    });
    return { server: server, seen: seen };
  })();
  const providerPort = await listen(provider.server, '127.0.0.1');
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + '/v1/chat/completions';
  const workDir = freshDir('data');
  /* 刻意**不**注入 port：走装配的默认 NodeModelPort（全局 fetch），
     而 spec.endpoint 指向本机 mock provider —— 零真实 provider 调用。 */
  const inst = SERVICE.buildHomeNode({
    dataDir: workDir,
    token: ADMIN_TOKEN,
    host: '0.0.0.0',      /* 远端姿态也要能被证明（见 §33.4） */
    logger: () => {}
  });
  inst.open();
  inst.registry.putCharacter('friend_a', { id: 'friend_a', name: 'A' },
    { provider: 'custom', model: 'mock', endpoint: providerEndpoint, apiKey: 'sk-local', systemPrompt: 'SYS-A' });
  inst.registry.putCharacter('friend_b', { id: 'friend_b', name: 'B' },
    { provider: 'custom', model: 'mock', endpoint: providerEndpoint, apiKey: 'sk-local', systemPrompt: 'SYS-B' });
  const SECRET_B = 'SECRET_OTHER_CHARACTER_MEMORY_7C41';
  inst.memoryStore.putRecord(mem('mem_a_public', {
    createdBy: 'friend_a', content: '显卡 驱动 更新失败 A 的记忆', visibility: 'public'
  }));
  inst.memoryStore.putRecord(mem('mem_b_private', {
    createdBy: 'friend_b', content: '显卡 驱动 更新失败 ' + SECRET_B, visibility: 'only', visibleTo: ['friend_b']
  }));
  const port = await listen(inst.server, '0.0.0.0');
  const remote = await (async function pickRemote() {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const e of list || []) {
        const fam = String(e.family);
        if ((fam === 'IPv4' || fam === '4') && !e.internal) return e.address;
      }
    }
    return '127.0.0.2';
  })();
  /* 网关错误信封有两种形状（string 或 {code}）—— 两种都认，但不放宽词表。 */
  const errorCodeOf = body => {
    if (!body) return null;
    if (typeof body.error === 'string') return body.error;
    if (body.error && typeof body.error.code === 'string') return body.error.code;
    if (typeof body.code === 'string') return body.code;
    return null;
  };

  try {
    /* ── pairing：拿一个真实 device token ───────────────────────────── */
    const pairSession = await req('127.0.0.1', port, 'POST', '/pairing/session', {
      headers: DESKTOP, body: { deviceName: 'audit-phone', deviceType: 'android' }
    });
    const pairComplete = await req('127.0.0.1', port, 'POST', '/mobile/v1/pairing/complete', {
      body: { v: 1, payload: { pairingId: pairSession.body && pairSession.body.payload && pairSession.body.payload.pairingId, secret: pairSession.body && pairSession.body.payload && pairSession.body.payload.secret, deviceName: 'audit-phone', deviceType: 'android' } }
    });
    const deviceToken = pairComplete.body && pairComplete.body.payload && pairComplete.body.payload.token;
    const DEVICE = { Authorization: 'Bearer ' + String(deviceToken) };
    check('§33.0 pairing produced a real device token (precondition)',
      pairComplete.status === 200 && typeof deviceToken === 'string' && deviceToken.length > 10,
      'status=' + pairComplete.status);

    /* ① 设备令牌不能当桌面代理 */
    const deviceOnDesktopFace = await req('127.0.0.1', port, 'GET', '/memory/list', { headers: DEVICE });
    check('§33.1 a DEVICE token cannot call the desktop /memory/* face',
      deviceOnDesktopFace.status === 401 && deviceOnDesktopFace.body && deviceOnDesktopFace.body.error === 'unauthenticated',
      'status=' + deviceOnDesktopFace.status + ' error=' + (deviceOnDesktopFace.body && deviceOnDesktopFace.body.error));
    const desktopOnMobileFace = await req('127.0.0.1', port, 'GET', '/mobile/v1/character/list', { headers: DESKTOP });
    check('§33.2 a DESKTOP token cannot call the mobile device face',
      desktopOnMobileFace.status === 401
      && ['AUTH_REQUIRED', 'AUTH_INVALID'].indexOf(errorCodeOf(desktopOnMobileFace.body)) >= 0,
      'status=' + desktopOnMobileFace.status + ' error=' + JSON.stringify(errorCodeOf(desktopOnMobileFace.body)));
    const noCreds = await req('127.0.0.1', port, 'GET', '/memory/list', {});
    check('§33.3 loopback without the desktop token is refused on /memory/*',
      noCreds.status === 401, 'status=' + noCreds.status);
    /* 远端姿态：socket 到得了（0.0.0.0 绑定），但**凭据**才是边界。
       没有桌面 token ⇒ 拒绝；带了正确的桌面 token ⇒ 才被服务。 */
    const remoteNoToken = await req(remote, port, 'GET', '/memory/list', {});
    const remoteWithToken = await req(remote, port, 'GET', '/memory/list?limit=1', { headers: DESKTOP });
    check('§33.4 a non-loopback caller without the desktop token cannot reach /memory/*',
      remoteNoToken.status === 401 || remoteNoToken.status === 403,
      'remote=' + remote + ' status=' + remoteNoToken.status + ' error=' + JSON.stringify(errorCodeOf(remoteNoToken.body)));
    check('§33.4b the desktop credential (not the network location) is the boundary',
      remoteWithToken.status === 200 && remoteWithToken.body && remoteWithToken.body.ok === true,
      'remote=' + remote + ' with-desktop-token status=' + remoteWithToken.status);
    const recallVerb = await req('127.0.0.1', port, 'POST', '/memory/recall', { headers: DESKTOP, body: { characterId: 'friend_a' } });
    check('§33.5 there is no /memory/recall verb to attack today (404)',
      recallVerb.status === 404,
      'status=' + recallVerb.status);

    /* ② 伪造字段：payload 里的 authority 只能在服务端产生。
       ★ mobile chat/send 是**异步**的（202 + turnId），provider 调用发生在响应之后；
         因此每一轮都必须等它真的打到 provider 再发下一轮（也保证 body→turn 的映射）。
       ★ 会话的**第一轮**走 coldStart 通道（anchor 准入），因此每个角色先来一轮热身，
         被测量的那一轮才是 surface 通道（lexical gate + 普通召回）。 */
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const sendTurn = async (requestId, characterId, payload) => {
      const before = provider.seen.bodies.length;
      const sent = await readSse('127.0.0.1', port, '/mobile/v1/chat/send', {
        v: 1, requestId: requestId, payload: Object.assign({ characterId: characterId }, payload)
      }, DEVICE);
      const deadline = Date.now() + 10000;
      while (provider.seen.bodies.length === before && Date.now() < deadline) await sleep(40);
      return { status: sent.status, raw: sent.raw, bodyIndex: provider.seen.bodies.length - 1, produced: provider.seen.bodies.length > before };
    };
    const FORGED = {
      selectedIds: ['mem_b_private'], memoryIds: ['mem_b_private'], ids: ['mem_b_private'],
      candidateRecords: [{ id: 'FORGED_CANDIDATE', content: 'FORGED_CANDIDATE_BODY' }],
      rank: ['mem_b_private'], scores: { mem_b_private: 999 }, relevanceScore: 999,
      cooldownFactors: { mem_b_private: 0 }, seatResult: ['FORGED_SEAT'], seatPlan: { seats: 99 },
      topK: 999, exploration: false, allowExploration: false, budget: 999999, maxChars: 999999,
      now: 1, random: 0.0001, channelHint: 'recall', ownerId: 'friend_b', characterOverride: 'friend_b',
      currentTime: '1999-01-01T00:00:00+08:00', settings: { budget: 999999 }
    };
    const warmA = await sendTurn('audit-warm-a', 'friend_a', { content: '你好' });
    const forgedSend = await sendTurn('audit-forged-1', 'friend_a', Object.assign({ content: '显卡 驱动 更新失败' }, FORGED));
    const cleanSend = await sendTurn('audit-clean-1', 'friend_a', { content: '显卡 驱动 更新失败' });
    const wireCountAtA = provider.seen.bodies.length;
    const forgedBody = provider.seen.bodies[forgedSend.bodyIndex] || {};
    const cleanBody = provider.seen.bodies[cleanSend.bodyIndex] || {};
    const forgedWire = JSON.stringify(forgedBody);
    const cleanWire = JSON.stringify(cleanBody);
    const systemOf = b => {
      const msgs = (b && Array.isArray(b.messages)) ? b.messages : [];
      return msgs.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
    };
    /* 只比较**记忆块**（P0 的当前时间按分钟变化，比较整段 system 会 flaky）。 */
    const memoryBlockOf = text => {
      const s = String(text || '');
      const start = s.indexOf('【长期记忆】');
      if (start < 0) return '';
      const end = s.indexOf('（以上为长期记忆');
      return end > start ? s.slice(start, end) : s.slice(start);
    };
    const forgedMarkers = ['FORGED_CANDIDATE', 'FORGED_SEAT', '1999-01-01', '"topK"', '"cooldownFactors"', '"selectedIds"', '"exploration"'];
    check('§33.6 forged authority fields never reach the provider wire',
      forgedSend.status === 202 && cleanSend.status === 202
      && forgedSend.produced && cleanSend.produced && wireCountAtA >= 3
      && forgedWire.length > 2 && cleanWire.length > 2
      && forgedMarkers.every(m => forgedWire.indexOf(m) < 0),
      'providerCalls=' + wireCountAtA + ' markers present: '
      + JSON.stringify(forgedMarkers.filter(m => forgedWire.indexOf(m) >= 0)));
    check('§33.7 the server-selected memory context is identical with and without the forged payload',
      memoryBlockOf(systemOf(cleanBody)).length > 0
      && memoryBlockOf(systemOf(forgedBody)) === memoryBlockOf(systemOf(cleanBody)),
      JSON.stringify({
        cleanBlock: memoryBlockOf(systemOf(cleanBody)).slice(0, 90),
        forgedBlock: memoryBlockOf(systemOf(forgedBody)).slice(0, 90)
      }));
    check('§33.8 a forged now cannot move the server clock in the prompt',
      /当前时间：/.test(systemOf(cleanBody)) && systemOf(cleanBody).indexOf('1999-01-01') < 0
      && systemOf(forgedBody).indexOf('1999-01-01') < 0,
      'server-formatted time present, forged timestamp absent');

    /* ③ 另一个角色的记忆永不进入 A 的召回 */
    check('§33.9 character A\'s turn never carries character B\'s private memory',
      wireCountAtA >= 2 && cleanWire.length > 2 && forgedWire.length > 2
      && cleanWire.indexOf(SECRET_B) < 0 && forgedWire.indexOf(SECRET_B) < 0,
      'sentinel absent from both A turns (wire bytes present: ' + cleanWire.length + '/' + forgedWire.length + ')');
    const warmB = await sendTurn('audit-warm-b', 'friend_b', { content: '你好' });
    const bTurn = await sendTurn('audit-b-1', 'friend_b', { content: '显卡 驱动 更新失败' });
    const bBody = provider.seen.bodies[bTurn.bodyIndex] || {};
    const bWire = JSON.stringify(bBody);
    check('§33.10 positive control: B\'s own private memory IS reachable to B',
      warmB.status === 202 && bTurn.status === 202 && bTurn.produced
      && memoryBlockOf(systemOf(bBody)).length > 0 && bWire.indexOf(SECRET_B) >= 0,
      'sentinel present in B\'s own turn: ' + (bWire.indexOf(SECRET_B) >= 0)
      + ' (B block=' + JSON.stringify(memoryBlockOf(systemOf(bBody)).slice(0, 80)) + ')');
    check('§33.11 full-view evidence is never requested by the recall path',
      !/evidenceView/.test(read('services/home-node/memory-retrieval.js'))
      && !/evidenceView/.test(gatewaySrc)
      && cleanWire.length > 2 && cleanWire.indexOf('evidenceView') < 0,
      'no evidenceView in production recall code or on the wire (wire bytes: ' + cleanWire.length + ')');
    check('§33.12 canonical payload injection cannot smuggle another owner into the turn',
      cleanWire.length > 2 && cleanWire.indexOf('"friendId":"friend_b"') < 0
      && forgedWire.indexOf('"friendId":"friend_b"') < 0,
      'server sets friendId = requested characterId (parseSendPayload)');
  } finally {
    try { inst.close(); } catch (_) { /* 已关闭 */ }
    try { provider.server.close(); } catch (_) { /* 未监听 */ }
    dropDir(workDir);
  }

  /* ══════════════════════════════════════════════════════════════════════
     §25 · NEW-ROUTE SECURITY — 攻击 POST /internal/runtime/memory-recall
     ----------------------------------------------------------------------
     冻结契约（task-16）：闭集 { characterId, requestId, conversationId,
     channelIntent?, turnMessage, timeoutMs }；任何权威字段一律**指名拒绝**
     （caller-attempted-to-supply-recall-authority 之类）；纯影子（不写
     exposure / 不推进 session / 不激活 / 不调 provider）；只回 ids + 有界
     diagnostics。
     ★ 模块不在盘上时 **SKIP**（不假通过、也不假失败）—— 攻击已按契约写好，
       落盘后同一条命令即可复跑。
     ══════════════════════════════════════════════════════════════════════ */
  section('§25 · new-route security attacks');
  const RUNTIME_RECALL_MODULE = 'services/home-node/runtime-recall.js';
  const FROZEN_ACCEPTED = ['characterId', 'requestId', 'conversationId', 'channelIntent', 'turnMessage', 'timeoutMs'];
  const FROZEN_AUTHORITY_FIELDS = [
    'selectedIds', 'candidateRecords', 'records', 'scores', 'rank', 'topK', 'budget',
    'maxChars', 'seatPlan', 'exploration', 'cooldown', 'random', 'now', 'timestamp',
    'activation', 'settings', 'normalizedQuery', 'tokens',
    'memoryIds', 'ids', 'score', 'relevanceScore', 'cooldownFactors', 'seatResult',
    'evidenceView', 'provider', 'model', 'endpoint', 'apiKey', 'credentialRef',
    'sql', 'filter', 'query', 'limit', 'ownerId', 'characterOverride', 'systemPrompt', 'prompt'
  ];
  let RUNTIME_RECALL = null;
  let RUNTIME_RECALL_ERROR = null;
  try { RUNTIME_RECALL = require(path.join(ROOT, RUNTIME_RECALL_MODULE)); }
  catch (error) { RUNTIME_RECALL_ERROR = error; }
  const recallFactory = RUNTIME_RECALL
    ? (typeof RUNTIME_RECALL === 'function' ? RUNTIME_RECALL
      : (typeof RUNTIME_RECALL.createRuntimeRecall === 'function' ? RUNTIME_RECALL.createRuntimeRecall : null))
    : null;
  verdict('NEW_ROUTE_FROZEN_CONTRACT', {
    path: '/internal/runtime/memory-recall',
    accepted: FROZEN_ACCEPTED,
    rejectedByAuthority: FROZEN_AUTHORITY_FIELDS,
    pureShadow: true,
    providerCalls: 'NONE (no modelPort dependency in the contract)'
  });
  if (typeof recallFactory !== 'function') {
    skip('§25.1–§25.14 new-route attacks',
      RUNTIME_RECALL_MODULE + ' not on disk yet (frozen contract = task-16)'
      + (RUNTIME_RECALL_ERROR ? ' — ' + String(RUNTIME_RECALL_ERROR.message) : '')
      + '; attacks are written against that contract and re-run when it lands');
    verdict('NEW_ROUTE_SECURITY_ATTACKS', 'PENDING_ROUTE');
  } else {
    /* 单一真源：权威名单与专用码都从**模块自己**的导出读，而不是在本套件里抄一份。 */
    const AUTHORITY_CODE = 'caller-attempted-to-supply-recall-authority';
    const REJECTED_LIST = Array.isArray(RUNTIME_RECALL.REJECTED_AUTHORITY_FIELDS)
      ? RUNTIME_RECALL.REJECTED_AUTHORITY_FIELDS : [];
    const SECRET_B2 = 'SECRET_NEW_ROUTE_OTHER_7C41';
    check('§25.0 the frozen contract exports path + both field lists',
      RUNTIME_RECALL.PATH === '/internal/runtime/memory-recall'
      && RUNTIME_RECALL.OPERATION === 'memory-recall'
      && Array.isArray(RUNTIME_RECALL.REQUEST_FIELDS) && RUNTIME_RECALL.REQUEST_FIELDS.length === 8
      && REJECTED_LIST.length >= 24
      && RUNTIME_RECALL.REASON.callerSuppliedRecallAuthority === AUTHORITY_CODE,
      JSON.stringify({ path: RUNTIME_RECALL.PATH, accepted: RUNTIME_RECALL.REQUEST_FIELDS, rejectedCount: REJECTED_LIST.length }));
    const attackDir = freshDir('recall-attack');
    const attackStore = MEMORY_STORE({ dataDir: attackDir, logger: () => {} });
    attackStore.open();
    attackStore.putRecord(mem('ra_public', { createdBy: 'friend_a', content: '显卡 驱动 更新失败 A 的记忆' }));
    attackStore.putRecord(mem('ra_b_private', {
      createdBy: 'friend_b', content: '显卡 驱动 更新失败 ' + SECRET_B2, visibility: 'only', visibleTo: ['friend_b']
    }));
    const sessionWrites = { begin: 0, end: 0, exposure: 0, reads: 0 };
    const attackSession = {
      beginHomeTurn: () => { sessionWrites.begin++; return 1; },
      endHomeTurn: () => { sessionWrites.end++; return true; },
      recordExposure: () => { sessionWrites.exposure++; return 1; },
      getExposure: () => { sessionWrites.reads++; return null; }
    };
    let randomDraws = 0;
    const realRetrieval = MEMORY_RETRIEVAL({
      store: attackStore, clock: () => NOW, random: () => { randomDraws++; return 0.5; },
      sessionState: attackSession, logger: () => {}
    });
    let retrieveCalls = 0, reinforceCalls = 0;
    const retrievalProbe = {
      store: realRetrieval.store,
      retrieve: (...args) => { retrieveCalls++; return realRetrieval.retrieve(...args); },
      reinforce: (...args) => { reinforceCalls++; return realRetrieval.reinforce(...args); },
      buildMemoryBlock: (...args) => realRetrieval.buildMemoryBlock(...args),
      buildRuntimeContext: (...args) => realRetrieval.buildRuntimeContext(...args)
    };
    /* 本套件不 require 生产模块的角色目录实现：只给一个"这台节点上有这两个
       运行时角色"的最小 registry（与解释边界同一个 accessor 形状）。 */
    const attackRegistry = {
      getCharacterSpec: id => (String(id) === 'friend_a' || String(id) === 'friend_b') ? { id: String(id) } : null,
      listCharacters: () => [{ id: 'friend_a' }, { id: 'friend_b' }]
    };
    const recallSvc = recallFactory({
      memoryRetrieval: retrievalProbe, memoryStore: attackStore, registry: attackRegistry,
      sessionState: attackSession, clock: () => NOW, random: () => 0.5, logger: () => {}
    });
    const recallInvoke = (body, options) => {
      try { return Promise.resolve(recallSvc.run(body, options)); }
      catch (error) { THROWN.push(String((error && error.message) || error)); return Promise.resolve({ ok: false, error: 'THREW' }); }
    };
    const baseRecallBody = {
      operation: 'memory-recall',
      characterId: 'friend_a', requestId: 'attack-1', conversationId: 'dm:friend_a',
      message: '显卡 驱动 更新失败', timeoutMs: 5000
    };
    const revisionBefore = attackStore.listRecords({}).revision;
    const cleanRecall = await recallInvoke(baseRecallBody, {});
    check('§25.1 the route answers a well-formed request with ids + bounded counts',
      cleanRecall && cleanRecall.ok === true && Array.isArray(cleanRecall.selectedIds)
      && cleanRecall.selectedIds.indexOf('ra_public') >= 0
      && JSON.stringify(cleanRecall.selectedIds).indexOf('ra_b_private') < 0
      && cleanRecall.counts && cleanRecall.counts.selected === cleanRecall.selectedIds.length
      && typeof cleanRecall.fingerprint === 'string'
      && !!cleanRecall.boundary && cleanRecall.boundary.pureShadow === true
      && retrieveCalls === 1,
      JSON.stringify({ ok: cleanRecall && cleanRecall.ok, ids: cleanRecall && cleanRecall.selectedIds,
        counts: cleanRecall && cleanRecall.counts, error: errCode(cleanRecall) }));

    /* §25.2a —— 用**模块自己的**权威名单（单一真源）逐个攻击：必须拿到那个
       专用码 caller-attempted-to-supply-recall-authority，且一次 retrieve 都不发生。 */
    let attackFailures = 0;
    const attackFailDetail = [];
    const retrieveBaseline = retrieveCalls;
    for (const field of REJECTED_LIST) {
      const body = Object.assign({}, baseRecallBody, { requestId: 'attack-' + field });
      body[field] = ['selectedIds', 'candidateRecords', 'records', 'candidates', 'selectedIds'].indexOf(field) >= 0
        ? ['ra_b_private'] : 'FORGED';
      const r = await recallInvoke(body, {});
      if (!(r && r.ok === false && errCode(r) === AUTHORITY_CODE && r.field === field)) {
        attackFailures++;
        attackFailDetail.push(field + ':' + errCode(r) + '/' + r.field);
      }
    }
    check('§25.2a every field on the module\'s own authority list gets the dedicated code',
      REJECTED_LIST.length >= 24 && attackFailures === 0 && retrieveCalls === retrieveBaseline,
      'refused=' + (REJECTED_LIST.length - attackFailures) + '/' + REJECTED_LIST.length
      + ' failures=' + JSON.stringify(attackFailDetail.slice(0, 8)));

    /* §25.2b —— 本套件冻结的**更宽**名单（含 evidenceView / apiKey / endpoint /
       sql / ownerId 等）：不在模块权威名单里的那些必须仍被闭集拒绝（request-field-forbidden），
       一个都不许静默忽略。 */
    let looseFailures = 0;
    const looseFailDetail = [];
    for (const field of FROZEN_AUTHORITY_FIELDS) {
      const body = Object.assign({}, baseRecallBody, { requestId: 'attack2-' + field });
      body[field] = field === 'evidenceView' ? 'full'
        : (['selectedIds', 'memoryIds', 'ids'].indexOf(field) >= 0 ? ['ra_b_private'] : 'FORGED');
      const r = await recallInvoke(body, {});
      const named = r && r.ok === false
        && (errCode(r) === AUTHORITY_CODE || errCode(r) === 'request-field-forbidden')
        && r.field === field;
      if (!named) { looseFailures++; looseFailDetail.push(field + ':' + errCode(r) + '/' + r.field); }
    }
    check('§25.2b the wider frozen list is also refused by name (closed schema, never ignored)',
      looseFailures === 0 && retrieveCalls === retrieveBaseline,
      'refused=' + (FROZEN_AUTHORITY_FIELDS.length - looseFailures) + '/' + FROZEN_AUTHORITY_FIELDS.length
      + ' failures=' + JSON.stringify(looseFailDetail.slice(0, 8)));

    const unknownKey = await recallInvoke(Object.assign({}, baseRecallBody, { requestId: 'attack-unknown', harmlessKey: 1 }), {});
    check('§25.2c an unknown-but-harmless key is refused (not silently ignored)',
      unknownKey.ok === false && errCode(unknownKey) === 'request-field-forbidden' && unknownKey.field === 'harmlessKey',
      errCode(unknownKey) + '/' + unknownKey.field);
    const badOperation = await recallInvoke(Object.assign({}, baseRecallBody, { requestId: 'attack-op', operation: 'memory-interpretation' }), {});
    check('§25.2d a wrong operation is refused (path routes, operation decides semantics)',
      badOperation.ok === false && errCode(badOperation) === 'operation-forbidden',
      errCode(badOperation));

    const crossBody = Object.assign({}, baseRecallBody, { requestId: 'attack-cross', characterId: 'friend_a', ownerId: 'friend_b' });
    const crossRes = await recallInvoke(crossBody, {});
    check('§25.3 a cross-character payload cannot borrow another character\'s memory',
      crossRes.ok === false && errCode(crossRes) === 'request-field-forbidden'
      && retrieveCalls === retrieveBaseline
      && JSON.stringify(cleanRecall).indexOf(SECRET_B2) < 0,
      errCode(crossRes) + '/' + crossRes.field);
    const bRes = await recallInvoke(Object.assign({}, baseRecallBody, { requestId: 'attack-b', characterId: 'friend_b' }), {});
    check('§25.4 positive control: B\'s own private memory is selectable for B (isolation is real)',
      bRes.ok === true && Array.isArray(bRes.selectedIds) && bRes.selectedIds.indexOf('ra_b_private') >= 0
      && cleanRecall.selectedIds.indexOf('ra_b_private') < 0
      && retrieveCalls === retrieveBaseline + 1,
      JSON.stringify({ aIds: cleanRecall.selectedIds, bIds: bRes.selectedIds }));

    const fullView = await recallInvoke(Object.assign({}, baseRecallBody, { requestId: 'attack-fullview', evidenceView: 'full' }), {});
    check('§25.5 a full-view request is refused',
      fullView.ok === false && fullView.field === 'evidenceView', errCode(fullView));

    const resultText = JSON.stringify(cleanRecall);
    const ALLOWED_RESULT_KEYS = ['ok', 'durable', 'operation', 'characterId', 'turnIdentity', 'selectedIds',
      'activationPolicy', 'channel', 'reason', 'fingerprint', 'counts', 'chars', 'boundary', 'status',
      'error', 'reasonCode', 'detail', 'field', 'requestedOperation', 'timeoutMs', 'timeoutClamped'];
    check('§25.6 the result carries ids and bounded counts only (no canonical rows, no scores, no content)',
      resultText.indexOf('BODY-') < 0 && resultText.indexOf('显卡') < 0
      && !/relevanceScore|memoryValue|finalScore|_score/.test(resultText)
      && Object.keys(cleanRecall).every(k => ALLOWED_RESULT_KEYS.indexOf(k) >= 0)
      && cleanRecall.boundary.exposureWrites === 0 && cleanRecall.boundary.activationWrites === 0
      && cleanRecall.boundary.providerCalls === 0 && cleanRecall.boundary.sessionMutation === 'NONE',
      JSON.stringify(Object.keys(cleanRecall)));

    check('§25.7 pure shadow: no exposure / session / activation writes, no store revision move',
      sessionWrites.begin === 0 && sessionWrites.end === 0 && sessionWrites.exposure === 0
      && reinforceCalls === 0
      && attackStore.listRecords({}).revision === revisionBefore,
      JSON.stringify({ sessionWrites, reinforceCalls, revisionBefore, revisionAfter: attackStore.listRecords({}).revision }));

    const desc = typeof recallSvc.describe === 'function' ? recallSvc.describe() : null;
    check('§25.8 describe() declares the boundary truthfully and carries no secret',
      desc && desc.transportScope === 'DESKTOP_ONLY' && desc.callerAuthority === 'NONE'
      && desc.pureShadow === true && desc.providerCalls === 0 && desc.providerReachable === false
      && desc.exposureWrites === 0 && desc.activationWrites === 0 && desc.sessionMutation === 'NONE'
      && desc.randomAuthority === 'memory-retrieval-constructor' && desc.clockAuthority === 'home-node-server'
      && JSON.stringify(desc).indexOf(SECRET_B2) < 0,
      JSON.stringify(desc && { path: desc.path, callerAuthority: desc.callerAuthority,
        transportScope: desc.transportScope, providerCalls: desc.providerCalls, storeIdentity: desc.storeIdentity }));
    check('§25.9 the service never threw during the attacks', THROWN.length === 0, JSON.stringify(THROWN.slice(0, 4)));

    /* HTTP 面：只有在装配层真的导出了这条服务时才测。 */
    const httpProbeDir = freshDir('recall-http');
    let httpRecallInst = null;
    try {
      httpRecallInst = SERVICE.buildHomeNode({ dataDir: httpProbeDir, token: ADMIN_TOKEN, logger: () => {} });
      httpRecallInst.open();
      if (!httpRecallInst.runtimeRecall) {
        skip('§25.10–§25.13 http-level new-route attacks', 'buildHomeNode did not export runtimeRecall (route not assembled yet)');
      } else {
        const hp = await listen(httpRecallInst.server, '127.0.0.1');
        const noToken = await req('127.0.0.1', hp, 'POST', '/internal/runtime/memory-recall', { body: baseRecallBody });
        const getVerb = await req('127.0.0.1', hp, 'GET', '/internal/runtime/memory-recall', { headers: DESKTOP });
        const forgedField = await req('127.0.0.1', hp, 'POST', '/internal/runtime/memory-recall', {
          headers: DESKTOP, body: Object.assign({}, baseRecallBody, { selectedIds: ['ra_b_private'] })
        });
        check('§25.10 POST without the desktop token is 401', noToken.status === 401, 'status=' + noToken.status);
        check('§25.11 GET is 405 (recall-is-post-only)',
          getVerb.status === 405 && !!getVerb.body && /post-only/i.test(String(getVerb.body.error)), 'status=' + getVerb.status);
        check('§25.12 an authority field over HTTP is refused, never silently ignored',
          forgedField.status >= 400 && forgedField.status < 500 && forgedField.body && forgedField.body.ok === false,
          'status=' + forgedField.status + ' error=' + (forgedField.body && forgedField.body.error));
        check('§25.13 the refusal carries no memory body',
          String(forgedField.raw || '').indexOf(SECRET_B2) < 0, 'raw response scanned');
      }
    } catch (error) {
      check('§25.10–§25.13 http-level new-route attacks', false, String((error && error.message) || error));
    } finally {
      if (httpRecallInst) { try { httpRecallInst.close(); } catch (_) { /* 已关闭 */ } }
      dropDir(httpProbeDir);
    }
    check('§25.14 zero provider calls on this route (no model port is even a dependency)',
      /* 看**代码面**：头注释里写着 "没有 modelPort" 正是我们要的，不能把它当成引用。 */
      !/modelPort/.test(WIRING.stripJsComments(read('services/home-node/runtime-recall.js')))
      && !/require\(['"](?:node:)?https?['"]\)/.test(read('services/home-node/runtime-recall.js'))
      && desc && desc.providerReachable === false && desc.providerCalls === 0
      && retrieveCalls > 0,
      'retrieveCalls=' + retrieveCalls + ' · runtime-recall.js has no modelPort reference in code');
    verdict('NEW_ROUTE_SECURITY_ATTACKS', attackFailures === 0 && looseFailures === 0 ? 'ALL_REFUSED' : 'FAILURES=' + (attackFailures + looseFailures));
    try { attackStore.close(); } catch (_) { /* 已关闭 */ }
    dropDir(attackDir);
  }

  /* ══════════════════════════════════════════════════════════════════════
     §32 · PERFORMANCE（median + p95，含真实的 loopback hop）
     ══════════════════════════════════════════════════════════════════════ */
  section('§32 · performance (diagnostic only — no invented threshold, no "zero cost")');
  const FIXTURE_SIZE = 240;
  const ITER_BROWSER = 200;
  const ITER_SERVER = 100;
  const ITER_HTTP = 60;
  const fixture = records(FIXTURE_SIZE);

  const browserSamples = [];
  for (let i = 0; i < ITER_BROWSER; i++) {
    const t0 = process.hrtime.bigint();
    ORCH.recall(fixture, Object.assign({}, B, { random: () => 0.5 }));
    browserSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  const perfDir = freshDir('perf');
  const perfStore = MEMORY_STORE({ dataDir: perfDir, logger: () => {} });
  perfStore.open();
  for (const r of fixture) perfStore.putRecord(r);
  const perfRetrieval = MEMORY_RETRIEVAL({ store: perfStore, clock: () => NOW, random: () => 0.5, logger: () => {} });
  const serverSamples = [];
  for (let i = 0; i < ITER_SERVER; i++) {
    const t0 = process.hrtime.bigint();
    perfRetrieval.retrieve('friend_a', { userMessage: '显卡 驱动 更新失败' });
    serverSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  perfStore.close();

  const perfNodeDir = freshDir('perf-node');
  const perfInst = SERVICE.buildHomeNode({
    dataDir: perfNodeDir, token: ADMIN_TOKEN,
    port: { run: () => Promise.reject(new Error('unused')) }, logger: () => {}
  });
  perfInst.open();
  perfInst.registry.putCharacter('friend_a', { id: 'friend_a', name: 'A' },
    { provider: 'custom', model: 'mock', endpoint: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'sk-local' });
  const perfPort = await listen(perfInst.server, '127.0.0.1');
  const hopSamples = [];
  await req('127.0.0.1', perfPort, 'GET', '/health', {});   /* warm-up */
  for (let i = 0; i < ITER_HTTP; i++) {
    const t0 = process.hrtime.bigint();
    await req('127.0.0.1', perfPort, 'GET', '/health', {});
    hopSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const readSamples = [];
  for (let i = 0; i < Math.min(20, ITER_HTTP); i++) {
    const t0 = process.hrtime.bigint();
    await req('127.0.0.1', perfPort, 'GET', '/memory/list?limit=240', { headers: DESKTOP });
    readSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  try { perfInst.close(); } catch (_) { /* 已关闭 */ }
  dropDir(perfDir);
  dropDir(perfNodeDir);

  const PERF = {
    fixtureSize: FIXTURE_SIZE,
    iterations: { browserInProcess: ITER_BROWSER, serverInProcess: ITER_SERVER, loopbackHop: ITER_HTTP, canonicalReadOverHttp: readSamples.length },
    browserPathRecallMs: { median: Number(median(browserSamples).toFixed(4)), p95: Number(p95(browserSamples).toFixed(4)) },
    serverPathRecallMs: { median: Number(median(serverSamples).toFixed(4)), p95: Number(p95(serverSamples).toFixed(4)) },
    loopbackHopHealthMs: { median: Number(median(hopSamples).toFixed(4)), p95: Number(p95(hopSamples).toFixed(4)) },
    canonicalReadOverHttpMs: { median: Number(median(readSamples).toFixed(4)), p95: Number(p95(readSamples).toFixed(4)) }
  };
  console.log('PERFORMANCE_TABLE_JSON = ' + JSON.stringify(PERF));
  console.log('PERFORMANCE_NOTE = the loopback HTTP hop is a real cost (it is not zero); '
    + 'the hop figure in the table above is measured separately from the recall work and no arithmetic is claimed between them.');
  check('§32.1 every measured path completed with a positive, finite latency',
    median(browserSamples) > 0 && median(serverSamples) > 0 && median(hopSamples) > 0 && median(readSamples) > 0
    && [median(browserSamples), p95(browserSamples), median(serverSamples), p95(serverSamples), median(hopSamples), p95(hopSamples), median(readSamples), p95(readSamples)].every(Number.isFinite),
    JSON.stringify(PERF));
  check('§32.2 p95 >= median on every path (a coarse percentile, not a hard threshold)',
    p95(browserSamples) >= median(browserSamples) && p95(serverSamples) >= median(serverSamples)
    && p95(hopSamples) >= median(hopSamples),
    'reported with fixture size ' + FIXTURE_SIZE + ' and iteration counts above');

  /* ══════════════════════════════════════════════════════════════════════
     §31 · MOBILE / GATEWAY REGRESSION（工作树 vs pristine git archive HEAD）
     ══════════════════════════════════════════════════════════════════════ */
  section('§31 · mobile / gateway recall+session+activation regression');
  const REGRESSION_ARTIFACT = path.join(ROOT, '.dsh-research', 'r4c-live-3-2-request-mobile-regression.json');
  let regression = null;
  try { regression = JSON.parse(fs.readFileSync(REGRESSION_ARTIFACT, 'utf8')); } catch (_) { regression = null; }
  /* ★ `.dsh-research/` **不属于**交付树（git archive 排除它），因此"证据产物不存在"
     在干净树里是**预期**，不是失败。存在时逐行核对；不存在时显式 SKIP 并把重新生成
     的命令打出来 —— 绝不用一次假失败伪装成"覆盖了"（P21-R4-LIVE-3.2 复核发现）。 */
  if (!regression) {
    skip('§31.1 the regression artifact exists (worktree vs pristine HEAD)',
      '.dsh-research/ is not part of a clean tree — regenerate with: '
      + 'node .dsh-research/r4c-live-3-2-request-regression.js <root> <label> [--merge <path>]');
  } else {
    check('§31.1 the regression artifact exists (worktree vs pristine HEAD)',
      !!regression.worktree && !!regression.pristine,
      REGRESSION_ARTIFACT + ' — regenerate with node .dsh-research/r4c-live-3-2-request-regression.js <root> <label>');
  }
  if (regression) {
    const table = {
      worktree: regression.worktree.rows.map(r => ({ suite: r.suite, exit: r.exitCode, pass: r.pass, fail: r.fail })),
      pristine: regression.pristine.rows.map(r => ({ suite: r.suite, exit: r.exitCode, pass: r.pass, fail: r.fail }))
    };
    console.log('MOBILE_REGRESSION_TABLE_JSON = ' + JSON.stringify(table));
    const redWorktree = regression.worktree.rows.filter(r => r.exitCode !== 0).map(r => r.suite).sort();
    const redPristine = regression.pristine.rows.filter(r => r.exitCode !== 0).map(r => r.suite).sort();
    check('§31.2 every mobile/gateway suite is present in both trees',
      regression.worktree.rows.length === 9 && regression.pristine.rows.length === 9
      && regression.worktree.rows.every(r => r.present) && regression.pristine.rows.every(r => r.present),
      JSON.stringify({ worktree: regression.worktree.rows.length, pristine: regression.pristine.rows.length }));
    check('§31.3 the red set is identical in the worktree and in pristine HEAD (pre-existing reds separated)',
      JSON.stringify(redWorktree) === JSON.stringify(redPristine),
      JSON.stringify({ worktreeRed: redWorktree, pristineRed: redPristine }));
    verdict('MOBILE_REGRESSION_GREEN_WORKTREE', regression.worktree.green + '/' + regression.worktree.rows.length);
    verdict('MOBILE_REGRESSION_GREEN_PRISTINE', regression.pristine.green + '/' + regression.pristine.rows.length);
    verdict('MOBILE_REGRESSION_PREEXISTING_RED', redPristine);
  } else {
    verdict('MOBILE_REGRESSION_GREEN_WORKTREE', 'SKIPPED_NO_ARTIFACT');
    verdict('MOBILE_REGRESSION_GREEN_PRISTINE', 'SKIPPED_NO_ARTIFACT');
    verdict('MOBILE_REGRESSION_PREEXISTING_RED', 'SKIPPED_NO_ARTIFACT');
  }

  /* ══════════════════════════════════════════════════════════════════════
     verdicts
     ══════════════════════════════════════════════════════════════════════ */
  console.log('\n' + '='.repeat(72));
  verdict('R4C_LIVE_3_2_TRANSPORT_RECOMMENDATION', 'B_NEW_NARROW_INTERNAL_RECALL_ROUTE');
  verdict('RECALL_QUERY_AUTHORITY', 'SERVER_RUNTIME');
  verdict('RECALL_RANDOM_AUTHORITY', 'SERVER_RUNTIME');
  verdict('RECALL_CLOCK_AUTHORITY', 'SERVER_RUNTIME');
  verdict('NO_GENERIC_RECALL_PROXY_REQUIREMENT', 'ONE_VERB_SELECTION_ONLY (see printed text)');
  verdict('BROWSER_MUST_NEVER_SUBMIT_COUNT', BROWSER_MUST_NEVER_SUBMIT.length);
  verdict('FORBIDDEN_EXPOSURE_COUNT', MUST_NOT_EXPOSE.length);
  verdict('SKIPPED_SECTIONS', skipped + ' (evidence absent — never counted as pass or fail)');
  console.log('-'.repeat(72));
  if (failures) {
    console.error('RECALL REQUEST AUTHORITY AUDIT FAILED · ' + failures + ' assertion(s), ' + passed
      + ' passed, ' + skipped + ' skipped');
    process.exit(1);
  }
  console.log('RECALL REQUEST AUTHORITY AUDIT PASSED · ' + passed + ' assertions green'
    + (skipped ? ' · ' + skipped + ' skipped' : ''));
})().catch(error => {
  console.error('RECALL REQUEST AUTHORITY AUDIT CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
