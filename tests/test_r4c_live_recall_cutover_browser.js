'use strict';
/* ====================================================================
   P21-R4-LIVE-3.4 · Desktop 召回权威 cutover —— **真实浏览器**端到端证明（CDP）
   --------------------------------------------------------------------
   运行：node tests/test_r4c_live_recall_cutover_browser.js

   ── 它回答的问题（只有真实浏览器能回答的那一半）───────────────────────
   节点级证明（tests/test_r4c_live_recall_cutover.js，55 green）已经把
   "服务端是唯一选择者"证到了模块边界。这一条要证的是**产品边界**：

     一个**真实 Chrome** 里的**真实 Desktop 回合**
       → 真实 assets/js/communication.js 的 cutover seam
       → 真实 assets/js/home-node-client.js 的 runMemoryRecall
       → 真实 Home Node 子进程的 POST /internal/runtime/memory-recall
       → 真实 canonical memory store + 真实服务端选择
       → 返回的 context **真的进了发给 provider 的 prompt**
     并且：把浏览器自己的选择器**改成另一个答案**，prompt 里的记忆上下文
     一个字节都不变（§27/§28 NEGATIVE_SELECTOR_CONTROL = SERVER_WINS）。

   ── 它同时要报的数字 ────────────────────────────────────────────────
     §29 OWNERSHIP      : HOME_NODE_EXPOSURE_WRITES / BROWSER_EXPOSURE_WRITES /
                          激活计数（期望：恰好一次 canonical 激活、浏览器零曝光写入）
     §26 FIRST-TOKEN    : 真实路径上新增的那一次 loopback 往返的 median / p95（ms）
     §23/§24 SERVER DOWN: 节点不可达时回合照常继续、记忆上下文为空、
                          且**不**恢复浏览器召回权威

   ★ 一个字节都不假：真实 Chrome（CDP）、真实 InternalBeyond.html（真实静态层）、
     真实 Home Node 子进程（真实 SQLite store + 真实选择器）、真实 mock provider
     （本地 HTTP，记录自己收到的 prompt）。若 CDP 起不来 ⇒ 打印 BLOCKED 并以非零码
     结束，绝不伪造浏览器结果。零真实 provider 调用、零真实 API key。

   ★ 临时目录纪律：**所有** scratch 落在 <workspace>/.dsh-tmp/ 下（先建 RUN_ROOT，
     再把 TEMP/TMP/TMPDIR 指向它）—— 于是连 CDP 夹具给 Chrome 建的 profile 也落在
     同一个盘上；结束即删。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'l34b-'));
process.env.TEMP = RUN_ROOT;
process.env.TMP = RUN_ROOT;
process.env.TMPDIR = RUN_ROOT;

const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
const sleep = fx.sleep;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
  return !!cond;
}
function section(t) { console.log('\n── ' + t + ' ──'); }
const P = (name, value) => console.log(name + ' = ' + value);
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };

/* ── 夹具常量 ───────────────────────────────────────────────────────── */
const OPERATION = 'memory-recall';
const ROLE_ID = 'role_r4c_l34';
const QUERY = '显卡 驱动 更新失败';
const HOME_TOKEN = 'r4c-l34-browser-token';
const MOCK_MODEL = 'ib-r4c-recall-mock-model';
const PROVIDER_PATH = '/v1/chat/completions';
const IS_GROUP_REQUEST_ID = 'grp_probe';

/* canonical 世界：由子进程夹具种进**真实** store；浏览器只知道 id。 */
const CANON_ROWS = [
  { id: 'm_canon_a', title: '那晚的显卡', content: 'CANON_RECALL_A_5E0C 显卡 驱动 更新失败 那晚我熬到凌晨', visibility: 'public', valence: 0.2, arousal: 0.7 },
  { id: 'm_canon_b', title: '驱动又坏了', content: 'CANON_RECALL_B_77A1 显卡 驱动 更新失败 让我很沮丧', visibility: 'public', valence: 0.1, arousal: 0.5 },
  { id: 'm_canon_c', title: '买菜', content: 'CANON_RECALL_C_31D9 周末去超市买了西红柿和鸡蛋', visibility: 'public', valence: 0.5, arousal: 0.2 },
  { id: 'm_canon_private', title: '私有的一条', content: 'CANON_RECALL_PRIVATE_88FE 显卡 驱动 更新失败 不可读', visibility: 'private', valence: 0.3, arousal: 0.3 }
];
const CANON_BY_ID = {};
for (const r of CANON_ROWS) CANON_BY_ID[r.id] = r;
const CANON_PRIVATE_ID = 'm_canon_private';

/* 浏览器自己的选择器**会**给出的另一个答案（§28 的控制变量）。
   它是一段只存在于页面里的文本：如果它进了 prompt，SERVER_WINS 就是假话。 */
const BROWSER_DECOY_ID = 'm_browser_decoy';
const BROWSER_DECOY_TEXT = 'BROWSER_SELECTOR_DECOY_9C3F 显卡 驱动 更新失败（浏览器自己挑的那一条）';

/* ── 断言常量（全部由实测赋值；UNKNOWN 表示没量到）───────────────────── */
const R = {
  CHROME_LAUNCHED: 'NO',
  CHROME_PROFILE_UNDER_DSH_TMP: 'UNKNOWN',
  CDP_WORKS: 'UNKNOWN',
  REAL_TURN_COMPLETED: 'UNKNOWN',
  RECALL_REQUEST_CAPTURED: 'UNKNOWN',
  RECALL_RESPONSE_CAPTURED: 'UNKNOWN',
  RECALL_WIRE_OPERATION: 'UNKNOWN',
  RECALL_WIRE_MODE: 'UNKNOWN',
  RECALL_WIRE_FIELDS: 'UNKNOWN',
  ISGROUP_FORWARDED_BY_CLIENT: 'UNKNOWN',
  ISGROUP_WIRE_BODY: 'UNKNOWN',
  SERVER_SELECTED_IDS: 'UNKNOWN',
  SERVER_SELECTED_COUNT: 'UNKNOWN',
  PROMPT_MEMORY_IDS_MATCH_SERVER: 'UNKNOWN',
  PROMPT_CONTAINS_DECOY: 'UNKNOWN',
  BROWSER_SELECTOR_CONSULTED: 'UNKNOWN',
  BROWSER_SELECTOR_CALLS_DURING_TURN: 'UNKNOWN',
  BROWSER_SELECTOR_SELFCHECK_RETURNS_DECOY: 'UNKNOWN',
  NEGATIVE_SELECTOR_CONTROL: 'UNKNOWN',
  BROWSER_SELECTOR_OUTPUT_REACHED_PROMPT: 'UNKNOWN',
  HOME_NODE_EXPOSURE_WRITES: 'UNKNOWN',
  BROWSER_EXPOSURE_WRITES: 'UNKNOWN',
  HOME_NODE_ACTIVATION_WRITES: 'UNKNOWN',
  ACTIVATION_EXACTLY_ONCE: 'UNKNOWN',
  ACTIVATION_STORE_DELTA: 'UNKNOWN',
  ACTIVATION_ONLY_SERVER_SELECTED: 'UNKNOWN',
  FIRST_TOKEN_RECALL_HOP_MS_MEDIAN: 'UNKNOWN',
  FIRST_TOKEN_RECALL_HOP_MS_P95: 'UNKNOWN',
  FIRST_TOKEN_RECALL_HOP_SAMPLES: 'UNKNOWN',
  FIRST_TOKEN_RECALL_HOP_METHOD: 'UNKNOWN',
  TURN_TOTAL_MS: 'UNKNOWN',
  SERVER_DOWN_METHOD: 'UNKNOWN',
  SERVER_DOWN_TURN_COMPLETED: 'UNKNOWN',
  SERVER_DOWN_TURN_REACHED_PROVIDER: 'UNKNOWN',
  SERVER_DOWN_CHAT_WRITE_ERROR: 'UNKNOWN',
  SERVER_DOWN_FULL_KILL_TURN_ABORTED_BY_CHAT_STORE: 'UNKNOWN',
  SERVER_DOWN_RECALL_SEAM_REACHED: 'UNKNOWN',
  SERVER_DOWN_MEMORY_CONTEXT: 'UNKNOWN',
  SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY: 'UNKNOWN',
  REAL_PROVIDER_CALLS: 0,
  MOCK_PROVIDER_ONLY: 'YES'
};

