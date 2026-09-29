'use strict';

/* P35.4 evidence serializer. The only artifact-validation authority is the
   exact, unmodified ValidationResult object issued by artifact-validator.js. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const contract = require('./contract.js');
const artifactValidator = require('./artifact-validator.js');
const updateManifest = require('../../runtime/update-manifest.js');
const validationSchema = require('./schemas/validation-result.schema.json');
const artifactManifestSchema = require('./schemas/artifact-manifest.schema.json');
const writerResultSchema = require('./schemas/artifact-manifest-write-result.schema.json');

const RESULT_SCHEMA = 'internalbeyond.artifact-manifest-write-result';
const OUTPUT_ROOTS = Object.freeze({
  release: Object.freeze(['dist']),
  test: Object.freeze(['tmp', 'installer-smoke-build'])
});
const RELEASE_CHECKS = Object.freeze([
  'request-contract', 'root-version', 'artifact-filename', 'artifact-path-boundary',
  'artifact-size', 'artifact-sha256', 'inno-identity-source', 'installer-pe-version',
  'sha256-sums', 'inno-compile-identity', 'build-metadata-version',
  'build-metadata-sha256', 'build-metadata-size', 'build-metadata-filename',
  'canonical-update-metadata', 'staging-payload-manifest', 'staging-user-data-policy',
  'staging-secret-scan', 'staging-payload-deny-rules', 'staging-static-path-scan',
  'staging-content-audit', 'staging-dynamic-path-scan', 'inno-payload-compression',
  'canonical-source-closure', 'build-source-provenance'
]);
const TEST_CHECKS = Object.freeze([
  'request-contract', 'root-version', 'artifact-filename', 'artifact-path-boundary',
  'artifact-size', 'artifact-sha256', 'inno-identity-source', 'installer-pe-version',
  'sha256-sums', 'inno-compile-identity', 'test-mode-stable-manifest',
  'test-installer-identity', 'staging-payload-manifest', 'staging-user-data-policy',
  'staging-secret-scan', 'staging-payload-deny-rules', 'staging-static-path-scan',
  'staging-content-audit', 'staging-dynamic-path-scan', 'inno-payload-compression',
  'canonical-source-closure', 'build-source-provenance'
]);
const FORBIDDEN_KEYS = new Set([
  'apikey', 'credential', 'credentials', 'credentialref', 'vault', 'userdata',
  'userprofile', 'memory', 'memorydata', 'chathistory', 'indexeddb', 'sqlite',
  'appdata', 'secret', 'secrets', 'authorization', 'bearer', 'homeNodeData'.toLowerCase()
]);
const PATH_KEYS = new Set(['path', 'outputpath', 'outputroot', 'manifestpath', 'directory', 'dir', 'root']);
const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch (_) { return false; }
}

function onlyFields(value, allowed, code, field) {
  if (!isPlainObject(value)) return { ok: false, code: code, field: field };
  let keys;
  try { keys = Reflect.ownKeys(value); } catch (_) { return { ok: false, code: code, field: field }; }
  for (const key of keys) {
    if (typeof key !== 'string') return { ok: false, code: code, field: field };
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) { descriptor = null; }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      return { ok: false, code: code, field: field + '.' + key };
    }
    if (!allowed.has(key)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const forbidden = FORBIDDEN_KEYS.has(normalized) ||
        /(?:apikey|credential|vault|userdata|memory|chathistory|indexeddb|sqlite|appdata|secret|authorization|bearer)/.test(normalized);
      const pathLike = PATH_KEYS.has(normalized) || /(?:absolute|developer|repository|workspace).*(?:path|root|directory)/.test(normalized);
      return {
        ok: false,
        code: pathLike ? 'OUTPUT_PATH_INVALID' : (forbidden ? 'FORBIDDEN_FIELD_DETECTED' : code),
        field: field + '.' + key
      };
    }
  }
  return { ok: true };
}

function isJsonData(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) return false;
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length > 10000 || keys.length !== length + 1) return false;
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
      }
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !isJsonData(descriptor.value, seen)) return false;
      }
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of keys) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          !isJsonData(descriptor.value, seen)) return false;
    }
    return true;
  } catch (_) { return false; }
  finally { seen.delete(value); }
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function isDateTime(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_RE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/* Minimal JSON Schema 2020-12 evaluator for the keywords in the frozen P35
   P35 schemas. It intentionally has no network/ref resolver or side effects. */
