// Synthetic extensions loaded by the pinned official DSH Web profile.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inside } from './containment.mjs';
import { appendWorkModeTraceSnapshot, appendWorkModeUserMessage, RUN_ID_RE, SESSION_ID_RE } from './work-mode-trace-host.mjs';
const source = process.env.IB_DSH_P0_SOURCE;
const load = relative => import(pathToFileURL(path.join(source, relative)).href);
const { LlmAdapter, LlmError, createUserMessage } = await load('packages/llm/llm/lib/index.js');
const { DirectoryPicker } = await load('packages/host/directory-picker/lib/index.js');
const { appendPluginRecord } = await load('packages/core/session/lib/index.js');

const PROVIDER = 'ib-home-node-run-required';
const MODEL = 'consent-bound-session-only';
const root = process.env.IB_DSH_P0_WORKSPACE;

class FakeAdapter extends LlmAdapter {
  providerInfo() { return { id: PROVIDER, name: 'Home Node · Bound Work Run' }; }
  async listModels() { return [{ provider: PROVIDER, id: MODEL, name: 'Work Run bound only', inputModalities: ['text'] }]; }
  async resolveModel(provider, model) {
    if (provider !== PROVIDER || model !== MODEL) throw new Error('synthetic-model-only');
    return { provider, id: model, name: 'Work Run bound only', inputModalities: ['text'], context: { contextWindow: 32768 } };
  }
  async *stream(options) {
    options.signal.throwIfAborted();
    throw new LlmError('IB_WORK_RUN_REQUIRED', 'CONSENT_DENIED');
  }
}

class SyntheticPicker extends DirectoryPicker {
  capability() { return { kind: 'native', pick: async () => root }; }
}

