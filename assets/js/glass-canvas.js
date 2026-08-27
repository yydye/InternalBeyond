/* ============================================================
   GLASS CANVAS 画窗模块（仅欢迎页，不触碰站内其他逻辑）
   - 白笔：加粗 / 微透 / 冷光晕，模拟在玻璃上写字
   - 指雾笔：擦开凝雾层
   - 窗内背景按文件名约定加载：bg-canvas.jpg / bg-canvas.png，缺失静默
   - Sui 签名右侧的调色盘图标开关，进入时默认打开
   - 点击 游戏引导/开始设置/查看说明/跳过 时：画窗 0.32s 先退场
   ============================================================ */
(function(NS){
'use strict';
var slot=document.getElementById('gw-slot');
if(!slot)return;
var pane=document.getElementById('gw-pane');
var inkCv=document.getElementById('gw-draw');
var fogCv=document.getElementById('gw-fogwipe');
if(!pane||!inkCv||!fogCv)return;
var ink=inkCv.getContext('2d');
var fog=fogCv.getContext('2d');
var dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
var W=0,H=0,TOOL='finger';
var inkStrokes=[],wipeStrokes=[],cur=null;
/* 可调参数：FOGD=凝雾厚度系数；SIZE=各画笔当前线宽 */
var FOGD=1.0;
var SIZE={pen:3.6,finger:19};
var PEN_MIN=1.4,PEN_MAX=9,FIN_MIN=8,FIN_MAX=44;
var fogKnob=null,brushKnob=null;

/* ---------- 窗内背景：bg-canvas.png → bg-canvas.jpg 依次探测，全部缺失则保持空窗 ---------- */
(function probe(names){
  if(!names.length)return;
  var name=names.shift();
  var im=new Image();
  im.onload=function(){
    var el=document.getElementById('gw-img');
    if(el)el.style.backgroundImage='url("'+name+'")';
    /* 按图片真实比例校准 --gw-ar：画窗高度公式自动跟随，换图无需改 CSS */
    if(im.naturalWidth>0&&im.naturalHeight>0){
      document.documentElement.style.setProperty('--gw-ar',(im.naturalWidth/im.naturalHeight).toFixed(6));
    }
    slot.classList.add('gw-has-img');
  };
  im.onerror=function(){probe(names)};
  im.src=name;
})(['bg-canvas.png','bg-canvas.jpg']);

/* ---------- 几何工具 ---------- */
function mid(a,b){return{x:(a.x+b.x)/2,y:(a.y+b.y)/2}}
/* 把整条笔画构建成一条连续路径再一次性 stroke：单次描边内自交不会叠加透明度 */
function tracePath(ctx,p){
  ctx.beginPath();
  if(p.length===1){ctx.moveTo(p[0].x*W,p[0].y*H);ctx.lineTo(p[0].x*W+0.01,p[0].y*H);return}
  ctx.moveTo(p[0].x*W,p[0].y*H);
  if(p.length===2){ctx.lineTo(p[1].x*W,p[1].y*H);return}
  var m0=mid(p[0],p[1]);ctx.lineTo(m0.x*W,m0.y*H);
  for(var i=1;i<p.length-1;i++){
    var m2=mid(p[i],p[i+1]);
    ctx.quadraticCurveTo(p[i].x*W,p[i].y*H,m2.x*W,m2.y*H);
  }
  ctx.lineTo(p[p.length-1].x*W,p[p.length-1].y*H);
}

/* ---------- 白笔（玻璃发光笔迹）---------- */
function inkStyle(w){
  ink.lineCap='round';ink.lineJoin='round';
  ink.strokeStyle='rgba(255,255,255,0.78)';
  ink.fillStyle='rgba(255,255,255,0.78)';
  ink.lineWidth=w||SIZE.pen;
  ink.shadowColor='rgba(178,212,255,0.9)';
  ink.shadowBlur=12;
}
function inkDot(p,w){w=w||SIZE.pen;inkStyle(w);ink.beginPath();ink.arc(p.x*W,p.y*H,w*0.53,0,Math.PI*2);ink.fill()}
function renderInkStroke(p){
  var w=p.w||3.6;
  if(p.length===1){inkDot(p[0],w);return}
  inkStyle(w);tracePath(ink,p);ink.stroke();
}
function redrawInk(){
  ink.clearRect(0,0,W,H);
  for(var i=0;i<inkStrokes.length;i++)renderInkStroke(inkStrokes[i]);
}

/* ---------- 指雾笔（凝雾层 + 擦除）---------- */
function blotch(x,y,r,a){
  var g=fog.createRadialGradient(W*x,H*y,0,W*x,H*y,Math.max(W,H)*r);
  g.addColorStop(0,'rgba(222,234,250,'+a+')');g.addColorStop(1,'rgba(222,234,250,0)');
  fog.fillStyle=g;fog.fillRect(0,0,W,H);
}
function fa(a){return Math.min(1,a*FOGD)}  /* 各层透明度 × 厚度系数 */
function paintHaze(){
  fog.globalCompositeOperation='source-over';
  fog.shadowBlur=0;
  fog.fillStyle='rgba(208,224,244,'+fa(0.10)+')';   /* 基础凝雾 */
  fog.fillRect(0,0,W,H);
  var g=fog.createRadialGradient(W*0.5,H*0.46,Math.min(W,H)*0.22,W*0.5,H*0.5,Math.max(W,H)*0.72);
  g.addColorStop(0,'rgba(214,228,246,0)');
  g.addColorStop(1,'rgba(214,228,246,'+fa(0.12)+')'); /* 边缘 */
  fog.fillStyle=g;fog.fillRect(0,0,W,H);
  blotch(0.18,0.20,0.50,fa(0.06));                  /* 不均匀雾斑 */
  blotch(0.82,0.74,0.55,fa(0.05));
  blotch(0.60,0.12,0.40,fa(0.04));
}
function renderWipeStroke(p){
  var w=p.w||19;
  fog.globalCompositeOperation='destination-out';
  fog.lineCap='round';fog.lineJoin='round';
  fog.strokeStyle='rgba(0,0,0,0.92)';fog.lineWidth=w;
  if(p.length===1){fog.fillStyle='rgba(0,0,0,0.92)';fog.beginPath();fog.arc(p[0].x*W,p[0].y*H,w/2,0,Math.PI*2);fog.fill()}
  for(var i=1;i<p.length;i++){fog.beginPath();fog.moveTo(p[i-1].x*W,p[i-1].y*H);fog.lineTo(p[i].x*W,p[i].y*H);fog.stroke()}
  fog.globalCompositeOperation='source-over';
}
function redrawFog(){
  fog.globalCompositeOperation='source-over';
  fog.clearRect(0,0,W,H);
  paintHaze();
  for(var i=0;i<wipeStrokes.length;i++)renderWipeStroke(wipeStrokes[i]);
  fog.globalCompositeOperation='source-over';
}
function wipeSegLive(a,b,w){          /* 拖动时实时硬擦 */
  fog.globalCompositeOperation='destination-out';
  fog.lineCap='round';fog.lineJoin='round';
  fog.strokeStyle='rgba(0,0,0,0.92)';fog.lineWidth=w||19;
  fog.beginPath();fog.moveTo(a.x*W,a.y*H);fog.lineTo(b.x*W,b.y*H);fog.stroke();
  fog.globalCompositeOperation='source-over';
}

/* ---------- 尺寸 ---------- */
function sizeAll(){
  var r=pane.getBoundingClientRect();
  if(r.width<2||r.height<2)return;
  W=r.width;H=r.height;
  inkCv.width=Math.round(W*dpr);inkCv.height=Math.round(H*dpr);
  fogCv.width=Math.round(W*dpr);fogCv.height=Math.round(H*dpr);
  ink.setTransform(dpr,0,0,dpr,0,0);
  fog.setTransform(dpr,0,0,dpr,0,0);
  redrawInk();redrawFog();
}

/* ---------- 指针绘制 ---------- */
function pt(e){var r=inkCv.getBoundingClientRect();return{x:(e.clientX-r.left)/W,y:(e.clientY-r.top)/H}}
inkCv.addEventListener('pointerdown',function(e){
  if(e.button>0||W<2)return;
  if(slot.classList.contains('gw-exit'))return;
  try{inkCv.setPointerCapture(e.pointerId)}catch(_){}
  var p=pt(e);
  cur={tool:TOOL,pts:[p]};
  cur.pts.w=SIZE[TOOL];               /* 记录本笔画线宽 */
  (TOOL==='pen'?inkStrokes:wipeStrokes).push(cur.pts);
  if(TOOL==='pen')redrawInk();else renderWipeStroke(cur.pts);
  e.preventDefault();
});
inkCv.addEventListener('pointermove',function(e){
  if(!cur)return;
  var p=pt(e),pts=cur.pts,last=pts[pts.length-1];
  if(Math.hypot((p.x-last.x)*W,(p.y-last.y)*H)<1.2)return;
  pts.push(p);
  var n=pts.length;
  if(cur.tool==='pen'){
    redrawInk();
  }else{
    wipeSegLive(pts[n-2],pts[n-1],pts.w);
  }
});
function strokeUp(){
  if(!cur)return;
  if(cur.tool==='finger')redrawFog();
  cur=null;
}
inkCv.addEventListener('pointerup',strokeUp);
inkCv.addEventListener('pointercancel',strokeUp);

/* ---------- 工具切换 / 清除 ---------- */
var btnPen=document.getElementById('gw-tool-pen');
var btnFinger=document.getElementById('gw-tool-finger');
function setTool(t){
  TOOL=t;
  if(btnPen)btnPen.classList.toggle('active',t==='pen');
  if(btnFinger)btnFinger.classList.toggle('active',t==='finger');
  if(brushKnob)brushKnob.paint();     /* BRUSH 温度计跟随当前画笔显示对应大小 */
}
if(btnPen)btnPen.addEventListener('click',function(){setTool('pen')});
if(btnFinger)btnFinger.addEventListener('click',function(){setTool('finger')});
var btnClear=document.getElementById('gw-clear');
if(btnClear)btnClear.addEventListener('click',function(){
  inkStrokes.length=0;wipeStrokes.length=0;cur=null;
  redrawInk();redrawFog();
});

/* ---------- 温度计滑条：MIST=玻璃温度（℃，越冷凝雾越厚）/ BRUSH=当前画笔大小（点击/左右拖动/滚轮）---------- */
function makeTherm(el,getV,setV,fmt){
  if(!el)return null;
  var tube=el.querySelector('.gw-therm-tube');
  var fill=el.querySelector('.gw-therm-fill');
  var bulb=el.querySelector('.gw-therm-bulb');
  var val=el.querySelector('.gw-therm-val');
  function paint(){
    var v=getV();
    if(fill)fill.style.width=(v*100).toFixed(1)+'%';
    if(bulb)bulb.style.opacity=(0.55+v*0.45).toFixed(3);  /* 球泡亮度随数值 */
    if(val&&fmt)val.textContent=fmt(v);                   /* 数字读数 */
  }
  function fromX(x){
    var r=tube.getBoundingClientRect();
    if(r.width<2)return;
    setV(Math.max(0,Math.min(1,(x-r.left)/r.width)));
    paint();
  }
  var drag=false;
  el.addEventListener('pointerdown',function(e){
    if(e.button>0||slot.classList.contains('gw-exit'))return;
    drag=true;
    try{el.setPointerCapture(e.pointerId)}catch(_){}
    fromX(e.clientX);                                     /* 点击处即定位 */
    e.preventDefault();e.stopPropagation();
  });
  el.addEventListener('pointermove',function(e){
    if(!drag)return;
    fromX(e.clientX);e.preventDefault();
  });
  function rel(){drag=false}
  el.addEventListener('pointerup',rel);
  el.addEventListener('pointercancel',rel);
  el.addEventListener('wheel',function(e){
    setV(Math.max(0,Math.min(1,getV()+(e.deltaY<0?0.05:-0.05))));
    paint();e.preventDefault();e.stopPropagation();
  },{passive:false});
  paint();
  return{paint:paint};
}
var fogRedrawReq=false;
function requestFogRedraw(){          /* 拖动滑条时按帧重绘凝雾，避免高频全量重画 */
  if(fogRedrawReq)return;
  fogRedrawReq=true;
  requestAnimationFrame(function(NS){fogRedrawReq=false;redrawFog()});
}
/* —— 磨砂层跟随 MIST 联动 —— */
var frostEl=pane.querySelector('.gw-frost');
function syncFrostFog(){
  /* FOGD 范围 0.3(最暖)~2.3(最冷)，默认 1.0
     磨砂层：暖时几乎透明，冷时较浓 */
  var t=(FOGD-0.3)/2.0;  /* 0(暖)~1(冷) */
  var frostO=(0.08+t*0.72).toFixed(3);
  if(frostEl)frostEl.style.opacity=frostO;
}
syncFrostFog();
/* MIST：温度计语义 — 水银柱越长玻璃越暖、凝雾越薄；越冷凝雾越厚。
   温标 -13℃（最冷，FOGD=2.3 最厚）~ 7℃（最暖，FOGD=0.3 最薄），默认 0℃ = 1.0 */
fogKnob=makeTherm(document.getElementById('gw-therm-fog'),
  function(){return Math.max(0,Math.min(1,1-(FOGD-0.3)/2.0))},
  function(v){FOGD=0.3+(1-v)*2.0;syncFrostFog();requestFogRedraw()},
  function(v){var t=Math.round(-13+20*v);return (t===0?0:t)+'℃'});
brushKnob=makeTherm(document.getElementById('gw-therm-brush'),
  function(){return TOOL==='pen'?(SIZE.pen-PEN_MIN)/(PEN_MAX-PEN_MIN):(SIZE.finger-FIN_MIN)/(FIN_MAX-FIN_MIN)},
  function(v){if(TOOL==='pen')SIZE.pen=PEN_MIN+v*(PEN_MAX-PEN_MIN);else SIZE.finger=FIN_MIN+v*(FIN_MAX-FIN_MIN)},
  function(){var r=TOOL==='pen'?(SIZE.pen-PEN_MIN)/(PEN_MAX-PEN_MIN):(SIZE.finger-FIN_MIN)/(FIN_MAX-FIN_MIN);return Math.round(-13+20*r)+'°F'});

/* ---------- Sui 签名右侧的调色盘开关（默认打开）---------- */
window.gwToggle=function(){
  var off=slot.classList.toggle('gw-off');
  var t=document.getElementById('gw-toggle');
  if(t){t.classList.toggle('off',off);t.setAttribute('aria-pressed',off?'false':'true')}
};

/* ---------- 进站退场编排 ---------- */
(function(NS){
  if(typeof window.enterSite!=='function')return;
  var orig=window.enterSite,fired=false;
  function boardVisible(){
    if(slot.classList.contains('gw-off')||slot.classList.contains('gw-exit'))return false;
    return getComputedStyle(slot).display!=='none';
  }
  window.enterSite=function(){
    var args=arguments;
    if(fired||!boardVisible())return orig.apply(window,args);
    fired=true;
    slot.classList.add('gw-exit');                        /* 画窗 0.32s 快速淡出+微模糊 */
    setTimeout(function(NS){orig.apply(window,args)},340);  
  };
  /* 兜底：任何其他路径触发 dissolving 时画窗同步退场 */
  var sp=document.getElementById('splash');
  if(sp&&window.MutationObserver){
    var mo=new MutationObserver(function(NS){
      if(sp.classList.contains('dissolving')||sp.classList.contains('hidden')){
        slot.classList.add('gw-exit');mo.disconnect();
      }
    });
    mo.observe(sp,{attributes:true,attributeFilter:['class']});
  }
})();

/* ---------- 启动 ---------- */
if(window.ResizeObserver)new ResizeObserver(sizeAll).observe(pane);
window.addEventListener('resize',sizeAll);
sizeAll();

/* ---- window.IB 命名空间迁移：所有权标记 ---- */
NS.expose('glassCanvas', {
  mounted: true
});
})(window.IB || (window.IB = {}));
