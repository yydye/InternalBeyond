'use strict';
/* ====================================================================
   IB Home Node · P21-R4-PROD-1 · Cognitive Runtime Control Plane
   --------------------------------------------------------------------
   这是 R4 主认知闭环**完成之后**的产品化阶段：把"操作者改文件"升级为
   "用户按角色显式控制"，同时**不**给浏览器任何权威。

      用户意图 → Browser/UI intent
              → authorized narrow mutation boundary（HTTP /internal/…）
              → 本模块（产品级状态矩阵）
              → runtime-policy.js#setCognitive（**唯一**的 durable writer）
              → <dataDir>/runtime-policy.json
              → cognitive runtime（Interpretation / Expectation / BehaviorEffect）

   ── 它是什么 ────────────────────────────────────────────────────────
   · **唯一**的产品级读写边界：按角色读/写两个开关
       autoInterpretationEnabled · autoExpectationEnabled
   · **冻结的合法状态矩阵**（§5）：
       I=OFF E=OFF 合法 · I=ON E=OFF 合法 · I=ON E=ON 合法
       I=OFF E=ON  **非法** ⇒ 拒绝（不规范化、不静默猜测）
   · 读**无副作用**：不创建文件、不写任何 entry、不因为 UI 打开而落盘。

   ── 它不是什么（结构性）─────────────────────────────────────────────
   · 不是第二份 policy 权威：持久化一律交给注入的 runtime-policy 实例
     （同一份文件、同一个原子写者）。本模块**没有** fs / 路径拼接。
   · 不是第三个成本位：BehaviorEffect 是确定性投影，**没有**独立开关，
     本模块的 schema 里**不存在** autoBehaviorEffectEnabled 这个键
     （提交它 = unknown field ⇒ 拒绝）。
   · 不返回任何内部信息：wire 投影里没有 file / dataDir / 其它角色 /
     凭据 / provider / 模型 / endpoint。
   · 不碰 Recall / Interpretation / Expectation / BehaviorEffect 的任何语义：
     它只改那两个布尔，其余一律原样。
   ==================================================================== */

const AUTHORITY_SOURCE = 'FILE_POLICY';
const MUTATION_AUTHORITY = 'HOME_NODE_AUTHENTICATED_INTERNAL_ROUTE';
const SCOPE = 'PER_CHARACTER_WITH_GLOBAL_DEFAULT';
const MAX_CHARACTER_ID_CHARS = 180;
/* 写请求的**闭集**：只有这两个键（多一个键就不是本控制面的契约）。 */
const REQUEST_FIELDS = Object.freeze(['autoInterpretationEnabled', 'autoExpectationEnabled']);
const ERROR = Object.freeze({
  invalidCharacterId: 'INVALID_CHARACTER_ID',
  invalidValue: 'INVALID_VALUE',
  illegalState: 'ILLEGAL_COGNITIVE_STATE',
  unusable: 'POLICY_FILE_UNUSABLE',
  writeFailed: 'POLICY_WRITE_FAILED',
  unknownField: 'UNKNOWN_FIELD',
  policyMissing: 'POLICY_AUTHORITY_MISSING'
});
/* ── `readable` 的语义（UI closure 机械证明需要）─────────────────────────
   "可读"回答的是**这份权威现在能不能写**，而不是"值是不是 ON"。判据与
   runtime-policy 的 POLICY_FILE_UNUSABLE **逐字同一个**（文件级 `documentStatus`）：
     · 文件不存在 · JSON 合法且 version 认 · 形状是对象 ⇒ readable = true
       （新装节点 OFF/OFF 是**正常**状态，UI 不该报警）
     · 读不动 / JSON 坏 / 不是对象 / version 不认 ⇒ readable = false
       （UI 必须显式报警，并把控件置为不可编辑 —— 因为写真的会被拒）
   没有 documentStatus（老实例/测试替身）时退回**白名单**判定：未知原因按不可用
   处理（fail closed）。 */
