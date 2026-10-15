/* ====================================================================
   IB Role DM Runtime — 角色私信（Inter-Character Direct Messaging）执行域
   --------------------------------------------------------------------
   ── 这一层是什么 ─────────────────────────────────────────────────────
   它是**角色 A 与角色 B 之间一对一会话**的运行时。它不是一个新 runtime：
   两边的每一次发言都走既有 canonical AI execution seam
   （`callApiChat` / `callApiChatStream`，见 communication.js:4484/4562），
   各自绑定**各自角色**的 provider/model/endpoint 配置，各自拿一个
   **宿主回合**（`_ibTurnScope` → 工具执行周期 → 上下文预算），各自经
   各自角色的 Middle Brain（Character Integrity Guard + trace）。

   A 的发言必须是 A 的模型调用；B 的回复必须是 B 的模型调用。
   本文件里**没有任何地方**让一个模型扮演两个人，也没有"生成 10 轮剧本"
   这种一次性多轮生成 —— 那是剧本，不是私信。

   ── 挂在哪一层（为什么不另造一套 runtime）────────────────────────────
     · 会话身份      → assets/js/chat-core.js 的既有 conversation 键
                       （friendId = roledm_<token> ⇒ conversationId = dm:roledm_<token>）
     · 消息持久化    → 既有 chatMessages 存储（扩展既有 message representation）
     · 模型执行      → 既有 callApiChat*（唯一 seam）
     · 回合/周期/预算 → 既有 _ibTurnScope / _ibTurnLc / IBFC 周期 / planParts 预算
     · 人格闸门      → 既有 IB.middleBrain.middleBrainFinalizeReply
     · 对象/内容生成 → 既有 buildSiteContext / amBuildInject / getMemoryContext
     · 记忆边界      → 既有 memories（episodic）→ 既有 Memory Consolidation
     · 循环/quota    → 既有 reply-chain-core 的 LIMITS 语义 + 本域三个预算
   本文件只补"角色之间"这一维：canonical thread 身份、双角色 context 组装、
   run 守卫、directional 关系观测。其余一律复用。

   ── 硬边界（本域刻意**不**做的事）────────────────────────────────────
     · 不写 Moments（DM ≠ 朋友圈）
     · 不写用户单聊的任何 thread
     · 不执行任何副作用标签（ws_* / mem_* / cal_note / blog_read 一律不解析）
     · 不把 DM 原文写进长期记忆（只写有界 episodic 候选，交既有 consolidation）
     · 不在 UI 层调度（UI 只调用本模块暴露的 canonical 入口）
     · 不用一个模型生成整段对话
   ==================================================================== */
