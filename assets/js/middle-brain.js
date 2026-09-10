/* ====================================================================
   Middle Brain · Thin Compatibility Facade + Assembly Root + Execution Seam（P11-1A / 1B / 1C）
   --------------------------------------------------------------------
   本文件不含任何业务逻辑，只做五件事：
     1. 编排：Admission Gate →（YES）Astra →（失败/NO）本地 pipeline
     2. 执行缝：middleBrainExecute = readiness 判定 + pipeline（生产调用方唯一入口，P11-1C）
     3. 组装：按 MB_PUBLIC_API 把四层冻结契约拼成 canonical 门面 IB.middleBrain
     4. 兼容代理：window.* 43 个公开符号 + window._middleBrain（1A 不删除）
     5. 初始化设置卡片（与拆分前执行时机逐字一致）
   五层实现与其唯一出口（IB.__middleBrainContracts）：
     middle-brain-config.js    · config    → MBC.config（无上游依赖）
     middle-brain-policy.js    · policy    → MBC.policy（依赖 config）
     middle-brain-astra.js     · astra     → MBC.astra （依赖 config / policy，唯一网络边界）
     middle-brain-judge.js     · judge     → MBC.judge （依赖 config / policy / astra）
     middle-brain-integrity.js · integrity → MBC.integrity（依赖 config / policy / astra，P11-2）
   依赖是单向 DAG：config ← policy ← astra ← {judge, integrity} ← facade；层间只读冻结契约。
   P11-1B 已删除 P11-1A 的共享可写 namespace（唯一入口现为 IB.__middleBrainContracts）。
   P11-1C：生产唯一消费者 communication.js single-chat 只经 IB.middleBrain.middleBrainExecute
     进入 Middle Brain——不读 IB.__middleBrainContracts、不调用层契约、不自行编排 readiness、
     不依赖 window.* 兼容别名作为 canonical path。
   P11-2：生成后执行缝 IB.middleBrain.middleBrainFinalizeReply（Character Integrity Guard），
     同样只存在于 facade、**不挂 window 兼容别名**；调用方只交候选回复、只取回文本。
   拆分只动位置，不改 observable behavior。
   ==================================================================== */
