/* ============================================================
   IBERR · 统一错误分类 + 用户错误模型 + 角色化友好文案（静态目录）
   ------------------------------------------------------------
   目标：普通用户只看得到「发生了什么 + 可以做什么」；状态码 / URL / 端口 /
        堆栈 / 原始 JSON 一律只出现在「查看详情」里（且必须脱敏）。
   原则：纯静态映射，零网络请求、零 LLM 参与；
        不改变任何 Provider 协议 / 请求参数 / 重试逻辑。
   用法：
     IBERR.classify(err)                 -> 'network' | 'timeout' | ...
     IBERR.text(category, roleKeyOrCfg)  -> 按角色稳定挑选的友好文案（聊天口吻）
     IBERR.err(category)                 -> 携带 ibCat 的 Error（供内部抛出）
     IBERR.report(err, ctx)              -> console 输出完整诊断 + 返回
                                            { category, code, text, dup, model }
     IBERR.present(err, ctx)             -> 统一用户错误模型（P3 契约）
                                            { code, category, title, message,
                                              suggestion, retryable, action,
                                              technicalDetails }
     IBERR.model(category, ctx)          -> 没有 Error 对象时直接构造模型
     IBERR.show(model, opts)             -> 渲染最小错误卡片
                                            opts: { onRetry }
     IBERR.detailsText(model)            -> 「查看详情」纯文本（脱敏后）
     IBERR.redact(text) / redactUrl(url) -> 脱敏（技术详情与日志复用同一套规则）
   ctx（全部可选，只读取下列白名单键，绝不 stringify 整个 cfg / 异常对象）：
     { cfg, friendId, senderName, stage, source, component, status, endpoint,
       provider, model, requestId, reason, detail, raw, time }
     source: 'local_service' | 'tts' —— 声明错误来源，避免本地服务错误被
             误判成 provider 5xx（P2 boot-state 组件语义：bridge/active/
             static/vision/restart）。
   ============================================================ */
