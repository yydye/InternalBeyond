'use strict';

/*
 * Home Node transport adapter for Tencent QQ Bot C2C and explicitly authorized groups.
 *
 * This owns only the official SDK connection and a bounded, in-memory handoff
 * queue. Provider, role, Memory and conversation history remain in the existing
 * desktop QQ conversation adapter. AppSecret is resolved from the existing
 * encrypted Vault at explicit connect time and is never returned or logged.
 */

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const createCredentialResolver = require('../../active/credential-resolver.js');

const MAX_ACCOUNTS = 16;
const MAX_OPENIDS = 20;
const MAX_GROUP_BINDINGS = 32;
const DEFAULT_SESSION_ID = 'default';
const MAX_PENDING = 48;
const MAX_SEEN = 4096;
const MAX_SENT_GROUP_ECHOES = 2048;
const MAX_MESSAGE_CHARS = 6000;
const MAX_REPLY_CHARS = 1800;
const IMAGE_REPLY_TIMEOUT_MS = 360000;
const MAX_IMAGE_COUNT = 3;
const MAX_CONCURRENT_IMAGE_DOWNLOADS = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_OUTBOUND_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_HOST_SUFFIXES = Object.freeze(['qq.com', 'qq.com.cn', 'qpic.cn']);
const REPLY_TIMEOUT_MS = 30000;
/* QQBot 1.0.5 defaults OpenAPI requests to 30s; disconnect waits through the
   in-flight passive reply so it cannot complete after a successful stop ACK. */
const SEND_STOP_WAIT_MS = 32000;
const CLIENT_LEASE_MS = 12000;
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPEN_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,512}$/u;

/* Tencent's SDK 1.0.5 source names this combined bit GROUP_AND_C2C (1 << 25)
   but does not export the symbolic constant. The value is pinned to that SDK
   version; group text/attachments are read only after @, group allowlist and takeover checks. */
const C2C_AND_GROUP_INTENT_V105 = 1 << 25;

const ERROR_CODES = new Set([
  'credential-vault-unavailable', 'credential-vault-provider-mismatch',
  'official-sdk-unavailable', 'official-invalid-credentials',
  'official-app-not-authorized', 'official-intent-not-accepted',
  'official-network-error', 'official-start-failed', 'official-send-failed',
  'official-stopped', 'takeover-paused', 'message-not-allowed',
  'combined-intent-consent-required',
  'invalid-request', 'invalid-stage-transition', 'account-not-configured', 'account-not-connected',
  'worker-inactive', 'request-not-pending', 'provider-unavailable', 'provider-failed', 'queue-full',
  'invalid-group-list', 'invalid-group-binding', 'invalid-group-openid', 'duplicate-group-openid',
  'invalid-group-admin-list', 'invalid-group-admin-openid', 'duplicate-group-admin-openid',
  'invalid-private-role-selection-list', 'invalid-private-role-selection', 'duplicate-private-role-selection',
  'invalid-session-id',
  'group-role-required', 'group-not-allowed', 'group-paused',
  'role-unavailable', 'role-config-unavailable', 'context-failed', 'invalid-event',
  'empty-output', 'request-timeout', 'home-node-unreachable', 'image-source-rejected',
  'image-source-domain-rejected', 'image-source-protocol-rejected', 'image-redirect-rejected',
  'image-dns-failed', 'image-dns-rejected', 'image-download-failed', 'image-download-timeout',
  'image-http-rejected', 'image-network-failed', 'image-network-unreachable', 'image-ipv6-unreachable',
  'image-connection-refused', 'image-connection-reset', 'image-connection-closed',
  'image-address-family-unavailable', 'image-lookup-result-invalid', 'image-tls-failed', 'image-attachment-invalid',
  'image-type-mismatch', 'image-too-large', 'image-type-unsupported', 'vision-unavailable',
  'image-input-invalid', 'image-output-invalid', 'image-output-disabled', 'attachments-unsupported'
]);

const DIAGNOSTIC_STAGES = new Set([
  'websocket-connecting', 'websocket-connected', 'websocket-reconnecting', 'websocket-disconnected',
  'non-c2c-dropped', 'self-echo-dropped', 'open-id-denied', 'global-paused', 'account-manual',
  'group-no-mention', 'group-not-allowed', 'group-manual', 'group-paused',
  'worker-inactive', 'invalid-reply-target', 'attachments-unsupported', 'image-download-started',
  'image-download-succeeded', 'image-download-failed', 'group-event-shape', 'image-output-invalid', 'empty-message', 'queue-full',
  'event-queued', 'delivered-to-ui', 'provider-started', 'provider-ready', 'provider-failed',
  'send-started', 'send-succeeded', 'send-failed', 'media-send-started', 'media-send-succeeded',
  'media-send-failed', 'empty-reply', 'queue-timeout',
  'client-timeout', 'provider-timeout', 'takeover-cancelled', 'official-stopped', 'idle'
]);

const COUNTER_BY_STAGE = Object.freeze({
  'non-c2c-dropped': 'nonC2cDropped',
  'self-echo-dropped': 'selfEchoDropped',
  'open-id-denied': 'openIdDenied',
  'global-paused': 'globalPaused',
  'account-manual': 'accountManual',
  'group-no-mention': 'groupNoMention',
  'group-not-allowed': 'groupNotAllowed',
  'group-manual': 'groupManual',
  'group-paused': 'groupPaused',
  'worker-inactive': 'workerInactive',
  'event-queued': 'eventsQueued',
  'delivered-to-ui': 'eventsDeliveredToUi',
  'provider-started': 'providerStarted',
  'provider-ready': 'providerReady',
  'provider-failed': 'providerFailed',
  'image-download-failed': 'imageDownloadFailed',
  'send-started': 'sendStarted',
  'send-succeeded': 'sendSucceeded',
  'send-failed': 'sendFailed',
  'media-send-started': 'mediaSendStarted',
  'media-send-succeeded': 'mediaSendSucceeded',
  'media-send-failed': 'mediaSendFailed',
  'queue-timeout': 'queueTimeouts',
  'client-timeout': 'clientTimeouts',
  'provider-timeout': 'providerTimeouts'
});

const DIAGNOSTIC_TRANSITIONS = Object.freeze({
  'provider-started': new Set(['delivered-to-ui']),
  'provider-ready': new Set(['provider-started']),
  'provider-failed': new Set(['provider-started'])
});

const TRACE_STAGES = new Set([
  'websocket-connecting', 'websocket-connected', 'websocket-reconnecting', 'websocket-disconnected',
  'event-queued', 'delivered-to-ui', 'provider-started', 'provider-ready',
  'provider-failed', 'image-download-started', 'image-download-succeeded', 'image-download-failed', 'group-event-shape',
  'send-started', 'send-succeeded', 'send-failed', 'media-send-started', 'media-send-succeeded', 'media-send-failed'
]);

function imageError(code, safeMeta) {
  const error = Object.assign(new Error(code), { code: code });
  const httpStatus = Number(safeMeta && safeMeta.httpStatus);
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) error.httpStatus = httpStatus;
  return error;
}

function imageNetworkError(error, address) {
  const code = String(error && error.code || '');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return imageError('image-download-timeout');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return imageError('image-dns-failed');
  if (/^(?:ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code)) return imageError('image-tls-failed');
  if (code === 'ECONNREFUSED') return imageError('image-connection-refused');
  if (code === 'ECONNRESET') return imageError('image-connection-reset');
  if (code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE') return imageError('image-connection-closed');
  if (code === 'ERR_INVALID_IP_ADDRESS') return imageError('image-lookup-result-invalid');
  if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'EPROTONOSUPPORT') {
    return imageError('image-address-family-unavailable');
  }
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EHOSTDOWN') {
    return imageError(Number(address && address.family) === 6 ? 'image-ipv6-unreachable' : 'image-network-unreachable');
  }
  return imageError('image-network-failed');
}

function imageMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return IMAGE_MIME_TYPES.has(mime) ? mime : '';
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function isAllowedImageHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host)) return false;
  return IMAGE_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith('.' + suffix));
}