export const name = 'ib-native-work-ui-p0';
export const inject = ['llm', 'tools', 'webServer'];
export function apply(ctx) {
  if (process.env.IB_DEV_SYNTHETIC !== '1' || !root) {
    throw new Error('synthetic-environment-required');
  }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new FakeAdapter()));
  ctx.effect(() => ctx.tools.guard(() => 'IB_HOME_NODE_WORK_RUN_REQUIRED'));
  ctx.plugin(SyntheticPicker);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/ib/work-mode/trace', handler: async (req, res) => {
    const reply = (status, body) => {
      if (res.destroyed) return;
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text, 'utf8') });
      res.end(text);
    };
    if (req.method !== 'POST') { reply(405, { ok: false, error: 'method-not-allowed' }); return; }
    const origin = String(req.headers.origin || '');
    const expectedOrigin = `${ctx.webServer.protocol}//${ctx.webServer.host}:${ctx.webServer.port}`;
    if (origin && origin !== expectedOrigin) { reply(403, { ok: false, error: 'origin-denied' }); return; }
    let bodyText = '';
    try {
      for await (const chunk of req) {
        bodyText += Buffer.from(chunk).toString('utf8');
        if (Buffer.byteLength(bodyText, 'utf8') > 128 * 1024) { reply(413, { ok: false, error: 'body-too-large' }); return; }
      }
    } catch (_) { reply(400, { ok: false, error: 'request-disconnected' }); return; }
    let body;
    try { body = JSON.parse(bodyText); } catch (_) { reply(400, { ok: false, error: 'invalid-json' }); return; }
    const expectedKeys = ['at', 'errorCode', 'events', 'model', 'phase', 'promptSummary', 'provider', 'runId', 'sessionId', 'summary'];
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== expectedKeys.sort().join(',')
      || !SESSION_ID_RE.test(String(body.sessionId || '')) || !RUN_ID_RE.test(String(body.runId || ''))
      || !Array.isArray(body.events) || body.events.length > 512) {
      reply(400, { ok: false, error: 'invalid-trace-request' }); return;
    }
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    if (!sessions || typeof sessions.get !== 'function') {
      reply(503, { ok: false, error: 'session-controller-unavailable' }); return;
    }
    const session = sessions.get(body.sessionId);
    if (!session || !session.header || typeof session.header.cwd !== 'string') {
      reply(404, { ok: false, error: 'session-unavailable' }); return;
    }
    try { inside(session.header.cwd); }
    catch (_) { reply(403, { ok: false, error: 'session-outside-synthetic-workspace' }); return; }
    try {
      const result = appendWorkModeTraceSnapshot({
        session,
        appendRecord: appendPluginRecord,
        runId: body.runId,
        phase: body.phase,
        events: body.events,
        provider: body.provider,
        model: body.model,
        promptSummary: body.promptSummary,
        summary: body.summary,
        errorCode: body.errorCode,
        at: body.at,
        appendUserMessage: (target, input) => {
          const message = createUserMessage({
            content: [{ type: 'text', text: String(input.prompt || '').slice(0, 2400) }],
            source: { kind: 'user', rpcId: String(input.runId || '') }
          });
          target.append('user/message', message, { surfaceOp: 'append' });
          return true;
        }
      });
      reply(result.ok === true ? 200 : 400, result);
    } catch (_) { reply(409, { ok: false, error: 'session-trace-append-failed' }); }
  } }), 'ib-native-work-ui-p0: work-mode trajectory bridge');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/ib/work-mode/task', handler: async (req, res) => {
    const reply = (status, body) => {
      if (res.destroyed) return;
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text, 'utf8') });
      res.end(text);
    };
    if (req.method !== 'POST') { reply(405, { ok: false, error: 'method-not-allowed' }); return; }
    const origin = String(req.headers.origin || '');
    const expectedOrigin = `${ctx.webServer.protocol}//${ctx.webServer.host}:${ctx.webServer.port}`;
    if (origin && origin !== expectedOrigin) { reply(403, { ok: false, error: 'origin-denied' }); return; }
    let text = '';
    try {
      for await (const chunk of req) {
        text += Buffer.from(chunk).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > 8192) { reply(413, { ok: false, error: 'body-too-large' }); return; }
      }
    } catch (_) { reply(400, { ok: false, error: 'request-disconnected' }); return; }
    let body;
    try { body = JSON.parse(text); } catch (_) { reply(400, { ok: false, error: 'invalid-json' }); return; }
    const expectedKeys = ['prompt', 'runId', 'sessionId'];
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== expectedKeys.join(',')
      || !SESSION_ID_RE.test(String(body.sessionId || '')) || !RUN_ID_RE.test(String(body.runId || ''))
      || typeof body.prompt !== 'string' || body.prompt.length > 2400) {
      reply(400, { ok: false, error: 'invalid-task-message' }); return;
    }
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(body.sessionId) : null;
    if (!session || !session.header || typeof session.header.cwd !== 'string') { reply(404, { ok: false, error: 'session-unavailable' }); return; }
    try { inside(session.header.cwd); }
    catch (_) { reply(403, { ok: false, error: 'session-outside-synthetic-workspace' }); return; }
    const result = appendWorkModeUserMessage({ session, runId: body.runId, prompt: body.prompt,
      appendUserMessage: (target, input) => {
        const message = createUserMessage({ content: [{ type: 'text', text: String(input.prompt || '').slice(0, 2400) }],
          source: { kind: 'user', rpcId: String(input.runId || '') } });
        target.append('user/message', message, { surfaceOp: 'append' });
        return true;
      } });
    reply(result.ok === true ? 200 : 400, result);
  } }), 'ib-native-work-ui-p0: accepted task message');
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('<head>',
    '<head><meta name="ib-dsh-p0" content="synthetic">' +
    '<style>.ib-work-run-session{display:grid;gap:12px;margin:12px auto;max-width:900px;max-height:min(42vh,360px);overflow:auto;align-content:start;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-container-fill-l2,transparent);color:inherit}.ib-work-run-heading{display:grid;gap:6px}.ib-work-run-events{display:grid;gap:4px;max-height:160px;overflow:auto;font-size:12px}.ib-work-run-result{max-height:42vh;overflow:auto}.ib-work-run-result[data-app-builder-artifact]{height:auto;max-height:none;overflow:visible}.ib-work-run-result ol{display:grid;gap:8px;padding-inline-start:24px}.ib-work-run-result li{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l2);line-height:1.45}.ib-work-run-result li button{margin-inline-start:10px}.ib-work-run-consent details{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-container-fill-l1,transparent)}.ib-work-run-consent details summary{cursor:pointer;font-weight:600}.ib-work-run-consent details p{font-size:12px;line-height:1.5}.ib-work-run-finding{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2)}.ib-work-run-session button{justify-self:start}.ib-app-builder-entry{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-container-fill-l1,transparent)}.ib-app-builder-entry label{display:flex;align-items:center;gap:8px;font-size:12px}.ib-app-builder-entry select{max-width:min(320px,60vw);min-height:32px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-container-fill-l1,transparent);color:inherit;font:inherit}.ib-app-builder-entry p{margin:0;font-size:12px;line-height:1.4;opacity:.76}.ib-executor-selector{position:relative;display:inline-flex;max-width:360px;color:inherit;font:inherit}.ib-executor-trigger{display:inline-flex;align-items:center;gap:8px;min-width:185px;max-width:360px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-container-fill-l2,transparent);color:inherit;text-align:left;cursor:pointer}.ib-executor-avatar{width:24px;height:24px;flex:0 0 24px;border-radius:50%;object-fit:cover}.ib-executor-avatar-fallback{display:grid;place-items:center;background:var(--dsw-alias-container-fill-l3,rgba(127,147,166,.18));font-size:12px}.ib-executor-trigger-copy{display:grid;min-width:0;line-height:1.25}.ib-executor-trigger-copy strong,.ib-executor-trigger-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ib-executor-trigger-copy span{font-size:11px;opacity:.72}.ib-executor-menu{position:absolute;z-index:10000;right:0;bottom:calc(100% + 8px);display:grid;gap:10px;width:min(360px,84vw);max-height:70vh;overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-container-fill-l2,#f7f9fb);color:inherit;box-shadow:0 8px 28px rgba(25,42,60,.16)}.ib-executor-menu label{display:grid;gap:5px;font-size:12px}.ib-executor-menu select,.ib-executor-menu button{min-height:34px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-container-fill-l1,transparent);color:inherit;font:inherit}.ib-executor-menu button{justify-self:start;cursor:pointer}.ib-executor-menu button:disabled{opacity:.48;cursor:not-allowed}.ib-executor-menu-note{margin:0;font-size:11px;line-height:1.5;opacity:.78}.ib-executor-menu [role=alert]{color:var(--dsw-alias-color-danger,#b42318);font-size:12px}.ib-work-run-session{display:block;flex:0 0 auto;min-height:34px;max-width:900px;margin:4px auto;padding:0;border:0;border-radius:0;background:transparent;color:inherit}.ib-dsh-work-entry{display:flex;align-items:center;gap:8px;min-height:34px;margin:2px 0;font:inherit}.ib-dsh-work-entry button{padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-container-fill-l1,transparent);color:inherit;font:inherit;cursor:pointer}.ib-dsh-work-entry [role=status]{font-size:12px;opacity:.72}.ib-work-run-details{display:grid;gap:12px;margin:8px auto;max-width:900px;max-height:min(42vh,360px);overflow:auto;align-content:start;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-container-fill-l2,transparent);color:inherit}.ib-work-run-details button{justify-self:start}.ib-work-run-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.ib-work-run-history>details>summary{cursor:pointer;font-weight:600;opacity:.82}</style>' +
    '<style>.ib-executor-selector{max-width:252px;min-width:195px;display:inline-grid;grid-template-columns:minmax(0,1fr);padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-container-fill-l2,transparent)}.ib-executor-trigger{display:grid;grid-template-rows:auto auto;width:100%;min-width:0;max-width:252px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;box-shadow:none}.ib-executor-role-trigger,.ib-executor-profile-trigger{display:flex;align-items:center;gap:6px;min-width:0;min-height:31px;padding:3px 6px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.ib-executor-role-trigger:hover,.ib-executor-profile-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,transparent)}.ib-executor-role-trigger:disabled,.ib-executor-profile-trigger:disabled{opacity:.55;cursor:not-allowed}.ib-executor-avatar{width:21px;height:21px;flex:0 0 21px;border-radius:50%;object-fit:cover}.ib-executor-avatar-fallback{display:grid;place-items:center;background:var(--dsw-alias-container-fill-l3,rgba(127,147,166,.18));font-size:11px}.ib-executor-role-copy,.ib-executor-profile-copy{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600}.ib-executor-profile-trigger{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:3px;row-gap:0}.ib-executor-profile-copy{font-size:11px}.ib-executor-profile-kind{grid-column:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;opacity:.72}.ib-executor-chevron{flex:0 0 auto;margin-inline-start:auto;font-size:13px;opacity:.72}.ib-executor-menu{width:min(330px,84vw);padding:12px;color:var(--dsw-alias-label-primary,currentColor);color-scheme:inherit}.ib-executor-menu h3{margin:0 0 2px;font-size:13px;font-weight:650}.ib-executor-menu button{color:inherit}.ib-executor-menu .ib-executor-option{display:flex;align-items:center;justify-self:stretch;gap:9px;width:100%;min-height:42px;padding:7px 8px;background:transparent;text-align:left}.ib-executor-menu .ib-executor-option[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover,transparent);border-color:var(--dsw-alias-brand-primary,currentColor)}.ib-executor-option-copy{display:grid;min-width:0;gap:2px}.ib-executor-option-copy strong,.ib-executor-option-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ib-executor-option-copy strong{font-size:12px;font-weight:600}.ib-executor-option-copy span{font-size:10px;opacity:.76}.ib-executor-profile-option{padding-inline-start:10px!important}.ib-work-run-session{min-height:0;padding:0;border:0;background:transparent}.ib-work-run-session[data-work-details-open="false"]{max-height:none;overflow:visible}.ib-dsh-work-entry{min-height:24px;margin:2px 0}.ib-dsh-work-entry button{padding:4px 8px}.ib-dsh-brand-mark{display:block;flex:0 0 auto;color:var(--dsw-alias-brand-primary,currentColor)}.ib-dsh-brand-name{font-weight:650;letter-spacing:.05em}.ib-work-record-menu-item{width:100%;text-align:left}.ib-dsh-about{display:grid;gap:10px;max-width:620px;font-size:13px;line-height:1.65}.ib-dsh-about h3,.ib-dsh-about p{margin:0}.ib-dsh-theme-follow-row{display:grid;gap:6px;padding:10px 0;color:var(--dsw-alias-label-primary,currentColor);line-height:1.5}.ib-dsh-theme-follow-row strong{font-size:13px;font-weight:600}.ib-dsh-theme-follow-row span{font-size:12px;color:var(--dsw-alias-label-tertiary,currentColor)}[data-ib-host-theme-row="true"]{display:none!important}[data-agent-preset-id="synthetic-p0"] code{display:none!important}</style>')));
}
