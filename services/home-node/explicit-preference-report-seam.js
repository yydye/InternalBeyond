'use strict';
/* ====================================================================
   IB Home Node · Explicit Preference Report Seam（Prediction Error P5-B3-E-R1）
   --------------------------------------------------------------------
         authenticated desktop user（受信用户通道）
                          ↓  POST /internal/user-reports/preference
             Explicit Preference Report Seam        ← 本文件
                          ↓
           runtime-explicit-preference-report（**唯一** report mint 权威）
                          ↓
        explicit-preference-report-reality-source（唯一映射）→ RealityEvent
                          ↓
             既有 runtime-reality-feedback（**不**在这里重复）

   ── 为什么需要一条**专用**入口（§2/§3）──────────────────────────────
   `/messages` · `/turn` · mobile `chat/send` 的语义是 "send user message"，
   不是 "declare an authoritative subjective report"。把它们当权威边界，
   等于让"用户随便说的一句话"自动变成关于他自己的事实。
   ⇒ RAW_CHAT_INGRESS != EXPLICIT_REPORT_INGRESS。

   本文件是**唯一**的 explicitness authority 载体：
     EXPLICITNESS_AUTHORITY = DEDICATED_STRUCTURED_USER_REPORT_ACTION

   ── 用户身份来自**传输**，不来自 payload（§13）──────────────────────
     USER_AUTHORSHIP_AUTHORITY = LOOPBACK_SOCKET + CONFIGURED_DESKTOP_CREDENTIAL
   两条同时成立才算"这次动作来自用户受信客户端通道"。它证明的是
   "action came through the user's trusted client channel"，**不是**某个
   人身份，也**不**把普通聊天文本升级成 report（那条路在本文件里根本不存在：
   没有 text 字段、没有 message 字段、没有 free-text 解析）。

   ── scope 由服务端派生（§8）─────────────────────────────────────────
     characterId    ← 经 server canonical registry 绑定（与 D3 同一个 accessor；
                      客户端给的只是一个 **selector**，不是 authority）
     conversationId ← CHAT_CORE.conversationIdOf(boundCharacterId, threadId)
   客户端**不能**提交 characterId-as-authority / conversationId / userId /
   timestamp / source / reportId —— 出现即拒（逐名拒绝，不静默丢弃）。

   ── 时间（§9）───────────────────────────────────────────────────────
     EXPLICIT_REPORT_OCCURRED_AT = SERVER_ACCEPTED_REPORT_TIME
   body.timestamp / body.occurredAt 一律拒绝，绝不当 authority。

   ── 本文件**没有**的能力 ─────────────────────────────────────────────
     prediction lookup · relation · OutcomeObservation · settlement ·
     calibration · memory · relationship · 任何第二套 feedback driver。
   ==================================================================== */

const path = require('path');
const crypto = require('node:crypto');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const CHAT_CORE = require(path.join(ASSETS_JS, 'chat-core.js'));
const PREF = require(path.join(ASSETS_JS, 'memory-recall', 'preference-proposition-core.js'));
const REPORT_MODULE = require(path.join(__dirname, 'runtime-explicit-preference-report.js'));

/* ══ 路径：本阶段新增的**全部** HTTP 面就是这一条 ═════════════════════
   ★ 它落在 `/internal/` 前缀下 ⇒ 自动继承 isDesktopOnlyPath（远端未配置桌面
     token 时整片 403，而不是匿名可达）。与 /internal/economy/* 同一条纪律。
   ★ 它刻意**不**在 /messages、/turn 或 /mobile/ 下：语义不同、身份不同。 */
const REPORT_PATH = '/internal/user-reports/preference';

/* ══ §12 · stance 闭集（恰好两个）═══════════════════════════════════
   ★ 没有 love / hate / neutral / unsure / slightly_like / LIKE_A_LOT —— 它们
     不在映射里，因此只能落到 UNKNOWN_STANCE。只折大小写，不折别的。 */
const STANCE_ALIASES = Object.freeze({
  LIKE: 'like',
  DISLIKE: 'dislike'
});

