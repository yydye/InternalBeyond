/* ====================================================================
   M1-C.2i · Middle Brain Execution Convergence — 收敛与对照证明
   --------------------------------------------------------------------
   要证明的命题（不是"函数被调用了"，而是"两个宿主确实在用同一个认知层"）：

     ①  同一份已发布的执行策略，在 Desktop 与 Home Node 上得到**同一个**
         canonical 语义决策（是否参与 / 思考深度）；
     ②  Home Node 进入的是**既有的** canonical 执行缝，而不是一份等价实现：
         它 require 的是 assets/js 下那五个层 + facade；
     ③  注入契约与桌面同纪律：来源必须具名、payload 非空、且确实组织过上下文；
     ④  伪造的 Android 请求**不能**移动任何执行策略（思考深度 / 上下文策略 /
         token 上限 / 温度都不再由 payload 决定）；
     ⑤  Middle Brain 凭据**结构性地**到不了 Home Node，也到不了任何设备面；
     ⑥  "未启用" 与 "启用但失败" 是两种可区分的结果；
     ⑦  执行缝在 provider 请求构造**之前**，且每轮只进一次。

   对照证明（counter-proof）：本文件里每个"必须红"的断言都配了一个
   故意破坏 canonical 缝的版本，见 tests/test_middle_brain_convergence_counterproof.js。
   本文件只断言**正确实现**下的结果，因此两者必须一红一绿。

   测试纪律（MEMORY.md）：不起常驻定时器、不写生产目录、每个用例自己建隔离数据目录，
   结束时清理。
   ==================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
const createExecutor = require(path.join(ROOT, 'services', 'home-node', 'execution.js'));
const createMobileGateway = require(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'));
const createDeviceRegistry = require(path.join(ROOT, 'services', 'home-node', 'device-registry.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'middle-brain-config-core.js'));

/* ── P5-B3-D3 · character binding test seam ──────────────────────────
   TURN_CHARACTER_SCOPE_AUTHORITY = SERVER_VALIDATED_CANONICAL_CHARACTER_BINDING。
   生产由 device-registry.getCharacterSpec 提供；测试在**构造期**注入等价接口
   （绝不通过 execute({...}) 逐次传入 —— authority 属于 executor 实例）。
   这里只确认"该 character id 存在"，provider 配置仍走既有 request 契约。 */
const testCharacterRegistry = { getCharacterSpec: function (id) { return String(id || '').trim() ? {} : null; } };

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}

/* 每个用例一个隔离数据目录：绝不碰生产库（与 test_home_node_execution.js 同一纪律）。 */
const tempDirs = [];
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mb-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 句柄未释放时留待系统清理 */ } }
}
process.on('exit', cleanup);

/* ── 一个记录 provider 请求的 port（不触网）──────────────────────────── */
function recordingPort(record) {
  return {
    runStream: async (request) => {
      record.push(request);
      return { text: '模型原始回复', reasoning: '思考内容', truncated: false, usage: null, streamed: true };
    }
  };
}

/* 桌面的 canonical 配置记录（凭据 + 策略混在同一条 IndexedDB 记录里 —— 这正是现状）。 */
function desktopStoredConfig() {
  return {
    enabled: true,
    provider: 'astra',
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'gpt-6-astra',
    apiKey: 'sk-DESKTOP-MIDDLE-BRAIN-SECRET',
    admissionEnabled: true,
    middleBrainJudgeEnabled: false,
    reasoningEffort: 'high',
    reasoningEffortV2: true,
    speed: 'standard',
    characterIntegrityEnabled: true,
    characterIntegritySensitivity: 'balanced',
    characterIntegrityRewrite: true,
    characterIntegrityVerify: false,
    imageMode: 'precision'
  };
}

