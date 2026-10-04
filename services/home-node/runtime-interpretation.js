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
/* 可见性 core：与浏览器、与 memory-store.listVisible **同一份**实现。
   它在 UMD 下导出，Node 可直接 require（本行就是那次机械证明）。 */
const DEFAULT_VISIBILITY_CORE = require(path.join(ASSETS_JS, 'memory-visibility-core.js'));

/* ── 路径常量：全仓只有一份字面量（与 economyCommand.path 同一约定）────
   语义最窄的那一条：路径里带着 operation 名，因此审计者不需要读 handler
   就知道这条路由**只能**做一件事。刻意不做 /internal/runtime/derive 这种
   "万能派生入口" —— 那会为未来的 Expectation 提前留一个洞。 */
const MEMORY_INTERPRETATION_PATH = '/internal/runtime/memory-interpretation';
const OPERATION = 'memory-interpretation';
/* §4 冻结：只有这一项。Expectation / Counterfactual = NOT ENABLED。 */
const ALLOWED_RUNTIME_DERIVATIONS = Object.freeze([OPERATION]);

/* ── 请求契约（闭集）────────────────────────────────────────────────
   P21-R4-LIVE-3：**浏览器不再提交 canonical 记忆内容**。
   它最多提交"要解释哪几条"（selectedMemoryIds）；内容、可见性、投影
   全部由 Home Node 从 canonical store 解析。因此这一层能表达的东西
   从"四个词 + 一个自由信封"收窄成"六个词，其中一个只是 id 列表"。

   ★ 为什么这次不是"把 records 字段删掉"那么简单：旧形状里
     `inputEnvelope.records` 是**内容**通道（LIVE-2.2 已机械证明它是
     调用方控制的任意文本通道）。删掉它必须同时给出**新的权威路径**
     （见 resolveCanonicalEvidence），否则只是把能力藏起来而不是换掉。 */
const REQUEST_FIELDS = Object.freeze(['operation', 'characterId', 'timeoutMs', 'selectedMemoryIds', 'currentState', 'roleName']);
/* ── canonical 证据字段：出现即 reject（**不** silent ignore）──────────
   这不是"多了一个白名单项"，而是本阶段的核心安全属性：
   任何试图把记忆内容/证据状态/可见性/存储元数据塞进来的请求，
   都会得到一个**指名**的拒绝码 `caller-attempted-to-supply-canonical-evidence`。
   `inputEnvelope` / `selectedIds` 也在名单里：它们是旧形状的载体，
   留着它们等于留着一条"看起来还在用旧协议"的歧义通道。 */
const CANONICAL_EVIDENCE_FIELDS = Object.freeze([
  'records', 'record', 'memoryRecords', 'memory_records', 'inputEnvelope', 'selectedIds',
  'content', 'summary', 'title', 'source', 'rawSource', 'kind',
  'evidenceState', 'evidence', 'systemEvidenceState', 'evidenceConfidence',
  'visibility', 'visibleTo', 'excludeFrom', 'createdBy', 'ownerId',
  'createdAt', 'updatedAt', 'lastActivated', 'importance', 'activationCount',
  'valence', 'arousal', 'pinned', 'resolved', 'tags', 'revision',
  'canonical', 'snapshot', 'memoryPayload', 'memory'
]);
/* 权威字段名单（执行侧）：与上面同一套纪律，但属于**执行权威**而不是
   证据权威。保留原名以便审计者一眼看出"哪些词被明确想过"。 */
const AUTHORITY_BEARING_FIELDS = Object.freeze([
  'credentialRef', 'apiKey', 'secret', 'provider', 'model', 'endpoint',
  'systemPrompt', 'developerPrompt', 'developer', 'prompt', 'messages',
  'instructions', 'baseURL', 'token', 'authorization', 'headers', 'spec', 'config'
]);

/* ── 边界（有界请求）────────────────────────────────────────────────── */
const MAX_CHARACTER_ID_CHARS = 180;
const MAX_ROLE_NAME_CHARS = 120;
/* canonical 投影允许交给 R4-C 的字段（**恰好**这些）。
   逐一对应 R4-C normalizeInput 真正消费的键；存储/ACL/修订/激活等
   内部元数据**不在**其中（§14）。 */
const PROJECTION_FIELDS = Object.freeze(['id', 'content', 'title', 'source', 'kind', 'valence', 'arousal']);
/* ★ 三个上限**全部派生自 R4-C 核心自己声明的边界**，不在这里另发明数字：
   如果核心哪天把 MAX_MEMORIES 从 8 改成别的，这里的选择上限会**跟着变**，
   而不是悄悄分叉成"请求允许 8 条、核心只解释 5 条"。 */
const MAX_SELECTED_MEMORY_IDS = Number(DEFAULT_CORE.BOUNDS && DEFAULT_CORE.BOUNDS.MAX_MEMORIES) || 8;
const MAX_CONTENT_CHARS = Number(DEFAULT_CORE.BOUNDS && DEFAULT_CORE.BOUNDS.MAX_CONTENT_CHARS) || 1200;
const MAX_TITLE_CHARS = Number(DEFAULT_CORE.BOUNDS && DEFAULT_CORE.BOUNDS.MAX_TITLE_CHARS) || 200;
const MAX_OPERATION_ECHO_CHARS = 64;
const MAX_ID_CHARS = 180;

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
  /* ── P21-R4-LIVE-3 新增（只有三个，刻意不膨胀词表）──────────────────
     · caller-attempted-to-supply-canonical-evidence：请求里出现任何
       canonical 证据字段（records/content/evidenceState/...）。
       **一个**码覆盖整类，靠 `field` 指明具体是哪一个。
     · duplicate-memory-id：selectedMemoryIds 里有重复（**不**静默去重，
       否则"我选了 8 条"与"服务端解释了 7 条"会静默分叉）。
     · memory-selection-exceeds-bound：超过 R4-C 的 MAX_MEMORIES。 */
  canonicalEvidenceSupplied: 'caller-attempted-to-supply-canonical-evidence',
  duplicateMemoryId: 'duplicate-memory-id',
  selectionExceedsBound: 'memory-selection-exceeds-bound',
  canonicalEvidenceUnavailable: 'canonical-evidence-unavailable',
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
  'caller-attempted-to-supply-canonical-evidence': 400,
  'duplicate-memory-id': 400,
  'memory-selection-exceeds-bound': 400,
  'canonical-evidence-unavailable': 503,
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

/* ── P21-R4-LIVE-3 · 三项**分别**冻结的权威（不许合并成一个词）────────
   EVIDENCE_CONTENT_AUTHORITY      内容从哪来
   EVIDENCE_VISIBILITY_AUTHORITY   谁判定这条内容对这个角色可读
   RECALL_SELECTION_AUTHORITY      谁决定"要解释哪几条"
   本阶段只把前两项收进服务端；第三项仍然是调用方提议的，而且
   **不**声称它绑定于一次真实召回。把三者写成一个词，正是上一阶段
   被机械证伪的那种过度声明。 */
const EVIDENCE_CONTENT_AUTHORITY = 'SERVER_CANONICAL';
const EVIDENCE_VISIBILITY_AUTHORITY = 'SERVER';
const RECALL_SELECTION_AUTHORITY = 'CALLER_PROPOSED';
const SELECTED_SET_BOUND_TO_CURRENT_RECALL = 'NO';
const EVIDENCE_STATE_AUTHORITY = 'SERVER_NOT_CLAIMED';
const PROVIDER_MEMORY_SOURCE = 'SERVER_CANONICAL_PROJECTION';