function validateSchemaValue(value, schema, location, errors) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      errors.push(location);
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) errors.push(location);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) errors.push(location);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(location);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(location);
    if (schema.pattern) {
      let pattern;
      try { pattern = new RegExp(schema.pattern); } catch (_) { errors.push(location); }
      if (pattern && !pattern.test(value)) errors.push(location);
    }
    if (schema.format === 'date-time' && !isDateTime(value)) errors.push(location);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(location);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(location);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateSchemaValue(item, schema.items, location + '[' + index + ']', errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(location + '.' + key);
    }
    const properties = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateSchemaValue(value[key], properties[key], location + '.' + key, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(location + '.' + key);
      }
    }
  }
  for (const subSchema of schema.allOf || []) validateSchemaValue(value, subSchema, location, errors);
  if (schema.if) {
    const conditionErrors = [];
    validateSchemaValue(value, schema.if, location, conditionErrors);
    if (!conditionErrors.length && schema.then) validateSchemaValue(value, schema.then, location, errors);
  }
}

function conformsToSchema(value, schema) {
  if (!isJsonData(value, new Set())) return false;
  const errors = [];
  validateSchemaValue(value, schema, '$', errors);
  return errors.length === 0;
}

function canonicalTimestamp(value) {
  return typeof value === 'string' && isDateTime(value);
}

function resultCheckSet(mode) {
  return mode === 'release' ? RELEASE_CHECKS : TEST_CHECKS;
}

function validationSemanticsAreComplete(result, job) {
  const context = result.context;
  const checks = result.checks;
  if (!Array.isArray(checks) || !checks.length || !context || context.target !== job.target ||
      context.mode !== job.mode || context.version !== job.version || context.dirty !== false ||
      typeof context.revision !== 'string' || !REVISION_RE.test(context.revision)) return false;
  if (result.summary.pass !== checks.length || result.summary.warn !== 0 || result.summary.fail !== 0) return false;
  const seen = new Set();
  for (const check of checks) {
    if (seen.has(check.id) || check.status !== 'PASS' || check.code !== null) return false;
    seen.add(check.id);
  }
  return resultCheckSet(job.mode).every((id) => seen.has(id));
}

function deny(code, message) {
  return {
    status: 'DENIED', code: code, message: message,
    manifest: null, serialized: null, sha256: null
  };
}

