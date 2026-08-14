(function(NS){
/* ============================================================
   SUI'S ROOM — Game Module for Internal Beyond
   A pixel-art life sim / visual novel module
   ============================================================ */
'use strict';

/* ── CONFIGURATION ─────────────────────────────────────── */
const GAME_W = 1672, GAME_H = 941;
const SPRITE_SIZE = 147;           // walk/idle frame size
const LIE_FW = 205, LIE_FH = 151; // lie frame (614/3 ≈ 205)
const CHAR_SPEED = 3.2;           // px per frame at 60fps
const WALK_FPS = 6;               // walk animation speed
const IDLE_INTERVAL = 3500;       // ms between idle blinks
const TYPE_SPEED = 35;            // ms per character (typewriter)
const DIALOGUE_MAX_CHARS = 120;   // chars per dialogue page (3 lines)
const DIALOGUE_MAX_LINES = 3;     // 对话框可视行数（文本区高度≈32%×334px≈3行，overflow:hidden）
const DIALOGUE_LINE_CHARS = 44;   // 每可视行可容纳的全角字符数（半角抉0.5计，文本区宽≈845px/18px≈46，田44保底）

/* ── WALKABLE AREA ─────────────────────────────────────── */
const WALK_POLY = [
  {x:95,y:600},{x:265,y:475},{x:450,y:400},{x:700,y:380},
  {x:1080,y:380},{x:1100,y:560},{x:1100,y:845},{x:95,y:845}
];
const OBSTACLES = [
  {type:'circle',x:890,y:618,r:84},    /* 水晶球圆桌本体（缩小：桌前/周围地面光影可通行） */
  {type:'rect',x:824,y:524,w:132,h:60}, /* 桌后窄缓冲带：避免角色站在桌正后方时与桌面像素重叠 */
  {type:'rect',x:300,y:650,w:170,h:100},
  {type:'rect',x:105,y:625,w:160,h:140}
];

/* ── CRYSTAL FLOOR LIGHT (walkable) ────────────────────── */
/* 水晶球投在地面的光晕区域：可行走；角色走入时，光会渐渐投在她身上 */
const CRYSTAL_FLOOR_LIGHT = {x:885,y:650,r:140};

/* ── INTERACTIVE OBJECTS ───────────────────────────────── */
const INTERACTIONS = [
  {id:'bed',      x:350, y:550, iconX:300, iconY:380, face:'up',   label:'休息'},
  {id:'tea',      x:350, y:770, iconX:370, iconY:680, face:'up',   label:'茶歇'},
  {id:'crystal',  x:810, y:660, iconX:925, iconY:685, face:'up',   label:'占卜'},
  {id:'desk',     x:1070,y:560, iconX:1240,iconY:430, face:'right',label:'游戏'},
  {id:'wardrobe', x:480, y:430, iconX:480, iconY:310, face:'up',   label:'衣柜'}
];

/* ── BED POSITION ──────────────────────────────────────── */
const BED_LIE_X = 155, BED_LIE_Y = 293;
const BED_STAND_X = 350, BED_STAND_Y = 550;
const BED_SLEEP_WALK_X = 450, BED_SLEEP_WALK_Y = 460;

/* ── OUTFITS ───────────────────────────────────────────── */
const OUTFITS = [
  {id:'eyepatch_dress', label:'Gothic Dress',
   walk:'game/sprites/walk_eyepatch_dress.png', idle:'game/sprites/idle_eyepatch_dress.png',
   lie:'game/sprites/lie_eyepatch_dress.png', portrait:'game/portraits/eyepatch_dress.png'},
  {id:'nopatch_dress', label:'Gothic Dress (no patch)',
   walk:'game/sprites/walk_nopatch_dress.png', idle:'game/sprites/idle_nopatch_dress.png',
   lie:'game/sprites/lie_nopatch_dress.png', portrait:'game/portraits/nopatch_dress.png'},
  {id:'casual', label:'Casual',
   walk:'game/sprites/walk_casual.png', idle:'game/sprites/idle_casual.png',
   lie:'game/sprites/lie_casual.png', portrait:'game/portraits/casual.png'},
  {id:'salome', label:'Salome',
   walk:'game/sprites/walk_salome.png', idle:'game/sprites/idle_salome.png',
   lie:'game/sprites/lie_salome.png', portrait:'game/portraits/salome.png'},
  {id:'jk', label:'JK',
   walk:'game/sprites/walk_jk.png', idle:'game/sprites/idle_jk.png',
   lie:'game/sprites/lie_jk.png', portrait:'game/portraits/jk.png'},
  {id:'wedding', label:'Wedding',
   walk:'game/sprites/walk_wedding.png', idle:'game/sprites/idle_wedding.png',
   lie:'game/sprites/lie_wedding.png', portrait:'game/portraits/wedding.png'}
];

/* ── JSON EXTRACTION HELPER (robust for DeepSeek/国内模型) ── */
function extractJSON(raw){
  if(!raw||typeof raw!=='string') throw new Error('empty');
  /* 1. Strip markdown fences (case-insensitive) */
  let s=raw.replace(/```(?:json|JSON)?\s*/g,'').trim();
  /* 2. Try direct parse first */
  try{return JSON.parse(s)}catch(e){}
  /* 3. Extract first {...} block from text like "好的，这是你的故事：{...}" */
  const m=s.match(/\{[\s\S]*\}/);
  if(m){try{return JSON.parse(m[0])}catch(e){}}
  /* 4. Last resort: throw so caller uses fallback */
  throw new Error('no valid JSON');
}

/* ── FIXED DIALOGUE TEXTS ──────────────────────────────── */
const FIXED_LINES = {
  bed1: "现在我该睡觉了吗？",
  bed_confirm: "我知道了，好。",
  bed_sleep: "晚安。",
  crystal_intro: "要使用塔罗牌占卜吗？",
  desk_intro: "今天会给我设计怎样的游戏呢？",
  wardrobe_intro: ["让我偶尔试试你喜欢的风格，怎么样？","想看我穿什么样的衣服呢？","（小声）想买新衣服了……"],
  stairs_blocked: "……这扇门是锁着的。",
  no_api: "还没有配置API呢。去设置页面添加一个吧。",
  sui_open: "请问有什么我可以帮助你的吗？\n如果你有其他想问我的事情，可以按下右下角的NEXT来和我开启对话。",
  thinking: "……"
};

/* ── INTERACTION MARKERS (display order: tea → tarot → story → wardrobe → sleep) ── */
const MARKERS = [
  {id:'tea',      en:'Tea',      cn:'茶歇'},
  {id:'crystal',  en:'Tarot',    cn:'占卜'},
  {id:'desk',     en:'Story',    cn:'故事'},
  {id:'wardrobe', en:'Wardrobe', cn:'衣柜'},
  {id:'bed',      en:'Sleep',    cn:'睡觉'}
];

/* ── GUIDED HOME TOUR ─────────────────────────────────── */
/* Intro spoken at the bed, facing the camera */
function getTourIntro(){
  var mode=document.body.classList.contains('theme-infernal')?'Infernal':'Internal';
  return [
    "欢迎来到"+mode+" Beyond的世界。\n我是这个房间里的主控角色，Sui。我会带领你了解这个游戏房间的玩法。\n点击[Back]按钮会直接退出引导，点击[Next]则进入下一页。",
    mode+" Beyond（IB）是一个免费的GitHub开源作品。\n如果你是通过付费购买的方式来到这里，那你收到的不会是正版游戏。\n请通过GitHub：Sui-IB，或QQ：1282901880来找到真正的游戏作者。",
    "所有玩法后续均可通过点击对应区域，或点击导航栏中的各个功能按钮来开启互动。\n来吧。现在，请跟着我。"
  ];
}
/* Walk-and-talk stations (tour order: tea → story → tarot → wardrobe → bed) */
const TOUR_STEPS = [
  {id:'tea',     face:'up',    pages:[
    "这里是Tea茶歇模块。\n可按照喜好准备一杯饮品和一份甜品，与你想要共度时光的TA一起享用。\n在白昼模式与夜晚模式开启茶歇，会有不同的效果哦。"]},
  {id:'desk',    face:'right', pages:[
    "这是Story模块。\n在这里可以游玩TA，或是你自己设计的互动文字冒险游戏。\n游戏中可随时选择存档游戏剧本到Blog模块中的密码日记本内。\n存档后可以在日记里让TA帮你生成记忆。"]},
  {id:'crystal', face:'up',    pages:[
    "这里是占卜桌。\n你可以在这里使用塔罗占卜，邀请TA帮你解读，或独自探索。\n按下Save，可以存下你此次在占卜桌执行的所有操作。"]},
  {id:'wardrobe',face:'up',    pages:[
    "这里是我的衣柜，在这里可以给我自由换装。\n请注意：更换服装后，我的立绘、模型与角色动画也会同步更换。"]},
  {id:'bed',     face:'up',    pages:[
    "这里是我的床。到这里，房间的所有互动功能就介绍完了。\n你想白天睡觉还是晚上睡觉都可以。",
    "Room浮窗标题栏里有一个Mini按钮。\n按下后，游戏浮窗会变成一个小型视窗。\n你可以在浏览网站其他页面时，让我在一旁安静地陪着你。",
    "茶歇进行时也可以进入小窗，其他互动需要退出小窗后才能使用。\n小窗的标题栏可以拖动位置，按✕退出，或者回到Room页面会自动恢复全屏。",
    "如果你想切换房间的昼夜模式，可以点击屏幕右上角的水滴按钮。\n如果想听歌，你可以使用左下角的音乐播放器添加本地音乐来在这个房间里播放，但歌单不会存档。\n祝你游戏愉快。"]}
];

/* ============================================================
   CSS INJECTION
   ============================================================ */
const CSS = `
/* ── ROOM TEXT: 不可选中/复制（输入框除外） ──────────── */
#game-panel,#page-game{-webkit-user-select:none;-moz-user-select:none;user-select:none;-webkit-touch-callout:none}
#game-panel input,#game-panel textarea,#page-game input,#page-game textarea{-webkit-user-select:text;-moz-user-select:text;user-select:text}

/* ── GAME MINI ICON ──────────────────────────────────── */
#game-mini{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:90;
  padding:48px 11px;border-radius:8px 0 0 8px;background:rgba(20,30,50,0.35);border:1px solid var(--glass-border);border-right:none;
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);cursor:pointer;
  transition:all 0.4s var(--transition);opacity:0;writing-mode:vertical-lr;
  letter-spacing:0.18em;font-family:'Cormorant Garamond',serif;font-style:italic;font-size:0.88rem;color:var(--text-muted)}
#game-mini.visible{opacity:1;transform:translateY(-50%)}
#game-mini:hover{background:rgba(175,195,228,0.15);color:var(--light)}
body.theme-infernal #game-mini{color:#ffffff}
body:not(.theme-infernal) #game-mini{background:rgba(255,255,255,0.28);border-color:rgba(180,215,245,0.4);color:#2b487a}
body:not(.theme-infernal) #game-mini:hover{background:rgba(255,255,255,0.45);color:#152c58}

/* ── PET WINDOW (350×350 viewport + panel header) ────── */
#game-pet-window{position:fixed;z-index:91;width:350px;border-radius:12px;overflow:hidden;display:none;
  background:rgba(10,15,30,0.97);border:1px solid var(--glass-border);
  box-shadow:0 6px 32px rgba(0,0,0,0.5);backdrop-filter:blur(6px);flex-direction:column}
#game-pet-window.show{display:flex}
#game-pet-viewport-wrap{position:relative;width:350px;height:350px;overflow:hidden;flex-shrink:0}

/* ── GAME PANEL (floating) ───────────────────────────── */
#game-panel{position:fixed;z-index:92;border-radius:16px;overflow:hidden;display:none;
  background:rgba(10,15,30,0.95);border:1px solid var(--glass-border);
  box-shadow:0 8px 40px rgba(0,0,0,0.5);backdrop-filter:blur(8px);
  flex-direction:column}
#game-panel.show{display:flex}
.game-panel-header{display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px;background:rgba(0,0,0,0.3);cursor:grab;user-select:none;min-height:36px}
.game-panel-header:active{cursor:grabbing}
.game-panel-title{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:0.9rem;color:var(--silver);letter-spacing:0.05em}
.game-panel-close{background:none;border:none;color:var(--mist);cursor:pointer;font-size:1.1rem;padding:2px 6px;transition:color 0.3s;line-height:1}
.game-panel-close:hover{color:var(--white)}
.game-panel-zoom{display:flex;gap:4px;align-items:center}
.game-panel-zoom button{background:none;border:1px solid rgba(175,195,228,0.2);color:var(--mist);
  cursor:pointer;font-size:0.85rem;width:24px;height:24px;border-radius:4px;
  display:flex;align-items:center;justify-content:center;transition:all 0.3s;line-height:1}
.game-panel-zoom button:hover{border-color:var(--accent);color:var(--white)}

/* ── GAME VIEWPORT ───────────────────────────────────── */
.game-viewport{position:relative;width:${GAME_W}px;height:${GAME_H}px;overflow:hidden;
  transform-origin:top left;image-rendering:pixelated;cursor:crosshair}

/* ── ROOM BACKGROUND ─────────────────────────────────── */
.game-bg{position:absolute;inset:0;background-size:cover;background-position:center;transition:opacity 1.5s ease}
.game-bg-day{background-image:url('game/room_day.png');opacity:1}
.game-bg-night{background-image:url('game/room_night.png');opacity:0}
body.theme-infernal .game-bg-day{opacity:0}
body.theme-infernal .game-bg-night{opacity:1}

