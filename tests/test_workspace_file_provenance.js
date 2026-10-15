'use strict';

/* Internal Beyond · R4-2 · Workspace File Provenance
   Real browser/IndexedDB probe for canonical writer provenance and canonical-first
   archive collision routing.  The browser uses an isolated temporary profile. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const harness = read('tests/test_chat_smoke.js');
const boundary = harness.indexOf('async function main() {');
if (boundary <= 0) throw new Error('existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } =
  new Function('require', '__dirname', harness.slice(0, boundary)
    + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const PAGE_URL = 'file:///' + path.join(ROOT, 'InternalBeyond.html').replace(/\\/g, '/');

let failures = 0;
let passes = 0;
function ok(name, condition, detail) {
  if (condition) {
    passes++;
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.error('  FAIL  ' + name
      + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 500) : ''));
  }
}

function rmWithRetry(dir, tries) {
  for (let i = 0; i < (tries || 5); i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      /* retry */
    }
    const end = Date.now() + 200;
    while (Date.now() < end) { /* busy wait only for temp profile cleanup */ }
  }
  return false;
}

function staticContractChecks() {
  const files = read('assets/js/workspace/files.js');
  const ws = read('assets/js/workspace.js');
  const preview = read('assets/js/workspace/preview.js');
  const run = read('assets/js/workspace/run.js');
  const core = read('assets/js/core.js');
  const siteOps = read('assets/js/site-operations.js');

  ok('F7.humanWriterIsExplicit',
    /wsSaveFile\(f\.projectId,f\.path,ta\.value,'User',\{kind:'user'\}\)/.test(preview));
  ok('F8.importWriterIsExplicit',
    /wsSaveFile\(projId,f\.path,f\.content,'导入',\{kind:'import'\}\)/.test(files));
  ok('F9.scriptWriterIsExplicit',
    /wsSaveFile\(ctx\.projId,n,c,'脚本',\{kind:'script'\}\)/.test(run));
  ok('F10.noDirectPersistedToolWriter',
    !/wsSaveFile\(/.test(siteOps) && !/dbPut\(['"]projectFiles['"]/.test(siteOps));
  ok('F20.copyCarriesCanonicalFields',
    /copied\.lastModifiedByKind=cur\.lastModifiedByKind/.test(files)
    && /copied\.lastModifiedById=cur\.lastModifiedById/.test(files));
  ok('F21.displayLabelRemainsUIField',
    /f\.lastModifiedBy==='你'\?'User':f\.lastModifiedBy/.test(files));
  ok('F22.dbVer24', require('./helpers/db-schema-authority.js').isVersion('InternalBeyondDB', 24));
  ok('F25.routingHasNoDisplayIdentityComparison',
    !/lastModifiedBy\s*!?==/.test(ws));
  ok('F25.routingUsesCanonicalValidity',
    /_wsCanonicalFileProvenanceValid/.test(ws)
    && /_wsArchiveCollisionNeedsUniquePath/.test(ws));
}

async function browserE2E() {
  const chrome = chromePath();
  ok('browser.binaryFound', !!chrome, chrome);
  if (!chrome) {
    console.log('REAL_BROWSER_GATE_DEFERRED_BY_TOOLING');
    return;
  }

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r4-2-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  const exceptions = [];
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (response.ok) {
          ready = true;
          break;
        }
      } catch (e) {
        /* starting */
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    ok('browser.ready', ready);
    if (!ready) return;

    const tab = await (await fetch(
      'http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL),
      { method: 'PUT' }
    )).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    cdp.on('Runtime.exceptionThrown', event => {
      const detail = event.exceptionDetails || {};
      const exception = detail.exception || {};
      exceptions.push(String(exception.description || detail.text || ''));
    });

    const pageReady = await waitFor(cdp,
      'typeof window._execWsOps==="function"'
      + '&&typeof window.wsSaveFile==="function"'
      + '&&typeof window._wsArchiveFileBlocks==="function"'
      + '&&typeof window._wsExecuteRun==="function"'
      + '&&typeof window._ibBuildExportData==="function"'
      + '&&typeof window._ibMirrorNow==="function"', 25000);
    ok('browser.workspaceSeamsReady', pageReady);
    if (!pageReady) return;

    const prepared = await evaluate(cdp,
      '(async function(){'
      + 'var all=await dbGetAll("projectFiles");'
      + 'for(var i=0;i<all.length;i++){'
      + 'if(String(all[i].path||"").indexOf("r4-")===0)await dbDelete("projectFiles",all[i].id);'
      + '}'
      + 'var pid=await wsEnsureDefaultProject();'
      + 'window._wsActiveProject=pid;'
      + 'return {pid,dbVer:window.DB_VER};'
      + '})()');
    ok('F22.runtimeDbVer24', prepared && prepared.dbVer === 24, prepared);

    const probe = await evaluate(cdp,
      '(async function(){'
      + 'var pid=' + JSON.stringify(prepared.pid) + ';'
      + 'var A={id:"r4-role-a",nickname:"X"};'
      + 'var B={id:"r4-role-b",nickname:"X"};'
      + 'var roleWrite=async function(cfg,path,content){'
      + 'window._wsActiveProject=pid;'
      + 'return (await _execWsOps([{type:"create",path:path,content:content,overwrite:true}],cfg.nickname,cfg,{source:"r4"}))[0];'
      + '};'
      + 'var readFile=function(path){return wsGetFileByPath(pid,path)};'
      + 'var filesFor=function(path){var dot=path.lastIndexOf(".");var stem=dot>0?path.slice(0,dot):path;return wsGetFiles(pid).then(function(xs){return xs.filter(function(x){return x.path===path||x.path.indexOf(stem+" (")===0})})};'
      + 'await roleWrite(A,"r4-role-a.txt","A");'
      + 'await roleWrite(B,"r4-role-b.txt","B");'
      + 'var fA=await readFile("r4-role-a.txt"),fB=await readFile("r4-role-b.txt");'
      + 'var sameName=fA&&fB&&fA.lastModifiedBy==="X"&&fB.lastModifiedBy==="X"'
      + '&&fA.lastModifiedByKind==="role"&&fB.lastModifiedByKind==="role"'
      + '&&fA.lastModifiedById===A.id&&fB.lastModifiedById===B.id'
      + '&&fA.lastModifiedById!==fB.lastModifiedById;'
      + 'var reserved=[{cfg:{id:"r4-role-user",nickname:"User"},path:"r4-reserved-user.txt"},'
      + '{cfg:{id:"r4-role-you",nickname:"你"},path:"r4-reserved-you.txt"},'
      + '{cfg:{id:"r4-role-import",nickname:"导入"},path:"r4-reserved-import.txt"}];'
      + 'var reservedRows=[];'
      + 'for(var r=0;r<reserved.length;r++){'
      + 'var rr=reserved[r];'
      + 'await roleWrite(rr.cfg,rr.path,"old");'
      + 'var before=await readFile(rr.path);'
      + 'var routeBefore=_wsArchiveCollisionNeedsUniquePath(before);'
      + 'await _wsArchiveFileBlocks([{path:rr.path,content:"new"}],"X",_wsRoleFileProvenance(B));'
      + 'var after=await filesFor(rr.path);'
      + 'reservedRows.push({routeBefore:routeBefore,count:after.length,content:(await readFile(rr.path)||{}).content,kind:(await readFile(rr.path)||{}).lastModifiedByKind});'
      + '}'
      + 'var humanPath="r4-human.txt";'
      + 'await wsSaveFile(pid,humanPath,"human","User",{kind:"user"});'
      + 'var humanBefore=await readFile(humanPath);'
      + 'var humanRoute=_wsArchiveCollisionNeedsUniquePath(humanBefore);'
      + 'await _wsArchiveFileBlocks([{path:humanPath,content:"role"}],"X",_wsRoleFileProvenance(A));'
      + 'var humanRows=await filesFor(humanPath);'
      + 'var humanSafe=humanRoute===true&&humanRows.length===2'
      + '&&humanRows.some(function(x){return x.path===humanPath&&x.content==="human"})'
      + '&&humanRows.some(function(x){return x.path!==humanPath&&x.content==="role"});'
      + 'var importPath="r4-import.txt";'
      + 'await wsSaveFile(pid,importPath,"import","导入",{kind:"import"});'
      + 'var importBefore=await readFile(importPath);'
      + 'var importRoute=_wsArchiveCollisionNeedsUniquePath(importBefore);'
      + 'await _wsArchiveFileBlocks([{path:importPath,content:"role"}],"X",_wsRoleFileProvenance(A));'
      + 'var importRows=await filesFor(importPath);'
      + 'var importSafe=importRoute===true&&importRows.length===2'
      + '&&importRows.some(function(x){return x.path===importPath&&x.content==="import"})'
      + '&&importRows.some(function(x){return x.path!==importPath&&x.content==="role"});'
      + 'var legacyLabels=["User","你","导入"],legacyResults=[];'
      + 'for(var l=0;l<legacyLabels.length;l++){'
      + 'var lp="r4-legacy-"+l+".txt";'
      + 'await wsSaveFile(pid,lp,"legacy-"+l,legacyLabels[l]);'
      + 'var legacyBefore=await readFile(lp);'
      + 'var legacyRoute=_wsArchiveCollisionNeedsUniquePath(legacyBefore);'
      + 'await _wsArchiveFileBlocks([{path:lp,content:"replacement-"+l}],"X",_wsRoleFileProvenance(A));'
      + 'var legacyRows=await filesFor(lp);'
      + 'legacyResults.push(legacyRoute===true&&legacyRows.length===2'
      + '&&legacyRows.some(function(x){return x.path===lp&&x.content==="legacy-"+l}));'
      + '}'
      + 'var invalidRecords=['
      + '{id:"r4-invalid-role",projectId:pid,path:"r4-invalid-role.txt",content:"old",size:3,created:1,lastModified:1,lastModifiedBy:"User",lastModifiedByKind:"role"},'
      + '{id:"r4-invalid-user",projectId:pid,path:"r4-invalid-user.txt",content:"old",size:3,created:1,lastModified:1,lastModifiedBy:"User",lastModifiedByKind:"user",lastModifiedById:""},'
      + '{id:"r4-invalid-kind",projectId:pid,path:"r4-invalid-kind.txt",content:"old",size:3,created:1,lastModified:1,lastModifiedBy:"导入",lastModifiedByKind:"unknown"}'
      + '];'
      + 'var invalidResults=[];'
      + 'for(var z=0;z<invalidRecords.length;z++){'
      + 'var ir=invalidRecords[z];await dbPut("projectFiles",ir);'
      + 'var invalidRoute=_wsArchiveCollisionNeedsUniquePath(ir);'
      + 'await _wsArchiveFileBlocks([{path:ir.path,content:"new"}],"X",_wsRoleFileProvenance(A));'
      + 'var invalidRows=await filesFor(ir.path);'
      + 'invalidResults.push(invalidRoute===true&&invalidRows.length===2&&invalidRows.some(function(x){return x.path===ir.path&&x.content==="old"}));'
      + '}'
      + 'var mismatchPath="r4-canonical-mismatch.txt";'
      + 'await wsSaveFile(pid,mismatchPath,"old","User",{kind:"role",id:A.id});'
      + 'var mismatchBefore=await readFile(mismatchPath);'
      + 'var mismatchRoute=_wsArchiveCollisionNeedsUniquePath(mismatchBefore);'
      + 'await _wsArchiveFileBlocks([{path:mismatchPath,content:"new"}],"X",_wsRoleFileProvenance(B));'
      + 'var mismatchRows=await filesFor(mismatchPath);'
      + 'var canonicalWins=mismatchRoute===false&&mismatchRows.length===1'
      + '&&mismatchRows[0].path===mismatchPath&&mismatchRows[0].content==="new"'
      + '&&mismatchRows[0].lastModifiedByKind==="role"&&mismatchRows[0].lastModifiedById===B.id;'
      + 'var partialInvalid=['
      + '_wsArchiveCollisionNeedsUniquePath({lastModifiedBy:"User",lastModifiedByKind:"role"}),'
      + '_wsArchiveCollisionNeedsUniquePath({lastModifiedBy:"User",lastModifiedByKind:"role",lastModifiedById:""}),'
      + '_wsArchiveCollisionNeedsUniquePath({lastModifiedBy:"User",lastModifiedByKind:"user",lastModifiedById:"x"}),'
      + '_wsArchiveCollisionNeedsUniquePath({lastModifiedBy:"导入",lastModifiedByKind:"unknown"})'
      + '].every(Boolean);'
      + 'var legacy=await readFile("r4-legacy-0.txt");'
      + 'var legacyReadable=!!legacy&&legacy.lastModifiedBy==="User"'
      + '&&legacy.lastModifiedByKind===undefined&&legacy.lastModifiedById===undefined;'
      + 'var reloadPath="r4-reload.txt";'
      + 'await wsSaveFile(pid,reloadPath,"reload","X",_wsRoleFileProvenance(A));'
      + 'var reloadBefore=await readFile(reloadPath);'
      + 'var exportData=await _ibBuildExportData();'
      + 'var exportRecord=(exportData.projectFiles||[]).find(function(x){return x.path===reloadPath});'
      + 'var exportKeeps=!!exportRecord&&exportRecord.lastModifiedByKind==="role"&&exportRecord.lastModifiedById===A.id;'
      + 'await dbDelete("projectFiles",reloadBefore.id);'
      + 'var input=document.createElement("input");'
      + 'Object.defineProperty(input,"files",{value:[new Blob([JSON.stringify(exportData)],{type:"application/json"})]});'
      + 'await importAll({target:input});'
      + 'var imported=await readFile(reloadPath);'
      + 'var importKeeps=!!imported&&imported.lastModifiedByKind==="role"&&imported.lastModifiedById===A.id;'
      + 'await _ibMirrorNow(true);'
      + 'var pack=null;try{pack=JSON.parse(localStorage.getItem("ib_mirror_v1")||"null")}catch(e){}'
      + 'var mirrorRecord=pack&&pack.stores&&pack.stores.projectFiles'
      + '&&pack.stores.projectFiles.find(function(x){return x.path===reloadPath});'
      + 'var mirrorKeeps=!!mirrorRecord&&mirrorRecord.lastModifiedByKind==="role"&&mirrorRecord.lastModifiedById===A.id;'
      + 'var scriptRes=await _wsExecuteRun({lang:"js",entry:"",code:"save(\\\"r4-script-output.txt\\\",\\\"written\\\")",projId:pid,timeoutSec:5,author:"X",actorId:A.id});'
      + 'var scriptFile=await readFile("r4-script-output.txt");'
      + 'var scriptKeeps=!!scriptRes&&scriptRes.ok===true&&!!scriptFile'
      + '&&scriptFile.lastModifiedBy==="脚本"&&scriptFile.lastModifiedByKind==="script"'
      + '&&scriptFile.lastModifiedById===undefined;'
      + 'await wsSaveFile(pid,"r4-ui.txt","ui","User",{kind:"user"});'
      + 'await renderWsFiles(pid);'
      + 'var uiRow=Array.prototype.slice.call(document.querySelectorAll(".ws-file-row")).find(function(row){'
      + 'var n=row.querySelector(".ws-file-name");return n&&n.textContent==="r4-ui.txt";'
      + '});'
      + 'var uiMeta=uiRow&&uiRow.querySelector(".ws-file-meta");'
      + 'var uiKeepsLabel=!!uiMeta&&uiMeta.textContent.indexOf("User")>=0;'
      + 'return {sameName:sameName,reservedRows:reservedRows,humanSafe:humanSafe,importSafe:importSafe,'
      + 'legacyResults:legacyResults,legacyReadable:legacyReadable,invalidResults:invalidResults,'
      + 'canonicalWins:canonicalWins,partialInvalid:partialInvalid,exportKeeps:exportKeeps,'
      + 'importKeeps:importKeeps,mirrorKeeps:mirrorKeeps,reloadPath:reloadPath,scriptKeeps:scriptKeeps,'
      + 'uiKeepsLabel:uiKeepsLabel};'
      + '})()');

    ok('F1_F2_F3.sameNameRolesPersistCanonicalIds',
      !!probe && probe.sameName === true, probe);
    ok('F4_F5_F6.reservedRoleLabelsRemainRole',
      !!probe && probe.reservedRows.length === 3
      && probe.reservedRows.every(function(row) {
        return row.routeBefore === false && row.count === 1
          && row.content === 'new' && row.kind === 'role';
      }), probe && probe.reservedRows);
    ok('F7.humanManualProvenance', !!probe && probe.humanSafe === true, probe);
    ok('F8.importProvenance', !!probe && probe.importSafe === true, probe);
    ok('F9.scriptWritebackProvenance', !!probe && probe.scriptKeeps === true, probe);
    ok('F10.toolPathHasNoIndependentProjectFileWriter',
      !/wsSaveFile\(/.test(read('assets/js/site-operations.js')), 'tool writes runtime result only');
    ok('F11.legacyRecordReadable', !!probe && probe.legacyReadable === true, probe);
    ok('F12_F13_F14.legacyReservedLabelsUseConservativeRouting',
      !!probe && probe.legacyResults.length === 3 && probe.legacyResults.every(Boolean), probe);
    ok('F15.canonicalPresentBeatsDisplayCollision',
      !!probe && probe.canonicalWins === true, probe);
    ok('F16.canonicalMismatchNeverUsesDisplayFallback',
      !!probe && probe.canonicalWins === true, probe);
    ok('F17.partialInvalidCanonicalIsConservative',
      !!probe && probe.partialInvalid === true
      && probe.invalidResults.length === 3 && probe.invalidResults.every(Boolean), probe);
    ok('F18.indexedDbRoundTrip', !!probe && probe.importKeeps === true, probe);
    ok('F20.exportImportAndMirrorPreserveCanonical',
      !!probe && probe.exportKeeps === true && probe.importKeeps === true
      && probe.mirrorKeeps === true, probe);
    ok('F21.uiKeepsDisplayLabel', !!probe && probe.uiKeepsLabel === true, probe);

    await evaluate(cdp, 'window._wsActiveProject=' + JSON.stringify(prepared.pid));
    const reloadLoaded = new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, 25000);
      cdp.on('Page.loadEventFired', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
    await cdp.send('Page.reload', { ignoreCache: true });
    const reloaded = await reloadLoaded && await waitFor(cdp,
      'document.readyState==="complete"&&typeof window.wsGetFileByPath==="function"'
      + '&&typeof window._execWsOps==="function"', 25000);
    ok('F19.browserReloadReady', reloaded);
    const afterReload = reloaded ? await evaluate(cdp,
      '(async function(){'
      + 'var f=(await window.dbGetAll("projectFiles")).find(function(x){return x.projectId==='
      + JSON.stringify(prepared.pid) + '&&x.path==="r4-reload.txt";});'
      + 'return !!f&&f.lastModifiedBy==="X"&&f.lastModifiedByKind==="role"&&f.lastModifiedById==="r4-role-a";'
      + '})()') : false;
    ok('F19.reloadPreservesCanonicalFields',
      afterReload === true, afterReload);

    ok('console.noTypeErrorReferenceErrorUnhandledRejection',
      exceptions.length === 0, exceptions.slice(0, 5));
  } finally {
    try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
    try { browser.kill(); } catch (e) { /* ignore */ }
    rmWithRetry(profile, 5);
  }
}

async function main() {
  console.log('== R4-2 · Workspace File Provenance Implementation 测试 ==');
  staticContractChecks();
  await browserE2E();
  console.log(failures === 0
    ? '\n全部通过 ✔  (' + passes + ')'
    : '\n失败 ' + failures + ' 项，已通过 ' + passes + ' 项');
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => {
  console.error('harness error: ' + (error && error.stack || error));
  process.exitCode = 2;
});
