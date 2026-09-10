/* ====================================================================
   IB Image Edit — 图片编辑 / 参考图解析接线层（浏览器）
   --------------------------------------------------------------------
   职责（**只有这些**）：把"用户想改哪张图"变成 IB.imageRouter 能吃的结构化信号。

     Chat <ws_edit_image> / 用户选中的图片 / 附带图片
              ↓
     Image Reference Resolver（本文件 + image-edit-core.js）
        · 找图片：explicit selected > attached > latest editable（多轮 A→B→C）
        · 验证：MIME / 空数据 / 单张体积 / 数量 / 合计体积
        · 转成既有 canonical 表示 {dataUrl,base64,mime,name}(+lineage)
              ↓
     IB.imageRouter.routeImageRequest({operation:'edit', previousImage, …})
              ↓（模型选择 / 并发 / 优先级 / 队列全部属于既有 Router，本文件不碰）

   本文件**不选模型、不判断 Flare/Sunburst、不调 provider、不管并发、不管 priority、
   不发任何网络请求**（provider 执行只在 workspace.js 的既有执行器里）。

   限额可覆盖：apiSettings 私有 key 'image_edit'（数量/体积/压缩参数，可选）。
   ==================================================================== */
(function (NS) {
  'use strict';
  var CORE = (typeof window !== 'undefined') ? window.IBImageEditCore : null;
  var CFG_KEY = 'image_edit';
  var _limCache = null, _limLoaded = false;
  var _selection = null;   /* {image, conversationId, at} —— 用户显式选中的图片（内存态，不落库） */

  function _debugOn() { try { return localStorage.getItem('ibImageEditDebug') === '1'; } catch (e) { return false; } }
  function _log(line) { if (_debugOn()) { try { console.log(line); } catch (e) {} } }

  /* ── 限额（只读一次；改配置后调 reloadLimits） ── */
  function _limits() {
    if (!CORE) return Promise.resolve(null);
    if (_limLoaded) return Promise.resolve(_limCache);
    _limLoaded = true;
    try {
      if (typeof dbGet !== 'function') return Promise.resolve(CORE.IMAGE_EDIT_DEFAULTS);
      return Promise.resolve(dbGet('apiSettings', CFG_KEY)).then(function (c) {
        _limCache = CORE.mergeLimits(c && typeof c === 'object' ? c : null);
        return _limCache;
      }, function () { _limCache = CORE.mergeLimits(null); return _limCache; });
    } catch (e) { _limCache = CORE.mergeLimits(null); return Promise.resolve(_limCache); }
  }

  /* ── 超限图片先复用既有压缩 helper（moments 的 1024px/JPEG 缩放），不复制压缩算法 ── */
  function _shrink(dataUrl, lim) {
    var fn = null;
    try { fn = (NS.moments && typeof NS.moments._momentsShrinkDataUrl === 'function') ? NS.moments._momentsShrinkDataUrl : null; } catch (e) { fn = null; }
    if (!fn) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return fn(String(dataUrl), lim.maxShrinkPx, lim.shrinkQuality); })
      .then(function (out) { return (typeof out === 'string' && out.slice(0, 5) === 'data:') ? out : null; })
      .catch(function () { return null; });
  }
  /* 归一化单个候选（必要时压缩一次，仍超限则如实报错） */
  function _prepare(raw, lim) {
    var n = CORE.normalizeImage(raw, lim);
    if (n.ok) return Promise.resolve(n);
    if (n.code !== 'IMAGE_REFERENCE_TOO_LARGE') return Promise.resolve(n);
    var src = (typeof raw === 'string') ? raw : String((raw && (raw.dataUrl || raw.url || raw.src)) || '');
    if (!src) return Promise.resolve(n);
    return _shrink(src, lim).then(function (shrunk) {
      if (!shrunk) return n;
      var n2 = CORE.normalizeImage({ dataUrl: shrunk, name: (raw && raw.name) || '' }, lim);
      return n2.ok ? n2 : n;
    });
  }

  /* ── 聊天历史读取：只用既有 chatMessages 存储，不新建索引/不改 schema ── */
  function _messages(conversationId) {
    try {
      if (!conversationId || typeof dbGetByIndex !== 'function') return Promise.resolve([]);
      return Promise.resolve(dbGetByIndex('chatMessages', 'byFriend', conversationId)).then(function (list) {
        return (Array.isArray(list) ? list : []).slice().sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
      }, function () { return []; });
    } catch (e) { return Promise.resolve([]); }
  }
  function _inScope(m, ctx) {
    if (!m) return false;
    if (ctx.threadId && String(m.threadId || '') !== String(ctx.threadId)) return false;
    if (ctx.senderName && m.role === 'assistant' && String(m.senderName || '') !== String(ctx.senderName)) return false;
    return true;
  }
  /* 取一条消息里最后一张可用图片（同一消息多图时用最新那张） */
  function _lastImageOf(m, lim) {
    var imgs = (m && Array.isArray(m.images)) ? m.images : [];
    for (var i = imgs.length - 1; i >= 0; i--) {
      var n = CORE.normalizeImage(imgs[i], lim);
      if (n.ok) {
        if (!n.image.imageId) n.image.imageId = 'msgimg_' + String(m.id || '') + '_' + i;
        n.image.sourceId = String(m.id || '') + '#' + i;
        if (!n.image.generationType) n.image.generationType = (m.role === 'assistant') ? 'generate' : 'attach';
        return n.image;
      }
    }
    return null;
  }

  /* 候选收集：{explicit, attached, latest}（优先级判定交给 core） */
  function _candidates(ctx, lim) {
    ctx = ctx || {};
    var conv = String(ctx.conversationId || ctx.friendId || '');
    if (!conv) { try { if (typeof activeFriendId !== 'undefined' && activeFriendId) conv = String(activeFriendId); } catch (e) {} }
    return _messages(conv).then(function (msgs) {
      var out = { explicit: null, attached: null, latest: null, conversationId: conv };

      /* ① explicit：调用方直接给的图片，或用户在 UI 里选中的图片（同一会话才生效） */
      var exp = ctx.explicitImage || null;
      if (!exp && _selection && (!_selection.conversationId || !conv || _selection.conversationId === conv)) exp = _selection.image;

      /* ② attached：本轮用户消息里的图片（优先按 id 精确匹配，否则取最近一条 user 消息） */
      var attachedMsg = null;
      if (ctx.userMessageId) attachedMsg = msgs.filter(function (m) { return String(m.id) === String(ctx.userMessageId); })[0] || null;
      if (!attachedMsg) {
        for (var a = msgs.length - 1; a >= 0; a--) { if (msgs[a].role === 'user' && _inScope(msgs[a], ctx)) { attachedMsg = msgs[a]; break; } }
      }

      /* ③ latest：本会话最近一条可编辑图片（A→B→C 里的"最新一张"就是上一次编辑结果） */
      var latestImg = null;
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (!_inScope(m, ctx)) continue;
        if (attachedMsg && String(m.id) === String(attachedMsg.id)) continue; /* attached 单独作为一档优先级 */
        var img = _lastImageOf(m, lim);
        if (img) { latestImg = img; break; }
      }

      return Promise.resolve()
        .then(function () { return exp ? _prepare(exp, lim) : null; })
        .then(function (r1) {
          if (r1 && r1.ok) out.explicit = r1.image;
          return attachedMsg ? _lastImageOf(attachedMsg, lim) : null;
        })
        .then(function (r2) {
          if (r2) out.attached = r2;
          return latestImg || null;
        })
        .then(function (r3) { out.latest = r3; return out; });
    });
  }

  /* ── 解析可编辑源图：explicit > attached > latest ── */
  function resolveEditableImage(ctx) {
    if (!CORE) return Promise.resolve({ ok: false, code: 'IMAGE_EDIT_UNSUPPORTED', reason: 'image-edit-core 未加载' });
    return _limits().then(function (lim) { return _candidates(ctx || {}, lim); }).then(function (cands) {
      var picked = CORE.pickPreviousImage(cands, _limCache);
      if (!picked.ok) return picked;
      return {
        ok: true, image: picked.image, sourceKind: picked.sourceKind,
        conversationId: cands.conversationId,
        lineage: { imageId: picked.image.imageId || '', editDepth: picked.image.editDepth || 0 }
      };
    });
  }

  /* ── 显式文件路径（<ws_edit_image path="图片文件"/>）：ICode 里的图片文件 ── */
  function resolveFromPath(path) {
    var p = String(path || '').trim().replace(/^ws_(gen_image|read_image|edit_image)\s*/i, '').replace(/^path=["']?/, '').trim();
    if (!p) return Promise.resolve({ ok: false, code: 'IMAGE_EDIT_NO_SOURCE', reason: '缺少图片文件名' });
    if (/^(https?:)?\/\//i.test(p) || /^file:/i.test(p)) return Promise.resolve({ ok: false, code: 'IMAGE_REFERENCE_INVALID', reason: '不支持网络地址或本地路径' });
    return _limits().then(function (lim) {
      var tryProjects = [];
      try { if (NS.workspace && NS.workspace._wsActiveProject) tryProjects.push(NS.workspace._wsActiveProject); } catch (e) {}
      return Promise.resolve()
        .then(function () { return (typeof window.wsEnsureDefaultProject === 'function') ? window.wsEnsureDefaultProject() : null; })
        .catch(function () { return null; })
        .then(function (defId) {
          if (defId) tryProjects.push(defId);
          function next() {
            if (!tryProjects.length) return null;
            var pid = tryProjects.shift();
            if (!pid || typeof window.wsGetFileByPath !== 'function') return next();
            return Promise.resolve(window.wsGetFileByPath(pid, p)).catch(function () { return null; }).then(function (f) {
              if (f) return f;
              return next();
            });
          }
          return next();
        })
        .then(function (file) {
          if (!file) return { ok: false, code: 'IMAGE_EDIT_NO_SOURCE', reason: '文件不存在：' + p };
          var content = String((typeof file.content === 'string' && file.content) || '');
          if (!content) return { ok: false, code: 'IMAGE_REFERENCE_INVALID', reason: '图片文件内容为空' };
          var looksImage = content.slice(0, 5) === 'data:' || /\.(png|jpe?g|webp)$/i.test(p);
          if (!looksImage) return { ok: false, code: 'IMAGE_REFERENCE_INVALID', reason: '不是可编辑的图片文件' };
          var raw = content.slice(0, 5) === 'data:' ? content : ('data:image/png;base64,' + content);
          return _prepare({ dataUrl: raw, name: p }, lim).then(function (n) {
            if (!n.ok) return n;
            n.image.sourceId = 'icode:' + p;
            n.image.name = p;
            return { ok: true, image: n.image, sourceKind: 'explicit' };
          });
        });
    });
  }

  /* 参考图：先按数量上限快速拒绝，再逐张归一化（超限时复用压缩 helper 缩放一次） */
  function _prepareRefs(list, lim) {
    var arr = Array.isArray(list) ? list.filter(function (x) { return !!x; }) : [];
    if (arr.length > lim.maxReferenceImages) {
      return Promise.resolve({ ok: false, code: 'IMAGE_REFERENCE_LIMIT', reason: '参考图最多 ' + lim.maxReferenceImages + ' 张（本次 ' + arr.length + ' 张）' });
    }
    if (!arr.length) return Promise.resolve({ ok: true, images: [] });
    return Promise.all(arr.map(function (r) { return _prepare(r, lim); })).then(function (rs) {
      /* 失败的保留原值，交给 core 再校验一次并返回它自己的结构化错误码 */
      return { ok: true, images: rs.map(function (r, i) { return r.ok ? r.image : arr[i]; }) };
    });
  }

  /* ── 组装给 Router 的编辑请求（禁止复制 Router contract：字段以既有契约为准） ── */
  function buildEditRequest(instruction, ctx) {
    ctx = ctx || {};
    if (!CORE) return Promise.resolve({ ok: false, code: 'IMAGE_EDIT_UNSUPPORTED', reason: 'image-edit-core 未加载' });
    var limP = _limits();
    var explicitP = ctx.path ? resolveFromPath(ctx.path) : Promise.resolve(null);
    return Promise.all([limP, explicitP]).then(function (pair) {
      var lim = pair[0], fromPath = pair[1];
      if (fromPath && !fromPath.ok) return fromPath;
      var c2 = Object.assign({}, ctx);
      if (fromPath && fromPath.ok) c2.explicitImage = fromPath.image;
      return _prepareRefs(ctx.referenceImages, lim).then(function (refs) {
        if (!refs.ok) return refs;
        return _candidates(c2, lim).then(function (cands) {
          var r = CORE.buildEditRequest({
            instruction: instruction,
            explicit: cands.explicit, attached: cands.attached, latest: cands.latest,
            referenceImages: refs.images,
            identityPreservation: ctx.identityPreservation,
            characterId: ctx.characterId, source: ctx.source,
            requestedMode: ctx.requestedMode, requestedQuality: ctx.requestedQuality,
            userInitiated: ctx.userInitiated, background: ctx.background, size: ctx.size
          }, lim);
          if (!r.ok) return r;
          r.conversationId = cands.conversationId;
          _log('[ImageEdit] resolve source=' + r.sourceKind + ' editDepth=' + r.editDepth +
            ' refs=' + r.referenceCount + ' imageId=' + (r.request.previousImage.imageId || '-'));
          return r;
        });
      });
    });
  }

  /* ── 显式选中（Phase 3）：图片查看器里的"编辑这张图" / 外部调用 ── */
  function selectImage(image, meta) {
    if (!CORE) return { ok: false, code: 'IMAGE_EDIT_UNSUPPORTED' };
    var n = CORE.normalizeImage(image, _limCache || CORE.IMAGE_EDIT_DEFAULTS);
    if (!n.ok) return n;
    meta = meta || {};
    _selection = { image: n.image, conversationId: String(meta.conversationId || ''), at: Date.now() };
    try { if (typeof window.renderAttachPreviews === 'function') window.renderAttachPreviews(); } catch (e) {}
    try {
      var inp = document.getElementById('chat-full-input') || document.getElementById('chat-input');
      if (inp && inp.focus) inp.focus();
    } catch (e) {}
    return { ok: true, selection: _selection };
  }
  function getSelection() { return _selection ? { image: _selection.image, conversationId: _selection.conversationId, at: _selection.at } : null; }
  function clearSelection() {
    _selection = null;
    try { if (typeof window.renderAttachPreviews === 'function') window.renderAttachPreviews(); } catch (e) {}
    return true;
  }
  /* 预览条里的"正在编辑这张图片"小卡片（复用既有 .chat-preview-item 样式，不新增 CSS） */
  function renderSelectionChip(bar) {
    if (!_selection || !bar || !bar.appendChild) return false;
    try {
      var item = document.createElement('div');
      item.className = 'chat-preview-item';
      item.title = '正在编辑这张图片（点 ✕ 取消）';
      item.setAttribute('data-ib-edit-chip', '1');
      var img = document.createElement('img');
      img.src = _selection.image.dataUrl;
      img.alt = 'editing';
      var x = document.createElement('div');
      x.className = 'chat-preview-x';
      x.textContent = '✕';
      x.onclick = function () { clearSelection(); };
      item.appendChild(img); item.appendChild(x);
      bar.appendChild(item);
      return true;
    } catch (e) { return false; }
  }

  if (!CORE) {
    _log('[ImageEdit] image-edit-core.js 未加载，图片编辑解析不可用');
    NS.expose('imageEdit', {
      available: false,
      resolveEditableImage: function () { return Promise.resolve({ ok: false, code: 'IMAGE_EDIT_UNSUPPORTED', reason: 'Image Edit Core 未加载' }); },
      buildEditRequest: function () { return Promise.resolve({ ok: false, code: 'IMAGE_EDIT_UNSUPPORTED', reason: 'Image Edit Core 未加载' }); }
    });
    return;
  }

  NS.expose('imageEdit', {
    available: true,
    resolveEditableImage: resolveEditableImage,
    resolveFromPath: resolveFromPath,
    buildEditRequest: buildEditRequest,
    selectImage: selectImage,
    getSelection: getSelection,
    clearSelection: clearSelection,
    renderSelectionChip: renderSelectionChip,
    editErrorText: CORE.editErrorText,
    IMAGE_EDIT_DEFAULTS: CORE.IMAGE_EDIT_DEFAULTS,
    reloadLimits: function () { _limLoaded = false; _limCache = null; return true; }
  });
})(window.IB || (window.IB = {}));
