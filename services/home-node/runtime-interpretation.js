/* ====================================================================
   IB Home Node · R4-C LIVE · Vault-Authorized Runtime Interpretation Boundary
   （P21-R4-LIVE-2.1）
   --------------------------------------------------------------------
   FACTS MAY REMAIN STABLE · MEANING MAY CHANGE.
   而这一层是"变"的那一半**第一次**拥有一个可执行的服务端边界。

   ── 这一层**是**什么 ────────────────────────────────────────────────
   一个 **runtime-only** 的解释执行边界：

     operation        = 'memory-interpretation'（**唯一**，闭集）
     authority        = Home Node 按 characterId 从 character_runtime_specs 解析
     credential       = Vault，request-scoped（services/home-node/credential-access.js）
     prompt/validator = R4-C 纯核心（**同一份** SYSTEM_INSTRUCTIONS / validateResponse）
     attempts         = 1（AUTO_RETRY = NONE）
     timeout          = 调用方显式给出，服务端**同一个**值 + 既有天花板
     cost gate        = **server-side**，默认 OFF；调用方的 enabled 不是权威
     durability       = 零（不写 Understanding / memory / relationship / SQLite / IndexedDB）

   ── 这一层**不是**什么（逐条冻结，避免下次有人从代码里读出更多）────────
     · 不是 auto invocation：本阶段 R4C_AUTO_INVOCATION = NOT_IMPLEMENTED。
       没有任何生产调用方；`communication.js` 一个字没改，首 token 延迟变化 = 0。
       §37 登记的未来执行缝是 POST_RECALL_NONBLOCKING，但那是**未来**阶段的事。
     · 不是 Expectation / Counterfactual：那两个 operation 不在闭集里，
       未知 operation 一律 operation-forbidden（fail closed），
       并且**没有**通用模型入口 —— 本文件不存在"任意 provider + 任意 prompt"的形状。
     · 不是 Android 通道：`/internal/` 前缀当前被 http.js 归入**桌面面**
       （isDesktopOnlyPath）。本阶段的传输结论是 DESKTOP_ONLY，
       ANDROID_COMPATIBILITY = NOT_PROVEN。未来 Android 可以复用本文件的
       handler/service core，但**传输与鉴权边界必须另外设计**，不得把这条
       `/internal/` 路由报告成 Android-compatible。
     · 不是 durable Understanding revision：返回值恒为 durable:false，
       且 metaMemoryState / recollectionQuality 恒为 null（R4-C 既有语义）。

   ── 权威方向（本阶段最核心的一条）────────────────────────────────────
                 browser request
                       │ 只允许四个字段：
                       │   operation / characterId / timeoutMs / inputEnvelope
                       ▼
        ┌──────────────────────────────────────────────┐
        │ 闭集校验（多一个字段就 reject，绝不 ignore）  │
        └──────────────────────────────────────────────┘
                       ▼
        server cost gate（默认 OFF ⇒ 零 provider / 零 Vault）
                       ▼
        registry.getCharacterSpec(characterId)      ← 唯一角色配置查询
                       ▼  spec.credentialRef
        credentialAccess.resolve(ref)               ← 唯一 Vault resolver
                       ▼  secret（request-scoped）
        NodeModelPort.run(...)   ← 恰一次
                       ▼
        R4-C core.validateResponse → assembleShadow → 非持久结果

   **浏览器无权选择** credentialRef / provider / model / endpoint / apiKey：
   这些字段出现在请求里是**拒绝**而不是忽略（§5/§30），
   而它们本身只从 characterId 对应的 server-side spec 解析出来。

   ── 为什么 handler 复用 R4-C 纯核心而不是重写一份 ────────────────────
   `assets/js/memory-recall/memory-interpretation-core.js` 是 UMD，Node 侧
   可直接 require（本文件顶部就是那次机械证明）。因此：
     · SYSTEM_INSTRUCTIONS 只有一份（提示词不是本文件发明的）；
     · validateResponse 只有一份（VALIDATOR_IMPLEMENTATION_COUNT = 1）；
     · 信封构造只有一份（buildRequest）。
   本文件**没有**任何第二份 system prompt、第二份 schema、第二份 validator 的
   痕迹 —— 它只做"取权威 → 单次执行 → 把结果交给核心校验 → 原样返回"。

   ── 与 R4-C 影子 runner 的关系（如实登记）────────────────────────────
   R4-C 另有一份**浏览器侧影子 runner**（assets/js/memory-recall/ 下与纯核心
   同目录的那个 `*-runner.js`）：它没有任何生产调用方，而且它把 `deps.enabled`
   当作开关 —— 那正是本阶段禁止的形状（CALLER_INTENT != SERVER_COST_POLICY）。
   本文件因此**不**调用它，而是直接调用同一份纯核心，并把那份 runner 里
   "单次执行 + 有界等待 + signal 转发"的纪律在这里按 Node 生产边界重述一遍
   （多出来的部分只有：Vault 权威、error catalog、非持久结果信封）。
   **没有**第三套模型框架，也没有第二个 validator。

   ★ 上面这段刻意**不写**那份 runner 的文件名字面量：R4-C 的 AA2 守卫
     （tests/test_memory_interpretation_shadow.js）以**原始文本**（不剥注释）
     扫描 assets/services/bridge/src-tauri，断言"没有任何生产文件提到它"。
     那条守卫的意图是"runner 没有被接线"，而不是"生产代码不许解释自己为什么
     不接线" —— 但守卫是冻结的，因此这里让文档绕开字面量，而不是去放宽守卫。
   ==================================================================== */
'use strict';

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
/* ★ 机械证明：Node 侧能直接加载 R4-C 纯核心。这里刻意**硬 require** ——
   一个加载不到纯核心的宿主不应该"看起来有一个解释边界"，而应该在装配期
   就炸掉（fail closed）。`deps.core` 仍然可注入，测试因此可以替换它，
   但生产路径拿到的一定是下面这一份。 */
