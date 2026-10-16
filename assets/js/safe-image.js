'use strict';

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IBSafeImage = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  var MAX_SOURCE_LENGTH = 16 * 1024 * 1024;
  var DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|gif|avif|bmp|x-icon);base64,([A-Za-z0-9+/]+={0,2})$/i;
  var SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,180}$/;

  function pageUrl(baseHref) {
    var value = baseHref;
    if (!value && root && root.location) value = root.location.href;
    try { return new URL(String(value || 'http://localhost/')); } catch (_) { return new URL('http://localhost/'); }
  }

  function normalizeSource(value, baseHref) {
    if (typeof value !== 'string') return '';
    var source = value.trim();
    if (!source || source.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f<>"'`]/.test(source)) return '';

    if (/^data:/i.test(source)) {
      var dataMatch = DATA_IMAGE_RE.exec(source);
      if (!dataMatch || dataMatch[1].length % 4 !== 0) return '';
      return source;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^https?:\/\//i.test(source)) return '';
    if (source.indexOf('\\') >= 0 || source.slice(0, 2) === '//') return '';

    var base = pageUrl(baseHref);
    var url;
    try { url = new URL(source, base); } catch (_) { return ''; }
    if (url.username || url.password) return '';
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;

    /* The standalone file:// entrypoint uses relative app assets. Keep those
       paths usable while refusing absolute file URLs and parent traversal. */
    if (base.protocol === 'file:' && url.protocol === 'file:' && !source.startsWith('/')) {
      /* URL parsing normalizes literal dot segments, but percent-encoded dot
         and separator forms must be checked too before preserving a relative
         file URL for the standalone file:// entrypoint. */
      try {
        var baseDirectory = decodeURIComponent(new URL('.', base).pathname);
        var decodedTarget = decodeURIComponent(url.pathname);
        if (baseDirectory.indexOf('\\') >= 0 || decodedTarget.indexOf('\\') >= 0) return '';
        var baseParts = baseDirectory.split('/').filter(Boolean);
        var targetParts = decodedTarget.split('/').filter(Boolean);
        var normalizedTarget = [];
        targetParts.forEach(function (part) {
          if (part === '.') return;
          if (part === '..') { if (normalizedTarget.length) normalizedTarget.pop(); return; }
          normalizedTarget.push(part);
        });
        var normalizedBase = baseParts.join('/').toLowerCase();
        var normalizedPath = normalizedTarget.join('/').toLowerCase();
        if (normalizedPath.indexOf(normalizedBase + '/') === 0) return source;
      } catch (_) { return ''; }
    }
    return '';
  }

  function cssUrl(value, baseHref) {
    var source = normalizeSource(value, baseHref);
    if (!source) return '';
    var escaped = source.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\r/g, '\\d ').replace(/\n/g, '\\a ').replace(/\f/g, '\\c ');
    return 'url("' + escaped + '")';
  }

  function normalizeLink(value, allowMailto) {
    if (typeof value !== 'string') return '';
    var source = value.trim();
    if (!source || source.length > 4096 || /[\u0000-\u001f\u007f<>"'`\\]/.test(source) || source.slice(0, 2) === '//') return '';
    if (/^mailto:/i.test(source)) {
      if (allowMailto !== true || /[\r\n]/.test(source)) return '';
      try { return new URL(source).href; } catch (_) { return ''; }
    }
    if (!/^https?:\/\//i.test(source)) return '';
    var url;
    try { url = new URL(source); } catch (_) { return ''; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return '';
    return url.href;
  }

  function escapeAttribute(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function jsArgument(value) {
    var literal = JSON.stringify(String(value == null ? '' : value))
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return escapeAttribute(literal);
  }

  function normalizeFields(record, fields) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    fields.forEach(function (field) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) return;
      if (record[field] == null || record[field] === '') return;
      record[field] = normalizeSource(record[field]);
    });
  }

  function normalizeImageRows(rows) {
    if (!Array.isArray(rows)) return;
    rows.forEach(function (row) {
      if (typeof row === 'string') return;
      normalizeFields(row, ['dataUrl']);
    });
  }

  function requireRowIds(rows, fields, collection) {
    if (!Array.isArray(rows)) return;
    rows.forEach(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalidImport('IMPORT_RECORD_INVALID');
      fields.forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(row, field) && !validBindingId(row[field])) {
          throw invalidImport('IMPORT_ID_INVALID:' + collection + ':' + field);
        }
      });
    });
  }

  function sanitizeImportedArchive(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    requireRowIds(data.posts, ['id'], 'posts');
    requireRowIds(data.blogComments, ['id', 'postId'], 'blogComments');
    requireRowIds(data.groups, ['id'], 'groups');
    if (Array.isArray(data.groups)) data.groups.forEach(function (group) {
      if (!Array.isArray(group.members)) return;
      group.members.forEach(function (member) {
        var id = typeof member === 'string' ? member : member && member.characterId;
        if (id != null && !validBindingId(id)) throw invalidImport('IMPORT_ID_INVALID:groups:characterId');
      });
    });
    var about = Array.isArray(data.about) ? data.about : (data.about ? [data.about] : []);
    about.forEach(function (record) {
      normalizeFields(record, ['avatar', 'avatarUrl', 'bgImage', 'backgroundImage']);
      if (record && Array.isArray(record.galleryImages)) {
        record.galleryImages = record.galleryImages.map(function (image) { return normalizeSource(image); });
      }
    });
    ['apiConfigs', 'apiSettings'].forEach(function (key) {
      if (!Array.isArray(data[key])) return;
      data[key].forEach(function (record) {
        if (!validBindingId(record && record.id)) {
          throw invalidImport('API_CONFIG_ID_INVALID');
        }
        if (record.credentialRef != null && String(record.credentialRef).trim()
          && !validBindingId(record.credentialRef)) throw invalidImport('IMPORT_CREDENTIAL_REF_INVALID');
        normalizeFields(record, ['avatar', 'avatarUrl']);
        if (record && record.character) normalizeFields(record.character, ['avatar', 'avatarUrl']);
      });
    });
    ['chatMessages', 'messages', 'posts', 'moments'].forEach(function (key) {
      if (!Array.isArray(data[key])) return;
      data[key].forEach(function (record) {
        if (record && Array.isArray(record.images)) normalizeImageRows(record.images);
      });
    });
    return data;
  }

  function sanitizeSceneData(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    var scene = payload.scene;
    if (scene && typeof scene === 'object' && !Array.isArray(scene) && Array.isArray(scene.participants)) {
      scene.participants.forEach(function (participant) { normalizeFields(participant, ['avatar', 'avatarUrl']); });
    }
    return payload;
  }

  function validBindingId(value) { return SAFE_ID_RE.test(String(value == null ? '' : value)); }
  function invalidImport(code) { var error = new Error(code); error.code = code; return error; }

  return Object.freeze({
    normalizeSource: normalizeSource,
    cssUrl: cssUrl,
    normalizeLink: normalizeLink,
    escapeAttribute: escapeAttribute,
    jsArgument: jsArgument,
    sanitizeImportedArchive: sanitizeImportedArchive,
    sanitizeSceneData: sanitizeSceneData,
    validBindingId: validBindingId
  });
});
