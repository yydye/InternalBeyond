/* Expression Pack data contract.
 * Packs, state defaults, and per-message selections belong to apiConfigs, never chatMessages.
 * This module is pure so imports and renderers can share the same rules. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IBExpressionPackCore = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var MAX_PACKS = 24;
  var MAX_EXPRESSIONS_PER_PACK = 32;
  var MAX_ASSIGNMENTS = 500;
  var MAX_IMAGE_DATA_URL_LENGTH = 500000;
  var SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  var DEFAULT_STATES = ['neutralExpression', 'greetingExpression', 'typingExpression', 'voiceExpression', 'errorExpression'];
  var DEFAULT_SETTINGS = Object.freeze({ enabled: true, microMotion: true });
  var MOOD_ALIASES = {
    happy: ['happy', 'joy', 'smile', 'smiling', 'cheerful', '开心', '高兴', '微笑', '喜悦', '愉快'],
    laugh: ['laugh', 'laughing', '哈哈', '大笑', '爆笑', '傻笑'],
    sad: ['sad', 'cry', 'crying', 'upset', '难过', '悲伤', '伤心', '哭泣'],
    surprised: ['surprised', 'surprise', 'shock', '惊讶', '震惊', '意外'],
    angry: ['angry', 'mad', '生气', '愤怒', '恼火'],
    thinking: ['thinking', 'thoughtful', '疑惑', '思考', '思索'],
    shy: ['shy', 'embarrassed', 'blush', '害羞', '脸红'],
    worried: ['worried', 'concerned', '担心', '忧虑'],
    curious: ['curious', '好奇'],
    calm: ['calm', 'relaxed', '平静', '放松']
  };
  var CONTEXT_RULES = [
    { mood: 'laugh', pattern: /(哈哈+|呵呵+|笑死|太逗了|好好笑|笑出声|lol\b|haha+)/i },
    { mood: 'surprised', pattern: /(没想到|真的假的|居然|竟然|不会吧|天哪|天啊|哇[！!？?]|惊讶|震惊|surprised|no way\b|wow\b)/i },
    { mood: 'sad', pattern: /(难过|伤心|失望|遗憾|抱歉|对不起|可惜|sad\b|sorry\b|upset\b)/i },
    { mood: 'worried', pattern: /(担心|放心不下|不舒服|辛苦了|照顾好|小心|worried\b|take care\b)/i },
    { mood: 'angry', pattern: /(生气|愤怒|恼火|讨厌|不满|angry\b|annoyed\b)/i },
    { mood: 'shy', pattern: /(害羞|脸红|不好意思|羞|blush\b|embarrassed\b)/i },
    { mood: 'happy', pattern: /(太好了|好开心|很开心|高兴|喜欢|期待|恭喜|真棒|开心|happy\b|glad\b|great\b|congratulations\b)/i },
    { mood: 'thinking', pattern: /(让我想想|我想想|仔细想想|有点疑惑|可能吧|或许|thinking\b|let me think\b)/i },
    { mood: 'curious', pattern: /(好奇|想知道|有意思|curious\b|wonder\b)/i }
  ];
  var STREAM_TAG_PREFIX = '[[expression:';
  var MAX_EXPRESSION_TAG_LENGTH = 96;

  function text(value, limit) {
    return String(value == null ? '' : value).trim().slice(0, limit || 80);
  }
  function cloneConfig(config) {
    var out = Object.assign({}, config || {});
    out.expressionPacks = (Array.isArray(config && config.expressionPacks) ? config.expressionPacks : []).map(function (pack) {
      var copy = Object.assign({}, pack || {});
      copy.expressions = (Array.isArray(pack && pack.expressions) ? pack.expressions : []).map(function (expression) {
        return Object.assign({}, expression || {});
      });
      return copy;
    });
    var source = config && config.expressionAssignments && typeof config.expressionAssignments === 'object'
      && !Array.isArray(config.expressionAssignments) ? config.expressionAssignments : {};
    out.expressionAssignments = Object.create(null);
    Object.keys(source).forEach(function (key) { out.expressionAssignments[key] = source[key]; });
    var defaults = config && config.expressionDefaults && typeof config.expressionDefaults === 'object'
      && !Array.isArray(config.expressionDefaults) ? config.expressionDefaults : null;
    if (defaults) {
      out.expressionDefaults = {};
      Object.keys(defaults).forEach(function (key) {
        out.expressionDefaults[key] = defaults[key] && typeof defaults[key] === 'object'
          ? Object.assign({}, defaults[key]) : defaults[key];
      });
    } else delete out.expressionDefaults;
    return out;
  }
  function packsOf(config) {
    return (Array.isArray(config && config.expressionPacks) ? config.expressionPacks : []).filter(function (pack) {
      return !!(pack && typeof pack.id === 'string' && pack.id && Array.isArray(pack.expressions));
    });
  }
  function expressionsOf(pack) {
    return (Array.isArray(pack && pack.expressions) ? pack.expressions : []).filter(function (expression) {
      return !!(expression && typeof expression.id === 'string' && expression.id && typeof expression.name === 'string'
        && expression.name && typeof expression.dataUrl === 'string' && expression.dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH
        && SAFE_IMAGE_DATA_URL.test(expression.dataUrl));
    });
  }
  function activePack(config) {
    var packs = packsOf(config), activeId = String(config && config.activeExpressionPackId || '');
    for (var i = 0; i < packs.length; i++) if (packs[i].id === activeId) return packs[i];
    return null;
  }
  function packById(config, packId) {
    var packs = packsOf(config), id = String(packId || '');
    for (var i = 0; i < packs.length; i++) if (packs[i].id === id) return packs[i];
    return null;
  }
  function expressionById(pack, expressionId) {
    var list = expressionsOf(pack), id = String(expressionId || '');
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === id) return list[i];
    return null;
  }
  function settingsOf(config) {
    var source = config && config.expressionSettings && typeof config.expressionSettings === 'object'
      && !Array.isArray(config.expressionSettings) ? config.expressionSettings : {};
    return {
      enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
      microMotion: typeof source.microMotion === 'boolean' ? source.microMotion : DEFAULT_SETTINGS.microMotion,
      modelTags: typeof source.modelTags === 'boolean' ? source.modelTags : true
    };
  }
  function setSettings(config, settings) {
    var out = cloneConfig(config), source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    out.expressionSettings = {
      enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
      microMotion: typeof source.microMotion === 'boolean' ? source.microMotion : DEFAULT_SETTINGS.microMotion,
      modelTags: typeof source.modelTags === 'boolean' ? source.modelTags : true
    };
    return out;
  }
  function normalizedToken(value) {
    var result = String(value == null ? '' : value).trim().toLowerCase();
    try { if (result.normalize) result = result.normalize('NFKC'); } catch (e) { }
    return result.replace(/[\s_-]+/g, '');
  }
  function moodForToken(value) {
    var token = normalizedToken(value), moods = Object.keys(MOOD_ALIASES);
    if (!token) return '';
    for (var i = 0; i < moods.length; i++) {
      for (var j = 0; j < MOOD_ALIASES[moods[i]].length; j++) {
        if (token === normalizedToken(MOOD_ALIASES[moods[i]][j])) return moods[i];
      }
    }
    return '';
  }
  function moodForExpression(expression) {
    if (!expression) return '';
    var label = normalizedToken(String(expression.id || '') + ' ' + String(expression.name || ''));
    var moods = Object.keys(MOOD_ALIASES);
    for (var i = 0; i < moods.length; i++) {
      for (var j = 0; j < MOOD_ALIASES[moods[i]].length; j++) {
        var alias = normalizedToken(MOOD_ALIASES[moods[i]][j]);
        if (alias && label.indexOf(alias) >= 0) return moods[i];
      }
    }
    return '';
  }
  function expressionReference(resolved) {
    return resolved ? { packId: String(resolved.pack.id), expressionId: String(resolved.expression.id) } : null;
  }
  function resolveExpressionTag(config, value) {
    var token = String(value == null ? '' : value).trim().slice(0, 64);
    if (!token) return null;
    var packs = packsOf(config), normalized = normalizedToken(token), active = activePack(config);
    var ordered = active ? [active].concat(packs.filter(function (pack) { return pack.id !== active.id; })) : packs;
    for (var i = 0; i < ordered.length; i++) {
      var expressions = expressionsOf(ordered[i]);
      for (var j = 0; j < expressions.length; j++) {
        if (normalizedToken(expressions[j].id) === normalized || normalizedToken(expressions[j].name) === normalized) {
          return { pack: ordered[i], expression: expressions[j], mood: moodForExpression(expressions[j]), source: 'model' };
        }
      }
    }
    var mood = moodForToken(token);
    if (!mood) return null;
    for (var p = 0; p < ordered.length; p++) {
      var list = expressionsOf(ordered[p]);
      for (var e = 0; e < list.length; e++) {
        if (moodForExpression(list[e]) === mood) return { pack: ordered[p], expression: list[e], mood: mood, source: 'model' };
      }
    }
    return null;
  }
  function automaticMood(value) {
    var text = String(value == null ? '' : value).slice(0, 4000), matches = [];
    if (!text.trim()) return '';
    CONTEXT_RULES.forEach(function (rule, index) {
      var found = text.match(new RegExp(rule.pattern.source, 'gi'));
      if (found && found.length) matches.push({ mood: rule.mood, score: found.length, order: index });
    });
    matches.sort(function (left, right) { return right.score - left.score || left.order - right.order; });
    return matches.length ? matches[0].mood : '';
  }
  function automaticExpression(config, value) {
    var pack = activePack(config), mood = automaticMood(value);
    if (!pack || !mood) return null;
    var expressions = expressionsOf(pack);
    for (var i = 0; i < expressions.length; i++) {
      if (moodForExpression(expressions[i]) === mood) return { pack: pack, expression: expressions[i], mood: mood, source: 'automatic' };
    }
    return null;
  }
  function actionForMood(mood, state) {
    if (state === 'typingExpression' || mood === 'surprised' || mood === 'laugh') return 'blink';
    if (mood === 'happy' || mood === 'shy' || state === 'voiceExpression') return 'sway';
    return 'transition';
  }
  function resolveMessageExpression(config, input) {
    input = input && typeof input === 'object' ? input : {};
    var state = String(input.stateOverride || '');
    if (DEFAULT_STATES.indexOf(state) >= 0) {
      var stateMatch = expressionForState(config, state);
      return stateMatch ? Object.assign({}, stateMatch, {
        source: 'state', mood: moodForExpression(stateMatch.expression), action: actionForMood(moodForExpression(stateMatch.expression), state)
      }) : null;
    }
    var manual = messageExpression(config, input.messageId);
    if (manual) return Object.assign({}, manual, { source: 'manual', mood: moodForExpression(manual.expression), action: 'transition' });
    var settings = settingsOf(config), selected = null, ref = input.modelExpressionRef;
    if (settings.enabled && settings.modelTags && ref) {
      var modelPack = packById(config, ref.packId), modelExpression = modelPack && expressionById(modelPack, ref.expressionId);
      if (modelExpression) selected = { pack: modelPack, expression: modelExpression,
        source: 'model', mood: moodForExpression(modelExpression) };
    }
    if (!selected && settings.enabled && settings.autoSelect !== false) selected = automaticExpression(config, input.text);
    if (!selected) selected = expressionForState(config, 'neutralExpression');
    return selected ? Object.assign({}, selected, { action: actionForMood(selected.mood, '') }) : null;
  }
  function parseReplyExpressions(value, config) {
    var source = String(value == null ? '' : value), output = '', markers = [], cursor = 0;
    var prefix = /\[\[\s*expression\s*:/ig, match, settings = settingsOf(config);
    while ((match = prefix.exec(source))) {
      var start = match.index, valueStart = prefix.lastIndex;
      output += source.slice(cursor, start);
      var close = source.indexOf(']]', valueStart), lineBreak = source.indexOf('\n', valueStart);
      if (close < 0 || (lineBreak >= 0 && lineBreak < close)) {
        cursor = lineBreak >= 0 ? lineBreak + 1 : source.length;
        prefix.lastIndex = cursor;
        continue;
      }
      var key = String(source.slice(valueStart, close)).trim().slice(0, 64);
      var withinLimit = close - start <= MAX_EXPRESSION_TAG_LENGTH;
      var resolved = withinLimit && settings.enabled && settings.modelTags ? resolveExpressionTag(config, key) : null;
      markers.push({ key: key, offset: output.length, expressionRef: expressionReference(resolved), valid: !!resolved });
      cursor = close + 2;
      prefix.lastIndex = cursor;
    }
    output += source.slice(cursor);
    return { text: output, markers: markers, expressionRef: markers.reduce(function (ref, marker) {
      return ref || marker.expressionRef;
    }, null) };
  }
  function expressionRefsForSegments(parsed, segments) {
    var text = String(parsed && parsed.text || ''), markers = Array.isArray(parsed && parsed.markers) ? parsed.markers : [];
    var list = Array.isArray(segments) ? segments : [], spans = [], cursor = 0;
    for (var i = 0; i < list.length; i++) {
      var segment = String(list[i] == null ? '' : list[i]);
      var start = text.indexOf(segment, cursor);
      if (start < 0) start = cursor;
      spans.push({ start: start, end: start + segment.length });
      cursor = start + segment.length;
    }
    var refs = list.map(function () { return null; });
    markers.forEach(function (marker) {
      if (!marker.expressionRef || !spans.length) return;
      var index = -1, bestDistance = Infinity;
      for (var si = 0; si < spans.length; si++) {
        if (marker.offset >= spans[si].start && marker.offset <= spans[si].end) { index = si; break; }
        var distance = marker.offset < spans[si].start ? spans[si].start - marker.offset : marker.offset - spans[si].end;
        if (distance < bestDistance) { bestDistance = distance; index = si; }
      }
      if (index >= 0 && !refs[index]) refs[index] = marker.expressionRef;
    });
    return refs;
  }
  function createTagStreamFilter() {
    var pending = '', lowerPrefix = STREAM_TAG_PREFIX.toLowerCase();
    function possibleOpen(value) {
      var compact = String(value || '').replace(/\s+/g, '').toLowerCase();
      return !!compact && lowerPrefix.indexOf(compact) === 0;
    }
    return Object.freeze({
      push: function (chunk) {
        pending += String(chunk == null ? '' : chunk);
        var output = '';
        while (pending) {
          var start = pending.indexOf('[[');
          if (start < 0) {
            var hold = pending.endsWith('[') ? 1 : 0;
            output += pending.slice(0, pending.length - hold);
            pending = hold ? pending.slice(-hold) : '';
            break;
          }
          output += pending.slice(0, start);
          var candidate = pending.slice(start), colon = candidate.indexOf(':');
          if (colon < 0 && possibleOpen(candidate)) {
            pending = pending.slice(start);
            break;
          }
          if (colon < 0 || !/^\[\[\s*expression\s*:/i.test(candidate.slice(0, colon + 1))) {
            output += pending.slice(start, start + 1);
            pending = pending.slice(start + 1);
            continue;
          }
          var close = pending.indexOf(']]', start + colon + 1);
          var lineBreak = pending.indexOf('\n', start + colon + 1);
          if (close < 0 && lineBreak < 0 && pending.length - start <= MAX_EXPRESSION_TAG_LENGTH) {
            pending = pending.slice(start);
            break;
          }
          if (close >= 0 && (lineBreak < 0 || close < lineBreak)) pending = pending.slice(close + 2);
          else pending = lineBreak >= 0 ? pending.slice(lineBreak + 1) : '';
        }
        return output;
      },
      finish: function () { pending = ''; return ''; }
    });
  }
  function defaultExpression(config, state) {
    if (DEFAULT_STATES.indexOf(String(state || '')) < 0) return null;
    var defaults = config && config.expressionDefaults;
    var ref = defaults && typeof defaults === 'object' ? defaults[state] : null;
    if (!ref || typeof ref !== 'object') return null;
    var pack = packById(config, ref.packId), expression = expressionById(pack, ref.expressionId);
    return expression ? { pack: pack, expression: expression } : null;
  }
  function expressionForState(config, state) {
    if (DEFAULT_STATES.indexOf(String(state || '')) < 0) return null;
    var current = defaultExpression(config, state);
    if (current) return current;
    return state === 'neutralExpression' ? null : defaultExpression(config, 'neutralExpression');
  }
  function setExpressionDefaults(config, defaults) {
    var out = cloneConfig(config), source = defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? defaults : {};
    var normalized = {};
    DEFAULT_STATES.forEach(function (state) {
      var ref = source[state];
      if (!ref || typeof ref !== 'object') return;
      var packId = String(ref.packId || ''), expressionId = String(ref.expressionId || '');
      if (packId && expressionId && packById(out, packId) && expressionById(packById(out, packId), expressionId)) {
        normalized[state] = { packId: packId, expressionId: expressionId };
      }
    });
    if (Object.keys(normalized).length) out.expressionDefaults = normalized;
    else delete out.expressionDefaults;
    return out;
  }
  function clearExpressionDefaults(out, packId, expressionId) {
    var defaults = out && out.expressionDefaults;
    if (!defaults || typeof defaults !== 'object') return;
    Object.keys(defaults).forEach(function (state) {
      var ref = defaults[state];
      if (ref && String(ref.packId || '') === String(packId || '')
        && (!expressionId || String(ref.expressionId || '') === String(expressionId))) delete defaults[state];
    });
    if (!Object.keys(defaults).length) delete out.expressionDefaults;
  }
  function addPack(config, id, name, now) {
    var packId = text(id, 120), packName = text(name, 40), out = cloneConfig(config);
    if (!packId || !packName || packsOf(out).length >= MAX_PACKS || packById(out, packId)) return null;
    out.expressionPacks.push({ id: packId, name: packName, expressions: [], createdAt: Number(now) || Date.now() });
    if (!out.activeExpressionPackId) out.activeExpressionPackId = packId;
    return out;
  }
  function setActivePack(config, packId) {
    var id = String(packId || ''), out = cloneConfig(config);
    if (id && !packById(out, id)) return null;
    out.activeExpressionPackId = id;
    return out;
  }
  function removePack(config, packId) {
    var id = String(packId || ''), out = cloneConfig(config);
    if (!packById(out, id)) return null;
    out.expressionPacks = out.expressionPacks.filter(function (pack) { return String(pack.id) !== id; });
    if (String(out.activeExpressionPackId || '') === id) out.activeExpressionPackId = out.expressionPacks.length ? String(out.expressionPacks[0].id) : '';
    Object.keys(out.expressionAssignments).forEach(function (messageId) {
      var assignment = out.expressionAssignments[messageId];
      if (assignment && String(assignment.packId || '') === id) delete out.expressionAssignments[messageId];
    });
    clearExpressionDefaults(out, id);
    return out;
  }
  function addExpression(config, packId, expression) {
    var id = String(packId || ''), pack = packById(config, id), source = expression || {};
    var expressionId = text(source.id, 120), name = text(source.name, 48), dataUrl = String(source.dataUrl || '');
    if (!pack || !expressionId || !name || !SAFE_IMAGE_DATA_URL.test(dataUrl) || dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
    if (pack.expressions.length >= MAX_EXPRESSIONS_PER_PACK || expressionById(pack, expressionId)) return null;
    var out = cloneConfig(config), target = packById(out, id);
    target.expressions.push({
      id: expressionId,
      name: name,
      mimeType: dataUrl.slice(5, dataUrl.indexOf(';')),
      dataUrl: dataUrl,
      createdAt: Number(source.createdAt) || Date.now()
    });
    return out;
  }
  function removeExpression(config, packId, expressionId) {
    var id = String(packId || ''), eId = String(expressionId || ''), pack = packById(config, id);
    if (!pack || !expressionById(pack, eId)) return null;
    var out = cloneConfig(config), target = packById(out, id);
    target.expressions = target.expressions.filter(function (expression) { return String(expression.id) !== eId; });
    Object.keys(out.expressionAssignments).forEach(function (messageId) {
      var assignment = out.expressionAssignments[messageId];
      if (assignment && String(assignment.packId || '') === id && String(assignment.expressionId || '') === eId) delete out.expressionAssignments[messageId];
    });
    clearExpressionDefaults(out, id, eId);
    return out;
  }
  function setMessageExpression(config, messageId, packId, expressionId, now) {
    var msgId = text(messageId, 180), pId = String(packId || ''), eId = String(expressionId || ''), out = cloneConfig(config);
    if (!msgId || msgId === '__proto__' || msgId === 'constructor' || msgId === 'prototype') return null;
    if (eId && (!packById(out, pId) || !expressionById(packById(out, pId), eId))) return null;
    if (eId) out.expressionAssignments[msgId] = { packId: pId, expressionId: eId, updatedAt: Number(now) || Date.now() };
    else delete out.expressionAssignments[msgId];
    var keys = Object.keys(out.expressionAssignments);
    if (keys.length > MAX_ASSIGNMENTS) {
      keys.sort(function (a, b) {
        return (Number(out.expressionAssignments[a] && out.expressionAssignments[a].updatedAt) || 0)
          - (Number(out.expressionAssignments[b] && out.expressionAssignments[b].updatedAt) || 0);
      });
      while (keys.length > MAX_ASSIGNMENTS) delete out.expressionAssignments[keys.shift()];
    }
    return out;
  }
  function messageExpression(config, messageId) {
    var map = config && config.expressionAssignments;
    var assignment = map && typeof map === 'object' ? map[String(messageId || '')] : null;
    if (!assignment) return null;
    var pack = packById(config, assignment.packId), expression = expressionById(pack, assignment.expressionId);
    return expression ? { pack: pack, expression: expression } : null;
  }

  return Object.freeze({
    MAX_PACKS: MAX_PACKS,
    MAX_EXPRESSIONS_PER_PACK: MAX_EXPRESSIONS_PER_PACK,
    MAX_ASSIGNMENTS: MAX_ASSIGNMENTS,
    MAX_IMAGE_DATA_URL_LENGTH: MAX_IMAGE_DATA_URL_LENGTH,
    DEFAULT_STATES: DEFAULT_STATES.slice(),
    DEFAULT_SETTINGS: Object.assign({}, DEFAULT_SETTINGS),
    packsOf: packsOf,
    expressionsOf: expressionsOf,
    activePack: activePack,
    packById: packById,
    settingsOf: settingsOf,
    setSettings: setSettings,
    messageExpression: messageExpression,
    defaultExpression: defaultExpression,
    expressionForState: expressionForState,
    resolveExpressionTag: resolveExpressionTag,
    resolveMessageExpression: resolveMessageExpression,
    parseReplyExpressions: parseReplyExpressions,
    expressionRefsForSegments: expressionRefsForSegments,
    automaticMood: automaticMood,
    createTagStreamFilter: createTagStreamFilter,
    addPack: addPack,
    setActivePack: setActivePack,
    removePack: removePack,
    addExpression: addExpression,
    removeExpression: removeExpression,
    setMessageExpression: setMessageExpression,
    setExpressionDefaults: setExpressionDefaults
  });
});
