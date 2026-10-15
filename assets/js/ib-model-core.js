/* ====================================================================
   IB Model Core — runtime-neutral provider core (UMD dual-load)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/ib-model-core.js"> → window.IBModelCore
   - Node   : require('../assets/js/ib-model-core.js')
   - 规则：零 window / 零 DOM / 零 fetch / 零 window.IB / 零 Proactive 依赖 / 纯函数优先。
   - 逐行为提取自 browser social.js(提供者目录) 与 active/model-client.js
     (adaptMessageParts/geminiParts + anthropic/gemini/openai request/response)。
   - 结构参考仓库已有 UMD 共享模块 reply-chain-core.js。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./provider-directory.js')); }
  else { root.IBModelCore = factory(root.PROVIDERS_DIR || {}); }
})(typeof self !== 'undefined' ? self : this, function (CANON) {
  'use strict';

  /* 提供者目录：唯一 canonical 数据源为 assets/js/provider-directory.js。
     此处不再维护第二份 provider metadata 字面量；
     Node 下由上方 require 传入，browser 下由 window.PROVIDERS_DIR 传入。 */
  var PROVIDERS = (CANON && CANON.PROVIDERS) || {};

  /* provider → wire format（model-client 分支保持一致：anthropic/gemini/else-openai）
     P11-0：唯一 canonical 决策在 provider-directory.js。
       Node    —— CANON = require('./provider-directory.js')
       Browser —— CANON = window.PROVIDERS_DIR
     宿主只传了裸 PROVIDERS 表（无 providerFormat）时保留原表达式，行为逐位不变。 */
  function providerFormat(provider) {
    if (CANON && typeof CANON.providerFormat === 'function') return CANON.providerFormat(provider);
    return (PROVIDERS[provider] && PROVIDERS[provider].format) || 'openai';
  }
  /* canonical 结构化决策（供 agent-runtime 等读取 known/hasFormat）。 */
  function resolveProviderFormat(provider) {
    if (CANON && typeof CANON.resolveProviderFormat === 'function') return CANON.resolveProviderFormat(provider);
    var entry = (provider == null ? null : PROVIDERS[provider]) || null;
    if (entry) { var fmt = String(entry.format || ''); return { format: fmt || 'openai', known: true, hasFormat: !!fmt }; }
    return { format: 'openai', known: false, hasFormat: false };
  }

  /* P18 · model policy：该 model 是否接受 temperature / top_p / top_k。
     唯一判定在 provider-directory.js（MODEL_POLICIES）；宿主只传了裸 PROVIDERS 表
     （无该函数）时返回 true = 照发，与 P18 之前逐位一致。 */
  function modelSupportsSamplingParameters(model) {
    if (CANON && typeof CANON.modelSupportsSamplingParameters === 'function') {
      return CANON.modelSupportsSamplingParameters(model) !== false;
    }
    return true;
  }

  /* P19 · model policy：该 model 是否接受「最后一条 assistant 消息作为 seed」
     （assistant prefill）。唯一判定仍在 provider-directory.js（MODEL_POLICIES），
     与 sampling 共用同一个 canonical lookup；宿主没有该函数时返回 true =
     保留历史行为（未知 model 绝不擅自改变请求语义）。 */
  function modelSupportsAssistantPrefill(model) {
    if (CANON && typeof CANON.modelSupportsAssistantPrefill === 'function') {
      return CANON.modelSupportsAssistantPrefill(model) !== false;
    }
    return true;
  }

  /* ── P19 · 结构化输出意图（intent）vs 传输实现（transport）────────────────
     调用方只表达「本次请求需要结构化 JSON」（options.jsonMode）。实现方式由
     model policy 决定：
       A. 支持 assistant prefill 的 model → 追加 seed assistant 消息（历史行为）
       B. 不支持的 model（Claude 4.6+）→ 不追加 seed，改为等价的 prompt 约束
     旧的 options.jsonPrefill 仍然被接受，但它只是 A 方案的 seed 文本，
     不再等同于「要 JSON」这个业务语义。 */
  var JSON_ONLY_CONSTRAINT = 'Return exactly one valid JSON object. The first non-whitespace character must be { and the final non-whitespace character must be }. Do not use Markdown code fences. Do not include commentary before or after the JSON.';
  /* 等价 JSON-only 指令的识别标记：命中即认为请求已自带约束（复用，不再插第二份）。
     含本实现自己的标记（保证 rebuild / retry 幂等）与 IB 现有 consumer 的措辞。 */
  var JSON_ONLY_MARKS = [
    'Return exactly one valid JSON object.',
    '只输出一个 JSON',
    '只返回一个 JSON',
    '仅输出一个 JSON',
    '输出严格 JSON'
  ];

  function _contentTextOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : String(content);
    return content.map(function (p) { return (p && typeof p.text === 'string') ? p.text : ''; }).join('\n');
  }
  function _hasJsonOnlyInstruction(system, messages) {
    var hay = String(system || '');
    for (var i = 0; i < messages.length; i++) hay += '\n' + _contentTextOf(messages[i] && messages[i].content);
    for (var j = 0; j < JSON_ONLY_MARKS.length; j++) { if (hay.indexOf(JSON_ONLY_MARKS[j]) !== -1) return true; }
    return false;
  }
  /* 把 JSON 意图写进最后一条 user 消息（无 user 消息时追加一条）。
     纯函数：不改入参数组 / 不重复注入（同一约束已存在时原样返回）。 */
  function _appendJsonOnlyConstraint(system, messages) {
    var list = Array.isArray(messages) ? messages : [];
    if (_hasJsonOnlyInstruction(system, list)) return list;
    var idx = -1;
    for (var i = list.length - 1; i >= 0; i--) { if (list[i] && list[i].role === 'user') { idx = i; break; } }
    if (idx < 0) return list.concat([{ role: 'user', content: JSON_ONLY_CONSTRAINT }]);
    var msg = list[idx];
    var content = msg.content;
    var next = list.slice();
    if (typeof content === 'string') {
      next[idx] = { role: msg.role, content: content ? (content + '\n\n' + JSON_ONLY_CONSTRAINT) : JSON_ONLY_CONSTRAINT };
    } else if (Array.isArray(content)) {
      next[idx] = { role: msg.role, content: content.concat([{ type: 'text', text: JSON_ONLY_CONSTRAINT }]) };
    } else {
      next[idx] = { role: msg.role, content: JSON_ONLY_CONSTRAINT };
    }
    return next;
  }

  /* ── P21 · reasoning capability 读取（唯一真源 = provider-directory.js）────────
     canonical 档位 auto/low/medium/high/max 的能力事实（字段名、支持值、预算表）只存在于
     provider-directory.js；本文件只做两件事：向它要一份**纯计划**，然后按计划写 body。
     宿主只传了裸 PROVIDERS 表（无 P21 函数）时返回 capability_unavailable → 一律 abstain
     （不发参数），绝不退化成"在 adapter 里猜一家 provider 的字段名"。 */
  function normalizeReasoningTier(v) {
    if (CANON && typeof CANON.normalizeReasoningTier === 'function') return CANON.normalizeReasoningTier(v);
    var s = (v == null ? '' : String(v)).trim().toLowerCase();
    if (s === 'xhigh') return 'high';
    return (s === 'low' || s === 'medium' || s === 'high' || s === 'max') ? s : 'auto';
  }
  function reasoningCapability(provider, model) {
    if (CANON && typeof CANON.reasoningCapability === 'function') return CANON.reasoningCapability(provider, model);
    return null;
  }
  function reasoningWirePlan(spec) {
    spec = spec || {};
    if (CANON && typeof CANON.reasoningWirePlan === 'function') return CANON.reasoningWirePlan(spec);
    return { requested: normalizeReasoningTier(spec.effort), effective: 'auto', wirePath: [], value: undefined, fallbackReason: 'capability_unavailable', capability: null };
  }

  /* ── P21 · reasoning trace（只读观测环 · telemetry）────────────────────────
     用途：让「requested effort → effective effort → 真实 wire 参数 → 实际 reasoning tokens」
     可对比（Diagnostics / 测试共用同一份证据）。记录字段名固定为：
       requestedReasoningEffort / effectiveReasoningEffort / reasoningWireParam /
       reasoningFallbackReason（+ reasoningTokens 回填位）。
     硬约束：白名单构造，只含 provider/model/format/consumer + 四个 reasoning 字段 + token 数 +
     时间；**不含** prompt、消息、请求体、Authorization、apiKey；容量固定、只驻内存、绝不落盘。
     RCI-1：除 provider/model/format/consumer 外，再记**调用身份** characterId / threadId
     （「谁为什么发出这次调用」）。provider/model 只说明"走了哪条通道"：
     **同 provider + 同 model 绝不能用来推断属于同一个 consumer** —— 并发的日记与角色私信
     可以共用同一个 provider/model，只有 consumer/characterId/threadId 能把它们分开。
     身份一律由调用方在自己的执行上下文里传入（拿不到就写 ''），
     绝不从 prompt 解析、绝不从 model/provider 反推角色。 */
  var REASONING_TRACE_MAX = 100;
  var _reasoningTrace = [];
  function _reasoningTracePush(rec) {
    try { _reasoningTrace.push(rec); if (_reasoningTrace.length > REASONING_TRACE_MAX) _reasoningTrace.shift(); } catch (e) { /* ignore */ }
    return rec;
  }
  /* 实际 reasoning tokens 回填：优先挂到最近一条**同一次调用**（consumer/provider/model 匹配）
     且还没有该字段的计划记录上；匹配不到则单独记一条（只含计量，不含任何请求内容）。
     并发下不会把 A 请求的 token 记到 B 请求上：不匹配就退化为独立计量记录。 */
  function noteReasoningTokens(tokens, meta) {
    var n = Number(tokens);
    if (!isFinite(n) || n < 0) return null;
    var count = Math.max(0, Math.floor(n));
    var m = meta || {};
    var wantConsumer = (m.consumer == null ? '' : String(m.consumer));
    var wantProvider = (m.provider == null ? '' : String(m.provider));
    var wantModel = (m.model == null ? '' : String(m.model));
    /* RCI-1：调用身份参与配对 —— 并发下同 provider/model 的两个 consumer（或同 consumer 的
       两个角色）各自拿回自己的 token 数，不会把 A 角色的用量挂到 B 的记录上。
       未提供身份键时行为与 RCI-1 之前逐位一致（不新增匹配条件）。 */
    var wantCharacter = (m.characterId == null ? '' : String(m.characterId));
    var wantThread = (m.threadId == null ? '' : String(m.threadId));
    for (var i = _reasoningTrace.length - 1; i >= 0; i--) {
      var rec = _reasoningTrace[i];
      if (rec.reasoningTokens != null) continue;
      if (m.consumer != null && rec.consumer !== wantConsumer) continue;
      if (m.provider != null && rec.provider !== wantProvider) continue;
      if (m.model != null && rec.model !== wantModel) continue;
      if (m.characterId != null && rec.characterId !== wantCharacter) continue;
      if (m.threadId != null && rec.threadId !== wantThread) continue;
      rec.reasoningTokens = count;
      return rec;
    }
    return _reasoningTracePush({
      at: Date.now(), consumer: wantConsumer, characterId: wantCharacter, threadId: wantThread,
      provider: wantProvider, model: wantModel, format: '',
      requestedReasoningEffort: '', effectiveReasoningEffort: '', reasoningWireParam: '',
      reasoningFallbackReason: '', reasoningTokens: count
    });
  }
  function reasoningTrace(n) {
    var k = Math.max(1, Math.min(REASONING_TRACE_MAX, Number(n) || 5));
    return _reasoningTrace.slice(-k);
  }
  function reasoningTraceReset() { _reasoningTrace.length = 0; }

  /* ── Turn Trace · bounded, in-memory event view ───────────────────────
     Keep the Work Run event vocabulary (sequence / eventType / status /
     reasonCode / createdAt) while keeping Chat turns out of work_runs: that
     store is authority-bound to Work Mode run/consent state. Only metrics and
     stable identities enter this ring; no prompt, message, memory text, tool
     arguments, endpoint, or credential is accepted by the field whitelist. */
  var TURN_TRACE_MAX = 40;
  var TURN_TRACE_EVENT_MAX = 48;
  var TURN_TRACE_EVENT_TYPES = Object.freeze([
    'input', 'context', 'memory', 'middle_brain', 'model_call_started',
    'model_call_retry', 'model_call_finished', 'tool_execution', 'tool_guard', 'result'
  ]);
  var TURN_TRACE_EVENT_FIELDS = Object.freeze([
    'inputMessages', 'inputChars', 'attachmentCount', 'contextMessages', 'contextChars', 'contextTokens',
    'systemChars', 'tailChars', 'memoryState', 'memoryChars', 'memoryItems',
    'memoryAuthority', 'mbSource', 'mbInjected', 'provider', 'model', 'format',
    'attempt', 'latencyMs', 'retryDelayMs', 'retryCount', 'httpStatus', 'errorCategory',
    'finishReason', 'truncated', 'toolName', 'toolCount', 'toolStatus', 'toolCalls',
    'toolRounds', 'guardTripped', 'guardReason', 'guardEvents', 'resultChars',
    'assistantMessages', 'reasonCode', 'status'
  ]);
  var _turnTraceRing = [];
  var _turnTraceById = Object.create(null);
  var _turnTraceSeq = 0;

  function _traceText(value, limit) {
    return String(value == null ? '' : value).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit || 100);
  }
  function _traceNumber(value) {
    var n = Number(value);
    return isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  function turnTraceBegin(meta) {
    meta = meta || {};
    var traceId = 'turn_' + Date.now().toString(36) + '_' + (++_turnTraceSeq).toString(36);
    var rec = {
      traceId: traceId,
      consumer: _traceText(meta.consumer, 40),
      characterId: _traceText(meta.characterId, 100),
      threadId: _traceText(meta.threadId, 120),
      turnId: _traceText(meta.turnId, 120),
      startedAt: Date.now(), completedAt: null, status: 'active',
      nextSequence: 1, events: []
    };
    _turnTraceById[traceId] = rec;
    return traceId;
  }
  function turnTraceEvent(traceId, eventType, fields) {
    var rec = _turnTraceById[String(traceId || '')];
    var type = String(eventType || '');
    if (!rec || TURN_TRACE_EVENT_TYPES.indexOf(type) < 0) return null;
    fields = fields || {};
    var event = {
      sequence: rec.nextSequence++, eventType: type,
      fromStatus: rec.events.length ? String(rec.events[rec.events.length - 1].eventType) : 'active',
      toStatus: type, version: rec.nextSequence - 1,
      reasonCode: fields.reasonCode == null ? null : _traceText(fields.reasonCode, 64),
      createdAt: Date.now()
    };
    TURN_TRACE_EVENT_FIELDS.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(fields, key) || key === 'reasonCode') return;
      var value = fields[key];
      if (key === 'guardEvents') {
        event[key] = Array.isArray(value) ? value.slice(0, 16).map(function (v) { return _traceText(v, 32); }) : [];
      } else if (typeof value === 'boolean') event[key] = value;
      else if (typeof value === 'number') event[key] = _traceNumber(value);
      else if (value != null) event[key] = _traceText(value, key === 'toolName' ? 80 : 100);
    });
    rec.events.push(event);
    if (rec.events.length > TURN_TRACE_EVENT_MAX) rec.events.shift();
    return Object.assign({}, event);
  }
  function turnTraceFinish(traceId, status, fields) {
    var rec = _turnTraceById[String(traceId || '')];
    if (!rec) return null;
    if (rec.completedAt == null) {
      var finalFields = Object.assign({}, fields || {}, { status: _traceText(status || 'completed', 32) });
      turnTraceEvent(traceId, 'result', finalFields);
      rec.status = finalFields.status;
      rec.completedAt = Date.now();
      _turnTraceRing.push(rec);
      while (_turnTraceRing.length > TURN_TRACE_MAX) {
        var expired = _turnTraceRing.shift();
        if (expired && expired.traceId) delete _turnTraceById[expired.traceId];
      }
    }
    return _turnTraceClone(rec);
  }
  function _turnTraceClone(rec) {
    return {
      traceId: rec.traceId, consumer: rec.consumer, characterId: rec.characterId,
      threadId: rec.threadId, turnId: rec.turnId, startedAt: rec.startedAt,
      completedAt: rec.completedAt, status: rec.status,
      events: rec.events.map(function (event) { return Object.assign({}, event, { guardEvents: event.guardEvents ? event.guardEvents.slice() : undefined }); })
    };
  }
  function turnTraceRecent(n, traceId) {
    var k = Math.max(1, Math.min(TURN_TRACE_MAX, Number(n) || 10));
    var list = _turnTraceRing.slice();
    Object.keys(_turnTraceById).forEach(function (id) {
      var rec = _turnTraceById[id];
      if (rec && rec.completedAt == null) list.push(rec);
    });
    list.sort(function (a, b) { return a.startedAt - b.startedAt; });
    if (traceId != null) list = list.filter(function (rec) { return rec.traceId === String(traceId); });
    return list.slice(-k).map(_turnTraceClone);
  }
  function turnTraceReset() {
    _turnTraceRing.length = 0;
    _turnTraceById = Object.create(null);
  }

  function _setByPath(body, path, value) {
    var o = body;
    for (var i = 0; i < path.length - 1; i++) {
      var k = path[i];
      if (!o[k] || typeof o[k] !== 'object') o[k] = {};
      o = o[k];
    }
    o[path[path.length - 1]] = value;
  }

  /* provider adapter / request builder 边界的**唯一**翻译器：
     canonical reasoningEffort → 该 provider/model/format 的真实 wire 字段。
     · auto / 未取证 provider / 该 format 不支持 / 档位无法表达 → 一个字段都不写，body 保持原样；
     · 写字段时只按 provider-directory.js 的官方支持值／预算表，不在本文件里出现任何 provider 名判断。
     返回 plan（供 telemetry / trace / 测试断言）；永不抛错。 */
  function applyReasoningEffort(body, spec, options) {
    options = options || {};
    if (!body || typeof body !== 'object') return null;
    var s = spec || {};
    var wirePlan = reasoningWirePlan({
      provider: s.provider, model: s.model,
      format: options.format, effort: options.effort, maxTokens: options.maxTokens
    });
    try {
      if (wirePlan && wirePlan.value !== undefined && wirePlan.wirePath && wirePlan.wirePath.length) _setByPath(body, wirePlan.wirePath, wirePlan.value);
    } catch (e) { /* 写字段失败绝不影响请求：body 保持已构建的内容 */ }
    /* telemetry 记录字段名即要求 9 的四要素（+ 实际 reasoning tokens 回填位）：
       requestedReasoningEffort / effectiveReasoningEffort / reasoningWireParam / reasoningFallbackReason。 */
    _reasoningTracePush({
      at: Date.now(),
      consumer: String(options.consumer || ''),
      /* RCI-1：调用身份（谁发出的这次调用）。两个都不是 wire 字段，只进这条内存记录；
         调用方没传 → ''（不猜、不从 prompt 解析、不从 model/provider 反推角色）。 */
      characterId: String(options.characterId || ''),
      threadId: String(options.threadId || ''),
      provider: String(s.provider == null ? '' : s.provider),
      model: String(s.model == null ? '' : s.model),
      format: String(options.format == null ? '' : options.format),
      requestedReasoningEffort: wirePlan ? wirePlan.requested : 'auto',
      effectiveReasoningEffort: wirePlan ? wirePlan.effective : 'auto',
      reasoningWireParam: (wirePlan && wirePlan.wirePath && wirePlan.wirePath.length) ? wirePlan.wirePath.join('.') : '',
      reasoningFallbackReason: (wirePlan && wirePlan.fallbackReason) || '',
      reasoningTokens: null
    });
    return wirePlan;
  }

  /* 内容 part 适配（提取自 active/model-client.js adaptMessageParts） */
  function adaptMessageParts(fmt, content) {
    if (typeof content === 'string' || !Array.isArray(content)) return content;
    return content.map(function (p) {
      if (p && p.type === '_image' && p.base64) {
        if (fmt === 'anthropic') return { type: 'image', source: { type: 'base64', media_type: p.mime || 'image/jpeg', data: p.base64 } };
        if (fmt === 'gemini') return { inlineData: { mimeType: p.mime || 'image/jpeg', data: p.base64 } };
        return { type: 'image_url', image_url: { url: 'data:' + (p.mime || 'image/jpeg') + ';base64,' + p.base64 } };
      }
      return { type: 'text', text: String((p && p.text) || '') };
    });
  }
  /* gemini content → parts（提取自 model-client.js geminiParts） */
  function geminiParts(content) {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: String(content || '') }];
    return adaptMessageParts('gemini', content);
  }

  /* 归一 prompt -> {system, messages}
     Node 形态: {system, messages}；Browser 形态: 纯 messages 数组（system 取 spec.systemPrompt 或首条 system 消息） */
  function _prompt(prompt, spec) {
    if (prompt && prompt.messages && (prompt.system !== undefined || Array.isArray(prompt.messages))) {
      return { system: prompt.system || '', messages: prompt.messages };
    }
    if (Array.isArray(prompt)) {
      var sys = (spec && spec.systemPrompt) ? String(spec.systemPrompt) : '';
      var msgs = [];
      for (var i = 0; i < prompt.length; i++) {
        if (prompt[i] && prompt[i].role === 'system') { if (!sys) sys = String(prompt[i].content || ''); }
        else msgs.push(prompt[i]);
      }
      return { system: sys, messages: msgs };
    }
    return { system: '', messages: [] };
  }

  /* ── P23 Phase 2A · canonical history → provider wire 的**唯一**归一入口 ──────
     为什么需要：canonical 存储里**允许**出现相邻同 role 的行 ——
       · 一次模型回合交付多条 assistant 消息（waifu 多段呈现 / 工具续轮）；
       · 用户连发、以及非 user/assistant 的 canonical 行在对话映射里落到 user。
     这就是 "Storage truth ≠ Wire representation"：数据库里它们必须是独立消息
     （P23 2A 不变量 1/11），但部分 provider 的 wire format **要求 user/assistant
     交替** —— Gemini 的 contents 收到两个连续的 model 轮是非法请求。
     因此合一只发生在这段边界上，且只有一份实现：
       · Node   : buildRequestBody 调用它（Home Node 执行器走同一函数）；
       · Browser: callApiChat / callApiChatStream 的 gemini 分支调用它。
     规则：
       · ALTERNATION_FORMATS（当前 = ['gemini']）以外的 format **原样返回** ——
         OpenAI 接受相邻同 role；Anthropic 的 Messages API 自己合并相邻轮；
         两者都不是本函数要改的行为，改了就是无理由的行为变更；
       · 只合并 role 相同且**相邻**的行：字符串用 '\n\n' 连接，parts 数组拼接；
         绝不丢内容、绝不改顺序、绝不改 role；
       · 带原生工具协议字段（tool_calls / tool_call_id）的行不参与合并 ——
         合并会把工具调用与普通文本糊成一条，破坏协议；
       · 绝不改动入参（返回新数组 + 新对象），且这是**读侧**变换：
         数据库里的独立消息一条都不动。
     返回新数组（元素也是新对象）。 */
  var ALTERNATION_FORMATS = ['gemini'];
  function _wireJoinContent(a, b) {
    if (typeof a === 'string' && typeof b === 'string') return a + '\n\n' + b;
    var toParts = function (c) {
      if (Array.isArray(c)) return c.slice();
      return [{ type: 'text', text: String(c == null ? '' : c) }];
    };
    return toParts(a).concat(toParts(b));
  }
  function _wireHasProtocolFields(m) {
    return !!(m && (m.tool_calls !== undefined || m.tool_call_id !== undefined));
  }
  function normalizeWireRoles(messages, format) {
    var list = Array.isArray(messages) ? messages : [];
    if (ALTERNATION_FORMATS.indexOf(String(format == null ? '' : format)) < 0) return list.slice();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m !== 'object') continue;
      var last = out.length ? out[out.length - 1] : null;
      if (last && last.role === m.role && !_wireHasProtocolFields(last) && !_wireHasProtocolFields(m)) {
        last.content = _wireJoinContent(last.content, m.content);
        continue;
      }
      var copy = { role: m.role, content: m.content };
      if (m.tool_calls !== undefined) copy.tool_calls = m.tool_calls;
      if (m.tool_call_id !== undefined) copy.tool_call_id = m.tool_call_id;
      if (m.name !== undefined) copy.name = m.name;
      out.push(copy);
    }
    return out;
  }

  /* ── P20 · canonical prompt → Anthropic wire 归一（Browser / Node 唯一真源）──────
     IB canonical 输入**允许**出现 system 消息。consumer 的常见形态是「顶层 system 与
     messages 首条 system 同时给同一段文本」，例如：
       { system: '角色设定', messages: [{role:'system',content:'角色设定'},{role:'user',content:'你好'}] }
     这是合法的 IB 内部表示；**provider adapter 负责**把它转成各家的 wire format，
     不能靠"禁止 consumer 产生 system"来解决。

     Anthropic 的 messages 只接受 user / assistant，system 必须放在顶层 system 字段。
     本函数是这条归一的唯一实现（浏览器经 window.IBModelCore 调用同一函数，Node 由
     buildRequestBody 调用同一函数）——禁止在别处复制第二份。

     规则（Browser / Node 逐位一致）：
       ① 候选文本顺序 = 顶层 system（{system,messages} 形态）→ 随后按出现顺序的 messages system；
       ② 完全相同（忽略首尾空白）的文本只保留一次 —— consumer 普遍把同一段 system 同时放进
          两处，去重后与 P20 之前的浏览器语义逐位相同，不会把角色设定送两遍；
       ③ 不同文本用 '\n\n' 连接（稳定分隔符，绝不 join('')）；顺序稳定，多条 system 不丢；
       ④ 都没解析到时回落到 spec.systemPrompt（与 _prompt 的数组形态一致）；
       ⑤ messages 只保留非 system 项（逐条浅拷贝，**绝不改动入参对象**）；
       ⑥ 无法映射的 role **不静默删除**（保留原样，由 provider 判定并报错），
          只记入 unmappedRoles 供诊断使用。
     返回 {system, messages, systemParts, unmappedRoles, extractedSystems}。 */
  var ANTHROPIC_SYSTEM_SEPARATOR = '\n\n';

  /* system content → 文本。canonical 契约里 system 是 string；此处对 block 数组 /
     {text} 形态做最小安全兼容，**绝不用 String(content)**（否则会变 [object Object]）。 */
  function _systemText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var texts = [];
      for (var i = 0; i < content.length; i++) {
        var p = content[i];
        if (typeof p === 'string') { if (p) texts.push(p); }
        else if (p && typeof p.text === 'string') { if (p.text) texts.push(p.text); }
      }
      return texts.join('\n');
    }
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  }

  function normalizeAnthropicMessages(prompt, spec) {
    var raw = [];
    var base = '';
    if (prompt && prompt.messages && (prompt.system !== undefined || Array.isArray(prompt.messages))) {
      base = _systemText(prompt.system);
      raw = Array.isArray(prompt.messages) ? prompt.messages : [];
    } else if (Array.isArray(prompt)) {
      raw = prompt;
    }
    if (!base) base = _systemText(spec && spec.systemPrompt);

    var parts = [], seen = {};
    function _collect(text) {
      if (!text) return;
      var key = String(text).replace(/^\s+/, '').replace(/\s+$/, '');
      if (!key || seen[key]) return;
      seen[key] = true;
      parts.push(text);
    }
    _collect(base);

    var messages = [], unmapped = [], extracted = 0;
    for (var j = 0; j < raw.length; j++) {
      var m = raw[j];
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'system') { extracted++; _collect(_systemText(m.content)); continue; }
      messages.push(Object.assign({}, m));   /* 浅拷贝：调用方数组与其元素对象都不被改动 */
      if (m.role !== 'user' && m.role !== 'assistant') {
        var label = String(m.role);
        if (unmapped.indexOf(label) < 0) unmapped.push(label);
      }
    }
    return {
      system: parts.join(ANTHROPIC_SYSTEM_SEPARATOR),
      messages: messages,
      systemParts: parts,
      unmappedRoles: unmapped,
      extractedSystems: extracted
    };
  }

  /* P20 · Anthropic wire invariant 诊断（纯函数，不抛错）：
     messages 必须是数组、不得残留 system（developer 同样非法）、model 必须存在、
     system 只能是 string 或 block 数组。用于测试与诊断 seam；
     生产路径**不**据此抛错（IB 没有 body 级 fail-fast 契约，不能为一个诊断断言炸掉用户请求）。 */
  function validateAnthropicRequestBody(body) {
    if (!body || typeof body !== 'object') return { ok: false, problems: ['body-not-object'] };
    var problems = [];
    var list = body.messages;
    if (!Array.isArray(list)) problems.push('messages-not-array');
    else {
      for (var i = 0; i < list.length; i++) {
        var role = list[i] && list[i].role;
        if (role === 'system' || role === 'developer') problems.push('system-role-in-messages');
        else if (role !== 'user' && role !== 'assistant') problems.push('unmapped-role:' + String(role));
      }
    }
    if (body.model === undefined || body.model === null || body.model === '') problems.push('missing-model');
    if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) problems.push('system-not-string');
    return { ok: problems.length === 0, problems: problems };
  }

  /* 构建 provider-specific request body（纯；transport 的 endpoint/headers 由调用方处理）
     spec: {provider, model, format?, temperature?, systemPrompt?}
     prompt: {system, messages} | messages[]
     options: {jsonMode, jsonPrefill, maxTokens, temperature?} */
  function buildRequestBody(spec, prompt, options) {
    options = options || {};
    var fmt = (spec && (spec.format || providerFormat(spec.provider))) || 'openai';
    var model = spec && spec.model;
    var maxTokens = (options.maxTokens != null ? options.maxTokens : 512);
    var temperature = (options.temperature != null) ? options.temperature : (spec && spec.temperature != null ? spec.temperature : null);
    var pres = _prompt(prompt, spec);
    var system = pres.system, messages = pres.messages;

    if (fmt === 'anthropic') {
      /* P20：system/messages 归一走唯一真源 normalizeAnthropicMessages（Browser 同一函数）。
         buildRequestBody 只负责把归一后的 canonical messages 适配成 Anthropic content blocks。 */
      var an = normalizeAnthropicMessages(prompt, spec);
      var ab = {
        model: model,
        max_tokens: maxTokens,
        system: an.system,
        messages: an.messages.map(function (m) { return { role: m.role, content: adaptMessageParts('anthropic', m.content) }; })
      };
      if (options.jsonMode) {
        if (modelSupportsAssistantPrefill(model)) {
          var jp = options.jsonPrefill || '{"action":';
          ab.messages = ab.messages.concat([{ role: 'assistant', content: jp }]);
        } else {
          ab.messages = _appendJsonOnlyConstraint(ab.system, ab.messages);
        }
      }
      if (temperature != null && modelSupportsSamplingParameters(model)) ab.temperature = Number(temperature);
      /* P21 · reasoning：canonical reasoningEffort → 能力翻译（auto/未取证 → 一个字段都不写） */
      applyReasoningEffort(ab, spec, { format: 'anthropic', effort: options.reasoningEffort, maxTokens: maxTokens, consumer: options.consumer });
      return ab;
    }
    if (fmt === 'gemini') {
      var gb = {
        system_instruction: { parts: [{ text: system }] },
        /* P23 Phase 2A：Gemini 的 contents 必须 user/model 交替 —— 相邻同 role 在
           这一段边界上合并（唯一实现，见 normalizeWireRoles）。 */
        contents: normalizeWireRoles(messages, 'gemini').map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m.content) }; }),
        generationConfig: { maxOutputTokens: maxTokens }
      };
      if (options.jsonMode) gb.generationConfig.responseMimeType = 'application/json';
      if (temperature != null) gb.generationConfig.temperature = Number(temperature);
      applyReasoningEffort(gb, spec, { format: 'gemini', effort: options.reasoningEffort, maxTokens: maxTokens, consumer: options.consumer });
      return gb;
    }
    /* openai 系（兼容 custom/其余全部） */
    var baseMessages = [{ role: 'system', content: system }].concat(messages.map(function (m) { return { role: m.role, content: adaptMessageParts('openai', m.content) }; }));
    var ob = { model: model, messages: baseMessages, max_tokens: maxTokens };
    if (options.jsonMode) ob.response_format = { type: 'json_object' };
    if (temperature != null) ob.temperature = Number(temperature);
    applyReasoningEffort(ob, spec, { format: 'openai', effort: options.reasoningEffort, maxTokens: maxTokens, consumer: options.consumer });
    return ob;
  }

  /* ── Phase 9 · SSE 流式解析（runtime-neutral，唯一实现）───────────────────
     目标：Node 侧获得真正的增量生成能力，而 provider 的 wire format 解析**只**存在于
     本文件（与 buildRequestBody / parseResponse 同一层），绝不散落进 chat service。

     覆盖的 wire format（与 buildRequestBody 的 providerFormat 三分法一致）：
       · openai   : `data: {choices:[{delta:{content,reasoning_content|reasoning|analysis|thinking}}]}`
       · anthropic: `event: content_block_delta` + `data: {delta:{type:'text_delta'|'thinking_delta'}}`
       · gemini   : `data: {candidates:[{content:{parts:[{text,thought}]}}]}`（真实 SSE，无 data: 前缀）
       · responses: `event: response.output_text.delta` 与 `response.reasoning_summary_text.delta`

     输出事件契约（与 NodeModelPort.run 的 onEvent 同名字段对齐）：
       {type:'delta', kind:'content'|'reasoning', text, index}
       {type:'error', kind, message, status?}
       {type:'error', kind:'provider-stream', message}   ← 服务端在流中回传的错误对象

     容错（硬要求）：
       · 不完整的行留在缓冲里等下一块，绝不丢半个 JSON；
       · 单行 JSON 解析失败 → 丢弃该行并记数，**绝不中断整个流**；
       · 未知事件类型 → 忽略并记数（provider 迭代不会打断生成）；
       · `[DONE]`、空行、`:` 注释行按 SSE 规范跳过。

     返回 {push(chunk), finish(), accumulate(), stats(), error()}。 */
  function createStreamParser(format, onEvent) {
    var fmt = format || 'openai';
    var buf = '';
    var seq = 0;
    var acc = { content: '', reasoning: '', usage: null, truncated: false };
    var stats = { chunks: 0, events: 0, deltas: 0, malformed: 0, unknown: 0, done: false };
    var streamError = null;
    /* anthropic / responses 的块类型是跨行状态（event: 行给出、data: 行消费）。 */
    var pendingEvent = '';

    function emit(event) {
      if (typeof onEvent !== 'function') return;
      try { onEvent(event); } catch (_) { /* consumer 回调异常不得中断解析 */ }
    }
    function emitDelta(kind, text) {
      if (!text) return;
      if (kind === 'reasoning') acc.reasoning += text; else acc.content += text;
      stats.deltas++;
      emit({ type: 'delta', kind: kind, text: text, index: seq++ });
    }
    function noteUsage(usage, usageFormat) {
      if (!usage || typeof usage !== 'object') return;
      var u = null;
      if (usageFormat === 'gemini') {
        u = { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 };
        var rtg = reasoningTokensFromUsage(usage, 'gemini');
        if (rtg != null) u.reasoning_tokens = rtg;
      } else if (usageFormat === 'anthropic') {
        /* Anthropic 把 usage **拆成两条事件**：message_start 给 input_tokens，
           message_delta 只给 output_tokens。因此这里只能写入**真实出现过**的字段 ——
           若照抄 0 兜底，第二次合并会用 input_tokens:0 覆盖掉第一次的真实值。
           （openai/gemini 的 usage 是单条完整对象，零兜底不影响正确性。） */
        u = {};
        if (usage.input_tokens != null) u.input_tokens = usage.input_tokens || 0;
        if (usage.output_tokens != null) u.output_tokens = usage.output_tokens || 0;
        if (usage.cache_read_input_tokens != null) u.cache_read_input_tokens = usage.cache_read_input_tokens || 0;
        if (usage.cache_creation_input_tokens != null) u.cache_creation_input_tokens = usage.cache_creation_input_tokens || 0;
        if (!Object.keys(u).length) return;
      } else if (usageFormat === 'responses') {
        u = {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens != null ? usage.total_tokens : ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
          input_tokens_details: usage.input_tokens_details || null,
          output_tokens_details: usage.output_tokens_details || null
        };
        var rtr = reasoningTokensFromUsage(usage, 'responses');
        if (rtr != null) u.reasoning_tokens = rtr;
      } else {
        u = { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0 };
        var rto = reasoningTokensFromUsage(usage, 'openai');
        if (rto != null) u.reasoning_tokens = rto;
      }
      /* 后到的 usage 覆盖先到的（OpenAI 只在最后一个 chunk 给 usage；
         Anthropic 的 message_start 与 message_delta 各给一半 → 合并而非覆盖）。 */
      acc.usage = acc.usage ? Object.assign({}, acc.usage, u) : u;
    }

    function handleOpenAI(wire) {
      if (wire && wire.usage) noteUsage(wire.usage, 'openai');
      if (wire && wire.error) {
        streamError = String((wire.error && wire.error.message) || wire.error);
        emit({ type: 'error', kind: 'provider-stream', message: streamError });
        return;
      }
      var choice = (wire && wire.choices && wire.choices[0]) || null;
      if (!choice) return;
      var delta = choice.delta || choice.message || null;
      if (delta) {
        var reasoning = delta.reasoning_content != null ? delta.reasoning_content
          : (delta.reasoning != null ? delta.reasoning : (delta.analysis != null ? delta.analysis : delta.thinking));
        if (typeof reasoning === 'string') {
          /* openai 系的 reasoning_content 是逐块给的；不支持流式 reasoning 的 format
             只会给终值 → 此时不 emit delta，只保留在 acc 里（finish 仍返回它）。 */
          if (streamsReasoning(fmt)) emitDelta('reasoning', reasoning);
          else if (!acc.reasoning) acc.reasoning = reasoning;
        }
        var content = delta.content;
        if (Array.isArray(content)) content = content.map(function (p) { return (p && (p.text || p.content)) || ''; }).join('');
        if (typeof content === 'string') emitDelta('content', content);
      }
      if (choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens') acc.truncated = true;
    }

    function handleAnthropic(wire) {
      var type = (wire && wire.type) || pendingEvent;
      if (type === 'error') {
        streamError = String((wire && wire.error && wire.error.message) || 'stream error');
        emit({ type: 'error', kind: 'provider-stream', message: streamError });
        return;
      }
      if (type === 'message_start' && wire && wire.message && wire.message.usage) noteUsage(wire.message.usage, 'anthropic');
      if (type === 'message_delta') {
        if (wire && wire.usage) noteUsage(wire.usage, 'anthropic');
        if (wire && wire.delta && (wire.delta.stop_reason === 'max_tokens')) acc.truncated = true;
        return;
      }
      if (type === 'content_block_delta' && wire && wire.delta) {
        var d = wire.delta;
        if (d.type === 'text_delta' && typeof d.text === 'string') emitDelta('content', d.text);
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') emitDelta('reasoning', d.thinking);
        else if (typeof d.text === 'string') emitDelta('content', d.text);
        return;
      }
      /* message_stop / content_block_start / content_block_stop / ping：无正文，忽略 */
    }

    function handleGemini(wire) {
      if (wire && wire.error) {
        streamError = String((wire.error && wire.error.message) || wire.error);
        emit({ type: 'error', kind: 'provider-stream', message: streamError });
        return;
      }
      if (wire && wire.usageMetadata) noteUsage(wire.usageMetadata, 'gemini');
      var cand = (wire && wire.candidates && wire.candidates[0]) || null;
      if (!cand) return;
      var parts = (cand.content && cand.content.parts) || [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p) continue;
        if (p.thought) emitDelta('reasoning', typeof p.text === 'string' ? p.text : '');
        else if (typeof p.text === 'string') emitDelta('content', p.text);
      }
      if (cand.finishReason === 'MAX_TOKENS' || /max_tokens/i.test(String(cand.finishReason || ''))) acc.truncated = true;
    }

    function handleResponses(wire) {
      var type = (wire && wire.type) || pendingEvent;
      if (type === 'error' || (wire && wire.error)) {
        streamError = String((wire && wire.error && wire.error.message) || 'stream error');
        emit({ type: 'error', kind: 'provider-stream', message: streamError });
        return;
      }
      if (type === 'response.output_text.delta' && typeof wire.delta === 'string') { emitDelta('content', wire.delta); return; }
      if (type === 'response.reasoning_summary_text.delta' && typeof wire.delta === 'string') { emitDelta('reasoning', wire.delta); return; }
      /* response.completed 携带最终 usage（若 provider 给） */
      if (type === 'response.completed' && wire.response && wire.response.usage) noteUsage(wire.response.usage, 'responses');
      if (type === 'response.incomplete') acc.truncated = true;
    }

    function handleLine(line) {
      if (!line) return;
      if (line.charAt(0) === ':') return;                 /* SSE 注释/心跳 */
      if (line.indexOf('event:') === 0) { pendingEvent = line.slice(6).trim(); return; }
      if (line.indexOf('data:') === 0) {
        var data = line.slice(5).trim();
        if (!data) return;
        if (data === '[DONE]') { stats.done = true; pendingEvent = ''; return; }
        var wire = null;
        try { wire = JSON.parse(data); }
        catch (e) { stats.malformed++; return; }          /* 容错：丢弃该行，绝不中断 */
        stats.events++;
        if (fmt === 'anthropic') handleAnthropic(wire);
        else if (fmt === 'gemini') handleGemini(wire);
        else if (fmt === 'responses') handleResponses(wire);
        else handleOpenAI(wire);
        pendingEvent = '';
        return;
      }
      /* 裸 JSON 行（Gemini 的真实 SSE 不带 data: 前缀） */
      var trimmed = line.trim();
      if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
        var bare = null;
        try { bare = JSON.parse(trimmed); }
        catch (e) { stats.malformed++; return; }
        stats.events++;
        if (fmt === 'gemini') handleGemini(bare);
        else if (fmt === 'openai') handleOpenAI(bare);
        return;
      }
      stats.unknown++;
    }

    function push(chunk) {
      if (chunk == null) return;
      stats.chunks++;
      buf += String(chunk);
      for (;;) {
        var nl = buf.indexOf('\n');
        if (nl < 0) break;
        var line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
        handleLine(line);
      }
    }

    /* finish()：处理最后一行（无尾换行的合法情况）并返回累积结果。
       与 parseResponse 的返回形状一致，因此调用方可以无差别地处理流式/非流式。 */
    function finish() {
      if (buf) { var tail = buf; buf = ''; handleLine(tail.charAt(tail.length - 1) === '\r' ? tail.slice(0, -1) : tail); }
      if (!acc.truncated) { /* 留待 provider 的 finish_reason 判定 */ }
      return {
        content: acc.content,
        reasoning: acc.reasoning,
        truncated: acc.truncated,
        usage: acc.usage,
        streamError: streamError,
        stats: stats
      };
    }

    return { push: push, finish: finish, stats: function () { return stats; }, error: function () { return streamError; } };
  }

  /* 该 format 的推理内容是否真的以**增量**形式出现在流里。
     openai 系（DeepSeek 等）的 reasoning_content 逐块给；anthropic 有 thinking_delta；
     gemini 有 thought part；responses 有 reasoning_summary_text.delta。
     唯一没有流式 reasoning 的是「宿主自己声明 format 未知」的裸表兜底情形（format 会
     落到 'openai'，因此实际恒为 true）——保留这个判定是为了让未来新增 format 时
     有一个显式的、可测试的位置，而不是默默把终值当增量。 */
  function streamsReasoning(format) {
    return format === 'openai' || format === 'anthropic' || format === 'gemini' || format === 'responses';
  }

  /* 解析 provider-specific response → {content, reasoning, truncated, usage}
     spec: {provider, format?} */
  /* P21 · 实际 reasoning tokens 读取（唯一实现）：是"观测值"而不是新计量口径 ——
     只在 provider 真的回传时返回数字，读不到就返回 null（绝不伪造成 0）。
     · OpenAI 兼容：usage.completion_tokens_details.reasoning_tokens
     · Responses  ：usage.output_tokens_details.reasoning_tokens
     · Gemini     ：usageMetadata.thoughtsTokenCount
     · Anthropic  ：thinking tokens 已包含在 output_tokens 内，无独立字段 → null */
  function reasoningTokensFromUsage(usage, format) {
    if (!usage || typeof usage !== 'object') return null;
    function num(v) { var n = Number(v); return (isFinite(n) && n >= 0) ? Math.floor(n) : null; }
    if (format === 'gemini') {
      return num(usage.thoughtsTokenCount != null ? usage.thoughtsTokenCount : usage.thoughts_token_count);
    }
    var details = usage.completion_tokens_details || usage.output_tokens_details || null;
    if (details && details.reasoning_tokens != null) return num(details.reasoning_tokens);
    if (usage.reasoning_tokens != null) return num(usage.reasoning_tokens);
    return null;
  }

  function parseResponse(wire, spec, options) {
    options = options || {};
    var fmt = (spec && (spec.format || providerFormat(spec.provider))) || 'openai';
    var out = { content: '', reasoning: '', truncated: false, usage: null };
    if (!wire) return out;

    if (fmt === 'anthropic') {
      var blocks = Array.isArray(wire.content) ? wire.content : [];
      out.content = blocks.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text || ''; }).join('');
      out.reasoning = blocks.filter(function (b) { return b && b.type === 'thinking'; }).map(function (b) { return b.thinking || b.text || ''; }).join('\n');
      out.truncated = (wire.stop_reason === 'max_tokens');
      if (wire.usage) out.usage = { input_tokens: wire.usage.input_tokens || 0, output_tokens: wire.usage.output_tokens || 0 };
      return out;
    }
    if (fmt === 'gemini') {
      var cand = (wire.candidates && wire.candidates[0]) || {};
      var parts = (cand.content && cand.content.parts) || [];
      out.content = parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
      out.reasoning = parts.filter(function (p) { return p.thought; }).map(function (p) { return p.text || ''; }).join('\n');
      out.truncated = cand.finishReason === 'MAX_TOKENS' || /max_tokens/i.test(String(cand.finishReason || ''));
      if (wire.usageMetadata) {
        out.usage = { input_tokens: wire.usageMetadata.promptTokenCount || 0, output_tokens: wire.usageMetadata.candidatesTokenCount || 0 };
        var _rtg = reasoningTokensFromUsage(wire.usageMetadata, 'gemini');
        if (_rtg != null) out.usage.reasoning_tokens = _rtg;
      }
      return out;
    }
    var choice = (wire.choices && wire.choices[0]) || {};
    var message = choice.message || {};
    out.content = (message.content == null ? '' : message.content);
    out.reasoning = message.reasoning_content || message.reasoning || message.analysis || message.thinking || '';
    out.truncated = choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens';
    if (wire.usage) {
      out.usage = { prompt_tokens: wire.usage.prompt_tokens || 0, completion_tokens: wire.usage.completion_tokens || 0 };
      var _rto = reasoningTokensFromUsage(wire.usage, 'openai');
      if (_rto != null) out.usage.reasoning_tokens = _rto;
    }
    return out;
  }

  /* ── GPT-6 Astra 最小适配层（runtime-neutral，无 DOM）──
     Astra 走 OpenAI-compatible wire（format='openai'），因此 request/response 归一直接复用
     buildRequestBody / parseResponse。此处抽出独立的 AstraAdapter 作为**干净的中间件接口**：
     - isAstra(spec)：判断提供者是否为 Astra（provider 名或 format 标记）
     - buildRequest / parseResponse：委托给通用 openai 归一，字段保持独立可替换
     - normalizePrompt：统一 {system, messages} 入口（与 Middle Brain 后续接管的形状一致）
     目的：让 Astra 后续可以作为独立 middleware 调用，不改动其它 provider 的既有行为。 */
  function _isAstra(spec) {
    if (!spec) return false;
    var provider = String((spec.provider || '')).toLowerCase();
    var model = String((spec.model || '')).toLowerCase();
    return provider === 'astra' || provider === 'gpt-6' || /gpt-6|astra/.test(model);
  }
  var AstraAdapter = {
    isAstra: _isAstra,
    normalizePrompt: function (prompt, spec) { return _prompt(prompt, spec); },
    /* 归一请求体：委托给通用 openai（Astra format='openai'，无特例字段）。中等脑接入时在此挂归一钩子。 */
    buildRequest: function (spec, prompt, options) {
      var fmt = 'openai';
      var p = _prompt(prompt, spec);
      var model = spec && spec.model;
      var maxTokens = (options && options.maxTokens != null) ? options.maxTokens : 512;
      var temperature = (options && options.temperature != null) ? options.temperature : (spec && spec.temperature != null ? spec.temperature : null);
      var msgs = [{ role: 'system', content: p.system }].concat(p.messages.map(function (m) { return { role: m.role, content: adaptMessageParts('openai', m.content) }; }));
      var body = { model: model, messages: msgs, max_tokens: maxTokens };
      if (options && options.jsonMode) body.response_format = { type: 'json_object' };
      if (temperature != null) body.temperature = Number(temperature);
      return { endpoint: spec && spec.endpoint, headers: {}, body: body, format: fmt };
    },
    /* 归一响应：复用通用 openai 归一出 content/reasoning/truncated/usage。 */
    parseResponse: function (wire, spec, options) { return parseResponse(wire, Object.assign({}, spec, { format: 'openai' }), options); },

    /* ── OpenAI Responses API · 专用 request builder ──
       不把 Responses API 当 Chat Completions 发送。正确映射：
       model / input / instructions / max_output_tokens / reasoning.effort /
       stream / text.format。绝不发送 max_tokens / temperature / top_p / logprobs /
       reasoning_effort 等 Chat Completions 旧参数。
       保持旧 buildRequest 不变（其它调用方仍走 OpenAI-compat）。 */
    buildResponsesRequest: function (spec, prompt, options) {
      options = options || {};
      var p = _prompt(prompt, spec);
      var model = (spec && spec.model) || 'gpt-6-astra';
      var maxOut = (options.maxTokens != null ? options.maxTokens : 512);
      /* input：把 system 并入首条，或作为独立 message。Responses input 支持 {role,content}。
         instructions 为独立 top-level 字段（若 Middle Brain 有独立 system/instruction）。 */
      var input = [];
      if (p.system) input.push({ role: 'system', content: p.system });
      (p.messages || []).forEach(function (m) { input.push({ role: m.role, content: adaptMessageParts('openai', m.content) }); });
      var body = { model: model, input: input, max_output_tokens: maxOut, stream: !!options.stream };
      if (p.system) body.instructions = p.system;               /* Responses 独立指令域 */
      if (p.messages && p.messages[0] && p.messages[0].role === 'system') {
        /* system 已在 input 保留（兼容），instructions 作为独立域给 Middle Brain */
      }
      /* P21 · reasoning：canonical reasoningEffort → provider 能力翻译（唯一真源 = provider-directory.js）。
         auto（默认）与未取证 provider 一律**不写任何字段**，body 与上线前逐字节一致。 */
      applyReasoningEffort(body, spec, { format: 'responses', effort: options.reasoningEffort, maxTokens: maxOut, consumer: options.consumer });
      /* 结构化 JSON 输出：Responses 原生 text.format。若结构化参数可能不兼容，
         由上层 catch 后去掉再重试（fallback 不破坏聊天）。 */
      if (options.jsonMode) body.text = { format: { type: 'json_schema', name: 'middle_brain_result', schema: {
        type: 'object',
        properties: {
          keep: { type: 'array', items: { type: 'string' } },
          merge: { type: 'array', items: { type: 'object' } },
          drop: { type: 'array', items: { type: 'string' } },
          compressedContext: { type: 'string' },
          currentKept: { type: 'boolean' }
        },
        required: ['compressedContext', 'currentKept'],
        additionalProperties: false
      } } };
      return { endpoint: (spec && spec.endpoint) || 'https://api.openai.com/v1/responses', headers: {}, body: body, format: 'responses' };
    },

    /* ── OpenAI Responses API · 专用 parser ──
       优先 response.output_text（官方便捷字段）；无或为空时遍历 response.output：
         output[] 是权威来源，可能含不同 type 的输出项（message / reasoning / ...）。
         仅对 type==='message' 读 content；type==='reasoning' 读 summary（→ reasoning）。
         message.content 项：优先官方 output_text，其次 output_text type 的 .text，
         再 fallback 到 text type 的 .text（兼容旧/中转变体）。
       决不假设 choices[0].message.content，也不 assume output[0].content[0].text。
       text 仅在非空时采用，空 output_text 不应挡住 output[] 里的真实内容。 */
    parseResponsesResponse: function (wire, spec, options) {
      var out = { content: '', reasoning: '', truncated: false, usage: null };
      if (!wire) return out;
      var text = null;
      /* 顶层 output_text 是便捷字段；若非空字符串则优先采用 */
      if (typeof wire.output_text === 'string' && wire.output_text !== '') text = wire.output_text;
      /* 若没有顶层 output_text（或为空），则遍历权威的 output[]，按 item.type 分支处理 */
      if (text == null && Array.isArray(wire.output)) {
        var parts = [];
        for (var i = 0; i < wire.output.length; i++) {
          var item = wire.output[i];
          if (!item) continue;
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (var j = 0; j < item.content.length; j++) {
              var c = item.content[j]; if (!c) continue;
              /* message.content 项：优先官方 output_text 字段；再按项 type 取 text */
              if (typeof c.output_text === 'string') parts.push(c.output_text);
              else if (c.type === 'output_text' && typeof c.output_text === 'string' && c.output_text !== '') parts.push(c.output_text);
              else if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
              else if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
            }
          } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            item.summary.forEach(function (s) { if (s && typeof s.text === 'string') out.reasoning += (out.reasoning ? '\n' : '') + s.text; });
          }
          /* 其它 type（如 file_search / web_search_call）不属于正文，忽略 */
        }
        if (parts.length) text = parts.join('');
      }
      out.content = (text == null ? '' : String(text));
      /* done/truncated 信号：Responses 无 finish_reason，用 status 判断 */
      if (wire.status && /incomplete/.test(String(wire.status))) out.truncated = true;
      /* usage 映射：Responses API 专用字段 → IB 现有 {input_tokens, output_tokens, total} 结构 */
      if (wire.usage) {
        var u = wire.usage;
        out.usage = {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          total_tokens: u.total_tokens != null ? u.total_tokens : ((u.input_tokens || 0) + (u.output_tokens || 0)),
          input_tokens_details: u.input_tokens_details || null,
          output_tokens_details: u.output_tokens_details || null
        };
        var _rtr = reasoningTokensFromUsage(u, 'responses');
        if (_rtr != null) out.usage.reasoning_tokens = _rtr;
      }
      return out;
    },

    /* ── OpenAI Responses API · SSE/event stream parser（占位兼容入口）──
       Middle Brain v0 实际用非流式调用；此入口为未来 streaming 预留。
       逐事件解析，仅做保守兼容；不破坏现有 Chat Completions streaming。 */
    parseResponsesStream: function (onEvent) {
      var buf = '';
      return {
        push: function (chunk) {
          buf += chunk;
          for (;;) {
            var nl = buf.indexOf('\n');
            if (nl < 0) break;
            var line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.indexOf('data:')) { /* keep */ }
            if (line.indexOf('data:') !== 0) continue;
            var d = line.slice(5).trim(); if (d === '[DONE]') return;
            try { onEvent && onEvent(JSON.parse(d)); } catch (e) {}
          }
        },
        flush: function () { return buf; }
      };
    }
  };

  return {
    PROVIDERS: PROVIDERS,
    providerFormat: providerFormat,
    resolveProviderFormat: resolveProviderFormat,
    modelSupportsSamplingParameters: modelSupportsSamplingParameters,
    modelSupportsAssistantPrefill: modelSupportsAssistantPrefill,
    /* P20：Anthropic wire 归一的唯一真源（Browser / Node 共用同一实现） */
   normalizeAnthropicMessages: normalizeAnthropicMessages,
    normalizeWireRoles: normalizeWireRoles,
    validateAnthropicRequestBody: validateAnthropicRequestBody,
    /* P21：reasoning 能力读取 + adapter 边界唯一翻译器 + 只读观测环 */
    normalizeReasoningTier: normalizeReasoningTier,
    reasoningCapability: reasoningCapability,
    reasoningWirePlan: reasoningWirePlan,
    applyReasoningEffort: applyReasoningEffort,
    reasoningTrace: reasoningTrace,
    reasoningTraceReset: reasoningTraceReset,
    noteReasoningTokens: noteReasoningTokens,
    turnTraceBegin: turnTraceBegin,
    turnTraceEvent: turnTraceEvent,
    turnTraceFinish: turnTraceFinish,
    turnTraceRecent: turnTraceRecent,
    turnTraceReset: turnTraceReset,
    reasoningTokensFromUsage: reasoningTokensFromUsage,
    adaptMessageParts: adaptMessageParts,
    geminiParts: geminiParts,
    buildRequestBody: buildRequestBody,
    parseResponse: parseResponse,
    /* Phase 9：SSE 流式解析的唯一实现（provider wire format 只在本文件被解释）。
       返回的 finish() 形状与 parseResponse 一致，调用方对流式/非流式可无差别处理。 */
    createStreamParser: createStreamParser,
    AstraAdapter: AstraAdapter
  };
});
