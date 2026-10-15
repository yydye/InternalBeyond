'use strict';

/*
 * Opt-in Home Node host for the pinned DeepSeek Harness ACP backend.
 *
 * This module is deliberately not wired into the default Home Node assembly.
 * The caller supplies the canonical Work Run store, Home Node registry,
 * request-scoped credential access, NodeModelPort, Workspace Project Tool
 * composition, and a pinned DSH launcher. Nothing is read from DSH provider
 * settings, and the DSH process receives only a loopback RPC capability.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const createNodeModelPort = require('../../active/node-model-port.js');
const workModeConsentCore = require('../../assets/js/work-mode-consent-core.js');
const providerRouteCore = require('../../assets/js/work-mode-provider-route.js');
const workModeExecutor = require('../../assets/js/work-mode-executor.js');
const actionRegistryCore = require('../../assets/js/action-registry.js');
const projectInspect = require('../../assets/js/work-mode-project-inspect.js');
const workspaceChangeContract = require('../../assets/js/workspace-change-contract.js');

const DSH_REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const WORKFLOW_ID = 'project.audit.readonly';
const APP_BUILDER_WORKFLOW_ID = 'app.builder';
const CODING_WORKFLOW_ID = 'coding.workspace';
const CODING_TOOLS = Object.freeze(['project.read_file', 'project.create_file', 'project.update_file']);
const APP_DRAFT_TOOL_LIMIT = 20;
const PROJECT_WRITE_TOOL_LIMIT = 12;
const MAX_RPC_BODY_BYTES = 128 * 1024;
const MAX_MESSAGES = 80;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_PROGRESS_EVENTS_PER_RUN = 512;
const MAX_PROGRESS_RUNS = 100;
const PROGRESS_RETENTION_MS = 24 * 60 * 60 * 1000;
const ACP_METHOD = Object.freeze({
  INITIALIZE: 'initialize',
  NEW_SESSION: 'session/new',
  PROMPT: 'session/prompt',
  CANCEL: 'session/cancel',
  CLOSE: 'session/close',
  UPDATE: 'session/update',
  PERMISSION: 'session/request_permission'
});

class HostAdapterError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HostAdapterError';
    this.code = code;
  }
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameRoute(left, right) {
  if (!left || !right) return false;
  return left.providerRef === right.providerRef
    && left.provider === right.provider
    && left.model === right.model
    && left.endpoint === right.endpoint
    && left.credentialRef === right.credentialRef;
}

function routeFromSpec(providerRef, spec) {
  if (!record(spec)) throw new HostAdapterError('provider-route-unavailable');
  const route = providerRouteCore.normalize(Object.assign({}, spec, {
    id: String(providerRef || ''),
    credentialRef: String(spec.credentialRef || providerRef || '')
  }));
  if (!route) throw new HostAdapterError('provider-route-incomplete');
  if (Object.prototype.hasOwnProperty.call(spec, 'apiKey') && String(spec.apiKey || '').trim()) {
    throw new HostAdapterError('provider-route-plaintext-credential-denied');
  }
  return route;
}

function apiScope(route, destination) {
  return workModeConsentCore.providerScope(
    destination,
    route.providerRef,
    { provider: route.provider, model: route.model, endpoint: route.endpoint },
    crypto.webcrypto
  );
}

function makeRequestId(prefix) {
  return String(prefix || 'dsh') + '-' + crypto.randomUUID();
}

function writeJson(res, status, body) {
  if (res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text, 'utf8')
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_RPC_BODY_BYTES) {
        reject(new HostAdapterError('model-request-too-large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new HostAdapterError('invalid-model-request')); }
    });
    req.on('error', () => reject(new HostAdapterError('model-request-disconnected')));
  });
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) throw new HostAdapterError('invalid-model-messages');
  let totalBytes = 0;
  return value.map(message => {
    if (!record(message) || Object.keys(message).some(key => key !== 'role' && key !== 'content')
      || typeof message.role !== 'string' || typeof message.content !== 'string'
      || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw new HostAdapterError('invalid-model-message');
    }
    const size = Buffer.byteLength(message.content, 'utf8');
    totalBytes += size;
    if (size > MAX_MESSAGE_BYTES || totalBytes > MAX_RPC_BODY_BYTES) throw new HostAdapterError('model-request-too-large');
    return { role: message.role, content: message.content };
  });
}

const DSH_TRACE_EVENT_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'request/header',
  'tool/call', 'tool/result', 'assistant/message'
]);

function normalizeDshTraceEvent(value) {
  if (!record(value) || Object.keys(value).some(key => !['type', 'seq', 'time', 'data'].includes(key))) return null;
  const type = String(value.type || '');
  const data = value.data;
  if (!DSH_TRACE_EVENT_TYPES.has(type) || !record(data)
    || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0
    || !Number.isSafeInteger(value.time) || Number(value.time) < 0) return null;
  const turn = Number.isSafeInteger(data.turn) && Number(data.turn) >= 0 ? Number(data.turn) : null;
  const step = Number.isSafeInteger(data.step) && Number(data.step) >= 0 ? Number(data.step) : null;
  if (turn === null && type !== 'request/header') return null;
  const normalized = { turn: turn === null ? 0 : turn };
  if (step !== null) normalized.step = step;
  if (type === 'turn/end') {
    const reason = record(data.reason) ? data.reason : null;
    const kind = String(reason && reason.kind || 'error').slice(0, 24);
    normalized.reason = { kind: kind };
    if (kind === 'error') {
      const failure = record(reason.error) ? reason.error : {};
      const code = String(failure.code || 'UNKNOWN').slice(0, 80);
      normalized.reason.error = { code: code, message: code === 'AUTH'
        ? '模型认证失败；详细信息已隐藏。' : 'DSH 执行未完成。' };
    }
  } else if (type === 'request/header') {
    normalized.reason = ['initial', 'resume', 'change', 'series'].includes(String(data.reason)) ? String(data.reason) : 'initial';
  } else if (type === 'tool/call') {
    const name = String(data.name || '').slice(0, 120);
    const callId = String(data.callId || '').slice(0, 180);
    const args = String(data.arguments || '{}');
    if (!name || !callId || Buffer.byteLength(args, 'utf8') > 3000) return null;
    let parsed;
    try { parsed = JSON.parse(args); } catch (_) { return null; }
    if (!record(parsed)) return null;
    normalized.name = name;
    normalized.callId = callId;
    normalized.arguments = JSON.stringify(parsed);
  } else if (type === 'tool/result') {
    const message = record(data.message) ? data.message : null;
    const source = message && record(message.source) ? message.source : null;
    const callId = String(source && source.callId || '').slice(0, 180);
    const content = message && Array.isArray(message.content) ? message.content : [];
    if (!callId || content.length > 4) return null;
    const safeContent = content.flatMap(block => {
      if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') return [];
      return [{ type: 'text', text: block.text.slice(0, 4000) }];
    });
    normalized.message = { source: { callId: callId }, content: safeContent,
      isError: message.isError === true };
    if (record(data.error)) {
      normalized.error = { code: String(data.error.code || 'UNKNOWN').slice(0, 80),
        message: String(data.error.code || '') === 'AUTH' ? '工具认证失败；详细信息已隐藏。' : '工具执行未完成。' };
    }
  } else if (type === 'assistant/message') {
    const usage = record(data.usage) ? data.usage : null;
    if (usage) {
      normalized.usage = {};
      for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        if (Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0) normalized.usage[key] = Number(usage[key]);
      }
    }
    if (Number.isSafeInteger(data.firstTokenTime) && Number(data.firstTokenTime) >= 0) {
      normalized.firstTokenTime = Number(data.firstTokenTime);
    }
    if (Number.isSafeInteger(data.stepStartTime) && Number(data.stepStartTime) >= 0) {
      normalized.stepStartTime = Number(data.stepStartTime);
    }
    if (data.interrupted === true) normalized.interrupted = true;
  }
  return { type: type, seq: Number(value.seq), time: Number(value.time), data: normalized };
}

function constantTimeBearerMatches(header, token) {
  const supplied = String(header || '').replace(/^Bearer\s+/i, '');
  const expectedBuffer = Buffer.from(String(token || ''), 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function createAcpClient(child, onUpdate) {
  let sequence = 0;
  let buffer = '';
  let closedError = null;
  const pending = new Map();

  function failPending(error) {
    if (closedError) return;
    closedError = error instanceof Error ? error : new Error(String(error || 'ACP child closed'));
    for (const request of pending.values()) request.reject(closedError);
    pending.clear();
  }

  function send(value) {
    if (closedError || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw closedError || new HostAdapterError('acp-child-not-writable');
    }
    const json = JSON.stringify(value) + '\n';
    child.stdin.write(json, error => {
      if (error) failPending(error);
    });
  }

  function respond(id, result) {
    try { send({ jsonrpc: '2.0', id: id, result: result }); }
    catch (_) { /* the request's owning process is already closing */ }
  }

  function dispatch(message) {
    if (!record(message) || message.jsonrpc !== '2.0') {
      failPending(new HostAdapterError('invalid-acp-frame'));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'method')) {
      if (message.method === ACP_METHOD.UPDATE && record(message.params)) {
        try { onUpdate(message.params); } catch (_) { /* observers are not authority */ }
        return;
      }
      if (message.method === ACP_METHOD.PERMISSION) {
        respond(message.id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      if (message.id !== undefined) {
        try {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Host method is not available' } });
        } catch (_) { /* child is closing */ }
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (record(message.error)) {
      request.reject(new HostAdapterError('acp-request-failed', String(message.error.message || 'ACP request failed')));
    } else request.resolve(message.result);
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_RPC_BODY_BYTES * 2 && !buffer.includes('\n')) {
      failPending(new HostAdapterError('acp-frame-too-large'));
      try { child.kill(); } catch (_) { /* best-effort child cleanup */ }
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try { dispatch(JSON.parse(line)); }
        catch (_) { failPending(new HostAdapterError('invalid-acp-json')); }
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stdout.on('error', error => failPending(error));
  child.stdin.on('error', error => failPending(error));
  child.once('error', error => failPending(error));
  child.once('close', (code, signal) => {
    failPending(new HostAdapterError('acp-child-exited', `ACP child exited (${String(code)} ${String(signal || '')})`));
  });

  return {
    request(method, params) {
      if (closedError) return Promise.reject(closedError);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { send({ jsonrpc: '2.0', id: id, method: method, params: params }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method: method, params: params });
    },
    fail(error) { failPending(error); }
  };
}

function createDshHostAdapter(options) {
  options = options || {};
  const enabled = options.enabled === true;
  const workRunStore = options.workRunStore || null;
  const appDraftStore = options.appDraftStore || null;
  const registry = options.registry || null;
  const actionRegistry = options.actionRegistry || actionRegistryCore.createRegistry();
  const credentialAccess = options.credentialAccess || null;
  const createProjectTool = options.createProjectTool || null;
  const modelPort = options.nodeModelPort || createNodeModelPort({});
  const dsh = options.dsh || {};
  const webUiHost = options.webUiHost || null;
  const spawn = options.spawn || nodeSpawn;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const protocolVersion = options.protocolVersion;
  const runtimeInstalled = typeof options.runtimeInstalled === 'function' ? options.runtimeInstalled : () => true;
  const runtimeInstallationStatus = typeof options.runtimeInstallationStatus === 'function'
    ? options.runtimeInstallationStatus : () => ({ phase: 'idle' });
  const active = new Map();
  const progress = new Map();
  const pendingProjectChanges = new Map();
  let runtimeUpgradeInProgress = false;

  function pruneProgress() {
    const at = Date.now();
    for (const [runId, item] of progress) {
      if (item.expiresAt <= at && !active.has(runId)) progress.delete(runId);
    }
    while (progress.size >= MAX_PROGRESS_RUNS) {
      let removed = false;
      for (const runId of progress.keys()) {
        if (active.has(runId)) continue;
        progress.delete(runId);
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }

  function emit(event, state, extra) {
    const eventData = Object.assign({ event: event, runId: state && state.runId || null, at: Date.now() }, extra || {});
    const runId = state && state.runId;
    if (runId) {
      let item = progress.get(runId);
      if (!item) {
        pruneProgress();
        item = { nextSequence: 1, events: [], expiresAt: Date.now() + PROGRESS_RETENTION_MS };
        progress.set(runId, item);
      }
      const safe = { sequence: item.nextSequence++, event: String(event), runId: runId, at: eventData.at };
      for (const key of ['call', 'fileId', 'path', 'toolName', 'code', 'reason', 'version', 'addedLines', 'removedLines']) {
        const value = eventData[key];
        if (typeof value === 'string' && value.length <= 400) safe[key] = value;
        else if (Number.isSafeInteger(value) && value >= 0) safe[key] = value;
      }
      if (record(eventData.dshEvent)) safe.dshEvent = eventData.dshEvent;
      item.events.push(safe);
      if (item.events.length > MAX_PROGRESS_EVENTS_PER_RUN) item.events.splice(0, item.events.length - MAX_PROGRESS_EVENTS_PER_RUN);
      item.expiresAt = Date.now() + PROGRESS_RETENTION_MS;
    }
    try {
      onEvent(eventData);
    } catch (_) { /* diagnostics never change authorization or execution */ }
  }

  function getEvents(runId) {
    pruneProgress();
    const item = progress.get(String(runId || ''));
    return item ? item.events.map(event => Object.assign({}, event)) : [];
  }

  function assertDependencies() {
    if (!enabled) throw new HostAdapterError('dsh-host-disabled');
    let installed = false;
    try { installed = runtimeInstalled() === true; } catch (_) { installed = false; }
    if (!installed) throw new HostAdapterError('dsh-runtime-not-installed');
    if (!workRunStore || !['getRun', 'getConsent', 'getDshSession', 'checkConsent', 'transition', 'cancel', 'completeRun'].every(name => typeof workRunStore[name] === 'function')) {
      throw new HostAdapterError('work-run-authority-unavailable');
    }
    if (!registry || typeof registry.getCharacterSpec !== 'function' || typeof registry.listCharacters !== 'function') {
      throw new HostAdapterError('provider-registry-unavailable');
    }
    if (!credentialAccess || typeof credentialAccess.resolve !== 'function') {
      throw new HostAdapterError('credential-access-unavailable');
    }
    if (typeof createProjectTool !== 'function') throw new HostAdapterError('workspace-project-tool-unavailable');
    if (!modelPort || typeof modelPort.run !== 'function') throw new HostAdapterError('node-model-port-unavailable');
    if (dsh.revision !== DSH_REVISION) throw new HostAdapterError('dsh-revision-mismatch');
    if (!dsh.nodeExe || !dsh.binScript || (!dsh.patch && !Array.isArray(dsh.patches)) || !dsh.repoRoot || !dsh.tsxLoader) {
      throw new HostAdapterError('dsh-launcher-incomplete');
    }
    if (!protocolVersion) throw new HostAdapterError('acp-protocol-version-missing');
  }

  function readRun(runId) {
    const result = workRunStore.getRun(runId);
    if (!result || result.ok !== true || !record(result.run)) throw new HostAdapterError(result && result.code || 'run-not-found');
    return result.run;
  }

  function readConsent(runId, consentId) {
    const result = workRunStore.getConsent(runId, consentId);
    if (!result || result.ok !== true || !record(result.consent)) throw new HostAdapterError(result && result.code || 'consent-not-found');
    return result.consent;
  }

  function assertSessionBinding(runId, sessionId, consentId) {
    if (!/^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/.test(String(sessionId || ''))) {
      throw new HostAdapterError('dsh-session-binding-required');
    }
    const result = workRunStore.getDshSession(sessionId, runId);
    if (!result || result.ok !== true || !record(result.binding)
      || result.binding.sessionId !== sessionId || result.binding.runId !== runId
      || result.binding.consentId !== consentId) throw new HostAdapterError('dsh-session-run-mismatch');
    return result.binding;
  }

  async function resolveProviderRoute(providerRef) {
    let spec = null;
    try { spec = registry.getCharacterSpec(providerRef); } catch (_) { /* fail closed below */ }
    const route = routeFromSpec(providerRef, spec);
    const scope = await apiScope(route, 'agent');
    if (!scope) throw new HostAdapterError('provider-route-invalid');
    return { route: route, scope: scope, spec: spec };
  }

  function validateRunConsent(run, consent, routeScope, expectedProjectRef, requestedFileIds) {
    if (![WORKFLOW_ID, APP_BUILDER_WORKFLOW_ID, CODING_WORKFLOW_ID].includes(run.workflowId) || run.projectRef !== expectedProjectRef) throw new HostAdapterError('run-scope-mismatch');
    if (run.workflowId === APP_BUILDER_WORKFLOW_ID
      && (run.executorSelection == null || run.executorSelection.presetId !== 'app-builder'
        || !run.appDraftRef || !Array.isArray(consent.fileIds) || consent.fileIds.length !== 0
        || consent.memoryScope != null || consent.memoryDerivedScope != null)) {
      throw new HostAdapterError('app-builder-consent-scope-invalid');
    }
    if (run.workflowId === CODING_WORKFLOW_ID
      && (run.executorSelection == null || run.executorSelection.presetId !== 'coding'
        || consent.workspaceWriteConfirmed !== true || !Array.isArray(consent.fileIds) || consent.fileIds.length === 0
        || consent.memoryScope != null || consent.memoryDerivedScope != null)) {
      throw new HostAdapterError('coding-consent-scope-invalid');
    }
    if (run.workflowId !== CODING_WORKFLOW_ID && consent.workspaceWriteConfirmed === true) {
      throw new HostAdapterError('unexpected-workspace-write-consent');
    }
    if (run.status !== 'queued' && run.status !== 'running') throw new HostAdapterError('run-not-active');
    if (consent.runId !== run.runId || consent.projectRef !== run.projectRef || consent.status !== 'active') {
      throw new HostAdapterError('consent-inactive');
    }
    const result = workRunStore.checkConsent({
      runId: run.runId,
      consentId: consent.consentId,
      projectRef: run.projectRef,
      providerScope: routeScope,
      fileIds: requestedFileIds || consent.fileIds,
      consumer: 'agent',
      memoryScope: consent.memoryScope == null ? null : consent.memoryScope
    });
    if (!result || result.ok !== true) throw new HostAdapterError(result && result.code || 'consent-denied');
    return result;
  }

  async function authorizedModelCall(state, messages, signal) {
    if (!state.sendingAllowed || state.cancelled) throw new HostAdapterError('execution-stopped');
    assertSessionBinding(state.runId, state.dshSessionId, state.consentId);
    emit('model-preflight', state, { call: state.modelCalls + 1 });

    let run = readRun(state.runId);
    if (run.status !== 'running') throw new HostAdapterError('run-not-running');
    let consent = readConsent(state.runId, state.consentId);
    let selected = await resolveProviderRoute(state.providerRef);
    validateRunConsent(run, consent, selected.scope, state.projectRef);

    const credential = credentialAccess.resolve(selected.route.credentialRef);
    if (!credential || credential.ok !== true || typeof credential.secret !== 'string' || !credential.secret.trim()) {
      throw new HostAdapterError('credential-unavailable');
    }
    if (String(credential.provider || '').toLowerCase() !== selected.route.provider.toLowerCase()) {
      throw new HostAdapterError('credential-provider-mismatch');
    }

    /* Credential resolution is synchronous and request-scoped. Re-read the registry and
       Consent immediately before handing this exact route and secret to NodeModelPort. */
    const fresh = await resolveProviderRoute(state.providerRef);
    if (!sameRoute(selected.route, fresh.route) || fresh.scope.routeHash !== selected.scope.routeHash) {
      credential.secret = '';
      throw new HostAdapterError('provider-route-changed');
    }
    run = readRun(state.runId);
    consent = readConsent(state.runId, state.consentId);
    validateRunConsent(run, consent, fresh.scope, state.projectRef);
    if (signal.aborted || !state.sendingAllowed) {
      credential.secret = '';
      throw new HostAdapterError('execution-stopped');
    }

    const requestSpec = Object.assign({}, fresh.spec, {
      provider: fresh.route.provider,
      model: fresh.route.model,
      endpoint: fresh.route.endpoint,
      credentialRef: fresh.route.credentialRef,
      apiKey: credential.secret
    });
    const request = {
      spec: requestSpec,
      prompt: { system: '', messages: messages },
      maxTokens: 512,
      temperature: 0,
      consumer: 'work_mode_dsh'
    };
    state.modelCalls += 1;
    emit('model-send', state, { call: state.modelCalls, providerRef: fresh.route.providerRef });
    try {
      return await modelPort.run(request, { signal: signal, timeoutMs: state.modelTimeoutMs });
    } finally {
      requestSpec.apiKey = '';
      credential.secret = '';
    }
  }

  async function handleModelRequest(state, req, res) {
    if (req.method !== 'POST' || req.url !== '/model/run') {
      writeJson(res, 404, { ok: false, error: 'not-found' });
      return;
    }
    if (!constantTimeBearerMatches(req.headers.authorization, state.hostToken)) {
      writeJson(res, 401, { ok: false, error: 'host-auth-denied' });
      return;
    }
    if (!state.sendingAllowed || state.childExited || active.get(state.runId) !== state) {
      writeJson(res, 410, { ok: false, error: 'execution-stopped' });
      return;
    }
    let body;
    try { body = await readJson(req); }
    catch (error) {
      writeJson(res, 400, { ok: false, error: error.code || 'invalid-model-request' });
      return;
    }
    if (!record(body) || Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'messages')) {
      writeJson(res, 400, { ok: false, error: 'invalid-model-request' });
      return;
    }
    let messages;
    try { messages = normalizeMessages(body.messages); }
    catch (error) {
      writeJson(res, 400, { ok: false, error: error.code || 'invalid-model-messages' });
      return;
    }
    const controller = new AbortController();
    state.modelRequests.add(controller);
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
      state.modelRequests.delete(controller);
    });
    try {
      const result = await authorizedModelCall(state, messages, controller.signal);
      if (!controller.signal.aborted && state.sendingAllowed && !state.childExited) {
        writeJson(res, 200, { ok: true, text: result.text });
      }
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) {
        const code = error instanceof HostAdapterError ? error.code : 'model-port-failed';
        state.lastModelError = code;
        writeJson(res, 409, { ok: false, error: code });
      }
    } finally {
      state.modelRequests.delete(controller);
    }
  }

  async function handleSessionEvent(state, req, res) {
    if (req.method !== 'POST' || req.url !== '/session/event') {
      writeJson(res, 404, { ok: false, error: 'not-found' });
      return;
    }
    if (!constantTimeBearerMatches(req.headers.authorization, state.hostToken)) {
      writeJson(res, 401, { ok: false, error: 'host-auth-denied' });
      return;
    }
    if (active.get(state.runId) !== state || !state.sessionId || state.childExited) {
      writeJson(res, 410, { ok: false, error: 'execution-stopped' });
      return;
    }
    let body;
    try { body = await readJson(req); }
    catch (error) {
      writeJson(res, 400, { ok: false, error: error.code || 'invalid-session-event' });
      return;
    }
    if (!record(body) || Object.keys(body).sort().join(',') !== 'childSessionId,dshSessionId,event,runId'
      || String(body.runId || '') !== state.runId
      || String(body.dshSessionId || '') !== state.dshSessionId
      || String(body.childSessionId || '') !== state.sessionId) {
      writeJson(res, 403, { ok: false, error: 'dsh-session-run-mismatch' });
      return;
    }
    try { assertSessionBinding(state.runId, state.dshSessionId, state.consentId); }
    catch (error) {
      writeJson(res, 403, { ok: false, error: error.code || 'dsh-session-run-mismatch' });
      return;
    }
    const event = normalizeDshTraceEvent(body.event);
    if (!event) {
      writeJson(res, 400, { ok: false, error: 'invalid-dsh-session-event' });
      return;
    }
    emit('dsh-session-event', state, { dshEvent: Object.assign({}, event, {
      provider: state.actualProvider || '', model: state.actualModel || ''
    }) });
    writeJson(res, 200, { ok: true });
  }

  async function handleProjectRead(state, req, res) {
    if (req.method !== 'POST' || req.url !== '/project/read_file') {
      writeJson(res, 404, { ok: false, error: 'not-found' });
      return;
    }
    if (!constantTimeBearerMatches(req.headers.authorization, state.hostToken)) {
      writeJson(res, 401, { ok: false, error: 'host-auth-denied' });
      return;
    }
    if (!state.sendingAllowed || state.childExited || active.get(state.runId) !== state) {
      writeJson(res, 410, { ok: false, error: 'execution-stopped' });
      return;
    }
    let body;
    try { body = await readJson(req); }
    catch (error) {
      writeJson(res, 400, { ok: false, error: error.code || 'invalid-project-request' });
      return;
    }
    if (!record(body) || Object.keys(body).length !== 1 || typeof body.fileId !== 'string') {
      writeJson(res, 400, { ok: false, error: 'invalid-project-request' });
      return;
    }
    const readActionId = actionRegistry && typeof actionRegistry.resolveLegacyTool === 'function'
      ? actionRegistry.resolveLegacyTool('project.read_file') : null;
    const traceActionId = readActionId || 'ib.workspace.read_file.v1';
    const appendReadTrace = (status, authorityResult) => {
      if (!workRunStore || typeof workRunStore.recordActionTrace !== 'function') return;
      try {
        workRunStore.recordActionTrace(state.runId, {
          requestId: 'dsh_read_' + crypto.randomUUID(),
          actionId: traceActionId,
          status: status,
          authorityResult: authorityResult
        });
      } catch (_) { /* trace collection never changes Workspace authorization */ }
    };
    const readInputCheck = readActionId && actionRegistry && typeof actionRegistry.validateInput === 'function'
      ? actionRegistry.validateInput(readActionId, { fileId: body.fileId }, 'agent') : { ok: false };
    if (!readInputCheck || readInputCheck.ok !== true) {
      appendReadTrace('denied', 'denied');
      writeJson(res, 403, { ok: false, error: 'action-registry-read-denied' });
      return;
    }
    try { assertSessionBinding(state.runId, state.dshSessionId, state.consentId); }
    catch (error) {
      appendReadTrace('denied', 'denied');
      writeJson(res, 409, { ok: false, error: error.code || 'dsh-session-run-mismatch' });
      return;
    }
    if (!state.executorSelection || !state.executorSelection.allowedTools.includes(workModeExecutor.TOOL_PROJECT_READ)) {
      if (state.executorSelection && state.executorSelection.presetId === 'coding') state.projectToolDenied = true;
      emit('tool-denied', state, { toolName: 'project.read_file', fileId: body.fileId, code: 'preset-tool-not-allowed' });
      appendReadTrace('denied', 'denied');
      writeJson(res, 403, { ok: false, error: 'preset-tool-not-allowed' });
      return;
    }
    const file = state.projectFiles.find(item => item && item.fileId === body.fileId);
    emit('tool-call', state, { toolName: 'project.read_file', fileId: body.fileId, path: file && file.path || '' });
    const controller = new AbortController();
    state.workspaceRequests.add(controller);
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
      state.workspaceRequests.delete(controller);
    });
    try {
      const run = readRun(state.runId);
      const consent = readConsent(state.runId, state.consentId);
      const route = await resolveProviderRoute(state.providerRef);
      validateRunConsent(run, consent, route.scope, state.projectRef, [body.fileId]);
      if (state.projectReadCalls >= state.maxProjectReadCalls) {
        if (state.executorSelection.presetId === 'coding') state.projectToolDenied = true;
        emit('tool-denied', state, { toolName: 'project.read_file', fileId: body.fileId, code: 'preset-tool-call-limit' });
        appendReadTrace('denied', 'denied');
        writeJson(res, 403, { ok: false, error: 'preset-tool-call-limit' });
        return;
      }
      state.projectReadCalls += 1;
      const result = await state.projectTool.readFile({
        projectRef: state.projectRef,
        fileId: body.fileId,
        scope: { projectRef: state.projectRef, files: state.projectFiles },
        signal: controller.signal
      });
      if (controller.signal.aborted || !state.sendingAllowed || state.childExited || res.destroyed) return;
      if (!result || result.ok !== true) {
        const normalized = workspaceChangeContract.normalizeResult(result || { ok: false, error: 'project-read-denied' });
        const errorCode = workspaceChangeContract.normalizeError(normalized && normalized.error || 'project-read-denied');
        const workspaceChange = normalized && normalized.workspaceChange;
        if (state.executorSelection.presetId === 'coding') state.projectToolDenied = true;
        emit('tool-denied', state, {
          toolName: 'project.read_file', fileId: body.fileId, code: errorCode,
          ...(workspaceChange && workspaceChange.reason ? { reason: workspaceChange.reason } : {})
        });
        const denied = /scope|consent|denied|unauthorized/i.test(String(errorCode));
        appendReadTrace(denied ? 'denied' : 'failed', denied ? 'denied' : 'allowed');
        writeJson(res, 409, Object.assign({ ok: false, error: errorCode }, workspaceChange ? { workspaceChange: workspaceChange } : {}));
        return;
      }
      const readOutputCheck = actionRegistry && typeof actionRegistry.validateOutput === 'function'
        ? actionRegistry.validateOutput(readActionId, result) : { ok: false };
      if (!readOutputCheck || readOutputCheck.ok !== true) {
        if (state.executorSelection.presetId === 'coding') state.projectToolDenied = true;
        emit('tool-denied', state, { toolName: 'project.read_file', fileId: body.fileId, code: 'action-output-invalid' });
        appendReadTrace('failed', 'allowed');
        writeJson(res, 502, { ok: false, error: 'project-read-result-invalid' });
        return;
      }
      appendReadTrace('succeeded', 'allowed');
      emit('project-read', state, { toolName: 'project.read_file', fileId: body.fileId, path: result.path || file && file.path || '' });
      state.projectReadIds.add(body.fileId);
      writeJson(res, 200, { ok: true, result: result });
    } catch (error) {
      const sourceCode = error instanceof HostAdapterError ? error.code : 'project-read-denied';
      const normalized = workspaceChangeContract.normalizeResult({ ok: false, error: sourceCode });
      const code = workspaceChangeContract.normalizeError(normalized.error);
      const workspaceChange = normalized.workspaceChange;
      if (state.executorSelection && state.executorSelection.presetId === 'coding') state.projectToolDenied = true;
      const denied = /consent|scope|denied|authorization/i.test(String(code || ''));
      appendReadTrace(denied ? 'denied' : 'failed', denied ? 'denied' : 'not_checked');
      if (!controller.signal.aborted && !res.destroyed) {
        writeJson(res, 409, Object.assign({ ok: false, error: code }, workspaceChange ? { workspaceChange: workspaceChange } : {}));
      }
    } finally {
      state.workspaceRequests.delete(controller);
    }
  }

  async function handleProjectWrite(state, req, res, toolName) {
    const endpoints = {
      'project.create_file': '/project/create_file',
      'project.update_file': '/project/update_file'
    };
    const endpoint = endpoints[toolName];
    if (req.method !== 'POST' || req.url !== endpoint) { writeJson(res, 404, { ok: false, error: 'not-found' }); return; }
    if (!constantTimeBearerMatches(req.headers.authorization, state.hostToken)) {
      writeJson(res, 401, { ok: false, error: 'host-auth-denied' }); return;
    }
    if (!state.sendingAllowed || state.childExited || active.get(state.runId) !== state) {
      writeJson(res, 410, { ok: false, error: 'execution-stopped' }); return;
    }
    let body;
    try { body = await readJson(req); }
    catch (error) { writeJson(res, 400, { ok: false, error: error.code || 'invalid-project-write-request' }); return; }
    const expectedKeys = toolName === 'project.create_file' ? ['anchorFileId', 'content', 'path'] : ['content', 'fileId'];
    if (!record(body) || Object.keys(body).sort().join(',') !== expectedKeys.join(',')
      || expectedKeys.some(key => typeof body[key] !== 'string')
      || Buffer.byteLength(body.content, 'utf8') > 131072) {
      writeJson(res, 400, { ok: false, error: 'invalid-project-write-request' }); return;
    }
    const anchorId = toolName === 'project.create_file' ? body.anchorFileId : body.fileId;
    try { assertSessionBinding(state.runId, state.dshSessionId, state.consentId); }
    catch (error) { writeJson(res, 409, { ok: false, error: error.code || 'dsh-session-run-mismatch' }); return; }
    const authorizedFile = state.projectFiles.find(item => item && item.fileId === anchorId);
    emit('tool-call', state, { toolName: toolName, fileId: anchorId, path: toolName === 'project.create_file' ? body.path : authorizedFile && authorizedFile.path || '' });
    if (!state.executorSelection || state.executorSelection.presetId !== 'coding'
      || !state.executorSelection.allowedTools.includes(toolName)
      || !state.executorSelection.allowedTools.includes(workModeExecutor.TOOL_PROJECT_READ)) {
      state.projectToolDenied = true;
      emit('tool-denied', state, { toolName: toolName, fileId: anchorId, code: 'preset-tool-not-allowed' });
      writeJson(res, 403, { ok: false, error: 'preset-tool-not-allowed' }); return;
    }
    if (!authorizedFile || !state.projectTool || typeof state.projectTool[toolName === 'project.create_file' ? 'createFile' : 'updateFile'] !== 'function') {
      state.projectToolDenied = true;
      emit('tool-denied', state, { toolName: toolName, fileId: anchorId, code: 'scope-denied' });
      writeJson(res, 403, { ok: false, error: 'scope-denied' }); return;
    }
    if (!state.projectReadIds.has(anchorId)) {
      state.projectToolDenied = true;
      emit('tool-denied', state, { toolName: toolName, fileId: anchorId, code: 'project-read-required' });
      writeJson(res, 403, { ok: false, error: 'project-read-required' }); return;
    }
    const controller = new AbortController();
    state.workspaceRequests.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); state.workspaceRequests.delete(controller); });
    try {
      const run = readRun(state.runId);
      const consent = readConsent(state.runId, state.consentId);
      const route = await resolveProviderRoute(state.providerRef);
      validateRunConsent(run, consent, route.scope, state.projectRef, [anchorId]);
      if (run.workflowId !== CODING_WORKFLOW_ID || run.status !== 'running' || consent.workspaceWriteConfirmed !== true) {
        state.projectToolDenied = true;
        emit('tool-denied', state, { toolName: toolName, fileId: anchorId, code: 'workspace-write-consent-required' });
        writeJson(res, 403, { ok: false, error: 'workspace-write-consent-required' }); return;
      }
      if (state.projectWriteCalls >= PROJECT_WRITE_TOOL_LIMIT) {
        state.projectToolDenied = true;
        emit('tool-denied', state, { toolName: toolName, fileId: anchorId, code: 'project-write-call-limit' });
        writeJson(res, 403, { ok: false, error: 'project-write-call-limit' }); return;
      }
      state.projectWriteCalls += 1;
      const input = toolName === 'project.create_file'
        ? { projectRef: state.projectRef, anchorFileId: body.anchorFileId, path: body.path, content: body.content,
          scope: { projectRef: state.projectRef, files: state.projectFiles }, signal: controller.signal }
        : { projectRef: state.projectRef, fileId: body.fileId, content: body.content,
          scope: { projectRef: state.projectRef, files: state.projectFiles }, signal: controller.signal };
      const result = toolName === 'project.create_file'
        ? await state.projectTool.createFile(input) : await state.projectTool.updateFile(input);
      if (controller.signal.aborted || !state.sendingAllowed || state.childExited || res.destroyed) return;
      if (!result || result.ok !== true) {
        state.projectToolDenied = true;
        const code = String(result && result.error || 'project-write-denied');
        emit('tool-denied', state, { toolName: toolName, fileId: anchorId, path: body.path || authorizedFile.path, code: code });
        writeJson(res, 409, { ok: false, error: code, result: { ok: false, error: code, fileId: anchorId, path: body.path || authorizedFile.path } });
        return;
      }
      if (typeof result.changeId === 'string') state.projectChanges.push(result.changeId);
      emit('project-file-write', state, { toolName: toolName, fileId: result.fileId || anchorId, path: result.path || '',
        addedLines: Number(result.addedLines) || 0, removedLines: Number(result.removedLines) || 0 });
      writeJson(res, 200, { ok: true, result: { ok: true, status: 'written', fileId: result.fileId || anchorId,
        path: result.path || '', addedLines: Number(result.addedLines) || 0, removedLines: Number(result.removedLines) || 0,
        diff: typeof result.diff === 'string' ? result.diff.slice(0, 3000) : '' } });
    } catch (error) {
      const code = error instanceof HostAdapterError ? error.code : 'project-write-denied';
      state.projectToolDenied = true;
      if (!controller.signal.aborted && !res.destroyed) writeJson(res, 409, { ok: false, error: code });
    } finally { state.workspaceRequests.delete(controller); }
  }

  async function handleAppDraftTool(state, req, res, toolName) {
    const endpoints = {
      'app_draft.list_files': '/app-draft/list_files',
      'app_draft.read_file': '/app-draft/read_file',
      'app_draft.create_file': '/app-draft/create_file',
      'app_draft.update_file': '/app-draft/update_file'
    };
    if (req.method !== 'POST' || req.url !== endpoints[toolName]) {
      writeJson(res, 404, { ok: false, error: 'not-found' }); return;
    }
    if (!constantTimeBearerMatches(req.headers.authorization, state.hostToken)) {
      writeJson(res, 401, { ok: false, error: 'host-auth-denied' }); return;
    }
    if (!state.sendingAllowed || state.childExited || active.get(state.runId) !== state) {
      writeJson(res, 410, { ok: false, error: 'execution-stopped' }); return;
    }
    let body;
    try { body = await readJson(req); }
    catch (error) { writeJson(res, 400, { ok: false, error: error.code || 'invalid-app-draft-request' }); return; }
    const expectedKeys = toolName === 'app_draft.list_files' ? []
      : (toolName === 'app_draft.read_file' ? ['path'] : ['content', 'path']);
    if (!record(body) || Object.keys(body).sort().join(',') !== expectedKeys.sort().join(',')
      || (toolName !== 'app_draft.list_files' && typeof body.path !== 'string')
      || ((toolName === 'app_draft.create_file' || toolName === 'app_draft.update_file') && typeof body.content !== 'string')) {
      writeJson(res, 400, { ok: false, error: 'invalid-app-draft-request' }); return;
    }
    try {
      assertSessionBinding(state.runId, state.dshSessionId, state.consentId);
      const run = readRun(state.runId);
      const consent = readConsent(state.runId, state.consentId);
      const route = await resolveProviderRoute(state.providerRef);
      validateRunConsent(run, consent, route.scope, state.projectRef);
      if (run.workflowId !== APP_BUILDER_WORKFLOW_ID || run.status !== 'running'
        || run.appDraftRef !== state.appDraftRef || consent.fileIds.length !== 0
        || !state.executorSelection || state.executorSelection.presetId !== 'app-builder'
        || !state.executorSelection.allowedTools.includes(toolName)) {
        emit('tool-denied', state, { toolName: toolName, code: 'preset-tool-not-allowed' });
        writeJson(res, 403, { ok: false, error: 'preset-tool-not-allowed' }); return;
      }
      if (state.appDraftToolCalls >= APP_DRAFT_TOOL_LIMIT) {
        emit('tool-denied', state, { toolName: toolName, code: 'app-draft-tool-call-limit' });
        writeJson(res, 403, { ok: false, error: 'app-draft-tool-call-limit' }); return;
      }
      const context = appDraftStore.getRunContext({ draftRef: state.appDraftRef, projectRef: state.projectRef, runId: state.runId });
      if (!context || context.ok !== true || context.runStatus !== 'running') {
        writeJson(res, 409, { ok: false, error: 'app-draft-run-not-active' }); return;
      }
      state.appDraftToolCalls += 1;
      emit('tool-call', state, { toolName: toolName, path: body.path || '' });
      let result;
      if (toolName === 'app_draft.list_files') result = appDraftStore.listFiles({ draftRef: state.appDraftRef, projectRef: state.projectRef, runId: state.runId });
      else if (toolName === 'app_draft.read_file') result = appDraftStore.readFile({ draftRef: state.appDraftRef, projectRef: state.projectRef, runId: state.runId, path: body.path });
      else if (toolName === 'app_draft.create_file') result = appDraftStore.createFile({ draftRef: state.appDraftRef, projectRef: state.projectRef, runId: state.runId, path: body.path, content: body.content });
      else result = appDraftStore.updateFile({ draftRef: state.appDraftRef, projectRef: state.projectRef, runId: state.runId, path: body.path, content: body.content });
      if (result && result.ok === true) {
        if (toolName === 'app_draft.create_file' || toolName === 'app_draft.update_file') {
          emit('app-draft-file-written', state, { toolName: toolName, path: result.path, version: result.version });
        } else if (toolName === 'app_draft.read_file') {
          emit('app-draft-file-read', state, { toolName: toolName, path: result.path });
        }
        writeJson(res, 200, { ok: true, result: result });
      } else {
        emit('tool-denied', state, { toolName: toolName, path: body.path || '', code: result && result.error || 'app-draft-tool-denied' });
        writeJson(res, 409, { ok: false, error: result && result.error || 'app-draft-tool-denied' });
      }
    } catch (error) {
      const code = error instanceof HostAdapterError ? error.code : 'app-draft-tool-denied';
      if (!res.destroyed) writeJson(res, 409, { ok: false, error: code });
    }
  }

  function createModelServer(state) {
    const server = http.createServer((req, res) => {
      if (req.url === '/project/read_file') void handleProjectRead(state, req, res);
      else if (req.url === '/project/create_file') void handleProjectWrite(state, req, res, 'project.create_file');
      else if (req.url === '/project/update_file') void handleProjectWrite(state, req, res, 'project.update_file');
      else if (req.url === '/session/event') void handleSessionEvent(state, req, res);
      else if (req.url && req.url.startsWith('/app-draft/')) {
        const tool = Object.keys({
          'app_draft.list_files': '/app-draft/list_files', 'app_draft.read_file': '/app-draft/read_file',
          'app_draft.create_file': '/app-draft/create_file', 'app_draft.update_file': '/app-draft/update_file'
        }).find(name => ({
          'app_draft.list_files': '/app-draft/list_files', 'app_draft.read_file': '/app-draft/read_file',
          'app_draft.create_file': '/app-draft/create_file', 'app_draft.update_file': '/app-draft/update_file'
        })[name] === req.url);
        if (tool) void handleAppDraftTool(state, req, res, tool);
        else { writeJson(res, 404, { ok: false, error: 'not-found' }); }
      }
      else void handleModelRequest(state, req, res);
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new HostAdapterError('host-model-server-bind-failed'));
          return;
        }
        state.server = server;
        state.modelPortUrl = `http://127.0.0.1:${address.port}/model/run`;
        resolve(server);
      });
    });
  }

  function childEnvironment(state) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    return {
      PATH: process.env.PATH || '',
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'),
      TEMP: state.tempDir,
      TMP: state.tempDir,
      DSH_HOME: path.join(state.tempDir, 'dsh-home'),
      DSH_AGENTS_HOME: path.join(state.tempDir, 'dsh-agents'),
      DSH_TELEMETRY_DISABLED: '1',
      TSX_TSCONFIG_PATH: path.join(dsh.repoRoot, 'tsconfig.json'),
      IB_DSH_MODEL_PORT_URL: state.modelPortUrl,
      IB_DSH_HOST_RPC_TOKEN: state.hostToken,
      IB_DSH_ALLOWED_TOOLS: state.executorSelection ? state.executorSelection.allowedTools.join(',') : '',
      IB_DSH_HOME_NODE_RUN_ID: state.runId,
      IB_DSH_HOME_NODE_SESSION_ID: state.dshSessionId
    };
  }

  async function waitForSpawn(child) {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  function interruptible(state, promise) {
    return Promise.race([
      promise,
      state.interruptPromise.then(value => { throw new HostAdapterError(value && value.kind === 'timeout' ? 'execution-timeout' : 'execution-cancelled'); }),
      state.exitPromise.then(() => { throw new HostAdapterError('acp-child-exited'); })
    ]);
  }

  async function waitForExit(state, timeoutMs) {
    if (state.childExited) return state.exitInfo;
    let timer;
    try {
      return await Promise.race([
        state.exitPromise,
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new HostAdapterError('child-exit-timeout')), timeoutMs); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  function terminateChild(state) {
    if (!state.child || state.childExited) return;
    try { state.child.kill('SIGTERM'); } catch (_) { /* best effort */ }
    return waitForExit(state, 1500).catch(() => {
      try { state.child.kill('SIGKILL'); } catch (_) { /* child may already be gone */ }
      return waitForExit(state, 1500).catch(() => null);
    });
  }

  async function closeSession(state) {
    if (!state.acp || !state.sessionId || state.childExited) return;
    try {
      await Promise.race([
        state.acp.request(ACP_METHOD.CLOSE, { sessionId: state.sessionId }),
        new Promise(resolve => setTimeout(resolve, 500))
      ]);
    } catch (_) { /* ACP child may be unwinding a failed/cancelled turn */ }
  }

  async function transitionTerminal(state, status, reasonCode) {
    let run;
    try { run = readRun(state.runId); } catch (_) { return; }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return;
    if (run.status === 'cancel_requested' && status === 'cancelled') {
      const result = workRunStore.transition({
        runId: state.runId,
        requestId: makeRequestId('dsh-terminal'),
        expectedVersion: run.version,
        status: 'cancelled',
        reasonCode: 'runtime_cancelled'
      });
      if (!result || result.ok !== true) emit('terminal-transition-failed', state, { code: result && result.code || 'unknown' });
      return;
    }
    if (run.status !== 'running') return;
    const result = workRunStore.transition({
      runId: state.runId,
      requestId: makeRequestId('dsh-terminal'),
      expectedVersion: run.version,
      status: status,
      reasonCode: reasonCode
    });
    if (!result || result.ok !== true) emit('terminal-transition-failed', state, { code: result && result.code || 'unknown' });
  }

  async function run(input) {
    if (runtimeUpgradeInProgress) return { ok: false, error: 'dsh-runtime-updating' };
    assertDependencies();
    if (!record(input) || Object.keys(input).some(key => !['runId', 'sessionId', 'consentId', 'providerRef', 'prompt', 'timeoutMs', 'mcpServers', 'plannedFileIds', 'deferResult'].includes(key))) {
      return { ok: false, error: 'invalid-request' };
    }
    if (input.mcpServers !== undefined && (!Array.isArray(input.mcpServers) || input.mcpServers.length > 0)) {
      return { ok: false, error: 'mcp-configuration-denied' };
    }
    const runId = String(input.runId || '');
    const dshSessionId = String(input.sessionId || '');
    const consentId = String(input.consentId || '');
    const providerRef = String(input.providerRef || '');
    const prompt = String(input.prompt || '');
    const timeoutMs = Number(input.timeoutMs || options.timeoutMs || 120000);
    const deferResult = input.deferResult === true;
    const plannedFileIds = input.plannedFileIds === undefined ? null : input.plannedFileIds;
    if (!runId || !consentId || !providerRef || !prompt.trim()
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60 * 1000
      || (plannedFileIds !== null && (!Array.isArray(plannedFileIds) || plannedFileIds.length > 12
        || plannedFileIds.some(fileId => typeof fileId !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(fileId))
        || new Set(plannedFileIds).size !== plannedFileIds.length))) {
      return { ok: false, error: 'invalid-request' };
    }
    if (active.has(runId)) return { ok: false, error: 'run-already-active' };

    const state = {
      runId: runId,
      consentId: consentId,
      providerRef: providerRef,
      projectRef: '',
      dshSessionId: dshSessionId,
      timeoutMs: timeoutMs,
      modelTimeoutMs: Math.min(timeoutMs, Number(options.modelTimeoutMs) || timeoutMs),
      hostToken: crypto.randomBytes(32).toString('hex'),
      tempDir: fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), 'ib-dsh-host-')),
      modelRequests: new Set(),
      workspaceRequests: new Set(),
      modelCalls: 0,
      lastModelError: '',
      sendingAllowed: false,
      cancelled: false,
      childExited: false,
      sessionId: '',
      actualProvider: '',
      actualModel: '',
      agentText: '',
      deferResult: deferResult,
      plannedFileIds: plannedFileIds,
      executorSelection: null,
      appDraftRef: '',
      appDraftToolCalls: 0,
      cancelKind: '',
      child: null,
      server: null,
      acp: null,
      timer: null,
      exitInfo: null,
      exitPromise: null,
      resolveExit: null,
      resolveInterrupt: null,
      interruptPromise: null,
      resolveFinished: null,
      finishedPromise: null,
      projectTool: null,
      projectFiles: [],
      projectReadCalls: 0,
      projectReadIds: new Set(),
      projectToolDenied: false,
      maxProjectReadCalls: 0,
      projectWriteCalls: 0,
      projectChanges: []
    };
    state.interruptPromise = new Promise(resolve => { state.resolveInterrupt = resolve; });
    state.exitPromise = new Promise(resolve => { state.resolveExit = resolve; });
    state.finishedPromise = new Promise(resolve => { state.resolveFinished = resolve; });
    active.set(runId, state);

    let startingRun = null;
    try {
      startingRun = readRun(runId);
      if ((startingRun.status !== 'queued' && !(deferResult && startingRun.status === 'running'))
        || ![WORKFLOW_ID, APP_BUILDER_WORKFLOW_ID, CODING_WORKFLOW_ID].includes(startingRun.workflowId)) throw new HostAdapterError('run-not-queued');
      assertSessionBinding(runId, dshSessionId, consentId);
      state.projectRef = startingRun.projectRef;
      let consent = readConsent(runId, consentId);
      const route = await resolveProviderRoute(providerRef);
      state.actualProvider = route.route.provider;
      state.actualModel = route.route.model;
      validateRunConsent(startingRun, consent, route.scope, state.projectRef);
      const executorSelection = workModeExecutor.normalizeSnapshot(startingRun.executorSelection);
      if (!executorSelection || executorSelection.profileRef !== providerRef
        || !workModeConsentCore.sameProviderScopes([executorSelection.providerScope], [route.scope])) {
        throw new HostAdapterError('run-executor-selection-mismatch');
      }
      if (startingRun.workflowId === APP_BUILDER_WORKFLOW_ID) {
        if (!appDraftStore || !startingRun.appDraftRef || executorSelection.presetId !== 'app-builder'
          || executorSelection.allowedTools.join(',') !== workModeExecutor.APP_DRAFT_TOOLS.join(',')) {
          throw new HostAdapterError('app-draft-run-scope-mismatch');
        }
        let appRun = appDraftStore.getRunContext({ draftRef: startingRun.appDraftRef,
          projectRef: startingRun.projectRef, runId: runId });
        if (appRun && appRun.ok === true && appRun.runStatus === 'queued') {
          const activated = appDraftStore.activateRun({ draftRef: startingRun.appDraftRef,
            projectRef: startingRun.projectRef, runId: runId });
          if (!activated || activated.ok !== true) throw new HostAdapterError('app-draft-run-not-active');
          appRun = appDraftStore.getRunContext({ draftRef: startingRun.appDraftRef,
            projectRef: startingRun.projectRef, runId: runId });
        }
        if (!appRun || appRun.ok !== true || appRun.runStatus !== 'running') throw new HostAdapterError('app-draft-run-not-active');
        state.appDraftRef = startingRun.appDraftRef;
      } else if (startingRun.workflowId === CODING_WORKFLOW_ID) {
        if (executorSelection.presetId !== 'coding' || executorSelection.allowedTools.join(',') !== CODING_TOOLS.join(',')) {
          throw new HostAdapterError('coding-preset-workflow-mismatch');
        }
      } else if (executorSelection.presetId === 'app-builder') {
        throw new HostAdapterError('app-builder-preset-workflow-mismatch');
      } else if (executorSelection.presetId === 'coding') {
        throw new HostAdapterError('coding-preset-workflow-mismatch');
      }
      state.executorSelection = executorSelection;
      state.maxProjectReadCalls = executorSelection.maxProjectReadCalls;
      state.projectTool = await createProjectTool({ runId: runId, projectRef: state.projectRef, consentId: consentId });
      if (!state.projectTool || typeof state.projectTool.snapshot !== 'function' || typeof state.projectTool.readFile !== 'function'
        || (startingRun.workflowId === CODING_WORKFLOW_ID
          && (typeof state.projectTool.createFile !== 'function' || typeof state.projectTool.updateFile !== 'function'
            || typeof state.projectTool.rollback !== 'function'))) {
        throw new HostAdapterError('workspace-project-tool-unavailable');
      }
      if (!Array.isArray(consent.fileIds)) throw new HostAdapterError('consent-file-scope-invalid');
      const inspectEnabled = startingRun.workflowId !== APP_BUILDER_WORKFLOW_ID;
      const inspectActionId = 'ib.project.inspect.v1';
      const inspectTrace = (status, authorityResult) => {
        if (!inspectEnabled || !workRunStore || typeof workRunStore.recordActionTrace !== 'function') return;
        try {
          workRunStore.recordActionTrace(runId, {
            requestId: 'dsh_read_' + crypto.randomUUID(),
            actionId: inspectActionId,
            status: status,
            authorityResult: authorityResult
          });
        } catch (_) { /* trace collection never changes Workspace authorization */ }
      };
      if (inspectEnabled) {
        const inspectInput = {
          runId: runId,
          consentId: consentId,
          projectRef: state.projectRef,
          fileIds: consent.fileIds.slice()
        };
        const inspectInputCheck = actionRegistry && typeof actionRegistry.validateInput === 'function'
          ? actionRegistry.validateInput(inspectActionId, inspectInput) : { ok: false };
        if (!inspectInputCheck || inspectInputCheck.ok !== true) {
          inspectTrace('denied', 'denied');
          throw new HostAdapterError('action-registry-project-inspect-denied');
        }
      }
      const snapshotController = new AbortController();
      state.workspaceRequests.add(snapshotController);
      let snapshot;
      try { snapshot = await state.projectTool.snapshot(state.projectRef, { signal: snapshotController.signal }); }
      catch (error) {
        inspectTrace('failed', 'not_checked');
        throw error;
      }
      finally { state.workspaceRequests.delete(snapshotController); }
      if (!snapshot || snapshot.ok !== true || snapshot.projectRef !== state.projectRef || !Array.isArray(snapshot.files)) {
        inspectTrace('failed', 'not_checked');
        throw new HostAdapterError(snapshot && snapshot.error || 'workspace-project-snapshot-failed');
      }
      const authorizedFileIds = new Set(consent.fileIds);
      const workspaceAuthorized = snapshot.files.filter(file => file && authorizedFileIds.has(file.fileId));
      if (workspaceAuthorized.length !== authorizedFileIds.size) {
        inspectTrace('denied', 'denied');
        throw new HostAdapterError('consent-file-not-in-workspace');
      }
      if (inspectEnabled) {
        try {
          const freshRun = readRun(runId);
          const freshConsent = readConsent(runId, consentId);
          const freshRoute = await resolveProviderRoute(providerRef);
          validateRunConsent(freshRun, freshConsent, freshRoute.scope, state.projectRef, consent.fileIds);
        } catch (error) {
          const code = error instanceof HostAdapterError ? error.code : 'consent-unavailable';
          const denied = /consent|scope|denied|authorization/i.test(String(code));
          inspectTrace(denied ? 'denied' : 'failed', denied ? 'denied' : 'not_checked');
          throw error;
        }
        const inspected = projectInspect.build({
          projectRef: state.projectRef,
          projectName: snapshot.projectName,
          fileIds: consent.fileIds,
          files: workspaceAuthorized
        });
        if (!inspected || inspected.ok !== true || !inspected.output) {
          inspectTrace('failed', 'allowed');
          throw new HostAdapterError(inspected && inspected.error || 'project-inspection-failed');
        }
        const inspectOutputCheck = actionRegistry && typeof actionRegistry.validateOutput === 'function'
          ? actionRegistry.validateOutput(inspectActionId, inspected.output) : { ok: false };
        if (!inspectOutputCheck || inspectOutputCheck.ok !== true) {
          inspectTrace('failed', 'allowed');
          throw new HostAdapterError('action-output-project-inspect-invalid');
        }
        state.projectInspection = inspected.output;
        inspectTrace('succeeded', 'allowed');
      }
      const planned = plannedFileIds === null ? consent.fileIds : plannedFileIds;
      if (planned.some(fileId => !authorizedFileIds.has(fileId))) throw new HostAdapterError('plan-file-scope-invalid');
      const plannedSet = new Set(planned);
      state.projectFiles = workspaceAuthorized.filter(file => plannedSet.has(file.fileId));
      if (state.projectFiles.length !== plannedSet.size) throw new HostAdapterError('planned-file-not-in-workspace');
      let transitioned = { ok: true, run: startingRun };
      if (startingRun.status === 'queued') {
        transitioned = workRunStore.transition({
          runId: runId,
          requestId: makeRequestId('dsh-start'),
          expectedVersion: startingRun.version,
          status: 'running',
          reasonCode: 'runtime_started'
        });
        if (!transitioned || transitioned.ok !== true || !transitioned.run) throw new HostAdapterError(transitioned && transitioned.code || 'run-start-failed');
      } else {
        emit('run-host-attached', state, { version: startingRun.version });
      }
      state.sendingAllowed = true;
      if (startingRun.status === 'queued') emit('run-started', state, { version: transitioned.run.version });

      state.timer = setTimeout(() => {
        if (state.cancelKind) return;
        state.cancelKind = 'timeout';
        state.sendingAllowed = false;
        for (const controller of state.modelRequests) controller.abort();
        for (const controller of state.workspaceRequests) controller.abort();
        state.resolveInterrupt({ kind: 'timeout' });
        if (state.acp && state.sessionId && !state.childExited) {
          try { state.acp.notify(ACP_METHOD.CANCEL, { sessionId: state.sessionId }); } catch (_) { /* child is unwinding */ }
        } else if (state.child && !state.childExited) {
          void terminateChild(state);
        }
      }, timeoutMs);

      await createModelServer(state);
      if (state.cancelKind) throw new HostAdapterError(state.cancelKind === 'timeout' ? 'execution-timeout' : 'execution-cancelled');
      const patches = Array.isArray(dsh.patches) ? dsh.patches.slice() : [dsh.patch];
      const args = Array.isArray(dsh.args)
        ? dsh.args.slice()
        : ['--import', dsh.tsxLoader, dsh.binScript, '--profile', 'acp', ...patches.flatMap(patch => ['--patch', patch])];
      state.child = spawn(dsh.nodeExe, args, {
        cwd: state.tempDir,
        env: childEnvironment(state),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      state.child.stderr.on('data', chunk => {
        const line = String(chunk).slice(0, 256);
        if (line.includes('IB_POC_PROJECT_FILE_READ')) emit('project-file-read', state);
      });
      state.child.once('close', (code, signal) => {
        state.childExited = true;
        state.exitInfo = { code: code, signal: signal };
        state.sendingAllowed = false;
        for (const controller of state.modelRequests) controller.abort();
        for (const controller of state.workspaceRequests) controller.abort();
        state.resolveExit(state.exitInfo);
        if (state.cancelKind === '') {
          state.cancelKind = 'crash';
          state.resolveInterrupt({ kind: 'crash', code: code, signal: signal });
        }
      });
      await interruptible(state, waitForSpawn(state.child));
      state.acp = createAcpClient(state.child, params => {
        const update = params && params.update;
        if (update && update.sessionUpdate === 'agent_message_chunk'
          && update.content && update.content.type === 'text' && typeof update.content.text === 'string') {
          state.agentText += update.content.text;
        }
      });
      const init = await interruptible(state, state.acp.request(ACP_METHOD.INITIALIZE, {
        protocolVersion: protocolVersion,
        clientCapabilities: {}
      }));
      if (!record(init) || !init.protocolVersion) throw new HostAdapterError('acp-initialize-failed');
      const created = await interruptible(state, state.acp.request(ACP_METHOD.NEW_SESSION, {
        cwd: state.tempDir,
        mcpServers: []
      }));
      if (!record(created) || typeof created.sessionId !== 'string') throw new HostAdapterError('acp-session-create-failed');
      state.sessionId = created.sessionId;

      const promptPromise = state.acp.request(ACP_METHOD.PROMPT, {
        sessionId: state.sessionId,
        prompt: [{ type: 'text', text: prompt }]
      }).then(value => ({ kind: 'prompt', value }), error => ({ kind: 'error', error: error }));
      const outcome = await Promise.race([
        promptPromise,
        state.interruptPromise.then(value => ({ kind: 'interrupt', value })),
        state.exitPromise.then(value => ({ kind: 'exit', value }))
      ]);

      if (outcome.kind === 'interrupt' || outcome.kind === 'exit') {
        const why = state.cancelKind || (outcome.kind === 'exit' ? 'crash' : 'stopped');
        throw new HostAdapterError(why === 'timeout' ? 'execution-timeout' : (why === 'cancelled' ? 'execution-cancelled' : 'acp-child-exited'));
      }
      if (outcome.kind === 'error') throw outcome.error;
      const response = outcome.value;
      if (!record(response) || response.stopReason !== 'end_turn') {
        throw new HostAdapterError(state.cancelKind === 'cancelled' ? 'execution-cancelled' : 'acp-prompt-failed');
      }
      let result;
      try { result = JSON.parse(state.agentText); }
      catch (_) { throw new HostAdapterError('invalid-work-result-json'); }
      if (startingRun.workflowId === CODING_WORKFLOW_ID && state.projectToolDenied === true) {
        throw new HostAdapterError('coding-tool-denied');
      }
      if (startingRun.workflowId === CODING_WORKFLOW_ID
        && (!record(result) || result.schemaVersion !== 1 || typeof result.summary !== 'string'
          || !Array.isArray(result.findings) || result.findings.length !== 0)) {
        throw new HostAdapterError('invalid-coding-result');
      }
      const latestRun = readRun(runId);
      if (latestRun.status !== 'running') throw new HostAdapterError('run-not-running');
      if (state.deferResult) {
        if (startingRun.workflowId === CODING_WORKFLOW_ID && state.projectChanges.length
          && state.projectTool && typeof state.projectTool.rollback === 'function') {
          const projectTool = state.projectTool;
          const changes = state.projectChanges.slice();
          const journal = { changes: changes, rollback: projectTool.rollback, commitChanges: projectTool.commitChanges, timer: null };
          journal.timer = setTimeout(async () => {
            if (pendingProjectChanges.get(runId) !== journal) return;
            let latest = null;
            try { latest = readRun(runId); } catch (_) {}
            if (latest && latest.status === 'completed' && typeof journal.commitChanges === 'function') journal.commitChanges();
            else for (const changeId of changes.slice().reverse()) { try { await journal.rollback(changeId); } catch (_) {} }
            pendingProjectChanges.delete(runId);
          }, 2 * 60 * 1000);
          pendingProjectChanges.set(runId, journal);
        }
        emit('agent-report-ready', state, { version: latestRun.version });
        return { ok: true, run: latestRun, candidate: result };
      }
      const completed = workRunStore.completeRun({
        runId: runId,
        requestId: makeRequestId('dsh-complete'),
        expectedVersion: latestRun.version,
        consentId: consentId,
        result: result
      });
      if (!completed || completed.ok !== true) throw new HostAdapterError(completed && completed.code || 'result-completion-failed');
      emit('run-completed', state, { version: completed.run.version });
      return { ok: true, run: completed.run, result: completed.result };
    } catch (error) {
      const current = (() => { try { return readRun(runId); } catch (_) { return null; } })();
      const reason = state.cancelKind === 'cancelled'
        ? 'cancelled'
        : (state.cancelKind === 'timeout' ? 'timeout' : (state.cancelKind === 'crash' ? 'crash' : 'failed'));
      if (state.projectTool && typeof state.projectTool.rollback === 'function' && state.projectChanges.length) {
        for (const changeId of state.projectChanges.slice().reverse()) {
          try {
            const rollback = await state.projectTool.rollback(changeId);
            emit('project-file-rollback', state, { code: rollback && rollback.ok === true ? 'restored' : String(rollback && rollback.error || 'rollback-failed') });
          } catch (_) { emit('project-file-rollback', state, { code: 'rollback-failed' }); }
        }
        state.projectChanges.length = 0;
      }
      if (reason === 'cancelled' && current && current.status === 'cancel_requested') {
        await transitionTerminal(state, 'cancelled', 'runtime_cancelled');
      } else if (current && current.status === 'running') {
        await transitionTerminal(state, 'failed', reason === 'crash' ? 'runtime_interrupted' : 'runtime_failed');
      }
      const code = state.lastModelError || (error instanceof HostAdapterError ? error.code : 'dsh-execution-failed');
      emit('run-failed', state, { code: code, reason: reason });
      return { ok: false, error: code, reason: reason };
    } finally {
      state.sendingAllowed = false;
      if (state.timer) clearTimeout(state.timer);
      for (const controller of state.modelRequests) controller.abort();
      for (const controller of state.workspaceRequests) controller.abort();
      await closeSession(state);
      if (state.child && !state.childExited) {
        try { state.child.stdin.end(); } catch (_) { /* already closed */ }
        await waitForExit(state, 5000).catch(() => terminateChild(state));
      }
      if (state.server) {
        await new Promise(resolve => {
          state.server.close(() => resolve());
          if (typeof state.server.closeAllConnections === 'function') state.server.closeAllConnections();
        });
      }
      active.delete(runId);
      try { fs.rmSync(state.tempDir, { recursive: true, force: true }); } catch (_) { /* temp cleanup is best effort */ }
      state.resolveFinished();
    }
  }

  async function cancel(runId, reason) {
    const state = active.get(String(runId || ''));
    if (!state || state.cancelled) return { ok: false, error: 'run-not-active' };
    state.cancelled = true;
    state.cancelKind = reason === 'timeout' ? 'timeout' : 'cancelled';
    state.sendingAllowed = false;
    if (state.cancelKind === 'cancelled') {
      try {
        const run = readRun(state.runId);
        if (run.status === 'queued' || run.status === 'running') {
          workRunStore.cancel({ runId: run.runId, requestId: makeRequestId('dsh-cancel'), expectedVersion: run.version });
        }
      } catch (_) { /* Consent check still fails closed if Home Node is unavailable */ }
    }
    for (const controller of state.modelRequests) controller.abort();
    for (const controller of state.workspaceRequests) controller.abort();
    state.resolveInterrupt({ kind: state.cancelKind });
    if (state.acp && state.sessionId && !state.childExited) {
      try { state.acp.notify(ACP_METHOD.CANCEL, { sessionId: state.sessionId }); } catch (_) { /* child is unwinding */ }
    }
    emit('run-cancel-requested', state, { reason: state.cancelKind });
    return { ok: true };
  }

  async function finalizeProjectChanges(runId, commit) {
    runId = String(runId || '');
    const journal = pendingProjectChanges.get(runId);
    if (!journal) return { ok: true, noChanges: true };
    let run;
    try { run = readRun(runId); } catch (error) { return { ok: false, error: error.code || 'run-not-found' }; }
    if (commit === true && run.status !== 'completed') return { ok: false, error: 'run-not-completed' };
    if (commit !== true && !['failed', 'cancelled'].includes(run.status)) return { ok: false, error: 'run-not-terminal' };
    clearTimeout(journal.timer);
    if (commit === true) {
      if (typeof journal.commitChanges === 'function') journal.commitChanges();
      pendingProjectChanges.delete(runId);
      return { ok: true, committed: journal.changes.length };
    }
    const failures = [];
    for (const changeId of journal.changes.slice().reverse()) {
      let result;
      try { result = await journal.rollback(changeId); } catch (_) { result = null; }
      if (!result || result.ok !== true) failures.push(String(result && result.error || 'workspace-rollback-failed'));
    }
    pendingProjectChanges.delete(runId);
    return failures.length ? { ok: false, error: 'workspace-rollback-failed', failures: failures.length }
      : { ok: true, rolledBack: journal.changes.length };
  }

  async function close() {
    const states = Array.from(active.values());
    await Promise.all(states.map(state => cancel(state.runId, 'host-stop')));
    await Promise.all(states.map(state => state.finishedPromise));
    for (const [runId, journal] of pendingProjectChanges) {
      clearTimeout(journal.timer);
      let completed = false;
      try { completed = readRun(runId).status === 'completed'; } catch (_) {}
      if (completed && typeof journal.commitChanges === 'function') journal.commitChanges();
      else for (const changeId of journal.changes.slice().reverse()) { try { await journal.rollback(changeId); } catch (_) {} }
      pendingProjectChanges.delete(runId);
    }
    if (webUiHost && typeof webUiHost.close === 'function') {
      try { await webUiHost.close(); } catch (_) { /* the Work Run host remains authoritative */ }
    }
  }

  function startWebUi() {
    if (runtimeUpgradeInProgress) return Promise.resolve({ ok: false, error: 'dsh-runtime-updating' });
    if (!enabled || !webUiHost || typeof webUiHost.start !== 'function') {
      return Promise.resolve({ ok: false, error: 'dsh-web-ui-disabled' });
    }
    return webUiHost.start();
  }

  async function beginRuntimeUpgrade() {
    if (runtimeUpgradeInProgress || active.size > 0 || pendingProjectChanges.size > 0) {
      return { ok: false, error: 'dsh-runtime-upgrade-busy' };
    }
    runtimeUpgradeInProgress = true;
    try {
      if (webUiHost && typeof webUiHost.pauseForRuntimeUpgrade === 'function') {
        const paused = await webUiHost.pauseForRuntimeUpgrade();
        if (!paused || paused.ok !== true) throw new Error(paused && paused.error || 'dsh-web-upgrade-pause-failed');
      }
      return { ok: true };
    } catch (error) {
      runtimeUpgradeInProgress = false;
      return { ok: false, error: String(error && error.message || 'dsh-runtime-upgrade-busy') };
    }
  }

  async function verifyRuntimeUpgrade() {
    if (!runtimeUpgradeInProgress || !runtimeInstalled()) return { ok: false, error: 'dsh-runtime-upgrade-state-invalid' };
    if (!webUiHost || typeof webUiHost.start !== 'function') return { ok: false, error: 'dsh-web-ui-disabled' };
    const result = await webUiHost.start();
    return result && result.ok === true ? { ok: true }
      : { ok: false, error: String(result && result.error || 'dsh-runtime-upgrade-health-check-failed') };
  }

  async function rollbackRuntimeUpgrade() {
    if (webUiHost && typeof webUiHost.pauseForRuntimeUpgrade === 'function') {
      try { await webUiHost.pauseForRuntimeUpgrade(); } catch (_) {}
    }
  }

  async function finishRuntimeUpgrade(options) {
    options = options || {};
    let result = { ok: true };
    if (options.restored === true && runtimeInstalled() && webUiHost && typeof webUiHost.start === 'function') {
      const started = await webUiHost.start();
      if (!started || started.ok !== true) result = { ok: false,
        error: String(started && started.error || 'dsh-runtime-rollback-start-failed') };
    }
    runtimeUpgradeInProgress = false;
    return result;
  }

  function getWebUiBootstrap(parentOrigin) {
    if (!enabled || !webUiHost || typeof webUiHost.bootstrap !== 'function') return null;
    return webUiHost.bootstrap(parentOrigin);
  }

  return Object.freeze({
    run: run,
    cancel: cancel,
    finalizeProjectChanges: finalizeProjectChanges,
    close: close,
    getEvents: getEvents,
    startWebUi: startWebUi,
    beginRuntimeUpgrade: beginRuntimeUpgrade,
    verifyRuntimeUpgrade: verifyRuntimeUpgrade,
    rollbackRuntimeUpgrade: rollbackRuntimeUpgrade,
    finishRuntimeUpgrade: finishRuntimeUpgrade,
    getWebUiBootstrap: getWebUiBootstrap,
    describe: () => {
      let installed = false;
      let installation = { phase: 'idle' };
      try { installed = runtimeInstalled() === true; } catch (_) {}
      try { installation = runtimeInstallationStatus() || installation; } catch (_) {}
      const result = { enabled: enabled && installed, configured: enabled, runtimeInstalled: installed,
        runtimeInstallAvailable: typeof options.runtimeInstallationStatus === 'function',
        runtimeInstallation: installation, runtimeUpgradeInProgress: runtimeUpgradeInProgress,
        dshRevision: DSH_REVISION, activeRuns: active.size, activeRunIds: [...active.keys()] };
      if (webUiHost && typeof webUiHost.describe === 'function') result.webUi = webUiHost.describe();
      return result;
    }
  });
}

module.exports = createDshHostAdapter;
module.exports.DSH_REVISION = DSH_REVISION;
module.exports.HostAdapterError = HostAdapterError;
