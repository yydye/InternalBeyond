'use strict';

/*
 * P32 · Host-origin compatibility
 *
 * Tauri 2 serves a bundled webview from its own local origin instead of from
 * 127.0.0.1 or file://. This helper is deliberately tiny and shared by the
 * existing local HTTP/WebSocket gates so the host adapter does not need a new
 * transport or a second authentication model.
 */

const TAURI_ORIGIN_RE = /^https?:\/\/tauri\.localhost(?::\d+)?$/i;
const DEV_WEB_PORT = 23130;

function isTauriOrigin(origin) {
  return TAURI_ORIGIN_RE.test(String(origin == null ? '' : origin).trim());
}

function isDevWebOrigin(origin) {
  try {
    const parsed = new URL(String(origin == null ? '' : origin));
    const host = String(parsed.hostname || '').toLowerCase();
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (host === '127.0.0.1' || host === 'localhost' || host === '::1')
      && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === DEV_WEB_PORT;
  } catch (_) {
    return false;
  }
}

function blocksDevWebOrigin(origin, env) {
  return String((env || process.env).IB_DEV_MODE || '') !== '1' && isDevWebOrigin(origin);
}

module.exports = {
  TAURI_ORIGIN_RE,
  DEV_WEB_PORT,
  isTauriOrigin,
  isDevWebOrigin,
  blocksDevWebOrigin
};
