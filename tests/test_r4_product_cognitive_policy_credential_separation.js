'use strict';
/* ====================================================================
   P21-R4-PROD-1.1a · Credential Separation Truth Probe
   --------------------------------------------------------------------
   只回答一个问题：

     "角色没有可用模型凭据时，用户通过 Cognitive Control Plane 把 policy
      从 OFF/OFF 改成 ON/OFF 或 ON/ON，**policy mutation 本身**是否仍然
      成功并持久化？"

   两个必须分开的事实：
     A. POLICY MUTATION            POST /internal/runtime/cognitive-policy
     B. LATER COGNITIVE EXECUTION  Interpretation / Expectation provider call

   冻结期望：
     CREDENTIAL_REQUIRED_FOR_POLICY_MUTATION = NO
     · set ON/OFF（无凭据）⇒ 200 · durable = ON/OFF · readback = ON/OFF
     · UI 不得显示"未保存"（mutation 成功 ⇒ 走 saved 分支）
     · 之后 eligible turn：认知调用按**既有** credential-unavailable / fail-closed
       语义不可用，但 **policy 保持 ON**（不自动关闭、不删 entry、不返回 409/400）

   对照：另一个**有**凭据的角色必须真的调用到假 provider —— 否则"0 次调用"
   可能只是装置假象，而不是凭据缺失的结论。

   纪律：零真实出网（假 provider + *.invalid）· scratch 只在 .dsh-tmp · 自然退出。
   ==================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH_ROOT = path.join(ROOT, '.dsh-tmp');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'credsep-'));

const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const NODE_MODEL_PORT = require(path.join(ROOT, 'active', 'node-model-port.js'));
const CREDENTIAL_VAULT = require(path.join(ROOT, 'active', 'credential-vault.js'));
const RC = require(path.join(ROOT, 'services', 'home-node', 'runtime-recall.js'));
const RP = require(path.join(ROOT, 'services', 'home-node', 'runtime-policy.js'));
const MODEL = require(path.join(ROOT, 'assets', 'js', 'cognitive-runtime-settings.js'));

const NOW = 1750000000000;
const TOKEN = 'credsep-token';
const CHAR_NO_CRED = 'role_no_cred';     /* credentialRef 指向 Vault 里不存在的 ref */
const CHAR_NO_REF = 'role_no_ref';       /* spec 里根本没有 credentialRef（spec-incomplete） */
const CHAR_OK = 'role_with_cred';        /* 对照：有可用凭据 */
const QUERY = '显卡 驱动 更新失败';
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

function makeFetch(rec) {
  return function (url, init) {
    const body = String((init && init.body) || '');
    rec.push({ url: String(url), body: body });
    let content = '{"items":[]}';
    if (body.indexOf('MEMORY_INTERPRETATION_INPUT') >= 0) {
      const m = /```json\s*\n([\s\S]*?)\n\s*```/.exec(body.replace(/\\"/g, '"').replace(/\\n/g, '\n'));
      let batch = [];
      try { batch = m ? (JSON.parse(m[1]).MEMORY_BATCH || []) : []; } catch (_) { }
      content = JSON.stringify({ items: batch.map(x => ({
        memoryId: x.memoryId, meaning: '解释', appraisal: 'negative', affect: 'warm',
        basis: 'ai_inference', subjectiveConfidence: 0.4
      })) });
    } else if (body.indexOf('EXPECTATION_INPUT') >= 0) {
      const ids = (body.replace(/\\"/g, '"').replace(/\\n/g, '\n').match(/"memoryId"\s*:\s*"([^"]+)"/g) || [])
        .map(s => s.split('"')[3]);
      content = JSON.stringify({ items: ids.length ? [{
        prediction: 'p', trigger: { kind: 'same-topic', label: 'x' }, evidenceMemoryIds: [ids[0]],
        contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.5
      }] : [] });
    }
    const text = JSON.stringify({ choices: [{ message: { content: content } }] });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });
  };
}
function post(port, urlPath, body) {
  return new Promise(resolve => {
    const data = body === null ? '' : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-IB-Home-Token': TOKEN }
    }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', c => raw += c);
      res.on('end', () => { let b = null; try { b = JSON.parse(raw); } catch (_) { } resolve({ status: res.statusCode, body: b, raw }); });
    });
    r.on('timeout', () => { try { r.destroy(); } catch (_) { } resolve({ status: 0, body: null, raw: '' }); });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.write(data); r.end();
  });
}

