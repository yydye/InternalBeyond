(function(NS){
/* ============================================================
   SUI'S ROOM — Tarot module: deck data, card faces, spreads,
   reading UI. Split from game_module.js (statement order kept).
   ============================================================ */
'use strict';

/* ── TAROT DECK ────────────────────────────────────────── */
const MAJOR_ARCANA = [
  ['0','愚者','The Fool'],['I','魔术师','The Magician'],['II','女祭司','The High Priestess'],
  ['III','皇后','The Empress'],['IV','皇帝','The Emperor'],['V','教皇','The Hierophant'],
  ['VI','恋人','The Lovers'],['VII','战车','The Chariot'],['VIII','力量','Strength'],
  ['IX','隐者','The Hermit'],['X','命运之轮','Wheel of Fortune'],['XI','正义','Justice'],
  ['XII','倒吊人','The Hanged Man'],['XIII','死神','Death'],['XIV','节制','Temperance'],
  ['XV','恶魔','The Devil'],['XVI','塔','The Tower'],['XVII','星星','The Star'],
  ['XVIII','月亮','The Moon'],['XIX','太阳','The Sun'],['XX','审判','Judgement'],
  ['XXI','世界','The World']
];
const SUITS = [
  {en:'Wands',cn:'权杖',color:'#5a1a1a'},
  {en:'Cups',cn:'圣杯',color:'#1a2a5a'},
  {en:'Swords',cn:'宝剑',color:'#2a2a3a'},
  {en:'Pentacles',cn:'星币',color:'#4a3a0a'}
];
const RANKS = [
  {en:'Ace',cn:'',num:'A'},{en:'Two',cn:'二',num:'2'},{en:'Three',cn:'三',num:'3'},
  {en:'Four',cn:'四',num:'4'},{en:'Five',cn:'五',num:'5'},{en:'Six',cn:'六',num:'6'},
  {en:'Seven',cn:'七',num:'7'},{en:'Eight',cn:'八',num:'8'},{en:'Nine',cn:'九',num:'9'},
  {en:'Ten',cn:'十',num:'10'},{en:'Page',cn:'侍从',num:'P'},{en:'Knight',cn:'骑士',num:'Kn'},
  {en:'Queen',cn:'王后',num:'Q'},{en:'King',cn:'国王',num:'K'}
];

/* ── 流式传输辅助：游戏模块统一入口 ── */
function _isStreamEnabled(cfg){
  if(!cfg)return false;
  const streamCfg=cfg.streaming!==undefined?!!cfg.streaming:true;
  return streamCfg&&typeof callApiChatStream==='function';
}

function buildTarotDeck(){
  const deck=[];
  MAJOR_ARCANA.forEach(([num,cn,en],mi)=>deck.push({type:'major',num,cn,en,mi,display:num+' - '+cn+' '+en,color:'#2a1540'}));
  SUITS.forEach(s=>RANKS.forEach(r=>deck.push({type:'minor',suit:s,rank:r,
    display:s.cn+(r.cn||r.en)+' '+r.en+' of '+s.en,color:s.color,symbol:r.num})));
  return deck;
}
const TAROT_DECK = buildTarotDeck();

/* ══════════════════════════════════════════════════════════════
   TAROT FACES · "Vergelight Arcana"
   Three card-face designs by Claude (Fable 5) for Internal Beyond.
   Faces are English-only. A reversed draw is shown *physically* —
   the whole face rotates 180° — no upright/reversed badge printed.
   Two styles ship; the user switches at the table via the
   "Deck" button (choice persists in localStorage):
     'veil'   — Gossamer Veil   薄纱银线 · indigo ground, twin hairline
                frame with corner points, silverline emblem
     'orrery' — Astral Orrery   星象仪 · suit-tinted ground, dotted
                orbit ring behind the emblem, corner star ticks
   ══════════════════════════════════════════════════════════════ */
var TAROT_FACE_STYLE=(function(){try{var v=localStorage.getItem('ibTarotFaceStyle');return(v==='veil'||v==='orrery')?v:'veil'}catch(e){return 'veil'}})();

/* ── emblem geometry helpers（正多角星/轮辐等规则形在运行时精确生成） ── */
function _tsxStar(cx,cy,rO,rI,n,rot){
  var pts=[],a0=(rot||0)-Math.PI/2;
  for(var i=0;i<n*2;i++){var r=i%2?rI:rO,a=a0+i*Math.PI/n;pts.push((cx+r*Math.cos(a)).toFixed(2)+','+(cy+r*Math.sin(a)).toFixed(2))}
  return '<polygon points="'+pts.join(' ')+'"/>';
}
function _tsxRays(cx,cy,r0,r1,n,rot){
  var d='',a0=rot||0;
  for(var i=0;i<n;i++){var a=a0+i*2*Math.PI/n;
    d+='M'+(cx+r0*Math.cos(a)).toFixed(2)+' '+(cy+r0*Math.sin(a)).toFixed(2)
      +'L'+(cx+r1*Math.cos(a)).toFixed(2)+' '+(cy+r1*Math.sin(a)).toFixed(2)+' ';}
  return '<path d="'+d.trim()+'"/>';
}

/* ── suit emblems（小阿卡纳：花色线徽） ── */
var _TSX_SUIT={
  Wands:'<path d="M6.5 19.5 L17.5 4.5"/><path d="M14.2 5.4 l3.4-1.6"/><path d="M15.8 8.4 l3.2-1.3"/><path d="M8.2 14.6 l-2.6-1.2"/>',
  Cups:'<path d="M6.8 5 h10.4"/><path d="M7.8 5 c0 4.4 2.5 6.6 4.2 6.6 s4.2-2.2 4.2-6.6"/><path d="M12 11.6 v5.2"/><path d="M9 19.4 h6"/><path d="M12 16.8 v2.6"/>',
  Swords:'<path d="M12 3 v13.2"/><path d="M9.5 6.2 L12 3 l2.5 3.2"/><path d="M7.8 16.2 h8.4"/><path d="M12 16.2 v4"/><path d="M10.5 20.2 h3"/>',
  Pentacles:'<circle cx="12" cy="12" r="8.2"/>'+ _tsxStar(12,12,6.1,2.35,5,0)
};
/* ── major arcana emblems（大阿卡纳 22 徽，按 MAJOR_ARCANA 序） ── */
var _TSX_MAJOR=[
  /* 0 Fool — bindle & road */'<path d="M7 17.2 L15 6.8"/><circle cx="16.6" cy="5.6" r="2.3"/><path d="M5 19.6 h9.4"/>',
  /* I Magician — lemniscate */'<path d="M7 12 c0-2.7 3.4-2.7 5 0 c1.6 2.7 5 2.7 5 0 c0-2.7-3.4-2.7-5 0 c-1.6 2.7-5 2.7-5 0 Z"/>',
  /* II High Priestess — pillars & veil */'<path d="M7 4.8 v14.4"/><path d="M17 4.8 v14.4"/><path d="M7 8.2 C9.6 11 14.4 11 17 8.2"/><circle cx="12" cy="5.8" r="1.5"/>',
  /* III Empress — venus */'<circle cx="12" cy="9" r="4.6"/><path d="M12 13.6 v6.4"/><path d="M9.2 16.8 h5.6"/>',
  /* IV Emperor — aries sceptre */'<path d="M12 4.6 v14.8"/><path d="M12 8.4 C10.8 4.8 6.6 5 6.6 8.2 c0 2 1.6 3.1 3.3 2.7"/><path d="M12 8.4 C13.2 4.8 17.4 5 17.4 8.2 c0 2-1.6 3.1-3.3 2.7"/>',
  /* V Hierophant — key */'<circle cx="12" cy="7" r="3"/><path d="M12 10 v9.6"/><path d="M12 15.2 h3"/><path d="M12 18.4 h3.8"/>',
  /* VI Lovers — bound rings */'<circle cx="9.3" cy="12" r="4.5"/><circle cx="14.7" cy="12" r="4.5"/>',
  /* VII Chariot — winged wheel */'<circle cx="12" cy="13.6" r="4.4"/>'+_tsxRays(12,13.6,1.1,4.4,4,Math.PI/4)+'<path d="M7.4 10.4 C5 8.8 3.8 6.8 4.2 4.8"/><path d="M16.6 10.4 C19 8.8 20.2 6.8 19.8 4.8"/>',
  /* VIII Strength — open hand */'<path d="M9 20 v-6.6"/><path d="M11 20 v-8.6"/><path d="M13 20 v-8.6"/><path d="M15 20 v-6.6"/><path d="M9 13.4 c0-2.2 1.1-3.4 3-3.4 s3 1.2 3 3.4"/><path d="M9 20 h6"/>',
  /* IX Hermit — lantern */'<path d="M9 8.4 h6 v6.8 h-6 Z"/><path d="M12 4.4 v4"/><path d="M10.4 15.2 v2.6 h3.2 v-2.6"/><circle cx="12" cy="11.8" r="1.15"/>',
  /* X Wheel */'<circle cx="12" cy="12" r="7.6"/>'+_tsxRays(12,12,1.4,7.6,6,0)+'<circle cx="12" cy="12" r="1.4"/>',
  /* XI Justice — scales */'<path d="M12 4.4 v13.6"/><path d="M8.4 20 h7.2"/><path d="M5.4 8 h13.2"/><path d="M7.3 8 L4.7 11.5"/><path d="M7.3 8 L9.9 11.5"/><path d="M4.5 11.5 a2.85 2.85 0 0 0 5.5 0"/><path d="M16.7 8 L14.1 11.5"/><path d="M16.7 8 L19.3 11.5"/><path d="M14 11.5 a2.85 2.85 0 0 0 5.5 0"/>',
  /* XII Hanged Man */'<path d="M6.4 4.8 h11.2"/><path d="M12 4.8 v4.6"/><circle cx="12" cy="16.8" r="2.15"/><path d="M12 9.4 v5.2"/><path d="M10 11 L13.8 13.6"/>',
  /* XIII Death — scythe */'<path d="M7.6 20 L15.2 4.6"/><path d="M14.4 4.9 C18.8 3.6 21.2 6.4 20.6 9.6 C18.7 6.8 16.4 6.2 13.6 6.9"/>',
  /* XIV Temperance — two vessels */'<path d="M5.6 6.4 h5.2"/><path d="M6.3 6.4 c0 2.6 1.5 4 2.7 4 s2.5-1.4 2.5-4"/><path d="M13.2 13.6 h5.2"/><path d="M13.9 13.6 c0 2.6 1.5 4 2.7 4 s2.5-1.4 2.5-4"/><path d="M9.6 10.8 C11.6 11.9 12.8 12.9 14.2 13.4"/>',
  /* XV Devil — inverted star */_tsxStar(12,12,7.4,2.85,5,Math.PI),
  /* XVI Tower */'<path d="M9 20 V8.2 h6 V20"/><path d="M8 8.2 h8"/><path d="M9.7 5.6 L12 8.2 L14.3 5.6"/><path d="M6.2 3.4 L9.6 8 H7.2 L10.6 12.8"/>',
  /* XVII Star */_tsxRays(12,12,0,8.2,4,0)+_tsxRays(12,12,0,4.6,4,Math.PI/4)+'<circle cx="18" cy="5.4" r="0.95"/>',
  /* XVIII Moon — crescent & dew */'<path d="M14.6 4.2 A8.1 8.1 0 1 0 14.6 19.8 A6.5 6.5 0 1 1 14.6 4.2 Z"/><circle cx="18.6" cy="9" r="0.8"/><circle cx="19.6" cy="12.4" r="0.8"/><circle cx="18.6" cy="15.8" r="0.8"/>',
  /* XIX Sun */'<circle cx="12" cy="12" r="4.4"/>'+_tsxRays(12,12,6,8.6,8,0),
  /* XX Judgement — trumpet */'<path d="M5.8 11.2 L15.4 6.2 V15.4 L5.8 12.8 Z"/><path d="M15.4 8 c2 .4 3.1 1.7 3.1 3 s-1.1 2.6-3.1 3"/><path d="M20.4 8.4 l1.7-1"/><path d="M21 11.2 h2"/><path d="M20.4 14 l1.7 1"/>',
  /* XXI World — laurel oval */'<path d="M12 3.6 C7 3.6 4.4 7.8 4.4 12 s2.6 8.4 7.6 8.4 7.6-4.2 7.6-8.4 S17 3.6 12 3.6 Z"/><path d="M6.4 6.6 l-1.7-1.2"/><path d="M17.6 6.6 l1.7-1.2"/><path d="M6.4 17.4 l-1.7 1.2"/><path d="M17.6 17.4 l1.7 1.2"/><circle cx="12" cy="12" r="1.05"/>'
];

function _tsxGlyphSVG(card,extra){
  var inner=card.type==='major'?_TSX_MAJOR[card.mi]:_TSX_SUIT[card.suit.en];
  return '<svg class="tsx-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"'+(extra||'')+'>'+inner+'</svg>';
}
/* 花色浅调（正文/线条着色用，majors 用各风格默认银/金） */
var _TSX_SUIT_INK={Wands:'#e0b8a8',Cups:'#b8c8ec',Swords:'#c4cadc',Pentacles:'#e0cf9a'};

/* ── 牌面构建：三风格共用一个入口 ── */
function buildTarotFaceHTML(card,reversed){
  var st=TAROT_FACE_STYLE;
  var isMajor=card.type==='major';
  var numStr=isMajor?card.num:card.rank.num;
  var name=isMajor?card.en:card.rank.en;                 /* e.g. "The Star" / "Seven" */
  var sub=isMajor?'':'of '+card.suit.en;                 /* minors second line */
  var ink=isMajor?'':(_TSX_SUIT_INK[card.suit.en]||'');
  var tint=isMajor?'':card.suit.color;
  var body='';
  if(st==='orrery'){
    body='<div class="tsx-num">'+numStr+'</div>'
        +'<div class="tsx-orbit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.55"><circle cx="12" cy="12" r="10.4" stroke-dasharray="0.1 2.1" stroke-linecap="round"/></svg>'+_tsxGlyphSVG(card)+'</div>'
        +'<div class="tsx-name">'+name+(sub?'<span class="tsx-sub">'+sub+'</span>':'')+'</div>';
  }else{ /* veil */
    body='<div class="tsx-num">'+numStr+'</div>'
        +_tsxGlyphSVG(card)
        +'<div class="tsx-name">'+name+(sub?'<span class="tsx-sub">'+sub+'</span>':'')+'</div>';
  }
  return '<div class="tarot-slot-card tsx tsx-'+st+(isMajor?' tsx-major':' tsx-minor')+' show'+(reversed?' reversed':'')+'"'
        +(tint?' style="--tsx-tint:'+tint+';--tsx-ink:'+ink+'"':'')+'>'
        +'<div class="tsx-face"><div class="tsx-frame"></div>'+body+'</div></div>';
}


/* ── TAROT SPREADS ──────────────────────────────────────── */
const TAROT_SPREADS = [
  {id:'free',    name:'无牌阵',   nameEn:'Free',     desc:'自由抽牌',                   maxCards:3, slots:[]},
  {id:'single',  name:'单牌',     nameEn:'Single',   desc:'此刻的指引',                 slots:[{label:'此刻'}]},
  {id:'timeline',name:'时间之流', nameEn:'Timeline', desc:'过去 · 现在 · 未来',          slots:[{label:'过去'},{label:'现在'},{label:'未来'}]},
  {id:'cross',   name:'十字',     nameEn:'Cross',    desc:'处境 · 障碍 · 建议 · 结果',   slots:[{label:'处境'},{label:'障碍'},{label:'建议'},{label:'结果'}]},
  {id:'star',    name:'命运之星', nameEn:'Star',     desc:'现状 · 挑战 · 根源 · 未来 · 潜力', slots:[{label:'现状'},{label:'挑战'},{label:'根源'},{label:'未来'},{label:'潜力'}]}
];


function getTarotGuideHTML(companionLine){
  const status=companionLine||'你开始独自使用塔罗占卜……\n\n';
  return status+'Sui：欢迎使用占卜桌。\n\n点击上方「选择陪你占卜的TA」邀请一位解读者。\n\n点击下方的「Deck」可以切换塔罗牌的款式：Gossamer Veil ⇄ Astral Orrery。\n\n上方的按钮可以切换牌阵：\n· 无牌阵 — 自由抽1~3张，没有固定含义\n· 单牌 — 1张，代表此刻的指引\n· 时间之流 — 3张：过去、现在、未来\n· 十字 — 4张：处境、障碍、建议、结果\n· 命运之星 — 5张：现状、挑战、根源、未来、潜力\n\n勾选「＋指引牌」可以多抽一张作为额外的指引。\n\n左边散开的牌就是78张塔罗牌。\n点一张，它会飞到下方的牌位上，自动翻面。\n\n牌位填满后，点击下方的「Invite AI」让TA为你解读。\n\n解读完成后可以：\n· Reshuffle — 全部重来\n· 追问 — 补充你的问题，让TA说更多（最多3次）\n· 存档 — 保存到密码日记本\n· Exit — 离开\n\n在心里默念你的问题，然后选一张牌吧。'
}

/* ── CRYSTAL BALL / TAROT ────────────────────────────── */
function interactCrystal(){
  showDialogue('Sui',[FIXED_LINES.crystal_intro],()=>{
    closeDialogue();
    openTarot();
  });
}

function openTarot(){
  if(!G.viewport){G.state='idle';return}
  G.tarotOpen=true;
  const panel=G.viewport.querySelector('#game-tarot');
  if(!panel){G.state='idle';G.tarotOpen=false;return}

  /* Auto-select first API if available */
  initTarotState(null);
  renderTarotUI(panel);
  panel.classList.add('show');
}

function initTarotState(cfg){
  G._tarot={
    spread:TAROT_SPREADS[1],guide:false,slots:[],totalSlots:1,deck:[],
    phase:'pick',readingText:'',cfg:cfg,freeCount:0,followupLeft:3,
    sessionLog:[]
  };
  const indices=[...Array(TAROT_DECK.length).keys()];
  for(let i=indices.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[indices[i],indices[j]]=[indices[j],indices[i]]}
  G._tarot.deck=indices;
}

/* Log a user action to the tarot session log and display it in the reading panel */
function logTarotAction(msg){
  var t=G._tarot;if(!t)return;
  t.sessionLog.push({type:'action',text:msg,time:Date.now()});
  /* Append to reading panel as centered styled entry */
  if(!G.viewport)return;
  var rp=G.viewport.querySelector('#tarot-reading-panel');
  if(rp){
    var el=document.createElement('div');
    el.className='tarot-action-log';
    el.textContent='【'+msg+'】';
    rp.appendChild(el);
    rp.scrollTop=rp.scrollHeight;
  }
}

function renderTarotUI(panel){
  const t=G._tarot;
  const spreadBtns=TAROT_SPREADS.map(s=>
    `<button class="tarot-spread-opt${s.id===t.spread.id?' active':''}" data-sid="${s.id}">${s.name}</button>`
  ).join('');

  panel.innerHTML=`
    <div class="tarot-spread-bar" id="tarot-spread-bar">${spreadBtns}</div>
    <div class="tarot-top-row">
      <div class="tarot-spread-desc" id="tarot-spread-desc">${t.spread.desc}</div>
      <label class="tarot-guide-toggle"><input type="checkbox" id="tarot-guide-cb"${t.guide?' checked':''}> ＋指引牌</label>
      <button class="tarot-spread-opt" id="tarot-change-ai" style="font-size:0.82rem;padding:5px 16px">${t.cfg?escapeHtml(t.cfg.nickname||t.cfg.model||'AI'):'✦ 选择陪你占卜的TA'}</button>
    </div>
    <div class="tarot-body">
      <div class="tarot-left">
        <div class="tarot-fan" id="tarot-fan"></div>
        <div class="tarot-slots-wrap" id="tarot-slots"></div>
      </div>
      <div class="tarot-right">
        <div class="tarot-reading-panel" id="tarot-reading-panel">
          ${getTarotGuideHTML(t.cfg?escapeHtml(t.cfg.nickname||t.cfg.model||'AI')+' 正在陪你一起使用塔罗占卜……\n\n':'')}
        </div>
        <div id="tarot-followup-wrap"></div>
      </div>
    </div>
    <div class="tarot-actions" id="tarot-actions">
      <button class="tarot-btn" id="tarot-exit">Exit</button>
    </div>`;

  /* Spread selection */
  panel.querySelectorAll('.tarot-spread-opt').forEach(btn=>{
    btn.addEventListener('click',()=>{
      if(t.phase!=='pick')return;
      const sp=TAROT_SPREADS.find(s=>s.id===btn.dataset.sid);
      if(!sp)return;
      t.spread=sp; t.slots=[]; t.freeCount=0;
      logTarotAction('你选择了「'+sp.name+'」牌阵……');
      updateTarotSlots(panel);
      panel.querySelectorAll('.tarot-spread-opt').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      panel.querySelector('#tarot-spread-desc').textContent=sp.desc;
      panel.querySelectorAll('.tarot-fan-card').forEach(c=>c.classList.remove('picked'));
    });
  });

  panel.querySelector('#tarot-guide-cb').addEventListener('change',(e)=>{
    if(t.phase!=='pick')return;
    t.guide=e.target.checked; t.slots=[]; t.freeCount=0;
    logTarotAction(t.guide?'你增加了指引牌……':'你取消了指引牌……');
    updateTarotSlots(panel);
    panel.querySelectorAll('.tarot-fan-card').forEach(c=>c.classList.remove('picked'));
  });

  /* Change AI companion button */
  const changeAiBtn=panel.querySelector('#tarot-change-ai');
  {
    changeAiBtn.addEventListener('click',()=>{
      const esc2=(typeof escapeHtml==='function')?escapeHtml:(s=>String(s));
      const hasApis=typeof apiConfigs!=='undefined'&&apiConfigs.length>0;
      const rp=panel.querySelector('#tarot-reading-panel');
      if(!hasApis){
        var noapi=document.createElement('div');noapi.className='tarot-action-log';noapi.textContent='【还没有配置API。请在 API Settings 页面添加后再来。】';rp.appendChild(noapi);rp.scrollTop=rp.scrollHeight;
        return;
      }
      /* Show API selection as floating overlay on top of reading panel */
      var selDiv=document.createElement('div');selDiv.id='tarot-ai-sel-overlay';
      selDiv.style.cssText='position:absolute;inset:0;z-index:5;background:rgba(18,18,38,0.92);display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px;overflow-y:auto;border-radius:8px';
      selDiv.innerHTML='<div style="font-family:Noto Serif SC,serif;font-size:0.92rem;color:rgba(220,215,240,0.6)">请选择陪你使用塔罗占卜的TA…</div>'+apiConfigs.map(a=>'<button class="tarot-followup-opt" data-caid="'+a.id+'" style="width:100%;padding:10px 16px;font-size:0.88rem">'+esc2(a.nickname||a.model||'AI')+'</button>').join('');
      var rpWrap=rp.parentElement;if(rpWrap)rpWrap.style.position='relative';
      rpWrap.appendChild(selDiv);
      selDiv.querySelectorAll('[data-caid]').forEach(btn=>{
        btn.addEventListener('click',()=>{
          const cfg2=apiConfigs.find(a=>a.id===btn.dataset.caid);
          if(cfg2){
            t.cfg=cfg2;
            changeAiBtn.textContent=cfg2.nickname||cfg2.model||'AI';/* BUGFIX: textContent 不需要预转义 */
            logTarotAction('你选择了'+(cfg2.nickname||cfg2.model||'AI')+'陪你占卜……');/* BUGFIX: logTarotAction 用 textContent 渲染且写入存档，传原文即可 */
            var welcome=document.createElement('div');welcome.style.cssText='padding:6px 0';
            welcome.textContent=(cfg2.nickname||cfg2.model||'AI')+' 正在陪你一起使用塔罗占卜……\nSui：欢迎你们使用占卜桌。如果TA需要再看一次操作教程，可以向上翻阅。';
            welcome.style.whiteSpace='pre-wrap';
            rp.appendChild(welcome);rp.scrollTop=rp.scrollHeight;
          }
          selDiv.remove();
        });
      });
    });
  }

  generateTarotFan(panel);
  updateTarotSlots(panel);/* 内部会重建按钮行并绑定 Exit 等全部按钮，此处不再重复绑定（修复 Exit 双重绑定） */
}

function getTarotTotalSlots(){
  const t=G._tarot;
  let total=t.spread.id==='free'?t.spread.maxCards:t.spread.slots.length;
  if(t.guide)total++;
  return total;
}

function updateTarotSlots(panel){
  const t=G._tarot;
  const total=getTarotTotalSlots();
  t.totalSlots=total;
  const wrap=panel.querySelector('#tarot-slots');
  let labels=[];
  if(t.spread.id==='free'){for(let i=0;i<t.spread.maxCards;i++)labels.push('')}
  else{labels=t.spread.slots.map(s=>s.label)}
  if(t.guide)labels.push('指引');

  const items=[];
  for(let i=0;i<labels.length;i++){
    const filled=t.slots[i];
    const cls='tarot-slot-item'+(filled?' filled':'');
    let inner='';
    if(filled){
      /* Vergelight Arcana：逆位以整面倒置呈现，不再印正/逆徽标（AI 解读提示词仍携带正逆信息） */
      inner=buildTarotFaceHTML(filled.card,filled.reversed);
    }else{
      inner='<span style="font-size:1.4rem;color:rgba(160,140,200,0.18)">✦</span>';
    }
    items.push(`<div style="display:flex;flex-direction:column;align-items:center"><div class="${cls}" data-slot="${i}">${inner}</div><div class="tarot-slot-label">${labels[i]||''}</div></div>`);
  }
  wrap.innerHTML=items.join('');
  updateTarotActions(panel);
}

function generateTarotFan(panel){
  const fan=panel.querySelector('#tarot-fan');
  if(!fan)return;
  const fanW=fan.clientWidth;
  if(!fanW){ requestAnimationFrame(()=>generateTarotFan(panel)); return; }   /* panel not laid out yet — retry once visible */
  const total=TAROT_DECK.length;
  /* Chosen fan form: a wide, shallow 110° arc. Cards are drawn at the slot size
     (115×178) and the whole fan is sized to the live layout so it spans most of the
     width, sits just above the slot row, and never rises over the top bar.
     The slot row itself is untouched. */
  const cardW=115, cardH=178;                       /* card size = slot size */
  const spreadDeg=110;                              /* fan angle (form A) */
  const startDeg=-spreadDeg/2;
  const ea=(spreadDeg/2)*Math.PI/180;
  const halfW=fanW/2;
  const leanX=(cardW/2)*Math.cos(ea)+cardH*Math.sin(ea);   /* sideways reach of a tilted edge card */
  const Rx=Math.max(60,(halfW*0.98-leanX)/Math.sin(ea));   /* widen to fill ~the whole width, no side clip */
  let Ry=Rx*0.5327;                                 /* arc shape of preview A (wider than tall) */
  let upRoom=160;                                   /* empty space above the fan box, within .tarot-left */
  try{
    const lr=fan.parentElement.getBoundingClientRect();
    const fr=fan.getBoundingClientRect();
    upRoom=Math.max(80,fr.top-lr.top);
  }catch(e){}
  const LOW=12;                                     /* lowest card ≈12px above fan-box bottom → tidy gap to slots */
  const topMax=240+upRoom-6;                        /* keep the top under the bar */
  const rawExt=(ry)=>{
    let top=-1e9,bot=1e9;
    for(let i=0;i<total;i++){
      const ang=startDeg+(i/(total-1))*spreadDeg, r=ang*Math.PI/180, ct=Math.cos(r), st=Math.sin(r), yB=ct*ry;
      const cs=[[-cardW/2,0],[cardW/2,0],[-cardW/2,cardH],[cardW/2,cardH]];
      for(let k=0;k<4;k++){ const Y=yB+(-cs[k][0]*st+cs[k][1]*ct); if(Y>top)top=Y; if(Y<bot)bot=Y; }
    }
    return [top,bot];
  };
  let ext=rawExt(Ry);
  if(LOW+(ext[0]-ext[1])>topMax && (ext[0]-ext[1])>0){ Ry*=Math.max(0.3,(topMax-LOW)/(ext[0]-ext[1])); ext=rawExt(Ry); }
  const pivotY=LOW-ext[1];                           /* drop the fan so its lowest card sits just above the slots */
  let html='';
  for(let i=0;i<total;i++){
    const u=i/(total-1);                       /* 0..1 */
    const ang=startDeg+u*spreadDeg;            /* fan angle */
    const rad=ang*Math.PI/180;
    const x=Math.sin(rad)*Rx;                  /* horizontal offset of the base from center */
    const yBottom=pivotY+Math.cos(rad)*Ry;     /* base height above fan bottom */
    html+=`<div class="tarot-fan-card" data-idx="${i}" style="left:calc(50% + ${x.toFixed(1)}px - ${(cardW/2).toFixed(1)}px);bottom:${yBottom.toFixed(1)}px;--rot:${ang.toFixed(1)}deg;z-index:${i}">✦</div>`;
  }
  fan.innerHTML=html;
  /* 悬停/点击共用的基准几何：以生成时的布局盒中心为准，抬升变换不影响判定，从根上消除悬停振荡 */
  fan._centers=Array.from(fan.querySelectorAll('.tarot-fan-card')).map(el=>({el,x:el.offsetLeft+cardW/2,y:el.offsetTop+cardH/2}));
  const nearestFanCard=(clientX,clientY)=>{
    const r=fan.getBoundingClientRect();
    const px=clientX-r.left,py=clientY-r.top;
    let best=null,bestD=Infinity;
    for(const c of (fan._centers||[])){
      if(c.el.classList.contains('picked'))continue;
      const dx=px-c.x,dy=py-c.y,d=dx*dx+dy*dy;
      if(d<bestD){bestD=d;best=c.el;}
    }
    return {el:best,d:Math.sqrt(bestD)};
  };
  /* 容器级"就近取牌"：点扇形区任意位置取最接近的未抽出牌，且与悬停抬起的是同一张 */
  if(!fan._pickBound){
    fan._pickBound=true;
    fan.addEventListener('click',(e)=>{
      if(!G._tarot||G._tarot.phase!=='pick')return;
      const hit=nearestFanCard(e.clientX,e.clientY);
      if(hit.el){hit.el.classList.remove('lift');pickTarotCard(panel,parseInt(hit.el.dataset.idx),hit.el);}
    });
    /* 悬停抬牌：requestAnimationFrame 合帧；卡片沿自身轴线抽出并微正立，过渡曲线平缓 */
    let _hraf=0,_hx=0,_hy=0;
    const applyLift=()=>{
      _hraf=0;
      if(!G._tarot||G._tarot.phase!=='pick'){fan.querySelectorAll('.tarot-fan-card.lift').forEach(c=>c.classList.remove('lift'));return}
      const hit=nearestFanCard(_hx,_hy);
      const target=(hit.el&&hit.d<=130)?hit.el:null;
      fan.querySelectorAll('.tarot-fan-card.lift').forEach(c=>{if(c!==target)c.classList.remove('lift')});
      if(target)target.classList.add('lift');
    };
    fan.addEventListener('pointermove',(e)=>{
      if(e.pointerType&&e.pointerType!=='mouse')return;
      _hx=e.clientX;_hy=e.clientY;
      if(!_hraf)_hraf=requestAnimationFrame(applyLift);
    });
    fan.addEventListener('pointerleave',()=>{
      if(_hraf){cancelAnimationFrame(_hraf);_hraf=0}
      fan.querySelectorAll('.tarot-fan-card.lift').forEach(c=>c.classList.remove('lift'));
    });
  }
}

function pickTarotCard(panel,deckIdx,fanEl){
  const t=G._tarot;
  const total=getTarotTotalSlots();
  const filledCount=t.slots.filter(Boolean).length;
  if(filledCount>=total)return;

  let slotIdx=-1;
  for(let i=0;i<total;i++){if(!t.slots[i]){slotIdx=i;break}}
  if(slotIdx<0)return;

  const cardIndex=t.deck[deckIdx];
  const card=TAROT_DECK[cardIndex];
  const reversed=Math.random()<0.5;
  logTarotAction('你抽到了 '+card.display+'（'+(reversed?'逆位':'正位')+'）……');
  fanEl.classList.add('picked');

  const panelRect=panel.getBoundingClientRect();
  const fanRect=fanEl.getBoundingClientRect();
  const slotEl=panel.querySelectorAll('.tarot-slot-item')[slotIdx];
  const slotRect=slotEl.getBoundingClientRect();

  const flyer=document.createElement('div');
  flyer.className='tarot-flying';
  flyer.textContent='✦';
  flyer.style.left=(fanRect.left-panelRect.left)+'px';
  flyer.style.top=(fanRect.top-panelRect.top)+'px';
  panel.appendChild(flyer);

  requestAnimationFrame(()=>{
    flyer.style.left=(slotRect.left-panelRect.left)+'px';
    flyer.style.top=(slotRect.top-panelRect.top)+'px';
    flyer.style.width='115px';
    flyer.style.height='178px';
    flyer.style.borderRadius='9px';
  });

  setTimeout(()=>{
    flyer.remove();
    t.slots[slotIdx]={card,reversed};
    if(t.spread.id==='free')t.freeCount++;
    updateTarotSlots(panel);
  },580);
}

function updateTarotActions(panel){
  const t=G._tarot;
  const actWrap=panel.querySelector('#tarot-actions');
  const filledCount=t.slots.filter(Boolean).length;
  const total=getTarotTotalSlots();

  if(t.phase==='pick'){
    const allFilled=filledCount>=total;
    const canFinish=t.spread.id==='free'&&filledCount>=1;
    let btns='<button class="tarot-btn" id="tarot-reshuffle">Reshuffle</button>';
    if(allFilled||canFinish){
      btns+='<button class="tarot-btn" id="tarot-interpret">Invite AI</button>';
      if(canFinish&&!allFilled)btns+='<button class="tarot-btn" id="tarot-done-free">完成选牌</button>';
    }
    btns+='<button class="tarot-btn" id="tarot-deck" title="切换塔罗牌款式">Deck</button>';
    btns+='<button class="tarot-btn" id="tarot-save">Save</button>';
    btns+='<button class="tarot-btn" id="tarot-exit">Exit</button>';
    actWrap.innerHTML=btns;
    actWrap.querySelector('#tarot-deck')?.addEventListener('click',()=>switchTarotDeckStyle(panel));
    actWrap.querySelector('#tarot-reshuffle')?.addEventListener('click',()=>{logTarotAction('你重置了牌阵……');resetTarot(panel)});
    actWrap.querySelector('#tarot-exit')?.addEventListener('click',()=>{closeTarot();G.state='idle'});
    actWrap.querySelector('#tarot-save')?.addEventListener('click',()=>saveTarotReading());
    actWrap.querySelector('#tarot-done-free')?.addEventListener('click',()=>{if(t.cfg)runTarotInterpret(panel,t.cfg);else{if(typeof toast==='function')toast('请先点击顶部「选择陪你占卜的TA」选择一位解读者')}});
    actWrap.querySelector('#tarot-interpret')?.addEventListener('click',()=>{if(t.cfg)runTarotInterpret(panel,t.cfg);else{if(typeof toast==='function')toast('请先点击顶部「选择陪你占卜的TA」选择一位解读者')}});
  }else if(t.phase==='reading'||t.phase==='followup'){
    let btns='<button class="tarot-btn" id="tarot-reshuffle">Reshuffle</button>';
    if(t.followupLeft>0) btns+='<button class="tarot-btn" id="tarot-followup-btn">追问</button>';
    btns+='<button class="tarot-btn" id="tarot-deck" title="切换塔罗牌款式">Deck</button>';
    btns+='<button class="tarot-btn" id="tarot-save">Save</button>';
    btns+='<button class="tarot-btn" id="tarot-exit">Exit</button>';
    actWrap.innerHTML=btns;
    actWrap.querySelector('#tarot-deck')?.addEventListener('click',()=>switchTarotDeckStyle(panel));
    actWrap.querySelector('#tarot-reshuffle')?.addEventListener('click',()=>{logTarotAction('你重置了牌阵……');resetTarot(panel)});
    actWrap.querySelector('#tarot-exit')?.addEventListener('click',()=>{closeTarot();G.state='idle'});
    actWrap.querySelector('#tarot-save')?.addEventListener('click',()=>saveTarotReading());
    actWrap.querySelector('#tarot-followup-btn')?.addEventListener('click',()=>showTarotFollowup(panel));
  }
}

/* ── Deck 按钮：切换牌面款式（Vergelight Arcana：veil ⇄ orrery）──
   选择写入 localStorage 持久化；桌面上已抽出的牌即时换装；
   切换动作同步写进右侧记录（logTarotAction 会同时进入 sessionLog，随存档保存） */
function switchTarotDeckStyle(panel){
  TAROT_FACE_STYLE=TAROT_FACE_STYLE==='veil'?'orrery':'veil';
  try{localStorage.setItem('ibTarotFaceStyle',TAROT_FACE_STYLE)}catch(e){}
  var deckName=TAROT_FACE_STYLE==='veil'?'Gossamer Veil':'Astral Orrery';
  logTarotAction('你已切换塔罗牌组为：「'+deckName+'」……');
  updateTarotSlots(panel);/* 内部会顺带重建按钮行并重新绑定 */
}

async function runTarotInterpret(panel,cfg){
  const t=G._tarot;
  t.cfg=cfg;
  t.phase='reading';
  const fan=panel.querySelector('#tarot-fan');
  if(fan)fan.style.display='none';
  /* Hide spread bar in reading mode */
  const sbar=panel.querySelector('#tarot-spread-bar');if(sbar)sbar.style.display='none';
  const trow=panel.querySelector('.tarot-top-row');if(trow)trow.style.display='none';

  const drawnCards=t.slots.filter(Boolean);
  const spreadName=t.spread.name+(t.guide?' + 指引牌':'');
  let cardsDesc=drawnCards.map((s,i)=>{
    const pos=s.reversed?'逆位':'正位';
    const name=s.card.display;
    let label='';
    if(t.spread.id==='free'){label='第'+(i+1)+'张'}
    else{
      const slotLabels=[...t.spread.slots.map(sl=>sl.label)];
      if(t.guide)slotLabels.push('指引');
      label=slotLabels[i]||'';
    }
    return (label?label+'：':'')+name+'（'+pos+'）';
  }).join('\n');

  /* Get user name for prompt */
  let userName='对方';
  try{const about=await dbGet('about','main');if(about&&about.name)userName=about.name}catch(e){}

  const tarotBase='你是一位塔罗占卜师。请为你眼前的至亲之人来解读塔罗牌。\n你的解读风格客观、诚实，又不失亲和力。';
  const relPrefix=cfg.relationship?'你和对方的关系是：'+cfg.relationship+'。\n':'';
  const sysPrompt=(cfg.systemPrompt?cfg.systemPrompt+'\n\n':'')+relPrefix+tarotBase;
  /* 注入记忆 */
  let tarotSys=sysPrompt;
  if(typeof getMemoryContext==='function'){
    try{const memCtx=await getMemoryContext(cfg.id,{maxChars:800});if(memCtx)tarotSys+='\n\n'+memCtx}catch(e){}
  }
  const userPrompt=`用户使用「${spreadName}」牌阵进行了塔罗占卜：\n${cardsDesc}\n\n请综合这${drawnCards.length}张牌的位置含义和正逆位，给出占卜解读。使用中文，200字以内。`;

  const readPanel=panel.querySelector('#tarot-reading-panel');
  var loadDiv=document.createElement('div');loadDiv.id='tarot-loading-div';loadDiv.style.cssText='text-align:center;padding:20px;opacity:0.4';loadDiv.textContent='✦ 正在解读…';readPanel.appendChild(loadDiv);readPanel.scrollTop=readPanel.scrollHeight;
  logTarotAction('你询问了'+(cfg.nickname||cfg.model||'AI')+'如何解读……');/* BUGFIX: 同上，避免双重转义进入存档 */
  updateTarotActions(panel);

  try{
    const aiName=cfg.nickname||cfg.model||'AI';
    const reply=_isStreamEnabled(cfg)?await callApiChatStream(cfg,[{role:'system',content:tarotSys},{role:'user',content:userPrompt}]):await callApiChat(cfg,[{role:'system',content:tarotSys},{role:'user',content:userPrompt}]);
    t.readingText=reply||'';
    if(!t.readingText){t.readingText='API没有反应…请尝试重新解读。'}
    t._aiName=aiName;
    t._history=[{role:'system',content:tarotSys},{role:'user',content:userPrompt},{role:'assistant',content:t.readingText}];
    /* Log AI reading to session */
    t.sessionLog.push({type:'ai-reading',text:t.readingText,time:Date.now()});
    var ld=readPanel.querySelector('#tarot-loading-div');if(ld)ld.remove();
    var rdiv=document.createElement('div');rdiv.style.cssText='padding:8px 0;border-top:1px solid rgba(160,140,200,0.06);margin-top:6px';rdiv.textContent=aiName+'：'+t.readingText;/* BUGFIX: textContent 本身不解析 HTML，先 escapeHtml 会把 & < > 显示成 &amp; 等实体 */readPanel.appendChild(rdiv);readPanel.scrollTop=readPanel.scrollHeight;
  }catch(e){
    t.phase='pick';
    let errMsg='连接遇到了问题';
    if(e.message){
      if(e.message.includes('超时'))errMsg='请求超时，请检查网络';
      else if(e.message.includes('401'))errMsg='API Key 无效';
      else if(e.message.includes('429'))errMsg='请求频率过高，请稍后再试';
      else errMsg=e.message;
    }
    readPanel.innerHTML='<div style="text-align:center;padding:20px"><div style="opacity:0.6;margin-bottom:12px">'+escapeHtml(errMsg)+'</div><button class="tarot-btn" id="tarot-retry">重试</button></div>';
    panel.querySelector('#tarot-retry')?.addEventListener('click',()=>{
      if(fan)fan.style.display='';
      if(sbar)sbar.style.display='';
      if(trow)trow.style.display='';
      readPanel.innerHTML=getTarotGuideHTML(G._tarot&&G._tarot.cfg?escapeHtml(G._tarot.cfg.nickname||G._tarot.cfg.model||'AI')+' 正在陪你一起使用塔罗占卜……\n\n':'');
      updateTarotActions(panel);
    });
  }
  /* Show follow-up count */
  const fwWrap=panel.querySelector('#tarot-followup-wrap');
  fwWrap.innerHTML=`<div class="tarot-followup-section"><div class="tarot-followup-count">剩余追问 ${t.followupLeft} 次</div></div>`;
  updateTarotActions(panel);
}

function showTarotFollowup(panel){
  const t=G._tarot;
  if(t.followupLeft<=0)return;
  t.phase='followup';
  const wrap=panel.querySelector('#tarot-followup-wrap');
  wrap.innerHTML=`<div class="tarot-followup-section">
    <input class="tarot-followup-input" id="tarot-fu-input" placeholder="补充你的问题（选填）…">
    <div class="tarot-followup-opts">
      <button class="tarot-followup-opt" data-ft="detail">希望TA解说得更详细</button>
      <button class="tarot-followup-opt" data-ft="summary">希望TA给你总结</button>
      <button class="tarot-followup-opt" data-ft="care">希望TA对你说一句关怀的话</button>
    </div>
    <div class="tarot-followup-count">剩余追问 ${t.followupLeft} 次</div>
  </div>`;
  wrap.querySelectorAll('[data-ft]').forEach(btn=>{
    btn.addEventListener('click',()=>handleTarotFollowup(panel,btn.dataset.ft));
  });
}

async function handleTarotFollowup(panel,type){
  const t=G._tarot;
  if(!t.cfg||!t._history||t.followupLeft<=0)return;
  const wrap=panel.querySelector('#tarot-followup-wrap');
  const userExtra=document.getElementById('tarot-fu-input')?.value?.trim()||'';

  let followMsg='';
  if(type==='detail') followMsg='请更详细地解读每张牌的含义，以及它们之间的关联。';
  else if(type==='summary') followMsg='请用简洁的几句话总结这次占卜的核心信息。';
  else followMsg='请以温柔关怀的语气，对我说一句安慰或鼓励的话。';
  if(userExtra) followMsg+='\n\n用户补充的问题：'+userExtra;

  /* Log the followup action */
  var logLabel=type==='detail'?'希望TA解说得更详细':type==='summary'?'希望TA给你总结':'希望TA对你说一句关怀的话';
  if(userExtra){logTarotAction('你输入了：【'+userExtra+'】，并追问了：【'+logLabel+'】。')}
  else{logTarotAction('你追问了：【'+logLabel+'】。')}
  t.sessionLog.push({type:'followup-q',text:logLabel+(userExtra?' / '+userExtra:''),time:Date.now()});

  t._history.push({role:'user',content:followMsg});
  t.followupLeft--;

  wrap.innerHTML=`<div class="tarot-followup-section"><div class="tarot-followup-count">剩余追问 ${t.followupLeft} 次</div></div>`;

  const readPanel=panel.querySelector('#tarot-reading-panel');
  readPanel.innerHTML+='<div id="tarot-fu-loading" style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(160,140,200,0.1);opacity:0.4;text-align:center">✦ ……</div>';
  readPanel.scrollTop=readPanel.scrollHeight;

  try{
    const reply=_isStreamEnabled(t.cfg)?await callApiChatStream(t.cfg,t._history):await callApiChat(t.cfg,t._history);
    t._history.push({role:'assistant',content:reply||''});
    t.readingText+='\n\n'+reply;
    t.sessionLog.push({type:'followup-a',text:reply||'',time:Date.now()});
    var fuLd=readPanel.querySelector('#tarot-fu-loading');if(fuLd)fuLd.remove();
    var fuDiv=document.createElement('div');fuDiv.style.cssText='margin-top:16px;padding-top:12px;border-top:1px solid rgba(160,140,200,0.1)';fuDiv.textContent=(t._aiName||'AI')+'：'+(reply||'……');readPanel.appendChild(fuDiv);
    readPanel.scrollTop=readPanel.scrollHeight;
  }catch(e){
    var fuLdErr=readPanel.querySelector('#tarot-fu-loading');if(fuLdErr)fuLdErr.remove();
    readPanel.innerHTML+='<div style="margin-top:10px;opacity:0.6">'+escapeHtml(e.message||'请求失败')+'</div>';
  }
  t.phase='reading';
  updateTarotActions(panel);
}

async function saveTarotReading(){
  const t=G._tarot;
  if(!t) return;
  if(!t.sessionLog||t.sessionLog.length===0){if(typeof toast==='function')toast('暂无可存档的内容');return}
  if(typeof dbPut==='undefined') return;

  const drawnCards=t.slots.filter(Boolean);
  const spreadName=t.spread.name+(t.guide?' + 指引牌':'');
  let content='【塔罗占卜记录】\n';
  content+='牌阵：'+spreadName+'\n\n';
  /* Include drawn cards if any */
  if(drawnCards.length>0){
    drawnCards.forEach((s,i)=>{
      const pos=s.reversed?'逆位':'正位';
      let label='';
      if(t.spread.id==='free'){label='第'+(i+1)+'张'}
      else{
        const labels=[...t.spread.slots.map(sl=>sl.label)];
        if(t.guide)labels.push('指引');
        label=labels[i]||'';
      }
      content+=(label?label+'：':'')+s.card.display+'（'+pos+'）\n';
    });
    content+='\n';
  }
  /* Include full session log */
  content+='【操作记录】\n';
  t.sessionLog.forEach(function(entry){
    if(entry.type==='action') content+='▸ '+entry.text+'\n';
    else if(entry.type==='ai-reading') content+='\n【AI解读】\n'+entry.text+'\n';
    else if(entry.type==='followup-q') content+='\n【追问】'+entry.text+'\n';
    else if(entry.type==='followup-a') content+=entry.text+'\n';
  });

  const aiName=t._aiName||'AI';
  const post={
    id:'tarot_'+Date.now(),
    title:'Tarot · '+spreadName,
    subtitle:aiName+' · '+(drawnCards.length||0)+'张',
    locked:true,
    category:'',
    content,
    created:Date.now(),
    updated:Date.now()
  };
  try{
    await ensureDiaryInit();
    await dbPut('posts',post);
    if(typeof toast==='function') toast('占卜记录已保存');
  }catch(e){
    if(typeof toast==='function') toast('保存失败');
  }
}

function resetTarot(panel){
  const t=G._tarot;
  t.slots=[];t.freeCount=0;t.phase='pick';t.readingText='';t._history=null;t.followupLeft=3;t.sessionLog=[];
  const indices=[...Array(TAROT_DECK.length).keys()];
  for(let i=indices.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[indices[i],indices[j]]=[indices[j],indices[i]]}
  t.deck=indices;
  const fan=panel.querySelector('#tarot-fan');if(fan)fan.style.display='';
  const sbar=panel.querySelector('#tarot-spread-bar');if(sbar)sbar.style.display='';
  const trow=panel.querySelector('.tarot-top-row');if(trow)trow.style.display='';
  generateTarotFan(panel);
  updateTarotSlots(panel);
  /* Don't clear reading panel — just log the action */
  const fw=panel.querySelector('#tarot-followup-wrap');if(fw)fw.innerHTML='';
}

function closeTarot(){
  G.tarotOpen=false;
  G._tarot=null;
  if(G.viewport){const panel=G.viewport.querySelector('#game-tarot');if(panel){panel.classList.remove('show');panel.innerHTML=''}}
}


/* ---- IB 命名空间迁移：双挂载（window 实时 + IB.game 合并注册）。严格模式保持：IIFE 开括号置于文件头注释之前。 ---- */
function ibGameLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._isStreamEnabled=_isStreamEnabled;
window.buildTarotDeck=buildTarotDeck;
window._tsxStar=_tsxStar;
window._tsxRays=_tsxRays;
window._tsxGlyphSVG=_tsxGlyphSVG;
window.buildTarotFaceHTML=buildTarotFaceHTML;
window.getTarotGuideHTML=getTarotGuideHTML;
window.interactCrystal=interactCrystal;
window.openTarot=openTarot;
window.initTarotState=initTarotState;
window.logTarotAction=logTarotAction;
window.renderTarotUI=renderTarotUI;
window.getTarotTotalSlots=getTarotTotalSlots;
window.updateTarotSlots=updateTarotSlots;
window.generateTarotFan=generateTarotFan;
window.pickTarotCard=pickTarotCard;
window.updateTarotActions=updateTarotActions;
window.switchTarotDeckStyle=switchTarotDeckStyle;
window.runTarotInterpret=runTarotInterpret;
window.showTarotFollowup=showTarotFollowup;
window.handleTarotFollowup=handleTarotFollowup;
window.saveTarotReading=saveTarotReading;
window.resetTarot=resetTarot;
window.closeTarot=closeTarot;
window.MAJOR_ARCANA=MAJOR_ARCANA;
window.SUITS=SUITS;
window.RANKS=RANKS;
window.TAROT_DECK=TAROT_DECK;
window.TAROT_SPREADS=TAROT_SPREADS;
ibGameLive('TAROT_FACE_STYLE', function(){return TAROT_FACE_STYLE}, function(v){TAROT_FACE_STYLE=v});
ibGameLive('_TSX_SUIT', function(){return _TSX_SUIT}, function(v){_TSX_SUIT=v});
ibGameLive('_TSX_MAJOR', function(){return _TSX_MAJOR}, function(v){_TSX_MAJOR=v});
ibGameLive('_TSX_SUIT_INK', function(){return _TSX_SUIT_INK}, function(v){_TSX_SUIT_INK=v});
NS.expose('game', {
  _isStreamEnabled: _isStreamEnabled,
  buildTarotDeck: buildTarotDeck,
  _tsxStar: _tsxStar,
  _tsxRays: _tsxRays,
  _tsxGlyphSVG: _tsxGlyphSVG,
  buildTarotFaceHTML: buildTarotFaceHTML,
  getTarotGuideHTML: getTarotGuideHTML,
  interactCrystal: interactCrystal,
  openTarot: openTarot,
  initTarotState: initTarotState,
  logTarotAction: logTarotAction,
  renderTarotUI: renderTarotUI,
  getTarotTotalSlots: getTarotTotalSlots,
  updateTarotSlots: updateTarotSlots,
  generateTarotFan: generateTarotFan,
  pickTarotCard: pickTarotCard,
  updateTarotActions: updateTarotActions,
  switchTarotDeckStyle: switchTarotDeckStyle,
  runTarotInterpret: runTarotInterpret,
  showTarotFollowup: showTarotFollowup,
  handleTarotFollowup: handleTarotFollowup,
  saveTarotReading: saveTarotReading,
  resetTarot: resetTarot,
  closeTarot: closeTarot,
  MAJOR_ARCANA: MAJOR_ARCANA,
  SUITS: SUITS,
  RANKS: RANKS,
  TAROT_DECK: TAROT_DECK,
  TAROT_SPREADS: TAROT_SPREADS,
  TAROT_FACE_STYLE: TAROT_FACE_STYLE,
  _TSX_SUIT: _TSX_SUIT,
  _TSX_MAJOR: _TSX_MAJOR,
  _TSX_SUIT_INK: _TSX_SUIT_INK,
});
})(window.IB || (window.IB = {}));