const USABLE_REASONS = Object.freeze([
  null, undefined,
  'policy-file-missing',
  'global-default',
  'expectation-section-missing',
  'expectation-global-default'
]);
function usableReason(reason) {
  return USABLE_REASONS.indexOf(reason === undefined ? null : reason) >= 0;
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function bounded(v, n) { return text(v).slice(0, n); }

function createRuntimeCognitivePolicy(deps) {
  const d = deps || {};
  const policy = d.policy || null;
  const logger = typeof d.logger === 'function' ? d.logger : function () {};
  function note(event, fields) { try { logger(event, fields || {}); } catch (_) { /* 观测失败不影响判定 */ } }

  function normalizedId(characterId) {
    const id = text(characterId).trim();
    if (!id || id.length > MAX_CHARACTER_ID_CHARS) return '';
    return id;
  }

  /* ── 读：按角色的**唯一**读取面（无副作用）────────────────────────────
     失败一律 fail closed 成 OFF/OFF，并如实给出 reasonCode（不是"可能是真的"）。 */
  function readCharacter(characterId) {
    const id = normalizedId(characterId);
    if (!policy) {
      return {
        ok: false, code: ERROR.policyMissing, characterId: id,
        autoInterpretationEnabled: false, autoExpectationEnabled: false
      };
    }
    if (!id) return { ok: false, code: ERROR.invalidCharacterId, characterId: '' };
    const i = policy.read(id);
    const e = policy.readExpectation(id);
    /* 文件级判据（与写者同一个）：有 documentStatus 就用它，否则白名单回退。 */
    let docStatus = null;
    try { docStatus = typeof policy.documentStatus === 'function' ? policy.documentStatus() : null; } catch (_) { docStatus = null; }
    const readable = docStatus && typeof docStatus.ok === 'boolean'
      ? docStatus.ok === true
      : (usableReason(i.reason) && usableReason(e.reason));
    return {
      ok: true,
      characterId: id,
      autoInterpretationEnabled: i.autoInterpretationEnabled === true,
      autoExpectationEnabled: e.autoExpectationEnabled === true,
      /* 值来自文件（角色项/全局 default）还是 fail-closed 默认 —— 这是 UI 需要
         区分"用户设过"与"没设过"的唯一信息，不泄漏任何路径。 */
      source: { interpretation: i.source, expectation: e.source },
      reasonCode: {
        interpretation: i.reason == null ? null : bounded(i.reason, 64),
        expectation: e.reason == null ? null : bounded(e.reason, 64)
      },
      /* 文件是否可写：UI 据此把控件置为"不可修改 + 具名原因"，而不是假装保存成功。 */
      readable: readable,
      authorityReason: docStatus && docStatus.ok !== true && docStatus.reason ? bounded(docStatus.reason, 64) : null,
      authoritySource: AUTHORITY_SOURCE,
      mutationAuthority: MUTATION_AUTHORITY,
      scope: SCOPE,
      cost: costBlock()
    };
  }

  /* ── 写：产品级 state matrix + **一次**原子落盘 ──────────────────────── */
  function setCharacter(characterId, next) {
    const id = normalizedId(characterId);
    if (!id) return { ok: false, code: ERROR.invalidCharacterId };
    if (!isPlainObject(next)) return { ok: false, code: ERROR.invalidValue };
    for (const key of Object.keys(next)) {
      if (REQUEST_FIELDS.indexOf(key) < 0) {
        return { ok: false, code: ERROR.unknownField, field: bounded(key, 64) };
      }
    }
    const interpretation = next.autoInterpretationEnabled;
    const expectation = next.autoExpectationEnabled;
    if (typeof interpretation !== 'boolean' || typeof expectation !== 'boolean') {
      return { ok: false, code: ERROR.invalidValue, field: 'autoInterpretationEnabled|autoExpectationEnabled' };
    }
    /* ★ 冻结矩阵：Expectation 不能在 Interpretation 关闭时开启。
       这是**权威层**的拒绝，不是 UI 的礼貌 —— UI 的联动只是体验。 */
    if (expectation === true && interpretation === false) {
      note('cognitive-policy-rejected', { characterId: id, reason: 'illegal-cognitive-state' });
      return { ok: false, code: ERROR.illegalState, characterId: id };
    }
    if (!policy || typeof policy.setCognitive !== 'function') {
      return { ok: false, code: ERROR.policyMissing };
    }
    const written = policy.setCognitive(id, {
      autoInterpretationEnabled: interpretation,
      autoExpectationEnabled: expectation
    });
    if (!written || written.ok !== true) {
      const code = written && written.code ? String(written.code) : ERROR.writeFailed;
      note('cognitive-policy-write-failed', { characterId: id, code: code });
      return {
        ok: false,
        code: code === 'POLICY_FILE_UNUSABLE' ? ERROR.unusable : code,
        characterId: id,
        reason: written && written.reason ? bounded(written.reason, 120) : null
      };
    }
    const after = readCharacter(id);
    note('cognitive-policy-updated', {
      characterId: id, autoInterpretationEnabled: interpretation, autoExpectationEnabled: expectation
    });
    return {
      ok: true,
      characterId: id,
      autoInterpretationEnabled: interpretation,
      autoExpectationEnabled: expectation,
      updatedAt: Number(written.updatedAt) || null,
      source: after.source,
      cost: costBlock()
    };
  }

  /* 成本是**上界**，不是承诺（§16）：zero-memory / 通道不合格 / L3 失败 /
     L5 失败 / 重放 / 凭据不可用 都可能让实际上限落回 0。 */
  function costBlock() {
    return {
      maxExtraModelCallsPerCharacterTurn: 2,
      interpretation: 1,
      expectation: 1,
      behaviorEffect: 0,
      behaviorEffectPolicy: 'NO_INDEPENDENT_BIT',
      wording: 'AT_MOST',
      note: 'upper bound per character turn; zero-memory, channel, L3/L5 failure, replay and credential-unavailable all drop it to 0'
    };
  }

  function describe() {
    let policyView = null;
    try { policyView = policy && typeof policy.describe === 'function' ? policy.describe() : null; } catch (_) { policyView = null; }
    return {
      ready: !!policy,
      authoritySource: AUTHORITY_SOURCE,
      mutationAuthority: MUTATION_AUTHORITY,
      scope: SCOPE,
      /* ★ 刻意**不**在这里放策略文件路径：读契约（§9）里没有路径，
         describe() 也不放 —— 需要文件身份的诊断去问 runtime-policy.describe()。 */
      readable: !!(policyView && policyView.readable),
      version: policyView ? policyView.schemaVersion : null,
      requestFields: REQUEST_FIELDS.slice(),
      legalStates: ['OFF/OFF', 'ON/OFF', 'ON/ON'],
      illegalStates: ['OFF/ON'],
      browserDirectPolicyAuthority: 'NO',
      behaviorEffectIndependentPolicy: 'NONE',
      defaultAutoInterpretation: policyView ? policyView.default === true : false,
      defaultAutoExpectation: policyView && policyView.expectationPolicy ? policyView.expectationPolicy.default === true : false,
      enabledCharacterCount: policyView ? Number(policyView.enabledCharacterCount) || 0 : 0,
      enabledExpectationCharacterCount: policyView && policyView.expectationPolicy
        ? Number(policyView.expectationPolicy.enabledCharacterCount) || 0 : 0,
      cost: costBlock()
    };
  }

  return Object.freeze({
    readCharacter: readCharacter,
    setCharacter: setCharacter,
    describe: describe,
    AUTHORITY_SOURCE: AUTHORITY_SOURCE,
    MUTATION_AUTHORITY: MUTATION_AUTHORITY,
    SCOPE: SCOPE,
    REQUEST_FIELDS: REQUEST_FIELDS,
    ERROR: ERROR
  });
}

module.exports.createRuntimeCognitivePolicy = createRuntimeCognitivePolicy;
module.exports.AUTHORITY_SOURCE = AUTHORITY_SOURCE;
module.exports.MUTATION_AUTHORITY = MUTATION_AUTHORITY;
module.exports.SCOPE = SCOPE;
module.exports.REQUEST_FIELDS = REQUEST_FIELDS;
module.exports.ERROR = ERROR;
