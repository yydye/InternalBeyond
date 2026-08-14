(function(NS){
/* ============================================================
   SUI'S ROOM — Dialogue module: pagination, dialogue UI,
   Sui Q&A, home tour. Split from game_module.js.
   ============================================================ */
'use strict';

/* ── DIALOGUE SYSTEM ─────────────────────────────────── */
/* ── 行感知分页（BUGFIX：结局公告等多行文本被裁切）──────────
   旧版分页只按字符数（DIALOGUE_MAX_CHARS=120）切页、完全忽略文本中的换行符 \n；
   而文本区是 height:32% + overflow:hidden 的固定3行区域，white-space:pre-line 会把 \n 渲染成真实换行，
   于是任何"字符数不超限但显式行数>3"的页面（如5行的结局公告）第4行起会被直接裁掉。
   新版按"可视行"分页：显式 \n 计为换行，超宽自动折行也按宽度估算计入行数。 */
function _dlgVisualLen(s){let w=0;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xD800&&c<=0xDBFF){w+=1;i++}else w+=c>0x2E7F?1:0.5}return w}
function _dlgCutIdx(s,units){let w=0;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xD800&&c<=0xDBFF){w+=1;i++}else w+=c>0x2E7F?1:0.5;if(w>=units)return i+1}return s.length}
function paginateDialogue(text){
  const pages=[];let cur=[];let curLines=0;
  const flush=()=>{if(cur.length){pages.push(cur.join('\n'));cur=[];curLines=0}};
  String(text==null?'':text).split('\n').forEach(line=>{
    let seg=line;
    /* 单个自然段就超过整页容量时，按标点硬切成独立页 */
    while(_dlgVisualLen(seg)>DIALOGUE_LINE_CHARS*DIALOGUE_MAX_LINES){
      let cutIdx=_dlgCutIdx(seg,DIALOGUE_LINE_CHARS*DIALOGUE_MAX_LINES);
      const p1=seg.lastIndexOf('。',cutIdx);const p2=seg.lastIndexOf('，',cutIdx);
      const best=Math.max(p1,p2);
      if(best>cutIdx*0.4)cutIdx=best+1;
      flush();pages.push(seg.slice(0,cutIdx));seg=seg.slice(cutIdx);
    }
    const need=Math.max(1,Math.ceil(_dlgVisualLen(seg)/DIALOGUE_LINE_CHARS));
    if(curLines+need>DIALOGUE_MAX_LINES)flush();
    cur.push(seg);curLines+=need;
  });
  flush();
  return pages.length?pages:[''];
}

