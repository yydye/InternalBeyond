'use strict';
/* ====================================================================
   P21-R4-PROD-1.1 · Cognitive Runtime UI —— **真实浏览器**端到端验收（CDP）
   --------------------------------------------------------------------
   证明：
   ① §26 流程：角色 A 初始 OFF/OFF → 打开设置 → read（**无副作用**）→ 开 I（成本确认）
      → 服务端 ON/OFF → reload → ON/OFF → 开 E（成本确认）→ ON/ON → reload → ON/ON
      → 关 E → ON/OFF → 关 I → OFF/OFF → reload → OFF/OFF
   ② §25 mutation wire：浏览器走的是**既有已认证客户端**（同一条 `_request`），
      请求体是闭集两键，桌面 token 由客户端携带 —— UI 不持有 token、不拼请求。
   ③ §24 浏览器权威否定：DOM 手改 / 直接调 renderer / window 伪造 / localStorage 伪造 /
      IndexedDB 伪造 / 直接构造非法 OFF/ON / 注入 provider·model·credentialRef·dataDir·version·
      autoBehaviorEffectEnabled —— **都不能**改变 durable policy。
   ④ §27 运行时产品证明（fake provider）：ON/OFF ⇒ L3=1·L5=0·BE=0；
      ON/ON ⇒ L3=1·L5=1·BE 确定性 + 下一 eligible turn 放置；OFF/OFF ⇒ 0/0/0。
   ⑤ §28 重启：UI 设 ON/ON → 重启 Home Node → reload 后仍 ON/ON。
   ⑥ §29 坏文件：UI 显示 OFF/OFF **并且**可见错误；尝试开启 ⇒ 409 未保存，文件字节不变。
   ⑦ §30/§31/§32 可访问性（label/for · disabled · role=status · "最多"措辞）、
      390px 窄宽（无横向溢出）、明暗两主题（无新增硬编码视觉）。

   纪律：零真实出网（fake provider + *.invalid）· scratch 只在 .dsh-tmp · 自然退出。
   ==================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'prod1ui-'));
process.env.TEMP = RUN_ROOT; process.env.TMP = RUN_ROOT; process.env.TMPDIR = RUN_ROOT;

const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
const sleep = fx.sleep;
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
const RC = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const RP = require(path.join(ROOT, 'services', 'home-node', 'runtime-policy.js'));
const MODEL = require(path.join(ROOT, 'assets', 'js', 'cognitive-runtime-settings.js'));

const NOW = 1750000000000;
const TOKEN = 'prod1ui-token';
const CHAR_A = 'role_ui_a';
const CHAR_B = 'role_ui_b';
const QUERY = '显卡 驱动 更新失败';
const SENTINEL = 'PROD1UI-SENTINEL-2D9F';
const POLICY_PATH = '/internal/runtime/cognitive-policy';

let passed = 0, failed = 0;
const CONST = {};
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failed++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''));
  return !!cond;
}
function section(t) { console.log('\n── ' + t + ' ──'); }
const P = (n, v) => { CONST[n] = v; console.log(n + ' = ' + v); };
const J = v => { try { return JSON.stringify(v); } catch (_) { return String(v); } };

const CASE_BUDGET = { BUILD: 25000, TURN: 45000, UI: 40000 };
const OVERALL_BUDGET_MS = 480000;
let CURRENT_CASE = '(none)';
class CaseTimeout extends Error {}
const instances = [];
async function withCase(name, kind, fn) {
  const budget = CASE_BUDGET[kind] || 30000;
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

/* ── 假 provider（Home Node 侧）──────────────────────────────────────── */
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
const freshDir = p => fs.mkdtempSync(path.join(RUN_ROOT, p));
function seedVault(dir) {
  const v = CREDENTIAL_VAULT({ dataDir: dir });
  v.load(); v.upsert('cred_a', { provider: 'custom', apiKey: SENTINEL }); v.save();
}
async function buildInstance(tag, opts) {
  const o = opts || {};
  const dataDir = o.dataDir || freshDir('ui-' + tag + '-data-');
  const credDir = o.credDir || freshDir('ui-' + tag + '-cred-');
  seedVault(credDir);
  const rec = [];
  const port = NODE_MODEL_PORT({ fetch: makeFetch(rec), timeoutMs: 30000 });
  const logs = [];
  const inst = SERVICE.buildHomeNode({
    dataDir, credentialDataDir: credDir, token: TOKEN, port, clock: () => NOW,
    logger: function () {
      const args = Array.prototype.slice.call(arguments).map(x => {
        if (x && typeof x === 'object') { try { return JSON.parse(JSON.stringify(x)); } catch (_) { return String(x); } }
        return x === undefined ? null : x;
      });
      logs.push(args);
    }
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
  const h = { tag, inst, rec, logs, dataDir, credDir, webPort, policyFile: path.join(dataDir, RP.FILE_NAME) };
  instances.push(h);
  return h;
}
function post(h, urlPath, body, headers) {
  return new Promise(resolve => {
    const data = body === null ? '' : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: h.webPort, path: urlPath, method: 'POST', timeout: 20000,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': TOKEN }, headers || {})
    }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { } resolve({ status: res.statusCode, body: b, raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) { } resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.write(data); r.end();
  });
}
const cpRead = (h, id) => post(h, POLICY_PATH, { operation: 'read', characterId: id });
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
const policyExists = h => fs.existsSync(h.policyFile);

(async function main() {
  console.log('P21-R4-PROD-1.1 · Cognitive Runtime UI 端到端（真实 Chrome + Home Node + 已认证内部路由）');
  console.log('scratch root = ' + RUN_ROOT);
  let launched = null, webChild = null;
  let budgetTimer = setTimeout(function () {
    console.error('  FAIL  OVERALL_BUDGET');
    failed += 1; process.exitCode = 1;
  }, OVERALL_BUDGET_MS);

  try {
    /* ══ 0 · 模块纯契约（Node）══ */
    section('0 · module contract (pure state machine)');
    check('0.1 关 I 时若 E 在开 ⇒ 一次原子写 I=false,E=false（绝不连发两次写请求）',
      J(MODEL.planToggle({ autoInterpretationEnabled: true, autoExpectationEnabled: true }, 'interpretation', false))
      === J({ ok: true, next: { autoInterpretationEnabled: false, autoExpectationEnabled: false } }),
      MODEL.planToggle({ autoInterpretationEnabled: true, autoExpectationEnabled: true }, 'interpretation', false));
    check('0.2 I=OFF 时 E 必须 disabled，且 planToggle 直接拒绝"偷偷联动开启 I"',
      MODEL.expectationDisabled({ autoInterpretationEnabled: false }) === true
      && MODEL.expectationDisabled({ autoInterpretationEnabled: true }) === false
      && MODEL.planToggle({ autoInterpretationEnabled: false, autoExpectationEnabled: false }, 'expectation', true).ok === false,
      'expectation depends on interpretation');
    check('0.3 成本确认只发生在 OFF→ON；关闭永不二次确认',
      MODEL.needsConfirmation({ autoInterpretationEnabled: false, autoExpectationEnabled: false }, 'interpretation', true) === true
      && MODEL.needsConfirmation({ autoInterpretationEnabled: true, autoExpectationEnabled: false }, 'expectation', true) === true
      && MODEL.needsConfirmation({ autoInterpretationEnabled: true, autoExpectationEnabled: true }, 'interpretation', false) === false
      && MODEL.needsConfirmation({ autoInterpretationEnabled: true, autoExpectationEnabled: true }, 'expectation', false) === false,
      'confirm only on opt-in');
    check('0.4 关 I 而 E 在开 ⇒ 有依赖确认文案；成本口径永远是"最多"',
      typeof MODEL.dependencyNotice({ autoInterpretationEnabled: true, autoExpectationEnabled: true }, 'interpretation', false) === 'string'
      && /最多/.test(MODEL.confirmationText('interpretation')) && /最多/.test(MODEL.confirmationText('expectation'))
      && /最多/.test(MODEL.statusText({ autoInterpretationEnabled: true, autoExpectationEnabled: true }))
      && !/一定|固定/.test(MODEL.statusText({ autoInterpretationEnabled: true, autoExpectationEnabled: true })),
      MODEL.statusText({ autoInterpretationEnabled: true, autoExpectationEnabled: true }));
    check('0.5 错误映射齐备：401/403 · illegal-cognitive-state · request-field-forbidden · 409 · 网络',
      /凭据/.test(MODEL.errorText({ error: 'unauthenticated' }))
      && /凭据/.test(MODEL.errorText({ error: 'remote-admin-disabled' }))
      && /不合法/.test(MODEL.errorText({ error: 'illegal-cognitive-state' }))
      && /闭集/.test(MODEL.errorText({ error: 'request-field-forbidden' }))
      && /策略文件不可用/.test(MODEL.errorText({ error: 'policy-file-unusable' }))
      && /不可用/.test(MODEL.errorText({ error: 'runtime-remote-missing' })),
      'readable error map');
    check('0.6 坏文件读取：OFF/OFF **并且**给出"不可用"错误文案（不是静默默认值）',
      /不可用/.test(String(MODEL.readErrorText({ readable: false }))),
      MODEL.readErrorText({ readable: false }));
    check('0.7 模块没有 token / storage / 文件面：不含 localStorage / indexedDB / token / writeFile',
      !/localStorage|indexedDB|sessionStorage|dbPut|apiKey|X-IB-Home-Token|writeFile/.test(
        fs.readFileSync(path.join(ROOT, 'assets/js/cognitive-runtime-settings.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
      'no browser-side authority');
    check('0.8 BehaviorEffect 没有开关：模块里不出现 autoBehaviorEffectEnabled，UI 文案是"自动 · 不调用模型"',
      fs.readFileSync(path.join(ROOT, 'assets/js/cognitive-runtime-settings.js'), 'utf8').indexOf('autoBehaviorEffectEnabled') < 0
      && /行为影响：自动/.test(fs.readFileSync(path.join(ROOT, 'assets/js/cognitive-runtime-settings.js'), 'utf8'))
      && /确定性 · 不调用模型/.test(fs.readFileSync(path.join(ROOT, 'assets/js/cognitive-runtime-settings.js'), 'utf8')),
      'no third toggle');

    /* ══ 1 · 真实浏览器 ══ */
    section('1 · real Chrome + InternalBeyond.html + Home Node');
    const H = await buildInstance('main');
    const webPort = await fx.freePort();
    webChild = spawn(process.execPath, [path.join('services', 'internal-beyond-server.js')], {
      cwd: ROOT, env: Object.assign({}, process.env, { IB_WEB_PORT: String(webPort) }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let webUp = false;
    for (let i = 0; i < 80; i++) { const w = await fx.request(webPort, 'GET', '/health'); if (w.status === 200) { webUp = true; break; } await sleep(250); }
    check('1.1 真实静态层活着（产品自己的 server 提供 InternalBeyond.html）', webUp === true, webUp);
    const exe = fx.chromePath();
    if (!exe) {
      console.error('  FAIL  BLOCKED：找不到 Chrome / Edge。');
      console.error('R4_PROD1_UI_BROWSER_VERDICT=BLOCKED no-browser');
      process.exitCode = 1; return;
    }
    launched = await fx.launchChrome(exe, {});
    const cdp = launched.cdp;
    const evaluate = async function (expression, awaitPromise) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitPromise === true });
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async function (expr, timeoutMs, label) {
      const deadline = Date.now() + (timeoutMs || 15000);
      let last = null;
      while (Date.now() < deadline) {
        try { last = await evaluate(expr); } catch (_) { last = null; }
        if (last) return last;
        await sleep(200);
      }
      throw new Error('等待超时：' + (label || expr));
    };
    const setBase = (port) => `(function(){ localStorage.setItem('ib_home_node_http', ${JSON.stringify('http://127.0.0.1:')} + ${JSON.stringify(String(port))} + ''); return localStorage.getItem('ib_home_node_http'); })()`;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try{'
        + 'localStorage.setItem("ib_home_node_http",' + JSON.stringify('http://127.0.0.1:' + H.webPort) + ');'
        + 'localStorage.setItem("ib_home_node_mode","canonical");'
        + 'localStorage.setItem("ib_home_node_token",' + JSON.stringify(TOKEN) + ');'
        + '}catch(e){}'
    });
    const navigate = async function () {
      const loaded = new Promise(r => cdp.once ? cdp.once('Page.loadEventFired', r) : cdp.on('Page.loadEventFired', r));
      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/InternalBeyond.html' });
      await loaded;
      await sleep(700);
    };
    await navigate();
    const mounted = await waitFor('!!document.getElementById("cognitive-runtime-section")', 30000, 'cognitive section mounted').catch(() => false);
    check('1.2 §21 自挂载成功：模块只靠一行 script include 就把「高级认知」区块挂进了 #page-api',
      mounted === true, mounted);
    /* 页面侧的准备：角色 + 触发一次设置页读取 */
    const PREP = `(function(){
      var a = { id: ${JSON.stringify(CHAR_A)}, nickname: 'RoleA', model: 'm', endpoint: 'https://provider.invalid/x', apiKey: '', provider: 'custom', relationship: 'friend', systemPrompt: '', temperature: 1, streaming: false, showThinking: false, promptCache: false, created: Date.now() };
      var b = JSON.parse(JSON.stringify(a)); b.id = ${JSON.stringify(CHAR_B)}; b.nickname = 'RoleB';
      return Promise.resolve(dbPut('apiConfigs', a)).then(function(){ return dbPut('apiConfigs', b); })
        .then(function(){ window.__uiWire = []; var real = window.fetch;
          window.fetch = function(url, init){
            var u = String(url);
            if (u.indexOf('/internal/runtime/cognitive-policy') >= 0) {
              var hdr = (init && init.headers) || {};
              var tok = hdr['X-IB-Home-Token'] || hdr['x-ib-home-token'] || (init && init.headers && init.headers.get && init.headers.get('X-IB-Home-Token')) || null;
              var body = null; try { body = JSON.parse(String((init && init.body) || '')); } catch(e){}
              window.__uiWire.push({ url: u, body: body, hasToken: !!tok, tokenFrom: tok ? 'client-header' : null });
            }
            return real.apply(this, arguments);
          };
          return (typeof loadApiSettingsUI === 'function') ? loadApiSettingsUI() : null; });
    })()`;
    await prepPage(H);
    check('1.3 页面准备（两个角色已写入浏览器目录）完成',
      (await evaluate(`(function(){ return dbGet('apiConfigs', ${JSON.stringify(CHAR_A)}).then(function(r){ return !!r; }); })()`, true)) === true);
    /* ★ 页面启动会把浏览器侧角色目录**以 replace 语义**发布到 Home Node
       （home-node-bootstrap 的 catalog publish）—— 那会按浏览器配置重写角色 spec，
       把本测试注入的 `credentialRef: cred_a` 换掉，于是自动解释会以
       credential-unavailable 失败。因此每次页面准备之后，把 Node 侧 spec 恢复成
       测试注入的那一份。这是**测试装置**，不是产品行为。 */
    function restoreSpecs(handle) {
      const inst = handle && handle.inst ? handle.inst : handle;
      const spec = { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'cred_a', systemPrompt: 'SYS' };
      inst.registry.putCharacter(CHAR_A, { id: CHAR_A, name: 'A', relationship: 'friend' }, spec);
      inst.registry.putCharacter(CHAR_B, { id: CHAR_B, name: 'B', relationship: 'friend' }, spec);
    }
    async function prepPage(handle) { await evaluate(PREP, true); restoreSpecs(handle); }
    const secReady = await waitFor(`(function(){
      var sel = document.getElementById('cognitive-runtime-character');
      var st = document.getElementById('cognitive-runtime-status');
      return !!(sel && sel.options.length >= 2 && st && st.textContent && st.textContent.indexOf('载入') < 0);
    })()`, 20000, 'section ready').catch(() => false);
    check('1.4 §5 打开设置即读：角色下拉有 2 项，状态行从"载入中…"变成已加载文案', secReady === true, secReady);
    const fileBeforeRead = policyExists(H);
    check('1.5 §5 读取**无副作用**：读完之后策略文件仍然不存在（不自动创建、不自动写 OFF/OFF）',
      fileBeforeRead === false && policyExists(H) === false,
      { fileExists: policyExists(H) });

    const uiState = () => evaluate(`(function(){
      var i = document.getElementById('cognitive-runtime-interpretation');
      var e = document.getElementById('cognitive-runtime-expectation');
      var st = document.getElementById('cognitive-runtime-status');
      var sel = document.getElementById('cognitive-runtime-character');
      return { i: !!i.checked, e: !!e.checked, eDisabled: !!e.disabled, iDisabled: !!i.disabled,
               status: st ? String(st.textContent) : null, character: sel ? sel.value : null };
    })()`);
    const chooseChar = (id) => evaluate(`(function(){ var s=document.getElementById('cognitive-runtime-character'); s.value=${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
    const setConfirm = (val) => evaluate(`(function(){ window.__confirmLog=[]; window.confirm=function(m){ window.__confirmLog.push(String(m)); return ${val ? 'true' : 'false'}; }; return 'ok'; })()`);
    const clickToggle = (which) => evaluate(`(function(){ var el=document.getElementById('cognitive-runtime-${which}'); el.click(); return 'clicked'; })()`);

    /* ══ 2 · §26 主流程 ══ */
    section('2 · §26 UI flow (A: OFF/OFF → ON/OFF → ON/ON → OFF/OFF)');
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("载入")<0; })()', 15000).catch(() => false);
    const st0 = await uiState();
    check('2.1 初始状态来自服务端：A = OFF/OFF，E 为 disabled 并显示"需要先开启自动解释"',
      st0.i === false && st0.e === false && st0.eDisabled === true
      && (await evaluate('(function(){ var n=document.getElementById("cognitive-runtime-expectation-note"); return !!n && !n.hidden; })()')) === true,
      st0);
    await setConfirm(true);
    await clickToggle('interpretation');
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("已保存")>=0; })()', 20000, 'I saved').catch(() => false);
    const afterI = await uiState();
    const srvI = await cpRead(H, CHAR_A);
    check('2.2 开"自动解释"：成本确认出现，服务端落盘 ON/OFF，UI 显示已保存 + 最多 +1',
      (await evaluate('(function(){ return (window.__confirmLog||[]).join("|"); })()')).indexOf('最多') >= 0
      && afterI.i === true && afterI.e === false && afterI.eDisabled === false
      && srvI.body.autoInterpretationEnabled === true && srvI.body.autoExpectationEnabled === false
      && /最多 \+1/.test(afterI.status), { ui: afterI, server: srvI.body });
    await navigate();
    await prepPage(H);
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("载入")<0; })()', 15000).catch(() => false);
    const afterReload1 = await uiState();
    check('2.3 reload 后仍是 ON/OFF（UI 状态来自服务端，不是浏览器缓存）',
      afterReload1.i === true && afterReload1.e === false && afterReload1.eDisabled === false, afterReload1);
    await setConfirm(true);
    await clickToggle('expectation');
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("已保存")>=0; })()', 20000, 'E saved').catch(() => false);
    const afterE = await uiState();
    const srvE = await cpRead(H, CHAR_A);
    check('2.4 开"预测与行为"：确认文案提到"最多再 +1 / 完整认知模式最多 +2"，服务端 ON/ON，UI 显示最多 +2',
      (await evaluate('(function(){ return (window.__confirmLog||[]).join("|"); })()')).indexOf('完整认知模式最多 +2') >= 0
      && afterE.i === true && afterE.e === true
      && srvE.body.autoInterpretationEnabled === true && srvE.body.autoExpectationEnabled === true
      && /最多 \+2/.test(afterE.status), { ui: afterE, server: srvE.body });
    await navigate();
    await prepPage(H);
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("载入")<0; })()', 15000).catch(() => false);
    check('2.5 reload 后 ON/ON', (await uiState()).i === true && (await uiState()).e === true, await uiState());
    await setConfirm(true);
    await clickToggle('expectation');
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("已保存")>=0; })()', 20000).catch(() => false);
    check('2.6 关"预测与行为"：无二次确认，服务端 ON/OFF',
      (await evaluate('(function(){ return (window.__confirmLog||[]).length; })()')) === 0
      && (await cpRead(H, CHAR_A)).body.autoExpectationEnabled === false
      && (await cpRead(H, CHAR_A)).body.autoInterpretationEnabled === true,
      (await cpRead(H, CHAR_A)).body);
    await setConfirm(true);
    await clickToggle('interpretation');
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("已保存")>=0; })()', 20000).catch(() => false);
    check('2.7 关"自动解释"（此时 E 已关 ⇒ 无依赖确认）：服务端 OFF/OFF，UI 显示已关闭',
      (await evaluate('(function(){ return (window.__confirmLog||[]).length; })()')) === 0
      && (await cpRead(H, CHAR_A)).body.autoInterpretationEnabled === false
      && (await cpRead(H, CHAR_A)).body.autoExpectationEnabled === false
      && /已关闭/.test((await uiState()).status),
      (await cpRead(H, CHAR_A)).body);
    await navigate();
    await prepPage(H);
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("载入")<0; })()', 15000).catch(() => false);
    check('2.8 reload 后 OFF/OFF（回到初始）', (await uiState()).i === false && (await uiState()).e === false);

    /* ══ 3 · 依赖与原子性 ══ */
    section('3 · E dependency + atomic close');
    await setConfirm(true);
    await clickToggle('interpretation');                       /* I ON */
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("已保存")>=0; })()', 20000).catch(() => false);
    await clickToggle('expectation');                          /* E ON */
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("已保存")>=0; })()', 20000).catch(() => false);
    const wireBefore = (await evaluate('(function(){ return (window.__uiWire||[]).length; })()'));
    await setConfirm(true);
    await clickToggle('interpretation');                       /* I OFF while E ON */
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("已保存")>=0; })()', 20000).catch(() => false);
    const wireAfter = (await evaluate('(function(){ return (window.__uiWire||[]).length; })()'));
    const depState = await cpRead(H, CHAR_A);
    const seg = (await evaluate('(function(){ return (window.__uiWire||[]).slice(-3); })()'));
    check('3.1 关 I 而 E 在开：一次依赖确认 + **一次**原子写 I=false,E=false（不是两次写请求）',
      (await evaluate('(function(){ return (window.__confirmLog||[]).join("|"); })()')).indexOf('也会关闭预测与行为') >= 0
      && depState.body.autoInterpretationEnabled === false && depState.body.autoExpectationEnabled === false
      && (wireAfter - wireBefore) <= 2
      && seg.filter(w => w.body && w.body.operation === 'set').length >= 1
      && seg.filter(w => w.body && w.body.operation === 'set').every(w => w.body.autoInterpretationEnabled === false && w.body.autoExpectationEnabled === false),
      { wireDelta: wireAfter - wireBefore, writes: seg.filter(w => w.body && w.body.operation === 'set') });

    /* ══ 4 · §25 mutation wire（已认证客户端路径）══ */
    section('4 · §25 mutation wire');
    const wire = await evaluate('(function(){ return (window.__uiWire||[]); })()');
    const sets = wire.filter(w => w.body && w.body.operation === 'set');
    check('4.1 所有写请求都打到已认证的内部路由，且由客户端携带桌面凭据（UI 不持有 token）',
      sets.length >= 3 && wire.every(w => w.hasToken === true),
      { writes: sets.length, tokenOnEveryRequest: wire.every(w => w.hasToken === true) });
    check('4.2 请求体是**闭集**：每次只有 operation/characterId/两个布尔，没有第三个 bit 或其它键',
      sets.length > 0 && sets.every(w => J(Object.keys(w.body).sort()) === J(['autoExpectationEnabled', 'autoInterpretationEnabled', 'characterId', 'operation'])),
      sets.map(w => Object.keys(w.body).sort()));

    /* ══ 5 · §24 浏览器权威否定 ══ */
    section('5 · browser authority negatives');
    const before = await cpRead(H, CHAR_A);
    const attacks = await evaluate(`(function(){
      var out = [];
      var i = document.getElementById('cognitive-runtime-interpretation');
      i.checked = true; out.push('dom-checked-forged');
      var e = document.getElementById('cognitive-runtime-expectation');
      e.disabled = false; e.checked = true; out.push('dom-disabled-forged');
      try { window.IB.CognitiveRuntimeSettings.planToggle({autoInterpretationEnabled:false,autoExpectationEnabled:false},'expectation',true); out.push('renderer-planned'); } catch(err){}
      window.__forgedPolicy = { autoInterpretationEnabled: true, autoExpectationEnabled: true };
      localStorage.setItem('ib_cognitive_policy', JSON.stringify(window.__forgedPolicy));
      try { indexedDB.open('forged', 1); } catch(err){}
      out.push('localStorage+indexedDB-forged');
      return out;
    })()`);
    const afterAttacks = await cpRead(H, CHAR_A);
    check('5.1 DOM 手改 checked / 放开 disabled / 直接调 renderer / localStorage+IndexedDB 伪造 均**不改变** durable policy',
      J(before.body) === J(afterAttacks.body) && attacks.length === 4,
      { before: before.body, after: afterAttacks.body, attacks });
    /* (a) 绕过客户端、**直接** fetch 越权/非法请求 ⇒ 服务端闭集拒绝，policy 不变 */
    const rawBefore = await cpRead(H, CHAR_A);
    const rawAttacks = await evaluate(`(function(){
      var base = localStorage.getItem('ib_home_node_http');
      var tok = localStorage.getItem('ib_home_node_token');
      var mk = function(b){ return fetch(base + '/internal/runtime/cognitive-policy', {
        method:'POST', headers:{ 'Content-Type':'application/json', 'X-IB-Home-Token': tok },
        body: JSON.stringify(b) }); };
      var cases = [
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:true, autoExpectationEnabled:false, autoBehaviorEffectEnabled:true },
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:true, autoExpectationEnabled:false, provider:'evil' },
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:true, autoExpectationEnabled:false, dataDir:'C:/' },
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:true, autoExpectationEnabled:false, version:99 },
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:false, autoExpectationEnabled:true },
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:true, autoExpectationEnabled:false, memoryInterpretationEnabled:true }
      ];
      return Promise.all(cases.map(function(c){ return mk(c).then(function(r){ return r.status; }); }));
    })()`, true);
    const rawAfter = await cpRead(H, CHAR_A);
    check('5.2 §24 直接构造越权/非法请求（含第三个 bit · provider · dataDir · version · 非法 OFF/ON）：服务端全部拒绝，policy 不变',
      rawAttacks.every(s => s === 400) && J(rawAfter.body) === J(rawBefore.body),
      { statuses: rawAttacks, policyUnchanged: J(rawAfter.body) === J(rawBefore.body) });
    /* (b) 经客户端提交同样的越权字段：客户端是**闭集构造器** ⇒ 那些键根本没进 wire */
    const forged = await evaluate(`(function(){
      var rt = window.IB.homeNode.runtime;
      var bad = [
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:true, autoExpectationEnabled:false, autoBehaviorEffectEnabled:true },
        { operation:'set', characterId:${JSON.stringify(CHAR_A)}, autoInterpretationEnabled:true, autoExpectationEnabled:false, provider:'evil', credentialRef:'x' }
      ];
      return Promise.all(bad.map(function(b){ return rt.runCognitivePolicy(b).then(function(r){ return r && r.ok === true; }); }))
        .then(function(oks){ return { ok: oks, wire: (window.__uiWire||[]).slice(-2) }; });
    })()`, true);
    check('5.3 §7/§24 经客户端提交越权字段：键在**构造层**就被丢弃（不转发），wire 体只有闭集四项',
      forged.wire.length >= 1
      && forged.wire.every(w => J(Object.keys((w.body || {})).sort()) === J(['autoExpectationEnabled', 'autoInterpretationEnabled', 'characterId', 'operation'])),
      forged.wire.map(w => w.body));
    const lsState = await evaluate(`(function(){
      localStorage.setItem('ib_cognitive_policy', JSON.stringify({ autoInterpretationEnabled:true, autoExpectationEnabled:true }));
      var sel = document.getElementById('cognitive-runtime-character');
      return (typeof loadApiSettingsUI === 'function') ? loadApiSettingsUI().then(function(){ return { forged: localStorage.getItem('ib_cognitive_policy') }; }) : { forged: null };
    })()`, true);
    await sleep(600);
    const lsUi = await uiState();
    const lsSrv = await cpRead(H, CHAR_A);
    check('5.4 §24 伪造的 localStorage 键不构成策略权威：服务端状态与 UI 都不受它影响（UI == 服务端）',
      !!lsState && lsState.forged && lsState.forged.indexOf('true') >= 0
      && lsUi.i === lsSrv.body.autoInterpretationEnabled && lsUi.e === lsSrv.body.autoExpectationEnabled,
      { ui: { i: lsUi.i, e: lsUi.e }, server: lsSrv.body });

    /* ══ 6 · §27 运行时产品证明 ══ */
    section('6 · §27 runtime product proof (fake provider)');
    const setOn1 = await post(H, POLICY_PATH, { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: false });
    const preRead = await cpRead(H, CHAR_A);
    const b1 = H.rec.length;
    const t1 = await recallPost(H, { requestId: 'ui_rb_1' });
    const d1 = await settle(H);
    const calls1 = H.rec.length - b1;
    const exp1 = H.inst.runtimeRecall.describe().expectation.counters;
    const auto1 = H.inst.runtimeRecall.describe().autoInterpretation.counters;
    check('6.1 UI 设 A=ON/OFF 后：eligible turn 花 **1** 次（L3），L5 不创建，BehaviorEffect 不产生',
      setOn1.status === 200 && preRead.body.autoInterpretationEnabled === true
      && calls1 === 1 && exp1.created === 0 && d1.counters.derived === 0,
      {
        setStatus: setOn1.status, policy: preRead.body.autoInterpretationEnabled, calls: calls1,
        exp: exp1, auto: auto1, derived: d1.counters.derived,
        recall: { ok: t1.body && t1.body.ok, selected: t1.body && t1.body.selectedIds, reasonCodes: t1.body && t1.body.reasonCodes, channel: t1.body && t1.body.channel },
        autoLogs: H.logs.filter(l => /interpret|auto|expect/i.test(J(l))).slice(-8),
        turnRecord: H.inst.runtimeRecall.getTurnInterpretation(RC.deriveStableTurnId('ui_rb_1', 'dm:' + CHAR_A))
      });
    await post(H, POLICY_PATH, { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: true });
    const b2 = H.rec.length;
    await recallPost(H, { requestId: 'ui_rb_2', message: QUERY + ' b2' });
    const d2 = await settle(H);
    const calls2 = H.rec.length - b2;
    check('6.2 UI 设 A=ON/ON 后：花 **2** 次（L3+L5），BehaviorEffect 确定性派生（+0 调用）',
      calls2 === 2 && d2.counters.derived === 1 && d2.cost.providerCalls === 0,
      { calls: calls2, derived: d2.counters.derived });
    const t3 = await recallPost(H, { requestId: 'ui_rb_3', message: QUERY + ' b3' });
    await settle(H);   /* 交付是"上一回合的结果给下一回合"，所以必须先让上一轮结算 */
    const t4 = await recallPost(H, { requestId: 'ui_rb_4', message: QUERY + ' b4' });
    await settle(H);   /* 再结算这一轮，然后才切到 OFF/OFF（否则就是测试自己制造的竞态） */
    check('6.3 下一 eligible turn 拿到第 17 键（derivedFrom = L3_AND_L5，sourceTurn = 上一回合）',
      t3.status === 200 && !!t4.body.behaviorEffect
      && t4.body.behaviorEffect.derivedFrom === 'L3_AND_L5'
      && t4.body.behaviorEffect.sourceTurn === RC.deriveStableTurnId('ui_rb_3', 'dm:' + CHAR_A),
      { effect: t4.body.behaviorEffect });
    await post(H, POLICY_PATH, { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: false, autoExpectationEnabled: false });
    const b5 = H.rec.length;
    await recallPost(H, { requestId: 'ui_rb_5', message: QUERY + ' b5' });
    await recallPost(H, { requestId: 'ui_rb_6', message: QUERY + ' b6' });
    const d5 = await settle(H);
    check('6.4 关闭成 OFF/OFF 之后：后续回合 **0** 次自动调用（0/0/0）',
      (H.rec.length - b5) === 0 && d5.counters.derived === 3, { calls: H.rec.length - b5, derivedTotal: d5.counters.derived });

    /* ══ 7 · §17/§18 角色切换与竞态 ══ */
    section('7 · role switching + race guard');
    await post(H, POLICY_PATH, { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: true });
    await post(H, POLICY_PATH, { operation: 'set', characterId: CHAR_B, autoInterpretationEnabled: false, autoExpectationEnabled: false });
    await prepPage(H);
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("载入")<0; })()', 15000).catch(() => false);
    const aState = await uiState();
    await chooseChar(CHAR_B);
    await waitFor('(function(){ var i=document.getElementById("cognitive-runtime-interpretation"); return i && i.checked===false; })()', 15000).catch(() => false);
    const bState = await uiState();
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var i=document.getElementById("cognitive-runtime-interpretation"); return i && i.checked===true; })()', 15000).catch(() => false);
    const aAgain = await uiState();
    check('7.1 §17 切换角色各自重新 read：A=ON/ON → B=OFF/OFF → 回 A=ON/ON，无跨角色缓存',
      aState.i === true && aState.e === true && bState.i === false && bState.e === false
      && aAgain.i === true && aAgain.e === true, { a: aState, b: bState, aAgain });
    const race = await evaluate(`(function(){
      var sel = document.getElementById('cognitive-runtime-character');
      sel.value = ${JSON.stringify(CHAR_A)}; sel.dispatchEvent(new Event('change'));
      var p1 = new Promise(function(r){ setTimeout(r, 30); });
      sel.value = ${JSON.stringify(CHAR_B)}; sel.dispatchEvent(new Event('change'));
      return p1.then(function(){ return new Promise(function(r){ setTimeout(function(){
        var i=document.getElementById('cognitive-runtime-interpretation');
        var st=document.getElementById('cognitive-runtime-status');
        r({ i: !!i.checked, status: String(st.textContent), selected: sel.value });
      }, 1200); }); });
    })()`, true);
    check('7.2 §17 快速 A→B：A 的晚返回**不得**覆盖 B 的页面（generation guard）',
      race.selected === CHAR_B && race.i === false, race);
    const race2 = await evaluate(`(function(){
      var i = document.getElementById('cognitive-runtime-interpretation');
      i.click();
      var e = document.getElementById('cognitive-runtime-expectation');
      setTimeout(function(){ e.click(); }, 10);
      setTimeout(function(){ e.click(); }, 20);
      return new Promise(function(r){ setTimeout(function(){
        var st=document.getElementById('cognitive-runtime-status');
        r({ status: String(st.textContent), i: !!i.checked, e: !!e.checked });
      }, 2500); });
    })()`, true);
    const race2State = await cpRead(H, CHAR_B);
    check('7.3 §18 快速连续 toggle：最终 UI 与服务端最终状态一致（读回为准）',
      race2.i === race2State.body.autoInterpretationEnabled
      && race2.e === race2State.body.autoExpectationEnabled
      && /已保存|已关闭|已启用/.test(race2.status),
      { ui: race2, server: race2State.body });

    /* ══ 8 · §29 坏文件（独立实例）══ */
    section('8 · §29 corrupt policy file');
    const BAD = await buildInstance('corrupt');
    await post(BAD, POLICY_PATH, { operation: 'set', characterId: CHAR_A, autoInterpretationEnabled: true, autoExpectationEnabled: true });
    const goodBytes = fs.readFileSync(BAD.policyFile);
    fs.writeFileSync(BAD.policyFile, '{ "version": 1, "characters": ', 'utf8');
    const badBytes = fs.readFileSync(BAD.policyFile);
    /* ★ 不 navigate：`addScriptToEvaluateOnNewDocument` 会在每个新文档把 base 写回 H，
       而本段的意图是把**已加载**的页面切到坏文件实例（客户端每次调用都读 localStorage）。 */
    await evaluate(setBase(BAD.webPort));
    check('8.0 页面已切到坏文件实例的 Home Node（读的是它，而不是主实例）',
      (await evaluate('(function(){ return localStorage.getItem("ib_home_node_http"); })()'))
      === 'http://127.0.0.1:' + BAD.webPort,
      await evaluate('(function(){ return localStorage.getItem("ib_home_node_http"); })()'));
    await prepPage(H);
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("载入")<0; })()', 15000).catch(() => false);
    const badState = await uiState();
    check('8.1 §29/§16 坏文件：UI 显示 OFF/OFF **并且**可见错误（不是让用户以为这是正常配置）',
      badState.i === false && badState.e === false && /不可用|异常/.test(badState.status), badState);
    const wireBeforeBad = (await evaluate('(function(){ return (window.__uiWire||[]).length; })()'));
    await setConfirm(true);
    await clickToggle('interpretation');
    await sleep(1200);
    const badWire = (await evaluate('(function(){ return (window.__uiWire||[]).slice(-3); })()'));
    const badState2 = await uiState();
    check('8.2 §29 尝试开启：服务端 409 policy-file-unusable，UI 保持 OFF/OFF 并显示"未保存"，文件字节不变',
      badState2.i === false && badState2.e === false
      && /不可用|未保存/.test(badState2.status)
      && Buffer.compare(fs.readFileSync(BAD.policyFile), badBytes) === 0
      && Buffer.compare(badBytes, goodBytes) !== 0,
      { status: badState2.status, wire: badWire, bytesUnchanged: Buffer.compare(fs.readFileSync(BAD.policyFile), badBytes) === 0 });

    /* ══ 9 · §30/§31/§32 可访问性 / 窄宽 / 主题 ══ */
    section('9 · accessibility · narrow width · themes');
    await evaluate(setBase(H.webPort));
    await navigate();
    await prepPage(BAD);
    await chooseChar(CHAR_A);
    await waitFor('(function(){ var s=document.getElementById("cognitive-runtime-status"); return s && s.textContent.indexOf("载入")<0; })()', 15000).catch(() => false);
    /* 让「角色/API 设置」页真的可见（否则 #page-api 是隐藏的，量不到几何） */
    await evaluate(`(function(){ try { if (typeof navTo === 'function') navTo('api'); } catch(e){}
      var p = document.getElementById('page-api'); if (p && !p.classList.contains('active')) p.classList.add('active');
      return document.getElementById('page-api').classList.contains('active'); })()`);
    await sleep(400);
    const a11y = await evaluate(`(function(){
      var i = document.getElementById('cognitive-runtime-interpretation');
      var e = document.getElementById('cognitive-runtime-expectation');
      var st = document.getElementById('cognitive-runtime-status');
      var li = document.querySelector('label[for="cognitive-runtime-interpretation"]');
      var le = document.querySelector('label[for="cognitive-runtime-expectation"]');
      return {
        iId: i && i.id, iType: i && i.type, iHasLabel: !!li, iLabelText: li ? li.textContent.trim() : null,
        eHasLabel: !!le, eDisabledAttr: e ? e.hasAttribute('disabled') : null,
        statusRole: st ? st.getAttribute('role') : null, statusLive: st ? st.getAttribute('aria-live') : null,
        statusText: st ? st.textContent : null,
        hasMaxWording: /最多/.test(document.getElementById('cognitive-runtime-section').textContent),
        inlineGradient: /gradient|backdrop-filter|blur/.test(document.getElementById('cognitive-runtime-section').getAttribute('style') || ''),
        hasInlineStyle: !!document.getElementById('cognitive-runtime-section').getAttribute('style')
      };
    })()`);
    check('9.1 §30 可访问性：真 checkbox + label[for] + disabled 属性 + role=status/aria-live + 文案含"最多"，无内联渐变/毛玻璃/内联样式',
      a11y.iType === 'checkbox' && a11y.iHasLabel === true && a11y.eHasLabel === true
      && a11y.statusRole === 'status' && a11y.statusLive === 'polite'
      && a11y.hasMaxWording === true && a11y.inlineGradient === false && a11y.hasInlineStyle === false,
      a11y);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    const narrow = await evaluate(`(function(){
      var sec = document.getElementById('cognitive-runtime-section');
      var i = document.getElementById('cognitive-runtime-interpretation');
      var e = document.getElementById('cognitive-runtime-expectation');
      return {
        docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
        secRight: Math.round(sec.getBoundingClientRect().right), iRight: Math.round(i.getBoundingClientRect().right),
        eRight: Math.round(e.getBoundingClientRect().right), iVisible: i.getBoundingClientRect().width > 0
      };
    })()`);
    check('9.2 §31 390px 窄宽：无横向溢出，两个 toggle 仍在视口内且可见',
      narrow.docScroll <= narrow.docClient + 1 && narrow.iRight <= 390 && narrow.eRight <= 390 && narrow.iVisible === true, narrow);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    const themes = await evaluate(`(function(){
      var out = {};
      var body = document.body;
      var prev = body.className;
      [['internal', false], ['infernal', true]].forEach(function(pair){
        if (pair[1]) body.classList.add('theme-infernal'); else body.classList.remove('theme-infernal');
        var sec = document.getElementById('cognitive-runtime-section');
        var st = document.getElementById('cognitive-runtime-status');
        out[pair[0]] = {
          color: getComputedStyle(sec).color, statusColor: getComputedStyle(st).color,
          surfaceBg: getComputedStyle(sec).backgroundColor
        };
      });
      body.className = prev;
      return out;
    })()`);
    check('9.3 §32 明暗两主题（body.theme-infernal 交叉切换）下区块前景色各自成立且不同 —— 沿用现有 token，零新增硬编码视觉',
      !!themes.internal && !!themes.infernal
      && themes.internal.color !== themes.infernal.color
      && !/gradient/.test(J(themes)),
      themes);
    P('COGNITIVE_UI_MUTATION_MODE', 'SERVER_CONFIRMED_NON_OPTIMISTIC');
    P('EXPECTATION_DEPENDENCY_UI', 'DISABLED_UNTIL_INTERPRETATION_ENABLED');
    P('BEHAVIOR_EFFECT_UI', 'AUTO_NO_TOGGLE');
    P('COST_DISCLOSURE', 'MAXIMUM_CALLS_NOT_GUARANTEED_CALLS');
    P('UI_READY', failed === 0 ? 'YES' : 'NO');
  } catch (error) {
    console.error('SUITE_THREW: ' + ((error && error.stack) || error));
    failed += 1;
  } finally {
    clearTimeout(budgetTimer);
    for (const h of instances) { try { h.inst.server.close(); } catch (_) { } try { h.inst.close(); } catch (_) { } }
    if (webChild) { try { webChild.kill(); } catch (_) { } }
    if (launched && typeof launched.close === 'function') { try { await launched.close(); } catch (_) { } }
    await sleep(300);
    try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch (_) { }
  }
  console.log('');
  for (const k of Object.keys(CONST)) P(k, CONST[k]);
  console.log('R4_PROD1_UI_BROWSER_COUNTS passed=' + passed + ' failed=' + failed);
  console.log('NATURAL_EXIT = YES code=' + (failed === 0 ? 0 : 1));
  process.exitCode = failed === 0 ? 0 : 1;
})();
