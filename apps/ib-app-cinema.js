/* ====================================================================
   观影室（Cinema）— 桌面 APP
   --------------------------------------------------------------------
   支持多视频来源（Media Adapter v1）：本地 / 直链 .mp4/.webm / HLS .m3u8 /
   YouTube 官方 embed / Bilibili 官方 embed；未知来源 graceful fallback。
    - 只经 ctx 与主程序对话（sdk 2）；不直接触碰底层 db/发送函数。
    - 会话/进度/Memory/Proactive 经 IB.activity 统一运行时；
      · 视频与字幕文件一律不入库、不随备份（播放点只存秒数与梗概）。
      · 上下文经 ctx 注入：只透露到播放点为止的字幕 + 进度 + 梗概。
      · 留影帧经 IB.activity.send 的 visionReference 进入**既有**图片视觉链路，
        只随当轮请求（request-local），不入库、不进 Memory、不写聊天记录。
   - Adapter 由 MB(IBMedia) 提供：load/play/pause/seek/getCurrentTime/getDuration/destroy。
   禁止：DRM 绕过 / 防盗链破解 / Cookie·Token 偷取 / 下载受保护视频 / 代理绕过平台限制。
   ==================================================================== */
(function(){
  'use strict';
  if(!window.IBApps||!window.IBActivity)return;
  var H,C;var S={dm:true,subN:6,vq:'m'};
  var subs=[],sum={recap:'',upTo:0},_activity=null,_aiId='',_lastCue='',_typingTimer=null,_grabError='';
  var _media=null,_adapter=null,_lastPush=0,_subtitleLoaded=false,_subtitleName='';
  var _pendingProgress=null,_progressBusy=false,_progressPromise=Promise.resolve(),_resumeActivities=[],_resumeTargetId='',_summaryBusy=false,_chatOpenedRole=''
  var CinemaCore=window.IBCinemaCore||null;
  var $=function(s){return H&&H.querySelector(s)};

  function esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
  function toast(m){try{if(C&&C.ui&&C.ui.toast)C.ui.toast(m)}catch(e){try{console.info('[Cinema]',m)}catch(e2){}}}
  function fmt(sec){sec=Math.max(0,Math.floor(sec||0));var m=Math.floor(sec/60),s=sec%60,h=Math.floor(m/60);m%=60;return(h?(h+':'+String(m).padStart(2,'0')):String(m))+':'+String(s).padStart(2,'0')}
  function hashStr(s){var h=0;for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0}return Math.abs(h)}

  /* ---- Media Adapter 加载（独立模块，卸载即净） ---- */
  function ensureMedia(){return new Promise(function(res){if(window.IBMedia){res();return}var s=document.createElement('script');s.src='apps/ib-media-adapter.js';s.onload=function(){res()};s.onerror=function(){res()};document.head.appendChild(s)})}

  /* ---- 字幕解析（srt/vtt） ---- */
  function decode(buf){try{return new TextDecoder('utf-8',{fatal:true}).decode(buf)}catch(e){try{return new TextDecoder('gb18030').decode(buf)}catch(e2){return new TextDecoder().decode(buf)}}}
  function tsec(t){var p=String(t).trim().replace(',','.').split(':');var v=0;for(var i=0;i<p.length;i++)v=v*60+parseFloat(p[i]);return isNaN(v)?0:v}
  function parseSubs(text){var out=[],lines=String(text).split(/\r?\n/),i=0;for(;i<lines.length;i++){var m=lines[i].match(/(\S+)\s+-->\s+(\S+)/);if(!m)continue;var s=tsec(m[1]),e=tsec(m[2]);var buf=[];i++;for(;i<lines.length&&lines[i].trim()!=='';i++)buf.push(lines[i]);var txt=buf.join(' ').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim().slice(0,400);if(txt)out.push([s,e,txt])}return out}
  function renderSubtitleStatus(){var node=$('#ci-sub-status');if(!node)return;var oldName=String(_subtitleName||(_activity&&_activity.progress&&_activity.progress.subtitleName)||'');node.textContent=_subtitleLoaded?'字幕已加载 · '+subs.length+' 条 · '+_subtitleName:(oldName?'上次使用“'+oldName+'”；字幕文件不会保存，请重新选择以恢复同步。':'没有加载字幕。仍可按播放时间、你的描述与经你选择的留影讨论；角色不会编造台词。');node.classList.toggle('loaded',_subtitleLoaded)}
  function loadSub(file){if(!file)return;file.arrayBuffer().then(function(buf){try{subs=parseSubs(decode(buf));_subtitleLoaded=subs.length>0;_subtitleName=String(file.name||'本地字幕').slice(0,120);toast(_subtitleLoaded?'已加载字幕 '+subs.length+' 条':'字幕文件中没有可识别的 SRT/VTT 字幕');_lastCue='';renderSubtitleStatus();renderRecap();if(_adapter&&_adapter.getCurrentTime)_persistProgress(_adapter.getCurrentTime(),_adapter.getDuration(),true)}catch(e){_subtitleLoaded=false;_subtitleName=String(file.name||'').slice(0,120);renderSubtitleStatus();renderRecap();toast('字幕解析失败')}}).catch(function(){_subtitleLoaded=false;_subtitleName=String(file.name||'').slice(0,120);renderSubtitleStatus();renderRecap();toast('读取字幕失败')})}
  function recentSubs(sec,n){var r=[];for(var c of subs){if(c[0]<=sec)r.push(c);else break}return r.slice(-(n||S.subN))}
  function cueAt(sec){for(var c of subs){if(sec>=c[0]&&sec<=c[1])return c}return null}

  /* ---- 弹幕 / 共看面板 ---- */
  function strip(t){return String(t||'').replace(/<[^>]+>/g,'')}
  function danmaku(t){if(!S.dm||!t)return;var lay=H&&H.querySelector('#ci-dm-l');if(!lay)return;var b=document.createElement('div');b.className='ci-dmi';b.textContent=t;lay.appendChild(b);var dur=Math.min(8,Math.max(5,t.length*0.18));b.style.animationDuration=dur+'s';setTimeout(function(){try{b.remove()}catch(e){}},dur*1000+50);setTimeout(function(){if(lay.childElementCount>40)try{lay.removeChild(lay.firstChild)}catch(e){}},dur*1000+60)}
  /* 消息过滤（M1 · Activity Context）：friend 必须一致；legacy 活动继续按旧频道匹配；
     新活动只认 metadata.activityId === 当前活动 id —— 防止角色主聊天里的普通消息灌进小窗。 */
  function _sameChannel(am){
    if(!_activity)return false;
    if(am&&am.friendId&&String(am.friendId)!==String(_activity.roleId))return false;
    if(_activity.threadId)return !(am&&am.threadId&&am.threadId!==_activity.threadId);
    return !!(am&&am.activityId&&String(am.activityId)===String(_activity.id));
  }
  function onMsg(am){if(!_sameChannel(am))return;var who=(am&&am.role==='user')?'我':((am&&am.senderName)||'TA');var text=String(am&&am.content||'');_endTyping();danmaku(strip(text));if(who==='我'){var h=$('#ci-msgs');if(h)for(var i=0;i<h.children.length;i++){var row=h.children[i];if(row.dataset&&row.dataset.pendingText===text){if(am.id)row.dataset.messageId=String(am.id);delete row.dataset.pendingText;return}}}_appendMsg(who,text,am&&am.id)}
  /* turn 通道过滤（M1.5）：只响应属于当前活动的 turn —— 普通聊天/其他角色的 turn
     不得点亮或熄灭 Cinema 的 typing。超时兜底：缺失 turn end（非流式/失败路径）时自动收起。 */
  function onTurn(t){
    if(!_activity||!t)return;
    if(!t.activityId||String(t.activityId)!==String(_activity.id))return;
    if(t.state==='start')_showTyping();else if(t.state==='end')_endTyping();
  }
  function _showTyping(){var h=H&&H.querySelector('#ci-msgs');if(!h)return;var d=h.querySelector('#ci-typing');if(!d){d=document.createElement('div');d.className='ci-typing';d.id='ci-typing';d.textContent='TA 正在输入…';h.appendChild(d)}h.scrollTop=h.scrollHeight;_armTypingTimeout()}
  /* window.__ciTypingTimeoutMs 是测试可覆写的超时接缝；默认 60s。 */
  function _armTypingTimeout(){if(_typingTimer){clearTimeout(_typingTimer);_typingTimer=null}var _to=Number(window.__ciTypingTimeoutMs)>0?Number(window.__ciTypingTimeoutMs):60000;_typingTimer=setTimeout(function(){_typingTimer=null;_endTyping()},_to)}
  /* 单例语义：无论历史遗留多少条，`end`/超时都一次清干净（防非流式路径多轮残留）。 */
  function _endTyping(){if(_typingTimer){clearTimeout(_typingTimer);_typingTimer=null}if(!H)return;var ds=H.querySelectorAll('.ci-typing');for(var i=0;i<ds.length;i++)try{ds[i].remove()}catch(e){}}
  function _appendMsg(who,text,messageId){var h=H&&H.querySelector('#ci-msgs');if(!h)return;if(messageId){for(var i=0;i<h.children.length;i++)if(h.children[i].dataset&&h.children[i].dataset.messageId===String(messageId))return}var d=document.createElement('div');d.className='ci-msg '+(who==='我'?'mine':'other');if(messageId)d.dataset.messageId=String(messageId);if(String(messageId||'').indexOf('pending:')===0)d.dataset.pendingText=String(text||'');d.innerHTML='<span>'+esc(who)+'</span> '+esc(String(text||''));h.appendChild(d);h.scrollTop=h.scrollHeight}
  async function loadActivityMessages(){
    if(!_activity||!C||!C.chat||!C.chat.recent)return;
    var h=$('#ci-msgs');if(!h)return;
    var roleId=String(_activity.roleId||'');
    if(!_activity.threadId&&C.chat.open&&_chatOpenedRole!==roleId){C.chat.open(roleId);_chatOpenedRole=roleId}
    while(h.firstChild)h.removeChild(h.firstChild);
    var rows=[];try{rows=await C.chat.recent(50)}catch(e){}
    var selected=(rows||[]).filter(function(m){if(!m||!['user','assistant'].includes(m.role))return false;if(_activity.threadId)return String(m.threadId||'')===String(_activity.threadId);return String(m.metadata&&m.metadata.activityId||m.activityId||'')===String(_activity.id)});
    selected.forEach(function(m){_appendMsg(m.role==='user'?'我':(m.senderName||'TA'),m.content||'',m.id)})
  }

  /* ---- 播放进度（来自 Adapter 事件） ---- */
  function _onTime(ev){if(!_activity||!ev)return;var sec=Number(ev.time)||0,dur=Number(ev.duration)||0;var t=H&&H.querySelector('#ci-time'),f=H&&H.querySelector('#ci-fill'),d=H&&H.querySelector('#ci-dur'),cc=H&&H.querySelector('#ci-cc');if(t)t.textContent=fmt(sec);if(d)d.textContent=fmt(dur);if(f)try{f.style.width=(dur?Math.min(100,sec/dur*100):0)+'%'}catch(e){}var cue=cueAt(sec);var ctxt=cue?strip(cue[2]):'';if(cc)cc.textContent=ctxt;if(ctxt!==_lastCue)_lastCue=ctxt;_pushProgress(sec,dur)}
  function _progressFor(sec,dur){var p=_activity&&_activity.progress||{};var rec=recentSubs(sec,S.subN);return{sec:Math.max(0,Number(sec)||0),dur:Math.max(0,Number(dur)||0),subs:rec.map(function(c){return[Math.floor(c[0]),Math.floor(c[1]||0),strip(c[2])]}),recap:String(sum.recap||p.recap||'').slice(0,800),upTo:Math.max(0,Number(sum.upTo||p.upTo)||0),pct:dur?Math.max(0,Math.min(100,Number(sec)/Number(dur)*100)):0,noTime:p.noTime===true,subtitlesAvailable:_subtitleLoaded,subtitleName:String(_subtitleName||p.subtitleName||'').slice(0,120),sourceProvider:String(_media&&_media.provider||p.sourceProvider||''),sourceKind:String(_media&&_media.provider==='local'?'local':(p.sourceKind||'')),fileFingerprint:String(_activity&&_activity.fileFingerprint||p.fileFingerprint||'')}}
  function _drainProgress(){if(_progressBusy)return _progressPromise;_progressBusy=true;_progressPromise=Promise.resolve().then(async function(){while(_pendingProgress){var item=_pendingProgress;_pendingProgress=null;var saved=await IB.activity.setProgress(item.id,item.progress);if(saved&&_activity&&_activity.id===item.id)_activity=saved}}).catch(function(e){toast('观影进度暂未保存：'+String(e&&e.message||e).slice(0,90))}).then(function(){_progressBusy=false;if(_pendingProgress)return _drainProgress();return null});return _progressPromise}
  function _persistProgress(sec,dur,force){if(!_activity||!IB.activity||typeof IB.activity.setProgress!=='function')return Promise.resolve(null);var now=Date.now();if(!force&&now-_lastPush<5000)return _progressPromise;_lastPush=now;_pendingProgress={id:_activity.id,progress:_progressFor(sec,dur)};return _drainProgress()}
  function _pushProgress(sec,dur){return _persistProgress(sec,dur,false)}

  /* ---- 加载媒体（统一入口） ---- */
  function titleFor(media){if(media.caps&&media.caps.file){return media.caps.file.name.replace(/\.[^.]+$/,'')}if(media.provider==='youtube')return 'YouTube · '+(media.id||'视频');if(media.provider==='bilibili')return 'Bilibili · '+(media.id||'视频');if(media.provider==='hls')return '直播流 · '+(media.url||'').slice(0,24);var u=media.url.split(/[?#]/)[0].split('/').pop();var name=u||'视频';return name.replace(/\.[^/.]+$/,'')||name}
  function chooseVideo(){var host=H&&H.querySelector('.ci-app')||H||document.body;if(host){var old=host.querySelectorAll('.ci-video-chooser');for(var i=0;i<old.length;i++)try{old[i].remove()}catch(e){}}var inp=document.createElement('input');inp.type='file';inp.accept='video/*';inp.className='ci-video-chooser';inp.hidden=true;if(host)host.appendChild(inp);inp.onchange=function(){if(inp.files&&inp.files[0])pickFilm(inp.files[0]);try{inp.remove()}catch(e){}};inp.click()}
  function renderRecent(rows){
    var box=$('#ci-recent');if(!box)return;while(box.firstChild)box.removeChild(box.firstChild);
    var roles=(C&&C.chat&&C.chat.list&&C.chat.list())||[],roleMap={};roles.forEach(function(r){roleMap[r.id]=r.nickname||r.model||'TA'});
    var usable=(rows||[]).filter(function(a){var p=a&&a.progress||{};return a&&a.type==='cinema'&&a.status!=='finished'&&(!_activity||String(a.id)!==String(_activity.id))&&(Number(p.sec)>1.5||p.noTime===true)}).slice(0,4);
    _resumeActivities=usable;box.hidden=!usable.length;if(!usable.length)return;
    var heading=document.createElement('div');heading.className='ci-recent-title';heading.textContent='最近观影';box.appendChild(heading);
    usable.forEach(function(a){
      var p=a.progress||{},row=document.createElement('div');row.className='ci-resume-row';
      var copy=document.createElement('div');copy.className='ci-resume-copy';var name=document.createElement('strong');name.textContent=a.title||'本地视频';
      var meta=document.createElement('span');meta.textContent=(roleMap[a.roleId]||'已绑定角色')+' · '+(p.noTime?'平台未提供播放时间':fmt(p.sec))+(p.subtitleName?' · 字幕需重选':'');copy.appendChild(name);copy.appendChild(meta);
      var btn=document.createElement('button');btn.type='button';btn.className='ci-resume-btn';btn.disabled=!roleMap[a.roleId]||p.noTime===true;btn.textContent=p.noTime?'平台无进度':(p.sourceKind==='local'?'选择文件续播':'粘贴来源续播');
      btn.setAttribute('aria-label',p.sourceKind==='local'?'重新选择《'+(a.title||'本地视频')+'》并恢复进度':'重新输入《'+(a.title||'视频')+'》的相同来源以匹配观影记录');
      btn.addEventListener('click',function(){_resumeTargetId=a.id;_aiId=a.roleId;paintAiSel();var sel=$('#ci-ai');if(sel){sel.value=_aiId;sel.disabled=false}if(p.sourceKind==='local')chooseVideo();else{var url=$('#ci-url');if(url){url.placeholder='粘贴与记录完全相同的视频链接（链接本身不会保存）';url.focus()}toast('链接不会保存；粘贴相同来源并加载后，才能匹配这条进度记录')}});
      row.appendChild(copy);row.appendChild(btn);box.appendChild(row)
    })
  }
  async function refreshRecent(){if(!IB.activity||typeof IB.activity.listActivities!=='function'){renderRecent([]);return}try{renderRecent(await IB.activity.listActivities({type:'cinema'}))}catch(e){renderRecent([])}}
  function _updateVisionState(){var btn=$('#ci-snap'),note=$('#ci-frame-note');if(!btn)return;var canFrame=!!(_media&&_media.caps&&_media.caps.canFrame),canSee=false;try{canSee=!!(C&&C.chat&&C.chat.canSee&&C.chat.canSee(_aiId))}catch(e){}btn.disabled=!canFrame||!canSee;btn.title=!canFrame?'此来源不能安全截帧':(!canSee?'当前角色不支持图像识别':'仅在你点“留影”后发送这一帧');if(note)note.textContent=!canFrame?'此来源不允许截帧；仍可根据字幕与播放时间讨论。':(!canSee?'当前角色不支持图像识别；字幕、时间与文字互动仍可用。':'仅在你主动点击“留影”后，单帧会随下一句发送；不会连续上传视频画面。')}
  function _destroyCurrent(){if(_adapter&&typeof _adapter.destroy==='function'){try{_adapter.destroy()}catch(e){}}_adapter=null;_media=null;_lastCue=''}
  function _bindAdapter(){if(!_adapter)return;_adapter.on('timeupdate',_onTime);_adapter.on('paused',function(ev){_persistProgress(ev&&ev.time||(_adapter&&_adapter.getCurrentTime&&_adapter.getCurrentTime())||0,ev&&ev.duration||(_adapter&&_adapter.getDuration&&_adapter.getDuration())||0,true)});_adapter.on('ended',function(){_persistProgress(_adapter&&_adapter.getCurrentTime&&_adapter.getCurrentTime()||0,_adapter&&_adapter.getDuration&&_adapter.getDuration()||0,true)});_adapter.on('error',function(ev){toast(String(ev&&ev.message||'播放出错'))})}
  async function _loadMedia(input){
    var cfgs=(C&&C.chat&&C.chat.list()||[]).filter(function(a){return !String(a.id).startsWith('group_')});
    if(!cfgs.length){toast('请先在 API 页添加一个 AI');return}
    if(!_aiId)_aiId=cfgs[0].id;
    var media=window.IBMedia.resolveMedia(input);
    if(media.type==='unknown'){toast('无法识别该来源：'+String(media.url||'空').slice(0,60));return}
    var title=titleFor(media),identity=CinemaCore?CinemaCore.mediaIdentity(media,title):null;
    if(!identity){toast('观影组件未就绪，请重开观影室');return}
    var previous=_activity;
    if(previous&&_adapter){await _persistProgress(_adapter.getCurrentTime?_adapter.getCurrentTime():0,_adapter.getDuration?_adapter.getDuration():0,true)}
    _destroyCurrent();
    subs=[];_subtitleLoaded=false;_subtitleName='';sum={recap:'',upTo:0};_lastPush=0;renderSubtitleStatus();
    var host=H&&H.querySelector('#ci-player');if(!host){toast('播放器未就绪');return}
    var adapter=window.IBMedia.createAdapter(media,host);
    _media=media;_adapter=adapter;_updateVisionState();_bindAdapter();
    var key=identity.resourceId;
    _activity=await IB.activity.findActivity('cinema',_aiId,key);
    if(!_activity&&identity.legacyResourceId&&identity.legacyResourceId!==key){var legacy=await IB.activity.findActivity('cinema',_aiId,identity.legacyResourceId);if(legacy){var migrate=await C.ui.confirm('找到同名旧版观影记录（'+fmt(legacy.progress&&legacy.progress.sec||0)+'）。只会迁移播放秒数与梗概，不保存视频文件或路径。是否将这份进度绑定到当前文件？');if(migrate){var oldProgress=legacy.progress||{};oldProgress.sourceKind='local';oldProgress.fileFingerprint=identity.fileFingerprint||'';_activity=await IB.activity.saveActivity(legacy.id,{resourceId:key,resourceKey:key,progress:oldProgress})}}}
    if(!_activity){_activity=await IB.activity.createActivity({type:'cinema',roleId:_aiId,resourceId:key,resourceKey:key,title:title,kind:'cinema',quiet:true,memory:true,progress:{sec:0,dur:0,subs:[],recap:'',upTo:0,noTime:(media.provider==='bilibili'),subtitlesAvailable:false,sourceProvider:media.provider,sourceKind:media.provider==='local'?'local':'remote',fileFingerprint:identity.fileFingerprint||''}})}
    if(!_activity){toast('创建观影活动失败');return}
    if(previous&&previous.id!==_activity.id&&IB.activity.saveActivity){try{await IB.activity.saveActivity(previous.id,{status:'paused'})}catch(e){}}
    if(_activity.status!=='active'&&IB.activity.saveActivity){try{_activity=await IB.activity.saveActivity(_activity.id,{status:'active'})||_activity}catch(e){}}
    sum={recap:String(_activity.progress&&_activity.progress.recap||''),upTo:Number(_activity.progress&&_activity.progress.upTo)||0};
    if(media.provider==='local'&&identity.fileFingerprint&&_activity.progress){_activity.progress.fileFingerprint=identity.fileFingerprint}
    if(_resumeTargetId){if(_activity.id!==_resumeTargetId)toast('所选文件与该观影记录不一致，已作为新记录打开；原进度未覆盖');_resumeTargetId=''}
    /* Bilibili embed 不提供播放进度：如实标记（不伪造 00:00），legacy 记录补一次 */
    if(media.provider==='bilibili'&&_activity.progress&&!(_activity.progress.noTime)){
      var _upd=await IB.activity.setProgress(_activity.id,Object.assign({},_activity.progress,{noTime:true}));
      if(_upd)_activity=_upd;
    }
    /* M1：新活动置为 current；legacy 频道活动保持旧隔离（上下文走旧频道锚） */
    if(!_activity.threadId){try{await IB.activity.setCurrent(_activity.id)}catch(e){}}
    var head=H&&H.querySelector('#ci-title');if(head)head.textContent=title;
    await adapter.load().then(async function(){
      var cap=H&&H.querySelector('#ci-snap');if(cap)cap.disabled=false;_updateVisionState();
      var e=H&&H.querySelector('#ci-empty');if(e)e.style.display='none';
      var sel=$('#ci-ai');if(sel)sel.disabled=true;
      renderRecap();refreshRecent();await loadActivityMessages();
      var duration=adapter.getDuration?adapter.getDuration():0;var resumeSec=CinemaCore.resumePoint(_activity.progress,duration,!!(media.caps&&media.caps.canSeek));
      if(resumeSec!==null){adapter.seek(resumeSec);_onTime({time:resumeSec,duration:duration});toast('已恢复到 '+fmt(resumeSec)+'；字幕需重新选择，点击播放继续')}
      else if(media.provider==='local'&&_activity.progress&&_activity.progress.sec>0)toast('已载入该视频；记录接近片尾，可从头播放或手动拖动进度')
      else toast('已载入《'+title+'》；按下播放即可开始');
      await _persistProgress(resumeSec!==null?resumeSec:(adapter.getCurrentTime?adapter.getCurrentTime():0),duration,true);
    }).catch(function(err){toast(String(err&&err.message||'播放失败'));if(_activity&&IB.activity.saveActivity)IB.activity.saveActivity(_activity.id,{status:'paused'}).catch(function(){})});
    if(previous&&previous.id===_activity.id&&_activity.progress&&_activity.progress.subtitleName)toast('字幕文件不会保存，请重新选择“'+String(_activity.progress.subtitleName).slice(0,60)+'”以恢复字幕同步');
  }
  async function pickFilm(file){await _loadMedia({file:file})}
  async function loadUrl(url){url=String(url||'').trim();if(!url){toast('请输入视频链接');return}await _loadMedia({url:url})}

  /* ---- 留影（仅本地/直链/HLS 支持截帧） ---- */
  /* 截帧防御（M1.5）：跨域直链可能因 canvas 污染抛 SecurityError —— 不抛异常、返回 null，
     由调用方按 _grabError 给出真实提示。不设 crossOrigin、不绕过任何平台限制。 */
  function grabFrame(){_grabError='';try{var v=H&&H.querySelector('#ci-player video');if(!v||!v.videoWidth)return null;var w={l:384,m:512,h:768}[S.vq]||512,q={l:0.6,m:0.72,h:0.8}[S.vq]||0.72;var c=document.createElement('canvas');c.width=w;c.height=Math.round(v.videoHeight*(w/v.videoWidth)||w*0.75);c.getContext('2d').drawImage(v,0,0,c.width,c.height);return c.toDataURL('image/jpeg',q)}catch(e){_grabError=String((e&&e.name)||'capture-failed');return null}}

  /* ---- UI ---- */
  function paint(paint){
    if(!H)return;
    if(paint){
      H.innerHTML=
        '<div class="ci-app">'
        +'<div class="ci-head"><span class="ci-head-title" id="ci-title">观影室</span><button class="ci-exit" type="button" id="ci-exit">× Exit</button></div>'
        +'<div class="ci-recent" id="ci-recent" hidden></div>'
        +'<div class="ci-workspace">'
        +'<section class="ci-screen-column">'
        +'<div class="ci-stage"><div class="ci-empty" id="ci-empty">选择本机视频，或粘贴直链 / HLS / YouTube / Bilibili 地址。字幕、时间与经你选择的一帧会进入本轮剧情上下文；视频文件不会上传。</div><div class="ci-player" id="ci-player"></div><div class="ci-dm" id="ci-dm-l"></div><div class="ci-cc" id="ci-cc"></div></div>'
        +'<div class="ci-prog"><span id="ci-time">00:00</span><div class="ci-bar"><div class="ci-fill" id="ci-fill"></div></div><span id="ci-dur">00:00</span></div>'
        +'<div class="ci-sub-status" id="ci-sub-status" aria-live="polite">没有加载字幕。仍可按播放时间、你的描述与经你选择的留影讨论；角色不会编造台词。</div>'
        +'<section class="ci-recap" id="ci-recap" hidden><div class="ci-recap-head"><div><span class="ci-kicker">STORY THREAD</span><strong>前情梗概</strong></div><button class="ci-btn" id="ci-recap-btn" type="button">整理下一段</button></div><p id="ci-recap-text"></p><small id="ci-recap-progress"></small><div class="ci-frame-note" id="ci-frame-note"></div></section>'
        +'</section>'
        +'<section class="ci-chat"><div class="ci-chat-head"><span class="ci-kicker">TOGETHER</span><span>回应你想聊的剧情，不复读字幕</span></div><div class="ci-msgs" id="ci-msgs" aria-live="polite"></div><div class="ci-input"><textarea id="ci-input" placeholder="和 TA 聊聊这段视频…"></textarea><button id="ci-send" type="button">发送</button></div></section>'
        +'</div>'
        +'<div class="ci-tools">'
        +'<div class="ci-urlbar"><input id="ci-url" placeholder="粘贴视频链接（.mp4 / .m3u8 / YouTube / Bilibili）" class="ci-url-input"><button class="ci-btn primary" type="button" id="ci-url-btn">加载</button></div>'
        +'<button class="ci-pick primary" type="button" id="ci-pick">选择视频</button>'
        +'<button class="ci-pick" type="button" id="ci-sub-btn">字幕</button><input type="file" id="ci-sub" accept=".srt,.vtt" hidden>'
        +'<label class="ci-ai-label" for="ci-ai">陪看角色</label><select id="ci-ai" class="ci-ai" aria-label="陪看角色"></select>'
        +'<button class="ci-btn" type="button" id="ci-snap" disabled>留影</button><button class="ci-btn" type="button" id="ci-dm">弹幕</button>'
        +'<button class="ci-btn" type="button" id="ci-fs">全屏</button><button class="ci-btn" type="button" id="ci-mem">存记忆</button>'
        +'<button class="ci-btn" type="button" id="ci-nudge">提醒</button><button class="ci-btn" type="button" id="ci-open-chat">去聊天</button>'
        +'</div>'
        +'</div>';
      var exit=H.querySelector('#ci-exit');if(exit)exit.onclick=function(){if(C&&C.ui&&C.ui.close)C.ui.close()};
      var urli=H.querySelector('#ci-url');var urlbtn=H.querySelector('#ci-url-btn');if(urlbtn)urlbtn.onclick=function(){if(urli)loadUrl(urli.value)};
      if(urli)urli.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();loadUrl(urli.value)}});
      var ipk=H.querySelector('#ci-pick');if(ipk)ipk.onclick=chooseVideo;
      var isubBtn=H.querySelector('#ci-sub-btn');if(isubBtn)isubBtn.onclick=function(){var isub=H.querySelector('#ci-sub');if(isub)isub.click()};
      var isub=H.querySelector('#ci-sub');if(isub)isub.onchange=function(){if(isub.files&&isub.files[0])loadSub(isub.files[0])};
      var ai=H.querySelector('#ci-ai');if(ai)ai.onchange=function(){if(_media){ai.value=_aiId;toast('当前片段已绑定 '+(C.chat.list().find(function(r){return r.id===_aiId})||{}).nickname+'；请离开后重新选择角色')}else{_aiId=ai.value;_updateVisionState()}};
      var recapBtn=H.querySelector('#ci-recap-btn');if(recapBtn)recapBtn.onclick=updateRecap;
      var snap=H.querySelector('#ci-snap');if(snap)snap.onclick=function(){
        if(snap.disabled){toast(!(_media&&_media.caps&&_media.caps.canFrame)?'当前来源不能安全截帧':'当前角色不支持图像识别；仍可按字幕和你的描述讨论');return}
        var canSee=true;try{if(C&&C.chat&&typeof C.chat.canSee==='function')canSee=!!C.chat.canSee(_aiId)}catch(e){}
        if(!canSee){toast('这位 TA 的模型不识图，留影发不出画面');return}
        var u=grabFrame();if(u){toast('已选择当前一帧；仅会随你的下一条消息发送，不会连续取帧');snap.dataset.frame=u}else toast(_grabError?'当前视频源无法截取画面，请发送截图后继续讨论':'当前来源不支持截帧')
      };
      var dm=H.querySelector('#ci-dm');if(dm)dm.onclick=function(){S.dm=!S.dm;dm.textContent=S.dm?'弹幕✓':'弹幕'};
      var fs=H.querySelector('#ci-fs');if(fs)fs.onclick=function(){var v=H.querySelector('#ci-player video');var p=v?v:H.querySelector('#ci-player iframe');if(p){if(document.fullscreenElement)document.exitFullscreen();else if(p.requestFullscreen)p.requestFullscreen()}else toast('暂不支持全屏')};
      var mem=H.querySelector('#ci-mem');if(mem)mem.onclick=function(){(async function(){if(!_activity){toast('先开始观看');return}await IB.activity.writeMemory(_activity,'观影 · '+(_activity?(_activity.title||''):''),(_lastCue||sum.recap||'').slice(0,400));toast('已把这段共同观影写进记忆')})()};
      var nud=H.querySelector('#ci-nudge');if(nud)nud.onclick=function(){(async function(){if(!_activity){toast('先开始观看');return}await IB.activity.nudge({activityId:_activity.id});toast('已安排 TA 稍后提醒你继续')})()};
      var oc=H.querySelector('#ci-open-chat');if(oc)oc.onclick=function(){if(_activity)IB.activity.openChat(_activity.id)};
      var send=H.querySelector('#ci-send');if(send)send.onclick=sendMsg;
      var inpt=H.querySelector('#ci-input');if(inpt)inpt.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg()}});
      paintAiSel();renderSubtitleStatus();renderRecap();refreshRecent();_updateVisionState();
    }
  }
  function paintAiSel(){var sel=H&&H.querySelector('#ci-ai');if(!sel)return;var list=(C&&C.chat&&C.chat.list()||[]).filter(function(a){return !String(a.id).startsWith('group_')});sel.innerHTML=list.map(function(a){return '<option value="'+esc(a.id)+'">'+esc(a.nickname)+'</option>'}).join('');if(!_aiId&&list.length)_aiId=list[0].id;sel.value=_aiId||''}

  function renderRecap(){var box=$('#ci-recap'),text=$('#ci-recap-text'),meta=$('#ci-recap-progress'),btn=$('#ci-recap-btn');if(!box)return;var p=_activity&&_activity.progress||{};var recap=String(sum.recap||p.recap||'');if(!_activity){box.hidden=true;return}box.hidden=false;if(text)text.textContent=recap||(_subtitleLoaded?'尚未整理前情。点击“整理下一段”后，TA 会按需将最多 15 分钟字幕压成梗概。':'无字幕时仍可聊当前进度与用户描述；前情梗概需要先加载字幕。');if(meta)meta.textContent=recap?'梗概覆盖至 '+fmt(sum.upTo||p.upTo||0)+' · 梗概保存在本部观影进度；字幕整理请求与回复保留在角色聊天记录中':'字幕不会自动发送；整理前情由你手动触发，字幕片段和回复会保留在角色聊天记录中。';if(btn){btn.disabled=!_subtitleLoaded||!subs.length||_summaryBusy;btn.textContent=_summaryBusy?'正在整理…':'整理下一段'}renderSubtitleStatus()}

  async function updateRecap(){
    if(!_activity||!_subtitleLoaded||!subs.length){toast('先加载可识别的 SRT/VTT 字幕，再整理前情');return}
    if(_summaryBusy)return;
    var sec=_adapter&&_adapter.getCurrentTime?_adapter.getCurrentTime():0,dur=_adapter&&_adapter.getDuration?_adapter.getDuration():0;
    var from=Math.max(0,Number(sum.upTo||(_activity.progress&&_activity.progress.upTo))||0);
    if(sec<=from+1){toast('继续播放到新字幕后再整理下一段');return}
    var segment=CinemaCore.recapSegment(subs,from,sec,900,6000);
    if(!segment.lines.length){toast('这段播放区间没有可整理的字幕');return}
    var mins=Math.max(1,Math.ceil((segment.toSec-segment.fromSec)/60));
    var ok=await C.ui.confirm('这会把 '+mins+' 分钟内的新字幕和已有梗概发给当前陪看角色所用 Provider 一次；整理请求与回复会保留在当前角色聊天记录，梗概保存在观影进度，不会自动写入长期记忆。继续吗？');
    if(!ok)return;
    var prompt=CinemaCore.buildRecapPrompt({title:_activity.title,previousRecap:sum.recap,segment:segment});
    var activityId=_activity.id,startedAt=Date.now()-1000,button=$('#ci-recap-btn');_summaryBusy=true;if(button)button.disabled=true;renderRecap();
    try{
      var result=await IB.activity.send(activityId,prompt,{progress:_progressFor(sec,dur)});
      if(!result||result.ok!==true){_endTyping();await loadActivityMessages();toast('前情整理请求没有完成；现有梗概已保留');return}
      await loadActivityMessages();_endTyping();
      var messages=[];try{messages=await C.chat.recent(50)}catch(e){}
      var candidates=(messages||[]).filter(function(m){return m&&m.role==='assistant'&&m.metadata&&String(m.metadata.activityId||'')===String(activityId)&&Number(m.timestamp||m.ts||0)>=startedAt});
      if(!candidates.length){await new Promise(function(resolve){setTimeout(resolve,180)});try{messages=await C.chat.recent(50)}catch(e){}candidates=(messages||[]).filter(function(m){return m&&m.role==='assistant'&&m.metadata&&String(m.metadata.activityId||'')===String(activityId)})}
      candidates.sort(function(a,b){return Number(b.timestamp||b.ts||0)-Number(a.timestamp||a.ts||0)});
      var answer=candidates[0]&&CinemaCore.visibleText(candidates[0].content||'');
      if(!answer){toast('未收到可保存的梗概回复；现有进度与字幕仍保留');return}
      var saveRecap=await C.ui.confirm('梗概候选（仅保存到本部影片的观影进度，不写入长期记忆）：\n\n'+answer.slice(0,700)+'\n\n确认保存？');if(!saveRecap){toast('已取消保存；原梗概保持不变');return}
      var progress=_progressFor(sec,dur);progress.recap=answer.slice(0,800);progress.upTo=segment.toSec;
      var saved=await IB.activity.setProgress(activityId,progress);if(saved){_activity=saved;sum={recap:progress.recap,upTo:progress.upTo};toast('前情梗概已更新到 '+fmt(segment.toSec))}else toast('梗概已生成，但观影进度保存失败')
    }catch(e){toast('前情整理失败；原梗概没有覆盖')}
    finally{_summaryBusy=false;renderRecap()}
  }

  async function sendMsg(){
    var inp=H&&H.querySelector('#ci-input');if(!inp||!_activity)return;
    var text=inp.value.trim();if(!text)return;inp.value=''
    var snapH=H&&H.querySelector('#ci-snap'),frame=(snapH&&snapH.dataset&&snapH.dataset.frame)||'';
    var cur=_adapter&&_adapter.getCurrentTime?_adapter.getCurrentTime():0;
    var opts={progress:_progressFor(cur,_adapter&&_adapter.getDuration?_adapter.getDuration():0)};
    if(frame){opts.visionReference={dataUrl:frame};delete snapH.dataset.frame}
    _appendMsg('我',text,'pending:'+Date.now()+':'+Math.floor(Math.random()*100000));danmaku(text);
    try{
      var sent=await IB.activity.send(_activity.id,text,opts);
      _endTyping();await loadActivityMessages();
      if(!sent||sent.ok!==true)toast('消息没有发出；请重试')
    }catch(e){_endTyping();await loadActivityMessages();toast('消息发送失败；请重试')}
  }
  function start(){paint(true)}

  IBApps.register({
    id:'cinema',name:'观影室',version:'1.1.0',sdk:2,wall:true,headless:true,
    icon:'<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 9.5h17M7.5 6v12M16.5 6v12"/><path d="M10.8 11v4l3.4-2z"/>',
    mount:async function(h,ctx){H=h;C=ctx;_aiId=(C.chat&&C.chat.current&&C.chat.current()&&C.chat.current().id)||'';await ensureMedia();start();
      if(C&&C.on){C.on('message',onMsg);C.on('turn',onTurn)}},
    back:function(){},
    unmount:function(){
      if(_typingTimer){clearTimeout(_typingTimer);_typingTimer=null}
      try{if(C&&C.off){C.off('message',onMsg);C.off('turn',onTurn)}}catch(e){}
      var leaving=_activity,id=leaving&&leaving.id,roleId=leaving&&leaving.roleId;
      if(leaving&&_adapter){var finalSec=_adapter.getCurrentTime?_adapter.getCurrentTime():Number(leaving.progress&&leaving.progress.sec)||0;var finalDur=_adapter.getDuration?_adapter.getDuration():Number(leaving.progress&&leaving.progress.dur)||0;var write=_persistProgress(finalSec,finalDur,true);write.then(function(){if(IB.activity&&IB.activity.saveActivity)return IB.activity.saveActivity(id,{status:'paused'})}).catch(function(){})}
      /* 离开播放器后暂停 Activity，避免普通 Chat 继续自动继承观影上下文；重选同一视频时再恢复。 */
      try{if(leaving&&roleId&&IB.activity&&typeof IB.activity.clearCurrent==='function')IB.activity.clearCurrent(roleId,id)}catch(e){}
      _destroyCurrent();subs=[];_subtitleLoaded=false;_subtitleName='';_activity=null;_media=null;_resumeActivities=[];_resumeTargetId='';_chatOpenedRole='';H=null;C=null
    }
  });
})();
