'use strict';

/*
 * C3.4 DTO-only projection store contract.
 *
 * This module reads and updates only characters.id / characters.dto_json.
 * It does not join, select, or write the separate runtime-spec table. The
 * caller must already have validated the composite bundle, approval, row set,
 * authority mapping, and before/after DTO digests.
 */
const crypto = require('crypto');

const ALLOWED_DTO_FIELDS = Object.freeze(['model', 'capabilities']);
const ALLOWED_CAPABILITY_KEYS = Object.freeze(['chat', 'stream', 'vision', 'webSearch', 'imageGen']);
const SQL = Object.freeze({
  selectDto: 'SELECT id, dto_json FROM characters WHERE id=?',
  updateDto: 'UPDATE characters SET dto_json=? WHERE id=? AND dto_json=?'
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(key => {
      if (value[key] !== undefined) out[key] = stableValue(value[key]);
    });
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function dtoSha256(dto) {
  return sha256Hex(stableStringify(dto));
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function projectionError(code) {
  return Object.assign(new Error(code), { code: code });
}

function capabilityShapeIsCanonical(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some(key => ALLOWED_CAPABILITY_KEYS.indexOf(key) < 0)) return false;
  if (value.chat !== true) return false;
  for (const key of ['stream', 'vision', 'webSearch']) {
    if (typeof value[key] !== 'boolean') return false;
  }
  /* MobileDTO omits imageGen when false and emits it only when enabled. */
  if (Object.prototype.hasOwnProperty.call(value, 'imageGen') && value.imageGen !== true) return false;
  return true;
}

function changedTopLevelFields(before, after) {
  const keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after)))).sort();
  return keys.filter(key => {
    const beforeHas = Object.prototype.hasOwnProperty.call(before, key);
    const afterHas = Object.prototype.hasOwnProperty.call(after, key);
    return beforeHas !== afterHas || stableStringify(before[key]) !== stableStringify(after[key]);
  });
}

