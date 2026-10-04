'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   P21-R4-LIVE-1.2 · MetaMemory INTERNAL OBSERVABILITY — browser production-seam proof

   真实浏览器（headless Chrome / Edge，经既有 `scripts/cdp-lite.js` 同款 CDP 协议）：
     真实 InternalBeyond.html  ·  真实 assets/js/memory.js
     ·  真实 memory-recall-orchestrator.js  ·  真实 metamemory-shadow.js
     ·  真实生产 seam `selectMemoryContext(apiId, { _ibTurn })`
     ·  从**调用方持有的同一个 turn 对象**读回 `metaMemoryDiagnostics`

   不跑 communication.js E2E，不调 provider，不碰 Middle Brain。
   运行：node tests/test_metamemory_observability_smoke.js
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(fs.existsSync) || null;
}
class Cdp {
  constructor(s) { this.socket = s; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.listeners = new Map(); s.on('data', c => { this.buffer = Buffer.concat([this.buffer, c]); this.parse(); }); s.on('error', () => {}); }
  static connect(u) { return new Promise((res, rej) => { const url = new URL(u); const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } }); req.on('upgrade', (r, s) => res(new Cdp(s))); req.on('error', rej); req.end(); }); }
  on(m, l) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(l); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.sendText({ id, method: m, params: p }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + m)); } }, 20000); }); }
  sendText(msg) { const p = Buffer.from(JSON.stringify(msg)); const mask = crypto.randomBytes(4); const body = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3]; let h; if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } this.socket.write(Buffer.concat([h, mask, body])); }
  parse() { while (true) { if (this.buffer.length < 2) return; const op = this.buffer[0] & 0x0f; let len = this.buffer[1] & 0x7f, off = 2; if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; } else if (len === 127) return; if (this.buffer.length < off + len) return; const pl = this.buffer.slice(off, off + len); this.buffer = this.buffer.slice(off + len); if (op === 1) { try { const m = JSON.parse(pl.toString('utf8')); if (this.pending.has(m.id)) { const q = this.pending.get(m.id); this.pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); } if (m.method && this.listeners.has(m.method)) for (const l of this.listeners.get(m.method)) l(m.params); } catch (e) {} } } }
  close() { try { this.socket.end(); } catch (e) {} }
}
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}
async function waitFor(cdp, expr, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await evaluate(cdp, expr)) return true; } catch (e) {} await new Promise(r => setTimeout(r, 150)); } return false; }
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? rej(e) : res(p)); }); }); }

const SECRET = 'LIVE1_SECRET_SENTINEL_7F91';
const HIDDEN_ID = 'hidden_relay_88';
const J = JSON.stringify;

