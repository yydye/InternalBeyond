// Production DSH browser surface. Model calls and tools are fail-closed here;
// actual Work Runs execute through the bound Home Node ACP adapter.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendWorkModeTraceSnapshot,
  appendWorkModeUserMessage,
  RUN_ID_RE,
  SESSION_ID_RE,
} from './work-mode-trace-host.mjs';

const runtimeRoot = path.resolve(process.env.IB_DSH_RUNTIME_ROOT || '');
const workspaceRoot = path.resolve(process.env.IB_DSH_WORKSPACE_ROOT || '');
const loadRuntime = relative => import(pathToFileURL(path.join(runtimeRoot, 'node_modules', relative)).href);
const [{ LlmAdapter, LlmError, createUserMessage }, { appendPluginRecord }] = await Promise.all([
  loadRuntime('@deepseek-ai/dsh-llm/src/index.ts'),
  loadRuntime('@deepseek-ai/dsh-session/src/index.ts'),
]);

const PROVIDER = 'ib-home-node-run-required';
const MODEL = 'consent-bound-session-only';

function assertEnvironment() {
  if (process.env.IB_DSH_NATIVE_MODE !== 'production'
    || process.env.IB_DSH_EMBEDDED_TAURI !== '1'
    || process.env.IB_DEV_MODE === '1' || process.env.IB_DEV_SYNTHETIC === '1'
    || !runtimeRoot || !workspaceRoot) {
    throw new Error('production-dsh-host-environment-required');
  }
  if (!/^[a-f0-9]{32}$/i.test(String(process.env.IB_TAURI_HOST_INSTANCE_ID || ''))) {
    throw new Error('production-tauri-host-identity-required');
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const expectedRoot = path.resolve(localAppData, 'InternalBeyond', 'dsh-work-mode', 'workspace');
  if (!localAppData || workspaceRoot.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error('production-dsh-workspace-root-invalid');
  }
  for (const name of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'IB_DSH_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    if (process.env[name] !== undefined) throw new Error('provider-egress-environment-denied');
  }
  for (let current = workspaceRoot; current !== path.dirname(current); current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('dsh-workspace-reparse-point-denied'); }
    catch (error) { if (error && error.code !== 'ENOENT') throw error; }
  }
}

function insideWorkspace(value) {
  if (typeof value !== 'string' || !value) throw new Error('dsh-session-workspace-required');
  const candidate = path.resolve(value);
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('dsh-session-outside-private-work-area');
  }
}

class HomeNodeRunRequiredAdapter extends LlmAdapter {
  providerInfo() { return { id: PROVIDER, name: 'Home Node · 已授权 Run' }; }
  async listModels() {
    return [{ provider: PROVIDER, id: MODEL, name: 'Home Node Work Run', inputModalities: ['text'] }];
  }
  async resolveModel(provider, model) {
    if (provider !== PROVIDER || model !== MODEL) throw new Error('home-node-run-model-only');
    return { provider, id: model, name: 'Home Node Work Run', inputModalities: ['text'], context: { contextWindow: 32768 } };
  }
  async *stream(options) {
    options.signal.throwIfAborted();
    throw new LlmError('IB_HOME_NODE_WORK_RUN_REQUIRED', 'CONSENT_DENIED');
  }
}

function sendJson(res, status, value) {
  if (res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body, 'utf8') });
  res.end(body);
}

async function readJson(req, limit) {
  let text = '';
  for await (const chunk of req) {
    text += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('body-too-large');
  }
  return JSON.parse(text);
}

export const name = 'ib-native-work-ui-production';
export const inject = ['llm', 'tools', 'webServer'];