/* ── LIGHT EFFECTS LAYER ─────────────────────────────── */
.game-lights{position:absolute;inset:0;pointer-events:none;z-index:2;mix-blend-mode:screen;opacity:0.7}
.game-lights-overlay{position:absolute;inset:0;pointer-events:none;z-index:3;transition:opacity 1.5s ease}

/* Day lights */
.game-day-lights{opacity:1}
body.theme-infernal .game-day-lights{opacity:0}
.game-night-lights{opacity:0}
body.theme-infernal .game-night-lights{opacity:1}

/* Window light beam (day) */
.light-beam-day{position:absolute;top:0;left:400px;width:820px;height:100%;
  background:linear-gradient(180deg,rgba(255,240,200,0.0) 0%,rgba(255,235,180,0.08) 20%,rgba(255,230,170,0.15) 40%,rgba(255,225,160,0.08) 65%,rgba(255,220,150,0.02) 85%,transparent 100%);
  clip-path:polygon(25% 0%,75% 0%,95% 100%,5% 100%);
  animation:lightBreath 8s ease-in-out infinite,lightWarmFade 25s ease-in-out infinite}

/* Cool dawn/overcast light beam (Internal only) */
.light-beam-cool{position:absolute;top:0;left:400px;width:820px;height:100%;
  background:linear-gradient(180deg,rgba(180,200,235,0.0) 0%,rgba(170,195,230,0.08) 20%,rgba(160,190,225,0.16) 40%,rgba(155,185,220,0.09) 65%,rgba(150,180,215,0.03) 85%,transparent 100%);
  clip-path:polygon(25% 0%,75% 0%,95% 100%,5% 100%);
  opacity:0;animation:lightBreath 8s ease-in-out infinite,lightCoolFade 25s ease-in-out infinite}
body.theme-infernal .light-beam-cool{opacity:0;animation:none}

/* Full-room cold/overcast filter (Internal only) */
.game-cold-filter{position:absolute;inset:0;pointer-events:none;z-index:1;
  background:linear-gradient(180deg,rgba(140,165,200,0.12) 0%,rgba(150,175,210,0.18) 30%,rgba(145,170,205,0.15) 60%,rgba(135,160,195,0.10) 100%);
  mix-blend-mode:multiply;opacity:0;
  animation:coldFilterCycle 25s ease-in-out infinite}
body.theme-infernal .game-cold-filter{opacity:0;animation:none}

@keyframes lightWarmFade{0%,100%{opacity:1}45%,55%{opacity:0.15}}
@keyframes lightCoolFade{0%,100%{opacity:0}45%,55%{opacity:0.9}}
@keyframes coldFilterCycle{0%,100%{opacity:0}42%,58%{opacity:1}}

/* ── PRISMATIC RAINBOW LIGHT (Internal/day mode only) ── */
.light-prism{position:absolute;top:0;left:420px;width:780px;height:100%;
  clip-path:polygon(28% 0%,72% 0%,92% 100%,8% 100%);
  opacity:0;pointer-events:none;mix-blend-mode:screen}
body:not(.theme-infernal) .light-prism{opacity:1;animation:prismColdFade 25s ease-in-out infinite}
@keyframes prismColdFade{0%,100%{opacity:1}42%,58%{opacity:0.15}}

.light-prism-rainbow{position:absolute;inset:0;
  background:linear-gradient(165deg,
    rgba(255,100,100,0.0) 0%,
    rgba(255,140,80,0.04) 15%,
    rgba(255,220,100,0.06) 25%,
    rgba(140,255,140,0.05) 35%,
    rgba(100,200,255,0.07) 45%,
    rgba(130,130,255,0.05) 55%,
    rgba(200,100,255,0.04) 65%,
    rgba(255,100,180,0.03) 75%,
    transparent 90%);
  animation:prismShift 15s ease-in-out infinite alternate}

.light-prism-streak1{position:absolute;top:8%;left:30%;width:35%;height:80%;
  background:linear-gradient(170deg,transparent 0%,rgba(255,200,120,0.06) 30%,rgba(180,230,255,0.08) 50%,rgba(200,150,255,0.05) 70%,transparent 100%);
  animation:streakDrift1 20s ease-in-out infinite;filter:blur(20px)}

.light-prism-streak2{position:absolute;top:15%;left:45%;width:25%;height:70%;
  background:linear-gradient(175deg,transparent 0%,rgba(255,180,200,0.05) 25%,rgba(150,255,200,0.07) 50%,rgba(180,200,255,0.05) 75%,transparent 100%);
  animation:streakDrift2 25s ease-in-out infinite;filter:blur(25px)}

.light-prism-shimmer{position:absolute;inset:0;
  background:repeating-linear-gradient(90deg,
    transparent 0px,transparent 60px,
    rgba(255,255,255,0.015) 62px,transparent 64px);
  animation:shimmerScroll 8s linear infinite}

@keyframes prismShift{
  0%{transform:translateX(-20px) skewX(-2deg);opacity:0.7}
  50%{transform:translateX(20px) skewX(2deg);opacity:1}
  100%{transform:translateX(-10px) skewX(-1deg);opacity:0.8}}
@keyframes streakDrift1{
  0%{transform:translateX(-30px) translateY(10px);opacity:0.5}
  50%{transform:translateX(30px) translateY(-10px);opacity:0.9}
  100%{transform:translateX(-30px) translateY(10px);opacity:0.5}}
@keyframes streakDrift2{
  0%{transform:translateX(20px) translateY(-15px);opacity:0.4}
  50%{transform:translateX(-25px) translateY(15px);opacity:0.8}
  100%{transform:translateX(20px) translateY(-15px);opacity:0.4}}
@keyframes shimmerScroll{0%{transform:translateX(-64px)}100%{transform:translateX(64px)}}

/* Light motes (floating sparkles in day mode) */
.light-mote{position:absolute;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle,rgba(255,240,200,0.6) 0%,rgba(255,220,160,0.2) 40%,transparent 70%);
  animation:moteFloat ease-in-out infinite;filter:blur(1px)}
body.theme-infernal .light-mote{opacity:0}

/* Moonlight beam (night) */
.light-beam-night{position:absolute;top:0;left:450px;width:750px;height:100%;
  background:linear-gradient(180deg,rgba(100,140,220,0.0) 0%,rgba(80,120,200,0.06) 15%,rgba(60,100,180,0.14) 35%,rgba(50,90,170,0.08) 60%,rgba(40,80,160,0.02) 80%,transparent 100%);
  clip-path:polygon(30% 0%,70% 0%,90% 100%,10% 100%);
  animation:lightBreath 12s ease-in-out infinite}

@keyframes lightBreath{0%,100%{opacity:0.7}50%{opacity:1}}

/* Candle glows */
.light-candle{position:absolute;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle,rgba(255,200,100,0.35) 0%,rgba(255,180,80,0.12) 40%,transparent 70%);
  animation:candleFlicker 2s ease-in-out infinite alternate}
@keyframes candleFlicker{0%{opacity:0.6;transform:scale(1)}25%{opacity:0.85;transform:scale(1.05)}50%{opacity:0.55;transform:scale(0.95)}75%{opacity:0.9;transform:scale(1.08)}100%{opacity:0.65;transform:scale(0.98)}}

.light-candle-night{background:radial-gradient(circle,rgba(255,190,80,0.45) 0%,rgba(255,170,60,0.18) 35%,transparent 65%)}

/* Crystal ball glow */
.light-crystal{position:absolute;left:843px;top:497px;width:90px;height:90px;border-radius:50%;
  background:radial-gradient(circle,rgba(100,160,255,0.5) 0%,rgba(80,140,240,0.2) 40%,rgba(60,120,220,0.05) 65%,transparent 80%);
  animation:crystalPulse 3s ease-in-out infinite;filter:blur(6px)}
@keyframes crystalPulse{0%,100%{opacity:0.6;transform:scale(1)}50%{opacity:1;transform:scale(1.15)}}

/* Dust particles */
.game-dust{position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden}
.dust-particle{position:absolute;width:3px;height:3px;border-radius:50%;
  background:rgba(200,215,240,0.4);animation:dustFloat linear infinite}
@keyframes dustFloat{0%{transform:translateY(100%) translateX(0);opacity:0}10%{opacity:0.6}90%{opacity:0.4}100%{transform:translateY(-20%) translateX(40px);opacity:0}}
@keyframes moteFloat{0%{opacity:0;transform:translate(0,0) scale(1)}15%{opacity:0.8}50%{opacity:0.5;transform:translate(var(--mx,30px),var(--my,-40px)) scale(1.3)}85%{opacity:0.6}100%{opacity:0;transform:translate(var(--mx2,60px),var(--my2,-80px)) scale(0.8)}}

body.theme-infernal .dust-particle{background:rgba(200,215,240,0.4)}

/* Dark vignette */
.game-vignette{position:absolute;inset:0;pointer-events:none;z-index:5;
  background:radial-gradient(ellipse at 50% 40%,transparent 50%,rgba(0,0,0,0.15) 100%)}
body.theme-infernal .game-vignette{background:radial-gradient(ellipse at 50% 40%,transparent 40%,rgba(0,0,0,0.3) 100%)}

/* ── CHARACTER SPRITE ────────────────────────────────── */
.game-char{position:absolute;z-index:10;pointer-events:none;image-rendering:pixelated}
.game-char-sprite{width:${SPRITE_SIZE}px;height:${SPRITE_SIZE}px;overflow:hidden;position:relative}
.game-char-sprite img{position:absolute;image-rendering:pixelated}
.game-char-shadow{position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);
  width:70px;height:22px;border-radius:50%;
  background:radial-gradient(ellipse,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.3) 50%,transparent 70%);
  pointer-events:none}
.game-char-lightcast{position:absolute;inset:-12px -10px 0;pointer-events:none;opacity:0;
  transition:opacity 0.45s ease;will-change:opacity}
.game-char-lightcast::before{content:"";position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(ellipse at 50% 36%,rgba(126,178,255,0.40) 0%,rgba(96,150,238,0.17) 48%,transparent 76%);
  mix-blend-mode:screen}
.game-char.in-crystal-light .game-char-lightcast::before{animation:crystalPulse 3s ease-in-out infinite}
body:not(.theme-infernal) .game-char-lightcast::before{opacity:0.45}
.game-char.in-crystal-light .game-char-sprite img{filter:brightness(1.08) saturate(1.04)}
.game-char-lie{position:absolute;z-index:10;pointer-events:none;image-rendering:pixelated}
.game-char-lie img{image-rendering:pixelated}

/* ── ACTION SIDEBAR (outside viewport, right side) ───── */
.game-sidebar{display:flex;flex-direction:column;gap:3px;padding:8px 6px;flex-shrink:0;
  background:rgba(15,20,40,0.92);border-left:1px solid rgba(100,130,180,0.15)}
.game-sidebar.hidden{display:none}
.game-sidebar-btn{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:13px;
  color:rgba(200,215,240,0.65);background:none;border:none;cursor:pointer;
  padding:8px 12px;border-radius:6px;transition:all 0.3s;letter-spacing:0.04em;
  white-space:nowrap;text-align:left}
.game-sidebar-btn:hover{color:#e8f0ff;background:rgba(114,168,216,0.12);
  text-shadow:0 0 8px rgba(114,168,216,0.5)}

/* ── Zzz SLEEP ANIMATION (disabled) ───────────────────── */
.game-zzz{display:none !important}

/* ── SPEECH BUBBLE ───────────────────────────────────── */
.game-bubble{position:absolute;z-index:15;pointer-events:none;
  padding:4px 10px;border-radius:8px;background:rgba(0,0,0,0.55);
  color:#e0e6f2;font-size:14px;white-space:nowrap;
  backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.1);
  animation:bubbleFade 2s ease-in-out forwards}
@keyframes bubbleFade{0%{opacity:0;transform:translateY(4px)}15%{opacity:1;transform:translateY(0)}85%{opacity:1}100%{opacity:0;transform:translateY(-4px)}}

/* ── DIALOGUE OVERLAY ────────────────────────────────── */
.game-dialogue{position:absolute;inset:0;z-index:20;display:none;
  flex-direction:column;justify-content:flex-end;pointer-events:none}
.game-dialogue.show{display:flex}
/* Story portrait — now anchored to the LEFT of the dialogue box (req #3) and
   enlarged (req #1). The box is right+bottom anchored: the artwork hugs the
   box's right edge, which is parked at x≈400 — just left of where the dialogue
   text begins (box 14% ≈ x414) — so the figure can lap over the box's left
   rose/border but can never cover the dialogue text or the name, no matter how
   wide the uploaded portrait is. (A full-width portrait such as Sui has its
   outer hair run a little past the screen's left edge; the face/body stay in
   frame, which reads as a character standing at the left of the room.) */
.game-dialogue-portrait{position:absolute;bottom:0;left:-50px;z-index:21;
  width:450px;height:560px;pointer-events:none;opacity:0;
  display:flex;align-items:flex-end;justify-content:flex-end;
  transition:opacity 0.4s ease;transform-origin:bottom center}
.game-dialogue-portrait.show{opacity:1}
.game-dialogue-portrait img{max-width:100%;max-height:100%;width:auto;height:auto;
  object-fit:contain;object-position:bottom right;
  filter:drop-shadow(2px 4px 12px rgba(0,0,0,0.5))}
/* SUI 立绘单独沿用旧版(V5)右侧定位；自定义立绘保持上面的左侧加大样式不变 */
.game-dialogue-portrait.sui{left:auto;right:20px;width:400px;height:460px}
.game-dialogue-portrait.sui img{width:100%;height:100%;object-position:bottom}

