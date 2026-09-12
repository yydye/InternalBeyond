/* ====================================================================
   M1-C.2i · Home Node **生产装配** 上的 Middle Brain 执行收敛
   --------------------------------------------------------------------
   为什么需要这一条（而不是并进 test_middle_brain_convergence.js）：
   那条测试自己 createExecutor(...)，因此它证明的是"执行器接上执行缝之后行为正确"，
   **不**证明生产装配真的把执行缝接上了。本仓库已经因为这类缺口吃过一次亏
   （canonical memory 只在 buildHomeNode 里接好，进程级启动路径漏了，
   23118 上 /memory/* 全 501 而测试全绿 —— 见 home-node-service.js 的注释）。

   所以这里走**生产装配函数** buildHomeNode()，并让 provider 是一个真实的
   loopback HTTP 服务：请求从 executeCharacterTurn 出发，经 NodeModelPort 与
   IBModelCore.buildRequestBody（唯一翻译器）真正发到网上（本地回环），
   把服务端收到的请求体抓下来断言。

   证明的事：
     ① buildHomeNode 装配出的 executor 确实带 canonical 执行缝；
     ② 已发布的执行策略（经 registry，与 /characters/publish 同一条路）被读到；
     ③ 回合真的进入了执行缝：上下文被压缩块替换、contextPolicy 如实改写；
     ④ 思考深度经唯一翻译器到达 provider wire；
     ⑤ 未发布策略时行为与 M1-C.2i 之前一致（不假装参与）。

   纪律：只连 127.0.0.1 上自己起的服务；数据目录在系统临时目录；结束时清理。
   ==================================================================== */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets', 'js', 'middle-brain-config-core.js'));
const IBMC = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js'));
const buildHomeNode = require(path.join(ROOT, 'services', 'home-node-service.js')).buildHomeNode;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

/* SSE 回环 provider：记录收到的请求体，按 openai 流式形状回一段内容。
   用真实 HTTP 而不是打桩 port，是为了让 buildRequestBody / createStreamParser
   这一整条生产链路都真的跑起来。 */
function startLoopbackProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (_) { body = raw; }
      seen.push({ url: req.url, body: body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '模型原始回复' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server: server, seen: seen, port: server.address().port }));
  });
}

