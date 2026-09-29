'use strict';

const TARGETS = Object.freeze({
  'windows-installer': 'supported',
  'windows-portable': 'reserved',
  'web-export': 'reserved',
  'android-apk': 'reserved'
});

const MODES = Object.freeze(['release', 'debug', 'test']);
const CHANNELS = Object.freeze(['stable', 'local']);
const JOB_FIELDS = new Set(['id', 'target', 'version', 'channel', 'mode', 'options']);
const OPTION_FIELDS = new Set(['includeDocs', 'includeExamples']);
const FORBIDDEN_FIELDS = new Set([
  'apikey', 'credential', 'credentials', 'vault', 'userdata', 'userprofile',
  'memory', 'memorydata', 'chathistory', 'indexeddb', 'sqlite', 'appdata',
  'secret', 'secrets', 'env', 'environment'
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

class PackagingContractError extends Error {
  constructor(code, field) {
    super('PackagingJob rejected (' + code + ')' + (field ? ' at ' + field : ''));
    this.name = 'PackagingContractError';
    this.code = code;
    this.field = field || '';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeFieldName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertNoForbiddenFields(value, fieldPath, seen) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new PackagingContractError('CYCLIC_VALUE', fieldPath);
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new PackagingContractError('INVALID_OBJECT', fieldPath);
  }
  seen.add(value);
  const keys = Object.keys(value);
  for (const key of keys) {
    const next = fieldPath ? fieldPath + '.' + key : key;
    if (FORBIDDEN_FIELDS.has(normalizeFieldName(key))) {
      throw new PackagingContractError('FORBIDDEN_FIELD', next);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new PackagingContractError('ACCESSOR_NOT_ALLOWED', next);
    }
    assertNoForbiddenFields(descriptor.value, next, seen);
  }
  seen.delete(value);
}

function rejectUnknownFields(object, allowed, prefix) {
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new PackagingContractError('UNKNOWN_FIELD', (prefix ? prefix + '.' : '') + String(key));
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      throw new PackagingContractError('ACCESSOR_NOT_ALLOWED', (prefix ? prefix + '.' : '') + key);
    }
  }
}

function validatePackagingJob(input) {
  if (!isPlainObject(input)) throw new PackagingContractError('JOB_MUST_BE_OBJECT', '');
  assertNoForbiddenFields(input, '', new Set());
  rejectUnknownFields(input, JOB_FIELDS, '');

  for (const field of ['id', 'target', 'version', 'channel', 'mode', 'options']) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      throw new PackagingContractError('REQUIRED_FIELD', field);
    }
  }

  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    throw new PackagingContractError('INVALID_ID', 'id');
  }
  if (typeof input.target !== 'string' || !Object.prototype.hasOwnProperty.call(TARGETS, input.target)) {
    throw new PackagingContractError('INVALID_TARGET', 'target');
  }
  if (typeof input.version !== 'string' || (input.version !== '' && !VERSION_PATTERN.test(input.version))) {
    throw new PackagingContractError('INVALID_VERSION', 'version');
  }
  if (typeof input.mode !== 'string' || !MODES.includes(input.mode)) {
    throw new PackagingContractError('INVALID_MODE', 'mode');
  }
  if (typeof input.channel !== 'string' || !CHANNELS.includes(input.channel)) {
    throw new PackagingContractError('INVALID_CHANNEL', 'channel');
  }
  const expectedChannel = input.mode === 'release' ? 'stable' : 'local';
  if (input.channel !== expectedChannel) {
    throw new PackagingContractError('MODE_CHANNEL_MISMATCH', 'channel');
  }
  if (!isPlainObject(input.options)) throw new PackagingContractError('OPTIONS_MUST_BE_OBJECT', 'options');
  assertNoForbiddenFields(input.options, 'options', new Set());
  rejectUnknownFields(input.options, OPTION_FIELDS, 'options');

  const options = {
    includeDocs: Object.prototype.hasOwnProperty.call(input.options, 'includeDocs')
      ? input.options.includeDocs : false,
    includeExamples: Object.prototype.hasOwnProperty.call(input.options, 'includeExamples')
      ? input.options.includeExamples : false
  };
  for (const key of Object.keys(options)) {
    if (typeof options[key] !== 'boolean') {
      throw new PackagingContractError('OPTION_MUST_BE_BOOLEAN', 'options.' + key);
    }
    if (options[key] !== false) {
      throw new PackagingContractError('OPTION_NOT_SUPPORTED', 'options.' + key);
    }
  }

  return Object.freeze({
    id: input.id,
    target: input.target,
    version: input.version,
    channel: input.channel,
    mode: input.mode,
    options: Object.freeze(options),
    targetState: TARGETS[input.target]
  });
}

function getAvailableTargets() {
  return Object.keys(TARGETS)
    .filter((target) => TARGETS[target] === 'supported')
    .map((id) => Object.freeze({ id: id, enabled: true }));
}

function getReservedTargets() {
  return Object.keys(TARGETS)
    .filter((target) => TARGETS[target] === 'reserved')
    .map((id) => Object.freeze({ id: id, enabled: false }));
}

function resolveJobVersion(job, canonicalVersion) {
  const normalized = validatePackagingJob(job);
  if (typeof canonicalVersion !== 'string' || !VERSION_PATTERN.test(canonicalVersion)) {
    throw new PackagingContractError('CANONICAL_VERSION_INVALID', 'VERSION');
  }
  if (normalized.version && normalized.version !== canonicalVersion) {
    throw new PackagingContractError('VERSION_MISMATCH', 'version');
  }
  return Object.freeze(Object.assign({}, normalized, { version: canonicalVersion }));
}

module.exports = {
  TARGETS: TARGETS,
  MODES: MODES,
  CHANNELS: CHANNELS,
  PackagingContractError: PackagingContractError,
  validatePackagingJob: validatePackagingJob,
  resolveJobVersion: resolveJobVersion,
  getAvailableTargets: getAvailableTargets,
  getReservedTargets: getReservedTargets,
  VERSION_PATTERN: VERSION_PATTERN
};