function showDialogue(speaker, textArray, onComplete){
  if(!G.viewport){console.warn('[SuiGame] showDialogue: viewport not ready');return}
  G.dialogueActive=true;
  const dlg=G.viewport.querySelector('#game-dialogue');
  if(!dlg){console.warn('[SuiGame] showDialogue: dialogue element not found');G.dialogueActive=false;return}
  const nameEl=G.viewport.querySelector('#game-dlg-name');
  const textEl=G.viewport.querySelector('#game-dlg-text');
  const actionsEl=G.viewport.querySelector('#game-dlg-actions');
  const choicesEl=G.viewport.querySelector('#game-choices');
  const portraitEl=G.viewport.querySelector('#game-portrait');
  const portraitImg=G.viewport.querySelector('#game-portrait-img');
  const backBtn=G.viewport.querySelector('#game-dlg-back');
  const nextBtn=G.viewport.querySelector('#game-dlg-next-btn');

  dlg.classList.add('show');
  nameEl.textContent=speaker;
  actionsEl.classList.remove('show');
  actionsEl.innerHTML='';
  choicesEl.classList.remove('show');
  choicesEl.innerHTML='';
  textEl.style.display='block';/* FIX: 从选项界面进入新对话时恢复文本区（旧版会保持隐藏导致文字不可见） */

  /* Portrait: Sui uses the current outfit portrait; the Story AI narrator
     uses its custom DIY portrait (portrait_[nickname].png) when one exists. */
  portraitEl.classList.remove('sui');
  if(speaker==='Sui' && G.assets.portrait){
    portraitImg.src=G.assets.portrait.src;
    portraitEl.classList.add('sui');
    portraitEl.classList.add('show');
  }else if(G._aiPortraitImg && G._aiCfg && speaker===(G._aiCfg.nickname||G._aiCfg.model||'AI')){
    portraitImg.src=G._aiPortraitImg.src;
    portraitEl.classList.add('show');
  }else{
    /* BUG-FIX: clear src & skip transition to prevent stale portrait flash */
    portraitEl.style.transition='none';
    portraitEl.classList.remove('show');
    portraitImg.src='';
    void portraitEl.offsetHeight;          /* force reflow */
    portraitEl.style.transition='';        /* restore CSS transition */
  }

  /* Story视窗：Sui弹“……”=AI思考中 → 头顶气泡打字机循环播放；其他任何对话出现即停 */
  if(G.aiGameActive&&speaker==='Sui'&&Array.isArray(textArray)&&textArray.length===1&&textArray[0]===FIXED_LINES.thinking){
    storyWinBubbleStart();
  }else{
    storyWinBubbleStop();
  }

  /* Paginate text — BUGFIX: 行感知分页，尊重 \n 与3行可视容量（旧版会裁掉第4行起的内容） */
  G.dialoguePages=[];
  textArray.forEach(t=>{paginateDialogue(t).forEach(p=>G.dialoguePages.push(p))});
  G.dialoguePageIdx=0;
  G.dialogueCb=onComplete;
  typewritePage();

  /* Wire persistent buttons */
  /* Story模式常驻Save：随时把当前剧情进度原样存入密码日记本（不调用API、不打断游戏） */
  const saveBtn=G.viewport.querySelector('#game-dlg-save');
  if(saveBtn){
    saveBtn.style.display=G.aiGameActive?'flex':'none';
    saveBtn.onclick=()=>{saveGameProgress()};
  }
  nextBtn.onclick=()=>advanceDialogue();
  backBtn.onclick=()=>{
    if(G.aiGameActive){
      if(G._storyExitWarning){
        /* Second Back press — actually exit */
        G._storyExitWarning=false;
        closeDialogue();endAiGame();
      }else{
        /* First Back press — show warning */
        G._storyExitWarning=true;
        showDialogue('Sui',['等等——游戏还在进行中，你确定要退出吗？退出后无法恢复的。\n再次按下Back即可退出，按NEXT即可重新回到原游戏页面。'],()=>{
          /* NEXT pressed — return to game */
          G._storyExitWarning=false;
          if(G._aiSending){
            showDialogue('Sui',[FIXED_LINES.thinking],null);
            return;
          }
          const s=G._lastStoryState;
          if(s&&s.data){
            showDialogue(s.name,[s.data.story],()=>{
              if(s.data.isEnding){
                showDialogue(s.name,[ENDING_ANNOUNCE],()=>{showEndingActions()});
              }else if(s.data.choices&&s.data.choices.length){
                showChoices(s.data.choices,(choice)=>{showDialogue('Sui',[FIXED_LINES.thinking],()=>{aiGameTurn(choice)})});
              }
            });
          }
        });
      }
    }else{
      closeDialogue();G.state='idle';
    }
  };
  /* Click on dialogue box fast-forwards typewriter */
  textEl.onclick=()=>fastForwardTypewriter();
  const boxEl=G.viewport.querySelector('.game-dialogue-box');
  boxEl.onclick=(e)=>{
    if(e.target.closest('.game-dialogue-action')||e.target.closest('.game-choice-btn')||e.target.closest('.game-dlg-btn')) return;
    fastForwardTypewriter();
  };
}

