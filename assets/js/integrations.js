/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.ext 注册）。 */
(function(NS){
/* ============================================================
 * InternalBeyond 扩展模块包 v1
 * 包含: IB_MD(markdown雅化) / IBMCP(MCP客户端) / IBFC(原生函数调用)
 *       IBWS(联网搜索) / IBSandbox(沙箱扩展) / IBDIY(自装载设置卡)
 * 设计原则: 全部自包含; 与宿主的接线点通过 hook 注入; 任何一处失败
 *           都 fail-open 回落到宿主原有行为, 不影响现有功能。
 * ============================================================ */

/* 兼容清理: 「语义记忆」功能已移除, 启动时清掉其遗留配置键(仅本地设置; 已写入记忆库的条目不受影响) */
try{['ib_semOn','ib_semApi','ib_semAuto','ib_semScope','ib_semSeen'].forEach(function(k){localStorage.removeItem(k)})}catch(e){}

/* ---------- 0. Markdown 雅化(仅两处转换, 其余沿用原净化) ---------- */
const IB_MD = {
  // 在 _mdSoften 的"消除规则"之前调用: 先转换, 转不动的再被原规则兜底消除
  soften(s){
    if(!s) return s;
    // 标题 → 【标题】  (# 后必须有空白, 与原行为的匹配范围一致; 吃掉尾部 ##)
    s = s.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '【$1】');
    // 加粗 → 「加粗」  (**x** 与 __x__; 内部不含 * / _ 与换行, 嵌套的交给原兜底规则)
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '「$1」');
    s = s.replace(/(^|[^_])__([^_\n]+)__(?!_)/g, '$1「$2」');
    return s;
  }
};

/* ---------- 1. IBMCP: 浏览器端 MCP 客户端 (Streamable HTTP / JSON-RPC 2.0) ---------- */
const IBMCP = {
  KEY: 'ib_mcp_cfg',
  _rpcId: 0,
  _sessions: {},            // alias -> { sid, serverInfo }
  PROTO: '2025-03-26',

  cfg(){
    let c = {};
    try{ c = JSON.parse(localStorage.getItem(this.KEY) || '{}'); }catch(e){}
    if(typeof c.enabled === 'undefined') c.enabled = true;
    if(typeof c.confirm === 'undefined') c.confirm = true;   // 调用前需确认, 默认开
    if(!Array.isArray(c.servers)) c.servers = [];
    return c;
  },
  save(c){ try{ localStorage.setItem(this.KEY, JSON.stringify(c)); }catch(e){} },

  /* ---- 底层 RPC: 兼容 直接JSON / SSE 包裹 两种返回; 自动管理会话头 ---- */
  async _rpc(server, method, params, _retried){
    const isNotif = method.indexOf('notifications/') === 0;
    const body = { jsonrpc: '2.0', method };
    if(params !== undefined) body.params = params;
    if(!isNotif) body.id = ++this._rpcId;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    };
    const sess = this._sessions[server.alias];
    if(sess && sess.sid) headers['Mcp-Session-Id'] = sess.sid;

    let resp;
    try{
      resp = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) });
    }catch(e){
      throw new Error('网络请求失败(可能是 CORS 未开放或地址不可达): ' + (e && e.message || e));
    }

    const sid = resp.headers && resp.headers.get && resp.headers.get('mcp-session-id');
    if(sid){
      this._sessions[server.alias] = this._sessions[server.alias] || {};
      this._sessions[server.alias].sid = sid;
    }

    // 会话失效 → 清会话重连重试一次
    if((resp.status === 404 || resp.status === 400) && sess && sess.sid && !_retried && !isNotif && method !== 'initialize'){
      delete this._sessions[server.alias];
      await this.connect(server.alias);
      return this._rpc(server, method, params, true);
    }

    if(isNotif){
      if(!resp.ok && resp.status !== 202) throw new Error('HTTP ' + resp.status);
      return null;
    }
    if(!resp.ok){
      let t = ''; try{ t = await resp.text(); }catch(e){}
      throw new Error('HTTP ' + resp.status + (t ? ' ' + t.slice(0, 200) : ''));
    }

    const ctype = ((resp.headers && resp.headers.get && resp.headers.get('content-type')) || '').toLowerCase();
    let msg = null;
    if(ctype.indexOf('text/event-stream') >= 0){
      const raw = await resp.text();
      msg = this._pickFromSSE(raw, body.id);
      if(!msg) throw new Error('SSE 流中未找到对应响应(id=' + body.id + ')');
    }else{
      let j;
      try{ j = await resp.json(); }catch(e){ throw new Error('响应不是合法 JSON'); }
      if(Array.isArray(j)) msg = j.find(m => m && m.id === body.id) || j[0];
      else msg = j;
    }
    if(msg && msg.error){
      throw new Error('MCP 错误 ' + (msg.error.code != null ? msg.error.code : '') + ': ' + (msg.error.message || ''));
    }
    return msg ? msg.result : null;
  },

  _pickFromSSE(raw, wantId){
    const events = String(raw).split(/\r?\n\r?\n/);
    let fallback = null;
    for(let i = 0; i < events.length; i++){
      const dataLines = events[i].split(/\r?\n/)
        .filter(l => l.slice(0, 5) === 'data:')
        .map(l => l.slice(5).replace(/^ /, ''));
      if(!dataLines.length) continue;
      let j = null;
      try{ j = JSON.parse(dataLines.join('\n')); }catch(e){ continue; }
      if(j && (('result' in j) || ('error' in j))){
        if(j.id === wantId) return j;
        if(!fallback) fallback = j;
      }
    }
    return fallback;
  },

  /* ---- 连接: initialize → notifications/initialized → tools/list(分页) ---- */
  async connect(alias){
    const c = this.cfg();
    const s = c.servers.find(x => x.alias === alias);
    if(!s) throw new Error('未找到服务器: ' + alias);
    delete this._sessions[alias];

    const init = await this._rpc(s, 'initialize', {
      protocolVersion: this.PROTO,
      capabilities: {},
      clientInfo: { name: 'InternalBeyond', version: '1.0' }
    });
    this._sessions[alias] = this._sessions[alias] || {};
    this._sessions[alias].serverInfo = init && init.serverInfo || null;
    try{ await this._rpc(s, 'notifications/initialized', {}); }catch(e){ /* 有些实现不需要 */ }

    let tools = [], cursor, guard = 0;
    do{
      const r = await this._rpc(s, 'tools/list', cursor ? { cursor } : {});
      (r && r.tools || []).forEach(t => tools.push(t));
      cursor = r && r.nextCursor;
      guard++;
    }while(cursor && guard < 20 && tools.length < 200);

    const oldOn = {};
    (s.tools || []).forEach(t => { oldOn[t.name] = t.enabled !== false; });
    s.tools = tools.map(t => ({
      name: t.name,
      description: String(t.description || '').slice(0, 600),
      inputSchema: t.inputSchema || { type: 'object' },
      enabled: Object.prototype.hasOwnProperty.call(oldOn, t.name) ? oldOn[t.name] : true
    }));
    s.status = 'ok';
    s.lastError = '';
    s.lastSync = Date.now();
    s.serverInfo = init && init.serverInfo || null;
    this.save(c);
    return s.tools.length;
  },

  enabledTools(){
    const c = this.cfg();
    if(c.enabled === false) return [];
    const out = [];
    c.servers.forEach(s => {
      if(s.enabled === false) return;
      (s.tools || []).forEach(t => {
        if(t.enabled !== false) out.push({ alias: s.alias, tool: t });
      });
    });
    return out;
  },

  /* ---- 注入到系统提示【外部工具】块的文本(token 精简版) ---- */
  promptBlock(){
    const list = this.enabledTools();
    if(!list.length) return '';
    const lines = list.map(it => {
      const t = it.tool;
      let hint = '';
      const sch = t.inputSchema || {};
      const props = sch.properties || {};
      const req = sch.required || [];
      const keys = Object.keys(props);
      hint = keys.length
        ? '（参数：' + keys.slice(0, 8).map(k => k + (req.indexOf(k) >= 0 ? '*' : '')).join('，') + '）'
        : '（无参数）';
      const desc = String(t.description || '').replace(/\s+/g, ' ').slice(0, 120);
      return '- mcp.' + it.alias + '.' + t.name + (desc ? '：' + desc : '') + hint;
    });
    return lines.join('\n');
  },

  /* ---- 名称解析 + 调用(带会话失效重试) ---- */
  resolve(fullName){
    let n = String(fullName || '').replace(/^mcp\./, '');
    const c = this.cfg();
    for(const s of c.servers){
      if(n.indexOf(s.alias + '.') === 0) return { server: s, toolName: n.slice(s.alias.length + 1) };
    }
    for(const s of c.servers){
      if((s.tools || []).some(t => t.name === n)) return { server: s, toolName: n };
    }
    return null;
  },

  async call(fullName, args){
    const c = this.cfg();
    if(c.enabled === false) throw new Error('MCP 已在设置中关闭');
    const r = this.resolve(fullName);
    if(!r) throw new Error('未找到 MCP 工具: ' + fullName);
    if(!this._sessions[r.server.alias]) await this.connect(r.server.alias);
    let res;
    try{
      res = await this._rpc(r.server, 'tools/call', { name: r.toolName, arguments: args || {} });
    }catch(e){
      // 会话可能过期: 重连再试一次
      delete this._sessions[r.server.alias];
      await this.connect(r.server.alias);
      res = await this._rpc(r.server, 'tools/call', { name: r.toolName, arguments: args || {} });
    }
    return this._extract(res);
  },

  _extract(res){
    const out = { ok: true, text: '', images: [] };
    if(res && res.isError) out.ok = false;
    const content = (res && res.content) || [];
    const parts = [];
    content.forEach(c => {
      if(!c) return;
      if(c.type === 'text') parts.push(c.text || '');
      else if(c.type === 'image' && c.data) out.images.push('data:' + (c.mimeType || 'image/png') + ';base64,' + c.data);
      else if(c.type === 'resource' && c.resource && c.resource.text) parts.push(c.resource.text);
      else if(c.type === 'audio') parts.push('[音频内容,暂不支持播放]');
    });
    if(!parts.length && res && res.structuredContent){
      try{ parts.push(JSON.stringify(res.structuredContent)); }catch(e){}
    }
    out.text = parts.join('\n').slice(0, 12000);
    return out;
  },

  /* ---- 供 _execWsOps 工具分支调用: 返回与 webhook 工具一致的结果形状 ---- */
  async execOp(name, args){
    try{
      const r = await this.call(name, args);
      return { ok: r.ok, reason: r.ok ? '' : 'MCP 返回 isError', response: r.text, images: r.images };
    }catch(e){
      return { ok: false, reason: String(e && e.message || e), response: '', images: [] };
    }
  }
};

