/* Memory UI port · Coastline rendering and motion are transplanted from the original ZIP.
   Data access is through memoryReferenceAdapter; nested documents are sandboxed. */
(function(NS){
'use strict';
var $=function(id){return document.getElementById(id)};
function E(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function pad(n){return String(n).padStart(2,'0')}
function copy(key,fallback,vars){try{if(window.IBI18n&&typeof window.IBI18n.t==='function'){var value=window.IBI18n.t(key,vars);if(value!==key)return value}}catch(e){}return fallback}
function libIntro(){return{t:copy('memory.title','Memory'),a:copy('memory.tagline','Memory, settled and surfaced'),b:copy('memory.wanderingStar','Wandering Star'),d:'<span>'+copy('memory.descriptionLine1','Memories settle beneath the tide, then surface when they matter.')+'</span><br><span>'+copy('memory.descriptionLine2','Every shared moment leaves an echo for what comes next.')+'</span>'}}
function fathomIntro(){var d=copy('memory.fathom.description','循着记忆之间的回声，追寻彼此的关联与来处。'),n=copy('memory.fathom.notice','自动生成与随机浏览、过期记录尚未开放；此处呈现真实回望与已有联系。');return{t:'Fathom',a:copy('memory.fathom.tagline','记忆关联与追溯'),b:copy('memory.fathom.epithet','The Abyss Gazing Back'),d:d+(window.IBI18n&&window.IBI18n.locale==='zh-CN'?'':' ')+n}}
function openMem(id){id=String(id||'');if(id&&typeof window.openMemoryModal==='function')window.openMemoryModal(id)}
/* ══════════ 视图（记忆库 ⇄ 透视）与星图窗（星空 ⇄ 海岸） ══════════ */
var VIEW='lib',SC={lib:'coast',fathom:'sky'},INTRO=null,TXT=null,IT=0,ST=0;
function scene(){return SC[VIEW]}
function visibleInViewport(el){if(!el)return false;try{var s=getComputedStyle(el),r=el.getBoundingClientRect(),vw=document.documentElement.clientWidth||innerWidth,vh=document.documentElement.clientHeight||innerHeight;
  return s.display!=='none'&&s.visibility!=='hidden'&&r.width>1&&r.height>1&&r.right>0&&r.bottom>0&&r.left<vw&&r.top<vh}catch(e){return false}}
function pageOn(){var pg=$('page-memory');return !!pg&&(pg.classList.contains('active')||visibleInViewport(pg))}
function coastVisible(){return visibleInViewport($('mem-sky'))}
function paintIntro(anim){if(!INTRO||!TXT)return;var x=TXT[VIEW],h2=INTRO.querySelector('h2'),si=INTRO.querySelector('.mi-sub-int'),sf=INTRO.querySelector('.mi-sub-inf'),ds=INTRO.querySelector('.module-intro-desc');
  var set=function(){if(h2)h2.textContent=x.t;if(si)si.textContent=x.a;if(sf)sf.textContent=x.b;if(ds)ds.innerHTML=x.d;INTRO.classList.remove('mi-swap')};
  clearTimeout(IT);if(anim){INTRO.classList.add('mi-swap');IT=setTimeout(set,210)}else set()}
function placeAuthorityStatus(){var status=$('memory-authority-status'),slot=$(VIEW==='fathom'?'memory-authority-slot-fathom':'memory-authority-slot-lib');if(!status||!slot)return false;if(status.parentNode!==slot)slot.appendChild(status);return true}
function applyScene(){var sky=$('mem-sky'),pg=$('page-memory');if(!sky||!pg)return;var s=scene(),co=(s==='coast');
  var sw=$('mem-sky-sw');if(sw)sw.querySelectorAll('button[data-s]').forEach(function(b){var on=b.getAttribute('data-s')===s;b.classList.toggle('on',on);b.setAttribute('aria-pressed',on?'true':'false')});
  pg.classList.toggle('sc-coast',co);clearTimeout(ST);
  var ld=document.querySelector('#mem-sky-legend .mem-sky-legend-desc');if(ld)ld.textContent=co?copy('memory.coast.legendDescription','每一段记忆，都是海岸上的一粒星砂。'):copy('memory.legendDescription','星点收存共同记忆；柔光留给角色档案。');
  if(co){coastPrep();sky.classList.add('is-coast');ST=setTimeout(function(){if(scene()==='coast')sky.classList.add('coast-set')},640)}
  else if(sky.classList.contains('is-coast')||sky.classList.contains('coast-set')){sky.classList.remove('coast-set');void sky.offsetWidth;sky.classList.remove('is-coast')}
  coastSync()}
function setScene(s){s=(s==='coast')?'coast':'sky';if(SC[VIEW]===s)return;SC[VIEW]=s;try{NS.memoryReferenceAdapter.setScene(VIEW,s)}catch(e){}applyScene()}
function setView(v,noRender){v=(v==='fathom')?'fathom':'lib';var pg=$('page-memory'),seg=$('mem-view-seg');if(!pg)return;var changed=(v!==VIEW);VIEW=v;pg.classList.toggle('mv-fathom',v==='fathom');if(seg){seg.setAttribute('data-v',v);seg.querySelectorAll('button[data-v]').forEach(function(b){var on=b.getAttribute('data-v')===v;b.classList.toggle('on',on);b.setAttribute('aria-selected',on?'true':'false')})}placeAuthorityStatus();if(changed)paintIntro(true);applyScene();if(v==='fathom')renderFathom();else if(changed){try{window.renderMemories()}catch(e){}try{window.renderAutoMemShowcase()}catch(e){}}}
/* ══════════ 海岸 ══════════ */
var CO={ov:null,fr:null,mini:null,ready:false,fullReady:false,pendingStars:null,sig:'',n:0,inview:true,busy:false,ct:0,closing:false,stage:'',err:'',log:[],retry:0,rt:0,wt:0,noteOn:false,gl2:null,paused:false,idle:false,act:Date.now(),nMem:0,nScan:0};
var TPL='',MC=null,MCT=0,MP=null,RC={},RCT=0;/* 省力用的三份缓存：解开的海岸模板、记忆表（含进行中的读取）、最近各轮（扫一次以后跟着新回复与删改增量维护） */
var THUMBS={};
function clog(t){try{CO.log.push(new Date().toTimeString().slice(0,8)+' '+t);if(CO.log.length>40)CO.log.shift();console.info('[IBCoast] '+t)}catch(e){}}
function appLight(){return !document.body.classList.contains('theme-infernal')}
function fmt(n){try{return Number(n||0).toLocaleString('en-US')}catch(e){return String(n|0)}}
function sigOf(all){var mx=0;all.forEach(function(m){var u=m&&(m.updated||m.created)||0;if(u>mx)mx=u});return all.length+'|'+mx}
function thumb(light){var o=THUMBS[light?'light':'dark'];return o&&o.sig===CO.sig?o:null}
function art(n,light){/* 还没有真画面的缩略图时的底：只铺海的底色和一道柔光，不撒点、不动 */
  var P=light?{g0:'#e9f4f8',g1:'#cde0ea',g2:'#a7bccb',band:'#5d7f99',band2:'#ffffff',bo:'.2',bo2:'.7'}:{g0:'#02060c',g1:'#061629',g2:'#0b2140',band:'#49c4ff',band2:'#9fe6ff',bo:'.14',bo2:'.28'};
  var svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 236" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+P.g0+'"/><stop offset=".55" stop-color="'+P.g1+'"/><stop offset="1" stop-color="'+P.g2+'"/></linearGradient><filter id="b" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="10"/></filter></defs><rect width="420" height="236" fill="url(#g)"/><path d="M-10 118C70 92 150 134 230 108S370 86 430 112" stroke="'+P.band+'" stroke-width="20" fill="none" opacity="'+P.bo+'" filter="url(#b)"/><path d="M-10 122C70 96 150 138 230 112S370 90 430 116" stroke="'+P.band2+'" stroke-width="2" fill="none" opacity="'+P.bo2+'" filter="url(#b)"/></svg>';
  return "url('data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg).replace(/'/g,'%27')+"')"}
function bgFor(n,light){var th=thumb(light);return th?("url('"+th.data+"')"):art(n,light)}
function saveThumb(d){try{if(typeof d.data==='string'&&d.data.indexOf('data:image/jpeg')===0&&d.data.length<400000){THUMBS[d.light?'light':'dark']={sig:CO.sig,data:d.data,at:Date.now()};if(!!d.light===appLight()){var a=document.querySelector('#mem-sky-coast .cs-art');if(a)a.style.backgroundImage="url('"+d.data+"')"}}}catch(x){}}
function tplSrc(){if(TPL)return TPL;var data=window.IBMemoryCoastlineTemplate;if(!data)return '';try{var raw=atob(String(data).replace(/\s+/g,''));var bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);TPL=new TextDecoder('utf-8').decode(bytes);return TPL}catch(e){return ''}}
function fontUrl(){/* 本站自己那条字体地址；海岸里改成页面起来以后再挂（不挡脚本），连不上字体服务时海岸照样起来 */
  try{var ss=document.styleSheets;for(var i=0;i<ss.length&&i<6;i++){var rules=null;try{rules=ss[i].cssRules}catch(e){continue}if(!rules)continue;
    for(var j=0;j<rules.length&&j<3;j++){var r=rules[j];if(r&&r.type===3&&/fonts\.googleapis\.com/.test(String(r.href||'')))return String(r.href)}}}catch(e){}return ''}
function hasGL2(){if(CO.gl2!==null)return CO.gl2;try{var c=document.createElement('canvas'),g=c.getContext('webgl2');CO.gl2=!!g;try{var x=g&&g.getExtension('WEBGL_lose_context');if(x)x.loseContext()}catch(e){}}catch(e){CO.gl2=false}return CO.gl2}
function stars(all){return all.map(function(m){var c=String(m.summary||'').trim()||String(m.content||'').replace(/\s+/g,' ').trim().slice(0,160);var ts=m.eventTime>0?m.eventTime:(m.created||0),d=ts?new Date(ts):null;
  return{id:String(m.id),name:String(m.title||'').slice(0,40),domain:String(m.domain||''),importance:+m.importance||5,pinned:!!m.pinned,created:d?(d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())):'',content:c}})}
function build(all,cls){var src=tplSrc();if(!src)return '';var json=JSON.stringify({stars:stars(all)}).replace(/<\//g,'<\\/'),fu=JSON.stringify(fontUrl()).replace(/<\//g,'<\\/');
  return src.replace('__IB_DATA__',function(){return json}).replace('__IB_FONTS__','').replace('__IB_FONTURL__',function(){return fu}).replace('__IB_BODYCLS__',cls).replace('__IB_BODYSTYLE__',function(){return '--ib-sat:0px;--ib-sab:0px;--ib-sar:0px'})}/* 电脑端窗里也按全量画：不减夜光藻、不隔帧、分辨率不封 1.25 倍（模板里对应三处已改） */
function coastEl(){return $('mem-sky-coast')}
function cntText(){return copy(CO.n===1?'memory.coastCountOne':'memory.coastCount',CO.n===1?'海岸留存 1 段记忆':'海岸留存 '+fmt(CO.n)+' 段记忆',{count:fmt(CO.n)})}
function note(t,bad){var c=coastEl(),el=c&&c.querySelector('.cs-n');if(!el)return;CO.noteOn=!!t;el.classList.toggle('bad',!!(t&&bad));el.textContent=t||cntText()}
function setCount(n){CO.n=n;var c=coastEl();if(!c)return;var el=c.querySelector('.cs-n');if(el&&!CO.noteOn)el.textContent=cntText();
  var a=c.querySelector('.cs-art');if(a)a.style.backgroundImage=bgFor(n,appLight())}
function publishCoastRecords(frame){if(!frame||!frame.contentWindow||!Array.isArray(CO.pendingStars))return false;try{frame.contentWindow.postMessage({ib:'coast-set-data',stars:CO.pendingStars},'*');return true}catch(e){return false}}
function applyCoastRecords(all){if(!Array.isArray(all))return false;MC=all;MCT=Date.now();CO.sig=sigOf(all);CO.pendingStars=stars(all);if(CO.noteOn&&!CO.err)note('');setCount(all.length);
  if(CO.mini&&CO.ready)publishCoastRecords(CO.mini);if(CO.fr&&CO.fullReady)publishCoastRecords(CO.fr);return true}
function mems(){if(MC&&Date.now()-MCT<1500)return Promise.resolve(MC);if(MP)return MP;CO.nMem++;var request;
  try{request=NS.memoryReferenceAdapter.readMemories()}catch(e){request=Promise.reject(e)}
  MP=Promise.resolve(request).then(function(result){if(!result||result.status!=='ok'||!Array.isArray(result.items)){note(copy('memory.coastReadFailed','记忆暂时无法读取'),1);return null}applyCoastRecords(result.items);return MC},function(){note(copy('memory.coastReadFailed','记忆暂时无法读取'),1);return null});
  MP=MP.then(function(all){MP=null;return all},function(){MP=null;return null});return MP}
function coastPrep(){var c=coastEl();if(!c)return;var lt=appLight();c.classList.toggle('light',lt);
  var a=c.querySelector('.cs-art');if(a&&!a.style.backgroundImage)a.style.backgroundImage=bgFor(CO.n,lt);
  mems().then(function(all){if(all)applyCoastRecords(all)})}
function recount(){clearTimeout(CO.ct);CO.ct=setTimeout(function(){if(scene()==='coast'&&pageOn())coastPrep()},600)}
function coastAlive(){return scene()==='coast'&&pageOn()&&!CO.ov}/* 该不该留着窗里的海岸 */
function coastRun(){return coastAlive()&&!document.hidden&&(CO.inview||coastVisible())&&!CO.idle}/* 该不该让它动：滚出屏幕、切到别的标签页、三分钟没人动时只是停住，不拆 */
function pauseMini(on){if(!CO.mini||CO.paused===!!on)return;CO.paused=!!on;try{CO.mini.contentWindow.postMessage({ib:on?'coast-pause':'coast-resume'},'*')}catch(e){}clog('窗里的海岸：'+(on?'停住':'接着动'))}
function coastSync(){clearTimeout(CO.rt);if(!coastAlive()){stopMini();return}if(coastRun()){if(CO.mini)pauseMini(false);else startMini()}else if(CO.mini)pauseMini(true)}
function bump(){CO.act=Date.now();if(!CO.idle)return;CO.idle=false;clog('有动静，海岸接着动');coastSync();if(CO.fr&&CO.ov){try{CO.fr.contentWindow.postMessage({ib:'coast-resume'},'*')}catch(e){}}}
function idleTick(){if(CO.idle||!(CO.mini||CO.ov)||Date.now()-CO.act<180000)return;CO.idle=true;clog('三分钟没人动，海岸先停住');coastSync();if(CO.fr&&CO.ov){try{CO.fr.contentWindow.postMessage({ib:'coast-pause'},'*')}catch(e){}}}
function frame2(fn){requestAnimationFrame(function(){requestAnimationFrame(fn)})}
function startMini(){if(CO.mini||CO.busy||!coastRun())return;var c=coastEl(),host=c&&c.querySelector('.cs-live');if(!host)return;
  /* 先让海岸自己出现；Home Node 的 canonical 记忆同步在后台补进来，不拦住原版画面启动。 */
  CO.busy=true;var initial=Array.isArray(MC)?MC:[];CO.pendingStars=stars(initial);
  if(!MC)note(copy('memory.coastLoading','记忆正在浮现…'));
  if(!hasGL2()){CO.busy=false;CO.err='nogl';note(copy('memory.coastNoRenderer','海岸暂时无法显现，请稍后重试。'),1);clog('没有 WebGL2');return}
  var src=build(initial,'mini'+(appLight()?' light':''));if(!src){CO.busy=false;CO.err='tpl';note(copy('memory.coastNoRenderer','海岸暂时无法显现，请稍后重试。'),1);clog('模板没读到');return}
  frame2(function(){if(CO.mini||!coastRun()){CO.busy=false;return}
    var f=document.createElement('iframe');f.className='cs-mini';f.setAttribute('title','');f.setAttribute('tabindex','-1');f.setAttribute('aria-hidden','true');f.setAttribute('referrerpolicy','no-referrer');f.setAttribute('sandbox','allow-scripts');f.srcdoc=src;
    CO.mini=f;CO.ready=false;CO.paused=false;CO.stage='load';CO.err='';host.classList.remove('on');window.addEventListener('message',onMsg);host.appendChild(f);CO.busy=false;clog('窗里的海岸：建（'+initial.length+' 条）');
    clearTimeout(CO.wt);CO.wt=setTimeout(function(){if(CO.mini===f&&!CO.ready&&!CO.err)note('the tide is coming in')},1800)});
  mems().then(function(all){if(all){CO.retry=0;applyCoastRecords(all)}})}
function stopMini(){CO.paused=false;clearTimeout(CO.wt);if(CO.noteOn&&(!CO.err||CO.err==='run'))note('');if(!CO.mini)return;var f=CO.mini;CO.mini=null;CO.ready=false;try{f.srcdoc='<!doctype html><title>.</title>'}catch(e){}
  var h=f.parentNode;if(h&&h.classList)h.classList.remove('on');setTimeout(function(){try{f.remove()}catch(e){}},60);if(!CO.ov)window.removeEventListener('message',onMsg);clog('窗里的海岸：拆')}
function onTheme(){var lt=appLight(),c=coastEl();if(c){c.classList.toggle('light',lt);var a=c.querySelector('.cs-art');if(a)a.style.backgroundImage=bgFor(CO.n,lt)}
  if(CO.mini&&CO.mini.contentWindow){try{CO.mini.contentWindow.postMessage({ib:'coast-set-theme',light:lt},'*')}catch(e){}}}
function waitText(ov,t){var w=ov&&ov.querySelector('.cs-wait');if(!w)return;w.classList.add('bad');w.textContent=t}
function onMsg(e){var d=e&&e.data;if(!d||!d.ib)return;var fromMini=CO.mini&&e.source===CO.mini.contentWindow,fromFull=CO.fr&&e.source===CO.fr.contentWindow;
  if(fromMini){
    if(d.ib==='coast-ready'){CO.ready=true;CO.stage='ready';CO.err='';clearTimeout(CO.wt);if(MC)note('');else note(copy('memory.coastLoading','记忆正在浮现…'));var h=CO.mini.parentNode;if(h&&h.classList)h.classList.add('on');if(Array.isArray(CO.pendingStars))publishCoastRecords(CO.mini);clog('窗里的海岸：起来了');return}
    if(d.ib==='coast-stage'){CO.stage=String(d.s||'');clog('窗里的海岸：'+CO.stage+(d.n?(' '+d.n):'')+(d.ms?(' '+d.ms+' 毫秒'):''));return}
     if(d.ib==='coast-nogl'){CO.err='nogl';note(copy('memory.coastNoRenderer','海岸暂时无法显现，请稍后重试。'),1);clog('窗里的海岸：没有 WebGL2');return}
     if(d.ib==='coast-error'){clog('窗里的海岸出错：'+String(d.msg||''));if(!CO.ready){CO.err='run';note(copy('memory.coastNoRenderer','海岸暂时无法显现，请稍后重试。'),1)}return}
    if(d.ib==='coast-thumb'){saveThumb(d);return}
    if(d.ib==='coast-act'){bump();return}
    return}
  if(!fromFull||!CO.ov||CO.closing)return;
  if(d.ib==='coast-ready'){CO.fullReady=true;CO.ov.classList.add('ready');if(CO.pendingStars)publishCoastRecords(CO.fr);clog('全屏：起来了');try{CO.fr.contentWindow.focus()}catch(x){}return}/* 键盘（左右键逐条看、Esc）直接交给海岸 */
  if(d.ib==='coast-stage'){clog('全屏：'+String(d.s||'')+(d.n?(' '+d.n):'')+(d.ms?(' '+d.ms+' 毫秒'):''));return}
  if(d.ib==='coast-nogl'){CO.ov.classList.add('ready');clog('全屏：没有 WebGL2');return}/* 海岸自己会写一行提示，让它露出来 */
   if(d.ib==='coast-error'){clog('全屏出错：'+String(d.msg||''));if(!CO.ov.classList.contains('ready'))waitText(CO.ov,copy('memory.coastNoRenderer','海岸暂时无法显现，请稍后重试。'));return}
  if(d.ib==='coast-act'){bump();return}
  if(d.ib==='coast-close'){coastClose();return}
  if(d.ib==='coast-thumb'){saveThumb(d);return}
  if(d.ib==='coast-theme'){CO.ov.classList.toggle('light',!!d.light);return}
  if(d.ib==='coast-open'){var id=String(d.id||'');coastClose(function(){openMem(id)})}}/* 记忆编辑框在页面里，压不过全屏层：先收海岸，再打开那条记忆 */
function onKey(e){if(e.key==='Escape'&&CO.ov){e.preventDefault();coastClose()}}
function still(){try{return document.body.classList.contains('ib-reduce')||matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){return false}}
function winClip(){/* 星图窗此刻在屏幕上的位置，换成全屏层的裁切框；窗子不在屏幕上时返回空，改用淡入淡出 */
  var c=coastEl();if(!c)return '';var r=c.getBoundingClientRect(),vw=document.documentElement.clientWidth||innerWidth,vh=innerHeight;
  if(r.width<40||r.height<40||r.bottom<=8||r.top>=vh-8)return '';
  var f=function(v){return Math.max(0,v).toFixed(1)+'px'};
  return 'inset('+f(r.top)+' '+f(vw-r.right)+' '+f(vh-r.bottom)+' '+f(r.left)+' round 20px)'}
function coastOpen(){if(CO.ov||CO.closing)return;stopMini();/* 先把全屏层立起来再读库：点了一定有反应 */
  var lt=appLight(),ov=E('div',lt?'light':'');ov.id='ib-coast';ov.setAttribute('role','dialog');ov.setAttribute('aria-label','海岸全貌');
  ov.innerHTML='<div class="cs-bg"></div><div class="cs-wait">the tide is coming in</div><div class="cs-load"><i></i></div><button type="button" class="cs-x" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  var clip=still()?'':winClip();if(clip){ov.classList.add('grow');ov.style.clipPath=clip}
  ov.querySelector('.cs-x').addEventListener('click',function(){coastClose()});
  document.documentElement.classList.add('ib-coast-on');document.body.appendChild(ov);CO.ov=ov;CO.fr=null;CO.fullReady=false;
  window.addEventListener('message',onMsg);document.addEventListener('keydown',onKey);clog('全屏：开');
  frame2(function(){if(CO.ov!==ov)return;ov.classList.add('on');if(clip)ov.style.clipPath='inset(0px 0px 0px 0px round 0px)'});
  var initial=Array.isArray(MC)?MC:[];CO.pendingStars=stars(initial);var src=build(initial,lt?'light':'');if(!src){waitText(ov,'海岸没起来：模板没读到');clog('模板没读到');return}
  if(!MC)mems().then(function(all){if(all)applyCoastRecords(all)});
  setTimeout(function(){if(CO.ov!==ov||CO.closing)return;/* 等长满的那一下走完再建海岸，两件重活不挤在一起 */
    document.documentElement.classList.add('ib-coast-full');/* 长满了：底下整页不再画，显卡只管海岸 */
    var f=document.createElement('iframe');f.className='cs-frame';f.setAttribute('title','Coastline');f.setAttribute('referrerpolicy','no-referrer');f.setAttribute('sandbox','allow-scripts');f.srcdoc=src;CO.fr=f;CO.fullReady=false;ov.insertBefore(f,ov.querySelector('.cs-wait'));clog('全屏：建（'+initial.length+' 条）');
    setTimeout(function(){if(CO.ov===ov&&CO.fr===f&&!CO.closing&&!ov.classList.contains('ready')&&!ov.querySelector('.cs-wait.bad')){ov.classList.add('ready');clog('全屏：20 秒没等到，先把画面露出来')}},20000)},clip?680:80)}
function coastClose(after){if(!CO.ov||CO.closing)return;var ov=CO.ov,f=CO.fr,q=still();CO.closing=true;document.removeEventListener('keydown',onKey);document.documentElement.classList.remove('ib-coast-full');
  try{ov.querySelector('.cs-bg').style.backgroundImage=bgFor(CO.n,appLight())}catch(e){}
  /* 保留全屏 iframe 的当前画面穿过裁切动画；fin() 在过渡结束后统一释放 Canvas/WebGL 文档。 */
    setTimeout(function(){document.documentElement.classList.remove('ib-coast-on');
    var clip=q?'':winClip();
    if(clip){ov.classList.add('grow');void ov.offsetWidth;ov.style.clipPath=clip;setTimeout(fin,680)}else{ov.classList.remove('on');setTimeout(fin,480)}},20);
  function fin(){try{if(f&&f.parentNode)f.remove()}catch(e){}try{ov.remove()}catch(e){}if(CO.ov===ov){CO.ov=null;CO.fr=null;CO.fullReady=false}CO.closing=false;if(!CO.mini)window.removeEventListener('message',onMsg);coastSync();
    if(typeof after==='function'){try{after()}catch(e){}}}}


var FATHOM={snapshot:null,selectedRecall:'',selectedMemory:'',benchmark:null,failure:null,mode:'order',seq:0};
function emptyHTML(title,detail){return '<div class="sx-mp-empty" role="status" aria-live="polite"><b>'+safeHtml(title)+'</b><span>'+safeHtml(detail)+'</span></div>'}
function safeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
function fathomDate(value){var n=Number(value)||0;if(!n)return copy('memory.fathom.unknownTime','时间未记');try{return new Date(n).toLocaleString()}catch(e){return String(n)}}
function fathomRecordMap(snapshot){var map={};(snapshot&&snapshot.records||[]).forEach(function(record){if(record&&record.id!=null)map[String(record.id)]=record});return map}
function fathomLabel(snapshot,id){var row=fathomRecordMap(snapshot)[String(id)];return row&&(row.title||row.domain)||copy('memory.fathom.untitled','未命名记忆')}
function fathomShortId(id){id=String(id||'');return id.length>12?id.slice(0,8)+'…':id}
function fathomSource(channel){return channel==='group'?copy('memory.fathom.groupChat','群聊'):copy('memory.fathom.chat','Chat')}
function selectFathomRecall(id){FATHOM.selectedRecall=String(id||'');FATHOM.selectedMemory='';paintFathom()}
function selectFathomMemory(id){FATHOM.selectedMemory=String(id||'');paintFathom()}
function openFathomMemory(id){id=String(id||'');var row=fathomRecordMap(FATHOM.snapshot)[id];if(row)openMem(id)}
function renderFathomMap(snapshot){
  var box=$('sx-mp-box'),low=$('sx-low'),recalls=(snapshot&&snapshot.recalls||[]).slice(),records=(snapshot&&snapshot.records||[]),map=fathomRecordMap(snapshot);
  if(!box)return;
  if(FATHOM.mode==='time')recalls.sort(function(a,b){return(a.at-b.at)||String(a.id).localeCompare(String(b.id))});
  else recalls.sort(function(a,b){return((b.edges||[]).length-(a.edges||[]).length)||(b.at-a.at)});
  recalls=recalls.slice(0,36);
  var note=$('sx-mp-note');if(note)note.textContent=copy('memory.fathom.mapNote','每一行来自一次真实回望，连线只表示当时记录的关联。');
  var tab=$('sx-tab');if(tab)tab.innerHTML='<div class="sx-tt"><b>'+copy('memory.fathom.strands','脉络 · Strands')+'</b><span>'+safeHtml(snapshot&&snapshot.scope&&snapshot.scope.name||'')+'</span></div><span class="sx-st">'+safeHtml(String(recalls.length))+' · '+copy('memory.fathom.recallEvents','次回望')+'</span>';
  if(!recalls.length){box.classList.add('sx-ref-empty');box.style.height='180px';box.style.minWidth='700px';box.innerHTML=emptyHTML(copy('memory.fathom.noRecalls','尚无回望'),copy('memory.fathom.noRecallsHint','真实召回发生后，记忆会在这里留下可追溯的脉络。'));if(low)low.classList.add('sx-empty');var emptyCat=$('sx-cat');if(emptyCat){var emptySlice=records.slice(0,40);emptyCat.innerHTML=emptySlice.map(function(row){return'<div class="sx-ci'+(FATHOM.selectedMemory===String(row.id)?' sx-sel':'')+'" data-fathom-memory="'+safeHtml(row.id)+'" role="button" tabindex="0"><i class="sx-ci-dot"></i><div class="sx-ci-m"><div class="sx-ci-t">'+safeHtml(row.title||copy('memory.fathom.untitled','未命名记忆'))+'</div><div class="sx-ci-s">'+safeHtml(row.domain||copy('memory.fathom.uncategorized','未归类'))+' · '+safeHtml(fathomDate(row.created))+'</div></div><span class="sx-ci-n">'+safeHtml((row.tags||[]).slice(0,2).join(' · '))+'</span><i class="sx-ci-car"></i></div>'}).join('')||'<p class="sx-cq">'+safeHtml(copy('memory.fathom.noMemories','当前角色没有可见记忆。'))+'</p>'}renderFathomDetail(snapshot,null);return}
  if(low)low.classList.remove('sx-empty');box.classList.remove('sx-ref-empty');box.classList.add('sx-swap');setTimeout(function(){box.classList.remove('sx-swap')},480);
  var maxNodes=1;recalls.forEach(function(event){var ids=(event.selectedIds||[]).slice();(event.edges||[]).forEach(function(edge){if(ids.indexOf(edge.relatedMemoryId)<0)ids.push(edge.relatedMemoryId)});maxNodes=Math.max(maxNodes,ids.length)});
  var width=Math.max(900,250+maxNodes*112+60),height=44+recalls.length*64;
  box.style.minWidth=width+'px';box.style.height=height+'px';
  var svg='<svg viewBox="0 0 '+width+' '+height+'" preserveAspectRatio="none" aria-hidden="true"><path class="sx-grow" d="M0 44H'+width+'"/>';
  var rows='';
  recalls.forEach(function(event,index){
    var y=64+index*64,ids=(event.selectedIds||[]).slice(),direct={},related={};ids.forEach(function(id){direct[String(id)]=1});
    (event.edges||[]).forEach(function(edge){related[String(edge.anchorMemoryId)]=1;related[String(edge.relatedMemoryId)]=1;if(ids.indexOf(edge.anchorMemoryId)<0)ids.push(edge.anchorMemoryId);if(ids.indexOf(edge.relatedMemoryId)<0)ids.push(edge.relatedMemoryId)});
    if(FATHOM.mode==='time')ids.sort(function(a,b){return((map[a]&&map[a].created)||0)-((map[b]&&map[b].created)||0)});
    var positions={};ids.forEach(function(id,i){positions[String(id)]=250+i*112});
    var selected=String(event.id)===FATHOM.selectedRecall?' sx-sel':'';
    rows+='<div class="sx-rh'+selected+'" data-fathom-recall="'+safeHtml(event.id)+'" role="button" tabindex="0" aria-label="'+safeHtml(fathomSource(event.channel)+' · '+fathomDate(event.at))+'" style="top:'+(y-21)+'px;width:196px"><span class="sx-rh-no">'+String(index+1).padStart(2,'0')+'</span><span class="sx-rh-t">'+safeHtml(fathomDate(event.at))+'</span><span class="sx-rh-m"><b>'+ids.length+'</b></span><i class="sx-rh-port"></i></div>';
    svg+='<path class="sx-grow" d="M0,'+(y+27)+'H'+width+'"/><g class="sx-rw'+selected+'">';
    (event.edges||[]).forEach(function(edge){var x1=positions[String(edge.anchorMemoryId)],x2=positions[String(edge.relatedMemoryId)];if(x1==null||x2==null||x1===x2)return;var mid=(x1+x2)/2;svg+='<path class="sx-w" d="M'+x1+','+y+' C'+mid+','+(y-14)+' '+mid+','+(y-14)+' '+x2+','+y+'"><title>'+safeHtml(edge.relation)+'</title></path><path class="sx-wf" d="M'+x1+','+y+' C'+mid+','+(y-14)+' '+mid+','+(y-14)+' '+x2+','+y+'"/>'});
    ids.forEach(function(id){var x=positions[String(id)],record=map[String(id)]||{},isDirect=!!direct[String(id)],isRelated=!!related[String(id)],pin=record.pinned===true?' sx-pin':'';svg+='<g class="sx-n'+(isDirect?' sx-mile':'')+(isRelated&&!isDirect?' sx-assoc':'')+pin+'" data-fathom-memory="'+safeHtml(id)+'" role="button" tabindex="0" aria-label="'+safeHtml(record.title||copy('memory.fathom.untitled','未命名记忆'))+'" style="--sx-c:var(--sx-acc)" transform="translate('+x+','+y+')"><circle class="sx-hit" r="12"/><circle class="sx-dot" r="'+(isDirect?'5.4':'4')+'"/><title>'+safeHtml(record.title||copy('memory.fathom.untitled','未命名记忆'))+'</title></g>'});
    svg+='</g>';
  });
  svg+='</svg>';box.innerHTML=svg+rows;
  var foot=$('sx-mp-foot'),edgeCount=recalls.reduce(function(n,event){return n+(event.edges||[]).length},0),faded=copy('memory.fathom.direct','直接浮现'),related=copy('memory.fathom.associated','Association 关联');
  if(foot)foot.innerHTML='<span class="sx-lg"><span><i style="background:var(--sx-acc)"></i>'+safeHtml(faded)+'</span><span><i style="background:var(--sx-gold)"></i>'+safeHtml(related)+' · '+edgeCount+'</span></span><span class="sx-tb"><span>'+safeHtml(copy('memory.fathom.sourceTrace','来源可追溯'))+'</span></span>';
  var cat=$('sx-cat');if(cat){var slice=records.slice(0,40);cat.innerHTML=slice.map(function(row){return'<div class="sx-ci'+(FATHOM.selectedMemory===String(row.id)?' sx-sel':'')+'" data-fathom-memory="'+safeHtml(row.id)+'" role="button" tabindex="0"><i class="sx-ci-dot"></i><div class="sx-ci-m"><div class="sx-ci-t">'+safeHtml(row.title||copy('memory.fathom.untitled','未命名记忆'))+'</div><div class="sx-ci-s">'+safeHtml(row.domain||copy('memory.fathom.uncategorized','未归类'))+' · '+safeHtml(fathomDate(row.created))+'</div></div><span class="sx-ci-n">'+safeHtml((row.tags||[]).slice(0,2).join(' · '))+'</span><i class="sx-ci-car"></i></div>'}).join('')||'<p class="sx-cq">'+safeHtml(copy('memory.fathom.noMemories','当前角色没有可见记忆。'))+'</p>'}
  var selectedRecall=recalls.find(function(event){return String(event.id)===FATHOM.selectedRecall})||recalls[0];
  if(!FATHOM.selectedRecall&&selectedRecall)FATHOM.selectedRecall=String(selectedRecall.id);
  renderFathomDetail(snapshot,selectedRecall);
}
function renderFathomDetail(snapshot,event){
  var det=$('sx-det');if(!det)return;var map=fathomRecordMap(snapshot),recordId=FATHOM.selectedMemory,record=recordId&&map[recordId];
  if(record){var tags=(record.tags||[]).map(function(tag){return'<span>'+safeHtml(tag)+'</span>'}).join('');var sources=(snapshot.recalls||[]).filter(function(item){return(item.selectedIds||[]).indexOf(recordId)>=0||(item.edges||[]).some(function(edge){return edge.relatedMemoryId===recordId||edge.anchorMemoryId===recordId})});det.innerHTML='<div class="sx-low-h sx-dt-head"><h3 class="sx-dt-title">'+safeHtml(record.title||copy('memory.fathom.untitled','未命名记忆'))+'</h3><span class="sx-dt-meta">'+safeHtml(record.domain||copy('memory.fathom.uncategorized','未归类'))+' · '+safeHtml(fathomDate(record.created))+'</span></div><div class="sx-dt-body"><div class="sx-dt-grid"><div><h4 class="sx-lab">'+copy('memory.fathom.memoryTags','Tags')+'</h4><div class="sx-dt-tags">'+(tags||'<span>'+safeHtml(copy('memory.fathom.noTags','尚无标签'))+'</span>')+'</div></div><aside><h4 class="sx-lab">'+copy('memory.fathom.sources','Sources')+'</h4>'+sources.map(function(item){var relations=(item.edges||[]).filter(function(edge){return edge.anchorMemoryId===recordId||edge.relatedMemoryId===recordId});return'<div class="sx-dt-x"><b>'+safeHtml(fathomSource(item.channel))+'</b> · '+safeHtml(fathomDate(item.at))+(relations.length?'<br>'+relations.map(function(edge){var other=edge.anchorMemoryId===recordId?edge.relatedMemoryId:edge.anchorMemoryId;return safeHtml(copy('memory.fathom.relation','关联'))+' · '+safeHtml(edge.relation)+' · '+safeHtml(fathomLabel(snapshot,other))}).join('<br>'):'<br>'+safeHtml(copy('memory.fathom.directSource','本轮直接浮现')) )+'</div>'}).join('')||'<p class="sx-hint">'+safeHtml(copy('memory.fathom.noSources','近期回望中没有来源记录。'))+'</p>'+'</aside></div></div><div class="sx-dt-foot"><button type="button" class="btn fm-mini" data-fathom-open="'+safeHtml(recordId)+'">'+safeHtml(copy('memory.fathom.openMemory','查看记忆'))+'</button></div>';return}
  if(!event){det.innerHTML='<div class="sx-low-h sx-dt-head">'+copy('memory.fathom.sources','Sources')+'</div><div class="sx-dt-body"><p class="sx-hint">'+safeHtml(copy('memory.fathom.noRecallsHint','真实召回发生后，记忆会在这里留下可追溯的脉络。'))+'</p></div>';return}
  var direct=(event.selectedIds||[]).map(function(id){return'<div class="sx-pg" data-fathom-memory="'+safeHtml(id)+'" role="button" tabindex="0"><i class="sx-pg-k"></i><span class="sx-pg-d">'+safeHtml(fathomShortId(id))+'</span><span class="sx-pg-t">'+safeHtml(fathomLabel(snapshot,id))+'</span><button type="button" class="sx-pg-o" data-fathom-open="'+safeHtml(id)+'">'+safeHtml(copy('memory.fathom.openMemory','查看'))+'</button></div>'}).join('');
  var edges=(event.edges||[]).map(function(edge){return'<div class="sx-dt-x"><b>'+safeHtml(fathomLabel(snapshot,edge.anchorMemoryId))+'</b> → <b>'+safeHtml(fathomLabel(snapshot,edge.relatedMemoryId))+'</b><br>'+safeHtml(copy('memory.fathom.relation','关联'))+' · '+safeHtml(edge.relation)+' · '+safeHtml(fathomSource(event.channel))+' · '+safeHtml(fathomDate(event.at))+'</div>'}).join('');
  det.innerHTML='<div class="sx-low-h sx-dt-head"><h3 class="sx-dt-title">'+safeHtml(copy('memory.fathom.recallSource','回望来源'))+'</h3><span class="sx-dt-meta">'+safeHtml(fathomSource(event.channel))+' · '+safeHtml(fathomDate(event.at))+'</span></div><div class="sx-dt-body"><div class="sx-dt-grid"><div><h4 class="sx-lab">'+copy('memory.fathom.directMemories','直接浮现')+'</h4>'+(direct||'<p class="sx-hint">'+safeHtml(copy('memory.fathom.noDirectRecall','这一轮没有直接浮现的记忆。'))+'</p>')+'</div><aside><h4 class="sx-lab">'+copy('memory.fathom.associations','记忆关联')+'</h4>'+(edges||'<p class="sx-hint">'+safeHtml(copy('memory.fathom.noAssociations','这一轮没有记录到关联。'))+'</p>')+'</aside></div></div><div class="sx-dt-foot"><span>'+safeHtml(copy('memory.fathom.traceCounts','候选 {candidates} · 可用 {eligible} · 浮现 {selected}',{candidates:event.counts&&event.counts.candidates==null?'—':event.counts&&event.counts.candidates,eligible:event.counts&&event.counts.eligible==null?'—':event.counts&&event.counts.eligible,selected:event.counts&&event.counts.selected==null?(event.selectedIds||[]).length:event.counts.selected}))+'</span></div>';
}
function renderTidebook(snapshot){
  var list=$('fm-list'),grid=list&&list.parentNode;if(!list)return;var filter=$('fm-filter'),kind=filter&&filter.value||'all',timeline=(snapshot&&snapshot.timeline||[]).filter(function(event){return kind==='all'||event.kind===kind}).slice(0,80),map=fathomRecordMap(snapshot),html='',last='';
  timeline.forEach(function(event){var day=new Date(Number(event.at)||0).toLocaleDateString();if(day!==last){last=day;html+='<div class="fm-day"><i class="fm-dia"></i><span class="fm-day-l">'+safeHtml(day)+'</span></div>'}
    var title='',detail='',ids=[];
    if(event.kind==='recall'){ids=(event.selectedIds||[]).slice();title=copy('memory.fathom.tideRecall','记忆浮现');detail=fathomSource(event.channel)+' · '+ids.length+' · '+(event.edges||[]).length+' '+copy('memory.fathom.associations','关联')}
    else if(event.kind==='write'){ids=event.recordId?[event.recordId]:[];title=copy('memory.fathom.tideWrite','记忆落笔');detail=map[event.recordId]?(map[event.recordId].domain||copy('memory.fathom.uncategorized','未归类')):copy('memory.fathom.memoryChanged','一条记忆有了新的记录')}
    else{ids=event.recordId&&map[event.recordId]?[event.recordId]:[];title=copy('memory.fathom.tideRemove','记忆退潮');detail=copy('memory.fathom.removedAt','移除记录')+' · '+safeHtml(fathomShortId(event.recordId))}
    html+='<article class="fm-turn"><i class="fm-bead"></i><div class="fm-card"><div class="fm-h"><span>'+safeHtml(title)+'</span><small>'+safeHtml(fathomDate(event.at))+'</small></div><p class="fm-hint">'+safeHtml(detail)+'</p>';
    if(event.kind==='recall'&&(event.edges||[]).length){html+='<div class="fm-li">'+event.edges.map(function(edge){return'<span>'+safeHtml(fathomLabel(snapshot,edge.anchorMemoryId))+' → '+safeHtml(fathomLabel(snapshot,edge.relatedMemoryId))+' · '+safeHtml(edge.relation)+'</span>'}).join('')+'</div>'}
    if(ids.length){html+='<div class="fm-acts keep">'+ids.slice(0,8).map(function(id){return'<button type="button" class="fm-act" data-fathom-open="'+safeHtml(id)+'">'+safeHtml(fathomLabel(snapshot,id))+'</button>'}).join('')+'</div>'}
    html+='</div></article>';
  });
  if(timeline.length){list.classList.remove('is-empty');if(grid)grid.classList.remove('fm-none');list.innerHTML=html}
  else{list.classList.add('is-empty');if(grid)grid.classList.add('fm-none');list.innerHTML='<div class="fm-card fm-nonec"><div class="fm-h">'+safeHtml(copy('memory.fathom.noTideRecords','还没有可回望的记录'))+'</div><p class="fm-hint">'+safeHtml(copy('memory.fathom.noTideRecordsHint','记忆写入或真实召回后，记录会在这里留下。'))+'</p></div>'}
  var recalls=(snapshot&&snapshot.timeline||[]).filter(function(e){return e.kind==='recall'}).length,writes=(snapshot&&snapshot.timeline||[]).filter(function(e){return e.kind==='write'}).length,removed=(snapshot&&snapshot.timeline||[]).filter(function(e){return e.kind==='remove'}).length;
  var rail=[['fm-rc-ln','memory.fathom.railRecalls','真实回望',recalls+' · '+copy('memory.fathom.recallEvents','次回望')],['fm-rc-old','memory.fathom.railRemoved','已移除',removed+' · '+copy('memory.fathom.records','条记录')],['fm-rc-miss','memory.fathom.railMisses','遗漏依据',FATHOM.benchmark&&FATHOM.benchmark.ok===true?String((FATHOM.benchmark.missed||[]).length)+' · '+copy('memory.fathom.missed','遗漏'):copy('memory.fathom.missBasis','仅在有明确预期时统计')],['fm-rc-wlog','memory.fathom.railWrites','落笔记录',writes+' · '+copy('memory.fathom.records','条记录')]];
  rail.forEach(function(row){var el=$(row[0]);if(el)el.innerHTML='<div class="fm-h">'+copy(row[1],row[2])+'</div><p class="fm-hint">'+safeHtml(row[3])+'</p>'});
}
function renderBenchmark(snapshot){
  var body=$('fm-eval-body');if(!body)return;var records=(snapshot&&snapshot.records||[]),result=FATHOM.benchmark;
  var options=records.map(function(row){return'<option value="'+safeHtml(row.id)+'">'+safeHtml((row.title||copy('memory.fathom.untitled','未命名记忆'))+' · '+(row.domain||copy('memory.fathom.uncategorized','未归类'))+' · '+fathomShortId(row.id))+'</option>'}).join('');
  var resultHtml='';
  if(result){if(!result.ok)resultHtml='<p class="fm-hint">'+safeHtml(copy('memory.fathom.benchmarkFailed','这次召回没有完成，请稍后再试。'))+'</p>';
    else{var labels=function(ids){return ids.map(function(id){return'<span class="fm-fathom-chip">'+safeHtml(fathomLabel(snapshot,id))+'</span>'}).join('')||'<span class="fm-hint">'+safeHtml(copy('memory.fathom.none','无'))+'</span>'};resultHtml='<div class="fm-fathom-result"><div class="fm-xt-bar"><span class="fm-fathom-chip">'+copy('memory.fathom.hitCount','命中')+' · '+result.hits.length+'</span><span class="fm-fathom-chip">'+copy('memory.fathom.missCount','遗漏')+' · '+result.missed.length+'</span><span class="fm-fathom-chip">'+copy('memory.fathom.falseCount','误召回')+' · '+result.falseRecalls.length+'</span></div><p class="fm-xt-q">'+copy('memory.fathom.expected','已知预期')+'</p><div>'+labels(result.expected)+'</div><p class="fm-xt-q">'+copy('memory.fathom.recalled','实际浮现')+'</p><div>'+labels(result.actual)+'</div><p class="fm-xt-q">'+copy('memory.fathom.missed','遗漏')+'</p><div>'+labels(result.missed)+'</div><p class="fm-xt-q">'+copy('memory.fathom.falseRecalls','误召回')+'</p><div>'+labels(result.falseRecalls)+'</div></div>'}}
  body.innerHTML='<div class="fm-fathom-form"><label class="fm-xt-q" for="fm-benchmark-query">'+safeHtml(copy('memory.fathom.benchmarkQuery','召回语句'))+'</label><textarea id="fm-benchmark-query" maxlength="1200" rows="3" data-bm-query placeholder="'+safeHtml(copy('memory.fathom.benchmarkQueryPlaceholder','写下一句用于回看的话'))+'"></textarea><label class="fm-xt-q" for="fm-benchmark-expected">'+safeHtml(copy('memory.fathom.expectedMemories','选择已知应浮现的记忆'))+'</label><select id="fm-benchmark-expected" multiple size="5" data-bm-expected>'+options+'</select><label class="fm-fathom-check"><input type="checkbox" data-bm-none> '+safeHtml(copy('memory.fathom.expectNone','预期没有记忆浮现'))+'</label><div class="fm-xt-bar"><button type="button" class="btn btn-primary fm-mini" data-act="benchmark-run"'+(records.length?'':' disabled')+'>'+safeHtml(copy('memory.fathom.runBenchmark','开始回看'))+'</button><span class="fm-hint">'+safeHtml(copy('memory.fathom.benchmarkScope','本次回看只留在当前页面，不会改动记忆。'))+'</span></div>'+resultHtml+'</div>';
}
function renderTidy(snapshot){
  var body=$('fm-tidy-body');if(!body)return;var tidy=snapshot&&snapshot.tidy||{},map=fathomRecordMap(snapshot),html='';
  function review(id){return'<button type="button" class="fm-act" data-act="tidy-review" data-id="'+safeHtml(id)+'">'+safeHtml(copy('memory.fathom.reviewMemory','打开核对'))+'</button>'}
  function rows(items,build){return items.length?items.map(build).join(''):'<p class="fm-hint">'+safeHtml(copy('memory.fathom.none','暂无'))+'</p>'}
  html+='<section class="fm-fathom-tidy-group"><p class="fm-xt-q">'+safeHtml(copy('memory.fathom.duplicateSuggestions','内容完全相同'))+'</p>'+rows(tidy.duplicates||[],function(item){var names=(item.memoryIds||[]).map(function(id){return'<span class="fm-fathom-chip">'+safeHtml(fathomLabel(snapshot,id))+'</span>'+review(id)}).join('');return'<div class="fm-fathom-suggestion"><span class="fm-hint">'+safeHtml(copy('memory.fathom.exactDuplicateBasis','依据：可见记忆正文完全相同'))+'</span><div>'+names+'</div></div>'})+'</section>';
  html+='<section class="fm-fathom-tidy-group"><p class="fm-xt-q">'+safeHtml(copy('memory.fathom.categorySuggestions','归类线索'))+'</p>'+rows(tidy.categories||[],function(item){var evidence=(item.evidenceIds||[]).map(function(id){return safeHtml(fathomLabel(snapshot,id))}).join('、');return'<div class="fm-fathom-suggestion"><span class="fm-fathom-chip">'+safeHtml(fathomLabel(snapshot,item.memoryId))+'</span><span class="fm-hint">'+safeHtml(copy('memory.fathom.categoryBasis','与 {count} 条同类记忆共用标签：{tags} → {domain}',{count:(item.evidenceIds||[]).length,tags:(item.sharedTags||[]).join('、'),domain:item.domain}))+' · '+safeHtml(evidence)+'</span>'+review(item.memoryId)+'</div>'})+'</section>';
  html+='<section class="fm-fathom-tidy-group"><p class="fm-xt-q">'+safeHtml(copy('memory.fathom.uncategorizedMemories','尚未归类'))+'</p>'+rows(tidy.uncategorized||[],function(id){var row=map[String(id)]||{};return'<div class="fm-fathom-suggestion"><span class="fm-fathom-chip">'+safeHtml(row.title||copy('memory.fathom.untitled','未命名记忆'))+'</span><span class="fm-hint">'+safeHtml(copy('memory.fathom.chooseCategory','可在记忆编辑器中选择类别。'))+'</span>'+review(id)+'</div>'})+'</section>';
  html+='<section class="fm-fathom-tidy-group"><p class="fm-xt-q">'+safeHtml(copy('memory.fathom.tagCleanup','重复标签'))+'</p>'+rows(tidy.tagCleanup||[],function(item){return'<div class="fm-fathom-suggestion"><span class="fm-fathom-chip">'+safeHtml(fathomLabel(snapshot,item.memoryId))+'</span><span class="fm-hint">'+safeHtml(copy('memory.fathom.removeRepeatedTags','可核对并合并重复标签：{tags}',{tags:(item.removeTags||[]).join('、')}))+'</span>'+review(item.memoryId)+'</div>'})+'</section>';
  body.innerHTML=html;
}
function paintFathom(){var snapshot=FATHOM.snapshot;if(!snapshot)return;renderFathomMap(snapshot);renderTidebook(snapshot);renderBenchmark(snapshot);renderTidy(snapshot)}
function fathomStatusCopy(failure,loading){
  if(loading)return{title:copy('memory.fathom.homeNodeLoading','正在连接 Home Node…'),detail:copy('memory.fathom.homeNodeLoadingHint','正在读取记忆脉络与潮汐记录。')};
  failure=failure||{};var kind=failure.failureKind||'request',status=Number(failure.httpStatus)||0,vars={status:status||'—'};
  if(kind==='authorization')return{title:copy('memory.fathom.homeNodeAuthFailed','Home Node 拒绝访问（HTTP {status}）',vars),detail:copy('memory.fathom.homeNodeNotRead','本次记录未读取，状态未知。')};
  if(kind==='not-ready')return{title:copy('memory.fathom.homeNodeNotReady','Home Node 暂不可用（HTTP {status}）',vars),detail:copy('memory.fathom.homeNodeNotRead','本次记录未读取，状态未知。')};
  if(kind==='unsupported')return{title:copy('memory.fathom.homeNodeUnsupported','Home Node 未提供此读取（HTTP {status}）',vars),detail:copy('memory.fathom.homeNodeNotRead','本次记录未读取，状态未知。')};
  if(kind==='unreachable')return{title:copy('memory.fathom.homeNodeUnreachable','无法连接 Home Node'),detail:copy('memory.fathom.homeNodeNotRead','本次记录未读取，状态未知。')};
  if(kind==='timeout')return{title:copy('memory.fathom.homeNodeTimeout','等待 Home Node 响应超时'),detail:copy('memory.fathom.homeNodeNotRead','本次记录未读取，状态未知。')};
  if(kind==='scope')return{title:copy('memory.fathom.homeNodeScopeFailed','无法确定当前记忆角色'),detail:copy('memory.fathom.homeNodeNotRead','本次记录未读取，状态未知。')};
  return{title:status?copy('memory.fathom.homeNodeRequestFailed','Home Node 读取失败（HTTP {status}）',vars):copy('memory.fathom.homeNodeRequestFailedNoStatus','Home Node 读取失败'),detail:copy('memory.fathom.homeNodeNotRead','本次记录未读取，状态未知。')};
}
function renderFathomState(failure,loading){
  var message=fathomStatusCopy(failure,loading),box=$('sx-mp-box'),low=$('sx-low'),list=$('fm-list'),grid=list&&list.parentNode,detail=$('sx-det');
  if(box){box.classList.add('sx-ref-empty');box.style.height='180px';box.innerHTML=emptyHTML(message.title,message.detail)}
  if(low)low.classList.add('sx-empty');
  if(detail)detail.innerHTML='<div class="sx-low-h sx-dt-head"><h3 class="sx-dt-title">'+safeHtml(message.title)+'</h3></div><div class="sx-dt-body"><p class="sx-hint">'+safeHtml(message.detail)+'</p></div>';
  if(list){list.classList.add('is-empty');if(grid)grid.classList.add('fm-none');list.innerHTML='<div class="fm-card fm-nonec"><div class="fm-h">'+safeHtml(message.title)+'</div><p class="fm-hint">'+safeHtml(message.detail)+'</p></div>'}
  ['fm-rc-ln','fm-rc-old','fm-rc-miss','fm-rc-wlog'].forEach(function(id){var el=$(id);if(el)el.innerHTML='<div class="fm-h">'+safeHtml(copy('memory.fathom.notRead','未读取'))+'</div><p class="fm-hint">'+safeHtml(message.title)+'</p>'});
  ['fm-eval-body','fm-tidy-body'].forEach(function(id){var el=$(id);if(el)el.innerHTML='<p class="fm-hint">'+safeHtml(message.title)+'</p><p class="fm-hint">'+safeHtml(message.detail)+'</p>'});
}
function renderFathom(){
  var adapter=NS.memoryReferenceAdapter;if(!adapter)return;syncFathomFilter();var seq=++FATHOM.seq,page=$('mem-view-fathom');FATHOM.snapshot=null;FATHOM.failure=null;FATHOM.benchmark=null;if(page)page.setAttribute('data-data-state','loading');renderFathomState(null,true);
  function finishFailure(failure){if(seq!==FATHOM.seq)return;FATHOM.failure=failure||{failureKind:'request'};FATHOM.snapshot=null;var state=FATHOM.failure.failureKind==='not-ready'?'not-ready':'error';if(page)page.setAttribute('data-data-state',state);renderFathomState(FATHOM.failure,false)}
  try{Promise.resolve(adapter.readFathom()).then(function(snapshot){if(seq!==FATHOM.seq)return;FATHOM.snapshot=snapshot&&snapshot.status==='ok'?snapshot:null;
    if(FATHOM.snapshot){FATHOM.failure=null;var hasEntries=(FATHOM.snapshot.records||[]).length||(FATHOM.snapshot.recalls||[]).length||(FATHOM.snapshot.timeline||[]).length;if(page)page.setAttribute('data-data-state',hasEntries?'available':'empty');if(FATHOM.selectedRecall&&!(FATHOM.snapshot.recalls||[]).some(function(event){return String(event.id)===FATHOM.selectedRecall}))FATHOM.selectedRecall='';paintFathom();return}
    finishFailure(snapshot);
  },function(){finishFailure({failureKind:'unreachable'})})}catch(e){finishFailure({failureKind:'request'})}
}
function setMapMode(mode){var seg=$('sx-seg');if(!seg)return;mode=mode==='time'?'time':'order';FATHOM.mode=mode;seg.setAttribute('data-v',mode);seg.querySelectorAll('button[data-sx="mode"]').forEach(function(b){var on=b.getAttribute('data-v')===mode;b.classList.toggle('sx-on',on);b.setAttribute('aria-pressed',on?'true':'false')});paintFathom()}
function runBenchmark(){var adapter=NS.memoryReferenceAdapter,query=$('fm-benchmark-query'),expected=$('fm-benchmark-expected'),none=document.querySelector('[data-bm-none]'),button=document.querySelector('[data-act="benchmark-run"]');if(!adapter||!query||!expected)return;var ids=none&&none.checked?[]:Array.from(expected.selectedOptions).map(function(option){return option.value});if(!(none&&none.checked)&&!ids.length){var msg=$('fm-eval-body');if(msg){var old=msg.querySelector('.fm-benchmark-error');if(!old){old=E('p','fm-hint fm-benchmark-error');msg.querySelector('.fm-fathom-form').appendChild(old)}old.textContent=copy('memory.fathom.expectedRequired','请先选择已知预期，或勾选“预期没有记忆浮现”。')}return}if(button)button.disabled=true;FATHOM.benchmark=null;adapter.benchmark(query.value,ids).then(function(result){FATHOM.benchmark=result;paintFathom()},function(){FATHOM.benchmark={ok:false,error:'recall-failed'};paintFathom()})}
function syncFathomFilter(){var filter=$('fm-filter');if(!filter)return;var value=filter.value||'all';filter.disabled=false;filter.setAttribute('aria-disabled','false');filter.innerHTML='<option value="all">'+safeHtml(copy('memory.fathom.filterAll','全部'))+'</option><option value="recall">'+safeHtml(copy('memory.fathom.filterRecall','回望'))+'</option><option value="write">'+safeHtml(copy('memory.fathom.filterWrite','落笔'))+'</option><option value="remove">'+safeHtml(copy('memory.fathom.filterRemove','退潮'))+'</option>';filter.value=value}
function bindFathom(){var box=$('mem-view-fathom');if(!box||box.__memoryRefBound)return;box.__memoryRefBound=true;box.addEventListener('click',function(ev){var target=ev.target&&ev.target.closest?ev.target.closest('[data-sx="mode"]'):null;if(target){setMapMode(target.getAttribute('data-v'));return}target=ev.target&&ev.target.closest?ev.target.closest('[data-act="refresh"]'):null;if(target){renderFathom();return}target=ev.target&&ev.target.closest?ev.target.closest('[data-act="benchmark-run"]'):null;if(target){runBenchmark();return}target=ev.target&&ev.target.closest?ev.target.closest('[data-act="tidy-review"]'):null;if(target){openFathomMemory(target.getAttribute('data-id'));return}target=ev.target&&ev.target.closest?ev.target.closest('[data-fathom-recall]'):null;if(target){selectFathomRecall(target.getAttribute('data-fathom-recall'));return}target=ev.target&&ev.target.closest?ev.target.closest('[data-fathom-open]'):null;if(target){ev.stopPropagation();openFathomMemory(target.getAttribute('data-fathom-open'));return}target=ev.target&&ev.target.closest?ev.target.closest('[data-fathom-memory]'):null;if(target)selectFathomMemory(target.getAttribute('data-fathom-memory'))});
  box.addEventListener('keydown',function(ev){if(ev.key!=='Enter'&&ev.key!==' ')return;var target=ev.target&&ev.target.closest?ev.target.closest('[data-fathom-memory],[data-fathom-recall]'):null;if(!target)return;ev.preventDefault();if(target.hasAttribute('data-fathom-memory'))selectFathomMemory(target.getAttribute('data-fathom-memory'));else selectFathomRecall(target.getAttribute('data-fathom-recall'))});
  var filter=$('fm-filter');if(filter){syncFathomFilter();filter.addEventListener('change',function(){if(FATHOM.snapshot)renderTidebook(FATHOM.snapshot)})}
  var refresh=box.querySelector('[data-act="refresh"]');if(refresh)refresh.disabled=false;
  var find=$('fm-sb-find'),reask=$('fm-sb-reask');[find,reask].forEach(function(button){if(button){button.disabled=true;button.setAttribute('aria-disabled','true')}});
  var random=document.querySelector('#fm-sx [data-sx="rand"]');if(random){random.disabled=true;random.setAttribute('aria-disabled','true')}
}
function placeSharedSkyfold(){
  var fold=$('mem-world-skyfold'),library=$('mem-view-lib'),stats=$('memory-stats-disclosure');if(!library||!fold)return false;
  if(fold.parentNode!==library)library.insertBefore(fold,stats&&stats.parentNode===library?stats:library.firstChild);
  if(fold.getAttribute('data-memory-reference-prepared')!=='true'){fold.open=true;fold.setAttribute('data-memory-reference-prepared','true')}
  return true
}
function placeWorldEntry(){
  var entry=$('mem-world-entry'),slot=$('memory-world-entry-slot');if(!entry||!slot)return false;
  if(entry.parentNode!==slot)slot.appendChild(entry);
  return true
}
function initReference(){
  var page=$('page-memory'),intro=page&&page.querySelector('.module-intro'),seg=$('mem-view-seg'),sw=$('mem-sky-sw'),coast=coastEl();if(!page||!intro||!seg||!coast)return;
  INTRO=intro;TXT={lib:libIntro(),fathom:fathomIntro()};
  seg.addEventListener('click',function(ev){var b=ev.target&&ev.target.closest?ev.target.closest('button[data-v]'):null;if(b)setView(b.getAttribute('data-v'))});
  if(sw)sw.addEventListener('click',function(ev){ev.stopPropagation();var b=ev.target&&ev.target.closest?ev.target.closest('button[data-s]'):null;if(b)setScene(b.getAttribute('data-s'))});
  coast.addEventListener('click',function(ev){ev.stopPropagation();try{coastOpen()}catch(e){clog('全屏没开成：'+String((e&&e.message)||e))}});
  placeSharedSkyfold();placeWorldEntry();placeAuthorityStatus();bindFathom();renderFathom();
  document.addEventListener('ib:locale-changed',function(){TXT.lib=libIntro();TXT.fathom=fathomIntro();paintIntro(false);applyScene();if(VIEW==='fathom')renderFathom()});
  try{new MutationObserver(function(){placeSharedSkyfold();placeWorldEntry()}).observe(page,{childList:true,subtree:true})}catch(e){}
  var active=pageOn();try{new MutationObserver(function(){var next=pageOn();if(next!==active){active=next;if(next&&scene()==='coast')coastPrep();coastSync()}}).observe(page,{attributes:true,attributeFilter:['class','style']})}catch(e){}
  document.addEventListener('visibilitychange',coastSync);window.addEventListener('focus',coastSync);window.addEventListener('pageshow',coastSync);
  var sky=$('mem-sky');try{if(sky&&'IntersectionObserver'in window)new IntersectionObserver(function(es){var z=es[es.length-1];CO.inview=!!(z&&z.isIntersecting);coastSync()},{threshold:0.05}).observe(sky)}catch(e){}
  try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var old=String(ms[i].oldValue||'');if(/\btheme-infernal\b/.test(old)!==document.body.classList.contains('theme-infernal')){onTheme();return}}}).observe(document.body,{attributes:true,attributeFilter:['class'],attributeOldValue:true})}catch(e){}
  ['pointermove','pointerdown','keydown','wheel','touchstart'].forEach(function(ev){window.addEventListener(ev,bump,{passive:true,capture:true})});setInterval(idleTick,15000);
  applyScene();coastSync();
}
var API={version:'memory-reference-ui-1.0.0',mounted:false,state:function(){return{view:VIEW,scene:scene(),full:!!CO.ov,mini:!!CO.mini,count:CO.n}},setView:setView,setScene:setScene,refresh:renderFathom};
if(NS&&typeof NS.expose==='function')NS.expose('memoryReferenceUI',API);else NS.memoryReferenceUI=API;
function mountReferenceUI(){initReference();API.mounted=!!INTRO;if(NS&&NS.memoryReferenceUI)NS.memoryReferenceUI.mounted=API.mounted}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountReferenceUI);else mountReferenceUI();
})(window.IB||(window.IB={}));
