'use strict';
/* ====================================================================
   IB Home Node · L5 Expectation live runtime（P21-R4-LIVE-5）
   --------------------------------------------------------------------
   L5 期望**第一次**在真实的服务端会话运行时里跑起来：非持久、turn-local、
   不改变行为、不改写 prompt、只产出不消费。

   ── 它消费什么（§4 · CONTRACT.md (k-4)）─────────────────────────────
   REQUIRED   · 召回已选中的 canonical 行（records + selectedIds）—— 唯一必需输入
   OPTIONAL   · R4-B system evidence state（只读）
              · **已验证的 L3 解释结果**（调用方已经拿到的，本模块绝不去触发 R4-C）
              · relationship / emotion（有界）
   FORBIDDEN  · 当前 raw user prompt · recent observed context · full history
   本模块**没有**任何读取 user message 的入口 —— 它拿到的是召回与解释的产物。

   ── 两条被分开报告的声明（OWNER RULING 1）──────────────────────────
   协议层（冻结，**不改**）：
       EXPECTATION_REQUIRES_L3_INTERPRETATION = NO
       EXPECTATION_WITHOUT_INTERPRETATION     = CREATED_DEGRADED
     （CONTRACT.md:1848 解释是 OPTIONAL；:1856-1857 缺失时按 degraded 降级。）
   运行时调度层（本模块的纪律）：
       LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS   = YES
     —— 生产 seam **只在一次已验证的 L3 成功之后**才调度期望。这不是协议语义，
        而是我们选择的调度纪律；两者作为两条不同的声明分别报告，绝不互相冒充。

   ── 成本（§8 · OWNER RULING 2）─────────────────────────────────────
   `EXPECTATION_EXECUTION_KIND = MODEL`：期望的**内容**由模型产生（纯核心只做
   prompt 组装、严格校验与组装，它**没有**任何规则生成器 —— 见
   expectation-shadow-core.js:219-286）。因此：
     MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN = 1
     MAX_ATTEMPTS = 1 · AUTO_RETRY = 'NONE' · calls ≤ 1 / turn
   权威来自 `runtime-policy.js` 的**期望段**（与解释段两个独立布尔；解释开着
   不蕴含期望开着）。默认 OFF ⇒ NEW_EXPECTATION_MODEL_CALLS = 0。

   ── 只产出，不消费（§ISOLATION）────────────────────────────────────
   本模块**不导出任何返回期望正文的入口**：外部只能看到状态/计数/延迟/原因。
   持有者（holder）只在内部用于"同一逻辑回合不重复创建"的判重。因此"没有消费者"
   是**结构性**的，而不是靠约定：没有 API 可以读到内容。
   零持久写：不碰 SQLite / memory_records / Understanding / IndexedDB /
   localStorage / 文件 / 关系存储 / runtime-policy（除操作者显式 set）。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const DEFAULT_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'expectation-shadow-core.js'));
const DEFAULT_VISIBILITY_CORE = require(path.join(ASSETS_JS, 'memory-visibility-core.js'));

/* 与 R4-C runner 同一个默认 maxTokens（同一个模型任务，不另发明参数）。 */
const DEFAULT_MAX_TOKENS = 900;

/* 与解释边界同一个天花板来源（understanding-derivation.js:70），不另发明参数。 */
const SAFETY_CAP_MS = 120000;
/* 后台期望不该按最坏情况跑满：这是**服务端自有**的超时，不是调用方给的。 */
const AUTO_EXPECTATION_TIMEOUT_MS = 20000;
const MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN = 1;

/* 有界 turn-local 兄弟持有者（**不是**解释持有者，**不是** session state）。 */
const MAX_HELD_EXPECTATIONS = 64;
const TURN_EXPECTATION_TTL_MS = 10 * 60 * 1000;

const ENTRY = 'runFromValidatedInterpretation';
const EXECUTION_KIND = 'MODEL';

/* ── P5-B3-G1 · 结构化 expectation → canonical Prediction 的**运行时**投影 ──
   它不是 model adapter 的一部分：准入策略与组装是 runtime authority（§22/§54）。
   本模块只调用它的 plan()；真正的注册仍走下面唯一那处 P2 seam。 */