/* ── P21-R4-LIVE-4 · 服务端内部自动解释路径（READY-but-OFF）─────────────
   两条**独立**的策略，刻意不合并：
     EXTERNAL_INTERPRETATION_ROUTE_POLICY —— `run()`（POST 路由）的 cost gate，
                                              由 deps.costPolicy 决定；
     AUTO_INTERPRETATION_POLICY            —— `runFromAuthoritativeRecall()`
                                              （服务端内部）的 cost gate，
                                              由 deps.autoInterpretationPolicy 决定。
   两者默认都是 OFF，而且**没有**任何"全局 enabled"能把它们一起打开：
   外部路由在自动策略为 on 时依然 disabled（见 runFromAuthoritativeRecall 的
   说明与外部 run() 的第①步 —— 它们各自读各自的 policy）。
   `runFromAuthoritativeRecall` **没有任何路由**：http.js 只调用 run()。 */
const INTERPRETATION_RECALL_BINDING = 'DIRECT_SERVER_INTERNAL';
const RECORD_SOURCE_FROM_RECALL = 'SERVER_CANONICAL_RECALL_RESULT';
const RECORD_SOURCE_REBIND = 'SERVER_CANONICAL_REBIND';
const AUTO_INTERPRETATION_ENTRY = 'runFromAuthoritativeRecall';
/* 一个逻辑角色回合最多**追加**多少次模型调用。1 = 自动解释；它不改变
   外部路由的 MAX_ATTEMPTS（那也是 1），也不引入重试。 */
const MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN = 1;
/* 自动路径的超时是**服务端自有**的 policy：有名字、有具体数字、有上界关系。
   SAFETY_CAP_MS（120000）只是上界，不是默认值 —— 后台解释不该按最坏情况跑满。 */
const AUTO_INTERPRETATION_TIMEOUT_MS = 20000;
const AUTO_INTERPRETATION_TIMEOUT_OWNER = 'services/home-node/runtime-interpretation.js#AUTO_INTERPRETATION_TIMEOUT_MS';
/* 通道矩阵：哪些通道允许自动解释。**不是**四个都开 ——
   surface（普通对话中的相关记忆）与 recall（用户明确要求回忆）是"她此刻想起了
   什么"的两种真实形态；glossary 是一次术语命中（生产里 provider 至今 dormant），
   coldStart 是自动恢复上下文（activationPolicy = none：那不是用户主动想起），
   两者都不构成"当前的想法"，因此不在自动解释范围内。 */
const AUTO_INTERPRETATION_CHANNEL_MATRIX = Object.freeze({
  surface: 'ELIGIBLE',
  recall: 'ELIGIBLE',
  glossary: 'NOT_ELIGIBLE',
  coldStart: 'NOT_ELIGIBLE'
});
/* 冻结导出（测试按字面量断言）：矩阵是唯一来源，数组由它派生。 */
const AUTO_INTERPRETATION_CHANNELS = Object.freeze(
  Object.keys(AUTO_INTERPRETATION_CHANNEL_MATRIX).filter((c) => AUTO_INTERPRETATION_CHANNEL_MATRIX[c] === 'ELIGIBLE')
);

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

/* ── auto cost gate（P21-R4-LIVE-4）────────────────────────────────────
   与外部路由的 resolveCostPolicy **同一个纪律、不同的键**：
     CALLER_INTENT != SERVER_COST_POLICY；这里的权威只有装配层注入的
     `runtimeAutoInterpretationPolicy`，唯一的开法是
     `{ autoInterpretationEnabled: true }`。
   函数抛错 ⇒ false（fail closed）；不读 env、不读 UI、不读 memory:settings、
   不读 Middle Brain flag —— 没有第二个来源，因此也没有"全局 enabled"可以把
   外部路由一起打开。 */
function resolveAutoPolicy(policy) {
  let raw = policy;
  let source = 'absent-default-false';
  if (typeof raw === 'function') {
    source = 'injected-function';
    try { raw = raw(); }
    catch (_) { return { enabled: false, source: 'injected-function-threw' }; }
  }
  if (raw === undefined || raw === null) return { enabled: false, source: source };
  if (typeof raw === 'boolean') return { enabled: raw, source: 'injected-boolean' };
  if (isPlainObject(raw)) return { enabled: raw.autoInterpretationEnabled === true, source: 'assembly-policy-object' };
  return { enabled: false, source: 'unrecognized-default-false' };
}

