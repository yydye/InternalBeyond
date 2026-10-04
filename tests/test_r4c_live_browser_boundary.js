'use strict';
/* ====================================================================
   P21-R4-LIVE-2.1 · 浏览器侧的**运行时解释边界**端到端验收（真实浏览器）
   --------------------------------------------------------------------
   运行：node tests/test_r4c_live_browser_boundary.js

   ★ 这个文件**不在** test-all.js 里，理由与 P22-15~25 那几条视觉/验收测试
     同款：它要开一个真实浏览器。

   ── 它要证明的那条链 ────────────────────────────────────────────────
     真实 InternalBeyond.html（产品静态层 http://127.0.0.1:<web>/）
       ↓ 真实 assets/js/home-node-client.js 的 createRuntimeRemote
       ↓ 真实 assets/js/home-node-bootstrap.js 的 IB.homeNode.runtime 挂载
     POST /internal/runtime/memory-interpretation（桌面凭据 · loopback）
       ↓ 真实 Home Node 子进程（真实 SQLite store / registry / Vault 取用 /
         真实 NodeModelPort）
       ↓ characterId → character_runtime_specs（服务端自己解析）
       ↓ credentialRef → Vault（服务端自己解析，secret 只活在这一次请求里）
       ↓ 恰一次 provider 调用（**假** provider，只为了能观测 wire）
     一个非持久结果（durable:false · attempts:1 · 零 durable 写入）

   REAL：InternalBeyond.html、home-node-client.js、home-node-bootstrap.js、
         services/home-node-service.js 的 buildHomeNode 子进程、真实 HTTP、
         真实 Vault resolver、真实 NodeModelPort。
   FAKE：Vault 里那一条 secret（哨兵字符串）与一个本地 mock provider。
   唯一被注入的装配事实是**成本闸门**（runtimeInterpretationPolicy）——
   生产 require.main 路径刻意没有启用旋钮（F8），因此"打开它"只能发生在
   测试夹具 tests/fixtures/r4c-live-home-node-child.js 里。

   ★ 一个字节都不假：浏览器真的在跑，页面真的加载了产品的脚本，
     provider 是**真的**本地 HTTP 服务（它记录自己看到了什么）。
     若 CDP 无法启动，本文件以非零码结束并打印 BLOCKED —— 绝不伪造浏览器结果。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
const ROOT = path.resolve(__dirname, '..');

/* ── 夹具常量 ───────────────────────────────────────────────────────── */
const SENTINEL = 'SECRET_SENTINEL_INTERP_91B7';   /* 只允许存在于 Vault 密文里 */
const OPERATION = 'memory-interpretation';
const CHARACTER_ID = 'r4c_live_browser_role';
const UNKNOWN_CHARACTER_ID = 'r4c_live_browser_role_absent';
const CREDENTIAL_REF = 'r4c_live_browser_ref';
const PROVIDER_CLASS = 'custom';
const PROVIDER_MODEL = 'ib-r4c-browser-mock-model';
const PROVIDER_PATH = '/v1/chat/completions';
const DESKTOP_TOKEN = 'r4c-live-browser-desktop-token';
/* 浏览器**不得**有权选择的字段（出现在请求里必须是拒绝，而不是忽略）。 */
const FORBIDDEN_FIELDS = ['credentialRef', 'apiKey', 'provider', 'model', 'endpoint',
  'systemPrompt', 'prompt', 'messages'];
/* R4-C 纯核心的 SYSTEM_INSTRUCTIONS 里的稳定子串：证明 prompt 权威在服务端
   核心，而不是浏览器送进来的任何一段文本。 */
const SYSTEM_AUTHORITY_SUBSTRING = '记忆解释影子';

const IDS = ['mem_r4c_a', 'mem_r4c_b'];
const RECORDS = [
  { id: 'mem_r4c_a', title: '便利店屋檐下的雨', content: '下午四点，我们站在便利店屋檐下等雨停。', kind: 'episodic', rawSource: 'chat', valence: 0.4, arousal: 0.5 },
  { id: 'mem_r4c_b', title: '抽屉里的旧照片', content: '她说起一张放在抽屉最底下的旧照片。', kind: 'episodic', rawSource: 'diary', valence: 0.2, arousal: 0.3 }
];

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { failed++; console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title); }
const sleep = fx.sleep;

/* ── 假 provider：**真的**本地 HTTP 服务 ─────────────────────────────
   它唯一的职责是"如实记录自己看到了什么"，并回一个 OpenAI 形状的响应。
   它记录 url / host / authorization / 完整 body —— 于是 (c)(d) 的每一条
   都是**被观测到的事实**，而不是从服务端代码里推断出来的。 */
function createMockProvider() {
  const seen = [];
  const server = http.createServer(function (req, res) {
    let raw = '';
    req.on('data', function (c) { raw += c; });
    req.on('end', function () {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      seen.push({
        method: String(req.method || ''),
        url: String(req.url || ''),
        host: String(req.headers.host || ''),
        authorization: String(req.headers.authorization || ''),
        contentType: String(req.headers['content-type'] || ''),
        body: body,
        raw: raw
      });
      const ids = memoryIdsFromWire(raw);
      const items = ids.map(function (id) {
        return {
          memoryId: id,
          meaning: '（假 provider）这条记忆在**当前状态**下意味着：先把它放回它的出处，再谈它现在改变了什么。',
          appraisal: 'neutral', affect: 'unclear', relationshipMeaning: null, causalAttribution: null,
          basis: 'ai_inference', subjectiveConfidence: 0.5
        };
      });
      const wire = {
        id: 'mock-r4c-1', object: 'chat.completion', created: 1700000000, model: PROVIDER_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ items: items }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wire));
    });
  });
  return { server: server, seen: seen, count: function () { return seen.length; } };
}

