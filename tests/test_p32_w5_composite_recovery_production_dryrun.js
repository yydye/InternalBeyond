'use strict';

/* Explicitly invoked P5.6 live RecoveryOnly dry-run.
 * It starts only the installed canonical Host with --recovery-only, selects the
 * three fixed source files, runs a readonly production snapshot/planner, and
 * never issues approval or invokes Apply. Do not add this script to test-all. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const fx = require('./fixtures/p22-cdp-client.js');
const networkPolicy = require('./p32-w5-recovery-network-policy.js');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_ROOT = 'C:\\Users\\admin\\AppData\\Local\\Programs\\InternalBeyond';
const HOST_EXE = path.join(INSTALL_ROOT, 'internalbeyond-host.exe');
const P55_PLAN_ID = 'p32-w5-r3b3-p5.5:f99b6f236ecd78d3c111d106';
const P55_PLAN_SHA256 = 'f99b6f236ecd78d3c111d106d3c1714b9790f65f09c34937de62ba21a9aea117';
const P562_AUTHORITY_REVISION_ID = 'p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca';
const P562_AUTHORITY_REVISION_SHA256 = 'f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7';
const SERVICE_PORTS = [23120, 23116, 23115, 23114, 23118];
const AUTHORITY_EVIDENCE = [
  { path: 'C:\\Users\\admin\\AppData\\Roaming\\HiBit Uninstaller\\Uninstaller\\Backup\\InternalBeyond, 22-09-2026_20,41,27(52,1928)\\BackupFiles.zip', sha256: '8fb1f17a8b99028774d2decbb13aa3779c4df2c793c190017fdbc632dfc3db82', kind: 'HiBit backup' },
  { path: path.resolve(__dirname, '..', 'hibit-identity-transition-report.json'), sha256: '517c663692de479b76fb2fc06b777022af2c8d227b6a1109e3fbd7e2eee1b876', kind: 'HiBit identity evidence' },
  { path: path.resolve(__dirname, '..', 'role-metadata-continuity-report.json'), sha256: '02203167deef66b374d77a7945a4199d6870094e54f89ab3b92a236d4adb4c43', kind: 'role continuity evidence' },
  { path: path.join(ROOT, 'tmp', 'p32-w5-r3b', 'composite-recovery-authority-revision-p5.6.2.json'), sha256: '447451b1ce2e9d774b4a6bbe812b28e44e4918c2606c137b1c6d786e4b0c6ae3', kind: 'authority revision manifest' }
];
const SOURCES = [
  { path: 'C:\\Users\\admin\\Downloads\\InternalBeyond_auto_2026-09-02.json', name: 'InternalBeyond_auto_2026-09-02.json', sha256: '1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401' },
  { path: 'E:\\存储\\IB_backup_2026-09-03.json', name: 'IB_backup_2026-09-03.json', sha256: '37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d' },
  { path: 'C:\\Users\\admin\\Downloads\\InternalBeyond_auto_2026-08-27.json', name: 'InternalBeyond_auto_2026-08-27.json', sha256: '5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84' }
];

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sha256Stream(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'), stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
function checkSourceFiles() {
  return SOURCES.map(source => {
    if (!fs.existsSync(source.path)) throw new Error('source-missing:' + source.name);
    const stat = fs.statSync(source.path), digest = sha256(source.path);
    if (digest !== source.sha256) throw new Error('source-hash-mismatch:' + source.name);
    return { fileName: source.name, size: stat.size, sha256: digest };
  });
}
async function checkAuthorityEvidence() {
  const evidence = [];
  for (const item of AUTHORITY_EVIDENCE) {
    if (!fs.existsSync(item.path)) throw new Error('authority-evidence-missing:' + item.kind);
    const stat = fs.statSync(item.path), digest = await sha256Stream(item.path);
    if (digest !== item.sha256) throw new Error('authority-evidence-hash-mismatch:' + item.kind);
    evidence.push({ kind: item.kind, fileName: path.basename(item.path), size: stat.size, sha256: digest });
  }
  const revisionPath = AUTHORITY_EVIDENCE[3].path;
  const revision = JSON.parse(fs.readFileSync(revisionPath, 'utf8'));
  if (!revision.identity || revision.identity.planId !== P562_AUTHORITY_REVISION_ID || revision.identity.planSha256 !== P562_AUTHORITY_REVISION_SHA256 ||
      revision.authority.current !== 'USER_CONFIRMED_IDENTITY_SUCCESSION' || revision.supersedes.planId !== P55_PLAN_ID || revision.supersedes.planSha256 !== P55_PLAN_SHA256) {
    throw new Error('authority-revision-manifest-binding-invalid');
  }
  return { files: evidence, revisionPlanId: revision.identity.planId, revisionPlanSha256: revision.identity.planSha256 };
}
async function getTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fx.request(port, 'GET', '/json/list');
    const target = Array.isArray(response.body) && response.body.find(item => item && item.type === 'page' && item.webSocketDebuggerUrl);
    if (target) return target;
    await fx.sleep(250);
  }
  throw new Error('recovery-webview-debug-target-timeout');
}
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('page-evaluation-failed:' + (result.exceptionDetails.text || 'exception'));
  return result.result && result.result.value;
}
async function waitFor(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evaluate(cdp, expression)) return true; } catch (_) {}
    await fx.sleep(200);
  }
  return false;
}
function lineValue(text, prefix) {
  const line = String(text || '').split(/\r?\n/).find(item => item.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}
const INTEGRITY_PS_SOURCE = String.raw`
$integritySource = @'
using System;
using System.Runtime.InteropServices;
public static class P562ProcessIntegrity {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int needed);
 [DllImport("advapi32.dll", SetLastError=true)] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll", SetLastError=true)] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
 public static string Get(int pid) {
  IntPtr process=OpenProcess(0x1000,false,pid); if(process==IntPtr.Zero) return "UNREADABLE";
  IntPtr token=IntPtr.Zero,data=IntPtr.Zero;
  try { if(!OpenProcessToken(process,0x0008,out token)) return "UNREADABLE";
   int needed; GetTokenInformation(token,25,IntPtr.Zero,0,out needed); if(needed<=0)return "UNREADABLE";
   data=Marshal.AllocHGlobal(needed); if(!GetTokenInformation(token,25,data,needed,out needed))return "UNREADABLE";
   IntPtr sid=Marshal.ReadIntPtr(data),countPtr=GetSidSubAuthorityCount(sid); if(countPtr==IntPtr.Zero)return "UNREADABLE";
   byte count=Marshal.ReadByte(countPtr); if(count==0)return "UNREADABLE";
   uint rid=(uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
   string label=rid>=0x4000?"SYSTEM":rid>=0x3000?"HIGH":rid>=0x2000?"MEDIUM":rid>=0x1000?"LOW":"UNTRUSTED";
   return label+"(S-1-16-"+rid+")";
  } finally {if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data);if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
 }
}
'@
Add-Type -TypeDefinition $integritySource -ErrorAction Stop
`;
function runPowerShellJson(script) {
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(String(output || '').trim());
}
function inspectProcess(pid) {
  const script = INTEGRITY_PS_SOURCE + `
$targetPid = ${Number(pid)}
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
if(-not $proc){[pscustomobject]@{exists=$false}|ConvertTo-Json -Compress;exit 0}
[pscustomobject]@{exists=$true;path=$proc.ExecutablePath;integrity=[P562ProcessIntegrity]::Get($targetPid);recoveryOnlyArgument=([string]$proc.CommandLine).Contains('--recovery-only')}|ConvertTo-Json -Compress`;
  return runPowerShellJson(script);
}
function serviceIsolationSnapshot() {
  const script = `$ports=@(23120,23116,23115,23114,23118);$listeners=foreach($port in $ports){Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue|ForEach-Object{[pscustomobject]@{port=$port;pid=$_.OwningProcess}}};$canonicalNode='C:\\Users\\admin\\AppData\\Local\\Programs\\InternalBeyond\\runtime\\node\\node.exe';$nodes=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -ieq $canonicalNode});$hosts=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -ieq 'internalbeyond-host.exe'});[pscustomobject]@{listeners=@($listeners);canonicalRuntimeNodeCount=$nodes.Count;hostProcessCount=$hosts.Count}|ConvertTo-Json -Compress -Depth 4`;
  return runPowerShellJson(script);
}
async function waitForHostIdentity(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = inspectProcess(pid); if (last && last.exists && last.path) return last; } catch (_) {}
    await fx.sleep(200);
  }
  throw new Error('canonical-host-process-identity-unreadable:' + String(last && last.integrity || 'unknown'));
}
function assertServicesAbsent(snapshot, phase) {
  if (!snapshot || snapshot.listeners.length !== 0 || snapshot.canonicalRuntimeNodeCount !== 0) {
    throw new Error('canonical-runtime-services-active-' + phase);
  }
}
async function closeWindow(cdp, child) {
  try {
    await evaluate(cdp, "window.__TAURI__&&window.__TAURI__.window&&window.__TAURI__.window.getCurrentWindow().close()");
  } catch (_) {}
  const exited = new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve(true);
    child.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 12000);
  });
  if (await exited) return true;
  await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-Command', "$p=Get-Process -Id " + String(child.pid) + " -ErrorAction SilentlyContinue; if($p){[void]$p.CloseMainWindow()}"], { windowsHide: true }, () => resolve()));
  const graceful = await new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve(true);
    child.once('exit', () => resolve(true));
    setTimeout(() => resolve(false), 10000);
  });
  return graceful;
}

async function main() {
  if (!process.argv.includes('--allow-read-only-production-dry-run')) {
    throw new Error('explicit-flag-required: --allow-read-only-production-dry-run');
  }
  const snapshotOnly = process.argv.includes('--p5.8.5-snapshot-only');
  const emitP585Result = process.argv.includes('--p5.8.5-result-marker');
  const groupList = execFileSync('whoami.exe', ['/groups'], { encoding: 'utf8', windowsHide: true });
  const integrity = /S-1-16-8192\b/i.test(groupList) ? 'MEDIUM' : (/S-1-16-12288\b/i.test(groupList) ? 'HIGH' : 'UNKNOWN');
  if (integrity !== 'MEDIUM') throw new Error('refusing-to-enable-WebView2-CDP-outside-medium-integrity:' + integrity);
  if (!fs.existsSync(HOST_EXE)) throw new Error('canonical-host-exe-missing');
  const manifestPath = path.join(INSTALL_ROOT, 'ib-payload-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('canonical-payload-manifest-missing');
  const payload = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!payload.files.includes('assets/js/composite-recovery-plan.js') || !payload.files.includes('assets/js/recovery-production-adapter.js')) throw new Error('canonical-composite-recovery-payload-missing');
  const compositeSource = fs.readFileSync(path.join(INSTALL_ROOT, 'assets/js/composite-recovery-plan.js'), 'utf8');
  const adapterSource = fs.readFileSync(path.join(INSTALL_ROOT, 'assets/js/recovery-production-adapter.js'), 'utf8');
  if (!compositeSource.includes('p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca') ||
      !compositeSource.includes('USER_CONFIRMED_IDENTITY_SUCCESSION') ||
      !adapterSource.includes('USER_CONFIRMED_IDENTITY_SUCCESSION')) throw new Error('canonical-authority-revision-payload-missing');
  const verifiedSources = checkSourceFiles();
  const authorityEvidence = await checkAuthorityEvidence();
  const servicesBefore = serviceIsolationSnapshot();
  assertServicesAbsent(servicesBefore, 'before-host-spawn');
  if (servicesBefore.hostProcessCount !== 0) throw new Error('canonical-host-already-running-before-recovery-only');
  let hostIdentity = null, servicesDuring = null, servicesAfter = null;
  const debugPort = await fx.freePort();
  const hostArgs = ['--recovery-only'];
  const environment = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS || '', '--remote-debugging-port=' + debugPort].filter(Boolean).join(' ')
  });
  const child = spawn(HOST_EXE, hostArgs, { cwd: INSTALL_ROOT, env: environment, stdio: 'ignore', windowsHide: true });
  process.stdout.write('P5.6 RecoveryOnly PID=' + String(child.pid || '') + ' WebView2 CDP port=' + debugPort + '\n');
  let cdp = null, output = null, closeOk = false;
  try {
    hostIdentity = await waitForHostIdentity(child.pid, 8000);
    const hostIdentityAudit = {
      canonicalPathMatch: String(hostIdentity.path || '').toLowerCase() === HOST_EXE.toLowerCase(),
      integrity: hostIdentity.integrity,
      recoveryOnlyArgument: hostIdentity.recoveryOnlyArgument === true
    };
    process.stdout.write('P5.6.2 Host identity=' + JSON.stringify(hostIdentityAudit) + '\n');
    if (!hostIdentityAudit.canonicalPathMatch || hostIdentityAudit.integrity !== 'MEDIUM(S-1-16-8192)' || !hostIdentityAudit.recoveryOnlyArgument) {
      throw new Error('canonical-host-medium-recovery-identity-invalid:' + JSON.stringify(hostIdentityAudit));
    }
    servicesDuring = serviceIsolationSnapshot();
    assertServicesAbsent(servicesDuring, 'after-host-spawn');
    const target = await getTarget(debugPort, 90000);
    cdp = await fx.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    const shellReady = await waitFor(cdp, "window.__IB_RECOVERY_ONLY__===true&&window.IBRecoveryShell&&document.getElementById('composite-files')", 30000);
    if (!shellReady) throw new Error('installed-recovery-only-shell-not-ready');
    const shellStatus = await evaluate(cdp, 'JSON.stringify(window.IBRecoveryShell.status())');
    if (!shellStatus || !JSON.parse(shellStatus).mode.includes('RECOVERY_ONLY')) throw new Error('recovery-only-host-marker-invalid');
    const initialShell = JSON.parse(shellStatus);
    if (initialShell.normalRuntimeStarted !== false || initialShell.productionApplyEnabled !== false || initialShell.networkEnabled !== false) throw new Error('recovery-only-runtime-boundary-invalid');
    const guarded = await evaluate(cdp, `(() => {
      const classifyDestination = ${networkPolicy.classifyDestination.toString()};
      const extractSafeTauriCommand = ${networkPolicy.extractSafeTauriCommand.toString()};
      const decideTauriIpc = ${networkPolicy.decideTauriIpc.toString()};
      const guardStarted=performance.now();
      const g={readwriteAttempts:0,schemaUpgradeEvents:0,localStorageWriteAttempts:0,networkAttempts:0,blockedNetworkRequests:0,blockedExternalNetworkRequests:0,internalNetworkAttempts:0,externalNetworkAttempts:0,otherSchemeNetworkAttempts:0,tauriIpcAttempts:0,tauriIpcReadOnlyDispatches:0,tauriIpcRejectedRequests:0,externalNetworkDispatches:0,externalResourceAssignments:0,externalNetworkDetails:[],tauriIpcDetails:[]};
      window.__IB_P564_CLASSIFY_DESTINATION__=classifyDestination;
      window.__IB_P564_TEST_PHASE__='post-boot-idle';
      const safeStack=()=>String(new Error('blocked network attempt').stack||'').split(String.fromCharCode(10)).slice(2,14).map(line=>line.replace(/[?#].*$/,'?[redacted]'));
      const rawUrl=value=>value&&value.url?value.url:value;
      const recordNetworkAttempt=(value,api,method,body)=>{
        g.networkAttempts++;
        const dest=classifyDestination(rawUrl(value),location.origin);
        if(dest.kind==='TAURI_LOCAL_IPC'){
          g.tauriIpcAttempts++;
          const decision=decideTauriIpc(rawUrl(value),location.origin,method,body);
          g.tauriIpcDetails.push({api:String(api||'unknown'),method:String(method||''),command:decision.command,action:decision.action,phase:String(window.__IB_P564_TEST_PHASE__||'unknown'),elapsedMs:Math.round(performance.now()-guardStarted),stack:safeStack()});
          return decision.action;
        }
        if(dest.kind==='EXTERNAL'){
          g.externalNetworkAttempts++;
          const parsed=new URL(String(rawUrl(value)),location.href);
          const safePath=parsed.pathname.split('/').map(part=>part.length>20?'[redacted-segment]':part).join('/');
          g.externalNetworkDetails.push({api:String(api||'unknown'),method:String(method||''),destination:{scheme:dest.scheme,host:dest.host,path:safePath},phase:String(window.__IB_P564_TEST_PHASE__||'unknown'),elapsedMs:Math.round(performance.now()-guardStarted),stack:safeStack()});
          return 'BLOCK_EXTERNAL';
        }
        if(dest.kind==='LOCAL'){g.internalNetworkAttempts++;return 'BLOCK_INTERNAL'}
        g.otherSchemeNetworkAttempts++;return 'BLOCK_OTHER_SCHEME';
      };
      const nativeFetch=window.fetch.bind(window);
      const tx=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(stores,mode){if(mode==='readwrite'){g.readwriteAttempts++;throw new Error('P5.6.2-readwrite-transaction-blocked')}return tx.apply(this,arguments)};
      const open=IDBFactory.prototype.open;
      IDBFactory.prototype.open=function(){const req=open.apply(this,arguments);req.addEventListener('upgradeneeded',()=>{g.schemaUpgradeEvents++});return req};
      const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem,clear=Storage.prototype.clear;
      Storage.prototype.setItem=function(){g.localStorageWriteAttempts++;throw new Error('P5.6.2-localStorage-write-blocked')};
      Storage.prototype.removeItem=function(){g.localStorageWriteAttempts++;throw new Error('P5.6.2-localStorage-write-blocked')};
      Storage.prototype.clear=function(){g.localStorageWriteAttempts++;throw new Error('P5.6.2-localStorage-write-blocked')};
      window.fetch=function(input,init){
        const method=init&&init.method||input&&input.method||'GET',body=init&&init.body||null;
        const decision=recordNetworkAttempt(input,'fetch',method,body);
        if(decision==='ALLOW_READ_ONLY_TAURI_IPC'){g.tauriIpcReadOnlyDispatches++;return nativeFetch(input,init)}
        g.blockedNetworkRequests++;
        if(decision==='BLOCK_EXTERNAL')g.blockedExternalNetworkRequests++;
        if(decision==='BLOCK_TAURI_IPC')g.tauriIpcRejectedRequests++;
        return Promise.reject(new Error('P5.6.4-network-blocked'));
      };
      XMLHttpRequest.prototype.open=function(method,url){const decision=recordNetworkAttempt(url,'XMLHttpRequest',method,null);g.blockedNetworkRequests++;if(decision==='BLOCK_EXTERNAL')g.blockedExternalNetworkRequests++;if(decision==='BLOCK_TAURI_IPC')g.tauriIpcRejectedRequests++;throw new Error('P5.6.4-xhr-blocked')};
      XMLHttpRequest.prototype.send=function(){g.blockedNetworkRequests++;throw new Error('P5.6.2-xhr-blocked')};
      window.WebSocket=function(url){const decision=recordNetworkAttempt(url,'WebSocket','CONNECT',null);g.blockedNetworkRequests++;if(decision==='BLOCK_EXTERNAL')g.blockedExternalNetworkRequests++;if(decision==='BLOCK_TAURI_IPC')g.tauriIpcRejectedRequests++;throw new Error('P5.6.4-websocket-blocked')};
      if(window.EventSource)window.EventSource=function(url){const decision=recordNetworkAttempt(url,'EventSource','CONNECT',null);g.blockedNetworkRequests++;if(decision==='BLOCK_EXTERNAL')g.blockedExternalNetworkRequests++;if(decision==='BLOCK_TAURI_IPC')g.tauriIpcRejectedRequests++;throw new Error('P5.6.4-eventsource-blocked')};
      if(navigator.sendBeacon)navigator.sendBeacon=function(url){const decision=recordNetworkAttempt(url,'sendBeacon','POST',null);g.blockedNetworkRequests++;if(decision==='BLOCK_EXTERNAL')g.blockedExternalNetworkRequests++;if(decision==='BLOCK_TAURI_IPC')g.tauriIpcRejectedRequests++;return false};
      window.addEventListener('securitypolicyviolation',event=>{const dest=classifyDestination(event.blockedURI,location.origin);if(dest.kind==='EXTERNAL')g.externalResourceAssignments++});
      window.__IB_P562_READONLY_GUARD__=g;return true;
    })()`);
    if (guarded !== true) throw new Error('read-only-runtime-guard-install-failed');
    if (snapshotOnly) {
      await evaluate(cdp, "window.__IB_P564_TEST_PHASE__='target-snapshot-capture'");
      const snapshotManifest = await evaluate(cdp, `(async()=>{
        const Adapter=window.IBProductionRecoveryAdapter&&window.IBProductionRecoveryAdapter.ProductionRecoveryAdapter;
        if(typeof Adapter!=='function')throw new Error('target-snapshot-adapter-unavailable');
        const adapter=new Adapter();
        try{await adapter.prepareProductionTarget();const snapshot=await adapter.snapshot();return snapshot.manifest}
        finally{adapter.close()}
      })()`);
      if (!snapshotManifest || snapshotManifest.schema !== 'internalbeyond.target-snapshot-manifest' || snapshotManifest.version !== 1) throw new Error('target-snapshot-manifest-invalid');
      if (snapshotManifest.databaseName !== 'InternalBeyondDB' || snapshotManifest.schemaVersion !== 24 || snapshotManifest.origin !== 'http://tauri.localhost') throw new Error('target-snapshot-manifest-target-invalid');
      const readonlyGuard = JSON.parse(await evaluate(cdp, 'JSON.stringify(window.__IB_P562_READONLY_GUARD__)'));
      const approvalNotIssuedAndApplyDisabled = await evaluate(cdp, "(()=>{const a=document.getElementById('issue-production-approval'),x=document.getElementById('execute-production-restore'),c=document.getElementById('approval-understands-production-write');return !!a&&!!x&&a.disabled&&x.disabled&&!!c&&!c.checked&&document.getElementById('approval-plan-id').value===''&&document.getElementById('approval-plan-hash').value===''&&document.getElementById('approval-confirmation').value===''})()");
      const applyFlagClosed = await evaluate(cdp, "window.IBProductionRecoveryAdapter.PRODUCTION_APPLY_ENABLED===false&&typeof window.IBProductionRecoveryAdapter.issueExplicitProductionRestoreApproval==='undefined'");
      const activeState = await evaluate(cdp, "document.getElementById('active-rearm-state').textContent");
      const activeQuarantined = /quarantined/i.test(String(activeState||'')) && /blocked/i.test(String(activeState||''));
      const servicesAfter = serviceIsolationSnapshot();
      assertServicesAbsent(servicesAfter, 'during-snapshot-only-capture');
      const safetyFacts = {
        recoveryOnly: initialShell.mode === 'RECOVERY_ONLY',
        normalLauncherSuppressed: initialShell.normalRuntimeStarted === false,
        recoveryNetworkDisabled: initialShell.networkEnabled === false,
        activeQuarantined: activeQuarantined === true,
        approvalNotIssuedAndApplyDisabled: approvalNotIssuedAndApplyDisabled === true,
        productionApplyClosed: applyFlagClosed === true,
        indexedDbReadwriteAttemptsZero: readonlyGuard.readwriteAttempts === 0,
        schemaUpgradeEventsZero: readonlyGuard.schemaUpgradeEvents === 0,
        localStorageWritesZero: readonlyGuard.localStorageWriteAttempts === 0,
        externalNetworkAttemptsZero: readonlyGuard.externalNetworkAttempts === 0,
        externalNetworkDispatchesZero: readonlyGuard.externalNetworkDispatches === 0,
        readOnlyCheckpointIpcOnly: readonlyGuard.tauriIpcAttempts === 1 && readonlyGuard.tauriIpcReadOnlyDispatches === 1 && readonlyGuard.tauriIpcRejectedRequests === 0 && readonlyGuard.tauriIpcDetails.every(item => item.command === 'read_recovery_checkpoint' && item.action === 'ALLOW_READ_ONLY_TAURI_IPC'),
        manifestContainsNoForbiddenPayloadFields: !/(?:api.?key|secret|content|timestamp|session|cache|wal|shm)/i.test(JSON.stringify(snapshotManifest))
      };
      output = {
        status: Object.values(safetyFacts).every(Boolean) ? 'TARGET_SNAPSHOT_CAPTURED' : 'BLOCKED_SAFETY_BOUNDARY',
        captureMode: 'READ_ONLY_SNAPSHOT_ONLY',
        hostIdentity: hostIdentityAudit,
        snapshotManifest: snapshotManifest,
        readOnlyGuard: readonlyGuard,
        safetyFacts: safetyFacts,
        activeQuarantined: activeQuarantined,
        servicesBefore: servicesBefore,
        servicesDuring: servicesDuring,
        servicesAfterCapture: servicesAfter
      };
    } else {
    const rootDoc = await cdp.send('DOM.getDocument', { depth: 1 });
    const fileNode = await cdp.send('DOM.querySelector', { nodeId: rootDoc.root.nodeId, selector: '#composite-files' });
    if (!fileNode || !fileNode.nodeId) throw new Error('composite-source-input-missing');
    await evaluate(cdp, "window.__IB_P564_TEST_PHASE__='source-selection'");
    await cdp.send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: SOURCES.map(source => source.path) });
    await evaluate(cdp, "document.getElementById('composite-files').dispatchEvent(new Event('change',{bubbles:true}))");
    const fileCount = await evaluate(cdp, "document.getElementById('composite-files').files.length");
    if (fileCount !== 3) throw new Error('composite-source-selection-count-invalid');
    await evaluate(cdp, "window.__IB_P564_TEST_PHASE__='source-validation'");
    await evaluate(cdp, "document.getElementById('validate-composite').click()");
    const packageReady = await waitFor(cdp, "document.getElementById('status').textContent.includes('State: PLAN')&&document.getElementById('composite-summary').textContent.includes('Frozen composite plan ID')", 120000);
    if (!packageReady) {
      const status = await evaluate(cdp, "document.getElementById('status').textContent");
      throw new Error('composite-source-validation-failed:' + String(status || 'no-status'));
    }
    const summaryText = await evaluate(cdp, "document.getElementById('composite-summary').textContent");
    for (const source of SOURCES) if (!summaryText.includes(source.name) || !summaryText.includes(source.sha256)) throw new Error('composite-source-summary-incomplete:' + source.name);
    await evaluate(cdp, "window.__IB_P564_TEST_PHASE__='production-bound-dry-run'");
    await evaluate(cdp, "document.getElementById('dry-run').click()");
    const dryRunDone = await waitFor(cdp, "document.getElementById('status').textContent.includes('State: APPROVAL_REQUIRED')||document.getElementById('status').textContent.includes('State: FAILED')", 120000);
    if (!dryRunDone) throw new Error('production-bound-dry-run-timeout');
    const stateText = await evaluate(cdp, "document.getElementById('status').textContent");
    const details = await evaluate(cdp, "document.getElementById('recovery-details').textContent");
    const state = String(stateText || '').includes('State: APPROVAL_REQUIRED') ? 'READY_FOR_EXPLICIT_APPROVAL' : 'BLOCKED';
    const frozenPlanId = lineValue(details, 'Frozen P5.5 plan ID: ');
    const frozenPlanHash = lineValue(details, 'Frozen P5.5 plan SHA-256: ');
    const planHashField = lineValue(details, 'Composite planHash (unchanged): ');
    const productionPlanId = lineValue(details, 'Production-bound plan ID: ');
    const productionPlanHash = lineValue(details, 'Production-bound plan SHA-256: ');
    const targetIdentityText = lineValue(details, 'Target identity: ');
    const targetSnapshotHash = lineValue(details, 'Target snapshot SHA-256: ');
    const targetSnapshotManifestText = lineValue(details, 'Target snapshot manifest JSON: ');
    if (!targetSnapshotManifestText) throw new Error('target-snapshot-manifest-not-rendered');
    const targetSnapshotManifest = JSON.parse(targetSnapshotManifestText);
    if (targetSnapshotManifest.aggregateSha256 !== targetSnapshotHash) throw new Error('target-snapshot-manifest-aggregate-mismatch');
    if (/(?:api.?key|secret|content|timestamp|session|cache|wal|shm)/i.test(JSON.stringify(targetSnapshotManifest))) throw new Error('target-snapshot-manifest-forbidden-field-present');
    const authority = lineValue(details, 'Identity authority: ');
    const authorityRevisionId = lineValue(details, 'Authority revision ID: ');
    const authorityRevisionHash = lineValue(details, 'Authority revision SHA-256: ');
    const authorityProvenance = JSON.parse(lineValue(details, 'Authority provenance: '));
    const preflight = JSON.parse(lineValue(details, 'Preflight: '));
    const mutation = JSON.parse(lineValue(details, 'Mutation counters: '));
    const readonlyGuard = JSON.parse(await evaluate(cdp, 'JSON.stringify(window.__IB_P562_READONLY_GUARD__)'));
    const previewAudit = JSON.parse(await evaluate(cdp, `JSON.stringify((()=>{
      const text=id=>String(document.getElementById(id)&&document.getElementById(id).textContent||'').trim();
      const rows=Array.from(document.querySelectorAll('#preview-domain-rows tr')).map(row=>row.textContent.trim());
      const excluded=Array.from(document.querySelectorAll('#preview-excluded-data li')).map(item=>item.textContent.trim());
      const checks=['final-confirm-plan','final-confirm-snapshot','final-confirm-identity','final-confirm-credentials'].map(id=>{const item=document.getElementById(id);return !!item&&!item.checked});
      const phrase=document.getElementById('final-restore-confirmation'),continueButton=document.getElementById('enter-native-approval');
      const issue=document.getElementById('issue-production-approval'),execute=document.getElementById('execute-production-restore'),nativeControls=document.getElementById('production-approval-controls');
      return{
        visible:!!document.getElementById('recovery-preview')&&!document.getElementById('recovery-preview').hidden,
        planId:text('preview-plan-id'),planSha256:text('preview-plan-hash'),targetSnapshotSha256:text('preview-target-snapshot-hash'),
        sourceCount:Number(text('preview-source-count')),provenanceCount:Number(text('preview-provenance-count')),provenanceState:text('preview-provenance-state'),
        domainRows:rows,oldIdentity:text('preview-identity-old'),newIdentity:text('preview-identity-new'),identityAuthority:text('preview-identity-authority'),identityExplanation:text('preview-identity-explanation'),
        credentialState:text('preview-credential-state'),apiConfigMetadataCount:Number(text('preview-api-metadata-count')),excludedData:excluded,
        finalChecksUnchecked:checks.every(Boolean),finalPhraseBlank:!!phrase&&phrase.value==='',continueToNativeDisabled:!!continueButton&&continueButton.disabled,
        nativeApprovalControlsHidden:!!nativeControls&&nativeControls.hidden,issueApprovalDisabled:!!issue&&issue.disabled,executeRestoreDisabled:!!execute&&execute.disabled
      }
    })())`));
    let previewScreenshotPath = null, previewScreenshotError = null;
    if (process.argv.includes('--p5.8.6-preview-audit')) {
      try {
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true });
        const screenshotFile = path.join(ROOT, 'tmp', 'p32-w5-r3b', 'p5.8.6-preview.png');
        fs.mkdirSync(path.dirname(screenshotFile), { recursive: true });
        fs.writeFileSync(screenshotFile, Buffer.from(screenshot.data, 'base64'));
        previewScreenshotPath = path.relative(ROOT, screenshotFile).replace(/\\/g, '/');
      } catch (error) {
        previewScreenshotError = String(error && error.message || error);
      }
    }
    const resourceAudit = JSON.parse(await evaluate(cdp, `JSON.stringify((()=>{const entries=performance.getEntriesByType('resource');let external=0,localIpc=0,local=0,other=0;for(const entry of entries){const d=window.__IB_P564_CLASSIFY_DESTINATION__(entry.name,location.origin);if(d.kind==='EXTERNAL')external++;else if(d.kind==='TAURI_LOCAL_IPC')localIpc++;else if(d.kind==='LOCAL')local++;else other++}return{resourceEntries:entries.length,externalResources:external,tauriIpcResources:localIpc,localResources:local,otherSchemes:other,cspExternalViolations:window.__IB_P562_READONLY_GUARD__.externalResourceAssignments}})())`));
    const approvalNotIssuedAndApplyDisabled = await evaluate(cdp, "(()=>{const a=document.getElementById('issue-production-approval'),x=document.getElementById('execute-production-restore'),c=document.getElementById('approval-understands-production-write');return !!a&&!!x&&a.disabled&&x.disabled&&!!c&&!c.checked&&document.getElementById('approval-plan-id').value===''&&document.getElementById('approval-plan-hash').value===''&&document.getElementById('approval-confirmation').value===''})()");
    const applyFlagClosed = await evaluate(cdp, "window.IBProductionRecoveryAdapter.PRODUCTION_APPLY_ENABLED===false&&typeof window.IBProductionRecoveryAdapter.issueExplicitProductionRestoreApproval==='undefined'");
    const shell = JSON.parse(shellStatus);
    const targetIdentity = targetIdentityText ? JSON.parse(targetIdentityText) : null;
    const domainsLine = lineValue(details, 'Domains: ');
    const domains = domainsLine ? JSON.parse(domainsLine) : null;
    const activeState = await evaluate(cdp, "document.getElementById('active-rearm-state').textContent");
    const activeQuarantined = /quarantined/i.test(String(activeState||'')) && /blocked/i.test(String(activeState||''));
    servicesAfter = serviceIsolationSnapshot();
    assertServicesAbsent(servicesAfter, 'after-dry-run');
    const safetyFacts = {
      recoveryOnly: shell.mode === 'RECOVERY_ONLY',
      normalLauncherSuppressed: shell.normalRuntimeStarted === false,
      recoveryNetworkDisabled: shell.networkEnabled === false,
      activeQuarantined: activeQuarantined === true,
      approvalNotIssuedAndApplyDisabled: approvalNotIssuedAndApplyDisabled === true,
      productionApplyClosed: applyFlagClosed === true,
      productionWritesZero: mutation.productionWrites === 0,
      localStorageWritesZero: mutation.localStorageWrites === 0,
      providerCallsZero: mutation.providerCalls === 0,
      indexedDbReadwriteAttemptsZero: readonlyGuard.readwriteAttempts === 0,
      schemaUpgradeEventsZero: readonlyGuard.schemaUpgradeEvents === 0,
      guardedLocalStorageWritesZero: readonlyGuard.localStorageWriteAttempts === 0,
      externalNetworkAttemptsZero: readonlyGuard.externalNetworkAttempts === 0,
      allExternalRequestsBlockedBeforeDispatch: readonlyGuard.blockedExternalNetworkRequests === readonlyGuard.externalNetworkAttempts,
      externalNetworkSentZero: readonlyGuard.externalNetworkDispatches === 0,
      noExternalResourceFetches: resourceAudit.externalResources === 0 && resourceAudit.cspExternalViolations === 0,
      tauriIpcRestrictedToReadOnlyCheckpoint: readonlyGuard.tauriIpcAttempts === 1 && readonlyGuard.tauriIpcReadOnlyDispatches === 1 && readonlyGuard.tauriIpcRejectedRequests === 0 && readonlyGuard.tauriIpcDetails.every(item => item.command === 'read_recovery_checkpoint' && item.action === 'ALLOW_READ_ONLY_TAURI_IPC'),
      credentialNeedsRebind: preflight.credentialState === 'NEEDS_REBIND',
      secretValuesProjectedZero: preflight.secretValuesProjected === 0,
      recoveryPreviewVisible: previewAudit.visible && previewAudit.planId === productionPlanId && previewAudit.planSha256 === productionPlanHash && previewAudit.targetSnapshotSha256 === targetSnapshotHash,
      recoveryPreviewCountsAndProvenance: previewAudit.sourceCount === 539 && previewAudit.provenanceCount === 539 && previewAudit.provenanceState === 'Provenance bound',
      recoveryPreviewDomainsComplete: previewAudit.domainRows.length === 9 && previewAudit.domainRows.some(row => row.includes('autoMemory')) && previewAudit.domainRows.every(row => row.includes('BOUND ·')),
      recoveryPreviewIdentityBound: previewAudit.oldIdentity === 'friend_1785260690497' && previewAudit.newIdentity === 'friend_1788318367937_tcmw0p' && previewAudit.identityAuthority === 'USER_CONFIRMED_IDENTITY_SUCCESSION' && previewAudit.identityExplanation.includes('不是自动迁移发现'),
      recoveryPreviewCredentialAndExclusions: previewAudit.credentialState === 'NEEDS_REBIND' && previewAudit.apiConfigMetadataCount === 13 && ['cache','WebView session','WAL/SHM physical files','logs','runtime state'].every(value => previewAudit.excludedData.includes(value)),
      finalRestoreConfirmationNotCompleted: previewAudit.finalChecksUnchecked && previewAudit.finalPhraseBlank && previewAudit.continueToNativeDisabled,
      nativeApprovalFlowStillHidden: previewAudit.nativeApprovalControlsHidden && previewAudit.issueApprovalDisabled && previewAudit.executeRestoreDisabled
    };
    const safetyPass = Object.values(safetyFacts).every(Boolean);
    if (state === 'READY_FOR_EXPLICIT_APPROVAL') {
      if (frozenPlanId !== 'p32-w5-r3b3-p5.5:f99b6f236ecd78d3c111d106' || frozenPlanHash !== 'f99b6f236ecd78d3c111d106d3c1714b9790f65f09c34937de62ba21a9aea117' || planHashField !== frozenPlanHash) throw new Error('frozen-p5.5-identity-changed');
      if (authority !== 'USER_CONFIRMED_IDENTITY_SUCCESSION' || authorityRevisionId !== P562_AUTHORITY_REVISION_ID || authorityRevisionHash !== P562_AUTHORITY_REVISION_SHA256) throw new Error('p5.6.2-authority-revision-binding-invalid');
      if (authorityProvenance.recordCount !== 539 || authorityProvenance.traceDigest !== '420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5') throw new Error('p5.6.2-provenance-binding-invalid');
      if (!/^r3b3:[a-f0-9]{64}$/.test(String(productionPlanId || '')) || productionPlanId !== 'r3b3:' + productionPlanHash) throw new Error('production-bound-plan-identity-invalid');
      if (!/^[a-f0-9]{64}$/.test(String(targetSnapshotHash || '')) || !targetIdentity || targetIdentity.class !== 'production' || targetIdentity.origin !== 'http://tauri.localhost' || targetIdentity.databaseName !== 'InternalBeyondDB' || targetIdentity.schemaVersion !== 24 || !targetIdentity.identity.includes(INSTALL_ROOT)) throw new Error('production-target-binding-invalid');
      if (preflight.targetCollisions !== 0 || preflight.danglingReferences !== 0 || preflight.duplicates !== 0 || preflight.rejected !== 0) throw new Error('production-planner-preflight-not-clear');
      const authorityEvidence = lineValue(details, 'Authority evidence: ');
      if (!authorityEvidence || !authorityEvidence.includes('B_TEMPORAL_COEXISTENCE_ONLY') || !authorityEvidence.includes('B_PARTIAL_ROLE_SIMILARITY') || !authorityEvidence.includes('explicitTransitionFound')) throw new Error('authority-evidence-not-bound-to-plan');
    }
    output = {
      status: state === 'READY_FOR_EXPLICIT_APPROVAL' && !safetyPass ? 'BLOCKED_SAFETY_BOUNDARY' : state,
      stateText: stateText,
      shellMode: shell.mode,
      hostIdentity: hostIdentity,
      normalRuntimeStarted: shell.normalRuntimeStarted,
      activeQuarantined: activeQuarantined,
      verifiedSources: verifiedSources,
      sourceSummaryValidated: true,
      frozenPlanId: frozenPlanId,
      frozenPlanSha256: frozenPlanHash,
      authority: authority,
      authorityRevisionId: authorityRevisionId,
      authorityRevisionSha256: authorityRevisionHash,
      authorityProvenance: authorityProvenance,
      authorityEvidence: authorityEvidence,
      productionBoundPlanId: productionPlanId,
      productionBoundPlanSha256: productionPlanHash,
      targetIdentity: targetIdentity,
      targetSnapshotSha256: targetSnapshotHash,
      targetSnapshotManifest: targetSnapshotManifest,
      recoveryPreview: previewAudit,
      previewScreenshotPath: previewScreenshotPath,
      previewScreenshotError: previewScreenshotError,
      preflight: preflight,
      mutation: mutation,
      readonlyGuard: readonlyGuard,
      resourceAudit: resourceAudit,
      safetyFacts: safetyFacts,
      servicesBefore: servicesBefore,
      servicesDuring: servicesDuring,
      servicesAfter: servicesAfter,
      domainSummary: domains,
      approvalNotIssuedAndApplyDisabled: approvalNotIssuedAndApplyDisabled,
      productionApplyEnabled: false,
      productionIndexedDbWrites: 0,
      approvalTokenIssued: false,
      applyWindowOpened: false,
      activeState: activeState
    };
    }
  } finally {
    if (cdp) {
      try { await evaluate(cdp, "window.__TAURI__&&window.__TAURI__.window&&window.__TAURI__.window.getCurrentWindow().close()"); } catch (_) {}
      cdp.socket.destroy();
    }
    closeOk = await new Promise(resolve => {
      if (child.exitCode != null || child.signalCode != null) return resolve(true);
      child.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 12000);
    });
    if (!closeOk && child.pid) {
      await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-Command', "$p=Get-Process -Id " + String(child.pid) + " -ErrorAction SilentlyContinue; if($p){[void]$p.CloseMainWindow()}"], { windowsHide: true }, () => resolve()));
      closeOk = await new Promise(resolve => {
        if (child.exitCode != null || child.signalCode != null) return resolve(true);
        child.once('exit', () => resolve(true));
        setTimeout(() => resolve(false), 10000);
      });
    }
  }
  if (!closeOk) throw new Error('recovery-only-host-did-not-close-gracefully');
  const servicesAfterClose = serviceIsolationSnapshot();
  assertServicesAbsent(servicesAfterClose, 'after-host-close');
  if (servicesAfterClose.hostProcessCount !== 0) throw new Error('canonical-host-still-running-after-recovery-only-close');
  if (output) output.servicesAfterClose = servicesAfterClose;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  if (emitP585Result && output) process.stdout.write('P585_RESULT=' + JSON.stringify(output) + '\n');
  if (!output || (snapshotOnly ? output.status !== 'TARGET_SNAPSHOT_CAPTURED' : output.status !== 'READY_FOR_EXPLICIT_APPROVAL')) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write('BLOCKED ' + String(error && error.message || error) + '\n');
  process.exitCode = 1;
});