function isPublicIPv4(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIPv6(value) {
  const address = String(value || '').toLowerCase().split('%')[0];
  if (!address || net.isIP(address) !== 6) return false;
  if (address.startsWith('::ffff:')) return isPublicIPv4(address.slice(7));
  const first = parseInt(address.split(':')[0] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && !address.startsWith('2001:db8:');
}

async function lookupPublicImageAddress(hostname) {
  let records;
  try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch (_) { throw imageError('image-dns-failed'); }
  if (!records.length || records.some(record => !(record.family === 4
    ? isPublicIPv4(record.address) : isPublicIPv6(record.address)))) throw imageError('image-dns-rejected');
  return records[0];
}

function requestImageUrl(url, address) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const request = https.request({
      protocol: 'https:', hostname: url.hostname, servername: url.hostname, port: 443,
      method: 'GET', path: url.pathname + url.search,
      headers: { Accept: 'image/jpeg,image/png,image/webp' },
      lookup: (_hostname, lookupOptions, callback) => {
        /* Node's autoSelectFamily path calls custom lookup with all=true and
           requires an address array. Return only the already-vetted pinned IP. */
        if (lookupOptions && lookupOptions.all === true) {
          callback(null, [{ address: address.address, family: address.family }]);
          return;
        }
        callback(null, address.address, address.family);
      }
    }, response => {
      const status = Number(response.statusCode) || 0;
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.resume();
        finish(null, { redirected: true, redirect: location || '', httpStatus: status });
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(imageError('image-http-rejected', { httpStatus: status }));
        return;
      }
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        response.destroy();
        finish(imageError('image-too-large'));
        return;
      }
      const declaredMime = imageMime(response.headers['content-type']);
      const declaredType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!declaredMime && declaredType !== 'application/octet-stream') {
        response.resume();
        finish(imageError('image-type-unsupported'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_IMAGE_BYTES) {
          chunks.forEach(part => part.fill(0));
          chunks.length = 0;
          response.destroy();
          finish(imageError('image-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        const buffer = Buffer.concat(chunks, bytes);
        chunks.forEach(part => part.fill(0));
        chunks.length = 0;
        const detected = detectImageMime(buffer);
        if (!detected) {
          buffer.fill(0);
          finish(imageError('image-type-unsupported'));
          return;
        }
        if (declaredMime && declaredMime !== detected) {
          buffer.fill(0);
          finish(imageError('image-type-mismatch'));
          return;
        }
        finish(null, { buffer: buffer, mime: detected });
      });
      response.on('error', error => finish(imageNetworkError(error, address)));
    });
    timer = setTimeout(() => {
      finish(imageError('image-download-timeout'));
      request.destroy();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    request.on('error', error => finish(imageNetworkError(error, address)));
    request.end();
  });
}

async function downloadQQImage(attachment, depth) {
  depth = Number(depth) || 0;
  if (depth > 2) throw imageError('image-redirect-rejected');
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)
    || typeof attachment.content_type !== 'string' || !attachment.content_type.trim()
    || typeof attachment.url !== 'string' || !attachment.url.trim()) throw imageError('image-attachment-invalid');
  const declaredMime = imageMime(attachment && attachment.content_type);
  if (!declaredMime) throw imageError('image-type-unsupported');
  const rawUrl = String(attachment && attachment.url || '');
  let url;
  try { url = new URL(rawUrl); } catch (_) { throw imageError('image-source-domain-rejected'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw imageError('image-source-protocol-rejected');
  }
  if (!isAllowedImageHost(url.hostname)) throw imageError('image-source-domain-rejected');
  const address = await lookupPublicImageAddress(url.hostname);
  const result = await requestImageUrl(url, address);
  if (result.redirected) {
    if (!result.redirect) throw imageError('image-redirect-rejected', { httpStatus: result.httpStatus });
    let redirected;
    try { redirected = new URL(result.redirect, url); } catch (_) { throw imageError('image-redirect-rejected', { httpStatus: result.httpStatus }); }
    if (redirected.protocol !== 'https:' || redirected.username || redirected.password
      || (redirected.port && redirected.port !== '443') || !isAllowedImageHost(redirected.hostname)) {
      throw imageError('image-redirect-rejected', { httpStatus: result.httpStatus });
    }
    return downloadQQImage({ content_type: declaredMime, url: redirected.toString() }, depth + 1);
  }
  if (result.mime !== declaredMime) {
    if (Buffer.isBuffer(result.buffer)) result.buffer.fill(0);
    throw imageError('image-type-mismatch');
  }
  return result;
}

function decodeImagePayload(input, maxBytes) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (Object.keys(src).some(key => !['mime', 'base64'].includes(key))) throw imageError('image-output-invalid');
  const mime = imageMime(src.mime);
  const base64 = String(src.base64 || '');
  if (!mime || !base64 || base64.length > Math.ceil(maxBytes * 4 / 3) + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw imageError('image-output-invalid');
  }
  const buffer = Buffer.from(base64, 'base64');
  const detected = detectImageMime(buffer);
  if (buffer.length > maxBytes || detected !== mime) {
    const code = buffer.length > maxBytes ? 'image-too-large' : 'image-output-invalid';
    buffer.fill(0);
    throw imageError(code);
  }
  return { mime: mime, buffer: buffer };
}

function inboundAttachmentsForMessage(msg, isGroup, directValue) {
  const direct = Array.isArray(directValue) ? directValue : [];
  const hasReplyReference = !!String(msg && msg.refMsgIdx || '').trim()
    || Number(msg && msg.msgType) === 103;
  const elements = isGroup && Array.isArray(msg && msg.msgElements) ? msg.msgElements : [];
  const combined = direct.slice();
  let elementAttachmentCount = 0;
  const seen = new Set();
  for (const attachment of direct) {
    if (!attachment || typeof attachment !== 'object') continue;
    const type = typeof attachment.content_type === 'string' ? attachment.content_type : '';
    const url = typeof attachment.url === 'string' ? attachment.url : '';
    if (type && url) seen.add(type + '\0' + url);
  }
  for (const element of elements) {
    const quoted = element && Array.isArray(element.attachments) ? element.attachments : [];
    elementAttachmentCount += quoted.length;
    if (!isGroup || !hasReplyReference) continue;
    for (const attachment of quoted) {
      if (!attachment || typeof attachment !== 'object') {
        combined.push(attachment);
        continue;
      }
      const type = typeof attachment.content_type === 'string' ? attachment.content_type : '';
      const url = typeof attachment.url === 'string' ? attachment.url : '';
      const key = type && url ? type + '\0' + url : '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      combined.push(attachment);
    }
  }
  return {
    attachments: combined,
    directAttachmentCount: direct.length,
    elementCount: elements.length,
    elementAttachmentCount,
    selectedAttachmentCount: combined.length,
    quoteReference: hasReplyReference
  };
}

function cleanErrorCode(value, fallback) {
  const code = String(value || '');
  return ERROR_CODES.has(code) ? code : (fallback || 'official-start-failed');
}

function accountIdFor(appId) {
  return 'qqofficial_' + String(appId || '').trim();
}

function credentialRefFor(appId) {
  return 'qqofficial:' + String(appId || '').trim();
}

function normalizeOpenIds(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values.slice(0, MAX_OPENIDS) : []) {
    const id = String(value == null ? '' : value).trim();
    if (OPEN_ID_RE.test(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function normalizeSessionId(value) {
  const id = String(value == null ? '' : value).trim();
  return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : DEFAULT_SESSION_ID;
}

function normalizeGroupAdminOpenIds(values) {
  if (values == null) return { ok: true, openIds: [] };
  if (!Array.isArray(values) || values.length > MAX_OPENIDS) return { ok: false, error: 'invalid-group-admin-list' };
  const seen = new Set();
  const openIds = [];
  for (const value of values) {
    const id = String(value == null ? '' : value).trim();
    if (!OPEN_ID_RE.test(id)) return { ok: false, error: 'invalid-group-admin-openid' };
    if (seen.has(id)) return { ok: false, error: 'duplicate-group-admin-openid' };
    seen.add(id);
    openIds.push(id);
  }
  return { ok: true, openIds };
}

function normalizeGroupBindings(values) {
  if (values == null) return { ok: true, groups: [] };
  if (!Array.isArray(values) || values.length > MAX_GROUP_BINDINGS) return { ok: false, error: 'invalid-group-list' };
  const seen = new Set();
  const groups = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['groupOpenId', 'roleId', 'takeover', 'adminMemberOpenIds', 'sessionId'].includes(key))) {
      return { ok: false, error: 'invalid-group-binding' };
    }
    const groupOpenId = String(value.groupOpenId == null ? '' : value.groupOpenId).trim();
    if (!OPEN_ID_RE.test(groupOpenId)) return { ok: false, error: 'invalid-group-openid' };
    if (seen.has(groupOpenId)) return { ok: false, error: 'duplicate-group-openid' };
    seen.add(groupOpenId);
    const roleId = String(value.roleId == null ? '' : value.roleId).trim().slice(0, 160);
    const takeover = value.takeover === true;
    if (takeover && !roleId) return { ok: false, error: 'group-role-required' };
    const admins = normalizeGroupAdminOpenIds(value.adminMemberOpenIds);
    if (!admins.ok) return admins;
    const sessionId = value.sessionId == null ? DEFAULT_SESSION_ID : String(value.sessionId).trim();
    if (sessionId !== DEFAULT_SESSION_ID && !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) {
      return { ok: false, error: 'invalid-session-id' };
    }
    groups.push({ groupOpenId, roleId, takeover, adminMemberOpenIds: admins.openIds, sessionId: sessionId || DEFAULT_SESSION_ID });
  }
  return { ok: true, groups };
}