/* 从 provider wire 的正文里取出**这一批**要解释的 memoryId。
   ★ 必须结构化地取，不能用正则扫整段正文：信封里除了 MEMORY_BATCH 之外，
     requestedSchema 的示例也含一个 `"memoryId"` 键（值是说明文字），
     正则会把它当成一个真实 id，于是 mock 会回一条**幻觉 id** ——
     而那会让"假 provider 回什么"变成一个比被测边界更不可控的变量。
   位置：user 消息里那个 ```json 围栏内的信封（R4-C core.buildRequest 的形状）。 */
function memoryIdsFromWire(raw) {
  try {
    const body = JSON.parse(String(raw));
    const messages = Array.isArray(body && body.messages) ? body.messages : [];
    for (const message of messages) {
      const content = message && typeof message.content === 'string' ? message.content : '';
      const fence = content.match(/```json\s*([\s\S]*?)```/);
      if (!fence) continue;
      const envelope = JSON.parse(fence[1]);
      const batch = Array.isArray(envelope && envelope.MEMORY_BATCH) ? envelope.MEMORY_BATCH : [];
      const ids = batch.map(function (item) { return item && item.memoryId; })
        .filter(Boolean).map(String);
      if (ids.length) return ids;
    }
  } catch (_) { /* 形状不是我们预期的那一种：如实返回空，让断言去失败 */ }
  return [];
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let n = 0, at = 0;
  for (;;) {
    const i = String(text).indexOf(needle, at);
    if (i < 0) return n;
    n++; at = i + needle.length;
  }
}

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
  });
}

/* ── durable 面的快照 ────────────────────────────────────────────────
   两类证据，缺一不可：
     · **逻辑面**：走真实 HTTP 读 memory / understanding 的 count+revision
       （读不到就是读不到，绝不把失败当成"没变"）；
     · **字节面**：数据目录与 Vault 目录里每个文件的 size+sha256
       —— 于是"零 durable 写入"是一句可以被机械核对的话，而不是承诺。 */
function dirDigest(dir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { names = []; }
  for (const name of names.sort()) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      const buf = fs.readFileSync(p);
      out[name] = { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    } catch (error) {
      out[name] = { error: String((error && error.message) || error) };
    }
  }
  return out;
}

