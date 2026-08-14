﻿/* ══ Calendar 模块脚本（并入自 v35 定稿，v36 修订：数据入库 / 真实好友 / 便笺协议） ══ */
(function(NS){
'use strict';
/* ── 工具 ── */
function $(s,c){return (c||document).querySelector(s)}
function $$(s,c){return Array.prototype.slice.call((c||document).querySelectorAll(s))}
function p2(n){return (n<10?'0':'')+n}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;'})}

var _t=new Date();
var TODAY=new Date(_t.getFullYear(),_t.getMonth(),_t.getDate());
var MEN=['January','February','March','April','May','June','July','August','September','October','November','December'];
var MAB=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
var MCN=['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
var WEN=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var WCN=['日','一','二','三','四','五','六'];
function isoOf(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
function diffD(a,b){return Math.round((b.getTime()-a.getTime())/86400000)}
function isoAdd(base,n){var d=new Date(base.getTime()+n*86400000);return isoOf(d)}

/* ── 月相：真实月龄 ── */
var SYN=29.530588853, NM0=Date.UTC(2000,0,6,18,14);
function moonAge(d){var a=((d.getTime()-NM0)/86400000)%SYN;return a<0?a+SYN:a}
function moonIllum(age){return Math.round((1-Math.cos(2*Math.PI*age/SYN))/2*100)}
function moonName(age){
  if(age<1.85||age>SYN-1.85)return '新月';
  if(age<6.4)return '娥眉月';
  if(age<8.4)return '上弦月';
  if(age<13.8)return '盈凸月';
  if(age<15.8)return '满月';
  if(age<21.1)return '亏凸月';
  if(age<23.1)return '下弦月';
  return '残月';
}
var moonUID=0;
function moonSVG(age,sz,x,y){
  moonUID++;var uid='mn'+moonUID;
  var r=10,cx=12,cy=12;
  var k=Math.cos(2*Math.PI*age/SYN);
  var waxing=age<SYN/2, il=moonIllum(age);
  var rx=Math.max(0.4,Math.abs(k)*r).toFixed(2);
  var lit='';
  if(il>=99){lit='M '+cx+' '+(cy-r)+' A '+r+' '+r+' 0 1 1 '+cx+' '+(cy+r)+' A '+r+' '+r+' 0 1 1 '+cx+' '+(cy-r)+' Z';}
  else if(il>1){
    if(waxing){lit='M '+cx+' '+(cy-r)+' A '+r+' '+r+' 0 0 1 '+cx+' '+(cy+r)+' A '+rx+' '+r+' 0 0 '+(k>0?0:1)+' '+cx+' '+(cy-r)+' Z';}
    else{lit='M '+cx+' '+(cy-r)+' A '+r+' '+r+' 0 0 0 '+cx+' '+(cy+r)+' A '+rx+' '+r+' 0 0 '+(k>0?1:0)+' '+cx+' '+(cy-r)+' Z';}
  }
  var s='<svg class="moon"'+(x!=null?' x="'+x+'" y="'+y+'"':'')+' width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" aria-hidden="true">';
  s+='<defs><radialGradient id="'+uid+'b" cx="33%" cy="27%" r="78%">'
    +'<stop offset="0" style="stop-color:var(--moon-base-a)"/><stop offset="0.55" style="stop-color:var(--moon-base-b)"/><stop offset="1" style="stop-color:var(--moon-base-c)"/></radialGradient>'
    +'<radialGradient id="'+uid+'l" cx="31%" cy="24%" r="82%">'
    +'<stop offset="0" style="stop-color:var(--moon-lit-a)"/><stop offset="0.55" style="stop-color:var(--moon-lit-b)"/><stop offset="1" style="stop-color:var(--moon-lit-c)"/></radialGradient>'
    +'</defs>';
  s+='<g class="m-int">';
  s+='<circle class="m-aura" cx="12" cy="12" r="11.2"/>';
  s+='<circle cx="12" cy="12" r="10" fill="url(#'+uid+'b)" opacity="0.5"/>';
  s+='<circle cx="12" cy="12" r="10" style="fill:var(--moon-dark)"/>';
  if(lit){s+='<path d="'+lit+'" fill="url(#'+uid+'l)"/>';}
  s+='<circle class="m-rim" cx="12" cy="12" r="10"/>';
  s+='</g>';
  s+='<g class="m-inf">';
  s+='<circle cx="12" cy="12" r="10" style="fill:var(--moon-dark)"/>';
  if(lit){s+='<path d="'+lit+'" style="fill:var(--moon2-lit)"/>';}
  s+='<circle cx="12" cy="12" r="10" style="fill:none;stroke:var(--moon-rim);stroke-width:0.8"/>';
  s+='</g></svg>';
  return s;
}

/* ── 二十四节气（太阳黄经近似） ── */
var TERMS=['春分','清明','谷雨','立夏','小满','芒种','夏至','小暑','大暑','立秋','处暑','白露','秋分','寒露','霜降','立冬','小雪','大雪','冬至','小寒','大寒','立春','雨水','惊蛰'];
/* v44 — 节气改为精确求解交节时刻。
   旧写法用低精度黄经公式、且只在当日正午采样一次，交节点落在当天凌晨或深夜时会判错一天。
   现在用 Meeus 视黄经（中心差 + 章动 + 光行差）配牛顿迭代求出黄经整 15° 的准确时刻，
   再按本地时区落到日期；整年 24 个节气一次算完并缓存，重复查询不再重算。 */
function sunLongApp(ms){
  var jd=ms/86400000+2440587.5+69/86400;/* ΔT：本世纪约 69 秒 */
  var T=(jd-2451545)/36525;
  var L0=280.46646+36000.76983*T+0.0003032*T*T;
  var M=(357.52911+35999.05029*T-0.0001537*T*T)*Math.PI/180;
  var C=(1.914602-0.004817*T-0.000014*T*T)*Math.sin(M)+(0.019993-0.000101*T)*Math.sin(2*M)+0.000289*Math.sin(3*M);
  var om=(125.04-1934.136*T)*Math.PI/180;
  var lam=L0+C-0.00569-0.00478*Math.sin(om);
  return ((lam%360)+360)%360;
}
function angGap(a,b){var d=(a-b)%360;if(d>180)d-=360;if(d<-180)d+=360;return d}
function termMs(y,k){
  var t=Date.UTC(y,2,20,4)+k*15.2184*86400000,g;/* 自春分粗估起步，牛顿迭代收敛 */
  for(var i=0;i<12;i++){g=angGap(sunLongApp(t),k*15);t-=g*86400000/0.9856;if(Math.abs(g)<1e-8)break}
  return t;
}
var _termYears={};
function termList(y){
  if(_termYears[y])return _termYears[y];
  var a=[],yy,k,ms;
  for(yy=y-1;yy<=y+1;yy++)for(k=0;k<24;k++){ms=termMs(yy,k);a.push({name:TERMS[k],ms:ms,iso:isoOf(new Date(ms))})}
  a.sort(function(x,z){return x.ms-z.ms});
  var out=[];for(var i=0;i<a.length;i++)if(!i||a[i].iso!==a[i-1].iso)out.push(a[i]);
  _termYears[y]=out;return out;
}
function termInfo(d){
  var iso=isoOf(d),L=termList(d.getFullYear()),cur=0;
  for(var i=0;i<L.length;i++){if(L[i].iso<=iso)cur=i;else break}
  var nx=L[Math.min(cur+1,L.length-1)];
  var a=calDate(L[cur].iso),b=calDate(nx.iso);
  return {name:L[cur].name,next:nx.name,days:b?Math.max(0,diffD(d,b)):0,dayN:a?diffD(a,d)+1:1};
}

/* ── v39 — 传统节日：农历节日的公历日期按 Meeus 朔望与中气置闰规则预先推算（2024–2060），
   公历固定节日查表，复活节 / 感恩节按规则算，清明与冬至取自本模块既有的节气算法。
   节日只并入消息末尾的日历栏，不进 system 常量块，因此不影响提示缓存。
 ── */
var HOL_LUNAR={2024:'0209除夕,0210春节,0224元宵,0610端午,0810七夕,0917中秋,1011重阳,0118腊八',2025:'0128除夕,0129春节,0212元宵,0531端午,0829七夕,1006中秋,1029重阳,0107腊八',2026:'0216除夕,0217春节,0303元宵,0619端午,0819七夕,0925中秋,1018重阳,0126腊八',2027:'0205除夕,0206春节,0220元宵,0609端午,0808七夕,0915中秋,1008重阳,0115腊八',2028:'0125除夕,0126春节,0209元宵,0528端午,0826七夕,1003中秋,1026重阳,0104腊八',2029:'0212除夕,0213春节,0227元宵,0616端午,0816七夕,0922中秋,1016重阳,0122腊八',2030:'0202除夕,0203春节,0217元宵,0605端午,0805七夕,0912中秋,1005重阳,0111腊八',2031:'0122除夕,0123春节,0206元宵,0624端午,0824七夕,1001中秋,1024重阳,0101腊八',2032:'0210除夕,0211春节,0225元宵,0612端午,0812七夕,0919中秋,1012重阳,0120腊八',2033:'0130除夕,0131春节,0214元宵,0601端午,0801七夕,0908中秋,1001重阳,0108腊八',2034:'0218除夕,0219春节,0305元宵,0620端午,0820七夕,0927中秋,1020重阳,0127腊八',2035:'0207除夕,0208春节,0222元宵,0610端午,0810七夕,0916中秋,1009重阳,0116腊八',2036:'0127除夕,0128春节,0211元宵,0530端午,0828七夕,1004中秋,1027重阳,0105腊八',2037:'0214除夕,0215春节,0301元宵,0618端午,0817七夕,0924中秋,1017重阳,0123腊八',2038:'0203除夕,0204春节,0218元宵,0607端午,0807七夕,0913中秋,1007重阳,0112腊八',2039:'0123除夕,0124春节,0207元宵,0527端午,0826七夕,1002中秋,1026重阳,0102腊八',2040:'0211除夕,0212春节,0226元宵,0614端午,0814七夕,0920中秋,1014重阳,0121腊八',2041:'0131除夕,0201春节,0215元宵,0603端午,0803七夕,0910中秋,1003重阳,1230腊八',2042:'0121除夕,0122春节,0205元宵,0622端午,0822七夕,0928中秋,1022重阳',2043:'0209除夕,0210春节,0224元宵,0611端午,0811七夕,0917中秋,1011重阳,0118腊八',2044:'0129除夕,0130春节,0213元宵,0531端午,0731七夕,1005中秋,1029重阳,0107腊八',2045:'0216除夕,0217春节,0303元宵,0619端午,0819七夕,0925中秋,1018重阳,0125腊八',2046:'0205除夕,0206春节,0220元宵,0608端午,0808七夕,0915中秋,1008重阳,0114腊八',2047:'0125除夕,0126春节,0209元宵,0529端午,0827七夕,1004中秋,1027重阳,0103腊八',2048:'0213除夕,0214春节,0228元宵,0615端午,0816七夕,0922中秋,1016重阳,0122腊八',2049:'0201除夕,0202春节,0216元宵,0604端午,0805七夕,0911中秋,1005重阳,0111腊八',2050:'0122除夕,0123春节,0206元宵,0623端午,0823七夕,0930中秋,1024重阳,0101腊八',2051:'0210除夕,0211春节,0225元宵,0613端午,0812七夕,0919中秋,1013重阳,0120腊八',2052:'0131除夕,0201春节,0215元宵,0601端午,0801七夕,0907中秋,1030重阳,0109腊八',2053:'0218除夕,0219春节,0305元宵,0620端午,0820七夕,0926中秋,1020重阳,0127腊八',2054:'0207除夕,0208春节,0222元宵,0610端午,0810七夕,0916中秋,1009重阳,0116腊八',2055:'0127除夕,0128春节,0211元宵,0530端午,0829七夕,1005中秋,1028重阳,0105腊八',2056:'0214除夕,0215春节,0229元宵,0617端午,0817七夕,0924中秋,1017重阳,0124腊八',2057:'0203除夕,0204春节,0218元宵,0606端午,0806七夕,0913中秋,1006重阳,0112腊八',2058:'0123除夕,0124春节,0207元宵,0625端午,0825七夕,1002中秋,1025重阳,0102腊八',2059:'0211除夕,0212春节,0226元宵,0614端午,0814七夕,0921中秋,1014重阳,0121腊八',2060:'0201除夕,0202春节,0216元宵,0603端午,0802七夕,0909中秋,1002重阳,1230腊八'};
var HOL_FIX=[['0101','元旦'],['0214','情人节'],['0601','儿童节'],['1031','万圣夜'],['1224','平安夜'],['1225','圣诞节'],['1231','跨年夜']];
var HOL_LEAD=3;/* 节日进入日历栏的提前天数 */
function holEaster(y){
  var a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
      f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,
      i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,
      m=Math.floor((a+11*h+22*l)/451),
      mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;
  return new Date(y,mo-1,da);
}
function holNthDow(y,mi,dow,n){/* 第 n 个星期 dow（mi 为 0 起的月份） */
  var d=new Date(y,mi,1),sh=(dow-d.getDay()+7)%7;
  return new Date(y,mi,1+sh+(n-1)*7);
}
var _holCache={};
function holMap(y){
  if(_holCache[y])return _holCache[y];
  var m={};
  HOL_FIX.forEach(function(p){m[y+'-'+p[0].slice(0,2)+'-'+p[0].slice(2)]=p[1]});
  var L=HOL_LUNAR[y];
  if(L)L.split(',').forEach(function(x){m[y+'-'+x.slice(0,2)+'-'+x.slice(2,4)]=x.slice(4)});
  m[isoOf(holEaster(y))]='复活节';
  m[isoOf(holNthDow(y,10,4,4))]='感恩节';
  _holCache[y]=m;return m;
}
/* v40 — 单日节日查询：查表节日 + 节气节日（清明/冬至）；同日双节返回两条并列（如 2026-04-05 既是清明也是复活节）。挂历黄点、日程表节日行与日历栏共用此来源 */
function holsOn(d){
  var out=[],nm=holMap(d.getFullYear())[isoOf(d)];
  if(nm)out.push(nm);
  var ti=termInfo(d);
  if(ti.dayN===1&&(ti.name==='清明'||ti.name==='冬至'))out.push(ti.name);
  return out;
}
function holidaysIn(t,lead){
  var out=[];
  for(var i=0;i<=lead;i++){
    var d=new Date(t.getFullYear(),t.getMonth(),t.getDate()+i),iso=isoOf(d);
    holsOn(d).forEach(function(nm){out.push({name:nm,occ:iso,du:i})});
  }
  return out;
}

/* ── 数据层（集成版）：好友即 API 配置；事项/便笺/台账存 IndexedDB；设置存 apiSettings ── */
var Y0=TODAY.getFullYear();
var AIS=[];      /* 好友快照 {id,name,model}，随 apiConfigs 刷新 */
var MEETS={};    /* friendId → 首条聊天消息时间戳（相遇日默认取自最早一条聊天记录） */
var MEET_IB=null;/* v37 — 与站点本身的相遇：全库最早一条聊天消息的时间戳（含群聊） */
var IB_KEY='__ib__';/* v37 — MEETSET 中站点纪念日的保留键 */
var MEETSET={};  /* friendId → 'YYYY-MM-DD'：用户在设置页手动指定的相遇纪念日，优先于自动推算 */
var AISTATE={};  /* friendId → [读取,留言]，未记录的好友默认 [1,1] */
var ALLOW_NOTES=true;/* v39 — 语义扩为总开关：关闭后 AI 既不读取日程也不写便笺，消息中不附带任何日历内容 */
var HOLIDAY_ON=false;/* v39 — 传统节日提醒，默认关闭 */
var ITEMS=[];    /* calEvents 内存镜像 */
var NOTES=[];    /* calNotes 内存镜像（时间倒序） */
var SET={noPetals:false,bootMini:true};/* v37 — 周起始与「打开时回到今天」开关已撤：固定周日开头、打开即回当月。v42 — bootMini：开站小窗常驻，默认开启 */
var LEAD=7;
function aiName(id){for(var i=0;i<AIS.length;i++)if(AIS[i].id===id)return AIS[i].name;return '已移除的 AI'}
function perm(id){return AISTATE[id]||[1,1]}
function visLabel(v){
  v=String(v||'self');
  if(v==='all')return '公开';
  if(v==='self')return '仅自己';
  if(v.indexOf('ais:')===0)return '仅 '+v.slice(4).split('|').map(aiName).join('、');/* v44 — 多选 */
  if(v.indexOf('ai:')===0)return '仅 '+aiName(v.slice(3));
  return v;
}
function visibleTo(it,aid){
  var v=it&&it.vis?String(it.vis):'self';
  if(v==='self')return false;
  if(v==='all')return true;
  if(v.indexOf('ais:')===0)return v.slice(4).split('|').indexOf(aid)>=0;/* v44 — 多选 */
  return v==='ai:'+aid;
}
async function refreshAIs(){
  var src=[];
  try{
    if(typeof apiConfigs!=='undefined'&&apiConfigs&&apiConfigs.length)src=apiConfigs;
    else if(typeof loadApiConfigs==='function'){await loadApiConfigs();if(typeof apiConfigs!=='undefined'&&apiConfigs)src=apiConfigs}
  }catch(e){}
  AIS=src.filter(function(a){return a&&a.id}).map(function(a){return {id:a.id,name:a.nickname||a.model||'AI',model:a.model||''}});
  AIS.forEach(function(a){if(!AISTATE[a.id])AISTATE[a.id]=[1,1]});
  if(heroAI>=AIS.length+1)heroAI=0;/* v37 — 0 号页固定是站点纪念日，好友页从 1 起 */
}
async function refreshMeets(){
  MEETS={};MEET_IB=null;
  try{var all=await dbGetAll('chatMessages');all.forEach(function(m){
    if(!m.timestamp)return;
    if(MEET_IB==null||m.timestamp<MEET_IB)MEET_IB=m.timestamp;/* v37 — 站点相遇日不排除群聊 */
    if(!m.friendId||String(m.friendId).indexOf('group_')===0)return;
    if(!MEETS[m.friendId]||m.timestamp<MEETS[m.friendId])MEETS[m.friendId]=m.timestamp;
  })}catch(e){}
}
function meetIso(id){if(MEETSET[id])return MEETSET[id];if(!MEETS[id])return null;var d=new Date(MEETS[id]);return isoOf(d)}
function meetIsoIB(){if(MEETSET[IB_KEY])return MEETSET[IB_KEY];if(MEET_IB==null)return null;return isoOf(new Date(MEET_IB))}/* v37 */
async function loadCalData(){
  try{ITEMS=(await dbGetAll('calEvents')).sort(function(a,b){return (a.created||0)-(b.created||0)})}catch(e){ITEMS=[]}
  try{NOTES=(await dbGetAll('calNotes')).sort(function(a,b){return (b.ts||0)-(a.ts||0)})}catch(e){NOTES=[]}
  try{var s=await dbGet('apiSettings','calendarSettings');
    if(s){SET.noPetals=!!s.noPetals;SET.bootMini=s.bootMini!==false;ALLOW_NOTES=s.allowNotes!==false;AISTATE=s.perm||{};MEETSET=s.meetSet||{};HOLIDAY_ON=!!s.holiday}
  }catch(e){}
  document.body.classList.toggle('no-petals',SET.noPetals);
}
function saveCalSettings(){try{dbPut('apiSettings',{id:'calendarSettings',noPetals:SET.noPetals,bootMini:SET.bootMini,allowNotes:ALLOW_NOTES,perm:AISTATE,meetSet:MEETSET,holiday:HOLIDAY_ON})}catch(e){}}
var _dataReady=false;
async function ensureData(){if(_dataReady)return;await loadCalData();await refreshAIs();_dataReady=true}
function calDate(s){
  var m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;
  var y=+m[1],mo=+m[2],d=+m[3],x=new Date(y,mo-1,d);
  return x.getFullYear()===y&&x.getMonth()===mo-1&&x.getDate()===d?x:null;
}
function exactDate(y,m,d){var x=new Date(y,m,d);return x.getFullYear()===y&&x.getMonth()===m&&x.getDate()===d?x:null}
function itemDate(it){return calDate(it&&it.date)}
/* 脏数据兜底：结束日期无效或早于开始日期时，运行期按“与开始日同一天”收口，避免消失或无限重复。 */
function itemEndDate(it){var b=itemDate(it);if(!b||!it||!it.endDate)return null;var e=calDate(it.endDate);return !e||e.getTime()<b.getTime()?new Date(b.getTime()):e}
/* v44 — 每周重复支持多选：新数据写 weekdays 数组，旧数据的单个 weekday 自动兼容 */
function itemWeekdays(it,b){
  var a=[],i,w;
  if(it&&Object.prototype.toString.call(it.weekdays)==='[object Array]'){
    for(i=0;i<it.weekdays.length;i++){w=+it.weekdays[i];if(w>=0&&w<=6&&a.indexOf(w)<0)a.push(w)}
  }
  if(!a.length&&it){w=+it.weekday;if(w>=0&&w<=6)a=[w]}
  if(!a.length)a=[b?b.getDay():0];
  return a.sort(function(x,z){return x-z});
}
function itemWeekday(it,b){return itemWeekdays(it,b)[0]}
function wdText(it,b){return itemWeekdays(it,b).map(function(w){return WCN[w]}).join('、')}
function occKey(it,o){return it.repeat==='once'&&it.endDate?it.date:isoOf(o)}
/* v44 — 月末顺延：31 日的每月重复，遇到只有 30 天或 28/29 天的月份时改在该月最后一天成立；
   2 月 29 日的每年重复在平年落到 2 月 28 日。原写法是直接跳过这些月份与年份。 */
function clampDay(y,m,dd){var last=new Date(y,m+1,0).getDate();return new Date(y,m,Math.min(dd,last))}
function occursOn(it,d){
  var b=itemDate(it),e=itemEndDate(it);if(!b||d.getTime()<b.getTime()||(e&&d.getTime()>e.getTime()))return false;
  if(it.repeat==='daily')return true;
  if(it.repeat==='weekly')return itemWeekdays(it,b).indexOf(d.getDay())>=0;
  if(it.repeat==='yearly')return clampDay(d.getFullYear(),b.getMonth(),b.getDate()).getTime()===d.getTime();
  if(it.repeat==='monthly')return clampDay(d.getFullYear(),d.getMonth(),b.getDate()).getTime()===d.getTime();
  return e?true:b.getTime()===d.getTime();
}
function nextOcc(it,from){
  var b=itemDate(it),e=itemEndDate(it),o=null,start,w,off,i,y,m;if(!b||e&&from.getTime()>e.getTime())return null;
  if(it.repeat==='once')return from.getTime()<=b.getTime()?(e&&b.getTime()>e.getTime()?null:b):(e&&from.getTime()<=e.getTime()?from:null);
  start=from.getTime()<b.getTime()?b:from;
  if(it.repeat==='daily')o=start;
  else if(it.repeat==='weekly'){
    var ws=itemWeekdays(it,b),c2;/* v44 — 取多选星期里最近的一天 */
    for(i=0;i<ws.length;i++){off=(ws[i]-start.getDay()+7)%7;c2=new Date(start.getFullYear(),start.getMonth(),start.getDate()+off);if(!o||c2.getTime()<o.getTime())o=c2}
  }
  else if(it.repeat==='yearly'){
    for(i=0;i<3&&!o;i++){o=clampDay(start.getFullYear()+i,b.getMonth(),b.getDate());if(o.getTime()<start.getTime())o=null}
  }else if(it.repeat==='monthly'){
    for(i=0;i<24&&!o;i++){m=start.getMonth()+i;y=start.getFullYear()+Math.floor(m/12);m=((m%12)+12)%12;o=clampDay(y,m,b.getDate());if(o.getTime()<start.getTime())o=null}
  }
  if(!o||o.getTime()<b.getTime()||e&&o.getTime()>e.getTime())return null;return o;
}
function dayItems(d){return ITEMS.filter(function(it){return occursOn(it,d)})}

/* ── 环境：窗内花瓣（星幕与雨丝为预览页外壳，未随集成并入） ── */
function buildWindowPetals(){
  var f=$('#eph-petals');if(!f)return;var h='';
  for(var i=0;i<20;i++){
    var sz=6.5+Math.random()*7.5;
    h+='<span class="window-petal" style="--x:'+(Math.random()*100).toFixed(1)+'%;--s:'+sz.toFixed(1)+'px;--d:'+(10+Math.random()*9).toFixed(1)+'s;--delay:'+(-Math.random()*18).toFixed(1)+'s;--dx1:'+(Math.random()*70-35).toFixed(0)+'px;--dx2:'+(Math.random()*100-50).toFixed(0)+'px;--dx3:'+(Math.random()*130-65).toFixed(0)+'px;--o:'+(0.18+Math.random()*0.24).toFixed(2)+'"><svg viewBox="-7 -7 14 14"><use href="#sym-floret"/></svg></span>';
  }
  f.innerHTML=h;
}

/* ── 时钟（统一盘面：展开 128 — 收起 96，按显示尺寸原生绘制） ── */
function ckP(c,r,aDeg){var a=aDeg*Math.PI/180;return [c+Math.sin(a)*r, c-Math.cos(a)*r]}
function primeHands(ids){
  var n=new Date();
  var s=n.getSeconds()+n.getMilliseconds()/1000;
  var mi=n.getMinutes()+s/60;
  var hr=(n.getHours()%12)+mi/60;
  var deg=[hr/12*360,mi/60*360,s/60*360];
  ids.forEach(function(id,i){var g=document.getElementById(id);if(g)g.style.setProperty('--h0',deg[i].toFixed(3)+'deg')});
}
function buildMainClock(){
  var svg=$('#ice-clock');if(!svg)return;
  var c=103,h='';
  h+='<circle class="ck-halo" cx="103" cy="103" r="100"/>';
  h+='<circle class="ck-basin" cx="103" cy="103" r="96"/>';
  h+='<circle class="ck-face" cx="103" cy="103" r="89"/>';
  h+='<path class="ck-conc-sh" d="M28 65 A84 84 0 0 1 178 65"/>';
  h+='<path class="ck-conc-hi" d="M24 130 A84 84 0 0 0 182 130"/>';
  /* 按要求删除 A 版原有的两层 ck-lathe 内环圆线 */
  h+='<path class="ck-glint" d="M40 63 A78 78 0 0 1 92 28"/>';
  h+='<path class="ck-glint faint" d="M166 138 A78 78 0 0 1 122 176"/>';
  for(var i=0;i<60;i++){
    var maj=i%5===0;
    var q1=ckP(c,maj?76:79,i*6),q2=ckP(c,maj?84:83,i*6);
    h+='<line class="ck-tick'+(maj?' maj':'')+'" x1="'+q1[0].toFixed(2)+'" y1="'+q1[1].toFixed(2)+'" x2="'+q2[0].toFixed(2)+'" y2="'+q2[1].toFixed(2)+'" stroke-width="'+(maj?1.8:1)+'"/>';
  }
  h+='<g id="hand-hr" class="ck-raised"><path class="ck-hand-hr" d="M103 116 L99.4 104 L101.4 60 L103 53 L104.6 60 L106.6 104 Z"/><line class="ck-spine" x1="103" y1="110" x2="103" y2="60"/></g>';
  h+='<g id="hand-min" class="ck-raised"><path class="ck-hand-min" d="M103 119 L100.2 104 L101.8 40 L103 33 L104.2 40 L105.8 104 Z"/><line class="ck-spine" x1="103" y1="113" x2="103" y2="41"/></g>';
  h+='<g id="hand-sec"><line class="ck-sec-tail" x1="103" y1="103" x2="103" y2="119"/><circle class="ck-sec-ring" cx="103" cy="115" r="3.2"/><line class="ck-hand-sec" x1="103" y1="111" x2="103" y2="30"/></g>';
  h+='<circle class="ck-cap" cx="103" cy="103" r="4.4"/><circle class="ck-cap-dot" cx="103" cy="103" r="1.4"/>';
  svg.innerHTML=h;
  primeHands(['hand-hr','hand-min','hand-sec']);
}
function buildWidgetClock(){
  var svg=$('#wg-clock');if(!svg)return;
  var c=103,h='';
  h+='<circle class="ck-halo" cx="103" cy="103" r="100"/>';
  h+='<circle class="ck-basin" cx="103" cy="103" r="96"/>';
  h+='<circle class="ck-face" cx="103" cy="103" r="89"/>';
  h+='<path class="ck-conc-sh" d="M28 65 A84 84 0 0 1 178 65"/>';
  h+='<path class="ck-conc-hi" d="M24 130 A84 84 0 0 0 182 130"/>';
  /* 小窗同样不绘制两层 ck-lathe 内环圆线 */
  h+='<path class="ck-glint" d="M40 63 A78 78 0 0 1 92 28"/>';
  h+='<path class="ck-glint faint" d="M166 138 A78 78 0 0 1 122 176"/>';
  for(var i=0;i<60;i++){
    var maj=i%5===0;
    var q1=ckP(c,maj?76:79,i*6),q2=ckP(c,maj?84:83,i*6);
    h+='<line class="ck-tick'+(maj?' maj':'')+'" x1="'+q1[0].toFixed(2)+'" y1="'+q1[1].toFixed(2)+'" x2="'+q2[0].toFixed(2)+'" y2="'+q2[1].toFixed(2)+'" stroke-width="'+(maj?1.8:1)+'"/>';
  }
  h+='<g id="wg-hr" class="ck-raised"><path class="ck-hand-hr" d="M103 116 L99.4 104 L101.4 60 L103 53 L104.6 60 L106.6 104 Z"/><line class="ck-spine" x1="103" y1="110" x2="103" y2="60"/></g>';
  h+='<g id="wg-min" class="ck-raised"><path class="ck-hand-min" d="M103 119 L100.2 104 L101.8 40 L103 33 L104.2 40 L105.8 104 Z"/><line class="ck-spine" x1="103" y1="113" x2="103" y2="41"/></g>';
  h+='<g id="wg-sec"><line class="ck-sec-tail" x1="103" y1="103" x2="103" y2="119"/><circle class="ck-sec-ring" cx="103" cy="115" r="3.2"/><line class="ck-hand-sec" x1="103" y1="111" x2="103" y2="30"/></g>';
  h+='<circle class="ck-cap" cx="103" cy="103" r="4.4"/><circle class="ck-cap-dot" cx="103" cy="103" r="1.4"/>';
  svg.innerHTML=h;
  primeHands(['wg-hr','wg-min','wg-sec']);
}

/* ── 走时与读数 ── */
/* ── 周序 — 年积 — 纪念倒数 ── */
var astroDay=-1;
function refreshAstro(d){
  var age=moonAge(d),ti=termInfo(d),e;
  e=$('#tpa-moon');if(e)e.innerHTML=moonSVG(age,17);
  e=$('#tpa-name');if(e)e.textContent=moonName(age);
  e=$('#tpa-illum');if(e)e.textContent=moonIllum(age)+'%';
  e=$('#tpa-term');if(e)e.textContent=ti.name;
  e=$('#tpa-next');if(e)e.textContent='第'+ti.dayN+'天';
}
function tick(){
  var n=new Date();
  var h24=n.getHours();
  var hh=p2(H24?h24:((h24%12)||12)),mm=p2(n.getMinutes()),ss=p2(n.getSeconds());
  [['tp-hh',hh],['tp-mm',mm],['tp-ss',ss],['wgt-hh',hh],['wgt-mm',mm],['wgt-ss',ss],
   ['tp-fdate',MEN[n.getMonth()]+' '+n.getDate()+', '+n.getFullYear()],
   ['wgt-date',WEN[n.getDay()]+' · '+MEN[n.getMonth()]+' '+n.getDate()+', '+n.getFullYear()]].forEach(function(a){
    var e=document.getElementById(a[0]);if(e&&e.textContent!==a[1])e.textContent=a[1]});
  var wd=WEN[n.getDay()],wde=document.getElementById('tp-week');
  if(wde&&wde.textContent!==wd)wde.textContent=wd;
  if(astroDay!==n.getDate()){astroDay=n.getDate();refreshAstro(n);
    var nd=new Date(n.getFullYear(),n.getMonth(),n.getDate());
    if(nd.getTime()!==TODAY.getTime()){TODAY=nd;try{if(curSheet)rebuildSheet();renderSelected();renderAnni();renderFeed()}catch(e){}}
  }
}

/* ── 页一 — 日程表（列全部事项按倒数排开，表头恒锚定今天） ── */
function renderSelected(){
  $('#ag-dd').textContent=TODAY.getDate();
  $('#ag-mm').textContent=MAB[TODAY.getMonth()];
  var rows=ITEMS.map(function(it){var o=nextOcc(it,TODAY);return{it:it,du:o?diffD(TODAY,o):9999}})
    .filter(function(r){return r.du<9999});
  if(HOLIDAY_ON)holidaysIn(TODAY,HOL_LEAD).forEach(function(h){rows.push({hol:h.name,du:h.du})});/* v40 — 开启传统节日提醒时，日程表并列临近的节日 */
  rows.sort(function(a,b){return a.du-b.du});
  $('#ag-sub').textContent=WEN[TODAY.getDay()]+', '+MEN[TODAY.getMonth()]+' '+TODAY.getDate()+' · 星期'+WCN[TODAY.getDay()];
  var list=$('#ag-list');
  if(!rows.length){
    list.innerHTML='<div class="ev-empty"><svg viewBox="0 0 24 24" stroke-width="1.3"><rect x="4" y="5.5" width="16" height="14" rx="3"/><path d="M8 3.5v3.5M16 3.5v3.5M4 10h16"/></svg><span>日程表还是空白</span><small>点「+」新建一条</small></div>';
  }else{
    list.innerHTML=rows.map(function(r){
      if(r.hol)return '<div class="ev-item"><i class="dt hd"></i><div><div class="et">'+esc(r.hol)+'</div></div><b class="ev-du">'+(r.du===0?'今天':'<span class="n">'+r.du+'</span><small>天后</small>')+'</b></div>';
      var it=r.it,cl=dotCls(it);
      return '<div class="ev-item"><i class="dt '+cl+'"></i><div><div class="et">'+esc(it.title)+'</div></div><b class="ev-du">'+(r.du===0?'今天':'<span class="n">'+r.du+'</span><small>天后</small>')+'</b></div>';
    }).join('');
  }
}
/* v38 — 点选日期的选中机制整体移除：今日格由构建时的 .today 类直接标出，特效在 CSS 中常驻 */

/* ── 显示常量：周起始固定周日（沿用通用网页日历式样）— 24 小时制 ── */
var WEEKSTART=0,H24=true;
function rebuildSheet(){
  var book=$('#cal-book');if(!book||anim)return;
  if(curSheet&&curSheet.parentNode)curSheet.remove();
  curSheet=buildSheet(curY,curM);
  book.appendChild(curSheet);
  syncYM();/* v37 — 窗头年月下拉随挂历联动 */
}

/* ── 挂历页构建（照原设计，未改动） ── */
function buildSheet(y,m){
  var sheet=el('div','cal-sheet');
  var h='<span class="hole h1"></span><span class="hole h2"></span><span class="hole h3"></span><span class="hole h4"></span><span class="hole h5"></span>';
  h+='<svg class="sheet-sakura sheet-sakura-a" viewBox="0 0 180 110" aria-hidden="true"><use href="#sym-sakura-spray-legacy"/></svg>';
  h+='<svg class="sheet-sakura sheet-sakura-b" viewBox="0 0 180 110" aria-hidden="true"><use href="#sym-sakura-spray-legacy"/></svg>';
  h+='<svg class="sheet-sakura sheet-sakura-title-petals" viewBox="0 0 146 52" aria-hidden="true"><use href="#sym-sakura-title-petals"/></svg>';
  h+='<div class="sheet-title"><div class="sh-mo"><span class="sh-mo-en">'+MEN[m]+'<span class="yr">'+y+'</span></span><span class="sh-mo-cn">'+MCN[m]+'</span></div>'
    +'<div class="sheet-nav"><button class="sn-btn" data-nav="-1" title="上一月"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg></button>'
    +'<button class="sn-btn" data-nav="1" title="下一月"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg></button></div></div>';
  h+='<div class="sheet-dow">';
  var DW=['SUN','MON','TUE','WED','THU','FRI','SAT'];
  for(var i=0;i<7;i++){var dwi=(i+WEEKSTART)%7;h+='<span'+((dwi===0||dwi===6)?' class="wknd"':'')+'>'+DW[dwi]+'</span>'}
  h+='</div><div class="sheet-grid">';
  var start=(new Date(y,m,1).getDay()-WEEKSTART+7)%7, dim=new Date(y,m+1,0).getDate(), prevDim=new Date(y,m,0).getDate();
  for(var c=0;c<42;c++){
    var dnum,cm=m,dimc=false;
    if(c<start){dnum=prevDim-start+1+c;cm=m-1;dimc=true}
    else if(c>=start+dim){dnum=c-start-dim+1;cm=m+1;dimc=true}
    else dnum=c-start+1;
    var dd=new Date(y,cm,dnum);
    var iso=isoOf(dd);
    var dots='',seen={};
    if(!dimc){
      dayItems(dd).forEach(function(it){
        var cl=dotCls(it);
        if(seen[cl])return;seen[cl]=1;dots+='<i class="dt '+cl+'"></i>'});
      if(HOLIDAY_ON&&holsOn(dd).length)dots+='<i class="dt hd"></i>';/* v40 — 节日黄点 */
    }
    var age=moonAge(new Date(dd.getFullYear(),dd.getMonth(),dd.getDate(),20));
    var isToday=dd.getTime()===TODAY.getTime();
    h+='<button class="cal-cell'+(dimc?' dim':'')+(isToday?' today':'')+'" data-date="'+iso+'">'
      +'<span class="dn">'+dnum+'</span>'+moonSVG(age,15)
      +'<span class="dots">'+dots+'</span></button>';
  }
  h+='</div><div class="sheet-legend"><span class="lg"><i class="dt an"></i>纪念与生日</span><span class="lg"><i class="dt cy"></i>计划</span><span class="lg"><i class="dt ev"></i>记录</span>'+(HOLIDAY_ON?'<span class="lg"><i class="dt hd"></i>传统节日</span>':'')+'</div>';
  sheet.innerHTML=h;
  return sheet;
}

/* ── 翻页（照原设计，未改动） ── */
var curY=TODAY.getFullYear(),curM=TODAY.getMonth(),curSheet=null,anim=false;
function spawnPetals(book){
  if(document.body.classList.contains('no-petals'))return;
  var n=7+Math.floor(Math.random()*4);
  for(var i=0;i<n;i++){
    var s=el('span','petal');
    var sz=(9+Math.random()*6).toFixed(1);
    s.style.left=(30+Math.random()*55)+'%';
    s.style.top=(8+Math.random()*46)+'%';
    s.style.width=sz+'px';s.style.height=sz+'px';
    s.style.setProperty('--px',(-(30+Math.random()*90)).toFixed(0)+'px');
    s.style.setProperty('--pr',(-(120+Math.random()*160)).toFixed(0)+'deg');
    s.style.setProperty('--pd',(2.2+Math.random()*0.8).toFixed(2)+'s');
    s.style.setProperty('--pdelay',(Math.random()*0.5).toFixed(2)+'s');
    s.innerHTML='<svg width="100%" height="100%" viewBox="-7 -7 14 14"><use href="#sym-floret"/></svg>';
    book.appendChild(s);
    (function(sp){setTimeout(function(NS){if(sp.parentNode)sp.remove()},3900)})(s);
  }
}
/* v39 — 可指定目标年月（ty/tm）：跨月跳转复用同一套翻页/插页动画。v40 — Now 键改走专属回位动画（nowReturn），不再经此路径；ty/tm 形参保留备用 */
function goMonth(dir,ty,tm){
  if(anim)return;anim=true;
  var ny,nm;
  if(ty!=null){ny=ty;nm=tm}
  else{ny=curY;nm=curM+dir;if(nm<0){nm=11;ny--} if(nm>11){nm=0;ny++}}
  var book=$('#cal-book');
  var fresh=buildSheet(ny,nm);
  if(dir<0){
    var dHolder=el('div','drop-holder');
    var dVeil=el('div','drop-veil');
    curSheet.appendChild(dVeil);
    dHolder.appendChild(fresh);
    book.appendChild(dHolder);
    spawnPetals(book);
    requestAnimationFrame(function(NS){requestAnimationFrame(function(NS){
      dHolder.classList.add('drop-go');dVeil.classList.add('drop-go');
    })});
    var dDone=false;
    var dFinish=function(){
      if(dDone)return;dDone=true;
      book.appendChild(fresh);dHolder.remove();
      if(dVeil.parentNode)dVeil.remove();
      if(curSheet&&curSheet.parentNode)curSheet.remove();
      curSheet=fresh;curY=ny;curM=nm;anim=false;
      syncYM();/* v37 */
    };
    dHolder.addEventListener('animationend',function(e){if(e.target===dHolder)dFinish()});
    setTimeout(dFinish,1650);
    return;
  }
  var holder=el('div','flip-holder');
  var front=el('div','flip-face front');
  var back=el('div','flip-face back');
  var shade=el('div','flip-shade');
  var cast=el('div','flip-cast');
  holder.appendChild(front);holder.appendChild(back);holder.appendChild(shade);
  front.appendChild(curSheet);
  book.appendChild(fresh);fresh.appendChild(cast);
  book.appendChild(holder);
  spawnPetals(book);
  requestAnimationFrame(function(NS){requestAnimationFrame(function(NS){
    holder.classList.add('go');
    cast.classList.add('go');
  })});
  var done=false;
  function finish(){
    if(done)return;done=true;
    holder.remove();
    if(cast.parentNode)cast.remove();
    curSheet=fresh;curY=ny;curM=nm;anim=false;
    syncYM();/* v37 */
  }
  holder.addEventListener('animationend',function(e){if(e.target===holder)finish()});
  setTimeout(finish,1900);
}

/* ── v37 — 窗头年月下拉：选定即跳转挂历显示的月份；翻页与重建时反向回写 ── */
var selHY=null,selHM=null;
function syncYM(){
  if(selHY)selHY.set(Math.max(0,Math.min(150,curY-1950)));
  if(selHM)selHM.set(curM);
  syncNow();
}
/* v40 — Now：回到当前月份走专属「回位」动画（旧页上浮消散，当前月轻落定格），与翻页/插页不同源；已在当月时置灰 */
function syncNow(){
  var b=$('#eph-now');if(!b)return;
  b.disabled=(curY===TODAY.getFullYear()&&curM===TODAY.getMonth());
}
function nowReturn(ny,nm){
  if(anim)return;anim=true;
  var book=$('#cal-book');
  var fresh=buildSheet(ny,nm);
  fresh.classList.add('now-in');
  var old=curSheet;
  if(old)old.classList.add('now-out');
  book.appendChild(fresh);
  spawnPetals(book);
  var done=false;
  function fin(){
    if(done)return;done=true;
    fresh.classList.remove('now-in');
    if(old&&old.parentNode)old.remove();
    curSheet=fresh;curY=ny;curM=nm;anim=false;
    syncYM();
  }
  fresh.addEventListener('animationend',function(e){if(e.target===fresh)fin()});
  setTimeout(fin,1000);
}
function goNow(){
  if(anim)return;
  var ty=TODAY.getFullYear(),tm=TODAY.getMonth();
  if(ty===curY&&tm===curM)return;
  nowReturn(ty,tm);
}
function jumpYM(){
  if(!selHY||!selHM)return;
  if(anim){syncYM();return}/* 翻页动画中不跳，回写当前月份 */
  var ny=1950+selHY.get(),nm=selHM.get();
  if(ny===curY&&nm===curM)return;
  curY=ny;curM=nm;rebuildSheet();
}

/* ── 页二 — 日程（原纪念日页） ── */
var heroAI=0;
function anniDateLine(it){
  var b=itemDate(it),e=itemEndDate(it);if(!b)return '—';
  var hasEnd=!!(e&&(it.repeat!=='once'||e.getTime()>b.getTime()));
  var d=b.getFullYear()+'年'+(b.getMonth()+1)+'月'+b.getDate()+'日';
  if(hasEnd)d+=' — '+e.getFullYear()+'年'+(e.getMonth()+1)+'月'+e.getDate()+'日';
  if(it.repeat==='yearly')return d+' · 每年';
  if(it.repeat==='monthly')return d+' · 每月';
  if(it.repeat==='weekly')return d+' · 每周'+wdText(it,b);
  if(it.repeat==='daily')return d+' · 每天';
  return d+(hasEnd?' · 连续':' · 单次');
}
/* v44 — 挂历圆点改按事项类型分色，与图例一一对应：纪念日/生日 → an，计划 → cy，记录 → ev。
   原先按「是否循环」分类，连续的记录会落进「单次事项」那一色，图例语义对不上。 */
function dotCls(it){return (it.kind==='anniv'||it.kind==='birthday')?'an':(it.kind==='plan'?'cy':'ev')}
function rowHTML(it,du){
  var b=it.date?itemDate(it):null,e=itemEndDate(it),hasRange=!!(b&&e&&e.getTime()>b.getTime());
  var dbTop=it.repeat==='daily'?'每日':(it.repeat==='weekly'?(itemWeekdays(it,b).length>1?'每周':'周'+wdText(it,b)):(b?p2(b.getDate()):'—'));
  var dbSub=it.repeat==='daily'?'DAILY':(it.repeat==='weekly'?'WEEKLY':(b?MAB[b.getMonth()]:''));
  var chip=du===0?'今天':(du>=9999?'—':'<b>'+du+'</b><small>天后</small>');
  var cl=dotCls(it);
  var rep=it.repeat==='yearly'?'每年':it.repeat==='weekly'?'每周'+wdText(it,b):it.repeat==='monthly'?'每月':it.repeat==='daily'?'每天':hasRange?'连续':'单次';
  var meta=[rep];
  if(e&&(it.repeat!=='once'||hasRange))meta.push((it.repeat==='once'?'至 ':'截至 ')+isoOf(e).replace(/-/g,'/'));
  if(it.kind==='anniv'&&b&&TODAY.getTime()>=b.getTime())meta.push('已相伴 '+diffD(b,TODAY)+' 天');
  if(it.remind){var ld=(it.lead!=null)?it.lead:LEAD;meta.push(ld===0?'当天提醒便笺':'提前 '+ld+' 天提醒便笺')}/* v40 — 原「每年 — 便笺」表意含混，改为写明提前天数的完整短语 */
  var priv='<span class="tagb'+(it.vis!=='all'?' priv':'')+'">'+visLabel(it.vis)+'</span>';
  return '<div class="anni-row"><span class="ar-db"><b>'+dbTop+'</b><small>'+dbSub+'</small></span>'
   +'<span class="ar-main"><span class="ar-name"><i class="dt '+cl+'"></i>'+esc(it.title)+'</span>'
   +'<span class="ar-sub">'+priv+'<span>'+meta.join(' · ')+'</span></span></span>'
   +'<span class="ar-chip'+(du<=7?' near':'')+'">'+chip+'</span>'
   +(it.id?'<button class="ar-edit" data-edit="'+esc(it.id)+'" title="编辑此事项">✎</button><button class="ar-del" data-del="'+esc(it.id)+'" title="删除此事项">✕</button>':'')+'</div>';
}
function meetHero(a){
  var iso=meetIso(a.id);
  var head='<div class="anni-hero">'
   +'<button class="ah-prev" title="切换到上一位 AI"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 7.5 8l4.5 4.5"/><path d="M7.5 3.5 3 8l4.5 4.5"/></svg></button>'
   +'<div class="ah-body"><div class="ah-l">';
  var tail='<button class="ah-next" title="切换到下一位 AI"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3.5 8.5 8 4 12.5"/><path d="M8.5 3.5 13 8l-4.5 4.5"/></svg></button>'
   +'</div>';
  if(!iso){
    return head
     +'<div class="ah-name">与 '+esc(a.name)+' 的相遇纪念日</div>'
     +'<div class="ah-date">尚无聊天记录 — 第一次对话的日子会记在这里</div>'
     +'<div class="ah-meta"><span class="tagb priv">'+esc(a.model)+'</span></div></div>'
     +'<div class="ah-r"><div class="ah-num">—</div><div class="ah-unit">No record</div></div></div>'
     +tail;
  }
  var it={kind:'anniv',title:'与 '+a.name+' 的相遇纪念日',date:iso,repeat:'yearly',vis:'ai:'+a.id};
  var b=itemDate(it);
  var o=nextOcc(it,TODAY),du=o?diffD(TODAY,o):9999;
  var comp=(b&&TODAY.getTime()>=b.getTime())?diffD(b,TODAY):0;
  var pct=Math.max(0,Math.min(1,(365-du)/365));
  var big=du===0?'今天':String(du),unit=du===0?'Today — 就是这一天':'Days · 倒计时';
  return head
   +'<div class="ah-name">'+esc(it.title)+'</div>'
   +'<div class="ah-date">'+anniDateLine(it)+'</div>'
   +'<div class="ah-meta"><span class="tagb priv">'+esc(a.model)+'</span><span class="tagb">已相伴 '+comp+' 天</span></div>'
   +'<div class="ah-bar"><i style="width:'+(pct*100).toFixed(1)+'%"></i></div></div>'
   +'<div class="ah-r"><div class="ah-num'+(du===0?' now':'')+'">'+big+'</div><div class="ah-unit">'+unit+'</div></div></div>'
   +tail;
}
/* v37 — 首页：与站点本身的相遇纪念日；站名随主题由 CSS 联动切换 */
function ibNameHTML(){return '与 <span class="ibn-int">Internal</span><span class="ibn-inf">Infernal</span> Beyond 的相遇纪念日'}
function ibHero(){
  var iso=meetIsoIB(),total=AIS.length+1;
  var head='<div class="anni-hero">'
   +'<button class="ah-prev" title="切换到上一位"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 7.5 8l4.5 4.5"/><path d="M7.5 3.5 3 8l4.5 4.5"/></svg></button>'
   +'<div class="ah-body"><div class="ah-l">';
  var tail='<button class="ah-next" title="切换到下一位"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3.5 8.5 8 4 12.5"/><path d="M8.5 3.5 13 8l-4.5 4.5"/></svg></button>'
   +'</div>';
  if(!iso){
    return head
     +'<div class="ah-name">'+ibNameHTML()+'</div>'
     +'<div class="ah-date">尚无记录 — 第一次在这里说话的日子会记在这里</div>'
     +'<div class="ah-meta"><span class="tagb">全部日程</span></div></div>'
     +'<div class="ah-r"><div class="ah-num">—</div><div class="ah-unit">No record</div></div></div>'
     +tail;
  }
  var it={kind:'anniv',title:'',date:iso,repeat:'yearly',vis:'all'};
  var b=itemDate(it);
  var o=nextOcc(it,TODAY),du=o?diffD(TODAY,o):9999;
  var comp=(b&&TODAY.getTime()>=b.getTime())?diffD(b,TODAY):0;
  var pct=Math.max(0,Math.min(1,(365-du)/365));
  var big=du===0?'今天':String(du),unit=du===0?'Today — 就是这一天':'Days · 倒计时';
  return head
   +'<div class="ah-name">'+ibNameHTML()+'</div>'
   +'<div class="ah-date">'+anniDateLine(it)+'</div>'
   +'<div class="ah-meta"><span class="tagb">全部日程</span><span class="tagb">已相伴 '+comp+' 天</span></div>'
   +'<div class="ah-bar"><i style="width:'+(pct*100).toFixed(1)+'%"></i></div></div>'
   +'<div class="ah-r"><div class="ah-num'+(du===0?' now':'')+'">'+big+'</div><div class="ah-unit">'+unit+'</div></div></div>'
   +tail;
}
function renderAnni(dir){
  var heroBox=$('#anni-hero'),list=$('#anni-list'),lab=$('#anni-vislab');
  if(heroAI>=AIS.length+1)heroAI=0;
  if(heroAI===0){/* v37 — 首页：站点纪念日 + 全部日程（无论可见范围） */
    if(heroBox){
      heroBox.innerHTML=ibHero();
      if(dir){var bd0=$('.ah-body',heroBox);if(bd0)bd0.classList.add(dir==='prev'?'anim-prev':'anim-next')}
    }
    var rowsA=ITEMS.map(function(it){var o=nextOcc(it,TODAY);return {it:it,du:o?diffD(TODAY,o):9999}})
      .filter(function(r){return r.du<9999})
      .sort(function(x,y){return x.du-y.du});
    if(lab)lab.textContent='All — 全部日程 · '+rowsA.length+' 项';
    if(list)list.innerHTML=rowsA.length?rowsA.map(function(r){return rowHTML(r.it,r.du)}).join(''):'<div class="ps-note" style="padding:6px 2px">还没有任何日程。点右上「新建」记下第一条。</div>';
  }else{
    var a=AIS[heroAI-1];
    if(heroBox){
      heroBox.innerHTML=meetHero(a);
      if(dir){var bd=$('.ah-body',heroBox);if(bd)bd.classList.add(dir==='prev'?'anim-prev':'anim-next')}
    }
    var canRead=perm(a.id)[0];
    var rows=ITEMS.filter(function(it){return visibleTo(it,a.id)})
      .map(function(it){var o=nextOcc(it,TODAY);return {it:it,du:o?diffD(TODAY,o):9999}})
      .filter(function(r){return r.du<9999})
      .sort(function(x,y){return x.du-y.du});
    if(lab)lab.textContent=canRead?('Visible — 对 '+a.name+' 可见的日程 · '+rows.length+' 项'):('Visible — 对 '+a.name+' 可见的日程');
    if(list){
      if(!canRead)list.innerHTML='<div class="ps-note" style="padding:6px 2px">'+esc(a.name)+' 的读取权限已关闭，暂时看不到任何日程。可在设置页重新开启。</div>';
      else if(!rows.length)list.innerHTML='<div class="ps-note" style="padding:6px 2px">还没有对 '+esc(a.name)+' 可见的日程。</div>';
      else list.innerHTML=rows.map(function(r){return rowHTML(r.it,r.du)}).join('');
    }
  }
  var all=ITEMS.map(function(it){var o=nextOcc(it,TODAY);return {it:it,du:o?diffD(TODAY,o):9999}}).sort(function(x,y){return x.du-y.du});
  var rem=all.filter(function(r){return r.du<9999&&r.it.remind&&r.it.vis!=='self'})[0];
  var e=$('#anni-fore');
  if(e)e.innerHTML=!ALLOW_NOTES?'日历接入总开关已在设置页关闭，AI 暂不读取日程、不写便笺。':(rem?((rem.du===0?'「'+esc(rem.it.title)+'」今天处于提醒窗口。':'距「'+esc(rem.it.title)+'」还有 <b>'+rem.du+' 天</b>。')+'有读取权限且可见的 AI 会在'+((rem.it.lead!=null?rem.it.lead:LEAD)===0?'当天':'提前 '+(rem.it.lead!=null?rem.it.lead:LEAD)+' 天内')+'提起并写便笺。'):'暂无可供 AI 提醒的事项。');
  e=$('#anni-notesum');
  if(e){
    var latest=NOTES[0];
    e.innerHTML=ALLOW_NOTES?('共 <b>'+NOTES.length+'</b> 条便笺'+(latest?('，最近来自 '+esc(latest.aiName||aiName(latest.ai))+'。'):'。')):'日历接入总开关已在设置页关闭。';
  }
}

/* ── 页三 — 新建（v36：即时预览已撤） ── */
var selY,selM,selD,selRep,selVis,selLead;
var LEADS=[0,1,2,3,5,7,14,30,-1];/* v35 — 提前档位；-1=自定义 */
var VIS_OPTS=[];
function repKey(i){return i===0?'yearly':i===1?'monthly':i===2?'weekly':i===3?'daily':'once'}
function curKind(){var b=$('#kind-seg button.on');return b?b.dataset.k:'anniv'}
function selectedStartIso(){return selY&&selM&&selD?(1950+selY.get())+'-'+p2(selM.get()+1)+'-'+p2(selD.get()+1):''}
function syncReminderUI(){var r=$('#f-remind'),l=$('#lead-row');if(r&&l)l.style.display=r.checked?'':'none'}
function syncVisibilityReminder(){var o=selVis&&VIS_OPTS[selVis.get()],r=$('#f-remind');if(o&&o.v==='self'&&r&&r.checked){r.checked=false;syncReminderUI()}}
function syncKindUI(kind,defaults){
  var c={anniv:['例如：与 Sui 的相遇纪念日',0,0,0,1],birthday:['例如：My Birthday',0,0,0,1],plan:['例如：学习计划',1,4,0,1],memo:['例如：写作进度记录',1,4,-1,0]}[kind]||[];
  $('#f-title').placeholder=c[0]||'事项标题';$('#end-date-row').style.display=c[1]?'':'none';
  if(!c[1]){$('#f-end-date').value='';$('#f-end-date').dataset.valid=''}
  $('#date-repeat-label').textContent=c[1]?'Start Date & Repeat — 开始日期与重复':'Date & Repeat — 日期与重复';
  if(defaults&&selRep)selRep.set(c[2]);if(defaults&&selVis)selVis.set(c[3]<0?VIS_OPTS.length-1:c[3]);
  if(defaults&&$('#f-remind')){$('#f-remind').checked=!!c[4];syncVisibilityReminder();syncReminderUI()}
  syncRepeatUI();syncVisUI();
}
/* ── v44 — 每周多选与可见范围多选的界面同步 ── */
function visPicked(){return $$('#vis-pick button.on').map(function(b){return b.dataset.ai})}
function renderVisPick(sel){
  var p=$('#vis-pick');if(!p)return;
  sel=sel||[];
  p.innerHTML=AIS.length?AIS.map(function(a){return '<button type="button" data-ai="'+esc(a.id)+'"'+(sel.indexOf(a.id)>=0?' class="on"':'')+'>'+esc(a.name)+'</button>'}).join('')
    :'<span class="f-hint" style="margin:0">还没有已配置的 API 好友</span>';
}
function syncVisUI(){
  var o=selVis&&VIS_OPTS[selVis.get()],p=$('#vis-pick');
  if(p)p.style.display=(o&&o.v==='multi')?'':'none';
}
function syncRepeatUI(){
  var row=$('#wd-row');if(!row)return;
  var on=!!(selRep&&repKey(selRep.get())==='weekly');
  row.style.display=on?'':'none';
  if(on&&!$$('#wd-pick button.on').length){
    var b=calDate(selectedStartIso())||TODAY,btn=$('#wd-pick button[data-w="'+b.getDay()+'"]');
    if(btn)btn.classList.add('on');
  }
}
function applyEndInput(inp){
  var iso=parseMeetDate(inp.value),prev=inp.dataset.valid||'',start=selectedStartIso();
  if(iso===null){toast('没认出这个日期，试试 2026-10-31 这样的写法');inp.value=prev;return null}
  if(iso&&start&&iso<start){toast('结束日期不能早于开始日期');inp.value=prev&&prev>=start?prev:'';inp.dataset.valid=inp.value;inp.focus();return null}
  inp.value=iso;inp.dataset.valid=iso;return iso;
}
/* v41 — 备注长度：中文字计 2、其余计 1，上限 60（即 30 个中文字符） */
function noteTrim(s){
  s=String(s||'');
  var n=0,out='';
  for(var i=0;i<s.length;i++){
    var w=s.charCodeAt(i)>255?2:1;
    if(n+w>60)break;
    n+=w;out+=s.charAt(i);
  }
  return out;
}
function formItem(end){
  var y=1950+selY.get(),m=selM.get(),d=selD.get()+1,rep=repKey(selRep.get()),kind=curKind();
  var vis=VIS_OPTS[selVis.get()].v;
  if(vis==='multi'){var ids=visPicked();vis=ids.length>1?'ais:'+ids.join('|'):(ids.length===1?'ai:'+ids[0]:'self')}/* v44 — 多选落库 */
  var it={kind:kind,title:(($('#f-title').value)||'').trim(),
    date:y+'-'+p2(m+1)+'-'+p2(d),repeat:rep,vis:vis,
    remind:vis!=='self'&&$('#f-remind').checked};
  if((kind==='plan'||kind==='memo')&&end&&(rep!=='once'||end!==it.date))it.endDate=end;
  var nv=noteTrim(((($('#f-note')||{}).value)||'').trim());
  if(nv)it.note=nv;
  var lv=selLead?LEADS[selLead.get()]:LEAD;
  it.lead=lv<0?Math.max(0,Math.min(365,parseInt(($('#f-lead-custom')||{}).value,10)||0)):lv;
  if(rep==='weekly'){/* v44 — 多选星期；同时写入单个 weekday，旧版本读到也不会失效 */
    var ws=$$('#wd-pick button.on').map(function(x){return +x.dataset.w}).sort(function(p,q){return p-q});
    if(!ws.length)ws=[new Date(y,m,d).getDay()];
    it.weekdays=ws;it.weekday=ws[0];
  }
  return it;
}

/* ── v44 — 编辑已有事项：行卡「✎」把整条事项回填进新建表单，保存即就地更新 ── */
var EDIT_ID=null;
function clearEdit(){
  EDIT_ID=null;
  var s=$('#btn-save');if(s)s.textContent='保存';
  var bn=$('#edit-banner');if(bn)bn.textContent='';
  var t=$('#f-title');if(t)t.value='';
  var n=$('#f-note');if(n)n.value='';
  var e=$('#f-end-date');if(e){e.value='';e.dataset.valid=''}
}
function fillForm(it){
  EDIT_ID=it.id;
  var kind=it.kind||'anniv';
  $$('#kind-seg button').forEach(function(x){x.classList.toggle('on',x.dataset.k===kind)});
  syncKindUI(kind,false);
  $('#f-title').value=it.title||'';
  var b=itemDate(it)||TODAY;
  selY.set(Math.max(0,Math.min(2100,b.getFullYear())-1950));
  selM.set(b.getMonth());
  var nD=new Date(b.getFullYear(),b.getMonth()+1,0).getDate(),opts=[];
  for(var i=1;i<=nD;i++)opts.push(p2(i)+' 日');
  selD.setOpts(opts,b.getDate()-1);
  var rk={yearly:0,monthly:1,weekly:2,daily:3,once:4}[it.repeat||'once'];
  selRep.set(rk==null?4:rk);
  var ws=itemWeekdays(it,b);
  $$('#wd-pick button').forEach(function(x){x.classList.toggle('on',ws.indexOf(+x.dataset.w)>=0)});
  syncRepeatUI();
  var v=String(it.vis||'self'),vi;
  if(v.indexOf('ais:')===0){
    /* v45 — 名单里已被移除的 AI 先剔掉；剩两位以上走「指定多位」，剩一位退成单选那一档，剩零位退成仅自己 */
    var ids=v.slice(4).split('|').filter(function(x){return AIS.some(function(a){return a.id===x})});
    renderVisPick(ids);
    if(ids.length>1)vi=VIS_OPTS.findIndex(function(o){return o.v==='multi'});
    else if(ids.length===1)vi=VIS_OPTS.findIndex(function(o){return o.v==='ai:'+ids[0]});
    else vi=-1;
  }else{
    renderVisPick([]);
    vi=VIS_OPTS.findIndex(function(o){return o.v===v});
  }
  if(vi<0)vi=VIS_OPTS.length-1;
  selVis.set(vi);syncVisUI();
  var nt=$('#f-note');if(nt)nt.value=it.note||'';
  var ed=$('#f-end-date');if(ed){ed.value=it.endDate||'';ed.dataset.valid=it.endDate||''}
  var rm=$('#f-remind');if(rm)rm.checked=!!it.remind;
  syncReminderUI();
  var lv=(it.lead!=null)?it.lead:LEAD,li=LEADS.indexOf(lv),lc=$('#f-lead-custom');
  if(li<0){li=LEADS.length-1;if(lc){lc.value=lv;lc.style.display=''}}
  else if(lc)lc.style.display='none';
  if(selLead)selLead.set(li);
  var sv=$('#btn-save');if(sv)sv.textContent='保存修改';
  var bn=$('#edit-banner');if(bn)bn.textContent='正在编辑：'+(it.title||'未命名事项');
  switchTab('new');
}

/* ── 页四 — 留言（集成版：读 calNotes 库） ── */
var faNotes='all';
function renderFeed(){
  var feed=$('#feed');if(!feed)return;
  var rows=NOTES.filter(function(n){return faNotes==='all'||n.ai===faNotes});
  var off=!ALLOW_NOTES?'<div class="ps-card"><div class="ps-note">日历接入已关闭：AI 不再读取日程或新增便笺，历史便笺仍可查看。</div></div>':'';
  if(!rows.length){feed.innerHTML=off+'<div class="ps-card"><div class="ps-note">还没有便笺。开启提醒的日程临近时，拥有留言权限的 AI 会在聊天中写下第一张。</div></div>';return}
  feed.innerHTML=off+rows.map(function(n){
    var d=new Date(n.ts||Date.now());
    return '<div class="cal-lc">'
     +'<button class="lc-del" data-note-del="'+esc(n.id)+'" title="删除">✕</button>'
     +'<div class="lc-top"><span class="lc-ai"><i class="lc-dot"></i>'+esc(n.aiName||aiName(n.ai))+'</span>'+(n.itemTitle?'<span class="lc-ref">「'+esc(n.itemTitle)+'」</span>':'')+'<span class="lc-date">'+d.getFullYear()+'/'+p2(d.getMonth()+1)+'/'+p2(d.getDate())+'</span></div>'
     +'<div class="lc-body">'+esc(n.body||'')+'</div></div>';
  }).join('');
}
$('#feed').addEventListener('click',async function(e){
  var b=e.target.closest('[data-note-del]');if(!b)return;
  e.stopPropagation();
  var id=b.dataset.noteDel;
  try{await dbDelete('calNotes',id)}catch(e2){toast('删除失败，请重试');return}
  NOTES=NOTES.filter(function(n){return n.id!==id});
  renderFeed();renderAnni();
  toast('已删除该便笺');
});

/* ── 页五 — 设定：下拉选一位 AI，再单独调 TA 的两枚权限与相遇纪念日 ── */
var selAI=null;
function renderMatrix(){
  var b=$('#ai-matrix-body');if(!b)return;
  if(!AIS.length){
    b.innerHTML='<span class="ps-note" style="display:block;padding:6px 0 12px">还没有已配置的 API 好友。在 API 页面添加后，这里可以逐位设置读取与留言权限。</span>';
    renderMeetRow();return;
  }
  var a=AIS[Math.min(selAI?selAI.get():0,AIS.length-1)],st=perm(a.id);
  if(!st[0]&&st[1]){st=[0,0];AISTATE[a.id]=st;saveCalSettings()}
  b.innerHTML='<span class="aiw">读取<label class="ib-switch"><input type="checkbox" data-ai="'+esc(a.id)+'" data-k="0"'+(st[0]?' checked':'')+'><span class="kn"></span></label></span>'
    +'<span class="aiw"'+(!st[0]?' title="需先开启读取"':'')+'>留言<label class="ib-switch"><input type="checkbox" data-ai="'+esc(a.id)+'" data-k="1"'+(st[1]?' checked':'')+(!st[0]?' disabled':'')+'><span class="kn"></span></label></span>';
  renderMeetRow();
}
/* v37 — 相遇纪念日改手动输入识别：写下日期即手动指定，清空恢复自动；「自动」键与三枚下拉已撤 */
var _meetAid=null;
function meetPH(iso){return iso?('自动 · '+iso):'自动 · 尚无聊天记录'}
function renderMeetRow(){
  var row=$('#meet-row'),inp=$('#meet-input');
  if(row&&inp){
    if(!AIS.length){row.style.display='none';_meetAid=null}
    else{
      row.style.display='';
      var a=AIS[Math.min(selAI?selAI.get():0,AIS.length-1)];
      _meetAid=a.id;
      inp.value=MEETSET[a.id]||'';
      inp.placeholder=meetPH(MEETS[a.id]?isoOf(new Date(MEETS[a.id])):null);
    }
  }
  var ibInp=$('#meet-ib-input');
  if(ibInp){
    ibInp.value=MEETSET[IB_KEY]||'';
    ibInp.placeholder=meetPH(MEET_IB!=null?isoOf(new Date(MEET_IB)):null);
  }
}
/* 宽松识别：2025-3-14 / 2025/3/14 / 2025.3.14 / 2025年3月14日 / 20250314 */
function parseMeetDate(s){
  s=String(s||'').trim();
  if(!s)return '';
  var m=s.match(/^(\d{4})\s*[-\/\.年]\s*(\d{1,2})\s*[-\/\.月]\s*(\d{1,2})\s*日?$/)||s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if(!m)return null;
  var y=+m[1],mo=+m[2],d=+m[3];
  if(y<1900||y>2100||mo<1||mo>12||d<1||d>31)return null;
  var dt=new Date(y,mo-1,d);
  if(dt.getMonth()!==mo-1||dt.getDate()!==d)return null;
  return y+'-'+p2(mo)+'-'+p2(d);
}
function applyMeetInput(inp,key){
  var iso=parseMeetDate(inp.value);
  if(iso===null){toast('没认出这个日期，试试 2025-03-14 这样的写法');renderMeetRow();return}
  if(iso===''){
    if(MEETSET[key]){delete MEETSET[key];saveCalSettings();toast('已改回按第一条聊天记录推算')}
  }else{
    MEETSET[key]=iso;saveCalSettings();toast('相遇纪念日已记为 '+iso);
  }
  renderMeetRow();renderAnni();
}

/* ── 自绘下拉 ── */
function closeAllSelects(){$$('.ib-select.open').forEach(function(s){s.classList.remove('open')})}
function makeSelect(hostId,opts,selIdx,onPick){
  var host=document.getElementById(hostId);if(!host)return null;
  var st={i:selIdx,opts:opts};
  host.innerHTML='<button type="button" class="ibs-face" aria-haspopup="listbox"><span class="ibs-val"></span>'
    +'<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg></button>'
    +'<div class="ibs-menu" role="listbox"></div>';
  var face=$('.ibs-face',host),val=$('.ibs-val',host),menu=$('.ibs-menu',host);
  function paint(){
    val.textContent=st.opts[st.i];
    menu.innerHTML=st.opts.map(function(o,i){return '<button type="button" class="ibs-opt'+(i===st.i?' on':'')+'" data-i="'+i+'" role="option">'+o+'</button>'}).join('');
  }
  paint();
  face.addEventListener('click',function(e){e.stopPropagation();
    var open=host.classList.contains('open');
    closeAllSelects();
    if(!open){host.classList.add('open');
      var on=$('.ibs-opt.on',menu);if(on&&on.scrollIntoView)on.scrollIntoView({block:'nearest'})}
  });
  menu.addEventListener('click',function(e){var b=e.target.closest('.ibs-opt');if(!b)return;e.stopPropagation();
    st.i=+b.dataset.i;paint();host.classList.remove('open');if(onPick)onPick(st.i)});
  return {
    get:function(){return st.i},
    set:function(i){st.i=i;paint()},
    setOpts:function(o,i){st.opts=o;st.i=Math.min(i!=null?i:st.i,o.length-1);paint()}
  };
}
document.addEventListener('click',closeAllSelects);

/* 组合坞入口由主站坞承接（#cal-mini），预览页的复刻坞未并入 */

/* ── 视窗 — 部件 ── */
var win=$('#eph-win'),widget=$('#cal-widget');
var winOX=0,winOY=0,curTab='cal';
function applyDrag(){win.style.transform='translate(calc(-50% + '+winOX+'px),calc(-50% + '+winOY+'px)) scale(1)'}
function switchTab(id){
  curTab=id;
  $$('.eph-tab').forEach(function(t){var on=t.dataset.tab===id;t.classList.toggle('on',on);t.setAttribute('aria-selected',on?'true':'false')});
  $$('.eph-page').forEach(function(p){p.classList.toggle('on',p.dataset.page===id)});
}
function openEph(tab){
  widget.classList.remove('show','open');
  win.classList.remove('to-widget');
  win.style.opacity='';
  win.classList.add('show');
  /* v37 — 「打开时回到今天」开关已撤：重开视窗一律回到当前月份 */
  if(curSheet&&!anim&&(curY!==TODAY.getFullYear()||curM!==TODAY.getMonth())){
    curY=TODAY.getFullYear();curM=TODAY.getMonth();rebuildSheet();
  }
  switchTab(tab||curTab||'cal');
  syncPetalField();
}
/* v39 — 关闭照 ICode 同款：不播退场过渡，直接隐藏（先抑制一帧过渡，避免半帧残影） */
function closeEph(){
  win.style.transition='none';
  win.classList.remove('show','to-widget');
  win.style.transform='';win.style.opacity='';winOX=0;winOY=0;
  widget.classList.remove('show','open');
  void win.offsetWidth;
  win.style.transition='';
  syncPetalField();
}
function widgetW(){return 300}
function widgetCenter(){
  var r=widget.getBoundingClientRect();
  if(r.width>0)return {x:r.left+r.width/2,y:r.top+64};
  return {x:innerWidth-26-widgetW()/2,y:86+64};
}
function minimizeToWidget(){
  if(!win.classList.contains('show'))return;
  var wr=win.getBoundingClientRect(),t=widgetCenter();
  var dx=t.x-(wr.left+wr.width/2), dy=t.y-(wr.top+wr.height/2);
  win.classList.add('to-widget');
  win.style.transform='translate(calc(-50% + '+(winOX+dx)+'px),calc(-50% + '+(winOY+dy)+'px)) scale(0.07)';
  win.style.opacity='0';
  setTimeout(function(NS){
    win.classList.remove('show','to-widget');
    win.style.transform='';win.style.opacity='';winOX=0;winOY=0;
    widget.classList.add('show');
    syncPetalField();
    toast('已收为悬浮小窗。点右下角日历图标可展开。');/* v47 */
  },430);
}
function restoreFromWidget(){
  widget.classList.remove('show','open');
  openEph(curTab);
}


/* 视窗拖拽（注水联动已移除） */
(function(NS){
  var head=$('#eph-head'),st=null;
  head.addEventListener('pointerdown',function(e){
    if(e.target.closest('button'))return;
    st={x:e.clientX,y:e.clientY,ox:winOX,oy:winOY};
    win.classList.add('dragging');head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove',function(e){
    if(!st)return;
    var lim=function(x){return Math.max(-(innerWidth/2-90),Math.min(innerWidth/2-90,x))};
    var limY=function(y){return Math.max(-(innerHeight/2-56),Math.min(innerHeight/2-56,y))};
    winOX=lim(st.ox+e.clientX-st.x);winOY=limY(st.oy+e.clientY-st.y);applyDrag();
  });
  var up=function(){if(!st)return;st=null;win.classList.remove('dragging')};
  head.addEventListener('pointerup',up);head.addEventListener('pointercancel',up);
})();
/* 部件拖拽 */
(function(NS){
  var mainZone=$('#wg-main'),st=null;
  mainZone.addEventListener('pointerdown',function(e){
    if(e.target.closest('button'))return;
    var r=widget.getBoundingClientRect();
    widget.style.left=r.left+'px';widget.style.top=r.top+'px';widget.style.right='auto';
    st={x:e.clientX,y:e.clientY,l:r.left,t:r.top,w:r.width,h:r.height};
    widget.classList.add('dragging');mainZone.setPointerCapture(e.pointerId);
  });
  mainZone.addEventListener('pointermove',function(e){
    if(!st)return;
    var l=Math.max(8,Math.min(innerWidth-st.w-8,st.l+e.clientX-st.x));
    var t=Math.max(8,Math.min(innerHeight-72,st.t+e.clientY-st.y));
    widget.style.left=l+'px';widget.style.top=t+'px';
    syncPetalOrigin();
  });
  var up=function(){if(!st)return;st=null;widget.classList.remove('dragging')};
  mainZone.addEventListener('pointerup',up);mainZone.addEventListener('pointercancel',up);
})();

/* ── toast 沿用主站全局；主题随主站 body.theme-infernal，无独立切换 ── */
var toast=(typeof window.toast==='function')?window.toast:function(){};

/* ── 事件 ── */
document.addEventListener('click',function(e){
  var tab=e.target.closest('.eph-tab');
  if(tab){if(EDIT_ID)clearEdit();switchTab(tab.dataset.tab);return}
  var go=e.target.closest('[data-goto]');
  if(go&&win.contains(go)){if(EDIT_ID)clearEdit();switchTab(go.dataset.goto);return}
});
$('#cal-book').addEventListener('click',function(e){
  var nav=e.target.closest('.sn-btn');if(nav){goMonth(+nav.dataset.nav);return}
});/* 日历格仅作展示；新建日程统一由「新建」入口进入，避免误触跳页。 */
$('#eph-close').addEventListener('click',closeEph);
$('#eph-min').addEventListener('click',minimizeToWidget);
$('#wg-restore').addEventListener('click',restoreFromWidget);
$('#wg-close').addEventListener('click',function(){widget.classList.remove('show','open');syncPetalField()});
$('#wg-main').addEventListener('dblclick',restoreFromWidget);
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    if(win.classList.contains('show'))minimizeToWidget();
  }
});
$('#anni-hero').addEventListener('click',function(e){
  var total=AIS.length+1;/* v37 — 0 号页是站点纪念日 */
  if(total<=1)return;
  var pv=e.target.closest('.ah-prev'),nx=e.target.closest('.ah-next');
  if(pv){heroAI=(heroAI-1+total)%total;renderAnni('prev')}
  else if(nx){heroAI=(heroAI+1)%total;renderAnni('next')}
});
$('#ai-matrix-body').addEventListener('change',function(e){
  var i=e.target;if(!i.dataset||!i.dataset.ai)return;
  var st=AISTATE[i.dataset.ai]||[1,1],k=+i.dataset.k;
  if(k===0){st[0]=i.checked?1:0;if(!st[0])st[1]=0}else{st[1]=i.checked?1:0;if(st[1])st[0]=1}
  AISTATE[i.dataset.ai]=st;saveCalSettings();renderMatrix();renderAnni();
});
$('#kind-seg').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;
  $$('#kind-seg button').forEach(function(x){x.classList.toggle('on',x===b)});syncKindUI(b.dataset.k,true);
});
$('#btn-save').addEventListener('click',async function(){
  var kind=curKind(),end='';
  if(kind==='plan'||kind==='memo'){end=applyEndInput($('#f-end-date'));if(end===null)return}
  var start=selectedStartIso();
  if(end&&end<start){toast('结束日期不能早于开始日期');$('#f-end-date').focus();return}
  if(VIS_OPTS[selVis.get()].v==='multi'&&!visPicked().length){toast('先选中至少一位 AI');return}
  var it=formItem(end);
  if(!it.title){toast('先给事项写一个标题');$('#f-title').focus();return}
  if(EDIT_ID){/* v44 — 就地更新：保留原 id 与建立时间；日期若改动，台账按新日期自然重算 */
    var old=null,q;
    for(q=0;q<ITEMS.length;q++)if(ITEMS[q].id===EDIT_ID)old=ITEMS[q];
    it.id=EDIT_ID;it.created=(old&&old.created)?old.created:Date.now();it.edited=Date.now();
    try{await dbPut('calEvents',it)}catch(e2){toast('保存失败，请重试');return}
    for(q=0;q<ITEMS.length;q++)if(ITEMS[q].id===EDIT_ID)ITEMS[q]=it;
    clearEdit();
    rebuildSheet();renderSelected();renderAnni();
    toast('已更新该事项');switchTab('anni');return;
  }
  it.id='cal_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*46656).toString(36);
  it.created=Date.now();
  try{await dbPut('calEvents',it)}catch(e){toast('保存失败，请重试');return}
  ITEMS.push(it);
  rebuildSheet();renderSelected();renderAnni();
  $('#f-title').value='';
  var _fn=$('#f-note');if(_fn)_fn.value='';
  var _fe=$('#f-end-date');if(_fe){_fe.value='';_fe.dataset.valid=''}
  toast('已保存 — 已加入日程');switchTab('anni');
});
/* v36 — 行卡删除：连带清掉该事项的提及/便笺台账（便笺本体保留在留言页） */
$('#anni-list').addEventListener('click',async function(e){
  var ed=e.target.closest('[data-edit]');/* v44 — 编辑入口 */
  if(ed){
    e.stopPropagation();
    var eid=ed.dataset.edit,tgt=null;
    for(var q=0;q<ITEMS.length;q++)if(ITEMS[q].id===eid)tgt=ITEMS[q];
    if(tgt)fillForm(tgt);else toast('这条事项已不在日程里');
    return;
  }
  var b=e.target.closest('[data-del]');if(!b)return;
  e.stopPropagation();
  var id=b.dataset.del;
  try{
    await dbDelete('calEvents',id);
    var led=await dbGetAll('calLedger');
    for(var i=0;i<led.length;i++){if(String(led[i].id).indexOf(id+'|')===0)await dbDelete('calLedger',led[i].id)}
  }catch(e2){}
  ITEMS=ITEMS.filter(function(x){return x.id!==id});
  if(EDIT_ID===id)clearEdit();/* v44 — 正在编辑的这条被删掉就退出编辑态 */
  rebuildSheet();renderSelected();renderAnni();
  toast('已删除该事项');
});
$('#set-allownotes').addEventListener('change',function(){ALLOW_NOTES=this.checked;saveCalSettings();renderFeed();renderAnni()});/* 总开关进 system 常量块：改动后各好友下一条消息重建一次提示缓存 */
$('#set-nopetal').addEventListener('change',function(){SET.noPetals=this.checked;saveCalSettings();document.body.classList.toggle('no-petals',this.checked)});
$('#set-holiday').addEventListener('change',function(){HOLIDAY_ON=this.checked;saveCalSettings();rebuildSheet();renderSelected()});/* v39 — 节日只影响 tail，不触发提示缓存重建；v40 — 切换后即时刷新挂历黄点、图例与日程表 */
$('#set-bootmini').addEventListener('change',function(){SET.bootMini=this.checked;saveCalSettings()});/* v42 — 开站小窗常驻：仅影响下次进站，默认开启 */
$('#eph-now').addEventListener('click',goNow);
/* v41 — 备注：输入超出上限即就地截断 */
(function(NS){var n=$('#f-note');if(n)n.addEventListener('input',function(){var v=noteTrim(this.value);if(v!==this.value)this.value=v})})();
/* v44 — 每周多选：至少留一天 */
(function(NS){var p=$('#wd-pick');if(!p)return;p.addEventListener('click',function(e){
  var b=e.target.closest('button[data-w]');if(!b)return;
  b.classList.toggle('on');
  if(!$$('#wd-pick button.on').length)b.classList.add('on');
})})();
/* v44 — 可见范围多选 */
(function(NS){var p=$('#vis-pick');if(!p)return;p.addEventListener('click',function(e){
  var b=e.target.closest('button[data-ai]');if(!b)return;
  b.classList.toggle('on');
})})();
/* v37 — 相遇纪念日：失焦或回车即识别；「每周从周一开始」「打开时回到今天」「自动」键的监听随控件一并撤除 */
$('#meet-input').addEventListener('change',function(){if(_meetAid)applyMeetInput(this,_meetAid)});
$('#meet-ib-input').addEventListener('change',function(){applyMeetInput(this,IB_KEY)});
$('#f-end-date').addEventListener('change',function(){applyEndInput(this)});
['meet-input','meet-ib-input','f-end-date'].forEach(function(id){
  var el=document.getElementById(id);
  if(el)el.addEventListener('keydown',function(e){if(e.key==='Enter')this.blur()});
});

