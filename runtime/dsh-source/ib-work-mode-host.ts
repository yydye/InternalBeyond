/** DSH Cordis adapter whose only model and file capabilities are Host RPCs. */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PROVIDER = 'ib-host-proxy'
const MODEL = 'host-proxy-v1'
const MODEL_PORT_URL = process.env.IB_DSH_MODEL_PORT_URL || ''
const HOST_RPC_TOKEN = process.env.IB_DSH_HOST_RPC_TOKEN || ''
const CONFIGURED_TOOLS = (process.env.IB_DSH_ALLOWED_TOOLS || 'project.read_file').split(',').filter(Boolean)
const HOME_NODE_RUN_ID = process.env.IB_DSH_HOME_NODE_RUN_ID || ''
const HOME_NODE_SESSION_ID = process.env.IB_DSH_HOME_NODE_SESSION_ID || ''
let toolCallSequence = 0

type SafeSessionEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function cleanFailure(value: unknown): Record<string, unknown> | undefined {
  const failure = object(value)
  if (!failure) return undefined
  const code = typeof failure.code === 'string' ? failure.code.slice(0, 80) : 'UNKNOWN'
  const message = code === 'AUTH' ? '模型认证失败；详细信息已隐藏。'
    : code === 'CONSENT_DENIED' ? '权限核验未通过。'
      : 'DSH 执行未完成。'
  return { code, message }
}

function safeToolArguments(name: string, value: unknown): Record<string, unknown> {
  const args = object(value) || {}
  if (name === 'project.read_file') return { fileId: String(args.fileId || '').slice(0, 180) }
  const safe: Record<string, unknown> = {}
  for (const key of ['fileId', 'anchorFileId']) {
    if (typeof args[key] === 'string') safe[key] = String(args[key]).slice(0, 180)
  }
  if (typeof args.path === 'string') safe.path = args.path.slice(0, 240)
  if (Object.prototype.hasOwnProperty.call(args, 'content')) safe.content = '[内容已隐藏]'
  return safe
}

function safeToolResultText(value: unknown): string {
  const blocks = Array.isArray(value) ? value : []
  const texts = blocks.map(block => {
    const part = object(block)
    return part?.type === 'text' && typeof part.text === 'string' ? part.text : ''
  }).filter(Boolean)
  for (const text of texts) {
    try {
      const result = object(JSON.parse(text))
      if (!result) continue
      const safe: Record<string, unknown> = {}
      for (const key of ['status', 'fileId', 'path', 'code', 'version', 'size', 'lastModified']) {
        const item = result[key]
        if (typeof item === 'string') safe[key] = item.slice(0, 240)
        else if (Number.isSafeInteger(item) && Number(item) >= 0) safe[key] = Number(item)
      }
      if (typeof result.diff === 'string') safe.diff = result.diff.slice(0, 900)
      if (Array.isArray(result.files)) {
        safe.files = result.files.slice(0, 40).flatMap(entry => {
          const file = object(entry)
          if (!file) return []
          return [{
            ...(typeof file.path === 'string' ? { path: file.path.slice(0, 240) } : {}),
            ...(typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 ? { size: file.size } : {})
          }]
        })
      }
      if (typeof result.content === 'string') safe.content = '[内容已隐藏]'
      if (!Object.keys(safe).length) safe.status = 'completed'
      return JSON.stringify(safe)
    } catch { /* use a small safe outcome below */ }
  }
  return JSON.stringify({ status: 'completed' })
}

