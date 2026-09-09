/* ====================================================================
   Middle Brain · Judge / Telemetry 层（P11-1A 自 middle-brain.js 物理拆分）
   --------------------------------------------------------------------
   职责：对"已压缩 Context"做只读质量评估 + 运行态 telemetry。
   边界：不修改 compressedContext、不写 Memory/Understanding/Thread、
         不生成角色回复、失败一律 null（绝不重试、绝不影响聊天）。
   默认关闭（middleBrainJudgeEnabled=false）；关闭时 Phase 2 行为完全不变。
   拆分只动位置，不改逻辑。
   ==================================================================== */
(function (NS) {
  'use strict';
  var root = typeof self !== 'undefined' ? self : globalThis;
  /* ====================================================================
     Middle Brain Phase 3 · Astra Context Judge（只读质量评估 / observe）
     --------------------------------------------------------------------
     - Judge 与 Compression 严格分离：Compression = "整理并压缩 Context"；
       Judge = "判断 Compression 做得好不好"。
     - Judge 只读：本次 organized Context、本次 Astra compressedContext、
       当前 userMessage、recent dialogue。绝不写 Memory/Understanding/Thread/
       Diary/Moments/IndexedDB/localStorage(Memory)。
     - 不修改 compressedContext；不生成角色回复；不做 OOC/Output Repair/
       Model Routing；不判断哪条 Memory 是真实事实（冲突只报告）。
     - 复用现有 Responses API Adapter（buildResponsesRequest / parseResponsesResponse /
       _ibApiPost 传输），不重新实现 HTTP/fetch/API Key/SSE/parser。
     - 失败（超时/500/非 JSON/校验不过）→ 返回 null，绝不重试、绝不影响聊天、
       绝不影响已成功的 Compression；不做第二次 Compression。
     - 只在 Astra 压缩实际成功时运行：Admission Gate=NO 或 fallback 到 local 均不调用。
     可用 middleBrainJudgeEnabled=false 完全关闭（Phase 2 行为不变）。
     ==================================================================== */
  var MB_JUDGE_SCHEMA = {
    type: 'object',
    properties: {
      relevance: { type: 'number' },
      contradiction: {
        type: 'object',
        properties: { detected: { type: 'boolean' }, items: { type: 'array', items: { type: 'string' } } },
        required: ['detected', 'items'], additionalProperties: false
      },
      stale: { type: 'array', items: { type: 'string' } },
      duplicate: { type: 'array', items: { type: 'string' } },
      missing_context: { type: 'array', items: { type: 'string' } },
      current_turn_coverage: { type: 'number' },
      compression_quality: { type: 'number' },
      overall: { type: 'number' },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['relevance', 'contradiction', 'stale', 'duplicate', 'missing_context', 'current_turn_coverage', 'compression_quality', 'overall', 'warnings'],
    additionalProperties: false
  };
  var MB_JUDGE_TIMEOUT_MS = 20000;
  var _mbJudgeTelemetry = {
    attempted: 0, success: 0, failed: 0, totalLatencyMs: 0,
    overallSum: 0, contradictionDetected: 0, missingTotal: 0, staleTotal: 0, duplicateTotal: 0, currentTurnCoverageSum: 0,
    last: null /* 最近一次数值快照（不含用户内容/API Key） */
  };
  function middleBrainJudgeEnabled() {
    try { return NS.getMiddleBrainConfig().then(function (c) { return !!(c && c.middleBrainJudgeEnabled === true); }); } catch (e) { return Promise.resolve(false); }
  }
  function _mbStrArr(v) { return Array.isArray(v) ? v.map(function (x) { return String(x); }).filter(function (x) { return x; }) : []; }
  /* 解析 + 校验 Judge JSON：clamp 0..1，白名单字段，异常/非 JSON → null。 */
  function _mbParseJudgeJson(text) {
    try {
      var s = String(text || '').trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      var c = obj.contradiction || {};
      return {
        relevance: NS._mbClamp01(Number(obj.relevance)),
        contradiction: { detected: !!(c.detected), items: _mbStrArr(c.items) },
        stale: _mbStrArr(obj.stale),
        duplicate: _mbStrArr(obj.duplicate),
        missing_context: _mbStrArr(obj.missing_context),
        current_turn_coverage: NS._mbClamp01(Number(obj.current_turn_coverage)),
        compression_quality: NS._mbClamp01(Number(obj.compression_quality)),
        overall: NS._mbClamp01(Number(obj.overall)),
        warnings: _mbStrArr(obj.warnings)
      };
    } catch (e) { return null; }
  }
  /* Judge 专用请求体：复用现有 Responses 归一，仅替换 structured-output schema（不重实现 HTTP/鉴权）。 */
  async function _mbBuildJudgeRequest(prompt, options) {
    var base = await NS.buildMiddleBrainResponsesRequest(null, prompt, { maxTokens: options.maxTokens || 900, jsonMode: true });
    base.body.text = { format: { type: 'json_schema', name: 'context_quality_report', schema: MB_JUDGE_SCHEMA } };
    return base;
  }
  function _mbBuildJudgePrompt(organized, compressedContext, userMessage) {
    var ctxBlocks = [];
    if (organized && organized.memory && organized.memory.length) ctxBlocks.push('【Memory】' + organized.memory.join('\n'));
    if (organized && organized.understanding && organized.understanding.length) ctxBlocks.push('【Understanding】' + organized.understanding.join('\n'));
    if (organized && organized.threads && organized.threads.length) ctxBlocks.push('【Thread】' + organized.threads.join('\n'));
    if (organized && organized.moments && organized.moments.length) ctxBlocks.push('【Moments】' + organized.moments.join('\n'));
    if (organized && Array.isArray(organized.dialogue) && organized.dialogue.length) ctxBlocks.push('【当前对话】' + organized.dialogue.join('\n'));
    if (userMessage) ctxBlocks.push('【当前用户消息】' + userMessage);
    return '你是 InternalBeyond（IB）的 Context Quality Judge。你只负责评估"压缩后的 Context 做得好不好"，'
      + '绝不修改它、绝不生成角色回复、绝不判断哪条 Memory 是真实事实（冲突只报告）。\n'
      + '读原始上下文（被压缩前的）与压缩后的结果，对压缩质量做只读评估，输出结构化 JSON。\n'
      + '评分规则：relevance / current_turn_coverage / compression_quality / overall 均为 0..1 分数（1 最佳）。\n'
      + 'stale / duplicate / missing_context 为问题条目字符串数组（无则空数组）。\n'
      + 'contradiction: 若上下文存在明显互相冲突的信息，detected:true 且列出冲突项；只报告，不判定哪个为真。\n'
      + '只输出 JSON，不要多余文字：{"relevance":0.9,"contradiction":{"detected":false,"items":[]},"stale":[],"duplicate":[],"missing_context":[],"current_turn_coverage":1.0,"compression_quality":0.85,"overall":0.9,"warnings":[]}\n'
      + '【原始上下文】\n' + (ctxBlocks.join('\n\n') || '(空)') + '\n\n【压缩后的 Context】\n' + (compressedContext || '(空)') + '\n\n'
      + '请评估【压缩后的 Context】的质量。';
  }
  /* Judge 主入口：复用现有 Responses 调用链，只读评估；失败 → null（不影响聊天/压缩）。 */
  async function middleBrainAstraJudge(characterId, userMessage, organized, compressedContext, opts) {
    opts = opts || {};
    try {
      /* disabled → 完全不调用 Judge（不计 telemetry，恢复 Phase 2 行为） */
      if (!(await middleBrainJudgeEnabled())) return null;
      if (!(await NS.middleBrainReady())) return null;
      var cfg = await NS.getMiddleBrainConfig();
      var t0 = Date.now();
      _mbJudgeTelemetry.attempted++;
      var prompt = _mbBuildJudgePrompt(organized, compressedContext, userMessage);
      var req = await _mbBuildJudgeRequest([{ role: 'user', content: prompt }], { maxTokens: 900 });
      if (req && cfg.endpoint) req.endpoint = cfg.endpoint;
      var ac = new AbortController();
      var tm = setTimeout(function () { ac.abort(); }, (opts.timeoutMs != null ? Number(opts.timeoutMs) : MB_JUDGE_TIMEOUT_MS));
      var res;
      if (typeof root._ibApiPost === 'function') {
        res = await root._ibApiPost(req.endpoint, Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }), JSON.stringify(req.body), { signal: ac.signal });
      } else {
        res = await fetch(req.endpoint, { method: 'POST', headers: Object.assign({}, req.headers, { Authorization: 'Bearer ' + (cfg.apiKey || '') }), body: JSON.stringify(req.body), signal: ac.signal });
      }
      clearTimeout(tm);
      if (!res.ok) return null;
      var data = await res.json().catch(function () { return null; });
      if (!data) return null;
      var parsed = null;
      try { var _a = NS.adapter(); if (_a && typeof _a.parseResponsesResponse === 'function') parsed = _a.parseResponsesResponse(data, null, {}); } catch (e) { parsed = null; }
      if (!parsed) parsed = { content: '', reasoning: '', truncated: false, usage: null };
      if (!parsed.content) return null;
      var report = _mbParseJudgeJson(parsed.content);
      if (!report) return null;
      var latency = Date.now() - t0;
      _mbJudgeTelemetry.success++;
      _mbJudgeTelemetry.totalLatencyMs += latency;
      _mbJudgeTelemetry.overallSum += report.overall;
      if (report.contradiction && report.contradiction.detected) _mbJudgeTelemetry.contradictionDetected++;
      _mbJudgeTelemetry.missingTotal += report.missing_context.length;
      _mbJudgeTelemetry.staleTotal += report.stale.length;
      _mbJudgeTelemetry.duplicateTotal += report.duplicate.length;
      _mbJudgeTelemetry.currentTurnCoverageSum += report.current_turn_coverage;
      _mbJudgeTelemetry.last = {
        attempted: _mbJudgeTelemetry.attempted, success: _mbJudgeTelemetry.success,
        latencyMs: latency, overall: report.overall, contradictionDetected: !!(report.contradiction && report.contradiction.detected),
        missingCount: report.missing_context.length, staleCount: report.stale.length, duplicateCount: report.duplicate.length,
        currentTurnCoverage: report.current_turn_coverage, ts: Date.now()
      };
      return report;
    } catch (e) {
      _mbJudgeTelemetry.failed++;
      return null;
    }
  }
  function middleBrainJudgeTelemetry() { return _mbJudgeTelemetry; }
  function middleBrainJudgeReset() { _mbJudgeTelemetry.attempted = 0; _mbJudgeTelemetry.success = 0; _mbJudgeTelemetry.failed = 0; _mbJudgeTelemetry.totalLatencyMs = 0; _mbJudgeTelemetry.overallSum = 0; _mbJudgeTelemetry.contradictionDetected = 0; _mbJudgeTelemetry.missingTotal = 0; _mbJudgeTelemetry.staleTotal = 0; _mbJudgeTelemetry.duplicateTotal = 0; _mbJudgeTelemetry.currentTurnCoverageSum = 0; _mbJudgeTelemetry.last = null; }

  /* —— 注册到 IB.__middleBrain（内部装配点，非公开契约）—— */
  NS.middleBrainAstraJudge = middleBrainAstraJudge;
  NS.middleBrainJudgeEnabled = middleBrainJudgeEnabled;
  NS.middleBrainJudgeTelemetry = middleBrainJudgeTelemetry;
  NS.middleBrainJudgeReset = middleBrainJudgeReset;
  NS._mbParseJudgeJson = _mbParseJudgeJson;
  NS.MB_JUDGE_SCHEMA = MB_JUDGE_SCHEMA;
  NS.MB_JUDGE_TIMEOUT_MS = MB_JUDGE_TIMEOUT_MS;
})((function (r) { var ib = r.IB || (r.IB = {}); return ib.__middleBrain || (ib.__middleBrain = {}); })(typeof self !== 'undefined' ? self : globalThis));
