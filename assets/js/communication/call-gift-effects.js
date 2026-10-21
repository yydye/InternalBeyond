/* Desktop adaptation of the mobile Helper gift presentation and FX canvas.
   Lower tiers use the original gift artwork card; fireworks, meteor and galaxy
   reuse the mobile particle/rail choreography on the desktop video stage. */
(function(NS){
  'use strict';

  var art={
    bouquet:'assets/communication/gifts/bouquet.webp',
    fireworks:'assets/communication/gifts/fireworks.webp',
    meteor:'assets/communication/gifts/meteor.webp',
    galaxy:'assets/communication/gifts/galaxy.webp'
  };
  var gaps={fireworks:1300,meteor:2600,galaxy:8600};
  var queue=[],particles=[],scenes=[],running=false,last=0,next=0,canvas=null,host=null,dpr=1,lastSize=null,toastTimer=0;
  var reduceMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)');

  function giftCanvas(stage){
    if(!stage)return null;
    host=stage;
    if(!canvas||canvas.parentNode!==stage){
      canvas=stage.querySelector('.voice-call-fx-canvas');
      if(!canvas){canvas=document.createElement('canvas');canvas.className='voice-call-fx-canvas';canvas.setAttribute('aria-hidden','true');stage.appendChild(canvas)}
    }
    canvas.style.transform='none';canvas.style.direction='ltr';
    sizeCanvas();
    return canvas;
  }
  function sizeCanvas(){
    if(!canvas||!host)return;
    var rect=host.getBoundingClientRect(),w=Math.max(1,rect.width),h=Math.max(1,rect.height),scale=Math.min(2,window.devicePixelRatio||1);
    var old=lastSize;
    if(canvas.width!==Math.round(w*scale)||canvas.height!==Math.round(h*scale)){
      canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);
    }
    canvas._dpr=scale;dpr=scale;
    if(old&&(Math.abs(old.w-w)>1||Math.abs(old.h-h)>1)){
      var sx=w/old.w,sy=h/old.h;
      particles.forEach(function(p){p.x*=sx;p.px*=sx;p.vx*=sx;p.y*=sy;p.py*=sy;p.vy*=sy;p.r*=Math.sqrt(sx*sy);if(p.line)p.line*=Math.sqrt(sx*sy)});
      scenes.forEach(function(s){
        s.D={W:w,H:h,sc:Math.max(.7,Math.min(1.3,h/800))};
        if(s.stars)s.stars.forEach(function(st){st.x*=sx;st.y*=sy;st.r*=Math.sqrt(sx*sy)});
        if(s.x!=null)s.x*=sx;if(s.tx!=null)s.tx*=sx;if(s.y!=null)s.y*=sy;if(s.ty!=null)s.ty*=sy;
        if(s.tail)s.tail.forEach(function(p){p.x*=sx;p.y*=sy});
        if(s.k==='galaxy')s.img=galaxyBuild(s.D);
      });
    }
    lastSize={w:w,h:h};
  }
  function visible(candidate){
    var target=candidate||host;
    if(!target||!target.isConnected||target.hidden||document.visibilityState==='hidden')return false;
    var r=target.getBoundingClientRect();return r.width>0&&r.height>0;
  }
  function showGift(stage,kind,gift){
    if(!stage)return;
    var card=stage.querySelector('.voice-call-gift-toast');
    if(!card){
      card=document.createElement('div');card.className='voice-call-gift-toast';card.setAttribute('aria-hidden','true');
      var icon=document.createElement('span');icon.className='voice-call-gift-toast-art';
      var image=document.createElement('img');image.alt='';image.draggable=false;
      var emoji=document.createElement('span');emoji.className='voice-call-gift-toast-emoji';
      icon.appendChild(image);icon.appendChild(emoji);
      var copy=document.createElement('span');copy.className='voice-call-gift-toast-copy';
      var kicker=document.createElement('small');kicker.textContent='一份心意';
      var title=document.createElement('strong');title.className='voice-call-gift-toast-title';
      copy.appendChild(kicker);copy.appendChild(title);card.appendChild(icon);card.appendChild(copy);stage.appendChild(card);
    }
    var img=card.querySelector('img'),emojiNode=card.querySelector('.voice-call-gift-toast-emoji'),titleNode=card.querySelector('.voice-call-gift-toast-title');
    card.classList.remove('show','tier-1','tier-2','tier-3','tier-4','tier-5');
    card.classList.add('tier-'+String(gift.tier||1));
    titleNode.textContent=gift.label||'礼物';
    if(art[kind]){img.src=art[kind];img.hidden=false;emojiNode.hidden=true}
    else{img.removeAttribute('src');img.hidden=true;emojiNode.hidden=false;emojiNode.textContent=gift.icon||'♥'}
    window.clearTimeout(toastTimer);void card.offsetWidth;card.classList.add('show');
    toastTimer=window.setTimeout(function(){try{card.classList.remove('show')}catch(e){}},kind==='galaxy'?8200:kind==='meteor'?6500:4400);
  }
  function dim(){var c=canvas;var W=c.width/(c._dpr||1),H=c.height/(c._dpr||1);return{W:W,H:H,sc:Math.max(.7,Math.min(1.3,H/800))}}
  function stars(D,count,hf){var out=[];for(var i=0;i<count;i++)out.push({x:Math.random()*D.W,y:Math.random()*D.H*hf,r:.6+Math.random()*1.3,ph:Math.random()*6.28,sp:1.5+Math.random()*2.5});return out}
  function railPoint(D,u){return{x:-D.W*.08+u*D.W*1.16,y:D.H*.42-u*D.H*.24+Math.sin(u*Math.PI*1.3)*D.H*.05}}
  function galaxyBuild(D){
    try{
      var c=document.createElement('canvas'),ratio=Math.min(1.5,(canvas&&canvas._dpr)||1),W=D.W,H=D.H*.62;c.width=Math.round(W*ratio);c.height=Math.round(H*ratio);
      var g=c.getContext('2d');if(!g)return null;g.setTransform(ratio,0,0,ratio,0,0);
      var blobs=[['186,204,255',.16],['210,196,255',.13],['255,236,200',.11],['160,190,255',.14],['236,222,255',.1]];
      for(var i=0;i<34;i++){var u=i/33,p=railPoint(D,u),r=D.H*.07+Math.random()*D.H*.075,b=blobs[i%blobs.length],gr=g.createRadialGradient(p.x,p.y,0,p.x,p.y,r);gr.addColorStop(0,'rgba('+b[0]+','+b[1]+')');gr.addColorStop(.55,'rgba('+b[0]+','+(b[1]*.35).toFixed(3)+')');gr.addColorStop(1,'rgba('+b[0]+',0)');g.fillStyle=gr;g.beginPath();g.arc(p.x,p.y+(Math.random()-.5)*D.H*.05,r,0,6.283);g.fill()}
      for(var j=0;j<40;j++){var u2=j/39,p2=railPoint(D,u2),r2=D.H*.022+Math.random()*D.H*.02,g2=g.createRadialGradient(p2.x,p2.y,0,p2.x,p2.y,r2);g2.addColorStop(0,'rgba(255,248,232,0.24)');g2.addColorStop(1,'rgba(255,248,232,0)');g.fillStyle=g2;g.beginPath();g.arc(p2.x,p2.y,r2,0,6.283);g.fill()}
      var colors=['#ffffff','#dfe9ff','#fff1d6','#cfd8ff'];
      for(var k=0;k<900;k++){var u3=Math.random(),p3=railPoint(D,u3),spread=(Math.random()-.5)*D.H*.24*Math.sqrt(Math.random());g.globalAlpha=.25+Math.random()*.5;g.fillStyle=colors[k%4];g.beginPath();g.arc(p3.x+(Math.random()-.5)*W*.02,p3.y+spread,.35+Math.random()*.7,0,6.283);g.fill()}
      g.globalAlpha=1;return c;
    }catch(e){return null}
  }
  function launch(kind){
    var D=dim();
    if(kind==='meteor')scenes.push({k:'meteor',t:0,dur:5200,next:0,big:600,D:D,stars:stars(D,34,.72),fl:0});
    else if(kind==='galaxy')scenes.push({k:'galaxy',t:0,dur:8200,D:D,stars:stars(D,120,.6),emit:0,met:0,img:galaxyBuild(D)});
    else{var tx=D.W*(.2+Math.random()*.6),ty=D.H*(.14+Math.random()*.3);scenes.push({k:'rocket',t:0,dur:680+Math.random()*180,x:tx+(Math.random()-.5)*D.W*.1,y:D.H*.98,tx:tx,ty:ty,tail:[],D:D})}
  }
  function burst(s){
    var D=s.D,pals=[['#ffd98a','#ffbf7d','#ff9a86','#ffe9b8','#bfdcff'],['#c9a0ff','#e2b8ff','#ffffff','#9fd0ff','#ffd98a'],['#bfe6ff','#ffd6a0','#ffffff','#ffb0a0','#9fd0ff']],pal=pals[Math.floor(Math.random()*pals.length)],base=Math.random()*6.283;
    for(var i=0;i<110;i++){var a=base+i/110*6.283+(Math.random()-.5)*.16,speed=(2.8+Math.random()*3.4)*D.sc;particles.push({x:s.tx,y:s.ty,px:s.tx,py:s.ty,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,life:1,dec:.3+Math.random()*.28,c:pal[i%pal.length],r:1.6+Math.random()*1.3,tw:Math.random()*6.28,g:.026,dr:.981,st:1,cr:i%10<3?1:0})}
    particles.push({x:s.tx,y:s.ty,vx:0,vy:0,life:1,dec:2.2,c:'#fff6dc',r:88*D.sc,glow:1});particles.push({x:s.tx,y:s.ty,vx:0,vy:0,life:1,dec:1.9,r:6*D.sc,ring:1,c:pal[0]});
  }
  function crackle(p){for(var i=0;i<5;i++){var a=Math.random()*6.283,speed=.9+Math.random()*1.4;particles.push({x:p.x,y:p.y,px:p.x,py:p.y,vx:p.vx*.4+Math.cos(a)*speed,vy:p.vy*.4+Math.sin(a)*speed,life:1,dec:1.4+Math.random()*.8,c:['#ffffff','#fff3c9','#ffe1ff'][i%3],r:.9+Math.random()*.8,tw:Math.random()*6.28,g:.02,dr:.97})}}
  function meteorStep(s,dt){
    s.fl=Math.max(0,s.fl-dt/300);if(s.t>=s.dur-1100)return;var D=s.D;s.next-=dt;s.big-=dt;
    function spawn(big){var fromTop=Math.random()<.7,x=fromTop?D.W*(.3+Math.random()*.75):D.W*1.04,y=fromTop?-12-Math.random()*D.H*.08:D.H*(-.05+Math.random()*.4),speed=(big?6+Math.random()*3:9+Math.random()*6)*D.sc,angle=2.28+(Math.random()-.5)*.22;particles.push({x:x,y:y,px:x,py:y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,life:1,dec:big?.55+Math.random()*.25:1+Math.random()*.5,c:big?'#ffffff':['#ffffff','#dfe9ff','#cfd9ff','#ffe9c9'][Math.floor(Math.random()*4)],r:big?2.6+Math.random()*.8:1+Math.random()*.8,tw:Math.random()*6.28,g:.006,dr:.998,line:big?18+Math.random()*8:6+Math.random()*4,big:big?1:0})}
    if(s.next<=0){s.next=90+Math.random()*110;spawn(false)}if(s.big<=0){s.big=620+Math.random()*420;spawn(true);s.fl=1}
  }
  function meteorDraw(g,s){var D=s.D,T=s.t,A=Math.min(1,T/600)*Math.min(1,Math.max(0,(s.dur-T)/900)),grad=g.createLinearGradient(0,0,0,D.H);grad.addColorStop(0,'rgba(124,142,255,'+(.22+.1*s.fl)*A+')');grad.addColorStop(.55,'rgba(96,110,220,'+(.12+.05*s.fl)*A+')');grad.addColorStop(1,'rgba(60,70,160,0)');g.globalAlpha=1;g.fillStyle=grad;g.fillRect(0,0,D.W,D.H);for(var i=0;i<s.stars.length;i++){var st=s.stars[i];g.globalAlpha=A*(.25+.75*Math.abs(Math.sin(st.ph+T/1000*st.sp)));g.fillStyle='#eef4ff';g.beginPath();g.arc(st.x,st.y,st.r,0,6.283);g.fill()}g.globalAlpha=1}
  function galaxyDraw(g,s,dt){
    var D=s.D,T=s.t,A=Math.min(1,T/1000)*Math.min(1,Math.max(0,(s.dur-T)/1400)),H2=D.H*.62,grad=g.createLinearGradient(0,0,0,H2);grad.addColorStop(0,'rgba(8,12,40,'+.36*A+')');grad.addColorStop(.75,'rgba(8,12,40,'+.16*A+')');grad.addColorStop(1,'rgba(8,12,40,0)');g.globalAlpha=1;g.fillStyle=grad;g.fillRect(0,0,D.W,H2);
    if(s.img){var dx=Math.sin(T/6000)*D.W*.015,dy=Math.cos(T/7000)*D.H*.008;g.globalAlpha=A*.96;try{g.drawImage(s.img,dx,dy,D.W,H2)}catch(e){}}
    for(var i=0;i<s.stars.length;i++){var st=s.stars[i],tw=.3+.7*Math.abs(Math.sin(st.ph+T/1000*st.sp));g.globalAlpha=A*tw;g.fillStyle='#f4f7ff';g.beginPath();g.arc(st.x,st.y,st.r,0,6.283);g.fill();if(st.r>1.35){var L=st.r*4*tw;g.globalAlpha=A*tw*.7;g.strokeStyle='#f4f7ff';g.lineWidth=.6;g.beginPath();g.moveTo(st.x-L,st.y);g.lineTo(st.x+L,st.y);g.moveTo(st.x,st.y-L);g.lineTo(st.x,st.y+L);g.stroke()}}
    var u=Math.max(0,Math.min(1,(T-900)/5600));u=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2;
    if(T>=900&&u<1){var hp=railPoint(D,u),halo=g.createRadialGradient(hp.x,hp.y,0,hp.x,hp.y,40*D.sc);halo.addColorStop(0,'rgba(255,236,190,'+.42*A+')');halo.addColorStop(1,'rgba(255,236,190,0)');g.globalAlpha=1;g.fillStyle=halo;g.beginPath();g.arc(hp.x,hp.y,40*D.sc,0,6.283);g.fill();
      for(var c=0;c<7;c++){var uu=u-c*.024;if(uu<0)break;var p1=railPoint(D,uu),p2=railPoint(D,Math.max(0,uu-.012)),ang=Math.atan2(p2.y-p1.y,p2.x-p1.x);g.save();g.translate(p1.x,p1.y);g.rotate(ang);g.globalAlpha=A*(c===0?1:.85);g.fillStyle=c===0?'#fff6e2':'#ffd98a';var len=D.sc*(c===0?16:13),ht=D.sc*(c===0?7:6);g.fillRect(-len/2,-ht/2,len,ht);g.globalAlpha=A*.95;g.fillStyle='#fff9ea';g.fillRect(-len/2+2,-ht/2+1.5,len/2-3,ht-3);g.fillRect(2,-ht/2+1.5,len/2-3,ht-3);g.restore()}
      s.emit-=dt;if(s.emit<=0){s.emit=80;var tp=railPoint(D,Math.max(0,u-.17));particles.push({x:tp.x,y:tp.y,px:tp.x,py:tp.y,vx:(Math.random()-.5)*.5,vy:-.25-Math.random()*.45,life:1,dec:.8+Math.random()*.5,c:['#ffe9b8','#ffd98a','#ffffff'][Math.floor(Math.random()*3)],r:.8+Math.random(),tw:Math.random()*6.28,g:-.003,dr:.99})}
    }
    if(!s.met&&T>=3400){s.met=1;var sx=D.W*(.55+Math.random()*.4),sy=-8,angle=2.35,speed=8*D.sc;particles.push({x:sx,y:sy,px:sx,py:sy,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,life:1,dec:.75,c:'#ffffff',r:2.2,tw:0,g:.004,dr:.998,line:20,big:1})}
    g.globalAlpha=1;
  }
  function draw(ts){
    if(!running)return;
    if(!visible()){reset();return}
    sizeCanvas();var c=canvas,g=c&&c.getContext('2d');if(!g){reset();return}
    var dt=last?Math.min(48,ts-last):16;last=ts;var f=dt/16.7;
    if(queue.length&&ts>=next){var kind=queue.shift();launch(kind);next=ts+(gaps[kind]||1000)+Math.random()*200}
    g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,c.width/dpr,c.height/dpr);var hasMeteor=false;
    for(var i=scenes.length-1;i>=0;i--){var s=scenes[i];s.t+=dt;
      if(s.k==='rocket'){var k=Math.min(1,s.t/s.dur),ease=1-Math.pow(1-k,3),x=s.x+(s.tx-s.x)*ease,y=s.y+(s.ty-s.y)*ease;s.tail.unshift({x:x,y:y});if(s.tail.length>10)s.tail.pop();for(var j=0;j<s.tail.length;j++){var tp=s.tail[j];g.globalAlpha=(1-j/s.tail.length)*.6;g.fillStyle='#ffe4a8';g.beginPath();g.arc(tp.x,tp.y,Math.max(.4,1.8-j*.12),0,6.283);g.fill()}g.globalAlpha=1;g.fillStyle='#fff8e4';g.beginPath();g.arc(x,y,2.3,0,6.283);g.fill();if(Math.random()<.6)particles.push({x:x,y:y,px:x,py:y,vx:(Math.random()-.5)*.9,vy:.4+Math.random()*.8,life:1,dec:2.2+Math.random(),c:'#ffd98a',r:.8+Math.random()*.7,tw:0,g:.03,dr:.98});if(k>=1){scenes.splice(i,1);burst(s)}}
      else if(s.k==='meteor'){hasMeteor=true;meteorDraw(g,s);meteorStep(s,dt);if(s.t>=s.dur)scenes.splice(i,1)}
      else if(s.k==='galaxy'){galaxyDraw(g,s,dt);if(s.t>=s.dur)scenes.splice(i,1)}
    }
    for(var pi=particles.length-1;pi>=0;pi--){var p=particles[pi];
      if(p.glow){p.life-=p.dec*dt/1000;if(p.life<=0){particles.splice(pi,1);continue}var glow=g.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r);glow.addColorStop(0,'rgba(255,246,220,'+.6*p.life+')');glow.addColorStop(1,'rgba(255,246,220,0)');g.globalAlpha=1;g.fillStyle=glow;g.beginPath();g.arc(p.x,p.y,p.r,0,6.283);g.fill();continue}
      if(p.ring){p.life-=p.dec*dt/1000;if(p.life<=0){particles.splice(pi,1);continue}var radius=p.r+(1-p.life)*140*(p.r/6);g.globalAlpha=.55*p.life;g.strokeStyle=p.c;g.lineWidth=2.2*p.life+.4;g.beginPath();g.arc(p.x,p.y,radius,0,6.283);g.stroke();continue}
      p.px=p.x;p.py=p.y;var drag=Math.pow(p.dr||.975,f);p.vx*=drag;p.vy=p.vy*drag+(p.g||0)*f;p.x+=p.vx*f;p.y+=p.vy*f;p.life-=p.dec*dt/1000;p.tw+=.35*f;if(p.life<=0){particles.splice(pi,1);continue}if(p.cr&&p.life<.52){p.cr=0;crackle(p)}
      var alpha=Math.max(0,Math.min(1,p.life))*(p.life<.35?.55+.45*Math.abs(Math.sin(p.tw)):1);
      if(p.line){var line=p.line,lg=g.createLinearGradient(p.x,p.y,p.x-p.vx*line,p.y-p.vy*line);lg.addColorStop(0,p.c);lg.addColorStop(1,'rgba(255,255,255,0)');g.globalAlpha=alpha;g.strokeStyle=lg;g.lineWidth=p.r;g.lineCap='round';g.beginPath();g.moveTo(p.x,p.y);g.lineTo(p.x-p.vx*line,p.y-p.vy*line);g.stroke();if(p.big){var head=g.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r*6);head.addColorStop(0,'rgba(255,255,255,'+.7*alpha+')');head.addColorStop(.4,'rgba(200,215,255,'+.28*alpha+')');head.addColorStop(1,'rgba(200,215,255,0)');g.fillStyle=head;g.beginPath();g.arc(p.x,p.y,p.r*6,0,6.283);g.fill();if(Math.random()<.7&&particles.length<420)particles.push({x:p.x-p.vx*(1+Math.random()*3),y:p.y-p.vy*(1+Math.random()*3),px:p.x,py:p.y,vx:(Math.random()-.5)*.8,vy:(Math.random()-.5)*.8,life:1,dec:1.6+Math.random()*.8,c:['#ffffff','#ffe9c9','#dfe9ff'][Math.floor(Math.random()*3)],r:.7+Math.random()*.7,tw:0,g:.012,dr:.985});g.fillStyle='#fff';g.beginPath();g.arc(p.x,p.y,p.r*.9,0,6.283);g.fill();continue}}
      if(p.st){g.globalAlpha=alpha*.55;g.strokeStyle=p.c;g.lineWidth=p.r*1.5;g.lineCap='round';g.beginPath();g.moveTo(p.px,p.py);g.lineTo(p.x,p.y);g.stroke()}g.globalAlpha=alpha;g.fillStyle=p.c;g.beginPath();g.arc(p.x,p.y,p.r*(.6+.4*p.life),0,6.283);g.fill();
    }
    g.globalAlpha=1;
    if(!queue.length&&!scenes.length&&!particles.length){reset();return}
    requestAnimationFrame(draw);
  }
  function reset(hideToast){
    queue.length=0;scenes.length=0;particles.length=0;running=false;last=0;next=0;
    if(canvas){try{var g=canvas.getContext('2d');if(g)g.clearRect(0,0,canvas.width,canvas.height)}catch(e){}}
    if(hideToast){window.clearTimeout(toastTimer);toastTimer=0;var card=host&&host.querySelector('.voice-call-gift-toast');if(card)card.classList.remove('show')}
  }
  function play(stage,kind,gift){
    showGift(stage,kind,gift||{});
    if(['fireworks','meteor','galaxy'].indexOf(kind)<0||!stage||!visible(stage)||(reduceMotion&&reduceMotion.matches))return;
    giftCanvas(stage);if(!canvas)return;queue.push(kind);
    if(!running){running=true;next=0;last=0;requestAnimationFrame(draw)}
  }
  window.addEventListener('resize',function(){if(canvas&&host&&host.isConnected)sizeCanvas()},{passive:true});
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'&&running)reset()});
  var api={play:play,reset:reset,art:art};
  window.IBCallGiftEffects=api;NS.callGiftEffects=api;
})(window.IB||(window.IB={}));