function validateBuildRequest(request) {
  if (!isJsonData(request, new Set())) {
    return { error: deny('INVALID_REQUEST', 'Request must contain only plain JSON data fields.') };
  }
  const requestFields = onlyFields(request, new Set(['job', 'validationResult', 'provenance']), 'INVALID_REQUEST', 'request');
  if (!requestFields.ok) return { error: deny(requestFields.code, 'Only job, validationResult and explicit provenance inputs are accepted.') };
  if (!Object.prototype.hasOwnProperty.call(request, 'job')) {
    return { error: deny('INVALID_REQUEST', 'PackagingJob is required.') };
  }
  if (!Object.prototype.hasOwnProperty.call(request, 'validationResult') ||
      !isJsonData(request.validationResult, new Set()) ||
      !artifactValidator.isIssuedValidationResult(request.validationResult) ||
      !conformsToSchema(request.validationResult, validationSchema)) {
    return { error: deny('VALIDATION_RESULT_INVALID', 'ValidationResult was not issued unchanged by the P35.3 Validator or does not match its schema.') };
  }
  const provenanceFields = onlyFields(request.provenance, new Set(['createdAt']), 'INVALID_REQUEST', 'provenance');
  if (!provenanceFields.ok || !Object.prototype.hasOwnProperty.call(request.provenance, 'createdAt') ||
      !canonicalTimestamp(request.provenance.createdAt)) {
    return { error: deny(provenanceFields.ok ? 'INVALID_REQUEST' : provenanceFields.code,
      'provenance.createdAt must be an explicit canonical UTC timestamp; the Writer does not create one.') };
  }
  let job;
  try {
    job = contract.resolveJobVersion(request.job, request.validationResult.context.version);
    if (job.target !== 'windows-installer' || !['release', 'test'].includes(job.mode)) throw new Error('unsupported target/mode');
  } catch (error) {
    const code = error && error.code === 'FORBIDDEN_FIELD' ? 'FORBIDDEN_FIELD_DETECTED' : 'INVALID_REQUEST';
    return { error: deny(code, 'PackagingJob is invalid or does not match the validated version contract.') };
  }

  const result = request.validationResult;
  if (result.status !== 'PASS' || result.valid !== true) {
    return { error: deny('VALIDATION_NOT_PASS', 'Only a complete ValidationResult with status PASS and valid=true may produce a manifest.') };
  }
  if (!validationSemanticsAreComplete(result, job)) {
    return { error: deny('VALIDATION_RESULT_INVALID', 'ValidationResult PASS status, summary, context or required checks are incomplete or inconsistent.') };
  }
  const artifact = result.artifact;
  if (!artifact || typeof artifact.name !== 'string' || artifact.name.length > 128 ||
      /[\\/:]/.test(artifact.name) || artifact.name === '.' || artifact.name === '..' ||
      !/\.exe$/i.test(artifact.name) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
      !SHA256_RE.test(artifact.sha256)) {
    return { error: deny('VALIDATION_RESULT_INVALID', 'ValidationResult artifact identity is not a safe Windows installer identity.') };
  }
  if (job.mode === 'release' && artifact.name !== updateManifest.installerAssetName(job.version)) {
    return { error: deny('VALIDATION_RESULT_INVALID', 'ValidationResult artifact name does not match the canonical release asset name.') };
  }
  return { job: job, result: result, createdAt: request.provenance.createdAt };
}

function buildArtifactManifest(request) {
  const input = validateBuildRequest(request);
  if (input.error) return input.error;
  const result = input.result;
  const manifest = {
    schema: 'internalbeyond.artifact-manifest',
    schemaVersion: 1,
    product: 'InternalBeyond',
    target: result.context.target,
    version: result.context.version,
    revision: result.context.revision,
    sourceDirty: result.context.dirty,
    mode: result.context.mode,
    channel: input.job.channel,
    options: {
      includeDocs: input.job.options.includeDocs,
      includeExamples: input.job.options.includeExamples
    },
    createdAt: input.createdAt,
    artifactFile: result.artifact.name,
    artifactBytes: result.artifact.size,
    hash: result.artifact.sha256,
    validated: true,
    validation: {
      status: 'PASS',
      checks: result.checks.map((check) => ({ id: check.id, status: check.status }))
    }
  };
  if (!conformsToSchema(manifest, artifactManifestSchema)) {
    return deny('MANIFEST_SCHEMA_INVALID', 'Derived manifest does not satisfy the frozen artifact-manifest schema.');
  }
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  const bytes = Buffer.from(serialized, 'utf8');
  return {
    status: 'BUILT', code: null, message: 'Artifact manifest was deterministically derived from a complete Validator PASS.',
    manifest: manifest, serialized: serialized, sha256: sha256(bytes)
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function sameCanonicalPath(left, right) {
  const normalize = function (value) {
    let result = path.resolve(value).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
    if (process.platform === 'win32') result = result.toLowerCase();
    return result;
  };
  return normalize(left) === normalize(right);
}

function realpath(io, target) {
  return io.realpathSync.native ? io.realpathSync.native(target) : io.realpathSync(target);
}

function resolveOutputDirectory(root, mode, io) {
  const parts = OUTPUT_ROOTS[mode];
  if (!parts) return { ok: false };
  let rootReal;
  try { rootReal = realpath(io, root); } catch (_) { return { ok: false }; }
  let current = rootReal;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = io.lstatSync(current); } catch (_) { return { ok: false }; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false };
    let real;
    try { real = realpath(io, current); } catch (_) { return { ok: false }; }
    if (!within(rootReal, real) || !sameCanonicalPath(current, real)) return { ok: false };
  }
  return { ok: true, path: current, root: rootReal };
}

