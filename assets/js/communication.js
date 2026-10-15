/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.chat 注册）。letters 域已提取到 communication/letters.js。 */
(function(NS){
/* BLOG COMMENTS */
async function loadBlogComments(postId){
  const container=document.getElementById('blog-comments-'+postId);
  if(!container)return;
  const all=await dbGetAll('blogComments');
  const comments=all.filter(c=>c.postId===postId).sort((a,b)=>b.created-a.created);
  if(!comments.length){container.innerHTML='<div style="font-size:0.78rem;color:var(--content-muted);padding:8px 0;opacity:0.7">还没有留言</div>';return}
  container.innerHTML=comments.map(c=>'<div class="blog-comment-card"><div class="blog-comment-from">'+esc(c.from||'AI')+'</div><div class="blog-comment-text">'+esc(c.content)+'</div><div class="blog-comment-time">'+new Date(c.created).toLocaleString('zh-CN')+'</div><div class="blog-comment-actions"><button class="btn" style="font-size:var(--fs-meta);padding:3px 8px" onclick="deleteBlogComment(\''+c.id+'\',\''+c.postId+'\')">删除</button></div></div>').join('');
}

async function requestBlogComment(postId){
  const sel=document.getElementById('blog-comment-select-'+postId);
  const aiId=sel?sel.value:'';
  if(!aiId){toast('Please chose one first');return}
  const cfg=apiConfigs.find(a=>a.id===aiId);
  if(!cfg||!_ibApiHasCredential(cfg)){toast('该 API 未配置密钥或本机端点');return}
  if(!cfg.endpoint){toast('该API未配置接口地址');return}
  const post=await dbGet('posts',postId);
  if(!post){toast('日志不存在');return}
  const about=await dbGet('about','main');

  const btn=document.getElementById('blog-comment-btn-'+postId);
  const oldText=btn.textContent;
  btn.disabled=true;btn.textContent='思考中…';

  const container=document.getElementById('blog-comments-'+postId);
  const loadingDiv=document.createElement('div');
  loadingDiv.className='blog-comment-loading';
  loadingDiv.id='blog-comment-loading';
  loadingDiv.innerHTML='<span class="letter-loading-spinner"></span>'+esc(cfg.nickname||'AI')+' 正在阅读并撰写留言…';
  container.insertBefore(loadingDiv,container.firstChild);

  /* P11-2I：本条路径的边界 trace 收尾闭包（不在裁定管线内，但会产生模型派生写入）。
     在 try 之前声明、在 catch 里兜底收尾 —— 见下方两处调用。 */
  let _bhFinish=function(){};
  try{
    let context='';
    if(cfg.relationship)context+='你和对方的关系是：'+cfg.relationship+'。\n';
    context+='你现在位于一个名为 Internal Beyond 的个人网站中。\n';
    if(about){
      context+='【用户信息，不是你的身份】\n昵称：'+about.name+'\n';
      if(about.bio)context+='简介：'+about.bio+'\n';
    }
    context+='\n【你正在阅读的日志】\n';
    context+='标题：'+(post.title||'无标题')+'\n';/* fix: 发给 API 的 prompt 不做 HTML 转义（同塔罗处已修的问题），否则 & < > 会变成实体 */
    if(post.subtitle)context+='副标题：'+post.subtitle+'\n';
    context+='发布日期：'+new Date(post.created).toLocaleDateString('zh-CN')+'\n';
    context+='正文：\n'+post.content+'\n';

    const existingComments=await dbGetAll('blogComments');
    const postComments=existingComments.filter(c=>c.postId===postId).sort((a,b)=>b.created-a.created).slice(0,3);
    if(postComments.length){
      context+='\n【这篇日志已有的留言（避免重复）】\n';
      postComments.forEach(c=>{context+=c.from+'：'+c.content.slice(0,80)+'…\n'});
    }
    /* 注入记忆 */
    const memCtx=await getMemoryContext(cfg.id,{maxChars:1000});
    if(memCtx)context+='\n'+memCtx;
    /* Auto Memory：留言也认识你——以本篇日志为语义种子；回复中的 mem 标签照常拦截执行 */
    let _amC={sys:'',tail:''};
    try{if(amEnabled(cfg)&&!cfg.amRecordOnly)_amC=await amBuildInject(cfg,(post.title||'')+'\n'+String(post.content||'').slice(0,600))}catch(e){}
    if(_amC.tail)context+='\n'+_amC.tail+'\n';

    context+='\n【请求】\n';
    context+='请针对这篇日志写一段留言/感想。可以评论内容、分享你的看法、给予共鸣或鼓励、提出有趣的问题。';
    context+='请使用该日志正文所使用的语言进行回复，风格自然，就像一个读者在博客下面留言一样。';
    context+='长度适中（200-400字）。不要与已有留言重复。直接写留言内容，不需要称呼或署名。';

    /* RCI-1：legacy callApi 接缝的调用身份 —— 与同一路径已登记的 MB 边界 trace 同名（'blog_comment'）。 */
    const response=await callApi(cfg,(_amC.sys?_amC.sys+'\n\n':'')+context,{_ibConsumer:'blog_comment'});
    const le=document.getElementById('blog-comment-loading');if(le)le.remove();

    let _cm={clean:String(response||''),ops:[]};
    try{_cm=_parseMemOps(String(response||''))}catch(e){}
    if(_cm.ops.length&&amEnabled(cfg)&&!cfg.amRecordOnly){
      /* P11-2I：这条路径不在裁定管线内（无 verdict），但它产生了模型派生的记忆
         写入。此前它在所有观测面上不可见 —— 现在记一条具名 trace，让"哪条路径
         在没有裁定的情况下写了记忆"成为可观测事实，而不是需要读代码才知道的事。 */
      _bhFinish=_mbBoundaryTrace('blog_comment',cfg,_cm.ops.length,'memory');
      let _bdone=0;
      try{_bdone=(await _execMemOps(_cm.ops,cfg,cfg.nickname||cfg.model||'AI')||[]).length}catch(e){}
      _bhFinish('completed',_bdone);
    }
    if(!_cm.clean||!_cm.clean.trim()){toast('AI 返回了空内容，未生成留言；请稍后重试');}
    else{
      const comment={id:'comment_'+Date.now(),postId:postId,from:cfg.nickname||cfg.model,content:_cm.clean,friendId:cfg.id,created:Date.now()};
      await dbPut('blogComments',comment);
      loadBlogComments(postId);
      toast('收到 '+(cfg.nickname||'AI')+' 的留言！');
    }
    _bhFinish('completed');
  }catch(e){
    const le=document.getElementById('blog-comment-loading');if(le)le.remove();
    /* P11-2I：异常路径同样收尾 —— 一次"开了记录却没进 ring"的 trace 等于没有 trace。
       中断原因只记**稳定枚举**，绝不记异常正文（那可能带 URL / key / 正文片段）。 */
    _bhFinish('aborted');
    let msg='请求失败';
    if(e.message){
      if(e.message.includes('Failed to fetch'))msg='无法连接到API服务器';
      else if(e.message.includes('401'))msg='API Key 无效';
      else if(e.message.includes('429'))msg='请求频率过高，请稍后再试';
      else msg=e.message;
    }
    toast(msg);
  }
  btn.disabled=false;btn.textContent=oldText;
}

async function deleteBlogComment(id,postId){if(confirm('确定删除？')){await dbDelete('blogComments',id);loadBlogComments(postId);toast('已删除')}}


/* ═══════ LLM 请求统一传输层（单点决定「直连 vs 本地 Bridge 代理」）═══════
   设计目标：
   · 双击 file://InternalBeyond.html 仍为合法运行方式；file:// 下 Origin 为
     null，多数 OpenAI-compatible API 不认该 Origin，会被 OPTIONS preflight 拦截。
   · 若本地 Bridge 可达，则把这些跨域请求交给 Bridge 服务端发起，绕开浏览器
     CORS；Bridge 不可达时逐请求回落到直连（保持原有行为与错误分类）。
   · 非 file://（http/https 承载）一律直连，不引入额外跳数与延迟。
   · 不改厂商协议 / 请求体，只统一注入此单点；Provider 的 Base URL / API Key /
     Model / streaming / headers / endpoint 配置全部原样透传。
   · 上游 API Key 经请求体交给 Bridge（仅本机 localhost），由 Bridge 转发到真实
     端点；Bridge 自身鉴权使用独立的 X-IB-Token 头，绝不与上游 API Key 混用。 */
function _ibProxyShouldRoute(url,o){
  try{
    if(typeof location==='undefined'||!location.protocol)return false;
    if(location.protocol!=='file:')return false;   /* http/https 承载保持直连 */
    if(o&&o._forceDirect)return false;             /* 显式豁免（调试 / 不需要） */
  }catch(e){return false}
  return true;
}
function _ibProxyBase(){
  try{ if(typeof window!=='undefined'&&window.__IB_DEV_MODE__===true)return window.ibBridgeBase?window.ibBridgeBase():''; }catch(e){return ''}
  try{ if(typeof window!=='undefined'&&window.__IB_DEV_MODE__===true&&window.ibBridgeBase)return window.ibBridgeBase(); }catch(e){}
  try{ if(typeof window!=='undefined'&&window.ibBridgeBase)return window.ibBridgeBase(); }catch(e){}
  try{ return String(localStorage.getItem('ib_bridge_http')||('http://127.0.0.1:'+String(window.__IB_BRIDGE_PORT__||23115))).replace(/\/+$/,''); }catch(e){}
  return 'http://127.0.0.1:' + String(window.__IB_BRIDGE_PORT__ || 23115);
}
function _ibProxyToken(){
  try{
    if(typeof window!=='undefined'&&window.__IB_DEV_MODE__===true)return '';
    if(typeof window!=='undefined'&&window.ibBridgeToken)return window.ibBridgeToken();
    if(typeof IBNET!=='undefined'&&typeof IBNET.cfg==='function')return String(IBNET.cfg().token||'').trim();
  }catch(e){}
  return '';
}
/* 唯一 LLM POST 入口：返回的 Response 在形状 / ok / status / body 上与「直连上游」
   完全等价（Bridge 会镜像上游状态码、content-type 与包体），因此调用方无需分辨来源。 */
async function _ibApiPost(url,headers,body,o){
  o=o||{};
  if(!_ibProxyShouldRoute(url,o))return fetch(url,{method:'POST',headers:headers,body:body,signal:o.signal});
  /* ── 经本地 Bridge：把上游 URL / 头 / 包体交给 Bridge，由它在服务端发起 ── */
  var base=_ibProxyBase();
  var bridgeHeaders={'Content-Type':'application/json'};
  var token=_ibProxyToken();
  if(token)bridgeHeaders['X-IB-Token']=token;
  if(typeof window!=='undefined'&&window.__IB_DEV_MODE__===true){
    var dev=window.__IB_DEV_SERVICE_CONFIG__;
    if(!dev||!dev.sessionToken||!dev.instanceId)throw new Error('dev-service-config-unavailable');
    bridgeHeaders['X-IB-Dev-Session']=String(dev.sessionToken);
    bridgeHeaders['X-IB-Dev-Instance']=String(dev.instanceId);
  }
  var bridgeReq={method:'POST',url:url,headers:headers,body:String(body||'')};
  try{
    return await fetch(base+'/api/llm-proxy',{
      method:'POST',headers:bridgeHeaders,body:JSON.stringify(bridgeReq),signal:o.signal
    });
  }catch(e){
    /* Bridge 不可达（连接被拒 / 网络错误）→ 回落直连，保留原行为与错误分类。
       HTTP 载体的非 2xx 代理响应不会走到这里（那是 Bridge 的合法答案）。 */
    return fetch(url,{method:'POST',headers:headers,body:body,signal:o.signal});
  }
}


/* API CALL HELPER
   provider → wire format 统一通过 canonical 决策取（唯一实现 = provider-directory.js）。
   P11-0：不再就地复制表达式，直接委托 window.PROVIDERS_DIR.providerFormat；
   window.PROVIDERS 只是它的兼容别名（social.js 暴露同一对象引用）。 */
function _providerFormat(cfg){
  try{
    var _dir=(typeof window!=='undefined')?window.PROVIDERS_DIR:null;
    if(_dir&&typeof _dir.providerFormat==='function')return _dir.providerFormat(cfg&&cfg.provider);
  }catch(e){}
  return (cfg&&PROVIDERS&&PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].format)||'openai';
}
/* P18 · model policy：该 model 是否接受 temperature / top_p / top_k。
   判定唯一实现 = provider-directory.js 的 MODEL_POLICIES；这里只委托。
   拿不到目录（旧宿主 / 目录加载失败）时返回 true = 照发，与 P18 之前逐位一致。
   只对已取证的 model id 生效；未知 id 不改变任何行为。 */
function _modelSupportsSampling(cfg){
  try{
    var _dir=(typeof window!=='undefined')?window.PROVIDERS_DIR:null;
    if(_dir&&typeof _dir.modelSupportsSamplingParameters==='function')return _dir.modelSupportsSamplingParameters(cfg&&cfg.model)!==false;
  }catch(e){}
  return true;
}
/* P20 · Anthropic wire 归一：唯一真源 = ib-model-core.js（Browser 与 Node 走同一函数）。
   本模块只转调，**禁止**在 communication.js 里再写第二份 system/messages 归一
   （P20 之前这里用 `_msgs.find(role==='system')` + filter 就地归一，与 Node 不一致）。
   核心缺失时明确报错（不静默降级成另一套语义）。 */
function _ibAnthropicWire(prompt){
  var core=(typeof window!=='undefined')?window.IBModelCore:null;
  if(!core||typeof core.normalizeAnthropicMessages!=='function'){
    throw new Error('Anthropic 请求归一不可用：IBModelCore.normalizeAnthropicMessages 未加载');
  }
  return core.normalizeAnthropicMessages(prompt);
}
/* P23 Phase 2A · canonical history → provider wire 归一的**桌面转调点**。
   实现唯一 = ib-model-core.js 的 normalizeWireRoles（Browser / Node 同一函数）；
   桌面侧的请求体是就地拼的（不经过 buildRequestBody），因此必须显式转调，
   绝不在这里写第二份"相邻同 role 怎么合并"的规则。
   Gemini 的 contents 要求 user/model 交替：一次回合交付多条 assistant 消息时
   （waifu 多段 / 工具续轮），数据库里的独立消息在这里被合并成一条 model 轮
   —— **只改 wire，不改数据库**。
   核心未加载时原样返回：那正是 P23 2A 之前的行为，不会因为归一层缺席而更难用。 */
function _ibWireMessages(list,format){
  try{
    var core=(typeof window!=='undefined')?window.IBModelCore:null;
    if(core&&typeof core.normalizeWireRoles==='function')return core.normalizeWireRoles(list,format);
  }catch(e){}
  return list;
}
/* P23 Phase 2A · conversation 的**确定性顺序**（实现唯一 = assets/js/delivery-sequence-core.js）。
   为什么每个读取点都必须走它：一次模型回合可以产出多条消息，它们共享同一个 timestamp
   （契约禁止用 +1ms 之类的时间差制造顺序）。只按 timestamp 排序时，"同毫秒"的先后
   由引擎/主键顺序决定，而且工具续轮的消息先落库、主回复落库更晚 —— 主回复会排到
   续轮**下面**（真实缺陷）。orderMessages 给出：回合内按 sequenceIndex 升序、回合整体
   落在它最早一条的位置；没有回合键的旧消息退化为 (timestamp, id)，与今天的取回顺序一致。
   核心未加载时原样返回（退回取回顺序，仍是确定性的，只是不含回合归组）。 */
function _ibOrderMessages(list){
  try{
    var core=(typeof window!=='undefined')?window.IBDeliverySequence:null;
    if(core&&typeof core.orderMessages==='function')return core.orderMessages(list);
  }catch(e){}
  return list;
}
function _ibCredentialUnavailable(){
  var error=new Error('CREDENTIAL_UNAVAILABLE');
  error.code='CREDENTIAL_UNAVAILABLE';
  return error;
}
function _ibCredentialIsLocalEndpoint(endpoint){
  try{
    var url=new URL(String(endpoint||'')),host=String(url.hostname||'').toLowerCase();
    return (url.protocol==='http:'||url.protocol==='https:')&&(host==='localhost'||host==='127.0.0.1'||host==='::1'||host==='[::1]');
  }catch(e){return false}
}
function _ibCredentialEndpointSafe(endpoint){
  var value=String(endpoint||'').trim();if(!value)return false;
  if(/(?:[?&])(?:api[_-]?key|key|token|secret|authorization|bearer|password|credential|signature|sig)=[^&#]+/i.test(value))return false;
  if(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/i.test(value))return false;
  try{var url=new URL(value);return (url.protocol==='http:'||url.protocol==='https:')&&!url.username&&!url.password&&!url.hash}
  catch(e){return false}
}
async function _ibWithRuntimeApiCredential(cfg,run,options){
  options=options||{};cfg=cfg&&typeof cfg==='object'?cfg:{};
  if(typeof run!=='function')throw _ibCredentialUnavailable();
  if(options.rejectImageGenSecret&&(String(cfg.imageGenApiKey||'').trim()||cfg._credentialImageSecretLegacy===true))throw _ibCredentialUnavailable();
  var requestCfg={};
  Object.keys(cfg).forEach(function(key){if(key!=='apiKey'&&key!=='imageGenApiKey')requestCfg[key]=cfg[key]});
  var resolverResponse=null,runtimeSecret='';
  var endpoint=options.endpoint||cfg.endpoint;
  try{
    if(!_ibCredentialEndpointSafe(endpoint))throw _ibCredentialUnavailable();
    if(_ibCredentialIsLocalEndpoint(endpoint)){
      requestCfg.apiKey='';
      return await run(requestCfg);
    }
    var hasCredentialRef=Object.prototype.hasOwnProperty.call(cfg,'credentialRef');
    var bindingId=hasCredentialRef?String(cfg.credentialRef||'').trim():String(cfg.id||'').trim();
    var host=typeof window!=='undefined'&&window.IB&&window.IB.host;
    var resolver=host&&host.credentialResolver;
    if(!bindingId||!resolver||typeof resolver.resolve!=='function'||resolver.available===false)throw _ibCredentialUnavailable();
    try{resolverResponse=await resolver.resolve(bindingId)}catch(e){throw _ibCredentialUnavailable()}
    if(!resolverResponse||resolverResponse.ok!==true||typeof resolverResponse.apiKey!=='string'||!resolverResponse.apiKey.trim())throw _ibCredentialUnavailable();
    var expectedProvider=String(options.expectedProvider||cfg.provider||'').trim().toLowerCase();
    var resolvedProvider=String(resolverResponse.provider||'').trim().toLowerCase();
    if(!resolvedProvider||(expectedProvider&&resolvedProvider!==expectedProvider))throw _ibCredentialUnavailable();
    runtimeSecret=resolverResponse.apiKey;
    requestCfg.apiKey=runtimeSecret;
    return await run(requestCfg);
  }finally{
    requestCfg.apiKey='';
    runtimeSecret='';
    if(resolverResponse&&typeof resolverResponse==='object')resolverResponse.apiKey='';
  }
}
if(typeof window!=='undefined')window._ibWithRuntimeApiCredential=_ibWithRuntimeApiCredential;

async function callApi(cfg,userMsg,opts){
  return _ibWithRuntimeApiCredential(cfg,function(runtimeCfg){return _callApiWithRuntimeCredential(runtimeCfg,userMsg,opts)});
}
async function _callApiWithRuntimeCredential(cfg,userMsg,opts){
  const format=_providerFormat(cfg);
  /* P21：同一条 canonical 思考深度（MB 未启用 → auto），翻译只发生在 request builder。
     RCI-1：本接缝与 callApiChat* 对称地接受调用方声明的**诊断身份**（opts._ibConsumer /
     _ibCharacterId / _ibThreadId）—— 它们只被 reasoning trace 读取，绝不进入 provider 请求体。
     不传 opts 的老调用方行为逐位不变（身份为空字符串，绝不抛错）。 */
  opts=opts||{};
  const _p21opts=Object.assign({},opts,{reasoningEffort:await _mbReasoningEffortForRequest()});
  let url=cfg.endpoint;
  let headers={'Content-Type':'application/json'};
  let body;
  if(format==='anthropic'){
    headers['x-api-key']=cfg.apiKey;
    headers['anthropic-version']='2023-06-01';
    headers['anthropic-dangerous-direct-browser-access']='true';
    _ccBeta(headers,cfg);
    /* P20：system 归一走 Core（顶层 system 与 messages 里的 system 合并去重） */
    const _an=_ibAnthropicWire({system:cfg.systemPrompt,messages:[{role:'user',content:userMsg}]});
    const ab={model:cfg.model,max_tokens:4096,messages:_an.messages.map(m=>({role:m.role,content:m.content}))};
    if(_an.system){if(cfg.promptCache!==false){ab.system=[{type:'text',text:_an.system,cache_control:_ccObj(cfg)}]}else{ab.system=_an.system}}
    if(cfg.temperature!=null&&_modelSupportsSampling(cfg))ab.temperature=cfg.temperature;
    _ibApplyReasoningEffort(ab,'anthropic',cfg,_p21opts,4096);/* P21：canonical 思考深度 → 能力翻译（auto/未取证 → 不写字段） */
    body=JSON.stringify(ab);
  }else if(format==='gemini'){
    url=url.replace('{model}',cfg.model)+'?key='+cfg.apiKey;
    const gb={contents:[{parts:[{text:(cfg.systemPrompt?cfg.systemPrompt+'\n\n':'')+userMsg}]}]};
    gb.generationConfig={maxOutputTokens:4096};
    if(cfg.temperature!=null)gb.generationConfig.temperature=cfg.temperature;
    _ibApplyReasoningEffort(gb,'gemini',cfg,_p21opts,4096);
    body=JSON.stringify(gb);
  }else{
    if(cfg.apiKey)headers['Authorization']='Bearer '+cfg.apiKey;
    const msgs=[];
    if(cfg.systemPrompt)msgs.push({role:'system',content:cfg.systemPrompt});
    msgs.push({role:'user',content:userMsg});
    const _ibMimo=_isMimoEndpoint(cfg);/* MiMo 契约：收 max_completion_tokens、拒 max_tokens/prompt_cache_key；与聊天通道共用同一判定，provider==='mimo' 或 endpoint 命中即生效 */
    const ob={model:cfg.model,messages:msgs};ob[_ibMimo?'max_completion_tokens':(_tokParamGet(cfg)||'max_tokens')]=4096;/* GPT-5 系要求 max_completion_tokens；参数名与聊天通道共用同一份会话记忆 */
    if(cfg.promptCache!==false&&!_ibMimo)ob.prompt_cache_key='ib_'+String(cfg.id||'');/* OpenAI 缓存本自动生效；此 key 只用于提升路由命中率。MiMo 无此字段，发出即 400 */
    if(cfg.temperature!=null)ob.temperature=cfg.temperature;
    _ibApplyReasoningEffort(ob,'openai',cfg,_p21opts,4096);
    body=JSON.stringify(ob);
  }
  const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),120000);
  try{
    let res;
    for(let _try=0;;_try++){
      res=await _ibApiPost(url,headers,body,{signal:ac.signal});
      if(res.ok)break;
      const _et=await res.text().catch(()=>'');
      /* GPT-5 系要求 max_completion_tokens：首次探测后记住（与聊天通道共用同一份记忆），本函数内立即换参数名重试一次 */
      if(_try===0&&format!=='anthropic'&&format!=='gemini'&&_errWantsCompletionParam({message:_et})){
        _tokParamRemember(cfg);
        try{const _ob2=JSON.parse(body);delete _ob2.max_tokens;_ob2.max_completion_tokens=4096;body=JSON.stringify(_ob2)}catch(e2){}
        continue;
      }
      throw new Error('API返回 '+res.status);
    }
    clearTimeout(tm);
    /* Detect HTML response (relay/proxy misconfiguration) */
    const ct=res.headers.get('content-type')||'';
    if(ct.includes('text/html')){throw new Error('API端点返回了网页而非JSON——请检查端点URL是否正确（当前格式: '+format+'）。如使用中转站，请确认API地址填写到完整路径（如 https://xxx.com/v1/chat/completions）')}
    const data=await res.json();
    try{
      _ibNoteReasoningUsage(format==='anthropic'?(data&&data.usage):(data&&data.usageMetadata),format,cfg,_p21opts);/* P21：实际 reasoning tokens 只读观测 */
      if(format==='anthropic'&&data.usage){_tkRecord(cfg,{i:data.usage.input_tokens||0,cr:data.usage.cache_read_input_tokens||0,cw:data.usage.cache_creation_input_tokens||0,o:data.usage.output_tokens||0})}
      else if(format==='gemini'&&data.usageMetadata){var _gu3=data.usageMetadata,_gc3=_gu3.cachedContentTokenCount||0;_tkRecord(cfg,{i:Math.max(0,(_gu3.promptTokenCount||0)-_gc3),cr:_gc3,cw:0,o:(_gu3.candidatesTokenCount||0)+(_gu3.thoughtsTokenCount||0)})}
      else if(data.usage){var _pu3=data.usage,_pc3=(_pu3.prompt_tokens_details&&_pu3.prompt_tokens_details.cached_tokens)||(_pu3.input_tokens_details&&_pu3.input_tokens_details.cached_tokens)||_pu3.prompt_cache_hit_tokens||0;_tkRecord(cfg,{i:Math.max(0,(_pu3.prompt_tokens||0)-_pc3),cr:_pc3,cw:0,o:_pu3.completion_tokens||0})}/* DeepSeek 用 prompt_cache_hit_tokens 回传命中量，此前只认 OpenAI 字段导致仪表盘恒显 0；input_tokens_details 为 Responses 形状兜底 */
    }catch(e){}
    if(format==='anthropic')return data.content?.[0]?.text||'';
    if(format==='gemini')return (data.candidates?.[0]?.content?.parts||[]).map(pp=>pp.text||'').join('')||'';
    /* OpenAI 系：content 可能是字符串或分段数组；正文为空时按 finish_reason 给出可读错误，
       避免"静默返空"——常见于服务商内容过滤（sensitive/content_filter），
       或思考型号把输出预算全部耗在思考上（finish_reason: length 且 reasoning_content 非空） */
    const _ch=data.choices?.[0]||{};
    let _txt=_ch.message?.content;
    if(Array.isArray(_txt))_txt=_txt.map(pp=>typeof pp==='string'?pp:(pp&&(pp.text||''))).join('');
    _txt=(_txt==null?'':String(_txt)).trim();
    if(!_txt){
      const _fr=_ch.finish_reason||'';
      if(/sensitive|content_filter/i.test(_fr))throw new Error('内容被该服务商的安全策略拦截（finish_reason: '+_fr+'），未生成正文；请调整措辞后重试');
      if(_fr==='length')throw new Error('输出上限耗尽而正文为空（finish_reason: length）'+(_ch.message?.reasoning_content?'——模型把输出预算用在了思考上':'')+'；请换用非思考型号，或联系服务商确认该模型的输出限制');
      throw new Error('API 返回了空内容'+(_fr?'（finish_reason: '+_fr+'）':'')+'，请稍后重试');
    }
    return _txt;
  }catch(e){clearTimeout(tm);if(e.name==='AbortError')throw new Error('请求超时（120秒），请检查网络连接或API服务状态');if(e.message&&e.message.includes('not valid JSON'))throw new Error('API端点返回了非JSON内容——请检查端点URL是否正确。如使用中转站，请确认地址填写到完整API路径');throw e}
}

async function initChatHeader(){
  try{
    await loadApiConfigs();
    if(apiConfigs.length>0){
      const cfg=apiConfigs[0];
      activeFriendId=cfg.id;
      document.getElementById('chat-header-name').textContent=cfg.nickname||cfg.model;
      document.getElementById('chat-mini-title').textContent=cfg.nickname||cfg.model;
    }
  }catch(e){}
}

/* 坞形态切换：缓缓沉降失焦淡出（0.42s）→ 不可见时瞬切布局 → 再 */
/* v40 — 坞形态骨架：现仅 solo（聊天面板）一处调用；日历小窗的坞联动已撤 */
function _ibDockSwap(apply){
  var d=document.getElementById('fab-dock');if(!d)return;
  clearTimeout(d._morphT);clearTimeout(d._morphT2);
  d.classList.remove('dock-swap-in');
  d.classList.add('dock-swap');
  d._morphT=setTimeout(function(){
    apply(d);
    d._morphTarget=null;
    void d.offsetWidth;/* 布局先落定，再开始淡入 */
    d.classList.add('dock-swap-in');
    d.classList.remove('dock-swap');
    d._morphT2=setTimeout(function(){d.classList.remove('dock-swap-in')},820);
  },420);
}
function _ibDockMorph(toSolo){
  var d=document.getElementById('fab-dock');if(!d)return;
  var cur=(d._morphTarget===true||d._morphTarget===false)?d._morphTarget:d.classList.contains('solo');
  if(cur===toSolo)return;
  d._morphTarget=toSolo;
  _ibDockSwap(function(dd){dd.classList.toggle('solo',toSolo)});
}
function openChatPanel(){
  const panel=document.getElementById('chat-panel');
  panel.style.left='';panel.style.top='';panel.style.right='24px';panel.style.bottom='';
  panel.classList.add('show');
  panel.classList.add('lifted');
  _ibDockMorph(true);
  if(activeFriendId)_clearUnread(activeFriendId);
  _updateUnreadUI();
  renderChatPanelFriends();
  loadChatMessages();
  try{if(activeFriendId&&window.IBExpressionPacks&&typeof window.IBExpressionPacks.applyChatGreeting==='function')window.IBExpressionPacks.applyChatGreeting(activeFriendId)}catch(expressionError){}
  document.getElementById('chat-input').focus();
  /* 打开迷你面板时也检查摘要 */
  if(activeFriendId)setTimeout(()=>autoSummaryOnOpen(activeFriendId,activeThreadId||null),300);
}
function closeChatPanel(){
  const panel=document.getElementById('chat-panel');
  panel.classList.remove('show');
  panel.classList.remove('lifted');
  panel.style.left='';panel.style.top='';panel.style.right='24px';panel.style.bottom='24px';
  var _fd=document.getElementById('fab-dock');if(_fd&&currentPage!=='chat')_fd.style.display='flex';
  _ibDockMorph(false);
  _updateUnreadUI();
}

/* ── Chat pagination helpers ── */
function _getApiAvatar(friendId){var fid=friendId||activeFriendId;var cfg=apiConfigs.find(a=>a.id===fid)||archivedConfigs.find(a=>a.id===fid);return cfg&&cfg.avatar?cfg.avatar:''}
function _getApiAvatarByName(senderName){if(!senderName)return '';var cfg=apiConfigs.find(a=>(a.nickname||a.model)===senderName)||archivedConfigs.find(a=>(a.nickname||a.model)===senderName);return cfg&&cfg.avatar?cfg.avatar:''}
function _messageApiConfig(m){
  if(!m)return null;
  const all=(apiConfigs||[]).concat(archivedConfigs||[]);
  /* P24-M2 · canonical 身份键优先（speakerId → config_id → friendId）；
     senderName 只作最后的 legacy 回退（显示与旧数据兼容），不再承担身份权威。 */
  const speakerId=m.metadata&&m.metadata.speakerId;
  if(speakerId){const bySpeaker=all.find(a=>a.id===speakerId);if(bySpeaker)return bySpeaker}
  const configId=m.metadata&&m.metadata.config_id;
  if(configId){const exact=all.find(a=>a.id===configId);if(exact)return exact}
  if(m.friendId&&!String(m.friendId).startsWith('group_')){
    const direct=all.find(a=>a.id===m.friendId);if(direct)return direct
  }
  if(m.senderName){
    const byName=all.find(a=>(a.nickname||a.model)===m.senderName);if(byName)return byName
  }
  return null
}
function _ibAddExpressionPromptHint(messages,roleId){
  var api=window.IBExpressionPacks;
  if(!Array.isArray(messages)||!api||typeof api.promptHint!=='function')return false;
  var hint='';try{hint=api.promptHint(String(roleId||''))}catch(e){hint=''}
  if(!hint)return false;
  var system=null;
  for(var i=0;i<messages.length;i++)if(messages[i]&&messages[i].role==='system'){system=messages[i];break}
  if(system)system.content=String(system.content||'')+'\n\n'+hint;
  else messages.unshift({role:'system',content:hint});
  return true;
}
function _ibParseExpressionReply(cfg,text){
  var core=window.IBExpressionPackCore;
  if(core&&typeof core.parseReplyExpressions==='function'){
    try{return core.parseReplyExpressions(String(text==null?'':text),cfg||null)}catch(e){}
  }
  var source=String(text==null?'':text),output='',cursor=0,prefix=/\[\[\s*expression\s*:/ig,match;
  while((match=prefix.exec(source))){
    var start=match.index,close=source.indexOf(']]',prefix.lastIndex),lineBreak=source.indexOf('\n',prefix.lastIndex);
    output+=source.slice(cursor,start);
    if(close<0||(lineBreak>=0&&lineBreak<close))cursor=lineBreak>=0?lineBreak+1:source.length;
    else cursor=close+2;
    prefix.lastIndex=cursor;
  }
  output+=source.slice(cursor);
  return {text:output,markers:[],expressionRef:null};
}
function _ibPrepareExpressionMessage(message,cfg,expressionRef){
  if(!message||message.role!=='assistant')return null;
  cfg=cfg||_messageApiConfig(message);
  var parsed=_ibParseExpressionReply(cfg,message.content);
  message.content=String(parsed.text||'');
  var api=window.IBExpressionPacks,roleId=String((cfg&&cfg.id)||(message.metadata&&(message.metadata.config_id||message.metadata.speakerId))||'');
  if(api&&roleId&&message.id){
    try{if(typeof api.rememberMessageText==='function')api.rememberMessageText(roleId,String(message.id),message.content)}catch(e){}
    var selected=expressionRef||parsed.expressionRef;
    try{if(selected&&typeof api.rememberMessageExpression==='function')api.rememberMessageExpression(roleId,String(message.id),selected)}catch(e){}
  }
  return parsed;
}
function _ibRememberExpressionRefs(messages,refs,cfg){
  if(!Array.isArray(messages)||!Array.isArray(refs)||!cfg||!window.IBExpressionPacks)return;
  messages.forEach(function(message,index){
    if(!message||!message.id)return;
    _ibPrepareExpressionMessage(message,cfg,refs[index]||null);
  });
}
/* D4.1-B presentation identity: use the canonical speaker/config id first; keep legacy
   senderName only as a compatibility fallback. This does not change stored message data. */
function _chatSpeakerKey(m){
  if(!m)return'';
  if(m.role==='user')return'_user_';
  const meta=m.metadata||{};
  const stable=meta.speakerId||meta.config_id;
  if(stable)return String(stable);
  const cfg=_messageApiConfig(m);
  if(cfg&&cfg.id)return String(cfg.id);
  return String(m.senderName||m.friendId||'');
}
function _chatAppendReplyQuoteCard(message,sources,bubble){
  const Q=window.IBMessageQuoteCore;
  const ref=message&&message.metadata&&message.metadata.replyQuote;
  if(!Q||!ref||!bubble||typeof Q.resolveReference!=='function')return null;
  const opts={friendId:String(message.friendId||''),threadId:String(message.threadId||(message.metadata&&message.metadata.threadId)||''),
    replySenderKey:Q.senderKey(message),userName:_cachedUserName||'You'};
  const resolved=Q.resolveReference(ref,sources,message,opts);
  const card=document.createElement('button');
  card.type='button';card.className='ib-reply-quote-card';
  card.dataset.sourceMessageId=String(ref.sourceMessageId||'');
  card.setAttribute('aria-label',resolved.ok?'定位到 '+String(resolved.senderName||'原发送者')+' 的原消息':'引用的原消息已不可用');
  const sender=document.createElement('span');sender.className='ib-reply-quote-card__sender';
  const excerpt=document.createElement('span');excerpt.className='ib-reply-quote-card__text';
  if(resolved.ok){
    sender.textContent=String(resolved.senderName||'原发送者');
    const value=String(resolved.snippet||'');excerpt.textContent=value.length>220?value.slice(0,220)+'…':value;
    card.addEventListener('click',function(){_chatJumpToQuotedMessage(ref.sourceMessageId,bubble)});
  }else{
    card.disabled=true;card.classList.add('is-unavailable');
    sender.textContent='原消息不可用';excerpt.textContent='已删除、撤回或无法通过引用校验';
  }
  card.appendChild(sender);card.appendChild(excerpt);
  const text=bubble.querySelector&&bubble.querySelector('.r-text');
  if(text&&text.parentNode===bubble)bubble.insertBefore(card,text);else bubble.insertBefore(card,bubble.firstChild);
  return card;
}
function _chatJumpToQuotedMessage(messageId,bubble){
  const host=bubble&&bubble.closest?bubble.closest('#chat-full-messages, #chat-messages'):null;
  if(!host)return false;
  const state=host._ibWin;
  if(state&&Array.isArray(state.msgs)){
    let index=-1;
    for(let i=0;i<state.msgs.length;i++)if(String(state.msgs[i]&&state.msgs[i].id||'')===String(messageId)){index=i;break}
    if(index<0)return false;
    while(state.start>index&&!state.loading)_chatWinMore(host,state);
  }
  const rows=host.querySelectorAll('.chat-msg[data-msg-id]');
  let target=null;
  for(let i=0;i<rows.length;i++)if(String(rows[i].dataset.msgId||'')===String(messageId)){target=rows[i];break}
  if(!target)return false;
  try{target.scrollIntoView({behavior:'smooth',block:'center'})}catch(e){target.scrollIntoView()}
  target.classList.add('ib-reply-quote-target');
  setTimeout(function(){try{target.classList.remove('ib-reply-quote-target')}catch(e){}},1800);
  return true;
}
function _chatRefreshReplyQuotesForTarget(messageId){
  try{
    document.querySelectorAll('.ib-reply-quote-card[data-source-message-id]').forEach(function(card){
      if(String(card.dataset.sourceMessageId||'')!==String(messageId))return;
      card.disabled=true;card.classList.add('is-unavailable');
      const sender=card.querySelector('.ib-reply-quote-card__sender');
      const excerpt=card.querySelector('.ib-reply-quote-card__text');
      if(sender)sender.textContent='原消息不可用';
      if(excerpt)excerpt.textContent='已删除、撤回或无法通过引用校验';
      card.setAttribute('aria-label','引用的原消息已不可用');
    });
  }catch(e){}
}
function _messageShowThinking(m){
  const cfg=_messageApiConfig(m);
  if(cfg)return _resolveShowThinking(cfg);
  if(m&&m.metadata&&typeof m.metadata.showThinking==='boolean')return m.metadata.showThinking;
  return _resolveShowThinking({provider:m&&m.metadata&&m.metadata.model,model:m&&m.metadata&&m.metadata.model_id})
}
var _chatThinkingDisclosureSequence=0;
function _buildChatThinkingEl(text,compact,expanded){
  const wrap=document.createElement('div');wrap.className='chat-thinking-wrap'+(expanded?' expanded':'');
  if(!compact)wrap.classList.add('ib-primitives');
  if(compact)wrap.style.cssText='max-width:100%;margin:0 0 4px 0';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='chat-thinking-toggle'+(expanded?' open':'');
  if(!compact){toggle.classList.add('btn');toggle.dataset.variant='text'}
  toggle.setAttribute('aria-controls','chat-thinking-body-'+(++_chatThinkingDisclosureSequence));
  toggle.setAttribute('aria-expanded',expanded?'true':'false');
  const arrow=document.createElement('span');arrow.className='think-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='▸';
  const label=document.createElement('span');label.className='think-label';label.textContent='思考过程';
  toggle.appendChild(arrow);toggle.appendChild(label);
  wrap.appendChild(toggle);
  const body=document.createElement('div');body.id=toggle.getAttribute('aria-controls');body.className='chat-thinking-body';body.style.whiteSpace='pre-wrap';body.textContent=text||'';
  toggle.addEventListener('click',function(){
    const open=toggle.getAttribute('aria-expanded')==='true';
    toggle.setAttribute('aria-expanded',open?'false':'true');
    wrap.classList.toggle('expanded',!open);toggle.classList.toggle('open',!open);
  });
  wrap.appendChild(body);
  return {wrap,toggle,body}
}
function _ensureStreamThinking(refs,registry){
  if(registry.length)return;
  refs.forEach(function(ref){
    const el=_buildChatThinkingEl('',!ref.full,true);
    let anchor=ref.div;
    while(anchor.previousElementSibling&&(anchor.previousElementSibling.classList.contains('chat-msg-header')||anchor.previousElementSibling.classList.contains('chat-msg-cont-time')||anchor.previousElementSibling.classList.contains('chat-thinking-wrap'))){anchor=anchor.previousElementSibling}
    ref.container.insertBefore(el.wrap,anchor);
    registry.push(el)
  })
}
function _appendStreamThinking(refs,registry,text){
  if(!text)return;_ensureStreamThinking(refs,registry);registry.forEach(e=>{e.body.textContent+=text})
}
function _finishStreamThinking(registry,text){
  registry.forEach(function(e){if(text!=null)e.body.textContent=text;e.wrap.classList.remove('expanded');e.toggle.classList.remove('open');e.toggle.setAttribute('aria-expanded','false');e.body.classList.remove('chat-stream-cursor')})
}
function _buildAvatarCircle(name,src,size){
  var d=document.createElement('div');d.className='chat-msg-avatar';
  if(size){d.style.width=size+'px';d.style.height=size+'px';d.style.fontSize=(size*0.4)+'px'}
  if(src){var img=document.createElement('img');img.src=src;img.alt='';d.appendChild(img)}
  else{d.textContent=(name||'?').charAt(0).toUpperCase()}
  return d;
}
/* ── P23 Phase 1 · assistant 一级 voice message 渲染分支 ──────────────
   voice 载荷存在且**有可播放音源**时，气泡取代整段文字稿（默认不重复显示文字）。
   文字稿仍是消息自己的数据：保留在 content 与 voice.transcript 里，
   由气泡上的「文」按钮展开 —— context / Memory / 搜索 / 导出 / 无障碍全部不受影响。
   撤回（withdrawn）与无可播放音源的记录一律回落为普通文本，绝不伪装成可播放。 */
function _ibAiVoicePayload(m){
  if(!m||m.role==='user'||m.withdrawn)return null;
  try{ if(window.IBVoiceMessage&&IBVoiceMessage.isAiVoiceMessage(m))return m.voice }catch(e){}
  return null;
}
function _renderAiVoice(host,m){
  host.appendChild(_buildVoiceEl(m.voice,{transcriptToggle:true}));
}
function _buildMsgEl(m,isFullscreen,isGroupCont,quoteSources){
  /* content 与 reasoning_content 始终分流；展示与否只由该消息对应模型的 showThinking 决定。 */
  const frag=document.createDocumentFragment();
  const isUser=m.role==='user';
  /* 系统事件消息：简短居中文本，不影响角色对话上下文 */
  if(m.role==='system'){
    const div=document.createElement('div');
    div.className='chat-msg system';
    div.textContent=m.content||'';
    if(m.id)div.dataset.msgId=m.id;
    frag.appendChild(div);
    return frag;
  }
  const _parts=isUser?{content:m.content||'',reasoning_content:''}:_assistantResponseParts(m.content||'',m.reasoning_content||m.thinking||'');
  const _displayContent=_parts.content;
  if(!isUser&&_parts.reasoning_content&&_messageShowThinking(m))frag.appendChild(_buildChatThinkingEl(_parts.reasoning_content,!isFullscreen,false).wrap);
  const div=document.createElement('div');
  div.className='chat-msg '+(isUser?'user':'ai');
  if(m.id)div.dataset.msgId=m.id;
  if(isFullscreen){div.dataset.senderRole=isUser?'user':'ai';div.dataset.senderId=_chatSpeakerKey(m)}
  if(isFullscreen){
    const sName=isUser?(_cachedUserName||'You'):(m.senderName||_getActiveAiName()||'AI');
    const timeStr=m.timestamp?new Date(m.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';
    /* Determine if this sender uses the new avatar layout */
    const aiAvatar=!isUser?(_getApiAvatar(m.friendId)||_getApiAvatarByName(m.senderName)):'';
    const userAvatar=isUser?_cachedUserAvatar:'';
    const useAvatarLayout=isUser||!!aiAvatar;
    if(useAvatarLayout){
      /* ── New grouped avatar layout ── */
      div.classList.add('chat-msg-avatared');
      if(!isGroupCont){
        /* Build header row: avatar + name + time
           用户侧 .align-right 是 row-reverse 布局，DOM 顺序会被镜像：
           想让视觉上"昵称在前、时间在后（贴近头像）"，须把时间插在头像与昵称之间 */
        const hdr=document.createElement('div');
        hdr.className='chat-msg-header '+(isUser?'align-right':'align-left');
        hdr.appendChild(_buildAvatarCircle(sName,isUser?userAvatar:aiAvatar));
        const nm=document.createElement('span');nm.className='r-head-name';nm.textContent=sName;
        if(isUser&&timeStr){const tm=document.createElement('span');tm.className='r-time';tm.textContent=timeStr;hdr.appendChild(tm);hdr.appendChild(nm)}
        else{hdr.appendChild(nm);if(timeStr){const tm=document.createElement('span');tm.className='r-time';tm.textContent=timeStr;hdr.appendChild(tm)}}
        frag.appendChild(hdr);
      }else if(timeStr){
        /* Continuation: show subtle inline timestamp */
        const ct=document.createElement('div');ct.className='chat-msg-cont-time';
        ct.style.textAlign=isUser?'right':'left';
        if(isUser)ct.style.marginRight='46px'; else ct.style.marginLeft='46px';
        ct.textContent=timeStr;frag.appendChild(ct);
      }
      const txt=document.createElement('div');txt.className='r-text';
      if(!isUser){const _avm=_ibAiVoicePayload(m);if(_avm)_renderAiVoice(txt,m);else _renderAiContent(txt,div,_displayContent);if(m.truncated)txt.appendChild(_buildContinuePill(m.id))}else if(m.voice){if(m.content)txt.appendChild(document.createTextNode(m.content));txt.appendChild(_buildVoiceEl(m.voice))}else{txt.textContent=m.content}
      div.appendChild(txt);
    }else{
      /* ── Original layout for AI without avatar ── */
      if(!isGroupCont){
        const head=document.createElement('div');head.className='r-head';
        head.innerHTML=esc(sName)+(timeStr?'<span class="r-time">'+timeStr+'</span>':'');
        div.appendChild(head);
      }else if(timeStr){
        const ct=document.createElement('div');ct.className='chat-msg-cont-time align-left';ct.textContent=timeStr;frag.appendChild(ct);
      }
      const txt=document.createElement('div');txt.className='r-text';
      if(!isUser){const _avm=_ibAiVoicePayload(m);if(_avm)_renderAiVoice(txt,m);else _renderAiContent(txt,div,_displayContent);if(m.truncated)txt.appendChild(_buildContinuePill(m.id))}else if(m.voice){if(m.content)txt.appendChild(document.createTextNode(m.content));txt.appendChild(_buildVoiceEl(m.voice))}else{txt.textContent=m.content}
      div.appendChild(txt);
    }
    if(m.files&&m.files.length)m.files.forEach(function(f){div.appendChild(_buildFileCard(f))});
    if(m.images&&m.images.length)m.images.forEach(function(img){var el=document.createElement('img');el.className='chat-bubble-img';el.loading='lazy';el.decoding='async';el.src=img.dataUrl;el.alt=img.name||'image';el.onclick=function(){_viewImageFull(img.dataUrl,img)};div.appendChild(el)});
    if(m.wsSearches||m.memOps)_amAppendExtraCards(div,m.wsSearches||[],m.memOps||[]);
    if(m.calNotes&&window.IBCAL)try{m.calNotes.forEach(function(r){div.appendChild(IBCAL.noteCard(r))})}catch(e){}
    _mbAppendNoticeCard(div,m);/* P11-2E · 历史重载：提示随消息持久化，回看同样看得见 */
    try{if(!isUser&&m.id&&window.IBExpressionPacks&&typeof window.IBExpressionPacks.decorateMessage==='function'){var _expressionCfg=_messageApiConfig(m);if(_expressionCfg)window.IBExpressionPacks.decorateMessage(_expressionCfg.id,m.id,div,{text:getTextContent(m)})}}catch(_expressionError){}
    if(m.id)_chatAppendMessageActions(m,div,isFullscreen);
  }else{
    /* Classic panel uses the same per-model showThinking decision as fullscreen. */
    if(!isUser&&m.senderName){
      var _pm=_mdMode();if(_pm==='full'||_pm==='partial')div.classList.add('md-rendered');
      const label=document.createElement('span');
      label.style.cssText='font-size:var(--fs-meta);opacity:0.7;display:block;margin-bottom:2px';
      label.textContent=m.senderName;
      div.appendChild(label);
      const _avm1=_ibAiVoicePayload(m);
      if(_avm1)_renderAiVoice(div,m);else _renderSegments(_panelMdHost(div),_displayContent);
    }else if(!isUser){
      var _pm2=_mdMode();if(_pm2==='full'||_pm2==='partial')div.classList.add('md-rendered');
      const _avm2=_ibAiVoicePayload(m);
      if(_avm2)_renderAiVoice(div,m);else _renderSegments(_panelMdHost(div),_displayContent);
    }else if(m.voice){
      if(m.content)div.appendChild(document.createTextNode(m.content));
      div.appendChild(_buildVoiceEl(m.voice));
    }else{
      div.textContent=m.content;
    }
    if(m.files&&m.files.length)m.files.forEach(function(f){div.appendChild(_buildFileCard(f))});
    if(m.images&&m.images.length)m.images.forEach(function(img){var el=document.createElement('img');el.className='chat-bubble-img';el.loading='lazy';el.decoding='async';el.src=img.dataUrl;el.alt=img.name||'image';el.style.maxWidth='180px';el.onclick=function(){_viewImageFull(img.dataUrl,img)};div.appendChild(el)});
    if(m.wsSearches||m.memOps)_amAppendExtraCards(div,m.wsSearches||[],m.memOps||[]);
    if(m.calNotes&&window.IBCAL)try{m.calNotes.forEach(function(r){div.appendChild(IBCAL.noteCard(r))})}catch(e){}
    _mbAppendNoticeCard(div,m);/* P11-2E · 小窗历史：与全屏同款 */
    try{if(!isUser&&m.id&&window.IBExpressionPacks&&typeof window.IBExpressionPacks.decorateMessage==='function'){var _panelExpressionCfg=_messageApiConfig(m);if(_panelExpressionCfg)window.IBExpressionPacks.decorateMessage(_panelExpressionCfg.id,m.id,div,{text:getTextContent(m)})}}catch(_panelExpressionError){}
    if(m.id)_chatAppendMessageActions(m,div,isFullscreen);
  }
  _chatAppendReplyQuoteCard(m,quoteSources,div);
  frag.appendChild(div);
  return frag;
}
var _cachedUserName='';
var _cachedUserAvatar='';
function _refreshCachedUserName(){dbGet('about','main').then(a=>{if(a&&a.name)_cachedUserName=a.name;_cachedUserAvatar=(a&&a.avatar)||'';updateNavUserIdentity(a)}).catch(()=>{})}
async function updateNavUserIdentity(data){
  try{
    if(!data)data=await dbGet('about','main');
    const nameEl=document.getElementById('nav-user-name');
    const avatarEl=document.getElementById('nav-user-avatar');
    if(!nameEl||!avatarEl)return;
    const name=(data&&data.name)?data.name:'';
    nameEl.textContent=name;
    if(data&&data.avatar){
      avatarEl.innerHTML='<img src="'+data.avatar+'" alt="">';
    }else{
      const initials=name?name.charAt(0).toUpperCase():'';
      avatarEl.innerHTML='';
      avatarEl.textContent=initials;
    }
    /* Hide if no name set or user chose to hide */
    const idEl=document.getElementById('nav-user-id');
    const showInNav=data&&data.showInNav!==undefined?data.showInNav:true;
    if(idEl)idEl.style.display=(name&&showInNav)?'':'none';
  }catch(e){}
}
function _getActiveAiName(){const c=apiConfigs.find(a=>a.id===activeFriendId)||archivedConfigs.find(a=>a.id===activeFriendId);return c?(c.nickname||c.model):'AI'}
/* ── 消息窗口渲染 ──
   打开对话仅渲染最近 _CHAT_WIN 条并钉在底部；滚动到顶端时向上补一批（每批 _CHAT_WIN 条），
   用补载前后的滚动高度差回补 scrollTop，视野停留在原消息处不跳动。
   仅改动显示层：发送给 API 的历史由各发送函数独立从数据库读取，不受此窗口影响。 */
var _CHAT_WIN=50;
function _chatWinMsgEl(msgs,i,isFullscreen,noCont){
  var m=msgs[i],prev=(noCont||i<=0)?null:msgs[i-1];
  var isCont=prev&&prev.role===m.role&&_chatSpeakerKey(prev)===_chatSpeakerKey(m);
  return _buildMsgEl(m,isFullscreen,isCont,msgs);
}
function _renderAllChat(container,msgs,isFullscreen){
  container.innerHTML='';
  var start=Math.max(0,msgs.length-_CHAT_WIN);
  var top=document.createElement('div');
  top.className='chat-msg system chat-win-top';/* 复用系统提示行样式，颜色随主题联动，与"与 xx 的对话"分隔行一致 */
  top.textContent='上滑加载更早消息';
  top.style.cssText='user-select:none'+(start>0?'':';display:none');
  container.appendChild(top);
  var st={msgs:msgs,start:start,isFullscreen:isFullscreen,top:top,stick:true,loading:false};
  container._ibWin=st;
  var frag=document.createDocumentFragment();
  for(var i=start;i<msgs.length;i++)frag.appendChild(_chatWinMsgEl(msgs,i,isFullscreen,i===start));
  container.appendChild(frag);
  _chatWinBind(container);
  _chatWinPin(container,st);
  /* 封档线：渲染完成后注入视觉分隔符 */
  _injectSealDivider(container,msgs);
}
/* 打开时钉底：同步钉一次，下一帧再钉一次；消息内图片为异步加载，
   图片到达后若用户仍停留在底部（stick）则按新高度再次钉底。
   原先只钉一次，晚到的图片会把内容顶高、视野停在中段。 */
function _chatWinPin(container,st){
  container.scrollTop=container.scrollHeight;
  requestAnimationFrame(function(){
    if(container._ibWin!==st)return;
    /* A user may move away from the bottom before this render-frame correction runs.
       Honor the scroll listener's stick flag so this deferred pin cannot undo a manual
       position or the upward-history anchor. */
    if(!st.stick)return;
    /* 消息不足一屏且仍有更早消息时不产生滚动条，主动补足到可滚动或补完为止 */
    var guard=0;
    while(st.start>0&&container.scrollHeight<=container.clientHeight&&guard++<20)_chatWinMore(container,st);
    container.scrollTop=container.scrollHeight;
  });
  container.querySelectorAll('img').forEach(function(im){
    if(im.complete)return;
    var pin=function(){if(container._ibWin===st&&st.stick)container.scrollTop=container.scrollHeight};
    im.addEventListener('load',pin,{once:true});
    im.addEventListener('error',pin,{once:true});
  });
}
function _chatWinBind(container){
  if(container._ibWinBound)return;
  container._ibWinBound=true;
  container.addEventListener('scroll',function(){
    var st=container._ibWin;
    if(!st)return;
    if(!st.top.isConnected){container._ibWin=null;return}/* 容器已被其他视图（按日查看、空状态等）整体重写，窗口状态作废 */
    st.stick=(container.scrollHeight-container.scrollTop-container.clientHeight)<40;
    if(st.start>0&&container.scrollTop<=40)_chatWinMore(container,st);
  });
}
function _chatWinMore(container,st){
  if(st.loading||st.start<=0)return;
  st.loading=true;
  var prevH=container.scrollHeight,prevTop=container.scrollTop;
  var oldStart=st.start,newStart=Math.max(0,oldStart-_CHAT_WIN);
  var frag=document.createDocumentFragment();
  for(var i=newStart;i<oldStart;i++)frag.appendChild(_chatWinMsgEl(st.msgs,i,st.isFullscreen,i===newStart));
  var prevAnchor=container.style.overflowAnchor;
  container.style.overflowAnchor='none';/* 补载期间关闭浏览器自动滚动锚定，避免与下方手动回补叠加成双重偏移 */
  container.insertBefore(frag,st.top.nextSibling);
  st.start=newStart;
  if(newStart<=0)st.top.style.display='none';
  container.scrollTop=prevTop+(container.scrollHeight-prevH);
  container.style.overflowAnchor=prevAnchor;
  /* 多选模式下补载的消息同步补挂选择圆圈（绝对定位，不改变消息高度） */
  if(container.classList.contains('chat-select-mode'))container.querySelectorAll('.chat-msg[data-msg-id]').forEach(function(el){
    if(!el.querySelector('.chat-sel-circle')){
      var c=_chatCreateSelectionControl(el.dataset.msgId);
      if(c)el.appendChild(c);
    }
  });
  /* 封档线：补载后重新定位分隔线（旧 divider 位置可能已不准确） */
  _injectSealDivider(container,st.msgs);
  st.loading=false;
}
/* 迷你面板全量渲染 */
function _renderPanelList(container,msgs,mapFn,viewKey,emptyHTML){
  if(!msgs.length){container.innerHTML=emptyHTML||'<div class="chat-msg system">发送消息开始对话</div>';return}
  container.innerHTML=msgs.map(mapFn).join('');
  container.scrollTop=container.scrollHeight;
}

async function loadChatMessages(){
  const container=document.getElementById('chat-messages');
  try{
    const filtered=activeFriendId?(await dbGetByIndex('chatMessages','byFriend',activeFriendId)):(await dbGetAll('chatMessages'));
    const _ordered=_ibOrderMessages(filtered);
    if(_ordered.length===0){
      container.innerHTML='<div class="chat-msg system">发送消息开始对话</div>';
      _ibDeliveryTypingReassert();/* P23 2B：回到仍在交付中的会话时把 typing 重新画出来 */
      return;
    }
    _renderAllChat(container,_ordered,false);
    _ibDeliveryTypingReassert();
  }catch(e){
    container.replaceChildren();
    var model=window.IBERR&&typeof window.IBERR.report==='function'?window.IBERR.report(e,{friendId:activeFriendId,stage:'chat_history'}).model:null;
    if(model){model.title='无法加载对话记录';model.message='这段历史记录暂时无法显示。';model.suggestion='可以重试读取；不会发送新消息。';model.action=null}
    _chatAppendErrorDisclosure(container,model,{scope:'history',stage:'chat_history',title:'无法加载对话记录',
      message:'这段历史记录暂时无法显示。',suggestion:'可以重试读取；不会发送新消息。',recoveryLabel:'重试读取',
      onRecover:function(){return loadChatMessages()}});
  }
}

/* ── IMAGE ATTACHMENT SYSTEM ────────────────────────── */
let _pendingImages=[];
let _pendingFiles=[];
const IMG_MAX_PX=2048,IMG_QUALITY=0.92,IMG_MAX_COUNT=6,IMG_MAX_BYTES=20*1024*1024;/* 压缩前原图上限 20MB；发送前会统一压缩到 2048px */
/* 发给 API 的上传文件正文：每个文件最多注入 60 万字符（≈8万+ token），超出部分截断并注明。
   本地保存的原文不受影响，只限制"塞进对话上下文"的量，防止单个巨型文件直接把请求撑爆。 */
const FILE_INJECT_DEFAULT=1000000;/* 单文件注入上限默认 100 万字符；DIY 页「文件解析库」卡可调（10万–300万），聊天附件与 ws_read 共用 */
function _ibInjectMax(){var v=0;try{v=parseInt(localStorage.getItem('ib_injectMax')||'',10)||0}catch(e){}if(!v)v=FILE_INJECT_DEFAULT;return Math.min(3000000,Math.max(100000,v))}
function _capFileText(t){t=t||'';var MAX=_ibInjectMax();return t.length<=MAX?t:t.slice(0,MAX)+'\n[…文件过长，已截断至前 '+MAX+' 字符（原文共 '+t.length+' 字符）。如需处理后续部分，请告知用户分段发送]'}

var _attachCloseHandler=null;
function toggleAttachPopup(btn){
  const popup=btn.querySelector('.chat-attach-popup');
  if(!popup)return;
  const wasOpen=popup.classList.contains('show');
  document.querySelectorAll('.chat-attach-popup.show').forEach(p=>p.classList.remove('show'));
  if(_attachCloseHandler){document.removeEventListener('pointerdown',_attachCloseHandler);_attachCloseHandler=null}
  if(!wasOpen){
    popup.classList.add('show');
    requestAnimationFrame(()=>{
      _attachCloseHandler=function(e){
        if(!popup.contains(e.target)&&!btn.contains(e.target)){
          popup.classList.remove('show');
          document.removeEventListener('pointerdown',_attachCloseHandler);
          _attachCloseHandler=null;
        }
      };
      document.addEventListener('pointerdown',_attachCloseHandler);
    });
  }
}

function pickImage(panel){
  document.querySelectorAll('.chat-attach-popup.show').forEach(p=>p.classList.remove('show'));
  const inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.multiple=true;
  inp.onchange=async function(){
    const selected=Array.from(inp.files||[]);
    const remaining=Math.max(0,IMG_MAX_COUNT-_pendingImages.length);
    const files=selected.slice(0,remaining);
    const errors=[];
    if(selected.length>remaining)errors.push('最多附加'+IMG_MAX_COUNT+'张图片。');
    for(const f of files){
      if(!f.type.startsWith('image/')){errors.push('仅支持图片文件。');continue}
      if(f.size>IMG_MAX_BYTES){errors.push('图片超过'+Math.round(IMG_MAX_BYTES/1024/1024)+'MB 限制。');continue}
      try{const compressed=await compressImage(f);_pendingImages.push(compressed);renderImagePreviews()}catch(e){errors.push('图片读取失败，请重新选择。')}
    }
    if(errors.length)_chatSetComposerFeedback(panel,errors.join(' '));
    else if(files.length)_chatSetComposerFeedback(panel,'');
  };inp.click()
}

function compressImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=function(){
      const img=new Image();
      img.onload=function(){
        let w=img.width,h=img.height;
        if(w>IMG_MAX_PX||h>IMG_MAX_PX){
          const ratio=Math.min(IMG_MAX_PX/w,IMG_MAX_PX/h);
          w=Math.round(w*ratio);h=Math.round(h*ratio)
        }
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,w,h);
        const dataUrl=canvas.toDataURL('image/jpeg',IMG_QUALITY);
        const base64=dataUrl.split(',')[1];
        resolve({dataUrl:dataUrl,base64:base64,mime:'image/jpeg',name:file.name||'image.jpg',size:Math.round(base64.length*0.75)})
      };
      img.onerror=reject;
      img.src=reader.result
    };
    reader.onerror=reject;
    reader.readAsDataURL(file)
  })
}

/* DeepSeek 普通文本模型没有原生图片输入：图片先由本地 Qwen2.5-VL 识别，
   再把描述文本交给角色的 DeepSeek 请求。
   例外：模型名精确为 deepseek-v4-flash-vision-exp 时，图片直接随消息发送给
   DeepSeek（OpenAI image_url 格式），由模型完成视觉理解与推理。 */
const DEEPSEEK_NATIVE_VISION_MODEL='deepseek-v4-flash-vision-exp';
function _isDeepSeekNativeVisionModel(model){
  return String((model==null?'':model)).trim().toLowerCase()===DEEPSEEK_NATIVE_VISION_MODEL;
}
function _usesNativeDeepSeekVision(cfg){
  return !!(cfg&&_isDeepSeekNativeVisionModel(cfg.model));
}
/* MiMo 判定（provider 感知 + endpoint 兜底双保险）：api.xiaomimimo.com 的 chat-completions 契约较窄 ——
   只接受 max_completion_tokens（不接受 max_tokens），且不定义 prompt_cache_key / stream_options。
   通用 OpenAI 分支默认发送这三个字段，会在 MiMo 上触发 400，故做特化：
   强制用 max_completion_tokens，并省略两个非官方字段（MiMo 缓存由服务端自动生效，响应仍回传 cached_tokens）。
   provider==='mimo' 为新增官方预设走法；保留 endpoint 嗅探以兼容未迁移的 custom 角色。 */
function _isMimoEndpoint(cfg){
  return !!(cfg&&(String(cfg.provider||'').toLowerCase()==='mimo'||/xiaomimimo\.com/i.test(String(cfg.endpoint||''))));
}
function _mimoTokenKey(cfg,opts){
  return _isMimoEndpoint(cfg)?'max_completion_tokens':(opts&&opts.tokenParam||'max_tokens');
}
/* 视觉能力判定（权威版）：默认放行（多模态普遍）；cfg.vision 显式关闭才拒绝；DeepSeek 文本模型仍算"可描述" */
function _ibModelCanSee(cfg){
  try{
    if(!cfg)return false;
    return !!( _usesLocalDeepSeekVision(cfg)||_usesNativeDeepSeekVision(cfg)||(cfg.vision!==undefined?!!cfg.vision:true) );
  }catch(e){return true}
}
/* 视觉能力声明（注入 system）：模型不再自我推断"我不支持/我是文本模型" */
const _VISION_DECLARE='\n\n【视觉能力】当前模型支持视觉多模态：你可以（也应当）直接查看用户发送的图片、工作区中读取的图片（ws_read_image）以及刚刚生成的图片，并依据看到的图像内容回应。不要自称"看不见图片"或"没有眼睛"。';
/* 生图说明块的逐轮注入判定（单聊/群聊共用一条真源，避免两处各写一套）：
   判定逻辑在 assets/js/chat-context-signals.js（结构化信号优先，末端才是极小可解释的意图兜底）。
   信号模块不可用时返回 true —— 宁可多注入一句说明，也不能让已开启的生图能力失去标签语法。 */
function _imgGenInstrNeeded(userMessage,sentFiles){
  try{
    if(window.IBContextSignals&&typeof window.IBContextSignals.imageGenInstrNeeded==='function'){
      return !!window.IBContextSignals.imageGenInstrNeeded({userMessage:userMessage,attachments:(sentFiles||null)});
    }
  }catch(e){}
  return true;
}
const LOCAL_VISION_ENDPOINT='http://127.0.0.1:8765/vision';
const _localVisionCache=new Map();
function _usesLocalDeepSeekVision(cfg){
  const provider=String((cfg&&cfg.provider)||'').toLowerCase();
  const model=String((cfg&&cfg.model)||'').toLowerCase();
  return (provider==='deepseek'||model.indexOf('deepseek')>=0)&&!_usesNativeDeepSeekVision(cfg)
}
function _localVisionCacheKey(img,prompt){
  const raw=String((img&&img.base64)||'');
  return [raw.length,raw.slice(0,48),raw.slice(-48),String(prompt||'').slice(0,300)].join('|')
}
async function _requestLocalVision(img,prompt){
  const key=_localVisionCacheKey(img,prompt);
  if(_localVisionCache.has(key))return _localVisionCache.get(key);
  const request=(async function(){
    const source=img.dataUrl||('data:'+(img.mime||'image/jpeg')+';base64,'+img.base64);
    const blob=await fetch(source).then(r=>r.blob());
    const body=new FormData();
    body.append('image',blob,img.name||'image.jpg');
    body.append('prompt',prompt||'描述这张图片，并指出主要对象、文字和重要细节。');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),300000);
    try{
      const response=await fetch(LOCAL_VISION_ENDPOINT,{method:'POST',body:body,signal:controller.signal});
      let data={};try{data=await response.json()}catch(e){}
      if(!response.ok)throw new Error((data&&data.detail)||('HTTP '+response.status));
      const result=String((data&&data.result)||'').trim();
      if(!result)throw new Error('本地视觉模型返回空内容');
      return result
    }catch(error){
      if(error&&error.name==='AbortError')throw new Error('本地视觉识别超时（超过5分钟）');
      throw error
    }finally{clearTimeout(timer)}
  })();
  _localVisionCache.set(key,request);
  if(_localVisionCache.size>24)_localVisionCache.delete(_localVisionCache.keys().next().value);
  try{return await request}catch(error){_localVisionCache.delete(key);throw error}
}
async function _describeImagesLocally(images,userText){
  const question=(userText||'描述图片内容，并指出主要对象、文字和重要细节。').trim();
  toast('Qwen2.5-VL 正在识别图片，请稍候…');
  _showStreamingUI(true);
  const results=await Promise.all(images.map(img=>_requestLocalVision(img,question)));
  toast('图片识别完成，正在生成角色回复…');
  return '\n\n【本地视觉模型 Qwen2.5-VL-3B-Instruct 的图片识别结果】\n'
    +results.map((result,index)=>'图片 '+(index+1)+'：'+result).join('\n\n')
    +'\n请基于这些图片信息回答用户，保持角色语气；不要提及中间模型、视觉服务或系统处理过程。'
}
/* 消息文本追加（复用点）：content 为字符串 → 直接拼接；content 为数组（带图/音频 parts）→ 更新 text part，
   绝不 String() 化（否则 [object Object] 乱码 + 图片 part 丢失，是"模型看不见图片"的根源之一） */
function _appendMsgText(msg,text){
  try{
    text=String(text||'');
    if(Array.isArray(msg.content)){
      const tp=msg.content.find(p=>p&&p.type==='text');
      if(tp){tp.text+=text;return}
      msg.content.unshift({type:'text',text:text});return
    }
    msg.content=String(msg.content||'')+text;
  }catch(e){try{msg.content=String(msg.content||'')+String(text||'')}catch(e2){}}
}
function _appendLocalVisionContext(messages,context){
  for(let i=messages.length-1;i>=0;i--){
    if(messages[i].role==='user'){
      const t=(getTextContent(messages[i])||'请查看图片');
      if(Array.isArray(messages[i].content)){
        const tp=messages[i].content.find(p=>p&&p.type==='text');
        if(tp)tp.text=t+context;
        else messages[i].content.unshift({type:'text',text:t+context});
      }
      else messages[i].content=t+context;
      return true
    }
  }
  return false
}

function renderImagePreviews(){renderAttachPreviews()}
function renderAttachPreviews(){
  ['chat-full-preview','chat-mini-preview'].forEach(id=>{
    const bar=document.getElementById(id);if(!bar)return;
    bar.innerHTML='';
    /* 图片编辑选中态（Phase 3）：与附件同一排显示"正在编辑这张图片"，复用既有 .chat-preview-item 样式 */
    let _editChip=false;
    try{if(window.IB&&IB.imageEdit&&IB.imageEdit.renderSelectionChip)_editChip=!!IB.imageEdit.renderSelectionChip(bar)}catch(e){}
    if(_pendingImages.length===0&&_pendingFiles.length===0&&!_editChip){bar.classList.remove('has-items');return}
    bar.classList.add('has-items');
    _pendingImages.forEach((img,i)=>{
      const item=document.createElement('div');item.className='chat-preview-item';
      item.innerHTML='<img src="'+img.dataUrl+'" alt="preview"><div class="chat-preview-x" onclick="removeImagePreview('+i+')">✕</div>';
      bar.appendChild(item)
    });
    _pendingFiles.forEach((f,i)=>{
      const item=document.createElement('div');item.className='chat-preview-item';
      item.innerHTML='<div class="chat-preview-file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>'+esc(f.name)+'</span></div><div class="chat-preview-x" onclick="removeFilePreview('+i+')">✕</div>';
      bar.appendChild(item)
    })
  })
}
function removeImagePreview(idx){_pendingImages.splice(idx,1);renderAttachPreviews()}
function removeFilePreview(idx){_pendingFiles.splice(idx,1);renderAttachPreviews()}
function _fmtFileSize(bytes){if(bytes<1024)return bytes+' B';if(bytes<1048576)return(bytes/1024).toFixed(1)+' KB';if(bytes<1073741824)return(bytes/1048576).toFixed(1)+' MB';return(bytes/1073741824).toFixed(1)+' GB'}
function _buildFileCard(f){
  var card=document.createElement('div');card.className='chat-file-card';
  card.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
    +'<div class="chat-file-card-info"><div class="chat-file-card-name">'+esc(f.name)+'</div>'
    +'<div class="chat-file-card-meta">'+(f.ext?('.'+f.ext.toUpperCase()+' · '):'')+_fmtFileSize(f.size||0)+'</div></div>';
  return card;
}

/* ── FILE DOWNLOAD SYSTEM (AI → User) ───────────────── */
function _parseFileBlocks(text){
  var re=/```file:([^\n]+)\n([\s\S]*?)```/g;
  var files=[];
  var clean=text.replace(re,function(_m,name,content){
    files.push({name:name.trim(),content:content.replace(/\n$/,'')});
    return '';
  });
  return {cleanText:clean.replace(/\n{3,}/g,'\n\n').trim(),files:files};
}
function _downloadTextFile(name,content){
  var blob=new Blob([content],{type:'text/plain;charset=utf-8'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download=name;
  document.body.appendChild(a);a.click();
  setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url)},200);
}
function _buildDownloadCard(name,content){
  var ext=name.split('.').pop()||'';
  var card=document.createElement('div');card.className='chat-file-card chat-file-download';
  card.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="7" y1="15" x2="12" y2="19"/><line x1="17" y1="15" x2="12" y2="19"/><line x1="12" y1="11" x2="12" y2="19"/></svg>'
    +'<div class="chat-file-card-info"><div class="chat-file-card-name">'+esc(name)+'</div>'
    +'<div class="chat-file-card-meta">'+(ext?('.'+esc(ext.toUpperCase())+' · '):'')+_fmtFileSize(new Blob([content]).size)+'</div></div>'
    +'<button class="chat-file-dl-btn">下载</button>';
  card.querySelector('.chat-file-dl-btn').onclick=function(ev){ev.stopPropagation();_downloadTextFile(name,content)};
  card.onclick=function(){_downloadTextFile(name,content)};
  return card;
}
/* ── 统一分段解析：把 AI 文本按出现顺序切成 text / 工作区操作 / file 下载块 ──
   v2 宽容解析：不同模型输出标签的姿势差异极大（单引号/中文引号/无引号、额外属性、
   大小写、闭合标签内多余空格），旧版单条严格正则只认 path="…" 双引号紧跟 >，
   稍有偏差就整段当纯文本——这正是"AI 说创建了但工作区没东西"的主要根源之一。
   现改为：宽松匹配开标签 → 独立提取属性 → 大小写不敏感地找闭合标签。 */
function _wsAttr(tag,name){
  /* 属性提取：容忍 "双引号" / '单引号' / “中文引号” / 无引号 与任意大小写 */
  var re=new RegExp(name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|[\u201c\u201d]([^\u201c\u201d]*)[\u201c\u201d]|([^\\s>/"\'\u201c\u201d]+))','i');
  var m=String(tag||'').match(re);
  if(!m)return'';
  return(m[1]!==undefined?m[1]:m[2]!==undefined?m[2]:m[3]!==undefined?m[3]:m[4]||'').trim();
}
/* ══ 聊天排版净化 / Markdown 渲染模式 ══ */
function _mdMode(){try{var v=localStorage.getItem('ib_mdMode');return(v==='none'||v==='partial'||v==='full'||v==='clean')?v:(v==='off'?'none':(v==='on'?'clean':'full'))}catch(e){return'full'}}
function _mdCleanOn(){var m=_mdMode();return m==='clean'}
function _mdSaveModeChange(){
  var el=document.getElementById('api-mdmode-select');var mode=el?el.value:'clean';
  try{localStorage.setItem('ib_mdMode',mode)}catch(e){}
  var labels={'clean':'排版净化','none':'不处理（原样显示）','partial':'部分渲染','full':'全部渲染'};
  toast('已切换为：'+labels[mode]);
  try{if(typeof loadChatMessages==='function')loadChatMessages()}catch(e){}
  try{
    if(typeof activeFriendId!=='undefined'&&activeFriendId){
      if(String(activeFriendId).startsWith('group_')){if(typeof selectGroup==='function')selectGroup(activeFriendId)}
      else if(typeof selectFriend==='function')selectFriend(activeFriendId)
    }
  }catch(e){}
}
/* 兼容旧存储 */
function _mdSaveCleanToggle(){_mdSaveModeChange()}

/* ── CJK 检测 ── */
function _hasCJK(s){return/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(s)}

/* ── Markdown → HTML 渲染器 ── */
function _mdRenderHtml(text,partial){
  if(!text)return'';
  var lines=String(text).split('\n'),html=[],inFence=false,fenceLang='',fenceBuf=[];
  var inList=false,listType='',listDepth=0;
  var inBlockquote=false,bqBuf=[];
  var inTable=false,tableBuf=[];
  function closeList(){if(inList){html.push('</'+listType+'>');inList=false;listType='';listDepth=0}}
  function closeBq(){if(inBlockquote){var joined=bqBuf.join('\n');var cls=_hasCJK(joined)?' md-bq-cjk':'';html.push('<blockquote class="'+cls.trim()+'">'+inlineRender(joined)+'</blockquote>');inBlockquote=false;bqBuf=[]}}
  function closeTable(){
    if(!inTable)return;
    var rows=tableBuf.map(function(r){return r.split('|').map(function(c){return c.trim()}).filter(function(c,i,a){return i>0||c!==''})});
    /* 去掉末尾空列 */
    rows=rows.map(function(r){while(r.length&&r[r.length-1]==='')r.pop();return r});
    if(rows.length<2){html.push(tableBuf.map(function(l){return'<p>'+inlineRender(l)+'</p>'}).join(''));inTable=false;tableBuf=[];return}
    /* 第二行判断分隔行 */
    var sep=rows[1];var isSep=sep.every(function(c){return/^[\s:]*-{2,}[\s:]*$/.test(c)});
    if(!isSep){html.push(tableBuf.map(function(l){return'<p>'+inlineRender(l)+'</p>'}).join(''));inTable=false;tableBuf=[];return}
    var cols=rows[0].length;
    html.push('<table><thead><tr>');
    rows[0].forEach(function(c){html.push('<th>'+inlineRender(c)+'</th>')});
    html.push('</tr></thead><tbody>');
    for(var ri=2;ri<rows.length;ri++){
      html.push('<tr>');for(var ci=0;ci<cols;ci++)html.push('<td>'+inlineRender(rows[ri]&&rows[ri][ci]||'')+'</td>');
      html.push('</tr>');
    }
    html.push('</tbody></table>');
    inTable=false;tableBuf=[];
  }
  function inlineRender(s){
    if(!s)return'';
    s=s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');/* XSS 修复：双引号必须转义，否则链接 URL 可越出 href="..." 注入事件属性 */
    /* 行内代码 */
    s=s.replace(/`([^`\n]+)`/g,'<code class="md-il">$1</code>');
    if(!partial){
      /* 加粗+斜体 */
      s=s.replace(/\*\*\*([^*]+)\*\*\*/g,function(_,t){var cls=_hasCJK(t)?' md-em-cjk':'';return'<strong><em class="'+cls.trim()+'">'+t+'</em></strong>'});
      s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
      s=s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g,function(_,pre,t){var cls=_hasCJK(t)?' md-em-cjk':'';return pre+'<em class="'+cls.trim()+'">'+t+'</em>'});
      s=s.replace(/__([^_]+)__/g,'<strong>$1</strong>');
      s=s.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g,function(_,pre,t){var cls=_hasCJK(t)?' md-em-cjk':'';return pre+'<em class="'+cls.trim()+'">'+t+'</em>'});
      s=s.replace(/~~([^~]+)~~/g,'<del>$1</del>');
      /* 图片/链接 */
      s=s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g,'<span title="$1">[$1]</span>');
      s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,function(_,t,u){u=String(u).trim();if(!/^(https?:|mailto:)/i.test(u))return '['+t+']('+u+')';/* XSS 修复：协议白名单，javascript: 等伪协议降级为纯文本 */return '<a href="'+u+'" target="_blank" rel="noopener noreferrer" style="color:var(--accent-light);text-decoration:underline">'+t+'</a>'});
    }
    return s;
  }
  for(var i=0;i<lines.length;i++){
    var L=lines[i];
    /* 围栏代码块 */
    if(/^\s*(```|~~~)/.test(L)){
      if(!inFence){closeBq();closeList();closeTable();inFence=true;fenceLang=L.replace(/^\s*(```|~~~)/,'').trim().replace(/[<>&"']/g,'');/* XSS 修复：语言名此前未转义直拼 innerHTML，```<img onerror=...> 可直接注入标签 */fenceBuf=[];continue}
      else{var code=fenceBuf.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html.push('<pre class="md-cb">'+(fenceLang?'<span class="md-cb-lang">'+fenceLang+'</span>':'')+'<code>'+code+'</code></pre>');
        inFence=false;fenceLang='';fenceBuf=[];continue}
    }
    if(inFence){fenceBuf.push(L);continue}
    /* 表格行 */
    if(/^\|/.test(L)){closeBq();closeList();if(!inTable)inTable=true;tableBuf.push(L);continue}
    if(inTable){closeTable()}
    /* 分割线 */
    if(!partial&&/^\s*([-*_])(\s*\1){2,}\s*$/.test(L)){closeBq();closeList();html.push('<hr>');continue}
    /* 引用 */
    if(!partial&&/^\s*>\s?/.test(L)){closeList();if(!inBlockquote)inBlockquote=true;bqBuf.push(L.replace(/^\s*>\s?/,''));continue}
    if(inBlockquote){closeBq()}
    /* 标题 */
    if(!partial){
      var hm=L.match(/^\s*(#{1,4})[ \t]+(.*?)[ \t]*#*[ \t]*$/);
      if(hm){closeList();var lvl=Math.min(hm[1].length+1,4);html.push('<h'+lvl+'>'+inlineRender(hm[2])+'</h'+lvl+'>');continue}
    }
    /* 无序列表 */
    var ulm=L.match(/^(\s*)[-*+]\s+(.*)/);
    if(ulm){closeBq();if(!inList||listType!=='ul'){closeList();html.push('<ul>');inList=true;listType='ul'}
      html.push('<li>'+inlineRender(ulm[2])+'</li>');continue}
    /* 有序列表 */
    var olm=L.match(/^(\s*)\d+\.\s+(.*)/);
    if(olm){closeBq();if(!inList||listType!=='ol'){closeList();html.push('<ol>');inList=true;listType='ol'}
      html.push('<li>'+inlineRender(olm[2])+'</li>');continue}
    /* 普通行 */
    closeList();
    if(L.trim()===''){html.push('');continue}
    html.push('<p>'+inlineRender(L)+'</p>');
  }
  /* 收尾 */
  if(inFence){var code=fenceBuf.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    html.push('<pre class="md-cb">'+(fenceLang?'<span class="md-cb-lang">'+fenceLang+'</span>':'')+'<code>'+code+'</code></pre>')}
  closeList();closeBq();closeTable();
  return html.join('\n').replace(/(<p>\s*<\/p>\n?){2,}/g,'<p></p>\n');
}
function _mdSoften(t){
  if(!t||_mdMode()!=='clean')return t;
  var lines=String(t).split('\n'),out=[],inFence=false;
  for(var i=0;i<lines.length;i++){
    var L=lines[i];
    if(/^\s*(```|~~~)/.test(L)){inFence=!inFence;continue}/* 丢弃围栏行本身，代码内容原样保留 */
    if(inFence){out.push(L);continue}
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(L))continue;       /* --- / *** / ___ 分割线整行移除 */
    L=L.replace(/^(\s*)#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/,function(_,sp,b){return b?sp+'【'+b+'】':sp});/* # 标题 → 【标题】 */
    L=L.replace(/^(\s*)>\s?/,'$1');                         /* > 引用 */
    L=L.replace(/^(\s*)[-*+]\s+/,'$1');                     /* 无序列表符（保留换行的列表感） */
    L=L.replace(/!\[([^\]]*)\]\(([^)]*)\)/g,'$1');          /* 图片记号留替代文字 */
    L=L.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'$1');           /* [链接](url) 留文字 */
    L=L.replace(/\*\*\*([^*]+)\*\*\*/g,'「$1」');
    L=L.replace(/\*\*([^*]+)\*\*/g,'「$1」');                /* **加粗** → 「加粗」 */
    L=L.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g,'$1$2');   /* *斜体*（避开 3*4 这类乘号） */
    L=L.replace(/__([^_]+)__/g,'「$1」');
    L=L.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g,'$1$2');  /* _斜体_（避开 snake_case） */
    L=L.replace(/~~([^~]+)~~/g,'$1');                       /* ~~删除线~~ */
    L=L.replace(/`([^`\n]+)`/g,'$1');                       /* `行内代码` */
    out.push(L);
  }
  return out.join('\n').replace(/\n{3,}/g,'\n\n');
}
/* 直播期增量净化器：在"只追加"的流式写入模型下尽量保住逐字打字感。
   策略：行首前缀（#/>/无序列表符/围栏/分割线）在行首短暂悬置后剥除；
   行内 * ~ ` 成对记号按"暂扣开记号、闭记号到达时一并消隐"处理；
   孤记号（真实的单个星号等）流式期间可能暂时隐没——流式结束后的整体
   重渲染（_wsFinalizeBubble → _mdSoften）以完整原文为准恢复，属兜底设计。 */
function _mkLiveMdCleaner(){
  var carry='',atLS=true,inFence=false,held={'*':0,'~':0,'`':0},prev='\n',inHead=false,boldOpen=false;
  function boundary(c){return c===''||/[\s，。！？、：；·（）()\[\]{}<>"'“”‘’…—\u4e00-\u9fff\n]/.test(c)}
  function resolveRun(run,out){
    var ch=run[0],n=run.length;
    if(held[ch]>0){var k=Math.min(n,held[ch]);held[ch]-=k;n-=k;
      if(ch==='*'&&boldOpen&&held[ch]===0){out.push('」');prev='」';boldOpen=false}}   /* 闭 ** → 」 */
    if(n>0){
      if(n===1&&!boundary(prev)){out.push(ch);prev=ch}      /* 3*4 之类夹在词间：按字面输出 */
      else{held[ch]=Math.min(held[ch]+n,3);                 /* 视作开记号暂扣（封顶防失衡） */
        if(ch==='*'&&n>=2&&!boldOpen){out.push('「');prev='「';boldOpen=true}}         /* 开 ** → 「 */
    }
  }
  function push(s){
    if(_mdMode()!=='clean')return s;
    s=carry+s;carry='';
    var out=[],i=0;
    while(i<s.length){
      if(atLS){
        var rest=s.slice(i);
        var nl=rest.indexOf('\n');
        var line=nl===-1?rest:rest.slice(0,nl);
        if(nl===-1){
          /* 行未收尾且形态未定 → 悬置等下一块：围栏/分割线候选、纯记号残枝 */
          if(/^\s*(`|~)/.test(line)||/^[\s\-*_]*$/.test(line)||/^\s*#{1,6}$/.test(line)||/^\s*>$/.test(line)||/^\s*\+$/.test(line)){carry=rest;break}
        }
        var mm=line.match(/^\s*(```|~~~)/);
        if(mm){/* 围栏行：整行吞掉并切换代码态（此处 nl 必不为 -1，未收尾时已在上方悬置） */
          inFence=!inFence;i+=nl+1;prev='\n';continue}
        if(inFence){
          if(nl===-1){out.push(rest);prev=rest[rest.length-1]||prev;i=s.length;atLS=false;break}
          out.push(line+'\n');i+=nl+1;prev='\n';continue}
        if(nl!==-1&&/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)){i+=nl+1;prev='\n';continue}/* 分割线 */
        mm=line.match(/^(\s*)#{1,6}[ \t]+/);
        if(mm){if(mm[1])out.push(mm[1]);out.push('【');prev='【';inHead=true;i+=mm[0].length;atLS=false;continue}/* 标题 → 【…（换行处补 】） */
        mm=line.match(/^(\s*)(?:>\s?|[-*+]\s+)/);
        if(mm){if(mm[1])out.push(mm[1]);i+=mm[0].length;atLS=false;continue}
        atLS=false;continue;
      }
      var c=s[i];
      if(c==='\n'){if(inHead){out.push('】');inHead=false}held['*']=held['~']=held['`']=0;boldOpen=false;out.push('\n');prev='\n';atLS=true;i++;continue}
      if(inFence){out.push(c);prev=c;i++;continue}
      if(c==='*'||c==='~'||c==='`'){
        var j=i;while(j<s.length&&s[j]===c)j++;
        if(j===s.length){carry=s.slice(i);break}            /* 记号串骑在块边界上：悬置 */
        resolveRun(s.slice(i,j),out);i=j;continue;
      }
      out.push(c);prev=c;i++;
    }
    return out.join('');
  }
  function finish(){
    var r=carry;carry='';
    /* 纯记号残枝且确有暂扣 → 就地结算（把骑在流末尾的闭 ** 配成 」）；孤立记号仍按原样返回，收尾重渲染兜底 */
    if(r&&/^[*~`]+$/.test(r)&&held[r[0]]>0){
      var _o=[],_i=0;
      while(_i<r.length){var _ch=r[_i],_j=_i;while(_j<r.length&&r[_j]===_ch)_j++;resolveRun(r.slice(_i,_j),_o);_i=_j}
      r=_o.join('');
    }
    if(inHead){r+='】';inHead=false}
    boldOpen=false;held['*']=held['~']=held['`']=0;
    return r;
  }
  return{push:push,finish:finish};
}
var _WS_OPEN_RE=/<ws_(project|read|read_image|create|edit|edit_image|run|tool|gen_image|make_docx|make_pdf|make_xlsx)\b([^>]*)>|```file:([^\n]+)\n/gi;
function _segmentAiText(text){
  text=text||'';
  var segs=[],last=0,m;
  var pushText=function(t){t=_mdSoften(t).replace(/\n{3,}/g,'\n\n').trim();if(t)segs.push({type:'text',text:t})};
  _WS_OPEN_RE.lastIndex=0;
  while((m=_WS_OPEN_RE.exec(text))!==null){
    var start=m.index,afterOpen=_WS_OPEN_RE.lastIndex;
    if(m[3]!==undefined){/* ```file:name 下载块 */
      var close=text.indexOf('```',afterOpen);
      pushText(text.slice(last,start));
      if(close===-1){/* 截断补救 */
        var fc=text.slice(afterOpen);
        if(fc.trim())segs.push({type:'file',name:m[3].trim(),content:fc,truncated:true});
        last=text.length;break;
      }
      segs.push({type:'file',name:m[3].trim(),content:text.slice(afterOpen,close).replace(/\n$/,'')});
      last=close+3;_WS_OPEN_RE.lastIndex=last;continue;
    }
    var kind=m[1].toLowerCase(),attrs=m[2]||'';
    pushText(text.slice(last,start));
    if(kind==='project'){
      segs.push({type:'op',op:{type:'project',name:_wsAttr(attrs,'name')||_wsAttr(attrs,'path')}});
      last=afterOpen;continue;
    }
    if(kind==='read'){
      segs.push({type:'op',op:{type:'read',path:_wsAttr(attrs,'path')||_wsAttr(attrs,'name'),from:parseInt(_wsAttr(attrs,'from'),10)||0,chars:parseInt(_wsAttr(attrs,'chars'),10)||0}});
      last=afterOpen;continue;
    }
    if(kind==='read_image'){
      /* 图片读取指令（ws_read_image）：命中 ICode 图片文件 → 入回注队列，下一条消息以图像注入 */
      segs.push({type:'op',op:{type:'read_image',path:_wsAttr(attrs,'path')||_wsAttr(attrs,'name')}});
      last=afterOpen;continue;
    }
    if(kind==='make_docx'||kind==='make_pdf'||kind==='make_xlsx'){
      /* <ws_make_*> 生成指令：正文即源内容，交由生成器构建真实文件 */
      var mkOp={type:kind,path:_wsAttr(attrs,'path')||_wsAttr(attrs,'name'),content:''};
      var mkClose=new RegExp('<\\/ws_'+kind+'\\s*>','ig');mkClose.lastIndex=afterOpen;
      var mkm=mkClose.exec(text);
      if(!mkm){/* 截断补救 */
        var mkBody=text.slice(afterOpen).replace(/^\n/,'');
        if(mkBody.trim()){mkOp.content=mkBody;mkOp.truncated=true;segs.push({type:'op',op:mkOp})}
        else segs.push({type:'op',op:Object.assign(mkOp,{malformed:true,truncated:true})});
        last=text.length;break;
      }
      mkOp.content=text.slice(afterOpen,mkm.index).replace(/^\n/,'').replace(/\n$/,'');
      segs.push({type:'op',op:mkOp});
      last=mkClose.lastIndex;_WS_OPEN_RE.lastIndex=last;continue;
    }
    if(kind==='run'){
      /* <ws_run lang entry|file timeout> —— 自闭合=只跑 entry 文件；带正文=运行内联代码 */
      var rOp={type:'run',lang:_wsAttr(attrs,'lang'),entry:_wsAttr(attrs,'entry')||_wsAttr(attrs,'file')||_wsAttr(attrs,'path'),timeoutSec:parseInt(_wsAttr(attrs,'timeout'))||0,pip:_wsAttr(attrs,'pip'),code:''};
      if(/\/\s*$/.test(attrs)){segs.push({type:'op',op:rOp});last=afterOpen;continue}
      var rClose=/<\/ws_run\s*>/ig;rClose.lastIndex=afterOpen;
      var rcm=rClose.exec(text);
      if(!rcm){/* 截断补救 */
        var rBody=text.slice(afterOpen).replace(/^\n/,'');
        if(rOp.entry&&!rBody.trim())segs.push({type:'op',op:rOp});/* 只有 entry、正文空 → 视作自闭合 */
        else if(rBody.trim()){rOp.code=rBody;rOp.truncated=true;segs.push({type:'op',op:rOp})}
        else segs.push({type:'op',op:Object.assign(rOp,{malformed:true,truncated:true})});
        last=text.length;break;
      }
      rOp.code=text.slice(afterOpen,rcm.index).replace(/^\n/,'').replace(/\n$/,'');
      segs.push({type:'op',op:rOp});
      last=rClose.lastIndex;_WS_OPEN_RE.lastIndex=last;continue;
    }
    if(kind==='gen_image'){
      /* <ws_gen_image prompt size file/> —— 自闭合=提示词在 prompt 属性；带正文=正文即提示词（描述较长时用） */
      var giOp={type:'gen_image',prompt:_wsAttr(attrs,'prompt')||'',size:_wsAttr(attrs,'size')||'',file:_wsAttr(attrs,'file')||_wsAttr(attrs,'path')||''};
      if(/\/\s*$/.test(attrs)){segs.push({type:'op',op:giOp});last=afterOpen;continue}
      var giClose=/<\/ws_gen_image\s*>/ig;giClose.lastIndex=afterOpen;
      var gim=giClose.exec(text);
      if(!gim){/* 截断补救：提示词可能不完整，标记后由执行层拒绝 */
        var giBody=text.slice(afterOpen).trim();
        if(giBody)giOp.prompt=giBody;
        giOp.truncated=true;segs.push({type:'op',op:giOp});
        last=text.length;break;
      }
      var giBody2=text.slice(afterOpen,gim.index).trim();
      if(giBody2)giOp.prompt=giBody2;
      segs.push({type:'op',op:giOp});
      last=giClose.lastIndex;_WS_OPEN_RE.lastIndex=last;continue;
    }
    if(kind==='edit_image'){
      /* <ws_edit_image path?>正文=修改要求</ws_edit_image>
         编辑当前会话"最近一张可编辑图片"（或 path 指定的 ICode 图片）。
         模型**不需要**自己传 base64 / URL / messageId —— 实际图片由 Reference Resolver 解析。 */
      var eiOp={type:'edit_image',prompt:_wsAttr(attrs,'prompt')||'',path:_wsAttr(attrs,'path')||_wsAttr(attrs,'name')||'',size:_wsAttr(attrs,'size')||'',file:_wsAttr(attrs,'file')||_wsAttr(attrs,'path')||''};
      if(/\/\s*$/.test(attrs)){segs.push({type:'op',op:eiOp});last=afterOpen;continue}
      var eiClose=/<\/ws_edit_image\s*>/ig;eiClose.lastIndex=afterOpen;
      var eim=eiClose.exec(text);
      if(!eim){/* 截断补救：修改要求可能不完整，标记后由执行层拒绝 */
        var eiBody=text.slice(afterOpen).trim();
        if(eiBody)eiOp.prompt=eiBody;
        eiOp.truncated=true;segs.push({type:'op',op:eiOp});
        last=text.length;break;
      }
      var eiBody2=text.slice(afterOpen,eim.index).trim();
      if(eiBody2)eiOp.prompt=eiBody2;
      segs.push({type:'op',op:eiOp});
      last=eiClose.lastIndex;_WS_OPEN_RE.lastIndex=last;continue;
    }
    if(kind==='tool'){
      /* <ws_tool name args/> —— 自闭合=参数在 args 属性；带正文=正文即 args JSON（参数较长时用） */
      var tOp={type:'tool',name:_wsAttr(attrs,'name'),args:_wsAttr(attrs,'args')||'',fc:_wsAttr(attrs,'fc')};
      if(/\/\s*$/.test(attrs)){segs.push({type:'op',op:tOp});last=afterOpen;continue}
      var tClose=/<\/ws_tool\s*>/ig;tClose.lastIndex=afterOpen;
      var tcm=tClose.exec(text);
      if(!tcm){/* 截断补救：正文可能不完整，标记后由执行层拒绝 */
        var tBody=text.slice(afterOpen).trim();
        if(tBody)tOp.args=tBody;
        tOp.truncated=true;segs.push({type:'op',op:tOp});
        last=text.length;break;
      }
      var tBody2=text.slice(afterOpen,tcm.index).trim();
      if(tBody2)tOp.args=tBody2;
      segs.push({type:'op',op:tOp});
      last=tClose.lastIndex;_WS_OPEN_RE.lastIndex=last;continue;
    }
    /* create / edit：大小写不敏感地寻找对应闭合标签 */
    var path=_wsAttr(attrs,'path')||_wsAttr(attrs,'name');
    var owr=/^(true|1|yes|是)$/i.test(_wsAttr(attrs,'overwrite'));/* overwrite="true" = 有意改写既有文件 */
    var closeRe=new RegExp('</ws_'+kind+'\\s*>','ig');closeRe.lastIndex=afterOpen;
    var cm=closeRe.exec(text);
    if(!cm){/* 截断补救：闭合标记不会出现时抢救已有内容，而不是让原始代码炸进气泡 */
      var body=text.slice(afterOpen);
      if(kind==='create'){var cc=body.replace(/^\n/,'');if(cc.trim())segs.push({type:'op',op:{type:'create',path:path,content:cc,truncated:true,overwrite:owr}})}
      else segs.push({type:'op',op:{type:'edit',path:path,malformed:true,truncated:true}});
      last=text.length;break;
    }
    var inner=text.slice(afterOpen,cm.index);
    if(kind==='create'){
      segs.push({type:'op',op:{type:'create',path:path,content:inner.replace(/^\n/,'').replace(/\n$/,''),overwrite:owr}});
    }else{
      var fm=inner.match(/<find>([\s\S]*?)<\/find>/i),rm=inner.match(/<replace>([\s\S]*?)<\/replace>/i);
      if(fm&&rm)segs.push({type:'op',op:{type:'edit',path:path,find:fm[1],replace:rm[1]}});
      else segs.push({type:'op',op:{type:'edit',path:path,malformed:true}});
    }
    last=closeRe.lastIndex;_WS_OPEN_RE.lastIndex=last;
  }
  pushText(text.slice(last));
  return segs;
}
/* ── ── 历史消息瘦身：发给 API 时把已执行过的文件全文替换为占位，避免 ── */
function _wsStubHistory(text){
  if(!text)return text;
  if(!/<ws_/i.test(text)&&text.indexOf('```file:')===-1)return text;
  return text
    .replace(/<ws_create\b([^>]*)>[\s\S]*?<\/ws_create\s*>/gi,function(_,a){return '[系统归档：文件 '+(_wsAttr(a,'path')||_wsAttr(a,'name')||'?')+' 的完整内容已存入工作区，历史原文省略]'})
    .replace(/<ws_edit\b([^>]*)>[\s\S]*?<\/ws_edit\s*>/gi,function(_,a){return '[系统归档：已编辑文件 '+(_wsAttr(a,'path')||_wsAttr(a,'name')||'?')+'，细节省略]'})
    .replace(/<ws_make_(docx|pdf|xlsx)\b([^>]*)>[\s\S]*?<\/ws_make_\1\s*>/gi,function(mm,k,a){return '[系统归档：已提交生成 '+(k==='docx'?'Word 文档':k==='pdf'?'PDF':'Excel 表格')+' '+(_wsAttr(a,'path')||_wsAttr(a,'name')||'?')+'，源内容省略]'})
    .replace(/<ws_run\b([^>]*)>[\s\S]*?<\/ws_run\s*>/gi,function(mm,a){var b=mm.replace(/^[^>]*>/,'').replace(/<\/ws_run\s*>\s*$/i,'');if(b.length<=1500)return mm;var en=_wsAttr(a,'entry')||_wsAttr(a,'file');return '[系统归档：已提交运行脚本'+(en?' '+en:'（内联）')+'，代码省略]'})
    .replace(/```file:([^\n]+)\n[\s\S]*?```/g,function(_,n){return '[系统归档：已输出下载文件 '+n.trim()+'，内容省略]'});
}
/* 思考占位符清洗：旧版本曾向历史注入固定占位符，长上下文中大量同形样本会被模型照抄并存为当轮思考。
   历史注入已移除；此函数在显示与 tail 注入前剥离残留占位（剥空视为无思考）。仅作用于展示与逐轮 tail，不改数据库与可缓存前缀。 */
function _cleanThinkingText(t){
  t=String(t||'');
  t=t.replace(/^(?:\s*\[?\s*此前的思考过程已省略\s*\]?\s*)+/,'');
  return t.trim();
}
/* ── 面板气泡（右下角快捷聊天）MD 修复：全部/部分渲染模式下补一层 .r-text 容器，
   让既有的 .md-rendered .r-text 系列样式（标题/加粗/斜体/代码块/表格等）在面板内同样生效；
   其余模式维持原直写结构，行为不变 ── */
function _panelMdHost(div){
  var mode=_mdMode();
  if(mode==='full'||mode==='partial'){var w=document.createElement('div');w.className='r-text';div.appendChild(w);return w}
  return div;
}
/* ── 分段渲染：文本、操作卡、下载卡按原始顺序进入气泡（历史与实时共用同一渲染路径） ── */
function _renderSegments(host,text,wsResults){
  var segs=_segmentAiText(text||'');
  var ri=0;
  var mode=_mdMode();
  segs.forEach(function(s){
    if(s.type==='text'){
      if(mode==='full'||mode==='partial'){
        var container=document.createElement('div');
        container.innerHTML=_mdRenderHtml(s.text,mode==='partial');
        while(container.firstChild)host.appendChild(container.firstChild);
      }else{host.appendChild(document.createTextNode(s.text))}
    }
    else if(s.type==='file'){
      var fc=_buildDownloadCard(s.name,s.content);
      if(s.truncated){var meta=fc.querySelector('.chat-file-card-meta');if(meta)meta.textContent+=' · 可能不完整'}
      host.appendChild(fc);
    }else{
      var data=Object.assign({},s.op);
      if(wsResults&&ri<wsResults.length){
        var r=wsResults[ri++];
        if(r&&r.type===data.type){data.ok=r.ok;if(r.reason)data.reason=r.reason;if(r.size!==undefined)data.size=r.size;if(r.projId)data.projId=r.projId;if(r.isDefault)data.isDefault=true;if(r.renamedFrom){data.renamedFrom=r.renamedFrom;data.path=r.path}
          if(data.type==='run'){['pendingConfirm','output','errText','ms','timedOut','changedNames','author','timeoutSec','lang','entry','code','fed','pip','images'].forEach(function(k){if(r[k]!==undefined)data[k]=r[k]})}
          if(data.type==='tool'){['pendingConfirm','response','fed','author','images','args','traceId'].forEach(function(k){if(r[k]!==undefined)data[k]=r[k]})}
          if(data.type==='gen_image'){['dataUrl','mime','model','path','prompt','bytes'].forEach(function(k){if(r[k]!==undefined)data[k]=r[k]})}
        }
      }
      var cardEl=_buildWsOpCard(data);
      if(cardEl)host.appendChild(cardEl);
    }
  });
}
/* Render AI text: segments (text + op */
function _renderAiContent(textEl,container,text,wsResults){
  textEl.textContent='';
  var mode=_mdMode();
  if(mode==='full'||mode==='partial'){
    /* 找到所属的 chat-msg 元素并添加 md-rendered 类 */
    var msgEl=container||textEl.closest('.chat-msg');
    if(msgEl&&msgEl.classList)msgEl.classList.add('md-rendered');
  }
  _renderSegments(textEl,text,wsResults);
}

function getTextContent(msg){
  if(!msg)return '';
  var t='';
  if(typeof msg.content==='string')t=msg.content;
  else if(Array.isArray(msg.content))t=msg.content.filter(b=>b.type==='text').map(b=>b.text||'').join('');
  else if(msg.content)t=String(msg.content);
  if(msg.voice&&msg.role==='user')t+=(t?'\n':'')+_voiceApiLine(msg.voice);/* 用户语音消息：存储记录读取时附上等效文本（映射后的 API 消息对象无 voice 字段，请求内容不经此改变）。P23：assistant 一级 voice message 的 content 本身就是文字稿，绝不重复追加。 */
  return t;
}

function _viewImageFull(src,image){
  const ov=document.createElement('div');ov.className='chat-bubble-img-full';
  ov.innerHTML='<img src="'+src+'">';ov.onclick=function(){ov.remove()};
  /* 图片编辑入口（Phase 3）：选中这张图 → 回到输入框，用户直接说"把背景换成晚上"即可。
     选中后 <ws_edit_image> / 自然语言续改都优先使用这张图（explicit > attached > latest）。 */
  try{
    if(image&&(image.dataUrl||image.base64)&&window.IB&&IB.imageEdit&&IB.imageEdit.available){
      ov.style.flexDirection='column';ov.style.gap='14px';
      const btn=document.createElement('button');
      btn.type='button';btn.className='btn';btn.textContent='编辑这张图';
      btn.onclick=function(ev){
        ev.stopPropagation();
        const r=IB.imageEdit.selectImage(image,{conversationId:(typeof activeFriendId!=='undefined'&&activeFriendId)||''});
        if(r&&r.ok){ov.remove();if(typeof toast==='function')toast('已选中这张图片，直接说要改哪里就行')}
        else if(typeof toast==='function')toast((r&&r.reason)||'这张图片无法编辑');
      };
      ov.appendChild(btn);
    }
  }catch(e){}
  document.body.appendChild(ov)
}

/* paste & drag-drop image support */
document.addEventListener('paste',function(e){
  if(!document.querySelector('.chat-input:focus')&&!document.querySelector('#chat-full-input:focus'))return;
  const items=e.clipboardData&&e.clipboardData.items;if(!items)return;
  for(const item of items){
    if(item.type.startsWith('image/')){
      e.preventDefault();
      const f=item.getAsFile();if(!f)continue;
      var _pastePanel=e.target&&e.target.id==='chat-full-input'?'full':'mini';
      if(_pendingImages.length>=IMG_MAX_COUNT){_chatSetComposerFeedback(_pastePanel,'最多附加'+IMG_MAX_COUNT+'张图片。');return}
      compressImage(f).then(c=>{_pendingImages.push(c);renderImagePreviews();_chatSetComposerFeedback(_pastePanel,'')}).catch(()=>_chatSetComposerFeedback(_pastePanel,'图片读取失败，请重新选择。'));
      break
    }
  }
});
['chat-full-messages','chat-messages'].forEach(id=>{
  const el=document.getElementById(id);if(!el)return;
  el.addEventListener('dragover',function(e){e.preventDefault();e.dataTransfer.dropEffect='copy'});
  el.addEventListener('drop',function(e){
    e.preventDefault();
    const files=e.dataTransfer.files;if(!files||!files.length)return;
    const _dropPanel=id==='chat-full-messages'?'full':'mini';
    Array.from(files).forEach(f=>{
      if(!f.type.startsWith('image/')){_chatSetComposerFeedback(_dropPanel,'拖放到对话中的文件仅支持图片；其他文件请使用附件入口。');return}
      if(_pendingImages.length>=IMG_MAX_COUNT){_chatSetComposerFeedback(_dropPanel,'最多附加'+IMG_MAX_COUNT+'张图片。');return}
      compressImage(f).then(c=>{_pendingImages.push(c);renderImagePreviews();_chatSetComposerFeedback(_dropPanel,'')}).catch(()=>_chatSetComposerFeedback(_dropPanel,'图片读取失败，请重新选择。'))
    })
  })
});

function chatKeyDown(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChatMessage()}
}

/* ── 未读消息提示（已禁用） ── */
const _unreadFriends=new Set();
function _markUnread(){}
function _clearUnread(){}
function _updateUnreadUI(){}

/* ── 群聊修复辅助函数（groupchat-fix v1） ── */
/* P11-2H · Group Prompt Input Boundary ────────────────────────────────────
   用户可控 metadata 进入 prompt 的唯一消毒入口。

   为什么需要它：群聊规则块把 group.name / selfName / 成员名 / 用户描述
   直接插进 system，而 system 靠换行承载结构 —— 值里出现一个换行，它就从
   "名字"变成"规则列表的一行"，与真实规则行文本上不可区分。审计确认这 5 处
   插值此前没有任何消毒，全仓也没有可复用的 prompt 面消毒实现
   （既有 esc() 全部是 HTML 转义）。

   本函数**不实现任何消毒规则**：规则本体在 prompt-boundary-core.js
   （与浏览器共用同一份，Node 测试直接 require 同一文件），这里只做两件事：
     ① 归一化调用形状（缺参数 / 非字符串 / 缺 core 都得到字符串）
     ② 只有真的改动了才记一条诊断（正常名字零噪声：changed=false 不记录）

   缺 core 时**不静默放行**：退回一个本地的保守兜底，只剥换行与控制字符。
   这与 P11-2F/P11-2G 的 fail-closed 纪律一致 —— 消毒能力不可用时，
   退化到"至少不产生新行"，而不是退化到"原样插入"。 */
function _pbCore(){
  try{
    var c=window.IBPromptBoundaryCore;
    return (c&&typeof c.sanitizePromptInput==='function')?c:null;
  }catch(e){return null}
}
function _pbFallback(v){
  /* 兜底只做一件事：把换行/回车/TAB/其它 C0-C1 控制字符与不可见格式字符换成空格，
     再折叠首尾空白。**不**截断、不归类、不报告 —— 它不是第二套规则实现，
     它是"core 不在时的最小安全下界"。 */
  return String(v==null?'':v)
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g,' ')
    .replace(/ {2,}/g,' ').replace(/^ +| +$/g,'');
}
/* 消毒一个值。tag 是**稳定类别名**（不是值），只用于诊断。 */
function _pbSanitize(v,tag){
  const core=_pbCore();
  if(!core){
    const out=_pbFallback(v);
    if(out!==String(v==null?'':v))console.warn('[PromptBoundary] sanitizer core unavailable, conservative fallback used ('+String(tag||'value')+')');
    return out;
  }
  const r=core.sanitizePromptInput(v);
  if(r&&r.changed)console.info('[PromptBoundary] sanitized '+String(tag||'value')+' ('+r.reason+')');
  return (r&&typeof r.value==='string')?r.value:'';
}
/* 列表消毒：去空、去重、保持顺序。成员名清单用。 */
function _pbSanitizeNames(list,tag){
  const arr=Array.isArray(list)?list:[];
  const core=_pbCore();
  if(core&&typeof core.sanitizeNameList==='function'){
    const r=core.sanitizeNameList(arr);
    if(r&&r.changed)console.info('[PromptBoundary] sanitized '+String(tag||'names')+' list');
    return r&&Array.isArray(r.names)?r.names:[];
  }
  const out=[];const seen=Object.create(null);
  for(const v of arr){const s=_pbFallback(v);if(!s||seen[s])continue;seen[s]=true;out.push(s)}
  return out;
}
function _escRe(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
/* 清洗群聊回复：
   1) 若回复里出现行首"[自己名字]"段落标记，抽取属于自己的那一段（到下一个成员标记为止）
   2) 否则从第一个行首"[其他成员名]"标记处截断，防止替别人代笔
   3) 句中提及如"我同意[亚伯]的看法"不受影响（只认行首标记） */
function sanitizeGroupReply(reply,selfName,allNames){
  const raw=String(reply||'').trim();
  const others=allNames.filter(n=>n!==selfName);
  const tagRe=function(n){return new RegExp('(^|\n)\\s*[\\[【]\\s*'+_escRe(n)+'\\s*[\\]】]\\s*[:：]?\\s*')};
  let t=raw;
  const sm=t.match(tagRe(selfName));
  if(sm){
    const start=t.indexOf(sm[0])+sm[0].length;
    t=t.slice(start);
    let cut=t.length;
    for(const n of allNames){
      const m2=t.search(tagRe(n));
      if(m2>=0&&m2<cut)cut=m2;
    }
    t=t.slice(0,cut);
  }else{
    let cut=t.length;
    for(const n of others){
      const m2=t.search(tagRe(n));
      if(m2>=0&&m2<cut)cut=m2;
    }
    t=t.slice(0,cut);
  }
  t=t.trim();
  return t||raw;/* 全被截没了则退回原文，至少不丢消息 */
}
/* 合并相邻同 role 消息（兼容个别严格要求 user/assistant 交替的中转端点） */
function collapseSameRole(msgs){
  const out=[];
  for(const m of msgs){
    const last=out[out.length-1];
    if(last&&last.role===m.role){last.content+='\n\n'+m.content}
    else out.push({role:m.role,content:m.content});
  }
  return out;
}

/* ════ Chat Context Builder（Extraction Debt 本轮落点）════
   single / group 各一条，外加一个薄分派层。
   - 只负责"稳定 system 前缀 + 动态 tail 后缀"这一 prompt-cache 分区；
   - 私有符号 _BLOG_READ_INSTR_BLOCK / _VISION_DECLARE / _IMGGEN_INSTR_BLOCK /
     _getWsReadInjection / _getWsOpFeedbackInjection / _getWsRunOutputInjection /
     _getIbToolResultInjection / _getBlogReadInjection 仍为模块私有，不导出；
   - messages 的组装与 system/tail 的注入点仍在 sendChatMessage，保证顺序不变。 */
async function _ibResolveChatMemoryReference(cfg,input){
  input=input||{};
  var core=window.IBChatReferenceResolution;
  var needs=core&&typeof core.needsResolution==='function'
    ?core.needsResolution(input.userMessage)
    :/(?:那个(?:梗|计划|事情|事|地方|供应商|项目|东西|人|话)?|那件(?:事|事情)?|上次(?:那件|那个|那次|我们说的)?|之前(?:说的|那个|那件|那条)?|她说的那个|他说的那个|她提到的那个|还是老地方|你知道我说的是哪个|你知道我说的那个|那个还记得|那个呢|它)/.test(String(input.userMessage||''));
  if(!needs)return null;
  if(!core||typeof core.resolve!=='function')return {state:'UNRESOLVED',mode:String(input.mode||'recall'),mention:'',referentType:'other',referentRefs:[],referentMemoryIds:[],referenceEvidence:[],normalizedMeaning:'',groundedQuery:'',confidence:0,reason:'resolver-unavailable'};
  try{
    if(typeof _ibApiReady==='function'&&!_ibApiReady(cfg))return core.unresolved(input,'resolver-unavailable');
    if(typeof _ibApiHasCredential==='function'&&!_ibApiHasCredential(cfg))return core.unresolved(input,'resolver-unavailable');
    var _referenceMemoryContext=await _ibLoadRecentRecallMemoryRefs(cfg,input);
    var _referenceInput=Object.assign({},input,{memoryReferences:_referenceMemoryContext});
    var _referenceResult=await core.resolve(_referenceInput,{
      resolveModel:async function(messages){
        return await callApiChat(cfg,messages,{
          _ibConsumer:'memory',maxTokens:480,timeoutMs:1500,wantMeta:false,
          jsonMode:true,disableTools:true,autoContinue:false,_noWebSearch:true
        });
      }
    });
    if(_referenceResult)_referenceResult.referenceMemoryReferences=_referenceMemoryContext;
    return _referenceResult;
  }catch(_referenceError){return core.unresolved(input,'resolver-failed')}
}
var _ibReferenceRecallSelections=new Map();
function _ibReferenceSelectionKey(characterId,conversationId){
  return String(characterId||'')+'\u0000'+String(conversationId||'');
}
function _ibRememberRecallSelection(input,ids){
  input=input||{};
  var characterId=String(input.characterId||''),conversationId=String(input.conversationId||'');
  if(!characterId||!conversationId)return;
  var unique=[];
  (Array.isArray(ids)?ids:[]).forEach(function(id){id=String(id||'').trim();if(id&&!unique.includes(id)&&unique.length<4)unique.push(id)});
  var key=_ibReferenceSelectionKey(characterId,conversationId);
  _ibReferenceRecallSelections.delete(key);
  _ibReferenceRecallSelections.set(key,{ids:unique,isGroup:input.isGroup===true,at:Date.now()});
  while(_ibReferenceRecallSelections.size>64){var oldest=_ibReferenceRecallSelections.keys().next();if(oldest.done)break;_ibReferenceRecallSelections.delete(oldest.value)}
}
async function _ibLoadRecentRecallMemoryRefs(cfg,input){
  input=input||{};
  var key=_ibReferenceSelectionKey(cfg&&cfg.id,input.conversationId);
  var selection=_ibReferenceRecallSelections.get(key);
  if(!selection||selection.isGroup!==(input.isGroup===true)||!selection.ids.length)return [];
  if(Date.now()-Number(selection.at||0)>30*60*1000){_ibReferenceRecallSelections.delete(key);return []}
  var authority=null,status=null;
  try{
    var surface=window.IB&&window.IB.homeNode&&window.IB.homeNode.memory;
    authority=surface&&(surface.authority||surface.instance)||null;
    status=authority&&typeof authority.status==='function'?authority.status():null;
  }catch(_authorityError){return []}
  if(!authority||typeof authority.get!=='function'||!status||status.mode!=='canonical'||status.fileOrigin===true)return [];
  var core=window.IBChatReferenceResolution;
  if(!core||typeof core.loadSelectedMemoryReferences!=='function'||typeof isMemoryVisibleTo!=='function')return [];
  return await core.loadSelectedMemoryReferences(selection.ids,{
    getRecord:function(id){return authority.get(id)},
    isVisible:function(row){return isMemoryVisibleTo(row,String(cfg&&cfg.id||''),input.isGroup===true,input.isGroup===true)}
  });
}
function _ibReferenceGroundingGuidance(resolution){
  if(!resolution||resolution.state==='NOT_APPLICABLE')return '';
  if(resolution.state==='RESOLVED')return '【当前消息的指代落地】'+String(resolution.normalizedMeaning||'')+'。这只是基于本会话近期消息或本会话上一轮已选中且仍可见的 canonical Memory 引用形成的派生语义；保留用户原有的否定、偏好和不确定语气，不要把它扩展成未说过的事实。';
  if(resolution.mode==='write')return '【Memory 保存请求未完成】这次保存请求中的指代没有唯一、可信的先行对象。不要声称已经记住或保存；如果保存请求仍需要处理，请自然询问用户具体指哪一件事。';
  if(resolution.state==='AMBIGUOUS')return '【当前消息的指代状态】近期对话中有多个合理对象。不要替用户选择其中一个；若回答必须依赖该对象，再自然询问，否则继续回答可确定的部分。不要把这个指代写入 Memory。';
  return '【当前消息的指代状态】近期对话里没有足够依据确定对象。不要编造先行对象或把字面指代当成事实；若回答必须依赖该对象，再自然询问，否则继续回答可确定的部分。不要把这个指代写入 Memory。';
}
async function _buildSingleChatContext(cfg,opts){
  opts=opts||{};
  var _ctxText=opts.userMessage||'';
  var ss=opts.ss||{enabled:false};
  var summaryText=opts.summaryText||null;
  var _targetThread=opts.threadId||null;
  var _referenceCore=window.IBChatReferenceResolution||null;
  var _referenceInput={userMessage:_ctxText,history:opts.referenceHistory||opts.dialogueHistory||[],currentMessageId:opts.currentMessageId||'',
    conversationId:opts.conversationId||'',friendId:opts.friendId||'',threadId:_targetThread||null,mode:'recall'};
  var _referenceResolution=opts.referenceResolution||await _ibResolveChatMemoryReference(cfg,_referenceInput);
  if(_referenceCore&&_referenceCore.needsResolution(_ctxText)){
    var _referenceValidation=null;try{_referenceValidation=_referenceCore.validateForTurn(_referenceResolution,_referenceInput)}catch(_referenceValidationError){}
    _referenceResolution=_referenceValidation&&_referenceValidation.resolution||_referenceCore.unresolved(_referenceInput,'resolution-invalid');
  }
  let sysContent=cfg.systemPrompt||'';
  if(cfg.nickname)sysContent=(sysContent?sysContent+'\n':'')+'你的身份/昵称是「'+cfg.nickname+'」。';
  if(cfg.relationship)sysContent=(sysContent?sysContent+'\n':'')+'你和对方的关系是：'+cfg.relationship+'。';
  /* ── 可选上下文按需化（Phase 1）· 逐轮注入信号 ──
     信号一律来自结构化事实源（待注入队列 / 附件 / 真实实体名 / ICode 入口状态 /
     角色能力开关），聚合逻辑在 assets/js/chat-context-signals.js，此处不做词表判定。
     任一信号缺失时，对应块退回"按需判定"的保守侧，绝不因为信号异常而漏掉必要能力。 */
  var _signals=null;
  try{
    if(window.IBContextSignals&&typeof window.IBContextSignals.workspaceInstrNeeded==='function'){
      _signals={fileOutput:await window.IBContextSignals.workspaceInstrNeeded({userMessage:_ctxText,history:(opts.history||null),attachments:(opts.sentFiles||null)})};
    }
  }catch(_sigErr){console.warn('[ContextSignals] resolve failed',String(_sigErr&&_sigErr.message||_sigErr).slice(0,120))}
  /* 日志段：用户消息里是否逐字提到某篇真实存在（且未锁定）的日志标题 */
  /* P11-3X-C：posts 是**一次全表读取**（实测 300 篇 ≈ 144KB 反序列化）。
     修复前这一轮要读两次：这里读一次判 `logs` 信号，buildSiteContext 内部
     再读一次取标题+摘要。现在把这一份**同一次读取的结果**传给 buildSiteContext
     复用（`opts.posts`），两侧看到的本就是同一批行，行为无差、读放大减半。
     信号模块缺失（_signals 为 null）时不预读 → 由 buildSiteContext 自行读取，
     与改动前逐字相同。 */
  let _postsForSite=null;
  if(_signals){
    _signals.logs=false;
    try{
      const _posts=await dbGetAll('posts');
      _postsForSite=_posts;
      if(_ctxText&&String(_ctxText).trim().length>=2){
        for(const _p of _posts){
          if(isLockedPost(_p))continue;
          const _t=String((_p&&_p.title)||'').trim();
          if(_t.length>=2&&String(_ctxText).indexOf(_t)>=0){_signals.logs=true;break}
        }
      }
    }catch(_pErr){_signals.logs=false;_postsForSite=null}
    _signals.blogRead=!!_signals.logs;/* Blog 阅读申请只在模型确实看得到日志标题时才有意义 */
  }
  const _siteRes=await buildSiteContext(_signals,_postsForSite?{posts:_postsForSite}:null);
  const siteCtx=(_siteRes==null)?'':String(_siteRes);
  if(siteCtx){sysContent=(sysContent?sysContent+'\n\n':'')+siteCtx}
  if(_siteRes&&_siteRes.blogRead)sysContent+=_BLOG_READ_INSTR_BLOCK;/* Blog 阅读申请指令：仅当本轮确实带上了日志列表时注入（1对1 专用，群聊不开放） */
  let _amInj={sys:'',tail:''};
  if(amEnabled(cfg)){try{_amInj=await amBuildInject(cfg,_ctxText,{chatImplicit:true})}catch(e){}}
  if(_amInj.sys)sysContent=(sysContent?sysContent+'\n\n':'')+_amInj.sys;
  /* 日历：本轮的"日历栏"只构建**一次**。buildTail 带台账副作用（每次渲染「〔未提及〕」标记
     都会把 shown 计数 +1，满 3 次即转为"已提及"），因此绝不能为了门控再算第二遍——那会让
     计数走两倍速、改变既有的可见性行为。下面注入 _tailCtx 时复用同一份产物。
     便笺指令（buildSys）只在"这一栏真的非空"时才注入。 */
  let _calTailForGate='';
  try{if(window.IBCAL){_calTailForGate=await IBCAL.buildTail(cfg)||''}}catch(e){}
  try{
    if(window.IBCAL&&window.IBContextSignals&&typeof window.IBContextSignals.calendarNoteNeeded==='function'&&window.IBContextSignals.calendarNoteNeeded(_calTailForGate)){
      const _calSys=await IBCAL.buildSys(cfg);if(_calSys)sysContent=(sysContent?sysContent+'\n\n':'')+_calSys;
    }
  }catch(e){}
  let _threadMemOk=true;
  if(_targetThread){const _thr=await (async()=>{try{return await dbGet('chatThreads',_targetThread)}catch(e){return null}})();_threadMemOk=_thr&&_thr.memoryEnabled}
  let _tailCtx='';
  /* ── C1（P2-03）· context retrieval ownership ──
     单聊一轮中 Memory/Understanding/Thread/Moments 各读取一次，结果同时供 Middle Brain 复用；
     _ctxJoined 精确记录这四个块在 tail 中的拼接位置，供 Middle Brain 成功时**替换**（不追加双份）。
     Middle Brain 收到的是"已读取结果"：'' 表示已读但无内容（禁止 fallback 再读），
     undefined 才表示调用方没提供（允许它自行 retrieval）。 */
  let _ctxJoined='',_ctxStart=-1,_memCtx='',_uCtx='',_tCtx='',_momCtx='';
  /* ── M1-C.2o · 当前对话证据（共享核心）─────────────────────────────────
     P0 审计：本函数此前**不传** dialogue，于是组织层得到 `organized.dialogue = []`，
     注入块里没有【当前对话】段，而 Home Node 传的是它自己那份投影 ——
     同一个当前回合在两端被喂了不同的对话证据（实测 dialogueChars 21 vs 83）。
     现在两端都用同一个核心（assets/js/dialogue-core.js）。
     输入取 `opts.dialogueHistory`：**本轮真的交给模型的那一段 canonical 历史**
     （调用方在 communication.js:2121 已按阶梯窗口切好），而不是第三次读取 ——
     "模型看的对话"与"证据里的对话"必须是同一段，否则本收敛毫无意义。
     currentId 为 null：浏览器侧的用户行 id 是在 :2063 的 dbPut 里就地生成的
     （`'msg_'+Date.now()+'_u'`），不经过本函数；共享核心因此走"末行原位重复"
     那条判据，语义等价（见 dialogue-core.js 规则 ④）。 */
  let _dlgLines=[];
  try{
    var _dlgCore=window.IBDialogueCore;
    if(_dlgCore&&typeof _dlgCore.lines==='function'){
      _dlgLines=_dlgCore.lines({history:opts.dialogueHistory||null, userMessage:_ctxText, currentId:null});
    }
  }catch(_dlgErr){console.warn('[Dialogue] evidence build failed',String(_dlgErr&&_dlgErr.message||_dlgErr).slice(0,120))}
  /* === P21-R4-LIVE-3.4 · CUTOVER CONSUMPTION SEAM (Node-sliceable, no DOM) === */
/* Desktop 召回权威 cutover：本轮起，"谁进 prompt"由 Home Node 决定。
   浏览器只做两件事：把**最小原始 turn 信号**送上去；把返回的**有界上下文**原样注入。
   这条路径**没有** browserSelect 之类的入参 —— 浏览器选择根本无从进入。
   失败语义（§23/§24 冻结）：服务端不可用 ⇒ 本轮没有记忆上下文，聊天照常继续；
   **绝不**回落到浏览器选择权威（否则 RECALL_SELECTION_AUTHORITY = SERVER 就是假话）。 */
var RECALL_WAIT_TIMEOUT_MS = 2500;    /* 客户端外层兜底：绝不无限阻塞 first token */
var RECALL_REQUEST_TIMEOUT_MS = 2000; /* 传给服务端的请求内层界（服务端 MAX 10000） */
async function ibRecallContextForTurn(input){
  var o = input || {};
  var unavailable = { context:'', selectedIds:[], authority:'SERVER_UNAVAILABLE', browserFallback:false, behaviorEffect:null, responseGuidance:null, responseGuidanceIdentity:null };
  var recall = null;
  if(typeof o.serverRecall === 'function'){ recall = o.serverRecall; }
  else{
    try{
      var _rt = (typeof window !== 'undefined' && window.IB && window.IB.homeNode && window.IB.homeNode.runtime) || null;
      if(_rt && typeof _rt.runMemoryRecall === 'function'){ recall = _rt.runMemoryRecall; }
    }catch(_e0){ recall = null; }
  }
  if(!recall){ return unavailable; }
  /* 请求身份**复用既有事实源**，绝不 Date.now()/Math.random()/临时 UUID：
     requestId = 本回合既有的 turnId；conversationId = chat-core 的 canonical 派生。 */
  var payload = {
    operation: 'memory-recall',
    mode: 'authoritative',
    characterId: (o.characterId == null) ? '' : String(o.characterId),
    requestId: (o.requestId == null) ? '' : String(o.requestId),
    conversationId: (o.conversationId == null) ? '' : String(o.conversationId),
    message: (o.message == null) ? '' : String(o.message)
  };
  if(typeof o.groundedQuery==='string'&&o.groundedQuery.trim()&&o.groundedQuery!==payload.message){
    payload.groundedQuery=o.groundedQuery.trim();
  }
  if(o.isFirstTurn === true) payload.isFirstTurn = true;
  if(o.conversationSignalAvailable === true) payload.conversationSignalAvailable = true;
  if(o.isGroup === true) payload.isGroup = true;
  var out = null;
  try{
    var _call = Promise.resolve(recall(payload, { timeoutMs: RECALL_REQUEST_TIMEOUT_MS }));
    /* 外层有界等待：本地 loopback 也必须 bounded，绝不无限阻塞 first token。 */
    out = await Promise.race([ _call, new Promise(function(res){ setTimeout(function(){ res(null); }, RECALL_WAIT_TIMEOUT_MS); }) ]);
  }catch(_err){ out = null; }
  if(!out || out.ok !== true){ return unavailable; }
  /* 本轮召回由 Home Node 权威执行（它自己写 exposure / 推进 session）：
     在 turn 对象上打标，下面两处 exposure 写入据此跳过，避免 dual exposure。 */
  if(o.turn && typeof o.turn === 'object'){ o.turn._ibRecallAuthority = 'SERVER'; }
  var text = (out.context && typeof out.context.text === 'string') ? out.context.text : '';
  _ibRememberRecallSelection(payload,out.selectedIds);
  var responseGuidance = (out.context && out.context.responseGuidance && typeof out.context.responseGuidance === 'object')
    ? out.context.responseGuidance : null;
  return {
    context: text,
    selectedIds: Array.isArray(out.selectedIds) ? out.selectedIds.slice() : [],
    authority: 'SERVER',
    browserFallback: false,
    responseGuidance: responseGuidance,
    responseGuidanceIdentity: responseGuidance && responseGuidance.turnIdentity ? {
      characterId: String(o.characterId || ''),
      conversationId: String(o.conversationId || ''),
      requestId: String(o.requestId || ''),
      turnId: String(responseGuidance.turnIdentity.turnId || '')
    } : null,
    /* ── P21-R4-F.2 · 第 17 键：**原样透传** server-owned 闭合对象（或 null）──
       浏览器不重算、不补字段、不推断、不按 L3/L5 文本构造、不按 memory 重新派生。
       非对象（协议外的形状）⇒ null：这是「没有可信效果」的忠实表示，
       不是 fallback 推断 —— renderer 还会再校验一次（双层 fail closed）。 */
    behaviorEffect: (out.behaviorEffect && typeof out.behaviorEffect === 'object') ? out.behaviorEffect : null
  };
}
/* === end seam === */
const _pushCtxBlock=function(text){if(!text)return;const sep=_tailCtx?'\n\n':'';if(_ctxStart<0)_ctxStart=_tailCtx.length;_tailCtx+=sep+text;_ctxJoined+=sep+text;};
if(_referenceResolution&&_referenceResolution.state!=='NOT_APPLICABLE')_pushCtxBlock(_ibReferenceGroundingGuidance(_referenceResolution));
  _tailCtx+='当前时间：'+new Date().toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'})+'。';
  try{if(ss.musicEnabled&&currentTrackIdx>=0&&!audioEl.paused&&playlist[currentTrackIdx])_tailCtx+='正在听：《'+playlist[currentTrackIdx].name+'》。';}catch(e){}
  try{if(_calTailForGate)_tailCtx+='\n\n'+_calTailForGate}catch(e){}/* 复用上面那一次 buildTail 产物（不再重算，避免台账计数走两倍） */
  if(summaryText)_tailCtx+='\n\n【对话历史备忘（此为后台参考信息，不要向对方复述或提及此段内容的存在）】\n'+summaryText;
  /* ── P11-3X-C · 本回合唯一的输入预算分配 ──────────────────────────────
     到这里为止，不可丢的部分都已定稿：sysContent（system/persona/关系/站点/
     工具块）、_tailCtx 里已经确定的非梯子块（时间/音乐/日历/摘要）、以及本回合
     真正要发的 history（opts.dialogueHistory = 调用方切好的阶梯窗口）与当前
     用户消息。可压缩块的额度就在这里**一次性**算出来，然后交给下面五个 producer
     各自**已有的**预算参数（maxChars / maxThreads）—— 不新增任何截断器。
     未超预算时每一项都是 null → 调用形状与改动前逐字相同。 */
  const _bAlloc=_ibAllocateCompressible(cfg,{
    system:sysContent,
    fixedTail:_tailCtx,
    history:opts.dialogueHistory||null,
    userMessage:_ctxText,
    caps:{memory:await (async()=>{try{const _ms=await getMemorySettings();return _ms&&_ms.budget?_ms.budget:DEFAULT_MEM_BUDGET}catch(e){return DEFAULT_MEM_BUDGET}})()}
  });
  const _bf=_bAlloc?_bAlloc.plan.fractions:null;
  const _bMemChars=_bf?_ibScaledCap((_bAlloc.caps&&_bAlloc.caps.memory)||DEFAULT_MEM_BUDGET,_bf.memory,100):null;
  const _bMomChars=_bf?_ibScaledCap(_IB_BUDGET_CAP_TOKENS.moments,_bf.moments,120):null;
  const _bUndChars=_bf?_ibScaledCap(_IB_BUDGET_CAP_TOKENS.understanding,_bf.understanding,60):null;
  const _bThreads=_bf?_ibScaledCap(3,_bf.thread,1):null;
  const _bActChars=_bf?_ibScaledCap(_IB_BUDGET_CAP_TOKENS.activity,_bf.activity,300):null;
  /* P21-R2-E1a · ColdStart 会话信号（latent）：由 send 点在本条消息落库前探得。
     这里逐项透传 —— 只探到这一层而不往下给，信号会在链路上静默丢失。 */
  var _cs=(opts&&opts.coldStart)||null;
  var _csOpts=_cs?{conversationId:_cs.conversationId,isFirstTurn:_cs.isFirstTurn===true,conversationSignalAvailable:_cs.conversationSignalAvailable===true}:null;
  /* F1b：turnIndex 由调用方在 retrieval 之前 begin 得到；这里只做透传。 */
  var _ibRecallOpts={};
  if(opts&&opts.sessionState)_ibRecallOpts.sessionState=opts.sessionState;
  if(opts&&opts.turnIndex!=null)_ibRecallOpts.turnIndex=opts.turnIndex;
  if(opts&&opts._ibTurn)_ibRecallOpts._ibTurn=opts._ibTurn;
  if(_threadMemOk){
    var _refRequired=!!(_referenceCore&&_referenceCore.needsResolution(_ctxText));
    if(!_refRequired||(_referenceResolution&&_referenceResolution.state==='RESOLVED')){
      var _groundedRecallQuery=_refRequired?(_referenceResolution.groundedQuery||_referenceResolution.normalizedMeaning):undefined;
      var _srvR=await ibRecallContextForTurn({characterId:cfg.id,message:_ctxText,groundedQuery:_groundedRecallQuery,isGroup:false,requestId:(opts&&opts.turnId)||'',conversationId:(opts&&opts.conversationId)||'',isFirstTurn:!!(_cs&&_cs.isFirstTurn===true),conversationSignalAvailable:!!(_cs&&_cs.conversationSignalAvailable===true),turn:(opts&&opts._ibRecallTurnMark)||null});_memCtx=_srvR.context;_pushCtxBlock(_memCtx);
    }
  }
  /* Understanding + Thread（v1）· 走 tail（末条 user 消息），绝不进 system（保 prompt cache 稳定）。 */
  try{if(_threadMemOk&&typeof getUnderstandingContext==='function'){_uCtx=await getUnderstandingContext(cfg.id,_bUndChars?{maxChars:_bUndChars}:undefined);_pushCtxBlock(_uCtx);}}catch(_uErr){console.warn('[Understanding] ctx failed',String(_uErr&&_uErr.message||_uErr).slice(0,120))}
  try{if(_threadMemOk&&typeof getThreadContext==='function'){_tCtx=await getThreadContext(cfg.id,_bThreads?{maxThreads:_bThreads}:undefined);_pushCtxBlock(_tCtx);}}catch(_tErr){console.warn('[Thread] ctx failed',String(_tErr&&_tErr.message||_tErr).slice(0,120))}
  try{if(_threadMemOk&&typeof getMomentsContext==='function'){_momCtx=await getMomentsContext(cfg.id,_bMomChars?{userMessage:_ctxText,maxChars:_bMomChars}:{userMessage:_ctxText});_pushCtxBlock(_momCtx);}}catch(_momErr){console.warn('[Moments] chat context failed',String(_momErr&&_momErr.message||_momErr).slice(0,120))}
  if(_amInj.tail)_tailCtx+=(_tailCtx?'\n\n':'')+_amInj.tail;
  /* ── C2 step 1 · canonical Context 快照（只读）──
     把本轮已读取的四个 producer 结果收成一个只读快照（producer / value / empty-vs-missing /
     visibility 标记），与 Middle Brain 共用同一个对象；**不改注入顺序、不改任何 producer 算法**。
     _threadMemOk=false 时四个 producer 未读取 → 记为 missing（gatedBy 说明门控来源），
     语义等价于 C1 的 opts.*Ctx === undefined。 */
  var _ctxSnapshot=null;
  try{
    var _CS=window.IBContextSnapshot;
    if(_CS&&typeof _CS.create==='function'){
      var _snapMissing=!_threadMemOk,_snapGated=_threadMemOk?null:'thread.memoryEnabled';
      var _snapField=function(producer,text){return _CS.field(producer,text,{missing:_snapMissing,gatedBy:_snapGated});};
      _ctxSnapshot=_CS.create({
        characterId:String(cfg.id||''),
        turnId:String((opts&&opts.turnId)||''),
        fields:{
          memory:_snapField('getMemoryContext',_memCtx),
          understanding:_snapField('getUnderstandingContext',_uCtx),
          thread:_snapField('getThreadContext',_tCtx),
          moments:_snapField('getMomentsContext',_momCtx)
        },
        gates:{threadMemoryEnabled:!!_threadMemOk}
      });
    }
  }catch(_snapErr){console.warn('[ContextSnapshot] build failed',String(_snapErr&&_snapErr.message||_snapErr).slice(0,120))}
  /* Middle Brain (Astra) · 认知协调层：
     - 消费上面已读取的四个块（memoryCtx/understandingCtx/threadCtx/momentsCtx），不再自行 retrieval
       → 消除同轮重复读取与重复 activation；
     - source 三态（P11-3 收敛）：'astra' → 使用 Astra 处理结果；'local' → 使用本地 pipeline 处理结果；
       'bypass'（null / 未启用 / 失败 / 空产物）→ 原样保留四个块。
       两种具名来源都是"这四个块的处理结果"，因此一律**替换**原块（禁止原块 + 处理结果双份注入）。 */
  try{
    /* P11-1C：production 只经 canonical facade IB.middleBrain 的 canonical execution seam
       middleBrainExecute（其内部 = readiness 判定 + pipeline）。调用方不再读 window 兼容别名，
       也不再自行编排 readiness → pipeline 两步。
       P11-3：是否注入由下面的显式三态注入契约 _mbInjectable 判定（不再硬编码 source==='astra'）。 */
    var _mbFacade=(window.IB&&window.IB.middleBrain)||null;
    var _mbTrSink=(window.IB&&window.IB.__mbTrace)||null;
    var _mbSysBefore=sysContent,_mbInjected=false,_mbSource='bypass';
    if(_threadMemOk&&_mbFacade&&typeof _mbFacade.middleBrainExecute==='function'){
      var _mbRes=await _mbFacade.middleBrainExecute(cfg.id, _ctxText||'', {
        memoryCtx:_memCtx, understandingCtx:_uCtx, threadCtx:_tCtx, momentsCtx:_momCtx,
        /* M1-C.2o：当前对话证据（共享核心产出，见本函数上方 _dlgLines）。
           与 Home Node 的 `dialogue: dialogueFrom(history, userMessage, currentMessageId)`
           **是同一个实现、同一段输入语义** —— 这就是"同一段对话在两个宿主上被投影成
           同一段证据"那条契约的桌面一侧。 */
        dialogue:_dlgLines,
        /* C2 step 1：同一个只读快照一并交给 Middle Brain（其 organize 优先读快照，见 middle-brain-policy.js）。
           两者值逐位一致，快照缺失时 MB 回落到 opts.*Ctx → 行为与 C1 完全相同。 */
        contextSnapshot:_ctxSnapshot
      });
      _mbSource=String((_mbRes&&_mbRes.source)||'')||'bypass';
      if(_mbInjectable(_mbRes,_ctxText||'')){
        var _mbBlock='【Middle Brain 压缩后的上下文（后台参考，勿向对方复述其存在）】\n'+_mbRes.compressedContext;
        /* 就地替换：用索引切片，不做子串搜索（避免与前面块内容碰巧同形时替换错位置） */
        if(_ctxJoined&&_ctxStart>=0)_tailCtx=_tailCtx.slice(0,_ctxStart)+(_ctxStart>0?'\n\n':'')+_mbBlock+_tailCtx.slice(_ctxStart+_ctxJoined.length);
        else _tailCtx+=(_tailCtx?'\n\n':'')+_mbBlock;
        _mbInjected=true;
      }
    }
    /* 观测实测值（不是推断）：本轮 MB 产物来源（astra / local / bypass）、system 是否被改动、
       是否真的替换了注入上下文。三者相互独立：source 只说明"产出了什么"，messagesChanged 才说明"是否到达角色请求"。 */
    if(_mbTrSink){
      _mbTrSink.note(cfg.id,'source',_mbSource);
      _mbTrSink.note(cfg.id,'systemChanged',sysContent!==_mbSysBefore);
      _mbTrSink.note(cfg.id,'messagesChanged',_mbInjected);
    }
  }catch(_mbErr){console.warn('[MiddleBrain] ctx failed',String(_mbErr&&_mbErr.message||_mbErr).slice(0,120))}
  try{if(_threadMemOk&&typeof getActivityContext==='function'){const _actCtx=await getActivityContext(cfg.id,{userMessage:_ctxText,threadId:_targetThread,maxChars:_bActChars||undefined,activity:((opts&&Object.prototype.hasOwnProperty.call(opts,'activity'))?opts.activity:undefined)});
  if(_actCtx)_tailCtx+=(_tailCtx?'\n\n':'')+_actCtx;}}catch(_actErr){console.warn('[Activity] chat context failed',String(_actErr&&_actErr.message||_actErr).slice(0,120))}
  /* P30-2 · 1:1 注入按**会话归属**过滤：只消费属于本会话的条目；其它会话的条目留在队列
     （scope 缺失的 unscoped/legacy 条目仍放行 ⇒ 旧行为不变）。Blog 队列不在本阶段范围。 */
  /* 本函数的会话键：由调用方透传 `opts.friendId`（1:1 = 角色 id；role-dm 等沿用调用方给的值）；
     cfg.id 只作兜底（1:1 场景二者同值），**绝不**用于群聊（群走 `_buildGroupChatContext`）。 */
  const _wsScopeMine=_ibWsScopeFilter(String(opts.friendId||cfg.id||''),opts.threadId||null);
  /* P30-5 · Blog 注入同样按当前会话过滤（mismatch KEEP；legacy string feedback 放行）。 */
  const _wsReadCtx=_getWsReadInjection(_wsScopeMine)+_getWsOpFeedbackInjection(_wsScopeMine)+_getWsRunOutputInjection(_wsScopeMine)+_getIbToolResultInjection(_wsScopeMine)+_getBlogReadInjection(_wsScopeMine);
  if(_wsReadCtx)_tailCtx+=(_tailCtx?'\n':'')+_wsReadCtx;
  try{if(_ibModelCanSee(cfg))sysContent+=_VISION_DECLARE}catch(e){}
  try{sysContent+='\n\n【撤回】如果你意识到自己上一条消息说错了话（比如 @ 错了人、说错了事实、语气不对），可以在本条回复里输出 <withdraw/>，系统会撤回你上一条消息并提示"XX撤回了一条消息"。只有确实说错时才用，不要频繁使用。'}catch(e){}
  /* 图像生成：能力开关仍由 cfg.imageGen 决定；说明只在"本轮可能真的要用标签"时注入
     （见 chat-context-signals.imageGenInstrNeeded）。门控信号缺失时保守注入，绝不削弱能力。 */
  if(cfg.imageGen&&_imgGenInstrNeeded(_ctxText,opts.sentFiles))sysContent+=_IMGGEN_INSTR_BLOCK;
  /* 全局短回合策略：仅当用户未明确要求详细时注入；voice 时明显短于 text。
     角色级「简洁回复」（cfg.replyStyle==='concise'）时换成更克制的简洁约束；
     「自然收尾」（cfg.naturalEnding===true）与「简洁回复」相互独立，在末尾追加；
     「保持对话连贯」（cfg.conversationContinuity===true）同样相互独立，可自由组合。 */
  try{if(window.IB&&IB.brevity){const _bd=!!opts.voice;sysContent=IB.brevity.apply(sysContent,{mode:_bd?'voice':'text',detailed:IB.brevity.isDetailedRequest(_ctxText),concise:!!(cfg&&cfg.replyStyle==='concise'),naturalEnding:!!(cfg&&cfg.naturalEnding),conversationContinuity:!!(cfg&&cfg.conversationContinuity),emotionalTexture:!_bd});}}catch(e){}
  /* ── P11-3X-C · 本回合的实测量测（唯一一次），供如实上报与测试取证 ──
     量的是**真正要发出去的东西**：最终 sysContent + 调用方切好的 history +
     末条用户消息（用户自己那句 + 注入的 tail）。total 是估算 token，
     over/irreducible 取自决定本次额度的那个 plan（worst case 判定）。 */
  let _bFinal=null;
  try{
    if(_bAlloc){
      const _core=_bAlloc.core;
      const _hist=opts.dialogueHistory||[];
      let _histTok=0;for(const _hm of _hist)_histTok+=_core.estimateTokens(_core.contentText(_hm&&_hm.content));
      const _act=_core.measure([{role:'system',content:sysContent},{role:'user',content:String(_ctxText||'')+_CTX_TAIL_SEP+_tailCtx}],
        {injectedTokens:_core.estimateTokens(_CTX_TAIL_SEP+_tailCtx)});
      _bFinal={
        ceiling:_bAlloc.plan.ceiling,reserve:_bAlloc.plan.reserve,inputBudget:_bAlloc.plan.inputBudget,
        inputTokens:_act.inputTokens+_histTok,
        parts:{system:_act.parts.system,current:_act.parts.current,injected:_act.parts.injected,
               history:_histTok,tools:_bAlloc.plan.summary.parts.tools},
        plannedOver:!!_bAlloc.plan.over, irreducible:!!_bAlloc.plan.irreducible,
        over:(_act.inputTokens+_histTok)>_bAlloc.plan.inputBudget,
        ladder:_bAlloc.plan.summary.ladder
      };
      _ibBudgetRecord(Object.assign({at:Date.now(),kind:opts.isGroup?'group':'chat',characterId:String((cfg&&cfg.id)||'')},_bFinal));
      /* 只在**真实**超预算时报警（计划的 worst case 判定只用于分配，不当作事实） */
      if(_bFinal.over)_ibBudgetLog(opts.isGroup?'group':'chat',_bAlloc,'actual~'+_bFinal.inputTokens+' tok');
    }
  }catch(_bErr){console.warn('[ContextBudget] measure failed',String(_bErr&&_bErr.message||_bErr).slice(0,120))}
  if(opts._ibTraceId){
    var _traceMemoryField=_ctxSnapshot&&_ctxSnapshot.fields&&_ctxSnapshot.fields.memory;
    _ibTurnTraceEvent(opts._ibTraceId,'memory',{
      memoryState:String((_traceMemoryField&&_traceMemoryField.state)||(_memCtx?'present':'missing')),
      memoryChars:String(_memCtx||'').length,
      memoryItems:Array.isArray(_srvR&&_srvR.selectedIds)?_srvR.selectedIds.length:0,
      memoryAuthority:String((_srvR&&_srvR.authority)||(_threadMemOk?'no-selection':'gated'))
    });
    _ibTurnTraceEvent(opts._ibTraceId,'middle_brain',{mbSource:String(_mbSource||'bypass'),mbInjected:!!_mbInjected});
    _ibTurnTraceEvent(opts._ibTraceId,'context',{contextChars:String(sysContent||'').length+String(_tailCtx||'').length,
      systemChars:String(sysContent||'').length,tailChars:String(_tailCtx||'').length,
      contextTokens:_bFinal&&Number(_bFinal.inputTokens)||0});
  }
  return {system:sysContent, tail:_tailCtx, snapshot:_ctxSnapshot, budget:_bFinal, referenceResolution:_referenceResolution,
    responseGuidance:(_srvR&&_srvR.responseGuidance)||null,
    responseGuidanceIdentity:(_srvR&&_srvR.responseGuidanceIdentity)||null,
    behaviorEffect:(_srvR&&_srvR.behaviorEffect)||null};
}
async function _buildGroupChatContext(cfg,opts){
  opts=opts||{};
  /* ── P11-2H · 唯一的消毒点，在**任何**值进入 prompt 之前 ────────────
     为什么放在这里而不是上游派生处：`opts.selfName` / `opts.allNames` 由
     调用方从角色 DTO 派生（cfg.nickname||cfg.model），归一到此处做一次，
     规则只有一个入口。放在上游会让"派生处消毒了、别处没有"重新变成可能。
     代价是同一份消毒对同一批名字多跑一次（纯函数、O(n)），接受。 */
  var selfName=_pbSanitize(opts.selfName||'',    'group.selfName')||'AI';
  var allNames=_pbSanitizeNames(opts.allNames||[], 'group.allNames');
  var userDesc=_pbSanitize(opts.userDesc||'',    'group.userDesc');
  var group=opts.group||{};
  var gss=opts.gss||{enabled:false};
  var gSummaryText=opts.gSummaryText||null;
  var _ctxText=opts.userMessage||'';
  var _referenceCore=window.IBChatReferenceResolution||null;
  var _referenceInput={userMessage:_ctxText,history:opts.referenceHistory||opts.history||[],currentMessageId:opts.currentMessageId||'',
    conversationId:opts.conversationId||'',friendId:String(group.id||''),threadId:opts.threadId||null,isGroup:true,mode:'recall'};
  var _referenceResolution=opts.referenceResolution||await _ibResolveChatMemoryReference(cfg,_referenceInput);
  if(_referenceCore&&_referenceCore.needsResolution(_ctxText)){
    var _referenceValidation=null;try{_referenceValidation=_referenceCore.validateForTurn(_referenceResolution,_referenceInput)}catch(_referenceValidationError){}
    _referenceResolution=_referenceValidation&&_referenceValidation.resolution||_referenceCore.unresolved(_referenceInput,'resolution-invalid');
  }
  var isFirstTurn=!!opts.isFirstTurn;
  let sysContent=cfg.systemPrompt||'';
  /* relationship 同属用户可控角色 metadata，且与群名同一类风险（成段自由文本）。
     空值不注入 —— 与既有 `if(cfg.relationship)` 门控一致，不新增"空关系"行。 */
  const _rel=_pbSanitize(cfg.relationship||'','group.relationship');
  if(_rel)sysContent=(sysContent?sysContent+'\n':'')+'你和对方的关系是：'+_rel+'。';
  const otherNames=allNames.filter(n=>n!==selfName);
  /* 群名可能是空（既有数据模型允许 name:''）。空值注入会让规则块出现
     `你是群聊""中的成员` —— 语义上是"没有名字"，形状上却不完整。
     用一个明确的占位而不是空串：占位本身也是受控常量。
     selfName 用同一个纪律，但占位取代码库里**既有**的 `||'AI'` 约定
     （见 social.js 的成员标签、_mbGroupTraceContext 的调用方），
     而不是新造一个词 —— 空引号对 `以""的身份发言` 会让规则失去可指称的对象。 */
  const _gName=_pbSanitize(group.name||'','group.name')||'（未命名群聊）';
  sysContent=(sysContent?sysContent+'\n\n':'')
    +'【群聊规则】你是群聊"'+_gName+'"中的成员"'+selfName+'"。'
    +(otherNames.length?('群里还有其他AI成员：'+otherNames.join('、')+'，以及'+userDesc+'。'):('群里还有'+userDesc+'。'))
    +'\n1. 你只能以"'+selfName+'"的身份发言，每次只输出你自己要说的一段话。'
    +'\n2. 绝对不要替其他成员或用户发言、代答、补写他们的台词或动作。即使用户点名了其他成员，也只回答属于你的部分，把他们的部分留给他们自己说。'
    +'\n3. 不要在回复开头加"['+selfName+']"等任何名字前缀，界面会自动标注你的名字。'
    +'\n4. 历史消息中带[名字]前缀的内容是用户或其他成员说的话，仅供你阅读参考。';
  /* 群聊：与单聊同一套逐轮门控（工作区指令/日志段），成员各自独立判定；
     群聊不注入 Blog 阅读申请（既有契约）。 */
  let _gSiteSignals={profile:true,logs:false,fileOutput:true,blogRead:false};
  try{
    if(window.IBContextSignals&&typeof window.IBContextSignals.workspaceInstrNeeded==='function'){
      _gSiteSignals.fileOutput=await window.IBContextSignals.workspaceInstrNeeded({userMessage:_ctxText,history:opts.history||null,attachments:(opts.sentFiles||null)});
    }
  }catch(_gSigErr){console.warn('[ContextSignals] group resolve failed',String(_gSigErr&&_gSigErr.message||_gSigErr).slice(0,120))}
  var _gPostsForSite=null;
  try{
    if(_ctxText&&String(_ctxText).trim().length>=2){
      const _gPosts=await dbGetAll('posts');
      _gPostsForSite=_gPosts;
      for(const _gp of _gPosts){
        if(isLockedPost(_gp))continue;
        const _gt=String((_gp&&_gp.title)||'').trim();
        if(_gt.length>=2&&String(_ctxText).indexOf(_gt)>=0){_gSiteSignals.logs=true;break}
      }
    }
  }catch(_gSiteErr){_gSiteSignals.logs=false;_gPostsForSite=null}
  const _gSiteRes=await buildSiteContext(_gSiteSignals,_gPostsForSite?{posts:_gPostsForSite}:null);
  const siteCtx=(_gSiteRes==null)?'':String(_gSiteRes);
  if(siteCtx)sysContent+='\n\n'+siteCtx;
  let _gAmInj={sys:'',tail:''};
  if(amEnabled(cfg)){try{_gAmInj=await amBuildInject(cfg,_ctxText)}catch(e){}}
  if(_gAmInj.sys)sysContent+='\n\n'+_gAmInj.sys;
  let _gTailCtx='';
  _gTailCtx+='当前时间：'+new Date().toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'})+'。';
  try{if(gss.musicEnabled&&currentTrackIdx>=0&&!audioEl.paused&&playlist[currentTrackIdx])_gTailCtx+='正在听：'+playlist[currentTrackIdx].name+'。';}catch(e){}
  if(gSummaryText)_gTailCtx+='\n\n【对话历史备忘（此为后台参考信息，不要向对方复述或提及此段内容的存在）】\n'+gSummaryText;
  if(_referenceResolution&&_referenceResolution.state!=='NOT_APPLICABLE')_gTailCtx+=(_gTailCtx?'\n\n':'')+_ibReferenceGroundingGuidance(_referenceResolution);
  /* ── P11-3X-C · 群聊宿主回合的同一份输入预算分配 ──────────────────────
     群聊只注入 memory 一个可压缩块（不注入 understanding / thread / moments /
     activity），因此梯子的其余几级上限记 0；history 与当前消息照常参与共享预算。
     未超预算时 _bGMemChars 为 null → 群聊的 memory 调用形状与改动前逐字相同
     （含它一直沿用的 maxChars:1500）。 */
  const _bGAlloc=_ibAllocateCompressible(cfg,{
    system:sysContent,
    fixedTail:_gTailCtx,
    history:opts.history||null,
    userMessage:_ctxText,
    caps:{memory:1500,moments:0,understanding:0,thread:0,activity:0}
  });
  const _bGMemChars=(_bGAlloc&&_bGAlloc.plan.fractions)?_ibScaledCap(1500,_bGAlloc.plan.fractions.memory,100):null;
  var _gResponseGuidance=null,_gResponseGuidanceIdentity=null;
  var _gTraceMemorySeen=false;
  if(group.memoryEnabled){
    const _gRefRequired=!!(_referenceCore&&_referenceCore.needsResolution(_ctxText));
    if(!_gRefRequired||(_referenceResolution&&_referenceResolution.state==='RESOLVED')){
      const _gGroundedRecallQuery=_gRefRequired?(_referenceResolution.groundedQuery||_referenceResolution.normalizedMeaning):undefined;
      const _gSrvR=await ibRecallContextForTurn({characterId:cfg.id,message:_ctxText,groundedQuery:_gGroundedRecallQuery,isGroup:true,requestId:(opts&&opts.turnId)||'',conversationId:(opts&&opts.conversationId)||'',turn:(opts&&opts._ibRecallTurnMark)||null});
      _gResponseGuidance=(_gSrvR&&_gSrvR.responseGuidance)||null;
      _gResponseGuidanceIdentity=(_gSrvR&&_gSrvR.responseGuidanceIdentity)||null;
      const gMemCtx=(_gSrvR&&_gSrvR.context)||'';
      _gTraceMemorySeen=true;
      _ibTurnTraceEvent(opts._ibTraceId,'memory',{memoryState:gMemCtx?'present':'empty',memoryChars:String(gMemCtx).length,
        memoryItems:Array.isArray(_gSrvR&&_gSrvR.selectedIds)?_gSrvR.selectedIds.length:0,
        memoryAuthority:String((_gSrvR&&_gSrvR.authority)||'unknown')});
      if(gMemCtx)_gTailCtx+=(_gTailCtx?'\n\n':'')+gMemCtx;
    }
  }
  if(_gAmInj.tail)_gTailCtx+=(_gTailCtx?'\n\n':'')+_gAmInj.tail;
  /* ── P29-3 · Workspace Actor Canonical Attribution（P29-2 冻结语义）──────────────
     ① actorId 非空 ⇒ **只**比 canonical id；mismatch ⇒ not mine（绝不回退 display 匹配）。
     ② actorId 空 ⇒ legacy：participants 里**唯一精确显示名** ⇒ 归属到该参与者；
        同名歧义（≥2 命中）⇒ not mine（fail closed，永不 SELF）。
     ③ 无主（actor 空，或本群没有任何参与者叫这个名字 —— 例如用户手动跑脚本的 'User'、
        已退出成员）⇒ 保持既有"本轮首个发言者兜底消费"（兼容旧行为，绝不静默丢弃）。
     actor 仍只是显示名；identity 只由 actorId（canonical）或唯一精确名（legacy）决定。 */
  /* P30-2 · 本会话的 canonical conversation 键（派生规则唯一属于 chat-core，经 _ibConvId 调用）。
     friendId 取群 id（= sendChatMessage 的 _targetFriend）；threadId 由调用方透传（群 UI 无话题频道 ⇒ null）。 */
  var _gCurConv=_ibConvId(String(group.id||''),opts.threadId||null);
  /* legacy 归属判定需要的参与者名单：唯一来源 = 群成员表 → apiConfigs 显示名
     （`_ibGroupParticipants(getGroupMemberIds(group))`，与 sendChatMessage 的 `_gParticipants` 同源，
     不新建注册表、不做第二次 DB 读）。**惰性构建**：canonical 路径（有 actorId）根本不碰它。 */
  var _gInjParts=null;
  function _gInjParticipants(){
    if(_gInjParts)return _gInjParts;
    _gInjParts=[];
    try{
      if(typeof _ibGroupParticipants==='function'&&typeof getGroupMemberIds==='function'&&group){
        _gInjParts=_ibGroupParticipants(getGroupMemberIds(group));
      }
    }catch(e){_gInjParts=[]}
    return _gInjParts;
  }
  var _gInjMine=function(it){
    /* ① P30-2 · 会话归属（WHERE）：条目声明了 friendId 就必须与本会话一致；
       不一致 ⇒ not mine（留在队列，等待其所属会话）。无 friendId ⇒ unscoped/legacy ⇒ 继续走 ②③。 */
    if(it&&it.friendId&&_ibConvId(it.friendId,it.threadId)!==_gCurConv)return false;
    var _aid=String((it&&it.actorId)||'');
    if(_aid)return _aid===String(cfg.id);
    var _a=String((it&&it.actor)||'');
    var _parts=_gInjParticipants();
    var _hits=0,_only='';
    for(var _hi=0;_hi<_parts.length;_hi++){
      if(_a&&String(_parts[_hi].name||'')===_a){_hits++;_only=String(_parts[_hi].id||'')}
    }
    if(_hits===1)return _only===String(cfg.id);
    if(_hits>1)return false;
    return isFirstTurn;
  };
  var _gWsInject=_getWsReadInjection(_gInjMine)+_getWsOpFeedbackInjection(_gInjMine)+_getWsRunOutputInjection(_gInjMine)+_getIbToolResultInjection(_gInjMine);
  if(_gWsInject)_gTailCtx+=(_gTailCtx?'\n':'')+_gWsInject;
  try{if(_ibModelCanSee(cfg))sysContent+=_VISION_DECLARE}catch(e){}
  try{sysContent+='\n\n【撤回】如果你意识到自己上一条消息说错了话（比如 @ 错了人、说错了事实、语气不对），可以在本条回复里输出 <withdraw/>，系统会撤回你上一条消息并提示"XX撤回了一条消息"。只有确实说错时才用，不要频繁使用。'}catch(e){}
  if(cfg.imageGen&&_imgGenInstrNeeded(_ctxText,opts.sentFiles))sysContent+=_IMGGEN_INSTR_BLOCK;/* 图像生成：按本成员开关注入，同样按轮门控 */
  /* 全局短回合策略（群聊 = text 模式）：仅当用户未明确要求详细时注入。
     本成员开启「简洁回复」（cfg.replyStyle==='concise'）时换成更克制的简洁约束；
     「自然收尾」（cfg.naturalEnding===true）与本成员独立组合，在末尾追加；
     「保持对话连贯」（cfg.conversationContinuity===true）同样按本成员独立组合。 */
  try{if(window.IB&&IB.brevity){sysContent=IB.brevity.apply(sysContent,{mode:'text',detailed:IB.brevity.isDetailedRequest(_ctxText),concise:!!(cfg&&cfg.replyStyle==='concise'),naturalEnding:!!(cfg&&cfg.naturalEnding),conversationContinuity:!!(cfg&&cfg.conversationContinuity),emotionalTexture:true});}}catch(e){}
  let _bGFinal=null;
  try{
    if(_bGAlloc){
      const _core=_bGAlloc.core;
      const _hist=opts.history||[];
      let _histTok=0;for(const _hm of _hist)_histTok+=_core.estimateTokens(_core.contentText(_hm&&_hm.content));
      const _act=_core.measure([{role:'system',content:sysContent},{role:'user',content:String(_ctxText||'')+_CTX_TAIL_SEP+_gTailCtx}],
        {injectedTokens:_core.estimateTokens(_CTX_TAIL_SEP+_gTailCtx)});
      _bGFinal={
        ceiling:_bGAlloc.plan.ceiling,reserve:_bGAlloc.plan.reserve,inputBudget:_bGAlloc.plan.inputBudget,
        inputTokens:_act.inputTokens+_histTok,
        parts:{system:_act.parts.system,current:_act.parts.current,injected:_act.parts.injected,
               history:_histTok,tools:_bGAlloc.plan.summary.parts.tools},
        plannedOver:!!_bGAlloc.plan.over, irreducible:!!_bGAlloc.plan.irreducible,
        over:(_act.inputTokens+_histTok)>_bGAlloc.plan.inputBudget,
        ladder:_bGAlloc.plan.summary.ladder
      };
      _ibBudgetRecord(Object.assign({at:Date.now(),kind:'group',characterId:String((cfg&&cfg.id)||'')},_bGFinal));
      if(_bGFinal.over)_ibBudgetLog('group',_bGAlloc,'actual~'+_bGFinal.inputTokens+' tok');
    }
  }catch(_bGErr){console.warn('[ContextBudget] group measure failed',String(_bGErr&&_bGErr.message||_bGErr).slice(0,120))}
  if(opts._ibTraceId){
    if(!_gTraceMemorySeen)_ibTurnTraceEvent(opts._ibTraceId,'memory',{memoryState:group.memoryEnabled?'unresolved':'gated',memoryAuthority:group.memoryEnabled?'server':'disabled'});
    _ibTurnTraceEvent(opts._ibTraceId,'context',{contextChars:String(sysContent||'').length+String(_gTailCtx||'').length,
      systemChars:String(sysContent||'').length,tailChars:String(_gTailCtx||'').length,contextTokens:_bGFinal&&Number(_bGFinal.inputTokens)||0});
  }
  return {system:sysContent, tail:_gTailCtx, budget:_bGFinal, referenceResolution:_referenceResolution,
    responseGuidance:_gResponseGuidance,responseGuidanceIdentity:_gResponseGuidanceIdentity};
}
async function buildChatContext(cfg,opts){
  opts=opts||{};
  if(opts.isGroup)return await _buildGroupChatContext(cfg,opts);
  return await _buildSingleChatContext(cfg,opts);
}

/* ════ P21-R4-M0 · shared ResponseGuidance envelope → Desktop consumer ════
   R4-F BehaviorEffect remains one source entry; it is not the envelope owner.
   Frozen placement contract (BEHAVIOR_EFFECT_PROMPT_PLACEMENT remains the same):
     · 只插入**一条独立**的 {role:'system'} 消息；绝不写 cfg.systemPrompt /
       sysContent / persona 块 / relationship 块 / _tailCtx / memory context /
       用户消息本体；
     · 顺序：canonical system（下标 0）**先于** behavior guidance（下标 1），
       guidance **先于**普通对话消息。没有 canonical system ⇒ **不放置**
       （绝不让自己成为第一条最高权威 system 而去覆盖 persona）；
     · 输入是 Home Node 返回的 ResponseGuidance envelope；R4-F entry 的 payload
       仍须经既有闭合 7 键 renderer（纯枚举表、零插值），本层不生成 guidance 文本；
     · renderer 缺席 / REFUSED / NO_PLACEMENT / 对象非法 / 没有 canonical system
       ⇒ **一个字符都不加**，聊天照常继续。绝不生成浏览器侧 stance，
       也绝不 best-effort 渲染；
     · 浏览器侧**没有第二套 effect holder**：效果是这一轮 prompt assembly 的
       一次性消费，用完即弃，不写任何地方（见 §20）。
   shared core 与 R4-F renderer 经**既有**动态插入路径懒加载（与 app-store.js 同一手法：
   createElement('script') + appendChild），因此不改 InternalBeyond.html。任一缺席 ⇒ 不放置。 */
var _ibBeRenderPromise=null,_ibResponseGuidanceCorePromise=null;
function _ibBehaviorEffectRenderReady(){
  try{
    if(typeof window!=='undefined'&&window.IBBehaviorEffectRender)return Promise.resolve(window.IBBehaviorEffectRender);
    if(typeof document==='undefined'||typeof document.createElement!=='function')return Promise.resolve(null);
    if(_ibBeRenderPromise)return _ibBeRenderPromise;
    _ibBeRenderPromise=new Promise(function(resolve){
      try{
        var sc=document.createElement('script');
        sc.src='assets/js/behavior-effect-render.js';
        sc.onload=function(){try{resolve(window.IBBehaviorEffectRender||null)}catch(_e){resolve(null)}};
        sc.onerror=function(){resolve(null)};
        (document.head||document.documentElement).appendChild(sc);
      }catch(_e2){resolve(null)}
    });
    return _ibBeRenderPromise;
  }catch(_e3){return Promise.resolve(null)}
}
function _ibResponseGuidanceCoreReady(){
  try{
    if(typeof window!=='undefined'&&window.IBResponseGuidanceCore)return Promise.resolve(window.IBResponseGuidanceCore);
    if(typeof document==='undefined'||typeof document.createElement!=='function')return Promise.resolve(null);
    if(_ibResponseGuidanceCorePromise)return _ibResponseGuidanceCorePromise;
    _ibResponseGuidanceCorePromise=new Promise(function(resolve){
      try{
        var sc=document.createElement('script');
        sc.src='assets/js/response-guidance-core.js';
        sc.onload=function(){try{resolve(window.IBResponseGuidanceCore||null)}catch(_e){resolve(null)}};
        sc.onerror=function(){resolve(null)};
        (document.head||document.documentElement).appendChild(sc);
      }catch(_e2){resolve(null)}
    });
    return _ibResponseGuidanceCorePromise;
  }catch(_e3){return Promise.resolve(null)}
}
async function _ibPlaceResponseGuidanceMessage(messages,envelope,hasCanonicalSystem,expectedIdentity){
  try{
    if(!Array.isArray(messages)||!envelope||typeof envelope!=='object')return false;
    if(hasCanonicalSystem!==true)return false;
    if(!messages.length||!messages[0]||messages[0].role!=='system')return false;
    var G=await _ibResponseGuidanceCoreReady();
    if(!G||typeof G.renderEnvelope!=='function')return false;
    var entries=Array.isArray(envelope.entries)?envelope.entries:[];
    var needsBehaviorEffect=entries.some(function(entry){return entry&&entry.guidanceKind==='behavior-effect-v1'});
    var R=needsBehaviorEffect?await _ibBehaviorEffectRenderReady():null;
    if(needsBehaviorEffect&&(!R||typeof R.render!=='function'))return false;
    var expected=expectedIdentity||envelope.turnIdentity||null;
    var renderers={'memory-behavior-posture-v1':function(payload){return G.renderBehaviorPosture(payload)}};
    if(R)renderers['behavior-effect-v1']=function(payload){return R.render(payload)};
    var result=G.renderEnvelope(envelope,expected,renderers,{allowTestFixtures:false});
    if(!result||result.ok!==true||!result.text)return false;
    messages.splice(1,0,{role:'system',content:result.text});
    return true;
  }catch(_e4){return false}
}

/* ════ Middle Brain 注入契约（P11-3）════
   seam 返回值 → "是否允许改写最终角色请求里的上下文"。三态语义与 trace 的 source 字段一一对应：
     'astra'  → 使用 Astra 处理结果（语义压缩；当前消息缺失时由 pipeline 兜底追加）
     'local'  → 使用本地 pipeline 处理结果（确定性去重/预算压缩；当前消息恒保留）
     'bypass' → 保留原始上下文（未启用 / 返回 null / 无产物）
   允许注入的必要条件（任一不成立即 bypass，绝不"近似注入"）：
     ① 来源必须显式具名（只有 'astra' / 'local' 可注入）——**不得**把 source 判成 truthy；
     ② payload 是非空字符串（trim 后非空）；
     ③ 本层确实组织过上下文（stats.empty !== true）。否则 compressedContext 只是当前用户消息的回声
        （pipeline 在全空时的兜底产物），注入它只会给请求加一段无信息的重复块；
     ④ 'local' 额外要求 payload 保留当前用户消息 —— 这是本地 pipeline 的输出契约
        （middle-brain.js 的无损兜底会把当前消息补上），用它反证 payload 来自本轮上下文而非残骸。
        'astra' 不加这一条：Astra 成功路径的行为在本阶段保持不变。 */
function _mbInjectable(res,userMessage){
  try{
    if(!res||typeof res!=='object')return false;
    var src=String(res.source||'');
    if(src!=='astra'&&src!=='local')return false;
    var payload=res.compressedContext;
    if(typeof payload!=='string'||!payload.trim())return false;
    if(res.stats&&res.stats.empty===true)return false;
    if(src==='local'&&payload.indexOf(String(userMessage||''))<0)return false;
    return true;
  }catch(e){return false}
}

/* Middle Brain Trace（dev 观测）：本轮请求参数指纹。只含非敏感标量（模型名/provider/
   format/流式/思考/token 上限），不含 API Key、system prompt 或用户正文；
   用途 = seam 前与实际发送前各取一次逐字节比较，证明 Middle Brain 未改动模型参数。 */
function _mbParamsFingerprint(cfg,streaming,thinking){
  try{
    return JSON.stringify({
      model:String((cfg&&cfg.model)||''),
      provider:String((cfg&&cfg.provider)||''),
      format:String(_providerFormat(cfg)||''),
      streaming:!!streaming,
      thinking:!!thinking,
      maxTokens:(typeof _chatMaxTokens==='function'?_chatMaxTokens(cfg):null)
    });
  }catch(e){return'{"err":1}'}
}
/* ── P11-3D.1 · 宿主 AI 回合的作用域（真正的 cycle owner）───────────────
   不变量（本阶段冻结）：

       ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET

   为什么周期不能开在 callApiChat* 内部（P11-3D 的旧模型，已废弃）：
     · XML 工具批次（_execWsOps）与工具续轮（_wsToolContinue）发生在
       callApiChatStream **返回之后**，那一刻周期已经被它的 finally 收掉了 → 这条
       通道从头到尾**没有周期可问**，于是 tool-count / duplicate / retry /
       elapsed 四类预算对 XML 全部失效，执行也不入账；
     · XML 续轮内部又调 callApiChat，于是它**自己另开一个周期** —— 一个 turn
       变成两个预算（也会重置轮次计数）。
   旧模型"一次 callApi 调用 = 一个周期"因此不成立：它把"函数调用"当成了"回合"。

   所有权模型（逐字对应 Phase 1 的 ownership 表）：
     · outer host turn  → _ibTurnScope() 建 turn，ownsCycle=true，唯一 begin/end 者；
     · nested model call→ 继承同一个 turn（把 turn.guard 绑到自己的 FC ctx），不 begin/end；
     · XML continuation → 继承同一个 turn（随 ictx/opts 显式传递），不 begin/end；
     · background turn  → 自己的 turn（自建 scope），与前台**不同实例**，互不干涉。
   禁止用"当前唯一活动周期"反推归属：归属只来自这里显式传下去的 turn 对象。 */
const _IB_TURN_MARK='__ibTurnScope';
function _ibTurnTraceBegin(meta){
  try{var core=window.IBModelCore;if(core&&typeof core.turnTraceBegin==='function')return core.turnTraceBegin(meta||'')}catch(e){}
  return '';
}
function _ibTurnTraceEvent(traceId,eventType,fields){
  try{var core=window.IBModelCore;if(core&&typeof core.turnTraceEvent==='function')return core.turnTraceEvent(traceId,eventType,fields||{})}catch(e){}
  return null;
}
function _ibTurnTraceFinish(traceId,status,fields,turn){
  if(!traceId)return null;
  try{
    var g=turn&&turn.guard;
    if(g&&typeof g.snapshot==='function'){
      var snap=g.snapshot(),events=[];
      try{events=(typeof g.trace==='function'?g.trace():[]).map(function(e){return String(e&&e.t||'')+(e&&e.reason?':'+String(e.reason):'')}).filter(Boolean)}catch(e){}
      _ibTurnTraceEvent(traceId,'tool_execution',{toolName:'turn_summary',
        toolStatus:Number(snap.toolCalls)>0?'accounted':'none',toolCount:Number(snap.toolCalls)||0,
        toolCalls:Number(snap.toolCalls)||0,toolRounds:Number(snap.rounds)||0});
      _ibTurnTraceEvent(traceId,'tool_guard',{toolCalls:Number(snap.toolCalls)||0,toolRounds:Number(snap.rounds)||0,
        guardTripped:!!snap.tripped,guardReason:String(snap.breakerReason||''),guardEvents:events.slice(-16)});
    }else _ibTurnTraceEvent(traceId,'tool_execution',{toolName:'turn_summary',toolStatus:g?'unobserved':'none',toolCount:0,toolCalls:0,toolRounds:0});
    var core=window.IBModelCore;
    if(core&&typeof core.turnTraceFinish==='function')return core.turnTraceFinish(traceId,status||'completed',fields||{});
  }catch(e){}
  return null;
}
function _ibTurnScope(label){
  return {
    [_IB_TURN_MARK]:true,
    label:String(label||'turn'),
    ownsCycle:true,
    guard:null,
    _guardCycle:false,
    active:false,
    round:0,
    activityId:null,/* 本回合实际注入/归属的 Activity（无则为 null；assistant 落库与广播继承此值） */
    ledger:{},nameMap:{},calls:[],tools:null,_acc:null
  };
}
/* 取本回合的作用域（只认带标记的对象，绝不把任意 opts 当真） */
function _ibTurnOf(o){
  var t=o&&o._ibTurn;
  return (t&&t[_IB_TURN_MARK]===true)?t:null;
}
/* 本回合的工具执行周期实例。
   宿主 turn 的周期在"工具块真的激活了这个回合"时开启（callApiChat* 的 _toolCycleBegin）。
   纯 XML 回合（模型没走原生 FC，只在正文里写 <ws_tool>）此前**没有任何周期**，
   那条通道于是完全不受裁定。这里给它补上**同一个** turn 的周期：
   仍然只有一个周期、一份预算，owner 仍是这个 turn（不是 XML 这一批操作）。 */
function _ibTurnGuard(turn){
  try{
    if(!turn)return null;
    if(turn.guard&&typeof turn.guard.active==='function'&&turn.guard.active())return turn.guard;
    /* cycleBegin 只接受 active 的工具上下文。宿主 turn 自身 active=false；XML-only
       Provider 不会建立 FC ctx，所以这里用一个短命的 active ctx 为同一 turn 开周期。 */
    if(typeof IBFC!=='undefined'&&typeof IBFC.cycleBegin==='function')return IBFC.cycleBegin({active:true},null,turn);
  }catch(e){}
  return null;
}
/* 宿主侧周期开关：只有 turn 的 owner 调用，且只在 turn 首尾各一次。
   cycleEnd 幂等（turn.guard 清空后不再有周期可收），因此"重复收尾"无害。 */
function _ibTurnCycleBegin(turn){
  try{
    if(!turn||typeof IBFC==='undefined'||typeof IBFC.cycleBegin!=='function')return null;
    return IBFC.cycleBegin(turn,null,turn);
  }catch(e){return null}
}
function _ibTurnCycleEnd(turn){
  try{
    if(!turn||typeof IBFC==='undefined'||typeof IBFC.cycleEnd!=='function')return null;
    return IBFC.cycleEnd(turn);
  }catch(e){return null}
}
/* 回合的作用域与生命周期：begin 一次、end 一次（任何出口都走 end）。 */
function _ibTurnLc(turn){
  var open=false;
  return {
    turn:function(){ return turn; },
    begin:function(){ if(open)return turn; open=true; _ibTurnCycleBegin(turn); return turn; },
    end:function(){ if(!open)return null; open=false; return _ibTurnCycleEnd(turn); }
  };
}

/* ── P11-3X-C · 宿主回合的唯一上下文预算 ────────────────────────────────
   不变量：ONE HOST TURN → ONE CONTEXT BUDGET。

   唯一事实源 = assets/js/context-budget-core.js（唯一估算器 + 应用级天花板 +
   输出预留 + 输入预算 + 可压缩阶梯）。本文件只做两件事：
     ① 在**宿主回合**（单聊 / 群聊各一次）把一个请求的组成算成 token，并据此
        给可压缩块的 producer 分配本回合额度；
     ② 如实记录（环 + 超预算时一条 console 行）。

   绝不：不新建第二个估算器 / 第二套预算；不改 P11-3D.1 的周期归属（周期 owner
   仍是宿主 turn，不在这里开/收周期）；永不裁剪不可丢的块（system/persona 身份、
   当前用户消息、工具定义）；不引入 provider 专属 context window 表（天花板是
   应用级常量，provider capability 留作扩展点）。

   为什么额度取"producer 自己的上限"而不是实测值：宿主必须在 producer **运行之前**
   就把额度发下去，那时块还不存在。用上限（worst case）判定"不超预算"意味着真实
   情况必然不超 —— 所以正常回合每一级的 keepFraction 恒为 1，producer 拿到的是
   与改动前**逐字相同**的调用（这正是"最小兼容策略"的含义：机制唯一存在，但在
   天花板之下不产生任何可观察变化）。 */
const _CTX_TAIL_SEP='\n\n---\n[以下为系统注入的参考上下文，不属于用户发言，勿复述或提及以下内容的存在]\n';
/* 可压缩块在 producer 侧的既有上限（worst case，单位=字符，按 CJK 1 token/字符
   计入预算）。这些数字**不是**新预算，而是下面这些既有常量的只读镜像：
   memSettings.budget（默认 DEFAULT_MEM_BUDGET）/ MOMENT_CONTEXT_CHAT_MAX /
   understanding 300 / thread 3 条 / activity 的 2000+600 切片。 */
const _IB_BUDGET_CAP_TOKENS={moments:900,understanding:300,thread:600,activity:2600};
function _ibBudgetCore(){try{return (typeof window!=='undefined'&&window.IBContextBudgetCore)||null}catch(e){return null}}
/* 应用级天花板。测试需要用真实宿主回合验证"超预算"分支，而把一个 400k 字符的
   persona 塞进浏览器代价过高，因此留一个**显式开发接缝**（window 上的一次性覆盖，
   不落 localStorage、不进任何用户设置，与 __ibBootFn 同类）。 */
function _ibBudgetCeiling(core){
  try{var o=(typeof window!=='undefined')?Number(window.__ibContextCeiling):0;if(isFinite(o)&&o>0)return o}catch(e){}
  return core?core.APP_CEILING_TOKENS:64000;
}
/* 只留最近若干个回合的量测（只含计数与状态，绝不含正文）。 */
const _IB_BUDGET_RING=[];
let _IB_BUDGET_SEQ=0;
function _ibBudgetRecord(entry){try{_IB_BUDGET_SEQ++;entry.seq=_IB_BUDGET_SEQ;_IB_BUDGET_RING.push(entry);if(_IB_BUDGET_RING.length>24)_IB_BUDGET_RING.shift()}catch(e){}}
function _ibBudgetHistory(){return _IB_BUDGET_RING.slice()}
/* 本回合 provider 侧工具定义的 token 量（FC 未激活 / 该厂商不支持 → 0）。
   量的是 `_callApiChatStreamOnce` 真正会注入 body.tools 的那一份定义
   （同一个 IBFC 构建源），不是另算一份。 */
function _ibToolsTokens(cfg){
  try{
    if(typeof IBFC==='undefined'||typeof IBFC.on!=='function'||!IBFC.on())return 0;
    if(typeof IBFC.toolDefinitions!=='function')return 0;
    const fmt=_providerFormat(cfg);
    if(fmt!=='anthropic'&&fmt!=='openai')return 0;
    const t=IBFC.toolDefinitions();
    const arr=(t&&t.openai&&t.openai.length)?t.openai:((t&&t.anthropic)||null);
    const core=_ibBudgetCore();
    return core?core.estimateTokens(core.toolsText(arr)):0;
  }catch(e){return 0}
}
/* 本回合的额度分配。返回 null 表示"核心不可用 → 一切照旧"（fail-open 到改动前）。 */
function _ibAllocateCompressible(cfg,parts){
  const core=_ibBudgetCore();
  if(!core)return null;
  try{
    parts=parts||{};
    const caps=Object.assign({},_IB_BUDGET_CAP_TOKENS,parts.caps||{});
    const plan=core.planParts({
      ceiling:_ibBudgetCeiling(core),
      reserve:(typeof _chatMaxTokens==='function')?_chatMaxTokens(cfg):undefined,
      systemTokens:core.estimateTokens(parts.system||''),
      historyTokens:(parts.history||[]).reduce(function(a,m){return a+core.estimateTokens(core.contentText(m&&m.content))},0),
      currentTokens:core.estimateTokens(parts.userMessage||''),
      injectedOtherTokens:core.estimateTokens(parts.fixedTail||''),
      toolsTokens:_ibToolsTokens(cfg),
      memoryTokens:caps.memory,
      momentsTokens:caps.moments,
      threadTokens:caps.thread,
      activityTokens:caps.activity,
      understandingTokens:caps.understanding
    });
    return {core:core,plan:plan,caps:caps};
  }catch(e){return null}
}
/* 把 keepFraction 作用到 producer 的既有上限上（只缩不放）。
   f===1 → 原样返回 null，调用方保持改动前的调用形状。 */
function _ibScaledCap(capChars,f,minChars){
  const f0=Number(f);
  if(!(f0<1))return null;
  const v=Math.floor(Number(capChars)*f0);
  return Math.max(minChars||0,v);
}
function _ibBudgetLog(kind,alloc,extra){
  try{
    const p=alloc&&alloc.plan;if(!p||!p.over)return;
    console.info('[IB Context Budget] '+kind+' | in~'+p.inputTokens+' tok / budget '+p.inputBudget
      +' (ceil '+p.ceiling+' - out '+p.reserve+') | '+(p.irreducible?'IRREDUCIBLE（只剩产品决策：persona/工具/换模型）':('ladder '+JSON.stringify(p.summary.ladder)))
      +(extra?(' | '+extra):''));
  }catch(e){}
}

/* P24-M3.3.3.3 · Recent Speaker window（**临时 v1 adapter policy**）──────────────────
   单位 = MemberTurn（**不是** message）：同一成员回合的多条 canonical 消息（multipart /
   工具续轮）只占 1 个 slot。因此这里**不能**复用任何"按消息计数"的读取窗口
   （DEFAULT_READ_GROUP_CHAT / glim.groupChatLimit / gss.keepCount 都是 message count，
   语义不同，故意不复用）。
   该值不进 storage / 不进 UI / 不进 schema / 不进 planner output；
   未来的 Group Participation Policy 应当接管这个值（群参与策略的归属地）。 */
const GROUP_RECENT_SPEAKER_WINDOW=2;

/* P5-B3-K · session-only, untrusted free-text preference candidates.
   This deterministic reader is independent of Middle Brain and Memory Ops;
   its only write boundary is an explicit user click into the existing report action. */
var _ibFreeTextReportCandidateCore=window.IBFreeTextReportCandidate||null;
var _ibFreeTextReportCandidateSession=_ibFreeTextReportCandidateCore
  ?_ibFreeTextReportCandidateCore.createSession():null;
var _ibFreeTextReportCandidateStatus=_ibFreeTextReportCandidateCore
  ?_ibFreeTextReportCandidateCore.STATUS:null;
var _ibFreeTextReportCandidateTimers=new Map();
function _ibFreeTextReportCards(candidateId){
  var out=[];
  document.querySelectorAll('.chat-msg[data-msg-id]').forEach(function(bubble){
    bubble.querySelectorAll('.chat-free-text-report-candidate[data-candidate-id]').forEach(function(card){
      if(card.dataset.candidateId===String(candidateId))out.push(card);
    });
  });
  return out;
}
function _ibFreeTextReportRender(candidateId,state,reason){
  _ibFreeTextReportCards(candidateId).forEach(function(card){
    var status=card.querySelector('[data-report-candidate-status]');
    var actions=card.querySelector('[data-report-candidate-actions]');
    var confirm=card.querySelector('[data-report-candidate-confirm]');
    var dismiss=card.querySelector('[data-report-candidate-dismiss]');
    if(!status||!actions)return;
    status.hidden=false;
    if(state===_ibFreeTextReportCandidateStatus.PENDING){
      status.textContent=reason?'提交未完成，可再次确认。':'等待你的确认。';
      actions.hidden=false;if(confirm)confirm.disabled=false;if(dismiss)dismiss.disabled=false;
    }else if(state===_ibFreeTextReportCandidateStatus.CONFIRMING){
      status.textContent='正在提交结构化报告…';
      actions.hidden=false;if(confirm)confirm.disabled=true;if(dismiss)dismiss.disabled=true;
    }else if(state===_ibFreeTextReportCandidateStatus.CONFIRMED){
      status.textContent='已提交结构化偏好报告。';actions.hidden=true;
    }else if(state===_ibFreeTextReportCandidateStatus.DISMISSED){
      status.textContent='已忽略；没有创建报告。';actions.hidden=true;
    }else{
      status.textContent='候选已过期或来源会话已变化；没有创建报告。';actions.hidden=true;
    }
  });
}
function _ibFreeTextReportClearTimer(candidateId){
  var timer=_ibFreeTextReportCandidateTimers.get(String(candidateId));
  if(timer){clearTimeout(timer);_ibFreeTextReportCandidateTimers.delete(String(candidateId));}
}
function _ibFreeTextReportCurrentScope(){
  return {characterId:String(activeFriendId||''),threadId:String(activeThreadId||'')};
}
function _ibFreeTextReportAttach(userMessage,scope){
  if(!_ibFreeTextReportCandidateCore||!_ibFreeTextReportCandidateSession||!userMessage)return null;
  var candidate=_ibFreeTextReportCandidateCore.extractCandidate(userMessage.content,userMessage.id);
  if(!candidate)return null;
  var created=_ibFreeTextReportCandidateSession.create(candidate,scope,userMessage);
  if(!created||created.ok!==true)return null;
  var bubbles=[];
  document.querySelectorAll('.chat-msg.user[data-msg-id]').forEach(function(bubble){
    if(bubble.dataset.msgId===String(userMessage.id))bubbles.push(bubble);
  });
  if(!bubbles.length){_ibFreeTextReportCandidateSession.expire(created.candidateId);return null;}
  bubbles.forEach(function(bubble){
    var card=document.createElement('section');
    card.className='chat-free-text-report-candidate';
    card.dataset.candidateId=created.candidateId;
    card.setAttribute('aria-label','Preference candidate confirmation');
    var kicker=document.createElement('span');kicker.className='chat-free-text-report-candidate__kicker';
    kicker.textContent='PREFERENCE · CANDIDATE';card.appendChild(kicker);
    var proposition=document.createElement('p');proposition.className='chat-free-text-report-candidate__proposition';
    proposition.textContent=(candidate.stance==='like'?'喜欢 ':'不喜欢 ')+candidate.targetKey;
    card.appendChild(proposition);
    var explanation=document.createElement('p');explanation.className='chat-free-text-report-candidate__copy';
    explanation.textContent='这只是待确认候选；只有你点击确认后，才会提交为结构化偏好报告。';
    card.appendChild(explanation);
    var actions=document.createElement('div');actions.className='chat-free-text-report-candidate__actions';
    actions.dataset.reportCandidateActions='1';
    var confirm=document.createElement('button');confirm.type='button';confirm.className='chat-free-text-report-candidate__confirm';
    confirm.dataset.reportCandidateConfirm='1';confirm.textContent='确认记录';
    confirm.addEventListener('click',function(){_ibFreeTextReportConfirm(created.candidateId);});
    var dismiss=document.createElement('button');dismiss.type='button';dismiss.className='chat-free-text-report-candidate__dismiss';
    dismiss.dataset.reportCandidateDismiss='1';dismiss.textContent='忽略';
    dismiss.addEventListener('click',function(){
      var state=_ibFreeTextReportCandidateSession.dismiss(created.candidateId);
      _ibFreeTextReportClearTimer(created.candidateId);
      _ibFreeTextReportRender(created.candidateId,state&&state.status||_ibFreeTextReportCandidateStatus.EXPIRED);
    });
    actions.appendChild(confirm);actions.appendChild(dismiss);card.appendChild(actions);
    var status=document.createElement('p');status.className='chat-free-text-report-candidate__status';
    status.dataset.reportCandidateStatus='1';status.setAttribute('role','status');status.hidden=true;
    card.appendChild(status);bubble.appendChild(card);
  });
  var delay=Math.max(0,created.expiresAt-Date.now());
  _ibFreeTextReportCandidateTimers.set(created.candidateId,setTimeout(function(){
    var state=_ibFreeTextReportCandidateSession.expire(created.candidateId);
    _ibFreeTextReportRender(created.candidateId,state&&state.status||_ibFreeTextReportCandidateStatus.EXPIRED);
    _ibFreeTextReportClearTimer(created.candidateId);
  },delay));
  return created;
}
async function _ibFreeTextReportConfirm(candidateId){
  if(!_ibFreeTextReportCandidateSession)return;
  var state=_ibFreeTextReportCandidateSession.get(candidateId);
  if(!state){_ibFreeTextReportRender(candidateId,_ibFreeTextReportCandidateStatus.EXPIRED);return;}
  if(state.status!=='pending'){
    _ibFreeTextReportRender(candidateId,state.status,state.reasonCode);return;
  }
  _ibFreeTextReportRender(candidateId,_ibFreeTextReportCandidateStatus.CONFIRMING);
  var currentScope=_ibFreeTextReportCurrentScope();
  var source=null;
  try{source=await dbGet('chatMessages',state.candidate.sourceMessageRef)}catch(_sourceError){source=null;}
  currentScope=_ibFreeTextReportCurrentScope();
  var reportAction=window.IB&&window.IB.homeNode&&window.IB.homeNode.explicitPreferenceReport;
  var result=await _ibFreeTextReportCandidateSession.confirm(candidateId,currentScope,source,
    reportAction&&reportAction.available===true&&typeof reportAction.submit==='function'
      ?function(payload){return reportAction.submit(payload)}:null);
  if(result.status===_ibFreeTextReportCandidateStatus.CONFIRMED
    ||result.status===_ibFreeTextReportCandidateStatus.EXPIRED
    ||result.status===_ibFreeTextReportCandidateStatus.DISMISSED)_ibFreeTextReportClearTimer(candidateId);
  _ibFreeTextReportRender(candidateId,result.status,result.reasonCode);
}

async function sendChatMessage(voiceMsg){
  /* voiceMsg：由语音模块 _vmFinish 传入的 {dataUrl,mime,duration,transcript}；按钮点击/回车调用时为空 */
  const _voice=(voiceMsg&&voiceMsg.dataUrl)?voiceMsg:null;
  const _callTurn=(voiceMsg&&voiceMsg.voiceCall&&voiceMsg.transcript)?voiceMsg:null;
  /* Find active friend config */
  if(!activeFriendId&&apiConfigs.length>0)activeFriendId=apiConfigs[0].id;
  /* 捕获发送瞬间的目标好友/话题，防止用户在等待API时切窗导致消息串到其他对话框 */
  const _targetFriend=_callTurn?String(_callTurn.roleId||''):activeFriendId;
  const _targetThread=_callTurn?(String(_callTurn.conversationId||'').indexOf('thread:')===0?String(_callTurn.conversationId).slice(7):null):activeThreadId;
  if(_chatSendingFor.has(_targetFriend))return;
  /* P11-2C · 本轮副作用政策来源：本回合唯一复位点。
     null = 拿不到状态（群聊/博客留言/角色来信等不经 Middle Brain 收口的路径都停在这里，
     以及收口本身故障时）→ 下游闸门 fail-open，行为与改动前逐字一致。
     只有单聊两条路径在收口后把它改成 integrity 层产出的 verdict。 */
  _mbVerdict=null;
  /* P11-2D · 同一个复位点复位抑制计数：否则上一回合残留的条数会让"本轮有指令"变成假命题。 */
  _mbSideEffectCounts={};
  /* 同一 verdict（尤其连续 UNDECIDED）不能充当回合边界。把"新回合尚未裁定"送到
     integrity 闸门，显式清掉上一轮抑制记录；null 仍按既有语义 fail-open。 */
  try{var _mbStartApi=window.IB&&window.IB.middleBrain;if(_mbStartApi&&typeof _mbStartApi.middleBrainSideEffectAllowed==='function')_mbStartApi.middleBrainSideEffectAllowed(null,null,0)}catch(_mbStartErr){}
  /* Get input from either mini or full chat */
  const miniInput=document.getElementById('chat-input');
  const fullInput=document.getElementById('chat-full-input');
  const input=currentPage==='chat'?fullInput:miniInput;
  const text=_voice?'':(_callTurn?String(_callTurn.transcript||'').trim():input.value.trim());/* 通话 transcript 与语音消息都不碰输入框草稿 */
  const _ctxText=_voice?_voiceApiLine(_voice):text;/* 供 @提及判定、记忆检索、Auto Memory 使用的等效文本 */
  if(!text&&!_voice&&!_pendingImages.length&&!_pendingFiles.length){
    _chatSetComposerFeedback(currentPage==='chat'?'full':'mini','请输入内容或添加附件后再发送。');
    return {ok:false,error:'empty_message'};
  }
  _chatSetComposerFeedback(currentPage==='chat'?'full':'mini','');

  const isGroup=_targetFriend&&_targetFriend.startsWith('group_');
  const _explicitMemoryApi=window.IBChatExplicitMemory||null;
  const _explicitMemoryIntent=(!(_voice||_callTurn)&&_explicitMemoryApi
    &&typeof _explicitMemoryApi.classify==='function')
    ?_explicitMemoryApi.classify(text)
    :null;
  const _referenceCore=window.IBChatReferenceResolution||null;
  const _explicitReferenceNeeded=!!(_explicitMemoryIntent&&(_referenceCore&&typeof _referenceCore.needsResolution==='function'
    ?_referenceCore.needsResolution(text)
    :/(?:那个(?:梗|计划|事情|事|地方|供应商|项目|东西|人|话)?|那件(?:事|事情)?|上次(?:那件|那个|那次|我们说的)?|之前(?:说的|那个|那件|那条)?|她说的那个|他说的那个|她提到的那个|还是老地方|你知道我说的是哪个|你知道我说的那个|那个还记得|那个呢|它)/.test(text)));

  if(isGroup){
    /* ===== GROUP CHAT MODE ===== */
    const groups=await loadGroups();
    const group=groups.find(g=>g.id===_targetFriend);
    if(!group){_chatSetComposerFeedback(currentPage==='chat'?'full':'mini','群聊已不可用，请重新选择会话。');return}
    normalizeGroupMembers(group);/* 自动迁移旧格式 */
    const allMemberIds=getGroupMemberIds(group);
    const memberCfgs=allMemberIds.map(mid=>apiConfigs.find(a=>a.id===mid)).filter(Boolean);
    if(memberCfgs.length<1){_chatSetComposerFeedback(currentPage==='chat'?'full':'mini','这个群聊目前没有可用成员。');return}
    /* P24-M3.2 · entry → cfg 的**唯一**映射：精确 id 匹配。
       绝不按 nickname / model 回退，也不允许 pick first（M3.2 §17）。 */
    const memberCfgById=new Map(memberCfgs.map(c=>[c.id,c]));
    const thinkingOn=true;/* reasoning 始终接收和保存；是否展示由每个成员 cfg.showThinking 决定 */

    if(!_voice&&!_callTurn)input.value='';
    const sentImages=(_voice||_callTurn)?[]:_pendingImages.slice();if(!_voice&&!_callTurn)_pendingImages=[];
    const sentFiles=(_voice||_callTurn)?[]:_pendingFiles.slice();if(!_voice&&!_callTurn){_pendingFiles=[];renderAttachPreviews()}

    const userMsg={id:'msg_'+Date.now()+'_u',role:'user',content:text,friendId:_targetFriend,timestamp:Date.now()};
    if(sentImages.length)userMsg.images=sentImages.map(img=>({dataUrl:img.dataUrl,base64:img.base64,mime:img.mime,name:img.name}));
    if(sentFiles.length)userMsg.files=sentFiles.map(f=>({name:f.name,ext:f.ext,size:f.size,text:f.text}));
    if(_voice)userMsg.voice={dataUrl:_voice.dataUrl,mime:_voice.mime,duration:_voice.duration,transcript:_voice.transcript||'',tone:_voice.tone||''};
    /* ── P24-M1 · 群回合身份地基（IDENTITY-ONLY）─────────────────────────────
       groupTurnId 由触发本回合的 canonical user message id 确定性派生（身份里不存在
       Date.now / 随机 / 昵称）；它**不落库为实体**，只作为运行期 context，最终事实来自
       本轮成员消息上的 metadata.groupTurnId。
       本阶段不改变：发言成员集合 / 顺序 / 上下文窗口 / 记忆 / persona / 工具 / typing /
       text·voice 决策 / P23 交付。身份不可用（核心缺席或校验不过）⇒ 退回原行为。 */
    const _gIdentity=_ibGroupIdentityContext({
      triggerUserMessageId:userMsg.id,groupId:_targetFriend,friendId:_targetFriend,
      threadId:_targetThread||'',createdAt:userMsg.timestamp
    });
    /* P24-M3.3.1 · GroupTurn runtime state（created）——runtime-only，见 _ibGroupTurnBegin。 */
    const _gTurn=_ibGroupTurnBegin(_targetFriend,(_gIdentity&&_gIdentity.groupTurnId)||'');
    /* ══ P24-M3.5.1A · 结构化 targeting（全部发生在**唯一一次** user 写入之前）══════
       顺序：userMsg.id 已知 → groupTurnId 派生 → mention candidates → resolveMentionTargets
             → canonicalize（participant 顺序 + 去重 + 仅当前参与者）→ 校验 writer invariant
             → 组装 metadata → **一次** dbPut。
       为什么必须在这里：① 解析只需 _ctxText / memberCfgs（都在上方就绪，纯函数零 I/O）；
       ② 二次写同一行会让 Home Node 产生假 revision；③ "字段存在"是 structured authority 的
       判据，只有写进去才能被 reader 认出来。
       身份域：targetSpeakerIds 里的 id = apiConfigs.id，与 metadata.speakerId **同一 domain**。
       本阶段**只写 targetSpeakerIds**（不写 metadata.groupTurnId：它可由 userMsg.id 纯派生，
       落库等于制造第二份可推导事实；审计见 M3.5.1A 报告）。 */
    const _gMentionCandidates=memberCfgs.map(c=>({id:c.id,name:c.nickname||c.model||''}));
    const _gMentionParsed=(()=>{try{const _c=_ibGroupCore();if(_c&&typeof _c.resolveMentionTargets==='function')return _c.resolveMentionTargets(_ctxText||'',_gMentionCandidates)}catch(e){}return {targets:[],ambiguous:[],unresolved:[]}})();
    const _gTargetIds=(()=>{try{const _c=_ibGroupCore();if(_c&&typeof _c.canonicalizeTargetSpeakerIds==='function')return _c.canonicalizeTargetSpeakerIds(_gMentionParsed.targets||[],memberCfgs.map(c=>c.id))}catch(e){}return null})();
    const _gTargetVerdict=(()=>{try{const _c=_ibGroupCore();if(_c&&typeof _c.validateTargetSpeakerIds==='function')return _c.validateTargetSpeakerIds(_gTargetIds)}catch(e){}return {ok:false,errors:['core-unavailable']}})();
    if(!_gTargetVerdict.ok){
      /* internal invariant failure：canonical writer 绝不写坏 row（复用既有 fail-closed 提示）。 */
      _ibGroupParticipationFailClosed('group-targeting-writer-invariant',(_gTargetVerdict.errors&&_gTargetVerdict.errors.length)||0);
      _chatSetComposerFeedback(currentPage==='chat'?'full':'mini','群聊消息未能准备好，没有发送。请重新输入后再试。');
      _ibGroupTurnEnd(_targetFriend,_gTurn,'completed');
      return;
    }
    userMsg.metadata={targetSpeakerIds:_gTargetIds};
    await dbPut('chatMessages',userMsg);   /* ← 每个新群用户消息恰好一次 canonical write */
    appendChatBubble('user',text,undefined,undefined,userMsg.id,sentImages,sentFiles,undefined,_voice);
    /* 上传的文件同步归档进 ICode 的「User」文件夹（先落库再逐个请求成员；文件内容随本条消息注入，后续可按文件名 ws_read 读取） */
    if(sentFiles.length){try{await _wsArchiveUserUploads(sentFiles)}catch(e){}}

    const msgContainer=currentPage==='chat'?document.getElementById('chat-full-messages'):document.getElementById('chat-messages');
    if(_explicitMemoryIntent&&!_explicitReferenceNeeded){
      _chatSendingFor.add(_targetFriend);
      _chatSyncComposerBusy();
      let _memoryWrite={handled:true,ok:false,replyText:'canonical Memory 写入通道未就绪，未保存。'};
      try{
        try{_memoryWrite=await window.IBChatExplicitMemory.route({text:text,sourceMessageId:userMsg.id,
          conversationId:_ibConvId(_targetFriend,_targetThread),timestamp:userMsg.timestamp})}catch(_memoryRouteError){}
        _chatAppendInlineStatus(msgContainer,_memoryWrite.replyText||'长期 Memory 写入失败，未保存。',_memoryWrite.ok?'success':'error');
      }finally{
        _ibGroupTurnEnd(_targetFriend,_gTurn,'completed');
        _chatSendingFor.delete(_targetFriend);
        _chatSyncComposerBusy();
        autoResizeInput(input);
        if(currentPage==='chat')renderChatCalendar();
        updateChatStorageInfo();
      }
      return {ok:true,replyText:_memoryWrite.replyText||'',userMessageId:userMsg.id,memoryWriteOk:_memoryWrite.ok===true,
        memoryReceipt:_memoryWrite.receipt||null};
    }
    /* ══ P24-M3.3.3.3 · ONE CANONICAL SNAPSHOT PER GROUP TURN ══════════════
       本回合的 canonical 历史**只在这里读一次**（封档线过滤 + canonical 顺序），
       之后同时供两个消费者使用：
         A. deriveRecentSpeakerIds（participation planning 输入）
         B. 后续 prompt history：_cacheStableSlice(gMsgs,gKeepCount)
       因此本分支里**只允许一次** dbGetByIndex('chatMessages','byFriend',…)：
       读两次会得到两份快照，"planner 看到的历史"与"成员看到的历史"可能不一致。
       时机：① 晚于 userMsg dbPut ⇒ 当前用户消息在快照内（prompt 里只作为 user 出现
             一次；tail 上下文挂在这条上，不是第二条 user 消息）；
             ② 早于 MemberTurn loop ⇒ 本轮 A/B/C 的回复**不会**回流进 recent
             （一个 GroupTurn 只规划一次；本轮新回复只经 roundExtras 传给后续成员）。 */
    const _gSealTs=await getChatSealTimestamp(_targetFriend);
    const gMsgs=filterSealed(_ibOrderMessages(await dbGetByIndex('chatMessages','byFriend',_targetFriend)),_gSealTs);/* 封档线过滤 · P23 2A：顺序走 canonical orderMessages */
    const _gReferenceResolution=await _ibResolveChatMemoryReference(memberCfgs[0],{
      userMessage:text,history:gMsgs,currentMessageId:userMsg.id,conversationId:_ibConvId(_targetFriend,_targetThread),
      friendId:_targetFriend,threadId:_targetThread||null,isGroup:true,mode:_explicitMemoryIntent?'write':'recall'
    });
    if(_explicitMemoryIntent&&_explicitReferenceNeeded){
      let _memoryWrite={handled:false,ok:false,error:'reference-unresolved'};
      try{_memoryWrite=await window.IBChatExplicitMemory.route({text:text,sourceMessageId:userMsg.id,
        conversationId:_ibConvId(_targetFriend,_targetThread),timestamp:userMsg.timestamp},{
          referenceResolution:_gReferenceResolution,referenceContextMessages:gMsgs,friendId:_targetFriend,threadId:_targetThread||''
        })}catch(_memoryRouteError){}
      if(_memoryWrite.handled){
        _chatSendingFor.add(_targetFriend);_chatSyncComposerBusy();
        _chatAppendInlineStatus(msgContainer,_memoryWrite.replyText||'长期 Memory 写入失败，未保存。',_memoryWrite.ok?'success':'error');
        _ibGroupTurnEnd(_targetFriend,_gTurn,'completed');_chatSendingFor.delete(_targetFriend);_chatSyncComposerBusy();
        autoResizeInput(input);if(currentPage==='chat')renderChatCalendar();updateChatStorageInfo();
        return {ok:true,replyText:_memoryWrite.replyText||'',userMessageId:userMsg.id,
          memoryWriteOk:_memoryWrite.ok===true,memoryReceipt:_memoryWrite.receipt||null};
      }
    }
    /* ══ P24-M3.2 · Participation Plan（**唯一**参与权威）═════════════════════
       流程：canonical participants → canonical mention targets → planParticipation()
             → plan.entries（每个 entry = 一次 MemberTurn，order = planned order）
       本阶段只替换"谁获得 MemberTurn"；context / provider / Middle Brain / P23 /
       typing / voice / memory / summary / 工具执行 / 取消 / timing **全部原样**。
       失败策略：**FAIL CLOSED**（绝不回退 legacy speakingCfgs —— 那会形成双权威并
       重新引入 nickname 参与判定）。user 消息已在上方落库，保持不变。 */
    let plannedEntries=[];
    let plannedCfgs=[];
    let _gPlannerFailed=false;
    let _gResolvedCap;                    /* P24-M3.5.2A：resolved numeric cap 或 undefined */
    _gTurn.status='planning';
    try{
      const _gCore=_ibGroupCore();
      /* ══ P24-M3.4.2 · Participation Policy 解析（planner 上游 · 每 GroupTurn 恰好一次）══
         pure resolver 只做 precedence + validation（零存储/零网络/零 DOM）；adapter 负责
         把三份**已切出来的 fragment**交给它，然后把结果**逐字段**映射到下游：
           resolved.policy.maxResponders        → planner input（条件注入）
           resolved.policy.recentSpeakerWindow  → deriveRecentSpeakerIds 的 window
         `sources` 只是诊断：绝不进 planner input / output、metadata、prompt、Memory、P23。

         **本阶段没有任何 policy 来源**（group policy storage 属 M3.4.3；user defaults 与
         system product defaults 尚不存在）⇒ 三份 fragment 都是 undefined ⇒ 解析结果必为
         {policy:{},sources:{}}。因此：
           · production 仍 unlimited（planner input 里**没有** cap 键）；
           · productive window 仍是 GROUP_RECENT_SPEAKER_WINDOW=2 这个 **adapter fallback**
             —— 它不是 system policy，绝不用它去凑 systemDefaults。
         绝不从 group 的未知字段偷读 policy；绝不 fallback 成"空 policy 后继续"（抛错即
         fail closed，交给本 try 的 catch 走既有 planner failure 路径）。 */
      if(!_gCore||typeof _gCore.resolveParticipationPolicy!=='function'||typeof _gCore.deriveRecentSpeakerIds!=='function'
        ||typeof _gCore.resolveTargetSpeakerIds!=='function'||typeof _gCore.projectTargetedParticipants!=='function')throw new Error('participation-policy-resolver-unavailable');
      /* ── P24-M3.5.1A · 结构化 targeting 读取（**每 GroupTurn 恰好一次**）+ 投影 ──
         message = 本轮刚写入 canonical 的 userMsg（字段必然存在 ⇒ structured authority）。
         非法 structured metadata ⇒ 抛错 ⇒ 本 try 的 catch：既有的"本轮参与计划不可用"fail-closed
         （user 消息已落库、planner 不执行、0 provider、0 assistant），**绝不回退文本解析**。
         投影只映射**当前** participants：历史已退出成员的 id 不报错、也不产生 mentioned。 */
      const _gTargetRes=_gCore.resolveTargetSpeakerIds({
        message:userMsg,text:_ctxText||'',candidates:_gMentionCandidates,participantIds:memberCfgs.map(c=>c.id)
      });
      const _gTargetedIds=_gCore.projectTargetedParticipants(_gTargetRes.targetSpeakerIds,memberCfgs);
      const _gMentionSet=new Set(_gTargetedIds);
      /* P24-M3.4.3 · group policy 的来源 = **已经加载的** canonical group object（上方 2128 行
         `loadGroups()` 的结果）：**不新增任何 policy DB 读**（每 GroupTurn 的 chatMessages
         快照仍恰好一次，policy 不产生第二次 I/O）。
         字段缺失 ⇒ `undefined` —— 绝不 `group.participationPolicy || {}`（那会把"未配置"
         伪造成"空 policy"，丢掉 absence 语义，并让老群行为漂移）。
         adapter **不做** validation：非法 stored policy 直接交给 resolver，由它 fail closed
         （既有"本轮参与计划不可用"路径），storage 层也绝不"顺手修好"它。 */
      const _gGroupPolicy=group.participationPolicy;
      const _gUserDefaults=undefined,_gSystemDefaults=undefined;
      const _gResolvedPolicy=_gCore.resolveParticipationPolicy(_gGroupPolicy,_gUserDefaults,_gSystemDefaults);
      /* P24-M3.5.2A · runtime cap：只取**已解析出的数值**（缺字段 ⇒ undefined = unlimited），
         绝不把整个 policy 对象传给 runtime，也绝不把 null 当 0。 */
      if(Object.prototype.hasOwnProperty.call(_gResolvedPolicy.policy,'maxResponders'))_gResolvedCap=_gResolvedPolicy.policy.maxResponders;
      /* effective recent window：**只**在 resolver 显式解析出该字段时才覆盖 adapter fallback。
         用 hasOwnProperty —— `recentSpeakerWindow:0` 是"关闭 recent"的真值，绝不能被 `||` 吃掉。 */
      const _gRecentWindow=Object.prototype.hasOwnProperty.call(_gResolvedPolicy.policy,'recentSpeakerWindow')
        ? _gResolvedPolicy.policy.recentSpeakerWindow
        : GROUP_RECENT_SPEAKER_WINDOW;
      /* ── P24-M3.3.3.3 · Recent Speaker 派生（输入 = 上面那份 canonical 快照 gMsgs）──
         participants 只传 canonical id，且**来自同一批** memberCfgs（= groups.members →
         apiConfigs 的精确映射，见上方 memberCfgById）——绝不重新读 group.members、
         绝不另建第二套 participant identity authority。
         helper 抛错（含 helper 缺席）⇒ 直接抛出，交给本 try 的 catch 走既有 planner
         fail-closed 路径：**绝不** fallback 成"没有 recent"后继续规划（那会把派生失败
         静默降级成另一种参与语义）。 */
      const _gRecentView=_gCore.deriveRecentSpeakerIds(gMsgs,memberCfgs.map(c=>c.id),{window:_gRecentWindow});
      const _gPlanInput={
        groupTurnId:(_gIdentity&&_gIdentity.groupTurnId)||'',
        trigger:{userMessageId:userMsg.id,text:String(_ctxText||'')},
        participants:memberCfgs.map(c=>({id:c.id,status:getGroupMemberStatus(group,c.id)||'',mentioned:_gMentionSet.has(c.id)})),
        recentSpeakerIds:_gRecentView.recentSpeakerIds
      };
      /* planner 只接收**它已支持的具体值**（整个 resolved policy 对象与 sources 一律不外传），
         且必须**条件注入**：absent ≠ "键存在但值为 undefined"。
         当前 resolver 默认不产出 maxResponders ⇒ 这里不生效 ⇒ production 仍 unlimited。 */
      if(Object.prototype.hasOwnProperty.call(_gResolvedPolicy.policy,'maxResponders'))_gPlanInput.maxResponders=_gResolvedPolicy.policy.maxResponders;
      const _gVerdict=(_gCore&&typeof _gCore.validateParticipationInput==='function')?_gCore.validateParticipationInput(_gPlanInput):{ok:false,errors:['planner-core-unavailable']};
      if(!_gVerdict||_gVerdict.ok!==true){
        _gPlannerFailed=true;
        _ibGroupParticipationFailClosed('group-participation-invalid-input',(_gVerdict&&_gVerdict.errors&&_gVerdict.errors.length)||0);
      }else{
        const _gPlan=_gCore.planParticipation(_gPlanInput);
        plannedEntries=(_gPlan&&_gPlan.entries)||[];
        const _gUnknown=[];
        for(let _gi=0;_gi<plannedEntries.length;_gi++){
          const _gc=memberCfgById.get(plannedEntries[_gi].speakerId);
          if(!_gc){_gUnknown.push(plannedEntries[_gi].speakerId);continue}
          plannedCfgs.push(_gc);
        }
        if(_gUnknown.length){
          _gPlannerFailed=true;
          _ibGroupParticipationFailClosed('group-participation-entry-unknown-speaker',_gUnknown.length);
          plannedEntries=[];plannedCfgs=[];
        }
      }
    }catch(_gPlanErr){
      _gPlannerFailed=true;
      _ibGroupParticipationFailClosed('group-participation-planner-exception',String((_gPlanErr&&_gPlanErr.message)||_gPlanErr).slice(0,80));
      plannedEntries=[];plannedCfgs=[];
    }
    _gTurn.status='planned';
    _gTurn.plannedCount=plannedEntries.length;
    if(!plannedEntries.length){
      /* 空计划 = 合法结果（全员静默未点名 / 全员已退出）⇒ 只呈现 UI 系统气泡。
         计划不可用（invalld input / entry 找不到 cfg / planner 抛错）⇒ 明确的可理解提示。
         **两种都不产生任何 canonical 消息**（沉默不是消息）。 */
      const quiet=document.createElement('div');
      quiet.className='chat-msg system';
      quiet.setAttribute('role','status');quiet.setAttribute('aria-live','polite');quiet.setAttribute('aria-atomic','true');
      if(_gPlannerFailed){
        quiet.classList.add('ib-primitives');
        const status=document.createElement('div');status.className='ib-inline-status';status.dataset.status='error';
        const marker=document.createElement('span');marker.className='ib-inline-status__marker';marker.setAttribute('aria-hidden','true');
        const text=document.createElement('span');text.className='ib-inline-status__text';text.textContent='本轮群聊参与计划不可用，没有发送成员回复。';
        status.appendChild(marker);status.appendChild(text);quiet.appendChild(status);
      }else quiet.textContent='（成员都在静默模式且没有被 @，本轮无人回应）';
      msgContainer.appendChild(quiet);
      msgContainer.scrollTop=msgContainer.scrollHeight;
      _ibGroupTurnEnd(_targetFriend,_gTurn,'completed');
      return;
    }
    /* 只校验本轮**计划发言者**的 API：被 omitted 的成员 API 未就绪不阻塞整轮（语义与改动前一致）。 */
    const invalidMembers=plannedCfgs.filter(c=>!_ibApiReady(c));
    if(invalidMembers.length>0){
      const missing=invalidMembers[0];
      const category=!String(missing.endpoint||'').trim()?'endpoint':(!String(missing.model||'').trim()?'model':'auth');
      const failureModel=window.IBERR&&typeof window.IBERR.model==='function'?window.IBERR.model(category,{cfg:missing,stage:'group_chat'}):null;
      if(failureModel&&!failureModel.action)failureModel.action={type:'open_settings',target:'api',label:'打开 API 设置'};
      _chatAppendErrorDisclosure(msgContainer,failureModel,{scope:'group-config',stage:'group_chat',title:'群聊成员设置未完成',
        roleId:String(missing.id||''),
        message:'有成员尚未完成 API 配置，本轮没有开始请求。',suggestion:'检查群聊成员的 API 设置后，再重新发送群聊消息。'});
      _ibGroupTurnEnd(_targetFriend,_gTurn,'completed');return;
    }
    const glim=await getReadingLimits();
    const _vtSg=await _vtGet();/* 语音直发开关（成员是否能听原声在循环内按各自模型判定） */
    /* 历史生成图参考（群聊）：从历史取最近一条 AI 生成图补入本轮（仅支持视觉的成员；去重防重复） */
    try{
      if(_ibModelCanSee(cfg)){
        for(let _ghi=gMsgs.length-1;_ghi>=0;_ghi--){
          const _ghm=gMsgs[_ghi];
          if(_ghm&&_ghm.role==='assistant'&&Array.isArray(_ghm.images)&&_ghm.images.length){
            const _gh=String(_ghm.images[0]&&_ghm.images[0].dataUrl||'');
            if(_gh.slice(0,5)==='data:'&&_gh.length>100&&_gh.length<2.4e6&&!sentImages.some(x=>x.dataUrl===_gh)){
              sentImages.push({dataUrl:_gh,base64:String(_ghm.images[0].base64||'').trim()||String(_gh.split(',')[1]||''),mime:String(_ghm.images[0].mime||'').trim()||((String(_gh.match(/^data:([^;,]+)/i)||[])[1])||'image/jpeg'),name:String(_ghm.images[0].name||'')||'generated.png'});
            }
            break;
          }
        }
      }
    }catch(e){}
    /* Group chat summary: only READ existing (no API call here) */
    let gSummaryText=null;
    const gss=await getSummarySettings();
    if(gss.enabled){
      const gExisting=await getChatSummary(_targetFriend,null);
      if(gExisting)gSummaryText=gExisting.summary;
    }
    const gKeepCount=gss.enabled?(gss.keepCount||6):(glim.groupChatLimit||DEFAULT_READ_GROUP_CHAT);
    const history=_cacheStableSlice(gMsgs,gKeepCount);/* 缓存修复：阶梯窗口，起点不再逐条滑动 */

    let about=null;try{about=await dbGet('about','main')}catch(e){}
    const userLabel=(about&&about.name)?about.name:'用户';
    const userDesc=(about&&about.name)?('用户「'+about.name+'」'):'用户';
    const allNames=memberCfgs.map(c=>c.nickname||c.model);
    /* P24-M2 · 本群回合的 participant authority（只读消费 canonical 来源）：
       groups.members 的 id + 角色显示名。历史里可能包含已静默 / 已退出成员的消息，
       因此取**全部成员**（不是本轮发言者）。绝不在这里另建一份成员注册表。 */
    const _gParticipants=_ibGroupParticipants(getGroupMemberIds(group));
    const roundExtras=[];/* FIX④: 本轮内先发言成员的回复，供后续成员接力可见 */

    _chatSendingFor.add(_targetFriend);
    _chatSyncComposerBusy();
    try{
    /* 工作区读取内容与操作结果反馈：**canonical 优先**地派发给真正所属成员（P29-3）；
       无主条目 / 成员已不在本群名单的条目，仍由本轮首个发言成员兜底消费（兼容旧行为） */
    let _gWsFirstTurn=true;
    /* ── P24-M1.1 · 群聊执行的 trace runtime binding ──────────────────────
       既有缺陷（HEAD 即存在）：群聊循环引用的是**裸标识符** `_mbTrace`，而
       `sendChatMessage` 里唯一的 `var _mbTrace=(window.IB&&window.IB.__mbTrace)||null;`
       声明在**单聊分支**（同一函数作用域）。var 提升后群聊侧拿到的是 undefined，
       于是 `_mbTrace.begin('group',…)` 必然抛 TypeError，又被成员级 catch 吞掉
       —— 每个成员都产不出回复（assistant message = 0）。
       修法：在群聊执行路径**首次使用之前**建立同一个 runtime binding。
       用 `var`（不是 let/const）：它与单聊分支是**同一个函数作用域绑定**，
       既不重复声明、也不 shadow 任何东西、更不是第二套 trace —— 取值仍然只来自
       Middle Brain 暴露的唯一 sink `IB.__mbTrace`。 */
    var _mbTrace=(window.IB&&window.IB.__mbTrace)||null;
    /* P24-M3.3.1 · 进入执行阶段（planned → executing）。 */
    _gTurn.status='executing';
    /* ══ P24-M3.5.2A · Dynamic Runtime State Foundation（feature gate，默认关）══════════
       本阶段只建立 runtime-only 的"准入队列 + hard gates + 记账"，**没有** SILENT / DEFER /
       INTERJECT，也不调用任何模型。开关默认 false：
         · false ⇒ 完全不建 runtime state，循环逐字沿用既有 static 语义（零额外读/写/调用）；
         · true  ⇒ 用同一份 entries 建 state，并按 queue 驱动**同一个**循环体
                    （enabled 但无任何 dynamic decision ⇒ 与 static 逐字等价）。
       status 快照来自**本轮已加载**的 group 对象（turn-start snapshot），绝不为此再读 DB。
       创建失败（非法 planner output）⇒ fail closed（既有"本轮参与计划不可用"路径）。 */
    let _gDynRt=null;
    if(_ibDynamicParticipationOn()){
      try{
        const _gStatusById={};
        for(let _si=0;_si<plannedEntries.length;_si++){
          const _sid=String(plannedEntries[_si].speakerId||'');
          if(_sid)_gStatusById[_sid]=getGroupMemberStatus(group,_sid)||'';
        }
        _gDynRt=_ibGroupCore().createDynamicRuntimeState({
          groupTurnId:(_gIdentity&&_gIdentity.groupTurnId)||'',
          entries:plannedEntries.map(e=>({speakerId:e.speakerId,order:e.order,reason:e.reason})),
          responderCap:_gResolvedCap,
          statusById:_gStatusById
        });
      }catch(_gRtErr){
        _ibGroupParticipationFailClosed('group-dynamic-runtime-contract',String((_gRtErr&&_gRtErr.message)||_gRtErr).slice(0,80));
        _chatAppendInlineStatus(msgContainer,'群聊执行状态无法启动，本轮没有发送成员回复。','error');
        _gTurn.status='planned';
        _ibGroupTurnEnd(_targetFriend,_gTurn,'completed');
        _chatSendingFor.delete(_targetFriend);
        _chatSyncComposerBusy();
        return;
      }
    }
    let _gRtCursor=0;
    /* P24-M3.5.2B · runtime-only decision source：**仅测试用**注入（非产品 API、不持久化、
       不进 prompt / metadata）。缺省 ⇒ SPEAK（生产默认行为不变）；disabled 时**完全不读**。 */
    const _gDynDecider=(_gDynRt&&typeof window.IB_DYNAMIC_PARTICIPATION_DECIDER==='function')?window.IB_DYNAMIC_PARTICIPATION_DECIDER:null;
    for(;;){/* P24-M3.2：entries 即参与计划（唯一权威）；M3.5.2A 起可选由 runtime queue 驱动 */
      /* P24-M3.3.1 · entry 边界检查（GroupTurn cancel）：被取消 ⇒ **不启动 provider**、
         不产生 assistant message、不改变 groupOrder；输出里已完成的成员消息一律保留。 */
      let entry=null;
      if(_gDynRt){
        const _gNx=_ibGroupCore().nextDynamicRuntimeEntry(_gDynRt,{cancelled:_gTurn.cancelled});
        if(_gNx.done)break;
        entry=_gNx.entry;
      }else{
        if(_gRtCursor>=plannedEntries.length)break;
        if(_gTurn.cancelled)break;
        entry=plannedEntries[_gRtCursor++];
      }
      /* ── P24-M3.5.2B · Runtime SILENT seam ────────────────────────────────
         位置：hard gates 之后（next 已通过 cancel/removed/cap/one-turn），
               startedCount / markStarted / typing / provider **之前**。
         SILENT ⇒ 该 speaker 本轮终止自己的 MemberTurn：不启动 provider、不建 typing、
         不写 canonical assistant 消息、不进 roundExtras、不进 P23；
         但 initial planner 的 admitted fact 保留（plannedCount 不变、groupOrder 空洞保留）。
         决策失败（抛错 / malformed / 未知词，含 defer/interject）⇒ fallback SPEAK（可选增强失败
         绝不改变既有行为，也不升级为 GroupTurn 失败）。 */
      if(_gDynRt){
        const _gDec=_ibGroupCore().resolveDynamicRuntimeDecision(_gDynRt,entry,{decider:_gDynDecider});
        if(_gDec&&_gDec.decision==='silent'){
          _ibGroupCore().markDynamicRuntimeSilent(_gDynRt,entry.speakerId);
          continue;
        }
        /* P24-M3.5.2C · DEFER：entry 已通过 hard gate 并被取出 ⇒ 追加到本轮队列尾部，
           等本轮后续机会（**NOT terminal**；同 speaker 本轮仍最多执行一次 SPEAK）。
           词表只在 feature 打开时生效；同一 speaker 第二次 defer 由 core 侧 fallback SPEAK
           （diagnostic='defer-limit'），defer 本身失败也一律继续 SPEAK ⇒ 绝不死循环 / 绝不丢 entry。 */
        if(_gDec&&_gDec.decision==='defer'&&_ibGroupCore().deferDynamicRuntimeEntry(_gDynRt,entry).ok===true){
          continue;
        }
      }
      _gTurn.startedCount++;
      if(_gDynRt)_ibGroupCore().markDynamicRuntimeStarted(_gDynRt,entry,{cancelled:_gTurn.cancelled});
      const cfg=memberCfgById.get(entry.speakerId);/* §17：精确 id 命中，构建计划时已校验 */
      const selfName=cfg.nickname||cfg.model;
      /* P24-M1 · MemberTurn identity：turnId 的种子与 P23 turnIdFor 逐字同源
         （groupTurnId + ':' + speakerId + ':' + groupOrder），因此工具续轮可以按
         P23 现行 tool-round 契约继承同一个 turnId；groupTurnId 只做群回合归属，
         不替代 turnId（两者必须并存，见 P24 Phase 1 §4.1 硬约束 H2）。
         身份不可用 ⇒ _gMember 为 null ⇒ 本成员退回 legacy 行为。 */
      /* P24-M3.2：groupOrder 直接取 **planner 的 planned order**（entry.order）。
         运行期失败不重排、不重编号（空洞合法，M3.1 已冻结）；OMITTED 者不占 order。 */
      const _gMember=_ibGroupMemberIdentity(_gIdentity,cfg.id,entry.order);
      /* P29-0 · Identity Read-Path Closure：身份不可用不再静默。
         仅诊断（计数 + 闭集日志），fallback 语义与写入形状逐字不变。 */
      if(!_gMember)_ibGroupIdentityDegraded(_gIdentity?'member-identity-unavailable':'group-identity-context-unavailable');
      /* P11-3D.1：群聊里**每个发言成员各自一个宿主回合** → 各自一个工具执行周期
         （成员之间不共享额度；这与"一次发言 = 一个 turn"的语义一致）。 */
      const _mbTurnLc=_ibTurnLc(_ibTurnScope('group'));
      const _mbTurn=_mbTurnLc.turn();
      if(_gMember){_mbTurn.turnId=_gMember.turnId;_mbTurn.groupTurnId=_gMember.groupTurnId;_mbTurn.speakerId=_gMember.speakerId;_mbTurn.groupOrder=_gMember.groupOrder;}
      _mbTurnLc.begin();
      const _gTraceId=_ibTurnTraceBegin({consumer:'group',characterId:String(cfg.id||''),threadId:String(_targetThread||''),turnId:String(_mbTurn.turnId||'')});
      _mbTurn.traceId=_gTraceId;
      _ibTurnTraceEvent(_gTraceId,'input',{inputMessages:1,inputChars:String(_ctxText||'').length});
      /* Catch cleanup must see the same presentation handles regardless of which nested
         provider/context branch throws. These are DOM/timer references, not runtime state. */
      let gStreamRefs=[],typingEl=null,_gTypTimer=null;
      try{
      /* P11-2F · 群聊运行时可观测：**每个发言成员各自一条 trace 记录**，
         与单聊一致地在回合开始处 begin（键 = 该成员的角色 id）。
         注意顺序：`_mbTraceNote` 在"没有 begin 过的记录"上是静默 no-op，
         因此这些字段必须在 begin **之后**写；写在循环之前会整片丢失。
         判定结果字段（policyDecision / blockedReason）由记忆指令消费点补写。 */
      /* P24-M1.1 · trace 是 observability，**不是** chat execution authority：
         sink 缺席（null）或自身抛错，都不允许阻止本成员回合产出 canonical 回复。
         与 `_mbGroupTraceContext` 同一防御风格（不新增 trace 抽象层）。 */
      if(_mbTrace){try{_mbTrace.begin('group',cfg.id)}catch(e){}}
      _mbGroupTraceContext(_targetFriend,cfg.id,memberCfgs,selfName);
      const _gvNative=_vmAudioNative(cfg)&&(_vtSg.direct!==false);/* 本成员能否直接听音频原声 */
      const _gStreamOk=cfg.streaming!==undefined?!!cfg.streaming:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].streaming);
      /* 非流式：typing指示器 */
      let _gTypStart=0;
      if(!_gStreamOk){
        typingEl=document.createElement('div');
        typingEl.className='chat-typing';
        typingEl.dataset.activityState='thinking';
        typingEl.dataset.speakerId=String(cfg.id||'');
        typingEl.setAttribute('role','status');
        typingEl.setAttribute('aria-live','polite');
        typingEl.setAttribute('aria-atomic','true');
        _gTypStart=Date.now();
        typingEl.innerHTML=esc(_chatActivitySpeakerName(_targetFriend,cfg.id))+' 正在思考…<span class="typing-sec">（0秒）</span>';
        var _gTypSec=typingEl.querySelector('.typing-sec');if(_gTypSec)_gTypSec.setAttribute('aria-hidden','true');
        _gTypTimer=setInterval(()=>{const s=Math.round((Date.now()-_gTypStart)/1000);const sp=typingEl.querySelector('.typing-sec');if(sp)sp.textContent='（'+s+'秒）'},1000);
        msgContainer.appendChild(typingEl);
        msgContainer.scrollTop=msgContainer.scrollHeight;
      }
      try{
        /* FIX①(核心): 只有"自己"的历史发言保留 assistant 角色；
           用户和其他成员的发言一律映射为 user 角色并带 [名字] 标注。
           旧版把所有AI发言都标成 assistant，等于告诉每个模型
           "别人的台词是你自己说过的话"（Anthropic 还会把相邻 assistant 轮合并成一条），
           这正是"一人分饰多角"的根源 */
        /* 历史只回传用户消息与最终回答；reasoning_content 仅本地保存/导出，不显示也不回传。
           系统事件消息（成员加入/退出等）不注入AI上下文。 */
        const _combined=history.concat(roundExtras);
        const _gQuoteCore=window.IBMessageQuoteCore||null;
        const _gQuoteContext=(_gQuoteCore&&typeof _gQuoteCore.buildContext==='function')
          ?_gQuoteCore.buildContext(_combined,{mode:'group',friendId:_targetFriend,threadId:_targetThread||'',currentSenderId:cfg.id,userName:userLabel,limit:8})
          :null;
        const mapped=_combined.filter(m=>m.role!=='system').map((m,i)=>{
          if(m.role==='user'){var uc='['+userLabel+'] '+(m.content||'');if(m.voice)uc+=(m.content?'\n':'')+_voiceApiLine(m.voice,!_gvNative);if(m.files&&m.files.length)m.files.forEach(function(f){uc+='\n\n[文件上传: '+f.name+']\n'+_capFileText(f.text)});return {role:'user',content:uc}}
          /* P24-M2 · WHO SAID IT 由 canonical speakerId 决定（senderName 只作显示与 legacy 回退）。
             不对称安全规则：unresolved / ambiguous / invalid / 非本群成员 一律不是 SELF。 */
          if(_ibGroupClassifyMessage(m,cfg.id,_gParticipants)==='SELF'){
            let c=_wsStubHistory(sanitizeGroupReply(m.content,selfName,allNames));
            return {role:'assistant',content:c};
          }
          return {role:'user',content:'['+(m.senderName||'AI')+'] '+_wsStubHistory(m.content)};
        });
        const messages=collapseSameRole(mapped);
        /* FIX②: 上下文构建（Extraction Seam）——system/tail 分区由 buildChatContext 产出 */
        const _gc=await buildChatContext(cfg,{isGroup:true,selfName:selfName,allNames:allNames,userDesc:userDesc,group:group,gss:gss,gSummaryText:gSummaryText,turnId:(typeof _mbTurn!=="undefined"&&_mbTurn&&_mbTurn.turnId)?_mbTurn.turnId:'',_ibTraceId:_gTraceId,conversationId:(typeof _mbTurn!=="undefined"&&_mbTurn&&_mbTurn.conversationId)?_mbTurn.conversationId:_ibConvId(String(group.id||''),(typeof opts!=="undefined"&&opts&&opts.threadId)?opts.threadId:null),_ibRecallTurnMark:(typeof _mbTurn!=="undefined"&&_mbTurn)?_mbTurn:null,userMessage:_ctxText,isFirstTurn:_gWsFirstTurn,history:messages,referenceHistory:gMsgs,referenceResolution:_gReferenceResolution,currentMessageId:userMsg.id,sentFiles:sentFiles,threadId:_targetThread||null});
        let sysContent=_gc.system;
        if(_gQuoteContext&&_gQuoteContext.prompt)sysContent=(sysContent?sysContent+'\n\n':'')+_gQuoteContext.prompt;
        const _gTailCtx=_gc.tail;
        _gWsFirstTurn=false;/* 首个发言者兜底消费完无主/移出成员条目后置 false */
        messages.unshift({role:'system',content:sysContent});
        _ibAddExpressionPromptHint(messages,cfg&&cfg.id);
        /* M0 · 群聊消费与 1:1 同一 ResponseGuidance envelope / 插入位。 */
        await _ibPlaceResponseGuidanceMessage(messages,_gc&&_gc.responseGuidance,!!sysContent,_gc&&_gc.responseGuidanceIdentity);
        if(_gTailCtx){/* 群聊尾部挂载：优先找用户本人的消息（无 senderName 且 role=user），找不到才回退到最后一条 user；
           带图消息（content 数组）用 _appendMsgText 追加，绝不 String() 化（图片 part 需要保留） */
          let _gtDone=false;
          for(let _gt=messages.length-1;_gt>=0;_gt--){if(messages[_gt].role==='user'&&!messages[_gt]._groupSender){_appendMsgText(messages[_gt],_CTX_TAIL_SEP+_gTailCtx);_gtDone=true;break}}
          if(!_gtDone){for(let _gt=messages.length-1;_gt>=0;_gt--){if(messages[_gt].role==='user'){_appendMsgText(messages[_gt],_CTX_TAIL_SEP+_gTailCtx);break}}}
        }
        /* R3 · 群聊图片注入：检查当前成员是否支持视觉，再按 group/thread WHERE
           做稳定 take/keep；同一 WHERE 的图片是会话上下文，不按 actor 拆散。 */
        const _gLocalVision=_usesLocalDeepSeekVision(cfg);
        const _gNativeDeepSeekVision=_usesNativeDeepSeekVision(cfg);
        const _gVisionOk=_gLocalVision||_gNativeDeepSeekVision||(cfg.vision!==undefined?!!cfg.vision:true);/* 默认放行（多模态普遍；显式关闭才拒绝） */
        if(_gVisionOk){
          var _gScopeMine=_ibWsScopeFilter(_targetFriend,_targetThread||null);
          _ibTakeScopedMedia('_ibToolDrainImages',_gScopeMine).forEach(function(u){var _gi=_ibMediaPromptImage(u,'tool_result.png');if(_gi)sentImages.push(_gi)});
          _ibTakeScopedMedia('_ibImageDrain',_gScopeMine).forEach(function(u){var _gi=_ibMediaPromptImage(u,'image_inject.png');if(_gi)sentImages.push(_gi)});
        }
        if(sentImages.length&&messages.length){
          if(_gLocalVision){
            try{
              let _gQuestion='';for(let gi=messages.length-1;gi>=0;gi--){if(messages[gi].role==='user'){_gQuestion=getTextContent(messages[gi]);break}}
              _appendLocalVisionContext(messages,await _describeImagesLocally(sentImages,_gQuestion));
            }catch(_gVisionError){
              console.error('[LocalVision] group analysis failed',_gVisionError);
              const _gVisionModel=window.IBERR&&typeof window.IBERR.model==='function'?window.IBERR.model('local_service',{source:'local_service',stage:'chat_image'}):null;
              if(_gVisionModel){_gVisionModel.title='图片识别未完成';_gVisionModel.message='本地视觉服务没有读出这张图片，因此本轮回复不会依据图片内容。';_gVisionModel.suggestion='检查本地视觉服务后，可以重新发送图片。'}
              if(_ibConvIsActive(_targetFriend,_targetThread))_chatAppendErrorDisclosure(msgContainer,_gVisionModel,{scope:'image-analysis',stage:'chat_image'});
              else if(_gVisionModel&&window.IBERR.show)window.IBERR.show(_gVisionModel,{stage:'chat_image'});
              _appendLocalVisionContext(messages,'\n\n[本地视觉识别暂不可用，无法读取本次图片。]');
            }
          }else if(_gVisionOk){
            for(let gi=messages.length-1;gi>=0;gi--){
              if(messages[gi].role==='user'){
                const _gImgNote=_gNativeDeepSeekVision
                  ? '\n\n【本条消息附带'+sentImages.length+'张图片】请直接查看这些图片，结合用户消息进行视觉理解与推理，并以你的角色身份回答。'
                  : '\n\n【本条消息附带'+sentImages.length+'张图片】你可以查看并描述图片内容。'+(cfg.imageGen?'':'你不能生成或返回图片。');
                const txtVal=(getTextContent(messages[gi])||'请查看图片')+_gImgNote;/* 缓存修复：图片说明改挂本条用户消息，保持 system 前缀稳定；DeepSeek 原生视觉模型走直接看图文案，不夹带图像生成限制 */

                const parts=[{type:'text',text:txtVal}];
                sentImages.forEach(img=>parts.push({type:'_image',base64:img.base64,mime:img.mime}));
                messages[gi].content=parts;break
              }
            }
          }else{
            for(let gi=messages.length-1;gi>=0;gi--){
              if(messages[gi].role==='user'){
                const t=getTextContent(messages[gi]);
                messages[gi].content=(t||'')+(t?'\n':'')+'[用户附加了'+sentImages.length+'张图片，但当前模型不支持图片识别]';
                break
              }
            }
          if(_ibConvIsActive(_targetFriend,_targetThread))_chatAppendInlineStatus(msgContainer,'当前群聊成员无法读取本次图片；回复将依据可读取的文字内容。','warning');
          }
        }
        /* Group file processing instructions */
        if(sentFiles.length){
          /* 缓存修复：文件能力说明改挂末条用户消息，保持 system 前缀稳定 */
          const _gfNote='【文件处理能力】用户上传了'+sentFiles.length+'个文件。你可以阅读、分析、编辑文件内容。这些文件已同步归档到 ICode 的「User」文件夹（<ws_project name="User"/> 选定后可用 ws_edit 直接修改原件）。输出修改结果时：内容很短（50行以内）可用 ```file:文件名.扩展名 代码块直接输出下载文件；较长的文件或整份改写，请改用工作区指令（<ws_project/> + <ws_create> 或 <ws_edit>），可放心输出完整文件——输出触及长度上限时系统会自动续写拼接。在标签/代码块外用自然语言说明你做了哪些修改。';
          for(let _gfi=messages.length-1;_gfi>=0;_gfi--){
            if(messages[_gfi].role==='user'){
              if(Array.isArray(messages[_gfi].content)){const _gtp=messages[_gfi].content.find(p=>p.type==='text');if(_gtp)_gtp.text+='\n\n'+_gfNote;else messages[_gfi].content.unshift({type:'text',text:_gfNote});}
              else messages[_gfi].content=String(messages[_gfi].content||'')+'\n\n'+_gfNote;
              break
            }
          }
        }
        /* 群聊语音直发：能听音频的成员当轮收到原声（与图片同一注入方式，仅当轮携带；WAV 转换结果跨成员复用） */
        if(_voice&&_gvNative&&messages.length){
          let _gvwav=null;
          try{_gvwav=await _vmApiAudioWav(_voice)}catch(exga){try{console.info('[IB语音直发] 音频转换失败（群聊成员 '+selfName+'），本轮仅发送文字稿: '+((exga&&exga.message)||exga))}catch(e){}}
          if(_gvwav){
            for(let _gvi=messages.length-1;_gvi>=0;_gvi--){
              if(messages[_gvi].role==='user'){
                if(Array.isArray(messages[_gvi].content))messages[_gvi].content.push({type:'_audio',mime:'audio/wav',base64:_gvwav,format:'wav'});
                else messages[_gvi].content=[{type:'text',text:String(messages[_gvi].content||'')||'[语音消息]'},{type:'_audio',mime:'audio/wav',base64:_gvwav,format:'wav'}];
                break
              }
            }
          }
        }
        let rawReply,groupThinking='',_gSrchLog=[];
        gStreamRefs=[];
        const _gCallRes={};/* 并发隔离：本成员本次调用的思考与截断结果 */
        if(_gStreamOk){
          /* 群聊流式 */
          _showStreamingUI(true);
          gStreamRefs=_ibConvIsActive(_targetFriend,_targetThread)?_createStreamBubble(_targetFriend,selfName,cfg&&cfg.id,_targetThread):[];
          let _gSBuf='',_gSThinkBuf='',_gSState=0;
          let _gLiveThink=[];
          const _gShowThinking=_resolveShowThinking(cfg);
          const _gThinkF=(tk)=>{if(_gShowThinking)_appendStreamThinking(gStreamRefs,_gLiveThink,tk)};
          const _gWsFilter=_wsMakeStreamFilter(_wsMakeStreamWriters(gStreamRefs));
          let _gSrchLive=null;
          const _gOnSearch=function(evt){
            if(evt.phase==='start'){
              _gSrchLive=_gWsFilter.card(function(){const c=document.createElement('div');c.className='ws-op-card pending';c.innerHTML=WS_ICON.search+'<span class="ws-op-text">正在联网搜索…</span>';return c});
            }else if(evt.phase==='query'&&_gSrchLive){
              _gSrchLive.forEach(c=>{const t=c.querySelector('.ws-op-text');if(t)t.innerHTML='正在联网搜索 · <b>'+esc(evt.query||'')+'</b>'});
            }else if(evt.phase==='results'){
              if(!_gSrchLive)_gSrchLive=_gWsFilter.card(function(){const c=document.createElement('div');c.className='ws-op-card';c.innerHTML=WS_ICON.search+'<span class="ws-op-text"></span>';return c});/* 任务A：Gemini/OpenAI 无 start 事件，直接建完成态卡 */
              _gSrchLive.forEach(c=>{c.classList.remove('pending');const t=c.querySelector('.ws-op-text');if(t)t.innerHTML='已联网搜索'+(evt.query?' · <b>'+esc(evt.query)+'</b>':'')+esc(' ('+(evt.results||[]).length+' 条结果)')});
              _gSrchLive=null;
            }
          };
          const _gMemLive=_mkMemLiveFilter(function(ch){_gWsFilter.push(ch)},function(build){return _gWsFilter.card(build)});
          const _gQuoteStream=(_gQuoteCore&&typeof _gQuoteCore.createStreamFilter==='function')?_gQuoteCore.createStreamFilter():null;
          const _gExpressionStream=window.IBExpressionPackCore&&typeof window.IBExpressionPackCore.createTagStreamFilter==='function'?window.IBExpressionPackCore.createTagStreamFilter():null;
          const _gEmit=(ch)=>{if(_gExpressionStream)ch=_gExpressionStream.push(ch);if(!String(ch||''))return;_chatSetStreamActivity(gStreamRefs,'streaming');_gMemLive.push(ch)};
          const _gFlush=(ch)=>{_gEmit(_gQuoteStream?_gQuoteStream.push(ch):ch)};
          try{
          var _gContextChars=0;messages.forEach(function(m){var c=m&&m.content;if(typeof c==='string')_gContextChars+=c.length;else if(Array.isArray(c))c.forEach(function(p){if(p&&typeof p.text==='string')_gContextChars+=p.text.length})});
          _ibTurnTraceEvent(_gTraceId,'context',{contextMessages:messages.length,contextChars:_gContextChars});
          rawReply=await callApiChatStream(cfg,messages,{_ibTurn:_mbTurn,_ibTraceId:_gTraceId,_ibConsumer:'group',_ibCharacterId:String((cfg&&cfg.id)||''),wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_gCallRes,searchLog:_gSrchLog,onSearch:_gOnSearch,
            onThink:function(tk){_gThinkF(tk)},
            onChunk:function(chunk){
              if(_gSState===2){_gFlush(chunk);return}
              _gSBuf+=chunk;
              if(_gSState===0){
                const _gOrphan=_gSBuf.match(/^\s*<\/think(?:ing)?>\s*/i);
                if(_gOrphan){_gSState=1;_gSThinkBuf=_gSBuf.slice(_gOrphan[0].length);_gSBuf='';return}
                const _gOpen=_gSBuf.match(/^\s*<think(?:ing)?>/i);
                if(_gOpen){_gSState=1;_gSThinkBuf=_gSBuf.slice(_gOpen[0].length);_gSBuf='';_gThinkF(_gSThinkBuf);return}
                if(_chatStreamPrefixCanProjectReply(_gSBuf))_chatSetStreamActivity(gStreamRefs,'streaming');
                if(_gSBuf.length>60){_gSState=2;_gFlush(_gSBuf);_gSBuf='';return}
              }
              if(_gSState===1){_gSThinkBuf+=chunk;_gSBuf='';_gThinkF(chunk);const ct=_gSThinkBuf.match(/<\/think(?:ing)?>/i);if(ct){const _gAfter=_gSThinkBuf.slice(ct.index+ct[0].length);_gSThinkBuf=_gSThinkBuf.slice(0,ct.index);_gSState=2;if(_gShowThinking)_finishStreamThinking(_gLiveThink,_gSThinkBuf);if(_gAfter&&_gAfter.trim())_gFlush(_gAfter.trim())}}
            }});
          }catch(_streamErr){if(!rawReply)rawReply=await callApiChat(cfg,messages,{_ibTurn:_mbTurn,_ibTraceId:_gTraceId,_ibConsumer:'group',_ibCharacterId:String((cfg&&cfg.id)||''),wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_gCallRes,searchLog:_gSrchLog});groupThinking=_gCallRes.reasoning_content||''}
          _showStreamingUI(false);
          _chatSetStreamActivity(gStreamRefs,'');
          if(_gQuoteStream){const _gQuoteTail=_gQuoteStream.finish();if(_gQuoteTail)_gEmit(_gQuoteTail)}
          if(_gExpressionStream)_gExpressionStream.finish();
          _gMemLive.finish();
          _gWsFilter.finish();
          gStreamRefs.forEach(ref=>{ref.div.classList.remove('chat-stream-cursor');if(ref.txt.classList)ref.txt.classList.remove('chat-stream-cursor')});
          _finishStreamThinking(_gLiveThink,null);
          groupThinking=_gCallRes.reasoning_content||'';
          if(!groupThinking&&_gSThinkBuf.trim())groupThinking=_gSThinkBuf.trim();
          if(_gShowThinking&&groupThinking){_ensureStreamThinking(gStreamRefs,_gLiveThink);_finishStreamThinking(_gLiveThink,groupThinking)}
        }else{
          /* 群聊非流式 */
          var _gContextCharsN=0;messages.forEach(function(m){var c=m&&m.content;if(typeof c==='string')_gContextCharsN+=c.length;else if(Array.isArray(c))c.forEach(function(p){if(p&&typeof p.text==='string')_gContextCharsN+=p.text.length})});
          _ibTurnTraceEvent(_gTraceId,'context',{contextMessages:messages.length,contextChars:_gContextCharsN});
          rawReply=await callApiChat(cfg,messages,{_ibTurn:_mbTurn,_ibTraceId:_gTraceId,_ibConsumer:'group',_ibCharacterId:String((cfg&&cfg.id)||''),wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_gCallRes,searchLog:_gSrchLog});
          groupThinking=_gCallRes.reasoning_content||'';
          clearInterval(_gTypTimer);
          const _gElapsed=Math.round((Date.now()-_gTypStart)/1000);
          if(typingEl){
            if(msgContainer.id==='chat-full-messages')typingEl.remove();
            else{typingEl.textContent=selfName+'（'+_gElapsed+'秒）';typingEl.style.animation='none';setTimeout(()=>{if(typingEl.parentNode)typingEl.remove()},1000)}
          }
        }
        if((!rawReply||!String(rawReply).trim())&&!(_gCallRes.reasoning_content||groupThinking)){_ibTurnTraceFinish(_gTraceId,'empty_output',{resultChars:0,assistantMessages:0},_mbTurn);appendChatBubble('ai',(window.IBERR?window.IBERR.text('empty_output',selfName):'（未收到有效回复）'),selfName);continue}
        var gParts=_assistantResponseParts(rawReply,groupThinking);
        groupThinking=gParts.reasoning_content;
        const _gQuoteParsed=(_gQuoteCore&&typeof _gQuoteCore.parseReply==='function')
          ?_gQuoteCore.parseReply(gParts.content,_gQuoteContext):{text:gParts.content,quote:null};
        gParts.content=_gQuoteParsed.text;
        const _gReplyQuote=_gQuoteParsed.quote||null;
        let cleanReply=sanitizeGroupReply(gParts.content,selfName,allNames);
        var _gExpressionReply=_ibParseExpressionReply(cfg,cleanReply);
        cleanReply=String(_gExpressionReply.text||'');
        let reply=cleanReply;
        /* AUTO MEMORY（群聊）：截取并执行本成员的 mem_* 指令，操作者标注为发言成员。
           P11-2F · 记忆边界：写入目标域必须经 integrity 层的群聊政策判定才可落地。
           判据（scope × kind × 角色域）全部在政策本体里，这里只负责交参数与执行；
           被拒的指令**不执行**，并留下一条 trace（blockedReason）。
           注：群聊不经过 Character Integrity，故 _mbVerdict 恒为 null；
           这**不改变**既有执行行为，只是把"这一轮没有裁定可问"如实标成 unverified。 */
        var _gMemR=[];
        /* P29-0：群聊撤回必须用 canonical id 选目标 ⇒ 传入本轮已有的 participants
           （group.members 派生，见 _gParticipants）；同名成员之间不再互相撤回。 */
        reply=await _applyWithdraw(cfg,reply,_targetFriend,selfName,_gParticipants);
        {const _gmp=_parseMemOps(reply);
         if(_gmp.ops.length){
           reply=_gmp.clean;
           /* scopeOf 由**被判定操作自己的 kind** 决定（当前三个 kind 全是角色私有记忆写入）；
              政策本体同时校验 cfg.id 是不是 group_* —— 群 id 冒充角色域时一律拒，
              否则全部成员的私有记忆会塌缩进同一个 friendId。 */
           const _gScopeOf=function(_op){return _mbSecGroupScope()};
           const _gAllowed=[],_gBlocked=[];
           _gmp.ops.forEach(function(_op,i){
             const _d=_mbGroupMemPolicy(_gScopeOf(_op),(_op&&_op.kind)||'',cfg&&cfg.id);
             if(_d.allowed===true)_gAllowed.push({op:_op,at:i});
             else _gBlocked.push(_d);
           });
           if(_gAllowed.length&&amEnabled(cfg))_gMemR=await _execMemOps(_gAllowed.map(x=>x.op),cfg,selfName);
           /* 拦截留下 trace：逐条原因，但绝不记正文 / id / 昵称 */
           _gBlocked.forEach(function(_d){_mbGroupTraceBlock(cfg.id,_d)});
         }}
        /* 群聊同样支持工作区：按顺序执行操作，操作者标注为发言成员 */
        var _gws=_parseWsOps(reply),_gwsR=[];
        if(_gws.ops.length){try{_gwsR=await _execWsOps(_gws.ops,selfName,cfg,{source:'chat',friendId:_targetFriend,senderName:selfName,threadId:_targetThread||'',_ibTurn:_mbTurn,guard:_ibTurnGuard(_mbTurn)})}catch(e){}}
        if(_gws.files&&_gws.files.length){try{await _wsArchiveFileBlocks(_gws.files,selfName,_wsRoleFileProvenance(cfg))}catch(e){}}
        /* 工具回合续（v6）：本成员执行了工具 → 结果自动回喂再生成一轮，用户无需再说一句。
           P11-3D.1：续轮继承**本成员这个宿主回合**的 turn（同一周期、同一预算）。 */
        if(_gws.ops.length||_gws.files.length){
          try{await _wsToolContinue(cfg,{messages:messages,lastReply:reply,friendId:_targetFriend,chatKey:_targetFriend,senderName:selfName,round:1,threadId:_targetThread,_ibTurn:_mbTurn,guard:_ibTurnGuard(_mbTurn)})}catch(e){}
        }
        var _gwsPhantom=_wsCheckPhantom(_gws.cleanText,_gws.ops.length,selfName,cfg.id,{friendId:_targetFriend,threadId:_targetThread||''});
        /* P24-M1 · canonical 消息经 Sequence 契约构造：P24 三键
           （groupTurnId / speakerId / groupOrder）只从 extraMetadata 进入 canonical
           message，绝不"dbPut 之后补写 metadata"。
           核心缺席 / 契约拒绝 ⇒ 退回改动前逐字同形的单条构造（内容一字不丢）；
           该情形只是**没有**群身份，其余行为与 M1 之前完全一致。 */
        const _gBuilt=_gMember?_ibSequenceMessages([reply],{
          turnId:_gMember.turnId,friendId:_targetFriend,threadId:_targetThread||'',
          timestamp:Date.now(),senderName:selfName,
          model:cfg.provider||cfg.model||'',modelId:cfg.model||'',configId:cfg.id,
          showThinking:_resolveShowThinking(cfg),
          extraMetadata:{groupTurnId:_gMember.groupTurnId,speakerId:_gMember.speakerId,groupOrder:_gMember.groupOrder}
        }):null;
        const aiMsg=(_gBuilt&&_gBuilt.length===1)?_gBuilt[0]:{id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:reply,reasoning_content:groupThinking||'',metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,showThinking:_resolveShowThinking(cfg)},friendId:_targetFriend,senderName:selfName,timestamp:Date.now()};
        aiMsg.reasoning_content=groupThinking||'';/* Sequence 契约不写 reasoning；取值与改动前的单条构造逐字相同 */
        if(_gReplyQuote){aiMsg.metadata=aiMsg.metadata||{};aiMsg.metadata.replyQuote=_gReplyQuote;}
        {const _gGiImgs=_wsCollectGenImages(_gwsR);if(_gGiImgs.length)aiMsg.images=_gGiImgs;}/* 生成的图片随消息持久化 */
        if(_gSrchLog.length)aiMsg.wsSearches=_gSrchLog.slice();
        if(_gMemR.length)aiMsg.memOps=_gMemR.map(r=>({ok:r.ok,status:r.status||'',label:r.label,detail:r.detail}));
        if(_gCallRes.truncated)aiMsg.truncated=true;/* 任务6 */
        _ibPrepareExpressionMessage(aiMsg,cfg,_gExpressionReply.expressionRef);
        await dbPut('chatMessages',aiMsg);
        roundExtras.push(aiMsg);
        if(_gStreamOk){
          /* 流式：以完整回复为准重建气泡（文本 + 操作卡 + 下载卡分段）。
             必须逐个 ref 重建——流式气泡可能同时写在全屏与迷你两个容器里，
             以前只重建"当前容器的最后一条"，另一个容器会停在半成品状态
             （迷你面板里留着原始指令 / pending 操作卡），关掉重开才恢复。 */
          gStreamRefs.forEach(ref=>{
            _wsFinalizeBubble(ref,reply,_gwsR);
            if(_gReplyQuote)_chatAppendReplyQuoteCard(aiMsg,_combined,ref.div);
            var gHost=ref.isTextNode?ref.div:ref.txt;
            if(_gSrchLog.length||_gMemR.length)_amAppendExtraCards(gHost,_gSrchLog,_gMemR);
            if(_wsPendingReads.length)gHost.appendChild(_buildWsReadHint());
            if(_gwsPhantom)gHost.appendChild(_buildWsPhantomHint(_gwsPhantom));
            ref.div.dataset.msgId=aiMsg.id;
            if(typeof _chatSelectMode!=='undefined'&&_chatSelectMode&&ref.full&&!ref.div.querySelector('.chat-sel-circle')){const sc=_chatCreateSelectionControl(aiMsg.id);if(sc)ref.div.appendChild(sc)}/* BUGFIX: 群聊流式同上 */
            _chatAppendMessageActions(aiMsg,ref.div,ref.full);
            if(aiMsg.truncated&&ref.full)gHost.appendChild(_buildContinuePill(aiMsg.id));/* 任务6 */
          });
          _syncMiniAfterStream(aiMsg.id,_targetFriend);
        }else{
          if(activeFriendId===_targetFriend){
            appendChatBubble('ai',reply,selfName,groupThinking||undefined,aiMsg.id,undefined,undefined,_gwsR,undefined,cfg,aiMsg,_combined);
            if(_gSrchLog.length||_gMemR.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_amAppendExtraCards(el,_gSrchLog,_gMemR)});/* 任务A：非流式也显示搜索/记忆卡 */
            if(_wsPendingReads.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsReadHint())});
            if(_gwsPhantom)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsPhantomHint(_gwsPhantom))});
            if(aiMsg.truncated)document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id="'+aiMsg.id+'"] .r-text').forEach(function(t){t.appendChild(_buildContinuePill(aiMsg.id))});/* 任务6 */
          }
        }
      if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
      _ibTurnTraceFinish(_gTraceId,'completed',{resultChars:String(reply||'').length,assistantMessages:1},_mbTurn);
      _mbGroupTraceFinish(cfg.id,_mbVerdict);
      if(_gDynRt)_ibGroupCore().markDynamicRuntimeCompleted(_gDynRt,cfg.id);   /* P24-M3.5.2A：成功记账 */
      }catch(err){
      if(_gDynRt)_ibGroupCore().markDynamicRuntimeFailed(_gDynRt,cfg.id);      /* P24-M3.5.2A：失败记账（不重试） */
      _ibTurnTraceFinish(_gTraceId,'failed',{errorCategory:_ibProviderErrorCategory(err),resultChars:0,assistantMessages:0},_mbTurn);
      if(_gTypTimer)clearInterval(_gTypTimer);
        if(typingEl&&typingEl.parentNode)typingEl.remove();
        _showStreamingUI(false);
        _chatSetStreamActivity(gStreamRefs,'');
        /* 失败成员的流式气泡若还没写入内容，直接移除，避免残留带光标的空气泡（已流出内容的气泡保留） */
        try{(gStreamRefs||[]).forEach(function(ref){const _t=String((ref.txt&&ref.txt.textContent)||'');const _hasCards=typeof (ref.txt&&ref.txt.querySelector)==='function'&&!!ref.txt.querySelector('.ws-op-card');if(!_t.trim()&&!_hasCards&&ref.div.parentNode)ref.div.parentNode.removeChild(ref.div)})}catch(e){}
        const _userStopped=String(err&&err.ibCat||'')==='aborted';
        const _ibFE=_userStopped?null:(window.IBERR?window.IBERR.report(err,{cfg:cfg,friendId:_targetFriend,senderName:selfName,stage:'group_chat'}):null);
        if(!_userStopped){
          /* 单个成员失败只作用于该 turn；L1 错误附在 conversation stream，绝不伪装成 assistant 回复。 */
          const _failureContainer=document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages');
          const _failureOptions={scope:'group-send',stage:'group_chat',speakerName:_chatActivitySpeakerName(_targetFriend,cfg&&cfg.id),
            roleId:String(cfg&&cfg.id||''),
            title:_ibFE&&_ibFE.model?_ibFE.model.title:'群聊成员暂时无法回复',
            message:_ibFE&&_ibFE.model?_ibFE.model.message:'这位成员的回复没有完成。',
            suggestion:_ibFE&&_ibFE.model?_ibFE.model.suggestion:'其他成员的回合仍按原顺序继续。'};
          if(_ibConvIsActive(_targetFriend,_targetThread))_chatAppendErrorDisclosure(_failureContainer,_ibFE&&_ibFE.model,_failureOptions);
          else if(_ibFE&&_ibFE.model&&window.IBERR&&window.IBERR.show)window.IBERR.show(_ibFE.model,{stage:'group_chat'});
        }
      }
      }finally{
        /* P11-3D.1：该成员的宿主回合结束 —— 周期的**唯一**收尾点（含失败路径）。 */
        _mbTurnLc.end();
      }
    }
    /* P24-M3.3.1 · 执行阶段收尾：cancelled 与 completed 是仅有的两种终态。 */
    _gTurn.status=_gTurn.cancelled?'cancelled':'completed';
    }finally{
      /* P24-M3.3.1 · 注销 GroupTurn runtime state（runtime-only；正常/取消/失败路径统一收口）。 */
      _ibGroupTurnEnd(_targetFriend,_gTurn,_gTurn.cancelled?'cancelled':'completed');
      _chatSendingFor.delete(_targetFriend);
      _chatSyncComposerBusy();
      autoResizeInput(input);
      if(currentPage==='chat')renderChatCalendar();
      updateChatStorageInfo();
      /* Deferred group summary */
      if(gss.enabled){const _gFid=_targetFriend;const _gSealTs2=_gSealTs;setTimeout(async()=>{try{const _gAll=filterSealed(_ibOrderMessages(await dbGetByIndex('chatMessages','byFriend',_gFid)),_gSealTs2);await maybeSummarize(pickGroupUtilityCfg(group,plannedCfgs)||memberCfgs[0],_gFid,null,_gAll)}catch(e){}},500)}
    }
    return;
  }

  /* ===== NORMAL 1-ON-1 CHAT ===== */
  const cfg=apiConfigs.find(a=>a.id===_targetFriend);
  if(!cfg||!_ibApiHasCredential(cfg)){
    /* P3：前置守卫也走统一用户错误模型（普通提示 + 「打开设置」） */
    if(window.IBERR&&window.IBERR.show)window.IBERR.show(window.IBERR.model('auth',{reason:'missing-key',cfg:cfg,stage:'chat'}));
    else toast('请先在 API 页面配置密钥或本机端点');
    return;
  }
  if(!cfg.endpoint){
    if(window.IBERR&&window.IBERR.show)window.IBERR.show(window.IBERR.model('endpoint',{reason:'missing-endpoint',cfg:cfg,stage:'chat'}));
    else toast('请先配置 API 接口地址');
    return;
  }
  const thinkingOn=true;/* reasoning 始终接收和保存；是否展示由 cfg.showThinking 决定 */

  /* ── M1 · Activity 上下文解析（每回合一次，前后两条落库路径共用）──────────
     优先级由 IB.activity.resolveActivity 持有（显式 activityId → legacy 频道锚 →
     current 指针 → status='active' 最新）。结果同时用于：
       ① user 消息 metadata.activityId（activityId = 本轮活动来源，threadId = 对话归属，两个独立语义）；
       ② _turn.activityId（assistant 从同一 turn 继承）；
       ③ 预解析结果随 buildChatContext 传入，避免同回合重复读表。
     无活动（普通聊天）时 _turnActivity 为 null，两个落库路径都不会凭空出现 activityId。 */
  const _reqActivityId=String((voiceMsg&&voiceMsg.activityId)||'');
  let _turnActivity=null;
  try{
    const _actApi=(window.IB&&window.IB.activity)||null;
    if(_actApi&&typeof _actApi.resolveActivity==='function'){
      _turnActivity=await _actApi.resolveActivity(_targetFriend,{activityId:_reqActivityId||undefined,threadId:_targetThread,userMessage:_ctxText});
    }
  }catch(_actResolveErr){console.warn('[Activity] resolve failed',String(_actResolveErr&&_actResolveErr.message||_actResolveErr).slice(0,120))}

  _chatSendingFor.add(_targetFriend);
  _chatSyncComposerBusy();
  if(!_voice&&!_callTurn)input.value='';
  const sentImages=(_voice||_callTurn)?[]:_pendingImages.slice();if(!_voice&&!_callTurn)_pendingImages=[];
  const sentFiles=(_voice||_callTurn)?[]:_pendingFiles.slice();if(!_voice&&!_callTurn){_pendingFiles=[];renderAttachPreviews()}

  const userMsg={id:'msg_'+Date.now()+'_u',role:'user',content:text,friendId:_targetFriend,timestamp:Date.now()};/* 编号方式与群聊统一：后缀防同毫秒碰撞 */
  if(sentImages.length)userMsg.images=sentImages.map(img=>({dataUrl:img.dataUrl,base64:img.base64,mime:img.mime,name:img.name}));
  if(sentFiles.length)userMsg.files=sentFiles.map(f=>({name:f.name,ext:f.ext,size:f.size,text:f.text}));
  if(_voice)userMsg.voice={dataUrl:_voice.dataUrl,mime:_voice.mime,duration:_voice.duration,transcript:_voice.transcript||'',tone:_voice.tone||''};
  if(_callTurn||_turnActivity){
    userMsg.metadata={};
    if(_callTurn){userMsg.metadata.source='voice_call';userMsg.metadata.callSessionId=String(_callTurn.callSessionId||'');userMsg.metadata.turnId=String(_callTurn.turnId||'')}
    if(_turnActivity)userMsg.metadata.activityId=_turnActivity.id;/* 只记来源，不改 threadId 归属 */
  }
  if(_targetThread)userMsg.threadId=_targetThread;
  /* P21-R2-E1a · ColdStart 会话信号必须在**本条消息落库之前**探得：
     探针问的是"该会话在此之前是否已有消息"，落库之后就永远是 false。
     结果只作 latent 元数据往下传，本轮不改变任何用户可见召回行为。 */
  var _coldStartSignal=null;
  try{_coldStartSignal=await _ibProbeColdStartSignal(_targetFriend,_targetThread||'');}catch(e){_coldStartSignal=null;}
  await dbPut('chatMessages',userMsg);
  _ibAppBroadcast('turn',{state:'start',friendId:_targetFriend,threadId:_targetThread,activityId:(_turnActivity?_turnActivity.id:undefined)});
  appendChatBubble('user',text,undefined,undefined,userMsg.id,sentImages,sentFiles,undefined,_voice);
  if(!_voice&&!_callTurn&&!sentImages.length&&!sentFiles.length
    &&_targetFriend&&String(_targetFriend).indexOf('group_')!==0
    &&String(activeFriendId||'')===String(_targetFriend)
    &&String(activeThreadId||'')===String(_targetThread||'')){
    _ibFreeTextReportAttach(userMsg,{characterId:_targetFriend,threadId:_targetThread||''});
  }
  /* P23 Phase 2B · user interrupt（§11）：用户在这个会话里说话 ⇒ 取消该会话**仍在投递**的
     剩余 unit（已交付的一律保留）。没有这一条就会出现"AI 像没看见用户插话一样，
     继续把上一轮剩下的 A/B/C 发完"。取消是幂等的：没有在途队列时什么也不做。 */
  try{_ibDeliveryAbort(_targetFriend,_targetThread,'user_interrupt')}catch(e){}
  /* AI 自主规划：用户主动发言 → 取消该角色等待中的 AI 计划（异步，不阻塞） */
  try{_activeUserReplied(userMsg)}catch(e){}
  /* 日记特殊事件：首次聊天 / 久别重逢（异步，不阻塞） */
  try{_diaryMaybeEvent(_targetFriend,userMsg)}catch(e){}
  /* 上传的文件同步归档进 ICode 的「User」文件夹（先落库再请求 AI；文件内容随本条消息注入，后续可按文件名 ws_read 读取） */
  if(sentFiles.length){try{await _wsArchiveUserUploads(sentFiles)}catch(e){}}

  if(_explicitMemoryIntent&&!_explicitReferenceNeeded){
    let _memoryWrite={handled:true,ok:false,replyText:'canonical Memory 写入通道未就绪，未保存。'};
    try{_memoryWrite=await window.IBChatExplicitMemory.route({text:text,sourceMessageId:userMsg.id,
      conversationId:_ibConvId(_targetFriend,_targetThread),timestamp:userMsg.timestamp})}catch(_memoryRouteError){}
    const _memoryReply=String(_memoryWrite.replyText||'长期 Memory 写入失败，未保存。');
    const _memoryAiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:_memoryReply,
      reasoning_content:'',metadata:{model:'chat-action',model_id:'explicit-memory',config_id:cfg.id,
        showThinking:false,chatAction:'explicit-memory-write',memoryWriteOk:_memoryWrite.ok===true},
      friendId:_targetFriend,timestamp:Date.now()};
    if(_targetThread)_memoryAiMsg.threadId=_targetThread;
    try{
      await dbPut('chatMessages',_memoryAiMsg);
      appendChatBubble('ai',_memoryReply,cfg.nickname||cfg.model,undefined,_memoryAiMsg.id,undefined,undefined,undefined,undefined,cfg);
      _ibAppBroadcast('message',{id:_memoryAiMsg.id,role:'assistant',content:_memoryReply,
        senderName:cfg.nickname||cfg.model,friendId:_targetFriend,threadId:_targetThread});
    }catch(_memoryReplyError){
      _chatAppendInlineStatus(document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages'),
        _memoryReply,_memoryWrite.ok?'success':'error');
    }
    _ibAppBroadcast('turn',{state:'end',friendId:_targetFriend,threadId:_targetThread,
      activityId:(_turnActivity?_turnActivity.id:undefined)});
    _chatSendingFor.delete(_targetFriend);
    _chatSyncComposerBusy();
    autoResizeInput(input);
    if(currentPage==='chat')renderChatCalendar();
    updateChatStorageInfo();
    return {ok:true,replyText:_memoryReply,messageId:_memoryAiMsg.id,userMessageId:userMsg.id,
      memoryWriteOk:_memoryWrite.ok===true,memoryReceipt:_memoryWrite.receipt||null};
  }

  const _streamingOk=cfg.streaming!==undefined?!!cfg.streaming:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].streaming);

  /* 非流式：显示typing计时器（P23 Phase 2B：创建/销毁收敛到唯一 typing authority，
     DOM 形状、id 约定、容器选择、1s 秒表全部逐字保留 —— 交付期的 typing 复用同一个实现）。 */
  let typingEl=null,_typStart=0;/* 秒表计时器现在由 typing authority 持有（_ibTypingReg） */
  if(!_streamingOk){
    _typStart=Date.now();
    typingEl=_ibTypingOn(_targetFriend,_targetThread,_chatActivitySpeakerName(_targetFriend,cfg.id),'thinking',cfg.id);
  }

  let ss={enabled:false};/* fix: 提升到 try 外供末尾延迟摘要使用，原 const 声明在 try 内、catch 后引用必抛 ReferenceError */
  let _sendResult={ok:false,error:'no_reply',userMessageId:userMsg.id};
  let _sealTs=0;/* 封档线时间戳：同 ss 提升至 try 外供延迟摘要闭包引用 */
  let streamRefs=[];/* 流式气泡引用提升到 try 外：失败路径需要清理未写入内容的空气泡 */
  /* P11-3D.1 · 单聊的宿主 AI 回合从这里开始、到下面 finally 结束。
     周期归属的唯一事实源就是这个 turn 对象：它随 opts._ibTurn 显式传给模型调用，
     随 ictx._ibTurn 显式传给 XML 工具批次与续轮 —— 没有任何全局"当前回合"可猜。 */
  const _turnLc=_ibTurnLc(_ibTurnScope('chat'));
  const _turn=_turnLc.turn();
  _turn.activityId=_turnActivity?_turnActivity.id:null;
  /* P23 Phase 2A · 本回合的稳定身份。种子 = 触发本回合的 user 消息 id（确定性、唯一，
     不新增 id 分配权）。一次模型回合可能交付多条消息（waifu 多段呈现 / 工具续轮），
     它们共享这个 turnId 与各自的 sequenceIndex —— 单条回合根本不写这个键，
     于是旧消息的形状逐字不变（additive capability）。 */
  try{var _seqCore=_ibDeliveryCore();if(_seqCore&&typeof _seqCore.turnIdFor==='function')_turn.turnId=_seqCore.turnIdFor(userMsg.id)}catch(e){}
  _turnLc.begin();
  var _turnTraceId=_ibTurnTraceBegin({consumer:'chat',characterId:String(cfg.id||''),threadId:String(_targetThread||''),turnId:String(_turn.turnId||'')});
  _turn.traceId=_turnTraceId;
  _ibTurnTraceEvent(_turnTraceId,'input',{inputMessages:1,inputChars:String(text||'').length,attachmentCount:sentFiles.length});
  try{
    const lim=await getReadingLimits();
    _sealTs=await getChatSealTimestamp(_targetFriend);
    const friendMsgs=filterSealed(_ibOrderMessages((await dbGetByIndex('chatMessages','byFriend',_targetFriend)).filter(m=>_targetThread?m.threadId===_targetThread:!m.threadId)),_targetThread?0:_sealTs);/* 封档线仅作用于主对话，话题频道不受影响 · P23 2A：顺序走 canonical orderMessages */
    /* 历史生成图参考：用户间隔后再问"刚才那张图怎么样"时，队列可能已消费——从历史取最近一条
       assistant 生成图补入本轮（仅支持视觉的模型；图片去重防重复注入） */
    try{
      if(_ibModelCanSee(cfg)){
        for(let _hi=friendMsgs.length-1;_hi>=0;_hi--){
          const _hm=friendMsgs[_hi];
          if(_hm&&_hm.role==='assistant'&&Array.isArray(_hm.images)&&_hm.images.length){
            for(const _hg of _hm.images.slice(0,1)){
              const _hu=String(_hg&&_hg.dataUrl||'');
              if(_hu.slice(0,5)==='data:'&&_hu.length>100&&_hu.length<2.4e6&&!sentImages.some(x=>x.dataUrl===_hu)){
                sentImages.push({dataUrl:_hu,base64:String(_hg&&_hg.base64||'').trim()||String(_hu.split(',')[1]||''),mime:String(_hg&&_hg.mime||'').trim()||((String(_hu.match(/^data:([^;,]+)/i)||[])[1])||'image/jpeg'),name:String(_hg&&_hg.name||'')||'generated.png'});
              }
            }
            break;
          }
        }
      }
    }catch(e){}
    /* Summary system: only READ existing summary before sending (no API call here) */
    let summaryText=null;
    ss=await getSummarySettings();
    if(ss.enabled){
      const existingSummary=await getChatSummary(_targetFriend,_targetThread);
      if(existingSummary)summaryText=existingSummary.summary;
    }
    const keepCount=ss.enabled?(ss.keepCount||6):(lim.chatLimit||DEFAULT_READ_CHAT);
    const history=_cacheStableSlice(friendMsgs,keepCount);/* 缓存修复：阶梯窗口，起点不再逐条滑动 */
    _ibTurnTraceEvent(_turnTraceId,'input',{inputMessages:history.length+1,inputChars:String(text||'').length,attachmentCount:sentFiles.length});
    const _quoteCore=window.IBMessageQuoteCore||null;
    const _chatQuoteContext=(_quoteCore&&typeof _quoteCore.buildContext==='function')
      ?_quoteCore.buildContext(history,{mode:'chat',friendId:_targetFriend,threadId:_targetThread||'',currentSenderId:cfg.id,userName:_cachedUserName,allowedRoles:['user'],limit:8})
      :null;
    let _chatReplyQuote=null;
    const _referenceResolution=await _ibResolveChatMemoryReference(cfg,{
      userMessage:text,history:history,currentMessageId:userMsg.id,conversationId:_ibConvId(_targetFriend,_targetThread),
      friendId:_targetFriend,threadId:_targetThread||null,mode:_explicitMemoryIntent?'write':'recall'
    });
    if(_explicitMemoryIntent&&_explicitReferenceNeeded){
      let _memoryWrite={handled:false,ok:false,error:'reference-unresolved'};
      try{_memoryWrite=await window.IBChatExplicitMemory.route({text:text,sourceMessageId:userMsg.id,
        conversationId:_ibConvId(_targetFriend,_targetThread),timestamp:userMsg.timestamp},{
          referenceResolution:_referenceResolution,referenceContextMessages:history,friendId:_targetFriend,threadId:_targetThread||''
        })}catch(_memoryRouteError){}
      if(_memoryWrite.handled){
        const _memoryReply=String(_memoryWrite.replyText||'长期 Memory 写入失败，未保存。');
        const _memoryAiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:_memoryReply,
          reasoning_content:'',metadata:{model:'chat-action',model_id:'explicit-memory-write',config_id:cfg.id,
            showThinking:false,chatAction:'explicit-memory-write',memoryWriteOk:_memoryWrite.ok===true},
          friendId:_targetFriend,timestamp:Date.now()};
        if(_targetThread)_memoryAiMsg.threadId=_targetThread;
        try{
          await dbPut('chatMessages',_memoryAiMsg);
          appendChatBubble('ai',_memoryReply,cfg.nickname||cfg.model,undefined,_memoryAiMsg.id,undefined,undefined,undefined,undefined,cfg);
          _ibAppBroadcast('message',{id:_memoryAiMsg.id,role:'assistant',content:_memoryReply,
            senderName:cfg.nickname||cfg.model,friendId:_targetFriend,threadId:_targetThread});
        }catch(_memoryReplyError){
          _chatAppendInlineStatus(document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages'),
            _memoryReply,_memoryWrite.ok?'success':'error');
        }
        _ibAppBroadcast('turn',{state:'end',friendId:_targetFriend,threadId:_targetThread,
          activityId:(_turnActivity?_turnActivity.id:undefined)});
        _turnLc.end();
        _ibTurnTraceEvent(_turnTraceId,'memory',{memoryState:_memoryWrite.ok?'written':'failed',memoryAuthority:'explicit_action',memoryItems:1});
        _ibTurnTraceFinish(_turnTraceId,'completed',{resultChars:_memoryReply.length,assistantMessages:1},_turn);
        _chatSendingFor.delete(_targetFriend);_chatSyncComposerBusy();autoResizeInput(input);
        if(currentPage==='chat')renderChatCalendar();updateChatStorageInfo();
        if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
        return {ok:true,replyText:_memoryReply,userMessageId:userMsg.id,memoryWriteOk:_memoryWrite.ok===true,
          memoryReceipt:_memoryWrite.receipt||null};
      }
    }
    /* Middle Brain Trace · dev 观测（只读观测，不落盘、不含正文/密钥、不改变任何判定）：
       本轮单聊请求开始记录；后续各参与层在同一条记录上打点，回合末尾统一打印一次。 */
    var _mbTrace=(window.IB&&window.IB.__mbTrace)||null;
    if(_mbTrace)_mbTrace.begin('chat',cfg.id);
    /* 修复：历史不再注入 <thinking> 占位符——长上下文中大量同形占位样本会被模型照抄（思考区整段输出占位字样）；历史仍为常量串，缓存前缀稳定性不变 */
    /* 历史只回传用户消息与最终回答；reasoning_content 仅本地保存/导出，不显示也不回传。 */
    const _vtS1=await _vtGet();
    const _vNative=_vmAudioNative(cfg)&&(_vtS1.direct!==false);/* 音频直发判定：能听原声的模型（「音频直发」开关默认开）不附加声学语气段 */
    const messages=history.map((m,i)=>{
      var mc=m.content||'';
      if(m.role==='user'&&m.voice)mc+=(mc?'\n':'')+_voiceApiLine(m.voice,!_vNative);/* P23：仅用户语音需要等效文本行；assistant voice message 的 content 已经是文字稿本身 */
      if(m.files&&m.files.length)m.files.forEach(function(f){mc+='\n\n[文件上传: '+f.name+']\n'+_capFileText(f.text)});
      var _mm={role:m.role==='assistant'?'assistant':'user',content:m.role==='assistant'?_wsStubHistory(mc):mc};
      if(m.role!=='user'&&_mm.role==='user')_mm._groupSender=true;
      return _mm;
    });
    /* ── 上下文构建：委托 buildChatContext（Extraction Seam），只取 system/tail 分区 ── */
    if(_mbTrace){
      _mbTrace.note(cfg.id,'inputMessages',messages.length);/* MB seam 之前的 messages 条数 */
      _mbTrace.note(cfg.id,'_paramsSeam',_mbParamsFingerprint(cfg,_streamingOk,thinkingOn));
    }
    const _bcc=await buildChatContext(cfg,{friendId:_targetFriend,userMessage:_ctxText,ss:ss,summaryText:summaryText,threadId:_targetThread,coldStart:_coldStartSignal,voice:!!_callTurn,sentFiles:sentFiles,activity:_turnActivity,turnId:(_turn&&_turn.turnId)||'',_ibTraceId:_turnTraceId,conversationId:_ibConvId(_targetFriend,_targetThread),_ibRecallTurnMark:_turn,
      /* M1-C.2o：把**本轮真正交给模型的那一段 canonical 历史**（上一行的 history，
         即阶梯窗口切片）交给上下文构建器，作为当前对话证据的来源。它不是"再读一次
         会话"，而是把同一个 `history` 变量复用 —— 于是"模型看到的对话"与
         "证据里的对话"是同一段，且与 Home Node 的 canonical 历史同源。 */
      dialogueHistory:history,referenceHistory:history,referenceResolution:_referenceResolution,currentMessageId:userMsg.id});
    let sysContent=_bcc.system;
    if(_chatQuoteContext&&_chatQuoteContext.prompt)sysContent=(sysContent?sysContent+'\n\n':'')+_chatQuoteContext.prompt;
    const _tailCtx=_bcc.tail;
    if(sysContent)messages.unshift({role:'system',content:sysContent});
    _ibAddExpressionPromptHint(messages,cfg&&cfg.id);
    /* M0 · guidance 在 canonical system 后、普通对话前独立放置。未通过
       shared envelope 校验 / renderer 拒绝 ⇒ 不加任何文本，聊天照常继续。 */
    await _ibPlaceResponseGuidanceMessage(messages,_bcc&&_bcc.responseGuidance,!!sysContent,_bcc&&_bcc.responseGuidanceIdentity);
    if(_tailCtx){for(let _ti=messages.length-1;_ti>=0;_ti--){if(messages[_ti].role==='user'){_appendMsgText(messages[_ti],_CTX_TAIL_SEP+_tailCtx);break}}}
    /* 声学语气参考（request-local）：由 call.js 在当前 turn 计算并传入，非空才注入。
       仅附加到 messages 末条用户消息的【新对象】（history.map 产出的副本，非 userMsg 本体），
       因此绝不写入 userMsg.content / chatMessages / Memory / UI，也不污染历史对象。 */
    if(_callTurn&&_callTurn.acousticReference){
      for(let _arI=messages.length-1;_arI>=0;_arI--){
        if(messages[_arI]&&messages[_arI].role==='user'&&typeof messages[_arI].content==='string'){
          messages[_arI].content=messages[_arI].content+'\n\n[Acoustic reference]\n'+String(_callTurn.acousticReference)+'\n[/Acoustic reference]';
          break;
        }
      }
    }
    const _localVision=_usesLocalDeepSeekVision(cfg);
    const _nativeDeepSeekVision=_usesNativeDeepSeekVision(cfg);
    /* 视觉判定默认放行（如今多模态已普遍；显式关闭 cfg.vision=false 才拒绝）；DeepSeek 文本模型仍走本地视觉描述 */
    const _visionOk=_localVision||_nativeDeepSeekVision||(cfg.vision!==undefined?!!cfg.vision:true);
    /* R3 · 图片回注：只有支持视觉时才 take；取之前按当前 friend/thread
       做稳定 partition，错误 WHERE 与 legacy item 继续留在原队列。 */
    if(_visionOk){
      var _scopeMine=_ibWsScopeFilter(_targetFriend,_targetThread||null);
      _ibTakeScopedMedia('_ibToolDrainImages',_scopeMine).forEach(function(u){var _si=_ibMediaPromptImage(u,'tool_result.png');if(_si)sentImages.push(_si)});
      _ibTakeScopedMedia('_ibImageDrain',_scopeMine).forEach(function(u){var _si=_ibMediaPromptImage(u,'image_inject.png');if(_si)sentImages.push(_si)});
    }
    /* Video Runtime / Cinema 留影帧 → 复用既有视觉路由（request-local）：任何合法请求
       携带的 visionReference（Call 视频面 / Cinema 留影产出的原始帧）都并入 sentImages，
       由下方既有分支 (native→image parts / 本地 Qwen→描述) 统一处理；只作用于 messages，
       绝不写入 userMsg.content / chatMessages / Memory。无可用帧时为空，不影响。 */
    try{if(voiceMsg&&voiceMsg.visionReference){const _fr=voiceMsg.visionReference||{};const _du=String(_fr.dataUrl||'');if(_du.slice(0,5)==='data:')sentImages.push({dataUrl:_du,base64:_du.split(',')[1]||'',mime:'image/jpeg',name:'vision_frame.jpg'});}}catch(e){}
    if(sentImages.length&&messages.length){
      if(_localVision){
        try{
          let _question='';for(let i=messages.length-1;i>=0;i--){if(messages[i].role==='user'){_question=getTextContent(messages[i]);break}}
          _appendLocalVisionContext(messages,await _describeImagesLocally(sentImages,_question));
        }catch(_visionError){
          console.error('[LocalVision] analysis failed',_visionError);
          const _visionModel=window.IBERR&&typeof window.IBERR.model==='function'?window.IBERR.model('local_service',{source:'local_service',stage:'chat_image'}):null;
          if(_visionModel){_visionModel.title='图片识别未完成';_visionModel.message='本地视觉服务没有读出这张图片，因此本轮回复不会依据图片内容。';_visionModel.suggestion='检查本地视觉服务后，可以重新发送图片。'}
          const _visionHost=document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages');
          if(_ibConvIsActive(_targetFriend,_targetThread))_chatAppendErrorDisclosure(_visionHost,_visionModel,{scope:'image-analysis',stage:'chat_image'});
          else if(_visionModel&&window.IBERR.show)window.IBERR.show(_visionModel,{stage:'chat_image'});
          _appendLocalVisionContext(messages,'\n\n[本地视觉识别暂不可用，无法读取本次图片。]');
        }
      }else if(_visionOk){
        for(let i=messages.length-1;i>=0;i--){
          if(messages[i].role==='user'){
            const _imgNote=_nativeDeepSeekVision
              ? '\n\n【本条消息附带'+sentImages.length+'张图片】请直接查看这些图片，结合用户消息进行视觉理解与推理，并以你的角色身份回答。'
              : '\n\n【本条消息附带'+sentImages.length+'张图片】你可以查看并描述图片内容。'+(cfg.imageGen?'':'你不能生成或返回图片。');
            const txtVal=(getTextContent(messages[i])||'请查看图片')+_imgNote;/* 缓存修复：图片说明改挂本条用户消息——原先拼进 system，带图的轮次 system 字节变化会触发全量缓存重建（该轮+下一轮回退各一次）；DeepSeek 原生视觉模型走直接看图文案，不夹带图像生成限制 */

            const parts=[{type:'text',text:txtVal}];
            sentImages.forEach(img=>parts.push({type:'_image',base64:img.base64,mime:img.mime}));
            messages[i].content=parts;break
          }
        }
      }else{
        for(let i=messages.length-1;i>=0;i--){
          if(messages[i].role==='user'){
            const t=getTextContent(messages[i]);
            messages[i].content=(t||'')+(t?'\n':'')+'[用户附加了'+sentImages.length+'张图片，但当前模型不支持图片识别]';
            break
          }
        }
        const _visionHost=document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages');
        if(_ibConvIsActive(_targetFriend,_targetThread))_chatAppendInlineStatus(_visionHost,'当前模型无法读取本次图片；回复将只依据文字内容。','warning');
      }
    }
    /* File processing instructions（缓存修复：改挂末条用户消息——原先拼进 system，带附件的轮次 system 字节变化会触发全量缓存重建） */
    if(sentFiles.length){
      const _fNote='【文件处理能力】用户上传了'+sentFiles.length+'个文件。你可以阅读、分析、编辑文件内容。这些文件已同步归档到 ICode 的「User」文件夹（<ws_project name="User"/> 选定后可用 ws_edit 直接修改原件）。输出修改结果时：内容很短（50行以内）可用 ```file:文件名.扩展名 代码块直接输出下载文件；较长的文件或整份改写，请改用工作区指令（<ws_project/> + <ws_create> 或 <ws_edit>），可放心输出完整文件——输出触及长度上限时系统会自动续写拼接。在标签/代码块外用自然语言说明你做了哪些修改。';
      for(let _fi=messages.length-1;_fi>=0;_fi--){
        if(messages[_fi].role==='user'){
          if(Array.isArray(messages[_fi].content)){const _tp=messages[_fi].content.find(p=>p.type==='text');if(_tp)_tp.text+='\n\n'+_fNote;else messages[_fi].content.unshift({type:'text',text:_fNote});}
          else messages[_fi].content=String(messages[_fi].content||'')+'\n\n'+_fNote;
          break
        }
      }
    }

    /* 语音直发：能听音频的模型当轮直接收到原声（16kHz 单声道 WAV 内联）；
       注入方式与图片附件一致——仅当轮携带，历史轮次回落为文字稿行，沿用现有附件缓存行为 */
    if(_voice&&_vNative&&messages.length){
      let _vwav=null;
      try{_vwav=await _vmApiAudioWav(_voice)}catch(exa){try{console.info('[IB语音直发] 音频转换失败，本轮仅发送文字稿: '+((exa&&exa.message)||exa))}catch(e){}}
      if(_vwav){
        for(let _vi=messages.length-1;_vi>=0;_vi--){
          if(messages[_vi].role==='user'){
            if(Array.isArray(messages[_vi].content))messages[_vi].content.push({type:'_audio',mime:'audio/wav',base64:_vwav,format:'wav'});
            else messages[_vi].content=[{type:'text',text:String(messages[_vi].content||'')||'[语音消息]'},{type:'_audio',mime:'audio/wav',base64:_vwav,format:'wav'}];
            break
          }
        }
      }
    }

    var _traceContextChars=0,_traceSystemChars=0;
    messages.forEach(function(m){
      var n=0,c=m&&m.content;
      if(typeof c==='string')n=c.length;
      else if(Array.isArray(c))c.forEach(function(part){if(part&&typeof part.text==='string')n+=part.text.length});
      _traceContextChars+=n;if(m&&m.role==='system')_traceSystemChars+=n;
    });
    _ibTurnTraceEvent(_turnTraceId,'context',{contextMessages:messages.length,contextChars:_traceContextChars,systemChars:_traceSystemChars});

    if(_streamingOk){
      /* ===== 流式传输路径 ===== */
      _showStreamingUI(true);
      streamRefs=_ibConvIsActive(_targetFriend,_targetThread)?_createStreamBubble(_targetFriend,cfg.nickname||cfg.model,cfg.id,_targetThread):[];
      /* Reasoning 始终独立缓冲；仅 showThinking=true 时创建实时面板。 */
      let _liveThinkEls=[];
      const _showThinking=_resolveShowThinking(cfg);
      const _thinkFlush=(tk)=>{if(_showThinking)_appendStreamThinking(streamRefs,_liveThinkEls,tk)};
      /* 思考链缓冲状态机：拦截 <thinking> 标签 */
      let _sBuf='',_sThinkBuf='',_sState=0;
      const _wsSFilter=_wsMakeStreamFilter(_wsMakeStreamWriters(streamRefs));
      const _chatQuoteStream=(_quoteCore&&typeof _quoteCore.createStreamFilter==='function')?_quoteCore.createStreamFilter():null;
      /* 联网搜索过程可视化：SSE 事件 → 直播卡（收尾后由 _amAppendExtraCards 以 searchLog 重建持久卡） */
      const _srchLog=[];let _srchLive=null;
      const _onSearch=function(evt){
        if(evt.phase==='start'){
          _srchLive=_wsSFilter.card(function(){const c=document.createElement('div');c.className='ws-op-card pending';c.innerHTML=WS_ICON.search+'<span class="ws-op-text">正在联网搜索…</span>';return c});
        }else if(evt.phase==='query'&&_srchLive){
          _srchLive.forEach(c=>{const t=c.querySelector('.ws-op-text');if(t)t.innerHTML='正在联网搜索 · <b>'+esc(evt.query||'')+'</b>'});
        }else if(evt.phase==='results'){
          if(!_srchLive)_srchLive=_wsSFilter.card(function(){const c=document.createElement('div');c.className='ws-op-card';c.innerHTML=WS_ICON.search+'<span class="ws-op-text"></span>';return c});/* 任务A：Gemini/OpenAI 无 start 事件，直接建完成态卡 */
          _srchLive.forEach(c=>{c.classList.remove('pending');const t=c.querySelector('.ws-op-text');if(t)t.innerHTML='已联网搜索'+(evt.query?' · <b>'+esc(evt.query)+'</b>':'')+esc(' ('+(evt.results||[]).length+' 条结果)')});
          _srchLive=null;
        }
      };
      const _memLive=_mkMemLiveFilter(function(ch){_wsSFilter.push(ch)},function(build){return _wsSFilter.card(build)});
      const _calLive=(window.IBCAL&&IBCAL.mkLiveFilter)?IBCAL.mkLiveFilter(function(ch){_memLive.push(ch)},function(build){return _wsSFilter.card(build)}):null;/* CALENDAR：流中 <cal_note> 换轻量提示卡 */
      const _expressionStream=window.IBExpressionPackCore&&typeof window.IBExpressionPackCore.createTagStreamFilter==='function'?window.IBExpressionPackCore.createTagStreamFilter():null;
      /* 语音通话流式句柄：仅当本次是 voiceCall 且角色支持流式时安装。 */
      var _voiceTurnSink=null;
      if(_callTurn&&_streamingOk){
        try{
          var _vcNow=(window.IB&&IB.voiceCall&&IB.voiceCall.getCurrent&&IB.voiceCall.getCurrent())||null;
          if(_vcNow&&_vcNow.pushSentence){_voiceTurnSink=_makeVoiceSentenceSink(_vcNow);_voiceSink=_voiceTurnSink;}
        }catch(e){_voiceTurnSink=null;_voiceSink=null}
      }
      const _sEmit=(ch)=>{if(_expressionStream)ch=_expressionStream.push(ch);if(!String(ch||''))return;_chatSetStreamActivity(streamRefs,'streaming');_calLive?_calLive.push(ch):_memLive.push(ch);if(_voiceSink)_voiceSink.feed(ch)};
      const _sFlush=(ch)=>{_sEmit(_chatQuoteStream?_chatQuoteStream.push(ch):ch)};
      const _callRes={};/* 并发隔离：本次调用的思考与截断结果（不再读共享全局量） */
      /* Middle Brain Trace · 记录最终 executor / 模型 / 实际发送的 messages 条数 + 参数指纹 */
      if(_mbTrace){
        _mbTrace.note(cfg.id,'executor','callApiChatStream');
        _mbTrace.note(cfg.id,'model',String(cfg.model||''));
        _mbTrace.note(cfg.id,'outputMessages',messages.length);
        _mbTrace.note(cfg.id,'_paramsSend',_mbParamsFingerprint(cfg,_streamingOk,thinkingOn));
      }
      /* F1b · 在 retrieval 之前 begin logical turn（§13）——同 `_turn` 对象重复进入
   返回同一 index，因此 retry / fallback / continuation 都不会重复 increment。 */
const _ibTurnIndex=(typeof window._ibBeginRecallTurn==='function')?window._ibBeginRecallTurn(cfg.id,_turn):null;
let rawReply=await callApiChatStream(cfg,messages,{_ibTurn:_turn,_ibTraceId:_turnTraceId,_ibConsumer:'chat',_ibCharacterId:cfg.id,wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_callRes,searchLog:_srchLog,onSearch:_onSearch,
        onThink:function(tk){_thinkFlush(tk)},
        onChunk:function(chunk){
        if(_sState===2){_sFlush(chunk);return}
        _sBuf+=chunk;
        if(_sState===0){
          const _orphan=_sBuf.match(/^\s*<\/think(?:ing)?>\s*/i);
          if(_orphan){_sState=1;_sThinkBuf=_sBuf.slice(_orphan[0].length);_sBuf='';return}
          const _open=_sBuf.match(/^\s*<think(?:ing)?>/i);
          if(_open){_sState=1;_sThinkBuf=_sBuf.slice(_open[0].length);_sBuf='';_thinkFlush(_sThinkBuf);return}
          if(_chatStreamPrefixCanProjectReply(_sBuf))_chatSetStreamActivity(streamRefs,'streaming');
          if(_sBuf.length>60){_sState=2;_sFlush(_sBuf);_sBuf='';return}
        }
        if(_sState===1){
          _sThinkBuf+=chunk;_sBuf='';
          _thinkFlush(chunk);/* 实时显示到思考面板 */
          const closeTag=_sThinkBuf.match(/<\/think(?:ing)?>/i);
          if(closeTag){
            const idx=closeTag.index;
            const cleanThink=_sThinkBuf.slice(0,idx);
            const after=_sThinkBuf.slice(idx+closeTag[0].length);
            _sThinkBuf=cleanThink;
            _sState=2;
            /* 清理面板内容（去掉</thinking>标签残留） */
            if(_showThinking)_finishStreamThinking(_liveThinkEls,cleanThink);
            if(after&&after.trim())_sFlush(after.trim());
          }
        }
      }});
      /* 清理UI */
      _showStreamingUI(false);
      _chatSetStreamActivity(streamRefs,'');
      if(_chatQuoteStream){const _quoteStreamTail=_chatQuoteStream.finish();if(_quoteStreamTail)_sEmit(_quoteStreamTail)}
      if(_expressionStream)_expressionStream.finish();
      /* 语音语句流：模型已停止输出，把残句作为最后一句（done）推给通话线程。 */
      if(_voiceTurnSink){_voiceTurnSink.flush(true);if(_voiceSink===_voiceTurnSink)_voiceSink=null;}
      if(_calLive)_calLive.finish();
      _memLive.finish();
      _wsSFilter.finish();
      streamRefs.forEach(ref=>{
        ref.div.classList.remove('chat-stream-cursor');
        if(ref.txt.classList)ref.txt.classList.remove('chat-stream-cursor')
      });
      /* 折叠思考面板 + 移除光标 */
      _finishStreamThinking(_liveThinkEls,null);
      /* 合并思考链 */
      let thinkingText=_callRes.reasoning_content||'';
      if(!thinkingText&&_sThinkBuf.trim())thinkingText=_sThinkBuf.trim();
      var responseParts=_assistantResponseParts(rawReply,thinkingText);
      thinkingText=responseParts.reasoning_content;
      var replyText=responseParts.content;
      if(_quoteCore&&typeof _quoteCore.parseReply==='function'){
        var _quoteParsedStream=_quoteCore.parseReply(replyText,_chatQuoteContext);
        replyText=_quoteParsedStream.text;_chatReplyQuote=_quoteParsedStream.quote||null;
      }
      var _expressionReplyStream=_ibParseExpressionReply(cfg,replyText);
      replyText=String(_expressionReplyStream.text||'');
      /* 空输出防护：模型什么都没回（连思考链都没有）→ 按统一错误分类走友好提示，不再静默保存空气泡 */
      if(!(replyText&&String(replyText).trim())&&!(thinkingText&&String(thinkingText).trim()))throw window.IBERR?window.IBERR.err('empty_output'):new Error('API 返回了空内容');
      /* P11-2 · Middle Brain 生成后收口（唯一新增调用点）：调用方只交候选回复、只取回最终文本，
         不感知其内部判定/修复策略。未启用或任何故障 → 原样返回候选，聊天不受影响。
         位置在功能标签截取之前：只作用于角色可见文本，工具/记忆指令仍走既有解析。
         M1-C.2p：交出去的 `history` 是**本轮真正交给模型的那段 canonical 对话**
         （上一行那个 history 变量，不是 provider 请求数组 messages），并附上当前回合
         的消息身份 —— 与 buildChatContext 交给认知层的对话证据同源、同变量、同一份语义。 */
      try{
        var _mbFS=(window.IB&&window.IB.middleBrain)||null;
        if(_mbFS&&typeof _mbFS.middleBrainFinalizeReply==='function'){
          var _mbFinal=await _mbFS.middleBrainFinalizeReply(cfg.id,_ctxText||'',replyText,{character:cfg,history:history,currentId:userMsg.id,contextSnapshot:_bcc.snapshot,voice:!!_callTurn});
           if(_mbFinal&&typeof _mbFinal.reply==='string'&&_mbFinal.reply&&_mbFinal.reply!==replyText){
             _expressionReplyStream=_ibParseExpressionReply(cfg,_mbFinal.reply);
             replyText=String(_expressionReplyStream.text||'');
           }
          _mbVerdict=(_mbFinal&&_mbFinal.outcome&&_mbFinal.outcome.verdict)||null;
        }
      }catch(_mbFinErrS){console.warn('[MiddleBrain] finalize failed',String(_mbFinErrS&&_mbFinErrS.message||_mbFinErrS).slice(0,120))}
      /* Middle Brain Trace · dev 观测：本轮的打印点**下移到所有副作用之后**（P11-2D）——
         抑制发生在解析回复之后，若仍在此处收口，trace 永远不可能包含"本轮拦下了什么"。
         打印内容、字段白名单、只读性质与落盘行为全部不变，只改打印时机。 */
      if(_showThinking&&thinkingText){_ensureStreamThinking(streamRefs,_liveThinkEls);_finishStreamThinking(_liveThinkEls,thinkingText)}
      /* mem_* 收尾（先于 ws 解析与收尾渲染，防止标签原文上屏/入库）：普通 1:1 Chat 的
         mem_create 是 canonical implicit candidate，交给异步 runtime admission；旧 Auto Memory
         update/delete 仍走 _execMemOps。两者都受 P11-2C 的显式 Middle Brain side-effect gate 控制。 */
      var _memR=[];
      replyText=await _applyWithdraw(cfg,replyText,_targetFriend,cfg.nickname||cfg.model||'AI');
      {const _mp=_parseMemOps(replyText);
       if(_mp.ops.length){
         replyText=_mp.clean;_mbSideEffectCounts[_MB_SEC.mem]=_mp.ops.length;
         const _implicitOps=_mp.ops.filter(op=>op&&op.kind==='create');
         const _autoOps=_mp.ops.filter(op=>!op||op.kind!=='create');
         if(amEnabled(cfg)&&!cfg.amRecordOnly&&_mbSideEffectGate(_MB_SEC.mem)){
           if(_implicitOps.length&&window.IBChatImplicitMemory&&typeof window.IBChatImplicitMemory.schedule==='function')try{
             window.IBChatImplicitMemory.schedule({operations:_implicitOps,userText:text,sourceMessageId:userMsg.id,
               conversationId:_ibConvId(_targetFriend,_targetThread),timestamp:userMsg.timestamp,
               cfg:{id:cfg.id,autoMem:!!cfg.autoMem,amRecordOnly:!!cfg.amRecordOnly},
               referenceResolution:_bcc.referenceResolution,referenceContextMessages:history,friendId:_targetFriend,threadId:_targetThread||''});
           }catch(_implicitMemoryScheduleError){}
           if(_autoOps.length)_memR=await _execMemOps(_autoOps,cfg,cfg.nickname||cfg.model||'AI');
         }
       }}      /* CALENDAR：截取 <cal_note> 便笺并入库（重复/越权丢弃出警示卡）；正文出现临近事项标题时在台账打「已提及」勾 */
      var _calR=[];
      try{if(window.IBCAL){_mbSideEffectCounts[_MB_SEC.cal]=_mbCalNoteCount(replyText);if(_mbSideEffectGate(_MB_SEC.cal)){const _cp=await IBCAL.processReply(replyText,cfg);replyText=_cp.clean;_calR=_cp.results||[]}}}catch(e){}
      /* Blog 阅读申请：截取 blog_read 标签并生成申请卡（标签不入库、不上屏） */
      var _brCards=[];
      {const _bp=_parseBlogReadOps(replyText);
       if(_bp.ops.length){replyText=_bp.clean;try{if(_mbSideEffectsOk(_MB_SEC.blog,_bp.ops.length))_brCards=await _execBlogReadOps(_bp.ops,{friendId:_targetFriend,threadId:_targetThread})}catch(e){}}}
      /* 以完整回复为准重建气泡：文本 + 操作卡 + 下载卡按原始顺序分段渲染，卡片状态对齐真实执行结果 */
      var _wsParsed=_parseWsOps(replyText);
      var _wsResults=[];
      if(_wsParsed.ops.length&&_mbSideEffectGateCats(_mbSecWsCats(_wsParsed.ops),_wsParsed.ops.length))_wsResults=await _execWsOps(_wsParsed.ops,cfg.nickname||cfg.model||'AI',cfg,{source:'chat',friendId:_targetFriend,threadId:_targetThread||'',userMessageId:userMsg.id,_ibTurn:_turn,guard:_ibTurnGuard(_turn)});
      if(_wsParsed.files&&_wsParsed.files.length){try{if(_mbSideEffectGateCats([_MB_SEC.file],_wsParsed.files.length))await _wsArchiveFileBlocks(_wsParsed.files,cfg.nickname||cfg.model||'AI',_wsRoleFileProvenance(cfg))}catch(e){}}
      var _wsPhantom=_wsCheckPhantom(_wsParsed.cleanText,_wsParsed.ops.length,cfg.nickname||cfg.model||'AI',cfg.id,{friendId:_targetFriend,threadId:_targetThread||''});
      streamRefs.forEach(ref=>{_wsFinalizeBubble(ref,replyText,_wsResults)});
      /* 工具回合续（v6）：执行了工具 → 结果自动回喂再生成一轮（用户无需再说一句；失败静默不影响已渲染内容）
         P11-2C：续轮本身不再回头问 Judge（那会新增模型调用，越界），因此它沿用**本回合**
         已记录的裁定状态：本回合 UNDECIDED 时，续轮解析出的工具指令同样不执行。
         状态来源是同一个显式值，续轮不做任何独立推断。 */
      /* P11-2E · 补上条数（P11-2D 缺口）：`_mbSideEffectGateCats(cats,n)` 的条数由
         **调用方**提供，而本调用点此前没传 —— 于是 `_mbSecWsCats(ops)` 里的
         `tool_continue` 永远落进 `!(_mbSideEffectCounts[cat] > 0)` 分支：闸门照样
         正确拦截（allow=false），但**一个字都不记**，抑制记录因而声称"这一轮没拦下
         任何东西"。补上条数后记录才如实。**只补元数据，判定语义与拦截行为一字未改。** */
      /* P23 Phase 2A · 工具续轮是否真的产出过消息。续轮消息与主回复属于**同一个模型
         回合**，所以主回复必须能知道自己是不是"本回合的多条之一"（决定要不要带回合
         身份）。返回值 round = 本回合最终的消息条数；null = 没有续轮。
         这不改变任何执行/裁定语义：续轮的判定与执行条件逐字未动。 */
      let _wsCont=null;
      if((_wsParsed.ops.length||_wsParsed.files.length)&&_mbSideEffectGateCats(_mbSecWsCats(_wsParsed.ops).concat(_wsParsed.files.length?[_MB_SEC.file]:[]),_mbSecWsCount(_wsParsed.ops,_wsParsed.files.length))){
        try{_wsCont=await _wsToolContinue(cfg,{messages:messages,lastReply:replyText,friendId:_targetFriend,chatKey:_targetFriend,senderName:cfg.nickname||cfg.model||'AI',round:1,threadId:_targetThread,_ibTurn:_turn,guard:_ibTurnGuard(_turn)})}catch(e){}
      }
      /* 本回合 trace 收口（打印点已在副作用之后，故抑制记录此刻已是终值） */
      _mbSecTraceFinish(_mbTrace,cfg.id,_mbVerdict);
      if(_srchLog.length||_memR.length)streamRefs.forEach(ref=>{_amAppendExtraCards(ref.isTextNode?ref.div:ref.txt,_srchLog,_memR)});
      if(_wsPendingReads.length)streamRefs.forEach(ref=>{(ref.isTextNode?ref.div:ref.txt).appendChild(_buildWsReadHint())});
      if(_brCards.length)streamRefs.forEach(ref=>{_brCards.forEach(function(c){(ref.isTextNode?ref.div:ref.txt).appendChild(_brBuildCard(c))})});
      if(_calR.length&&window.IBCAL)streamRefs.forEach(ref=>{_calR.forEach(function(r){(ref.isTextNode?ref.div:ref.txt).appendChild(IBCAL.noteCard(r))})});
      if(_wsPhantom)streamRefs.forEach(ref=>{(ref.isTextNode?ref.div:ref.txt).appendChild(_buildWsPhantomHint(_wsPhantom))});
      /* P11-2E · 内联提示卡：接在既有卡片之后、气泡之内 —— 不改 assistant 原文、
         不覆盖内容、不做模态/浮层。放在最后是为了让它始终读得到（不被打断）。
         P11-3D.1 修复：这一段此前写在 `const aiMsg` **之前**，而它读的正是 `aiMsg`
         （_mbAppendNoticeCard(card, msg) 需要 msg.metadata.integrityNotice）——
         于是每一次**流式**单聊回合都在这里抛 TDZ 异常（Cannot access 'aiMsg'
         before initialization）：消息不落库、`_sendResult.ok=false`、用户看到的
         是一条"请求失败"。它被 catch 吞掉，所以既不影响 provider 调用、也不影响
         上面已完成的工具执行，只让整个回合在收尾时失败 —— 这正是"宿主回合还没
         结束就已经失败"，P11-3D.1 的周期所有权因此必须和它一起修。 */
      const aiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:replyText,reasoning_content:thinkingText||'',metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,showThinking:_resolveShowThinking(cfg)},friendId:_targetFriend,timestamp:Date.now()};/* 编号方式与群聊统一：随机后缀防同毫秒碰撞 */
      if(_chatReplyQuote)aiMsg.metadata.replyQuote=_chatReplyQuote;
      if(_turn&&_turn.activityId)aiMsg.metadata.activityId=_turn.activityId;/* assistant 与本回合 user 同源 */
      /* P23 Phase 2A：本回合交付了多条消息（工具续轮已落库）⇒ 主回复带回合身份与序号 0。
         单条回合**不写**这个键 —— 旧消息形状与行为逐字不变（additive capability）。 */
      if(_wsCont&&_turn&&_turn.turnId){aiMsg.metadata.turnId=_turn.turnId;aiMsg.metadata.sequenceIndex=0;if(Number(_wsCont.round)>0)aiMsg.metadata.sequenceTotal=Number(_wsCont.round);}
      if(_srchLog.length)aiMsg.wsSearches=_srchLog;
      if(_memR.length)aiMsg.memOps=_memR.map(r=>({ok:r.ok,status:r.status||'',label:r.label,detail:r.detail}));
      if(_calR.length)aiMsg.calNotes=_calR.map(r=>({ok:r.ok,label:r.label,detail:r.detail}));
      {const _giImgs=_wsCollectGenImages(_wsResults);if(_giImgs.length)aiMsg.images=_giImgs;}/* 生成的图片随消息持久化，历史重载可见 */
      if(_targetThread)aiMsg.threadId=_targetThread;
      if(_callRes.truncated)aiMsg.truncated=true;/* 任务6：自动续写轮数用尽仍截断 */
      /* P11-2E · 用户可见提示（唯一落库点，流式）——
         位置必须在**所有副作用结束之后**：抑制记录是本回合累计的，早于最后一道
         闸门读取会漏掉后面的类别。读的是 integrity 层已经产出的记录，不重新判定、
         不额外询问闸门。无抑制 ⇒ 不写键（历史消息无键的渲染路径因此与改动前逐字一致）。 */
      {const _n=_mbIntegrityNoticeFor(_mbVerdict);if(_n)aiMsg.metadata.integrityNotice=_n;}
      _ibPrepareExpressionMessage(aiMsg,cfg,_expressionReplyStream.expressionRef);
      await dbPut('chatMessages',aiMsg);
      _ibAppBroadcast('message',{id:aiMsg.id,role:'assistant',content:aiMsg.content,senderName:cfg.nickname||cfg.model||'AI',friendId:_targetFriend,threadId:_targetThread,activityId:((aiMsg.metadata&&aiMsg.metadata.activityId)||undefined)});
      _ibAppBroadcast('turn',{state:'end',friendId:_targetFriend,threadId:_targetThread,activityId:((aiMsg.metadata&&aiMsg.metadata.activityId)||undefined)});
      _sendResult={ok:true,replyText:replyText,messageId:aiMsg.id,userMessageId:userMsg.id,voiceStreamed:!!_voiceTurnSink};
      /* 内联提示卡：此刻 aiMsg 已经存在且已落库，读的是它的 metadata.integrityNotice。 */
      streamRefs.forEach(ref=>{_mbAppendNoticeCard((ref.isTextNode?ref.div:ref.txt),aiMsg)});
      streamRefs.forEach(ref=>{
        if(_chatReplyQuote)_chatAppendReplyQuoteCard(aiMsg,history,ref.div);
        if(aiMsg.id){ref.div.dataset.msgId=aiMsg.id;
          if(typeof _chatSelectMode!=='undefined'&&_chatSelectMode&&ref.full&&!ref.div.querySelector('.chat-sel-circle')){const sc=_chatCreateSelectionControl(aiMsg.id);if(sc)ref.div.appendChild(sc)}/* BUGFIX: Select 模式中流式完成的消息补圈 */
          _chatAppendMessageActions(aiMsg,ref.div,ref.full)}
        if(aiMsg.truncated&&ref.full)ref.txt.appendChild(_buildContinuePill(aiMsg.id));/* 任务6 */
      });
      _syncMiniAfterStream(aiMsg.id,_targetFriend);
      if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
    }else{
      /* ===== 非流式传输路径（原有逻辑） ===== */
      const _srchLogN=[];/* 任务A：非流式同样收集搜索记录（三家通用） */
      const _callResN={};/* 并发隔离：本次调用的思考与截断结果 */
      /* Middle Brain Trace · 记录最终 executor / 模型 / 实际发送的 messages 条数 + 参数指纹 */
      if(_mbTrace){
        _mbTrace.note(cfg.id,'executor','callApiChat');
        _mbTrace.note(cfg.id,'model',String(cfg.model||''));
        _mbTrace.note(cfg.id,'outputMessages',messages.length);
        _mbTrace.note(cfg.id,'_paramsSend',_mbParamsFingerprint(cfg,_streamingOk,thinkingOn));
      }
      let rawReply=await callApiChat(cfg,messages,{_ibTurn:_turn,_ibTraceId:_turnTraceId,_ibConsumer:'chat',_ibCharacterId:cfg.id,wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_callResN,searchLog:_srchLogN});
      _ibTypingFinish(_targetFriend,cfg.nickname||cfg.model,_typStart);
      var responsePartsN=_assistantResponseParts(rawReply,_callResN.reasoning_content||'');
      let thinkingText=responsePartsN.reasoning_content;
      var replyText=responsePartsN.content;
      if(_quoteCore&&typeof _quoteCore.parseReply==='function'){
        var _quoteParsedNonStream=_quoteCore.parseReply(replyText,_chatQuoteContext);
        replyText=_quoteParsedNonStream.text;_chatReplyQuote=_quoteParsedNonStream.quote||null;
      }
      var _expressionReplyNonStream=_ibParseExpressionReply(cfg,replyText);
      replyText=String(_expressionReplyNonStream.text||'');
      /* 空输出防护（非流式）：与流式路径同一处理，走统一错误分类 */
      if(!(replyText&&String(replyText).trim())&&!(thinkingText&&String(thinkingText).trim()))throw window.IBERR?window.IBERR.err('empty_output'):new Error('API 返回了空内容');
      /* P11-2 · Middle Brain 生成后收口（唯一新增调用点）：调用方只交候选回复、只取回最终文本，
         不感知其内部判定/修复策略。未启用或任何故障 → 原样返回候选，聊天不受影响。
         位置在功能标签截取之前：只作用于角色可见文本，工具/记忆指令仍走既有解析。
         M1-C.2p：与流式路径逐字同款 —— 交 canonical 对话切片 + 当前回合身份。 */
      try{
        var _mbFN=(window.IB&&window.IB.middleBrain)||null;
        if(_mbFN&&typeof _mbFN.middleBrainFinalizeReply==='function'){
          var _mbFinal=await _mbFN.middleBrainFinalizeReply(cfg.id,_ctxText||'',replyText,{character:cfg,history:history,currentId:userMsg.id,contextSnapshot:_bcc.snapshot,voice:!!_callTurn});
           if(_mbFinal&&typeof _mbFinal.reply==='string'&&_mbFinal.reply&&_mbFinal.reply!==replyText){
             _expressionReplyNonStream=_ibParseExpressionReply(cfg,_mbFinal.reply);
             replyText=String(_expressionReplyNonStream.text||'');
           }
          _mbVerdict=(_mbFinal&&_mbFinal.outcome&&_mbFinal.outcome.verdict)||null;
        }
      }catch(_mbFinErrN){console.warn('[MiddleBrain] finalize failed',String(_mbFinErrN&&_mbFinErrN.message||_mbFinErrN).slice(0,120))}
      /* Middle Brain Trace · 打印点与非流式逐字同款：下移到副作用之后（P11-2D）。 */
      /* 非流式路径与流式路径同款：mem_create 进入 canonical implicit admission；旧 Auto Memory
         update/delete 仍走 _execMemOps，side-effect 决策只看显式裁定状态。 */
      var _memRNs=[];
      replyText=await _applyWithdraw(cfg,replyText,_targetFriend,cfg.nickname||cfg.model||'AI');
      {const _mpn=_parseMemOps(replyText);
       if(_mpn.ops.length){
         replyText=_mpn.clean;_mbSideEffectCounts[_MB_SEC.mem]=_mpn.ops.length;
         const _implicitOpsN=_mpn.ops.filter(op=>op&&op.kind==='create');
         const _autoOpsN=_mpn.ops.filter(op=>!op||op.kind!=='create');
         if(amEnabled(cfg)&&!cfg.amRecordOnly&&_mbSideEffectGate(_MB_SEC.mem)){
           if(_implicitOpsN.length&&window.IBChatImplicitMemory&&typeof window.IBChatImplicitMemory.schedule==='function')try{
             window.IBChatImplicitMemory.schedule({operations:_implicitOpsN,userText:text,sourceMessageId:userMsg.id,
               conversationId:_ibConvId(_targetFriend,_targetThread),timestamp:userMsg.timestamp,
               cfg:{id:cfg.id,autoMem:!!cfg.autoMem,amRecordOnly:!!cfg.amRecordOnly},
               referenceResolution:_bcc.referenceResolution,referenceContextMessages:history,friendId:_targetFriend,threadId:_targetThread||''});
           }catch(_implicitMemoryScheduleError){}
           if(_autoOpsN.length)_memRNs=await _execMemOps(_autoOpsN,cfg,cfg.nickname||cfg.model||'AI');
         }
       }}
      /* CALENDAR：非流式同样截取 <cal_note> 并入库、扫描提及 */
      var _calRNs=[];
      try{if(window.IBCAL){_mbSideEffectCounts[_MB_SEC.cal]=_mbCalNoteCount(replyText);if(_mbSideEffectGate(_MB_SEC.cal)){const _cpn=await IBCAL.processReply(replyText,cfg);replyText=_cpn.clean;_calRNs=_cpn.results||[]}}}catch(e){}
      /* Blog 阅读申请：截取 blog_read 标签并生成申请卡（标签不入库、不上屏） */
      var _brCardsNs=[];
      {const _bpn=_parseBlogReadOps(replyText);
       if(_bpn.ops.length){replyText=_bpn.clean;try{if(_mbSideEffectsOk(_MB_SEC.blog,_bpn.ops.length))_brCardsNs=await _execBlogReadOps(_bpn.ops,{friendId:_targetFriend,threadId:_targetThread})}catch(e){}}}
      var _wsNs=_parseWsOps(replyText);
      var _wsRNs=[];
      if(_wsNs.ops.length&&_mbSideEffectGateCats(_mbSecWsCats(_wsNs.ops),_wsNs.ops.length))_wsRNs=await _execWsOps(_wsNs.ops,cfg.nickname||cfg.model||'AI',cfg,{source:'chat',friendId:_targetFriend,threadId:_targetThread||'',userMessageId:userMsg.id,_ibTurn:_turn,guard:_ibTurnGuard(_turn)});
      if(_wsNs.files&&_wsNs.files.length){try{if(_mbSideEffectGateCats([_MB_SEC.file],_wsNs.files.length))await _wsArchiveFileBlocks(_wsNs.files,cfg.nickname||cfg.model||'AI',_wsRoleFileProvenance(cfg))}catch(e){}}
      var _wsNsPhantom=_wsCheckPhantom(_wsNs.cleanText,_wsNs.ops.length,cfg.nickname||cfg.model||'AI',cfg.id,{friendId:_targetFriend,threadId:_targetThread||''});
      /* 工具回合续（v6）：非流式主对话同样自动回喂再生成一轮（P11-2C：同款沿用本回合裁定状态）
         P11-2E：与流式路径同款补上条数（见上方流式路径的说明）。 */
      let _wsContN=null;/* P23 Phase 2A：与流式路径同款 —— 本回合最终消息条数（null = 无续轮） */
      if((_wsNs.ops.length||_wsNs.files.length)&&_mbSideEffectGateCats(_mbSecWsCats(_wsNs.ops).concat(_wsNs.files.length?[_MB_SEC.file]:[]),_mbSecWsCount(_wsNs.ops,_wsNs.files.length))){
        try{_wsContN=await _wsToolContinue(cfg,{messages:messages,lastReply:replyText,friendId:_targetFriend,chatKey:_targetFriend,senderName:cfg.nickname||cfg.model||'AI',round:1,threadId:_targetThread,_ibTurn:_turn,guard:_ibTurnGuard(_turn)})}catch(e){}
      }
      /* 本回合 trace 收口（与非流式逐字同款） */
      _mbSecTraceFinish(_mbTrace,cfg.id,_mbVerdict);
      const aiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:replyText,reasoning_content:thinkingText||'',metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,showThinking:_resolveShowThinking(cfg)},friendId:_targetFriend,timestamp:Date.now()};/* 编号方式与群聊统一：随机后缀防同毫秒碰撞 */
      if(_chatReplyQuote)aiMsg.metadata.replyQuote=_chatReplyQuote;
      if(_turn&&_turn.activityId)aiMsg.metadata.activityId=_turn.activityId;/* assistant 与本回合 user 同源（非流式与流式一致） */
      /* P23 Phase 2A：与流式路径逐字同款 —— 本回合有工具续轮 ⇒ 主回复带回合身份与序号 0。 */
      if(_wsContN&&_turn&&_turn.turnId){aiMsg.metadata.turnId=_turn.turnId;aiMsg.metadata.sequenceIndex=0;if(Number(_wsContN.round)>0)aiMsg.metadata.sequenceTotal=Number(_wsContN.round);}
      if(_srchLogN.length)aiMsg.wsSearches=_srchLogN;/* 任务A */
      if(_memRNs.length)aiMsg.memOps=_memRNs.map(r=>({ok:r.ok,status:r.status||'',label:r.label,detail:r.detail}));
      if(_calRNs.length)aiMsg.calNotes=_calRNs.map(r=>({ok:r.ok,label:r.label,detail:r.detail}));
      {const _giImgsN=_wsCollectGenImages(_wsRNs);if(_giImgsN.length)aiMsg.images=_giImgsN;}/* 生成的图片随消息持久化 */
      if(_targetThread)aiMsg.threadId=_targetThread;
      if(_callResN.truncated)aiMsg.truncated=true;/* 任务6：自动续写轮数用尽仍截断 */
      /* P11-2E · 用户可见提示（唯一落库点，非流式）——与流式路径逐字同款同形。 */
      {const _nNs=_mbIntegrityNoticeFor(_mbVerdict);if(_nNs)aiMsg.metadata.integrityNotice=_nNs;}
      /* waifu 消息呈现（MessagePresentation）：非流式纯文本长回复 → 按自然停顿拆多条，逐条上屏（像真人一条条发）。
         仅当 waifu 开、且回复为"纯文本、无功能标签"时介入；plan 决定 single/multi，绝不触碰模型执行/continuation。 */
      const _waifuPlan=(cfg.waifu===true&&!_wsNs.ops.length&&_wsNs.files.length===0&&_memRNs.length===0&&_calRNs.length===0&&_brCardsNs.length===0&&!_wsNsPhantom&&!_srchLogN.length&&!_callResN.truncated&&window.MessagePresentation&&window.MessagePresentation.plan)?window.MessagePresentation.plan(replyText,{waifu:true,streaming:false}):null;
      const _waifuSegs=(_waifuPlan&&_waifuPlan.mode==='multi')?_waifuPlan.messages:null;
      const _waifuExpressionRefs=(_waifuSegs&&window.IBExpressionPackCore&&typeof window.IBExpressionPackCore.expressionRefsForSegments==='function')
        ?window.IBExpressionPackCore.expressionRefsForSegments(_expressionReplyNonStream,_waifuSegs.map(function(s){return String(s&&s.text||'')})):[];
      /* P23 Phase 2D：结构定下来之后，**模态**交给唯一的 Multimodal Delivery Policy。
         默认（没有显式意图/偏好/提示）⇒ 全部 text，下面走的仍是 2A/2B 既有路径，
         与 2D 之前逐字同形。只有 policy 真的决定出 voice unit 时，才切到
         materialization path（音频在该 unit 到达 delivery time 时才合成）。 */
      const _mmResult=(_waifuSegs&&_waifuSegs.length)?_ibMmResolve(
        _waifuSegs.map(function(s){return String(s&&s.text||'')}),cfg,
        {turnId:(_turn&&_turn.turnId)||'',conversationId:_ibConvId(_targetFriend,_targetThread),hints:(_waifuPlan&&_waifuPlan.hints)||null}
      ):null;
      const _mmHasVoice=!!(_mmResult&&_mmResult.stats&&_mmResult.stats.voiceResolved>0);
      /* P23 Phase 2A：多段交付**必须**经 Sequence Contract 落库 —— 每条一条独立
         canonical 消息，共享回合身份、共用同一个 timestamp（顺序由 sequenceIndex
         决定，绝不再靠 +1ms 的时间差制造顺序）。节奏与渲染仍由下面的循环负责。 */
      const _waifuMsgs=(_waifuSegs&&!_mmHasVoice)?_ibSequenceMessages((_mmResult?_mmResult.units:_waifuSegs.map(function(s){return {content:String(s&&s.text||'')}})).map(function(u){return String(u.content==null?'':u.content)}),{
        turnId:(_turn&&_turn.turnId)||'',friendId:_targetFriend,threadId:_targetThread,timestamp:Date.now(),
        model:cfg.provider||cfg.model||'',modelId:cfg.model||'',configId:cfg.id,
        showThinking:_resolveShowThinking(cfg),extraMetadata:{waifu:true,activityId:(_turn&&_turn.activityId)||undefined}
      }):null;
      if(_chatReplyQuote&&_waifuMsgs&&_waifuMsgs.length){_waifuMsgs[0].metadata=_waifuMsgs[0].metadata||{};_waifuMsgs[0].metadata.replyQuote=_chatReplyQuote;}
      if(_mmHasVoice&&_mmResult&&_mmResult.units.length){
        /* materialization path：unit 只带 kind/content；canonical 消息与音频都在 delivery time 生成。 */
        const _wHandleV=_ibStartDelivery({
          turnId:(_turn&&_turn.turnId)||'',friendId:_targetFriend,threadId:_targetThread,
          cfg:cfg,senderName:cfg.nickname||cfg.model||'AI',thinkingText:thinkingText||'',
          activityId:(_turn&&_turn.activityId)||null,timestamp:Date.now(),lazyBuild:true,
          model:cfg.provider||cfg.model||'',modelId:cfg.model||'',configId:cfg.id,
          showThinking:_resolveShowThinking(cfg),
          quoteSources:history,replyQuote:_chatReplyQuote,
          units:_mmResult.units.map(function(u,i){
            return {kind:u.kind,content:u.content,
              expressionRef:_waifuExpressionRefs[i]||null,
              delivery:(i===0?null:{delayBefore:(Number(_waifuSegs[i]&&_waifuSegs[i].delay)||0)})};
          })
        });
        if(_wHandleV){
          await _wHandleV.promise;
          _sendResult={ok:true,replyText:replyText,messageId:null,userMessageId:userMsg.id};
          if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
        }else{
          /* runtime 不可用 ⇒ 全部按 text 立即交付（内容一字不丢），并把这次形式降级记进 policy trace。 */
          try{var _P0=_ibMmPolicy();if(_P0&&typeof _P0.note==='function')_P0.note(_mmResult.units.map(function(_,i){return {unitIndex:i,requested:'voice',resolved:'text',reason:'runtime-unavailable'}}),{turnId:(_turn&&_turn.turnId)||''});}catch(e){}
          const _fbMsgs=_ibSequenceMessages(_mmResult.units.map(function(u){return u.content}),{
            turnId:(_turn&&_turn.turnId)||'',friendId:_targetFriend,threadId:_targetThread,timestamp:Date.now(),
            model:cfg.provider||cfg.model||'',modelId:cfg.model||'',configId:cfg.id,
            showThinking:_resolveShowThinking(cfg),extraMetadata:{waifu:true,activityId:(_turn&&_turn.activityId)||undefined}
          });
          if(_chatReplyQuote&&_fbMsgs&&_fbMsgs.length){_fbMsgs[0].metadata=_fbMsgs[0].metadata||{};_fbMsgs[0].metadata.replyQuote=_chatReplyQuote;}
          _ibRememberExpressionRefs(_fbMsgs,_waifuExpressionRefs,cfg);
          for(let _wi=0;_fbMsgs&&_wi<_fbMsgs.length;_wi++){
            await dbPut('chatMessages',_fbMsgs[_wi]);
            if(activeFriendId===_targetFriend)appendChatBubble('ai',_fbMsgs[_wi].content,undefined,_wi===0?(thinkingText||undefined):undefined,_fbMsgs[_wi].id,undefined,undefined,undefined,undefined,cfg,_fbMsgs[_wi],history);
          }
          _sendResult={ok:true,replyText:replyText,messageId:null,userMessageId:userMsg.id};
          if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
        }
      }else if(_waifuMsgs&&_waifuMsgs.length){
        /* P23 Phase 2B：交付交给 Delivery Runtime（时间 / typing / 取消 / 会话隔离的唯一
           authority）。这里只做两件事：把 canonical unit 交出去、等它跑完。
           · 首条不等待（生成期的"思考中"已经承担了那段时间）；后续条目的等待值仍然来自
             既有 planner（MessagePresentation）——runtime 不在本阶段新增任何节奏策略；
           · await handle.promise 保持"本函数在交付结束后才返回"的既有语义，
             因此 call.js / active-plans 等调用方逐字不受影响；
           · 用户中途插话 / 点停止 ⇒ runtime 取消剩余 unit，已交付的保留（§10/§11）。 */
        for(let _wi=0;_wi<_waifuMsgs.length;_wi++){
          _waifuMsgs[_wi].reasoning_content=(_wi===0?(thinkingText||''):'');
        }
        _ibRememberExpressionRefs(_waifuMsgs,_waifuExpressionRefs,cfg);
        const _wUnits=_waifuMsgs.map(function(m,i){
          return {kind:m.voice?'voice':'text',content:m.content,
            expressionRef:_waifuExpressionRefs[i]||null,
            delivery:(i===0?null:{delayBefore:(Number(_waifuSegs[i]&&_waifuSegs[i].delay)||0)}),
            message:m};
        });
        const _wHandle=_ibStartDelivery({
          turnId:(_turn&&_turn.turnId)||'',friendId:_targetFriend,threadId:_targetThread,
          cfg:cfg,senderName:cfg.nickname||cfg.model||'AI',thinkingText:thinkingText||'',
          quoteSources:history,replyQuote:_chatReplyQuote,
          activityId:(_turn&&_turn.activityId)||null,units:_wUnits
        });
        if(_wHandle){
          await _wHandle.promise;
          _sendResult={ok:true,replyText:replyText,messageId:null,userMessageId:userMsg.id};
          if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);/* BUGFIX: 多段消息同样需要在非活动好友时标记未读 */
        }else{
          /* runtime 不可用（旧宿主 / 未加载）⇒ 退回**逐条立即交付**：顺序与内容不变，
             只失去节奏与 typing（绝不因为归一层缺席而丢消息）。 */
          for(let _wi=0;_wi<_waifuMsgs.length;_wi++){
            const _wMsg=_waifuMsgs[_wi];
            _ibPrepareExpressionMessage(_wMsg,cfg,_waifuExpressionRefs[_wi]||null);
            await dbPut('chatMessages',_wMsg);
            if(activeFriendId===_targetFriend)appendChatBubble('ai',_wMsg.content,undefined,_wi===0?(thinkingText||undefined):undefined,_wMsg.id,undefined,undefined,undefined,undefined,cfg,_wMsg,history);
          }
          _sendResult={ok:true,replyText:replyText,messageId:null,userMessageId:userMsg.id};
          if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
        }
      }else{
        _ibPrepareExpressionMessage(aiMsg,cfg,_expressionReplyNonStream.expressionRef);
        await dbPut('chatMessages',aiMsg);
        _sendResult={ok:true,replyText:replyText,messageId:aiMsg.id,userMessageId:userMsg.id};
        if(activeFriendId===_targetFriend){
        appendChatBubble('ai',replyText,undefined,thinkingText||undefined,aiMsg.id,aiMsg.images,undefined,_wsRNs,undefined,cfg,aiMsg,history);
        if(_srchLogN.length||_memRNs.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_amAppendExtraCards(el,_srchLogN,_memRNs)});/* 任务A：非流式也显示搜索/记忆卡 */
        if(_wsPendingReads.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsReadHint())});
        if(_brCardsNs.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_brCardsNs.forEach(function(c){el.appendChild(_brBuildCard(c))})});
        if(_calRNs.length&&window.IBCAL)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_calRNs.forEach(function(r){el.appendChild(IBCAL.noteCard(r))})});
        if(_wsNsPhantom)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsPhantomHint(_wsNsPhantom))});
        /* P11-2E · 内联提示卡（非流式）：与流式路径同款同形 */
        document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_mbAppendNoticeCard(el,aiMsg)});
        if(aiMsg.truncated)document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id="'+aiMsg.id+'"] .r-text').forEach(function(t){t.appendChild(_buildContinuePill(aiMsg.id))});/* 任务6 */
      }
      else _markUnread(_targetFriend);
      }
      /* 微信式小动作（v7）：非 waifu 单条消息 → AI 自查撤回 或 拍一拍（撤回）；延迟让用户先看到内容再撤 */
      if(!_waifuMsgs){
        var __wRid=aiMsg.id,__wText=replyText;
        setTimeout(function(){ if(_chatShouldWithdraw(__wText)){_chatWithdrawMsg(__wRid)} else {_maybePatWithdraw(cfg,__wRid)} },1000);
      }
    }
  }catch(err){
    _ibTypingOff(_targetFriend);/* P23 Phase 2B：错误路径同样经唯一 typing authority 清理 */
    _showStreamingUI(false);
    _chatSetStreamActivity(streamRefs,'');
    /* Middle Brain Trace · 失败轮也打印一次（层参与度与成功轮同格式，便于对照断点） */
    if(_mbTrace)_mbTrace.finish(cfg.id,{});
    /* 失败时移除还没写入任何内容的流式气泡（含思考面板卡），避免残留带光标的空气泡；已流出内容的气泡保留 */
    try{(streamRefs||[]).forEach(function(ref){const _t=String((ref.txt&&ref.txt.textContent)||'');const _hasCards=typeof (ref.txt&&ref.txt.querySelector)==='function'&&!!ref.txt.querySelector('.ws-op-card');if(!_t.trim()&&!_hasCards&&ref.div.parentNode)ref.div.parentNode.removeChild(ref.div)})}catch(e){}
    /* 统一错误分类 + 角色化友好文案；完整技术错误已由 IBERR.report 与底层日志写入 Console */
    const _userStopped=String(err&&err.ibCat||'')==='aborted';
    const _ibFE=_userStopped?null:(window.IBERR?window.IBERR.report(err,{cfg:cfg,friendId:_targetFriend,stage:'chat'}):null);
    if(!_userStopped){
      /* L1 stays with the failed user turn; there is no message-level Retry owner. L3 opens only on demand. */
      _chatPresentSendFailure(_targetFriend,_targetThread,_ibFE&&_ibFE.model,{
        scope:'send',stage:'chat',errorFor:userMsg.id,title:_ibFE&&_ibFE.model?_ibFE.model.title:'请求没有完成',
        message:_ibFE&&_ibFE.model?_ibFE.model.message:'这次请求没有完成。',
        suggestion:_ibFE&&_ibFE.model?_ibFE.model.suggestion:'检查网络或 API 设置后，可重新发送消息。'
      });
    }
    _sendResult={ok:false,error:String(err&&err.message||err),userMessageId:userMsg.id};
  }
  /* P11-3D.1：宿主回合结束 —— 周期的**唯一**收尾点（正常与异常出口共用）。
     幂等：什么都没开过就是空操作；已经收过就不再收第二次。 */
  var _sendErrorCategory=_sendResult.ok?'':_ibProviderErrorCategory(new Error(String(_sendResult.error||'')));
  _ibTurnTraceFinish(_turnTraceId,_sendResult.ok?'completed':(_sendErrorCategory==='aborted'?'aborted':'failed'),{
    resultChars:String(_sendResult.replyText||'').length,assistantMessages:_sendResult.messageId?1:0,
    errorCategory:_sendErrorCategory
  },_turn);
  _turnLc.end();
  _chatSendingFor.delete(_targetFriend);
  _chatSyncComposerBusy();
  autoResizeInput(input);
  /* AI 自主规划：回复成功保存后，异步生成下一次主动联系计划（fail-open，绝不影响聊天） */
  try{_activeMaybePlanNext({friendId:_targetFriend,threadId:_targetThread,character:cfg})}catch(e){}
  /* Deferred summary: generate AFTER response, async, no blocking */
  if(ss.enabled){
    const _sumFid=_targetFriend,_sumTid=_targetThread,_sumSealTs=_sealTs;
    setTimeout(async()=>{try{
      const _allM=filterSealed(_ibOrderMessages((await dbGetByIndex('chatMessages','byFriend',_sumFid)).filter(m=>_sumTid?m.threadId===_sumTid:!m.threadId)),_sumTid?0:_sumSealTs);/* P23 2A：canonical 顺序 */
      await maybeSummarize(cfg,_sumFid,_sumTid,_allM);
    }catch(e){}},500);
  }
  if(currentPage==='chat')renderChatCalendar();
  updateChatStorageInfo();
  return _sendResult;
}

function appendChatBubble(role,text,senderName,reasoningContent,msgId,images,files,wsResults,voice,modelConfig,messageRecord,quoteSources){
  const isUser=role==='user';
  const imgs=images||[];
  const fls=files||[];
  const miniPanel=document.getElementById('chat-panel');
  const miniVisible=miniPanel&&miniPanel.classList.contains('show');
  const containers=[
    {el:miniVisible?document.getElementById('chat-messages'):null,full:false},
    {el:document.getElementById('chat-full-messages'),full:true}
  ];
  containers.forEach(({el:container,full})=>{
    if(!container)return;
    const sysMsg=container.querySelector('.chat-msg.system');
    if(sysMsg)sysMsg.remove();
    if(!isUser&&reasoningContent&&_resolveShowThinking(modelConfig))container.appendChild(_buildChatThinkingEl(reasoningContent,!full,false).wrap);
    const div=document.createElement('div');
    div.className='chat-msg '+role;
    if(msgId)div.dataset.msgId=msgId;
    if(full){
      div.dataset.senderRole=isUser?'user':'ai';
      div.dataset.senderId=_chatSpeakerKey({role:isUser?'user':'assistant',friendId:activeFriendId,senderName:senderName,metadata:{config_id:modelConfig&&modelConfig.id}});
    }
    /* BUGFIX: Select 模式进行中到达的新消息也补上选择圈 */
    if(msgId&&typeof _chatSelectMode!=='undefined'&&_chatSelectMode&&full){
      const c=_chatCreateSelectionControl(msgId);
      if(c)div.appendChild(c);
    }
    if(full){
      const sName=isUser?(_cachedUserName||'You'):(senderName||_getActiveAiName()||'AI');
      const timeStr=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const aiAvatar=!isUser?(_getApiAvatar()||_getApiAvatarByName(senderName)):'';
      const userAvatar=isUser?_cachedUserAvatar:'';
      const useAvatarLayout=isUser||!!aiAvatar;
      var _prevMsgs=container.querySelectorAll('.chat-msg');
      var _lastM=_prevMsgs.length?_prevMsgs[_prevMsgs.length-1]:null;
      var _isCont=!!(_lastM&&_lastM.dataset.senderRole===div.dataset.senderRole&&_lastM.dataset.senderId===div.dataset.senderId);
      if(useAvatarLayout){
        div.classList.add('chat-msg-avatared');
        if(!_isCont){
          /* 用户侧 row-reverse：时间插在头像与昵称之间 → 视觉上昵称在前、时间在后 */
          const hdr=document.createElement('div');
          hdr.className='chat-msg-header '+(isUser?'align-right':'align-left');
          hdr.appendChild(_buildAvatarCircle(sName,isUser?userAvatar:aiAvatar));
          const nm=document.createElement('span');nm.className='r-head-name';nm.textContent=sName;
          const tm=document.createElement('span');tm.className='r-time';tm.textContent=timeStr;
          if(isUser){hdr.appendChild(tm);hdr.appendChild(nm)}else{hdr.appendChild(nm);hdr.appendChild(tm)}
          container.appendChild(hdr);
        }else{
          const ct=document.createElement('div');ct.className='chat-msg-cont-time';
          ct.style.textAlign=isUser?'right':'left';
          if(isUser)ct.style.marginRight='46px'; else ct.style.marginLeft='46px';
          ct.textContent=timeStr;container.appendChild(ct);
        }
        const txt=document.createElement('div');txt.className='r-text';
        /* P23 Phase 2D：assistant 的一级 voice message 也必须能**即时**画成语音气泡
           （历史重载走 _buildMsgEl，那里早就会画；实时追加过去只画文本，会出现
           "落库是 voice、眼前是文字"的分叉）。判定仍复用 Phase 1 的唯一函数
           _ibAiVoicePayload（陈旧/撤回/不可播放一律回落文本）。 */
        if(!isUser){var _av1=_ibAiVoicePayload({role:'assistant',content:text,voice:voice||null});if(_av1)_renderAiVoice(txt,{voice:_av1});else _renderAiContent(txt,div,text,wsResults)}else if(voice){if(text)txt.appendChild(document.createTextNode(text));txt.appendChild(_buildVoiceEl(voice))}else{txt.textContent=text}
        div.appendChild(txt);
      }else{
        const head=document.createElement('div');head.className='r-head';
        head.innerHTML=esc(sName)+'<span class="r-time">'+timeStr+'</span>';
        div.appendChild(head);
        const txt=document.createElement('div');txt.className='r-text';
        if(!isUser){var _av2=_ibAiVoicePayload({role:'assistant',content:text,voice:voice||null});if(_av2)_renderAiVoice(txt,{voice:_av2});else _renderAiContent(txt,div,text,wsResults)}else if(voice){if(text)txt.appendChild(document.createTextNode(text));txt.appendChild(_buildVoiceEl(voice))}else{txt.textContent=text}
        div.appendChild(txt);
      }
      fls.forEach(function(f){div.appendChild(_buildFileCard(f))});
      imgs.forEach(img=>{const el=document.createElement('img');el.className='chat-bubble-img';el.src=img.dataUrl;el.alt=img.name||'image';el.onclick=function(){_viewImageFull(img.dataUrl,img)};div.appendChild(el)});
      if(msgId)_chatAppendMessageActions({id:msgId,role:role,friendId:activeFriendId,senderName:senderName},div,full);
    }else{
        if(senderName&&role==='ai'&&!_isCont){
        var _acm=_mdMode();if(_acm==='full'||_acm==='partial')div.classList.add('md-rendered');
        const label=document.createElement('span');
        label.style.cssText='font-size:var(--fs-meta);opacity:0.7;display:block;margin-bottom:2px';
        label.textContent=senderName;
        div.appendChild(label);
        /* P23 2D：小窗同样按 Phase 1 的唯一判定画语音气泡（历史/实时一致）。 */
        var _av3=_ibAiVoicePayload({role:'assistant',content:text,voice:voice||null});
        if(_av3)_renderAiVoice(_panelMdHost(div),{voice:_av3});else _renderSegments(_panelMdHost(div),text,wsResults);
        }else if(senderName&&role==='ai'&&_isCont){
          var _acmCont=_mdMode();if(_acmCont==='full'||_acmCont==='partial')div.classList.add('md-rendered');
          const ct=document.createElement('div');ct.className='chat-msg-cont-time align-left';ct.textContent=timeStr;container.appendChild(ct);
          var _avCont=_ibAiVoicePayload({role:'assistant',content:text,voice:voice||null});
          if(_avCont)_renderAiVoice(div,{voice:_avCont});else _renderSegments(_panelMdHost(div),text,wsResults);
        }else if(!isUser){
        var _acm2=_mdMode();if(_acm2==='full'||_acm2==='partial')div.classList.add('md-rendered');
        var _av4=_ibAiVoicePayload({role:'assistant',content:text,voice:voice||null});
        if(_av4)_renderAiVoice(_panelMdHost(div),{voice:_av4});else _renderSegments(_panelMdHost(div),text,wsResults);
      }else if(voice){
        if(text)div.appendChild(document.createTextNode(text));
        div.appendChild(_buildVoiceEl(voice));
      }else{
        div.textContent=text;
      }
      fls.forEach(function(f){div.appendChild(_buildFileCard(f))});
      imgs.forEach(img=>{const el=document.createElement('img');el.className='chat-bubble-img';el.loading='lazy';el.decoding='async';el.src=img.dataUrl;el.alt=img.name||'image';el.style.maxWidth='180px';el.onclick=function(){_viewImageFull(img.dataUrl,img)};div.appendChild(el)});
      if(msgId)_chatAppendMessageActions({id:msgId,role:role,friendId:activeFriendId,senderName:senderName},div,full);
    }
    if(messageRecord)_chatAppendReplyQuoteCard(messageRecord,quoteSources||[],div);
    container.appendChild(div);
    if(!isUser&&msgId&&window.IBExpressionPacks&&typeof window.IBExpressionPacks.decorateMessage==='function'){
      try{
        var _liveExpressionConfig=modelConfig||_messageApiConfig(messageRecord||{role:'assistant',friendId:activeFriendId,senderName:senderName});
        var _liveExpressionRole=String((_liveExpressionConfig&&_liveExpressionConfig.id)
          ||(messageRecord&&messageRecord.metadata&&(messageRecord.metadata.config_id||messageRecord.metadata.speakerId))||'');
        if(_liveExpressionRole)window.IBExpressionPacks.decorateMessage(_liveExpressionRole,String(msgId),div,{config:_liveExpressionConfig||undefined,text:String(text||'')});
      }catch(_liveExpressionError){}
    }
    container.scrollTop=container.scrollHeight;
  });
}

/* 收藏按钮（统一走 IB.favorites，引用式——只存 sourceId/文本/元信息，不复制二进制）。
   兼容传完整消息对象或长度消息 id；渲染时为尽快呈现先画空星，再异步回填状态。 */
/* 宿主 → 当前打开 App 的事件广播（幂等、fail-open、不复制 Chat Runtime）。
   仅投递 AI 完成的『message』（适合弹幕）与『turn start/end』状态；由打开中的 App（如 Cinema）自行过滤 friendId/threadId。 */
function _ibAppBroadcast(ev,payload){try{if(typeof window.IBApps==='object'&&IBApps&&typeof IBApps.broadcast==='function')IBApps.broadcast(ev,payload)}catch(e){}}

function _chatSetFavoriteButtonState(button,faved){
  if(!button)return;
  button.textContent=faved?'★':'☆';
  button.title=faved?'取消收藏此消息':'收藏此消息';
  button.setAttribute('aria-label',faved?'取消收藏此消息':'收藏此消息');
  button.setAttribute('aria-pressed',faved?'true':'false');
}
async function _toggleMsgFav(msg,b){
  var m=msg;
  try{
    if(typeof window.IB==='undefined'||!IB.favorites||typeof IB.favorites.has!=='function')throw new Error('FAVORITES_UNAVAILABLE');
    if(typeof m==='string'&&m)m=await dbGet('chatMessages',m);
    if(!m||!m.id)throw new Error('CHAT_MESSAGE_NOT_FOUND');
    var h=await IB.favorites.has(m.id);
    if(h){
      var removed=await IB.favorites.removeBySource('chat',m.id);
      if(!removed)throw new Error('CHAT_FAVORITE_REMOVE_FAILED');
      _chatSetFavoriteButtonState(b,false);
      toast('已取消收藏');
    }else{
      var meta={kind:(m.voice?'voice':(m.images&&m.images.length?'image':'text')),
        voice:m.voice?{duration:m.voice.duration,transcript:m.voice.transcript||''}:null,
        imgN:(m.images&&m.images.length)||0,threadId:m.threadId||'',threadName:'',
        who:m.role==='user'?'我':(m.senderName||'TA')};
      var rec=await IB.favorites.add({type:'chat',roleId:m.friendId||'',sourceId:m.id,title:'',body:String(m.content||'').slice(0,6000),meta:meta});
      if(!rec)throw new Error('CHAT_FAVORITE_WRITE_FAILED');
      _chatSetFavoriteButtonState(b,true);
      toast('已收藏');
    }
  }catch(error){
    var model=window.IBERR?window.IBERR.report(error,{friendId:m&&m.friendId||activeFriendId,stage:'chat_favorite'}).model:null;
    if(model){
      model.title='无法更新收藏';
      model.message='这条消息的收藏状态没有更改。';
      model.suggestion='检查收藏数据后，可以再次使用“收藏”操作。';
    }
    var host=b&&b.closest?b.closest('#chat-full-messages, #chat-messages'):null;
    if(!host)host=document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages');
    if(host)_chatAppendErrorDisclosure(host,model,{scope:'favorite',stage:'chat_favorite',errorFor:m&&m.id||''});
    else if(model&&window.IBERR&&window.IBERR.show)window.IBERR.show(model,{stage:'chat_favorite'});
  }
}
function _msgFavBtn(msg){
  var b=document.createElement('button');b.type='button';b.className='btn chat-msg-fav';b.dataset.variant='text';
  _chatSetFavoriteButtonState(b,false);
  function setState(v){_chatSetFavoriteButtonState(b,v)}
  var m=msg;
  // 异步回填收藏态（失败静默，保持空星）
  (function(){if(typeof window.IB==='undefined'||!IB.favorites)return;
    if(m&&typeof m==='object'&&m.id){IB.favorites.has(m.id).then(setState,function(){});return}
    if(typeof m==='string'&&m){dbGet('chatMessages',m).then(function(r){if(r)return IB.favorites.has(r.id)}).then(setState,function(){})}
  })();
  b.onclick=function(ev){ev.stopPropagation();_toggleMsgFav(msg,b)};
  return b;
}

var _chatActionPopoverSequence=0;
function _chatAppendMessageActions(message,bubble,isFullscreen){
  if(!message||!message.id||!bubble||bubble.querySelector('.chat-msg-actions'))return null;
  var host=bubble.closest?bubble.closest('#chat-full-messages, #chat-messages'):null;
  var archived=!!((host&&host.classList.contains('chat-arch-ro'))||(isFullscreen&&typeof _chatArchMode!=='undefined'&&_chatArchMode));
  var actions=document.createElement('div');
  actions.className='ib-primitives chat-msg-actions';
  actions.appendChild(_msgFavBtn(message));
  if(!archived){
    var sequence=++_chatActionPopoverSequence;
    var panelId='chat-message-actions-'+sequence;
    var trigger=document.createElement('button');
    trigger.type='button';
    trigger.id=panelId+'-trigger';
    trigger.className='btn chat-msg-more';
    trigger.dataset.variant='text';
    trigger.textContent='⋯';
    trigger.setAttribute('aria-label','更多消息操作');
    trigger.setAttribute('aria-controls',panelId);
    trigger.setAttribute('aria-expanded','false');
    trigger.setAttribute('popovertarget',panelId);
    actions.appendChild(trigger);
    var panel=document.createElement('div');
    panel.id=panelId;
    panel.className='ib-overlay-popover chat-msg-actions-popover';
    panel.setAttribute('popover','auto');
    panel.setAttribute('data-ib-popover','');
    panel.setAttribute('aria-labelledby',trigger.id);
    panel.addEventListener('beforetoggle',function(event){trigger.setAttribute('aria-expanded',event.newState==='open'?'true':'false')});
    panel.addEventListener('toggle',function(){trigger.setAttribute('aria-expanded',panel.matches(':popover-open')?'true':'false')});
    var remove=document.createElement('button');
    remove.type='button';
    remove.className='btn chat-msg-action-delete';
    remove.dataset.variant='destructive';
    remove.dataset.action='delete';
    remove.textContent='删除消息';
    remove.setAttribute('aria-label','删除这条消息');
    remove.addEventListener('click',function(event){
      event.stopPropagation();
      if(typeof panel.hidePopover==='function')panel.hidePopover();
      trigger.focus({preventScroll:true});
      deleteSingleMsg(message.id,bubble);
    });
    panel.appendChild(remove);
    trigger.addEventListener('keydown',function(event){
      if(event.key!=='Enter'&&event.key!==' ')return;
      event.preventDefault();
      if(panel.matches(':popover-open'))return;
      try{panel.showPopover();trigger.setAttribute('aria-expanded','true')}catch(e){}
    });
    actions.appendChild(panel);
  }
  bubble.appendChild(actions);
  if(!archived&&window.IBOverlayLifecycle&&typeof window.IBOverlayLifecycle.install==='function')window.IBOverlayLifecycle.install(actions);
  return actions;
}

async function deleteSingleMsg(id,bubble,frag){
  var host=bubble&&bubble.closest?bubble.closest('#chat-full-messages, #chat-messages'):null;
  var focusWasInBubble=!!(bubble&&document.activeElement&&bubble.contains(document.activeElement));
  try{await dbDelete('chatMessages',id)}catch(e){
    var model=window.IBERR?window.IBERR.report(e,{friendId:activeFriendId,stage:'chat_delete'}).model:null;
    if(model){model.title='无法删除这条消息';model.message='消息仍保留在对话中。';model.suggestion='检查存储是否可用后，可以再次选择删除。'}
    if(host)_chatAppendErrorDisclosure(host,model,{scope:'delete',stage:'chat_delete',errorFor:id});
    else if(model&&window.IBERR&&window.IBERR.show)window.IBERR.show(model,{stage:'chat_delete'});
    return;
  }
  _vmStopForMsgIds([id]);/* 删除的是正在播放的语音消息时同步停止播放 */
  /* Remove the bubble and its thinking block / avatar header if present */
  if(bubble){
    /* 头像行 / 续发时间 / 思考链以任意组合出现在气泡上方（原序：思考链 */
    let prev=bubble.previousElementSibling;
    while(prev&&(prev.classList.contains('chat-msg-header')||prev.classList.contains('chat-msg-cont-time')||prev.classList.contains('chat-thinking-wrap'))){
      const gone=prev;prev=prev.previousElementSibling;gone.remove();
    }
    bubble.remove();
  }
  _chatRefreshReplyQuotesForTarget(id);
  /* Also remove from the other panel if visible */
  if(focusWasInBubble&&host){
    if(!host.hasAttribute('tabindex'))host.setAttribute('tabindex','-1');
    host.focus({preventScroll:true});
  }
  updateChatCount();updateChatStorageInfo();
}
function autoResizeInput(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,100)+'px'}

/* _parseThinking: 思考链解析 v2 —— 只认"回复开头 */
function _parseThinking(raw){
  var thinking='', reply=raw||'';
  /* Case 3: 开头孤立的闭合标签 */
  var lead=reply.match(/^\s*<\/think(?:ing)?>\s*/i);
  if(lead){
    reply=reply.slice(lead[0].length);
    /* 旧中转偶尔会丢失 opening tag，却保留“思考正文 + closing tag + 最终回复”。 */
    var orphanClose=reply.match(/<\/think(?:ing)?>/i);
    if(orphanClose&&reply.slice(orphanClose.index+orphanClose[0].length).trim()){
      thinking=reply.slice(0,orphanClose.index).replace(/^\s*(?:思考|thinking)\s*[:：]\s*/i,'').trim();
      reply=reply.slice(orphanClose.index+orphanClose[0].length);
    }
  }
  var openMatch=reply.match(/^\s*<think(?:ing)?>/i);
  if(openMatch){
    var rest=reply.slice(openMatch[0].length);
    var closeMatch=rest.match(/<\/think(?:ing)?>/i);
    if(closeMatch){
      thinking=rest.slice(0,closeMatch.index).trim();
      reply=rest.slice(closeMatch.index+closeMatch[0].length);
    }else{
      /* 没有闭合标签：用「第一处空行」作为思考/正文的分界 */
      var splitIdx=rest.search(/\n\s*\n/);
      if(splitIdx>0){
        thinking=rest.slice(0,splitIdx).trim();
        reply=rest.slice(splitIdx);
      }else{
        /* 既无闭合标签也无空行，没有可靠分界——保留为正文，至少让用户看到回复（空气泡更糟）。 */
        reply=rest;
      }
    }
  }
  return {thinking:thinking,reply:reply.trim()};
}

/* API 原生 reasoning_content / thinking block 是主通道；文本标签解析只兼容旧模型或中转。 */
function _assistantResponseParts(content,nativeReasoning){
  var text=content==null?'':String(content);
  /* 原生字段原样保留；只有 content 内旧式标签才进入下面的兼容解析。 */
  var reasoning=nativeReasoning==null?'':String(nativeReasoning);
  var legacy=_parseThinking(text);
  if(legacy.thinking){
    var fallback=_cleanThinkingText(legacy.thinking);
    if(!reasoning)reasoning=fallback;
    else if(fallback&&reasoning.indexOf(fallback)===-1)reasoning+='\n\n'+fallback;
    text=legacy.reply;
  }else{
    text=legacy.reply;
  }
  return {content:text,reasoning_content:reasoning};
}

/* Anthropic 联网搜索 + 思考链泄漏修复：只处理响应文本，不改请求体、搜索工具或缓存断点。 */
function _anthropicWebThinkResponseMode(cfg,opts,wantThink){
  try{return !!(wantThink&&cfg&&cfg.provider==='anthropic'&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!(opts&&opts._noWebSearch)&&!IBWS.blocked(cfg))}catch(e){return false}
}
function _mergeAnthropicWebThink(a,b){
  a=String(a||'').trim();b=String(b||'').trim();
  if(!a)return b;if(!b)return a;if(a.indexOf(b)!==-1)return a;if(b.indexOf(a)!==-1)return b;
  return a+'\n\n'+b;
}
/* 中转站可能把 <thinking> 拆跨多个 SSE chunk，且在标签前先吐搜索过程。
   首个标签未确认前暂存；确认后把标签前缀与标签内容归入思考区。无闭合标签时回退为正文，避免空气泡。 */
function _makeAnthropicWebThinkMux(onText,onThink){
  var buf='',reply='',thinking='',phase='pre',prefix='',done=false,last=null;
  var OPEN=/<think(?:ing)?\b[^>]*>/i,CLOSE=/<\/think(?:ing)?\s*>/i;
  function text(v){if(!v)return;reply+=v;if(typeof onText==='function')onText(v)}
  function think(v){if(!v)return;thinking+=v;if(typeof onThink==='function')onThink(v)}
  function scan(){
    for(;;){
      if(phase==='pre'){
        var op=buf.match(OPEN);if(!op)return;
        prefix+=buf.slice(0,op.index);buf=buf.slice(op.index+op[0].length);phase='think';continue;
      }
      if(phase==='think'){
        var cl=buf.match(CLOSE);if(!cl)return;
        think(prefix+buf.slice(0,cl.index));prefix='';buf=buf.slice(cl.index+cl[0].length);phase='text';continue;
      }
      var op2=buf.match(OPEN);if(!op2){text(buf);buf='';return}
      text(buf.slice(0,op2.index));buf=buf.slice(op2.index+op2[0].length);phase='think';continue;
    }
  }
  return{
    push(v){if(done||v==null)return;buf+=String(v);scan()},
    releaseAsText(){if(done)return;text(prefix+buf);prefix='';buf='';phase='text'},
    finish(){
      if(done)return last;
      if(phase==='pre')text(buf);
      else if(phase==='think')text(prefix+buf);/* 标签不完整/未闭合：宁可显示，也不吞正文 */
      else text(buf);
      prefix='';buf='';done=true;last={text:reply,thinking:thinking};return last
    }
  }
}

/* Side-channel for native model reasoning. Never concatenate this into visible content. */
var _lastApiReasoning='';

/* 思考链格式已融入 system prompt，不再追加 THINK_R */

/* 多模态内容格式转换：内部格式 → API 特定格式 */
/* ── 缓存友好历史窗口 ──
   旧实现 slice(-keepCount) 每来一条新消息、窗口起点就 +1，请求前缀从第一条历史起全部变化，
   prompt caching 永远无法命中。改为"阶梯推进"：起点只停在 step 的整数倍位置，
   连续 step 条消息内前缀完全一致（可命中缓存），越过边界才整体前移一次（重建一次缓存）。
   代价是窗口长度在 keepCount ~ keepCount+step-1 之间浮动，多出的部分按 0.1 倍缓存读取价计费。
   2026-07 复核：step 上限维持 24（与下方 Math.min(24,…) 一致）。前缀缓存是"从请求首字节起逐字匹配"，
   窗口起点一前移，消息层无论打几个断点都必然全部失配（只有 system 段存活），所以重建无法靠断点消除，
   只能降低频率：100 条窗口下每 24 条消息重建一次(≈12轮)，单次重建成本不变；
   代价是窗口浮动上限 +23 条，多出部分按 0.1x 读取价计费。
   若把上限调到 50，可把重建频率减半(≈25轮一次)，代价是浮动上限升到 +49 条、常驻多算约 +$0.003/轮；
   权衡后取 24。改动时注释与 Math.min 内的数值须同步。 */
function _cacheStableSlice(list,keepCount){
  keepCount=Math.max(1,keepCount|0);
  const total=(list&&list.length)||0;
  if(total<=keepCount)return (list||[]).slice();
  const step=Math.max(6,Math.min(24,Math.ceil(keepCount/2)));
  const start=Math.floor((total-keepCount)/step)*step;
  return list.slice(start);
}
/* 1小时长效缓存（Anthropic extended-cache-ttl beta）：按配置生成 cache_control 与请求头 */
function _ccObj(cfg){return (cfg&&cfg.cacheTtl1h&&cfg.promptCache!==false)?{type:'ephemeral',ttl:'1h'}:{type:'ephemeral'}}
function _ccBeta(hdrs,cfg){if(hdrs&&cfg&&cfg.cacheTtl1h&&cfg.promptCache!==false)hdrs['anthropic-beta']='extended-cache-ttl-2025-04-11';return hdrs}
/* ── 统一前缀缓存审计（[IB Cache Audit]，console-only，零行为改变）──
   背景：provider 的自动前缀缓存要求"请求开头与已缓存请求逐字一致"才产生命中。
   此探针在每次请求发出前，比较"最终发送 payload"（openai / anthropic / gemini 三形态）与上一轮快照：
   · 计算稳定前缀长度与首个分歧字符位置；
   · 分别判定 System / History / Tools / Request structure 是否逐字一致；
   · 仅输出【截断 + 脱敏】的变更片段，绝不将完整 prompt 打到生产日志（避免泄露角色 Memory / 用户对话）。
   仅在提示缓存开关 (cfg.promptCache!==false) 开启时运行；不修改任何请求内容，随时可整段删除。 */
var _ibCacheAuditPrev={};
/* 稳定段的规范化文本：供逐段 SAME/CHANGED 判定 */
function _cacheSegText(c){
  if(typeof c==='string')return c;
  if(Array.isArray(c))return c.map(function(p){if(p&&p.type==='image')return'[img]';if(p&&p.type==='image_url')return'[img]';if(p&&p.type==='_image')return'[img]';if(p&&p.type==='_audio')return'[audio]';if(p&&p.type==='input_audio')return'[audio]';return(p&&p.text)||''}).join('');
  return String(c||'');
}
function _cacheSeg(role,c){return '\u00b6'+(role||'')+'\u00a7'+_cacheSegText(c)}
/* 粗 token 估算：**唯一实现已迁到 assets/js/context-budget-core.js**
   （P11-3X-C：全仓只允许存在一份估算算法本体）。这里保留同名薄壳，因为
   [IB Cache Audit] 的日志字符串一直在用它，改调用点没有收益、只会扩大差异面。
   口径不变：CJK≈1 token/字，其余≈0.33；仅用于提示量级，不精确计费。
   核心不可用时**不在此处复制一份算法**（那正是本阶段要消除的第二套实现）：
   退化成纯字符计数即可。生产里不可达 —— HTML 中 context-budget-core.js
   排在 communication.js 之前。 */
function _cacheTok(s){var _c=_ibBudgetCore();if(_c&&typeof _c.estimateTokens==='function')return _c.estimateTokens(s);return String(s==null?'':s).length}
/* 截断 + 脱敏：只展示变更片段附近，隐藏完整 Memory / 用户对话 */
function _cacheRedact(s){return String(s).replace(/[\r\n]+/g,'⏎').replace(/[ \t]{2,}/g,' ')}
/* ── 审计快照的请求身份（baseline key）──
   只放"决定两个请求能否被当作同一 cache-prefix 连续请求来比较"的字段：
   · consumer —— 必须来自真实执行上下文（callApiChat* 的 opts._ibConsumer ← runtime request.consumer）。
     缺失时留空，绝不按当前页面（#chat/#diary）、system prompt 文本或调用栈字符串猜测；
     空 consumer 自成一档，永远不会污染任何具名 consumer 的基线。
   · character —— 不同角色的 system/history 本来就不同，互相比较没有意义。
   · provider / model / format —— 决定 cache 池归属与 wire 形态，换模型/换协议必然换缓存。
   刻意不入 key：requestId、timestamp、正文长度等每轮变化字段（入了就永远形成不了基线），
   以及 endpoint（用户显式改配置属于配置变更，与"同一请求流前缀是否稳定"无关，过度隔离只会让基线频繁丢失）。 */
function _ibCacheAuditKey(consumer,cfg,fmt,idModel){
  return String(consumer||'')+'::'+String((cfg&&cfg.id)||'')+'::'+String((cfg&&cfg.provider)||'')+'::'+String(idModel||'')+'::'+fmt;
}
function _ibCacheAuditLabel(consumer,cfg,fmt,idModel){
  return 'Consumer: '+(String(consumer||'')||'(unspecified)')
    +' | Character: '+(String((cfg&&cfg.id)||'')||'-')
    +' | Provider: '+(String((cfg&&cfg.provider)||'')||'-')
    +' | Model: '+(String(idModel||'')||'-')
    +' | Format: '+fmt;
}
function _ibCacheAudit(cfg,body,fmt,meta){
  try{
    if(!body||!cfg)return;
    fmt=fmt==='gemini'?'gemini':(fmt==='anthropic'?'anthropic':'openai');
    var consumer=String((meta&&meta.consumer)||'');
    var model='',system='',hist='',tools='',struct='';
    if(fmt==='anthropic'){
      model=body.model||'';
      var sa=body.system;
      system=(Array.isArray(sa)?((sa[0]&&sa[0].text)||''):(typeof sa==='string'?sa:''));
      hist=(body.messages||[]).map(function(m){return _cacheSeg(m&&m.role,m&&m.content)}).join('\n');
      tools=(body.tools?JSON.stringify(body.tools):'');
      struct=JSON.stringify({mtxt:body.max_tokens,t:body.temperature,use:body.tool_choice?1:0,qz:body.top_k?1:0});
    }else if(fmt==='gemini'){
      model=body.model||'';
      var sg=body.system_instruction;
      system=(sg&&sg.parts&&sg.parts[0]&&sg.parts[0].text)||'';
      hist=(body.contents||[]).map(function(m){return _cacheSeg(m&&m.role,m&&m.parts)}).join('\n');
      tools='';/* Gemini 工具经 tools 字段，本调用链不注入，恒为空（不参与判定） */
      struct=JSON.stringify({mtxt:body.generationConfig&&body.generationConfig.maxOutputTokens,t:body.generationConfig&&body.generationConfig.temperature,qz:body.generationConfig&&body.generationConfig.responseMimeType});
    }else{
      model=body.model||'';
      var msgs=body.messages||[],seg=[];
      for(var i=0;i<msgs.length;i++){
        if(i===0&&msgs[i]&&msgs[i].role==='system'){system=_cacheSegText(msgs[i].content);}
        else{seg.push(_cacheSeg(msgs[i]&&msgs[i].role,msgs[i]&&msgs[i].content));}
      }
      hist=seg.join('\n');
      tools=(body.tools?JSON.stringify(body.tools):'');
      struct=JSON.stringify({mtxt:body.max_tokens!=null?body.max_tokens:(body.max_completion_tokens!=null?body.max_completion_tokens:null),t:body.temperature!=null?body.temperature:null,rf:body.response_format?JSON.stringify(body.response_format):null,pc:(typeof body.prompt_cache_key==='string'?body.prompt_cache_key:null),so:body.stream_options?1:0,ta:body.tool_choice?1:0});
    }
    /* 真实发送字节（与 provider 视角一致的 token 前缀用于计算稳定前缀/首分歧） */
    var bodyStr=JSON.stringify(body);
    /* 实际发出的 model 优先（gemini 的 model 在 URL 上、body 里没有 → 回落 cfg.model） */
    var idModel=String(model||'')||String((cfg&&cfg.model)||'');
    var key=_ibCacheAuditKey(consumer,cfg,fmt,idModel);/* 同一请求流（consumer+角色+provider+model+格式）内比较 */
    var label=_ibCacheAuditLabel(consumer,cfg,fmt,idModel);
    var prev=_ibCacheAuditPrev[key];
    _ibCacheAuditPrev[key]={bs:bodyStr,model:model,system:system,hist:hist,tools:tools,struct:struct};
    if(!prev){console.info('[IB Cache Audit] '+label+' | Prompt text: '+_cacheTok(system+hist)+' chars-est | 已记录本请求流基线。从同一 Consumer 的下一轮请求开始输出前缀稳定性对比。');return}
    /* 各段 SAME/CHANGED：仅 History 允许"末尾追加"不视为破坏（新 user 消息追加在数组尾）；
       System / Tools / Request structure 任何变化都视为破坏（system 位于 token 流前端、tools/结构决定请求形状）。 */
    function eff(p,c){if(p===c)return false;if(typeof p==='string'&&typeof c==='string'&&c.indexOf(p)===0)return false;return true}
    var hisC=eff(prev.hist,hist);
    var sysC=(system!==prev.system);
    var toolC=(tools!==prev.tools);
    var structC=(struct!==prev.struct);
    /* 真实请求字节的公共前缀长度 = 稳定前缀；它是首个分歧位置 */
    var n=Math.min(prev.bs.length,bodyStr.length),d=0;
    while(d<n&&prev.bs.charCodeAt(d)===bodyStr.charCodeAt(d))d++;
    var stable=d;/* 稳定前缀（真实请求字节） */
    /* 无任何段被破坏 → 前缀稳定（纯追加或完全一致） */
    if(!sysC&&!hisC&&!toolC&&!structC){
      console.info('[IB Cache Audit] '+label
        +' | Prompt chars: '+_cacheTok(system+hist)+' (~'+_cacheTok(system+hist)+' tok)'
        +' | Stable prefix: '+stable+' request-bytes (~'+_cacheTok(bodyStr.slice(0,stable))+' tok est)'
        +' | First difference: (纯追加/无，无)'
        +' | System: SAME | History: SAME | Tools: SAME | Request structure: SAME'
        +' —— 前缀逐字稳定，本轮仅为消息尾部追加或完全一致。若命中仍为 0，判定见"C"「provider 未启用/未回传缓存字段」。');
      return;
    }
    /* 有段被破坏 → 定位首个分歧所在段并输出截断+脱敏片段 */
    var sec=sysC?'SYS':(hisC?'HIS':(toolC?'TOOLS':'STRUCT'));
    var pd=(sec==='SYS'?prev.system:(sec==='HIS'?prev.hist:(sec==='TOOLS'?prev.tools:prev.struct)));
    var ct=(sec==='SYS'?system:(sec==='HIS'?hist:(sec==='TOOLS'?tools:struct)));
    var k=0,mn=Math.min(pd.length,ct.length);while(k<mn&&pd.charCodeAt(k)===ct.charCodeAt(k))k++;
    var a=_cacheRedact(pd.slice(Math.max(0,k-140),k+180));
    var b=_cacheRedact(ct.slice(Math.max(0,k-140),k+180));
    console.warn('[IB Cache Audit] '+label
      +' | Prompt chars: '+_cacheTok(system+hist)+' (~'+_cacheTok(system+hist)+' tok)'
      +' | Stable prefix: '+stable+' request-bytes (~'+_cacheTok(bodyStr.slice(0,stable))+' tok est)'
      +' | First difference: request-byte '+stable
      +' | System: '+(sysC?'CHANGED':'SAME')
      +' | History: '+(hisC?'CHANGED':'SAME')
      +' | Tools: '+(toolC?'CHANGED':'SAME')
      +' | Request structure: '+(structC?'CHANGED':'SAME')
      +' | 分歧段: '+sec);
    console.warn('[IB Cache Audit] Consumer: '+(consumer||'(unspecified)')+' | Changed section (截断+脱敏) 定位首次分歧:\n【上一轮】…'+a+'…\n【本　轮】…'+b+'…');
  }catch(e){}
}
/* 向后兼容别名：旧签名 (cfg, messages) 仍可用，等价于仅 messages 的 OpenAI 审计；meta 可选（同 _ibCacheAudit） */
function _ibOaiCacheDiag(cfg,msgs,meta){
  try{_ibCacheAudit(cfg,{model:(cfg&&cfg.model)||'',messages:msgs||[]},'openai',meta)}catch(e){}
}
/* ── Anthropic 消息级缓存断点注入 ──
   在 chatMsgs 数组的倒数第二条消息（新 user 消息之前的最后一条历史消息）上
   添加 cache_control，让整个对话历史前缀都能被 Anthropic prompt caching 命中。
   Anthropic 最多支持 4 个断点：system(1) + messages(至多3)。
   这里在「倒数第 2 条」加 1 个断点：保证下一轮请求时，
   system + 已有历史 全部走缓存读取，只有最新的 user 消息是新增输入。
   如果消息数 ≤ 1（没有历史，只有当前 user 消息），不加断点。 */
function _injectAnthropicMsgCache(chatMsgs,cfg){
  if(!chatMsgs||chatMsgs.length<=1)return;/* 只有1条=当前消息，没有可缓存的历史 */
  if(cfg&&cfg.promptCache===false)return;
  if(cfg&&cfg.provider&&cfg.provider!=='anthropic')return;
  /* 先清扫历史块上的残留 cache_control（copy-on-write，绝不改动调用方持有的原始块对象），
     保证每次请求恰好 system(1) + message(1) 两个断点。
     旧实现直接在块对象上原地写 cache_control，有两个隐患：
     ① 原生 FC 多轮时 _fc 消息的 content 数组跨轮共享同一批块对象，断点逐轮累积，
        超过 Anthropic 的 4 断点上限即整请求 400；
     ② 1小时TTL开关切换后，残留块仍带旧 ttl:'1h'，而请求头已不再带 extended-cache-ttl beta，
        同样会被 API 拒绝。 */
  for(let i=0;i<chatMsgs.length;i++){
    const mm=chatMsgs[i];
    if(mm&&Array.isArray(mm.content)&&mm.content.some(b=>b&&b.cache_control)){
      mm.content=mm.content.map(b=>{if(b&&b.cache_control){const c=Object.assign({},b);delete c.cache_control;return c}return b});
    }
  }
  /* 倒数第 2 条（即新 user 消息前的最后一条历史消息） */
  const idx=chatMsgs.length-2;
  const msg=chatMsgs[idx];
  if(!msg)return;
  /* 如果 content 已经是数组(multimodal/FC)，把断点写在"最后一个块的副本"上 */
  if(Array.isArray(msg.content)){
    if(msg.content.length>0){
      const arr=msg.content.slice();
      arr[arr.length-1]=Object.assign({},arr[arr.length-1],{cache_control:_ccObj(cfg)});
      msg.content=arr;
    }
  }else{
    /* 纯文本 → 转成 content block 数组以承载 cache_control */
    msg.content=[{type:'text',text:String(msg.content||''),cache_control:_ccObj(cfg)}];
  }
}

function _adaptContentForApi(content,fmt,allowImages){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return String(content||'');
  /* DeepSeek 文本模型只接收本地视觉描述，不接收 image blocks。
     deepseek-v4-flash-vision-exp 例外：调用方会传入 allowImages=true，
     由这里转换为 OpenAI image_url 后随消息直发。
     此边界过滤用于防止历史图片与 function-call/tool 消息重新引入 image_url。 */
  if(allowImages===false)return content.filter(p=>p&&p.type==='text').map(p=>p.text||'').join('');
  if(fmt==='anthropic')return content.map(p=>{
    if(p.type==='_image')return{type:'image',source:{type:'base64',media_type:p.mime,data:p.base64}};
    if(p.type==='_audio')return{type:'text',text:'[语音消息原声：当前渠道不支持音频输入，请参考文字稿]'};/* 防御分支：直发判定已排除 Anthropic，正常不会走到 */
    return{type:'text',text:p.text||''}
  });
  if(fmt==='openai')return content.map(p=>{
    if(p.type==='_image'){var _ib64=String(p.base64||'').replace(/\s+/g,'').replace(/^(?:data:[^,]*;base64,)+/i,''),_imime=/^image\//i.test(String(p.mime||''))?p.mime:'image/jpeg';return{type:'image_url',image_url:{url:'data:'+_imime+';base64,'+_ib64}}}
    if(p.type==='_audio')return{type:'input_audio',input_audio:{data:p.base64,format:p.format||'wav'}};
    return{type:'text',text:p.text||''}
  });
  return content.filter(p=>p.type==='text').map(p=>p.text||'').join('')
}
function _adaptMessageForApi(message,fmt,allowImages){
  message=message||{};
  const adapted={role:message.role,content:_adaptContentForApi(message.content,fmt,allowImages)};
  /* Preserve only protocol fields required by native function-calling rounds. */
  if(message.tool_calls!==undefined)adapted.tool_calls=message.tool_calls;
  if(message.tool_call_id!==undefined)adapted.tool_call_id=message.tool_call_id;
  if(message.name!==undefined)adapted.name=message.name;
  return adapted
}

/* ── 流式传输 (SSE Streaming) ── */
let _streamAbortController=null;/* 兜底句柄；常规路径已改走按对话隔离的 _chatCallStates */
/* ── 语音通话流式句柄：模型 stream 的干净正文（已过滤 thinking）经 _sFlush 推给本 sink。
   非语音聊天时保持 null，完全惰性，不改变原流式行为。── */
var _voiceSink=null;
function _makeVoiceSentenceSink(call){
  var buf='';
  return {
    active:true,
    feed:function(ch){
      if(!this.active)return;
      buf+=ch;
      /* Strip complete XML-ish markup (tool/calendar/memory/withdraw tags). A tag
         split across chunks is removed as soon as its closing '>' arrives, so a
         reply with an unfinished instruction never reads it aloud. */
      buf=buf.replace(/<[^>]*>/g,'');
      for(;;){
        var m=/^[^。！？!?；;]*[。！？!?；;]/.exec(buf);
        if(!m)break;
        var s=m[0].trim();
        buf=buf.slice(m[0].length);
        if(s)call.pushSentence(s,false);
      }
    },
    flush:function(done){
      if(!this.active)return;
      this.active=false;
      buf=buf.replace(/<[^>]*>/g,'');
      var rest=buf.trim();buf='';
      if(rest)call.pushSentence(rest,done!==false);
      else call.pushSentence('',done!==false);
    }
  };
}
var _lastApiFinish='';/* 结束原因镜像（length/max_tokens/MAX_TOKENS = 被输出上限截断）。真实判定改用各调用自己的状态对象 */
/* ── 跨对话并发隔离 ──
   发送锁按好友分开，但"最近一次思考内容 / 结束原因 / 停止标记 / 可停止的传输"此前共用全局变量，
   两路对话同时进行时会互相串扰（停止只停最新一路、思考文本挂错对话、截断标记与自动续写误判）。
   现改为：每次聊天调用创建独立状态对象，按对话 ID 注册，停止按钮按当前查看的对话定位。 */
var _chatCallStates={};/* key = 好友/群 ID → {think,finish,stopped,ac} */
function _newCallState(opts){var st={key:(opts&&opts.chatKey)||'',think:'',finish:'',stopped:false,ac:null,abortReason:''};if(st.key)_chatCallStates[st.key]=st;return st}
function _endCallState(st){if(st&&st.key&&_chatCallStates[st.key]===st)delete _chatCallStates[st.key]}
function _mSetThink(opts,v){_lastApiReasoning=v;if(opts&&opts._st)opts._st.think=v}
function _mSetFinish(opts,v){_lastApiFinish=v;if(opts&&opts._st)opts._st.finish=v}
function _finishIsTrunc(f){return f==='length'||f==='max_tokens'||f==='MAX_TOKENS'}
function stopStreaming(){
  /* P23 Phase 2B：停止按钮同时取消本会话**仍在投递**的剩余 unit（已交付的保留）。
     生成与交付是同一段用户体验，因此两者共用同一个停止入口 —— 不新增第二个 stop。 */
  try{_ibDeliveryAbort(activeFriendId,activeThreadId,'user_stop')}catch(e){}
  /* P24-M3.3.1 · GroupTurn cancel signal（runtime-only，仅翻标记）：
     ① 未来**尚未启动**的 entry 由群聊循环在下一个 entry 边界检查并停止；
     ② 当前正在流式的成员仍由下面的 st.ac.abort() 中止（同一个 stop 入口，**没有第二套 abort**）；
     ③ 非流式成员当前无法中止（known limitation，见 docs）。 */
  try{_ibGroupTurnCancel(activeFriendId,'user_stop')}catch(e){}
  /* 优先停当前查看的对话；当前对话没有进行中的传输而全局只剩一路时，停那一路 */
  var st=_chatCallStates[activeFriendId];
  if(!st){var ks=Object.keys(_chatCallStates);if(ks.length===1)st=_chatCallStates[ks[0]]}
  if(st){
    st.stopped=true;st.abortReason='user_stop';
    if(st.ac){
      if(String(activeFriendId||'')===String(st.key||''))_chatSetActiveStreamActivity(st.key,activeThreadId,'stopping');
      try{st.ac.abort()}catch(e){}st.ac=null;
    }
    return;
  }
  if(_streamAbortController){_streamAbortController.abort();_streamAbortController=null}
}
let _memStreamAbortController=null;
let _memStreamWasStopped=false;
function stopMemoryStreaming(){_memStreamWasStopped=true;if(_memStreamAbortController){_memStreamAbortController.abort();_memStreamAbortController=null}}
function _showStreamingUI(show){
  if(!show&&_chatCallStates[activeFriendId]&&_chatCallStates[activeFriendId].ac)show=true;/* 并发隔离：当前查看的对话仍在流式传输时，另一路结束不收走停止按钮 */
  ['chat-stop-full','chat-stop-mini'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display=show?'':'none'});
  ['chat-send-full','chat-send-btn'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.display=show?'none':''});
}

/* D4.1-C presentation adapters: project existing owners into the current host; no state is stored here. */
function _chatSyncComposerBusy(){
  var fid=String(activeFriendId||'');
  var busy=!!(fid&&typeof _chatSendingFor!=='undefined'&&_chatSendingFor.has(fid));
  var full=currentPage==='chat';
  var area=document.querySelector(full?'#page-chat .chat-input-area':'#chat-panel .chat-input-area');
  var send=document.getElementById(full?'chat-send-full':'chat-send-btn');
  if(area){
    if(busy){area.setAttribute('aria-busy','true');area.dataset.activityState='sending'}
    else{area.removeAttribute('aria-busy');delete area.dataset.activityState}
  }
  if(send)send.disabled=busy;
  return busy;
}
function _chatSetComposerFeedback(panel,message){
  var full=panel==='full'||panel==='chat-full-input';
  var input=document.getElementById(full?'chat-full-input':'chat-input');
  var area=input&&input.closest?input.closest('.chat-input-area'):null;
  var feedback=full?document.getElementById('chat-composer-feedback'):(area&&area.querySelector('.chat-composer-feedback'));
  if(!feedback&&area&&!full){
    feedback=document.createElement('div');
    feedback.className='ib-primitives chat-composer-feedback';
    feedback.setAttribute('role','status');
    feedback.setAttribute('aria-live','polite');
    feedback.setAttribute('aria-atomic','true');
    area.appendChild(feedback);
  }
  if(!feedback)return false;
  var text=String(message||'').trim();
  feedback.textContent=text;
  feedback.hidden=!text;
  if(area){if(text)area.dataset.validationState='error';else delete area.dataset.validationState}
  return true;
}
function _chatAppendInlineStatus(container,text,status){
  if(!container)return null;
  var row=document.createElement('div');
  row.className='ib-primitives chat-msg system chat-status-event';
  row.dataset.status=String(status||'neutral');
  var inline=document.createElement('div');
  inline.className='ib-inline-status';
  inline.dataset.status=String(status||'neutral');
  inline.setAttribute('role','status');
  inline.setAttribute('aria-live','polite');
  inline.setAttribute('aria-atomic','true');
  var marker=document.createElement('span');
  marker.className='ib-inline-status__marker';marker.setAttribute('aria-hidden','true');
  var message=document.createElement('span');
  message.className='ib-inline-status__text';message.textContent=String(text||'');
  inline.appendChild(marker);inline.appendChild(message);row.appendChild(inline);container.appendChild(row);
  return row;
}
function _chatAppendErrorDisclosure(container,model,options){
  if(!container)return null;
  options=options||{};model=model&&typeof model==='object'?model:{};
  if(options.errorFor){
    container.querySelectorAll('.chat-message-error').forEach(function(existing){
      if(existing.dataset.errorScope===String(options.scope||'message')&&existing.dataset.errorFor===String(options.errorFor))existing.remove();
    });
  }
  var row=document.createElement('div');
  row.className='ib-primitives chat-message-error';
  row.dataset.errorScope=String(options.scope||'message');
  if(options.errorFor)row.dataset.errorFor=String(options.errorFor);
  row.setAttribute('role','alert');
  var title=document.createElement('strong');
  title.className='chat-message-error__title';
  title.textContent=String(model.title||options.title||'这次操作没有完成');
  row.appendChild(title);
  if(options.speakerName){
    var speaker=document.createElement('span');
    speaker.className='chat-message-error__speaker';speaker.textContent=String(options.speakerName);
    row.appendChild(speaker);
  }
  var message=document.createElement('p');
  message.className='chat-message-error__message';
  message.textContent=String(model.message||options.message||'当前操作没有完成。');
  row.appendChild(message);
  var suggestion=String(model.suggestion||options.suggestion||'');
  if(suggestion){var next=document.createElement('p');next.className='chat-message-error__suggestion';next.textContent=suggestion;row.appendChild(next)}
  var actions=document.createElement('div');actions.className='chat-message-error__actions';
  var action=model.action;
  if(action&&(action.type==='open_settings'||action.type==='open_page')&&typeof window.navTo==='function'){
    var recovery=document.createElement('button');recovery.type='button';recovery.className='btn btn-primary';
    recovery.textContent=String(action.label||'打开设置');
    recovery.addEventListener('click',function(){try{window.navTo(action.type==='open_page'?(action.target||'home'):(action.target||'api'))}catch(e){}});
    actions.appendChild(recovery);
  }
  if(typeof options.onRecover==='function'){
    var recover=document.createElement('button');recover.type='button';recover.className='btn btn-primary';
    recover.textContent=String(options.recoveryLabel||'重新读取');
    recover.addEventListener('click',function(){
      if(recover.disabled)return;
      recover.disabled=true;recover.setAttribute('aria-busy','true');
      Promise.resolve().then(function(){return options.onRecover()}).then(function(result){
        if(result===false&&recover.isConnected){recover.disabled=false;recover.removeAttribute('aria-busy')}
      },function(){if(recover.isConnected){recover.disabled=false;recover.removeAttribute('aria-busy')}});
    });
    actions.appendChild(recover);
  }
  if(model.code&&window.IBERR&&typeof window.IBERR.show==='function'){
    var details=document.createElement('button');details.type='button';details.className='btn';details.dataset.variant='text';
    details.textContent='查看技术详情';
    details.addEventListener('click',function(){window.IBERR.show(model,{stage:String(options.stage||'chat')})});
    actions.appendChild(details);
  }
  if(actions.childNodes.length)row.appendChild(actions);
  container.appendChild(row);
  if(options.roleId&&window.IBExpressionPacks&&typeof window.IBExpressionPacks.applyRoleState==='function'){
    try{window.IBExpressionPacks.applyRoleState(options.roleId,'errorExpression',row)}catch(e){}
  }
  return row;
}
function _chatPresentSendFailure(friendId,threadId,model,options){
  options=options||{};
  if(!options.roleId&&String(friendId||'').indexOf('group_')!==0)options.roleId=String(friendId||'');
  var active=_ibConvIsActive(friendId,threadId);
  var container=document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages');
  if(active)return _chatAppendErrorDisclosure(container,model,options);
  if(model&&window.IBERR&&typeof window.IBERR.show==='function')return window.IBERR.show(model,{stage:String(options.stage||'chat')});
  return null;
}
function _chatActivitySpeakerName(friendId,speakerId){
  var fid=String(friendId||''),sid=String(speakerId||'');
  var cfg=typeof apiConfigs!=='undefined'&&Array.isArray(apiConfigs)?apiConfigs.find(function(item){return item&&item.id===(sid||fid)}):null;
  var name=String(cfg&&cfg.nickname||'').trim();
  if(name)return name;
  return fid.indexOf('group_')===0?'群聊成员':'AI';
}
function _chatStreamActivityText(name,state){
  var copy={thinking:'正在思考…',streaming:'正在回复…',stopping:'正在停止…'};
  return copy[state]?(String(name||'AI')+' '+copy[state]):'';
}
function _chatStreamPrefixCanProjectReply(buffer){
  var prefix=String(buffer||'').replace(/^\s+/,'').toLowerCase();
  if(!prefix)return false;
  return !['<think>','<thinking>','</think>','</thinking>'].some(function(marker){return marker.indexOf(prefix)===0});
}
function _chatSetStreamActivityElement(el,state){
  if(!el||!el.isConnected)return false;
  if(!state){el.remove();return true}
  if(el.dataset.state===state)return false;
  el.dataset.state=state;
  el.textContent=_chatStreamActivityText(el.dataset.speakerName,state);
  return true;
}
function _chatSetStreamActivity(refs,state){
  (Array.isArray(refs)?refs:[]).forEach(function(ref){_chatSetStreamActivityElement(ref&&ref.activityEl,state)});
}
function _chatSetActiveStreamActivity(friendId,threadId,state){
  var box=document.getElementById(currentPage==='chat'?'chat-full-messages':'chat-messages');
  if(!box)return 0;
  var changed=0,fid=String(friendId||''),tid=String(threadId||'');
  box.querySelectorAll('.chat-stream-activity').forEach(function(el){
    if(el.dataset.friendId!==fid||String(el.dataset.threadId||'')!==tid)return;
    if(_chatSetStreamActivityElement(el,state))changed++;
  });
  return changed;
}

/* ══════════ 输出上限与自动续写 ══════════
   截断的根因是请求里写死的 max_tokens:4096。这里做三件事：
   ① 按 provider 给出更大的默认输出上限（DeepSeek V4 官方支持最高 384K 输出）；
   ② 若某服务商不接受高上限（400 报错提到 max_tokens），自动降回 4096 重试一次；
   ③ 即便如此仍被截断（finish_reason=length 等），自动带着已生成内容请求"无缝续写"，
      去除接缝处的重复后拼接，最多续 3 轮 —— 对用户表现为"没有长度限制"。 */
/* 各提供商单次输出上限：一律按主流旗舰模型的官方最大值顶格给（用户明确不在意 token 消耗）。
   若某个具体模型/中转支持不到这个数，请求会报错，下方包装器会读取错误里的建议值自动降档重试，
   所以这里可以放心写大——宁可"顶格再回退"，也不要"保守而浪费"。 */
const _PROVIDER_MAX_OUT={deepseek:65536,anthropic:64000,openai:32768,grok:32768,moonshot:32768,mimo:131072,mistral:32768,qwen:32768,glm:32768,doubao:32768,minimax:32768,yi:16384,baichuan:16384,gemini:65536,custom:32768};
function _chatMaxTokens(cfg){return _PROVIDER_MAX_OUT[cfg&&cfg.provider]||16384}
function _errLooksMaxTok(e){return /max_?tokens|max_completion_tokens|maxOutputTokens/i.test(String(e&&e.message||''))}
/* 新款 OpenAI 系模型（o1/o3/gpt-5 等）不认 max_tokens、要求 max_completion_tokens：
   典型报错同时提到两个参数名（"'max_tokens' is not supported… use 'max_completion_tokens'"）。
   识别到就换参数名原额重试，而不是傻傻降到 4096。 */
function _errWantsCompletionParam(e){var s=String(e&&e.message||'');return /max_completion_tokens/i.test(s)&&/max_tokens/i.test(s)&&/not\s+support|unsupported|instead|use\b|不支持|请使用|改用/i.test(s)}
/* ── 输出上限参数名记忆（仅存内存，刷新页面清零）──
   GPT-5 系等新款 OpenAI 模型只接受 max_completion_tokens，不接受 max_tokens。
   此前该情况按消息逐次探测：每条消息都先发一次带 max_tokens 的请求、收到 400 后才换参数名重试，
   控制台因此每条消息都出现失败请求。现在首次探测到之后按 API+模型 记住，
   本会话内后续消息直接用正确参数名首发。刷新页面后重新探测。与 IBWS 的搜索参数记忆同一套思路。 */
var _tokParamMem={};
function _tokParamKey(cfg){return String((cfg&&cfg.id)||'')+'|'+String((cfg&&cfg.model)||'')}
function _tokParamGet(cfg){try{return _tokParamMem[_tokParamKey(cfg)]||''}catch(e){return ''}}
function _tokParamRemember(cfg){try{var k=_tokParamKey(cfg);if(_tokParamMem[k])return;_tokParamMem[k]='max_completion_tokens';console.info('[IB] 该模型要求 max_completion_tokens 参数（'+String((cfg&&cfg.model)||'')+'），本会话内后续请求已直接采用正确参数名，不再每条消息先发一次失败请求。刷新页面后重新探测。')}catch(e){}}
/* 从"超出上限"类报错里提取服务端给出的建议最大值，直接一步到位而不是盲目减半。
   兼容：OpenAI "supports at most 16384 completion tokens"、Anthropic "65536 > 32000, which is the maximum"、
   中转常见 "max_tokens 不能超过 8192 / 上限为 8192" 等。 */
function _extractSuggestedMaxTok(e){
  var s=String(e&&e.message||'');
  var m=s.match(/(?:less than or equal to|no more than|at most|maximum(?:\s+allowed)?(?:\s+of)?|不能超过|不得超过|至多|最大为?|上限[为是]?)[^0-9]{0,12}([0-9][0-9,]{2,8})/i)
       ||s.match(/support(?:s|ed)?(?:\s+\S+){0,3}\s+([0-9][0-9,]{2,8})\s*(?:output\s+|completion\s+)?tokens/i)
       ||s.match(/[0-9][0-9,]*\s*>\s*([0-9][0-9,]{2,8})/);
  if(!m)return 0;
  var n=parseInt(m[1].replace(/,/g,''),10);
  return(n>=256&&n<=400000)?n:0;
}
/* 接缝去重：续写开头若重复了已有结尾（模型常见行为），裁掉重叠部分 */
function _wsDedupSeam(prev,next){
  if(!prev||!next)return next||'';
  var max=Math.min(400,prev.length,next.length);
  for(var k=max;k>=16;k--){
    if(prev.slice(prev.length-k)===next.slice(0,k))return next.slice(k);
  }
  return next;
}
var _maxContinuesPref=3;/* 任务6：自动续写轮数（可在 API 设置页配置；被截断时自动续写的最大次数） */
async function loadOutputSettings(){
  try{const s=await dbGet('apiSettings','outputSettings');if(s&&s.maxContinues!=null)_maxContinuesPref=Math.max(0,Math.min(10,parseInt(s.maxContinues)||3))}catch(e){}
  const el=document.getElementById('api-max-continues');if(el)el.value=String(_maxContinuesPref);
  const mc=document.getElementById('api-mdmode-select');if(mc)mc.value=_mdMode();
}
async function saveOutputSettings(){
  const el=document.getElementById('api-max-continues');
  _maxContinuesPref=Math.max(0,Math.min(10,parseInt(el&&el.value)||3));
  try{await dbPut('apiSettings',{id:'outputSettings',maxContinues:_maxContinuesPref})}catch(e){}
}
const _WS_CONT_PROMPT='[系统指令] 你上一条回复因输出长度上限被截断。请从截断处无缝继续输出剩余内容：不要重复任何已输出的内容，不要重新开头，不要致歉或解释，不要输出 <thinking>。如果截断发生在 <ws_create>/<ws_edit> 标签或代码块内部，直接继续其内容，并在结束时正确闭合标签/代码块。输出完剩余内容即停止。';

/* 流式：包装器（对外接口不变），内部循环调用单次版并自动续写 */
/* ══════════ 工具回合续（v6）：工具执行后自动回喂模型，AI 自己接着说 ══════════
   现有工具结果（ws_read / ws_edit / ws_run / ws_tool / 生图/读图回注等）全部走 _wsPending* 队列，
   原本只在「用户下一条消息」时注入——用户必须再说一句才能收尾。本机制在工具执行完成后：
   ① 消费反馈队列（与下一条消息同一注入源，消费式、不重复注入）；
   ② 附加图片回注（R3 scoped _ibImageDrain / _ibToolDrainImages，仅 vision 模型；
      DeepSeek 文本模型走本地视觉描述）；
   ③ 自动再调用一次模型（非流式，上限 _WS_TOOL_CONT_MAX 轮）→ 渲染为同角色的续接气泡；
   ④ 续轮里再输出工具则继续执行+续轮（受轮数上限保护，死循环不可能）。
   任何失败静默：工具结果仍在队列中，用户下一条消息照常注入（零回退风险）。 */
var _WS_TOOL_CONT_MAX=2;/* 一次用户回合内工具后自动续轮上限（不含用户消息本身触发的首轮） */
/* P11-2C · 副作用闸门（桌面 Chat 回合内**唯一**的政策读取点）──────────────
   输入是**显式裁定状态**（本轮 Middle Brain 收口产出的 verdict，或 null = 拿不到状态），
   决策本身完全由 integrity 层持有，经**门面**转发（middleBrainSideEffectAllowed）。
   本适配层不判断、不加条件、不看 reply、不看文本是否变化、不看有无错误码 ——
   它只把状态送去决策点并把结论带回来。门面不可用（未装配）时同样 fail-open：
   那时没有任何状态可传，等价于改动前的行为。 */
var _mbVerdict=null;
/* 本回合解析出的模型派生副作用指令**条数**（P11-2D 可观测性）。
   这是"这一轮究竟有没有要被执行的指令"这一事实的**唯一持有者** —— 由解析过 ops 的
   位置写入，闸门只读取、不推断（闸门不看文本，所以它无从知道有没有指令）。
   关键语义：UNDECIDED 但 count 全为 0 ⇒ 根本没有发生抑制，绝不记 suppression=true。 */
var _mbSideEffectCounts={};
/* 类别名常量（与 integrity 层 MB_CI_SUPPRESSION_CATEGORIES 的值一一对应；
   这里只是把字面量收敛到一处，避免 6 个字符串在 12 个调用点上散落笔误）。 */
var _MB_SEC={mem:'memory',cal:'calendar',blog:'blog_read',ws:'workspace',file:'file_archive',tool:'tool_continue'};
/* P11-2D · 抑制记录的**唯一消费点**：把"确有条目 + 被拦下"转成记一条去标识化记录。
   只传类别与条数；路径 / 正文 / 搜索词 / 工具参数一律不进入本函数。
   形态说明：
     · `_mbSideEffectGateCats([...], n)` —— 类别由调用方按真实 op 类型算出（ws_ops 横跨多类时逐个）；
     · `_mbSideEffectGate(_MB_SEC.x)`    —— 单类别，条数取自本回合计数表；
     · `_mbSideEffectsOk()`              —— 没有条目可报的守卫（工具续轮），零记录。
   三条路径都不会因为"状态是 UNDECIDED"而记抑制：没有确有条目就没有记录。 */
function _mbSideEffectGateCats(cats,n){
  if(!(Number(n)>0))return _mbSideEffectsOk(null,0);
  if(!Array.isArray(cats)||!cats.length)return _mbSideEffectsOk(null,0);
  var ok=true;
  for(var i=0;i<(cats||[]).length;i++){if(_mbSideEffectsOk(cats[i],n)===false)ok=false}
  return ok;
}
function _mbSideEffectGate(cat){
  var n=Number(_mbSideEffectCounts[cat])||0;
  if(n<=0)return _mbSideEffectsOk(null,0);
  return _mbSideEffectGateCats([cat],n);
}
/* ws_ops 单个入口承载多类动作（文件 / 图片 / 搜索 / 工具执行），按 op.type 归类。
   未知 type **不给兜底类别**：宁可少记一个类别，也不把一个我们不认识的指令
   归进最像的那一类（不猜类别 —— 与闸门"不推断"同一原则）。 */
function _mbSecWsCat(op){
  var t=String((op&&op.type)||'').toLowerCase();
  if(t==='run')return _MB_SEC.tool;                                 /* 会再触发一次模型请求的那一类 */
  if(t==='create'||t==='edit'||t==='read'||t==='read_image'
    ||t==='gen_image'||t==='edit_image')return _MB_SEC.ws;          /* 文件 / 图片读写 */
  return null;
}
/* ws_ops 一束指令可能横跨多个类别（如 read + run）：逐个归类并去重。 */
function _mbSecWsCats(ops){
  var out=[];
  (ops||[]).forEach(function(op){
    var c=_mbSecWsCat(op);
    if(c&&out.indexOf(c)<0)out.push(c);
  });
  return out;
}
/* 与 `_mbSecWsCats` 配套的条数：一束指令里**确实存在**的条目数（ops + file 块）。
   闸门只把它当元数据用（`_mbCiSuppress` 要求 count > 0 才记录），它不参与任何判定 ——
   判定只由 verdict 决定。至少为 1：调用方既然问了，就说明这一轮**确有**条目
   （这正是"没有条目就不记录"那条纪律的对偶面）。
   P11-2E 补：本函数是为了修掉 P11-2D 的一个缺口 —— 多类别的工具续轮调用点此前
   没传条数，于是 `tool_continue` 这个"会再发一次模型请求"的类别**永远不会被记录**。 */
function _mbSecWsCount(ops,fileCount){
  var n=(Array.isArray(ops)?ops.length:0)+(Number(fileCount)>0?Number(fileCount):0);
  return n>0?n:1;
}
/* 日历闸门只把明确的便笺指令计为可记录副作用。普通回复也会经过 processReply
   的扫描入口；没有 <cal_note> 时，UNDECIDED 仍跳过扫描，但不能记成拦下了一项操作。 */
function _mbCalNoteCount(reply){
  var m=String(reply||'').match(/<cal_note\b/gi);
  return m?m.length:0;
}
function _mbSideEffectsOk(category,count){
  /* 唯一读取入口 = 门面（与 middleBrainExecute 同一纪律）：不碰内部层契约符号。
     调用形状固定为 `门面(本轮状态, 类别, 条数)`：状态永远是 _mbVerdict（本回合收口产物），
     后两个只是**元数据**，判定语义完全在 integrity 层 —— 适配层不解释 verdict 的含义。 */
  var _f=(window.IB&&window.IB.middleBrain)||null;
  if(!_f||typeof _f.middleBrainSideEffectAllowed!=='function')return true;
  return _f.middleBrainSideEffectAllowed(_mbVerdict,category,count)===true;
}
/* ── P11-2I · 收口之外的模型派生副作用：**记录**，不假装判定 ─────────────────
   背景（P0 审计结论，不是新增能力）：博客留言与角色来信两条路径从模型回复里
   解析 `<mem_*>` 并直接 `_execMemOps` 落库，既没有 verdict 也没有任何 trace ——
   它们此前在所有观测面上都是**不可见的**。

   为什么这里**不**调用 `_mbSideEffectGate`：`_mbVerdict` 的语义是"**本轮单聊
   回合**收口产出的裁定状态"，它的唯一复位点是 sendMessage 的回合开头。留言与
   来信不在任何单聊回合里，读到的是**上一次**回合的残留值（或并发回合中正在
   跑的值）。把它送进闸门会得到一个"看起来经过判定"的结论，而那个结论在语义上
   是错的 —— 它可能因为一条无关的 UNDECIDED 回复而误拦一次正常留言，也可能因为
   null 而静默放行。**用一个语义错误的闸门冒充边界，比没有闸门更糟**，
   因为它在观测面上无法与真实判定区分。

   所以本函数只做一件事：把"这条路径产生了模型派生的记忆写入、且它不在
   裁定管线内"如实记进**既有**的 trace 记录（与单聊/群聊同一套 `__mbTrace`，
   零新设施）。consumer 具名（blog_comment / role_letter），
   sideEffectPolicy='outside_adjudication'，blockedReason=null，
   sideEffectsSuppressed 保持 null（绝不写成 true —— 这里没有发生抑制）。
   字段与判定语义来自 integrity 层的 MB_CI_OUTSIDE_ADJUDICATION，本处不复制字面量。

   收尾纪律：本函数**返回一个收尾闭包**而不是句柄对象 —— 这样记录一定进 ring
   （`finish` 是唯一推进 ring 的点），调用方不可能"忘了 finish"或"用错 key"。
   闭包只接受**结构化**的收尾参数（executor / outputMessages / count），
   绝不接受异常正文 —— 那可能带 URL / key / 正文片段。 */
function _mbOutsideAdjudication(){
  try{
    var _f=(window.IB&&window.IB.middleBrain)||null;
    var v=_f&&_f.MB_CI_OUTSIDE_ADJUDICATION;
    /* 降级字面量与 integrity 层的枚举值逐字相同（由测试断言两者一致），
       这里**不是**第二份规则，只是"门面不在时不抛"的保守下界。 */
    return v?String(v):'outside_adjudication';
  }catch(e){return 'outside_adjudication'}
}
function _mbBoundaryTrace(consumer,cfg,count,category){
  try{
    var t=(window.IB&&window.IB.__mbTrace)||null;
    if(!t||typeof t.begin!=='function'||typeof t.finish!=='function')return function(){};
    var key=String((cfg&&cfg.id)||'');
    if(!key)return function(){};
    t.begin(String(consumer||''),key);
    /* 只记事实：本路径不在裁定管线内、没有 verdict、没有发生抑制。
       类别与条数由调用方给出（它已经解析过 ops），本层不推断。 */
    var cats=(category==null?[]:[String(category)]);
    t.note(key,'sideEffectPolicy',_mbOutsideAdjudication());
    t.note(key,'integrityVerdict',null);
    t.note(key,'integrityReason',null);
    t.note(key,'blockedReason',null);
    t.note(key,'sideEffectCategories',cats);
    t.note(key,'inputMessages',null);
    var done=false;
    return function(kind,executed){
      if(done)return;done=true;
      try{
        var extra={executor:String(kind==null?'completed':kind)};
        if(Number.isFinite(Number(executed)))extra.outputMessages=Number(executed);
        t.finish(key,extra);
      }catch(e){}
    };
  }catch(e){return function(){}}
}
/* 唯一入口（与 `IB.__mbTrace` / `IB.middleBrain` 同一纪律：只读命名空间，不复制实现）。
   兄弟模块（communication/letters.js 在自己的 IIFE 里）取用这一处 —— 于是
   "收口之外路径必须留 trace"这条纪律只有一个实现，不会因为第二个消费方而分叉。 */
try{
  if(window.IB){window.IB.__mbBoundaryTrace=_mbBoundaryTrace;window.IB.__mbOutsideAdjudication=_mbOutsideAdjudication}
}catch(e){}

/* ── P11-2F · 群聊记忆写入边界（适配层；判定一律委托给 integrity 层）──────────
   `_mbGroupMemPolicy` 是群聊路径的**唯一判定入口**。它只做三件事：
     ① 取门面（不碰内部层契约符号）；
     ② 把群聊的记忆目标域如实交给 integrity 层的纯分类器；
     ③ 政策本体不可用时 **fail closed**（与 `_calibrateMemoryCandidate` 的
        "准入核心不可用即拒绝"同一纪律）。
   刻意**不**在这里复制 scope 枚举或 kind 词表：那会是第二份政策实现。
   返回 {allowed,policyDecision,blockedReason,scope}；政策不可用时 scope/memoryScope
   一律留 null，表示"观测不到"，绝不编造一个看起来很正常的域。 */
function _mbGroupMemPolicy(scope,kind,characterId){
  var _f=(window.IB&&window.IB.middleBrain)||null;
  if(!_f||typeof _f.middleBrainGroupMemoryPolicy!=='function'){
    return {allowed:false,policyDecision:'deny',blockedReason:'policy_unavailable',scope:null};
  }
  return _f.middleBrainGroupMemoryPolicy(_mbVerdict,scope,kind,characterId);
}
/* 群聊记忆目标域：发言成员的**私有**长期记忆（autoMemory，按角色 id 存储）。
   这个词表值来自 integrity 层（MB_GROUP_MEMORY_SCOPE），此处不写字面量。 */
function _mbSecGroupScope(){
  var _f=(window.IB&&window.IB.middleBrain)||null;
  var s=_f&&_f.MB_GROUP_MEMORY_SCOPE;
  return (s&&s.PRIVATE_ROLE)||null;
}
/* 群聊成员 id 列表（去重、稳定排序）—— 只放 id，不放昵称：trace 是元数据面。 */
function _mbGroupParticipants(cfgs){
  var out=[];
  (cfgs||[]).forEach(function(c){
    var id=c&&c.id?String(c.id):'';
    if(id&&out.indexOf(id)<0)out.push(id);
  });
  return out.sort();
}
/* 群聊每个发言成员的回合结束时收尾该成员的 trace 记录。
   群聊**没有**抑制记录可报（不经过副作用闸门），因此 sideEffectsSuppressed 保持
   该成员记录的初始值 —— 绝不写成 true，也绝不假装这里发生了抑制。
   与单聊一致：finish 是唯一把记录推进 ring 并打印的点，每个成员各调一次。 */
function _mbGroupTraceFinish(traceKey,verdict){
  try{
    var trace=(window.IB&&window.IB.__mbTrace)||null;
    if(!trace)return;
    trace.finish(String(traceKey==null?'':traceKey),{});
  }catch(e){}
}

/* 群聊回合一开就写入 §4 的 context 字段（groupId / participants / memoryScope）。
   判定结果字段（policyDecision / blockedReason）由 `_mbGroupMemPolicy` 的消费点补写 ——
   没有记忆指令时它们保持 null，表示"本回合没有任何记忆写入被判定"，绝不预先写成 allow。 */
function _mbGroupTraceContext(groupId,traceKey,cfgs){
  try{
    var trace=(window.IB&&window.IB.__mbTrace)||null;
    if(!trace)return;
    var key=String(traceKey==null?(groupId||''):traceKey);
    trace.note(key,'groupId',groupId==null?null:String(groupId));
    trace.note(key,'participants',_mbGroupParticipants(cfgs));
    trace.note(key,'memoryScope',_mbSecGroupScope());
    trace.note(key,'policyDecision',null);
    trace.note(key,'blockedReason',null);
  }catch(e){}
}
/* 被拦下的记忆指令 → 一条 trace（"任何被 Middle Brain 拦截的行为必须留下 trace"）。
   只记稳定原因与目标域；**不记**记忆正文、条目 id 或角色昵称。 */
function _mbGroupTraceBlock(traceKey,decision){
  try{
    var trace=(window.IB&&window.IB.__mbTrace)||null;
    if(!trace)return;
    var key=String(traceKey==null?'':traceKey);
    trace.note(key,'memoryScope',decision&&decision.scope!=null?decision.scope:null);
    trace.note(key,'policyDecision',(decision&&decision.policyDecision)||'deny');
    trace.note(key,'blockedReason',(decision&&decision.blockedReason)||'out_of_scope');
  }catch(e){}
}

/* 抑制记录的唯一读取入口：经门面（不碰内部层契约）。
   两个守卫都是**如实性**守卫，不是判定：
     · verdict 已复位 ⇒ 本函数还没被任何副作用调用过 ⇒ 抑制记录属于上一回合 ⇒ 不读（留 null）；
     · 门面不可用 ⇒ 不编造结论，两个字段留 null / []，表示"观测不到"。
   返回 null 一律意味着"这一轮没有可报告的信息"，绝不等于"没有抑制"。 */
function _mbSecTrace(verdict){
  if(!verdict)return null;
  try{
    var _f=(window.IB&&window.IB.middleBrain)||null;
    if(!_f||typeof _f.middleBrainSideEffectSuppression!=='function')return null;
    var s=_f.middleBrainSideEffectSuppression()||{};
    return {s:!((s.count||0)>0),c:Array.isArray(s.categories)?s.categories:[]};
  }catch(e){return null}
}
function _mbSecTraceFinish(trace,characterId,verdict){
  if(!trace)return;
  var t=_mbSecTrace(verdict);
  trace.note(characterId,'sideEffectsSuppressed',t?t.s:null);
  trace.note(characterId,'sideEffectCategories',t?t.c:[]);
  trace.finish(characterId,{});
}

/* ── P11-2E · 用户可见的完整性提示（唯一派生点与唯一渲染点）──────────────
   解决的问题：UNDECIDED 回合里回复**正常显示**，但由它解析出的自动动作被拦下。
   此前开发者可见（trace / telemetry，P11-2D）、**用户完全不可见** —— 用户只会
   看到回复缺了一件事，然后自己猜。

   与 P11-2C/2D 的边界完全一致，不重新判定任何东西：
     · 只在**真实发生抑制**时出现。判据是 integrity 层唯一写入点产出的记录
       （count > 0），**不是** verdict === UNDECIDED —— 后者只是"没拿到结论"，
       没有任何条目时它不是抑制（P11-2D 的核心语义）。
     · verdict 必须仍是 UNDECIDED：抑制只可能由该状态产生；若记录非空而状态不是
       UNDECIDED，那就是不一致，此时**不显示**（绝不把矛盾包装成一句安慰话）。
     · 不新增任何模型调用、不改闸门、不改 verdict 词表、不恢复被拦下的动作。

   措辞纪律（用户不需要知道内部审查）：
     · 不出现 Judge / Astra / integrity / UNDECIDED / confidence / score /
       severity / dimension 中的任何一词 —— 内部审查的存在对用户不是信息；
     · 用户真正需要知道的三件事：① 回复本身是好的；② 有个自动动作没做；
       ③ 再说一次可以重做。三者都不需要暴露"为什么被拦"的机制。
     · 措辞说的是"这次没能确认执行条件"（事实），而不是"我判断你不安全"
       （把一次技术性未决说成对其内容的否定判断，是给用户的错误归因）。
   渲染形态：沿用既有的 `.ws-op-card.warn` 内联卡（与 `_buildWsPhantomHint`
   "AI 声称已创建但实际未执行"同一形态与同一语义档位），**不用 toast** —— toast
   会消失，而用户需要在历史里看得见"这件事当时没做"。 */

/* 反馈契约（冻结）：metadata.integrityNotice = {type, categories}。
   只存类型与类别名，**不存 payload**：没有正文 / 路径 / 记忆内容 / 工具参数 /
   搜索词的承载字段。字符串一律取自下方词表，绝不从模型输出里拼接。 */
var MB_INTEGRITY_NOTICE_TYPE='side_effect_blocked';
/* 与 integrity 层 MB_CI_SUPPRESSION_CATEGORIES 的 6 个值一一对应（字面量收敛到一处）。
   这里保存的是**全部**真实发生的类别。 */
var _MB_NOTICE_CATS=['memory','calendar','blog_read','workspace','file_archive','tool_continue'];
/* 其中**用户可感知**的那几类才有对应说法。memory / calendar 本就是静默动作
   （写进了记忆、记了便笺，用户平时也看不到），"没做"对用户不构成一个可核对的缺口；
   把它们说成"没执行"只会制造困惑。类别本身仍如实保存在 metadata 里 ——
   这与 P11-2D"说不清就别报"是同一条纪律：展示层只说它真能说清的那部分。 */
var MB_NOTICE_USER_VISIBLE_CATS=['workspace','file_archive'];
var _MB_NOTICE_TEXT_SPECIFIC='回复已完成，但本次涉及文件/工作区的自动操作没有执行——暂时无法确认执行条件。需要的话，你再说一次我就重做。';
var _MB_NOTICE_TEXT_GENERIC='回复已完成，但本次有一项自动操作没有执行——暂时无法确认执行条件。需要的话，你再说一次我就重做。';

/* —— 唯一派生点：verdict + 本回合抑制记录 ⇒ 该消息要不要带提示 ——
   返回 null = 不带提示（metadata 里连键都不会出现）。
   verdict 词表仍是 integrity 层的 `MB_CI_VERDICT`（门面下的内部层契约），
   这里只**取值**，不复制枚举、不新建第二套状态机。 */
function _mbIntegrityNoticeFor(verdict){
  if(verdict!=='UNDECIDED')return null;
  try{
    var _f=(window.IB&&window.IB.middleBrain)||null;
    if(!_f||typeof _f.middleBrainSideEffectSuppression!=='function')return null;
    var s=_f.middleBrainSideEffectSuppression()||{};
    /* 唯一判据：真实记录到了抑制条数。没有条目 ⇒ 没有提示。 */
    if(!(Number(s.count)>0))return null;
    var cats=[];
    (Array.isArray(s.categories)?s.categories:[]).forEach(function(c){
      var v=String(c||'').toLowerCase();
      if(_MB_NOTICE_CATS.indexOf(v)>=0&&cats.indexOf(v)<0)cats.push(v);
    });
    /* 类别一个都没认出来：宁可什么都不说，也不编一个说不清的提示（同 P11-2D）。 */
    if(!cats.length)return null;
    return {type:MB_INTEGRITY_NOTICE_TYPE,categories:cats};
  }catch(e){return null}
}
/* —— 唯一解析点：消息 → 提示形态。历史消息没有该 metadata ⇒ 返回 null，
   渲染路径与本次改动之前**逐字一致**（T10）。 */
function _mbNoticeFromMessage(m){
  try{
    var n=m&&m.metadata&&m.metadata.integrityNotice;
    if(!n||typeof n!=='object'||Array.isArray(n))return null;
    if(String(n.type)!==MB_INTEGRITY_NOTICE_TYPE)return null;
    var cats=[];
    (Array.isArray(n.categories)?n.categories:[]).forEach(function(c){
      var v=String(c||'').toLowerCase();
      if(_MB_NOTICE_CATS.indexOf(v)>=0&&cats.indexOf(v)<0)cats.push(v);
    });
    if(!cats.length)return null;
    return {type:MB_INTEGRITY_NOTICE_TYPE,categories:cats};
  }catch(e){return null}
}
/* —— 唯一渲染点：内联提示卡。只吃上面解析出来的 {type, categories}，
   卡片文本是固定词表产物 —— 任何模型输出/文件路径/记忆正文都进不来。
   刻意不挂任何按钮：被拦下的动作**不会**因此被重放（P11-2C 的边界）。 */
function _buildIntegrityNoticeCard(notice){
  try{
    var c=document.createElement('div');
    c.className='ws-op-card warn ib-integrity-notice';
    c.dataset.noticeType=String(notice&&notice.type||'');
    var specific=(notice&&Array.isArray(notice.categories)?notice.categories:[])
      .some(function(x){return MB_NOTICE_USER_VISIBLE_CATS.indexOf(x)>=0});
    var txt=specific?_MB_NOTICE_TEXT_SPECIFIC:_MB_NOTICE_TEXT_GENERIC;
    var ic=(typeof WS_ICON!=='undefined'&&WS_ICON&&WS_ICON.warn)?WS_ICON.warn:'';
    c.innerHTML=ic+'<span class="ws-op-text">'+esc(txt)+'</span>';
    return c;
  }catch(e){return null}
}
/* 渲染入口：无提示 ⇒ 不 append 任何节点（不打断聊天、不覆盖回复）。 */
function _mbAppendNoticeCard(host,m){
  var n=_mbNoticeFromMessage(m);
  if(!n||!host)return null;
  var c=_buildIntegrityNoticeCard(n);
  if(c)host.appendChild(c);
  return c;
}
async function _wsToolContinue(cfg,o){
  try{
    if(!cfg||!o)return null;
    var round=Math.max(0,Number(o.round)||0);
    if(round>_WS_TOOL_CONT_MAX)return null;
    /* ── P11-3D.1：XML 续轮是**同一个宿主回合**的另一条入口 ──────────────
       P11-3D 时期这里是 `IBFC.cycleBegin(null,…)`（恒 null）+ 自己 cycleEnd，
       于是续轮内部另开了一个周期：一个 turn 两个预算，且轮次计数被重置。
       现在续轮**只继承**宿主回合的 turn（o._ibTurn）：
         · 有 turn → 不 begin、不 end，用它那一个周期与那一份预算；
         · 没有 turn（旧调用面/独立脚本）→ 退化成"本次调用自己就是一个宿主回合"
           （ownsCycle 只属于这个新建的 turn），保持单周期语义。
       旧的 _WS_TOOL_CONT_MAX 仍是这条通道的硬上界（未放宽），
       canonical 轮预算由同一个 guard 裁定 —— 不新建第二套轮次上限。 */
    var _turn=_ibTurnOf(o);
    var _lc=null;
    if(!_turn){ _lc=_ibTurnLc(_ibTurnScope('xml-continue')); _turn=_lc.turn(); _lc.begin(); }
    var _cont=Object.assign({},o,{messages:(o.messages||[]).slice(),round:round,_ibTurn:_turn,guard:_turn.guard});
    try{
      return await _wsToolContinueInner(cfg,_cont);
    }finally{
      if(_lc)_lc.end();
    }
  }catch(e){
    console.warn('[WsToolContinue] failed (tool results stay queued for next user message):',String(e&&e.message||e).slice(0,160));
    return null;
  }
}
async function _wsToolContinueInner(cfg,o){
  try{
    var round=Math.max(0,Number(o.round)||0);
    /* 本回合的作用域（宿主 turn）。周期实例**只能**来自它 ——
       拿不到就没有周期可用，XML 工具于是被 no-active-cycle 拒绝执行（fail closed），
       而不是回落"当前活动实例"把执行记进别人的额度。 */
    var _turn=_ibTurnOf(o);
    var _g=(_turn&&_turn.guard&&typeof _turn.guard.active==='function'&&_turn.guard.active())?_turn.guard:null;
    /* ① 消费本回合执行的工具反馈（消费式：后续用户消息不再重复注入） */
    var feed='';
    try{
      /* P30-2 · 工具续轮同样按会话归属过滤（friendId/threadId 来自本次续轮的会话上下文）。 */
      const _scMine=_ibWsScopeFilter(o.friendId,o.threadId);
      /* P30-5 · 工具续轮侧同样按会话过滤 Blog 注入。 */
      feed=_getWsReadInjection(_scMine)+_getWsOpFeedbackInjection(_scMine)+_getWsRunOutputInjection(_scMine)+_getIbToolResultInjection(_scMine)+_getBlogReadInjection(_scMine);
    }catch(e){feed=''}
    /* ② 图片回注（工具图片 / 生图结果 / ws_read_image；仅支持视觉的模型消费；文本模型保留队列） */
    var imgParts=[],imgNote='';
    try{
      var _lv=_usesLocalDeepSeekVision(cfg),_nv=_usesNativeDeepSeekVision(cfg);
      var _vOk=_lv||_nv||(cfg.vision!==undefined?!!cfg.vision:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].vision));
      if(_vOk){
        var _media=[];
        _ibTakeScopedMedia('_ibToolDrainImages',_scMine).forEach(function(u){var _ti=_ibMediaPromptImage(u,'tool_result.png');if(_ti)_media.push(_ti)});
        _ibTakeScopedMedia('_ibImageDrain',_scMine).forEach(function(u){var _ii=_ibMediaPromptImage(u,'image_inject.png');if(_ii)_media.push(_ii)});
        var _urls=_media;
        if(_lv&&_urls.length){
          try{
            var _desc=_describeImagesLocally(_urls,'请结合图片继续你刚才的工作：'+(o.lastReply||'').slice(0,120));
            if(_desc)imgNote='\n\n[图像参考（本地视觉识别）] '+String(_desc).slice(0,2000);
          }catch(e){imgNote=''}
        }else if(_urls.length){
          _urls.forEach(function(u){imgParts.push({type:'_image',base64:u.base64,mime:u.mime})});
        }
      }
    }catch(e){}
    if(!feed&&!imgParts.length&&!imgNote)return null;/* 无任何工具反馈可续 → 保持原有行为 */    /* ③ 构造续轮消息：历史 + 上一条 assistant + 工具结果 user（图片附在 user 消息上） */
    var msgs=(o.messages||[]).slice();
    msgs.push({role:'assistant',content:String(o.lastReply||'')});
    var userText='【工具执行结果】你上一步发出的操作已经执行完成，结果如下（据此继续/收尾；不要重复执行已完成的动作）：'
      +(feed?'\n'+feed:'')+(imgNote?('\n'+imgNote):'')
      +'\n若结果满足要求，用一句自然的话向用户收尾即可；若有需要修正或继续的操作，请继续输出相应指令。';
    var userMsg={role:'user',content:imgParts.length?[{type:'text',text:userText}].concat(imgParts):userText};
    msgs.push(userMsg);
    var r=await callApiChat(cfg,msgs,{_ibConsumer:'chat',_ibTraceId:_turn&&_turn.traceId||'',maxTokens:Math.max(1024,o.maxTokens||2048),timeoutMs:90000,wantMeta:false,autoContinue:true,_ibTurn:_turn});/* 工具续轮：同一 Chat 请求流（同一宿主回合 → 同一周期/同一预算） */
    if(!r||!String(r).trim())return null;
    /* ④ 续轮回复里的工具继续执行（常见于链式操作：生成→继续调整）
       P11-3D.1：授权与结算**只有一处**（_ibExecToolOp 的 authorize→execute→settle），
       这里不再做第二遍 beforeCall —— 两处授权会让一次调用吃掉两份工具额度
       （重复/计数口径立刻失真：真实执行 1 次、账本 +2）。 */
    var parsed=_assistantResponseParts(r,'');
    var contText=parsed.content;
    var _cOp=_parseWsOps(contText),_cResults=[];
    var _cExec=_cOp.ops;
    try{_cResults=await _execWsOps(_cExec,o.senderName||(cfg.nickname||cfg.model||'AI'),cfg,{source:'chat',friendId:o.friendId||'',threadId:o.threadId||'',senderName:o.senderName||'',_ibTurn:_turn,guard:_g})}catch(e){}
    if(_cOp.files&&_cOp.files.length){try{await _wsArchiveFileBlocks(_cOp.files,o.senderName||(cfg.nickname||cfg.model||'AI'),_wsRoleFileProvenance(cfg))}catch(e){}}
    /* ⑤ 渲染为同角色续接气泡（含操作卡），与主流程同款 */
    var _cId='msg_'+Date.now()+'_'+Math.floor(Math.random()*100000);
    var _cImg=_wsCollectGenImages(_cResults);
    var _cMsg={id:_cId,role:'assistant',content:contText,reasoning_content:parsed.reasoning_content||'',metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,showThinking:_resolveShowThinking(cfg),toolRound:round+1},friendId:o.friendId,timestamp:Date.now()};
    if(_turn&&_turn.activityId)_cMsg.metadata.activityId=_turn.activityId;/* 同回合 activity 归属继承（与主流式/非流式/waifu 落库点同款） */
    /* P23 Phase 2A：本回合的第 (round+1) 条消息。工具续轮与主回复是**同一个**模型回合
       （同一个 turn 对象、同一份预算），因此共享回合身份、各自的 sequenceIndex 决定
       顺序 —— 此前只按 timestamp 排，而续轮先落库、主回复落库更晚，reload 后顺序会
       颠倒（真实缺陷）。回合身份**只在单聊回合**存在：群聊的回合归属（成员级 vs 群级）
       需要单独设计，本阶段不为群聊引入 per-member turn。 */
    if(_turn&&_turn.turnId){_cMsg.metadata.turnId=_turn.turnId;_cMsg.metadata.sequenceIndex=round+1;}
    /* P24-M1 · 群聊工具续轮：groupTurnId / speakerId / groupOrder 与所属成员回合保持一致
       （续轮绝不产生新的群回合）。turnId 仍按 P23 现行 tool-round 契约继承
       （同一个 turn + sequenceIndex=round+1）。
       只在群身份存在时写入 ⇒ 单聊逐字不变。 */
    if(_turn&&_turn.groupTurnId){_cMsg.metadata.groupTurnId=_turn.groupTurnId;_cMsg.metadata.speakerId=_turn.speakerId;_cMsg.metadata.groupOrder=_turn.groupOrder;}
    if(o.senderName)_cMsg.senderName=o.senderName;
    if(_cImg.length)_cMsg.images=_cImg;
    if(o.threadId)_cMsg.threadId=o.threadId;
    _ibPrepareExpressionMessage(_cMsg,cfg,null);
    try{await dbPut('chatMessages',_cMsg)}catch(e){}
    if(o.friendId===activeFriendId){
      appendChatBubble('ai',contText,o.senderName,parsed.reasoning_content||undefined,_cId,_cImg,undefined,_cResults,undefined,cfg);
      /* appendChatBubble 为全屏与迷你容器统一挂载相同的消息操作。 */
    }else{try{_markUnread(o.friendId)}catch(e){}}
    /* ⑥ 续轮若再产生工具反馈 → 继续（轮预算由 guard 统一裁定，旧字面量只作下界）
       P11-3D.1：递归续轮**继承同一个 turn**（同一个周期、同一份预算）——
       无论递归多少层，本 turn 的 cycle 数始终为 1，maxRounds 也不被重置。 */
    var _ctripped=false;
    try{_ctripped=!!(_g&&_g.tripped())}catch(e){}
    if(_ctripped){try{if(typeof IBFC._trip==='function')IBFC._trip(_g.tripInfo().reason,null,function(t){try{console.warn(t)}catch(e){}})}catch(e){}}
    if(round<_WS_TOOL_CONT_MAX&&!_ctripped){
      try{await _wsToolContinue(cfg,Object.assign({},o,{messages:msgs,lastReply:contText,round:round+1}))}catch(e){}
    }
    return{text:contText,round:round+1};
  }catch(e){
    console.warn('[WsToolContinue] failed (tool results stay queued for next user message):',String(e&&e.message||e).slice(0,160));
    return null;
  }
}
window._wsToolContinue=_wsToolContinue;

/* ══════════ Waifu 消息呈现（MessagePresentation）· v11 ══════════
   定位：Waifu Mode 是"消息呈现模式"，只回答两件事：完整响应 → 呈现成几条、每条隔多久。
         **"在哪切"不再是本模块的事**：P23 Phase 2C 之后，切分规则（Structural Parsing /
         Utterance Segmentation / anti-fragmentation / min-max 长度策略 / 无损保证）
         唯一实现 = assets/js/delivery-planner.js；本模块只做 mode 决策与节奏提示。
   对外 API（语义与 v10 逐字兼容）：
     plan(reply, opts) → { mode:'stream'|'single'|'multi', messages:[{text,delay}], segments:[text] }
     split(text, opts) → string[] | null   （向后兼容别名，= planner.segment）
     delayBetween(len) → number            （真人节奏，确定性上界；Runtime 执行，本层只提示）
     deliveryPlan(reply,opts) → planner 的完整计划（units/stats/policy，只读、无时间）
     policy() → 生效的切分边界（只读）
   约束：不干预模型执行 / continuation / memory / tools；不改 Harness / ModelPort；
        streaming:true → {mode:'stream'}，交给现有 streaming renderer 实时呈现，绝不等待完整再拆。
   lossless 硬性保证（由 planner 负责并自检）：join(messages) 与原文仅差空白归一。 */
window.MessagePresentation = (function () {
  'use strict';
  /* ══════════ P23 Phase 2C · 呈现层（"怎么拆"已交给 Delivery Planner）══════════
     P23 2C 之前，"怎么拆"与"隔多久发"都住在这里。现在：
       · 结构（切分规则 / 边界 / 无损保证）唯一实现 = assets/js/delivery-planner.js；
       · 本模块只保留**呈现与节奏**：
           - mode 决策（stream / single / multi）；
           - delayBetween —— 既有节奏公式（被 waifu.pace.dynamic 钉住）。它只是**提示**，
             真正的等待由 Phase 2B 的 Delivery Runtime 执行（时间不属于本层）；
           - 向后兼容的 split / plan 入口（旧调用与浏览器端到端测试仍经它们，
             语义逐字不变：null = 不拆）。
     本文件**不再**实现任何第二套拆句规则。planner 缺席时 split 返回 null
     （= 退回单条消息的安全退化，绝不因为归一层缺席而丢内容）。 */
  function planner() {
    try { return (typeof window !== 'undefined') ? window.IBDeliveryPlanner : null; } catch (e) { return null; }
  }
  /* 真人发送节奏：根据上一条长度给出"到下一条"的确定性上界（无不可测随机）。
     短消息 320 · 普通 480 · 较长 640 · 长 800 · 超长 960；首条立即（delay 0）。 */
  function delayBetween(len) {
    len = Number(len) || 0;
    if (len <= 10) return 320;
    if (len <= 30) return 480;
    if (len <= 60) return 640;
    if (len <= 120) return 800;
    return 960;
  }
  /* 向后兼容入口：语义 = planner.segment（null = 不拆；功能标签/空文本/拆不出多条）。 */
  function split(text, opts) {
    var P = planner();
    if (!P || typeof P.segment !== 'function') return null;
    return P.segment(text, opts || {});
  }
  /* 呈现决策（唯一入口）：完整响应 → 呈现计划（内容 + 节奏）。
     - streaming:true → 'stream'（现有 streaming renderer 实时呈现，不拆、不等完整）
     - waifu 关闭 或 无法自然拆成多条 → 'single'
     - waifu 开且能拆成多条 → 'multi'（messages 逐条呈现，含各自 delay） */
  function plan(reply, opts) {
    opts = opts || {};
    if (opts.streaming) return { mode: 'stream', messages: [], segments: [] };
    if (opts.waifu !== true) return { mode: 'single', messages: [], segments: [] };
    var segs = split(reply, opts);
    if (!segs || segs.length <= 1) return { mode: 'single', messages: [], segments: [] };
    var messages = segs.map(function (t, i) { return { text: t, delay: i === 0 ? 0 : delayBetween(segs[i - 1].length) }; });
    return { mode: 'multi', messages: messages, segments: segs };
  }
  /* P23 2C 新增（只读、无时间）：把 planner 的完整计划暴露给 delivery 链路与诊断。
     units 是 Phase 2C 的 unit 形状（{kind:'text',content}）；delay 仍然只出现在 plan()。 */
  function deliveryPlan(reply, opts) {
    var P = planner();
    return (P && typeof P.planTurn === 'function') ? P.planTurn(reply, opts || {}) : null;
  }
  /* 生效的切分策略（只读；供诊断与测试断言"边界明确"）。 */
  function policy() {
    var P = planner();
    return (P && typeof P.policyFor === 'function') ? P.policyFor(null) : null;
  }
  return { split: split, plan: plan, delayBetween: delayBetween, deliveryPlan: deliveryPlan, policy: policy };
})();
/* 向后兼容别名：旧调用/测试仍经 window._waifuSplit；语义 = MessagePresentation.split */
window._waifuSplit = function (_t) { return window.MessagePresentation ? window.MessagePresentation.split(_t) : null; };

/* ══════════ P23 Phase 2A · 多段交付的 canonical 构造（Message Sequence Contract）══════════
   上层的「呈现计划」（MessagePresentation.plan）与本层的**数据契约**是两件事：
     · plan 决定"拆成几条、每条等多久" —— 那是呈现策略，Phase 2A 不新增任何策略；
     · 本层决定"这几条在数据库里长什么样" —— 每条都是**真正独立**的 canonical
       chatMessage（各自 id、各自可撤回、各自可播放），通过 metadata 里的回合身份
       （turnId / sequenceIndex / sequenceTotal）关联成同一个模型回合。
   构造逻辑**全部**在 assets/js/delivery-sequence-core.js（纯模块，Node 可测）；
   这里只转调一次：把文本片段 + 本回合的身份与模型信息交给契约层。
   核心未加载 ⇒ 返回 null ⇒ 调用方退回单条行为（绝不在这里手写第二份构造逻辑）。
   注意：本函数**不**产生延迟、不排队、不发请求 —— 节奏仍由调用方既有的循环负责。 */
function _ibDeliveryCore(){
  try{return (typeof window!=='undefined')?window.IBDeliverySequence:null}catch(e){return null}
}
function _ibSequenceMessages(texts,ctx){
  var core=_ibDeliveryCore();
  if(!core||typeof core.buildMessages!=='function')return null;
  var c=ctx||{};
  var units=[];
  for(var i=0;i<(texts||[]).length;i++)units.push({kind:'text',text:String(texts[i]==null?'':texts[i])});
  if(!units.length)return null;
  var msgs=core.buildMessages({turnId:String(c.turnId||''),units:units},{
    friendId:c.friendId,role:'assistant',senderName:c.senderName,threadId:c.threadId,
    timestamp:c.timestamp,model:c.model,modelId:c.modelId,configId:c.configId,
    showThinking:c.showThinking,extraMetadata:c.extraMetadata
  });
  return (msgs&&msgs.length)?msgs:null;
}

/* ══════════ P24-M1 · Group Runtime identity 的**桌面 adapter** ══════════
   身份逻辑的**唯一实现** = assets/js/group-runtime-core.js（纯模块，Node 可测）：
     groupTurnIdFor / memberTurnIdFor / createIdentityContext / createMemberIdentity
     validateIdentityContext / validateMemberIdentity
   本区块只做两件事（与 _ibSequenceMessages 同一纪律）：
     ① 取模块（不复制任何 id 派生或校验规则）；
     ② 建 → 校验 → 通过才返回，否则 **null**，调用方据此退回 legacy 行为。
   为什么返回 null 而不是"尽力构造"：群身份一旦写进 canonical 消息就是事实，
   宁可这条消息没有身份（行为与 M1 之前一致），也不写入一个无法校验的身份。
   核心未加载（旧宿主 / 诊断页 / 测试沙箱）⇒ 同样是 null。 */
function _ibGroupCore(){
  try{return (typeof window!=='undefined')?window.IBGroupRuntime:null}catch(e){return null}
}
function _ibGroupIdentityContext(o){
  var core=_ibGroupCore();
  if(!core||typeof core.createIdentityContext!=='function'||typeof core.validateIdentityContext!=='function')return null;
  var ctx=null;
  try{ctx=core.createIdentityContext(o||{})}catch(e){return null}
  /* 校验本身出问题也按"没有身份"处理（fail closed 到 legacy 行为）——绝不把
     身份层的异常带进真实的发送链路。 */
  try{var verdict=core.validateIdentityContext(ctx);return (verdict&&verdict.ok===true)?ctx:null}catch(e){return null}
}
function _ibGroupMemberIdentity(ctx,speakerId,groupOrder){
  var core=_ibGroupCore();
  if(!ctx||!core||typeof core.createMemberIdentity!=='function'||typeof core.validateMemberIdentity!=='function')return null;
  var member=null;
  try{member=core.createMemberIdentity(ctx,speakerId,groupOrder)}catch(e){return null}
  try{var verdict=core.validateMemberIdentity(member);return (verdict&&verdict.ok===true)?member:null}catch(e){return null}
}

/* ══════════ P29-0 · Group member identity 退化的**诊断面**（只观测，不改语义）══════════
   `_gMember === null` 时该成员回合会退回"无 P24 身份"的单条构造 —— 那是 M1 既有的
   fallback 语义，本阶段**一字不改**（宁可少一条身份，也不写入无法校验的身份）。

   但它此前是**静默**的：运行期既看不到发生次数、也看不到原因，于是"身份丢了"与
   "本来就没有身份"无法区分（M2 的 UNKNOWN 永不 SELF 会让这条消息在后续回合里
   不再是该角色自己的话）。

   这里只加：一个稳定计数字典 + 一行闭集日志（**不含**正文 / id / 昵称 / 凭据），
   供诊断与测试断言。**绝不**写 metadata / DB / prompt —— 因此不是新 authority、
   不是新 store、不改变任何既有行为。 */
var _gIdentityDegraded=Object.create(null);
function _ibGroupIdentityDegraded(code){
  try{
    var k=String(code||'unknown');
    _gIdentityDegraded[k]=(_gIdentityDegraded[k]||0)+1;
    console.warn('[IB Group Identity] degraded | '+k+' | count='+_gIdentityDegraded[k]);
  }catch(e){}
  return false
}
function _ibGroupIdentityDegradedSnapshot(){
  var out={};
  try{Object.keys(_gIdentityDegraded).forEach(function(k){out[k]=_gIdentityDegraded[k]})}catch(e){}
  return out
}

/* ══════════ P24-M2 · Speaker identity 的**桌面 adapter** ══════════
   实现唯一 = assets/js/group-runtime-core.js 的
     resolveSpeakerId / classifyMessageForSpeaker / normalizeParticipants
   本区块只做两件事：
     ① 从 canonical 来源组装 participants —— groups.members 的 id（只读）+
        apiConfigs / archivedConfigs 的显示名；**不新建 participant registry**，
        也不把 senderName 升级成 participant authority；
     ② 转调并 fail closed。
   核心未加载 ⇒ 分类一律 'UNKNOWN'（**永不 SELF**）：不对称安全规则在退化路径上同样
   成立 —— 宁可少一条"自己的旧话"，也绝不把别人的话当成自己说过的。 */
function _ibGroupParticipants(memberIds){
  var out=[];
  (memberIds||[]).forEach(function(mid){
    var id=String(mid==null?'':mid);if(!id)return;
    var c=null;
    try{c=(apiConfigs||[]).find(function(a){return a.id===id})||null}catch(e){}
    if(!c){try{c=(typeof archivedConfigs!=='undefined'&&archivedConfigs?archivedConfigs.find(function(a){return a.id===id}):null)||null}catch(e){}}
    out.push({id:id,name:c?String(c.nickname||c.model||''):''});
  });
  return out;
}
function _ibGroupClassifyMessage(m,currentSpeakerId,participants){
  var core=_ibGroupCore();
  if(!core||typeof core.classifyMessageForSpeaker!=='function')return 'UNKNOWN';
  try{return String(core.classifyMessageForSpeaker(m,currentSpeakerId,participants)||'UNKNOWN')}catch(e){return 'UNKNOWN'}
}
/* P24-M3.2 · participation fail-closed 的**唯一**用户呈现 + 稳定日志码。
   只输出稳定 code 与计数（绝不含正文 / 昵称 / 凭据）；fail closed 时**不**回退 legacy
   speakingCfgs —— 双权威会重新引入 nickname 参与判定（M3 IDENTITY RISK）。 */
function _ibGroupParticipationFailClosed(code,detail){
  try{console.warn('[IB Group Participation] '+String(code||'unknown')+(detail==null?'':(' | '+String(detail).slice(0,80))))}catch(e){}
}

/* ══════════ P24-M3.5.2A · Dynamic Runtime State Foundation 的 feature gate ══════════
   默认关：本阶段不新增 storage / UI，生产默认走既有 static 路径（逐字不变）；
   测试可通过 window.IB_DYNAMIC_PARTICIPATION=true 打开 foundation（仍无任何 dynamic decision）。 */
const IB_DYNAMIC_PARTICIPATION_DEFAULT=false;
function _ibDynamicParticipationOn(){
  try{
    if(typeof window!=='undefined'&&typeof window.IB_DYNAMIC_PARTICIPATION==='boolean')return window.IB_DYNAMIC_PARTICIPATION===true;
  }catch(e){}
  return IB_DYNAMIC_PARTICIPATION_DEFAULT;
}

/* ══════════ P24-M3.3.1 · GroupTurn runtime state（**runtime-only**）══════════
   它只存在于内存：
     · 不进 DB / 不进 chatMessages metadata / 不进 prompt / 不进 P23；
     · 唯一用途：让"停止"能够阻止**尚未启动**的后续 entry（已完成的消息不受影响）；
     · 不新增任何 abort 原语 —— 当前正在执行的成员仍由既有 `_chatCallStates[..].ac` 中止。
   生命周期：created → planning → planned → executing → completed | cancelled
   （`completed` 只表示"该 GroupTurn 结束"；是否真的执行过成员由 startedCount 区分。）
   key = group id，与 `_chatSendingFor` / `_chatCallStates` 同一 key 空间。 */
var _gGroupTurnStates=Object.create(null);
function _ibGroupTurnBegin(groupId,groupTurnId){
  var st={groupTurnId:String(groupTurnId||''),status:'created',cancelled:false,cancelReason:'',
    plannedCount:0,startedCount:0};
  try{var k=String(groupId||'');if(k)_gGroupTurnStates[k]=st}catch(e){}
  return st;
}
function _ibGroupTurnEnd(groupId,st,terminal){
  try{
    if(st&&!st.cancelled&&terminal)st.status=String(terminal);
    var k=String(groupId||'');
    if(k&&_gGroupTurnStates[k]===st)delete _gGroupTurnStates[k];
  }catch(e){}
}
/* 唯一的 cancel 信号入口（由 stopStreaming 调用）：只翻标记，不改状态机 ——
   状态推进仍由生命周期自己完成（planning/planned/executing/cancelled）。 */
function _ibGroupTurnCancel(groupId,reason){
  try{
    var st=_gGroupTurnStates[String(groupId||'')];
    if(!st||st.cancelled)return false;
    st.cancelled=true;st.cancelReason=String(reason||'cancelled');
    return true;
  }catch(e){return false}
}

/* ══════════ P23 Phase 2B · Delivery Runtime 的**桌面 adapter** ══════════
   分层（单向依赖，见 docs/P23-2B-DELIVERY-RUNTIME.md）：
     delivery-sequence-core（结构：unit → canonical chatMessage[]）
       ↓
     delivery-runtime（时间与生命周期：队列 / 状态 / typing 开关 / cancel；零 DOM）
       ↓
     本区块（adapter：把"交付"落成真实动作 —— dbPut + appendChatBubble + 广播 + typing DOM）

   ── 为什么这里是唯一的交付入口 ─────────────────────────────────────
   一条 unit 只有在**被本区块交付**时才进入 conversation stream；未交付的 unit 只活在
   内存队列里，因此 provider context / Memory / Search / Middle Brain / Diary /
   Role Letters / Home Node dialogue 都不可能看到它（它们直接读 canonical store）。
   这一条是 Phase 2B 的硬验收线，靠结构成立而不是靠每个 consumer 各自过滤。

   ── persistence timing（本阶段的关键决定）────────────────────────────
   **每个 unit 到它的 delivery time 才 dbPut**（不预写、不留影子行）。理由见 runtime
   顶部注释：91 个读取点直接读 chatMessages，没有任何一处认识"投递队列"。
   reload / crash 语义因此天然正确：已交付的在库里，未交付的随页面消失（队列 ephemeral）。

   ── 幂等与顺序 ─────────────────────────────────────────────────────
   · 串行：runtime 保证同一时刻只有一个 unit 在飞（绝不交错、绝不重排）；
   · id 由 Phase 2A 的契约确定（turnId+index+timestamp 唯一决定）⇒ 重放同一条 queue
     会落到同一条记录（Home Node 判 identical ⇒ skipped），不会写第二份。 */
var _ibDeliveryRuntimeSingleton=null;
/* canonical conversation identity（**不是**裸 friendId）：唯一派生规则属于 chat-core。 */
function _ibConvId(friendId,threadId){
  try{
    var c=(typeof window!=='undefined')?window.IBChatCore:null;
    if(c&&typeof c.conversationIdOf==='function')return c.conversationIdOf(friendId,threadId);
  }catch(e){}
  return 'dm:'+String(friendId==null?'':friendId)+(threadId?('|'+String(threadId)):'');
}
/* ── P21-R2-E1a · ColdStart 会话信号探针（**latent**）──────────────────────────
   目的：给将来的 coldStart channel 提供"这是本会话第一轮"的**可靠**信号。
   本轮 orchestrator **不消费**它 ⇒ 用户可见召回语义与 R2-D 完全相同。

   判据：conversationId 可派生 && 该会话在 store 中**已有消息数 === 0**。

   三条刻意的设计约束：
     ① **必须在当前 user message 落库之前调用**。调用点放在 dbPut 之前；
        若放到之后，"0 条"永远不成立，coldStart 会静默失效。
     ② **不做封档过滤、不截窗口**。这里问的是"该会话是否存在任何消息"，
        而不是"这一页拿到几条"。封档(filterSealed)会把旧消息滤掉，
        那会让"有历史的会话"看起来是空的 ⇒ 误判成新会话。
     ③ **fail closed**：读失败 / 索引缺失 / 非数组 ⇒ isFirstTurn **false**。
        "读不到"绝不能等于"是新的"。 */
async function _ibProbeColdStartSignal(friendId,threadId){
  var _tid=String(threadId==null?'':threadId);
  var out={conversationId:null,isFirstTurn:false,conversationSignalAvailable:false};
  try{
    var cid=_ibConvId(friendId,_tid);
    if(!cid)return out;
    out.conversationId=cid;
    var rows=await dbGetByIndex('chatMessages','byFriend',friendId);
    if(!Array.isArray(rows))return out;
    /* 会话归属判据与全仓其他调用点**逐字一致**：
       threadId ? m.threadId===threadId : !m.threadId */
    var n=0;
    for(var i=0;i<rows.length;i++){
      var m=rows[i];if(!m)continue;
      if(_tid?String(m.threadId||'')===_tid:!m.threadId)n++;
    }
    out.isFirstTurn=(n===0);
    out.conversationSignalAvailable=true;
    return out;
  }catch(e){
    /* fail closed：读不到就**不**声称这是第一轮 */
    return out;
  }
}
/* ── P30-2 · Workspace 注入的会话归属 filter（WHERE）───────────────────────────
   契约（P30-1 冻结）：
     · item 声明了 `friendId`（非空）⇒ 只有 conversationIdOf(item.friendId,item.threadId)
       与当前会话相等时才可见/可消费；不同会话 ⇒ **留在队列**（不消费、不丢弃）；
     · item 没有 `friendId` ⇒ unscoped/legacy ⇒ 交给既有规则（actor / 首轮兜底），
       本 filter 一律放行（保持旧行为，绝不为了完整率强绑）；
     · 比较键只由 `_ibConvId`（= chat-core.conversationIdOf 的既有 adapter）产出，不在此复制派生逻辑。
   返回的谓词可直接交给 `_getWs*Injection(filterFn)` 的 take/keep 机制（非匹配项自然保留）。 */
function _ibWsScopeFilter(friendId,threadId){
  var cur=_ibConvId(friendId,threadId);
  return function(it){
    if(!it||!it.friendId)return true;
    return _ibConvId(it.friendId,it.threadId)===cur;
  };
}
/* R3 · media queue boundary
   Media queues are runtime-only, so scope must be checked immediately before a
   destructive take. Scoped objects use the existing P30 predicate; legacy bare
   strings/objects stay in the queue (fail closed) and are never assigned the
   current conversation. The partition is stable for both take and keep. */
function _ibTakeScopedMedia(queueName,filterFn){
  var list=[];try{list=Array.isArray(window[queueName])?window[queueName]:[]}catch(e){list=[]}
  var take=[],keep=[];
  list.forEach(function(item){
    var fid=(item&&typeof item==='object'&&typeof item.friendId==='string')?item.friendId.trim():'';
    if(!fid){keep.push(item);return}
    var ok=false;try{ok=typeof filterFn==='function'&&!!filterFn(item)}catch(e){ok=false}
    (ok?take:keep).push(item);
  });
  try{window[queueName]=keep}catch(e){}
  return take;
}
function _ibMediaPromptImage(raw,fallbackName){
  var u=typeof raw==='string'?String(raw):String((raw&&raw.dataUrl)||'');
  if(!u||u.slice(0,5)!=='data:')return null;
  var mime=typeof raw==='object'&&raw&&raw.mime?String(raw.mime):(((u.match(/^data:([^;,]+)/i)||[])[1])||'image/jpeg');
  var b64=typeof raw==='object'&&raw&&raw.base64?String(raw.base64):String(u.split(',')[1]||'');
  if(!b64)return null;
  return{dataUrl:u,base64:b64,mime:mime,name:(typeof raw==='object'&&raw&&raw.name?String(raw.name):String(fallbackName||'image_inject.png'))};
}
/* scope 只是**标注**（本阶段不实现任何群聊行为）：未来 Group Runtime 直接复用同一队列。 */
function _ibConvScope(friendId){
  try{
    var c=(typeof window!=='undefined')?window.IBChatCore:null;
    if(c&&typeof c.isGroupFriendId==='function')return c.isGroupFriendId(friendId)?'group':'single';
  }catch(e){}
  return String(friendId==null?'':friendId).indexOf('group_')===0?'group':'single';
}
/* 这条 unit 现在是否**看得见**（活动会话 + 同一 thread）——渲染与 typing 都要问它。
   与旧 waifu 循环只比 activeFriendId 相比，这里补上了 thread：否则用户在交付期间
   切到话题频道，主对话的后续单元会被追加进话题列表（真实缺陷）。 */
function _ibConvIsActive(friendId,threadId){
  try{
    if(String(activeFriendId||'')!==String(friendId||''))return false;
    var cur=(typeof activeThreadId==='undefined')?null:activeThreadId;
    if(String(cur||'')!==String(threadId||''))return false;
    return true;
  }catch(e){return false}
}
/* ── typing authority（唯一实现）──────────────────────────────────────
   既有 typing UI 就是 `div.chat-typing`（单聊 id = `chat-typing-<friendId>`），
   Phase 2B 让它在**交付期**也能开关，因此把创建/销毁收敛到这一对函数上：
     同一 class / 同一 id 约定 / 同一容器选择规则，只是文案分两种：
       mode:'thinking' → `名字 思考中…（N秒）`（生成期；与改动前逐字一致，含 1s 秒表）
       mode:'typing'   → `名字 正在输入…`（交付期；与 Cinema 文案同款，无秒表）
   单例：按 friendId 注册。绝不创建第二套 typing UI；Cinema 的 `.ci-typing` 由 turn
   广播驱动，与本函数无关，也不受影响。 */
var _ibTypingReg=Object.create(null);/* friendId → {el,timer} */
function _ibTypingOff(friendId){
  var key=String(friendId==null?'':friendId);
  var rec=_ibTypingReg[key];
  if(rec){
    if(rec.timer){try{clearInterval(rec.timer)}catch(e){}}
    try{if(rec.el&&rec.el.parentNode)rec.el.parentNode.removeChild(rec.el)}catch(e){}
    delete _ibTypingReg[key];
  }
  /* 兜底：DOM 里可能还留着别人创建的同类节点（例如失败路径），一并清掉。 */
  try{
    var id=key?('chat-typing-'+key):'';
    ['chat-full-messages','chat-messages'].forEach(function(cid){
      var box=document.getElementById(cid);if(!box)return;
      var nodes=box.querySelectorAll('.chat-typing');
      for(var i=0;i<nodes.length;i++){
        var el=nodes[i];
        /* 只清"本 authority 画出来的那一个"：id 命中或 data 标记命中。
           群聊路径自己创建的 `.chat-typing`（无 id / 无标记）**不在**本函数的辖区里，
           绝不能在单聊收尾时顺手把它删掉。 */
        if((id&&el.id===id)||el.dataset.ibTypingFriend===key)try{el.remove()}catch(e){}
      }
    });
  }catch(e){}
}
function _ibTypingOn(friendId,threadId,name,mode,roleId){
  try{
    if(!_ibConvIsActive(friendId,threadId))return null;      /* 只在活动会话里画 */
    var key=String(friendId==null?'':friendId);
    _ibTypingOff(key);                                        /* 单例：先清旧的（含秒表） */
    var el=document.createElement('div');
    el.className='chat-typing';
    if(key)el.id='chat-typing-'+key;
    el.dataset.ibTypingMode=(mode==='typing')?'typing':'thinking';
    el.dataset.activityState=el.dataset.ibTypingMode;
    el.dataset.ibTypingFriend=key;
    if(String(threadId||''))el.dataset.ibTypingThread=String(threadId);
    el.setAttribute('role','status');
    el.setAttribute('aria-live','polite');
    el.setAttribute('aria-atomic','true');
    var whoName=String(name||'').trim();
    if(!whoName)whoName=key.indexOf('group_')===0?'群聊成员':'AI';
    var who=esc(whoName);
    el.innerHTML=who+((mode==='typing')?' 正在输入…':' 思考中…<span class="typing-sec">（0秒）</span>');
    var elapsedEl=el.querySelector('.typing-sec');if(elapsedEl)elapsedEl.setAttribute('aria-hidden','true');
    var expressionRoleId=String(roleId||((key.indexOf('group_')===0)?'':key));
    var rec={el:el,timer:null,name:whoName,roleId:expressionRoleId};
    if(mode!=='typing'){
      var t0=Date.now();
      rec.timer=setInterval(function(){
        var sp=el.querySelector('.typing-sec');
        if(sp)sp.textContent='（'+Math.round((Date.now()-t0)/1000)+'秒）';
      },1000);
    }
    _ibTypingReg[key]=rec;
    var container=currentPage==='chat'?document.getElementById('chat-full-messages'):document.getElementById('chat-messages');
    if(container){container.appendChild(el);container.scrollTop=container.scrollHeight}
    if(expressionRoleId&&window.IBExpressionPacks&&typeof window.IBExpressionPacks.applyRoleState==='function'){
      try{window.IBExpressionPacks.applyRoleState(expressionRoleId,'typingExpression',el)}catch(expressionError){}
    }
    return el;
  }catch(e){return null}
}
/* 生成结束的收尾：把 typing 文案改成「名字（N秒）」，1200ms 后移除 —— 与改动前逐字同感，
   只是现在同时清掉注册表与秒表计时器（唯一的 typing 生命周期在这里收口）。 */
function _ibTypingFinish(friendId,name,t0){
  try{
    var key=String(friendId==null?'':friendId);
    var rec=_ibTypingReg[key];
    if(rec&&rec.timer){try{clearInterval(rec.timer)}catch(e){}rec.timer=null}
    var el=(rec&&rec.el)?rec.el:document.getElementById('chat-typing-'+key);
    delete _ibTypingReg[key];
    if(!el)return null;
    if(el.closest&&el.closest('#chat-full-messages')){try{el.remove()}catch(e){}return null}
    var secs=Math.max(0,Math.round((Date.now()-Number(t0||Date.now()))/1000));
    el.textContent=(name||'AI')+'（'+secs+'秒）';
    el.removeAttribute('role');el.removeAttribute('aria-live');el.removeAttribute('aria-atomic');
    delete el.dataset.activityState;delete el.dataset.ibTypingMode;
    el.style.animation='none';
    setTimeout(function(){try{if(el.parentNode)el.remove()}catch(e){}},1200);
    return el;
  }catch(e){return null}
}
/* runtime 单例：时间只能经注入的时钟流动（测试用 fake clock 覆盖 window.__ibDeliveryClock）。 */
function _ibDeliveryRuntime(){
  if(_ibDeliveryRuntimeSingleton)return _ibDeliveryRuntimeSingleton;
  try{
    var rt=(typeof window!=='undefined')?window.IBDeliveryRuntime:null;
    if(!rt||typeof rt.createDeliveryRuntime!=='function')return null;
    var clock=(typeof window!=='undefined'&&window.__ibDeliveryClock)?window.__ibDeliveryClock:null;
    _ibDeliveryRuntimeSingleton=rt.createDeliveryRuntime(clock?{
      now:clock.now,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout
    }:{});
  }catch(e){_ibDeliveryRuntimeSingleton=null}
  return _ibDeliveryRuntimeSingleton;
}
/* 交付一个 unit = 落库 + （可见时）渲染 + 广播。返回 false/抛错 ⇒ runtime 判 failed
   并停止剩余单元（已交付的一律保留）。 */
async function _ibDeliverUnit(queue,unit,index){
  var m=null;
  if(queue.lazyBuild){
    /* P23 Phase 2D · materialization path：voice unit 的音频在这一刻才合成（text unit 也一样，
       为了保持同一份前缀构造），然后由 Phase 2A 构造 canonical 消息。 */
    var built=await _ibBuildUnitAt(queue,unit,index);
    if(!built||built.ok!==true)return {ok:false,reason:String((built&&built.reason)||'build-failed')};
    m=built.message;
    m.reasoning_content=(index===0?(queue.thinkingText||''):'');
  }else{
    m=unit&&unit.message;
  }
  if(!m||!m.id)return {ok:false,reason:'no-message'};
  if(index===0&&queue.replyQuote){m.metadata=m.metadata||{};m.metadata.replyQuote=queue.replyQuote;}
  _ibPrepareExpressionMessage(m,queue.cfg,unit&&unit.expressionRef||null);
  _ibTypingOff(queue.friendId);                      /* typing OFF ⇒ message appears（§8） */
  try{await dbPut('chatMessages',m)}catch(e){return {ok:false,reason:'persist-failed'}}
  if(_ibConvIsActive(queue.friendId,queue.threadId)){
    try{
      appendChatBubble('ai',m.content,undefined,(index===0?(queue.thinkingText||undefined):undefined),m.id,undefined,undefined,undefined,(m.voice||undefined),queue.cfg,m,queue.quoteSources||[]);
    }catch(e){/* 渲染失败不回滚已落库的事实：消息已在 canonical store 里 */}
  }
  try{
    _ibAppBroadcast('message',{id:m.id,role:'assistant',content:m.content,
      senderName:queue.senderName||'',friendId:queue.friendId,threadId:queue.threadId,
      activityId:((m.metadata&&m.metadata.activityId)||undefined)});
  }catch(e){}
  return {ok:true};
}
/* 启动一次序列交付。units = [{kind,content,delivery?,message}]。
   返回 queue handle（无 runtime / 无单元 / 参数不全 ⇒ null，调用方必须退回单条行为）。 */
function _ibStartDelivery(opts){
  var o=opts||{};
  var rt=_ibDeliveryRuntime();
  if(!rt||!o.units||!o.units.length)return null;
  var conversationId=_ibConvId(o.friendId,o.threadId);
  var multi=(o.units.length>1);
  var queue={
    friendId:o.friendId,threadId:o.threadId||null,cfg:o.cfg,senderName:o.senderName||'',
    activityName:String(o.activityName||(o.cfg?(o.cfg.nickname||'AI'):(o.senderName||''))||(String(o.friendId||'').indexOf('group_')===0?'群聊成员':'AI')),
    thinkingText:o.thinkingText||'',
    turnId:String(o.turnId||''),        /* lazy 模式下由本对象构造 canonical 消息（2A 需要回合身份） */
    /* P23 2D · lazy（materialization）模式所需的本回合常量：voice unit 的音频要到 delivery
       time 才产生，因此 canonical 消息也只能那时构造（见 _ibBuildUnitAt）。timestamp 在这里
       固定一次，保证同一回合所有 unit 共享同一个时间戳（2A 的不变量）。 */
    lazyBuild:o.lazyBuild===true,
    units:o.units,                      /* lazy 模式需要按前缀回看已交付/正在交付的 unit（见 _ibBuildUnitAt） */
    quoteSources:o.quoteSources||[],     /* canonical sources for request-local quote cards only */
    replyQuote:o.replyQuote||null,
    timestamp:Number(o.timestamp)||Date.now(),
    model:String(o.model||''),modelId:String(o.modelId||''),configId:String(o.configId||''),
    showThinking:(typeof o.showThinking==='boolean')?o.showThinking:undefined,
    conversationId:conversationId,
    onUnit:function(unit,index){return _ibDeliverUnit(queue,unit,index)},
    onTyping:function(on){
      if(on)_ibTypingOn(queue.friendId,queue.threadId,queue.activityName,'typing',queue.cfg&&queue.cfg.id);
      else _ibTypingOff(queue.friendId);
    },
    onState:function(state,info){
      /* onState 只在**终结**状态被调用（runtime 的 finish()）：此刻交还发送按钮。
         "交付期间保持停止按钮可用"由下面的 _showStreamingUI(true) 在开始时完成。 */
      if(multi)try{_showStreamingUI(false)}catch(e){}
      try{
        _ibAppBroadcast('turn',{state:'end',friendId:queue.friendId,threadId:queue.threadId,
          activityId:o.activityId||undefined});
      }catch(e){}
    }
  };
  try{
    var handle=rt.enqueue({
      turnId:String(o.turnId||''),conversationId:conversationId,scope:_ibConvScope(o.friendId),
      units:o.units,onUnit:queue.onUnit,onTyping:queue.onTyping,onState:queue.onState
    });
    if(handle&&multi)try{_showStreamingUI(true)}catch(e){}
    return handle;
  }catch(e){return null}
}
/* 取消某会话仍在投递的剩余单元（已交付保留）。reason: user_interrupt / user_stop / superseded… */
function _ibDeliveryAbort(friendId,threadId,reason){
  var rt=_ibDeliveryRuntime();
  if(!rt||typeof rt.abort!=='function')return false;
  try{return rt.abort(_ibConvId(friendId,threadId),reason||'cancelled')}catch(e){return false}
}
function _ibDeliveryPending(friendId,threadId){
  var rt=_ibDeliveryRuntime();
  if(!rt||typeof rt.pending!=='function')return null;
  try{return rt.pending(_ibConvId(friendId,threadId))}catch(e){return null}
}
/* 回到一个"仍在 typing 阶段"的会话时，把 typing 重新画出来（面板重渲染会销毁 DOM）。
   只在活动会话里生效；不是第二套 typing UI，仍走 _ibTypingOn。 */
function _ibDeliveryTypingReassert(){
  try{
    var p=_ibDeliveryPending(activeFriendId,activeThreadId);
    if(!p||p.state!=='delivering'||!p.typing)return false;
    var rec=_ibTypingReg[String(activeFriendId||'')];
    _ibTypingOn(activeFriendId,activeThreadId,(rec&&rec.name)||(String(activeFriendId||'').indexOf('group_')===0?'群聊成员':'AI'),'typing',rec&&rec.roleId);
    return true;
  }catch(e){return false}
}

/* ══════════ P23 Phase 2D · Multimodal Delivery Policy 的**桌面 adapter** ══════════
   决策唯一实现 = assets/js/multimodal-delivery-policy.js（纯模块：零 DOM / 零 TTS / 零时间）。
   本区块只做三件事，且**不做任何模态判断**：
     ① 采集输入：capability（消毒视图）/ preference / intent / hint；
     ② 转调 policy.resolve()，并把逐条决策写进 policy 的 trace；
     ③ 在 **delivery time** 物化 voice 音频（TTS 只在这里、只在这一刻发生 —— 见下）。

   ── 为什么 TTS 在 delivery time，而不是 sequence 创建时 ─────────────
   若在创建序列时就把所有未来 voice 音频合成好，用户一旦 Stop / 插话 / 切走，
   那些音频的钱已经花了，与 Phase 2B 的「cancelled before materialization ⇒ 零请求」冲突。
   因此：policy 只决定"这一条是 voice unit"；音频在它**即将进入会话流**的那一刻才合成
   （runtime 的 onUnit 内），未交付的 unit 永远不会触发 TTS。

   ── 失败语义（§9）────────────────────────────────────────────────
   TTS 失败 ⇒ **确定性降级**为同内容 text unit（content 一字不改），原因写进 policy trace。
   绝不换 provider、绝不静默回落、绝不产生"文字 + 语音"两条消息。 */
function _ibMmPolicy(){
  try{return (typeof window!=='undefined')?window.IBMultimodalPolicy:null}catch(e){return null}
}
/* capability：**消毒视图**（策略层只看得到"能不能"，看不到任何凭据/端点）。
   离线可判定（enabled + voiceId + clone 参考音频），真实合成失败由物化步骤兜底降级。 */
function _ibVoiceCapability(cfg){
  var vc=(cfg&&cfg.voice&&typeof cfg.voice==='object')?cfg.voice:{};
  var enabled=vc.enabled===true;
  var type=String(vc.voiceType||'builtin');
  var voiceId=String(vc.voiceId||'');
  var refId=String((vc.voiceData&&vc.voiceData.refAudioId)||'');
  var reason='',available=false;
  if(!enabled)reason='voice-disabled';
  else if(type==='clone'&&!refId)reason='clone-reference-missing';
  else if(!voiceId)reason='voice-id-missing';
  else available=true;
  return { voice:{
    available:available, reason:reason,
    source:String(vc.source||vc.provider||''),
    provider:String(vc.provider||''),
    engine:String(vc.model||''),
    voiceId:voiceId,
    voiceType:type,
    model:String(vc.model||'')
  } };
}
/* 意图 / 偏好（§5/§6/§13/§14）——三者必须分开：
     intent.voice     显式意图（"这次用语音说"）。本阶段**没有 UI**，只有程序化接缝
                      window.__ibMultimodalIntent（诊断/测试/未来上层），UI 留后续阶段。
     preference.voice 角色配置里显式 opt-in（cfg.voice.replyDelivery==='voice'）——
                      本阶段也没有 UI 写入它，因此生产默认恒为 text。
     hints.preferVoice 上层（未来 Middle Brain）的**偏好**提示，不是命令。
   三者都只是**输入**；模态仍由 policy 决定（本函数不做任何判断）。 */
function _ibMmIntent(cfg,hints){
  var vc=(cfg&&cfg.voice&&typeof cfg.voice==='object')?cfg.voice:{};
  var seam=null;
  try{seam=(typeof window!=='undefined')?(window.__ibMultimodalIntent||null):null}catch(e){seam=null}
  return {
    intent:{ voice:!!(seam&&seam.voice===true) },
    preference:{ voice:String(vc.replyDelivery||'')==='voice' },
    hints:{ preferVoice:!!(hints&&hints.preferVoice===true) }
  };
}
/* 把 planner 的分段文本交给 policy（默认全 text；无 voice ⇒ 与 2A/2B 既有路径逐字同形）。 */
function _ibMmResolve(segments,cfg,meta){
  var P=_ibMmPolicy();
  if(!P||typeof P.resolve!=='function')return null;
  var m=meta||{};
  var units=[];
  for(var i=0;i<(segments||[]).length;i++)units.push({kind:'text',content:String(segments[i]==null?'':segments[i])});
  if(!units.length)return null;
  var inputs=_ibMmIntent(cfg,m.hints);
  var result=null;
  try{
    result=P.resolve(units,{
      turnId:m.turnId||'',conversationId:m.conversationId||'',
      capability:_ibVoiceCapability(cfg),
      intent:inputs.intent,preference:inputs.preference,hints:inputs.hints
    });
  }catch(e){return null}
  try{ if(typeof P.note==='function'&&result&&result.decisions)P.note(result.decisions,{turnId:m.turnId||'',conversationId:m.conversationId||''}); }catch(e){}
  return result;
}
/* voice 物化的唯一实现（**只在 delivery time 调用**）。
   复用 Phase 1 的单实现部件：IB.bridge.ttsPayload（payload 组装）、/api/tts、
   IB.bridge.fetchAiVoiceDataUrl（inline 上限判定）、IB.bridge.probeAudioDuration（真实时长）。
   只回"音频证据"（dataUrl/audioUrl/mime/duration/provenance）——canonical voice 对象由
   Phase 2A 的契约构造（本函数绝不自己拼 voice schema）。
   测试用注入接缝 window.__ibVoiceMaterializer（fake TTS adapter）覆盖，绝不调用真实 provider。 */
function _ibVoiceMaterializerSeam(){
  try{return (typeof window!=='undefined'&&typeof window.__ibVoiceMaterializer==='function')?window.__ibVoiceMaterializer:null}catch(e){return null}
}
async function _ibMaterializeVoiceUnit(content,cfg){
  var text=String(content==null?'':content);
  var seam=_ibVoiceMaterializerSeam();
  if(seam){
    try{
      var r=await seam({content:text,voice:(cfg&&cfg.voice)||{}});
      if(r&&r.ok===true&&r.audio)return {ok:true,audio:r.audio};
      return {ok:false,reason:String((r&&r.reason)||'materializer-empty').slice(0,40)};
    }catch(e){return {ok:false,reason:'materializer-threw'}}
  }
  try{
    var bridge=(typeof window!=='undefined'&&window.IB)?IB.bridge:null;
    if(!bridge||typeof bridge.ttsPayload!=='function'||typeof window.ibBridgeFetch!=='function'||typeof window.ibBridgeBase!=='function'){
      return {ok:false,reason:'tts-unavailable'};
    }
    var vc=(cfg&&cfg.voice&&typeof cfg.voice==='object')?cfg.voice:{};
    var payload=bridge.ttsPayload(vc,text);
    if(!payload)return {ok:false,reason:'tts-payload-empty'};
    var res=await window.ibBridgeFetch(window.ibBridgeBase()+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    var j=null;try{j=await res.json()}catch(e){j=null}
    if(!j||j.ok!==true||!j.url)return {ok:false,reason:'tts-failed'};
    var inline='';
    try{ if(typeof bridge.fetchAiVoiceDataUrl==='function')inline=String(await bridge.fetchAiVoiceDataUrl(String(j.url))||''); }catch(e){inline=''}
    var duration=Number(j.duration)||0;
    if(!duration&&typeof bridge.probeAudioDuration==='function'){
      try{duration=Number(await bridge.probeAudioDuration(inline||String(j.url)))||0}catch(e){duration=0}
    }
    return { ok:true,audio:{
      dataUrl:inline,audioUrl:String(j.url),mime:String(j.mime||''),duration:duration,
      provenance:{
        source:String(vc.source||vc.provider||''),
        provider:String(j.provider||vc.provider||''),
        engine:String(j.engine||vc.model||''),
        model:String(vc.model||''),
        voiceId:String(vc.voiceId||''),
        voiceType:String(vc.voiceType||'builtin'),
        refAudioId:String((vc.voiceData&&vc.voiceData.refAudioId)||'')
      }
    } };
  }catch(e){return {ok:false,reason:'tts-error'}}
}
/* 逐 unit 构造 canonical 消息（**materialization path** 专用）。
   为什么需要它：voice unit 的音频要到 delivery time 才有，而 Phase 2A 要求 voice unit
   在构造时就带可播放音源。于是这里按"前缀"构造：把已交付/正在交付的 unit（它们的音频都已物化）
   一起交给 2A，取最后一条 —— index / id / 回合身份仍然**只**由 2A 决定，adapter 绝不自己拼 id。
   只丢掉一个字段：`metadata.sequenceTotal`（前缀长度 ≠ 回合总数；2A 已声明它是 advisory、
   读取方以消息集合为准），绝不写一个错的数字进库。 */
async function _ibBuildUnitAt(queue,unit,index){
  var core=_ibDeliveryCore();
  if(!core||typeof core.buildMessages!=='function')return {ok:false,reason:'no-core'};
  var inputs=[];
  try{
    for(var i=0;i<=index;i++){
      var u=queue.units[i]||{};
      var content=String(u.content==null?'':u.content);
      if(String(u.kind)==='voice'){
        var audio=u.__audio||null;
        if(!audio){
          var got=await _ibMaterializeVoiceUnit(content,queue.cfg);
          if(!got.ok){
            /* §9 候选 B：确定性降级 —— 同内容 text unit，绝不换 provider、绝不静默。 */
            u.kind='text';
            u.__degraded=String(got.reason||'voice-unavailable');
            try{var P=_ibMmPolicy();if(P&&typeof P.note==='function')P.note([{unitIndex:i,requested:'voice',resolved:'text',reason:u.__degraded}],{turnId:queue.turnId,conversationId:queue.conversationId});}catch(e){}
            inputs.push({kind:'text',text:content});
            continue;
          }
          audio=got.audio;u.__audio=audio;
        }
        inputs.push({kind:'voice',text:content,dataUrl:audio.dataUrl,audioUrl:audio.audioUrl,mime:audio.mime,duration:audio.duration,provenance:audio.provenance});
      }else{
        inputs.push({kind:'text',text:content});
      }
    }
    var msgs=core.buildMessages({turnId:String(queue.turnId||''),units:inputs},{
      friendId:queue.friendId,role:'assistant',senderName:queue.senderName,threadId:queue.threadId,
      timestamp:queue.timestamp,model:queue.model,modelId:queue.modelId,configId:queue.configId,
      showThinking:queue.showThinking
    });
    if(!msgs||!msgs.length){
      /* 诊断：只打印**错误词表**（没有正文/凭据），与仓库既有 console 行同款。 */
      try{var _chk=core.validate({turnId:String(queue.turnId||''),units:inputs});console.warn('[Delivery2D] build empty',JSON.stringify((_chk&&_chk.errors)||[]).slice(0,160))}catch(e){}
      return {ok:false,reason:'build-failed'};
    }
    var msg=msgs[msgs.length-1];
    if(msg.metadata)delete msg.metadata.sequenceTotal;   /* advisory；前缀构造算不出总数，绝不写错值 */
    if(index===0&&queue.replyQuote){msg.metadata=msg.metadata||{};msg.metadata.replyQuote=queue.replyQuote;}
    return {ok:true,message:msg};
  }catch(e){
    /* 诊断行沿用仓库既有形态（console 一行、长度受限、绝不打印正文/凭据）。 */
    try{console.warn('[Delivery2D] build failed',String(e&&e.message||e).slice(0,120))}catch(_e){}
    return {ok:false,reason:'build-threw'};
  }
}

/* ══════════ 微信式社交小动作（v7）：AI 撤回 / 拍一拍（撤回） ══════════
   撤回 = 把该条 AI 消息内容改写为"【XX撤回了一条消息】"并重渲染（历史 content 已是文案，重载天然支持）。
   ① AI 自查撤回：消息里 @了自己 或 @了一个不存在的名字（@错人）→ 撤回自己这条；
   ② 拍一拍（撤回）：某 AI 上一条与当前高度相似（重复废话）→ 由触发者"拍一拍"撤回上一条。
   失败静默：任何检查异常都不影响消息本身。 */
function _chatCfgById(id){try{return (apiConfigs||[]).find(function(c){return String(c.id)===String(id)})||null}catch(e){return null}}
function _chatShouldWithdraw(content){
  try{
    const t=String(content||'');if(!t)return false;
    const self=_getActiveAiName()||'';
    if(self&&(t.indexOf('@'+self)!==-1||t.indexOf('＠'+self)!==-1))return true;/* @ 了自己 */
    const names=new Set((apiConfigs||[]).map(function(c){return String(c.nickname||c.model||'')}).filter(Boolean));
    const ats=t.match(/[@＠]([^\s@＠]+)/g)||[];
    for(const a of ats){const n=String(a).replace(/^[@＠]/,'').trim();if(n&&!names.has(n))return true}/* @ 了不存在的名字 */
    return false;
  }catch(e){return false}
}
async function _chatWithdrawMsg(msgId){
  try{
    const m=await dbGet('chatMessages',msgId);if(!m||m.withdrawn)return false;
    const who=m.senderName||(function(){const c=_chatCfgById(m.config_id);return c?(c.nickname||c.model||'AI'):'AI'})();
    m.content='【'+who+'撤回了一条消息】';
    m.withdrawn=true;m.withdrawnBy='self';
    if(m.images)delete m.images;if(m.wsSearches)delete m.wsSearches;if(m.memOps)delete m.memOps;
    /* P23 Phase 1.1：voice 与 images/wsSearches/memOps 同类 —— 撤回必须连带清除音频、
       文字稿与 provenance。否则撤回文本仍留在 voice.transcript、音频仍留在记录与导出里。
       统一走 IBVoiceMessage.dropVoice（生命周期原语，与续写/未来编辑路径共用同一份语义）。 */
    try{ if(window.IBVoiceMessage&&IBVoiceMessage.dropVoice){IBVoiceMessage.dropVoice(m)}else if(m.voice){delete m.voice} }catch(e){ if(m.voice)delete m.voice }
    await dbPut('chatMessages',m);
    try{document.querySelectorAll('.chat-msg[data-msg-id="'+msgId+'"]').forEach(function(el){el.remove()})}catch(e){}
    _chatRefreshReplyQuotesForTarget(msgId);
    if(activeFriendId===String(m.friendId||'')){
      const mcfg=_chatCfgById(m.config_id);
      appendChatBubble('ai',m.content,m.senderName,undefined,msgId,undefined,undefined,undefined,undefined,mcfg);
    }
    return true;
  }catch(e){return false}
}
/* ② 拍一拍（撤回）：上一条同发送者消息与当前高度相似 → 撤回上一条并由触发者提示 */
async function _maybePatWithdraw(cfg,curMsgId){
  try{
    if(!cfg||!curMsgId)return false;
    const cur=await dbGet('chatMessages',curMsgId);if(!cur)return false;
    const hist=filterSealed(_ibOrderMessages(await dbGetByIndex('chatMessages','byFriend',cur.friendId)),0);/* P23 2A：canonical 顺序（"上一条"必须是真实的上一条） */
    let prev=null;
    /* P29-0：找"上一条同发送者"也是 ownership 判断 ⇒ 走同一个 canonical 分类器
       （单聊只有当前角色一个参与者，因此 legacy 的名字回退仍是唯一精确匹配）。 */
    const _patParts=[{id:String(cfg.id||''),name:String(cur.senderName||cfg.nickname||cfg.model||'')}];
    for(let i=hist.length-1;i>=0;i--){
      const x=hist[i];
      if(!x||x.id===curMsgId||x.role!=='assistant')continue;
      if(_ibGroupClassifyMessage(x,cfg.id,_patParts)!=='SELF')continue;
      prev=x;break
    }
    if(!prev||prev.withdrawn)return false;
    const sim=(typeof _activeTextSimilarity==='function')?_activeTextSimilarity(String(cur.content||''),String(prev.content||'')):0;
    if(sim<0.75)return false;/* 不算重复废话 */
    const patBy=cfg.nickname||cfg.model||'AI';
    const who=cur.senderName||'';
    if(await _chatWithdrawMsg(prev.id)){
      const noteId='msg_'+Date.now()+'_p'+Math.floor(Math.random()*100000);
      const note={id:noteId,role:'assistant',content:'【'+patBy+'拍了拍'+who+'，因重复发言已撤回】',senderName:patBy,metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,pat:true},friendId:cur.friendId,timestamp:Date.now()+1};
      await dbPut('chatMessages',note);
      if(activeFriendId===String(cur.friendId||''))appendChatBubble('ai',note.content,patBy,undefined,noteId,undefined,undefined,undefined,undefined,cfg);
      return true;
    }
    return false;
  }catch(e){return false}
}
window._chatShouldWithdraw=_chatShouldWithdraw;
window._chatWithdrawMsg=_chatWithdrawMsg;
window._maybePatWithdraw=_maybePatWithdraw;
/* 模型自主撤回（v7.1）：回复含 <withdraw/> → 提取标签 + 撤回自己上一条（像 AI 自己意识到说错话） */
function _extractWithdraw(text){
  try{
    const t=String(text||'');const m=t.match(/<\s*withdraw\s*\/?\s*>/i);
    if(m){return{clean:(t.slice(0,m.index)+t.slice(m.index+m[0].length)).replace(/^\s*\n/,'').trim(),withdraw:true}}
    return{clean:t,withdraw:false};
  }catch(e){return{clean:String(text||''),withdraw:false}}
}
/* ── P29-0 · Identity Read-Path Closure：撤回目标的选择 = **ownership 判断** ────────────
   旧实现用 `x.senderName === senderName` 找"我上一条"。两个角色同名时，A 撤回自己的话
   会命中 B 的消息（审计已证明）。

   现在唯一判定入口 = 已有的 canonical身份分类器 `_ibGroupClassifyMessage`
   （内部走 M2 `resolveSpeakerId`：`metadata.speakerId` 优先；缺失才回退"唯一精确显示名"；
   歧义 / 非法 / 非本群 / resolver 缺席 ⇒ UNKNOWN ⇒ **永不判 SELF**）。

   参与者来源（不新建 authority）：
     · 群聊：调用方传入本轮**已有的** participants 列表（`_gParticipants`，来自 groups.members）；
     · 单聊：只有当前角色一个参与者（该会话的 assistant 行只可能属于它），
       因此 legacy 的名字回退在这里仍然是**唯一精确匹配**，历史数据行为不变。
   senderName 仍然参与 UI 文案与 legacy 显示，但不再参与"这是不是我上一条"的判定。 */
async function _chatWithdrawSelf(cfg,friendId,senderName,participants){
  try{
    if(!cfg||!friendId)return false;
    const hist=filterSealed(_ibOrderMessages(await dbGetByIndex('chatMessages','byFriend',friendId)),0);/* P23 2A：canonical 顺序 */
    const _parts=(Array.isArray(participants)&&participants.length)
      ?participants
      :[{id:String(cfg.id||''),name:String(senderName||'')}];
    for(let i=hist.length-1;i>=0;i--){
      const x=hist[i];
      if(!x||x.role!=='assistant'||x.withdrawn)continue;
      if(_ibGroupClassifyMessage(x,cfg.id,_parts)!=='SELF')continue;   /* canonical id 判定；歧义 ⇒ UNKNOWN ⇒ 跳过 */
      return await _chatWithdrawMsg(x.id)
    }
    return false;
  }catch(e){return false}
}
/* 统一收尾：若回复文本含 <withdraw/> → 清标签 + 撤回自己上一条；返回清理后的文本。
   participants 由群聊调用方透传（单聊省略 ⇒ 只认当前角色一个参与者）。 */
async function _applyWithdraw(cfg,text,friendId,senderName,participants){
  try{
    const w=_extractWithdraw(text);
    if(w.withdraw){await _chatWithdrawSelf(cfg,friendId,senderName,participants);return w.clean}
    return text;
  }catch(e){return text}
}
const _WITHDRAW_INSTR_BLOCK='\n\n【撤回】如果你意识到自己上一条消息说错了话（比如 @ 错了人、说错了事实、刚刚的语气不对），可以在本条回复里输出 <withdraw/>，系统会撤回你上一条消息并提示"XX撤回了一条消息"。只有确实说错时才用，不要频繁使用。';
window._extractWithdraw=_extractWithdraw;
window._chatWithdrawSelf=_chatWithdrawSelf;
window._applyWithdraw=_applyWithdraw;
/* P29-0 · 身份退化诊断快照（只读，透明面；非 authority、无持久化） */
window._ibGroupIdentityDegradedSnapshot=_ibGroupIdentityDegradedSnapshot;

/* ════ P21 · 统一思考深度（reasoningEffort）消费缝 ════
   canonical 值唯一来源 = Middle Brain 配置（IB.middleBrain.middleBrainReasoningEffort）：
     · Middle Brain 未启用 / 读取失败 → 'auto'（= 一个字段都不发，绝不注入）
     · 本层**不做任何 provider 判断**：canonical 值只透传；翻译只发生在 provider request
       builder（IBModelCore.applyReasoningEffort → provider-directory.js 的 P21 能力表）。
   为什么在这里读：callApiChat* 是浏览器侧所有角色模型调用（角色聊天 / 日记 / 主动消息 /
   朋友圈 / 工具轮）的唯一收口，读一次即统一，不在每个 consumer 各写一份。
   与 Speed/service_tier 严格分离：本缝只碰 reasoning，绝不写 service_tier（反之亦然）。 */
async function _mbReasoningEffortForRequest(){
  try{
    var f=(window.IB&&window.IB.middleBrain)||null;
    if(f&&typeof f.middleBrainReasoningEffort==='function')return String((await f.middleBrainReasoningEffort())||'auto');
  }catch(e){}
  return 'auto';
}
/* provider request builder 边界唯一翻译入口（薄封装，零 provider 知识）。 */
function _ibApplyReasoningEffort(bodyObj,format,cfg,opts,maxTok){
  try{
    var core=(typeof window!=='undefined')?window.IBModelCore:null;
    if(!core||typeof core.applyReasoningEffort!=='function')return null;
    return core.applyReasoningEffort(bodyObj,{provider:(cfg&&cfg.provider)||'',model:(cfg&&cfg.model)||''},
      {format:format,effort:(opts&&opts.reasoningEffort)||'auto',maxTokens:maxTok,consumer:String((opts&&opts._ibConsumer)||''),
       characterId:String((opts&&opts._ibCharacterId)||''),threadId:String((opts&&opts._ibThreadId)||'')});
  }catch(e){return null}
}
/* 实际 reasoning tokens 只读回填（观测用：读不到就是 null，绝不伪造成 0）。
   不参与 token 记账 —— 记账口径（i/cr/cw/o）保持原样。 */
function _ibNoteReasoningUsage(usage,format,cfg,opts){
  try{
    var core=(typeof window!=='undefined')?window.IBModelCore:null;
    if(!core||typeof core.reasoningTokensFromUsage!=='function'||typeof core.noteReasoningTokens!=='function')return null;
    var n=core.reasoningTokensFromUsage(usage,format);
    if(n==null)return null;
    return core.noteReasoningTokens(n,{consumer:String((opts&&opts._ibConsumer)||''),provider:(cfg&&cfg.provider)||'',model:(cfg&&cfg.model)||'',
      characterId:String((opts&&opts._ibCharacterId)||''),threadId:String((opts&&opts._ibThreadId)||'')});
  }catch(e){return null}
}

/* ── P11-3D.1：单回合工具执行周期（宿主侧唯一入口）─────────────────────
   一个宿主 AI 回合 = 一个 guard cycle。owner 是 turn（上面 _ibTurnScope 建的那个），
   不是这里的调用者：模型调用入口只是"周期被激活的判定点"。
   P11-3D 时期 begin/end 都挂在 callApiChat* 上，于是周期在 callApiChatStream
   返回时就被收掉，而 XML 批次与续轮都发生在那一刻之后 —— 见文件顶部的不变量说明。 */
/* 工具块真的激活这个回合时调用（**必须**在 try 之外：它是安全调用，不得被任何异常跳过）。 */
function _toolCycleBegin(fcCtx,turn){
  try{
    if(typeof IBFC==='undefined' || typeof IBFC.cycleBegin!=='function')return
    /* 只有 turn 的 owner 有资格开周期；继承者（nested call / XML 续轮）在这里
       只是把 turn 上已有的实例绑到自己的 ctx 上，cycleBegin 内部按 ownsCycle 区分。
       FC 未激活（fcCtx 为空/非活动）时不开周期 —— 纯文本回合不占任何额度。 */
    IBFC.cycleBegin(fcCtx,null,turn);
  }catch(e){}
}
/* 收尾：只有宿主回合自己拥有周期，因此只有它带 _lc 时才收。
   幂等由 _ibTurnLc 保证（end 一次），且 cycleEnd 自身对"没有周期"返回 null。 */
function _toolCycleEnd(fcCtx,turnB){
  try{
    if(!turnB)return
    if(turnB.lc)turnB.lc.end();          /* 隐式回合（没有宿主）→ 本调用自己就是 owner */
  }catch(e){}
}
/* provider 调用前的轮预算询问（第 2 轮起）。拒绝 = 熔断 → 停止 provider 循环。
   emit 必须传**本回合的输出流**：熔断原因要出现在用户与诊断都能看到的那条通道上，
   用 console.warn 顶替它会让"原因只存在于控制台"（本次开发真实踩到过）。
   P11-3D.1：额度取自**本回合自己的实例**（ctx._ibTurn.guard）—— 全局指针在并发
   回合里可能指向别人的周期，拿它询问会把本次 provider 调用记进别人的额度。 */
/* 本回合的 guard 实例：口径与 IBFC.runRound 完全一致 ——
   ① 本回合 turn 上记着的那个（唯一事实源）；② 该 ctx 已经绑上的那个；③ 全局指针
   （只在前两者都拿不到时兜底，例如非 FC 调用面上的诊断读取）。
   **绝不**用"当前活动的周期"反推归属。 */
function _ibGuardOfCtx(fcCtx){
  try{
    var t=fcCtx&&fcCtx._ibTurn;
    /* 有本回合：只认它自己的实例。本回合还没开周期 → null（= 不介入），
       绝不回落到全局指针 —— 那会把本次询问记进**别人**的周期。 */
    if(t)return (t.guard&&typeof t.guard.beforeCall==='function')?t.guard:null;
    var bound=fcCtx&&fcCtx._guard;
    if(bound&&typeof bound.beforeCall==='function')return bound;
    if(typeof IBFC!=='undefined'&&typeof IBFC._syncGuardPolicy==='function')return IBFC._syncGuardPolicy();
  }catch(e){}
  return null;
}
function _roundBudgetAllows(fcCtx,emit){
  try{
    if(!fcCtx || !fcCtx.active)return true
    const g=_ibGuardOfCtx(fcCtx);
    if(!g)return true
    const d=g.beforeCall('__round__',null,{kind:'round'});
    if(d&&d.allowed)return true
    if(typeof IBFC._trip==='function')IBFC._trip(d&&d.reason||'round-budget-exhausted',fcCtx,emit)
    return false
  }catch(e){return true}
}
/* FC 端点回落/参数回落重试（round--/continue）：不得绕过总预算，也不得无限重试 */
function _fcRetryAllowed(fcCtx){
  try{
    if(!fcCtx || !fcCtx.active)return true
    const g=_ibGuardOfCtx(fcCtx);
    if(!g)return true
    const d=g.beforeCall('__retry__',{round:fcCtx.round||0},{kind:'retry'});
    return !!(d&&d.allowed)
  }catch(e){return true}
}

/* ── P11-3D.1 · 模型调用入口的周期接线 ────────────────────────────────
   模型调用**不是**周期 owner：宿主回合才是。这里只做两件事：
     ① 有宿主回合（opts._ibTurn）→ 把该 turn 记到 FC ctx 上（ctx._ibTurn），
        于是这个 ctx 的活跃性与周期归属都指向同一个 turn；**不开周期、不收周期**；
     ② 没有宿主回合（诊断/设置向导/摘要等直接调用者）→ 本调用**自己就是那个回合**：
        自建一个 turn 并在本函数 finally 里收尾（等价于单调用回合），
        这样"没有宿主回合时工具照样被预算约束"，而不是回到无人裁定的旧态。
   两种情形都只有一个周期、一份预算 —— 这正是不变量在非宿主调用面上的落地。 */
function _ibModelCallTurn(opts){
  var t=_ibTurnOf(opts);
  if(t)return {turn:t,lc:null};
  /* 隐式回合的标签是**静态**的：刻意不去读 opts._ibConsumer —— 审计身份键只允许
     出现在 callApiChat* 的 opts 与 runtime 桥接里（tests/test_frontend_structure.js
     的 cacheAudit.metadataNeverInProviderBody 守的就是这条线：诊断身份不得渗进
     请求构造路径）。turn 标签只是本地读数的名字，不需要那个身份。 */
  var lc=_ibTurnLc(_ibTurnScope('model-call'));
  lc.begin();
  return {turn:lc.turn(),lc:lc};
}
function _ibBindTurn(fcCtx,turn){
  if(!fcCtx||!turn)return fcCtx;
  fcCtx._ibTurn=turn;
  if(turn.guard)fcCtx._guard=turn.guard;
  return fcCtx;
}

/* Transient provider recovery is bounded and stays on the already selected route.
   A stream is retried only before the current provider attempt has emitted text/thinking. */
function _ibProviderErrorCategory(error){
  try{if(window.IBERR&&typeof window.IBERR.classify==='function')return window.IBERR.classify(error)}catch(e){}
  if(error&&error.ibCat)return String(error.ibCat);
  if(error&&error.name==='AbortError')return 'timeout';
  return 'unknown';
}
function _ibProviderRetryLimit(error){
  var category=_ibProviderErrorCategory(error);
  if(category==='timeout')return 1;
  return category==='network'||category==='rate_limit'||category==='provider'?2:0;
}
function _ibProviderRetryDelay(error,retryIndex){
  var backoff=Math.min(4000,400*Math.pow(2,Math.max(0,retryIndex-1)));
  var retryAfter=Math.max(0,Number(error&&error.retryAfterMs)||0);
  return Math.min(15000,Math.max(backoff,retryAfter));
}
async function _ibWaitForProviderRetry(delayMs,opts){
  var end=Date.now()+Math.max(0,Number(delayMs)||0);
  while(Date.now()<end){
    var st=opts&&opts._st;
    var external=opts&&opts.abortController&&opts.abortController.signal;
    if((st&&(st.stopped||st.abortReason==='user_stop'))||(external&&external.aborted))return false;
    await new Promise(function(resolve){setTimeout(resolve,Math.min(100,Math.max(1,end-Date.now())))});
  }
  var finalState=opts&&opts._st;
  var finalSignal=opts&&opts.abortController&&opts.abortController.signal;
  return !((finalState&&(finalState.stopped||finalState.abortReason==='user_stop'))||(finalSignal&&finalSignal.aborted));
}
function _ibProviderHttpError(response,body){
  var status=Number(response&&response.status)||0;
  var error=new Error(status+': '+String(body||''));
  if(status)error.status=status;
  try{
    var raw=response&&response.headers&&response.headers.get('retry-after');
    if(raw){
      var seconds=Number(raw),delay=isFinite(seconds)?seconds*1000:(Date.parse(raw)-Date.now());
      if(isFinite(delay)&&delay>0)error.retryAfterMs=Math.min(15000,delay);
    }
  }catch(e){}
  return error;
}
function _ibStoppedRetryError(){var error=new Error('已停止');error.ibCat='aborted';return error}

async function callApiChatStream(cfg,messages,opts){
  opts=Object.assign({},opts||{},{reasoningEffort:await _mbReasoningEffortForRequest()});
  var budget=opts.maxTokens||_chatMaxTokens(cfg);
  var maxRounds=opts.autoContinue?(opts.maxContinues!=null?opts.maxContinues:_maxContinuesPref):0;
  var userChunk=opts.onChunk||function(){};
  /* ── P21-R2-F1b · cooldown exposure 的 Browser success seam ─────────
     契约：流式在 **first token / stream open** 写一次；非流式在成功返回前写一次。
     为什么包在这里：内部 retry loop 就在本函数里（round++），per-attempt 钩子会
     每次 retry 都写。本包装位于循环**之外**，并用一次标志位保证
     **每个 logical turn 恰好一次**：
       · 前一 attempt 在首 token 前失败 ⇒ 成功那次的 first token 写一次；
       · 前一 attempt 已出 token 后失败 ⇒ 标志位已置，不再写第二次。
     数据来源是 runtime turn 对象上的 memoryExposure（**最终注入** ids）——
     绝不使用 reinforcementIds，也绝不落库。 */
  var _ibExpFired=false;
  var _ibUserChunkRaw=userChunk;
  userChunk=function(ch){
    if(!_ibExpFired){
      _ibExpFired=true;
      try{
        var _et=opts&&opts._ibTurn;
        var _ex=(_et&&_et._ibRecallAuthority!=='SERVER')?(_et&&_et.memoryExposure):null;
        if(_ex&&typeof window!=='undefined'&&typeof window._ibRecordRecallExposure==='function'){
          window._ibRecordRecallExposure(_ex);
        }
      }catch(e){}
    }
    return _ibUserChunkRaw.apply(this,arguments);
  };
  var full='',thinkAcc='',msgs=messages,tokRetries=0,tokenParam=_tokParamGet(cfg),providerRetries=0;
  var st=_newCallState(opts);/* 并发隔离：本次调用的独立状态（思考/结束原因/停止/可中止句柄），按 chatKey 注册供停止按钮定位 */
  /* FC：原生函数调用（anthropic/openai 走 tools 参数；无工具块/开关关/其他厂商 → 不激活，回落 XML 通道） */
  var _fcCtx=null;
  var _turnB=_ibModelCallTurn(opts);
  try{if(!opts.disableTools&&typeof IBFC!=='undefined'){var _fcv=IBFC.prepare(messages,_providerFormat(cfg),{vision:_usesNativeDeepSeekVision(cfg)||(cfg.vision!==undefined?!!cfg.vision:true)});if(_fcv&&_fcv.active){_fcCtx=_ibBindTurn(_fcv,_turnB.turn);msgs=_fcCtx.messages}}}catch(e){_fcCtx=null}
  /* P11-3D.1：周期**不在这里开**。工具块真的激活这个回合时，cycleBegin 由
     _toolCycleBegin 调一次，owner 是宿主回合（或上面那个隐式回合）。
     放在 try 之外是有意的：周期归零不得被任何异常跳过。 */
  _toolCycleBegin(_fcCtx,_turnB.turn);
  try{/* 并发隔离：任何退出路径都在函数尾 finally 注销本对话的调用状态 */
  for(var round=0;;round++){
    /* P11-3D：第 2 轮起的每次 provider 调用都要先过总轮预算 —— 这是
       `continue` 无法绕过的位置（它在循环体最前，先于任何续跑路径）。 */
    if(round>0&&!(_roundBudgetAllows(_fcCtx,userChunk)))break;
    var hold='',holding=round>0;/* 续写轮先缓冲开头，做接缝去重后再上屏 */
    var o=Object.assign({},opts,{maxTokens:budget});
    o._st=st;/* 并发隔离：单次调用把思考/结束原因写进本调用的状态对象 */
    if(tokenParam)o.tokenParam=tokenParam;
    if(_fcCtx)o._fcCtx=_fcCtx;
    if(round>0){
      o.wantThinking=false;
      o.onChunk=function(ch){
        if(!holding){userChunk(ch);return}
        hold+=ch;
        if(hold.length>=500){var d=_wsDedupSeam(full,hold);holding=false;hold='';if(d)userChunk(d)}
      };
    }
    var _attemptProgress=false,_attemptStartedAt=Date.now();
    var _attemptChunk=o.onChunk||function(){},_attemptThink=o.onThink||function(){};
    o.onChunk=function(ch){if(ch)_attemptProgress=true;return _attemptChunk(ch)};
    o.onThink=function(ch){if(ch)_attemptProgress=true;return _attemptThink(ch)};
    var _traceId=String(opts._ibTraceId||(opts._ibTurn&&opts._ibTurn.traceId)||'');
    var _attemptNo=providerRetries+1;
    _ibTurnTraceEvent(_traceId,'model_call_started',{provider:cfg.provider,model:cfg.model,format:_providerFormat(cfg),attempt:_attemptNo});
    var piece='';
    try{piece=await _callApiChatStreamOnce(cfg,msgs,o)}
    catch(e){
      var _providerCategory=_ibProviderErrorCategory(e);
      var _providerStatus=0;try{_providerStatus=Number(window.IBERR&&window.IBERR.statusOf?window.IBERR.statusOf(e):e.status)||0}catch(_statusError){}
      _ibTurnTraceEvent(_traceId,'model_call_finished',{provider:cfg.provider,model:cfg.model,format:_providerFormat(cfg),attempt:_attemptNo,
        status:'failed',latencyMs:Date.now()-_attemptStartedAt,httpStatus:_providerStatus||null,errorCategory:_providerCategory});
      if(e&&e.code==='CREDENTIAL_UNAVAILABLE')throw _ibCredentialUnavailable();
      var _retryLimit=_ibProviderRetryLimit(e);
      if(!_attemptProgress&&providerRetries<_retryLimit){
        providerRetries++;
        var _retryDelay=_ibProviderRetryDelay(e,providerRetries);
        _ibTurnTraceEvent(_traceId,'model_call_retry',{provider:cfg.provider,model:cfg.model,attempt:providerRetries+1,
          retryCount:providerRetries,retryDelayMs:_retryDelay,errorCategory:_providerCategory,httpStatus:_providerStatus||null});
        if(!await _ibWaitForProviderRetry(_retryDelay,Object.assign({},opts,{_st:st})))throw _ibStoppedRetryError();
        if(st.abortReason==='timeout'||st.abortReason==='heartbeat')st.abortReason='';
        round--;continue;
      }
      /* 联网搜索：报错明确指向搜索工具 → 只去掉搜索重试，保留原生 FC */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&/web_search|google_search/i.test(String(e&&e.message||e))){providerRetries=0;opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* FC：端点不认 tools 参数 → 关掉 FC 原样重试一次（回落 XML 通道） */
      if(_fcCtx&&round===0&&!full&&/tool/i.test(String(e&&e.message||e))){providerRetries=0;_fcCtx=null;msgs=messages;round--;continue}
      /* 联网搜索：端点不认搜索参数(4xx 且非鉴权错) → 去掉搜索原样重试一次 */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!IBWS.blocked(cfg)&&IBWS.errLooksParam(e)){providerRetries=0;opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* ① 新款 OpenAI 系模型要求 max_completion_tokens：换参数名原额重试（不降额） */
      if(!tokenParam&&round===0&&_errWantsCompletionParam(e)&&_fcRetryAllowed(_fcCtx)){providerRetries=0;tokenParam='max_completion_tokens';_tokParamRemember(cfg);round--;continue}
      /* ② 输出上限超过该模型/中转允许值：优先用报错里给的建议值一步到位，否则减半（下限1024），最多3次 */
      if(round===0&&tokRetries<3&&budget>1024&&_errLooksMaxTok(e)&&_fcRetryAllowed(_fcCtx)){
        providerRetries=0;
        tokRetries++;
        var _sug=_extractSuggestedMaxTok(e);
        budget=(_sug&&_sug<budget)?_sug:Math.max(1024,Math.floor(budget/2));
        round--;continue;
      }
      if(round>0&&full){_lastApiReasoning=thinkAcc;if(opts.result){opts.result.reasoning_content=thinkAcc;opts.result.truncated=_finishIsTrunc(st.finish)}return full}/* 续写失败不丢已有内容 */
      throw e;
    }
    _ibTurnTraceEvent(_traceId,'model_call_finished',{provider:cfg.provider,model:cfg.model,format:_providerFormat(cfg),attempt:_attemptNo,
      status:(st.abortReason==='timeout'||st.abortReason==='heartbeat')?'partial':'success',latencyMs:Date.now()-_attemptStartedAt,
      resultChars:String(piece||'').length,finishReason:st.finish||''});
    providerRetries=0;
    if(round>0){
      piece=_wsDedupSeam(full,piece);
      if(holding){holding=false;hold='';if(piece)userChunk(piece)}
    }
    full+=piece;
    if(st.think)thinkAcc+=(thinkAcc?'\n':'')+st.think;
    /* FC：本轮出现原生工具调用 → 立即执行、结果接回对话，续跑下一轮；需确认时转普通标签走原流程 */
    if(_fcCtx&&!st.stopped){
      try{
        var _fcr=await IBFC.runRound(_fcCtx,piece,function(t){userChunk(t);full+=t});
        if(_fcr&&_fcr.done===false){msgs=_fcCtx.messages;continue}
      }catch(e){}
    }
    var truncated=_finishIsTrunc(st.finish);
    if(!truncated||round>=maxRounds||st.stopped)break;
    msgs=((_fcCtx&&_fcCtx.messages)||messages).concat([{role:'assistant',content:full},{role:'user',content:_WS_CONT_PROMPT}]);
  }
  _lastApiReasoning=thinkAcc;
  if(opts.result){opts.result.reasoning_content=thinkAcc;opts.result.truncated=_finishIsTrunc(st.finish)}
  return full;
  }finally{_endCallState(st);_toolCycleEnd(_fcCtx,_turnB)}
}

/* 非流式：同样的包装策略 */
async function callApiChat(cfg,messages,opts){
  opts=Object.assign({},opts||{},{reasoningEffort:await _mbReasoningEffortForRequest()});
  var budget=opts.maxTokens||_chatMaxTokens(cfg);
  var maxRounds=opts.autoContinue?(opts.maxContinues!=null?opts.maxContinues:_maxContinuesPref):0;
  var timeoutMs=opts.timeoutMs||(opts.autoContinue?300000:0);/* 长输出给足等待时间 */
  var full='',thinkAcc='',msgs=messages,tokRetries=0,tokenParam=_tokParamGet(cfg),lastTrunc=false,providerRetries=0;
  var st=_newCallState(null);/* 并发隔离：仅用于按调用隔离思考/结束原因；非流式没有停止入口，不注册停止路由（与原行为一致） */
  /* FC：原生函数调用（与流式同一套；无工具块/开关关/其他厂商 → 不激活） */
  var _fcCtx=null;
  var _turnB=_ibModelCallTurn(opts);
  try{if(!opts.disableTools&&typeof IBFC!=='undefined'){var _fcv=IBFC.prepare(messages,_providerFormat(cfg),{vision:_usesNativeDeepSeekVision(cfg)||(cfg.vision!==undefined?!!cfg.vision:true)});if(_fcv&&_fcv.active){_fcCtx=_ibBindTurn(_fcv,_turnB.turn);msgs=_fcCtx.messages}}}catch(e){_fcCtx=null}
  /* P11-3D.1：同上（非流式路径）—— 周期归零在 try 之外。 */
  _toolCycleBegin(_fcCtx,_turnB.turn);
  try{/* 并发隔离：任何退出路径都在函数尾 finally 注销状态 */
  for(var round=0;;round++){
    /* P11-3D：第 2 轮起的每次 provider 调用都要先过总轮预算（`continue` 到不了这里之前） */
    if(round>0&&!(_roundBudgetAllows(_fcCtx,function(t){full+=t;})))break;
    var o=Object.assign({},opts,{maxTokens:budget,wantMeta:true});
    o._st=st;/* 并发隔离：单次调用把思考/结束原因写进本调用的状态对象 */
    if(tokenParam)o.tokenParam=tokenParam;
    if(_fcCtx)o._fcCtx=_fcCtx;
    if(timeoutMs)o.timeoutMs=timeoutMs;
    if(round>0)o.wantThinking=false;
    var _traceId=String(opts._ibTraceId||(opts._ibTurn&&opts._ibTurn.traceId)||'');
    var _attemptNo=providerRetries+1,_attemptStartedAt=Date.now();
    _ibTurnTraceEvent(_traceId,'model_call_started',{provider:cfg.provider,model:cfg.model,format:_providerFormat(cfg),attempt:_attemptNo});
    var r;
    try{r=await _callApiChatOnce(cfg,msgs,o)}
    catch(e){
      var _providerCategory=_ibProviderErrorCategory(e);
      var _providerStatus=0;try{_providerStatus=Number(window.IBERR&&window.IBERR.statusOf?window.IBERR.statusOf(e):e.status)||0}catch(_statusError){}
      _ibTurnTraceEvent(_traceId,'model_call_finished',{provider:cfg.provider,model:cfg.model,format:_providerFormat(cfg),attempt:_attemptNo,
        status:'failed',latencyMs:Date.now()-_attemptStartedAt,httpStatus:_providerStatus||null,errorCategory:_providerCategory});
      if(e&&e.code==='CREDENTIAL_UNAVAILABLE')throw _ibCredentialUnavailable();
      var _retryLimit=_ibProviderRetryLimit(e);
      if(providerRetries<_retryLimit){
        providerRetries++;
        var _retryDelay=_ibProviderRetryDelay(e,providerRetries);
        _ibTurnTraceEvent(_traceId,'model_call_retry',{provider:cfg.provider,model:cfg.model,attempt:providerRetries+1,
          retryCount:providerRetries,retryDelayMs:_retryDelay,errorCategory:_providerCategory,httpStatus:_providerStatus||null});
        if(!await _ibWaitForProviderRetry(_retryDelay,opts))throw _ibStoppedRetryError();
        round--;continue;
      }
      /* 联网搜索：报错明确指向搜索工具 → 只去掉搜索重试，保留原生 FC */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&/web_search|google_search/i.test(String(e&&e.message||e))){providerRetries=0;opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* AI 规划 jsonMode：端点不认 response_format → 去掉 JSON 模式原样重试一次（降级为提示词 + 容错解析） */
      if(opts.jsonMode&&round===0&&!full&&/response_format|json[ _-]?mode|json_object/i.test(String(e&&e.message||e))){providerRetries=0;opts=Object.assign({},opts,{jsonMode:false});round--;continue}
      /* FC：端点不认 tools 参数 → 关掉 FC 原样重试一次（回落 XML 通道） */
      if(_fcCtx&&round===0&&!full&&/tool/i.test(String(e&&e.message||e))){providerRetries=0;_fcCtx=null;msgs=messages;round--;continue}
      /* 联网搜索：端点不认搜索参数(4xx 且非鉴权错) → 去掉搜索原样重试一次 */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!IBWS.blocked(cfg)&&IBWS.errLooksParam(e)){providerRetries=0;opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* ① 新款 OpenAI 系模型要求 max_completion_tokens：换参数名原额重试（不降额） */
      if(!tokenParam&&round===0&&_errWantsCompletionParam(e)&&_fcRetryAllowed(_fcCtx)){providerRetries=0;tokenParam='max_completion_tokens';_tokParamRemember(cfg);round--;continue}
      /* ② 输出上限超过该模型/中转允许值：优先用报错建议值一步到位，否则减半（下限1024），最多3次 */
      if(round===0&&tokRetries<3&&budget>1024&&_errLooksMaxTok(e)&&_fcRetryAllowed(_fcCtx)){
        providerRetries=0;
        tokRetries++;
        var _sug=_extractSuggestedMaxTok(e);
        budget=(_sug&&_sug<budget)?_sug:Math.max(1024,Math.floor(budget/2));
        round--;continue;
      }
      if(round>0&&full){lastTrunc=false;break}
      throw e;
    }
    var _modelText=String((r&&r.text)||'');
    _ibTurnTraceEvent(_traceId,'model_call_finished',{provider:cfg.provider,model:cfg.model,format:_providerFormat(cfg),attempt:_attemptNo,
      status:'success',latencyMs:Date.now()-_attemptStartedAt,resultChars:_modelText.length,truncated:!!(r&&r.truncated)});
    providerRetries=0;
    var piece=(r&&r.text)||'';
    if(round>0)piece=_wsDedupSeam(full,piece);
    full+=piece;
    if(st.think)thinkAcc+=(thinkAcc?'\n':'')+st.think;
    lastTrunc=!!(r&&r.truncated);
    /* FC：非流式轮 —— Once 已把工具调用暂存到 _fcCtx._nsCalls */
    if(_fcCtx&&_fcCtx._nsCalls&&_fcCtx._nsCalls.length){
      try{
        var _nsc=_fcCtx._nsCalls;_fcCtx._nsCalls=null;
        var _fcr2=await IBFC.runRound(_fcCtx,piece,function(t){full+=t},_nsc);
        if(_fcr2&&_fcr2.done===false){msgs=_fcCtx.messages;lastTrunc=false;continue}
      }catch(e){}
    }
    if(!lastTrunc||round>=maxRounds)break;
    msgs=((_fcCtx&&_fcCtx.messages)||messages).concat([{role:'assistant',content:full},{role:'user',content:_WS_CONT_PROMPT}]);
  }
  _lastApiReasoning=thinkAcc;
  if(opts.result){opts.result.reasoning_content=thinkAcc;opts.result.truncated=lastTrunc}
  /* 非流式 success seam：走到这里说明 HTTP/model 成功返回。
     同一 logical turn 只会到这里一次（retry 走 throw 分支）。 */
  var _ibExpFiredNS=false;
  if(!_ibExpFiredNS){
    _ibExpFiredNS=true;
    try{
      var _nsT=opts&&opts._ibTurn;
      var _nsX=(_nsT&&_nsT._ibRecallAuthority!=='SERVER')?(_nsT&&_nsT.memoryExposure):null;
      if(_nsX&&typeof window!=='undefined'&&typeof window._ibRecordRecallExposure==='function'){
        window._ibRecordRecallExposure(_nsX);
      }
    }catch(e){}
  }
  return opts.wantMeta?{text:full,truncated:lastTrunc}:full;
  }finally{_endCallState(st);_toolCycleEnd(_fcCtx,_turnB)}
}

/* ── 任务A：Gemini/OpenAI 联网搜索可视化 ──
   两家的搜索元数据不像 Anthropic 那样以独立事件出现在流中：
   · Gemini 把 groundingMetadata（webSearchQueries + groundingChunks）挂在 candidate 上，多在流尾块；
   · OpenAI 把 url_citation 注解挂在 delta/message.annotations 上，且没有查询词。
   处理策略：流中持续累积去重（feed），流结束时合成一条搜索记录（flush）→ 走与 Anthropic 相同的
   searchLog / onSearch({phase:'results'}) 管线，卡片与持久化零新增代码。 */
function _ibwsFeedGrounding(gm,opts){
  if(!gm||!opts)return;
  const g=opts._gnd||(opts._gnd={q:[],r:[],seen:{}});
  try{(gm.webSearchQueries||[]).forEach(q=>{q=String(q||'').trim();if(q&&!g.seen['q:'+q]){g.seen['q:'+q]=1;g.q.push(q)}})}catch(e){}
  try{(gm.groundingChunks||[]).forEach(c=>{const w=c&&c.web;if(!w)return;const u=w.uri||'';const t=w.title||u;if(!u&&!t)return;const k='r:'+(u||t);if(!g.seen[k]){g.seen[k]=1;g.r.push({title:t||u,url:u})}})}catch(e){}
}
function _ibwsFeedAnnotations(list,opts){
  if(!list||!list.length||!opts)return;
  const g=opts._gnd||(opts._gnd={q:[],r:[],seen:{}});
  try{list.forEach(a=>{if(!a)return;const uc=a.url_citation||a.urlCitation||(a.type==='url_citation'&&a.url?a:null);if(!uc)return;const u=uc.url||'';const t=uc.title||u;if(!u&&!t)return;const k='r:'+(u||t);if(!g.seen[k]){g.seen[k]=1;g.r.push({title:t||u,url:u})}})}catch(e){}
}
function _ibwsFlushSearchMeta(opts){
  const g=opts&&opts._gnd;if(!g)return;
  opts._gnd=null;
  if(!g.q.length&&!g.r.length)return;
  const rec={query:g.q.join('、'),results:g.r};
  if(opts.searchLog)opts.searchLog.push(rec);
  if(opts.onSearch)try{opts.onSearch({phase:'results',query:rec.query,results:rec.results})}catch(e){}
}

async function _callApiChatStreamOnce(cfg,messages,opts){
  return _ibWithRuntimeApiCredential(cfg,function(runtimeCfg){
    return _callApiChatStreamOnceWithRuntimeCredential(runtimeCfg,messages,opts);
  });
}
async function _callApiChatStreamOnceWithRuntimeCredential(cfg,messages,opts){
  return _ibWithRuntimeApiCredential(cfg,function(runtimeCfg){
    return _callApiChatStreamOnceWithRuntimeCredential(runtimeCfg,messages,opts);
  });
}
async function _callApiChatStreamOnceWithRuntimeCredential(cfg,messages,opts){
  opts=opts||{};
  _mSetThink(opts,'');_mSetFinish(opts,'');
  const maxTok=opts.maxTokens||4096;
  const timeoutMs=opts.timeoutMs||60000;
  const wantThink=!!opts.wantThinking;
  const onChunk=opts.onChunk||(()=>{});
  const onThink=opts.onThink||(()=>{});/* 思考链实时回调 */
  const fmt=_providerFormat(cfg);
  /* 不改写用户消息来索取思维链。原生 reasoning delta 走独立侧通道。 */
  let _msgs=messages;
  /* 联网搜索边界：开关开启时在 system 末尾追加一句使用边界，与搜索工具同时出现、同时消失 */
  try{if(typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!(opts&&opts._noWebSearch)&&!IBWS.blocked(cfg)&&IBWS.SYS_NOTE&&IBWS.searchNoteNeeded(_msgs,cfg)){_msgs=_msgs.map(m=>m&&m.role==='system'?Object.assign({},m,{content:String(m.content||'')+IBWS.SYS_NOTE}):m)}}catch(e){}
  /* 联网搜索·逐轮硬提醒：文件任务时把 TURN_NOTE 附到最后一条 user 消息（仅发送副本，零缓存代价） */
  try{if(typeof IBWS!=='undefined'&&IBWS.steer)_msgs=IBWS.steer(_msgs,cfg,opts)}catch(e){}
  const ac=opts.abortController||new AbortController();const _extAC=!!opts.abortController;if(!_extAC)_streamAbortController=ac;
  if(opts._st)opts._st.ac=ac;/* 并发隔离：供停止按钮按对话中止 */
  const tm=setTimeout(()=>{if(opts._st)opts._st.abortReason='timeout';ac.abort()},timeoutMs);
  /* 心跳超时：默认45秒没收到任何chunk就中断，可通过opts.heartbeatMs覆盖 */
  const _hbMs=opts.heartbeatMs||45000;
  let _heartbeat=null;
  const _resetHB=()=>{if(_heartbeat)clearTimeout(_heartbeat);_heartbeat=setTimeout(()=>{if(opts._st)opts._st.abortReason='heartbeat';ac.abort()},_hbMs)};
  let fullText='',thinkingText='';
  /* 仅响应侧启用：官方原生 thinking_delta 仍走旧路径；只有文本标签泄漏时才由 mux 分流。 */
  const _anthWebThinkMode=(fmt==='anthropic'&&_anthropicWebThinkResponseMode(cfg,opts,wantThink));
  let _anthNativeThinkSeen=false;
  const _anthWebThinkMux=_anthWebThinkMode?_makeAnthropicWebThinkMux(function(t){fullText+=t;onChunk(t)},function(t){thinkingText+=t;onThink(t)}):null;
  function _anthropicResponseText(t){t=String(t||'');if(!t)return;if(_anthWebThinkMux&&!_anthNativeThinkSeen)_anthWebThinkMux.push(t);else{fullText+=t;onChunk(t)}}
  try{
    let url,hdrs={},body;
    if(fmt==='anthropic'){
      url=cfg.endpoint;
      hdrs={'Content-Type':'application/json','x-api-key':cfg.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'};
      _ccBeta(hdrs,cfg);
      const _an=_ibAnthropicWire(_msgs);/* P20：system 归一唯一真源 = IBModelCore */
      const chatMsgs=_an.messages.map(m=>{if(m&&m._fc){var _c=Object.assign({},m);delete _c._fc;return _c}return{role:m.role,content:_adaptContentForApi(m.content,'anthropic')}});
      _injectAnthropicMsgCache(chatMsgs,cfg);/* 消息级缓存断点 */
      const b={model:cfg.model,max_tokens:maxTok,stream:true,messages:chatMsgs};
      if(opts._fcCtx&&opts._fcCtx.tools){b.tools=opts._fcCtx.tools.anthropic;IBFC.newAcc(opts._fcCtx)}
      try{if(typeof IBWS!=='undefined')IBWS.attach(b,'anthropic',cfg,opts)}catch(e){}
      if(_an.system){if(cfg.promptCache!==false&&cfg.provider==='anthropic'){b.system=[{type:'text',text:_an.system,cache_control:_ccObj(cfg)}]}else{b.system=_an.system}}if(cfg.temperature!=null&&_modelSupportsSampling(cfg))b.temperature=cfg.temperature;
      if(cfg.promptCache!==false){try{_ibCacheAudit(cfg,b,'anthropic',{consumer:opts._ibConsumer})}catch(e){}}/* 前缀缓存审计（console-only） */
      _ibApplyReasoningEffort(b,'anthropic',cfg,opts,maxTok);/* P21：canonical 思考深度 → 能力翻译（auto/未取证 → 不写字段） */
      body=JSON.stringify(b);
    }else if(fmt==='gemini'){
      url=cfg.endpoint.replace('{model}',cfg.model).replace('generateContent','streamGenerateContent')+'?key='+cfg.apiKey+'&alt=sse';
      hdrs={'Content-Type':'application/json'};
      const sysMsgG=_msgs.find(m=>m.role==='system');
      const contents=_ibWireMessages(_msgs.filter(m=>m.role!=='system'),'gemini').map(m=>{
        const parts=[];
        if(Array.isArray(m.content)){m.content.forEach(p=>{if(p.type==='_image')parts.push({inlineData:{mimeType:p.mime,data:p.base64}});else if(p.type==='_audio')parts.push({inlineData:{mimeType:p.mime||'audio/wav',data:p.base64}});else parts.push({text:p.text||''})})}
        else{parts.push({text:String(m.content||'')})}
        return{role:m.role==='assistant'?'model':'user',parts}
      });
      const gB={contents};if(sysMsgG)gB.system_instruction={parts:[{text:sysMsgG.content}]};
      gB.generationConfig={maxOutputTokens:maxTok};/* 之前完全没设，Gemini 按默认值截断输出 */
      if(cfg.temperature!=null)gB.generationConfig.temperature=cfg.temperature;
      try{if(typeof IBWS!=='undefined')IBWS.attach(gB,'gemini',cfg,opts)}catch(e){}
      if(cfg.promptCache!==false){try{_ibCacheAudit(cfg,gB,'gemini',{consumer:opts._ibConsumer})}catch(e){}}/* 前缀缓存审计（console-only） */
      _ibApplyReasoningEffort(gB,'gemini',cfg,opts,maxTok);
      body=JSON.stringify(gB);
    }else{
      url=cfg.endpoint;
      hdrs={'Content-Type':'application/json'};if(cfg.apiKey)hdrs.Authorization='Bearer '+cfg.apiKey;
      const _allowOpenAIImages=!_usesLocalDeepSeekVision(cfg);
      const ob={model:cfg.model,messages:_msgs.map(m=>_adaptMessageForApi(m,'openai',_allowOpenAIImages)),stream:true};
      if(opts._fcCtx&&opts._fcCtx.tools){ob.tools=opts._fcCtx.tools.openai;IBFC.newAcc(opts._fcCtx)}
      try{if(typeof IBWS!=='undefined')IBWS.attach(ob,'openai',cfg,opts)}catch(e){}
      ob[_mimoTokenKey(cfg,opts)]=maxTok;/* 新款 OpenAI 系模型由包装器切换为 max_completion_tokens；MiMo 端点强制 max_completion_tokens */
      if(cfg.promptCache!==false&&!_isMimoEndpoint(cfg))ob.prompt_cache_key='ib_'+String(cfg.id||'');/* OpenAI 缓存本自动生效；此 key 只用于提升路由命中率。MiMo 无此字段且自行缓存，发出去反而 400 */
      if(cfg.promptCache!==false&&!_isMimoEndpoint(cfg))ob.stream_options={include_usage:true};/* 用量回传：与上方附加参数同受"提示缓存"开关控制。MiMo 未定义此字段，省略以免 400 */
      if(cfg.promptCache!==false){try{_ibCacheAudit(cfg,ob,'openai',{consumer:opts._ibConsumer})}catch(e){}}/* 前缀缓存审计（console-only） */
      if(cfg.temperature!=null)ob.temperature=cfg.temperature;
      /* ── 临时调试（定位 OpenRouter 400；测试完删除本段）──
         console 执行：localStorage.setItem('ib_debug_omit','prompt_cache_key,stream_options') 可逐项剔除；
         支持字段名：prompt_cache_key / stream_options / temperature / tools / web_search_options / max_tokens 等；
         完整请求体打印需额外显式打开：localStorage.setItem('ib_debug_body','1')（默认不打印，避免把角色 Memory / 用户对话打进生产日志）。 */
      try{
        var _dbgOmit=(typeof localStorage!=='undefined'?localStorage.getItem('ib_debug_omit'):'')||'';
        var _dbgBodyShow=!!(typeof localStorage!=='undefined'&&localStorage.getItem('ib_debug_body'));
        var _dbgKeys=_dbgOmit.split(/[,，\s]+/).map(function(s){return s.trim()}).filter(Boolean);
        if(_dbgKeys.length){_dbgKeys.forEach(function(k){delete ob[k]});console.warn('[IB调试] 已临时移除请求体字段:',_dbgKeys.join(', '))}
        if(_dbgBodyShow){
          var _dbgBody=JSON.parse(JSON.stringify(ob));
          (function _dbgRedact(o){if(!o||typeof o!=='object')return;for(var k in o){if(/key|token|secret|authorization/i.test(k)&&typeof o[k]==='string'&&o[k]){o[k]=String(o[k]).slice(0,4)+'***'+String(o[k]).slice(-4)}else _dbgRedact(o[k])}})(_dbgBody);
          /* URL 同样脱敏：Gemini 端点把 key 放进 ?key= 查询串，须隐藏其中的完整 API Key */
          var _dbgRedactUrl=function(u){try{return String(u||'').replace(/([?&])key=[^&]*/gi,'$1key=***********')}catch(e){return String(u||'')}};
          console.log('[IB调试] 最终请求体:',JSON.stringify(_dbgBody,null,2));
          console.log('[IB调试] 请求URL:',_dbgRedactUrl(url),'| credentialAttached:',!!cfg.apiKey);
        }
      }catch(e){}
      _ibApplyReasoningEffort(ob,'openai',cfg,opts,maxTok);
      body=JSON.stringify(ob);
    }
    const res=await _ibApiPost(url,hdrs,body,{signal:ac.signal});
    clearTimeout(tm);_resetHB();
    if(!res.ok){const e=await res.text();console.error('[IB API错误]',res.status,e);throw _ibProviderHttpError(res,e)}
    const _sct=res.headers.get('content-type')||'';
    if(_sct.includes('text/html')){throw new Error('API端点返回了网页而非JSON——请检查端点URL是否正确。如使用中转站，请确认API地址填写到完整路径（如 https://xxx.com/v1/chat/completions）')}
    const reader=res.body.getReader();const decoder=new TextDecoder();let buf='';
    while(true){
      const{done,value}=await reader.read();if(done)break;
      _resetHB();
      buf+=decoder.decode(value,{stream:true});
      const lines=buf.split('\n');buf=lines.pop()||'';
      for(const line of lines){
        if(!line.startsWith('data:'))continue;/* 兼容 "data:" 冒号后无空格的实现 */
        const d=line.slice(5).replace(/^\s+/,'').trim();if(d==='[DONE]')continue;
        try{
          const j=JSON.parse(d);
          if(fmt==='anthropic'){
            if(opts._fcCtx&&opts._fcCtx._acc)IBFC.feedAnthropic(opts._fcCtx._acc,j);
            if(j.type==='message_start'&&j.message&&j.message.usage){var _mu=j.message.usage;opts._tkU={i:_mu.input_tokens||0,cr:_mu.cache_read_input_tokens||0,cw:_mu.cache_creation_input_tokens||0,o:0}}
            if(j.type==='message_delta'&&j.delta&&j.delta.stop_reason)_mSetFinish(opts,j.delta.stop_reason);
            if(j.type==='message_delta'&&j.usage){var _tu=opts._tkU||(opts._tkU={i:0,cr:0,cw:0,o:0});_tu.o=j.usage.output_tokens||_tu.o}/* 记账加固：改为流末统一落账（见循环收尾），中转把 usage 拆进多个 message_delta 时不再重复记行 */
            /* ── 服务端联网搜索可视化：server_tool_use(累积query) → web_search_tool_result(结果) ── */
            if(j.type==='content_block_start'&&j.content_block){
              const cb=j.content_block;
              if(cb.type==='server_tool_use'&&/search/i.test(cb.name||'')){opts._srchIdx=j.index;opts._srchBuf='';if(opts.onSearch)try{opts.onSearch({phase:'start'})}catch(e){}}
              else if(cb.type==='web_search_tool_result'){
                const rs=[];try{(Array.isArray(cb.content)?cb.content:[]).forEach(r=>{if(r&&(r.title||r.url))rs.push({title:r.title||r.url,url:r.url||''})})}catch(e){}
                const rec={query:opts._srchQ||'',results:rs};
                if(opts.searchLog)opts.searchLog.push(rec);
                if(opts.onSearch)try{opts.onSearch({phase:'results',query:rec.query,results:rs})}catch(e){}
              }
            }
            if(j.type==='content_block_stop'&&opts._srchIdx!=null&&j.index===opts._srchIdx){
              try{const qo=JSON.parse(opts._srchBuf||'{}');opts._srchQ=qo.query||''}catch(e){opts._srchQ=''}
              opts._srchIdx=null;
              if(opts.onSearch)try{opts.onSearch({phase:'query',query:opts._srchQ})}catch(e){}
            }
            if(j.type==='content_block_delta'){
              if(j.delta?.type==='input_json_delta'&&opts._srchIdx!=null&&j.index===opts._srchIdx){opts._srchBuf=(opts._srchBuf||'')+(j.delta.partial_json||'')}
              if(j.delta?.type==='thinking_delta'){
                if(!_anthNativeThinkSeen){_anthNativeThinkSeen=true;if(_anthWebThinkMux)_anthWebThinkMux.releaseAsText()}
                const tk=j.delta.thinking||'';thinkingText+=tk;onThink(tk)
              }
              else if(j.delta?.type==='text_delta'){_anthropicResponseText(j.delta.text||'')}
            }
          }else if(fmt==='gemini'){
            if(j.usageMetadata){_ibNoteReasoningUsage(j.usageMetadata,'gemini',cfg,opts);var _gu=j.usageMetadata,_gc=_gu.cachedContentTokenCount||0;opts._tkU={i:Math.max(0,(_gu.promptTokenCount||0)-_gc),cr:_gc,cw:0,o:(_gu.candidatesTokenCount||0)+(_gu.thoughtsTokenCount||0)}}
            if(j.candidates&&j.candidates[0]&&j.candidates[0].finishReason)_mSetFinish(opts,j.candidates[0].finishReason);/* 记账加固：用量改为流末统一落账 */
            const _gm=j.candidates?.[0]?.groundingMetadata;if(_gm)_ibwsFeedGrounding(_gm,opts);/* 任务A：搜索元数据多在流尾块 */
            const parts=j.candidates?.[0]?.content?.parts||[];
            for(const p of parts){if(p.thought){thinkingText+=p.text||'';onThink(p.text||'')}else if(p.text){fullText+=p.text;onChunk(p.text)}}
          }else{
            if(j.usage){_ibNoteReasoningUsage(j.usage,'openai',cfg,opts);var _pu=j.usage,_pc=(_pu.prompt_tokens_details&&_pu.prompt_tokens_details.cached_tokens)||(_pu.input_tokens_details&&_pu.input_tokens_details.cached_tokens)||_pu.prompt_cache_hit_tokens||0;if(cfg.promptCache!==false)try{console.info('[IB缓存诊断] usage 原文: '+JSON.stringify(_pu))}catch(e2){}opts._tkU={i:Math.max(0,(_pu.prompt_tokens||0)-_pc),cr:_pc,cw:0,o:_pu.completion_tokens||0}}/* 记账加固：暂存覆盖（累计式 usage 以末次为准），流末统一落账，防个别中转逐 chunk 带 usage 造成重复记账 *//* DeepSeek 命中字段兼容：prompt_cache_hit_tokens；input_tokens_details 为 Responses 形状回传的兜底 */
            if(j.choices&&j.choices[0]&&j.choices[0].finish_reason)_mSetFinish(opts,j.choices[0].finish_reason);
            const delta=j.choices?.[0]?.delta;
            const _ann=(delta&&delta.annotations)||(j.choices?.[0]?.message&&j.choices[0].message.annotations);if(_ann&&_ann.length)_ibwsFeedAnnotations(_ann,opts);/* 任务A */
            if(opts._fcCtx&&opts._fcCtx._acc&&delta)IBFC.feedOpenAI(opts._fcCtx._acc,delta);
            if(delta?.reasoning_content){thinkingText+=delta.reasoning_content;onThink(delta.reasoning_content)}
            if(delta?.content){fullText+=delta.content;onChunk(delta.content)}
          }
        }catch(e){}
      }
    }
    if(_anthWebThinkMux)_anthWebThinkMux.finish();
    if(thinkingText)_mSetThink(opts,thinkingText);
    if(opts._tkU){try{_tkRecord(cfg,opts._tkU,opts)}catch(e2){}opts._tkU=null}/* 记账加固：流末统一落账 */
    if(!_extAC&&_streamAbortController===ac)_streamAbortController=null;if(opts._st&&opts._st.ac===ac)opts._st.ac=null;if(_heartbeat)clearTimeout(_heartbeat);_ibwsFlushSearchMeta(opts);return fullText;
  }catch(e){
    clearTimeout(tm);if(!_extAC&&_streamAbortController===ac)_streamAbortController=null;if(opts._st&&opts._st.ac===ac)opts._st.ac=null;if(_heartbeat)clearTimeout(_heartbeat);
    if(opts._tkU){try{_tkRecord(cfg,opts._tkU,opts)}catch(e2){}opts._tkU=null}/* 记账加固：手动停止/超时的请求输入侧照样计费，此前一律漏记，现按已知量落账（输出可能少记） */
    if(e.name==='AbortError'){
      if(_anthWebThinkMux)_anthWebThinkMux.finish();
      if(thinkingText)_mSetThink(opts,thinkingText);
      if(fullText.trim()){_ibwsFlushSearchMeta(opts);return fullText}
      /* 中止语义按 abort 来源区分（结构化，不依赖中文文案）：
         user_stop → 保持原有 stopped/aborted 语义；timeout/heartbeat → 明确的 timeout 错误。 */
      if((opts._st&&opts._st.abortReason)==='user_stop'){var _ue=new Error('请求超时或已停止');_ue.ibCat='aborted';throw _ue}
      var _te=new Error('请求超时');_te.ibCat='timeout';throw _te
    }
    throw e
  }
}

/* 流式气泡：创建空AI气泡并返回文本元素引用 */
/* ── 流式收尾后校准迷你面板 ──
   面板若在流式"进行中"才被打开，拿不到实时 ref：openChatPanel 里的 loadChatMessages
   只能读到"未含本条"的历史快照，收尾时也没有它的 ref 可重建——于是要么缺这条消息，
   要么残留半成品（原始指令文本 / pending 操作卡 / 流式光标），关掉重开才恢复。
   收尾后统一体检：面板开着、看的是同一好友，但缺这条消息或消息仍是半成品 → 重载迷你列表。 */
function _syncMiniAfterStream(msgId,friendId){
  try{
    var panel=document.getElementById('chat-panel');
    if(!panel||!panel.classList.contains('show'))return;
    if(activeFriendId!==friendId)return;
    var box=document.getElementById('chat-messages');
    if(!box)return;
    var el=box.querySelector('.chat-msg[data-msg-id="'+msgId+'"]');
    if(!el||el.querySelector('.ws-op-card.pending')||el.querySelector('.chat-stream-cursor')||el.classList.contains('chat-stream-cursor')){
      loadChatMessages();
    }
  }catch(e){}
}
function _createStreamBubble(_targetFriend,senderName,speakerId,threadId){
  const refs=[];
  const miniPanel=document.getElementById('chat-panel');
  const miniVisible=miniPanel&&miniPanel.classList.contains('show');
  const containers=[
    {el:miniVisible?document.getElementById('chat-messages'):null,full:false},
    {el:document.getElementById('chat-full-messages'),full:true}
  ];
  containers.forEach(({el:container,full})=>{
    if(!container)return;
    const sysMsg=container.querySelector('.chat-msg.system');if(sysMsg)sysMsg.remove();
    const div=document.createElement('div');div.className='chat-msg ai';
    const streamSenderId=String(speakerId||'');
    if(full){div.dataset.senderRole='ai';div.dataset.senderId=streamSenderId}
    var _sMode=_mdMode();if(_sMode==='full'||_sMode==='partial')div.classList.add('md-rendered');
    if(full){
      const sName=senderName||_getActiveAiName()||'AI';
      const activityName=_chatActivitySpeakerName(_targetFriend,speakerId||_targetFriend);
      const timeStr=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const aiAvatar=_getApiAvatar()||_getApiAvatarByName(senderName);
      if(aiAvatar){
        /* ── New avatar layout for streaming ── */
        div.classList.add('chat-msg-avatared');
        div.dataset.senderRole='ai';
        div.dataset.senderId=streamSenderId;
        var _prevMsgs=container.querySelectorAll('.chat-msg');
        var _lastM=_prevMsgs.length?_prevMsgs[_prevMsgs.length-1]:null;
        var _isCont=_lastM&&_lastM.dataset.senderRole==='ai'&&_lastM.dataset.senderId===streamSenderId;
        if(!_isCont){
          const hdr=document.createElement('div');hdr.className='chat-msg-header align-left';
          hdr.appendChild(_buildAvatarCircle(sName,aiAvatar));
          const nm=document.createElement('span');nm.className='r-head-name';nm.textContent=sName;hdr.appendChild(nm);
          const tm=document.createElement('span');tm.className='r-time';tm.textContent=timeStr;hdr.appendChild(tm);
          container.appendChild(hdr);
        }else{
          const ct=document.createElement('div');ct.className='chat-msg-cont-time';ct.style.textAlign='left';ct.style.marginLeft='46px';ct.textContent=timeStr;container.appendChild(ct);
        }
        const activity=document.createElement('div');
        activity.className='chat-stream-activity';
        activity.dataset.state='thinking';
        activity.dataset.friendId=String(_targetFriend||'');
        activity.dataset.threadId=String(threadId||'');
        activity.dataset.speakerId=streamSenderId;
        activity.dataset.speakerName=activityName;
        activity.setAttribute('role','status');
        activity.setAttribute('aria-live','polite');
        activity.setAttribute('aria-atomic','true');
        activity.textContent=_chatStreamActivityText(activityName,'thinking');
        div.appendChild(activity);
        const txt=document.createElement('div');txt.className='r-text chat-stream-cursor';
        txt.setAttribute('aria-live','off');
        div.appendChild(txt);refs.push({div,txt,full:true,container,activityEl:activity});
      }else{
        /* ── Original layout for AI without avatar ── */
        const head=document.createElement('div');head.className='r-head';
        head.innerHTML=esc(sName)+'<span class="r-time">'+timeStr+'</span>';
        div.appendChild(head);
        const activity=document.createElement('div');
        activity.className='chat-stream-activity';
        activity.dataset.state='thinking';
        activity.dataset.friendId=String(_targetFriend||'');
        activity.dataset.threadId=String(threadId||'');
        activity.dataset.speakerId=streamSenderId;
        activity.dataset.speakerName=activityName;
        activity.setAttribute('role','status');
        activity.setAttribute('aria-live','polite');
        activity.setAttribute('aria-atomic','true');
        activity.textContent=_chatStreamActivityText(activityName,'thinking');
        div.appendChild(activity);
        const txt=document.createElement('div');txt.className='r-text chat-stream-cursor';
        txt.setAttribute('aria-live','off');
        div.appendChild(txt);refs.push({div,txt,full:true,container,activityEl:activity});
      }
    }else{
      if(senderName){
        const label=document.createElement('span');label.style.cssText='font-size:var(--fs-meta);opacity:0.7;display:block;margin-bottom:2px';label.textContent=senderName;div.appendChild(label)
      }
      const txt=document.createTextNode('');div.appendChild(txt);
      div.classList.add('chat-stream-cursor');
      refs.push({div,txt,full:false,container,isTextNode:true});
    }
    container.appendChild(div);container.scrollTop=container.scrollHeight;
  });
  return refs;
}

/* Full API call for chat with history */
async function _callApiChatOnce(cfg,messages,opts){
  return _ibWithRuntimeApiCredential(cfg,function(runtimeCfg){
    return _callApiChatOnceWithRuntimeCredential(runtimeCfg,messages,opts);
  });
}
async function _callApiChatOnceWithRuntimeCredential(cfg,messages,opts){
  return _ibWithRuntimeApiCredential(cfg,function(runtimeCfg){
    return _callApiChatOnceWithRuntimeCredential(runtimeCfg,messages,opts);
  });
}
async function _callApiChatOnceWithRuntimeCredential(cfg,messages,opts){
  opts=opts||{};
  _mSetThink(opts,'');_mSetFinish(opts,'');
  const maxTok=opts.maxTokens||4096;
  const timeoutMs=opts.timeoutMs||60000;
  const wantThink=!!opts.wantThinking;
  const pack=(text,truncated)=>opts.wantMeta?{text:text,truncated:!!truncated}:text;
  const fmt=_providerFormat(cfg);

  /* 不要求模型把内部推理写进正文；仅接收 API 的原生 reasoning/thinking block。 */
  let _msgs=messages, _prefillThinking=false;
  /* 联网搜索边界：开关开启时在 system 末尾追加一句使用边界，与搜索工具同时出现、同时消失 */
  try{if(typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!(opts&&opts._noWebSearch)&&!IBWS.blocked(cfg)&&IBWS.SYS_NOTE&&IBWS.searchNoteNeeded(_msgs,cfg)){_msgs=_msgs.map(m=>m&&m.role==='system'?Object.assign({},m,{content:String(m.content||'')+IBWS.SYS_NOTE}):m)}}catch(e){}
  /* 联网搜索·逐轮硬提醒：文件任务时把 TURN_NOTE 附到最后一条 user 消息（仅发送副本，零缓存代价） */
  try{if(typeof IBWS!=='undefined'&&IBWS.steer)_msgs=IBWS.steer(_msgs,cfg,opts)}catch(e){}

  if(fmt==='anthropic'){
    const _an=_ibAnthropicWire(_msgs);/* P20：system 归一唯一真源 = IBModelCore */
    const chatMsgs=_an.messages.map(m=>{if(m&&m._fc){var _c=Object.assign({},m);delete _c._fc;return _c}return{role:m.role,content:_adaptContentForApi(m.content,'anthropic')}});
    _injectAnthropicMsgCache(chatMsgs,cfg);/* 消息级缓存断点 */
    if(_prefillThinking) chatMsgs.push({role:'assistant',content:'<thinking>'});
    const body={model:cfg.model,max_tokens:maxTok,messages:chatMsgs};
    if(opts._fcCtx&&opts._fcCtx.tools)body.tools=opts._fcCtx.tools.anthropic;
    try{if(typeof IBWS!=='undefined')IBWS.attach(body,'anthropic',cfg,opts)}catch(e){}
    if(_an.system){if(cfg.promptCache!==false&&cfg.provider==='anthropic'){body.system=[{type:'text',text:_an.system,cache_control:_ccObj(cfg)}]}else{body.system=_an.system}}
    if(cfg.temperature!=null&&_modelSupportsSampling(cfg))body.temperature=cfg.temperature;
    if(cfg.promptCache!==false){try{_ibCacheAudit(cfg,body,'anthropic',{consumer:opts._ibConsumer})}catch(e){}}/* 前缀缓存审计（console-only） */
    _ibApplyReasoningEffort(body,'anthropic',cfg,opts,maxTok);/* P21：canonical 思考深度 → 能力翻译（auto/未取证 → 不写字段） */
    const hdrs={'Content-Type':'application/json','x-api-key':cfg.apiKey,
      'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'};
    _ccBeta(hdrs,cfg);
    const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const res=await _ibApiPost(cfg.endpoint,hdrs,JSON.stringify(body),{signal:ac.signal});
      clearTimeout(tm);
      if(!res.ok){const e=await res.text();throw _ibProviderHttpError(res,e)}
      const data=await res.json();
      try{if(data&&data.usage){_tkRecord(cfg,{i:data.usage.input_tokens||0,cr:data.usage.cache_read_input_tokens||0,cw:data.usage.cache_creation_input_tokens||0,o:data.usage.output_tokens||0},opts)}}catch(e){}/* 清理：原第二行按 OpenAI 字段解析 Anthropic 响应的死代码已删（恒为全零被守卫拦下） */
  if(opts._fcCtx){try{opts._fcCtx._nsCalls=IBFC.extractFromResponse(opts._fcCtx,data)}catch(e){opts._fcCtx._nsCalls=null}}
      /* 任务A：非流式响应里的服务端搜索块 → searchLog（query 块在结果块之前出现） */
      try{if(opts.searchLog&&data.content&&Array.isArray(data.content)){let _q='';data.content.forEach(c=>{if(c&&c.type==='server_tool_use'&&/search/i.test(c.name||'')){_q=(c.input&&c.input.query)||''}else if(c&&c.type==='web_search_tool_result'){const rs=[];(Array.isArray(c.content)?c.content:[]).forEach(r=>{if(r&&(r.title||r.url))rs.push({title:r.title||r.url,url:r.url||''})});opts.searchLog.push({query:_q,results:rs});_q=''}})}}catch(e){}
      let _anthNativeThinking='';
      if(data.content&&Array.isArray(data.content)){
        const thinkParts=data.content.filter(c=>c.type==='thinking');
        if(thinkParts.length){_anthNativeThinking=thinkParts.map(c=>c.thinking||c.text||'').join('\n');_mSetThink(opts,_anthNativeThinking)}
      }
      const textParts=(data.content||[]).filter(c=>c.type!=='thinking');
      let _out=textParts.map(c=>c.text||'').join('');
      if(_prefillThinking) _out='<thinking>'+_out;
      /* 官方原生 thinking block 保持原逻辑；仅对中转混入正文的标签做二次分流。 */
      if(!_anthNativeThinking&&_anthropicWebThinkResponseMode(cfg,opts,wantThink)){
        const _amx=_makeAnthropicWebThinkMux();_amx.push(_out);const _amr=_amx.finish();
        if(_amr.thinking)_mSetThink(opts,_mergeAnthropicWebThink(_anthNativeThinking,_amr.thinking));
        _out=_amr.text;
      }
      if(data.stop_reason)_mSetFinish(opts,data.stop_reason);
      return pack(_out,data.stop_reason==='max_tokens');
    }catch(e){clearTimeout(tm);if(e.name==='AbortError')throw new Error('请求超时');throw e}
  }

  if(fmt==='gemini'){
    const ep=cfg.endpoint.replace('{model}',cfg.model)+'?key='+cfg.apiKey;
    const sysMsgG=_msgs.find(m=>m.role==='system');
    const contents=_ibWireMessages(_msgs.filter(m=>m.role!=='system'),'gemini').map(m=>{
      const parts=[];
      if(Array.isArray(m.content)){
        m.content.forEach(p=>{
          if(p.type==='_image')parts.push({inlineData:{mimeType:p.mime,data:p.base64}});
          else if(p.type==='_audio')parts.push({inlineData:{mimeType:p.mime||'audio/wav',data:p.base64}});
          else parts.push({text:p.text||''})
        })
      }else{parts.push({text:String(m.content||'')})}
      return{role:m.role==='assistant'?'model':'user',parts:parts}
    });
    const gBody={contents};
    if(sysMsgG)gBody.system_instruction={parts:[{text:sysMsgG.content}]};
    gBody.generationConfig={maxOutputTokens:maxTok};/* 之前完全没设，Gemini 按默认值截断输出 */
    if(opts.jsonMode)gBody.generationConfig.responseMimeType='application/json';/* AI 规划：结构化 JSON 输出 */
    if(cfg.temperature!=null)gBody.generationConfig.temperature=cfg.temperature;
    try{if(typeof IBWS!=='undefined')IBWS.attach(gBody,'gemini',cfg,opts)}catch(e){}
    if(cfg.promptCache!==false){try{_ibCacheAudit(cfg,gBody,'gemini',{consumer:opts._ibConsumer})}catch(e){}}/* 前缀缓存审计（console-only） */
    /* Gemini: thinking is handled by system prompt <thinking> tags, not native API */
    _ibApplyReasoningEffort(gBody,'gemini',cfg,opts,maxTok);
    const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const res=await _ibApiPost(ep,{'Content-Type':'application/json'},JSON.stringify(gBody),{signal:ac.signal});
      clearTimeout(tm);
      if(!res.ok){const e=await res.text();throw _ibProviderHttpError(res,e)}
      const data=await res.json();
      try{if(data.usageMetadata){_ibNoteReasoningUsage(data.usageMetadata,'gemini',cfg,opts);var _gu2=data.usageMetadata,_gc2=_gu2.cachedContentTokenCount||0;_tkRecord(cfg,{i:Math.max(0,(_gu2.promptTokenCount||0)-_gc2),cr:_gc2,cw:0,o:(_gu2.candidatesTokenCount||0)+(_gu2.thoughtsTokenCount||0)},opts)}}catch(e){}
      const cand=(data.candidates&&data.candidates[0])||{};
      try{if(cand.groundingMetadata){_ibwsFeedGrounding(cand.groundingMetadata,opts);_ibwsFlushSearchMeta(opts)}}catch(e){}/* 任务A */
      if(cand.content&&cand.content.parts){
        const thinkParts=cand.content.parts.filter(p=>p.thought===true);
        if(thinkParts.length) _mSetThink(opts,thinkParts.map(p=>p.text||'').join('\n'));
      }
      const txt=(cand.content&&cand.content.parts)?cand.content.parts.filter(p=>!p.thought).map(p=>p.text||'').join(''):'';
      if(cand.finishReason)_mSetFinish(opts,cand.finishReason);
      return pack(txt,cand.finishReason==='MAX_TOKENS');
    }catch(e){clearTimeout(tm);if(e.name==='AbortError')throw new Error('请求超时');throw e}
  }

  /* OpenAI-compatible */
  const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),timeoutMs);
  try{
  const _allowOpenAIImages=!_usesLocalDeepSeekVision(cfg);
  const oBody={model:cfg.model,messages:_msgs.map(m=>_adaptMessageForApi(m,'openai',_allowOpenAIImages))};
  if(opts._fcCtx&&opts._fcCtx.tools)oBody.tools=opts._fcCtx.tools.openai;
  if(opts.jsonMode)oBody.response_format={type:'json_object'};/* AI 规划：结构化 JSON 输出（不支持的中转站会在包装层降级重试） */
  try{if(typeof IBWS!=='undefined')IBWS.attach(oBody,'openai',cfg,opts)}catch(e){}
  oBody[_mimoTokenKey(cfg,opts)]=maxTok;/* 新款 OpenAI 系模型由包装器切换为 max_completion_tokens；MiMo 端点强制 max_completion_tokens */
  if(cfg.promptCache!==false&&!_isMimoEndpoint(cfg))oBody.prompt_cache_key='ib_'+String(cfg.id||'');/* OpenAI 缓存本自动生效；此 key 只用于提升路由命中率。MiMo 无此字段且自行缓存，发出去反而 400 */
  if(cfg.promptCache!==false){try{_ibCacheAudit(cfg,oBody,'openai',{consumer:opts._ibConsumer})}catch(e){}}/* 前缀缓存审计（console-only） */
  if(cfg.temperature!=null)oBody.temperature=cfg.temperature;
  _ibApplyReasoningEffort(oBody,'openai',cfg,opts,maxTok);
  const _hdrN=Object.assign({'Content-Type':'application/json'},cfg.apiKey?{Authorization:'Bearer '+cfg.apiKey}:{});
  const res=await _ibApiPost(cfg.endpoint,_hdrN,JSON.stringify(oBody),{signal:ac.signal});
  clearTimeout(tm);
  if(!res.ok){const e=await res.text();throw _ibProviderHttpError(res,e)}
  const _oct=res.headers.get('content-type')||'';
  if(_oct.includes('text/html')){throw new Error('API端点返回了网页而非JSON——请检查端点URL是否正确。如使用中转站，请确认API地址填写到完整路径（如 https://xxx.com/v1/chat/completions）')}
  const data=await res.json();
  try{if(data.usage){_ibNoteReasoningUsage(data.usage,'openai',cfg,opts);var _pu4=data.usage,_pc4=(_pu4.prompt_tokens_details&&_pu4.prompt_tokens_details.cached_tokens)||(_pu4.input_tokens_details&&_pu4.input_tokens_details.cached_tokens)||_pu4.prompt_cache_hit_tokens||0;if(cfg.promptCache!==false)try{console.info('[IB缓存诊断] usage 原文: '+JSON.stringify(_pu4))}catch(e2){}_tkRecord(cfg,{i:Math.max(0,(_pu4.prompt_tokens||0)-_pc4),cr:_pc4,cw:0,o:_pu4.completion_tokens||0},opts)}}catch(e){}/* 修复：OpenAI 兼容非流式聊天此前完全不记用量；DeepSeek / Responses 形状命中字段一并兼容 */
  if(opts._fcCtx){try{opts._fcCtx._nsCalls=IBFC.extractFromResponse(opts._fcCtx,data)}catch(e){opts._fcCtx._nsCalls=null}}
  const ch=(data.choices&&data.choices[0])||{};
  try{const _annN=ch.message&&ch.message.annotations;if(_annN&&_annN.length){_ibwsFeedAnnotations(_annN,opts);_ibwsFlushSearchMeta(opts)}}catch(e){}/* 任务A */
  if(ch.message&&ch.message.reasoning_content!=null) _mSetThink(opts,String(ch.message.reasoning_content));
  if(ch.finish_reason)_mSetFinish(opts,ch.finish_reason);
  return pack((ch.message&&ch.message.content)||'',ch.finish_reason==='length');
  }catch(e){clearTimeout(tm);if(e.name==='AbortError')throw new Error('请求超时（'+Math.round(timeoutMs/1000)+'秒），请检查网络连接或API服务状态');if(e.message&&e.message.includes('not valid JSON'))throw new Error('API端点返回了非JSON内容——请检查端点URL是否正确。如使用中转站，请确认地址填写到完整API路径');throw e}
}

async function clearChatHistory(){
  if(!confirm('确定要清空所有聊天记录吗？'))return;
  /* 角色私信（roledm_*）不属于"用户与角色的聊天记录"，因此**不**被这个动作清空：
     它有自己明确的"清空聊天记录 / 删除这段私聊"入口（角色私信页）。
     否则用户在 Chat 页点一次清空，就会连带删掉两个角色之间的私人历史。 */
  const msgs=(await dbGetAll('chatMessages')).filter(m=>!ibIsRoleDmFriendId(m&&m.friendId));
  for(const m of msgs){await dbDelete('chatMessages',m.id)}
  /* Also clear all threads */
  try{const threads=await dbGetAll('chatThreads');for(const t of threads)await dbDelete('chatThreads',t.id)}catch(e){}
  /* 清理所有摘要 */
  try{const sums=await dbGetAll('chatSummaries');for(const s of sums)await dbDelete('chatSummaries',s.id)}catch(e){}
  activeThreadId=null;
  updateChatCount();updateChatStorageInfo();
  document.getElementById('chat-messages').innerHTML='<div class="chat-msg system">发送消息开始对话</div>';
  const fullC=document.getElementById('chat-full-messages');
  if(fullC)fullC.innerHTML='<div class="chat-msg system">聊天记录已清空</div>';
  
  if(currentPage==='chat')renderChatCalendar();
  toast('聊天记录已清空');
}

async function exportChatHistory(){toggleExportSection()}
async function toggleExportSection(){
  const sec=document.getElementById('export-section');
  const btn=document.getElementById('export-toggle-btn');
  /* Close delete section if open */
  const delSec=document.getElementById('delete-section');if(delSec&&delSec.classList.contains('open')){delSec.classList.remove('open');const db=document.getElementById('delete-toggle-btn');if(db)db.textContent='删除聊天记录 ▾'}
  if(sec.classList.contains('open')){sec.classList.remove('open');if(btn)btn.textContent='导出聊天记录 ▾';return}
  const msgs=(await dbGetAll('chatMessages')).filter(m=>!ibIsRoleDmFriendId(m&&m.friendId));
  if(!msgs.length){toast('没有聊天记录可导出');return}
  const grouped={};msgs.forEach(m=>{const fid=m.friendId||'unknown';if(!grouped[fid])grouped[fid]={count:0,latest:0};grouped[fid].count++;if(m.timestamp>grouped[fid].latest)grouped[fid].latest=m.timestamp});
  const groups=await loadGroups();const listEl=document.getElementById('export-chat-list');
  let html='';
  for(const [fid,info] of Object.entries(grouped)){
    let label='',icon='💬';
    if(fid.startsWith('group_')){const g=groups.find(gr=>gr.id===fid);label='群聊: '+(g?g.name:fid);icon='👥'}
    else{const cfg=apiConfigs.find(a=>a.id===fid)||archivedConfigs.find(a=>a.id===fid);label=cfg?((cfg.nickname||cfg.model||fid)+(cfg.archived?'（已归档）':'')):fid}
    html+='<label class="export-item"><input type="checkbox" class="export-chat-cb" value="'+fid+'" checked><span>'+icon+' '+esc(label)+'</span><span class="ei-info">'+info.count+'条 · '+new Date(info.latest).toLocaleDateString('zh-CN')+'</span></label>';
  }
  listEl.innerHTML=html;document.getElementById('export-select-all').checked=true;
  sec.classList.add('open');if(btn)btn.textContent='收起 ▴';
}
function toggleExportAll(){const all=document.getElementById('export-select-all').checked;document.querySelectorAll('.export-chat-cb').forEach(cb=>{cb.checked=all})}

/* --- Delete by API --- */
async function toggleDeleteSection(){
  const sec=document.getElementById('delete-section');
  const btn=document.getElementById('delete-toggle-btn');
  /* Close export section if open */
  const expSec=document.getElementById('export-section');if(expSec&&expSec.classList.contains('open')){expSec.classList.remove('open');const eb=document.getElementById('export-toggle-btn');if(eb)eb.textContent='导出聊天记录 ▾'}
  if(sec.classList.contains('open')){sec.classList.remove('open');if(btn)btn.textContent='删除聊天记录 ▾';return}
  const msgs=(await dbGetAll('chatMessages')).filter(m=>!ibIsRoleDmFriendId(m&&m.friendId));
  if(!msgs.length){toast('没有聊天记录可删除');return}
  const grouped={};msgs.forEach(m=>{const fid=m.friendId||'unknown';if(!grouped[fid])grouped[fid]={count:0,latest:0};grouped[fid].count++;if(m.timestamp>grouped[fid].latest)grouped[fid].latest=m.timestamp});
  const groups=await loadGroups();const listEl=document.getElementById('delete-chat-list');
  let html='';
  for(const [fid,info] of Object.entries(grouped)){
    let label='',icon='💬';
    if(fid.startsWith('group_')){const g=groups.find(gr=>gr.id===fid);label='群聊: '+(g?g.name:fid);icon='👥'}
    else{const cfg=apiConfigs.find(a=>a.id===fid)||archivedConfigs.find(a=>a.id===fid);label=cfg?((cfg.nickname||cfg.model||fid)+(cfg.archived?'（已归档）':'')):fid}
    html+='<label class="export-item"><input type="checkbox" class="delete-chat-cb" value="'+fid+'"><span>'+icon+' '+esc(label)+'</span><span class="ei-info">'+info.count+'条 · '+new Date(info.latest).toLocaleDateString('zh-CN')+'</span></label>';
  }
  listEl.innerHTML=html;document.getElementById('delete-select-all').checked=false;
  sec.classList.add('open');if(btn)btn.textContent='收起 ▴';
}
function toggleDeleteAll(){const all=document.getElementById('delete-select-all').checked;document.querySelectorAll('.delete-chat-cb').forEach(cb=>{cb.checked=all})}
async function confirmDeleteByApi(){
  const selected=[...document.querySelectorAll('.delete-chat-cb:checked')].map(cb=>cb.value);
  if(!selected.length){toast('请至少选择一个对话');return}
  const names=selected.map(fid=>{
    if(fid.startsWith('group_')){return '群聊'}
    const cfg=apiConfigs.find(a=>a.id===fid)||archivedConfigs.find(a=>a.id===fid);return cfg?(cfg.nickname||cfg.model||fid):fid;
  });
  if(!confirm('确定要删除以下对话的聊天记录吗？\n\n'+names.join('、')+'\n\n此操作不可撤销。'))return;
  const msgs=await dbGetAll('chatMessages');
  let count=0;
  for(const m of msgs){
    if(selected.includes(m.friendId||'unknown')){await dbDelete('chatMessages',m.id);count++}
  }
  /* Also delete threads for selected friends */
  try{const threads=await dbGetAll('chatThreads');for(const t of threads){if(selected.includes(t.friendId))await dbDelete('chatThreads',t.id)}}catch(e){}
  /* 清理相关摘要 */
  try{const sums=await dbGetAll('chatSummaries');for(const s of sums){if(selected.includes(s.friendId))await dbDelete('chatSummaries',s.id)}}catch(e){}
  updateChatCount();updateChatStorageInfo();
  /* Refresh current chat view if affected */
  if(activeFriendId&&selected.includes(activeFriendId)){
    const container=document.getElementById('chat-full-messages');
    if(container)container.innerHTML='<div class="chat-msg system">聊天记录已删除</div>';
    const miniContainer=document.getElementById('chat-messages');
    if(miniContainer)miniContainer.innerHTML='<div class="chat-msg system">聊天记录已删除</div>';
    
  }
  if(currentPage==='chat')renderChatCalendar();
  /* Close the section */
  const sec=document.getElementById('delete-section');if(sec)sec.classList.remove('open');
  const btn=document.getElementById('delete-toggle-btn');if(btn)btn.textContent='删除聊天记录 ▾';
  toast('已删除 '+count+' 条消息');
}
function _chatExportMessage(m,speaker){
  let out='['+new Date(m.timestamp).toLocaleString('zh-CN')+'] '+speaker+':\n'+(m.content||'')+'\n';
  const reasoning=_cleanThinkingText(m&&(m.reasoning_content||m.thinking)?(m.reasoning_content||m.thinking):'').trim();
  if(reasoning)out+='\n[模型推理]\n'+reasoning+'\n';
  return out+'\n'
}
async function confirmExport(){
  const selected=[...document.querySelectorAll('.export-chat-cb:checked')].map(cb=>cb.value);
  if(!selected.length){toast('请至少选择一个对话');return}
  const msgs=_ibOrderMessages(await dbGetAll('chatMessages'));/* P23 2A：导出顺序 = canonical 顺序（含回合归组） */
  const allThreads=await (async()=>{try{return await dbGetAll('chatThreads')}catch(e){return[]}})();
  const grouped={};msgs.forEach(m=>{const fid=m.friendId||'unknown';if(!selected.includes(fid))return;const key=fid+(m.threadId?'::'+m.threadId:'');if(!grouped[key])grouped[key]={fid:fid,threadId:m.threadId||null,msgs:[]};grouped[key].msgs.push(m)});
  let text='';const groups=await loadGroups();
  for(const [key,data] of Object.entries(grouped)){
    const fid=data.fid;const fMsgs=data.msgs;
    let sn='';if(fid.startsWith('group_')){const g=groups.find(gr=>gr.id===fid);sn='群聊: '+(g?g.name:fid)}else{const cfg=apiConfigs.find(a=>a.id===fid)||archivedConfigs.find(a=>a.id===fid);sn=cfg?(cfg.nickname||cfg.model||fid):fid}
    if(data.threadId){const thr=allThreads.find(t=>t.id===data.threadId);sn+=' · '+(thr?thr.name:'话题')}
    text+='══════════════════════════════\n  '+sn+' ('+fMsgs.length+'条)\n══════════════════════════════\n\n';
    fMsgs.forEach(m=>{text+=_chatExportMessage(m,m.role==='user'?(_cachedUserName||'You'):(m.senderName||sn))});text+='\n';
  }
  const blob=new Blob([text],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='chat_history_'+new Date().toISOString().slice(0,10)+'.txt';document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  toast('已导出 '+selected.length+' 个对话');
}

/* ════════ 角色私信（Role DM）与用户聊天的边界判据 ════════
   唯一真源是 assets/js/chat-core.js 的 isRoleDmFriendId（前缀 roledm_，
   与 assets/js/role-dm-core.js 的 ROLE_DM_FRIEND_PREFIX 同值）。
   本函数的唯一职责是"在不解包 payload 的前提下排除角色私信记录"，
   供全表扫描点使用（清空 / 导出 / 删除 / 计数 / 存储计量 / 日历）。
   核心不可用时返回 false（= 不排除）—— 与前缀判据的默认行为一致，
   绝不因为观测核心缺失而把**用户自己的**聊天记录误判成角色私信。 */
function ibIsRoleDmFriendId(friendId){
  try{var c=window.IBChatCore;if(c&&typeof c.isRoleDmFriendId==='function')return !!c.isRoleDmFriendId(friendId)}catch(e){}
  return String(friendId==null?'':friendId).indexOf('roledm_')===0;
}

async function updateChatCount(){
  try{
    const msgs=(await dbGetAll('chatMessages')).filter(m=>!ibIsRoleDmFriendId(m&&m.friendId));
    const el=document.getElementById('chat-count');
    if(el)el.textContent='共 '+msgs.length+' 条消息';
    updateChatStorageInfo();
  }catch(e){}
}

/* READING LIMITS */
const DEFAULT_READ_CHAT=5,DEFAULT_READ_POSTS=5,DEFAULT_READ_GROUP_CHAT=10;
/* MEMORY SETTINGS */
const DEFAULT_MEM_BUDGET=2000,DEFAULT_MEM_CONTENT_LEN=200;
async function getMemorySettings(){
  try{
    const cfg=await dbGet('apiSettings','memorySettings');
    if(!cfg)return{budget:DEFAULT_MEM_BUDGET,contentLen:DEFAULT_MEM_CONTENT_LEN,memStreaming:false};
    return{budget:cfg.budget||DEFAULT_MEM_BUDGET,contentLen:cfg.contentLen||DEFAULT_MEM_CONTENT_LEN,memStreaming:!!cfg.memStreaming};
  }catch(e){return{budget:DEFAULT_MEM_BUDGET,contentLen:DEFAULT_MEM_CONTENT_LEN,memStreaming:false}}
}
/* ── 记忆设置「自定义」辅助 ── */
function _memSettingVal(id,def,min,max){
  const sel=document.getElementById(id);
  if(!sel)return def;
  if(sel.value!=='custom')return parseInt(sel.value)||def;
  const inp=document.getElementById(id+'-custom');
  let v=parseInt(inp&&inp.value,10);
  if(isNaN(v))return def;
  v=Math.min(max,Math.max(min,v));
  if(inp)inp.value=String(v);
  return v;
}
function onMemSettingSelect(type){
  const id=type==='budget'?'api-mem-budget':'api-mem-content-len';
  const sel=document.getElementById(id);
  const inp=document.getElementById(id+'-custom');
  if(inp)inp.style.display=(sel&&sel.value==='custom')?'':'none';
  if(sel&&sel.value==='custom'&&inp&&!inp.value){inp.focus();return}
  saveMemorySettings();
}
function _applyMemSettingUI(id,val,def){
  const sel=document.getElementById(id);if(!sel)return;
  const inp=document.getElementById(id+'-custom');
  const has=[...sel.options].some(o=>o.value===String(val));
  if(has){sel.value=String(val);if(inp){inp.style.display='none';inp.value=''}}
  else{sel.value='custom';if(inp){inp.style.display='';inp.value=String(val!=null?val:def)}}
}
async function saveMemorySettings(){
  const memStreamEl=document.getElementById('api-mem-streaming-toggle');
  const budget=_memSettingVal('api-mem-budget',DEFAULT_MEM_BUDGET,100,99999);
  const contentLen=_memSettingVal('api-mem-content-len',DEFAULT_MEM_CONTENT_LEN,50,9999);
  const memStreaming=memStreamEl?!!memStreamEl.checked:false;
  await dbPut('apiSettings',{id:'memorySettings',budget,contentLen,memStreaming});
  /* Sync the Memory page dashboard hint */
  const hint=document.querySelector('.mem-deck-tok-hint');
  if(hint)hint.textContent=window.IBI18n&&window.IBI18n.t?window.IBI18n.t('memory.injectLimit',{chars:budget}):'每次注入上限约 '+budget+' 字符';
  toast('记忆设置已保存');
}
async function loadMemorySettingsUI(){
  const s=await getMemorySettings();
  _applyMemSettingUI('api-mem-budget',s.budget,DEFAULT_MEM_BUDGET);
  _applyMemSettingUI('api-mem-content-len',s.contentLen,DEFAULT_MEM_CONTENT_LEN);
  const memStreamEl=document.getElementById('api-mem-streaming-toggle');if(memStreamEl)memStreamEl.checked=!!s.memStreaming;
  updateMemStorageInfo();updateChatStorageInfo();
}
function _fmtB(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(2)+' MB'}
async function updateMemStorageInfo(){try{const all=await dbGetAll('memories');let t=0;all.forEach(m=>{try{t+=new Blob([JSON.stringify(m)]).size}catch(e){t+=JSON.stringify(m).length*2}});const el=document.getElementById('mem-storage-size');if(el)el.textContent=_fmtB(t);const bar=document.getElementById('mem-storage-bar');if(bar){const p=Math.min(100,t/5242880*100);bar.style.width=p.toFixed(1)+'%'}const c=document.getElementById('mem-storage-count');if(c)c.textContent=all.length+' 条记忆'}catch(e){}}
async function updateChatStorageInfo(){try{const all=(await dbGetAll('chatMessages')).filter(m=>!ibIsRoleDmFriendId(m&&m.friendId));let t=0,imgCount=0;all.forEach(m=>{try{t+=new Blob([JSON.stringify(m)]).size}catch(e){t+=JSON.stringify(m).length*2};if(m.images&&m.images.length)imgCount+=m.images.length});const el=document.getElementById('chat-storage-size');if(el)el.textContent=_fmtB(t);const bar=document.getElementById('chat-storage-bar');if(bar){const p=Math.min(100,t/10485760*100);bar.style.width=p.toFixed(1)+'%'}const c=document.getElementById('chat-storage-count');if(c)c.textContent=all.length+' 条消息'+(imgCount?' · '+imgCount+' 张图片':'')}catch(e){}}
async function updateDangerStorageInfo(){
  const stores=[
    {name:'chatMessages',label:'聊天记录'},
    {name:'memories',label:'记忆库'},
    {name:'letters',label:'信件'},
    {name:'posts',label:'日志'},
    {name:'blogComments',label:'日志留言'},
    {name:'apiConfigs',label:'API 配置'},
    {name:'apiSettings',label:'系统设置'},
    {name:'chatSummaries',label:'对话摘要'},
    {name:'about',label:'个人资料'},
    {name:'groups',label:'群聊'},
    {name:'chatThreads',label:'话题频道'},
    {name:'uploadedFiles',label:'上传文件'},
    {name:'categories',label:'分类'},
    {name:'music',label:'音乐'}
  ];
  let grandTotal=0;const breakdown=[];
  for(const s of stores){
    try{
      const all=await dbGetAll(s.name);let size=0;
      all.forEach(item=>{try{size+=new Blob([JSON.stringify(item)]).size}catch(e){size+=JSON.stringify(item).length*2}});
      grandTotal+=size;
      if(size>0)breakdown.push({label:s.label,size:size,count:all.length});
    }catch(e){}
  }
  breakdown.sort((a,b)=>b.size-a.size);
  const el=document.getElementById('danger-total-size');if(el)el.textContent=_fmtB(grandTotal);
  const bar=document.getElementById('danger-total-bar');if(bar){const p=Math.min(100,grandTotal/52428800*100);bar.style.width=Math.max(1,p).toFixed(1)+'%'}
}
async function getReadingLimits(){
  try{
    const cfg=await dbGet('apiSettings','readingLimits');
    if(!cfg)return{chatLimit:DEFAULT_READ_CHAT,postsLimit:DEFAULT_READ_POSTS,groupChatLimit:DEFAULT_READ_GROUP_CHAT};
    if(cfg.groupChatLimit==null)cfg.groupChatLimit=DEFAULT_READ_GROUP_CHAT;/* 旧版本保存的设置里没有这个字段，读出来时补上默认值 */
    return cfg;
  }catch(e){return{chatLimit:DEFAULT_READ_CHAT,postsLimit:DEFAULT_READ_POSTS,groupChatLimit:DEFAULT_READ_GROUP_CHAT}}
}
/* 任务5：读取范围「自定义」支撑函数 */
function _readRangeVal(base,def,min,max){
  const sel=document.getElementById('api-read-'+base);
  if(!sel)return def;
  if(sel.value!=='custom')return parseInt(sel.value);
  const inp=document.getElementById('api-read-'+base+'-custom');
  let v=parseInt(inp&&inp.value,10);
  if(isNaN(v))return def;
  v=Math.min(max,Math.max(min,v));
  if(inp)inp.value=String(v);/* 越界即时回写，所见即所存 */
  return v;
}
function onReadRangeSelect(base){
  const sel=document.getElementById('api-read-'+base);
  const inp=document.getElementById('api-read-'+base+'-custom');
  if(inp)inp.style.display=(sel&&sel.value==='custom')?'':'none';
  if(sel&&sel.value==='custom'&&inp&&!inp.value){inp.focus();return}/* 等用户输入后经 onchange 落库 */
  saveReadingLimits();
}
function _applyReadRangeUI(base,val,def){
  const sel=document.getElementById('api-read-'+base);if(!sel)return;
  const inp=document.getElementById('api-read-'+base+'-custom');
  const has=[...sel.options].some(o=>o.value===String(val));
  if(has){sel.value=String(val);if(inp){inp.style.display='none';inp.value=''}}
  else{sel.value='custom';if(inp){inp.style.display='';inp.value=String(val!=null?val:def)}}
}
async function saveReadingLimits(){
  const chatLimit=_readRangeVal('chat',DEFAULT_READ_CHAT,1,9999);
  const postsLimit=_readRangeVal('posts',DEFAULT_READ_POSTS,0,999);
  const groupChatLimit=_readRangeVal('group-chat',DEFAULT_READ_GROUP_CHAT,1,9999);
  await dbPut('apiSettings',{id:'readingLimits',chatLimit,postsLimit,groupChatLimit});
}
async function loadReadingLimitsUI(){
  const lim=await getReadingLimits();
  _applyReadRangeUI('chat',lim.chatLimit,DEFAULT_READ_CHAT);
  _applyReadRangeUI('posts',lim.postsLimit,DEFAULT_READ_POSTS);
  _applyReadRangeUI('group-chat',lim.groupChatLimit||DEFAULT_READ_GROUP_CHAT,DEFAULT_READ_GROUP_CHAT);
}
/* CONTEXT SAFETY: truncate combined context to ~8000 chars max */
function truncateContext(text,maxChars){if(!text||text.length<=maxChars)return text;return text.slice(0,maxChars)+'…（内容过长，已截断）'}


/* ===== WELCOME-BACK TIME GAP MESSAGE (Presence v2) ===== */
var _lastActiveTime=Date.now();
var _presenceStartupLastActive=0;try{_presenceStartupLastActive=parseInt(localStorage.getItem('ib_lastActive'))||0}catch(e){}
var _welcomeSent=false;
var _pageHiddenAt=0;/* 记录页面切到后台的时刻 */
function _updateLastActive(){_lastActiveTime=Date.now();try{localStorage.setItem('ib_lastActive',String(_lastActiveTime))}catch(e){}}
function _formatTime(ts){return new Date(ts).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}
function _formatDate(ts){return new Date(ts).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}
function _isSameDay(a,b){var d1=new Date(a),d2=new Date(b);return d1.getFullYear()===d2.getFullYear()&&d1.getMonth()===d2.getMonth()&&d1.getDate()===d2.getDate()}
async function _checkWelcomeBack(lastActiveOverride){
  if(_welcomeSent)return;
  const ss=await getSummarySettings();if(!ss.welcomeEnabled)return;
  let lastActive=parseInt(lastActiveOverride)||0;
  if(!lastActive){try{lastActive=parseInt(localStorage.getItem('ib_lastActive'))||0}catch(e){return}}
  if(!lastActive){_updateLastActive();return}
  const now=Date.now();
  const gap=now-lastActive;
  const intervalMs=(ss.welcomeInterval||2)*3600000;
  if(gap<intervalMs){_updateLastActive();return}
  _welcomeSent=true;_updateLastActive();
  if(!activeFriendId||!apiConfigs.length)return;
  const cfg=apiConfigs.find(a=>a.id===activeFriendId);
  if(!_ibApiReady(cfg))return;
  const isGroup=activeFriendId.startsWith('group_');if(isGroup)return;
  /* 格式化含上下文的时间缺口 */
  const hours=Math.floor(gap/3600000);const mins=Math.floor((gap%3600000)/60000);
  let dur='';if(hours>0)dur+=hours+' 小时';if(mins>0)dur+=(hours>0?' ':'')+mins+' 分钟';
  const sameDay=_isSameDay(lastActive,now);
  let gapText='[你在 '+(sameDay?'':_formatDate(lastActive)+' ')+_formatTime(lastActive)+' 离开，'
    +(sameDay?'':_formatDate(now)+' ')+_formatTime(now)+' 回来，离开约 '+dur+']';
  /* fix: 取输入框逻辑与 sendChatMessage 保持一致（按 */
  const input=currentPage==='chat'?document.getElementById('chat-full-input'):document.getElementById('chat-input');
  if(input){
    /* fix: 暂存并恢复用户未发送的草稿与待发附件，避免被自动消息覆盖/顺 */
    const _draft=input.value,_imgs=_pendingImages,_fls=_pendingFiles;
    _pendingImages=[];_pendingFiles=[];
    input.value=gapText;
    sendChatMessage();
    input.value=_draft;
    _pendingImages=_imgs;_pendingFiles=_fls;
    renderAttachPreviews();autoResizeInput(input);
  }
}
/* Track activity：click/keydown/scroll/mousemove 维持活跃 */
document.addEventListener('click',_updateLastActive);document.addEventListener('keydown',_updateLastActive);
document.addEventListener('scroll',_updateLastActive,{passive:true});document.addEventListener('mousemove',function(){_updateLastActive()},{passive:true});
/* visibilitychange：页面切后台时记录；回前台时重新检测 */
document.addEventListener('visibilitychange',function(){
  if(document.hidden){_pageHiddenAt=Date.now()}
  else{
    /* 从后台恢复：先用进入后台的时刻计算离开时长，再更新当前活跃时间 */
    if(_pageHiddenAt){const _presenceLeftAt=_pageHiddenAt;_pageHiddenAt=0;_welcomeSent=false;setTimeout(function(){_checkWelcomeBack(_presenceLeftAt)},500)}
    _updateLastActive();
  }
});

/* ===== FILE UPLOAD SUPPORT ===== */
var FILE_MAX_BYTES=50*1024*1024,FILE_MAX_COUNT=15;/* 单文件 50MB、最多 15 个 */
function pickFile(panel){
  document.querySelectorAll('.chat-attach-popup.show').forEach(p=>p.classList.remove('show'));
  const inp=document.createElement('input');inp.type='file';inp.multiple=true;
  inp.accept='.txt,.md,.markdown,.js,.mjs,.cjs,.ts,.tsx,.jsx,.vue,.svelte,.json,.jsonc,.csv,.tsv,.xml,.html,.htm,.css,.scss,.less,.py,.java,.kt,.c,.h,.cpp,.hpp,.cs,.go,.rs,.rb,.php,.swift,.lua,.sql,.sh,.bash,.zsh,.bat,.ps1,.yaml,.yml,.log,.ini,.cfg,.conf,.toml,.env,.properties,.gitignore,.dockerfile,.tex,.srt,.vtt,.pdf,.docx,.xlsx,.xls,.pptx,.rtf,.epub';
  inp.onchange=async function(){
    const files=Array.from(inp.files||[]);if(!files.length)return;
    let added=0,lastName='';const errors=[];
    for(const file of files){
      if(_pendingFiles.length>=FILE_MAX_COUNT){errors.push('最多附加 '+FILE_MAX_COUNT+' 个文件。');break}
      if(file.size>FILE_MAX_BYTES){errors.push('「'+file.name+'」超过 '+_fmtFileSize(FILE_MAX_BYTES)+' 的大小限制。');continue}
      try{
        const ext=file.name.split('.').pop()||'';
        if(_icodeIsRich(file.name)){/* 富文件：raw 存原始 base64 供归档，text 存提取文本供发送 */
          const raw=await _wsFileToDataUrl(file,file.name);
          const rt=await _wsExtractRichText({path:file.name,content:raw,size:file.size});
          _pendingFiles.push({name:file.name,text:rt,size:file.size,ext:ext,raw:raw});
        }else{
          const text=await file.text();
          _pendingFiles.push({name:file.name,text:text,size:file.size,ext:ext});
        }
        added++;lastName=file.name;
      }catch(e){errors.push('「'+file.name+'」读取失败，请重新选择。')}
    }
    renderAttachPreviews();
    if(errors.length)_chatSetComposerFeedback(panel,errors.join(' '));
    else if(added)_chatSetComposerFeedback(panel,'');
    if(added===1)toast('已添加文件: '+lastName);
    else if(added>1)toast('已添加 '+added+' 个文件');
  };inp.click();
}

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.chat 登记全部导出 ---- */
function ibChatLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.loadBlogComments=loadBlogComments;
window.requestBlogComment=requestBlogComment;
window.deleteBlogComment=deleteBlogComment;
window.callApi=callApi;
window._ibApiPost=_ibApiPost;/* 暴露统一传输（Bridge-aware CORS 处理），供 Middle Brain 等复用 */
window._ibProxyShouldRoute=_ibProxyShouldRoute;
window.initChatHeader=initChatHeader;
window._ibDockSwap=_ibDockSwap;
window._ibDockMorph=_ibDockMorph;
window.openChatPanel=openChatPanel;
window.closeChatPanel=closeChatPanel;
window._getApiAvatar=_getApiAvatar;
window._getApiAvatarByName=_getApiAvatarByName;
window._messageApiConfig=_messageApiConfig;
window._messageShowThinking=_messageShowThinking;
window._buildChatThinkingEl=_buildChatThinkingEl;
window._ensureStreamThinking=_ensureStreamThinking;
window._appendStreamThinking=_appendStreamThinking;
window._finishStreamThinking=_finishStreamThinking;
window._buildAvatarCircle=_buildAvatarCircle;
window._buildMsgEl=_buildMsgEl;
window._refreshCachedUserName=_refreshCachedUserName;
window.updateNavUserIdentity=updateNavUserIdentity;
window._getActiveAiName=_getActiveAiName;
window._chatWinMsgEl=_chatWinMsgEl;
window._renderAllChat=_renderAllChat;
window._chatWinPin=_chatWinPin;
window._chatWinBind=_chatWinBind;
window._chatWinMore=_chatWinMore;
window._renderPanelList=_renderPanelList;
window.loadChatMessages=loadChatMessages;
window._ibInjectMax=_ibInjectMax;
window._capFileText=_capFileText;
window.toggleAttachPopup=toggleAttachPopup;
window.pickImage=pickImage;
window.compressImage=compressImage;
window.DEEPSEEK_NATIVE_VISION_MODEL=DEEPSEEK_NATIVE_VISION_MODEL;
window._isDeepSeekNativeVisionModel=_isDeepSeekNativeVisionModel;
window._usesNativeDeepSeekVision=_usesNativeDeepSeekVision;
window._usesLocalDeepSeekVision=_usesLocalDeepSeekVision;
window._localVisionCacheKey=_localVisionCacheKey;
window._requestLocalVision=_requestLocalVision;
window._describeImagesLocally=_describeImagesLocally;
window._appendLocalVisionContext=_appendLocalVisionContext;
window.renderImagePreviews=renderImagePreviews;
window.renderAttachPreviews=renderAttachPreviews;
window.removeImagePreview=removeImagePreview;
window.removeFilePreview=removeFilePreview;
window._fmtFileSize=_fmtFileSize;
window._buildFileCard=_buildFileCard;
window._parseFileBlocks=_parseFileBlocks;
window._downloadTextFile=_downloadTextFile;
window._buildDownloadCard=_buildDownloadCard;
window._wsAttr=_wsAttr;
window._mdMode=_mdMode;
window._mdCleanOn=_mdCleanOn;
window._mdSaveModeChange=_mdSaveModeChange;
window._mdSaveCleanToggle=_mdSaveCleanToggle;
window._hasCJK=_hasCJK;
window._mdRenderHtml=_mdRenderHtml;
window._mdSoften=_mdSoften;
window._mkLiveMdCleaner=_mkLiveMdCleaner;
window._segmentAiText=_segmentAiText;
window._wsStubHistory=_wsStubHistory;
window._cleanThinkingText=_cleanThinkingText;
window._panelMdHost=_panelMdHost;
window._renderSegments=_renderSegments;
window._renderAiContent=_renderAiContent;
window.getTextContent=getTextContent;
window._viewImageFull=_viewImageFull;
window.chatKeyDown=chatKeyDown;
window._markUnread=_markUnread;
window._clearUnread=_clearUnread;
window._updateUnreadUI=_updateUnreadUI;
window._escRe=_escRe;
window.sanitizeGroupReply=sanitizeGroupReply;
window.collapseSameRole=collapseSameRole;
window.sendChatMessage=sendChatMessage;
window.appendChatBubble=appendChatBubble;
window.deleteSingleMsg=deleteSingleMsg;
/* P23 Phase 2B · Delivery Runtime 的桌面接缝（供 App / 测试 / 诊断只读观察与取消） */
window._ibDeliveryRuntime=_ibDeliveryRuntime;
window._ibStartDelivery=_ibStartDelivery;
window._ibDeliveryAbort=_ibDeliveryAbort;
window._ibDeliveryPending=_ibDeliveryPending;
window._ibConvId=_ibConvId;
/* P30-2 · 会话归属 filter（测试/诊断入口；生产内部直接调用同一函数） */
window._ibWsScopeFilter=_ibWsScopeFilter;
/* R3 · media queue partition/normalization seam (test + diagnostics; no new manager) */
window._ibTakeScopedMedia=_ibTakeScopedMedia;
window._ibMediaPromptImage=_ibMediaPromptImage;
window._ibTypingOn=_ibTypingOn;
window._ibTypingOff=_ibTypingOff;
window._ibTypingFinish=_ibTypingFinish;
/* P23 Phase 2D · Multimodal Delivery Policy 的桌面接缝（诊断 / 测试 / 未来上层） */
window._ibMmResolve=_ibMmResolve;
window._ibVoiceCapability=_ibVoiceCapability;
window._ibMmIntent=_ibMmIntent;
window._ibMaterializeVoiceUnit=_ibMaterializeVoiceUnit;
window._ibBuildUnitAt=_ibBuildUnitAt;
window.autoResizeInput=autoResizeInput;
window._parseThinking=_parseThinking;
window._assistantResponseParts=_assistantResponseParts;
window._anthropicWebThinkResponseMode=_anthropicWebThinkResponseMode;
window._mergeAnthropicWebThink=_mergeAnthropicWebThink;
window._makeAnthropicWebThinkMux=_makeAnthropicWebThinkMux;
window._cacheStableSlice=_cacheStableSlice;
window._ccObj=_ccObj;
window._ccBeta=_ccBeta;
window._ibCacheAudit=_ibCacheAudit;
window._ibOaiCacheDiag=_ibOaiCacheDiag;
window._injectAnthropicMsgCache=_injectAnthropicMsgCache;
window._adaptContentForApi=_adaptContentForApi;
window._adaptMessageForApi=_adaptMessageForApi;
window._ibModelCanSee=_ibModelCanSee;/* App Store ctx.chat.canSee 的既有依赖（此前漏导出 → 留影能力门 ReferenceError） */
window._newCallState=_newCallState;
window._endCallState=_endCallState;
window._mSetThink=_mSetThink;
window._mSetFinish=_mSetFinish;
window._finishIsTrunc=_finishIsTrunc;
window.stopStreaming=stopStreaming;
window.stopMemoryStreaming=stopMemoryStreaming;
window._showStreamingUI=_showStreamingUI;
window._chatSyncComposerBusy=_chatSyncComposerBusy;
window._chatSetComposerFeedback=_chatSetComposerFeedback;
window._chatAppendInlineStatus=_chatAppendInlineStatus;
window._chatAppendErrorDisclosure=_chatAppendErrorDisclosure;
window._chatMaxTokens=_chatMaxTokens;
window._errLooksMaxTok=_errLooksMaxTok;
window._errWantsCompletionParam=_errWantsCompletionParam;
window._tokParamKey=_tokParamKey;
window._tokParamGet=_tokParamGet;
window._tokParamRemember=_tokParamRemember;
window._extractSuggestedMaxTok=_extractSuggestedMaxTok;
window._wsDedupSeam=_wsDedupSeam;
window.loadOutputSettings=loadOutputSettings;
window.saveOutputSettings=saveOutputSettings;
window.callApiChatStream=callApiChatStream;
window.callApiChat=callApiChat;
window._ibwsFeedGrounding=_ibwsFeedGrounding;
window._ibwsFeedAnnotations=_ibwsFeedAnnotations;
window._ibwsFlushSearchMeta=_ibwsFlushSearchMeta;
window._callApiChatStreamOnce=_callApiChatStreamOnce;
window._syncMiniAfterStream=_syncMiniAfterStream;
window._createStreamBubble=_createStreamBubble;
window._callApiChatOnce=_callApiChatOnce;
window.clearChatHistory=clearChatHistory;
window.exportChatHistory=exportChatHistory;
window.toggleExportSection=toggleExportSection;
window.toggleExportAll=toggleExportAll;
window.toggleDeleteSection=toggleDeleteSection;
window.toggleDeleteAll=toggleDeleteAll;
window.confirmDeleteByApi=confirmDeleteByApi;
window._chatExportMessage=_chatExportMessage;
window.confirmExport=confirmExport;
window.updateChatCount=updateChatCount;
window.getMemorySettings=getMemorySettings;
window._memSettingVal=_memSettingVal;
window.onMemSettingSelect=onMemSettingSelect;
window._applyMemSettingUI=_applyMemSettingUI;
window.saveMemorySettings=saveMemorySettings;
window.loadMemorySettingsUI=loadMemorySettingsUI;
window._fmtB=_fmtB;
window.updateMemStorageInfo=updateMemStorageInfo;
window.updateChatStorageInfo=updateChatStorageInfo;
window.updateDangerStorageInfo=updateDangerStorageInfo;
window.getReadingLimits=getReadingLimits;
window._readRangeVal=_readRangeVal;
window.onReadRangeSelect=onReadRangeSelect;
window._applyReadRangeUI=_applyReadRangeUI;
window.saveReadingLimits=saveReadingLimits;
window.loadReadingLimitsUI=loadReadingLimitsUI;
window.truncateContext=truncateContext;
/* P11-3X-C · 上下文预算的可观测面（只读）。只暴露"量测与状态"，
   不含任何正文：供诊断页 / 测试读取"这一回合到底送了多少 token"。
   唯一事实源仍是 assets/js/context-budget-core.js。 */
window.IBContextBudget={
  core:function(){return _ibBudgetCore()},
  history:_ibBudgetHistory,
  last:function(){const h=_ibBudgetHistory();return h.length?h[h.length-1]:null},
  toolsTokens:_ibToolsTokens,
  ceiling:function(cfg){const c=_ibBudgetCore();return c?c.APP_CEILING_TOKENS:0}
};
window._updateLastActive=_updateLastActive;
window._formatTime=_formatTime;
window._formatDate=_formatDate;
window._isSameDay=_isSameDay;
window._checkWelcomeBack=_checkWelcomeBack;
window.pickFile=pickFile;
window.IMG_MAX_PX=IMG_MAX_PX;
window.FILE_INJECT_DEFAULT=FILE_INJECT_DEFAULT;
window.LOCAL_VISION_ENDPOINT=LOCAL_VISION_ENDPOINT;
window._localVisionCache=_localVisionCache;
window._unreadFriends=_unreadFriends;
window._PROVIDER_MAX_OUT=_PROVIDER_MAX_OUT;
window._WS_CONT_PROMPT=_WS_CONT_PROMPT;
window._appendMsgText=_appendMsgText;
window.DEFAULT_READ_CHAT=DEFAULT_READ_CHAT;
window.DEFAULT_MEM_BUDGET=DEFAULT_MEM_BUDGET;
window.IMG_QUALITY=IMG_QUALITY;
window.IMG_MAX_COUNT=IMG_MAX_COUNT;
window.IMG_MAX_BYTES=IMG_MAX_BYTES;
window.DEFAULT_READ_POSTS=DEFAULT_READ_POSTS;
window.DEFAULT_READ_GROUP_CHAT=DEFAULT_READ_GROUP_CHAT;
window.DEFAULT_MEM_CONTENT_LEN=DEFAULT_MEM_CONTENT_LEN;
ibChatLive('_cachedUserName', function(){return _cachedUserName}, function(v){_cachedUserName=v});
ibChatLive('_cachedUserAvatar', function(){return _cachedUserAvatar}, function(v){_cachedUserAvatar=v});
ibChatLive('_CHAT_WIN', function(){return _CHAT_WIN}, function(v){_CHAT_WIN=v});
ibChatLive('_pendingImages', function(){return _pendingImages}, function(v){_pendingImages=v});
ibChatLive('_pendingFiles', function(){return _pendingFiles}, function(v){_pendingFiles=v});
ibChatLive('_attachCloseHandler', function(){return _attachCloseHandler}, function(v){_attachCloseHandler=v});
ibChatLive('_WS_OPEN_RE', function(){return _WS_OPEN_RE}, function(v){_WS_OPEN_RE=v});
ibChatLive('_lastApiReasoning', function(){return _lastApiReasoning}, function(v){_lastApiReasoning=v});
ibChatLive('_ibCacheAuditPrev', function(){return _ibCacheAuditPrev}, function(v){_ibCacheAuditPrev=v});
ibChatLive('_streamAbortController', function(){return _streamAbortController}, function(v){_streamAbortController=v});
ibChatLive('_lastApiFinish', function(){return _lastApiFinish}, function(v){_lastApiFinish=v});
ibChatLive('_chatCallStates', function(){return _chatCallStates}, function(v){_chatCallStates=v});
ibChatLive('_memStreamAbortController', function(){return _memStreamAbortController}, function(v){_memStreamAbortController=v});
ibChatLive('_memStreamWasStopped', function(){return _memStreamWasStopped}, function(v){_memStreamWasStopped=v});
ibChatLive('_tokParamMem', function(){return _tokParamMem}, function(v){_tokParamMem=v});
ibChatLive('_maxContinuesPref', function(){return _maxContinuesPref}, function(v){_maxContinuesPref=v});
ibChatLive('_lastActiveTime', function(){return _lastActiveTime}, function(v){_lastActiveTime=v});
ibChatLive('_presenceStartupLastActive', function(){return _presenceStartupLastActive}, function(v){_presenceStartupLastActive=v});
ibChatLive('_welcomeSent', function(){return _welcomeSent}, function(v){_welcomeSent=v});
ibChatLive('_pageHiddenAt', function(){return _pageHiddenAt}, function(v){_pageHiddenAt=v});
ibChatLive('FILE_MAX_BYTES', function(){return FILE_MAX_BYTES}, function(v){FILE_MAX_BYTES=v});
ibChatLive('FILE_MAX_COUNT', function(){return FILE_MAX_COUNT}, function(v){FILE_MAX_COUNT=v});
NS.expose('chat', {
  MessagePresentation: window.MessagePresentation,
  loadBlogComments: loadBlogComments,
  requestBlogComment: requestBlogComment,
  deleteBlogComment: deleteBlogComment,
  buildChatContext: buildChatContext,
  contextBudgetHistory: _ibBudgetHistory,
  callApi: callApi,
  initChatHeader: initChatHeader,
  _ibDockSwap: _ibDockSwap,
  _ibDockMorph: _ibDockMorph,
  openChatPanel: openChatPanel,
  closeChatPanel: closeChatPanel,
  _getApiAvatar: _getApiAvatar,
  _getApiAvatarByName: _getApiAvatarByName,
  _messageApiConfig: _messageApiConfig,
  _messageShowThinking: _messageShowThinking,
  _buildChatThinkingEl: _buildChatThinkingEl,
  _ensureStreamThinking: _ensureStreamThinking,
  _appendStreamThinking: _appendStreamThinking,
  _finishStreamThinking: _finishStreamThinking,
  _buildAvatarCircle: _buildAvatarCircle,
  _buildMsgEl: _buildMsgEl,
  _refreshCachedUserName: _refreshCachedUserName,
  updateNavUserIdentity: updateNavUserIdentity,
  _getActiveAiName: _getActiveAiName,
  _chatWinMsgEl: _chatWinMsgEl,
  _renderAllChat: _renderAllChat,
  _chatWinPin: _chatWinPin,
  _chatWinBind: _chatWinBind,
  _chatWinMore: _chatWinMore,
  _renderPanelList: _renderPanelList,
  loadChatMessages: loadChatMessages,
  _ibInjectMax: _ibInjectMax,
  _capFileText: _capFileText,
  toggleAttachPopup: toggleAttachPopup,
  pickImage: pickImage,
  compressImage: compressImage,
  DEEPSEEK_NATIVE_VISION_MODEL: DEEPSEEK_NATIVE_VISION_MODEL,
  _isDeepSeekNativeVisionModel: _isDeepSeekNativeVisionModel,
  _usesNativeDeepSeekVision: _usesNativeDeepSeekVision,
  _usesLocalDeepSeekVision: _usesLocalDeepSeekVision,
  _localVisionCacheKey: _localVisionCacheKey,
  _requestLocalVision: _requestLocalVision,
  _describeImagesLocally: _describeImagesLocally,
  _appendLocalVisionContext: _appendLocalVisionContext,
  renderImagePreviews: renderImagePreviews,
  renderAttachPreviews: renderAttachPreviews,
  removeImagePreview: removeImagePreview,
  removeFilePreview: removeFilePreview,
  _fmtFileSize: _fmtFileSize,
  _buildFileCard: _buildFileCard,
  _parseFileBlocks: _parseFileBlocks,
  _downloadTextFile: _downloadTextFile,
  _buildDownloadCard: _buildDownloadCard,
  _wsAttr: _wsAttr,
  _mdMode: _mdMode,
  _mdCleanOn: _mdCleanOn,
  _mdSaveModeChange: _mdSaveModeChange,
  _mdSaveCleanToggle: _mdSaveCleanToggle,
  _hasCJK: _hasCJK,
  _mdRenderHtml: _mdRenderHtml,
  _mdSoften: _mdSoften,
  _mkLiveMdCleaner: _mkLiveMdCleaner,
  _segmentAiText: _segmentAiText,
  _wsStubHistory: _wsStubHistory,
  _cleanThinkingText: _cleanThinkingText,
  _panelMdHost: _panelMdHost,
  _renderSegments: _renderSegments,
  _renderAiContent: _renderAiContent,
  getTextContent: getTextContent,
  _viewImageFull: _viewImageFull,
  chatKeyDown: chatKeyDown,
  _markUnread: _markUnread,
  _clearUnread: _clearUnread,
  _updateUnreadUI: _updateUnreadUI,
  _escRe: _escRe,
  sanitizeGroupReply: sanitizeGroupReply,
  collapseSameRole: collapseSameRole,
  sendChatMessage: sendChatMessage,
  appendChatBubble: appendChatBubble,
  deleteSingleMsg: deleteSingleMsg,
  autoResizeInput: autoResizeInput,
  _parseThinking: _parseThinking,
  _assistantResponseParts: _assistantResponseParts,
  _anthropicWebThinkResponseMode: _anthropicWebThinkResponseMode,
  _mergeAnthropicWebThink: _mergeAnthropicWebThink,
  _makeAnthropicWebThinkMux: _makeAnthropicWebThinkMux,
  _cacheStableSlice: _cacheStableSlice,
  _ccObj: _ccObj,
  _ccBeta: _ccBeta,
  _ibCacheAudit: _ibCacheAudit,
  _ibOaiCacheDiag: _ibOaiCacheDiag,
  _injectAnthropicMsgCache: _injectAnthropicMsgCache,
  _adaptContentForApi: _adaptContentForApi,
  _adaptMessageForApi: _adaptMessageForApi,
  _newCallState: _newCallState,
  _endCallState: _endCallState,
  _mSetThink: _mSetThink,
  _mSetFinish: _mSetFinish,
  _finishIsTrunc: _finishIsTrunc,
  stopStreaming: stopStreaming,
  stopMemoryStreaming: stopMemoryStreaming,
  _showStreamingUI: _showStreamingUI,
  _chatMaxTokens: _chatMaxTokens,
  _errLooksMaxTok: _errLooksMaxTok,
  _errWantsCompletionParam: _errWantsCompletionParam,
  _tokParamKey: _tokParamKey,
  _tokParamGet: _tokParamGet,
  _tokParamRemember: _tokParamRemember,
  _extractSuggestedMaxTok: _extractSuggestedMaxTok,
  _wsDedupSeam: _wsDedupSeam,
  loadOutputSettings: loadOutputSettings,
  saveOutputSettings: saveOutputSettings,
  callApiChatStream: callApiChatStream,
  callApiChat: callApiChat,
  _ibwsFeedGrounding: _ibwsFeedGrounding,
  _ibwsFeedAnnotations: _ibwsFeedAnnotations,
  _ibwsFlushSearchMeta: _ibwsFlushSearchMeta,
  _callApiChatStreamOnce: _callApiChatStreamOnce,
  _syncMiniAfterStream: _syncMiniAfterStream,
  _createStreamBubble: _createStreamBubble,
  _callApiChatOnce: _callApiChatOnce,
  clearChatHistory: clearChatHistory,
  exportChatHistory: exportChatHistory,
  toggleExportSection: toggleExportSection,
  toggleExportAll: toggleExportAll,
  toggleDeleteSection: toggleDeleteSection,
  toggleDeleteAll: toggleDeleteAll,
  confirmDeleteByApi: confirmDeleteByApi,
  _chatExportMessage: _chatExportMessage,
  confirmExport: confirmExport,
  updateChatCount: updateChatCount,
  getMemorySettings: getMemorySettings,
  _memSettingVal: _memSettingVal,
  onMemSettingSelect: onMemSettingSelect,
  _applyMemSettingUI: _applyMemSettingUI,
  saveMemorySettings: saveMemorySettings,
  loadMemorySettingsUI: loadMemorySettingsUI,
  _fmtB: _fmtB,
  updateMemStorageInfo: updateMemStorageInfo,
  updateChatStorageInfo: updateChatStorageInfo,
  updateDangerStorageInfo: updateDangerStorageInfo,
  getReadingLimits: getReadingLimits,
  _readRangeVal: _readRangeVal,
  onReadRangeSelect: onReadRangeSelect,
  _applyReadRangeUI: _applyReadRangeUI,
  saveReadingLimits: saveReadingLimits,
  loadReadingLimitsUI: loadReadingLimitsUI,
  truncateContext: truncateContext,
  _updateLastActive: _updateLastActive,
  _formatTime: _formatTime,
  _formatDate: _formatDate,
  _isSameDay: _isSameDay,
  _checkWelcomeBack: _checkWelcomeBack,
  pickFile: pickFile,
  IMG_MAX_PX: IMG_MAX_PX,
  FILE_INJECT_DEFAULT: FILE_INJECT_DEFAULT,
  LOCAL_VISION_ENDPOINT: LOCAL_VISION_ENDPOINT,
  _localVisionCache: _localVisionCache,
  _unreadFriends: _unreadFriends,
  _PROVIDER_MAX_OUT: _PROVIDER_MAX_OUT,
  _WS_CONT_PROMPT: _WS_CONT_PROMPT,
  DEFAULT_READ_CHAT: DEFAULT_READ_CHAT,
  DEFAULT_MEM_BUDGET: DEFAULT_MEM_BUDGET,
  IMG_QUALITY: IMG_QUALITY,
  IMG_MAX_COUNT: IMG_MAX_COUNT,
  IMG_MAX_BYTES: IMG_MAX_BYTES,
  DEFAULT_READ_POSTS: DEFAULT_READ_POSTS,
  DEFAULT_READ_GROUP_CHAT: DEFAULT_READ_GROUP_CHAT,
  DEFAULT_MEM_CONTENT_LEN: DEFAULT_MEM_CONTENT_LEN,
  _cachedUserName: _cachedUserName,
  _cachedUserAvatar: _cachedUserAvatar,
  _CHAT_WIN: _CHAT_WIN,
  _pendingImages: _pendingImages,
  _pendingFiles: _pendingFiles,
  /* P23 Phase 2B · Delivery Runtime 接缝 */
  _ibDeliveryRuntime: _ibDeliveryRuntime,
  _ibStartDelivery: _ibStartDelivery,
  _ibDeliveryAbort: _ibDeliveryAbort,
  _ibDeliveryPending: _ibDeliveryPending,
  _ibConvId: _ibConvId,
  _ibTakeScopedMedia: _ibTakeScopedMedia,
  _ibMediaPromptImage: _ibMediaPromptImage,
  _ibTypingOn: _ibTypingOn,
  _ibTypingOff: _ibTypingOff,
  _ibTypingFinish: _ibTypingFinish,
  /* P23 Phase 2D · Multimodal Delivery Policy 接缝 */
  _ibMmResolve: _ibMmResolve,
  _ibVoiceCapability: _ibVoiceCapability,
  _ibMmIntent: _ibMmIntent,
  _ibMaterializeVoiceUnit: _ibMaterializeVoiceUnit,
  _ibBuildUnitAt: _ibBuildUnitAt,
  _attachCloseHandler: _attachCloseHandler,
  _WS_OPEN_RE: _WS_OPEN_RE,
  _lastApiReasoning: _lastApiReasoning,
  _ibCacheAuditPrev: _ibCacheAuditPrev,
  _streamAbortController: _streamAbortController,
  _lastApiFinish: _lastApiFinish,
  _chatCallStates: _chatCallStates,
  _memStreamAbortController: _memStreamAbortController,
  _memStreamWasStopped: _memStreamWasStopped,
  _tokParamMem: _tokParamMem,
  _maxContinuesPref: _maxContinuesPref,
  _lastActiveTime: _lastActiveTime,
  _presenceStartupLastActive: _presenceStartupLastActive,
  _welcomeSent: _welcomeSent,
  _pageHiddenAt: _pageHiddenAt,
  FILE_MAX_BYTES: FILE_MAX_BYTES,
  FILE_MAX_COUNT: FILE_MAX_COUNT,
});
})(window.IB || (window.IB = {}));