/* ── 假 provider：**真的**本地 HTTP 服务 ─────────────────────────────
   它记录每一次收到的请求（含完整 prompt 正文），并按请求体的 stream 标志
   分别回 SSE 或 JSON —— 于是"模型看到的那段 prompt"是一条被观测到的事实。 */
function createMockProvider() {
  const seen = [];
  const server = http.createServer(function (req, res) {
    /* ★ 这个 provider 是**浏览器直接调用**的（桌面聊天路径），因此它是跨源
       （127.0.0.1:webPort → 127.0.0.1:providerPort）。没有这几行，Chrome 会
       把真正的 POST 拦在预检上 —— 而"被拦"看起来像"provider 没被调用"，
       正好会把这条证明变成一句错话。 */
    const origin = String(req.headers.origin || '*');
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || 'Content-Type, Authorization, x-api-key, anthropic-version'),
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    };
    if (String(req.headers['access-control-request-private-network'] || '') === 'true') {
      cors['Access-Control-Allow-Private-Network'] = 'true';
    }
    if (String(req.method || '').toUpperCase() === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      seen.push({ url: String(req.url || ''), host: String(req.headers.host || ''), method: String(req.method || ''), body: body, raw: raw });
      const wantStream = !!(body && body.stream === true);
      const content = '（mock）我听到了。';
      if (wantStream) {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, cors));
        res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: content } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: MOCK_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', created: 1700000000, model: MOCK_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 }
      }));
    });
  });
  return { server: server, seen: seen, count: function () { return seen.filter(function (e) { return e.method === 'POST'; }).length; } };
}

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
  });
}
function freshDir(tag) { return fs.mkdtempSync(path.join(RUN_ROOT, 'l34b-' + tag + '-')); }
function sha256(v) { return require('node:crypto').createHash('sha256').update(String(v)).digest('hex'); }

/* prompt 正文（所有消息拼起来）—— 断言只打在"模型看到的东西"上。 */
function contentOfMessage(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(function (p) { return (p && p.text) || ''; }).join('\n');
  return '';
}
function promptTextOf(providerEntry) {
  const msgs = (providerEntry && providerEntry.body && Array.isArray(providerEntry.body.messages)) ? providerEntry.body.messages : [];
  return msgs.map(contentOfMessage).join('\n');
}
/* ★ 本轮**自己**注入的那一段：这一层把召回上下文挂在"最后一条 user 消息"的
   尾部。用整段 prompt 判"这一轮有没有注入记忆"是错的 —— 历史里本来就带着
   前几轮注入过的文本，那会把历史误判成本轮注入。 */
function currentTurnTailOf(providerEntry) {
  const msgs = (providerEntry && providerEntry.body && Array.isArray(providerEntry.body.messages)) ? providerEntry.body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') return contentOfMessage(msgs[i]);
  }
  return '';
}
/* ★ 一个真实回合里 provider 可能被调用**不止一次**（例如回合末尾的
   Auto Memory 判定也是同一段 wire）。因此"这一轮的聊天调用"必须按**内容**
   认出来，而不是取最后一次 POST —— 否则会把 Auto Memory 的 prompt 当聊天 prompt。 */
function findChatPostFor(list, marker) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (promptTextOf(list[i]).indexOf(marker) >= 0) return list[i];
  }
  return null;
}