function inspectOutputFile(io, directory, name) {
  const target = path.join(directory, name);
  let stat;
  try { stat = io.lstatSync(target); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, exists: false, path: target };
    return { ok: false, exists: false };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return { ok: false, exists: true };
  let real;
  try { real = realpath(io, target); } catch (_) { return { ok: false, exists: true }; }
  if (!within(directory, real) || !sameCanonicalPath(target, real)) return { ok: false, exists: true };
  return { ok: true, exists: true, path: real, stat: stat };
}

function verifyReadback(bytes, expected, schema) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch (_) { return { ok: false, code: 'MANIFEST_READBACK_FAILED' }; }
  if (!conformsToSchema(parsed, schema)) return { ok: false, code: 'MANIFEST_READBACK_FAILED' };
  if (!buffer.equals(expected)) return { ok: false, code: 'MANIFEST_CONTENT_MISMATCH' };
  return { ok: true };
}

function writerResult(status, code, message, manifestName, digest) {
  const result = {
    schema: RESULT_SCHEMA,
    schemaVersion: 1,
    status: status,
    code: code || null,
    message: message,
    manifest: manifestName ? { name: manifestName, sha256: digest || '' } : null
  };
  if (!conformsToSchema(result, writerResultSchema)) {
    throw new Error('internal manifest writer result violates its schema');
  }
  return result;
}

function normalizeIo(overrides) {
  return Object.assign({
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    readFileSync: fs.readFileSync,
    linkSync: fs.linkSync,
    unlinkSync: fs.unlinkSync
  }, overrides || {});
}

