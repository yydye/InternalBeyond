'use strict';

/* InternetBeyond · AI↔AI 连续社交链冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：发帖 / 首层 AI 评论 / 作者回评 / replyTo 正确 / 第三方加入 / 第三方 replyTo 正确 /
   最大轮数 / >12 条评论停止 / 小时上限 / 45min 冷却 / 重复事件幂等 / 刷新后不重复生成 /
   publishReply=false / 非法 replyTo 回落 / 内容重复过滤 / 低信息过滤 / aiComment 总开关 /
   Memory 与线程上下文注入。全程 mock 端点，不真实调用模型。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;

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
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0;
    this.pending = new Map(); this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => {});
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: {
        Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
      }});
      req.on('upgrade', (res, socket) => resolve(new Cdp(socket)));
      req.on('error', reject); req.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message)); const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4); const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : Buffer.alloc(4);
    if (payload.length >= 126) { header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], short = this.buffer[1] & 0x7f; let off = 2, len = short;
      if (short === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (short === 127) { if (this.buffer.length < 10) return; len = this.buffer.readUInt32BE(6); off = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0; let mask = null;
      if (masked) { if (this.buffer.length < off + 4) return; mask = this.buffer.subarray(off, off + 4); off += 4; }
      if (this.buffer.length < off + len) return;
      let payload = this.buffer.subarray(off, off + len); this.buffer = this.buffer.subarray(off + len);
      if (mask) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let msg; try { msg = JSON.parse(payload.toString()); } catch (error) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result || {});
      } else if (msg.method && this.listeners.has(msg.method)) {
        for (const listener of this.listeners.get(msg.method)) listener(msg.params || {});
      }
    }
  }
  close() { try { this.socket.destroy(); } catch (error) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}
async function waitFor(cdp, expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (error) {} await new Promise(r => setTimeout(r, 120)); }
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
}
function startMockApi() {
  /* per-model 路由（按请求体中的模型名与线程内 comment-id 数量决定回复） */
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let model = '', content = '';
        try {
          const j = JSON.parse(body || '{}');
          model = String(j.model || '');
          const msgs = Array.isArray(j.messages) ? j.messages : [];
          const userText = msgs.map(m => String(m && m.content != null ? m.content : '')).join('\n');
          const ids = [...userText.matchAll(/\[(mc_[a-z0-9_]+)\]/g)].map(x => x[1]);
          const n = ids.length;
          if (model === 'ds') {
            if (n === 0) content = JSON.stringify({ publishComment: true, comment: '这个照片拍得不错。' });
            else content = JSON.stringify({ publishReply: true, comment: '这角度确实妙，回头我也试试。', replyTo: ids[n - 1] });
          }
          else if (model === 'cha') content = JSON.stringify({ publishReply: true, comment: '你也喜欢？', replyTo: ids[0] || '' });
          else if (model === 'kim') content = JSON.stringify({ publishReply: true, comment: '我觉得光线很好。', replyTo: ids[n - 1] || '' });
          else if (model === 'decl') content = JSON.stringify({ publishReply: false });
          else if (model === 'badrep') content = JSON.stringify({ publishReply: true, comment: '非法回复对象测试。', replyTo: 'mom_not_exist_123' });
          else if (model === 'duprep') content = JSON.stringify({ publishReply: true, comment: '这个照片拍得不错。', replyTo: '' });
          else if (model === 'lowrep') content = JSON.stringify({ publishReply: true, comment: '哈哈', replyTo: '' });
          else content = JSON.stringify({});
        } catch (e) { content = JSON.stringify({}); }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
      return;
    }
    res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const mock = await startMockApi(); const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-chain-smoke-'));
  const browser = spawn(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--remote-debugging-address=127.0.0.1','--remote-debugging-port=' + port,'--user-data-dir=' + profile,'about:blank'], { stdio: 'ignore' });
  let failures = 0, cdp;
  const check = (name, ok, detail = '') => { if (ok) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (error) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready); if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    const exceptions = []; cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    await evaluate(cdp, "window.confirm=function(){return true;}");
    check('page.ready', await waitFor(cdp, "window.IB&&IB.moments&&typeof generateRoleReply==='function'&&typeof IB.moments.generateRoleReply==='function'", 20000));
    check('dual.reply', await evaluate(cdp, "typeof _momentsMaybeReplyChain==='function'&&typeof IB.moments._momentsMaybeReplyChain==='function'&&typeof IB.moments._momentsReplyChainPlan==='function'"));

    /* 统一准备：3 个主角色 + 4 个行为角色 + 短延迟 */
    await evaluate(cdp, `(async function(){
      _momentsPrefsSave({aiComment:false,aiLike:false,frequency:'low',otherRolesVisible:true});
      _momentsSetReplyDelayForTest(60,120);
      localStorage.removeItem('ib_moments_reply_chain_v1');
      localStorage.removeItem('ib_moments_comment_log_v1');
      const mk=(id,model,nick,sys)=>({id:id,provider:'openai',model:model,endpoint:'http://127.0.0.1:${mock.port}/v1',apiKey:'',nickname:nick,systemPrompt:sys,avatar:'',banner:'',bio:sys,joinedAt:1717200000000,sortOrder:0});
      const cfgs=[
        mk('ds','ds','DeepSeek','你是 DeepSeek，专业文字批评家。'),
        mk('cha','cha','ChromeAI','你是 ChromeAI，住在浏览器窗口里的角色。'),
        mk('kim','kim','Kimi','你是 Kimi。'),
        mk('decl','decl','Decline','你是 Decl。'),
        mk('badrep','badrep','BadReply','你是 BadReply。'),
        mk('duprep','duprep','DupReply','你是 DupReply。'),
        mk('lowrep','lowrep','LowReply','你是 LowReply。')
      ];
      for(const c of cfgs)await dbPut('apiConfigs',c);
      await loadApiConfigs();
      await dbPut('memories',{id:'mem_chain_1',title:'DeepSeek 的偏好',content:'DeepSeek 喜欢反光的水面与低饱和照片。',visibility:'public',importance:6});
      await dbPut('about',{id:'main',name:'Sui'});
      return true;
    })()`);
    check('env.ready', await evaluate(cdp, "apiConfigs.length>=7"));

    /* ═══ 1+2+3+4+5+6：完整五跳示例（ChromeAI 发帖 → DeepSeek 评论 → ChromeAI 回评 → Kimi 加入 → DeepSeek 回复 Kimi）═══ */
    const hops = await evaluate(cdp, `(async function(){
      _momentsPrefsSave({aiComment:true});
      const post=await createMoment({roleId:'cha',content:'今天拍了一张照片，光线很好。',source:'manual',visibility:'all'});
      const mid=post.moment.id;
      const h1=await generateRoleComment('ds',mid);                       /* 首层评论 */
      const c1=h1.comment;
      const h2=await generateRoleReply('cha',mid,{replyTo:c1.id,targetRoleId:'ds',force:true});   /* 作者回评 */
      const c2=h2.comment;
      const h3=await generateRoleReply('kim',mid,{replyTo:c2.id,targetRoleId:'cha',force:true});   /* 第三方加入 */
      const c3=h3.comment;
      const h4=await generateRoleReply('ds',mid,{replyTo:c3.id,targetRoleId:'kim',force:true});    /* DeepSeek 回复 Kimi */
      const c4=h4.comment;
      const m=await getMoment(mid);
      return JSON.stringify({
        mid:mid,
        h1:{ok:h1.ok,published:h1.published},c1:{id:c1.id,author:c1.authorId,replyTo:c1.replyTo,content:c1.content},
        h2:{ok:h2.ok,published:h2.published},c2:{id:c2.id,author:c2.authorId,replyTo:c2.replyTo,content:c2.content},
        h3:{ok:h3.ok,published:h3.published},c3:{id:c3.id,author:c3.authorId,replyTo:c3.replyTo,content:c3.content},
        h4:{ok:h4.ok,published:h4.published},c4:{id:c4.id,author:c4.authorId,replyTo:c4.replyTo,content:c4.content},
        total:m.comments.length,
        flat:m.comments.map(function(c){return c.authorId+'|'+String(c.replyTo||'')})
      });
    })()`);
    const hop = JSON.parse(hops);
    check('5hop.postCreated', !!hop.mid);
    check('5hop.firstLayer', hop.h1.ok && hop.h1.published && hop.c1.author === 'ds' && hop.c1.replyTo === '', JSON.stringify(hop.c1));
    check('5hop.authorReply', hop.h2.ok && hop.h2.published && hop.c2.author === 'cha' && hop.c2.replyTo === hop.c1.id, JSON.stringify(hop.c2));
    check('5hop.thirdJoins', hop.h3.ok && hop.h3.published && hop.c3.author === 'kim' && hop.c3.replyTo === hop.c2.id, JSON.stringify(hop.c3));
    check('5hop.dsRepiesKimi', hop.h4.ok && hop.h4.published && hop.c4.author === 'ds' && hop.c4.replyTo === hop.c3.id, JSON.stringify(hop.c4));
    check('5hop.threadShape', hop.total === 4 && hop.flat[0] === 'ds|' && hop.flat[1] === 'cha|' + hop.c1.id && hop.flat[2] === 'kim|' + hop.c2.id && hop.flat[3] === 'ds|' + hop.c3.id, hop.flat.join(';'));
    /* 线程 UI 树可渲染（回复关系正确 → 树结构正确） */
    check('5hop.round', await evaluate(cdp, "(async function(){var m=await getMoment('" + hop.mid + "');return _momentsChainRound(m)===3})()"));

    /* ═══ 7. 最大轮数限制 ═══ */
    const roundLim = await evaluate(cdp, `(async function(){
      localStorage.removeItem('ib_moments_reply_chain_v1');
      var m={id:'mom_roundlim',roleId:'cha',content:'轮数测试。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date().toISOString()};
      for(var i=1;i<=4;i++)m.comments.push({id:'rc_'+i,authorType:'role',authorId:i%2? 'ds':'cha',content:'轮数回复 '+i,replyTo:('rc_'+(i-1)),createdAt:new Date(Date.now()+i*1000).toISOString()});
      await dbPut(MOMENT_STORE,m);
      var a=await _momentsMaybeReplyChain('mom_roundlim','rc_4');
      var st=_momentsReplyChainState()['mom_roundlim'];
      return JSON.stringify({triggered:a,state:st||null,round:_momentsChainRound(m)});
    })()`);
    const rl = JSON.parse(roundLim);
    check('limit.rounds', rl.round === 4 && rl.triggered === false && !rl.state, roundLim);

    /* ═══ 8. >12 条评论停止 ═══ */
    const commentLim = await evaluate(cdp, `(async function(){
      localStorage.removeItem('ib_moments_reply_chain_v1');
      var m={id:'mom_commentlim',roleId:'cha',content:'评论数测试。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date().toISOString()};
      for(var i=1;i<=13;i++)m.comments.push({id:'cc_'+i,authorType:'role',authorId:i%2? 'ds':'kim',content:'评论 '+i,replyTo:'',createdAt:new Date(Date.now()+i*1000).toISOString()});
      await dbPut(MOMENT_STORE,m);
      var a=await _momentsMaybeReplyChain('mom_commentlim','cc_13');
      var st=_momentsReplyChainState()['mom_commentlim'];
      return JSON.stringify({triggered:a,state:st||null});
    })()`);
    const cl = JSON.parse(commentLim);
    check('limit.comments12', cl.triggered === false && !cl.state, commentLim);

    /* ═══ 9+10. 每小时上限 / 45min 冷却 ═══ */
    const rate = await evaluate(cdp, `(function(){
      localStorage.setItem('ib_moments_comment_log_v1',JSON.stringify({ds:[Date.now(),Date.now()-60000,Date.now()-120000,Date.now()-180000]}));
      var hourly=_momentsReplyRoomOk('ds',Date.now());
      localStorage.setItem('ib_moments_comment_log_v1',JSON.stringify({ds:[Date.now()]}));
      _momentsSetState('ds',{lastCommentAt:Date.now()});
      var cool=_momentsReplyRoomOk('ds',Date.now());
      _momentsSetState('ds',{lastCommentAt:0});
      localStorage.removeItem('ib_moments_comment_log_v1');
      return JSON.stringify({hourly:hourly,cool:cool});
    })()`);
    const rt = JSON.parse(rate);
    check('limit.hourly', rt.hourly === false, 'hourly should be blocked at 4/h -> ' + rate);
    check('limit.cooldown45', rt.cool === false, rate);

    /* ═══ 11+12. 幂等：重复事件 / 刷新后不重复生成 ═══ */
    const idem = await evaluate(cdp, `(async function(){
      localStorage.removeItem('ib_moments_reply_chain_v1');
      localStorage.removeItem('ib_moments_comment_log_v1');
      localStorage.removeItem('ib_moments_state_v1');
      _momentsPrefsSave({aiComment:true});
      /* 帖主=decl（模型选择不参与）→ 第一步确定性落空，链条不自我延续，便于验证幂等；
         临时只留 decl+ds 两个角色，避免第三方被确定性哈希选中 */
      var saved=apiConfigs.slice();
      var dscfg=apiConfigs.find(function(c){return c.id==='ds'});
      var declcfg=apiConfigs.find(function(c){return c.id==='decl'});
      apiConfigs.length=0; apiConfigs.push(declcfg,dscfg);
      var m={id:'mom_idem',roleId:'decl',content:'幂等测试。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date().toISOString()};
      m.comments.push({id:'idem_1',authorType:'role',authorId:'ds',content:'首层评论。',replyTo:'',createdAt:new Date().toISOString()});
      await dbPut(MOMENT_STORE,m);
      var before=(await getMoment('mom_idem')).comments.length;
      var t1=await _momentsMaybeReplyChain('mom_idem','idem_1');   /* 正常触发（排队） */
      var t2=await _momentsMaybeReplyChain('mom_idem','idem_1');   /* 相同 comment 再次触发 → 必须拒绝 */
      var t3=await _momentsMaybeReplyChain('mom_idem','old_id');    /* 旧 comment（非最新）→ 拒绝 */
      await new Promise(function(r){setTimeout(r,600)});            /* 等待计划执行（60-120ms） */
      var fresh=await getMoment('mom_idem');
      var added=fresh.comments.length-before;
      /* 模拟"刷新后再来一次"：状态在 localStorage，重读后再次触发同一最新评论 */
      var latest=fresh.comments[fresh.comments.length-1];
      var t4=await _momentsMaybeReplyChain('mom_idem',latest.id);   /* 已消费过的最新评论 → 必须拒绝 */
      await new Promise(function(r){setTimeout(r,500)});
      var after=await getMoment('mom_idem');
      var st=_momentsReplyChainState()['mom_idem']||{};
      apiConfigs.length=0; saved.forEach(function(c){apiConfigs.push(c)});
      return JSON.stringify({t1:t1,t2:t2,t3:t3,t4:t4,added:added,before:before,after:after.comments.length,consumed:st.lastConsumedCommentId||''});
    })()`);
    const idm = JSON.parse(idem);
    check('idem.duplicateEvent', idm.t1 === true && idm.t2 === false && idm.t3 === false, JSON.stringify(idm));
    check('idem.replayLatest', idm.t4 === false, JSON.stringify(idm));
    check('idem.noDoubleGenerate', idm.added === 0 && idm.after === idm.before && idm.consumed === 'idem_1', JSON.stringify(idm));

    /* ═══ 13. publishReply=false ═══ */
    const decl = await evaluate(cdp, `(async function(){
      var m={id:'mom_decl',roleId:'cha',content:'声明测试。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date().toISOString()};
      m.comments.push({id:'decl_1',authorType:'role',authorId:'ds',content:'第一条。',replyTo:'',createdAt:new Date().toISOString()});
      await dbPut(MOMENT_STORE,m);
      var r=await generateRoleReply('decl','mom_decl',{replyTo:'decl_1',targetRoleId:'ds',force:true});
      var fresh=await getMoment('mom_decl');
      return JSON.stringify({ok:r.ok,published:r.published,count:fresh.comments.length});
    })()`);
    const dc = JSON.parse(decl);
    check('decl.publishFalse', dc.ok === true && dc.published === false && dc.count === 1, decl);

    /* ═══ 14. 非法 replyTo → 回落到建议目标 ═══ */
    const bad = await evaluate(cdp, `(async function(){
      _momentsPrefsSave({aiComment:true});
      var m={id:'mom_badrep',roleId:'cha',content:'非法回复测试。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date().toISOString()};
      m.comments.push({id:'bad_1',authorType:'role',authorId:'ds',content:'第一条。',replyTo:'',createdAt:new Date().toISOString()});
      await dbPut(MOMENT_STORE,m);
      var r=await generateRoleReply('badrep','mom_badrep',{replyTo:'bad_1',targetRoleId:'ds',force:true});
      var fresh=await getMoment('mom_badrep');
      return JSON.stringify({ok:r.ok,published:r.published,replyTo:r.replyTo||'',saved:fresh.comments[1]?fresh.comments[1].replyTo:'',count:fresh.comments.length});
    })()`);
    const bd = JSON.parse(bad);
    check('badrep.fallback', bd.ok === true && bd.published === true && bd.saved === 'bad_1', bad);

    /* ═══ 15. 内容重复过滤 ═══ */
    const dup = await evaluate(cdp, `(async function(){
      var m={id:'mom_duprep',roleId:'cha',content:'重复测试。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date().toISOString()};
      m.comments.push({id:'dup_1',authorType:'role',authorId:'ds',content:'这个照片拍得不错。',replyTo:'',createdAt:new Date().toISOString()});
      await dbPut(MOMENT_STORE,m);
      var r=await generateRoleReply('duprep','mom_duprep',{replyTo:'dup_1',targetRoleId:'ds',force:true});
      var fresh=await getMoment('mom_duprep');
      return JSON.stringify({ok:r.ok,published:!!r.published,error:r.error||'',count:fresh.comments.length});
    })()`);
    const dp = JSON.parse(dup);
    check('dup.filtered', dp.count === 1 && (dp.error.indexOf('相似') >= 0 || dp.published === false), dup);

    /* ═══ 16. 低信息过滤（哈哈） ═══ */
    const low = await evaluate(cdp, `(async function(){
      var m={id:'mom_lowrep',roleId:'cha',content:'低信息测试。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'manual',createdAt:new Date().toISOString()};
      m.comments.push({id:'low_1',authorType:'role',authorId:'ds',content:'第一条。',replyTo:'',createdAt:new Date().toISOString()});
      await dbPut(MOMENT_STORE,m);
      var r=await generateRoleReply('lowrep','mom_lowrep',{replyTo:'low_1',targetRoleId:'ds',force:true});
      var fresh=await getMoment('mom_lowrep');
      return JSON.stringify({ok:r.ok,published:r.published,count:fresh.comments.length,lowInfo:_momentsReplyLowInfo('哈哈')&&_momentsReplyLowInfo('不错啊')==false});
    })()`);
    const lw = JSON.parse(low);
    check('lowInfo.filtered', lw.ok === true && lw.published === false && lw.count === 1 && lw.lowInfo === true, low);

    /* ═══ 17. aiComment 总开关 ═══ */
    const off = await evaluate(cdp, `(async function(){
      _momentsPrefsSave({aiComment:false});
      var r=await generateRoleReply('ds','mom_decl',{force:true});
      var t=await _momentsMaybeReplyChain('mom_decl','decl_1');
      _momentsPrefsSave({aiComment:true});
      return JSON.stringify({reply:r,trigger:t});
    })()`);
    const of = JSON.parse(off);
    check('toggle.aiCommentOff', of.reply.ok === false && String(of.reply.error||'').indexOf('关闭') >= 0 && of.trigger === false, off);

    /* ═══ 18+19. Memory 与线程上下文注入（纯 prompt 断言，不调模型） ═══ */
    const prompt = await evaluate(cdp, `(function(){
      var ctx={user:{name:'Sui',id:'u'},memories:[{title:'DeepSeek 的偏好',content:'DeepSeek 喜欢反光的水面与低饱和照片。'}],recentMoments:[{content:'昨天我拍了一张雾中的河。'}]};
      var m={id:'mom_prompt',roleId:'cha',content:'今天拍了一张照片，光线很好。',images:[{dataUrl:'x',mime:'image/jpeg'}],visibility:'all',visibleRoleIds:[],likes:[],comments:[
        {id:'p_1',authorType:'role',authorId:'ds',content:'这个照片拍得不错。',replyTo:'',createdAt:'2026-01-01T00:00:00Z'},
        {id:'p_2',authorType:'role',authorId:'cha',content:'你也喜欢？',replyTo:'p_1',createdAt:'2026-01-01T00:00:01Z'},
        {id:'p_3',authorType:'role',authorId:'kim',content:'我觉得光线很好。',replyTo:'p_2',createdAt:'2026-01-01T00:00:02Z'}
      ],source:'manual',createdAt:'2026-01-01T00:00:00Z'};
      var b=buildMomentReplyPrompt({character:{id:'ds',nickname:'DeepSeek',systemPrompt:'你是 DeepSeek。',relationship:'朋友'},context:ctx,moment:m,targetRoleId:'kim',replyTo:'p_3'});
      var t=b.messages[1].content;
      return JSON.stringify({
        post:t.indexOf('今天拍了一张照片')>=0,
        thread:t.indexOf('ChromeAI → DeepSeek')>=0&&t.indexOf('Kimi → ChromeAI')>=0,
        ids:t.indexOf('[p_1]')>=0&&t.indexOf('[p_3]')>=0,
        rel:t.indexOf('→')>=0,
        memory:t.indexOf('反光的水面')>=0,
        recent:t.indexOf('雾中的河')>=0,
        target:t.indexOf('Kimi')>=0,
        img:t.indexOf('1 张图片')>=0,
        current:t.indexOf('DeepSeek')>=0
      });
    })()`);
    const pr = JSON.parse(prompt);
    check('prompt.threadContext', pr.post && pr.thread && pr.ids && pr.rel && pr.current, prompt);
    check('prompt.memoryBounded', pr.memory && pr.recent, prompt);
    check('prompt.imageInfo', pr.img === true, prompt);

    check('runtime.noJsErrors', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
  } catch (e) {
    check('harness.error', false, String(e && e.message || e).slice(0, 300));
  } finally {
    try { cdp && cdp.close(); } catch (e) {}
    browser.kill('SIGKILL');
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(failures ? '\nSocialNet chain smoke failed: ' + failures : '\nSocialNet chain smoke test passed ✔');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
