'use strict';

/* Internal, fixed-purpose preflight worker. It waits until the Executor has
   captured process ownership before running synchronous Inspector probes. */

const environmentInspector = require('./environment-inspector.js');

let request = null;
let started = false;
let input = '';
try { request = JSON.parse(process.argv[2] || ''); } catch (_) { request = null; }

function runInspection() {
  if (started) return;
  started = true;
  if (!request || typeof request.root !== 'string' || request.target !== 'windows-installer' ||
      !['release', 'test'].includes(request.mode)) {
    process.exitCode = 1;
    return;
  }
  try {
    const result = environmentInspector.inspectEnvironment({
      root: request.root,
      target: request.target,
      mode: request.mode
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = 0;
  } catch (_) {
    process.exitCode = 1;
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  const newline = input.indexOf('\n');
  if (newline < 0) return;
  const command = input.slice(0, newline).trim();
  input = '';
  if (command === 'GO') runInspection();
  else process.exitCode = 1;
});
process.stdin.on('end', () => {
  if (!started) process.exitCode = 0;
});
