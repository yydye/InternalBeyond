'use strict';

const crypto = require('node:crypto');

const MAX_ACCOUNTS = 16;
const MAX_ALLOWLIST_ITEMS = 500;
const MAX_MESSAGE_CHARS = 6000;
const MAX_REPLY_CHARS = 1800;
const MAX_PENDING = 48;
const MAX_SEEN = 4096;
const REPLY_TIMEOUT_MS = 30000;
const CLIENT_LEASE_MS = 12000;
const HEARTBEAT_STALE_MS = 120000;
const ACCOUNT_ID_RE = /^\d{5,12}$/;
const NUMERIC_ID_RE = /^\d{5,14}$/;
const CALLBACK_AUTH_ERRORS = new Set([
  'callback-token-invalid', 'signature-missing', 'signature-invalid',
  'self-id-missing', 'self-id-mismatch', 'origin-rejected', 'local-only-rejected'
]);

function id(value, pattern) {
  const out = String(value == null ? '' : value).trim();
  return pattern.test(out) ? out : '';
}

function plainMessage(message, rawMessage, selfId) {
  let text = '';
  let mentionedSelf = false;
  let unsupported = false;
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (!segment || typeof segment !== 'object') { unsupported = true; continue; }
      const type = String(segment.type || '');
      const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
      if (type === 'text') text += String(data.text || '');
      else if (type === 'at') {
        const target = String(data.qq || data.user_id || '');
        if (target === selfId || target === 'all') {
          if (target === selfId) mentionedSelf = true;
          text += ' ';
        }
      } else unsupported = true;
    }
  } else if (typeof message === 'string') {
    const source = String(rawMessage || message);
    if (/\[CQ:(?!at(?:,|\]))[a-z_]+(?:,|\])/i.test(source)) unsupported = true;
    text = source.replace(/\[CQ:at,qq=(\d+)\]/gi, (_match, target) => {
      if (String(target) === selfId) mentionedSelf = true;
      return ' ';
    }).replace(/\[CQ:[^\]]*\]/gi, ' ');
  }
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS);
  return { text, mentionedSelf, unsupported };
}

function cleanReply(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_REPLY_CHARS);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeAccount(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const accountId = id(src.accountId, ACCOUNT_ID_RE);
  const roleId = String(src.roleId == null ? '' : src.roleId).trim().slice(0, 160);
  const ids = (values) => {
    const out = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values.slice(0, MAX_ALLOWLIST_ITEMS) : []) {
      const next = id(value, NUMERIC_ID_RE);
      if (next && !seen.has(next)) { seen.add(next); out.push(next); }
    }
    return out;
  };
  if (!accountId) return { ok: false, error: 'invalid-account-id' };
  if (src.takeover === true && !roleId) return { ok: false, error: 'role-required' };
  return {
    ok: true,
    account: {
      accountId,
      roleId,
      takeover: src.takeover === true,
      allowedPrivateUserIds: ids(src.allowedPrivateUserIds),
      allowedGroupIds: ids(src.allowedGroupIds),
      groupTrigger: 'mention',
      configuredAt: Number(src.configuredAt) || Date.now()
    }
  };
}

