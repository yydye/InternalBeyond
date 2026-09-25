'use strict';

/* P32-W.5-R3-B.3.1 RecoveryOnly boundary contract; static only. */
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
const releaseManifest=require(path.join(root,'scripts','release-manifest.js'));
const dbSchema=require(path.join(root,'assets','js','webcore-db-schema.js'));
const productionAdapter=require(path.join(root,'assets','js','recovery-production-adapter.js'));
const firstBoot=require(path.join(root,'assets','js','recovery-first-boot.js'));
let pass=0;
function check(name,fn){fn();pass++;console.log('✓ '+name)}

console.log('P32-W.5 RecoveryOnly Host boundary tests');

check('normal Web Core consumes the shared v24 schema module',()=>{
  const schema=read('assets/js/webcore-db-schema.js');
  const html=read('InternalBeyond.html');
  const core=read('assets/js/core.js');
  assert.ok(schema.includes("var DB_NAME='InternalBeyondDB'"));
  assert.ok(schema.includes('var DB_VERSION=24'));
  assert.ok(html.indexOf('assets/js/webcore-db-schema.js')<html.indexOf('assets/js/core.js'));
  assert.ok(core.includes('DB_SCHEMA.open(indexedDB'));
  assert.ok(!/function openDB\(\)[^\n]*createObjectStore/.test(core));
});

check('all recovery stores are part of the shared schema contract',()=>{
  const schema=read('assets/js/webcore-db-schema.js');
  for(const name of ['apiConfigs','chatMessages','chatThreads','groups','memories','autoMemory','diary_entries','moments','roleLetters'])assert.ok(schema.includes("'"+name+"'"),name);
});

check('shared schema preserves the complete v24 store and index contract',()=>{
  assert.strictEqual(dbSchema.DB_NAME,'InternalBeyondDB');
  assert.strictEqual(dbSchema.DB_VERSION,24);
  assert.deepStrictEqual(dbSchema.STORE_NAMES,[
    'posts','categories','about','music','apiSettings','chatMessages','letters','apiConfigs','groups','blogComments',
    'memories','chatThreads','chatSummaries','uploadedFiles','blogAnnotations','projects','projectFiles','autoMemory',
    'calEvents','calNotes','calLedger','active_message_settings','active_message_history','active_message_plans',
    'diary_entries','moments','roleLetters','roleLetterMemories','activities','favorites','understandings','threads','disclosureFacts'
  ]);
  assert.ok(dbSchema.INDEXES.some(i=>i[0]==='chatMessages'&&i[1]==='byFriend'&&i[2]==='friendId'));
  assert.ok(dbSchema.INDEXES.some(i=>i[0]==='moments'&&i[1]==='byCreated'&&i[2]==='createdAt'));
});

check('RecoveryOnly is an explicit Host argument and branches before normal launcher startup',()=>{
  const rust=read('src-tauri/src/lib.rs');
  assert.ok(rust.includes('const RECOVERY_ONLY_ARG: &str = "--recovery-only"'));
  assert.ok(rust.includes('host_entry_mode(std::env::args_os().skip(1))'));
  const recoveryAt=rust.indexOf('if restricted_recovery_page {',rust.indexOf('.setup(move |app|'));
  const normalManage=rust.indexOf('app.manage(ProjectKnowledgeState::new',recoveryAt);
  const returnAt=rust.indexOf('return Ok(())',recoveryAt);
  const spawnAt=rust.indexOf('spawn_existing_launcher(&lifecycle)',normalManage);
  assert.ok(recoveryAt>=0&&returnAt>recoveryAt&&normalManage>returnAt&&spawnAt>normalManage);
  assert.ok(rust.includes('recovery_payload_is_complete(&runtime.root)'));
  assert.ok(rust.includes('if runtime.mode != RuntimeMode::Production'));
});

