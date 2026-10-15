const RECORD_TYPE = 'plugin:internalbeyond/dsh-work-mode/run-event';
const MAX_EVENTS_PER_SNAPSHOT = 512;
const MAX_RESULT_SUMMARY = 1600;
const SESSION_ID_RE = /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/;
const RUN_ID_RE = /^wr_[A-Za-z0-9-]{36}$/;

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pluginRecords(session) {
  let events = [];
  try { events = session.snapshotEvents(); } catch (_) { /* invalid or closed session */ }
  return Array.isArray(events) ? events.filter(event => event && event.type === RECORD_TYPE && record(event.data)) : [];
}

function readRunContext(session, runId) {
  const events = pluginRecords(session);
  const seen = new Set();
  const calls = new Map();
  let maxTurn = -1;
  let runTurn = null;
  let childTurnOffset = null;
  let step = 0;
  let startedAt = 0;
  let lastAssistant = null;
  for (const event of session.snapshotEvents()) {
    if (event && (event.type === 'turn/start' || event.type === 'turn/end')
      && record(event.data) && nonNegativeInteger(event.data.turn) !== null) {
      maxTurn = Math.max(maxTurn, Number(event.data.turn));
    }
    if (!event || event.type !== RECORD_TYPE || !record(event.data)) continue;
    const data = event.data;
    if (nonNegativeInteger(data.turn) !== null) maxTurn = Math.max(maxTurn, Number(data.turn));
    if (data.runId !== runId) continue;
    if (typeof data.sourceSequence === 'string') seen.add(data.sourceSequence);
    if (nonNegativeInteger(data.turn) !== null) {
      if (runTurn === null) runTurn = Number(data.turn);
      maxTurn = Math.max(maxTurn, Number(data.turn));
    }
    if (data.sourceTurn !== undefined && nonNegativeInteger(data.sourceTurn) !== null
      && nonNegativeInteger(data.turn) !== null && childTurnOffset === null) {
      childTurnOffset = Number(data.turn) - Number(data.sourceTurn);
    }
    if (data.phase === 'running' && nonNegativeInteger(data.at) !== null) startedAt = Number(data.at);
    if (data.phase === 'running' && nonNegativeInteger(data.step) !== null) step = Number(data.step);
    if (data.kind === 'tool-call' && typeof (data.sourceCallId || data.callId) === 'string') {
      calls.set(String(data.sourceCallId || data.callId), data);
    }
    if (data.kind === 'tool-result' && typeof data.sourceCallId === 'string' && !calls.has(data.sourceCallId)) {
      calls.set(data.sourceCallId, data);
    }
    if (data.kind === 'assistant-metadata') lastAssistant = data;
  }
  const turn = runTurn === null ? maxTurn + 1 : runTurn;
  return { seen, calls, turn: Math.max(0, turn), childTurnOffset, step, startedAt, lastAssistant };
}

