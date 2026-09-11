/* ====================================================================
   Middle Brain · Character Integrity Guard 层（P11-2 新增）
   --------------------------------------------------------------------
   职责（P11-2 唯一新增能力，Middle Brain 内部）：
     1. Judge：判定"候选回复是否明显偏离当前角色"——结构化、machine-readable、确定性解析
     2. Gate：只有高置信度 + 强 severity 的明显 OOC 才触发重写（阈值配置化、保守默认）
     3. Targeted rewrite：保留原意/事实/信息量/对话任务，只修被指出的 violation
     4. Optional verify：重写后可选复判，**只观测**，绝不触发第二次重写
     5. Telemetry：enabled / judge ran / pass / fail / judge error / rewrite / rewrite error / verify / latency
   边界（硬约束）：
     - 只读：绝不写 Memory / Understanding / Thread / Diary / Moments / IndexedDB / localStorage
     - 绝不生成最终回复之外的任何内容；不修改用户要求、工具结果、事实答案
     - 绝不成环：每条候选最多一次 rewrite（judge → rewrite → optional verify → STOP）
     - 任何失败（未就绪 / 超时 / HTTP / 非 JSON / 校验不过 / 重写异常）→ 返回原候选
     - 默认关闭：关闭时零模型调用，行为与 P11-1C 等价
   依赖：MBC.config / MBC.policy / MBC.astra（DAG 上游，只读）；对外唯一出口 = MBC.integrity（冻结）。
   传输不重复实现：所有模型请求走 ASTRA.middleBrainModelCall（astra 层 = 唯一网络边界）。
   ==================================================================== */
