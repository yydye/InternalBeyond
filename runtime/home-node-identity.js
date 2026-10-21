'use strict';

/* Stable, non-secret identity for the directory that owns canonical Home Node
 * data. The raw path stays local to the service and is never exposed by /health. */
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const HOME_NODE_PROTOCOL_VERSION = 1;

function normalizedDirectory(directory) {
  return path.resolve(String(directory || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function dataDirectoryId(directory) {
  const normalized = normalizedDirectory(directory);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/* Stable identity for a Home Node authority, separate from its data-directory
 * fingerprint and from a transient Tauri Host session. Production uses its
 * resolved installation root; Dev/Synthetic additionally bind the per-launch
 * instance id so a second Dev session cannot borrow the first one's node. */
function instanceId(environment, runtimeRoot, devInstanceId) {
  const mode = String(environment || '').trim().toLowerCase();
  if (!new Set(['production', 'dev', 'synthetic']).has(mode)) return '';
  const root = normalizedDirectory(runtimeRoot);
  if (!root) return '';
  const devId = mode === 'production' ? '' : String(devInstanceId || '').trim().toLowerCase();
  if (mode !== 'production' && !devId) return '';
  const identity = ['internalbeyond-home-node-instance-v1', mode, root, devId].join('\n');
  return crypto.createHash('sha256').update(identity, 'utf8').digest('hex');
}

function homeNodeDataDirectory(env, devIdentity) {
  env = env || process.env;
  if (devIdentity && (devIdentity.mode === 'dev' || devIdentity.mode === 'synthetic')) {
    return path.join(devIdentity.sandboxRoot, 'home-node');
  }
  const configured = String(env.IB_HOME_NODE_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, 'InternalBeyond', 'home-node');
  }
  return path.join(os.homedir(), '.internal-beyond', 'home-node');
}

module.exports = Object.freeze({
  HOME_NODE_PROTOCOL_VERSION,
  normalizedDirectory,
  dataDirectoryId,
  instanceId,
  homeNodeDataDirectory
});
