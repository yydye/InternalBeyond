(function(NS){
/* ============================================================
   SUI'S ROOM — Room engine tail: wardrobe, render loop,
   sprites, save/load, panel & pet modes, boot. Split from
   game_module.js.
   ============================================================ */
'use strict';


/* ── WARDROBE ────────────────────────────────────────── */
function interactWardrobe(){
  const lines = FIXED_LINES.wardrobe_intro;
  const text = Array.isArray(lines) ? lines[Math.floor(Math.random()*lines.length)] : lines;
  showDialogue('Sui',[text],()=>{
    closeDialogue();
    openWardrobe();
  });
}

function openWardrobe(){
  if(!G.viewport){G.state='idle';return}
  G.wardrobeOpen=true;
  const panel=G.viewport.querySelector('#game-wardrobe');
  if(!panel){G.state='idle';G.wardrobeOpen=false;return}
  panel.innerHTML=`<h4>Wardrobe</h4><div class="game-wardrobe-divider"><span></span></div><div class="game-wardrobe-grid">${OUTFITS.map((o,i)=>
    `<button class="game-wardrobe-item ${i===G.outfitIdx?'active':''}" data-idx="${i}"><span class="game-wardrobe-dot"></span>${o.label}</button>`
  ).join('')}</div><button class="game-wardrobe-close" id="wardrobe-close">Close</button>`;
  panel.classList.add('show');

  panel.querySelectorAll('[data-idx]').forEach(btn=>{
    btn.addEventListener('click',async ()=>{
      const idx=parseInt(btn.dataset.idx);
      if(idx===G.outfitIdx){closeWardrobe();G.state='idle';return}
      G.outfitIdx=idx;
      await loadOutfitAssets(idx);
      updateCharSprite();
      closeWardrobe();
      G.state='idle';
      saveState();
    });
  });
  panel.querySelector('#wardrobe-close').addEventListener('click',()=>{closeWardrobe();G.state='idle'});
}

function closeWardrobe(){
  G.wardrobeOpen=false;
  if(G.viewport){const el=G.viewport.querySelector('#game-wardrobe');if(el)el.classList.remove('show')}
}

/* ── RENDER LOOP ─────────────────────────────────────── */
function gameLoop(time){
  if(!G.running){return}
  const dt=time-G.lastTime;
  G.lastTime=time;

  switch(G.state){
    case 'sleeping':
    case 'waking':
    case 'lying':
      updateLie(dt);
      break;
    case 'walking':
      updateWalk(dt);
      break;
    case 'idle':
    case 'interacting':
      updateIdle(dt);
      break;
  }

  updateMarkers();
  if(G.petMode) updatePetCamera();
  G.animFrame=requestAnimationFrame(gameLoop);
}

function updateWalk(dt){
  if(G.targetX===null){G.state='idle';return}
  /* Follow the waypoint path (last element ≈ final target) */
  const dest = (G.path&&G.path.length) ? G.path[0] : {x:G.targetX,y:G.targetY};
  const dx=dest.x-G.charX, dy=dest.y-G.charY;
  const dist=Math.hypot(dx,dy);
  if(dist<4){
    if(G.path&&G.path.length>1){
      G.path.shift(); /* reached a waypoint, advance to next */
    }else{
      /* Reached final target */
      G.charX=G.targetX; G.charY=G.targetY;
      G.targetX=null; G.targetY=null; G.path=null;
      G.state='idle'; G.walkFrame=0;
      handleArrival();
      updateCharPosition(); updateCharSprite();
      return;
    }
  }
  const speed=CHAR_SPEED;
  const vx=(dx/dist)*speed, vy=(dy/dist)*speed;
  const nx=G.charX+vx, ny=G.charY+vy;
  if(isWalkable(nx,ny)){
    G.charX=nx; G.charY=ny;
  }else{
    /* Slide along the obstacle edge */
    if(isWalkable(G.charX+vx,G.charY)) G.charX+=vx;
    else if(isWalkable(G.charX,G.charY+vy)) G.charY+=vy;
    else{
      /* Truly stuck: drop this waypoint, or finish if it was the last */
      if(G.path&&G.path.length>1){
        G.path.shift();
      }else{
        G.state='idle'; G.targetX=null; G.targetY=null; G.path=null;
        handleArrival();
        return;
      }
    }
  }
  /* Update facing */
  if(Math.abs(dx)>Math.abs(dy)) G.facing=dx>0?'right':'left';
  else G.facing=dy>0?'down':'up';
  /* Animate walk - RPG Maker style: stand→step1→stand→step2 */
  G.walkTimer+=dt;
  if(G.walkTimer>1000/WALK_FPS){
    G.walkTimer=0;
    G.walkFrame=(G.walkFrame+1)%4;
  }
  updateCharPosition();
  updateCharSprite();
}

function updateIdle(dt){
  G.idleTimer+=dt;
  if(G.idleTimer>IDLE_INTERVAL){
    G.idleTimer=0;
    /* Blink animation: frame 0→1→2→1→0 */
    G.idleFrame=1;
    updateIdleSprite();
    setTimeout(()=>{G.idleFrame=2;updateIdleSprite()},120);
    setTimeout(()=>{G.idleFrame=1;updateIdleSprite()},240);
    setTimeout(()=>{G.idleFrame=0;updateIdleSprite()},360);
  }
  updateCharPosition();
  updateIdleSprite();
}

function updateLie(dt){
  G.lieTimer+=dt;
  const interval = G.lieMode==='sleeping'?800:1200;
  if(G.lieTimer>interval){
    G.lieTimer=0;
    if(G.lieMode==='awake'){
      G.lieFrame=G.lieFrame===0?1:0; // frames 0-1
    }else{
      G.lieFrame=G.lieFrame===1?2:1; // frames 1-2
    }
    updateLieSprite();
  }
}

/* ── SPRITE RENDERING ────────────────────────────────── */
function updateCharPosition(){
  if(!G.viewport) return;
  const el=G.viewport.querySelector('#game-char');
  if(!el) return;
  el.style.left=(G.charX-SPRITE_SIZE/2)+'px';
  el.style.top=(G.charY-SPRITE_SIZE+20)+'px'; // feet at bottom, offset up
  /* 水晶球地面光晕投在角色身上：按与光心距离调强度；仅在量化值变化时写样式，几乎零开销 */
  const lc=el.querySelector('.game-char-lightcast');
  if(lc){
    const d=Math.hypot(G.charX-CRYSTAL_FLOOR_LIGHT.x,G.charY-CRYSTAL_FLOOR_LIGHT.y);
    const o=Math.round(Math.max(0,Math.min(1,1-d/CRYSTAL_FLOOR_LIGHT.r))*20)/20;
    if(lc._o!==o){lc._o=o;lc.style.opacity=o;el.classList.toggle('in-crystal-light',o>0.05)}
  }
}

function updateCharSprite(){
  if(!G.viewport) return;
  const img=G.viewport.querySelector('#game-char-img');
  if(!img||!G.assets.walk) return;
  img.src=G.assets.walk.src;
  const row = {down:0,left:1,right:2,up:3}[G.facing]||0;
  /* Walk cycle: stand(1)→step1(0)→stand(1)→step2(2) */
  const walkCycle=[1,0,1,2];
  const col = G.state==='walking'?walkCycle[G.walkFrame%4]:1;
  img.style.left=(-col*SPRITE_SIZE)+'px';
  img.style.top=(-row*SPRITE_SIZE)+'px';
  img.style.width='441px';img.style.height='588px';
  const charEl=G.viewport.querySelector('#game-char');
  if(charEl) charEl.style.display='block';
  const lieEl=G.viewport.querySelector('#game-char-lie');
  if(lieEl) lieEl.style.display='none';
}

function updateIdleSprite(){
  if(!G.viewport) return;
  if(G.teaAnimActive) return; /* Don't override tea sitting animation */
  const img=G.viewport.querySelector('#game-char-img');
  if(!img||!G.assets.idle) return;
  img.src=G.assets.idle.src;
  img.style.left=(-G.idleFrame*SPRITE_SIZE)+'px';
  img.style.top='0px';
  img.style.width='441px';img.style.height='147px';
}

function updateLieSprite(){
  if(!G.viewport) return;
  const el=G.viewport.querySelector('#game-char-lie');
  const img=G.viewport.querySelector('#game-char-lie-img');
  if(!el||!img||!G.assets.lie) return;
  el.style.display='block';
  const charEl=G.viewport.querySelector('#game-char');
  if(charEl) charEl.style.display='none';
  img.src=G.assets.lie.src;
  /* 3 frames in 614px wide sheet, each ~205px */
  const fw=Math.floor(614/3);
  img.style.width='614px';img.style.height='151px';
  img.style.position='absolute';
  img.style.left=(-G.lieFrame*fw)+'px';
  img.style.top='0px';
  /* Position on bed */
  el.style.left=BED_LIE_X+'px';el.style.top=BED_LIE_Y+'px';
  el.style.width=fw+'px';el.style.height='151px';
  el.style.overflow='hidden';
  el.style.position='absolute';
}

/* ── THEME OBSERVER ──────────────────────────────────── */
function setupThemeObserver(){
  const obs=new MutationObserver(()=>{
    if(!G.viewport)return;
    const isNight=document.body.classList.contains('theme-infernal');
    G.viewport.querySelector('.game-bg-day').style.opacity=isNight?'0':'1';
    G.viewport.querySelector('.game-bg-night').style.opacity=isNight?'1':'0';
  });
  obs.observe(document.body,{attributes:true,attributeFilter:['class']});
}

/* ── SAVE / LOAD ─────────────────────────────────────── */
async function saveState(){
  try{
    const data={outfitIdx:G.outfitIdx,charX:G.charX,charY:G.charY,
      facing:G.facing,state:G.state,lieMode:G.lieMode,isFirstOpen:G.isFirstOpen};
    localStorage.setItem('suiGameState',JSON.stringify(data));
  }catch(e){console.warn('Game save failed:',e)}
}

async function loadState(){
  try{
    const raw=localStorage.getItem('suiGameState');
    if(raw){
      const s=JSON.parse(raw);
      /* BUGFIX (wardrobe): the outfit is intentionally NOT restored from the
         save. loadAssets() runs before loadState() and loads sprites for the
         default outfit (Casual), so restoring a different saved index here left
         the wardrobe showing a stale selection (e.g. a previously tried-on
         Wedding) while the character still wore Casual. Every page load now
         starts in the default outfit, matching the fresh-open design below. */
      G.charX=s.charX||BED_STAND_X;
      G.charY=s.charY||BED_STAND_Y;
      G.facing=s.facing||'down';
      G.isFirstOpen=true; /* Always treat as first open per page load — Sui auto-wakes */
      if(s.state==='sleeping'||s.state==='lying'){
        G.state=s.state;
        G.lieMode=s.lieMode||'awake';
      }else{
        G.state='idle';
      }
    }
  }catch(e){console.warn('Game load failed:',e)}
}

/* Game state stored in localStorage — no DB upgrade needed */

/* ── PANEL OPEN / CLOSE ──────────────────────────────── */
async function openGamePanel(){
  G.mode='float';
  const panel=document.getElementById('game-panel');
  const container=document.getElementById('game-panel-viewport-container');
  /* Show panel immediately with loading text */
  panel.style.left='50%';
  panel.style.top='50%';
  panel.style.transform='translate(-50%,-50%)';
  panel.style.width='320px';panel.style.height='200px';
  panel.classList.add('show');
  document.getElementById('game-mini').style.display='none';

  if(!G.initialized){
    container.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:160px;color:var(--silver);font-family:Cormorant Garamond,serif;font-style:italic;font-size:0.95rem;letter-spacing:0.05em">Loading...</div>';
    try{
      await initGame(container);
    }catch(e){
      console.error('[SuiGame] Init failed:',e);
      container.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:160px;color:#e88;font-size:0.85rem;padding:20px;text-align:center">加载失败，请按F12查看控制台<br>'+e.message+'</div>';
      return;
    }
  }else if(G.viewport && G.viewport.parentElement!==container){
    container.appendChild(G.viewport);
  }
  updateScale();
  /* Re-center after resize */
  panel.style.left='50%';
  panel.style.top='50%';
  panel.style.transform='translate(-50%,-50%)';
  if(!G.running) startLoop();
}

function closeGamePanel(){
  document.getElementById('game-panel').classList.remove('show');
  document.getElementById('game-mini').style.display='block';
  saveState();
  pauseGame();
}

/* ── PET MODE (350×350 QQ-pet window) ─────────────────── */
const PET_SIZE=350;

async function enterPetMode(){
  /* Block entry during interactive states that would break in mini view (Tea is allowed) */
  if(G.dialogueActive||G.aiGameActive||G.tarotOpen||G.wardrobeOpen||G.tourActive||suiActive) return;
  /* Close any open panel first */
  document.getElementById('game-panel').classList.remove('show');
  document.getElementById('game-mini').style.display='none';
  G.mode='pet';
  G.petMode=true;

  const petWin=document.getElementById('game-pet-window');
  const wrap=document.getElementById('game-pet-viewport-wrap');

  if(!G.initialized){
    wrap.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:'+PET_SIZE+'px;color:var(--silver);font-family:Cormorant Garamond,serif;font-style:italic;font-size:0.85rem">Loading...</div>';
    try{ await initGame(wrap); }catch(e){ console.error('[SuiGame] Pet init failed:',e); return; }
  }else if(G.viewport && G.viewport.parentElement!==wrap){
    wrap.appendChild(G.viewport);
  }

  /* 1:1 scale — native resolution, no scaling blur */
  G.petScale = 1.0;
  G.viewport.style.transformOrigin='top left';

  /* Position the pet window */
  petWin.style.right='20px';
  petWin.style.bottom='20px';
  petWin.style.left='auto';
  petWin.style.top='auto';
  petWin.classList.add('show');

  /* Hide interaction markers in pet mode */
  var ind=G.viewport.querySelector('#game-indicators');
  if(ind) ind.style.display='none';

  /* Wire pet buttons */
  document.getElementById('pet-sleep-btn').onclick=function(){
    if(G.state==='sleeping'||G.state==='lying') return;
    if(G.teaChatActive||G.teaOpen||G.teaAnimActive) return; /* don't interrupt tea */
    /* Direct sleep: walk to bed, then sleep without dialogue */
    petSleep();
  };
  document.getElementById('pet-exit-btn').onclick=function(){ exitPetMode(); };

  updatePetCamera();
  if(!G.running) startLoop();
}

function exitPetMode(){
  G.petMode=false;
  G.mode='float';
  document.getElementById('game-pet-window').classList.remove('show');
  document.getElementById('game-mini').style.display='block';

  /* Restore viewport transform (remove pet camera offset) */
  if(G.viewport){
    G.viewport.style.transform='scale('+(G.scale||0.5)+')';
    G.viewport.style.transformOrigin='top left';
  }

  /* Restore interaction markers */
  var ind=G.viewport?G.viewport.querySelector('#game-indicators'):null;
  if(ind) ind.style.display='';

  saveState();
  pauseGame();
}

function petSleep(){
  if(!G.viewport) return;
  /* If already sleeping/lying, do nothing */
  if(G.state==='sleeping'||G.state==='lying') return;
  /* Walk to bed, then sleep directly (no dialogue) */
  startWalkTo(BED_SLEEP_WALK_X, BED_SLEEP_WALK_Y);
  G.onArrive=function(){
    G.facing='up';
    /* Skip dialogue — go straight to sleep animation */
    setTimeout(function(){
      if(!G.viewport) return;
      G.viewport.querySelector('#game-char').style.display='none';
      G.viewport.querySelector('#game-char-lie').style.display='block';
      G.state='lying'; G.lieMode='sleeping'; G.lieFrame=1;
      updateLieSprite();
      showZzz(true);
      saveState();
    }, 300);
  };
}

function updatePetCamera(){
  if(!G.viewport||!G.petMode) return;
  /* Center camera on character (or bed if sleeping/lying) */
  var cx,cy;
  if(G.state==='sleeping'||G.state==='lying'){
    cx=BED_LIE_X+LIE_FW/2;
    cy=BED_LIE_Y+LIE_FH/2;
  }else{
    cx=G.charX;
    cy=G.charY;
  }
  /* Aesthetic offset: during restful states, pull camera toward bottom-right
     so Sui sits upper-left of frame with more room atmosphere visible.
     ┌─────────────────────────────────────────────────────────┐
     │  HOW TO ADJUST:  search "petCamOffset" in this file.   │
     │  cx += N  →  bigger N = camera moves RIGHT (Sui LEFT)  │
     │  cy += N  →  bigger N = camera moves DOWN  (Sui UP)    │
     │  Values are in game-pixels. Safe range: 0 – 120.       │
     └─────────────────────────────────────────────────────────┘ */
  /* petCamOffset — sleep */
  if(G.state==='sleeping'||G.state==='lying'){ cx+=5; cy+=45; }
  /* petCamOffset — tea */
  else if(G.teaChatActive||G.teaAnimActive){ cx+=75; cy+=45; }
  /* How many game-pixels fit in the pet window at current scale */
  var viewW=PET_SIZE/G.petScale;
  var viewH=PET_SIZE/G.petScale;
  var halfW=viewW/2;
  var halfH=viewH/2;
  /* Clamp so we don't show outside the game world, then ROUND to prevent sub-pixel blur on pixel art */
  var camX=Math.round(Math.max(0,Math.min(GAME_W-viewW, cx-halfW)));
  var camY=Math.round(Math.max(0,Math.min(GAME_H-viewH, cy-halfH)));
  G.petCamX=camX;
  G.petCamY=camY;
  G.viewport.style.transform='scale('+G.petScale+') translate('+(-camX)+'px,'+(-camY)+'px)';
  /* Grey out Sleep button while tea is active (runs each frame but only writes DOM on state change) */
  var psb=document.getElementById('pet-sleep-btn');
  if(psb){
    var tLock=!!(G.teaChatActive||G.teaOpen||G.teaAnimActive);
    if(psb._tLock!==tLock){
      psb._tLock=tLock;
      psb.style.opacity=tLock?'0.25':'';
      psb.style.pointerEvents=tLock?'none':'';
    }
  }
}

function pauseGame(){
  G.running=false;
  if(G.animFrame){cancelAnimationFrame(G.animFrame);G.animFrame=null}
}

async function openGamePage(){
  G.mode='page';
  const container=document.getElementById('game-fullpage-container');
  if(!G.initialized){
    container.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:300px;color:var(--silver);font-family:Cormorant Garamond,serif;font-style:italic;font-size:1rem;letter-spacing:0.05em">Loading...</div>';
    try{
      await initGame(container);
    }catch(e){
      console.error('[SuiGame] Init failed:',e);
      container.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:300px;color:#e88;font-size:0.85rem;padding:20px;text-align:center">加载失败，请按F12查看控制台<br>'+e.message+'</div>';
      return;
    }
  }else if(G.viewport && G.viewport.parentElement!==container){
    container.appendChild(G.viewport);
  }
  updateScale();
  requestAnimationFrame(()=>{if(G.viewport&&G.mode==='page')updateScale()});
  if(!G.running) startLoop();
  /* If the room was already initialized, initGame won't run — start the tour here */
  if(G.pendingTour && G.initialized){
    G.pendingTour=false;
    setTimeout(()=>startHomeTour({fromWelcome:true}), 300);
  }
}

function startLoop(){
  G.running=true;
  G.lastTime=performance.now();
  G.animFrame=requestAnimationFrame(gameLoop);
}

/* ── INITIALIZATION ──────────────────────────────────── */
async function initGame(container){
  G.container=container;
  await loadAssets();
  await loadState();
  createViewport(container);
  updateScale();

  /* Set initial state */
  if(G.pendingTour){
    /* Entered via "家园引导": show Sui asleep briefly, then she wakes into the tour */
    G.pendingTour=false; /* consume now so the openGamePage fallback can't re-fire */
    G.state='sleeping'; G.lieMode='sleeping'; G.lieFrame=1;
    updateLieSprite();
    showZzz(true);
    G.viewport.querySelector('#game-char').style.display='none';
    G.viewport.querySelector('#game-char-lie').style.display='block';
    toggleSidebar(true);
    setTimeout(()=>{
      startHomeTour({fromWelcome:true});
    }, 1400);
  }else if(G.isFirstOpen || G.state==='sleeping'){
    G.state='sleeping';
    G.lieMode='sleeping';
    G.lieFrame=1; /* sleeping starts at frame 1 (0-indexed) for frames 2-3 cycle */
    updateLieSprite();
    showZzz(true);
    G.viewport.querySelector('#game-char').style.display='none';
    G.viewport.querySelector('#game-char-lie').style.display='block';
    toggleSidebar(true);
    /* Auto-wake: Sui gets up by herself after a brief pause */
    setTimeout(()=>{
      if(G.state!=='sleeping') return; /* Already woken by click */
      showZzz(false);
      /* Brief awake-in-bed animation before standing */
      G.lieMode='awake'; G.lieFrame=0;
      updateLieSprite();
      setTimeout(()=>{
        if(!G.viewport) return;
        G.viewport.querySelector('#game-char-lie').style.display='none';
        G.viewport.querySelector('#game-char').style.display='block';
        G.charX=BED_STAND_X; G.charY=BED_STAND_Y;
        G.state='idle'; G.facing='down'; G.isFirstOpen=false;
        updateCharPosition(); updateIdleSprite();
        toggleSidebar(true);
        saveState();
      }, 800);
    }, 1500);
  }else if(G.state==='lying'){
    updateLieSprite();
    G.viewport.querySelector('#game-char').style.display='none';
    G.viewport.querySelector('#game-char-lie').style.display='block';
    showZzz(true);
    toggleSidebar(true);
  }else{
    G.state='idle';
    updateCharPosition();
    updateCharSprite();
    updateIdleSprite();
    toggleSidebar(true);
  }

  /* Fade in */
  const fade=G.viewport.querySelector('#game-fade');
  setTimeout(()=>fade.classList.add('hidden'),300);

  G.initialized=true;
  setupThemeObserver();
}

/* ── DRAGGABLE PANEL ─────────────────────────────────── */
function setupDrag(){
  const panel=document.getElementById('game-panel');
  const handle=document.getElementById('game-panel-header');
  let dragging=false,startX,startY,startLeft,startTop;
  handle.addEventListener('mousedown',e=>{
    if(e.target.closest('.game-panel-close'))return;
    dragging=true;
    const rect=panel.getBoundingClientRect();
    startX=e.clientX;startY=e.clientY;startLeft=rect.left;startTop=rect.top;
    panel.style.transform='none';
    panel.style.left=startLeft+'px';panel.style.top=startTop+'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    panel.style.left=(startLeft+e.clientX-startX)+'px';
    panel.style.top=(startTop+e.clientY-startY)+'px';
  });
  document.addEventListener('mouseup',()=>{dragging=false});
  /* Touch support for mobile */
  handle.addEventListener('touchstart',e=>{
    if(e.target.closest('.game-panel-close'))return;
    dragging=true;
    const t=e.touches[0];
    const rect=panel.getBoundingClientRect();
    startX=t.clientX;startY=t.clientY;startLeft=rect.left;startTop=rect.top;
    panel.style.transform='none';
    panel.style.left=startLeft+'px';panel.style.top=startTop+'px';
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!dragging)return;
    const t=e.touches[0];
    panel.style.left=(startLeft+t.clientX-startX)+'px';
    panel.style.top=(startTop+t.clientY-startY)+'px';
  },{passive:true});
  document.addEventListener('touchend',()=>{dragging=false});
  document.getElementById('game-panel-close').addEventListener('click',closeGamePanel);
  document.getElementById('game-pet-enter').addEventListener('click',enterPetMode);
  /* Zoom controls */
  document.getElementById('game-zoom-in').addEventListener('click',()=>{
    G.userScale=Math.min((G.userScale||1)+0.1, 1.2);updateScale()});
  document.getElementById('game-zoom-out').addEventListener('click',()=>{
    G.userScale=Math.max((G.userScale||1)-0.1, 0.35);updateScale()});
}

/* ── HOOK INTO EXISTING NAV ──────────────────────────── */
function hookNavigation(){
  const origNavTo=window.navTo;
  window.navTo=function(page){
    if(page==='game'){
      document.getElementById('game-mini').style.display='none';
      /* Exit pet mode if active */
      if(G.petMode){
        G.petMode=false;
        document.getElementById('game-pet-window').classList.remove('show');
        var ind2=G.viewport?G.viewport.querySelector('#game-indicators'):null;
        if(ind2) ind2.style.display='';
      }
      /* Close floating panel if open */
      document.getElementById('game-panel').classList.remove('show');
      /* Refresh API configs from storage so the Tea / Story / Tarot modules
         always see the latest configured APIs — even if the user added an API
         and came straight here without ever opening the API Settings page. */
      if(typeof loadApiConfigs==='function'){ try{ loadApiConfigs(); }catch(e){} }
      /* Use original navTo to handle page display (it will find #page-game) */
      origNavTo(page);
      /* Then initialize game in the full page container */
      openGamePage();
    }else{
      if(G.petMode){
        /* Keep pet window visible while on other pages — just save state */
        saveState();
      }else{
        if(G.running){saveState();pauseGame()}
        document.getElementById('game-mini').style.display='block';
      }
      origNavTo(page);
    }
  };
}

/* ── RESIZE HANDLER ──────────────────────────────────── */
function setupResize(){
  window.addEventListener('resize',()=>{if(G.initialized)updateScale()});
}

/* ── SIDEBAR TOGGLE ───────────────────────────────────── */
function toggleSidebar(show){
  /* Sidebar is always visible — never hidden */
  document.querySelectorAll('.game-sidebar').forEach(el=>{
    el.classList.remove('hidden');
  });
  if(G.initialized) updateScale();
}
function disableSidebarButtons(disable){
  document.querySelectorAll('.game-sidebar-btn').forEach(btn=>{
    if(disable){
      btn.classList.add('disabled');
    }else{
      btn.classList.remove('disabled');
    }
  });
  /* Hide the interaction markers while controls are disabled
     (visibility is also continuously governed by updateMarkers) */
  document.querySelectorAll('.ix-marker').forEach(m=>{
    m.style.display = disable ? 'none' : '';
  });
  /* Disable Mini button unless we're in a tea state (tea is allowed in mini mode) */
  var miniBtn=document.getElementById('game-pet-enter');
  if(miniBtn){
    var teaException=G.teaChatActive||G.teaOpen||G.teaAnimActive;
    var blocked=disable&&!teaException;
    miniBtn.style.pointerEvents=blocked?'none':'';
    miniBtn.style.opacity=blocked?'0.25':'0.7';
  }
}
function setupSidebar(){
  document.querySelectorAll('.game-sidebar-btn, .game-sidebar-btn-reset').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      onInteract(btn.dataset.action);
    });
  });
}