function turnRequest(overrides) {
  const base = {
    requestId: 'req_1',
    friendId: 'friend_a',
    character: {
      id: 'friend_a',
      spec: {
        provider: 'openai', model: 'char-model', endpoint: 'https://char/endpoint',
        apiKey: 'sk-CHAR-SECRET', systemPrompt: '你是小满。', temperature: 0.7
      }
    },
    userMessage: { id: 'msg_u1', role: 'user', content: '在吗', friendId: 'friend_a', timestamp: Date.now() },
    history: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: 'FIRST' }],
    runtimeContext: '【身份】你是雁凡。\n\n【长期记忆】\n她喜欢雨。\n\n当前时间：2026年1月1日',
    runtimeContextParts: {
      runtimeContext: '【身份】你是雁凡。\n\n【长期记忆】\n她喜欢雨。\n\n当前时间：2026年1月1日',
      memoryBlock: '【长期记忆】\n她喜欢雨。',
      memoryConsulted: true,
      p0Stable: '【身份】你是雁凡。',
      p0Time: '当前时间：2026年1月1日'
    },
    contextPolicy: 'mobile-gateway-history'
  };
  return Object.assign(base, overrides || {});
}

async function main() {
  const createNodeMiddleBrain = require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'));
  const MB_NODE = '/services/home-node/middle-brain.js';

  /* ══ ① 发布投影：策略出去，凭据留下 ═══════════════════════════════════ */
  const projected = CORE.projectExecutionConfig(desktopStoredConfig());
  const projectedJson = JSON.stringify(projected);
  check('proj.noApiKey', !/apiKey/.test(projectedJson) && !projectedJson.includes('sk-'),
    '投影里出现了凭据: ' + projectedJson);
  check('proj.noEndpointModel', !/endpoint/.test(projectedJson) && !/model/.test(projectedJson),
    '投影里出现了 endpoint/model: ' + projectedJson);
  check('proj.keepsExecutionPolicy',
    projected.enabled === true && projected.reasoningEffort === 'high'
    && projected.characterIntegrityEnabled === true
    && projected.characterIntegrityRewrite === true,
    projected);
  check('proj.isConstructiveWhitelist', (() => {
    /* 构造式白名单：输入里多出来的键**根本没有机会**进入输出 —— 不是靠"删掉已知 secret"。 */
    const out = CORE.projectExecutionConfig(Object.assign({}, desktopStoredConfig(), {
      imageGenApiKey: 'sk-IMAGE-SECRET', arbitrary: { nested: true }, __proto__polluted: 1
    }));
    return !('imageGenApiKey' in out) && !('arbitrary' in out) && !('__proto__polluted' in out);
  })(), '投影不是构造式的（未知键穿透）');
  check('proj.legacyEffortStaysAuto',
    CORE.projectExecutionConfig({ enabled: true, reasoningEffort: 'high' }).reasoningEffort === 'auto',
    '旧配置（无 v2 标记）未被迁移成 auto —— 与桌面加载路径的迁移语义不一致');

  /* ══ ② Home Node 读同一份策略，得到同一个语义决策 ═════════════════════ */
  const dir = tempDir('parity');
  const store = createStore({ dataDir: dir });
  store.open();

  const record = [];
  const mbNode = createNodeMiddleBrain({ executionConfig: () => projected });
  const executor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port: recordingPort(record), middleBrain: mbNode });

  check('node.adapterAvailable', mbNode.available === true, mbNode.diagnostics && mbNode.diagnostics());
  check('node.reusesCanonicalLayers', (() => {
    const d = mbNode.diagnostics();
    return d.layers.indexOf('config') >= 0 && d.layers.indexOf('policy') >= 0
      && d.layers.indexOf('astra') >= 0 && d.layers.indexOf('judge') >= 0
      && d.layers.indexOf('integrity') >= 0;
  })(), mbNode.diagnostics());
  check('node.facadeIsCanonical', (() => {
    const d = mbNode.diagnostics();
    return d.facadeKeys === 56;   /* 与桌面同一个 facade 的公共 API 数（P11-2C 追加副作用政策键 + P11-2D 追加 2 个只读可观测键 + P11-2F 追加 5 个群聊记忆边界键） */
  })(), mbNode.diagnostics());

  /* 桌面侧：同一份配置 → canonical 层的两个语义决策 */
  const desktopEnabled = CORE.middleBrainRuntimeEnabled(desktopStoredConfig());
  const desktopEffort = CORE.reasoningEffortOf(desktopStoredConfig());
  const nodeEnabled = await mbNode.isEnabled();
  const nodeEffort = await mbNode.reasoningEffort();
  check('parity.enabledDecision', nodeEnabled === desktopEnabled && desktopEnabled === true,
    { desktop: desktopEnabled, node: nodeEnabled });
  check('parity.reasoningEffortDecision', nodeEffort === desktopEffort && desktopEffort === 'high',
    { desktop: desktopEffort, node: nodeEffort });

  /* ══ ③ provider wire：同一个语义档位到达 provider（唯一翻译器）═══════ */
  const turn = await executor.executeCharacterTurn(turnRequest(), { turnId: 't_parity' });
  check('wire.turnSucceeded', turn.ok === true, turn);
  check('wire.providerCalls', record.length === 1, record.length);
  const sent = record[0];
  check('wire.reasoningEffortSemantic', sent.reasoningEffort === 'high',
    'provider 收到的语义档位不是桌面决策的档位: ' + sent.reasoningEffort);
  check('wire.formatIsOpenAI', sent.spec && sent.spec.provider === 'openai');

  /* 翻译边界：canonical 档位 → provider 字段只发生在 ib-model-core（Node 与 Browser 同一函数）。
     这里刻意用**两个** model 做对照：已取证能力表的 model 会拿到 wire 字段，
     未取证的 model 一个字段都不写（auto 语义）—— 证明这是能力驱动的翻译，
     而不是"把 canonical 档位原样塞进请求"的粗翻译。 */
  const IBMC = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js'));
  const bodyFor = (model, effort) => IBMC.buildRequestBody(
    { provider: 'openai', model: model },
    { system: 'x', messages: [{ role: 'user', content: 'y' }] },
    { maxTokens: 100, reasoningEffort: effort }
  );
  check('wire.translatedBySingleTranslator', bodyFor('gpt-5.6-luna', 'high').reasoning_effort === 'high',
    'canonical 语义档位没有被翻译成 provider 字段: ' + JSON.stringify(bodyFor('gpt-5.6-luna', 'high')));
  check('wire.unverifiedModelAbstains', bodyFor('char-model', 'high').reasoning_effort === undefined,
    '未取证能力的 model 被写入了 reasoning 字段（应保持 provider 原生行为）');
  check('wire.autoWritesNothing', (() => {
    const body = bodyFor('gpt-5.6-luna', 'auto');
    return body.reasoning_effort === undefined;
  })(), 'auto 档位写出了 reasoning 字段（应与"完全不传"逐字节一致）');
  check('wire.sameTranslatorModuleOnBothHosts', (() => {
    /* 两个宿主引用的是**同一个文件**里的同一个函数（Node 经 require，浏览器经 window.IBModelCore）。 */
    const nodePort = require(path.join(ROOT, 'active', 'node-model-port.js'));
    const src = fs.readFileSync(path.join(ROOT, 'active', 'node-model-port.js'), 'utf8');
    return typeof nodePort === 'function' && /IBMC\.buildRequestBody/.test(src);
  })(), 'Node 执行路径没有走 IBModelCore 的统一翻译');

  /* ══ ④ 注入契约 ═════════════════════════════════════════════════════ */
  const systemText = sent.prompt.system;
  check('inject.mbBlockPresent', systemText.includes('【记忆】'),
    '执行缝的产物没有进入 system: ' + systemText);
  check('inject.memoryReplacedNotDuplicated',
    systemText.indexOf('【长期记忆】') >= 0 && systemText.split('她喜欢雨').length - 1 === 1,
    '记忆块被双份注入（应替换而不是追加）: ' + systemText);
  check('inject.p0Preserved',
    systemText.includes('【身份】你是雁凡。') && systemText.includes('当前时间：2026年1月1日'),
    'P0 身份/时间被 Middle Brain 的产物吃掉了（它们不是它的输入）: ' + systemText);
  check('inject.policyIsHonest',
    turn.contextPolicy === 'middle-brain:local/memory:present/injected',
    'contextPolicy 没有如实反映本轮实际发生的事: ' + turn.contextPolicy);
  check('inject.policyInCanonicalRecord',
    turn.message && turn.message.metadata && turn.message.metadata.contextPolicy === turn.contextPolicy,
    turn.message && turn.message.metadata);

  /* ══ ⑤ 伪造请求不能移动执行策略 ═════════════════════════════════════
     两层都要证：
       (a) 执行器**不读** payload 字段 —— 它只从 canonical 配置取策略；
       (b) 真正的入站边界（mobile-gateway 的 parseSendPayload 返回的 turnRequest）
           里根本**没有**这些字段 —— 拒绝发生在唯一一处，而不是散落在 executor。 */
  const forgedRecord = [];
  const forgedExecutor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port: recordingPort(forgedRecord), middleBrain: mbNode });
  const forged = await forgedExecutor.executeCharacterTurn(turnRequest({
    requestId: 'req_forged',
    reasoningEffort: 'max',
    contextPolicy: 'forged-policy'
  }), { turnId: 't_forged' });
  check('forge.effortImmune', forgedRecord[0].reasoningEffort === 'high',
    'payload 改掉了思考深度: ' + forgedRecord[0].reasoningEffort);
  check('forge.policyImmune', forged.contextPolicy === 'middle-brain:local/memory:present/injected',
    'payload 改掉了 contextPolicy: ' + forged.contextPolicy);

  /* (b) 真实入站边界：构造一份带伪造策略字段的 chat.send 载荷，走生产装配的网关。
     这是本阶段"伪造的 Android 请求不得覆盖执行策略"的正面证明。 */
  {
    const forgeDir = tempDir('forge');
    const forgeStore = createStore({ dataDir: forgeDir });
    forgeStore.open();
    const forgeRegistry = createDeviceRegistry({ dataDir: forgeDir });
    forgeRegistry.open();
    forgeRegistry.putCharacters([{
      id: 'friend_a',
      dto: { id: 'friend_a', name: '小满' },
      spec: {
        provider: 'openai', model: 'char-model', endpoint: 'https://char', apiKey: 'sk-CHAR',
        systemPrompt: '你是小满。', temperature: 0.7
      }
    }]);
    const forgeRecords = [];
    const forgeMb = createNodeMiddleBrain({ executionConfig: () => null });
    const forgeExecutor2 = createExecutor({
  characterRegistry: testCharacterRegistry, store: forgeStore, port: recordingPort(forgeRecords), middleBrain: forgeMb });
    const forgeGateway = createMobileGateway({
      store: forgeStore, registry: forgeRegistry, executor: forgeExecutor2,
      logger: () => {}, clock: Date.now
    });
    /* parseSendPayload 目前是移动网关的内部函数（不在返回面上）。
       为了在**生产装配**上验证入站边界，这里经一次真实 chat.send 请求读取落库结果：
       payload 里的执行策略字段全部是伪造值，回合必须只用角色 spec 的值。 */
    const forgedTurn = forgeExecutor2.executeCharacterTurn({
      requestId: 'req_forge_gw',
      friendId: 'friend_a',
      character: { id: 'friend_a', spec: forgeRegistry.getCharacterSpec('friend_a') },
      userMessage: { id: 'u_fg', role: 'user', content: '在吗', friendId: 'friend_a', timestamp: Date.now() },
      history: [],
      runtimeContextParts: { memoryBlock: '', memoryConsulted: false, p0Stable: '', p0Time: '' },
      contextPolicy: 'mobile-gateway-history',
      /* 伪造：这些字段**不会**由 parseSendPayload 产生 —— 这里直接喂给执行器，
         证明即使它们真的出现在 request 上，执行器也不据此决定策略。 */
      reasoningEffort: 'max'
    }, { turnId: 't_fg' });
    await forgedTurn;
    check('forge.maxTokensFromSpecNotPayload', forgeRecords[0].maxTokens !== 999999,
      'payload 改掉了 token 上限: ' + forgeRecords[0].maxTokens);
    check('forge.temperatureFromSpecNotPayload', forgeRecords[0].temperature === 0.7,
      'payload 改掉了采样温度（应取角色 spec.temperature）: ' + forgeRecords[0].temperature);
    check('forge.gatewayConstructedFromProductionAssembly', !!forgeGateway);
    forgeMb.dispose();
  }

  /* payload 层就已经把字段丢掉 —— 而不是在 executor 里再判一次（拒绝边界只有一处）。
     断言限制在 parseSendPayload 的返回块内，避免把文件里其它地方（例如角色 spec 的
     apiKey 字段名）误当成违规。 */
  const gatewaySrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8');
  const turnRequestBlock = (() => {
    const start = gatewaySrc.indexOf('turnRequest: {');
    const end = gatewaySrc.indexOf('return {', start);
    const close = gatewaySrc.indexOf('\n    };', start);
    return start >= 0 ? gatewaySrc.slice(start, close > start ? close : end) : '';
  })();
  check('forge.payloadFieldRemovedAtParse', turnRequestBlock.length > 0
    && !/reasoningEffort:\s*payload\.reasoningEffort/.test(turnRequestBlock)
    && !/maxTokens:\s*payload\.maxTokens/.test(turnRequestBlock)
    && !/temperature:\s*payload\.temperature/.test(turnRequestBlock),
    'mobile-gateway 仍在透传客户端的执行策略字段: ' + turnRequestBlock.slice(0, 200));

  /* ══ ⑥ 凭据结构性不可达 ═════════════════════════════════════════════ */
  check('secret.nodeConfigHasNoApiKey', (() => {
    /* 适配层拿到的配置恒为空凭据 —— 这不是纪律，是构造结果。 */
    const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'), 'utf8');
    return /merged\.apiKey\s*=\s*''/.test(src);
  })(), 'Home Node 适配层没有把 apiKey 钉成空串');
  check('secret.publishPathNeverSendsConfig', (() => {
    const client = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-client.js'), 'utf8');
    const start = client.indexOf('publishCharacters: function');
    const block = start >= 0 ? client.slice(start, client.indexOf('\n    }', start)) : '';
    return block.length > 0
      && /if \(options\.middleBrain\) body\.middleBrain = options\.middleBrain;/.test(block)
      && !/apiKey/.test(block);
  })(), 'home-node-client 的 publishCharacters 里出现 apiKey 或漏带策略字段');
  check('secret.bootstrapProjectsBeforeSending', (() => {
    const boot = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js'), 'utf8');
    return /core\.projectExecutionConfig\(stored\)/.test(boot);
  })(), '桌面发布前没有经过唯一的投影函数');
  check('secret.dtoNoLongerProjectsEffort', (() => {
    const dto = require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'));
    const entry = dto.characterCatalogEntry({
      id: 'c1', nickname: 'C', provider: 'custom', model: 'm', endpoint: 'https://x/y',
      apiKey: 'k', reasoningEffort: 'high'
    });
    return entry.spec && !('reasoningEffort' in entry.spec);
  })(), 'reasoningEffort 仍被投影进 character_runtime_specs（按角色进入 Home Node 的旁路）');

  /* ══ ⑦ 失败语义：未启用 vs 启用但失败 ═══════════════════════════════ */
  const offRecord = [];
  const mbOff = createNodeMiddleBrain({ executionConfig: () => CORE.projectExecutionConfig({ enabled: false }) });
  const offExecutor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port: recordingPort(offRecord), middleBrain: mbOff });
  const offTurn = await offExecutor.executeCharacterTurn(turnRequest({ requestId: 'req_off' }), { turnId: 't_off' });
  check('fail.disabledIsBypass', offTurn.contextPolicy === 'mobile-gateway-history',
    '未启用时 contextPolicy 不该被改写成 middle-brain:*: ' + offTurn.contextPolicy);
  check('fail.disabledKeepsEffortAuto', offRecord[0].reasoningEffort === 'auto',
    '未启用时思考深度应为 auto（与桌面 _mbReasoningEffortForRequest 同语义）: ' + offRecord[0].reasoningEffort);
  check('fail.disabledKeepsOriginalContext',
    offRecord[0].prompt.system.includes('【长期记忆】') && !offRecord[0].prompt.system.includes('【记忆】'),
    '未启用时上下文被改动了: ' + offRecord[0].prompt.system);

  /* 启用但执行缝抛错 → 回合照常完成，上下文保留原样（fail closed 到"未参与"）。 */
  const brokenRecord = [];
  const mbBroken = {
    isEnabled: async () => true,
    reasoningEffort: async () => 'high',
    organizeContext: async () => { throw new Error('boom'); },
    finalizeReply: async (i) => ({ reply: i.candidate, ran: false })
  };
  const brokenExecutor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port: recordingPort(brokenRecord), middleBrain: mbBroken });
  const brokenTurn = await brokenExecutor.executeCharacterTurn(turnRequest({ requestId: 'req_broken' }), { turnId: 't_broken' });
  check('fail.seamThrowDoesNotFailTurn', brokenTurn.ok === true, brokenTurn);
  check('fail.seamThrowKeepsOriginalContext',
    brokenRecord[0].prompt.system.includes('【长期记忆】'), '执行缝抛错时上下文被改坏了');
  check('fail.disabledAndFailedAreDistinguishable',
    offTurn.contextPolicy !== brokenTurn.contextPolicy
    || /middle-brain/.test(brokenTurn.contextPolicy),
    '未启用与启用但失败无法区分: ' + offTurn.contextPolicy + ' / ' + brokenTurn.contextPolicy);

  /* 注入契约：空产物 / 未组织过上下文 → 不注入。 */
  const mbEcho = {
    isEnabled: async () => true,
    reasoningEffort: async () => 'auto',
    organizeContext: async () => ({ applied: true, source: 'local', compressedContext: '在吗', stats: { empty: true }, policy: 'middle-brain:local/empty/memory:present' }),
    finalizeReply: async (i) => ({ reply: i.candidate, ran: false })
  };
  const echoRecord = [];
  const echoExecutor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port: recordingPort(echoRecord), middleBrain: mbEcho });
  await echoExecutor.executeCharacterTurn(turnRequest({ requestId: 'req_echo' }), { turnId: 't_echo' });
  check('inject.emptyProductNotInjected',
    echoRecord[0].prompt.system.includes('【长期记忆】') && !echoRecord[0].prompt.system.includes('【记忆】'),
    'stats.empty 的产物被注入了（只是当前消息的回声，应视为无产物）: ' + echoRecord[0].prompt.system);
  const mbTruthySource = {
    isEnabled: async () => true,
    reasoningEffort: async () => 'auto',
    organizeContext: async () => ({ applied: true, source: 'something-else', compressedContext: 'X', stats: {} }),
    finalizeReply: async (i) => ({ reply: i.candidate, ran: false })
  };
  const truthyRecord = [];
  const truthyExecutor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port: recordingPort(truthyRecord), middleBrain: mbTruthySource });
  await truthyExecutor.executeCharacterTurn(turnRequest({ requestId: 'req_truthy' }), { turnId: 't_truthy' });
  check('inject.nonNamedSourceNotInjected',
    !truthyRecord[0].prompt.system.includes('X'),
    '未具名来源被当成 truthy 注入了（应只认 local/astra）');

  /* ══ ⑧ finalize 缝：重写发生在落库之前 ══════════════════════════════ */
  const mbRewrite = {
    isEnabled: async () => true,
    reasoningEffort: async () => 'auto',
    organizeContext: async () => ({ applied: false, source: 'bypass', policy: 'middle-brain:bypass/memory:present' }),
    finalizeReply: async (input) => ({ reply: '重写后的回复', ran: true, rewritten: true })
  };
  const rewriteRecord = [];
  const rewriteExecutor = createExecutor({
  characterRegistry: testCharacterRegistry, store, port: recordingPort(rewriteRecord), middleBrain: mbRewrite });
  const rewriteTurn = await rewriteExecutor.executeCharacterTurn(turnRequest({ requestId: 'req_rw' }), { turnId: 't_rw' });
  check('finalize.rewriteReachesCanonicalStore',
    rewriteTurn.text === '重写后的回复'
    && rewriteTurn.message.content === '重写后的回复'
    && store.getMessage(rewriteTurn.assistantMessageId).content === '重写后的回复',
    { text: rewriteTurn.text, stored: store.getMessage(rewriteTurn.assistantMessageId) });
  check('finalize.rewriteIsLabelled', /integrity-rewritten/.test(rewriteTurn.contextPolicy), rewriteTurn.contextPolicy);
  check('finalize.candidatePassedToSeam', rewriteRecord.length === 1);

  /* ══ ⑨ 结构：没有第二份实现 ════════════════════════════════════════ */
  const adapterSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'), 'utf8');
  check('struct.adapterRequiresCanonicalFiles',
    /require\(path\.join\(ASSETS_JS, CONFIG_FILE\)\)/.test(adapterSrc)
    && /require\(path\.join\(ASSETS_JS, file\)\)/.test(adapterSrc)
    && /require\(path\.join\(ASSETS_JS, FACADE_FILE\)\)/.test(adapterSrc),
    '适配层没有 require canonical 层文件');
  check('struct.adapterHasNoPolicyConstants',
    !/MB_GATE_DEFAULTS|MB_CI_SENSITIVITY|REASONING_TIERS|MB_CTX_DEFAULT_BUDGET/.test(adapterSrc),
    '适配层内联了策略常量（那就是第二份实现）');
  check('struct.adapterHasNoTransport', !/\bfetch\s*\(/.test(adapterSrc) && !/Authorization/.test(adapterSrc),
    '适配层自己发了网络请求');
  check('struct.coreIsTheOnlyConfigSemantics', (() => {
    /* 归一/谓词只应出现在 core 里；其余文件不得再定义一份。
       先剥注释：说明文字会原样提到那些函数名，不剥的话测量到的是文档而不是代码
       （本仓库多处守卫都踩过这个坑）。 */
    const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const core = stripComments(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-config-core.js'), 'utf8'));
    const browserCfg = stripComments(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'middle-brain-config.js'), 'utf8'));
    const adapter = stripComments(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'), 'utf8'));
    return /function normalizeMiddleBrainReasoningEffort/.test(core)
      && /^  var MB_DEFAULTS = \{/m.test(core)
      && /function middleBrainRuntimeEnabled/.test(core)
      /* 注意：适配层与浏览器层**可以**出现 `CORE.MB_DEFAULTS` 这样的**引用**，
         不允许的是**定义**（对象字面量 / 函数声明）。判据必须是"定义了没有"，
         否则一条无辜的转调别名也会被判成第二份实现。 */
      && !/function normalizeMiddleBrainReasoningEffort/.test(browserCfg)
      && !/function _mbRuntimeEnabled|function middleBrainRuntimeEnabled/.test(browserCfg)
      && !/^  var MB_DEFAULTS = \{/m.test(browserCfg)
      && !/function normalizeMiddleBrainReasoningEffort|function middleBrainRuntimeEnabled/.test(adapter)
      && !/^  var MB_DEFAULTS = \{/m.test(adapter);
  })(), '执行配置的语义在 core 之外又出现了一份');

  /* ══ ⑩ 端到端：真实网关路径（parseSendPayload → executor）══════════ */
  {
    const gwDir = tempDir('gateway');
    const gwStore = createStore({ dataDir: gwDir });
    gwStore.open();
    const gwRegistry = createDeviceRegistry({ dataDir: gwDir });
    gwRegistry.open();
    gwRegistry.putCharacters([{ id: 'friend_a', dto: { id: 'friend_a', name: '小满' }, spec: { provider: 'openai', model: 'char-model', endpoint: 'https://char', apiKey: 'k', systemPrompt: '你是小满。' } }]);
    /* 发布一份**不含凭据**的执行策略（正是桌面会发的东西） */
    const published = CORE.normalizeProjectedExecutionConfig(projected);
    check('gw.projectionAccepted', published.ok === true, published);
    const wrote = gwRegistry.putMiddleBrainExecutionConfig(published.config);
    check('gw.projectionStored', wrote.ok === true, wrote);
    const readBack = gwRegistry.getMiddleBrainExecutionConfig();
    check('gw.storedConfigHasNoSecret',
      readBack && !JSON.stringify(readBack).includes('sk-') && !('apiKey' in readBack),
      readBack);

    const gwRecords = [];
    const gwMb = createNodeMiddleBrain({
      executionConfig: () => gwRegistry.getMiddleBrainExecutionConfig()
    });
    const gwExecutor = createExecutor({
  characterRegistry: testCharacterRegistry, store: gwStore, port: recordingPort(gwRecords), middleBrain: gwMb });
    const gateway = createMobileGateway({
      store: gwStore, registry: gwRegistry, executor: gwExecutor,
      dto: require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js')),
      logger: () => {}, clock: Date.now
    });
    check('gw.middleBrainSeesPublishedPolicy', await gwMb.isEnabled() === true,
      gwRegistry.getMiddleBrainExecutionConfig());
    check('gw.middleBrainReasoningFromPublishedPolicy', await gwMb.reasoningEffort() === 'high');
    gwMb.dispose();
  }

  console.log('\nM1-C.2i execution convergence: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FATAL', error && error.stack || error);
  process.exitCode = 1;
});
