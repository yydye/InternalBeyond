'use strict';

/* Runs the recovery adapter against real IndexedDB in a disposable browser
 * profile and isolated loopback origin. No production WebView/Profile is opened. */
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const http=require('http');
const {spawn}=require('child_process');
const ROOT=path.resolve(__dirname,'..');

function browserPath(){
  if(process.env.CHROME_PATH&&fs.existsSync(process.env.CHROME_PATH))return process.env.CHROME_PATH;
  for(const candidate of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ])if(fs.existsSync(candidate))return candidate;
  return null;
}
function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port))})}
function waitExit(child,ms){return new Promise(resolve=>{if(child.exitCode!==null||child.signalCode)return resolve();const timer=setTimeout(resolve,ms);child.once('exit',()=>{clearTimeout(timer);resolve()})})}
function findUnexpectedRuntimeFiles(root){
  const found=[];
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(/^(home-node\.db(?:-wal|-shm)?|credential-vault\.(?:key|json)|active-message-service\.json)$/i.test(entry.name))found.push(full);if(entry.isDirectory())walk(full)}}
  if(fs.existsSync(root))walk(root);
  return found;
}

async function main(){
  const chrome=browserPath();
  if(!chrome){console.log('SKIP: Chrome/Edge not found');process.exitCode=0;return}
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ib-r3b2-temporary-profile-'));
  let posted=null,finishPost;
  let timeoutId=null;
  const postedPromise=new Promise(resolve=>{finishPost=resolve});
  const allowed=new Map([
    ['/fixture.html',{file:path.join(__dirname,'fixtures','recovery-adapter-browser.html'),type:'text/html; charset=utf-8'}],
    ['/tests/fixtures/recovery-adapter-browser-spec.js',{file:path.join(__dirname,'fixtures','recovery-adapter-browser-spec.js'),type:'text/javascript; charset=utf-8'}],
    ['/assets/js/webcore-db-schema.js',{file:path.join(ROOT,'assets','js','webcore-db-schema.js'),type:'text/javascript; charset=utf-8'}],
    ['/assets/js/recovery-engine.js',{file:path.join(ROOT,'assets','js','recovery-engine.js'),type:'text/javascript; charset=utf-8'}],
    ['/assets/js/recovery-webcore-adapter.js',{file:path.join(ROOT,'assets','js','recovery-webcore-adapter.js'),type:'text/javascript; charset=utf-8'}]
  ]);
  const server=http.createServer((req,res)=>{
    if(req.method==='POST'&&req.url==='/report'){
      let raw='';req.setEncoding('utf8');req.on('data',chunk=>{raw+=chunk});req.on('end',()=>{
        try{posted=JSON.parse(raw);res.writeHead(200,{'Content-Type':'application/json','Connection':'close'});res.end('{"ok":true}');finishPost(posted)}
        catch(error){res.writeHead(400,{'Connection':'close'});res.end();finishPost({ok:false,error:String(error)})}
      });return;
    }
    const entry=allowed.get(new URL(req.url,'http://127.0.0.1').pathname);
    if(!entry){res.writeHead(404,{'Connection':'close'});res.end();return}
    fs.readFile(entry.file,(error,bytes)=>{
      if(error){res.writeHead(500,{'Connection':'close'});res.end();return}
      res.writeHead(200,{'Content-Type':entry.type,'Cache-Control':'no-store','Connection':'close'});res.end(bytes);
    });
  });
  let browser=null;
  try{
    const port=await listen(server);
    const url='http://127.0.0.1:'+port+'/fixture.html';
    browser=spawn(chrome,[
      '--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--user-data-dir='+profile,url
    ],{stdio:'ignore',windowsHide:true});
    const timeout=new Promise((_,reject)=>{timeoutId=setTimeout(()=>reject(new Error('browser IndexedDB test timed out')),60000)});
    const result=await Promise.race([postedPromise,timeout]);
    assert.ok(result&&result.ok,'browser checks failed: '+JSON.stringify(result&&result.checks||result&&result.error));
    for(const check of result.checks||[])console.log((check.ok?'✓ ':'✗ ')+check.name+(check.detail?` — ${check.detail}`:''));
    assert.strictEqual(result.profileOrigin,'http://127.0.0.1:'+port);
    assert.strictEqual(result.temporaryTarget,'InternalBeyondDB v24');
    assert.strictEqual(result.productionProfileAccessed,false);
    assert.strictEqual(result.providerCalls,0);
    assert.strictEqual(result.activeStarted,false);
    assert.strictEqual(result.bridgeStarted,false);
    assert.strictEqual(result.homeNodeStarted,false);
    const unexpectedRuntimeFiles=findUnexpectedRuntimeFiles(profile);
    assert.deepStrictEqual(unexpectedRuntimeFiles,[],'temporary Chromium profile must not create IB service/runtime data');
    console.log('Temporary browser profile: '+profile);
    console.log('PASS: RecoveryWebCoreAdapter disposable IndexedDB checks');
  }finally{
    if(timeoutId)clearTimeout(timeoutId);
    if(browser){try{browser.kill()}catch(e){};await waitExit(browser,5000)}
    if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()))}
    try{fs.rmSync(profile,{recursive:true,force:true})}catch(e){console.error('temporary profile cleanup failed:',String(e&&e.message||e));process.exitCode=1}
    if(!posted&&process.exitCode!==1)process.exitCode=1;
  }
}

main().catch(error=>{console.error(error&&error.stack||error);process.exitCode=1});
