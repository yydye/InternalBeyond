/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.chat 注册）。letters 域已提取到 communication/letters.js。 */
(function(NS){
/* BLOG COMMENTS */
async function loadBlogComments(postId){
  const container=document.getElementById('blog-comments-'+postId);
  if(!container)return;
  const all=await dbGetAll('blogComments');
  const comments=all.filter(c=>c.postId===postId).sort((a,b)=>b.created-a.created);
  if(!comments.length){container.innerHTML='<div style="font-size:0.78rem;color:var(--text-muted);padding:8px 0;opacity:0.7">还没有留言</div>';return}
  container.innerHTML=comments.map(c=>'<div class="blog-comment-card"><div class="blog-comment-from">'+esc(c.from||'AI')+'</div><div class="blog-comment-text">'+esc(c.content)+'</div><div class="blog-comment-time">'+new Date(c.created).toLocaleString('zh-CN')+'</div><div class="blog-comment-actions"><button class="btn" style="font-size:0.7rem;padding:3px 8px" onclick="deleteBlogComment(\''+c.id+'\',\''+c.postId+'\')">删除</button></div></div>').join('');
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

    const response=await callApi(cfg,(_amC.sys?_amC.sys+'\n\n':'')+context);
    const le=document.getElementById('blog-comment-loading');if(le)le.remove();

    let _cm={clean:String(response||''),ops:[]};
    try{_cm=_parseMemOps(String(response||''))}catch(e){}
    if(_cm.ops.length&&amEnabled(cfg)&&!cfg.amRecordOnly){try{await _execMemOps(_cm.ops,cfg,cfg.nickname||cfg.model||'AI')}catch(e){}}
    if(!_cm.clean||!_cm.clean.trim()){toast('AI 返回了空内容，未生成留言；请稍后重试');}
    else{
      const comment={id:'comment_'+Date.now(),postId:postId,from:cfg.nickname||cfg.model,content:_cm.clean,friendId:cfg.id,created:Date.now()};
      await dbPut('blogComments',comment);
      loadBlogComments(postId);
      toast('收到 '+(cfg.nickname||'AI')+' 的留言！');
    }
  }catch(e){
    const le=document.getElementById('blog-comment-loading');if(le)le.remove();
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


/* API CALL HELPER */
async function callApi(cfg,userMsg){
  const format=PROVIDERS[cfg.provider]?.format||'openai';
  let url=cfg.endpoint;
  let headers={'Content-Type':'application/json'};
  let body;
  if(format==='anthropic'){
    headers['x-api-key']=cfg.apiKey;
    headers['anthropic-version']='2023-06-01';
    headers['anthropic-dangerous-direct-browser-access']='true';
    _ccBeta(headers,cfg);
    const ab={model:cfg.model,max_tokens:4096,messages:[{role:'user',content:userMsg}]};
    if(cfg.systemPrompt){if(cfg.promptCache!==false){ab.system=[{type:'text',text:cfg.systemPrompt,cache_control:_ccObj(cfg)}]}else{ab.system=cfg.systemPrompt}}
    if(cfg.temperature!=null)ab.temperature=cfg.temperature;
    body=JSON.stringify(ab);
  }else if(format==='gemini'){
    url=url.replace('{model}',cfg.model)+'?key='+cfg.apiKey;
    const gb={contents:[{parts:[{text:(cfg.systemPrompt?cfg.systemPrompt+'\n\n':'')+userMsg}]}]};
    gb.generationConfig={maxOutputTokens:4096};
    if(cfg.temperature!=null)gb.generationConfig.temperature=cfg.temperature;
    body=JSON.stringify(gb);
  }else{
    if(cfg.apiKey)headers['Authorization']='Bearer '+cfg.apiKey;
    const msgs=[];
    if(cfg.systemPrompt)msgs.push({role:'system',content:cfg.systemPrompt});
    msgs.push({role:'user',content:userMsg});
    const ob={model:cfg.model,messages:msgs};ob[_tokParamGet(cfg)||'max_tokens']=4096;/* GPT-5 系要求 max_completion_tokens；参数名与聊天通道共用同一份会话记忆 */
    if(cfg.promptCache!==false)ob.prompt_cache_key='ib_'+String(cfg.id||'');/* OpenAI 缓存本自动生效；此 key 只用于提升路由命中率 */
    if(cfg.temperature!=null)ob.temperature=cfg.temperature;
    body=JSON.stringify(ob);
  }
  const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),120000);
  try{
    let res;
    for(let _try=0;;_try++){
      res=await fetch(url,{method:'POST',headers,body,signal:ac.signal});
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
function _messageShowThinking(m){
  const cfg=_messageApiConfig(m);
  if(cfg)return _resolveShowThinking(cfg);
  if(m&&m.metadata&&typeof m.metadata.showThinking==='boolean')return m.metadata.showThinking;
  return _resolveShowThinking({provider:m&&m.metadata&&m.metadata.model,model:m&&m.metadata&&m.metadata.model_id})
}
function _buildChatThinkingEl(text,compact,expanded){
  const wrap=document.createElement('div');wrap.className='chat-thinking-wrap'+(expanded?' expanded':'');
  if(compact)wrap.style.cssText='max-width:100%;margin:0 0 4px 0';
  const toggle=document.createElement('div');toggle.className='chat-thinking-toggle'+(expanded?' open':'');
  toggle.innerHTML='<span class="think-arrow">▸</span><span class="think-label">thinking</span>';
  toggle.onclick=function(){wrap.classList.toggle('expanded');toggle.classList.toggle('open')};
  wrap.appendChild(toggle);
  const body=document.createElement('div');body.className='chat-thinking-body';body.style.whiteSpace='pre-wrap';body.textContent=text||'';
  wrap.appendChild(body);
  return {wrap,toggle,body}
}
function _ensureStreamThinking(refs,registry){
  if(registry.length)return;
  refs.forEach(function(ref){
    const el=_buildChatThinkingEl('',!ref.full,true);
    el.body.classList.add('chat-stream-cursor');
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
  registry.forEach(function(e){if(text!=null)e.body.textContent=text;e.wrap.classList.remove('expanded');e.toggle.classList.remove('open');e.body.classList.remove('chat-stream-cursor')})
}
function _buildAvatarCircle(name,src,size){
  var d=document.createElement('div');d.className='chat-msg-avatar';
  if(size){d.style.width=size+'px';d.style.height=size+'px';d.style.fontSize=(size*0.4)+'px'}
  if(src){var img=document.createElement('img');img.src=src;img.alt='';d.appendChild(img)}
  else{d.textContent=(name||'?').charAt(0).toUpperCase()}
  return d;
}
function _buildMsgEl(m,isFullscreen,isGroupCont){
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
      div.dataset.senderRole=isUser?'user':'ai';
      var _isGrpMsg=!isUser&&(m.friendId||'').startsWith('group_');
      div.dataset.senderId=isUser?'_user_':(_isGrpMsg?((m.metadata&&m.metadata.config_id)||m.senderName||''):(m.friendId||activeFriendId||''));
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
      if(!isUser){_renderAiContent(txt,div,_displayContent);if(m.truncated)txt.appendChild(_buildContinuePill(m.id))}else if(m.voice){if(m.content)txt.appendChild(document.createTextNode(m.content));txt.appendChild(_buildVoiceEl(m.voice))}else{txt.textContent=m.content}
      div.appendChild(txt);
    }else{
      /* ── Original layout for AI without avatar ── */
      const head=document.createElement('div');head.className='r-head';
      head.innerHTML=esc(sName)+(timeStr?'<span class="r-time">'+timeStr+'</span>':'');
      div.appendChild(head);
      const txt=document.createElement('div');txt.className='r-text';
      if(!isUser){_renderAiContent(txt,div,_displayContent);if(m.truncated)txt.appendChild(_buildContinuePill(m.id))}else if(m.voice){if(m.content)txt.appendChild(document.createTextNode(m.content));txt.appendChild(_buildVoiceEl(m.voice))}else{txt.textContent=m.content}
      div.appendChild(txt);
    }
    if(m.files&&m.files.length)m.files.forEach(function(f){div.appendChild(_buildFileCard(f))});
    if(m.images&&m.images.length)m.images.forEach(function(img){var el=document.createElement('img');el.className='chat-bubble-img';el.loading='lazy';el.decoding='async';el.src=img.dataUrl;el.alt=img.name||'image';el.onclick=function(){_viewImageFull(img.dataUrl)};div.appendChild(el)});
    if(m.wsSearches||m.memOps)_amAppendExtraCards(div,m.wsSearches||[],m.memOps||[]);
    if(m.calNotes&&window.IBCAL)try{m.calNotes.forEach(function(r){div.appendChild(IBCAL.noteCard(r))})}catch(e){}
    if(m.id){const db=document.createElement('button');db.className='chat-msg-del';db.textContent='✕';db.title='删除此消息';db.onclick=function(ev){ev.stopPropagation();deleteSingleMsg(m.id,div,frag)};div.appendChild(db)}
  }else{
    /* Classic panel uses the same per-model showThinking decision as fullscreen. */
    if(!isUser&&m.senderName){
      var _pm=_mdMode();if(_pm==='full'||_pm==='partial')div.classList.add('md-rendered');
      const label=document.createElement('span');
      label.style.cssText='font-size:0.68rem;opacity:0.7;display:block;margin-bottom:2px';
      label.textContent=m.senderName;
      div.appendChild(label);
      _renderSegments(_panelMdHost(div),_displayContent);
    }else if(!isUser){
      var _pm2=_mdMode();if(_pm2==='full'||_pm2==='partial')div.classList.add('md-rendered');
      _renderSegments(_panelMdHost(div),_displayContent);
    }else if(m.voice){
      if(m.content)div.appendChild(document.createTextNode(m.content));
      div.appendChild(_buildVoiceEl(m.voice));
    }else{
      div.textContent=m.content;
    }
    if(m.files&&m.files.length)m.files.forEach(function(f){div.appendChild(_buildFileCard(f))});
    if(m.images&&m.images.length)m.images.forEach(function(img){var el=document.createElement('img');el.className='chat-bubble-img';el.loading='lazy';el.decoding='async';el.src=img.dataUrl;el.alt=img.name||'image';el.style.maxWidth='180px';el.onclick=function(){_viewImageFull(img.dataUrl)};div.appendChild(el)});
    if(m.wsSearches||m.memOps)_amAppendExtraCards(div,m.wsSearches||[],m.memOps||[]);
    if(m.calNotes&&window.IBCAL)try{m.calNotes.forEach(function(r){div.appendChild(IBCAL.noteCard(r))})}catch(e){}
    if(m.id){const db=document.createElement('button');db.className='chat-msg-del';db.textContent='✕';db.title='删除此消息';db.onclick=function(ev){ev.stopPropagation();deleteSingleMsg(m.id,div,frag)};div.appendChild(db)}
  }
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
  var isCont=prev&&prev.role===m.role&&(m.role==='user'||((prev.friendId||'_')===(m.friendId||'_')&&(!m.senderName||(prev.senderName||'_')===(m.senderName||'_'))));
  return _buildMsgEl(m,isFullscreen,isCont);
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
      var c=document.createElement('div');c.className='chat-sel-circle';
      c.onclick=function(ev){ev.stopPropagation();_toggleMsgSel(el.dataset.msgId,c)};
      el.appendChild(c);
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
    filtered.sort((a,b)=>a.timestamp-b.timestamp);
    if(filtered.length===0){
      container.innerHTML='<div class="chat-msg system">发送消息开始对话</div>';
      return;
    }
    _renderAllChat(container,filtered,false);
  }catch(e){container.innerHTML='<div class="chat-msg system">发送消息开始对话</div>'}
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
    const files=Array.from(inp.files).slice(0,IMG_MAX_COUNT-_pendingImages.length);
    for(const f of files){
      if(!f.type.startsWith('image/')){toast('仅支持图片文件');continue}
      if(f.size>IMG_MAX_BYTES){toast('图片超过'+Math.round(IMG_MAX_BYTES/1024/1024)+'MB限制');continue}
      if(_pendingImages.length>=IMG_MAX_COUNT){toast('最多附加'+IMG_MAX_COUNT+'张图片');break}
      try{const compressed=await compressImage(f);_pendingImages.push(compressed);renderImagePreviews()}catch(e){toast('图片读取失败')}
    }
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
function _appendLocalVisionContext(messages,context){
  for(let i=messages.length-1;i>=0;i--){
    if(messages[i].role==='user'){
      messages[i].content=(getTextContent(messages[i])||'请查看图片')+context;
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
    if(_pendingImages.length===0&&_pendingFiles.length===0){bar.classList.remove('has-items');return}
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
var _WS_OPEN_RE=/<ws_(project|read|create|edit|run|tool|gen_image|make_docx|make_pdf|make_xlsx)\b([^>]*)>|```file:([^\n]+)\n/gi;
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
          if(data.type==='tool'){['pendingConfirm','response','fed','author','images','args'].forEach(function(k){if(r[k]!==undefined)data[k]=r[k]})}
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
  if(msg.voice)t+=(t?'\n':'')+_voiceApiLine(msg.voice);/* 语音消息：存储记录读取时附上等效文本（映射后的 API 消息对象无 voice 字段，请求内容不经此改变） */
  return t;
}

function _viewImageFull(src){
  const ov=document.createElement('div');ov.className='chat-bubble-img-full';
  ov.innerHTML='<img src="'+src+'">';ov.onclick=function(){ov.remove()};
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
      if(_pendingImages.length>=IMG_MAX_COUNT){toast('最多附加'+IMG_MAX_COUNT+'张图片');return}
      compressImage(f).then(c=>{_pendingImages.push(c);renderImagePreviews()}).catch(()=>toast('图片读取失败'));
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
    Array.from(files).forEach(f=>{
      if(!f.type.startsWith('image/'))return;
      if(_pendingImages.length>=IMG_MAX_COUNT)return;
      compressImage(f).then(c=>{_pendingImages.push(c);renderImagePreviews()}).catch(()=>{})
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

async function sendChatMessage(voiceMsg){
  /* voiceMsg：由语音模块 _vmFinish 传入的 {dataUrl,mime,duration,transcript}；按钮点击/回车调用时为空 */
  const _voice=(voiceMsg&&voiceMsg.dataUrl)?voiceMsg:null;
  /* Find active friend config */
  if(!activeFriendId&&apiConfigs.length>0)activeFriendId=apiConfigs[0].id;
  /* 捕获发送瞬间的目标好友/话题，防止用户在等待API时切窗导致消息串到其他对话框 */
  const _targetFriend=activeFriendId;
  const _targetThread=activeThreadId;
  if(_chatSendingFor.has(_targetFriend))return;
  /* Get input from either mini or full chat */
  const miniInput=document.getElementById('chat-input');
  const fullInput=document.getElementById('chat-full-input');
  const input=currentPage==='chat'?fullInput:miniInput;
  const text=_voice?'':input.value.trim();/* 语音消息不读取、不清空输入框，输入框中的草稿保持原样 */
  const _ctxText=_voice?_voiceApiLine(_voice):text;/* 供 @提及判定、记忆检索、Auto Memory 使用的等效文本 */
  if(!text&&!_voice&&!_pendingImages.length&&!_pendingFiles.length)return;

  const isGroup=_targetFriend&&_targetFriend.startsWith('group_');

  if(isGroup){
    /* ===== GROUP CHAT MODE ===== */
    const groups=await loadGroups();
    const group=groups.find(g=>g.id===_targetFriend);
    if(!group){toast('群聊不存在');return}
    normalizeGroupMembers(group);/* 自动迁移旧格式 */
    const allMemberIds=getGroupMemberIds(group);
    const memberCfgs=allMemberIds.map(mid=>apiConfigs.find(a=>a.id===mid)).filter(Boolean);
    if(memberCfgs.length<1){toast('群聊中没有有效的API成员');return}
    /* 动态成员状态过滤：
       status === 'active' → 正常发言
       status === 'muted'  → 静音，仅当用户 @TA 时才发言
       status === 'removed' → 已退出，不参与发言 */
    const speakingCfgs=memberCfgs.filter(c=>{
      const st=getGroupMemberStatus(group,c.id);
      if(st==='removed')return false;
      if(st==='muted'){
        const nm=c.nickname||c.model||'';
        return !!nm&&(_ctxText.indexOf('@'+nm)!==-1||_ctxText.indexOf('＠'+nm)!==-1);
      }
      return true;/* active 正常参与 */
    });
    /* 只校验本轮实际要发言的成员——静默成员即使API未配置完整也不阻塞发送 */
    const invalidMembers=speakingCfgs.filter(c=>!_ibApiReady(c));
    if(invalidMembers.length>0){toast('部分成员API未配置完整（'+invalidMembers.map(c=>c.nickname||c.model).join('、')+' ）');return}
    const thinkingOn=true;/* reasoning 始终接收和保存；是否展示由每个成员 cfg.showThinking 决定 */

    const sendBtn=document.getElementById('chat-send-btn');
    if(!_voice)input.value='';
    const sentImages=_voice?[]:_pendingImages.slice();if(!_voice)_pendingImages=[];
    const sentFiles=_voice?[]:_pendingFiles.slice();if(!_voice){_pendingFiles=[];renderAttachPreviews()}

    const userMsg={id:'msg_'+Date.now()+'_u',role:'user',content:text,friendId:_targetFriend,timestamp:Date.now()};
    if(sentImages.length)userMsg.images=sentImages.map(img=>({dataUrl:img.dataUrl,base64:img.base64,mime:img.mime,name:img.name}));
    if(sentFiles.length)userMsg.files=sentFiles.map(f=>({name:f.name,ext:f.ext,size:f.size,text:f.text}));
    if(_voice)userMsg.voice={dataUrl:_voice.dataUrl,mime:_voice.mime,duration:_voice.duration,transcript:_voice.transcript||'',tone:_voice.tone||''};
    await dbPut('chatMessages',userMsg);
    appendChatBubble('user',text,undefined,undefined,userMsg.id,sentImages,sentFiles,undefined,_voice);
    /* 上传的文件同步归档进 ICode 的「User」文件夹（先落库再逐个请求成员；文件内容随本条消息注入，后续可按文件名 ws_read 读取） */
    if(sentFiles.length){try{await _wsArchiveUserUploads(sentFiles)}catch(e){}}

    const msgContainer=currentPage==='chat'?document.getElementById('chat-full-messages'):document.getElementById('chat-messages');
    /* 静默模式安全网：创建时已保证至少一位常规发言者，正常情况下走不到这里； */
    if(speakingCfgs.length===0){
      const quiet=document.createElement('div');
      quiet.className='chat-msg system';
      quiet.textContent='（成员都在静默模式且没有被 @，本轮无人回应）';
      msgContainer.appendChild(quiet);
      msgContainer.scrollTop=msgContainer.scrollHeight;
      return;
    }
    const glim=await getReadingLimits();
    const _vtSg=await _vtGet();/* 语音直发开关（成员是否能听原声在循环内按各自模型判定） */
    const _gSealTs=await getChatSealTimestamp(_targetFriend);
    const gMsgs=filterSealed((await dbGetByIndex('chatMessages','byFriend',_targetFriend)).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)),_gSealTs);/* 封档线过滤 */
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
    const roundExtras=[];/* FIX④: 本轮内先发言成员的回复，供后续成员接力可见 */

    _chatSendingFor.add(_targetFriend);
    if(sendBtn)sendBtn.disabled=true;
    try{
    /* 工作区读取内容与操作结果反馈：带成员名的条目在各自成员发言前精准注入；
       无主条目 / 成员已不在本群名单的条目，由本轮首个发言成员兜底消费（兼容旧行为） */
    let _gWsFirstTurn=true;
    for(const cfg of speakingCfgs){/* 静默模式：静默成员本轮不参与 */
      const selfName=cfg.nickname||cfg.model;
      const _gvNative=_vmAudioNative(cfg)&&(_vtSg.direct!==false);/* 本成员能否直接听音频原声 */
      const _gStreamOk=cfg.streaming!==undefined?!!cfg.streaming:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].streaming);
      /* 非流式：typing指示器 */
      let typingEl=null,_gTypStart=0,_gTypTimer=null;
      if(!_gStreamOk){
        typingEl=document.createElement('div');
        typingEl.className='chat-typing';
        _gTypStart=Date.now();
        typingEl.innerHTML=esc(selfName)+' 思考中…<span class="typing-sec">（0秒）</span>';
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
        const mapped=_combined.filter(m=>m.role!=='system').map((m,i)=>{
          if(m.role==='user'){var uc='['+userLabel+'] '+(m.content||'');if(m.voice)uc+=(m.content?'\n':'')+_voiceApiLine(m.voice,!_gvNative);if(m.files&&m.files.length)m.files.forEach(function(f){uc+='\n\n[文件上传: '+f.name+']\n'+_capFileText(f.text)});return {role:'user',content:uc}}
          if((m.senderName||'')===selfName){
            let c=_wsStubHistory(sanitizeGroupReply(m.content,selfName,allNames));
            return {role:'assistant',content:c};
          }
          return {role:'user',content:'['+(m.senderName||'AI')+'] '+_wsStubHistory(m.content)};
        });
        const messages=collapseSameRole(mapped);
        /* FIX②: 补强 system 指令——列出成员名单 + 明确禁止代角 */
        let sysContent=cfg.systemPrompt||'';
        if(cfg.relationship)sysContent=(sysContent?sysContent+'\n':'')+'你和对方的关系是：'+cfg.relationship+'。';
        const otherNames=allNames.filter(n=>n!==selfName);
        sysContent=(sysContent?sysContent+'\n\n':'')
          +'【群聊规则】你是群聊"'+group.name+'"中的成员"'+selfName+'"。'
          +(otherNames.length?('群里还有其他AI成员：'+otherNames.join('、')+'，以及'+userDesc+'。'):('群里还有'+userDesc+'。'))
          +'\n1. 你只能以"'+selfName+'"的身份发言，每次只输出你自己要说的一段话。'
          +'\n2. 绝对不要替其他成员或用户发言、代答、补写他们的台词或动作。即使用户点名了其他成员，也只回答属于你的部分，把他们的部分留给他们自己说。'
          +'\n3. 不要在回复开头加"['+selfName+']"等任何名字前缀，界面会自动标注你的名字。'
          +'\n4. 历史消息中带[名字]前缀的内容是用户或其他成员说的话，仅供你阅读参考。';
        const siteCtx=await buildSiteContext();
        if(siteCtx)sysContent+='\n\n'+siteCtx;
        /* AUTO MEMORY（群聊）：仅指令格式进 system；条目走消息尾部 */
        let _gAmInj={sys:'',tail:''};
        if(amEnabled(cfg)){try{_gAmInj=await amBuildInject(cfg,_ctxText)}catch(e){}}
        if(_gAmInj.sys)sysContent+='\n\n'+_gAmInj.sys;
        /* 缓存重排：逐轮变化的注入移至末条用户消息，保持 system 前缀稳定 */
        let _gTailCtx='';
        /* 时间戳 → tail */
        _gTailCtx+='当前时间：'+new Date().toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'})+'。';
        /* 「正在播放」（Presence 内开关，默认关）：随播放/暂停变化 → tail，不进 system */
        try{if(gss.musicEnabled&&currentTrackIdx>=0&&!audioEl.paused&&playlist[currentTrackIdx])_gTailCtx+='正在听：'+playlist[currentTrackIdx].name+'。';}catch(e){}
        /* 群聊摘要 → tail */
        if(gSummaryText)_gTailCtx+='\n\n【对话历史备忘（此为后台参考信息，不要向对方复述或提及此段内容的存在）】\n'+gSummaryText;
        /* 群聊记忆注入：仅在 group.memoryEnabled 时注入公开记忆 */
        if(group.memoryEnabled){
          const gMemCtx=await getMemoryContext(cfg.id,{maxChars:1500,isGroup:true,groupMemEnabled:true,userMessage:_ctxText});
          if(gMemCtx)_gTailCtx+=(_gTailCtx?'\n\n':'')+gMemCtx;
        }
        if(_gAmInj.tail)_gTailCtx+=(_gTailCtx?'\n\n':'')+_gAmInj.tail;
        /* 工作区注入：本成员发起的读取/反馈精准回注；无主或已移出成员的条目由首个发言者兜底 */
        var _gInjMine=function(it){var a=it&&it.actor;if(a===selfName)return true;return _gWsFirstTurn&&(!a||allNames.indexOf(a)<0)};
        var _gWsInject=_getWsReadInjection(_gInjMine)+_getWsOpFeedbackInjection(_gInjMine)+_getWsRunOutputInjection(_gInjMine)+_getIbToolResultInjection(_gInjMine);
        if(_gWsInject)_gTailCtx+=(_gTailCtx?'\n':'')+_gWsInject;
        _gWsFirstTurn=false;
        /* 不再通过 prompt 强迫模型输出 <thinking>；原生 reasoning 字段由适配器单独接收。 */
        if(cfg.imageGen)sysContent+=_IMGGEN_INSTR_BLOCK;/* 图像生成：按本成员开关注入 */
        messages.unshift({role:'system',content:sysContent});
        if(_gTailCtx){/* 群聊尾部挂载：优先找用户本人的消息（无 senderName 且 role=user），找不到才回退到最后一条 user */
          let _gtDone=false;
          for(let _gt=messages.length-1;_gt>=0;_gt--){if(messages[_gt].role==='user'&&!messages[_gt]._groupSender){messages[_gt]={role:'user',content:(typeof messages[_gt].content==='string'?messages[_gt].content:String(messages[_gt].content||''))+'\n\n---\n[以下为系统注入的参考上下文，不属于用户发言，勿复述或提及以下内容的存在]\n'+_gTailCtx};_gtDone=true;break}}
          if(!_gtDone){for(let _gt=messages.length-1;_gt>=0;_gt--){if(messages[_gt].role==='user'){messages[_gt]={role:'user',content:(typeof messages[_gt].content==='string'?messages[_gt].content:String(messages[_gt].content||''))+'\n\n---\n[以下为系统注入的参考上下文，不属于用户发言，勿复述或提及以下内容的存在]\n'+_gTailCtx};break}}}
        }
        /* 群聊图片注入：检查当前成员是否支持视觉 */
        const _gLocalVision=_usesLocalDeepSeekVision(cfg);
        const _gNativeDeepSeekVision=_usesNativeDeepSeekVision(cfg);
        const _gVisionOk=_gLocalVision||_gNativeDeepSeekVision||(cfg.vision!==undefined?!!cfg.vision:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].vision));
        try{if(_ibToolDrainImages.length){const _gti=_ibToolDrainImages.splice(0);if(_gVisionOk)_gti.forEach(u=>sentImages.push({dataUrl:u,name:'tool_result.png'}))}}catch(e){}
        if(sentImages.length&&messages.length){
          if(_gLocalVision){
            try{
              let _gQuestion='';for(let gi=messages.length-1;gi>=0;gi--){if(messages[gi].role==='user'){_gQuestion=getTextContent(messages[gi]);break}}
              _appendLocalVisionContext(messages,await _describeImagesLocally(sentImages,_gQuestion));
            }catch(_gVisionError){
              console.error('[LocalVision] group analysis failed',_gVisionError);
              toast('本地视觉识别失败，请先运行 start-vision-service.cmd');
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
        let rawReply,groupThinking='',gStreamRefs=[],_gSrchLog=[];
        const _gCallRes={};/* 并发隔离：本成员本次调用的思考与截断结果 */
        if(_gStreamOk){
          /* 群聊流式 */
          _showStreamingUI(true);
          gStreamRefs=activeFriendId===_targetFriend?_createStreamBubble(_targetFriend,selfName):[];
          /* 群聊流式气泡：senderId 改用 config_id，Voice 匹配更精确 */
          if(gStreamRefs&&gStreamRefs[0]&&isGroup&&cfg&&cfg.id){gStreamRefs[0].dataset.senderId=cfg.id}
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
          const _gFlush=(ch)=>{_gMemLive.push(ch)};
          try{
          rawReply=await callApiChatStream(cfg,messages,{wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_gCallRes,searchLog:_gSrchLog,onSearch:_gOnSearch,
            onThink:function(tk){_gThinkF(tk)},
            onChunk:function(chunk){
              if(_gSState===2){_gFlush(chunk);return}
              _gSBuf+=chunk;
              if(_gSState===0){
                const _gOrphan=_gSBuf.match(/^\s*<\/think(?:ing)?>\s*/i);
                if(_gOrphan){_gSState=1;_gSThinkBuf=_gSBuf.slice(_gOrphan[0].length);_gSBuf='';return}
                const _gOpen=_gSBuf.match(/^\s*<think(?:ing)?>/i);
                if(_gOpen){_gSState=1;_gSThinkBuf=_gSBuf.slice(_gOpen[0].length);_gSBuf='';_gThinkF(_gSThinkBuf);return}
                if(_gSBuf.length>60){_gSState=2;_gFlush(_gSBuf);_gSBuf='';return}
              }
              if(_gSState===1){_gSThinkBuf+=chunk;_gSBuf='';_gThinkF(chunk);const ct=_gSThinkBuf.match(/<\/think(?:ing)?>/i);if(ct){const _gAfter=_gSThinkBuf.slice(ct.index+ct[0].length);_gSThinkBuf=_gSThinkBuf.slice(0,ct.index);_gSState=2;if(_gShowThinking)_finishStreamThinking(_gLiveThink,_gSThinkBuf);if(_gAfter&&_gAfter.trim())_gFlush(_gAfter.trim())}}
            }});
          }catch(_streamErr){if(!rawReply)rawReply=await callApiChat(cfg,messages,{wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_gCallRes,searchLog:_gSrchLog});groupThinking=_gCallRes.reasoning_content||''}
          _showStreamingUI(false);
          _gMemLive.finish();
          _gWsFilter.finish();
          gStreamRefs.forEach(ref=>{ref.div.classList.remove('chat-stream-cursor');if(ref.txt.classList)ref.txt.classList.remove('chat-stream-cursor')});
          _finishStreamThinking(_gLiveThink,null);
          groupThinking=_gCallRes.reasoning_content||'';
          if(!groupThinking&&_gSThinkBuf.trim())groupThinking=_gSThinkBuf.trim();
          if(_gShowThinking&&groupThinking){_ensureStreamThinking(gStreamRefs,_gLiveThink);_finishStreamThinking(_gLiveThink,groupThinking)}
        }else{
          /* 群聊非流式 */
          rawReply=await callApiChat(cfg,messages,{wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_gCallRes,searchLog:_gSrchLog});
          groupThinking=_gCallRes.reasoning_content||'';
          clearInterval(_gTypTimer);
          const _gElapsed=Math.round((Date.now()-_gTypStart)/1000);
          if(typingEl){typingEl.textContent=selfName+'（'+_gElapsed+'秒）';typingEl.style.animation='none';setTimeout(()=>{if(typingEl.parentNode)typingEl.remove()},1000)}
        }
        if((!rawReply||!String(rawReply).trim())&&!(_gCallRes.reasoning_content||groupThinking)){appendChatBubble('ai',(window.IBERR?window.IBERR.text('empty_output',selfName):'（未收到有效回复）'),selfName);continue}
        var gParts=_assistantResponseParts(rawReply,groupThinking);
        groupThinking=gParts.reasoning_content;
        let cleanReply=sanitizeGroupReply(gParts.content,selfName,allNames);
        let reply=cleanReply;
        /* AUTO MEMORY（群聊）：截取并执行本成员的 mem_* 指令，操作者标注为发言成员 */
        var _gMemR=[];
        {const _gmp=_parseMemOps(reply);
         if(_gmp.ops.length){reply=_gmp.clean;if(amEnabled(cfg))_gMemR=await _execMemOps(_gmp.ops,cfg,selfName)}}
        /* 群聊同样支持工作区：按顺序执行操作，操作者标注为发言成员 */
        var _gws=_parseWsOps(reply),_gwsR=[];
        if(_gws.ops.length){try{_gwsR=await _execWsOps(_gws.ops,selfName,cfg)}catch(e){}}
        if(_gws.files&&_gws.files.length){try{await _wsArchiveFileBlocks(_gws.files,selfName)}catch(e){}}
        var _gwsPhantom=_wsCheckPhantom(_gws.cleanText,_gws.ops.length,selfName);
        const aiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:reply,reasoning_content:groupThinking||'',metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,showThinking:_resolveShowThinking(cfg)},friendId:_targetFriend,senderName:selfName,timestamp:Date.now()};
        {const _gGiImgs=_wsCollectGenImages(_gwsR);if(_gGiImgs.length)aiMsg.images=_gGiImgs;}/* 生成的图片随消息持久化 */
        if(_gSrchLog.length)aiMsg.wsSearches=_gSrchLog.slice();
        if(_gMemR.length)aiMsg.memOps=_gMemR.map(r=>({ok:r.ok,status:r.status||'',label:r.label,detail:r.detail}));
        if(_gCallRes.truncated)aiMsg.truncated=true;/* 任务6 */
        await dbPut('chatMessages',aiMsg);
        roundExtras.push(aiMsg);
        if(_gStreamOk){
          /* 流式：以完整回复为准重建气泡（文本 + 操作卡 + 下载卡分段）。
             必须逐个 ref 重建——流式气泡可能同时写在全屏与迷你两个容器里，
             以前只重建"当前容器的最后一条"，另一个容器会停在半成品状态
             （迷你面板里留着原始指令 / pending 操作卡），关掉重开才恢复。 */
          gStreamRefs.forEach(ref=>{
            _wsFinalizeBubble(ref,reply,_gwsR);
            var gHost=ref.isTextNode?ref.div:ref.txt;
            if(_gSrchLog.length||_gMemR.length)_amAppendExtraCards(gHost,_gSrchLog,_gMemR);
            if(_wsPendingReads.length)gHost.appendChild(_buildWsReadHint());
            if(_gwsPhantom)gHost.appendChild(_buildWsPhantomHint(_gwsPhantom));
            ref.div.dataset.msgId=aiMsg.id;
            if(typeof _chatSelectMode!=='undefined'&&_chatSelectMode&&ref.full&&!ref.div.querySelector('.chat-sel-circle')){const sc=document.createElement('div');sc.className='chat-sel-circle';sc.onclick=function(ev){ev.stopPropagation();_toggleMsgSel(aiMsg.id,sc)};ref.div.appendChild(sc)}/* BUGFIX: 群聊流式同上 */
            const db=document.createElement('button');db.className='chat-msg-del';db.textContent='\u2715';db.title='删除此消息';db.onclick=function(ev){ev.stopPropagation();deleteSingleMsg(aiMsg.id,ref.div)};ref.div.appendChild(db);
            if(aiMsg.truncated&&ref.full)gHost.appendChild(_buildContinuePill(aiMsg.id));/* 任务6 */
          });
          _syncMiniAfterStream(aiMsg.id,_targetFriend);
        }else{
          if(activeFriendId===_targetFriend){
            appendChatBubble('ai',reply,selfName,groupThinking||undefined,aiMsg.id,undefined,undefined,_gwsR,undefined,cfg);
            if(_gSrchLog.length||_gMemR.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_amAppendExtraCards(el,_gSrchLog,_gMemR)});/* 任务A：非流式也显示搜索/记忆卡 */
            if(_wsPendingReads.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsReadHint())});
            if(_gwsPhantom)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsPhantomHint(_gwsPhantom))});
            if(aiMsg.truncated)document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id="'+aiMsg.id+'"] .r-text').forEach(function(t){t.appendChild(_buildContinuePill(aiMsg.id))});/* 任务6 */
          }
        }
        if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
      }catch(err){
        if(_gTypTimer)clearInterval(_gTypTimer);
        if(typingEl&&typingEl.parentNode)typingEl.remove();
        _showStreamingUI(false);
        /* 失败成员的流式气泡若还没写入内容，直接移除，避免残留带光标的空气泡（已流出内容的气泡保留） */
        try{(gStreamRefs||[]).forEach(function(ref){const _t=String((ref.txt&&ref.txt.textContent)||'');const _hasCards=typeof (ref.txt&&ref.txt.querySelector)==='function'&&!!ref.txt.querySelector('.ws-op-card');if(!_t.trim()&&!_hasCards&&ref.div.parentNode)ref.div.parentNode.removeChild(ref.div)})}catch(e){}
        const _ibFE=window.IBERR?window.IBERR.report(err,{cfg:cfg,friendId:_targetFriend,senderName:selfName,stage:'group_chat'}):null;
        const _ibFT=_ibFE?_ibFE.text:(selfName+': 请求失败');
        if(!_ibFE||!_ibFE.dup){toast(_ibFT);appendChatBubble('ai',_ibFT,selfName)}
      }
    }
    }finally{
      _chatSendingFor.delete(_targetFriend);
      if(sendBtn)sendBtn.disabled=false;
      autoResizeInput(input);
      if(currentPage==='chat')renderChatCalendar();
      updateChatStorageInfo();
      /* Deferred group summary */
      if(gss.enabled){const _gFid=_targetFriend;const _gSealTs2=_gSealTs;setTimeout(async()=>{try{const _gAll=filterSealed((await dbGetByIndex('chatMessages','byFriend',_gFid)).sort((a,b)=>a.timestamp-b.timestamp),_gSealTs2);await maybeSummarize(pickGroupUtilityCfg(group,speakingCfgs)||memberCfgs[0],_gFid,null,_gAll)}catch(e){}},500)}
    }
    return;
  }

  /* ===== NORMAL 1-ON-1 CHAT ===== */
  const cfg=apiConfigs.find(a=>a.id===_targetFriend);
  if(!cfg||!_ibApiHasCredential(cfg)){toast('请先在 API 页面配置密钥或本机端点');return}
  if(!cfg.endpoint){toast('请先配置 API 接口地址');return}
  const thinkingOn=true;/* reasoning 始终接收和保存；是否展示由 cfg.showThinking 决定 */

  _chatSendingFor.add(_targetFriend);
  const sendBtn=document.getElementById('chat-send-btn');
  if(sendBtn)sendBtn.disabled=true;
  if(!_voice)input.value='';
  const sentImages=_voice?[]:_pendingImages.slice();if(!_voice)_pendingImages=[];
  const sentFiles=_voice?[]:_pendingFiles.slice();if(!_voice){_pendingFiles=[];renderAttachPreviews()}

  const userMsg={id:'msg_'+Date.now()+'_u',role:'user',content:text,friendId:_targetFriend,timestamp:Date.now()};/* 编号方式与群聊统一：后缀防同毫秒碰撞 */
  if(sentImages.length)userMsg.images=sentImages.map(img=>({dataUrl:img.dataUrl,base64:img.base64,mime:img.mime,name:img.name}));
  if(sentFiles.length)userMsg.files=sentFiles.map(f=>({name:f.name,ext:f.ext,size:f.size,text:f.text}));
  if(_voice)userMsg.voice={dataUrl:_voice.dataUrl,mime:_voice.mime,duration:_voice.duration,transcript:_voice.transcript||'',tone:_voice.tone||''};
  if(_targetThread)userMsg.threadId=_targetThread;
  await dbPut('chatMessages',userMsg);
  appendChatBubble('user',text,undefined,undefined,userMsg.id,sentImages,sentFiles,undefined,_voice);
  /* AI 自主规划：用户主动发言 → 取消该角色等待中的 AI 计划（异步，不阻塞） */
  try{_activeUserReplied(userMsg)}catch(e){}
  /* 日记特殊事件：首次聊天 / 久别重逢（异步，不阻塞） */
  try{_diaryMaybeEvent(_targetFriend,userMsg)}catch(e){}
  /* 上传的文件同步归档进 ICode 的「User」文件夹（先落库再请求 AI；文件内容随本条消息注入，后续可按文件名 ws_read 读取） */
  if(sentFiles.length){try{await _wsArchiveUserUploads(sentFiles)}catch(e){}}

  const _streamingOk=cfg.streaming!==undefined?!!cfg.streaming:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].streaming);

  /* 非流式：显示typing计时器 */
  let typingEl=null,_typStart=0,_typTimer=null;
  if(!_streamingOk){
    typingEl=document.createElement('div');
    typingEl.className='chat-typing';typingEl.id='chat-typing-'+_targetFriend;
    _typStart=Date.now();
    typingEl.innerHTML=esc(cfg.nickname||cfg.model)+' 思考中…<span class="typing-sec">（0秒）</span>';
    _typTimer=setInterval(()=>{const s=Math.round((Date.now()-_typStart)/1000);const sp=typingEl.querySelector('.typing-sec');if(sp)sp.textContent='（'+s+'秒）'},1000);
    const msgContainer=currentPage==='chat'?document.getElementById('chat-full-messages'):document.getElementById('chat-messages');
    if(activeFriendId===_targetFriend){msgContainer.appendChild(typingEl);msgContainer.scrollTop=msgContainer.scrollHeight}
  }

  let ss={enabled:false};/* fix: 提升到 try 外供末尾延迟摘要使用，原 const 声明在 try 内、catch 后引用必抛 ReferenceError */
  let _sealTs=0;/* 封档线时间戳：同 ss 提升至 try 外供延迟摘要闭包引用 */
  let streamRefs=[];/* 流式气泡引用提升到 try 外：失败路径需要清理未写入内容的空气泡 */
  try{
    const lim=await getReadingLimits();
    _sealTs=await getChatSealTimestamp(_targetFriend);
    const friendMsgs=filterSealed((await dbGetByIndex('chatMessages','byFriend',_targetFriend)).filter(m=>_targetThread?m.threadId===_targetThread:!m.threadId).sort((a,b)=>a.timestamp-b.timestamp),_targetThread?0:_sealTs);/* 封档线仅作用于主对话，话题频道不受影响 */
    /* Summary system: only READ existing summary before sending (no API call here) */
    let summaryText=null;
    ss=await getSummarySettings();
    if(ss.enabled){
      const existingSummary=await getChatSummary(_targetFriend,_targetThread);
      if(existingSummary)summaryText=existingSummary.summary;
    }
    const keepCount=ss.enabled?(ss.keepCount||6):(lim.chatLimit||DEFAULT_READ_CHAT);
    const history=_cacheStableSlice(friendMsgs,keepCount);/* 缓存修复：阶梯窗口，起点不再逐条滑动 */
    /* 修复：历史不再注入 <thinking> 占位符——长上下文中大量同形占位样本会被模型照抄（思考区整段输出占位字样）；历史仍为常量串，缓存前缀稳定性不变 */
    /* 历史只回传用户消息与最终回答；reasoning_content 仅本地保存/导出，不显示也不回传。 */
    const _vtS1=await _vtGet();
    const _vNative=_vmAudioNative(cfg)&&(_vtS1.direct!==false);/* 音频直发判定：能听原声的模型（「音频直发」开关默认开）不附加声学语气段 */
    const messages=history.map((m,i)=>{
      var mc=m.content||'';
      if(m.voice)mc+=(mc?'\n':'')+_voiceApiLine(m.voice,!_vNative);
      if(m.files&&m.files.length)m.files.forEach(function(f){mc+='\n\n[文件上传: '+f.name+']\n'+_capFileText(f.text)});
      var _mm={role:m.role==='assistant'?'assistant':'user',content:m.role==='assistant'?_wsStubHistory(mc):mc};
      if(m.role!=='user'&&_mm.role==='user')_mm._groupSender=true;
      return _mm;
    });
    let sysContent=cfg.systemPrompt||'';
    if(cfg.nickname)sysContent=(sysContent?sysContent+'\n':'')+'你的身份/昵称是「'+cfg.nickname+'」。';
    if(cfg.relationship)sysContent=(sysContent?sysContent+'\n':'')+'你和对方的关系是：'+cfg.relationship+'。';
    const siteCtx=await buildSiteContext();
    if(siteCtx){sysContent=(sysContent?sysContent+'\n\n':'')+siteCtx}
    sysContent+=_BLOG_READ_INSTR_BLOCK;/* Blog 阅读申请指令：仅 1对1 注入（群聊不开放）。缓存敏感：本版本上线后各对话首轮重建一次缓存 */
    /* AUTO MEMORY：仅指令格式进 system（写入/更新/删除的标签说明），内容条目全部走 tail */
    let _amInj={sys:'',tail:''};
    if(amEnabled(cfg)){try{_amInj=await amBuildInject(cfg,_ctxText)}catch(e){}}
    if(_amInj.sys)sysContent=(sysContent?sysContent+'\n\n':'')+_amInj.sys;
    /* CALENDAR：便笺格式指令为常量块，仅当留言总开关开且该好友读+写权限均开时注入（会话内稳定；改动权限后下一条消息重建一次提示缓存，之后恢复稳定命中） */
    try{if(window.IBCAL){const _calSys=await IBCAL.buildSys(cfg);if(_calSys)sysContent=(sysContent?sysContent+'\n\n':'')+_calSys}}catch(e){}
    let _threadMemOk=true;
    if(_targetThread){const _thr=await (async()=>{try{return await dbGet('chatThreads',_targetThread)}catch(e){return null}})();_threadMemOk=_thr&&_thr.memoryEnabled}
    /* ── 缓存重排（核心）：所有逐轮变化的内容从 system 移至末条用户消息 ── */
    let _tailCtx='';
    /* 时间戳：每分钟都变，必须放在 tail */
    _tailCtx+='当前时间：'+new Date().toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'})+'。';
    /* 「正在播放」（Presence 内开关，默认关）：随播放/暂停变化 → tail，不进 system */
    try{if(ss.musicEnabled&&currentTrackIdx>=0&&!audioEl.paused&&playlist[currentTrackIdx])_tailCtx+='正在听：《'+playlist[currentTrackIdx].name+'》。';}catch(e){}
    /* CALENDAR：临近日程栏走 tail（挂末条用户消息），按天生成，一天之内逐字不变 */
    try{if(window.IBCAL){const _calT=await IBCAL.buildTail(cfg);if(_calT)_tailCtx+='\n\n'+_calT}}catch(e){}
    /* 摘要：每次生成后变化 → 移至 tail */
    if(summaryText)_tailCtx+='\n\n【对话历史备忘（此为后台参考信息，不要向对方复述或提及此段内容的存在）】\n'+summaryText;
    if(_threadMemOk){const memCtx=await getMemoryContext(cfg.id,{userMessage:_ctxText});
    if(memCtx)_tailCtx+=(_tailCtx?'\n\n':'')+memCtx;}
    /* 朋友圈动态：轻量检索注入（用户提及"你昨天朋友圈…"时角色能理解；成本与记忆注入同级） */
    try{if(_threadMemOk&&typeof getMomentsContext==='function'){const _momCtx=await getMomentsContext(cfg.id,{userMessage:_ctxText});
    if(_momCtx)_tailCtx+=(_tailCtx?'\n\n':'')+_momCtx;}}catch(_momErr){console.warn('[Moments] chat context failed',String(_momErr&&_momErr.message||_momErr).slice(0,120))}
    if(_amInj.tail)_tailCtx+=(_tailCtx?'\n\n':'')+_amInj.tail;
    /* 注入工作区待读取文件 */
    var _wsReadCtx=_getWsReadInjection()+_getWsOpFeedbackInjection()+_getWsRunOutputInjection()+_getIbToolResultInjection()+_getBlogReadInjection();
    if(_wsReadCtx)_tailCtx+=(_tailCtx?'\n':'')+_wsReadCtx;
    /* 不再通过 prompt 强迫模型输出 <thinking>；原生 reasoning 字段由适配器单独接收。 */
    if(cfg.imageGen)sysContent+=_IMGGEN_INSTR_BLOCK;/* 图像生成：按好友开关注入（会话内稳定，缓存友好） */
    if(sysContent)messages.unshift({role:'system',content:sysContent});
    if(_tailCtx){for(let _ti=messages.length-1;_ti>=0;_ti--){if(messages[_ti].role==='user'){messages[_ti]={role:'user',content:(typeof messages[_ti].content==='string'?messages[_ti].content:String(messages[_ti].content||''))+'\n\n---\n[以下为系统注入的参考上下文，不属于用户发言，勿复述或提及以下内容的存在]\n'+_tailCtx};break}}}
    const _localVision=_usesLocalDeepSeekVision(cfg);
    const _nativeDeepSeekVision=_usesNativeDeepSeekVision(cfg);
    const _visionOk=_localVision||_nativeDeepSeekVision||(cfg.vision!==undefined?!!cfg.vision:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].vision));
    try{if(_ibToolDrainImages.length){const _ti=_ibToolDrainImages.splice(0);if(_visionOk)_ti.forEach(u=>sentImages.push({dataUrl:u,name:'tool_result.png'}))}}catch(e){}
    if(sentImages.length&&messages.length){
      if(_localVision){
        try{
          let _question='';for(let i=messages.length-1;i>=0;i--){if(messages[i].role==='user'){_question=getTextContent(messages[i]);break}}
          _appendLocalVisionContext(messages,await _describeImagesLocally(sentImages,_question));
        }catch(_visionError){
          console.error('[LocalVision] analysis failed',_visionError);
          toast('本地视觉识别失败，请先运行 start-vision-service.cmd');
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
        toast('当前API（'+cfg.provider+'）不支持图片识别，图片未发送');
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

    if(_streamingOk){
      /* ===== 流式传输路径 ===== */
      _showStreamingUI(true);
      streamRefs=activeFriendId===_targetFriend?_createStreamBubble(_targetFriend):[];
      /* Reasoning 始终独立缓冲；仅 showThinking=true 时创建实时面板。 */
      let _liveThinkEls=[];
      const _showThinking=_resolveShowThinking(cfg);
      const _thinkFlush=(tk)=>{if(_showThinking)_appendStreamThinking(streamRefs,_liveThinkEls,tk)};
      /* 思考链缓冲状态机：拦截 <thinking> 标签 */
      let _sBuf='',_sThinkBuf='',_sState=0;
      const _wsSFilter=_wsMakeStreamFilter(_wsMakeStreamWriters(streamRefs));
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
      const _sFlush=(ch)=>{_calLive?_calLive.push(ch):_memLive.push(ch)};
      const _callRes={};/* 并发隔离：本次调用的思考与截断结果（不再读共享全局量） */
      let rawReply=await callApiChatStream(cfg,messages,{wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_callRes,searchLog:_srchLog,onSearch:_onSearch,
        onThink:function(tk){_thinkFlush(tk)},
        onChunk:function(chunk){
        if(_sState===2){_sFlush(chunk);return}
        _sBuf+=chunk;
        if(_sState===0){
          const _orphan=_sBuf.match(/^\s*<\/think(?:ing)?>\s*/i);
          if(_orphan){_sState=1;_sThinkBuf=_sBuf.slice(_orphan[0].length);_sBuf='';return}
          const _open=_sBuf.match(/^\s*<think(?:ing)?>/i);
          if(_open){_sState=1;_sThinkBuf=_sBuf.slice(_open[0].length);_sBuf='';_thinkFlush(_sThinkBuf);return}
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
      /* 空输出防护：模型什么都没回（连思考链都没有）→ 按统一错误分类走友好提示，不再静默保存空气泡 */
      if(!(replyText&&String(replyText).trim())&&!(thinkingText&&String(thinkingText).trim()))throw window.IBERR?window.IBERR.err('empty_output'):new Error('API 返回了空内容');
      if(_showThinking&&thinkingText){_ensureStreamThinking(streamRefs,_liveThinkEls);_finishStreamThinking(_liveThinkEls,thinkingText)}
      /* AUTO MEMORY：截取并执行 mem_* 指令（先于 ws 解析与收尾渲染，防止标签原文入库/上屏） */
      var _memR=[];
      {const _mp=_parseMemOps(replyText);
       if(_mp.ops.length){replyText=_mp.clean;if(amEnabled(cfg))_memR=await _execMemOps(_mp.ops,cfg,cfg.nickname||cfg.model||'AI')}}
      /* CALENDAR：截取 <cal_note> 便笺并入库（重复/越权丢弃出警示卡）；正文出现临近事项标题时在台账打「已提及」勾 */
      var _calR=[];
      try{if(window.IBCAL){const _cp=await IBCAL.processReply(replyText,cfg);replyText=_cp.clean;_calR=_cp.results||[]}}catch(e){}
      /* Blog 阅读申请：截取 blog_read 标签并生成申请卡（标签不入库、不上屏） */
      var _brCards=[];
      {const _bp=_parseBlogReadOps(replyText);
       if(_bp.ops.length){replyText=_bp.clean;try{_brCards=await _execBlogReadOps(_bp.ops)}catch(e){}}}
      /* 以完整回复为准重建气泡：文本 + 操作卡 + 下载卡按原始顺序分段渲染，卡片状态对齐真实执行结果 */
      var _wsParsed=_parseWsOps(replyText);
      var _wsResults=[];
      if(_wsParsed.ops.length)_wsResults=await _execWsOps(_wsParsed.ops,cfg.nickname||cfg.model||'AI',cfg);
      if(_wsParsed.files&&_wsParsed.files.length){try{await _wsArchiveFileBlocks(_wsParsed.files,cfg.nickname||cfg.model||'AI')}catch(e){}}
      var _wsPhantom=_wsCheckPhantom(_wsParsed.cleanText,_wsParsed.ops.length);
      streamRefs.forEach(ref=>{_wsFinalizeBubble(ref,replyText,_wsResults)});
      if(_srchLog.length||_memR.length)streamRefs.forEach(ref=>{_amAppendExtraCards(ref.isTextNode?ref.div:ref.txt,_srchLog,_memR)});
      if(_wsPendingReads.length)streamRefs.forEach(ref=>{(ref.isTextNode?ref.div:ref.txt).appendChild(_buildWsReadHint())});
      if(_brCards.length)streamRefs.forEach(ref=>{_brCards.forEach(function(c){(ref.isTextNode?ref.div:ref.txt).appendChild(_brBuildCard(c))})});
      if(_calR.length&&window.IBCAL)streamRefs.forEach(ref=>{_calR.forEach(function(r){(ref.isTextNode?ref.div:ref.txt).appendChild(IBCAL.noteCard(r))})});
      if(_wsPhantom)streamRefs.forEach(ref=>{(ref.isTextNode?ref.div:ref.txt).appendChild(_buildWsPhantomHint(_wsPhantom))});
      const aiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:replyText,reasoning_content:thinkingText||'',metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,showThinking:_resolveShowThinking(cfg)},friendId:_targetFriend,timestamp:Date.now()};/* 编号方式与群聊统一：随机后缀防同毫秒碰撞 */
      if(_srchLog.length)aiMsg.wsSearches=_srchLog;
      if(_memR.length)aiMsg.memOps=_memR.map(r=>({ok:r.ok,status:r.status||'',label:r.label,detail:r.detail}));
      if(_calR.length)aiMsg.calNotes=_calR.map(r=>({ok:r.ok,label:r.label,detail:r.detail}));
      {const _giImgs=_wsCollectGenImages(_wsResults);if(_giImgs.length)aiMsg.images=_giImgs;}/* 生成的图片随消息持久化，历史重载可见 */
      if(_targetThread)aiMsg.threadId=_targetThread;
      if(_callRes.truncated)aiMsg.truncated=true;/* 任务6：自动续写轮数用尽仍截断 */
      await dbPut('chatMessages',aiMsg);
      streamRefs.forEach(ref=>{
        if(aiMsg.id){ref.div.dataset.msgId=aiMsg.id;const db=document.createElement('button');db.className='chat-msg-del';db.textContent='✕';db.title='删除此消息';db.onclick=function(ev){ev.stopPropagation();deleteSingleMsg(aiMsg.id,ref.div)};ref.div.appendChild(db);
          if(typeof _chatSelectMode!=='undefined'&&_chatSelectMode&&ref.full&&!ref.div.querySelector('.chat-sel-circle')){const sc=document.createElement('div');sc.className='chat-sel-circle';sc.onclick=function(ev){ev.stopPropagation();_toggleMsgSel(aiMsg.id,sc)};ref.div.appendChild(sc)}/* BUGFIX: Select 模式中流式完成的消息补圈 */}
        if(aiMsg.truncated&&ref.full)ref.txt.appendChild(_buildContinuePill(aiMsg.id));/* 任务6 */
      });
      _syncMiniAfterStream(aiMsg.id,_targetFriend);
      if(activeFriendId!==_targetFriend)_markUnread(_targetFriend);
    }else{
      /* ===== 非流式传输路径（原有逻辑） ===== */
      const _srchLogN=[];/* 任务A：非流式同样收集搜索记录（三家通用） */
      const _callResN={};/* 并发隔离：本次调用的思考与截断结果 */
      let rawReply=await callApiChat(cfg,messages,{wantThinking:thinkingOn,autoContinue:true,chatKey:_targetFriend,result:_callResN,searchLog:_srchLogN});
      clearInterval(_typTimer);
      const _elapsed=Math.round((Date.now()-_typStart)/1000);
      const te=document.getElementById('chat-typing-'+_targetFriend);
      if(te){te.textContent=(cfg.nickname||cfg.model)+'（'+_elapsed+'秒）';te.style.animation='none';setTimeout(()=>{if(te.parentNode)te.remove()},1200)}
      var responsePartsN=_assistantResponseParts(rawReply,_callResN.reasoning_content||'');
      let thinkingText=responsePartsN.reasoning_content;
      var replyText=responsePartsN.content;
      /* 空输出防护（非流式）：与流式路径同一处理，走统一错误分类 */
      if(!(replyText&&String(replyText).trim())&&!(thinkingText&&String(thinkingText).trim()))throw window.IBERR?window.IBERR.err('empty_output'):new Error('API 返回了空内容');
      /* 非流式路径：先截取 mem_* 指令，再按顺序执行工作区操作 */
      var _memRNs=[];
      {const _mpn=_parseMemOps(replyText);
       if(_mpn.ops.length){replyText=_mpn.clean;if(amEnabled(cfg))_memRNs=await _execMemOps(_mpn.ops,cfg,cfg.nickname||cfg.model||'AI')}}
      /* CALENDAR：非流式同样截取 <cal_note> 并入库、扫描提及 */
      var _calRNs=[];
      try{if(window.IBCAL){const _cpn=await IBCAL.processReply(replyText,cfg);replyText=_cpn.clean;_calRNs=_cpn.results||[]}}catch(e){}
      /* Blog 阅读申请：截取 blog_read 标签并生成申请卡（标签不入库、不上屏） */
      var _brCardsNs=[];
      {const _bpn=_parseBlogReadOps(replyText);
       if(_bpn.ops.length){replyText=_bpn.clean;try{_brCardsNs=await _execBlogReadOps(_bpn.ops)}catch(e){}}}
      var _wsNs=_parseWsOps(replyText);
      var _wsRNs=[];
      if(_wsNs.ops.length)_wsRNs=await _execWsOps(_wsNs.ops,cfg.nickname||cfg.model||'AI',cfg);
      if(_wsNs.files&&_wsNs.files.length){try{await _wsArchiveFileBlocks(_wsNs.files,cfg.nickname||cfg.model||'AI')}catch(e){}}
      var _wsNsPhantom=_wsCheckPhantom(_wsNs.cleanText,_wsNs.ops.length);
      const aiMsg={id:'msg_'+Date.now()+'_'+Math.floor(Math.random()*100000),role:'assistant',content:replyText,reasoning_content:thinkingText||'',metadata:{model:cfg.provider||cfg.model||'',model_id:cfg.model||'',config_id:cfg.id,showThinking:_resolveShowThinking(cfg)},friendId:_targetFriend,timestamp:Date.now()};/* 编号方式与群聊统一：随机后缀防同毫秒碰撞 */
      if(_srchLogN.length)aiMsg.wsSearches=_srchLogN;/* 任务A */
      if(_memRNs.length)aiMsg.memOps=_memRNs.map(r=>({ok:r.ok,status:r.status||'',label:r.label,detail:r.detail}));
      if(_calRNs.length)aiMsg.calNotes=_calRNs.map(r=>({ok:r.ok,label:r.label,detail:r.detail}));
      {const _giImgsN=_wsCollectGenImages(_wsRNs);if(_giImgsN.length)aiMsg.images=_giImgsN;}/* 生成的图片随消息持久化 */
      if(_targetThread)aiMsg.threadId=_targetThread;
      if(_callResN.truncated)aiMsg.truncated=true;/* 任务6：自动续写轮数用尽仍截断 */
      await dbPut('chatMessages',aiMsg);
      if(activeFriendId===_targetFriend){
        appendChatBubble('ai',replyText,undefined,thinkingText||undefined,aiMsg.id,aiMsg.images,undefined,_wsRNs,undefined,cfg);
        if(_srchLogN.length||_memRNs.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_amAppendExtraCards(el,_srchLogN,_memRNs)});/* 任务A：非流式也显示搜索/记忆卡 */
        if(_wsPendingReads.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsReadHint())});
        if(_brCardsNs.length)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_brCardsNs.forEach(function(c){el.appendChild(_brBuildCard(c))})});
        if(_calRNs.length&&window.IBCAL)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){_calRNs.forEach(function(r){el.appendChild(IBCAL.noteCard(r))})});
        if(_wsNsPhantom)document.querySelectorAll('.chat-msg[data-msg-id="'+aiMsg.id+'"]').forEach(function(el){el.appendChild(_buildWsPhantomHint(_wsNsPhantom))});
        if(aiMsg.truncated)document.querySelectorAll('#chat-full-messages .chat-msg[data-msg-id="'+aiMsg.id+'"] .r-text').forEach(function(t){t.appendChild(_buildContinuePill(aiMsg.id))});/* 任务6 */
      }
      else _markUnread(_targetFriend);
    }
  }catch(err){
    if(_typTimer)clearInterval(_typTimer);
    const te=document.getElementById('chat-typing-'+_targetFriend);if(te)te.remove();
    _showStreamingUI(false);
    /* 失败时移除还没写入任何内容的流式气泡（含思考面板卡），避免残留带光标的空气泡；已流出内容的气泡保留 */
    try{(streamRefs||[]).forEach(function(ref){const _t=String((ref.txt&&ref.txt.textContent)||'');const _hasCards=typeof (ref.txt&&ref.txt.querySelector)==='function'&&!!ref.txt.querySelector('.ws-op-card');if(!_t.trim()&&!_hasCards&&ref.div.parentNode)ref.div.parentNode.removeChild(ref.div)})}catch(e){}
    /* 统一错误分类 + 角色化友好文案；完整技术错误已由 IBERR.report 与底层日志写入 Console */
    const _ibFE=window.IBERR?window.IBERR.report(err,{cfg:cfg,friendId:_targetFriend,stage:'chat'}):null;
    const _ibFT=_ibFE?_ibFE.text:'请求失败';
    if(!_ibFE||!_ibFE.dup){
      toast(_ibFT);
      if(activeFriendId===_targetFriend)appendChatBubble('ai',_ibFT);
    }
  }
  _chatSendingFor.delete(_targetFriend);
  if(sendBtn)sendBtn.disabled=false;
  autoResizeInput(input);
  /* AI 自主规划：回复成功保存后，异步生成下一次主动联系计划（fail-open，绝不影响聊天） */
  try{_activeMaybePlanNext({friendId:_targetFriend,threadId:_targetThread,character:cfg})}catch(e){}
  /* Deferred summary: generate AFTER response, async, no blocking */
  if(ss.enabled){
    const _sumFid=_targetFriend,_sumTid=_targetThread,_sumSealTs=_sealTs;
    setTimeout(async()=>{try{
      const _allM=filterSealed((await dbGetByIndex('chatMessages','byFriend',_sumFid)).filter(m=>_sumTid?m.threadId===_sumTid:!m.threadId).sort((a,b)=>a.timestamp-b.timestamp),_sumTid?0:_sumSealTs);
      await maybeSummarize(cfg,_sumFid,_sumTid,_allM);
    }catch(e){}},500);
  }
  if(currentPage==='chat')renderChatCalendar();
  updateChatStorageInfo();
}

function appendChatBubble(role,text,senderName,reasoningContent,msgId,images,files,wsResults,voice,modelConfig){
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
    /* BUGFIX: Select 模式进行中到达的新消息也补上选择圈 */
    if(msgId&&typeof _chatSelectMode!=='undefined'&&_chatSelectMode&&full){
      const c=document.createElement('div');c.className='chat-sel-circle';
      c.onclick=function(ev){ev.stopPropagation();_toggleMsgSel(msgId,c)};
      div.appendChild(c);
    }
    if(full){
      const sName=isUser?(_cachedUserName||'You'):(senderName||_getActiveAiName()||'AI');
      const timeStr=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const aiAvatar=!isUser?(_getApiAvatar()||_getApiAvatarByName(senderName)):'';
      const userAvatar=isUser?_cachedUserAvatar:'';
      const useAvatarLayout=isUser||!!aiAvatar;
      if(useAvatarLayout){
        div.classList.add('chat-msg-avatared');
        div.dataset.senderRole=isUser?'user':'ai';
        var _isGrpCtx=(activeFriendId||'').startsWith('group_');
        div.dataset.senderId=isUser?'_user_':(_isGrpCtx?((modelConfig&&modelConfig.id)||senderName||''):(activeFriendId||''));
        /* Detect if previous msg is from same sender → continuation */
        var _prevMsgs=container.querySelectorAll('.chat-msg');
        var _lastM=_prevMsgs.length?_prevMsgs[_prevMsgs.length-1]:null;
        var _isCont=_lastM&&_lastM.dataset.senderRole===(isUser?'user':'ai')&&_lastM.dataset.senderId===(isUser?'_user_':(_isGrpCtx?(senderName||''):(activeFriendId||'')));
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
        if(!isUser){_renderAiContent(txt,div,text,wsResults)}else if(voice){if(text)txt.appendChild(document.createTextNode(text));txt.appendChild(_buildVoiceEl(voice))}else{txt.textContent=text}
        div.appendChild(txt);
      }else{
        const head=document.createElement('div');head.className='r-head';
        head.innerHTML=esc(sName)+'<span class="r-time">'+timeStr+'</span>';
        div.appendChild(head);
        const txt=document.createElement('div');txt.className='r-text';
        if(!isUser){_renderAiContent(txt,div,text,wsResults)}else if(voice){if(text)txt.appendChild(document.createTextNode(text));txt.appendChild(_buildVoiceEl(voice))}else{txt.textContent=text}
        div.appendChild(txt);
      }
      fls.forEach(function(f){div.appendChild(_buildFileCard(f))});
      imgs.forEach(img=>{const el=document.createElement('img');el.className='chat-bubble-img';el.src=img.dataUrl;el.alt=img.name||'image';el.onclick=function(){_viewImageFull(img.dataUrl)};div.appendChild(el)});
      if(msgId){const db=document.createElement('button');db.className='chat-msg-del';db.textContent='✕';db.title='删除此消息';db.onclick=function(ev){ev.stopPropagation();deleteSingleMsg(msgId,div)};div.appendChild(db)}
    }else{
      if(senderName&&role==='ai'){
        var _acm=_mdMode();if(_acm==='full'||_acm==='partial')div.classList.add('md-rendered');
        const label=document.createElement('span');
        label.style.cssText='font-size:0.68rem;opacity:0.7;display:block;margin-bottom:2px';
        label.textContent=senderName;
        div.appendChild(label);
        _renderSegments(_panelMdHost(div),text,wsResults);
      }else if(!isUser){
        var _acm2=_mdMode();if(_acm2==='full'||_acm2==='partial')div.classList.add('md-rendered');
        _renderSegments(_panelMdHost(div),text,wsResults);
      }else if(voice){
        if(text)div.appendChild(document.createTextNode(text));
        div.appendChild(_buildVoiceEl(voice));
      }else{
        div.textContent=text;
      }
      fls.forEach(function(f){div.appendChild(_buildFileCard(f))});
      imgs.forEach(img=>{const el=document.createElement('img');el.className='chat-bubble-img';el.loading='lazy';el.decoding='async';el.src=img.dataUrl;el.alt=img.name||'image';el.style.maxWidth='180px';el.onclick=function(){_viewImageFull(img.dataUrl)};div.appendChild(el)});
      if(msgId){const db=document.createElement('button');db.className='chat-msg-del';db.textContent='✕';db.title='删除此消息';db.onclick=function(ev){ev.stopPropagation();deleteSingleMsg(msgId,div)};div.appendChild(db)}
    }
    container.appendChild(div);
    container.scrollTop=container.scrollHeight;
  });
}

async function deleteSingleMsg(id,bubble,frag){
  try{await dbDelete('chatMessages',id)}catch(e){toast('删除失败');return}
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
  /* Also remove from the other panel if visible */
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
/* ── OpenAI 前缀缓存诊断（console-only，零行为改变）──
   背景：OpenAI 自动缓存要求"请求开头与已缓存请求逐字一致且 ≥1024 token"才产生命中。
   此探针在每次 OpenAI 格式请求发出前，将本轮消息序列与上一轮快照对比，在控制台标注首个分歧位置并分类：
   · 分歧位于上一轮末条消息的动态尾部 → 结构正常，system+历史前缀可被复用；
   · 分歧早于该位置 → 前缀被逐轮变化的内容污染（打印分歧点上下文以定位来源）。
   仅在提示缓存开关开启时运行；不修改任何请求内容，随时可整段删除。 */
var _ibOaiCachePrev={};
function _ibOaiCacheDiag(cfg,msgs){
  try{
    if(!msgs||!msgs.length)return;
    var parts=[],lastStart=0;
    for(var i=0;i<msgs.length;i++){
      if(i===msgs.length-1)lastStart=parts.join('').length;
      var c=msgs[i]&&msgs[i].content;
      parts.push('\u00b6'+(msgs[i].role||'')+'\u00a7'+(typeof c==='string'?c:JSON.stringify(c)));
    }
    var full=parts.join('');
    var key=String((cfg&&cfg.id)||'');
    var prev=_ibOaiCachePrev[key];
    _ibOaiCachePrev[key]={full:full,lastStart:lastStart};
    if(!prev){console.info('[IB缓存诊断] 已记录本对话的前缀基线（'+full.length+' 字符）。从下一轮请求开始输出前缀稳定性对比。');return}
    var n=Math.min(prev.full.length,full.length),d=0;
    while(d<n&&prev.full.charCodeAt(d)===full.charCodeAt(d))d++;
    if(d>=prev.lastStart){
      console.info('[IB缓存诊断] ✓ 前缀稳定：与上一轮的分歧仅出现在上一轮末条消息的动态注入区（第 '+d+' / '+prev.full.length+' 字符）。system+历史部分逐字一致，理论上可被 OpenAI 前缀缓存复用（需该前缀 ≥1024 token）。若命中仍为 0，请对照相邻的 usage 原文日志：若 usage 中没有 prompt_tokens_details / input_tokens_details 字段，说明该模型或端点未回传命中数据（仪表盘只能显示 0，实际折扣以账单为准）；若字段存在且 cached_tokens 恒为 0，则为服务端未对该请求启用缓存。另：OpenAI 推理类模型（GPT-5 系等）经 chat/completions 调用时，官方文档说明其缓存利用率显著低于 Responses 接口（隐藏思考过程不跨轮保留），命中偶发或持续为 0 属服务端已知行为。');
    }else{
      var a=prev.full.slice(Math.max(0,d-90),d+150).replace(/\u00b6/g,'\n¶').replace(/\u00a7/g,'§');
      var b=full.slice(Math.max(0,d-90),d+150).replace(/\u00b6/g,'\n¶').replace(/\u00a7/g,'§');
      console.warn('[IB缓存诊断] ✗ 前缀在第 '+d+' 字符处提前分歧（上一轮末条消息本应从第 '+prev.lastStart+' 字符开始）——system 或历史消息存在逐轮变化，这会使 OpenAI 前缀缓存无法命中。\n【上一轮】…'+a+'…\n【本　轮】…'+b+'…\n提示：若上下文显示本轮历史从更靠后的消息开始，属于阶梯窗口的周期性前移（每隔若干轮的预期重建，仅一次性失效）；若是 system 或某条历史消息的文字发生了变化，则为需要修复的前缀污染点，请将此日志反馈给开发者。');
    }
  }catch(e){}
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
    if(p.type==='_image')return{type:'image_url',image_url:{url:'data:'+p.mime+';base64,'+p.base64}};
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
var _lastApiFinish='';/* 结束原因镜像（length/max_tokens/MAX_TOKENS = 被输出上限截断）。真实判定改用各调用自己的状态对象 */
/* ── 跨对话并发隔离 ──
   发送锁按好友分开，但"最近一次思考内容 / 结束原因 / 停止标记 / 可停止的传输"此前共用全局变量，
   两路对话同时进行时会互相串扰（停止只停最新一路、思考文本挂错对话、截断标记与自动续写误判）。
   现改为：每次聊天调用创建独立状态对象，按对话 ID 注册，停止按钮按当前查看的对话定位。 */
var _chatCallStates={};/* key = 好友/群 ID → {think,finish,stopped,ac} */
function _newCallState(opts){var st={key:(opts&&opts.chatKey)||'',think:'',finish:'',stopped:false,ac:null};if(st.key)_chatCallStates[st.key]=st;return st}
function _endCallState(st){if(st&&st.key&&_chatCallStates[st.key]===st)delete _chatCallStates[st.key]}
function _mSetThink(opts,v){_lastApiReasoning=v;if(opts&&opts._st)opts._st.think=v}
function _mSetFinish(opts,v){_lastApiFinish=v;if(opts&&opts._st)opts._st.finish=v}
function _finishIsTrunc(f){return f==='length'||f==='max_tokens'||f==='MAX_TOKENS'}
function stopStreaming(){
  /* 优先停当前查看的对话；当前对话没有进行中的传输而全局只剩一路时，停那一路 */
  var st=_chatCallStates[activeFriendId];
  if(!st){var ks=Object.keys(_chatCallStates);if(ks.length===1)st=_chatCallStates[ks[0]]}
  if(st){st.stopped=true;if(st.ac){try{st.ac.abort()}catch(e){}st.ac=null}return}
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

/* ══════════ 输出上限与自动续写 ══════════
   截断的根因是请求里写死的 max_tokens:4096。这里做三件事：
   ① 按 provider 给出更大的默认输出上限（DeepSeek V4 官方支持最高 384K 输出）；
   ② 若某服务商不接受高上限（400 报错提到 max_tokens），自动降回 4096 重试一次；
   ③ 即便如此仍被截断（finish_reason=length 等），自动带着已生成内容请求"无缝续写"，
      去除接缝处的重复后拼接，最多续 3 轮 —— 对用户表现为"没有长度限制"。 */
/* 各提供商单次输出上限：一律按主流旗舰模型的官方最大值顶格给（用户明确不在意 token 消耗）。
   若某个具体模型/中转支持不到这个数，请求会报错，下方包装器会读取错误里的建议值自动降档重试，
   所以这里可以放心写大——宁可"顶格再回退"，也不要"保守而浪费"。 */
const _PROVIDER_MAX_OUT={deepseek:65536,anthropic:64000,openai:32768,grok:32768,moonshot:32768,mistral:32768,qwen:32768,glm:32768,doubao:32768,minimax:32768,yi:16384,baichuan:16384,gemini:65536,custom:32768};
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
async function callApiChatStream(cfg,messages,opts){
  opts=opts||{};
  var budget=opts.maxTokens||_chatMaxTokens(cfg);
  var maxRounds=opts.autoContinue?(opts.maxContinues!=null?opts.maxContinues:_maxContinuesPref):0;
  var userChunk=opts.onChunk||function(){};
  var full='',thinkAcc='',msgs=messages,tokRetries=0,tokenParam=_tokParamGet(cfg);
  var st=_newCallState(opts);/* 并发隔离：本次调用的独立状态（思考/结束原因/停止/可中止句柄），按 chatKey 注册供停止按钮定位 */
  /* FC：原生函数调用（anthropic/openai 走 tools 参数；无工具块/开关关/其他厂商 → 不激活，回落 XML 通道） */
  var _fcCtx=null;
  try{if(!opts.disableTools&&typeof IBFC!=='undefined'){var _fcv=IBFC.prepare(messages,PROVIDERS[cfg.provider]?.format||'openai',{vision:_usesNativeDeepSeekVision(cfg)||(cfg.vision!==undefined?!!cfg.vision:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].vision))});if(_fcv&&_fcv.active){_fcCtx=_fcv;msgs=_fcCtx.messages}}}catch(e){_fcCtx=null}
  try{/* 并发隔离：任何退出路径都在函数尾 finally 注销本对话的调用状态 */
  for(var round=0;;round++){
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
    var piece='';
    try{piece=await _callApiChatStreamOnce(cfg,msgs,o)}
    catch(e){
      /* 联网搜索：报错明确指向搜索工具 → 只去掉搜索重试，保留原生 FC */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&/web_search|google_search/i.test(String(e&&e.message||e))){opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* FC：端点不认 tools 参数 → 关掉 FC 原样重试一次（回落 XML 通道） */
      if(_fcCtx&&round===0&&!full&&/tool/i.test(String(e&&e.message||e))){_fcCtx=null;msgs=messages;round--;continue}
      /* 联网搜索：端点不认搜索参数(4xx 且非鉴权错) → 去掉搜索原样重试一次 */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!IBWS.blocked(cfg)&&IBWS.errLooksParam(e)){opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* ① 新款 OpenAI 系模型要求 max_completion_tokens：换参数名原额重试（不降额） */
      if(!tokenParam&&round===0&&_errWantsCompletionParam(e)){tokenParam='max_completion_tokens';_tokParamRemember(cfg);round--;continue}
      /* ② 输出上限超过该模型/中转允许值：优先用报错里给的建议值一步到位，否则减半（下限1024），最多3次 */
      if(round===0&&tokRetries<3&&budget>1024&&_errLooksMaxTok(e)){
        tokRetries++;
        var _sug=_extractSuggestedMaxTok(e);
        budget=(_sug&&_sug<budget)?_sug:Math.max(1024,Math.floor(budget/2));
        round--;continue;
      }
      if(round>0&&full){_lastApiReasoning=thinkAcc;if(opts.result){opts.result.reasoning_content=thinkAcc;opts.result.truncated=_finishIsTrunc(st.finish)}return full}/* 续写失败不丢已有内容 */
      throw e;
    }
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
  }finally{_endCallState(st)}
}

/* 非流式：同样的包装策略 */
async function callApiChat(cfg,messages,opts){
  opts=opts||{};
  var budget=opts.maxTokens||_chatMaxTokens(cfg);
  var maxRounds=opts.autoContinue?(opts.maxContinues!=null?opts.maxContinues:_maxContinuesPref):0;
  var timeoutMs=opts.timeoutMs||(opts.autoContinue?300000:0);/* 长输出给足等待时间 */
  var full='',thinkAcc='',msgs=messages,tokRetries=0,tokenParam=_tokParamGet(cfg),lastTrunc=false;
  var st=_newCallState(null);/* 并发隔离：仅用于按调用隔离思考/结束原因；非流式没有停止入口，不注册停止路由（与原行为一致） */
  /* FC：原生函数调用（与流式同一套；无工具块/开关关/其他厂商 → 不激活） */
  var _fcCtx=null;
  try{if(!opts.disableTools&&typeof IBFC!=='undefined'){var _fcv=IBFC.prepare(messages,PROVIDERS[cfg.provider]?.format||'openai',{vision:_usesNativeDeepSeekVision(cfg)||(cfg.vision!==undefined?!!cfg.vision:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].vision))});if(_fcv&&_fcv.active){_fcCtx=_fcv;msgs=_fcCtx.messages}}}catch(e){_fcCtx=null}
  try{/* 并发隔离：任何退出路径都在函数尾 finally 注销状态 */
  for(var round=0;;round++){
    var o=Object.assign({},opts,{maxTokens:budget,wantMeta:true});
    o._st=st;/* 并发隔离：单次调用把思考/结束原因写进本调用的状态对象 */
    if(tokenParam)o.tokenParam=tokenParam;
    if(_fcCtx)o._fcCtx=_fcCtx;
    if(timeoutMs)o.timeoutMs=timeoutMs;
    if(round>0)o.wantThinking=false;
    var r;
    try{r=await _callApiChatOnce(cfg,msgs,o)}
    catch(e){
      /* 联网搜索：报错明确指向搜索工具 → 只去掉搜索重试，保留原生 FC */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&/web_search|google_search/i.test(String(e&&e.message||e))){opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* AI 规划 jsonMode：端点不认 response_format → 去掉 JSON 模式原样重试一次（降级为提示词 + 容错解析） */
      if(opts.jsonMode&&round===0&&!full&&/response_format|json[ _-]?mode|json_object/i.test(String(e&&e.message||e))){opts=Object.assign({},opts,{jsonMode:false});round--;continue}
      /* FC：端点不认 tools 参数 → 关掉 FC 原样重试一次（回落 XML 通道） */
      if(_fcCtx&&round===0&&!full&&/tool/i.test(String(e&&e.message||e))){_fcCtx=null;msgs=messages;round--;continue}
      /* 联网搜索：端点不认搜索参数(4xx 且非鉴权错) → 去掉搜索原样重试一次 */
      if(!opts._noWebSearch&&round===0&&!full&&typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!IBWS.blocked(cfg)&&IBWS.errLooksParam(e)){opts._noWebSearch=true;IBWS.markUnsupported(cfg,e);round--;continue}
      /* ① 新款 OpenAI 系模型要求 max_completion_tokens：换参数名原额重试（不降额） */
      if(!tokenParam&&round===0&&_errWantsCompletionParam(e)){tokenParam='max_completion_tokens';_tokParamRemember(cfg);round--;continue}
      /* ② 输出上限超过该模型/中转允许值：优先用报错建议值一步到位，否则减半（下限1024），最多3次 */
      if(round===0&&tokRetries<3&&budget>1024&&_errLooksMaxTok(e)){
        tokRetries++;
        var _sug=_extractSuggestedMaxTok(e);
        budget=(_sug&&_sug<budget)?_sug:Math.max(1024,Math.floor(budget/2));
        round--;continue;
      }
      if(round>0&&full){lastTrunc=false;break}
      throw e;
    }
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
  return opts.wantMeta?{text:full,truncated:lastTrunc}:full;
  }finally{_endCallState(st)}
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
  opts=opts||{};
  _mSetThink(opts,'');_mSetFinish(opts,'');
  const maxTok=opts.maxTokens||4096;
  const timeoutMs=opts.timeoutMs||60000;
  const wantThink=!!opts.wantThinking;
  const onChunk=opts.onChunk||(()=>{});
  const onThink=opts.onThink||(()=>{});/* 思考链实时回调 */
  const fmt=PROVIDERS[cfg.provider]?.format||'openai';
  /* 不改写用户消息来索取思维链。原生 reasoning delta 走独立侧通道。 */
  let _msgs=messages;
  /* 联网搜索边界：开关开启时在 system 末尾追加一句使用边界，与搜索工具同时出现、同时消失 */
  try{if(typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!(opts&&opts._noWebSearch)&&!IBWS.blocked(cfg)&&IBWS.SYS_NOTE){_msgs=_msgs.map(m=>m&&m.role==='system'?Object.assign({},m,{content:String(m.content||'')+IBWS.SYS_NOTE}):m)}}catch(e){}
  /* 联网搜索·逐轮硬提醒：文件任务时把 TURN_NOTE 附到最后一条 user 消息（仅发送副本，零缓存代价） */
  try{if(typeof IBWS!=='undefined'&&IBWS.steer)_msgs=IBWS.steer(_msgs,cfg,opts)}catch(e){}
  const ac=opts.abortController||new AbortController();const _extAC=!!opts.abortController;if(!_extAC)_streamAbortController=ac;
  if(opts._st)opts._st.ac=ac;/* 并发隔离：供停止按钮按对话中止 */
  const tm=setTimeout(()=>ac.abort(),timeoutMs);
  /* 心跳超时：默认45秒没收到任何chunk就中断，可通过opts.heartbeatMs覆盖 */
  const _hbMs=opts.heartbeatMs||45000;
  let _heartbeat=null;
  const _resetHB=()=>{if(_heartbeat)clearTimeout(_heartbeat);_heartbeat=setTimeout(()=>ac.abort(),_hbMs)};
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
      const sysMsg=_msgs.find(m=>m.role==='system');
      const chatMsgs=_msgs.filter(m=>m.role!=='system').map(m=>{if(m&&m._fc){var _c=Object.assign({},m);delete _c._fc;return _c}return{role:m.role,content:_adaptContentForApi(m.content,'anthropic')}});
      _injectAnthropicMsgCache(chatMsgs,cfg);/* 消息级缓存断点 */
      const b={model:cfg.model,max_tokens:maxTok,stream:true,messages:chatMsgs};
      if(opts._fcCtx&&opts._fcCtx.tools){b.tools=opts._fcCtx.tools.anthropic;IBFC.newAcc(opts._fcCtx)}
      try{if(typeof IBWS!=='undefined')IBWS.attach(b,'anthropic',cfg,opts)}catch(e){}
      if(sysMsg){if(cfg.promptCache!==false&&cfg.provider==='anthropic'){b.system=[{type:'text',text:sysMsg.content,cache_control:_ccObj(cfg)}]}else{b.system=sysMsg.content}}if(cfg.temperature!=null)b.temperature=cfg.temperature;
      body=JSON.stringify(b);
    }else if(fmt==='gemini'){
      url=cfg.endpoint.replace('{model}',cfg.model).replace('generateContent','streamGenerateContent')+'?key='+cfg.apiKey+'&alt=sse';
      hdrs={'Content-Type':'application/json'};
      const sysMsgG=_msgs.find(m=>m.role==='system');
      const contents=_msgs.filter(m=>m.role!=='system').map(m=>{
        const parts=[];
        if(Array.isArray(m.content)){m.content.forEach(p=>{if(p.type==='_image')parts.push({inlineData:{mimeType:p.mime,data:p.base64}});else if(p.type==='_audio')parts.push({inlineData:{mimeType:p.mime||'audio/wav',data:p.base64}});else parts.push({text:p.text||''})})}
        else{parts.push({text:String(m.content||'')})}
        return{role:m.role==='assistant'?'model':'user',parts}
      });
      const gB={contents};if(sysMsgG)gB.system_instruction={parts:[{text:sysMsgG.content}]};
      gB.generationConfig={maxOutputTokens:maxTok};/* 之前完全没设，Gemini 按默认值截断输出 */
      if(cfg.temperature!=null)gB.generationConfig.temperature=cfg.temperature;
      try{if(typeof IBWS!=='undefined')IBWS.attach(gB,'gemini',cfg,opts)}catch(e){}
      body=JSON.stringify(gB);
    }e{if(/key|token|secret|authorization/i.test(k)&&typeof o[k]==='string'&&o[k]){o[k]=String(o[k]).slice(0,4)+'***'+String(o[k]).slice(-4)}else _dbgRedact(o[k])}})(_dbgBody);
        console.log('[IB调试] 最终请求体:',JSON.stringify(_dbgBody,null,2));
        console.log('[IB调试] 请求URL:',url,'| Authorization:',cfg.apiKey?('Bearer '+String(cfg.apiKey).slice(0,6)+'***'):'(无)');
      }catch(e){}
      body=JSON.stringify(ob);
    }
    const res=await fetch(url,{method:'POST',signal:ac.signal,headers:hdrs,body});
    clearTimeout(tm);_resetHB();
    if(!res.ok){const e=await res.text();console.error('[IB API错误]',res.status,e);throw new Error(res.status+': '+e)}
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
            if(j.usageMetadata){var _gu=j.usageMetadata,_gc=_gu.cachedContentTokenCount||0;opts._tkU={i:Math.max(0,(_gu.promptTokenCount||0)-_gc),cr:_gc,cw:0,o:(_gu.candidatesTokenCount||0)+(_gu.thoughtsTokenCount||0)}}
            if(j.candidates&&j.candidates[0]&&j.candidates[0].finishReason)_mSetFinish(opts,j.candidates[0].finishReason);/* 记账加固：用量改为流末统一落账 */
            const _gm=j.candidates?.[0]?.groundingMetadata;if(_gm)_ibwsFeedGrounding(_gm,opts);/* 任务A：搜索元数据多在流尾块 */
            const parts=j.candidates?.[0]?.content?.parts||[];
            for(const p of parts){if(p.thought){thinkingText+=p.text||'';onThink(p.text||'')}else if(p.text){fullText+=p.text;onChunk(p.text)}}
          }else{
            if(j.usage){var _pu=j.usage,_pc=(_pu.prompt_tokens_details&&_pu.prompt_tokens_details.cached_tokens)||(_pu.input_tokens_details&&_pu.input_tokens_details.cached_tokens)||_pu.prompt_cache_hit_tokens||0;if(cfg.promptCache!==false)try{console.info('[IB缓存诊断] usage 原文: '+JSON.stringify(_pu))}catch(e2){}opts._tkU={i:Math.max(0,(_pu.prompt_tokens||0)-_pc),cr:_pc,cw:0,o:_pu.completion_tokens||0}}/* 记账加固：暂存覆盖（累计式 usage 以末次为准），流末统一落账，防个别中转逐 chunk 带 usage 造成重复记账 *//* DeepSeek 命中字段兼容：prompt_cache_hit_tokens；input_tokens_details 为 Responses 形状回传的兜底 */
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
    if(opts._tkU){try{_tkRecord(cfg,opts._tkU)}catch(e2){}opts._tkU=null}/* 记账加固：流末统一落账 */
    if(!_extAC&&_streamAbortController===ac)_streamAbortController=null;if(opts._st&&opts._st.ac===ac)opts._st.ac=null;if(_heartbeat)clearTimeout(_heartbeat);_ibwsFlushSearchMeta(opts);return fullText;
  }catch(e){
    clearTimeout(tm);if(!_extAC&&_streamAbortController===ac)_streamAbortController=null;if(opts._st&&opts._st.ac===ac)opts._st.ac=null;if(_heartbeat)clearTimeout(_heartbeat);
    if(opts._tkU){try{_tkRecord(cfg,opts._tkU)}catch(e2){}opts._tkU=null}/* 记账加固：手动停止/超时的请求输入侧照样计费，此前一律漏记，现按已知量落账（输出可能少记） */
    if(e.name==='AbortError'){
      if(_anthWebThinkMux)_anthWebThinkMux.finish();
      if(thinkingText)_mSetThink(opts,thinkingText);
      if(fullText.trim()){_ibwsFlushSearchMeta(opts);return fullText}
      throw new Error('请求超时或已停止')
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
function _createStreamBubble(_targetFriend,senderName){
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
    var _sMode=_mdMode();if(_sMode==='full'||_sMode==='partial')div.classList.add('md-rendered');
    if(full){
      const sName=senderName||_getActiveAiName()||'AI';
      const timeStr=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const aiAvatar=_getApiAvatar()||_getApiAvatarByName(senderName);
      if(aiAvatar){
        /* ── New avatar layout for streaming ── */
        div.classList.add('chat-msg-avatared');
        div.dataset.senderRole='ai';
        var _isGrpSCtx=(activeFriendId||'').startsWith('group_');
        div.dataset.senderId=_isGrpSCtx?(senderName||''):(activeFriendId||'');
        var _prevMsgs=container.querySelectorAll('.chat-msg');
        var _lastM=_prevMsgs.length?_prevMsgs[_prevMsgs.length-1]:null;
        var _isCont=_lastM&&_lastM.dataset.senderRole==='ai'&&_lastM.dataset.senderId===(_isGrpSCtx?(senderName||''):(activeFriendId||''));
        if(!_isCont){
          const hdr=document.createElement('div');hdr.className='chat-msg-header align-left';
          hdr.appendChild(_buildAvatarCircle(sName,aiAvatar));
          const nm=document.createElement('span');nm.className='r-head-name';nm.textContent=sName;hdr.appendChild(nm);
          const tm=document.createElement('span');tm.className='r-time';tm.textContent=timeStr;hdr.appendChild(tm);
          container.appendChild(hdr);
        }else{
          const ct=document.createElement('div');ct.className='chat-msg-cont-time';ct.style.textAlign='left';ct.style.marginLeft='46px';ct.textContent=timeStr;container.appendChild(ct);
        }
        const txt=document.createElement('div');txt.className='r-text chat-stream-cursor';
        div.appendChild(txt);refs.push({div,txt,full:true,container});
      }else{
        /* ── Original layout for AI without avatar ── */
        const head=document.createElement('div');head.className='r-head';
        head.innerHTML=esc(sName)+'<span class="r-time">'+timeStr+'</span>';
        div.appendChild(head);
        const txt=document.createElement('div');txt.className='r-text chat-stream-cursor';
        div.appendChild(txt);refs.push({div,txt,full:true,container});
      }
    }else{
      if(senderName){
        const label=document.createElement('span');label.style.cssText='font-size:0.68rem;opacity:0.7;display:block;margin-bottom:2px';label.textContent=senderName;div.appendChild(label)
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
  opts=opts||{};
  _mSetThink(opts,'');_mSetFinish(opts,'');
  const maxTok=opts.maxTokens||4096;
  const timeoutMs=opts.timeoutMs||60000;
  const wantThink=!!opts.wantThinking;
  const pack=(text,truncated)=>opts.wantMeta?{text:text,truncated:!!truncated}:text;
  const fmt=PROVIDERS[cfg.provider]?.format||'openai';

  /* 不要求模型把内部推理写进正文；仅接收 API 的原生 reasoning/thinking block。 */
  let _msgs=messages, _prefillThinking=false;
  /* 联网搜索边界：开关开启时在 system 末尾追加一句使用边界，与搜索工具同时出现、同时消失 */
  try{if(typeof IBWS!=='undefined'&&IBWS.on(cfg)&&!(opts&&opts._noWebSearch)&&!IBWS.blocked(cfg)&&IBWS.SYS_NOTE){_msgs=_msgs.map(m=>m&&m.role==='system'?Object.assign({},m,{content:String(m.content||'')+IBWS.SYS_NOTE}):m)}}catch(e){}
  /* 联网搜索·逐轮硬提醒：文件任务时把 TURN_NOTE 附到最后一条 user 消息（仅发送副本，零缓存代价） */
  try{if(typeof IBWS!=='undefined'&&IBWS.steer)_msgs=IBWS.steer(_msgs,cfg,opts)}catch(e){}

  if(fmt==='anthropic'){
    const sysMsg=_msgs.find(m=>m.role==='system');
    const chatMsgs=_msgs.filter(m=>m.role!=='system').map(m=>{if(m&&m._fc){var _c=Object.assign({},m);delete _c._fc;return _c}return{role:m.role,content:_adaptContentForApi(m.content,'anthropic')}});
    _injectAnthropicMsgCache(chatMsgs,cfg);/* 消息级缓存断点 */
    if(_prefillThinking) chatMsgs.push({role:'assistant',content:'<thinking>'});
    const body={model:cfg.model,max_tokens:maxTok,messages:chatMsgs};
    if(opts._fcCtx&&opts._fcCtx.tools)body.tools=opts._fcCtx.tools.anthropic;
    try{if(typeof IBWS!=='undefined')IBWS.attach(body,'anthropic',cfg,opts)}catch(e){}
    if(sysMsg){if(cfg.promptCache!==false&&cfg.provider==='anthropic'){body.system=[{type:'text',text:sysMsg.content,cache_control:_ccObj(cfg)}]}else{body.system=sysMsg.content}}
    if(cfg.temperature!=null)body.temperature=cfg.temperature;
    const hdrs={'Content-Type':'application/json','x-api-key':cfg.apiKey,
      'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'};
    _ccBeta(hdrs,cfg);
    const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const res=await fetch(cfg.endpoint,{method:'POST',signal:ac.signal,headers:hdrs,body:JSON.stringify(body)});
      clearTimeout(tm);
      if(!res.ok){const e=await res.text();throw new Error(res.status+': '+e)}
      const data=await res.json();
      try{if(data&&data.usage){_tkRecord(cfg,{i:data.usage.input_tokens||0,cr:data.usage.cache_read_input_tokens||0,cw:data.usage.cache_creation_input_tokens||0,o:data.usage.output_tokens||0})}}catch(e){}/* 清理：原第二行按 OpenAI 字段解析 Anthropic 响应的死代码已删（恒为全零被守卫拦下） */
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
    const contents=_msgs.filter(m=>m.role!=='system').map(m=>{
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
    /* Gemini: thinking is handled by system prompt <thinking> tags, not native API */
    const ac=new AbortController();const tm=setTimeout(()=>ac.abort(),timeoutMs);
    try{
      const res=await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(gBody),signal:ac.signal});
      clearTimeout(tm);
      if(!res.ok){const e=await res.text();throw new Error(res.status+': '+e)}
      const data=await res.json();
      try{if(data.usageMetadata){var _gu2=data.usageMetadata,_gc2=_gu2.cachedContentTokenCount||0;_tkRecord(cfg,{i:Math.max(0,(_gu2.promptTokenCount||0)-_gc2),cr:_gc2,cw:0,o:(_gu2.candidatesTokenCount||0)+(_gu2.thoughtsTokenCount||0)})}}catch(e){}
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
  oBody[opts.tokenParam||'max_tokens']=maxTok;/* 新款 OpenAI 系模型由包装器切换为 max_completion_tokens */
  if(cfg.promptCache!==false)oBody.prompt_cache_key='ib_'+String(cfg.id||'');/* OpenAI 缓存本自动生效；此 key 只用于提升路由命中率 */
  if(cfg.promptCache!==false){try{_ibOaiCacheDiag(cfg,oBody.messages)}catch(e){}}/* 前缀缓存诊断（console-only） */
  if(cfg.temperature!=null)oBody.temperature=cfg.temperature;
  const res=await fetch(cfg.endpoint,{
    method:'POST',signal:ac.signal,
    headers:Object.assign({'Content-Type':'application/json'},cfg.apiKey?{Authorization:'Bearer '+cfg.apiKey}:{}),
    body:JSON.stringify(oBody)
  });
  clearTimeout(tm);
  if(!res.ok){const e=await res.text();throw new Error(res.status+': '+e)}
  const _oct=res.headers.get('content-type')||'';
  if(_oct.includes('text/html')){throw new Error('API端点返回了网页而非JSON——请检查端点URL是否正确。如使用中转站，请确认API地址填写到完整路径（如 https://xxx.com/v1/chat/completions）')}
  const data=await res.json();
  try{if(data.usage){var _pu4=data.usage,_pc4=(_pu4.prompt_tokens_details&&_pu4.prompt_tokens_details.cached_tokens)||(_pu4.input_tokens_details&&_pu4.input_tokens_details.cached_tokens)||_pu4.prompt_cache_hit_tokens||0;if(cfg.promptCache!==false)try{console.info('[IB缓存诊断] usage 原文: '+JSON.stringify(_pu4))}catch(e2){}_tkRecord(cfg,{i:Math.max(0,(_pu4.prompt_tokens||0)-_pc4),cr:_pc4,cw:0,o:_pu4.completion_tokens||0})}}catch(e){}/* 修复：OpenAI 兼容非流式聊天此前完全不记用量；DeepSeek / Responses 形状命中字段一并兼容 */
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
  const msgs=await dbGetAll('chatMessages');
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
  const msgs=await dbGetAll('chatMessages');
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
  const msgs=await dbGetAll('chatMessages');
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
  const msgs=await dbGetAll('chatMessages');msgs.sort((a,b)=>a.timestamp-b.timestamp);
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

async function updateChatCount(){
  try{
    const msgs=await dbGetAll('chatMessages');
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
  if(hint)hint.textContent='每次注入上限约 '+budget+' 字符';
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
async function updateChatStorageInfo(){try{const all=await dbGetAll('chatMessages');let t=0,imgCount=0;all.forEach(m=>{try{t+=new Blob([JSON.stringify(m)]).size}catch(e){t+=JSON.stringify(m).length*2};if(m.images&&m.images.length)imgCount+=m.images.length});const el=document.getElementById('chat-storage-size');if(el)el.textContent=_fmtB(t);const bar=document.getElementById('chat-storage-bar');if(bar){const p=Math.min(100,t/10485760*100);bar.style.width=p.toFixed(1)+'%'}const c=document.getElementById('chat-storage-count');if(c)c.textContent=all.length+' 条消息'+(imgCount?' · '+imgCount+' 张图片':'')}catch(e){}}
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
    let added=0,lastName='';
    for(const file of files){
      if(_pendingFiles.length>=FILE_MAX_COUNT){toast('最多附加 '+FILE_MAX_COUNT+' 个文件');break}
      if(file.size>FILE_MAX_BYTES){toast('「'+file.name+'」过大（上限 '+_fmtFileSize(FILE_MAX_BYTES)+'）');continue}
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
      }catch(e){toast('「'+file.name+'」读取失败')}
    }
    renderAttachPreviews();
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
window.autoResizeInput=autoResizeInput;
window._parseThinking=_parseThinking;
window._assistantResponseParts=_assistantResponseParts;
window._anthropicWebThinkResponseMode=_anthropicWebThinkResponseMode;
window._mergeAnthropicWebThink=_mergeAnthropicWebThink;
window._makeAnthropicWebThinkMux=_makeAnthropicWebThinkMux;
window._cacheStableSlice=_cacheStableSlice;
window._ccObj=_ccObj;
window._ccBeta=_ccBeta;
window._ibOaiCacheDiag=_ibOaiCacheDiag;
window._injectAnthropicMsgCache=_injectAnthropicMsgCache;
window._adaptContentForApi=_adaptContentForApi;
window._adaptMessageForApi=_adaptMessageForApi;
window._newCallState=_newCallState;
window._endCallState=_endCallState;
window._mSetThink=_mSetThink;
window._mSetFinish=_mSetFinish;
window._finishIsTrunc=_finishIsTrunc;
window.stopStreaming=stopStreaming;
window.stopMemoryStreaming=stopMemoryStreaming;
window._showStreamingUI=_showStreamingUI;
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
ibChatLive('_ibOaiCachePrev', function(){return _ibOaiCachePrev}, function(v){_ibOaiCachePrev=v});
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
  loadBlogComments: loadBlogComments,
  requestBlogComment: requestBlogComment,
  deleteBlogComment: deleteBlogComment,
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
  _attachCloseHandler: _attachCloseHandler,
  _WS_OPEN_RE: _WS_OPEN_RE,
  _lastApiReasoning: _lastApiReasoning,
  _ibOaiCachePrev: _ibOaiCachePrev,
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