/* ══ 信封（恰好五个键，其中 threadId 可选）══════════════════════════
   ★ price / prediction / reportId / source / sourceInstance / authority /
     validated / confidence / timestamp / occurredAt / conversationId / userId
     等**都不在**信封里 ⇒ 它们连"被忽略"的机会都没有：出现即拒。 */
const ENVELOPE_KEYS = Object.freeze(['requestId', 'characterId', 'targetKey', 'stance', 'threadId']);

/* ══ §8/§13 · payload 里**禁止**出现的身份 / 权威键（逐名拒绝）══════ */
const FORBIDDEN_KEYS = Object.freeze([
  /* 身份 */
  'userId', 'user', 'user_id', 'author', 'authorId', 'principal', 'principalId',
  'decidedBy', 'role', 'party', 'deviceId',
  /* scope authority：必须由服务端派生 */
  'conversationId', 'conversation', 'friendId', 'thread', 'scope',
  /* 时间 authority */
  'timestamp', 'occurredAt', 'at', 'time',
  /* provenance / report identity */
  'source', 'sourceInstance', 'sourceActionId', 'actionId', 'reportId',
  'preferenceToken', 'token', 'sealedBy', 'authority', 'validated',
  /* prediction 相关：报告**不许**知道 prediction 的存在 */
  'predictionId', 'predictionType', 'targetDomain', 'relation',
  'matched', 'missed', 'settlementState', 'calibrationCounted',
  /* 内容回退通道：本面**没有**自由文本 */
  'text', 'content', 'message', 'statement', 'evidence', 'confidence'
]);

const REFUSAL = Object.freeze({
  SEAM_NOT_CONFIGURED: 'EXPLICIT_PREFERENCE_REPORT_NOT_CONFIGURED',
  CREDENTIAL_NOT_CONFIGURED: 'EXPLICIT_PREFERENCE_REPORT_DESKTOP_TOKEN_NOT_CONFIGURED',
  NOT_LOOPBACK: 'EXPLICIT_PREFERENCE_REPORT_NOT_LOOPBACK',
  MISSING_USER_CREDENTIAL: 'EXPLICIT_PREFERENCE_REPORT_MISSING_DESKTOP_CREDENTIAL',
  WRONG_USER_CREDENTIAL: 'EXPLICIT_PREFERENCE_REPORT_WRONG_DESKTOP_CREDENTIAL',
  MALFORMED_ENVELOPE: 'EXPLICIT_PREFERENCE_REPORT_MALFORMED_ENVELOPE',
  FORBIDDEN_KEY: 'EXPLICIT_PREFERENCE_REPORT_NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT',
  UNEXPECTED_ENVELOPE_KEYS: 'EXPLICIT_PREFERENCE_REPORT_UNEXPECTED_ENVELOPE_KEYS',
  MISSING_REQUEST_ID: 'EXPLICIT_PREFERENCE_REPORT_MISSING_REQUEST_ID',
  MISSING_CHARACTER_SELECTOR: 'EXPLICIT_PREFERENCE_REPORT_MISSING_CHARACTER_SELECTOR',
  CHARACTER_NOT_BOUND: 'EXPLICIT_PREFERENCE_REPORT_CHARACTER_NOT_BOUND',
  CHARACTER_AUTHORITY_UNAVAILABLE: 'EXPLICIT_PREFERENCE_REPORT_CHARACTER_AUTHORITY_UNAVAILABLE',
  MISSING_TARGET_KEY: 'EXPLICIT_PREFERENCE_REPORT_MISSING_TARGET_KEY',
  TARGET_KEY_NOT_CANONICAL: 'EXPLICIT_PREFERENCE_REPORT_TARGET_KEY_NOT_CANONICAL',
  MISSING_STANCE: 'EXPLICIT_PREFERENCE_REPORT_MISSING_STANCE',
  UNKNOWN_STANCE: 'EXPLICIT_PREFERENCE_REPORT_UNKNOWN_STANCE',
  PRODUCER_UNAVAILABLE: 'EXPLICIT_PREFERENCE_REPORT_PRODUCER_UNAVAILABLE',
  PRODUCER_REFUSED: 'EXPLICIT_PREFERENCE_REPORT_REFUSED_BY_THE_PRODUCER'
});

