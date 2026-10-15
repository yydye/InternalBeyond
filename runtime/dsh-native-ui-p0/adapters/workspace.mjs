import { inside, official } from '../containment.mjs';
const { WorkspaceRegistry } = await official('packages/workspace/workspace/lib/index.js');
export default class SyntheticWorkspaceRegistry extends WorkspaceRegistry {
  create(directory, title) { return super.create(inside(directory), title); }
  resolveByPath(directory) { return super.resolveByPath(inside(directory)); }
}
