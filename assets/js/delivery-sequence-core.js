/* ====================================================================
   IB Delivery Sequence Core — 「一次模型回合 → N 条 canonical chatMessage」的**唯一**契约
   (P23 Phase 2A · UMD dual-load)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/delivery-sequence-core.js"> → window.IBDeliverySequence
   - Node   : require('../assets/js/delivery-sequence-core.js')（测试与 Home Node 用）
   - 规则：零 window / 零 DOM / 零 fetch / 零 IndexedDB / 零 provider 判定 /
     零 TTS / 零定时器 / 零时钟读取。本文件是**纯模块**。

   唯一职责（Phase 2A §3 / §14）：
     ① 定义「上层给出的一个 sequence」是什么 —— validate(sequence)
     ② 把 sequence **确定性地**构造成 canonical chatMessages[] —— buildMessages()
     ③ 定义一段 conversation 的**确定性顺序** —— orderMessages() / compareMessages()

   本文件**不做**（Phase 2A 明令禁止、属后续阶段）：
     AI 自动拆句 / Delivery Planner / Middle Brain 决定 kind / 人工延迟 / typing
     timing / 逐条定时发送 / emotion planner / prompt 注入 / streaming 交付 /
     Voicebox streaming / 生图 planner。它只回答「给定了 sequence 之后，数据长什么样」。

   ── 为什么是「N 条独立消息」而不是「一条 parent 内嵌 segments」──
   依据是**当前源码的消费面**（Phase 0 audit，见 docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md）：
     · chatMessages 的 91 个读取点全部**逐条**消费（context 映射 / memory / search /
       export / calendar / summary / mobile DTO / 撤回 / 删除）。没有一条读取点认识
       「一条消息里还有若干 delivery unit」这种结构。
     · 撤回（communication.js:_chatWithdrawMsg）、删除（deleteSingleMsg）、播放
       （_ibAiVoicePayload）、收藏（favorites，sourceId = message id）全部以
       **message id** 为单位。把 unit 塞进一条消息里，这四处全部需要新的第二套语义。
     · 生产里**已经存在**两个「一次模型回合产出多条 assistant 消息」的既成事实：
       waifu 多段呈现（MessagePresentation → 逐条 dbPut）与工具续轮
       （communication.js:_wsToolContinue → 追加 dbPut）。契约必须描述**它们已经在做的事**，
       而不是另造一个平行世界。
   因此：一个 delivery unit = 一条真正独立的 canonical chatMessage（不变量 1），
   多条消息通过 metadata 里的**回合身份**关联（不变量 3/4）。

   ── 回合身份为什么放在 metadata ──
   chat-core 的 canonical 字段表里，metadata 已经是「跨消息的每消息注解」的家：
   M1 的 activityId 正是同一个概念 —— 同一宿主回合的 user 与 assistant 共享
   `metadata.activityId`（communication.js:2516 / 2864）。回合身份沿用同一位置，
   于是：
     · 不需要新顶层字段（KNOWN_FIELDS 不变，canonicalize 不会把它报成 schema 漂移）；
     · 不需要 DB migration（metadata 本来就是 canonical conditional 字段；Home Node 的
       payload_json 是 canonicalize 的输出，未知键原样往返 —— 见
       services/home-node/chat-store.js:evaluateWrite / test_chat_core_contract 的往返断言）；
     · 旧消息没有任何一个新键，行为逐字不变（不变量 10）。
   三个键（都在 metadata 里）：
     turnId          —— **同一次模型生成**的稳定身份（同一回合的每条消息逐字相同）
     sequenceIndex   —— 本回合内的确定性序号（0 起，连续）
     sequenceTotal   —— advisory（生产端知道时给出）。读取方**必须**以消息集合为准
                        （按 turnId 计数），绝不信任这个数：工具续轮在写第一条消息时
                        还不知道本回合最终会有几条。

   ── 排序为什么需要它 ──
   生产实测：工具续轮的消息比主回复**先落库**，而主回复用的是更晚的 Date.now() ——
   于是「只按 timestamp 排序」在 reload 后会把主回复排到续轮**下面**（真实缺陷）。
   同毫秒的多条消息同理没有稳定判据。因此顺序必须是**回合内按 sequenceIndex、
   回合整体落在它最早一条的位置**（orderMessages），而不是靠伪造时间差。
   orderMessages 对**没有**回合键的旧消息退化为 (timestamp, id)：其中 id 只是
   确定性兜底 —— IndexedDB 的 getAll/byFriend 本来就按 key(=id) 升序返回，
   这一步把"引擎碰巧给的顺序"变成契约里写明的顺序。

   安全边界（不变量 9）：sequence 输入里任何一层出现凭据形状的键或值
   （apiKey / token / secret / authorization / Bearer … / sk-…）⇒ 整批**不产出**
   （fail closed）。这里绝不"清洗后照写"，因为一条消息一旦落库就已经是事实。
   voice 的 provenance 清洗复用 voice-message-core（Phase 1 冻结契约），
   本文件不建立第二套 voice schema（不变量 7）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./chat-core.js'), require('./voice-message-core.js'));
  } else {
    root.IBDeliverySequence = factory(root.IBChatCore, root.IBVoiceMessage);
  }
})(typeof self !== 'undefined' ? self : this, function (CHAT_CORE, VOICE) {
  'use strict';

  /* ── 契约常量（唯一真源）────────────────────────────────────────── */
  var TURN_ID = 'turnId';
  var SEQUENCE_INDEX = 'sequenceIndex';
  var SEQUENCE_TOTAL = 'sequenceTotal';
  var SEQUENCE_META_KEYS = [TURN_ID, SEQUENCE_INDEX, SEQUENCE_TOTAL];

  /* 本阶段**正式支持**的 delivery unit 种类。 */
  var SUPPORTED_KINDS = ['text', 'voice'];
  /* 只**登记**、不实现的种类：image 的 planner 属后续阶段（Phase 2A §3）。
     登记在这里是为了让"它必须走同一条契约"这件事可被断言，而不是留一句口头承诺。 */
  var RESERVED_KINDS = ['image'];

  /* 单回合单元数上限。取值沿用既有 MessagePresentation 的段数上限量级（60），
     不新发明数字：一个回合拆到 60 条以上已经不再是"呈现"，而是故障。 */
  var MAX_UNITS = 60;

  /* id 熵位数：6 位十进制（= 1e-6 同毫秒同序号碰撞概率），严格优于既有生产写入点的
     Math.random()*100000（1e-5）。形状与 chat-core 的 ID_SHAPES.assistantPart
     （'msg_<ms>_<rand>_<i>'）逐字同族，因此 isKnownMessageId 直接承认它。 */
  var ID_ENTROPY_MOD = 1000000;
  /* 序号补零位数。为什么必须补零、且熵部分**只由 turnId 决定**（不含 index）：
       存储层的自然顺序就是 **id 升序**（IndexedDB 的 getAll/byFriend 按 key=id 返回）。
       只要同一回合的 id 形如 `msg_<ts>_<同一段熵>_<补零的序号>`，"按 id 升序"
       就与"按 sequenceIndex 升序"**逐字同序** —— 于是任何没有调用 orderMessages 的
       读取点（跨阶段冻结的 social.js、测试 harness、未来的消费者）拿到的顺序也是对的。
       这是 P23 2B 的浏览器端到端实测逼出来的：waifu 多段在 dbGetAll 顺序下曾经乱序
       （同一 timestamp + 每 index 不同的随机熵）。 */
  var ID_INDEX_PAD = 3;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return v == null ? '' : String(v); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function posInt(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.floor(n) : 0; }
  function idOrder(a, b) { var x = str(a), y = str(b); return x < y ? -1 : (x > y ? 1 : 0); }

  /* ── 回合身份 ──────────────────────────────────────────────────────
     turnIdFor(seed) = 由调用方给出的**种子**（通常是触发本回合的 user message id）
     派生出的确定性回合 id。它不是 message id，不进 chat-core 的 id 形状表；
     唯一要求是"同一回合的所有消息逐字相同 + 不同回合不相同"。 */
  function turnIdFor(seed) {
    var s = str(seed);
    if (!s) return '';
    var token = (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function')
      ? CHAT_CORE.stableToken(s) : '';
    if (!token) return '';
    return 'turn_' + token;
  }

  /* 一条已存消息的回合身份（无 → ''）。绝不从内容/时间猜。 */
  function turnIdOf(message) {
    if (!isObject(message)) return '';
    var md = message.metadata;
    if (!isObject(md)) return '';
    return str(md[TURN_ID]);
  }

  /* 本回合内的序号。缺失 → 0（"本回合唯一的一条"）；非法值 → 0。 */
  function sequenceIndexOf(message) {
    if (!isObject(message)) return 0;
    var md = message.metadata;
    if (!isObject(md)) return 0;
    var n = num(md[SEQUENCE_INDEX]);
    return (isFinite(n) && n >= 0) ? Math.floor(n) : 0;
  }

  /* 是否属于一个「多单元回合」（同 turnId 的消息多于一条）。纯函数、只看集合。 */
  function turnUnitCount(messages, turnId) {
    var t = str(turnId);
    var list = Array.isArray(messages) ? messages : [];
    if (!t) return 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) if (turnIdOf(list[i]) === t) n++;
    return n;
  }
  function isSequenceMember(message, messages) {
    var t = turnIdOf(message);
    if (!t) return false;
    return turnUnitCount(messages, t) > 1;
  }

  /* ── message id：确定性、形状与既有多段形状同族 ────────────────────
     id 由 (turnId, index, timestamp) 唯一决定 —— 同一个 sequence 构造两次得到
     逐字相同的 id，于是"重放同一个 sequence"在 Home Node 上落到同一条记录
     （chat-store 的 id 级幂等：identical → skipped），不会写第二遍。 */
  function messageIdFor(turnId, index, timestamp) {
    var token = (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function')
      ? CHAT_CORE.stableToken(str(turnId)) : '';
    var n = token ? (parseInt(token.slice(0, 8), 36) % ID_ENTROPY_MOD) : 0;
    if (!isFinite(n) || n < 0) n = 0;
    var pad = ('000000' + n).slice(-6);
    var idx = Math.max(0, Math.floor(Number(index) || 0));
    var idxs = String(idx);
    while (idxs.length < ID_INDEX_PAD) idxs = '0' + idxs;
    return 'msg_' + posInt(timestamp) + '_' + pad + '_' + idxs;
  }

  /* ── validate：sequence 输入契约 ───────────────────────────────────
     输入（概念形状，字段名即契约）：
       {
         turnId: 'turn_xxx',                 // 必须；本回合的稳定身份
         units: [                            // 必须；1..MAX_UNITS 条
           { kind:'text',  text:'…' },
           { kind:'voice', text:'文字稿', dataUrl?/audioUrl?, mime?, duration?, provenance? }
         ]
       }
     返回 { ok, errors[], units[], dropped[] }：
       · errors 用**稳定词表**（禁止字符串匹配分支）；
       · units 是**规范化后**的单元（voice 单元已带 canonical voice 对象）；
       · 任何一条错误都会让 ok=false，调用方据此**一条都不写**（绝不部分落库）。
     词表：
       not-an-object / missing-turnId / missing-units / no-units-array /
       too-many-units / unit-not-object:<i> / missing-kind:<i> /
       unsupported-kind:<i>:<kind> / empty-text:<i> / unplayable-voice:<i> /
       secret-in-unit:<i> / secret-in-metadata
     "unit 级容错"是刻意的：空的 text 单元属于**呈现噪音**，不是安全事件。
     但它同样不产出消息（空消息会污染 search / memory / 上下文），并且必须被
     显式报告出来 —— 于是调用方能在测试里断言"它被丢掉了"，而不是靠结果数量猜。 */
  function validate(sequence) {
    var errors = [];
    var dropped = [];
    var units = [];
    if (!isObject(sequence)) return { ok: false, errors: ['not-an-object'], units: [], dropped: dropped };

    var turnId = str(sequence[TURN_ID]);
    if (!turnId) errors.push('missing-turnId');
    /* 安全边界：sequence 顶层（turnId 之外的任何注解）先过一遍秘密探测。 */
    if (VOICE && typeof VOICE.findSecret === 'function') {
      var top = {};
      var topKeys = Object.keys(sequence);
      for (var tk = 0; tk < topKeys.length; tk++) {
        if (topKeys[tk] === 'units') continue;
        top[topKeys[tk]] = sequence[topKeys[tk]];
      }
      var topHit = VOICE.findSecret(top);
      if (topHit) errors.push('secret-in-metadata');
    }

    var raw = sequence.units;
    if (!Array.isArray(raw)) {
      errors.push(raw == null ? 'missing-units' : 'no-units-array');
      return { ok: false, errors: errors, units: units, dropped: dropped };
    }
    if (raw.length > MAX_UNITS) errors.push('too-many-units');

    for (var i = 0; i < raw.length && i < MAX_UNITS; i++) {
      var u = raw[i];
      if (!isObject(u)) { errors.push('unit-not-object:' + i); continue; }
      var kind = str(u.kind);
      if (!kind) { errors.push('missing-kind:' + i); continue; }
      if (SUPPORTED_KINDS.indexOf(kind) < 0) {
        /* image 等**已登记未实现**的种类与真正的未知种类都在这里：契约上都不是本阶段
           能产出的单元（planner 属后续阶段），因此确定性拒绝而不是静默丢弃。 */
        errors.push('unsupported-kind:' + i + ':' + kind);
        continue;
      }
      /* 秘密边界分两类，因为两者的 canonical 语义本来就不同：
         · 除 provenance 之外的任何字段（文本、附加字段、顶层注解）—— 一旦出现凭据形状
           就**整批拒绝**（fail closed）：一条消息落库就已经是事实，没有"事后清洗"。
         · voice.provenance —— 它有自己的 canonical 清洗（voice-message-core 的
           sanitizeProvenance：白名单 + 丢秘密键/值，Phase 1 冻结）。这里**不**把它
           当成拒绝理由，但构造之后会对产出的 voice 对象再做一次反向探针（见下），
           于是"清洗器坏了"仍然会被抓住。 */
      if (VOICE && typeof VOICE.findSecret === 'function') {
        var probe = {};
        var pKeys = Object.keys(u);
        for (var pk = 0; pk < pKeys.length; pk++) {
          if (pKeys[pk] === 'provenance') continue;
          probe[pKeys[pk]] = u[pKeys[pk]];
        }
        var hit = VOICE.findSecret(probe);
        if (hit) { errors.push('secret-in-unit:' + i); continue; }
      }
      var text = str(u.text);
      if (kind === 'text') {
        if (!text.trim()) { dropped.push({ index: i, reason: 'empty-text' }); continue; }
        units.push({ index: units.length, kind: 'text', text: text, voice: null });
        continue;
      }
      /* kind === 'voice'：音源判定与清洗**复用** Phase 1 的唯一实现（voice-message-core）。
         content 与 voice.transcript 是同一个文本（content 是 authority）。 */
      var voice = (VOICE && typeof VOICE.build === 'function') ? VOICE.build({
        dataUrl: u.dataUrl, audioUrl: u.audioUrl, mime: u.mime, duration: u.duration,
        transcript: text, provenance: u.provenance, content: text
      }) : null;
      if (!voice) {
        /* 宁可没有这条 voice message，也不写一条不可播放的假 voice（Phase 1 契约）。 */
        errors.push('unplayable-voice:' + i);
        continue;
      }
      /* 反向探针：provenance 已被 canonical 清洗过，产出的 voice 对象里不该再有秘密。
         万一清洗器坏了，这里 fail closed（而不是把凭据写进消息）。 */
      if (VOICE && typeof VOICE.findSecret === 'function' && VOICE.findSecret(voice)) {
        errors.push('secret-in-unit:' + i);
        continue;
      }
      units.push({ index: units.length, kind: 'voice', text: text, voice: voice });
    }
    return { ok: errors.length === 0, errors: errors, units: units, dropped: dropped };
  }

  /* ── metadata 构造：构造式白名单 ───────────────────────────────────
     输出对象的每一个键都由本函数**逐字写出**；额外注解（extraMetadata）只接受
     标量，且拒绝秘密形状。因此"输入里多出来的键"没有机会进入消息。 */
  function buildMetadata(unit, index, total, turnId, opts) {
    var md = {};
    md[TURN_ID] = turnId;
    md[SEQUENCE_INDEX] = index;
    if (total > 0) md[SEQUENCE_TOTAL] = total;
    if (opts.model) md.model = str(opts.model);
    if (opts.modelId) md.model_id = str(opts.modelId);
    if (opts.configId) md.config_id = str(opts.configId);
    if (typeof opts.showThinking === 'boolean') md.showThinking = opts.showThinking;
    var extra = opts.extraMetadata;
    if (isObject(extra)) {
      var keys = Object.keys(extra);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (SEQUENCE_META_KEYS.indexOf(k) >= 0) continue;   /* 契约键只由本函数写 */
        var v = extra[k];
        var t = typeof v;
        if (t !== 'string' && t !== 'number' && t !== 'boolean') continue;
        if (VOICE && typeof VOICE.findSecret === 'function') {
          var probe = {}; probe[k] = v;
          if (VOICE.findSecret(probe)) continue;
        }
        md[k] = v;
      }
    }
    return md;
  }

  /* ── buildMessages：sequence → canonical chatMessages[] ────────────
     opts（全部显式，本函数绝不读时钟/环境）：
       friendId  必须（缺 → 不产出：没有会话归属的消息不是 canonical 消息）
       timestamp 必须为正（缺 → 不产出；调用方给，本模块不读 Date.now）
       role      默认 'assistant'（sequence 是**模型**交付，不是用户发言）
       senderName / threadId / model / modelId / configId / showThinking / extraMetadata
     输出：每条都是完整 canonical 记录（chat-core.validateMessage 通过），
       共享同一个 timestamp（**绝不**用 +1ms 之类的时间差制造顺序 —— 顺序来自
       sequenceIndex，见 orderMessages）。
     deterministic：同输入 ⇒ 逐字节同输出（含 id）。 */
  function buildMessages(sequence, opts) {
    opts = opts || {};
    var check = validate(sequence);
    if (!check.ok) return [];
    var units = check.units;
    if (!units.length) return [];

    var friendId = str(opts.friendId);
    if (!friendId) return [];
    var timestamp = posInt(opts.timestamp != null ? opts.timestamp : opts.now);
    if (!timestamp) return [];
    var turnId = str(opts.turnId) || str(sequence[TURN_ID]);
    if (!turnId) return [];

    var role = str(opts.role) || 'assistant';
    var total = units.length;
    var out = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var msg = {
        id: messageIdFor(turnId, u.index, timestamp),
        role: role,
        content: u.text,                       /* content 是文本 authority（不变量 6） */
        metadata: buildMetadata(u, u.index, total, turnId, opts),
        friendId: friendId,
        timestamp: timestamp
      };
      if (opts.senderName) msg.senderName = str(opts.senderName);
      if (opts.threadId) msg.threadId = str(opts.threadId);
      if (u.kind === 'voice') msg.voice = u.voice;
      out.push(msg);
    }
    return out;
  }

  /* ── 顺序 ──────────────────────────────────────────────────────────
     compareMessages：**逐对**的全序（timestamp → 同回合内 sequenceIndex → id）。
     它单独用不足以表达"一个回合的消息必须相邻"，因此生产读取点必须用
     orderMessages（集合级）—— 后者是唯一 canonical 入口。
     orderMessages(list, opts)：
       · 返回**新数组**；绝不修改入参数组，也不修改任何消息对象；
       · opts.base==='given' → 以入参顺序为基础（Home Node SQL 已按
         (timestamp, insert_seq) 排好序时用这个：不重排全序，只把回合聚成连续块）；
         否则以 (timestamp, id) 为基础；
       · 同一 turnId 的所有单元聚成**连续块**，块的位置 = 该回合在基础顺序里
         第一次出现的位置，块内按 sequenceIndex 升序；
       · 没有回合键的旧消息逐字保持基础顺序（不变量 10）。
     性质（测试断言）：幂等、确定性、不丢不增、元素同一性保持。 */
  function compareMessages(a, b) {
    var ta = num(a && a.timestamp), tb = num(b && b.timestamp);
    if (ta !== tb) return ta < tb ? -1 : 1;
    var turnA = turnIdOf(a), turnB = turnIdOf(b);
    if (turnA && turnA === turnB) {
      var ia = sequenceIndexOf(a), ib = sequenceIndexOf(b);
      if (ia !== ib) return ia < ib ? -1 : 1;
    }
    return idOrder(a && a.id, b && b.id);
  }

  function orderMessages(list, opts) {
    opts = opts || {};
    var base = [];
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m && typeof m === 'object' && !Array.isArray(m)) base.push(m);
      }
    }
    if (opts.base === 'given') base = base.slice(); else base.sort(compareMessages);
    if (base.length < 2) return base;

    var groups = Object.create(null);
    var turnOrder = [];
    for (var j = 0; j < base.length; j++) {
      var t = turnIdOf(base[j]);
      if (!t) continue;
      if (!groups[t]) { groups[t] = { emitted: false, units: [] }; turnOrder.push(t); }
      groups[t].units.push(base[j]);
    }
    if (!turnOrder.length) return base;

    var out = [];
    for (var k = 0; k < base.length; k++) {
      var tt = turnIdOf(base[k]);
      if (!tt) { out.push(base[k]); continue; }
      var g = groups[tt];
      if (!g || g.emitted) continue;
      g.emitted = true;
      g.units.sort(function (x, y) {
        var ix = sequenceIndexOf(x), iy = sequenceIndexOf(y);
        return (ix - iy) || idOrder(x && x.id, y && y.id);
      });
      for (var u = 0; u < g.units.length; u++) out.push(g.units[u]);
    }
    /* 兜底：任何未发出的行（理论上不可能）按基础顺序补在末尾 —— **绝不丢消息**。 */
    if (out.length !== base.length) {
      for (var z = 0; z < base.length; z++) if (out.indexOf(base[z]) < 0) out.push(base[z]);
    }
    return out;
  }

  /* 一个回合的单元（canonical 顺序）。turnId 缺失/无成员 ⇒ 空数组。 */
  function unitsOf(messages, turnId) {
    var t = str(turnId);
    if (!t) return [];
    return orderMessages(messages).filter(function (m) { return turnIdOf(m) === t; });
  }

  return {
    TURN_ID: TURN_ID,
    SEQUENCE_INDEX: SEQUENCE_INDEX,
    SEQUENCE_TOTAL: SEQUENCE_TOTAL,
    SEQUENCE_META_KEYS: SEQUENCE_META_KEYS,
    SUPPORTED_KINDS: SUPPORTED_KINDS,
    RESERVED_KINDS: RESERVED_KINDS,
    MAX_UNITS: MAX_UNITS,
    turnIdFor: turnIdFor,
    turnIdOf: turnIdOf,
    sequenceIndexOf: sequenceIndexOf,
    turnUnitCount: turnUnitCount,
    isSequenceMember: isSequenceMember,
    messageIdFor: messageIdFor,
    validate: validate,
    buildMessages: buildMessages,
    compareMessages: compareMessages,
    orderMessages: orderMessages,
    unitsOf: unitsOf
  };
});
