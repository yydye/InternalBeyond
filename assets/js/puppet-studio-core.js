/* IB Puppet Studio project, raster cutout, manifest, and ZIP helpers.
   This module is deterministic and has no provider, storage, or runtime calls. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IBPuppetStudioCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var PROJECT_SCHEMA = 'internalbeyond.puppet-project.v1';
  var RUNTIME_SCHEMA = 'internalbeyond.puppet.v1';
  var MAX_LAYERS = 2048;
  var MAX_PROJECT_BYTES = 160 * 1024 * 1024;
  var MAX_IMAGE_BYTES = 18 * 1024 * 1024;
  var MAX_CUTOUT_PIXELS = 4 * 1024 * 1024;

  function clamp(value, min, max, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }
  function validId(value) { return /^[A-Za-z0-9_-]{1,48}$/.test(String(value || '')); }
  function createId(prefix) {
    var random = Math.random().toString(36).slice(2, 10);
    return String(prefix || 'item') + '-' + Date.now().toString(36) + '-' + random;
  }
  function mimeFromDataUrl(value) {
    var match = /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(String(value || ''));
    return match ? match[1].toLowerCase() : '';
  }
  function dataUrlBytes(value) {
    var mime = mimeFromDataUrl(value);
    if (!mime) throw new Error('项目素材必须是 PNG、JPG 或 WebP 图片。');
    var encoded = String(value).slice(String(value).indexOf(',') + 1);
    var raw = atob(encoded), bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { mime: mime, bytes: bytes };
  }
  function readFileDataUrl(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/i.test(String(file.type || ''))) return Promise.reject(new Error('仅支持 PNG、JPG 或 WebP 图片。'));
    if (Number(file.size) > MAX_IMAGE_BYTES) return Promise.reject(new Error('单张图片超过 18 MB，请先缩小后再导入。'));
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('无法读取所选图片。')); };
      reader.readAsDataURL(file);
    });
  }
  function loadImage(source) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('图片无法解码。')); };
      image.src = source;
    });
  }
  function cropSource(source, rect) {
    return loadImage(source).then(function (image) {
      var x = clamp(rect && rect.x, 0, image.naturalWidth - 1, 0);
      var y = clamp(rect && rect.y, 0, image.naturalHeight - 1, 0);
      var width = clamp(rect && rect.width, 1, image.naturalWidth - x, image.naturalWidth - x);
      var height = clamp(rect && rect.height, 1, image.naturalHeight - y, image.naturalHeight - y);
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width)); canvas.height = Math.max(1, Math.round(height));
      var context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, sourceRect: { x: x, y: y, width: width, height: height } };
    });
  }
  function pointInPolygon(x, y, polygon) {
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var a = polygon[i], b = polygon[j];
      if (((a.y > y) !== (b.y > y)) && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || 1e-6) + a.x) inside = !inside;
    }
    return inside;
  }
  function removeConnectedBackground(imageData, maskData, tolerance, keyColor) {
    var width = imageData.width, height = imageData.height, total = width * height;
    if (total > MAX_CUTOUT_PIXELS) throw new Error('选区超过 4 百万像素，请缩小选区后再分层。');
    var pixels = imageData.data, mask = maskData.data, visited = new Uint8Array(total), queue = new Uint32Array(total), head = 0, tail = 0;
    var color = keyColor || [255, 255, 255], limit = Math.round(clamp(tolerance, 1, 120, 24) * clamp(tolerance, 1, 120, 24) * 3);
    function matches(index) {
      if (!mask[index * 4 + 3] || !pixels[index * 4 + 3]) return false;
      var offset = index * 4, dr = pixels[offset] - color[0], dg = pixels[offset + 1] - color[1], db = pixels[offset + 2] - color[2];
      return dr * dr + dg * dg + db * db <= limit;
    }
    function seed(index) { if (!visited[index] && matches(index)) { visited[index] = 1; queue[tail++] = index; } }
    for (var x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
    for (var y = 1; y < height - 1; y++) { seed(y * width); seed(y * width + width - 1); }
    while (head < tail) {
      var current = queue[head++], cx = current % width;
      if (cx > 0) seed(current - 1);
      if (cx + 1 < width) seed(current + 1);
      if (current >= width) seed(current - width);
      if (current + width < total) seed(current + width);
    }
    for (var index = 0; index < total; index++) if (visited[index]) pixels[index * 4 + 3] = 0;
  }
  function cutoutPolygon(source, polygon, options) {
    options = options || {};
    if (!Array.isArray(polygon) || polygon.length < 3) return Promise.reject(new Error('先在画布上围出一个有效区域。'));
    return loadImage(source).then(function (image) {
      var points = polygon.map(function (point) { return { x: clamp(point.x, 0, image.naturalWidth, 0), y: clamp(point.y, 0, image.naturalHeight, 0) }; });
      var left = Math.max(0, Math.floor(Math.min.apply(Math, points.map(function (p) { return p.x; }))));
      var top = Math.max(0, Math.floor(Math.min.apply(Math, points.map(function (p) { return p.y; }))));
      var right = Math.min(image.naturalWidth, Math.ceil(Math.max.apply(Math, points.map(function (p) { return p.x; }))));
      var bottom = Math.min(image.naturalHeight, Math.ceil(Math.max.apply(Math, points.map(function (p) { return p.y; }))));
      var width = right - left, height = bottom - top;
      if (width < 4 || height < 4) throw new Error('选区太小，无法建立图层。');
      if (width * height > MAX_CUTOUT_PIXELS) throw new Error('选区超过 4 百万像素，请缩小选区后再分层。');
      var canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, left, top, width, height, 0, 0, width, height);
      var sourceCanvas = document.createElement('canvas'); sourceCanvas.width = width; sourceCanvas.height = height;
      sourceCanvas.getContext('2d').drawImage(image, left, top, width, height, 0, 0, width, height);
      var pixels = context.getImageData(0, 0, width, height), maskCanvas = document.createElement('canvas'); maskCanvas.width = width; maskCanvas.height = height;
      var maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
      maskContext.beginPath();
      points.forEach(function (point, index) { if (!index) maskContext.moveTo(point.x - left, point.y - top); else maskContext.lineTo(point.x - left, point.y - top); });
      maskContext.closePath(); maskContext.fillStyle = '#fff'; maskContext.fill();
      var mask = maskContext.getImageData(0, 0, width, height);
      if (options.removeBackground) removeConnectedBackground(pixels, mask, options.tolerance, options.keyColor || [255, 255, 255]);
      var maskBytes = mask.data, rgba = pixels.data;
      for (var index = 0; index < width * height; index++) rgba[index * 4 + 3] = Math.round(rgba[index * 4 + 3] * maskBytes[index * 4 + 3] / 255);
      context.putImageData(pixels, 0, 0);
      return { dataUrl: canvas.toDataURL('image/png'), sourceDataUrl: sourceCanvas.toDataURL('image/png'), width: width, height: height, box: { x: left, y: top, width: width, height: height } };
    });
  }
  function defaultMotions() {
    return { breath: null, gaze: null, headTurn: null, blink: null, mouth: null, actions: [] };
  }
  function defaultBones() {
    return [
      { id: 'root', name: 'Root', parent: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      { id: 'body', name: '身体', parent: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      { id: 'head', name: '头部', parent: 'body', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      { id: 'left-arm', name: '左臂', parent: 'body', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      { id: 'right-arm', name: '右臂', parent: 'body', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
    ];
  }
  function createProject(name) {
    return {
      schema: PROJECT_SCHEMA, version: 1, id: createId('puppet-project'),
      name: String(name || '未命名角色').slice(0, 80), updatedAt: new Date().toISOString(),
      reference: { assetId: '', name: '', width: 0, height: 0, dataUrl: '' },
      view: { label: '正面视图', rect: null, assetId: '', width: 0, height: 0 },
      assets: Object.create(null), canvas: { width: 800, height: 1000 },
      bones: defaultBones(), layers: [], motions: defaultMotions(),
      characterEngine: 'puppet', bundleId: '', roleId: '', aiDraft: null
    };
  }
  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object' || raw.schema !== PROJECT_SCHEMA) throw new Error('这不是可编辑的 IB Puppet 工程文件。');
    var project = createProject(raw.name);
    project.id = /^[A-Za-z0-9_-]{1,96}$/.test(String(raw.id || '')) ? String(raw.id) : createId('puppet-project');
    project.updatedAt = String(raw.updatedAt || new Date().toISOString());
    var assets = raw.assets && typeof raw.assets === 'object' ? raw.assets : {};
    Object.keys(assets).slice(0, MAX_LAYERS * 2 + 16).forEach(function (id) {
      if (!validId(id) || !mimeFromDataUrl(assets[id])) return;
      project.assets[id] = String(assets[id]);
    });
    var reference = raw.reference && typeof raw.reference === 'object' ? raw.reference : {};
    if (reference.dataUrl && mimeFromDataUrl(reference.dataUrl)) {
      project.reference = {
        assetId: String(reference.assetId || ''), name: String(reference.name || '参考图').slice(0, 160),
        width: clamp(reference.width, 1, 8192, 1), height: clamp(reference.height, 1, 8192, 1), dataUrl: String(reference.dataUrl)
      };
    }
    var view = raw.view && typeof raw.view === 'object' ? raw.view : {};
    if (view.assetId && project.assets[view.assetId]) {
      project.view = {
        label: String(view.label || '角色视图').slice(0, 32),
        rect: normalizeRect(view.rect), assetId: String(view.assetId),
        width: clamp(view.width, 1, 8192, 800), height: clamp(view.height, 1, 8192, 1000), viewId: String(view.viewId || 'front').slice(0, 32)
      };
    }
    project.canvas = {
      width: clamp(raw.canvas && raw.canvas.width, 256, 4096, project.view.width || 800),
      height: clamp(raw.canvas && raw.canvas.height, 256, 4096, project.view.height || 1000)
    };
    var bones = Array.isArray(raw.bones) ? raw.bones : [];
    project.bones = bones.slice(0, 512).filter(function (bone) { return bone && validId(bone.id); }).map(function (bone) {
      return {
        id: String(bone.id), name: String(bone.name || bone.id).slice(0, 48), parent: bone.parent && validId(bone.parent) ? String(bone.parent) : null,
        x: clamp(bone.x, -8192, 8192, 0), y: clamp(bone.y, -8192, 8192, 0),
        rotation: clamp(bone.rotation, -12.57, 12.57, 0), scaleX: clamp(bone.scaleX, .2, 5, 1), scaleY: clamp(bone.scaleY, .2, 5, 1)
      };
    });
    if (!project.bones.length) project.bones = defaultBones();
    var boneIds = new Set(project.bones.map(function (bone) { return bone.id; }));
    project.bones.forEach(function (bone) { if (bone.parent && !boneIds.has(bone.parent)) bone.parent = null; });
    var layers = Array.isArray(raw.layers) ? raw.layers : [];
    project.layers = layers.slice(0, MAX_LAYERS).filter(function (layer) { return layer && validId(layer.id) && project.assets[layer.assetId]; }).map(function (layer, index) {
      var mesh = layer.mesh && typeof layer.mesh === 'object' ? layer.mesh : null;
      var viewBox = layer.viewBox && typeof layer.viewBox === 'object' ? normalizeRect(layer.viewBox) : null;
      return {
        id: String(layer.id), name: String(layer.name || '图层 ' + (index + 1)).slice(0, 80), assetId: String(layer.assetId),
        rawAssetId: project.assets[layer.rawAssetId] ? String(layer.rawAssetId) : String(layer.assetId),
        bone: boneIds.has(String(layer.bone || '')) ? String(layer.bone) : project.bones[0].id,
        x: clamp(layer.x, -8192, 8192, 0), y: clamp(layer.y, -8192, 8192, 0), rotation: clamp(layer.rotation, -12.57, 12.57, 0),
        anchorX: clamp(layer.anchorX, 0, 1, .5), anchorY: clamp(layer.anchorY, 0, 1, .5),
        scaleX: clamp(layer.scaleX, .2, 5, 1), scaleY: clamp(layer.scaleY, .2, 5, 1),
        alpha: clamp(layer.alpha, 0, 1, 1), zIndex: clamp(layer.zIndex, -1000, 1000, index), visible: layer.visible !== false,
        viewBox: viewBox, confidence: clamp(layer.confidence, 0, 1, 0), notes: String(layer.notes || '').slice(0, 220),
        mesh: mesh ? {
          columns: Math.round(clamp(mesh.columns, 2, 32, 4)), rows: Math.round(clamp(mesh.rows, 2, 32, 6)),
          pinY: clamp(mesh.pinY, 0, 1, .15), swayX: clamp(mesh.swayX, -80, 80, 0), swayY: clamp(mesh.swayY, -80, 80, 0),
          frequency: clamp(mesh.frequency, .1, 20, .8), phase: clamp(mesh.phase, -100, 100, 0),
          stiffness: clamp(mesh.stiffness, 2, 120, 36), damping: clamp(mesh.damping, .5, 40, 9)
        } : null
      };
    });
    project.motions = normalizeMotions(raw.motions, boneIds, new Set(project.layers.map(function (layer) { return layer.id; })));
    project.bundleId = /^[0-9a-f-]{36}$/i.test(String(raw.bundleId || '')) ? String(raw.bundleId) : '';
    project.roleId = String(raw.roleId || '').slice(0, 160);
    project.aiDraft = raw.aiDraft && typeof raw.aiDraft === 'object' ? normalizeAiDraft(raw.aiDraft) : null;
    var bytes = 0;
    Object.keys(project.assets).forEach(function (id) { bytes += project.assets[id].length; });
    bytes += project.reference.dataUrl.length;
    if (bytes > MAX_PROJECT_BYTES) throw new Error('工程素材总量超过 160 MB。');
    return project;
  }
  function normalizeRect(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var x = clamp(raw.x, 0, 1, 0), y = clamp(raw.y, 0, 1, 0);
    var width = clamp(raw.width, 0, 1 - x, 0), height = clamp(raw.height, 0, 1 - y, 0);
    return width > .001 && height > .001 ? { x: x, y: y, width: width, height: height } : null;
  }
  function normalizeMotions(raw, boneIds, layerIds) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var out = defaultMotions();
    var breath = raw.breath;
    if (breath && boneIds.has(String(breath.boneId || ''))) out.breath = {
      boneId: String(breath.boneId), periodSeconds: clamp(breath.periodSeconds, 1, 30, 4), amplitudeY: clamp(breath.amplitudeY, -80, 80, 0), scaleY: clamp(breath.scaleY, -.1, .1, 0)
    };
    var gaze = raw.gaze;
    if (gaze && boneIds.has(String(gaze.boneId || ''))) out.gaze = {
      boneId: String(gaze.boneId), periodSeconds: clamp(gaze.periodSeconds, 1, 30, 5), amplitudeX: clamp(gaze.amplitudeX, -32, 32, 0), amplitudeY: clamp(gaze.amplitudeY, -24, 24, 0)
    };
    var headTurn = raw.headTurn;
    if (headTurn && boneIds.has(String(headTurn.boneId || ''))) out.headTurn = {
      boneId: String(headTurn.boneId), periodSeconds: clamp(headTurn.periodSeconds, 1.5, 30, 6),
      amplitudeX: clamp(headTurn.amplitudeX, -12, 12, 0), amplitudeRotation: clamp(headTurn.amplitudeRotation, -.35, .35, 0)
    };
    var blink = raw.blink;
    if (blink) {
      var blinkPairs = Array.isArray(blink.pairs) ? blink.pairs : [];
      if (!blinkPairs.length && layerIds.has(String(blink.openLayerId || '')) && layerIds.has(String(blink.closedLayerId || ''))) {
        blinkPairs = [{ id: 'blink-main', openLayerIds: [String(blink.openLayerId)], closedLayerId: String(blink.closedLayerId) }];
      }
      blinkPairs = blinkPairs.slice(0, 4).map(function (pair, index) {
        var openIds = Array.isArray(pair && pair.openLayerIds) ? pair.openLayerIds : [pair && pair.openLayerId];
        openIds = openIds.map(String).filter(function (id) { return layerIds.has(id); }).slice(0, 8);
        var closedId = String(pair && pair.closedLayerId || '');
        if (!openIds.length || !layerIds.has(closedId) || openIds.indexOf(closedId) >= 0) return null;
        return { id: validId(pair.id) ? String(pair.id) : 'blink-' + (index + 1), side: String(pair.side || '').slice(0, 8), openLayerIds: openIds, closedLayerId: closedId };
      }).filter(Boolean);
      if (blinkPairs.length) out.blink = {
        openLayerId: blinkPairs[0].openLayerIds[0], closedLayerId: blinkPairs[0].closedLayerId, pairs: blinkPairs,
        minIntervalSeconds: clamp(blink.minIntervalSeconds, 1, 30, 2.8),
        maxIntervalSeconds: clamp(blink.maxIntervalSeconds, 1, 60, 5.2), durationSeconds: clamp(blink.durationSeconds, .08, 1, .18)
      };
    }
    var mouth = raw.mouth;
    if (mouth && layerIds.has(String(mouth.openLayerId || '')) && layerIds.has(String(mouth.closedLayerId || ''))) out.mouth = {
      openLayerId: String(mouth.openLayerId), closedLayerId: String(mouth.closedLayerId), sensitivity: clamp(mouth.sensitivity, .2, 3, 1)
    };
    out.actions = (Array.isArray(raw.actions) ? raw.actions : []).slice(0, 128).filter(function (action) { return action && validId(action.id); }).map(function (action) {
      var duration = clamp(action.durationSeconds, .15, 60, 1);
      return {
        id: String(action.id), label: String(action.label || action.id).slice(0, 24), durationSeconds: duration,
        fadeInSeconds: clamp(action.fadeInSeconds, 0, 5, .12), fadeOutSeconds: clamp(action.fadeOutSeconds, 0, 5, .12),
        keyframes: (Array.isArray(action.keyframes) ? action.keyframes : []).slice(0, 8192).filter(function (frame) {
          return frame && ((frame.boneId && boneIds.has(String(frame.boneId))) || (frame.layerId && layerIds.has(String(frame.layerId))));
        }).map(function (frame) {
          var target = frame.boneId ? { boneId: String(frame.boneId) } : { layerId: String(frame.layerId) }, result = Object.assign({ at: clamp(frame.at, 0, duration, 0), easing: ['linear', 'smooth', 'easeIn', 'easeOut', 'easeInOut'].indexOf(frame.easing) >= 0 ? frame.easing : 'smooth' }, target);
          ['x', 'y'].forEach(function (key) { if (Number.isFinite(Number(frame[key]))) result[key] = clamp(frame[key], -8192, 8192, 0); });
          ['rotation'].forEach(function (key) { if (Number.isFinite(Number(frame[key]))) result[key] = clamp(frame[key], -12.57, 12.57, 0); });
          ['scaleX', 'scaleY'].forEach(function (key) { if (Number.isFinite(Number(frame[key]))) result[key] = clamp(frame[key], .2, 5, 1); });
          if (Number.isFinite(Number(frame.alpha))) result.alpha = clamp(frame.alpha, 0, 1, 1);
          return result;
        })
      };
    });
    out.actions.forEach(function (action) { action.keyframes.sort(function (left, right) { return left.at - right.at; }); });
    return out;
  }
  function normalizeAiDraft(raw) {
    var draft = { providerId: String(raw.providerId || '').slice(0, 160), createdAt: String(raw.createdAt || ''), activeViewId: String(raw.activeViewId || 'front').slice(0, 32), views: [], parts: [], bones: [], motions: null, notes: [] };
    if (Array.isArray(raw.views)) draft.views = raw.views.slice(0, 8).map(function (view, index) {
      return { id: validId(view.id) ? String(view.id) : 'view-' + index, label: String(view.label || '视图 ' + (index + 1)).slice(0, 32), box: normalizeRect(view.box), confidence: clamp(view.confidence, 0, 1, .4), note: String(view.note || '').slice(0, 180) };
    }).filter(function (view) { return view.box; });
    if (Array.isArray(raw.parts)) draft.parts = raw.parts.slice(0, 48).map(function (part, index) {
      return { id: validId(part.id) ? String(part.id) : 'part-' + index, label: String(part.label || '图层建议 ' + (index + 1)).slice(0, 48), viewId: String(part.viewId || 'front').slice(0, 32), box: normalizeRect(part.box), boneId: validId(part.boneId) ? String(part.boneId) : 'root', anchorX: clamp(part.anchorX, 0, 1, .5), anchorY: clamp(part.anchorY, 0, 1, .5), zIndex: Math.round(clamp(part.zIndex, -1000, 1000, index)), confidence: clamp(part.confidence, 0, 1, .35), occlusion: String(part.occlusion || '').slice(0, 180) };
    }).filter(function (part) { return part.box; });
    if (Array.isArray(raw.bones)) draft.bones = raw.bones.slice(0, 64).map(function (bone) {
      return { id: validId(bone.id) ? String(bone.id) : '', name: String(bone.name || bone.id || '骨骼').slice(0, 48), parent: validId(bone.parent) ? String(bone.parent) : null, x: clamp(bone.x, -8192, 8192, 0), y: clamp(bone.y, -8192, 8192, 0), rotation: clamp(bone.rotation, -12.57, 12.57, 0) };
    }).filter(function (bone) { return bone.id; });
    if (raw.motions && typeof raw.motions === 'object') draft.motions = raw.motions;
    if (Array.isArray(raw.notes)) draft.notes = raw.notes.slice(0, 16).map(function (note) { return String(note || '').slice(0, 240); });
    return draft;
  }
  function toRuntimeManifest(project) {
    project = normalizeProject(project);
    if (!project.layers.length) throw new Error('至少建立一个真实图层后才能导出运行包。');
    var animatedLayerIds = new Set(), motions = project.motions || defaultMotions();
    function requireLayer(id) { if (id) animatedLayerIds.add(String(id)); }
    if (motions.blink) {
      var blinkPairs = Array.isArray(motions.blink.pairs) && motions.blink.pairs.length ? motions.blink.pairs : [motions.blink];
      blinkPairs.forEach(function (pair) { (Array.isArray(pair.openLayerIds) ? pair.openLayerIds : [pair.openLayerId]).forEach(requireLayer); requireLayer(pair.closedLayerId); });
    }
    if (motions.mouth) { requireLayer(motions.mouth.openLayerId); requireLayer(motions.mouth.closedLayerId); }
    motions.actions.forEach(function (action) { (action.keyframes || []).forEach(function (frame) { requireLayer(frame.layerId); }); });
    var manifest = {
      schema: RUNTIME_SCHEMA, name: project.name, canvas: project.canvas,
      bones: project.bones.map(function (bone) { return { id: bone.id, parent: bone.parent, x: bone.x, y: bone.y, rotation: bone.rotation, scaleX: bone.scaleX, scaleY: bone.scaleY }; }),
      layers: project.layers.filter(function (layer) { return layer.visible !== false || animatedLayerIds.has(layer.id); }).map(function (layer) {
        var mime = mimeFromDataUrl(project.assets[layer.assetId]) || 'image/png', extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
        var result = { id: layer.id, name: layer.name, src: 'layers/' + layer.assetId + '.' + extension, bone: layer.bone, x: layer.x, y: layer.y, rotation: layer.rotation, anchorX: layer.anchorX, anchorY: layer.anchorY, scaleX: layer.scaleX, scaleY: layer.scaleY, alpha: layer.alpha, zIndex: layer.zIndex };
        if (layer.mesh) result.mesh = layer.mesh;
        return result;
      }),
      motions: Object.assign({}, project.motions, { actions: project.motions.actions.filter(function (action) { return Array.isArray(action.keyframes) && action.keyframes.length > 0; }) })
    };
    if (!manifest.layers.length) throw new Error('所有图层都已隐藏，无法导出。');
    return manifest;
  }
  function utf8(value) { return new TextEncoder().encode(String(value)); }
  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function zipStore(files) {
    var locals = [], central = [], offset = 0, date = new Date(), dosTime = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | (Math.floor(date.getSeconds() / 2) & 31);
    var dosDate = (((Math.max(1980, date.getFullYear()) - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    files.forEach(function (file) {
      var name = utf8(file.path), bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes), crc = crc32(bytes);
      var local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30);
      locals.push(local, bytes);
      var entry = new Uint8Array(46 + name.length), cv = new DataView(entry.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true); cv.setUint32(42, offset, true); entry.set(name, 46); central.push(entry);
      offset += local.length + bytes.length;
    });
    var centralSize = central.reduce(function (sum, entry) { return sum + entry.length; }, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    return new Blob(locals.concat(central, [end]), { type: 'application/zip' });
  }
  return Object.freeze({
    PROJECT_SCHEMA: PROJECT_SCHEMA, RUNTIME_SCHEMA: RUNTIME_SCHEMA, MAX_LAYERS: MAX_LAYERS, MAX_PROJECT_BYTES: MAX_PROJECT_BYTES, MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    clamp: clamp, createId: createId, createProject: createProject, defaultBones: defaultBones, defaultMotions: defaultMotions, normalizeProject: normalizeProject, normalizeRect: normalizeRect,
    normalizeAiDraft: normalizeAiDraft, readFileDataUrl: readFileDataUrl, loadImage: loadImage, mimeFromDataUrl: mimeFromDataUrl, dataUrlBytes: dataUrlBytes,
    cropSource: cropSource, cutoutPolygon: cutoutPolygon, toRuntimeManifest: toRuntimeManifest, zipStore: zipStore, crc32: crc32
  });
});