(function (root) {
  'use strict';
  var MBC = (root.IB = root.IB || {}).__middleBrainContracts || (root.IB.__middleBrainContracts = {});
  var CFG = MBC.config, POL = MBC.policy, ASTRA = MBC.astra;   /* contract 依赖：config / policy / astra（只读） */

  /* —— 判断维度（白名单：非白名单维度一律丢弃，避免模型自创维度） —— */
  var MB_CI_DIMENSIONS = ['persona', 'speech_style', 'relationship', 'emotional_continuity', 'knowledge_boundary', 'behavior'];
  var MB_CI_TIMEOUT_MS = 20000;
  var MB_CI_MAX_VIOLATIONS = 8;        /* 上限：防止模型输出长清单（也防 CoT 泄漏） */
  var MB_CI_EVIDENCE_CHARS = 200;      /* 单条 evidence/reason 上限：只留短理由，不存长推理 */
  var MB_CI_JUDGE_MAX_TOKENS = 900;
  var MB_CI_REWRITE_MAX_TOKENS = 1600;
  /* 保守默认（第一版宁可漏掉轻微 OOC，也不频繁误杀正常回复）：
     confidence = Judge 自评置信度下限；score = 一致性分数上限（越低越像 OOC）；
     severity = 单条 violation 强度下限；failBelow = 判定为 fail 的分数参考线（仅 telemetry 分类用）。 */
  var MB_CI_SENSITIVITY = {
    conservative: { confidence: 0.80, score: 0.35, severity: 0.85, failBelow: 0.50 },
    balanced: { confidence: 0.65, score: 0.45, severity: 0.70, failBelow: 0.60 },
    strict: { confidence: 0.50, score: 0.55, severity: 0.60, failBelow: 0.70 }
  };
  var MB_CI_DEFAULT_SENSITIVITY = 'conservative';

  var MB_CI_SCHEMA = {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      score: { type: 'number' },
      confidence: { type: 'number' },
      violations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'string' },
            severity: { type: 'number' },
            evidence: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['dimension', 'severity', 'evidence', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['pass', 'score', 'confidence', 'violations'],
    additionalProperties: false
  };
  var MB_CI_REWRITE_SCHEMA = {
    type: 'object',
    properties: { reply: { type: 'string' } },
    required: ['reply'],
    additionalProperties: false
  };

  var _mbCiTelemetry = {
    checked: 0,          /* 进入 Guard（enabled）的次数 */
    skipped: {},         /* skipReason → 次数 */
    judgeRuns: 0, judgePass: 0, judgeFail: 0, judgeError: 0, judgeMalformed: 0,
    rewriteTriggered: 0, rewriteOk: 0, rewriteError: 0, rewriteSkipped: 0,
    verifyRuns: 0, verifyPass: 0, verifyFail: 0, verifyError: 0,
    judgeLatencyMs: 0, rewriteLatencyMs: 0,
    maxRewritesPerTurn: 0,
    last: null
  };
  function middleBrainCharacterIntegrityTelemetry() { return _mbCiTelemetry; }
  function middleBrainCharacterIntegrityReset() {
    _mbCiTelemetry.checked = 0; _mbCiTelemetry.skipped = {};
    _mbCiTelemetry.judgeRuns = 0; _mbCiTelemetry.judgePass = 0; _mbCiTelemetry.judgeFail = 0;
    _mbCiTelemetry.judgeError = 0; _mbCiTelemetry.judgeMalformed = 0;
    _mbCiTelemetry.rewriteTriggered = 0; _mbCiTelemetry.rewriteOk = 0; _mbCiTelemetry.rewriteError = 0; _mbCiTelemetry.rewriteSkipped = 0;
    _mbCiTelemetry.verifyRuns = 0; _mbCiTelemetry.verifyPass = 0; _mbCiTelemetry.verifyFail = 0; _mbCiTelemetry.verifyError = 0;
    _mbCiTelemetry.judgeLatencyMs = 0; _mbCiTelemetry.rewriteLatencyMs = 0; _mbCiTelemetry.maxRewritesPerTurn = 0;
    _mbCiTelemetry.last = null;
  }
  function _ciSkip(reason) {
    _mbCiTelemetry.skipped[reason] = (_mbCiTelemetry.skipped[reason] || 0) + 1;
    _mbCiTelemetry.last = { skipReason: reason, ts: Date.now() };
  }
  function _ciLast(patch) {
    _mbCiTelemetry.last = Object.assign({}, _mbCiTelemetry.last || {}, patch, { ts: Date.now() });
  }

  /* —— 证据提取（只读；只用仓库真实存在的数据） —— */
  function _ciStr(v) { return v == null ? '' : String(v); }
  function _ciCap(s, n) { s = _ciStr(s); return s.length > n ? s.slice(0, n) : s; }
  function _ciTextOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (p) { return p && typeof p.text === 'string' ? p.text : ''; }).filter(Boolean).join(' ');
    }
    return '';
  }
  /* 最近对话（只取 user/assistant，跳过 system；单条 400 字符、合计 2400 字符上限） */
  function _ciHistory(history) {
    var out = [];
    if (!Array.isArray(history)) return out;
    for (var i = history.length - 1; i >= 0 && out.length < 8; i--) {
      var m = history[i]; if (!m || typeof m !== 'object') continue;
      var role = (m.role === 'assistant') ? 'assistant' : (m.role === 'user' ? 'user' : null);
      if (!role) continue;
      var text = _ciTextOf(m.content);
      if (!text || !text.trim()) continue;
      out.unshift({ role: role, text: _ciCap(text, 400) });
    }
    var total = 0;
    for (var j = 0; j < out.length; j++) total += out[j].text.length;
    while (out.length > 1 && total > 2400) { total -= out[0].text.length; out.shift(); }
    return out;
  }
  /* 角色证据：只读消费方已经拿到的角色配置（不发明新 schema、不自行 retrieval） */
  function _mbCiBuildEvidence(characterId, userMessage, opts) {
    opts = opts || {};
    var ch = opts.character || {};
    var persona = {
      nickname: _ciCap(ch.nickname, 40),
      relationship: _ciCap(ch.relationship, 60),
      bio: _ciCap(ch.bio || ch.signature, 200),
      systemPrompt: _ciCap(ch.systemPrompt, 1600)
    };
    var dialogue = _ciHistory(opts.history);
    var ctx = { memory: '', understanding: '', thread: '', moments: '' };
    ['memory', 'understanding', 'thread', 'moments'].forEach(function (name) {
      try {
        var s = POL._mbSnapshotCtx(opts, name);
        if (s && s.provided && s.value) ctx[name] = _ciCap(s.value, 900);
      } catch (e) {}
    });
    var hasCtx = !!(ctx.memory || ctx.understanding || ctx.thread || ctx.moments);
    return {
      characterId: _ciCap(characterId, 80),
      persona: persona,
      userMessage: _ciCap(userMessage, 600),
      dialogue: dialogue,
      context: ctx,
      /* 证据可用性：缺失的维度**不允许**被判 fail（防误杀） */
      available: {
        persona: !!(persona.systemPrompt || persona.nickname || persona.bio),
        speech_style: !!(persona.systemPrompt || dialogue.length),
        relationship: !!persona.relationship,
        emotional_continuity: dialogue.length > 0,
        knowledge_boundary: hasCtx,
        behavior: !!(persona.systemPrompt || dialogue.length)
      }
    };
  }

  /* —— 控制标签：带功能标签的候选回复不做重写（工具副作用已无法安全重建） —— */
  function _mbCiHasControlTags(text) {
    return /<withdraw|<thinking>|<\/think|<ws_[a-z_]*|<mem_|<cal_note|<blog_read|```file:/i.test(_ciStr(text));
  }
  /* 供 Judge 阅读的"可见文本"（近似视图：只用于判定，不用于重写替换） */
  function _mbCiVisibleText(text) {
    var s = _ciStr(text);
    s = s.replace(/```file:[\s\S]*?```/gi, ' ');
    s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ');
    s = s.replace(/<\/?think(?:ing)?>/gi, ' ');
    s = s.replace(/<withdraw\s*\/?>/gi, ' ');
    s = s.replace(/<\/?(?:ws|mem|cal|blog)_[a-z_]*\b[^>]*>/gi, ' ');
    return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* —— 确定性解析：Judge JSON —— */
  function _mbParseCiJson(text) {
    try {
      var s = _ciStr(text).trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.pass !== 'boolean') return null;                     /* 必需字段缺失 → malformed */
      if (obj.score == null || isNaN(Number(obj.score))) return null;
      if (!Array.isArray(obj.violations)) return null;
      var violations = [];
      for (var i = 0; i < obj.violations.length && violations.length < MB_CI_MAX_VIOLATIONS; i++) {
        var v = obj.violations[i]; if (!v || typeof v !== 'object') continue;
        var dim = _ciStr(v.dimension).trim().toLowerCase();
        if (MB_CI_DIMENSIONS.indexOf(dim) < 0) continue;                  /* 非白名单维度 → 丢弃 */
        violations.push({
          dimension: dim,
          severity: POL._mbClamp01(Number(v.severity)),
          evidence: _ciCap(v.evidence, MB_CI_EVIDENCE_CHARS),
          reason: _ciCap(v.reason, MB_CI_EVIDENCE_CHARS)
        });
      }
      var maxSeverity = 0;
      for (var k = 0; k < violations.length; k++) if (violations[k].severity > maxSeverity) maxSeverity = violations[k].severity;
      /* confidence 缺失 → 0（保守：不允许"没给置信度"就触发重写） */
      var conf = (obj.confidence == null || isNaN(Number(obj.confidence))) ? 0 : POL._mbClamp01(Number(obj.confidence));
      return {
        pass: obj.pass === true,
        score: POL._mbClamp01(Number(obj.score)),
        confidence: conf,
        violations: violations,
        maxSeverity: maxSeverity,
        dimensions: violations.map(function (x) { return x.dimension; })
      };
    } catch (e) { return null; }
  }
  /* —— 确定性解析：Rewrite JSON —— */
  function _mbParseCiRewriteJson(text) {
    try {
      var s = _ciStr(text).trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      var r = obj.reply;
      if (typeof r !== 'string' || !r.trim()) return null;
      return r;
    } catch (e) { return null; }
  }

  /* —— 阈值 / 门控（纯函数，可确定性单测） —— */
  function _mbCiSensitivity(cfg) {
    var s = _ciStr(cfg && cfg.characterIntegritySensitivity).trim().toLowerCase();
    return MB_CI_SENSITIVITY[s] ? s : MB_CI_DEFAULT_SENSITIVITY;
  }
  function _mbCiThresholds(cfg) { return MB_CI_SENSITIVITY[_mbCiSensitivity(cfg)]; }
  /* gate：只有"Judge 明确 fail + 置信度够 + 分数够低 + severity 够高 + 未用过重写 + 无控制标签"才重写。
     任何一项不满足 → 原回复（保守优先）。 */
  function _mbCiGate(report, cfg, opts) {
    opts = opts || {};
    var th = _mbCiThresholds(cfg);
    if (!report) return { rewrite: false, reason: 'no_report', thresholds: th };
    /* maxSeverity 缺失时按 violations 现算（手写/降级 report 也能安全判定；缺失即 0 → 不重写） */
    var maxSev = (report.maxSeverity != null) ? Number(report.maxSeverity)
      : (Array.isArray(report.violations) ? report.violations.reduce(function (m, v) {
        var s = Number(v && v.severity); return isNaN(s) ? m : Math.max(m, s);
      }, 0) : 0);
    if (report.pass === true) return { rewrite: false, reason: 'judge_pass', thresholds: th };
    if (!(cfg && cfg.characterIntegrityRewrite === true)) return { rewrite: false, reason: 'rewrite_disabled', thresholds: th };
    if (opts.rewriteUsed === true) return { rewrite: false, reason: 'rewrite_already_used', thresholds: th };
    if (opts.controlTags === true) return { rewrite: false, reason: 'control_tags_present', thresholds: th };
    if (!(Number(report.confidence) >= th.confidence)) return { rewrite: false, reason: 'low_confidence', thresholds: th };
    if (!(Number(report.score) <= th.score)) return { rewrite: false, reason: 'score_above_threshold', thresholds: th };
    if (!(maxSev >= th.severity)) return { rewrite: false, reason: 'severity_below_threshold', thresholds: th };
    return { rewrite: true, reason: 'strong_ooc', thresholds: th, maxSeverity: maxSev };
  }

  /* —— Prompt 构建 —— */
  function _ciEvidenceBlock(ev) {
    var lines = [];
    if (ev.persona.nickname) lines.push('昵称：' + ev.persona.nickname);
    if (ev.persona.relationship) lines.push('与用户的关系：' + ev.persona.relationship);
    if (ev.persona.bio) lines.push('简介：' + ev.persona.bio);
    if (ev.persona.systemPrompt) lines.push('角色设定/系统提示词：\n' + ev.persona.systemPrompt);
    return lines.join('\n') || '(无角色设定)';
  }
  function _ciDialogueBlock(ev) {
    if (!ev.dialogue.length) return '(无)';
    return ev.dialogue.map(function (m) { return (m.role === 'assistant' ? '角色：' : '用户：') + m.text; }).join('\n');
  }
  function _ciContextBlock(ev) {
    var parts = [];
    if (ev.context.memory) parts.push('【记忆】' + ev.context.memory);
    if (ev.context.understanding) parts.push('【对TA的理解】' + ev.context.understanding);
    if (ev.context.thread) parts.push('【仍在推进的线索】' + ev.context.thread);
    if (ev.context.moments) parts.push('【近期动态】' + ev.context.moments);
    return parts.join('\n\n') || '(无)';
  }
  function _ciUnavailableBlock(ev) {
    var miss = MB_CI_DIMENSIONS.filter(function (d) { return !ev.available[d]; });
    return miss.length ? miss.join(' / ') : '(无)';
  }
  function _mbCiJudgePrompt(ev, candidateVisible) {
    return '你是 InternalBeyond（IB）的 Character Integrity Judge。'
      + '你只判断"这段候选回复是否**明显**偏离当前角色"，绝不修改它、绝不生成新回复、绝不评价文笔好坏。\n'
      + '【最重要的防误杀原则】当前上下文中的明确变化证据 > 静态人设刻板印象。\n'
      + '- 角色按用户要求暂时正式/冷淡/生气/开玩笑 → 不是 OOC。\n'
      + '- 角色正常生气、正常冷淡、正常开玩笑 → 不是 OOC。\n'
      + '- 角色讨论技术/事实问题、语气变平实 → 不是 OOC。\n'
      + '- 措辞、句式、口癖与"刻板印象"不同 → 不是 OOC（不同底层模型本来就该有不同的声音）。\n'
      + '- 只有当回复与角色人格、关系状态、已知事实或当前情境发生**实质冲突**时，才判 pass:false。\n'
      + '【维度】persona / speech_style / relationship / emotional_continuity / knowledge_boundary / behavior。\n'
      + '【证据不可用】下列维度缺少证据，**不得**据此判 fail：' + _ciUnavailableBlock(ev) + '\n'
      + '【输出】只输出 JSON，不要任何解释文字、不要 chain-of-thought：\n'
      + '{"pass":true,"score":0.93,"confidence":0.9,"violations":[]}\n'
      + 'score = 角色一致性分数（1 完全一致，0 完全偏离）；confidence = 你对本次判断的置信度（0..1）；\n'
      + 'violations[].dimension 必须取上述六个之一；severity 0..1；evidence 必须是候选回复里的原文片段（≤80字）；'
      + 'reason 一句话（≤60字）。无违规时 violations 为空数组。\n'
      + '【角色证据】\n' + _ciEvidenceBlock(ev) + '\n\n'
      + '【最近对话】\n' + _ciDialogueBlock(ev) + '\n\n'
      + '【可用上下文证据】\n' + _ciContextBlock(ev) + '\n\n'
      + '【当前用户消息】\n' + (ev.userMessage || '(无)') + '\n\n'
      + '【候选回复】\n' + candidateVisible + '\n\n'
      + '请判定【候选回复】是否明显偏离角色。';
  }
  function _mbCiRewritePrompt(ev, candidate, report) {
    var vs = (report.violations || []).map(function (v, i) {
      return (i + 1) + '. dimension=' + v.dimension + ' severity=' + v.severity
        + '\n   evidence: ' + (v.evidence || '(无)') + '\n   reason: ' + (v.reason || '(无)');
    }).join('\n');
    return '你是 IB 的 Character Integrity Rewriter。你的任务**不是**重新回答用户，'
      + '而是把【候选回复】按【需要修正的 violation】做**最小改写**。\n'
      + '必须保留：原意、信息量、事实内容、对用户请求的完成度、当前对话任务；保留原回复的语言风格与表达习惯。\n'
      + '只允许修正：下面列出的 violation。\n'
      + '严禁：增加剧情/新事实/新记忆；编造 Memory；修改事实答案；修改用户要求；修改工具结果；'
      + '为了"像角色"而降低答案正确性；把角色统一改写成温柔/礼貌/文学化的同一种风格；'
      + '输出解释、前言、markdown 代码块或任何标签。\n'
      + '若无法在不改变原意的前提下修正，则原样返回原回复。\n'
      + '【角色证据】\n' + _ciEvidenceBlock(ev) + '\n\n'
      + '【最近对话】\n' + _ciDialogueBlock(ev) + '\n\n'
      + '【当前用户消息】\n' + (ev.userMessage || '(无)') + '\n\n'
      + '【需要修正的 violation】\n' + (vs || '(无)') + '\n\n'
      + '【候选回复】\n' + candidate + '\n\n'
      + '只输出 JSON：{"reply":"改写后的完整回复"}';
  }

  /* —— 单次模型调用（复用 astra 层唯一网络边界；失败返回结构化原因）——
     P21：consumer 只用于 reasoning 观测归因；思考深度走 canonical 配置（auto → 不写字段）。 */
  async function _ciCall(prompt, schema, schemaName, maxTokens, timeoutMs) {
    try {
      var r = await ASTRA.middleBrainModelCall([{ role: 'user', content: prompt }], {
        maxTokens: maxTokens, jsonMode: true, schema: schema, schemaName: schemaName,
        timeoutMs: (timeoutMs != null ? Number(timeoutMs) : MB_CI_TIMEOUT_MS),
        consumer: 'middle_brain.integrity'
      });
      return r || { ok: false, error: 'error' };
    } catch (e) { return { ok: false, error: 'error' }; }
  }

  /* —— 重写结果净化：防止"自由发挥/漂移/注入控制标签" —— */
  function _mbCiSanitizeRewrite(reply, original) {
    var r = _ciStr(reply).trim();
    if (!r) return { ok: false, reason: 'empty' };
    if (_mbCiHasControlTags(r)) return { ok: false, reason: 'control_tags' };
    var olen = _ciStr(original).trim().length;
    if (olen > 60 && r.length < olen * 0.3) return { ok: false, reason: 'too_short' };
    if (r.length > olen * 2.5 + 200) return { ok: false, reason: 'too_long' };
    return { ok: true, reply: r };
  }

  /* ====================================================================
     主入口：Character Integrity Guard
     返回 {reply, ran, report, gate, rewrite, verify, judgeError}
     reply 永远是可用的字符串（失败 = 原候选）。
     ==================================================================== */
  async function middleBrainCharacterIntegrity(characterId, userMessage, candidate, opts) {
    opts = opts || {};
    var out = { reply: candidate, ran: false, report: null, gate: null, rewrite: null, verify: null, judgeError: null, evidence: null };
    try {
      if (typeof candidate !== 'string' || !candidate.trim()) { _ciSkip('empty_candidate'); return out; }
      var cfg = await CFG.getMiddleBrainConfig();
      /* ① 默认关闭：零模型调用（Guard OFF 与 P11-1C 等价） */
      if (!(cfg && cfg.characterIntegrityEnabled === true)) { _ciSkip('disabled'); return out; }
      _mbCiTelemetry.checked++;
      /* ② 范围：本阶段只接 single-chat 文本轮；voice 轮不接（改写会与已播报的语音失配） */
      if (opts.voice === true) { _ciSkip('voice_surface'); return out; }
      /* ③ 无 Astra 就绪 → 不发起任何请求（增强层不得成为聊天单点故障） */
      if (!(await CFG.middleBrainReady())) { _ciSkip('astra_not_ready'); return out; }
      var visible = _mbCiVisibleText(candidate);
      if (!visible) { _ciSkip('no_visible_text'); return out; }
      var controlTags = _mbCiHasControlTags(candidate);
      var evidence = _mbCiBuildEvidence(characterId, userMessage, opts);
      out.evidence = evidence;
      out.ran = true;

      /* ④ Judge：整轮最多一次 */
      var t0 = Date.now();
      var jr = await _ciCall(_mbCiJudgePrompt(evidence, visible), MB_CI_SCHEMA, 'character_integrity_report', MB_CI_JUDGE_MAX_TOKENS, opts.judgeTimeoutMs);
      var jlat = Date.now() - t0;
      _mbCiTelemetry.judgeRuns++; _mbCiTelemetry.judgeLatencyMs += jlat;
      if (!jr.ok) {
        _mbCiTelemetry.judgeError++; out.judgeError = jr.error;
        _ciSkip('judge_' + jr.error); _ciLast({ judgeRan: true, judgeResult: 'error', judgeError: jr.error, judgeLatencyMs: jlat });
        return out;
      }
      var report = _mbParseCiJson(jr.content);
      if (!report) {
        _mbCiTelemetry.judgeMalformed++;
        _ciSkip('judge_malformed'); _ciLast({ judgeRan: true, judgeResult: 'malformed', judgeLatencyMs: jlat });
        return out;
      }
      out.report = report;
      var th = _mbCiThresholds(cfg);
      if (report.pass === true && report.score > th.failBelow) {
        _mbCiTelemetry.judgePass++;
        _ciLast({ judgeRan: true, judgeResult: 'pass', score: report.score, confidence: report.confidence, maxSeverity: report.maxSeverity, judgeLatencyMs: jlat, rewriteTriggered: false });
        return out;
      }
      _mbCiTelemetry.judgeFail++;

      /* ⑤ Gate：只有强 OOC 才重写 */
      var gate = _mbCiGate(report, cfg, { controlTags: controlTags, rewriteUsed: false });
      out.gate = gate;
      _ciLast({
        judgeRan: true, judgeResult: 'fail', score: report.score, confidence: report.confidence,
        maxSeverity: report.maxSeverity, dimensions: report.dimensions, judgeLatencyMs: jlat,
        gateReason: gate.reason, rewriteTriggered: false
      });
      if (!gate.rewrite) { _mbCiTelemetry.rewriteSkipped++; _ciSkip('gate_' + gate.reason); return out; }

      /* ⑥ Targeted rewrite：每条候选最多一次（无循环、无二次 judge→rewrite） */
      _mbCiTelemetry.rewriteTriggered++;
      _mbCiTelemetry.maxRewritesPerTurn = Math.max(_mbCiTelemetry.maxRewritesPerTurn, 1);
      var t1 = Date.now();
      var rr = await _ciCall(_mbCiRewritePrompt(evidence, candidate, report), MB_CI_REWRITE_SCHEMA, 'character_integrity_rewrite', MB_CI_REWRITE_MAX_TOKENS, opts.rewriteTimeoutMs);
      var rlat = Date.now() - t1;
      _mbCiTelemetry.rewriteLatencyMs += rlat;
      if (!rr.ok) {
        _mbCiTelemetry.rewriteError++;
        _ciSkip('rewrite_' + rr.error); _ciLast({ rewriteTriggered: true, rewriteOk: false, rewriteError: rr.error, rewriteLatencyMs: rlat });
        return out;
      }
      var raw = _mbParseCiRewriteJson(rr.content);
      if (raw == null) {
        _mbCiTelemetry.rewriteError++;
        _ciSkip('rewrite_malformed'); _ciLast({ rewriteTriggered: true, rewriteOk: false, rewriteError: 'malformed', rewriteLatencyMs: rlat });
        return out;
      }
      var san = _mbCiSanitizeRewrite(raw, candidate);
      if (!san.ok) {
        _mbCiTelemetry.rewriteError++;
        _ciSkip('rewrite_' + san.reason); _ciLast({ rewriteTriggered: true, rewriteOk: false, rewriteError: san.reason, rewriteLatencyMs: rlat });
        return out;
      }
      out.reply = san.reply;
      out.rewrite = { reply: san.reply, latencyMs: rlat };
      _mbCiTelemetry.rewriteOk++;
      _ciLast({ rewriteTriggered: true, rewriteOk: true, rewriteLatencyMs: rlat, changed: san.reply !== candidate });

      /* ⑦ Optional verify：只观测。无论结果如何都**不得**触发第二次 rewrite。 */
      if (cfg.characterIntegrityVerify === true) {
        var vr = await _ciCall(_mbCiJudgePrompt(evidence, _mbCiVisibleText(san.reply)), MB_CI_SCHEMA, 'character_integrity_report', MB_CI_JUDGE_MAX_TOKENS, opts.judgeTimeoutMs);
        if (!vr.ok) { _mbCiTelemetry.verifyError++; out.verify = { ok: false, error: vr.error }; }
        else {
          var vrep = _mbParseCiJson(vr.content);
          if (!vrep) { _mbCiTelemetry.verifyError++; out.verify = { ok: false, error: 'malformed' }; }
          else {
            _mbCiTelemetry.verifyRuns++;
            if (vrep.pass === true) _mbCiTelemetry.verifyPass++; else _mbCiTelemetry.verifyFail++;
            out.verify = { ok: true, pass: vrep.pass, score: vrep.score, maxSeverity: vrep.maxSeverity };
          }
        }
        _ciLast({ verify: out.verify || null });
      }
      return out;
    } catch (e) {
      /* 任何未预期异常 → 原候选（绝不因 Guard 失败而丢回复）；只记短错误串，不记上下文内容 */
      _ciSkip('guard_error');
      _ciLast({ guardError: _ciCap(String(e && e.message || e), 160) });
      return out;
    }
  }

  /* —— layer contract（P11-2）：integrity 层唯一出口，冻结后下游只读 —— */
  MBC.integrity = Object.freeze({
    middleBrainCharacterIntegrity: middleBrainCharacterIntegrity,
    middleBrainCharacterIntegrityTelemetry: middleBrainCharacterIntegrityTelemetry,
    middleBrainCharacterIntegrityReset: middleBrainCharacterIntegrityReset,
    _mbParseCiJson: _mbParseCiJson,
    _mbParseCiRewriteJson: _mbParseCiRewriteJson,
    _mbCiGate: _mbCiGate,
    _mbCiVisibleText: _mbCiVisibleText,
    _mbCiHasControlTags: _mbCiHasControlTags,
    _mbCiBuildEvidence: _mbCiBuildEvidence,
    _mbCiJudgePrompt: _mbCiJudgePrompt,
    _mbCiRewritePrompt: _mbCiRewritePrompt,
    _mbCiSanitizeRewrite: _mbCiSanitizeRewrite,
    _mbCiSensitivity: _mbCiSensitivity,
    MB_CI_SCHEMA: MB_CI_SCHEMA,
    MB_CI_REWRITE_SCHEMA: MB_CI_REWRITE_SCHEMA,
    MB_CI_TIMEOUT_MS: MB_CI_TIMEOUT_MS,
    MB_CI_SENSITIVITY: MB_CI_SENSITIVITY,
    MB_CI_DIMENSIONS: MB_CI_DIMENSIONS
  });
})(typeof self !== 'undefined' ? self : globalThis);