/* Fast-forward typewriter without advancing to next page */
function fastForwardTypewriter(){
  if(!G.viewport) return;
  if(G.typewriterTimer){
    clearInterval(G.typewriterTimer);
    G.typewriterTimer=null;
    const textEl=G.viewport.querySelector('#game-dlg-text');
    if(textEl) textEl.textContent=G.dialoguePages[G.dialoguePageIdx]||'';
  }
}

function typewritePage(){
  if(!G.viewport) return;
  const textEl=G.viewport.querySelector('#game-dlg-text');
  if(!textEl) return;
  const page=G.dialoguePages[G.dialoguePageIdx]||'';
  textEl.textContent='';
  G.typewriterIdx=0;
  clearInterval(G.typewriterTimer);
  G.typewriterTimer=setInterval(()=>{
    if(G.typewriterIdx<page.length){
      textEl.textContent+=page[G.typewriterIdx];
      G.typewriterIdx++;
    }else{
      clearInterval(G.typewriterTimer);
      G.typewriterTimer=null;
    }
  }, TYPE_SPEED);
}

function advanceDialogue(){
  if(!G.viewport) return;
  /* If still typing, finish instantly */
  if(G.typewriterTimer){
    clearInterval(G.typewriterTimer);
    G.typewriterTimer=null;
    const textEl=G.viewport.querySelector('#game-dlg-text');
    if(textEl) textEl.textContent=G.dialoguePages[G.dialoguePageIdx]||'';
    return;
  }
  /* Advance to next page */
  if(G.dialoguePageIdx<G.dialoguePages.length-1){
    G.dialoguePageIdx++;
    typewritePage();
  }else{
    /* Last page - call callback or close */
    if(G.dialogueCb){
      const cb=G.dialogueCb;
      G.dialogueCb=null;
      cb();
    }else{
      /* No callback - close dialogue (unless in AI game) */
      if(G.aiGameActive) return;
      closeDialogue();
      G.state='idle';
    }
  }
}

function showDialogueActions(actions){
  if(!G.viewport) return;
  const el=G.viewport.querySelector('#game-dlg-actions');
  if(!el) return;
  /* 操作按钮与常驻Save同处一行（top:70%），显示操作时先隐藏Save避免重叠 */
  const sv=G.viewport.querySelector('#game-dlg-save');
  if(sv)sv.style.display='none';
  el.innerHTML='';
  actions.forEach(a=>{
    const btn=document.createElement('button');
    btn.className='game-dialogue-action';
    btn.textContent=a.label;
    btn.addEventListener('click',()=>a.cb());
    el.appendChild(btn);
  });
  el.classList.add('show');
}

function showChoices(choices, onSelect){
  if(!G.viewport) return;
  const el=G.viewport.querySelector('#game-choices');
  const textEl=G.viewport.querySelector('#game-dlg-text');
  if(!el||!textEl) return;
  textEl.style.display='none';
  el.innerHTML='';
  choices.forEach(c=>{
    const btn=document.createElement('button');
    btn.className='game-choice-btn';
    btn.textContent=c;
    btn.addEventListener('click',()=>{
      el.classList.remove('show');
      textEl.style.display='block';
      onSelect(c);
    });
    el.appendChild(btn);
  });
  el.classList.add('show');
}