check('RecoveryOnly keeps the singleton guard and exposes only recovery checkpoint commands',()=>{
  const rust=read('src-tauri/src/lib.rs');
  assert.ok(rust.includes('tauri_plugin_single_instance::init'));
  assert.ok(rust.includes('if !restricted_recovery_page {\n            builder = builder.plugin(tauri_plugin_window_state'));
  assert.ok(rust.includes('if !recovery_only_instance && args_request_recovery_only(&args)'));
  assert.ok(rust.includes('let restricted_recovery_page = recovery_only || recovery_policy.blocked();'));
  assert.ok(rust.includes("Object.defineProperty(window, '__IB_RECOVERY_TARGET_IDENTITY__'"));
  assert.ok(rust.includes("Object.defineProperty(window, '__IB_TAURI_HOST__'"));
  assert.ok(rust.includes('} else if recovery_policy.blocked() {\n        builder'));
  assert.ok(rust.includes('window.__IB_RECOVERY_BOOT_BLOCKED__ = {};'));
  assert.ok(rust.includes('read_recovery_checkpoint,\n            issue_recovery_restore_approval,\n            open_recovery_apply_window,\n            close_recovery_apply_window,\n            write_recovery_checkpoint,\n            abort_recovery_checkpoint_before_apply'));
  assert.ok(rust.includes('const PRODUCTION_RESTORE_ENABLED: bool = false'));
  assert.ok(rust.includes('recovery_apply_window_matches'));
  assert.ok(rust.includes('credential_status,\n            acknowledge_recovery_first_boot'));
  assert.ok(rust.includes('const PRODUCTION_RESTORE_ENABLED: bool = false'));
});

