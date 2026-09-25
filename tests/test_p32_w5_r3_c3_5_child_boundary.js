'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rust = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'services', 'home-node', 'reconstruction-runner.js'), 'utf8');
const probe = fs.readFileSync(path.join(root, 'services', 'home-node', 'c35 child boundary probe 子进程.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'Recovery.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'assets', 'js', 'recovery-c3-5-reconstruction.js'), 'utf8');

function functionSource(source, name, endPattern) {
  const start = source.indexOf(name);
  assert.notStrictEqual(start, -1, name + ' is present');
  const end = source.indexOf(endPattern, start);
  assert.notStrictEqual(end, -1, name + ' has a bounded source region');
  return source.slice(start, end);
}

/* Node entry proof must be the first executable body in the runner and precede
   all imported modules. */
const runnerEntry = runner.indexOf("process.stderr.write('C35_NODE_ENTRY_REACHED\\n')");
const firstRunnerImport = runner.indexOf("require('path')");
assert(runnerEntry >= 0 && firstRunnerImport > runnerEntry, 'runner entry marker precedes imports');
assert(runner.slice(0, runnerEntry).trim() === "'use strict';\n\n/* Earliest safe evidence that Node entered this CommonJS file. Keep this\n   fixed marker before module imports and avoid all file/database access. */\nif (require.main === module) {\n  try {", 'runner marker remains at earliest executable location');

/* The packaged fixture intentionally has one operation: write a fixed marker. */
assert.match(probe, /^'use strict';[\s\S]*process\.stdout\.write\('C35_NODE_ENTRY_REACHED\\n'\);\s*$/);
assert.doesNotMatch(probe, /require\s*\(|import\s|node:sqlite|fetch\s*\(|readFile|writeFile|process\.env/);

const nativeSpawn = functionSource(rust, 'fn c35_spawn_native_child(', '\nfn c35_native_spawn_context(');
assert.match(nativeSpawn, /Command::new\(executable\)/);
assert.match(nativeSpawn, /\.args\(arguments\)/);
assert.match(nativeSpawn, /\.current_dir\(cwd\)/);
assert.match(nativeSpawn, /stdin\(Stdio::piped\(\)\)/);
assert.match(nativeSpawn, /stdout\(Stdio::piped\(\)\)/);
assert.match(nativeSpawn, /stderr\(Stdio::piped\(\)\)/);
assert.match(nativeSpawn, /command\.creation_flags\(CREATE_NO_WINDOW\)/);
assert.match(nativeSpawn, /C35_CHILD_SPAWN_ATTEMPTED/);
assert.match(nativeSpawn, /C35_CHILD_PROCESS_STARTED/);
assert.match(nativeSpawn, /C35_CHILD_EXIT_RECEIVED/);
assert.doesNotMatch(nativeSpawn, /env_clear\s*\(|\.env\s*\(/);

const dryRun = functionSource(rust, 'fn p32_w5_r3_c3_5_reconstruction_dry_run(', '\nstruct C35RunnerOutputCheck');
assert.match(dryRun, /c35_spawn_native_child\(&node, &child_arguments, &root, Some\(&request_bytes\)\)/);
const probeCommand = functionSource(rust, 'fn p32_w5_r3_c3_5_child_process_boundary_probe(', '\n#[tauri::command(rename_all = "camelCase")]\nfn p32_w5_r3_c3_5_reconstruction_dry_run(');
assert.match(probeCommand, /c35_spawn_native_child\(&executable, &arguments, &root, None\)/);
assert.match(probeCommand, /writeAllowed": false/);
assert.match(probeCommand, /applyAllowed": false/);
assert.match(probeCommand, /databaseOpened": false/);
assert.doesNotMatch(probeCommand, /ProductionReconstructionAdapter|reconstruction-runner\.js|Sqlite|DatabaseSync/);

const recoveryHandlerStart = rust.indexOf('if recovery_only {\n        builder.invoke_handler(tauri::generate_handler![');
const recoveryHandlerEnd = rust.indexOf('} else if recovery_policy.blocked()', recoveryHandlerStart);
assert(recoveryHandlerStart >= 0 && recoveryHandlerEnd > recoveryHandlerStart);
assert.match(rust.slice(recoveryHandlerStart, recoveryHandlerEnd), /p32_w5_r3_c3_5_child_process_boundary_probe/);
const normalHandlerStart = rust.indexOf('} else {\n        builder.invoke_handler(tauri::generate_handler![', recoveryHandlerEnd);
const normalHandlerEnd = rust.indexOf(']);', normalHandlerStart);
assert(normalHandlerStart >= 0 && normalHandlerEnd > normalHandlerStart);
assert.doesNotMatch(rust.slice(normalHandlerStart, normalHandlerEnd), /p32_w5_r3_c3_5_child_process_boundary_probe/);

assert.match(html, /id="c35-child-boundary-probe-button"/);
assert.match(html, /does not call reconstruction runner|不调用 reconstruction runner/);
assert.match(ui, /p32_w5_r3_c3_5_child_process_boundary_probe/);
const probeUi = functionSource(ui, 'async function runChildBoundaryProbe()', '\n  if (childProbeButton) childProbeButton.addEventListener');
assert.match(probeUi, /tauri\.core\.invoke\('p32_w5_r3_c3_5_child_process_boundary_probe'/);
assert.doesNotMatch(probeUi, /runDryRun\(|p32_w5_r3_c3_5_reconstruction_dry_run/);
assert.doesNotMatch(probeUi, /root\.__IB_P32W5_C35_DRYRUN_REQUESTED__/);
assert.match(ui, /C35_CHILD_SPAWN_ATTEMPTED/);
assert.match(ui, /C35_NODE_ENTRY_REACHED/);

console.log('PASS C3.5-J static child boundary contract');