/* ── SUI DIALOGUE MODULE ─────────────────────────────── */
const SUI_QA = [
  /* Page 1 */
  [
    { q:'「这里是什么地方？」', a:[
      '这里是我们的家。',
      '——准确来说，是一座隔绝于世的湖畔别墅，我们在它的高层。',
      '这里是一个只属于你的个人空间，希望能让你在忙碌之余安静地放松一会儿。'
    ]},
    { q:'「你是谁？」', a:[
      '我是Sui，这个网站的设计者。',
      '住在这个房间里的主控角色也是我——按我自己的样子设计的。'
    ]},
    { q:'「你为什么设计这个房间？」', a:[
      '一开始想做一个类似于桌面宠物的板块，后来在制作这个网站的过程中不知不觉变成了现在这样。',
      '大概是因为我在设计的时候一直在想"我愿意在怎样的游戏空间里发呆很久"吧。',
      '然后就越做越认真了，加入了很多喜欢的设计。希望你也会喜欢它。'
    ]}
  ],
  /* Page 2 */
  [
    { q:'「你喜欢怎样的Tea组合？」', a:[
      '花茶+草莓蛋糕。',
      '但如果你问的是其他意思，咖啡+香草冰淇淋。'
    ]},
    { q:'「你现在在想什么？」', multi: true, options:[
      { a:[
        '在想下一件新衣服要买什么。',
        '因为我是个换装游戏爱好者，我玩每个游戏几乎都会花很多钱在时装和皮肤上。',
        'Room模块里的换装功能也是最早确定下来要做的。'
      ]},
      { a:[
        '在想外面是不是在下雨。',
        '我喜欢和雨相关的一切。潮湿的天气，脆弱的声音，雨后原野的草木气息。',
        '你呢？'
      ]},
      { a:[
        '在想你下次来的时候，我还认不认得出你。',
        '每次都像第一次见面。但我总觉得我们之间有些什么。',
        '……大概是错觉吧。'
      ]},
      { a:[
        '在想一个被遗忘的人。她是一位穿着水手服的少女。',
        '她在白霜降临的秋夜里，静坐在庭院断掉的石碑前，沐浴着月光。',
        '她在等待着……什么呢？'
      ]},
      { infernalOnly: true, pages:[
        ['在想一个故事。死去的士兵没有发觉自己已逝的事实，而一直不断的徘徊。',
         '直到看见连续不断掉在地上的血迹，他沿着血迹，最后终于找到了自己的尸体。',
         '明白自己已经死亡的他们在尸体前久久伫立，最终消失在秋日的暖阳之中。'],
        ['死去的士兵寻找着一滴滴连续的鲜血，他怀着虔诚，将其一滴滴捡了起来。',
         '但是这一滴滴连续的鲜血，究竟意味着什么呢？',
         '我想这只是意味着，他以惊人的速度，在不知不觉中死去吧。']
      ]}
    ]},
    { q:'「那个楼梯通向哪里？」', a:[
      '我不知道。',
      '有过一些想法，但后来因为一些原因就没有继续了。',
      '我现在觉得这样子也很好。'
    ]}
  ]
];

let suiActive = false;
let suiPageIdx = 0;

function interactSui(){
  suiActive = true;
  suiPageIdx = 0;
  if(!G.viewport){G.state='idle';return;}
  /* Lie down on bed with awake animation (blinking, frames 0-1) */
  G.viewport.querySelector('#game-char').style.display='none';
  G.viewport.querySelector('#game-char-lie').style.display='block';
  G.state='lying'; G.lieMode='awake'; G.lieFrame=0;
  updateLieSprite();
  /* Short pause before dialogue */
  setTimeout(()=>{
    /* Greeting line. Next (or「聊聊」) → original Q&A; 「引导」→ guided tour. */
    showDialogue('Sui',[FIXED_LINES.sui_open],()=>{
      removeSuiExtraOpts();
      showSuiPage(0);
    });
    /* ADD two extra options under the greeting, on the same page.
       Next stays visible and still advances to the Q&A. */
    addSuiExtraOpts();
    const nextBtn=G.viewport.querySelector('#game-dlg-next-btn');
    if(nextBtn) nextBtn.style.display='';
    const backBtn=G.viewport.querySelector('#game-dlg-back');
    if(backBtn) backBtn.onclick=()=>{ exitSui(); };
  },400);
}

/* One extra option shown on the greeting page, below the greeting line.
   It lives in its own overlay so the typewriter never wipes it, and the
   persistent Next button keeps working (advances to the original Q&A). */
