/* ====================================================================
   Middle Brain · Thin Compatibility Facade（P11-1A）
   --------------------------------------------------------------------
   本文件只做三件事，不含任何业务逻辑：
     1. 编排：Admission Gate →（YES）Astra →（失败/NO）本地 pipeline
     2. canonical 门面：IB.middleBrain（= 同一 API 对象）
     3. 兼容代理：window.* 43 个公开符号 + window._middleBrain（1A 不删除）
   四层实现位于：
     middle-brain-config.js  · config / UI
     middle-brain-policy.js  · deterministic policy / gate
     middle-brain-astra.js   · Astra transport
     middle-brain-judge.js   · judge / telemetry
   生产唯一消费者：communication.js single-chat 路径（经 IB.middleBrain）。
   拆分只动位置，不改 observable behavior。
   ==================================================================== */
(function (NS) {
  'use strict';
  var root = typeof self !== 'undefined' ? self : globalThis;
  /* —— 统一入口：Admission Gate →（YES）Astra →（失败/NO）本地 pipeline ——
     网关只做成本开关：NO 时绝不发起 Astra 网络请求；YES 时沿用 Phase 1 Astra 管线不变。 */
  async function middleBrainCompressPipeline(characterId, userMessage, opts) {
    opts = opts || {};
    var admission = await NS.middleBrainAdmissionGate(characterId, userMessage, opts);
    if (admission && admission.useAstra) {
      var astra = await NS.middleBrainAstraInvoke(characterId, userMessage, opts);
      if (astra) {
        /* 要求 #3：当前 userMessage 永远保留。Astra 结果若不含当前消息（非破坏性 tail 追加）。 */
        if (userMessage && astra.compressedContext && astra.compressedContext.indexOf(userMessage) < 0) {
          astra.compressedContext = (astra.compressedContext ? astra.compressedContext + '\n\n' : '') + userMessage;
        }
        astra.admission = admission;
        /* Phase 3 · Context Judge：仅 Astra 压缩成功时运行；只读评估，不写 compressedContext，
           失败（含 disabled/无法就绪）→ astra.judge=null，绝不影响聊天与压缩。 */
        astra.judge = await NS.middleBrainAstraJudge(characterId, userMessage, astra.structured, astra.compressedContext, opts);
        return astra;
      }
    }
    /* fallback：本地组织+压缩（纯规则，无 Astra 依赖） */
    var local = await NS.middleBrainContextPipeline(characterId, userMessage, opts);
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

  var _mbApi = {
    getMiddleBrainConfig: NS.getMiddleBrainConfig,
    saveMiddleBrainConfig: NS.saveMiddleBrainConfig,
    isMiddleBrainEnabled: NS.isMiddleBrainEnabled,
    middleBrainReady: NS.middleBrainReady,
    getMiddleBrainSystemPrompt: NS.getMiddleBrainSystemPrompt,
    buildMiddleBrainRequest: NS.buildMiddleBrainRequest,
    buildMiddleBrainResponsesRequest: NS.buildMiddleBrainResponsesRequest,
    parseMiddleBrainResponsesResponse: NS.parseMiddleBrainResponsesResponse,
    parseMiddleBrainResponse: NS.parseMiddleBrainResponse,
    middleBrainOrganizeContext: NS.middleBrainOrganizeContext,
    middleBrainCompressContext: NS.middleBrainCompressContext,
    middleBrainContextPipeline: NS.middleBrainContextPipeline,
    middleBrainAstraInvoke: NS.middleBrainAstraInvoke,
    middleBrainCompressPipeline: middleBrainCompressPipeline,
    middleBrainAdmissionGate: NS.middleBrainAdmissionGate,
    middleBrainAdmissionGateReset: NS.middleBrainAdmissionGateReset,
    _mbAnalyzeSignals: NS._mbAnalyzeSignals,
    _mbDecisionFromSignals: NS._mbDecisionFromSignals,
    _mbGateScore: NS._mbGateScore,
    MB_GATE_DEFAULTS: NS.MB_GATE_DEFAULTS,
    middleBrainAstraJudge: NS.middleBrainAstraJudge,
    middleBrainJudgeEnabled: NS.middleBrainJudgeEnabled,
    middleBrainJudgeTelemetry: NS.middleBrainJudgeTelemetry,
    middleBrainJudgeReset: NS.middleBrainJudgeReset,
    _mbParseJudgeJson: NS._mbParseJudgeJson,
    MB_JUDGE_SCHEMA: NS.MB_JUDGE_SCHEMA,
    MB_JUDGE_TIMEOUT_MS: NS.MB_JUDGE_TIMEOUT_MS,
    middleBrainAstraEnabled: middleBrainAstraEnabled,
    _mbParseAstraJson: NS._mbParseAstraJson,
    MB_ASTRA_TIMEOUT_MS: NS.MB_ASTRA_TIMEOUT_MS,
    middleBrainPipelineAvailable: NS.middleBrainPipelineAvailable,
    MB_CTX_DEFAULT_BUDGET: NS.MB_CTX_DEFAULT_BUDGET,
    saveMiddleBrainConfigUI: NS.saveMiddleBrainConfigUI,
    loadMiddleBrainConfigUI: NS.loadMiddleBrainConfigUI
  };

  /* ── canonical 门面 + 兼容代理 ────────────────────────────────────────
     IB.middleBrain 是唯一 canonical 入口（与 window._middleBrain 同一对象）；
     window.* 为 1A 期间的兼容代理，语义与拆分前逐字一致，暂不删除。 */
  root._middleBrain = _mbApi;
  root.IB = root.IB || {};
  root.IB.middleBrain = _mbApi;
  window.middleBrainOrganizeContext = NS.middleBrainOrganizeContext;
  window.middleBrainCompressContext = NS.middleBrainCompressContext;
  window.middleBrainContextPipeline = NS.middleBrainContextPipeline;
  window.middleBrainAstraInvoke = NS.middleBrainAstraInvoke;
  window.middleBrainCompressPipeline = middleBrainCompressPipeline;
  window.middleBrainAdmissionGate = NS.middleBrainAdmissionGate;
  window.middleBrainAdmissionGateReset = NS.middleBrainAdmissionGateReset;
  window._mbAnalyzeSignals = NS._mbAnalyzeSignals;
  window._mbDecisionFromSignals = NS._mbDecisionFromSignals;
  window._mbGateScore = NS._mbGateScore;
  window.MB_GATE_DEFAULTS = NS.MB_GATE_DEFAULTS;
  window.middleBrainAstraJudge = NS.middleBrainAstraJudge;
  window.middleBrainJudgeEnabled = NS.middleBrainJudgeEnabled;
  window.middleBrainJudgeTelemetry = NS.middleBrainJudgeTelemetry;
  window.middleBrainJudgeReset = NS.middleBrainJudgeReset;
  window._mbParseJudgeJson = NS._mbParseJudgeJson;
  window.MB_JUDGE_SCHEMA = NS.MB_JUDGE_SCHEMA;
  window.MB_JUDGE_TIMEOUT_MS = NS.MB_JUDGE_TIMEOUT_MS;
  window.mbReasoningPick = NS.mbReasoningPick;
  window.mbSpeedPick = NS.mbSpeedPick;
  window.mbModelPick = NS.mbModelPick;
  window.mbModelStep = NS.mbModelStep;
  window.normalizeMiddleBrainReasoningEffort = NS.normalizeMiddleBrainReasoningEffort;
  window.normalizeMiddleBrainSpeed = NS.normalizeMiddleBrainSpeed;
  window._mbReadReasoning = NS._mbReadReasoning;
  window._mbReadSpeed = NS._mbReadSpeed;
  window._mbReadModel = NS._mbReadModel;
  window.middleBrainAstraEnabled = middleBrainAstraEnabled;
  window.middleBrainPipelineAvailable = NS.middleBrainPipelineAvailable;
  window.middleBrainAstraEnabled = middleBrainAstraEnabled;
  window._mbParseAstraJson = NS._mbParseAstraJson;
  window.saveMiddleBrainConfigUI = NS.saveMiddleBrainConfigUI;
  window.loadMiddleBrainConfigUI = NS.loadMiddleBrainConfigUI;
  window.getMiddleBrainConfig = NS.getMiddleBrainConfig;
  window.saveMiddleBrainConfig = NS.saveMiddleBrainConfig;
  window.isMiddleBrainEnabled = NS.isMiddleBrainEnabled;
  window.middleBrainEnabled = NS.isMiddleBrainEnabled;
  window.middleBrainReady = NS.middleBrainReady;
  window.buildMiddleBrainRequest = NS.buildMiddleBrainRequest;
  window.buildMiddleBrainResponsesRequest = NS.buildMiddleBrainResponsesRequest;
  window.parseMiddleBrainResponsesResponse = NS.parseMiddleBrainResponsesResponse;
  window.parseMiddleBrainResponse = NS.parseMiddleBrainResponse;
  window.getMiddleBrainSystemPrompt = NS.getMiddleBrainSystemPrompt;

  /* 初始化：填充 Middle Brain 设置卡片（dom 就绪后）。
     保持在最后一个 Middle Brain 脚本内，与拆分前的执行时机逐字一致。 */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', NS.loadMiddleBrainConfigUI);
    else try { NS.loadMiddleBrainConfigUI(); } catch (e) {}
  }
})((function (r) { var ib = r.IB || (r.IB = {}); return ib.__middleBrain || (ib.__middleBrain = {}); })(typeof self !== 'undefined' ? self : globalThis));
