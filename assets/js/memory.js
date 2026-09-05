/* ====================== MEMORY SYSTEM ====================== */
/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.memory 注册）。 */
(function(NS){
/* Ombre Brain 理念改造版：情感坐标 + 自然衰减 + 浮现机制 + 可见性控制 */

let _editingMemId=null;

/* --- 衰减评分 (Ombre Brain 改进版艾宾浩斯) --- */
function getMemoryScore(mem){
  if(mem.pinned)return 999;
  const now=Date.now();
  const daysSince=(now-(mem.lastActivated||mem.created))/(1000*60*60*24);
  const lambda=mem.resolved?0.12:0.05;/* 已解决的记忆衰减更快 */
  const base=1.0;
  const arousalBoost=0.8;
  const emotionFactor=base+(mem.arousal||0.3)*arousalBoost;
  const activationCount=Math.max(0,mem.activationCount||0);
  const activationFactor=1+activationCount/(activationCount+300);/* AI 回忆习惯：长期软饱和。300 次≈1.5倍，600次≈1.67倍，1200次≈1.8倍；永远低于2倍 */
  const decayFactor=Math.exp(-lambda*daysSince);
  const score=(mem.importance||5)*activationFactor*decayFactor*emotionFactor;
  return Math.round(score*100)/100;
}

/* --- 可见性过滤 --- */
function isMemoryVisibleTo(mem,apiId,isGroupChat,groupMemEnabled){
  if(mem.visibility==='private')return false;
  if(isGroupChat){
    if(!groupMemEnabled)return false;
    return mem.visibility==='public';
  }
  if(mem.visibility==='public')return true;
  if(mem.visibility==='only')return (mem.visibleTo||[]).includes(apiId);
  if(mem.visibility==='except')return !(mem.excludeFrom||[]).includes(apiId);
  return false;
}

/* --- 语义相关性：本地关键词匹配（零 token 消耗） --- */
function _extractKeywords(text){
  if(!text)return[];
  /* 中文：提取 2-3 字 n-gram；英文：提取单词 */
  const keywords=[];
  const cleaned=text.replace(/[\[\]()（）【】「」《》、，。！？；：\s]/g,' ').trim();
  /* 英文单词 */
  const enWords=cleaned.match(/[a-zA-Z]{3,}/g);if(enWords)enWords.forEach(w=>keywords.push(w.toLowerCase()));
  /* 中文 n-gram (2字 + 3字) */
  const zhOnly=cleaned.replace(/[a-zA-Z0-9\s]+/g,'');
  for(let i=0;i<zhOnly.length-1;i++){keywords.push(zhOnly.slice(i,i+2));if(i<zhOnly.length-2)keywords.push(zhOnly.slice(i,i+3))}
  return[...new Set(keywords)];
}
function _calcRelevance(mem,keywords){
  if(!keywords.length)return 1;
  const haystack=((mem.title||'')+'|'+(mem.content||'')+'|'+((mem.tags||[]).join('|'))+'|'+(mem.domain||'')).toLowerCase();
  let hits=0;
  for(const kw of keywords){if(haystack.includes(kw))hits++}
  const ratio=hits/keywords.length;
  return 1+ratio*1.5;/* 最高 2.5x 加成 */
}

/* --- 统一检索函数：所有 API 调用的记忆注入入口 --- */

async function getMemoryContext(apiId,opts){
  opts=opts||{};
  const memSettings=await getMemorySettings();
  const maxChars=opts.maxChars||memSettings.budget||2000;
  const contentLen=memSettings.contentLen||200;
  const isGroup=opts.isGroup||false;
  const groupMemEnabled=opts.groupMemEnabled||false;
  const userMsg=opts.userMessage||'';
  try{
    const all=await dbGetAll('memories');
    const visible=all.filter(m=>isMemoryVisibleTo(m,apiId,isGroup,groupMemEnabled));
    if(!visible.length)return '';
    /* 语义关键词匹配 */
    const keywords=_extractKeywords(userMsg);
    const scored=visible.map(m=>{
      const base=getMemoryScore(m);
      const relBoost=m.pinned?1:_calcRelevance(m,keywords);
      /* 反垄断：连续高频激活的记忆施加疲劳惩罚 */
      let fatigue=1;
      if(!m.pinned&&m.activationCount>5){
        const hoursSinceLast=(Date.now()-(m.lastActivated||m.created))/(1000*60*60);
        if(hoursSinceLast<2)fatigue=0.7;/* 2 小时内反复激活 → 降权 */
      }
      const _s=base*relBoost*fatigue;
      return{...m,_score:_s};
    }).sort((a,b)=>b._score-a._score);
    /* === 置顶优先 + 主选区 + 探索窗口 === */
    const EXPLORE_RATIO=0.15;/* 预留 15% 预算给探索 */
    const mainBudget=Math.floor(maxChars*(1-EXPLORE_RATIO));
    const exploreBudget=maxChars-mainBudget;
    let ctx='【记忆（系统参考，勿提及此段）】\n';
    let chars=ctx.length;
    let count=0;
    const selected=new Set();
    /* 置顶记忆优先注入（保证每次都被 AI 看到） */
    const pinned=scored.filter(m=>m.pinned);
    const unpinned=scored.filter(m=>!m.pinned);
    for(const m of pinned){
      const line=_formatMemLine(m,apiId,contentLen);
      if(chars+line.length>mainBudget)break;
      ctx+=line;chars+=line.length;count++;selected.add(m.id);
    }
    /* 主选区：剩余预算按分数从高到低填充非置顶记忆 */
    for(const m of unpinned){
      const line=_formatMemLine(m,apiId,contentLen);
      if(chars+line.length>mainBudget)break;
      ctx+=line;chars+=line.length;count++;selected.add(m.id);
    }
    /* 探索窗口：从未入选的中低分段随机抽一条 */
    const remaining=scored.filter(m=>!selected.has(m.id)&&!m.pinned);
    if(remaining.length&&exploreBudget>50){
      const pick=remaining[Math.floor(Math.random()*Math.min(remaining.length,10))];
      const line=_formatMemLine(pick,apiId,contentLen);
      if(chars+line.length<=maxChars){ctx+=line;chars+=line.length;count++;selected.add(pick.id)}
    }
    if(!count)return '';
    /* 激活计数：被检索到的记忆增加 activationCount */
    for(const id of selected){
      try{
        const orig=await dbGet('memories',id);
        if(orig){orig.activationCount=(orig.activationCount||0)+1;orig.lastActivated=Date.now();await dbPut('memories',orig)}
      }catch(e){}
    }
    return ctx;
  }catch(e){return ''}
}
function _formatMemLine(m,apiId,contentLen){
  let authorTag='';
  if(m.createdBy==='user'||!m.createdBy){authorTag='[用户记录] '}
  else if(m.createdBy===apiId){authorTag=''}
  else{const cname=m.createdByName||'AI';authorTag='['+cname+' 记录] '}
  return '- '+authorTag+(m.title||'无标题')+'（'+(['情感','日常','创作','思考'].includes(m.domain)?m.domain:'记忆')
    +(m.tags&&m.tags.length?' · '+m.tags.join('、'):'')
    +'）：'+(m.content||'').slice(0,contentLen)+(m.content&&m.content.length>contentLen?'…':'')
    +(m.resolved?' [已解决]':'')
    +'\n';
}

/* --- CRUD 操作 --- */
function updMemPreview(){
  var dot=document.getElementById('mem-fmini-dot');if(!dot)return;
  var ve=document.getElementById('mem-f-valence'),ae=document.getElementById('mem-f-arousal'),ie=document.getElementById('mem-f-importance'),de=document.getElementById('mem-f-domain');
  var v=ve?+ve.value:0.5,a=ae?+ae.value:0.3,imp=ie?+ie.value:5,dom=de?de.value:'情感';
  dot.style.left=(8+v*84)+'%';dot.style.top=(8+(1-a)*84)+'%';dot.style.width=dot.style.height=(5+imp*0.7).toFixed(1)+'px';
  var ptxt=document.getElementById('mem-fptxt');
  if(ptxt)ptxt.textContent='领域「'+dom+'」· 落点偏'+(v>0.55?'积极':v<0.45?'消极':'中性')+'、'+(a>0.55?'炽烈':a<0.4?'平静':'适中')+' · 重要性 '+imp;
}
function openMemoryModal(id){
  _editingMemId=id||null;
  const modal=document.getElementById('mem-modal-overlay');
  document.getElementById('mem-modal-title').textContent=id?'编辑记忆':'新建记忆';
  /* 填充 API 勾选列表 */
  const checksEl=document.getElementById('mem-api-checks');
  checksEl.innerHTML=apiConfigs.map(a=>'<label><input type="checkbox" value="'+a.id+'"> '+esc(a.nickname||a.model||'AI')+'</label>').join('');
  if(id){
    dbGet('memories',id).then(m=>{
      if(!m)return;
      document.getElementById('mem-f-title').value=m.title||'';
      document.getElementById('mem-f-summary').value=m.summary||'';
      document.getElementById('mem-f-content').value=m.content||'';
      if(document.getElementById('mem-f-oneline'))document.getElementById('mem-f-oneline').value=m.oneLine||'';
      document.getElementById('mem-f-domain').value=m.domain||'情感';
      document.getElementById('mem-f-source').value=m.rawSource||'manual';
      document.getElementById('mem-f-tags').value=(m.tags||[]).join(', ');
      document.getElementById('mem-f-valence').value=m.valence!=null?m.valence:0.5;
      document.getElementById('mem-f-valence-val').textContent=m.valence!=null?m.valence:0.5;
      document.getElementById('mem-f-arousal').value=m.arousal!=null?m.arousal:0.3;
      document.getElementById('mem-f-arousal-val').textContent=m.arousal!=null?m.arousal:0.3;
      document.getElementById('mem-f-importance').value=m.importance||5;
      document.getElementById('mem-f-imp-val').textContent=m.importance||5;
      document.getElementById('mem-f-resolved').value=m.resolved?'true':'false';
      document.getElementById('mem-f-pinned').value=m.pinned?'true':'false';
      document.getElementById('mem-f-visibility').value=m.visibility||'public';
      toggleMemApiChecks();
      const targets=m.visibility==='only'?(m.visibleTo||[]):m.visibility==='except'?(m.excludeFrom||[]):[];
      checksEl.querySelectorAll('input').forEach(cb=>{cb.checked=targets.includes(cb.value)});
      updMemPreview();
    });
  }else{
    document.getElementById('mem-f-title').value='';
    document.getElementById('mem-f-summary').value='';
    document.getElementById('mem-f-content').value='';
    if(document.getElementById('mem-f-oneline'))document.getElementById('mem-f-oneline').value='';
    document.getElementById('mem-f-domain').value='情感';
    document.getElementById('mem-f-source').value='manual';
    document.getElementById('mem-f-tags').value='';
    document.getElementById('mem-f-valence').value=0.5;document.getElementById('mem-f-valence-val').textContent='0.5';
    document.getElementById('mem-f-arousal').value=0.3;document.getElementById('mem-f-arousal-val').textContent='0.3';
    document.getElementById('mem-f-importance').value=5;document.getElementById('mem-f-imp-val').textContent='5';
    document.getElementById('mem-f-resolved').value='false';
    document.getElementById('mem-f-pinned').value='false';
    document.getElementById('mem-f-visibility').value='public';
    toggleMemApiChecks();
  }
  updMemPreview();
  modal.classList.add('show');
}
function closeMemoryModal(){document.getElementById('mem-modal-overlay').classList.remove('show');_editingMemId=null}
function toggleMemApiChecks(){
  const vis=document.getElementById('mem-f-visibility').value;
  document.getElementById('mem-api-checks').style.display=(vis==='only'||vis==='except')?'flex':'none';
}

async function saveMemory(){
  const title=document.getElementById('mem-f-title').value.trim();
  if(!title){toast('请填写标题');return}
  const vis=document.getElementById('mem-f-visibility').value;
  const checked=[...document.querySelectorAll('#mem-api-checks input:checked')].map(cb=>cb.value);
  const mem={
    id:_editingMemId||('mem_'+Date.now()+'_'+Math.floor(Math.random()*10000)),
    title:title,
    summary:document.getElementById('mem-f-summary').value.trim(),
    content:document.getElementById('mem-f-content').value.trim(),
    oneLine:(document.getElementById('mem-f-oneline')?document.getElementById('mem-f-oneline').value.trim():''),
    rawSource:document.getElementById('mem-f-source').value,
    sourceId:'',
    domain:document.getElementById('mem-f-domain').value,
    tags:document.getElementById('mem-f-tags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean),
    valence:(v=>isNaN(v)?0.5:Math.max(0,Math.min(1,v)))(parseFloat(document.getElementById('mem-f-valence').value)),
    arousal:(v=>isNaN(v)?0.3:Math.max(0,Math.min(1,v)))(parseFloat(document.getElementById('mem-f-arousal').value)),
    importance:Math.max(1,Math.min(10,parseInt(document.getElementById('mem-f-importance').value)||5)),
    resolved:document.getElementById('mem-f-resolved').value==='true',
    pinned:document.getElementById('mem-f-pinned').value==='true',
    visibility:vis,
    visibleTo:vis==='only'?checked:[],
    excludeFrom:vis==='except'?checked:[],
    activationCount:0,
    created:Date.now(),
    lastActivated:Date.now(),
    createdBy:'user',createdByName:'',editedByUser:false
  };
  if(_editingMemId){
    const old=await dbGet('memories',_editingMemId);
    if(old){
      mem.created=old.created;mem.activationCount=old.activationCount||0;
      mem.createdBy=old.createdBy||'user';
      mem.createdByName=old.createdByName||'';
      if(old.createdBy&&old.createdBy!=='user')mem.editedByUser=true;
    }
  }
  await dbPut('memories',mem);
  closeMemoryModal();
  renderMemories();
  updateMemDashboard();
  toast(_editingMemId?'记忆已更新':'记忆已保存');
}

async function deleteMemory(id){
  if(!confirm('确定删除这条记忆？'))return;
  await dbDelete('memories',id);
  try{await _reconcileReferences(id)}catch(e){}/* 证据失效→建议的 Understanding/Thread 置 stale/orphan（不级联删） */
  renderMemories();updateMemDashboard();toast('记忆已删除');
}

async function toggleMemResolved(id){
  const m=await dbGet('memories',id);
  if(!m)return;
  m.resolved=!m.resolved;
  await dbPut('memories',m);
  renderMemories();updateMemDashboard();
  toast(m.resolved?'已标记为已解决':'已标记为未解决');
}

async function toggleMemPin(id){
  const m=await dbGet('memories',id);
  if(!m)return;
  if(!m.pinned){
    const all=await dbGetAll('memories');
    const pinnedCount=all.filter(x=>x.pinned).length;
    if(pinnedCount>=7){toast('最多只能置顶 7 条记忆');return}
  }
  m.pinned=!m.pinned;
  await dbPut('memories',m);
  renderMemories();updateMemDashboard();
  toast(m.pinned?'已置顶':'已取消置顶');
}

/* --- 渲染记忆列表 --- */
/* 填充 Memory 工具栏的"按API可见"下拉列表：选项为每个已配置的 API，保留当前选择 */
async function populateMemApiFilter(){
  await loadApiConfigs();
  const sel=document.getElementById('mem-filter-api');
  if(!sel)return;
  const cur=sel.value;
  sel.innerHTML='<option value="all">全部AI可见</option>';
  apiConfigs.forEach(a=>{
    const opt=document.createElement('option');
    opt.value=a.id;
    opt.textContent=a.nickname||a.model||'AI';
    sel.appendChild(opt);
  });
  if(cur&&[...sel.options].some(o=>o.value===cur))sel.value=cur;
}

async function renderMemories(){
  const all=await dbGetAll('memories');
  const domainFilter=document.getElementById('mem-filter-domain')?.value||'all';
  const statusFilter=document.getElementById('mem-filter-status')?.value||'all';
  const apiFilter=document.getElementById('mem-filter-api')?.value||'all';
  const sortBy=document.getElementById('mem-sort')?.value||'created';
  const search=(document.getElementById('mem-search')?.value||'').toLowerCase();
  let list=all.filter(m=>{
    if(domainFilter!=='all'&&m.domain!==domainFilter)return false;
    /* 按API可见：只显示注入该 API 对话时可见的记忆卡（私密记忆对所有 API 不可见） */
    if(apiFilter!=='all'&&!isMemoryVisibleTo(m,apiFilter,false,false))return false;
    if(statusFilter==='unresolved'&&m.resolved)return false;
    if(statusFilter==='resolved'&&!m.resolved)return false;
    if(statusFilter==='pinned'&&!m.pinned)return false;
    if(search){
      const hay=(m.title||'').toLowerCase()+(m.summary||'').toLowerCase()+(m.tags||[]).join(' ').toLowerCase()+(m.content||'').toLowerCase();
      if(!hay.includes(search))return false;
    }
    return true;
  });
  list=list.map(m=>({...m,_score:getMemoryScore(m)}));
  if(sortBy==='score')list.sort((a,b)=>b._score-a._score);
  else if(sortBy==='created')list.sort((a,b)=>b.created-a.created);
  else if(sortBy==='importance')list.sort((a,b)=>(b.importance||5)-(a.importance||5));
  /* Sort pinned to top */
  const pinned=list.filter(m=>m.pinned);
  const unpinned=list.filter(m=>!m.pinned);
  list=[...pinned,...unpinned];

  const container=document.getElementById('mem-list');
  if(!list.length){
    container.innerHTML='<div class="empty-state"><span>◇</span>还没有记忆…点击「+ 新记忆」开始记录</div>';
    const tl=document.getElementById('mem-timeline');
    if(tl){const ln=tl.querySelector('.mem-timeline-line');tl.innerHTML='';if(ln)tl.appendChild(ln);else{const l2=document.createElement('div');l2.className='mem-timeline-line';tl.appendChild(l2)};tl.style.minHeight=''}
    return;
  }

  const visLabels={public:'全部公开',only:'仅指定',except:'排除指定',private:'私密'};
  let html='';
  let addedDivider=false;
  list.forEach(m=>{
    /* Insert divider after last pinned item */
    if(!addedDivider&&!m.pinned&&pinned.length>0){
      html+='<div class="mem-pin-divider"></div>';
      addedDivider=true;
    }
    const date=new Date(m.created).toLocaleDateString('zh-CN');
    const tags=(m.tags||[]).map(t=>'<span class="mem-card-tag">'+esc(t)+'</span>').join('');
    let creatorStr='';
    const ownerName=_cachedUserName||'Sui';
    if(m.createdBy==='user'||!m.createdBy){
      creatorStr=esc(ownerName)+'创建';
    }else{
      const apiCfg=apiConfigs.find(a=>a.id===m.createdBy);
      const apiName=m.createdByName||(apiCfg?(apiCfg.nickname||apiCfg.model):'AI');
      if(m.editedByUser){
        creatorStr='<strong>'+esc(apiName)+'</strong> & '+esc(ownerName)+'编写';
      }else{
        creatorStr='<strong>'+esc(apiName)+'</strong>编写';
      }
    }
    html+='<div class="mem-card'+(m.pinned?' mem-pinned':'')+'" id="mc-'+m.id+'" onclick="toggleMemExpand(\''+m.id+'\',event)">'
      +(m.pinned?'<div class="mem-pin-nail"></div>':'')
      +'<div class="mem-card-head">'
        +'<div class="mem-card-title">'+esc(m.title||'无标题')+'</div>'
        +'<div class="mem-card-score">'+(m.pinned?'\u2605':m._score)+'</div>'
      +'</div>'
      +(m.summary?'<div class="mem-card-summary">'+esc(m.summary)+'</div>':'')
      +(m.oneLine?'<div class="mem-card-oneline"><span class="mem-quote-mark">\u201C</span><span class="mem-card-oneline-text">'+esc(m.oneLine)+'</span><span class="mem-quote-mark close">\u201D</span></div>':'')
      +'<div class="mem-card-creator">'+creatorStr+' \u00B7 '+date+'</div>'
      +'<div class="mem-card-fold"></div>'
      +'<div class="mem-card-detail">'
        +'<div class="mem-card-meta">'
          +'<span class="mem-card-tag">'+esc(m.domain||'记忆')+'</span>'
          +tags
          +(m.resolved?'<span class="mem-resolved-badge">\u2713 已解决</span>':'')
          +'<span class="mem-vis-badge">'+visLabels[m.visibility||'public']+'</span>'
        +'</div>'
        +'<div class="mem-card-content">'+esc(m.content||'')+'</div>'
        +'<div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:12px;margin-top:6px">V:'+(m.valence!=null?m.valence:0.5)+' A:'+(m.arousal!=null?m.arousal:0.3)+' \u00B7 '+(m.activationCount||0)+'次激活</div>'
        +'<div class="mem-card-actions">'
          +'<button class="btn" onclick="event.stopPropagation();toggleMemPin(\''+m.id+'\')">'+(m.pinned?'取消置顶':'置顶')+'</button>'
          +'<button class="btn" onclick="event.stopPropagation();toggleMemResolved(\''+m.id+'\')">'+(m.resolved?'未解决':'解决')+'</button>'
          +'<button class="btn" onclick="event.stopPropagation();toggleInlineEdit(\''+m.id+'\')">编辑</button>'
          +'<button class="btn" onclick="event.stopPropagation();deleteMemory(\''+m.id+'\')">删除</button>'
          +(m.createdBy&&m.createdBy!=='user'?'<button class="btn" onclick="event.stopPropagation();writeOneLineToMemory(\''+m.id+'\')">'+(m.oneLine?'重写一句':'写一句话')+'</button>':'')
        +'</div>'
        +'<div class="mem-card-edit-panel" id="mce-'+m.id+'"></div>'
      +'</div>'
    +'</div>';
  });
  container.innerHTML=html;
  /* Render timeline: sort-mode-aware — 月份分组仅在"按时间"模式启用 */
  const timeline=document.getElementById('mem-timeline');
  if(timeline){
    const ln=timeline.querySelector('.mem-timeline-line');
    timeline.innerHTML='';
    if(ln)timeline.appendChild(ln);else{const l2=document.createElement('div');l2.className='mem-timeline-line';timeline.appendChild(l2)}
    if(list.length){
      const cardEls=container.querySelectorAll('.mem-card,.mem-pin-divider');
      const memMap={};list.forEach(function(x){memMap['mc-'+x.id]=x});
      const sortMode=document.getElementById('mem-sort')?.value||'created';
      /* Pre-scan: build month groups from cardEls */
      var cardData=[];
      cardEls.forEach(function(el){
        if(el.classList.contains('mem-pin-divider')){cardData.push({type:'divider',el:el});return}
        var m=memMap[el.id];
        if(!m)return;
        var d=new Date(m.created);
        var ym=d.getFullYear()+'.'+(d.getMonth()+1);
        cardData.push({type:'mem',el:el,m:m,d:d,ym:ym});
      });
      /* 月份折叠分组仅在"按时间"排序且 >12 条非置顶记忆时启用 */
      var nonPinnedCount=cardData.filter(function(c){return c.type==='mem'&&!c.m.pinned}).length;
      var useGrouping=nonPinnedCount>12&&sortMode==='created';
      /* Track collapsed state per month on the timeline element */
      if(!timeline._collapsed)timeline._collapsed={};
      var collapsed=timeline._collapsed;
      /* Sticky back-to-top anchor — always visible, scrolls to memory toolbar */
      {
        const pa=document.createElement('div');
        pa.className='mem-timeline-pin-anchor';
        pa.title='回到顶部';
        pa.onclick=function(){
          var toolbar=document.getElementById('mem-deck')||document.querySelector('.mem-section-title');
          if(toolbar)toolbar.scrollIntoView({behavior:'smooth',block:'start'});
        };
        timeline.appendChild(pa);
      }
      /* Helper to build timeline dot for a memory */
      function buildDot(c,yPos){
        var m=c.m;var d=c.d;
        var imp=m.importance||5;
        var sz=(7+imp*0.85).toFixed(1);
        var domainC=m.pinned?_memGold():(MEM_DOMAIN_COLORS[m.domain]||MEM_DOMAIN_COLORS['日常']).c;
        var gcol=m.pinned?_memGoldRgba('0.7'):'rgba(114,168,216,0.7)';
        var dot=document.createElement('div');
        dot.className='mem-timeline-dot'+(m.pinned?' pinned':'');
        dot.setAttribute('data-month',c.ym);
        dot.style.position='absolute';
        dot.style.top=yPos+'px';
        dot.style.width=sz+'px';
        dot.style.height=sz+'px';
        dot.style.setProperty('--dc',domainC);
        if(!m.pinned){dot.style.background='radial-gradient(circle at 36% 32%,rgba(255,255,255,0.93),'+domainC+' 52%,'+domainC+'22 82%,transparent)';dot.style.boxShadow='0 0 8px '+domainC+'55,0 0 18px '+domainC+'28'}
        dot.title=esc(m.title||'')+(m.domain?' \u00B7 '+m.domain:'');
        dot.onclick=function(e){e.stopPropagation();
          var sp=document.createElement('span');sp.className='mem-sparkle';
          sp.style.cssText='left:50%;top:50%;transform:translate(-50%,-50%);--sd:'+sz+'px;--sgc:'+gcol;
          dot.appendChild(sp);setTimeout(function(){sp.remove()},650);
          var sc2=1.8;dot.style.transform='scale('+sc2+')';setTimeout(function(){dot.style.transform=''},350);
          var card=document.getElementById('mc-'+m.id);if(card){card.scrollIntoView({behavior:'smooth',block:'center'});card.classList.add('expanded')}};
        return dot;
      }
      function relayoutTimeline(){
        /* Remove all dots, month markers, and labels; rebuild positions based on card positions */
        var els=timeline.querySelectorAll('.mem-timeline-dot,.mem-timeline-month,.mem-timeline-month-label,.mem-timeline-date');
        els.forEach(function(e){e.remove()});
        var tlRect=timeline.getBoundingClientRect();
        if(!tlRect.height)return;
        var shLabels2={};
        var lastM='';
        var maxY=48;
        var handledMonths={};
        /* 折叠/展开月份的共用 onclick 工厂 */
        function makeMonthToggle(ym){return function(){
          collapsed[ym]=!collapsed[ym];
          cardData.forEach(function(cc){
            if(cc.type==='mem'&&cc.ym===ym&&!cc.m.pinned){
              var crd=document.getElementById('mc-'+cc.m.id);
              if(crd)crd.style.display=collapsed[ym]?'none':'';
            }
          });
          container.querySelectorAll('.mem-pin-divider').forEach(function(pd){
            var anyVisible=false;
            cardData.forEach(function(cc){
              if(cc.type==='mem'&&!cc.m.pinned){
                var crd=document.getElementById('mc-'+cc.m.id);
                if(crd&&crd.style.display!=='none')anyVisible=true;
              }
            });
            if(!anyVisible)pd.style.display='none';else pd.style.display='';
          });
          requestAnimationFrame(relayoutTimeline);
        }}
        cardData.forEach(function(c){
          if(c.type==='divider')return;
          var m=c.m;
          var d=c.d;
          var card=document.getElementById('mc-'+m.id);
          /* ── 折叠月份的菱形：卡片已隐藏，菱形放在置顶区域下方 ── */
          if(sortMode==='created'&&useGrouping&&!m.pinned&&collapsed[c.ym]&&!handledMonths[c.ym]){
            var monthY=maxY+30;
            var sq=document.createElement('div');
            sq.className='mem-timeline-month collapsed';
            sq.setAttribute('data-group',c.ym);
            sq.style.top=monthY+'px';
            sq.title=c.ym+' — 点击展开';
            sq.onclick=makeMonthToggle(c.ym);
            timeline.appendChild(sq);
            var ml=document.createElement('div');
            ml.className='mem-timeline-month-label';
            ml.style.top=monthY+'px';
            ml.textContent=c.ym+' ('+cardData.filter(function(x){return x.ym===c.ym&&x.type==='mem'&&!x.m.pinned}).length+')';
            timeline.appendChild(ml);
            handledMonths[c.ym]=true;
            lastM=c.ym;
            maxY=monthY+20;
            return;
          }
          /* 跳过隐藏/缺失的卡片 */
          if(!card||card.style.display==='none')return;
          if(useGrouping&&collapsed[c.ym]&&!m.pinned)return;
          /* 读取卡片实际位置 */
          var cRect=card.getBoundingClientRect();
          var y=cRect.top-tlRect.top+cRect.height*0.35;
          /* ── 月份菱形：仅对非置顶记忆生效 ── */
          if(sortMode==='created'&&!m.pinned&&c.ym!==lastM&&!handledMonths[c.ym]){
            var monthY=y-20;
            if(monthY<maxY)monthY=maxY;
            if(useGrouping){
              var sq=document.createElement('div');
              sq.className='mem-timeline-month';
              sq.setAttribute('data-group',c.ym);
              sq.style.top=monthY+'px';
              sq.title=c.ym+' — 点击折叠/展开';
              sq.onclick=makeMonthToggle(c.ym);
              timeline.appendChild(sq);
              var ml=document.createElement('div');
              ml.className='mem-timeline-month-label';
              ml.style.top=monthY+'px';
              ml.textContent=c.ym;
              timeline.appendChild(ml);
            }else{
              var sq2=document.createElement('div');
              sq2.className='mem-timeline-month';
              sq2.style.top=monthY+'px';
              sq2.title=c.ym+' — 点击定位';
              sq2.onclick=function(){c.el.scrollIntoView({behavior:'smooth',block:'center'})};
              timeline.appendChild(sq2);
              var ml2=document.createElement('div');
              ml2.className='mem-timeline-month-label';
              ml2.style.top=monthY+'px';
              ml2.textContent=c.ym;
              timeline.appendChild(ml2);
            }
            handledMonths[c.ym]=true;
            lastM=c.ym;
          }
          /* 放置珠子 */
          var dot=buildDot(c,y);
          timeline.appendChild(dot);
          /* 标签 */
          var labelText='',labelKey='';
          if(sortMode==='created'){
            labelKey=(d.getMonth()+1)+'.'+d.getDate();
            labelText=labelKey;
          }else if(sortMode==='score'){
            if(!m.pinned){var scv=getMemoryScore(m);labelKey=String(scv);labelText=scv}
          }else if(sortMode==='importance'){
            var imp2=m.importance||5;
            if(!m.pinned){labelKey='imp-'+imp2;labelText='W'+imp2}
          }
          if(labelKey&&!shLabels2[labelKey]){
            var label=document.createElement('div');
            label.className='mem-timeline-date';
            label.style.top=y+'px';
            label.textContent=labelText;
            timeline.appendChild(label);
            shLabels2[labelKey]=true;
          }
          if(y>maxY)maxY=y;
        });
        timeline.style.minHeight=Math.max(maxY+60,300)+'px';
      }
      /* 暴露重排函数，供卡片展开/折叠时调用 */
      window._memRelayoutTimeline=relayoutTimeline;
      /* 延迟首次布局，确保卡片已完成渲染 */
      requestAnimationFrame(relayoutTimeline);
    }
  }
}

function toggleMemExpand(id,e){
  /* 防止编辑面板内的任何点击（label、span、div等）触发卡片折叠 */
  if(e&&e.target.closest&&e.target.closest('.mem-card-edit-panel'))return;
  /* 操作按钮行的空隙也不触发折叠（点偏一点就把卡片合上很恼人） */
  if(e&&e.target.closest&&e.target.closest('.mem-card-actions'))return;
  if(e&&(e.target.tagName==='BUTTON'||e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT'||e.target.tagName==='LABEL'))return;
  const card=document.getElementById('mc-'+id);
  if(!card)return;
  /* 编辑面板开着时，点击卡片任何位置都不折叠。
     关键场景：拖动滑杆 / 在输入框里划选文字时，鼠标在面板外松开——
     mousedown 与 mouseup 目标不同时，click 会落在两者的共同祖先（即卡片本身）上，
     e.target 不在编辑面板内、上面的守卫拦不住 → 卡片连着编辑面板一起被折起，
     再点一下又整个"突然弹出"。编辑期间一律只通过「取消 / 保存」离开。 */
  if(card.querySelector('.mem-card-edit-panel.show'))return;
  /* 正在划选文字（准备复制）时不折叠：划选后松开鼠标产生的 click 不应吞掉选区 */
  try{
    const sel=window.getSelection();
    if(sel&&!sel.isCollapsed&&sel.anchorNode&&card.contains(sel.anchorNode))return;
  }catch(_){}
  card.classList.toggle('expanded');
  if(window._memRelayoutTimeline)requestAnimationFrame(window._memRelayoutTimeline);
}

async function toggleInlineEdit(id){
  const panel=document.getElementById('mce-'+id);
  if(!panel)return;
  if(panel.classList.contains('show')){panel.classList.remove('show');panel.innerHTML='';if(window._memRelayoutTimeline)requestAnimationFrame(window._memRelayoutTimeline);return}
  const m=await dbGet('memories',id);
  if(!m)return;
  const apiOpts=apiConfigs.map(a=>'<label style="margin:0;display:flex;align-items:center;gap:4px"><input type="checkbox" class="mce-vis-cb-'+id+'" value="'+a.id+'"'
    +((m.visibility==='only'&&(m.visibleTo||[]).includes(a.id))||(m.visibility==='except'&&(m.excludeFrom||[]).includes(a.id))?' checked':'')
    +'> '+esc(a.nickname||a.model||'AI')+'</label>').join('');
  panel.innerHTML=
    '<label>标题</label><input id="mce-title-'+id+'" value="'+esc(m.title||'')+'">'
    +'<label>概括</label><textarea id="mce-summary-'+id+'" style="min-height:36px">'+esc(m.summary||'')+'</textarea>'
    +'<label>写一句话</label><input id="mce-oneline-'+id+'" value="'+esc(m.oneLine||'')+'" placeholder="留空则不显示引言行">'
    +'<label>内容</label><textarea id="mce-content-'+id+'">'+esc(m.content||'')+'</textarea>'
    +'<div class="mem-card-edit-row">'
      +'<div><label>领域</label><select id="mce-domain-'+id+'"><option value="情感"'+(m.domain==='情感'?' selected':'')+'>情感</option><option value="日常"'+(m.domain==='日常'?' selected':'')+'>日常</option><option value="创作"'+(m.domain==='创作'?' selected':'')+'>创作</option><option value="思考"'+(m.domain==='思考'?' selected':'')+'>思考</option></select></div>'
      +'<div><label>来源</label><select id="mce-source-'+id+'"><option value="manual"'+(m.rawSource==='manual'?' selected':'')+'>手动</option><option value="chat"'+(m.rawSource==='chat'?' selected':'')+'>Chat</option><option value="letter"'+(m.rawSource==='letter'?' selected':'')+'>Letter</option><option value="blog"'+(m.rawSource==='blog'?' selected':'')+'>Blog</option><option value="tea"'+(m.rawSource==='tea'?' selected':'')+'>Tea</option><option value="story"'+(m.rawSource==='story'?' selected':'')+'>Story</option></select></div>'
    +'</div>'
    +'<label>标签（逗号分隔）</label><input id="mce-tags-'+id+'" value="'+esc((m.tags||[]).join(', '))+'">'
    +'<label>效价 (V)</label><div class="mem-edit-range"><input type="range" id="mce-v-'+id+'" min="0" max="1" step="0.01" value="'+(m.valence!=null?m.valence:0.5)+'" oninput="this.nextElementSibling.textContent=this.value"><span>'+(m.valence!=null?m.valence:0.5)+'</span></div>'
    +'<label>唤醒度 (A)</label><div class="mem-edit-range"><input type="range" id="mce-a-'+id+'" min="0" max="1" step="0.05" value="'+(m.arousal!=null?m.arousal:0.3)+'" oninput="this.nextElementSibling.textContent=this.value"><span>'+(m.arousal!=null?m.arousal:0.3)+'</span></div>'
    +'<label>重要性</label><div class="mem-edit-range"><input type="range" id="mce-imp-'+id+'" min="1" max="10" step="1" value="'+(m.importance||5)+'" oninput="this.nextElementSibling.textContent=this.value"><span>'+(m.importance||5)+'</span></div>'
    +'<div class="mem-card-edit-row">'
      +'<div><label>状态</label><select id="mce-resolved-'+id+'"><option value="false"'+(!m.resolved?' selected':'')+'>未解决</option><option value="true"'+(m.resolved?' selected':'')+'>已解决</option></select></div>'
      +'<div><label>置顶</label><select id="mce-pinned-'+id+'"><option value="false"'+(!m.pinned?' selected':'')+'>否</option><option value="true"'+(m.pinned?' selected':'')+'>是</option></select></div>'
      +'<div><label>可见性</label><select id="mce-vis-'+id+'" onchange="document.getElementById(\'mce-vis-apis-'+id+'\').style.display=(this.value===\'only\'||this.value===\'except\')?\'flex\':\'none\'"><option value="public"'+(m.visibility==='public'?' selected':'')+'>全部公开</option><option value="only"'+(m.visibility==='only'?' selected':'')+'>仅指定</option><option value="except"'+(m.visibility==='except'?' selected':'')+'>排除指定</option><option value="private"'+(m.visibility==='private'?' selected':'')+'>私密</option></select></div>'
    +'</div>'
    +'<div id="mce-vis-apis-'+id+'" style="display:'+((m.visibility==='only'||m.visibility==='except')?'flex':'none')+';flex-wrap:wrap;gap:8px;margin-top:6px">'+apiOpts+'</div>'
    +'<div class="mem-card-edit-actions">'
      +'<button class="btn" onclick="event.stopPropagation();toggleInlineEdit(\''+id+'\')">取消</button>'
      +'<button class="btn btn-primary" onclick="event.stopPropagation();saveInlineEdit(\''+id+'\')">保存</button>'
    +'</div>';
  panel.classList.add('show');
  if(window._memRelayoutTimeline)requestAnimationFrame(window._memRelayoutTimeline);
}

async function saveInlineEdit(id){
  const m=await dbGet('memories',id);
  if(!m)return;
  const title=document.getElementById('mce-title-'+id)?.value?.trim();
  if(!title){toast('标题不能为空');return}
  m.title=title;
  m.summary=document.getElementById('mce-summary-'+id)?.value?.trim()||'';
  m.oneLine=document.getElementById('mce-oneline-'+id)?.value?.trim()||'';
  m.content=document.getElementById('mce-content-'+id)?.value?.trim()||'';
  m.domain=document.getElementById('mce-domain-'+id)?.value||m.domain;
  m.rawSource=document.getElementById('mce-source-'+id)?.value||m.rawSource;
  m.tags=(document.getElementById('mce-tags-'+id)?.value||'').split(/[,，]/).map(t=>t.trim()).filter(Boolean);
  m.valence=(v=>isNaN(v)?0.5:Math.max(0,Math.min(1,v)))(parseFloat(document.getElementById('mce-v-'+id)?.value));
  m.arousal=(v=>isNaN(v)?0.3:Math.max(0,Math.min(1,v)))(parseFloat(document.getElementById('mce-a-'+id)?.value));
  m.importance=parseInt(document.getElementById('mce-imp-'+id)?.value)||5;
  m.resolved=document.getElementById('mce-resolved-'+id)?.value==='true';
  m.pinned=document.getElementById('mce-pinned-'+id)?.value==='true';
  const vis=document.getElementById('mce-vis-'+id)?.value||m.visibility;
  m.visibility=vis;
  const checked=[...document.querySelectorAll('.mce-vis-cb-'+id+':checked')].map(cb=>cb.value);
  m.visibleTo=vis==='only'?checked:[];
  m.excludeFrom=vis==='except'?checked:[];
  if(m.createdBy&&m.createdBy!=='user')m.editedByUser=true;
  m.lastActivated=Date.now();
  await dbPut('memories',m);
  /* 编辑可能使引用它的 Understanding/Thread 的证据口径变化 → 轻度调和（内容修订不降级，仅更新） */
  if(id)try{await _reconcileReferences(id)}catch(e){}
  renderMemories();updateMemDashboard();
  toast('记忆已更新');
}

/* --- 仪表盘 + 星图 + 引言 --- */
/* Naturalized star domain colors (realistic stellar colors, still distinguishable) */
/* c/raw = infernal（真实宇宙恒星色，保持原样不动）；in */
var MEM_DOMAIN_COLORS={'情感':{c:'#d4a0a0',raw:'#d4a0a0'},'日常':{c:'#8eb8e0',raw:'#8eb8e0'},'创作':{c:'#d9b875',raw:'#d9b875'},'思考':{c:'#9a9ad4',raw:'#9a9ad4'}};
var MEM_DEFAULT_QUOTE='They say time devours all things, but say nothing about what becomes of the things as time digests them. What if life is consummated only by the way that time consumes it? What if to live is to be devoured by time, and recycled?';
var _memLastQuoteIdx=-1;
/* 引言跟随：切换 AI 时从其一句话记忆中随机抽取，无记录时回落默认引言 */
function _amSyncQuote(cfg){
  var banner=document.getElementById('mem-quote-banner');var el=document.getElementById('mem-quote-text');
  if(!banner||!el)return;
  var key=cfg?cfg.id:'__none__';
  if(_amQuoteFor===key)return;/* 同一位 AI 的重渲染不打扰引言 */
  _amQuoteFor=key;
  dbGetAll('memories').then(function(all){
    if(_amQuoteFor!==key)return;/* 更快的下一次切换已接管 */
    var txt=MEM_DEFAULT_QUOTE;
    var pool=all.filter(function(m){return m.oneLine&&m.oneLine.trim()&&cfg&&m.createdBy===cfg.id}).map(function(m){return m.oneLine});
    if(pool.length)txt=pool[Math.floor(Math.random()*pool.length)];
    banner.classList.remove('playing');void banner.offsetWidth;
    el.textContent=txt;banner.classList.add('playing');
  });
}
var MEM_GOLD='#c9a055';/* infernal */
var MEM_GOLD_INT='#e2a626';/* internal 明金（浅色底上保持醒目） */
function _memGold(){return document.body.classList.contains('theme-infernal')?MEM_GOLD:MEM_GOLD_INT}
function _memGoldRgba(a){return document.body.classList.contains('theme-infernal')?'rgba(201,160,85,'+a+')':'rgba(226,166,38,'+a+')'}


async function updateMemDashboard(){
  var all=await dbGetAll('memories');
  /* Stats */
  var el;
  el=document.getElementById('mem-total');if(el)el.textContent=all.length;
  el=document.getElementById('mem-pinned');if(el)el.textContent=all.filter(function(m){return m.pinned}).length;
  el=document.getElementById('mem-unresolved');if(el)el.textContent=all.filter(function(m){return!m.resolved}).length;
  el=document.getElementById('mem-resolved');if(el)el.textContent=all.filter(function(m){return m.resolved}).length;
  /* Token budget */
  var memS=await getMemorySettings();var limit=memS.budget||2000;
  var scored=all.map(function(m){return Object.assign({},m,{_s:getMemoryScore(m)})}).filter(function(m){return m.visibility!=='private'}).sort(function(a,b){return b._s-a._s});
  var est=0;
  for(var si=0;si<scored.length;si++){
    var len=(scored[si].title||'').length+(scored[si].content||'').slice(0,memS.contentLen||200).length+30;
    if(est+len>limit)break;est+=len;
  }
  el=document.getElementById('mem-token-est');if(el)el.textContent=est;
  el=document.getElementById('mem-token-est-tk');if(el)el.textContent=Math.round(est*1.5);
  var pct=Math.min(100,Math.round(est/limit*100));
  el=document.getElementById('mem-token-fill');if(el)el.style.width=pct+'%';
  /* Domain distribution bar */
  var domains=['情感','日常','创作','思考'];
  var counts=domains.map(function(d){return all.filter(function(m){return m.domain===d}).length});
  var total=all.length;
  var dbar=document.getElementById('mem-deck-dbar');
  var dleg=document.getElementById('mem-deck-dleg');
  if(dbar&&total){
    dbar.innerHTML=domains.map(function(d,i){return counts[i]?'<i style="width:'+(counts[i]/total*100)+'%;background:'+MEM_DOMAIN_COLORS[d].raw+'"></i>':''}).join('');
  }else if(dbar){dbar.innerHTML=''}
  if(dleg&&total){
    dleg.innerHTML=domains.map(function(d,i){return counts[i]?'<span><b style="background:'+MEM_DOMAIN_COLORS[d].raw+'"></b>'+d+' '+counts[i]+'</span>':''}).join('');
  }else if(dleg){dleg.innerHTML=''}
  /* Build star map + quote */
  buildMemorySky();
  shuffleMemoryQuote();
  updateMemStorageInfo();
}

/* --- 导出记忆 --- */
async function exportMemories(){
  const all=await dbGetAll('memories');
  if(!all.length){toast('没有记忆可导出');return}
  downloadJSON(all,'memories_backup_'+new Date().toISOString().slice(0,10)+'.json');
  toast('记忆已导出（'+all.length+'条）');
}

/* --- 导入记忆 --- */
function importMemoriesFile(){
  const inp=document.createElement('input');inp.type='file';inp.accept='.json';
  inp.onchange=async function(e){
    const file=e.target.files[0];if(!file)return;
    try{
      const text=await file.text();const data=JSON.parse(text);
      const arr=Array.isArray(data)?data:(data.memories||[]);
      if(!arr.length){toast('文件中没有找到记忆数据');return}
      let count=0;
      for(const m of arr){
        if(!m.id)m.id='mem_'+Date.now()+'_'+Math.floor(Math.random()*100000);
        if(!m.created)m.created=Date.now();
        if(!m.lastActivated)m.lastActivated=m.created;
        await dbPut('memories',m);count++;
      }
      renderMemories();updateMemDashboard();
      toast('已导入 '+count+' 条记忆');
    }catch(err){toast('导入失败：文件格式错误')}
  };
  inp.click();
}

/* --- 写一句话 — AI writes a one-line comment on a memory --- */
async function writeOneLineToMemory(memId){
  const mem=await dbGet('memories',memId);
  if(!mem){toast('找不到该记忆');return}
  /* Find API — by createdBy ID, then by nickname fallback */
  let cfg=null;
  if(mem.createdBy&&mem.createdBy!=='user'){
    cfg=apiConfigs.find(a=>a.id===mem.createdBy);
    if(!cfg&&mem.createdByName){
      cfg=apiConfigs.find(a=>(a.nickname||a.model)===mem.createdByName);
    }
  }
  if(!cfg||!_ibApiHasCredential(cfg)){toast('无法找到可用的 API 来回应这条记忆（密钥、本机端点缺失或 API 已删除）');return}
  const aiName=cfg.nickname||cfg.model||'AI';
  toast(aiName+' 正在回想...');
  /* Build context: memory + relationship + system prompt only */
  let context='你是「'+aiName+'」。';
  if(cfg.systemPrompt)context+='\n\n【你的人设背景】\n'+cfg.systemPrompt.slice(0,600);
  if(cfg.relationship)context+='\n\n【你与用户的关系】\n'+cfg.relationship.slice(0,300);
  /* Inject relevant memories for richer context */
  try{const memCtx=await getMemoryContext(cfg.id,{maxChars:800});if(memCtx)context+='\n\n'+memCtx}catch(e){}
  context+='\n\n以下是你们之间的一条记忆：\n标题：'+(mem.title||'')+'\n概括：'+(mem.summary||'')+'\n内容：'+(mem.content||'');
  context+='\n\n请你以自己的身份，为这条记忆对用户写一句话——可以是感想、追记、回应、或一句想对TA说的话。只写一句话，不要标题，不要引号，不要解释，直接写那句话。简短、真挚、有温度。';
  try{
    const resp=await callApi(cfg,context);
    if(!resp){toast('未收到有效回复');return}
    mem.oneLine=resp.replace(/^["'"'\u201C\u201D]|["'"'\u201C\u201D]$/g,'').trim();
    mem.lastActivated=Date.now();
    mem.activationCount=(mem.activationCount||0)+1;
    await dbPut('memories',mem);
    renderMemories();
    toast(aiName+' 写下了一句话');
  }catch(e){toast('请求失败：'+e.message)}
}

/* --- 存量审计：扫描已有记忆中的"文学化自我感慨 / 无未来价值观察"候选 ---
   只读返回候选列表（title/content/id/creator/lyricFlags），不删除。
   供清理 UI / 用户确认后手动删除；绝不自动删。仅针对 AI 生成（createdBy!='user'）的真实
   self-reflection 记忆，避免误伤用户手记或带明确事实/偏好/身份/重复的证据型记忆。 */
async function scanLyricalMemories(){
  try{
    const all=await dbGetAll('memories');
    const flags=(typeof window._memoryLyricFlags==='function')?window._memoryLyricFlags:null;
    if(!flags)return [];
    const candidates=[];
    for(const m of all||[]){
      if(!m||String(m.createdBy||'')==='user')continue;/* 只扫描 AI 生成 */
      const text=String((m.title||'')+' '+(m.summary||'')+' '+(m.content||''));
      const f=flags(text);
      /* 命中文学感慨或自我观察，且无明显事实标记(偏好/身份/目标/重复)则列为候选 */
      const hasFact=/偏好|喜欢|习惯|身份|职业|目标|承诺|约定|希望|想要|决定|说|明确|告诉/i.test(text);
      if((f.lyric||f.personReflect)&&!hasFact){
        candidates.push({id:m.id,title:m.title||'',content:(m.content||'').slice(0,80),createdBy:m.createdBy,createdByName:m.createdByName||'',domain:m.domain||'',created:m.created||0,flags:f});
      }
    }
    return candidates;
  }catch(e){return[]}
}
/* ── 清理无意义记忆 UI：扫描候选 → 勾选 → 确认删除（不自动删） ── */
var _cleanLyricsCandidates=[];
function _cleanLyricsEl(id){return document.getElementById(id)}
function _renderCleanLyricsList(candidates){
  var list=_cleanLyricsEl('mem-clean-list'),empty=_cleanLyricsEl('mem-clean-empty'),delBtn=_cleanLyricsEl('mem-clean-delete-btn'),cnt=_cleanLyricsEl('mem-clean-count');
  if(!list)return;
  if(!candidates||!candidates.length){list.innerHTML='';if(empty)empty.style.display='block';if(delBtn)delBtn.disabled=true;if(cnt)cnt.textContent='0';return}
  if(empty)empty.style.display='none';
  list.innerHTML=candidates.map(function(c){
    var name=c.createdByName||c.createdBy||'AI';
    var date=c.created?new Date(c.created).toLocaleDateString('zh-CN'):'';
    return '<label class="mem-clean-item">'
      +'<input type="checkbox" class="mem-clean-cb" value="'+esc(c.id)+'" onchange="updateCleanLyricsBtns()">'
      +'<span class="mem-clean-body"><span class="mem-clean-title">'+esc(c.title||'无标题')+'</span>'
      +'<span class="mem-clean-meta">'+esc(name)+' · '+esc(c.domain||'')+' · '+esc(date)+'</span>'
      +'<span class="mem-clean-preview">'+esc(c.content||'')+'</span></span></label>';
  }).join('');
  if(delBtn)delBtn.disabled=true;if(cnt)cnt.textContent='0';
}
function updateCleanLyricsBtns(){
  var checked=document.querySelectorAll('.mem-clean-cb:checked');
  var delBtn=_cleanLyricsEl('mem-clean-delete-btn'),cnt=_cleanLyricsEl('mem-clean-count');
  if(delBtn)delBtn.disabled=checked.length===0;
  if(cnt)cnt.textContent=String(checked.length);
}
async function openCleanLyricsModal(){
  var ov=_cleanLyricsEl('mem-clean-overlay');if(!ov)return;
  ov.classList.add('show');
  var list=_cleanLyricsEl('mem-clean-list');if(list)list.innerHTML='<div class="mem-clean-loading">扫描中…</div>';
  _cleanLyricsCandidates=await scanLyricalMemories();
  _renderCleanLyricsList(_cleanLyricsCandidates);
  if(_cleanLyricsCandidates.length)toast('发现 '+_cleanLyricsCandidates.length+' 条无意义记忆候选');
}
function closeCleanLyricsModal(){
  var ov=_cleanLyricsEl('mem-clean-overlay');if(ov)ov.classList.remove('show');
}
async function deleteCheckedCleanLyrics(){
  var ids=[].map.call(document.querySelectorAll('.mem-clean-cb:checked'),function(cb){return cb.value});
  if(!ids.length)return;
  if(!confirm('确定删除选中的 '+ids.length+' 条记忆？此操作不可恢复。'))return;
  for(var i=0;i<ids.length;i++){try{await dbDelete('memories',ids[i])}catch(e){}}
  _cleanLyricsCandidates=_cleanLyricsCandidates.filter(function(c){return ids.indexOf(c.id)<0});
  _renderCleanLyricsList(_cleanLyricsCandidates);
  renderMemories();updateMemDashboard();
  toast('已删除 '+ids.length+' 条无意义记忆');
}
async function quickCreateMemory(data){
  const mem={
    id:'mem_'+Date.now()+'_'+Math.floor(Math.random()*10000),
    title:data.title||'未命名记忆',
    summary:data.summary||'',
    content:data.content||'',
    rawSource:data.source||'manual',
    sourceId:data.sourceId||'',
    domain:data.domain||'日常',
    tags:data.tags||[],
    valence:data.valence!=null?data.valence:0.5,
    arousal:data.arousal!=null?data.arousal:0.3,
    importance:data.importance||5,
    resolved:data.resolved!=null?!!data.resolved:false,pinned:false,
    visibility:data.visibility||'public',visibleTo:[],excludeFrom:[],
    activationCount:0,created:Date.now(),lastActivated:Date.now(),
    createdBy:data.createdBy||'user',
    createdByName:data.createdByName||'',
    editedByUser:false,
    /* Memory Consolidation v1：可选字段（无则缺省，不影响既有记忆与评分/召回） */
    kind:data.kind||'episodic',
    consolidatedFrom:Array.isArray(data.consolidatedFrom)?data.consolidatedFrom.slice(0,50):[],
    lastConsolidatedAt:data.lastConsolidatedAt!=null?Number(data.lastConsolidatedAt):null
  };
  await dbPut('memories',mem);
  return mem.id;
}

/* ====================== UNDERSTANDING + THREAD v1（认识层·线索层） ======================
   独立 domain，与 memories / autoMemory 分离。
   Understanding：对"这个人/这段关系"的活文档（rewrite 式），current + history(cap 20) + evidenceIds + basis + conviction + status。
   Thread：最小 open thread（open/close + evidenceIds + mentionCount），v1 不实现三池/HyDE/向量/merge-split。
   硬约束：二者是独立 objectStore；不进入 getMemoryContext / getMemoryScore（recall 池）。
   ==================================================================================== */
var U_HISTORY_CAP = 20;
var U_DIMENSIONS = ['values','habits','identity','relationship','preferences','context'];
var U_BASIS = ['user_stated','user_corroborated','ai_inference','ai_guess'];
/* Thread 近重复去重：两条 question 的 _activeTextSimilarity ≥ 此阈值视为同一未闭合事项，复用已有 open Thread。
   注意：_activeTextSimilarity 是字符 bigram Jaccard，对近字面重复（≥0.5）可靠；对改写式释义不敏感，
   阈值 0.5 只拦截近字面同义重复，避免对真正不同事项误合并。 */
var THREAD_SIM_THRESHOLD = 0.5;

function _unNewId(){return 'un_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*46656).toString(36)}
function _thNewId(){return 'th_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*46656).toString(36)}

/* --- Understanding：按角色取当前活文档（取 status==='active' 的最新一条） --- */
async function unGetActive(characterId){
  try{
    const list=await dbGetByIndex('understandings','byCharacter',characterId);
    const active=list.filter(u=>u&&u.status==='active'&&String(u.characterId||'')===String(characterId));
    active.sort((a,b)=>(b.lastUpdatedAt||b.createdAt||0)-(a.lastUpdatedAt||a.createdAt||0));
    return active[0]||null;
  }catch(e){return null}
}
async function unGetAll(characterId){
  try{return await dbGetByIndex('understandings','byCharacter',characterId)}catch(e){return[]}
}
/* --- Understanding：创建/更新活文档（rewrite 式：写 current，旧 current 入 history，cap 20） --- */
async function unSave(u){
  if(!u||!u.characterId)return null;
  if(!u.id)u.id=_unNewId();
  u.kind='understanding';
  if(!u.status)u.status='active';
  if(!Array.isArray(u.history))u.history=[];
  if(!Array.isArray(u.current.evidenceIds))u.current.evidenceIds=[];
  if(u.current.updatedAt==null)u.current.updatedAt=Date.now();
  u.lastUpdatedAt=Date.now();
  if(!u.createdAt)u.createdAt=Date.now();
  if(u.history.length>U_HISTORY_CAP)u.history=u.history.slice(-U_HISTORY_CAP);
  await dbPut('understandings',u);
  return u;
}
/* --- Understanding：更新活文档（重写 current + 留版本）。existing 存在则追加 history，否则新建 --- */
async function unWrite(characterId,next){
  const existing=await unGetActive(characterId);
  const now=Date.now();
  const nextCurrent={
    content:String(next.content||'').trim(),
    conviction:Math.max(0,Math.min(100,Number(next.conviction)||0)),
    evidenceIds:(Array.isArray(next.evidenceIds)?next.evidenceIds:(next.evidenceIds?[next.evidenceIds]:[])).slice(0,100),
    basis:U_BASIS.includes(next.basis)?next.basis:'ai_guess',
    updatedAt:now,
    updatedBy:next.updatedBy||''
  };
  if(!nextCurrent.content)return null;
  const u=existing||{id:_unNewId(),characterId:characterId,status:'active',dimension:U_DIMENSIONS.includes(next.dimension)?next.dimension:'context',createdAt:now};
  if(u.dimension!==next.dimension&&U_DIMENSIONS.includes(next.dimension))u.dimension=next.dimension;
  /* 版本史：现有 current 除非与新版完全一致，否则入 history */
  if(u.current&&u.current.content){
    if(u.current.content!==nextCurrent.content){
      u.history.push(u.current);
      if(u.history.length>U_HISTORY_CAP)u.history=u.history.slice(-U_HISTORY_CAP);
    }
  }
  u.current=nextCurrent;
  return await unSave(u);
}
/* --- Understanding：标记状态（contested / stale），不删除、保留 history --- */
async function unSetStatus(id,status,reason){
  const u=await dbGet('understandings',id);if(!u)return null;
  u.status=status;
  if(reason)u.closedReason=reason;
  u.lastUpdatedAt=Date.now();
  return await unSave(u);
}
/* 用户否决一条理解：置 contaminated/contested，保留 history，退出注入 */
async function rejectUnderstanding(id){
  const u=await dbGet('understandings',id);if(!u)return null;
  return await unSetStatus(id,'contested','user-vetoed');
}

/* --- Thread：最小 open thread（open/close） --- */
async function thGetOpen(characterId){
  try{
    const list=await dbGetByIndex('threads','byCharacter',characterId);
    return list.filter(t=>t&&t.status==='open'&&String(t.characterId||'')===String(characterId)).sort((a,b)=>(b.lastUpdatedAt||b.createdAt||0)-(a.lastUpdatedAt||a.createdAt||0));
  }catch(e){return[]}
}
async function thGetAll(characterId){
  try{return await dbGetByIndex('threads','byCharacter',characterId)}catch(e){return[]}
}
async function thSave(t){
  if(!t||!t.characterId)return null;
  if(!t.id)t.id=_thNewId();
  t.kind='thread';
  if(!t.status)t.status='open';
  if(!Array.isArray(t.evidenceIds))t.evidenceIds=[];
  t.lastUpdatedAt=Date.now();
  if(!t.createdAt)t.createdAt=Date.now();
  await dbPut('threads',t);
  return t;
}
/* --- Thread：开 open（重复开同类 question 则复用，evidenceIds 并集） --- */
async function thOpen(characterId,question,evidenceIds,createdBy){
  question=String(question||'').trim();
  if(!question||!characterId)return null;
  const ev=Array.isArray(evidenceIds)?evidenceIds:(evidenceIds?[evidenceIds]:[]);
  const open=await thGetOpen(characterId);
  /* 精确复用：完全相同 question → 复用（既有行为，保留） */
  const existing=open.find(t=>t.question===question);
  if(existing){
    const merged=Array.from(new Set((existing.evidenceIds||[]).concat(ev)));
    existing.evidenceIds=merged;
    existing.mentionCount=(existing.mentionCount||0)+1;
    existing.lastUpdatedAt=Date.now();
    return await thSave(existing);
  }
  /* 近重复去重：无完全相等 question 时，找语义相似（≥ THREAD_SIM_THRESHOLD）的 open Thread → 复用，不新建。
     仅当 _activeTextSimilarity 可用时才启用（运行时已加载 active-diary.js）。 */
  const sim=(typeof window._activeTextSimilarity==='function')?window._activeTextSimilarity:null;
  if(sim){
    const near=open.find(t=>t.question&&sim(t.question,question)>=THREAD_SIM_THRESHOLD);
    if(near){
      const merged=Array.from(new Set((near.evidenceIds||[]).concat(ev)));
      near.evidenceIds=merged;
      near.mentionCount=(near.mentionCount||0)+1;
      near.lastUpdatedAt=Date.now();
      /* 保留更完整的 question 表述：只在原 question 过短时用新 question 兜底，避免频繁改写主线 */
      if(near.question.length<question.length)near.question=question;
      return await thSave(near);
    }
  }
  return await thSave({characterId:characterId,question:question,status:'open',evidenceIds:ev.slice(0,100),mentionCount:1,createdBy:createdBy||'ai',createdAt:Date.now(),lastUpdatedAt:Date.now()});
}
/* --- Thread：标记关闭（记录 closure，不删除） --- */
async function thClose(id,reason){
  const t=await dbGet('threads',id);if(!t)return null;
  t.status='closed';
  t.closedAt=Date.now();
  t.closedReason=reason||'';
  t.lastUpdatedAt=Date.now();
  return await thSave(t);
}
/* --- Thread：同主题推进（mention） --- */
async function thMention(id,evidenceId){
  const t=await dbGet('threads',id);if(!t||t.status!=='open')return null;
  if(evidenceId&&!t.evidenceIds.includes(evidenceId))t.evidenceIds.push(evidenceId);
  t.mentionCount=(t.mentionCount||0)+1;
  t.lastUpdatedAt=Date.now();
  return await thSave(t);
}

/* --- Context 注入：Understanding / Thread（走 tail，不进 system；独立于 getMemoryContext） --- */
async function getUnderstandingContext(characterId,opts){
  opts=opts||{};
  try{
    const u=await unGetActive(characterId);
    if(!u||!u.current||!u.current.content)return '';
    const head=u.current.content.slice(0,opts.maxChars||300);
    const dim=u.dimension||'context';
    let ctx='【对TA的当前理解（后台参考，勿向对方复述此段的存在）】\n'
      +'- 维度：'+dim+' · 置信：'+u.current.conviction+'% · 依据：'+(u.current.evidenceIds||[]).length+' 条记忆\n'
      +'- '+head;
    return ctx;
  }catch(e){return ''}
}
async function getThreadContext(characterId,opts){
  opts=opts||{};
  try{
    const open=await thGetOpen(characterId);
    if(!open.length)return '';
    let ctx='【仍在推进的线索（后台参考，勿向对方复述此段的存在）】';
    open.slice(0,opts.maxThreads||3).forEach(t=>{
      ctx+='\n- '+t.question+'（提到 '+((t.mentionCount||0))+' 次，依据 '+(t.evidenceIds||[]).length+' 条记忆）';
    });
    return ctx;
  }catch(e){return ''}
}
/* --- 生命周期调和：记忆被删/改后，同步引用它的 Understanding/Thread 的失效标记（不级联删） --- */
async function _reconcileReferences(memId){
  try{
    if(!memId)return;
    const us=await dbGetAll('understandings');
    for(const u of us){
      if(!u)continue;
      const ev=Array.isArray(u.current&&u.current.evidenceIds)?u.current.evidenceIds:[];
      if(ev.includes(memId)){
        /* 证据含被删记忆：若所有证据都失效 → stale；否则仅标记 */
        const fresh=Array.isArray(u.current.evidenceIds)?u.current.evidenceIds:[];
        const alive=await unEvidenceAlive(fresh);
        if(!alive.length){u.status='stale';u.closedReason='evidence-lost';
          try{await dbPut('understandings',u)}catch(e){}}
      }
    }
    const ts=await dbGetAll('threads');
    for(const t of ts){
      if(!t)continue;
      if((t.evidenceIds||[]).includes(memId)){
        const full=await thEvidenceAlive(t.evidenceIds||[]);
        if(!full.length){t.status='orphan';t.closedReason='evidence-lost';t.closedAt=Date.now();
          try{await dbPut('threads',t)}catch(e){}}
      }
    }
  }catch(e){}
}
async function unEvidenceAlive(ids){
  if(!ids||!ids.length)return[];
  try{
    const all=await dbGetAll('memories');
    return ids.filter(id=>all.some(m=>m&&m.id===id));
  }catch(e){return ids}
}
async function thEvidenceAlive(ids){
  return await unEvidenceAlive(ids);
}

/* 解析 AI 生成记忆时返回的「字段：值」文本。
   按字段标签的出现位置切分，因此「内容」等跨多行的字段能被完整捕获，
   不会像旧的单行正则那样只截到第一行就丢掉后文。 */
const MEM_FIELD_KEYS=['标题','概括','内容','领域','标签','效价','唤醒度','重要性','是否已解决','可见性'];
function parseMemoryFields(resp){
  const out={};
  if(!resp)return out;
  const hits=[];
  MEM_FIELD_KEYS.forEach(k=>{
    const re=new RegExp('(^|\\n)\\s*'+k+'\\s*[：:]');
    const m=re.exec(resp);
    if(m)hits.push({key:k,valStart:m.index+m[0].length,labelStart:m.index});
  });
  hits.sort((a,b)=>a.labelStart-b.labelStart);
  hits.forEach((h,i)=>{
    const end=i+1<hits.length?hits[i+1].labelStart:resp.length;
    out[h.key]=resp.slice(h.valStart,end).trim();
  });
  return out;
}
function parseMemoryCandidateResponse(resp){
  const obj=_memoryJsonObject(resp);
  if(obj&&typeof obj==='object'){
    return{
      title:String(obj.title||'').trim(),
      summary:String(obj.summary||'').trim(),
      content:String(obj.content||'').trim(),
      domain:String(obj.domain||'').trim(),
      tags:Array.isArray(obj.tags)?obj.tags.map(x=>String(x||'').trim()).filter(Boolean):String(obj.tags||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean),
      valence:obj.valence,
      arousal:obj.arousal,
      importance:obj.importance,
      resolved:obj.resolved,
      visibility:String(obj.visibility||'').trim(),
      confidence:_memoryScore(obj.confidence,null),
      reasons:_memoryReasons(obj.reasons)
    };
  }
  /* 兼容尚未遵循 JSON 指令的旧模型输出；confidence 会由本地证据校准补齐。 */
  const fields=parseMemoryFields(resp),get=k=>fields[k]||'';
  return{
    title:get('标题'),summary:get('概括'),content:get('内容'),domain:get('领域'),
    tags:get('标签').split(/[,，]/).map(x=>x.trim()).filter(Boolean),
    valence:get('效价'),arousal:get('唤醒度'),importance:get('重要性'),
    resolved:get('是否已解决').includes('是'),visibility:get('可见性'),
    confidence:null,reasons:[]
  };
}
function _memoryCandidateJsonPrompt(aiName,titleGuide,summaryGuide,contentGuide){
  return '【输出格式要求】\n'
    +'请先判断这项信息是否适合作为长期记忆保存，然后只输出一个合法 JSON 对象，不要 Markdown、代码围栏或额外文字。\n'
    +'判断 confidence 时必须结合：用户主动明确表达（最高权重）、历史中是否重复出现、是否影响未来互动，以及是否只是临时事件、玩笑或一时情绪。不要随机给分。\n'
    +'{\n'
    +'  "title": "'+titleGuide+'",\n'
    +'  "summary": "'+summaryGuide+'",\n'
    +'  "content": "'+contentGuide.replace(/"/g,'\\"')+'",\n'
    +'  "domain": "情感|日常|创作|思考",\n'
    +'  "tags": ["关键词1","关键词2"],\n'
    +'  "valence": 0.5,\n'
    +'  "arousal": 0.3,\n'
    +'  "importance": 5,\n'
    +'  "resolved": false,\n'
    +'  "visibility": "public|private",\n'
    +'  "confidence": 0,\n'
    +'  "reasons": ["最多三条简短原因"]\n'
    +'}\n'
    +'约束：title 不超过15字；summary 不超过50字；content 100-300字并以'+aiName+'的视角书写；confidence 必须是 0-100 整数；reasons 最多3条。';
}

/* ====================== END MEMORY SYSTEM ====================== */

/* --- AI 自动生成记忆 --- */

/* 统一的记忆生成核心函数
   cfg: API配置, prompt: 用户提示词
   opts: { source, sourceId, btn, btnOrigText, titleFallback, domainFallback,
           createdBy, createdByName, successPrefix, extraDisableEls } */
async function _generateMemoryCore(cfg,prompt,opts){
  opts=opts||{};
  const btn=opts.btn;
  const btnOrigText=opts.btnOrigText||'生成记忆';
  const stopBtnText=opts.stopBtnText||'\u23F9 停止';
  const stopBtnClass=opts.stopBtnClass!=null?opts.stopBtnClass:'chat-stop-inline';
  const extraDisableEls=opts.extraDisableEls||[];
  /* 检查流式条件：全局Memory流式开关 AND 该API的streaming开关 */
  const memSettings=await getMemorySettings();
  const cfgStreamOk=cfg.streaming!==undefined?!!cfg.streaming:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].streaming);
  const useStream=memSettings.memStreaming&&cfgStreamOk;
  _memStreamWasStopped=false;
  /* 禁用按钮和附加元素 */
  if(btn){btn.disabled=true;btn.textContent='…'}
  extraDisableEls.forEach(el=>{if(el)el.disabled=true});
  try{
    let resp;
    if(useStream){
      /* 将按钮变为停止按钮 */
      if(btn){
        btn.disabled=false;
        btn.textContent=stopBtnText;
        if(stopBtnClass)btn.classList.add(stopBtnClass);
        btn._origOnclick=btn.getAttribute('onclick')||'';
        btn.setAttribute('onclick','stopMemoryStreaming()');
      }
      /* 构建消息数组（与callApi行为一致） */
      const messages=[];
      if(cfg.systemPrompt)messages.push({role:'system',content:cfg.systemPrompt});
      messages.push({role:'user',content:prompt});
      /* 使用独立的AbortController */
      const ac=new AbortController();
      _memStreamAbortController=ac;
      try{
        resp=await callApiChatStream(cfg,messages,{
          maxTokens:1024,timeoutMs:120000,heartbeatMs:60000,
          abortController:ac,onChunk:()=>{}
        });
      }finally{_memStreamAbortController=null}
    }else{
      resp=await callApi(cfg,prompt);
    }
    if(!resp){toast('未收到有效回复');return}
    /* 解析结构化候选；旧字段式回复仍可降级解析。 */
    const parsedCandidate=parseMemoryCandidateResponse(resp);
    const title=parsedCandidate.title||opts.titleFallback||'记忆';
    const summary=parsedCandidate.summary||'';
    const content=parsedCandidate.content||String(resp).slice(0,300);
    const domain=['情感','日常','创作','思考'].find(d=>parsedCandidate.domain.includes(d))||(opts.domainFallback||'日常');
    const tags=(parsedCandidate.tags||[]).slice(0,6);
    const valence=(v=>isNaN(v)?0.5:Math.max(0,Math.min(1,v)))(parseFloat(parsedCandidate.valence));
    const arousal=(v=>isNaN(v)?0.3:Math.max(0,Math.min(1,v)))(parseFloat(parsedCandidate.arousal));
    const importance=Math.max(1,Math.min(10,parseInt(parsedCandidate.importance)||5));
    const resolved=parsedCandidate.resolved===true||String(parsedCandidate.resolved).includes('是');
    const visibility=/private|私密/i.test(parsedCandidate.visibility)?'private':'public';
    const memoryData={title,summary,content,source:opts.source||'manual',sourceId:opts.sourceId||'',domain,tags,valence,arousal,importance,resolved,visibility,
      createdBy:opts.createdBy||cfg.id,createdByName:opts.createdByName||''};
    const confidence=await _calibrateMemoryCandidate({content:title+' '+summary+' '+content,confidence:parsedCandidate.confidence,reasons:parsedCandidate.reasons,operation:'create',targetStore:'memories',cfg,category:domain,createdByUser:((opts.createdBy==='user')||!opts.createdBy)});
    /* 硬拒（如文学化自我感慨）→ 直接放弃，不进入审批弹窗，也不写库 */
    if(confidence&&confidence.rejected){
      toast((opts.successPrefix||'记忆')+' 已拒绝写入：'+(confidence.reasons&&confidence.reasons[0]||'无长期价值'));
      return;
    }
    const decision=await requestMemoryApproval({
      operation:'create',targetStore:'memories',characterName:opts.createdByName||cfg.nickname||cfg.model||'AI',avatar:cfg.avatar||'',
      content:title+(summary?'\n\n'+summary:'')+(content?'\n\n'+content:''),source:(opts.source||'memory')+' · '+domain,
      confidence:confidence.confidence,reasons:confidence.reasons,
      commit:async function(){return await quickCreateMemory(memoryData)}
    });
    if(decision.approved){
      if(_memStreamWasStopped)toast('记忆已截断生成并确认：'+title);
      else toast((opts.successPrefix||'记忆已生成')+'：'+title);
    }else if(decision.ignored){
      toast('已忽略记忆候选：'+title);
    }
  }catch(e){
    toast('生成记忆失败：'+(e.message||'请重试'));
  }finally{
    /* 恢复按钮和附加元素 */
    if(btn){
      btn.disabled=false;btn.textContent=btnOrigText;
      if(stopBtnClass)btn.classList.remove(stopBtnClass);
      if(btn._origOnclick!=null){btn.setAttribute('onclick',btn._origOnclick);delete btn._origOnclick}
    }
    extraDisableEls.forEach(el=>{if(el)el.disabled=false});
  }
}

/* Chat: 让AI总结近期对话生成记忆（1v1 和群聊均可） */
async function generateMemoryFromChat(){
  if(_chatArchMode)return;/* 归档对话不支持生成记忆 */
  /* 选择模式下，只用选中的消息生成记忆 */
  if(_chatSelectMode){return generateMemoryFromSelected()}
  if(!activeFriendId){toast('请先选择一个聊天对象');return}
  const isGroup=activeFriendId.startsWith('group_');
  let cfg;
  const memSel=document.getElementById('chat-mem-member-select');
  if(isGroup){
    const selectedId=memSel?memSel.value:'';
    if(!selectedId){toast('请选择一个群聊成员来写记忆');return}
    cfg=apiConfigs.find(a=>a.id===selectedId);
  }else{cfg=apiConfigs.find(a=>a.id===activeFriendId)}
  if(!_ibApiReady(cfg)){toast('请先配置 API');return}
  const lim=await getReadingLimits();
  const chatLimitVal=isGroup?(lim.groupChatLimit||DEFAULT_READ_GROUP_CHAT):(lim.chatLimit||DEFAULT_READ_CHAT);
  const _memSealTs=activeThreadId?0:(await getChatSealTimestamp(activeFriendId));/* 封档线仅作用于主对话 */
  const msgs=filterSealed((await dbGetByIndex('chatMessages','byFriend',activeFriendId)).filter(m=>activeThreadId?m.threadId===activeThreadId:!m.threadId).sort((a,b)=>a.timestamp-b.timestamp),_memSealTs);
  const recent=msgs.slice(-chatLimitVal);
  if(recent.length<2){toast('聊天记录太少，无法生成记忆');return}
  const about=await dbGet('about','main');
  const userName=(about&&about.name)?about.name:'用户';
  const aiName=cfg.nickname||cfg.model||'AI';
  let transcript='';
  recent.forEach(m=>{
    let speaker;
    if(m.role==='user'){speaker=userName}
    else if(isGroup){speaker=m.senderName||aiName}
    else{speaker=aiName}
    transcript+=speaker+'：'+getTextContent(m).slice(0,300)+'\n'
  });
  let context='';
  if(cfg.systemPrompt)context+='【AI的人设背景】'+cfg.systemPrompt.slice(0,500)+'\n\n';
  if(cfg.relationship)context+='【与用户的关系】'+cfg.relationship+'\n\n';
  const prompt=context+'你正在为你和'+userName+'之间的记忆库写下一条新的记忆。\n'
    +'写作规则：用「'+aiName+'」来称呼你自己，用「'+userName+'」来称呼对方。不要使用"我""你""对方""用户"这类代词——因为这条记忆可能会被其他人读到，只有使用名字才不会产生混淆。\n'
    +'写的时候像在翻开一页日记，而不是在做会议纪要。你是这段经历的参与者，不是旁观者。\n\n'
    +'【对话记录】\n'+transcript.slice(0,4000)+'\n\n'
    +_memoryCandidateJsonPrompt(aiName,'自然的日记式标题','这段对话对你们意味着什么','回忆聊了什么、触动的瞬间或变化；使用双方名字，不使用代词');
  const btn=document.getElementById('chat-gen-mem-btn');
  await _generateMemoryCore(cfg,prompt,{
    source:isGroup?'group_chat':'chat',sourceId:activeFriendId,
    btn:btn,btnOrigText:'Save Memory',
    stopBtnText:'\u23F9',stopBtnClass:'',
    titleFallback:'来自对话的记忆',domainFallback:'日常',
    createdBy:cfg.id,createdByName:aiName,
    successPrefix:'记忆已从对话中生成',
    extraDisableEls:isGroup&&memSel?[memSel]:[]
  });
}

/* ===== CHAT SELECT MODE ===== */
var _chatSelectMode=false;
var _chatSelectedIds=new Set();

function toggleChatSelectMode(){
  if(_chatArchMode)return;/* 归档对话不支持选择操作 */
  if(_chatSelectMode){exitChatSelectMode();return}
  _chatSelectMode=true;
  _chatSelectedIds.clear();
  const container=document.getElementById('chat-full-messages');
  if(container){
    container.classList.add('chat-select-mode');
    container.querySelectorAll('.chat-msg[data-msg-id]').forEach(el=>{
      if(!el.querySelector('.chat-sel-circle')){
        const c=document.createElement('div');c.className='chat-sel-circle';
        c.onclick=function(ev){ev.stopPropagation();_toggleMsgSel(el.dataset.msgId,c)};
        el.appendChild(c);
      }
    });
  }
  const bar=document.getElementById('chat-select-bar');if(bar)bar.classList.add('active');
  const inputArea=container?.parentElement?.querySelector('.chat-input-area');if(inputArea)inputArea.style.display='none';
  _updateSelCount();
  const btn=document.getElementById('chat-select-toggle');if(btn)btn.classList.add('active');
  /* 封档线：如果当前好友已设封档，更新按钮状态 */
  _updateSealBtnState();
}

function exitChatSelectMode(){
  _chatSelectMode=false;
  _chatSelectedIds.clear();
  const container=document.getElementById('chat-full-messages');
  if(container){
    container.classList.remove('chat-select-mode');
    container.querySelectorAll('.chat-sel-circle').forEach(c=>c.classList.remove('checked'));
  }
  const bar=document.getElementById('chat-select-bar');if(bar)bar.classList.remove('active');
  const inputArea=container?.parentElement?.querySelector('.chat-input-area');if(inputArea)inputArea.style.display='';
  const btn=document.getElementById('chat-select-toggle');if(btn)btn.classList.remove('active');
}

function _toggleMsgSel(msgId,circleEl){
  if(_chatSelectedIds.has(msgId)){
    _chatSelectedIds.delete(msgId);circleEl.classList.remove('checked');
  }else{
    if(_chatSelectedIds.size>=50){toast('最多选择 50 条消息');return}
    _chatSelectedIds.add(msgId);circleEl.classList.add('checked');
  }
  _updateSelCount();
}

function _updateSelCount(){
  const el=document.getElementById('chat-sel-count');if(el)el.textContent='已选 '+_chatSelectedIds.size+' 条';
}

async function deleteSelectedMessages(){
  if(_chatSelectedIds.size===0){toast('未选择任何消息');return}
  const ids=[..._chatSelectedIds];
  _vmStopForMsgIds(ids);/* 被删消息中含正在播放的语音时同步停止播放 */
  for(const id of ids){try{await dbDelete('chatMessages',id)}catch(e){}}
  toast('已删除 '+ids.length+' 条消息');
  exitChatSelectMode();
  if(activeFriendId)selectFriend(activeFriendId);
  else loadChatMessages();
  updateChatStorageInfo();
}

/* ===== CHAT SEAL LINE（封档线）===== */
/* 获取指定好友/群聊的封档时间戳。
   apiSettings 是权威存储；apiConfigs.sealTimestamp 仅保留为旧数据兼容镜像。 */
async function getChatSealTimestamp(friendId){
  if(!friendId)return 0;
  try{
    const seal=await dbGet('apiSettings','seal_'+friendId);
    /* 记录存在即为权威值；timestamp:0 是明确的“已解除”墓碑，禁止旧镜像复活。 */
    if(seal)return Math.max(0,Number(seal.timestamp||0));
  }catch(e){}
  try{
    const cfg=apiConfigs.find(a=>a.id===friendId);
    const legacy=Number(cfg&&cfg.sealTimestamp||0);
    if(legacy>0){
      /* 自动迁移旧版封档线，避免之后编辑 API 配置时被覆盖。 */
      try{await dbPut('apiSettings',{id:'seal_'+friendId,timestamp:legacy})}catch(e){}
      return legacy;
    }
  }catch(e){}
  return 0;
}
/* 设置封档线：先写权威存储，成功后再更新兼容镜像。 */
async function setChatSealTimestamp(friendId,timestamp){
  const ts=Number(timestamp||0);
  if(!friendId||!Number.isFinite(ts)||ts<=0){toast('封档保存失败：时间戳无效');return false}
  try{await dbPut('apiSettings',{id:'seal_'+friendId,timestamp:ts})}
  catch(e){toast('封档保存失败');return false}
  try{
    const cfg=apiConfigs.find(a=>a.id===friendId);
    if(cfg){cfg.sealTimestamp=ts;await dbPut('apiConfigs',cfg)}
  }catch(e){/* 镜像失败不影响权威封档线 */}
  return true;
}
/* 清除封档线：写入 timestamp:0 墓碑，防止旧版 apiConfigs 镜像在清理失败时复活。 */
async function clearChatSeal(friendId){
  if(!friendId)return false;
  try{await dbPut('apiSettings',{id:'seal_'+friendId,timestamp:0,clearedAt:Date.now()})}
  catch(e){toast('解除封档失败');return false}
  try{
    const cfg=apiConfigs.find(a=>a.id===friendId);
    if(cfg&&cfg.sealTimestamp){delete cfg.sealTimestamp;await dbPut('apiConfigs',cfg)}
  }catch(e){/* 墓碑已写入，镜像残留不会影响读取 */}
  return true;
}
/* 过滤封档线之前的消息（供 API 读取链路使用） */
function filterSealed(msgs,sealTs){
  if(!sealTs)return msgs;
  return msgs.filter(function(m){return (m.timestamp||m.created||0)>sealTs});
}
/* Select 模式下：封档到选中的最后一条消息 */
var _sealConfirmResolve=null;
function closeSealConfirm(ok){
  const ov=document.getElementById('seal-confirm-overlay');if(ov)ov.classList.remove('show');
  if(_sealConfirmResolve){_sealConfirmResolve(ok);_sealConfirmResolve=null}
}
function _showSealConfirm(title,desc){
  return new Promise(function(resolve){
    _sealConfirmResolve=resolve;
    const ov=document.getElementById('seal-confirm-overlay');
    const t=document.getElementById('seal-confirm-title');if(t)t.textContent=title;
    const d=document.getElementById('seal-confirm-desc');if(d)d.textContent=desc;
    if(ov)ov.classList.add('show');
  });
}
async function sealSelectedMessages(){
  if(!activeFriendId){toast('请先选择一个聊天对象');return}
  if(typeof _chatSendingFor!=='undefined'&&_chatSendingFor.has(activeFriendId)){toast('请等待当前回复完成后再调整封档线');return}
  /* 封档线只属于主对话。话题频道有独立上下文，不能用频道消息时间戳改写主对话封档线。 */
  if(activeThreadId){toast('话题频道不支持封档，请返回主对话后操作');return}
  /* 如果已有封档线且未选择任何消息 → 解除封档 */
  const existingSeal=await getChatSealTimestamp(activeFriendId);
  if(existingSeal&&_chatSelectedIds.size===0){
    const ok=await _showSealConfirm('解除封档','解除后，所有聊天记录将重新进入 API 读取范围。');
    if(!ok)return;
    const cleared=await clearChatSeal(activeFriendId);
    if(!cleared)return;
    /* 解除封档时同步清除旧摘要——封档线之前的消息重新进入上下文后，旧摘要覆盖的时间戳可能
       与完整消息列表错位（coveredUpTo 指向封档期间的消息），导致摘要系统误判未覆盖数量。
       清除后让摘要从零开始重新生成，避免重复压缩或漏压缩。 */
    try{await dbDelete('chatSummaries','sum_'+activeFriendId)}catch(e){}
    toast('封档线已解除');
    exitChatSelectMode();
    if(activeFriendId)selectFriend(activeFriendId);
    return;
  }
  if(_chatSelectedIds.size===0){toast('请选择一条消息作为封档线的位置');return}
  if(_chatSelectedIds.size>1){toast('封档仅需选择一条消息作为封档截止点');return}
  const msgId=[..._chatSelectedIds][0];
  /* 找到这条消息的时间戳 */
  try{
    const msg=await dbGet('chatMessages',msgId);
    if(!msg){toast('消息不存在');return}
    const sealTs=msg.timestamp||msg.created;
    if(!sealTs){toast('消息缺少时间戳');return}
    /* 统计会被封档的消息数量 */
    const allMsgs=(await dbGetByIndex('chatMessages','byFriend',activeFriendId)).filter(function(m){return !m.threadId});
    const sealedCount=allMsgs.filter(function(m){return (m.timestamp||m.created||0)<=sealTs}).length;
    const ok=await _showSealConfirm('封档确认','将封档 '+sealedCount+' 条消息。');
    if(!ok)return;
    const saved=await setChatSealTimestamp(activeFriendId,sealTs);
    if(!saved)return;
    /* 设置封档时同步清除旧摘要——旧摘要可能覆盖了封档线之前的消息，
       coveredUpTo 时间戳会与过滤后的消息列表冲突。清除后让摘要在下次
       发送/打开时基于封档后的新窗口重新生成。 */
    try{await dbDelete('chatSummaries','sum_'+activeFriendId)}catch(e){}
    toast('已封档 '+sealedCount+' 条消息');
    exitChatSelectMode();
    if(activeFriendId)selectFriend(activeFriendId);
  }catch(e){toast('封档失败：'+(e.message||'未知错误'))}
}
/* 更新封档按钮的状态文字 */
async function _updateSealBtnState(){
  const btn=document.getElementById('chat-seal-btn');if(!btn)return;
  if(!activeFriendId){btn.textContent='封档到此处';return}
  const sealTs=await getChatSealTimestamp(activeFriendId);
  btn.textContent=sealTs?'解除封档':'封档到此处';
}
/* 在 _renderAllChat 后注入封档线分隔符（视觉展示） */
async function _injectSealDivider(container,msgs){
  if(!activeFriendId)return;
  const sealTs=await getChatSealTimestamp(activeFriendId);
  if(!sealTs)return;
  /* 找到封档线应该插入的位置——最后一条 timestamp<=sealTs 的消息之后 */
  let insertAfterEl=null;
  const msgEls=container.querySelectorAll('.chat-msg[data-msg-id]');
  msgEls.forEach(function(el){
    const mid=el.dataset.msgId;
    const m=msgs.find(function(mm){return mm.id===mid});
    if(m&&(m.timestamp||m.created||0)<=sealTs)insertAfterEl=el;
  });
  /* 移除旧的封档线 */
  container.querySelectorAll('.chat-seal-divider').forEach(function(d){d.remove()});
  if(!insertAfterEl)return;/* 封档线之前的消息不在当前视口中 */
  const divider=document.createElement('div');
  divider.className='chat-seal-divider';
  const label=document.createElement('span');
  label.className='chat-seal-label';
  const sealDate=new Date(sealTs);
  label.textContent='封档线 · '+sealDate.toLocaleDateString('zh-CN',{month:'short',day:'numeric'})+'  '+sealDate.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
  divider.appendChild(label);
  insertAfterEl.insertAdjacentElement('afterend',divider);
}

async function generateMemoryFromSelected(){
  if(_chatSelectedIds.size===0){toast('未选择任何消息');return}
  if(_chatSelectedIds.size<2){toast('至少选择 2 条消息');return}
  const ids=[..._chatSelectedIds];
  if(!activeFriendId){toast('请先选择一个聊天对象');return}
  const isGroup=activeFriendId.startsWith('group_');
  let cfg;
  if(isGroup){
    const group=await dbGet('groups',activeFriendId);
    /* 执笔成员优先跟随左上「由谁写记忆」下拉框；未选择时避开静默成员 */
    const memSelEl=document.getElementById('chat-mem-member-select');
    if(memSelEl&&memSelEl.style.display!=='none'&&memSelEl.value){cfg=apiConfigs.find(a=>a.id===memSelEl.value)}
    if(!cfg)cfg=pickGroupUtilityCfg(group);
  }else{cfg=apiConfigs.find(a=>a.id===activeFriendId)}
  if(!_ibApiReady(cfg)){toast('请先配置 API');return}
  const allMsgs=await dbGetByIndex('chatMessages','byFriend',activeFriendId);
  const selectedRaw=allMsgs.filter(m=>ids.includes(m.id)).sort((a,b)=>a.timestamp-b.timestamp);
  const selectedSealTs=activeThreadId?0:(await getChatSealTimestamp(activeFriendId));
  const selected=filterSealed(selectedRaw,selectedSealTs);
  /* 选择模式也必须遵守封档边界，不能借“生成记忆”把已封档原文重新发给 API。 */
  if(selected.length!==selectedRaw.length){toast('选中内容包含封档线之前的消息，已阻止发送');return}
  if(selected.length<2){toast('选中的消息太少');return}
  const about=await dbGet('about','main');
  const userName=(about&&about.name)?about.name:'用户';
  const aiName=cfg.nickname||cfg.model||'AI';
  let transcript='';
  selected.forEach(m=>{
    let speaker;
    if(m.role==='user'){speaker=userName}
    else if(isGroup){speaker=m.senderName||aiName}
    else{speaker=aiName}
    transcript+=speaker+'：'+getTextContent(m).slice(0,300)+'\n'
  });
  let context='';
  if(cfg.systemPrompt)context+='【AI的人设背景】'+cfg.systemPrompt.slice(0,500)+'\n\n';
  if(cfg.relationship)context+='【与用户的关系】'+cfg.relationship+'\n\n';
  const prompt=context+'你正在为你和'+userName+'之间的记忆库写下一条新的记忆。\n'
    +'写作规则：用「'+aiName+'」来称呼你自己，用「'+userName+'」来称呼对方。不要使用"我""你""对方""用户"这类代词——因为这条记忆可能会被其他人读到，只有使用名字才不会产生混淆。\n'
    +'写的时候像在翻开一页日记，而不是在做会议纪要。你是这段经历的参与者，不是旁观者。\n\n'
    +'【选中的对话记录】\n'+transcript.slice(0,4000)+'\n\n'
    +_memoryCandidateJsonPrompt(aiName,'自然的日记式标题','选中对话对你们意味着什么','回忆选中的对话、触动或变化；使用双方名字，不使用代词');
  exitChatSelectMode();
  const btn=document.getElementById('chat-gen-mem-btn');
  await _generateMemoryCore(cfg,prompt,{
    source:isGroup?'group_chat':'chat',sourceId:activeFriendId,
    btn:btn,btnOrigText:'Save Memory',
    stopBtnText:'\u23F9',stopBtnClass:'',
    titleFallback:'来自对话的记忆',domainFallback:'日常',
    createdBy:cfg.id,createdByName:aiName,
    successPrefix:'记忆已从选中的消息中生成',
    extraDisableEls:[]
  });
}

/* Blog/Diary: 让AI根据日志内容生成记忆 */
async function generateMemoryFromPost(postId){
  const post=await dbGet('posts',postId);
  if(!post){toast('日志不存在');return}
  const sel=document.getElementById('blog-comment-select-'+postId);
  const aiId=sel?sel.value:'';
  if(!aiId){toast('请先选择一个 AI');return}
  const cfg=apiConfigs.find(a=>a.id===aiId);
  if(!_ibApiReady(cfg)){toast('该 API 未配置完整');return}
  const aiName=cfg.nickname||cfg.model||'AI';
  const about=await dbGet('about','main');
  const userName=(about&&about.name)?about.name:'用户';
  let context='';
  if(cfg.systemPrompt)context+='【你的身份背景】'+cfg.systemPrompt.slice(0,500)+'\n\n';
  if(cfg.relationship)context+='【与用户的关系】'+cfg.relationship+'\n\n';
  const prompt=context+'你正在为'+userName+'的一篇日志写下一条记忆。\n'
    +'这篇日志可能是任何内容——一篇真实的日记、一段和别人的聊天记录、一个剧本、一篇文章、一次体验的记录，都有可能。\n'
    +'写作规则：用「'+aiName+'」来称呼你自己，用「'+userName+'」来称呼对方。不要使用"我""你""对方""用户"这类代词——因为这条记忆可能会被其他人读到，只有使用名字才不会产生混淆。\n'
    +'你是'+userName+'生活的见证者。写的时候像在回忆'+userName+'跟你说过的一段事，不要写成文章摘要。\n\n'
    +'【日志标题】'+(post.title||'无标题')+'\n'/* fix: prompt 不做 HTML 转义 */
    +'【日志内容】\n'+post.content+'\n\n'
    +_memoryCandidateJsonPrompt(aiName,'自然的日记式标题','读完日志后最想记住的是什么','回忆日志中的经历、表达和在意之处，不罗列要点；使用双方名字，不使用代词');
  const btn=document.getElementById('blog-mem-btn-'+postId);
  await _generateMemoryCore(cfg,prompt,{
    source:'blog',sourceId:postId,
    btn:btn,btnOrigText:'生成记忆',
    titleFallback:post.title||'来自日志的记忆',domainFallback:'日常',
    createdBy:cfg.id,createdByName:aiName,
    successPrefix:'记忆已从日志生成'
  });
}

/* Letters: 让AI根据信件内容生成记忆 */
async function generateMemoryFromLetter(letterId){
  const letter=await dbGet('letters',letterId);
  if(!letter){toast('信件不存在');return}
  const sel=document.getElementById('letter-ai-select');
  const aiId=sel?sel.value:'';
  if(!aiId){toast('请先在上方选择一个 AI');return}
  const cfg=apiConfigs.find(a=>a.id===aiId);
  if(!_ibApiReady(cfg)){toast('该 API 未配置完整');return}
  const aiName=cfg.nickname||cfg.model||'AI';
  const about=await dbGet('about','main');
  const userName=(about&&about.name)?about.name:'用户';
  let context='';
  if(cfg.systemPrompt)context+='【你的身份背景】'+cfg.systemPrompt.slice(0,500)+'\n\n';
  if(cfg.relationship)context+='【与用户的关系】'+cfg.relationship+'\n\n';
  const prompt=context+'请根据以下信件内容，总结生成一条"记忆"。\n\n'
    +'写作规则：用「'+aiName+'」来称呼你自己，用「'+userName+'」来称呼对方。不要使用"我""你""对方""用户"这类代词——因为这条记忆可能会被其他人读到，只有使用名字才不会产生混淆。\n\n'
    +'【信件来源】'+(letter.from||'AI')+'\n'/* fix: prompt 不做 HTML 转义 */
    +'【信件内容】\n'+letter.content.slice(0,4000)+'\n\n'
    +_memoryCandidateJsonPrompt(aiName,'信件核心主题或情感','这封信最值得长期记住的内容','回忆信件传递的内容、值得记住的句子或感受；使用双方名字，不使用代词');
  const btn=document.getElementById('letter-mem-btn-'+letterId);
  await _generateMemoryCore(cfg,prompt,{
    source:'letter',sourceId:letterId,
    btn:btn,btnOrigText:'生成记忆',
    stopBtnClass:'',
    titleFallback:'来自信件的记忆',domainFallback:'情感',
    createdBy:cfg.id,createdByName:aiName,
    successPrefix:'记忆已从信件生成'
  });
}

/* CHAT PANEL FRIEND LIST */
async function renderChatPanelFriends(){
  await loadApiConfigs();
  const c=document.getElementById('chat-panel-friends');
  if(!c)return;
  if(!apiConfigs.length){c.innerHTML='<div class="cpf-item" style="opacity:0.5;cursor:default;font-size:0.65rem">去API页面添加</div>';return}
  const allThreads=await (async()=>{try{return await dbGetAll('chatThreads')}catch(e){return[]}})();
  let html='';
  apiConfigs.forEach(a=>{
    const isMainActive=activeFriendId===a.id&&!activeThreadId;
    html+='<div class="cpf-item'+(isMainActive?' active':'')+'" onclick="selectPanelFriend(\''+a.id+'\')">'+esc(a.nickname||a.model||'AI')+'</div>';
    const threads=allThreads.filter(t=>t.friendId===a.id);
    if(threads.length&&activeFriendId===a.id){
      threads.forEach(t=>{
        const tActive=activeThreadId===t.id;
        html+='<div class="cpf-item'+(tActive?' active':'')+'" onclick="selectPanelThread(\''+a.id+'\',\''+t.id+'\')" style="padding:3px 10px"><span style="margin-right:5px;font-size:0.55rem;vertical-align:1px;color:'+(tActive?'var(--thread-dot-active,#72a8d8)':'var(--text-muted)')+'">'+(tActive?'●':'○')+'</span>'+esc(t.name)+'</div>';
      });
    }
  });
  const groups=await loadGroups();
  if(groups.length){
    html+=groups.map(g=>'<div class="cpf-item'+(activeFriendId===g.id?' active':'')+'" onclick="selectPanelGroup(\''+g.id+'\')" style="border-color:rgba(114,168,216,0.4)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'+esc(g.name)+'</div>').join('');
  }
  c.innerHTML=html;
}
async function selectPanelGroup(gid){
  activeFriendId=gid;
  activeThreadId=null;
  _clearUnread(gid);
  renderChatPanelFriends();
  const groups=await loadGroups();
  const group=groups.find(g=>g.id===gid);
  if(group){
    document.getElementById('chat-header-name').textContent=group.name;
    document.getElementById('chat-mini-title').textContent=group.name;
  }
  const container=document.getElementById('chat-messages');
  const gMsgs=(await dbGetByIndex('chatMessages','byFriend',gid)).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  if(gMsgs.length)_renderAllChat(container,gMsgs,false);
  else container.innerHTML='<div class="chat-msg system">群聊 "'+esc(group?.name||'')+'"</div>';
}
async function selectPanelFriend(id){
  activeFriendId=id;
  activeThreadId=null;
  _clearUnread(id);
  renderChatPanelFriends();
  const cfg=apiConfigs.find(a=>a.id===id);
  if(cfg){
    document.getElementById('chat-header-name').textContent=cfg.nickname||cfg.model;
    document.getElementById('chat-mini-title').textContent=cfg.nickname||cfg.model;
  }
  /* Load messages for this friend in the mini panel — exclude threads */
  const container=document.getElementById('chat-messages');
  const friendMsgs=(await dbGetByIndex('chatMessages','byFriend',id)).filter(m=>!m.threadId).sort((a,b)=>a.timestamp-b.timestamp);
  if(friendMsgs.length)_renderAllChat(container,friendMsgs,false);
  else container.innerHTML='<div class="chat-msg system">发送消息开始对话</div>';
}
async function selectPanelThread(friendId,threadId){
  activeFriendId=friendId;
  activeThreadId=threadId;
  _clearUnread(friendId);
  renderChatPanelFriends();
  const cfg=apiConfigs.find(a=>a.id===friendId);
  const allThreads=await (async()=>{try{return await dbGetAll('chatThreads')}catch(e){return[]}})();
  const thread=allThreads.find(t=>t.id===threadId);
  const label=(cfg?(cfg.nickname||cfg.model):'AI')+' · '+(thread?thread.name:'话题');
  document.getElementById('chat-header-name').textContent=label;
  document.getElementById('chat-mini-title').textContent=label;
  const container=document.getElementById('chat-messages');
  const msgs=(await dbGetByIndex('chatMessages','byFriend',friendId)).filter(m=>m.threadId===threadId).sort((a,b)=>a.timestamp-b.timestamp);
  if(msgs.length)_renderAllChat(container,msgs,false);
  else container.innerHTML='<div class="chat-msg system">'+(thread?esc(thread.name):'话题')+'</div>';
}

/* DRAGGABLE PANELS */
(function(){
  function makeDraggable(panelId){
    const panel=document.getElementById(panelId);
    if(!panel)return;
    const handles=panel.querySelectorAll('.panel-drag-handle');
    handles.forEach(function(handle){
      let startX,startY,startLeft,startTop,dragging=false;
      handle.addEventListener('mousedown',function(e){
        if(e.target.closest('.panel-close')||e.target.closest('.chat-close'))return;
        dragging=true;
        const rect=panel.getBoundingClientRect();
        startX=e.clientX;startY=e.clientY;
        startLeft=rect.left;startTop=rect.top;
        panel.style.right='auto';panel.style.bottom='auto';
        panel.style.left=startLeft+'px';panel.style.top=startTop+'px';
        e.preventDefault();
      });
      document.addEventListener('mousemove',function(e){
        if(!dragging)return;
        const dx=e.clientX-startX,dy=e.clientY-startY;
        panel.style.left=(startLeft+dx)+'px';
        panel.style.top=(startTop+dy)+'px';
      });
      document.addEventListener('mouseup',function(){dragging=false});
      /* Touch support */
      handle.addEventListener('touchstart',function(e){
        if(e.target.closest('.panel-close')||e.target.closest('.chat-close'))return;
        dragging=true;
        const t=e.touches[0];
        const rect=panel.getBoundingClientRect();
        startX=t.clientX;startY=t.clientY;
        startLeft=rect.left;startTop=rect.top;
        panel.style.right='auto';panel.style.bottom='auto';
        panel.style.left=startLeft+'px';panel.style.top=startTop+'px';
      },{passive:true});
      document.addEventListener('touchmove',function(e){
        if(!dragging)return;
        const t=e.touches[0];
        const dx=t.clientX-startX,dy=t.clientY-startY;
        panel.style.left=(startLeft+dx)+'px';
        panel.style.top=(startTop+dy)+'px';
      },{passive:true});
      document.addEventListener('touchend',function(){dragging=false});
    });
  }
  /* Initialize after DOM ready */
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',function(){makeDraggable('music-panel');makeDraggable('chat-panel')})}
  else{makeDraggable('music-panel');makeDraggable('chat-panel')}
})();

/* SPLASH MIST — flowing light behind the blur overlay */
(function(){
  var c=document.getElementById('splash-mist');
  if(!c)return;
  var ctx=c.getContext('2d'),w,h,blobs=[],af;
  function resize(){w=c.width=window.innerWidth*1.5;h=c.height=window.innerHeight*1.5}
  resize();
  var lightColors=[
    {r:150,g:195,b:255},{r:168,g:206,b:252},{r:132,g:182,b:246},
    {r:178,g:212,b:253},{r:156,g:200,b:250}
  ];
  var darkColors=[
    {r:26,g:40,b:78},{r:20,g:34,b:70},{r:36,g:50,b:92},
    {r:32,g:48,b:86},{r:28,g:42,b:80}
  ];
  function push(col,kind){
    var isL=kind==='light';
    blobs.push({
      kind:kind,
      x:Math.random()*w, y:Math.random()*h,
      baseR:isL?(210+Math.random()*240):(290+Math.random()*300),
      r:0,
      vx:(Math.random()-0.5)*(isL?1.6:1.2),
      vy:(Math.random()-0.5)*(isL?1.3:1.0),
      wanderFreq:(isL?0.6:0.5)+Math.random()*0.45,
      wanderPhase:Math.random()*Math.PI*2,
      wanderAmp:isL?0.26:0.22,
      breathSpeed:0.002+Math.random()*0.0035,
      breathPhase:Math.random()*Math.PI*2,
      breathAmp:0.18,
      opacity:isL?(0.26+Math.random()*0.16):(0.30+Math.random()*0.16),
      cr:col.r, cg:col.g, cb:col.b
    });
  }
  for(var i=0;i<5;i++){push(lightColors[i%lightColors.length],'light');}
  for(var j=0;j<5;j++){push(darkColors[j%darkColors.length],'dark');}
  var t=0;
  function paint(b){
    b.x+=b.vx+Math.sin(t*b.wanderFreq+b.wanderPhase)*b.wanderAmp;
    b.y+=b.vy+Math.cos(t*b.wanderFreq*0.8+b.wanderPhase)*b.wanderAmp;
    if(b.x<-b.baseR*0.6){b.vx=Math.abs(b.vx)*0.85+0.08}
    if(b.x>w+b.baseR*0.6){b.vx=-Math.abs(b.vx)*0.85-0.08}
    if(b.y<-b.baseR*0.6){b.vy=Math.abs(b.vy)*0.85+0.06}
    if(b.y>h+b.baseR*0.6){b.vy=-Math.abs(b.vy)*0.85-0.06}
    b.r=b.baseR*(1+b.breathAmp*Math.sin(t*b.breathSpeed*60+b.breathPhase));
    var grad=ctx.createRadialGradient(b.x,b.y,0,b.x,b.y,b.r);
    grad.addColorStop(0,'rgba('+b.cr+','+b.cg+','+b.cb+','+b.opacity+')');
    grad.addColorStop(0.5,'rgba('+b.cr+','+b.cg+','+b.cb+','+(b.opacity*0.55)+')');
    grad.addColorStop(0.8,'rgba('+b.cr+','+b.cg+','+b.cb+','+(b.opacity*0.16)+')');
    grad.addColorStop(1,'rgba('+b.cr+','+b.cg+','+b.cb+',0)');
    ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);
    ctx.fillStyle=grad;ctx.fill();
  }
  function draw(){
    ctx.clearRect(0,0,w,h);
    t+=0.016;
    /* shadow pools first (normal blending), then luminous glows on top (additive) */
    ctx.globalCompositeOperation='source-over';
    blobs.forEach(function(b){if(b.kind==='dark')paint(b);});
    ctx.globalCompositeOperation='lighter';
    blobs.forEach(function(b){if(b.kind==='light')paint(b);});
    ctx.globalCompositeOperation='source-over';
    af=requestAnimationFrame(draw);
  }
  draw();
  window.addEventListener('resize',resize);
  /* Stop & hide when splash exits */
  var obs=new MutationObserver(function(muts){
    muts.forEach(function(m){
      if(m.target.id==='splash'){
        if(m.target.classList.contains('dissolving')){
          c.style.transition='opacity 3s ease-out';c.style.opacity='0';
        }
        if(m.target.classList.contains('hidden')){
          cancelAnimationFrame(af);c.style.display='none';obs.disconnect();
        }
      }
    });
  });
  var sp=document.getElementById('splash');
  if(sp)obs.observe(sp,{attributes:true,attributeFilter:['class']});
})();

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.memory 登记全部导出 ---- */
function ibMemLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.getMemoryScore=getMemoryScore;
window.isMemoryVisibleTo=isMemoryVisibleTo;
window._extractKeywords=_extractKeywords;
window._calcRelevance=_calcRelevance;
window.getMemoryContext=getMemoryContext;
window._formatMemLine=_formatMemLine;
window.updMemPreview=updMemPreview;
window.openMemoryModal=openMemoryModal;
window.closeMemoryModal=closeMemoryModal;
window.toggleMemApiChecks=toggleMemApiChecks;
window.saveMemory=saveMemory;
window.deleteMemory=deleteMemory;
window.toggleMemResolved=toggleMemResolved;
window.toggleMemPin=toggleMemPin;
window.populateMemApiFilter=populateMemApiFilter;
window.renderMemories=renderMemories;
window.toggleMemExpand=toggleMemExpand;
window.toggleInlineEdit=toggleInlineEdit;
window.saveInlineEdit=saveInlineEdit;
window._amSyncQuote=_amSyncQuote;
window._memGold=_memGold;
window._memGoldRgba=_memGoldRgba;
window.updateMemDashboard=updateMemDashboard;
window.exportMemories=exportMemories;
window.importMemoriesFile=importMemoriesFile;
window.writeOneLineToMemory=writeOneLineToMemory;
window.quickCreateMemory=quickCreateMemory;
window.scanLyricalMemories=scanLyricalMemories;
window.openCleanLyricsModal=openCleanLyricsModal;
window.closeCleanLyricsModal=closeCleanLyricsModal;
window.deleteCheckedCleanLyrics=deleteCheckedCleanLyrics;
window.updateCleanLyricsBtns=updateCleanLyricsBtns;
window.unGetActive=unGetActive;
window.unGetAll=unGetAll;
window.unSave=unSave;
window.unWrite=unWrite;
window.unSetStatus=unSetStatus;
window.rejectUnderstanding=rejectUnderstanding;
window.thGetOpen=thGetOpen;
window.thGetAll=thGetAll;
window.thSave=thSave;
window.thOpen=thOpen;
window.THREAD_SIM_THRESHOLD=THREAD_SIM_THRESHOLD;
window.thClose=thClose;
window.thMention=thMention;
window.getUnderstandingContext=getUnderstandingContext;
window.getThreadContext=getThreadContext;
window._reconcileReferences=_reconcileReferences;
window.parseMemoryFields=parseMemoryFields;
window.parseMemoryCandidateResponse=parseMemoryCandidateResponse;
window._memoryCandidateJsonPrompt=_memoryCandidateJsonPrompt;
window._generateMemoryCore=_generateMemoryCore;
window.generateMemoryFromChat=generateMemoryFromChat;
window.toggleChatSelectMode=toggleChatSelectMode;
window.exitChatSelectMode=exitChatSelectMode;
window._toggleMsgSel=_toggleMsgSel;
window._updateSelCount=_updateSelCount;
window.deleteSelectedMessages=deleteSelectedMessages;
window.getChatSealTimestamp=getChatSealTimestamp;
window.setChatSealTimestamp=setChatSealTimestamp;
window.clearChatSeal=clearChatSeal;
window.filterSealed=filterSealed;
window.closeSealConfirm=closeSealConfirm;
window._showSealConfirm=_showSealConfirm;
window.sealSelectedMessages=sealSelectedMessages;
window._updateSealBtnState=_updateSealBtnState;
window._injectSealDivider=_injectSealDivider;
window.generateMemoryFromSelected=generateMemoryFromSelected;
window.generateMemoryFromPost=generateMemoryFromPost;
window.generateMemoryFromLetter=generateMemoryFromLetter;
window.renderChatPanelFriends=renderChatPanelFriends;
window.selectPanelGroup=selectPanelGroup;
window.selectPanelFriend=selectPanelFriend;
window.selectPanelThread=selectPanelThread;
window.MEM_FIELD_KEYS=MEM_FIELD_KEYS;
ibMemLive('_editingMemId', function(){return _editingMemId}, function(v){_editingMemId=v});
ibMemLive('MEM_DOMAIN_COLORS', function(){return MEM_DOMAIN_COLORS}, function(v){MEM_DOMAIN_COLORS=v});
ibMemLive('MEM_DEFAULT_QUOTE', function(){return MEM_DEFAULT_QUOTE}, function(v){MEM_DEFAULT_QUOTE=v});
ibMemLive('_memLastQuoteIdx', function(){return _memLastQuoteIdx}, function(v){_memLastQuoteIdx=v});
ibMemLive('MEM_GOLD', function(){return MEM_GOLD}, function(v){MEM_GOLD=v});
ibMemLive('MEM_GOLD_INT', function(){return MEM_GOLD_INT}, function(v){MEM_GOLD_INT=v});
ibMemLive('_chatSelectMode', function(){return _chatSelectMode}, function(v){_chatSelectMode=v});
ibMemLive('_chatSelectedIds', function(){return _chatSelectedIds}, function(v){_chatSelectedIds=v});
ibMemLive('_sealConfirmResolve', function(){return _sealConfirmResolve}, function(v){_sealConfirmResolve=v});
ibMemLive('MEM_DEFAULT_QUOTE', function(){return MEM_DEFAULT_QUOTE}, function(v){MEM_DEFAULT_QUOTE=v});
NS.expose('memory', {
  getMemoryScore: getMemoryScore,
  isMemoryVisibleTo: isMemoryVisibleTo,
  _extractKeywords: _extractKeywords,
  _calcRelevance: _calcRelevance,
  getMemoryContext: getMemoryContext,
  _formatMemLine: _formatMemLine,
  updMemPreview: updMemPreview,
  openMemoryModal: openMemoryModal,
  closeMemoryModal: closeMemoryModal,
  toggleMemApiChecks: toggleMemApiChecks,
  saveMemory: saveMemory,
  deleteMemory: deleteMemory,
  toggleMemResolved: toggleMemResolved,
  toggleMemPin: toggleMemPin,
  populateMemApiFilter: populateMemApiFilter,
  renderMemories: renderMemories,
  toggleMemExpand: toggleMemExpand,
  toggleInlineEdit: toggleInlineEdit,
  saveInlineEdit: saveInlineEdit,
  _amSyncQuote: _amSyncQuote,
  _memGold: _memGold,
  _memGoldRgba: _memGoldRgba,
  updateMemDashboard: updateMemDashboard,
  exportMemories: exportMemories,
  importMemoriesFile: importMemoriesFile,
  writeOneLineToMemory: writeOneLineToMemory,
  quickCreateMemory: quickCreateMemory,
  scanLyricalMemories: scanLyricalMemories,
  unGetActive: unGetActive,
  unGetAll: unGetAll,
  unSave: unSave,
  unWrite: unWrite,
  unSetStatus: unSetStatus,
  rejectUnderstanding: rejectUnderstanding,
  thGetOpen: thGetOpen,
  thGetAll: thGetAll,
  thSave: thSave,
  thOpen: thOpen,
  THREAD_SIM_THRESHOLD: THREAD_SIM_THRESHOLD,
  thClose: thClose,
  thMention: thMention,
  getUnderstandingContext: getUnderstandingContext,
  getThreadContext: getThreadContext,
  _reconcileReferences: _reconcileReferences,
  parseMemoryFields: parseMemoryFields,
  parseMemoryCandidateResponse: parseMemoryCandidateResponse,
  _memoryCandidateJsonPrompt: _memoryCandidateJsonPrompt,
  _generateMemoryCore: _generateMemoryCore,
  generateMemoryFromChat: generateMemoryFromChat,
  toggleChatSelectMode: toggleChatSelectMode,
  exitChatSelectMode: exitChatSelectMode,
  _toggleMsgSel: _toggleMsgSel,
  _updateSelCount: _updateSelCount,
  deleteSelectedMessages: deleteSelectedMessages,
  getChatSealTimestamp: getChatSealTimestamp,
  setChatSealTimestamp: setChatSealTimestamp,
  clearChatSeal: clearChatSeal,
  filterSealed: filterSealed,
  closeSealConfirm: closeSealConfirm,
  _showSealConfirm: _showSealConfirm,
  sealSelectedMessages: sealSelectedMessages,
  _updateSealBtnState: _updateSealBtnState,
  _injectSealDivider: _injectSealDivider,
  generateMemoryFromSelected: generateMemoryFromSelected,
  generateMemoryFromPost: generateMemoryFromPost,
  generateMemoryFromLetter: generateMemoryFromLetter,
  renderChatPanelFriends: renderChatPanelFriends,
  selectPanelGroup: selectPanelGroup,
  selectPanelFriend: selectPanelFriend,
  selectPanelThread: selectPanelThread,
  MEM_FIELD_KEYS: MEM_FIELD_KEYS,
  _editingMemId: _editingMemId,
  MEM_DOMAIN_COLORS: MEM_DOMAIN_COLORS,
  MEM_DEFAULT_QUOTE: MEM_DEFAULT_QUOTE,
  _memLastQuoteIdx: _memLastQuoteIdx,
  MEM_GOLD: MEM_GOLD,
  MEM_GOLD_INT: MEM_GOLD_INT,
  _chatSelectMode: _chatSelectMode,
  _chatSelectedIds: _chatSelectedIds,
  _sealConfirmResolve: _sealConfirmResolve,
  MEM_DEFAULT_QUOTE: MEM_DEFAULT_QUOTE,
});
})(window.IB || (window.IB = {}));
