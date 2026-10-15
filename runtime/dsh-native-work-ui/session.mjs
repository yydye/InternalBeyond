// DSH UI sessions are confined to the private Home Node Work Mode scratch
// directory. Workspace reads and writes remain Home Node Run tools only.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimeRoot = path.resolve(process.env.IB_DSH_RUNTIME_ROOT || '');
const workspaceRoot = path.resolve(process.env.IB_DSH_WORKSPACE_ROOT || '');
const modulePath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'src', 'index.ts');
const { SessionController } = await import(pathToFileURL(modulePath).href);
const allowedPresets = new Set(['general', 'coding', 'research', 'app-builder']);

function insideWorkspace(value) {
  const resolved = path.resolve(String(value || workspaceRoot));
  const relative = path.relative(workspaceRoot, resolved);
  if (!workspaceRoot || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('dsh-session-outside-private-work-area');
  }
  return resolved;
}

export default class HomeNodeWorkModeSessionController extends SessionController {
  create(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid-session-request');
    const cwd = insideWorkspace(request.cwd || workspaceRoot);
    const preset = String(request.agentPreset || 'general');
    if (!allowedPresets.has(preset)) throw new Error('work-mode-agent-preset-denied');
    return super.create(Object.assign({}, request, { cwd: cwd, agentPreset: preset }));
  }
}