const DEFAULT_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'memory-interpretation-core.js'));

/* ── 路径常量：全仓只有一份字面量（与 economyCommand.path 同一约定）────
   语义最窄的那一条：路径里带着 operation 名，因此审计者不需要读 handler
   就知道这条路由**只能**做一件事。刻意不做 /internal/runtime/derive 这种
   "万能派生入口" —— 那会为未来的 Expectation 提前留一个洞。 */
const MEMORY_INTERPRETATION_PATH = '/internal/runtime/memory-interpretation';
const OPERATION = 'memory-interpretation';
/* §4 冻结：只有这一项。Expectation / Counterfactual = NOT ENABLED。 */
const ALLOWED_RUNTIME_DERIVATIONS = Object.freeze([OPERATION]);

/* ── 请求契约（闭集）────────────────────────────────────────────────
   多一个字段就 reject：这不是"宽容解析"，而是让"浏览器能表达什么"这件事
   在**结构上**只有四个词。权威字段（provider/model/endpoint/credentialRef/
   apiKey/...）因此根本没有进入执行路径的入口，而不是"记得忽略它们"。 */
const REQUEST_FIELDS = Object.freeze(['operation', 'characterId', 'timeoutMs', 'inputEnvelope']);
/* inputEnvelope 同样是闭集：它的五个键就是 R4-C normalizeInput 真实消费的
   那五个。信封里多一个键 → reject，因此"把 prompt / provider 藏在信封里"
   这条隧道在类型上不存在。 */
const ENVELOPE_FIELDS = Object.freeze(['selectedIds', 'records', 'evidence', 'currentState', 'roleName']);
/* 权威字段名单：它们**不是**白名单的补充，而是"为什么闭集"的可读理由。
   请求里出现任何一项 → request-field-forbidden，并在响应里指名那一个字段。 */
const AUTHORITY_BEARING_FIELDS = Object.freeze([
  'credentialRef', 'apiKey', 'secret', 'provider', 'model', 'endpoint',
  'systemPrompt', 'developerPrompt', 'developer', 'prompt', 'messages',
  'instructions', 'baseURL', 'token', 'authorization', 'headers', 'spec', 'config'
]);

/* ── 边界（有界请求）────────────────────────────────────────────────── */
const MAX_CHARACTER_ID_CHARS = 180;
const MAX_ROLE_NAME_CHARS = 120;
const MAX_ENVELOPE_RECORDS = 64;      /* R4-C 自己再裁到 MAX_MEMORIES = 8 */
const MAX_ENVELOPE_IDS = 64;
const MAX_OPERATION_ECHO_CHARS = 64;

/* ── 超时权威（与 R4-C.1 §12 同一条纪律）────────────────────────────
   本边界**不拥有**超时 policy：调用方必须显式给出 timeoutMs。
   缺失 ⇒ timeout-authority-missing，绝不回落到一个凭空发明的默认值。
   SAFETY_CAP_MS 只是**上界**，取值来自仓库既有的 derivation 天花板
   （services/home-node/understanding-derivation.js:70），因此它有证据。 */
const SAFETY_CAP_MS = 120000;
const SAFETY_CAP_SOURCE = 'services/home-node/understanding-derivation.js:70 UNDERSTANDING_TIMEOUT_MS';
const MAX_ATTEMPTS = 1;
const AUTO_RETRY = 'NONE';
/* 与 R4-C runner 同一个默认 maxTokens（同一个模型任务，不另发明参数）。 */
const DEFAULT_MAX_TOKENS = 1400;
const CONSUMER = 'r4c-live-runtime-interpretation';

/* ── 失败语义（§28）──────────────────────────────────────────────────
   左边的词表是本阶段的**对外**词；右边那一列（见 CORE_CODE_MAP）是本边界
   复用的 R4-C 核心词。两者**同时**出现在 reasonCodes 里，因此
   "服务端错误码"与"核心错误码"的对应关系是可断言的，而不是靠读者推断。 */
const REASON = Object.freeze({
  disabled: 'disabled',
  operationForbidden: 'operation-forbidden',
  requestShapeInvalid: 'request-shape-invalid',
  requestFieldForbidden: 'request-field-forbidden',
  runtimeSpecUnavailable: 'runtime-spec-unavailable',
  credentialUnavailable: 'credential-unavailable',
  timeoutAuthorityMissing: 'timeout-authority-missing',
  timeout: 'timeout',
  providerError: 'provider-error',
  network: 'network',
  invalidOutput: 'invalid-output',
  aborted: 'aborted',
  modelPortUnavailable: 'model-port-unavailable',
  coreMissing: 'interpretation-core-missing'
});

/* 本边界码 → R4-C 核心既有码（有一份才映射；没有就只报本边界码）。
   ★ 键是 REASON 的**值**（对外词），不是属性名 —— 这张表是"同一个失败
     在两个词表里叫什么"的唯一对照，写错一个键就会静默地不映射。 */
const CORE_CODE_MAP = Object.freeze({
  timeout: 'model-timeout',
  aborted: 'model-aborted',
  'provider-error': 'model-transport-error',
  network: 'model-transport-error',
  'invalid-output': 'model-json-invalid',
  'model-port-unavailable': 'model-port-unavailable'
});

/* HTTP 状态：传输层直接使用这里的值，因此"同一个失败在两条路径上不会有
   两个状态码"。R4-C 校验器的码（model-*）一律 502 —— 上游给了不可用的东西。 */
const STATUS_BY_REASON = Object.freeze({
  disabled: 503,
  'operation-forbidden': 403,
  'request-shape-invalid': 400,
  'request-field-forbidden': 400,
  'runtime-spec-unavailable': 404,
  'credential-unavailable': 503,
  'timeout-authority-missing': 400,
  timeout: 504,
  'provider-error': 502,
  network: 502,
  'invalid-output': 502,
  aborted: 499,
  'model-port-unavailable': 503,
  'interpretation-core-missing': 503,
  'no-authorized-memory': 422
});