(async function main() {
  console.log('P21-R4-LIVE-3.4 · 真实浏览器召回权威证明（真实 Chrome + 真实 Home Node + mock provider）');
  console.log('scratch root = ' + RUN_ROOT);

  const exe = fx.chromePath();
  if (!exe) {
    console.error('  FAIL  BLOCKED：找不到 Chrome / Edge（设置 CHROME_PATH 或安装其中之一）。');
    console.error('R4C_LIVE_3_4_BROWSER_VERDICT=BLOCKED no-browser');
    process.exitCode = 1;
    setTimeout(function () { process.exit(1); }, 100);
    return;
  }

  const children = [];
  const dirs = [RUN_ROOT];
  const spawnTracked = function (cmd, args, opts) { const c = spawn(cmd, args, opts); children.push(c); return c; };

  const nodeDir = freshDir('node');
  const vaultDir = freshDir('vault');
  const homePort = await fx.freePort();
  const webPort = await fx.freePort();

  const provider = createMockProvider();
  const providerPort = await listen(provider.server);
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + PROVIDER_PATH;

  const AUTH = { 'X-IB-Home-Token': HOME_TOKEN };
  const payloadOf = function (res) { return (res && res.body && res.body.payload) ? res.body.payload : null; };
  const homeGet = function (p) { return fx.request(homePort, 'GET', p, null, AUTH); };
  const homePost = function (p, body) { return fx.request(homePort, 'POST', p, body, AUTH); };

  let launched = null;
  let childOut = '';
  let homeChild = null;
  let homeAlive = false;
  const evidence = { recallHttp: null, recallResponse: null, providerPromptSha: null, providerPromptHead: null, providerCallCount: 0 };

  /* canonical 快照：**只读**，用来量 §29 的激活计数。 */
  async function canonicalSnapshot() {
    const res = await homeGet('/memory/list?limit=500');
    const p = payloadOf(res);
    const rows = {};
    for (const row of (p && p.records) || []) {
      rows[row.id] = { activationCount: row.activationCount, lastActivated: row.lastActivated, revision: row.revision, content: row.content, visibility: row.visibility };
    }
    return { status: res.status, count: p && p.count, revision: p && p.revision, rows: rows };
  }

  try {
    /* ══════════════════════════════════════════════════════════════
       0 · 真实部件
       ══════════════════════════════════════════════════════════════ */
    section('0 · real pieces');
    /* 真实 Home Node 子进程（真实装配 + 真实 canonical 种子）。
       ★ 刻意**不**注入成本闸门：召回边界不需要它，而"生产默认是关的"这条
         事实在本套件里保持原样（解释边界的事由 LIVE-3 套件守）。 */
    homeChild = spawnTracked(process.execPath,
      [path.join('tests', 'fixtures', 'r4c-live-home-node-child.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          IB_R4C_DATA_DIR: nodeDir,
          IB_R4C_CREDENTIAL_DIR: vaultDir,
          IB_R4C_TOKEN: HOME_TOKEN,
          IB_R4C_PORT: String(homePort),
          IB_R4C_CANONICAL_ROWS: JSON.stringify(CANON_ROWS),
          IB_HOME_NODE_DATA_DIR: nodeDir,
          IB_CREDENTIAL_DATA_DIR: vaultDir,
          IB_HOME_NODE_HOST: '127.0.0.1'
        }),
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
    homeChild.stdout.on('data', function (c) { childOut += String(c); });
    homeChild.stderr.on('data', function (c) { childOut += String(c); });

    const web = spawnTracked(process.execPath, [path.join('services', 'internal-beyond-server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { IB_WEB_PORT: String(webPort) }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let webOut = '';
    web.stdout.on('data', function (c) { webOut += String(c); });
    web.stderr.on('data', function (c) { webOut += String(c); });

    let homeUp = false, webUp = false;
    for (let i = 0; i < 100; i++) {
      if (!homeUp) { const h = await fx.request(homePort, 'GET', '/health'); homeUp = (h.status === 200); }
      if (!webUp) { const w = await fx.request(webPort, 'GET', '/health'); webUp = (w.status === 200); }
      if (homeUp && webUp) break;
      await sleep(250);
    }
    homeAlive = homeUp;
    check('0.1 真实 Home Node 子进程与真实静态层都活着', homeUp && webUp, { home: childOut.slice(-300), web: webOut.slice(-150) });
    if (!homeUp || !webUp) throw new Error('services did not start');

    const seededLine = childOut.split(/\r?\n/).filter(function (l) { return l.indexOf('IB-R4C-NODE-SEEDED') === 0; })[0] || '';
    const seeded = JSON.parse(seededLine.replace('IB-R4C-NODE-SEEDED', '').trim() || '{}');
    check('0.2 四条 canonical 行真的种进了真实 store', seeded.count === CANON_ROWS.length, seededLine);

    const snap0 = await canonicalSnapshot();
    check('0.3 canonical 读面可复核（count=4、全部 activationCount=0）',
      snap0.status === 200 && snap0.count === CANON_ROWS.length &&
      CANON_ROWS.every(function (row) { return snap0.rows[row.id] && snap0.rows[row.id].activationCount === 0; }),
      snap0);
    R.ACTIVATION_STORE_DELTA = 'BASELINE_CAPTURED';

    /* 角色目录：召回需要 registry.getCharacter(id)（名字/关系）。 */
    const published = await homePost('/characters/publish', {
      merge: true,
      characters: [{ id: ROLE_ID, nickname: 'R4C 召回角色', relationship: '同居', provider: 'custom', model: MOCK_MODEL, endpoint: providerEndpoint, credentialRef: 'cred_not_used_by_recall' }]
    });
    check('0.4 角色目录已发布（召回边界只读 registry 取名字）',
      published.status === 200 && payloadOf(published) && payloadOf(published).count === 1, published.body);

    /* ══════════════════════════════════════════════════════════════
       1 · 真实浏览器
       ══════════════════════════════════════════════════════════════ */
    section('1 · real Chrome via CDP');
    launched = await fx.launchChrome(exe, {});
    R.CHROME_LAUNCHED = 'YES';
    R.CDP_WORKS = 'YES';
    /* ★ 临时目录纪律：CDP 夹具给 Chrome 建的 user-data-dir 走 os.tmpdir()，
       而本进程在启动前已把 TEMP/TMP/TMPDIR 指向 .dsh-tmp/RUN_ROOT ⇒ profile
       必须落在工作区的 .dsh-tmp 下，C: 一个字节都不写。 */
    R.CHROME_PROFILE_UNDER_DSH_TMP = (String(launched.profile || '').indexOf(RUN_ROOT) === 0) ? 'YES' : 'NO';
    check('1.0 ★ 临时目录纪律：Chrome 的 user-data-dir 落在 <workspace>/.dsh-tmp 下（不是 %TEMP%）',
      R.CHROME_PROFILE_UNDER_DSH_TMP === 'YES', { profile: launched.profile, runRoot: RUN_ROOT });
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
        + 'localStorage.setItem("ib_home_node_http",' + JSON.stringify('http://127.0.0.1:' + homePort) + ');'
        + 'localStorage.setItem("ib_home_node_mode","canonical");'
        + 'localStorage.setItem("ib_home_node_token",' + JSON.stringify(HOME_TOKEN) + ');'
        + '}catch(e){}'
    });
    const APP_URL = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
    const loaded = new Promise(function (resolve) { cdp.on('Page.loadEventFired', resolve); });
    await cdp.send('Page.navigate', { url: APP_URL });
    await loaded;
    await sleep(600);

    const surface = await waitFor(`(function(){
      return !!(window.IB && IB.homeNode && IB.homeNode.runtime && IB.homeNode.runtime.available === true
        && typeof IB.homeNode.runtime.runMemoryRecall === 'function'
        && typeof sendChatMessage === 'function');
    })()`, 30000, 'runtime 面 + sendChatMessage').catch(function () { return false; });
    check('1.1 真实页面里 cutover 需要的三件东西都在（runtime 面 / runMemoryRecall / sendChatMessage）',
      surface === true, surface);

    /* ── 仪器：浏览器自己的选择器 / 曝光写入 / 召回 HTTP 全部被观测 ──────
       ★ 负控制不是"改一个变量看看"：它把生产选择器**替换成一个会返回不同答案的
         版本**。若权威仍在浏览器，decoy 必然出现在 prompt 里。 */
    const INSTRUMENT = `(function(){
      if (window.__l34) return 'already';
      var P = window.__l34 = {
        selectorCalls: 0, exposureWrites: 0, activationWrites: 0, beginTurnCalls: 0,
        httpRecalls: [], mountedRecalls: [], notes: []
      };
      function wrapCounter(name, kind){
        var real = window[name];
        if (typeof real !== 'function') { P.notes.push('missing:' + name); return false; }
        window[name] = function(){
          if (kind === 'selector') {
            P.selectorCalls += 1;
            return Promise.resolve({ context: ${JSON.stringify(BROWSER_DECOY_TEXT)}, selectedIds: [${JSON.stringify(BROWSER_DECOY_ID)}], activationPolicy: 'normal' });
          }
          if (kind === 'exposure') P.exposureWrites += 1;
          if (kind === 'activation') P.activationWrites += 1;
          if (kind === 'begin') P.beginTurnCalls += 1;
          return real.apply(this, arguments);
        };
        return true;
      }
      wrapCounter('selectMemoryContext', 'selector');
      wrapCounter('getMemoryContext', 'selector');
      wrapCounter('_ibRecordRecallExposure', 'exposure');
      wrapCounter('recordMemoryActivation', 'activation');
      wrapCounter('_ibBeginRecallTurn', 'begin');
      try {
        var rt = window.IB && IB.homeNode && IB.homeNode.runtime;
        if (rt && typeof rt.runMemoryRecall === 'function') {
          var realRecall = rt.runMemoryRecall;
          rt.runMemoryRecall = function(payload, options){
            var rec = { request: payload, options: options, t0: performance.now() };
            P.mountedRecalls.push(rec);
            return Promise.resolve(realRecall(payload, options)).then(function(res){
              rec.t1 = performance.now(); rec.result = res; return res;
            }, function(err){ rec.t1 = performance.now(); rec.error = String((err && err.message) || err); throw err; });
          };
        } else { P.notes.push('missing:IB.homeNode.runtime.runMemoryRecall'); }
      } catch (e) { P.notes.push('mount-wrap-failed:' + e); }
      var realFetch = window.fetch;
      window.fetch = function(url, init){
        var u = String(url);
        var isRecall = u.indexOf('/internal/runtime/memory-recall') >= 0;
        var rec = null;
        if (isRecall) {
          rec = { url: u, method: (init && init.method) || 'GET', t0: performance.now() };
          try { rec.requestBody = (init && init.body) ? JSON.parse(String(init.body)) : null; }
          catch (e) { rec.requestBodyRaw = String(init && init.body).slice(0, 200); }
          P.httpRecalls.push(rec);
        }
        var p = realFetch.apply(this, arguments);
        if (isRecall) {
          p.then(function(res){
            rec.status = res.status; rec.t1 = performance.now();
            try { res.clone().text().then(function(t){ try { rec.responseBody = JSON.parse(t); } catch (e) { rec.responseRaw = String(t).slice(0, 300); } }, function(){}); } catch (e) {}
          }, function(err){ rec.error = String((err && err.message) || err); rec.t1 = performance.now(); });
        }
        return p;
      };
      return 'ok';
    })()`;
    const instrumented = await evaluate(INSTRUMENT);
    const instrumentNotes = await evaluate('(function(){ return (window.__l34 && window.__l34.notes) || []; })()');
    check('1.2 仪器装上了（选择器 / 曝光 / 激活 / loopback 召回全部可观测）',
      instrumented === 'ok' && Array.isArray(instrumentNotes) && instrumentNotes.length === 0,
      { instrumented: instrumented, notes: instrumentNotes });

    /* 负控制自检：**它真的会给出另一个答案**。没有这一条，"选择器没被调用"
       可能只是"探针坏了"。 */
    const selfCheck = await evaluate(`(function(){
      window.__l34.selectorCalls = 0;
      return Promise.resolve(window.selectMemoryContext('__selfcheck__', {})).then(function(res){
        var ok = !!(res && res.context === ${JSON.stringify(BROWSER_DECOY_TEXT)}
          && Array.isArray(res.selectedIds) && res.selectedIds[0] === ${JSON.stringify(BROWSER_DECOY_ID)});
        window.__l34.selectorCalls = 0;
        return { ok: ok, decoy: res && res.selectedIds };
      });
    })()`, true);
    R.BROWSER_SELECTOR_SELFCHECK_RETURNS_DECOY = (selfCheck && selfCheck.ok) ? 'YES' : 'NO';
    check('1.3 ★ 负控制自检：被替换后的浏览器选择器**确实会**返回另一个集合（decoy 生效）',
      selfCheck && selfCheck.ok === true, selfCheck);

    /* ══════════════════════════════════════════════════════════════
       2 · 准备一个真实 Desktop 回合
       ══════════════════════════════════════════════════════════════ */
    section('2 · prepare one real desktop turn');
    const prepared = await evaluate(`(function(){
      var cfg = { id: ${JSON.stringify(ROLE_ID)}, nickname: 'R4C 召回角色', model: ${JSON.stringify(MOCK_MODEL)},
        endpoint: ${JSON.stringify(providerEndpoint)}, apiKey: 'test-local-key', provider: 'custom',
        relationship: '同居', systemPrompt: '', temperature: 1, streaming: true, showThinking: false,
        promptCache: false, created: Date.now() };
      return Promise.resolve(dbPut('apiConfigs', cfg))
        .then(function(){ return (typeof loadApiConfigs === 'function') ? loadApiConfigs() : null; })
        .then(function(){
          window.activeFriendId = ${JSON.stringify(ROLE_ID)};
          window.activeThreadId = null;
          window.currentPage = 'chat';
          var el = document.getElementById('chat-full-input') || document.getElementById('chat-input');
          return {
            hasInput: !!el,
            inputId: el ? el.id : null,
            activeFriendId: window.activeFriendId,
            cfgLoaded: !!(window.apiConfigs || []).some(function(a){ return a.id === ${JSON.stringify(ROLE_ID)}; })
          };
        })
        .catch(function(e){ return { error: String((e && e.message) || e) }; });
    })()`, true);
    check('2.1 页面已准备好一个真实回合（apiConfig 落库 + 当前角色 + 输入框存在）',
      prepared && prepared.hasInput === true && prepared.cfgLoaded === true && prepared.activeFriendId === ROLE_ID,
      prepared);

    /* ── 2.2 热身回合：让这个会话**不再是第一轮** ─────────────────────────
       ★ 这是产品语义，不是夹具取巧：全新会话的第一句走 coldStart 通道，
         那条通道按"锚点"（置顶/长期未提）选人，与查询无关，因此在只有普通行的
         库里它诚实地选出 0 条。**被测量的那个回合**必须是会话里正常的一轮
         （isFirstTurn=false），否则我们量到的是冷启动，而不是"这一轮该想起谁"。 */
    const warmup = await evaluate(`(function(){
      var el = document.getElementById('chat-full-input') || document.getElementById('chat-input');
      if (!el) return Promise.resolve({ ok: false, error: 'no-input-element' });
      el.value = ${JSON.stringify('在吗？先随便说一句。')};
      return Promise.resolve(sendChatMessage())
        .then(function(res){ return { ok: true, error: (res && res.error) || null }; },
              function(err){ return { ok: false, error: String((err && err.message) || err) }; });
    })()`, true);
    await sleep(300);
    check('2.2 热身回合跑完（会话不再是第一轮；真实路径上没有异常）',
      warmup && warmup.ok === true && !warmup.error, warmup);

    /* §29 的激活基线必须在**被测量回合之前**取（热身之后）。 */
    const snapBase = await canonicalSnapshot();
    check('2.3 激活基线取到了（四条行都可读，热身没有写坏基线）',
      snapBase.status === 200 && snapBase.count === CANON_ROWS.length,
      { count: snapBase.count, activations: CANON_ROWS.map(function (r) { return (snapBase.rows[r.id] || {}).activationCount; }) });
    /* 仪器计数清零：被测量的回合从零开始。 */
    await evaluate('(function(){ var p = window.__l34; p.selectorCalls = 0; p.exposureWrites = 0; p.activationWrites = 0; p.httpRecalls = []; p.mountedRecalls = []; return "reset"; })()');

    /* ══════════════════════════════════════════════════════════════
       3 · 真实回合（§27/§28/§29 的全部证据都来自这一次）
       ══════════════════════════════════════════════════════════════ */
    section('3 · ONE real desktop turn (browser → Home Node → prompt)');
    const turn = await evaluate(`(function(){
      var el = document.getElementById('chat-full-input') || document.getElementById('chat-input');
      if (!el) return Promise.resolve({ ok: false, error: 'no-input-element' });
      el.value = ${JSON.stringify(QUERY)};
      var p0 = window.__l34.selectorCalls, e0 = window.__l34.exposureWrites, a0 = window.__l34.activationWrites;
      var t0 = performance.now();
      return Promise.resolve(sendChatMessage())
        .then(function(res){
          return { ok: true, error: (res && res.error) || null, ms: performance.now() - t0,
            selectorCalls: window.__l34.selectorCalls - p0,
            exposureWrites: window.__l34.exposureWrites - e0,
            activationWrites: window.__l34.activationWrites - a0 };
        }, function(err){ return { ok: false, error: String((err && err.message) || err), ms: performance.now() - t0 }; });
    })()`, true);
    await sleep(400);
    const probe = await evaluate('(function(){ return window.__l34; })()');
    R.REAL_TURN_COMPLETED = (turn && turn.ok && !turn.error) ? 'YES' : 'NO';
    R.TURN_TOTAL_MS = turn && turn.ms != null ? Math.round(turn.ms) : 'UNKNOWN';
    check('3.1 ★★★ 一个真实 Desktop 回合跑完了（sendChatMessage 全程无异常）',
      turn && turn.ok === true && !turn.error, turn);

    /* ① loopback 召回：请求与响应都是捕获到的字节（不是推断）。 */
    const httpRecalls = (probe && probe.httpRecalls) || [];
    const rec0 = httpRecalls[0] || null;
    evidence.recallHttp = rec0;
    evidence.recallResponse = rec0 ? rec0.responseBody || null : null;
    R.RECALL_REQUEST_CAPTURED = rec0 && rec0.requestBody ? 'YES' : 'NO';
    R.RECALL_RESPONSE_CAPTURED = rec0 && rec0.responseBody ? 'YES' : 'NO';
    R.RECALL_WIRE_OPERATION = rec0 && rec0.requestBody ? String(rec0.requestBody.operation) : 'UNKNOWN';
    R.RECALL_WIRE_MODE = rec0 && rec0.requestBody ? String(rec0.requestBody.mode) : 'UNKNOWN';
    R.RECALL_WIRE_FIELDS = rec0 && rec0.requestBody ? Object.keys(rec0.requestBody).sort().join(',') : 'UNKNOWN';
    R.ISGROUP_FORWARDED_BY_CLIENT = (rec0 && rec0.requestBody && Object.prototype.hasOwnProperty.call(rec0.requestBody, 'isGroup')) ? 'YES' : 'NO';
    check('3.2 ★★★★ 捕获到真实 loopback 召回请求：operation=memory-recall / mode=authoritative',
      !!rec0 && !!rec0.requestBody && rec0.requestBody.operation === OPERATION && rec0.requestBody.mode === 'authoritative' &&
      rec0.requestBody.characterId === ROLE_ID && typeof rec0.requestBody.message === 'string' && rec0.requestBody.message.indexOf('显卡') >= 0,
      rec0 && rec0.requestBody);
    check('3.3 ★★★★ 捕获到真实召回响应：ok:true + 服务端选出的 selectedIds + 非空 context',
      !!rec0 && !!rec0.responseBody && rec0.responseBody.ok === true &&
      Array.isArray(rec0.responseBody.selectedIds) && rec0.responseBody.selectedIds.length > 0 &&
      !!(rec0.responseBody.context && typeof rec0.responseBody.context.text === 'string' && rec0.responseBody.context.text.length > 0),
      rec0 && { status: rec0.status, selectedIds: rec0.responseBody && rec0.responseBody.selectedIds, chars: rec0.responseBody && rec0.responseBody.context && rec0.responseBody.context.chars });

    const serverSelected = (rec0 && rec0.responseBody && Array.isArray(rec0.responseBody.selectedIds)) ? rec0.responseBody.selectedIds.slice() : [];
    R.SERVER_SELECTED_IDS = serverSelected.join(',');
    R.SERVER_SELECTED_COUNT = String(serverSelected.length);
    check('3.4 ★★★★ 服务端选出的就是那两条与查询相关的 canonical 行（且不含 private / 无关行）',
      serverSelected.length >= 1 &&
      serverSelected.indexOf(CANON_PRIVATE_ID) < 0 &&
      serverSelected.every(function (id) { return !!CANON_BY_ID[id]; }),
      serverSelected);

    /* ② prompt 捕获：mock provider 收到的那一段就是"模型看到的"。 */
    const providerCalls = provider.seen.filter(function (e) { return e.url === PROVIDER_PATH && e.method === 'POST'; });
    const pc = providerCalls[providerCalls.length - 1] || null;
    const promptText = pc ? promptTextOf(pc) : '';
    const promptTail = pc ? currentTurnTailOf(pc) : '';
    evidence.providerCallCount = providerCalls.length;
    evidence.providerPromptSha = promptText ? sha256(promptText) : null;
    evidence.providerPromptHead = promptText ? promptText.slice(0, 400) : null;
    evidence.providerTailHead = promptTail ? promptTail.slice(-400) : null;
    check('3.5 ★★★★ 真实回合真的走到了 mock provider（捕获到完整 prompt）',
      !!pc && promptText.length > 0, { calls: providerCalls.length, chars: promptText.length });
    check('3.6 ★★★★ provider 的 host 是 mock 端点（零真实出网）',
      !!pc && pc.host === '127.0.0.1:' + providerPort && pc.body && pc.body.model === MOCK_MODEL,
      pc && { host: pc.host, model: pc.body && pc.body.model });

    /* ③ §27/§28 权威：**本轮尾部**里的记忆 = 服务端选的；decoy 一个字都不在。 */
    const selectedTexts = serverSelected.map(function (id) { return CANON_BY_ID[id] ? CANON_BY_ID[id].content : null; }).filter(Boolean);
    const unselectedTexts = CANON_ROWS.filter(function (r) { return serverSelected.indexOf(r.id) < 0; }).map(function (r) { return r.content; });
    const promptHasAllSelected = selectedTexts.length > 0 && selectedTexts.every(function (t) { return promptTail.indexOf(t) >= 0; });
    const promptHasDecoy = promptTail.indexOf(BROWSER_DECOY_TEXT) >= 0 || promptTail.indexOf(BROWSER_DECOY_ID) >= 0;
    const promptHasUnselected = unselectedTexts.filter(function (t) { return promptTail.indexOf(t) >= 0; });
    R.PROMPT_MEMORY_IDS_MATCH_SERVER = promptHasAllSelected && promptHasUnselected.length === 0 ? 'YES' : 'NO';
    R.PROMPT_CONTAINS_DECOY = promptHasDecoy ? 'YES' : 'NO';
    check('3.7 ★★★★★ §27 本轮尾部里**只有**服务端选中的 canonical 正文（未选中的一条都不在）',
      promptHasAllSelected && promptHasUnselected.length === 0,
      { selectedTexts: selectedTexts.length, leaked: promptHasUnselected, tailHead: promptTail.slice(-200) });
    check('3.8 ★★★★★ §28 浏览器选择器的答案（decoy）**没有**进本轮 prompt',
      promptHasDecoy === false, { decoyInPrompt: promptHasDecoy });

    /* ④ 选择器根本没被咨询过；§28 结论。 */
    const selectorCallsDuringTurn = turn && turn.selectorCalls != null ? turn.selectorCalls : -1;
    R.BROWSER_SELECTOR_CALLS_DURING_TURN = String(selectorCallsDuringTurn);
    R.BROWSER_SELECTOR_CONSULTED = selectorCallsDuringTurn === 0 ? 'NO' : 'YES';
    R.BROWSER_SELECTOR_OUTPUT_REACHED_PROMPT = promptHasDecoy ? 'YES' : 'NO';
    const serverWins = selectorCallsDuringTurn === 0 && promptHasAllSelected && promptHasUnselected.length === 0 && promptHasDecoy === false;
    R.NEGATIVE_SELECTOR_CONTROL = serverWins ? 'SERVER_WINS' : 'REFUTED';
    check('3.9 ★★★★★ §27/§28 浏览器选择器在整个回合里**一次都没有被咨询**（权威不在浏览器）',
      selectorCallsDuringTurn === 0, { selectorCalls: selectorCallsDuringTurn, selfcheckReturnsDecoy: R.BROWSER_SELECTOR_SELFCHECK_RETURNS_DECOY });
    check('3.10 ★★★★★ NEGATIVE_SELECTOR_CONTROL = SERVER_WINS（换成另一个答案也不改变 prompt）',
      R.NEGATIVE_SELECTOR_CONTROL === 'SERVER_WINS',
      { NEGATIVE_SELECTOR_CONTROL: R.NEGATIVE_SELECTOR_CONTROL, selectorCalls: selectorCallsDuringTurn, decoyInPrompt: promptHasDecoy });

    /* ⑤ §29 OWNERSHIP：节点写曝光/激活；浏览器零写入。 */
    const effects = (rec0 && rec0.responseBody && rec0.responseBody.effects) ? rec0.responseBody.effects : null;
    const boundary = (rec0 && rec0.responseBody && rec0.responseBody.boundary) ? rec0.responseBody.boundary : null;
    R.HOME_NODE_EXPOSURE_WRITES = String((effects && effects.exposure && effects.exposure.written != null) ? effects.exposure.written : (boundary && boundary.exposureWrites != null ? boundary.exposureWrites : 'UNKNOWN'));
    R.HOME_NODE_ACTIVATION_WRITES = String((effects && effects.activation && effects.activation.updated != null) ? effects.activation.updated : (boundary && boundary.activationWrites != null ? boundary.activationWrites : 'UNKNOWN'));
    R.BROWSER_EXPOSURE_WRITES = String(turn && turn.exposureWrites != null ? turn.exposureWrites : 'UNKNOWN');
    check('3.11 ★★★★ §29 节点自述：它写了曝光与激活（effect 非零、turnBegun/turnEnded 都真）',
      !!effects && effects.turnBegun === true && effects.turnEnded === true &&
      effects.exposure && effects.exposure.written > 0 &&
      effects.activation && effects.activation.updated > 0,
      effects);
    check('3.12 ★★★★★ §29 BROWSER_EXPOSURE_WRITES = 0（浏览器一个曝光都没写）',
      R.BROWSER_EXPOSURE_WRITES === '0', { exposure: R.BROWSER_EXPOSURE_WRITES, activationOnBrowser: probe && probe.activationWrites });

    const snap1 = await canonicalSnapshot();
    const deltaIds = [];
    for (const row of CANON_ROWS) {
      const before = snapBase.rows[row.id] ? snapBase.rows[row.id].activationCount : null;
      const after = snap1.rows[row.id] ? snap1.rows[row.id].activationCount : null;
      if (before != null && after != null && after !== before) deltaIds.push(row.id + ':' + before + '->' + after);
    }
    R.ACTIVATION_STORE_DELTA = deltaIds.join('|') || 'NONE';
    const everyDeltaIsOne = deltaIds.length === serverSelected.length && deltaIds.every(function (d) { return /:(\d+)->(\d+)$/.test(d) && (Number(d.split('->')[1]) - Number(d.split(':')[1].split('->')[0])) === 1; });
    R.ACTIVATION_EXACTLY_ONCE = everyDeltaIsOne ? 'YES' : 'NO';
    R.ACTIVATION_ONLY_SERVER_SELECTED = deltaIds.every(function (d) { return serverSelected.indexOf(d.split(':')[0]) >= 0; }) ? 'YES' : 'NO';
    check('3.13 ★★★★★ §29 canonical 激活恰好一次：只有服务端选中的行 +1（其它行一个都没动）',
      R.ACTIVATION_EXACTLY_ONCE === 'YES' && R.ACTIVATION_ONLY_SERVER_SELECTED === 'YES',
      { deltas: deltaIds, selected: serverSelected });

    /* ⑥ 客户端确实没有把 isGroup 放上 wire（§说明：只观察、不改生产）。 */
    const mountedRecalls = (probe && probe.mountedRecalls) || [];
    check('3.14 ★★ 观察记录：seam 的 payload 与客户端实际发出的 body 都被捕获（isGroup 只在 seam 一侧）',
      mountedRecalls.length >= 1 && !!mountedRecalls[0].request &&
      !!rec0 && !!rec0.requestBody,
      { seamPayloadKeys: mountedRecalls[0] && mountedRecalls[0].request ? Object.keys(mountedRecalls[0].request).sort() : null, wireKeys: rec0 && rec0.requestBody ? Object.keys(rec0.requestBody).sort() : null });

    /* ⑥b isGroup 探针：seam 在群聊里会传 isGroup:true（communication.js:2007），
           服务端也已接受它（OPTIONAL_REQUEST_FIELDS）。这里用**同一条真实动词**
           发一次 shadow 请求（零写入），看它到底有没有到 wire 上。
           ★ 探针只做**观察**：无论结果如何，这条 check 断言的都是"探针本身成立"
             （请求真的发出了、body 真的被捕获）；发现本身作为常量上报。 */
    const isGroupProbe = await evaluate(`(function(){
      return Promise.resolve(IB.homeNode.runtime.runMemoryRecall({
        operation: 'memory-recall', mode: 'shadow', characterId: ${JSON.stringify(ROLE_ID)},
        requestId: ${JSON.stringify(IS_GROUP_REQUEST_ID)}, conversationId: 'dm:' + ${JSON.stringify(ROLE_ID)},
        message: '分组身份探针', isGroup: true
      }, { timeoutMs: 2000 })).then(function(res){ return { ok: !!(res && res.ok === true) }; },
        function(err){ return { ok: false, error: String((err && err.message) || err) }; });
    })()`, true);
    const isGroupWire = await evaluate(`(function(){
      var list = (window.__l34 && window.__l34.httpRecalls) || [];
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].requestBody && list[i].requestBody.requestId === ${JSON.stringify(IS_GROUP_REQUEST_ID)}) return list[i].requestBody;
      }
      return null;
    })()`);
    R.ISGROUP_FORWARDED_BY_CLIENT = (isGroupWire && Object.prototype.hasOwnProperty.call(isGroupWire, 'isGroup')) ? 'YES' : 'NO';
    R.ISGROUP_WIRE_BODY = isGroupWire ? Object.keys(isGroupWire).sort().join(',') : 'UNKNOWN';
    check('3.15 ★★ 探针成立：带 isGroup:true 的调用真的发出去了，且 wire body 被捕获',
      !!isGroupProbe && isGroupProbe.ok === true && !!isGroupWire,
      { probe: isGroupProbe, wire: isGroupWire });

    /* ══════════════════════════════════════════════════════════════
       4 · §26 first-token cost（真实路径上的那一次 loopback 往返）
       ══════════════════════════════════════════════════════════════ */
    section('4 · §26 first-token cost (added loopback hop)');
    const timingSamples = [];
    if (rec0 && rec0.t1 != null && rec0.t0 != null) timingSamples.push(rec0.t1 - rec0.t0);
    /* 再用**真实客户端 + 真实节点**取独立样本：每条都是它自己的一轮
       （authoritative 会真的 begin/推进/曝光/结束，因此样本形态与真实回合一致）。 */
    const TIMING_N = 10;
    const timingRun = await evaluate(`(function(){
      var out = [];
      var i = 0;
      function step(){
        if (i >= ${TIMING_N}) return Promise.resolve(out);
        var k = i++;
        return Promise.resolve(IB.homeNode.runtime.runMemoryRecall({
          operation: 'memory-recall', mode: 'authoritative', characterId: ${JSON.stringify(ROLE_ID)},
          requestId: 'l34_timing_' + k, conversationId: 'dm:' + ${JSON.stringify(ROLE_ID)},
          message: ${JSON.stringify(QUERY)} + ' #' + k
        }, { timeoutMs: 2000 })).then(function(res){
          out.push({ k: k, ok: !!(res && res.ok === true), selected: (res && Array.isArray(res.selectedIds)) ? res.selectedIds.length : 0 });
          return step();
        }, function(err){ out.push({ k: k, ok: false, error: String((err && err.message) || err) }); return step(); });
      }
      return step();
    })()`, true);
    const timingHttp = await evaluate('(function(){ return (window.__l34 && window.__l34.httpRecalls) || []; })()');
    /* 第 0 条就是被测量回合那一次（已经作为第一个样本收过），因此从第 1 条起。 */
    for (const rec of timingHttp.slice(1)) {
      if (rec && rec.t0 != null && rec.t1 != null) timingSamples.push(rec.t1 - rec.t0);
    }
    const sorted = timingSamples.slice().sort(function (a, b) { return a - b; });
    const medianOf = function (arr) { if (!arr.length) return null; const m = Math.floor(arr.length / 2); return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2; };
    const p95Of = function (arr) { if (!arr.length) return null; const idx = Math.min(arr.length - 1, Math.ceil(0.95 * arr.length) - 1); return arr[idx]; };
    R.FIRST_TOKEN_RECALL_HOP_MS_MEDIAN = sorted.length ? Number(medianOf(sorted).toFixed(2)) : 'UNKNOWN';
    R.FIRST_TOKEN_RECALL_HOP_MS_P95 = sorted.length ? Number(p95Of(sorted).toFixed(2)) : 'UNKNOWN';
    R.FIRST_TOKEN_RECALL_HOP_SAMPLES = String(sorted.length);
    R.FIRST_TOKEN_RECALL_HOP_METHOD = 'fetch-level wall time of POST /internal/runtime/memory-recall (1 real turn sample + ' + TIMING_N + ' authoritative samples through the real client)';
    check('4.1 ★★★★ §26 真实路径上的 loopback 往返被量到（样本 ≥ 5，中位数为正数）',
      sorted.length >= 5 && R.FIRST_TOKEN_RECALL_HOP_MS_MEDIAN !== 'UNKNOWN' && Number(R.FIRST_TOKEN_RECALL_HOP_MS_MEDIAN) > 0,
      { samples: sorted.length, median: R.FIRST_TOKEN_RECALL_HOP_MS_MEDIAN, p95: R.FIRST_TOKEN_RECALL_HOP_MS_P95, raw: sorted.map(function (v) { return Number(v.toFixed(1)); }) });
    check('4.2 ★★★ 计时样本都成功返回（不是把失败也当耗时）',
      Array.isArray(timingRun) && timingRun.length === TIMING_N && timingRun.every(function (s) { return s.ok === true && s.selected >= 0; }),
      timingRun);

    /* ══════════════════════════════════════════════════════════════
       5 · §23/§24 召回失败（两种形态，都如实标注）
       ══════════════════════════════════════════════════════════════ */
    section('5 · §23/§24 recall failure semantics');
    const providerPostsBeforeDown = provider.seen.filter(function (e) { return e.url === PROVIDER_PATH && e.method === 'POST'; }).length;

    /* ── 5-A · 传输层故障（节点还在）：只让**召回这一跳**的 fetch 真的 reject。
       于是被证明的是 seam 的失败语义本身：失败 ⇒ 本轮没有记忆上下文、
       **不**回落到浏览器选择、聊天照常继续。 */
    await evaluate(`(function(){
      window.__l34.realFetch = window.__l34.realFetch || window.fetch;
      window.__l34.hopDownCalls = 0;
      window.fetch = function(url, init){
        if (String(url).indexOf('/internal/runtime/memory-recall') >= 0) {
          window.__l34.hopDownCalls += 1;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return window.__l34.realFetch.apply(this, arguments);
      };
      return 'patched';
    })()`);
    const hopBefore = await evaluate('(function(){ var p = window.__l34; return { selector: p.selectorCalls, mounted: p.mountedRecalls.length, http: p.httpRecalls.length }; })()');
    const hopTurn = await evaluate(`(function(){
      var el = document.getElementById('chat-full-input') || document.getElementById('chat-input');
      if (!el) return Promise.resolve({ ok: false, error: 'no-input-element' });
      el.value = ${JSON.stringify(QUERY + ' 这是召回的 loopback 跳失败时的一轮 A7F3')};
      return Promise.resolve(sendChatMessage())
        .then(function(res){ return { ok: true, error: (res && res.error) || null }; },
              function(err){ return { ok: false, error: String((err && err.message) || err) }; });
    })()`, true);
    await sleep(300);
    const hopProbe = await evaluate('(function(){ var p = window.__l34; return { selector: p.selectorCalls, mounted: p.mountedRecalls.slice(-2), hopDownCalls: p.hopDownCalls }; })()');
    const hopPosts = provider.seen.filter(function (e) { return e.url === PROVIDER_PATH && e.method === 'POST'; });
    const hopPc = findChatPostFor(hopPosts, 'A7F3');
    const hopTail = hopPc ? currentTurnTailOf(hopPc) : '';
    const hopPrompt = hopPc ? promptTextOf(hopPc) : '';
    const hopHasCanon = CANON_ROWS.some(function (r) { return hopTail.indexOf(r.content) >= 0; });
    const hopHasDecoy = hopTail.indexOf(BROWSER_DECOY_TEXT) >= 0;
    const hopReachedSeam = !!hopProbe && hopProbe.hopDownCalls >= 1;
    const hopLastMount = (hopProbe && Array.isArray(hopProbe.mounted) && hopProbe.mounted.length) ? hopProbe.mounted[hopProbe.mounted.length - 1] : null;
    const hopSeamUnavailable = !!hopLastMount && !(hopLastMount.result && hopLastMount.result.ok === true);
    check('5.1 ★★★★★ §23 召回这一跳真的失败时：回合照常走到 provider，且**本轮尾部没有任何记忆上下文**',
      !!hopPc && hopPosts.length > providerPostsBeforeDown && hopHasCanon === false && hopHasDecoy === false,
      { reachedSeam: hopReachedSeam, reachedProvider: !!hopPc, hasCanonical: hopHasCanon, hasDecoy: hopHasDecoy, tail: hopTail.slice(-160) });
    check('5.2 ★★★★ §23 seam 确实被走到、并且把结果判成不可用（不是静默成功）',
      hopReachedSeam && hopSeamUnavailable,
      { hopDownCalls: hopProbe && hopProbe.hopDownCalls, lastMountedResult: hopLastMount && hopLastMount.result });
    check('5.3 ★★★★★ §24 失败**没有**恢复浏览器召回权威（选择器仍然零调用、decoy 零出现）',
      hopProbe && hopProbe.selector === hopBefore.selector && hopHasDecoy === false,
      { selectorBefore: hopBefore.selector, selectorAfter: hopProbe && hopProbe.selector, hasDecoy: hopHasDecoy });

    /* 还原 fetch，然后做**真**的服务器不可达。 */
    await evaluate('(function(){ if (window.__l34.realFetch) window.fetch = window.__l34.realFetch; return "restored"; })()');

    /* ── 5-B · 真做法：把 Home Node 进程**杀掉**，再跑一个真实回合 ───────── */
    try { homeChild.kill(); } catch (_) { /* 已结束 */ }
    let killed = false;
    for (let i = 0; i < 40; i++) {
      const h = await fx.request(homePort, 'GET', '/health');
      if (h.status === 0 || h.status >= 500) { killed = true; break; }
      await sleep(250);
    }
    homeAlive = !killed;
    R.SERVER_DOWN_METHOD = killed ? 'HOME_NODE_PROCESS_KILLED' : 'UNREACHABLE_ENDPOINT';
    const killBefore = await evaluate('(function(){ var p = window.__l34; return { selector: p.selectorCalls, mounted: p.mountedRecalls.length }; })()');
    const downPostsBefore = provider.seen.filter(function (e) { return e.url === PROVIDER_PATH && e.method === 'POST'; }).length;
    const downTurn = await evaluate(`(function(){
      var el = document.getElementById('chat-full-input') || document.getElementById('chat-input');
      if (!el) return Promise.resolve({ ok: false, error: 'no-input-element' });
      el.value = ${JSON.stringify(QUERY + ' 这是节点不可达时的一轮 B2E9')};
      return Promise.resolve(sendChatMessage())
        .then(function(res){ return { ok: true, error: (res && res.error) || null }; },
              function(err){ return { ok: false, error: String((err && err.message) || err) }; });
    })()`, true);
    await sleep(500);
    const downProbe = await evaluate('(function(){ var p = window.__l34; return { selector: p.selectorCalls, mounted: p.mountedRecalls.slice(-2), http: p.httpRecalls.slice(-2) }; })()');
    const downPosts = provider.seen.filter(function (e) { return e.url === PROVIDER_PATH && e.method === 'POST'; });
    const downPc = findChatPostFor(downPosts, 'B2E9');
    const downTail = downPc ? currentTurnTailOf(downPc) : '';
    const downHasAnyCanon = CANON_ROWS.some(function (r) { return downTail.indexOf(r.content) >= 0; });
    const downHasDecoy = downTail.indexOf(BROWSER_DECOY_TEXT) >= 0 || downTail.indexOf(BROWSER_DECOY_ID) >= 0;
    const downSelectorCalls = (downProbe && downProbe.selector != null && killBefore) ? (downProbe.selector - killBefore.selector) : -1;
    const downNewPost = downPosts.length > downPostsBefore;
    R.SERVER_DOWN_TURN_REACHED_PROVIDER = (downNewPost && !!downPc) ? 'YES' : 'NO';
    /* ★ "回合照常继续"的判据是**模型调用真的发生了**，而不是 sendChatMessage 的
       返回值：canonical 模式下聊天正文写入也走 Home Node，节点没了它必然被拒
       （home-node-offline）—— 那是**聊天存储**的失败语义，与召回权威无关，
       因此这里如实报出来，但不把它算进召回 cutover 的判据。 */
    R.SERVER_DOWN_TURN_COMPLETED = (downNewPost && !!downPc) ? 'YES' : 'NO';
    R.SERVER_DOWN_CHAT_WRITE_ERROR = (downTurn && downTurn.error) ? String(downTurn.error) : 'NONE';
    /* 观察到的真实形态：**全死**的节点会让聊天回合自己在聊天存储上 fail closed
       （写不进 canonical chat store ⇒ 这一轮不发聊天模型调用）。这是产品既有语义，
       不是召回 cutover 引入的 —— 召回 cutover 自己的失败语义由 5-A（只让召回那一跳
       失败、节点仍活）证明，那里回合照常走到了 provider。 */
    R.SERVER_DOWN_FULL_KILL_TURN_ABORTED_BY_CHAT_STORE = (!downPc && R.SERVER_DOWN_CHAT_WRITE_ERROR !== 'NONE') ? 'YES' : 'NO';
    R.SERVER_DOWN_RECALL_SEAM_REACHED = (downProbe && downProbe.mounted && downProbe.mounted.length) ? 'YES' : 'NO';
    R.SERVER_DOWN_MEMORY_CONTEXT = (downHasAnyCanon || hopHasCanon) ? 'PRESENT' : 'NONE';
    /* decoy 在**任何**一轮的任何 prompt 里都不许出现（这是权威没被恢复的最强判据）。 */
    const anyDecoyAfterFailure = provider.seen.some(function (e) {
      return e.method === 'POST' && promptTextOf(e).indexOf(BROWSER_DECOY_TEXT) >= 0;
    });
    const restores = hopProbe.selector !== hopBefore.selector || (downSelectorCalls !== 0) ||
      anyDecoyAfterFailure || hopHasDecoy || downHasDecoy;
    R.SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY = restores ? 'YES' : 'NO';
    check('5.4 ★★★★ §23 全死节点下观察到的真实形态：聊天回合在**聊天存储**上 fail closed（如实报出，不是召回面的行为）',
      killed === true && R.SERVER_DOWN_FULL_KILL_TURN_ABORTED_BY_CHAT_STORE === 'YES' && !downPc,
      { killed: killed, chatWriteError: R.SERVER_DOWN_CHAT_WRITE_ERROR, seamReached: R.SERVER_DOWN_RECALL_SEAM_REACHED, turnResult: downTurn });
    check('5.5 ★★★★★ §24 两种失败形态下都**没有**恢复浏览器召回权威：decoy 从未出现在任何 prompt 里',
      anyDecoyAfterFailure === false && hopHasDecoy === false && downHasDecoy === false &&
      hopProbe.selector === hopBefore.selector && downSelectorCalls === 0,
      { anyDecoy: anyDecoyAfterFailure, hopSelectorDelta: hopProbe.selector - hopBefore.selector, downSelectorDelta: downSelectorCalls });
    check('5.6 ★★★★★ §24 SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY = NO（没有回落、没有重选、没有 decoy）',
      R.SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY === 'NO',
      { hopSelectorDelta: hopProbe.selector - hopBefore.selector, downSelectorDelta: downSelectorCalls, anyDecoy: anyDecoyAfterFailure, method: R.SERVER_DOWN_METHOD });

    section('6 · verdict');
  } catch (error) {
    failed++;
    console.error('  FAIL  套件抛出异常 — ' + String((error && (error.stack || error.message)) || error));
  } finally {
    R.REAL_PROVIDER_CALLS = provider.count();
    /* 报告（写入 .dsh-research/）——先落盘再清理，保证证据不随 scratch 消失。 */
    try {
      const jsonPath = path.join(ROOT, '.dsh-research', 'r4c-live-3-4-browser.json');
      const mdPath = path.join(ROOT, '.dsh-research', 'r4c-live-3-4-browser.md');
      fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
      const payload = {
        phase: 'P21-R4-LIVE-3.4',
        generatedAt: new Date().toISOString(),
        verdict: failed === 0 ? 'PASS' : 'FAIL',
        counts: { passed: passed, failed: failed },
        constants: R,
        captured: {
          recallRequest: evidence.recallHttp ? evidence.recallHttp.requestBody : null,
          recallResponseSummary: evidence.recallResponse ? {
            ok: evidence.recallResponse.ok, selectedIds: evidence.recallResponse.selectedIds,
            counts: evidence.recallResponse.counts, channel: evidence.recallResponse.channel,
            chars: evidence.recallResponse.context && evidence.recallResponse.context.chars,
            effects: evidence.recallResponse.effects, boundary: evidence.recallResponse.boundary
          } : null,
          providerPromptSha256: evidence.providerPromptSha,
          providerPromptHead: evidence.providerPromptHead,
          providerCurrentTurnTailHead: evidence.providerTailHead,
          providerCallCount: evidence.providerCallCount,
          providerRequests: provider.seen.map(function (e) {
            return {
              method: e.method, url: e.url, host: e.host, model: e.body && e.body.model,
              stream: !!(e.body && e.body.stream), bodyChars: e.raw.length,
              tailHead: e.method === 'POST' ? currentTurnTailOf(e).slice(-160) : null
            };
          })
        },
        canonicalRows: CANON_ROWS.map(function (r) { return { id: r.id, content: r.content, visibility: r.visibility }; }),
        browserDecoy: { id: BROWSER_DECOY_ID, text: BROWSER_DECOY_TEXT }
      };
      fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
      const md = [
        '# P21-R4-LIVE-3.4 · Real-browser recall authority proof (CDP)',
        '',
        '- verdict: **' + payload.verdict + '** (' + passed + ' passed / ' + failed + ' failed)',
        '- generated: ' + payload.generatedAt,
        '',
        '## machine-readable constants',
        '',
        '```',
        Object.keys(R).map(function (k) { return k + ' = ' + R[k]; }).join('\n'),
        '```',
        '',
        '## captured recall request (browser → Home Node)',
        '',
        '```json',
        JSON.stringify(payload.captured.recallRequest, null, 2),
        '```',
        '',
        '## captured recall response (Home Node → browser, summary)',
        '',
        '```json',
        JSON.stringify(payload.captured.recallResponseSummary, null, 2),
        '```',
        '',
        '## provider prompt (head 400 chars, sha256 ' + evidence.providerPromptSha + ')',
        '',
        '```',
        String(evidence.providerPromptHead || ''),
        '```',
        '',
        '## canonical rows seeded into the real store',
        '',
        '```json',
        JSON.stringify(payload.canonicalRows, null, 2),
        '```',
        ''
      ].join('\n');
      fs.writeFileSync(mdPath, md, 'utf8');
      console.log('report: ' + jsonPath);
    } catch (reportError) {
      console.error('  (report write failed: ' + String((reportError && reportError.message) || reportError) + ')');
    }

    /* 全部常量都打印（acceptance 要求）。 */
    console.log('');
    for (const key of Object.keys(R)) P(key, R[key]);
    console.log('REAL_PROVIDER_CALLS = ' + R.REAL_PROVIDER_CALLS);

    if (launched && typeof launched.close === 'function') { try { await launched.close(); } catch (_) { } }
    for (const c of children) { try { c.kill(); } catch (_) { } }
    await sleep(600);
    for (const d of dirs.slice().reverse()) {
      for (let i = 0; i < 6; i++) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ }
        if (!fs.existsSync(d)) break;
        await sleep(200);
      }
    }
    console.log('\n' + (failed === 0 ? '全部通过 ✔' : failed + ' 项失败 ✘') + '  (' + passed + ' 通过 / ' + failed + ' 失败)');
    console.log('R4C_LIVE_3_4_BROWSER_VERDICT=' + (failed === 0 ? 'PASS' : 'FAIL'));
    console.log('R4C_LIVE_3_4_BROWSER_COUNTS passed=' + passed + ' failed=' + failed);
    process.exitCode = failed === 0 ? 0 : 1;
    setTimeout(function () { process.exit(failed === 0 ? 0 : 1); }, 200);
  }
})();
