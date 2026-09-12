/* ====================================================================
   M1-C.2n · 浏览器侧接线（CDP）· 真实 Chrome，真实 file:// 承载

   状态：**已进入 test-all 的 browser 组**（需要 --browser，因本机需 Chrome）。

   此前本文件曾是"已知缺口"：它的自建 CDP 客户端发出的**未掩码**帧被 Chrome
   静默忽略（RFC 6455 §5.3 要求客户端帧必须掩码），既不报错也不断开，于是
   症状是"静默挂死"，因此没有登记进自动套件 —— 一条从不运行的绿灯比没有更糟。
   根因已修（掩码 + 新鲜的 16 字节 Sec-WebSocket-Key），现在它真的在跑。

   它证明的是 Node 侧套件无法证明的两件事：
     · 浏览器里的可见性判定与 Node 判定**逐位一致**（同一份 UMD 核心）；
     · canonical 承载下直接 dbPut/dbDelete('moments') **必须被拒绝**，
       且被拒绝的写入不会损坏既有行（P6 的真实浏览器证据）。
   ==================================================================== */
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;
const CORE = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { failed++; failures.push(name); console.log('  ✖ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

function chromePath() {
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  return null;
}
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        /* Sec-WebSocket-Key 必须是**新鲜**的 16 字节 nonce（RFC 6455 §4.1）。
           原先写死成 Buffer.from('0123456789abcdef') 既是常量、又不足以
           表达"随机"，虽然本机 Chrome 尚未因此拒绝，但没有理由留一个错的。 */
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket) => {
      const client = { socket, buf: Buffer.alloc(0), seq: 0, pending: new Map() };
      socket.on('data', (d) => {
        client.buf = Buffer.concat([client.buf, d]);
        for (;;) {
          if (client.buf.length < 2) return;
          const b1 = client.buf[1] & 0x7f; let off = 2, len = b1;
          if (b1 === 126) { if (client.buf.length < 4) return; len = client.buf.readUInt16BE(2); off = 4; }
          else if (b1 === 127) { if (client.buf.length < 10) return; len = Number(client.buf.readBigUInt64BE(2)); off = 10; }
          /* 服务端帧按规范**不应**掩码，但既然要按掩码位解码，就把它实现正确。 */
          let maskKey = null;
          if (client.buf[1] & 0x80) {
            if (client.buf.length < off + 4) return;
            maskKey = client.buf.subarray(off, off + 4); off += 4;
          }
          if (client.buf.length < off + len) return;
          let payload = client.buf.subarray(off, off + len); client.buf = client.buf.subarray(off + len);
          if (maskKey) {
            const out = Buffer.alloc(len);
            for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
            payload = out;
          }
          let msg; try { msg = JSON.parse(payload.toString()); } catch (e) { continue; }
          if (msg.id && client.pending.has(msg.id)) {
            const p = client.pending.get(msg.id); client.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result || {});
          }
        }
      });
      socket.on('error', (e) => { for (const p of client.pending.values()) p.reject(e); client.pending.clear(); });
      /* 客户端 → 服务端的所有帧**必须**掩码（RFC 6455 §5.3）。此前这里发的
         是未掩码帧，Chrome 会直接忽略（不报错、也不关闭），于是本文件的症状
         是"静默挂死"而不是显式失败 —— 这正是它当初无法进入自动套件的原因。
         服务端 → 客户端的帧**必须不**掩码，故下面读取时按掩码位解码。 */
      client.send = (method, params) => new Promise((res2, rej2) => {
        const id = ++client.seq; client.pending.set(id, { resolve: res2, reject: rej2 });
        const body = Buffer.from(JSON.stringify({ id, method, params: params || {} }));
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(body.length);
        for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i & 3];
        let frame;
        if (body.length < 126) {
          frame = Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
        } else if (body.length < 65536) {
          const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(body.length, 2);
          frame = Buffer.concat([h, mask, masked]);
        } else {
          const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(body.length), 2);
          frame = Buffer.concat([h, mask, masked]);
        }
        socket.write(frame);
      });
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: JSON.stringify(r.exceptionDetails.exception) };
  return r.result && r.result.value;
}
async function waitFor(cdp, expression, timeout) {
  const end = Date.now() + (timeout || 20000);
  while (Date.now() < end) {
    const v = await ev(cdp, expression);
    if (v === true) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  const chrome = chromePath();
  if (!chrome) { console.log('NO CHROME — skipped'); process.exit(0); }
  const port = await freePort();
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'ibmom-br-')), 'about:blank'], { stdio: 'ignore' });
  proc.unref();
  let up = false;
  for (let i = 0; i < 150; i++) { try { await fetch('http://127.0.0.1:' + port + '/json/version'); up = true; break; } catch (e) { await new Promise(r => setTimeout(r, 150)); } }
  if (!up) { console.log('CDP NOT UP — skipped'); process.exit(0); }
  const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
  const cdp = await wsConnect(tab.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  console.log('M1-C.2n · browser-side moments authority wiring');
  const ready = await waitFor(cdp, "typeof db!=='undefined'&&typeof _momentsVisibleToRole==='function'&&!!window.IBMomentsVisibilityCore", 30000);
  check('browser.ready', ready);
  if (!ready) { proc.kill(); process.exit(1); }

  /* ① 共享核已加载，且**页面里的判定与 Node 判定逐位一致** */
  const casesJson = JSON.stringify([
    { id: 'b1', authorType: 'role', roleId: 'r-a', content: 'x', visibility: 'all', visibleRoleIds: [] },
    { id: 'b2', authorType: 'role', roleId: 'r-a', content: 'x', visibility: 'private', visibleRoleIds: [] },
    { id: 'b3', authorType: 'role', roleId: 'r-a', content: 'x', visibility: 'user', visibleRoleIds: [] },
    { id: 'b4', authorType: 'role', roleId: 'r-a', content: 'x', visibility: 'roles', visibleRoleIds: ['r-b'] },
    { id: 'b5', authorType: 'role', roleId: 'r-a', content: 'x', visibility: 'everyone', visibleRoleIds: [] },
    { id: 'b6', roleId: 'r-a', content: 'x' },
    { id: 'b7', authorType: 'user', authorId: 'u1', roleId: '', content: 'x', visibility: 'private', visibleRoleIds: [] }
  ]);
  const principalsJson = JSON.stringify([
    { kind: 'role', id: 'r-a' }, { kind: 'role', id: 'r-b' }, { kind: 'role', id: 'r-z' }, { kind: 'user', id: 'u1' }
  ]);
  const browserVerdicts = await ev(cdp, `(function(){
    var core=window.IBMomentsVisibilityCore, ms=${casesJson}, ps=${principalsJson}, out=[];
    for(var i=0;i<ms.length;i++) for(var j=0;j<ps.length;j++) out.push(core.isMomentVisibleTo(ms[i],ps[j])?1:0);
    return out;
  })()`);
  const ms = JSON.parse(casesJson), ps = JSON.parse(principalsJson);
  const nodeVerdicts = [];
  for (const m of ms) for (const p of ps) nodeVerdicts.push(CORE.isMomentVisibleTo(m, p) ? 1 : 0);
  check('parity.browserEqualsNode', JSON.stringify(browserVerdicts) === JSON.stringify(nodeVerdicts),
    { browser: browserVerdicts, node: nodeVerdicts });

  /* ② 生产函数 == 共享核（证明生产代码真的用了它，而不是各判一次） */
  const prodVsCore = await ev(cdp, `(function(){
    var core=window.IBMomentsVisibilityCore, ms=${casesJson}, out={mismatch:[]};
    function userPrincipal(){ return _momentsPrincipalUser(); }
    for(var i=0;i<ms.length;i++){
      var role=core.isMomentVisibleTo(ms[i],{kind:'role',id:'r-b'});
      var viaProd=_momentsVisibleToRole(ms[i],'r-b');
      if(role!==viaProd) out.mismatch.push({i:i,core:role,prod:viaProd});
    }
    return out;
  })()`);
  check('parity.productionUsesCore', prodVsCore && prodVsCore.mismatch && prodVsCore.mismatch.length === 0, prodVsCore);

  /* ③ getMomentsContext 走共享渲染：与 Node 用同一份状态渲染出的文本逐字相同 */
  const seeded = await ev(cdp, `(async function(){
    var base=Date.now()-60000;
    await dbPut(MOMENT_STORE,{id:'br_own',authorType:'role',authorId:'br_r',roleId:'br_r',content:'BR_OWN_PUBLIC',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date(base).toISOString()});
    await dbPut(MOMENT_STORE,{id:'br_priv',authorType:'role',authorId:'br_r',roleId:'br_r',content:'BR_OWN_PRIVATE',images:[],visibility:'private',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date(base+1000).toISOString()});
    var cfg={id:'br_r',provider:'openai',model:'BR_MODEL',endpoint:'http://127.0.0.1:9/v1',apiKey:'',nickname:'BR_NAME',systemPrompt:'x',temperature:0.7};
    await dbPut('apiConfigs',cfg); await loadApiConfigs();
    return true;
  })()`);
  check('seed.ok', seeded === true);
  const ctxText = await ev(cdp, "getMomentsContext('br_r')");
  check('ctx.publicIn', typeof ctxText === 'string' && ctxText.indexOf('BR_OWN_PUBLIC') >= 0, ctxText);
  check('ctx.privateOutOfChat', typeof ctxText === 'string' && ctxText.indexOf('BR_OWN_PRIVATE') < 0, ctxText);
  /* 同一份状态 + 同一份名字目录 → 与 Node 渲染**逐字相同**。 */
  const rowsForNode = await ev(cdp, `(async function(){
    var all=await dbGetAll(MOMENT_STORE);
    return all.filter(function(m){return m.id==='br_own'||m.id==='br_priv'});
  })()`);
  const nodeRendered = CORE.renderMomentsContext({
    moments: rowsForNode,
    principal: { kind: 'role', id: 'br_r' },
    characterId: 'br_r',
    userName: '用户',
    characterNameOf: (id) => (String(id) === 'br_r' ? 'BR_NAME' : ''),
    options: { ownLimit: 4, otherLimit: 3 }
  });
  /* 时间标签依赖"现在"，因此比较的是除了首个（时间）之外的行体 —— 这一段
     就是"证据信封"的比较粒度：内容 + 作者名 + 顺序 + 块头。 */
  const stripTime = (t) => String(t || '').split('\n').map(l => l.replace(/（[^）]*）/, '（）')).join('\n');
  check('parity.contextByteIdentical', stripTime(ctxText) === stripTime(nodeRendered),
    { browser: stripTime(ctxText), node: stripTime(nodeRendered) });

  /* ④ file:// 下权威不生效 → 本地写是回滚路径，必须仍然可用 */
  const rollback = await ev(cdp, `(function(){
    var st = (window.IB && IB.homeNode && IB.homeNode.moments && IB.homeNode.moments.status) ? IB.homeNode.moments.status() : null;
    return { status: st, effective: st ? st.authorityEffective : null, mode: st ? st.mode : null };
  })()`);
  check('rollback.authorityNotEffectiveOnFile', rollback && rollback.effective === false, rollback);

  /* ⑤ canonical 承载下**任何**直接 dbPut('moments') 必须被拒绝。
     这一条在 file:// 下无法用真实权威触发，因此用"结构性注入"验证守卫本身：
     把权威对象换成 authorityEffective()===true 的替身后再写一次。 */
  const guard = await ev(cdp, `(async function(){
    var host = window.IB && IB.homeNode;
    if(!host || !host.moments || !host.moments.instance) return { skip: 'authority-absent', note: 'file:// 下权威未装配' };
    var inst = host.moments.instance;
    var original = inst.authorityEffective;
    inst.authorityEffective = function(){ return true; };
    /* 直接 dbPut：必须被守卫拒绝。 */
    var rejected = null;
    try {
      await dbPut(MOMENT_STORE, { id:'guard_probe', roleId:'br_r', content:'GUARD', visibility:'all', images:[], visibleRoleIds:[], likes:[], comments:[], source:'manual', createdAt: new Date().toISOString() });
      rejected = false;
    } catch(e) { rejected = String(e && e.code || e && e.message || e); }
    var deleted = null;
    try {
      await dbDelete(MOMENT_STORE, 'br_own');
      deleted = false;
    } catch(e2) { deleted = String(e2 && e2.code || e2 && e2.message || e2); }
    inst.authorityEffective = original;
    return { rejected: rejected, deleted: deleted, stillThere: !!(await dbGet(MOMENT_STORE,'br_own')) };
  })()`);
  check('cutover.directPutRejected', guard && guard.rejected === 'moments-write-closed', guard);
  check('cutover.directDeleteRejected', guard && guard.deleted === 'moments-delete-closed', guard);
  check('cutover.rowSurvivesRejectedWrite', guard && guard.stillThere === true, guard);

  /* ⑥ 守卫**不**在 file:// 下生效（回滚路径必须能写） */
  const rollbackWrite = await ev(cdp, `(async function(){
    try {
      await dbPut(MOMENT_STORE, { id:'rb_probe', authorType:'role', roleId:'br_r', content:'RB', visibility:'all', visibleRoleIds:[], likes:[], comments:[], source:'manual', createdAt: new Date().toISOString() });
      var row = await dbGet(MOMENT_STORE,'rb_probe');
      return { ok: !!row };
    } catch(e) { return { ok:false, error:String(e && e.code || e && e.message) }; }
  })()`);
  check('rollback.localWriteAllowed', rollbackWrite && rollbackWrite.ok === true, rollbackWrite);

  console.log('\n' + '='.repeat(64));
  console.log('Moments browser authority: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) console.log('failed: ' + failures.join(', '));
  proc.kill();
  await new Promise(r => setTimeout(r, 300));
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error('unexpected failure:', error); process.exit(1); });