function normalizePrivateRoleSelections(values, allowedUserOpenIds) {
  if (values == null) return { ok: true, selections: [] };
  if (!Array.isArray(values) || values.length > MAX_OPENIDS) return { ok: false, error: 'invalid-private-role-selection-list' };
  const allowed = new Set(allowedUserOpenIds);
  const seen = new Set();
  const selections = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['userOpenId', 'roleId', 'sessionId'].includes(key))) {
      return { ok: false, error: 'invalid-private-role-selection' };
    }
    const userOpenId = String(value.userOpenId == null ? '' : value.userOpenId).trim();
    const roleId = String(value.roleId == null ? '' : value.roleId).trim().slice(0, 160);
    const sessionId = value.sessionId == null ? DEFAULT_SESSION_ID : String(value.sessionId).trim();
    if (!OPEN_ID_RE.test(userOpenId) || !allowed.has(userOpenId) || !roleId) {
      return { ok: false, error: 'invalid-private-role-selection' };
    }
    if (seen.has(userOpenId)) return { ok: false, error: 'duplicate-private-role-selection' };
    if (sessionId !== DEFAULT_SESSION_ID && !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) {
      return { ok: false, error: 'invalid-session-id' };
    }
    seen.add(userOpenId);
    selections.push({ userOpenId, roleId, sessionId: sessionId || DEFAULT_SESSION_ID });
  }
  return { ok: true, selections };
}

function normalizeAccount(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const appId = String(src.appId == null ? '' : src.appId).trim();
  if (!APP_ID_RE.test(appId)) return { ok: false, error: 'invalid-app-id' };
  const roleId = String(src.roleId == null ? '' : src.roleId).trim().slice(0, 160);
  const takeover = src.takeover === true;
  if (takeover && !roleId) return { ok: false, error: 'role-required' };
  const allowedUserOpenIds = normalizeOpenIds(src.allowedUserOpenIds);
  const privateRoleSelections = normalizePrivateRoleSelections(src.privateRoleSelections, allowedUserOpenIds);
  if (!privateRoleSelections.ok) return privateRoleSelections;
  const groupBindings = normalizeGroupBindings(src.groups);
  if (!groupBindings.ok) return groupBindings;
  return {
    ok: true,
    account: {
      appId,
      accountId: accountIdFor(appId),
      credentialRef: credentialRefFor(appId),
      roleId,
      takeover,
      combinedIntentConsent: src.combinedIntentConsent === true,
      allowedUserOpenIds,
      privateRoleSelections: privateRoleSelections.selections,
      groups: groupBindings.groups
    }
  };
}

function safeCodeFromError(error, fallback) {
  const closeCode = Number(error && (error.closeCode || (error.cause && error.cause.closeCode))) || 0;
  if (closeCode === 4914 || closeCode === 4915) return 'official-intent-not-accepted';
  const status = Number(error && (error.httpStatus || error.status)) || 0;
  if (status === 401) return 'official-invalid-credentials';
  if (status === 403) return 'official-app-not-authorized';
  if (error && error.httpStatus != null && status === 0) return 'official-network-error';
  if (error && error.code === 'CREDENTIAL_UNAVAILABLE') return 'credential-vault-unavailable';
  if (error && error.code === 'ERR_MODULE_NOT_FOUND') return 'official-sdk-unavailable';
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'
    || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND')) return 'official-network-error';
  return fallback || 'official-start-failed';
}

async function createSDKBot(input) {
  let sdk;
  try { sdk = await import('@tencent-connect/qqbot-nodejs'); }
  catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw Object.assign(new Error('official-sdk-unavailable'), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    throw error;
  }
  if (!sdk || typeof sdk.QQBot !== 'function') {
    throw Object.assign(new Error('official-sdk-unavailable'), { code: 'ERR_MODULE_NOT_FOUND' });
  }
  const logger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
  const bot = new sdk.QQBot({
    appId: input.appId,
    appSecret: input.appSecret,
    accountId: accountIdFor(input.appId),
    transport: 'websocket',
    tokenPrefetch: 'sync',
    markdownSupport: false,
    intents: C2C_AND_GROUP_INTENT_V105,
    logger
  });
  return bot;
}

