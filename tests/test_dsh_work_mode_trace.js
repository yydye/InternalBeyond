'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { appendWorkModeTraceSnapshot, WORK_MODE_TRACE_RECORD_TYPE } = require('../runtime/dsh-native-ui-p0/work-mode-trace-host.mjs');

function createSession() {
  const events = [];
  return {
    events,
    snapshotEvents() { return events.slice(); },
    append(type, data, metadata) {
      const event = Object.assign({ type, seq: events.length, time: Date.now(), data: structuredClone(data) }, metadata || {});
      events.push(event);
      return event;
    }
  };
}

function appendRecord(session, type, data) {
  const event = { type, ignorable: true, seq: session.events.length, time: Date.now(), data: structuredClone(data) };
  session.events.push(event);
  return event.seq;
}

function dshEvent(runId, sequence, type, time, data) {
  return { runId, sequence, event: 'dsh-session-event', dshEvent: { type, seq: sequence, time, data } };
}

test('DSH work trace is session-scoped, sanitized, idempotent, and recoverable', () => {
  const session = createSession();
  const runId = 'wr_12345678-1234-4234-9234-123456789abc';
  const start = appendWorkModeTraceSnapshot({ session, appendRecord, runId, phase: 'running', at: 1000,
    provider: 'openai', model: 'synthetic-model', promptSummary: 'Audit the selected synthetic file.', events: [],
    appendUserMessage(target, input) {
      const message = { id: 'msg-' + input.runId, role: 'user', content: [{ type: 'text', text: input.prompt }],
        source: { kind: 'user', rpcId: input.runId } };
      target.append('user/message', message, { surfaceOp: 'append' });
    } });
  assert.deepEqual(start, { ok: true, imported: 0, terminal: false });
  assert.ok(session.events.some(event => event.type === 'turn/start' && event.data.turn === 0));
  assert.ok(session.events.some(event => event.type === 'user/message'
    && event.data.source.rpcId === runId && event.surfaceOp === 'append'));
  const turnStartIndex = session.events.findIndex(event => event.type === 'turn/start' && event.data.turn === 0);
  const promptIndex = session.events.findIndex(event => event.type === 'user/message' && event.data.source.rpcId === runId);
  const runningIndex = session.events.findIndex(event => event.type === WORK_MODE_TRACE_RECORD_TYPE
    && event.data.runId === runId && event.data.phase === 'running');
  assert.ok(turnStartIndex < promptIndex && promptIndex < runningIndex,
    'the native Session opens the turn and records the user task before its live Home Node status');

  const events = [
    dshEvent(runId, 'd1', 'turn/start', 1010, { turn: 0 }),
    dshEvent(runId, 'd2', 'step/start', 1020, { turn: 0, step: 1 }),
    dshEvent(runId, 'd3', 'request/header', 1025, { turn: 0, step: 1, reason: 'initial' }),
    { runId, sequence: 'd4', event: 'dsh-session-event', dshEvent: { type: 'tool/call', seq: 3, time: 1040,
      provider: 'openai', model: 'synthetic-model', data: { turn: 0, step: 1, callId: 'call-1', name: 'app_draft.update_file',
        arguments: JSON.stringify({ path: 'styles.css', content: '[内容已隐藏]' }) } } },
    { runId, sequence: 'd5', event: 'dsh-session-event', dshEvent: { type: 'tool/result', seq: 4, time: 1250,
      provider: 'openai', model: 'synthetic-model', data: { turn: 0, step: 1, message: { source: { callId: 'call-1' },
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', path: 'styles.css', version: 2, content: '[内容已隐藏]' }) }],
        isError: false } } } },
    { runId, sequence: 'd6', event: 'dsh-session-event', dshEvent: { type: 'assistant/message', seq: 5, time: 1300,
      data: { turn: 0, step: 1, stepStartTime: 1020, firstTokenTime: 1090,
        usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 2 }, content: 'must not be copied' } } }
  ];
  const live = appendWorkModeTraceSnapshot({ session, appendRecord, runId, phase: 'running', at: 1400,
    provider: 'openai', model: 'synthetic-model', events });
  assert.equal(live.imported, 6);
  const runRecords = session.events.filter(event => event.type === WORK_MODE_TRACE_RECORD_TYPE && event.data.runId === runId);
  assert.deepEqual(runRecords.map(event => event.data.kind), [
    'run-state', 'session-event', 'session-event', 'request-header', 'tool-call', 'tool-result', 'assistant-metadata'
  ]);
  const running = runRecords.find(event => event.data.kind === 'run-state').data;
  assert.equal(running.phase, 'running');
  assert.equal(running.provider, 'openai');
  assert.equal(running.model, 'synthetic-model');
  const toolCall = runRecords.find(event => event.data.kind === 'tool-call').data;
  assert.equal(toolCall.turn, 0);
  assert.deepEqual(JSON.parse(toolCall.arguments), { path: 'styles.css', content: '[内容已隐藏]' });
  const toolResult = runRecords.find(event => event.data.kind === 'tool-result').data;
  assert.equal(toolResult.callTime, 1040);
  assert.equal(toolResult.sourceTime, 1250);
  assert.match(toolResult.content[0].text, /"version":2/);
  assert.doesNotMatch(toolResult.content[0].text, /must not be copied|source text/i);
  assert.equal(runRecords.find(event => event.data.kind === 'assistant-metadata').data.usage.outputTokens, 8);

  const duplicate = appendWorkModeTraceSnapshot({ session, appendRecord, runId, phase: 'running', at: 1450,
    provider: 'openai', model: 'synthetic-model', promptSummary: 'Audit the selected synthetic file.', events,
    appendUserMessage() { throw new Error('the same Run prompt must not append twice'); } });
  assert.equal(duplicate.imported, 0);
  const completed = appendWorkModeTraceSnapshot({ session, appendRecord, runId, phase: 'completed', at: 1500,
    provider: 'openai', model: 'synthetic-model', summary: 'Styles updated.', events });
  assert.equal(completed.terminal, true);
  const terminal = session.events.find(event => event.type === WORK_MODE_TRACE_RECORD_TYPE
    && event.data.runId === runId && event.data.phase === 'completed').data;
  assert.equal(terminal.durationMs, 500);
  assert.equal(terminal.summary, 'Styles updated.');
  assert.equal(terminal.stepStartTime, 1020);
  assert.equal(terminal.firstTokenTime, 1090);

  const nextRun = 'wr_abcdefab-1234-4234-9234-abcdefabcdef';
  appendWorkModeTraceSnapshot({ session, appendRecord, runId: nextRun, phase: 'running', at: 2000, events: [] });
  const next = appendWorkModeTraceSnapshot({ session, appendRecord, runId: nextRun, phase: 'cancelled', at: 2200,
    errorCode: '', events: [] });
  assert.equal(next.terminal, true);
  const nextState = session.events.find(event => event.type === WORK_MODE_TRACE_RECORD_TYPE
    && event.data.runId === nextRun && event.data.phase === 'cancelled').data;
  assert.equal(nextState.turn, 1, 'continuous Runs occupy new turns in the same DSH Session');

  const otherSession = createSession();
  appendWorkModeTraceSnapshot({ session: otherSession, appendRecord, runId, phase: 'running', at: 3000, events: [] });
  assert.equal(otherSession.events.filter(event => event.type === WORK_MODE_TRACE_RECORD_TYPE && event.data.runId === runId).length, 1);
});

test('failed DSH Run exposes only a stable Home Node failure code', () => {
  const session = createSession();
  const runId = 'wr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  appendWorkModeTraceSnapshot({ session, appendRecord, runId, phase: 'running', at: 100, events: [] });
  appendWorkModeTraceSnapshot({ session, appendRecord, runId, phase: 'failed', at: 210,
    errorCode: 'CONSENT_DENIED', events: [] });
  const failed = session.events.find(event => event.type === WORK_MODE_TRACE_RECORD_TYPE
    && event.data.runId === runId && event.data.phase === 'failed').data;
  assert.equal(failed.errorCode, 'CONSENT_DENIED');
  assert.equal(Object.hasOwn(failed, 'error'), false, 'raw provider or tool errors are not copied to the trace');
});