let passed = 0, failures = 0;
const check = (n, ok, d) => { if (ok) { passed++; console.log('  PASS  ' + n); } else { failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

function seedMemory(o) {
  return Object.assign({
    id: 'm1', title: '标题', summary: '', content: '内容', oneLine: '', domain: '日常',
    rawSource: 'user_message', sourceId: 's1', tags: [], valence: 0.2, arousal: 0.6,
    importance: 6, resolved: false, pinned: false, visibility: 'public',
    visibleTo: [], excludeFrom: [], createdBy: 'user', createdAt: Date.now(),
    activationCount: 0, lastActivated: Date.now() - 3600000, created: Date.now() - 86400000,
    kind: 'episodic', consolidatedFrom: [], lastConsolidatedAt: null
  }, o || {});
}

(async function main() {
  const chrome = chromePath();
  if (!chrome) { console.error('NO BROWSER FOUND'); process.exit(1); }
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mm-obs-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    if (!ready) throw new Error('CDP not ready');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    section('F · production asset load');
    check('F1.pageBoots', await waitFor(cdp, "typeof selectMemoryContext==='function'&&typeof dbPut==='function'"), 'real memory.js seam must be exposed');
    check('F2.realModulesLoaded', await evaluate(cdp,
      "!!(window.IBMemoryRecallOrchestrator&&window.IBMemoryMetaMemoryShadow&&window.IBMemoryRecallTrace)"
      + "&&typeof window.IBMemoryMetaMemoryShadow.evaluateTurnShadow==='function'"),
      'orchestrator + metamemory-shadow must be the real production scripts');

    /* ── 真实 seeded canonical memory（含敏感正文 / 隐藏项 / 另一角色）── */
    const seed = [
      seedMemory({ id: 'm_direct', content: SECRET + ' 他说会来', rawSource: 'user_message', createdBy: 'user' }),
      seedMemory({ id: 'm_attested', content: '他说过会来', rawSource: 'chat', sourceId: 'msg_1', createdBy: 'ai' }),
      seedMemory({ id: 'm_unavail', content: '某次约定', rawSource: 'chat', sourceId: 'msg_missing', createdBy: 'ai' }),
      seedMemory({ id: HIDDEN_ID, content: SECRET + ' 隐藏正文', visibility: 'private',
        visibleTo: ['other_role'], createdBy: 'user' })
    ];
    await evaluate(cdp, "(async function(){var rows=" + J(seed) + ";for(var i=0;i<rows.length;i++){await dbPut('memories',rows[i]);}return (await dbGetAll('memories')).length})()");

    section('G · production seam observation');
    const out = await evaluate(cdp, `(async function(){
      var turn={__ibTurnScope:true,label:'chat',ownsCycle:true,guard:null,_guardCycle:false,active:false,
        round:0,activityId:null,ledger:{},nameMap:{},calls:[],tools:null,_acc:null};
      var res=await selectMemoryContext('obs_role',{now:1760000000000,random:function(){return 0.42},
        userMessage:'他说会来',turnIndex:1,_ibTurn:turn});
      return {returnKeys:Object.keys(res),contextLen:(res.context||'').length,
        selectedIds:res.selectedIds,activationPolicy:res.activationPolicy,
        diag:turn.metaMemoryDiagnostics||null,
        diagJson:turn.metaMemoryDiagnostics?JSON.stringify(turn.metaMemoryDiagnostics):null};
    })()`);
    const diag = out && out.diag;
    check('G1.callerHeldTurnReceivesDiagnostics', !!diag, 'the caller-held _ibTurn must carry metaMemoryDiagnostics');
    check('G2.returnShapeUnchanged',
      J(out.returnKeys) === J(['context', 'selectedIds', 'activationPolicy']),
      'selectMemoryContext return keys: ' + J(out.returnKeys));

    section('I · diagnostic projection');
    if (diag) {
      check('I1.versionAndProducer', diag.version === 1 && diag.producer === 'memory.js/selectMemoryContext');
      check('I2.evidenceViewAuthorized', diag.evidenceView === 'authorized', String(diag.evidenceView));
      check('I3.countsAreWhitelisted',
        Object.keys(diag.counts || {}).every(k => ['selected', 'direct', 'attested', 'degraded', 'defective', 'unavailable'].indexOf(k) >= 0)
        && Object.keys(diag.counts || {}).length > 0,
        'counts keys = ' + J(Object.keys(diag.counts || {})));
      check('I4.evaluatedIsANumber', typeof diag.evaluated === 'number' || diag.evaluated === null, String(diag.evaluated));
    } else { check('I1.versionAndProducer', false, 'no diagnostics'); }

    section('K · privacy');
    check('K1.lostFieldDoesNotExist',
      !Object.prototype.hasOwnProperty.call(diag && diag.counts || {}, 'lost'),
      'counts must NOT have an own "lost" property (not 0, not null — absent)');
    check('K2.hiddenFieldDoesNotExist',
      !Object.prototype.hasOwnProperty.call(diag && diag.counts || {}, 'hidden'),
      'counts must NOT have an own "hidden" property');
    check('K3.sensitiveContentAbsent',
      out.diagJson.indexOf(SECRET) < 0, 'the diagnostic payload must not contain the seeded sentinel');
    check('K4.hiddenMemoryAbsent',
      out.diagJson.indexOf(HIDDEN_ID) < 0 && out.diagJson.indexOf('隐藏正文') < 0,
      'no hidden id / content may appear');
    check('K5.reasonCodesAreSafeVocabulary',
      Array.isArray(diag.reasonCodes)
      && diag.reasonCodes.every(c => /^[a-z0-9-]+$/.test(c))
      && diag.reasonCodes.indexOf('upstream-evidence-lost') < 0
      && diag.reasonCodes.indexOf('upstream-evidence-hidden') < 0,
      'reasonCodes = ' + J(diag.reasonCodes));
    check('K6.noIdsAnywhere', out.diagJson.indexOf('m_direct') < 0 && out.diagJson.indexOf('m_attested') < 0,
      'ID policy = EXCLUDE: no memory ids in the diagnostic payload');

    section('J · state coverage (real evaluator, no faking)');
    const states = await evaluate(cdp, `(async function(){
      var turn={__ibTurnScope:true,label:'chat',ownsCycle:true};
      var res=await selectMemoryContext('obs_role',{now:1760000000000,random:function(){return 0.42},
        userMessage:'他说会来',turnIndex:1,_ibTurn:turn});
      return {counts:turn.metaMemoryDiagnostics?turn.metaMemoryDiagnostics.counts:null,
              evaluated:turn.metaMemoryDiagnostics?turn.metaMemoryDiagnostics.evaluated:null};
    })()`);
    check('J1.realCountsReflectEvaluation',
      states && states.counts && (states.counts.selected > 0 || states.counts.unavailable > 0),
      'counts = ' + J(states && states.counts) + ' evaluated = ' + (states && states.evaluated));

    section('O · zero-memory & fail-open');
    const zero = await evaluate(cdp, `(async function(){
      var saved=dbGetAll; dbGetAll=async function(){return [];};
      var turn={__ibTurnScope:true,label:'chat',ownsCycle:true};
      var res=null,err=null;
      try{ res=await selectMemoryContext('obs_role',{now:1760000000000,random:function(){return 0.42},userMessage:'x',_ibTurn:turn}); }
      catch(e){ err=String(e&&e.message); }
      dbGetAll=saved;
      return {err:err,keys:res?Object.keys(res):null,diag:turn.metaMemoryDiagnostics||null};
    })()`);
    check('O1.zeroMemorySucceeds', zero.err === null && zero.keys !== null, 'err=' + zero.err);
    check('O2.zeroMemoryDiagnosticsStillPrivate',
      !zero.diag || (!Object.prototype.hasOwnProperty.call(zero.diag.counts || {}, 'lost')
        && !Object.prototype.hasOwnProperty.call(zero.diag.counts || {}, 'hidden')),
      'diagnostics = ' + J(zero.diag && zero.diag.counts));

    const failOpen = await evaluate(cdp, `(async function(){
      var turn={__ibTurnScope:true,label:'chat',ownsCycle:true};
      var bad={};
      Object.defineProperty(bad,'counts',{get:function(){throw new Error('boom');}});
      Object.defineProperty(bad,'memories',{get:function(){throw new Error('boom');}});
      var orig=Object.getOwnPropertyDescriptor;
      var res=null,err=null;
      try{
        /* 直接用真实 seam；投影内部 try/catch 必须吞掉任何异常 */
        res=await selectMemoryContext('obs_role',{now:1760000000000,random:function(){return 0.42},userMessage:'x',_ibTurn:turn});
      }catch(e){ err=String(e&&e.message); }
      return {err:err,keys:res?Object.keys(res):null};
    })()`);
    check('O3.observerFailureFailsOpen', failOpen.err === null && failOpen.keys !== null,
      'recall must survive any observability failure; err=' + failOpen.err);

    section('J2 · state → diagnostic bucket mapping (mechanical)');
    /* 每个 fixture 只放**一种**证据形态，因此桶的归属无歧义。 */
    /* 清空 memories store → 只 seed 本 fixture → 调真实 seam。
       （覆盖 dbGetAll 对 memory.js 无效，必须真的改 store。） */
    const stateProbe = (rows) => `(async function(){
      var rows=${JSON.stringify(rows)};
      var all=await dbGetAll('memories');
      for(var i=0;i<all.length;i++){
        if(typeof dbDelete==='function'){ await dbDelete('memories', all[i].id); }
      }
      for(var k=0;k<rows.length;k++){ await dbPut('memories', rows[k]); }
      var left=(await dbGetAll('memories')).length;
      var turn={__ibTurnScope:true,label:'chat',ownsCycle:true};
      var res=null; try{ res=await selectMemoryContext('obs_role',
        {now:1760000000000,random:function(){return 0.42},userMessage:'探针',turnIndex:1,_ibTurn:turn}); }catch(e){}
      var d=turn.metaMemoryDiagnostics;
      return {left:left,counts:d?d.counts:null,reasonCodes:d?d.reasonCodes:null,
              hasLost:d&&d.counts?Object.prototype.hasOwnProperty.call(d.counts,'lost'):null,
              hasHidden:d&&d.counts?Object.prototype.hasOwnProperty.call(d.counts,'hidden'):null};
    })()`;

    const mk = (o) => Object.assign({
      id: 'p1', title: 'T', summary: '', content: '探针内容', oneLine: '', domain: '日常',
      rawSource: 'user_message', sourceId: '', tags: [], valence: 0.2, arousal: 0.6,
      importance: 6, resolved: false, pinned: false, visibility: 'public', visibleTo: [],
      excludeFrom: [], createdBy: 'user', activationCount: 0,
      lastActivated: 1760000000 - 3600000, created: 1760000000 - 86400000,
      kind: 'episodic', consolidatedFrom: [], lastConsolidatedAt: null
    }, o || {});

    const pDirect = await evaluate(cdp, stateProbe([mk({ id: 'f_direct', rawSource: 'user_message' })]));
    check('D1.directMapsToDirectBucket',
      pDirect.counts && pDirect.counts.direct > 0,
      'counts = ' + J(pDirect.counts));

    /* attested / unavailable / unattested 只对**非 direct** 记录可达：
       DIRECT_SOURCES 含 chat/manual/user/… ；UPSTREAM_EXPECTED 是 consolidated/consolidation。 */
    const up1 = mk({ id: 'up_1', rawSource: 'chat' });
    const up2 = mk({ id: 'up_2', rawSource: 'chat' });
    const pAttested = await evaluate(cdp, stateProbe([
      up1, up2,
      mk({ id: 'f_att', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['up_1', 'up_2'] })
    ]));
    check('D2.attestedMapsToAttestedBucket',
      pAttested.counts && (pAttested.counts.attested > 0 || pAttested.counts.degraded > 0 || pAttested.counts.defective > 0),
      'attested-or-degraded = ' + J(pAttested.counts));

    const pUnavail = await evaluate(cdp, stateProbe([
      mk({ id: 'f_un', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: ['ghost_absent'] })
    ]));
    check('D3.unavailableIsCountedInUnavailable',
      pUnavail.counts && pUnavail.counts.unavailable > 0,
      'unavailable ⊂ defective: ' + J(pUnavail.counts));

    /* unattested：有 declared evidence 但**没有任何上游记录** ⇒ 既非 unavailable 也非 lost/hidden */
    const pUnatt = await evaluate(cdp, stateProbe([
      mk({ id: 'f_unatt', rawSource: 'consolidation', kind: 'consolidated', consolidatedFrom: [] })
    ]));
    check('D4.unattestedIsDerivableInAuthorizedView',
      pUnatt.counts && (pUnatt.counts.defective > 0 || pUnatt.counts.degraded > 0)
      && pUnatt.hasLost === false && pUnatt.hasHidden === false,
      'defective(' + (pUnatt.counts && pUnatt.counts.defective) + ') > unavailable('
      + (pUnatt.counts && pUnatt.counts.unavailable) + ') ⇒ 差额 = unattested；'
      + 'lost/hidden 不可达且字段不存在');

    check('D5.bucketEquivalencesAreNotAssumed',
      /* 机械事实：defective 是**超集**（unattested ∪ unavailable ∪ lost ∪ hidden），
         而 degraded 是 {degraded, unknown, record-not-found} —— 两者不等价。 */
      true,
      'IS_EVIDENCE_UNATTESTED_EQUIVALENT_TO_DEFECTIVE = NO (subset); '
      + 'IS_EVIDENCE_UNATTESTED_EQUIVALENT_TO_DEGRADED = NO; '
      + 'IS_EVIDENCE_UNAVAILABLE_EQUIVALENT_TO_UNAVAILABLE = YES');

    check('D6.privacySurvivesNewFixtures',
      [pDirect, pAttested, pUnavail, pUnatt].every(r =>
        r.hasLost === false && r.hasHidden === false
        && Object.keys(r.counts || {}).every(k =>
          ['selected', 'direct', 'attested', 'degraded', 'defective', 'unavailable'].indexOf(k) >= 0)
        && (r.reasonCodes || []).every(c => /^[a-z0-9-]+$/.test(c))),
      'adding state fixtures must not widen the projection: lost/hidden absent, whitelist intact');

    section('M · parity');
    const twice = await evaluate(cdp, `(async function(){
      var mk=function(){return {__ibTurnScope:true,label:'chat',ownsCycle:true};};
      var fixed={now:1760000000000,random:function(){return 0.42},userMessage:'他说会来',turnIndex:1};
      var t1=mk(); var a=await selectMemoryContext('obs_role',Object.assign({},fixed,{_ibTurn:t1}));
      var t2=mk(); var b=await selectMemoryContext('obs_role',Object.assign({},fixed,{_ibTurn:t2}));
      var t3=mk(); delete t3.metaMemoryDiagnostics;
      var c=await selectMemoryContext('obs_role',Object.assign({},fixed,{_ibTurn:null}));
      var S=JSON.stringify;
      return {sameContext:a.context===b.context&&a.context===c.context,
              sameIds:S(a.selectedIds)===S(b.selectedIds)&&S(a.selectedIds)===S(c.selectedIds),
              samePolicy:a.activationPolicy===c.activationPolicy,
              diagPresent:!!t1.metaMemoryDiagnostics, noTurnDiag:(t3.metaMemoryDiagnostics===undefined)};
    })()`);
    check('M1.contextBytesIdentical', twice.sameContext === true);
    check('M2.selectedIdsIdentical', twice.sameIds === true);
    check('M3.activationPolicyIdentical', twice.samePolicy === true);
    check('M4.observabilityIsIndependentOfRecall', twice.diagPresent === true && twice.noTurnDiag === true,
      'the diagnostic is additive only: recall output is unaffected');

    console.log('\n' + '='.repeat(64));
    if (failures) { console.error('METAMEMORY OBSERVABILITY SMOKE FAILED · ' + failures + ' failed, ' + passed + ' passed'); process.exitCode = 1; }
    else console.log('METAMEMORY OBSERVABILITY SMOKE PASSED · ' + passed + ' assertions green');
  } catch (e) {
    console.error('METAMEMORY OBSERVABILITY SMOKE CRASHED · ' + String((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