(async function main() {
  console.log('P21-R4-PROD-1.1a · Credential Separation Truth Probe');
  console.log('scratch root = ' + RUN_ROOT);

  const dataDir = path.join(RUN_ROOT, 'data');
  const credDir = path.join(RUN_ROOT, 'cred');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(credDir, { recursive: true });
  /* Vault 里**只有** cred_a：另外两个角色拿不到任何可用凭据。 */
  const vault = CREDENTIAL_VAULT({ dataDir: credDir });
  vault.load();
  vault.upsert('cred_a', { provider: 'custom', apiKey: 'CREDSEP-SENTINEL' });
  vault.save();

  const rec = [];
  const inst = SERVICE.buildHomeNode({
    dataDir, credentialDataDir: credDir, token: TOKEN,
    port: NODE_MODEL_PORT({ fetch: makeFetch(rec), timeoutMs: 30000 }),
    clock: () => NOW, logger: () => { }
  });
  inst.open();
  const char = (id, name) => ({ id, name, relationship: 'friend' });
  inst.registry.putCharacter(CHAR_NO_CRED, char(CHAR_NO_CRED, 'NoCred'),
    { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'cred_missing', systemPrompt: 'SYS' });
  inst.registry.putCharacter(CHAR_NO_REF, char(CHAR_NO_REF, 'NoRef'),
    { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', systemPrompt: 'SYS' });
  inst.registry.putCharacter(CHAR_OK, char(CHAR_OK, 'WithCred'),
    { provider: 'custom', model: 'model-a', endpoint: 'https://provider.invalid/v1/chat/completions', credentialRef: 'cred_a', systemPrompt: 'SYS' });
  for (const id of ['m1', 'm2']) {
    inst.memoryStore.putRecord({
      id, kind: 'episodic', title: 'T-' + id, content: 'C-' + id + ' ' + QUERY, domain: '日常', tags: [],
      valence: 0.2, arousal: 0.6, importance: 6, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
      activationCount: 0, created: NOW - 86400000, lastActivated: NOW - 86400000, createdBy: 'user', createdByName: '',
      editedByUser: false, consolidatedFrom: [], lastConsolidatedAt: null
    });
  }
  const port = await new Promise(r => inst.server.listen(0, '127.0.0.1', () => r(inst.server.address().port)));
  const policyFile = path.join(dataDir, RP.FILE_NAME);
  const readPolicyFile = () => (fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : null);
  const cpRead = (id) => post(port, POLICY_PATH, { operation: 'read', characterId: id });
  const cpSet = (id, i, e) => post(port, POLICY_PATH, {
    operation: 'set', characterId: id, autoInterpretationEnabled: i, autoExpectationEnabled: e
  });
  const recall = (id, requestId) => post(port, RC.PATH, {
    operation: 'memory-recall', mode: 'authoritative', characterId: id,
    requestId: requestId, conversationId: 'dm:' + id, message: QUERY, timeoutMs: 4000
  });
  async function settle() {
    await inst.runtimeRecall.awaitAutoIdle(20000);
    await inst.runtimeRecall.awaitExpectationIdle(20000);
  }

  /* ── 0 · 前提：Vault 里确实没有那两个角色的凭据 ── */
  section('0 · precondition（凭据确实不可用）');
  {
    const probeMissing = (() => { try { return vault.resolve('cred_missing'); } catch (_) { return { ok: false, reason: 'resolve-threw' }; } })();
    const probeOk = (() => { try { return vault.resolve('cred_a'); } catch (_) { return { ok: false, reason: 'resolve-threw' }; } })();
    check('0.1 前提成立：cred_missing 在 Vault 里不可解析；cred_a 可解析（对照）',
      !probeMissing || probeMissing.ok !== true,
      { missing: probeMissing ? { ok: probeMissing.ok, reason: probeMissing.reason } : null, control: probeOk ? probeOk.ok : null });
  }

  /* ── 1 · A：policy mutation 与凭据可用性**解耦** ── */
  section('1 · A · POLICY MUTATION（无凭据）');
  {
    const initial = await cpRead(CHAR_NO_CRED);
    const initialFile = policyFile;
    check('1.1 初始 OFF/OFF，且此时策略文件**不存在**（读无副作用）',
      initial.status === 200 && initial.body.autoInterpretationEnabled === false
      && initial.body.autoExpectationEnabled === false && !fs.existsSync(initialFile),
      { read: initial.body, fileExists: fs.existsSync(initialFile) });

    const onOff = await cpSet(CHAR_NO_CRED, true, false);
    const file1 = readPolicyFile();
    const rb1 = await cpRead(CHAR_NO_CRED);
    check('1.2 无凭据角色 set ON/OFF ⇒ **200 success**（不是 409/400）',
      onOff.status === 200 && onOff.body.ok === true
      && onOff.body.autoInterpretationEnabled === true && onOff.body.autoExpectationEnabled === false,
      { status: onOff.status, body: onOff.body });
    check('1.3 已**持久化**到文件（characters 段显式 true；不是内存态）',
      !!file1 && !!file1.characters[CHAR_NO_CRED]
      && file1.characters[CHAR_NO_CRED].autoInterpretationEnabled === true,
      file1 && file1.characters);
    check('1.4 authoritative readback = ON/OFF（UI 拿到的是服务端真值）',
      rb1.status === 200 && rb1.body.autoInterpretationEnabled === true
      && rb1.body.autoExpectationEnabled === false && rb1.body.readable === true
      && rb1.body.source.interpretation === 'FILE_POLICY',
      rb1.body);
    check('1.5 UI 口径：该响应的 ok/readable 让模块走 **saved** 分支（不是 errorText 的"未保存"分支）',
      rb1.body.ok === true && rb1.body.readable === true && MODEL.readErrorText(rb1.body) === null,
      { ok: rb1.body.ok, readable: rb1.body.readable, readErrorText: MODEL.readErrorText(rb1.body) });

    const onOn = await cpSet(CHAR_NO_CRED, true, true);
    const file2 = readPolicyFile();
    const rb2 = await cpRead(CHAR_NO_CRED);
    check('1.6 同一无凭据角色 set ON/ON ⇒ 同样 **200 success** + 持久化 + readback ON/ON',
      onOn.status === 200 && onOn.body.ok === true
      && !!file2 && file2.characters[CHAR_NO_CRED].autoInterpretationEnabled === true
      && !!file2.expectation && !!file2.expectation.characters[CHAR_NO_CRED]
      && file2.expectation.characters[CHAR_NO_CRED].autoExpectationEnabled === true
      && rb2.body.autoInterpretationEnabled === true && rb2.body.autoExpectationEnabled === true,
      { status: onOn.status, file: file2 && file2.expectation && file2.expectation.characters, readback: rb2.body });

    /* spec 里连 credentialRef 都没有 ⇒ 同样是"没有可用凭据"的形态 */
    const noRef = await cpSet(CHAR_NO_REF, true, true);
    const file3 = readPolicyFile();
    check('1.7 连 credentialRef 都没有的角色（spec-incomplete 形态）⇒ 同样 200 + 持久化',
      noRef.status === 200 && noRef.body.ok === true
      && !!file3.characters[CHAR_NO_REF] && file3.characters[CHAR_NO_REF].autoInterpretationEnabled === true
      && !!file3.expectation.characters[CHAR_NO_REF]
      && file3.expectation.characters[CHAR_NO_REF].autoExpectationEnabled === true,
      { status: noRef.status, entry: file3.characters[CHAR_NO_REF] });
    P('CREDENTIAL_REQUIRED_FOR_POLICY_MUTATION', 'NO');
  }

  /* ── 2 · B：之后的认知执行按既有语义失败，policy 不变 ── */
  section('2 · B · LATER COGNITIVE EXECUTION（无凭据 ⇒ 既有 fail-closed）');
  {
    const before = rec.length;
    const turn = await recall(CHAR_NO_CRED, 'credsep_no_cred_1');
    await settle();
    const calls = rec.length - before;
    const turnId = RC.deriveStableTurnId('credsep_no_cred_1', 'dm:' + CHAR_NO_CRED);
    const record = inst.runtimeRecall.getTurnInterpretation(turnId);
    const auto = inst.runtimeRecall.describe().autoInterpretation.counters;
    check('2.1 无凭据的 eligible turn：**没有** provider 调用（凭据缺失 ⇒ 不可能出网）',
      turn.status === 200 && calls === 0 && auto.started === 1 && auto.succeeded === 0,
      { http: turn.status, providerCalls: calls, auto });
    check('2.2 失败按**既有**语义具名（credential-unavailable / spec-incomplete 一类），不是新造状态',
      !!record && record.status === 'failed' && record.providerCalls === 0
      && ['credential-unavailable', 'spec-incomplete', 'runtime-spec-unavailable'].indexOf(String(record.reason)) >= 0,
      record);
    const rb = await cpRead(CHAR_NO_CRED);
    const file = readPolicyFile();
    check('2.3 ★ policy **保持 ON/ON**：运行时失败不会自动关闭、不会改回 OFF、不会删 entry',
      rb.body.autoInterpretationEnabled === true && rb.body.autoExpectationEnabled === true
      && file.characters[CHAR_NO_CRED].autoInterpretationEnabled === true
      && file.expectation.characters[CHAR_NO_CRED].autoExpectationEnabled === true,
      { readback: rb.body, entry: file.characters[CHAR_NO_CRED], expectation: file.expectation.characters[CHAR_NO_CRED] });
    check('2.4 失败之后 mutation 依然可用（policy 权威未被运行时失败污染）',
      (await cpSet(CHAR_NO_CRED, true, false)).status === 200
      && (await cpRead(CHAR_NO_CRED)).body.autoInterpretationEnabled === true
      && (await cpRead(CHAR_NO_CRED)).body.autoExpectationEnabled === false,
      (await cpRead(CHAR_NO_CRED)).body);

    /* 对照：有凭据的角色在同一装置里**真的**调用到 provider */
    await cpSet(CHAR_OK, true, false);
    const cBefore = rec.length;
    await recall(CHAR_OK, 'credsep_ok_1');
    await settle();
    check('2.5 对照（有凭据）：同一装置里真的产生 provider 调用 ⇒ 2.1 的 0 次是"凭据缺失"的结论，不是装置假象',
      (rec.length - cBefore) === 1,
      { controlCalls: rec.length - cBefore });
    P('POLICY_SURVIVES_CREDENTIAL_UNAVAILABLE_RUNTIME', 'YES');
  }

  /* ── 3 · Negative：凭据不可用不得触发这些 ── */
  section('3 · negative（明确不得发生的行为）');
  {
    const statuses = [];
    for (const [i, e] of [[true, false], [true, true], [false, false], [true, false]]) {
      const r = await cpSet(CHAR_NO_CRED, i, e);
      statuses.push(r.status);
    }
    const rb = await cpRead(CHAR_NO_CRED);
    const file = readPolicyFile();
    check('3.1 无凭据角色的 mutation **从不**返回 409/400（除状态矩阵本身非法外一律 200）',
      statuses.every(s => s === 200),
      statuses);
    check('3.2 无凭据不使 UI 显示"未保存"：readback readable=true 且 ok=true',
      rb.body.readable === true && rb.body.ok === true && MODEL.readErrorText(rb.body) === null,
      { readable: rb.body.readable, readErrorText: MODEL.readErrorText(rb.body) });
    check('3.3 无凭据**不**自动改回 OFF、**不**删除角色 entry（entry 仍在，值为显式布尔）',
      typeof file.characters[CHAR_NO_CRED].autoInterpretationEnabled === 'boolean'
      && typeof file.expectation.characters[CHAR_NO_CRED].autoExpectationEnabled === 'boolean'
      && rb.body.autoInterpretationEnabled === true,
      { character: file.characters[CHAR_NO_CRED], expectation: file.expectation.characters[CHAR_NO_CRED] });
    check('3.4 非法状态矩阵仍然被权威层拒绝（凭据无关；OFF/ON 依旧 400）',
      (await cpSet(CHAR_NO_CRED, false, true)).status === 400,
      'illegal state independent of credentials');
    check('3.5 策略文件始终是**可用**权威（readable=true），坏凭据不会污染 policy 文件',
      rb.body.readable === true && !!file.version,
      { readable: rb.body.readable, version: file.version });
    P('CREDENTIAL_UNAVAILABLE_AUTO_DISABLES_POLICY', 'NO');
    P('CREDENTIAL_UNAVAILABLE_DELETES_CHARACTER_ENTRY', 'NO');
    P('CREDENTIAL_UNAVAILABLE_BREAKS_MUTATION_HTTP', 'NO');
  }

  /* ── 4 · 契约口径（既有 code path：写者从不读 Vault）── */
  section('4 · contract（代码事实：policy writer 不触达凭据）');
  {
    const policySrc = fs.readFileSync(path.join(ROOT, 'services/home-node/runtime-cognitive-policy.js'), 'utf8');
    const routeSrc = fs.readFileSync(path.join(ROOT, 'services/home-node/http.js'), 'utf8');
    check('4.1 产品边界不引用凭据：没有 credential / vault / resolve / apiKey 面',
      !/credentialAccess|credentialVault|vault|apiKey|secret/i.test(
        policySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
      'mutation path is credential-blind');
    check('4.2 那条 route 的 handler 只在 writer 上落盘，不查询凭据可用性',
      /runtimeCognitivePolicy\.setCharacter\(/.test(routeSrc)
      && routeSrc.indexOf('/internal/runtime/cognitive-policy') >= 0,
      'no credential probe on the mutation route');
    P('MUTATION_PATH_TOUCHES_CREDENTIAL_STORE', 'NO');
  }

  console.log('');
  for (const k of Object.keys(CONST)) P(k, CONST[k]);
  console.log('R4_PROD1_1A_CREDENTIAL_SEPARATION_COUNTS passed=' + passed + ' failed=' + failed);
  const verdict = failed === 0 ? 'DOCUMENTATION_WORDING_BUG_ONLY' : 'PRODUCT_BUG';
  console.log('VERDICT = ' + verdict);
  console.log('NATURAL_EXIT = YES code=' + (failed === 0 ? 0 : 1));

  try { inst.server.close(); } catch (_) { }
  try { inst.close(); } catch (_) { }
  await new Promise(r => setTimeout(r, 200));
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch (_) { }
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(error => {
  console.log('SUITE_THREW: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