export function apply(ctx) {
  assertEnvironment();
  ctx.llm.registerAdapter([PROVIDER], new HomeNodeRunRequiredAdapter());
  // The browser DSH surface is not an execution authority. Work Mode creates
  // a Home Node Run first; the per-Run ACP child receives only its snapshot.
  ctx.tools.guard(() => 'IB_HOME_NODE_WORK_RUN_REQUIRED');

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/ib/work-mode/trace', handler: async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
    const origin = String(req.headers.origin || '');
    const expectedOrigin = `${ctx.webServer.protocol}//${ctx.webServer.host}:${ctx.webServer.port}`;
    if (!origin || origin !== expectedOrigin) { sendJson(res, 403, { ok: false, error: 'origin-denied' }); return; }
    let body;
    try { body = await readJson(req, 128 * 1024); }
    catch (error) { sendJson(res, String(error && error.message) === 'body-too-large' ? 413 : 400,
      { ok: false, error: String(error && error.message) === 'body-too-large' ? 'body-too-large' : 'invalid-json' }); return; }
    const expectedKeys = ['at', 'errorCode', 'events', 'model', 'phase', 'promptSummary', 'provider', 'runId', 'sessionId', 'summary'];
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== expectedKeys.slice().sort().join(',')
      || !SESSION_ID_RE.test(String(body.sessionId || '')) || !RUN_ID_RE.test(String(body.runId || ''))
      || !Array.isArray(body.events) || body.events.length > 512) {
      sendJson(res, 400, { ok: false, error: 'invalid-trace-request' }); return;
    }
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(body.sessionId) : null;
    if (!session || !session.header) { sendJson(res, 404, { ok: false, error: 'session-unavailable' }); return; }
    try { insideWorkspace(session.header.cwd); }
    catch (_) { sendJson(res, 403, { ok: false, error: 'session-outside-private-work-area' }); return; }
    try {
      const result = appendWorkModeTraceSnapshot({
        session, appendRecord: appendPluginRecord, runId: body.runId, phase: body.phase,
        events: body.events, provider: body.provider, model: body.model,
        promptSummary: body.promptSummary, summary: body.summary,
        errorCode: body.errorCode, at: body.at,
        appendUserMessage: (target, input) => {
          const message = createUserMessage({
            content: [{ type: 'text', text: String(input.prompt || '').slice(0, 2400) }],
            source: { kind: 'user', rpcId: String(input.runId || '') }
          });
          target.append('user/message', message, { surfaceOp: 'append' });
          return true;
        }
      });
      sendJson(res, result.ok === true ? 200 : 400, result);
    } catch (_) { sendJson(res, 409, { ok: false, error: 'session-trace-append-failed' }); }
  } }), 'ib-native-work-ui: Home Node Run trace projection');

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/ib/work-mode/task', handler: async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
    const origin = String(req.headers.origin || '');
    const expectedOrigin = `${ctx.webServer.protocol}//${ctx.webServer.host}:${ctx.webServer.port}`;
    if (!origin || origin !== expectedOrigin) { sendJson(res, 403, { ok: false, error: 'origin-denied' }); return; }
    let body;
    try { body = await readJson(req, 8192); }
    catch (error) { sendJson(res, String(error && error.message) === 'body-too-large' ? 413 : 400,
      { ok: false, error: String(error && error.message) === 'body-too-large' ? 'body-too-large' : 'invalid-json' }); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== 'prompt,runId,sessionId'
      || !SESSION_ID_RE.test(String(body.sessionId || '')) || !RUN_ID_RE.test(String(body.runId || ''))
      || typeof body.prompt !== 'string' || body.prompt.length > 2400) {
      sendJson(res, 400, { ok: false, error: 'invalid-task-message' }); return;
    }
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(body.sessionId) : null;
    if (!session || !session.header) { sendJson(res, 404, { ok: false, error: 'session-unavailable' }); return; }
    try { insideWorkspace(session.header.cwd); }
    catch (_) { sendJson(res, 403, { ok: false, error: 'session-outside-private-work-area' }); return; }
    const result = appendWorkModeUserMessage({
      session, runId: body.runId, prompt: body.prompt,
      appendUserMessage: (target, input) => {
        const message = createUserMessage({
          content: [{ type: 'text', text: String(input.prompt || '').slice(0, 2400) }],
          source: { kind: 'user', rpcId: String(input.runId || '') }
        });
        target.append('user/message', message, { surfaceOp: 'append' });
        return true;
      }
    });
    sendJson(res, result.ok === true ? 200 : 400, result);
  } }), 'ib-native-work-ui: Home Node Run task projection');
}