function createQQOneBot(options) {
  options = options || {};
  const desktopCredential = String(options.desktopCredential || '');
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomId = typeof options.randomId === 'function'
    ? options.randomId
    : () => crypto.randomBytes(16).toString('hex');
  const logger = typeof options.logger === 'function' ? options.logger : function () {};
  const accounts = new Map();
  const accountStatus = new Map();
  const pending = new Map();
  const queue = [];
  const seen = new Map();
  let paused = true;
  let closed = false;
  let lastClientAt = 0;

  function touchClient() {
    if (!closed) lastClientAt = Number(clock()) || Date.now();
  }

  function secretFor(accountId) {
    if (!desktopCredential) return '';
    return crypto.createHmac('sha256', desktopCredential)
      .update('ib-qq-onebot-v1:' + accountId)
      .digest('base64url');
  }

  function statusFor(accountId) {
    if (!accountStatus.has(accountId)) {
      accountStatus.set(accountId, { state: 'waiting', lastEventAt: 0, lastHeartbeatAt: 0, online: null, lastError: '', callbackAuthError: '' });
    }
    return accountStatus.get(accountId);
  }

  function reportCallbackAuthFailure(accountValue, reasonValue) {
    const accountId = id(accountValue, ACCOUNT_ID_RE);
    if (!accountId) return false;
    const reason = CALLBACK_AUTH_ERRORS.has(String(reasonValue || '')) ? String(reasonValue) : 'signature-invalid';
    const current = statusFor(accountId);
    current.callbackAuthError = reason;
    return true;
  }

  function reportCallbackAuthenticated(accountValue) {
    const accountId = id(accountValue, ACCOUNT_ID_RE);
    if (!accountId) return false;
    const current = statusFor(accountId);
    current.callbackAuthError = '';
    return true;
  }

  function resolvePending(requestId, reply) {
    const item = pending.get(requestId);
    if (!item) return false;
    pending.delete(requestId);
    clearTimeout(item.timer);
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].requestId === requestId) queue.splice(index, 1);
    }
    item.resolve(reply || null);
    return true;
  }

  function stopAccount(accountId) {
    for (const [requestId, item] of pending) {
      if (item.event.accountId === accountId) resolvePending(requestId, null);
    }
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].accountId === accountId) queue.splice(index, 1);
    }
  }

  function configure(input) {
    if (closed) return { ok: false, error: 'qq-onebot-closed' };
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (!Array.isArray(src.accounts) || src.accounts.length > MAX_ACCOUNTS) return { ok: false, error: 'invalid-account-list' };
    const next = new Map();
    for (const item of src.accounts) {
      const normalized = normalizeAccount(item);
      if (!normalized.ok) return normalized;
      const account = normalized.account;
      if (next.has(account.accountId)) return { ok: false, error: 'duplicate-account-id' };
      if (account.takeover && account.roleId && Array.from(next.values()).some(row => row.takeover && row.roleId === account.roleId)) {
        return { ok: false, error: 'role-already-bound-to-active-account' };
      }
      next.set(account.accountId, account);
    }
    const nextPaused = src.paused !== false;
    for (const [oldId, oldAccount] of accounts) {
      const updated = next.get(oldId);
      if (!updated || nextPaused || !updated.takeover || JSON.stringify(oldAccount) !== JSON.stringify(updated)) stopAccount(oldId);
    }
    accounts.clear();
    for (const [accountId, account] of next) accounts.set(accountId, account);
    paused = nextPaused;
    touchClient();
    return { ok: true, paused, accounts: status() };
  }

  function setup(accountValue, baseUrl) {
    const accountId = id(accountValue, ACCOUNT_ID_RE);
    if (!accountId) return { ok: false, error: 'invalid-account-id' };
    const secret = secretFor(accountId);
    if (!secret) return { ok: false, error: 'desktop-credential-unavailable' };
    const base = String(baseUrl || '').replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(base); } catch (_) { parsed = null; }
    const host = parsed && String(parsed.hostname || '').toLowerCase();
    if (!parsed || parsed.protocol !== 'http:' || parsed.username || parsed.password
      || !parsed.port || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      return { ok: false, error: 'loopback-base-required' };
    }
    const callbackBase = 'http://127.0.0.1:' + String(parsed.port);
    const callbackUrl = callbackBase + '/qq/onebot/v11/' + accountId + '?token=' + encodeURIComponent(secret);
    return { ok: true, accountId, callbackUrl, messagePostFormat: 'array', reportSelfMessage: false };
  }

  function isCallbackToken(accountValue, token) {
    const accountId = id(accountValue, ACCOUNT_ID_RE);
    const expected = accountId ? secretFor(accountId) : '';
    return !!expected && constantTimeEqual(token, expected);
  }

  function isCallbackSignature(accountValue, rawBody, signature) {
    const accountId = id(accountValue, ACCOUNT_ID_RE);
    const secret = accountId ? secretFor(accountId) : '';
    const supplied = String(signature || '');
    if (!secret || !/^sha1=[a-f0-9]{40}$/i.test(supplied)) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody), 'utf8');
    const expected = 'sha1=' + crypto.createHmac('sha1', secret).update(body).digest('hex');
    return constantTimeEqual(supplied.toLowerCase(), expected);
  }

  function isReceivingEnabled(accountValue) {
    const accountId = id(accountValue, ACCOUNT_ID_RE);
    const account = accountId ? accounts.get(accountId) : null;
    const now = Number(clock()) || Date.now();
    return !closed && !paused && !!account && account.takeover === true
      && (account.allowedPrivateUserIds.length > 0 || account.allowedGroupIds.length > 0)
      && lastClientAt > 0 && now - lastClientAt <= CLIENT_LEASE_MS;
  }

  function heartbeat() {
    if (closed) return { ok: false, error: 'qq-onebot-closed' };
    touchClient();
    return { ok: true, clientActive: true, leaseMs: CLIENT_LEASE_MS };
  }

  function status() {
    const now = Number(clock()) || Date.now();
    const out = [];
    for (const account of accounts.values()) {
      const current = statusFor(account.accountId);
      let state = current.state;
      if (!current.lastEventAt) state = 'waiting';
      else if (now - current.lastEventAt > HEARTBEAT_STALE_MS) state = 'stale';
      else if (current.online === true) state = 'online';
      else if (current.online === false) state = 'offline';
      else state = 'seen';
      out.push({
        accountId: account.accountId,
        roleId: account.roleId,
        takeover: account.takeover,
        state,
        paused,
        lastEventAt: current.lastEventAt || null,
        lastHeartbeatAt: current.lastHeartbeatAt || null,
        callbackAuthError: current.callbackAuthError || '',
        pendingCount: Array.from(pending.values()).filter(item => item.event.accountId === account.accountId).length
      });
    }
    return {
      ok: true,
      paused,
      clientActive: lastClientAt > 0 && now - lastClientAt <= CLIENT_LEASE_MS,
      accounts: out
    };
  }

  function markEvent(accountId, event) {
    const current = statusFor(accountId);
    current.lastEventAt = Number(clock()) || Date.now();
    current.state = 'seen';
    current.lastError = '';
    current.callbackAuthError = '';
    if (event.post_type === 'meta_event') {
      if (event.meta_event_type === 'heartbeat') {
        current.lastHeartbeatAt = current.lastEventAt;
        const online = event.status && typeof event.status.online === 'boolean' ? event.status.online : null;
        if (online !== null) current.online = online;
        else if (current.online === null) current.online = true;
      } else if (event.meta_event_type === 'lifecycle') {
        if (event.sub_type === 'connect') current.online = true;
        if (event.sub_type === 'disable' || event.sub_type === 'disconnect') current.online = false;
      }
    } else if (event.post_type === 'message') current.online = true;
  }

  function remember(eventKey) {
    const now = Number(clock()) || Date.now();
    const prior = seen.get(eventKey);
    if (prior && now - prior < 10 * 60 * 1000) return false;
    seen.set(eventKey, now);
    if (seen.size > MAX_SEEN) {
      for (const [key, at] of seen) {
        if (now - at > 10 * 60 * 1000 || seen.size > MAX_SEEN) seen.delete(key);
        if (seen.size <= MAX_SEEN) break;
      }
    }
    return true;
  }

  function receive(accountValue, token, event) {
    const accountId = id(accountValue, ACCOUNT_ID_RE);
    if (!accountId || !secretFor(accountId) || !constantTimeEqual(token, secretFor(accountId))) {
      return Promise.resolve({ ok: false, error: 'unauthorized' });
    }
    const account = accounts.get(accountId);
    if (!account || !event || typeof event !== 'object' || Array.isArray(event)) return Promise.resolve({ ok: true, quickOperation: null });
    if (String(event.self_id == null ? '' : event.self_id) !== accountId) {
      logger('warn', 'qq-onebot-account-mismatch', { accountId });
      return Promise.resolve({ ok: true, quickOperation: null });
    }
    markEvent(accountId, event);
    if (event.post_type !== 'message') return Promise.resolve({ ok: true, quickOperation: null });
    if (!isReceivingEnabled(accountId)) return Promise.resolve({ ok: true, quickOperation: null });
    const messageType = String(event.message_type || '');
    const senderId = id(event.user_id, NUMERIC_ID_RE);
    if (!senderId || senderId === accountId || Array.from(accounts.keys()).includes(senderId)) return Promise.resolve({ ok: true, quickOperation: null });
    let peerId = '';
    if (messageType === 'private') {
      if (event.sub_type && event.sub_type !== 'friend') return Promise.resolve({ ok: true, quickOperation: null });
      if (!account.allowedPrivateUserIds.includes(senderId)) return Promise.resolve({ ok: true, quickOperation: null });
      peerId = senderId;
    } else if (messageType === 'group') {
      if (event.sub_type && event.sub_type !== 'normal') return Promise.resolve({ ok: true, quickOperation: null });
      const groupId = id(event.group_id, NUMERIC_ID_RE);
      if (!groupId || !account.allowedGroupIds.includes(groupId)) return Promise.resolve({ ok: true, quickOperation: null });
      peerId = groupId;
    } else return Promise.resolve({ ok: true, quickOperation: null });

    const parsed = plainMessage(event.message, event.raw_message, accountId);
    if (!parsed.text || parsed.unsupported) return Promise.resolve({ ok: true, quickOperation: null });
    if (messageType === 'group' && !parsed.mentionedSelf) return Promise.resolve({ ok: true, quickOperation: null });
    const messageId = String(event.message_id == null ? '' : event.message_id).slice(0, 80);
    if (pending.size >= MAX_PENDING || queue.length >= MAX_PENDING) return Promise.resolve({ ok: true, quickOperation: null });
    const seenKey = accountId + ':' + (messageId || (String(event.time || '') + ':' + senderId + ':' + parsed.text.slice(0, 80)));
    if (!remember(seenKey)) return Promise.resolve({ ok: true, quickOperation: null });

    const requestId = String(randomId()).slice(0, 80);
    const friendId = messageType === 'group'
      ? 'group_qq_' + accountId + '_' + peerId
      : 'qq_' + accountId + '_' + peerId;
    const conversationId = (messageType === 'group' ? 'group:' : 'dm:') + friendId;
    const queued = {
      requestId,
      accountId,
      roleId: account.roleId,
      messageId,
      messageType,
      senderId,
      peerId,
      friendId,
      conversationId,
      text: parsed.text,
      receivedAt: Number(event.time) > 0 ? Number(event.time) * 1000 : Number(clock()) || Date.now()
    };
    return new Promise(resolve => {
      const timer = setTimeout(() => resolvePending(requestId, null), REPLY_TIMEOUT_MS);
      pending.set(requestId, { event: queued, resolve, timer });
      queue.push(queued);
    }).then(reply => ({
      ok: true,
      quickOperation: reply ? {
        reply,
        auto_escape: true,
        at_sender: false
      } : null
    }));
  }

  function poll() {
    touchClient();
    if (paused || closed) return { ok: true, event: null };
    while (queue.length) {
      const event = queue.shift();
      const item = pending.get(event.requestId);
      const account = accounts.get(event.accountId);
      if (item && account && account.takeover && !paused) return { ok: true, event };
      if (item) resolvePending(event.requestId, null);
    }
    return { ok: true, event: null };
  }

  function complete(input) {
    touchClient();
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const requestId = String(src.requestId || '').slice(0, 80);
    const item = pending.get(requestId);
    if (!item) return { ok: false, error: 'request-not-pending' };
    const account = accounts.get(item.event.accountId);
    if (paused || !account || !account.takeover) {
      resolvePending(requestId, null);
      return { ok: false, error: 'takeover-paused' };
    }
    const reply = cleanReply(src.reply);
    if (!reply) {
      resolvePending(requestId, null);
      return { ok: true, replied: false };
    }
    resolvePending(requestId, reply);
    return { ok: true, replied: true };
  }

  function describe() {
    return {
      transport: 'onebot11-http-client',
      localOnly: true,
      accountLimit: MAX_ACCOUNTS,
      replyTimeoutMs: REPLY_TIMEOUT_MS,
      clientLeaseMs: CLIENT_LEASE_MS,
      proactiveMessages: false,
      contentLogs: false
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const requestId of Array.from(pending.keys())) resolvePending(requestId, null);
    queue.length = 0;
    accounts.clear();
  }

  return Object.freeze({
    configure,
    setup,
    isCallbackToken,
    isCallbackSignature,
    reportCallbackAuthFailure,
    reportCallbackAuthenticated,
    isReceivingEnabled,
    status,
    heartbeat,
    receive,
    poll,
    complete,
    pause: value => configure({ accounts: Array.from(accounts.values()), paused: value !== false }),
    close,
    describe
  });
}

module.exports = createQQOneBot;
module.exports.createQQOneBot = createQQOneBot;
module.exports.normalizeAccount = normalizeAccount;
module.exports.plainMessage = plainMessage;
module.exports.cleanReply = cleanReply;
module.exports.constantTimeEqual = constantTimeEqual;