(function (NS) {
  'use strict';

  var CORE = (typeof window !== 'undefined' && window.IBRoleDmCore) || null;
  var PROFILE_CORE = (typeof window !== 'undefined' && window.IBPublicProfileCore) || null;
  /* 本 run 里"真正交给模型"的历史条数上限。角色私信是**会话**而不是检索：
     模型必须看见刚说过的话，因此这里不接 planParts 的可压缩阶梯（那会允许
     裁剪当前对话本身）。作为代价，可压缩块全部使用**固定小上限**：
       · 共享历史       ≤ 12 条
       · memory         ≤ 900 字符（单聊默认是 memSettings.budget）
       · understanding  ≤ 300 字符（与 _IB_BUDGET_CAP_TOKENS.understanding 同值）
       · 站点上下文     由 buildSiteContext 自身的既有上限决定
       · Auto Memory    由本角色 cfg.autoMemBudget 决定
     因此一次角色私信回合的输入远低于 APP_CEILING_TOKENS(64000)，不可能超预算。 */
  var HISTORY_LIMIT = 12;
  var MEMORY_CHAR_CAP = 900;
  var UNDERSTANDING_CHAR_CAP = 300;

  /* ── 每一轮的输出上限（不是"省钱旋钮"）─────────────────────────────
     max_tokens 是**上限**而不是计费：给得宽不会让一次发言更贵，只会让本来
     说得完的话不被砍断。旧值 700 的真实后果在 2026-09-15 的真实模型探针里
     被测出来了：思考型号（deepseek-v4-flash-vision-exp）在角色私信那种
     「人格 + 站点上下文 + memory + understanding + 历史」的大 prompt 下，
     700 个输出 token **全部**花在 reasoning 上（provider 原始回包：
     finish_reason=length、content 长度 0、reasoning 1098 字符、completion 701），
     正文一个字都没开始 —— 而旧代码把"正文为空"归成 provider-failed，
     用户看到"模型请求失败"，于是去查一个根本没坏的 key。
     成本护栏不在这里，在**轮数 / 日额 / 冷却**（roleTurnTimes / dailyLimit /
     pairCooldown），那三条一条都没动。 */
  var TURN_MAX_TOKENS = 2048;
  /* 被截断且正文为空时的一次有界重试上限（**只重试一次**）：
     它挡的是"预算还是不够"，而不是把失败重试到成功。 */
  var TURN_MAX_TOKENS_RETRY = 4096;

  /* ── 持久化命名空间 ────────────────────────────────────────────────
     消息历史在 canonical chatMessages（Home Node 权威 / IndexedDB 镜像）。
     下面几个 key 只存**索引与有界状态**，不存正文：
       · threads  —— canonical thread 元数据（participants/createdAt/state、thread memorandum，及可选 Scene 标题/标签/播放设置）
       · relations —— directional 关系状态（A→B 与 B→A 各自一条）
       · ledger   —— 每角色的轮次时间戳（时/日两级 quota）
       · runs     —— 每 thread 的最近一次 run 结果（停止原因，供 UI 如实展示）
     为什么不用新的 IndexedDB object store：本仓库的既有决策是"数据模型向后
     兼容优先，不轻易升 DB_VER"，而新增 store 会强制升版并牵动多处硬编码
     断言（tests/test_chat_core_contract.js 等）。Thread 身份与消息计数可从
     chatMessages 重建；Scene 标签和播放偏好是 thread 自身的轻量元数据，随
     thread 索引一起保存，不复制消息，也不进入 chatMessages。正文与 provenance
     仍只写在 canonical 存储（chatMessages / memories）。 */
  var KEY_THREADS = 'ib_role_dm_threads_v1';
  var KEY_RELATIONS = 'ib_role_dm_relations_v1';
  var KEY_LEDGER = 'ib_role_dm_ledger_v1';
  var KEY_PREFS = 'ib_role_dm_prefs_v1';
  var KEY_REPLY_INITIATIVE = 'ib_role_dm_reply_initiative_v1';
  var INDEX_VERSION = 1;
  var SCENE_TITLE_MAX = 80;
  var SCENE_TAG_MAX = 8;
  var SCENE_TAG_LENGTH_MAX = 24;
  var SCENE_EXPORT_FORMAT = 'internalbeyond.role-dm-scene';
  var SCENE_EXPORT_VERSION = 1;

  /* ── 运行期锁（本标签页内；跨标签页由 pair cooldown + ledger 兜底）── */
  var _runningThreads = {};   /* friendId -> runId */
  var _running = false;

  /* ══════════ 小工具 ═══════════════ */
  function core() {
    if (CORE) return CORE;
    try { CORE = window.IBRoleDmCore; } catch (e) { CORE = null; }
    return CORE;
  }
  /* 「角色公开认知层」唯一实现（assets/js/public-profile-core.js）。
     与 core() 同款延迟解析 —— 本文件不得在加载期就对另一个脚本求值。 */
  function profileCore() {
    if (PROFILE_CORE) return PROFILE_CORE;
    try { PROFILE_CORE = window.IBPublicProfileCore; } catch (e) { PROFILE_CORE = null; }
    return PROFILE_CORE;
  }
  function _roleTurnTraceCore() {
    try { return window.IBModelCore || null; } catch (e) { return null; }
  }
  function _roleTurnTraceBegin(meta) {
    try { var c = _roleTurnTraceCore(); return c && typeof c.turnTraceBegin === 'function' ? c.turnTraceBegin(meta || {}) : ''; } catch (e) { return ''; }
  }
  function _roleTurnTraceEvent(traceId, type, fields) {
    try { var c = _roleTurnTraceCore(); return c && typeof c.turnTraceEvent === 'function' ? c.turnTraceEvent(traceId, type, fields || {}) : null; } catch (e) { return null; }
  }
  function _roleTurnTraceFinish(traceId, status, fields, turn) {
    try {
      var c = _roleTurnTraceCore();
      var guard = turn && turn.guard;
      if (guard && typeof guard.snapshot === 'function') {
        var snap = guard.snapshot(), events = [];
        try { events = (typeof guard.trace === 'function' ? guard.trace() : []).map(function (event) { return String(event && event.t || '') + (event && event.reason ? ':' + String(event.reason) : ''); }).filter(Boolean).slice(-16); } catch (e) {}
        _roleTurnTraceEvent(traceId, 'tool_execution', { toolName: 'turn_summary', toolStatus: Number(snap.toolCalls) > 0 ? 'accounted' : 'none',
          toolCount: Number(snap.toolCalls) || 0, toolCalls: Number(snap.toolCalls) || 0, toolRounds: Number(snap.rounds) || 0 });
        _roleTurnTraceEvent(traceId, 'tool_guard', { toolCalls: Number(snap.toolCalls) || 0, toolRounds: Number(snap.rounds) || 0,
          guardTripped: !!snap.tripped, guardReason: String(snap.breakerReason || ''), guardEvents: events });
      }
      return c && typeof c.turnTraceFinish === 'function' ? c.turnTraceFinish(traceId, status || 'completed', fields || {}) : null;
    } catch (e) { return null; }
  }
  function _roleErrorCategory(error) {
    try { if (window.IBERR && typeof window.IBERR.classify === 'function') return window.IBERR.classify(error); } catch (e) {}
    return String(error && (error.ibCat || error.code) || 'unknown').slice(0, 64);
  }
  function apiConfigsLive() {
    try { return window.apiConfigs || []; } catch (e) { return []; }
  }
  function archivedConfigsLive() {
    try { return window.archivedConfigs || []; } catch (e) { return []; }
  }
  function cfgOf(id) {
    var s = String(id);
    var a = apiConfigsLive(), b = archivedConfigsLive();
    for (var i = 0; i < a.length; i++) if (String(a[i] && a[i].id) === s) return a[i];
    for (var j = 0; j < b.length; j++) if (String(b[j] && b[j].id) === s) return b[j];
    return null;
  }
  function nameOf(cfg) {
    if (!cfg) return '（角色已删除）';
    return cfg.nickname || cfg.model || 'AI';
  }
  function apiReady(cfg) {
    try { if (typeof window._ibApiReady === 'function') return !!window._ibApiReady(cfg); } catch (e) { }
    return false;
  }
  function apiHasCredential(cfg) {
    try { if (typeof window._ibApiHasCredential === 'function') return !!window._ibApiHasCredential(cfg); } catch (e) { }
    return true;
  }
  function nowMs() { return Date.now(); }
  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function uid(prefix) { return prefix + nowMs().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  /* 用户可控 metadata 进入 prompt 的**唯一**消毒实现（与群聊同一个核心）。
     签名必须与 canonical 核心一致。canonical 的
     `sanitizePromptInput(value, options)` 返回的是**对象**
     `{value, changed, findings, reason, ...}`（见 prompt-boundary-core.js §6），
     而 communication.js:1416-1418 的既有读法正是 `r.value`。
     本函数曾经写成 `typeof out === 'string'` —— 在 canonical 对象上永远为
     false，于是生产里 canonical 消毒**一次都没有生效过**，实际一直跑的是
     下面那个更弱的本地兜底（它不处理零宽/双向控制字符，也不报告 findings）。
     单测没抓到，是因为 mock 注入的假实现恰好返回字符串（正是本函数注释里
     警告过的"因为注入了假实现而全绿"）。两种形状都必须接受。 */
  function sanitizeInput(v, options) {
    try {
      var core = window.IBPromptBoundaryCore;
      if (core && typeof core.sanitizePromptInput === 'function') {
        var out = core.sanitizePromptInput(v, (options && typeof options === 'object') ? options : {});
        if (typeof out === 'string') return out;
        if (out && typeof out.value === 'string') return out.value;
      }
    } catch (e) { }
    return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  function sanitizeName(v) {
    return sanitizeInput(v).slice(0, 60);
  }
  function defaultSceneMetadata(thread) {
    return {
      title: '',
      tags: [],
      createdAt: Number((thread || {}).createdAt) || 0,
      playback: { voiceMode: 'auto', textPacing: 'natural' }
    };
  }
  function normalizeSceneMetadata(value, thread) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var src = value, base = defaultSceneMetadata(thread), tags = [], seen = {};
    var title = String(typeof src.title === 'string' ? src.title : '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SCENE_TITLE_MAX);
    var rawTags = Array.isArray(src.tags) ? src.tags : [];
    for (var i = 0; i < rawTags.length && tags.length < SCENE_TAG_MAX; i++) {
      if (typeof rawTags[i] !== 'string') continue;
      var tag = rawTags[i].replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SCENE_TAG_LENGTH_MAX);
      var key = tag.toLocaleLowerCase();
      if (!tag || seen[key]) continue;
      seen[key] = true;
      tags.push(tag);
    }
    var playback = src.playback && typeof src.playback === 'object' && !Array.isArray(src.playback) ? src.playback : {};
    var parsedCreatedAt = Number(src.createdAt);
    var createdAt = isFinite(parsedCreatedAt) && parsedCreatedAt > 0 ? parsedCreatedAt : (base.createdAt || nowMs());
    return {
      title: title,
      tags: tags,
      createdAt: createdAt,
      playback: {
        voiceMode: playback.voiceMode === 'text' ? 'text' : 'auto',
        textPacing: playback.textPacing === 'fast' ? 'fast' : 'natural'
      }
    };
  }
  function sceneMetadataView(thread) {
    var rec = thread || {}, stored = normalizeSceneMetadata(rec.scene, rec) || defaultSceneMetadata(rec);
    var participantIds = Array.isArray(rec.participantIds) ? rec.participantIds.slice(0, 2) : [];
    var participants = participantIds.map(function (id) {
      var cfg = cfgOf(id);
      return { id: String(id || ''), name: nameOf(cfg), missing: !cfg };
    });
    var fallbackTitle = participants.map(function (participant) { return participant.name; }).join(' × ') || 'Role DM Scene';
    return {
      title: stored.title || fallbackTitle,
      participants: participants,
      createdAt: Number(stored.createdAt) || Number(rec.createdAt) || 0,
      tags: stored.tags.slice(),
      playback: { voiceMode: stored.playback.voiceMode, textPacing: stored.playback.textPacing }
    };
  }

  /* ── 层④（跨 run 的共同历史）进入 prompt 的**唯一** canonical 边界 ──────
     备忘的正文来自模型自己说过的话，也就是"用户可间接影响的文本"。
     换行在本函数里由**结构**提供（我拼的 '\n'），内容永远不能自己带一个
     换行进来 —— 一份能插入独立行的备忘，就能在
     「不属于任何人的发言」的那条参考帧里伪造出一条新指令。
     逐行过 sanitizeInput（唯一实现），不做第二套正则。 */
  function memorandumForPrompt(raw) {
    var c = core();
    if (!c || typeof c.normalizeMemorandum !== 'function') return null;
    var memo = c.normalizeMemorandum(raw);
    if (!memo) return null;
    var src = memo.text.split('\n');
    var out = [];
    for (var i = 0; i < src.length; i++) {
      /* maxLength 200 > MEMORANDUM_LINE_MAX(160)：消毒不该在这里悄悄截断，
         截断是 core 的职责（它有唯一的行上限）。 */
      var line = sanitizeInput(src[i], { maxLength: 200 });
      if (line) out.push(line);
    }
    if (!out.length) return null;
    return {
      schemaVersion: memo.schemaVersion,
      text: out.join('\n'),
      coveredUntilMessageId: memo.coveredUntilMessageId,
      coveredUntilAt: memo.coveredUntilAt,
      updatedAt: memo.updatedAt,
      sourceMessageCount: memo.sourceMessageCount
    };
  }

  /* ══════════ 索引：threads ═══════════════ */
  function threadsAll() {
    var v = readJSON(KEY_THREADS, null);
    var out = [];
    if (!v || Number(v.v) !== INDEX_VERSION || !v.items || typeof v.items !== 'object') return out;
    for (var k in v.items) {
      if (!Object.prototype.hasOwnProperty.call(v.items, k)) continue;
      var rec = core() ? core().normalizeThreadRecord(v.items[k]) : null;
      if (rec) {
        var scene = normalizeSceneMetadata(rec.scene, rec);
        if (scene) rec.scene = scene;
        else delete rec.scene;
        out.push(rec);
      }
    }
    out.sort(function (a, b) { return (Number(b.lastMessageAt) || Number(b.createdAt) || 0) - (Number(a.lastMessageAt) || Number(a.createdAt) || 0); });
    return out;
  }
  function threadsSave(list) {
    var items = {};
    for (var i = 0; i < list.length; i++) items[list[i].threadId] = list[i];
    return writeJSON(KEY_THREADS, { v: INDEX_VERSION, items: items, updatedAt: nowMs() });
  }
  function threadSave(rec) {
    if (!rec || !core()) return false;
    var norm = core().normalizeThreadRecord(rec);
    if (!norm) return false;
    var scene = normalizeSceneMetadata(norm.scene, norm);
    if (scene) norm.scene = scene;
    else delete norm.scene;
    var v = readJSON(KEY_THREADS, null);
    var items = (v && Number(v.v) === INDEX_VERSION && v.items && typeof v.items === 'object') ? v.items : {};
    items[norm.threadId] = norm;
    return writeJSON(KEY_THREADS, { v: INDEX_VERSION, items: items, updatedAt: nowMs() });
  }
  function threadGet(friendId) {
    var list = threadsAll();
    for (var i = 0; i < list.length; i++) if (list[i].threadId === String(friendId)) return list[i];
    return null;
  }

  /* ══════════ 索引：relations（directional）═══════════════ */
  function relationsAll() {
    var v = readJSON(KEY_RELATIONS, null);
    var out = {};
    if (!v || Number(v.v) !== INDEX_VERSION || !v.items || typeof v.items !== 'object') return out;
    for (var k in v.items) {
      if (!Object.prototype.hasOwnProperty.call(v.items, k)) continue;
      var rec = core() ? core().normalizeRelationRecord(v.items[k]) : null;
      if (rec) out[rec.relationKey] = rec;
    }
    return out;
  }
  function relationGetRaw(fromId, toId) {
    var key = core() ? core().relationKey(fromId, toId) : '';
    if (!key) return null;
    var all = relationsAll();
    return all[key] || null;
  }
  /* 读（缺省即"尚无任何来往"的初值；**绝不**用 pair hash 假装已有关系）。 */
  function relationGet(fromId, toId) {
    var rec = relationGetRaw(fromId, toId);
    if (rec) return rec;
    return core() ? core().buildRelationRecord(fromId, toId, { now: nowMs() }) : null;
  }
  function relationSave(rec) {
    if (!rec || !core()) return false;
    var norm = core().normalizeRelationRecord(rec);
    if (!norm) return false;
    var v = readJSON(KEY_RELATIONS, null);
    var items = (v && Number(v.v) === INDEX_VERSION && v.items && typeof v.items === 'object') ? v.items : {};
    items[norm.relationKey] = norm;
    return writeJSON(KEY_RELATIONS, { v: INDEX_VERSION, items: items, updatedAt: nowMs() });
  }

  /* ══════════ 索引：轮次账本（quota）═══════════════ */
  function ledgerAll() { return readJSON(KEY_LEDGER, {}); }
  function roleTurnTimes(roleId) {
    var led = ledgerAll();
    var arr = led[String(roleId)];
    return Array.isArray(arr) ? arr.filter(function (t) { return Number(t) > 0; }) : [];
  }
  function roleTurnRecord(roleId, at) {
    var led = ledgerAll();
    var key = String(roleId);
    var arr = Array.isArray(led[key]) ? led[key].filter(function (t) { return Number(t) > 0 && (Number(at) - Number(t)) <= 86400000; }) : [];
    arr.push(Number(at) || nowMs());
    led[key] = arr.slice(-200);
    writeJSON(KEY_LEDGER, led);
  }
  function roleTurnDrop(roleId, at) {
    var led = ledgerAll();
    var key = String(roleId);
    var arr = Array.isArray(led[key]) ? led[key].slice() : [];
    var i = arr.lastIndexOf(Number(at));
    if (i >= 0) arr.splice(i, 1);
    led[key] = arr;
    writeJSON(KEY_LEDGER, led);
  }

  /* ══════════ 偏好 ═══════════════ */
  /* 默认**开启**：这是本轮新增的正式能力，用户入口就是"让她们聊一会儿"。
     自动调度（autonomous）默认**关闭** —— 本轮不开启全自动 scheduler。 */
  function prefs() {
    var d = { enabled: true, autonomous: false };
    var raw = readJSON(KEY_PREFS, null);
    if (raw && typeof raw === 'object') {
      if (raw.enabled !== undefined) d.enabled = raw.enabled !== false;
      if (raw.autonomous !== undefined) d.autonomous = raw.autonomous === true;
    }
    return d;
  }
  function setPrefs(patch) {
    var cur = prefs();
    var next = Object.assign({}, cur, patch || {});
    writeJSON(KEY_PREFS, next);
    return next;
  }

  /* Optional reply behavior is isolated from the autonomous social scheduler.
     It is per-character UI preference only; it never creates work or messages. */
  function normalizeReplyInitiativePrefs(value) {
    var raw = value && typeof value === 'object' ? value : {};
    var types = raw.types && typeof raw.types === 'object' ? raw.types : {};
    return {
      enabled: raw.enabled === true,
      frequency: raw.frequency === 'occasional' ? 'occasional' : 'low',
      types: {
        supplement: types.supplement === undefined ? true : types.supplement === true,
        contextLink: types.contextLink === undefined ? true : types.contextLink === true,
        careNudge: types.careNudge === undefined ? true : types.careNudge === true
      }
    };
  }
  function replyInitiativeAll() {
    var raw = readJSON(KEY_REPLY_INITIATIVE, null);
    var source = raw && raw.characters && typeof raw.characters === 'object' ? raw.characters : {};
    var out = {};
    Object.keys(source).forEach(function (id) {
      if (id) out[String(id)] = normalizeReplyInitiativePrefs(source[id]);
    });
    return out;
  }
  function replyInitiativePrefs(roleId) {
    var id = String(roleId || '').trim();
    var all = replyInitiativeAll();
    return id && all[id] ? all[id] : normalizeReplyInitiativePrefs(null);
  }
  function setReplyInitiativePrefs(roleId, patch) {
    var id = String(roleId || '').trim();
    if (!id) return normalizeReplyInitiativePrefs(null);
    var all = replyInitiativeAll();
    var current = all[id] || normalizeReplyInitiativePrefs(null);
    var update = patch && typeof patch === 'object' ? patch : {};
    var next = normalizeReplyInitiativePrefs({
      enabled: update.enabled === undefined ? current.enabled : update.enabled,
      frequency: update.frequency === undefined ? current.frequency : update.frequency,
      types: Object.assign({}, current.types, update.types && typeof update.types === 'object' ? update.types : {})
    });
    all[id] = next;
    writeJSON(KEY_REPLY_INITIATIVE, { v: 1, characters: all });
    return next;
  }
  function replyInitiativeOpportunity(roleId, runId, frequency) {
    var source = String(roleId || '') + '\u001f' + String(runId || '');
    var hash = 0;
    for (var i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
    var divisor = frequency === 'occasional' ? 2 : 4;
    return source.length > 1 && hash % divisor === 0;
  }
  function replyInitiativeForTurn(roleId, trigger, runId, rawPrefs, grantedByRole) {
    var id = String(roleId || '').trim();
    var config = normalizeReplyInitiativePrefs(rawPrefs);
    var granted = grantedByRole && typeof grantedByRole === 'object' ? grantedByRole : null;
    if (!id || trigger !== 'manual' || !config.enabled || !config.types.supplement && !config.types.contextLink && !config.types.careNudge) return null;
    if (granted && granted[id] === true) return null;
    if (!replyInitiativeOpportunity(id, runId, config.frequency)) return null;
    if (granted) granted[id] = true;
    return config;
  }

  /* ══════════ thread 解析与创建 ═══════════════ */
  /* 同一对角色**只**对应一个 canonical DM identity —— 与 A/B 顺序无关。 */
  async function resolveThread(a, b, opts) {
    opts = opts || {};
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    var sa = String(a == null ? '' : a).trim();
    var sb = String(b == null ? '' : b).trim();
    if (!sa || !sb) return { ok: false, reason: c.REASON.missingCharacter };
    /* 自己不能和自己私信：这条判定必须在**任何**存储动作之前。 */
    if (sa === sb) return { ok: false, reason: c.REASON.sameCharacter };
    var parts = c.canonicalizeParticipants(sa, sb);
    if (parts.length !== 2) return { ok: false, reason: c.REASON.sameCharacter };
    var friendId = c.roleDmFriendId(parts[0], parts[1]);
    var existing = threadGet(friendId);
    if (existing) {
      /* 已有 thread → 直接复用（不重复创建）。参与者若有变化（不可能，但如实处理）→ 以 canonical 为准。 */
      if (existing.participantIds.join('\u0001') !== parts.join('\u0001')) {
        existing.participantIds = parts;
        threadSave(existing);
      }
      return { ok: true, created: false, thread: existing };
    }
    var rec = c.buildThreadRecord(parts[0], parts[1], { now: nowMs(), topic: opts.topic });
    if (!rec) return { ok: false, reason: c.REASON.missingCharacter };
    /* 先把已有历史接上：thread 可能经由导入/其它设备产生过消息（索引是派生的）。
       limit 必须是 **0（不限）** 而不是 1：loadMessages 的 limit 是"只取最后 N 条"，
       传 1 会让 messageCount 恒被写成 1（真实条数 5 也写成 1，已实测）。
       thread 记录的 messageCount 是**计数**，因此这里必须读全量；
       顺带 lastMessageAt / lastTurnRoleId 仍取自最后一条，语义不变。
       （rebuildThreadIndex 一直是对的 —— 这条自愈路径漏了同一件事。） */
    var hist = await loadMessages(friendId, 0);
    if (hist.length) {
      rec.messageCount = hist.length;
      rec.lastMessageAt = Number(hist[hist.length - 1].timestamp) || 0;
      rec.lastTurnRoleId = String((hist[hist.length - 1].metadata || {}).senderId || '');
    }
    threadSave(rec);
    return { ok: true, created: true, thread: rec };
  }

  function updateSceneMetadata(threadId, patch) {
    var fid = String(threadId || '');
    var rec = threadGet(fid);
    if (!rec) return { ok: false, reason: 'thread-not-found' };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, reason: 'bad-scene-patch' };
    var current = normalizeSceneMetadata(rec.scene, rec) || defaultSceneMetadata(rec);
    var playbackPatch = patch.playback && typeof patch.playback === 'object' && !Array.isArray(patch.playback) ? patch.playback : {};
    rec.scene = normalizeSceneMetadata({
      title: Object.prototype.hasOwnProperty.call(patch, 'title') ? patch.title : current.title,
      tags: Object.prototype.hasOwnProperty.call(patch, 'tags') ? patch.tags : current.tags,
      createdAt: Object.prototype.hasOwnProperty.call(patch, 'createdAt') && isFinite(Number(patch.createdAt)) && Number(patch.createdAt) > 0
        ? Number(patch.createdAt) : (current.createdAt || Number(rec.createdAt) || nowMs()),
      playback: {
        voiceMode: Object.prototype.hasOwnProperty.call(playbackPatch, 'voiceMode') ? playbackPatch.voiceMode : current.playback.voiceMode,
        textPacing: Object.prototype.hasOwnProperty.call(playbackPatch, 'textPacing') ? playbackPatch.textPacing : current.playback.textPacing
      }
    }, rec);
    rec.updatedAt = nowMs();
    if (!threadSave(rec)) return { ok: false, reason: 'scene-save-failed' };
    return { ok: true, scene: sceneMetadataView(rec) };
  }

  function exportSceneData(threadId) {
    var rec = threadGet(String(threadId || ''));
    if (!rec) return { ok: false, reason: 'thread-not-found' };
    var scene = sceneMetadataView(rec);
    return {
      ok: true,
      data: {
        format: SCENE_EXPORT_FORMAT,
        version: SCENE_EXPORT_VERSION,
        exportedAt: nowMs(),
        participants: rec.participantIds.map(function (roleId) { return { roleId: String(roleId) }; }),
        scene: {
          title: scene.title,
          tags: scene.tags.slice(),
          createdAt: scene.createdAt,
          playback: { voiceMode: scene.playback.voiceMode, textPacing: scene.playback.textPacing }
        }
      }
    };
  }

  async function importSceneData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'bad-scene-file' };
    if (payload.format !== SCENE_EXPORT_FORMAT) return { ok: false, reason: 'bad-scene-format' };
    if (payload.version !== SCENE_EXPORT_VERSION) return { ok: false, reason: 'unsupported-scene-version' };
    var sourceScene = payload.scene;
    if (!sourceScene || typeof sourceScene !== 'object' || Array.isArray(sourceScene)) return { ok: false, reason: 'bad-scene-metadata' };
    var hasMessageData = Object.prototype.hasOwnProperty.call(payload, 'messages')
      || Object.prototype.hasOwnProperty.call(payload, 'chatMessages')
      || Object.prototype.hasOwnProperty.call(sourceScene, 'messages');
    if (hasMessageData) return { ok: false, reason: 'message-data-not-allowed' };
    if (!Array.isArray(payload.participants) || payload.participants.length !== 2) return { ok: false, reason: 'bad-participant-refs' };
    var roleIds = [];
    for (var i = 0; i < payload.participants.length; i++) {
      var ref = payload.participants[i];
      var roleId = ref && typeof ref === 'object' && typeof ref.roleId === 'string' ? ref.roleId.trim() : '';
      if (!roleId || roleId.length > 120 || !/^[A-Za-z0-9_.:-]+$/.test(roleId) || roleIds.indexOf(roleId) >= 0) {
        return { ok: false, reason: 'bad-participant-refs' };
      }
      roleIds.push(roleId);
    }
    var c = core();
    var friendId = c ? c.roleDmFriendId(roleIds[0], roleIds[1]) : '';
    if (!friendId) return { ok: false, reason: 'bad-participant-refs' };
    /* Refuse collisions before resolveThread: import never adopts or overwrites an
       existing thread. Also check canonical messages in case its index is missing. */
    if (threadGet(friendId)) return { ok: false, reason: 'thread-exists', threadId: friendId };
    var priorRows = [];
    try { priorRows = await dbGetByIndex('chatMessages', 'byFriend', friendId); }
    catch (e) { return { ok: false, reason: 'message-store-unavailable' }; }
    var priorMessages = (priorRows || []).filter(function (message) { return c.messageBelongsToThread(message, friendId); });
    if (priorMessages.length) return { ok: false, reason: 'thread-exists', threadId: friendId };

    var resolved = await resolveThread(roleIds[0], roleIds[1]);
    if (!resolved || !resolved.ok) return { ok: false, reason: (resolved && resolved.reason) || 'thread-create-failed' };
    if (!resolved.created || Number((resolved.thread || {}).messageCount) > 0) {
      return { ok: false, reason: 'thread-exists', threadId: (resolved.thread || {}).threadId || friendId };
    }
    var currentRows = [];
    try { currentRows = await dbGetByIndex('chatMessages', 'byFriend', friendId); }
    catch (e) { return { ok: false, reason: 'message-store-unavailable', threadId: friendId };
    }
    if ((currentRows || []).some(function (message) { return c.messageBelongsToThread(message, friendId); })) {
      return { ok: false, reason: 'thread-exists', threadId: friendId };
    }
    var playback = sourceScene.playback && typeof sourceScene.playback === 'object' && !Array.isArray(sourceScene.playback)
      ? sourceScene.playback : {};
    var createdAt = Number(sourceScene.createdAt);
    if (!isFinite(createdAt) || createdAt <= 0) createdAt = nowMs();
    var saved = updateSceneMetadata(resolved.thread.threadId, {
      title: typeof sourceScene.title === 'string' ? sourceScene.title : '',
      tags: Array.isArray(sourceScene.tags) ? sourceScene.tags : [],
      createdAt: createdAt,
      playback: {
        voiceMode: playback.voiceMode === 'text' ? 'text' : 'auto',
        textPacing: playback.textPacing === 'fast' ? 'fast' : 'natural'
      }
    });
    if (!saved.ok) {
      await deleteThread(resolved.thread.threadId);
      return { ok: false, reason: saved.reason || 'scene-save-failed' };
    }
    var missingRoles = [], missingVoiceProfiles = [];
    roleIds.forEach(function (roleId) {
      var cfg = cfgOf(roleId);
      if (!cfg) missingRoles.push(roleId);
      else if (saved.scene.playback.voiceMode === 'auto' && !(cfg.voice && cfg.voice.enabled === true)) missingVoiceProfiles.push(roleId);
    });
    return {
      ok: true,
      created: true,
      threadId: resolved.thread.threadId,
      scene: saved.scene,
      missingRoles: missingRoles,
      missingVoiceProfiles: missingVoiceProfiles
    };
  }

  /* 从 canonical 存储重建索引（导入恢复 / 索引丢失时自愈）。
     真相始终是消息行本身，因此重建是**安全且幂等**的。 */
  async function rebuildThreadIndex() {
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    var rows;
    try { rows = await dbGetAll('chatMessages'); } catch (e) { return { ok: false, reason: 'store-unavailable' }; }
    var byFriend = {};
    for (var i = 0; i < (rows || []).length; i++) {
      var m = rows[i];
      if (!c.isRoleDmMessage(m)) continue;
      var fid = String(m.friendId);
      if (!byFriend[fid]) byFriend[fid] = [];
      byFriend[fid].push(m);
    }
    var list = threadsAll();
    var have = {};
    for (var k = 0; k < list.length; k++) have[list[k].threadId] = list[k];
    /* 索引里存在但**已损坏**的记录（例如 participantIds 缺失/长度不对）不能只是
       被忽略：threadsAll() 会把它滤掉，于是下面 `have[f]` 拿到 undefined，
       而重建又会因为"索引里有这个键"而认定它已存在 —— 结果是这条 thread
       在重建后从列表里彻底消失（实测踩过）。因此显式收集损坏键，并在重建末尾
       把它们从索引里剔除（消息本身不动，历史仍可从消息恢复）。 */
    var raw = readJSON(KEY_THREADS, null);
    var rawItems = (raw && Number(raw.v) === INDEX_VERSION && raw.items && typeof raw.items === 'object') ? raw.items : {};
    var brokenKeys = {};
    for (var rk in rawItems) {
      if (!Object.prototype.hasOwnProperty.call(rawItems, rk)) continue;
      if (!have[rk]) brokenKeys[rk] = true;
    }
    var built = 0;
    var skipped = 0;
    for (var f in byFriend) {
      if (!Object.prototype.hasOwnProperty.call(byFriend, f)) continue;
      var msgs = byFriend[f].sort(function (x, y) { return (Number(x.timestamp) || 0) - (Number(y.timestamp) || 0); });
      var last = msgs[msgs.length - 1];
      var md = (last && last.metadata) || {};
      /* 参与者来源按可靠性排序，绝不写空值：
           ① metadata.senderId / recipientId（本能力的规范字段）；
           ② metadata.config_id（既有 chat 写入点的角色 id 字段；旧消息只有它）；
           ③ 该 thread 里出现过的所有 metadata.senderId/config_id（多轮历史里取全部）。
         仍凑不齐两个不同的参与者 → **跳过**这条 thread，绝不把半截记录写回索引
         （实测踩过：先赋值再校验会让损坏记录覆盖掉可用的索引项）。 */
      var seenIds = [];
      for (var mi = 0; mi < msgs.length; mi++) {
        var mmd = msgs[mi].metadata || {};
        [mmd.senderId, mmd.recipientId, mmd.config_id].forEach(function (v) {
          var s = String(v == null ? '' : v);
          if (s && seenIds.indexOf(s) < 0) seenIds.push(s);
        });
      }
      var fromMsg = [String(md.senderId || md.config_id || ''), String(md.recipientId || '')];
      for (var si = 0; si < seenIds.length && fromMsg.filter(Boolean).length < 2; si++) {
        if (fromMsg.indexOf(seenIds[si]) < 0) fromMsg.push(seenIds[si]);
      }
      var parts = c.canonicalizeParticipants(fromMsg[0] || seenIds[0], fromMsg[1] || seenIds[1]);
      if (parts.length !== 2) { skipped++; continue; }
      var existing = have[f];
      var rec = existing || c.buildThreadRecord(parts[0], parts[1], { now: Number(msgs[0].timestamp) || nowMs() });
      if (!rec) rec = c.buildThreadRecord(parts[0], parts[1], { now: Number(msgs[0].timestamp) || nowMs() });
      if (!rec) { skipped++; continue; }
      rec.participantIds = parts;
      rec.messageCount = msgs.length;
      rec.lastMessageAt = Number(last.timestamp) || 0;
      rec.lastTurnRoleId = String(md.senderId || md.config_id || '');
      rec.updatedAt = rec.lastMessageAt || rec.updatedAt;
      have[f] = rec;
      if (!existing) built++;
    }
    var kept = {};
    for (var hk in have) {
      if (!Object.prototype.hasOwnProperty.call(have, hk)) continue;
      var nrec = c.normalizeThreadRecord(have[hk]);
      if (nrec) kept[hk] = nrec;      /* 只写回**能通过 canonical 校验**的记录 */
    }
    threadsSave(Object.keys(kept).map(function (k2) { return kept[k2]; }));
    return {
      ok: true,
      threads: Object.keys(kept).length,
      discovered: built,
      skipped: skipped,
      dropped: Object.keys(brokenKeys)
    };
  }

  /* ══════════ 消息读写 ═══════════════ */
  async function loadMessages(friendId, limit) {
    var rows;
    try { rows = await dbGetByIndex('chatMessages', 'byFriend', String(friendId)); }
    catch (e) { return []; }
    var c = core();
    var list = (rows || []).filter(function (m) { return c ? c.messageBelongsToThread(m, friendId) : false; });
    list.sort(function (a, b) { return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0); });
    if (limit && list.length > limit) list = list.slice(-limit);
    return list;
  }
  async function appendMessage(msg) {
    if (!msg) return { ok: false, reason: 'bad-message' };
    try { await dbPut('chatMessages', msg); }
    catch (e) {
      /* Home Node 权威下的 fail-closed：写失败必须让调用方看到失败，
         绝不静默写第二份 canonical（home-node-bootstrap.js 的既有语义）。 */
      return { ok: false, reason: core() ? core().REASON.persistFailed : 'persist-failed', error: String((e && e.message) || e) };
    }
    return { ok: true, id: msg.id };
  }

  /* Reuse communication.js's singleton Delivery Runtime. Role DM keeps its own
     canonical message adapter, but shares ordered timing/cancel semantics. The
     conversation key is intentionally disjoint from Chat's dm:/group: keys. */
  async function deliverRoleDmSequence(options) {
    var opts = options || {};
    var signal = opts.signal || null;
    if (signal && signal.aborted) return { ok: false, reason: 'aborted', delivered: 0 };
    var runtime = null;
    try {
      if (window && typeof window._ibDeliveryRuntime === 'function') runtime = window._ibDeliveryRuntime();
    } catch (e) { runtime = null; }
    if (!runtime || typeof runtime.enqueue !== 'function') {
      return { ok: false, reason: 'delivery-unavailable', delivered: 0 };
    }
    var conversationId = 'role-dm:' + String(opts.threadId || '');
    if (!opts.threadId || !Array.isArray(opts.units) || !opts.units.length || typeof opts.onUnit !== 'function') {
      return { ok: false, reason: 'bad-delivery-sequence', delivered: 0 };
    }
    var inFlight = null;
    var abortHandler = function () {
      try { if (typeof runtime.abort === 'function') runtime.abort(conversationId, 'user_stop'); } catch (e) { }
    };
    if (signal && typeof signal.addEventListener === 'function') {
      try { signal.addEventListener('abort', abortHandler, { once: true }); } catch (e) { }
    }
    var handle = null;
    try {
      handle = runtime.enqueue({
        turnId: String(opts.runId || 'role-dm') + ':' + String(opts.modelTurnIndex || 0),
        conversationId: conversationId,
        scope: 'role-dm',
        units: opts.units.map(function (unit) { return { content: String((unit && unit.text) || ''), payload: unit }; }),
        /* Short deterministic pacing follows the existing runtime's silent-delay
           and typing stages. It is bounded by that runtime's own clamp. */
        pacing: { baseMs: 240, perCharMs: 8 },
        onUnit: function (unit, index) {
          inFlight = Promise.resolve().then(function () {
            if (signal && signal.aborted) return { ok: false, reason: 'aborted' };
            return opts.onUnit(unit && unit.payload, index);
          });
          return inFlight;
        },
        onTyping: function (on, info) {
          try {
            if (typeof NS.roleDmEmit === 'function') NS.roleDmEmit('delivery', {
              threadId: String(opts.threadId), typing: !!on, sequenceIndex: Number((info || {}).sequenceIndex) || 0,
              speakerId: String(opts.speakerId || ''),
              speakerName: String(opts.speakerName || '')
            });
          } catch (e) { }
        }
      });
      if (!handle || !handle.promise) return { ok: false, reason: 'delivery-unavailable', delivered: 0 };
      if (signal && signal.aborted) abortHandler();
      var result = await handle.promise;
      /* Delivery Runtime resolves cancellation immediately. Wait for a unit whose
         persistence had already started so run() cannot return ahead of its commit. */
      if (inFlight) { try { await inFlight; } catch (e) { } }
      if (signal && signal.aborted) return { ok: false, reason: 'aborted', delivered: Number((result || {}).delivered) || 0 };
      return {
        ok: !!(result && result.state === 'completed'),
        reason: String((result && result.reason) || (result && result.state) || 'delivery-failed'),
        delivered: Number((result && result.delivered) || 0),
        total: Number((result && result.total) || opts.units.length)
      };
    } catch (e) {
      if (inFlight) { try { await inFlight; } catch (ignored) { } }
      return { ok: false, reason: signal && signal.aborted ? 'aborted' : 'delivery-failed', delivered: 0 };
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', abortHandler); } catch (e) { }
      }
    }
  }

  /* ══════════ A 侧 / B 侧 context 组装 ═══════════════
     每一侧只用**自己**的人格与**自己**的记忆；对方只以**公开认知层**
     （名字 / 公开简介·身份·特征·兴趣 / 你对 TA 的有向看法）出现。
     这从结构上排除"人格串角色"。

     ── 对方的公开资料从哪里来（Peer Awareness Phase 1）────────────────
     唯一来源是 assets/js/public-profile-core.js 的 buildPeerView()：
     构造式白名单 —— 只读 `publicProfile` 与既有的真正公开字段
     （bio / signature），**绝不**读 systemPrompt / apiKey / endpoint /
     memory / relationship。本文件不做任何自己的"截取 persona"逻辑，
     也不在别处拼第二份公开资料 —— 需要的人去调那一个函数。

     为什么不是 `peer.systemPrompt.slice(...)`：persona 是 **Self-private
     authority**，"哪一段算公开"无法判定；截取长度是任意选择，而秘密设定 /
     OOC 指令 / 隐藏关系一旦被截进去，就是一个无法回滚的泄漏。安全优先于
     信息量：旧角色没有公开资料时，对方就只以**名字**出现。 */
  async function composeSide(speakerId, peerId, thread, opts) {
    var c = core();
    opts = opts || {};
    var speaker = cfgOf(speakerId);
    var peer = cfgOf(peerId);
    var history = opts.history || [];
    /* Request-local Conversation State: derived only from this thread's already
       loaded messages and this run's explicit topic hint. Never persisted. */
    var conversationState = opts.trigger === 'autonomous' ? null : {
      threadId: String((thread && thread.threadId) || ''),
      messageCount: history.length,
      topicHint: sanitizeInput(String(opts.topic || '')).slice(0, 200)
    };
    /* ── 层④（我们以前聊过什么）的真源是 **thread 记录** ────────────────
       挂在一对角色上而不是任一角色上，因此 A 与 B **必然**读到同一份
       （memorandum(A,B) === memorandum(B,A)）；有向的是层③ relationship，
       不是这一层。调用方可用 opts.threadMemorandum 显式覆盖（测试用），
       但默认从 thread 上读 —— 否则"共同历史"会变成一个由每个调用点
       各自决定的量，那正是这一层最容易退化的方式。 */
    var memoRaw = (opts.threadMemorandum !== undefined) ? opts.threadMemorandum : (thread ? thread.threadMemorandum : null);
    var memoForPrompt = memorandumForPrompt(memoRaw);
    /* 对方的公开认知层（唯一投影点）。核心缺失时退回"只有名字"——
       绝不因为依赖缺失就把 persona 塞进去。 */
    var pc = profileCore();
    var peerView = (pc && typeof pc.buildPeerView === 'function')
      ? pc.buildPeerView(peer || {}, { sanitize: sanitizeInput, name: peer ? nameOf(peer) : '' })
      : { name: peer ? nameOf(peer) : '', publicIntro: '', occupation: '', traits: [], interests: [], source: 'name-only' };
    var _rel = relationGet(speakerId, peerId);
    var spec = {
      selfName: sanitizeName(nameOf(speaker)) || 'AI',
      selfSystemPrompt: String((speaker && speaker.systemPrompt) || ''),
      /* 对**用户**的关系：这是既有字段的既有语义（cfg.relationship 描述的是
         角色与用户），在此**原样**注入，不挪用成"角色之间的关系"。 */
      selfRelationshipToUser: sanitizeInput(String((speaker && speaker.relationship) || '')),
      peerName: sanitizeName(nameOf(peer)) || '（角色已删除）',
      peerMissing: !peer,
      /* 你对 TA 的看法：来自**有向**关系记录，不是对方的 relationship 字段。
         Phase 4A：同一条有向记录另外派生一份**行为投影**（只吃 familiarity
         这一个数）。绝不使用 cfg.relationship / 用户 Memory / 用户昵称 ——
         那些是"角色↔用户"，不是"A↔B"。 */
      peerRelationship: describeRelation(_rel),
      peerFamiliarity: _rel ? Number(_rel.familiarity) : undefined,
      peerNote: '',
      /* 对方是谁：**只**允许公开的资料（层①）。 */
      peerProfile: {
        publicIntro: peerView.publicIntro,
        occupation: peerView.occupation,
        traits: peerView.traits,
        interests: peerView.interests
      },
      peerProfileSource: peerView.source,
      userPresent: opts.userPresent === true,
      userName: sanitizeInput(opts.userName || ''),
      topic: sanitizeInput(opts.topic || '').slice(0, 200),
      nowLabel: new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' }),
      threadContext: opts.threadContext || '',
      /* 自主发起（低权威行为背景）。调用方（runTurn）已经保证：只有
         trigger==='autonomous' 且当前发言者就是发起人时才非空。 */
      initiation: opts.initiationSignal ? { signalCode: opts.initiationSignal.signalCode } : null,
      /* 层④：跨 run 的共同历史（无向，A 与 B 同一份）。null = 还没有备忘，
         此时 prompt 里**不出现**这一块（不是出现一个空的块）。 */
      threadMemorandum: memoForPrompt,
      history: history.map(function (m) {
        var md = m.metadata || {};
        var sid = String(md.senderId || '');
        return {
          senderId: sid,
          senderName: sanitizeName(String(m.senderName || nameOf(cfgOf(sid)))),
          content: String(m.content || ''),
          fromSelf: sid === String(speakerId),
          fromUser: false
        };
      })
    };
    var built = c.buildRoleDmContext(spec);
    var roleDmDetailedRequest = false;
    /* Reuse the loaded shared brevity policy, with its Role DM-specific strategy.
       This is prompt composition only: no extra provider call, state, or persistence. */
    try {
      var brevity = (window.IB && window.IB.brevity) || null;
      if (brevity && typeof brevity.applyRoleDm === 'function') {
        var styleText = String(opts.lastPeerText || opts.topic || '');
        roleDmDetailedRequest = typeof brevity.isRoleDmDetailedRequest === 'function'
          ? brevity.isRoleDmDetailedRequest(styleText)
          : (typeof brevity.isDetailedRequest === 'function' && brevity.isDetailedRequest(styleText));
        built.system = brevity.applyRoleDm(built.system, {
          detailed: roleDmDetailedRequest,
          concise: !!(speaker && speaker.replyStyle === 'concise'),
          naturalEnding: !!(speaker && speaker.naturalEnding === true),
          conversationContinuity: !!(speaker && speaker.conversationContinuity === true)
        });
      }
    } catch (e) { }
    /* 站点上下文 / Auto Memory 注入：与群聊逐字同款（按本角色独立门控），
       但**不含**玩家可见性档位之外的任何私密内容 —— 复用既有 producer，
       不新造第二套注入器。 */
    try {
      if (typeof buildSiteContext === 'function') {
        var siteCtx = await buildSiteContext({ profile: true, logs: false, fileOutput: false, blogRead: false }, null);
        if (siteCtx) built.system += '\n\n' + String(siteCtx);
      }
    } catch (e) { }
    try {
      if (typeof window.amEnabled === 'function' && window.amEnabled(speaker)) {
        var inj = await window.amBuildInject(speaker, opts.lastPeerText || '');
        if (inj && inj.sys) built.system += '\n\n' + inj.sys;
        if (inj && inj.tail) built.messages[built.messages.length - 1].content += '\n\n' + inj.tail;
      }
    } catch (e) { }
    /* Memory / Understanding：按**本角色**读取（既有 producer，既有可见性规则）。
       私聊不注入 Moments / 日程 / 工作区工具块 —— 那些属于前台聊天场景。 */
    var _memCtx = '', _undCtx = '';
    try {
      if (typeof getMemoryContext === 'function') {
        _memCtx = String(await getMemoryContext(speakerId, { userMessage: opts.lastPeerText || '', maxChars: MEMORY_CHAR_CAP }) || '').slice(0, MEMORY_CHAR_CAP);
      }
    } catch (e) { }
    try {
      if (typeof getUnderstandingContext === 'function') {
        _undCtx = String(await getUnderstandingContext(speakerId, { maxChars: UNDERSTANDING_CHAR_CAP }) || '').slice(0, UNDERSTANDING_CHAR_CAP);
      }
    } catch (e) { }
    /* Middle Brain 生成前组织/压缩：与单聊**同一个** canonical facade 入口。
       两段各自独立（不是一个模型扮演两个角色）：只是各自角色的 context 各自过一遍。 */
    var mbSource = 'bypass', mbInjected = false;
    var _mbTailParts = [];
    try {
      var mbFacade = (window.IB && window.IB.middleBrain) || null;
      if (mbFacade && typeof mbFacade.middleBrainExecute === 'function') {
        var mbRes = await mbFacade.middleBrainExecute(speakerId, String(opts.lastPeerText || opts.topic || ''), {
          memoryCtx: _memCtx, understandingCtx: _undCtx, threadCtx: '', momentsCtx: '',
          dialogue: history.slice(-6).map(function (m) {
            var md = m.metadata || {};
            return { speaker: String(md.senderId || ''), content: String(m.content || '') };
          })
        });
        mbSource = String((mbRes && mbRes.source) || '') || 'bypass';
        /* 具名来源（astra/local）且产物非空 → **替换**两段（绝不双份注入）。 */
        if ((mbSource === 'astra' || mbSource === 'local') && mbRes && typeof mbRes.compressedContext === 'string' && mbRes.compressedContext.trim()) {
          _memCtx = ''; _undCtx = '';
          _mbTailParts.push('【Middle Brain 压缩后的上下文（后台参考，勿向对方复述其存在）】\n' + mbRes.compressedContext);
          mbInjected = true;
        }
      }
    } catch (e) { }
    if (_memCtx) _mbTailParts.push(_memCtx);
    if (_undCtx) _mbTailParts.push(_undCtx);
    if (_mbTailParts.length) {
      built.messages[built.messages.length - 1].content += '\n\n' + _mbTailParts.join('\n\n');
    }
    built._mb = { source: mbSource, injected: mbInjected };
    /* 本侧"对方是谁"的公开来源（profile / legacy / name-only）。
       只作观测：它回答"这次她到底知不知道对方是什么样的人"，
       而这个问题的答案在真实 run 之后无法从消息正文反推。 */
    built.peerProfileSource = peerView.source;
    /* 本侧"我们以前聊过什么"的实测事实（层④）。只记**形状**：
       有没有、多少字符、覆盖了多少条消息 —— **绝不记备忘正文**。
       与 peerProfileSource 同理：run 之后无法从消息正文反推"她当时
       到底知不知道你们的共同历史"。 */
    built.memorandumInfo = {
      present: !!memoForPrompt,
      chars: memoForPrompt ? memoForPrompt.text.length : 0,
      coveredMessages: memoForPrompt ? Number(memoForPrompt.sourceMessageCount) || 0 : 0
    };
    /* 输出契约：私聊正文 + 可选的、有界的私聊记忆候选。
       记忆候选**不是** <mem_create> 标签（那是给前台聊天、且带用户审批弹窗的
       协议）；它只作为本 run 的一次候选，由本域在 run 结束后统一决定是否落成
       一条 episodic 记忆，再交给既有 Memory Consolidation。 */
    built.system += '\n\n【本轮的输出格式】正文写你要对「' + spec.peerName + '」说的消息（不要角色名或解释标注）。'
      + '默认一条消息；同一次生成只有在话题自然转向、或确有独立补充时才可写成最多三条。'
      + '每条消息只表达一个自然完整的意思；复杂说明可以留在一条里。'
      + '多条消息必须用单独一行 [[ib:message]] 分隔；普通换行、分段和标点都不会自动拆成多个气泡。'
      + '如果这次私聊里出现了**值得你长期记住**的具体事情，再另起一行输出一行私聊记忆候选：'
      + '<role_dm_memo importance="1-10">一句话，≤80字</role_dm_memo>。'
      + '没有值得长期记住的事就完全不要输出这个标签。绝大多数闲聊都不需要它。';
    built.system += '\n\n【可选的自然聊天节奏】只按角色原有语气和当前上下文说话，不必每轮拆分，也不必刻意口语化。'
      + '合适时可以用短句和轻停顿、简短回应（如“嗯”“好”“哈哈”），或在想到真实补充时轻微改口。'
      + '短回应后若只是同一意思的解释，优先合成一条；确实像两个自然接话节拍、或补充本身独立时，才用既有 [[ib:message]] 分成气泡。'
      + '不要为了显得自然或凑气泡数而添加回应、重复内容或虚构事实；改口只纠正当前对话中已有依据的内容。';
    try {
      var expressionHint = window.IBExpressionPacks && typeof window.IBExpressionPacks.promptHint === 'function'
        ? window.IBExpressionPacks.promptHint(speakerId) : '';
      if (expressionHint) built.system += '\n\n' + expressionHint;
    } catch (expressionPromptError) { }
    built.system += '\n\n【Correction / Hesitation v1 · 低频修正】改口、补充或犹豫后修正完全可选且低频，绝大多数回复直接自然说完。'
      + '只有当当前 thread 的明确原文，或本轮已经写出的当前措辞，提供了可指出的具体依据时才修正；补充也只能澄清本句或 thread 已提供的事实。'
      + '如果当前 thread 没有那句话，就不要声称“我刚才说过”或“刚才说错了”，不编造先前错误、反悔或新事实；空 thread 不假设有旧说法。'
      + '犹豫只可作为确有修正依据时的一小句承接，并立刻给出修正；不写戏剧化停顿、拉长省略号、口吃或重复道歉。轻微否定自己前一句时，必须能指出该句及更正依据。'
      + '一次回复最多出现一处修正，即使有依据也可以不修正；不要每轮安排。若改口自然分成两拍，先说原表达再紧接更正；一句内能自然完成就不要为犹豫单独拆泡，多条消息只沿用 [[ib:message]] 的既有顺序和格式。';
    if (opts.trigger !== 'autonomous') {
      built.system += '\n\n【Conversation State v1 · 当前 thread】'
        + (conversationState.messageCount > 0
          ? '本轮使用当前 thread 最近 ' + conversationState.messageCount + ' 条对话原文。'
          : '当前 thread 没有历史消息；不要假设曾讨论过的话题、已回答的问题或共同事件。')
        + (conversationState.topicHint
          ? '本轮明确给出的话题入口是「' + conversationState.topicHint + '」；如果近期对话已经转向，以较新的原文为准。'
          : '从当前 thread 最近对话识别正在讨论的主题；近期已转向时不要固守旧话题。')
        + '把仍未回答的问题、尚未完成的约定作为可承接项；后续消息已答复或完成的就视为解决，不重复询问或机械追问。'
        + '计划、偏好和状态以本 thread 最近的明确说法为准，较新的明确修正覆盖较早说法；问题、猜测和假设不当作已确认事实。'
        + '只在自然相关时轻提一处近期内容，不复述、回顾或机械总结；无自然承接点时直接回应当前内容。'
        + '当前内容确有依据时，可以轻微反驳、补充、改口或插入一句短促的打断式补充；这些表达完全可选，每次回复至多一种，不要每轮加入或演成戏剧冲突。'
        + '以上判断只用当前 thread 的消息与本轮话题提示，不从其他 thread、Chat 或跨会话内容补足，也不凭空补写过去事件。';
    }
    var replyInitiative = opts.replyInitiative && typeof opts.replyInitiative === 'object'
      ? normalizeReplyInitiativePrefs(opts.replyInitiative) : null;
    if (replyInitiative && replyInitiative.enabled) {
      var initiativeGuidance = [];
      if (replyInitiative.types.supplement) initiativeGuidance.push('回复中补充：加一句相关想法或轻微反问');
      if (replyInitiative.types.contextLink) initiativeGuidance.push('关联上下文：连接本线程已提供的相关内容，不声称记得未提供的经历');
      if (replyInitiative.types.careNudge) initiativeGuidance.push('轻量关心或提醒：只根据对方明确说过的状态、安排或困难，不推断新事实');
      if (initiativeGuidance.length) {
        built.system += '\n\n【回复内轻量主动表达】本轮可选下面一种方式，在当前 Role DM 回复中自然带出：'
          + initiativeGuidance.join('；') + '。这只是低频机会，不要求每次都添加；如果当前上下文没有明确依据、或正常回复已经足够，就不要补充。'
          + '保持角色原有语气，不新开话题，不为了主动表达额外制造气泡；若补充确实独立，再沿用现有多气泡格式。';
      }
    }
    built.system += '\n\n【本轮回合意图】输出的第一行必须且只写一个短控制标记，紧接着从下一行开始写消息正文：'
      + '[role_dm:speak]、[role_dm:continue_self]、[role_dm:yield] 或 [role_dm:end]。'
      + 'speak 表示本次生成的消息已经说完，现在交给对方；continue_self 表示这些消息之后确实还有独立的后续想法，需要下一次模型调用。'
      + '同一次生成里的 1–3 条消息仍只算一个模型回合；continue_self 才会再消耗一个模型回合，同一角色最多连续两次模型生成。'
      + '不要把本来适合分开发送的两件事用多个段落塞进同一条普通闲聊，也不要把一句完整答复拆成碎片。'
      + 'yield 表示这次不发消息、让对方接话，适合停顿或把话让给对方；end 表示对话已经自然停在这里，可附一条简短收尾，也可不写正文。'
      + '一条消息已经自然说完时用 speak；有真正独立的补充才用 continue_self；对话停住时可用 yield 或 end。不要为了延长对话而制造补充，也不要解释或复述控制标记；标记不会显示给对方。';
    if ((Number(opts.consecutiveSpeakerCount) || 0) >= 1) {
      built.system += '\n\n【跨模型连续发言上限】你已经连续完成 ' + Math.min(2, Number(opts.consecutiveSpeakerCount) || 0)
        + ' 次模型生成；本轮之后若再由你开启一次模型生成会超过上限。当前生成内的多条消息仍只算一次，请不要选择 continue_self。';
    }
    if (!roleDmDetailedRequest) {
      built.system += '\n\n【普通闲聊的优先格式】最近的历史只提供事实和关系背景，不要求你模仿它的长度或排版。'
        + '除非对方明确要求展开，或话题确实复杂，一条普通回应通常一两句；先接住最近的一件事，说完就停。'
        + '如果自然地转到另一件独立的事，可以在本次生成里另发一条；不要按句号、换行或固定长度机械拆分。'
        + '只有还需要另一次模型生成补充时才选择 continue_self；不要把多条消息误当成多个模型回合。'
        + '不要为了遵守格式删掉复杂问题必需的解释，也不要为了多发消息拆开一段完整的话。';
    }
    /* Keep a compact copy of the control contract in the final generation frame.
       The model sees this after recent history and Memory context, while the stored
       message remains untouched and the runtime still performs exactly one call. */
    var finalUserIndex = built.messages.length - 1;
    if (finalUserIndex >= 0 && built.messages[finalUserIndex].role === 'user') {
      var finalFrame = '【本轮输出格式】第一行只写一个控制标记：[role_dm:speak]、[role_dm:continue_self]、[role_dm:yield] 或 [role_dm:end]；下一行开始写正文。'
        + '默认一条；确有自然话题转向时最多三条，并且只用单独一行 [[ib:message]] 分隔，不按标点或换行拆分。'
        + '每条可在自己的末尾另起一行选择一个引用键，例如 [[quote:Q1.2]]；每条独立决定是否引用。'
        + '一次生成里的多条消息仍只消耗一个模型回合；continue_self 才会调用模型生成下一回合。'
        + '不要省略标记，不要加代码围栏或解释。yield 仅写标记不写正文；end 可以只写标记或附收尾。';
      if (!roleDmDetailedRequest) {
        finalFrame += ' 普通闲聊通常一句或两句；复杂说明可以保持一条，只有独立话题才分成不同消息。';
      }
      if (opts.trigger !== 'autonomous') {
        finalFrame += ' 回复前核对本 thread 最近消息里已经回答的内容；引用只在自然时轻带，不复述或机械总结。';
      }
      finalFrame += ' 自然聊天节奏是可选的：可按语境使用短停顿、简短回应或轻微改口补充；不要每轮套用，也不要为拆分制造消息，并保持角色原有语气与事实边界。';
      finalFrame += ' 改口或犹豫完全可选且低频，只依据当前措辞或当前 thread 明确原文；无原文不声称说过或说错过，不添新事实。犹豫须立即接修正，不制造戏剧停顿；多气泡先原表达后修正，沿用 [[ib:message]]。';
      if ((Number(opts.consecutiveSpeakerCount) || 0) >= 1) finalFrame += ' 你已连续完成模型生成，本轮之后请让对方接话，不要选择 continue_self。';
      built.messages[finalUserIndex].content += '\n\n' + finalFrame;
    }
    /* Quote-Aware Reply uses the existing canonical messages only. The request-local
       candidate map is also the validation allowlist; no new call or stored state. */
    var quoteCore = (window && window.IBMessageQuoteCore) || null;
    built.quoteContext = null;
    try {
      if (quoteCore && typeof quoteCore.buildContext === 'function') {
        built.quoteContext = quoteCore.buildContext(history, {
          mode: 'role-dm', friendId: String((thread && thread.threadId) || ''),
          threadId: String((thread && thread.threadId) || ''), currentSenderId: speakerId,
          limit: 8
        });
        if (built.quoteContext.prompt) built.system += '\n\n' + built.quoteContext.prompt
          + '\n本轮如果使用 [[ib:message]] 分成多条，每条消息都可以单独选择至多一个目录中的引用键；引用标记紧跟该条正文并放在分隔符之前。';
      }
    } catch (e) { built.quoteContext = null; }
    /* buildRoleDmContext returns both a diagnostic `system` string and the provider
       `messages` array. Every policy above is appended to the former, so synchronize
       the canonical system frame before the sole provider call. Without this copy,
       the live model sees only the base persona and final user frame—not brevity,
       intent, Memory framing, or Quote-Aware Reply guidance. */
    if (built.messages.length && built.messages[0] && built.messages[0].role === 'system') {
      built.messages[0].content = built.system;
    }
    built.peerName = spec.peerName;
    var _traceMemoryChars = String(_memCtx || '').length + String(_undCtx || '').length;
    var _traceContextChars = String(built.system || '').length;
    built.messages.forEach(function (message) { _traceContextChars += String((message && message.content) || '').length; });
    built.traceMetrics = {
      memoryState: _traceMemoryChars ? 'present' : 'empty',
      memoryChars: _traceMemoryChars,
      contextMessages: built.messages.length,
      contextChars: _traceContextChars,
      systemChars: String(built.system || '').length,
      tailChars: built.messages.length ? String((built.messages[built.messages.length - 1] || {}).content || '').length : 0
    };
    built.selfName = spec.selfName;
    return built;
  }

  /* 把有向关系记录说成一句人话（给发言方自己看）。**只有**真实观测过的
     关系才会产生这句话；没有来往时返回 ''（不注入一行"关系未知"）。 */
  function describeRelation(rel) {
    if (!rel) return '';
    var c = core();
    if (!c) return '';
    if (!(Number(rel.dmCount) > 0)) return '';
    var trust = Number(rel.trust), fam = Number(rel.familiarity);
    var t = trust >= 0.75 ? '很信任' : trust >= 0.6 ? '比较信任' : trust >= 0.45 ? '说不上信任与否' : trust >= 0.3 ? '有些保留' : '不太信任';
    var f = fam >= 0.7 ? '非常熟' : fam >= 0.4 ? '挺熟' : fam >= 0.2 ? '有些熟悉' : '还不太熟';
    return '你们私下聊过 ' + Number(rel.dmCount) + ' 次；你' + f + '，对 TA ' + t + '。';
  }

  /* ══════════ 一轮发言（**一次真实模型调用**）═══════════════
     返回值：{ok, text, memo, provider, model, speakerName, reason}
     失败时的 reason 只取三种事实之一（**请求成功 ≠ provider 失败**）：
       · missingCharacter / provider-not-ready  —— 配置层面，根本没发出去；
       · provider-failed                          —— 请求真的失败了（抛错/HTTP/鉴权）；
       · output-truncated / empty-output          —— 请求成功，但没有可用正文。 */
  async function runTurn(ctx) {
    var c = core();
    var speakerId = String(ctx.speakerId);
    var peerId = String(ctx.peerId);
    var speaker = cfgOf(speakerId);
    if (!speaker) return { ok: false, reason: c.REASON.missingCharacter };
    if (!apiReady(speaker)) return { ok: false, reason: c.REASON.notReady };
    var history = await loadMessages(ctx.thread.threadId, ctx.historyLimit || HISTORY_LIMIT);
    var lastPeer = '';
    for (var i = history.length - 1; i >= 0; i--) {
      if (String((history[i].metadata || {}).senderId) === peerId) { lastPeer = String(history[i].content || ''); break; }
    }
    /* Middle Brain Trace：**在 context 组装之前** begin，因为组装本身就要往
       同一条记录上打点（MB 产出来源）。身份字段一律指本回合的真实执行上下文。 */
    var trace = (function () { try { return (window.IB && window.IB.__mbTrace) || null; } catch (e) { return null; } })();
    var _turnTraceId = _roleTurnTraceBegin({consumer:'role_dm',characterId:speakerId,
      threadId:String((ctx.thread && ctx.thread.threadId) || ''),turnId:String(ctx.runId || ctx.turnIndex || '')});
    _roleTurnTraceEvent(_turnTraceId,'input',{inputMessages:history.length+1,inputChars:String(lastPeer || '').length});
    function _finishRoleDmTrace(status, fields) {
      if (trace) { try { trace.finish(speakerId, {}); } catch (e) { } }
      _roleTurnTraceFinish(_turnTraceId,status,Object.assign({resultChars:0,assistantMessages:0},fields || {}),turn);
    }
    if (trace) {
      trace.begin('role_dm', speakerId);
      /* 只记稳定身份；**不记** API key、不记 prompt、不记消息正文。 */
      trace.note(speakerId, 'consumer', 'role_dm');
      trace.note(speakerId, 'threadId', ctx.thread.threadId);
      trace.note(speakerId, 'speaker', speakerId);
      trace.note(speakerId, 'peer', peerId);
      trace.note(speakerId, 'trigger', String(ctx.trigger || 'manual'));
      /* 自主发起的社会理由（reasonCode 闭集）——**只记 code**，
         绝不记 score / affinity / quota / scheduler 之类的工程数据。 */
      if (ctx.signal && ctx.signal.reasonCode) {
        trace.note(speakerId, 'initiationSignal', String(ctx.signal.reasonCode).slice(0, 40));
      }
      trace.note(speakerId, 'turn', Number(ctx.turnIndex) || 0);
      trace.note(speakerId, 'model', String(speaker.model || ''));
      trace.note(speakerId, 'executor', 'callApiChat');
    }
    var built;
    try {
      built = await composeSide(speakerId, peerId, ctx.thread, {
        history: history,
        topic: ctx.topic,
        userName: ctx.userName,
        userPresent: ctx.userPresent,
        threadContext: ctx.threadContext,
        lastPeerText: lastPeer,
        /* 自主发起的行为背景。**只**透传闭集里的 code；任何其它字段
           （score / peerId / quota / signals 数组）都到不了这里。 */
        initiationSignal: (ctx.trigger === 'autonomous' && ctx.signal && ctx.signal.reasonCode)
          ? { signalCode: String(ctx.signal.reasonCode) }
          : null,
        trigger: ctx.trigger,
        runId: ctx.runId,
        replyInitiative: ctx.replyInitiative || null,
        consecutiveSpeakerCount: Number(ctx.consecutiveSpeakerCount) || 0
      });
    } catch (contextError) {
      _finishRoleDmTrace('failed',{errorCategory:'context'});
      throw contextError;
    }
    _roleTurnTraceEvent(_turnTraceId,'memory',{memoryState:built.traceMetrics&&built.traceMetrics.memoryState||'empty',
      memoryChars:built.traceMetrics&&built.traceMetrics.memoryChars||0,memoryAuthority:'role_visible'});
    _roleTurnTraceEvent(_turnTraceId,'middle_brain',{mbSource:String((built._mb&&built._mb.source)||'bypass'),
      mbInjected:!!(built._mb&&built._mb.injected)});
    _roleTurnTraceEvent(_turnTraceId,'context',{contextMessages:built.traceMetrics&&built.traceMetrics.contextMessages||built.messages.length,
      contextChars:built.traceMetrics&&built.traceMetrics.contextChars||0,systemChars:built.traceMetrics&&built.traceMetrics.systemChars||0,
      tailChars:built.traceMetrics&&built.traceMetrics.tailChars||0});
    _roleTurnTraceEvent(_turnTraceId,'tool_execution',{toolName:'none',toolStatus:'disabled',toolCount:0});
    var promptContract = {
      roleDmBrevity: String(built.system || '').indexOf('【角色私聊表达】') >= 0,
      ordinaryShortFormat: String(built.system || '').indexOf('【普通闲聊的优先格式】') >= 0,
      intentContract: String(built.system || '').indexOf('[role_dm:continue_self]') >= 0,
      finalUserIntentContract: !!(built.messages.length && built.messages[built.messages.length - 1].role === 'user'
        && String(built.messages[built.messages.length - 1].content || '').indexOf('[role_dm:continue_self]') >= 0),
      quoteGuidance: !!(built.messages.length && built.messages[0] && built.messages[0].role === 'system'
        && String(built.messages[0].content || '').indexOf('【可选的引用回复】') >= 0),
      messageProtocol: !!(built.messages.length && built.messages[0] && built.messages[0].role === 'system'
        && String(built.messages[0].content || '').indexOf('[[ib:message]]') >= 0)
    };
    var quoteCandidateCount = built.quoteContext && Array.isArray(built.quoteContext.candidates)
      ? built.quoteContext.candidates.length : 0;
    var quoteOptionCount = built.quoteContext && Array.isArray(built.quoteContext.quoteOptions)
      ? built.quoteContext.quoteOptions.length : 0;
    try {
      if (typeof ctx.onQuoteCandidates === 'function') ctx.onQuoteCandidates(quoteCandidateCount, quoteOptionCount);
    } catch (e) { }

    if (ctx.abortSignal && ctx.abortSignal.aborted) {
      _finishRoleDmTrace('aborted',{reasonCode:'aborted'});
      return { ok: false, reason: c.REASON.aborted };
    }

    /* 宿主回合：ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET。
       与群聊里"每个发言成员各自一个宿主回合"逐字同款（communication.js:2165-2167）。 */
    var turn = null, lc = null;
    try {
      if (typeof _ibTurnScope === 'function' && typeof _ibTurnLc === 'function') {
        lc = _ibTurnLc(_ibTurnScope('role_dm'));
        turn = lc.turn();
        lc.begin();
      }
    } catch (e) { lc = null; }
    if (trace && built._mb) {
      /* MB 层的实测来源（astra / local / bypass）与"是否真的注入"，与单聊同名同义。 */
      trace.note(speakerId, 'source', built._mb.source);
      trace.note(speakerId, 'messagesChanged', !!built._mb.injected);
    }
    /* 对方公开认知的来源（profile / legacy / name-only）—— 值本身不含任何
       角色内容，只说明"这一侧有没有拿到公开资料"。 */
    if (trace) trace.note(speakerId, 'peerProfileSource', String(built.peerProfileSource || 'name-only'));
    /* 层④ 的实测事实。只记形状与计数，**不记正文**（§16）。
       A 侧与 B 侧这两个值必须相同 —— 它们读的是同一份 thread 备忘。 */
    if (trace && built.memorandumInfo) {
      trace.note(speakerId, 'memorandumPresent', !!built.memorandumInfo.present);
      trace.note(speakerId, 'memorandumChars', Number(built.memorandumInfo.chars) || 0);
      trace.note(speakerId, 'memorandumCoveredMessages', Number(built.memorandumInfo.coveredMessages) || 0);
    }
    var raw = '';
    /* 执行器回的是什么形状：wantMeta 下是 {text,truncated}。truncated 是
       provider 的 finish_reason 翻译过来的**事实**，不是估计值。 */
    var asked = { text: '', truncated: false, budgets: [] };
    try {
      if (typeof callApiChat !== 'function') {
        _finishRoleDmTrace('failed',{reasonCode:'executor_unavailable'});
        return { ok: false, reason: 'executor-unavailable' };
      }
      var res = {};
      /* 预算梯子只有两级，且第二级只在"被截断且正文为空"时才会被追加。
         为什么要元信息（wantMeta）：callApiChat 在正文为空时**不抛错**，
         只把 finish_reason=length 记进元信息。不要它，就分不清两件完全不同
         的事：provider/网络/鉴权失败（该去查 API 配置）与输出上限被思考吃光
         （该给更多预算）—— 而后者正是本仓库真实探针测到的那个失败。 */
      var budgets = [Number(ctx.maxTokens) || TURN_MAX_TOKENS];
      for (var bi = 0; bi < budgets.length; bi++) {
        var r = await callApiChat(speaker, built.messages, {
          _ibConsumer: 'role_dm',
          _ibTraceId: _turnTraceId,
          /* RCI-1：调用身份 = 本回合**实际发言角色**与它所在的私聊 thread。
             两者都取自本回合的真实执行上下文（speakerId 是本回合的发言方 id，
             threadId 是本次 run 的会话 id）；没有独立 runId，也不为一个 trace
             新建持久化 id —— threadId 已经能把这次会话与别的会话分开。
             只进 reasoning trace，不进入 provider 请求体。 */
          _ibCharacterId: speakerId,
          _ibThreadId: String((ctx.thread && ctx.thread.threadId) || ''),
          _ibTurn: turn || undefined,
          /* 私聊是纯对话：不给工具、不联网、不自动续轮。
             这既是产品边界（角色之间聊天不该去改用户的工作区），
             也去掉了一整类副作用与 runaway 面。 */
          disableTools: true,
          _noWebSearch: true,
          autoContinue: false,
          wantThinking: false,
          wantMeta: true,
          maxTokens: budgets[bi],
          timeoutMs: 90000,
          result: res
        });
        asked.budgets.push(budgets[bi]);
        asked.text = String((r && r.text) == null ? '' : r.text);
        asked.truncated = !!(r && r.truncated === true);
        if (ctx.abortSignal && ctx.abortSignal.aborted) break;
        if (asked.text.trim()) break;
        /* 正文为空（无论是否被截断）⇒ 这一轮一个字都没说成，给**一次**更大的
           预算重试。实测有两种形态，都必须覆盖：
             · finish_reason=length —— 思考把输出上限吃光（已确证的原始回包）；
             · finish_reason≠length 但 content 为空 —— 思考写完了、正文没落地，
               同一条 prompt 下一分钟又能说成（瞬时形态）。
           只重试一次；两次都空就说成"没说成"，绝不重试到成功。
           已经比第二级宽（ctx 显式给了更大预算）时不再追加，避免重复同一预算。 */
        if (bi === 0 && budgets[0] < TURN_MAX_TOKENS_RETRY) budgets.push(TURN_MAX_TOKENS_RETRY);
      }
      built._res = res;
    } catch (err) {
      _finishRoleDmTrace('failed',{errorCategory:_roleErrorCategory(err)});
      return { ok: false, reason: c.REASON.providerFailed, error: String((err && err.message) || err).slice(0, 200) };
    } finally {
      try { if (lc) lc.end(); } catch (e) { }
    }

    if (ctx.abortSignal && ctx.abortSignal.aborted) {
      _finishRoleDmTrace('aborted',{reasonCode:'aborted'});
      return { ok: false, reason: c.REASON.aborted };
    }

    raw = asked.text;
    var text = String(raw == null ? '' : raw);
    var parsedIntent = c.parseRoleDmIntent(text);
    text = parsedIntent.text;
    var intent = parsedIntent.intent;
    var quoteCore = (window && window.IBMessageQuoteCore) || null;
    var replyMessages = [{ text: text, quote: null, quoteResult: 'core-unavailable', quoteReason: 'core-unavailable' }];
    var sequenceInfo = { multi: false, messageCount: 1, formatFallback: false, formatReason: '' };
    try {
      if (quoteCore && typeof quoteCore.parseReplyMessages === 'function') {
        var parsedSequence = quoteCore.parseReplyMessages(text, built.quoteContext);
        replyMessages = Array.isArray(parsedSequence.messages) ? parsedSequence.messages : replyMessages;
        sequenceInfo = {
          multi: parsedSequence.multi === true,
          messageCount: replyMessages.length,
          formatFallback: parsedSequence.formatFallback === true,
          formatReason: String(parsedSequence.formatReason || '')
        };
      } else if (quoteCore && typeof quoteCore.parseReply === 'function') {
        var parsedQuote = quoteCore.parseReply(text, built.quoteContext);
        replyMessages = [{
          text: parsedQuote.text,
          quote: parsedQuote.valid === true ? (parsedQuote.quote || null) : null,
          quoteResult: parsedQuote.valid === true ? 'accepted' : (parsedQuote.directiveFound ? 'rejected' : 'no-directive'),
          quoteReason: parsedQuote.valid === true ? '' : String(parsedQuote.reason || (parsedQuote.directiveFound ? 'unknown' : 'missing-directive'))
        }];
      } else if (quoteCore && typeof quoteCore.stripDirectives === 'function') {
        var strippedUnavailable = quoteCore.stripDirectives(text);
        replyMessages = [{ text: strippedUnavailable.text, quote: null, quoteResult: 'core-unavailable', quoteReason: 'core-unavailable' }];
      }
    } catch (e) {
      var safeText = quoteCore && typeof quoteCore.stripDirectives === 'function'
        ? quoteCore.stripDirectives(text).text : text;
      replyMessages = [{ text: safeText, quote: null, quoteResult: 'rejected', quoteReason: 'parse-error' }];
      sequenceInfo = { multi: false, messageCount: 1, formatFallback: true, formatReason: 'parse-error' };
    }
    if (!replyMessages.length) replyMessages = [{ text: '', quote: null, quoteResult: 'no-directive', quoteReason: 'missing-directive' }];
    text = replyMessages.map(function (unit) { return String((unit && unit.text) || ''); }).join('\n\n');
    for (var qpi = 0; qpi < replyMessages.length; qpi++) {
      try {
        var quoteUnit = replyMessages[qpi] || {};
        if (typeof ctx.onQuoteParse === 'function') ctx.onQuoteParse({
          result: String(quoteUnit.quoteResult || 'core-unavailable'),
          reason: String(quoteUnit.quoteReason || 'core-unavailable')
        });
      } catch (e) { }
    }
    try { if (typeof ctx.onSequenceParse === 'function') ctx.onSequenceParse(sequenceInfo); } catch (e) { }
    if (!text.trim() && intent !== 'yield' && intent !== 'end') {
      _finishRoleDmTrace('empty_output',{reasonCode:asked.truncated?'output_truncated':'empty_output'});
      /* 这里有界预算与那一次重试都已经走完，仍然一个字都没有 —— 于是**现在**
         才能给停止原因，且必须按**证据**分类（Phase 3.1 Output Failure Semantics）：
           · truncated=true（provider 的 finish_reason=length 翻过来的事实）
             → output-truncated：输出上限（被思考）吃光了；
           · truncated=false → empty-output：请求成功、服务商回了空正文。
         两者都**不再**落进 provider-failed。provider 并没有失败：把它说成
         "模型请求失败"会把用户引去查 key / endpoint / 网络 —— 三个都没坏的东西。
         error 与停止原因同码（一个事实只写一次），emptyOutput 仍保留为
         "模型回过话、只是没吐出正文"的分类标记（run() 用它守住那条
         "密钥缺失"的用户报错不会在这些路径上出现）。 */
      return {
        ok: false,
        reason: asked.truncated ? c.REASON.outputTruncated : c.REASON.emptyOutput,
        error: asked.truncated ? c.REASON.outputTruncated : c.REASON.emptyOutput,
        emptyOutput: true,
        intent: intent,
        intentParsed: parsedIntent.valid === true,
        intentParseReason: parsedIntent.reason || 'unknown',
        promptContract: promptContract
      };
    }
    /* 私聊记忆候选：先从各条消息摘掉标签，**绝不**让标签进入正文 / 持久化 / 渲染。 */
    var memo = null;
    for (var memoIndex = 0; memoIndex < replyMessages.length; memoIndex++) {
      var memoUnit = replyMessages[memoIndex] || {};
      memoUnit.text = String(memoUnit.text || '').replace(/<role_dm_memo\b([^>]*)>([\s\S]*?)<\/role_dm_memo\s*>/ig, function (tag, attrs, body) {
        if (!memo) {
          var imp = /importance\s*=\s*"?(\d{1,2})"?/i.exec(attrs || '');
          var mc = String(body || '').trim().slice(0, 200);
          if (mc) memo = { content: mc, importance: imp ? parseInt(imp[1], 10) : 6 };
        }
        return '';
      }).trim();
    }
    text = replyMessages.map(function (unit) { return String((unit && unit.text) || ''); }).join('\n\n');
    /* A valid control-only response is a successful turn attempt, not provider empty-output.
       Control actions never create a message or a Memory candidate. */
    if (!text.trim() && (intent === 'yield' || intent === 'end')) {
      _finishRoleDmTrace('completed',{resultChars:0,assistantMessages:0,reasonCode:intent});
      return {
        ok: true, text: '', messages: [], memo: null, stripped: [], intent: intent,
        intentParsed: parsedIntent.valid === true,
        intentParseReason: parsedIntent.reason || 'unknown',
        sequence: sequenceInfo,
        promptContract: promptContract,
        peerText: String(lastPeer || ''), provider: String(speaker.provider || ''),
        model: String(speaker.model || ''), speakerName: nameOf(speaker)
      };
    }
    /* 兜底：模型可能只输出标签不写正文 → 说明这一轮没有实质内容。
       这同样不是 provider 故障（它回过话），归 empty-output。 */
    if (!text.trim()) {
      _finishRoleDmTrace('empty_output',{reasonCode:'empty_output'});
      return { ok: false, reason: c.REASON.emptyOutput, error: c.REASON.emptyOutput, emptyOutput: true,
        intent: intent, intentParsed: parsedIntent.valid === true, intentParseReason: parsedIntent.reason || 'unknown', promptContract: promptContract };
    }
    /* Middle Brain 生成后收口 —— 与单聊同一个唯一调用点、同一份裁定词表。
       consumer=role_dm 不豁免 persona guard / speech style / knowledge 边界。 */
    var verdict = null;
    try {
      var mb = (window.IB && window.IB.middleBrain) || null;
      if (mb && typeof mb.middleBrainFinalizeReply === 'function') {
        var fin = await mb.middleBrainFinalizeReply(speakerId, lastPeer || ctx.topic || '', text, { character: speaker, history: history });
        if (fin && typeof fin.reply === 'string' && fin.reply && fin.reply !== text) {
          text = fin.reply;
          /* Keep the existing one-finalizer-per-model-generation contract. If the
             integrity guard rewrites the combined candidate, no safe unit mapping
             remains, so its result becomes one ordinary message without quote refs. */
          replyMessages = [{ text: text, quote: null, quoteResult: 'no-directive', quoteReason: 'missing-directive' }];
          sequenceInfo = { multi: false, messageCount: 1, formatFallback: false, formatReason: '' };
        }
        verdict = (fin && fin.outcome && fin.outcome.verdict) || null;
      }
    } catch (e) { }
    if (trace) { try { trace.finish(speakerId, {}); } catch (e) { } }

    /* 私聊不解析任何副作用标签（ws_* / mem_* / cal_note / blog_read / withdraw）。
       若模型仍写出了它们，从正文里剥掉，避免标签原样上屏或入库 —— 这既守住
       "角色之间聊天不操作用户环境"的边界，也不静默丢弃（下面如实报 stripped）。 */
    var stripped = [];
    var cleanMessages = [];
    for (var cleanIndex = 0; cleanIndex < replyMessages.length; cleanIndex++) {
      var candidateUnit = replyMessages[cleanIndex] || {};
      var cleanText = String(candidateUnit.text || '').replace(/<\/?(?:ws_[a-z_]+|mem_(?:create|update|delete)|cal_note|blog_read|withdraw)\b[^>]*>/gi, function (tag) {
        stripped.push(String(tag).replace(/[<>/]/g, '').split(/\s|>/)[0]);
        return '';
      });
      cleanText = cleanText.replace(/```[a-z]*file:[^\n]*\n[\s\S]*?```/gi, '').trim();
      if (cleanText) {
        var expressionParse = { text: cleanText, expressionRef: null };
        try {
          if (window.IBExpressionPacks && typeof window.IBExpressionPacks.parseReply === 'function') {
            expressionParse = window.IBExpressionPacks.parseReply(speakerId, cleanText) || expressionParse;
          } else if (window.IBExpressionPackCore && typeof window.IBExpressionPackCore.parseReplyExpressions === 'function') {
            expressionParse = window.IBExpressionPackCore.parseReplyExpressions(cleanText, speaker) || expressionParse;
          }
        } catch (expressionParseError) { expressionParse = { text: cleanText, expressionRef: null }; }
        cleanMessages.push({ text: String(expressionParse.text || ''), replyQuote: candidateUnit.quote || null,
          expressionRef: expressionParse.expressionRef || null });
      }
    }
    replyMessages = cleanMessages;
    text = replyMessages.map(function (unit) { return String(unit.text || ''); }).join('\n\n').trim();
    /* 我们自己把标签剥干净之后没剩正文：模型确实给了东西，只是没有可用正文。
       与"provider 失败"无关（同 empty-output 一类），因此**绝不**报密钥。 */
    if (!text) {
      if (intent === 'end') {
        _roleTurnTraceFinish(_turnTraceId,'completed',{resultChars:0,assistantMessages:0,reasonCode:'end'},turn);
        return {
          ok: true, text: '', messages: [], memo: null, stripped: stripped, intent: intent,
          intentParsed: parsedIntent.valid === true,
          intentParseReason: parsedIntent.reason || 'unknown',
          sequence: sequenceInfo,
          promptContract: promptContract,
          peerText: String(lastPeer || ''), provider: String(speaker.provider || ''),
          model: String(speaker.model || ''), speakerName: nameOf(speaker)
        };
      }
      _roleTurnTraceFinish(_turnTraceId,'empty_output',{resultChars:0,assistantMessages:0,reasonCode:'empty_output'},turn);
      return { ok: false, reason: c.REASON.emptyOutput, error: c.REASON.emptyOutput, emptyOutput: true,
        intent: intent, intentParsed: parsedIntent.valid === true, intentParseReason: parsedIntent.reason || 'unknown', promptContract: promptContract };
    }

    _roleTurnTraceFinish(_turnTraceId,'completed',{resultChars:String(text || '').length,assistantMessages:replyMessages.length},turn);
    return {
      ok: true,
      text: String(replyMessages[0].text || ''),
      messages: replyMessages,
      memo: memo,
      stripped: stripped,
      intent: intent,
      intentParsed: parsedIntent.valid === true,
      intentParseReason: parsedIntent.reason || 'unknown',
      sequence: sequenceInfo,
      promptContract: promptContract,
      replyQuote: replyMessages[0].replyQuote || null,
      /* 这一轮模型**实际看到**的上一条对方消息（组装 prompt 时已经从
         history 里取出来的那一条，正是 lastPeer）。
         为什么要在返回值里带出来：M3 软复读要回答"她是不是在复述对方刚说的话"，
         而"对方刚说的话"的 canonical 定义就是**这一条** —— 不是 thread 里的
         上一条消息（那可能是她自己说的），也不是本 run 里的上一条
         （跨 run 续聊时它并不存在）。让调用方自己去猜，就等于把这个定义
         写第二遍，而那正是"同一件事有两个真源"的起点。 */
      peerText: String(lastPeer || ''),
      provider: String(speaker.provider || ''),
      model: String(speaker.model || ''),
      speakerName: nameOf(speaker)
    };
  }

  /* ══════════ 一次完整 run：默认交替，可有限连续、让话或结束 ═══════════
     opts: { aId, bId, turns, topic, trigger, initiatorId, force,
             signal (abort signal), initiationSignal (自主发起的社会理由) }
     两个 signal 刻意不同名：`opts.signal` 是本域既有的**中止信号**
     （{aborted:true} 语义），而自主发起的理由与"要不要停下来"是两件事。
     它们曾经共用一个字段名，结果是"reasonCode"被当成 abort signal 读 —— 
     一个既不会报错、又永远不会生效的静默接线错误（测试里表现为
     trace 里没有 initiationSignal，而 prompt 里也没有那段行为背景）。 */
  async function run(opts) {
    opts = opts || {};
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    var trigger = (opts.trigger === 'autonomous') ? 'autonomous' : 'manual';
    /* autonomous 的三道闸门（Phase 3）：
       ① **总开关**（localStorage prefs.autonomous）—— 立即停止产生新的
          autonomous run 的 kill switch。它由设置面板写入，默认 false。
       ② **发起人必须有值**。没有 initiatorId 的 autonomous run 是无主的：
          它无法保证"发起人第一个说"，也就无法与 manual 续聊区分。
          缺这个参数是**调用方的错误**，必须可见地失败，而不是退回
          "谁都行" —— 那正是"她主动发起、对方先说"的来源。
       ③ **canAutonomousRun 再问一次**（角色级 opt-in + 额度 + 冷却 + 退避）。
          为什么必须在这里、而不是只在调用方：本函数是 canonical 公开 API，
          而 §23 的 kill switch 要求"关掉后不再产生新的 run"。调用方
          （role-dm-social.js）在判定与发起之间有 await —— 期间用户可能
          已经关掉了设置。只在调用方检查，等于关掉之后仍会漏出去一次。
          opts.skipAutonomousGate 只给**测试**用：它让守卫本身可以被单独
          验证，而不是在生产路径上留一条绕过它的路。 */
    if (trigger === 'autonomous') {
      if (prefs().autonomous !== true) return { ok: false, reason: 'autonomous-disabled' };
      if (!String(opts.initiatorId || '').trim()) return { ok: false, reason: 'autonomous-no-initiator' };
      if (opts.skipAutonomousGate !== true) {
        var autoGate = canAutonomousRun(opts.aId, opts.bId, nowMs());
        if (!autoGate || autoGate.ok !== true) {
          return {
            ok: false,
            reason: autoGate ? autoGate.reason : 'autonomous-not-permitted',
            blockedBy: (autoGate && autoGate.blockedBy) || null
          };
        }
      }
    }
    var resolved = await resolveThread(opts.aId, opts.bId, { topic: opts.topic });
    if (!resolved.ok) return resolved;
    var thread = resolved.thread;
    var parts = thread.participantIds;
    var friendId = thread.threadId;

    /* ── 守卫 1：per-thread running lock（同一 thread 不允许两个并发 run）── */
    if (_runningThreads[friendId]) return { ok: false, reason: c.REASON.threadBusy, thread: thread };

    /* ── 守卫 2：per-character lock（复用既有全局 _chatSendingFor，因此
       Active Companion / Diary / Voice 能**看见**角色此刻正在私聊并让路）── */
    var held = [];
    var sending = null;
    try { sending = (typeof _chatSendingFor !== 'undefined') ? _chatSendingFor : null; } catch (e) { sending = null; }
    for (var pi = 0; pi < parts.length; pi++) {
      var pid = parts[pi];
      if (sending && sending.has(pid)) {
        for (var ri = 0; ri < held.length; ri++) sending.delete(held[ri]);
        return { ok: false, reason: c.REASON.characterBusy, detail: pid, thread: thread };
      }
      if (sending) { sending.add(pid); held.push(pid); }
    }

    var runId = uid('roledmrun_');
    _runningThreads[friendId] = runId;
    _running = true;
    var startedAt = nowMs();

    /* ── 守卫 3：thread 必须处于 active。
       archived 的唯一来源是"参与者之一被删除"（onCharacterDeleted），因此它同时
       表达"历史保留、但不该再有新对话"。角色若日后被重建，归档状态不自动解除 ——
       解除是明确的用户动作，不是一次隐式回滚。 */
    if (thread.state !== 'active') {
      releaseLocks(friendId, held, sending);
      return { ok: false, reason: c.REASON.missingCharacter, detail: 'thread-archived', thread: thread };
    }

    /* ── 守卫 4：**两个**参与者都必须存在。
       只检查"即将发言的那个"是不够的：那样会出现"一方说了话、另一方根本不在"
       的半截 run（已经落了一条消息，然后以 missing-character 停）。角色私信是
       一对一会话，任何一方不存在，这段会话就**不该开始**。 */
    for (var vi = 0; vi < parts.length; vi++) {
      if (!cfgOf(parts[vi])) {
        releaseLocks(friendId, held, sending);
        return { ok: false, reason: c.REASON.missingCharacter, detail: parts[vi], thread: thread };
      }
    }
    /* ── 守卫 4：同一对角色冷却（防止连点 / 两个标签页互相接力）── */
    var cooldown = c.pairCooldownRemaining(thread.lastRunAt, startedAt);
    if (cooldown > 0 && opts.force !== true) {
      releaseLocks(friendId, held, sending);
      return { ok: false, reason: c.REASON.pairCooldown, remainingMs: cooldown, thread: thread };
    }

    /* Read the existing final speaker streak so the two-message cap also holds across
       run boundaries. A short/incomplete read is treated conservatively when the thread
       already records messages; this adds no stored state or alternate message authority. */
    var priorMessages = await loadMessages(friendId, 2);
    var priorStreak = c.trailingSpeakerStreak(priorMessages);
    if (Number(thread.messageCount) > priorMessages.length && priorMessages.length < 2) {
      priorStreak = { speakerId: priorStreak.speakerId || String(thread.lastTurnRoleId || ''), count: 2 };
    } else if (!priorStreak.speakerId && thread.lastTurnRoleId) {
      priorStreak = { speakerId: String(thread.lastTurnRoleId), count: 2 };
    }

    var maxTurns = c.normalizeTurnBudget(trigger, opts.turns);
    var turnsDone = 0;
    /* P2 budget counts model generations. A P3.2 generation may deliver several
       independent messages, but that never buys another provider call. */
    var modelTurnsDone = 0;
    var replyInitiativeGranted = {};
    var stallCount = 0;
    var produced = [];
    /* Run-local prompt/output calibration counters. These contain only intent enums and
       shape counts; they are returned to the caller and are never persisted or logged. */
    var intentStats = {
      total: 0, parsed: 0, fallback: 0,
      byIntent: { speak: 0, continue_self: 0, yield: 0, end: 0 },
      fallbackReasons: {}
    };
    var promptStats = { total: 0, roleDmBrevity: 0, ordinaryShortFormat: 0, intentContract: 0, finalUserIntentContract: 0, quoteGuidance: 0, messageProtocol: 0 };
    /* Quote telemetry is request/run-local and content-free. Never retain source IDs,
       excerpts, output text, prompts, or credential fields in the calibration summary. */
    var quoteStats = {
      candidateSets: 0, candidateCount: 0, maxCandidatesPerTurn: 0, quoteOptionCount: 0, maxQuoteOptionsPerTurn: 0,
      parseTotal: 0, accepted: 0, noDirective: 0, rejected: 0, coreUnavailable: 0,
      rejectedByReason: {}, applied: 0
    };
    var deliveryStats = {
      generatedTurns: 0, multiMessageTurns: 0, messagesGenerated: 0, messagesDelivered: 0,
      formatFallbacks: 0, formatFallbackReasons: {}, duplicateFiltered: 0, lowInfoFiltered: 0,
      stoppedSequences: 0
    };
    /* 本轮 run 里**出现过的所有文本**（含被判为重复/低信息而丢弃的那些）。
       只用 produced（=已落库）来判重是不够的：第一次重复被丢弃后，第二次的
       比较基准里仍然没有它，于是"同内容对轰"会先漏过一次才熔断。 */
    var seenTexts = [];
    /* M3 软复读观测（bounded、无正文、run-local）。
       它是**对话质量遥测**，不是安全阀，也不是角色世界里的任何事实：
       不进 Memory、不动 Relationship、不写 thread memorandum、不改 prompt。
       形状刻意只有 5 个计数 —— 没有正文、没有共享片段、没有匹配到的句子。 */
    var quality = { analyzed: 0, softRepeatTurns: 0, mirrorTurns: 0, boilerplateTurns: 0, maxAgreementStreak: 0 };
    var providerFailed = false;
    var runError = '';
    var stopReason = null;
    var runTopic = String(opts.topic || thread.topic || '').slice(0, 200);
    var userName = '';
    try { var about = await dbGet('about', 'main'); userName = (about && about.name) || ''; } catch (e) { }

    /* 记录 lastRunAt：立刻落盘，于是并发/重复点击在**这一层**就被冷却挡住，
       而不是等 run 结束（否则连点会同时穿过守卫 1-3）。 */
    var initiatorId = String(opts.initiatorId || '').trim();
    thread.lastRunAt = startedAt;
    thread.runCount = (Number(thread.runCount) || 0) + 1;
    thread.stoppedReason = '';
    thread.lastInitiatedBy = (trigger === 'autonomous') ? initiatorId : '';
    if (runTopic) thread.topic = runTopic;
    threadSave(thread);

    /* 谁先说。autonomous 走 forceInitiator（发起人必须第一个说，见
       role-dm-core 的 chooseFirstSpeaker）；manual 保持既有"接上一个人"。
       返回空字符串只可能是"发起人不在参与者里" —— 那是一次**真实的失败**，
       必须带着原因退出，绝不能退化成"那就让另一个人先说"。 */
    var speakerId = c.chooseFirstSpeaker(thread, initiatorId || parts[0], { forceInitiator: trigger === 'autonomous' });
    if (!speakerId) {
      releaseLocks(friendId, held, sending);
      return { ok: false, reason: 'initiator-not-participant', detail: initiatorId, thread: thread };
    }
    var lastSpeakerId = priorStreak.speakerId;
    var consecutiveSpeakerCount = Number(priorStreak.count) || 0;
    var consecutiveCapBlocked = false;
    if (speakerId === lastSpeakerId && consecutiveSpeakerCount >= 2) {
      if (trigger === 'autonomous' && speakerId === initiatorId) consecutiveCapBlocked = true;
      else speakerId = (parts[0] === speakerId) ? parts[1] : parts[0];
    }
    try {
      for (var t = 0; t < maxTurns; t++) {
        /* ── 守卫 4：abort / 轮数 / 空转熔断 ── */
        if (consecutiveCapBlocked) { stopReason = c.REASON.consecutiveCap; break; }
        if (opts.signal && opts.signal.aborted) { stopReason = c.REASON.aborted; break; }
        var gate = c.canRunMoreTurn({ aborted: !!(opts.signal && opts.signal.aborted), providerFailed: providerFailed, stallCount: stallCount, maxTurns: maxTurns, turnsDone: modelTurnsDone });
        if (!gate.ok) { stopReason = gate.reason; break; }
        /* ── 守卫 5：每角色时/日轮次配额 ── */
        if (!c.roleTurnRoomOk(roleTurnTimes(speakerId), nowMs())) { stopReason = c.REASON.roleDailyCap; break; }
        var peerId = (parts[0] === speakerId) ? parts[1] : parts[0];
        var replyInitiative = trigger === 'manual'
          ? replyInitiativeForTurn(speakerId, trigger, runId, replyInitiativePrefs(speakerId), replyInitiativeGranted)
          : null;

        var turnRes = await runTurn({
          thread: thread,
          speakerId: speakerId,
          peerId: peerId,
          topic: runTopic,
          trigger: trigger,
          replyInitiative: replyInitiative,
          runId: runId,
          /* 自主发起的**社会理由**（闭集 code，不是自由文本）。
             只在真正由本角色发起的那一轮进入 prompt —— 对方的回应不该
             继承"我主动来找你"这个背景。 */
          signal: (trigger === 'autonomous' && speakerId === initiatorId) ? (opts.initiationSignal || null) : null,
          abortSignal: opts.signal || null,
          turnIndex: modelTurnsDone,
          consecutiveSpeakerCount: (lastSpeakerId === speakerId) ? consecutiveSpeakerCount : 0,
          userName: userName,
          historyLimit: HISTORY_LIMIT,
          onQuoteCandidates: function (count, options) {
            var n = Math.max(0, Math.floor(Number(count) || 0));
            var optionCount = Math.max(0, Math.floor(Number(options) || 0));
            quoteStats.candidateSets++;
            quoteStats.candidateCount += n;
            if (n > quoteStats.maxCandidatesPerTurn) quoteStats.maxCandidatesPerTurn = n;
            quoteStats.quoteOptionCount += optionCount;
            if (optionCount > quoteStats.maxQuoteOptionsPerTurn) quoteStats.maxQuoteOptionsPerTurn = optionCount;
          },
          onQuoteParse: function (diagnostic) {
            var d = diagnostic && typeof diagnostic === 'object' ? diagnostic : {};
            var result = String(d.result || 'rejected');
            quoteStats.parseTotal++;
            if (result === 'accepted') quoteStats.accepted++;
            else if (result === 'no-directive') quoteStats.noDirective++;
            else if (result === 'core-unavailable') quoteStats.coreUnavailable++;
            else {
              quoteStats.rejected++;
              var reason = /^(?:bad-json|bad-payload|duplicate-directive|unknown-source|source-id-mismatch|bad-snippet|snippet-not-in-source|wrong-conversation|wrong-thread|parse-error|sequence-fallback|unknown)$/.test(String(d.reason || ''))
                ? String(d.reason) : 'unknown';
              quoteStats.rejectedByReason[reason] = (quoteStats.rejectedByReason[reason] || 0) + 1;
            }
          }
        });

        if (turnRes && turnRes.ok === true) {
          modelTurnsDone++;
          deliveryStats.generatedTurns++;
          var generatedSequence = turnRes.messages && Array.isArray(turnRes.messages) ? turnRes.messages.length : (String(turnRes.text || '').trim() ? 1 : 0);
          deliveryStats.messagesGenerated += generatedSequence;
          if (generatedSequence > 1) deliveryStats.multiMessageTurns++;
          if (turnRes.sequence && turnRes.sequence.formatFallback === true) {
            deliveryStats.formatFallbacks++;
            var formatReason = /^(?:too-many-messages|empty-message|parse-error)$/.test(String(turnRes.sequence.formatReason || ''))
              ? String(turnRes.sequence.formatReason) : 'unknown';
            deliveryStats.formatFallbackReasons[formatReason] = (deliveryStats.formatFallbackReasons[formatReason] || 0) + 1;
          }
        }

        if (turnRes && typeof turnRes.intentParsed === 'boolean') {
          intentStats.total++;
          if (turnRes.intentParsed) intentStats.parsed++;
          else {
            intentStats.fallback++;
            var fallbackReason = String(turnRes.intentParseReason || 'unknown').slice(0, 40);
            intentStats.fallbackReasons[fallbackReason] = (intentStats.fallbackReasons[fallbackReason] || 0) + 1;
          }
          var countedIntent = turnRes.intent || 'speak';
          if (Object.prototype.hasOwnProperty.call(intentStats.byIntent, countedIntent)) {
            intentStats.byIntent[countedIntent]++;
          } else {
            intentStats.byIntent.speak++;
          }
        }
        if (turnRes && turnRes.promptContract) {
          promptStats.total++;
          if (turnRes.promptContract.roleDmBrevity === true) promptStats.roleDmBrevity++;
          if (turnRes.promptContract.ordinaryShortFormat === true) promptStats.ordinaryShortFormat++;
          if (turnRes.promptContract.intentContract === true) promptStats.intentContract++;
          if (turnRes.promptContract.finalUserIntentContract === true) promptStats.finalUserIntentContract++;
          if (turnRes.promptContract.quoteGuidance === true) promptStats.quoteGuidance++;
          if (turnRes.promptContract.messageProtocol === true) promptStats.messageProtocol++;
        }

        /* Stop can arrive while the non-streaming provider call is in flight. Discard its
           returned candidate before any guard, control action, or canonical message write. */
        if (opts.signal && opts.signal.aborted) { stopReason = c.REASON.aborted; break; }

        if (!turnRes.ok) {
          /* 任何失败都**安全停止**：已完成的消息保留、锁释放、原因落盘。
             绝不自动无限 retry（输出类失败的那一次重试已经在 runTurn 里
             有界地用完），也绝不 fallback 到另一个角色的模型。 */
          stopReason = turnRes.reason;
          /* 这一轮的**真实**原因带进 run 结果：run() 的 error 字段本来就是
             "为什么没聊起来"的答案，不带上来，'output-truncated' 与
             'empty-output' 的区分就没有人看得见。 */
          if (turnRes.error) runError = String(turnRes.error).slice(0, 200);
          /* 只有**真的** provider / 配置故障才走这一支。输出类失败
             （output-truncated / empty-output）**不在这里**：模型回过话，
             问题不在 key，因此既不置 providerFailed、也不弹"检查密钥"卡片 ——
             它们已经在上一行如实落进 stopReason，由 UI 按自己的文案解释。 */
          if (turnRes.reason === c.REASON.providerFailed || turnRes.reason === c.REASON.notReady) {
            providerFailed = true;
            /* 角色配置失效：清楚报错（既有用户错误模型），并停止本 run。
               但**只**在确实是配置/鉴权这一类故障时报它 —— 模型真的回过话、
               只是没吐出正文（turnRes.emptyOutput）不是配置问题，
               把它也说成"密钥缺失"会把用户引去改一个没坏的配置。 */
            if (turnRes.emptyOutput !== true) {
              try {
                var cfgX = cfgOf(speakerId);
                var canShow = (window.IBERR && typeof window.IBERR.show === 'function' && typeof window.IBERR.model === 'function');
                if (canShow) window.IBERR.show(window.IBERR.model('auth', { reason: 'missing-key', cfg: cfgX, stage: 'role_dm' }));
              } catch (e) { }
            }
          }
          if (turnRes.reason === c.REASON.missingCharacter) providerFailed = true;
          break;
        }

        var turnIntent = turnRes.intent || 'speak';
        var generatedUnits = turnRes.messages && Array.isArray(turnRes.messages)
          ? turnRes.messages.slice() : (String(turnRes.text || '').trim() ? [{ text: turnRes.text, replyQuote: turnRes.replyQuote || null }] : []);
        if (turnIntent === 'end' && !generatedUnits.length) {
          stopReason = c.REASON.naturalEnd;
          break;
        }
        if (turnIntent === 'yield') {
          stallCount++;
          if (stallCount >= c.STALL_LIMIT) { stopReason = c.REASON.silentStall; break; }
          speakerId = peerId;
          continue; /* A control-only yield consumes this loop attempt but writes no message. */
        }

        /* ── 守卫 6：逐条执行既有低信息与重复过滤。一个 sequence 中的
           被滤单元不会抹掉其余有效消息；整批都被滤掉时沿用旧的让话/熔断语义。 */
        var acceptedUnits = [];
        var unitStopReason = '';
        for (var unitIndex = 0; unitIndex < generatedUnits.length; unitIndex++) {
          var candidateUnit = generatedUnits[unitIndex] || {};
          var unitText = String(candidateUnit.text || '').trim();
          if (!unitText) continue;
          var dup = c.isDuplicateTurn(unitText, seenTexts);
          var lowInfo = c.lowInfoMatch(unitText);
          var contextualShort = lowInfo && c.lowInfoContextuallyMeaningful(unitText, turnRes.peerText || '');
          var repeatedShort = contextualShort && c.isRepeatedLowInfoTurn(unitText, seenTexts);
          if (lowInfo && (!contextualShort || repeatedShort)) {
            deliveryStats.lowInfoFiltered++;
            stallCount++;
            seenTexts.push(unitText);
            if (turnIntent === 'end') { unitStopReason = c.REASON.naturalEnd; break; }
            if (stallCount >= c.STALL_LIMIT) { unitStopReason = 'low-info-stall'; break; }
            continue;
          }
          if (dup.duplicate) {
            deliveryStats.duplicateFiltered++;
            stallCount++;
            seenTexts.push(unitText);
            if (turnIntent === 'end') { unitStopReason = c.REASON.naturalEnd; break; }
            if (stallCount >= c.STALL_LIMIT) { unitStopReason = c.REASON.duplicateStall; break; }
            continue;
          }
          stallCount = 0;
          seenTexts.push(unitText);
          acceptedUnits.push({ text: unitText, replyQuote: candidateUnit.replyQuote || candidateUnit.quote || null,
            expressionRef: candidateUnit.expressionRef || null });
        }
        if (!acceptedUnits.length) {
          if (unitStopReason) { stopReason = unitStopReason; break; }
          if (turnIntent === 'end') { stopReason = c.REASON.naturalEnd; break; }
          speakerId = peerId;
          continue;
        }

        /* ── M3 软复读观测（**只观测，不拦截**）──
           为什么放在两个守卫**之后**：这条信号描述的是"这段对话实际说出口的
           质量"。被 low-info / duplicate 丢弃的那些轮根本没有进入对话，
           也就不在 M3 的口径里 —— 它们各有自己的 authority（low-info guard /
           runaway guard），M3 既不接管也不与它们争。
           为什么输入全部取自本 run 已有的东西：
             · peerText 是这一轮**真的看到**的上一条对方消息（runTurn 里已经
               从 history 取过，只是以前没有带出来）；
             · recentReplies 是**已经落库**的最近两条 —— produced 本来就在，
               M3 不新增任何正文缓存，run 结束即随 run 一起消失，不落盘。
           为什么不改变控制流：M3 判定的是"要不要在下一次**本来就会发生**的
           调用里改口风"，而不是"要不要丢掉这条消息"。这里既不 break 也不
           continue、不碰 stopReason、不重试、不重写 —— 一次 run 的模型调用
           次数因此与 M3 之前**逐字相同**（见测试 AH2 / AH4 / AH9 / AH11）。 */
        try {
          var sq = c.analyzeSoftRepetition(acceptedUnits[0].text, turnRes.peerText || '',
            produced.slice(-2).map(function (p) { return String(p.content); }));
          if (sq) {
            quality.analyzed++;
            if (sq.softRepeat === true) {
              quality.softRepeatTurns++;
              if (sq.kind === 'mirror') quality.mirrorTurns++;
              else if (sq.kind === 'boilerplate') quality.boilerplateTurns++;
            }
            if ((Number(sq.agreementStreak) || 0) > quality.maxAgreementStreak) {
              quality.maxAgreementStreak = Number(sq.agreementStreak) || 0;
            }
          }
        } catch (e) { /* 观测失败绝不改变一次 run 的结果 */ }

        var quotaRecordedForGeneration = false;
        var memoAssignedForGeneration = false;
        var deliveryResult = await deliverRoleDmSequence({
          threadId: friendId,
          runId: runId,
          modelTurnIndex: modelTurnsDone - 1,
          speakerId: speakerId,
          speakerName: turnRes.speakerName,
          signal: opts.signal || null,
          units: acceptedUnits,
          onUnit: async function (unit, sequenceIndex) {
            if (opts.signal && opts.signal.aborted) return { ok: false, reason: c.REASON.aborted };
            var timestamp = nowMs();
            if (timestamp <= (Number(thread.lastMessageAt) || 0)) timestamp = (Number(thread.lastMessageAt) || 0) + 1;
            var msg = c.buildRoleDmMessage({
              friendId: friendId,
              senderId: speakerId,
              recipientId: peerId,
              senderName: turnRes.speakerName,
              content: unit.text,
              timestamp: timestamp,
              trigger: trigger,
              turnIndex: turnsDone,
              runId: runId,
              provider: turnRes.provider,
              model: turnRes.model,
              replyQuote: unit.replyQuote || null
            });
            if (!msg) return { ok: false, reason: 'bad-message' };
            try {
              var expressionPacks = window.IBExpressionPacks;
              if (unit.expressionRef && expressionPacks && typeof expressionPacks.rememberMessageExpression === 'function') {
                expressionPacks.rememberMessageExpression(speakerId, msg.id, unit.expressionRef);
              }
              if (expressionPacks && typeof expressionPacks.rememberMessageText === 'function') {
                expressionPacks.rememberMessageText(speakerId, msg.id, unit.text);
              }
            } catch (expressionRememberError) { }
            /* This remains the canonical commit boundary. Abort cancels queued units;
               a persistence request already in flight is awaited and kept. */
            if (opts.signal && opts.signal.aborted) return { ok: false, reason: c.REASON.aborted };
            var written = await appendMessage(msg);
            if (!written.ok) return { ok: false, reason: written.reason || c.REASON.persistFailed };
            if (msg.metadata && msg.metadata.replyQuote) quoteStats.applied++;
            deliveryStats.messagesDelivered++;
            if (!quotaRecordedForGeneration) {
              roleTurnRecord(speakerId, msg.timestamp);
              quotaRecordedForGeneration = true;
            }
            produced.push({
              roleId: speakerId,
              messageId: msg.id,
              content: unit.text,
              memo: memoAssignedForGeneration ? null : turnRes.memo
            });
            memoAssignedForGeneration = true;
            turnsDone++;
            thread.lastMessageAt = msg.timestamp;
            thread.lastTurnRoleId = speakerId;
            thread.messageCount = (Number(thread.messageCount) || 0) + 1;
            thread.updatedAt = msg.timestamp;
            threadSave(thread);
            try { if (typeof NS.roleDmEmit === 'function') NS.roleDmEmit('turn', { threadId: friendId, messageId: msg.id }); } catch (e) { }
            return { ok: true, id: msg.id, sequenceIndex: sequenceIndex };
          }
        });
        if (!deliveryResult.ok) {
          if (opts.signal && opts.signal.aborted) stopReason = c.REASON.aborted;
          else stopReason = deliveryResult.reason || 'delivery-failed';
          if (deliveryResult.delivered > 0) deliveryStats.stoppedSequences++;
          if (/persist-failed|bad-message/.test(String(stopReason))) providerFailed = true;
          break;
        }
        if (opts.signal && opts.signal.aborted) { stopReason = c.REASON.aborted; break; }
        if (lastSpeakerId === speakerId) consecutiveSpeakerCount = Math.min(2, consecutiveSpeakerCount + 1);
        else { lastSpeakerId = speakerId; consecutiveSpeakerCount = 1; }
        if (unitStopReason) { stopReason = unitStopReason; break; }
        if (turnIntent === 'end') { stopReason = c.REASON.naturalEnd; break; }
        if (turnIntent === 'continue_self' && consecutiveSpeakerCount < 2) speakerId = speakerId;
        else speakerId = peerId;
      }
    } catch (err) {
      stopReason = 'run-error';
      /* 诊断：一次 run 的意外失败必须留下**可回答**的原因（只记 message，
         不含 prompt / 正文 / key）。只吞异常不记原因会让"为什么没聊起来"
         变成一个无法回答的问题（浏览器 smoke 实测踩过）。 */
      runError = String((err && err.message) || err).slice(0, 200);
      try { console.warn('[RoleDM] run failed', runError); } catch (e) { }
    } finally {
      /* 唯一收尾点：任何出口都必须停止、保留已完成消息、释放锁、记录原因。 */
      releaseLocks(friendId, held, sending);
      _running = false;
    }
    if (!stopReason) stopReason = c.REASON.maxTurns;

    /* ── 关系观测：directional + bounded。每个方向各自观测，可以不同。── */
    var relationResult = null;
    try { relationResult = await observeRun(thread, produced, runTopic); } catch (e) { }

    /* ── 记忆边界：有界 episodic 候选 → 既有 consolidation。── */
    var memoryResult = null;
    try { memoryResult = await emitMemories(thread, produced, trigger, modelTurnsDone); } catch (e) { }

    /* ── 层④：跨 run 共同历史的滚动更新 ──
       放在这两个观测之后：它读的是**已经落库**的消息，因此必须等本 run 的
       消息全部写完。失败绝不吞掉整个 run 的结果（已经聊过的内容照常返回），
       但也绝不假装更新过 —— memorandumResult 如实为 null。 */
    var memorandumResult = null;
    try { memorandumResult = await updateMemorandum(thread); } catch (e) { memorandumResult = null; }

    thread.stoppedReason = stopReason;
    thread.updatedAt = nowMs();
    threadSave(thread);

    var calibrationChars = 0, calibrationParagraphs = 0, multiParagraphMessages = 0;
    var shortMessages = 0, sameSpeakerTransitions = 0;
    for (var ci = 0; ci < produced.length; ci++) {
      var calibrationText = String(produced[ci].content || '').trim();
      calibrationChars += calibrationText.length;
      var calibrationParts = calibrationText ? calibrationText.split(/\r?\n\s*\r?\n/).filter(function (part) { return !!String(part || '').trim(); }) : [];
      var paragraphCount = calibrationParts.length;
      calibrationParagraphs += paragraphCount;
      if (paragraphCount > 1) multiParagraphMessages++;
      if (calibrationText.length <= 40) shortMessages++;
      if (ci > 0 && produced[ci - 1].roleId === produced[ci].roleId) sameSpeakerTransitions++;
    }
    var calibrationTransitions = Math.max(0, produced.length - 1);
    var calibration = {
      prompts: promptStats,
      intents: {
        total: intentStats.total,
        parsed: intentStats.parsed,
        fallback: intentStats.fallback,
        parseRate: intentStats.total ? intentStats.parsed / intentStats.total : null,
        byIntent: intentStats.byIntent,
        fallbackReasons: intentStats.fallbackReasons
      },
      messages: {
        count: produced.length,
        avgChars: produced.length ? calibrationChars / produced.length : 0,
        avgParagraphs: produced.length ? calibrationParagraphs / produced.length : 0,
        multiParagraph: multiParagraphMessages,
        shortLe40: shortMessages,
        sameSpeakerTransitions: sameSpeakerTransitions,
        transitions: calibrationTransitions,
        sameSpeakerRate: calibrationTransitions ? sameSpeakerTransitions / calibrationTransitions : 0
      },
      delivery: {
        generatedTurns: deliveryStats.generatedTurns,
        multiMessageTurns: deliveryStats.multiMessageTurns,
        messagesGenerated: deliveryStats.messagesGenerated,
        messagesDelivered: deliveryStats.messagesDelivered,
        formatFallbacks: deliveryStats.formatFallbacks,
        formatFallbackReasons: deliveryStats.formatFallbackReasons,
        duplicateFiltered: deliveryStats.duplicateFiltered,
        lowInfoFiltered: deliveryStats.lowInfoFiltered,
        stoppedSequences: deliveryStats.stoppedSequences
      },
      quotes: {
        candidateSets: quoteStats.candidateSets,
        candidateCount: quoteStats.candidateCount,
        maxCandidatesPerTurn: quoteStats.maxCandidatesPerTurn,
        quoteOptionCount: quoteStats.quoteOptionCount,
        maxQuoteOptionsPerTurn: quoteStats.maxQuoteOptionsPerTurn,
        parseTotal: quoteStats.parseTotal,
        accepted: quoteStats.accepted,
        noDirective: quoteStats.noDirective,
        rejected: quoteStats.rejected,
        coreUnavailable: quoteStats.coreUnavailable,
        rejectedByReason: quoteStats.rejectedByReason,
        applied: quoteStats.applied
      },
      stopReason: stopReason,
      naturalEnd: stopReason === c.REASON.naturalEnd
    };

    var last = produced.length ? produced[produced.length - 1] : null;
    try {
      if (typeof NS.roleDmEmit === 'function') {
        NS.roleDmEmit('run', { threadId: friendId, turns: turnsDone, stopReason: stopReason, runId: runId, memorandum: memorandumResult });
      }
    } catch (e) { }

    return {
      ok: turnsDone > 0,
      runId: runId,
      thread: thread,
      turns: turnsDone,
      modelTurns: modelTurnsDone,
      stopReason: stopReason,
      calibration: calibration,
      /* **实际**第一个说成话的人 —— 不是"计划由谁发起"。
         canonical truth 就是 produced[0]：它只在 appendMessage 成功**之后**
         才 append（同一条消息一旦落库，它的 senderId 就是既定事实；低信息 /
         重复内容在落库**之前**就被丢弃、不进 produced，因此不会被误记）。
         于是没有人需要去**猜**这件事：不读 thread.lastTurnRoleId（它同时被
         manual 与 autonomous 改写，读它等于用状态猜历史），也不复用
         initiatorId（那是"请求由谁发起"，provider 在第一轮就失败时它照样有值，
         而那时一个人都没说出话 —— 两者只有在 autonomous 真的说成了话时
         才恰好相等，那正是本字段要如实区分的差别）。
         没有任何成功消息时是 ''（失败出口一律如此：那些出口在 produced
         还是空的时候就越过了这条 return）。 */
      firstSpeakerId: produced.length ? String(produced[0].roleId) : '',
      /* M3 对话质量观测（§9）：本次 run 有几轮是"软复读"、属于哪一类、
         最长的连续附和次数。**只有计数**：正文、共享片段、匹配到的句子
         一概不留（§19）。analyzed 恒等于 turns —— 每一轮落库的发言都过了
         同一个纯函数；不等就说明有轮次漏掉了观测。 */
      quality: quality,
      messages: produced.map(function (p) { return p.messageId; }),
      lastMessageId: last ? last.messageId : null,
      relation: relationResult,
      memory: memoryResult,
      memorandum: memorandumResult,
      error: runError || null,
      reason: turnsDone > 0 ? null : (stopReason || 'no-turn')
    };
  }

  function releaseLocks(friendId, held, sending) {
    try { delete _runningThreads[friendId]; } catch (e) { }
    for (var i = 0; i < held.length; i++) { try { if (sending) sending.delete(held[i]); } catch (e) { } }
  }

  /* ══════════ 关系观测（有界）═══════════════
     输入 = 本次 run 的真实事实；输出 = 两条有向记录各自的有界增量。
     绝不"每说一句话就永久改人格"：单次 run 的改动被 RELATION_DELTA_CAP 封顶，
     且每个方向只看**那个方向**的发言（于是 A→B 与 B→A 可以不同）。 */
  async function observeRun(thread, produced, topic) {
    var c = core();
    var parts = thread.participantIds;
    if (parts.length !== 2) return null;
    var fromA = produced.filter(function (p) { return p.roleId === parts[0]; });
    var fromB = produced.filter(function (p) { return p.roleId === parts[1]; });
    var out = { a: null, b: null };
    out.a = await observeDirection(parts[0], parts[1], fromA, fromB, produced.length, topic);
    out.b = await observeDirection(parts[1], parts[0], fromB, fromA, produced.length, topic);
    return out;
  }
  async function observeDirection(fromId, toId, mine, theirs, turns, topic) {
    var c = core();
    if (!turns) return null;
    var rel = relationGet(fromId, toId);
    if (!rel) return null;
    var texts = mine.map(function (p) { return p.content; });
    var tones = c.toneCounts(texts);
    var delta = c.relationDelta({
      turns: turns,
      positive: tones.positive,
      negative: tones.negative,
      initiatorId: fromId,
      responderId: toId
    });
    var before = { trust: rel.trust, familiarity: rel.familiarity, affinity: rel.affinity };
    rel = c.applyRelationDelta(rel, delta);
    rel.dmCount = (Number(rel.dmCount) || 0) + 1;
    rel.lastDmAt = nowMs();
    rel.updatedAt = rel.lastDmAt;
    /* 观测环形缓冲：只留**事实**（轮数/基调计数/时间/thread），绝不留正文。 */
    rel.observations.push({
      at: rel.lastDmAt,
      threadId: threadIdOfSafe(fromId, toId),
      turns: turns,
      spoke: mine.length,
      positive: tones.positive,
      negative: tones.negative,
      topic: String(topic || '').slice(0, 40),
      delta: delta
    });
    rel.observations = rel.observations.slice(-(c.OBSERVATION_KEEP));
    relationSave(rel);
    return { fromId: fromId, toId: toId, before: before, after: { trust: rel.trust, familiarity: rel.familiarity, affinity: rel.affinity }, delta: delta };
  }
  function threadIdOfSafe(a, b) { var c = core(); return c ? c.roleDmFriendId(a, b) : ''; }

  /* ══════════ 层④ 的滚动更新（每个 run 结束时判定一次）═══════════════
     硬要求：**绝不**每个 run 固定多调一次模型。本函数只做三件事：
       ① 读全量 thread 消息（真相始终是消息行本身，索引只是派生）
       ② 交给 core 的纯函数决定"这次该不该折叠"（阈值 + watermark）
       ③ 该折叠才写回 thread 记录（沿用同一个 threadSave）
     生成器是**确定性抽取**（core.memorandumFoldLines），因此
     "普通短 run 的额外 summary 调用数"恒为 0 —— 这不是"暂时还没做"，
     而是本阶段的生成方式本身不需要模型调用。

     返回的形状就是 §16 要求的可观测性字段（不含备忘正文）。 */
  async function updateMemorandum(thread) {
    var c = core();
    if (!c || !thread || typeof c.foldMemorandum !== 'function') {
      return {
        present: false, chars: 0, coveredMessages: 0, updated: false,
        reason: 'core-unavailable', folded: 0, producer: 'deterministic', summaryCalls: 0
      };
    }
    var messages = await loadMessages(thread.threadId, 0);
    var res = c.foldMemorandum({
      memo: thread.threadMemorandum,
      messages: messages,
      /* 最近窗口**必须**和 runTurn 用的是同一个数 —— 否则备忘会开始
         覆盖模型本来就能读到的原文，"不重复"这个保证就没了。 */
      recentLimit: HISTORY_LIMIT,
      nameOf: function (id, m) {
        var sn = m ? sanitizeName(String(m.senderName || '')) : '';
        if (sn) return sn;
        return nameOf(cfgOf(id));
      },
      now: nowMs()
    });
    if (res.changed && res.memo) {
      thread.threadMemorandum = res.memo;
      thread.updatedAt = nowMs();
      threadSave(thread);
    }
    var memo = res.memo || null;
    return {
      present: !!memo,
      chars: memo ? String(memo.text || '').length : 0,
      coveredMessages: memo ? Number(memo.sourceMessageCount) || 0 : 0,
      updated: !!res.changed,
      reason: String(res.reason || ''),
      folded: Number(res.folded) || 0,
      producer: 'deterministic',
      /* 确定性生成 → 恒 0。写死 0 是一个**可断言的事实**（测试断言
         "一个 run 的模型调用次数 === 轮数"），不是占位符：将来若引入
         模型摘要（方案 C），这里必须换成真实计数，那条断言会立刻变红。 */
      summaryCalls: 0
    };
  }

  /* ══════════ 记忆边界 ═══════════════
     硬要求：**禁止**每条 Role DM → 双方长期记忆。
     做法：一个 run 结束后，每个参与者**最多**贡献 1 条 episodic 记忆，
     且必须同时满足：run 达到最小轮数、模型确实给出了记忆候选、importance 达阈值。
     写入用既有 canonical 构造器 quickCreateMemory（visibility='only' +
     visibleTo=[自己]），因此：
       · 只有该角色自己能召回（读边界与注入边界同源）；
       · kind='episodic' → 进入既有 Memory Consolidation（episodic→semantic）；
       · provenance 指向 thread（不指向消息正文）—— 删除 raw history **不会**
         也不假装会级联删除已固化的长期记忆，UI 如实说明这一点。 */
  async function emitMemories(thread, produced, trigger, modelTurnCount) {
    var c = core();
    if (!produced.length) return { written: 0, skipped: 'no-productions' };
    var parts = thread.participantIds;
    var written = 0;
    var writtenByRole = {};
    var details = [];
    for (var i = 0; i < parts.length; i++) {
      var roleId = parts[i];
      /* 每 run **每人**最多一条候选（不是全场一条）：A 与 B 各自是自己的记忆所有者，
         各自形成自己的理解。用"本次 run 已为该角色写入的条数"计数，绝不按消息条数放大。 */
      if (!c.memoryBudgetOk(writtenByRole[roleId] || 0)) { details.push({ roleId: roleId, skipped: 'run-budget' }); continue; }
      var mine = produced.filter(function (p) { return p.roleId === roleId; });
      var memos = mine.filter(function (p) { return p.memo && p.memo.content; });
      if (!memos.length) { details.push({ roleId: roleId, skipped: 'no-memo' }); continue; }
      /* 一次 run 内该角色可能给了多条候选：只取 importance 最高的一条。 */
      memos.sort(function (x, y) { return (Number(y.memo.importance) || 0) - (Number(x.memo.importance) || 0); });
      var chosen = memos[0].memo;
      var allowed = c.memoryCandidateAllowed({
        /* Three bubbles from one generation still count as one Role DM turn for
           the existing Memory threshold; batching cannot manufacture eligibility. */
        turns: Number(modelTurnCount) || 0,
        stallCount: 0,
        importance: Number(chosen.importance) || 0,
        content: chosen.content
      });
      if (!allowed.ok) { details.push({ roleId: roleId, skipped: allowed.reason }); continue; }
      var cfg = cfgOf(roleId);
      if (!cfg) { details.push({ roleId: roleId, skipped: 'missing-character' }); continue; }
      var peerCfg = cfgOf(parts[0] === roleId ? parts[1] : parts[0]);
      var ok = false;
      try {
        if (typeof quickCreateMemory === 'function') {
          var newId = await quickCreateMemory({
            title: ('和' + nameOf(peerCfg) + '的私聊').slice(0, 24),
            summary: String(chosen.content).slice(0, 80),
            content: String(chosen.content).slice(0, 300),
            source: 'role_dm',
            /* provenance = thread（不是消息正文）。 */
            sourceId: thread.threadId,
            domain: '日常',
            tags: ['role_dm'],
            valence: 0.5,
            arousal: 0.4,
            importance: Math.max(0, Math.min(10, Number(chosen.importance) || 0)),
            resolved: false,
            /* visibility='only' + visibleTo=[自己]：只有本角色能召回。
               private 会让角色自己也召回不到（既有语义），因此不能用 private。 */
            visibility: 'only',
            visibleTo: [String(roleId)],
            excludeFrom: [],
            createdBy: String(roleId),
            createdByName: nameOf(cfg),
            kind: 'episodic',
            consolidatedFrom: [],
            lastConsolidatedAt: null
          });
          ok = !!newId;
        }
      } catch (e) { ok = false; }
      if (ok) { written++; writtenByRole[roleId] = (writtenByRole[roleId] || 0) + 1; details.push({ roleId: roleId, written: true }); }
      else { details.push({ roleId: roleId, skipped: 'write-failed' }); }
    }
    return { written: written, details: details, trigger: trigger };
  }

  /* ══════════ 删除 / 清空语义 ═══════════════
     两个动作**语义明确、互不假装**：
       clearThread(friendId) —— 清空聊天记录：删掉该 thread 的**消息**，
                                以及由它们派生的 thread memorandum（层④），
                                保留 thread 身份与 directional 关系状态。
       deleteThread(friendId) —— 删除整个私聊：消息 + 备忘 + thread 索引记录一起删。
     **两者都不级联删除已固化的长期记忆**：本仓库没有 provenance-safe 的
     记忆级联删除（记忆的 provenance 只到 thread 粒度，且 consolidation 已把
     episodic 归纳成 semantic，来源可能已被合并/改写）。UI 必须如实说明，
     绝不提供"删除私聊 = 忘记一切"的假按钮。

     注意"派生物"与"已固化记忆"的区别，这正是两条不同规则的来源：
       · thread memorandum 是这条私聊 raw history 的**派生物**（它的输入只有
         这条 thread 的消息）→ 清空原文就必须一起清掉，否则会出现
         "记录清空了、但两个人还记得"的残留；
       · 角色 private Memory 是**已经独立固化**的长期记忆（收件人是单个角色，
         生命周期与这条 thread 无关）→ 不级联删除，也不假装能删。 */
  async function clearThread(friendId) {
    var c = core();
    var fid = String(friendId);
    var msgs = await loadMessages(fid);
    var n = 0, failed = 0;
    for (var i = 0; i < msgs.length; i++) {
      try { await dbDelete('chatMessages', msgs[i].id); n++; }
      catch (e) { failed++; }
    }
    var rec = threadGet(fid);
    if (rec && !failed) {
      rec.messageCount = 0;
      rec.lastMessageAt = 0;
      rec.lastTurnRoleId = '';
      /* The topic hint is thread-local short-term context too; an empty thread
         must not carry it into a later conversation after the user clears history. */
      rec.topic = '';
      /* 层④ 的备忘是 raw history 的**派生物**，因此必须与它同生共死：
         留着它等于"清空了聊天记录，但两个角色仍然记得聊过什么" ——
         那不是清空，那是一个用户无法察觉的残留。
         （刻意用 delete 而不是写 null：没有备忘的 thread 记录与加这一层
           之前逐字节相同，导入/导出与既有断言都不受影响。） */
      delete rec.threadMemorandum;
      /* 清空聊天记录开始一个新的空 Scene：旧标题、标签和播放偏好随历史一起清掉。 */
      rec.scene = {
        title: '', tags: [], createdAt: nowMs(),
        playback: { voiceMode: 'auto', textPacing: 'natural' }
      };
      rec.updatedAt = nowMs();
      threadSave(rec);
    }
    return { ok: failed === 0, removed: n, failed: failed, memorandumCleared: !failed, memoryUntouched: true };
  }
  async function deleteThread(friendId) {
    var fid = String(friendId);
    var res = await clearThread(fid);
    var list = threadsAll().filter(function (t) { return t.threadId !== fid; });
    threadsSave(list);
    /* 关系状态**刻意保留**：关系不是这段聊天记录的属性，它是两个角色之间的
       事实；删掉聊天不会让"你们彼此怎么看对方"归零。UI 入口另行提供。 */
    return { ok: res.ok, removedMessages: res.removed, failed: res.failed, memorandumCleared: res.memorandumCleared, relationKept: true, memoryUntouched: true };
  }
  /* 角色被删除时的 thread 处理：参与者缺失 → thread 进入 archived（历史保留、
     不可再启动 run），并如实标注哪一侧缺失。绝不静默删除用户的历史。 */
  async function onCharacterDeleted(roleId) {
    var c = core();
    var rid = String(roleId);
    var list = threadsAll();
    var touched = 0, clearedRelations = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].participantIds.indexOf(rid) < 0) continue;
      list[i].state = 'archived';
      list[i].updatedAt = nowMs();
      touched++;
    }
    if (touched) threadsSave(list);
    /* 指向已删除角色的 directional 关系记录：删除（那个方向的主语已不存在）。
       对方→被删角色的记录同理删除。 */
    var rels = relationsAll();
    var keep = {};
    var changed = false;
    for (var k in rels) {
      if (!Object.prototype.hasOwnProperty.call(rels, k)) continue;
      if (rels[k].fromId === rid || rels[k].toId === rid) { changed = true; clearedRelations++; continue; }
      keep[k] = rels[k];
    }
    if (changed) writeJSON(KEY_RELATIONS, { v: INDEX_VERSION, items: keep, updatedAt: nowMs() });
    /* 该角色的轮次账本一并清掉（它已不再存在）。 */
    var led = ledgerAll();
    if (led[rid]) { delete led[rid]; writeJSON(KEY_LEDGER, led); }
    return { ok: true, threads: touched, relations: clearedRelations };
  }

  /* ══════════ canonical trigger API（Active Companion 的调度消费者调用）═══
     这是本域**唯一**给自动调度预留的接缝。scheduler 只调用它，
     绝不碰 DOM（UI 层的渲染由 roleDmEmit 事件驱动）。 */
  /* 自主预算的判定实现由 Social 层注入（role-dm-social.js）。
     **为什么是注入而不是 require**：role-dm.js 是本域的执行层，先于
     Social 层加载；如果它直接依赖 Social 层，那么"执行域能不能起来"
     就取决于"社交层有没有起来"。注入让依赖方向是单向的：
       Social（决定要不要找谁）→ Role DM（真正聊）
     而 Role DM 只提供接口，不知道谁在调它。
     未注入时 canAutonomousRun 仍然完整可用（它自己那几条闸门照常生效），
     只是没有自主额度这一层 —— 而 autonomous 的**总开关**在 run() 里，
     所以"没有注入"绝不等于"可以偷偷跑"。 */
  var _autoBudgetCheck = null;
  function setAutonomousBudgetChecker(fn) {
    _autoBudgetCheck = (typeof fn === 'function') ? fn : null;
    return true;
  }
  function canAutonomousRun(aId, bId, now) {
    var c = core();
    if (!c) return { ok: false, reason: 'core-unavailable' };
    /* ① 全局 kill switch。 */
    if (prefs().autonomous !== true) return { ok: false, reason: 'autonomous-disabled' };
    /* ② 角色级 opt-in（缺字段 ⇒ 关闭，绝不因升级而变 true）+ 自主额度。 */
    if (_autoBudgetCheck) {
      var gate = null;
      try { gate = _autoBudgetCheck(String(aId), String(bId), Number(now) || nowMs()); } catch (e) { gate = null; }
      if (gate && gate.ok === false) return { ok: false, reason: gate.reason || 'autonomous-not-permitted', blockedBy: gate.blockedBy || null };
    }
    /* ③ thread 状态与 pair 冷却（既有语义，未改动）。 */
    var resolved = threadGet(c.roleDmFriendId(aId, bId));
    if (resolved) {
      var cd = c.pairCooldownRemaining(resolved.lastRunAt, Number(now) || nowMs());
      if (cd > 0) return { ok: false, reason: c.REASON.pairCooldown, remainingMs: cd };
      if (resolved.state === 'archived') return { ok: false, reason: 'thread-archived' };
    }
    /* ④ 该角色的**共享**轮次额度（manual 与 autonomous 共用）——
       这一条是成本护栏，不是自主预算。 */
    if (!c.roleTurnRoomOk(roleTurnTimes(aId), now)) return { ok: false, reason: c.REASON.roleDailyCap };
    return { ok: true };
  }
  function start(aId, bId, options) {
    /* 手动 run 同时也是"用户此刻在跟角色互动"的证据：自主调度据此避让。 */
    noteUserActivity(nowMs());
    return run(Object.assign({ aId: aId, bId: bId, trigger: 'manual' }, options || {}));
  }
  function startAutonomous(aId, bId, options) {
    var o = options || {};
    /* 发起人**必须**由调用方显式给出。
       刻意不提供 aId 之类的默认值：一个静默的默认值会让"忘了传发起人"这个
       调用方错误变成一次看起来正常的 run，而它的第一条发言者是谁取决于
       参数顺序 —— 那正是 §20 要禁止的模糊性。
       唯一可接受的默认**只**发生在没有 options 对象的简写调用上
       （startAutonomous(a, b)：a 是唯一能表达"谁主动"的位置）；
       一旦调用方给了 options，"我以为它会默认用 aId"就不再是理由。 */
    var hasOptions = (options && typeof options === 'object');
    return run(Object.assign({ aId: aId, bId: bId, trigger: 'autonomous' }, hasOptions ? options : {}, {
      initiatorId: hasOptions ? String(o.initiatorId || '') : String(aId || '')
    }));
  }
  /* 手动 run 也记一次"用户最近活动"：自主调度据此避让
     （用户刚跟某个角色聊完，不该立刻由另一个角色自主发起来打扰）。 */
  function noteUserActivity(at) {
    try {
      if (NS.roleDmSocial && typeof NS.roleDmSocial.noteUserActivity === 'function') {
        NS.roleDmSocial.noteUserActivity(at);
      }
    } catch (e) { }
  }

  /* ══════════ 对外只读视图（UI / 测试共用）═══════════════ */
  async function listThreads() {
    var c = core();
    var list = threadsAll();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var msgs = await loadMessages(t.threadId, 0);
      var last = msgs.length ? msgs[msgs.length - 1] : null;
      var md = (last && last.metadata) || {};
      var aCfg = cfgOf(t.participantIds[0]);
      var bCfg = cfgOf(t.participantIds[1]);
      out.push({
        threadId: t.threadId,
        participantIds: t.participantIds.slice(),
        participants: [
          { id: t.participantIds[0], name: nameOf(aCfg), missing: !aCfg },
          { id: t.participantIds[1], name: nameOf(bCfg), missing: !bCfg }
        ],
        state: t.state,
        scene: sceneMetadataView(t),
        createdAt: t.createdAt,
        lastMessageAt: t.lastMessageAt,
        messageCount: msgs.length,
        lastPreview: last ? String(last.content || '').slice(0, 60) : '',
        lastSpeakerId: String(md.senderId || ''),
        /* 谁主动发起的（'' = 手动 / 从未）。UI 用它显示"XX 主动发起"。
           只暴露角色 id，不暴露任何工程数据。 */
        lastInitiatedBy: String(t.lastInitiatedBy || ''),
        running: !!_runningThreads[t.threadId],
        ready: !!(aCfg && bCfg && apiReady(aCfg) && apiReady(bCfg) && t.state === 'active')
      });
    }
    out.sort(function (x, y) { return (y.lastMessageAt || y.createdAt) - (x.lastMessageAt || x.createdAt); });
    return out;
  }
  async function threadDetail(friendId) {
    var c = core();
    var rec = threadGet(friendId);
    if (!rec) return null;
    var msgs = await loadMessages(friendId, 0);
    var aCfg = cfgOf(rec.participantIds[0]);
    var bCfg = cfgOf(rec.participantIds[1]);
    return {
      thread: rec,
      scene: sceneMetadataView(rec),
      messages: msgs.map(function (m) {
        var md = m.metadata || {};
        return {
          id: m.id,
          senderId: String(md.senderId || ''),
          recipientId: String(md.recipientId || ''),
          friendId: String(m.friendId || friendId),
          threadId: String(md.threadId || m.friendId || friendId),
          senderName: String(m.senderName || nameOf(cfgOf(md.senderId))),
          content: String(m.content || ''),
          withdrawn: m.withdrawn === true,
          replyQuote: (function () {
            var q = md.replyQuote;
            if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
            return {
              version: Number(q.version) || 0,
              sourceMessageId: String(q.sourceMessageId || ''),
              sourceSenderKey: String(q.sourceSenderKey || ''),
              snippet: typeof q.snippet === 'string' ? q.snippet : '',
              mode: String(q.mode || '')
            };
          })(),
          timestamp: Number(m.timestamp) || 0,
          provider: String(md.provider || ''),
          model: String(md.model || ''),
          trigger: String(md.trigger || ''),
          turnIndex: Number(md.turnIndex) || 0
        };
      }),
      participants: [
        { id: rec.participantIds[0], name: nameOf(aCfg), missing: !aCfg, ready: !!aCfg && apiReady(aCfg), provider: String((aCfg && aCfg.provider) || ''), model: String((aCfg && aCfg.model) || '') },
        { id: rec.participantIds[1], name: nameOf(bCfg), missing: !bCfg, ready: !!bCfg && apiReady(bCfg), provider: String((bCfg && bCfg.provider) || ''), model: String((bCfg && bCfg.model) || '') }
      ],
      relations: [
        relationGet(rec.participantIds[0], rec.participantIds[1]),
        relationGet(rec.participantIds[1], rec.participantIds[0])
      ],
      running: !!_runningThreads[friendId],
      stopReason: rec.stoppedReason
    };
  }
  function listCharacters() {
    var out = [];
    var a = apiConfigsLive();
    for (var i = 0; i < a.length; i++) {
      if (!a[i] || !a[i].id) continue;
      out.push({ id: String(a[i].id), name: nameOf(a[i]), provider: String(a[i].provider || ''), model: String(a[i].model || ''), ready: apiReady(a[i]) });
    }
    return out;
  }
  function isRunning(friendId) {
    if (friendId) return !!_runningThreads[String(friendId)];
    return !!_running;
  }

  NS.roleDm = {
    /* 生命周期 / 索引 */
    resolveThread: resolveThread,
    updateSceneMetadata: updateSceneMetadata,
    exportSceneData: exportSceneData,
    importSceneData: importSceneData,
    rebuildThreadIndex: rebuildThreadIndex,
    listThreads: listThreads,
    threadDetail: threadDetail,
    listCharacters: listCharacters,
    isRunning: isRunning,
    prefs: prefs,
    setPrefs: setPrefs,
    replyInitiativePrefs: replyInitiativePrefs,
    setReplyInitiativePrefs: setReplyInitiativePrefs,
    /* 执行 */
    start: start,
    startAutonomous: startAutonomous,
    canAutonomousRun: canAutonomousRun,
    setAutonomousBudgetChecker: setAutonomousBudgetChecker,
    noteUserActivity: noteUserActivity,
    run: run,
    /* 维护 */
    clearThread: clearThread,
    deleteThread: deleteThread,
    onCharacterDeleted: onCharacterDeleted,
    /* 关系 */
    relationGet: relationGet,
    relationsAll: relationsAll,
    /* 只读内部（测试 / 诊断） */
    _threadsAll: threadsAll,
    _loadMessages: loadMessages,
    _composeSide: composeSide,
    _replyInitiativeOpportunity: replyInitiativeOpportunity,
    _replyInitiativeForTurn: replyInitiativeForTurn,
    /* 层④（跨 run 共同历史）：投影边界 + 滚动更新 + 只读读取。 */
    _memorandumForPrompt: memorandumForPrompt,
    _updateMemorandum: updateMemorandum,
    _threadMemorandum: function (friendId) {
      var rec = threadGet(String(friendId));
      return (rec && rec.threadMemorandum) ? rec.threadMemorandum : null;
    },
    _keys: { threads: KEY_THREADS, relations: KEY_RELATIONS, ledger: KEY_LEDGER, prefs: KEY_PREFS,
      replyInitiative: KEY_REPLY_INITIATIVE, indexVersion: INDEX_VERSION }
  };
  NS.expose('roleDm', NS.roleDm);
})(window.IB || (window.IB = {}));
