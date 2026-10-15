import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const workspace = process.env.IB_DSH_P0_WORKSPACE;
export function inside(value) {
  if (process.env.IB_DEV_SYNTHETIC !== '1' || !workspace || typeof value !== 'string') throw new Error('P0_SYNTHETIC_PATH_REQUIRED');
  const relative = path.relative(path.resolve(workspace), path.resolve(value));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('P0_SYNTHETIC_PATH_ONLY');
  return path.resolve(value);
}
export function official(relative) {
  return import(pathToFileURL(path.join(process.env.IB_DSH_P0_SOURCE, relative)).href);
}