function writeArtifactManifest(request, options) {
  const built = buildArtifactManifest(request);
  if (built.status !== 'BUILT') {
    return writerResult('DENIED', built.code, built.message, null, null);
  }
  const o = options || {};
  const root = path.resolve(o.root || path.resolve(__dirname, '..', '..'));
  const io = normalizeIo(o.io);
  const mode = built.manifest.mode;
  const output = resolveOutputDirectory(root, mode, io);
  if (!output.ok) {
    return writerResult('DENIED', 'OUTPUT_PATH_INVALID', 'The mode-specific canonical output directory is missing or unsafe.', null, null);
  }
  const manifestName = built.manifest.artifactFile + '.manifest.json';
  const existing = inspectOutputFile(io, output.path, manifestName);
  if (!existing.ok) {
    return writerResult('DENIED', 'OUTPUT_PATH_INVALID', 'The canonical sidecar path is not a regular, contained file path.', null, null);
  }
  const expectedBytes = Buffer.from(built.serialized, 'utf8');
  if (existing.exists) {
    let bytes;
    try { bytes = io.readFileSync(existing.path); }
    catch (_) { return writerResult('FAILED', 'MANIFEST_WRITE_FAILED', 'Existing sidecar could not be read safely.', null, null); }
    if (Buffer.isBuffer(bytes) && bytes.equals(expectedBytes)) {
      return writerResult('ALREADY_IDENTICAL', null, 'An identical canonical sidecar already exists; no file was changed.', manifestName, built.sha256);
    }
    return writerResult('DENIED', 'MANIFEST_ALREADY_EXISTS_CONFLICT', 'A different sidecar already exists and was left untouched.', null, null);
  }

  const tempName = '.p35-' + manifestName + '.tmp';
  const temp = inspectOutputFile(io, output.path, tempName);
  if (!temp.ok || temp.exists) {
    return writerResult('FAILED', 'MANIFEST_WRITE_FAILED', 'The deterministic temporary sidecar path is unavailable; no existing file was removed.', null, null);
  }
  let descriptor = null;
  let tempOwned = false;
  try {
    descriptor = io.openSync(temp.path, 'wx', 0o600);
    tempOwned = true;
    io.writeFileSync(descriptor, expectedBytes);
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = null;

    const tempEvidence = inspectOutputFile(io, output.path, tempName);
    if (!tempEvidence.ok || !tempEvidence.exists) {
      return writerResult('FAILED', 'MANIFEST_READBACK_FAILED', 'Temporary sidecar could not be read back from its canonical directory.', null, null);
    }
    let tempBytes;
    try { tempBytes = io.readFileSync(tempEvidence.path); }
    catch (_) { return writerResult('FAILED', 'MANIFEST_READBACK_FAILED', 'Temporary sidecar could not be read back.', null, null); }
    const tempCheck = verifyReadback(tempBytes, expectedBytes, artifactManifestSchema);
    if (!tempCheck.ok) {
      return writerResult('FAILED', tempCheck.code, 'Temporary sidecar failed schema/read-back verification.', null, null);
    }

    try { io.linkSync(tempEvidence.path, path.join(output.path, manifestName)); }
    catch (error) {
      if (error && error.code === 'EEXIST') {
        const raced = inspectOutputFile(io, output.path, manifestName);
        if (raced.ok && raced.exists) {
          try {
            const racedBytes = io.readFileSync(raced.path);
            if (Buffer.isBuffer(racedBytes) && racedBytes.equals(expectedBytes)) {
              return writerResult('ALREADY_IDENTICAL', null, 'An identical canonical sidecar won the concurrent create; no file was replaced.', manifestName, built.sha256);
            }
          } catch (_) { /* Report conflict below without exposing file content. */ }
          return writerResult('DENIED', 'MANIFEST_ALREADY_EXISTS_CONFLICT', 'A different sidecar won the concurrent create and was left untouched.', null, null);
        }
        return writerResult('DENIED', 'OUTPUT_PATH_INVALID', 'The sidecar path changed while writing.', null, null);
      }
      throw error;
    }

    /* linkSync publishes the already-flushed inode atomically and fails rather
       than replacing a concurrently-created destination. */
    io.unlinkSync(tempEvidence.path);
    tempOwned = false;
    const finalEvidence = inspectOutputFile(io, output.path, manifestName);
    if (!finalEvidence.ok || !finalEvidence.exists) {
      return writerResult('FAILED', 'MANIFEST_READBACK_FAILED', 'Committed sidecar is missing or unsafe on read-back.', null, null);
    }
    let finalBytes;
    try { finalBytes = io.readFileSync(finalEvidence.path); }
    catch (_) { return writerResult('FAILED', 'MANIFEST_READBACK_FAILED', 'Committed sidecar could not be read back.', null, null); }
    const finalCheck = verifyReadback(finalBytes, expectedBytes, artifactManifestSchema);
    if (!finalCheck.ok) {
      return writerResult('FAILED', finalCheck.code, 'Committed sidecar failed schema/read-back verification.', null, null);
    }
    return writerResult('WRITTEN', null, 'Artifact manifest sidecar was atomically created and verified.', manifestName, built.sha256);
  } catch (_) {
    return writerResult('FAILED', 'MANIFEST_WRITE_FAILED', 'Manifest sidecar could not be written atomically; the artifact was not changed.', null, null);
  } finally {
    if (descriptor !== null) {
      try { io.closeSync(descriptor); } catch (_) { /* Preserve the primary result. */ }
    }
    if (tempOwned) {
      try { io.unlinkSync(temp.path); } catch (_) { /* Only remove this invocation's exclusive temp file. */ }
    }
  }
}

module.exports = {
  RESULT_SCHEMA: RESULT_SCHEMA,
  OUTPUT_ROOTS: OUTPUT_ROOTS,
  buildArtifactManifest: buildArtifactManifest,
  writeArtifactManifest: writeArtifactManifest
};