/** Project real DSH Session events to the bounded trace DTO accepted by Home Node. */
function safeSessionEvent(event: SessionEvent, stepStartTime?: number): SafeSessionEvent | null {
  const source = event as SessionEvent & { data: Record<string, unknown> }
  const data = source.data
  if (!object(data) || !Number.isSafeInteger(source.seq) || !Number.isFinite(source.time)) return null
  const turn = Number.isSafeInteger(data.turn) ? Number(data.turn) : undefined
  const step = Number.isSafeInteger(data.step) ? Number(data.step) : undefined
  switch (source.type) {
    case 'turn/start': return { type: source.type, seq: source.seq, time: source.time, data: { turn } }
    case 'turn/end': {
      const reason = object(data.reason)
      if (!reason || typeof reason.kind !== 'string') return null
      const safeReason: Record<string, unknown> = { kind: reason.kind.slice(0, 24) }
      if (reason.kind === 'error') safeReason.error = cleanFailure(reason.error)
      return { type: source.type, seq: source.seq, time: source.time, data: { turn, reason: safeReason } }
    }
    case 'step/start':
    case 'step/end': return { type: source.type, seq: source.seq, time: source.time, data: { turn, step } }
    case 'request/header': {
      const header = object(data.header)
      const config = object(header?.config)
      if (!config) return null
      return {
        type: source.type, seq: source.seq, time: source.time,
        data: { turn, step, reason: typeof data.reason === 'string' ? data.reason.slice(0, 24) : 'initial' }
      }
    }
    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name.slice(0, 120) : ''
      if (!name || typeof data.callId !== 'string') return null
      let parsed: unknown = {}
      try { parsed = JSON.parse(String(data.arguments || '{}')) } catch { return null }
      return {
        type: source.type, seq: source.seq, time: source.time,
        data: { turn, step, callId: String(data.callId).slice(0, 180), name,
          arguments: JSON.stringify(safeToolArguments(name, parsed)) }
      }
    }
    case 'tool/result': {
      const message = object(data.message)
      const toolSource = object(message?.source)
      if (typeof toolSource?.callId !== 'string') return null
      const error = cleanFailure(data.error)
      return {
        type: source.type, seq: source.seq, time: source.time,
        data: { turn, step,
          message: { source: { callId: String(toolSource.callId).slice(0, 180) },
            content: [{ type: 'text', text: safeToolResultText(message?.content) }],
            isError: message?.isError === true },
          ...(error ? { error } : {}) }
      }
    }
    case 'assistant/message': {
      const stream = Array.isArray(data.stream) ? data.stream : []
      const firstTokenTime = assistantStreamFirstTokenTime(stream as never[])
      const usage = object(data.usage)
      return {
        type: source.type, seq: source.seq, time: source.time,
        data: { turn, step, ...(usage ? { usage } : {}),
          ...(Number.isSafeInteger(stepStartTime) ? { stepStartTime } : {}),
          ...(Number.isFinite(firstTokenTime) ? { firstTokenTime } : {}),
          ...(data.interrupted === true ? { interrupted: true } : {}) }
      }
    }
    default: return null
  }
}

function assertHostEnvironment(): void {
  if (!MODEL_PORT_URL || HOST_RPC_TOKEN.length < 32) throw new Error('IB_DSH_HOST_CONFIGURATION_INVALID')
  for (const name of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'IB_DSH_API_KEY']) {
    if (process.env[name] !== undefined) throw new Error('IB_DSH_PROVIDER_CREDENTIAL_PRESENT')
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts: unknown[] = value
    return parts.map((part) => {
      if (typeof part === 'string') return part
      if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string') return part.text
      return JSON.stringify(part)
    }).join('\n')
  }
  return value == null ? '' : JSON.stringify(value)
}

type HostEnvelope = { ok?: boolean; error?: string; text?: string; result?: Record<string, unknown> }

async function hostRequest(path: string, body: unknown, signal: AbortSignal): Promise<{ response: Response; value: HostEnvelope }> {
  const base = new URL(MODEL_PORT_URL)
  base.pathname = path
  base.search = ''
  const response = await fetch(base, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${HOST_RPC_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw: unknown = await response.json()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { response, value: { ok: false, error: 'invalid-host-response' } }
  }
  const source = raw as Record<string, unknown>
  const value: HostEnvelope = {}
  if (typeof source.ok === 'boolean') value.ok = source.ok
  if (typeof source.error === 'string') value.error = source.error
  if (typeof source.text === 'string') value.text = source.text
  if (typeof source.result === 'object' && source.result !== null && !Array.isArray(source.result)) {
    value.result = source.result as Record<string, unknown>
  }
  return { response, value }
}

const projectReadFileTool = defineTool({
  name: 'project.read_file',
  description: 'Read one Home Node consented text file by file id.',
  parameters: {
    fileId: { type: 'string', required: true, description: 'The exact consented project file id.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, enum: ['read', 'denied'] },
        fileId: { type: 'string', required: true },
        content: { type: 'string', required: true },
        code: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    try {
      const host = await hostRequest('/project/read_file', { fileId: args.fileId }, exec.signal)
      const result = host.value.result
      if (!host.response.ok || host.value.ok !== true || !result || result.ok !== true
        || typeof result.fileId !== 'string' || typeof result.content !== 'string') {
        const code = typeof host.value.error === 'string' ? host.value.error
          : (result && typeof result.error === 'string' ? result.error : 'project-read-denied')
        return {
          status: 'denied' as const,
          fileId: args.fileId,
          content: '',
          code: code,
        }
      }
      return { status: 'read' as const, fileId: result.fileId, content: result.content, code: '' }
    } catch (error) {
      if (exec.signal.aborted) throw error
      return { status: 'denied' as const, fileId: args.fileId, content: '', code: 'host-unavailable' }
    }
  },
})

const projectWriteSpecs = [
  { name: 'project.create_file', endpoint: '/project/create_file', keys: ['anchorFileId', 'path', 'content'] as string[] },
  { name: 'project.update_file', endpoint: '/project/update_file', keys: ['fileId', 'content'] as string[] },
] as const

function projectWriteTool(spec: typeof projectWriteSpecs[number]) {
  const parameters: Record<string, { type: 'string'; required: true; description: string }> = {}
  for (const key of spec.keys) parameters[key] = {
    type: 'string', required: true,
    description: key === 'content' ? 'Complete UTF-8 text; at most 128 KiB.'
      : key === 'path' ? 'Safe Workspace relative path in an explicitly consented file directory.'
        : 'Exact Home Node consented file id.',
  }
  return defineTool({
    name: spec.name,
    description: spec.name === 'project.create_file'
      ? 'Create a text file in the directory of a Home Node consented Workspace file.'
      : 'Replace one exact Home Node consented Workspace file, after version validation.',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['written', 'denied'] },
        fileId: { type: 'string', required: true }, path: { type: 'string', required: true },
        code: { type: 'string', required: true }, diff: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const request: Record<string, unknown> = {}
      for (const key of spec.keys) request[key] = (args as Record<string, unknown>)[key]
      try {
        const host = await hostRequest(spec.endpoint, request, exec.signal)
        const result = host.value.result
        if (!host.response.ok || host.value.ok !== true || !result || result.ok !== true) {
          return { status: 'denied' as const, fileId: String(result?.fileId || (args as Record<string, unknown>).fileId || ''),
            path: String(result?.path || (args as Record<string, unknown>).path || ''), diff: '',
            code: host.value.error || String(result?.error || 'project-write-denied') }
        }
        return { status: 'written' as const, fileId: String(result.fileId || ''), path: String(result.path || ''),
          code: '', diff: typeof result.diff === 'string' ? result.diff.slice(0, 900) : '' }
      } catch (error) {
        if (exec.signal.aborted) throw error
        return { status: 'denied' as const, fileId: String((args as Record<string, unknown>).fileId || ''),
          path: String((args as Record<string, unknown>).path || ''), code: 'host-unavailable', diff: '' }
      }
    },
  })
}
const projectWriteTools = projectWriteSpecs.map(projectWriteTool)