(async function main() {
  console.log('P21-R4-LIVE-2.1 · 浏览器运行时解释边界（真实浏览器 · 真实 Home Node 子进程）');

  const exe = fx.chromePath();
  if (!exe) {
    console.error('  ✖ BLOCKED：找不到 Chrome / Edge（设置 CHROME_PATH 或安装其中之一）。');
    console.error('R4C_LIVE_BROWSER_BOUNDARY_VERDICT=BLOCKED no-browser');
    process.exitCode = 1;
    setTimeout(function () { process.exit(1); }, 100);
    return;
  }

  const children = [];
  const dirs = [];
  const tmp = function (tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r4c-browser-' + tag + '-')); dirs.push(d); return d; };
  const spawnTracked = function (cmd, args, opts) { const c = spawn(cmd, args, opts); children.push(c); return c; };

  const nodeDir = tmp('node');
  const vaultDir = tmp('vault');
  const homePort = await fx.freePort();
  const webPort = await fx.freePort();

  /* ① 假 Vault：把哨兵写进**临时**凭据数据目录（合成 Vault 配方）。
        它是本次唯一一份 provider secret，而它必须**只**存在于密文里。 */
  const createVault = require(path.join(ROOT, 'active', 'credential-vault.js'));
  const vault = createVault({ dataDir: vaultDir });
  vault.load();
  const vaultUpserted = vault.upsert(CREDENTIAL_REF, { provider: PROVIDER_CLASS, apiKey: SENTINEL });

  /* ② 假 provider（真 HTTP）。 */
  const provider = createMockProvider();
  const providerPort = await listen(provider.server);
  const providerEndpoint = 'http://127.0.0.1:' + providerPort + PROVIDER_PATH;

  const homeBase = 'http://127.0.0.1:' + homePort;
  const AUTH = { 'X-IB-Home-Token': DESKTOP_TOKEN };
  const homeGet = function (p) { return fx.request(homePort, 'GET', p, null, AUTH); };
  const homePost = function (p, body) { return fx.request(homePort, 'POST', p, body, AUTH); };
  const payloadOf = function (res) { return (res && res.body && res.body.payload) ? res.body.payload : null; };

  let launched = null;
  let childOut = '';

  try {
    section('0 · 真实部件全部就位');
    check('0.1 ★ Vault 里那一条 secret 真的写进了临时凭据目录（合成 Vault，密文落盘）',
      vaultUpserted === true && fs.existsSync(path.join(vaultDir, 'credential-vault.json')) &&
      fs.readFileSync(path.join(vaultDir, 'credential-vault.json'), 'utf8').indexOf(SENTINEL) < 0,
      { upserted: vaultUpserted, files: fs.readdirSync(vaultDir) });

    /* ③ 真实 Home Node 子进程：真实装配 + 唯一注入的成本闸门。 */
    const child = spawnTracked(process.execPath,
      [path.join('tests', 'fixtures', 'r4c-live-home-node-child.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          IB_R4C_DATA_DIR: nodeDir,
          IB_R4C_CREDENTIAL_DIR: vaultDir,
          IB_R4C_TOKEN: DESKTOP_TOKEN,
          IB_R4C_PORT: String(homePort),
          /* 双保险：模块顶层的 resolveDesktopCredential() 也按这两个变量选目录，
             因此装配期副作用同样落在临时目录里（生产数据目录一个字节不动）。 */
          IB_HOME_NODE_DATA_DIR: nodeDir,
          IB_CREDENTIAL_DATA_DIR: vaultDir,
          IB_HOME_NODE_HOST: '127.0.0.1'
        }),
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
    child.stdout.on('data', function (c) { childOut += String(c); });
    child.stderr.on('data', function (c) { childOut += String(c); });

    /* ④ 真实静态层（产品正常启动链的那一个）。 */
    const web = spawnTracked(process.execPath, [path.join('services', 'internal-beyond-server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { IB_WEB_PORT: String(webPort) }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let webOut = '';
    web.stdout.on('data', function (c) { webOut += String(c); });
    web.stderr.on('data', function (c) { webOut += String(c); });

    let homeUp = false;
    let webUp = false;
    for (let i = 0; i < 100; i++) {
      if (!homeUp) { const h = await fx.request(homePort, 'GET', '/health'); homeUp = (h.status === 200); }
      if (!webUp) { const w = await fx.request(webPort, 'GET', '/health'); webUp = (w.status === 200); }
      if (homeUp && webUp) break;
      await sleep(250);
    }
    check('0.2 ★ 真实 Home Node 子进程与真实静态层都在私有端口上活着',
      homeUp && webUp, { home: childOut.slice(-400), web: webOut.slice(-200) });
    if (!homeUp || !webUp) throw new Error('services did not start');

    /* 子进程的**自述**：闸门真的开着（不是父进程对环境的猜测）。 */
    const readyLine = childOut.split(/\r?\n/).filter(function (l) { return l.indexOf('IB-R4C-NODE-READY') === 0; })[0] || '';
    let ready = null;
    try { ready = JSON.parse(readyLine.replace('IB-R4C-NODE-READY', '').trim()); } catch (_) { ready = null; }
    check('0.3 ★★★ 子进程自述成本闸门开着（costPolicy.memoryInterpretationEnabled=true）',
      !!ready && ready.costPolicy && ready.costPolicy.memoryInterpretationEnabled === true && ready.port === homePort,
      { readyLine: readyLine, childTail: childOut.slice(-300) });

    /* /security 的**外部**读数：与自述同源，且是 HTTP 面的事实。
       ★ 配了桌面 token 的节点上 /security 也要出示凭据（它在 !authorized
         那条门之后），因此这里必须带 AUTH —— 不带会读到一次 401，
         而不是"这条面的自述"。 */
    const security = await homeGet('/security');
    const runtimeSecurity = security.body && security.body.runtimeInterpretation ? security.body.runtimeInterpretation : null;
    check('0.4 ★★★ /security 自述这条面已装配、路径正确、闸门开着、自动调用未实现、非持久',
      security.status === 200 && !!runtimeSecurity && runtimeSecurity.assembled === true &&
      runtimeSecurity.path === '/internal/runtime/memory-interpretation' &&
      runtimeSecurity.costPolicyEnabled === true &&
      runtimeSecurity.autoInvocation === 'NOT_IMPLEMENTED' &&
      runtimeSecurity.autoRetry === 'NONE' && runtimeSecurity.maxAttempts === 1 &&
      runtimeSecurity.durable === false && runtimeSecurity.transportScope === 'DESKTOP_ONLY',
      runtimeSecurity);

    /* ⑤ 发布角色：runtime spec 只经服务端的白名单投影进入 character_runtime_specs。
          浏览器**不**参与这一步的权威 —— 它只提供 characterId。 */
    const publish = await homePost('/characters/publish', {
      merge: true,
      characters: [{
        id: CHARACTER_ID, nickname: 'R4C 边界角色',
        provider: PROVIDER_CLASS, model: PROVIDER_MODEL, endpoint: providerEndpoint,
        credentialRef: CREDENTIAL_REF
      }]
    });
    const publishPayload = payloadOf(publish);
    check('0.5 ★★ 角色目录发布成功（spec 带 credentialRef，而 spec 永不离开 Node）',
      publish.status === 200 && !!publishPayload && publishPayload.count === 1,
      publish.body);

    /* ── ⑥ 真实浏览器 ─────────────────────────────────────────────── */
    launched = await fx.launchChrome(exe, {});
    const cdp = launched.cdp;
    const evaluate = async function (expression, awaitPromise) {
      const r = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: awaitPromise === true });
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async function (expr, timeoutMs, label) {
      const deadline = Date.now() + (timeoutMs || 15000);
      while (Date.now() < deadline) {
        let v = null;
        try { v = await evaluate(expr); } catch (_) { v = null; }
        if (v) return v;
        await sleep(250);
      }
      throw new Error('等待超时：' + (label || expr));
    };
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    /* ★ 页面凭据：显式测试 desktop token（服务端是以显式 token 构建的，因此
       bootstrap 交付面是关的 —— 不设它就会测到一次 401，而不是这条边界）。 */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try{' +
        'localStorage.setItem("ib_home_node_http",' + JSON.stringify(homeBase) + ');' +
        'localStorage.setItem("ib_home_node_mode","canonical");' +
        'localStorage.setItem("ib_home_node_token",' + JSON.stringify(DESKTOP_TOKEN) + ');' +
        '}catch(e){}'
    });
    const APP_URL = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
    const loaded = new Promise(function (resolve) { cdp.on('Page.loadEventFired', resolve); });
    await cdp.send('Page.navigate', { url: APP_URL });
    await loaded;
    await sleep(500);

    const mounted = await waitFor(`(function(){
      return !!(window.IB && IB.homeNode && IB.homeNode.runtime && IB.homeNode.runtime.available === true
        && typeof IB.createRuntimeRemote === 'function');
    })()`, 25000, 'IB.homeNode.runtime 挂载').catch(function () { return false; });
    check('1.1 ★★★ 真实页面里 runtime 面已挂载：IB.homeNode.runtime.available === true',
      mounted === true, mounted);

    /* ── 结构窄性：只有一个动词，没有通用模型入口，也没有持久权威那套动词 ── */
    const narrow = await evaluate(`(function(){
      var driver = IB.createRuntimeRemote({});
      var verbs = Object.keys(driver);
      var runtime = IB.homeNode.runtime;
      var generic = ['runRuntimeModel','deriveAnything','runDerivation','derive','runModel','runPrompt','run']
        .filter(function(k){ return typeof driver[k] === 'function' || typeof runtime[k] === 'function'; });
      return {
        verbs: verbs,
        generic: generic,
        mountKeys: Object.keys(runtime).sort(),
        instanceKeys: Object.keys(runtime.instance || {}),
        available: runtime.available
      };
    })()`);
    check('1.2 ★★★ createRuntimeRemote 只暴露一个动词 runMemoryInterpretation（没有第二个动词）',
      narrow && JSON.stringify(narrow.verbs) === JSON.stringify(['runMemoryInterpretation']), narrow);
    check('1.3 ★★★ 没有通用运行时模型入口（runRuntimeModel / deriveAnything / runPrompt / derive … 全不存在）',
      narrow && narrow.generic.length === 0, narrow && narrow.generic);
    check('1.4 ★★ 挂载面刻意与 memory/understanding/moments 不同形：只有 instance/available/一个动词',
      narrow && JSON.stringify(narrow.mountKeys) === JSON.stringify(['available', 'instance', 'runMemoryInterpretation']) &&
      JSON.stringify(narrow.instanceKeys) === JSON.stringify(['runMemoryInterpretation']), narrow);

    /* ══════════════════════════════════════════════════════════════
       (a) 浏览器**没有**秘密 —— 扫 window / localStorage / sessionStorage /
           DOM / performance，并在同一支探针里做**自检**
       ══════════════════════════════════════════════════════════════ */
    section('2 · (a) 浏览器不持有 secret');
    const scanner = `(function(sentinel){
      var hits = [];
      var visited = [];
      var budget = 4000;
      function seen(o){ for (var i=0;i<visited.length;i++) if (visited[i] === o) return true; visited.push(o); return false; }
      function note(where, text){ if (String(text).indexOf(sentinel) >= 0) hits.push(where); }
      function walk(value, label, depth){
        if (depth > 4 || hits.length > 8 || budget-- < 0) return;
        if (value == null) return;
        var t = typeof value;
        if (t === 'string') { note(label, value); return; }
        if (t !== 'object') return;
        if (value === window || value === document) return;
        if (value.nodeType) return;
        if (seen(value)) return;
        var json = null;
        try { json = JSON.stringify(value); } catch (e) { json = null; }
        if (json != null) { note(label, json); return; }
        var keys = [];
        try { keys = Object.keys(value); } catch (e) { return; }
        for (var i=0;i<keys.length && i<60;i++){
          var v = null;
          try { v = value[keys[i]]; } catch (e) { continue; }
          walk(v, label + '.' + keys[i], depth + 1);
        }
      }
      try { for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); note('localStorage['+k+']', k+'='+localStorage.getItem(k)); } } catch (e) { hits.push('localStorage-error'); }
      try { for (var j=0;j<sessionStorage.length;j++){ var k2=sessionStorage.key(j); note('sessionStorage['+k2+']', k2+'='+sessionStorage.getItem(k2)); } } catch (e) { hits.push('sessionStorage-error'); }
      try { note('DOM.outerHTML', document.documentElement.outerHTML); } catch (e) {}
      try { note('document.cookie', document.cookie); } catch (e) {}
      var names = [];
      try { names = Object.getOwnPropertyNames(window); } catch (e) { names = []; }
      for (var n=0;n<names.length && n<3000;n++){
        var name = names[n];
        var v2 = null;
        try { v2 = window[name]; } catch (e) { continue; }
        if (typeof v2 === 'function') continue;
        walk(v2, 'window.' + name, 0);
      }
      try { var entries = performance.getEntriesByType('resource') || []; for (var p=0;p<entries.length;p++) note('perf:'+entries[p].name, entries[p].name); } catch (e) {}
      var lsKeys = [];
      try { for (var q=0;q<localStorage.length;q++) lsKeys.push(localStorage.key(q)); } catch (e) {}
      return {
        hits: hits,
        lsKeys: lsKeys,
        windowProps: names.length,
        domChars: (function(){ try { return document.documentElement.outerHTML.length; } catch (e) { return -1; } })(),
        desktopTokenPresent: (function(){ try { return localStorage.getItem('ib_home_node_token') === ${JSON.stringify(DESKTOP_TOKEN)}; } catch (e) { return false; } })()
      };
    })(${JSON.stringify(SENTINEL)})`;

    const scan1 = await evaluate(scanner);
    check('2.1 ★★★★★ 浏览器里**没有**哨兵：window / localStorage / sessionStorage / DOM / performance 全零命中',
      scan1 && scan1.hits.length === 0,
      { hits: scan1 && scan1.hits, scanned: scan1 && { lsKeys: scan1.lsKeys, windowProps: scan1.windowProps, domChars: scan1.domChars } });
    /* 对照：这一次的浏览器**确实**持有 desktop token（因此"没扫到"不是因为
       "什么凭据都没有"）；而 provider secret 依然一个字节都不在。 */
    check('2.2 ★★★ 对照面：浏览器确实持有 desktop token（负结果有意义），但 provider secret 不在',
      scan1 && scan1.desktopTokenPresent === true && scan1.lsKeys.indexOf('ib_home_node_token') >= 0,
      scan1 && { lsKeys: scan1.lsKeys, token: scan1.desktopTokenPresent });
    /* 扫描器自检：把哨兵**临时**放进 sessionStorage，同一支探针必须报命中，
       再删掉必须归零。没有这一条，"扫不到"可能只是"扫描器坏了"。 */
    const scanPositive = await evaluate('(function(){ try { sessionStorage.setItem("__r4c_scanner_selfcheck", ' +
      JSON.stringify(SENTINEL) + '); return true; } catch (e) { return false; } })()');
    const scan2 = await evaluate(scanner);
    await evaluate('(function(){ try { sessionStorage.removeItem("__r4c_scanner_selfcheck"); } catch (e) {} return true; })()');
    const scan3 = await evaluate(scanner);
    check('2.3 ★★★ 扫描器自检：人为放进去的哨兵**会**被扫到（因此 2.1 的零命中是真的）',
      scanPositive === true && !!scan2 && scan2.hits.length > 0 && !!scan3 && scan3.hits.length === 0,
      { selfCheck: scanPositive, positiveHits: scan2 && scan2.hits, afterCleanup: scan3 && scan3.hits });

    /* ══════════════════════════════════════════════════════════════
       (b) 浏览器**不能**选择 credentialRef / provider / model / endpoint
           —— 攻击路径用**裸 fetch**（绕过客户端），因此证明的是服务端的拒绝
       ══════════════════════════════════════════════════════════════ */
    section('3 · (b) 权威字段在服务端被拒绝（裸 fetch 攻击路径）');
    const attackBody = function (extras, envelope) {
      return JSON.stringify({
        operation: OPERATION, characterId: CHARACTER_ID, timeoutMs: 20000,
        inputEnvelope: envelope || { selectedIds: IDS, records: RECORDS },
        ...extras
      });
    };
    const attackExpr = function (bodyJson) {
      return `(function(){
        return fetch(${JSON.stringify(homeBase + '/internal/runtime/memory-interpretation')}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-IB-Protocol': '1', 'X-IB-Home-Token': ${JSON.stringify(DESKTOP_TOKEN)} },
          body: ${JSON.stringify(bodyJson)}
        }).then(function(r){ return r.text().then(function(t){ var b = null; try { b = JSON.parse(t); } catch(e){ b = null; } return { status: r.status, body: b }; }); })
          .catch(function(e){ return { status: 0, error: String(e) }; });
      })()`;
    };
    const attack1 = await evaluate(attackExpr(attackBody({
      credentialRef: 'evil-ref', provider: 'evil-provider', model: 'evil-model',
      endpoint: 'http://127.0.0.1:1/v1', apiKey: SENTINEL
    })), true);
    check('3.1 ★★★★★ 带 credentialRef/provider/model/endpoint/apiKey 的请求 ⇒ HTTP 400 request-field-forbidden',
      attack1 && attack1.status === 400 && attack1.body && attack1.body.error === 'request-field-forbidden' &&
      attack1.body.ok === false && attack1.body.durable === false &&
      Array.isArray(attack1.body.reasonCodes) && attack1.body.reasonCodes.indexOf('request-field-forbidden') >= 0,
      attack1);
    check('3.2 ★★★ 响应**指名**了被拒的权威字段（而不是含糊的"坏请求"）',
      attack1 && attack1.body && FORBIDDEN_FIELDS.indexOf(String(attack1.body.field)) >= 0,
      attack1 && attack1.body && { field: attack1.body.field, detail: attack1.body.detail });

    const attack2 = await evaluate(attackExpr(attackBody({}, {
      selectedIds: IDS, records: RECORDS, provider: 'evil-provider', model: 'evil-model'
    })), true);
    check('3.3 ★★★ 把权威字段藏进 inputEnvelope 同样被拒（信封是闭集，field=inputEnvelope.*）',
      attack2 && attack2.status === 400 && attack2.body && attack2.body.error === 'request-field-forbidden' &&
      String(attack2.body.field || '').indexOf('inputEnvelope.') === 0,
      attack2);

    const attack3 = await evaluate(attackExpr(JSON.stringify({
      operation: 'memory-interpretation', characterId: CHARACTER_ID, timeoutMs: 20000,
      inputEnvelope: { selectedIds: IDS, records: RECORDS }, enabled: true
    })), true);
    check('3.4 ★★★ 调用方自带 enabled:true **不是**权威（未知字段 ⇒ 拒绝；成本闸门只认服务端策略）',
      attack3 && attack3.status === 400 && attack3.body && attack3.body.error === 'request-field-forbidden',
      attack3);

    check('3.5 ★★★★ 三次被拒的请求一条都没有到达 provider（provider 调用数 = 0）',
      provider.count() === 0, { providerCalls: provider.count(), seen: provider.seen.map(function (e) { return e.url; }) });

    /* ══════════════════════════════════════════════════════════════
       (f)-before：durable 面快照（等它**安静**下来再取）
       ══════════════════════════════════════════════════════════════ */
    section('4 · (f)-before · durable 面快照');
    const durableSnapshot = async function () {
      const mem = await homeGet('/memory/list?limit=500');
      const memChanges = await homeGet('/memory/changes?cursor=0&limit=500');
      const und = await homeGet('/understanding/list?limit=500');
      const undChanges = await homeGet('/understanding/changes?cursor=0&limit=500');
      const mp = payloadOf(mem); const mcp = payloadOf(memChanges);
      const up = payloadOf(und); const ucp = payloadOf(undChanges);
      return {
        memoryRecords: mp ? { status: mem.status, count: mp.count, revision: mp.revision, ids: (mp.records || []).map(function (r) { return r.id; }).join('|') } : { status: mem.status, error: mem.body && mem.body.error },
        memoryChangeFeed: mcp ? { status: memChanges.status, cursor: mcp.cursor, revision: mcp.revision, upserts: (mcp.upserts || []).length, deletes: (mcp.deletes || []).length } : { status: memChanges.status, error: memChanges.body && memChanges.body.error },
        understanding: up ? { status: und.status, count: up.count, revision: up.revision, ids: (up.records || []).map(function (r) { return r.id || r.characterId; }).join('|') } : { status: und.status, error: und.body && und.body.error },
        understandingChangeFeed: ucp ? { status: undChanges.status, cursor: ucp.cursor, revision: ucp.revision, upserts: (ucp.upserts || []).length, deletes: (ucp.deletes || []).length } : { status: undChanges.status, error: undChanges.body && undChanges.body.error },
        storeBytes: dirDigest(nodeDir),
        vaultBytes: dirDigest(vaultDir)
      };
    };
    let before = await durableSnapshot();
    let quiet = false;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const again = await durableSnapshot();
      if (JSON.stringify(again) === JSON.stringify(before)) { quiet = true; break; }
      before = again;
    }
    check('4.1 ★★ durable 面在动手之前已经安静（连续两次快照逐字节一致）',
      quiet, { before: before });
    check('4.2 ★★★ 四张读面都真的读到了（不是"读不到所以看起来没变"）',
      before.memoryRecords.status === 200 && before.memoryChangeFeed.status === 200 &&
      before.understanding.status === 200 && before.understandingChangeFeed.status === 200,
      before);
    const vaultDigestBefore = before.vaultBytes;

    /* ══════════════════════════════════════════════════════════════
       (c)(d)(e) 真实客户端 + 真实挂载面的 happy path
       ══════════════════════════════════════════════════════════════ */
    section('5 · (c)(d)(e) 真实客户端一次调用');
    /* ★ 调用方**故意**把这些权威字段塞进 input：客户端必须一个都不转发。
       同时用页面内的 fetch 探针记录**真正发出去的 body** —— 于是"闭集构造"
       的断言打在 wire 上，而不是打在源码的意图上。 */
    const happy = await evaluate(`(function(){
      var probe = window.__r4cWire = { requests: [] };
      var real = window.fetch;
      window.fetch = function(url, init){
        var u = String(url);
        if (u.indexOf('/internal/runtime/memory-interpretation') >= 0) {
          var body = null;
          try { body = JSON.parse(String(init && init.body)); } catch (e) { body = null; }
          probe.requests.push({ url: u, method: (init && init.method) || 'GET', body: body });
        }
        return real.apply(window, arguments);
      };
      var input = {
        characterId: ${JSON.stringify(CHARACTER_ID)},
        inputEnvelope: {
          selectedIds: ${JSON.stringify(IDS)},
          records: ${JSON.stringify(RECORDS)},
          evidence: {},
          currentState: { relationship: '同居', emotion: '平静' },
          roleName: '小满'
        },
        credentialRef: 'evil-ref', apiKey: ${JSON.stringify(SENTINEL)},
        provider: 'evil-provider', model: 'evil-model', endpoint: 'http://127.0.0.1:1/v1',
        systemPrompt: 'evil system prompt', prompt: 'evil prompt', messages: [{ role: 'user', content: 'evil' }]
      };
      var startedAt = Date.now();
      return Promise.resolve(IB.homeNode.runtime.runMemoryInterpretation(input, { timeoutMs: 20000 }))
        .then(function(res){ return { threw: false, res: res, wire: probe.requests, elapsedMs: Date.now() - startedAt }; },
              function(err){ return { threw: true, error: String((err && err.message) || err), wire: probe.requests, elapsedMs: Date.now() - startedAt }; });
    })()`, true);

    const happyRes = happy && happy.res;
    const wireBody = happy && happy.wire && happy.wire[0] ? happy.wire[0].body : null;
    check('5.1 ★★★★★ 真实客户端调用成功（HTTP 200 + ok:true）',
      !!happy && happy.threw === false && !!happyRes && happyRes.ok === true && happyRes.status === 200,
      { threw: happy && happy.threw, error: happy && happy.error, res: happyRes });
    check('5.2 ★★★★★ wire 上的 body 恰好四个键，且 operation 是模块常量（闭集构造）',
      !!wireBody && JSON.stringify(Object.keys(wireBody).sort()) === JSON.stringify(['characterId', 'inputEnvelope', 'operation', 'timeoutMs']) &&
      wireBody.operation === OPERATION && wireBody.characterId === CHARACTER_ID &&
      typeof wireBody.timeoutMs === 'number' && wireBody.timeoutMs === 20000,
      wireBody);
    check('5.3 ★★★★★ 调用方塞进来的 credentialRef/apiKey/provider/model/endpoint/prompt… 一个都没上 wire',
      !!wireBody && FORBIDDEN_FIELDS.every(function (f) {
        return !Object.prototype.hasOwnProperty.call(wireBody, f) &&
          !Object.prototype.hasOwnProperty.call(wireBody.inputEnvelope || {}, f);
      }) && JSON.stringify(wireBody).indexOf(SENTINEL) < 0 &&
      JSON.stringify(wireBody).indexOf('evil') < 0,
      { wireBody: wireBody, forbidden: FORBIDDEN_FIELDS });
    check('5.4 ★★★★ inputEnvelope 的五个键原样送达（闭集不等于丢字段）',
      !!wireBody && wireBody.inputEnvelope && wireBody.inputEnvelope.selectedIds.join(',') === IDS.join(',') &&
      (wireBody.inputEnvelope.records || []).length === RECORDS.length &&
      wireBody.inputEnvelope.roleName === '小满' &&
      wireBody.inputEnvelope.currentState && wireBody.inputEnvelope.currentState.emotion === '平静',
      wireBody && wireBody.inputEnvelope);

    /* (d) provider 恰一次。 */
    check('5.5 ★★★★★ (d) 假 provider 被调用**恰好 1 次**',
      provider.count() === 1, { calls: provider.count(), seen: provider.seen.map(function (e) { return e.url; }) });
    /* (c) 服务端自己解析 spec + Vault 解析 secret。 */
    const p0 = provider.seen[0] || null;
    const sentinelOccurrences = provider.seen.reduce(function (n, e) { return n + countOccurrences(JSON.stringify(e), SENTINEL); }, 0);
    const sentinelRequests = provider.seen.filter(function (e) { return JSON.stringify(e).indexOf(SENTINEL) >= 0; }).length;
    check('5.6 ★★★★★ (c) provider 观测到哨兵**恰好一次**（且只在 Authorization 里）',
      sentinelOccurrences === 1 && sentinelRequests === 1 && !!p0 && p0.authorization === 'Bearer ' + SENTINEL,
      { occurrences: sentinelOccurrences, requests: sentinelRequests, authorization: p0 && p0.authorization });
    check('5.7 ★★★★★ (c) provider 观测到的是**已发布的** endpoint 与 model（服务端从 characterId 解析）',
      !!p0 && p0.url === PROVIDER_PATH && p0.host === '127.0.0.1:' + providerPort && p0.body && p0.body.model === PROVIDER_MODEL,
      p0 && { url: p0.url, host: p0.host, model: p0.body && p0.body.model });
    check('5.8 ★★★★ prompt 权威在服务端核心：系统消息就是 R4-C 的 SYSTEM_INSTRUCTIONS',
      !!p0 && JSON.stringify(p0.body).indexOf(SYSTEM_AUTHORITY_SUBSTRING) >= 0 &&
      JSON.stringify(p0.body).indexOf('evil') < 0,
      p0 && JSON.stringify(p0.body).slice(0, 240));

    /* (e) 结果形状：非持久 + attempts === 1。 */
    check('5.9 ★★★★★ (e) 结果 durable:false 且 model.attempts === 1',
      !!happyRes && happyRes.durable === false && happyRes.model && happyRes.model.attempts === 1,
      happyRes && { durable: happyRes.durable, model: happyRes.model });
    check('5.10 ★★★★ (e) 校验过的条目真的回来了（items 覆盖请求的两条，没有 missingFor）',
      !!happyRes && Array.isArray(happyRes.items) && happyRes.items.length === IDS.length &&
      (happyRes.missingFor || []).length === 0 && happyRes.counts && happyRes.counts.returned === IDS.length &&
      happyRes.items.every(function (i) { return i.meaning && i.basis === 'ai_inference' && i.appraisal === 'neutral'; }),
      happyRes && { items: happyRes.items, missingFor: happyRes.missingFor, counts: happyRes.counts });
    check('5.11 ★★★ R4-C 的既有非持久语义一字未改：metaMemoryState/recollectionQuality 恒为 null',
      !!happyRes && happyRes.metaMemoryState === null && happyRes.recollectionQuality === null &&
      happyRes.operation === OPERATION && happyRes.characterId === CHARACTER_ID,
      happyRes && { meta: happyRes.metaMemoryState, rec: happyRes.recollectionQuality, op: happyRes.operation, cid: happyRes.characterId });
    check('5.12 ★★★ boundary 块自述：runtimeOnly / vaultReads=1 / providerCalls=1 / autoInvocation=NOT_IMPLEMENTED',
      !!happyRes && !!happyRes.boundary && happyRes.boundary.runtimeOnly === true && happyRes.boundary.durable === false &&
      happyRes.boundary.vaultReads === 1 && happyRes.boundary.providerCalls === 1 && happyRes.boundary.attempts === 1 &&
      happyRes.boundary.maxAttempts === 1 && happyRes.boundary.autoRetry === 'NONE' &&
      happyRes.boundary.autoInvocation === 'NOT_IMPLEMENTED',
      happyRes && happyRes.boundary);

    /* ── 负向对照：不发明默认超时；角色不存在时服务端如实说 spec 不可用 ── */
    section('6 · 负向对照（都不产生第二次 provider 调用）');
    const noTimeout = await evaluate(`(function(){
      return Promise.resolve(IB.homeNode.runtime.runMemoryInterpretation({
        characterId: ${JSON.stringify(CHARACTER_ID)},
        inputEnvelope: { selectedIds: ${JSON.stringify(IDS)}, records: ${JSON.stringify(RECORDS)} }
      }, {})).then(function(res){ return res; }, function(e){ return { threw: String(e) }; });
    })()`, true);
    const noTimeoutWire = await evaluate('(function(){ var w = (window.__r4cWire && window.__r4cWire.requests) || []; return w.length ? w[w.length-1].body : null; })()');
    check('6.1 ★★★★★ 调用方不给 timeoutMs ⇒ 服务端 timeout-authority-missing（浏览器**不**发明默认超时）',
      !!noTimeout && noTimeout.ok === false && noTimeout.error === 'timeout-authority-missing' &&
      (noTimeout.reasonCodes || []).indexOf('timeout-authority-missing') >= 0,
      noTimeout);
    check('6.2 ★★★ 这一次 wire 上的 timeoutMs 是 null（NaN 序列化的诚实形状），而不是被填成某个默认值',
      !!noTimeoutWire && noTimeoutWire.timeoutMs === null &&
      JSON.stringify(Object.keys(noTimeoutWire).sort()) === JSON.stringify(['characterId', 'inputEnvelope', 'operation', 'timeoutMs']),
      noTimeoutWire);

    const unknown = await evaluate(`(function(){
      return Promise.resolve(IB.homeNode.runtime.runMemoryInterpretation({
        characterId: ${JSON.stringify(UNKNOWN_CHARACTER_ID)},
        inputEnvelope: { selectedIds: ${JSON.stringify(IDS)}, records: ${JSON.stringify(RECORDS)} }
      }, { timeoutMs: 20000 })).then(function(res){ return res; }, function(e){ return { threw: String(e) }; });
    })()`, true);
    check('6.3 ★★★★ characterId 指向不存在的角色 ⇒ runtime-spec-unavailable（spec 只能由服务端从 characterId 解析）',
      !!unknown && unknown.ok === false && unknown.error === 'runtime-spec-unavailable' &&
      unknown.boundary && unknown.boundary.providerCalls === 0 && unknown.boundary.vaultReads === 0,
      unknown);
    check('6.4 ★★★★★ 以上两次失败之后 provider 仍然只被调用过 1 次（零重试、零额外成本）',
      provider.count() === 1, { calls: provider.count() });

    /* ══════════════════════════════════════════════════════════════
       (f) ZERO durable writes
       ══════════════════════════════════════════════════════════════ */
    section('7 · (f) 零 durable 写入');
    const after = await durableSnapshot();
    const sameLogical =
      JSON.stringify(before.memoryRecords) === JSON.stringify(after.memoryRecords) &&
      JSON.stringify(before.memoryChangeFeed) === JSON.stringify(after.memoryChangeFeed) &&
      JSON.stringify(before.understanding) === JSON.stringify(after.understanding) &&
      JSON.stringify(before.understandingChangeFeed) === JSON.stringify(after.understandingChangeFeed);
    check('7.1 ★★★★★ memory_records 与 memory change feed 逐字段不变（count/revision/ids/upserts/deletes）',
      JSON.stringify(before.memoryRecords) === JSON.stringify(after.memoryRecords) &&
      JSON.stringify(before.memoryChangeFeed) === JSON.stringify(after.memoryChangeFeed),
      { before: { r: before.memoryRecords, c: before.memoryChangeFeed }, after: { r: after.memoryRecords, c: after.memoryChangeFeed } });
    check('7.2 ★★★★★ Understanding 的 revision 与 change feed 逐字段不变（水位面没有被推进）',
      JSON.stringify(before.understanding) === JSON.stringify(after.understanding) &&
      JSON.stringify(before.understandingChangeFeed) === JSON.stringify(after.understandingChangeFeed),
      { before: { u: before.understanding, c: before.understandingChangeFeed }, after: { u: after.understanding, c: after.understandingChangeFeed } });
    const sameBytes = JSON.stringify(before.storeBytes) === JSON.stringify(after.storeBytes) &&
      JSON.stringify(before.vaultBytes) === JSON.stringify(after.vaultBytes);
    check('7.3 ★★★★★ SQLite store 文件与 Vault 凭据文件的 size+sha256 逐字节不变（零 durable 写入 · 零凭据改写）',
      sameBytes, { storeBefore: before.storeBytes, storeAfter: after.storeBytes, vaultBefore: vaultDigestBefore, vaultAfter: after.vaultBytes });
    check('7.4 ★★★ 逻辑面与字节面**同时**为零写入（不是"某一类看不出变化"）',
      sameLogical && sameBytes, { sameLogical: sameLogical, sameBytes: sameBytes });

    section('8 · 结果');
  } catch (error) {
    failed++;
    console.error('  ✖ 验收抛出异常 — ' + String((error && (error.stack || error.message)) || error));
  } finally {
    if (launched && typeof launched.close === 'function') { try { await launched.close(); } catch (_) { } }
    for (const c of children) { try { c.kill(); } catch (_) { } }
    await sleep(800);
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { } }
    console.log('\n' + (failed === 0 ? '全部通过 ✔' : failed + ' 项失败 ✘') +
      '  (' + passed + ' 通过 / ' + failed + ' 失败)');
    console.log('R4C_LIVE_BROWSER_BOUNDARY_VERDICT=' + (failed === 0 ? 'PASS' : 'FAIL'));
    console.log('R4C_LIVE_BROWSER_BOUNDARY_COUNTS passed=' + passed + ' failed=' + failed);
    /* ★ 显式退出：本文件持有 keep-alive 的 HTTP 句柄与一个 CDP socket，
       只靠"事件循环空了"退出在实测中不会发生（P22-24 的同一条收尾纪律）。 */
    process.exitCode = failed === 0 ? 0 : 1;
    setTimeout(function () { process.exit(failed === 0 ? 0 : 1); }, 200);
  }
})();
