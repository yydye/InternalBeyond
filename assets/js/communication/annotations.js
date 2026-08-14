/* BLOG ANNOTATIONS — Reading Companion（阅读伴侣）—— 自 communication.js 机械提取（只动位置，不改逻辑；加载于 communication.js 之前）。 */
(function(NS){
/* ═══════════════════════════════════════════════════
   BLOG ANNOTATIONS — Reading Companion (阅读伴侣)
   ═══════════════════════════════════════════════════ */
let _annoPostId='';let _annoSelText='';let _annoParaIdx=-1;let _annoSelectedAI=null;let _annoSelRange=null;

/* ── Create toolbar elements (once) ── */
(function _initAnnoToolbar(){
  if(document.getElementById('anno-toolbar'))return;
  const tb=document.createElement('div');tb.id='anno-toolbar';
  tb.innerHTML='<button class="anno-tb-btn" onclick="_annoCopy()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>复制</button><div class="anno-tb-sep"></div><div class="anno-tb-pen" id="anno-pen" onclick="_annoToggleDrop(event)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><span class="anno-sel-name" id="anno-sel-name"></span><div class="anno-tb-drop" id="anno-drop"></div></div>';
  document.body.appendChild(tb);
  const ib=document.createElement('div');ib.id='anno-input-bar';
  ib.innerHTML='<span class="ai-name" id="anno-inp-name"></span><span class="ai-dot">·</span><input id="anno-inp-field" maxlength="40" placeholder="Say something or don\'t" aria-label="批注内容" onkeydown="if(event.key===\'Enter\')_annoSend()" oninput="_annoLimitInput(this)"><button type="button" class="anno-send-btn" onclick="_annoSend()" aria-label="发送批注"><svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" stroke-width="2" stroke-linecap="round" width="12" height="12"><path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4z"/></svg></button>';
  document.body.appendChild(ib);
})();

/* Limit input: EN=1, CN=2, max 40 */
function _annoLimitInput(el){let len=0;let cut=-1;for(let i=0;i<el.value.length;i++){len+=(el.value.charCodeAt(i)>127?2:1);if(len>40&&cut<0)cut=i}if(cut>=0)el.value=el.value.slice(0,cut)}

/* ── Selection handler ── */
document.addEventListener('mouseup',function(e){
  const pvc=document.querySelector('#blog-read-view[style*="block"] .post-view-content');
  if(!pvc||!pvc.contains(e.target))return;
  /* Ignore selections inside annotation cards */
  if(e.target.closest('.anno-block'))return;
  const sel=window.getSelection();
  if(!sel||sel.isCollapsed||!sel.toString().trim()){_annoHideAll();return}
  const text=sel.toString().trim();if(!text||text.length<2)return;
  _annoSelText=text;
  /* Detect paragraph index */
  let node=sel.anchorNode;_annoParaIdx=-1;
  while(node&&node!==pvc){if(node.nodeType===1&&node.classList&&node.classList.contains('pv-para')){_annoParaIdx=parseInt(node.dataset.idx||'-1');break}node=node.parentNode}
  /* Apply temporary underline highlight */
  _annoClearTempHL();
  try{const range=sel.getRangeAt(0);_annoSelRange=range.cloneRange();
    const wrapper=document.createElement('span');wrapper.className='pv-sel-active';wrapper.id='anno-temp-hl';
    range.surroundContents(wrapper);sel.removeAllRanges();
  }catch(ex){/* complex selections across nodes */}
  /* Position toolbar */
  const hlEl=document.getElementById('anno-temp-hl');
  const anchor=hlEl||pvc;
  const rect=hlEl?hlEl.getBoundingClientRect():e.target.getBoundingClientRect();
  const tb=document.getElementById('anno-toolbar');
  _annoPopulateDrop();
  tb.classList.add('show');
  tb.style.left=Math.max(8,rect.left+rect.width/2-tb.offsetWidth/2)+'px';
  tb.style.top=Math.max(8,rect.top-42+window.scrollY)+'px';
  tb.style.position='absolute';
  document.getElementById('anno-input-bar').classList.remove('show');
});

document.addEventListener('mousedown',function(e){
  const tb=document.getElementById('anno-toolbar');
  const ib=document.getElementById('anno-input-bar');
  if(tb&&!tb.contains(e.target)&&ib&&!ib.contains(e.target)){_annoHideAll()}
  if(!e.target.closest('.anno-tb-pen')){const pen=document.getElementById('anno-pen');if(pen)pen.classList.remove('open')}
});

document.addEventListener('contextmenu',function(e){
  const pvc=document.querySelector('#blog-read-view[style*="block"] .post-view-content');
  if(pvc&&pvc.contains(e.target)){e.preventDefault()}
});

function _annoClearTempHL(){const old=document.getElementById('anno-temp-hl');if(old){const p=old.parentNode;while(old.firstChild)p.insertBefore(old.firstChild,old);p.removeChild(old);p.normalize()}}

function _annoHideAll(){
  const tb=document.getElementById('anno-toolbar');if(tb)tb.classList.remove('show');
  const ib=document.getElementById('anno-input-bar');if(ib)ib.classList.remove('show');
  _annoSelectedAI=null;_annoSelRange=null;
  const sn=document.getElementById('anno-sel-name');if(sn)sn.textContent='';
  const pen=document.getElementById('anno-pen');if(pen)pen.classList.remove('open');
  _annoClearTempHL();
}

function _annoPopulateDrop(){
  const drop=document.getElementById('anno-drop');if(!drop)return;
  drop.innerHTML=apiConfigs.map(a=>'<div class="anno-tb-drop-item" onclick="_annoPickAI(\''+a.id+'\',event)"><span class="atdi-name">'+esc(a.nickname||a.model||'AI')+'</span><span class="atdi-check">✓</span></div>').join('');
}

function _annoCopy(){
  if(_annoSelText)navigator.clipboard?.writeText(_annoSelText).catch(()=>{});
  toast('已复制');_annoHideAll();window.getSelection()?.removeAllRanges();
}

function _annoToggleDrop(e){e.stopPropagation();document.getElementById('anno-pen').classList.toggle('open')}

function _annoPickAI(aiId,e){
  if(e)e.stopPropagation();
  const cfg=apiConfigs.find(a=>a.id===aiId);if(!cfg)return;
  _annoSelectedAI=cfg;
  document.getElementById('anno-sel-name').textContent=cfg.nickname||cfg.model;
  document.getElementById('anno-pen').classList.remove('open');
  document.querySelectorAll('.anno-tb-drop-item').forEach(el=>el.classList.remove('selected'));
  if(e&&e.currentTarget)e.currentTarget.classList.add('selected');
  const tb=document.getElementById('anno-toolbar');
  const rect=tb.getBoundingClientRect();
  tb.classList.remove('show');
  const ib=document.getElementById('anno-input-bar');
  ib.style.left=Math.max(8,rect.left)+'px';
  ib.style.top=rect.top+window.scrollY+'px';
  ib.style.position='absolute';
  ib.classList.add('show');
  document.getElementById('anno-inp-name').textContent=cfg.nickname||cfg.model;
  const field=document.getElementById('anno-inp-field');
  field.value='';field.placeholder='Say something or don\'t';field.focus();
}

async function _annoSend(){
  if(!_annoSelectedAI||!_annoPostId)return;
  const cfg=_annoSelectedAI;
  if(!_ibApiHasCredential(cfg)){toast('该 API 未配置密钥或本机端点');return}
  if(!cfg.endpoint){toast('该API未配置接口地址');return}
  /* Max 30 annotations per post */
  const existing=await _loadAnnotations(_annoPostId);
  if(existing.length>=30){toast('每篇日志最多 30 条批注');_annoHideAll();return}
  const userMsg=document.getElementById('anno-inp-field').value.trim();
  const selText=_annoSelText;
  const paraIdx=_annoParaIdx;
  _annoHideAll();window.getSelection()?.removeAllRanges();

  const post=await dbGet('posts',_annoPostId);if(!post)return;
  const paras=post.content.split(/\n\n+/);
  const paraText=paras[paraIdx]||'';

  const paraEl=document.querySelector('.pv-para[data-idx="'+paraIdx+'"]');
  const loadDiv=document.createElement('div');loadDiv.className='anno-block-loading';loadDiv.id='anno-loading-tmp';
  loadDiv.innerHTML='<span class="letter-loading-spinner"></span>'+esc(cfg.nickname||'AI')+' 正在批注…';
  if(paraEl)paraEl.insertAdjacentElement('afterend',loadDiv);

  const about=await dbGet('about','main');
  let prompt='';
  if(cfg.relationship)prompt+='你和对方的关系是：'+cfg.relationship+'。\n';
  prompt+='你现在正在陪TA阅读日志内容，用户在阅读过程中选中了一段文字。\n';
  if(about){prompt+='用户昵称：'+about.name+(about.bio?'（'+about.bio+'）':'')+'\n'}
  prompt+='\n【日志标题】'+(post.title||'无标题')+'\n';
  prompt+='【选中文字所在的段落】\n'+paraText+'\n';
  prompt+='【用户选中的文字】\n'+selText+'\n';
  if(userMsg){prompt+='【用户对你说的话】\n'+userMsg+'\n'}
  const memCtx=await getMemoryContext(cfg.id,{maxChars:800});
  if(memCtx)prompt+='\n'+memCtx;
  prompt+='\n【请求】\n';
  prompt+='请针对用户选中的文字写一段简短的批注或感想。';
  if(userMsg)prompt+='用户写了话，请优先回应用户的话。';
  else prompt+='用户没有写话，请自由发挥。';
  prompt+='自然地分享你的理解、感受、或提出一个出其不意的有趣角度。';
  prompt+='简短精炼（50-150字），使用日志正文所使用的语言。直接写批注内容，不需要称呼或署名。';

  try{
    const response=await callApi(cfg,prompt);
    const le=document.getElementById('anno-loading-tmp');if(le)le.remove();
    if(response){
      const anno={id:'anno_'+Date.now(),postId:_annoPostId,selectedText:selText,paraIdx:paraIdx,
        aiId:cfg.id,aiName:cfg.nickname||cfg.model,userMsg:userMsg,content:response,created:Date.now()};
      await dbPut('blogAnnotations',anno);
      _renderAnnotationsForPost(_annoPostId);
      toast('收到 '+(cfg.nickname||'AI')+' 的批注');
    }
  }catch(e){
    const le=document.getElementById('anno-loading-tmp');if(le)le.remove();
    let msg='请求失败';
    if(e.message){if(e.message.includes('Failed to fetch'))msg='无法连接到API';else if(e.message.includes('401'))msg='API Key 无效';else if(e.message.includes('429'))msg='请求频率过高';else msg=e.message}
    toast(msg);
  }
}

async function _loadAnnotations(postId){
  const all=await dbGetAll('blogAnnotations');
  return all.filter(a=>a.postId===postId).sort((a,b)=>a.created-b.created);
}

function _annoFormatTime(ts){const d=new Date(ts);return d.getFullYear()+'年'+(d.getMonth()+1)+'月'+d.getDate()+'日 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}

async function _renderAnnotationsForPost(postId){
  const annos=await _loadAnnotations(postId);
  const post=await dbGet('posts',postId);if(!post)return;
  const paras=post.content.split(/\n\n+/);
  const pvc=document.querySelector('#blog-read-view .post-view-content');if(!pvc)return;

  pvc.innerHTML=paras.map((p,i)=>'<div class="pv-para" data-idx="'+i+'">'+esc(p)+'</div>').join('');

  const byPara={};
  annos.forEach(a=>{
    let idx=a.paraIdx;
    if(idx>=0&&idx<paras.length&&paras[idx].includes(a.selectedText)){/* ok */}
    else{idx=-1;for(let i=0;i<paras.length;i++){if(paras[i].includes(a.selectedText)){idx=i;break}}}
    if(idx<0)idx=a.paraIdx;if(idx<0)idx=paras.length-1;
    if(!byPara[idx])byPara[idx]=[];
    byPara[idx].push(a);
  });

  let _grpId=0;
  Object.keys(byPara).forEach(idx=>{
    const paraEl=pvc.querySelector('.pv-para[data-idx="'+idx+'"]');
    if(!paraEl)return;
    const annoGroup=byPara[idx];
    /* Group annotations by selectedText */
    const textGroups={};
    annoGroup.forEach(a=>{if(!textGroups[a.selectedText])textGroups[a.selectedText]=[];textGroups[a.selectedText].push(a)});
    /* Underline text + count marker, each linked to a group */
    let html=paraEl.innerHTML;
    const groupIds={};/* selectedText → grpId */
    const unanchored={};/* grpId → true：正文中未能生成下划线锚点的组，渲染时默认展开兜底 */
    Object.keys(textGroups).sort((a,b)=>b.length-a.length).forEach(t=>{
      const escaped=esc(t);
      const gid='anno-grp-'+(_grpId++);
      groupIds[t]=gid;
      const count=textGroups[t].length;
      const bubble='<span class="pv-anno-count">'+count+'</span>';
      if(html.includes(escaped)){
        html=html.replace(escaped,'<span class="pv-annotated" onclick="_annoToggleGroup(\''+gid+'\')" data-grp="'+gid+'">'+escaped+'</span>'+bubble);
      }else{unanchored[gid]=true}
    });
    paraEl.innerHTML=html;
    /* Render annotation groups (hidden by default) */
    let insertAfter=paraEl;
    Object.keys(textGroups).forEach(t=>{
      const gid=groupIds[t];
      const grpDiv=document.createElement('div');grpDiv.className='anno-group'+(unanchored[gid]?' open':'');grpDiv.id=gid;
      textGroups[t].forEach(a=>{
        const block=document.createElement('div');block.className='anno-block';
        block.innerHTML='<div class="anno-block-inner">'
          +'<div class="anno-block-head"><span class="anno-block-name">'+esc(a.aiName)+'</span><span class="anno-block-time">'+_annoFormatTime(a.created)+'</span></div>'
          +(a.userMsg?'<div class="anno-block-q">'+esc(a.userMsg)+'</div>':'')
          +'<div class="anno-block-txt">'+esc(a.content)+'</div>'
          +'</div>'
          +'<button class="anno-block-del" onclick="_deleteAnno(\''+a.id+'\',\''+a.postId+'\')" title="删除">×</button>';
        grpDiv.appendChild(block);
      });
      insertAfter.insertAdjacentElement('afterend',grpDiv);
      insertAfter=grpDiv;
    });
  });
}

function _annoToggleGroup(gid){
  const grp=document.getElementById(gid);if(!grp)return;
  grp.classList.toggle('open');
}

async function _deleteAnno(id,postId){
  if(!confirm('删除这条批注？'))return;
  await dbDelete('blogAnnotations',id);
  _renderAnnotationsForPost(postId);
  toast('批注已删除');
}

/* Annotation info for post cards */
async function _annoEnrichPostCards(){
  try{const all=await dbGetAll('blogAnnotations');if(!all.length)return;
  const byPost={};all.forEach(a=>{if(!byPost[a.postId])byPost[a.postId]={count:0,names:[]};byPost[a.postId].count++;if(!byPost[a.postId].names.includes(a.aiName))byPost[a.postId].names.push(a.aiName)});
  document.querySelectorAll('.post-card').forEach(card=>{
    const onclick=card.getAttribute('onclick')||'';const m=onclick.match(/viewPost\('([^']+)'\)/);if(!m)return;
    const pid=m[1];const info=byPost[pid];if(!info)return;
    const meta=card.querySelector('.post-card-meta');if(!meta)return;
    const span=document.createElement('span');span.textContent='· '+info.count+' notes';
    meta.appendChild(span);
  })}catch(e){}
}

/* ---- 双挂载：core.js 的运行时调用与内联 onclick 模板串仍经 window 访问；IB.chat.annotations 登记导出 ---- */
function ibAnnoLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._annoLimitInput=_annoLimitInput;
window._annoClearTempHL=_annoClearTempHL;
window._annoHideAll=_annoHideAll;
window._annoPopulateDrop=_annoPopulateDrop;
window._annoCopy=_annoCopy;
window._annoToggleDrop=_annoToggleDrop;
window._annoPickAI=_annoPickAI;
window._annoSend=_annoSend;
window._loadAnnotations=_loadAnnotations;
window._annoFormatTime=_annoFormatTime;
window._renderAnnotationsForPost=_renderAnnotationsForPost;
window._annoToggleGroup=_annoToggleGroup;
window._deleteAnno=_deleteAnno;
window._annoEnrichPostCards=_annoEnrichPostCards;
ibAnnoLive('_annoPostId', function(){return _annoPostId}, function(v){_annoPostId=v});
ibAnnoLive('_annoSelText', function(){return _annoSelText}, function(v){_annoSelText=v});
ibAnnoLive('_annoParaIdx', function(){return _annoParaIdx}, function(v){_annoParaIdx=v});
ibAnnoLive('_annoSelectedAI', function(){return _annoSelectedAI}, function(v){_annoSelectedAI=v});
ibAnnoLive('_annoSelRange', function(){return _annoSelRange}, function(v){_annoSelRange=v});
NS.expose('chat.annotations', {
  _annoLimitInput: _annoLimitInput,
  _annoClearTempHL: _annoClearTempHL,
  _annoHideAll: _annoHideAll,
  _annoPopulateDrop: _annoPopulateDrop,
  _annoCopy: _annoCopy,
  _annoToggleDrop: _annoToggleDrop,
  _annoPickAI: _annoPickAI,
  _annoSend: _annoSend,
  _loadAnnotations: _loadAnnotations,
  _annoFormatTime: _annoFormatTime,
  _renderAnnotationsForPost: _renderAnnotationsForPost,
  _annoToggleGroup: _annoToggleGroup,
  _deleteAnno: _deleteAnno,
  _annoEnrichPostCards: _annoEnrichPostCards,
  _annoPostId: _annoPostId,
  _annoSelText: _annoSelText,
  _annoParaIdx: _annoParaIdx,
  _annoSelectedAI: _annoSelectedAI,
  _annoSelRange: _annoSelRange,
});
})(window.IB || (window.IB = {}));