const SELF_BITS = Object.freeze({
  seam: 'explicit-preference-report-seam',
  explicitnessAuthority: 'DEDICATED_STRUCTURED_USER_REPORT_ACTION',
  rawChatTextIsExplicitReport: false,
  freeTextParser: 'NONE',
  seamHoldsModelPort: false,
  seamHoldsPredictionAuthority: false,
  seamHoldsSettlementAuthority: false,
  seamHoldsMemoryAuthority: false,
  seamHoldsRelationshipAuthority: false,
  seamInterpretsUserLanguage: false,
  seamAddsASecondFeedbackDriver: false,
  identityComesFromTheTransportNotThePayload: true,
  scopeComesFromTheCharacterRegistryNotThePayload: true,
  occurredAtComesFromTheServerClockNotThePayload: true,
  reportIsNotAnOutcomeObservation: true,
  reportIsNotASettlement: true
});

const MAX_ID_LENGTH = 200;

function isPlainObject(value) { return value != null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return value == null ? '' : String(value); }
function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest(); }
function constantTimeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}
function unexpectedKeysOf(input, allowed) {
  return Object.keys(input).filter(key => allowed.indexOf(key) < 0);
}

/**
 * createExplicitPreferenceReportSeam(options)
 *   · reportProducer   —— **唯一**的 report mint 权威（本文件不做 mint）
 *   · realitySink      —— 装配层注入的 report → RealityEvent 落点
 *                         （= explicit-preference-report-reality-source#emit）
 *   · characterRegistry—— D3 的 canonical character binding accessor（**不新造**）
 *   · desktopCredential—— 已配置的桌面 token。空串 ⇒ 本面整体关闭（fail closed）
 *   · clock / logger
 */
