/* IB Puppet: a small declarative 2D puppet renderer for call-stage presentation.
   PixiJS is used only as the MIT canvas renderer; neither Cubism Core nor the
   Live2D runtime is loaded here. VoiceCall remains the authority for state/TTS. */
(function (NS) {
  'use strict';

  var PIXI_SCRIPT = 'assets/vendor/live2d/pixi.min.js';
  var pixiPromise = null;
  var activeCall = null;
  var motionProperties = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'alpha'];
  var MAX_BONES = 512, MAX_LAYERS = 2048, MAX_ACTIONS = 128, MAX_KEYFRAMES = 8192;

  function clamp(value, min, max, fallback) {
    value = Number(value);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  function isReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      || document.documentElement.dataset.reducedMotion === 'true'
      || document.documentElement.dataset.motion === 'off'
      || (document.body && (document.body.dataset.reducedMotion === 'true' || document.body.dataset.motion === 'off'));
  }
  function detectDisplayRate() {
    return new Promise(function (resolve) {
      var stamps = [], last = 0, count = 0;
      function sample(now) {
        if (last) {
          var delta = now - last;
          if (count > 8 && delta >= 3 && delta <= 50) stamps.push(delta);
        }
        last = now; count++;
        if (count < 48) { requestAnimationFrame(sample); return; }
        stamps.sort(function (a, b) { return a - b; });
        var median = stamps.length ? stamps[Math.floor(stamps.length / 2)] : 1000 / 60;
        resolve(clamp(1000 / median, 30, 240, 60));
      }
      requestAnimationFrame(sample);
    }).catch(function () { return 60; });
  }
  function quantizedRate(value) {
    return value >= 100 ? 120 : (value >= 48 ? 60 : 30);
  }
  function requestedRate(role, displayRate) {
    var raw = String(role && role.puppetFrameRate || 'auto');
    var requested = raw === 'auto' ? quantizedRate(displayRate) : Number(raw);
    if ([30, 60, 120].indexOf(requested) < 0) requested = quantizedRate(displayRate);
    return Math.min(requested, quantizedRate(displayRate));
  }
  function appendPixi() {
    return new Promise(function (resolve, reject) {
      if (window.PIXI && window.PIXI.Application && window.PIXI.Sprite) { resolve(); return; }
      var scripts = document.querySelectorAll('script[data-ib-puppet-pixi]'), existing = scripts.length ? scripts[0] : null;
      if (existing) {
        if (existing.dataset.loaded === 'true') { resolve(); return; }
        if (existing.dataset.failed === 'true') { existing.remove(); existing = null; }
      }
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', function () { reject(new Error('PIXI_LOAD_FAILED')); }, { once: true });
        return;
      }
      var script = document.createElement('script');
      script.src = PIXI_SCRIPT; script.async = false; script.dataset.ibPuppetPixi = 'true';
      script.onload = function () { script.dataset.loaded = 'true'; window.PIXI && window.PIXI.Application ? resolve() : reject(new Error('PIXI_RUNTIME_MISSING')); };
      script.onerror = function () { script.dataset.failed = 'true'; reject(new Error('PIXI_LOAD_FAILED')); };
      (document.head || document.documentElement).appendChild(script);
    });
  }
  function ensurePixi() {
    if (!pixiPromise) pixiPromise = appendPixi().catch(function (error) { pixiPromise = null; throw error; });
    return pixiPromise;
  }
  function safeLayerUrl(manifestUrl, source, allowInline) {
    source = String(source || '').trim();
    if (allowInline && source.length <= 24 * 1024 * 1024 && /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(source)) return source;
    if (!source || source.indexOf('\\') >= 0 || source.indexOf(':') >= 0 || source.charAt(0) === '/' || source.charAt(0) === '\\') throw new Error('PUPPET_PATH_REJECTED');
    var parts = source.split('/');
    if (parts.some(function (part) { return !part || part === '.' || part === '..'; })) throw new Error('PUPPET_PATH_REJECTED');
    if (!/\.(png|jpe?g|webp)$/i.test(source)) throw new Error('PUPPET_IMAGE_TYPE_UNSUPPORTED');
    var url = new URL(source, manifestUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'tauri:') throw new Error('PUPPET_PATH_REJECTED');
    if (url.username || url.password || url.origin !== new URL(manifestUrl).origin) throw new Error('PUPPET_PATH_REJECTED');
    return url.href;
  }
  function validateManifest(value) {
    if (!value || value.schema !== 'internalbeyond.puppet.v1') throw new Error('PUPPET_SCHEMA_UNSUPPORTED');
    var canvas = value.canvas || {};
    if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width < 256 || canvas.width > 4096 || canvas.height < 256 || canvas.height > 4096) throw new Error('PUPPET_CANVAS_INVALID');
    if (!Array.isArray(value.bones) || !value.bones.length || value.bones.length > MAX_BONES || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > MAX_LAYERS) throw new Error('PUPPET_COMPONENT_LIMIT_EXCEEDED');
    var boneIds = new Set(), layerIds = new Set();
    value.bones.forEach(function (bone) {
      if (!bone || !/^[A-Za-z0-9_-]{1,48}$/.test(String(bone.id || '')) || boneIds.has(bone.id)) throw new Error('PUPPET_BONE_INVALID');
      boneIds.add(bone.id);
    });
    value.bones.forEach(function (bone) {
      if (bone.parent && !boneIds.has(bone.parent)) throw new Error('PUPPET_BONE_INVALID');
      var seen = new Set(), cursor = bone;
      while (cursor) {
        if (seen.has(cursor.id)) throw new Error('PUPPET_BONE_CYCLE');
        seen.add(cursor.id);
        cursor = cursor.parent ? value.bones.find(function (item) { return item.id === cursor.parent; }) : null;
      }
    });
    var totalMeshVertices = 0;
    value.layers.forEach(function (layer) {
      if (!layer || !/^[A-Za-z0-9_-]{1,48}$/.test(String(layer.id || '')) || layerIds.has(layer.id) || !boneIds.has(layer.bone)) throw new Error('PUPPET_LAYER_INVALID');
      layerIds.add(layer.id);
      if (!Number.isFinite(Number(layer.x || 0)) || !Number.isFinite(Number(layer.y || 0))
        || !Number.isFinite(Number(layer.rotation || 0))
        || !Number.isFinite(Number(layer.anchorX == null ? .5 : layer.anchorX))
        || !Number.isFinite(Number(layer.anchorY == null ? .5 : layer.anchorY))
        || !Number.isFinite(Number(layer.scaleX == null ? 1 : layer.scaleX))
        || !Number.isFinite(Number(layer.scaleY == null ? 1 : layer.scaleY))
        || !Number.isFinite(Number(layer.alpha == null ? 1 : layer.alpha))) throw new Error('PUPPET_LAYER_INVALID');
      if (layer.mesh) {
        var cols = Number(layer.mesh.columns), rows = Number(layer.mesh.rows), vertices = cols * rows;
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 32 || rows < 2 || rows > 32
          || vertices > 1024 || !Number.isFinite(Number(layer.mesh.swayX || 0)) || !Number.isFinite(Number(layer.mesh.swayY || 0))) throw new Error('PUPPET_MESH_INVALID');
        totalMeshVertices += vertices;
        if (totalMeshVertices > 65536) throw new Error('PUPPET_MESH_LIMIT_EXCEEDED');
      }
    });
    var motions = value.motions || {};
    if (motions.breath && !boneIds.has(motions.breath.boneId)) throw new Error('PUPPET_MOTION_INVALID');
    if (motions.gaze && !boneIds.has(motions.gaze.boneId)) throw new Error('PUPPET_GAZE_INVALID');
    if (motions.headTurn && !boneIds.has(motions.headTurn.boneId)) throw new Error('PUPPET_MOTION_INVALID');
    if (motions.blink) {
      var blinkPairs = Array.isArray(motions.blink.pairs) && motions.blink.pairs.length ? motions.blink.pairs : [motions.blink];
      if (blinkPairs.length > 4 || blinkPairs.some(function (pair) {
        var openIds = Array.isArray(pair.openLayerIds) ? pair.openLayerIds : [pair.openLayerId];
        return !layerIds.has(String(pair.closedLayerId || '')) || !openIds.length || openIds.length > 8
          || openIds.some(function (id) { return !layerIds.has(String(id || '')); });
      })) throw new Error('PUPPET_MOTION_INVALID');
    }
    if (motions.mouth && (!layerIds.has(motions.mouth.closedLayerId) || !layerIds.has(motions.mouth.openLayerId))) throw new Error('PUPPET_MOTION_INVALID');
    var actions = Array.isArray(motions.actions) ? motions.actions : [];
    if (actions.length > MAX_ACTIONS) throw new Error('PUPPET_ACTION_LIMIT_EXCEEDED');
    var totalKeyframes = 0;
    actions.forEach(function (action) {
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(String(action && action.id || '')) || !Array.isArray(action.keyframes) || action.keyframes.length > MAX_KEYFRAMES) throw new Error('PUPPET_ACTION_INVALID');
      totalKeyframes += action.keyframes.length;
      if (totalKeyframes > MAX_KEYFRAMES) throw new Error('PUPPET_ACTION_LIMIT_EXCEEDED');
      action.keyframes.forEach(function (frame) {
        var hasBone = !!frame.boneId, hasLayer = !!frame.layerId;
        if (hasBone === hasLayer || (hasBone && !boneIds.has(frame.boneId)) || (hasLayer && !layerIds.has(frame.layerId))) throw new Error('PUPPET_ACTION_INVALID');
        if (frame.easing && ['linear', 'smooth', 'easeIn', 'easeOut', 'easeInOut'].indexOf(frame.easing) < 0) throw new Error('PUPPET_ACTION_INVALID');
      });
    });
    return value;
  }
  function loadTexture(url) {
    return new Promise(function (resolve, reject) {
      var texture;
      try { texture = window.PIXI.Texture.from(url); } catch (error) { reject(error); return; }
      var base = texture && texture.baseTexture;
      if (!base) { reject(new Error('PUPPET_TEXTURE_INVALID')); return; }
      if (base.valid) { resolve(texture); return; }
      var settled = false;
      function done(error) {
        if (settled) return; settled = true;
        if (base.off) { base.off('loaded', onLoad); base.off('error', onError); }
        if (error) reject(error); else resolve(texture);
      }
      function onLoad() { done(); }
      function onError() { done(new Error('PUPPET_TEXTURE_LOAD_FAILED')); }
      if (base.once) { base.once('loaded', onLoad); base.once('error', onError); }
      else { base.on('loaded', onLoad); base.on('error', onError); }
      window.setTimeout(function () { if (!base.valid) done(new Error('PUPPET_TEXTURE_TIMEOUT')); }, 15000);
    });
  }
  function spriteFor(layer, texture) {
    var sprite, mesh = layer.mesh;
    if (mesh && window.PIXI.SimpleMesh) {
      var columns = clamp(mesh.columns, 2, 32, 2), rows = clamp(mesh.rows, 2, 32, 2);
      var width = Math.max(1, texture.width || texture.orig.width || 1), height = Math.max(1, texture.height || texture.orig.height || 1);
      var anchorX = clamp(layer.anchorX, 0, 1, .5), anchorY = clamp(layer.anchorY, 0, 1, .5);
      var vertices = new Float32Array(columns * rows * 2), uvs = new Float32Array(columns * rows * 2), indices = new Uint16Array((columns - 1) * (rows - 1) * 6);
      for (var row = 0; row < rows; row++) {
        for (var column = 0; column < columns; column++) {
          var index = row * columns + column, u = column / (columns - 1), v = row / (rows - 1), offset = index * 2;
          vertices[offset] = (u - anchorX) * width; vertices[offset + 1] = (v - anchorY) * height;
          uvs[offset] = u; uvs[offset + 1] = v;
          if (column < columns - 1 && row < rows - 1) {
            var cell = (row * (columns - 1) + column) * 6, a = index, b = index + 1, c = index + columns, d = c + 1;
            indices[cell] = a; indices[cell + 1] = b; indices[cell + 2] = c;
            indices[cell + 3] = b; indices[cell + 4] = d; indices[cell + 5] = c;
          }
        }
      }
      sprite = new window.PIXI.SimpleMesh(texture, vertices, uvs, indices, window.PIXI.DRAW_MODES.TRIANGLES);
      sprite.autoUpdate = false;
      var vertexCount = rows * columns, rowInfluence = new Float32Array(rows), springX = new Float32Array(vertexCount), springY = new Float32Array(vertexCount);
      var velocityX = new Float32Array(vertexCount), velocityY = new Float32Array(vertexCount), pinY = clamp(mesh.pinY, 0, 1, .2);
      for (var pinRow = 0; pinRow < rows; pinRow++) rowInfluence[pinRow] = Math.max(0, (pinRow / (rows - 1) - pinY) / Math.max(.01, 1 - pinY));
      sprite._ibPuppetMesh = {
        baseVertices: new Float32Array(vertices), vertices: sprite.vertices, columns: columns, rows: rows, rowInfluence: rowInfluence,
        swayX: clamp(mesh.swayX, -80, 80, 0), swayY: clamp(mesh.swayY, -80, 80, 0),
        frequency: clamp(mesh.frequency, .1, 20, 1), phase: clamp(mesh.phase, -100, 100, 0),
        stiffness: clamp(mesh.stiffness, 2, 120, 34), damping: clamp(mesh.damping, .5, 40, 9),
        springX: springX, springY: springY, velocityX: velocityX, velocityY: velocityY
      };
    } else {
      sprite = new window.PIXI.Sprite(texture);
      sprite.anchor.set(clamp(layer.anchorX, 0, 1, .5), clamp(layer.anchorY, 0, 1, .5));
    }
    sprite.position.set(clamp(layer.x, -8192, 8192, 0), clamp(layer.y, -8192, 8192, 0));
    sprite.rotation = clamp(layer.rotation, -12.57, 12.57, 0);
    sprite.scale.set(clamp(layer.scaleX, .2, 5, 1), clamp(layer.scaleY, .2, 5, 1));
    sprite.alpha = clamp(layer.alpha, 0, 1, 1);
    sprite.zIndex = clamp(layer.zIndex, -1000, 1000, 0);
    return sprite;
  }
  function layerBase(layer) {
    return { x: clamp(layer.x, -8192, 8192, 0), y: clamp(layer.y, -8192, 8192, 0), rotation: clamp(layer.rotation, -12.57, 12.57, 0), scaleX: clamp(layer.scaleX, .2, 5, 1), scaleY: clamp(layer.scaleY, .2, 5, 1), alpha: clamp(layer.alpha, 0, 1, 1) };
  }
  function boneBase(bone) {
    return {
      x: clamp(bone.x, -8192, 8192, 0), y: clamp(bone.y, -8192, 8192, 0),
      rotation: clamp(bone.rotation, -12.57, 12.57, 0),
      scaleX: clamp(bone.scaleX, .2, 5, 1), scaleY: clamp(bone.scaleY, .2, 5, 1)
    };
  }
  function fit(state) {
    if (!state || state.cancelled || !state.app || !state.world) return;
    var rect = state.layer.getBoundingClientRect(), width = Math.max(1, rect.width), height = Math.max(1, rect.height);
    state.app.renderer.resize(width, height);
    var canvas = state.manifest.canvas;
    var roleScale = clamp(state.role.puppetScale, 75, 135, 100) / 100;
    var scale = Math.min(width / canvas.width, height / canvas.height) * roleScale;
    state.world.scale.set(scale);
    var offsetX = clamp(state.role.puppetOffsetX, -20, 20, 0) / 100;
    var offsetY = clamp(state.role.puppetOffsetY, -30, 20, 0) / 100;
    state.world.position.set((width - canvas.width * scale) / 2 + width * offsetX, (height - canvas.height * scale) / 2 + height * offsetY);
  }
  function setLayerVisible(state, id, visible) {
    var sprite = state.layerNodes[id];
    if (sprite) sprite.visible = !!visible;
  }
  function compileActions(state, actions) {
    var slotsByKey = Object.create(null), slots = [];
    (actions || []).forEach(function (action) {
      var tracks = action.tracks = [], tracksByKey = Object.create(null);
      (action.keyframes || []).forEach(function (frame) {
        var target = frame.boneId ? 'b:' + frame.boneId : 'l:' + frame.layerId;
        motionProperties.forEach(function (property) {
          if (target.charAt(0) === 'b' && property === 'alpha') return;
          if (!Number.isFinite(Number(frame[property]))) return;
          var trackKey = target + ':' + property, track = tracksByKey[trackKey];
          if (!track) {
            var isBone = target.charAt(0) === 'b', id = target.slice(2);
            var object = isBone ? state.bones[id] : state.layerTransforms[id];
            if (!object) return;
            var slot = slotsByKey[trackKey];
            if (!slot) {
              slot = slotsByKey[trackKey] = { object: object, property: property, base: object.base[property], weighted: 0, weight: 0 };
              slots.push(slot);
            }
            track = tracksByKey[trackKey] = { key: trackKey, slot: slot, points: [] }; tracks.push(track);
          }
          track.points.push({ at: Number(frame.at) || 0, value: Number(frame[property]), easing: frame.easing || 'smooth' });
        });
      });
      tracks.forEach(function (track) { track.points.sort(function (a, b) { return a.at - b.at; }); });
      action.durationSeconds = clamp(action.durationSeconds, .15, 60, 1);
      action.fadeInSeconds = clamp(action.fadeInSeconds, 0, 5, .12);
      action.fadeOutSeconds = clamp(action.fadeOutSeconds, 0, 5, .12);
    });
    state.motionSlots = slots;
  }
  function easeAmount(value, style) {
    value = clamp(value, 0, 1, 0);
    if (style === 'linear') return value;
    if (style === 'easeIn') return value * value;
    if (style === 'easeOut') return 1 - (1 - value) * (1 - value);
    if (style === 'easeInOut') return value < .5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
    return value * value * (3 - 2 * value);
  }
  function sampleTrack(points, time, fallback, track) {
    if (!points || !points.length) return fallback;
    if (time <= points[0].at) return points[0].value;
    var last = points.length - 1;
    if (time >= points[last].at) return points[last].value;
    var low = 0, high = last;
    while (low + 1 < high) {
      var middle = (low + high) >> 1;
      if (time < points[middle].at) high = middle; else low = middle;
    }
    var previous = points[low], next = points[high], span = Math.max(.0001, next.at - previous.at);
    var amount = easeAmount((time - previous.at) / span, next.easing || 'smooth');
    var difference = next.value - previous.value;
    if (track && track.key.endsWith(':rotation')) difference = ((difference + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return previous.value + difference * amount;
  }
  function applyActions(state, now) {
    var actions = state.activeActions, slots = state.motionSlots;
    for (var b = 0; b < state.boneList.length; b++) {
      var bone = state.boneList[b]; bone.x = bone.base.x; bone.y = bone.base.y; bone.rotation = bone.base.rotation;
      bone.scaleX = bone.base.scaleX; bone.scaleY = bone.base.scaleY;
    }
    for (var l = 0; l < state.layerTransformList.length; l++) {
      var layer = state.layerTransformList[l]; layer.x = layer.base.x; layer.y = layer.base.y;
      layer.rotation = layer.base.rotation; layer.scaleX = layer.base.scaleX; layer.scaleY = layer.base.scaleY; layer.alpha = layer.base.alpha;
    }
    for (var s = 0; s < slots.length; s++) { slots[s].weighted = 0; slots[s].weight = 0; }
    var kept = 0;
    for (var actionIndex = 0; actionIndex < actions.length; actionIndex++) {
      var entry = actions[actionIndex];
      var action = entry.action, elapsed = Math.max(0, (now - entry.startedAt) / 1000);
      if (!entry.fadeOutAt && elapsed >= action.durationSeconds) entry.fadeOutAt = entry.startedAt + action.durationSeconds * 1000;
      var weight = entry.skipFadeIn ? 1 : (action.fadeInSeconds > 0 ? Math.min(1, elapsed / action.fadeInSeconds) : 1);
      if (entry.fadeOutAt) {
        var fadeElapsed = Math.max(0, now - entry.fadeOutAt);
        weight *= action.fadeOutSeconds > 0 ? 1 - clamp(fadeElapsed / (action.fadeOutSeconds * 1000), 0, 1, 1) : 0;
      }
      entry.weight = weight;
      if (weight <= .001 && entry.fadeOutAt) continue;
      actions[kept++] = entry;
      var seconds = clamp(elapsed, 0, action.durationSeconds, 0);
      for (var trackIndex = 0; trackIndex < action.tracks.length; trackIndex++) {
        var track = action.tracks[trackIndex];
        var slot = track.slot;
        slot.weighted += sampleTrack(track.points, seconds, slot.base, track) * weight; slot.weight += weight;
      }
    }
    actions.length = kept;
    for (var slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      var item = slots[slotIndex], total = Math.min(1, item.weight);
      if (!item.weight) continue;
      item.object[item.property] = item.weight > 1 ? item.weighted / item.weight : item.base * (1 - total) + item.weighted;
    }
  }
  function changeTargetFps(state, target, now) {
    if (state.targetFps === target) return;
    state.targetFps = target;
    state.renderFrames = 0;
    state.frameSampleStart = now;
  }
  function setPointIfChanged(point, x, y) {
    if (Math.abs(point.x - x) > .0001 || Math.abs(point.y - y) > .0001) point.set(x, y);
  }
  function updateMesh(state, layer, seconds, deltaSeconds) {
    var mesh = layer.meshState;
    if (!mesh) return;
    var dt = clamp(deltaSeconds, 0, .05, 1 / 120);
    var boneMotion = layer.bone.worldRotation - layer.bone.base.rotation;
    var meshState = layer.node._ibPuppetMesh, rowInfluence = mesh.rowInfluence, columns = mesh.columns;
    for (var row = 0; row < mesh.rows; row++) {
      var influence = rowInfluence[row];
      if (!influence) continue;
      for (var column = 0; column < columns; column++) {
        var index = row * columns + column, sidePhase = (column / Math.max(1, columns - 1) - .5) * .72;
        var phase = seconds * Math.PI * 2 * mesh.frequency + mesh.phase + sidePhase;
        var targetX = (mesh.swayX * Math.sin(phase) + boneMotion * 10) * influence;
        var targetY = mesh.swayY * Math.cos(phase + .35) * influence;
        var steps = Math.max(1, Math.min(8, Math.ceil(dt * 120))), step = dt / steps;
        var positionX = mesh.springX[index], velocityX = mesh.velocityX[index], positionY = mesh.springY[index], velocityY = mesh.velocityY[index];
        for (var stepIndex = 0; stepIndex < steps; stepIndex++) {
          velocityX += (targetX - positionX) * mesh.stiffness * step; velocityX *= Math.exp(-mesh.damping * step); positionX += velocityX * step;
          velocityY += (targetY - positionY) * mesh.stiffness * step; velocityY *= Math.exp(-mesh.damping * step); positionY += velocityY * step;
        }
        mesh.springX[index] = positionX; mesh.velocityX[index] = velocityX;
        mesh.springY[index] = positionY; mesh.velocityY[index] = velocityY;
      }
    }
    var vertices = mesh.vertices, base = mesh.baseVertices, columns = mesh.columns, rows = mesh.rows;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < columns; x++) {
        var point = y * columns + x, offset = point * 2;
        vertices[offset] = base[offset] + mesh.springX[point]; vertices[offset + 1] = base[offset + 1] + mesh.springY[point];
      }
    }
    var buffers = layer.node.geometry && layer.node.geometry.buffers;
    if (buffers && buffers[0] && typeof buffers[0].update === 'function') buffers[0].update();
    else if (meshState && typeof meshState.invalidate === 'function') meshState.invalidate();
    mesh.isRest = false;
  }
  function resetMesh(layer) {
    var mesh = layer.meshState;
    if (!mesh || mesh.isRest) return;
    mesh.vertices.set(mesh.baseVertices); mesh.springX.fill(0); mesh.springY.fill(0); mesh.velocityX.fill(0); mesh.velocityY.fill(0);
    var buffers = layer.node.geometry && layer.node.geometry.buffers;
    if (buffers && buffers[0] && typeof buffers[0].update === 'function') buffers[0].update();
    mesh.isRest = true;
  }
  function animate(state, deltaSeconds, now) {
    if (state.cancelled || !state.app || !state.manifest) return;
    now = Number(now) || performance.now();
    var seconds = (now - state.startedAt) / 1000, motions = state.manifest.motions || {}, reduced = isReducedMotion();
    if (reduced) state.activeActions.length = 0;
    applyActions(state, now);
    if (!reduced && motions.breath) {
      var breath = motions.breath, bone = state.bones[breath.boneId];
      if (bone) {
        var wave = Math.sin(seconds * Math.PI * 2 / clamp(breath.periodSeconds, 1, 30, 4));
        bone.y += wave * clamp(breath.amplitudeY, -80, 80, 0);
        bone.scaleY *= 1 + wave * clamp(breath.scaleY, -.1, .1, 0);
      }
    }
    if (!reduced && motions.gaze) {
      var gaze = motions.gaze, gazeBone = state.bones[gaze.boneId];
      if (gazeBone) {
        var gazePhase = seconds * Math.PI * 2 / clamp(gaze.periodSeconds, 1, 30, 5);
        gazeBone.x += Math.sin(gazePhase) * clamp(gaze.amplitudeX, -32, 32, 0);
        gazeBone.y += Math.sin(gazePhase * .63 + .8) * clamp(gaze.amplitudeY, -24, 24, 0);
      }
    }
    if (!reduced && motions.headTurn) {
      var turn = motions.headTurn, turnBone = state.bones[turn.boneId];
      if (turnBone) {
        var turnPhase = seconds * Math.PI * 2 / clamp(turn.periodSeconds, 1.5, 30, 6);
        turnBone.x += Math.sin(turnPhase) * clamp(turn.amplitudeX, -12, 12, 0);
        turnBone.rotation += Math.sin(turnPhase * .73 + .4) * clamp(turn.amplitudeRotation, -.35, .35, 0);
      }
    }
    for (var i = 0; i < state.boneList.length; i++) {
      var current = state.boneList[i], parent = current.parentBone;
      if (parent) {
        var localX = current.x * parent.worldScaleX, localY = current.y * parent.worldScaleY;
        var cosine = Math.cos(parent.worldRotation), sine = Math.sin(parent.worldRotation);
        current.worldX = parent.worldX + cosine * localX - sine * localY;
        current.worldY = parent.worldY + sine * localX + cosine * localY;
        current.worldRotation = parent.worldRotation + current.rotation;
        current.worldScaleX = parent.worldScaleX * current.scaleX;
        current.worldScaleY = parent.worldScaleY * current.scaleY;
      } else {
        current.worldX = current.x; current.worldY = current.y; current.worldRotation = current.rotation;
        current.worldScaleX = current.scaleX; current.worldScaleY = current.scaleY;
      }
    }
    for (var layerIndex = 0; layerIndex < state.drawLayers.length; layerIndex++) {
      var item = state.drawLayers[layerIndex], sprite = item.node, transform = item.transform, joint = item.bone;
      var localX = transform.x * joint.worldScaleX, localY = transform.y * joint.worldScaleY;
      var c = Math.cos(joint.worldRotation), sn = Math.sin(joint.worldRotation);
      setPointIfChanged(sprite.position, joint.worldX + c * localX - sn * localY, joint.worldY + sn * localX + c * localY);
      var rotation = joint.worldRotation + transform.rotation;
      if (Math.abs(sprite.rotation - rotation) > .0001) sprite.rotation = rotation;
      setPointIfChanged(sprite.scale, joint.worldScaleX * transform.scaleX, joint.worldScaleY * transform.scaleY);
      if (Math.abs(sprite.alpha - transform.alpha) > .001) sprite.alpha = transform.alpha;
      if (item.meshState) { if (reduced) resetMesh(item); else updateMesh(state, item, seconds, deltaSeconds); }
    }
    var blink = motions.blink;
    if (blink) {
      var blinkPairs = Array.isArray(blink.pairs) && blink.pairs.length ? blink.pairs : [blink];
      state.blinkStates = state.blinkStates || Object.create(null);
      blinkPairs.forEach(function (pair, pairIndex) {
        var key = String(pair.id || ('blink-' + pairIndex)), blinkState = state.blinkStates[key];
        var min = clamp(blink.minIntervalSeconds, 1, 30, 2.8), max = clamp(blink.maxIntervalSeconds, min, 60, 5.2);
        if (!blinkState) blinkState = state.blinkStates[key] = { until: 0, nextAt: now + 2400 + Math.random() * 3200 };
        if (!reduced && now >= blinkState.nextAt) {
          blinkState.until = now + clamp(blink.durationSeconds, .08, 1, .18) * 1000;
          blinkState.nextAt = blinkState.until + (min + Math.random() * Math.max(0, max - min)) * 1000;
        }
        var closed = !reduced && now < blinkState.until;
        var openIds = Array.isArray(pair.openLayerIds) ? pair.openLayerIds : [pair.openLayerId];
        openIds.forEach(function (id) { if (id) setLayerVisible(state, id, !closed); });
        setLayerVisible(state, pair.closedLayerId, closed);
      });
    }
    var mouth = motions.mouth;
    if (mouth) {
      var energy = clamp(state.call._voiceTtsAudioLevel != null ? state.call._voiceTtsAudioLevel : state.call._live2dAudioLevel, 0, 1, 0);
      var speaking = !reduced && state.call.state === 'speaking' && !state.call.speakerMuted;
      var target = speaking ? clamp(energy * clamp(mouth.sensitivity, .2, 3, 1), 0, 1, 0) : 0;
      var dt = clamp(deltaSeconds, 0, .1, 1 / 60), smoothing = 1 - Math.exp(-dt / .075);
      state.mouthLevel += (target - state.mouthLevel) * smoothing;
      var open = state.mouthLevel > .13;
      setLayerVisible(state, mouth.closedLayerId, !open);
      setLayerVisible(state, mouth.openLayerId, open);
      var mouthLayer = state.layerNodes[mouth.openLayerId], mouthBase = mouthLayer && state.layerTransforms[mouth.openLayerId];
      if (mouthLayer && mouthBase) {
        var mouthScaleY = mouthBase.scaleY * (.72 + .28 * state.mouthLevel);
        if (Math.abs(mouthLayer.scale.y - mouthScaleY) > .001) mouthLayer.scale.y = mouthScaleY;
      }
    }
  }
  function addActionBar(state) {
    var actions = state.manifest.motions && state.manifest.motions.actions || [];
    if (!actions.length) return;
    var bar = document.createElement('div');
    bar.className = 'voice-call-puppet-actions';
    bar.setAttribute('aria-label', '角色动作');
    actions.forEach(function (action) {
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'voice-call-puppet-action'; button.textContent = String(action.label || action.id);
      button.addEventListener('click', function () {
        startAction(state, action);
        button.blur();
      });
      bar.appendChild(button);
    });
    state.stage.appendChild(bar);
    state.actionBar = bar;
  }
  function startAction(state, action) {
    var now = performance.now(), entries = state.activeActions;
    entries.forEach(function (entry) { if (!entry.fadeOutAt) entry.fadeOutAt = now; });
    entries.push({ action: action, startedAt: now, fadeOutAt: 0, weight: 0 });
  }
  function fetchManifest(url) {
    return fetch(url, { credentials: 'omit', cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('PUPPET_MANIFEST_HTTP_' + response.status);
      return response.json();
    }).then(validateManifest);
  }
  function mount(stage, role, call, options) {
    if (!stage || !call) return Promise.resolve({ ok: false, reason: 'missing-stage' });
    options = options || {};
    var inlineManifest = options.manifest && typeof options.manifest === 'object' ? options.manifest : null;
    var presentationPreview = !!inlineManifest && options.preview !== false;
    if (!presentationPreview && activeCall && activeCall !== call) destroy(activeCall);
    destroy(call);
    if (!presentationPreview) activeCall = call;
    call._puppetGeneration = (Number(call._puppetGeneration) || 0) + 1;
    var token = call._puppetGeneration, boundRole = role || call.role || {};
    var workshop = window.IBDIYWorkshop, ready = workshop && workshop.ready;
    var waitForDiy = ready && typeof ready.then === 'function' ? Promise.resolve(ready).catch(function () {}) : Promise.resolve();
    return waitForDiy.then(function () {
      if (call.destroyed || call._puppetGeneration !== token || !stage.isConnected || stage.hidden) return { ok: false, reason: 'cancelled' };
      var base = window.IBCallLive2D && typeof window.IBCallLive2D.createRoleLayer === 'function'
        ? window.IBCallLive2D.createRoleLayer(stage, boundRole)
        : null;
      if (!base) throw new Error('PUPPET_ROLE_STAGE_UNAVAILABLE');
      var state = {
        stage: stage, role: boundRole, call: call, token: token, layer: base.layer, base: base,
        app: null, manifest: null, bones: Object.create(null), boneList: [], layerNodes: Object.create(null),
        layerTransforms: Object.create(null), layerTransformList: [], drawLayers: [], motionSlots: [], activeActions: [],
        observer: null, fallbackResize: null, tick: null, actionBar: null, textures: [],
        cancelled: false, mode: base.avatar ? 'portrait' : 'none', startedAt: performance.now(),
        nextBlinkAt: performance.now() + 2600 + Math.random() * 2600, blinkUntil: 0, mouthLevel: 0,
        requestedFps: 60, targetFps: 60, displayRate: 60, adaptiveFps: false
      };
      call._puppetPresentation = state;
      stage.classList.add('has-role-presentation');
      if (base.portrait && typeof window.IBCallLive2D.fitPortrait === 'function') {
        window.IBCallLive2D.fitPortrait(stage, base.portrait, boundRole, base.diyPortrait);
        state.fallbackResize = function () { if (state.mode === 'portrait' && base.portrait && base.portrait.isConnected) window.IBCallLive2D.fitPortrait(stage, base.portrait, boundRole, base.diyPortrait); };
        window.addEventListener('resize', state.fallbackResize, { passive: true });
      }
      var bundleId = String(boundRole.puppetRef || '').trim(), library = window.IB && window.IB.host && window.IB.host.characterPuppets;
      if (!inlineManifest && (!bundleId || !library || !library.available)) {
        if (base.note) base.note.textContent = base.avatar ? '' : '此角色尚未绑定 IB Puppet 素材，可继续使用 DIY 立绘';
        return { ok: true, mode: state.mode, reason: bundleId ? 'native-storage-unavailable' : 'no-puppet-bound' };
      }
      var manifestTask = inlineManifest
        ? Promise.resolve({ url: document.baseURI || location.href, manifest: validateManifest(inlineManifest), inline: true })
        : library.resolve(bundleId).then(function (manifestUrl) {
          return fetchManifest(manifestUrl).then(function (manifest) { return { url: manifestUrl, manifest: manifest, inline: false }; });
        });
      return manifestTask.then(function (loaded) {
        if (state.cancelled || call._puppetGeneration !== token || !stage.isConnected || stage.hidden) return { ok: false, reason: 'cancelled' };
        state.preview = !!loaded.inline;
        state.manifest = loaded.manifest;
        if (base.note) base.note.textContent = '正在唤醒角色形象…';
        return ensurePixi().then(function () {
          if (state.cancelled || call._puppetGeneration !== token || !stage.isConnected || stage.hidden) return { ok: false, reason: 'cancelled' };
          var canvas = document.createElement('canvas');
          canvas.className = 'voice-call-puppet-canvas'; canvas.setAttribute('aria-hidden', 'true'); canvas.style.transform = 'none'; canvas.style.direction = 'ltr';
          state.layer.appendChild(canvas);
          var bounds = state.layer.getBoundingClientRect(), resolution = clamp(window.devicePixelRatio || 1, 1, 1.5, 1);
          var app = new window.PIXI.Application({ view: canvas, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height), backgroundAlpha: 0, transparent: true, antialias: true, autoDensity: true, resolution: resolution, autoStart: false, sharedTicker: false });
          state.app = app;
          if (app.ticker) { app.ticker.stop(); app.ticker.maxFPS = 0; }
          var world = new window.PIXI.Container(); world.sortableChildren = true; state.world = world; app.stage.addChild(world);
          var boneDefs = loaded.manifest.bones, boneById = Object.create(null);
          boneDefs.forEach(function (bone) { boneById[bone.id] = bone; });
          function createBone(id) {
            if (state.bones[id]) return state.bones[id];
            var definition = boneById[id], baseTransform = boneBase(definition);
            var bone = { id: id, definition: definition, base: baseTransform, x: baseTransform.x, y: baseTransform.y, rotation: baseTransform.rotation, scaleX: baseTransform.scaleX, scaleY: baseTransform.scaleY };
            state.bones[id] = bone;
            if (definition.parent) createBone(definition.parent);
            return bone;
          }
          boneDefs.forEach(function (bone) { createBone(bone.id); });
          var visitedBones = Object.create(null);
          function orderBone(bone) {
            if (!bone || visitedBones[bone.id]) return;
            if (bone.definition.parent) orderBone(state.bones[bone.definition.parent]);
            visitedBones[bone.id] = true; bone.parentBone = bone.definition.parent ? state.bones[bone.definition.parent] : null;
            state.boneList.push(bone);
          }
          boneDefs.forEach(function (bone) { orderBone(state.bones[bone.id]); });
          var textureLoads = Object.create(null), displayRateTask = detectDisplayRate();
          var layerAssets = loaded.manifest.layers.map(function (layer) {
            var url = safeLayerUrl(loaded.url, layer.src, loaded.inline);
            if (!textureLoads[url]) textureLoads[url] = loadTexture(url);
            return textureLoads[url].then(function (texture) { return { definition: layer, texture: texture, url: url }; });
          });
          return Promise.all(layerAssets).then(function (assets) {
            if (state.cancelled || call._puppetGeneration !== token || !stage.isConnected || stage.hidden) {
              assets.forEach(function (item) { try { item.texture.destroy(true); } catch (e) {} });
              return { ok: false, reason: 'cancelled' };
            }
            assets.forEach(function (item) {
              var layer = item.definition, sprite = spriteFor(layer, item.texture);
              sprite._ibPuppetBoneId = layer.bone; world.addChild(sprite);
              var transform = { base: layerBase(layer) };
              transform.x = transform.base.x; transform.y = transform.base.y; transform.rotation = transform.base.rotation;
              transform.scaleX = transform.base.scaleX; transform.scaleY = transform.base.scaleY; transform.alpha = transform.base.alpha;
              var drawLayer = { definition: layer, node: sprite, bone: state.bones[layer.bone], transform: transform, meshState: sprite._ibPuppetMesh || null };
              state.layerNodes[layer.id] = sprite; state.layerTransforms[layer.id] = transform;
              state.layerTransformList.push(transform); state.drawLayers.push(drawLayer);
              if (state.textures.indexOf(item.texture) < 0) state.textures.push(item.texture);
            });
            compileActions(state, loaded.manifest.motions && loaded.manifest.motions.actions || []);
            state.meshVertexCount = state.drawLayers.reduce(function (sum, layer) { return sum + (layer.meshState ? layer.meshState.columns * layer.meshState.rows : 0); }, 0);
            state.estimatedTextureBytes = state.textures.reduce(function (sum, texture) {
              var baseTexture = texture && texture.baseTexture, resource = baseTexture && baseTexture.resource;
              var width = Number(baseTexture && (baseTexture.realWidth || baseTexture.width) || resource && (resource.width || resource.naturalWidth)) || 0;
              var height = Number(baseTexture && (baseTexture.realHeight || baseTexture.height) || resource && (resource.height || resource.naturalHeight)) || 0;
              return sum + width * height * 4;
            }, 0);
            state.mode = 'puppet'; state.layer.dataset.mode = 'puppet'; state.layer.classList.add('is-puppet');
            if (base.portrait) base.portrait.hidden = true;
            if (base.note && base.note.parentNode) base.note.remove();
            if (state.fallbackResize) { window.removeEventListener('resize', state.fallbackResize); state.fallbackResize = null; }
            fit(state); addActionBar(state);
            state.lastRenderAt = 0; state.renderFrames = 0; state.renderWindowStart = 0; state.renderFps = 0;
            state.workSamples = []; state.rafSamples = []; state.rafCallbacks = 0; state.missedRafCallbacks = 0;
            state.adaptivePressureWindows = 0; state.healthySince = 0; state.frameHandle = 0;
            return displayRateTask.then(function (displayRate) {
              state.displayRate = displayRate;
              state.requestedFps = requestedRate(boundRole, displayRate);
              state.targetFps = state.requestedFps;
              state.frameSampleStart = performance.now();
              state.tick = function (now) {
                if (state.cancelled || !state.app) return;
                now = Number(now) || performance.now();
                var rafDelta = state.lastRafAt ? now - state.lastRafAt : 0;
                state.lastRafAt = now; state.rafCallbacks++;
                if (rafDelta > 0 && rafDelta < 100) {
                  state.rafSamples.push(rafDelta); if (state.rafSamples.length > 120) state.rafSamples.shift();
                  if (rafDelta > 1000 / Math.max(30, state.displayRate) * 1.8) state.missedRafCallbacks++;
                }
                var interval = 1000 / state.targetFps;
                if (!state.lastRenderAt || now - state.lastRenderAt >= interval - .35) {
                  var elapsed = state.lastRenderAt ? now - state.lastRenderAt : interval;
                  state.lastRenderAt = now;
                  var workStart = performance.now();
                  animate(state, clamp(elapsed / 1000, 0, .1, 1 / state.targetFps), now);
                  try { state.app.renderer.render(state.app.stage); } catch (e) { state.renderError = String(e && e.message || e); }
                  var workMs = Math.max(0, performance.now() - workStart);
                  state.workSamples.push(workMs); if (state.workSamples.length > 120) state.workSamples.shift();
                  state.renderFrames++;
                }
                var sampleElapsed = now - state.frameSampleStart;
                if (sampleElapsed >= 1000) {
                  state.renderFps = Math.round(state.renderFrames * 1000 / sampleElapsed);
                  state.avgFrameMs = state.workSamples.length ? state.workSamples.reduce(function (a, b) { return a + b; }, 0) / state.workSamples.length : 0;
                  var sortedWork = state.workSamples.slice().sort(function (a, b) { return a - b; });
                  state.p95FrameMs = sortedWork.length ? sortedWork[Math.min(sortedWork.length - 1, Math.floor(sortedWork.length * .95))] : 0;
                  state.rafRate = state.rafSamples.length ? 1000 / (state.rafSamples.reduce(function (a, b) { return a + b; }, 0) / state.rafSamples.length) : displayRate;
                  var targetBudget = 1000 / state.targetFps, missedRatio = state.rafCallbacks ? state.missedRafCallbacks / state.rafCallbacks : 0;
                  var pressured = state.avgFrameMs > targetBudget * .72 || missedRatio > .045;
                  if (pressured) {
                    state.adaptivePressureWindows++; state.healthySince = 0;
                    if (state.adaptivePressureWindows >= 2 && state.targetFps > 30) {
                      changeTargetFps(state, state.targetFps === 120 ? 60 : 30, now); state.adaptiveFps = true; state.adaptivePressureWindows = 0;
                    }
                  } else {
                    state.adaptivePressureWindows = 0;
                    if (!state.healthySince) state.healthySince = now;
                    if (state.adaptiveFps && state.targetFps < state.requestedFps && now - state.healthySince >= 8000) {
                      changeTargetFps(state, state.targetFps === 30 && state.requestedFps >= 60 ? 60 : state.requestedFps, now);
                      state.adaptiveFps = state.targetFps !== state.requestedFps; state.healthySince = now;
                    }
                  }
                  state.renderFrames = 0; state.rafCallbacks = 0; state.missedRafCallbacks = 0; state.frameSampleStart = now;
                }
                state.frameHandle = requestAnimationFrame(state.tick);
              };
              // Draw once before resolving mount() so editor previews and the
              // first call frame do not flash an empty canvas after textures load.
              state.tick(performance.now());
              if (window.ResizeObserver) { state.observer = new ResizeObserver(function () { fit(state); }); state.observer.observe(state.layer); }
              else { state.fallbackResize = function () { fit(state); }; window.addEventListener('resize', state.fallbackResize, { passive: true }); }
              return { ok: true, mode: 'puppet', preview: !!loaded.inline, bundleId: bundleId, layerCount: assets.length, targetFps: state.targetFps, displayRate: displayRate };
            });
          });
        });
      }).catch(function (error) {
        if (state.cancelled || call._puppetGeneration !== token) return { ok: false, reason: 'cancelled' };
        state.mode = base.avatar ? 'portrait' : 'none'; state.layer.dataset.mode = state.mode;
        if (base.note) base.note.textContent = base.avatar ? 'IB Puppet 未能加载，已使用角色立绘' : 'IB Puppet 未能加载，当前角色没有可用立绘';
        try { if (state.app && state.app.ticker) state.app.ticker.stop(); var view = state.app && state.app.view; if (state.app) state.app.destroy(true, { children: true, texture: true, baseTexture: true }); if (view && view.parentNode) view.remove(); } catch (e) {}
        state.app = null; state.world = null; state.manifest = null; state.bones = Object.create(null); state.layerNodes = Object.create(null); state.textures = [];
        try { console.warn('[IB Puppet] role presentation fallback', String(error && error.message || error)); } catch (e) {}
        return { ok: false, mode: state.mode, error: String(error && error.message || error) };
      });
    }).catch(function (error) { return { ok: false, reason: String(error && error.message || error) }; });
  }
  function syncAudioLevel(call, value) {
    var state = call && call._puppetPresentation;
    if (state && !state.cancelled) state.audioLevel = clamp(value, 0, 1, 0);
  }
  function destroy(call) {
    call = call || activeCall;
    if (!call) return;
    call._puppetGeneration = (Number(call._puppetGeneration) || 0) + 1;
    var state = call._puppetPresentation;
    if (!state) { if (activeCall === call) activeCall = null; return; }
    state.cancelled = true;
    try { if (state.observer) state.observer.disconnect(); } catch (e) {}
    try { if (state.fallbackResize) window.removeEventListener('resize', state.fallbackResize); } catch (e) {}
    try { if (state.frameHandle) cancelAnimationFrame(state.frameHandle); } catch (e) {}
    try { if (state.app && state.app.ticker) state.app.ticker.stop(); } catch (e) {}
    try { if (state.world && state.world.parent) state.world.parent.removeChild(state.world); } catch (e) {}
    try { if (state.textures) state.textures.forEach(function (texture) { try { texture.destroy(true); } catch (e) {} }); } catch (e) {}
    try { if (state.app) state.app.destroy(true, { children: true, texture: false, baseTexture: false }); } catch (e) {}
    try { if (state.actionBar) state.actionBar.remove(); } catch (e) {}
    try { if (state.layer) state.layer.remove(); } catch (e) {}
    try { if (state.stage) { state.stage.classList.remove('has-role-presentation'); var panel = state.stage.closest('.voice-call-panel'); if (panel) panel.classList.remove('has-role-avatar'); } } catch (e) {}
    delete call._puppetPresentation;
    if (activeCall === call) activeCall = null;
  }
  function playAction(call, actionId) {
    var state = call && call._puppetPresentation, actions = state && state.manifest && state.manifest.motions && state.manifest.motions.actions || [];
    var action = actions.find(function (item) { return item.id === String(actionId || ''); });
    if (!state || state.cancelled || !action) return false;
    startAction(state, action);
    return true;
  }
  function seekAction(call, actionId, seconds) {
    var state = call && call._puppetPresentation, actions = state && state.manifest && state.manifest.motions && state.manifest.motions.actions || [];
    var action = actions.find(function (item) { return item.id === String(actionId || ''); });
    if (!state || state.cancelled || !action) return false;
    state.activeActions = [{ action: action, startedAt: performance.now() - clamp(seconds, 0, action.durationSeconds, 0) * 1000, fadeOutAt: 0, weight: 1, skipFadeIn: true }];
    return true;
  }
  function attachManifest(stage, manifest, call, role) {
    var boundRole = Object.assign({ characterEngine: 'puppet', puppetFrameRate: '60' }, role || {});
    return mount(stage, boundRole, call, { manifest: manifest, preview: true });
  }
  function peek(call) {
    var state = call && call._puppetPresentation;
    if (!state) return null;
    var active = state.activeActions && state.activeActions.length ? state.activeActions[state.activeActions.length - 1] : null;
    return {
      mode: state.mode, preview: !!state.preview, bundleId: state.role && state.role.puppetRef || '', state: state.call && state.call.state || 'idle', cancelled: state.cancelled,
      audioLevel: state.audioLevel || 0, mouthLevel: state.mouthLevel || 0, action: active && active.action.id || '',
      displayRate: state.displayRate || 0, rafRate: state.rafRate || 0, targetFps: state.targetFps || 0, renderFps: state.renderFps || 0,
      averageFrameMs: Number(state.avgFrameMs || 0), p95FrameMs: Number(state.p95FrameMs || 0), adaptiveFps: !!state.adaptiveFps,
      layerCount: state.drawLayers ? state.drawLayers.length : 0, boneCount: state.boneList ? state.boneList.length : 0,
      meshVertexCount: state.meshVertexCount || 0, estimatedTextureBytes: state.estimatedTextureBytes || 0, renderError: state.renderError || ''
    };
  }
  var api = { attach: mount, mount: mount, attachManifest: attachManifest, destroy: destroy, syncAudioLevel: syncAudioLevel, playAction: playAction, seekAction: seekAction, peek: peek, validateManifest: validateManifest };
  window.IBCallPuppet = api;
  NS.callPuppet = api;
})(window.IB || (window.IB = {}));
