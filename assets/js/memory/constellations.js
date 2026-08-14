/* CONSTELLATIONS */
/* IB 命名空间迁移：constellations 域（记忆生命力 / 星空构建 / 星座连线 / 引言轮换）自 memory.js 机械提取（只动位置，不改逻辑）。 */
(function(NS){
function getMemVitality(m){
  if(m.pinned)return 1;
  var d=(Date.now()-(m.lastActivated||m.created))/(864e5);
  var l=m.resolved?0.12:0.05;
  var dc=Math.exp(-l*d);
  var ac=Math.max(0,m.activationCount||0);
  var a=ac/(ac+300);/* 与检索权重同曲线：长期增长但不早早视觉饱和 */
  return Math.max(0.12,Math.min(1,dc*0.82+a*0.18));
}

async function buildMemorySky(){
  var sky=document.getElementById('mem-sky');if(!sky)return;
  sky.querySelectorAll('.mem-star,.mem-sparkle').forEach(function(e){e.remove()});
  var all=await dbGetAll('memories');
  /* ── 防叠加：如果两颗星的位置过近，给后来的星施加微偏移 ── */
  var _placed=[];
  function _jitter(x,y){
    for(var j=0;j<_placed.length;j++){
      var dx=x-_placed[j][0],dy=y-_placed[j][1];
      if(dx*dx+dy*dy<12){/* ~3.5% 画幅内算重叠 */
        var ang=Math.atan2(dy,dx)+Math.PI*(0.4+Math.random()*0.2);
        x=Math.max(4,Math.min(96,x+Math.cos(ang)*4));
        y=Math.max(4,Math.min(96,y+Math.sin(ang)*4));
        j=-1;/* 重新检查 */
      }
    }
    _placed.push([x,y]);
    return [x,y];
  }
  /* ── AM 恒星：每个开启了 Auto Memory 的 API 渲染为渐变色恒星 ── */
  var _amApis=(typeof apiConfigs!=='undefined'?apiConfigs:[]).filter(function(c){return c.autoMem||c.amRecordOnly});
  _amApis.forEach(function(cfg){
    var ex=Math.random()*80+10, ey=Math.random()*80+10;
    var ep=_jitter(ex,ey);ex=ep[0];ey=ep[1];
    var sz=11;/* 月亮：略大于普通置顶星（已缩小） */
    var btn=document.createElement('button');
    btn.className='mem-star mem-star-am';
    btn.style.cssText='left:'+ex.toFixed(1)+'%;top:'+ey.toFixed(1)+'%;--sd:'+sz+'px;--sop:0.92;--sgc:rgba(100,180,200,0.5);--sg:16px;--stw:'+(4+Math.random()*3).toFixed(1)+'s';
    btn.innerHTML='<span class="mem-star-dot mem-am-gradient"></span><span class="mem-star-tip">'+esc(cfg.nickname||cfg.model||'AI')+' · Auto Memory</span>';
    btn.setAttribute('aria-label',esc(cfg.nickname||cfg.model||'AI'));
    btn.onclick=function(){amJumpSettings(cfg.id)};
    sky.appendChild(btn);
  });
  var _cstPts=[];/* internal 星座连线用：本次渲染的全部星点坐标与领域 */
  all.forEach(function(m){
    var vit=getMemVitality(m),sc=getMemoryScore(m);
    /* fix: 与 getMemoryScore 同款读取端兜底——importAll 原样入库，旧备份缺 V/A/重要性时星星会算出 left:NaN% 直接消失 */
    var _xy0=[8+(m.valence!=null?m.valence:0.5)*84,8+(1-(m.arousal!=null?m.arousal:0.3))*84];
    var _xyJ=_jitter(_xy0[0],_xy0[1]);var x=_xyJ[0],y=_xyJ[1];
    _cstPts.push({x:x,y:y,d:m.domain||'日常'});
    var d=3.5+(m.importance||5)*0.78;
    var dc=m.pinned?_memGold():(MEM_DOMAIN_COLORS[m.domain]||MEM_DOMAIN_COLORS['日常']).c;
    var gc=m.pinned?_memGoldRgba((0.4+vit*0.4).toFixed(2)):'rgba(114,168,216,'+(0.2+vit*0.35).toFixed(2)+')';
    var gb=(m.pinned?11:Math.round(4+d*vit))+'px';
    var btn=document.createElement('button');
    btn.className='mem-star'+(m.pinned?' pinned':'');
    btn.style.cssText='left:'+x+'%;top:'+y+'%;--sc:'+dc+';--sd:'+d.toFixed(1)+'px;--sop:'+(0.3+vit*0.7).toFixed(2)+';--sgc:'+gc+';--sg:'+gb+';--stw:'+(3+Math.random()*3.5).toFixed(1)+'s';
    var dt=new Date(m.created);
    var dateStr=dt.getFullYear()+'.'+(dt.getMonth()+1)+'.'+dt.getDate()+' '+dt.getHours()+':'+String(dt.getMinutes()).padStart(2,'0');
    btn.innerHTML='<span class="mem-star-dot"></span><span class="mem-star-tip">'+esc(m.title||'')+' · '+dateStr+'</span>';
    btn.setAttribute('aria-label',esc(m.title||''));
    btn.onclick=function(){
      /* sparkle effect on click */
      var sp=document.createElement('span');sp.className='mem-sparkle';
      sp.style.cssText='left:50%;top:50%;transform:translate(-50%,-50%);--sd:'+d.toFixed(1)+'px;--sgc:'+gc;
      btn.appendChild(sp);setTimeout(function(){sp.remove()},650);
    };
    sky.appendChild(btn);
  });
  _memSkyConstellations(_cstPts);
}

/* ── internal 星座连线：同一领域内按横坐标相邻的记忆星之间画发丝线（像星座连线），
   距离过远（>约38%画幅）不连；infernal 下该 SVG 由 CSS 隐藏，重建随 buildMemorySky ── */
function _memSkyConstellations(pts){
  var svg=document.getElementById('mem-sky-lines');if(!svg)return;
  var by={};pts.forEach(function(p){(by[p.d]=by[p.d]||[]).push(p)});
  var html='';
  Object.keys(by).forEach(function(k){
    var arr=by[k].slice().sort(function(a,b){return a.x-b.x});
    for(var i=0;i<arr.length-1;i++){
      var a=arr[i],b=arr[i+1],dx=a.x-b.x,dy=a.y-b.y;
      if(dx*dx+dy*dy>1500)continue;
      html+='<line x1="'+(a.x*8).toFixed(1)+'" y1="'+(a.y*4).toFixed(1)+'" x2="'+(b.x*8).toFixed(1)+'" y2="'+(b.y*4).toFixed(1)+'"/>';
    }
  });
  svg.innerHTML=html;
}

function shuffleMemoryQuote(){
  var banner=document.getElementById('mem-quote-banner');
  var textEl=document.getElementById('mem-quote-text');
  if(!banner||!textEl)return;
  var _sc=null;try{var _sl=_amList();if(_sl.length){if(_amIdx>=_sl.length)_amIdx=0;_sc=_sl[_amIdx]}}catch(e){}
  dbGetAll('memories').then(function(all){
    var pool=all.filter(function(m){return m.oneLine&&m.oneLine.trim()&&(!_sc||m.createdBy===_sc.id)}).map(function(m){return m.oneLine});
    var txt;
    if(!pool.length){txt=MEM_DEFAULT_QUOTE}
    else{var i;do{i=Math.floor(Math.random()*pool.length)}while(pool.length>1&&i===_memLastQuoteIdx);_memLastQuoteIdx=i;txt=pool[i]}
    banner.classList.remove('playing');void banner.offsetWidth;
    textEl.textContent=txt;
    banner.classList.add('playing');
  });
}

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.memory.constellations 登记全部导出 ---- */
window.getMemVitality=getMemVitality;
window.buildMemorySky=buildMemorySky;
window._memSkyConstellations=_memSkyConstellations;
window.shuffleMemoryQuote=shuffleMemoryQuote;
NS.expose('memory.constellations', {
  getMemVitality: getMemVitality,
  buildMemorySky: buildMemorySky,
  _memSkyConstellations: _memSkyConstellations,
  shuffleMemoryQuote: shuffleMemoryQuote,
});
})(window.IB || (window.IB = {}));