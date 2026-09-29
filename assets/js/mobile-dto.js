/* ====================================================================
   IB Mobile DTO — Mobile Gateway 的**唯一**出站投影层
   --------------------------------------------------------------------
   这个文件同时被 Node（services/home-node/mobile-gateway.js，通过 require）
   与浏览器（assets/js/home-node-bootstrap.js，通过 <script>）加载。
   这是 M1-A 的 D1/D10 约定：**一条规则只有一份实现，两个宿主共用**。

   ── Character DTO ≠ Character Runtime Config（Phase 12）──────────────
   桌面的 apiConfigs 条目**同时**是「显示身份」和「provider 运行配置」：
       nickname / avatar / relationship / bio / handle / ...
       apiKey / endpoint / model / provider / systemPrompt / imageGenApiKey / ...
   本模块只做前者。任何带凭据性质的字段在被读到的**第一行**就被丢掉，
   而不是"记得在发送前删掉"。

   这不是靠"字段黑名单"实现的安全：白名单是**构造式**的 ——
   输出对象由本文件的字面量逐字段搭建，输入里多出来的键**根本没有机会**进入输出。
   因此即使未来 apiConfigs 增加了某个新的 secret 字段，这里也不会自动泄漏它。

   ── 为什么不把 DTO 写在 gateway 里 ──────────────────────────────────
   因为浏览器发布角色目录时用的是本模块的 characterCatalogEntry()。
   如果服务端另写一份投影，就会出现"发布的是 A、返回的是 B"的漂移，
   而漂移的那一天没人会注意到。同一份实现 ⇒ 结构上不可能漂移。
   ==================================================================== */
