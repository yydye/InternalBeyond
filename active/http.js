/* IB Active · HTTP 层：CORS（Origin 白名单）、JSON 响应、请求体解析、任务公开视图、
   全部 REST 路由（tasks / plans / reconcile / events / history）与 server 实例。
   从 active-message-service.js 提取为工厂：state 经 getState() 注入（仅原地变更，
   无重新赋值），armedUsers / 持久化 / 计划域函数全部依赖注入。原逻辑逐字不变。 */
'use strict';

const http = require('http');

function createHttp(ctx) {
  const {
    HOST, PORT, maxBody, getState, armedUsers, saveNow, queueSave,
    publicPlan, sanitizeAiPlan, buildTaskReplacement, recordUserId,
    trimText, deepClone, finiteTimestamp,
    sanitizeMomentSchedule, publicMomentSchedule
  } = ctx;

  function originAllowed(origin) {
    return !origin || origin === 'null' || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin);
  }

  function applyCors(request, response) {
    const origin = request.headers.origin;
    if (!originAllowed(origin)) return false;
    response.setHeader('Access-Control-Allow-Origin', origin || 'null');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    /* 注意：不再发送 Access-Control-Allow-Private-Network 放行头——
       现代浏览器 PNA 预检会拒绝公网网页对私网资源的请求，此头保留反而使
       公网恶意页面（经 sandboxed iframe / data: 页，Origin 为 null）可跨域读写本服务。 */
    return true;
  }

  function json(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    response.end(body);
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on('data', chunk => {
        size += chunk.length;
        if (size > maxBody) {
          reject(new Error('Request body is too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (_) {
          reject(new Error('Invalid JSON body'));
        }
      });
      request.on('error', reject);
    });
  }

  function publicTask(task) {
    const setting = task && task.setting || {};
    const character = task && task.character || {};
    return {
      id: setting.id,
      character_id: setting.character_id,
      character_name: character.nickname || character.model || 'AI',
      enabled: !!setting.enabled,
      next_run_at: setting.next_run_at || null,
      last_sent: setting.last_sent || null,
      task_revision: task && task.task_revision || 1,
      setting_updated_at: task && task.setting_updated_at || finiteTimestamp(setting.updated_at)
    };
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (!applyCors(request, response)) {
        json(response, 403, { error: 'Origin is not allowed' });
        return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      /* new URL 对畸形请求行（如非法百分号编码）可能抛错；必须位于 try 内，否则成为未捕获异常导致进程退出 */
      const url = new URL(request.url, `http://${HOST}:${PORT}`);
      const parts = url.pathname.split('/').filter(Boolean);
      const s = getState();
      if (request.method === 'GET' && url.pathname === '/health') {        json(response, 200, {
          ok: true,
          service: 'internal-beyond-active-messages',
          version: 3,
          tasks: Object.keys(s.tasks).length,
          plans: Object.keys(s.plans).length,
          moments: Object.keys(s.moments || {}).length,
          reply_chains: Object.keys(s.replyChains || {}).length,
          pending_events: Object.values(s.events).filter(event => !event.acknowledged).length,
          armed_users: armedUsers.size,
          now: Date.now()
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/tasks') {
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        json(response, 200, {
          tasks: Object.values(s.tasks)
            .filter(task => String(task && task.setting && task.setting.user_id || '') === userId)
            .map(publicTask)
        });
        return;
      }
      if (request.method === 'PUT' && parts[0] === 'tasks' && parts[1]) {
        const taskId = decodeURIComponent(parts.slice(1).join('/'));
        const body = await readBody(request);
        if (!body || !body.setting || body.setting.id !== taskId || !body.setting.user_id || !body.character) {
          json(response, 400, { error: 'Invalid task snapshot' });
          return;
        }
        const existingOwner = String(s.tasks[taskId] && s.tasks[taskId].setting && s.tasks[taskId].setting.user_id || '');
        const incomingOwner = String(body.setting.user_id || '');
        if (existingOwner && existingOwner !== incomingOwner) {
          json(response, 403, { error: 'Task does not belong to this user' });
          return;
        }
        const built = buildTaskReplacement(body, taskId, s.tasks[taskId]);
        s.tasks[taskId] = built.task;
        saveNow();
        json(response, 200, { ok: true, stale: built.stale, task: publicTask(s.tasks[taskId]) });
        return;
      }
      if (request.method === 'DELETE' && parts[0] === 'tasks' && parts[1]) {
        const taskId = decodeURIComponent(parts.slice(1).join('/'));
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        const existing = s.tasks[taskId];
        if (existing && String(existing.setting && existing.setting.user_id || '') !== userId) {
          json(response, 403, { error: 'Task does not belong to this user' });
          return;
        }
        if (existing) {
          delete s.tasks[taskId];
          saveNow();
        }
        json(response, 200, { ok: true, missing: !existing });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/plans') {
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        json(response, 200, {
          plans: Object.values(s.plans)
            .filter(p => String(p && p.user_id || '') === userId)
            .map(publicPlan)
        });
        return;
      }
      if (request.method === 'PUT' && parts[0] === 'plans' && parts[1]) {
        const planId = decodeURIComponent(parts.slice(1).join('/'));
        const body = await readBody(request);
        if (!body || !body.plan || body.plan.id !== planId) {
          json(response, 400, { error: 'Invalid plan snapshot' });
          return;
        }
        const incoming = sanitizeAiPlan(body.plan);
        if (!incoming.id || !incoming.characterId || !incoming.user_id) {
          json(response, 400, { error: 'Invalid plan snapshot' });
          return;
        }
        const existing = s.plans[planId];
        const existingOwner = String(existing && existing.user_id || '');
        if (existingOwner && existingOwner !== incoming.user_id) {
          json(response, 403, { error: 'Plan does not belong to this user' });
          return;
        }
        const incomingUpdated = Date.parse(incoming.updatedAt) || 0;
        const existingUpdated = existing ? (Date.parse(existing.updatedAt) || 0) : 0;
        const existingExecuted = existing ? (Date.parse(existing.executedAt) || 0) : 0;
        /* stale 判定以服务端已执行状态为单调边界：已发送（executedAt 存在）的计划
           任何回退为 scheduled 的尝试一律拒绝（浏览器本地状态经事件回传同步，不存在合法回退场景）。
           客户端提交未来 updatedAt/executedAt 无法绕过：执行状态只前进不后退。 */
        const executedLock = existingExecuted > 0 && ['scheduled', 'evaluating', 'sending'].includes(incoming.status);
        if ((existing && incomingUpdated < existingUpdated) || executedLock) {
          /* 本地计划已被执行器更新（如已发送）→ 拒绝旧快照回写 */
          json(response, 200, { ok: true, stale: true, plan: publicPlan(existing) });
          return;
        }
        /* 已执行标记单调：客户端快照缺 executedAt（旧数据）或携带不可解析/更早的 executedAt
           （epoch 0、垃圾值）时保留服务端已执行标记，防止抹掉后 scheduled 回写通过 stale 检查导致重复发送 */
        const incomingExecTs = Date.parse(incoming.executedAt) || 0;
        const existingExecTs = existing ? (Date.parse(existing.executedAt) || 0) : 0;
        s.plans[planId] = {
          ...incoming,
          executedAt: incomingExecTs > 0 && incomingExecTs >= existingExecTs
            ? incoming.executedAt
            : ((existing && existing.executedAt) || null),
          character: deepClone(body.character || {}),
          user: deepClone(body.user || {}),
          recent_memories: Array.isArray(body.recent_memories) ? deepClone(body.recent_memories.slice(0, 8)) : [],
          recent_messages: Array.isArray(body.recent_messages) ? deepClone(body.recent_messages.slice(-16)) : [],
          recent_proactive_messages: Array.isArray(body.recent_proactive_messages) ? deepClone(body.recent_proactive_messages.slice(-10)) : [],
          chat_summary: trimText(body.chat_summary, 1200),
          last_interaction_at: finiteTimestamp(body.last_interaction_at),
          synced_at: Date.now()
        };
        saveNow();
        json(response, 200, { ok: true, stale: false, plan: publicPlan(s.plans[planId]) });
        return;
      }
      if (request.method === 'DELETE' && parts[0] === 'plans' && parts[1]) {
        const planId = decodeURIComponent(parts.slice(1).join('/'));
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        const existing = s.plans[planId];
        if (existing && String(existing.user_id || '') !== userId) {
          json(response, 403, { error: 'Plan does not belong to this user' });
          return;
        }
        const executed = !!(existing && (existing.executedAt || (existing.status === 'waiting_for_user')));
        if (existing) {
          delete s.plans[planId];
          saveNow();
        }
        /* executed 标记：告知调用方该副本删除前已执行过，防止浏览器误判离线后重发已发送计划 */
        json(response, 200, { ok: true, missing: !existing, executed });
        return;
      }
      /* ── Moments 后台朋友圈调度：与 plans 同一套 user_id 归属 + stale/executedAt 单调 + reconcile 声明 ── */
      if (request.method === 'GET' && url.pathname === '/moments') {
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        json(response, 200, {
          moments: Object.values(s.moments || {})
            .filter(m => String(m && m.user_id || '') === userId)
            .map(publicMomentSchedule)
        });
        return;
      }
      if (request.method === 'PUT' && parts[0] === 'moments' && parts[1]) {
        const characterId = decodeURIComponent(parts.slice(1).join('/'));
        const body = await readBody(request);
        const raw = body && body.schedule || {};
        if (!raw || String(raw.id || raw.characterId || '') !== characterId || !raw.characterId || !raw.user_id) {
          json(response, 400, { error: 'Invalid moment schedule snapshot' });
          return;
        }
        const incoming = sanitizeMomentSchedule(raw);
        if (!incoming.characterId || !incoming.user_id) {
          json(response, 400, { error: 'Invalid moment schedule snapshot' });
          return;
        }
        const existing = (s.moments || {})[characterId];
        const existingOwner = String(existing && existing.user_id || '');
        if (existingOwner && existingOwner !== incoming.user_id) {
          json(response, 403, { error: 'Moment schedule does not belong to this user' });
          return;
        }
        const incomingUpdated = Date.parse(incoming.updatedAt) || 0;
        const existingUpdated = existing ? (Date.parse(existing.updatedAt) || 0) : 0;
        /* stale 判定：执行器推进（updatedAt 更新）后，旧的浏览器快照回写一律拒绝（防重复执行） */
        if (existing && incomingUpdated < existingUpdated) {
          json(response, 200, { ok: true, stale: true, schedule: publicMomentSchedule(existing) });
          return;
        }
        /* executedAt 单调：已执行标记只前进不后退 */
        const incomingExecTs = Date.parse(incoming.executedAt || '') || 0;
        const existingExecTs = existing ? (Date.parse(existing.executedAt || '') || 0) : 0;
        s.moments[characterId] = {
          ...incoming,
          executedAt: incomingExecTs > 0 && incomingExecTs >= existingExecTs
            ? incoming.executedAt
            : ((existing && existing.executedAt) || null),
          character: deepClone(body.character || {}),
          user: deepClone(body.user || {}),
          recent_memories: Array.isArray(body.recent_memories) ? deepClone(body.recent_memories.slice(0, 8)) : [],
          recent_messages: Array.isArray(body.recent_messages) ? deepClone(body.recent_messages.slice(-16)) : [],
          recent_proactive_messages: Array.isArray(body.recent_proactive_messages) ? deepClone(body.recent_proactive_messages.slice(-10)) : [],
          chat_summary: trimText(body.chat_summary, 1200),
          last_interaction_at: finiteTimestamp(body.last_interaction_at),
          recent_moments: Array.isArray(body.recent_moments) ? deepClone(body.recent_moments.slice(0, 30)) : [],
          other_role_moments: Array.isArray(body.other_role_moments) ? deepClone(body.other_role_moments.slice(0, 20)) : [],
          /* ── AI↔AI 回复链：线程快照 + 角色偏好（同一 PUT 载荷的附加字段，协议不变） ── */
          recent_threads: Array.isArray(body.recent_threads) ? deepClone(body.recent_threads.slice(0, 8)) : [],
          moments_prefs: (body.prefs && typeof body.prefs === 'object') ? deepClone(body.prefs) : {},
          synced_at: Date.now()
        };
        saveNow();
        json(response, 200, { ok: true, stale: false, schedule: publicMomentSchedule(s.moments[characterId]) });
        return;
      }
      if (request.method === 'DELETE' && parts[0] === 'moments' && parts[1]) {
        const characterId = decodeURIComponent(parts.slice(1).join('/'));
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        const existing = (s.moments || {})[characterId];
        if (existing && String(existing.user_id || '') !== userId) {
          json(response, 403, { error: 'Moment schedule does not belong to this user' });
          return;
        }
        const executed = !!(existing && existing.executedAt);
        if (existing) {
          delete s.moments[characterId];
          saveNow();
        }
        /* executed 标记：与 plans 同理，防止浏览器误判后本地补发已执行动态 */
        json(response, 200, { ok: true, missing: !existing, executed });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/reconcile') {
        const body = await readBody(request);
        const userId = String(body && body.user_id || '');
        /* 仅当对应字段存在时才清理该集合：调用方各自声明自己管辖的 id 列表，
           未声明的一侧保持不动（避免 AI 计划同步误删手动任务或反之） */
        const hasTasks = Array.isArray(body && body.task_ids);
        const hasPlans = Array.isArray(body && body.plan_ids);
        const hasMomentIds = Array.isArray(body && body.moment_ids);
        const keep = new Set(hasTasks ? body.task_ids.map(String) : []);
        const keepPlans = new Set(hasPlans ? body.plan_ids.map(String) : []);
        const keepMoments = new Set(hasMomentIds ? body.moment_ids.map(String) : []);
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        let removed = 0;
        if (hasTasks) {
          Object.keys(s.tasks).forEach(taskId => {
            const taskUser = String(s.tasks[taskId] && s.tasks[taskId].setting && s.tasks[taskId].setting.user_id || '');
            if (taskUser === userId && !keep.has(taskId)) {
              delete s.tasks[taskId];
              removed += 1;
            }
          });
        }
        let removedPlans = 0;
        if (hasPlans) {
          Object.keys(s.plans).forEach(planId => {
            const planUser = String(s.plans[planId] && s.plans[planId].user_id || '');
            if (planUser === userId && !keepPlans.has(planId)) {
              delete s.plans[planId];
              removedPlans += 1;
            }
          });
        }
        let removedMoments = 0;
        if (hasMomentIds) {
          Object.keys(s.moments || {}).forEach(characterId => {
            const momentUser = String(s.moments[characterId] && s.moments[characterId].user_id || '');
            if (momentUser === userId && !keepMoments.has(characterId)) {
              delete s.moments[characterId];
              removedMoments += 1;
            }
          });
        }
        if (removed || removedPlans || removedMoments) saveNow();
        /* Arming is intentionally last and process-local: a failed reconcile never enables scheduling. */
        armedUsers.add(userId);
        json(response, 200, { ok: true, removed, removed_plans: removedPlans, removed_moments: removedMoments, armed: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
        const events = Object.values(s.events)
          .filter(event => !event.acknowledged && recordUserId(event) === userId)
          .sort((a, b) => Number(a.sent_at || 0) - Number(b.sent_at || 0))
          .slice(0, limit);
        json(response, 200, { events });
        return;
      }
      if (request.method === 'POST' && parts[0] === 'events' && parts[1] && parts[2] === 'ack') {
        const eventId = decodeURIComponent(parts[1]);
        const body = await readBody(request);
        const userId = String(body && body.user_id || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        const event = s.events[eventId];
        if (event && recordUserId(event) !== userId) {
          json(response, 403, { error: 'Event does not belong to this user' });
          return;
        }
        if (event) {
          const acknowledgedAt = Date.now();
          event.acknowledged = true;
          event.acknowledged_at = acknowledgedAt;
          if (event.run_id && s.history[event.run_id] && recordUserId(s.history[event.run_id]) === userId) {
            s.history[event.run_id] = {
              ...s.history[event.run_id],
              acknowledged: true,
              acknowledged_at: acknowledgedAt
            };
          }
          delete s.events[eventId];
          queueSave();
        }
        json(response, 200, { ok: true, missing: !event });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/history') {
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        const history = Object.values(s.history)
          .filter(item => recordUserId(item) === userId)
          .sort((a, b) => Number(b.sent_at || b.started_at || 0) - Number(a.sent_at || a.started_at || 0))
          .slice(0, 200)
          .map(item => ({ ...item, reasoning_content: item.reasoning_content ? '[stored]' : '' }));
        json(response, 200, { history });
        return;
      }
      if (request.method === 'DELETE' && url.pathname === '/history') {
        const userId = String(url.searchParams.get('user_id') || '');
        if (!userId) {
          json(response, 400, { error: 'user_id is required' });
          return;
        }
        const removable = new Set();
        let removedHistory = 0;
        Object.keys(s.history).forEach(historyId => {
          const item = s.history[historyId];
          if (recordUserId(item) !== userId || item.status === 'processing') return;
          removable.add(historyId);
          delete s.history[historyId];
          removedHistory += 1;
        });
        let removedEvents = 0;
        Object.keys(s.events).forEach(eventId => {
          const event = s.events[eventId];
          if (recordUserId(event) !== userId) return;
          /* Clearing delivery history also discards its queued delivery receipt, preventing it from reappearing. */
          if (event.acknowledged || removable.has(event.run_id)) {
            delete s.events[eventId];
            removedEvents += 1;
          }
        });
        if (removedHistory || removedEvents) saveNow();
        json(response, 200, { ok: true, removed_history: removedHistory, removed_events: removedEvents });
        return;
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      json(response, 500, { error: trimText(error && error.message || error, 1200) });
    }
  });

  return { server, originAllowed, applyCors, json, readBody, publicTask };
}

module.exports = createHttp;
