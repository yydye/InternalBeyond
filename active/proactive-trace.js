/* IB Active · Proactive Observability Trace (v1)
   --------------------------------------------------------------------
   在 Proactive Domain 记录的**零决策**执行 trace。仅当 IB_PROACTIVE_TRACE=on 时
   记录，否则全部 no-op（零行为差异）。Debug Console 通过 /proactive/traces 消费。

   用途：让 Proactive 从“能跑”变成“能解释自己为什么这样跑”。纯观察器，
   不参与 scheduler / DND / dedup / fallback 的任何决策，不改任何返回值。

   硬约束：
   - 永不保存 API key / 完整 prompt / 完整上下文 / 完整消息正文；
   - 只保存白名单字段，字符串一律截断；
   - 内存环型缓冲（默认 50 条），不落盘、不跨进程；
   - 默认关闭（enabled=false 时 begin 返回 null，append/set/finish/recent 全部无副作用）。
   -------------------------------------------------------------------- */
'use strict';

function redact(value, limit) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').slice(0, limit);
}

/* 白名单字段：只有这些会进入 trace；密钥命名的一律丢弃 */
const META_FIELDS = new Set([
  'kind', 'trigger', 'triggerReason', 'planId', 'taskId',
  'characterId', 'characterName', 'provider', 'model',
  'intent', 'reason', 'scheduledFor', 'settings', 'context',
  'evalAction', 'evalReason', 'outcome', 'errorType',
  'compatRetry', 'compatRetryKind', 'dedup', 'fallback',
  'generationAttempts', 'sentMessageId', 'sentAt', 'validation',
  'laterOutcome', 'laterOutcomeAt'
]);

function sanitizeValue(field, value) {
  if (value == null) return null;
  if (field === 'validation') {
    /* validation 只保留 {ok, reason}，reason 截断 */
    return (value && typeof value === 'object') ? { ok: !!value.ok, reason: redact(value.reason, 160) } : null;
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'object') {
    /* 对象/数组序列化成紧凑字符串后截断，避免存入裸对象 */
    try { return redact(JSON.stringify(value), 200); } catch (_) { return redact(String(value), 200); }
  }
  return redact(value, 200);
}

function sanitizeMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const key of Object.keys(meta)) {
    if (!META_FIELDS.has(key)) continue;
    if (/key|token|secret|authorization|password|credential|apikey|api_key/i.test(key)) continue;
    const v = sanitizeValue(key, meta[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

function createProactiveTrace(deps) {
  deps = deps || {};
  const enabled = !!deps.enabled;
  const limit = Math.max(1, Number(deps.limit) || 50);
  const buffer = [];      /* 已完结 trace（ring buffer，新→旧） */
  const active = {};      /* traceId -> 进行中记录 */

  function nextTraceId() {
    return 'pt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /* begin(meta) -> traceId | null' */
  function begin(meta) {
    if (!enabled) return null;
    const traceId = (meta && typeof meta.traceId === 'string' && meta.traceId) || nextTraceId();
    active[traceId] = {
      traceId,
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      outcome: 'running',
      errorType: '',
      steps: [],
      ...sanitizeMeta(meta)
    };
    return traceId;
  }

  /* set(traceId, fields)：把聚合字段（compatRetry/validation/dedup/fallback 等）写进当前记录 */
  function set(traceId, fields) {
    if (!enabled || !traceId || !active[traceId]) return;
    const merged = sanitizeMeta(fields || {});
    const rec = active[traceId];
    for (const k of Object.keys(merged)) rec[k] = merged[k];
  }

  /* append(traceId, stage, ok, kind, detail)：追加一个时间线步骤 */
  function append(traceId, stage, ok, kind, detail) {
    if (!enabled || !traceId || !active[traceId]) return;
    active[traceId].steps.push({
      stage: redact(stage, 40),
      ts: Date.now(),
      ok: !!ok,
      kind: redact(kind || '', 24),
      detail: redact(detail || '', 200)
    });
  }

  /* finish(traceId, outcome, meta)：完结并推入 ring buffer */
  function finish(traceId, outcome, meta) {
    if (!enabled || !traceId || !active[traceId]) return null;
    const rec = active[traceId];
    const now = Date.now();
    rec.finishedAt = now;
    rec.durationMs = now - rec.startedAt;
    if (outcome != null) rec.outcome = redact(outcome, 24);
    Object.assign(rec, sanitizeMeta(meta || {}));
    delete active[traceId];
    buffer.push(rec);
    if (buffer.length > limit) buffer.shift();
    return rec;
  }

  /* recent(n)：返回最近 n 条已完结 trace 的脱敏深拷贝（新→旧） */
  function recent(n) {
    if (!enabled) return [];
    const take = Math.max(1, Math.min(limit, Number(n) || 50));
    return JSON.parse(JSON.stringify(buffer.slice(-take).reverse()));
  }

  function isEnabled() { return enabled; }
  function count() { return buffer.length; }
  function reset() { buffer.length = 0; for (const k in active) delete active[k]; }

  /* Phase 4 — Outcome observation（record-only，绝不反哺决策）。
     把「已发送」之后的后续结果（replied / ignored / dismissed / continued…）挂到
     一条已完结 trace 上。依赖调用方提供**可靠**的 traceId 关联；找不到（已从
     ring buffer 淘汰或未知）时返回 null，绝不伪造 outcome。
     注意：当前 companion 服务不实时观测用户回复，因此下列 outcome 在 v1 无可靠来源：
       replied / ignored / dismissed / continued —— 需浏览器端真实回复信号，本阶段仅预留接口。 */
  function observeOutcome(traceId, outcome, meta) {
    if (!enabled || !traceId) return null;
    let rec = null;
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      if (buffer[i].traceId === traceId) { rec = buffer[i]; break; }
    }
    if (!rec) return null;
    const merged = sanitizeMeta(Object.assign({ laterOutcome: outcome }, meta || {}));
    Object.assign(rec, merged);
    if (rec.laterOutcomeAt == null) rec.laterOutcomeAt = Date.now();
    return rec;
  }

  return { begin, set, append, finish, recent, enabled: isEnabled, count, reset, observeOutcome };
}

module.exports = createProactiveTrace;
