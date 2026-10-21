
(function(){
'use strict';
if(!window.IBMap){try{console.warn('[IBTrc] IBMap missing')}catch(e){}return}
var KEY='map_me',PERM_KEY='map_trace_permissions',MAXN=2000,TRD=null,PERM=null,HERO=null,SHOWN=false,PMI=0,CKS=null,ED=null,AD=null,SR='trip',SPX=false,SITEMS=null,SPOSTS=null,FILLING=false,NF={},HNF={},FEEDC=null,FEEDT=0,RQ=0,_pendLink=null;
function $(x){return document.getElementById(x)}
function M(){return window.IBMap}
function T(){return (window.IBMap&&window.IBMap._t)||{}}
function cfgName(c){try{return M().roleName(c)}catch(e){return String(c&&(c.nickname||c.model||c.id)||'TA')}}
function openSheet(id){try{if(window._ibMapOpenSheet)window._ibMapOpenSheet(id)}catch(e){}}
function closeSheets(){try{if(window._ibMapCloseSheets)window._ibMapCloseSheets()}catch(e){}}
function p2(n){return (n<10?'0':'')+n}
function E(s){return esc(String(s==null?'':s))}
function uniq(v,i,a){return !!v&&a.indexOf(v)===i}
function day0(t){var d=new Date(t);d.setHours(0,0,0,0);return d.getTime()}
function hm(t){var d=new Date(t);return p2(d.getHours())+':'+p2(d.getMinutes())}
function md(t){var d=new Date(t);return p2(d.getMonth()+1)+'.'+p2(d.getDate())}
function dlong(t){var d=new Date(t),y=d.getFullYear()!==new Date().getFullYear();return (y?(d.getFullYear()+' 年 '):'')+(d.getMonth()+1)+' 月 '+d.getDate()+' 日'}
function when(t,dOnly){var n=Date.now(),t0=day0(n);if(t>=t0)return dOnly?'今天':('今天 '+hm(t));if(t>=t0-864e5)return dOnly?'昨天':('昨天 '+hm(t));return dlong(t)+(dOnly?'':(' '+hm(t)))}
function cn(c){return /^(中国|中國|中华人民共和国|china|prc)/i.test(String(c||''))}
function cityOf(x){var c=String((x&&x.city)||'');return (c.length>2&&/市$/.test(c))?c.slice(0,-1):c}
function coOf(x){var c=String((x&&x.country)||'');if(!c)return (x&&x.city)?'中国':'';return cn(c)?'中国':c.split(/[;；\/／]/)[0].trim()}
function wn(n){n=String(n||'');return (/^[A-Za-z0-9]/.test(n)?' ':'')+n}
var PREC=[['door','门牌'],['block','街区'],['city','城市']],HOMEV=[['city','城市'],['sub','区'],['none','不给']];

/* ── 图标 ── */
var IC9={
  pin:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  route:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 19.5c2.6-.6 4.2-2.7 6.6-3.6 2.2-.8 4.3.4 6.4-1.4" stroke-dasharray="1.4 2.6"/><path d="M17.2 3.6a3.3 3.3 0 0 1 3.3 3.3c0 2.5-3.3 5.5-3.3 5.5s-3.3-3-3.3-5.5a3.3 3.3 0 0 1 3.3-3.3z"/><circle cx="17.2" cy="6.9" r="1"/><circle cx="3.6" cy="19.4" r="1.3"/></svg>',
  home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5L12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/><path d="M10.5 19v-4.5h3V19"/></svg>',
  pen:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h3.8L19 8.8a2.7 2.7 0 0 0-3.8-3.8L4.5 15.7z"/><path d="M13.6 6.6l3.8 3.8"/></svg>',
  plus:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  set:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h9M17.5 7.5H20M4 16.5h3M11.5 16.5H20"/><circle cx="15.2" cy="7.5" r="2.2"/><circle cx="9.3" cy="16.5" r="2.2"/></svg>',
  globe:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a11.6 11.6 0 0 0 0 16a11.6 11.6 0 0 0 0-16"/><path d="M4 12h16"/></svg>',
  lock:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>'
};
function pmark(city,en,date,time){var id='trpm'+(++PMI);return '<svg viewBox="0 0 120 120" aria-hidden="true"><defs><path id="'+id+'a" d="M21 60a39 39 0 0 1 78 0"/><path id="'+id+'b" d="M25 60a35 35 0 0 0 70 0"/></defs><g fill="none" stroke="currentColor"><circle cx="60" cy="60" r="51" stroke-width="1.1" stroke-dasharray="2.2 3"/><circle cx="60" cy="60" r="45" stroke-width=".9"/><circle cx="60" cy="60" r="27" stroke-width=".8"/><path d="M-4 47q7-5 14 0t14 0M-4 60q7-5 14 0t14 0M-4 73q7-5 14 0t14 0" stroke-width=".9" opacity=".7"/></g><text font-family="Raleway,sans-serif" font-size="8.4" letter-spacing="2.6" fill="currentColor" stroke="none"><textPath href="#'+id+'a" startOffset="50%" text-anchor="middle">'+E(en)+'</textPath></text><text font-family="\'Noto Sans SC\',sans-serif" font-size="9" letter-spacing="3.2" fill="currentColor" stroke="none"><textPath href="#'+id+'b" startOffset="50%" text-anchor="middle">'+E(city)+'</textPath></text><text x="60" y="61" text-anchor="middle" font-family="\'Cormorant Garamond\',serif" font-weight="600" font-size="17" fill="currentColor" stroke="none">'+E(date)+'</text><text x="60" y="75" text-anchor="middle" font-family="\'Cormorant Garamond\',serif" font-size="11" fill="currentColor" stroke="none" opacity=".85">'+E(time)+'</text></svg>'}

/* ── 数据：读到库才缓存，没读到不写库 ── */
async function load(){if(TRD)return TRD;var r=null,ok=false;try{r=await dbGet('apiSettings',KEY);ok=true}catch(e){}
  var d=(r&&Array.isArray(r.pts))?r:{id:KEY,v:1,pts:[]};d.id=KEY;d.set=Object.assign({prec:'block',home:'city'},d.set||{});d.pts.sort(function(a,b){return b.t-a.t});if(ok)TRD=d;return d}
async function save(){if(!TRD)return false;TRD.pts.sort(function(a,b){return b.t-a.t});if(TRD.pts.length>MAXN)TRD.pts.length=MAXN;try{await dbPut('apiSettings',TRD);return true}catch(e){return false}}
async function loadPermissions(){if(PERM)return PERM;var r=null;try{r=await dbGet('apiSettings',PERM_KEY)}catch(e){}PERM={};if(r&&r.permissions&&typeof r.permissions==='object')Object.keys(r.permissions).forEach(function(id){if(r.permissions[id]===true)PERM[id]=true});return PERM}
function can(id){try{return !!(PERM&&PERM[String(id||'')]===true)}catch(e){return false}}
async function setCan(id,v){await loadPermissions();var key=String(id||'');if(!key)return false;if(v)PERM[key]=true;else delete PERM[key];try{await dbPut('apiSettings',{id:PERM_KEY,permissions:PERM,updatedAt:Date.now()});return true}catch(e){return false}}
function visibleToRole(row,id){return !Array.isArray(row&&row.visTo)||row.visTo.length===0||row.visTo.indexOf(String(id||''))>=0}
function tas(){try{return M().roleConfigs().filter(function(c){return c&&!c._group&&String(c.id||'').indexOf('group_')!==0})}catch(e){return []}}
function curCfg9(){try{return M().chatConfig()}catch(e){return null}}
function ava(el){if(!el)return;try{M().setAvatar(el,'',meName())}catch(e){try{el.textContent='我'}catch(x){}}}

/* ── 给 TA 看到的写法：门牌＝地点名加路名，街区＝街道或区，城市＝只到城市；坐标从来不给 ── */
function seen(x,lv){if(!x)return '';lv=lv||x.prec||'block';var c=cityOf(x),fo=(x.country&&!cn(x.country))?coOf(x):'',a=[];if(fo)a.push(fo);
  if(lv==='city'){a.push(c||x.sub||x.name||'');return a.filter(uniq).join(' · ')}
  if(c)a.push(c);
  if(lv==='block'){var s=x.sub||x.road||'';if(s)a.push(s);else if(!c)a.push(x.name||'');return a.filter(uniq).join(' · ')}
  var nm=String(x.name||'');if(nm)a.push(nm);var rd=(x.road&&nm.indexOf(x.road)<0&&x.road!==c)?(x.road+(x.hn?(' '+x.hn):'')):'';return a.filter(uniq).join(' · ')+(rd?('（'+rd+'）'):'')}
function homeSeen(h,mode){if(!h||mode==='none')return '';var c=cityOf(h)||h.sub||'';return mode==='sub'?[c,h.sub].filter(uniq).join(' · '):c}
function homeName(h){return [cityOf(h),h.sub].filter(uniq).join(' ')}

/* ── 分趟：同一座城市、前后不超过 4 天算一趟 ── */
function groups(L){var G=[];L.forEach(function(x){var g=G[G.length-1],c=cityOf(x)||'';if(g&&g.c===c&&(g.items[g.items.length-1].t-x.t)<4*864e5)g.items.push(x);else G.push({c:c,co:(x.country&&!cn(x.country))?coOf(x):'',items:[x]})});return G}
function rng(items){var a=items[items.length-1].t,b=items[0].t,A=new Date(a),B=new Date(b),yy=A.getFullYear()!==new Date().getFullYear()?(A.getFullYear()+' 年 '):'';
  if(A.toDateString()===B.toDateString())return yy+(A.getMonth()+1)+' 月 '+A.getDate()+' 日';
  if(A.getMonth()===B.getMonth()&&A.getFullYear()===B.getFullYear())return yy+(A.getMonth()+1)+' 月 '+A.getDate()+'–'+B.getDate()+' 日';
  return yy+(A.getMonth()+1)+' 月 '+A.getDate()+' 日 – '+(B.getMonth()+1)+' 月 '+B.getDate()+' 日'}

/* ── 行迹页 ── */
var SKEL='<div class="trc-gw"><div class="trc-gl" id="trc-gl"><canvas></canvas><div class="mp-marks"></div></div><button type="button" class="trc-gtap" data-a="map" aria-label="在地图上看我的行迹"></button><button type="button" class="trc-gopen mp-g glass" data-a="map">'+IC9.globe+'在地图上看</button><div class="trc-now mp-g glass" id="trc-now"></div></div>'
  +'<div class="trc-pair" id="trc-pair"></div>'
  +'<div class="trc-acts"><div class="trc-st" id="trc-st"></div><div class="trc-btns"><button type="button" class="trc-pill mp-g glass" data-a="add" aria-label="补一个去过的地方">'+IC9.plus+'<span class="l">补一个去过的地方</span><span class="s">补记</span></button><button type="button" class="trc-pill mp-g glass" data-a="set" aria-label="设置">'+IC9.set+'<span class="t">设置</span></button></div></div>'
  +'<div class="trc-list" id="trc-list"></div>';
var EMPTY='<div class="mp-je trc-je"><svg viewBox="0 0 200 120" aria-hidden="true"><path class="r" d="M24 98c30-6 46-30 74-38s46 8 66-12"/><path d="M164 18a13 13 0 0 1 13 13c0 10-13 21-13 21s-13-11-13-21a13 13 0 0 1 13-13z"/><circle cx="164" cy="31" r="3.6"/><circle class="p" cx="24" cy="98" r="4"/></svg><b>还没有行迹</b><span>点「打卡定位」记下你现在在哪。以前在聊天里发过的位置，可以在「设置」里导入。</span></div>';
function meName(){try{var n=String((window._ibAbout&&window._ibAbout.name)||(document.getElementById('nav-user-name')||{}).textContent||'').trim();return n||'我'}catch(e){return '我'}}
function statsHtml(L){var ci={},co={};L.forEach(function(x){var c=cityOf(x);if(c)ci[c]=1;var o=coOf(x);if(o)co[o]=1});var n=meName(),nm='<span class="who'+(/[A-Za-z0-9]$/.test(n)?' lat':'')+'">'+E(n)+'</span>';/* v327-p：「名字 去过 几座城市 几个国家与地区」；一处都没有时不摆三个 0 */
  if(!L.length)return '<span class="lead">'+nm+'去过的地方会记在这里</span>';
  return '<span class="lead">'+nm+'去过</span><span><b>'+Object.keys(ci).length+'</b>座城市</span><span><b>'+Object.keys(co).length+'</b>个国家与地区</span>'}
function nowHtml(L,h){var km=T().kmTo;if(!L.length)return h?('<span>家 <b>'+E(homeName(h)||'已设好')+'</b></span><span class="n2">还没有行迹</span>'):'<span>还没有行迹，点下面的「打卡定位」</span>';
  var x=L[0],fr=Date.now()-x.t<3*864e5,lab=(fr?'现在 ':('最近 '+md(x.t)+' '))+'<b>'+E([cityOf(x),x.name].filter(uniq).join(' · ')||seen(x,'block'))+'</b>',r='';
  if(h&&km){var k=km(+h.lat,+h.lon,x.lat,x.lon);if(k<=30)r='在家附近';else{var i=0,st=x.t,pt=x.t;while(i<L.length&&km(+h.lat,+h.lon,L[i].lat,L[i].lon)>30&&pt-L[i].t<4*864e5){st=L[i].t;pt=L[i].t;i++}/* 中间隔了 4 天以上的不算同一趟 */var dd=Math.floor((day0(Date.now())-day0(st))/864e5)+1;r='离家 <b>'+Math.round(k)+'</b> 公里'+(fr?(' · 出门第 <b>'+dd+'</b> 天'):'')}}
  return '<span>'+lab+'</span>'+(r?('<span class="n2">'+r+'</span>'):'')}
function pairHtml(h,set){var hs=!h?'':(set.home==='none'?'不给 TA 看':(homeSeen(h,set.home)||'地名还没查到'));
  return '<button type="button" class="trc-ck" data-a="ck"><i>'+IC9.pin+'</i><span><b>打卡定位</b><em>定位，选一个最贴近的地点，写一句</em></span><span class="trc-pmw">'+pmark('行迹','TRACES',md(Date.now()),hm(Date.now()))+'</span></button>'
    +'<div class="trc-hm"><span class="trc-hi">'+IC9.home+'</span><div class="trc-hmm"><div class="t">家 · '+E(h?(homeName(h)||'已设好'):'还没设')+'</div><div class="s">'+E(h?((h.addr?(h.addr+' · '):'')+'TA 看到：'+hs):'设好以后，这里会算出离家多远、出门第几天')+'</div></div><button type="button" class="trc-ib" data-a="home" aria-label="改家的位置">'+IC9.pen+'</button></div>'}
function entHtml(x){var tg=[];if(x.me)tg.push('<span class="trc-tag">'+IC9.lock+'只我自己看</span>');if(x.src==='add')tg.push('<span class="trc-tag">补记</span>');if(x.src==='loc')tg.push('<span class="trc-tag">聊天里发过的位置</span>');if(x.src==='chat')tg.push('<span class="trc-tag">发给过 TA</span>');
  return '<article class="trc-ent'+(x.me?' me':'')+'" data-id="'+E(x.id)+'"><div class="r1"><span class="pn">'+E(x.name||seen(x,'block')||'某处')+'</span><span class="tm">'+md(x.t)+(x.dOnly?'':(' '+hm(x.t)))+'</span><button type="button" class="trc-ib" data-a="ed" data-id="'+E(x.id)+'" aria-label="改这一处">'+IC9.pen+'</button></div>'
    +'<div class="r2"><span>'+(x.me?E(x.sub||x.road||''):('TA 看到：'+E(seen(x)||'—')))+'</span><span>'+E(x.wx||'')+'</span></div>'+(x.note?('<p class="nt">'+E(x.note)+'</p>'):'')+(tg.length?('<div class="trc-tags">'+tg.join('')+'</div>'):'')+'</article>'}
function listHtml(L){return groups(L).map(function(g){return '<section class="trc-grp"><div class="trc-gh"><h4>'+E(g.c||'地名还没查到')+(g.co?('<small>'+E(g.co)+'</small>'):'')+'</h4><span>'+E(rng(g.items))+' · '+g.items.length+' 处</span></div><div class="trc-tl">'+g.items.map(entHtml).join('')+'</div></section>'}).join('')}
function pinNode(x,hero){var n=document.createElement('div');n.className='mp-pin mp-mepin';var a=document.createElement('span');n.appendChild(a);ava(a);if(!hero){n.title=x.name||'';n.addEventListener('click',function(e){e.stopPropagation();focus(x.id)})}return n}
function heroOf(){var el=$('trc-gl');if(!el)return null;if(HERO&&HERO.el===el)return HERO;try{var G=T().Globe;HERO=new G(el);HERO.spin=false;HERO.touched=true;HERO.k=1.6;HERO.live=function(){return SHOWN&&!document.hidden};var G0=T().glob?T().glob():null;if(G0&&G0.tint)HERO.tint=G0.tint}catch(e){HERO=null}return HERO}
function heroDraw(L,h,C){var G=heroOf();if(!G)return;G.style=(C&&C.gstyle)||'frost';var mk=[],ln=[],A=L.slice(0,120).reverse();
  if(h){var hn=document.createElement('div');hn.className='mp-home';hn.textContent='⌂';mk.push({lat:+h.lat,lon:+h.lon,node:hn})}
  L.slice(0,60).forEach(function(x){mk.push({lat:x.lat,lon:x.lon,node:pinNode(x,true)})});
  for(var i=1;i<A.length;i++){var s=[{lat:A[i-1].lat,lon:A[i-1].lon},{lat:A[i].lat,lon:A[i].lon}];s.s=1;ln.push(s)}
  var c=L[0]||h;if(c)G.rot={lon:+c.lon,lat:Math.max(-55,Math.min(55,+c.lat))};try{G.setMarks(mk,ln)}catch(e){}}
async function render(){var box=$('mp-traces');if(!box)return;var my=++RQ,d=await load(),C=null;try{C=await T().cfgSet()}catch(e){}if(my!==RQ)return;
  var h=(C&&C.home&&isFinite(+C.home.lat))?C.home:null,L=d.pts;
  if(!box._sk){box._sk=1;box.innerHTML=SKEL;box.addEventListener('click',onClick)}
  $('trc-st').innerHTML=statsHtml(L);$('trc-now').innerHTML=nowHtml(L,h);$('trc-pair').innerHTML=pairHtml(h,d.set);$('trc-list').innerHTML=L.length?listHtml(L):EMPTY;
  if(SHOWN)heroDraw(L,h,C);
  if(h&&!h.city&&!HNF[h.lat+','+h.lon]){HNF[h.lat+','+h.lon]=1;homeFill(h)}
  if(!FILLING&&L.some(function(x){return !x.city&&!NF[x.id]}))fill()}
function onClick(e){var b=e.target.closest('[data-a]');if(!b)return;var a=b.getAttribute('data-a');
  if(a==='ck')ckOpen('page');else if(a==='add')addOpen();else if(a==='set')setOpen();else if(a==='home')homeOpen();else if(a==='ed')edOpen(b.getAttribute('data-id'));else if(a==='map')toMap()}
function toMap(){try{M().setSel('me');M().gotoTab('map')}catch(e){}}
function show(){SHOWN=true;render().catch(function(e){try{console.error('[IBTrc]',e)}catch(x){}})}
function hide(){SHOWN=false;if(HERO){try{HERO.release()}catch(e){}}}
function focus(id){try{M().gotoTab('traces')}catch(e){}var n=0,go=function(){var el=document.querySelector('#mp-traces [data-id="'+String(id).replace(/"/g,'')+'"]');if(el&&el.offsetParent){try{el.scrollIntoView({block:'center',behavior:document.body.classList.contains('ib-reduce')?'auto':'smooth'})}catch(e){}el.classList.remove('fresh');void el.offsetWidth;el.classList.add('fresh');return}if(++n<12)setTimeout(go,120)};setTimeout(go,80)}
async function marks(){var d=await load(),L=d.pts.slice(0,300),out=[],ln=[],A=L.slice().reverse();
  L.forEach(function(x){out.push({lat:x.lat,lon:x.lon,node:pinNode(x,false),me:x})});
  for(var i=1;i<A.length;i++){var s=[{lat:A[i-1].lat,lon:A[i-1].lon},{lat:A[i].lat,lon:A[i].lon}];s.s=1;ln.push(s)}
  return{marks:out,lines:ln,n:d.pts.length}}
async function homeFill(h){try{var R=await M().reverse(+h.lat,+h.lon);if(R&&(R.city||R.sub)){h.city=R.city||'';h.sub=R.sub||'';h.country=R.country||'';h.addr=[R.road?(R.road+(R.hn?(' '+R.hn):'')):'',R.sub,R.city].filter(uniq).join(' · ');await M().saveCfg();if(SHOWN)render()}}catch(e){}}
async function fill(){if(FILLING)return;FILLING=true;var n=0;try{var d=await load();for(var i=0;i<d.pts.length&&n<20;i++){var x=d.pts[i];if(x.city||NF[x.id])continue;n++;var R=null;try{R=await M().reverse(x.lat,x.lon)}catch(e){}if(R&&(R.city||R.sub)){x.city=R.city||'';x.sub=x.sub||R.sub||'';x.road=x.road||R.road||'';x.country=R.country||''}else NF[x.id]=1}if(n)await save()}catch(e){}finally{FILLING=false}if(n&&SHOWN)render()}

/* ── 弹层 ── */
function chips(id,v,list){var el=$(id);if(!el)return;el.innerHTML=(list||PREC).map(function(q){return '<button type="button" class="chip'+(q[0]===v?' on':'')+'" data-v="'+q[0]+'">'+q[1]+'</button>'}).join('')}
function swOn(el,v){if(!el)return;el.classList.toggle('on',!!v);el.setAttribute('aria-checked',v?'true':'false')}
var TA9='<div class="f-group trc-fg"><textarea id="%ID%" rows="2" maxlength="200" placeholder="写一句（可空）"></textarea></div>';
var SHEETS_HTML='<div class="sheet trc-sheet" id="sheet-trc-ck">'
  +'<div data-st="loc" class="trc-loc"><span class="trc-radar"><i></i></span><span id="trck-lt">在定位…</span></div>'
  +'<div data-st="fail" hidden><h4 class="trc-sh-t">没定到位</h4><p class="trc-sh-s" id="trck-ft"></p><div class="sheet-btns"><button type="button" class="btn" id="trck-x">算了</button><button type="button" class="btn primary" id="trck-re">再试一次</button></div></div>'
  +'<div data-st="pick" hidden><h4 class="trc-sh-t">在这儿打个卡</h4><p class="trc-sh-s" id="trck-at"></p><div class="trc-picks" id="trck-picks"></div>'
  +'<div class="trc-row"><span>给 TA 看到</span><div class="mp-chips" id="trck-prec"></div></div><p class="trc-seen" id="trck-seen"></p>'+TA9.replace('%ID%','trck-note')
  +'<div class="trc-row" id="trck-mer"><span>只我自己看</span><div class="sw2" id="trck-me" role="switch" aria-checked="false" tabindex="0"></div></div>'
  +'<p class="trc-auto" id="trck-auto"></p><button type="button" class="btn wide primary" id="trck-ok">记下这一处</button></div>'
  +'<div data-st="done" hidden><div class="trc-pmark" id="trck-pm"></div><h4 class="trc-sh-t c">记下了</h4><p class="trc-sh-s c" id="trck-ds"></p><button type="button" class="btn wide primary" id="trck-done">好</button></div></div>'
  +'<div class="sheet trc-sheet" id="sheet-trc-add"><h4 class="trc-sh-t">补一个去过的地方</h4><p class="trc-sh-s">搜地名，或者在地图上点一下。</p>'
  +'<div class="trc-srch"><input id="tra-q" maxlength="60" placeholder="地名，比如：平江路" enterkeyhint="search" autocomplete="off"><button type="button" class="btn mini" id="tra-go">搜</button></div>'
  +'<div class="trc-picks" id="tra-res"></div><button type="button" class="trc-lnk" id="tra-map">在地图上点一下</button>'
  +'<div class="trc-row"><span>哪天去的</span><input type="date" id="tra-d" class="trc-date"></div>'
  +'<div class="trc-row"><span>给 TA 看到</span><div class="mp-chips" id="tra-prec"></div></div><p class="trc-seen" id="tra-seen"></p>'+TA9.replace('%ID%','tra-note')
  +'<div class="trc-row"><span>只我自己看</span><div class="sw2" id="tra-me" role="switch" aria-checked="false" tabindex="0"></div></div>'
  +'<button type="button" class="btn wide primary" id="tra-ok" disabled>记下这一处</button></div>'
  +'<div class="sheet trc-sheet" id="sheet-trc-ed"><h4 class="trc-sh-t" id="tre-t"></h4><p class="trc-sh-s" id="tre-s"></p>'
  +'<div class="trc-row"><span>给 TA 看到</span><div class="mp-chips" id="tre-prec"></div></div><p class="trc-seen" id="tre-seen"></p>'+TA9.replace('%ID%','tre-note').replace('rows="2"','rows="3"')
  +'<div class="trc-row"><span>只我自己看</span><div class="sw2" id="tre-me" role="switch" aria-checked="false" tabindex="0"></div></div>'
  +'<div class="sheet-btns"><button type="button" class="btn danger" id="tre-del">删掉</button><button type="button" class="btn primary" id="tre-ok">保存</button></div></div>'
  +'<div class="sheet trc-sheet" id="sheet-trc-home"><h4 class="trc-sh-t">家</h4><p class="trc-sh-s" id="trh-s"></p>'
  +'<div class="sheet-btns"><button type="button" class="btn" id="trh-here">用现在的位置</button><button type="button" class="btn" id="trh-map">在地图上点</button></div><button type="button" class="btn wide trc-x2" id="trh-x">清掉</button></div>'
  +'<div class="sheet trc-sheet trc-set" id="sheet-trc-set">'
  +'<div class="tog trs-h"><div class="tog-m"><div class="tog-t">谁能查我的行迹</div><div class="tog-s">开着的 TA 想知道你最近去了哪时会自己查，只在那一轮看得到；标了「只我自己看」的不给。</div></div></div>'
  +'<div class="trs-who" id="trs-who"></div>'
  +'<div class="f-group"><label>打卡时默认给 TA 看到 <span class="lb-note">（每次打卡时还能改）</span></label><div class="sel"><select id="trs-prec" aria-label="打卡时默认给 TA 看到"></select></div></div>'
  +'<div class="f-group"><label>家给 TA 看到 <span class="lb-note" id="trs-hex"></span></label><div class="sel"><select id="trs-home" aria-label="家给 TA 看到"></select></div></div>'
  +'<div class="f-group"><label>聊天里发过的位置 <span class="lb-note" id="trs-impn"></span></label><button type="button" class="btn" id="trs-imp">导入到行迹</button></div>'
  +'<button type="button" class="btn wide primary" id="trs-ok">保存设置</button></div>'
  +'<div class="sheet trc-sheet" id="sheet-trc-pv"><h4 class="trc-sh-t">这条会带给 TA 的内容</h4><pre class="pl-pv" id="trp-t"></pre><div class="sheet-btns"><button type="button" class="btn" id="trp-x">撤回</button><button type="button" class="btn primary" id="trp-ok">知道了</button></div></div>';
function sheets(){if($('sheet-trc-ck'))return;var w=document.createElement('div');w.innerHTML=SHEETS_HTML;while(w.firstChild)document.body.appendChild(w.firstChild);bindSheets()}
function onChip(id,fn){var el=$(id);if(!el)return;el.addEventListener('click',function(e){var b=e.target.closest('.chip');if(!b||!el.contains(b)||b.disabled)return;el.querySelectorAll('.chip').forEach(function(x){x.classList.toggle('on',x===b)});fn(b.getAttribute('data-v'))})}
function onSw(id,fn){var el=$(id);if(!el)return;var t=function(){var v=!el.classList.contains('on');swOn(el,v);fn(v)};el.addEventListener('click',t);el.addEventListener('keydown',function(e){if(e.key===' '||e.key==='Enter'){e.preventDefault();t()}})}
function bindSheets(){
  $('trck-picks').addEventListener('click',function(e){var b=e.target.closest('.trc-pk');if(!b||!CKS)return;CKS.sel=+b.getAttribute('data-i')||0;this.querySelectorAll('.trc-pk').forEach(function(x){x.classList.toggle('on',x===b)});ckSeen()});
  onChip('trck-prec',function(v){if(CKS){CKS.prec=v;ckSeen()}});onSw('trck-me',function(v){if(CKS){CKS.me=v;ckSeen()}});
  $('trck-ok').addEventListener('click',ckSave);$('trck-done').addEventListener('click',function(){var id=CKS&&CKS.id,pg=CKS&&CKS.ctx==='page';closeSheets();if(pg&&id)focus(id)});
  $('trck-x').addEventListener('click',function(){closeSheets()});$('trck-re').addEventListener('click',function(){if(!CKS)return;ckState('loc');$('trck-lt').textContent='在定位…';ckRun(CKS)});
  onChip('tre-prec',function(v){if(ED){ED.prec=v;edSeen()}});onSw('tre-me',function(v){if(ED){ED.me=v;edSeen()}});$('tre-ok').addEventListener('click',edSave);$('tre-del').addEventListener('click',edDel);
  $('tra-go').addEventListener('click',addSearch);$('tra-q').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();addSearch()}});
  $('tra-res').addEventListener('click',function(e){var b=e.target.closest('.trc-pk');if(!b||!AD)return;var c=AD.res[+b.getAttribute('data-i')];if(c)addPick(c)});
  $('tra-map').addEventListener('click',function(){closeSheets();try{M().pickAt('点一下你去过的地方',async function(ll){var R=null;try{R=await M().reverse(ll.lat,ll.lon)}catch(e){}var nm=(R&&(R.poi||R.road||R.sub||R.city))||(ll.lat.toFixed(3)+', '+ll.lon.toFixed(3));try{M().gotoTab('traces')}catch(e){}addOpen({name:nm,lat:+ll.lat,lon:+ll.lon,tag:'地图上点的',R:R})})}catch(e){}});
  onChip('tra-prec',function(v){if(AD){AD.prec=v;addSeen()}});onSw('tra-me',function(v){if(AD){AD.me=v;addSeen()}});$('tra-ok').addEventListener('click',addSave);
  $('trh-here').addEventListener('click',async function(){closeSheets();toast('在定位…');var p=null;try{p=await M().locate()}catch(e){}if(!p){toast('没定到位。检查定位权限，或到室外再试');return}await homeSet(p.lat,p.lon);toast('家定在这儿了')});
  $('trh-map').addEventListener('click',function(){closeSheets();try{M().pickAt('点一下你家在哪',async function(ll){await homeSet(ll.lat,ll.lon);try{M().gotoTab('traces')}catch(e){}toast('家定在这儿了')})}catch(e){}});
  $('trh-x').addEventListener('click',async function(){var ask='清掉家的位置？行迹不受影响。',ok=false;try{ok=typeof confirmDlg==='function'?await confirmDlg(ask,'清掉'):window.confirm(ask)}catch(e){ok=false}if(!ok)return;var C=await T().cfgSet();C.home=null;try{await M().saveCfg()}catch(e){}closeSheets();render();try{M().refresh()}catch(e){}toast('清掉了')});
  $('trs-who').addEventListener('click',function(e){var s=e.target.closest('.sw2');if(!s||!SD)return;var id=s.getAttribute('data-f'),v=!s.classList.contains('on');swOn(s,v);SD.can[id]=v;setEx()});
  $('trs-who').addEventListener('keydown',function(e){if((e.key===' '||e.key==='Enter')&&e.target.classList&&e.target.classList.contains('sw2')){e.preventDefault();e.target.click()}});
  $('trs-prec').addEventListener('change',function(){if(SD)SD.prec=this.value});$('trs-home').addEventListener('change',function(){if(SD){SD.home=this.value;setEx()}});
  $('trs-imp').addEventListener('click',impRun);$('trs-ok').addEventListener('click',setSave);
  $('trp-x').addEventListener('click',function(){_pendLink=null;try{M().clearChatAttachment()}catch(e){}closeSheets();toast('撤回了')});$('trp-ok').addEventListener('click',function(){closeSheets()})}

/* ── 打卡定位 ── */
function ckState(s){var sh=$('sheet-trc-ck');if(!sh)return;sh.querySelectorAll('[data-st]').forEach(function(x){x.hidden=x.getAttribute('data-st')!==s})}
async function ckOpen(ctx){sheets();var d=await load();CKS={ctx:ctx==='chat'?'chat':'page',prec:d.set.prec||'block',me:false,sel:0};$('trck-note').value='';ckState('loc');$('trck-lt').textContent='在定位…';openSheet('sheet-trc-ck');ckRun(CKS)}
async function ckRun(S){var p=null;try{p=await M().locate()}catch(e){}if(S!==CKS)return;if(!p){$('trck-ft').textContent='检查一下定位权限，或者到窗边、室外再试。';ckState('fail');return}
  S.p=p;S.t=Date.now();$('trck-lt').textContent='在找附近的地点…';
  var wxP=Promise.resolve().then(function(){return M().weatherAt(p.lat,p.lon)}).catch(function(){return null}),R=null,C=[];
  try{R=await M().reverse(p.lat,p.lon)}catch(e){}if(S!==CKS)return;S.R=R||{};
  try{C=await nearPois(p.lat,p.lon)}catch(e){C=[]}if(S!==CKS)return;S.cands=cands(C,S.R,p);S.sel=0;
  var w=null;try{w=await Promise.race([wxP,new Promise(function(r){setTimeout(function(){r(null)},6000)})])}catch(e){}if(S!==CKS)return;
  S.wx=(w&&w.txt)?(w.txt+(isFinite(+w.temp)?(' '+Math.round(+w.temp)+'℃'):'')):'';ckPaint();ckState('pick')}
async function nearPois(lat,lon){var t=T();try{if(!(t.inCN&&t.inCN(lat,lon)&&t.amapOn&&await t.amapOn()))return []}catch(e){return []}
  var g=t.wgs2gcj(lat,lon),j=await t.amapGet('place/around',{location:g[1].toFixed(6)+','+g[0].toFixed(6),radius:500,sortrule:'distance',offset:8,page:1,extensions:'base',types:'050000|060000|080000|100000|110000|120000|140000|150000|190000'},true),out=[];
  ((j&&j.pois)||[]).forEach(function(q){var nm=typeof q.name==='string'?q.name:'',lc=typeof q.location==='string'?q.location.split(','):[];if(!nm||lc.length<2)return;var w=t.gcj2wgs(+lc[1],+lc[0]);out.push({name:nm,lat:w[0],lon:w[1],kind:(typeof q.type==='string'?q.type.split(';')[0]:'')||'地点',dist:+q.distance||0})});return out}
function cands(C,R,p){var out=[],sn={};function add(o){if(!o.name||sn[o.name])return;sn[o.name]=1;out.push(o)}
  C.slice(0,6).forEach(function(c){add({name:c.name,lat:c.lat,lon:c.lon,lv:'poi',tag:c.kind+(c.dist?(' · '+Math.round(c.dist)+' 米'):'')})});
  if(R.poi)add({name:R.poi,lat:p.lat,lon:p.lon,lv:'poi',tag:'地点'});
  var rd=(R.road||'')+(R.hn?(' '+R.hn):'');if(rd)add({name:rd,lat:p.lat,lon:p.lon,lv:'road',tag:'街道'});
  if(R.sub)add({name:R.sub,lat:p.lat,lon:p.lon,lv:'sub',tag:'街区'});
  if(R.city)add({name:R.city,lat:p.lat,lon:p.lon,lv:'city',tag:'城市'});
  if(!out.length)add({name:'这里（'+p.lat.toFixed(3)+', '+p.lon.toFixed(3)+'）',lat:p.lat,lon:p.lon,lv:'pt',tag:'没查到地名'});
  return out.slice(0,8)}
function ckDraft(){var S=CKS,c=S.cands[S.sel]||S.cands[0],R=S.R||{};return{name:c.name,lat:c.lat,lon:c.lon,road:R.road||'',hn:R.hn||'',sub:R.sub||'',city:R.city||'',country:R.country||'',prec:S.prec}}
function ckSeen(){var S=CKS;if(!S||!S.cands)return;var me=S.ctx!=='chat'&&S.me;$('trck-seen').innerHTML=me?'只你自己看得到，TA 查不到':('TA 看到：<b>'+E(seen(ckDraft())||'—')+'</b>')}
function ckPaint(){var S=CKS,R=S.R||{},p=S.p;
  $('trck-at').textContent='定位到 '+([cityOf(R),R.sub,R.road].filter(uniq).join(' ')||(p.lat.toFixed(4)+', '+p.lon.toFixed(4)))+(p.acc?('，误差约 '+Math.round(p.acc)+' 米'):'')+'。选一个最贴近的：';
  $('trck-picks').innerHTML=S.cands.map(function(c,i){return '<button type="button" class="trc-pk'+(i===S.sel?' on':'')+'" data-i="'+i+'"><b>'+E(c.name)+'</b><span>'+E(c.tag)+'</span></button>'}).join('');
  chips('trck-prec',S.prec);$('trck-mer').hidden=S.ctx==='chat';swOn($('trck-me'),!!S.me);
  $('trck-auto').textContent='一起记下：'+hm(S.t)+(S.wx?(' · '+S.wx):'');$('trck-ok').textContent=S.ctx==='chat'?'记下并挂到消息上':'记下这一处';ckSeen()}
async function ckSave(){var S=CKS;if(!S||!S.p||!S.cands)return;var d=await load(),x=ckDraft();
  var tr={id:'tr_'+Date.now()+'_'+Math.floor(Math.random()*1e4),t:S.t||Date.now(),lat:+x.lat,lon:+x.lon,acc:Math.round(S.p.acc||0),name:x.name,road:x.road,hn:x.hn,sub:x.sub,city:x.city,country:x.country,prec:S.prec,note:$('trck-note').value.trim().slice(0,200),me:S.ctx!=='chat'&&!!S.me,wx:S.wx||'',src:'ck'};
  d.pts.unshift(tr);if(!(await save())){d.pts=d.pts.filter(function(q){return q!==tr});toast('没存上，再试一次');return}S.id=tr.id;
  var pm=$('trck-pm');pm.innerHTML=pmark(cityOf(tr)||tr.name,'TRACES',md(tr.t),hm(tr.t));pm.classList.remove('hit');void pm.offsetWidth;pm.classList.add('hit');
  $('trck-ds').textContent=[tr.name,cityOf(tr)].filter(uniq).join(' · ')+' · '+dlong(tr.t)+' '+hm(tr.t)+(S.ctx==='chat'?'。已经挂在输入框上面，发消息时一起带上':'');ckState('done');
  if(S.ctx==='chat')attach(cardOne(tr),'我在'+String(seen(tr).split(' · ').pop()||tr.name));
  if(SHOWN)render();try{M().refresh()}catch(e){}}

/* ── 改一处 ── */
async function edOpen(id){var d=await load(),x=d.pts.find(function(q){return q.id===id});if(!x)return;sheets();ED={x:x,prec:x.prec||'block',me:!!x.me};
  $('tre-t').textContent=x.name||seen(x,'block')||'这一处';$('tre-s').textContent=dlong(x.t)+(x.dOnly?'':(' '+hm(x.t)))+(x.wx?(' · '+x.wx):'')+(cityOf(x)?(' · '+[cityOf(x),x.sub].filter(uniq).join(' ')):'');
  chips('tre-prec',ED.prec);$('tre-note').value=x.note||'';swOn($('tre-me'),ED.me);edSeen();openSheet('sheet-trc-ed')}
function edSeen(){if(!ED)return;$('tre-seen').innerHTML=ED.me?'只你自己看得到，TA 查不到':('TA 看到：<b>'+E(seen(Object.assign({},ED.x,{prec:ED.prec}))||'—')+'</b>')}
async function edSave(){if(!ED)return;var x=ED.x;x.prec=ED.prec;x.me=ED.me;x.note=$('tre-note').value.trim().slice(0,200);await save();closeSheets();ED=null;render();try{M().refresh()}catch(e){}toast('改好了')}
async function edDel(){if(!ED)return;var ask='删掉这一处？已经发进聊天的卡片不受影响。',ok=false;try{ok=typeof confirmDlg==='function'?await confirmDlg(ask,'删掉'):window.confirm(ask)}catch(e){ok=false}if(!ok)return;var d=await load(),id=ED.x.id;if(ED.x.imp)d.set.impx=(Array.isArray(d.set.impx)?d.set.impx:[]).concat([ED.x.imp]).slice(-500);/* v327-p：导入后删掉的记一笔，下次导入不再导回来 */d.pts=d.pts.filter(function(q){return q.id!==id});await save();closeSheets();ED=null;render();try{M().refresh()}catch(e){}toast('删掉了')}

/* ── 补记 ── */
async function addOpen(pre){sheets();var d=await load();AD={res:[],prec:d.set.prec||'block',me:false,pt:null};$('tra-q').value='';$('tra-res').innerHTML='';var td=new Date();$('tra-d').value=td.getFullYear()+'-'+p2(td.getMonth()+1)+'-'+p2(td.getDate());$('tra-d').max=$('tra-d').value;$('tra-note').value='';chips('tra-prec',AD.prec);swOn($('tra-me'),false);$('tra-ok').disabled=true;$('tra-seen').textContent='';if(pre){AD.res=[pre];$('tra-res').innerHTML='<button type="button" class="trc-pk on" data-i="0"><b>'+E(pre.name)+'</b><span>'+E(pre.tag||'')+'</span></button>';addPick(pre)}openSheet('sheet-trc-add')}
async function addSearch(){if(!AD)return;var q=$('tra-q').value.trim();if(!q){toast('写一个地名');return}$('tra-res').innerHTML='<p class="trc-sle">在查…</p>';var out=[],t=T();
  try{if(/[\u3400-\u9fff]/.test(q)&&t.amapOn&&await t.amapOn()){var j=await t.amapGet('place/text',{keywords:q,offset:8,page:1,extensions:'base'},true);((j&&j.pois)||[]).forEach(function(p){var lc=typeof p.location==='string'?p.location.split(','):[];if(lc.length<2||typeof p.name!=='string')return;var w=t.gcj2wgs(+lc[1],+lc[0]);out.push({name:p.name,lat:w[0],lon:w[1],tag:[p.cityname,p.adname].filter(function(v){return typeof v==='string'&&v}).join(' ')||'高德'})})}}catch(e){}
  if(out.length<3){try{var r=await t.geoSearch(q,6);(r||[]).forEach(function(x){var nm=String(x.name||x.full||x.display_name||'').split(',')[0].trim(),la=+x.lat,lo=+(x.lon!=null?x.lon:x.lng);if(!nm||!isFinite(la)||!isFinite(lo))return;out.push({name:nm,lat:la,lon:lo,tag:String(x.country||'').slice(0,20)||'OpenStreetMap'})})}catch(e){}}
  if(!AD)return;AD.res=out.slice(0,8);AD.pt=null;$('tra-ok').disabled=true;$('tra-seen').textContent='';
  $('tra-res').innerHTML=AD.res.length?AD.res.map(function(c,i){return '<button type="button" class="trc-pk" data-i="'+i+'"><b>'+E(c.name)+'</b><span>'+E(c.tag)+'</span></button>'}).join(''):'<p class="trc-sle">没查到。换个写法，或者在地图上点一下。</p>'}
function addPick(c){if(!AD)return;AD.pt=c;$('tra-ok').disabled=false;var i=AD.res.indexOf(c);$('tra-res').querySelectorAll('.trc-pk').forEach(function(b){b.classList.toggle('on',+b.getAttribute('data-i')===i)});addSeen()}
function addSeen(){if(!AD||!AD.pt){$('tra-seen').textContent='';return}var R=AD.pt.R||{};$('tra-seen').innerHTML=AD.me?'只你自己看得到，TA 查不到':('TA 看到：<b>'+E(seen({name:AD.pt.name,city:R.city||'',sub:R.sub||'',road:R.road||'',country:R.country||'',prec:AD.prec})||AD.pt.name)+'</b>'+(R.city?'':'（地名记下以后补全）'))}
async function addSave(){if(!AD||!AD.pt)return;var A=AD,c=A.pt,R=c.R||null;$('tra-ok').disabled=true;if(!R){try{R=await M().reverse(c.lat,c.lon)}catch(e){}}R=R||{};
  var dv=$('tra-d').value,tt=Date.now(),dOnly=false;if(/^\d{4}-\d{2}-\d{2}$/.test(dv)){var q=dv.split('-'),dt=new Date(+q[0],+q[1]-1,+q[2],12,0,0);if(dt.getTime()>Date.now()&&dt.toDateString()!==new Date().toDateString()){toast('日期不能晚于今天');$('tra-ok').disabled=false;return}/* v327-p：补记不收将来的日期 */if(dt.toDateString()!==new Date().toDateString()){tt=dt.getTime();dOnly=true}}
  var d=await load(),tr={id:'tr_'+Date.now()+'_a',t:tt,dOnly:dOnly,lat:+c.lat,lon:+c.lon,acc:0,name:String(c.name||'').slice(0,60),road:R.road||'',hn:R.hn||'',sub:R.sub||'',city:R.city||'',country:R.country||'',prec:A.prec,note:$('tra-note').value.trim().slice(0,200),me:!!A.me,wx:'',src:'add'};
  d.pts.push(tr);if(!(await save())){toast('没存上，再试一次');$('tra-ok').disabled=false;return}closeSheets();AD=null;await render();focus(tr.id);try{M().refresh()}catch(e){}toast('补上了')}

/* ── 家 ── */
async function homeOpen(){sheets();var C=await T().cfgSet(),h=C&&C.home;$('trh-s').textContent=h?('现在：'+(h.addr||homeName(h)||(Number(h.lat).toFixed(3)+', '+Number(h.lon).toFixed(3)))+'。你自己看到的是完整地址，给 TA 看到哪一级在「设置」里选。'):'还没设。设好以后能算出离家多远、出门第几天。';$('trh-x').hidden=!h;openSheet('sheet-trc-home')}
async function homeSet(lat,lon){var R=null;try{R=await M().reverse(lat,lon)}catch(e){}R=R||{};var C=await T().cfgSet();C.home={lat:+lat,lon:+lon,city:R.city||'',sub:R.sub||'',country:R.country||'',addr:[R.road?(R.road+(R.hn?(' '+R.hn):'')):'',R.sub,R.city].filter(uniq).join(' · ')};try{await M().saveCfg()}catch(e){}if(SHOWN)render();try{M().refresh()}catch(e){}}

/* ── 设置抽屉 ── */
/* 改动先记在抽屉里（SD），点「保存设置」才写入；直接关掉等于没改 */
var SD=null,PRECS=[['door','门牌（地点名和路名）'],['block','街区（街道或区）'],['city','城市（只到城市）']],HOMES=[['city','城市'],['sub','城市和区'],['none','不给 TA 看']];
function opts(id,v,list){var el=$(id);if(!el)return;el.innerHTML=list.map(function(q){return '<option value="'+q[0]+'">'+q[1]+'</option>'}).join('');el.value=v;if(el.value!==v)el.selectedIndex=0}
function setEx(){if(!SD)return;var h=SD.h;$('trs-hex').textContent=!h?'（还没设家）':(SD.home==='none'?'':('（TA 看到：'+(homeSeen(h,SD.home)||'地名还没查到')+'）'))}
async function setOpen(){sheets();var d=await load(),L=tas(),C=null;try{C=await T().cfgSet()}catch(e){}
  SD={can:{},prec:d.set.prec||'block',home:d.set.home||'city',h:(C&&C.home&&isFinite(+C.home.lat))?C.home:null};L.forEach(function(c){SD.can[c.id]=can(c.id)});
  $('trs-who').innerHTML=L.length?L.map(function(c){var on=SD.can[c.id];return '<div class="tog trs-ta"><div class="tog-m"><span class="trc-wa" data-a="'+E(c.id)+'"></span><div class="tog-t">'+E(cfgName(c))+'</div></div><div class="sw2'+(on?' on':'')+'" data-f="'+E(c.id)+'" role="switch" aria-checked="'+(on?'true':'false')+'" aria-label="'+E(cfgName(c))+' 能查我的行迹" tabindex="0"></div></div>'}).join(''):'<p class="hint trs-none">还没有 TA。</p>';
  $('trs-who').querySelectorAll('[data-a]').forEach(function(a){var c=L.find(function(q){return q.id===a.getAttribute('data-a')});try{M().setAvatar(a,c&&c.avatar||'',cfgName(c))}catch(e){}});
  opts('trs-prec',SD.prec,PRECS);opts('trs-home',SD.home,HOMES);setEx();$('trs-impn').textContent='（在数…）';$('trs-imp').disabled=true;openSheet('sheet-trc-set');impCount()}
async function setSave(){if(!SD)return;var S9=SD,d=await load();for(var id in S9.can){if(can(id)!==S9.can[id])await setCan(id,S9.can[id])}
  if(d.set.prec!==S9.prec||d.set.home!==S9.home){d.set.prec=S9.prec;d.set.home=S9.home;await save()}SD=null;closeSheets();render();toast('存好了')}
async function impList(){var d=await load(),have={},tot=0,left=[];d.pts.forEach(function(x){if(x.imp)have[x.imp]=1});(Array.isArray(d.set.impx)?d.set.impx:[]).forEach(function(k){have[k]=1});var L=tas();for(var i=0;i<L.length;i++){var c=L[i],ls=[];try{ls=await M().loadLocs(c.id)}catch(e){}(ls||[]).forEach(function(l){if(!l||!isFinite(+l.lat))return;tot++;var k=c.id+':'+l.at;if(!have[k]){have[k]=1;left.push({k:k,l:l})}})}return{total:tot,left:left}}
async function impCount(){var n=await impList();if(!$('trs-impn'))return;$('trs-impn').textContent=n.total?(n.left.length?('（发过 '+n.total+' 处，还有 '+n.left.length+' 处没导入）'):('（发过的 '+n.total+' 处都导入过了）')):'（还没用「发送位置」发过）';$('trs-imp').disabled=!n.left.length}
function coarse(l){var f=function(v){var s=String(+v),i=s.indexOf('.');return i<0?0:(s.length-i-1)};return Math.max(f(l.lat),f(l.lon))<=1}
async function impRun(){var n=await impList();if(!n.left.length)return;var d=await load();n.left.forEach(function(q){var l=q.l;d.pts.push({id:'tr_'+l.at+'_l'+Math.floor(Math.random()*1e4),t:+l.at||Date.now(),lat:+l.lat,lon:+l.lon,acc:0,name:String(l.name||'').slice(0,40),road:'',hn:'',sub:'',city:'',country:'',prec:coarse(l)?'city':'block',note:'',me:false,wx:'',src:'loc',imp:q.k})});
  if(!(await save())){toast('没存上，再试一次');return}impCount();render();try{M().refresh()}catch(e){}toast('导入了 '+n.left.length+' 处')}

/* ── 聊天 + 号：Map 分享行迹 ── */
var SHARE_HTML='<div class="pl-scrim" id="trw-scrim" hidden></div><div class="pl-win trw" id="trw" role="dialog" aria-modal="true" aria-labelledby="trw-t" hidden>'
  +'<svg class="pl-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 19.5c2.6-.6 4.2-2.7 6.6-3.6 2.2-.8 4.3.4 6.4-1.4" stroke-dasharray="1.4 2.6"/><path d="M17.2 3.6a3.3 3.3 0 0 1 3.3 3.3c0 2.5-3.3 5.5-3.3 5.5s-3.3-3-3.3-5.5a3.3 3.3 0 0 1 3.3-3.3z"/></svg>'
  +'<button type="button" class="pl-x" id="trw-x" aria-label="关闭">✕</button><div class="pl-lab">Share — 分享</div><h3 class="pl-t" id="trw-t">Map · 分享行迹</h3><div class="pl-s" id="trw-s"></div>'
  +'<div id="trw-1" class="pl-list"><button type="button" class="pl-it" data-k="ck">'+IC9.pin+'<span><b>打卡定位</b><i>记下你现在在哪，挂在下一条消息上</i></span></button><button type="button" class="pl-it" data-k="carry">'+IC9.route+'<span><b>带上最近的行迹</b><i>选一段时间，去过的地方和你写的话一起带上</i></span></button></div>'
  +'<div id="trw-2" hidden><button type="button" class="pl-back" id="trw-back">‹ 返回</button><div class="trc-row"><span>范围</span><div class="mp-chips" id="trw-rng"></div></div><div id="trw-list"></div>'
  +'<button type="button" class="trc-opt" id="trw-px"><i class="trc-cbx"></i><span><b>在这些地方发的动态</b><em id="trw-pxs"></em></span></button>'
  +'<button type="button" class="btn wide primary" id="trw-ok">挂到消息上</button></div>'
  +'<p class="pl-foot" id="trw-f">点发送才会发出去；标了「只我自己看」的不会带上</p></div>';
function shareBuild(){if($('trw'))return;var w=document.createElement('div');w.innerHTML=SHARE_HTML;while(w.firstChild)document.body.appendChild(w.firstChild);
  $('trw-x').addEventListener('click',shareClose);$('trw-scrim').addEventListener('click',shareClose);
  $('trw-1').addEventListener('click',function(e){var b=e.target.closest('.pl-it');if(!b)return;if(b.getAttribute('data-k')==='ck'){shareClose();ckOpen('chat')}else carryOpen()});
  $('trw-back').addEventListener('click',function(){$('trw-1').hidden=false;$('trw-2').hidden=true});
  onChip('trw-rng',function(v){SR=v;carryPaint()});
  $('trw-px').addEventListener('click',function(){if(this.disabled)return;SPX=!SPX;this.classList.toggle('on',SPX)});
  $('trw-ok').addEventListener('click',carryOk)}
function share(){var c=curCfg9();if(!c){toast('在一对一的对话里才能分享行迹');return}shareBuild();$('trw-s').textContent='把你在哪、去过哪儿挂在下一条消息上，发给'+wn(cfgName(c))+'。';$('trw-1').hidden=false;$('trw-2').hidden=true;$('trw').hidden=false;$('trw-scrim').hidden=false}
function shareClose(){var w=$('trw');if(w){w.hidden=true;$('trw-scrim').hidden=true}}
function rangeOf(r,L){var n=Date.now();if(r==='today')return L.filter(function(x){return x.t>=day0(n)&&!x.dOnly});if(r==='7d')return L.filter(function(x){return n-x.t<7*864e5});if(r==='30d')return L.filter(function(x){return n-x.t<30*864e5});var g=groups(L)[0];return g?g.items:[]}
async function carryOpen(){var d=await load(),c0=curCfg9(),L=d.pts.filter(function(x){return !x.me&&visibleToRole(x,c0&&c0.id)});$('trw-1').hidden=true;$('trw-2').hidden=false;SPX=false;$('trw-px').classList.remove('on');
  if(!L.length){$('trw-rng').innerHTML='';$('trw-list').innerHTML='<p class="trc-sle">还没有能带上的行迹。先在「打卡定位」记一处，或者到 Map → 行迹里补记。</p>';$('trw-ok').disabled=true;$('trw-px').hidden=true;return}
  $('trw-px').hidden=false;carryPaint()}
async function carryPaint(){var d=await load(),c0=curCfg9(),L=d.pts.filter(function(x){return !x.me&&visibleToRole(x,c0&&c0.id)}),R9=[['today','今天'],['7d','7 天'],['trip','这一趟'],['30d','30 天']];
  if(!rangeOf(SR,L).length)SR='trip';
  $('trw-rng').innerHTML=R9.map(function(q){var n=rangeOf(q[0],L).length;return '<button type="button" class="chip'+(q[0]===SR?' on':'')+'" data-v="'+q[0]+'"'+(n?'':' disabled')+'>'+q[1]+'</button>'}).join('');
  var it=rangeOf(SR,L);SITEMS=it;
  $('trw-list').innerHTML='<ul class="trc-sl">'+it.slice(0,8).map(function(x){return '<li><b>'+E(seen(x)||x.name)+'</b><span>'+E(when(x.t,x.dOnly)+(x.wx?(' · '+x.wx):''))+'</span>'+(x.note?('<em>'+E(x.note)+'</em>'):'')+'</li>'}).join('')+'</ul>'+(it.length>8?('<p class="trc-sle">还有 '+(it.length-8)+' 处，一起带上</p>'):'');
  $('trw-ok').disabled=!it.length;$('trw-pxs').textContent='在查…';
  var px=[];try{px=await postsIn(it)}catch(e){px=[]}if(SITEMS!==it)return;SPOSTS=px;$('trw-pxs').textContent=px.length?('同一段时间带定位的 '+px.length+' 条'):'这段时间没有带定位的动态';$('trw-px').disabled=!px.length;if(!px.length){SPX=false;$('trw-px').classList.remove('on')}}
async function feedRows(){if(FEEDC&&Date.now()-FEEDT<60000)return FEEDC;var out=[],pick=function(p){if(p&&p.author&&p.author.type==='user'&&p.loc&&p.loc.lat!=null&&p.vis!=='user')out.push({ts:+p.ts||0,text:String(p.text||'').replace(/\u200b/g,'').slice(0,300),label:String(p.loc.label||'').slice(0,40),vis:p.vis,visTo:p.visTo,visEx:p.visEx})};
  try{if(typeof db==='undefined'||!db)throw 0;await new Promise(function(res,rej){var rq=db.transaction('feed').objectStore('feed').openCursor();rq.onsuccess=function(){var c=rq.result;if(!c){res();return}pick(c.value);c.continue()};rq.onerror=function(){rej(rq.error)}})}catch(e){out=[];try{(await dbGetAll('feed')||[]).forEach(pick)}catch(x){}}/* 游标逐条读、只留几个字段，不把整张动态表（带图）留在内存里 */
  FEEDC=out;FEEDT=Date.now();return out}
async function postsIn(it){if(!it.length)return [];var a=it[it.length-1].t-12*36e5,b=it[0].t+12*36e5,c=curCfg9(),id=c&&c.id,P=await feedRows();
  return P.filter(function(p){if(p.ts<a||p.ts>b)return false;if(p.vis==='only'&&!(Array.isArray(p.visTo)&&p.visTo.indexOf(id)>=0))return false;if(p.vis==='except'&&Array.isArray(p.visEx)&&p.visEx.indexOf(id)>=0)return false;return !!(p.text||p.label)}).sort(function(x,y){return y.ts-x.ts}).slice(0,6)}
function carryOk(){var it=SITEMS||[];if(!it.length)return;if(!curCfg9()){toast('回到一对一的对话里再带上');return}
  var lab=SR==='trip'?([cityOf(it[0])||it[0].name,rng(it)].filter(uniq).join(' · ')):({today:'今天','7d':'最近 7 天','30d':'最近 30 天'}[SR]||'最近'),px=SPX?(SPOSTS||[]):[];
  var head='这是我在 Map 里记下的行迹（'+lab+'，'+it.length+' 处，新的在前）：',lines=[],len=head.length;
  for(var i=0;i<it.length;i++){var x=it[i],ln='- '+when(x.t,x.dOnly)+'　'+(seen(x)||x.name)+(x.wx?('　'+x.wx):'')+(x.note?('　我写的：「'+x.note+'」'):'');if(len+ln.length>1150){lines.push('……还有 '+(it.length-i)+' 处没列');break}lines.push(ln);len+=ln.length+1}
  var pt=px.length?('\n同一段时间我发的动态：\n'+px.map(function(p){return '- '+when(p.ts)+(p.label?('（定位：'+p.label+'）'):'')+'：「'+String(p.text||'').slice(0,80)+'」'}).join('\n')):'';
  var L={url:'https://www.openstreetmap.org/#ibmap=traces',title:'我的行迹 · '+lab,desc:it.length+' 处'+(px.length?(' · 另附 '+px.length+' 条动态'):''),img:'',site:'行迹',kind:'traces',rich:'trace',text:(head+'\n'+lines.join('\n')+pt).slice(0,1490),
    tr:{lab:String(cityOf(it[0])||lab),px:px.length,items:it.slice(0,12).map(function(x){return{n:seen(x)||x.name,t:x.t,d:x.dOnly?1:0,w:x.wx||'',o:x.note||''}})}};
  shareClose();attach(L,'这是我最近的行迹');toast('挂在输入框上面了，点发送和你的话一起发出去')}
function attach(L,say){try{var c9=curCfg9();if(!c9)return false;L.fid=c9.id;_pendLink=L;if(!M().queueChatShare(L)){_pendLink=null;toast('没挂上：请回到一对一 Chat 再试');return false}return true}catch(e){toast('没挂上：回到一对一 Chat 再试');return false}}
function cardOne(tr){var sn=seen(tr),url='https://www.openstreetmap.org/#ibmap=trace';/* v327-p：链接不带坐标。链接会跟着卡片文字进发给 TA 的历史，原来门牌、街区两档把坐标也带了出去 */
  return{url:url,title:'打卡 · '+sn,desc:dlong(tr.t)+' '+hm(tr.t)+(tr.wx?(' · '+tr.wx):''),img:'',site:'行迹',kind:'trace',rich:'trace',text:dlong(tr.t)+' '+hm(tr.t)+'，在'+sn+'打卡'+(tr.wx?('，当时'+tr.wx):'')+'。'+(tr.note?('我写了一句：「'+tr.note+'」'):''),tr:{n:sn,c:cityOf(tr),t:tr.t,w:tr.wx||'',o:tr.note||'',i:tr.id}}}
function pvOpen(){var L=_pendLink;if(!L)return;sheets();$('trp-t').textContent='[卡片] '+(L.title||'')+'\n'+(L.text||L.desc||'');openSheet('sheet-trc-pv')}

/* ── 聊天里的行迹卡（包住 _lkCardHtml；跟分区玻璃「聊天里的卡片」） ── */
function cardHtml(l){var q=l.tr||{},href=E(String(l.url||''));
  if(l.kind==='trace'){var t1=+q.t||Date.now();return '<a class="lk-card trc-card trc-k1" href="'+href+'" target="_blank" rel="noopener noreferrer"><span class="trc-cpm">'+pmark(String(q.c||q.n||'').slice(0,6),'TRACES',md(t1),hm(t1))+'</span><span class="trc-cb"><span class="trc-ck2">Traces · 打卡</span><b class="trc-ct">'+E(q.n||String(l.title||'').replace(/^打卡 · /,''))+'</b><span class="trc-cm">'+E(dlong(t1)+' '+hm(t1)+(q.w?(' · '+q.w):''))+'</span>'+(q.o?('<span class="trc-cn">'+E(q.o)+'</span>'):'')+'</span></a>'}
  var it=Array.isArray(q.items)?q.items:[],sh=it.slice(0,5),t2=it.length?(+it[0].t||Date.now()):Date.now();
  return '<a class="lk-card trc-card trc-k2" href="'+href+'" target="_blank" rel="noopener noreferrer"><span class="trc-cpm">'+pmark(String(q.lab||'').slice(0,6),'TRACES',md(t2),it.length+' 处')+'</span><span class="trc-cb"><span class="trc-ck2">Traces · 行迹</span><b class="trc-ct">'+E(String(l.title||'我的行迹'))+'</b><span class="trc-cm">'+E(l.desc||'')+'</span><span class="trc-cl">'
    +sh.map(function(x){return '<span><b>'+E(x.n)+'</b><i>'+E(md(+x.t)+(x.d?'':(' '+hm(+x.t)))+(x.w?(' · '+x.w):''))+'</i>'+(x.o?('<em>'+E(x.o)+'</em>'):'')+'</span>'}).join('')+(it.length>5?('<span class="trc-cmore">还有 '+(it.length-5)+' 处</span>'):'')+'</span></span></a>'}
try{if(typeof _lkCardHtml==='function'){var _lk0=_lkCardHtml;_lkCardHtml=function(l){try{if(l&&(l.kind==='trace'||l.kind==='traces'))return cardHtml(l)}catch(e){}return _lk0.apply(this,arguments)}}}catch(e){}
try{if(typeof _msgPreview==='function'){var _mv0=_msgPreview;_msgPreview=function(last){var r=_mv0.apply(this,arguments);try{if(last&&last.link&&(last.link.kind==='trace'||last.link.kind==='traces')&&typeof r==='string')r=r.replace('[链接] ','[行迹] ')}catch(e){}return r}}}catch(e){}
try{if(typeof drawAttach==='function'){var _da9=drawAttach;drawAttach=function(){var r=_da9.apply(this,arguments);try{var L=_pendLink,st=$('cv-attach-strip');if(L&&st&&(L.kind==='trace'||L.kind==='traces'))st.querySelectorAll('.att-thumb.file').forEach(function(t){var s=t.querySelector('.att-doc');if(!s||s.textContent!=='🔗 '+String(L.title||''))return;s.textContent='📍 '+L.title;t.classList.add('att-trc');t.addEventListener('click',function(e){if(e.target.closest('.att-x'))return;pvOpen()})})}catch(e){}return r}}}catch(e){}
function markSent(id){load().then(function(d){var x=d.pts.find(function(q){return q.id===id});if(x&&x.src!=='chat'){x.src='chat';return save().then(function(){if(SHOWN)render()})}}).catch(function(){})}/* v327-p：打卡卡真的发出去了才标「发给过 TA」（原来挂上就标，撤回了也留着） */
async function recordSharedLocation(o){o=o||{};var d=await load(),id='tr_'+Date.now()+'_'+Math.floor(Math.random()*1e4),row={id:id,t:Number(o.at)||Date.now(),lat:+o.lat,lon:+o.lon,acc:Math.round(Number(o.accuracy)||0),name:String(o.name||'').slice(0,80),road:String(o.road||'').slice(0,80),hn:String(o.houseNumber||'').slice(0,30),sub:String(o.sub||'').slice(0,80),city:String(o.city||'').slice(0,80),country:String(o.country||'').slice(0,80),prec:['exact','block','city'].indexOf(String(o.precision||''))>=0?String(o.precision):'block',note:'',me:false,wx:'',src:'chat',friendId:String(o.friendId||''),visTo:[String(o.friendId||'')]};if(!isFinite(row.lat)||!isFinite(row.lon)||!row.friendId)return false;d.pts.unshift(row);if(!await save()){d.pts=d.pts.filter(function(x){return x!==row});return false}if(SHOWN)render();try{M().refresh()}catch(e){}return id}
try{if(typeof sendMsg==='function'){var _sd0=sendMsg;sendMsg=function(){var L=null,sid='';try{L=_pendLink;var ta9=$('cv-ta'),c9=curCfg9();if(L&&(L.kind==='trace'||L.kind==='traces')){
  if(L.fid&&(!c9||c9.id!==L.fid)){_pendLink=null;try{drawAttach()}catch(e){}toast('这张行迹卡是挂给另一位 TA 的，已经取下');return Promise.resolve()}/* v327-p：卡是按挂的那位 TA 能看到的内容拼的，换了对话不带过去 */
  if(ta9&&!ta9.value.trim()&&!(_pendImgs&&_pendImgs.length)&&!(_pendFiles&&_pendFiles.length)&&!window._ibPendStk)ta9.value=L.kind==='trace'?('我在'+String((L.tr&&L.tr.n)||'这儿').split(' · ').pop()):'这是我最近的行迹';
  if(L.kind==='trace'&&L.tr&&L.tr.i)sid=L.tr.i}}catch(e){}
  var r=_sd0.apply(this,arguments);if(sid){var fin=function(){try{if(_pendLink!==L)markSent(sid)}catch(e){}};try{Promise.resolve(r).then(fin,fin)}catch(e){}}return r}}}catch(e){}/* 只挂了行迹卡、没写字：补一句再走原来的发送 */

/* ── TA 查行迹：<ws_traces days/> ── */
var INSTR='【行迹】<ws_traces/>——查对方在 Map 里记下的行迹：家在哪座城市，最近去过的地方（时间、地名、当时的天气、对方写的一句备注）。默认给最近 30 条；<ws_traces days="7"/> 只看最近 7 天。结果另起一条交回给你；地名只到对方允许的精度，对方标了只自己看的不在里面。想知道对方最近去了哪、现在在哪座城市时用。';
async function instr(cfg){try{if(!cfg||cfg._group)return '';await loadPermissions();if(!can(cfg.id))return '';return INSTR}catch(e){return ''}}
async function exec(cfg,op){var LB='查看行迹';if(!cfg||cfg._group)return{ok:false,label:LB,reason:'群聊里不能查行迹'};await loadPermissions();if(!can(cfg.id))return{ok:false,label:LB,reason:'对方没让你查行迹（Map → 行迹 → 设置里逐位开）'};await load();
  var days=0;try{var mm=String(op.attrs||'').match(/\bdays=["']([^"']*)["']/i);days=parseInt(mm&&mm[1]||'',10)||0}catch(e){}if(days<0)days=0;if(days>3650)days=3650;
  var d=await load(),L=d.pts.filter(function(x){return !x.me&&visibleToRole(x,cfg.id)});L=days>0?L.filter(function(x){return Date.now()-x.t<days*864e5}):L.slice(0,30);
  var C=null;try{C=await T().cfgSet()}catch(e){}var h=C&&C.home,hs=h?homeSeen(h,d.set.home):'',hl=hs?('家：'+hs+'\n'):'';
  if(!L.length)return{ok:true,label:LB,detail:'没有记下的',response:hl+(days>0?('最近 '+days+' 天对方没有记下行迹。'):'对方还没有记下行迹。')};
  var out=hl+'对方在 Map 里记下的行迹（新的在前，'+(days>0?('最近 '+days+' 天，'):'')+L.length+' 处）：\n'+L.map(function(x){return '- '+when(x.t,x.dOnly)+'　'+(seen(x)||'某处')+(x.wx?('　'+x.wx):'')+(x.note?('　对方写的：「'+x.note+'」'):'')}).join('\n');
  return{ok:true,label:LB,detail:L.length+' 处'+(days>0?(' · 最近 '+days+' 天'):''),response:out.slice(0,6000)}}
try{WS_META.traces=['','查看行迹'];EXEC_WS.traces=1;WS_ICON.traces='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 13c1.8-.4 2.8-1.8 4.4-2.4 1.5-.5 2.9.3 4.3-.9" stroke-dasharray="1 1.8"/><path d="M11.5 2.4a2.2 2.2 0 0 1 2.2 2.2c0 1.7-2.2 3.7-2.2 3.7S9.3 6.3 9.3 4.6a2.2 2.2 0 0 1 2.2-2.2z"/></svg>'}catch(e){}

/* ── 主题切换、切后台、屏幕变宽：只在行迹页开着时重画小地球仪 ── */
try{var _dk9=document.body.classList.contains('theme-infernal');new MutationObserver(function(){var dk=document.body.classList.contains('theme-infernal');if(dk!==_dk9){_dk9=dk;if(SHOWN&&HERO)try{HERO.draw()}catch(e){}}}).observe(document.body,{attributes:true,attributeFilter:['class']})}catch(e){}
document.addEventListener('visibilitychange',function(){if(!HERO)return;try{if(document.hidden)HERO.release();else if(SHOWN)HERO.draw()}catch(e){}});
window.addEventListener('resize',function(){if(SHOWN&&HERO)try{HERO.draw()}catch(e){}});
window._ibTrc={show:show,hide:hide,marks:marks,ava:ava,exec:exec,instr:instr,share:share,ck:ckOpen,focus:focus,_t:{load:load,save:save,seen:seen,when:when,groups:groups,cardHtml:cardHtml,cardOne:cardOne,can:can,setCan:setCan,render:render,carryOk:carryOk,carryOpen:carryOpen,rangeOf:rangeOf,reset:function(){TRD=null;PERM=null;FEEDC=null}}};
window.IBMapTraces={instruction:instr,execute:exec,can:can,setCan:setCan,share:share,checkin:ckOpen,previewPending:pvOpen,focus:focus,closeTransient:shareClose,markSent:markSent,recordSharedLocation:recordSharedLocation,clearPending:function(){_pendLink=null},_t:{load:load,save:save,loadPermissions:loadPermissions,seen:seen,carryOk:carryOk,rangeOf:rangeOf}};
})();
