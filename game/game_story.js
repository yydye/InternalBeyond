(function(NS){
/* ============================================================
   SUI'S ROOM — Story module: desk interaction, AI branching
   narrative engine, story window. Split from game_module.js.
   ============================================================ */
'use strict';

/* Single AI response using a specific configuration */
/* ── DESK / AI GAME ──────────────────────────────────── */
function interactDesk(){
  showDialogue('Sui',[FIXED_LINES.desk_intro],()=>{
    showChoices(['开始游戏','用Blog里自己写的自定义剧本开启剧情。','为我介绍一下Story的玩法。'],(choice)=>{
      if(choice==='开始游戏'){
        closeDialogue();
        openAiSetup();
      }else if(choice.includes('自定义剧本')){
        closeDialogue();
        openCustomScriptSetup();
      }else{
        showDialogue('Sui',[
          'Story是一个AI驱动的互动文字冒险游戏。\n你选择一个AI来当游戏主持人，TA会为你实时编写分支剧情。',
          '开始前你需要做三个选择：\n· 选一个AI当主持人\n· 选故事类型（奇幻/神秘学/推理悬疑/恋爱/科幻）\n· 选恐怖程度（无/低/中/高）',
          '游戏开始后，AI每轮会给你一段剧情，然后提供三个选项让你选择。\n你的每一个选择都会影响故事的走向。',
          '故事大约在12到16轮后结束。\n共有3个普通结局和1个隐藏结局——能不能触发隐藏结局，取决于你的选择。',
          '还有一种玩法：「自定义剧本」。\n你在Blog里写一篇日志当剧本（世界观、角色、剧情走向都行），AI会按你写的内容来主持游戏。',
          '游戏进行时，对话框中间会出现Save按钮。\n按下后我会帮你把当前的剧情进度写进密码日记本，此操作不会打断游戏进度，中途存档的剧本不会有剧透。',
          '通关结局后按下Save，\n我会为你整理一份完整的故事设定文档存入密码日记本，含全部结局与隐藏要素。\n保存后你可以在日记里让TA帮你把这段故事生成一条记忆。\n结局页会出现两个新的按钮：Replay（以相同设定再来一局）和Exit（离开）。',
          '游戏过程中，按对话框左下角的Back可以随时退出（会有确认提示）。\n准备好了的话，按Back返回上一级，然后开始你的故事吧。'
        ],null);
      }
    });
  });
}

function openAiSetup(){
  if(!G.viewport){G.state='idle';return}
  /* Check if any API is configured */
  const hasApi = typeof apiConfigs!=='undefined' && apiConfigs.length>0;
  const panel=G.viewport.querySelector('#game-ai-setup');
  if(!panel){G.state='idle';return}
  if(!hasApi){
    panel.innerHTML=`<h4>No API Configured</h4><p style="font-size:0.8rem;color:var(--text-muted);text-align:center">${FIXED_LINES.no_api}</p>
    <div class="game-ai-setup-actions"><button class="tarot-btn" id="game-ai-noapi-close">Close</button></div>`;
    panel.classList.add('show');
    panel.querySelector('#game-ai-noapi-close').addEventListener('click',()=>{panel.classList.remove('show');G.state='idle'});
    return;
  }
  const apiOpts = apiConfigs.map((a,i)=>`<option value="${i}">${a.nickname||a.model||'AI'}</option>`).join('');
  panel.innerHTML=`<h4>Interactive Story</h4>
    <label>AI</label><select id="game-ai-select">${apiOpts}</select>
    <label>Genre</label><select id="game-genre"><option value="fantasy">Fantasy</option><option value="mystery">Mystic</option><option value="detective">Detective</option><option value="romance">Romance</option><option value="scifi">Sci-Fi</option></select>
    <label>Horror Elements</label><select id="game-horror"><option value="no">No</option><option value="low">Low</option><option value="mid">Medium</option><option value="high">High</option></select>
    <div class="game-ai-setup-actions">
      <button class="tarot-btn" id="game-ai-start">Start</button>
      <button class="tarot-btn" id="game-ai-cancel">Cancel</button>
    </div>`;
  panel.classList.add('show');

  panel.querySelector('#game-ai-start').addEventListener('click',()=>{
    const aiIdx=parseInt(panel.querySelector('#game-ai-select').value);
    const genre=panel.querySelector('#game-genre').value;
    const horror=panel.querySelector('#game-horror').value;
    panel.classList.remove('show');
    /* Genre-specific Sui response before starting */
    const genreLines={
      fantasy:'有时我会感到幻想与现实之间的距离……并不远。',
      mystery:'神秘，会屈从于更高的神秘……这是谁的台词？',
      detective:'嗯？现在是侦探时间吗？',
      romance:'浪漫主义就是爱情的本质吗？',
      scifi:'我要穿着现在的衣服去玩吗？会不会不合氛围？'
    };
    const line=genreLines[genre]||'……';
    showDialogue('Sui',[line],()=>{
      closeDialogue();
      startAiGame(aiIdx, genre, horror);
    });
  });
  panel.querySelector('#game-ai-cancel').addEventListener('click',()=>{
    panel.classList.remove('show');
    G.state='idle';
  });
}

async function openCustomScriptSetup(){
  if(!G.viewport){G.state='idle';return}
  const hasApi=typeof apiConfigs!=='undefined'&&apiConfigs.length>0;
  const panel=G.viewport.querySelector('#game-ai-setup');
  if(!panel){G.state='idle';return}
  if(!hasApi){
    panel.innerHTML=`<h4>No API Configured</h4><p style="font-size:0.8rem;color:var(--text-muted);text-align:center">${FIXED_LINES.no_api}</p>
    <div class="game-ai-setup-actions"><button class="tarot-btn" id="game-ai-noapi-close">Close</button></div>`;
    panel.classList.add('show');
    panel.querySelector('#game-ai-noapi-close').addEventListener('click',()=>{panel.classList.remove('show');G.state='idle'});
    return;
  }
  /* Load blog posts (exclude locked diary) */
  let posts=[];
  try{const all=await dbGetAll('posts');posts=all.filter(p=>p.locked!==true&&p.category!=='🔒 密码日记本').sort((a,b)=>b.created-a.created)}catch(e){}
  if(!posts.length){
    panel.innerHTML=`<h4 style="font-family:'Noto Sans SC',sans-serif;font-style:normal">自定义剧本</h4><p style="font-size:0.85rem;color:var(--text-muted);text-align:center;line-height:1.8">Blog里还没有日志。\n请先去Blog写一篇日志作为剧本。</p>
    <div class="game-ai-setup-actions"><button class="tarot-btn" id="game-ai-noapi-close">Close</button></div>`;
    panel.classList.add('show');
    panel.querySelector('#game-ai-noapi-close').addEventListener('click',()=>{panel.classList.remove('show');G.state='idle'});
    return;
  }
  const esc=(typeof escapeHtml==='function')?escapeHtml:(s=>String(s));
  const apiOpts=apiConfigs.map((a,i)=>`<option value="${i}">${esc(a.nickname||a.model||'AI')}</option>`).join('');
  const postList=posts.map(p=>`<div class="game-script-item" data-pid="${p.id}" style="padding:10px 14px;margin-bottom:6px;border:1px solid rgba(175,195,228,0.15);border-radius:8px;cursor:pointer;transition:all 0.3s"><div style="font-size:0.88rem;color:var(--light);margin-bottom:3px">${esc(p.title||'无标题')}</div><div style="font-size:0.72rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((p.content||'').slice(0,60))}</div></div>`).join('');
  panel.innerHTML=`<h4 style="font-family:'Noto Sans SC',sans-serif;font-style:normal">自定义剧本</h4>
    <label>AI</label><select id="game-cs-ai">${apiOpts}</select>
    <label style="margin-top:12px">Genre</label><select id="game-cs-genre"><option value="fantasy">Fantasy</option><option value="mystery">Mystic</option><option value="detective">Detective</option><option value="romance">Romance</option><option value="scifi">Sci-Fi</option></select>
    <label style="margin-top:12px">Horror Elements</label><select id="game-cs-horror"><option value="no">No</option><option value="low">Low</option><option value="mid">Medium</option><option value="high">High</option></select>
    <label style="margin-top:12px">选择一篇日志作为剧本</label>
    <div id="game-cs-posts" style="max-height:200px;overflow-y:auto;margin-bottom:12px">${postList}</div>
    <div class="game-ai-setup-actions">
      <button class="tarot-btn" id="game-cs-start" style="opacity:0.4;pointer-events:none">开始</button>
      <button class="tarot-btn" id="game-cs-cancel">取消</button>
    </div>`;
  panel.classList.add('show');
  panel.style.maxHeight='80%';

  let selectedPostId=null;
  panel.querySelectorAll('.game-script-item').forEach(item=>{
    item.addEventListener('mouseover',()=>item.style.borderColor='rgba(175,195,228,0.4)');
    item.addEventListener('mouseout',()=>{if(item.dataset.pid!==selectedPostId)item.style.borderColor='rgba(175,195,228,0.15)'});
    item.addEventListener('click',()=>{
      panel.querySelectorAll('.game-script-item').forEach(el=>el.style.borderColor='rgba(175,195,228,0.15)');
      item.style.borderColor='var(--accent)';
      selectedPostId=item.dataset.pid;
      const startBtn=panel.querySelector('#game-cs-start');
      startBtn.style.opacity='1';startBtn.style.pointerEvents='auto';
    });
  });

  panel.querySelector('#game-cs-start').addEventListener('click',async()=>{
    if(!selectedPostId)return;
    const aiIdx=parseInt(panel.querySelector('#game-cs-ai').value);
    const genre=panel.querySelector('#game-cs-genre').value;
    const horror=panel.querySelector('#game-cs-horror').value;
    const post=posts.find(p=>p.id===selectedPostId);
    if(!post){if(typeof toast==='function')toast('日志不存在');return}
    panel.classList.remove('show');
    showDialogue('Sui',['收到。让我先看一下你的剧本……'],()=>{
      closeDialogue();
      startAiGame(aiIdx,genre,horror,post.content);
    });
  });
  panel.querySelector('#game-cs-cancel').addEventListener('click',()=>{
    panel.classList.remove('show');
    G.state='idle';
  });
}

function startAiGame(aiIdx, genre, horror, customScript){
  G.aiGameActive=true;
  G.aiGameRound=0;
  G.aiGameHistory=[];
  G._aiSession=(G._aiSession||0)+1;/* FIX: 会话令牌，作废上一局可能仍在途的请求 */
  G._progressSaving=false;
  G._aiCfg=apiConfigs[aiIdx];
  G._aiGenre=genre;
  G._aiHorror=horror;
  G._aiCustomScript=customScript||null;
  /* BUG-4 fix: load this AI's custom DIY portrait (portrait_[nickname].png).
     The quick local fetch finishes well before the first networked AI reply,
     so the portrait is ready when the AI's first line is shown. */
  G._aiPortraitImg=null;
  loadCustomPortrait(G._aiCfg).then(img=>{ G._aiPortraitImg=img; });
  /* Lock movement — gray out sidebar buttons */
  disableSidebarButtons(true);
  /* Hide Sui character → show desk reading sprite with typewriter bubble */
  showDeskSprite();
  openStoryWindow();/* Story常驻视窗：开窗淡入（Replay重开新局时复用同一视窗） */

  const personalize=!!(G._aiCfg&&G._aiCfg.storyPersonalize);
  const relHint2=personalize&&G._aiCfg.relationship?'你和玩家的关系是：'+G._aiCfg.relationship+'。\n':'';
  /* BUGFIX v1.0.2: 界面选项的英文代号先翻译成中文,避免 prompt 中英夹杂 */
  const GENRE_CN={fantasy:'奇幻',mystery:'神秘学',detective:'推理悬疑',romance:'恋爱',scifi:'科幻'};
  const HORROR_CN={low:'轻微',mid:'中等',high:'强烈'};
  let sysPrompt;
  if(customScript){
    sysPrompt=relHint2+`请扮演互动小说/文字冒险游戏的游戏主持人。
以下是玩家提供的自定义剧本，请根据剧本内容来主持游戏：

「${customScript.slice(0,3000)}」

玩家选择的游戏类型为${GENRE_CN[genre]||genre}，选择的恐怖度为${horror==='no'?'无':(HORROR_CN[horror]||horror)}。
请按照剧本中的世界观、角色和剧情逻辑来推进故事。如果剧本只提供了方向性描述，请自由发挥细节。
每次给出一段剧情描述（200字以内），然后提供3个选项让玩家选择。
故事在第12轮（可酌情增加到12到16轮）结束时导向结局。共有3个普通结局和1个隐藏结局。
请以JSON格式回复：
{"story":"剧情文字","choices":["选项1","选项2","选项3"],
 "isEnding":false,"endingType":null,"mood":"calm"}
其中mood字段表示Sui听到这段剧情时的情绪反应，只能取以下5个值之一：calm（平静日常）、joy（开心愉悦）、tense（紧张警惕）、sad（悲伤难过）、shock（震惊意外）。请根据剧情走向与玩家上一个选项造成的后果来选择。
不要输出任何JSON以外的内容。`;
  }else{
    const genreHint=genre==='detective'?'玩家将扮演侦探角色来破案。请设计一个有悬念的案件，提供线索、嫌疑人和推理环节，让玩家通过选择来收集证据、审讯嫌疑人并最终揭开真相。\n'
      :genre==='mystery'?'故事围绕神秘学与宗教展开。创作题材可从以下方向选取（不限于此）：塔罗象征、炼金术、卡巴拉、赫尔墨斯主义、蔷薇十字会、诺斯替主义、基督教密契传统、佛教、密宗、苏菲派、神道教等。恐怖程度较低时以经典神秘传统为主；恐怖程度较高时可加入虚构的异端教派、架空的禁忌仪式、洛夫克拉夫特式宇宙恐怖、以及你自由创作的邪典体系——但所有黑暗或邪典内容必须是虚构的，禁止引用现实中的邪教事件或真实犯罪。请用通俗易懂的方式讲故事，玩家不需要专业知识也能玩得开心。\n':'';
    sysPrompt=relHint2+`请扮演互动小说/文字冒险游戏的游戏主持人来主持这个游戏。
用户选择了${GENRE_CN[genre]||genre}类型游戏，恐怖设定为${horror==='no'?'否':'是'}${horror!=='no'?'，程度为'+(HORROR_CN[horror]||horror):''}。
${genreHint}每次给出一段剧情描述（180字以内），然后提供3个选项让玩家选择。
故事在第12轮（可酌情增加到12到16轮）结束时导向结局。共有3个普通结局和1个隐藏结局。
请以JSON格式回复：
{"story":"剧情文字","choices":["选项1","选项2","选项3"],
 "isEnding":false,"endingType":null,"mood":"calm"}
其中mood字段表示Sui听到这段剧情时的情绪反应，只能取以下5个值之一：calm（平静日常）、joy（开心愉悦）、tense（紧张警惕）、sad（悲伤难过）、shock（震惊意外）。请根据剧情走向与玩家上一个选项造成的后果来选择。
不要输出任何JSON以外的内容。`;
  }
  /* Stack with custom API system prompt only when storyPersonalize is on */
  if(personalize){
    const apiCustom=(G._aiCfg.systemPrompt||'').trim();
    if(apiCustom) sysPrompt=apiCustom+'\n\n---\n\n'+sysPrompt;
  }
  G._aiSysPrompt=sysPrompt;
  G._aiMemInjected=false;

  /* Send first message */
  aiGameTurn('开始游戏');
}

const ENDING_ANNOUNCE='故事到这里就结束了，感谢你陪我走完这段旅程。\n请点击新弹出的按钮：\nSave — 整理完整设定文档并保存\nReplay — 用相同设定再来一局\nExit — 离开故事模式';

/* 结局操作按钮（主路径与Back恢复路径共用，修复旧版恢复路径里Exit不询问存档的不一致） */
/* 存档结果反馈：成功 / 仅存原始记录 / 彻底失败。彻底失败时不退出游戏，
   让玩家停在结局页可再按一次Save重试，避免记录无声丢失。 */
function finishGameSave(res){
  if(res==='busy')return;/* 连点产生的第二次调用，交给第一次处理 */
  if(res==='fail'){
    showDialogue('Sui',['抱歉，由于未知原因，我无法写入设定文档。\n可再次点击Save重试，或查看Blog是否有部分写入。'],()=>{showEndingActions()});
    return;
  }
  if(res==='raw'){
    showDialogue('Sui',['由于未知原因，我未能写入完整的设定文档。我已经保存了部分的原始记录文档。'],()=>{closeDialogue();endAiGame()});
    return;
  }
  showDialogue('Sui',['已整理完毕。我已将完整的设定文档写入密码日记本。'],()=>{closeDialogue();endAiGame()});
}
function showEndingActions(){
  showDialogueActions([
    {label:'Save',cb:()=>{ showDialogue('Sui',['明白。正在帮你整理故事记录……'],null); saveGameAsBlog().then(r=>finishGameSave(r)).catch(()=>finishGameSave('fail')) }},
    {label:'Replay',cb:()=>{ closeDialogue(); /* FIX: 按id查找而非indexOf，避免apiConfigs数组被重载后误报"已删除" */ const idx=apiConfigs.findIndex(a=>G._aiCfg&&a.id===G._aiCfg.id); if(idx<0){if(typeof toast==='function')toast('该API已被删除，请重新选择');openAiSetup();return} startAiGame(idx,G._aiGenre,G._aiHorror,G._aiCustomScript); }},
    {label:'Exit',cb:()=>{
      showDialogue('Sui',['要先把这次的游戏记录存档到密码日记本再离开吗？'],()=>{
        showDialogueActions([
          {label:'存档并离开',cb:()=>{showDialogue('Sui',['明白。正在帮你整理故事记录……'],null);saveGameAsBlog().then(r=>finishGameSave(r)).catch(()=>finishGameSave('fail'))}},
          {label:'直接离开',cb:()=>{closeDialogue();endAiGame()}}
        ]);
      });
    }}
  ]);
}

async function aiGameTurn(userChoice){
  G.aiGameRound++;
  G.aiGameHistory.push({role:'user',content:userChoice});
  await aiGameSend();
}

/* 发送当前回合。与aiGameTurn拆开，使"重试"不会重复推进轮数、重复写入历史 */
async function aiGameSend(){
  const session=G._aiSession;
  G._aiSending=true;

  /* 首轮注入记忆到system prompt（仅storyPersonalize开启时） */
  if(G.aiGameRound<=1&&!G._aiMemInjected&&G._aiCfg&&G._aiCfg.storyPersonalize){
    G._aiMemInjected=true;
    try{
      if(typeof getMemoryContext==='function'){
        const memCtx=await getMemoryContext(G._aiCfg.id,{maxChars:1000});
        if(memCtx)G._aiSysPrompt+='\n\n'+memCtx;
      }
    }catch(e){}
  }

  const recentHistory=G.aiGameHistory.length>40?G.aiGameHistory.slice(-40):G.aiGameHistory;
  const msgs=recentHistory.map(m=>({role:m.role,content:m.content}));
  const messages=[{role:'system',content:G._aiSysPrompt},...msgs];

  /* Show Sui thinking "……" while waiting for AI — portrait shown */
  showDialogue('Sui',[FIXED_LINES.thinking],null);

  try{
    const reply = _isStreamEnabled(G._aiCfg) ? await callApiChatStream(G._aiCfg, messages) : await callApiChat(G._aiCfg, messages);
    G._aiSending=false;
    if(!G.aiGameActive||session!==G._aiSession)return;/* 玩家已退出，丢弃迟到响应 */
    if(!reply||!String(reply).trim()){aiGameError('连接失败，请检查API配置和网络连接。');return}
    G.aiGameHistory.push({role:'assistant',content:reply});

    let data;
    try{
      data=extractJSON(reply);
    }catch(e){
      data={story:reply,choices:['继续','返回'],isEnding:false};
    }
    if(typeof data.story!=='string'||!data.story.trim())data.story=String(reply);
    if(!data.isEnding&&(!Array.isArray(data.choices)||!data.choices.length))data.choices=['继续'];
    storyWinMood(data.mood);

    /* Show story in dialogue under AI narrator name */
    const name = G._aiCfg.nickname||'???';
    G._lastStoryState={name,data};
    showDialogue(name, [data.story], ()=>{
      if(data.isEnding){
        showDialogue(name,[ENDING_ANNOUNCE],()=>{showEndingActions()});
      }else if(data.choices && data.choices.length){
        showChoices(data.choices, (choice)=>{
          showDialogue('Sui',[FIXED_LINES.thinking],()=>{
            aiGameTurn(choice);
          });
        });
      }
    });
  }catch(err){
    G._aiSending=false;
    if(!G.aiGameActive||session!==G._aiSession)return;
    aiGameError(err.message||'请检查API配置');
  }
}

/* FIX: 错误不再直接终结整局游戏（旧版一次超时/429就毁掉十几轮进度），改为提供重试 */
function aiGameError(msg){
  storyWinError();/* Story视窗：“！”报错演出 */
  const m=String(msg||'未知错误').slice(0,80);
  showDialogue('Sui',['连接遇到了问题：'+m+'\n请选择重试、存档，或退出Story模式。'],()=>{
    showDialogueActions([
      {label:'重试',cb:()=>{aiGameSend()}},
      {label:'存档并退出',cb:()=>{showDialogue('Sui',['收到。正在帮你保存当前进度……'],null);saveGameProgress().then(()=>{closeDialogue();endAiGame()}).catch(()=>{closeDialogue();endAiGame()})}},
      {label:'退出',cb:()=>{closeDialogue();endAiGame()}}
    ]);
  });
}

function endAiGame(){
  closeStoryWindow();/* Story视窗：淡出并销毁 */
  hideDeskSprite();/* 书桌精灵：收起，恢复角色 */
  G.aiGameActive=false;
  G._aiSession=(G._aiSession||0)+1;
  G._aiSending=false;
  G._storyExitWarning=false;
  G._lastStoryState=null;
  G._aiCustomScript=null;
  G._aiPortraitImg=null;
  G.state='idle';
  disableSidebarButtons(false);
}

/* ── 游戏内进度存档（常驻Save按钮）──────────────────────
   与"结局后Save"分工：进度存档=把目前为止的剧情与选择原样快照进密码日记本，
   瞬时完成、不调用API、不打断游戏；结局后Save=让AI整理完整设定文档。 */
async function saveGameProgress(){
  if(typeof dbPut==='undefined'){if(typeof toast==='function')toast('存档功能不可用');return}
  if(!G.aiGameActive||!G.aiGameHistory||!G.aiGameHistory.length){if(typeof toast==='function')toast('暂无可存档的进度');return}
  if(G._progressSaving)return;/* 防连点 */
  G._progressSaving=true;
  storyWinSave('saving');/* Story视窗：SAVING…演出 */
  try{
    let content='【互动故事 · 进度存档】（第'+G.aiGameRound+'轮，故事进行中）\n\n';
    G.aiGameHistory.forEach(m=>{
      try{
        if(m.role==='assistant'){
          const d=extractJSON(m.content);
          content+=d.story+'\n\n';
          if(d.choices)content+='选项: '+d.choices.join(' / ')+'\n\n';
        }else{content+='▸ '+m.content+'\n\n'}
      }catch(e){content+=m.content+'\n\n'}
    });
    const post={id:'post_'+Date.now(),title:'📖 Story 进度 — '+((G._aiCfg&&G._aiCfg.nickname)||'AI'),
      subtitle:'第'+G.aiGameRound+'轮 · 进行中',locked:true,category:'',content,created:Date.now(),updated:Date.now()};
    await ensureDiaryInit();
    await dbPut('posts',post);
    if(typeof toast==='function')toast('已存档当前进度（第'+G.aiGameRound+'轮）');
    storyWinSave('ok');
  }catch(e){
    if(typeof toast==='function')toast('进度存档失败');
    storyWinSave('fail');
  }
  G._progressSaving=false;
}

async function saveGameAsBlog(){
  if(typeof dbPut==='undefined')return 'fail';
  if(G._docSaving)return 'busy';/* 防重复触发：结局Save与"存档并离开"被连点时只生成一份 */
  G._docSaving=true;
  storyWinSave('saving');/* Story视窗：SAVING…演出 */
  /* FIX: 入口处快照全部所需状态——之后无论玩家多快退出/开新局，存档内容都不受影响 */
  const cfg=G._aiCfg;
  const round=G.aiGameRound;
  const hist=(G.aiGameHistory||[]).slice();
  const genre=G._aiGenre||'fantasy';
  const horror=G._aiHorror||'no';
  const aiName=(cfg&&cfg.nickname)||'AI';
  /* 原始记录（可读版）：用于保险落地与生成失败兜底 */
  let rawContent='';
  hist.forEach(m=>{
    try{
      if(m.role==='assistant'){
        const d=extractJSON(m.content);
        rawContent+=d.story+'\n\n';
        if(d.choices)rawContent+='选项: '+d.choices.join(' / ')+'\n\n';
      }else{rawContent+='▸ '+m.content+'\n\n'}
    }catch(e){rawContent+=m.content+'\n\n'}
  });
  let postId=null;
  const createdAt=Date.now();
  try{
    if(typeof callApiChat==='undefined'||!cfg){
      /* Fallback: save raw history if no AI available */
      await ensureDiaryInit();
      await dbPut('posts',{id:'post_'+Date.now(),title:'Interactive Story - '+aiName,
        subtitle:'Round '+round,locked:true,category:'',content:'【互动故事记录】\n\n'+rawContent,
        created:createdAt,updated:createdAt});
      if(typeof toast==='function') toast('故事已保存到Blog');
      storyWinSave('ok');
      return 'raw';
    }

    /* FIX①: 先把原始记录"保险落地"再调用AI——即使生成期间关闭页面/断网/中转挂掉，
       这局故事也已经在密码日记本里了；生成成功后会用完整设定文档原地替换这篇日志。 */
    postId='post_'+Date.now();
    await ensureDiaryInit();
    await dbPut('posts',{id:postId,title:'📜 Story Design — '+aiName,
      subtitle:'设定文档生成中… · '+round+' Rounds',locked:true,category:'',
      content:'（AI正在为你生成完整设定文档，完成后本文档会被自动替换。如果本文档一直停留在这句话，说明生成已中断。以下是被我截断的原始记录。）\n\n'+rawContent,
      created:createdAt,updated:createdAt});

    if(typeof toast==='function') toast('正在生成完整设定文档...');

    const historyText = hist.map(m=>{
      if(m.role==='user') return '[Player] '+m.content;
      try{
        const d=extractJSON(m.content);
        return '[GM] '+d.story+(d.choices?' | Choices: '+d.choices.join(', '):'')+(d.isEnding?' [ENDING: '+d.endingType+']':'');
      }catch(e){return '[GM] '+m.content}
    }).join('\n');

    const docPrompt=`Based on the following interactive story session, generate a COMPLETE game design document in Chinese. Include ALL of the following sections:

## 游戏概要
Brief overview of the story world, theme, and core concept.

## 完整剧本
The full script/narrative of what happened, written as a readable story.

## 游戏机制
- Scoring system (what gives points, point values)
- Key decision points and their consequences

## 多结局设定
List ALL possible endings (not just the one reached), including:
- Normal endings (at least 3)
- Hidden/secret ending(s)
- How each ending is triggered (conditions)

## 隐藏要素
- Secret items, easter eggs, hidden dialogue triggers
- Special combinations that unlock hidden content

## 角色与世界观
Character descriptions, world lore, key locations

---
Session log:
${historyText}
---
Genre: ${genre}, Horror level: ${horror}
Write the document entirely in Chinese. Be creative and comprehensive — expand beyond what was explicitly shown in the session to create a full game design.`;

    /* FIX②: 文档生成是长输出，单独放宽超时到90秒（普通对话仍是30秒）；
       FIX③: 检测输出是否被 max_tokens 上限截断——无论是本地的4096还是中转端点自己的上限——
       被截断就让模型从断点续写并拼接，最多4段。这是"存进去的文档不完整"的根治。 */
    const baseMsgs=[
      {role:'system',content:'你是一个专业的游戏设计师，擅长将互动故事会话整理为完整的游戏设计文档。输出纯文本，不使用markdown代码块。'},
      {role:'user',content:docPrompt}
    ];
    let doc='',truncated=false;
    for(let seg=0;seg<4;seg++){
      const msgs=seg===0?baseMsgs:baseMsgs.concat([
        {role:'assistant',content:doc},
        {role:'user',content:'继续。直接从中断处接着输出剩余内容，不要重复已输出的部分，也不要加任何说明。'}
      ]);
      const r=await callApiChat(cfg,msgs,{maxTokens:8192,timeoutMs:90000,wantMeta:true});
      /* 兼容旧版 callApiChat（直接返回字符串）：当作单段完整输出处理 */
      const piece=(r&&typeof r==='object')?String(r.text||''):String(r||'');
      truncated=!!(r&&typeof r==='object'&&r.truncated);
      doc+=piece;
      if(!truncated||!piece.trim())break;
    }
    if(!doc.trim())throw new Error('AI返回了空文档');
    if(truncated)doc+='\n\n（注：文本内容过长，连续4段输出后依然超过上限字符数，已在此截断。）';

    await dbPut('posts',{id:postId,title:'📜 Story Design — '+aiName,
      subtitle:'Full Game Design Document · '+round+' Rounds',locked:true,category:'',
      content:doc.trim(),created:createdAt,updated:Date.now()});
    if(typeof toast==='function') toast('完整设定文档已保存到Blog');
    storyWinSave('ok');
    return 'doc';
  }catch(e){
    console.warn('[SuiGame] Design doc generation failed:',e);
    /* Fallback: 把"保险落地"那篇原地转正为原始记录（同一id覆盖，不会产生第二篇） */
    try{
      await ensureDiaryInit();
      await dbPut('posts',{id:postId||('post_'+Date.now()),title:'Interactive Story - '+aiName,
        subtitle:'Round '+round,locked:true,category:'',content:'【互动故事记录】\n\n'+rawContent,
        created:createdAt,updated:Date.now()});
      if(typeof toast==='function') toast('故事已保存到Blog（设定生成失败，已保存原始记录）');
      storyWinSave('ok');
      return 'raw';
    }catch(e2){
      if(typeof toast==='function') toast('存档失败：'+String((e2&&e2.message)||e2).slice(0,40));
      storyWinSave('fail');
      return 'fail';
    }
  }finally{
    G._docSaving=false;
  }
}
/* ════════════════════════════════════════════════════════════════════════
   STORY WINDOW —— Room-story 常驻演出视窗（古早像素风）
   ────────────────────────────────────────────────────────────────────────
   · startAiGame() 开窗淡入 / endAiGame() 淡出销毁（Replay 重开新局复用同一视窗）
   · 昼夜双图层 0.6s 交叉渐隐，MutationObserver 跟随 body 主题class 实时切换
   · Sui 精灵横排 6 帧循环；5 种情绪（calm/joy/tense/sad/shock）
     分别对应不同帧速 + 位移动画 + 头顶像素表情气泡
   · AI 思考（对话框弹“……”）→ 视窗内 Sui 头顶“......”打字机气泡反复播放
   · 存档 SAVING… / SAVE OK! / SAVE FAIL 像素面板演出；报错“！”演出
   · 窗体淡入淡出（scale 0.95→1 + opacity，0.5s）与昼夜双图层切换的
     CSS 手法照搬 Tea 选茶面板
   ════════════════════════════════════════════════════════════════════════ */
const SW_W=608, SW_H=375;            /* 视窗背景素材原始尺寸（1:1摆进1672×941画布，不再缩小） */
const SW_TOP=86;                     /* 视窗顶边y（画布坐标）；水平居中——位置按示意图实测 */
const SW_SPR_X=302, SW_SPR_Y=263;    /* 精灵锚点：中心x=302、底边y=263（盖住椅子、手搭桌沿，按示意图实测） */
const SW_SPR_FRAMES=5;               /* 精灵图5列（按轮次顺序播放） */
let SW_SPR_W=750/5, SW_SPR_H=98;     /* 单帧尺寸（素材载入后自动校正：宽÷5列，高÷2行） */
const SW_MOODS=['calm','joy','tense','sad','shock'];
const SW_MOOD_MS={calm:800,joy:650,tense:700,sad:900,shock:700}; /* 帧间隔ms：整体放慢，呼吸节奏 */
const SW_MOOD_COL={calm:2,joy:0,tense:1,sad:3,shock:4}; /* 情绪→精灵列：calm/存档=第3组 */
/* ── Desk sprite 书桌精灵（Story模式时Sui趴在书桌上睡觉） ── */
const DESK_SPR_CX=1282, DESK_SPR_BY=438;
const DESK_SPR_FW=150, DESK_SPR_FH=100; /* 书桌图 150×200，上下2帧各100px */

/* ── 像素SVG图标（crispEdges硬边方块拼接） ── */
const SW_SVG=(function(){
  const P=(x,y,w,h,c)=>'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+c+'"/>';
  const D='#26233a', W='#fffdf5', F='#f6f3e8';
  /* 16×16 小表情气泡（白底深边 + 底部阶梯小尾巴），inner 为内嵌字形 */
  function balloon(inner){
    return '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
      +P(2,0,12,1,D)
      +P(1,1,14,1,D)+P(2,1,12,1,W)
      +P(0,2,16,9,D)+P(1,2,14,9,W)
      +P(1,11,14,1,D)+P(2,11,12,1,W)
      +P(2,12,12,1,D)+P(6,12,2,1,W)
      +P(5,13,1,1,D)+P(6,13,2,1,W)+P(8,13,1,1,D)
      +P(5,14,1,1,D)+P(6,14,1,1,W)+P(7,14,1,1,D)
      +P(5,15,2,1,D)
      +inner+'</svg>';
  }
  return {
    /* joy：深色八分音符 ♪ */
    joy:balloon(P(9,3,1,6,D)+P(10,3,2,1,D)+P(11,4,1,3,D)+P(7,7,2,1,D)+P(6,8,3,2,D)),
    /* tense：蓝色汗滴（带高光） */
    tense:balloon(P(7,3,1,1,'#5b8bd9')+P(6,4,3,2,'#5b8bd9')+P(5,6,5,3,'#5b8bd9')+P(6,9,3,1,'#5b8bd9')+P(6,6,1,2,'#cfe0ff')),
    /* sad：三根高低错落的蓝灰下垂线 */
    sad:balloon(P(4,4,1,4,'#6a7aa8')+P(7,3,1,6,'#6a7aa8')+P(10,5,1,4,'#6a7aa8')),
    /* shock：黄色十字爆点 + 四角火花 */
    shock:balloon(P(7,3,2,7,'#f0b840')+P(4,5,8,2,'#f0b840')+P(4,3,1,1,'#f0b840')+P(11,3,1,1,'#f0b840')+P(4,9,1,1,'#f0b840')+P(11,9,1,1,'#f0b840')),
    /* err：红色“！” */
    err:balloon(P(7,2,2,6,'#d8454f')+P(7,9,2,2,'#d8454f')),
    /* floppy：存档软盘（深框/蓝身/白快门/白标签） */
    floppy:'<svg class="sw-floppy" viewBox="0 0 9 9" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
      +P(0,0,9,9,D)+P(1,1,7,7,'#4a6fb8')+P(3,1,4,3,'#cfd6e8')+P(4,2,1,2,'#4a6fb8')+P(2,5,5,3,F)+P(3,6,3,1,'#9aa3bf')+'</svg>',
    /* tail：“……”大气泡底部的阶梯尾巴（8×4，颜色与气泡同底） */
    tail:'<svg class="sw-tail" viewBox="0 0 8 4" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
      +P(0,0,1,1,D)+P(1,0,6,1,F)+P(7,0,1,1,D)
      +P(1,1,1,1,D)+P(2,1,4,1,F)+P(6,1,1,1,D)
      +P(2,2,1,1,D)+P(3,2,2,1,F)+P(5,2,1,1,D)
      +P(3,3,2,1,D)+'</svg>'
  };
})();

/* ── 视窗样式（淡入淡出手法与 Tea 面板一致：scale+opacity 0.5s ease） ── */
const STORY_CSS=`
/* ── STORY WINDOW（Room-story 常驻视窗 · 像素风） ── */
.game-story-win{position:absolute;top:${SW_TOP}px;left:${(GAME_W-SW_W)/2}px;width:${SW_W}px;height:${SW_H}px;z-index:18;pointer-events:none;opacity:0;transform:scale(0.96);transform-origin:top center;transition:transform .5s ease,opacity .5s ease}
.game-story-win.show{opacity:1;transform:scale(1)}
/* 素材自带哥特边框、透明底——不加底色/描边，只留一层柔和投影把视窗从房间里衬出来 */
.sw-stage{position:absolute;top:0;left:0;width:${SW_W}px;height:${SW_H}px;filter:drop-shadow(0 6px 14px rgba(8,6,18,.55))}
/* 昼/夜双图层交叉渐隐（同 Tea 面板换肤手法） */
.sw-bg{position:absolute;left:0;top:0;width:100%;height:100%;transition:opacity .6s ease}
/* Sui 精灵（wrapper 吃情绪位移动画，sheet 吃帧动画） */
.sw-sprite{position:absolute;left:${SW_SPR_X}px;bottom:${SW_H-SW_SPR_Y}px;margin-left:${-SW_SPR_W/2}px;z-index:2}
#sw-sheet{width:${SW_SPR_W}px;height:${SW_SPR_H}px;background:url('game/story_sprites.png') 0 0/500% 200% no-repeat;image-rendering:pixelated}
/* 头顶表情气泡 */
.sw-emote{position:absolute;left:348px;top:152px;width:64px;height:64px;transform:translate(-50%,-100%);z-index:4;opacity:0;pointer-events:none}
.sw-emote svg{width:100%;height:100%;display:block}
.sw-emote.show{opacity:1;animation:swEmotePop .28s steps(3) both}
@keyframes swEmotePop{0%{transform:translate(-50%,-100%) scale(0)}60%{transform:translate(-50%,-100%) scale(1.15)}100%{transform:translate(-50%,-100%) scale(1)}}
.sw-emote-err svg{animation:swShakeX .4s steps(2) 4}
/* “......”打字机气泡 */
.sw-bubble{position:absolute;left:302px;top:156px;transform:translate(-50%,-100%);z-index:5;background:#f6f3e8;border:3px solid #26233a;box-shadow:3px 3px 0 rgba(38,35,58,.55);padding:5px 10px 7px;opacity:0;pointer-events:none}
.sw-bubble.show{opacity:1}
#sw-bubble-text{display:inline-block;width:105px;height:24px;line-height:24px;overflow:hidden;font-family:'Courier New',monospace;font-weight:bold;font-size:24px;letter-spacing:3px;color:#26233a;text-align:left;white-space:pre}
.sw-bubble .sw-tail{position:absolute;left:50%;bottom:-13px;width:32px;height:16px;margin-left:-16px;display:block}
/* 存档提示面板 */
.sw-save{position:absolute;right:30px;bottom:26px;z-index:3;display:flex;align-items:center;gap:7px;background:#f6f3e8;border:3px solid #26233a;box-shadow:3px 3px 0 rgba(38,35,58,.55);padding:5px 9px;opacity:0;transform:translateY(4px);transition:opacity .2s steps(2),transform .2s steps(2);pointer-events:none}
.sw-save.show{opacity:1;transform:translateY(0)}
.sw-save .sw-floppy{width:27px;height:27px;display:block}
#sw-save-text{font-family:'Courier New',monospace;font-weight:bold;font-size:17px;letter-spacing:1px;color:#26233a;white-space:nowrap}
.sw-save.saving #sw-save-text::after{content:'';display:inline-block;width:30px;text-align:left;animation:swDots 1.2s steps(1) infinite}
@keyframes swDots{0%,100%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
.sw-save.saving .sw-floppy{animation:swBlink .8s steps(2) infinite}
@keyframes swBlink{50%{opacity:.25}}
.sw-save.ok{animation:swInvert .55s steps(2) 2}
@keyframes swInvert{50%{filter:invert(1)}}
.sw-save.fail #sw-save-text{color:#d8454f}
.sw-save.fail{animation:swShakeX .4s steps(2) 3}
@keyframes swShakeX{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
/* 5 种情绪位移动画（作用于精灵 wrapper） */
.sw-mood-joy{animation:swJoyHop .55s ease 2}
@keyframes swJoyHop{0%,100%{transform:translateY(0)}40%{transform:translateY(-13px)}}
.sw-mood-tense{/* 已移除左右抖动位移 */}
.sw-mood-sad{animation:swSad 3.2s ease-in-out infinite}
@keyframes swSad{0%,100%{transform:translateY(3px)}50%{transform:translateY(5px)}}
.sw-mood-shock{animation:swShock .55s ease 1}
@keyframes swShock{0%,100%{transform:translateY(0)}25%{transform:translateY(-16px) scaleY(1.04)}}
/* ── DESK SPRITE (Story mode · Room内书桌精灵) ──────── */
.game-desk-spr{position:absolute;left:${DESK_SPR_CX-DESK_SPR_FW/2}px;top:${DESK_SPR_BY-DESK_SPR_FH}px;
  width:${DESK_SPR_FW}px;height:${DESK_SPR_FH}px;z-index:8;pointer-events:none;
  image-rendering:pixelated;overflow:hidden;opacity:0;transition:opacity .5s ease}
.game-desk-spr.show{opacity:1}
#game-desk-sheet,#game-desk-sheet-inf{position:absolute;left:0;top:0;width:${DESK_SPR_FW}px;height:${DESK_SPR_FH}px;
  background-repeat:no-repeat;background-position:0 0;background-size:100% 200%;image-rendering:pixelated;transition:opacity .6s ease}
#game-desk-sheet{background-image:url('game/story_desk_internal.png')}
#game-desk-sheet-inf{background-image:url('game/story_desk_infernal.png');opacity:0}
body.theme-infernal #game-desk-sheet{opacity:0}
body.theme-infernal #game-desk-sheet-inf{opacity:1}
/* ── 睡梦气泡（书桌精灵头顶·图标+星星） ──── */
.game-desk-zzz{position:absolute;left:${DESK_SPR_CX-12}px;top:${DESK_SPR_BY-DESK_SPR_FH-30}px;
  z-index:9;pointer-events:none;opacity:0;transition:opacity .5s ease;
  width:74px;height:64px}
.game-desk-zzz.show{opacity:1}
.sleep-bubble-img{position:absolute;left:0;top:0;width:100%;height:100%;image-rendering:pixelated;display:block;transition:opacity .6s ease}
.sbi-infernal{opacity:0}
body.theme-infernal .sbi-internal{opacity:0}
body.theme-infernal .sbi-infernal{opacity:1}
.sleep-star{position:absolute;font-size:8px;color:#f5d97a;opacity:0;
  text-shadow:0 0 3px rgba(245,217,122,.6);pointer-events:none}
.game-desk-zzz.show .sleep-star{animation:sleepSparkle 2.8s ease-in-out infinite}
.sleep-star.s0{top:-4px;right:-2px;font-size:7px;animation-delay:0s}
.sleep-star.s1{top:6px;right:-8px;font-size:5px;animation-delay:.7s}
.sleep-star.s2{top:-6px;left:8px;font-size:6px;animation-delay:1.4s}
.sleep-star.s3{top:14px;right:-5px;font-size:4px;animation-delay:2.1s}
@keyframes sleepSparkle{0%,100%{opacity:0;transform:scale(.5) translateY(0)}
  20%{opacity:.7;transform:scale(1) translateY(-2px)}
  50%{opacity:.9;transform:scale(1.1) translateY(-4px)}
  80%{opacity:.4;transform:scale(.8) translateY(-6px)}}
`;

/* ── Desk sprite: Story 模式时 Sui 坐在书桌前，头顶飘打字机气泡 ── */
function showDeskSprite(){
  if(!G.viewport)return;
  const ch=G.viewport.querySelector('#game-char');
  if(ch) ch.style.display='none';
  const ds=G.viewport.querySelector('#game-desk-spr');
  if(ds) ds.classList.add('show');
  startDeskSprFrames();
  startDeskTypw();
}
function hideDeskSprite(){
  if(!G.viewport)return;
  stopDeskSprFrames();
  stopDeskTypw();
  const ds=G.viewport.querySelector('#game-desk-spr');
  if(ds) ds.classList.remove('show');
  const ch=G.viewport.querySelector('#game-char');
  if(ch) ch.style.display='block';
}
function startDeskSprFrames(){
  if(G._deskSprTimer)clearInterval(G._deskSprTimer);
  const sheets=G.viewport&&G.viewport.querySelectorAll('#game-desk-sheet,#game-desk-sheet-inf');
  if(!sheets||!sheets.length)return;
  let row=0;
  G._deskSprTimer=setInterval(()=>{
    row=row===0?1:0;
    const pos='0 '+(row*100)+'%';
    sheets.forEach(s=>{s.style.backgroundPosition=pos;});
  },650);
}
function stopDeskSprFrames(){
  if(G._deskSprTimer){clearInterval(G._deskSprTimer);G._deskSprTimer=null;}
}
function startDeskTypw(){
  const el=G.viewport&&G.viewport.querySelector('#game-desk-zzz');
  if(el) el.classList.add('show');
}
function stopDeskTypw(){
  const el=G.viewport&&G.viewport.querySelector('#game-desk-zzz');
  if(el) el.classList.remove('show');
}

/* ── 开窗（startAiGame 调用；Replay 重开新局时复用同一视窗，只重置状态） ── */
function openStoryWindow(){
  if(!G.viewport)return;
  const ensureObs=()=>{
    if(!G.swThemeObs){
      G.swThemeObs=new MutationObserver(()=>storyWinApplyTheme());
      G.swThemeObs.observe(document.body,{attributes:true,attributeFilter:['class']});
    }
  };
  if(G.swEl){
    /* Replay 复用：清演出、回到 calm、对齐当前主题 */
    ensureObs();
    G.swFrame=0;
    storyWinBubbleStop();
    storyWinSave(null);
    if(G.swEmoteTimer){clearTimeout(G.swEmoteTimer);G.swEmoteTimer=null;}
    const em=G.swEl.querySelector('#sw-emote');
    if(em){em.className='sw-emote';em.innerHTML='';}
    const sheet=G.swEl.querySelector('#sw-sheet');
    if(sheet)sheet.style.backgroundPosition='0% 0';
    storyWinMood('calm');
    storyWinApplyTheme();
    G.swEl.classList.add('show');
    return;
  }
  const night=document.body.classList.contains('theme-infernal');
  const win=document.createElement('div');
  win.id='game-story-win';
  win.className='game-story-win';
  win.innerHTML=`
    <div class="sw-stage">
      <img class="sw-bg" id="sw-bg-day" src="game/story_win_day.png" alt="" draggable="false" style="opacity:${night?0:1}">
      <img class="sw-bg" id="sw-bg-night" src="game/story_win_night.png" alt="" draggable="false" style="opacity:${night?1:0}">
      <div class="sw-sprite" id="sw-sprite"><div id="sw-sheet"></div></div>
      <div class="sw-emote" id="sw-emote"></div>
      <div class="sw-bubble" id="sw-bubble"><span id="sw-bubble-text"></span>${SW_SVG.tail}</div>
      <div class="sw-save" id="sw-save">${SW_SVG.floppy}<span id="sw-save-text"></span></div>
    </div>`;
  G.viewport.appendChild(win);
  G.swEl=win;
  /* 精灵帧宽自适应：素材载入后按 naturalWidth/6 校正（占位图/正式图均适配，无需改代码） */
  const probe=new Image();
  probe.onload=()=>{
    if(!G.swEl)return;
    const fw=probe.naturalWidth/SW_SPR_FRAMES, fh=probe.naturalHeight/2; /* 2行取半 */
    SW_SPR_W=fw; SW_SPR_H=fh;
    const sheet=G.swEl.querySelector('#sw-sheet');
    const spr=G.swEl.querySelector('#sw-sprite');
    if(sheet){sheet.style.width=fw+'px';sheet.style.height=fh+'px';}
    if(spr){spr.style.marginLeft=(-fw/2)+'px';}
  };
  probe.src='game/story_sprites.png';
  ensureObs();
  G.swFrame=0;
  storyWinMood('calm');
  /* 双 rAF 后加 .show —— 与 Tea 面板相同的淡入触发方式 */
  requestAnimationFrame(()=>{requestAnimationFrame(()=>{win.classList.add('show');});});
}

/* ── 关窗（endAiGame 调用）：清全部定时器与观察者，淡出后移除 ── */
function closeStoryWindow(){
  if(G.swFrameTimer){clearInterval(G.swFrameTimer);G.swFrameTimer=null;}
  if(G.swBubbleTimer){clearInterval(G.swBubbleTimer);G.swBubbleTimer=null;}
  if(G.swSaveTimer){clearTimeout(G.swSaveTimer);G.swSaveTimer=null;}
  if(G.swEmoteTimer){clearTimeout(G.swEmoteTimer);G.swEmoteTimer=null;}
  if(G.swThemeObs){G.swThemeObs.disconnect();G.swThemeObs=null;}
  G.swMood='calm';G.swFrame=0;
  const win=G.swEl;
  G.swEl=null;
  if(!win)return;
  win.classList.remove('show');
  setTimeout(()=>{if(win&&!win.classList.contains('show'))win.remove();},600);
}

/* ── 昼夜切换：双图层交叉渐隐（跟随 body.theme-infernal） ── */
function storyWinApplyTheme(){
  if(!G.swEl)return;
  const night=document.body.classList.contains('theme-infernal');
  const d=G.swEl.querySelector('#sw-bg-day');
  const n=G.swEl.querySelector('#sw-bg-night');
  if(d)d.style.opacity=night?'0':'1';
  if(n)n.style.opacity=night?'1':'0';
}

/* ── 帧循环：按当前情绪的帧间隔循环 1-6 帧 ── */
function storyWinStartFrames(){
  if(!G.swEl)return;
  if(G.swFrameTimer){clearInterval(G.swFrameTimer);G.swFrameTimer=null;}
  const sheet=G.swEl.querySelector('#sw-sheet');
  if(!sheet)return;
  const ms=SW_MOOD_MS[G.swMood]||SW_MOOD_MS.calm;
  const col=SW_MOOD_COL[G.swMood]!=null?SW_MOOD_COL[G.swMood]:SW_MOOD_COL.calm;
  G.swFrame=0;
  sheet.style.backgroundPosition=(col*25)+'% 0%';
  G.swFrameTimer=setInterval(()=>{
    G.swFrame=G.swFrame===0?1:0; /* 上下2帧切换 */
    sheet.style.backgroundPosition=(col*25)+'% '+(G.swFrame*100)+'%';
  },ms);
}

/* ── 情绪切换：换帧速 + 重触发位移动画 + 弹头顶表情（calm 不弹） ── */
function storyWinMood(m){
  if(!G.swEl)return;
  if(SW_MOODS.indexOf(m)<0)m='calm'; /* 非法/缺失值兜底 */
  G.swMood=m;
  const col=SW_MOOD_COL[m]!=null?SW_MOOD_COL[m]:SW_MOOD_COL.calm;
  const sheet=G.swEl.querySelector('#sw-sheet');
  if(sheet) sheet.style.backgroundPosition=(col*25)+'% 0%';
  const spr=G.swEl.querySelector('#sw-sprite');
  if(spr){
    spr.className='sw-sprite';
    void spr.offsetWidth;
    spr.classList.add('sw-mood-'+m);
  }
  storyWinStartFrames();
  if(m!=='calm')storyWinShowEmote(m,(m==='tense'||m==='sad')?2600:2000);
}

/* ── 头顶像素表情气泡：pop 弹出，定时自动收起 ── */
function storyWinShowEmote(kind,dur){
  if(!G.swEl)return;
  const em=G.swEl.querySelector('#sw-emote');
  if(!em)return;
  if(G.swEmoteTimer){clearTimeout(G.swEmoteTimer);G.swEmoteTimer=null;}
  em.className='sw-emote';
  void em.offsetWidth; /* 重触发 pop 动画 */
  em.innerHTML=SW_SVG[kind]||'';
  em.classList.add('show','sw-emote-'+kind);
  G.swEmoteTimer=setTimeout(()=>{
    em.className='sw-emote';em.innerHTML='';G.swEmoteTimer=null;
  },dur||2000);
}

/* ── “......”打字机气泡：150ms逐点 → 满字停4拍 → 清空重播，直到下一句对话 ── */
function storyWinBubbleStart(){
  if(!G.swEl)return;
  if(G.swBubbleTimer)return; /* 已在播放：保持节奏，不重置 */
  const bub=G.swEl.querySelector('#sw-bubble');
  const txt=G.swEl.querySelector('#sw-bubble-text');
  if(!bub||!txt)return;
  bub.classList.add('show');
  const DOTS='......';
  let i=0, hold=0;
  txt.textContent='';
  G.swBubbleTimer=setInterval(()=>{
    if(i<DOTS.length){i++;txt.textContent=DOTS.slice(0,i);}
    else if(hold<4){hold++;}
    else{i=0;hold=0;txt.textContent='';}
  },150);
}
function storyWinBubbleStop(){
  if(G.swBubbleTimer){clearInterval(G.swBubbleTimer);G.swBubbleTimer=null;}
  if(!G.swEl)return;
  const bub=G.swEl.querySelector('#sw-bubble');
  if(bub)bub.classList.remove('show');
}

/* ── 存档演出：'saving'=SAVING…+软盘闪烁 / 'ok'=SAVE OK!反色闪两下 /
       'fail'=SAVE FAIL红字抖动 / null=立即隐藏 ── */
function storyWinSave(state){
  if(!G.swEl)return;
  const sv=G.swEl.querySelector('#sw-save');
  const tx=G.swEl.querySelector('#sw-save-text');
  if(!sv||!tx)return;
  if(G.swSaveTimer){clearTimeout(G.swSaveTimer);G.swSaveTimer=null;}
  if(!state){sv.className='sw-save';return;}
  if(state==='saving'){
    tx.textContent='SAVING';
    sv.className='sw-save show saving';
  }else if(state==='ok'){
    tx.textContent='SAVE OK!';
    sv.className='sw-save show ok';
    G.swSaveTimer=setTimeout(()=>{sv.className='sw-save';G.swSaveTimer=null;},1600);
  }else if(state==='fail'){
    tx.textContent='SAVE FAIL';
    sv.className='sw-save show fail';
    G.swSaveTimer=setTimeout(()=>{sv.className='sw-save';G.swSaveTimer=null;},2600);
  }
}

/* ── 报错演出：停气泡 → 头顶红“！” → 精灵 shock 跳起 ── */
function storyWinError(){
  if(!G.swEl)return;
  storyWinBubbleStop();
  storyWinShowEmote('err',2600);
  const spr=G.swEl.querySelector('#sw-sprite');
  if(spr){
    spr.className='sw-sprite';
    void spr.offsetWidth;
    spr.classList.add('sw-mood-shock');
  }
}


/* ---- IB 命名空间迁移：双挂载（window 实时 + IB.game 合并注册）。严格模式保持：IIFE 开括号置于文件头注释之前。 ---- */
function ibGameLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.interactDesk=interactDesk;
window.openAiSetup=openAiSetup;
window.openCustomScriptSetup=openCustomScriptSetup;
window.startAiGame=startAiGame;
window.finishGameSave=finishGameSave;
window.showEndingActions=showEndingActions;
window.aiGameTurn=aiGameTurn;
window.aiGameSend=aiGameSend;
window.aiGameError=aiGameError;
window.endAiGame=endAiGame;
window.saveGameProgress=saveGameProgress;
window.saveGameAsBlog=saveGameAsBlog;
window.showDeskSprite=showDeskSprite;
window.hideDeskSprite=hideDeskSprite;
window.startDeskSprFrames=startDeskSprFrames;
window.stopDeskSprFrames=stopDeskSprFrames;
window.startDeskTypw=startDeskTypw;
window.stopDeskTypw=stopDeskTypw;
window.openStoryWindow=openStoryWindow;
window.closeStoryWindow=closeStoryWindow;
window.storyWinApplyTheme=storyWinApplyTheme;
window.storyWinStartFrames=storyWinStartFrames;
window.storyWinMood=storyWinMood;
window.storyWinShowEmote=storyWinShowEmote;
window.storyWinBubbleStart=storyWinBubbleStart;
window.storyWinBubbleStop=storyWinBubbleStop;
window.storyWinSave=storyWinSave;
window.storyWinError=storyWinError;
window.ENDING_ANNOUNCE=ENDING_ANNOUNCE;
window.SW_W=SW_W;
window.SW_TOP=SW_TOP;
window.SW_SPR_X=SW_SPR_X;
window.SW_SPR_FRAMES=SW_SPR_FRAMES;
window.SW_MOODS=SW_MOODS;
window.SW_MOOD_MS=SW_MOOD_MS;
window.SW_MOOD_COL=SW_MOOD_COL;
window.DESK_SPR_CX=DESK_SPR_CX;
window.DESK_SPR_FW=DESK_SPR_FW;
window.SW_SVG=SW_SVG;
window.STORY_CSS=STORY_CSS;
window.SW_H=SW_H;
window.SW_SPR_Y=SW_SPR_Y;
window.DESK_SPR_BY=DESK_SPR_BY;
window.DESK_SPR_FH=DESK_SPR_FH;
ibGameLive('SW_SPR_W', function(){return SW_SPR_W}, function(v){SW_SPR_W=v});
ibGameLive('SW_SPR_H', function(){return SW_SPR_H}, function(v){SW_SPR_H=v});
NS.expose('game', {
  interactDesk: interactDesk,
  openAiSetup: openAiSetup,
  openCustomScriptSetup: openCustomScriptSetup,
  startAiGame: startAiGame,
  finishGameSave: finishGameSave,
  showEndingActions: showEndingActions,
  aiGameTurn: aiGameTurn,
  aiGameSend: aiGameSend,
  aiGameError: aiGameError,
  endAiGame: endAiGame,
  saveGameProgress: saveGameProgress,
  saveGameAsBlog: saveGameAsBlog,
  showDeskSprite: showDeskSprite,
  hideDeskSprite: hideDeskSprite,
  startDeskSprFrames: startDeskSprFrames,
  stopDeskSprFrames: stopDeskSprFrames,
  startDeskTypw: startDeskTypw,
  stopDeskTypw: stopDeskTypw,
  openStoryWindow: openStoryWindow,
  closeStoryWindow: closeStoryWindow,
  storyWinApplyTheme: storyWinApplyTheme,
  storyWinStartFrames: storyWinStartFrames,
  storyWinMood: storyWinMood,
  storyWinShowEmote: storyWinShowEmote,
  storyWinBubbleStart: storyWinBubbleStart,
  storyWinBubbleStop: storyWinBubbleStop,
  storyWinSave: storyWinSave,
  storyWinError: storyWinError,
  ENDING_ANNOUNCE: ENDING_ANNOUNCE,
  SW_W: SW_W,
  SW_TOP: SW_TOP,
  SW_SPR_X: SW_SPR_X,
  SW_SPR_FRAMES: SW_SPR_FRAMES,
  SW_MOODS: SW_MOODS,
  SW_MOOD_MS: SW_MOOD_MS,
  SW_MOOD_COL: SW_MOOD_COL,
  DESK_SPR_CX: DESK_SPR_CX,
  DESK_SPR_FW: DESK_SPR_FW,
  SW_SVG: SW_SVG,
  STORY_CSS: STORY_CSS,
  SW_H: SW_H,
  SW_SPR_Y: SW_SPR_Y,
  DESK_SPR_BY: DESK_SPR_BY,
  DESK_SPR_FH: DESK_SPR_FH,
  SW_SPR_W: SW_SPR_W,
  SW_SPR_H: SW_SPR_H,
});
})(window.IB || (window.IB = {}));