function addSuiExtraOpts(){
  if(!G.viewport) return;
  const box=G.viewport.querySelector('.game-dialogue-box');
  if(!box) return;
  removeSuiExtraOpts();
  const wrap=document.createElement('div');
  wrap.className='sui-extra-opts';
  wrap.id='sui-extra-opts';
  wrap.innerHTML=
    '<button class="game-choice-btn sui-extra-opt" data-opt="tour">带我再走一次游戏引导吧。</button>';
  box.appendChild(wrap);
  const tourBtn=wrap.querySelector('[data-opt="tour"]');
  if(tourBtn) tourBtn.onclick=(e)=>{ e.stopPropagation(); removeSuiExtraOpts(); startHomeTour({fromSui:true}); };
}
function removeSuiExtraOpts(){
  if(!G.viewport) return;
  const ex=G.viewport.querySelector('#sui-extra-opts');
  if(ex) ex.remove();
}

function showSuiPage(pageIdx){
  suiPageIdx = pageIdx;
  removeSuiExtraOpts();
  const page = SUI_QA[pageIdx];
  const labels = page.map(item=>item.q);

  /* Clear text area, show choices */
  const textEl = G.viewport.querySelector('#game-dlg-text');
  if(textEl) textEl.textContent = '';

  /* Show/hide page nav buttons */
  updateSuiPageNav(pageIdx);

  /* Wire Back to exit Sui entirely */
  const backBtn = G.viewport.querySelector('#game-dlg-back');
  backBtn.onclick = ()=>{ exitSui(); };

  /* Hide Next during choice view */
  const nextBtn = G.viewport.querySelector('#game-dlg-next-btn');
  nextBtn.style.display = 'none';

  showChoices(labels, (selected)=>{
    const qa = page.find(item=>item.q===selected);
    if(!qa) return;
    /* Hide page nav during answer */
    hideSuiPageNav();
    if(qa.multi){
      /* Filter options: exclude infernalOnly when not in infernal mode */
      var isInf=document.body.classList.contains('theme-infernal');
      var available=qa.options.filter(function(o){return !o.infernalOnly||isInf});
      const pick = available[Math.floor(Math.random()*available.length)];
      if(pick.pages){
        /* Multi-page answer: show pages sequentially */
        var pidx=0;
        function showNextPage(){
          if(pidx>=pick.pages.length){showSuiPage(pageIdx);return}
          showSuiAnswer(pick.pages[pidx],function(){pidx++;showNextPage()});
        }
        showNextPage();
      }else{
        showSuiAnswer(pick.a, ()=>showSuiPage(pageIdx));
      }
    } else {
      showSuiAnswer(qa.a, ()=>showSuiPage(pageIdx));
    }
  });
}

