/* ====================================================================
   IB Media Adapter v1 — 观影室多视频来源统一适配器
   --------------------------------------------------------------------
   - resolveMedia(input) → { type, provider, id, url, capabilities }
       type: 'video' | 'hls' | 'remote' | 'unknown'
       provider: 'local' | 'direct' | 'hls' | 'youtube' | 'bilibili' | 'unknown'
       capabilities: { canFrame, canSeek, remote }
   - createAdapter(media, hostEl, opts) → { load, play, pause, seek,
       getCurrentTime, getDuration, on, destroy }
   禁止/不实现：DRM 绕过、防盗链破解、Cookie/Token 偷取、下载受保护视频、代理绕过平台限制。
   平台受限（地区/X-Frame-Options/登录/浏览器）时只做识别并 graceful fallback，不强行播放。
   ==================================================================== */
(function(root){
  'use strict';

  /* ---- URL 识别 ---- */
  function isYouTube(u){return /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|live\/)|youtu\.be\/)/i.test(u)}
  function ytId(u){var m=String(u).match(/[?&]v=([\w-]{6,})/)||String(u).match(/youtu\.be\/([\w-]{6,})/)||String(u).match(/embed\/([\w-]{6,})/)||String(u).match(/shorts\/([\w-]{6,})/);return m?m[1]:''}
  function isBilibili(u){return /(?:bilibili\.com|b23\.tv)/i.test(u)}
  function biliId(u){var m=String(u).match(/\/video\/(BV[\w]+)/)||String(u).match(/bvid=(BV[\w]+)/);return m?m[1]:''}
  function isHls(u){return /\.m3u8(\?|#|$)/i.test(u)}
  function isDirectVideo(u){return /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(u)||/^(blob:|data:)/i.test(u)}

  function resolveMedia(input){
    var url=typeof input==='string'?input:((input&&(input.url||input.src))||'');
    var file=(input&&input.file)?input.file:null;
    if(file){return {type:'video',provider:'local',id:file.name||'',url:'',caps:{canFrame:true,canSeek:true,remote:false,file:file}}}
    if(!url){return {type:'unknown',provider:'unknown',id:'',url:'',caps:{canFrame:false,canSeek:false,remote:false}}}
    if(isYouTube(url)){return {type:'remote',provider:'youtube',id:ytId(url)||url,url:url,caps:{canFrame:false,canSeek:true,remote:true}}}
    if(isBilibili(url)){return {type:'remote',provider:'bilibili',id:biliId(url)||url,url:url,caps:{canFrame:false,canSeek:true,remote:true}}}
    if(isHls(url)){return {type:'hls',provider:'hls',id:url,url:url,caps:{canFrame:true,canSeek:true,remote:false}}}
    if(isDirectVideo(url)){return {type:'video',provider:'direct',id:url,url:url,caps:{canFrame:true,canSeek:true,remote:false}}}
    return {type:'unknown',provider:'unknown',id:url,url:url,caps:{canFrame:false,canSeek:false,remote:false}}
  }

  /* ---- 事件总线基类 ---- */
  function Emitter(){this._evt={}}
  Emitter.prototype.on=function(ev,fn){(this._evt[ev]=this._evt[ev]||[]);(this._evt[ev]).push(fn)};
  Emitter.prototype._emit=function(ev,p){var a=this._evt[ev];if(a)for(var i=0;i<a.length;i++){try{a[i](p)}catch(e){}}};
  Emitter.prototype._clear=function(){this._evt={}};

  /* ---- NativeVideoAdapter（本地文件 / 直链 .mp4 / .webm / blob:） ---- */
  function NativeVideoAdapter(media,host){this._evt={};this.media=media;this.host=host;this.video=null;this._objUrl=null;this._ls=[]}
  NativeVideoAdapter.prototype=Object.create(Emitter.prototype);
  NativeVideoAdapter.prototype.load=function(){var self=this;return new Promise(function(res,rej){
    var v=document.createElement('video');v.controls=true;v.playsInline=true;v.className='ci-el';self.video=v;
    var src;
    if(self.media.provider==='local'&&self.media.caps&&self.media.caps.file){self._objUrl=URL.createObjectURL(self.media.caps.file);src=self._objUrl}
    else{src=self.media.url}
    if(!src){self.host.innerHTML='<div class="ci-no-source">无法解析该来源。</div>';rej(new Error('no source'));return}
    self.host.innerHTML='';self.host.appendChild(v);
    function onLoaded(){self._emit('loadedmetadata',{duration:v.duration||0});res()}
    function onTime(){self._emit('timeupdate',{time:v.currentTime||0,duration:v.duration||0})}
    function onEnd(){self._emit('ended',{})}
    v.addEventListener('loadedmetadata',onLoaded);v.addEventListener('timeupdate',onTime);v.addEventListener('ended',onEnd);
    self._ls=[['loadedmetadata',onLoaded],['timeupdate',onTime],['ended',onEnd]];
    v.src=src;v.load();
    // 用户必须触发播放：挂 play 兜底（部分浏览器自动播放被拦）
    v.addEventListener('error',function(){self._emit('error',{message:'视频加载失败'})});
  })};
  NativeVideoAdapter.prototype.play=function(){try{this.video&&this.video.play().catch(function(){})}catch(e){}};
  NativeVideoAdapter.prototype.pause=function(){try{this.video&&this.video.pause()}catch(e){}};
  NativeVideoAdapter.prototype.seek=function(s){try{if(this.video)this.video.currentTime=s}catch(e){}};
  NativeVideoAdapter.prototype.getCurrentTime=function(){return this.video?(this.video.currentTime||0):0};
  NativeVideoAdapter.prototype.getDuration=function(){return this.video?(this.video.duration||0):0};
  NativeVideoAdapter.prototype.destroy=function(){var self=this;if(self._ls){for(var i=0;i<self._ls.length;i++){var l=self._ls[i];try{if(self.video)self.video.removeEventListener(l[0],l[1])}catch(e){}}}self._ls=[];if(self._objUrl){try{URL.revokeObjectURL(self._objUrl)}catch(e){};self._objUrl=null}try{if(self.video){self.video.pause();self.video.src='';}}catch(e){};try{if(self.video&&self.video.parentNode)self.video.parentNode.removeChild(self.video)}catch(e){};self.video=null;self._clear()};

  /* ---- HLSAdapter（.m3u8） ---- */
  function HLSAdapter(media,host){this._evt={};this.media=media;this.host=host;this.video=null;this.hls=null;this._ls=[]}
  HLSAdapter.prototype=Object.create(Emitter.prototype);
  HLSAdapter.prototype.load=function(){var self=this;return new Promise(function(res,rej){
    var v=document.createElement('video');v.controls=true;v.playsInline=true;v.className='ci-el';self.video=v;
    self.host.innerHTML='';self.host.appendChild(v);
    function onTime(){self._emit('timeupdate',{time:v.currentTime||0,duration:v.duration||0})}
    function onEnd(){self._emit('ended',{})}
    v.addEventListener('timeupdate',onTime);v.addEventListener('ended',onEnd);
    self._ls=[['timeupdate',onTime],['ended',onEnd]];
    if(typeof window.Hls!=='undefined'&&window.Hls.isSupported()){
      var hls=new window.Hls();self.hls=hls;hls.loadSource(self.media.url);hls.attachMedia(v);
      hls.on(window.Hls.Events.MANIFEST_PARSED,function(){self._emit('loadedmetadata',{duration:v.duration||0});res()});
      hls.on(window.Hls.Events.ERROR,function(e,fatal){if(fatal){self._emit('error',{message:'HLS 播放失败'})}});
      return;
    }
    if(v.canPlayType('application/vnd.apple.mpegurl')){
      v.src=self.media.url;
      v.addEventListener('loadedmetadata',function(){self._emit('loadedmetadata',{duration:v.duration||0});res()});
      return;
    }
    self.host.innerHTML='<div class="ci-no-source">当前浏览器不支持直接播放 HLS(.m3u8)。请使用 Safari，或加载 hls.js 后重试。</div>';
    rej(new Error('HLS unsupported'));
  })};
  HLSAdapter.prototype.play=function(){try{this.video&&this.video.play().catch(function(){})}catch(e){}};
  HLSAdapter.prototype.pause=function(){try{this.video&&this.video.pause()}catch(e){}};
  HLSAdapter.prototype.seek=function(s){try{if(this.video)this.video.currentTime=s}catch(e){}};
  HLSAdapter.prototype.getCurrentTime=function(){return this.video?(this.video.currentTime||0):0};
  HLSAdapter.prototype.getDuration=function(){return this.video?(this.video.duration||0):0};
  HLSAdapter.prototype.destroy=function(){var self=this;if(self._ls){for(var i=0;i<self._ls.length;i++){var l=self._ls[i];try{if(self.video)self.video.removeEventListener(l[0],l[1])}catch(e){}}}self._ls=[];if(self.hls){try{self.hls.destroy()}catch(e){};self.hls=null}try{if(self.video){self.video.pause();self.video.src='';}}catch(e){};try{if(self.video&&self.video.parentNode)self.video.parentNode.removeChild(self.video)}catch(e){};self.video=null;self._clear()};

  /* ---- YouTubeAdapter（官方 embed） ---- */
  function YouTubeAdapter(media,host){this._evt={};this.media=media;this.host=host;this.player=null;this._poll=null;this._els=null}
  YouTubeAdapter.prototype=Object.create(Emitter.prototype);
  YouTubeAdapter.prototype.load=function(){var self=this;return new Promise(function(res,rej){
    var div=document.createElement('div');div.className='ci-yt';self._els=div;self.host.innerHTML='';self.host.appendChild(div);
    function ready(){res()}
    function ytReady(){
      try{
        self.player=new window.YT.Player(div,{videoId:self.media.id,playerVars:{playsinline:1,rel:0},
          events:{
            onReady:function(){self._emit('loadedmetadata',{duration:(self.player&&self.player.getDuration())||0});self._startPoll();ready()},
            onStateChange:function(e){if(e.data===1)self._startPoll();if(e.data===0)self._emit('ended',{});if(e.data===2)self._emit('paused',{})}
          }});
      }catch(e){self.host.innerHTML='<div class="ci-no-source">YouTube 播放器初始化失败。</div>';rej(new Error('YT init'))}
    }
    if(typeof window.YT!=='undefined'&&window.YT&&window.YT.Player){ytReady();return}
    var prev=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=function(){if(typeof prev==='function')prev();ytReady()};
    if(!window.YT){
      var s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';s.async=true;s.onerror=function(){self.host.innerHTML='<div class="ci-no-source">YouTube 播放器加载失败（需要联网）。</div>';rej(new Error('YT api load'))};document.head.appendChild(s);
    }
  })};
  YouTubeAdapter.prototype._startPoll=function(){var self=this;if(self._poll)clearInterval(self._poll);self._poll=setInterval(function(){try{if(self.player&&self.player.getCurrentTime){self._emit('timeupdate',{time:self.player.getCurrentTime()||0,duration:self.player.getDuration()||0})}}catch(e){}},500)};
  YouTubeAdapter.prototype.play=function(){try{this.player&&this.player.playVideo&&this.player.playVideo()}catch(e){}};
  YouTubeAdapter.prototype.pause=function(){try{this.player&&this.player.pauseVideo&&this.player.pauseVideo()}catch(e){}};
  YouTubeAdapter.prototype.seek=function(s){try{this.player&&this.player.seekTo&&this.player.seekTo(s,true)}catch(e){}};
  YouTubeAdapter.prototype.getCurrentTime=function(){try{return this.player&&this.player.getCurrentTime?this.player.getCurrentTime():0}catch(e){return 0}};
  YouTubeAdapter.prototype.getDuration=function(){try{return this.player&&this.player.getDuration?this.player.getDuration():0}catch(e){return 0}};
  YouTubeAdapter.prototype.destroy=function(){var self=this;if(self._poll){clearInterval(self._poll);self._poll=null}if(self.player){try{self.player.destroy()}catch(e){};self.player=null}if(self._els){try{if(self._els.parentNode)self._els.parentNode.removeChild(self._els)}catch(e){};self._els=null}self._clear()};

  /* ---- BilibiliAdapter（官方播放器 embed iframe） ---- */
  function BilibiliAdapter(media,host){this._evt={};this.media=media;this.host=host;this.iframe=null}
  BilibiliAdapter.prototype=Object.create(Emitter.prototype);
  BilibiliAdapter.prototype.load=function(){var self=this;return new Promise(function(res){
    var iframe=document.createElement('iframe');iframe.className='ci-bili';iframe.allow='autoplay; fullscreen; encrypted-media';iframe.allowFullscreen=true;
    var bvid=encodeURIComponent(self.media.id||'');
    iframe.src='https://player.bilibili.com/player.html?bvid='+bvid+'&page=1&high_quality=1&danmaku=1';
    self.iframe=iframe;self.host.innerHTML='';self.host.appendChild(iframe);
    self._emit('loadedmetadata',{duration:0});res();
  })};
  BilibiliAdapter.prototype._post=function(func,args){try{if(this.iframe&&this.iframe.contentWindow){this.iframe.contentWindow.postMessage(JSON.stringify({event:'command',func:func,args:args&&args.length?args:[]}),'*')}}catch(e){}};
  BilibiliAdapter.prototype.play=function(){this._post('playVideo')};
  BilibiliAdapter.prototype.pause=function(){this._post('pauseVideo')};
  BilibiliAdapter.prototype.seek=function(s){this._post('seekTo',[s,true])};
  BilibiliAdapter.prototype.getCurrentTime=function(){return 0};
  BilibiliAdapter.prototype.getDuration=function(){return 0};
  BilibiliAdapter.prototype.destroy=function(){var self=this;if(self.iframe){try{if(self.iframe.parentNode)self.iframe.parentNode.removeChild(self.iframe)}catch(e){};self.iframe=null}self._clear()};

  /* ---- UnknownAdapter（未知来源 -> graceful fallback） ---- */
  function UnknownAdapter(media,host){this._evt={};this.media=media;this.host=host}
  UnknownAdapter.prototype=Object.create(Emitter.prototype);
  UnknownAdapter.prototype.load=function(){var self=this;if(self.host)self.host.innerHTML='<div class="ci-no-source">暂不支持该来源，请使用本地视频 / 直链(.mp4/.webm) / HLS(.m3u8) / YouTube / Bilibili。</div>';self._emit('loadedmetadata',{duration:0});return Promise.resolve()};
  UnknownAdapter.prototype.play=function(){};UnknownAdapter.prototype.pause=function(){};UnknownAdapter.prototype.seek=function(){};UnknownAdapter.prototype.getCurrentTime=function(){return 0};UnknownAdapter.prototype.getDuration=function(){return 0};
  UnknownAdapter.prototype.destroy=function(){var self=this;if(self.host)self.host.innerHTML='';self._clear()};

  function createAdapter(media,host,opts){
    switch(media.provider){
      case 'youtube':return new YouTubeAdapter(media,host);
      case 'bilibili':return new BilibiliAdapter(media,host);
      case 'hls':return new HLSAdapter(media,host);
      case 'local':case 'direct':return new NativeVideoAdapter(media,host);
      default:return new UnknownAdapter(media,host);
    }
  }

  root.IBMedia={resolveMedia:resolveMedia,createAdapter:createAdapter};
})(window);