/* ── 初始化（集成版）：懒装配，首次打开视窗或首次构建注入时执行；不自动开窗 ── */
var _inited=false;
async function init(){
  if(_inited)return;_inited=true;
  await ensureData();
  await refreshMeets();
  buildMainClock();buildWidgetClock();
  buildWindowPetals();
  setInterval(function(NS){if(!document.hidden)tick()},500);tick();
  /* v43 — 指针走时是纯 CSS 动画，系统休眠或长时间后台期间动画时间轴可能停走：
     数字读数每 0.5s 自会跳回，模拟指针却会留在旧位置。页面重新可见时重建两只钟面，
     指针按当前时刻重新校准；钟面内容与样式不变（init 只执行一次，监听只挂一次）。 */
  document.addEventListener('visibilitychange',function(){if(!document.hidden){buildMainClock();buildWidgetClock()}});
  curSheet=buildSheet(curY,curM);
  $('#cal-book').appendChild(curSheet);
  renderSelected();
  rebuildVisOpts();
  var yNow=Y0;
  var years=[];
  for(var y=1950;y<=2100;y++)years.push(y+' 年');/* v42 — 与挂历跳转范围一致 */
  var months=[];for(var mI=1;mI<=12;mI++)months.push(p2(mI)+' 月');
  function daysOf(yi,mi){return new Date(1950+yi,mi+1,0).getDate()}
  function dayOpts(nD){var a=[];for(var i=1;i<=nD;i++)a.push(p2(i)+' 日');return a}
  function refreshDays(){
    if(!selD)return;
    var nD=daysOf(selY.get(),selM.get());
    selD.setOpts(dayOpts(nD),Math.min(selD.get(),nD-1));
  }
  selY=makeSelect('ibsel-y',years,yNow-1950,refreshDays);
  selM=makeSelect('ibsel-m',months,TODAY.getMonth(),refreshDays);
  selD=makeSelect('ibsel-d',dayOpts(daysOf(yNow-1950,TODAY.getMonth())),TODAY.getDate()-1,null);
  selRep=makeSelect('ibsel-rep',['每年','每月','每周','每天','单次'],0,syncRepeatUI);/* v42 — 增加每天；v44 — 选「每周」时浮现星期多选 */
  /* v37 — 窗头年月下拉：直接跳转挂历显示的月份，菜单约五行高、可滚动 */
  var hys=[];for(var hy=1950;hy<=2100;hy++)hys.push(hy+' 年');
  selHY=makeSelect('ibsel-hy',hys,curY-1950,jumpYM);
  selHM=makeSelect('ibsel-hm',months,curM,jumpYM);
  selVis=makeSelect('ibsel-vis',VIS_OPTS.map(function(o){return o.t}),0,function(){syncVisibilityReminder();syncVisUI()});
  syncKindUI(curKind(),false);syncRepeatUI();syncVisUI();
  /* v35 — 提前天数：默认「提前 7 天」；选「自定义…」时旁侧数字框浮现 */
  selLead=makeSelect('ibsel-lead',['当天','提前 1 天','提前 2 天','提前 3 天','提前 5 天','提前 7 天','提前 14 天','提前 30 天','自定义…'],5,function(i){
    var c=$('#f-lead-custom');if(c)c.style.display=LEADS[i]<0?'':'none';
  });
  var _fr=$('#f-remind');
  if(_fr){_fr.addEventListener('change',syncReminderUI);syncReminderUI()}
  rebuildAISelects();
  var _c;( _c=$('#set-nopetal'))&&(_c.checked=SET.noPetals);
  (_c=$('#set-allownotes'))&&(_c.checked=ALLOW_NOTES);
  (_c=$('#set-holiday'))&&(_c.checked=HOLIDAY_ON);
  (_c=$('#set-bootmini'))&&(_c.checked=SET.bootMini);
  syncNow();
  renderAnni();renderMatrix();
  renderFeed();
}
function rebuildVisOpts(){
  var prev='all';
  if(selVis&&VIS_OPTS[selVis.get()])prev=VIS_OPTS[selVis.get()].v;
  VIS_OPTS=[{v:'all',t:'公开 — 所有 AI'}];
  AIS.forEach(function(a){VIS_OPTS.push({v:'ai:'+a.id,t:'仅 '+a.name})});
  if(AIS.length>1)VIS_OPTS.push({v:'multi',t:'指定多位 AI…'});/* v44 — 可同时勾选几位 */
  VIS_OPTS.push({v:'self',t:'仅自己 — AI 不可见'});
  renderVisPick(visPicked());
  if(selVis){
    var idx=VIS_OPTS.findIndex(function(o){return o.v===prev});
    if(idx<0&&prev.indexOf('ais:')===0)idx=VIS_OPTS.findIndex(function(o){return o.v==='multi'});
    if(idx<0)idx=prev==='all'?0:VIS_OPTS.length-1;
    selVis.setOpts(VIS_OPTS.map(function(o){return o.t}),idx);
    syncVisibilityReminder();syncVisUI();
  }
}
function rebuildAISelects(){
  if(!AIS.length){
    faNotes='all';
    selAI=makeSelect('ibsel-ai',['暂无 API 好友'],0,renderMatrix);
    makeSelect('ibsel-from',['全部 AI'],0,function(){faNotes='all';renderFeed()});
    return;
  }
  selAI=makeSelect('ibsel-ai',AIS.map(function(a){return a.name+(a.model?' — '+a.model:'')}),0,renderMatrix);
  var fromIdx=0;
  for(var i=0;i<AIS.length;i++){if(AIS[i].id===faNotes){fromIdx=i+1;break}}
  if(!fromIdx)faNotes='all';
  makeSelect('ibsel-from',['全部 AI'].concat(AIS.map(function(a){return a.name})),fromIdx,function(i){
    faNotes=i===0?'all':AIS[i-1].id;renderFeed();
  });
}
/* 打开视窗：每次刷新好友与相遇日快照（好友增减自动跟随） */
async function openCalendar(tab){
  await init();
  await refreshAIs();await refreshMeets();
  rebuildVisOpts();rebuildAISelects();
  renderAnni();renderMatrix();renderFeed();renderSelected();
  openEph(tab||'cal');
}