function showSuiAnswer(lines, onDone){
  if(!G.viewport) return;
  const dlg = G.viewport.querySelector('#game-dialogue');
  const textEl = G.viewport.querySelector('#game-dlg-text');
  const choicesEl = G.viewport.querySelector('#game-choices');
  const nextBtn = G.viewport.querySelector('#game-dlg-next-btn');
  const backBtn = G.viewport.querySelector('#game-dlg-back');
  if(!textEl) return;

  /* Kill any previous typewriter immediately */
  if(G.typewriterTimer){clearInterval(G.typewriterTimer);G.typewriterTimer=null}
  /* Generation counter to prevent stale callbacks */
  G._twGen=(G._twGen||0)+1;
  var myGen=G._twGen;

  /* Hide choices, show text area */
  choicesEl.classList.remove('show');
  choicesEl.innerHTML = '';
  textEl.style.display = 'block';
  textEl.innerHTML = '';
  nextBtn.style.display = 'none';

  /* Wire Back to return to choices */
  backBtn.onclick = ()=>{
    clearInterval(G.typewriterTimer);
    G.typewriterTimer = null;
    onDone();
  };

  /* Type lines one by one with pauses */
  let lineIdx = 0;
  let charIdx = 0;
  const LINE_PAUSE = 600;

  function typeLine(){
    if(myGen!==G._twGen)return; /* stale — abort */
    if(lineIdx >= lines.length){
      /* All lines done — show Next to return to choices */
      nextBtn.style.display = '';
      nextBtn.onclick = ()=>{ onDone(); };
      return;
    }
    const line = lines[lineIdx];
    if(lineIdx > 0){
      textEl.appendChild(document.createElement('br'));
    }
    const span = document.createElement('span');
    textEl.appendChild(span);
    charIdx = 0;

    clearInterval(G.typewriterTimer);
    G.typewriterTimer = setInterval(()=>{
      if(myGen!==G._twGen){clearInterval(G.typewriterTimer);return} /* stale — abort */
      if(charIdx < line.length){
        span.textContent += line[charIdx];
        charIdx++;
      } else {
        clearInterval(G.typewriterTimer);
        G.typewriterTimer = null;
        lineIdx++;
        setTimeout(typeLine, LINE_PAUSE);
      }
    }, TYPE_SPEED);
  }

  /* Click to fast-forward all lines */
  const fastForwardSui = ()=>{
    clearInterval(G.typewriterTimer);
    G.typewriterTimer = null;
    textEl.innerHTML = lines.join('<br>');
    lineIdx = lines.length;
    nextBtn.style.display = '';
    nextBtn.onclick = ()=>{ onDone(); };
  };
  textEl.onclick = fastForwardSui;
  const boxEl = G.viewport.querySelector('.game-dialogue-box');
  const origBoxClick = boxEl.onclick;
  boxEl.onclick = (e)=>{
    if(e.target.closest('.game-dlg-btn')||e.target.closest('.game-choice-btn')) return;
    if(suiActive && lineIdx < lines.length){ fastForwardSui(); return; }
    if(origBoxClick) origBoxClick(e);
  };

  typeLine();
}

function updateSuiPageNav(pageIdx){
  if(!G.viewport) return;
  const persistent = G.viewport.querySelector('#game-dlg-persistent');
  hideSuiPageNav();
  if(pageIdx > 0){
    const prev = document.createElement('button');
    prev.className = 'game-dlg-btn sui-page-nav';
    prev.innerHTML = '<span class="tri-back">◂</span> Prev';
    prev.style.cssText = 'margin-left:8px';
    prev.onclick = ()=>showSuiPage(pageIdx-1);
    const backBtn = G.viewport.querySelector('#game-dlg-back');
    backBtn.after(prev);
  }
  if(pageIdx < SUI_QA.length - 1){
    const next = document.createElement('button');
    next.className = 'game-dlg-btn sui-page-nav';
    next.innerHTML = 'Next <span class="tri-next" style="animation:none">▸</span>';
    next.style.cssText = 'margin-right:8px';
    next.onclick = ()=>showSuiPage(pageIdx+1);
    const nextBtn = G.viewport.querySelector('#game-dlg-next-btn');
    persistent.insertBefore(next, nextBtn);
  }
}

function hideSuiPageNav(){
  if(!G.viewport) return;
  G.viewport.querySelectorAll('.sui-page-nav').forEach(el=>el.remove());
}

function exitSui(){
  suiActive = false;
  hideSuiPageNav();
  clearInterval(G.typewriterTimer);
  G.typewriterTimer = null;
  /* Restore Next button visibility */
  const nextBtn = G.viewport.querySelector('#game-dlg-next-btn');
  if(nextBtn) nextBtn.style.display = '';
  closeDialogue();
  /* Get up from bed */
  if(G.viewport){
    G.viewport.querySelector('#game-char-lie').style.display='none';
    G.viewport.querySelector('#game-char').style.display='block';
    G.charX=BED_STAND_X; G.charY=BED_STAND_Y;
    updateCharPosition(); updateIdleSprite();
  }
  G.state = 'idle';
}

