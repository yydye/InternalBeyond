/* Proactive Interaction 共享核心 —— 浏览器与 Node 测试共用同一份实现，禁止分叉复制。
   加载方式：
   - 浏览器：<script src="assets/js/proactive-interaction-core.js">（在 active-plans.js / call.js 之前）；
     挂载 window._proactiveInteractionCore / IB.proactiveInteraction。
   - Node：require('./assets/js/proactive-interaction-core.js')（test_proactive_interaction.js 直接复用）。
   纯函数、零 DOM / 零 IO；交互模型（text_message | voice_call）、主动事件规范与去重、
   通话状态机、时长格式化等规则在此唯一定义。任何改动必须同时影响浏览器与测试。
   UI 只消费这里产出的规范化事件与状态，不做业务判断。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const core = factory();
    root._proactiveInteractionCore = core;
    root.IB = root.IB || {};
    root.IB.proactiveInteraction = core;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ══════════ 交互类型（唯一来源） ══════════ */
  const INTERACTIONS = ['text_message', 'voice_call'];

  /* 把任意来源的 interaction 规范到白名单内；非法/缺失回落 text_message。 */
  function normalizeInteraction(value) {
    return INTERACTIONS.indexOf(value) !== -1 ? value : 'text_message';
  }

  /* ══════════ 通话 UI 状态机 ══════════
     与 bridge/voice-runtime.js 的服务端状态（idle/connecting/listening/thinking/
     speaking/interrupting/error/ended）解耦：这里的 incoming/connected/ending 是
     前端在「呼入→接听→挂断」阶段可见的代理状态；一旦进入真实语音会话，runtime 状态
     才是唯一事实来源（见 call.js setState 的同步点）。canTransition 只约束前端允许的
     跳转，不做也不替代 runtime 权威。 */
  const CALL_STATES = ['idle', 'incoming', 'connecting', 'connected', 'listening', 'thinking', 'speaking', 'interrupting', 'ending', 'ended'];

  const CALL_LABELS = {
    idle: 'Idle',
    incoming: 'Incoming',
    connecting: 'Connecting',
    connected: 'Connected',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
    interrupting: 'Interrupting',
    ending: 'Ending',
    ended: 'Call ended'
  };

  /* 允许的前端状态迁移。idle 可直达 incoming（呼入）或 connecting（外呼）。 */
  const CALL_TRANSITIONS = {
    idle: ['incoming', 'connecting', 'ended'],
    incoming: ['connecting', 'idle', 'ended'],
    connecting: ['connected', 'listening', 'ended'],
    connected: ['listening', 'speaking', 'thinking', 'ending', 'ended'],
    listening: ['thinking', 'speaking', 'connecting', 'ending', 'ended'],
    thinking: ['listening', 'speaking', 'ending', 'ended'],
    speaking: ['listening', 'thinking', 'interrupting', 'ending', 'ended'],
    interrupting: ['listening', 'ending', 'ended'],
    ending: ['ended'],
    ended: []
  };

  function normalizeCallState(value) {
    return CALL_STATES.indexOf(value) !== -1 ? value : 'idle';
  }

  function canTransition(from, to) {
    const fromState = normalizeCallState(from);
    const toState = normalizeCallState(to);
    if (fromState === toState) return true;
    const allowed = CALL_TRANSITIONS[fromState] || [];
    return allowed.indexOf(toState) !== -1;
  }

  /* 通话时长格式化：ms → "m:ss"（不足 1 小时）或 "h:mm:ss" */
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(Number(ms) || 0));
    const seconds = Math.floor(total / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    return h > 0 ? (h + ':' + p2(m) + ':' + p2(s)) : (m + ':' + p2(s));
  }

  /* ══════════ 主动交互事件规范 ══════════
     事件字段：eventId / roleId / roleName / avatar / interaction / reason /
     openingMessage / createdAt / callMeta{conversationId, openingLine}。
     UI 与 runtime 只需消费这里产出的规范化值，不自行推断。 */
  function normalizeEvent(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const interaction = normalizeInteraction(r.interaction);
    const createdAt = String(r.createdAt || new Date().toISOString());
    const eventId = String(r.eventId || ('iact_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)));
    const openingMessage = String(r.openingMessage || r.opening_message || '').trim();
    const reason = String(r.reason || '').slice(0, 300);
    const callMeta = (r.callMeta && typeof r.callMeta === 'object') ? r.callMeta : {};
    return {
      eventId: eventId,
      roleId: String(r.roleId || r.role_id || ''),
      roleName: String(r.roleName || r.role_name || 'AI'),
      avatar: String(r.avatar || ''),
      interaction: interaction,
      reason: reason,
      openingMessage: openingMessage,
      openingLine: String(callMeta.openingLine || openingMessage).slice(0, 600),
      createdAt: createdAt,
      callMeta: {
        conversationId: String(callMeta.conversationId || (r.roleId ? ('main:' + r.roleId) : '')),
        openingLine: String(callMeta.openingLine || openingMessage).slice(0, 600)
      },
      /* 共识/结果状态：pending → accepted / declined / dismissed；只由 UI 动作推进 */
      status: ['pending', 'accepted', 'declined', 'dismissed'].indexOf(r.status) !== -1 ? r.status : 'pending',
      actedAt: r.actedAt ? String(r.actedAt) : null,
      planId: r.planId ? String(r.planId) : null
    };
  }

  /* 去重键：同一角色 + 同交互类型的消息，按规范化正文做稳定散列，用于防重复主动事件。 */
  function hashStr(s) {
    let h = 7;
    const t = String(s || '');
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
  }

  function eventKey(ev) {
    const e = ev && typeof ev === 'object' ? ev : {};
    const text = normalizeKey(String(e.openingMessage || e.openingLine || ''));
    return (e.roleId || '') + '|' + normalizeInteraction(e.interaction) + '|' + text;
  }

  function normalizeKey(value) {
    return String(value || '').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
  }

  /* 相似度：bigram Dice，与 proactive 去重一致的度量。 */
  function textSimilarity(left, right) {
    const a = normalizeKey(left);
    const b = normalizeKey(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const grams = function (v) {
      if (v.length < 2) return [v];
      const out = [];
      for (let i = 0; i < v.length - 1; i += 1) out.push(v.slice(i, i + 2));
      return out;
    };
    const pool = new Map();
    grams(a).forEach(function (g) { pool.set(g, (pool.get(g) || 0) + 1); });
    let overlap = 0;
    const bGrams = grams(b);
    bGrams.forEach(function (g) {
      const c = pool.get(g) || 0;
      if (!c) return;
      overlap += 1;
      pool.set(g, c - 1);
    });
    return 2 * overlap / (grams(a).length + bGrams.length);
  }

  /* 防重复：同一角色、同一交互类型，正文与最近事件高度相似（或完全相同），视为重复。 */
  function isDuplicateEvent(ev, recentEvents) {
    const e = ev && typeof ev === 'object' ? ev : {};
    const rows = Array.isArray(recentEvents) ? recentEvents : [];
    const key = String(e.roleId || '');
    const interaction = normalizeInteraction(e.interaction);
    for (let i = 0; i < rows.length; i += 1) {
      const old = rows[i] && typeof rows[i] === 'object' ? rows[i] : {};
      if (String(old.roleId || '') !== key) continue;
      if (normalizeInteraction(old.interaction) !== interaction) continue;
      /* 仍处 pending（未接听/未拒绝）的同类呼入 → 直接视为重复，避免叠加呼入 */
      if (old.status === 'pending' && e.status === 'pending') return true;
      if (textSimilarity(e.openingMessage, old.openingMessage) >= 0.82) return true;
    }
    return false;
  }

  /* 清理过期事件（默认 2 小时窗口内保留，防误删已接受/已拒绝的事件被再次触发）。 */
  function purgeExpired(list, maxAgeMs) {
    const rows = Array.isArray(list) ? list : [];
    const max = Number(maxAgeMs) || 2 * 60 * 60 * 1000;
    const now = Date.now();
    return rows.filter(function (item) {
      const t = Date.parse(item && item.createdAt) || 0;
      return (item && item.status !== 'pending') ? true : (now - t < max);
    });
  }

  return {
    INTERACTIONS: INTERACTIONS,
    CALL_STATES: CALL_STATES,
    CALL_LABELS: CALL_LABELS,
    normalizeInteraction: normalizeInteraction,
    normalizeEvent: normalizeEvent,
    normalizeCallState: normalizeCallState,
    canTransition: canTransition,
    formatDuration: formatDuration,
    eventKey: eventKey,
    textSimilarity: textSimilarity,
    isDuplicateEvent: isDuplicateEvent,
    purgeExpired: purgeExpired,
    hashStr: hashStr
  };
});