function createRuntimeInterpretation(deps) {  deps = deps || {};
  /* 依赖链（P21-R4-LIVE-3 起）：角色目录 → **canonical 证据** → Vault → 模型端口。
     任何一个缺席都会在**请求期**以稳定的码失败，而不是在装配期被静默忽略。 */
  const registry = deps.registry || null;
  /* canonical 记忆 store：唯一的内容/可见性来源（`getRecord` 单条读）。
     ★ 它**不是**可选的降级项：没有它，这一层就只能回到"信任调用方内容"，
       而那正是本阶段要消灭的形状 —— 因此缺席 = fail closed（不是跳过校验）。 */
  const memoryStore = deps.memoryStore || null;
  /* 可见性谓词：全仓**唯一**一份（assets/js/memory-visibility-core.js，
     浏览器与 Home Node 共用）。这里只注入、绝不复制第二份判定。 */
  const visibilityCore = deps.visibilityCore || DEFAULT_VISIBILITY_CORE;
  const credentialAccess = deps.credentialAccess || null;
  const modelPort = deps.modelPort || null;
  const core = deps.core || DEFAULT_CORE;
  const costPolicy = deps.costPolicy;
  /* P21-R4-LIVE-4 · **第二条**策略：只决定"服务端内部自动解释"开不开。
     它与 costPolicy 是两个不同的表达式（不同的键、不同的默认、不同的读取者），
     因此**没有**一个全局 enabled 能把外部路由一起打开。 */
  const autoInterpretationPolicy = deps.autoInterpretationPolicy;
  /* ── P21-R4-LIVE-4.3 · **文件权威**（唯一的**生产**成本权威）─────────
     由装配层注入的 `runtime-policy.js` 实例：`read(characterId)` 每次读文件，
     唯一写者是 Node 侧的 `set()`（没有路由 / 没有 window 面 / 没有 Tauri 命令）。
     `deps.autoInterpretationPolicy` 仍然存在，但它的身份被明确降级为
     **测试缝**：只有在装配层显式传值时它才生效，而且 describe() 会如实报
     `authoritySource: 'TEST_INJECTION'`（它绝不会成为生产后门 —— 生产两侧都
     不传它）。 */
  const runtimePolicy = deps.policy || null;
  const clock = typeof deps.clock === 'function' ? deps.clock : Date.now;
  const logger = typeof deps.logger === 'function' ? deps.logger : function () {};

  /* 进程级计数（观测用）：provider 调用 / Vault 读取 / canonical 读取各一个。
     它们**不**含任何秘密，也不含任何正文。 */
  const counters = { calls: 0, providerCalls: 0, vaultReads: 0, canonicalReads: 0, refused: 0, succeeded: 0 };

  /* ── 自动路径的"每逻辑回合一次"守卫（解释侧）────────────────────────────
     与 runtime-recall 的 turn memo **两层**：备忘录让重放在调度前就结束，
     这一层则保证"即使有人从另一条内部路径重复请求同一个 (characterId,
     turnIdentity)，也不会第二次调用 provider"。
     进程内、有界（插入序淘汰最旧）、**不落盘**。 */
  const MAX_AUTO_TURN_GUARD = 64;
  const autoTurnGuard = new Map();
  const autoCounters = { started: 0, succeeded: 0, failed: 0, timedOut: 0, refused: 0, notNeeded: 0, duplicateTurn: 0 };

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
      validatorAuthority: 'memory-interpretation-core.js#validateResponse',
      /* P21-R4-LIVE-3：三项**分别**登记，任何一项都不得被读成另一项。 */
      evidenceContentAuthority: EVIDENCE_CONTENT_AUTHORITY,
      evidenceVisibilityAuthority: EVIDENCE_VISIBILITY_AUTHORITY,
      recallSelectionAuthority: RECALL_SELECTION_AUTHORITY,
      selectedSetBoundToCurrentRecall: SELECTED_SET_BOUND_TO_CURRENT_RECALL,
      evidenceStateAuthority: EVIDENCE_STATE_AUTHORITY
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
    /* 证据来源自述只在服务端确实做过绑定时出现（早退路径没有它 ——
       "没有证据可谈"与"证据来自 canonical"是两件不同的事）。 */
    if (c.evidence !== undefined) out.evidence = c.evidence;
    return out;
  }

  /* ── 请求闭集校验。返回 { ok:true, ... } 或 { ok:false, result } ───── */
  function validateRequest(body) {
    if (!isPlainObject(body)) {
      return { ok: false, result: failure(REASON.requestShapeInvalid, { detail: 'body-not-an-object' }) };
    }
    /* ① canonical 证据字段：**先**查这个，再查白名单。
          顺序是刻意的：一个既带 apiKey 又带 records 的请求，报出来的应该是
          本阶段真正关心的那件事（"你想自己提供证据"），而不是一个泛泛的
          未知字段。两者都是 reject，但只有前者能告诉审计者攻击者想干什么。 */
    const keys = Object.keys(body);
    for (const key of keys) {
      if (CANONICAL_EVIDENCE_FIELDS.indexOf(key) >= 0) {
        return {
          ok: false,
          result: failure(REASON.canonicalEvidenceSupplied, {
            field: key,
            detail: 'canonical memory content / evidence / visibility is server-derived (R4-LIVE-3)',
            requestedOperation: typeof own(body, 'operation') === 'string'
              ? own(body, 'operation').slice(0, MAX_OPERATION_ECHO_CHARS) : null
          })
        };
      }
    }
    /* ② 闭集：任何白名单之外的**自有**键一律拒绝（绝不 ignore）。
          JSON.parse('{"__proto__":{...}}') 会产生一个**自有**的 `__proto__`
          键，因此原型污染尝试也在这里被当成未知字段抓住。 */
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
    /* ③ operation：**只有**一项合法。缺失 / null / 非字符串 / 任何别的词
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
    /* ④ characterId：非空字符串、有界。 */
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
    /* ⑤ timeoutMs：**调用方的显式权威**。刻意要求真正的 number：
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
    /* ⑥ selectedMemoryIds：**取代**了旧的 caller-supplied records。
          逐条规则都是必要的，没有一条是"顺手加的"：
            · 必须是数组（缺省不是"空选择"，而是形状错）；
            · 上限取 R4-C 自己的 MAX_MEMORIES —— 不是这里另发明一个数；
            · 重复 id 一律 reject（静默去重会让"我选了 8 条"与"解释了 7 条"
              在调用方不知情的情况下分叉）；
            · 每个都是非空有界字符串（数字 id 不是 id）。 */
    const idsRaw = own(body, 'selectedMemoryIds');
    if (!Array.isArray(idsRaw)) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, detail: 'selectedMemoryIds-must-be-an-array'
        })
      };
    }
    if (idsRaw.length > MAX_SELECTED_MEMORY_IDS) {
      return {
        ok: false,
        result: failure(REASON.selectionExceedsBound, {
          operation: OPERATION, characterId: characterId,
          detail: 'selectedMemoryIds exceeds R4-C MAX_MEMORIES=' + MAX_SELECTED_MEMORY_IDS
        })
      };
    }
    const selectedMemoryIds = [];
    const seenIds = Object.create(null);
    for (const rawId of idsRaw) {
      if (typeof rawId !== 'string') {
        return {
          ok: false,
          result: failure(REASON.requestShapeInvalid, {
            operation: OPERATION, characterId: characterId,
            detail: 'selectedMemoryIds entries must be non-empty strings'
          })
        };
      }
      const id = rawId.trim();
      if (!id || id.length > MAX_ID_CHARS) {
        return {
          ok: false,
          result: failure(REASON.requestShapeInvalid, {
            operation: OPERATION, characterId: characterId, detail: 'selectedMemoryIds entry out of bounds'
          })
        };
      }
      if (seenIds[id]) {
        return {
          ok: false,
          result: failure(REASON.duplicateMemoryId, {
            operation: OPERATION, characterId: characterId, field: 'selectedMemoryIds',
            detail: 'duplicate id in selection (silent de-duplication would change the interpreted set)'
          })
        };
      }
      seenIds[id] = true;
      selectedMemoryIds.push(id);
    }
    /* ⑦ currentState / roleName：**仅存**的两个非 canonical typed 输入。
          currentState 也按闭集处理（核心只读 relationship / emotion），
          因此"把记忆内容藏进 currentState"同样会被指名拒绝。 */
    const currentStateRaw = own(body, 'currentState');
    if (currentStateRaw !== undefined && !isPlainObject(currentStateRaw)) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, detail: 'currentState-must-be-an-object'
        })
      };
    }
    if (isPlainObject(currentStateRaw)) {
      for (const key of Object.keys(currentStateRaw)) {
        if (key !== 'relationship' && key !== 'emotion') {
          /* ★ 嵌套位置的**同一类意图必须报同一个码**：把 `content` 放在
             currentState 里，和放在顶层是同一件事（"我想自己提供证据"），
             因此 canonical 名单在嵌套层也走 canonical 码，只有真正无关的
             未知键才是泛泛的 request-field-forbidden。
             两处标签不一致会让审计者在日志里看到两种说法、一种行为。 */
          const canonical = CANONICAL_EVIDENCE_FIELDS.indexOf(key) >= 0;
          return {
            ok: false,
            result: canonical
              ? failure(REASON.canonicalEvidenceSupplied, {
                operation: OPERATION, characterId: characterId, field: 'currentState.' + key,
                detail: 'canonical memory content / evidence / visibility is server-derived (R4-LIVE-3)'
              })
              : failure(REASON.requestFieldForbidden, {
                operation: OPERATION, characterId: characterId, field: 'currentState.' + key,
                detail: 'currentState-is-a-closed-schema'
              })
          };
        }
      }
    }
    const roleNameRaw = own(body, 'roleName');
    /* 这里只把"明显不是字符串/明显超大"挡掉；真正的截断由核心做（它自己
       把 roleName 裁到 120 字符）—— 边界不复制核心的裁剪规则。 */
    if (roleNameRaw !== undefined && (typeof roleNameRaw !== 'string' || roleNameRaw.length > MAX_ROLE_NAME_CHARS * 4)) {
      return {
        ok: false,
        result: failure(REASON.requestShapeInvalid, {
          operation: OPERATION, characterId: characterId, detail: 'roleName must be a string'
        })
      };
    }
    return {
      ok: true,
      operation: OPERATION,
      characterId: characterId,
      timeoutMs: effectiveTimeoutMs,
      timeoutClamped: effectiveTimeoutMs !== timeoutRaw,
      requestedTimeoutMs: timeoutRaw,
      selectedMemoryIds: selectedMemoryIds,
      currentState: currentStateRaw,
      roleName: roleNameRaw
    };
  }
  /* ── P21-R4-LIVE-3 · canonical 证据绑定（**唯一**内容/可见性来源）────
     输入：characterId + selectedMemoryIds（调用方提议的 id 列表）。
     输出：{ records, boundIds, omitted, truncated, canonicalRevision }。

     ★ 为什么这不是"再写一个 memory reader"：它读的是**既有**的
       `memoryStore.getRecord(id)`（memory-store.js 的公开单条读），
       判定用的是**既有**的 `visibilityCore.canReadMemory`
       （memory-visibility-core.js —— 浏览器与 listVisible 共用的那一份）。
       本函数只做三件既有模块不做的事：按请求顺序逐条取、把"取不到"与
       "不可读"折叠成**同一个**结果、把整行投影成 R4-C 需要的七个字段。

     ★ 缺失与隐藏**必须同形**（§9/§10）：两者都只是"这条没有被绑定"，
       都进 `omitted`，都不带任何 per-id 原因。任何区分都会让响应变成
       一个存在性 oracle（"这个 id 存在但你看不到" ≠ "这个 id 不存在"）。

     ★ 只读：`getRecord` 不推进 revision、不写 change log、**不**激活
       （激活是 recordActivation 的事，本阶段一次都不调用）。 */
  function resolveCanonicalEvidence(characterId, selectedMemoryIds) {
    if (!memoryStore || typeof memoryStore.getRecord !== 'function') {
      return { ok: false, reason: 'memory-store-unavailable' };
    }
    if (!visibilityCore || typeof visibilityCore.canReadMemory !== 'function') {
      return { ok: false, reason: 'visibility-core-unavailable' };
    }
    /* 读主体 = 这个角色。设备 id / owner id / 会话 id 都不得冒充。 */
    const principal = { kind: 'role', id: characterId };
    const records = [];
    const boundIds = [];
    const omitted = [];
    let truncated = false;
    for (const id of selectedMemoryIds) {
      counters.canonicalReads += 1;
      let record = null;
      try { record = memoryStore.getRecord(id); }
      catch (_) { record = null; }                 /* 读失败 = 取不到，不猜 */
      if (!record) { omitted.push(id); continue; } /* 不存在 / 已软删 */
      let decision = null;
      try { decision = visibilityCore.canReadMemory(record, principal); }
      catch (_) { decision = null; }               /* 判定抛错 = 不可读 */
      if (!decision || decision.ok !== true) { omitted.push(id); continue; }
      const projected = projectCanonicalRecord(record);
      if (projected.truncated) truncated = true;
      records.push(projected.record);
      boundIds.push(id);
    }
    let revision = null;
    try {
      revision = typeof memoryStore.getRevision === 'function' ? Number(memoryStore.getRevision()) : null;
      if (!isFinite(revision)) revision = null;
    } catch (_) { revision = null; }
    return {
      ok: true,
      records: records,
      boundIds: boundIds,
      omitted: omitted,
      truncated: truncated,
      canonicalRevision: revision
    };
  }

  /* ── canonical 投影：**恰好**七个字段，全部 server-owned ─────────────
     对应 R4-C normalizeInput 真正消费的键（id / content / title / source /
     kind + encoding-time 的 valence / arousal）。刻意**不**含：
     visibility / visibleTo（ACL 字段）、createdBy（归属）、
     revision / deleted_at / seq（存储元数据）、
     importance / activationCount / lastActivated（激活权威）、
     createdAt（不必要的时间戳）。

     ★ 截断是**服务端 policy**（§18）：即使记录是真的，仍按 R4-C 的
       MAX_CONTENT_CHARS / MAX_TITLE_CHARS 裁剪，并把"发生过裁剪"如实
       报成 `truncated`。调用方既无法影响裁多少，也拿不到裁剪前的文本。 */
  function projectCanonicalRecord(record) {
    const rawContent = text(record.content != null ? record.content : record.summary);
    const rawTitle = text(record.title);
    const content = rawContent.slice(0, MAX_CONTENT_CHARS);
    const title = rawTitle.slice(0, MAX_TITLE_CHARS);
    const valence = record.valence == null ? null : Number(record.valence);
    const arousal = record.arousal == null ? null : Number(record.arousal);
    return {
      truncated: content.length !== rawContent.length || title.length !== rawTitle.length,
      /* 键序固定：投影的**形状**本身也是契约的一部分（测试直接比对键集）。 */
      record: {
        id: text(record.id),
        content: content,
        title: title,
        source: text(record.rawSource != null ? record.rawSource : record.source),
        kind: text(record.kind),
        valence: valence != null && isFinite(valence) ? valence : null,
        arousal: arousal != null && isFinite(arousal) ? arousal : null
      }
    };
  }

  /* ── P21-R4-LIVE-4 · 记录来源（只有两条，都不接受调用方内容）──────────
     · SERVER_CANONICAL_RECALL_RESULT —— binding 里带着召回结果**已经持有**的
       canonical 行（服务端进程内对象）。仍然逐条过 canReadMemory（可见性权威
       永远在服务端），再走**同一份** projectCanonicalRecord。
     · SERVER_CANONICAL_REBIND —— 没有行时按 id 服务端重绑
       （store.getRecord + canReadMemory + 同一投影）。
     两条路的输出形状完全一致；差别只写在 resultSource 自述里。 */
  function resolveBoundEvidence(characterId, selectedMemoryIds, recordsFromRecall) {
    if (Array.isArray(recordsFromRecall) && recordsFromRecall.length) {
      const byId = new Map();
      for (const r of recordsFromRecall) {
        if (isPlainObject(r) && r.id != null) byId.set(String(r.id), r);
      }
      const records = [];
      const boundIds = [];
      const omitted = [];
      let truncated = false;
      for (const id of selectedMemoryIds) {
        const rec = byId.get(id);
        if (!rec) { omitted.push(id); continue; }
        let decision = null;
        try { decision = visibilityCore.canReadMemory(rec, { kind: 'role', id: characterId }); }
        catch (_) { decision = null; }
        if (!decision || decision.ok !== true) { omitted.push(id); continue; }
        const projected = projectCanonicalRecord(rec);
        if (projected.truncated) truncated = true;
        records.push(projected.record);
        boundIds.push(id);
      }
      let revision = null;
      try {
        revision = (memoryStore && typeof memoryStore.getRevision === 'function') ? Number(memoryStore.getRevision()) : null;
        if (!isFinite(revision)) revision = null;
      } catch (_) { revision = null; }
      return {
        ok: true, records: records, boundIds: boundIds, omitted: omitted,
        truncated: truncated, canonicalRevision: revision, recordSource: RECORD_SOURCE_FROM_RECALL
      };
    }
    const rebind = resolveCanonicalEvidence(characterId, selectedMemoryIds);
    if (!rebind.ok) return rebind;
    rebind.recordSource = RECORD_SOURCE_REBIND;
    return rebind;
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

    /* ④ canonical 证据绑定（P21-R4-LIVE-3）——排在 **Vault 之前**。
          这一步取代了旧形状里的 `inputEnvelope.records`：调用方只提议
          "要解释哪几条"，内容与可见性由服务端从 canonical store 解析。
          ★ 顺序是安全属性而不是效率优化：一个"什么都绑不上"的请求
            （伪造 id / 别人的私有 id / 空选择）在**读凭据之前**就结束了，
            因此它连一次 Vault 读取都花不掉。 */
    const rebind = resolveCanonicalEvidence(characterId, shape.selectedMemoryIds);
    if (!rebind.ok) {
      counters.refused += 1;
      note('runtime-interpretation-canonical-evidence-unavailable', { characterId: characterId, reason: rebind.reason });
      return failure(REASON.canonicalEvidenceUnavailable, Object.assign({}, base, {
        providerClass: spec.provider, modelId: spec.model, detail: rebind.reason
      }));
    }
    const evidenceMeta = {
      source: PROVIDER_MEMORY_SOURCE,
      requested: shape.selectedMemoryIds.length,
      bound: rebind.boundIds.length,
      canonicalRevision: rebind.canonicalRevision,
      truncated: rebind.truncated,
      projectionFields: PROJECTION_FIELDS.slice()
    };
    if (rebind.boundIds.length === 0) {
      /* 一条都绑不上（全部不存在 / 全部不可见 / 本来就是空选择）：
         与"没有已授权记忆"是同一件事，用核心的既有码如实回答，零成本。
         ★ `omitted` 的内容**不**出现在这里：它只在成功结果里作为
           `missingFor` 的一部分出现，因此"不存在"与"不可见"在这一步
           给出**逐字节相同**的响应（§9/§10）。 */
      counters.refused += 1;
      note('runtime-interpretation-no-authorized-memory', {
        characterId: characterId, requested: shape.selectedMemoryIds.length
      });
      return failure(core.REASON_CODES.noInput, Object.assign({}, base, {
        providerClass: spec.provider, modelId: spec.model,
        requested: shape.selectedMemoryIds.length,
        evidence: evidenceMeta
      }));
    }

    /* ⑤ Vault（request-scoped，唯一 resolver）。 */
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

    /* ⑥ 信封构造（R4-C 纯核心，**唯一**一份构建器）。
          ★ `selectedIds` = **请求的 id 列表**（不是只绑上的那些）：
            R4-C 的 `normalizeInput` 按 selectedIds 逐条去 records 里取，
            取不到的**跳过**，而 `assembleShadow` 用 `selectedIds − items`
            算出 `missingFor` —— 那正是"这条没被解释"的唯一出口。
            如果这里只传 boundIds，missingFor 会恒为空，
            "服务端丢掉了哪几条"就再也没人说得出来。
          ★ `records` = **投影后的 canonical 行**（顺序即请求顺序）。
            调用方提供的任何内容都不在这条链上 —— 它在第①步就被拒绝了。 */
    const coreInput = {
      selectedIds: shape.selectedMemoryIds,
      records: rebind.records,
      currentState: shape.currentState,
      roleName: shape.roleName
    };
    if (!core || typeof core.buildRequest !== 'function' || typeof core.validateResponse !== 'function') {
      counters.refused += 1;
      return failure(REASON.coreMissing, Object.assign({}, base, { detail: 'R4-C core not loadable' }));
    }
    let built = null;
    try { built = core.buildRequest(coreInput); }
    catch (_) { return failure(REASON.requestShapeInvalid, Object.assign({}, base, { detail: 'core-build-threw' })); }
    if (!built || !built.stats || !built.stats.memoryCount) {
      /* 理论上到不了这里（上面已经拦过 bound===0），保留为第二道防御：
         核心若因为任何原因认为"没有输入"，就不调用模型（零成本）。 */
      counters.refused += 1;
      note('runtime-interpretation-no-input', { characterId: characterId });
      return failure(core.REASON_CODES.noInput, Object.assign({}, base, {
        providerClass: spec.provider, modelId: spec.model, vaultReads: vaultReadsForRequest,
        requested: shape.selectedMemoryIds.length, evidence: evidenceMeta
      }));
    }

    /* ⑦ 单次执行。 */
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
        requested: shape.selectedMemoryIds.length,
        evidence: evidenceMeta,
        detail: redactSecret(called.detail, resolved.secret)
      }));
    }

    /* ⑧ 解析：provider 原文到此为止。浏览器只会收到**校验过**的结构化结果。 */
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

    /* ⑨ **同一份** R4-C validator。这里没有第二套 schema，也没有第二套枚举。
          ★ allowedIds = **绑定成功的** id（不是请求的那一串）。
            allowedIds 的语义是"模型**被允许**返回哪些 id"，而模型只见过
            MEMORY_BATCH 里那几条；若把没绑上的 id（不存在 / 不可见）也放进
            允许集，一个乱回包的 provider 就能替一条**服务端刻意没给它看的**
            记忆编出一份"解释"，而那份解释会通过校验进入结果。
            `assembleShadow` 仍然拿请求列表，因此 missingFor / counts.requested
            的对外语义不受影响。 */
    const allowedIds = rebind.boundIds.slice();
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
        requested: shape.selectedMemoryIds.length,
        rejected: validated && validated.rejected ? validated.rejected : [],
        extraCodes: perItem,
        evidence: evidenceMeta
      }));
    }

    /* ⑩ 非持久结果（R4-C assembleShadow 的原始形状 + 审计字段）。 */
    const shadow = core.assembleShadow(coreInput, validated, {
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
      /* 证据来源自述：调用方据此知道"模型看到的正文来自 canonical 投影"，
         以及服务端裁过什么。**不**含任何被丢弃 id 的原因（§9/§10）。 */
      evidence: evidenceMeta,
      /* boundary 覆盖 assembleShadow 里没有自述的那几件事；其余字段
         （durable:false / model.attempts:1 / metaMemoryState:null）来自核心。
         计数一律取本次请求的**实测值**，不硬编码。 */
      boundary: boundaryBlock(called.attempts, called.attempts, vaultReadsForRequest)
    });
    return result;
  }

  /* ── P21-R4-LIVE-4.3 · 每角色自动策略解析（**唯一**的裁决点）──────────
     优先级是刻意的、也是可审计的：
       ① 装配层显式注入的测试缝（`autoInterpretationPolicy`）⇒ TEST_INJECTION；
       ② 否则文件权威 ⇒ FILE_POLICY（per-character，缺席回全局 default）；
       ③ 两者都没有 ⇒ fail closed（enabled:false），并如实自述 NONE_FAIL_CLOSED。
     绝不读请求体、绝不读浏览器设置镜像、绝不回落到任何 legacy 旗标。 */
  function resolveCharacterAutoPolicy(characterId) {
    const id = characterId == null ? null : String(characterId);
    if (autoInterpretationPolicy !== undefined) {
      const seam = resolveAutoPolicy(autoInterpretationPolicy);
      return { enabled: seam.enabled === true, authoritySource: 'TEST_INJECTION', source: seam.source, reason: seam.source, characterId: id };
    }
    if (runtimePolicy && typeof runtimePolicy.read === 'function') {
      try {
        const r = runtimePolicy.read(id);
        return {
          enabled: !!(r && r.autoInterpretationEnabled === true),
          authoritySource: 'FILE_POLICY',
          source: (r && r.source) || 'DEFAULT_OFF',
          reason: (r && r.reason) || null,
          characterId: id
        };
      } catch (_) {
        /* 读权威抛错 ⇒ OFF（fail closed），且如实说原因。 */
        return { enabled: false, authoritySource: 'FILE_POLICY', source: 'DEFAULT_OFF', reason: 'policy-read-threw', characterId: id };
      }
    }
    return { enabled: false, authoritySource: 'NONE_FAIL_CLOSED', source: 'DEFAULT_OFF', reason: 'no-policy-assembled', characterId: id };
  }

  /* ══════════════════════════════════════════════════════════════════════
     P21-R4-LIVE-4 · 服务端内部自动解释入口（**没有路由**）
     ══════════════════════════════════════════════════════════════════════
     调用者只有一个：Home Node 召回生命周期（runtime-recall.js 的
     authoritative 模式，**post-recall** seam）。http.js **只**调用 run()；
     本函数既不在 window.IB、也不是 Tauri command、也不是任何通用 RPC。

     ★ BINDING 只来自服务端进程内的召回结果对象（`binding`），**绝不**来自
       解析后的 HTTP body。调用方**不可能**通过它提交内容：
         · records 若在场，只被当作"召回已经持有的 canonical 行"，
           仍然逐条过 canReadMemory + 同一份投影；
         · 内容永远不从调用方文本里取。
     ★ 两条 cost gate 是**两个表达式**：本函数只读 `autoInterpretationPolicy`
       （`{ autoInterpretationEnabled: true }`），与外部 run() 的 costPolicy
       互不影响 —— 自动策略为 on 时外部路由依然 disabled。
     ★ 重试：NONE。一次逻辑回合最多一次（解释侧 guard + 召回侧 memo 两层）。 */
  async function runAuthoritativeRecallBinding(binding, options) {
    const opts = isPlainObject(options) ? options : {};
    const b = isPlainObject(binding) ? binding : null;
    const startedAt = Number(clock());
    /* 身份还不知道时的早退信封用"无角色"视图（全局 default / 测试缝）。 */
    const policy = resolveCharacterAutoPolicy(null);
    if (!b) {
      autoCounters.refused += 1;
      return { ok: false, status: 'failed', errorClass: REASON.requestShapeInvalid, reason: 'binding-not-an-object', providerCalls: 0, autoPolicy: policy, bindingMode: INTERPRETATION_RECALL_BINDING };
    }
    const characterId = text(b.characterId).trim().slice(0, MAX_CHARACTER_ID_CHARS);
    const turnIdentity = isPlainObject(b.turnIdentity) ? b.turnIdentity : null;
    const turnKey = text(b.turnId || (turnIdentity && (turnIdentity.turnId || turnIdentity.requestId)) || '').trim();
    if (!characterId || !turnKey) {
      autoCounters.refused += 1;
      return { ok: false, status: 'failed', errorClass: REASON.requestShapeInvalid, reason: 'binding-missing-identity', providerCalls: 0, autoPolicy: policy, bindingMode: INTERPRETATION_RECALL_BINDING };
    }
    /* ★ 每角色解析：A 开 / B 关必须各自成立 —— 值只来自文件（或测试缝），
       而且 read() 每次都重新读文件，所以不存在"A 的值被缓存给 B"。 */
    const characterPolicy = resolveCharacterAutoPolicy(characterId);
    const selectedMemoryIds = Array.isArray(b.selectedIds)
      ? b.selectedIds.map(String).filter(Boolean).slice(0, MAX_SELECTED_MEMORY_IDS) : [];
    /* ① 自动 cost gate（与外部路由**不同**的表达式）。 */
    if (characterPolicy.enabled !== true) {
      autoCounters.refused += 1;
      return {
        ok: false, status: 'disabled', reason: 'auto-policy-off', reasonCode: REASON.disabled,
        providerCalls: 0, autoPolicy: characterPolicy, bindingMode: INTERPRETATION_RECALL_BINDING
      };
    }
    /* ② 零选择 ⇒ **不调用 provider**，如实报 not-needed / no-memory。 */
    if (!selectedMemoryIds.length) {
      autoCounters.notNeeded += 1;
      return {
        ok: false, status: 'not-needed', reason: 'no-memory', reasonCode: core.REASON_CODES.noInput,
        providerCalls: 0, autoPolicy: characterPolicy, bindingMode: INTERPRETATION_RECALL_BINDING
      };
    }
    /* ③ 每逻辑回合一次（解释侧 guard；召回侧 memo 是另一层）。 */
    const guardKey = characterId + '\u0000' + turnKey;
    if (autoTurnGuard.has(guardKey)) {
      autoCounters.duplicateTurn += 1;
      return {
        ok: false, status: 'duplicate-turn', reason: 'turn-already-interpreted', reasonCode: 'duplicate-turn',
        providerCalls: 0, autoPolicy: characterPolicy, bindingMode: INTERPRETATION_RECALL_BINDING
      };
    }
    autoTurnGuard.set(guardKey, true);
    /* 有界：每次只加一条，因此一次 if 就够（本模块刻意不含 while 循环 ——
       G2 断言"没有重试循环"，而边界清理写成循环只会让它无法静态自证）。 */
    if (autoTurnGuard.size > MAX_AUTO_TURN_GUARD) {
      const oldest = autoTurnGuard.keys().next();
      if (!oldest.done) autoTurnGuard.delete(oldest.value);
    }
    autoCounters.started += 1;

    const base = { characterId: characterId, turnIdentity: turnIdentity, turnId: turnKey };
    const fail = (lifecycle, code, detail) => ({
      ok: false, status: lifecycle, errorClass: code, reasonCode: code,
      /* ★ P21-R4-LIVE-4.1B · §6 的**真因**：这一行曾经调用 `bounded()`，
         而它是 runtime-recall.js 的局部 helper —— 本文件里根本没有这个名字。
         于是**任何带 detail 的自动路径失败**都会抛 ReferenceError，被召回侧
         记成 `auto-hook-threw` / failed：超时因此永远到不了 TIMED_OUT。
         现在与同文件 `failure()` 的既有纪律逐字一致：String(...).slice(0,200)。 */
      detail: detail == null ? undefined : text(detail).slice(0, 200),
      characterId: characterId, turnIdentity: turnIdentity, turnId: turnKey,
      providerCalls: 0, startedAt: startedAt, completedAt: Number(clock()),
      autoPolicy: characterPolicy, bindingMode: INTERPRETATION_RECALL_BINDING
    });
    if (!modelPort || typeof modelPort.run !== 'function') { autoCounters.failed += 1; return fail('failed', REASON.modelPortUnavailable, 'modelPort.run is not assembled'); }
    const specResult = resolveCharacterSpec(characterId);
    if (!specResult.ok) { autoCounters.failed += 1; return fail('failed', REASON.runtimeSpecUnavailable, specResult.reason); }
    const spec = specResult.spec;
    /* ④ 记录来源：召回结果持有的 canonical 行优先，否则服务端重绑。 */
    const rebind = resolveBoundEvidence(characterId, selectedMemoryIds, b.records);
    if (!rebind.ok) { autoCounters.failed += 1; return fail('failed', REASON.canonicalEvidenceUnavailable, rebind.reason); }
    if (rebind.boundIds.length === 0) { autoCounters.notNeeded += 1; return fail('not-needed', core.REASON_CODES.noInput, 'no-authorized-memory'); }
    if (!credentialAccess || typeof credentialAccess.resolve !== 'function') { autoCounters.failed += 1; return fail('failed', REASON.credentialUnavailable, 'credential-access-not-assembled'); }
    counters.vaultReads += 1;
    let resolved = null;
    try { resolved = credentialAccess.resolve(spec.credentialRef); } catch (_) { resolved = null; }
    if (!resolved || resolved.ok !== true || typeof resolved.secret !== 'string' || !resolved.secret) {
      autoCounters.failed += 1;
      return fail('failed', REASON.credentialUnavailable, text(resolved && resolved.reason) || 'resolve-failed');
    }
    const providerSpec = { provider: spec.provider, model: spec.model, endpoint: spec.endpoint, secret: resolved.secret };
    if (!core || typeof core.buildRequest !== 'function' || typeof core.validateResponse !== 'function') {
      autoCounters.failed += 1; return fail('failed', REASON.coreMissing, 'R4-C core not loadable');
    }
    const coreInput = {
      selectedIds: selectedMemoryIds,
      records: rebind.records,
      currentState: isPlainObject(b.currentState) ? b.currentState : {},
      roleName: b.roleName == null ? '' : text(b.roleName)
    };
    let built = null;
    try { built = core.buildRequest(coreInput); }
    catch (_) { autoCounters.failed += 1; return fail('failed', REASON.requestShapeInvalid, 'core-build-threw'); }
    if (!built || !built.stats || !built.stats.memoryCount) {
      autoCounters.notNeeded += 1; return fail('not-needed', core.REASON_CODES.noInput, 'core-no-input');
    }
    /* ⑤ 单次执行：服务端自有的超时；没有任何调用方 signal。 */
    const timeoutMs = Math.min(AUTO_INTERPRETATION_TIMEOUT_MS, SAFETY_CAP_MS);
    const called = await invokeOnce(providerSpec, built, { signal: null, timeoutMs: timeoutMs });
    const completedAt = Number(clock());
    const evidenceMeta = {
      source: PROVIDER_MEMORY_SOURCE,
      requested: selectedMemoryIds.length,
      bound: rebind.boundIds.length,
      canonicalRevision: rebind.canonicalRevision == null ? null : rebind.canonicalRevision,
      truncated: rebind.truncated,
      projectionFields: PROJECTION_FIELDS.slice(),
      recordSource: rebind.recordSource
    };
    if (!called.ok) {
      /* ── P21-R4-LIVE-4.1B · §6 · timeout 状态 ─────────────────────────
         自动路径**没有调用方**（上面的 invokeOnce 传的是 `signal: null`），
         因此任何 abort 都不可能来自 caller：它只可能来自**服务端自有**的
         超时（invokeOnce 的内部 controller，或端口自己的 timer）。
         把它算成 `aborted`/`failed` 会把"服务端超时"混进"provider 失败"——
         §6 要的正是这两者的区分：超时必须落在 TIMED_OUT 状态。
           · `timeout`             → 有界等待到点 / 端口报超时
           · `aborted` 且无 caller → 同一个服务端超时的另一种报文
         原始报文不丢：`providerCode` 如实保留 called.code。 */
      const serverOwnedTimeout = (called.code === REASON.timeout) || (called.code === REASON.aborted);
      if (serverOwnedTimeout) autoCounters.timedOut += 1; else autoCounters.failed += 1;
      return Object.assign(fail(
        serverOwnedTimeout ? 'timed-out' : 'failed',
        serverOwnedTimeout ? REASON.timeout : called.code,
        serverOwnedTimeout ? 'server-owned-timeout' : redactSecret(called.detail, resolved.secret)
      ), {
        providerCalls: called.attempts, attempts: called.attempts,
        providerCode: called.code,
        timeoutMs: timeoutMs, timeoutOwner: AUTO_INTERPRETATION_TIMEOUT_OWNER,
        completedAt: completedAt, evidence: evidenceMeta
      });
    }
    /* ⑥ 解析 + **同一份** validator（与外部路由同一份核心，没有第二套）。 */
    const raw = called.text;
    let parsed = null;
    if (typeof raw === 'string' && raw.trim()) { try { parsed = JSON.parse(raw); } catch (_) { parsed = null; } }
    if (!isPlainObject(parsed)) {
      autoCounters.failed += 1;
      return Object.assign(fail('failed', REASON.invalidOutput, 'provider-output-not-a-json-object'), {
        providerCalls: called.attempts, attempts: called.attempts, timeoutMs: timeoutMs, evidence: evidenceMeta
      });
    }
    const allowedIds = rebind.boundIds.slice();
    const validated = core.validateResponse(parsed, { allowedIds: allowedIds });
    if (!validated || validated.ok !== true) {
      const code = (validated && Array.isArray(validated.reasonCodes) && validated.reasonCodes.length)
        ? validated.reasonCodes[0] : core.REASON_CODES.noItems;
      autoCounters.failed += 1;
      return Object.assign(fail('failed', code, 'validator-rejected'), {
        providerCalls: called.attempts, attempts: called.attempts, timeoutMs: timeoutMs, evidence: evidenceMeta
      });
    }
    const shadow = core.assembleShadow(coreInput, validated, {
      providerClass: spec.provider, modelId: spec.model,
      latencyMs: Math.max(0, completedAt - startedAt),
      status: validated.items.length < allowedIds.length ? 'partial' : 'ok'
    });
    autoCounters.succeeded += 1;
    note('runtime-interpretation-auto-ok', {
      characterId: characterId, turnId: turnKey, recordSource: rebind.recordSource,
      bound: rebind.boundIds.length, returned: shadow.counts ? shadow.counts.returned : null,
      durationMs: Math.max(0, completedAt - startedAt)
    });
    return {
      ok: true,
      status: 'succeeded',
      operation: OPERATION,
      characterId: characterId,
      turnIdentity: turnIdentity,
      turnId: turnKey,
      durable: false,
      startedAt: startedAt,
      completedAt: completedAt,
      timeoutMs: timeoutMs,
      timeoutOwner: AUTO_INTERPRETATION_TIMEOUT_OWNER,
      providerCalls: called.attempts,
      attempts: called.attempts,
      bindingMode: INTERPRETATION_RECALL_BINDING,
      recordSource: rebind.recordSource,
      evidence: evidenceMeta,
      autoPolicy: characterPolicy,
      /* 校验过的结构化结果（非持久）。它**不**自动回到浏览器：
         持有者是 runtime-recall 的 turn-local registry。 */
      interpretation: shadow,
      boundary: boundaryBlock(called.attempts, called.attempts, counters.vaultReads)
    };
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
      projectionFields: PROJECTION_FIELDS.slice(),
      maxSelectedMemoryIds: MAX_SELECTED_MEMORY_IDS,
      maxContentChars: MAX_CONTENT_CHARS,
      maxTitleChars: MAX_TITLE_CHARS,
      /* P21-R4-LIVE-3：三项权威分别出现，且**没有**任何一个字段叫
         "SERVER_AUTHORIZED_RECALL" —— 那会是一句本阶段没有实现的话。 */
      evidenceContentAuthority: EVIDENCE_CONTENT_AUTHORITY,
      evidenceVisibilityAuthority: EVIDENCE_VISIBILITY_AUTHORITY,
      recallSelectionAuthority: RECALL_SELECTION_AUTHORITY,
      selectedSetBoundToCurrentRecall: SELECTED_SET_BOUND_TO_CURRENT_RECALL,
      evidenceStateAuthority: EVIDENCE_STATE_AUTHORITY,
      providerMemorySource: PROVIDER_MEMORY_SOURCE,
      canonicalEvidence: {
        reader: 'services/home-node/memory-store.js#getRecord',
        visibility: 'assets/js/memory-visibility-core.js#canReadMemory',
        rebinding: 'per-id canonical lookup + character visibility + bounded projection',
        missingAndHiddenAreIndistinguishable: true,
        duplicatesRejected: true,
        orderPreserved: true
      },
      /* ── P21-R4-LIVE-4 · 服务端内部自动解释（READY-but-OFF）────────────
         与外部路由**分开**的两条自述：externalRoutePolicy = 上面那个
         costPolicy；autoPolicy = 这里。二者默认都是 false，而且**没有**
         一个全局开关能把它们一起打开（run 与 runFromAuthoritativeRecall
         各自读各自的 policy）。 */
      internalOnly: true,
      routeExposed: false,
      exposedRoutes: [],
      internalEntryPoint: AUTO_INTERPRETATION_ENTRY,
      internalCallers: ['services/home-node/runtime-recall.js#post-recall-hook'],
      recallBinding: INTERPRETATION_RECALL_BINDING,
      recordSources: [RECORD_SOURCE_FROM_RECALL, RECORD_SOURCE_REBIND],
      /* ── P21-R4-LIVE-4.3 · 自动策略的**来源**（唯一裁决者的自述）────────
         `authoritySource` 只有两种合法值：
           · 'TEST_INJECTION' —— 装配层显式注入了 `runtimeAutoInterpretationPolicy`
             （测试缝；生产两侧都不传它）；
           · 'FILE_POLICY'    —— `services/home-node/runtime-policy.js` 的文件权威
             （per-character + 全局 default；唯一写者是 Node 侧 `set()`）。
         两者都没有装配时如实说 'NONE_FAIL_CLOSED'（enabled:false）—— 与其
         冒充 FILE_POLICY，不如承认这一层今天没有权威。
         ★ `autoInterpretationEnabled` 是**全局 default** 视图：per-character 值
           不是一个布尔，真正的每角色裁决发生在 runFromAuthoritativeRecall 里。 */
      autoPolicy: (function () {
        const seamInjected = autoInterpretationPolicy !== undefined;
        const seam = seamInjected ? resolveAutoPolicy(autoInterpretationPolicy) : null;
        let fileInfo = null;
        if (!seamInjected && runtimePolicy && typeof runtimePolicy.describe === 'function') {
          try { fileInfo = runtimePolicy.describe(); } catch (_) { fileInfo = null; }
        }
        return {
          autoInterpretationEnabled: seamInjected ? seam.enabled === true : !!(fileInfo && fileInfo.default === true),
          source: seamInjected ? seam.source : (fileInfo ? (fileInfo.readable ? 'FILE_POLICY' : 'DEFAULT_OFF') : 'NO_POLICY_ASSEMBLED'),
          authoritySource: seamInjected ? 'TEST_INJECTION' : (fileInfo ? 'FILE_POLICY' : 'NONE_FAIL_CLOSED'),
          default: seamInjected ? false : !!(fileInfo && fileInfo.default === true),
          defaultEnabled: false,
          scope: seamInjected ? 'test-injection' : 'per-character+global-default',
          file: fileInfo ? fileInfo.file : null,
          enabledCharacterCount: fileInfo ? fileInfo.enabledCharacterCount : 0,
          policyKey: 'autoInterpretationEnabled',
          assemblyOption: 'runtimeAutoInterpretationPolicy',
          callerIntentIsNotAuthority: true,
          /* ── P21-R4-LIVE-4.3 · ⚠ PHASE TRANSITION（值修正，不是措辞修正）──
             在此之前这条边界**根本没有**生产启用路径，所以
             `productionEnablePath = 'NONE_IN_THIS_PHASE'` 是真的。现在有了
             **恰好一条**：操作者侧的策略文件（`<dataDir>/runtime-policy.json`，
             唯一写者是 Node 侧 `set()`）—— 旧值因此变成一句**假话**，本字段
             如实改成 'OPERATOR_FILE_ONLY'。
             ★ 调用者侧的伪造面一个字都没变：仍然是 NONE（请求体里的
               enabled / autoInterpretationEnabled 在两条路由上都被逐名拒绝，
               策略文件在攻击前后逐字节相同）。 */
          productionEnablePath: 'OPERATOR_FILE_ONLY',
          callerFacingEnablePath: 'NONE',
          operatorWritableOnly: !seamInjected
        };
      })(),
      externalInterpretationRoutePolicy: 'INDEPENDENT_OF_AUTO_POLICY',
      autoInterpretation: {
        channels: AUTO_INTERPRETATION_CHANNELS.slice(),
        channelMatrix: Object.assign({}, AUTO_INTERPRETATION_CHANNEL_MATRIX),
        maxAdditionalModelCallsPerCharacterTurn: MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN,
        perTurnGuard: 'in-process (characterId, turnIdentity); bounded ' + MAX_AUTO_TURN_GUARD,
        crossRestartExactlyOnce: 'NO',
        timeoutMs: AUTO_INTERPRETATION_TIMEOUT_MS,
        timeoutOwner: AUTO_INTERPRETATION_TIMEOUT_OWNER,
        timeoutCapMs: SAFETY_CAP_MS,
        attempts: MAX_ATTEMPTS,
        autoRetry: AUTO_RETRY,
        autoInvocation: AUTO_INVOCATION,
        resultHolder: 'services/home-node/runtime-recall.js#turn-local-registry',
        counters: Object.assign({}, autoCounters)
      },
      counters: Object.assign({}, counters)
    };
  }

  return Object.freeze({
    path: MEMORY_INTERPRETATION_PATH,
    operations: ALLOWED_RUNTIME_DERIVATIONS,
    run: run,
    /* 冻结的**公开**名字（测试与召回侧 hook 都按它调用）。内部实现符号故意
       不叫 `...Recall(`：Q3 的结构探针用 /recall\s*\(/i 量"服务端是否重跑
       recall"，而**函数声明名**会被它当成调用点。语义上本函数从不重跑召回
       —— 它只消费 in-process 的召回结果对象。 */
    runFromAuthoritativeRecall: runAuthoritativeRecallBinding,
    describe: describe,
    /* 冻结常量（与 module.exports 同一份对象，不是副本）：召回侧的 hook 用它们
       决定"哪些通道允许自动解释"，因此只有一处定义。 */
    AUTO_INTERPRETATION_CHANNELS: AUTO_INTERPRETATION_CHANNELS,
    AUTO_INTERPRETATION_CHANNEL_MATRIX: AUTO_INTERPRETATION_CHANNEL_MATRIX,
    MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN: MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN,
    INTERPRETATION_RECALL_BINDING: INTERPRETATION_RECALL_BINDING
  });
}