function createExplicitPreferenceReportSeam(options) {
  options = options || {};
  const reportProducer = options.reportProducer || null;
  const realitySink = typeof options.realitySink === 'function' ? options.realitySink : null;
  const characterRegistry = options.characterRegistry || null;
  const desktopCredential = text(options.desktopCredential);
  const logger = typeof options.logger === 'function' ? options.logger : function () { };
  const clock = typeof options.clock === 'function' ? options.clock : (() => Date.now());

  const credentialConfigured = desktopCredential.trim() !== '';
  const producerReady = !!reportProducer && typeof reportProducer.submit === 'function';
  const registryReady = !!characterRegistry && typeof characterRegistry.getCharacterSpec === 'function';
  const open = credentialConfigured && producerReady && registryReady && !!realitySink;

  const counters = {
    dispatchAttempted: 0, accepted: 0, refused: 0, duplicateReports: 0,
    realityMinted: 0, realityDuplicate: 0, realityFailed: 0,
    characterBindAttempts: 0, characterBindFailures: 0,
    modelCalls: 0, durableWrites: 0, memoryWrites: 0, relationshipWrites: 0,
    predictionLookups: 0, settlementCalls: 0
  };

  function record(event, fields) {
    try { logger('info', event, fields || {}); } catch (_) { /* 日志失败不得影响判定 */ }
  }

  function refusal(status, reasonCode, extra) {
    return Object.assign({
      ok: false,
      status: status,
      outcome: 'refused',
      refused: true,
      refusedBy: 'explicit-preference-report-seam',
      reasonCode: reasonCode,
      errors: [],
      reportId: null,
      report: null,
      reportMinted: false,
      realityEvent: null,
      realityStatus: null,
      realityReasonCode: null,
      reachedProducer: false,
      reachedRealityAuthority: false,
      callerScopeFromPayload: false,
      predictionLookups: 0,
      settlementCalls: 0
    }, SELF_BITS, extra || {});
  }

  /** 用户身份判定：loopback socket + 已配置桌面凭据（恒定时间比较）。 */
  function resolveUser(requestInfo) {
    const info = requestInfo || {};
    if (info.loopback !== true) return { ok: false, reasonCode: REFUSAL.NOT_LOOPBACK };
    if (!credentialConfigured) return { ok: false, reasonCode: REFUSAL.CREDENTIAL_NOT_CONFIGURED };
    const supplied = text(info.desktopCredential);
    if (supplied.trim() === '' || supplied.length > 512) return { ok: false, reasonCode: REFUSAL.MISSING_USER_CREDENTIAL };
    if (!constantTimeEqual(supplied, desktopCredential)) return { ok: false, reasonCode: REFUSAL.WRONG_USER_CREDENTIAL };
    return { ok: true };
  }

  /**
   * dispatch(requestInfo, rawBody) —— 唯一入口。
   * ★ 绝不抛回上游；身份不明时**不触碰** producer（调用方学不到 payload 的任何事）。
   */
  function dispatch(requestInfo, rawBody) {
    counters.dispatchAttempted += 1;

    if (!open) {
      record('explicit-preference-report-closed', {
        credentialConfigured: credentialConfigured,
        producerReady: producerReady,
        registryReady: registryReady,
        realitySinkBound: !!realitySink
      });
      return refusal(503, credentialConfigured ? REFUSAL.SEAM_NOT_CONFIGURED : REFUSAL.CREDENTIAL_NOT_CONFIGURED, {
        credentialConfigured: credentialConfigured,
        producerReady: producerReady,
        registryReady: registryReady,
        hint: !credentialConfigured
          ? 'set IB_HOME_NODE_TOKEN to enable the explicit preference report path'
          : 'the explicit preference report seam is not fully assembled'
      });
    }

    const user = resolveUser(requestInfo);
    if (user.ok !== true) {
      counters.refused += 1;
      record('explicit-preference-report-refused', { stage: 'identity', reasonCode: user.reasonCode });
      return refusal(user.reasonCode === REFUSAL.NOT_LOOPBACK ? 401 : 403, user.reasonCode, {
        identityIsEstablishedByTheTransport: true,
        acceptedCredentialHeaders: ['X-IB-Home-Token', 'Authorization: Bearer …'],
        hint: 'send the configured desktop credential from a loopback socket'
      });
    }

    if (!isPlainObject(rawBody)) {
      counters.refused += 1;
      return refusal(400, REFUSAL.MALFORMED_ENVELOPE, { errors: ['preference-report-body-must-be-a-plain-object'] });
    }

    /* ① 身份 / scope / 时间 / provenance 自报：逐名拒绝，且**不触碰** producer */
    const forbidden = FORBIDDEN_KEYS.filter(key => Object.prototype.hasOwnProperty.call(rawBody, key));
    if (forbidden.length) {
      counters.refused += 1;
      record('explicit-preference-report-refused', { stage: 'identity', reasonCode: REFUSAL.FORBIDDEN_KEY });
      return refusal(403, REFUSAL.FORBIDDEN_KEY, {
        rejectedKeys: forbidden,
        forbiddenKeys: FORBIDDEN_KEYS,
        identityIsEstablishedByTheTransport: true,
        scopeComesFromTheCharacterRegistryNotThePayload: true,
        errors: forbidden.map(key => 'preference-report-may-not-carry:' + key)
      });
    }

    /* ② 信封：恰好五个键 */
    const unexpected = unexpectedKeysOf(rawBody, ENVELOPE_KEYS);
    if (unexpected.length) {
      counters.refused += 1;
      return refusal(400, REFUSAL.UNEXPECTED_ENVELOPE_KEYS, {
        rejectedEnvelopeKeys: unexpected, acceptedEnvelopeKeys: ENVELOPE_KEYS,
        errors: unexpected.map(key => 'preference-report-envelope-key-not-whitelisted:' + key)
      });
    }

    /* ③ requestId：transport 身份（幂等 / 关联 / 重试）。它不是 report identity。 */
    const requestId = text(rawBody.requestId).trim();
    if (!requestId || requestId.length > MAX_ID_LENGTH) {
      counters.refused += 1;
      return refusal(400, REFUSAL.MISSING_REQUEST_ID, { errors: ['preference-report-requires-a-request-id'] });
    }

    /* ④ targetKey：客户端原文 → canonical（文法在唯一出处里） */
    const rawTargetKey = text(rawBody.targetKey);
    if (rawTargetKey.trim() === '') {
      counters.refused += 1;
      return refusal(400, REFUSAL.MISSING_TARGET_KEY, { errors: ['preference-report-requires-a-target-key'] });
    }
    const targetKey = PREF.canonicalTargetKey(rawTargetKey);
    if (targetKey == null) {
      counters.refused += 1;
      return refusal(400, REFUSAL.TARGET_KEY_NOT_CANONICAL, {
        errors: ['target-key-must-match:^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$'],
        targetKeyLength: rawTargetKey.length
      });
    }

    /* ⑤ stance：只折大小写，闭集恰好两个 */
    const rawStance = text(rawBody.stance).trim();
    if (rawStance === '') {
      counters.refused += 1;
      return refusal(400, REFUSAL.MISSING_STANCE, { acceptedStances: PREF.STANCES.slice() });
    }
    const stance = STANCE_ALIASES[rawStance.toUpperCase()] || null;
    if (stance == null) {
      counters.refused += 1;
      return refusal(400, REFUSAL.UNKNOWN_STANCE, { acceptedStances: PREF.STANCES.slice() });
    }

    /* ⑥ character 绑定：经 server canonical registry（**不新造 resolver**） */
    const selector = text(rawBody.characterId).trim();
    if (!selector) {
      counters.refused += 1;
      return refusal(400, REFUSAL.MISSING_CHARACTER_SELECTOR, { errors: ['preference-report-requires-a-character-selector'] });
    }
    counters.characterBindAttempts += 1;
    let spec = null;
    try { spec = characterRegistry.getCharacterSpec(selector); } catch (_) { spec = null; }
    if (!isPlainObject(spec)) {
      counters.characterBindFailures += 1;
      counters.refused += 1;
      record('explicit-preference-report-refused', { stage: 'character-binding', characterSelector: selector });
      return refusal(404, REFUSAL.CHARACTER_NOT_BOUND, {
        characterSelector: selector,
        errors: ['character-is-not-bound-in-the-canonical-registry']
      });
    }
    /* 客户端 id 只是 selector，不是 authority —— 绑定后的 id 才是 canonical */
    const characterId = selector;

    /* ⑦ conversation 派生：复用既有 canonical 函数，客户端**不**参与 */
    const threadId = rawBody.threadId == null ? '' : text(rawBody.threadId);
    if (threadId.length > 200) {
      counters.refused += 1;
      return refusal(400, REFUSAL.MALFORMED_ENVELOPE, { errors: ['thread-id-too-long'] });
    }
    const conversationId = CHAT_CORE.conversationIdOf(characterId, threadId);
    if (!conversationId) {
      counters.refused += 1;
      return refusal(400, REFUSAL.MALFORMED_ENVELOPE, { errors: ['conversation-id-underivable'] });
    }

    /* ⑧ canonical action identity：transport 派生（**不**等于 report identity） */
    const actionId = REPORT_MODULE.actionIdOf(requestId);
    if (!actionId) {
      counters.refused += 1;
      return refusal(400, REFUSAL.MISSING_REQUEST_ID, { errors: ['action-identity-underivable'] });
    }

    /* ⑨ 唯一 mint 权威 */
    let minted = null;
    try {
      minted = reportProducer.submit({
        actionId: actionId,
        characterId: characterId,
        conversationId: conversationId,
        targetKey: targetKey,
        stance: stance
      });
    } catch (error) {
      counters.refused += 1;
      record('explicit-preference-report-refused', { stage: 'producer', errorClass: 'producer-threw' });
      return refusal(500, REFUSAL.PRODUCER_REFUSED, {
        errors: [String((error && error.message) || error).slice(0, 200)]
      });
    }
    if (!minted || minted.ok !== true || !minted.report) {
      counters.refused += 1;
      return refusal(422, REFUSAL.PRODUCER_REFUSED, {
        producerReasonCode: minted && minted.reasonCode,
        reachedProducer: true
      });
    }
    const report = minted.report;
    const isNewMint = minted.status === 'minted';
    if (isNewMint) counters.accepted += 1; else counters.duplicateReports += 1;

    /* ⑩ report → RealityEvent（**只**在 NEW mint 之后；复用既有 backbone）。
        ★ report 是 upstream truth：这一段的失败**不**回滚 report。 */
    let sinkResult = null;
    if (isNewMint) {
      try { sinkResult = realitySink(report); }
      catch (_) { sinkResult = { ok: false, status: 'failed', reasonCode: 'reality-sink-threw' }; }
      if (sinkResult && sinkResult.status === 'minted') counters.realityMinted += 1;
      else if (sinkResult && sinkResult.status === 'duplicate') counters.realityDuplicate += 1;
      else counters.realityFailed += 1;
    }

    return Object.assign({
      ok: true,
      /* wire 契约：`status` 恒为 HTTP 状态码（与三条 economy seam 同形），
         `outcome` 才是语义词（accepted | duplicate）。 */
      status: 200,
      outcome: isNewMint ? 'accepted' : 'duplicate',
      refused: false,
      refusedBy: null,
      reasonCode: isNewMint ? 'ok' : minted.reasonCode,
      errors: [],
      reportId: report.reportId,
      report: report,
      reportMinted: isNewMint,
      realityEvent: sinkResult && sinkResult.realityEvent ? sinkResult.realityEvent : null,
      realityStatus: sinkResult ? sinkResult.status : null,
      realityReasonCode: sinkResult ? sinkResult.reasonCode : null,
      reachedProducer: true,
      reachedRealityAuthority: !!sinkResult
    }, SELF_BITS);
  }

  function describe() {
    return {
      status: open ? 'LIVE_CAPABLE' : 'CLOSED',
      path: REPORT_PATH,
      owner: 'HOME_NODE_RUNTIME_ASSEMBLY',
      explicitnessAuthority: 'DEDICATED_STRUCTURED_USER_REPORT_ACTION',
      userAuthorshipAuthority: 'LOOPBACK_SOCKET_PLUS_CONFIGURED_DESKTOP_CREDENTIAL',
      userAuthorshipProves: 'ACTION_CAME_THROUGH_THE_TRUSTED_CLIENT_CHANNEL',
      rawChatIngressIsExplicitReportIngress: 'NO',
      freeTextParser: 'NONE',
      characterAuthority: 'SERVER_CANONICAL_REGISTRY_BINDING（D3 accessor，不新造 resolver）',
      conversationAuthority: 'CHAT_CORE.conversationIdOf（服务端派生）',
      occurredAtAuthority: 'SERVER_ACCEPTED_REPORT_TIME',
      requestIdentityIsReportIdentity: 'NO',
      envelopeKeys: ENVELOPE_KEYS.slice(),
      forbiddenKeys: FORBIDDEN_KEYS.slice(),
      stanceEnum: PREF.STANCES.slice(),
      open: open,
      credentialConfigured: credentialConfigured,
      producerReady: producerReady,
      registryReady: registryReady,
      realitySinkBound: !!realitySink,
      modelCalls: 0, durableWrites: 0,
      memoryWrites: 0, relationshipWrites: 0,
      predictionLookups: 0, settlementCalls: 0,
      counters: Object.assign({}, counters)
    };
  }

  return {
    path: REPORT_PATH,
    dispatch: dispatch,
    describe: describe,
    resolveUser: resolveUser,
    counters: counters,
    REPORT_PATH: REPORT_PATH,
    ENVELOPE_KEYS: ENVELOPE_KEYS,
    FORBIDDEN_KEYS: FORBIDDEN_KEYS,
    REFUSAL: REFUSAL
  };
}

module.exports = {
  createExplicitPreferenceReportSeam: createExplicitPreferenceReportSeam,
  REPORT_PATH: REPORT_PATH,
  ENVELOPE_KEYS: ENVELOPE_KEYS,
  FORBIDDEN_KEYS: FORBIDDEN_KEYS,
  STANCE_ALIASES: STANCE_ALIASES,
  REFUSAL: REFUSAL,
  SELF_BITS: SELF_BITS
};