(function (root, factory) {
  'use strict';
  /* P23 Phase 2A：voice 的出站投影必须复用 Phase 1 的 canonical voice 契约
     （audioUrl 只认 Bridge 引用形状、provenance 只走它的白名单清洗），
     绝不在这里另写一份"什么算音源"的判定 —— 那是第二套 voice schema。
     Node 侧同一个 require；浏览器侧同一份全局（voice-message-core 先加载）。 */
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./voice-message-core.js')); }
  else { root.IBMobileDto = factory(root.IBVoiceMessage); }
})(typeof self !== 'undefined' ? self : this, function (VOICE) {
  'use strict';

  var DTO_VERSION = 1;

  function str(value, maxLen) {
    var text = String(value == null ? '' : value);
    return maxLen && text.length > maxLen ? text.slice(0, maxLen) : text;
  }
  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }
  function pick(obj, keys) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (obj[key] !== undefined && obj[key] !== null) out[key] = obj[key];
    }
    return out;
  }
  function strArray(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (value[i] == null) continue;
      var s = String(value[i]);
      if (s) out.push(s);
    }
    return out;
  }

  /* ── 角色：mobile-safe DTO ──────────────────────────────────────────
     暴露：身份与外观（Android 要画的）+ 「这台设备能不能发图」这一类能力位。
     不暴露：apiKey / imageGenApiKey / endpoint / model / provider /
             systemPrompt（原始隐藏提示词）/ temperature / 任何凭据。 */
  function characterDto(raw) {
    raw = raw || {};
    var id = str(raw.id, 128);
    var model = str(raw.model, 128);
    /* 名字的三级回落，顺序是刻意的：
         1. raw.nickname —— **原始** apiConfigs 条目的用户昵称（权威来源）；
         2. raw.name     —— 已经是 DTO 的输入（例如服务端把库里存的 DTO 再投影一次）。
                            少了这一级，"发布 → 落库 → 出站再投影"这条链会把昵称
                            静默换成模型名 —— 实测踩到过，正是"两份投影会漂移"的
                            典型症状；
         3. 模型名        —— 用户没填昵称时的显示名（与 social.js:1161 的 effName 同义）。 */
    var dto = {
      id: id,
      name: str(raw.nickname, 64) || str(raw.name, 64) || model || 'AI',
      avatar: str(raw.avatar, 512),
      relationship: str(raw.relationship, 64),
      handle: str(raw.handle, 32),
      signature: str(raw.signature, 80),
      bio: str(raw.bio, 160),
      banner: str(raw.banner, 512),
      createdAt: num(raw.createdAt != null ? raw.createdAt : raw.created),
      /* 模型名是**展示**信息（用户自己填的），不是凭据；Android 要显示"由谁生成"。
         它与 endpoint 不同：知道模型名不能访问任何服务。 */
      model: model,
      status: raw.archived ? 'archived' : 'active',
      capabilities: characterCapabilities(raw)
    };
    return dto;
  }

  /* 能力位：只描述"这个角色支持什么玩法"，不含任何运行参数。
     vision 来自角色的 vision 开关（Android 据此决定要不要放开发图片）。

     每一档同样做两级回落（原始字段 → 已投影的 capabilities 对象）：
     服务端会对库里的 DTO 再投影一次，如果只看扁平字段，第二次投影会把
     vision / imageGen / streaming / webSearch 全部归零 —— 也就是"发布时对、
     读出来错"这种最难查的漂移。 */
  function characterCapabilities(raw) {
    raw = raw || {};
    var prior = (raw.capabilities && typeof raw.capabilities === 'object') ? raw.capabilities : {};
    function flag(flat, priorKey) {
      if (raw[flat] !== undefined) return !!raw[flat];
      if (prior[priorKey] !== undefined) return !!prior[priorKey];
      return false;
    }
    var capabilities = {
      chat: true,
      stream: raw.streaming === undefined
        ? (prior.stream !== undefined ? !!prior.stream : true)
        : !!raw.streaming,
      vision: flag('vision', 'vision'),
      webSearch: flag('webSearch', 'webSearch')
    };
    if (flag('imageGen', 'imageGen')) {
      /* 只说"这个角色开了生图"，**不**说用哪家、哪个模型、哪个 endpoint。 */
      capabilities.imageGen = true;
    }
    return capabilities;
  }

  /* ── 发布条目：{id, dto, spec} ──────────────────────────────────────
     浏览器把 apiConfigs 逐条交给这里；Node 侧网关只会把 dto 表暴露给设备。
     spec 是**运行配置**，只进 Node 的 character_runtime_specs 表。

     接受两种输入形状，两者的出站结果都经同一份投影：
       · 原始 apiConfigs 条目（桌面直接传的）
       · 已经投影过的 {id, dto, spec}（桌面自己先过了 characterDto 再传）
     第二种形状必须被正确识别：如果把它当原始条目读 raw.nickname，
     角色名会静默变成空字符串 —— 这正是"两份实现会漂移"的典型症状，
     所以这里显式分支，而不是指望调用方永远只做一种事。

     spec 是显式构造的：只取一次文本回合真正需要的字段。
     刻意**不**包含 imageGenApiKey / voice* / autoMem* 等与文本回合无关的凭据，
     即使它们就在输入里。 */
  function characterCatalogEntry(raw, options) {
    options = options || {};
    raw = raw || {};
    var id = str(raw.id, 128);
    if (!id) return null;
    /* 判定"已经是投影过的条目"必须看 dto 的**内容**，而不是"有没有 dto 键"。
       空 dto（{}）是合法输入：那表示"这个角色只有 id，没有可发布字段"，
       此时应该回落到从原始字段投影，而不是把一个空对象原样发布出去
       （否则角色名会静默变成空串 —— 实测踩到过）。 */
    var projectedDto = (raw.dto && typeof raw.dto === 'object' && !Array.isArray(raw.dto) &&
      (raw.dto.name || raw.dto.id || raw.dto.model)) ? raw.dto : null;
    if (projectedDto) {
      return {
        id: id,
        dto: characterDto(Object.assign({ id: id }, projectedDto)),
        /* id 一并带入，使 mapSpec 能在入站已投影 spec 缺 credentialRef 时回落到 character id
           （P34.3-B：credentialRef 的权威来源仍是 id）。 */
        spec: (raw.spec && typeof raw.spec === 'object') ? mapSpec(Object.assign({ id: id }, raw.spec)) : null
      };
    }
    var entry = { id: id, dto: characterDto(raw), spec: null };
    if (options.withSpec !== false) entry.spec = mapSpec(raw);
    return entry;
  }

  /* spec 投影：白名单。输入里多出来的键（imageGenApiKey …）根本没有机会进入输出。 */
  function mapSpec(raw) {
    raw = raw || {};
    var provider = str(raw.provider, 64);
    var model = str(raw.model, 256);
    var endpoint = str(raw.endpoint, 512);
    /* P34.3-B · Home Node Vault authority: publish the non-secret credentialRef;
       old configs without it fall back to character id. The Home Node resolves
       the secret from the Vault at request time (credential-access.js). */
    var hasCredentialRef = Object.prototype.hasOwnProperty.call(raw, 'credentialRef');
    var credentialRef = hasCredentialRef ? str(raw.credentialRef, 180) : str(raw.id, 180);
    if (!provider || !model || !endpoint || !credentialRef) return null;
    var spec = { provider: provider, model: model, endpoint: endpoint, credentialRef: credentialRef };
    var systemPrompt = str(raw.systemPrompt, 200000);
    if (systemPrompt) spec.systemPrompt = systemPrompt;
    if (raw.temperature != null) spec.temperature = num(raw.temperature, 1);
    /* M1-C.2i：**刻意不再投影 reasoningEffort。**
       思考深度是**执行策略**，不是角色身份：canonical 语义里它来自全局 Middle Brain
       配置（assets/js/middle-brain-config-core.js），与"哪个角色"无关。
       此前这里会把 raw.reasoningEffort 原样带进 character_runtime_specs，
       等于给了它一条**按角色**进入 Home Node 的旁路 —— 而 Home Node 现在从
       已发布的执行策略读它（services/home-node/middle-brain.js）。
       两处都能决定同一件事，就是漂移的开始；所以这条旁路在投影层就被关掉。
       注意：不是"暂时没人写这个字段所以无害" —— 白名单一旦允许，它就是一个
       可以被后续代码意外填充的旋钮。 */
    if (raw.thinkingEnabled !== undefined) spec.thinkingEnabled = !!raw.thinkingEnabled;
    if (raw.showThinking !== undefined) spec.showThinking = !!raw.showThinking;
    return spec;
  }

  /* 用户资料投影（M1-C.2c-A · P0）。
     桌面的 about/main 是**单用户展示身份**，不是凭据：name 本来就会渲染进
     导航栏。Node 需要它来回答"她该叫我什么"，所以随角色目录一起发布。
     与 characterDto 同理，白名单**构造式**输出：输入多出来的键没有机会进入。
     只取 name（id 固定为 main —— 桌面就是一个单用户模型，不假装多用户）。 */
  function userProfileDto(raw) {
    raw = raw || {};
    var name = str(raw.name, 64).trim();
    if (!name) return null;
    return { id: 'main', name: name };
  }

  function characterCatalog(rawList, options) {    var out = [];
    if (!Array.isArray(rawList)) return out;
    for (var i = 0; i < rawList.length; i++) {
      var entry = characterCatalogEntry(rawList[i], options);
      if (entry) out.push(entry);
    }
    return out;
  }

  /* ── 消息：mobile DTO ───────────────────────────────────────────────
     保留（客户端要渲染 / 要能对账）：
       id / role / content / timestamp / threadId / senderName /
       images 元数据 / files 元数据 / voice 元数据 / metadata 白名单 /
       truncated / withdrawn / conversationId / revision
     剥掉（runtime-only）：
       reasoning_content —— 移动端不展示思考过程，且它是"内部运行时字段"；
       wsSearches / memOps / calNotes —— 工具与记忆操作的内部回执；
       upstreamRaw / thinkingSources —— 导出用的遗留字段。
     **图片只保留元数据**（mime / name / 尺寸），绝不内联 base64：
     一条 20MB 的内联图片会把「读历史」变成一次几十兆的下载。 */
  function messageDto(message, options) {
    options = options || {};
    message = message || {};
    var dto = {
      id: str(message.id, 256),
      role: str(message.role, 16),
      content: str(message.content, 1000000),
      timestamp: num(message.timestamp),
      conversationId: str(options.conversationId != null ? options.conversationId : message.conversationId, 256)
    };
    if (message.threadId) dto.threadId = str(message.threadId, 128);
    if (message.senderName) dto.senderName = str(message.senderName, 64);
    var images = imageMeta(message.images);
    if (images.length) dto.images = images;
    var files = fileMeta(message.files);
    if (files.length) dto.files = files;
    if (message.voice) dto.voice = voiceMeta(message.voice);
    if (message.truncated) dto.truncated = true;
    if (message.withdrawn) {
      dto.withdrawn = true;
      if (message.withdrawnBy) dto.withdrawnBy = str(message.withdrawnBy, 16);
    }
    var metadata = messageMetadata(message.metadata);
    if (Object.keys(metadata).length) dto.metadata = metadata;
    if (options.revision != null) dto.revision = num(options.revision);
    if (options.deleted != null) dto.deleted = !!options.deleted;
    if (message.__malformedPayload) dto.malformed = true;
    return dto;
  }

  /* metadata 白名单。注意 model / model_id 是**展示**信息，保留；
     config_id 是角色 id（公开发布的角色 id 本来就是明文），保留；
    其余未知键一律丢弃 —— 未知键里可能正好是某个未来的 secret。 */
  /* P23 Phase 2A 新增三个**回合身份**键（turnId / sequenceIndex / sequenceTotal）：
     它们让移动端知道"这几条消息来自同一次模型生成、以及它们在她那边的先后"。
     三者都只是标识与序号：不含凭据、不含内容，与 activityId 同级的每消息注解。 */
  var MESSAGE_METADATA_KEYS = ['model', 'model_id', 'config_id', 'showThinking', 'source', 'eventType', 'characterId', 'waifu',
    'turnId', 'sequenceIndex', 'sequenceTotal'];

  function messageMetadata(metadata) {
    var out = pick(metadata, MESSAGE_METADATA_KEYS);
    if (out.source) out.source = str(out.source, 32);
    if (out.eventType) out.eventType = str(out.eventType, 32);
    if (out.characterId) out.characterId = str(out.characterId, 128);
    if (out.config_id) out.config_id = str(out.config_id, 128);
    if (out.model) out.model = str(out.model, 64);
    if (out.model_id) out.model_id = str(out.model_id, 128);
    if (out.turnId != null) { var _tid = str(out.turnId, 64); if (_tid) out.turnId = _tid; else delete out.turnId; }
    /* 序号必须是有限非负数：非法值**丢掉**而不是归零 —— 归零会让"第 3 条"谎称"第 1 条"。 */
    ['sequenceIndex', 'sequenceTotal'].forEach(function (k) {
      if (out[k] == null) return;
      var n = Number(out[k]);
      if (isFinite(n) && n >= 0) out[k] = Math.floor(n); else delete out[k];
    });
    return out;
  }

  /* 图片：只留元数据。dataUrl / base64 绝不出现在 DTO 里。 */
  function imageMeta(images) {
    var out = [];
    if (!Array.isArray(images)) return out;
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (!img || typeof img !== 'object') continue;
      var item = { mime: str(img.mime, 64) || 'image/jpeg' };
      if (img.name) item.name = str(img.name, 256);
      if (img.width != null) item.width = num(img.width);
      if (img.height != null) item.height = num(img.height);
      if (img.size != null) item.size = num(img.size);
      /* 是否有可取回的内联数据 —— 客户端据此决定要不要请求整条消息。
         这是**布尔**，不是数据本身。 */
      item.inline = !!(img.dataUrl || img.base64);
      out.push(item);
    }
    return out;
  }

  function fileMeta(files) {
    var out = [];
    if (!Array.isArray(files)) return out;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file || typeof file !== 'object') continue;
      var item = { name: str(file.name, 256) };
      if (file.ext) item.ext = str(file.ext, 16);
      if (file.size != null) item.size = num(file.size);
      out.push(item);
    }
    return out;
  }

  function voiceMeta(voice) {
    if (!voice || typeof voice !== 'object') return null;
    var item = {};
    if (voice.mime) item.mime = str(voice.mime, 64);
    if (voice.duration != null) item.duration = num(voice.duration);
    if (voice.transcript) item.transcript = str(voice.transcript, 4000);
    /* dataUrl（音频本体）刻意不发。 */
    if (voice.dataUrl) item.inline = true;
    /* P23 Phase 2A（Phase 1 已登记的缺口闭合）：
       audioUrl —— 只接受 Phase 1 的 Bridge 引用形状（/tts/<name>.<ext>）。它是**引用**，
                   不是音频本体；不接受任意 URL（否则 DTO 会变成"把记录里的任意字符串
                   发给设备"的通道）。
       provenance —— 走 voice-message-core 的**同一个**白名单清洗（只保留扁平标量、丢秘密）。
       playable  —— "这条消息真的有一个音源"（Phase 1 的 canonical 判定），
                   与 inline 配套使用：inline=true 表示音源在本条记录里（客户端要取字节
                   得请求整条消息），绝不在 DTO 里内联音频。 */
    var bridgeAudio = (VOICE && typeof VOICE.isBridgeAudioPath === 'function' && VOICE.isBridgeAudioPath(voice.audioUrl))
      ? str(voice.audioUrl, 512) : '';
    if (bridgeAudio) item.audioUrl = bridgeAudio;
    var prov = (VOICE && typeof VOICE.sanitizeProvenance === 'function') ? VOICE.sanitizeProvenance(voice.provenance) : null;
    if (prov && Object.keys(prov).length) item.provenance = prov;
    item.playable = (VOICE && typeof VOICE.hasPlayable === 'function')
      ? !!VOICE.hasPlayable(voice) : !!(voice.dataUrl || bridgeAudio);
    return item;
  }

  /* ── 握手 / 状态 / 在线 ──────────────────────────────────────────── */
  function handshakeDto(info) {
    info = info || {};
    return {
      dtoVersion: DTO_VERSION,
      role: 'mobile-gateway',
      protocol: num(info.protocol, 1),
      serverVersion: str(info.serverVersion, 64),
      fingerprint: str(info.fingerprint, 64),
      model: 'thin-client',
      sync: {
        cursorModel: 'home-node-revision',
        changesAfter: true,
        historyPaging: 'keyset'
      },
      capabilities: strArray(info.capabilities)
    };
  }

  function presenceDto(device) {
    device = device || {};
    return {
      deviceId: str(device.deviceId, 64),
      name: str(device.name, 64),
      type: str(device.type, 32),
      online: !!device.online,
      lastSeenAt: num(device.lastSeenAt),
      appForeground: !!device.appForeground
    };
  }

  return {
    DTO_VERSION: DTO_VERSION,
    characterDto: characterDto,
    characterCapabilities: characterCapabilities,
    characterCatalogEntry: characterCatalogEntry,
    characterCatalog: characterCatalog,
    userProfileDto: userProfileDto,
    mapSpec: mapSpec,
    messageDto: messageDto,
    messageMetadata: messageMetadata,
    imageMeta: imageMeta,
    fileMeta: fileMeta,
    voiceMeta: voiceMeta,
    handshakeDto: handshakeDto,
    presenceDto: presenceDto,
    MESSAGE_METADATA_KEYS: MESSAGE_METADATA_KEYS
  };
});