const draftToolSpecs = [
  { name: 'app_draft.list_files', endpoint: '/app-draft/list_files', keys: [] as string[] },
  { name: 'app_draft.read_file', endpoint: '/app-draft/read_file', keys: ['path'] },
  { name: 'app_draft.create_file', endpoint: '/app-draft/create_file', keys: ['path', 'content'] },
  { name: 'app_draft.update_file', endpoint: '/app-draft/update_file', keys: ['path', 'content'] },
] as const

function appDraftTool(spec: typeof draftToolSpecs[number]) {
  const parameters: Record<string, { type: 'string'; required: true; description: string }> = {}
  if (spec.keys.includes('path')) parameters.path = { type: 'string', required: true, description: 'One of index.html, styles.css, app.js.' }
  if (spec.keys.includes('content')) parameters.content = { type: 'string', required: true, description: 'Complete UTF-8 file contents, at most 64 KiB.' }
  return defineTool({
    name: spec.name,
    description: spec.name === 'app_draft.list_files' ? 'List files in this isolated App Draft.'
      : spec.name === 'app_draft.read_file' ? 'Read one file from this isolated App Draft.'
        : spec.name === 'app_draft.create_file' ? 'Create a missing HTML, CSS, or JavaScript App Draft file.'
          : 'Replace one existing HTML, CSS, or JavaScript App Draft file.',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true, enum: ['ok', 'denied'] },
        path: { type: 'string', required: true }, content: { type: 'string', required: true },
        version: { type: 'number', required: true }, code: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const request: Record<string, unknown> = {}
      for (const key of spec.keys) request[key] = (args as Record<string, unknown>)[key]
      try {
        const host = await hostRequest(spec.endpoint, request, exec.signal)
        const result = host.value.result
        if (!host.response.ok || host.value.ok !== true || !result || result.ok !== true) {
          return { status: 'denied' as const, path: String((args as Record<string, unknown>).path || ''), content: '', version: 0,
            code: host.value.error || String(result && result.error || 'app-draft-tool-denied') }
        }
        return { status: 'ok' as const, path: String(result.path || ''),
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.files || result),
          version: Number.isSafeInteger(result.version) ? Number(result.version) : 0, code: '' }
      } catch (error) {
        if (exec.signal.aborted) throw error
        return { status: 'denied' as const, path: String((args as Record<string, unknown>).path || ''), content: '', version: 0, code: 'host-unavailable' }
      }
    },
  })
}

const appDraftTools = draftToolSpecs.map(appDraftTool)
const hostTools = [projectReadFileTool, ...projectWriteTools, ...appDraftTools]

class InternalBeyondHostLlmAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    if (provider !== PROVIDER) throw new Error(`unknown InternalBeyond host provider: ${provider}`)
    return { id: provider, name: 'InternalBeyond Host ModelPort' }
  }

  override listModels(provider: string) {
    if (provider !== PROVIDER) return Promise.resolve([])
    return Promise.resolve([{ provider, id: MODEL, name: 'Host ModelPort', inputModalities: ['text'] as const }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Host ModelPort',
      inputModalities: ['text'],
      context: { contextWindow: 2048 },
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolNames = (options.tools ?? []).map(tool => tool.name).sort()
    const expectedTools = CONFIGURED_TOOLS.slice().sort()
    if (toolNames.length !== expectedTools.length || toolNames.some((name, index) => name !== expectedTools[index])) {
      throw new LlmError('IB_DSH_TOOLSET_MISMATCH', 'CONSENT_DENIED')
    }
    const messages = options.messages.map(message => ({ role: message.role, content: contentText(message.content) }))
    const host = await hostRequest('/model/run', { messages }, options.signal)
    if (!host.response.ok || host.value.ok !== true || typeof host.value.text !== 'string') {
      if (options.signal.aborted) options.signal.throwIfAborted()
      throw new LlmError(`IB_DSH_HOST_MODEL_BLOCKED: ${host.value.error || host.response.status}`, 'CONSENT_DENIED')
    }
    options.signal.throwIfAborted()
    let decoded: unknown
    try { decoded = JSON.parse(host.value.text) } catch { decoded = null }
    if (typeof decoded === 'object' && decoded !== null && 'action' in decoded && decoded.action === 'call_tool') {
      const action = decoded as { name?: string; arguments?: Record<string, unknown> }
      const tool = hostTools.find(candidate => candidate.name === action.name)
      const keys = action.arguments && typeof action.arguments === 'object' ? Object.keys(action.arguments).sort() : []
      const allowedKeys = action.name === projectReadFileTool.name ? ['fileId']
        : projectWriteSpecs.find(spec => spec.name === action.name)?.keys.slice().sort()
          ?? draftToolSpecs.find(spec => spec.name === action.name)?.keys.slice().sort()
      if (!tool || !expectedTools.includes(tool.name) || !action.arguments || !allowedKeys
        || keys.join(',') !== allowedKeys.join(',')
        || keys.some(key => typeof action.arguments?.[key] !== 'string')) {
        throw new LlmError('IB_DSH_MODEL_TOOL_REQUEST_INVALID', 'CONSENT_DENIED')
      }
      const callId = ToolCallId(`ib-host-tool-${++toolCallSequence}`)
      const argumentsText = JSON.stringify(action.arguments)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: tool.name, argumentsDelta: argumentsText }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: callId, name: tool.name, arguments: argumentsText },
      }
      yield { type: 'usage', usage: { inputTokens: 24, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: host.value.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: host.value.text } }
    yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 24 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'ib-work-mode-host-adapter'
export const inject = ['llm', 'tools', 'sessions']

export function apply(ctx: Context): void {
  assertHostEnvironment()
  ctx.llm.registerAdapter([PROVIDER], new InternalBeyondHostLlmAdapter())
  hostTools.filter(tool => CONFIGURED_TOOLS.includes(tool.name)).forEach(tool => ctx.tools.register(tool))
  const allowed = new Set(CONFIGURED_TOOLS)
  ctx.tools.guard(execution => allowed.has(execution.name) ? undefined : 'IB_DSH_TOOL_DENIED')

  /* Forward a strict, display-safe projection of the real ACP Session events.
     The full model/tool payload stays in this ephemeral DSH Session; Home Node
     receives only the fields the DSH native Trajectory needs. */
  const eventTails = new Map<string, Promise<void>>()
  const stepStarts = new Map<string, number>()
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!HOME_NODE_RUN_ID || !HOME_NODE_SESSION_ID) return
    const data = event.data as { turn?: number; step?: number }
    const stepKey = `${session.id}:${String(data.turn ?? '')}:${String(data.step ?? '')}`
    if (event.type === 'step/start' && Number.isSafeInteger(event.time)) stepStarts.set(stepKey, event.time)
    const projected = safeSessionEvent(event, stepStarts.get(stepKey))
    if (projected === null) return
    const previous = eventTails.get(session.id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const { response, value } = await hostRequest('/session/event', {
        runId: HOME_NODE_RUN_ID,
        dshSessionId: HOME_NODE_SESSION_ID,
        childSessionId: session.id,
        event: projected,
      }, AbortSignal.timeout(2500))
      if (!response.ok || value.ok !== true) throw new Error(value.error || 'work-mode-event-relay-failed')
    }).catch(() => undefined)
    eventTails.set(session.id, next)
    if (event.type === 'step/end') stepStarts.delete(stepKey)
    return next
  })
  ctx.on('session/flush', (session: Session) => eventTails.get(session.id) ?? Promise.resolve())
}
