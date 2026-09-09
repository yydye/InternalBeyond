/* ====================================================================
   Middle Brain · Thin Compatibility Facade + Assembly Root（P11-1A / 1B）
   --------------------------------------------------------------------
   本文件不含任何业务逻辑，只做四件事：
     1. 编排：Admission Gate →（YES）Astra →（失败/NO）本地 pipeline
     2. 组装：按 MB_PUBLIC_API 把四层冻结契约拼成 canonical 门面 IB.middleBrain
     3. 兼容代理：window.* 43 个公开符号 + window._middleBrain（1A 不删除）
     4. 初始化设置卡片（与拆分前执行时机逐字一致）
   四层实现与其唯一出口（IB.__middleBrainContracts）：
     middle-brain-config.js  · config → MBC.config（无上游依赖）
     middle-brain-policy.js  · policy → MBC.policy（依赖 config）
     middle-brain-astra.js   · astra  → MBC.astra （依赖 config / policy）
     middle-brain-judge.js   · judge  → MBC.judge （依赖 config / policy / astra）
   依赖是单向 DAG：config ← policy ← astra ← judge ← facade；层间只读冻结契约。
   P11-1B 已删除 P11-1A 的共享可写 namespace（唯一入口现为 IB.__middleBrainContracts）。
   生产唯一消费者：communication.js single-chat 路径（经 IB.middleBrain）。
   拆分只动位置，不改 observable behavior。
   ==================================================================== */