/* 传输真值：本阶段**只有桌面**。这两个常量同时出现在 describe() 与结果里，
   因此"不得声称 Android 兼容"是一句可以被机械核对的话。 */
const TRANSPORT_SCOPE = 'DESKTOP_ONLY';
const ANDROID_COMPATIBILITY = 'NOT_PROVEN';
const AUTO_INVOCATION = 'NOT_IMPLEMENTED';
const EXECUTION_SEAM = 'POST_RECALL_NONBLOCKING';

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
/* 一律**只读自有属性**：原型上的东西（含被污染的 __proto__）永远不参与
   权威解析，因此"用原型污染注入 provider/model"这条路在读取侧就断了。 */
function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
function text(v) { return v == null ? '' : String(v); }
function statusFor(code) {
  if (Object.prototype.hasOwnProperty.call(STATUS_BY_REASON, code)) return STATUS_BY_REASON[code];
  /* R4-C 校验器的码（model-shape-invalid / model-returned-* / model-field-exceeds-bound
     ...）全部归入 502：它们的意思是"上游返回了不可用的东西"。 */
  return 502;
}

/* ── 网络 vs provider：只有**可观测的形状**才算 network ────────────────
   不做错误文案猜测的泛化匹配 —— 判据是 Node fetch 的真实失败形状
   （TypeError + cause.code）以及明确的 socket 码。其余一律 provider-error。 */
const NETWORK_CAUSE_CODES = Object.freeze([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'
]);
function isNetworkError(error) {
  if (!error) return false;
  const cause = error.cause || null;
  const code = text(cause && cause.code) || text(error.code);
  if (code && NETWORK_CAUSE_CODES.indexOf(code) >= 0) return true;
  const name = text(error.name);
  const message = text(error.message);
  if (name === 'TypeError' && /fetch failed|network|getaddrinfo|socket hang up/i.test(message)) return true;
  return false;
}
function isAbortError(error) {
  return !!error && (text(error.name) === 'AbortError' || error.code === 'ABORT_ERR');
}
function isTimeoutError(error) {
  return !!error && text(error.name) === 'TimeoutError';
}
/* 端口返回形状可能有两种（仓库里都存在）：{ok,text} 或 裸字符串 / {content}。
   与 R4-C runner 同一套提取规则 —— 但这**不是** validator，只是取文本。 */
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

/* ── server cost gate（§10）──────────────────────────────────────────
   CALLER_INTENT != SERVER_COST_POLICY。调用方请求里的 `enabled:true`
   在本文件里**零读取**（它甚至不在请求闭集里，出现即 reject）。
   权威只有这里：装配层注入的 policy。

   取值形态（全部默认 false）：
     undefined / null            → false（本阶段生产就是这个形态）
     boolean                     → 它自己
     { memoryInterpretationEnabled: true } → 唯一的开法
     function                    → 每次调用求值一次（测试可以翻它）
   函数抛错 ⇒ false（fail closed），且来源被如实记录。
   ★ 本阶段**不**新增 env / UI toggle：谁来配置它留给未来的 auto caller 阶段决定。 */
function resolveCostPolicy(policy) {
  let raw = policy;
  let source = 'absent-default-false';
  if (typeof raw === 'function') {
    source = 'injected-function';
    try { raw = raw(); }
    catch (_) { return { enabled: false, source: 'injected-function-threw' }; }
  }
  if (raw === undefined || raw === null) return { enabled: false, source: source };
  if (typeof raw === 'boolean') return { enabled: raw, source: 'injected-boolean' };
  if (isPlainObject(raw)) {
    return { enabled: raw.memoryInterpretationEnabled === true, source: 'assembly-policy-object' };
  }
  return { enabled: false, source: 'unrecognized-default-false' };
}