(function (root) {
  'use strict';
  var MBC = (root.IB = root.IB || {}).__middleBrainContracts || (root.IB.__middleBrainContracts = {});
  /* contract 依赖（单向 DAG：config → policy → astra → judge / integrity → facade） */
  var CFG = MBC.config, POL = MBC.policy, ASTRA = MBC.astra, JUDGE = MBC.judge, INTEG = MBC.integrity;

  /* ── Middle Brain Trace · dev-only 观测层（P-audit，双层 participation audit）────
     目的：在一次普通单聊请求里逐层回答"Middle Brain 是否真的参与了最终发给模型的请求"。
     硬约束（只观测，不参与任何业务判定）：
       · 只打印固定白名单字段；绝不打印 system prompt / 角色设定 / Memory / API key / 用户正文；
       · 不落盘、不写存储、不改任何返回值 / 判定 / 调用顺序（除本文件内的几个赋值外零副作用）；
       · 被观测层没有参与时一律打印 false，绝不省略该行。
     关闭方式：window.__IB_MB_TRACE = false，或 localStorage['ib_mb_trace'] = '0'。 */
  var _MB_TRACE_MAX = 20, _MB_TRACE_RING = [], _MB_TRACE = {};
  var _MB_TRACE_FIELDS = ['consumer', 'character', 'enabled', 'executeEntered', 'configApplied', 'policyApplied',
    'astraApplied', 'judgeApplied', 'oocGuardApplied', 'inputMessages', 'outputMessages', 'systemChanged',
    'requestParamsChanged', 'executor', 'model', 'source', 'messagesChanged'];
  function _mbTraceOn() {
    try {
      if (root.__IB_MB_TRACE === false) return false;
      if (root.__IB_MB_TRACE === true) return true;
      if (root.localStorage && root.localStorage.getItem('ib_mb_trace') === '0') return false;
      return true;
    } catch (e) { return false; }
  }
  function _mbTraceRec(characterId) {
    try { return _MB_TRACE[String(characterId == null ? '' : characterId)] || null; } catch (e) { return null; }
  }
  /* 只写字段；没有 begin 过的调用（直接调用 pipeline / 单测）→ 静默 no-op，不打印。 */
  function _mbTraceNote(characterId, key, value) {
    var r = _mbTraceRec(characterId);
    if (r) r[key] = value;
    return r;
  }
  function _mbTraceBegin(consumer, characterId) {
    if (!_mbTraceOn()) return null;
    var rec = { consumer: String(consumer || 'chat'), character: String(characterId == null ? '' : characterId), at: Date.now(),
      enabled: null, executeEntered: false, configApplied: false, policyApplied: false, astraApplied: false,
      judgeApplied: false, oocGuardApplied: false, inputMessages: null, outputMessages: null,
      systemChanged: null, requestParamsChanged: null, executor: null, model: null, source: null, messagesChanged: null };
    try { _MB_TRACE[rec.character] = rec; } catch (e) {}
    return rec;
  }
  function _mbTraceText(rec) {
    var lines = ['[MiddleBrain Trace]'];
    for (var i = 0; i < _MB_TRACE_FIELDS.length; i++) {
      var k = _MB_TRACE_FIELDS[i], v = rec[k];
      if (k === 'inputMessages' || k === 'outputMessages') lines.push(k + ': ' + (v == null ? 'null' : String(v)));
      else if (k === 'executor' || k === 'model' || k === 'source' || k === 'character' || k === 'consumer') lines.push(k + ': ' + (v == null ? '' : String(v)));
      else lines.push(k + ': ' + (v === true ? 'true' : 'false'));
    }
    return lines.join('\n');
  }
  function _mbTraceEmit(rec) {
    try { if (typeof console !== 'undefined' && console.info) console.info(_mbTraceText(rec)); } catch (e) {}
  }
  /* 只读取本轮的观测值；enabled 未被 runtime 路径读过时补一次只读探测（异步打印，不给聊天加 await）。 */
  function _mbTraceFinish(characterId, extra) {
    var rec = _mbTraceRec(characterId);
    if (!rec) return null;
    if (extra && typeof extra === 'object') {
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) rec[k] = extra[k]; }
    }
    rec.requestParamsChanged = (rec._paramsSeam != null && rec._paramsSend != null)
      ? String(rec._paramsSeam) !== String(rec._paramsSend) : false;
    try { _MB_TRACE_RING.push(rec); if (_MB_TRACE_RING.length > _MB_TRACE_MAX) _MB_TRACE_RING.shift(); } catch (e) {}
    try { delete _MB_TRACE[rec.character]; } catch (e) {}
    if (rec.enabled === null) {
      try {
        CFG.isMiddleBrainEnabled().then(function (v) { rec.enabled = !!v; _mbTraceEmit(rec); },
          function () { rec.enabled = false; _mbTraceEmit(rec); });
        return rec;
      } catch (e) { rec.enabled = false; }
    }
    _mbTraceEmit(rec);
    return rec;
  }

  /* —— 统一入口：Admission Gate →（YES）Astra →（失败/NO）本地 pipeline ——
     网关只做成本开关：NO 时绝不发起 Astra 网络请求；YES 时沿用 Phase 1 Astra 管线不变。 */
  async function middleBrainCompressPipeline(characterId, userMessage, opts) {
    opts = opts || {};
    var admission = await POL.middleBrainAdmissionGate(characterId, userMessage, opts);
    _mbTraceNote(characterId, 'policyApplied', true);   /* policy 层：Admission Gate 已实际执行 */
    if (admission && admission.useAstra) {
      var astra = await ASTRA.middleBrainAstraInvoke(characterId, userMessage, opts);
      if (astra) {
        _mbTraceNote(characterId, 'astraApplied', true);   /* astra 层：网络调用成功并返回结果 */
        /* 要求 #3：当前 userMessage 永远保留。Astra 结果若不含当前消息（非破坏性 tail 追加）。 */
        if (userMessage && astra.compressedContext && astra.compressedContext.indexOf(userMessage) < 0) {
          astra.compressedContext = (astra.compressedContext ? astra.compressedContext + '\n\n' : '') + userMessage;
        }
        astra.admission = admission;
        /* Phase 3 · Context Judge：仅 Astra 压缩成功时运行；只读评估，不写 compressedContext，
           失败（含 disabled/无法就绪）→ astra.judge=null，绝不影响聊天与压缩。 */
        astra.judge = await JUDGE.middleBrainAstraJudge(characterId, userMessage, astra.structured, astra.compressedContext, opts);
        _mbTraceNote(characterId, 'judgeApplied', !!(astra.judge));   /* judge 层：仅真正产出评估结果才为 true */
        _mbTraceNote(characterId, 'source', 'astra');
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
    _mbTraceNote(characterId, 'source', 'local');   /* Astra 未参与：本地 pipeline 兜底 */
    return local;
  }
  function middleBrainAstraEnabled() { return true; }  /* 启用开关由 middleBrainReady 判定 */

  /* ── canonical execution seam（P11-1C）────────────────────────────────
     生产调用方（single-chat）唯一执行入口。语义 = P11-1A 之前 communication.js 自己
     编排的那两步，逐字搬进来，不新增任何判定：
       未启用（enabled/endpoint/model 任一缺失）→ 返回 null，调用方不做任何事；
       已启用 → 执行 middleBrainCompressPipeline，返回其结果。
     来源三态（P11-3 收敛，与 trace 的 source 字段一一对应）：
       'astra'  → Astra 处理结果（唯一网络边界成功）
       'local'  → 本地 pipeline 处理结果（Gate NO / Astra 未就绪 / Astra 失败）
       'bypass' → 本缝返回 null（未启用），调用方保留原始上下文
     调用方因此不需要知道 config/policy/astra/judge，也不需要知道 isMiddleBrainEnabled /
     middleBrainCompressPipeline 等符号，只需按上面的三态决定是否替换上下文
     （判定在 communication.js 的 _mbInjectable：具名来源白名单 + 非空 payload + 组织过上下文）。
     注：readiness 判定沿用 isMiddleBrainEnabled（不含 apiKey），与迁移前完全一致；
     真正的 Astra 就绪判定仍由 Admission Gate 负责（apiKey 缺失 → local 兜底）。 */
  async function middleBrainExecute(characterId, userMessage, opts) {
    var _tr = _mbTraceRec(characterId);
    if (_tr) _tr.executeEntered = true;   /* 观测：canonical 执行缝确实进入 */
    if (!(await CFG.isMiddleBrainEnabled())) {
      if (_tr) { _tr.configApplied = true; _tr.enabled = false; }
      _mbTraceNote(characterId, 'source', 'bypass');   /* 三态之一：本缝未产出任何上下文 */
      return null;
    }
    if (_tr) { _tr.configApplied = true; _tr.enabled = true; }
    return middleBrainCompressPipeline(characterId, userMessage, opts).then(function (r) {
      if (_tr) _tr.source = (r && r.source) || null;
      return r;
    });
  }

  /* ── canonical 生成后执行缝（P11-2）──────────────────────────────────
     生产调用方（single-chat）在**角色模型生成候选回复之后**的唯一入口。
     语义：交候选回复 → 取回最终文本；调用方不感知内部任何判定/重写策略。
     硬保证：
       ① 未启用 / 任何故障 / 返回非法值 → 原样返回候选（Guard 绝不是聊天单点故障）；
       ② 只返回字符串，永不返回 null/undefined/空串；
       ③ 内部每条候选最多一次重写（由 integrity 层保证，本缝不参与编排）。 */
  async function middleBrainFinalizeReply(characterId, userMessage, candidate, opts) {
    if (typeof candidate !== 'string' || !candidate) return candidate;
    try {
      var r = await INTEG.middleBrainCharacterIntegrity(characterId, userMessage, candidate, opts || {});
      _mbTraceNote(characterId, 'oocGuardApplied', !!(r && r.ran));   /* 观测：一致性守卫本轮是否真的执行 */
      if (r && typeof r.reply === 'string' && r.reply) return r.reply;
    } catch (e) {}
    return candidate;
  }

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
    ['middleBrainExecute', 'facade'],
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
    ['loadMiddleBrainConfigUI', 'config'],
    ['normalizeMiddleBrainIntegritySensitivity', 'config'],
    ['middleBrainFinalizeReply', 'facade'],
    ['middleBrainCharacterIntegrity', 'integrity'],
    ['middleBrainCharacterIntegrityTelemetry', 'integrity'],
    ['middleBrainCharacterIntegrityReset', 'integrity'],
    ['_mbParseCiJson', 'integrity'],
    ['_mbCiGate', 'integrity'],
    ['_mbCiVisibleText', 'integrity'],
    ['MB_CI_SCHEMA', 'integrity'],
    ['MB_CI_TIMEOUT_MS', 'integrity'],
    ['middleBrainImageMode', 'config'],
    ['normalizeMiddleBrainImageMode', 'config']
  ];
  var MB_LAYERS = {
    config: CFG, policy: POL, astra: ASTRA, judge: JUDGE, integrity: INTEG,
    /* facade 自身导出的符号（不来自任何层契约） */
    facade: { middleBrainCompressPipeline: middleBrainCompressPipeline, middleBrainExecute: middleBrainExecute, middleBrainAstraEnabled: middleBrainAstraEnabled, middleBrainFinalizeReply: middleBrainFinalizeReply }
  };
  var _mbApi = {};
  MB_PUBLIC_API.forEach(function (entry) { _mbApi[entry[0]] = MB_LAYERS[entry[1]][entry[0]]; });

  /* ── canonical 门面 + 兼容代理 ────────────────────────────────────────
     IB.middleBrain 是唯一 canonical 入口（与 window._middleBrain 同一对象）；
     window.* 为 1A 期间的兼容代理，语义与拆分前逐字一致，暂不删除。
     注意：middleBrainExecute（P11-1C 执行缝）**故意不挂 window 兼容别名**，
     避免它退化成一个新的散落全局依赖；canonical 路径只有 IB.middleBrain。 */
  root._middleBrain = _mbApi;
  root.IB = root.IB || {};
  root.IB.middleBrain = _mbApi;
  /* dev-only 观测入口（独立于 canonical 门面 key 列表，不参与 MB_PUBLIC_API 契约）。 */
  root.IB.__mbTrace = {
    begin: _mbTraceBegin, note: _mbTraceNote, finish: _mbTraceFinish,
    recent: function (n) { var k = Math.max(1, Math.min(_MB_TRACE_MAX, Number(n) || 5)); return _MB_TRACE_RING.slice(-k); },
    fields: _MB_TRACE_FIELDS.slice(), on: _mbTraceOn
  };
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