(function (root) {
  'use strict';
  var MBC = (root.IB = root.IB || {}).__middleBrainContracts || (root.IB.__middleBrainContracts = {});
  /* contract 依赖（单向 DAG：config → policy → astra → judge → facade） */
  var CFG = MBC.config, POL = MBC.policy, ASTRA = MBC.astra, JUDGE = MBC.judge;
  /* —— 统一入口：Admission Gate →（YES）Astra →（失败/NO）本地 pipeline ——
     网关只做成本开关：NO 时绝不发起 Astra 网络请求；YES 时沿用 Phase 1 Astra 管线不变。 */
  async function middleBrainCompressPipeline(characterId, userMessage, opts) {
    opts = opts || {};
    var admission = await POL.middleBrainAdmissionGate(characterId, userMessage, opts);
    if (admission && admission.useAstra) {
      var astra = await ASTRA.middleBrainAstraInvoke(characterId, userMessage, opts);
      if (astra) {
        /* 要求 #3：当前 userMessage 永远保留。Astra 结果若不含当前消息（非破坏性 tail 追加）。 */
        if (userMessage && astra.compressedContext && astra.compressedContext.indexOf(userMessage) < 0) {
          astra.compressedContext = (astra.compressedContext ? astra.compressedContext + '\n\n' : '') + userMessage;
        }
        astra.admission = admission;
        /* Phase 3 · Context Judge：仅 Astra 压缩成功时运行；只读评估，不写 compressedContext，
           失败（含 disabled/无法就绪）→ astra.judge=null，绝不影响聊天与压缩。 */
        astra.judge = await JUDGE.middleBrainAstraJudge(characterId, userMessage, astra.structured, astra.compressedContext, opts);
        return astra;
      }
    }
    /* fallback：本地组织+压缩（纯规则，无 Astra 依赖） */
    var local = await POL.middleBrainContextPipeline(characterId, userMessage, opts);
    local.stats = local.stats || {};
    local.stats.source = 'local';
    local.source = 'local';   /* 顶层标记来源（与 astra 返回对齐） */
    if (local.compressedContext) {
      /* 要求 #3 兜底：当前 userMessage 如在压缩结果中缺失（无论是否含 dialogue）→ 追加，绝不漏掉当前消息。 */
      if (userMessage && local.compressedContext.indexOf(userMessage) < 0) {
        local.compressedContext = (local.compressedContext ? local.compressedContext + '\n\n' : '') + userMessage;
      }
    } else if (userMessage) {
      local.compressedContext = userMessage;
    }
    local.admission = admission;
    return local;
  }
  function middleBrainAstraEnabled() { return true; }  /* 启用开关由 middleBrainReady 判定 */

  /* ── 公共 API 组装表（P11-1B）────────────────────────────────────────
     每项 = [public key, owner layer]；key 顺序即 IB.middleBrain 的键顺序，
     由 test_frontend_structure.js 锁定（不得重排 / 改名 / 改 owner）。
     owner 只能取 MBC 中已冻结的层契约，或 facade 自身导出的符号。 */
  var MB_PUBLIC_API = [
    ['getMiddleBrainConfig', 'config'],
    ['saveMiddleBrainConfig', 'config'],
    ['isMiddleBrainEnabled', 'config'],
    ['middleBrainReady', 'config'],
    ['getMiddleBrainSystemPrompt', 'config'],
    ['buildMiddleBrainRequest', 'astra'],
    ['buildMiddleBrainResponsesRequest', 'astra'],
    ['parseMiddleBrainResponsesResponse', 'astra'],
    ['parseMiddleBrainResponse', 'astra'],
    ['middleBrainOrganizeContext', 'policy'],
    ['middleBrainCompressContext', 'policy'],
    ['middleBrainContextPipeline', 'policy'],
    ['middleBrainAstraInvoke', 'astra'],
    ['middleBrainCompressPipeline', 'facade'],
    ['middleBrainAdmissionGate', 'policy'],
    ['middleBrainAdmissionGateReset', 'policy'],
    ['_mbAnalyzeSignals', 'policy'],
    ['_mbDecisionFromSignals', 'policy'],
    ['_mbGateScore', 'policy'],
    ['MB_GATE_DEFAULTS', 'policy'],
    ['middleBrainAstraJudge', 'judge'],
    ['middleBrainJudgeEnabled', 'judge'],
    ['middleBrainJudgeTelemetry', 'judge'],
    ['middleBrainJudgeReset', 'judge'],
    ['_mbParseJudgeJson', 'judge'],
    ['MB_JUDGE_SCHEMA', 'judge'],
    ['MB_JUDGE_TIMEOUT_MS', 'judge'],
    ['middleBrainAstraEnabled', 'facade'],
    ['_mbParseAstraJson', 'astra'],
    ['MB_ASTRA_TIMEOUT_MS', 'astra'],
    ['middleBrainPipelineAvailable', 'policy'],
    ['MB_CTX_DEFAULT_BUDGET', 'policy'],
    ['saveMiddleBrainConfigUI', 'config'],
    ['loadMiddleBrainConfigUI', 'config']
  ];
  var MB_LAYERS = {
    config: CFG, policy: POL, astra: ASTRA, judge: JUDGE,
    /* facade 自身导出的符号（不来自任何层契约） */
    facade: { middleBrainCompressPipeline: middleBrainCompressPipeline, middleBrainAstraEnabled: middleBrainAstraEnabled }
  };
  var _mbApi = {};
  MB_PUBLIC_API.forEach(function (entry) { _mbApi[entry[0]] = MB_LAYERS[entry[1]][entry[0]]; });

  /* ── canonical 门面 + 兼容代理 ────────────────────────────────────────
     IB.middleBrain 是唯一 canonical 入口（与 window._middleBrain 同一对象）；
     window.* 为 1A 期间的兼容代理，语义与拆分前逐字一致，暂不删除。 */
  root._middleBrain = _mbApi;
  root.IB = root.IB || {};
  root.IB.middleBrain = _mbApi;
  window.middleBrainOrganizeContext = POL.middleBrainOrganizeContext;
  window.middleBrainCompressContext = POL.middleBrainCompressContext;
  window.middleBrainContextPipeline = POL.middleBrainContextPipeline;
  window.middleBrainAstraInvoke = ASTRA.middleBrainAstraInvoke;
  window.middleBrainCompressPipeline = middleBrainCompressPipeline;
  window.middleBrainAdmissionGate = POL.middleBrainAdmissionGate;
  window.middleBrainAdmissionGateReset = POL.middleBrainAdmissionGateReset;
  window._mbAnalyzeSignals = POL._mbAnalyzeSignals;
  window._mbDecisionFromSignals = POL._mbDecisionFromSignals;
  window._mbGateScore = POL._mbGateScore;
  window.MB_GATE_DEFAULTS = POL.MB_GATE_DEFAULTS;
  window.middleBrainAstraJudge = JUDGE.middleBrainAstraJudge;
  window.middleBrainJudgeEnabled = JUDGE.middleBrainJudgeEnabled;
  window.middleBrainJudgeTelemetry = JUDGE.middleBrainJudgeTelemetry;
  window.middleBrainJudgeReset = JUDGE.middleBrainJudgeReset;
  window._mbParseJudgeJson = JUDGE._mbParseJudgeJson;
  window.MB_JUDGE_SCHEMA = JUDGE.MB_JUDGE_SCHEMA;
  window.MB_JUDGE_TIMEOUT_MS = JUDGE.MB_JUDGE_TIMEOUT_MS;
  window.mbReasoningPick = CFG.mbReasoningPick;
  window.mbSpeedPick = CFG.mbSpeedPick;
  window.mbModelPick = CFG.mbModelPick;
  window.mbModelStep = CFG.mbModelStep;
  window.normalizeMiddleBrainReasoningEffort = CFG.normalizeMiddleBrainReasoningEffort;
  window.normalizeMiddleBrainSpeed = CFG.normalizeMiddleBrainSpeed;
  window._mbReadReasoning = CFG._mbReadReasoning;
  window._mbReadSpeed = CFG._mbReadSpeed;
  window._mbReadModel = CFG._mbReadModel;
  window.middleBrainAstraEnabled = middleBrainAstraEnabled;
  window.middleBrainPipelineAvailable = POL.middleBrainPipelineAvailable;
  window.middleBrainAstraEnabled = middleBrainAstraEnabled;
  window._mbParseAstraJson = ASTRA._mbParseAstraJson;
  window.saveMiddleBrainConfigUI = CFG.saveMiddleBrainConfigUI;
  window.loadMiddleBrainConfigUI = CFG.loadMiddleBrainConfigUI;
  window.getMiddleBrainConfig = CFG.getMiddleBrainConfig;
  window.saveMiddleBrainConfig = CFG.saveMiddleBrainConfig;
  window.isMiddleBrainEnabled = CFG.isMiddleBrainEnabled;
  window.middleBrainEnabled = CFG.isMiddleBrainEnabled;
  window.middleBrainReady = CFG.middleBrainReady;
  window.buildMiddleBrainRequest = ASTRA.buildMiddleBrainRequest;
  window.buildMiddleBrainResponsesRequest = ASTRA.buildMiddleBrainResponsesRequest;
  window.parseMiddleBrainResponsesResponse = ASTRA.parseMiddleBrainResponsesResponse;
  window.parseMiddleBrainResponse = ASTRA.parseMiddleBrainResponse;
  window.getMiddleBrainSystemPrompt = CFG.getMiddleBrainSystemPrompt;

  /* 初始化：填充 Middle Brain 设置卡片（dom 就绪后）。
     保持在最后一个 Middle Brain 脚本内，与拆分前的执行时机逐字一致。 */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', CFG.loadMiddleBrainConfigUI);
    else try { CFG.loadMiddleBrainConfigUI(); } catch (e) {}
  }
})(typeof self !== 'undefined' ? self : globalThis);
