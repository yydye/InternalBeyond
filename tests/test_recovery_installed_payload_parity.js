'use strict';

/* Read-only parity check of the current canonical staging payload and install root. */
const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const staging=path.join(root,'dist','staging');
const installRoot=path.resolve(process.argv[2]||'C:\\Users\\admin\\AppData\\Local\\Programs\\InternalBeyond');

function digest(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
function walk(dir,prefix){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const rel=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isDirectory())out.push(...walk(path.join(dir,entry.name),rel));else out.push(rel.replace(/\\/g,'/'));
  }
  return out;
}

assert.ok(fs.existsSync(staging),'dist/staging missing; build canonical installer first');
assert.ok(fs.existsSync(installRoot),'canonical installed root missing');
const manifest=JSON.parse(fs.readFileSync(path.join(staging,'ib-payload-manifest.json'),'utf8'));
assert.strictEqual(manifest.schema,'internalbeyond.payload-manifest');
assert.strictEqual(manifest.count,manifest.files.length);
const listed=new Set(manifest.files);
const missing=[],changed=[];
for(const relative of manifest.files){
  const staged=path.join(staging,...relative.split('/'));
  const installed=path.join(installRoot,...relative.split('/'));
  if(!fs.existsSync(installed)){missing.push(relative);continue}
  const a=fs.statSync(staged),b=fs.statSync(installed);
  if(a.size!==b.size||digest(staged)!==digest(installed))changed.push(relative);
}
const toleratedInno=/^unins\d+\.(?:exe|dat)$/i;
const unexpected=walk(installRoot,'').filter(relative=>!listed.has(relative)&&!toleratedInno.test(relative));
assert.deepStrictEqual(missing,[],'installed payload files missing');
assert.deepStrictEqual(changed,[],'installed payload bytes differ from canonical staging');
assert.deepStrictEqual(unexpected,[],'unexpected non-Inno files in install root');
for(const relative of [
  'Recovery.html','assets/js/composite-recovery-plan.js','assets/js/recovery-production-adapter.js',
  'assets/js/recovery-first-boot.js','assets/js/recovery-source-manifest.js','assets/js/recovery-ui.js',
  'assets/js/recovery-shell.js','assets/js/recovery-c3-5-reconstruction.js',
  'services/home-node/reconstruction-runner.js','services/home-node/c35 child boundary probe 子进程.js',
  'services/home-node/production-reconstruction-adapter.js',
  'services/home-node/composite-reconstruction-executor.js','services/home-node/composite-reconstruction-approval.js',
  'services/home-node/character-projection-store.js',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/composite-bundle.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-reconstruction-write-set.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/character-projection-write-set.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/home-node-proposed-write-set.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/character-field-authority-matrix.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/character-conflict-resolution.json',
  'services/home-node/reconstruction-contracts/p32-w5-r3c3/c2-authority-report.json'
])assert.ok(listed.has(relative),relative);
process.stdout.write(JSON.stringify({result:'PASS',installRoot:installRoot,manifestCount:manifest.count,missing:missing.length,changed:changed.length,unexpected:unexpected.length})+'\n');