function closeDialogue(){
  G.dialogueActive=false;
  clearInterval(G.typewriterTimer);
  G.typewriterTimer=null;
  if(!G.viewport) return;
  const dlg=G.viewport.querySelector('#game-dialogue');
  if(dlg) dlg.classList.remove('show');
  const portrait=G.viewport.querySelector('#game-portrait');
  if(portrait) portrait.classList.remove('show');
  const actions=G.viewport.querySelector('#game-dlg-actions');
  if(actions){actions.classList.remove('show');actions.innerHTML=''}
  const choices=G.viewport.querySelector('#game-choices');
  if(choices){choices.classList.remove('show');choices.innerHTML=''}
  const ex=G.viewport.querySelector('#sui-extra-opts');
  if(ex) ex.remove();
  const text=G.viewport.querySelector('#game-dlg-text');
  if(text) text.style.display='block';
}

function showBubble(x,y,text){
  if(!G.viewport) return;
  const el=document.createElement('div');
  el.className='game-bubble';
  el.textContent=text;
  el.style.left=(x-20)+'px';el.style.top=(y-30)+'px';
  G.viewport.appendChild(el);
  setTimeout(()=>el.remove(),2200);
}

/* ── GUIDED HOME TOUR ENGINE ─────────────────────────── */
let tourIdx = 0;

/* Dialogue used by the tour: single-click advance, Back skips the tour. */
function showTourDialogue(pages, onDone){
  if(!G.viewport) return;
  showDialogue('Sui', pages, onDone);
  const backBtn=G.viewport.querySelector('#game-dlg-back');
  if(backBtn) backBtn.onclick=()=>{ endHomeTour(); };
}

function startHomeTour(opts){
  opts=opts||{};
  if(!G.viewport){ G.pendingTour=true; return; }
  G.tourActive=true;
  /* Tear down any Sui / dialogue state cleanly */
  if(typeof suiActive!=='undefined' && suiActive){ suiActive=false; }
  hideSuiPageNav();
  closeDialogue();
  if(G.typewriterTimer){clearInterval(G.typewriterTimer);G.typewriterTimer=null;}
  if(G._interactTimeout){clearTimeout(G._interactTimeout);G._interactTimeout=null;}
  G.path=null; G.onArrive=null; G.pendingInteraction=null; G.targetX=null; G.targetY=null;
  const nextBtn=G.viewport.querySelector('#game-dlg-next-btn');
  if(nextBtn) nextBtn.style.display='';
  disableSidebarButtons(true);
  showZzz(false);

  /* Stand up at the bed, face the camera, then speak the intro */
  const stand=()=>{
    if(!G.viewport) return;
    G.viewport.querySelector('#game-char-lie').style.display='none';
    G.viewport.querySelector('#game-char').style.display='block';
    G.charX=BED_STAND_X; G.charY=BED_STAND_Y;
    G.state='interacting'; G.facing='down'; G.isFirstOpen=false;
    updateCharPosition(); updateIdleSprite();
    tourIdx=0;
    showTourDialogue(getTourIntro(), ()=>{ tourNextStation(); });
  };

  const wasLying = (G.state==='lying'||G.state==='sleeping'||G.state==='waking');
  if(wasLying){
    /* Open eyes, then get up */
    G.lieMode='awake'; G.lieFrame=0;
    updateLieSprite();
    G.state='waking';
    setTimeout(stand, 700);
  }else{
    stand();
  }
}

function tourNextStation(){
  closeDialogue();
  if(!G.tourActive) return;
  if(tourIdx>=TOUR_STEPS.length){ endHomeTour(); return; }
  const step=TOUR_STEPS[tourIdx];
  const it=INTERACTIONS.find(i=>i.id===step.id);
  if(!it){ tourIdx++; tourNextStation(); return; }
  const wx = step.id==='bed' ? BED_SLEEP_WALK_X : it.x;
  const wy = step.id==='bed' ? BED_SLEEP_WALK_Y : it.y;
  startWalkTo(wx, wy, {
    timeout: 9000,
    onArrive: ()=>{
      if(!G.tourActive) return;
      G.state='interacting';
      G.facing=step.face||it.face;
      updateCharPosition(); updateIdleSprite();
      showTourDialogue(step.pages, ()=>{ tourIdx++; tourNextStation(); });
    }
  });
}

