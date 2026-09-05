/* ====================================================================
   观影室（Cinema）— 桌面 APP
   --------------------------------------------------------------------
   支持多视频来源（Media Adapter v1）：本地 / 直链 .mp4/.webm / HLS .m3u8 /
   YouTube 官方 embed / Bilibili 官方 embed；未知来源 graceful fallback。
   - 只经 ctx 与主程序对话（sdk 2）；不直接触碰底层 db/发送函数。
   - 会话/进度/Memory/Proactive 经 IB.activity 统一运行时；
     · 视频与字幕文件一律不入库、不随备份（播放点只存秒数与梗概）。
     · 上下文经 ctx 注入：只透露到播放点为止的字幕 + 进度 + 梗概。
   - Adapter 由 MB(IBMedia) 提供：load/play/pause/seek/getCurrentTime/getDuration/destroy。
   禁止：DRM 绕过 / 防盗链破解 / Cookie·Token 偷取 / 下载受保护视频 / 代理绕过平台限制。
   ==================================================================== */
(function(){
  'use strict';
  if(!window.IBApps||!window.IBActivity)return;
  var H,C;var S={dm:true,subN:6,vq:'m',sumEvery:15,nudge:2,lastAi:''};
  var subs=[],sum={recap:''},_activity=null,_aiId='',_timer=null,_lastCue='';
  var _media=null,_adapter=null,_lastPush=0;
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
  function loadSub(file){if(!file)return;file.arrayBuffer().then(function(buf){try{subs=parseSubs(decode(buf));toast('已加载字幕 '+subs.length+' 条');_lastCue=''}catch(e){toast('字幕解析失败')}}).catch(function(){toast('读字幕失败')})}
  function recentSubs(sec,n){var r=[];for(var c of subs){if(c[0]<=sec)r.push(c);else break}return r.slice(-(n||S.subN))}
  function cueAt(sec){for(var c of subs){if(sec>=c[0]&&sec<=c[1])return c}return null}

  /* ---- 弹幕 / 共看面板 ---- */
  function strip(t){return String(t||'').replace(/<[^>]+>/g,'')}
  function danmaku(t){if(!S.dm||!t)return;var lay=H&&H.querySelector('#ci-dm-l');if(!lay)return;var b=document.createElement('div');b.className='ci-dmi';b.textContent=t;lay.appendChild(b);var dur=Math.min(8,Math.max(5,t.length*0.18));b.style.animationDuration=dur+'s';setTimeout(function(){try{b.remove()}catch(e){}},dur*1000+50);setTimeout(function(){if(lay.childElementCount>40)try{lay.removeChild(lay.firstChild)}catch(e){}},dur*1000+60)}
  function _sameChannel(am){if(!_activity)return false;if(am&&am.threadId&&_activity.threadId&&am.threadId!==_activity.threadId)return false;if(am&&am.friendId&&_activity.roleId&&String(am.friendId)!==String(_activity.roleId))return false;return true}
  function onMsg(am){if(!_sameChannel(am))return;var who=(am&&am.role==='user')?'我':((am&&am.senderName)||'TA');var text=String(am&&am.content||'');_endTyping();danmaku(strip(text));if((am&&am.role)==='user')_appendMsg('我',text);else _appendMsg(who,text)}
  function onTurn(t){if(t&&t.state==='start')_showTyping();else if(t&&t.state==='end')_endTyping()}
  function _showTyping(){var h=H&&H.querySelector('#ci-msgs');if(!h)return;var d=document.createElement('div');d.className='ci-typing';d.id='ci-typing';d.textContent='TA 正在输入…';h.appendChild(d);h.scrollTop=h.scrollHeight}
  function _endTyping(){var d=H&&(H.querySelector('#ci-typing'));if(d)try{d.remove()}catch(e){}}
  function _appendMsg(who,text){var h=H&&H.querySelector('#ci-msgs');if(!h)return;var d=document.createElement('div');d.className='ci-msg';d.innerHTML='<span>'+esc(who)+'</span> '+esc(String(text||''));h.appendChild(d);h.scrollTop=h.scrollHeight}

  /* ---- 播放进度（来自 Adapter 事件） ---- */
  function _onTime(ev){if(!_activity||!ev)return;var sec=ev.time||0,dur=ev.duration||0;var t=H&&H.querySelector('#ci-time'),f=H&&H.querySelector('#ci-fill'),d=H&&H.querySelector('#ci-dur'),cc=H&&H.querySelector('#ci-cc');if(t)t.textContent=fmt(sec);if(d)d.textContent=fmt(dur);if(f)try{f.style.width=((dur?(sec/dur*100):0)+'%')}catch(e){}var cue=cueAt(sec);var ctxt=cue?strip(cue[2]):'';if(cc)cc.textContent=ctxt;if(ctxt!==_lastCue)_lastCue=ctxt;_pushProgress(sec,dur)}
  function _pushProgress(sec,dur){if(!_activity)return;var now=Date.now();if(now-_lastPush<1500)return;_lastPush=now;var rec=recentSubs(sec,S.subN);IB.activity.setProgress(_activity.id,{sec:sec,dur:dur||0,subs:rec.map(function(c){return[Math.floor(c[0]),0,strip(c[2])]}),recap:sum.recap||'',upTo:0,pct:0})}

  /* ---- 加载媒体（统一入口） ---- */
  function titleFor(media){if(media.caps&&media.caps.file){return media.caps.file.name.replace(/\.[^.]+$/,'')}if(media.provider==='youtube')return 'YouTube · '+(media.id||'视频');if(media.provider==='bilibili')return 'Bilibili · '+(media.id||'视频');if(media.provider==='hls')return '直播流 · '+(media.url||'').slice(0,24);var u=media.url.split(/[?#]/)[0].split('/').pop();return u||'视频'}
  function _destroyCurrent(){if(_adapter&&typeof _adapter.destroy==='function'){try{_adapter.destroy()}catch(e){}}_adapter=null;_media=null;_lastCue=''}
  function _bindAdapter(){if(!_adapter)return;_adapter.on('timeupdate',_onTime);_adapter.on('ended',function(){});_adapter.on('error',function(ev){toast(String(ev&&ev.message||'播放出错'))})}
  async function _loadMedia(input){
    var cfgs=(C&&C.chat&&C.chat.list()||[]).filter(function(a){return !String(a.id).startsWith('group_')});
    if(!cfgs.length){toast('请先在 API 页添加一个 AI');return}
    if(!_aiId)_aiId=cfgs[0].id;
    var media=window.IBMedia.resolveMedia(input);
    if(media.type==='unknown'){toast('无法识别该来源：'+String(media.url||'空').slice(0,60));return}
    _destroyCurrent();
    var host=H&&H.querySelector('#ci-player');if(!host){toast('播放器未就绪');return}
    var adapter=window.IBMedia.createAdapter(media,host);
    _media=media;_adapter=adapter;_bindAdapter();
    var title=titleFor(media);
    var key='cin_'+hashStr(title+'|'+media.url+'|'+(media.id||''));
    _activity=await IB.activity.findActivity('cinema',_aiId,key);
    if(!_activity){_activity=await IB.activity.createActivity({type:'cinema',roleId:_aiId,resourceId:key,resourceKey:key,title:title,kind:'cinema',name:'观影室 · '+title.slice(0,24),quiet:true,memory:true,progress:{sec:0,dur:0,subs:[],recap:''}})}
    if(!_activity){toast('创建观影活动失败');return}
    var head=H&&H.querySelector('#ci-title');if(head)head.textContent=title;
    await adapter.load().then(function(){var cap=H&&H.querySelector('#ci-snap');if(cap)cap.disabled=!media.caps.canFrame;var e=H&&H.querySelector('#ci-empty');if(e)e.style.display='none';toast('开始一起看《'+title+'》')}).catch(function(err){toast(String(err&&err.message||'播放失败'))});
  }
  async function pickFilm(file){await _loadMedia({file:file})}
  async function loadUrl(url){url=String(url||'').trim();if(!url){toast('请输入视频链接');return}await _loadMedia({url:url})}

  /* ---- 留影（仅本地/直链/HLS 支持截帧） ---- */
  function grabFrame(){var v=H&&H.querySelector('#ci-player video');if(!v||!v.videoWidth)return null;var w={l:384,m:512,h:768}[S.vq]||512,q={l:0.6,m:0.72,h:0.8}[S.vq]||0.72;var c=document.createElement('canvas');c.width=w;c.height=Math.round(v.videoHeight*(w/v.videoWidth)||w*0.75);c.getContext('2d').drawImage(v,0,0,c.width,c.height);return c.toDataURL('image/jpeg',q)}

  /* ---- UI ---- */
  function paint(paint){
    if(!H)return;
    if(paint){
      H.innerHTML=
        '<div class="ci-app">'
        +'<div class="ci-head"><span class="ci-head-title" id="ci-title">观影室</span><button class="ci-exit" type="button" id="ci-exit">× Exit</button></div>'
        +'<div class="ci-stage"><div class="ci-empty" id="ci-empty">选择下方「选择视频 / 粘贴链接」，或在 URL 框粘贴直链 / HLS / YouTube / Bilibili 链接即可一起看。</div><div class="ci-player" id="ci-player"></div><div class="ci-dm" id="ci-dm-l"></div><div class="ci-cc" id="ci-cc"></div></div>'
        +'<div class="ci-prog"><span id="ci-time">00:00</span><div class="ci-bar"><div class="ci-fill" id="ci-fill"></div></div><span id="ci-dur">00:00</span></div>'
        +'<div class="ci-chat"><div class="ci-msgs" id="ci-msgs"></div><div class="ci-input"><textarea id="ci-input" placeholder="和 TA 聊此刻的画面…"></textarea><button id="ci-send" type="button">发送</button></div></div>'
        +'<div class="ci-tools">'
        +'<div class="ci-urlbar"><input id="ci-url" placeholder="粘贴视频链接（.mp4 / .m3u8 / YouTube / Bilibili）" class="ci-url-input"><button class="ci-btn primary" type="button" id="ci-url-btn">加载</button></div>'
        +'<button class="ci-pick primary" type="button" id="ci-pick">选择视频</button>'
        +'<button class="ci-pick" type="button" id="ci-sub-btn">字幕</button><input type="file" id="ci-sub" accept=".srt,.vtt" hidden>'
        +'<select id="ci-ai" class="ci-ai"></select>'
        +'<button class="ci-btn" type="button" id="ci-snap">留影</button><button class="ci-btn" type="button" id="ci-dm">弹幕</button>'
        +'<button class="ci-btn" type="button" id="ci-fs">全屏</button><button class="ci-btn" type="button" id="ci-mem">存记忆</button>'
        +'<button class="ci-btn" type="button" id="ci-nudge">提醒</button><button class="ci-btn" type="button" id="ci-open-chat">去聊天</button>'
        +'</div>'
        +'</div>';
      var exit=H.querySelector('#ci-exit');if(exit)exit.onclick=function(){if(C&&C.ui&&C.ui.close)C.ui.close()};
      var urli=H.querySelector('#ci-url');var urlbtn=H.querySelector('#ci-url-btn');if(urlbtn)urlbtn.onclick=function(){if(urli)loadUrl(urli.value)};
      if(urli)urli.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();loadUrl(urli.value)}});
      var ipk=H.querySelector('#ci-pick');if(ipk)ipk.onclick=function(){var inp=document.createElement('input');inp.type='file';inp.accept='video/*';inp.onchange=function(){if(inp.files&&inp.files[0])pickFilm(inp.files[0])};inp.click()};
      var isubBtn=H.querySelector('#ci-sub-btn');if(isubBtn)isubBtn.onclick=function(){var isub=H.querySelector('#ci-sub');if(isub)isub.click()};
      var isub=H.querySelector('#ci-sub');if(isub)isub.onchange=function(){if(isub.files&&isub.files[0])loadSub(isub.files[0])};
      var snap=H.querySelector('#ci-snap');if(snap)snap.onclick=function(){var u=grabFrame();if(u){toast('已留影随下一句发出');snap.dataset.frame=u}else toast('当前来源不支持截帧')};
      var dm=H.querySelector('#ci-dm');if(dm)dm.onclick=function(){S.dm=!S.dm;dm.textContent=S.dm?'弹幕✓':'弹幕'};
      var fs=H.querySelector('#ci-fs');if(fs)fs.onclick=function(){var v=H.querySelector('#ci-player video');var p=v?v:H.querySelector('#ci-player iframe');if(p){if(document.fullscreenElement)document.exitFullscreen();else if(p.requestFullscreen)p.requestFullscreen()}else toast('暂不支持全屏')};
      var mem=H.querySelector('#ci-mem');if(mem)mem.onclick=function(){(async function(){if(!_activity){toast('先开始观看');return}await IB.activity.writeMemory(_activity,'观影 · '+(_activity?(_activity.title||''):''),(_lastCue||sum.recap||'').slice(0,400));toast('已把这段共同观影写进记忆')})()};
      var nud=H.querySelector('#ci-nudge');if(nud)nud.onclick=function(){(async function(){if(!_activity){toast('先开始观看');return}await IB.activity.nudge({activityId:_activity.id});toast('已安排 TA 稍后提醒你继续')})()};
      var oc=H.querySelector('#ci-open-chat');if(oc)oc.onclick=function(){if(_activity)IB.activity.openChat(_activity.id)};
      var send=H.querySelector('#ci-send');if(send)send.onclick=sendMsg;
      var inpt=H.querySelector('#ci-input');if(inpt)inpt.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg()}});
      paintAiSel();
    }
  }
  function paintAiSel(){var sel=H&&H.querySelector('#ci-ai');if(!sel)return;var list=(C&&C.chat&&C.chat.list()||[]).filter(function(a){return !String(a.id).startsWith('group_')});sel.innerHTML=list.map(function(a){return '<option value="'+esc(a.id)+'">'+esc(a.nickname)+'</option>'}).join('');if(!_aiId&&list.length)_aiId=list[0].id;sel.value=_aiId||''}

  async function sendMsg(){var inp=H&&H.querySelector('#ci-input');if(!inp||!_activity)return;var text=inp.value.trim();if(!text)return;inp.value='';var snapH=H&&H.querySelector('#ci-snap');var frame=(snapH&&snapH.dataset&&snapH.dataset.frame)||'';if(frame){_appendMsg('我','[画面] '+text);danmaku(text);delete snapH.dataset.frame}else{_appendMsg('我',text);danmaku(text)}var cur=_adapter&&_adapter.getCurrentTime?_adapter.getCurrentTime():0;await IB.activity.send(_activity.id,text);setTimeout(function(){if(frame){_appendMsg('我','[留影 '+fmt(cur)+']')}},50)}

  var _lastNudge=0;
  function tick(){if(_activity&&S.nudge&&Date.now()-_activity.lastActiveAt>120000&&Date.now()-_lastNudge>8*60*1000){_lastNudge=Date.now();IB.activity.nudge({activityId:_activity.id})}}
  function start(){paint(true)}

  IBApps.register({
    id:'cinema',name:'观影室',version:'1.1.0',sdk:2,wall:true,headless:true,
    icon:'<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 9.5h17M7.5 6v12M16.5 6v12"/><path d="M10.8 11v4l3.4-2z"/>',
    mount:async function(h,ctx){H=h;C=ctx;_aiId=(C.chat&&C.chat.current&&C.chat.current()&&C.chat.current().id)||'';await ensureMedia();start();
      if(C&&C.on){C.on('message',onMsg);C.on('turn',onTurn)}if(_timer)clearInterval(_timer);_timer=setInterval(tick,15000)},
    back:function(){},
    unmount:function(){if(_timer)clearInterval(_timer);_timer=null;try{if(C&&C.off){C.off('message',onMsg);C.off('turn',onTurn)}}catch(e){}_destroyCurrent();subs=[];H=null;C=null}
  });
})();
