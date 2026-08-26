(function(NS){
'use strict';
var slot=document.getElementById('gw-slot');
var pane=document.getElementById('gw-pane');
var rcv=document.getElementById('gw-ripple');
var bgcv=document.getElementById('gw-ripple-bg');
var sp=document.getElementById('splash');
if(!slot||!pane||!rcv||!bgcv)return;
var rctx=rcv.getContext('2d');
var bgctx=bgcv.getContext('2d');
var dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
function R(a,b){return a+Math.random()*(b-a)}
var REDUCED=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var mqSmall=window.matchMedia?window.matchMedia('(max-width:900px)'):{matches:false};

var W=0,H=0,img=null;
var REFRACT_OK=true;

var SW=0,SH=0,h1=null,h2=null,bgData=null,outImg=null;
var sim=document.createElement('canvas'),simCtx=null;
var DAMP=0.9855;
var REFRACT=2.0;
/* 封面清晰化：画窗不再用低分辨率模拟网格整层替换画面（放大后模糊），
   只在高水波处叠加水痕高光，其余区域透出清晰的 bg-canvas 原图 */
var GLOSS_ONLY=true;
var LIGHT=10;
var STEP=1/30;

function poke(cx,cy,str,rad){
  cx|=0;cy|=0;
  var r2=rad*rad,R0=Math.ceil(rad);
  for(var y=-R0;y<=R0;y++){
    for(var x=-R0;x<=R0;x++){
      var px=cx+x,py=cy+y;
      if(px<1||py<1||px>=SW-1||py>=SH-1)continue;
      var f=(x*x+y*y)/r2;
      if(f>1)continue;

      h1[py*SW+px]+=str*(0.5+0.5*Math.cos(Math.PI*Math.sqrt(f)));
    }
  }
}
var swT=0;
function stepWater(){
  swT+=0.0333;
  for(var y=1;y<SH-1;y++){
    var i=y*SW+1;
    for(var x=1;x<SW-1;x++,i++){
      h2[i]=((h1[i-1]+h1[i+1]+h1[i-SW]+h1[i+SW])*0.5-h2[i])*DAMP
        +0.0024*Math.sin(swT*0.7+x*0.05+y*0.021)
        +0.0019*Math.sin(swT*0.43-x*0.023+y*0.041);
    }
  }
  var t=h1;h1=h2;h2=t;
}
function renderWater(){

  var gloss=(mode==='bg')||!REFRACT_OK||GLOSS_ONLY;
  var ctx=(mode==='bg')?bgctx:rctx;

  var GAIN=(mode==='bg')?150:330,CAP=(mode==='bg')?110:165;
  var dst=outImg.data,h=h1;
  var src=gloss?null:bgData.data;
  for(var y=0;y<SH;y++){
    var yu=y>0?y-1:y,yd=y<SH-1?y+1:y;
    for(var x=0;x<SW;x++){
      var i=y*SW+x;
      var xl=x>0?i-1:i,xr=x<SW-1?i+1:i;
      var gx=h[xl]-h[xr];
      var gy=h[yu*SW+x]-h[yd*SW+x];
      var di=i*4;
      if(src){
        var sx=x+(gx*REFRACT)|0;
        var sy=y+(gy*REFRACT)|0;
        if(sx<0)sx=0;else if(sx>=SW)sx=SW-1;
        if(sy<0)sy=0;else if(sy>=SH)sy=SH-1;
        var si=(sy*SW+sx)*4;
        var shade=gy*LIGHT;
        dst[di]=src[si]+shade;
        dst[di+1]=src[si+1]+shade;
        dst[di+2]=src[si+2]+shade*1.25;
        dst[di+3]=255;
      }else{
        var a=gy*GAIN;
        if(a>=0){dst[di]=224;dst[di+1]=238;dst[di+2]=255;dst[di+3]=(a>CAP?CAP:a)|0}
        else{a=-a;dst[di]=10;dst[di+1]=22;dst[di+2]=44;dst[di+3]=(a>CAP?CAP:a)|0}
      }
    }
  }
  simCtx.putImageData(outImg,0,0);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.imageSmoothingEnabled=true;
  if(src){

    ctx.filter='saturate(0.92) brightness(0.97)';
    ctx.drawImage(sim,0,0,W,H);
    ctx.filter='none';
  }else{
    ctx.clearRect(0,0,W,H);
    ctx.drawImage(sim,0,0,W,H);
  }
}

var rainT=R(0.6,1.6),ambT=R(1.5,3);
function rhythm(dt){
  rainT-=dt;
  if(rainT<=0){
    rainT=R(0.9,2.4);
    spawnDrop(R(0.8,1.5));
    if(Math.random()<0.18)spawnDrop(R(0.5,0.9));
  }
  ambT-=dt;
  if(ambT<=0){
    ambT=R(2.5,5.5);
    poke(R(2,SW-2),R(2,SH-2),R(0.25,0.55),3);
  }
}

var drops=[],plips=[];
function spawnDrop(str){
  var sx=R(2,SW-2),sy=R(2,SH-2);
  var px=sx/SW*W,py=sy/SH*H;
  var fall=H*R(0.34,0.52);
  var dur=R(0.3,0.42),vx=R(-8,14);
  drops.push({x:px-vx*dur,y:py-fall,ty:py,sx:sx,sy:sy,str:str,
    v:fall/dur,vx:vx,w:1.0+str*0.35});
}
function updateDrops(dt,ctx){
  for(var i=drops.length-1;i>=0;i--){
    var d=drops[i];
    d.x+=d.vx*dt;d.y+=d.v*dt;
    if(d.y>=d.ty){
      poke(d.sx,d.sy,d.str*1.15,1.6);
      poke(d.sx,d.sy,-d.str*0.4,3.2);
      plips.push({x:d.x,y:d.ty,t:0.22});
      drops.splice(i,1);
      continue;
    }
    var len=Math.min(26,d.v*0.045);
    var tx=d.x-d.vx*(len/d.v),ty=d.y-len;
    var g=ctx.createLinearGradient(tx,ty,d.x,d.y);
    g.addColorStop(0,'rgba(214,229,248,0)');
    g.addColorStop(0.7,'rgba(206,223,246,0.42)');
    g.addColorStop(1,'rgba(232,243,255,0.8)');
    ctx.strokeStyle=g;ctx.lineWidth=d.w;ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(d.x,d.y);ctx.stroke();
  }
  for(var j=plips.length-1;j>=0;j--){
    var p=plips[j];p.t-=dt;
    if(p.t<=0){plips.splice(j,1);continue}
    var a=p.t/0.22;
    ctx.strokeStyle='rgba(228,241,255,'+(0.45*a).toFixed(3)+')';
    ctx.lineWidth=0.9;
    ctx.beginPath();ctx.arc(p.x,p.y,1.2+(1-a)*5,0,6.2832);ctx.stroke();
    ctx.fillStyle='rgba(236,246,255,'+(0.55*a*a).toFixed(3)+')';
    ctx.beginPath();ctx.arc(p.x,p.y,1.4*a+0.3,0,6.2832);ctx.fill();
  }
}

var stirPts={};
function toSim(e){
  if(mode==='pane'){
    var r=pane.getBoundingClientRect();
    if(r.width<2||e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)return null;
    return{x:(e.clientX-r.left)/r.width*SW,y:(e.clientY-r.top)/r.height*SH};
  }
  return{x:e.clientX/W*SW,y:e.clientY/H*SH};
}
function stir(e){
  if(!(e.buttons&1))return;
  if(!tgtOk||idleNow())return;
  var p=toSim(e);if(!p)return;
  var lp=stirPts[e.pointerId];
  if(!lp){stirPts[e.pointerId]={x:p.x,y:p.y};return}
  var dx=p.x-lp.x,dy=p.y-lp.y;
  var d=Math.sqrt(dx*dx+dy*dy);
  if(d<1.15)return;
  var steps=Math.min(6,Math.ceil(d/1.5));
  var s=Math.min(0.55,0.12+d*0.05);
  for(var i=1;i<=steps;i++)poke(lp.x+dx*i/steps,lp.y+dy*i/steps,s,1.7);
  lp.x=p.x;lp.y=p.y;
}
function tap(e){
  if(!tgtOk||idleNow())return;
  var p=toSim(e);if(!p)return;
  stirPts[e.pointerId]={x:p.x,y:p.y};
  poke(p.x,p.y,2.0,2.8);
}
function lift(e){delete stirPts[e.pointerId]}
var drawCv=document.getElementById('gw-draw');
if(drawCv&&!REDUCED){
  drawCv.addEventListener('pointerdown',function(e){if(mode==='pane')tap(e)});
  drawCv.addEventListener('pointermove',function(e){if(mode==='pane')stir(e)});
  drawCv.addEventListener('pointerup',lift);
  drawCv.addEventListener('pointercancel',lift);
  drawCv.addEventListener('pointerleave',lift);
}
if(sp&&!REDUCED){
  sp.addEventListener('pointerdown',function(e){if(mode==='bg')tap(e)},{passive:true});
  sp.addEventListener('pointermove',function(e){if(mode==='bg')stir(e)},{passive:true});
  sp.addEventListener('pointerup',lift,{passive:true});
  sp.addEventListener('pointercancel',lift,{passive:true});
  sp.addEventListener('pointerleave',lift,{passive:true});
}

function gridFit(){
  SW=Math.min(320,Math.max(150,Math.round(W/4)));
  SH=Math.max(80,Math.round(SW*H/W));
  sim.width=SW;sim.height=SH;
  simCtx=sim.getContext('2d');
  h1=new Float32Array(SW*SH);
  h2=new Float32Array(SW*SH);
  stepAcc=0;
  stirPts={};
  if(drops)drops.length=0;
  if(plips)plips.length=0;
}
function rebuildBg(){
  if(!img)return false;
  var iw=img.naturalWidth,ih=img.naturalHeight;
  if(!iw||!ih)return false;
  var scale=Math.max(W/iw,H/ih);
  var sw=W/scale,sh=H/scale;
  var sx=(iw-sw)/2,sy=(ih-sh)/2;
  var tmp=document.createElement('canvas');
  tmp.width=SW;tmp.height=SH;
  var tc=tmp.getContext('2d');
  tc.drawImage(img,sx,sy,sw,sh,0,0,SW,SH);
  try{bgData=GLOSS_ONLY?null:tc.getImageData(0,0,SW,SH);REFRACT_OK=!GLOSS_ONLY;slot.classList.toggle('gw-gloss',!REFRACT_OK)}
  catch(_){bgData=null;REFRACT_OK=false;slot.classList.add('gw-gloss')}
  outImg=simCtx.createImageData(SW,SH);
  return true;
}
function retarget(m){
  if(m==='pane'){
    var r=pane.getBoundingClientRect();
    if(r.width<2||r.height<2)return false;
    W=r.width;H=r.height;
    rcv.width=Math.round(W*dpr);rcv.height=Math.round(H*dpr);
    gridFit();
    return rebuildBg();
  }
  W=window.innerWidth;H=window.innerHeight;
  if(W<2||H<2)return false;
  bgcv.width=Math.round(W*dpr);bgcv.height=Math.round(H*dpr);
  gridFit();
  outImg=simCtx.createImageData(SW,SH);
  for(var k=0;k<3;k++)poke(R(2,SW-2),R(2,SH-2),R(0.5,1.1),2);
  return true;
}

var mode=null,tgtOk=false,shownP=false,shownB=false;
function computeMode(){
  return (!slot.classList.contains('gw-off')&&!mqSmall.matches)?'pane':'bg';
}
function idleNow(){
  if(document.hidden)return true;
  if(slot.classList.contains('gw-exit'))return true;
  if(sp&&(sp.classList.contains('hidden')||sp.classList.contains('dissolving')))return true;
  return false;
}

var last=0,stepAcc=0;
function loop(ts){
  if(sp&&sp.classList.contains('hidden'))return;
  requestAnimationFrame(loop);
  var m=computeMode();
  if(m!==mode){
    mode=m;
    tgtOk=retarget(m);
    if(m!=='bg'){bgcv.classList.remove('on');shownB=false}
  }
  if(!tgtOk||idleNow()){last=ts;return}
  var raw=(ts-last)/1000||0.016;
  last=ts;
  var dt=Math.min(0.05,raw);
  var tdt=Math.min(2,raw);
  rhythm(tdt);
  stepAcc+=dt;
  var n=0;
  while(stepAcc>=STEP&&n<2){stepWater();stepAcc-=STEP;n++}
  renderWater();
  updateDrops(dt,(mode==='bg')?bgctx:rctx);
  if(mode==='pane'){if(!shownP){shownP=true;slot.classList.add('gw-rippling')}}
  else if(!shownB){shownB=true;bgcv.classList.add('on')}
}

if(window.ResizeObserver)new ResizeObserver(function(NS){if(mode==='pane')tgtOk=retarget('pane')}).observe(pane);
window.addEventListener('resize',function(){if(mode)tgtOk=retarget(mode)});

(function probe(names){
  if(!names.length)return;
  var name=names.shift();
  var im=new Image();
  im.onload=function(){
    img=im;
    if(REDUCED){
      mode='pane';
      if(retarget('pane')){renderWater();slot.classList.add('gw-rippling')}
      return;
    }
    if(mode==='pane')tgtOk=retarget('pane');
  };
  im.onerror=function(){probe(names)};
  im.src=name;
})(['bg-canvas.jpg','bg-canvas.png']);
if(!REDUCED)requestAnimationFrame(loop);

/* ---- window.IB 命名空间迁移：所有权标记 ---- */
NS.expose('glassRipple', {
  mounted: true
});
})(window.IB || (window.IB = {}));