function createRuntimeInterpretation(deps) {
  deps = deps || {};
  /* 三个依赖就是整条权威链：角色目录 → Vault → 模型端口。
     任何一个缺席都会在**请求期**以稳定的码失败，而不是在装配期被静默忽略。 */
  const registry = deps.registry || null;
  const credentialAccess = deps.credentialAccess || null;
  const modelPort = deps.modelPort || null;
  const core = deps.core || DEFAULT_CORE;
  const costPolicy = deps.costPolicy;
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now;
  const logger = typeof deps.logger === 'function' ? deps.logger : function () {};

  /* 进程级计数（观测用）：provider 调用与 Vault 读取各一个。
     它们**不**含任何秘密，也不含任何正文。 */
  const counters = { calls: 0, providerCalls: 0, vaultReads: 0, refused: 0, succeeded: 0 };

  function note(event, fields) {
    try { logger(event, fields || {}); } catch (_) { /* 观测失败不影响执行 */ }
  }

  /* ── 结果信封：成功与失败**同一套字段**，因此调用方不需要猜 ──────────
     失败形状刻意与 R4-C runner 的 `unavailable()` 同形（items/missingFor/
     rejected/counts/model/metaMemoryState/recollectionQuality），
     这里的差别只有三个：多一个 `error`（HTTP 层与调用方直接读它）、
     多一个 `operation/characterId`（审计）、多一个 `boundary`（自述）。
     ★ 没有任何一处会把 provider 原文、reasoning、prompt 或秘密放进来。 */
  function boundaryBlock(attempts, providerCalls, vaultReads) {
    return {
      runtimeOnly: true,
      durable: false,
      transportScope: TRANSPORT_SCOPE,
      androidCompatibility: ANDROID_COMPATIBILITY,
      autoInvocation: AUTO_INVOCATION,
      executionSeam: EXECUTION_SEAM,
      attempts: attempts,
      maxAttempts: MAX_ATTEMPTS,
      autoRetry: AUTO_RETRY,
      providerCalls: providerCalls,
      vaultReads: vaultReads,
      credentialAuthority: 'HOME_NODE_CHARACTER_RUNTIME_SPEC',
      promptAuthority: 'memory-interpretation-core.js#SYSTEM_INSTRUCTIONS',
      validatorAuthority: 'memory-interpretation-core.js#validateResponse'
    };
  }

  function failure(code, ctx) {
    const c = ctx || {};
    const attempts = Number(c.attempts) || 0;
    const providerCalls = Number(c.providerCalls) || 0;
    const vaultReads = Number(c.vaultReads) || 0;
    const codes = [code];
    const mapped = Object.prototype.hasOwnProperty.call(CORE_CODE_MAP, code) ? CORE_CODE_MAP[code] : null;
    if (mapped && core && core.REASON_CODES && mapped !== code) codes.push(mapped);
    if (Array.isArray(c.extraCodes)) {
      for (const extra of c.extraCodes) if (extra && codes.indexOf(extra) < 0) codes.push(extra);
    }
    const out = {
      ok: false,
      durable: false,
      operation: c.operation === undefined ? null : c.operation,
      characterId: c.characterId === undefined ? null : c.characterId,
      error: code,
      reasonCode: code,
      reasonCodes: codes,
      items: [],
      missingFor: [],
      rejected: Array.isArray(c.rejected) ? c.rejected : [],
      counts: { requested: Number(c.requested) || 0, returned: 0 },
      model: {
        providerClass: c.providerClass === undefined ? null : c.providerClass,
        modelId: c.modelId === undefined ? null : c.modelId,
        latencyMs: Number.isFinite(Number(c.latencyMs)) ? Number(c.latencyMs) : null,
        status: code,
        attempts: attempts
      },
      metaMemoryState: null,
      recollectionQuality: null,
      boundary: boundaryBlock(attempts, providerCalls, vaultReads),
      status: statusFor(code)
    };
    if (c.detail) out.detail = String(c.detail).slice(0, 200);
    if (c.field) out.field = String(c.field).slice(0, 80);
    if (c.requestedOperation !== undefined) out.requestedOperation = c.requestedOperation;
    return out;
  }

  /* ── 请求闭集校验。返回 { ok:true, ... } 或 { ok:false, result } ───── */
  function validateRequest(body) {
    if (!isPlainObject(body)) {
      return { ok: false, result: failure(REASON.requestShapeInvalid, { detail: 'body-not-an-object' }) };
    }
    /* ① 闭集：任何白名单之外的**自有**键一律拒绝（绝不 ignore）。
          JSON.parse('{"__proto__":{...}}') 会产生一个**自有**的 `__proto__`
          键，因此原型污染尝试也在这里被当成未知字段抓住。 */
    const keys = Object.keys(body);
    for (const key of keys) {
      if (REQUEST_FIELDS.indexOf(key) < 0) {
        const authority = AUTHORITY_BEARING_FIELDS.indexOf(key) >= 0;
        return {
          ok: false,
          result: failure(REASON.requestFieldForbidden, {
            field: key,
            detail: authority ? 'authority-bearing-field-is-not-accepted' : 'unknown-field-closed-schema',
            requestedOperation: typeof own(body, 'operation') === 'string'
              ? own(body, 'operation').slice(0, MAX_OPERATION_ECHO_CHARS) : null
          })
        };
      }
    }
    /* ② operation：**只有**一项合法。缺失 / null / 非字符串 / 任何别的词
          一律 operation-forbidden（fail closed，且不做通用模型路由）。 */
    const operationRaw = own(body, 'operation');
    const operation = typeof operationRaw === 'string' ? operationRaw : '';
    if (ALLOWED_RUNTIME_DERIVATIONS.indexOf(operation) < 0) {
      return {
        ok: false,
        result: failure(REASON.operationForbidden, {
          requestedOperation: typeof operationRaw === 'string'
            ? operationRaw.slice(0, MAX_OPERATION_ECHO_CHARS) : null,
          detail: 'allowlist=' + ALLOWED_RUNTIME_DERIVATIONS.join(',')
        })
      };
    }
    /* ③ characterId：非空字符串、有界。 */
    const characterIdRaw = own(body, 'characterId');
    const characterId = typeof characterIdRaw === 'string' ? characterIdRaw.trim() : '';
    if (!characterId || characterId.length > MAX_CHARACTER_ID_CHARS) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, detail: 'characterId-must-be-a-bounded-non-empty-string'
        })
      };
    }
    /* ④ timeoutMs：**调用方的显式权威**。刻意要求真正的 number：
         数字字符串不是权威，NaN/Infinity/<=0 也不是。 */
    const timeoutRaw = own(body, 'timeoutMs');
    if (typeof timeoutRaw !== 'number' || !isFinite(timeoutRaw) || !(timeoutRaw > 0)) {
      return {
        ok: false,
        result: failure(REASON.timeoutAuthorityMissing, {
          operation: OPERATION, characterId: characterId,
          detail: 'timeoutMs must be an explicit finite number > 0'
        })
      };
    }
    const effectiveTimeoutMs = Math.min(timeoutRaw, SAFETY_CAP_MS);
    /* ⑤ inputEnvelope：闭集 + 有界。 */
    const envelopeRaw = own(body, 'inputEnvelope');
    if (!isPlainObject(envelopeRaw)) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, detail: 'inputEnvelope-must-be-an-object'
        })
      };
    }
    const envelopeKeys = Object.keys(envelopeRaw);
    for (const key of envelopeKeys) {
      if (ENVELOPE_FIELDS.indexOf(key) < 0) {
        return {
          ok: false,
          result: failure(REASON.requestFieldForbidden, {
            operation: OPERATION, characterId: characterId, field: 'inputEnvelope.' + key,
            detail: 'inputEnvelope-is-a-closed-schema'
          })
        };
      }
    }
    const records = own(envelopeRaw, 'records');
    if (records !== undefined && (!Array.isArray(records) || records.length > MAX_ENVELOPE_RECORDS
      || records.some(function (r) { return !isPlainObject(r); }))) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId,
          detail: 'inputEnvelope.records must be an array of <= ' + MAX_ENVELOPE_RECORDS + ' objects'
        })
      };
    }
    const selectedIds = own(envelopeRaw, 'selectedIds');
    if (selectedIds !== undefined && (!Array.isArray(selectedIds) || selectedIds.length > MAX_ENVELOPE_IDS)) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId,
          detail: 'inputEnvelope.selectedIds must be an array of <= ' + MAX_ENVELOPE_IDS
        })
      };
    }
    const currentState = own(envelopeRaw, 'currentState');
    if (currentState !== undefined && !isPlainObject(currentState)) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, detail: 'inputEnvelope.currentState must be an object'
        })
      };
    }
    const roleName = own(envelopeRaw, 'roleName');
    /* 这里只把"明显不是字符串/明显超大"挡掉；真正的截断由核心做（它自己
       把 roleName 裁到 120 字符）—— 边界不复制核心的裁剪规则。 */
    if (roleName !== undefined && (typeof roleName !== 'string' || roleName.length > MAX_ROLE_NAME_CHARS * 4)) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, detail: 'inputEnvelope.roleName must be a string'
        })
      };
    }
    /* ★ 交给核心的只有这五个键，而且是**新对象**：信封里就算藏着别的
         东西（在闭集校验之后已经不可能），也不会被转发下去。 */
    return {
      ok: true,
      operation: OPERATION,
      characterId: characterId,
      timeoutMs: effectiveTimeoutMs,
      timeoutClamped: effectiveTimeoutMs !== timeoutRaw,
      requestedTimeoutMs: timeoutRaw,
      envelope: {
        selectedIds: selectedIds,
        records: records,
        evidence: own(envelopeRaw, 'evidence'),
        currentState: currentState,
        roleName: roleName
      }
    };
  }

  /* ── 角色运行时 spec（**唯一**查询点）────────────────────────────────
     §2/§6：characterId → runtime spec 只有这一条路。
     本文件**不**发明第二套 character config lookup，也不读 sqlite。 */
  function resolveCharacterSpec(characterId) {
    if (!registry || typeof registry.getCharacterSpec !== 'function') {
      return { ok: false, reason: 'registry-unavailable' };
    }
    let spec = null;
    try { spec = registry.getCharacterSpec(characterId) || null; }
    catch (_) { spec = null; }
    if (!isPlainObject(spec)) return { ok: false, reason: 'spec-missing' };
    const provider = text(spec.provider).trim();
    const model = text(spec.model).trim();
    const endpoint = text(spec.endpoint).trim();
    const credentialRef = text(spec.credentialRef).trim();
    if (!provider || !model || !endpoint || !credentialRef) {
      /* 缺任何一项都**如实**失败：拿一份不完整的 spec 去调用只会得到认证错误，
         而那条错误会伪装成"模型没给结果"。 */
      return { ok: false, reason: 'spec-incomplete' };
    }
    /* ★ 刻意**不**接受 spec.apiKey 回落（execution.js / understanding-derivation.js
       在迁移期仍然接受）：本阶段的权威是 Vault，明文回落会让
       "no plaintext fallback" 变成半真。 */
    return { ok: true, spec: { provider: provider, model: model, endpoint: endpoint, credentialRef: credentialRef } };
  }

  /* ── 单次执行（MAX_ATTEMPTS = 1，AUTO_RETRY = NONE）────────────────
     返回 { ok:true, text } 或 { ok:false, code, attempts, detail }。
     任何路径都**不重试**：不明传输失败在收费请求上重试等于替用户多花一次钱。 */
  async function invokeOnce(providerSpec, built, options) {
    const opts = options || {};
    let attempts = 0;
    let timedOut = false;
    let settled = false;
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const outer = opts.signal || null;
    let onOuterAbort = null;
    let timer = null;
    let resolveBound = null;
    const bounded = new Promise(function (resolve) { resolveBound = resolve; });

    function cleanup() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (onOuterAbort && outer) { try { outer.removeEventListener('abort', onOuterAbort); } catch (_) { /* 已移除 */ } }
    }

    /* 已经中止的请求**不发起** provider 调用（零成本）。 */
    if (outer && outer.aborted) return { ok: false, code: REASON.aborted, attempts: 0 };

    /* 服务端与调用方使用**同一个** timeout：调用方说 20s，这里就是 20s，
       不存在"浏览器 20s / 服务端 120s"的双权威。
       ★ 计时器**不**依赖 controller 是否存在：即使宿主没有 AbortController，
         "有界等待"这一条也必须成立（RUNNER_WAIT_BOUNDED 的等价物）。 */
    timer = setTimeout(function () {
      timedOut = true;
      if (controller) { try { controller.abort(); } catch (_) { /* 已中止 */ } }
      if (resolveBound && !settled) { settled = true; resolveBound(true); }
    }, opts.timeoutMs);
    if (outer) {
      onOuterAbort = function () {
        try { if (controller) controller.abort(); } catch (_) { /* 已中止 */ }
        if (resolveBound && !settled) { settled = true; resolveBound(true); }
      };
      try { outer.addEventListener('abort', onOuterAbort); } catch (_) { onOuterAbort = null; }
    }

    /* ★ 这一次调用就是**唯一**一次。请求体里的 provider/model/endpoint/apiKey
       全部来自服务端 spec；prompt 来自 R4-C 常量；调用方输入只是被解释的数据。 */
    attempts = 1;
    counters.calls += 1;
    counters.providerCalls += 1;
    const portPromise = Promise.resolve().then(function () {
      return modelPort.run({
        spec: { provider: providerSpec.provider, model: providerSpec.model, endpoint: providerSpec.endpoint, apiKey: providerSpec.secret },
        prompt: { system: built.system, messages: [{ role: 'user', content: built.user }] },
        messages: [{ role: 'user', content: built.user }],
        maxTokens: DEFAULT_MAX_TOKENS,
        jsonMode: true,
        /* 观测用标签：与 R4-C runner 的用途相同（reasoning token 归因），不含内容。 */
        consumer: CONSUMER
      }, {
        signal: controller ? controller.signal : (outer || undefined),
        /* 端口自己也有一个内部 timer；把同一个上界交给它，
           于是"服务端使用的 timeout"在两条实现上是同一个数。 */
        timeoutMs: opts.timeoutMs
      });
    });
    /* 有界等待赢了之后端口仍可能 reject；先挂一个空 catch，
       否则那会变成 unhandled rejection 噪音（与 R4-C runner 同一条纪律）。 */
    portPromise.catch(function () { /* 见上 */ });

    let res = null;
    try {
      res = await Promise.race([portPromise, bounded]);
    } catch (error) {
      cleanup();
      if (timedOut || isTimeoutError(error)) return { ok: false, code: REASON.timeout, attempts: attempts, detail: 'provider-timeout' };
      if (outer && outer.aborted) return { ok: false, code: REASON.aborted, attempts: attempts, detail: 'caller-aborted' };
      if (isAbortError(error)) return { ok: false, code: REASON.aborted, attempts: attempts, detail: 'provider-abort' };
      if (isNetworkError(error)) return { ok: false, code: REASON.network, attempts: attempts, detail: 'transport-network' };
      /* ★ provider 的**错误正文不回传**（§17）：它的 message 里可能带着
         provider 原文、中转回显，甚至把 key 抄回来。这里只保留一个可核对
         的事实 —— HTTP 状态码（NodeModelPort 会挂在 err.status 上）。 */
      const status = Number(error && error.status);
      return {
        ok: false, code: REASON.providerError, attempts: attempts,
        detail: 'provider-error' + (Number.isFinite(status) ? ' status=' + status : '')
      };
    }
    cleanup();
    if (res === true) {
      /* 有界等待到点：**本边界**的等待结束了（RUNNER_WAIT_BOUNDED 的等价物）。
         provider 是否真的停止计算取决于端口/上游是否尊重 signal ——
         这一句是本文件对"取消"的全部主张，不更多。 */
      if (outer && outer.aborted && !timedOut) return { ok: false, code: REASON.aborted, attempts: attempts, detail: 'caller-aborted' };
      return { ok: false, code: REASON.timeout, attempts: attempts, detail: 'bounded-wait-expired' };
    }
    if (outer && outer.aborted && !timedOut) return { ok: false, code: REASON.aborted, attempts: attempts, detail: 'caller-aborted' };
    return { ok: true, text: extractText(res), attempts: attempts };
  }

  /* ── 主入口：**永不抛出** ───────────────────────────────────────────── */
  async function run(body, options) {
    const opts = isPlainObject(options) ? options : {};
    const startedAt = Number(clock());
    const shape = validateRequest(body);
    if (!shape.ok) {
      counters.refused += 1;
      note('runtime-interpretation-refused', {
        code: shape.result.error, field: shape.result.field || null,
        characterId: shape.result.characterId || null
      });
      return shape.result;
    }
    const operation = shape.operation;
    const characterId = shape.characterId;
    const base = { operation: operation, characterId: characterId };
    /* 本次请求真正发生过几次 Vault 读取。信封里的 `boundary.vaultReads`
       必须报**这一次**的真实次数（而不是每个失败分支各自硬编码一个 1）：
       "审计面自述"与"实际行为"一旦可以各自漂移，这一层就不再可核对。 */
    let vaultReadsForRequest = 0;

    /* ① server cost gate —— 排在 Vault 解析**之前**：
          policy 为 false 时 provider 调用 = 0，Vault 读取也 = 0。
          §10 要求的两条前置（credential resolution / provider invocation）
         都被这一行覆盖，而且比要求更早一步（连角色目录都不读）。 */
    const policy = resolveCostPolicy(costPolicy);
    if (policy.enabled !== true) {
      counters.refused += 1;
      note('runtime-interpretation-disabled', { characterId: characterId, policySource: policy.source });
      return failure(REASON.disabled, Object.assign({}, base, {
        detail: 'server cost policy memoryInterpretationEnabled=false (source=' + policy.source + ')'
      }));
    }

    /* ② 模型端口必须在场。这一步排在角色目录/Vault **之前**：一个没有
          模型端口的宿主根本执行不了，因此不需要（也不应该）先去读凭据。 */
    if (!modelPort || typeof modelPort.run !== 'function') {
      counters.refused += 1;
      note('runtime-interpretation-port-unavailable', { characterId: characterId });
      return failure(REASON.modelPortUnavailable, Object.assign({}, base, {
        detail: 'modelPort.run is not assembled'
      }));
    }

    /* ③ 权威 runtime spec（唯一查询点）。 */
    const specResult = resolveCharacterSpec(characterId);
    if (!specResult.ok) {
      counters.refused += 1;
      note('runtime-interpretation-spec-unavailable', { characterId: characterId, reason: specResult.reason });
      return failure(REASON.runtimeSpecUnavailable, Object.assign({}, base, { detail: specResult.reason }));
    }
    const spec = specResult.spec;

    /* ④ Vault（request-scoped，唯一 resolver）。 */
    if (!credentialAccess || typeof credentialAccess.resolve !== 'function') {
      counters.refused += 1;
      note('runtime-interpretation-credential-unavailable', { characterId: characterId, reason: 'credential-access-not-assembled' });
      return failure(REASON.credentialUnavailable, Object.assign({}, base, {
        providerClass: spec.provider, modelId: spec.model, detail: 'credential-access-not-assembled'
      }));
    }
    counters.vaultReads += 1;
    vaultReadsForRequest += 1;
    let resolved = null;
    try { resolved = credentialAccess.resolve(spec.credentialRef); }
    catch (_) { resolved = null; }
    if (!resolved || resolved.ok !== true || typeof resolved.secret !== 'string' || !resolved.secret) {
      counters.refused += 1;
      note('runtime-interpretation-credential-unavailable', {
        characterId: characterId, reason: text(resolved && resolved.reason) || 'resolve-failed'
      });
      return failure(REASON.credentialUnavailable, Object.assign({}, base, {
        providerClass: spec.provider, modelId: spec.model,
        /* ★ 这一次 Vault **确实被读过一次**（上面那行计数器就是它），因此
           信封里的自述必须是 1 而不是默认的 0 —— 自述字段与实际行为不一致
           正是本阶段最不能容忍的那类缺陷（审计面撒谎比审计面缺席更糟）。
           只有"Vault 层根本没装配、连 resolve 都没调用"那条早退路径才是 0。 */
        vaultReads: vaultReadsForRequest,
        detail: text(resolved && resolved.reason) || 'resolve-failed'
      }));
    }
    /* ★ secret 的生命周期到此为止只存在于**本次请求**的局部变量里：
         它被放进下面那个临时 providerSpec，传给端口一次，然后随作用域消失。
         不进 response、不进 error detail、不进 trace / log / describe。 */
    const providerSpec = { provider: spec.provider, model: spec.model, endpoint: spec.endpoint, secret: resolved.secret };

    /* ⑤ 信封构造（R4-C 纯核心，**唯一**一份构建器）。 */
    if (!core || typeof core.buildRequest !== 'function' || typeof core.validateResponse !== 'function') {
      counters.refused += 1;
      return failure(REASON.coreMissing, Object.assign({}, base, { detail: 'R4-C core not loadable' }));
    }
    let built = null;
    try { built = core.buildRequest(shape.envelope); }
    catch (_) { return failure(REASON.requestShapeInvalid, Object.assign({}, base, { detail: 'core-build-threw' })); }
    if (!built || !built.stats || !built.stats.memoryCount) {
      /* 没有已授权的记忆可解释：如实说"没有输入"，绝不调用模型（零成本）。
         码直接取核心的既有词（no-authorized-memory），不另发明一个。 */
      counters.refused += 1;
      note('runtime-interpretation-no-input', { characterId: characterId });
      return failure(core.REASON_CODES.noInput, Object.assign({}, base, {
        providerClass: spec.provider, modelId: spec.model, vaultReads: vaultReadsForRequest
      }));
    }

    /* ⑥ 单次执行。 */
    const called = await invokeOnce(providerSpec, built, {
      signal: opts.signal || null,
      timeoutMs: shape.timeoutMs
    });
    const latencyMs = Math.max(0, Number(clock()) - startedAt);
    const modelMeta = {
      providerClass: spec.provider,
      modelId: spec.model,
      latencyMs: latencyMs
    };
    if (!called.ok) {
      counters.refused += 1;
      note('runtime-interpretation-failed', {
        characterId: characterId, outcome: called.code, providerClass: spec.provider,
        modelId: spec.model, attempts: called.attempts, durationMs: latencyMs
      });
      /* ★ detail 只可能来自我们的固定字符串或 provider 错误的首 160 字符。
         provider 错误文本里若回显了凭据（某些中转会这么干），这里仍然会把它
         带进响应 —— 因此 provider-error 的 detail 走**掩码**后再输出。 */
      return failure(called.code, Object.assign({}, base, modelMeta, {
        attempts: called.attempts,
        providerCalls: called.attempts,
        vaultReads: vaultReadsForRequest,
        requested: Array.isArray(shape.envelope.selectedIds) ? shape.envelope.selectedIds.length : 0,
        detail: redactSecret(called.detail, resolved.secret)
      }));
    }

    /* ⑦ 解析：provider 原文到此为止。浏览器只会收到**校验过**的结构化结果。 */
    const raw = called.text;
    if (typeof raw !== 'string' || !raw.trim()) {
      return failure(REASON.invalidOutput, Object.assign({}, base, modelMeta, {
        attempts: called.attempts, providerCalls: called.attempts, vaultReads: vaultReadsForRequest, detail: 'empty-provider-output'
      }));
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      return failure(REASON.invalidOutput, Object.assign({}, base, modelMeta, {
        attempts: called.attempts, providerCalls: called.attempts, vaultReads: vaultReadsForRequest, detail: 'provider-output-not-json'
      }));
    }
    if (!isPlainObject(parsed)) {
      return failure(REASON.invalidOutput, Object.assign({}, base, modelMeta, {
        attempts: called.attempts, providerCalls: called.attempts, vaultReads: vaultReadsForRequest, detail: 'provider-output-not-an-object'
      }));
    }

    /* ⑧ **同一份** R4-C validator。这里没有第二套 schema，也没有第二套枚举。 */
    const allowedIds = Array.isArray(shape.envelope.selectedIds) ? shape.envelope.selectedIds : [];
    const validated = core.validateResponse(parsed, { allowedIds: allowedIds });
    if (!validated || validated.ok !== true) {
      const code = (validated && Array.isArray(validated.reasonCodes) && validated.reasonCodes.length)
        ? validated.reasonCodes[0] : core.REASON_CODES.noItems;
      /* ★ 核心的 reasonCodes 只装"批次级"结论（no-valid-item 等），**逐条**的
         拒绝理由在 rejected[].reason 里。边界把两者合并成一份可断言的列表：
         于是"这一条到底为什么被拒"不需要调用方去翻 rejected 数组才能知道，
         而"批次级结论"也没有被丢掉。这里**不新增**任何词 —— 只是搬运。 */
      const perItem = [];
      if (validated && Array.isArray(validated.rejected)) {
        for (const entry of validated.rejected) {
          const reason = entry && entry.reason ? String(entry.reason) : null;
          if (reason && perItem.indexOf(reason) < 0) perItem.push(reason);
        }
      }
      return failure(code, Object.assign({}, base, modelMeta, {
        attempts: called.attempts, providerCalls: called.attempts, vaultReads: vaultReadsForRequest,
        requested: allowedIds.length,
        rejected: validated && validated.rejected ? validated.rejected : [],
        extraCodes: perItem
      }));
    }

    /* ⑨ 非持久结果（R4-C assembleShadow 的原始形状 + 三个审计字段）。 */
    const shadow = core.assembleShadow(shape.envelope, validated, {
      providerClass: spec.provider,
      modelId: spec.model,
      latencyMs: latencyMs,
      status: validated.items.length < allowedIds.length ? 'partial' : 'ok'
    });
    counters.succeeded += 1;
    note('runtime-interpretation-ok', {
      characterId: characterId, providerClass: spec.provider, modelId: spec.model,
      attempts: called.attempts, durationMs: latencyMs,
      returned: shadow.counts ? shadow.counts.returned : null
    });
    const result = Object.assign({}, shadow, {
      operation: operation,
      characterId: characterId,
      /* 审计：这次调用**真的**用了哪个超时（含 clamp 事实）。 */
      timeoutMs: shape.timeoutMs,
      timeoutClamped: shape.timeoutClamped === true,
      status: 200,
      /* boundary 覆盖 assembleShadow 里没有自述的那几件事；其余字段
         （durable:false / model.attempts:1 / metaMemoryState:null）来自核心。
         计数一律取本次请求的**实测值**，不硬编码。 */
      boundary: boundaryBlock(called.attempts, called.attempts, vaultReadsForRequest)
    });
    return result;
  }

  /* ── 秘密掩码：provider 错误文本里若回显了本次 secret，响应里必须是掩码 ──
     只对**本次** secret 做替换（不做宽泛正则），因此它不可能误伤正常文本。 */
  function redactSecret(detail, secret) {
    if (detail == null) return undefined;
    let out = String(detail);
    if (typeof secret === 'string' && secret.length >= 4 && out.indexOf(secret) >= 0) {
      out = out.split(secret).join('***');
    }
    return out.slice(0, 200);
  }

  function describe() {
    const policy = resolveCostPolicy(costPolicy);
    return {
      path: MEMORY_INTERPRETATION_PATH,
      operations: ALLOWED_RUNTIME_DERIVATIONS.slice(),
      transport: 'POST',
      transportScope: TRANSPORT_SCOPE,
      androidCompatibility: ANDROID_COMPATIBILITY,
      androidRuntimeBoundary: 'NOT_IMPLEMENTED',
      autoInvocation: AUTO_INVOCATION,
      executionSeam: EXECUTION_SEAM,
      runtimeOnly: true,
      durable: false,
      attempts: MAX_ATTEMPTS,
      autoRetry: AUTO_RETRY,
      timeoutAuthority: 'CALLER_EXPLICIT',
      timeoutCapMs: SAFETY_CAP_MS,
      timeoutCapSource: SAFETY_CAP_SOURCE,
      credentialAuthority: 'HOME_NODE_CHARACTER_RUNTIME_SPEC',
      credentialLayer: 'services/home-node/credential-access.js',
      credentialScope: 'REQUEST_ONLY',
      promptAuthority: 'assets/js/memory-recall/memory-interpretation-core.js#SYSTEM_INSTRUCTIONS',
      validator: 'assets/js/memory-recall/memory-interpretation-core.js#validateResponse',
      costPolicy: {
        memoryInterpretationEnabled: policy.enabled,
        source: policy.source,
        defaultEnabled: false,
        callerIntentIsNotAuthority: true,
        productionEnablePath: 'NONE_IN_THIS_PHASE'
      },
      requestFields: REQUEST_FIELDS.slice(),
      envelopeFields: ENVELOPE_FIELDS.slice(),
      counters: Object.assign({}, counters)
    };
  }

  return Object.freeze({
    path: MEMORY_INTERPRETATION_PATH,
    operations: ALLOWED_RUNTIME_DERIVATIONS,
    run: run,
    describe: describe
  });
}