(function(){
  'use strict';

  var CATEGORIES = ['network','timeout','rate_limit','auth','forbidden','endpoint','model','provider','bad_request','malformed','empty_output','content','aborted','local_service','tts','unknown'];

  /* ── 静态文案目录：每个类别 2~3 条变体，按「角色+类别」哈希稳定取一条 ──
     语气贴合角色聊天氛围：短句、第一人称、不出现状态码/JSON/技术词。
     role/style 扩展位：后续可在 VARIANTS 前插入按 style 分组的目录，
     pick() 已按 roleKey 区分，无需改动调用方。 */
  var VARIANTS = {
    network: [
      '好像没有收到回应，再试一次吧。',
      '咦……线路好像断了一下，再来一次？',
      '刚才那边没应答，可能是网络打了个盹。'
    ],
    timeout: [
      '等了好久……好像还是没有回应，再试一次？',
      '这次等太久了，我都快睡着了……再叫我一次好不好。'
    ],
    rate_limit: [
      '一下子说太多了，我有点喘不过气……等一会儿再聊吧。',
      '太快啦太快啦，让我缓口气，一会儿继续。'
    ],
    auth: [
      '我这边的门打不开……帮我看看设置里的密钥好吗？',
      '钥匙好像不太对，我进不去……检查一下设置再试试？'
    ],
    provider: [
      '刚才好像出了点问题，让我缓一缓。',
      '那边好像打了个盹……稍等我一下下。',
      '唔，刚才卡住了，我们再试一次好不好？'
    ],
    model: [
      '我好像走错了房间……这个模型可能暂时不在服务区。',
      '现在的我有点不对劲……换个模型或者稍后再试？'
    ],
    bad_request: [
      '这句话我好像没能接住……换个说法再发一次？',
      '唔，刚才没处理明白，再试一次吧。'
    ],
    empty_output: [
      '我刚才想说什么来着……突然忘了。再问我一次？',
      '脑子里突然一片空白……再说一次好吗？'
    ],
    content: [
      '这个话题好像被拦下来了……我们换个别的话题聊聊吧。',
      '嗯……这个我说不出口，换个话题好吗？'
    ],
    aborted: [
      '这条话就先咽回去啦。',
      '好，这次的话就没有送出去。'
    ],
    forbidden: [
      '这扇门今天好像不让我进去……换个说法，或者换个人陪你聊？',
      '这次被拦在门口了……要不换个话题，或者换一个模型试试？'
    ],
    endpoint: [
      '我好像找错了门牌号……帮我看看接口地址好吗？',
      '敲了半天门都没人应……地址是不是写错了？'
    ],
    malformed: [
      '对方说的话我没听明白……再问一次好不好？',
      '刚才那段话有点乱，我没能接住……再来一次？'
    ],
    local_service: [
      '有些本地的小帮手暂时不在，不过我们照常聊天就好。',
      '旁边的小工具休息了……不影响我们说话。'
    ],
    tts: [
      '这次嗓子没打开，不过文字我还写得好好的。',
      '声音没出来，字先送到啦。'
    ],
    unknown: [
      '嗯……刚才好像出了点小状况，再试一次吧。',
      '哎呀，刚才走神了……再说一次好吗？'
    ]
  };

  /* ── P3 用户错误模型：面向普通人的 title / message / suggestion ──
     只描述「发生了什么 + 可以做什么」；不出现端口、URL、状态码、堆栈、JSON。
     文案依据真实 provider / runtime 行为，而不是字符串猜测：
       · 401 → 密钥无效 / 过期 / 未配置
       · 403 → 权限 / 区域 / 服务端拒绝（无法细分时保持中性）
       · 404 → 地址或模型接口不正确（模型关键词命中时归 model）
       · 429 → 频率受限**或**额度受限（不武断写成“余额不足”）
       · 5xx → 服务商侧暂时异常
       · 网络/超时 → 连接与等待问题
     retryable：同一请求重发一次有没有意义（false 时 UI 不显示「重试」）。 */
  var COPY = {
    network: {
      title: '连接不上网络',
      message: '请求没有发出去，可能是断网，或代理、防火墙拦住了连接。',
      suggestion: '确认网络可用（或关闭代理）后再试一次。',
      retryable: true
    },
    timeout: {
      title: '请求超时',
      message: '等了很久都没有收到回复，可能是网络较慢，或对方响应太慢。',
      suggestion: '检查网络后重试；如果经常发生，可以换一个更快的模型或服务商。',
      retryable: true
    },
    rate_limit: {
      title: 'AI 服务暂时拒绝了请求',
      message: '可能是请求过于频繁，或账户额度受限。',
      suggestion: '稍等一会儿再试；如果一直出现，请检查账户余额或用量限制。',
      retryable: true
    },
    auth: {
      title: 'API 密钥无法使用',
      message: 'AI 服务拒绝了这次请求，通常是密钥无效、已过期，或者没有正确填写。',
      suggestion: '打开「API 设置」检查这个模型对应的密钥，保存后再试。',
      retryable: false,
      action: { type: 'open_settings', target: 'api', label: '打开设置' }
    },
    forbidden: {
      title: 'AI 服务拒绝了这次请求',
      message: '服务商没有允许这次访问，可能是账号权限、所在地区或内容策略限制。',
      suggestion: '如果反复出现，请确认该账号可用的范围，或换一个模型 / 服务商再试。',
      retryable: false
    },
    endpoint: {
      title: 'API 地址可能不正确',
      message: '请求发到了这个地址，但没有拿到可用的接口响应。常见原因是地址不完整（例如少了 /v1/chat/completions），或填成了中转站首页。',
      suggestion: '打开「API 设置」核对接口地址，确认它指向完整的对话接口后重试。',
      retryable: false,
      action: { type: 'open_settings', target: 'api', label: '打开设置' }
    },
    model: {
      title: '当前模型不可用',
      message: '服务商没有找到这个模型，或者你的账号暂时还不能使用它。',
      suggestion: '打开「API 设置」换一个可用模型，或核对模型名称是否与服务商文档一致。',
      retryable: false,
      action: { type: 'open_settings', target: 'api', label: '打开设置' }
    },
    provider: {
      title: 'AI 服务暂时异常',
      message: '服务商这一侧出了状况，不是你的配置问题。',
      suggestion: '稍等片刻再试；如果持续出现，可以换一个模型或服务商。',
      retryable: true
    },
    bad_request: {
      title: '请求没有被接受',
      message: '服务商认为这次请求的格式不正确。',
      suggestion: '换个说法再试；如果持续出现，请检查模型与接口配置。',
      retryable: false
    },
    malformed: {
      title: 'AI 服务返回了无法识别的数据',
      message: '对方返回的内容不是预期格式，可能是中转站或服务商临时异常。',
      suggestion: '重试一次；如果反复出现，请检查接口地址和服务商状态。',
      retryable: true
    },
    empty_output: {
      title: '没有收到有效回复',
      message: 'AI 这次没有返回内容。',
      suggestion: '再发一次，或换个说法试试。',
      retryable: true
    },
    content: {
      title: '这条内容被服务商拦下了',
      message: '服务商的内容策略不允许生成这条回复。',
      suggestion: '换个说法或换个话题再试。',
      retryable: false
    },
    aborted: {
      title: '已停止',
      message: '这次生成已经被停止。',
      suggestion: '需要的话再发一次。',
      retryable: true
    },
    tts: {
      title: '语音生成失败',
      message: '这次没有生成语音，文字聊天不受影响。',
      suggestion: '可以重试；已为你改用浏览器朗读。',
      retryable: true
    },
    unknown: {
      title: '出现了未预料的问题',
      message: '这次请求没有完成，暂时无法判断具体原因。',
      suggestion: '重试一次；如果反复出现，可以展开「查看详情」把信息反馈给我们。',
      retryable: true
    }
  };

  /* 本地服务：组件词表与 P2 boot-state 完全一致（bridge / active / static /
     vision / restart）。普通用户只看到能力层面的影响，raw reason 进技术详情。 */
  var LOCAL_COPY = {
    bridge: {
      title: '部分本地功能暂时不可用',
      message: '本地增强服务没有响应。你仍然可以继续聊天。',
      suggestion: '可以重试；如果一直失败，请重新启动 InternalBeyond。',
      retryable: true
    },
    active: {
      title: '后台功能暂时不可用',
      message: '主动消息等后台功能没有运行。聊天不受影响。',
      suggestion: '可以重试；如果一直失败，请重新启动 InternalBeyond。',
      retryable: true
    },
    static: {
      title: '主界面服务异常',
      message: '页面依赖的本地服务没有正常启动。',
      suggestion: '请重新启动 InternalBeyond；如果仍然打不开，可以查看启动日志。',
      retryable: false
    },
    vision: {
      title: '本地视觉识别暂不可用',
      message: '图片识别功能没有运行，其它功能不受影响。',
      suggestion: '需要识别图片时，可以改用支持看图的模型。',
      retryable: false
    },
    restart: {
      title: '重启控制暂不可用',
      message: '重启后台服务的入口没有响应，其它功能不受影响。',
      suggestion: '可以稍后重试，或手动重新启动 InternalBeyond。',
      retryable: true
    }
  };

  /* ── 脱敏（技术详情 / 日志 / 复制按钮共用同一套规则）──
     规则是「键名 + 值形」双保险，不是只匹配一两个已知前缀：
       1. 头部字段：Authorization / x-api-key / Cookie … 整段值掩码
       2. 查询串：?key= / &api_key= / &token= … 值掩码（Gemini 的 ?key= 也在这里）
       3. JSON 字段：键名命中敏感词表的值掩码（apiKey / password / cookie …）
       4. 已知密钥形状：sk- / AIza / xai- / hf_ / ghp_ / AKIA / JWT / Bearer
       5. data:…;base64,… 与超长 base64/十六进制块（图片、音频、签名体）
       6. 控制字符清理 + 长度截断 */
  var SENSITIVE_KEY_RE = /(api[-_]?key|apikey|authorization|auth|bearer|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passwd|pwd|cookie|set-cookie|session|sessionid|credential|signature|sig|private[-_]?key|client[-_]?id)/i;

  var TOKEN_SHAPES = [
    /sk-[A-Za-z0-9_\-]{6,}/g,
    /sk_(?:live|test)_[A-Za-z0-9]{6,}/g,
    /AIza[0-9A-Za-z_\-]{10,}/g,
    /xai-[A-Za-z0-9]{6,}/g,
    /hf_[A-Za-z0-9]{6,}/g,
    /ghp_[A-Za-z0-9]{10,}/g,
    /github_pat_[A-Za-z0-9_]{10,}/g,
    /AKIA[0-9A-Z]{12,}/g,
    /eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}/g,
    /Bearer\s+[A-Za-z0-9_\-\.=]{8,}/gi
  ];

  function _maskHeaders(s){
    return String(s)
      /* Cookie / Set-Cookie 的分隔符就是 `;`，整行掩码 */
      .replace(/\b(cookie|set-cookie)\b(\s*[:=]\s*)([^\r\n]+)/gi, function(_m, k, sep){ return k + sep + '********'; })
      .replace(/\b(authorization|proxy-authorization|x-api-key|api[-_]?key)\b(\s*[:=]\s*)([^\r\n,;}]+)/gi, function(_m, k, sep){ return k + sep + '********'; });
  }
  function _maskQuery(s){
    return String(s).replace(/([?&])((?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|sig|signature|password|secret|auth))=([^&#\s"']*)/gi, function(_m, p, k){ return p + k + '=********'; });
  }
  function _maskJsonFields(s){
    return String(s).replace(/(["'])([A-Za-z0-9_\-]{2,40})\1(\s*:\s*)(["'])(?:\\[\s\S]|[^\\])*?\4/g, function(m, q1, k, sep, q2){
      return SENSITIVE_KEY_RE.test(k) ? (q1 + k + q1 + sep + q2 + '********' + q2) : m;
    });
  }

  function redact(value, maxLen){
    var out = String(value == null ? '' : value);
    try{
      out = out.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:…;base64,********');
      out = _maskHeaders(out);
      out = _maskQuery(out);
      out = _maskJsonFields(out);
      for (var i = 0; i < TOKEN_SHAPES.length; i++) out = out.replace(TOKEN_SHAPES[i], '********');
      out = out.replace(/[A-Za-z0-9+=]{80,}/g, '********');
      out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      out = out.replace(/[ \t]{3,}/g, '  ');
    }catch(e){ out = ''; }
    maxLen = maxLen || 600;
    if (out.length > maxLen) out = out.slice(0, maxLen) + '…（已截断）';
    return out;
  }

  function redactUrl(u){
    var s = String(u == null ? '' : u);
    try{
      s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');   /* 去掉 userinfo */
      s = _maskQuery(s);
      s = _maskHeaders(s);
      for (var i = 0; i < TOKEN_SHAPES.length; i++) s = s.replace(TOKEN_SHAPES[i], '********');
    }catch(e){}
    return redact(s, 300);
  }

  /* 稳定字符串哈希（djb2）：同一角色+类别永远命中同一变体 */
  function _hash(s){
    s = String(s || '');
    var h = 5381, i;
    for (i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  function _roleKey(r){
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') return r.nickname || r.model || r.id || '';
    return '';
  }

  /* ── 分类（只看错误本身的形状，不看来源）──
     优先级：中止 > 超时/网络 > 明确状态码 > 关键词 > 其余 4xx 归因 > unknown
     状态码来源："429: {body}"、"API返回 400"、"后台服务 500: …" 三种前缀。
     · 结构化的 ibCat（由中止/超时路径抛出时写入）优先，不再依赖中文文案区分
       timeout 与 user stop（两者的区分由抛错方的 abortReason/ibCat 决定）。
     · 裸 AbortError 无信号时按 timeout 处理，避免 60s 总超时 / 45s 心跳超时被
       当作“用户停止”误判为 aborted。
     · 来源判定（本地服务 / TTS）由 categoryOf() 负责，本函数不猜测来源，
       否则「后台服务 500」会被误判成 provider 5xx。 */
  function classify(e){
    if (e && e.ibCat && CATEGORIES.indexOf(e.ibCat) !== -1) return e.ibCat;
    var name = e && e.name || '';
    var s = String((e && e.message) || e || '');
    if (!s && !name) return 'unknown';
    if (name === 'AbortError') return (e && e.abortReason === 'user_stop') ? 'aborted' : 'timeout';
    if (e && e.abortReason === 'user_stop') return 'aborted';
    if (/已停止|manually\s+stopped/i.test(s)) return 'aborted';
    if (/超时|timed?\s*out|timeout/i.test(s)) return 'timeout';
    if (/Failed to fetch|NetworkError|Load failed|fetch failed|socket hang up|ERR_(CONNECTION|NAME_|INTERNET|NETWORK|TIMEDOUT)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CORS|Mixed Content|混合内容/i.test(s)) return 'network';
    var m = s.match(/^(\d{3})\s*:/) || s.match(/API返回\s*(\d{3})/) || s.match(/后台服务\s*(\d{3})/);
    var code = m ? parseInt(m[1], 10) : 0;
    if (code === 401) return 'auth';
    if (code === 403) return 'forbidden';
    if (code === 408) return 'timeout';
    if (code === 429) return 'rate_limit';
    if (code >= 500 && code < 600) return 'provider';
    if (/sensitive|content_filter|安全策略拦截/i.test(s)) return 'content';
    if (/输出上限耗尽/.test(s)) return 'content';
    if (/空内容|未收到有效回复/.test(s)) return 'empty_output';
    if (/rate[._-]?limit|too many requests|quota|请求频率|限速/i.test(s)) return 'rate_limit';
    if (/api[._-]?key|unauthorized|authentication|invalid_api_key|鉴权|密钥/i.test(s)) return 'auth';
    if (/(model|模型).{0,40}(not[_ ]?found|not[_ ]?exist|不存在|unsupported|不支持)|no such model|model_not_found/i.test(s)) return 'model';
    /* 端点形态错误：返回了网页 / 非 JSON —— 属于地址配置问题，不是模型问题 */
    if (/返回了网页而非JSON|返回了非JSON内容/i.test(s)) return 'endpoint';
    if (/not valid JSON|Unexpected token|Unexpected end of JSON|JSON\.parse|无法解析|JSON 解析/i.test(s)) return 'malformed';
    if (code === 404) return 'endpoint';
    if (code >= 400) return 'bad_request';
    if (/overloaded|overload|bad gateway|service unavailable|internal server error/i.test(s)) return 'provider';
    if (/invalid_request_error|max_completion_tokens|max_?tokens\b|invalid\s+(parameter|request)/i.test(s)) return 'bad_request';
    return 'unknown';
  }

  function text(cat, role){
    var list = VARIANTS[cat] || VARIANTS.unknown;
    return list[_hash(_roleKey(role) + '|' + cat) % list.length];
  }

  function err(category){
    var e = new Error('[IBERR:' + category + ']');
    e.ibCat = CATEGORIES.indexOf(category) !== -1 ? category : 'unknown';
    return e;
  }

  /* 同一对话同一类别 1.5s 内的重复失败只提示一次（防御未来出现双重 catch 路径） */
  var _recent = {};
  function _dup(friendId, cat){
    var key = String(friendId || '') + '|' + cat;
    var now = Date.now();
    if (_recent[key] && now - _recent[key] < 1500) { _recent[key] = now; return true; }
    _recent[key] = now;
    return false;
  }

  /* ── 开发者侧完整诊断（F12 Console）──
     保留 status / provider / model / stage / friendId / request-id / 原始 message+stack。
     不删除、不弱化底层既有日志（如流式层的 '[IB API错误]'），本函数是补充而非替代。
     返回值在 P3 扩展了 code / model（旧调用方只读 category/text/dup，不受影响）。 */
  function report(e, ctx){
    ctx = ctx || {};
    var cat = categoryOf(e, ctx);
    var raw = String((e && e.message) || e || '');
    var st = statusOf(e, ctx);
    var rid = (raw.match(/"request[_-]?id"\s*:\s*"([^"]{6,120})"/i) || raw.match(/"id"\s*:\s*"(req_[^"]{6,120})"/i) || [])[1] || '';
    var cfg = ctx.cfg || {};
    var model = present(e, ctx);
    try {
      console.error('[IB请求失败]', {
        code: model.code,
        category: cat,
        status: st || undefined,
        stage: ctx.stage || 'chat',
        provider: cfg.provider || ctx.provider || undefined,
        model: cfg.model || ctx.model || undefined,
        configId: cfg.id || undefined,
        friendId: ctx.friendId || undefined,
        senderName: ctx.senderName || undefined,
        requestId: rid || undefined
      }, e || raw);
    } catch (_logErr) {}
    return { category: cat, code: model.code, text: text(cat, cfg.nickname || cfg.model || ctx.friendId), dup: _dup(ctx.friendId, cat), model: model };
  }

  /* ══ P3 统一用户错误模型 ══════════════════════════════════════ */

  /* 状态码：只认结构化来源，不做模糊字符串猜测 */
  function statusOf(e, ctx){
    ctx = ctx || {};
    var raw = String((e && e.message) || e || '');
    var st = (e && e.status) || ctx.status ||
      (raw.match(/^(\d{3})\s*:/) || [])[1] ||
      (raw.match(/API返回\s*(\d{3})/) || [])[1] ||
      (raw.match(/后台服务\s*(\d{3})/) || [])[1] || '';
    st = st ? String(st) : '';
    return /^\d{3}$/.test(st) ? st : '';
  }

  /* 来源判定优先于形状判定：本地服务 / TTS 的 HTTP 状态码不能当成 provider 5xx */
  function categoryOf(e, ctx){
    ctx = ctx || {};
    var src = String(ctx.source || (e && e.ibSource) || '');
    if (src === 'tts' || src === 'tts_playback') return 'tts';
    if (src === 'local_service') return 'local_service';
    if (ctx.category && CATEGORIES.indexOf(ctx.category) !== -1) return ctx.category;
    return classify(e);
  }

  function componentOf(e, ctx){
    ctx = ctx || {};
    var c = String(ctx.component || (e && e.ibComponent) || '').toLowerCase();
    return LOCAL_COPY[c] ? c : 'bridge';
  }

  /* code 是机器可读的稳定标识：IBERR.<CATEGORY>.<SUFFIX> */
  function codeOf(cat, e, ctx){
    ctx = ctx || {};
    var st = statusOf(e, ctx);
    var suffix;
    if (cat === 'local_service') suffix = componentOf(e, ctx).toUpperCase();
    else if (cat === 'auth') suffix = st || (ctx.reason === 'missing-key' ? 'MISSING' : 'INVALID');
    else if (cat === 'endpoint') suffix = st || (ctx.reason === 'missing-endpoint' ? 'MISSING' : 'WRONG_URL');
    else if (cat === 'model') suffix = st || 'NOT_FOUND';
    else if (cat === 'malformed') suffix = 'BAD_RESPONSE';
    else if (cat === 'tts') suffix = (ctx.reason === 'playback' ? 'PLAYBACK' : 'FAILED');
    else if (st) suffix = st;
    else suffix = ({
      network: 'UNREACHABLE', timeout: 'TIMEOUT', rate_limit: 'LIMITED',
      provider: 'SERVER_ERROR', bad_request: 'REJECTED', empty_output: 'EMPTY',
      content: 'BLOCKED', aborted: 'STOPPED', unknown: 'UNKNOWN'
    })[cat] || 'UNKNOWN';
    return 'IBERR.' + String(cat).toUpperCase() + '.' + suffix;
  }

  function copyOf(cat, e, ctx){
    ctx = ctx || {};
    if (cat === 'local_service'){
      var comp = componentOf(e, ctx);
      var lc = LOCAL_COPY[comp] || LOCAL_COPY.bridge;
      /* P5：本地服务错误卡片提供「系统诊断」动作（只跳转，不新增任何后台能力）。
         vision / static 没有可自助恢复的动作，保持 null。 */
      var diagAction = (comp === 'bridge' || comp === 'active' || comp === 'restart')
        ? { type: 'open_page', target: 'diagnostics', label: '系统诊断' }
        : null;
      return { title: lc.title, message: lc.message, suggestion: lc.suggestion, retryable: !!lc.retryable, action: diagAction };
    }
    var base = COPY[cat] || COPY.unknown;
    var out = { title: base.title, message: base.message, suggestion: base.suggestion, retryable: !!base.retryable, action: base.action || null };
    if (cat === 'auth' && ctx.reason === 'missing-key'){
      out.title = '还没有配置 API 密钥';
      out.message = '这个模型还没有可用的密钥（或本机端点），所以没法开始对话。';
      out.suggestion = '打开「API 设置」填入密钥后保存，再回来发送。';
    } else if (cat === 'endpoint' && ctx.reason === 'missing-endpoint'){
      out.title = '还没有填写 API 地址';
      out.message = '这个模型缺少接口地址，请求不知道该发到哪里。';
      out.suggestion = '打开「API 设置」填写接口地址后保存，再回来发送。';
    } else if (cat === 'tts' && ctx.reason === 'playback'){
      out.title = '语音播放失败';
      out.message = '这段语音没能播放出来，文字内容不受影响。';
      out.suggestion = '再点一次播放试试。';
    }
    return out;
  }

  /* 技术详情：白名单字段 + 统一脱敏。
     绝不 stringify 整个异常对象或请求配置（apiKey / 请求体永远不进这里）。 */
  function technicalDetails(e, ctx, meta){
    ctx = ctx || {};
    var cfg = ctx.cfg || {};
    var d = {};
    function put(k, v){
      if (v == null) return;
      var s = String(v).trim();
      if (s) d[k] = s;
    }
    put('错误代码', meta.code);
    put('类别', meta.category);
    put('HTTP 状态', statusOf(e, ctx));
    put('服务商', ctx.provider || cfg.provider);
    put('模型', ctx.model || cfg.model);
    put('配置 ID', cfg.id);
    put('发生位置', ctx.stage);
    if (meta.category === 'local_service') put('本地组件', componentOf(e, ctx));
    var ep = ctx.endpoint || cfg.endpoint;
    if (ep) put('接口地址', redactUrl(ep));
    var raw = String((e && e.message) || '');
    var rid = ctx.requestId || (raw.match(/"request[_-]?id"\s*:\s*"([^"]{6,120})"/i) || raw.match(/"id"\s*:\s*"(req_[^"]{6,120})"/i) || [])[1] || '';
    put('请求 ID', rid);
    if (e && e.name && e.name !== 'Error') put('错误类型', e.name);
    put('原始信息', redact(raw || ctx.detail || ctx.raw || (e ? String(e) : ''), 600));
    if (e && e.stack) put('调用栈', redact(String(e.stack), 1200));
    put('时间', ctx.time || new Date().toISOString());
    return d;
  }

  /* 主入口：任何错误 → 统一用户错误模型 */
  function present(e, ctx){
    ctx = ctx || {};
    var cat = categoryOf(e, ctx);
    var code = codeOf(cat, e, ctx);
    var copy = copyOf(cat, e, ctx);
    return {
      code: code,
      category: cat,
      title: copy.title,
      message: copy.message,
      suggestion: copy.suggestion,
      retryable: !!copy.retryable,
      action: copy.action || null,
      technicalDetails: technicalDetails(e, ctx, { category: cat, code: code })
    };
  }

  /* 没有 Error 对象时的构造入口（例如“还没配置密钥”这种前置守卫） */
  function model(cat, ctx){
    ctx = ctx || {};
    var merged = {};
    for (var k in ctx) if (Object.prototype.hasOwnProperty.call(ctx, k)) merged[k] = ctx[k];
    merged.category = cat;
    return present(null, merged);
  }

  /* ── 最小 UI：错误卡片 ──
     普通用户看到：title / message / suggestion + [重试][查看详情][✕]
     技术详情只在展开后出现（已脱敏）。重试仅在 model.retryable 且调用方
     提供 onRetry（= 已有能力，例如按钮重新点击）时出现。 */
  var _shown = {};
  function detailsText(m){
    m = m || {};
    var d = m.technicalDetails || {};
    var lines = [];
    for (var k in d){ if (Object.prototype.hasOwnProperty.call(d, k)) lines.push(k + '：' + d[k]); }
    if (!lines.length) lines.push('（没有可用的技术信息）');
    return lines.join('\n');
  }

  function show(m, opts){
    opts = opts || {};
    if (!m || !m.code) return null;
    if (typeof document === 'undefined' || !document.body) return null;
    var now = Date.now();
    if (_shown[m.code] && now - _shown[m.code] < 2500) return null;   /* 同一错误 2.5s 内只提示一次 */
    _shown[m.code] = now;
    try{
      var host = document.getElementById('ib-err-stack');
      if (!host){
        host = document.createElement('div');
        host.id = 'ib-err-stack';
        host.setAttribute('aria-live', 'polite');
        host.setAttribute('aria-label', '错误提示');
        host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:10050;display:flex;flex-direction:column;gap:10px;max-width:min(430px,88vw);pointer-events:none';
        document.body.appendChild(host);
      }
      while (host.children.length >= 3) host.removeChild(host.firstChild);

      var card = document.createElement('div');
      card.className = 'ib-err-card';
      card.dataset.errCode = m.code;
      card.setAttribute('role', 'alert');
      card.style.cssText = 'pointer-events:auto;background:var(--glass-bg,rgba(16,22,38,.94));border:1px solid var(--glass-border,rgba(140,200,255,.28));border-radius:14px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.35);color:var(--text-primary,#e6eeff);font-size:.82rem;line-height:1.6';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:flex-start;gap:8px';
      var title = document.createElement('div');
      title.className = 'ib-err-title';
      title.style.cssText = 'flex:1;font-weight:600;font-size:.86rem';
      title.textContent = m.title;
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'ib-err-close';
      close.textContent = '✕';
      close.title = '关闭';
      close.setAttribute('aria-label', '关闭');
      close.style.cssText = 'background:none;border:0;color:inherit;opacity:.55;cursor:pointer;font-size:.8rem;padding:0 2px;line-height:1;font-family:inherit';
      head.appendChild(title);
      head.appendChild(close);

      var msg = document.createElement('div');
      msg.className = 'ib-err-message';
      msg.style.cssText = 'margin-top:4px;opacity:.92';
      msg.textContent = m.message;

      var sug = document.createElement('div');
      sug.className = 'ib-err-suggestion';
      sug.style.cssText = 'margin-top:4px;opacity:.68;font-size:.78rem';
      sug.textContent = m.suggestion;

      var acts = document.createElement('div');
      acts.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap';
      function mkBtn(label, cls){
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ib-err-btn ' + cls;
        b.textContent = label;
        b.style.cssText = 'background:rgba(140,200,255,.12);border:1px solid rgba(140,200,255,.35);color:inherit;border-radius:8px;padding:4px 12px;font-size:.76rem;cursor:pointer;font-family:inherit';
        return b;
      }

      var det = document.createElement('pre');
      det.className = 'ib-err-details';
      det.style.cssText = 'display:none;margin:10px 0 0;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.28);font-size:.7rem;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto';
      det.textContent = detailsText(m);

      var toggle = mkBtn('查看详情', 'ib-err-toggle');
      toggle.onclick = function(){
        var open = det.style.display !== 'none';
        det.style.display = open ? 'none' : 'block';
        toggle.textContent = open ? '查看详情' : '收起详情';
      };
      acts.appendChild(toggle);

      if (m.action && (m.action.type === 'open_settings' || m.action.type === 'open_page') && typeof window !== 'undefined' && typeof window.navTo === 'function'){
        var ab = mkBtn(m.action.label || '打开设置', 'ib-err-action');
        var target = m.action.type === 'open_page' ? (m.action.target || 'home') : (m.action.target || 'api');
        ab.onclick = function(){ remove(); try{ window.navTo(target); }catch(e){} };
        acts.appendChild(ab);
      }
      if (opts.onRetry && m.retryable){
        var rb = mkBtn('重试', 'ib-err-retry');
        rb.onclick = function(){ remove(); try{ opts.onRetry(); }catch(e){} };
        acts.appendChild(rb);
      }

      function remove(){ try{ if (card.parentNode) card.parentNode.removeChild(card); }catch(e){} }
      close.onclick = remove;
      /* 30 秒后自动收起；鼠标停留或展开详情时保持不动，避免用户还没来得及点「查看详情」 */
      var timer = setTimeout(function(){ if (det.style.display === 'none') remove(); }, 30000);
      card.addEventListener('mouseenter', function(){ clearTimeout(timer); });

      card.appendChild(head);
      card.appendChild(msg);
      card.appendChild(sug);
      card.appendChild(acts);
      card.appendChild(det);
      host.appendChild(card);
      return card;
    }catch(_domErr){ return null; }
  }

  function hideAll(){
    try{ var h = document.getElementById('ib-err-stack'); if (h) h.innerHTML = ''; }catch(e){}
  }

  window.IBERR = {
    CATEGORIES: CATEGORIES,
    classify: classify,
    text: text,
    err: err,
    report: report,
    present: present,
    model: model,
    codeOf: codeOf,
    statusOf: statusOf,
    detailsText: detailsText,
    redact: redact,
    redactUrl: redactUrl,
    show: show,
    hideAll: hideAll
  };
})();