/* ═════════ 与聊天的接线：日历栏（tail）/ 便笺指令（system 常量）/ <cal_note> 解析与台账 ═════════ */
/* 台账键：事项id|本次日期ISO|好友id → {mentioned,shown,noted}
   〔未提及〕最多随注入出现 3 轮，之后视为已提及；回复正文出现事项标题即打勾；
   〔可留笺〕在 该AI可写 且 本次日期未写过 时出现；每事项每次日期至多收录一张便笺。 */
var CAL_TAIL_HEAD='【备忘日历｜〔未提及〕= 可自然提一句，提过即止；〔可留笺〕= 可附便笺】';
var CAL_NOTE_INSTR='【便笺】当日历中某事项或者节日标有〔可留笺〕且你想为它留一张便笺时，在回复末尾追加：\n<cal_note item="事项标题">30–150 字正文</cal_note>\n便笺会出现在对方的日历留言页，界面自动署名并标时间；正文不要写称呼、署名或日期。\n每条事项每次日期至多一张。';
function _calToday(){var n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate())}
function ledKey(itemId,occIso,aid){return itemId+'|'+occIso+'|'+aid}
async function ledGet(k){try{return await dbGet('calLedger',k)}catch(e){return null}}
function ledPut(l){try{dbPut('calLedger',l)}catch(e){}}
function repCN(it){
  if(it.repeat==='yearly')return ' · 每年';
  if(it.repeat==='monthly')return ' · 每月';
  if(it.repeat==='weekly'){var b=itemDate(it);return ' · 每周'+wdText(it,b)}
  if(it.repeat==='daily')return ' · 每天';
  return '';
}
function mdCN(iso,withYear){var a=String(iso||'').split('-');return (withYear?(+a[0])+'年':'')+(+a[1])+'月'+(+a[2])+'日'}
function kindCN(it){return {anniv:'纪念日',birthday:'生日',plan:'计划',memo:'记录'}[it&&it.kind]||'事项'}
function tailDateText(it,occ){
  var e=itemEndDate(it),end=e?isoOf(e):'',sy=String(it.date||'').split('-')[0],oy=String(occ||'').split('-')[0],ey=String(end||'').split('-')[0];
  if(it.repeat==='once'&&end&&end!==it.date){var cross=!!(sy&&ey&&sy!==ey);return mdCN(it.date,cross)+'—'+mdCN(end,cross)+' · 连续'}
  return mdCN(occ)+repCN(it)+(end&&it.repeat!=='once'?' · 截至 '+mdCN(end,!!(oy&&ey&&oy!==ey)):'');
}
/* system 常量块：仅当 总开关开 且 该好友读+写权限均开 时返回便笺指令（会话内稳定；权限改动后下一条消息重建一次缓存） */
async function buildSys(cfg){
  if(!cfg||!cfg.id)return '';
  await ensureData();
  if(!ALLOW_NOTES)return '';
  var p=perm(cfg.id);
  if(!p[0]||!p[1])return '';
  return CAL_NOTE_INSTR;
}
/* tail 日历栏：对该好友可见、处于各自提前窗口内的事项；一天之内内容不变 */
async function buildTail(cfg){
  if(!cfg||!cfg.id)return '';
  await ensureData();
  if(!ALLOW_NOTES)return '';/* v39 — 总开关关闭：日历栏整段不生成 */
  var p=perm(cfg.id);
  if(!p[0])return '';
  var t=_calToday(),rows=[];
  for(var i=0;i<ITEMS.length;i++){
    var it=ITEMS[i];
    if(!it.title||!it.remind||!visibleTo(it,cfg.id))continue;
    var o=nextOcc(it,t);if(!o)continue;
    var du=diffD(t,o);if(du<0)continue;
    if(du>(it.lead!=null?it.lead:LEAD))continue;
    rows.push({it:it,du:du,occ:occKey(it,o),show:isoOf(o)});
  }
  /* v45 — 节日：开关开启时并入同一栏，复用〔未提及〕与〔可留笺〕规则 */
  if(HOLIDAY_ON){
    holidaysIn(t,HOL_LEAD).forEach(function(h){rows.push({hol:h.name,du:h.du,occ:h.occ})});
  }
  if(!rows.length)return '';
  rows.sort(function(a,b){return a.du-b.du});
  var lines=[CAL_TAIL_HEAD];
  for(var j=0;j<rows.length;j++){
    var r=rows[j],seg=(r.show||r.occ).split('-'),mark='',when=(r.du===0?'今天':'还有 '+r.du+' 天');
    if(r.hol){
      var hk=ledKey('hol:'+r.hol,r.occ,cfg.id),hled=(await ledGet(hk))||{id:hk,mentioned:0,shown:0,noted:0};
      if(!hled.mentioned){
        if((hled.shown|0)>=3){hled.mentioned=1;ledPut(hled)}
        else{mark='〔未提及〕';hled.shown=(hled.shown|0)+1;ledPut(hled)}
      }
      if(p[1]&&!hled.noted)mark+='〔可留笺〕';
      lines.push('· '+r.hol+' — '+when+'（'+(+seg[1])+'月'+(+seg[2])+'日 · 节日）'+mark);
      continue;
    }
    var it=r.it;
    if(it.remind&&it.id){
      var k=ledKey(it.id,r.occ,cfg.id),led=(await ledGet(k))||{id:k,mentioned:0,shown:0,noted:0};
      if(!led.mentioned){
        if((led.shown|0)>=3){led.mentioned=1;ledPut(led)}
        else{mark+='〔未提及〕';led.shown=(led.shown|0)+1;ledPut(led)}
      }
      if(p[1]&&!led.noted)mark+='〔可留笺〕';
    }
    lines.push('· '+kindCN(it)+'：'+it.title+' — '+when+'（'+tailDateText(it,r.show||r.occ)+'）'+mark+(it.note?' 备注：'+it.note:''));
  }
  return lines.join('\n');
}
/* 回复解析：截取 <cal_note> 入库；扫描正文为已到窗口的事项打「已提及」勾 */
var CAL_TAG_RE=/<cal_note\b([^>]*?)>([\s\S]*?)<\/cal_note\s*>/gi;
async function scanMentions(text,cfg){
  if(!text||!cfg||!cfg.id)return;
  try{
    await ensureData();
    if(!ALLOW_NOTES)return;/* v39 — 总开关关闭：不再登记任何日历相关状态 */
    if(!perm(cfg.id)[0])return;
    var t=_calToday();
    if(HOLIDAY_ON){
      var hs=holidaysIn(t,HOL_LEAD);
      for(var hi=0;hi<hs.length;hi++){
        if(text.indexOf(hs[hi].name)===-1)continue;
        var hk2=ledKey('hol:'+hs[hi].name,hs[hi].occ,cfg.id),hl=(await ledGet(hk2))||{id:hk2,mentioned:0,shown:0,noted:0};
        if(!hl.mentioned){hl.mentioned=1;ledPut(hl)}
      }
    }
    for(var i=0;i<ITEMS.length;i++){
      var it=ITEMS[i];
      if(!it.remind||!it.id||!it.title||!visibleTo(it,cfg.id))continue;
      var o=nextOcc(it,t);if(!o)continue;
      var du=diffD(t,o);if(du<0||du>(it.lead!=null?it.lead:LEAD))continue;
      if(text.indexOf(it.title)===-1)continue;
      var k=ledKey(it.id,occKey(it,o),cfg.id),led=(await ledGet(k))||{id:k,mentioned:0,shown:0,noted:0};
      if(!led.mentioned){led.mentioned=1;ledPut(led)}
    }
  }catch(e){}
}
async function execNote(op,cfg){
  function fail(d){return {ok:false,label:'便笺未收录',detail:d}}
  if(!cfg||!cfg.id)return fail('缺少会话信息');
  if(!ALLOW_NOTES)return fail('日历接入总开关已关闭');
  var p=perm(cfg.id);
  if(!p[0]||!p[1])return fail('这位 AI 的日历留言权限未开启');
  if(!op.item)return fail('标签缺少 item 事项标题');
  if(!op.body)return fail('便笺正文为空');
  var t=_calToday(),hit=null,occ=null,du=0,matched=false,remindMatched=false;
  for(var i=0;i<ITEMS.length;i++){
    var it=ITEMS[i];
    if(it.title!==op.item||!it.id||!visibleTo(it,cfg.id))continue;
    matched=true;if(!it.remind)continue;remindMatched=true;
    var o=nextOcc(it,t);if(!o)continue;
    du=diffD(t,o);if(du<0||du>(it.lead!=null?it.lead:LEAD))continue;
    hit=it;occ=occKey(it,o);break;
  }
  /* v45 — 普通事项未成功命中时，允许当前提醒窗口内的系统节日留笺 */
  if(!hit&&HOLIDAY_ON){
    var hs=holidaysIn(t,HOL_LEAD),hol=null;
    for(var hi=0;hi<hs.length;hi++){
      if(hs[hi].name===op.item){hol=hs[hi];break}
    }
    if(hol){
      var hk=ledKey('hol:'+hol.name,hol.occ,cfg.id),hled=(await ledGet(hk))||{id:hk,mentioned:0,shown:0,noted:0};
      var hy=String(hol.occ||'').split('-')[0],htitle=(hy?hy+'年·':'')+hol.name;
      if(hled.noted)return fail('「'+htitle+'」本次日期已留过便笺');
      var hnote={id:'cnote_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*46656).toString(36),
        ai:cfg.id,aiName:cfg.nickname||cfg.model||'AI',itemId:'hol:'+hol.name,itemTitle:htitle,
        body:String(op.body).slice(0,300),ts:Date.now()};
      try{await dbPut('calNotes',hnote)}catch(e){return fail('写入本地数据库失败')}
      NOTES.unshift(hnote);
      hled.noted=1;ledPut(hled);
      return {ok:true,label:'已在日历留下便笺 ·「'+htitle+'」',detail:hnote.body};
    }
  }
  if(!matched)return fail('日历中没有「'+op.item+'」这一事项或节日，或它对这位 AI 不可见');
  if(!remindMatched)return fail('「'+op.item+'」未开启临近提醒便笺');
  if(!hit)return fail('「'+op.item+'」还未进入提醒窗口');
  var k=ledKey(hit.id,occ,cfg.id),led=(await ledGet(k))||{id:k,mentioned:0,shown:0,noted:0};
  if(led.noted)return fail('「'+op.item+'」本次日期已留过便笺');
  var note={id:'cnote_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*46656).toString(36),
    ai:cfg.id,aiName:cfg.nickname||cfg.model||'AI',itemId:hit.id,itemTitle:hit.title,
    body:String(op.body).slice(0,300),ts:Date.now()};
  try{await dbPut('calNotes',note)}catch(e){return fail('写入本地数据库失败')}
  NOTES.unshift(note);
  led.noted=1;ledPut(led);
  return {ok:true,label:'已在日历留下便笺 ·「'+hit.title+'」',detail:note.body};
}
async function processReply(replyText,cfg){
  var out={clean:replyText,results:[]};
  try{
    if(!replyText)return out;
    if(String(replyText).toLowerCase().indexOf('<cal_note')===-1){await scanMentions(replyText,cfg);return out}
    await ensureData();
    var ops=[];
    var clean=String(replyText).replace(CAL_TAG_RE,function(_m,attr,body){
      var itv='';String(attr||'').replace(/item\s*=\s*"([^"]*)"/i,function(__,v){itv=v;return ''});
      ops.push({item:(itv||'').trim(),body:String(body||'').trim()});
      return '';
    });
    clean=clean.replace(/\n{3,}/g,'\n\n');
    /* 流中断残缺标签：末尾悬空且无闭合的 <cal_note 片段整段剪除（<600字符防误伤正文） */
    var _d=clean.toLowerCase().lastIndexOf('<cal_note');
    if(_d!==-1){var _t2=clean.slice(_d);if(_t2.length<600&&!/<\/cal_note\s*>/i.test(_t2)){clean=clean.slice(0,_d).replace(/\s+$/,'')}}
    out.clean=clean;
    for(var i=0;i<ops.length;i++){
      if(i>=2){out.results.push({ok:false,label:'便笺未收录',detail:'每次回复最多收录 2 张（多余的已忽略）'});continue}
      out.results.push(await execNote(ops[i],cfg));
    }
    await scanMentions(clean,cfg);
    if(_inited){renderFeed();renderAnni()}
  }catch(e){}
  return out;
}
/* 便笺操作卡（与 AM 记忆卡同款式；历史重载时由主站按 aiMsg.calNotes 重建） */
var CAL_CARD_ICON='<svg class="ws-op-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#sym-cal"/></svg>';
function noteCard(r){
  var c=document.createElement('div');c.className='ws-op-card expandable'+(r.ok?'':' warn');
  var ic=r.ok?CAL_CARD_ICON:((typeof WS_ICON!=='undefined'&&WS_ICON.warn)||CAL_CARD_ICON);
  c.innerHTML=ic+'<span class="ws-op-text">'+esc(r.label||'日历便笺')+'</span>'
    +'<svg class="ws-op-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
  var det=document.createElement('div');det.className='ws-op-detail';det.textContent=r.detail||'';c.appendChild(det);
  c.onclick=function(){c.classList.toggle('expanded')};
  return c;
}
/* 直播过滤：流中的 <cal_note> 原文截下换成轻量提示卡（收尾以 processReply 结果为准） */
function mkLiveFilter(out,cardFn){
  var buf='',inTag=false,pend=[];
  function hold(s){var low=s.toLowerCase();for(var l=Math.min(low.length,9);l>0;l--){if('<cal_note'.indexOf(low.slice(-l))===0)return l}return 0}
  function open(){if(typeof cardFn!=='function')return;pend=cardFn(function(NS){var c=document.createElement('div');c.className='ws-op-card pending';c.innerHTML=CAL_CARD_ICON+'<span class="ws-op-text">正在留一张便笺…</span>';return c})||[]}
  function close(){(pend||[]).forEach(function(c){c.classList.remove('pending');var t=c.querySelector('.ws-op-text');if(t)t.textContent='已提交便笺'});pend=[]}
  return{
    push:function(ch){
      buf+=ch;
      for(;;){
        if(!inTag){
          var i=buf.toLowerCase().indexOf('<cal_note');
          if(i<0){var h=hold(buf);var emit=h?buf.slice(0,buf.length-h):buf;buf=h?buf.slice(buf.length-h):'';if(emit)out(emit);return}
          if(i>0){out(buf.slice(0,i));buf=buf.slice(i)}
          inTag=true;open();
        }
        if(inTag){
          var k=buf.toLowerCase().indexOf('</cal_note>');
          if(k<0){
            if(buf.length>4000){out(buf);buf='';inTag=false;close()}/* 防吞守卫：疑似误判时原样放行 */
            return;
          }
          buf=buf.slice(k+11);inTag=false;close();continue;
        }
      }
    },
    finish:function(){if(inTag){close();buf=''}else if(buf){if('<cal_note'.indexOf(buf.toLowerCase())!==0)out(buf);buf=''}}
  };
}
/* ── v42 — 悬浮小窗形态：花瓣自小窗飘向整页；坞内三枚按钮恒在（小窗联动收起已撤）；开站是否亮出小窗由设置「开站小窗常驻」决定，默认开启 ── */
function buildWidgetPetals(){
  var f=document.getElementById('wg-petal-field');if(!f||f.dataset.built)return;
  var h='';
  for(var i=0;i<16;i++){
    h+='<span class="wg-petal" style="--s:'+(6+Math.random()*7).toFixed(1)+'px'
      +';--jx:'+(Math.random()*220-110).toFixed(0)+'px'
      +';--d:'+(11+Math.random()*9).toFixed(1)+'s;--delay:'+(-Math.random()*20).toFixed(1)+'s'
      +';--dx1:'+(Math.random()*90-45).toFixed(0)+'px;--dx2:'+(Math.random()*150-70).toFixed(0)+'px;--dx3:'+(Math.random()*220-100).toFixed(0)+'px'
      +';--o:'+(0.16+Math.random()*0.22).toFixed(2)+'"><svg viewBox="-7 -7 14 14"><use href="#sym-floret"/></svg></span>';
  }
  f.innerHTML=h;f.dataset.built='1';
}
function syncPetalOrigin(){
  var f=document.getElementById('wg-petal-field');if(!f)return;
  var r=widget.getBoundingClientRect();
  if(r.width>0){f.style.setProperty('--ox',(r.left+r.width*0.5).toFixed(0)+'px');
                f.style.setProperty('--oy',(r.top+r.height*0.62).toFixed(0)+'px')}
}
function syncPetalField(){
  var f=document.getElementById('wg-petal-field');if(!f)return;
  var on=widget.classList.contains('show');
  f.classList.toggle('on',on);
  if(on){buildWidgetPetals();syncPetalOrigin()}
}
window.addEventListener('resize',function(){if(widget.classList.contains('show'))syncPetalOrigin()});
async function bootWidget(){
  try{
    await ensureData();
    if(!SET.bootMini)return;/* v42 — 默认显示；仅当用户关闭「开站小窗常驻」时不随站点载入亮出小窗 */
    await init();
    win.classList.remove('show','to-widget');
    widget.classList.add('show');
    syncPetalField();
  }catch(e){}
}
(function(NS){/* 等站点入场动画走完（坞现身）后读取「开站小窗常驻」设置；默认让小窗淡入 */
  var n=0,t=setInterval(function(NS){
    n++;
    var d=document.getElementById('fab-dock');
    if(d&&d.classList.contains('visible')){clearInterval(t);setTimeout(bootWidget,240);return}
    if(n>300)clearInterval(t);
  },200);
})();
window.IBCAL={open:openCalendar,buildSys:buildSys,buildTail:buildTail,processReply:processReply,noteCard:noteCard,mkLiveFilter:mkLiveFilter};

/* ---- window.IB 命名空间迁移：所有权标记 ---- */
NS.expose('calendar', { mounted: true });
})(window.IB || (window.IB = {}));