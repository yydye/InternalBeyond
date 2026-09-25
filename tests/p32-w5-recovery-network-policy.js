'use strict';

function classifyDestination(value, pageOrigin) {
  let url;
  try {
    const raw = value && value.url ? value.url : value;
    url = new URL(String(raw), String(pageOrigin || 'http://tauri.localhost'));
  } catch (_) {
    return { kind: 'UNPARSEABLE', scheme: '', host: '' };
  }

  const host = String(url.hostname || '').toLowerCase();
  const scheme = String(url.protocol || '').toLowerCase();
  if ((scheme === 'http:' || scheme === 'https:') && host === 'ipc.localhost') {
    return { kind: 'TAURI_LOCAL_IPC', scheme: scheme.slice(0, -1), host };
  }
  if (url.origin === pageOrigin || scheme === 'tauri:' || host === 'localhost' ||
      host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) {
    return { kind: 'LOCAL', scheme: scheme.slice(0, -1), host };
  }
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'ws:' || scheme === 'wss:') {
    return { kind: 'EXTERNAL', scheme: scheme.slice(0, -1), host };
  }
  return { kind: 'OTHER_SCHEME', scheme: scheme.slice(0, -1), host };
}

function extractSafeTauriCommand(body, urlValue) {
  const readOnly = 'read_recovery_checkpoint';
  const knownCommands = [
    'read_recovery_checkpoint',
    'open_recovery_apply_window',
    'close_recovery_apply_window',
    'write_recovery_checkpoint',
    'mark_recovery_checkpoint_verified',
    'clear_recovery_checkpoint_after_rollback'
  ];
  let routeCommand = null;
  try {
    const url = new URL(String(urlValue));
    const route = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    if (knownCommands.includes(route)) routeCommand = route;
  } catch (_) {}

  let bodyCommand = null;
  try {
    if (typeof body === 'string') {
      const value = JSON.parse(body);
      const candidates = [
        value && value.cmd,
        value && value.command,
        value && value.payload && value.payload.cmd,
        value && value.payload && value.payload.command
      ];
      bodyCommand = candidates.find(command => knownCommands.includes(command)) || null;
    }
  } catch (_) {
    bodyCommand = null;
  }
  if (routeCommand && bodyCommand && routeCommand !== bodyCommand) return null;
  return (bodyCommand || routeCommand) === readOnly ? readOnly : null;
}

function decideTauriIpc(urlValue, pageOrigin, method, body) {
  const destination = classifyDestination(urlValue, pageOrigin);
  if (destination.kind !== 'TAURI_LOCAL_IPC') {
    return { action: destination.kind === 'EXTERNAL' ? 'BLOCK_EXTERNAL' : 'BLOCK_NON_IPC', command: null };
  }
  const command = extractSafeTauriCommand(body, urlValue);
  if (String(method || '').toUpperCase() === 'POST' &&
      command === 'read_recovery_checkpoint') {
    return { action: 'ALLOW_READ_ONLY_TAURI_IPC', command };
  }
  return { action: 'BLOCK_TAURI_IPC', command: null };
}

module.exports = Object.freeze({
  classifyDestination,
  extractSafeTauriCommand,
  decideTauriIpc
});
