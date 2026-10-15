import path from 'node:path';
import { inside, official, workspace } from '../containment.mjs';
const { LocalFileSystem } = await official('packages/fs/fs-local/lib/index.js');
export default class SyntheticFileSystem extends LocalFileSystem {
  async resolve(value, options) {
    const selected = inside(path.resolve(options?.cwd || workspace, value));
    const target = await super.resolve(selected, options);
    inside(target.targetKey);
    return target;
  }
  lstat(value, options, signal) { return super.lstat(inside(path.resolve(options?.cwd || workspace, value)), options, signal); }
  processPathFromHostPath(value) { try { return inside(value); } catch (_) { return undefined; } }
  writeText() { throw new Error('P0_FILESYSTEM_READONLY'); }
  editText() { throw new Error('P0_FILESYSTEM_READONLY'); }
}