check('RecoveryOnly last-window destruction drains read-only work before one exit and leaves normal lifecycle alone',()=>{
  const rust=read('src-tauri/src/lib.rs');
  const runAt=rust.indexOf('.run(move |app, event|');
  const runEnd=rust.indexOf('\n        });',runAt);
  const run=rust.slice(runAt,runEnd);
  assert.ok(runAt>=0&&runEnd>runAt);
  assert.match(run,/RunEvent::WindowEvent\s*\{\s*label,\s*event:\s*WindowEvent::Destroyed/);
  assert.match(run,/if recovery_only/);
  assert.match(run,/app\.webview_windows\(\)\.keys\(\)\.all\(\|other\| other != &label\)/);
  assert.match(run,/lifecycle\.recovery_window_destroyed\(true\)/);
  assert.match(run,/app\.exit\(0\)/);
  assert.match(run,/lifecycle\.defer_exit_while_dry_run_active\(\)[\s\S]*api\.prevent_exit\(\)/);
  assert.doesNotMatch(run,/reconstruction|apply_reconstruction|open_recovery_apply_window\(/i);
  assert.match(run,/if recovery_only[\s\S]*api\.prevent_exit\(\)[\s\S]*else\s*\{\s*#\[cfg\(desktop\)\][\s\S]*stop_host_owned_services/);
  const dryRun=rust.slice(rust.indexOf('fn p32_w5_r3_c3_5_reconstruction_dry_run('),rust.indexOf('fn validate_c35_zero_write_report'));
  assert.ok(dryRun.indexOf('RecoveryOnlyDryRunGuard::begin')<dryRun.indexOf('command.spawn()'));
  assert.ok(dryRun.indexOf('child.wait_with_output()')>dryRun.indexOf('command.spawn()'));
  const runner=read('services/home-node/reconstruction-runner.js');
  assert.match(runner,/finally\s*\{\s*if \(adapter\) adapter\.close\(\);\s*\}/);
});

check('Recovery page contains no normal app or service startup scripts',()=>{
  const page=read('Recovery.html');
  for(const forbidden of ['assets/js/core.js','assets/js/active-diary.js','assets/js/bridge.js','local-services-runner.js','InternalBeyond.html'])assert.ok(!page.includes(forbidden),forbidden);
  for(const allowed of ['webcore-db-schema.js','recovery-engine.js','composite-recovery-plan.js','recovery-webcore-adapter.js','recovery-production-adapter.js','recovery-apply-executor.js','recovery-first-boot.js','recovery-source-manifest.js','recovery-ui.js','recovery-shell.js','recovery-c3-5-reconstruction.js'])assert.ok(page.includes(allowed),allowed);
  assert.ok(page.includes('composite-files'));
  assert.ok(page.includes('issue-production-approval'));
  assert.ok(page.includes('execute-production-restore'));
  assert.ok(page.includes('approval-plan-id'));
  assert.ok(page.includes('approval-plan-hash'));
  assert.ok(page.includes('approval-confirmation'));
  const build=read('src-tauri/build.rs');
  assert.ok(build.includes('["InternalBeyond.html", "Recovery.html"]'));
  assert.ok(build.includes('stage.join(entrypoint)'));
});

check('RecoveryShell is inert and does not open storage or network APIs',()=>{
  const shell=read('assets/js/recovery-shell.js');
  for(const forbidden of ['indexedDB','localStorage','sessionStorage','fetch(','XMLHttpRequest','WebSocket','credentials'])assert.ok(!shell.includes(forbidden),forbidden);
  assert.ok(shell.includes('__IB_RECOVERY_ONLY__'));
});

check('P5.7 executor is RecoveryOnly-only and does not turn on global apply',()=>{
  const executor=read('assets/js/recovery-apply-executor.js');
  assert.ok(executor.includes('__IB_RECOVERY_ONLY__'));
  assert.ok(executor.includes('issueExplicitProductionRestoreApproval'));
  assert.ok(executor.includes('createRollbackCheckpoint'));
  assert.ok(executor.includes('verifyRollbackCheckpoint'));
  assert.ok(executor.includes('withApprovedApplyWindow'));
  const adapter=read('assets/js/recovery-production-adapter.js');
  assert.ok(adapter.includes('var PRODUCTION_APPLY_ENABLED=false'));
  assert.ok(adapter.includes('SYNTHETIC_TEST_APPROVAL'));
  assert.ok(adapter.includes('EXPLICIT_PRODUCTION_RESTORE_APPROVAL'));
  assert.ok(adapter.includes('production-approval-issuer-recoveryonly-required'));
  const rust=read('src-tauri/src/lib.rs');
  assert.ok(rust.includes('const PRODUCTION_RESTORE_ENABLED: bool = false'));
  assert.ok(rust.includes('issue_recovery_restore_approval'));
  assert.ok(rust.includes('abort_recovery_checkpoint_before_apply'));
  assert.ok(rust.includes('APPROVAL_TOKEN_NOT_ISSUED_HERE'));
  const issueHandler=rust.indexOf('fn issue_recovery_restore_approval(');
  const nativeConfirm=rust.indexOf('confirm_native_restore_approval(hwnd.0, &request.plan)',issueHandler);
  const nativeIssue=rust.indexOf('issue_recovery_approval_inner(request',issueHandler);
  assert.ok(issueHandler>=0&&nativeConfirm>issueHandler&&nativeIssue>nativeConfirm);
  assert.ok(rust.includes('MessageBoxW'));
  assert.ok(rust.includes('get_webview_window("main")'));
  assert.ok(rust.includes('APPROVAL_WINDOW_INVALID'));
  assert.ok(rust.includes('APPROVAL_FOREGROUND_UNAVAILABLE'));
  assert.ok(rust.includes('APPROVAL_NATIVE_CONFIRMATION_REJECTED'));
  assert.ok(rust.includes('APPROVAL_NATIVE_CONFIRMATION_UNAVAILABLE'));
  const confirmBody=rust.slice(rust.indexOf('fn confirm_native_restore_approval('),rust.indexOf('#[cfg(not(windows))]',rust.indexOf('fn confirm_native_restore_approval(')));
  assert.ok(confirmBody.includes('IsWindow(owner)'));
  assert.ok(confirmBody.includes('GetForegroundWindow()'));
  assert.ok(confirmBody.includes('MessageBoxW(\n            owner,'));
  assert.ok(!confirmBody.includes('std::ptr::null_mut()'));
  const recoveryCommands=rust.slice(rust.indexOf('let builder = if recovery_only {'),rust.indexOf('} else if recovery_policy.blocked()',rust.indexOf('let builder = if recovery_only {')));
  assert.ok(recoveryCommands.includes('issue_recovery_restore_approval'));
  assert.ok(!rust.slice(rust.indexOf('} else if recovery_policy.blocked()')).includes('issue_recovery_restore_approval'));
});

check('RecoveryOnly target identity fingerprints declared payload bytes without changing normal runtime identity',()=>{
  const rust=read('src-tauri/src/lib.rs');
  assert.ok(rust.includes('fn recovery_payload_content_identity_from_manifest('));
  assert.ok(rust.includes('fn recovery_payload_content_identity('));
  assert.ok(rust.includes('hasher.update(&bytes)'));
  assert.ok(rust.includes('if recovery_only {\n                    recovery_payload_content_identity_from_manifest(&runtime.root)'));
  assert.ok(rust.includes('runtime.payload_identity.clone().unwrap_or_default()'));
});

check('Recovery engine has no persistence, network or provider capability',()=>{
  const engine=read('assets/js/recovery-engine.js');
  for(const pattern of [/\bindexedDB\s*(?:\.|\[)/,/\blocalStorage\s*(?:\.|\[)/,/\bsessionStorage\s*(?:\.|\[)/,/\bfetch\s*\(/,/XMLHttpRequest|WebSocket|providerClient/])assert.ok(!pattern.test(engine),pattern.toString());
});

check('production apply is closed and temporary target is explicit',()=>{
  const adapter=read('assets/js/recovery-webcore-adapter.js');
  assert.ok(adapter.includes('var PRODUCTION_APPLY_ENABLED=false'));
  assert.strictEqual(productionAdapter.PRODUCTION_APPLY_ENABLED,false);
  assert.strictEqual(productionAdapter.TemporaryIndexedDBAdapter,productionAdapter.RecoveryWebCoreAdapter);
  const prodSource=read('assets/js/recovery-production-adapter.js');
  assert.ok(prodSource.includes('var PRODUCTION_APPLY_ENABLED=false'));
  assert.ok(prodSource.includes('production-schema-migration-forbidden'));
  assert.ok(prodSource.includes("mode==='dry-run'"));
  assert.ok(adapter.includes("this.targetClass!=='temporary'"));
  assert.ok(adapter.includes("production-apply-disabled"));
});

check('first boot guard suppresses Active and Host launcher while preserving normal startup without a marker',()=>{
  const html=read('InternalBeyond.html');
  const activeAt=html.indexOf('assets/js/active-diary.js');
  assert.ok(html.indexOf('assets/js/recovery-first-boot.js')<activeAt);
  const active=read('assets/js/active-diary.js');
  assert.ok(active.includes('if(_recoveryActiveHeld())return{ok:false,reason:\'recovery-active-hold\'}'));
  assert.ok(active.includes('if(_recoveryActiveHeld()){'));
  const rust=read('src-tauri/src/lib.rs');
  assert.ok(rust.includes('if !recovery_policy.suppress_services()'));
  const normal=firstBoot.policyFromWindow({});
  assert.strictEqual(normal.mode,'NORMAL');
  assert.strictEqual(firstBoot.shouldSuppressActive(normal),false);
  assert.strictEqual(firstBoot.shouldSuppressServices(normal),false);
});

check('Recovery.html and recovery modules are shipped by the canonical whitelist',()=>{
  const files=new Set(releaseManifest.resolve({}).files.map(f=>f.to));
  for(const file of ['Recovery.html','assets/js/webcore-db-schema.js','assets/js/recovery-engine.js','assets/js/composite-recovery-plan.js','assets/js/recovery-webcore-adapter.js','assets/js/recovery-production-adapter.js','assets/js/recovery-apply-executor.js','assets/js/recovery-first-boot.js','assets/js/recovery-source-manifest.js','assets/js/recovery-ui.js','assets/js/recovery-shell.js','assets/js/recovery-c3-5-reconstruction.js','services/home-node/reconstruction-runner.js','services/home-node/production-reconstruction-adapter.js','services/home-node/composite-reconstruction-executor.js','services/home-node/composite-reconstruction-approval.js','services/home-node/character-projection-store.js','services/home-node/reconstruction-contracts/p32-w5-r3c3/composite-bundle.json','services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-reconstruction-write-set.json','services/home-node/reconstruction-contracts/p32-w5-r3c3/character-projection-write-set.json','services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-proposed-write-set.json','services/home-node/reconstruction-contracts/p32-w5-r3c3/character-field-authority-matrix.json','services/home-node/reconstruction-contracts/p32-w5-r3c3/character-conflict-resolution.json','services/home-node/reconstruction-contracts/p32-w5-r3c3/c2-authority-report.json'])assert.ok(files.has(file),file);
});

console.log('PASS '+pass+' RecoveryOnly Host contract checks');