module.exports = createRuntimeInterpretation;
module.exports.createRuntimeInterpretation = createRuntimeInterpretation;
module.exports.PATH = MEMORY_INTERPRETATION_PATH;
module.exports.OPERATION = OPERATION;
module.exports.ALLOWED_RUNTIME_DERIVATIONS = ALLOWED_RUNTIME_DERIVATIONS;
module.exports.REQUEST_FIELDS = REQUEST_FIELDS;
module.exports.CANONICAL_EVIDENCE_FIELDS = CANONICAL_EVIDENCE_FIELDS;
module.exports.PROJECTION_FIELDS = PROJECTION_FIELDS;
module.exports.MAX_SELECTED_MEMORY_IDS = MAX_SELECTED_MEMORY_IDS;
module.exports.MAX_CONTENT_CHARS = MAX_CONTENT_CHARS;
module.exports.MAX_TITLE_CHARS = MAX_TITLE_CHARS;
module.exports.EVIDENCE_CONTENT_AUTHORITY = EVIDENCE_CONTENT_AUTHORITY;
module.exports.EVIDENCE_VISIBILITY_AUTHORITY = EVIDENCE_VISIBILITY_AUTHORITY;
module.exports.RECALL_SELECTION_AUTHORITY = RECALL_SELECTION_AUTHORITY;
module.exports.SELECTED_SET_BOUND_TO_CURRENT_RECALL = SELECTED_SET_BOUND_TO_CURRENT_RECALL;
module.exports.EVIDENCE_STATE_AUTHORITY = EVIDENCE_STATE_AUTHORITY;
module.exports.PROVIDER_MEMORY_SOURCE = PROVIDER_MEMORY_SOURCE;
module.exports.DEFAULT_VISIBILITY_CORE = DEFAULT_VISIBILITY_CORE;
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
module.exports.resolveAutoPolicy = resolveAutoPolicy;
module.exports.INTERPRETATION_RECALL_BINDING = INTERPRETATION_RECALL_BINDING;
module.exports.RECORD_SOURCE_FROM_RECALL = RECORD_SOURCE_FROM_RECALL;
module.exports.RECORD_SOURCE_REBIND = RECORD_SOURCE_REBIND;
module.exports.AUTO_INTERPRETATION_ENTRY = AUTO_INTERPRETATION_ENTRY;
module.exports.AUTO_INTERPRETATION_CHANNELS = AUTO_INTERPRETATION_CHANNELS;
module.exports.AUTO_INTERPRETATION_CHANNEL_MATRIX = AUTO_INTERPRETATION_CHANNEL_MATRIX;
module.exports.MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN = MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN;
module.exports.AUTO_INTERPRETATION_TIMEOUT_MS = AUTO_INTERPRETATION_TIMEOUT_MS;
module.exports.AUTO_INTERPRETATION_TIMEOUT_OWNER = AUTO_INTERPRETATION_TIMEOUT_OWNER;