.game-dialogue-box-wrap{position:relative;width:100%;display:flex;justify-content:center;
  padding:0 40px 30px;pointer-events:auto}
.game-dialogue-box{position:relative;width:1173px;max-width:100%;aspect-ratio:1173/334;
  background-image:url('game/dialogue_box.png');background-size:100% 100%;
  background-repeat:no-repeat}
.game-dialogue-name{position:absolute;top:9.2%;left:13.5%;right:65.5%;
  font-family:'Noto Serif SC','Source Han Serif SC',serif;
  font-weight:600;font-size:17px;color:#e0e8f6;letter-spacing:0.08em;
  text-shadow:0 1px 8px rgba(0,0,0,0.6);text-align:center;transform:translate(-2px,4px)}
.game-dialogue-text{position:absolute;top:35%;left:14%;right:14%;height:32%;
  font-family:'Noto Serif SC','Source Han Serif SC',serif;font-size:18px;line-height:1.85;white-space:pre-line;
  color:#e8eef8;overflow:hidden;text-shadow:0 1px 6px rgba(0,0,0,0.7),0 0 10px rgba(0,0,0,0.3);font-weight:400}

.game-dialogue-next{display:none !important}
body:not(.theme-infernal) .game-dialogue-text{color:#0a1535;font-weight:600;
  text-shadow:0 0 8px rgba(255,255,255,0.7),0 0 16px rgba(255,255,255,0.4),0 0 28px rgba(255,255,255,0.2)}

/* ── PERSISTENT DIALOGUE BUTTONS ──────────────── */
.game-dlg-persistent{position:absolute;top:70%;left:14%;right:14%;height:10%;
  display:flex;justify-content:space-between;align-items:center;pointer-events:auto;transform:translateY(-2px)}
.game-dlg-btn{font-family:'Noto Serif SC',serif;
  font-size:17px;color:rgba(220,230,250,0.95);cursor:pointer;background:none;border:none;
  padding:4px 10px;transition:all 0.3s;display:flex;align-items:center;gap:6px;font-weight:600;
  letter-spacing:0.04em;text-shadow:0 1px 6px rgba(0,0,0,0.5)}
.game-dlg-btn:hover{color:#fff;text-shadow:0 0 10px rgba(114,168,216,0.7),0 0 20px rgba(114,168,216,0.4)}
.game-dlg-btn-back .tri-back{display:inline-block;transition:transform 0.3s;font-size:15px;
  color:rgba(180,210,255,0.9)}
.game-dlg-btn-back:hover .tri-back{transform:translateX(-4px);color:#fff;
  text-shadow:0 0 10px rgba(114,168,216,0.8)}
.game-dlg-btn-next .tri-next{display:inline-block;animation:triPulseNext 1.2s ease-in-out infinite;
  font-size:15px;color:rgba(180,210,255,0.9)}
.game-dlg-btn-next:hover .tri-next{color:#fff;text-shadow:0 0 10px rgba(114,168,216,0.8)}
@keyframes triPulseNext{0%,100%{transform:translateX(0)}50%{transform:translateX(5px)}}

/* Dialogue action buttons — two groups: left and right */
.game-dialogue-actions{position:absolute;top:70%;left:35%;right:35%;height:10%;
  display:none;justify-content:center;align-items:center;gap:24px;z-index:2}
.game-dialogue-actions.show{display:flex}
.game-dialogue-action{font-family:'Noto Serif SC',serif;
  font-size:16px;color:rgba(220,230,250,0.85);cursor:pointer;background:none;border:none;
  padding:3px 6px;transition:all 0.3s;display:flex;align-items:center;gap:5px;font-weight:500}
.game-dialogue-action:hover{color:#fff;text-shadow:0 0 10px rgba(114,168,216,0.7)}
.game-dialogue-action::before{content:'▸';color:rgba(160,200,255,0.7);
  transition:all 0.3s;display:inline-block;font-size:15px}
.game-dialogue-action:hover::before{color:#fff;transform:translateX(3px);
  text-shadow:0 0 10px rgba(114,168,216,0.8)}

/* ── CHOICE BUTTONS — in text area ───────────────────── */
.game-choices{position:absolute;top:35%;left:14%;right:14%;height:32%;
  display:none;flex-direction:column;justify-content:center;gap:8px}
.game-choices.show{display:flex}
.game-choice-btn{padding:5px 4px;background:none;
  border:none;color:rgba(210,225,250,0.8);
  font-family:'Noto Serif SC',serif;font-size:16px;cursor:pointer;font-weight:500;
  transition:all 0.3s;text-align:left;display:flex;align-items:center;gap:8px}
.game-choice-btn::before{content:'◆';font-size:9px;color:rgba(140,180,230,0.5);transition:all 0.3s}
.game-choice-btn:hover{color:#fff}
.game-choice-btn:hover::before{color:rgba(160,200,255,1);
  text-shadow:0 0 12px rgba(114,168,216,0.9),0 0 24px rgba(114,168,216,0.5)}

/* ── WARDROBE PANEL ──────────────────────────────────── */
.game-wardrobe{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:25;display:none;padding:30px 30px 22px;border-radius:20px;
  background:linear-gradient(160deg,rgba(18,26,46,0.95),rgba(11,17,30,0.96));
  border:1px solid rgba(180,200,232,0.16);
  backdrop-filter:blur(22px) saturate(1.15);-webkit-backdrop-filter:blur(22px) saturate(1.15);
  min-width:300px;max-width:360px;
  box-shadow:0 18px 60px rgba(0,0,0,0.55),0 0 0 1px rgba(120,150,200,0.08),inset 0 1px 0 rgba(255,255,255,0.06)}
.game-wardrobe.show{display:block}
.game-wardrobe h4{font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;
  font-size:1.45rem;color:rgba(214,226,248,0.95);margin:0 0 10px;text-align:center;
  letter-spacing:0.14em}
.game-wardrobe-divider{display:flex;align-items:center;justify-content:center;gap:9px;margin-bottom:18px}
.game-wardrobe-divider::before,.game-wardrobe-divider::after{content:'';height:1px;width:54px;
  background:linear-gradient(90deg,transparent,rgba(180,200,232,0.45))}
.game-wardrobe-divider::after{background:linear-gradient(90deg,rgba(180,200,232,0.45),transparent)}
.game-wardrobe-divider span{color:rgba(170,195,235,0.65);font-size:9px;transform:rotate(45deg);
  width:6px;height:6px;border:1px solid rgba(170,195,235,0.5);display:inline-block}
.game-wardrobe-grid{display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:16px}
.game-wardrobe-item{display:flex;align-items:center;gap:13px;width:100%;
  padding:12px 17px;background:rgba(178,198,230,0.05);border:1px solid rgba(178,198,230,0.12);
  border-radius:12px;color:rgba(212,224,246,0.82);font-family:'Noto Sans SC',sans-serif;
  font-size:0.86rem;cursor:pointer;transition:all 0.28s ease;text-align:left;position:relative;overflow:hidden}
.game-wardrobe-item:hover{background:rgba(178,198,230,0.12);border-color:rgba(178,198,230,0.3);
  color:rgba(228,238,255,0.98);transform:translateX(2px)}
.game-wardrobe-item.active{border-color:rgba(120,170,222,0.6);color:rgba(190,222,255,1);
  background:linear-gradient(90deg,rgba(120,170,222,0.18),rgba(120,170,222,0.06))}
.game-wardrobe-item.active::before{content:'';position:absolute;left:0;top:18%;bottom:18%;
  width:3px;border-radius:0 3px 3px 0;background:linear-gradient(rgba(130,180,235,0.9),rgba(110,160,215,0.7));
  box-shadow:0 0 10px rgba(120,170,222,0.6)}
.game-wardrobe-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;
  border:1.5px solid rgba(178,198,230,0.32);transition:all 0.28s}
.game-wardrobe-item.active .game-wardrobe-dot{background:rgba(130,180,235,0.95);
  border-color:rgba(150,195,240,0.8);box-shadow:0 0 9px rgba(120,170,222,0.7)}
.game-wardrobe-close{display:block;width:100%;padding:11px;margin-top:2px;
  background:rgba(178,198,230,0.08);border:1.5px solid rgba(178,198,230,0.3);border-radius:11px;
  color:rgba(216,228,250,0.88);font-family:'Cormorant Garamond',serif;font-style:normal;font-weight:600;
  font-size:0.95rem;cursor:pointer;transition:all 0.28s;letter-spacing:0.12em}
.game-wardrobe-close:hover{background:rgba(178,198,230,0.18);border-color:rgba(178,198,230,0.5);
  color:#fff}
/* ── INTERNAL (light) THEME ── */
body:not(.theme-infernal) .game-wardrobe{
  background:linear-gradient(160deg,rgba(246,250,255,0.97),rgba(228,240,255,0.96));
  border-color:rgba(150,190,235,0.45);
  box-shadow:0 18px 60px rgba(70,110,170,0.22),0 0 0 1px rgba(150,190,235,0.15),inset 0 1px 0 rgba(255,255,255,0.7)}
body:not(.theme-infernal) .game-wardrobe h4{color:#1b3666}
body:not(.theme-infernal) .game-wardrobe-divider::before{background:linear-gradient(90deg,transparent,rgba(80,130,195,0.5))}
body:not(.theme-infernal) .game-wardrobe-divider::after{background:linear-gradient(90deg,rgba(80,130,195,0.5),transparent)}
body:not(.theme-infernal) .game-wardrobe-divider span{border-color:rgba(70,125,195,0.6);color:rgba(70,125,195,0.7)}
body:not(.theme-infernal) .game-wardrobe-item{background:rgba(255,255,255,0.5);
  border-color:rgba(150,190,235,0.32);color:#284b7e}
body:not(.theme-infernal) .game-wardrobe-item:hover{background:rgba(255,255,255,0.85);
  border-color:rgba(110,160,220,0.5);color:#102347}
body:not(.theme-infernal) .game-wardrobe-item.active{border-color:rgba(70,130,205,0.6);
  color:#0c2247;background:linear-gradient(90deg,rgba(150,190,240,0.55),rgba(190,218,250,0.3))}
body:not(.theme-infernal) .game-wardrobe-item.active::before{background:linear-gradient(rgba(60,120,200,0.85),rgba(50,105,185,0.7));box-shadow:0 0 10px rgba(70,130,205,0.5)}
body:not(.theme-infernal) .game-wardrobe-dot{border-color:rgba(95,150,215,0.45)}
body:not(.theme-infernal) .game-wardrobe-item.active .game-wardrobe-dot{
  background:rgba(55,115,195,0.9);border-color:rgba(70,130,205,0.7);box-shadow:0 0 8px rgba(70,130,205,0.45)}
body:not(.theme-infernal) .game-wardrobe-close{
  background:rgba(110,160,222,0.16);border-color:rgba(70,125,195,0.5);color:#173a6e}
body:not(.theme-infernal) .game-wardrobe-close:hover{
  background:rgba(95,150,215,0.28);border-color:rgba(55,110,185,0.7);color:#0a2150}

/* ── TAROT PANEL ─────────────────────────────────────── */
.game-tarot{position:absolute;inset:0;z-index:25;display:none;flex-direction:column;
  background:url('game/tarot_bg.png') center/cover no-repeat,rgba(0,0,0,0.55);backdrop-filter:blur(6px);overflow:hidden;padding:10px 16px 10px}
.game-tarot.show{display:flex}

/* Spread selection bar */
.tarot-spread-bar{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-bottom:4px}
.tarot-spread-opt{font-family:'Noto Serif SC','Noto Sans SC',serif;font-size:0.82rem;font-weight:500;
  color:rgba(200,190,230,0.55);background:none;border:1px solid rgba(160,140,200,0.2);
  border-radius:20px;padding:5px 16px;cursor:pointer;transition:all 0.35s;white-space:nowrap}
.tarot-spread-opt:hover{color:rgba(220,210,240,0.9);border-color:rgba(180,160,220,0.5)}
.tarot-spread-opt.active{color:rgba(230,220,250,1);border-color:rgba(180,160,220,0.7);
  background:rgba(140,110,200,0.18);text-shadow:0 0 12px rgba(180,160,240,0.3)}
.tarot-top-row{display:flex;align-items:center;justify-content:center;gap:20px;margin-bottom:4px}
.tarot-spread-desc{font-family:'Noto Serif SC',serif;font-size:0.85rem;color:rgba(200,190,230,0.5);letter-spacing:0.06em}
.tarot-guide-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;
  font-family:'Noto Serif SC',serif;font-size:0.85rem;color:rgba(200,190,230,0.5);transition:color 0.3s}
.tarot-guide-toggle:hover{color:rgba(220,210,240,0.85)}
.tarot-guide-toggle input{accent-color:rgba(160,140,200,0.7);width:16px;height:16px}

/* Main body: left-right split */
.tarot-body{display:flex;flex:1;gap:20px;min-height:0;overflow:hidden}
.tarot-left{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;overflow:hidden;gap:20px}
.tarot-right{width:380px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid rgba(160,140,200,0.1);padding-left:18px;gap:8px}

/* Card fan area — opened folding fan */
.tarot-fan{position:relative;width:100%;flex:0 0 auto;height:240px;min-height:240px;touch-action:manipulation}
.tarot-fan-card{position:absolute;width:115px;height:178px;border-radius:5px;cursor:pointer;
  transform-origin:center bottom;transform:rotate(var(--rot,0deg));will-change:transform;
  transition:transform 0.34s cubic-bezier(0.22,0.61,0.36,1),opacity 0.4s,box-shadow 0.34s cubic-bezier(0.22,0.61,0.36,1),border-color 0.34s;
  background:linear-gradient(135deg,#1a1228 0%,#2a1a3a 50%,#1a1228 100%);
  border:1.5px solid rgba(180,160,120,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.35);
  display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:rgba(160,130,200,0.35)}
.tarot-fan-card.lift{z-index:60;transform:rotate(calc(var(--rot,0deg)*0.55)) translateY(-22px) scale(1.045);
  box-shadow:0 14px 34px rgba(120,90,190,0.5),0 4px 12px rgba(0,0,0,0.4);border-color:rgba(200,180,240,0.7)}
.tarot-fan-card.picked{opacity:0;pointer-events:none;transition:opacity 0.3s}

/* Card slots area */
.tarot-slots-wrap{display:flex;gap:16px;justify-content:center;align-items:flex-start;flex-wrap:wrap;flex-shrink:0;padding-top:16px}
.tarot-slot-item{width:115px;height:178px;border-radius:9px;position:relative;
  border:2px dashed rgba(160,140,200,0.25);display:flex;flex-direction:column;
  align-items:center;justify-content:center;transition:all 0.4s;perspective:600px}
.tarot-slot-item.filled{border-style:solid;border-color:rgba(180,160,120,0.4);
  background:rgba(26,18,40,0.6);box-shadow:0 4px 18px rgba(0,0,0,0.3)}
.tarot-slot-label{font-family:'Noto Serif SC',serif;font-size:0.78rem;color:rgba(200,190,230,0.55);
  margin-top:6px;text-align:center;letter-spacing:0.04em}
.tarot-slot-card{position:absolute;inset:0;border-radius:9px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;padding:8px;text-align:center;opacity:0;transition:opacity 0.5s}
.tarot-slot-card.show{opacity:1}
.tarot-slot-card .ts-num{font-family:'Cormorant Garamond',serif;font-size:1.6rem;font-weight:300;color:rgba(220,210,240,0.9)}
.tarot-slot-card .ts-cn{font-family:'Noto Serif SC',serif;font-weight:600;font-size:0.88rem;
  color:rgba(214,204,234,0.95);letter-spacing:0.06em;margin-top:4px}
.tarot-slot-card .ts-en{font-family:'Cormorant Garamond',serif;font-size:0.68rem;color:rgba(180,170,210,0.6);margin-top:2px}
.tarot-slot-card .ts-pos{font-size:0.65rem;padding:3px 10px;border-radius:4px;margin-top:5px;
  background:rgba(255,255,255,0.08);color:rgba(200,190,230,0.7)}

/* ── TAROT FACES · Vergelight Arcana（三风格牌面；逆位=整面 180° 倒置） ── */
.tarot-slot-card.tsx{padding:0;opacity:0;background:none}
.tarot-slot-card.tsx.show{opacity:1}
.tsx-face{position:absolute;inset:0;border-radius:8px;display:flex;flex-direction:column;align-items:center;
  justify-content:space-between;padding:11px 8px 9px;text-align:center;overflow:hidden;
  transition:transform 0.55s cubic-bezier(0.34,1.2,0.4,1)}
.tarot-slot-card.tsx.reversed .tsx-face{transform:rotate(180deg)}
.tsx-glyph{width:52px;height:52px;flex:0 0 auto;opacity:0.92}
.tsx-num{font-family:'Cormorant Garamond',serif;font-weight:500;letter-spacing:0.08em;line-height:1}
.tsx-name{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:0.72rem;letter-spacing:0.09em;
  text-transform:uppercase;line-height:1.35;display:flex;flex-direction:column;gap:1px}
.tsx-name .tsx-sub{font-size:0.58rem;letter-spacing:0.14em;opacity:0.62;font-style:italic;text-transform:none}
.tsx-frame{position:absolute;inset:0;pointer-events:none;border-radius:8px}

/* — Gossamer Veil 薄纱银线 — */
.tsx-veil .tsx-face{background:linear-gradient(160deg,#171129 0%,#1d1633 55%,#150f26 100%);color:rgba(216,210,236,0.92)}
.tsx-veil.tsx-minor .tsx-face{background:
  radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--tsx-tint) 26%,transparent),transparent 62%),
  linear-gradient(160deg,#171129 0%,#1d1633 55%,#150f26 100%)}
.tsx-veil .tsx-frame{border:1px solid rgba(196,186,226,0.34);box-shadow:inset 0 0 0 3px rgba(23,17,41,0.001),inset 0 0 0 4px rgba(196,186,226,0.16)}
.tsx-veil .tsx-frame::before,.tsx-veil .tsx-frame::after{content:"";position:absolute;width:3px;height:3px;border-radius:50%;
  background:rgba(210,200,240,0.55);left:50%;transform:translateX(-50%)}
.tsx-veil .tsx-frame::before{top:5.5px}.tsx-veil .tsx-frame::after{bottom:5.5px}
.tsx-veil .tsx-num{font-size:1.02rem;color:rgba(222,214,246,0.88)}
.tsx-veil.tsx-minor .tsx-glyph,.tsx-veil.tsx-minor .tsx-num{color:var(--tsx-ink,rgba(216,210,236,0.92))}
.tsx-veil .tsx-name{color:rgba(206,198,232,0.82)}

/* — Astral Orrery 星象仪 — */
.tsx-orrery .tsx-face{color:rgba(214,220,240,0.92);background:linear-gradient(165deg,#141a30 0%,#101528 100%)}
.tsx-orrery.tsx-minor .tsx-face{background:linear-gradient(165deg,color-mix(in srgb,var(--tsx-tint) 42%,#10142a) 0%,#0e1224 100%)}
.tsx-orrery .tsx-frame{border:1px solid rgba(176,190,224,0.3)}
.tsx-orrery .tsx-frame::before,.tsx-orrery .tsx-frame::after,
.tsx-orrery .tsx-corner::before,.tsx-orrery .tsx-corner::after{content:"✦";position:absolute;font-size:6px;color:rgba(198,208,236,0.6);line-height:1}
.tsx-orrery .tsx-frame::before{top:4px;left:5px}.tsx-orrery .tsx-frame::after{top:4px;right:5px}
.tsx-orrery .tsx-orbit{position:relative;width:78px;height:78px;flex:0 0 auto;display:flex;align-items:center;justify-content:center}
.tsx-orrery .tsx-orbit>svg:first-child{position:absolute;inset:0;width:100%;height:100%;color:rgba(190,202,232,0.55)}
.tsx-orrery .tsx-num{font-size:0.98rem;color:rgba(226,232,248,0.9)}
.tsx-orrery .tsx-name{color:rgba(206,214,238,0.85)}
.tsx-orrery .tsx-face::after{content:"✦   ✦";position:absolute;bottom:4px;left:0;right:0;font-size:6px;color:rgba(198,208,236,0.55);letter-spacing:0}


/* Flying card animation */
.tarot-flying{position:absolute;width:115px;height:178px;border-radius:5px;z-index:30;pointer-events:none;
  background:linear-gradient(135deg,#1a1228 0%,#2a1a3a 50%,#1a1228 100%);
  border:1.5px solid rgba(180,160,120,0.4);display:flex;align-items:center;justify-content:center;
  font-size:0.65rem;color:rgba(160,130,200,0.35);transition:all 0.55s cubic-bezier(0.25,0.46,0.45,0.94)}

/* Right panel: reading area */
.tarot-reading-panel{flex:1;overflow-y:auto;padding:16px;font-family:'Noto Serif SC',serif;
  font-size:0.95rem;line-height:2;color:rgba(220,215,240,0.88);white-space:pre-wrap;
  border-radius:10px;background:rgba(20,14,35,0.55);border:1px solid rgba(160,140,200,0.12);min-height:0}
.tarot-reading-panel::-webkit-scrollbar{width:3px}
.tarot-reading-panel::-webkit-scrollbar-thumb{background:rgba(160,140,200,0.3);border-radius:2px}
.tarot-reading-empty{display:flex;align-items:center;justify-content:center;height:100%;
  font-family:'Cormorant Garamond',serif;font-size:1.1rem;color:rgba(160,140,200,0.2);letter-spacing:0.12em}
.tarot-reading-name{font-family:'Cormorant Garamond',serif;font-size:0.92rem;font-weight:600;
  color:rgba(180,170,220,0.65);margin-bottom:8px;letter-spacing:0.04em}

/* Follow-up section in right panel */
.tarot-followup-section{flex-shrink:0;display:flex;flex-direction:column;gap:7px}
.tarot-followup-input{width:100%;padding:10px 14px;border-radius:12px;border:1px solid rgba(160,140,200,0.15);
  background:rgba(175,195,228,0.06);color:rgba(220,215,240,0.9);font-family:'Noto Serif SC',serif;
  font-size:0.85rem;box-sizing:border-box;outline:none}
.tarot-followup-input::placeholder{color:rgba(160,140,200,0.3)}
.tarot-followup-input:focus{border-color:rgba(160,140,200,0.4)}
.tarot-followup-opts{display:flex;flex-direction:column;gap:6px}
.tarot-followup-opt{font-family:'Noto Serif SC',serif;font-size:0.85rem;color:rgba(200,190,230,0.7);
  background:rgba(140,110,200,0.08);border:1px solid rgba(160,140,200,0.2);border-radius:16px;
  padding:9px 16px;cursor:pointer;transition:all 0.3s;text-align:center}
.tarot-followup-opt:hover{color:rgba(230,220,250,1);background:rgba(140,110,200,0.18);border-color:rgba(180,160,220,0.5)}
.tarot-followup-count{font-family:'Noto Serif SC',serif;font-size:0.75rem;color:rgba(200,190,230,0.3);text-align:center;margin-top:2px}

/* Action buttons */
.tarot-actions{display:flex;gap:16px;padding-top:10px;flex-wrap:wrap;justify-content:center;flex-shrink:0}
.tarot-btn{font-family:'Noto Serif SC','Noto Sans SC',serif;font-size:0.85rem;font-weight:500;
  color:var(--silver);background:rgba(175,195,228,0.08);border:1px solid var(--glass-border);
  border-radius:10px;padding:7px 20px;cursor:pointer;transition:all 0.3s}
.tarot-btn:hover{background:rgba(175,195,228,0.2);border-color:var(--accent);color:var(--white)}
.tarot-action-log{text-align:center;padding:4px 12px;margin:4px 0}

/* ── AI GAME MODE ────────────────────────────────────── */
.game-ai-setup{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:25;display:none;padding:28px 36px;border-radius:14px;
  background:rgba(15,20,45,0.88);border:1px solid rgba(100,130,180,0.25);
  backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);
  box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(80,110,160,0.1),inset 0 1px 0 rgba(255,255,255,0.08);
  min-width:280px;max-width:380px;
  max-height:90%;overflow-y:auto}
.game-ai-setup.show{display:block}
.game-ai-setup h4{font-family:'Cormorant Garamond',serif;font-style:italic;
  font-size:1.1rem;color:var(--silver);margin-bottom:16px;text-align:center}
.game-ai-setup label{display:block;font-size:0.75rem;color:var(--text-secondary);margin:10px 0 4px;letter-spacing:0.04em}
.game-ai-setup select,.game-ai-setup input{width:100%;padding:8px 12px;background:rgba(175,195,228,0.06);
  border:1px solid var(--glass-border);border-radius:8px;color:var(--text-primary);
  font-family:'Noto Sans SC',sans-serif;font-size:0.82rem;outline:none}
.game-ai-setup select{cursor:pointer}
.game-ai-setup-actions{display:flex;gap:10px;margin-top:18px;justify-content:center}

/* ── GAME FULL PAGE ──────────────────────────────────── */
#page-game{max-width:none !important;padding:60px 16px 20px !important;display:none;
  flex-direction:column;align-items:center;justify-content:center}
#page-game.active{display:flex !important}
.game-cine{width:var(--room-w,100%);max-width:100%;flex-shrink:0;container-type:inline-size;padding:0 clamp(2px,1.4cqi,12px) clamp(6px,1.4cqi,12px);--cine-glow:0 0 11px rgba(255,255,255,0.5);--cine-rule:rgba(38,84,140,0.3)}
.game-cine-top{display:flex;align-items:baseline;gap:clamp(9px,2.2cqi,15px);flex-wrap:wrap}
.game-cine-top h2{font-family:'Cormorant Garamond',serif;font-weight:600;font-size:clamp(1.05rem,4.3cqi,1.7rem);letter-spacing:0.06em;line-height:1.05;margin:0;color:#152c58;text-shadow:var(--cine-glow)}
.game-cine-sub{font-family:'Raleway',sans-serif;font-weight:300;font-size:clamp(0.6rem,1.85cqi,0.78rem);letter-spacing:0.2em;text-transform:uppercase;color:rgba(50,100,160,0.72);position:relative;padding-left:clamp(10px,2.4cqi,16px)}
.game-cine-sub::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:1px;height:0.95em;background:var(--cine-rule)}
.game-cine-rule{height:1px;background:linear-gradient(90deg,var(--cine-rule),transparent);width:min(100%,32ch);margin-top:clamp(7px,1.7cqi,11px);opacity:0.9}
.game-cine-desc{font-family:'Noto Sans SC',sans-serif;font-weight:300;font-size:clamp(0.66rem,2.05cqi,0.8rem);color:rgba(20,50,100,0.82);line-height:1.7;margin-top:clamp(6px,1.5cqi,10px);max-width:46ch;text-shadow:0 0 8px rgba(255,255,255,0.5),0 1px 3px rgba(0,0,0,0.15)}
body.theme-infernal .game-cine{--cine-glow:0 1px 10px rgba(0,0,0,0.55);--cine-rule:rgba(165,188,230,0.3)}
body.theme-infernal .game-cine-top h2{color:#e8eef6}
body.theme-infernal .game-cine-sub{color:rgba(114,168,216,0.55)}
body.theme-infernal .game-cine-desc{color:rgba(190,202,222,0.6);text-shadow:0 1px 7px rgba(0,0,0,0.5)}
.game-fullpage-wrap{position:relative;border-radius:12px;overflow:hidden;
  box-shadow:0 8px 40px rgba(0,0,0,0.4);border:1px solid var(--glass-border)}

/* ── LOADING / FADE ──────────────────────────────────── */
.game-fade{position:absolute;inset:0;z-index:30;background:#0a0e1e;
  transition:opacity 0.8s ease;pointer-events:none}
.game-fade.hidden{opacity:0}


/* ── SIDEBAR DISABLED STATE ──────────────────── */
.game-sidebar-btn.disabled{opacity:0.3;cursor:not-allowed;pointer-events:none}
.game-sidebar-btn.disabled:hover{color:rgba(200,215,240,0.65);background:none;text-shadow:none}
.game-sidebar-btn-reset{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:13px;
  color:rgba(255,180,180,0.65);background:none;border:none;cursor:pointer;
  padding:8px 12px;border-radius:6px;transition:all 0.3s;letter-spacing:0.04em;
  white-space:nowrap;text-align:left;border-top:1px solid rgba(100,130,180,0.12);margin-top:4px}
.game-sidebar-btn-reset:hover{color:#ffaaaa;background:rgba(255,140,140,0.12);
  text-shadow:0 0 8px rgba(255,140,140,0.5)}

/* ── SIDEBAR GROUP LABELS & SEPARATORS ──────── */
.game-sidebar-title{font-family:'Cormorant Garamond',serif;font-size:15px;
  font-weight:500;color:#e8c247;letter-spacing:0.1em;
  text-shadow:0 0 10px rgba(232,194,71,0.30);
  padding:4px 12px 2px;user-select:none;margin-bottom:2px}
body:not(.theme-infernal) .game-sidebar-title{color:#bb8a16;text-shadow:0 0 8px rgba(255,240,200,0.5)}
.game-sidebar-group-label{font-family:'Noto Sans SC',sans-serif;font-size:9px;font-weight:500;
  color:rgba(140,160,200,0.45);letter-spacing:0.12em;text-transform:uppercase;
  padding:2px 12px 0;user-select:none}
.game-sidebar-sep{height:1px;margin:4px 10px;
  background:linear-gradient(90deg,transparent,rgba(100,130,180,0.18),transparent)}

/* ── INTERACTION MARKERS (reconstructed, RPG-Maker style) ──
   A soft hotspot glow on the object + a gently bobbing sparkle.
   Hover brightens everything and reveals a labelled plaque.
   Click auto-paths the character over and opens the module.        */
#game-indicators{transition:opacity 0.45s ease}
#game-indicators.ix-off{opacity:0}
#game-indicators.ix-off .ix-marker{pointer-events:none}
.game-viewport{--ix-core:#fff7e6;--ix-glow:#ffd98c;--ix-deep:#c79a4e}
body.theme-infernal .game-viewport{--ix-core:#ffeccb;--ix-glow:#ffc879;--ix-deep:#df9f48}

.ix-marker{position:absolute;width:88px;height:88px;z-index:7;cursor:pointer;
  pointer-events:auto;transform:translate(-50%,-50%);
  -webkit-tap-highlight-color:transparent}

/* hotspot glow that sits on the object */
.ix-aura{position:absolute;left:50%;top:55%;width:60px;height:34px;
  transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;
  background:radial-gradient(ellipse at center,
    color-mix(in srgb,var(--ix-glow) 55%,transparent) 0%,
    color-mix(in srgb,var(--ix-glow) 22%,transparent) 45%,transparent 72%);
  opacity:0.45;filter:blur(0.5px);animation:ixAura 3.4s ease-in-out infinite}
.ix-aura::after{content:'';position:absolute;inset:0;border-radius:50%;
  border:1px solid color-mix(in srgb,var(--ix-core) 60%,transparent);
  opacity:0;transform:scale(0.6)}
@keyframes ixAura{0%,100%{opacity:0.32;transform:translate(-50%,-50%) scale(0.9)}
  50%{opacity:0.5;transform:translate(-50%,-50%) scale(1.04)}}

/* bobbing sparkle hovering above the object */
.ix-spark{position:absolute;left:50%;top:18%;width:24px;height:24px;
  transform:translateX(-50%);pointer-events:none;animation:ixBob 2.6s ease-in-out infinite}
.ix-spark-star{width:100%;height:100%;
  background:radial-gradient(circle at 50% 50%,var(--ix-core) 0%,
    var(--ix-glow) 38%,color-mix(in srgb,var(--ix-deep) 70%,transparent) 60%,transparent 74%);
  clip-path:polygon(50% 0%,58% 42%,100% 50%,58% 58%,50% 100%,42% 58%,0% 50%,42% 42%);
  filter:drop-shadow(0 0 5px color-mix(in srgb,var(--ix-glow) 70%,transparent));
  animation:ixTwinkle 2.6s ease-in-out infinite}
@keyframes ixBob{0%,100%{transform:translateX(-50%) translateY(0)}
  50%{transform:translateX(-50%) translateY(-7px)}}
@keyframes ixTwinkle{0%,100%{transform:scale(0.78);opacity:0.72}
  50%{transform:scale(1);opacity:1}}

/* label plaque */
.ix-tag{position:absolute;left:50%;bottom:calc(100% - 14px);transform:translateX(-50%) translateY(4px);
  display:flex;align-items:baseline;gap:6px;white-space:nowrap;pointer-events:none;
  padding:3px 11px;border-radius:7px;opacity:0;transition:opacity 0.28s ease,transform 0.28s ease;
  background:rgba(14,20,36,0.62);border:1px solid color-mix(in srgb,var(--ix-glow) 38%,transparent);
  box-shadow:0 4px 16px rgba(0,0,0,0.4),0 0 14px color-mix(in srgb,var(--ix-glow) 18%,transparent);
  backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
.ix-tag-en{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:15px;
  letter-spacing:0.04em;color:var(--ix-core);text-shadow:0 0 10px color-mix(in srgb,var(--ix-glow) 60%,transparent)}
.ix-tag-cn{font-family:'Noto Serif SC',serif;font-size:11px;letter-spacing:0.12em;
  color:color-mix(in srgb,var(--ix-core) 80%,#cfe)}
body:not(.theme-infernal) .ix-tag{background:rgba(252,247,238,0.82);
  border-color:color-mix(in srgb,var(--ix-deep) 50%,transparent);
  box-shadow:0 4px 16px rgba(60,40,10,0.18),0 0 14px color-mix(in srgb,var(--ix-glow) 30%,transparent)}
body:not(.theme-infernal) .ix-tag-en{color:#6a4c12;text-shadow:0 0 8px rgba(255,240,200,0.7)}
body:not(.theme-infernal) .ix-tag-cn{color:#7a5a1e}

/* hover / active intensify */
.ix-marker:hover .ix-aura{opacity:0.85;animation:none;
  transform:translate(-50%,-50%) scale(1.18);width:72px;height:40px;
  background:radial-gradient(ellipse at center,
    color-mix(in srgb,var(--ix-glow) 75%,transparent) 0%,
    color-mix(in srgb,var(--ix-glow) 32%,transparent) 48%,transparent 74%)}
.ix-marker:hover .ix-aura::after{animation:ixPing 1.1s ease-out infinite}
@keyframes ixPing{0%{opacity:0.5;transform:scale(0.55)}80%{opacity:0;transform:scale(1.5)}100%{opacity:0}}
.ix-marker:hover .ix-spark{animation-duration:1.3s}
.ix-marker:hover .ix-spark-star{filter:drop-shadow(0 0 9px var(--ix-glow));animation-duration:1.3s}
.ix-marker:hover .ix-tag{opacity:1;transform:translateX(-50%) translateY(0)}
.ix-marker:active .ix-spark{transform:translateX(-50%) translateY(2px) scale(0.9)}

/* ── SUI GREETING — two extra options shown below the greeting line ─ */
.sui-extra-opts{position:absolute;top:57%;left:14%;right:14%;z-index:3;
  display:flex;flex-direction:column;gap:6px;pointer-events:auto}
.sui-extra-opt{width:100%;text-align:left;margin:0}

/* Responsive scaling handled by JS updateScale() */
`;

/* ============================================================
   INJECT CSS
   ============================================================ */
function injectCSS(){
  const s=document.createElement('style');
  s.id='game-css';
  s.textContent=CSS+TEA_CSS+STORY_CSS;
  document.head.appendChild(s);
}

/* ============================================================
   INJECT HTML
   ============================================================ */
function injectHTML(){
  /* Nav link */
  const navLinks=document.querySelector('.nav-links');
  if(navLinks){
    const li=document.createElement('li');
    li.innerHTML='<a href="#game" data-page="game">Room</a>';
    li.firstElementChild.addEventListener('click',function(event){event.preventDefault();navTo('game')});
    const chatLi=navLinks.querySelector('[data-page="chat"]')?.parentElement;
    if(chatLi) navLinks.insertBefore(li, chatLi);
    else navLinks.appendChild(li);
  }

  /* Game full page */
  const app=document.getElementById('app');
  if(app){
    const page=document.createElement('div');
    page.className='page';
    page.id='page-game';
    page.innerHTML='<div class="game-cine"><div class="game-cine-top"><h2>Room</h2><span class="game-cine-sub">Interactive pixel sanctuary</span></div><div class="game-cine-rule"></div><div class="game-cine-desc">古早像素风格的私密房间。点击右侧菜单或房间里的光标，开启塔罗占卜、茶话会与专属冒险剧本。</div></div><div class="game-fullpage-wrap" id="game-fullpage-wrap" style="display:flex"><div id="game-fullpage-container"></div><div class="game-sidebar" id="game-sidebar-page"><div class="game-sidebar-title">Menu</div><div class="game-sidebar-sep"></div><button class="game-sidebar-btn" data-action="sui">Sui</button><div class="game-sidebar-sep"></div><button class="game-sidebar-btn" data-action="tea">Tea</button><button class="game-sidebar-btn" data-action="desk">Story</button><button class="game-sidebar-btn" data-action="crystal">Tarot</button><div class="game-sidebar-sep"></div><button class="game-sidebar-btn" data-action="wardrobe">Wardrobe</button><button class="game-sidebar-btn" data-action="bed">Sleep</button><button class="game-sidebar-btn-reset" data-action="reset">Reset</button></div></div>';
    app.appendChild(page);
  }

  /* Mini icon */
  const mini=document.createElement('div');
  mini.innerHTML='Room';
  mini.id='game-mini';
  mini.addEventListener('click',()=>openGamePanel());
  document.body.appendChild(mini);

  /* Floating panel */
  const panel=document.createElement('div');
  panel.id='game-panel';
  panel.innerHTML=`<div class="game-panel-header" id="game-panel-header">
    <span class="game-panel-title">Room</span>
    <div style="display:flex;align-items:center;gap:10px">
      <button class="game-panel-close" id="game-pet-enter" title="小窗" style="font-size:0.72rem;opacity:0.7;font-style:normal;letter-spacing:0.08em">Mini</button>
      <div class="game-panel-zoom">
        <button id="game-zoom-out" title="缩小">−</button>
        <button id="game-zoom-in" title="放大">+</button>
      </div>
      <button class="game-panel-close" id="game-panel-close">✕</button>
    </div>
  </div><div style="display:flex"><div id="game-panel-viewport-container"></div><div class="game-sidebar" id="game-sidebar">
    <div class="game-sidebar-title">Menu</div>
    <div class="game-sidebar-sep"></div>
    <button class="game-sidebar-btn" data-action="sui">Sui</button>
    <div class="game-sidebar-sep"></div>
    <button class="game-sidebar-btn" data-action="tea">Tea</button>
    <button class="game-sidebar-btn" data-action="desk">Story</button>
    <button class="game-sidebar-btn" data-action="crystal">Tarot</button>
    <div class="game-sidebar-sep"></div>
    <button class="game-sidebar-btn" data-action="wardrobe">Wardrobe</button>
    <button class="game-sidebar-btn" data-action="bed">Sleep</button>
    <button class="game-sidebar-btn-reset" data-action="reset">Reset</button>
  </div></div>`;
  document.body.appendChild(panel);

  /* Pet window (320×320 viewport + Room-style header) */
  const petWin=document.createElement('div');
  petWin.id='game-pet-window';
  petWin.innerHTML=`<div class="game-panel-header" id="game-pet-header"><span class="game-panel-title">Sui</span><div style="display:flex;align-items:center;gap:8px"><button class="game-panel-close" id="pet-sleep-btn" title="Sleep" style="font-size:0.78rem;font-style:normal;letter-spacing:0.06em">Sleep</button><button class="game-panel-close" id="pet-exit-btn" title="恢复">✕</button></div></div><div id="game-pet-viewport-wrap"></div>`;
  document.body.appendChild(petWin);
  /* Drag ONLY via the header bar (not the game viewport) */
  const petHeader=petWin.querySelector('#game-pet-header');
  let petDrag=false,petOx=0,petOy=0;
  petHeader.addEventListener('mousedown',e=>{if(e.target.closest('button'))return;petDrag=true;petOx=e.clientX-petWin.offsetLeft;petOy=e.clientY-petWin.offsetTop;e.preventDefault()});
  document.addEventListener('mousemove',e=>{if(!petDrag)return;petWin.style.left=(e.clientX-petOx)+'px';petWin.style.top=(e.clientY-petOy)+'px';petWin.style.right='auto';petWin.style.bottom='auto'});
  document.addEventListener('mouseup',()=>{petDrag=false});
  petHeader.addEventListener('touchstart',e=>{if(e.target.closest('button'))return;petDrag=true;var t=e.touches[0];petOx=t.clientX-petWin.offsetLeft;petOy=t.clientY-petWin.offsetTop},{passive:true});
  document.addEventListener('touchmove',e=>{if(!petDrag)return;var t=e.touches[0];petWin.style.left=(t.clientX-petOx)+'px';petWin.style.top=(t.clientY-petOy)+'px';petWin.style.right='auto';petWin.style.bottom='auto'},{passive:true});
  document.addEventListener('touchend',()=>{petDrag=false});
  /* Keep pet window visible on browser resize / un-maximize */
  window.addEventListener('resize',function(){
    if(!G.petMode)return;
    var pw=document.getElementById('game-pet-window');
    if(!pw||!pw.classList.contains('show'))return;
    var r=pw.getBoundingClientRect();
    if(r.right<40||r.left>window.innerWidth-40||r.bottom<40||r.top>window.innerHeight-40){
      pw.style.left='auto';pw.style.top='auto';pw.style.right='20px';pw.style.bottom='20px';
    }
  });
}

/* ============================================================
   GAME ENGINE
   ============================================================ */
let G = {
  initialized: false,
  running: false,
  state: 'sleeping', // sleeping | waking | idle | walking | interacting | lying | sitting
  outfitIdx: 2,      // default outfit = casual (blue everyday clothes); OUTFITS index 2
  charX: BED_STAND_X,
  charY: BED_STAND_Y,
  targetX: null,
  targetY: null,
  waypoint: null,
  path: null,          // array of {x,y} waypoints from findPath
  onArrive: null,      // callback fired when a walk completes (tour)
  tourActive: false,   // guided home tour in progress
  pendingTour: false,  // request to start the tour once the room is ready
  facing: 'down', // up | down | left | right
  walkFrame: 0,
  walkTimer: 0,
  idleFrame: 0,
  idleTimer: 0,
  lieFrame: 0,
  lieTimer: 0,
  lieMode: 'awake', // awake | sleeping
  isFirstOpen: true,
  dialogueActive: false,
  dialoguePages: [],
  dialoguePageIdx: 0,
  dialogueCb: null,
  typewriterIdx: 0,
  typewriterTimer: null,
  tarotOpen: false,
  wardrobeOpen: false,
  aiGameActive: false,
  aiGameRound: 0,
  aiGameHistory: [],
  teaOpen: false,
  teaAnimActive: false,
  _teaAnimInterval: null,
  teaChatActive: false,
  teaRound: 0,
  teaMaxRounds: 52,
  teaHistory: [],
  teaDrink: null,
  teaDessert: null,
  _teaCfg: null,
  _teaSysPrompt: '',
  _teaPortraitImg: null,   // custom DIY portrait for the current tea AI (or null)
  _aiPortraitImg: null,    // custom DIY portrait for the current Story AI (or null)
  _deskSprTimer: null,     // desk sprite 2-frame animation timer
  _deskTypwTimer: null,    // desk sprite typewriter animation timer
  petMode: false,          // QQ-pet mini window mode
  petScale: 0.5,           // pet window zoom scale
  petCamX: 0,              // pet camera offset X (game coords)
  petCamY: 0,              // pet camera offset Y (game coords)
  /* ── Story 常驻视窗（storyWin）内部状态 ── */
  swEl: null,              // 视窗根DOM节点（null = 未开启）
  swMood: 'calm',          // 当前情绪：calm / joy / tense / sad / shock
  swFrame: 0,              // 精灵当前帧（0-5）
  swFrameTimer: null,      // 精灵帧循环定时器
  swBubbleTimer: null,     // “……”气泡打字机定时器
  swSaveTimer: null,       // 存档提示自动隐藏定时器
  swEmoteTimer: null,      // 头顶表情气泡自动消失定时器
  swThemeObs: null,        // body 主题class观察者（昼夜实时切换）
  mode: 'float', // float | page
  userScale: 0.75, // user zoom level for float mode
  animFrame: null,
  assets: {},
  container: null,
  viewport: null,
  lastTime: 0,
  scale: 1
};

/* ── ASSET LOADING ───────────────────────────────────── */
function loadImage(src){
  return new Promise((res)=>{
    const img=new Image();
    const timer=setTimeout(()=>{console.warn('[SuiGame] Timeout loading:',src);res(null)},8000);
    img.onload=()=>{clearTimeout(timer);res(img)};
    img.onerror=()=>{clearTimeout(timer);console.warn('[SuiGame] Failed to load:',src);res(null)};
    img.src=src;
  });
}

async function loadAssets(){
  const outfit = OUTFITS[G.outfitIdx];
  const toLoad = {
    roomDay: 'game/room_day.png',
    roomNight: 'game/room_night.png',
    dialogueBox: 'game/dialogue_box.png',
    walk: outfit.walk,
    idle: outfit.idle,
    lie: outfit.lie,
    portrait: outfit.portrait
  };
  const keys = Object.keys(toLoad);
  const results = await Promise.all(Object.values(toLoad).map(src=>loadImage(src)));
  keys.forEach((k,i)=>{
    G.assets[k]=results[i];
    if(!results[i]) console.warn('[SuiGame] Asset missing:',toLoad[k]);
  });
}

async function loadOutfitAssets(idx){
  const outfit = OUTFITS[idx];
  G.assets.walk = await loadImage(outfit.walk);
  G.assets.idle = await loadImage(outfit.idle);
  G.assets.lie = await loadImage(outfit.lie);
  G.assets.portrait = await loadImage(outfit.portrait);
}

/* ── CUSTOM DIY PORTRAIT (per-API nickname) ─────────────────
   The DIY module documents that each API can have a custom transparent
   half-body portrait placed at game/portraits/portrait_[API昵称].png, shown
   on the left of the Story and Tea dialogue boxes. This implements that:
   it builds the path from the config's nickname and loads it. loadImage()
   resolves to null on error/timeout, so a missing portrait simply shows
   nothing (no broken-image icon, no exception). */
function customPortraitSrc(cfg){
  if(!cfg) return null;
  const nick=(cfg.nickname||cfg.model||'').trim();
  if(!nick) return null;
  return 'game/portraits/portrait_['+nick+'].png';
}
function loadCustomPortrait(cfg){
  const src=customPortraitSrc(cfg);
  if(!src) return Promise.resolve(null);
  return loadImage(src);
}

/* ── VIEWPORT CREATION ───────────────────────────────── */
function createViewport(container){
  container.innerHTML=''; /* Clear any loading text */
  const vp = document.createElement('div');
  vp.className='game-viewport';
  vp.innerHTML = `
    <div class="game-bg game-bg-day"></div>
    <div class="game-bg game-bg-night"></div>
    <div class="game-cold-filter"></div>
    <div class="game-lights-overlay game-day-lights">
      <div class="light-beam-day"></div>
      <div class="light-beam-cool"></div>
      <div class="light-prism">
        <div class="light-prism-rainbow"></div>
        <div class="light-prism-streak1"></div>
        <div class="light-prism-streak2"></div>
        <div class="light-prism-shimmer"></div>
      </div>
    </div>
    <div class="game-lights-overlay game-night-lights">
      <div class="light-beam-night"></div>
    </div>
    <canvas class="game-lights" id="game-lights-canvas" width="${GAME_W}" height="${GAME_H}"></canvas>
    <div class="game-dust" id="game-dust"></div>
    <div class="game-vignette"></div>
    <div class="game-char" id="game-char" style="display:none">
      <div class="game-char-sprite"><img id="game-char-img"></div>
      <div class="game-char-shadow"></div>
      <div class="game-char-lightcast"></div>
    </div>
    <div class="game-char-lie" id="game-char-lie" style="display:none">
      <img id="game-char-lie-img">
    </div>
    <div class="game-desk-spr" id="game-desk-spr">
      <div id="game-desk-sheet"></div>
      <div id="game-desk-sheet-inf"></div>
    </div>
    <div class="game-desk-zzz" id="game-desk-zzz">
      <img class="sleep-bubble-img sbi-internal" src="game/sleep_bubble_internal.png" alt="">
      <img class="sleep-bubble-img sbi-infernal" src="game/sleep_bubble_infernal.png" alt="">
      <span class="sleep-star s0">✦</span>
      <span class="sleep-star s1">✦</span>
      <span class="sleep-star s2">✦</span>
      <span class="sleep-star s3">✦</span>
    </div>
    <div id="game-indicators"></div>
    <div class="game-zzz" id="game-zzz" style="display:none"><span>Z</span><span>z</span><span>z</span></div>
    <div class="game-dialogue" id="game-dialogue">
      <div class="game-dialogue-portrait" id="game-portrait"><img id="game-portrait-img"></div>
      <div class="game-dialogue-box-wrap">
        <div class="game-dialogue-box">
          <div class="game-dialogue-name" id="game-dlg-name">Sui</div>
          <div class="game-dialogue-text" id="game-dlg-text"></div>
          <div class="game-dialogue-actions" id="game-dlg-actions"></div>
          <div class="game-choices" id="game-choices"></div>
          <div class="game-dlg-persistent" id="game-dlg-persistent">
            <button class="game-dlg-btn game-dlg-btn-back" id="game-dlg-back"><span class="tri-back">◂</span> Back</button>
            <button class="game-dlg-btn game-dlg-btn-save" id="game-dlg-save" style="display:none">✦ Save</button>
            <button class="game-dlg-btn game-dlg-btn-next" id="game-dlg-next-btn">Next <span class="tri-next">▸</span></button>
          </div>
        </div>
      </div>
    </div>
    <div class="game-wardrobe" id="game-wardrobe"></div>
    <div class="game-tarot" id="game-tarot"></div>
    <div class="game-ai-setup" id="game-ai-setup"></div>
    <div class="game-fade" id="game-fade"></div>
  `;

  /* Add candle lights */
  const candles = [
    {x:62,y:460,s:50},{x:72,y:680,s:40},       // left wall candles
    {x:358,y:235,s:45},{x:438,y:235,s:45},      // sconces by bed
    {x:1490,y:450,s:40},{x:1460,y:350,s:35},    // right wall candles
    {x:1345,y:475,s:30},{x:1370,y:478,s:28}     // desk candles
  ];
  const nightLayer = vp.querySelector('.game-night-lights');
  const dayLayer = vp.querySelector('.game-day-lights');
  candles.forEach(c=>{
    const el=document.createElement('div');
    el.className='light-candle light-candle-night';
    el.style.cssText=`left:${c.x-c.s/2}px;top:${c.y-c.s/2}px;width:${c.s}px;height:${c.s}px;animation-delay:${Math.random()*2}s`;
    nightLayer.appendChild(el);
    const el2=document.createElement('div');
    el2.className='light-candle';
    el2.style.cssText=`left:${c.x-c.s/2}px;top:${c.y-c.s/2}px;width:${c.s*0.6}px;height:${c.s*0.6}px;animation-delay:${Math.random()*2}s;opacity:0.3`;
    dayLayer.appendChild(el2);
  });
  /* Crystal glow */
  const crys = document.createElement('div');
  crys.className='light-crystal';
  nightLayer.appendChild(crys);
  const crys2=crys.cloneNode();
  crys2.style.opacity='0.4';
  dayLayer.appendChild(crys2);

  /* Floating light motes (day mode only) */
  for(let i=0;i<12;i++){
    const mote=document.createElement('div');
    mote.className='light-mote';
    const x=350+Math.random()*800;
    const y=100+Math.random()*600;
    const s=4+Math.random()*8;
    const dur=8+Math.random()*12;
    const mx=(Math.random()-0.5)*80;
    const my=-(20+Math.random()*60);
    mote.style.cssText=`left:${x}px;top:${y}px;width:${s}px;height:${s}px;animation-duration:${dur}s;animation-delay:${Math.random()*dur}s;--mx:${mx}px;--my:${my}px;--mx2:${mx*1.5}px;--my2:${my*1.5}px`;
    dayLayer.appendChild(mote);
  }

  /* Dust particles */
  const dustContainer=vp.querySelector('#game-dust');
  for(let i=0;i<20;i++){
    const d=document.createElement('div');
    d.className='dust-particle';
    d.style.left=Math.random()*100+'%';
    d.style.top=Math.random()*100+'%';
    d.style.animationDuration=(10+Math.random()*15)+'s';
    d.style.animationDelay=Math.random()*10+'s';
    d.style.opacity=0.2+Math.random()*0.4;
    dustContainer.appendChild(d);
  }

  /* Sidebar button handlers are set up in setupSidebar() */

  /* ── Interaction markers (glow + bobbing sparkle + hover plaque) ── */
  const indicatorDiv = vp.querySelector('#game-indicators');
  MARKERS.forEach(m=>{
    const it = INTERACTIONS.find(i=>i.id===m.id);
    if(!it) return;
    const marker = document.createElement('div');
    marker.className = 'ix-marker';
    marker.id = 'ix-'+m.id;
    marker.dataset.id = m.id;
    marker.style.left = it.iconX+'px';
    marker.style.top  = it.iconY+'px';
    marker.innerHTML =
      '<div class="ix-aura"></div>'+
      '<div class="ix-spark"><div class="ix-spark-star"></div></div>'+
      '<div class="ix-tag"><span class="ix-tag-en">'+m.en+'</span><span class="ix-tag-cn">'+m.cn+'</span></div>';
    marker.addEventListener('click', (e)=>{ onHintClick(m.id, e); });
    indicatorDiv.appendChild(marker);
  });

  /* Night background hidden by default */
  const isNight = document.body.classList.contains('theme-infernal');
  vp.querySelector('.game-bg-day').style.opacity = isNight?'0':'1';
  vp.querySelector('.game-bg-night').style.opacity = isNight?'1':'0';

  /* Click to move */
  vp.addEventListener('click', onViewportClick);

  container.appendChild(vp);
  G.viewport = vp;
  return vp;
}

/* ── SCALING ─────────────────────────────────────────── */
function updateScale(){
  if(!G.viewport) return;
  if(G.petMode) return; /* pet mode handles its own scaling */
  const sidebarW = G.mode==='float'
    ? (document.getElementById('game-sidebar')?.offsetWidth||0)
    : (document.getElementById('game-sidebar-page')?.offsetWidth||0);
  const introEl = document.querySelector('#page-game .game-cine');
  const introH = introEl ? introEl.offsetHeight + 6 : 0;
  const maxW = G.mode==='page' ? window.innerWidth-64-sidebarW : window.innerWidth-60-sidebarW;
  const maxH = G.mode==='page' ? window.innerHeight-140-introH : window.innerHeight-100;
  const sw = maxW/GAME_W, sh = maxH/GAME_H;
  const autoScale = Math.min(sw, sh, 1);
  G.scale = G.mode==='float' ? Math.min(autoScale, G.userScale||0.75) : autoScale;
  G.viewport.style.transform = `scale(${G.scale})`;
  G.viewport.style.transformOrigin = 'top left';
  const vw = Math.floor(GAME_W*G.scale), vh = Math.floor(GAME_H*G.scale);
  if(G.mode==='float'){
    const panel=document.getElementById('game-panel');
    if(panel){
      panel.style.width = (vw+sidebarW)+'px';
      panel.style.height = (vh+36)+'px';
    }
    const pc=document.getElementById('game-panel-viewport-container');
    if(pc){pc.style.width=vw+'px';pc.style.height=vh+'px';pc.style.overflow='hidden'}
  }else{
    const pc=document.getElementById('game-fullpage-container');
    if(pc){pc.style.width=vw+'px';pc.style.height=vh+'px';pc.style.overflow='hidden'}
    const wrap=document.getElementById('game-fullpage-wrap');
    if(wrap){wrap.style.height=vh+'px'}
    const pg=document.getElementById('page-game');
    if(pg){pg.style.setProperty('--room-w',(vw+sidebarW)+'px');pg.style.setProperty('--room-scale',String(G.scale))}
  }
}

/* ── GEOMETRY HELPERS ────────────────────────────────── */
function pointInPoly(px,py,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if((yi>py)!==(yj>py)&&px<(xj-xi)*(py-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}
function pointInObstacle(px,py){
  for(const o of OBSTACLES){
    if(o.type==='circle'){
      if(Math.hypot(px-o.x,py-o.y)<o.r) return true;
    }else{
      if(px>o.x&&px<o.x+o.w&&py>o.y&&py<o.y+o.h) return true;
    }
  }
  return false;
}
function isWalkable(px,py){
  return pointInPoly(px,py,WALK_POLY) && !pointInObstacle(px,py);
}
function clampToWalkable(tx,ty){
  if(isWalkable(tx,ty)) return {x:tx,y:ty};
  /* Find nearest walkable point (brute-force on boundary) */
  let best=null, bestD=Infinity;
  for(let i=0;i<WALK_POLY.length;i++){
    const a=WALK_POLY[i], b=WALK_POLY[(i+1)%WALK_POLY.length];
    const p=nearestOnSegment(tx,ty,a.x,a.y,b.x,b.y);
    const d=Math.hypot(p.x-tx,p.y-ty);
    if(d<bestD && !pointInObstacle(p.x,p.y)){bestD=d;best=p}
  }
  return best||{x:G.charX,y:G.charY};
}
function nearestOnSegment(px,py,ax,ay,bx,by){
  const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)));
  return {x:ax+t*dx,y:ay+t*dy};
}

/* ── PATHFINDING (grid A* + line-of-sight smoothing) ──── */
let NAV=null;
function buildNavGrid(){
  const CELL=34, minX=80, maxX=1130, minY=370, maxY=855;
  const cols=Math.ceil((maxX-minX)/CELL), rows=Math.ceil((maxY-minY)/CELL);
  const grid=[];
  for(let r=0;r<rows;r++){grid[r]=[];for(let c=0;c<cols;c++){
    const x=minX+c*CELL+CELL/2, y=minY+r*CELL+CELL/2;
    grid[r][c]=isWalkable(x,y)?0:1;
  }}
  NAV={CELL,minX,minY,cols,rows,grid};
}
function navCellOf(x,y){return {c:Math.floor((x-NAV.minX)/NAV.CELL), r:Math.floor((y-NAV.minY)/NAV.CELL)}}
function navCenter(c,r){return {x:NAV.minX+c*NAV.CELL+NAV.CELL/2, y:NAV.minY+r*NAV.CELL+NAV.CELL/2}}
function navWalkable(c,r){return r>=0&&r<NAV.rows&&c>=0&&c<NAV.cols&&NAV.grid[r][c]===0}
function nearestNavCell(x,y){
  const o=navCellOf(x,y);
  if(navWalkable(o.c,o.r)) return o;
  for(let rad=1;rad<14;rad++){
    for(let dc=-rad;dc<=rad;dc++) for(let dr=-rad;dr<=rad;dr++){
      if(Math.abs(dc)!==rad&&Math.abs(dr)!==rad) continue;
      if(navWalkable(o.c+dc,o.r+dr)) return {c:o.c+dc,r:o.r+dr};
    }
  }
  return null;
}
function lineClear(ax,ay,bx,by){
  const steps=Math.ceil(Math.hypot(bx-ax,by-ay)/8);
  for(let i=0;i<=steps;i++){const t=steps?i/steps:0;
    if(!isWalkable(ax+(bx-ax)*t, ay+(by-ay)*t)) return false;}
  return true;
}
function smoothPath(sx,sy,pts){
  const full=[{x:sx,y:sy},...pts], out=[];
  let i=0;
  while(i<full.length-1){
    let j=full.length-1;
    while(j>i+1 && !lineClear(full[i].x,full[i].y,full[j].x,full[j].y)) j--;
    out.push(full[j]); i=j;
  }
  return out;
}
function findPath(sx,sy,tx,ty){
  if(!NAV) buildNavGrid();
  if(lineClear(sx,sy,tx,ty)) return [{x:tx,y:ty}];
  const start=nearestNavCell(sx,sy), goal=nearestNavCell(tx,ty);
  if(!start||!goal) return [];
  const key=(c,r)=>r*NAV.cols+c;
  const g=new Map(), came=new Map(), open=new Map();
  const h=(c,r)=>Math.hypot(c-goal.c,r-goal.r);
  const sK=key(start.c,start.r);
  g.set(sK,0); open.set(sK,{c:start.c,r:start.r,f:h(start.c,start.r)});
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let found=false, guard=0;
  while(open.size && guard++<20000){
    let bestK=null,best=null;
    for(const [k,v] of open){ if(!best||v.f<best.f){best=v;bestK=k} }
    open.delete(bestK);
    if(best.c===goal.c&&best.r===goal.r){found=true;break}
    const bK=key(best.c,best.r), bg=g.get(bK);
    for(const [dc,dr] of dirs){
      const nc=best.c+dc, nr=best.r+dr;
      if(!navWalkable(nc,nr)) continue;
      if(dc!==0&&dr!==0 && (!navWalkable(best.c+dc,best.r)||!navWalkable(best.c,best.r+dr))) continue;
      const nk=key(nc,nr), ng=bg+((dc!==0&&dr!==0)?1.4142:1);
      if(!g.has(nk)||ng<g.get(nk)){
        g.set(nk,ng); came.set(nk,bK);
        open.set(nk,{c:nc,r:nr,f:ng+h(nc,nr)});
      }
    }
  }
  if(!found) return [];
  const path=[]; let ck=key(goal.c,goal.r);
  while(ck!==undefined){
    const c=ck%NAV.cols, r=Math.floor(ck/NAV.cols);
    path.push(navCenter(c,r));
    if(ck===sK) break;
    ck=came.get(ck);
  }
  path.reverse();
  path.push({x:tx,y:ty});
  return smoothPath(sx,sy,path);
}

/* ── WALK ORCHESTRATION ───────────────────────────────── */
function startWalkTo(tx,ty,opts){
  opts=opts||{};
  const target=clampToWalkable(tx,ty);
  G.targetX=target.x; G.targetY=target.y;
  G.path=findPath(G.charX,G.charY,target.x,target.y);
  if(!G.path||!G.path.length){G.state='idle';G.targetX=null;G.targetY=null;G.path=null;return}
  G.waypoint=null;
  G.state='walking'; G.walkTimer=0;
  G.pendingInteraction=opts.interaction||null;
  G.onArrive=opts.onArrive||null;
  const first=(G.path&&G.path.length)?G.path[0]:target;
  const dx=first.x-G.charX, dy=first.y-G.charY;
  if(Math.abs(dx)>Math.abs(dy)) G.facing=dx>0?'right':'left';
  else G.facing=dy>0?'down':'up';
  if(G._interactTimeout){clearTimeout(G._interactTimeout);G._interactTimeout=null}
  if(opts.interaction||opts.onArrive){
    G._interactTimeout=setTimeout(()=>{
      if(G.state==='walking'){
        G.state='idle'; G.targetX=null; G.targetY=null; G.path=null;
        handleArrival();
      }
    }, opts.timeout||8000);
  }
}
function handleArrival(){
  if(G._interactTimeout){clearTimeout(G._interactTimeout);G._interactTimeout=null}
  if(G.onArrive){ const cb=G.onArrive; G.onArrive=null; G.pendingInteraction=null; cb(); return; }
  if(G.pendingInteraction){
    const id=G.pendingInteraction; G.pendingInteraction=null;
    const it=INTERACTIONS.find(i=>i.id===id); if(it) G.facing=it.face;
    triggerInteraction(id);
  }
}

/* ── MARKER VISIBILITY ────────────────────────────────── */
function updateMarkers(){
  if(!G.viewport) return;
  const ind=G.viewport.querySelector('#game-indicators');
  if(!ind) return;
  const show = !G.petMode && G.state==='idle' && !G.tourActive && !G.dialogueActive &&
    !G.tarotOpen && !G.wardrobeOpen && !G.teaOpen && !G.teaChatActive && !G.aiGameActive;
  ind.classList.toggle('ix-off', !show);
}

/* ── Zzz DISPLAY ──────────────────────────────────────── */
function showZzz(show){
  const el=G.viewport?.querySelector('#game-zzz');
  if(!el)return;
  if(show){
    el.style.display='block';
    el.style.left=(BED_LIE_X+170)+'px';
    el.style.top=(BED_LIE_Y-10)+'px';
  }else{
    el.style.display='none';
  }
}

/* ── VIEWPORT CLICK → MOVE ───────────────────────────── */
function onViewportClick(e){
  if(G.aiGameActive) return; /* locked during AI game */
  if(G.teaChatActive||G.teaOpen) return; /* locked during Tea */
  if(G.tourActive) return; /* locked during the guided tour */
  if(G.dialogueActive||G.tarotOpen||G.wardrobeOpen||G.state==='interacting') return;
  if(G.state==='sleeping'){
    /* Wake up with eye-opening animation */
    showZzz(false);
    G.lieMode='awake'; G.lieFrame=0;
    updateLieSprite();
    G.state='waking';
    setTimeout(()=>{
      if(!G.viewport||G.state!=='waking') return;
      G.viewport.querySelector('#game-char-lie').style.display='none';
      G.viewport.querySelector('#game-char').style.display='block';
      G.charX=BED_STAND_X; G.charY=BED_STAND_Y;
      G.state='idle'; G.facing='down'; G.isFirstOpen=false;
      updateCharPosition(); updateIdleSprite();
      if(!G.petMode) toggleSidebar(true);
      saveState();
    }, 800);
    return;
  }
  if(G.state==='lying'){
    /* Don't wake up during Sui dialogue */
    if(suiActive) return;
    /* Wake up from bed with eye-opening animation */
    showZzz(false);
    G.lieMode='awake'; G.lieFrame=0;
    updateLieSprite();
    G.state='waking';
    setTimeout(()=>{
      if(!G.viewport||G.state!=='waking') return;
      G.viewport.querySelector('#game-char-lie').style.display='none';
      G.viewport.querySelector('#game-char').style.display='block';
      G.charX=BED_STAND_X; G.charY=BED_STAND_Y;
      G.state='idle'; G.facing='down';
      updateCharPosition(); updateIdleSprite();
      if(!G.petMode) toggleSidebar(true);
      saveState();
    }, 800);
    return;
  }
  if(G.state==='waking') return;
  const rect=G.viewport.getBoundingClientRect();
  var mx=(e.clientX-rect.left)/G.scale;
  var my=(e.clientY-rect.top)/G.scale;
  /* Pet mode: use the wrap container rect (viewport rect is shifted by the translate transform) */
  if(G.petMode){
    var wrapEl=document.getElementById('game-pet-viewport-wrap');
    if(wrapEl){
      var wr=wrapEl.getBoundingClientRect();
      mx=(e.clientX-wr.left)/G.petScale+G.petCamX;
      my=(e.clientY-wr.top)/G.petScale+G.petCamY;
    }
  }
  startWalkTo(mx,my);
}

/* ── HINT CLICK → WALK TO OBJECT & INTERACT (RPG Maker) ── */
function onHintClick(id, e){
  if(e) e.stopPropagation();
  if(G.petMode) return; /* locked in pet mode */
  if(G.aiGameActive||G.teaChatActive||G.teaOpen) return;
  if(G.tourActive) return; /* locked during the guided tour */
  if(G.dialogueActive||G.tarotOpen||G.wardrobeOpen||G.state==='interacting') return;
  if(G.state==='sleeping'||G.state==='lying'||G.state==='waking') return;

  const it = INTERACTIONS.find(i=>i.id===id);
  if(!it) return;

  /* Auto-path to the interaction point, then trigger on arrival */
  const walkX = id==='bed' ? BED_SLEEP_WALK_X : it.x;
  const walkY = id==='bed' ? BED_SLEEP_WALK_Y : it.y;
  startWalkTo(walkX, walkY, {interaction:id});
}

/* ── INTERACTION ─────────────────────────────────────── */
function resetGame(){
  /* One-click reset: clears any stuck state */
  if(G.typewriterTimer){clearInterval(G.typewriterTimer);G.typewriterTimer=null}
  closeDialogue();
  closeTarot();
  closeWardrobe();
  if(suiActive) exitSui();
  /* Tea cleanup */
  if(G.teaOpen) closeTeaSelect();
  if(G.teaChatActive) endTeaChat(false);
  stopTeaSpriteAnim();
  G.teaOpen=false;
  G.teaChatActive=false;
  if(G.viewport){
    const teaOverlay=G.viewport.querySelector('#game-tea-overlay');
    if(teaOverlay){teaOverlay.classList.remove('show');teaOverlay.innerHTML=''}
    const teaChat=G.viewport.querySelector('#game-tea-chat');
    if(teaChat) teaChat.remove();
  }
  if(G.viewport){
    const aiSetup=G.viewport.querySelector('#game-ai-setup');
    if(aiSetup) aiSetup.classList.remove('show');
  }
  G.aiGameActive=false;
  G._storyExitWarning=false;
  G._lastStoryState=null;
  G._aiCustomScript=null;
  /* Clean up desk reading sprite + story window (prevents duplicate character) */
  hideDeskSprite();
  closeStoryWindow();
  G.dialogueActive=false;
  G.tarotOpen=false;
  G.wardrobeOpen=false;
  G.pendingInteraction=null;
  G.tourActive=false;
  G.path=null;
  G.onArrive=null;
  if(G._interactTimeout){clearTimeout(G._interactTimeout);G._interactTimeout=null}
  disableSidebarButtons(false);
  /* Always clean up bed/lie/zzz state (catches sleeping, lying, AND waking mid-animation) */
  showZzz(false);
  if(G.viewport){
    const lieEl=G.viewport.querySelector('#game-char-lie');
    if(lieEl) lieEl.style.display='none';
  }
  /* Always reset position to window center */
  G.charX=650; G.charY=500;
  G.facing='up'; G.isFirstOpen=false;
  G.state='idle';
  G.targetX=null;G.targetY=null;
  updateCharPosition(); updateIdleSprite();
  toggleSidebar(true);
  saveState();
  if(typeof toast==='function') toast('已复位');
}

function onInteract(id){
  if(!G.initialized||!G.viewport) return; /* Guard: game must be ready */
  /* Reset always works */
  if(id==='reset'){resetGame();return}
  /* Locked while the guided tour is running */
  if(G.tourActive){
    if(typeof toast==='function') toast('正在进行家园引导…');
    return;
  }
  /* Grayed-out buttons during AI game */
  if(G.aiGameActive){
    if(typeof toast==='function') toast('请先退出正在进行的互动游戏。');
    return;
  }
  if(G.teaChatActive||G.teaOpen){
    if(typeof toast==='function') toast('请先退出茶歇。');
    return;
  }
  if(G.dialogueActive||G.state==='interacting'){
    if(id==='sui'||id==='tea') showBubble(G.charX, G.charY-40, '请先取消目前的交互动作。');
    return;
  }
  if(G.state==='sleeping'||G.state==='lying'||G.state==='waking'){
    if(id==='sui'||id==='tea') showBubble(G.charX, G.charY-40, '请先取消目前的交互动作。');
    return;
  }

  /* Desk, Tarot, Wardrobe, Tea: trigger directly without walking */
  if(id==='desk'||id==='crystal'||id==='wardrobe'||id==='tea'){
    G.state='interacting';
    const it=INTERACTIONS.find(i=>i.id===id);
    if(it) G.facing=it.face;
    triggerInteraction(id);
    return;
  }
  /* Sui: walk to bedside, then trigger */
  if(id==='sui'){
    startWalkTo(BED_SLEEP_WALK_X, BED_SLEEP_WALK_Y, {interaction:'sui'});
    return;
  }
  /* Bed and other interactions: walk to point, then trigger */
  const it=INTERACTIONS.find(i=>i.id===id);
  if(!it) return;
  const walkX = id==='bed' ? BED_SLEEP_WALK_X : it.x;
  const walkY = id==='bed' ? BED_SLEEP_WALK_Y : it.y;
  startWalkTo(walkX, walkY, {interaction:id});
}

function triggerInteraction(id){
  G.state='interacting';
  G.facing='up';
  switch(id){
    case 'bed': interactBed(); break;
    case 'tea': interactTea(); break;
    case 'crystal': interactCrystal(); break;
    case 'desk': interactDesk(); break;
    case 'wardrobe': interactWardrobe(); break;
    case 'sui': interactSui(); break;
  }
}

/* ── BED INTERACTION ─────────────────────────────────── */
function interactBed(){
  if(!G.viewport){G.state='idle';return;}
  /* Stage 1: "现在我该睡觉了吗？" — Back=cancel, Next=stage 2 */
  showDialogue('Sui',[FIXED_LINES.bed1],()=>{
    const nextBtn=G.viewport.querySelector('#game-dlg-next-btn');
    const backBtn=G.viewport.querySelector('#game-dlg-back');
    nextBtn.onclick=()=>{
      closeDialogue();
      /* Stage 2: one page — "我知道了，好。" with "晚安。" on the next line → sleep */
      setTimeout(()=>{
        showDialogue('Sui',[FIXED_LINES.bed_confirm+'\n'+FIXED_LINES.bed_sleep],()=>{
          const nextBtn2=G.viewport.querySelector('#game-dlg-next-btn');
          const backBtn2=G.viewport.querySelector('#game-dlg-back');
          nextBtn2.onclick=()=>{
            closeDialogue();
            setTimeout(()=>{
              if(!G.viewport) return;
              G.viewport.querySelector('#game-char').style.display='none';
              G.viewport.querySelector('#game-char-lie').style.display='block';
              G.state='lying'; G.lieMode='sleeping'; G.lieFrame=1;
              updateLieSprite();
              showZzz(true);
              saveState();
            },400);
          };
          backBtn2.onclick=()=>{closeDialogue();G.state='idle'};
        });
      },200);
    };
    backBtn.onclick=()=>{closeDialogue();G.state='idle'};
  });
}

/* ── TEA INTERACTION — see Tea Module at end of file ─── */

/* ---- IB 命名空间迁移：双挂载（window 实时 + IB.game 合并注册）。严格模式保持：IIFE 开括号置于文件头注释之前。 ---- */
function ibGameLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.extractJSON=extractJSON;
window.getTourIntro=getTourIntro;
window.injectCSS=injectCSS;
window.injectHTML=injectHTML;
window.loadImage=loadImage;
window.loadAssets=loadAssets;
window.loadOutfitAssets=loadOutfitAssets;
window.customPortraitSrc=customPortraitSrc;
window.loadCustomPortrait=loadCustomPortrait;
window.createViewport=createViewport;
window.updateScale=updateScale;
window.pointInPoly=pointInPoly;
window.pointInObstacle=pointInObstacle;
window.isWalkable=isWalkable;
window.clampToWalkable=clampToWalkable;
window.nearestOnSegment=nearestOnSegment;
window.buildNavGrid=buildNavGrid;
window.navCellOf=navCellOf;
window.navCenter=navCenter;
window.navWalkable=navWalkable;
window.nearestNavCell=nearestNavCell;
window.lineClear=lineClear;
window.smoothPath=smoothPath;
window.findPath=findPath;
window.startWalkTo=startWalkTo;
window.handleArrival=handleArrival;
window.updateMarkers=updateMarkers;
window.showZzz=showZzz;
window.onViewportClick=onViewportClick;
window.onHintClick=onHintClick;
window.resetGame=resetGame;
window.onInteract=onInteract;
window.triggerInteraction=triggerInteraction;
window.interactBed=interactBed;
window.GAME_W=GAME_W;
window.SPRITE_SIZE=SPRITE_SIZE;
window.LIE_FW=LIE_FW;
window.CHAR_SPEED=CHAR_SPEED;
window.WALK_FPS=WALK_FPS;
window.IDLE_INTERVAL=IDLE_INTERVAL;
window.TYPE_SPEED=TYPE_SPEED;
window.DIALOGUE_MAX_CHARS=DIALOGUE_MAX_CHARS;
window.DIALOGUE_MAX_LINES=DIALOGUE_MAX_LINES;
window.DIALOGUE_LINE_CHARS=DIALOGUE_LINE_CHARS;
window.WALK_POLY=WALK_POLY;
window.OBSTACLES=OBSTACLES;
window.CRYSTAL_FLOOR_LIGHT=CRYSTAL_FLOOR_LIGHT;
window.INTERACTIONS=INTERACTIONS;
window.BED_LIE_X=BED_LIE_X;
window.BED_STAND_X=BED_STAND_X;
window.BED_SLEEP_WALK_X=BED_SLEEP_WALK_X;
window.OUTFITS=OUTFITS;
window.FIXED_LINES=FIXED_LINES;
window.MARKERS=MARKERS;
window.TOUR_STEPS=TOUR_STEPS;
window.CSS=CSS;
window.GAME_H=GAME_H;
window.LIE_FH=LIE_FH;
window.BED_LIE_Y=BED_LIE_Y;
window.BED_STAND_Y=BED_STAND_Y;
window.BED_SLEEP_WALK_Y=BED_SLEEP_WALK_Y;
ibGameLive('G', function(){return G}, function(v){G=v});
ibGameLive('NAV', function(){return NAV}, function(v){NAV=v});
NS.expose('game', {
  extractJSON: extractJSON,
  getTourIntro: getTourIntro,
  injectCSS: injectCSS,
  injectHTML: injectHTML,
  loadImage: loadImage,
  loadAssets: loadAssets,
  loadOutfitAssets: loadOutfitAssets,
  customPortraitSrc: customPortraitSrc,
  loadCustomPortrait: loadCustomPortrait,
  createViewport: createViewport,
  updateScale: updateScale,
  pointInPoly: pointInPoly,
  pointInObstacle: pointInObstacle,
  isWalkable: isWalkable,
  clampToWalkable: clampToWalkable,
  nearestOnSegment: nearestOnSegment,
  buildNavGrid: buildNavGrid,
  navCellOf: navCellOf,
  navCenter: navCenter,
  navWalkable: navWalkable,
  nearestNavCell: nearestNavCell,
  lineClear: lineClear,
  smoothPath: smoothPath,
  findPath: findPath,
  startWalkTo: startWalkTo,
  handleArrival: handleArrival,
  updateMarkers: updateMarkers,
  showZzz: showZzz,
  onViewportClick: onViewportClick,
  onHintClick: onHintClick,
  resetGame: resetGame,
  onInteract: onInteract,
  triggerInteraction: triggerInteraction,
  interactBed: interactBed,
  GAME_W: GAME_W,
  SPRITE_SIZE: SPRITE_SIZE,
  LIE_FW: LIE_FW,
  CHAR_SPEED: CHAR_SPEED,
  WALK_FPS: WALK_FPS,
  IDLE_INTERVAL: IDLE_INTERVAL,
  TYPE_SPEED: TYPE_SPEED,
  DIALOGUE_MAX_CHARS: DIALOGUE_MAX_CHARS,
  DIALOGUE_MAX_LINES: DIALOGUE_MAX_LINES,
  DIALOGUE_LINE_CHARS: DIALOGUE_LINE_CHARS,
  WALK_POLY: WALK_POLY,
  OBSTACLES: OBSTACLES,
  CRYSTAL_FLOOR_LIGHT: CRYSTAL_FLOOR_LIGHT,
  INTERACTIONS: INTERACTIONS,
  BED_LIE_X: BED_LIE_X,
  BED_STAND_X: BED_STAND_X,
  BED_SLEEP_WALK_X: BED_SLEEP_WALK_X,
  OUTFITS: OUTFITS,
  FIXED_LINES: FIXED_LINES,
  MARKERS: MARKERS,
  TOUR_STEPS: TOUR_STEPS,
  CSS: CSS,
  GAME_H: GAME_H,
  LIE_FH: LIE_FH,
  BED_LIE_Y: BED_LIE_Y,
  BED_STAND_Y: BED_STAND_Y,
  BED_SLEEP_WALK_Y: BED_SLEEP_WALK_Y,
  G: G,
  NAV: NAV,
});
})(window.IB || (window.IB = {}));
