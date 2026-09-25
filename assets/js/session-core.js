/* ====================================================================
   IB Session Core — P26-3 · Session Runtime Contract Foundation
   --------------------------------------------------------------------
   回答一个问题：**什么是 Session？**

     Session = a bounded runtime lifecycle containing participants,
               state transitions, and temporal continuity.

   不是：Event（P26-1）· Observation（P26-2）· Capability · Canonical Record · Resource。

   ── 冻结边界（P26-3 §5）─────────────────────────────────────────────
     Session owns（YES）：lifecycle identity · participant membership during lifecycle ·
       runtime state transition semantics · start/end boundary
     Session owns（NO）：canonical business data · permission · capability execution ·
       resource arbitration · observation · event routing

   ── 生命周期（§7，证据驱动的最小集合）───────────────────────────────
     created → active → ended
                    ↘ failed
     created  ↘ failed / ended（未启动即失败 / 未启动即放弃）
     `paused` **NOT PRESENT**（P25-3E 已证明：活动级 pause 不存在；媒体 pause 属传输控制）
     `ended` / `failed` 是**终态**，不可再迁移（ended → active 非法）。

   ── 本模块**不是** ──────────────────────────────────────────────────
     Session Manager · Session Registry · Session Store · Session Router · Session Bus ·
     Realtime Session Sync · Presence System · Voice/Cinema Session Runtime

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch / 零 IPC / 零 provider / 零模型 /
     零权威 / 零 executor / 零资源仲裁 / 零事件路由 / 零订阅 / 零定时器 / 零时钟
     （**不读 Date.now**）/ 零随机（**不用 Math.random**）；时间与身份由调用方注入；
     秘密探测复用既有纯 helper。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBSessionCore = factory(root, root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE) {
  'use strict';

  var SESSION_VERSION = 'session/v1';
  /* 状态闭集（证据见文件头注释与 docs/P26-3-SESSION-RUNTIME-CONTRACT.md §3）。 */
  var SESSION_STATUSES = Object.freeze(['created', 'active', 'ended', 'failed']);
  var TERMINAL_STATUSES = Object.freeze(['ended', 'failed']);
  /* 状态迁移表：显式、有限、deterministic。 */
  var TRANSITIONS = Object.freeze({
    created: Object.freeze(['active', 'ended', 'failed']),
    active: Object.freeze(['ended', 'failed']),
    ended: Object.freeze([]),
    failed: Object.freeze([])
  });
  /* 会话**不得**承载 canonical business state（§8）——只允许 runtime state（status/participants/时间）。
     'participants' 是成员资格（运行时事实），不是业务正文。 */
  var RESERVED_STATE_FIELDS = Object.freeze([
    'messages', 'message', 'content', 'body', 'text', 'payload', 'data', 'value', 'snapshot',
    'record', 'row', 'history', 'chat', 'transcript', 'memories', 'memory', 'canonical',
    'images', 'image', 'audio', 'base64', 'dataurl', 'blob', 'files', 'attachments'
  ]);
  var ALLOWED_FIELDS = Object.freeze(['sessionId', 'domain', 'participants', 'status',
    'createdAt', 'updatedAt', 'endedAt', 'version']);
  var REQUIRED_FIELDS = Object.freeze(['sessionId', 'domain', 'participants', 'status', 'createdAt']);
  var MAX_ID_LEN = 200;
  var MAX_PARTICIPANTS = 32;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  var ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-@|]*$/;
  var TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;
  var SESSION_ERRORS = Object.freeze([
    'not-an-object', 'unknown-field', 'forbidden-state-field', 'missing-session-id',
    'bad-session-id', 'missing-domain', 'bad-domain', 'missing-participants', 'bad-participants',
    'too-many-participants', 'bad-participant-id', 'duplicate-participant-id',
    'missing-status', 'bad-status', 'missing-created-at', 'bad-created-at',
    'bad-updated-at', 'bad-ended-at', 'not-serializable', 'too-deep', 'not-json-value',
    'invalid-transition', 'already-terminal', 'missing-transition-time'
  ]);

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }
  function dedupe(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }
  function stableToken(seed) {
    try { if (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') return str(CHAT_CORE.stableToken(seed)); } catch (e) { /* fall through */ }
    return '';
  }
  function hasSecret(value) {
    try { if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(value); } catch (e) { /* 探测失败不阻断 */ }
    return false;
  }
  function deepFreeze(v) {
    if (Array.isArray(v)) { v.forEach(deepFreeze); return Object.freeze(v); }
    if (!isObject(v)) return v;
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return Object.freeze(v);
  }
  function usableId(v) {
    var s = str(v);
    if (!s || s !== s.trim() || s.length > MAX_ID_LEN) return false;
    if (CONTROL_PATTERN.test(s)) return false;
    return ID_PATTERN.test(s);
  }
  function isTimestamp(v) { return typeof v === 'number' && isFinite(v) && v > 0; }
  function isJsonValue(value, depth, errors, path) {
    var here = path || '';
    if (depth > 4) { errors.push('too-deep:' + here); return false; }
    if (value === null) return true;
    var t = typeof value;
    if (t === 'string') return true;
    if (t === 'number') return isFinite(value);
    if (t === 'boolean') return true;
    if (t === 'function' || t === 'symbol' || t === 'undefined' || t === 'bigint') { errors.push('not-json-value:' + here); return false; }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) if (!isJsonValue(value[i], depth + 1, errors, here + '[' + i + ']')) return false;
      return true;
    }
    if (!isPlainObject(value)) { errors.push('not-serializable:' + here); return false; }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) if (!isJsonValue(value[keys[k]], depth + 1, errors, here + '.' + keys[k])) return false;
    return true;
  }
  /* 输入形状扫描：未知字段与 canonical business state **一律拒绝**（不是静默丢弃）。 */
  function scanInputShape(input) {
    var errors = [];
    var keys = isPlainObject(input) ? Object.keys(input) : [];
    for (var i = 0; i < keys.length; i++) {
      var raw = String(keys[i]);
      var lower = raw.toLowerCase().replace(/[\s\-_]/g, '');
      if (RESERVED_STATE_FIELDS.indexOf(lower) >= 0) { errors.push('forbidden-state-field:' + raw); continue; }
      if (ALLOWED_FIELDS.indexOf(raw) < 0) errors.push('unknown-field:' + raw);
    }
    return dedupe(errors);
  }
  function canonicalParticipants(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var id = str(list[i]);
      if (out.indexOf(id) < 0) out.push(id);
    }
    return out.sort();
  }
  /* ── 校验（只验证 shape / syntax / 闭集；**不**验证任何 domain business schema）── */
  function validateSession(session) {
    var errors = [];
    if (!isPlainObject(session)) return { ok: false, errors: ['not-an-object'] };
    errors = errors.concat(scanInputShape(session));
    if (session.sessionId === undefined || session.sessionId === null || str(session.sessionId).trim() === '') errors.push('missing-session-id');
    else if (!usableId(session.sessionId)) errors.push('bad-session-id');
    if (session.domain === undefined || session.domain === null || str(session.domain).trim() === '') errors.push('missing-domain');
    else if (!TOKEN_PATTERN.test(str(session.domain)) || str(session.domain).length > 40) errors.push('bad-domain');
    if (!Array.isArray(session.participants)) errors.push('missing-participants');
    else if (!session.participants.length) errors.push('bad-participants');
    else if (session.participants.length > MAX_PARTICIPANTS) errors.push('too-many-participants');
    else {
      var seen = [];
      for (var i = 0; i < session.participants.length; i++) {
        var pid = str(session.participants[i]);
        if (!usableId(pid)) { errors.push('bad-participant-id:' + i); continue; }
        if (seen.indexOf(pid) >= 0) errors.push('duplicate-participant-id:' + pid);
        seen.push(pid);
      }
    }
    if (session.status === undefined || session.status === null || str(session.status) === '') errors.push('missing-status');
    else if (SESSION_STATUSES.indexOf(str(session.status)) < 0) errors.push('bad-status');
    if (session.createdAt === undefined || session.createdAt === null || session.createdAt === '') errors.push('missing-created-at');
    else if (!isTimestamp(session.createdAt)) errors.push('bad-created-at');
    if (session.updatedAt !== undefined && session.updatedAt !== null && session.updatedAt !== '' && !isTimestamp(session.updatedAt)) errors.push('bad-updated-at');
    if (session.endedAt !== undefined && session.endedAt !== null && session.endedAt !== '' && !isTimestamp(session.endedAt)) errors.push('bad-ended-at');
    var jsonErrors = [], present = {};
    Object.keys(session).forEach(function (k) { if (session[k] !== undefined) present[k] = session[k]; });
    if (!isJsonValue(present, 0, jsonErrors, '')) errors = errors.concat(jsonErrors);
    if (hasSecret({ sessionId: session.sessionId, domain: session.domain, participants: session.participants })) errors.push('forbidden-state-field:secret');
    errors = dedupe(errors);
    return { ok: errors.length === 0, errors: errors };
  }

  /* ── Session identity（§6）：可注入 / 确定性派生；**不是**全局计数器 ─────────
     sessionId 在生命周期内稳定；谁生成？—— **caller 注入优先**（domain / runtime 都可），
     未注入时由本模块确定性派生；Core 不持有任何全局计数或注册表。 */
  function createSessionIdentity(input, options) {
    var opts = isPlainObject(options) ? options : {};
    var src = isPlainObject(input) ? input : {};
    var injected = str(src.sessionId) || str(opts.sessionId);
    if (injected) {
      if (!usableId(injected)) return { ok: false, errors: ['bad-session-id'], sessionId: '' };
      return { ok: true, errors: [], sessionId: injected };
    }
    var participants = Array.isArray(src.participants) ? canonicalParticipants(src.participants) : [];
    var now = (src.createdAt === undefined || src.createdAt === null || src.createdAt === '')
      ? opts.createdAt : src.createdAt;
    var token = stableToken([str(src.domain), participants.join(','), str(now)].join('|'));
    if (!token) return { ok: false, errors: ['bad-session-id'], sessionId: '' };
    return { ok: true, errors: [], sessionId: 'sess_' + token };
  }

  /* ── 创建：唯一入口（status 恒为 'created'；时间与身份由调用方注入）──────────
     创建**不**等于开始：`created → active` 需要一次显式 transition（§7/§17）。 */
  function createSession(input, options) {
    var opts = isPlainObject(options) ? options : {};
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'], session: null };
    var shapeErrors = scanInputShape(input);
    if (shapeErrors.length) return { ok: false, errors: shapeErrors, session: null };
    /* 先按**原始**数组校验（重复参与者是显式错误，不静默去重），再按集合规范化写入。 */
    var participants = input.participants;
    var createdAt = (input.createdAt === undefined || input.createdAt === null || input.createdAt === '')
      ? opts.createdAt : input.createdAt;
    var idResult = createSessionIdentity({
      sessionId: input.sessionId, domain: input.domain,
      participants: Array.isArray(participants) ? participants : [], createdAt: createdAt
    }, { sessionId: opts.sessionId, createdAt: createdAt });
    if (!idResult.ok) return { ok: false, errors: idResult.errors, session: null };
    var draft = {
      sessionId: idResult.sessionId,
      domain: str(input.domain),
      participants: Array.isArray(participants) ? participants.slice() : participants,
      status: 'created',
      createdAt: createdAt
    };
    var verdict = validateSession(draft);
    if (!verdict.ok) return { ok: false, errors: verdict.errors, session: null };
    draft.participants = canonicalParticipants(draft.participants);
    return { ok: true, errors: [], session: deepFreeze(draft) };
  }

  /* ── 迁移契约（§17）：显式表；非法迁移 fail closed（返回 result，不抛异常）──── */
  function canTransitionSession(session, nextStatus) {
    var s = isPlainObject(session) ? session : {};
    var from = str(s.status), to = str(nextStatus);
    if (SESSION_STATUSES.indexOf(from) < 0 || SESSION_STATUSES.indexOf(to) < 0) return false;
    var allowed = TRANSITIONS[from];
    return !!allowed && allowed.indexOf(to) >= 0;
  }
  /* transitionSession(session, nextStatus, context) → { ok, session, errors, reason }
     context.at  = 迁移发生的时间（**必填**；本模块不读时钟）
     失败语义（§18）：返回 result（不抛错）、**不**自动恢复、**不**自动重试。
     终态（ended / failed）不可再迁移，且迁移返回**新的冻结 session**（原对象不变）。 */
  function transitionSession(session, nextStatus, context) {
    var ctx = isPlainObject(context) ? context : {};
    var verdict = validateSession(session);
    if (!verdict.ok) return { ok: false, session: null, errors: verdict.errors, reason: 'invalid-session' };
    var from = str(session.status), to = str(nextStatus);
    var mine = Object.keys(TRANSITIONS).filter(function (k) { return TRANSITIONS[k].indexOf(to) >= 0; });
    if (mine.indexOf(from) < 0) {
      var reason = TERMINAL_STATUSES.indexOf(from) >= 0 ? 'already-terminal' : 'invalid-transition';
      /* 迁移表外的目标状态（含 paused 之类）也是 invalid-transition（fail closed）。 */
      if (SESSION_STATUSES.indexOf(to) < 0) reason = 'invalid-transition';
      return { ok: false, session: null, errors: [reason], reason: reason };
    }
    if (!isTimestamp(ctx.at)) return { ok: false, session: null, errors: ['missing-transition-time'], reason: 'missing-transition-time' };
    if (ctx.at < session.createdAt) return { ok: false, session: null, errors: ['missing-transition-time'], reason: 'missing-transition-time' };
    if (TERMINAL_STATUSES.indexOf(to) >= 0 && ctx.at < Number(session.updatedAt || session.createdAt)) {
      return { ok: false, session: null, errors: ['missing-transition-time'], reason: 'missing-transition-time' };
    }
    var next = {
      sessionId: session.sessionId,
      domain: session.domain,
      participants: canonicalParticipants(session.participants),
      status: to,
      createdAt: session.createdAt,
      updatedAt: ctx.at
    };
    if (TERMINAL_STATUSES.indexOf(to) >= 0) next.endedAt = ctx.at;
    var check = validateSession(next);
    if (!check.ok) return { ok: false, session: null, errors: check.errors, reason: 'invalid-session' };
    return { ok: true, session: deepFreeze(next), errors: [], reason: '' };
  }

  return {
    SESSION_VERSION: SESSION_VERSION,
    SESSION_STATUSES: SESSION_STATUSES,
    TERMINAL_STATUSES: TERMINAL_STATUSES,
    TRANSITIONS: TRANSITIONS,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    RESERVED_STATE_FIELDS: RESERVED_STATE_FIELDS,
    SESSION_ERRORS: SESSION_ERRORS,
    createSessionIdentity: createSessionIdentity,
    createSession: createSession,
    validateSession: validateSession,
    canTransitionSession: canTransitionSession,
    transitionSession: transitionSession
  };
});
