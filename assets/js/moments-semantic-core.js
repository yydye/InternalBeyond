/* ====================================================================
   IB Moments Semantic Core — P25-2B · Semantic Recommendation Contract
   --------------------------------------------------------------------
   本模块是 Moments 语义输出的**唯一**实现（UMD 双载；浏览器
   `window.IBMomentsSemanticCore`，Node 侧 require）：

     · canonical semantic output 契约（recommendation / reasonCode / topic / draft）
     · 唯一 parser（结构校验、闭集校验、禁推理字段、长度上限）
     · topic identity → normalize → deterministic fingerprint
     · legacy（v1 `publish:true/false`）兼容投影 —— 兼容只存在于**一处** seam

   ── 它不是什么 ─────────────────────────────────────────────────────
     不裁决（那是 P25 Autonomy Core）、不执行（那是 executor）、不写库
     （那是 Moments creation authority）、不调模型 / provider（那是 Moments
     generation domain）、不读 Memory、不认识 DOM / IndexedDB / 网络。

   ── 冻结语义 ───────────────────────────────────────────────────────
     · recommendation 只有 `post` / `skip`：模型**不能**返回 permission
       （allow / deny / defer 属于 Autonomy Policy，不属于语义推荐）；
     · `recommendation:'post'` **绝不等于** 允许发布；
     · `reasonCode` 闭集，且方向必须一致（post 词表只能配 post）；
     · 禁止 thinking / CoT / analysis / rationale 等推理字段：出现即 malformed，
       绝不被保存、绝不被写进 trace；
     · `topicKey` 是**语义话题身份**（不是正文、不是标题、不是哈希），
       由本模块 normalize 后经 chat-core.stableToken 派生 `topicFingerprint`
       —— 模型不拥有 candidate identity；
     · 改措辞不改话题 ⇒ fingerprint 不变；换话题 ⇒ fingerprint 改变。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(null, require('./chat-core.js'), require('./moments-visibility-core.js'));
  } else {
    root.IBMomentsSemanticCore = factory(root, root.IBChatCore, root.IBMomentsVisibilityCore);
  }
})(typeof self !== 'undefined' ? self : this, function (root, CHAT_CORE, VISIBILITY_CORE) {
  'use strict';

  var CONTRACT_ID = 'moment-semantic/v2';
  var LEGACY_CONTRACT_ID = 'moment-legacy/v1';

  /* ── recommendation 闭集（模型只能在这两个之间选）──────────────────── */
  var RECOMMENDATIONS = Object.freeze(['post', 'skip']);

  /* ── reasonCode 闭集（由当前产品语义与 MOMENT_MOTIVES 收敛而来）────────
     post：从"为什么值得发"出发（动机枚举 share/daily_life/emotion/reflection/
           interaction/curiosity/social_response 与现有 prompt 的写作要求在语义上合并）；
     skip：从"为什么不发"出发（现有 prompt 的两条核心：没有具体支撑 / 与最近太像，
           再加上空泛、无上下文、不适合公开表达三种真实情况）。 */
  var POST_REASONS = Object.freeze([
    'meaningful-moment',      /* 有具体的人/事/物/场景 */
    'personal-feeling',       /* 有想表达的情绪 */
    'reflection-on-recent',   /* 对近期的事产生了想法 */
    'interaction-followup',   /* 与用户/朋友的近期互动引发 */
    'curiosity-share',        /* 看到或想到什么想分享/讨论 */
    'social-response'         /* 对近期社交事件的回应 */
  ]);
  var SKIP_REASONS = Object.freeze([
    'nothing-to-share',       /* 今天没有具体支撑（"宁可不发"的默认结果） */
    'too-similar-recent',     /* 与最近发过的内容过于相似 */
    'low-substance',          /* 只有换谁都成立的空泛句 */
    'no-context',             /* 缺少可依托的具体情境 */
    'unsuitable-content'      /* 内容不适合公开表达 */
  ]);
  var ALL_REASONS = Object.freeze(POST_REASONS.concat(SKIP_REASONS));

  /* 展示用短标签（**只用于旧 UI 文案**：reasonCode 进契约与 trace，标签进 toast）。
     它不是第二套语义词表 —— 键就是上面的闭集。 */
  var REASON_LABELS = Object.freeze({
    'meaningful-moment': '今天有具体想分享的事',
    'personal-feeling': '有想表达的情绪',
    'reflection-on-recent': '对最近的事有点想法',
    'interaction-followup': '想接着说刚才的互动',
    'curiosity-share': '看到或想到什么想分享',
    'social-response': '想回应最近的社交事件',
    'nothing-to-share': '今天没有什么值得分享的',
    'too-similar-recent': '和最近发过的太像了',
    'low-substance': '想说的太空泛',
    'no-context': '这次没有可依托的具体情境',
    'unsuitable-content': '这件事不适合发出来'
  });

  /* legacy `motive` → reasonCode（旧契约没有语义理由，只有动机标注）：
     兼容 seam 的**唯一**映射，绝不反向影响新契约。 */
  var LEGACY_MOTIVE_REASON = Object.freeze({
    share: 'meaningful-moment',
    daily_life: 'meaningful-moment',
    emotion: 'personal-feeling',
    reflection: 'reflection-on-recent',
    interaction: 'interaction-followup',
    curiosity: 'curiosity-share',
    social_response: 'social-response'
  });
  var LEGACY_DEFAULT_POST_REASON = 'meaningful-moment';
  var LEGACY_DEFAULT_SKIP_REASON = 'nothing-to-share';

  /* 禁止的推理字段：出现即 malformed（绝不保存、绝不进 trace）。 */
  var FORBIDDEN_OUTPUT_FIELDS = Object.freeze([
    'thinking', 'cot', 'chainofthought', 'chain_of_thought', 'reasoning',
    'analysis', 'rationale', 'explanation', 'scratchpad', 'steps'
  ]);

  var VISIBILITY_VALUES = Object.freeze(['all', 'user', 'roles', 'private']);
  var MOTIVE_VALUES = Object.freeze(['share', 'daily_life', 'emotion', 'reflection', 'interaction', 'curiosity', 'social_response', 'none']);
  var MAX_CONTENT_LEN = 2000;        /* 与 _momentsDefaults / canonical store 同源 */
  var MAX_IMAGE_PROMPT_LEN = 600;    /* 与既有 parser 同源 */
  var MAX_TOPIC_KEY_LEN = 40;
  var MAX_VISIBLE_ROLES = 20;
  var TOPIC_SEPARATOR = '-';
  var TOPIC_FINGERPRINT_PREFIX = 'mt_';
  var CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
  /* topicKey 允许的字符：拉丁字母/数字、连字符、以及 CJK（模型常用中文话题词）。
     其它标点 / 空白一律先归一为连字符，再做长度与形态校验。 */
  var TOPIC_DISALLOWED = /[\s\u3000]+/g;
  var TOPIC_PUNCT = /[^\p{Letter}\p{Number}\-]+/gu;
  /* 话题词里不应该出现的成句标点（出现即说明它更像一句话/正文）。 */
  var SENTENCE_PUNCT = /[。！？!?;；:：,，、"'“”‘’()（）\[\]{}<>《》]/;

  /* canonical 输出契约的 JSON 形态（prompt 与 correction 提示共用同一份，
     因此"prompt 要求的字段"与"parser 校验的字段"在结构上不可能漂移）。 */
  var OUTPUT_JSON_SCHEMA = '{"recommendation":"post|skip","reasonCode":"'
    + POST_REASONS.join('|') + '|' + SKIP_REASONS.join('|')
    + '","topicKey":"这一条动态的话题标识（2-6 个词，用 - 连接，例如 rainy-window / 雨天的窗台）","draft":'
    + '{"content":"正文","visibility":"all|user|roles|private","visibleRoleIds":[],"motive":"'
    + MOTIVE_VALUES.join('|') + '","wantImage":true|false,"imagePrompt":"想配图时的画面描述（≤120字）"}}';
  var SKIP_PREFIX = '{"recommendation":"skip","reasonCode":"nothing-to-share"}';
  var FORBIDDEN_FIELDS_SENTENCE = '只输出上面这一个 JSON 对象：不要输出 thinking / reasoning / analysis / rationale / explanation / 步骤 等任何推理内容，也不要输出多余的解释文字。';

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function str(v) { return v == null ? '' : String(v); }
  /* 全局对象解析：工厂函数是在**全局作用域**里创建后传进 UMD 外层的，因此它看不见
     外层的 `root` 参数 —— 早先这里直接引用 `root` 会抛 ReferenceError 并被 catch 吞掉，
     表现是"指纹恒为空"。因此把 root 作为参数传进工厂，并且**按调用时**重新问一次
     （浏览器侧 chat-core 属延迟加载，绝不能在加载时刻固化解析结果）。 */
  function globalRoot() {
    try { if (typeof window !== 'undefined' && window) return window; } catch (e) { /* ignore */ }
    try { if (typeof self !== 'undefined' && self) return self; } catch (e) { /* ignore */ }
    try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) { /* ignore */ }
    return root || null;
  }
  /* 复用既有 chat-core.stableToken（延迟解析，绝不在工厂参数里固化）。 */
  function chatCore() {
    var g = globalRoot();
    try {
      if (g && g.IBChatCore && typeof g.IBChatCore.stableToken === 'function') return g.IBChatCore;
    } catch (e) { /* ignore */ }
    return (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') ? CHAT_CORE : null;
  }
  /* 可见性归一复用**共享核**（绝不在这里写第二套 visibility 语义）。 */
  function visibilityCore() {
    var g = globalRoot();
    try {
      if (g && g.IBMomentsVisibilityCore && typeof g.IBMomentsVisibilityCore.writeVisibility === 'function') return g.IBMomentsVisibilityCore;
    } catch (e) { /* ignore */ }
    return (VISIBILITY_CORE && typeof VISIBILITY_CORE.writeVisibility === 'function') ? VISIBILITY_CORE : null;
  }
  function stableToken(seed) {
    var core = chatCore();
    try { if (core) return str(core.stableToken(seed)); } catch (e) { /* fall through */ }
    return '';
  }
  /* JSON 提取：**复用**既有唯一实现（浏览器 `_activeParsePlanJson`，Node 侧
     `active/plan-domain.js#parsePlanJson` 是它的逐字孪生）。测试/集成可经
     opts.parseJson 注入，绝不在这里写第二套容错解析。 */
  function jsonParser(opts) {
    if (opts && typeof opts.parseJson === 'function') return opts.parseJson;
    try { if (typeof _activeParsePlanJson === 'function') return _activeParsePlanJson; } catch (e) { /* ignore */ }
    try { if (root && typeof root._activeParsePlanJson === 'function') return root._activeParsePlanJson; } catch (e) { /* ignore */ }
    return null;
  }
  function dedupe(list) {
    var out = [], i;
    for (i = 0; i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }
  function isPostReason(code) { return POST_REASONS.indexOf(str(code)) >= 0; }
  function isSkipReason(code) { return SKIP_REASONS.indexOf(str(code)) >= 0; }
  function reasonLabel(code) { return str(REASON_LABELS[str(code)]) || str(code); }
  function hasForbiddenField(obj) {
    if (!isPlainObject(obj)) return '';
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var k = String(keys[i]).toLowerCase().replace(/[\s\-_]/g, '');
      for (var j = 0; j < FORBIDDEN_OUTPUT_FIELDS.length; j++) {
        if (k === FORBIDDEN_OUTPUT_FIELDS[j].replace(/[\s\-_]/g, '')) return String(keys[i]);
      }
    }
    /* draft 里同样不允许推理字段。 */
    if (isPlainObject(obj.draft)) return hasForbiddenField(obj.draft);
    return '';
  }

  /* ── topic identity ─────────────────────────────────────────────────
     归一规则（确定性、无时钟、无随机）：
       1) 去首尾空白；2) 空白/全角空格 → 连字符；3) 其它标点 → 连字符；
       4) 连字符折叠；5) 去首尾连字符；6) 长度 ≤ MAX_TOPIC_KEY_LEN。
     校验（失败即 malformed）：
       · 归一后为空；· 超长；· 含控制字符；· 含成句标点（更像正文）；
       · 与正文完全相同或完整包含正文（禁止用正文当话题身份）。 */
  function normalizeTopicKey(raw, draftContent) {
    var key = str(raw);
    if (!key) return { ok: false, error: 'missing-topic-key' };
    if (CONTROL_PATTERN.test(key)) return { ok: false, error: 'bad-topic-key' };
    var normalized = key.trim().replace(TOPIC_DISALLOWED, TOPIC_SEPARATOR).replace(TOPIC_PUNCT, TOPIC_SEPARATOR);
    normalized = normalized.replace(/-+/g, TOPIC_SEPARATOR).replace(/^-+|-+$/g, '');
    if (!normalized) return { ok: false, error: 'bad-topic-key' };
    if (normalized.length > MAX_TOPIC_KEY_LEN) return { ok: false, error: 'topic-key-too-long' };
    if (SENTENCE_PUNCT.test(key.trim())) return { ok: false, error: 'topic-key-looks-like-draft' };
    var draft = str(draftContent).trim();
    if (draft) {
      if (normalized === draft) return { ok: false, error: 'topic-key-looks-like-draft' };
      if (draft.length >= 8 && normalized.indexOf(draft) >= 0) return { ok: false, error: 'topic-key-looks-like-draft' };
    }
    return { ok: true, topicKey: normalized };
  }
  /* topicKey → 确定性 fingerprint（模型不拥有 identity：它只给话题提示）。 */
  function momentTopicFingerprint(topicKey) {
    var key = str(topicKey);
    if (!key) return '';
    var token = stableToken('moment-topic|' + key);
    return token ? (TOPIC_FINGERPRINT_PREFIX + token) : '';
  }

  /* ── draft 归一（沿用既有字段与既有约束，不创建第二套语义）────────── */
  function normalizeDraft(raw, opts) {
    opts = opts || {};
    var d = isPlainObject(raw) ? raw : null;
    if (!d) return { ok: false, error: 'missing-draft' };
    var content = str(d.content).trim();
    if (!content) return { ok: false, error: 'empty-draft-content' };
    if (content.length > MAX_CONTENT_LEN) return { ok: false, error: 'draft-content-too-long' };
    var core = visibilityCore();
    if (!core) return { ok: false, error: 'visibility-core-missing' };
    var visibility;
    try { visibility = str(core.writeVisibility(d.visibility)); } catch (e) { return { ok: false, error: 'visibility-core-threw' }; }
    /* 档位必须是既有闭集：缺失 → 'all'（与既有写入侧默认一致）；拼错（'invalid'）→
       **malformed**（绝不把"模型写错一个词"兜底成公开，也绝不落一条谁都看不见的
       脏行 —— 这是对旧 parser 的一次刻意收紧，见 P25-2B 报告 §已知限制）。 */
    if (visibility === 'invalid' || !visibility) return { ok: false, error: 'invalid-visibility' };
    if (VISIBILITY_VALUES.indexOf(visibility) < 0) return { ok: false, error: 'invalid-visibility' };
    var visibleRoleIds = Array.isArray(d.visibleRoleIds) ? d.visibleRoleIds.slice(0, MAX_VISIBLE_ROLES).map(String).filter(Boolean) : [];
    if (visibility === 'roles' && !visibleRoleIds.length) return { ok: false, error: 'roles-without-visible-role-ids' };
    if (visibility !== 'roles') visibleRoleIds = [];
    var motive = str(d.motive);
    if (motive && MOTIVE_VALUES.indexOf(motive) < 0) {
      /* v2：非法动机 ⇒ malformed；legacy v1：沿用旧归一（非法 → 空缺 → daily_life），
         因为 motive 在旧契约里只是标注，不是发布资格门。 */
      if (opts.strictMotive === true) return { ok: false, error: 'invalid-motive' };
      motive = '';
    }
    if (motive === 'none') motive = '';
    if (!motive) motive = 'daily_life';
    var wantImage = d.wantImage === true || d.includeImage === true;
    var imagePrompt = str(d.imagePrompt).trim().slice(0, MAX_IMAGE_PROMPT_LEN);
    return {
      ok: true,
      draft: {
        content: content, visibility: visibility, visibleRoleIds: visibleRoleIds,
        motive: motive, wantImage: wantImage, imagePrompt: imagePrompt
      }
    };
  }

  function recommendationOf(code, reasonCode, topicKey, topicFingerprint, source) {
    return {
      recommendation: code, reasonCode: reasonCode,
      topicKey: topicKey, topicFingerprint: topicFingerprint,
      source: source
    };
  }

  /* ── 唯一 parser ─────────────────────────────────────────────────────
     parseMomentSemanticOutput(raw) →
       { ok:true, contract, recommendation:{...}, draft:{...}|null, legacyReason, ignoredDraft }
       { ok:false, error, stage } */
  function parseMomentSemanticOutput(raw, opts) {
    var text = String(raw == null ? '' : raw);
    var trimmed = text.trim();
    if (!trimmed) return { ok: false, error: 'empty-output', stage: 'empty-output' };
    var extract = jsonParser(opts);
    if (!extract) return { ok: false, error: 'no-json-extractor', stage: 'no-extractor' };
    var j = null;
    /* 把 opts 透传给 JSON 提取器：companion 侧会用 prefillSeed 声明"本次请求真的用了
       assistant 续写"，那是既有容错契约（P19），不是本模块的语义决定。 */
    try { j = extract(trimmed, opts); } catch (e) { j = null; }
    if (!j || !isPlainObject(j)) {
      return { ok: false, error: 'unparseable-output', stage: trimmed.indexOf('{') < 0 ? 'no-json-object' : 'json-parse-failed' };
    }
    var forbidden = hasForbiddenField(j);
    if (forbidden) return { ok: false, error: 'forbidden-reasoning-field', stage: 'schema-forbidden-field', field: forbidden };
    var hasV2 = j.recommendation !== undefined;
    var hasV1 = j.publish !== undefined;
    if (hasV2 && hasV1) return { ok: false, error: 'conflicting-contract', stage: 'schema-conflicting-contract' };
    if (hasV2) return parseSemanticV2(j);
    if (hasV1) return parseLegacyV1(j);
    return { ok: false, error: 'missing-recommendation', stage: 'schema-missing-decision' };
  }

  function parseSemanticV2(j) {
    var recommendation = str(j.recommendation);
    if (RECOMMENDATIONS.indexOf(recommendation) < 0) {
      return { ok: false, error: 'unknown-recommendation', stage: 'schema-unknown-recommendation' };
    }
    var reasonCode = str(j.reasonCode);
    if (ALL_REASONS.indexOf(reasonCode) < 0) {
      return { ok: false, error: 'unknown-reason-code', stage: 'schema-unknown-reason-code' };
    }
    if (recommendation === 'post' && !isPostReason(reasonCode)) {
      return { ok: false, error: 'reason-code-direction-mismatch', stage: 'schema-reason-direction' };
    }
    if (recommendation === 'skip' && !isSkipReason(reasonCode)) {
      return { ok: false, error: 'reason-code-direction-mismatch', stage: 'schema-reason-direction' };
    }
    var rawTopic = j.topicKey !== undefined ? j.topicKey : (j.topic !== undefined ? j.topic : undefined);
    var draftRaw = j.draft;
    var draftContent = isPlainObject(draftRaw) ? str(draftRaw.content).trim() : '';
    var topic = normalizeTopicKey(rawTopic, draftContent);
    if (recommendation === 'post') {
      if (!topic.ok) return { ok: false, error: topic.error === 'missing-topic-key' ? 'missing-topic-key' : topic.error, stage: 'schema-bad-topic-key' };
      if (!isPlainObject(draftRaw)) return { ok: false, error: 'missing-draft', stage: 'schema-missing-draft' };
      var draft = normalizeDraft(draftRaw, { strictMotive: true });
      if (!draft.ok) return { ok: false, error: draft.error, stage: 'schema-bad-draft' };
      var fingerprint = momentTopicFingerprint(topic.topicKey);
      if (!fingerprint) return { ok: false, error: 'identity-core-missing', stage: 'schema-identity-missing' };
      return {
        ok: true, contract: CONTRACT_ID, errors: [], legacyReason: '', ignoredDraft: false,
        recommendation: recommendationOf('post', reasonCode, topic.topicKey, fingerprint, 'semantic'),
        draft: draft.draft
      };
    }
    /* skip：draft 允许缺省；即便存在也**一律忽略**（"草案看起来很好"不能成为发布理由）。 */
    var skipKey = topic.ok ? topic.topicKey : '';
    var skipFingerprint = skipKey ? momentTopicFingerprint(skipKey) : '';
    return {
      ok: true, contract: CONTRACT_ID, errors: [], legacyReason: '',
      ignoredDraft: isPlainObject(draftRaw), draft: null,
      recommendation: recommendationOf('skip', reasonCode, skipKey, skipFingerprint, 'semantic')
    };
  }

  function parseLegacyV1(j) {
    /* legacy 兼容 seam（LEGACY UNTIL P25-2C）：只把旧契约**投影**到新契约。
       `publish:true` 绝不等于允许发布 —— 它只是 recommendation:'post' 的来源之一，
       之后仍要走 Moments policy + Autonomy Core。 */
    if (j.publish !== true && j.publish !== false) {
      return { ok: false, error: 'legacy-publish-not-boolean', stage: 'schema-publish-not-boolean' };
    }
    if (j.publish === false) {
      return {
        ok: true, contract: LEGACY_CONTRACT_ID, errors: [], ignoredDraft: str(j.content).trim() !== '',
        legacyReason: String(j.reason || '').slice(0, 200), draft: null,
        recommendation: recommendationOf('skip', LEGACY_DEFAULT_SKIP_REASON, '', '', 'legacy')
      };
    }
    var content = str(j.content).trim();
    if (!content) return { ok: false, error: 'legacy-empty-content', stage: 'schema-empty-content' };
    var draft = normalizeDraft(j, { strictMotive: false });
    if (!draft.ok) return { ok: false, error: draft.error, stage: 'schema-bad-draft' };
    var reasonCode = LEGACY_MOTIVE_REASON[str(draft.draft.motive)] || LEGACY_DEFAULT_POST_REASON;
    /* legacy 契约没有话题身份：由**程序**从结构化字段派生一个确定性话题键，
       并且把这一条草案本身拌进 fingerprint 的**哈希种子**（指纹是哈希，不是正文；
       也绝不与语义话题混用）。理由：legacy 没有话题，只能用"这一条草案"当身份 ——
       同一条草案重试 ⇒ 同一 candidate（幂等，不双发）；不同的草案 ⇒ 不同 candidate
       （不会被误当成重试而**吞掉**一条本该发布的动态）。 */
    var topicKey = 'legacy-' + reasonCode;
    var fingerprint = momentTopicFingerprint(topicKey + '|' + content);
    if (!fingerprint) return { ok: false, error: 'identity-core-missing', stage: 'schema-identity-missing' };
    return {
      ok: true, contract: LEGACY_CONTRACT_ID, errors: [], legacyReason: '', ignoredDraft: false,
      recommendation: recommendationOf('post', reasonCode, topicKey, fingerprint, 'legacy'),
      draft: draft.draft
    };
  }

  /* legacy 形状投影：现有调用方 / 现有测试看到的旧字段视图（唯一实现）。 */
  function legacyMomentOutput(parsed) {
    var p = isPlainObject(parsed) ? parsed : null;
    if (!p || p.ok !== true) return null;
    if (p.recommendation.recommendation === 'skip') {
      return { publish: false, reason: String(p.legacyReason || reasonLabel(p.recommendation.reasonCode)).slice(0, 200), motive: 'none' };
    }
    var d = p.draft;
    if (!d) return null;
    return {
      publish: true, content: d.content, visibility: d.visibility, visibleRoleIds: d.visibleRoleIds.slice(),
      wantImage: d.wantImage, imagePrompt: d.imagePrompt,
      reason: String(p.legacyReason || ''), motive: d.motive
    };
  }
  function parseMomentOutputLegacy(raw, opts) { return legacyMomentOutput(parseMomentSemanticOutput(raw, opts)); }

  /* ── adapter 投影：语义结果 → P25-2A adapter 能直接消费的 recommendation ──
     只带业务字段：provider / endpoint / apiKey / raw response **永不**出现在这里。 */
  function toAdapterRecommendation(parsed) {
    var p = isPlainObject(parsed) ? parsed : null;
    if (!p || p.ok !== true) return null;
    var rec = p.recommendation || {};
    return {
      recommendation: str(rec.recommendation),
      reasonCode: str(rec.reasonCode),
      topicFingerprint: str(rec.topicFingerprint),
      draft: p.draft ? str(p.draft.content) : ''
    };
  }

  /* ── 诊断（prompt 与 parser 共用同一份 schema，避免两处漂移）────────── */
  function semanticOutputSchema() { return OUTPUT_JSON_SCHEMA; }
  function semanticSkipExample() { return SKIP_PREFIX; }
  function forbiddenFieldsSentence() { return FORBIDDEN_FIELDS_SENTENCE; }
  /* correction 提示：**只**要求新的结构化契约（绝不 fallback 回 publish/content）。 */
  function semanticCorrectionNote(diagnosis) {
    var why = isPlainObject(diagnosis) && diagnosis.stage ? '（上次输出的问题：' + str(diagnosis.stage) + '）' : '';
    return '\n\n【注意】上次输出不符合要求' + why + '。请重新输出**一个新的 JSON 对象**，字段严格如下：'
      + OUTPUT_JSON_SCHEMA + '。'
      + (str(diagnosis && diagnosis.stage) === 'schema-forbidden-field'
        ? '不要输出思考过程或分析，只保留上面列出的字段。'
        : '')
      + '不发布时用 ' + SKIP_PREFIX + '（draft 可以省略）。';
  }

  return {
    CONTRACT_ID: CONTRACT_ID,
    LEGACY_CONTRACT_ID: LEGACY_CONTRACT_ID,
    MOMENT_SEMANTIC_RECOMMENDATIONS: RECOMMENDATIONS,
    MOMENT_SEMANTIC_POST_REASONS: POST_REASONS,
    MOMENT_SEMANTIC_SKIP_REASONS: SKIP_REASONS,
    MOMENT_SEMANTIC_ALL_REASONS: ALL_REASONS,
    MOMENT_SEMANTIC_REASON_LABELS: REASON_LABELS,
    MOMENT_SEMANTIC_FORBIDDEN_FIELDS: FORBIDDEN_OUTPUT_FIELDS,
    MOMENT_SEMANTIC_VISIBILITY: VISIBILITY_VALUES,
    MOMENT_SEMANTIC_MOTIVES: MOTIVE_VALUES,
    MOMENT_SEMANTIC_LIMITS: Object.freeze({
      maxContentLen: MAX_CONTENT_LEN, maxImagePromptLen: MAX_IMAGE_PROMPT_LEN,
      maxTopicKeyLen: MAX_TOPIC_KEY_LEN, maxVisibleRoles: MAX_VISIBLE_ROLES
    }),
    normalizeTopicKey: normalizeTopicKey,
    momentTopicFingerprint: momentTopicFingerprint,
    normalizeDraft: normalizeDraft,
    parseMomentSemanticOutput: parseMomentSemanticOutput,
    legacyMomentOutput: legacyMomentOutput,
    parseMomentOutputLegacy: parseMomentOutputLegacy,
    toAdapterRecommendation: toAdapterRecommendation,
    semanticOutputSchema: semanticOutputSchema,
    semanticSkipExample: semanticSkipExample,
    forbiddenFieldsSentence: forbiddenFieldsSentence,
    semanticCorrectionNote: semanticCorrectionNote,
    reasonLabel: reasonLabel,
    isPostReason: isPostReason,
    isSkipReason: isSkipReason
  };
});
