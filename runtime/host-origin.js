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

function isTauriOrigin(origin) {
  return TAURI_ORIGIN_RE.test(String(origin == null ? '' : origin).trim());
}

module.exports = {
  TAURI_ORIGIN_RE,
  isTauriOrigin
};