const createRuntimeStructuredExpectationProjection =
  require('./runtime-structured-expectation.js').createRuntimeStructuredExpectationProjection;

const REASON = Object.freeze({
  notEnabled: 'expectation-policy-off',
  l3NotValidated: 'l3-not-validated',
  noMemory: 'no-memory',
  duplicateTurn: 'duplicate-turn',
  turnIdentityMissing: 'turn-identity-missing',
  modelPortUnavailable: 'model-port-unavailable',
  providerUnavailable: 'provider-unavailable',
  coreMissing: 'expectation-core-missing',
  timeout: 'expectation-timeout',
  failed: 'expectation-failed',
  noValidItem: 'no-valid-item'
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value) {
  return value == null ? '' : String(value);
}
function bounded(value, limit) { return text(value).slice(0, limit || 200); }
/* 端口结果的取文（与解释边界同一套：字符串 / {text} / {content}；ok:false ⇒ null）。 */
function extractText(res) {
  if (res == null) return null;
  if (typeof res === 'string') return res;
  if (isPlainObject(res)) {
    if (typeof res.text === 'string') return res.text;
    if (typeof res.content === 'string') return res.content;
    if (res.ok === false) return null;
  }
  return null;
}
function normalizeId(value, limit) {
  const id = text(value).trim();
  if (!id || id.length > (limit || 180)) return null;
  return id;
}

function createRuntimeExpectation(deps) {
  const d = deps || {};
  const core = d.core || DEFAULT_CORE;
  const modelPort = d.modelPort || null;
  const policy = d.policy || null;
  /* canonical 内容的唯一来源（与解释边界同一对既有模块）。 */
  const memoryStore = d.memoryStore || null;
  const visibilityCore = d.visibilityCore || DEFAULT_VISIBILITY_CORE;
  /* 角色运行时 spec 与凭据（与解释边界同一对依赖，不发明第二套 lookup）。 */
  const registry = d.registry || null;
  const credentialAccess = d.credentialAccess || null;
  /* ── P2 · Prediction Registry（**唯一**批准的 Prediction Error 内部 seam）──
     由装配注入；只读消费**这一次已验证的** L5 结果，把它确定性投影成
     PredictionRecord。不新增模型调用、不结算、不落盘、不进响应。 */
  const predictionRegistry = deps.predictionRegistry || null;
  const logger = typeof d.logger === 'function' ? d.logger : function () {};
  const clock = typeof d.clock === 'function' ? d.clock : function () { return Date.now(); };
  /* 测试缝：与生产权威**分开**（TEST_INJECTION ≠ FILE_POLICY），
     与 LIVE-4 解释边界同一条纪律。 */
  const seamPolicy = d.autoExpectationPolicy;
  const timeoutMs = Math.min(
    Number.isFinite(Number(d.timeoutMs)) && Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : AUTO_EXPECTATION_TIMEOUT_MS,
    SAFETY_CAP_MS
  );
  function note(event, fields) {
    try { logger(event, fields || {}); } catch (_) { /* 观测失败绝不影响判定 */ }
  }

  const counters = {
    started: 0, created: 0, notCreated: 0, failed: 0, timedOut: 0,
    inFlight: 0, scheduled: 0, providerCalls: 0,
    /* P5-B3-G1 · 结构化投影诊断（有界；**绝不**记录模型正文） */
    predictionProjected: 0, predictionProjectionFailed: 0
  };
  /* P5-B3-G1：结构化投影 runtime（可注入，测试可替换；生产用默认实现）。 */
  const structuredExpectation = d.structuredExpectation
    || createRuntimeStructuredExpectationProjection({ logger: null });
  /* 内容只活在这里：出不了这个模块（没有导出入口）。 */
  const held = new Map();
  let waiters = new Set();

  function turnKeyOf(characterId, conversationId, turnId) {
    return text(characterId) + '|' + text(conversationId) + '|' + text(turnId);
  }
  function sweep() {
    const now = Number(clock());
    for (const [key, rec] of held) {
      const stamp = rec && (rec.completedAt || rec.startedAt);
      if (Number.isFinite(Number(stamp)) && (now - Number(stamp)) > TURN_EXPECTATION_TTL_MS) held.delete(key);
    }
  }
  function evictOverflow() {
    while (held.size > MAX_HELD_EXPECTATIONS) {
      const oldest = held.keys().next();
      if (oldest.done) break;
      held.delete(oldest.value);
    }
  }
  function settleWaiters() {
    if (counters.scheduled !== 0 || counters.inFlight !== 0) return;
    for (const w of Array.from(waiters)) { try { w(); } catch (_) { /* 已结算 */ } }
    waiters.clear();
  }

  /* ── canonical 证据绑定（**复用既有两个模块**，不写第二个 memory reader）──
     与 runtime-interpretation.js 的 resolveCanonicalEvidence 同一套纪律：
       · 只读 `memoryStore.getRecord(id)`（既有公开单条读）；
       · 可读性用**既有** `visibilityCore.canReadMemory(record, principal)`；
       · 缺失与不可读**同形**（都只是"没绑定"），不带 per-id 原因 ——
         任何区分都会把本路径变成一个存在性 oracle；
       · 不推进 revision、不写 change log、不激活。
     这里只做"按 id 取行 + 投影成期望核心声明的输入字段"，没有新的读语义。
     ★ 生产上召回 wrapper 今天不返回行，因此这条重绑是**唯一**的内容来源；
       拿不到 store ⇒ fail closed（不创建），绝不拿空行去问模型。 */
  function resolveCanonicalEvidence(characterId, selectedIds) {
    if (!memoryStore || typeof memoryStore.getRecord !== 'function') return { ok: false, reason: 'memory-store-unavailable' };
    if (!visibilityCore || typeof visibilityCore.canReadMemory !== 'function') return { ok: false, reason: 'visibility-core-unavailable' };
    const principal = { kind: 'role', id: characterId };
    const records = [];
    const boundIds = [];
    for (const id of selectedIds) {
      let record = null;
      try { record = memoryStore.getRecord(id); } catch (_) { record = null; }
      if (!record) continue;                          /* 不存在 / 已软删 */
      let decision = null;
      try { decision = visibilityCore.canReadMemory(record, principal); } catch (_) { decision = null; }
      if (!decision || decision.ok !== true) continue; /* 不可读 = 与不存在同形 */
      records.push({
        id: String(record.id),
        content: record.content == null ? record.summary : record.content,
        source: record.rawSource != null ? record.rawSource : record.source,
        kind: record.kind
      });
      boundIds.push(String(record.id));
    }
    return { ok: boundIds.length > 0, records: records, boundIds: boundIds };
  }

  /* ── 期望段的权威解析（fail closed；权威只有两个来源）──────────────── */
  function resolveExpectationPolicy(characterId) {
    if (seamPolicy !== undefined) {
      const raw = seamPolicy;
      let enabled = false;
      if (typeof raw === 'function') {
        try { enabled = raw(characterId) === true; } catch (_) { enabled = false; }
      } else if (typeof raw === 'boolean') {
        enabled = raw === true;
      } else if (isPlainObject(raw)) {
        enabled = raw.autoExpectationEnabled === true;
      }
      return { enabled: enabled, authoritySource: 'TEST_INJECTION', reason: enabled ? null : 'seam-off', characterId: characterId };
    }
    if (policy && typeof policy.readExpectation === 'function') {
      let r = null;
      try { r = policy.readExpectation(characterId); }
      catch (_) { return { enabled: false, authoritySource: 'FILE_POLICY', reason: 'policy-read-threw', characterId: characterId }; }
      return {
        enabled: !!(r && r.autoExpectationEnabled === true),
        authoritySource: 'FILE_POLICY',
        reason: r && r.reason ? String(r.reason) : null,
        characterId: characterId
      };
    }
    return { enabled: false, authoritySource: 'NONE_FAIL_CLOSED', reason: 'no-policy-assembled', characterId: characterId };
  }

  /* L3 结果 → 期望核心的 subjective 层（只取核心已经冻结的三个字段）。 */
  function subjectiveFrom(l3) {
    const items = (l3 && Array.isArray(l3.items)) ? l3.items : [];
    return items.slice(0, 64).map(function (it) {
      return {
        memoryId: text(it && it.memoryId),
        meaning: text(it && it.meaning),
        affect: it && it.affect == null ? '' : text(it.affect)
      };
    }).filter(function (x) { return !!x.memoryId; });
  }

  /* ── 角色运行时 spec（**唯一**查询点；不发明第二套 lookup、不读 sqlite）──
     与 runtime-interpretation.js#resolveCharacterSpec 同一套：
     `registry.getCharacterSpec(id)` 拿 provider/model/endpoint/credentialRef，
     再经 `credentialAccess.resolve(ref)` 取**服务端**密钥。
     ★ 刻意不接受 spec.apiKey 明文回落：本阶段的权威是 Vault。 */
  function resolveProviderSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') return { ok: false, reason: 'registry-unavailable' };
    let spec = null;
    try { spec = registry.getCharacterSpec(characterId) || null; } catch (_) { spec = null; }
    if (!isPlainObject(spec)) return { ok: false, reason: 'spec-missing' };
    const provider = text(spec.provider).trim();
    const model = text(spec.model).trim();
    const endpoint = text(spec.endpoint).trim();
    const credentialRef = text(spec.credentialRef).trim();
    if (!provider || !model || !endpoint || !credentialRef) return { ok: false, reason: 'spec-incomplete' };
    if (!credentialAccess || typeof credentialAccess.resolve !== 'function') return { ok: false, reason: 'credential-access-unavailable' };
    let resolved = null;
    try { resolved = credentialAccess.resolve(credentialRef); } catch (_) { resolved = null; }
    if (!resolved || resolved.ok !== true || typeof resolved.secret !== 'string' || !resolved.secret) {
      return { ok: false, reason: text(resolved && resolved.reason) || 'credential-unavailable' };
    }
    return {
      ok: true,
      spec: { provider: provider, model: model, endpoint: endpoint, apiKey: resolved.secret },
      providerClass: provider,
      modelId: model
    };
  }

  /* ── 单次调用（服务端自有；**一次**、无重试、有界等待）────────────────
     与 runtime-interpretation.js#invokeOnce 同一套纪律：
       · attempts 恒为 1；AUTO_RETRY = 'NONE'（没有第二次尝试的代码路径）；
       · 超时是**服务端自有**的（调用方给不出更长的权威）；到点即放弃等待，
         端口即使忽略 signal 也不会让调用方悬挂；
       · 期望路径**没有**调用方 signal：因此任何中止都只可能是服务端超时。 */
  async function invokeOnce(built, options) {
    const o = options || {};
    const waitMs = Number.isFinite(Number(o.timeoutMs)) && Number(o.timeoutMs) > 0 ? Math.min(Number(o.timeoutMs), SAFETY_CAP_MS) : timeoutMs;
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    let timedOut = false;
    let settled = false;
    let resolveBound = null;
    const bounded = new Promise(function (resolve) { resolveBound = resolve; });
    const timer = setTimeout(function () {
      timedOut = true;
      if (controller) { try { controller.abort(); } catch (_) { /* 已中止 */ } }
      if (resolveBound && !settled) { settled = true; resolveBound(true); }
    }, waitMs);
    const portPromise = Promise.resolve().then(function () {
      return modelPort.run({
        spec: o.spec || null,
        prompt: { system: built.system, messages: [{ role: 'user', content: built.user }] },
        messages: [{ role: 'user', content: built.user }],
        maxTokens: Number(o.maxTokens) > 0 ? Number(o.maxTokens) : DEFAULT_MAX_TOKENS,
        jsonMode: true,
        signal: controller ? controller.signal : undefined
      });
    });
    let res = null;
    let code = null;
    try {
      res = await Promise.race([portPromise, bounded]);
    } catch (_) {
      code = 'expectation-transport-error';
    } finally {
      clearTimeout(timer);
      /* 端口即使忽略 signal，也把它的 rejection 吃掉，避免 unhandledRejection。 */
      try { Promise.resolve(portPromise).catch(function () {}); } catch (_) { /* 忽略 */ }
    }
    if (code) return { ok: false, code: code, attempts: 1 };
    if (timedOut) return { ok: false, code: 'expectation-timeout', attempts: 1 };
    const textOut = extractText(res);
    if (textOut == null) return { ok: false, code: 'expectation-transport-error', attempts: 1 };
    return { ok: true, text: textOut, attempts: 1 };
  }

  /* ── 唯一入口：**在已验证的 L3 成功之后**由 runtime-recall 的兄弟调度调用 ──
     非阻塞（调用方在下一 tick 调度）、只产出、失败绝不影响主聊天或召回响应。 */
  async function runFromValidatedInterpretation(input, opts) {
    const i = isPlainObject(input) ? input : {};
    const o = isPlainObject(opts) ? opts : {};
    counters.started += 1;
    counters.inFlight += 1;
    const startedAt = Number(clock());
    const characterId = normalizeId(i.characterId) || '';
    const conversationId = text(i.conversationId);
    const turnId = normalizeId(i.turnId, 200) || '';
    const base = { entry: ENTRY, characterId: characterId, conversationId: bounded(conversationId, 200), turnId: turnId };
    const finish = (view) => {
      counters.inFlight -= 1;
      settleWaiters();
      return Object.assign({}, base, view);
    };
    try {
      if (!turnId) {
        counters.notCreated += 1;
        return finish({ ok: false, status: 'not-created', reason: REASON.turnIdentityMissing, providerCalls: 0 });
      }
      const key = turnKeyOf(characterId, conversationId, turnId);
      sweep(); evictOverflow();
      /* ② 同一逻辑回合只创建一次（重放 ⇒ 0 次额外创建） */
      if (held.has(key)) {
        counters.notCreated += 1;
        return finish({ ok: false, status: 'not-created', reason: REASON.duplicateTurn, providerCalls: 0 });
      }
      /* ③ 成本权威：期望段（**独立**于解释段）。OFF ⇒ 零调用。 */
      const characterPolicy = resolveExpectationPolicy(characterId);
      if (characterPolicy.enabled !== true) {
        counters.notCreated += 1;
        note('runtime-expectation-not-enabled', { characterId: characterId, turnId: turnId, authoritySource: characterPolicy.authoritySource, reason: characterPolicy.reason });
        return finish({
          ok: false, status: 'not-created', reason: REASON.notEnabled,
          authoritySource: characterPolicy.authoritySource, policyReason: characterPolicy.reason, providerCalls: 0
        });
      }
      /* ④ 调度纪律（RULING 1）：只有**已验证的 L3 成功**才允许走到这里。
            协议本身不要求 L3（那是 OPTIONAL），这是我们选择的运行时纪律。 */
      if (i.interpretationValidated !== true) {
        counters.notCreated += 1;
        return finish({ ok: false, status: 'not-created', reason: REASON.l3NotValidated, providerCalls: 0 });
      }
      const selectedIds = Array.isArray(i.selectedIds) ? i.selectedIds.map(String) : [];
      if (!selectedIds.length) {
        counters.notCreated += 1;
        return finish({ ok: false, status: 'not-created', reason: REASON.noMemory, providerCalls: 0 });
      }
      /* ⑤ canonical 行：调用方给了就用它；没给就按 id 服务端重绑（唯一内容来源）。
            重绑不到任何一行 ⇒ 不创建（fail closed），绝不拿空信封去问模型。 */
      const rebound = (Array.isArray(i.records) && i.records.length)
        ? { ok: true, records: i.records, boundIds: i.records.map(function (r) { return String(r && r.id); }) }
        : resolveCanonicalEvidence(characterId, selectedIds);
      if (!rebound.ok || !rebound.boundIds.length) {
        counters.notCreated += 1;
        note('runtime-expectation-no-canonical', { characterId: characterId, turnId: turnId, reason: rebound.reason || 'no-authorized-memory' });
        return finish({ ok: false, status: 'not-created', reason: REASON.noMemory, detail: rebound.reason || 'no-authorized-memory', providerCalls: 0 });
      }
      if (!core || typeof core.buildRequest !== 'function' || typeof core.validateResponse !== 'function') {
        counters.failed += 1;
        return finish({ ok: false, status: 'failed', reason: REASON.coreMissing, providerCalls: 0 });
      }

      if (!modelPort || typeof modelPort.run !== 'function') {
        counters.failed += 1;
        return finish({ ok: false, status: 'failed', reason: REASON.modelPortUnavailable, providerCalls: 0 });
      }
      /* ⑤ canonical 行 + 上游 L3（主观层）→ 核心输入信封 */
      const coreInput = {
        records: rebound.records,
        selectedIds: rebound.boundIds,
        evidence: isPlainObject(i.evidence) ? i.evidence : undefined,
        interpretations: subjectiveFrom(i.interpretation),
        currentState: isPlainObject(i.currentState) ? i.currentState : {}
      };
      const built = core.buildRequest(coreInput);
      if (!built || !built.stats || !built.stats.evidenceCount) {
        counters.notCreated += 1;
        return finish({ ok: false, status: 'not-created', reason: REASON.noMemory, providerCalls: 0 });
      }
      /* ⑥ 单次执行：prompt 组装、严格校验、组装都在**冻结的纯核心**里
            （`expectation-shadow-core.js`，UMD require）。
            ★ 调用**不**经过浏览器侧的 `expectation-shadow-runner.js`：那是 R4-D 的
              **影子 runner**，仓库把它冻结为"零生产调用方"（`AE1.productionCallersAreZero` /
              `R4D14.runnerHasZeroProductionCallers`）。服务端自己这一次调用与
              runtime-interpretation.js 同款（那里也是自己 invokeOnce + 复用纯核心）：
              **一次**、无重试、服务端自有超时、jsonMode。 */
      const specResolved = resolveProviderSpec(characterId);
      if (!specResolved.ok) {
        counters.failed += 1;
        note('runtime-expectation-no-spec', { characterId: characterId, reason: specResolved.reason });
        return finish({ ok: false, status: 'failed', reason: REASON.providerUnavailable, detail: specResolved.reason, providerCalls: 0 });
      }
      const called = await invokeOnce(built, {
        spec: specResolved.spec,
        timeoutMs: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : timeoutMs,
        maxTokens: Number(o.maxTokens) > 0 ? Number(o.maxTokens) : 0
      });
      const attempts = called.attempts;
      counters.providerCalls += attempts;
      const completedAt = Number(clock());
      const latencyMs = completedAt - startedAt;
      if (!called.ok) {
        const timedOut = called.code === 'expectation-timeout';
        if (timedOut) { counters.timedOut += 1; } else { counters.failed += 1; }
        note('runtime-expectation-call-failed', { characterId: characterId, turnId: turnId, code: called.code, attempts: attempts });
        return finish({
          ok: false, status: timedOut ? 'timed-out' : 'failed',
          reason: timedOut ? REASON.timeout : REASON.failed, errorClass: called.code,
          providerCalls: attempts, latencyMs: latencyMs
        });
      }
      let parsed = null;
      try { parsed = JSON.parse(called.text); }
      catch (_) {
        counters.failed += 1;
        return finish({ ok: false, status: 'failed', reason: REASON.failed, errorClass: 'expectation-json-invalid', providerCalls: attempts, latencyMs: latencyMs });
      }
      const validated = core.validateResponse(parsed, {
        allowedMemoryIds: rebound.boundIds.slice(),
        independentObservationCount: Number.isFinite(Number(i.independentObservationCount)) ? Number(i.independentObservationCount) : undefined
      });
      const shadow = core.assembleShadow(coreInput, validated, {
        providerClass: (i.provider && i.provider.provider) || null,
        modelId: (i.provider && i.provider.model) || null,
        latencyMs: latencyMs,
        status: validated.ok ? 'ok' : 'no-valid-item'
      });
      const items = (shadow && Array.isArray(shadow.items)) ? shadow.items : [];
      let status = 'created';
      let reason = null;
      if (!items.length) { status = 'not-created'; reason = REASON.noValidItem; counters.notCreated += 1; }
      else { counters.created += 1; }
      /* 持有者只在**真的产出**时记录内容（内容永不出模块）。 */
      if (status === 'created') {
        held.set(key, {
          turnKey: key, characterId: characterId, conversationId: conversationId, turnId: turnId,
          startedAt: startedAt, completedAt: completedAt, itemCount: items.length, latencyMs: latencyMs,
          content: shadow
        });
        evictOverflow();
        /* ── P2 · Prediction Registry 投影（**只建档，不结算**）────────────
           用**已有的** items（不再调模型、不再读库）；每一项的 expectationIndex
           就是它在本回合里的序号 —— 确定性、无随机、无计数器。
           投影失败 = 没有记录，主链照常继续（与 BehaviorEffect 同一条纪律）。 */
        if (predictionRegistry && typeof predictionRegistry.projectFromValidatedExpectation === 'function') {
          /* ── P5-B3-G1 · 结构化 expectation → canonical PredictionRecord ──────
             投影**准入**（G1 只允许 preference）与 canonical expectation 的
             组装都由 runtime 侧 projection 决定；模型只提供候选。
             ★ 注册仍然**只**走下面这一处 P2 seam（ONE registry call site）。 */
          const planned = structuredExpectation.plan(items, {
            characterId: characterId, conversationId: conversationId, turnId: turnId
          });
          for (let step = 0; step < planned.plans.length; step += 1) {
            const plan = planned.plans[step];
            if (!plan || plan.ok !== true) continue;
            try {
              predictionRegistry.projectFromValidatedExpectation(plan.expectation, {
                now: completedAt,
                characterId: characterId,
                conversationId: conversationId,
                turnId: turnId,
                expectationIndex: plan.index,
                interpretationRef: { turnId: turnId }
              });
              counters.predictionProjected += 1;
            } catch (_) {
              /* 投影失败 = 没有记录，主链照常继续（与 BehaviorEffect 同一条纪律） */
              counters.predictionProjectionFailed += 1;
            }
          }
        }
      }
      note('runtime-expectation', {
        characterId: characterId, turnId: turnId, status: status,
        providerCalls: attempts, itemCount: items.length, latencyMs: latencyMs
      });
      return finish({
        ok: status === 'created', status: status, reason: reason,
        providerCalls: attempts, latencyMs: latencyMs, itemCount: items.length,
        attemptCap: MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN
      });
    } catch (error) {
      counters.failed += 1;
      return finish({ ok: false, status: 'failed', reason: REASON.failed, errorClass: 'expectation-hook-threw', providerCalls: 0 });
    }
  }

  /* 测试用 settle 缝（不在生产路径上）：等到调度 + 在飞都归零。 */
  function awaitIdle(waitMs) {
    const cap = Number.isFinite(Number(waitMs)) && Number(waitMs) > 0 ? Number(waitMs) : 10000;
    if (counters.scheduled === 0 && counters.inFlight === 0) {
      return Promise.resolve({ idle: true, inFlight: 0, scheduled: 0 });
    }
    return new Promise(function (resolve) {
      let done = false;
      const waiter = function () { if (done) return; done = true; resolve({ idle: true, inFlight: counters.inFlight, scheduled: counters.scheduled }); };
      waiters.add(waiter);
      const t = setTimeout(function () { if (done) return; done = true; waiters.delete(waiter); resolve({ idle: false, inFlight: counters.inFlight, scheduled: counters.scheduled }); }, cap);
      if (t && typeof t.unref === 'function') t.unref();
    });
  }

  /* `describe()` 只报告状态/计数/延迟/原因 —— **绝不**包含期望正文。 */
  function describe() {
    sweep();
    const characterPolicy = resolveExpectationPolicy(null);
    let filePolicy = null;
    try { filePolicy = (policy && typeof policy.describe === 'function') ? policy.describe().expectationPolicy : null; } catch (_) { filePolicy = null; }
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      routes: 'NONE',
      executionKind: EXECUTION_KIND,
      /* 两条**分开**的声明（RULING 1） */
      liveSchedulingRequiresL3Success: 'YES',
      protocolRequiresL3Interpretation: 'NO',
      protocolWithoutInterpretation: 'CREATED_DEGRADED',
      /* 成本包线（冻结） */
      maxAdditionalModelCallsPerCharacterTurn: MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN,
      maxAttempts: 1,
      autoRetry: 'NONE',
      timeoutMs: timeoutMs,
      timeoutCapMs: SAFETY_CAP_MS,
      timeoutOwner: 'SERVER',
      /* 只产出，不消费 */
      produceOnly: 'YES',
      consumesNothing: 'YES',
      contentExposed: 'NO',
      browserVisible: 'NO',
      durableWrites: 0,
      durable: false,
      /* PD 未落地（本阶段不强行结算） */
      predictionErrorLive: 'NO',
      predictionErrorBlocker: 'LATER_OBSERVATION_AUTHORITY_NOT_CLOSED',
      liveCanonicalSourceBinding: 'NOT_IMPLEMENTED',
      crossRestartExpectationExactlyOnce: 'NO',
      holder: {
        maxEntries: MAX_HELD_EXPECTATIONS,
        ttlMs: TURN_EXPECTATION_TTL_MS,
        keyScope: 'characterId+conversationId+turnId',
        durability: 'NONE',
        routeExposed: false,
        entries: held.size
      },
      counters: Object.assign({}, counters),
      /* P5-B3-G1 · 结构化 expectation 投影（runtime authority）
         ★ 只暴露**计数与原因词表**，绝不暴露候选内容或模型正文。 */
      structuredProjection: (typeof structuredExpectation.describe === 'function')
        ? structuredExpectation.describe() : null,
      policy: {
        authoritySource: characterPolicy.authoritySource,
        enabledCharacterCount: filePolicy ? Number(filePolicy.enabledCharacterCount) || 0 : 0,
        default: filePolicy ? filePolicy.default === true : false,
        file: filePolicy ? filePolicy.file : null,
        sectionPresent: filePolicy ? filePolicy.sectionPresent === true : false,
        independentFromInterpretation: true,
        callerIntentIsNotAuthority: true,
        productionEnablePath: 'OPERATOR_FILE_ONLY',
        callerFacingEnablePath: 'NONE'
      },
      reasons: Object.keys(REASON).map(function (k) { return REASON[k]; })
    };
  }

  return Object.freeze({
    ENTRY: ENTRY,
    runFromValidatedInterpretation: runFromValidatedInterpretation,
    awaitIdle: awaitIdle,
    describe: describe,
    resolveExpectationPolicy: resolveExpectationPolicy,
    /* 只读状态（不是内容）：持有者里有多少条、某个回合有没有产出过。 */
    heldCount: function () { sweep(); return held.size; },
    hasExpectationForTurn: function (characterId, conversationId, turnId) {
      sweep();
      return held.has(turnKeyOf(characterId, conversationId, turnId));
    },
    MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN: MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN,
    AUTO_EXPECTATION_TIMEOUT_MS: AUTO_EXPECTATION_TIMEOUT_MS,
    SAFETY_CAP_MS: SAFETY_CAP_MS,
    MAX_HELD_EXPECTATIONS: MAX_HELD_EXPECTATIONS,
    TURN_EXPECTATION_TTL_MS: TURN_EXPECTATION_TTL_MS,
    EXECUTION_KIND: EXECUTION_KIND,
    REASON_CODES: REASON
  });
}

module.exports.createRuntimeExpectation = createRuntimeExpectation;
module.exports.ENTRY = ENTRY;
module.exports.EXECUTION_KIND = EXECUTION_KIND;
module.exports.MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN = MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN;
module.exports.AUTO_EXPECTATION_TIMEOUT_MS = AUTO_EXPECTATION_TIMEOUT_MS;
module.exports.SAFETY_CAP_MS = SAFETY_CAP_MS;
module.exports.MAX_HELD_EXPECTATIONS = MAX_HELD_EXPECTATIONS;
module.exports.TURN_EXPECTATION_TTL_MS = TURN_EXPECTATION_TTL_MS;
module.exports.REASON_CODES = REASON;