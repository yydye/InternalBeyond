/* ===== MEMORY 星图 · 霜烬 · 画布星场（三层视差 / 不规则闪烁；无流星）
   升级 v2（保持原架构）：星点由硬边圆改为高斯光斑精灵（近景锐核+微晕、远景柔斑，层次感）；
   少量近距双星；最亮的几颗带极淡衍射十字；闪烁为双正弦不规则抖动。
   星带保持原版单峰高斯分布（一条光带）。色谱、亮度总量与原版持平，整体依旧低调。 ===== */
(function(NS){
  var canvas=document.getElementById('mem-sky-canvas'); if(!canvas) return;
  var ctx=canvas.getContext('2d'), W=0,H=0,DPR=1, layers=[], raf=0, vis=false, built=false;
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* 去饱和的真实恒星色谱（向银色收敛，贴合背景图） */
  var PAL=[['230,236,246',0.36],['200,214,236',0.24],['176,200,230',0.16],
           ['236,230,220',0.12],['217,193,154',0.08],['199,154,150',0.04]];
  function pick(){var r=Math.random(),a=0,i;for(i=0;i<PAL.length;i++){a+=PAL[i][1];if(r<=a)return PAL[i][0];}return PAL[0][0];}
  /* 高斯星点精灵缓存：每色两枚（soft=柔斑给远景/星带，sharp=锐核+微晕给中近景），build 时生成一次 */
  var SPR={};
  function _mkSprite(col,sharp){
    var S=64,c=document.createElement('canvas');c.width=S;c.height=S;
    var g=c.getContext('2d'),img=g.createImageData(S,S),d=img.data,cx=(S-1)/2,rgb=col.split(',');
    for(var y=0;y<S;y++)for(var x=0;x<S;x++){
      var dd=Math.sqrt((x-cx)*(x-cx)+(y-cx)*(y-cx))/cx,a;
      if(sharp)a=Math.min(1,Math.exp(-(dd*3.2)*(dd*3.2))+0.22*Math.exp(-(dd*1.35)*(dd*1.35)));
      else a=Math.exp(-(dd*2.2)*(dd*2.2));
      var i=(y*S+x)*4;d[i]=+rgb[0];d[i+1]=+rgb[1];d[i+2]=+rgb[2];d[i+3]=Math.round(a*255);
    }
    g.putImageData(img,0,0);return c;
  }
  function _buildSprites(){SPR={};for(var i=0;i<PAL.length;i++){var col=PAL[i][0];SPR[col]={soft:_mkSprite(col,false),sharp:_mkSprite(col,true)};}}
  function build(){
    DPR=Math.min(window.devicePixelRatio||1,2);
    var b=canvas.getBoundingClientRect(); W=b.width; H=b.height;
    if(W<2||H<2){ built=false; return; }   /* 记忆页隐藏时尺寸为 0，先不建 */
    canvas.width=W*DPR; canvas.height=H*DPR; ctx.setTransform(DPR,0,0,DPR,0,0);
    _buildSprites();
    /* kern：该层用哪枚精灵；远层柔斑、近层锐核——同色下的软硬差异即是纵深线索 */
    var defs=[{n:Math.round(W*H/2600), r:[0.3,0.9], a:[0.22,0.55], drift:0.05, tw:0.4, kern:'soft'},
              {n:Math.round(W*H/5400), r:[0.6,1.4], a:[0.40,0.82], drift:0.12, tw:0.7, kern:'sharp'},
              {n:Math.round(W*H/12500),r:[1.0,2.0], a:[0.60,1.00], drift:0.22, tw:1.0, kern:'sharp'}];
    layers=defs.map(function(d){
      var arr=[],k; for(k=0;k<d.n;k++){arr.push({
        x:Math.random()*W, y:Math.random()*H,
        r:d.r[0]+Math.random()*(d.r[1]-d.r[0]),
        a:d.a[0]+Math.random()*(d.a[1]-d.a[0]),
        c:pick(), tw:Math.random()<d.tw, ph:Math.random()*6.283, sp:0.4+Math.random()*0.9
      });}
      return {drift:d.drift, kern:d.kern, stars:arr};
    });
    /* 近距双星：中景层约 2% 的星在 1.6~2.6px 外多一颗更小的同色伴星（天文照片质感的细节） */
    (function(NS){
      var mid=layers[1].stars, extra=[], k;
      for(k=0;k<mid.length;k++){
        if(Math.random()<0.02){
          var s=mid[k], th=Math.random()*6.283, dd=1.6+Math.random();
          extra.push({x:s.x+dd*Math.cos(th), y:s.y+dd*Math.sin(th), r:s.r*0.6, a:s.a*0.8,
            c:s.c, tw:s.tw, ph:s.ph+0.9, sp:s.sp});
        }
      }
      layers[1].stars=mid.concat(extra);
    })();
    /* 最亮几颗（近景 r≥1.8）标记极淡衍射十字 */
    layers[2].stars.forEach(function(s){ if(s.r>=1.8) s.spike=true; });
    /* 尘埃带内微星层：沿 CSS 尘埃带同角度(-14°)、同位置(带心约在画布 51% 高度)
       高斯散布一层高密度微星，让光带内部呈"星星点点"的颗粒感。
       该层不随时间漂移（视觉上位于最远处），仅参与闪烁 */
    (function(NS){
      var ang=-14*Math.PI/180, cosA=Math.cos(ang), sinA=Math.sin(ang);
      var cx=W/2, cy=H*0.51, n=Math.round(W*H/2300), arr=[], tries=0;
      while(arr.length<n && tries<n*4){
        tries++;
        var u=(Math.random()*2-1)*0.66*W;
        var g=(Math.random()+Math.random()+Math.random()-1.5)/1.5;
        var v=g*H*0.075;
        var x=cx+u*cosA-v*sinA, y=cy+u*sinA+v*cosA;
        if(x<1||x>W-1||y<1||y>H-1)continue;
        arr.push({x:x, y:y,
          r:0.25+Math.random()*0.55, a:0.06+Math.random()*0.26,
          c:pick(), tw:Math.random()<0.3, ph:Math.random()*6.283, sp:0.4+Math.random()*0.9});
      }
      layers.unshift({drift:0, kern:'soft', stars:arr});
    })();
    built=true;
  }
  function paint(now, moving){
    if(!built) return;
    var t=now/1000, li, si, L, ox, s, x, a, spr, R, m;
    ctx.clearRect(0,0,W,H);
    for(li=0; li<layers.length; li++){
      L=layers[li]; ox = moving ? ((t*L.drift*8)%W) : 0;
      for(si=0; si<L.stars.length; si++){
        s=L.stars[si]; x=s.x-ox; if(x<0)x+=W;
        a=s.a;
        if(moving && s.tw){
          /* 双正弦不规则闪烁：更接近大气抖动，幅度与原版持平 */
          m=0.5+0.5*(0.65*Math.sin(t*s.sp+s.ph)+0.35*Math.sin(t*s.sp*2.7+s.ph*1.7));
          a=s.a*(0.58+0.42*m);
        }
        spr=SPR[s.c]; spr=spr?(spr[L.kern]||spr.sharp):null;
        if(spr){
          R=s.r*(L.kern==='sharp'?3:2.6);/* 精灵含晕，绘制半径大于名义星径 */
          ctx.globalAlpha=a;
          ctx.drawImage(spr,x-R,s.y-R,R*2,R*2);
        }else{
          ctx.globalAlpha=1; ctx.beginPath(); ctx.fillStyle='rgba('+s.c+','+a.toFixed(3)+')';
          ctx.arc(x,s.y,s.r,0,6.283); ctx.fill();
        }
        if(s.spike){
          /* 极淡衍射十字：只给最亮几颗，随闪烁同步呼吸 */
          var sl=s.r*7, sa=a*0.16;
          ctx.globalAlpha=1; ctx.lineWidth=0.7;
          var g1=ctx.createLinearGradient(x-sl,s.y,x+sl,s.y);
          g1.addColorStop(0,'rgba(235,240,250,0)');g1.addColorStop(0.5,'rgba(235,240,250,'+sa.toFixed(3)+')');g1.addColorStop(1,'rgba(235,240,250,0)');
          ctx.strokeStyle=g1; ctx.beginPath(); ctx.moveTo(x-sl,s.y); ctx.lineTo(x+sl,s.y); ctx.stroke();
          var g2=ctx.createLinearGradient(x,s.y-sl,x,s.y+sl);
          g2.addColorStop(0,'rgba(235,240,250,0)');g2.addColorStop(0.5,'rgba(235,240,250,'+sa.toFixed(3)+')');g2.addColorStop(1,'rgba(235,240,250,0)');
          ctx.strokeStyle=g2; ctx.beginPath(); ctx.moveTo(x,s.y-sl); ctx.lineTo(x,s.y+sl); ctx.stroke();
        }
      }
    }
    ctx.globalAlpha=1;
  }
  function loop(now){ paint(now,true); raf=requestAnimationFrame(loop); }
  function play(){
    if(!built || !vis) return;
    if(reduce){ paint(performance.now(),false); return; }   /* 尊重"减少动态"：静态绘制 */
    if(!raf) raf=requestAnimationFrame(loop);
  }
  function pause(){ if(raf){ cancelAnimationFrame(raf); raf=0; } }
  /* 尺寸变化（含从隐藏→可见）→ 重建并按需播放 */
  if('ResizeObserver' in window){
    new ResizeObserver(function(NS){ build(); if(vis) play(); else if(built&&reduce) paint(performance.now(),false); }).observe(canvas);
  } else {
    window.addEventListener('resize', function(){ build(); if(vis) play(); });
  }
  /* 进出视口 → 播放/暂停（省电） */
  if('IntersectionObserver' in window){
    new IntersectionObserver(function(es){
      vis=es[0].isIntersecting;
      if(vis){ if(!built) build(); play(); } else pause();
    },{threshold:0}).observe(canvas);
  } else { vis=true; }
  /* 初始尝试（若此刻可见） */
  build(); if(built){ vis=true; play(); }

/* ---- window.IB 命名空间迁移：所有权标记 ---- */
NS.expose('memorySky', {
  mounted: true,
  build: build,
  play: play,
  pause: pause,
});
})(window.IB || (window.IB = {}));
