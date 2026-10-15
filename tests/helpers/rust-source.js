'use strict';

/* Extract one Rust function without swallowing the next command/function. The
   source guards judge a read-only proof on its own body, not a whole-file slice. */
function extractFunction(source, name) {
  const code = String(source || '');
  const marker = 'fn ' + String(name) + '(';
  const start = code.indexOf(marker);
  if (start < 0) throw new Error('Rust function not found: ' + name);
  const open = code.indexOf('{', start + marker.length);
  if (open < 0) throw new Error('Rust function body not found: ' + name);

  let depth = 0;
  let state = 'code';
  let escaped = false;
  let blockDepth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1] || '';
    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '/' && next === '*') { blockDepth++; i++; continue; }
      if (ch === '*' && next === '/') {
        blockDepth--; i++;
        if (blockDepth === 0) state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') state = 'code';
      continue;
    }
    if (ch === '/' && next === '/') { state = 'line-comment'; i++; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; blockDepth = 1; i++; continue; }
    if (ch === '"') { state = 'string'; escaped = false; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error('Rust function body is unbalanced: ' + name);
}

module.exports = Object.freeze({ extractFunction: extractFunction });