function validateDtoOnlyUpdate(update, currentDto) {
  if (!update || typeof update !== 'object' || !isPlainObject(currentDto) || !isPlainObject(update.nextDto)) {
    throw projectionError('CHARACTER_PROJECTION_BAD_UPDATE');
  }
  const id = String(update.id || '');
  if (!id || String(currentDto.id || '') !== id || String(update.nextDto.id || '') !== id) {
    throw projectionError('CHARACTER_PROJECTION_ID_MISMATCH');
  }
  const expectedPaths = Array.isArray(update.fieldPaths) ? update.fieldPaths.slice().sort() : [];
  if (!expectedPaths.length || expectedPaths.some(path =>
    path !== 'characters.dto_json.model' && path !== 'characters.dto_json.capabilities')) {
    throw projectionError('CHARACTER_PROJECTION_FORBIDDEN_FIELD');
  }
  if (new Set(expectedPaths).size !== expectedPaths.length) {
    throw projectionError('CHARACTER_PROJECTION_DUPLICATE_FIELD');
  }
  const actualFields = changedTopLevelFields(currentDto, update.nextDto);
  const expectedFields = expectedPaths.map(path => path.slice('characters.dto_json.'.length)).sort();
  if (stableStringify(actualFields) !== stableStringify(expectedFields)) {
    throw projectionError('CHARACTER_PROJECTION_FIELD_SET_MISMATCH');
  }
  if (actualFields.includes('model') && typeof update.nextDto.model !== 'string') {
    throw projectionError('CHARACTER_PROJECTION_BAD_MODEL');
  }
  if (actualFields.includes('capabilities') && !capabilityShapeIsCanonical(update.nextDto.capabilities)) {
    throw projectionError('CHARACTER_PROJECTION_BAD_CAPABILITIES');
  }
  for (const field of ['name', 'avatar', 'relationship']) {
    if (stableStringify(currentDto[field]) !== stableStringify(update.nextDto[field])) {
      throw projectionError('CHARACTER_PROJECTION_IDENTITY_OR_PROFILE_MUTATION');
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(String(update.expectedBeforeDtoSha256 || '')) ||
      !/^[a-f0-9]{64}$/i.test(String(update.expectedAfterDtoSha256 || ''))) {
    throw projectionError('CHARACTER_PROJECTION_DIGEST_REQUIRED');
  }
  if (dtoSha256(currentDto) !== String(update.expectedBeforeDtoSha256).toLowerCase()) {
    throw projectionError('CHARACTER_PROJECTION_BEFORE_DIGEST_MISMATCH');
  }
  if (dtoSha256(update.nextDto) !== String(update.expectedAfterDtoSha256).toLowerCase()) {
    throw projectionError('CHARACTER_PROJECTION_AFTER_DIGEST_MISMATCH');
  }
}

function createCharacterProjectionStore(db, options) {
  options = options || {};
  const readOnly = options.readOnly === true;
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('character-projection-store-requires-sqlite-db');
  }
  const select = db.prepare(SQL.selectDto);
  const update = readOnly ? null : db.prepare(SQL.updateDto);

  function readCharacterDtoProjections(ids) {
    if (!Array.isArray(ids) || !ids.length) throw projectionError('CHARACTER_PROJECTION_IDS_REQUIRED');
    const normalized = ids.map(id => String(id || '').trim());
    if (normalized.some(id => !id) || new Set(normalized).size !== normalized.length) {
      throw projectionError('CHARACTER_PROJECTION_IDS_INVALID');
    }
    return normalized.map(id => {
      const row = select.get(id);
      if (!row) return { id: id, exists: false, dto: null, dtoSha256: null };
      let dto;
      try { dto = JSON.parse(row.dto_json); } catch (_) { throw projectionError('CHARACTER_PROJECTION_DTO_INVALID'); }
      if (!isPlainObject(dto) || String(dto.id || '') !== id) throw projectionError('CHARACTER_PROJECTION_DTO_ID_INVALID');
      return { id: id, exists: true, dto: dto, dtoSha256: dtoSha256(dto) };
    });
  }

  function applyCharacterDtoProjectionBatch(updates) {
    if (readOnly) throw projectionError('CHARACTER_PROJECTION_READ_ONLY');
    if (!Array.isArray(updates) || !updates.length || updates.length > 8) {
      throw projectionError('CHARACTER_PROJECTION_BATCH_SIZE_INVALID');
    }
    const ids = updates.map(row => String(row && row.id || '').trim());
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw projectionError('CHARACTER_PROJECTION_DUPLICATE_ID');
    db.exec('BEGIN IMMEDIATE');
    try {
      const beforeRows = [];
      for (const requested of updates) {
        const id = String(requested.id);
        const currentRow = select.get(id);
        if (!currentRow) throw projectionError('CHARACTER_PROJECTION_TARGET_MISSING');
        let currentDto;
        try { currentDto = JSON.parse(currentRow.dto_json); } catch (_) { throw projectionError('CHARACTER_PROJECTION_DTO_INVALID'); }
        validateDtoOnlyUpdate(requested, currentDto);
        beforeRows.push({ requested: requested, id: id, rawDtoJson: currentRow.dto_json, beforeDto: currentDto });
      }

      for (const row of beforeRows) {
        const nextJson = JSON.stringify(row.requested.nextDto);
        const result = update.run(nextJson, row.id, row.rawDtoJson);
        if (Number(result && result.changes) !== 1) throw projectionError('CHARACTER_PROJECTION_CAS_FAILED');
      }

      const verified = [];
      for (const row of beforeRows) {
        const after = select.get(row.id);
        if (!after) throw projectionError('CHARACTER_PROJECTION_READBACK_MISSING');
        let dto;
        try { dto = JSON.parse(after.dto_json); } catch (_) { throw projectionError('CHARACTER_PROJECTION_READBACK_INVALID'); }
        const digest = dtoSha256(dto);
        if (digest !== String(row.requested.expectedAfterDtoSha256).toLowerCase()) {
          throw projectionError('CHARACTER_PROJECTION_READBACK_DIGEST_MISMATCH');
        }
        verified.push({ id: row.id, beforeDtoSha256: row.requested.expectedBeforeDtoSha256, afterDtoSha256: digest });
      }
      db.exec('COMMIT');
      return { ok: true, updated: verified.length, deleted: 0, rows: verified };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* keep the original failure */ }
      throw error;
    }
  }

  return Object.freeze({
    readCharacterDtoProjections: readCharacterDtoProjections,
    applyCharacterDtoProjectionBatch: applyCharacterDtoProjectionBatch
  });
}

module.exports = createCharacterProjectionStore;
module.exports.stableStringify = stableStringify;
module.exports.dtoSha256 = dtoSha256;
module.exports.validateDtoOnlyUpdate = validateDtoOnlyUpdate;