/* ---------- 2. IBFC: 原生函数调用双轨 (Anthropic / OpenAI 原生, 其余回落 XML) ---------- */
const IBFC = {
  on(){ try{ return localStorage.getItem('ib_fcMode') !== 'off'; }catch(e){ return true; } },
  setOn(v){ try{ localStorage.setItem('ib_fcMode', v ? 'auto' : 'off'); }catch(e){} },
  maxRounds(){ const n = parseInt((typeof localStorage !== 'undefined' && localStorage.getItem('ib_fcRounds')) || '4', 10); return (n >= 1 && n <= 99) ? n : 4; },
  /* 逐服务器轮上限(存于 ib_mcp_cfg 内 servers[].maxRounds): 该服务器未设置时为默认值 5, 与外部工具轮上限无关 */
  mcpServerMaxRounds(alias){
    try{
      const s = IBMCP.cfg().servers.find(x => x.alias === alias);
      const n = s ? parseInt(s.maxRounds, 10) : NaN;
      if(n >= 1 && n <= 99) return n;
    }catch(e){}
    return 5;
  },

  // 接线时由宿主注入:
  execLocalTool: null,      // async (name, args) => {ok, reason, response, ...}  宿主 webhook 执行器
  confirmLookup: null,      // (name) => bool  该本地工具是否需确认
  getLocalTools: null,      // () => [{name, description?, confirm?}]  宿主已配置的 webhook 工具列表
  BLOCK_RE: /【外部工具】[\s\S]*?(?=\n【|$)/,   // 系统提示中工具块的定位(接线时按实际文本校准)
  tagOpen(name, fc){ return '<ws_tool name="' + name + '"' + (fc ? ' fc="1"' : '') + '>'; },
  tagClose: '</ws_tool>',

  sanitizeName(name, used){
    let n = String(name || '').replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '');
    if(!n) n = 'tool';
    n = n.slice(0, 60);
    let base = n, i = 2;
    while(used[n]){ n = base + '_' + (i++); }
    used[n] = true;
    return n;
  },

  stableStr(o){
    if(o === null || typeof o !== 'object') return JSON.stringify(o);
    if(Array.isArray(o)) return '[' + o.map(x => this.stableStr(x)).join(',') + ']';
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + this.stableStr(o[k])).join(',') + '}';
  },
  ledgerKey(name, args){ return name + '\u0001' + this.stableStr(args || {}); },

  /* ---- 每次发送前调用: 探测系统提示中的工具块, 构建 tools, 换掉块文本 ----
   * messages: 即将发送的消息数组(会被浅拷贝, 不动宿主原数组)
   * flavor  : 'anthropic' | 'openai' | 其他(不激活)
   * 返回 ctx; ctx.active=false 时一切照旧 */
  prepare(messages, flavor, options){
    const ctx = { active: false, flavor, messages, round: 0, ledger: {}, nameMap: {}, calls: [], tools: null, _acc: null, vision: !!(options && options.vision) };
    try{
      if(!this.on()) return ctx;
      if(flavor !== 'anthropic' && flavor !== 'openai') return ctx;
      let sysIdx = -1;
      for(let i = 0; i < messages.length; i++){
        const m = messages[i];
        const c = typeof m.content === 'string' ? m.content : '';
        if(m.role === 'system' && c.indexOf('【外部工具】') >= 0){ sysIdx = i; break; }
      }
      if(sysIdx < 0) return ctx;  // 本次请求没有工具块(摘要/信件等) → 不激活

      const tools = this._buildTools();
      if(!tools.list.length) return ctx;

      const msgs = messages.slice();
      const sys = Object.assign({}, msgs[sysIdx]);
      sys.content = String(sys.content).replace(this.BLOCK_RE,
        '【外部工具】工具已通过原生接口提供, 需要时直接调用, 结果会自动返回给你。');
      msgs[sysIdx] = sys;

      ctx.active = true;
      ctx.messages = msgs;
      ctx.tools = tools;
      ctx.nameMap = tools.nameMap;
      this._last = ctx;   /* 供 _execWsOps 的 fc="1" 分支按台账回查(单流串行, 覆盖即可) */
      return ctx;
    }catch(e){
      ctx.active = false;
      return ctx;
    }
  },

  _buildTools(){
    const used = {}, nameMap = {}, anthropic = [], openai = [], list = [];
    const locals = (typeof this.getLocalTools === 'function' ? (this.getLocalTools() || []) : []);
    locals.forEach(t => {
      const sName = this.sanitizeName(t.name, used);
      nameMap[sName] = t.name;
      const desc = ((sName !== t.name ? '[' + t.name + '] ' : '') + (t.description || '外部工具')).slice(0, 500);
      const schema = t.inputSchema || { type: 'object', properties: {}, additionalProperties: true,
                       description: '参数为键值对象, 键名按工具说明自定' };
      anthropic.push({ name: sName, description: desc, input_schema: schema });
      openai.push({ type: 'function', function: { name: sName, description: desc, parameters: schema } });
      list.push({ kind: 'local', name: t.name, sName });
    });
    (typeof IBMCP !== 'undefined' ? IBMCP.enabledTools() : []).forEach(it => {
      const full = 'mcp.' + it.alias + '.' + it.tool.name;
      const sName = this.sanitizeName(full, used);
      nameMap[sName] = full;
      const desc = ((sName !== full ? '[' + full + '] ' : '') + (it.tool.description || 'MCP 工具')).slice(0, 500);
      const schema = it.tool.inputSchema || { type: 'object' };
      anthropic.push({ name: sName, description: desc, input_schema: schema });
      openai.push({ type: 'function', function: { name: sName, description: desc, parameters: schema } });
      list.push({ kind: 'mcp', name: full, sName });
    });
    return { anthropic, openai, nameMap, list };
  },

  /* ---- SSE 累加器: 在 Once 的流解析回调里逐事件喂入 ---- */
  newAcc(ctx){
    const acc = { flavor: ctx.flavor, blocks: {}, order: [], done: [] };
    ctx._acc = acc;
    return acc;
  },
  feedAnthropic(acc, evt){
    try{
      if(!evt || !acc) return;
      if(evt.type === 'content_block_start' && evt.content_block && evt.content_block.type === 'tool_use'){
        acc.blocks[evt.index] = { id: evt.content_block.id, name: evt.content_block.name, json: '' };
        acc.order.push(evt.index);
      }else if(evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'input_json_delta'){
        const b = acc.blocks[evt.index];
        if(b) b.json += (evt.delta.partial_json || '');
      }else if(evt.type === 'content_block_stop'){
        const b = acc.blocks[evt.index];
        if(b && acc.done.indexOf(evt.index) < 0) acc.done.push(evt.index);
      }
    }catch(e){}
  },
  feedOpenAI(acc, delta){
    try{
      if(!acc || !delta || !delta.tool_calls) return;
      delta.tool_calls.forEach(tc => {
        const idx = tc.index != null ? tc.index : 0;
        if(!acc.blocks[idx]){ acc.blocks[idx] = { id: '', name: '', json: '' }; acc.order.push(idx); }
        const b = acc.blocks[idx];
        if(tc.id) b.id = tc.id;
        if(tc.function){
          if(tc.function.name) b.name += tc.function.name;
          if(tc.function.arguments) b.json += tc.function.arguments;
        }
      });
    }catch(e){}
  },
  // 非流式: 直接从响应体提取
  extractFromResponse(ctx, data){
    const calls = [];
    try{
      if(ctx.flavor === 'anthropic'){
        ((data && data.content) || []).forEach(c => {
          if(c && c.type === 'tool_use') calls.push({ id: c.id, sName: c.name, args: c.input || {} });
        });
      }else{
        const m = data && data.choices && data.choices[0] && data.choices[0].message;
        ((m && m.tool_calls) || []).forEach(tc => {
          let a = {}; try{ a = JSON.parse(tc.function.arguments || '{}'); }catch(e){}
          calls.push({ id: tc.id, sName: tc.function.name, args: a });
        });
      }
    }catch(e){}
    return this._finishCalls(ctx, calls);
  },
  takeCalls(ctx){
    const acc = ctx._acc;
    if(!acc || !acc.order.length) return [];
    const calls = acc.order.map(i => {
      const b = acc.blocks[i];
      let a = {};
      try{ a = b.json ? JSON.parse(b.json) : {}; }catch(e){ a = { _raw: String(b.json).slice(0, 2000) }; }
      return { id: b.id || ('fc_' + Math.random().toString(36).slice(2, 10)), sName: b.name, args: a };
    }).filter(c => c.sName);
    ctx._acc = null;
    return this._finishCalls(ctx, calls);
  },
  _finishCalls(ctx, calls){
    return calls.map(c => ({
      id: c.id || ('fc_' + Math.random().toString(36).slice(2, 10)),
      sName: c.sName,
      name: ctx.nameMap[c.sName] || c.sName,
      args: c.args || {}
    }));
  },

  needsConfirm(call){
    try{
      if(call.name.indexOf('mcp.') === 0) return IBMCP.cfg().confirm !== false;
      if(typeof this.confirmLookup === 'function') return !!this.confirmLookup(call.name);
    }catch(e){}
    return true; // 未知 → 保守要求确认
  },

  serialize(call, fc){
    let body = '';
    try{ body = JSON.stringify(call.args || {}); }catch(e){ body = '{}'; }
    return this.tagOpen(call.name, fc) + body + this.tagClose;
  },

  /* ---- 每轮 Once 结束后调用(接线处 ~8 行胶水):
   *   const r = await IBFC.runRound(ctx, pieceText, emit);
   *   if(!r.done){ continue; }  // 继续下一轮 API 调用, ctx.messages 已更新
   * emit(txt): 把序列化标签追加进输出流(走原 chunk 通道, 卡片系统自然接管) */
  async runRound(ctx, pieceText, emit, calls){
    if(!ctx || !ctx.active) return { done: true };
    calls = calls || this.takeCalls(ctx);
    if(!calls.length) return { done: true };

    // 任一调用需确认 → 序列化为普通标签(无 fc), 交给原有 pendingConfirm 流程, 本轮结束
    if(calls.some(c => this.needsConfirm(c))){
      calls.forEach(c => emit('\n' + this.serialize(c, false)));
      return { done: true, pendingConfirm: true };
    }

    // 全部立即执行
    const results = [];
    for(const c of calls){
      let r;
      try{
        if(c.name.indexOf('mcp.') === 0) r = await IBMCP.execOp(c.name, c.args);
        else if(typeof this.execLocalTool === 'function') r = await this.execLocalTool(c.name, c.args);
        else r = { ok: false, reason: '本地工具执行器未接线', response: '' };
      }catch(e){
        r = { ok: false, reason: String(e && e.message || e), response: '' };
      }
      r = r || { ok: false, reason: '空结果', response: '' };
      ctx.ledger[this.ledgerKey(c.name, c.args)] = r;
      results.push(r);
      emit('\n' + this.serialize(c, true));   // fc="1": finalize 只渲染卡片, 不再执行/不再排队注入
    }

    // 把 assistant(tool_use) + 结果 接回对话, 供下一轮
    ctx.messages = ctx.messages.concat(this.buildTurns(ctx, pieceText, calls, results));
    ctx.round++;
    /* 轮数分账: 外部工具(webhook)与 MCP 各自独立计数; MCP 再按服务器别名细分, 支持逐服务器轮上限 */
    const isMcp = c => String(c.name || '').indexOf('mcp.') === 0;
    if(calls.some(c => !isMcp(c))){
      ctx.roundLocal = (ctx.roundLocal || 0) + 1;
      if(ctx.roundLocal >= this.maxRounds()){
        emit('\n[已达外部工具调用轮数上限 ' + this.maxRounds() + ', 如需继续请回复"继续"]');
        return { done: true, hitCap: true };
      }
    }
    const mcpAliases = {};
    calls.filter(isMcp).forEach(c => {
      let a = '';
      try{ const r = IBMCP.resolve(c.name); a = (r && r.server && r.server.alias) || ''; }catch(e){}
      if(!a) a = String(c.name || '').split('.')[1] || '?';   // 解析失败(服务器已删等)兜底, 仅用于计数与提示
      mcpAliases[a] = true;
    });
    ctx.roundMcp = ctx.roundMcp || {};
    for(const a in mcpAliases){
      ctx.roundMcp[a] = (ctx.roundMcp[a] || 0) + 1;
      const cap = this.mcpServerMaxRounds(a);
      if(ctx.roundMcp[a] >= cap){
        emit('\n[已达 MCP 服务器「' + a + '」工具调用轮数上限 ' + cap + ', 如需继续请回复"继续"]');
        return { done: true, hitCap: true };
      }
    }
    return { done: false };
  },

  _resStr(r){
    let s = r.ok ? (r.response || '(空)') : ('调用失败: ' + (r.reason || '未知错误') + (r.response ? '\n' + r.response : ''));
    s = String(s).slice(0, 8000);
    if(r.images && r.images.length) s += '\n[附图 ' + r.images.length + ' 张, 已在界面卡片中显示]';
    return s;
  },

  buildTurns(ctx, pieceText, calls, results){
    if(ctx.flavor === 'anthropic'){
      const content = [];
      const t = String(pieceText || '').trim();
      if(t) content.push({ type: 'text', text: t });
      calls.forEach(c => content.push({ type: 'tool_use', id: c.id, name: c.sName, input: c.args }));
      const resBlocks = calls.map((c, i) => {
        const r = results[i];
        const rc = [{ type: 'text', text: this._resStr(r) }];
        if(ctx.vision)(r.images || []).slice(0, 2).forEach(img => {
          const m = /^data:([^;]+);base64,(.+)$/.exec(img);
          if(m && m[2].length < 2000000) rc.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        });
        return { type: 'tool_result', tool_use_id: c.id, content: rc, is_error: !r.ok };
      });
      return [
        { role: 'assistant', content, _fc: 1 },
        { role: 'user', content: resBlocks, _fc: 1 }
      ];
    }
    // openai
    const turns = [{
      role: 'assistant',
      content: String(pieceText || '').trim() || null,
      tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.sName, arguments: JSON.stringify(c.args || {}) } })),
      _fc: 1
    }];
    calls.forEach((c, i) => turns.push({ role: 'tool', tool_call_id: c.id, content: this._resStr(results[i]), _fc: 1 }));
    /* OpenAI 兼容接口的 tool 消息只能承载文本；视觉模型另加一条用户图像消息，让模型真正看到后端截图。 */
    if(ctx.vision){
      const imgs=[];
      results.forEach(r=>(r&&r.images||[]).forEach(img=>{if(imgs.length<4&&/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(String(img||'')))imgs.push(String(img))}));
      if(imgs.length)turns.push({role:'user',content:[{type:'text',text:'[后端工具返回的截图/图像，请结合上方工具结果继续处理。]'}].concat(imgs.map(img=>({type:'image_url',image_url:{url:img}}))),_fc:1});
    }
    return turns;
  },

  /* 供 _execWsOps 的 fc="1" 分支: 用台账结果填卡片, 跳过执行与结果排队 */
  ledgerGet(ctx, name, args){
    if(!ctx) return null;
    return ctx.ledger[this.ledgerKey(name, args || {})] || null;
  },
  /* 宿主侧便捷入口: 直接吃 _parseWsOps 产出的 op(args 为 JSON 字符串), 从最近一次激活的 ctx 回查 */
  ledgerGetByOp(op){
    try{
      if(!this._last || !op) return null;
      let args = {};
      const raw = String(op.args || '').trim();
      if(raw){ try{ args = JSON.parse(raw); }catch(e){ return null; } }
      return this.ledgerGet(this._last, op.name, args);
    }catch(e){ return null; }
  }
};