module.exports = createRuntimeInterpretation;
module.exports.createRuntimeInterpretation = createRuntimeInterpretation;
module.exports.PATH = MEMORY_INTERPRETATION_PATH;
module.exports.OPERATION = OPERATION;
module.exports.ALLOWED_RUNTIME_DERIVATIONS = ALLOWED_RUNTIME_DERIVATIONS;
module.exports.REQUEST_FIELDS = REQUEST_FIELDS;
module.exports.ENVELOPE_FIELDS = ENVELOPE_FIELDS;
module.exports.AUTHORITY_BEARING_FIELDS = AUTHORITY_BEARING_FIELDS;
module.exports.REASON = REASON;
module.exports.STATUS_BY_REASON = STATUS_BY_REASON;
module.exports.CORE_CODE_MAP = CORE_CODE_MAP;
module.exports.SAFETY_CAP_MS = SAFETY_CAP_MS;
module.exports.SAFETY_CAP_SOURCE = SAFETY_CAP_SOURCE;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.AUTO_RETRY = AUTO_RETRY;
module.exports.DEFAULT_MAX_TOKENS = DEFAULT_MAX_TOKENS;
module.exports.TRANSPORT_SCOPE = TRANSPORT_SCOPE;
module.exports.ANDROID_COMPATIBILITY = ANDROID_COMPATIBILITY;
module.exports.AUTO_INVOCATION = AUTO_INVOCATION;
module.exports.EXECUTION_SEAM = EXECUTION_SEAM;
module.exports.DEFAULT_CORE = DEFAULT_CORE;
module.exports.resolveCostPolicy = resolveCostPolicy;