function normalizedEvent(item, runId, context, provider, model) {
  if (!record(item) || String(item.runId || '') !== runId || item.event !== 'dsh-session-event'
    || typeof item.sequence !== 'string' || !record(item.dshEvent)) return null;
  const source = item.dshEvent;
  const type = boundedString(source.type, 40);
  const data = record(source.data) ? source.data : null;
  const sourceTime = nonNegativeInteger(source.time);
  if (!data || sourceTime === null) return null;
  const sourceTurn = nonNegativeInteger(data.turn);
  const sourceStep = nonNegativeInteger(data.step);
  if (sourceTurn !== null && context.childTurnOffset === null) context.childTurnOffset = context.turn - sourceTurn;
  const turn = sourceTurn === null ? context.turn : Math.max(0, sourceTurn + (context.childTurnOffset || 0));
  const step = sourceStep === null ? context.step : sourceStep;
  const base = {
    schemaVersion: 1,
    kind: 'session-event',
    runId,
    sourceSequence: item.sequence,
    sourceEventType: type,
    sourceTime,
    ...(sourceTurn === null ? {} : { sourceTurn }),
    turn,
    step,
    provider: boundedString(provider || source.provider, 120),
    model: boundedString(model || source.model, 160)
  };

  if (type === 'turn/start') {
    context.turn = turn;
    context.step = 0;
    return base;
  }
  if (type === 'step/start') {
    context.turn = turn;
    context.step = step;
    return base;
  }
  if (type === 'step/end') return base;
  if (type === 'turn/end') {
    const reason = record(data.reason) ? data.reason : {};
    const failure = record(reason.error) ? reason.error : {};
    return Object.assign(base, {
      reasonKind: boundedString(reason.kind, 24),
      ...(typeof failure.code === 'string' ? { errorCode: failure.code.slice(0, 80) } : {})
    });
  }
  if (type === 'request/header') {
    context.turn = turn;
    context.step = step;
    return Object.assign(base, { kind: 'request-header' });
  }
  if (type === 'tool/call') {
    const callId = boundedString(data.callId, 180);
    const name = boundedString(data.name, 120);
    let args = {};
    try { args = JSON.parse(String(data.arguments || '{}')); } catch (_) { return null; }
    if (!callId || !name || !record(args)) return null;
    const storedCallId = runId + ':' + callId;
    const call = Object.assign(base, { kind: 'tool-call', sourceCallId: callId,
      callId: storedCallId, name: name, arguments: JSON.stringify(args) });
    context.calls.set(callId, call);
    context.step = step;
    return call;
  }
  if (type === 'tool/result') {
    const message = record(data.message) ? data.message : {};
    const sourceRef = record(message.source) ? message.source : {};
    const sourceCallId = boundedString(sourceRef.callId, 180);
    if (!sourceCallId) return null;
    const prior = context.calls.get(sourceCallId);
    const content = Array.isArray(message.content) ? message.content.flatMap(block => {
      if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') return [];
      return [{ type: 'text', text: block.text.slice(0, 4000) }];
    }).slice(0, 4) : [];
    const error = record(data.error) ? data.error : {};
    return Object.assign(base, { kind: 'tool-result', sourceCallId,
      callId: runId + ':' + sourceCallId, name: boundedString(prior && prior.name, 120),
      arguments: boundedString(prior && prior.arguments, 3000), callTime: nonNegativeInteger(prior && prior.sourceTime),
      content, isError: message.isError === true,
      ...(typeof error.code === 'string' ? { errorCode: error.code.slice(0, 80) } : {}) });
  }
  if (type === 'assistant/message') {
    const usage = record(data.usage) ? data.usage : {};
    const safeUsage = {};
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (nonNegativeInteger(usage[key]) !== null) safeUsage[key] = Number(usage[key]);
    }
    const assistant = Object.assign(base, { kind: 'assistant-metadata',
      stepStartTime: nonNegativeInteger(data.stepStartTime), firstTokenTime: nonNegativeInteger(data.firstTokenTime),
      usage: safeUsage });
    context.lastAssistant = assistant;
    return assistant;
  }
  return null;
}