/* ---------- 2b. IBWS: 联网搜索(逐 API 开关; anthropic/gemini 原生, openai 视端点支持) ---------- */
const IBWS = {
  on(cfg){ return !!(cfg && cfg.webSearch); },
  /* ── 端点能力记忆（仅存内存，刷新页面清零）──
     某 API+模型 的搜索参数被服务端 400 拒绝后记住：后续每轮直接按"无搜索"构建请求，
     不再先发一次注定失败的请求（省一次往返，控制台不再每轮出现 400）。
     缓存意义：SYS_NOTE 与搜索参数在本会话内稳定缺席，成功请求的前缀不随重试来回变化。
     误判防护：仅当报错文本涉及搜索（/search/i）时才落标记，
     max_tokens / temperature 等无关参数错误不会触发（那类错误由各自的重试分支处理）。 */
  _unsup:{},
  _capKey(cfg){ return String((cfg&&cfg.id)||'')+'|'+String((cfg&&cfg.model)||''); },
  markUnsupported(cfg,err){
    try{
      if(!/search/i.test(String(err&&err.message||err||'')))return;
      const k=this._capKey(cfg);
      if(this._unsup[k])return;
      this._unsup[k]=true;
      console.info('[IB联网搜索] 该模型的接口不接受搜索参数（'+String((cfg&&cfg.model)||'')+'），本会话内已自动停用联网搜索，避免每轮先发一次失败请求。刷新页面后会重新探测。');
    }catch(e){}
  },
  blocked(cfg){ try{ return !!this._unsup[this._capKey(cfg)]; }catch(e){ return false; } },
  /* 追加到 system 末尾的使用规则：与搜索工具同时出现、同时消失（注入点在 _callApiChat*Once）
     注意：此文案是常量——只要联网开关不变，system 内容就稳定，不影响提示缓存命中 */
  SYS_NOTE: '\n\n【联网搜索使用规则】web_search 只在用户明确需要互联网上的信息时才可调用（查资料、新闻、天气、需核实的时事等）。以下情况禁止调用搜索工具：创建/生成/编辑/读取文件，写文档/表格/PDF/代码（一律用 ws_ 标签直接完成）。调用前自检：完成这条消息是否必须用到互联网上的新信息？若否，直接完成任务，不需要搜索。',
  /* ── 逐轮硬提醒（治"改提示词只好一阵子"的根）──
     与本文件 _callApiChatOnce 里思考链的修法同源：system 里的规则离生成点最远、
     会被长上下文稀释；把提醒附到"最后一条 user 消息"末尾（只改发送用的临时副本，
     不写入任何已保存历史）。消息级缓存断点打在倒数第2条上（见 _injectAnthropicMsgCache），
     最后一条 user 消息本来就永远是新输入，因此本注入零缓存代价；
     也刻意不做"检测到文件任务就把搜索工具从请求里摘掉"——tools 位于缓存前缀最前端，
     逐轮增删工具会把 system+全部历史的缓存反复打穿，长对话下代价远高于误搜。 */
  FILE_RE: /(ws_(create|edit|read|run|project|make_docx|make_pdf|make_xlsx)|工作区|文件|文档|表格|代码|脚本|程序|保存|存成|存为|导出|另存|docx?\b|pdf|xlsx?\b|excel|pptx?\b|csv\b|json\b|html?\b|markdown|\bmd\b|txt\b|word\b|python|javascript|\.py\b|\.js\b)/i,
  SEARCH_RE: /(搜|检索|查一下|查查|查询|查资料|帮我查|联网|上网|百度|谷歌|必应|google|bing|新闻|资讯|最新|近况|实时|时事|行情|股价|汇率|天气|官网|网上|\bsearch\b|\bnews\b|latest|look\s*up|browse)/i,
  /* 意图判定前的清洗（SEARCH_RE 只测清洗后的文本）：
     ① 剥掉否定/禁止式提及——"没搜/别搜了/禁止用搜索/停止搜索"是在反对搜索，不是要搜索；
     ② 剥掉"检查/审查/调查"这类含"查"的非搜索复合词，避免"检查一下"误命中"查一下"。
     刻意不用 (?<!…) 后行断言：正则字面量里的 lookbehind 在旧 Safari 是"解析期"报错，会连累整个脚本块。 */
  _stripNeg(t){return String(t||'').replace(/(没|别|不要|不用|不许|不准|禁止|勿|无需|不需要|不得|不能|停止)\s*(再|去|用|使用|调用|进行)?\s*(联网|上网)?\s*(搜索|搜|检索|查询|联网|上网)/g,'').replace(/[检审调]查/g,'')},
  TURN_NOTE: '\n\n[系统提示] 本条是文件/工作区任务：禁止调用联网搜索工具(web_search/google_search)，不要检索网页，直接用 ws_ 标签或已有知识完成。',
  /* 仅当"整组消息的最后一条"是普通(非FC回环)用户消息时返回其纯文本；否则返回空串。
     此函数只用于决定 TURN_NOTE 的追加目标——刻意不回溯历史：
     历史消息位于缓存断点之前，动它们会打穿前缀缓存。 */
  _lastUserText(msgs){
    try{
      const m=(msgs&&msgs.length)?msgs[msgs.length-1]:null;
      if(!m||m.role!=='user'||m._fc)return '';
      if(typeof m.content==='string')return m.content;
      if(Array.isArray(m.content))return m.content.map(p=>(p&&p.text)?p.text:'').join('\n');
      return String(m.content||'');
    }catch(e){}
    return '';
  },
  /* 文件/工作区意图 且 无明确搜索意图 → 本轮需要硬提醒。 */
  fileTurn(msgs){
    const t=this._lastUserText(msgs);if(!t)return false;
    if(!this.FILE_RE.test(t))return false;
    return !this.SEARCH_RE.test(this._stripNeg(t));
  },
  /* 在发送用的消息副本上给最后一条 user 消息追加 TURN_NOTE；返回新数组，绝不改动原历史对象 */
  steer(msgs,cfg,opts){
    try{
      if(!this.on(cfg)||(opts&&opts._noWebSearch)||this.blocked(cfg))return msgs;
      if(!this.fileTurn(msgs))return msgs;
      const out=msgs.slice();
      const i=out.length-1;const m=out[i];
      if(!m||m.role!=='user'||m._fc)return msgs;
      if(Array.isArray(m.content))out[i]=Object.assign({},m,{content:m.content.concat([{type:'text',text:this.TURN_NOTE}])});
      else out[i]=Object.assign({},m,{content:String(m.content||'')+this.TURN_NOTE});
      return out;
    }catch(e){}
    return msgs;
  },
  /* 4xx 且非 401/403 视为"参数不被接受", 触发去搜索重试; 鉴权错不重试 */
  errLooksParam(e){ const t = String(e && e.message || e || ''); return /^4\d\d/.test(t) && !/^40[13]/.test(t); },
  /* 发送前把搜索参数并入请求体; opts._noWebSearch 由回落重试置位 */
  attach(body, fmt, cfg, opts){
    try{
      if(opts && opts._noWebSearch) return false;
      if(this.blocked(cfg)) return false;/* 本会话已确认该模型不接受搜索参数 */
      if(!this.on(cfg) || !body) return false;
      if(fmt === 'anthropic'){
        body.tools = (body.tools || []).concat([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
        return true;
      }
      if(fmt === 'gemini'){
        body.tools = (body.tools || []).concat([{ google_search: {} }]);
        return true;
      }
      if(fmt === 'openai'){
        if(body.web_search_options === undefined) body.web_search_options = {};
        return true;
      }
    }catch(e){}
    return false;
  }
};

/* ---------- 3. IBSandbox: 沙箱扩展 (pip 白名单 / matplotlib 图片 / JS 加固) ---------- */
const IBSandbox = {
  pipAllow(){
    try{
      return (localStorage.getItem('ib_pipAllow') || '')
        .split(/[,，\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    }catch(e){ return []; }
  },
  setPipAllow(s){ try{ localStorage.setItem('ib_pipAllow', String(s || '')); }catch(e){} },
  checkPip(list){
    const allow = this.pipAllow();
    const denied = (list || []).filter(p => allow.indexOf(String(p).trim().toLowerCase()) < 0);
    return { ok: denied.length === 0, denied };
  },
  parsePipAttr(s){
    return String(s || '').split(/[,，\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 8);
  },

  /* Python worker 内注入的两段代码(接线时拼进 _WS_PY_WORKER_SRC) */
  PY_SETUP: "import os\nos.environ.setdefault('MPLBACKEND','AGG')\n",
  PY_FIGS: "def __ib_figs():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        import sys\n" +
    "        if 'matplotlib' in sys.modules:\n" +
    "            import matplotlib.pyplot as plt, io, base64\n" +
    "            for n in plt.get_fignums()[:6]:\n" +
    "                f=plt.figure(n); b=io.BytesIO()\n" +
    "                f.savefig(b, format='png', dpi=110, bbox_inches='tight')\n" +
    "                out.append(base64.b64encode(b.getvalue()).decode())\n" +
    "            plt.close('all')\n" +
    "    except Exception:\n" +
    "        pass\n" +
    "    return out\n",

  /* JS worker 加固前置(接线时 prepend 到 _WS_JS_WORKER_SRC 用户代码之前) */
  JS_HARDEN: "try{self.fetch=undefined;}catch(e){};try{self.XMLHttpRequest=undefined;}catch(e){};" +
    "try{self.importScripts=undefined;}catch(e){};try{self.indexedDB=undefined;}catch(e){};" +
    "try{self.caches=undefined;}catch(e){};try{self.WebSocket=undefined;}catch(e){};" +
    "try{self.EventSource=undefined;}catch(e){};",

  /* 卡片里的图片行(run / mcp tool 共用) */
  cssDone: false,
  ensureCss(){
    if(this.cssDone || typeof document === 'undefined') return;
    const st = document.createElement('style');
    st.textContent = '.ib-imgrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
      '.ib-imgrow img{max-height:110px;max-width:180px;border-radius:6px;cursor:zoom-in;border:1px solid rgba(128,128,128,.35)}' +
      '.ib-imgrow img.ib-full{max-height:80vh;max-width:100%;cursor:zoom-out}';
    document.head.appendChild(st);
    this.cssDone = true;
  },
  imagesRow(images){
    if(!images || !images.length) return '';
    this.ensureCss();
    const esc = s => String(s).replace(/"/g, '&quot;');
    return '<div class="ib-imgrow">' + images.slice(0, 6).map(src => {
      const full = /^data:/.test(src) ? src : 'data:image/png;base64,' + src;
      return '<img src="' + esc(full) + '" onclick="this.classList.toggle(\'ib-full\')" alt="图表">';
    }).join('') + '</div>';
  },
  capImages(images, maxTotal){
    maxTotal = maxTotal || 9 * 1024 * 1024;
    const out = []; let tot = 0;
    (images || []).forEach(b => {
      const s = String(b); tot += s.length;
      if(tot <= maxTotal) out.push(s);
    });
    return out;
  }
};

/* ---------- 4. IBDIY: 自装载设置卡(自动克隆宿主卡片样式, 接线只需一行) ---------- */
const IBDIY = {
  mounted: false,
  esc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); },

  /* 在 DIY 页渲染后调用: 找到「外部工具」卡片 → 在其后插入 MCP / 沙箱卡 + 在其内追加 FC 开关 */
  mount(){
    if(typeof document === 'undefined') return;
    const anchor = this.findToolsCard();
    if(!anchor) return;
    this.injectFcToggle(anchor);
    if(!document.getElementById('ib-mcp-card')){
      const mk = (id, bodyId, title) => {
        const el = document.createElement(anchor.tagName);
        el.className = anchor.className;
        el.id = id;
        el.style.cssText = 'padding:20px';
        el.innerHTML = '<h3>' + title + '</h3><div id="' + bodyId + '"></div>';
        anchor.parentNode.insertBefore(el, anchor.nextSibling);
        return el;
      };
      mk('ib-net-card', 'ib-net-body', '后端连接 <span class="section-meta">(Internal Bridge)</span>');
      mk('ib-richlib-card', 'ib-richlib-body', '文件解析库 <span class="section-meta">(File Parsers)</span>');
      mk('ib-sbx-card', 'ib-sbx-body', '沙箱扩展 <span class="section-meta">(Sandbox)</span>');
      mk('ib-mcp-card', 'ib-mcp-body', 'MCP 服务器');
    }
    this.renderMcp(); this.renderSbx(); this.renderNet();
    try{ if(typeof _ibRichLibsMount === 'function') _ibRichLibsMount(); }catch(e){}
    this.mounted = true;
  },

  findToolsCard(){
    /* ① 从 #ibtools-list 或 #ibtools-enabled 向上找到卡片容器 */
    const known = document.getElementById('ibtools-list') || document.getElementById('ibtools-enabled');
    if(known){
      let el = known;
      for(let k = 0; k < 8 && el; k++){
        const cls = (el.className || '').toString();
        if(cls.indexOf('api-section') >= 0 || cls.indexOf('glass-card') >= 0) return el;
        el = el.parentElement;
      }
      return known.parentElement || known;
    }
    /* ② 兜底：按标题文字定位 */
    const hs = document.querySelectorAll('h1,h2,h3,h4');
    for(let i = 0; i < hs.length; i++){
      const t = (hs[i].textContent || '').trim();
      if(t.indexOf('外部工具') === 0) return hs[i].parentElement;
    }
    return null;
  },

  injectFcToggle(anchor){
    if(document.getElementById('ib-fc-toggle')) {
      document.getElementById('ib-fc-toggle').checked = IBFC.on();
      return;
    }
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13px;cursor:pointer';
    wrap.innerHTML = '<input type="checkbox" id="ib-fc-toggle" class="u-native-check"> 原生函数调用（Anthropic / OpenAI 使用 tools 参数，其余厂商自动回落 XML）' +
      ' <span style="opacity:.6;margin-left:6px" title="Webhook 外部工具连续自动调用的轮数上限">外部工具轮上限</span><input type="number" id="ib-fc-rounds" class="ib-num" min="1" max="99" style="width:52px">';
    anchor.appendChild(wrap);
    const tg = wrap.querySelector('#ib-fc-toggle');
    tg.checked = IBFC.on();
    tg.onchange = () => IBFC.setOn(tg.checked);
    const rd = wrap.querySelector('#ib-fc-rounds');
    rd.value = IBFC.maxRounds();
    rd.onchange = () => {
      try{ localStorage.setItem('ib_fcRounds', rd.value); }catch(e){}
    };
  },

  /* ---- MCP 卡 ---- */
  renderMcp(){
    const box = document.getElementById('ib-mcp-body');
    if(!box) return;
    const c = IBMCP.cfg();
    const gcap = 5;   // 逐服务器「轮上限」留空时的默认值, 作为输入框占位提示
    const rows = c.servers.map((s, i) => {
      const st = s.status === 'ok'
        ? '<span style="color:var(--accent)">已连接 · ' + (s.tools || []).length + ' 个工具</span>'
        : (s.lastError ? '<span style="color:#c44">' + this.esc(String(s.lastError).slice(0, 90)) + '</span>' : '<span style="opacity:.55">未连接</span>');
      const _mr = parseInt(s.maxRounds, 10);
      const mrv = (_mr >= 1 && _mr <= 99) ? _mr : '';
      const tools = (s.tools || []).map((t, j) =>
        '<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0;font-size:0.78rem;cursor:pointer">' +
        '<input type="checkbox" data-ib-mcptool="' + i + ':' + j + '"' + (t.enabled !== false ? ' checked' : '') + ' class="u-native-check">' +
        this.esc(t.name) + '</label>'
      ).join('');
      return '<div style="border:1px solid var(--glass-border);border-radius:10px;padding:10px 12px;margin:8px 0">' +
        '<div class="api-form-group" style="margin-bottom:6px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<input data-ib-mcpalias="' + i + '" value="' + this.esc(s.alias) + '" placeholder="别名" style="width:90px">' +
        '<input data-ib-mcpurl="' + i + '" value="' + this.esc(s.url) + '" placeholder="服务器地址（含 token）" style="flex:1;min-width:180px">' +
        '<label style="font-size:0.78rem;display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap"><input type="checkbox" data-ib-mcpon="' + i + '"' + (s.enabled !== false ? ' checked' : '') + ' class="u-native-check">启用</label>' +
        '<label style="font-size:0.78rem;display:inline-flex;align-items:center;gap:4px;white-space:nowrap" title="该服务器工具连续自动调用的轮数上限（1~99）；留空则为默认值 5">轮上限<input type="number" data-ib-mcprounds="' + i + '" class="ib-num" value="' + mrv + '" placeholder="' + gcap + '" min="1" max="99" style="width:52px"></label>' +
        '<button class="btn" style="padding:3px 12px;font-size:0.75rem" data-ib-mcpconn="' + i + '">连接</button>' +
        '<button class="btn" style="padding:3px 12px;font-size:0.75rem" data-ib-mcpdel="' + i + '">删除</button>' +
        '</div></div><div style="font-size:0.78rem;margin-top:2px">' + st + '</div>' +
        (tools ? '<div style="margin-top:6px">' + tools + '</div>' : '') +
        '</div>';
    }).join('');

    box.innerHTML =
      '<p class="settings-description">连接 MCP 服务器后自动发现可用工具，调用方式与外部工具一致。连接失败时请检查跨域（CORS）设置。每个服务器可单独设置「轮上限」（连续自动调用的轮数上限，1~99），留空则为默认值 5。</p>' +
      '<div class="api-form-group" style="margin-bottom:8px"><label class="form-check-row"><input type="checkbox" id="ib-mcp-on"' + (c.enabled !== false ? ' checked' : '') + ' class="u-native-check"> 启用 MCP</label></div>' +
      '<div class="api-form-group" style="margin-bottom:14px"><label class="form-check-row"><input type="checkbox" id="ib-mcp-cf"' + (c.confirm !== false ? ' checked' : '') + ' class="u-native-check"> 调用前询问（需点击确认卡片后才会执行）</label></div>' +
      rows +
      '<div class="api-actions u-mt-3"><button class="btn btn-primary" id="ib-mcp-add">+ 添加服务器</button></div>';

    const self = this;
    box.querySelector('#ib-mcp-on').onchange = e => { const cc = IBMCP.cfg(); cc.enabled = e.target.checked; IBMCP.save(cc); };
    box.querySelector('#ib-mcp-cf').onchange = e => { const cc = IBMCP.cfg(); cc.confirm = e.target.checked; IBMCP.save(cc); };
    box.querySelector('#ib-mcp-add').onclick = () => { const cc = IBMCP.cfg(); cc.servers.push({ alias: 'srv' + (cc.servers.length + 1), url: '', enabled: true, tools: [] }); IBMCP.save(cc); self.renderMcp(); };
    box.querySelectorAll('[data-ib-mcpalias]').forEach(inp => { inp.onchange = () => { const cc = IBMCP.cfg(); cc.servers[+inp.dataset.ibMcpalias].alias = inp.value.trim() || 'srv'; IBMCP.save(cc); }; });
    box.querySelectorAll('[data-ib-mcpurl]').forEach(inp => { inp.onchange = () => { const cc = IBMCP.cfg(); cc.servers[+inp.dataset.ibMcpurl].url = inp.value.trim(); IBMCP.save(cc); }; });
    box.querySelectorAll('[data-ib-mcpon]').forEach(inp => { inp.onchange = () => { const cc = IBMCP.cfg(); cc.servers[+inp.dataset.ibMcpon].enabled = inp.checked; IBMCP.save(cc); }; });
    box.querySelectorAll('[data-ib-mcprounds]').forEach(inp => { inp.onchange = () => {
      const cc = IBMCP.cfg(); const s = cc.servers[+inp.dataset.ibMcprounds]; if(!s) return;
      const n = parseInt(inp.value, 10);
      if(n >= 1 && n <= 99){ s.maxRounds = n; } else { delete s.maxRounds; inp.value = ''; }   // 留空/非法 → 清除, 跟随全局
      IBMCP.save(cc);
    }; });
    box.querySelectorAll('[data-ib-mcpdel]').forEach(btn => { btn.onclick = () => { const cc = IBMCP.cfg(); cc.servers.splice(+btn.dataset.ibMcpdel, 1); IBMCP.save(cc); self.renderMcp(); }; });
    box.querySelectorAll('[data-ib-mcpconn]').forEach(btn => {
      btn.onclick = async () => {
        const i = +btn.dataset.ibMcpconn;
        const cc = IBMCP.cfg(); const alias = cc.servers[i].alias;
        btn.disabled = true; btn.textContent = '连接中…';
        try{
          const n = await IBMCP.connect(alias);
          ibExtSay('连接成功，发现 ' + n + ' 个工具');
        }catch(e){
          const cc2 = IBMCP.cfg(); const s2 = cc2.servers.find(x => x.alias === alias);
          if(s2){ s2.status = 'err'; s2.lastError = String(e && e.message || e); IBMCP.save(cc2); }
        }
        btn.disabled = false; btn.textContent = '连接';
        self.renderMcp();
      };
    });
    box.querySelectorAll('[data-ib-mcptool]').forEach(inp => {
      inp.onchange = () => {
        const p = inp.dataset.ibMcptool.split(':');
        const cc = IBMCP.cfg();
        cc.servers[+p[0]].tools[+p[1]].enabled = inp.checked;
        IBMCP.save(cc);
      };
    });
  },

  /* ---- 沙箱扩展卡 ---- */
  renderSbx(){
    const box = document.getElementById('ib-sbx-body');
    if(!box) return;
    let cur = '';
    try{ cur = localStorage.getItem('ib_pipAllow') || ''; }catch(e){}
    box.innerHTML =
      '<p class="settings-description">Python 沙箱支持 numpy、pandas、scipy、sympy、matplotlib 等科学计算包，按 import 自动加载。matplotlib 生成的图表以图片回传到聊天中。AI 可通过 <code style="font-size:0.82rem">pip="包名"</code> 申请安装其他纯 Python 包，仅限白名单内的包可执行。JS 沙箱已启用安全加固，禁止网络与存储 API。</p>' +
      '<div class="api-form-group"><label>micropip 白名单 <span class="field-note-inline">（逗号分隔）</span></label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<input id="ib-pip-allow" value="' + this.esc(cur) + '" placeholder="如：jieba, pypinyin" style="flex:1;min-width:200px">' +
      '<button class="btn btn-primary" id="ib-pip-save" style="padding:5px 16px;font-size:0.82rem">保存</button></div></div>';
    box.querySelector('#ib-pip-save').onclick = () => {
      IBSandbox.setPipAllow(box.querySelector('#ib-pip-allow').value);
      ibExtSay('白名单已保存');
    };
  },

  /* ---- 后端连接卡(Internal Bridge / IBNET) ---- */
  renderNet(){
    const box = document.getElementById('ib-net-body');
    if(!box || typeof IBNET === 'undefined') return;
    const c = IBNET.cfg();
    box.innerHTML =
      '<p class="settings-description">可选的后端长连接。这个 HTML 只包含客户端连接器，本身不能越过浏览器沙箱控制其他网页或游戏；需要另行运行本机 Internal Bridge 服务。后端可向页面推送消息，也可向 AI 提供受控工具（浏览器操作、页面结构、截图等）。工具属于高权限能力，默认关闭且默认逐次确认；只连接你信任的本机或私有服务器。</p>' +
      '<label class="ibtools-sw"><input type="checkbox" id="ib-net-on"' + (c.enabled ? ' checked' : '') + ' class="u-native-check"> 启用后端连接</label>' +
      '<label class="ibtools-sw"><input type="checkbox" id="ib-net-auto"' + (c.auto !== false ? ' checked' : '') + ' class="u-native-check"> 打开页面时自动连接</label>' +
      '<label class="ibtools-sw"><input type="checkbox" id="ib-net-toast"' + (c.toastOn !== false ? ' checked' : '') + ' class="u-native-check"> 收到推送时弹出提示</label>' +
      '<label class="ibtools-sw"><input type="checkbox" id="ib-net-tools"' + (c.toolsEnabled ? ' checked' : '') + ' class="u-native-check"> 允许后端向 AI 提供工具（高权限）</label>' +
      '<label class="ibtools-sw ibtools-sw-last"><input type="checkbox" id="ib-net-tools-confirm"' + (c.confirmTools !== false ? ' checked' : '') + ' class="u-native-check"> 后端工具调用前询问</label>' +
      '<div class="api-form-group"><label>后端地址 <span class="field-note-inline">（ws:// 或 wss://；填 http(s):// 会自动转换）</span></label><input id="ib-net-url" value="' + this.esc(c.url) + '" placeholder="ws://192.168.1.10:8765 或 wss://your-server.com/ib"></div>' +
      '<div class="api-form-group"><label>访问令牌（可选）<span class="field-note-inline">（连接后在首帧 hello 中发送，供后端鉴权，不会拼入地址）</span></label><input id="ib-net-token" type="password" value="' + this.esc(c.token) + '" placeholder="与后端约定的密钥，留空则不鉴权"></div>' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      '<span id="ib-net-status" style="display:inline-flex;align-items:center;gap:7px;font-size:0.82rem"></span>' +
      '<button class="btn btn-primary" id="ib-net-btn-c" style="padding:5px 18px;font-size:0.82rem">连接</button>' +
      '<button class="btn" id="ib-net-btn-d" style="padding:5px 18px;font-size:0.82rem">断开</button>' +
      '</div>' +
      '<div style="font-size:0.72rem;opacity:0.55;line-height:1.7;margin-bottom:14px">协议：JSON 文本帧（v1.1）。除 <code style="font-size:0.7rem">push</code> 外，后端可通过 <code style="font-size:0.7rem">tool_catalog</code> 声明工具，客户端用 <code style="font-size:0.7rem">tool_call</code> 调用并等待 <code style="font-size:0.7rem">tool_result</code>。完整协议见 Guide 页 DIY 章节。WebSocket 不受 CORS 约束；HTTPS 页面只能连 wss://。</div>' +
      '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px"><span style="font-size:0.85rem;color:var(--silver);letter-spacing:0.03em">推送记录</span><span id="ib-net-inbox-count" style="font-size:0.72rem;opacity:0.5"></span><button class="btn" id="ib-net-inbox-clear" style="padding:2px 10px;font-size:0.7rem;margin-left:auto">清空</button></div>' +
      '<div id="ib-net-inbox"></div>';

    const self = this;
    box.querySelector('#ib-net-on').onchange = e => {
      const cc = IBNET.cfg(); cc.enabled = e.target.checked; IBNET.save(cc);
      if(cc.enabled){ if(cc.url) IBNET.connect(true); else IBNET._setStatus('idle'); }
      else IBNET.disconnect();
    };
    box.querySelector('#ib-net-auto').onchange = e => { const cc = IBNET.cfg(); cc.auto = e.target.checked; IBNET.save(cc); };
    box.querySelector('#ib-net-toast').onchange = e => { const cc = IBNET.cfg(); cc.toastOn = e.target.checked; IBNET.save(cc); };
    box.querySelector('#ib-net-tools').onchange = e => {
      const cc = IBNET.cfg(); cc.toolsEnabled = e.target.checked; IBNET.save(cc);
      if(!cc.toolsEnabled) IBNET._rejectPending('后端工具已关闭'); else IBNET.requestCatalog();
      IBNET._uiSync();
    };
    box.querySelector('#ib-net-tools-confirm').onchange = e => { const cc = IBNET.cfg(); cc.confirmTools = e.target.checked; IBNET.save(cc); };
    box.querySelector('#ib-net-url').onchange = e => {
      const cc = IBNET.cfg();
      const raw = String(e.target.value || '').trim();
      if(!raw){
        const hasSocket = !!(IBNET._ws && (IBNET._ws.readyState === 0 || IBNET._ws.readyState === 1));
        if(hasSocket){ ibExtSay('当前仍在连接中；请先断开，再清空后端地址'); e.target.value = cc.url || ''; return; }
        cc.url = ''; IBNET.save(cc); return;
      }
      const norm = IBNET._normUrl(raw), err = IBNET._validateUrl(norm);
      if(err){ ibExtSay(err); e.target.value = cc.url || ''; return; }
      cc.url = norm; IBNET.save(cc); e.target.value = norm;
    };
    box.querySelector('#ib-net-token').onchange = e => { const cc = IBNET.cfg(); cc.token = e.target.value; IBNET.save(cc); };
    box.querySelector('#ib-net-btn-c').onclick = () => {
      /* 点击连接时直接读取表单；先校验再保存，避免无效新地址破坏仍存活的旧连接。 */
      const cc = IBNET.cfg();
      if(!cc.enabled){ ibExtSay('请先勾选「启用后端连接」'); return; }
      const rawUrl = String(box.querySelector('#ib-net-url').value || '').trim();
      if(!rawUrl){ ibExtSay('请先填写后端地址'); return; }
      const normUrl = IBNET._normUrl(rawUrl);
      const urlErr = IBNET._validateUrl(normUrl);
      if(urlErr){ ibExtSay(urlErr); return; }
      cc.url = normUrl;
      cc.token = String(box.querySelector('#ib-net-token').value || '');
      IBNET.save(cc);
      box.querySelector('#ib-net-url').value = normUrl;
      IBNET.connect(true);
    };
    box.querySelector('#ib-net-btn-d').onclick = () => IBNET.disconnect();
    box.querySelector('#ib-net-inbox-clear').onclick = () => { IBNET.inboxClear(); self._netRenderInbox(); ibExtSay('推送记录已清空'); };

    this._netSyncStatus();
    this._netRenderInbox();
  },

  /* 局部同步: 仅更新状态行与按钮态, 不重绘输入框(避免打断正在进行的输入) */
  _netSyncStatus(){
    const el = document.getElementById('ib-net-status');
    if(!el || typeof IBNET === 'undefined') return;
    const s = IBNET.status();
    const dot = col => '<span style="width:8px;height:8px;border-radius:50%;background:' + col + ';display:inline-block;flex-shrink:0"></span>';
    let html = '';
    if(s === 'online'){
      const tc = IBNET.tools().length;
      html = dot('var(--accent-light)') + '<span style="color:var(--accent-light)">已连接' + (IBNET._serverName ? ' · ' + this.esc(IBNET._serverName) : '') + (tc ? ' · ' + tc + ' 个后端工具' : '') + '</span>';
    }else if(s === 'connecting'){
      html = dot('rgba(212,196,140,0.85)') + '<span style="opacity:0.8">连接中…</span>';
    }else if(s === 'retry'){
      html = dot('rgba(212,196,140,0.85)') + '<span style="opacity:0.8">' + this.esc(String(IBNET._lastError || '连接中断').slice(0, 60)) + ' · 稍后自动重连</span>';
    }else if(s === 'error'){
      html = dot('#c46060') + '<span style="color:#c46060">' + this.esc(String(IBNET._lastError || '连接失败').slice(0, 80)) + '</span>';
    }else if(s === 'idle'){
      html = dot('rgba(150,168,198,0.4)') + '<span style="opacity:0.6">未连接</span>';
    }else{
      html = dot('rgba(150,168,198,0.4)') + '<span style="opacity:0.6">未启用</span>';
    }
    el.innerHTML = html;
    const bc = document.getElementById('ib-net-btn-c');
    const bd = document.getElementById('ib-net-btn-d');
    if(bc) bc.disabled = (s === 'connecting');
    const hasSocket = !!(IBNET._ws && (IBNET._ws.readyState === 0 || IBNET._ws.readyState === 1));
    if(bd) bd.disabled = !(s === 'online' || s === 'connecting' || s === 'retry' || hasSocket);
  },

  _netRenderInbox(){
    const list = document.getElementById('ib-net-inbox');
    const cnt = document.getElementById('ib-net-inbox-count');
    if(!list || typeof IBNET === 'undefined') return;
    const a = IBNET.inbox();
    if(cnt) cnt.textContent = a.length ? ('共 ' + a.length + ' 条，最多保留 50 条') : '';
    if(!a.length){
      list.innerHTML = '<div style="font-size:0.78rem;opacity:0.45;padding:8px 0">暂无推送。后端连接成功并发来消息后会显示在这里。</div>';
      return;
    }
    const fmt = t => { const d = new Date(t); const p = n => (n < 10 ? '0' : '') + n; return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    list.innerHTML = a.slice(0, 8).map(m =>
      '<div style="border-top:1px solid var(--glass-border);padding:8px 2px;font-size:0.8rem;line-height:1.7">' +
      '<span style="opacity:0.5;font-size:0.72rem">' + fmt(m.time) + '</span>' +
      (m.from ? ' <span style="color:var(--accent-light);font-size:0.75rem">' + this.esc(m.from) + '</span>' : '') +
      (m.title ? ' <span style="font-weight:400">' + this.esc(m.title) + '</span>' : '') +
      (m.text ? '<div style="opacity:0.75;font-size:0.76rem;margin-top:2px;word-break:break-word">' + this.esc(String(m.text).slice(0, 200)) + (String(m.text).length > 200 ? '…' : '') + '</div>' : '') +
      '</div>'
    ).join('') + (a.length > 8 ? '<div style="font-size:0.72rem;opacity:0.4;padding:6px 2px">…更早的 ' + (a.length - 8) + ' 条已收起</div>' : '');
  }
};

/* ---------- 5. IBNET: 后端连接器 (Internal Bridge · WebSocket 客户端) ----------
 * 可选的后端长连接模块。在 DIY 页填入一台持续运行的后端服务器地址
 * （云 VPS、家用主机、NAS 等均可）并启用后，IB 打开期间与其保持
 * WebSocket 长连接，后端即可向本页面主动推送消息与提醒。
 * 未配置 / 未启用 / 连不上时静默降级，本体功能不受任何影响。
 *
 * ── 通信协议 (JSON text frame, v1.1) ──────────────────────────
 *
 * 1. 握手 (客户端 → 服务端)
 *    连接建立后客户端立即发送:
 *    { type:"hello", client:"InternalBeyond", version:"1.1", token:"<令牌>",
 *      capabilities:["push","tools","images"] }
 *    · token 字段来自用户在 DIY 设置卡中填写的「访问令牌」，不拼入
 *      URL，避免泄漏进服务器访问日志。留空时为空字符串。
 *    · 后端应校验 token，不通过时关闭连接（建议 close code 4001）。
 *
 * 2. 握手确认 (服务端 → 客户端, 可选)
 *    { type:"hello_ack", server:"<服务器显示名称>" }
 *    · 客户端在状态栏显示 server 名称。未收到此帧时显示"已连接"。
 *
 * 3. 心跳 (双向)
 *    { type:"ping", t:<毫秒时间戳> }   →  对端回复 { type:"pong", t:<原值> }
 *    · 客户端每 30 秒发送 ping；75 秒内无任何回包视为超时并断连重试。
 *
 * 4. 推送 (服务端 → 客户端)
 *    { type:"push", title:"<标题>", text:"<正文>", from:"<来源名>" }
 *    · 三个字段均可选，至少携带一个；超长自动截断。
 *    · 客户端行为: 弹出 toast 提示、写入本地推送记录（上限 50 条）、
 *      派发 DOM 事件 document→'ib-net-push'（CustomEvent, detail 为该条记录），
 *      供其他模块（Chat / Letters 等）后续接入监听。
 *
 * 5. 扩展消息
 *    未知 type 一律存入推送记录原文，不报错，不中断连接 (fail-open)。
 *    后续版本可在此基础上增加 tool_call / sync / cron_result 等类型，
 *    前端模块无需修改即可保存记录；新功能只需在对应模块监听事件即可接入。
 *
 * ── 环境约束 ──────────────────────────────────────────────────
 *    · 页面以 HTTPS 打开时只能连 wss://（浏览器混合内容限制）。
 *    · 本地 file:// 打开时 ws:// 与 wss:// 均可。
 *    · WebSocket 不受 CORS 约束，无需服务端配置跨域头。
 * ------------------------------------------------------------------- */
const IBNET = {
  KEY: 'ib_net_cfg',
  INBOX_KEY: 'ib_net_inbox',
  VERSION: '1.1',
  _ws: null,
  _status: 'off',          /* off | idle | connecting | online | retry | error */
  _lastError: '',
  _serverName: '',
  _tools: [],
  _retryN: 0,
  _retryTimer: null,
  _hbTimer: null,
  _connectTimer: null,
  _lastRx: 0,
  _manualOff: false,
  _connSeq: 0,
  _callSeq: 0,
  _pendingCalls: {},
  MAX_FRAME_CHARS: 12 * 1024 * 1024,  /* 单帧上限：防止异常后端用超大 JSON 卡死页面。
                                         注意必须 ≥ MAX_IMAGE_TOTAL_CHARS(8MB)+文本与 JSON 开销：
                                         旧值 5MB 会把携带合规截图(如两张3.4MB整页截图)的 tool_result
                                         整帧误判为攻击并永久断连，恰好杀死"截图给AI看"的主场景 */
  MAX_TOOL_TEXT_CHARS: 12000,
  MAX_TOOL_ARG_CHARS: 200000,
  MAX_IMAGE_TOTAL_CHARS: 8 * 1024 * 1024,

  cfg(){
    let c = {};
    try{ c = JSON.parse(localStorage.getItem(this.KEY) || '{}'); }catch(e){}
    if(typeof c.enabled === 'undefined') c.enabled = false;
    if(typeof c.url !== 'string') c.url = '';
    if(typeof c.token !== 'string') c.token = '';
    if(typeof c.auto === 'undefined') c.auto = true;
    if(typeof c.toastOn === 'undefined') c.toastOn = true;
    if(typeof c.toolsEnabled === 'undefined') c.toolsEnabled = false;  /* 高权限能力默认关闭 */
    if(typeof c.confirmTools === 'undefined') c.confirmTools = true;
    return c;
  },
  save(c){ try{ localStorage.setItem(this.KEY, JSON.stringify(c)); }catch(e){} },

  inbox(){
    let a = [];
    try{ a = JSON.parse(localStorage.getItem(this.INBOX_KEY) || '[]'); }catch(e){}
    return Array.isArray(a) ? a : [];
  },
  _inboxPush(entry){
    const a = this.inbox();
    a.unshift(entry);
    while(a.length > 50) a.pop();
    try{ localStorage.setItem(this.INBOX_KEY, JSON.stringify(a)); }catch(e){}
  },
  inboxClear(){ try{ localStorage.removeItem(this.INBOX_KEY); }catch(e){} },

  status(){ return this._status; },
  tools(){
    if(this._status !== 'online' || !this.cfg().toolsEnabled) return [];
    return this._tools.slice();
  },
  promptBlock(){
    const list = this.tools();
    if(!list.length) return '';
    return list.map(function(t){
      const sch=t.inputSchema||{}, props=sch.properties||{}, req=Array.isArray(sch.required)?sch.required:[];
      const keys=Object.keys(props).slice(0,10);
      const hint=keys.length?'（参数：'+keys.map(function(k){return k+(req.indexOf(k)>=0?'*':'')}).join('，')+'）':'（无参数）';
      return '- bridge.'+t.name+(t.description?'：'+t.description:'')+hint;
    }).join('\n');
  },
  confirmRequired(fullName){
    const c=this.cfg();
    const t=this.resolveTool(fullName);
    return c.confirmTools !== false || !!(t && t.alwaysConfirm);
  },
  resolveTool(fullName){
    const n=String(fullName||'').replace(/^bridge\./,'');
    return this._tools.find(function(t){return t.name===n})||this._tools.find(function(t){return t.name.toLowerCase()===n.toLowerCase()})||null;
  },

  /* 地址容错: http(s):// → ws(s)://; 无协议默认补 ws:// */
  _normUrl(u){
    u = String(u || '').trim();
    if(!u) return '';
    if(/^https:\/\//i.test(u)) return 'wss://' + u.slice(8);
    if(/^http:\/\//i.test(u))  return 'ws://'  + u.slice(7);
    if(!/^wss?:\/\//i.test(u)) return 'ws://' + u;
    return u;
  },
  /* Browser WebSocket cannot attach Authorization.  LAN Bridge therefore
     accepts the configured token in this handshake URL and immediately checks
     it again in the hello frame.  The stored base address remains token-free. */
  _socketUrl(url, token){
    if(!token)return url;
    try{
      const parsed=new URL(url);
      if(!parsed.searchParams.has('ib_token')&&!parsed.searchParams.has('token'))parsed.searchParams.set('ib_token',token);
      return parsed.toString();
    }catch(e){return url}
  },
  _validateUrl(url){
    try{
      const u=new URL(url);
      if(u.protocol!=='ws:'&&u.protocol!=='wss:') return '地址协议必须是 ws:// 或 wss://';
      if(u.username||u.password) return '请勿把账号或令牌写进地址；请使用“访问令牌”字段';
      if(typeof location!=='undefined'&&location.protocol==='https:'&&u.protocol==='ws:') return 'HTTPS 页面不能连接 ws://，请改用 wss://';
      return '';
    }catch(e){ return '地址无效'; }
  },
  _closeReason(ev){
    const code=ev&&Number(ev.code)||0;
    const reason=String(ev&&ev.reason||'').replace(/[\r\n\t]+/g,' ').slice(0,120);
    return (code?'code '+code:'')+(reason?((code?' · ':'')+reason):'');
  },
  _isPermanentClose(ev){
    const code=ev&&Number(ev.code)||0;
    /* 4001/4003 为本协议建议值；4401/4403 兼容常见网关鉴权关闭码。此类错误不应无限重连。 */
    return code===4001||code===4003||code===4401||code===4403;
  },

  connect(manual){
    const c = this.cfg();
    if(!c.enabled){ this._setStatus('off'); return; }
    const url = this._normUrl(c.url);
    const hasLiveSocket = !!(this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1));
    if(!url){
      this._lastError = '未填写后端地址';
      if(hasLiveSocket){ this._uiSync(); return; }
      this._setStatus('error'); return;
    }
    const urlErr=this._validateUrl(url);
    if(urlErr){
      this._lastError=urlErr;
      if(hasLiveSocket){ this._uiSync(); return; }
      this._setStatus('error'); return;
    }
    /* 只在校验通过后写回规范地址。 */
    if(url!==c.url){ c.url=url; this.save(c); }
    this._connSeq++;
    const seq=this._connSeq;
    if(this._ws) this._teardown('连接已替换');
    if(manual){ this._manualOff = false; this._retryN = 0; }
    this._clearRetry();
    this._clearConnectTimer();
    this._lastError='';
    this._serverName='';               /* 修复：切换服务器时不再显示旧名称 */
    this._tools=[];
    this._uiSync();
    this._setStatus('connecting');
    let ws;
    try{ ws = new WebSocket(this._socketUrl(url,c.token)); }
    catch(e){
      this._lastError = '地址无效: ' + String(e && e.message || e).slice(0, 80);
      this._setStatus('error');
      if(!this._manualOff) this._scheduleRetry();
      return;
    }
    this._ws = ws;
    const self = this;
    this._connectTimer=setTimeout(function(){
      if(self._ws!==ws||seq!==self._connSeq||ws.readyState!==0)return;
      self._lastError='连接超时（12秒）';
      self._teardown(self._lastError);
      if(!self._manualOff&&self.cfg().enabled)self._scheduleRetry();
      else self._setStatus(self.cfg().enabled?'idle':'off');
    },12000);
    ws.onopen = function(){
      if(self._ws!==ws||seq!==self._connSeq)return;
      self._clearConnectTimer();
      self._retryN = 0; self._lastRx = Date.now(); self._lastError='';
      try{
        ws.send(JSON.stringify({ type: 'hello', client: 'InternalBeyond', version: self.VERSION, token: self.cfg().token || '', capabilities:['push','tools','images'] }));
      }catch(e){
        self._lastError='握手发送失败：'+String(e&&e.message||e).slice(0,80);
        self._teardown(self._lastError);
        if(!self._manualOff&&self.cfg().enabled)self._scheduleRetry();else self._setStatus(self.cfg().enabled?'idle':'off');
        return;
      }
      self._setStatus('online');
      self._startHeartbeat();
    };
    ws.onmessage = function(ev){ if(self._ws===ws&&seq===self._connSeq){ try{ self._onMessage(ev); }catch(e){} } };
    ws.onerror = function(){ /* 具体状态统一由 onclose 或连接超时处理 */ };
    ws.onclose = function(ev){
      if(self._ws!==ws||seq!==self._connSeq)return;  /* 防止旧连接的迟到 close 覆盖新连接状态 */
      const wasOnline = self._status === 'online';
      const permanent=self._isPermanentClose(ev);
      const closeInfo=self._closeReason(ev);
      self._clearConnectTimer(); self._stopHeartbeat(); self._ws = null;
      self._rejectPending('后端连接已断开'+(closeInfo?'（'+closeInfo+'）':''));
      self._tools=[]; self._serverName='';
      if(self._manualOff || !self.cfg().enabled){ self._setStatus(self.cfg().enabled ? 'idle' : 'off'); return; }
      self._lastError = (wasOnline ? '连接已断开' : '无法连接') + (closeInfo ? '（' + closeInfo + '）' : '');
      /* 鉴权/权限错误属于永久错误：旧版会每 60 秒无限重连，导致日志刷屏和无意义请求。 */
      if(permanent){ self._manualOff=true; self._setStatus('error'); return; }
      self._scheduleRetry();
    };
  },

  disconnect(){
    this._manualOff = true;
    this._connSeq++;
    this._clearRetry();
    this._teardown('用户已断开连接');
    this._tools=[]; this._serverName='';
    this._setStatus(this.cfg().enabled ? 'idle' : 'off');
  },

  _teardown(reason){
    this._clearConnectTimer();
    this._stopHeartbeat();
    this._rejectPending(reason||'连接已关闭');
    const ws = this._ws; this._ws = null;
    if(ws){ try{ ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.onopen = null; ws.close(); }catch(e){} }
  },
  _clearConnectTimer(){ if(this._connectTimer){ clearTimeout(this._connectTimer); this._connectTimer=null; } },
  _rejectPending(reason){
    const p=this._pendingCalls; this._pendingCalls={};
    Object.keys(p).forEach(function(id){try{clearTimeout(p[id].timer);p[id].reject(new Error(reason||'连接已关闭'))}catch(e){}});
  },

  _scheduleRetry(){
    this._clearRetry();
    const c=this.cfg();
    if(this._manualOff||!c.enabled||!c.url){this._setStatus(c.enabled?'idle':'off');return}
    this._retryN++;
    const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(5, this._retryN - 1)));
    this._setStatus('retry');
    const self = this;
    this._retryTimer = setTimeout(function(){ self._retryTimer = null; self.connect(); }, delay);
  },
  _clearRetry(){ if(this._retryTimer){ clearTimeout(this._retryTimer); this._retryTimer = null; } },

  _startHeartbeat(){
    this._stopHeartbeat();
    const self = this;
    this._hbTimer = setInterval(function(){
      const ws = self._ws;
      if(!ws || ws.readyState !== 1) return;
      if(Date.now() - self._lastRx > 75000){
        self._lastError = '心跳超时';
        self._teardown(self._lastError);
        if(!self._manualOff && self.cfg().enabled) self._scheduleRetry();
        else self._setStatus(self.cfg().enabled ? 'idle' : 'off');
        return;
      }
      try{ ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }catch(e){}
    }, 30000);
  },
  _stopHeartbeat(){ if(this._hbTimer){ clearInterval(this._hbTimer); this._hbTimer = null; } },

  _safeSchema(s){
    try{
      if(!s||typeof s!=='object')return{type:'object',properties:{}};
      const raw=JSON.stringify(s);
      if(raw.length>20000)return{type:'object',properties:{},description:'参数结构过大，已省略'};
      const x=JSON.parse(raw);
      if(x.type!=='object')x.type='object';
      return x;
    }catch(e){return{type:'object',properties:{}}}
  },
  _setTools(list){
    const seen={};
    this._tools=(Array.isArray(list)?list:[]).slice(0,100).map(function(t){
      if(!t||typeof t!=='object')return null;
      const name=String(t.name||'').trim();
      if(!/^[A-Za-z0-9_.:-]{1,80}$/.test(name)||seen[name])return null;
      seen[name]=1;
      return{name:name,description:String(t.description||'').replace(/[\r\n\t]+/g,' ').slice(0,500),inputSchema:IBNET._safeSchema(t.inputSchema||t.input_schema),alwaysConfirm:!!t.alwaysConfirm};
    }).filter(Boolean);
    this._uiSync();
    try{document.dispatchEvent(new CustomEvent('ib-net-tools',{detail:{tools:this.tools()}}))}catch(e){}
  },
  _normalizeImages(images){
    const out=[];let total=0;const cap=this.MAX_IMAGE_TOTAL_CHARS;
    (Array.isArray(images)?images:[]).slice(0,4).forEach(function(im){
      let u='';
      if(typeof im==='string')u=im;
      else if(im&&im.data)u='data:'+(im.mimeType||im.mime_type||'image/png')+';base64,'+im.data;
      if(/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(u)&&u.length<=3500000&&total+u.length<=cap){total+=u.length;out.push(u)}
    });
    return out;
  },
  requestCatalog(){
    const ws=this._ws;
    if(this._status==='online'&&ws&&ws.readyState===1){try{ws.send(JSON.stringify({type:'tool_catalog_request'}))}catch(e){}}
  },

  callTool(fullName,args,timeoutMs){
    const self=this;
    return new Promise(function(resolve,reject){
      if(!self.cfg().toolsEnabled){reject(new Error('后端工具未启用'));return}
      const ws=self._ws;
      if(self._status!=='online'||!ws||ws.readyState!==1){reject(new Error('后端未连接'));return}
      const tool=self.resolveTool(fullName);
      if(!tool){reject(new Error('未找到后端工具: '+fullName));return}
      let safeArgs=(args&&typeof args==='object')?args:{};
      try{if(JSON.stringify(safeArgs).length>self.MAX_TOOL_ARG_CHARS){reject(new Error('后端工具参数过大'));return}}catch(e){reject(new Error('后端工具参数无法序列化'));return}
      const id='tc_'+Date.now().toString(36)+'_'+(++self._callSeq).toString(36);
      const ms=Math.max(3000,Math.min(180000,Number(timeoutMs)||90000));
      const timer=setTimeout(function(){
        const p=self._pendingCalls[id];if(!p)return;
        delete self._pendingCalls[id];
        reject(new Error('后端工具调用超时（'+Math.round(ms/1000)+'秒）'));
      },ms);
      self._pendingCalls[id]={resolve:resolve,reject:reject,timer:timer,name:tool.name};
      try{ws.send(JSON.stringify({type:'tool_call',id:id,name:tool.name,args:safeArgs}))}
      catch(e){clearTimeout(timer);delete self._pendingCalls[id];reject(e)}
    });
  },
  async execOp(name,args){
    try{
      const r=await this.callTool(name,args);
      return{ok:r.ok!==false,reason:r.ok===false?(r.error||'后端工具返回失败'):'',response:r.text||'',images:r.images||[],data:r.data};
    }catch(e){return{ok:false,reason:String(e&&e.message||e),response:'',images:[]}}
  },

  _onMessage(ev){
    if(typeof ev.data !== 'string') return;
    if(ev.data.length>this.MAX_FRAME_CHARS){
      this._lastError='后端消息过大，已断开（上限 '+Math.round(this.MAX_FRAME_CHARS/1024/1024)+'MB）';
      this._manualOff=true;this._teardown(this._lastError);this._setStatus('error');return;
    }
    let m = null;
    try{ m = JSON.parse(ev.data); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;
    /* 只有有效协议 JSON 才算一次真实回包。 */
    this._lastRx = Date.now();
    const t = m.type;
    /* 通用事件必须在分流前派发：修复旧版“未知消息可扩展”但实际无事件可监听的问题 */
    try{ document.dispatchEvent(new CustomEvent('ib-net-message', { detail: m })); }catch(e){}
    if(t === 'ping'){ try{ this._ws && this._ws.readyState === 1 && this._ws.send(JSON.stringify({ type: 'pong', t: m.t })); }catch(e){} return; }
    if(t === 'pong') return;
    if(t === 'hello_ack'){
      if(m.ok===false){
        this._lastError=String(m.error||'后端拒绝连接').replace(/[\r\n\t]+/g,' ').slice(0,160);
        this._manualOff=true;this._teardown(this._lastError);this._setStatus('error');return;
      }
      if(m.server) this._serverName = String(m.server).slice(0, 40);
      if(Array.isArray(m.tools))this._setTools(m.tools);else this._uiSync();
      return;
    }
    if(t === 'tool_catalog'){ this._setTools(m.tools); return; }
    if(t === 'tool_result'){
      const p=this._pendingCalls[String(m.id||'')];
      if(!p)return;
      delete this._pendingCalls[String(m.id||'')]; clearTimeout(p.timer);
      let text=String(m.text||'').slice(0,this.MAX_TOOL_TEXT_CHARS);
      let data=m.data;
      if(data!==undefined){
        try{const raw=JSON.stringify(data);if(raw.length>this.MAX_TOOL_TEXT_CHARS)data={truncated:true,preview:raw.slice(0,this.MAX_TOOL_TEXT_CHARS)}}catch(e){data=undefined}
      }
      if(!text&&data!==undefined){try{text=JSON.stringify(data).slice(0,this.MAX_TOOL_TEXT_CHARS)}catch(e){}}
      p.resolve({ok:m.ok!==false,text:text,error:String(m.error||'').slice(0,1000),data:data,images:this._normalizeImages(m.images)});
      return;
    }
    if(t === 'push'){
      const entry = {
        id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        time: Date.now(),
        title: String(m.title || '').slice(0, 120),
        text: String(m.text || '').slice(0, 2000),
        from: String(m.from || '').slice(0, 40)
      };
      this._inboxPush(entry);
      if(this.cfg().toastOn){
        try{ toast((entry.from ? entry.from + '：' : '') + String(entry.title || entry.text || '收到一条推送').slice(0, 60)); }catch(e){}
      }
      try{ document.dispatchEvent(new CustomEvent('ib-net-push', { detail: entry })); }catch(e){}
      this._uiInbox();
      return;
    }
    /* 未知类型保留到收件箱，便于排错；同时已通过 ib-net-message 派发给扩展模块 */
    this._inboxPush({ id: 'u' + Date.now().toString(36), time: Date.now(), title: '[' + String(t || '?').slice(0, 24) + ']', text: String(ev.data).slice(0, 500), from: '' });
    this._uiInbox();
  },

  _setStatus(s){ this._status = s; this._uiSync(); },
  _uiSync(){ try{ if(typeof IBDIY !== 'undefined' && IBDIY._netSyncStatus) IBDIY._netSyncStatus(); }catch(e){} },
  _uiInbox(){ try{ if(typeof IBDIY !== 'undefined' && IBDIY._netRenderInbox) IBDIY._netRenderInbox(); }catch(e){} },

  boot(){
    const c = this.cfg();
    if(c.enabled && c.auto !== false && c.url){
      const self = this;
      setTimeout(function(){ try{ self.connect(); }catch(e){} }, 1200);
    }else this._setStatus(c.enabled?'idle':'off');
  }
};

/* 提示: 优先用宿主 toast, 无则回落 alert */
function ibExtSay(msg){ try{ if(typeof toast === 'function') return toast(msg); }catch(e){} try{ alert(msg); }catch(e){} }

/* ---------- 重置时的扩展数据清理(接进 resetAllData) ---------- */
function ibExtReset(){
  ['ib_mcp_cfg', 'ib_fcMode', 'ib_fcRounds', 'ib_mcpRounds', 'ib_pipAllow', 'ib_net_cfg', 'ib_net_inbox'].forEach(k => {
    try{ localStorage.removeItem(k); }catch(e){}
  });
  /* 后端连接: 断开在途连接并停掉重连/心跳定时器 */
  try{ if(typeof IBNET !== 'undefined'){ IBNET._manualOff = true; IBNET._clearRetry(); IBNET._teardown(); IBNET._status = 'off'; } }catch(e){}
  /* 兼容清理: 旧向量方案遗留的键与库 */
  ['ib_vecOn', 'ib_vecHost'].forEach(k => { try{ localStorage.removeItem(k); }catch(e){} });
  try{ indexedDB.deleteDatabase('IB_VEC'); }catch(e){}
}

/* ---------- Node 测试环境导出(浏览器内无副作用) ---------- */
if(typeof module !== 'undefined' && module.exports){
  module.exports = { IB_MD, IBMCP, IBFC, IBWS, IBSandbox, IBDIY, IBNET, ibExtReset, ibExtSay };
}

/* ---------- IB-EXT 宿主接线: hook 注入(全部 fail-open, 任一异常回落原行为) ---------- */
try{
  /* FC: 本地 Webhook 工具的 目录/确认/执行 三个钩子(执行结果经原生 tool_result 回传, 不再走注入队列) */
  IBFC.getLocalTools=function(){
    var out=[];
    var c=(typeof _ibToolsCache!=='undefined')?_ibToolsCache:null;
    if(c&&c.enabled)out=out.concat((c.tools||[]).map(function(t){return{name:t.name,description:(t.desc||'')+(t.params?'（参数：'+t.params+'）':'')}}));
    try{if(typeof IBNET!=='undefined')out=out.concat(IBNET.tools().map(function(t){return{name:'bridge.'+t.name,description:t.description||'Internal Bridge 后端工具',inputSchema:t.inputSchema}}))}catch(e){}
    return out;
  };
  IBFC.confirmLookup=function(name){
    if(/^bridge\./.test(String(name||''))&&typeof IBNET!=='undefined')return IBNET.confirmRequired(name);
    var c=(typeof _ibToolsCache!=='undefined')?_ibToolsCache:null;
    return!c||c.confirm!==false;
  };
  IBFC.execLocalTool=async function(name,args){
    if(/^bridge\./.test(String(name||''))&&typeof IBNET!=='undefined')return IBNET.execOp(name,args||{});
    var c=await getIbTools();
    if(!c.enabled)return{ok:false,reason:'外部工具功能未启用（API 设置页可开启）',response:''};
    var tool=(c.tools||[]).find(function(t){return t.name===name})||(c.tools||[]).find(function(t){return t.name.toLowerCase()===String(name).toLowerCase()});
    if(!tool)return{ok:false,reason:'未找到该工具（名称须与配置完全一致）',response:''};
    var r=await _ibToolFetch(tool,args||{});
    return{ok:r.ok,reason:r.ok?'':String(r.detail||'').slice(0,200),response:String(r.detail||'')};
  };
}catch(e){}

/* IBNET 启动器: 已启用且填写了地址时, 页面就绪后自动建连(fail-open) */
try{
  (function(){
    var _ibNetBoot = function(){ try{ if(typeof IBNET !== 'undefined') IBNET.boot(); }catch(e){} };
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _ibNetBoot);
    else setTimeout(_ibNetBoot, 0);
  })();
}catch(e){}

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.ext 登记全部导出 ---- */
function ibExtLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.ibExtSay=ibExtSay;
window.ibExtReset=ibExtReset;
window.IB_MD=IB_MD;
window.IBMCP=IBMCP;
window.IBFC=IBFC;
window.IBWS=IBWS;
window.IBSandbox=IBSandbox;
window.IBDIY=IBDIY;
window.IBNET=IBNET;
NS.expose('ext', {
  ibExtSay: ibExtSay,
  ibExtReset: ibExtReset,
  IB_MD: IB_MD,
  IBMCP: IBMCP,
  IBFC: IBFC,
  IBWS: IBWS,
  IBSandbox: IBSandbox,
  IBDIY: IBDIY,
  IBNET: IBNET,
});
})(window.IB || (window.IB = {}));