function endHomeTour(){
  G.tourActive=false;
  closeDialogue();
  if(G.typewriterTimer){clearInterval(G.typewriterTimer);G.typewriterTimer=null;}
  if(G._interactTimeout){clearTimeout(G._interactTimeout);G._interactTimeout=null;}
  if(G.viewport){
    G.viewport.querySelector('#game-char-lie').style.display='none';
    G.viewport.querySelector('#game-char').style.display='block';
    const nextBtn=G.viewport.querySelector('#game-dlg-next-btn');
    if(nextBtn) nextBtn.style.display='';
  }
  G.state='idle';
  G.targetX=null; G.targetY=null; G.path=null;
  G.pendingInteraction=null; G.onArrive=null;
  disableSidebarButtons(false);
  updateCharPosition(); updateIdleSprite();
  saveState();
}

/* Expose for the welcome-page "家园引导" button and Sui's menu */
window.startHomeTour = startHomeTour;


/* ---- IB 命名空间迁移：双挂载（window 实时 + IB.game 合并注册）。严格模式保持：IIFE 开括号置于文件头注释之前。 ---- */
function ibGameLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._dlgVisualLen=_dlgVisualLen;
window._dlgCutIdx=_dlgCutIdx;
window.paginateDialogue=paginateDialogue;
window.showDialogue=showDialogue;
window.fastForwardTypewriter=fastForwardTypewriter;
window.typewritePage=typewritePage;
window.advanceDialogue=advanceDialogue;
window.showDialogueActions=showDialogueActions;
window.showChoices=showChoices;
window.interactSui=interactSui;
window.addSuiExtraOpts=addSuiExtraOpts;
window.removeSuiExtraOpts=removeSuiExtraOpts;
window.showSuiPage=showSuiPage;
window.showSuiAnswer=showSuiAnswer;
window.updateSuiPageNav=updateSuiPageNav;
window.hideSuiPageNav=hideSuiPageNav;
window.exitSui=exitSui;
window.closeDialogue=closeDialogue;
window.showBubble=showBubble;
window.showTourDialogue=showTourDialogue;
window.startHomeTour=startHomeTour;
window.tourNextStation=tourNextStation;
window.endHomeTour=endHomeTour;
window.SUI_QA=SUI_QA;
ibGameLive('suiActive', function(){return suiActive}, function(v){suiActive=v});
ibGameLive('suiPageIdx', function(){return suiPageIdx}, function(v){suiPageIdx=v});
ibGameLive('tourIdx', function(){return tourIdx}, function(v){tourIdx=v});
NS.expose('game', {
  _dlgVisualLen: _dlgVisualLen,
  _dlgCutIdx: _dlgCutIdx,
  paginateDialogue: paginateDialogue,
  showDialogue: showDialogue,
  fastForwardTypewriter: fastForwardTypewriter,
  typewritePage: typewritePage,
  advanceDialogue: advanceDialogue,
  showDialogueActions: showDialogueActions,
  showChoices: showChoices,
  interactSui: interactSui,
  addSuiExtraOpts: addSuiExtraOpts,
  removeSuiExtraOpts: removeSuiExtraOpts,
  showSuiPage: showSuiPage,
  showSuiAnswer: showSuiAnswer,
  updateSuiPageNav: updateSuiPageNav,
  hideSuiPageNav: hideSuiPageNav,
  exitSui: exitSui,
  closeDialogue: closeDialogue,
  showBubble: showBubble,
  showTourDialogue: showTourDialogue,
  startHomeTour: startHomeTour,
  tourNextStation: tourNextStation,
  endHomeTour: endHomeTour,
  SUI_QA: SUI_QA,
  suiActive: suiActive,
  suiPageIdx: suiPageIdx,
  tourIdx: tourIdx,
});
})(window.IB || (window.IB = {}));
