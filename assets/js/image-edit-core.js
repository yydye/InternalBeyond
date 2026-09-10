/* ====================================================================
   IB Image Edit Core — 图片编辑 / 参考图解析内核
   --------------------------------------------------------------------
   运行时中立（浏览器 window.IBImageEditCore / Node require），零 DOM、零网络、零 DB。
   本文件**只做四件事**，绝不做 Router / Scheduler 的事：

     ① 归一化（normalizeImage）  各种来源的图片 → 现有 canonical 表示
                                  {dataUrl, base64, mime, name}（与 chatMessages.images 同形）
     ② 限额（checkBudget）       参考图数量 / 单张体积 / 合计体积
     ③ 选源（pickPreviousImage） explicit selected > attached > latest editable
     ④ 组装（buildEditRequest）  交给 IB.imageRouter.routeImageRequest 的结构化信号

   明确**不做**：不选模型、不判断 Flare/Sunburst、不调 provider、不管并发、
   不管 priority、不发任何请求。这些全部属于既有 Image Router / Scheduler。

   图片 canonical 表示沿用仓库既有对象（chatMessages.images / _pendingImages /
   sentImages 都是同一形状），只额外允许可选 lineage 字段：
     imageId · parentImageId · generationType('generate'|'edit') · editDepth · model
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBImageEditCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── ① 集中限额（所有 magic number 只在这里；可被 apiSettings['image_edit'] 覆盖） ── */
  var IMAGE_EDIT_DEFAULTS = {
    maxReferenceImages: 4,                 /* 参考图上限：禁止无限塞 */
    maxReferenceBytes: 4 * 1024 * 1024,    /* 单张上限 4MB（与 OpenAI Images edit 文档的输入图上限一致） */
    maxTotalReferenceBytes: 8 * 1024 * 1024,/* 全部参考图合计上限 */
    minBytes: 32,                          /* 空图 / 损坏图下限（1x1 PNG 约 69 字节，仍算有效图片） */
    maxShrinkPx: 1536,                     /* 超限时先复用既有压缩 helper 缩到 1536px */
    shrinkQuality: 0.9,
    allowMime: ['image/png', 'image/jpeg', 'image/webp']
  };

  /* ── ② 结构化错误码 → 用户文案（简短；详细 code 只进 debug/telemetry） ── */
  var IMAGE_EDIT_ERRORS = {
    IMAGE_EDIT_NO_SOURCE: '当前会话里没有可编辑的图片，请先生成一张，或选中要修改的图片',
    IMAGE_EDIT_UNSUPPORTED: '当前图片模型不支持编辑这张图片',
    IMAGE_REFERENCE_INVALID: '这张图片无法用作编辑参考（格式不受支持或内容为空）',
    IMAGE_REFERENCE_TOO_LARGE: '图片太大，无法作为编辑参考',
    IMAGE_REFERENCE_LIMIT: '参考图数量超出上限',
    IMAGE_EDIT_ABORTED: '图片编辑已取消',
    IMAGE_EDIT_TIMEOUT: '图片编辑超时，请稍后重试',
    IMAGE_PROVIDER_ERROR: '图片服务未能完成这次编辑，请稍后重试'
  };

  function _clampInt(v, lo, hi, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    n = Math.floor(n);
    return Math.max(lo, Math.min(hi, n));
  }
  /* 合并调用方覆盖值（非法值一律回默认，绝不让 0/NaN 卡死编辑链路） */
  function mergeLimits(options) {
    var out = {};
    for (var k in IMAGE_EDIT_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(IMAGE_EDIT_DEFAULTS, k)) out[k] = IMAGE_EDIT_DEFAULTS[k];
    }
    if (options && typeof options === 'object') {
      for (var k2 in options) {
        if (!Object.prototype.hasOwnProperty.call(IMAGE_EDIT_DEFAULTS, k2)) continue;
        if (k2 === 'allowMime') {
          var a = options.allowMime;
          if (Array.isArray(a) && a.length) out.allowMime = a.map(function (x) { return String(x).toLowerCase(); });
          continue;
        }
        out[k2] = options[k2];
      }
    }
    out.maxReferenceImages = _clampInt(out.maxReferenceImages, 1, 16, IMAGE_EDIT_DEFAULTS.maxReferenceImages);
    out.maxReferenceBytes = _clampInt(out.maxReferenceBytes, 1024, 64 * 1024 * 1024, IMAGE_EDIT_DEFAULTS.maxReferenceBytes);
    out.maxTotalReferenceBytes = _clampInt(out.maxTotalReferenceBytes, 1024, 128 * 1024 * 1024, IMAGE_EDIT_DEFAULTS.maxTotalReferenceBytes);
    out.minBytes = _clampInt(out.minBytes, 1, 1024 * 1024, IMAGE_EDIT_DEFAULTS.minBytes);
    out.maxShrinkPx = _clampInt(out.maxShrinkPx, 64, 4096, IMAGE_EDIT_DEFAULTS.maxShrinkPx);
    var q = Number(out.shrinkQuality);
    out.shrinkQuality = isFinite(q) && q > 0.1 && q <= 1 ? q : IMAGE_EDIT_DEFAULTS.shrinkQuality;
    if (out.maxTotalReferenceBytes < out.maxReferenceBytes) out.maxTotalReferenceBytes = out.maxReferenceBytes;
    return out;
  }

  function editErrorText(result) {
    if (!result) return '图片编辑失败';
    var code = String(result.code || '');
    if (IMAGE_EDIT_ERRORS[code]) return IMAGE_EDIT_ERRORS[code];
    return String(result.reason || '图片编辑失败');
  }
  function _err(code, reason) { return { ok: false, code: code, reason: reason || IMAGE_EDIT_ERRORS[code] || code }; }

  /* ── ③ data URL / base64 解析（只认图片；绝不读本地路径） ── */
  function _normMime(m) {
    var s = String(m || '').trim().toLowerCase();
    if (s === 'image/jpg') s = 'image/jpeg';
    return s;
  }
  function parseDataUrl(s) {
    var str = String(s || '');
    if (str.slice(0, 5) !== 'data:') return null;
    var comma = str.indexOf(',');
    if (comma === -1) return null;
    var head = str.slice(5, comma);
    var semi = head.indexOf(';');
    var mime = _normMime(semi === -1 ? head : head.slice(0, semi));
    var isB64 = /;base64/i.test(head);
    var data = str.slice(comma + 1);
    if (!isB64) return null;                     /* 只支持 base64 data URL（provider 需要二进制） */
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) return null;
    return { mime: mime, base64: data.replace(/\s+/g, '') };
  }
  function _bytesOf(base64) { return Math.floor(String(base64 || '').length * 0.75); }
  function _looksBase64(s) {
    var str = String(s || '');
    if (str.length < 64) return false;
    return /^[A-Za-z0-9+/=\s]+$/.test(str.slice(0, 256));
  }

  /* 归一化任意来源 → canonical 图片对象；失败返回结构化 code */
  function normalizeImage(input, options) {
    var lim = mergeLimits(options);
    if (input == null) return _err('IMAGE_REFERENCE_INVALID', '空图片');
    var raw = input, name = '', mimeHint = '', lineage = null;
    if (typeof raw === 'string') {
      raw = { dataUrl: raw };
    } else if (typeof raw === 'object') {
      name = String(raw.name || raw.fileName || '').trim();
      mimeHint = _normMime(raw.mime || raw.mimeType || '');
      /* lineage 原样保留（不新增图片结构，只在既有对象上带可选字段） */
      lineage = {
        imageId: raw.imageId ? String(raw.imageId) : '',
        parentImageId: raw.parentImageId ? String(raw.parentImageId) : '',
        generationType: String(raw.generationType || ''),
        editDepth: _clampInt(raw.editDepth, 0, 99, 0),
        model: raw.model ? String(raw.model) : '',
        sourceId: raw.sourceId ? String(raw.sourceId) : ''
      };
    } else {
      return _err('IMAGE_REFERENCE_INVALID', '不支持的图片输入');
    }

    var dataUrl = String(raw.dataUrl || raw.url || raw.src || raw.image || '').trim();
    var base64 = String(raw.base64 || raw.data || '').trim();
    var mime = mimeHint;

    if (dataUrl) {
      var parsed = parseDataUrl(dataUrl);
      if (!parsed) return _err('IMAGE_REFERENCE_INVALID', '不是可用的图片 data URL');
      mime = parsed.mime;
      base64 = parsed.base64;
      dataUrl = 'data:' + mime + ';base64,' + base64;
    } else if (base64) {
      if (!_looksBase64(base64)) return _err('IMAGE_REFERENCE_INVALID', '图片数据不是合法 base64');
      base64 = base64.replace(/\s+/g, '');
      if (!mime) mime = 'image/png';             /* 仓库既有约定：裸 base64 按 PNG 包装 */
      dataUrl = 'data:' + mime + ';base64,' + base64;
    } else {
      return _err('IMAGE_REFERENCE_INVALID', '图片内容为空');
    }

    mime = _normMime(mime);
    if (lim.allowMime.indexOf(mime) === -1) return _err('IMAGE_REFERENCE_INVALID', '不支持的图片格式：' + (mime || '未知'));
    var bytes = _bytesOf(base64);
    if (!base64 || bytes < lim.minBytes) return _err('IMAGE_REFERENCE_INVALID', '图片内容为空或已损坏');
    if (bytes > lim.maxReferenceBytes) return _err('IMAGE_REFERENCE_TOO_LARGE', '单张图片 ' + Math.round(bytes / 1048576 * 10) / 10 + 'MB 超过上限');

    var image = { dataUrl: dataUrl, base64: base64, mime: mime, name: name || ('image.' + (mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png')), bytes: bytes };
    if (lineage) {
      if (lineage.imageId) image.imageId = lineage.imageId;
      if (lineage.parentImageId) image.parentImageId = lineage.parentImageId;
      if (lineage.generationType) image.generationType = lineage.generationType;
      if (lineage.editDepth) image.editDepth = lineage.editDepth;
      if (lineage.model) image.model = lineage.model;
      if (lineage.sourceId) image.sourceId = lineage.sourceId;
    }
    return { ok: true, image: image };
  }

  /* 已存图片是否可编辑（用于遍历历史消息时快速筛除坏数据） */
  function isEditableImage(input, options) {
    var r = normalizeImage(input, options);
    return r.ok ? { ok: true, image: r.image } : r;
  }
  /* 是否需要先压缩（体积超限但有救） */
  function needsShrink(input, options) {
    var lim = mergeLimits(options);
    var r = normalizeImage(input, Object.assign({}, lim, { maxReferenceBytes: Number.MAX_SAFE_INTEGER }));
    if (!r.ok) return false;
    return r.image.bytes > lim.maxReferenceBytes;
  }

  /* ── ④ 参考图限额（数量 / 单张 / 合计） ── */
  function checkBudget(images, options) {
    var lim = mergeLimits(options);
    var list = Array.isArray(images) ? images.filter(function (x) { return !!x; }) : [];
    if (list.length > lim.maxReferenceImages) {
      return _err('IMAGE_REFERENCE_LIMIT', '参考图最多 ' + lim.maxReferenceImages + ' 张（本次 ' + list.length + ' 张）');
    }
    var total = 0, out = [];
    for (var i = 0; i < list.length; i++) {
      var n = normalizeImage(list[i], lim);
      if (!n.ok) return n;
      total += n.image.bytes;
      if (total > lim.maxTotalReferenceBytes) {
        return _err('IMAGE_REFERENCE_TOO_LARGE', '参考图合计 ' + Math.round(total / 1048576 * 10) / 10 + 'MB 超过上限');
      }
      out.push(n.image);
    }
    return { ok: true, images: out, totalBytes: total };
  }

  /* ── ⑤ 选源：explicit selected image > current user attached image > latest editable image ──
     纯函数：调用方（浏览器接线层）负责从聊天历史/UI 里取候选，这里只做优先级判定。 */
  var IMAGE_SOURCE_ORDER = ['explicit', 'attached', 'latest'];
  function pickPreviousImage(candidates, options) {
    var lim = mergeLimits(options);
    candidates = candidates || {};
    for (var i = 0; i < IMAGE_SOURCE_ORDER.length; i++) {
      var kind = IMAGE_SOURCE_ORDER[i];
      var cand = candidates[kind];
      if (!cand) continue;
      var n = normalizeImage(cand, lim);
      if (!n.ok) continue;                        /* 坏候选跳过，继续找下一优先级 */
      return { ok: true, image: n.image, sourceKind: kind };
    }
    return _err('IMAGE_EDIT_NO_SOURCE');
  }

  /* ── ⑥ lineage：A → B → C 的父子链（只加字段，不重构图片存储） ── */
  function newImageId(seed) {
    var n = (seed && isFinite(seed.now)) ? Math.floor(seed.now) : Date.now();
    var r = (seed && typeof seed.rand === 'number') ? seed.rand : Math.random();
    return 'img_' + n.toString(36) + '_' + Math.floor(r * 1e9).toString(36);
  }
  function lineageFor(parent, meta) {
    meta = meta || {};
    var depth = parent && isFinite(parent.editDepth) ? Math.floor(parent.editDepth) : 0;
    return {
      imageId: meta.imageId || newImageId(meta),
      parentImageId: (parent && parent.imageId) ? String(parent.imageId) : '',
      generationType: 'edit',
      editDepth: Math.max(0, depth) + 1,
      model: String(meta.model || '')
    };
  }
  /* 生成（非编辑）图片的 lineage 起点 */
  function lineageForGenerate(meta) {
    meta = meta || {};
    return { imageId: meta.imageId || newImageId(meta), parentImageId: '', generationType: 'generate', editDepth: 0, model: String(meta.model || '') };
  }

  /* ── ⑦ 组装 Router 请求（禁止在此复制 Router contract；只填既有字段） ──
     输入：
       instruction      编辑指令（正文）
       explicit/attached/latest  三个优先级的候选图片
       referenceImages  额外参考图（可空）
       characterId/source/requestedMode/requestedQuality/userInitiated/background/size
       identityPreservation  仅当调用方**明确知道**时才传（不在这里重复 classifyImageTask 的文本判断）
     输出：{ok:true, request:{operation:'edit', previousImage, referenceImages, multiTurnEdits, ...}} */
  function buildEditRequest(input, options) {
    input = input || {};
    var lim = mergeLimits(options);
    var instruction = String(input.instruction || input.prompt || '').trim();
    if (!instruction) return _err('IMAGE_EMPTY_PROMPT', '缺少编辑指令');

    var picked = pickPreviousImage({ explicit: input.explicit, attached: input.attached, latest: input.latest }, lim);
    if (!picked.ok) return picked;
    var previousImage = picked.image;

    /* 额外参考图：去重（同一张图既是 previousImage 又当参考图没有意义） */
    var refsIn = Array.isArray(input.referenceImages) ? input.referenceImages : [];
    var refs = [];
    for (var i = 0; i < refsIn.length; i++) {
      var n = normalizeImage(refsIn[i], lim);
      if (!n.ok) return n;
      if (n.image.dataUrl === previousImage.dataUrl) continue;
      refs.push(n.image);
    }
    var budget = checkBudget(refs, lim);
    if (!budget.ok) return budget;
    refs = budget.images;

    var depth = isFinite(previousImage.editDepth) ? Math.floor(previousImage.editDepth) : 0;
    var request = {
      operation: 'edit',
      prompt: instruction,
      previousImage: previousImage,
      referenceImages: refs,
      /* 多轮编辑信号：上一张是第 N 次编辑的结果 → multiTurnEdits=N（Router 已据此判 precision） */
      multiTurnEdits: depth,
      identityPreservation: input.identityPreservation === true,
      source: String(input.source || 'chat'),
      characterId: String(input.characterId || ''),
      requestedMode: input.requestedMode,
      requestedQuality: input.requestedQuality,
      userInitiated: input.userInitiated !== false,
      background: input.background === true,
      size: String(input.size || '')
    };
    return {
      ok: true, request: request, sourceKind: picked.sourceKind,
      referenceCount: refs.length, editDepth: depth,
      previous: { imageId: previousImage.imageId || '', editDepth: depth, sourceKind: picked.sourceKind }
    };
  }

  return {
    IMAGE_EDIT_DEFAULTS: IMAGE_EDIT_DEFAULTS,
    IMAGE_EDIT_ERRORS: IMAGE_EDIT_ERRORS,
    IMAGE_SOURCE_ORDER: IMAGE_SOURCE_ORDER,
    mergeLimits: mergeLimits,
    editErrorText: editErrorText,
    parseDataUrl: parseDataUrl,
    normalizeImage: normalizeImage,
    isEditableImage: isEditableImage,
    needsShrink: needsShrink,
    checkBudget: checkBudget,
    pickPreviousImage: pickPreviousImage,
    newImageId: newImageId,
    lineageFor: lineageFor,
    lineageForGenerate: lineageForGenerate,
    buildEditRequest: buildEditRequest
  };
});
