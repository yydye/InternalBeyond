/* ====================================================================
   IB Native Voice Message — canonical voice-message contract (UMD dual-load · P23 Phase 1)
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/voice-message-core.js"> → window.IBVoiceMessage
   - Node   : require('../assets/js/voice-message-core.js')
   - 规则：零 window / 零 DOM / 零 fetch / 零 IndexedDB / 零 provider 判定。
   - 唯一职责：定义「一条消息里的 voice 是什么」，并提供**纯函数**的构造 / 校验 /
     清洗 / 播放源解析。不做 I/O、不做存储、不做传输、不发请求。

   与 chat-core.js 的关系：chat-core 声明 `voice` 是 canonical 字段
   （CONDITIONAL_FIELDS，validateMessage 要求它是 object）；
   本文件定义那个 object 的**形状**。两个文件都不含 I/O，浏览器与 Node 共用同一份。

   既有形状（用户录音，communication.js 生产写入，必须逐字保留）：
     { dataUrl, mime, duration, transcript, tone }
   本阶段新增的是**同名字段在 assistant 消息上的权威形态**（AI voice message）：
     {
       dataUrl,        // 内联音频（小体积时）；无则 ''
       audioUrl,       // Bridge 本地引用（/tts/<id>.<ext>）；无则 ''
       mime, duration, transcript,
       provenance: { source, provider, engine, model, voiceId, voiceType, refAudioId }
     }
   dataUrl 与 audioUrl **至少有一个**，否则这条 voice 不成立（绝不出现「可播放」
   却没有任何音源的假 voice message）。relaod 可播放性由 dataUrl 或 audioUrl 保证，
   绝不依赖运行时 object URL。

   安全边界（硬约束）：provenance 只允许白名单字段，且任何层级都不允许出现
   apiKey / token / secret / authorization / password 之类的键或值。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBVoiceMessage = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 单条消息内联音频的上限（原始字节估算值）。超过则只保存 Bridge 引用（audioUrl），
     避免一条消息把 IndexedDB 记录推到数 MB；两种情况都可 reload 后播放。 */
  var INLINE_MAX_BYTES = 2000000;

  /* provenance 白名单 —— 只有这些键会进入消息数据。 */
  var PROVENANCE_FIELDS = ['source', 'provider', 'engine', 'model', 'voiceId', 'voiceType', 'refAudioId', 'profile'];

  /* 秘密键名（大小写不敏感、允许分隔符）。出现在任何层级即视为污染，整键丢弃。 */
  var SECRET_KEY_PATTERN = /(apikey|api_key|secret|token|authorization|password|credential|bearer)/i;
  /* 秘密值形态：常见 Bearer / sk- 前缀长串。 */
  var SECRET_VALUE_PATTERN = /(^|\s)(bearer\s+|sk-[A-Za-z0-9_\-]{8,})/i;

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return v == null ? '' : String(v); }
  function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0; }

  /* 秘密检测：给定任意值，返回第一个命中的秘密键路径或 ''。
     用于测试断言与运行期防御（持久化前清洗）。 */
  function findSecret(value, path) {
    var here = path || '';
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var ra = findSecret(value[i], here + '[' + i + ']');
        if (ra) return ra;
      }
      return '';
    }
    if (isObject(value)) {
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (SECRET_KEY_PATTERN.test(key)) return (here ? here + '.' : '') + key;
        var rk = findSecret(value[key], (here ? here + '.' : '') + key);
        if (rk) return rk;
      }
      return '';
    }
    if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) return here || '(value)';
    return '';
  }

  /* provenance 清洗：只保留白名单键、只保留字符串、丢弃秘密。绝不做「保留原对象」的短路。 */
  function sanitizeProvenance(raw) {
    var out = {};
    if (!isObject(raw)) return out;
    for (var i = 0; i < PROVENANCE_FIELDS.length; i++) {
      var k = PROVENANCE_FIELDS[i];
      if (!(k in raw)) continue;
      if (SECRET_KEY_PATTERN.test(k)) continue;
      var v = raw[k];
      if (v == null) continue;
      if (typeof v === 'object') continue;      /* provenance 是扁平标量集合，不承载嵌套结构 */
      var s = String(v);
      if (!s) continue;
      if (SECRET_VALUE_PATTERN.test(s)) continue;
      out[k] = s;
    }
    return out;
  }

  /* data URL 的原始字节估算（base64 长度 × 3/4）。非 data URL 返回 0。 */
  function estimateDataUrlBytes(dataUrl) {
    var s = str(dataUrl);
    if (s.indexOf('data:') !== 0) return 0;
    var comma = s.indexOf(',');
    if (comma < 0) return 0;
    var payload = s.slice(comma + 1);
    if (/;base64/i.test(s.slice(0, comma))) return Math.floor(payload.length * 3 / 4);
    return payload.length;
  }

  /* 是否是合法的音频 data URL（只接受 audio/*，防止把任意 data: 当成音源）。 */
  function isAudioDataUrl(s) {
    return /^data:audio\/[a-z0-9.+-]+;base64,/i.test(str(s));
  }

  /* 是否是 Bridge 的本地音频引用（只接受 /tts/<name>.<ext>，与 bridge/routes.js 的路由一致）。 */
  function isBridgeAudioPath(s) {
    return /^\/tts\/[\w.\-]+\.(mp3|wav)$/i.test(str(s));
  }

  /* 从 mime / URL 推导 mime（缺省 audio/mpeg，与既有 /tts/*.mp3 链路一致）。 */
  function mimeOf(mime, url) {
    var m = str(mime).toLowerCase();
    if (m.indexOf('audio/') === 0) return m;
    if (/\.wav($|\?)/i.test(str(url))) return 'audio/wav';
    if (/\.mp3($|\?)/i.test(str(url))) return 'audio/mpeg';
    if (/^data:audio\/wav/i.test(str(url))) return 'audio/wav';
    if (/^data:audio\/mpeg/i.test(str(url))) return 'audio/mpeg';
    return 'audio/mpeg';
  }

  /*
   * 内容指纹：一段语音是从**某个确切文本**生成的。content 一旦变化，这段音频就不再代表
   * 这条消息，两个真相必须消掉一个。
   * 为什么用指纹而不是直接比较 transcript：TTS 前的文本会经过 sticker/music 标记剥离与
   * 长度截断（_ibTtsMaxLen），transcript 与 content 本来就不保证逐字相等 —— 用 transcript
   * 判定会漏掉「content 变了但 transcript 恰好没变」的情况。
   * 确定性、零依赖（FNV-1a 变体 + 长度，长度参与是为了让同前缀不同长度的文本必然不同）。
   */
  function contentFingerprint(content) {
    var s = str(content);
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0; h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 = ((h2 ^ c) * 16777619) >>> 0;
    }
    return h1.toString(36) + h2.toString(36) + ':' + s.length;
  }

  /* 陈旧判定（读侧防御，绝不写库）：voice 由旧 content 生成 ⇒ 不再代表这条消息。
     没有 contentHash 的早期记录（Phase 1 前半段写入的）一律 fail open（继续渲染），
     因为它们无法被证明陈旧。 */
  function isStale(msg) {
    if (!isObject(msg) || !isObject(msg.voice)) return false;
    var h = msg.voice.contentHash;
    if (!h) return false;
    return String(h) !== contentFingerprint(msg.content);
  }

  /* 生命周期原语：**任何**改写 assistant content 的路径都必须调用它
     （撤回 / 续写 / 未来的编辑与重新生成）。选 immutable 语义（删 voice）而不是
     同步改 transcript：音频已经固化，改 transcript 只会制造「文字说 A、声音说 B」。 */
  function dropVoice(msg) {
    if (!isObject(msg) || !isObject(msg.voice)) return false;
    delete msg.voice;
    return true;
  }

  /*
   * build(raw) → canonical voice object | null
   * raw: { dataUrl?, audioUrl?, mime?, duration?, transcript?, provenance?|flat provider fields }
   * 返回 null 表示「这条 voice 不成立」：没有任何合法音源。
   * 大音频（> INLINE_MAX_BYTES）只有在存在 audioUrl 时才保留（否则 null —— 宁可没有
   * voice message，也不写一条不可播放的假 voice message）。
   */
  function build(raw) {
    if (!isObject(raw)) return null;
    var dataUrl = isAudioDataUrl(raw.dataUrl) ? str(raw.dataUrl) : '';
    var audioUrl = isBridgeAudioPath(raw.audioUrl) ? str(raw.audioUrl) : '';
    if (dataUrl && estimateDataUrlBytes(dataUrl) > INLINE_MAX_BYTES) {
      dataUrl = '';   /* 过大 ⇒ 退化为 Bridge 引用（若也没有引用则整条不成立） */
    }
    if (!dataUrl && !audioUrl) return null;

    var voice = {
      dataUrl: dataUrl,
      audioUrl: audioUrl,
      mime: mimeOf(raw.mime, dataUrl || audioUrl),
      duration: num(raw.duration),
      transcript: str(raw.transcript)
    };
    /* 记录「这段音频是从哪个 content 生成的」。后续任何 content 改写都会让指纹不匹配，
       渲染层据此拒绝把陈旧音频画成这条消息的语音（见 isStale / dropVoice）。 */
    if (typeof raw.content === 'string') voice.contentHash = contentFingerprint(raw.content);
    var prov = sanitizeProvenance(raw.provenance || raw);
    if (Object.keys(prov).length) voice.provenance = prov;
    return voice;
  }

  /* AI voice message：assistant 角色的消息带 canonical voice 载荷，且该载荷**不陈旧**。
     用户录音消息（role==='user'）不在此判定内 —— 它的形状由既有代码拥有。 */
  function isAiVoiceMessage(msg) {
    if (!isObject(msg)) return false;
    if (str(msg.role) === 'user') return false;
    if (isStale(msg)) return false;
    return hasPlayable(msg.voice);
  }

  /* 是否有可播放音源（dataUrl 或 audioUrl）。UI 用它决定「能不能画成可播放的气泡」。 */
  function hasPlayable(voice) {
    if (!isObject(voice)) return false;
    return isAudioDataUrl(voice.dataUrl) || isBridgeAudioPath(voice.audioUrl);
  }

  /* 播放源解析（唯一入口）：内联优先，其次 Bridge 引用；都没有返回 ''。
     绝不返回 object URL —— 调用方拿到的永远是可重新解析的持久源。 */
  function playSrc(voice) {
    if (!isObject(voice)) return '';
    if (isAudioDataUrl(voice.dataUrl)) return str(voice.dataUrl);
    if (isBridgeAudioPath(voice.audioUrl)) return str(voice.audioUrl);
    return '';
  }

  /* 气泡标题/调试用的一句话 provenance 描述（不含任何 secret）。 */
  function describe(voice) {
    if (!hasPlayable(voice)) return '';
    var p = isObject(voice.provenance) ? voice.provenance : {};
    var bits = [];
    if (p.source) bits.push(str(p.source));
    if (p.engine) bits.push('engine=' + str(p.engine));
    if (p.model && str(p.model) !== str(p.engine)) bits.push('model=' + str(p.model));
    if (p.voiceId) bits.push('voice=' + str(p.voiceId));
    if (p.voiceType && str(p.voiceType) !== 'builtin') bits.push(str(p.voiceType));
    if (p.refAudioId) bits.push('ref=' + str(p.refAudioId));
    return bits.join(' · ');
  }

  return {
    INLINE_MAX_BYTES: INLINE_MAX_BYTES,
    PROVENANCE_FIELDS: PROVENANCE_FIELDS,
    isObject: isObject,
    findSecret: findSecret,
    sanitizeProvenance: sanitizeProvenance,
    estimateDataUrlBytes: estimateDataUrlBytes,
    isAudioDataUrl: isAudioDataUrl,
    isBridgeAudioPath: isBridgeAudioPath,
    mimeOf: mimeOf,
    contentFingerprint: contentFingerprint,
    isStale: isStale,
    dropVoice: dropVoice,
    build: build,
    isAiVoiceMessage: isAiVoiceMessage,
    hasPlayable: hasPlayable,
    playSrc: playSrc,
    describe: describe
  };
});
