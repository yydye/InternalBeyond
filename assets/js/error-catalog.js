/* ============================================================
   IBERR · 统一 API 错误分类 + 角色化友好文案（静态目录）
   ------------------------------------------------------------
   目标：聊天界面只展示自然、简短的提示；完整技术错误保留在 F12 Console。
   原则：纯静态映射，零网络请求、零 LLM 参与；
        不改变任何 Provider 协议 / 请求参数 / 重试逻辑。
   用法：
     IBERR.classify(err)                 -> 'network' | 'timeout' | ...
     IBERR.text(category, roleKeyOrCfg)  -> 按角色稳定挑选的友好文案
     IBERR.err(category)                 -> 携带 ibCat 的 Error（供内部抛出）
     IBERR.report(err, ctx)              -> console 输出完整诊断 + 返回
                                            { category, text, dup }
   ctx: { cfg, friendId, senderName, stage }
   ============================================================ */
(function(){
  'use strict';

  var CATEGORIES = ['network','timeout','rate_limit','auth','provider','model','bad_request','empty_output','content','aborted','unknown'];

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
    unknown: [
      '嗯……刚才好像出了点小状况，再试一次吧。',
      '哎呀，刚才走神了……再说一次好吗？'
    ]
  };

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

  /* ── 分类 ──
     优先级：中止 > 超时/网络 > 明确状态码(401/403/429/5xx) > 关键词 >
             其余 4xx 归因 > 服务端过载词 > unknown
     状态码来源：底层 throw 的 "429: {body}" 与 "API返回 400" 两种前缀。 */
  function classify(e){
    if (e && e.ibCat && CATEGORIES.indexOf(e.ibCat) !== -1) return e.ibCat;
    var name = e && e.name || '';
    var s = String((e && e.message) || e || '');
    if (!s && !name) return 'unknown';
    if (name === 'AbortError') return 'aborted';
    if (/已停止|manually\s+stopped/i.test(s)) return 'aborted';
    if (/超时|timed?\s*out|timeout/i.test(s)) return 'timeout';
    if (/Failed to fetch|NetworkError|Load failed|ERR_(CONNECTION|NAME_|INTERNET|NETWORK)|CORS|Mixed Content|混合内容/i.test(s)) return 'network';
    var m = s.match(/^(\d{3})\s*:/) || s.match(/API返回\s*(\d{3})/);
    var code = m ? parseInt(m[1], 10) : 0;
    if (code === 401 || code === 403) return 'auth';
    if (code === 429) return 'rate_limit';
    if (code >= 500) return 'provider';
    if (/sensitive|content_filter|安全策略拦截/i.test(s)) return 'content';
    if (/输出上限耗尽/.test(s)) return 'content';
    if (/空内容|未收到有效回复/.test(s)) return 'empty_output';
    if (/rate[._-]?limit|too many requests|quota|请求频率|限速/i.test(s)) return 'rate_limit';
    if (/api[._-]?key|unauthorized|authentication|invalid_api_key|鉴权|密钥/i.test(s)) return 'auth';
    if (/(model|模型).{0,40}(not[_ ]?found|not[_ ]?exist|不存在|unsupported|不支持)|no such model|model_not_found/i.test(s)) return 'model';
    if (code === 404) return 'model';
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
     不删除、不弱化底层既有日志（如流式层的 '[IB API错误]'），本函数是补充而非替代。 */
  function report(e, ctx){
    ctx = ctx || {};
    var cat = (e && e.ibCat) || classify(e);
    var raw = String((e && e.message) || e || '');
    var st = (e && e.status) || (raw.match(/^(\d{3})\s*:/) || [])[1] || (raw.match(/API返回\s*(\d{3})/) || [])[1] || '';
    var rid = (raw.match(/"request[_-]?id"\s*:\s*"([^"]{6,120})"/i) || raw.match(/"id"\s*:\s*"(req_[^"]{6,120})"/i) || [])[1] || '';
    var cfg = ctx.cfg || {};
    try {
      console.error('[IB请求失败]', {
        category: cat,
        status: st || undefined,
        stage: ctx.stage || 'chat',
        provider: cfg.provider || undefined,
        model: cfg.model || undefined,
        configId: cfg.id || undefined,
        friendId: ctx.friendId || undefined,
        senderName: ctx.senderName || undefined,
        requestId: rid || undefined
      }, e || raw);
    } catch (_logErr) {}
    return { category: cat, text: text(cat, cfg.nickname || cfg.model || ctx.friendId), dup: _dup(ctx.friendId, cat) };
  }

  window.IBERR = {
    CATEGORIES: CATEGORIES,
    classify: classify,
    text: text,
    err: err,
    report: report
  };
})();
