/* ====================================================================
   IB Moments Autonomy Adapter — P25-2A · Moments Autonomy Adapter Foundation
   --------------------------------------------------------------------
   这是 P25 的**第一次真实业务接入**，也是"裁决层 ≠ 业务层"的样板接线：

     Trigger → Candidate Builder → Recommendation → Adapter → Autonomy Core
             → Executor Bridge → Moments Creation Authority → Persistence Authority

   本阶段**只建立 adapter foundation**：
     · 不接真实 semantic recommendation（P25-2B：一次模型调用产出 post/skip + 草稿）；
     · 不迁移 scheduler（P25-2C：真正的触发切换）；
     · 不碰 P23 / P24 / Middle Brain / Memory / Group Brain / Diary / Economy /
       Image Router / 自动点赞评论。

   ── 责任边界（谁说了算）─────────────────────────────────────────────
     · **裁决权威** = P25 Autonomy Core。本模块**永远**显式提供 ctx.decide，
       绝不依赖 Core 的 default-allow（Core 无 decider 时默认 ALLOW —— 那是
       Core 的通用契约，不是 Moments 的生产行为）。
     · **业务资格** = 本模块的 fail-closed policy（prefs / recommendation /
       content / cooldown / duplicate）。"模型/角色想发" ≠ "允许发"。
     · **落盘权威** = Moments creation authority（createMoment）。
       本模块只**调用**它：不复制 DB 写逻辑、不认识 IndexedDB / Home Node /
       canonical / mirror，也不判断承载模式（那是写入权威的职责）。
     · **表现层** = 由 writer 侧的 presentation 选项决定（UI 刷新 / AI 互动管线），
       不是本模块的权限，也不是落盘的前置条件。

   ── 纯度（可静态断言）──────────────────────────────────────────────
     零 DOM / 零 fetch / 零 provider / 零模型调用 / 零 IndexedDB / 零 localStorage /
     零定时器 / 零 Memory。时间必须由调用方注入（deps.now）—— 本文件没有
     Date.now，也没有 Math.random。身份哈希复用 chat-core.stableToken（与群聊 /
     日记同一个原语），秘密探测复用 voice-message-core.findSecret。

   ── 手动路径豁免 ───────────────────────────────────────────────────
     用户手动发帖（authorType='user' / source='manual'）**完全绕过**本模块：
     composer → createMoment，零 autonomy 调用、零 cooldown、零 recommendation。
     本模块对 source:'user' 显式 fail closed（unsupported-source），
     绝不"替用户"走一遍自主策略。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      null,
      require('./chat-core.js'), require('./voice-message-core.js'),
      require('./autonomy-core.js'), require('./moments-semantic-core.js')
    );
  } else {
    root.IBMomentsAutonomy = factory(root, root.IBChatCore, root.IBVoiceMessage, root.IBAutonomyCore, root.IBMomentsSemanticCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VOICE, AUTONOMY, SEMANTIC_CORE) {
  'use strict';

  /* ── 闭集词表（唯一真源；不新增第二套）──────────────────────────────── */
  /* 契约版本：P25-2B 把 reasonCode 从 v1（2A 占位词表）升级到 v2（语义推荐词表）。
     v1 词表**保持可用**（已冻结的 2A 契约与测试不改），校验取两者并集；
     v2 词表的唯一真源是 moments-semantic-core（本模块不复制它的词表）。 */
  var CONTRACT_VERSION = 'moment-recommendation/v2';
  var SEMANTIC = (SEMANTIC_CORE && typeof SEMANTIC_CORE.MOMENT_SEMANTIC_POST_REASONS !== 'undefined') ? SEMANTIC_CORE : null;
  var ACTION_TYPE = 'moment.post';
  /* 本阶段允许的候选来源：schedule（调度触发）/ character（角色内在冲动）。
     `user` 在 P25 Core 词表里合法，但手动发帖不走 autonomy（见文件头）。 */
  var CANDIDATE_SOURCES = Object.freeze(['schedule', 'character']);
  /* Recommendation 闭集：只有"发"与"不发"，没有"也许"。 */
  var RECOMMENDATIONS = Object.freeze(['post', 'skip']);
  /* reasonCode 闭集：把"为什么"收敛成可审计的 id（不存 CoT / thinking / 自然语言）。 */
  var POST_REASONS = Object.freeze(['scheduled-window', 'character-impulse', 'recent-event', 'social-response', 'mood-shift']);
  var SKIP_REASONS = Object.freeze(['no-material', 'duplicate-topic', 'recently-active', 'quiet-hours', 'already-covered', 'low-value']);
  /* v2（语义推荐，P25-2B）：来自 moments-semantic-core 的闭集。 */
  var POST_REASONS_V2 = SEMANTIC ? SEMANTIC.MOMENT_SEMANTIC_POST_REASONS : Object.freeze([]);
  var SKIP_REASONS_V2 = SEMANTIC ? SEMANTIC.MOMENT_SEMANTIC_SKIP_REASONS : Object.freeze([]);
  var RECOMMENDATION_REASONS = Object.freeze(POST_REASONS.concat(POST_REASONS_V2).concat(SKIP_REASONS).concat(SKIP_REASONS_V2));
  var POST_REASONS_ALL = Object.freeze(POST_REASONS.concat(POST_REASONS_V2));
  var SKIP_REASONS_ALL = Object.freeze(SKIP_REASONS.concat(SKIP_REASONS_V2));
  /* 自由文本理由字段：出现即视为 malformed（绝不把模型的思路当成裁决依据或记录）。 */
  var FORBIDDEN_REASON_FIELDS = Object.freeze(['thinking', 'cot', 'rationale', 'reason', 'analysis', 'explanation']);
  /* adapter 级原因（**业务侧**预检 / policy）。P25 Core 的 AUTONOMY_REASONS 保持冻结，
     这些 id 只出现在本模块的返回值与 runtime trace 的 reason 字段里。 */
  var ADAPTER_REASONS = Object.freeze([
    'invalid-candidate', 'unsupported-source', 'identity-core-missing', 'autonomy-core-missing',
    'time-not-injected',
    'recommendation-missing', 'recommendation-malformed', 'recommendation-unknown', 'recommendation-skip',
    'prefs-unavailable', 'prefs-malformed', 'prefs-disabled', 'autopublish-disabled',
    'content-missing', 'content-empty', 'content-too-long', 'content-secret', 'content-rejected',
    'bad-visibility', 'bad-visible-roles', 'bad-motive', 'bad-images',
    'cooldown', 'cooldown-unavailable', 'duplicate-runtime', 'duplicate-content', 'history-unavailable',
    'policy-allow', 'policy-deny', 'policy-defer', 'policy-failure',
    'cancelled', 'no-executor', 'no-writer'
  ]);
  var VISIBILITY_VALUES = Object.freeze(['all', 'user', 'roles', 'private']);
  var MOTIVE_VALUES = Object.freeze(['share', 'daily_life', 'emotion', 'reflection', 'interaction', 'curiosity', 'social_response', 'none']);
  var FREQUENCY_VALUES = Object.freeze(['low', 'medium', 'high']);

  var MAX_ID_LEN = 200;
  var MAX_TRIGGER_LEN = 200;
  var MAX_FINGERPRINT_LEN = 120;
  var MAX_CONTENT_LEN = 2000;        /* 与 _momentsDefaults 的 slice(0,2000) 同源 */
  var MAX_IMAGES = 9;
  var MAX_VISIBLE_ROLES = 20;
  var HISTORY_LIMIT_DEFAULT = 6;
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }
  function errText(e) { return String((e && e.message) || e).slice(0, 200); }
  function dedupe(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }
  /* 秘密探测复用**既有** canonical detector（voice-message-core.findSecret）。 */
  function hasSecret(v) {
    try { if (VOICE && typeof VOICE.findSecret === 'function') return !!VOICE.findSecret(v); } catch (e) { /* 探测失败不阻断 */ }
    return false;
  }
  /* 身份哈希复用 chat-core.stableToken（与群聊 turnId / 日记同一个原语）。
     核心缺席 ⇒ 返回 '' ⇒ 调用方 fail closed（绝不退回 Math.random 式身份）。 */
  function stableToken(seed) {
    try { if (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') return str(CHAT_CORE.stableToken(seed)); } catch (e) { /* fall through */ }
    return '';
  }
  function usableId(v) {
    var s = str(v);
    if (!s || s !== s.trim() || s.length > MAX_ID_LEN) return false;
    return !CONTROL_PATTERN.test(s);
  }
  function validTime(v) { return typeof v === 'number' && isFinite(v) && v >= 0; }
  function hasAutonomyCore() { return !!(AUTONOMY && typeof AUTONOMY.runAutonomyAction === 'function'); }
  /* 全局对象解析：工厂函数创建于全局作用域，看不见 UMD 外层的 `root` 参数，
     因此 root 必须**作为参数**传进来，并且按调用时重新问一次（默认写者 / 偏好读取器
     都是延迟解析的——它们在页面加载很久之后才被需要）。 */
  function globalRoot() {
    try { if (typeof window !== 'undefined' && window) return window; } catch (e) { /* ignore */ }
    try { if (typeof self !== 'undefined' && self) return self; } catch (e) { /* ignore */ }
    try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) { /* ignore */ }
    return root || null;
  }
  function autonomyDecisions() {
    var d = (AUTONOMY && AUTONOMY.AUTONOMY_DECISIONS) || { ALLOW: 'allow', DENY: 'deny', DEFER: 'defer' };
    return d;
  }
  function decisionValues() {
    var d = autonomyDecisions();
    return [str(d.ALLOW || 'allow'), str(d.DENY || 'deny'), str(d.DEFER || 'defer')];
  }

  /* ── ① Candidate Contract ───────────────────────────────────────────
     { candidateId, actorId, actionType, source, triggerRef, topicFingerprint, context }

     candidateId 必须**确定性**：actorId + triggerRef + topicFingerprint 经
     stableToken 派生（同样的输入 ⇒ 同样的 id；不同 actor/trigger/topic ⇒ 不同 id）。
     topicFingerprint 是**语义/话题身份**，不是草稿全文 —— 传全文直接 fail closed。 */
  function buildMomentCandidate(input) {
    var errors = [];
    if (!isPlainObject(input)) return { ok: false, errors: ['not-an-object'] };
    var actorId = str(input.actorId);
    if (!actorId) errors.push('missing-actor-id');
    else if (!usableId(actorId)) errors.push('bad-actor-id');
    var source = str(input.source);
    if (!source) errors.push('missing-source');
    else if (CANDIDATE_SOURCES.indexOf(source) < 0) errors.push('unsupported-source');
    var triggerRef = str(input.triggerRef);
    if (!triggerRef) errors.push('missing-trigger-ref');
    else if (!usableId(triggerRef) || triggerRef.length > MAX_TRIGGER_LEN) errors.push('bad-trigger-ref');
    var topicFingerprint = str(input.topicFingerprint);
    if (!topicFingerprint) errors.push('missing-topic-fingerprint');
    else if (topicFingerprint !== topicFingerprint.trim() || topicFingerprint.length > MAX_FINGERPRINT_LEN
      || CONTROL_PATTERN.test(topicFingerprint)) errors.push('bad-topic-fingerprint');
    var draft = str(input.draft);
    if (draft && topicFingerprint) {
      var trimmed = draft.trim();
      if (topicFingerprint === trimmed || (trimmed.length >= 20 && topicFingerprint.indexOf(trimmed) >= 0)) {
        errors.push('fingerprint-looks-like-draft');
      }
    }
    var context = null;
    /* `context: null` 是**本模块自己的输出形状**（无上下文），因此它必须也是合法输入：
       finalizeMomentCandidate() 的候选会被直接喂回 runMomentAutonomy()，
       "输出不能当输入" 会让这条唯一身份链路在第二次使用时自杀。 */
    if (input.context !== undefined && input.context !== null) {
      if (!isPlainObject(input.context)) errors.push('bad-context');
      else if (hasSecret(input.context)) errors.push('secret-in-context');
      else context = Object.assign({}, input.context);
    }
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    var token = stableToken(actorId + '|' + triggerRef + '|' + topicFingerprint);
    if (!token) return { ok: false, errors: ['identity-core-missing'] };
    return {
      ok: true,
      errors: [],
      candidate: {
        candidateId: 'mca_' + token,
        actorId: actorId,
        actionType: ACTION_TYPE,
        source: source,
        triggerRef: triggerRef,
        topicFingerprint: topicFingerprint,
        context: context
      }
    };
  }
  function momentCandidateId(input) {
    var built = buildMomentCandidate(input);
    if (!built.ok) return { ok: false, errors: built.errors };
    return { ok: true, candidateId: built.candidate.candidateId, errors: [] };
  }
  /* 候选 → **稳定写入身份**。同一 candidateId 永远得到同一个 Moment id，
     因此重试不会产生第二条 Moment（幂等是写安全，不是文本相似度）。 */
  function momentIdForCandidate(candidateId) {
    var token = stableToken(str(candidateId));
    return token ? 'mom_' + token : '';
  }
  function adapterReasonForCandidate(errors) {
    if (errors.indexOf('identity-core-missing') >= 0) return 'identity-core-missing';
    if (errors.indexOf('unsupported-source') >= 0) return 'unsupported-source';
    return 'invalid-candidate';
  }
  /* ── Candidate Seed → Final Candidate（P25-2B §13/§38）────────────────
     Trigger 先给出**候选种子**（actorId + triggerRef + 可选 context），语义评估之后
     才知道话题身份；finalize 把二者合成为最终候选。

     冻结：candidate identity **只有这一个来源**（buildMomentCandidate）。
       同 actor/trigger/topic（措辞变化）⇒ 同 candidateId；
       话题改变 ⇒ 不同 candidateId；语义结果缺席/无 topic ⇒ 不产生候选。 */
  function finalizeMomentCandidate(seed, semanticRecommendation) {
    var s = isPlainObject(seed) ? seed : {};
    var rec = isPlainObject(semanticRecommendation) ? semanticRecommendation : {};
    var input = {
      actorId: str(s.actorId),
      source: str(s.source),
      triggerRef: str(s.triggerRef),
      topicFingerprint: str(rec.topicFingerprint),
      draft: str(rec.draft)
    };
    if (isPlainObject(s.context)) input.context = s.context;
    return buildMomentCandidate(input);
  }

  /* ── ② Recommendation Contract（本阶段**不调用模型**）──────────────────
     调用方/测试注入 { recommendation:'post'|'skip', reasonCode, topicFingerprint, draft? }。
     missing / malformed / 未知词 / 指纹不一致 ⇒ 失败对象（调用方据此 DENY）。 */
  function normalizeMomentRecommendation(rec, candidate) {
    if (rec === undefined || rec === null) return { ok: false, errors: ['missing-recommendation'] };
    if (!isPlainObject(rec)) return { ok: false, errors: ['recommendation-not-an-object'] };
    var errors = [];
    for (var i = 0; i < FORBIDDEN_REASON_FIELDS.length; i++) {
      if (rec[FORBIDDEN_REASON_FIELDS[i]] !== undefined) errors.push('free-text-reason-forbidden');
    }
    var r = str(rec.recommendation);
    if (!r) errors.push('missing-recommendation-value');
    else if (RECOMMENDATIONS.indexOf(r) < 0) errors.push('unknown-recommendation');
    var reasonCode = str(rec.reasonCode);
    if (!reasonCode) errors.push('missing-reason-code');
    else if (RECOMMENDATION_REASONS.indexOf(reasonCode) < 0) errors.push('unknown-reason-code');
    else if (r === 'post' && POST_REASONS_ALL.indexOf(reasonCode) < 0) errors.push('reason-code-mismatch');
    else if (r === 'skip' && SKIP_REASONS_ALL.indexOf(reasonCode) < 0) errors.push('reason-code-mismatch');
    var fingerprint = rec.topicFingerprint === undefined ? null : str(rec.topicFingerprint);
    if (fingerprint === null) errors.push('missing-fingerprint');
    else if (candidate && str(candidate.topicFingerprint) !== fingerprint) errors.push('fingerprint-mismatch');
    var draft = rec.draft === undefined ? '' : rec.draft;
    if (draft !== '' && typeof draft !== 'string') errors.push('bad-draft');
    errors = dedupe(errors);
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, errors: [], recommendation: r, reasonCode: reasonCode, topicFingerprint: fingerprint, draft: str(draft) };
  }
  function adapterReasonForRecommendation(errors) {
    if (errors.indexOf('missing-recommendation') >= 0) return 'recommendation-missing';
    if (errors.indexOf('unknown-recommendation') >= 0 || errors.indexOf('unknown-reason-code') >= 0
      || errors.indexOf('reason-code-mismatch') >= 0) return 'recommendation-unknown';
    return 'recommendation-malformed';
  }

  /* ── ③ Settings Authority（复用 canonical key ib_moments_prefs_v1）────
     只读 enabled / autoPublish / frequency 三项；读不到、读失败、字段畸形 ⇒ DENY。
     纯 contract 不直接绑 DOM：测试注入 deps.readPrefs / deps.prefs，
     浏览器默认解析走既有 IB.moments._momentsPrefs（唯一偏好真源）。 */
  function prodPrefsReader() {
    var g = globalRoot();
    try {
      var IB = g && g.IB;
      var moments = IB && IB.moments;
      if (moments && typeof moments._momentsPrefs === 'function') return moments._momentsPrefs;
    } catch (e) { /* ignore */ }
    return null;
  }
  function readMomentsPrefs(deps) {
    var d = isObject(deps) ? deps : {};
    var raw;
    try {
      if (typeof d.readPrefs === 'function') raw = d.readPrefs();
      else if (d.prefs !== undefined) raw = d.prefs;
      else {
        var reader = prodPrefsReader();
        if (!reader) return { ok: false, reason: 'prefs-unavailable', errors: ['no-prefs-reader'] };
        raw = reader();
      }
    } catch (error) {
      return { ok: false, reason: 'prefs-unavailable', errors: ['read-failed'] };
    }
    if (!isPlainObject(raw)) return { ok: false, reason: 'prefs-unavailable', errors: ['not-an-object'] };
    if (typeof raw.enabled !== 'boolean' || typeof raw.autoPublish !== 'boolean') {
      return { ok: false, reason: 'prefs-malformed', errors: ['bad-flags'] };
    }
    var frequency = raw.frequency === undefined ? 'medium' : str(raw.frequency);
    if (FREQUENCY_VALUES.indexOf(frequency) < 0) return { ok: false, reason: 'prefs-malformed', errors: ['bad-frequency'] };
    return { ok: true, prefs: { enabled: raw.enabled, autoPublish: raw.autoPublish, frequency: frequency } };
  }

  /* ── ④ Content Contract（executor bridge 的安全接缝）───────────────────
     空 / 非法 / 超长 / 明显 secret 形态 ⇒ 拒绝（绝不发空 Moment、绝不发 placeholder）。
     可选 deps.contentSanitizer 是**注入接缝**（2B/2C 的敏感信息清洗挂这里）；
     它抛错 ⇒ policy-failure ⇒ DENY（fail closed），绝不是"清洗失败就照发"。 */
  function resolveMomentContent(rec, deps) {
    var draft = str(rec && rec.draft);
    if (!draft) return { ok: false, reason: 'content-missing' };
    var content = draft.trim();
    if (!content) return { ok: false, reason: 'content-empty' };
    if (content.length > MAX_CONTENT_LEN) return { ok: false, reason: 'content-too-long' };
    if (hasSecret(content)) return { ok: false, reason: 'content-secret' };
    var sanitizer = (isObject(deps) && typeof deps.contentSanitizer === 'function') ? deps.contentSanitizer : null;
    if (sanitizer) {
      var out = sanitizer(content);
      if (out === false || out === null || out === undefined) return { ok: false, reason: 'content-rejected' };
      if (typeof out === 'string') content = out.trim();
      else if (isPlainObject(out)) {
        if (out.ok !== true) return { ok: false, reason: 'content-rejected' };
        content = str(out.content === undefined ? content : out.content).trim();
      } else return { ok: false, reason: 'content-rejected' };
      if (!content) return { ok: false, reason: 'content-rejected' };
      if (hasSecret(content)) return { ok: false, reason: 'content-secret' };
    }
    return { ok: true, content: content };
  }

  /* ── ⑤ Post shape（visibility / visibleRoleIds / motive / images）──────
     只做"这就是要写的形状"的校验；可见性**语义**仍由写入权威 + 共享可见性核决定。
     本阶段不接图片生成：images 只允许已有 payload 或空数组。 */
  function resolvePostShape(deps) {
    var d = isObject(deps) ? deps : {};
    var visibility = d.visibility === undefined ? 'all' : str(d.visibility);
    if (VISIBILITY_VALUES.indexOf(visibility) < 0) return { ok: false, reason: 'bad-visibility' };
    var visibleRoleIds = [];
    if (visibility === 'roles') {
      if (!Array.isArray(d.visibleRoleIds)) return { ok: false, reason: 'bad-visible-roles' };
      visibleRoleIds = d.visibleRoleIds.slice(0, MAX_VISIBLE_ROLES).map(str).filter(Boolean);
      if (!visibleRoleIds.length) return { ok: false, reason: 'bad-visible-roles' };
    }
    var motive = d.motive === undefined ? '' : str(d.motive);
    if (motive && MOTIVE_VALUES.indexOf(motive) < 0) return { ok: false, reason: 'bad-motive' };
    if (motive === 'none') motive = '';
    var images = [];
    if (d.images !== undefined) {
      if (!Array.isArray(d.images)) return { ok: false, reason: 'bad-images' };
      images = d.images.slice(0, MAX_IMAGES).filter(function (im) { return isObject(im) && str(im.dataUrl); });
    }
    return {
      ok: true, visibility: visibility, visibleRoleIds: visibleRoleIds, motive: motive,
      images: images, presentation: d.presentation !== false
    };
  }

  /* ── ⑥ Cooldown（只做事实搬运，不发明策略）──────────────────────────
     把既有调度事实（lastPostAt / 频率间隔 / nextAt）转成 Core 的
     ctx.cooldownMsFor —— 具体分钟数**不进 Autonomy Core**。
     来源读失败 ⇒ cooldown-unavailable ⇒ DENY（Core 内部对 cooldownMsFor 抛错
     是"不阻断"，所以本模块**不把会抛错的函数交给 Core**）。 */
  function resolveCooldown(deps, action, now) {
    var d = isObject(deps) ? deps : {};
    var ms = null, lastPostAt = null;
    try {
      if (typeof d.cooldownMsFor === 'function') ms = d.cooldownMsFor(action);
      else if (d.cooldownMs !== undefined) ms = d.cooldownMs;
      if (typeof d.readLastPostAt === 'function') lastPostAt = d.readLastPostAt(str(action && action.actorId));
      else if (d.lastPostAt !== undefined) lastPostAt = d.lastPostAt;
    } catch (error) {
      return { ok: false, reason: 'cooldown-unavailable', errors: ['read-failed'] };
    }
    var cooldownMs = (typeof ms === 'number' && isFinite(ms) && ms > 0) ? Math.floor(ms) : 0;
    var last = (typeof lastPostAt === 'number' && isFinite(lastPostAt) && lastPostAt > 0 && lastPostAt <= now)
      ? Math.floor(lastPostAt) : null;
    return { ok: true, cooldownMs: cooldownMs, lastPostAt: last };
  }

  /* ── ⑦ Cross-session duplicate（从 canonical Moments 历史派生）────────
     不新增 store、不复制查询逻辑：读入口由调用方注入（生产应复用
     getRoleMoments / _momentsRecentOwn 这一层只读 helper）。
     本阶段只做**精确文本**判定 —— 相似度仍归既有写入侧管线，
     文本相似度**不是**幂等（幂等 = candidateId → 稳定 Moment id）。 */
  function toTimeMs(v) {
    if (typeof v === 'number' && isFinite(v) && v > 0) return Math.floor(v);
    var raw = str(v);
    if (!raw) return null;
    var parsed = Date.parse(raw);
    return isFinite(parsed) ? parsed : null;
  }
  function buildHistoryFacts(deps, actorId, content) {
    var d = isObject(deps) ? deps : {};
    var reader = (typeof d.readRecentOwnMoments === 'function') ? d.readRecentOwnMoments : null;
    if (!reader) return Promise.resolve({ ok: true, provided: false, count: 0, latestId: '', latestAt: null, duplicate: false });
    var rows;
    try { rows = reader(actorId, HISTORY_LIMIT_DEFAULT); }
    catch (error) { return Promise.resolve({ ok: false, reason: 'history-unavailable', errors: ['read-failed'] }); }
    return Promise.resolve(rows).then(function (list) {
      if (!Array.isArray(list)) return { ok: false, reason: 'history-unavailable', errors: ['not-an-array'] };
      var mine = list.filter(function (row) {
        return isObject(row) && (str(row.roleId) === str(actorId) || str(row.authorId) === str(actorId));
      });
      var wanted = str(content).trim();
      var duplicate = false, latestId = '', latestAt = null;
      for (var i = 0; i < mine.length; i++) {
        var row = mine[i];
        if (!latestId) {
          latestId = str(row.id);
          latestAt = toTimeMs(row.createdAt);
        }
        if (wanted && str(row.content).trim() === wanted) { duplicate = true; break; }
      }
      return { ok: true, provided: true, count: mine.length, latestId: latestId, latestAt: latestAt, duplicate: duplicate };
    }, function () { return { ok: false, reason: 'history-unavailable', errors: ['read-failed'] }; });
  }

  /* ── ⑧ Action mapping（candidate → Autonomy action）───────────────────
     只带业务事实：**绝不**把 provider 配置 / API key / raw cfg 塞进 context。 */
  function buildMomentAction(candidate, content, shape) {
    var c = isObject(candidate) ? candidate : {};
    var s = isObject(shape) ? shape : {};
    return {
      actionType: ACTION_TYPE,
      actorId: str(c.actorId),
      source: str(c.source),
      fingerprint: str(c.topicFingerprint),
      context: {
        candidateId: str(c.candidateId),
        momentId: momentIdForCandidate(str(c.candidateId)),
        topicFingerprint: str(c.topicFingerprint),
        triggerRef: str(c.triggerRef),
        content: str(content),
        visibility: str(s.visibility || 'all'),
        visibleRoleIds: Array.isArray(s.visibleRoleIds) ? s.visibleRoleIds.slice() : [],
        motive: str(s.motive),
        images: Array.isArray(s.images) ? s.images.slice() : [],
        presentation: s.presentation !== false,
        recommendation: str(s.recommendation),
        reasonCode: str(s.reasonCode)
      }
    };
  }

  /* ── ⑨ Executor bridge ────────────────────────────────────────────────
     只做一件事：把**已授权**的 action 交给既有 Moment creation authority。
     它不是 decision layer —— 不重新做 recommendation / policy / cooldown / duplicate。
     写入失败**不改成 DENY**：ALLOW + 执行失败 = ok:false（可诊断、可重试）。 */
  function resolveWriter(deps) {
    var d = isObject(deps) ? deps : {};
    if (typeof d.writeMoment === 'function') return d.writeMoment;
    var g = globalRoot();
    try {
      var IB = g && g.IB;
      if (IB && IB.moments && typeof IB.moments.createMoment === 'function') return IB.moments.createMoment;
      if (g && typeof g.createMoment === 'function') return g.createMoment;
    } catch (e) { /* ignore */ }
    return null;
  }
  function executeMomentPost(action, deps) {
    var d = isObject(deps) ? deps : {};
    var context = isObject(action) && isObject(action.context) ? action.context : {};
    var payload = {
      id: str(context.momentId),
      authorType: 'role',
      roleId: str(action && action.actorId),
      content: str(context.content),
      source: 'proactive',
      visibility: str(context.visibility || 'all'),
      visibleRoleIds: Array.isArray(context.visibleRoleIds) ? context.visibleRoleIds.slice(0, MAX_VISIBLE_ROLES) : [],
      motive: str(context.motive),
      images: Array.isArray(context.images) ? context.images.slice(0, MAX_IMAGES) : []
    };
    var writer = resolveWriter(d);
    if (!writer) return Promise.resolve({ ok: false, error: 'no-writer' });
    if (!payload.roleId || !payload.content.trim()) return Promise.resolve({ ok: false, error: 'invalid-payload' });
    var options = {};
    if (payload.id) options.id = payload.id;                       /* 稳定身份 ⇒ 幂等 */
    if (str(context.candidateId)) options.requestId = str(context.candidateId);  /* 权威侧重放保护 */
    if (context.presentation === false) options.presentation = false;             /* 纯持久化 */
    var pending;
    try { pending = writer(payload, options); }
    catch (error) { return Promise.resolve({ ok: false, error: errText(error) }); }
    return Promise.resolve(pending).then(function (res) {
      var ok = !!(res && res.ok === true);
      var persistence = (res && isObject(res.persistence)) ? res.persistence : {};
      return {
        ok: ok,
        id: str(res && res.moment && res.moment.id) || payload.id || '',
        moment: (res && res.moment) || null,
        outcome: str(persistence.outcome),
        authority: str(persistence.authority),
        error: ok ? '' : errText(res && res.error)
      };
    }, function (error) { return { ok: false, error: errText(error) }; });
  }

  /* ── ⑩ Runtime trace（继续用 P25 Core 的 trace 口径）──────────────────
     只有"连 action 都构造不出来"的极早期拒绝才由本模块自己记账
     （Core 缺席 / 输入不是对象）；其余全部经 Core，由 Core 记录。 */
  function traceEntry(state, actionType, actorId, decision, reason, now) {
    try {
      if (!isObject(state) || !Array.isArray(state.trace)) return null;
      var entry = {
        actionType: str(actionType), actorId: str(actorId),
        decision: str(decision), reason: str(reason),
        timestamp: validTime(now) ? Math.floor(now) : null
      };
      state.trace.push(entry);
      var limit = (AUTONOMY && AUTONOMY.AUTONOMY_TRACE_LIMIT) || 50;
      while (state.trace.length > limit) state.trace.shift();
      return entry;
    } catch (e) { return null; }
  }
  function resultBase(state, candidate, now) {
    return {
      ok: false, decision: 'deny', reason: '', coreReason: '', executed: false, written: false,
      idempotent: false, explicitPolicy: false,
      candidateId: str(candidate && candidate.candidateId), momentId: '', actorId: str(candidate && candidate.actorId),
      source: str(candidate && candidate.source), topicFingerprint: str(candidate && candidate.topicFingerprint),
      reasonCode: '', moment: null, persistence: null, error: '', errors: [], trace: null, state: state
    };
  }
  function adapterReasonForCore(coreReason, guard) {
    switch (str(coreReason)) {
      case 'default-allow': return 'policy-allow';
      case 'duplicate': return 'duplicate-runtime';
      case 'cooldown': return 'cooldown';
      case 'decision-deny': return guard ? guard.reason : 'policy-deny';
      case 'decision-defer': return 'policy-defer';
      case 'decision-failure': return 'policy-failure';
      case 'invalid-action': return guard ? guard.reason : 'invalid-candidate';
      case 'cancelled': return 'cancelled';
      case 'no-executor': return 'no-executor';
      default: return str(coreReason) || 'policy-failure';
    }
  }

  /* ── 唯一入口：candidate → recommendation → policy → Core → executor ── */
  async function runMomentAutonomy(input, deps) {
    var d = isObject(deps) ? deps : {};
    var now = validTime(d.now) ? Math.floor(d.now) : null;
    var state = isObject(d.state)
      ? d.state
      : (hasAutonomyCore() ? AUTONOMY.createAutonomyState() : { trace: [], lastExecuted: Object.create(null) });

    /* 极早期：连 action 都构造不出来 ⇒ 本模块记录 trace 后拒绝。 */
    if (!isPlainObject(input)) {
      var early = resultBase(state, null, now);
      early.reason = 'invalid-candidate';
      early.errors = ['not-an-object'];
      early.trace = traceEntry(state, ACTION_TYPE, '', 'deny', early.reason, now);
      return early;
    }
    if (!hasAutonomyCore()) {
      var noCore = resultBase(state, null, now);
      noCore.reason = 'autonomy-core-missing';
      noCore.errors = ['autonomy-core-missing'];
      noCore.trace = traceEntry(state, ACTION_TYPE, str(input.actorId), 'deny', noCore.reason, now);
      return noCore;
    }

    /* ① candidate */
    var built = buildMomentCandidate(input);
    var candidate = built.ok ? built.candidate : null;
    var seed = candidate || {
      candidateId: '', actorId: str(input.actorId), source: str(input.source),
      triggerRef: str(input.triggerRef), topicFingerprint: str(input.topicFingerprint)
    };
    /* ②–⑦ 事实解析（注入的读口 / 清洗钩子**抛错**一律收敛成 policy-failure ⇒ DENY）。
       recommendation 由测试/调用方注入（本阶段零模型调用）。 */
    var rec = { ok: false, errors: ['missing-recommendation'] };
    var prefs = { ok: false, reason: 'prefs-unavailable', errors: [] };
    var content = { ok: false, reason: 'content-missing' };
    var shape = { ok: true, visibility: 'all', visibleRoleIds: [], motive: '', images: [], presentation: true };
    var history = { ok: true, provided: false, count: 0, latestId: '', latestAt: null, duplicate: false };
    var cooldown = { ok: true, cooldownMs: 0, lastPostAt: null };
    var fatal = null;
    var action = null;
    try {
      rec = normalizeMomentRecommendation(d.recommendation, seed);
      prefs = readMomentsPrefs(d);
      content = rec.ok ? resolveMomentContent(rec, d) : { ok: false, reason: 'content-missing' };
      shape = resolvePostShape(d);
      if (shape.ok) {
        shape.recommendation = rec.ok ? rec.recommendation : '';
        shape.reasonCode = rec.ok ? rec.reasonCode : '';
      }
      /* ⑧ action（即使 candidate 非法也构造，让 Core 的权威判据与 trace 生效） */
      action = buildMomentAction(seed, content.ok ? content.content : '', shape.ok ? shape : {});
      /* ⑦ cross-session duplicate（只读派生，不新增 store） */
      history = await buildHistoryFacts(d, str(seed.actorId), content.ok ? content.content : '');
      /* ⑥ cooldown 事实 */
      cooldown = resolveCooldown(d, action, now === null ? 0 : now);
    } catch (error) {
      fatal = errText(error);
    }
    if (!action) action = buildMomentAction(seed, '', {});

    /* guard：第一个不通过的判据决定 adapter 级原因（顺序即优先级）。 */
    var guard = null;
    if (!built.ok) guard = { reason: adapterReasonForCandidate(built.errors), errors: built.errors };
    else if (fatal !== null) guard = { reason: 'policy-failure', errors: [fatal] };
    else if (!rec.ok) guard = { reason: adapterReasonForRecommendation(rec.errors), errors: rec.errors };
    else if (!prefs.ok) guard = { reason: prefs.reason, errors: prefs.errors || [] };
    else if (prefs.prefs.enabled !== true) guard = { reason: 'prefs-disabled', errors: [] };
    else if (prefs.prefs.autoPublish !== true) guard = { reason: 'autopublish-disabled', errors: [] };
    else if (rec.recommendation === 'skip') guard = { reason: 'recommendation-skip', errors: [] };
    else if (!content.ok) guard = { reason: content.reason, errors: [] };
    else if (now === null) guard = { reason: 'time-not-injected', errors: [] };
    else if (!shape.ok) guard = { reason: shape.reason, errors: [] };
    else if (!cooldown.ok) guard = { reason: cooldown.reason, errors: cooldown.errors || [] };
    else if (!history.ok) guard = { reason: history.reason, errors: history.errors || [] };
    else if (history.duplicate) guard = { reason: 'duplicate-content', errors: [] };

    /* ctx.decide：**永远显式传**（绝不依赖 Core 的 default-allow）。 */
    var ctx = {};
    if (now !== null) ctx.now = now;
    if (typeof d.duplicateWindowMs === 'number' && isFinite(d.duplicateWindowMs) && d.duplicateWindowMs >= 0) {
      ctx.duplicateWindowMs = Math.floor(d.duplicateWindowMs);
    }
    if (cooldown.ok && cooldown.cooldownMs > 0 && cooldown.lastPostAt !== null && now !== null
      && isObject(state.lastExecuted) && typeof AUTONOMY.autonomyFingerprint === 'function') {
      var fp = AUTONOMY.autonomyFingerprint(action);
      if (fp && state.lastExecuted[fp] === undefined) state.lastExecuted[fp] = cooldown.lastPostAt;
      ctx.cooldownMsFor = function () { return cooldown.cooldownMs; };
    }
    var extraDecision = '';
    ctx.decide = function (brief) {
      if (guard) return { decision: autonomyDecisions().DENY };
      if (typeof d.extraPolicy === 'function') {
        var out = d.extraPolicy({
          actionType: str(brief && brief.actionType), actorId: str(brief && brief.actorId),
          source: str(brief && brief.source), context: isObject(brief && brief.context) ? brief.context : null
        });
        var allowed = decisionValues();
        if (!isPlainObject(out) || allowed.indexOf(str(out.decision)) < 0) {
          /* 未知裁决 ⇒ 抛错 ⇒ Core 记 decision-failure ⇒ DENY（fail closed） */
          throw new Error('moments-policy-unknown-decision');
        }
        extraDecision = str(out.decision);
        return { decision: extraDecision };
      }
      return { decision: autonomyDecisions().ALLOW };
    };

    var pending = null;
    var executor = function (act) { pending = executeMomentPost(act, d); };
    var verdict = AUTONOMY.runAutonomyAction(state, action, ctx, executor);

    var result = resultBase(state, candidate || seed, now);
    result.decision = str(verdict.decision);
    result.coreReason = str(verdict.reason);
    result.reason = adapterReasonForCore(verdict.reason, guard);
    result.executed = verdict.executed === true;
    result.explicitPolicy = true;
    result.momentId = str(action.context.momentId);
    result.reasonCode = rec.ok ? rec.reasonCode : '';
    result.errors = guard ? (guard.errors || []) : [];
    result.trace = verdict.trace || null;
    result.ok = false;

    if (result.decision !== autonomyDecisions().ALLOW) {
      if (extraDecision === autonomyDecisions().DEFER) result.reason = 'policy-defer';
      return result;
    }
    var write = (pending === null) ? { ok: false, error: 'no-writer', outcome: '', authority: '' } : await pending;
    result.ok = write.ok === true;
    result.written = write.ok === true;
    result.idempotent = write.ok === true && (write.outcome === 'replayed' || write.outcome === 'skipped');
    result.moment = write.moment || null;
    result.persistence = { authority: str(write.authority), outcome: str(write.outcome) };
    result.error = write.ok === true ? '' : str(write.error);
    if (write.id) result.momentId = str(write.id);
    return result;
  }

  /* ── Adapter 工厂：依赖一次注入，state 跨调用（runtime-only）────────── */
  function createMomentsAutonomyAdapter(deps) {
    var base = isObject(deps) ? deps : {};
    var state = isObject(base.state)
      ? base.state
      : (hasAutonomyCore() ? AUTONOMY.createAutonomyState() : { trace: [], lastExecuted: Object.create(null) });
    function merged(override) {
      return isPlainObject(override) ? Object.assign({}, base, override, { state: state }) : Object.assign({}, base, { state: state });
    }
    return {
      state: state,
      buildCandidate: buildMomentCandidate,
      finalizeCandidate: finalizeMomentCandidate,
      run: function (input, override) { return runMomentAutonomy(input, merged(override)); },
      execute: function (action) { return executeMomentPost(action, merged({})); },
      trace: function () {
        return (AUTONOMY && typeof AUTONOMY.autonomyTraceSnapshot === 'function') ? AUTONOMY.autonomyTraceSnapshot(state) : [];
      }
    };
  }

  var CONTRACT = Object.freeze({
    version: CONTRACT_VERSION,
    actionType: ACTION_TYPE,
    candidateSources: CANDIDATE_SOURCES,
    recommendations: RECOMMENDATIONS,
    postReasons: POST_REASONS,
    skipReasons: SKIP_REASONS,
    semanticPostReasons: POST_REASONS_V2,
    semanticSkipReasons: SKIP_REASONS_V2,
    adapterReasons: ADAPTER_REASONS,
    visibility: VISIBILITY_VALUES,
    motives: MOTIVE_VALUES,
    frequencies: FREQUENCY_VALUES,
    limits: Object.freeze({
      maxIdLen: MAX_ID_LEN, maxTriggerLen: MAX_TRIGGER_LEN, maxFingerprintLen: MAX_FINGERPRINT_LEN,
      maxContentLen: MAX_CONTENT_LEN, maxImages: MAX_IMAGES, maxVisibleRoles: MAX_VISIBLE_ROLES,
      historyLimit: HISTORY_LIMIT_DEFAULT
    })
  });

  return {
    MOMENTS_AUTONOMY_CONTRACT: CONTRACT,
    MOMENT_CONTRACT_VERSION: CONTRACT_VERSION,
    MOMENT_ACTION_TYPE: ACTION_TYPE,
    MOMENT_CANDIDATE_SOURCES: CANDIDATE_SOURCES,
    MOMENT_RECOMMENDATIONS: RECOMMENDATIONS,
    MOMENT_POST_REASONS: POST_REASONS,
    MOMENT_SKIP_REASONS: SKIP_REASONS,
    MOMENT_SEMANTIC_POST_REASONS_V2: POST_REASONS_V2,
    MOMENT_SEMANTIC_SKIP_REASONS_V2: SKIP_REASONS_V2,
    MOMENT_RECOMMENDATION_REASONS: RECOMMENDATION_REASONS,
    MOMENT_ADAPTER_REASONS: ADAPTER_REASONS,
    buildMomentCandidate: buildMomentCandidate,
    finalizeMomentCandidate: finalizeMomentCandidate,
    momentCandidateId: momentCandidateId,
    momentIdForCandidate: momentIdForCandidate,
    normalizeMomentRecommendation: normalizeMomentRecommendation,
    readMomentsPrefs: readMomentsPrefs,
    resolveMomentContent: resolveMomentContent,
    resolvePostShape: resolvePostShape,
    buildMomentAction: buildMomentAction,
    executeMomentPost: executeMomentPost,
    runMomentAutonomy: runMomentAutonomy,
    createMomentsAutonomyAdapter: createMomentsAutonomyAdapter
  };
});