/** Append a bounded Home Node/DSH trace snapshot into one exact DSH Session. */
export function appendWorkModeTraceSnapshot(options) {
  const session = options && options.session;
  const appendRecord = options && options.appendRecord;
  const appendUserMessage = options && options.appendUserMessage;
  const runId = String(options && options.runId || '');
  if (!session || typeof appendRecord !== 'function' || !RUN_ID_RE.test(runId)) {
    return { ok: false, error: 'invalid-trace-binding' };
  }
  const inputEvents = Array.isArray(options.events) ? options.events.slice(-MAX_EVENTS_PER_SNAPSHOT) : [];
  const provider = boundedString(options.provider, 120);
  const model = boundedString(options.model, 160);
  const promptSummary = boundedString(options.promptSummary, 2400);
  const phase = ['running', 'completed', 'failed', 'cancelled'].includes(String(options.phase))
    ? String(options.phase) : '';
  if (!phase) return { ok: false, error: 'invalid-trace-phase' };
  const context = readRunContext(session, runId);
  const recordOne = (data) => appendRecord(session, RECORD_TYPE, data);
  const at = Number.isSafeInteger(options.at) && options.at >= 0 ? options.at : Date.now();
  if (promptSummary && typeof appendUserMessage === 'function') {
    const hasPrompt = session.snapshotEvents().some(event => event && event.type === 'user/message'
      && record(event.data) && record(event.data.source) && event.data.source.kind === 'user'
      && String(event.data.source.rpcId || '') === runId);
    if (!hasPrompt) {
      const events = session.snapshotEvents();
      if (!events.some(event => event && event.type === 'turn/start'
        && record(event.data) && Number(event.data.turn) === context.turn)) {
        session.append('turn/start', { turn: context.turn });
      }
      appendUserMessage(session, { runId: runId, turn: context.turn, prompt: promptSummary });
    }
  }
  const runningKey = 'status:running';
  if (!context.seen.has(runningKey)) {
    recordOne({ schemaVersion: 1, kind: 'run-state', runId, sourceSequence: runningKey,
      phase: 'running', at: at, turn: context.turn, step: context.step, provider, model });
    context.seen.add(runningKey);
    context.startedAt = at;
  }

  let imported = 0;
  for (const item of inputEvents) {
    if (!record(item) || typeof item.sequence !== 'string' || context.seen.has(item.sequence)) continue;
    const data = normalizedEvent(item, runId, context, provider, model);
    if (!data) continue;
    recordOne(data);
    context.seen.add(item.sequence);
    imported++;
  }

  if (phase !== 'running') {
    const terminalKey = 'status:' + phase;
    if (!context.seen.has(terminalKey)) {
      const summary = phase === 'completed' ? boundedString(options.summary, MAX_RESULT_SUMMARY) : '';
      const errorCodeCandidate = boundedString(options.errorCode, 80);
      const errorCode = /^[A-Za-z0-9_.:-]+$/.test(errorCodeCandidate) ? errorCodeCandidate : '';
      const endedAt = at;
      const durationMs = context.startedAt > 0 ? Math.max(0, endedAt - context.startedAt) : 0;
      recordOne({ schemaVersion: 1, kind: 'run-state', runId, sourceSequence: terminalKey,
        phase, at: endedAt, turn: context.turn, step: context.step,
        provider, model, durationMs,
        ...(summary ? { summary } : {}), ...(errorCode ? { errorCode } : {}),
        ...(context.lastAssistant ? {
          assistantTime: context.lastAssistant.sourceTime,
          stepStartTime: context.lastAssistant.stepStartTime,
          firstTokenTime: context.lastAssistant.firstTokenTime,
          usage: context.lastAssistant.usage
        } : {}) });
      context.seen.add(terminalKey);
      imported++;
    }
    const sessionEvents = session.snapshotEvents();
    if (!sessionEvents.some(event => event && event.type === 'turn/end'
      && record(event.data) && Number(event.data.turn) === context.turn)) {
      const reason = phase === 'completed' ? { kind: 'completed' }
        : phase === 'cancelled' ? { kind: 'aborted', reason: { kind: 'user' } }
          : { kind: 'error', error: { code: boundedString(options.errorCode, 80) || 'HOME_NODE_FAILED', message: 'Home Node Run failed.' } };
      session.append('turn/end', { turn: context.turn, reason });
    }
  }
  return { ok: true, imported, terminal: phase !== 'running' };
}

/** Persist a submitted DSH composer task into its exact Session before Consent.
 * This is a local user message; it creates no Home Node authorization or Provider request. */
export function appendWorkModeUserMessage(options) {
  const session = options && options.session;
  const appendUserMessage = options && options.appendUserMessage;
  const runId = String(options && options.runId || '');
  const prompt = boundedString(options && options.prompt, 2400);
  if (!session || typeof appendUserMessage !== 'function' || !RUN_ID_RE.test(runId) || !prompt
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) return { ok: false, error: 'invalid-task-message' };
  const events = session.snapshotEvents();
  const exists = events.some(event => event && event.type === 'user/message'
    && record(event.data) && record(event.data.source) && event.data.source.kind === 'user'
    && String(event.data.source.rpcId || '') === runId);
  if (exists) return { ok: true, duplicate: true };
  const context = readRunContext(session, runId);
  if (!events.some(event => event && event.type === 'turn/start'
    && record(event.data) && Number(event.data.turn) === context.turn)) {
    session.append('turn/start', { turn: context.turn });
  }
  const appended = appendUserMessage(session, { runId: runId, turn: context.turn, prompt: prompt });
  return appended === true ? { ok: true, duplicate: false } : { ok: false, error: 'task-message-append-failed' };
}

export { RECORD_TYPE as WORK_MODE_TRACE_RECORD_TYPE, SESSION_ID_RE, RUN_ID_RE };