/* ── BOOTSTRAP ───────────────────────────────────────── */
function bootstrap(){
  injectCSS();
  injectHTML();
  setupDrag();
  setupSidebar();
  hookNavigation();
  setupResize();

  /* Show mini icon after site enters */
  const checkSplash=setInterval(()=>{
    const splash=document.getElementById('splash');
    if(splash && splash.classList.contains('hidden')){
      clearInterval(checkSplash);
      setTimeout(()=>{
        document.getElementById('game-mini').classList.add('visible');
      },5200);
    }
  },500);
}

/* Make G accessible for debugging and AI setup panel */
window.G=G;

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',bootstrap);
}else{
  /* BUGFIX(潜伏): 立即调用会踩中 TEA_CSS/STORY_CSS（声明在本文件更靠后）的 TDZ——
     当前 <script src> 同步加载走不到这个分支，但一旦加 defer/async 或改为动态加载，
     整个游戏模块会在 injectCSS 处 ReferenceError 崩掉。推迟一个宏任务，等全文件求值完毕再启动。 */
  setTimeout(bootstrap,0);
}

/* ---- IB 命名空间迁移：双挂载（window 实时 + IB.game 合并注册）。严格模式保持：IIFE 开括号置于文件头注释之前。 ---- */
function ibGameLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.interactWardrobe=interactWardrobe;
window.openWardrobe=openWardrobe;
window.closeWardrobe=closeWardrobe;
window.gameLoop=gameLoop;
window.updateWalk=updateWalk;
window.updateIdle=updateIdle;
window.updateLie=updateLie;
window.updateCharPosition=updateCharPosition;
window.updateCharSprite=updateCharSprite;
window.updateIdleSprite=updateIdleSprite;
window.updateLieSprite=updateLieSprite;
window.setupThemeObserver=setupThemeObserver;
window.saveState=saveState;
window.loadState=loadState;
window.openGamePanel=openGamePanel;
window.closeGamePanel=closeGamePanel;
window.enterPetMode=enterPetMode;
window.exitPetMode=exitPetMode;
window.petSleep=petSleep;
window.updatePetCamera=updatePetCamera;
window.pauseGame=pauseGame;
window.openGamePage=openGamePage;
window.startLoop=startLoop;
window.initGame=initGame;
window.setupDrag=setupDrag;
window.hookNavigation=hookNavigation;
window.setupResize=setupResize;
window.toggleSidebar=toggleSidebar;
window.disableSidebarButtons=disableSidebarButtons;
window.setupSidebar=setupSidebar;
window.bootstrap=bootstrap;
window.PET_SIZE=PET_SIZE;
NS.expose('game', {
  interactWardrobe: interactWardrobe,
  openWardrobe: openWardrobe,
  closeWardrobe: closeWardrobe,
  gameLoop: gameLoop,
  updateWalk: updateWalk,
  updateIdle: updateIdle,
  updateLie: updateLie,
  updateCharPosition: updateCharPosition,
  updateCharSprite: updateCharSprite,
  updateIdleSprite: updateIdleSprite,
  updateLieSprite: updateLieSprite,
  setupThemeObserver: setupThemeObserver,
  saveState: saveState,
  loadState: loadState,
  openGamePanel: openGamePanel,
  closeGamePanel: closeGamePanel,
  enterPetMode: enterPetMode,
  exitPetMode: exitPetMode,
  petSleep: petSleep,
  updatePetCamera: updatePetCamera,
  pauseGame: pauseGame,
  openGamePage: openGamePage,
  startLoop: startLoop,
  initGame: initGame,
  setupDrag: setupDrag,
  hookNavigation: hookNavigation,
  setupResize: setupResize,
  toggleSidebar: toggleSidebar,
  disableSidebarButtons: disableSidebarButtons,
  setupSidebar: setupSidebar,
  bootstrap: bootstrap,
  PET_SIZE: PET_SIZE,
});
})(window.IB || (window.IB = {}));
