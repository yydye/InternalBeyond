/* ====================================================================
   IB Multimodal Delivery Policy — 「这个 unit 是 text 还是 voice」的**唯一**决策点
   (P23 Phase 2D · UMD dual-load)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/multimodal-delivery-policy.js"> → window.IBMultimodalPolicy
   - Node   : require('../assets/js/multimodal-delivery-policy.js')（测试用）
   - 规则：零 DOM / 零 fetch / 零 IndexedDB / 零 provider / 零 TTS / 零定时器 / 零时钟 /
     零 Math.random。**纯逻辑层**：给定 unit 与能力/偏好/意图，给出**模态**；不产生音频、不产生时间。

   ── 它在链路里的位置（严格单向）─────────────────────────────────────
       Planner（结构：几段、边界在哪）
         ↓
       Multimodal Policy（本文件：每段是 text 还是 voice）   ← 唯一的模态决策点
         ↓
       Sequence Contract（2A：message identity / sequence）
         ↓
       Delivery Runtime（2B：时间 / typing / cancel）
         ↓
       Phase 1 voice contract（voice message / playback）
   本文件**不认识** queue / cancel / typing / TTS / 音频 / DOM / 存储，也不认识 friendId
   （identity 只在 conversationId 层出现，因此未来 Group Member Turn 可直接复用）。

   ── 三条硬兼容线（都是「默认必须保持 TEXT」这条的展开）──────────────
     ① 没有明确意图/偏好/hint **且** 没有能力 → text；有偏好但没有能力 → text（确定性降级）。
     ② capability ≠ preference：角色**能**发语音（capability.voice.available）不等于它这次**想**发
        （preference / intent）。决策必须是两者的合取，绝不是 `if (voiceConfigured) sendVoice()`。
     ③ 任何异常 → text（绝不因为 policy 故障而丢回复；voice 只是**交付形式**，不是内容）。

   ── 为什么 voice 的音频不在这里生成 ─────────────────────────────────
   Policy 只说"这一条是 voice unit"。真正的 text → TTS → audio 发生在 **delivery time**
   （communication.js 的 delivery adapter 里），原因见 docs/P23-2D-MULTIMODAL-DELIVERY-POLICY.md §7：
   若在 sequence 创建时就合成全部音频，用户 cancel / interrupt / 未交付的 unit 都会白花钱，
   与 Phase 2B 的「cancelled before materialization ⇒ 零请求」直接冲突。
   本文件只输出**决策**，音频物化由 adapter 在 unit 到达 delivery time 时执行。

   ── Image（本阶段 DEFERRED）────────────────────────────────────────
   审计结论（见 phase 文档 §4）：image 目前**没有** canonical unit contract —— 2A 把 `image`
   列为 RESERVED 并确定性拒绝；image 也没有独立的 message schema / provenance / 存储权威
   （只有 `message.images` 这个内联数组）。因此本阶段：
     · 不新建半套 image runtime；不发明 image unit schema；
     · 但 contract 预留：`kind:'image'` 会被**识别**并给出确定性决策（有正文 → 降级为同内容 text；
       无正文 → 该 unit 无法交付，记入 dropped），**绝不静默丢失内容**。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./voice-message-core.js'));
  } else {
    root.IBMultimodalPolicy = factory(root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (VOICE) {
  'use strict';

  var POLICY_VERSION = 1;

  /* 决策原因码（稳定词表：调用方与测试按码断言，禁止字符串模糊匹配）。 */
  var REASONS = {
    DEFAULT_TEXT: 'default-text',                     /* 没有任何 voice 意图/偏好 */
    VOICE_ENABLED: 'voice-enabled',                   /* 有意图/偏好 + 有能力 ⇒ voice */
    VOICE_UNAVAILABLE: 'voice-unavailable',           /* 有偏好但没能力 ⇒ 确定性降级为 text */
    VOICE_INTENT_UNMET: 'voice-intent-unmet',         /* **显式意图**没被满足（同样降级，但原因可区分） */
    VOICE_DISABLED_BY_POLICY: 'voice-disabled-by-policy',
    VOICE_BUDGET_EXCEEDED: 'voice-budget-exceeded',   /* 单回合 voice 条数上限（成本护栏） */
    IMAGE_DEFERRED: 'image-deferred',                 /* image 尚未有 canonical contract */
    UNSUPPORTED_KIND: 'unsupported-kind',             /* 未知 kind（绝不放行） */
    MALFORMED_UNIT: 'malformed-unit',
    EMPTY_UNIT: 'empty-unit'
  };
  /* 单回合最多几条 voice（确定性成本护栏；超出者降级为 text，绝不随机挑）。 */
  var MAX_VOICE_UNITS_PER_TURN = 3;
  /* trace ring 上限（只放身份/模态/原因，绝不放正文）。 */
  var TRACE_MAX = 120;
  /* ── IMAGE DEFERRED（§11 的正式回答，写进 contract 而不是只写进报告）────────
     审计结论：image 目前**没有** canonical unit contract ——
       · Phase 2A 把 `image` 列为 RESERVED 并确定性拒绝（unsupported-kind）；
       · image 没有独立 message schema / provenance / 存储权威，只有 `message.images`
         这个内联数组（`{dataUrl, base64, mime, name}`，由上传与 `<ws_gen_image>` 生成）；
       · 生成路径是 Image Router + 角色自己的 imageGen 配置，属于工具调用层。
     因此本阶段：**不接入 image unit**，也不新建半套 image runtime；但 contract 明确登记
     "image 现在不可用、以及为什么"，并保证**遇到 image unit 时内容不丢**（见 resolve()）。 */
  var IMAGE_CAPABILITY = Object.freeze({ available: false, reason: REASONS.IMAGE_DEFERRED, deferredTo: 'P23.x' });

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return v == null ? '' : String(v); }
  function bool(v) { return v === true; }
  function norm(s) { return str(s).replace(/\s+/g, ''); }

  /* ── capability 消毒（唯一入口）───────────────────────────────────────
     输入可以是角色 voice 配置，也可以是任何上游给的能力对象；输出**只**包含白名单标量键：
       { available, reason, source, provider, engine, voiceId, voiceType, model }
     绝不透传 apiKey / token / endpoint / voiceData / 任何嵌套结构。
     秘密判定复用 Phase 1 的唯一实现（voice-message-core.findSecret）；即使它缺席也**不**
     自己写第二套正则 —— 那种情况下返回"不可用"，fail closed。 */
  function sanitizeCapability(raw) {
    var out = { available: false, reason: '', source: '', provider: '', engine: '', voiceId: '', voiceType: '', model: '' };
    if (!isObject(raw)) return out;
    if (!VOICE || typeof VOICE.findSecret !== 'function') return out;   /* 无法证明干净 ⇒ 不可用 */
    var probe = { voice: raw };
    if (VOICE.findSecret(probe)) return out;                            /* 含凭据形状 ⇒ 整块拒绝 */
    var v = isObject(raw.voice) ? raw.voice : raw;                      /* 允许 {voice:{…}} 或裸对象 */
    if (isObject(v.voice)) v = v.voice;                                 /* 兼容 cfg.voice 直传 */
    var keys = ['source', 'provider', 'engine', 'voiceId', 'voiceType', 'model'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], val = v[k];
      if (val == null) continue;
      if (typeof val === 'object') continue;
      var s = str(val);
      if (!s) continue;
      if (typeof VOICE.findSecret === 'function' && VOICE.findSecret({ v: s })) continue;
      out[k] = s;
    }
    out.available = v.available === true;
    out.reason = str(v.reason).slice(0, 64);
    return out;
  }

  /* ── 输入归一（意图 / 偏好 / hint / 策略开关）──────────────────────────
     三者**必须分开**（§5/§15）：
       intent.voice      —— 这次**明确要求** voice（程序化显式意图；本阶段无 UI）
       preference.voice  —— 角色/用户**希望** voice（角色配置 opt-in）
       hints.preferVoice —— 上层（未来 Middle Brain）给的**偏好**提示，不是命令
       policy.voice      —— 'allow'（默认）| 'off'（显式关闭，最高优先级） */
  function readInputs(ctx) {
    var c = isObject(ctx) ? ctx : {};
    var intent = isObject(c.intent) ? c.intent : {};
    var pref = isObject(c.preference) ? c.preference : {};
    var hints = isObject(c.hints) ? c.hints : {};
    var policy = isObject(c.policy) ? c.policy : {};
    return {
      intentVoice: bool(intent.voice),
      preferVoice: bool(pref.voice),
      hintVoice: bool(hints.preferVoice),
      policyOff: str(policy.voice) === 'off',
      capability: sanitizeCapability(c.capability),
      turnId: str(c.turnId).slice(0, 80),
      conversationId: str(c.conversationId).slice(0, 160),
      policyVersion: POLICY_VERSION
    };
  }

  /* ── 唯一决策表（可测、可复述）──────────────────────────────────────
        canVoice     = capability.voice.available
        policyOff    = policy.voice === 'off'
        softWant     = preference.voice || hints.preferVoice     （**软**偏好：不改结构）
        strongIntent = intent.voice                              （**显式意图**：可以升级 text → voice）

     逐 unit（输入 kind 是**生产者的请求**）：
       ┌ 输入 kind=voice（生产者显式请求语音）
       │   policyOff                        → text（voice-disabled-by-policy）
       │   !canVoice                        → text（intent ? voice-intent-unmet : voice-unavailable）
       │   预算用尽                          → text（voice-budget-exceeded）
       │   否则                              → voice（voice-enabled）
       └
       ┌ 输入 kind=text
       │   strongIntent && !policyOff && canVoice && 预算未用尽
       │                                     → voice（voice-enabled；**唯一的升级路径**）
       │   strongIntent && (!canVoice || policyOff) → text（voice-intent-unmet / disabled）
       │   只有软偏好（softWant）             → **text**（软偏好不改结构：它只让"已经请求语音的
       │                                        unit"能落地，不把纯文本变成语音）
       │   什么都没有                          → text（default-text）
       └
       ┌ 输入 kind=image / 未知               → text（image-deferred / unsupported-kind；见 §11）
       └
     为什么软偏好不升级 text：① 硬兼容线要求"没有**明确**意图就保持 text"；
     ② 一个 6 段的回复不该因为一次偏好就变成 6 次 TTS（成本护栏）；
     ③ §3 的混合形态（text A / voice B / text C）只有在"生产者标了哪一条"时才可能自然出现。 */
  function decideUnit(kind, inputs, budget) {
    var canVoice = inputs.capability.available === true;
    if (kind === 'voice') {
      if (inputs.policyOff) return { requested: 'voice', resolved: 'text', reason: REASONS.VOICE_DISABLED_BY_POLICY, canVoice: canVoice, upgraded: false };
      if (!canVoice) {
        return { requested: 'voice', resolved: 'text', canVoice: false, upgraded: false,
          reason: inputs.intentVoice ? REASONS.VOICE_INTENT_UNMET : REASONS.VOICE_UNAVAILABLE };
      }
      if (budget.voiceUsed >= budget.voiceMax) return { requested: 'voice', resolved: 'text', reason: REASONS.VOICE_BUDGET_EXCEEDED, canVoice: true, upgraded: false };
      budget.voiceUsed++;
      return { requested: 'voice', resolved: 'voice', reason: REASONS.VOICE_ENABLED, canVoice: true, upgraded: false };
    }
    /* kind === 'text'（image / 未知 kind 在 resolve 里已单独处理） */
    if (inputs.intentVoice) {
      if (inputs.policyOff) return { requested: 'text', resolved: 'text', reason: REASONS.VOICE_DISABLED_BY_POLICY, canVoice: canVoice, upgraded: false };
      if (!canVoice) return { requested: 'text', resolved: 'text', reason: REASONS.VOICE_INTENT_UNMET, canVoice: false, upgraded: false };
      if (budget.voiceUsed >= budget.voiceMax) return { requested: 'text', resolved: 'text', reason: REASONS.VOICE_BUDGET_EXCEEDED, canVoice: true, upgraded: false };
      budget.voiceUsed++;
      return { requested: 'text', resolved: 'voice', reason: REASONS.VOICE_ENABLED, canVoice: true, upgraded: true };
    }
    return { requested: 'text', resolved: 'text', reason: REASONS.DEFAULT_TEXT, canVoice: canVoice, upgraded: false };
  }

  /* ── resolve(units, ctx) → 决议后的 units + 逐条决策 + 统计 ──────────
     输入 unit（Phase 2C planner 的输出形状）：
       { kind:'text'|'voice'|'image', content }
     输出 unit（本文件契约）：
       { kind:'text'|'voice', content }        // 永远不含音频、不含时间
     不变量：
       · **content 一字不改**（policy 从不改写台词；有测试断言 join 与输入一致）；
       · 顺序与条数在 text/voice 之间保持（image 的降级/丢弃单独记账）；
       · 绝不抛错：任何异常 → 全部 text（宁可退回默认，也不丢回复）。 */
  function resolve(units, ctx) {
    var inputs = readInputs(ctx);
    var budget = { voiceUsed: 0, voiceMax: MAX_VOICE_UNITS_PER_TURN };
    var out = [], decisions = [];
    var stats = {
      inputUnits: 0, outputUnits: 0, voiceRequested: 0, voiceResolved: 0,
      downgraded: 0, upgraded: 0, imageDeferred: 0, dropped: 0, lossless: true
    };
    try {
      var list = Array.isArray(units) ? units : [];
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        stats.inputUnits++;
        if (!isObject(u)) { stats.dropped++; decisions.push({ index: i, requested: 'invalid', resolved: null, reason: REASONS.MALFORMED_UNIT }); continue; }
        var kind = str(u.kind) || 'text';
        var content = str(u.content);
        if (!norm(content)) { stats.dropped++; decisions.push({ index: i, requested: kind, resolved: null, reason: REASONS.EMPTY_UNIT }); continue; }
        if (kind === 'image') {
          /* IMAGE DEFERRED：有正文 ⇒ 降级为同内容 text（内容绝不丢）；无正文在上面已被 EMPTY_UNIT 拦下。 */
          stats.imageDeferred++;
          stats.downgraded++;
          out.push({ kind: 'text', content: content });
          decisions.push({ index: i, requested: 'image', resolved: 'text', reason: REASONS.IMAGE_DEFERRED, canVoice: inputs.capability.available === true });
          continue;
        }
        if (kind !== 'text' && kind !== 'voice') {
          out.push({ kind: 'text', content: content });
          stats.downgraded++;
          decisions.push({ index: i, requested: kind, resolved: 'text', reason: REASONS.UNSUPPORTED_KIND, canVoice: inputs.capability.available === true });
          continue;
        }
        var d = decideUnit(kind, inputs, budget);
        /* 统计口径（稳定）：
             voiceRequested = 请求过/尝试过 voice 的 unit 数（生产者请求 + 显式意图升级尝试）
             voiceResolved  = 真的以 voice 交付的 unit 数
             downgraded     = voiceRequested 里最终落成 text 的 unit 数
             upgraded       = text → voice 的升级条数（显式意图路径） */
        var triedVoice = (kind === 'voice') || (kind === 'text' && inputs.intentVoice);
        if (triedVoice) stats.voiceRequested++;
        if (d.resolved === 'voice') { stats.voiceResolved++; out.push({ kind: 'voice', content: content }); }
        else {
          if (triedVoice) stats.downgraded++;
          out.push({ kind: 'text', content: content });
        }
        if (d.upgraded) stats.upgraded++;
        decisions.push({
          index: i, requested: (kind === 'voice' ? 'voice' : (inputs.intentVoice ? 'voice' : 'text')),
          producerKind: kind, resolved: d.resolved, reason: d.reason,
          canVoice: d.canVoice === true, unitIndex: out.length - 1
        });
      }
      stats.outputUnits = out.length;
      stats.lossless = norm(out.map(function (x) { return x.kind === 'text' || x.kind === 'voice' ? x.content : ''; }).join(''))
        === norm(list.filter(isObject).map(function (x) { return str(x.content); }).join(''));
    } catch (e) {
      /* 任何异常 ⇒ 全部退化为 text（内容保留，绝不丢回复）。 */
      out = [];
      var safe = Array.isArray(units) ? units : [];
      for (var j = 0; j < safe.length; j++) {
        var x = safe[j];
        if (!isObject(x)) continue;
        var c = str(x.content);
        if (!norm(c)) continue;
        out.push({ kind: 'text', content: c });
      }
      decisions = out.map(function (_, idx) { return { index: idx, requested: 'unknown', resolved: 'text', reason: 'policy-error' }; });
      stats.outputUnits = out.length;
      stats.policyError = true;
      stats.downgraded = out.length;
      stats.lossless = norm(out.map(function (y) { return y.content; }).join(''))
        === norm(safe.filter(isObject).map(function (y) { return str(y.content); }).join(''));
    }
    return { units: out, decisions: decisions, stats: stats, inputs: {
      policyVersion: POLICY_VERSION, capability: inputs.capability, canVoice: inputs.capability.available === true,
      intentVoice: inputs.intentVoice, preferVoice: inputs.preferVoice, hintVoice: inputs.hintVoice, policyOff: inputs.policyOff
    } };
  }

  /* ── toSequenceUnits(resolved) → Phase 2A 的 unit 输入形状 ────────────
     只做形状映射（content → text），**不含** audio：voice unit 的音频由 adapter 在
     delivery time 物化后再交给 2A（见文件头 §「为什么 voice 的音频不在这里生成」）。 */
  function toSequenceUnits(resolved) {
    var list = (resolved && Array.isArray(resolved.units)) ? resolved.units : [];
    return {
      units: list.map(function (u) {
        return { kind: u.kind === 'voice' ? 'voice' : 'text', text: str(u.content) };
      })
    };
  }

  /* ── trace（§21）：只允许身份 + 模态 + 原因 ─────────────────────────
     条目字段被测试钉成闭集：{ at?, turnId, conversationId, unitIndex, requested,
     resolved, reason }。**绝不**写 content / audio / apiKey / token。 */
  var traceRing = [];
  function note(decisions, meta) {
    var m = isObject(meta) ? meta : {};
    var list = Array.isArray(decisions) ? decisions : [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i] || {};
      traceRing.push({
        turnId: str(m.turnId).slice(0, 80), conversationId: str(m.conversationId).slice(0, 160),
        unitIndex: (typeof d.unitIndex === 'number') ? d.unitIndex : (typeof d.index === 'number' ? d.index : 0),
        requested: str(d.requested).slice(0, 24), resolved: str(d.resolved).slice(0, 24), reason: str(d.reason).slice(0, 40)
      });
    }
    if (traceRing.length > TRACE_MAX) traceRing.splice(0, traceRing.length - TRACE_MAX);
    return traceRing.length;
  }
  function trace(limit) {
    var n = Number(limit);
    if (!isFinite(n) || n <= 0) n = TRACE_MAX;
    return traceRing.slice(Math.max(0, traceRing.length - n));
  }
  function resetTrace() { traceRing.length = 0; }
  function summaryOf(result) {
    if (!result) return null;
    return {
      policyVersion: POLICY_VERSION,
      inputUnits: (result.stats && result.stats.inputUnits) || 0,
      outputUnits: (result.stats && result.stats.outputUnits) || 0,
      voiceRequested: (result.stats && result.stats.voiceRequested) || 0,
      voiceResolved: (result.stats && result.stats.voiceResolved) || 0,
      downgraded: (result.stats && result.stats.downgraded) || 0,
      imageDeferred: (result.stats && result.stats.imageDeferred) || 0
    };
  }

  return Object.freeze({
    POLICY_VERSION: POLICY_VERSION,
    REASONS: REASONS,
    MAX_VOICE_UNITS_PER_TURN: MAX_VOICE_UNITS_PER_TURN,
    TRACE_MAX: TRACE_MAX,
    IMAGE_CAPABILITY: IMAGE_CAPABILITY,
    sanitizeCapability: sanitizeCapability,
    resolve: resolve,
    toSequenceUnits: toSequenceUnits,
    note: note,
    trace: trace,
    resetTrace: resetTrace,
    summaryOf: summaryOf
  });
});