async function main() {
  const provider = await startLoopbackProvider();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-assembly-'));
  tempDirs.push(dir);

  const runtime = buildHomeNode({ dataDir: dir, host: '127.0.0.1', port: 0, token: '' });
  runtime.open();

  const characterId = 'friend_assembly';
  const endpoint = 'http://127.0.0.1:' + provider.port + '/v1/chat/completions';

  /* ── ① 装配层结构：executor 确实带 canonical 执行缝 ────────────────── */
  check('assembly.executorPresent', !!runtime.executor && typeof runtime.executor.executeCharacterTurn === 'function');
  check('assembly.registrySupportsExecutionConfig',
    typeof runtime.registry.putMiddleBrainExecutionConfig === 'function'
    && typeof runtime.registry.getMiddleBrainExecutionConfig === 'function');
  check('assembly.noPolicyConfigBeforePublish',
    runtime.registry.getMiddleBrainExecutionConfig() === null,
    runtime.registry.getMiddleBrainExecutionConfig());

  /* 角色目录：与桌面发布同一形状（生产网关会用同一份 DTO 再收口一次）。 */
  const written = runtime.registry.putCharacters([{
    id: characterId,
    dto: { id: characterId, name: '小满', relationship: '朋友' },
    spec: {
      provider: 'openai', model: 'gpt-5.6-luna', endpoint: endpoint, apiKey: 'sk-loopback',
      systemPrompt: '你是小满。', temperature: null
    }
  }]);
  check('assembly.characterPublished', written.ok === true && written.withSpec === 1, written);

  function turnRequest(requestId) {
    return {
      requestId: requestId,
      conversationId: 'dm:' + characterId,
      friendId: characterId,
      character: { id: characterId, spec: runtime.registry.getCharacterSpec(characterId) },
      userMessage: { id: 'msg_u_' + requestId, role: 'user', content: '在吗', friendId: characterId, timestamp: Date.now() },
      history: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: 'FIRST' }],
      runtimeContextParts: {
        runtimeContext: '【身份】你是雁凡。\n\n【长期记忆】\n她喜欢雨。\n\n当前时间：2026年1月1日',
        memoryBlock: '【长期记忆】\n她喜欢雨。',
        memoryConsulted: true,
        p0Stable: '【身份】你是雁凡。',
        p0Time: '当前时间：2026年1月1日'
      },
      contextPolicy: 'mobile-gateway-history'
    };
  }
  function systemTextOf(body) {
    if (!body || !Array.isArray(body.messages)) return '';
    return body.messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n\n');
  }

  /* ── ② 未发布策略：行为必须与 M1-C.2i 之前一致（不假装参与）────────── */
  {
    provider.seen.length = 0;
    const result = await runtime.executor.executeCharacterTurn(turnRequest('req_before'), { turnId: 't_before' });
    check('before.turnSucceeded', result.ok === true, result);
    check('before.providerReached', provider.seen.length === 1, provider.seen.length);
    const body = provider.seen[0].body;
    check('before.contextPolicyUntouched', result.contextPolicy === 'mobile-gateway-history', result.contextPolicy);
    check('before.originalMemoryInSystem', systemTextOf(body).includes('【长期记忆】'), systemTextOf(body));
    check('before.noReasoningField', body.reasoning_effort === undefined,
      '未发布策略时不应写 reasoning 字段: ' + JSON.stringify(body));
  }

  /* ── ③ 发布执行策略（与桌面同一条路：registry 写入投影）──────────── */
  const projected = CORE.projectExecutionConfig({
    enabled: true, endpoint: endpoint, model: 'gpt-6-astra', apiKey: 'sk-DESKTOP-MB-SECRET',
    reasoningEffort: 'high', reasoningEffortV2: true, admissionEnabled: true,
    characterIntegrityEnabled: false, imageMode: 'precision'
  });
  check('publish.projectionHasNoSecret', !JSON.stringify(projected).includes('sk-') && !('apiKey' in projected),
    projected);
  const publishResult = runtime.registry.putMiddleBrainExecutionConfig(projected);
  check('publish.stored', publishResult.ok === true, publishResult);
  check('publish.readBackHasNoSecret',
    !JSON.stringify(runtime.registry.getMiddleBrainExecutionConfig()).includes('sk-'),
    runtime.registry.getMiddleBrainExecutionConfig());

  /* ── ④ 装配路径上真的进入执行缝 ──────────────────────────────────── */
  {
    provider.seen.length = 0;
    const result = await runtime.executor.executeCharacterTurn(turnRequest('req_after'), { turnId: 't_after' });
    check('after.turnSucceeded', result.ok === true, result);
    check('after.providerReached', provider.seen.length === 1, provider.seen.length);
    const body = provider.seen[0].body;
    const system = systemTextOf(body);
    check('after.middleBrainParticipated', /^middle-brain:local\//.test(String(result.contextPolicy)),
      '执行缝没有参与（生产装配可能漏接）: ' + result.contextPolicy);
    check('after.injected', /\/injected$/.test(String(result.contextPolicy)), result.contextPolicy);
    check('after.compressedBlockInSystem', system.includes('【记忆】'), system);
    check('after.memoryReplacedOnce', system.split('她喜欢雨').length - 1 === 1, system);
    check('after.p0Preserved', system.includes('【身份】你是雁凡。') && system.includes('当前时间：2026年1月1日'), system);
    check('after.policyPersisted', result.message && result.message.metadata
      && result.message.metadata.contextPolicy === result.contextPolicy,
      result.message && result.message.metadata);
    check('after.storedAssistantHasReplacedContext', (() => {
      const stored = runtime.store.getMessage(result.assistantMessageId);
      return stored && stored.metadata && stored.metadata.contextPolicy === result.contextPolicy;
    })());
  }

  /* ── ⑤ 思考深度经唯一翻译器到达 provider wire ─────────────────────── */
  {
    provider.seen.length = 0;
    await runtime.executor.executeCharacterTurn(turnRequest('req_wire'), { turnId: 't_wire' });
    const body = provider.seen[0].body;
    check('wire.reasoningEffortFromCanonicalConfig', body.reasoning_effort === 'high',
      'canonical 档位没有到达 provider wire: ' + JSON.stringify({ reasoning_effort: body.reasoning_effort }));
    /* 同一份语义档位在浏览器侧走的是同一个函数（IBModelCore.buildRequestBody）；
       这里顺带证明"未取证能力 abstain"这条也成立，避免把粗翻译当成翻译。 */
    const abstain = IBMC.buildRequestBody(
      { provider: 'openai', model: 'not-a-verified-model' },
      { system: 'x', messages: [] }, { maxTokens: 10, reasoningEffort: 'high' });
    check('wire.unverifiedModelAbstains', abstain.reasoning_effort === undefined, abstain);
  }

  /* ── ⑥ 每轮只进一次执行缝 ────────────────────────────────────────── */
  {
    provider.seen.length = 0;
    await runtime.executor.executeCharacterTurn(turnRequest('req_once'), { turnId: 't_once' });
    check('once.singleProviderCall', provider.seen.length === 1, provider.seen.length);
    const turn = runtime.executor.activeTurn('dm:' + characterId);
    check('once.noTurnLeftInFlight', turn === null, turn);
  }

  runtime.close();
  await new Promise(resolve => provider.server.close(resolve));

  console.log('\nM1-C.2i production assembly: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FATAL', error && error.stack || error);
  process.exitCode = 1;
});