function createQQOfficialManager(options) {
  options = options || {};
  const resolver = options.credentialResolver || createCredentialResolver({
    dataDir: String(options.dataDir || '').trim()
  });
  const createBot = typeof options.createBot === 'function' ? options.createBot : createSDKBot;
  const downloadImage = typeof options.downloadImage === 'function' ? options.downloadImage : downloadQQImage;
  const logger = typeof options.logger === 'function' ? options.logger : function () {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomId = typeof options.randomId === 'function'
    ? options.randomId : () => crypto.randomBytes(16).toString('hex');
  const accounts = new Map();
  const statusByAppId = new Map();
  const pendingOpenIdsByAppId = new Map();
  const pendingGroupOpenIdsByAppId = new Map();
  const pendingGroupAdminOpenIdsByAppId = new Map();
  const sessions = new Map();
  const pending = new Map();
  const queue = [];
  const seen = new Map();
  const sentGroupMessageIds = new Map();
  let activeImageDownloads = 0;
  let paused = true;
  let closed = false;
  let lastClientAt = 0;

  function statusFor(appId) {
    if (!statusByAppId.has(appId)) statusByAppId.set(appId, {
      state: 'stopped', lastEventAt: 0, lastError: '', lastCloseCode: null,
      lastReplyAt: 0, lastStage: 'idle', lastStageAt: 0,
      lastApiHttpStatus: null, lastApiBusinessCode: null, lastImageHttpStatus: null,
      diagnostics: {
        nonC2cDropped: 0, selfEchoDropped: 0, openIdDenied: 0,
        globalPaused: 0, accountManual: 0, workerInactive: 0,
        groupNoMention: 0, groupNotAllowed: 0, groupManual: 0, groupPaused: 0,
        imageDownloadFailed: 0,
        eventsQueued: 0, eventsDeliveredToUi: 0,
        providerStarted: 0, providerReady: 0, providerFailed: 0,
        sendStarted: 0, sendSucceeded: 0, sendFailed: 0,
        mediaSendStarted: 0, mediaSendSucceeded: 0, mediaSendFailed: 0,
        queueTimeouts: 0, clientTimeouts: 0, providerTimeouts: 0
      }
    });
    return statusByAppId.get(appId);
  }

  function recordStage(appId, stage, errorCode, safeMeta) {
    if (!DIAGNOSTIC_STAGES.has(stage)) return;
    const current = statusFor(appId);
    current.lastStage = stage;
    current.lastStageAt = Number(clock()) || Date.now();
    const counter = COUNTER_BY_STAGE[stage];
    if (counter) current.diagnostics[counter] = Math.min(1000000, (current.diagnostics[counter] || 0) + 1);
    if (stage === 'image-download-started') current.lastImageHttpStatus = null;
    if (stage === 'image-download-failed') {
      const imageHttpStatus = Number(safeMeta && safeMeta.httpStatus);
      current.lastImageHttpStatus = Number.isInteger(imageHttpStatus) && imageHttpStatus >= 100 && imageHttpStatus <= 599
        ? imageHttpStatus : null;
    }
    if (errorCode) current.lastError = cleanErrorCode(errorCode, 'official-start-failed');
    else if (stage === 'event-queued' || stage === 'provider-ready' || stage === 'send-succeeded'
      || stage === 'media-send-succeeded'
      || stage === 'image-download-succeeded'
      || stage === 'websocket-connected' || stage === 'group-no-mention' || stage === 'group-manual'
      || stage === 'non-c2c-dropped' || stage === 'self-echo-dropped') current.lastError = '';
    if (stage === 'event-queued' || stage === 'send-succeeded' || stage === 'media-send-succeeded') {
      current.lastApiHttpStatus = null;
      current.lastApiBusinessCode = null;
    }

    const failed = !!(errorCode && errorCode !== 'message-not-allowed' && errorCode !== 'takeover-paused')
      || stage === 'queue-timeout' || stage === 'client-timeout' || stage === 'provider-timeout';
    if (failed || TRACE_STAGES.has(stage)) {
      const accountRef = crypto.createHash('sha256').update(String(appId)).digest('hex').slice(0, 12);
      const fields = {
        accountRef,
        stage
      };
      const code = current.lastError || (errorCode ? cleanErrorCode(errorCode, 'official-start-failed') : '');
      if (code) fields.code = code;
      else if (failed) fields.code = 'request-timeout';
      const httpStatus = safeMeta && safeMeta.httpStatus != null ? Number(safeMeta.httpStatus) : NaN;
      const businessCode = safeMeta && safeMeta.businessCode != null ? Number(safeMeta.businessCode) : NaN;
      if (Number.isInteger(httpStatus) && httpStatus >= 0 && httpStatus <= 599) fields.httpStatus = httpStatus;
      if (Number.isSafeInteger(businessCode)) fields.businessCode = businessCode;
      const configuredGroupCount = safeMeta && safeMeta.configuredGroupCount != null
        ? Number(safeMeta.configuredGroupCount) : NaN;
      const pendingGroupCount = safeMeta && safeMeta.pendingGroupCount != null
        ? Number(safeMeta.pendingGroupCount) : NaN;
      const groupAdminCount = safeMeta && safeMeta.groupAdminCount != null
        ? Number(safeMeta.groupAdminCount) : NaN;
      if (Number.isInteger(configuredGroupCount) && configuredGroupCount >= 0 && configuredGroupCount <= MAX_GROUP_BINDINGS) {
        fields.configuredGroupCount = configuredGroupCount;
      }
      if (Number.isInteger(pendingGroupCount) && pendingGroupCount >= 0 && pendingGroupCount <= MAX_GROUP_BINDINGS) {
        fields.pendingGroupCount = pendingGroupCount;
      }
      if (Number.isInteger(groupAdminCount) && groupAdminCount >= 0 && groupAdminCount <= MAX_OPENIDS) {
        fields.groupAdminCount = groupAdminCount;
      }
      if (safeMeta && typeof safeMeta.groupAdminMatch === 'boolean') {
        fields.groupAdminMatch = safeMeta.groupAdminMatch;
      }
      for (const key of ['directAttachmentCount', 'elementCount', 'elementAttachmentCount', 'selectedAttachmentCount']) {
        const value = Number(safeMeta && safeMeta[key]);
        if (Number.isInteger(value) && value >= 0 && value <= 1000) fields[key] = value;
      }
      const messageType = Number(safeMeta && safeMeta.messageType);
      if (Number.isInteger(messageType) && messageType >= 0 && messageType <= 255) fields.messageType = messageType;
      if (safeMeta && safeMeta.quoteReference === true) fields.quoteReference = true;
      try {
        logger(failed ? 'warn' : 'info', 'qq-official-stage', fields);
      } catch (_) { /* diagnostics never affect message handling */ }
    }
  }

  function pendingOpenIds(appId) {
    if (!pendingOpenIdsByAppId.has(appId)) pendingOpenIdsByAppId.set(appId, new Set());
    return pendingOpenIdsByAppId.get(appId);
  }

  function capturePendingOpenId(appId, senderId) {
    const id = String(senderId == null ? '' : senderId).trim();
    if (!OPEN_ID_RE.test(id)) return;
    const candidates = pendingOpenIds(appId);
    if (candidates.size < MAX_OPENIDS) candidates.add(id);
  }

  function pendingGroupOpenIds(appId) {
    if (!pendingGroupOpenIdsByAppId.has(appId)) pendingGroupOpenIdsByAppId.set(appId, new Set());
    return pendingGroupOpenIdsByAppId.get(appId);
  }

  function capturePendingGroupOpenId(appId, groupOpenId) {
    const id = String(groupOpenId == null ? '' : groupOpenId).trim();
    if (!OPEN_ID_RE.test(id)) return;
    const candidates = pendingGroupOpenIds(appId);
    if (candidates.size < MAX_GROUP_BINDINGS) candidates.add(id);
  }

  function pendingGroupAdminOpenIds(appId, groupOpenId) {
    if (!pendingGroupAdminOpenIdsByAppId.has(appId)) pendingGroupAdminOpenIdsByAppId.set(appId, new Map());
    const byGroup = pendingGroupAdminOpenIdsByAppId.get(appId);
    if (!byGroup.has(groupOpenId)) byGroup.set(groupOpenId, new Set());
    return byGroup.get(groupOpenId);
  }

  function capturePendingGroupAdminOpenId(appId, groupOpenId, memberOpenId) {
    const id = String(memberOpenId == null ? '' : memberOpenId).trim();
    if (!OPEN_ID_RE.test(id)) return;
    const admins = groupBindingFor(accounts.get(appId), groupOpenId);
    if (admins && admins.adminMemberOpenIds.includes(id)) return;
    const candidates = pendingGroupAdminOpenIds(appId, groupOpenId);
    if (candidates.size < MAX_OPENIDS) candidates.add(id);
  }

  async function loadInboundImages(appId, attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return { ok: true, images: [] };
    if (attachments.length > MAX_IMAGE_COUNT) return { ok: false, error: 'image-too-large' };
    const images = [];
    let totalBytes = 0;
    recordStage(appId, 'image-download-started');
    try {
      for (const attachment of attachments) {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)
          || typeof attachment.content_type !== 'string' || !attachment.content_type.trim()
          || typeof attachment.url !== 'string'
          || !attachment.url.trim()) throw imageError('image-attachment-invalid');
        const expectedMime = imageMime(attachment && attachment.content_type);
        if (!expectedMime) throw imageError('attachments-unsupported');
        const declaredSize = Number(attachment && attachment.size);
        if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) throw imageError('image-too-large');
        const downloaded = await downloadImage(attachment);
        const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded && downloaded.buffer;
        const actualMime = detectImageMime(buffer);
        if (!Buffer.isBuffer(buffer) || buffer.length > MAX_IMAGE_BYTES || !actualMime || actualMime !== expectedMime) {
          if (Buffer.isBuffer(buffer)) buffer.fill(0);
          throw imageError(Buffer.isBuffer(buffer) && buffer.length > MAX_IMAGE_BYTES ? 'image-too-large'
            : actualMime && actualMime !== expectedMime ? 'image-type-mismatch' : 'image-type-unsupported');
        }
        totalBytes += buffer.length;
        if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
          buffer.fill(0);
          throw imageError('image-too-large');
        }
        const extension = actualMime === 'image/jpeg' ? 'jpg' : actualMime.slice('image/'.length);
        images.push({ mime: actualMime, base64: buffer.toString('base64'), name: 'qq-image-' + images.length + '.' + extension });
        buffer.fill(0);
      }
      recordStage(appId, 'image-download-succeeded');
      return { ok: true, images: images };
    } catch (error) {
      images.forEach(image => { image.base64 = ''; });
      const code = error && ['image-source-rejected', 'image-source-domain-rejected',
        'image-source-protocol-rejected', 'image-redirect-rejected', 'image-dns-failed',
        'image-dns-rejected', 'image-download-failed', 'image-download-timeout', 'image-http-rejected',
        'image-network-failed', 'image-network-unreachable', 'image-ipv6-unreachable',
        'image-connection-refused', 'image-connection-reset', 'image-connection-closed',
        'image-address-family-unavailable', 'image-lookup-result-invalid', 'image-tls-failed',
        'image-attachment-invalid', 'image-type-mismatch',
        'image-too-large', 'image-type-unsupported', 'attachments-unsupported'].includes(error.code)
        ? error.code : 'image-download-failed';
      const httpStatus = Number(error && error.httpStatus);
      recordStage(appId, 'image-download-failed', code, {
        httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : undefined
      });
      return { ok: false, error: code };
    }
  }

  function touchClient() {
    if (!closed) lastClientAt = Number(clock()) || Date.now();
  }

  function workerActive() {
    const now = Number(clock()) || Date.now();
    return !closed && lastClientAt > 0 && now - lastClientAt <= CLIENT_LEASE_MS;
  }

  function isEnabled(account) {
    return !closed && !paused && workerActive() && !!account
      && account.takeover === true && !!account.roleId
      && account.allowedUserOpenIds.length > 0;
  }

  function groupBindingFor(account, groupOpenId) {
    const id = String(groupOpenId == null ? '' : groupOpenId).trim();
    if (!account || !id) return null;
    return account.groups.find(group => group.groupOpenId === id) || null;
  }

  function privateRoleSelectionFor(account, userOpenId) {
    const id = String(userOpenId == null ? '' : userOpenId).trim();
    if (!account || !id) return null;
    return account.privateRoleSelections.find(row => row.userOpenId === id) || null;
  }

  function roleSessionFor(account, messageType, peerId) {
    if (messageType === 'group') {
      const binding = groupBindingFor(account, peerId);
      return binding ? { roleId: binding.roleId, sessionId: binding.sessionId } : null;
    }
    const selection = privateRoleSelectionFor(account, peerId);
    return selection
      ? { roleId: selection.roleId, sessionId: selection.sessionId }
      : { roleId: account && account.roleId || '', sessionId: DEFAULT_SESSION_ID };
  }

  function accountCoreSignature(account) {
    return JSON.stringify(Object.assign({}, account, { roleId: '', groups: [], privateRoleSelections: [] }));
  }

  function eventRoleSessionSignature(account, event) {
    if (!account || !event) return '';
    const peerId = event.messageType === 'group'
      ? String(event.groupOpenId || event.peerId || '') : String(event.senderId || '');
    if (event.messageType === 'group') {
      const group = groupBindingFor(account, peerId);
      return JSON.stringify(group ? {
        roleId: group.roleId, sessionId: group.sessionId, takeover: group.takeover,
        adminMemberOpenIds: group.adminMemberOpenIds
      } : null);
    }
    return JSON.stringify(roleSessionFor(account, event.messageType, peerId));
  }

  function isGroupMentioned(msg) {
    if (!msg || msg.kind !== 'group') return false;
    if (String(msg.rawEventType || '') === 'GROUP_AT_MESSAGE_CREATE') return true;
    return Array.isArray(msg.mentions) && msg.mentions.some(mention => mention && mention.is_you === true);
  }

  function isEventEnabled(account, event) {
    if (closed || paused || !workerActive() || !account || !event) return false;
    if (event.messageType === 'group') {
      const groupOpenId = String(event.groupOpenId || event.peerId || '').trim();
      const binding = groupBindingFor(account, groupOpenId);
      const current = binding && roleSessionFor(account, 'group', groupOpenId);
      return !!binding && binding.takeover === true && !!binding.roleId
        && current.roleId === String(event.roleId || '')
        && current.sessionId === normalizeSessionId(event.sessionId)
        && String(event.senderId || '').trim() !== ''
        && (event.canManageConversation !== true || binding.adminMemberOpenIds.includes(String(event.senderId || '')));
    }
    const current = roleSessionFor(account, 'private', String(event.senderId || ''));
    return account.takeover === true && !!account.roleId
      && account.allowedUserOpenIds.includes(String(event.senderId || ''))
      && current.roleId === String(event.roleId || '')
      && current.sessionId === normalizeSessionId(event.sessionId);
  }

  function authorizeInboundMessage(appId, msg) {
    const account = accounts.get(appId);
    if (!msg || (msg.kind !== 'c2c' && msg.kind !== 'group')) {
      recordStage(appId, 'non-c2c-dropped');
      return null;
    }
    if (msg.senderIsBot === true) {
      recordStage(appId, 'self-echo-dropped');
      return null;
    }
    if (!account) return null;

    if (msg.kind === 'group') {
      if (!isGroupMentioned(msg)) {
        recordStage(appId, 'group-no-mention');
        return null;
      }
      const groupOpenId = String(msg.groupOpenid || msg.groupOpenId || '').trim();
      if (!OPEN_ID_RE.test(groupOpenId)) {
        recordStage(appId, 'invalid-reply-target', 'invalid-event');
        return null;
      }
      const binding = groupBindingFor(account, groupOpenId);
      if (!binding) {
        capturePendingGroupOpenId(appId, groupOpenId);
        recordStage(appId, 'group-not-allowed', 'group-not-allowed', {
          configuredGroupCount: account.groups.length,
          pendingGroupCount: pendingGroupOpenIds(appId).size
        });
        return null;
      }
      if (paused) {
        recordStage(appId, 'group-paused', 'takeover-paused');
        return null;
      }
      if (!binding.takeover || !binding.roleId) {
        recordStage(appId, 'group-manual');
        return null;
      }
      if (!workerActive()) {
        recordStage(appId, 'worker-inactive', 'takeover-paused');
        return null;
      }
      const messageId = String(msg.messageId == null ? '' : msg.messageId).trim();
      if (messageId && isRecentGroupSelfEcho(appId, groupOpenId, messageId)) {
        recordStage(appId, 'self-echo-dropped');
        return null;
      }
      const senderId = String(msg.senderId == null ? '' : msg.senderId).trim();
      if (!senderId) {
        recordStage(appId, 'invalid-reply-target', 'invalid-event');
        return null;
      }
      capturePendingGroupAdminOpenId(appId, groupOpenId, senderId);
      return { kind: 'group', groupOpenId, senderId, binding };
    }

    const senderId = String(msg.senderId == null ? '' : msg.senderId).trim();
    if (!senderId) return null;
    if (!account.allowedUserOpenIds.includes(senderId)) {
      capturePendingOpenId(appId, senderId);
      recordStage(appId, 'open-id-denied', 'message-not-allowed');
      return null;
    }
    if (!isEnabled(account)) {
      const disabledStage = paused ? 'global-paused'
        : !account.takeover || !account.roleId || account.allowedUserOpenIds.length === 0 ? 'account-manual'
          : !workerActive() ? 'worker-inactive' : 'global-paused';
      recordStage(appId, disabledStage, disabledStage === 'account-manual' ? '' : 'takeover-paused');
      return null;
    }
    return { kind: 'c2c', groupOpenId: '', senderId, binding: null };
  }

  function resolveCredential(account) {
    if (!account || !accounts.has(account.appId)) return { ok: false, error: 'account-not-configured' };
    let credential = null;
    try { credential = resolver.resolve(account.credentialRef); } catch (_) { credential = null; }
    if (!credential || typeof credential.apiKey !== 'string' || !credential.apiKey.trim()) {
      return { ok: false, error: 'credential-vault-unavailable' };
    }
    if (String(credential.provider || '').trim().toLowerCase() !== 'qqbot') {
      return { ok: false, error: 'credential-vault-provider-mismatch' };
    }
    return { ok: true, secret: credential.apiKey };
  }

  function resolveRequest(requestId) {
    const item = pending.get(requestId);
    if (!item) return false;
    pending.delete(requestId);
    clearTimeout(item.timer);
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].requestId === requestId) queue.splice(index, 1);
    }
    if (item.event && Array.isArray(item.event.images)) {
      item.event.images.forEach(image => { if (image && typeof image === 'object') image.base64 = ''; });
      item.event.images.length = 0;
    }
    item.resolve();
    return true;
  }

  function cancelPending(appId, stage, errorCode) {
    for (const [requestId, item] of pending) {
      if (!appId || item.event.appId === appId) {
        recordStage(item.event.appId, stage || 'takeover-cancelled', errorCode || '');
        resolveRequest(requestId);
      }
    }
    for (let index = queue.length - 1; index >= 0; index--) {
      if (!appId || queue[index].appId === appId) queue.splice(index, 1);
    }
  }

  function cancelPendingForAccountChange(appId, oldAccount, updated) {
    const cancelAll = accountCoreSignature(oldAccount) !== accountCoreSignature(updated);
    for (const [requestId, item] of pending) {
      if (item.event.appId !== appId) continue;
      if (cancelAll || eventRoleSessionSignature(oldAccount, item.event) !== eventRoleSessionSignature(updated, item.event)) {
        recordStage(appId, 'takeover-cancelled', 'takeover-paused');
        resolveRequest(requestId);
      }
    }
  }

  function remember(appId, scope, peerId, messageId) {
    const now = Number(clock()) || Date.now();
    const key = appId + ':' + scope + ':' + peerId + ':' + messageId;
    const prior = seen.get(key);
    if (prior && now - prior < 10 * 60 * 1000) return false;
    seen.set(key, now);
    if (seen.size > MAX_SEEN) {
      for (const [id, at] of seen) {
        if (now - at > 10 * 60 * 1000 || seen.size > MAX_SEEN) seen.delete(id);
        if (seen.size <= MAX_SEEN) break;
      }
    }
    return true;
  }

  function groupMessageKey(appId, groupOpenId, messageId) {
    return String(appId) + ':group:' + String(groupOpenId) + ':' + String(messageId);
  }

  function isRecentGroupSelfEcho(appId, groupOpenId, messageId) {
    const key = groupMessageKey(appId, groupOpenId, messageId);
    const at = sentGroupMessageIds.get(key);
    const now = Number(clock()) || Date.now();
    if (!at) return false;
    if (now - at >= 10 * 60 * 1000) {
      sentGroupMessageIds.delete(key);
      return false;
    }
    return true;
  }

  function rememberSentGroupMessage(appId, target, messageId) {
    const id = String(messageId || '').trim();
    if (!target || target.scope !== 'group' || !target.targetId || !id) return;
    const now = Number(clock()) || Date.now();
    sentGroupMessageIds.set(groupMessageKey(appId, target.targetId, id), now);
    if (sentGroupMessageIds.size > MAX_SENT_GROUP_ECHOES) {
      for (const [key, at] of sentGroupMessageIds) {
        if (now - at >= 10 * 60 * 1000 || sentGroupMessageIds.size > MAX_SENT_GROUP_ECHOES) sentGroupMessageIds.delete(key);
        if (sentGroupMessageIds.size <= MAX_SENT_GROUP_ECHOES) break;
      }
    }
  }

  function configure(input) {
    if (closed) return Promise.resolve({ ok: false, error: 'qq-official-closed' });
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (!Array.isArray(src.accounts) || src.accounts.length > MAX_ACCOUNTS) {
      return Promise.resolve({ ok: false, error: 'invalid-account-list' });
    }
    const next = new Map();
    for (const raw of src.accounts) {
      const normalized = normalizeAccount(raw);
      if (!normalized.ok) return Promise.resolve(normalized);
      const account = normalized.account;
      if (next.has(account.appId)) return Promise.resolve({ ok: false, error: 'duplicate-app-id' });
      next.set(account.appId, account);
    }
    const nextPaused = src.paused !== false;
    const pendingStops = [];
    const removedAppIds = [];
    for (const [appId, oldAccount] of accounts) {
      const updated = next.get(appId);
      if (!updated) {
        removedAppIds.push(appId);
        pendingOpenIdsByAppId.delete(appId);
        pendingGroupOpenIdsByAppId.delete(appId);
        pendingGroupAdminOpenIdsByAppId.delete(appId);
        pendingStops.push(stopAccount(appId));
      }
      else if (JSON.stringify(oldAccount) !== JSON.stringify(updated)) {
        cancelPendingForAccountChange(appId, oldAccount, updated);
      }
      if (updated) {
        const pendingIds = pendingOpenIds(appId);
        for (const openId of pendingIds) {
          if (updated.allowedUserOpenIds.includes(openId)) pendingIds.delete(openId);
        }
        const pendingGroups = pendingGroupOpenIds(appId);
        for (const groupOpenId of pendingGroups) {
          if (groupBindingFor(updated, groupOpenId)) pendingGroups.delete(groupOpenId);
        }
        const pendingAdmins = pendingGroupAdminOpenIdsByAppId.get(appId);
        if (pendingAdmins) {
          for (const [groupOpenId, memberIds] of pendingAdmins) {
            const binding = groupBindingFor(updated, groupOpenId);
            if (!binding) { pendingAdmins.delete(groupOpenId); continue; }
            for (const memberOpenId of memberIds) {
              if (binding.adminMemberOpenIds.includes(memberOpenId)) memberIds.delete(memberOpenId);
            }
            if (!memberIds.size) pendingAdmins.delete(groupOpenId);
          }
        }
      }
    }
    if (!paused && nextPaused) cancelPending('', 'takeover-cancelled', 'takeover-paused');
    accounts.clear();
    for (const [appId, account] of next) accounts.set(appId, account);
    paused = nextPaused;
    touchClient();
    return Promise.all(pendingStops).then(() => {
      removedAppIds.forEach(appId => statusByAppId.delete(appId));
      return { ok: true, paused, accounts: status().accounts };
    });
  }

  function recordConnectionError(appId, error, fallback) {
    const current = statusFor(appId);
    current.state = 'failed';
    current.lastError = safeCodeFromError(error) || fallback || 'official-start-failed';
    current.lastCloseCode = Number(error && (error.closeCode || (error.cause && error.cause.closeCode))) || null;
    try { logger('warn', 'qq-official-connection-failed', { accountId: accountIdFor(appId), code: current.lastError, closeCode: current.lastCloseCode }); }
    catch (_) { /* diagnostics never affect connection state */ }
  }

  async function enqueueMessage(appId, generation, msg) {
    const runtime = sessions.get(appId);
    if (!runtime || runtime.generation !== generation || runtime.stopping) return;
    const account = accounts.get(appId);
    if (!account) return;
    const authorization = authorizeInboundMessage(appId, msg);
    if (!authorization) return;
    const isGroup = authorization.kind === 'group';
    const senderId = authorization.senderId;
    const peerId = isGroup ? authorization.groupOpenId : senderId;
    const roleSession = roleSessionFor(account, isGroup ? 'group' : 'private', peerId);
    const roleId = roleSession && roleSession.roleId || '';
    const sessionId = roleSession && roleSession.sessionId || DEFAULT_SESSION_ID;

    const messageId = String(msg.messageId == null ? '' : msg.messageId).trim();
    const target = msg.replyTarget && typeof msg.replyTarget === 'object' ? msg.replyTarget : null;
    const expectedScope = isGroup ? 'group' : 'c2c';
    if (!messageId || !target || target.scope !== expectedScope
      || String(target.targetId || '') !== peerId || String(target.msgId || '') !== messageId) {
      recordStage(appId, 'invalid-reply-target', 'invalid-event');
      return;
    }
    if (!remember(appId, isGroup ? 'group' : 'c2c', peerId, messageId)) return;
    const directAttachments = msg.attachments;
    if (directAttachments != null && !Array.isArray(directAttachments)) {
      recordStage(appId, 'attachments-unsupported', 'attachments-unsupported');
      return;
    }
    const attachmentInfo = inboundAttachmentsForMessage(msg, isGroup, directAttachments);
    const attachments = attachmentInfo.attachments;
    if (isGroup) {
      recordStage(appId, 'group-event-shape', '', {
        directAttachmentCount: attachmentInfo.directAttachmentCount,
        elementCount: attachmentInfo.elementCount,
        elementAttachmentCount: attachmentInfo.elementAttachmentCount,
        selectedAttachmentCount: attachmentInfo.selectedAttachmentCount,
        groupAdminCount: authorization.binding.adminMemberOpenIds.length,
        groupAdminMatch: authorization.binding.adminMemberOpenIds.includes(String(msg.senderId || '').trim()),
        quoteReference: attachmentInfo.quoteReference,
        messageType: msg.msgType
      });
    }
    let images = [];
    const text = String(msg.content == null ? '' : msg.content)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text && !attachments.length) {
      recordStage(appId, 'empty-message');
      return;
    }
    if (pending.size >= MAX_PENDING || queue.length >= MAX_PENDING
      || (attachments.length && activeImageDownloads >= MAX_CONCURRENT_IMAGE_DOWNLOADS)) {
      recordStage(appId, 'queue-full', 'queue-full');
      return;
    }
    if (attachments.length) {
      activeImageDownloads++;
      try {
        const loaded = await loadInboundImages(appId, attachments);
        if (!loaded.ok) return;
        images = loaded.images;
      } finally { activeImageDownloads = Math.max(0, activeImageDownloads - 1); }
    }
    if (!text && !images.length) {
      recordStage(appId, 'empty-message');
      return;
    }

    const receivedAt = Date.parse(String(msg.timestamp || '')) || Number(clock()) || Date.now();
    const id = String(randomId()).slice(0, 80);
    const accountId = accountIdFor(appId);
    const groupHash = isGroup
      ? crypto.createHash('sha256').update(appId + '\0' + authorization.groupOpenId).digest('hex').slice(0, 16)
      : '';
    const senderRef = isGroup
      ? 'member-' + crypto.createHash('sha256')
        .update(appId + '\0' + authorization.groupOpenId + '\0' + senderId).digest('hex').slice(0, 12)
      : '';
    const friendId = isGroup
      ? 'qqofficial_' + appId + '_group_' + groupHash
      : 'qqofficial_' + appId + '_' + senderId;
    const baseConversationId = isGroup
      ? 'qq-official:' + appId + ':group:' + groupHash
      : 'qq-official:' + appId + ':c2c:' + senderId;
    const event = {
      requestId: id,
      platform: 'qq-official',
      appId,
      accountId,
      roleId,
      messageId,
      messageType: isGroup ? 'group' : 'private',
      senderId,
      senderName: isGroup ? String(msg.senderName || '').trim().slice(0, 120) : '',
      senderRef,
      peerId,
      groupOpenId: isGroup ? authorization.groupOpenId : '',
      sessionId,
      canManageConversation: isGroup
        ? authorization.binding.adminMemberOpenIds.includes(senderId)
        : account.allowedUserOpenIds.includes(senderId),
      friendId,
      conversationId: sessionId === DEFAULT_SESSION_ID ? baseConversationId : baseConversationId + ':session:' + sessionId,
      text: text || '请查看用户发送的图片并回答。',
      receivedAt
    };
    if (images.length) event.images = images;
    const current = statusFor(appId);
    current.lastEventAt = Number(clock()) || Date.now();
    const item = { event, target, runtime, generation, timer: null, diagnosticStage: 'event-queued', resolve: function () {} };
    item.timer = setTimeout(() => {
      const stage = item.diagnosticStage === 'provider-started' ? 'provider-timeout'
        : (item.diagnosticStage === 'delivered-to-ui' || item.diagnosticStage === 'provider-ready') ? 'client-timeout' : 'queue-timeout';
      recordStage(appId, stage, 'request-timeout');
      resolveRequest(id);
    }, images.length ? IMAGE_REPLY_TIMEOUT_MS : REPLY_TIMEOUT_MS);
    pending.set(id, item);
    queue.push(event);
    recordStage(appId, 'event-queued');
  }

  function connect(input) {
    if (closed) return Promise.resolve({ ok: false, error: 'qq-official-closed' });
    const appId = String(input && input.appId || '').trim();
    const account = accounts.get(appId);
    if (!account) return Promise.resolve({ ok: false, error: 'account-not-configured' });
    if (!account.combinedIntentConsent) return Promise.resolve({ ok: false, error: 'combined-intent-consent-required' });
    const existing = sessions.get(appId);
    if (existing && !existing.stopping) {
      if (statusFor(appId).state === 'failed') {
        return stopAccount(appId).then(() => connect({ appId }));
      }
      return Promise.resolve({ ok: true, accountId: account.accountId, state: statusFor(appId).state, alreadyConnected: true });
    }
    const credential = resolveCredential(account);
    if (!credential.ok) {
      recordConnectionError(appId, { code: credential.error }, credential.error);
      statusFor(appId).lastError = credential.error;
      return Promise.resolve({ ok: false, error: credential.error });
    }

    const generation = (existing ? existing.generation : 0) + 1;
    const runtime = {
      appId,
      generation,
      client: null,
      startPromise: null,
      activeSends: new Set(),
      stopping: false
    };
    sessions.set(appId, runtime);
    const current = statusFor(appId);
    current.state = 'connecting';
    current.lastError = '';
    current.lastCloseCode = null;
    recordStage(appId, 'websocket-connecting');

    runtime.startPromise = Promise.resolve().then(() => createBot({
      appId,
      appSecret: credential.secret,
      accountId: account.accountId,
      intentMask: C2C_AND_GROUP_INTENT_V105
    })).then(bot => {
      if (!bot || typeof bot.on !== 'function' || typeof bot.start !== 'function' || typeof bot.stop !== 'function'
        || typeof bot.sendText !== 'function' || typeof bot.sendImage !== 'function') {
        throw Object.assign(new Error('official-sdk-unavailable'), { code: 'ERR_MODULE_NOT_FOUND' });
      }
      if (sessions.get(appId) !== runtime || runtime.stopping) {
        try { bot.stop(); } catch (_) {}
        return null;
      }
      runtime.client = bot;
      if (typeof bot.use === 'function') {
        bot.use(async (context, next) => {
          const message = context && context.message;
          /* C2C and group identity/consent are checked before message text or
             attachments can reach a Home Node listener. */
          if (!authorizeInboundMessage(appId, message)) return;
          await next();
        });
      }
      bot.on('ready', () => {
        if (sessions.get(appId) !== runtime || runtime.stopping) return;
        current.state = 'online';
        current.lastError = '';
        current.lastCloseCode = null;
        recordStage(appId, 'websocket-connected');
      });
      bot.on('resumed', () => {
        if (sessions.get(appId) !== runtime || runtime.stopping) return;
        current.state = 'online';
        current.lastError = '';
        current.lastCloseCode = null;
        recordStage(appId, 'websocket-connected');
      });
      bot.on('disconnected', detail => {
        if (sessions.get(appId) !== runtime || runtime.stopping) return;
        current.lastCloseCode = Number(detail && detail.code) || null;
        current.state = detail && detail.willReconnect === true ? 'reconnecting' : 'failed';
        current.lastError = current.lastCloseCode === 4914 || current.lastCloseCode === 4915
          ? 'official-intent-not-accepted' : (current.state === 'failed' ? 'official-start-failed' : '');
        recordStage(appId, current.state === 'reconnecting' ? 'websocket-reconnecting' : 'websocket-disconnected', current.lastError);
      });
      bot.on('error', error => {
        if (sessions.get(appId) !== runtime || runtime.stopping) return;
        if (current.state !== 'online') current.state = 'reconnecting';
        current.lastError = safeCodeFromError(error, 'official-network-error');
        recordStage(appId, 'websocket-reconnecting', current.lastError);
      });
      bot.on('message', (_context, message) => {
        enqueueMessage(appId, generation, message).catch(() => {
          recordStage(appId, 'image-download-failed', 'image-download-failed');
        });
      });
      return bot.start();
    }).then(() => {
      if (sessions.get(appId) === runtime && !runtime.stopping) {
        sessions.delete(appId);
        current.state = 'stopped';
      }
    }, error => {
      if (sessions.get(appId) === runtime) {
        sessions.delete(appId);
        recordConnectionError(appId, error);
      }
    }).finally(() => {
      credential.secret = '';
    });

    return Promise.resolve({ ok: true, accountId: account.accountId, state: 'connecting' });
  }

  async function stopAccount(appIdValue) {
    const appId = String(appIdValue || '').trim();
    const runtime = sessions.get(appId);
    if (!runtime) {
      if (accounts.has(appId)) {
        const current = statusFor(appId);
        current.state = 'stopped';
        current.lastError = '';
        cancelPending(appId, 'official-stopped', 'official-stopped');
      }
      return { ok: true, accountId: accountIdFor(appId), state: 'stopped', alreadyStopped: true };
    }
    runtime.stopping = true;
    sessions.delete(appId);
    cancelPending(appId, 'official-stopped', 'official-stopped');
    const current = statusFor(appId);
    current.state = 'stopping';
    current.lastError = '';
    try { runtime.client && runtime.client.stop(); } catch (_) {}
    const work = [runtime.startPromise, ...Array.from(runtime.activeSends)];
    let timeoutHandle = null;
    const timeout = new Promise(resolve => { timeoutHandle = setTimeout(resolve, SEND_STOP_WAIT_MS); });
    await Promise.race([Promise.allSettled(work), timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (accounts.has(appId)) current.state = 'stopped';
    return { ok: true, accountId: accountIdFor(appId), state: 'stopped' };
  }

  function status() {
    const rows = [];
    for (const account of accounts.values()) {
      const current = statusFor(account.appId);
      rows.push({
        appId: account.appId,
        accountId: account.accountId,
        roleId: account.roleId,
        takeover: account.takeover,
        combinedIntentConsent: account.combinedIntentConsent,
        allowedUserCount: account.allowedUserOpenIds.length,
        pendingUserOpenIds: Array.from(pendingOpenIds(account.appId)),
        groups: account.groups.map(group => ({
          groupOpenId: group.groupOpenId, roleId: group.roleId, takeover: group.takeover,
          adminMemberCount: group.adminMemberOpenIds.length,
          pendingAdminMemberOpenIds: Array.from(pendingGroupAdminOpenIds(account.appId, group.groupOpenId))
        })),
        allowedGroupCount: account.groups.length,
        pendingGroupOpenIds: Array.from(pendingGroupOpenIds(account.appId)),
        state: current.state,
        lastEventAt: current.lastEventAt || null,
        lastReplyAt: current.lastReplyAt || null,
        lastError: current.lastError || '',
        lastStage: current.lastStage || 'idle',
        lastStageAt: current.lastStageAt || null,
        lastApiHttpStatus: current.lastApiHttpStatus,
        lastApiBusinessCode: current.lastApiBusinessCode,
        lastImageHttpStatus: current.lastImageHttpStatus,
        diagnostics: Object.assign({}, current.diagnostics),
        lastCloseCode: current.lastCloseCode,
        pendingCount: Array.from(pending.values()).filter(item => item.event.appId === account.appId).length
      });
    }
    return {
      ok: true,
      paused,
      clientActive: workerActive(),
      leaseMs: CLIENT_LEASE_MS,
      accounts: rows
    };
  }

  function heartbeat() {
    if (closed) return { ok: false, error: 'qq-official-closed' };
    touchClient();
    return { ok: true, clientActive: true, leaseMs: CLIENT_LEASE_MS };
  }

  function poll() {
    touchClient();
    if (closed || paused) return { ok: true, event: null };
    while (queue.length) {
      const event = queue.shift();
      const item = pending.get(event.requestId);
      const runtime = sessions.get(event.appId);
      const account = accounts.get(event.appId);
      if (item && runtime === item.runtime && runtime.generation === item.generation
        && isEventEnabled(account, event)) {
        item.diagnosticStage = 'delivered-to-ui';
        recordStage(event.appId, 'delivered-to-ui');
        return { ok: true, event };
      }
      if (item) resolveRequest(event.requestId);
    }
    return { ok: true, event: null };
  }

  function progress(input) {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (Object.keys(src).some(key => !['requestId', 'stage', 'errorCode'].includes(key))) {
      return { ok: false, error: 'invalid-request' };
    }
    const requestId = String(src.requestId || '');
    const stage = String(src.stage || '');
    if (!requestId || requestId.length > 80 || !DIAGNOSTIC_TRANSITIONS[stage]
      || (src.errorCode != null && stage !== 'provider-failed')) return { ok: false, error: 'invalid-request' };
    const item = pending.get(requestId);
    if (!item) return { ok: false, error: 'request-not-pending' };
    const allowedPriorStages = DIAGNOSTIC_TRANSITIONS[stage];
    if (!allowedPriorStages.has(item.diagnosticStage)) return { ok: false, error: 'invalid-stage-transition' };
    const runtime = sessions.get(item.event.appId);
    const account = accounts.get(item.event.appId);
    if (closed || runtime !== item.runtime || runtime.generation !== item.generation
      || !isEventEnabled(account, item.event)) {
      resolveRequest(requestId);
      return { ok: false, error: 'takeover-paused' };
    }
    if (stage === 'provider-failed' && !ERROR_CODES.has(String(src.errorCode || ''))) {
      return { ok: false, error: 'invalid-request' };
    }
    item.diagnosticStage = stage;
    recordStage(item.event.appId, stage, stage === 'provider-failed' ? src.errorCode : '');
    return { ok: true, stage };
  }

  async function complete(input) {
    touchClient();
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (Object.keys(src).some(key => !['requestId', 'reply', 'images'].includes(key))) {
      return { ok: false, error: 'invalid-request' };
    }
    const requestId = String(src.requestId || '').slice(0, 80);
    const item = pending.get(requestId);
    if (!item) return { ok: false, error: 'request-not-pending' };
    const account = accounts.get(item.event.appId);
    const runtime = sessions.get(item.event.appId);
    if (closed || paused || !runtime || runtime !== item.runtime || runtime.generation !== item.generation
      || !isEventEnabled(account, item.event)) {
      recordStage(item.event.appId, 'takeover-cancelled', 'takeover-paused');
      resolveRequest(requestId);
      return { ok: false, error: 'takeover-paused' };
    }
    const reply = String(src.reply == null ? '' : src.reply)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim().slice(0, MAX_REPLY_CHARS);
    let images = [];
    try {
      if (src.images != null) {
        if (!Array.isArray(src.images) || src.images.length > 1) throw imageError('image-output-invalid');
        images = src.images.map(image => decodeImagePayload(image, MAX_OUTBOUND_IMAGE_BYTES));
      }
    } catch (error) {
      if (Array.isArray(src.images)) src.images.forEach(image => { if (image && typeof image === 'object') image.base64 = ''; });
      recordStage(item.event.appId, 'image-output-invalid',
        error && ERROR_CODES.has(error.code) ? error.code : 'image-output-invalid');
      resolveRequest(requestId);
      return { ok: false, error: error && ERROR_CODES.has(error.code) ? error.code : 'image-output-invalid' };
    }
    if (!reply && !images.length) {
      if (item.diagnosticStage !== 'provider-failed') recordStage(item.event.appId, 'empty-reply', 'empty-output');
      resolveRequest(requestId);
      return { ok: true, replied: false };
    }
    const mediaReply = images.length > 0;
    recordStage(item.event.appId, mediaReply ? 'media-send-started' : 'send-started');
    if (mediaReply) {
      const counters = statusFor(item.event.appId).diagnostics;
      counters.sendStarted = Math.min(1000000, (counters.sendStarted || 0) + 1);
    }
    resolveRequest(requestId);
    if (runtime.stopping || sessions.get(item.event.appId) !== runtime) {
      return { ok: false, error: 'official-stopped' };
    }
    const sendPromise = Promise.resolve().then(() => {
      if (!images.length) return runtime.client.sendText(item.target, reply);
      if (!runtime.client || typeof runtime.client.sendImage !== 'function') {
        throw Object.assign(new Error('official-sdk-unavailable'), { code: 'ERR_MODULE_NOT_FOUND' });
      }
      return runtime.client.sendImage(item.target, { buffer: images[0].buffer }, { content: reply || undefined });
    });
    runtime.activeSends.add(sendPromise);
    try {
      const sendResult = await sendPromise;
      if (item.target.scope === 'group') {
        const sentMessage = mediaReply ? sendResult && sendResult.message : sendResult;
        rememberSentGroupMessage(item.event.appId, item.target, sentMessage && sentMessage.id);
      }
      if (sessions.get(item.event.appId) === runtime && !runtime.stopping) {
        const current = statusFor(item.event.appId);
        current.lastReplyAt = Number(clock()) || Date.now();
        recordStage(item.event.appId, mediaReply ? 'media-send-succeeded' : 'send-succeeded');
        if (mediaReply) current.diagnostics.sendSucceeded = Math.min(1000000, (current.diagnostics.sendSucceeded || 0) + 1);
      }
      return { ok: true, replied: true };
    } catch (error) {
      const errorCode = safeCodeFromError(error, 'official-send-failed');
      if (sessions.get(item.event.appId) === runtime && !runtime.stopping) {
        const current = statusFor(item.event.appId);
        const httpStatus = Number(error && error.httpStatus);
        const businessCode = Number(error && error.bizCode);
        current.lastApiHttpStatus = Number.isInteger(httpStatus) && httpStatus >= 0 && httpStatus <= 599 ? httpStatus : null;
        current.lastApiBusinessCode = Number.isSafeInteger(businessCode) ? businessCode : null;
        recordStage(item.event.appId, mediaReply ? 'media-send-failed' : 'send-failed', errorCode, {
          httpStatus: current.lastApiHttpStatus,
          businessCode: current.lastApiBusinessCode
        });
        if (mediaReply) current.diagnostics.sendFailed = Math.min(1000000, (current.diagnostics.sendFailed || 0) + 1);
      }
      return { ok: false, error: errorCode };
    } finally {
      runtime.activeSends.delete(sendPromise);
      images.forEach(image => image.buffer.fill(0));
      if (Array.isArray(src.images)) src.images.forEach(image => { if (image && typeof image === 'object') image.base64 = ''; });
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    paused = true;
    cancelPending('', 'takeover-cancelled', 'takeover-paused');
    await Promise.allSettled(Array.from(sessions.keys(), appId => stopAccount(appId)));
    accounts.clear();
    pendingOpenIdsByAppId.clear();
    pendingGroupOpenIdsByAppId.clear();
    pendingGroupAdminOpenIdsByAppId.clear();
    sentGroupMessageIds.clear();
  }

  function pause(value) {
    if (closed) return { ok: false, error: 'qq-official-closed' };
    paused = value !== false;
    if (paused) cancelPending('', 'takeover-cancelled', 'takeover-paused');
    touchClient();
    return { ok: true, paused, accounts: status().accounts };
  }

  return Object.freeze({
    configure,
    connect,
    disconnect: stopAccount,
    status,
    heartbeat,
    poll,
    progress,
    complete,
    pause,
    isCredentialRef: ref => Array.from(accounts.values()).some(account => account.credentialRef === String(ref || '')),
    close,
    describe: () => ({
      transport: 'tencent-qqbot-nodejs-websocket',
      accountLimit: MAX_ACCOUNTS,
      intentMask: C2C_AND_GROUP_INTENT_V105,
      groupIntentCoupled: true,
      proactiveMessages: false,
      mediaProcessed: true,
      groupMessagesProcessed: true,
      groupRequiresMention: true,
      groupAuthorizationPerGroup: true,
      inboundImageLimitBytes: MAX_IMAGE_BYTES,
      inboundImageTotalLimitBytes: MAX_IMAGE_TOTAL_BYTES,
      outboundImageLimitBytes: MAX_OUTBOUND_IMAGE_BYTES,
      pendingLimit: MAX_PENDING,
      replyTimeoutMs: REPLY_TIMEOUT_MS,
      clientLeaseMs: CLIENT_LEASE_MS
    })
  });
}

module.exports = createQQOfficialManager;
module.exports.createQQOfficialManager = createQQOfficialManager;
module.exports.createSDKBot = createSDKBot;
module.exports.normalizeAccount = normalizeAccount;
module.exports.accountIdFor = accountIdFor;
module.exports.credentialRefFor = credentialRefFor;
module.exports.C2C_AND_GROUP_INTENT_V105 = C2C_AND_GROUP_INTENT_V105;
module.exports.downloadQQImage = downloadQQImage;
module.exports.decodeImagePayload = decodeImagePayload;
module.exports.isAllowedImageHost = isAllowedImageHost;
module.exports.detectImageMime = detectImageMime;
module.exports.MEDIA_LIMITS = Object.freeze({
  imageCount: MAX_IMAGE_COUNT,
  imageBytes: MAX_IMAGE_BYTES,
  imageTotalBytes: MAX_IMAGE_TOTAL_BYTES,
  outboundImageBytes: MAX_OUTBOUND_IMAGE_BYTES,
  downloadTimeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS
});
