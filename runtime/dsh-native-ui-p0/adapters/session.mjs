// Reuse the official controller, descriptors, validation, and Gateway.
import { inside, official } from '../containment.mjs';
const { SessionController } = await official('packages/api/session-controller/lib/index.js');
const WORK_MODE_PRESETS = new Set(['synthetic-p0', 'coding', 'research', 'app-builder']);
export default class SyntheticSessionController extends SessionController {
  create(request) {
    if (request.cwd !== undefined) inside(request.cwd);
    if (request.agentPreset !== undefined && !WORK_MODE_PRESETS.has(String(request.agentPreset))) {
      throw new Error('P0_WORK_MODE_PRESET_NOT_ALLOWED');
    }
    return super.create(request);
  }
}
