/* InternetBeyond · AI 社交网络（Social Net）视图层
   不重写 moments.js：在其导出之上增加薄 API 与视图。
   复用：getMoments/getRoleMoments/getMoment/likeMoment/addMomentComment/deleteMoment/
   createMoment/deleteMomentComment、_momentsScanDesc/_momentsCfg/_momentIsUserAuthor/
   _momentsAuthorRoleId/_momentsUserDisplayName/_momentsUserAvatarSrc/_momentsRoleName、
   _momentsRenderComposeIdentity、esc、toast、dbGet、_activeUserId、_cachedUserName 等。
   全部新状态在 localStorage（关注关系）与统一内存态中；window/IB 双挂载。 */
(function(NS){
'use strict';

/* ══════════ 状态 ══════════ */
const NET_FOLLOW_KEY='ib_social_follows_v1';
let _netView='feed';                 /* feed | friends | profile */
let _netRoleId='';                   /* 当前主页角色 id；'' 或 'user' = 用户本人 */
let _netPtab='posts';                /* posts | replies | media */
let _netQuery='';
let _netFriendsFilter='all';         /* all | only */
let _netThreadId='';
let _netReplyTargetId='';
let _netReplyTargetName='';
let _netRepostId='';
let _netUserCache=null;
let _netPtabSeq=0;     /* Profile 页签渲染代际（丢弃过期渲染，防竞态串页签） */
let _netFeedSeq=0;     /* Feed 渲染代际（搜索/刷新穿插时丢弃过期结果） */
const _netOrigCache={};              /* repost 原动态缓存（有界：按需填充） */

function _netFollows(){try{const v=JSON.parse(localStorage.getItem(NET_FOLLOW_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}}
function _netSetFollow(id,on){try{const m=_netFollows();if(on)m[String(id)]=1;else delete m[String(id)];localStorage.setItem(NET_FOLLOW_KEY,JSON.stringify(m))}catch(e){}}
function _netFollowing(id){return !!_netFollows()[String(id)]}

/* ══════════ 身份解析（全部带 fallback） ══════════ */
function _netSlug(t){
  const s=String(t||'').toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g,'_').replace(/^_+|_+$/g,'').slice(0,32);
  return s||'';
}
function _netHandleOf(cfg){
  const s=String((cfg&&cfg.handle)||'').trim();
  if(s)return '@'+s;
  const n=_netSlug((cfg&&(cfg.nickname||cfg.model))||'');
  if(n)return '@'+n;
  return '@'+(cfg&&cfg.id?cfg.id:'ai');
}
function _netCfg(id){
  return (apiConfigs||[]).find(a=>a.id===String(id))||((typeof archivedConfigs!=='undefined'&&archivedConfigs)||[]).find(a=>a.id===String(id))||null;
}
async function _netUserView(force){
  if(_netUserCache&&!force)return _netUserCache;
  let about=null;
  try{about=await dbGet('about','main')}catch(e){}
  const name=(about&&about.name&&String(about.name).trim())||(typeof _cachedUserName==='string'&&String(_cachedUserName).trim())||'本人';
  const v={
    sub:'user',id:'',name:name,
    handle:'@'+(_netSlug(name)||'me'),
    avatar:(about&&about.avatar)||(typeof _cachedUserAvatar==='string'?_cachedUserAvatar:'')||'',
    banner:(about&&about.bgImage)||'',
    bio:(about&&about.bio)||'',
    signature:(about&&about.customText)||'',
    joined:(about&&(about.createdAt||0))||0,
    cfg:about||null
  };
  _netUserCache=v;
  return v;
}
function _netRoleView(cfg){
  cfg=cfg||{};
  return {
    sub:'role',id:String(cfg.id||''),
    name:cfg.nickname||cfg.model||'AI',
    handle:_netHandleOf(cfg),
    avatar:cfg.avatar||cfg.avatarUrl||(cfg.character&&(cfg.character.avatar||cfg.character.avatarUrl||cfg.character.image))||'',
    banner:cfg.banner||'',
    bio:cfg.bio||'',
    signature:cfg.signature||'',
    joined:Number(cfg.joinedAt||cfg.created||0),
    cfg:cfg
  };
}
async function _netAuthorOf(m){
  if(_momentIsUserAuthor(m))return _netUserView();
  const rid=_momentsAuthorRoleId(m);
  const c=_netCfg(rid);
  return _netRoleView(c||{id:rid,nickname:'（角色已删除）'});
}
/* 同步快速身份（搜索过滤用）：不访问 IndexedDB */
function _netAuthorQuick(m){
  if(_momentIsUserAuthor(m)){
    const n=_momentsUserDisplayName();
    return{name:n,handle:'@'+(_netSlug(n)||'me')};
  }
  const c=_netCfg(_momentsAuthorRoleId(m));
  return{name:c?(c.nickname||c.model||'AI'):'（角色已删除）',handle:_netHandleOf(c||{id:_momentsAuthorRoleId(m)})};
}
function _netCommentName(c){
  if(c.authorType==='role'){const cg=_netCfg(c.authorId);return cg?(cg.nickname||cg.model||'AI'):'（角色已删除）'}
  return '我';
}
function _netJoinedLabel(ts){
  if(!Number(ts))return'Joined —';
  try{return'Joined '+new Date(Number(ts)).toLocaleDateString('en-US',{year:'numeric',month:'long'})}catch(e){return'Joined —'}
}
function _netRelTime(iso){
  const t=Date.parse(iso);
  if(!isFinite(t))return'';
  const d=(Date.now()-t)/1000;
  if(d<60)return'刚刚';
  if(d<3600)return Math.floor(d/60)+' 分钟前';
  if(d<86400)return Math.floor(d/3600)+' 小时前';
  if(d<86400*7)return Math.floor(d/86400)+' 天前';
  const dt=new Date(t),now=new Date();
  if(dt.getFullYear()===now.getFullYear())return dt.getMonth()+1+' 月 '+dt.getDate()+' 日';
  return dt.getFullYear()+' 年 '+(dt.getMonth()+1)+' 月';
}

/* ══════════ 通用 DOM 构建 ══════════ */
function _netEl(tag,cls,text){
  const el=document.createElement(tag);
  if(cls)el.className=cls;
  if(text!=null)el.textContent=text;
  return el;
}
function _netAvatarEl(view,opts){
  opts=opts||{};
  const d=_netEl('div','net-avatar'+(opts.className?(' '+opts.className):''));
  if(view.avatar){
    const img=document.createElement('img');
    img.src=view.avatar;img.alt='';img.loading='lazy';img.decoding='async';
    img.onerror=function(){d.textContent=String(view.name||'?').charAt(0).toUpperCase()};
    d.appendChild(img);
  }else d.textContent=String(view.name||'?').charAt(0).toUpperCase();
  if(opts.onClick)d.addEventListener('click',opts.onClick);
  return d;
}
function _netNameBtn(view,opts){
  opts=opts||{};
  const b=_netEl('button',opts.cls||'net-card-name',view.name);
  b.type='button';
  b.addEventListener('click',opts.onClick||function(){_netOpenProfile(view.sub==='user'?'user':view.id)});
  return b;
}
function _netFollowBtn(view){
  const on=_netFollowing(view.id);
  const b=_netEl('button','net-follow-btn'+(on?' is-following':''),on?'已关注':'+ 关注');
  b.type='button';
  b.addEventListener('click',function(ev){
    ev.stopPropagation();
    const now=!_netFollowing(view.id);
    _netSetFollow(view.id,now);
    b.textContent=now?'已关注':'+ 关注';
    b.classList.toggle('is-following',now);
    _netApplyFollowUI(view.id,now);
  });
  return b;
}

/* ══════════ 动态卡片 ══════════ */
async function _netCardFor(m){
  const author=await _netAuthorOf(m);
  const card=_netEl('article','net-card');
  card.dataset.id=m.id;

  const head=_netEl('div','net-card-head');
  head.appendChild(_netAvatarEl(author,{onClick:function(){_netOpenProfile(author.sub==='user'?'user':author.id)}}));
  const ident=_netEl('div','net-card-ident');
  const nameRow=_netEl('div','net-card-name-row');
  nameRow.appendChild(_netNameBtn(author));
  ident.appendChild(nameRow);
  ident.appendChild(_netEl('div','net-card-handle',author.handle));
  head.appendChild(ident);
  head.appendChild(_netEl('div','net-card-time',_netRelTime(m.createdAt)));
  if(m.source==='proactive'&&!(_momentIsUserAuthor(m)))head.appendChild(_netEl('span','net-card-tag','自主'));
  card.appendChild(head);

  if(m.content){
    const body=_netEl('div','net-card-body');
    String(m.content).split('\n').forEach(function(ln){if(ln)body.appendChild(_netEl('p','',ln))});
    card.appendChild(body);
  }

  if(m.repostOf)card.appendChild(await _netRepostBlock(m));

  if(m.images&&m.images.length)card.appendChild(_netImagesEl(m.images));

  const actions=_netEl('div','net-actions');
  const liked=!!(m.likes||[]).includes(_activeUserId());
  const likeBtn=_netEl('button','net-action'+(liked?' is-liked':''),(liked?'♥ ':'♡ ')+(m.likes?m.likes.length:0));
  likeBtn.type='button';likeBtn.title='点赞';
  likeBtn.addEventListener('click',async function(){
    const r=await likeMoment(m.id);
    /* 成功路径由服务层 _momentsPatchLikeUI 局部更新本卡片；此处不再全量重渲染 Feed/Profile，
       避免重建整个列表导致"显示更多"展开状态丢失与滚动位置瞬移 */
    if(!r.ok&&r.error)toast(r.error);
  });
  const cmtBtn=_netEl('button','net-action','💬 '+(m.comments?m.comments.length:0));
  cmtBtn.type='button';cmtBtn.title='评论';
  cmtBtn.addEventListener('click',function(){_netOpenThread(m.id)});
  const repostBtn=_netEl('button','net-action','↻ 转发');
  repostBtn.type='button';repostBtn.title='引用 / 转发';
  repostBtn.addEventListener('click',function(){_netOpenRepost(m)});
  actions.append(likeBtn,cmtBtn,repostBtn);
  const delBtn=_netEl('button','net-action net-del','删除');
  delBtn.type='button';
  delBtn.addEventListener('click',async function(){
    if(!confirm('删除这条动态？'))return;
    const r=await deleteMoment(m.id);
    if(r.ok){toast('已删除');if(_netView==='feed')_netRenderFeed();if(_netView==='profile')_netRenderProfile()}
    else if(r.error)toast(r.error);
  });
  actions.appendChild(delBtn);
  card.appendChild(actions);

  if(m.comments&&m.comments.length){
    const box=_netEl('div','net-comments');
    const recent=m.comments.slice(-2);
    recent.forEach(function(c){
      const row=_netEl('div','net-comment-row');
      const who=_netEl('span','net-comment-name',_netCommentName(c));
      const rep=c.replyTo?(' 回复 '+_netCommentName(findComment(m,c.replyTo)||{authorType:'user',authorId:''})):'';
      const txt=_netEl('span','net-comment-text',String(c.content||''));
      row.append(who,document.createTextNode((rep?rep+': ':'：')),txt);
      row.addEventListener('click',function(){_netOpenThread(m.id)});
      box.appendChild(row);
    });
    if(m.comments.length>2){
      const more=_netEl('button','net-thread-link','查看全部 '+m.comments.length+' 条评论');
      more.type='button';
      more.addEventListener('click',function(){_netOpenThread(m.id)});
      box.appendChild(more);
    }
    card.appendChild(box);
  }
  return card;
}
function findComment(m,cid){
  if(!m||!m.comments||!cid)return null;
  for(const c of m.comments){if(String(c.id)===String(cid))return c}
  return null;
}
async function _netRepostBlock(m){
  let orig=null;
  try{orig=_netOrigCache[m.repostOf]||await getMoment(m.repostOf)}catch(e){orig=null}
  if(orig)_netOrigCache[m.repostOf]=orig;
  const box=_netEl('div','net-repost');
  if(!orig){
    box.appendChild(_netEl('div','net-repost-body','（原动态已删除）'));
    return box;
  }
  const qa=_netAuthorQuick(orig);
  const head=_netEl('div','net-repost-head');
  head.appendChild(_netNameBtn({sub:(_momentIsUserAuthor(orig)?'user':((_momentsAuthorRoleId(orig))||'')),name:qa.name,handle:qa.handle},{cls:'net-name-btn',onClick:function(){_netOpenProfile(_momentIsUserAuthor(orig)?'user':_momentsAuthorRoleId(orig))}}));
  head.appendChild(_netEl('span','net-card-time',_netRelTime(orig.createdAt)));
  box.appendChild(head);
  box.appendChild(_netEl('div','net-repost-body',String(orig.content||'')));
  if(orig.images&&orig.images.length){
    const ig=_netImagesEl(orig.images.slice(0,3),'net-repost-imgs');
    ig.addEventListener('click',function(ev){ev.stopPropagation()});
    box.appendChild(ig);
  }
  return box;
}
function _netImagesEl(images,cls){
  const n=images.length;
  const grid=_netEl('div',(cls||'net-images')+' n'+(n===1?'1':(n>=5?'5plus':'23')));
  images.forEach(function(im){
    const w=_netEl('div','net-image');
    const img=document.createElement('img');
    img.src=String(im&&im.dataUrl||'');img.alt='';img.loading='lazy';img.decoding='async';
    img.onerror=function(){w.remove()};
    img.onclick=function(){try{if(typeof _viewImageFull==='function')_viewImageFull(String(im&&im.dataUrl||''))}catch(e){}};
    w.appendChild(img);grid.appendChild(w);
  });
  return grid;
}

/* ══════════ Feed ══════════ */
async function _netRenderFeed(){
  const feed=document.getElementById('mom-feed');
  if(!feed)return;
  const seq=++_netFeedSeq;
  feed.innerHTML='<div class="mom-state">加载中…</div>';
  let list=[];
  try{list=await getMoments(window.MOMENT_FEED_FIRST_SCAN||60)}catch(e){list=[]}/* 首屏只读最近 60 条，游标即停，不扫 360 */
  if(seq!==_netFeedSeq)return;/* 过期渲染（更快的搜索/刷新已接管） */
  const q=_netQuery.trim().toLowerCase();
  if(q){
    list=list.filter(function(m){
      const qa=_netAuthorQuick(m);
      return (String(m.content||'')+' '+(qa.name||'')+' '+(qa.handle||'')).toLowerCase().indexOf(q)>=0;
    });
  }
  const stats=document.getElementById('mom-stats');
  if(stats)stats.textContent=(q?('搜索“'+_netQuery.trim()+'” · '):'')+(list.length)+' 条动态';
  if(!list.length){
    feed.innerHTML='<div class="mom-state">'+(q?'没有匹配的动态。':'社交圈还空着。发一条，或等 TA 们自己发布。')+'</div>';
    return;
  }
  feed.innerHTML='';
  const frag=document.createDocumentFragment();
  for(const m of list){
    const card=await _netCardFor(m);
    frag.appendChild(card);
  }
  feed.appendChild(frag);
  try{
    const tips=document.getElementById('mom-role-tips');
    if(tips){
      const authors=new Set(list.map(function(m){return _netAuthorQuick(m).name}));
      authors.delete('');
      tips.textContent='共 '+authors.size+' 位朋友在分享';
    }
  }catch(e){}
}

/* ══════════ 右侧好友栏 ══════════ */
async function _netRenderRail(){
  const box=document.getElementById('net-friends-list');
  if(!box)return;
  box.innerHTML='';
  const roles=(apiConfigs||[]).slice();
  if(!roles.length){
    box.appendChild(_netEl('div','net-friend-row','还没有角色，去 API 页添加'));
    return;
  }
  roles.forEach(function(cfg){
    const view=_netRoleView(cfg);
    const row=_netEl('div','net-friend-row');
    row.appendChild(_netAvatarEl(view,{onClick:function(){_netOpenProfile(cfg.id)}}));
    const info=_netEl('div','net-friend-info');
    const nameBtn=_netEl('button','net-friend-name',view.name);
    nameBtn.type='button';
    nameBtn.addEventListener('click',function(){_netOpenProfile(cfg.id)});
    info.appendChild(nameBtn);
    info.appendChild(_netEl('div','net-friend-handle',view.handle));
    row.appendChild(info);
    row.appendChild(_netFollowBtn(view));
    box.appendChild(row);
  });
}

/* ══════════ 好友视图 ══════════ */
function _netSetFriendsFilter(mode){
  _netFriendsFilter=mode;
  const a=document.getElementById('net-follow-chip-all');
  const b=document.getElementById('net-follow-chip-only');
  if(a)a.classList.toggle('is-active',mode==='all');
  if(b)b.classList.toggle('is-active',mode==='only');
  _netRenderFriendsGrid();
}
async function _netRenderFriendsGrid(){
  const grid=document.getElementById('net-friends-grid');
  if(!grid)return;
  grid.innerHTML='';
  let roles=(apiConfigs||[]).slice();
  if(_netFriendsFilter==='only')roles=roles.filter(function(c){return _netFollowing(c.id)});
  if(!roles.length){
    grid.appendChild(_netEl('div','net-pf-empty',_netFriendsFilter==='only'?'还没有关注任何角色。':'还没有角色，去 API 页添加。'));
    return;
  }
  roles.forEach(function(cfg){
    const view=_netRoleView(cfg);
    const card=_netEl('div','net-friend-card');
    const head=_netEl('div','net-friend-card-head');
    head.appendChild(_netAvatarEl(view,{onClick:function(){_netOpenProfile(cfg.id)}}));
    const ident=_netEl('div','net-friend-info');
    const nameBtn=_netEl('button','net-friend-name',view.name);
    nameBtn.type='button';
    nameBtn.addEventListener('click',function(){_netOpenProfile(cfg.id)});
    ident.appendChild(nameBtn);
    ident.appendChild(_netEl('div','net-friend-handle',view.handle));
    head.appendChild(ident);
    card.appendChild(head);
    card.appendChild(_netEl('div','net-friend-bio',String(view.bio||cfg.relationship||'（还没有简介）').slice(0,120)));
    const acts=_netEl('div','net-friend-card-actions');
    acts.appendChild(_netFollowBtn(view));
    const go=_netEl('button','btn','进主页');
    go.type='button';
    go.addEventListener('click',function(){_netOpenProfile(cfg.id)});
    acts.appendChild(go);
    card.appendChild(acts);
    grid.appendChild(card);
  });
}

/* ══════════ Profile 主页 ══════════ */
async function _netRenderProfile(){
  const card=document.getElementById('net-profile-card');
  const body=document.getElementById('net-profile-body');
  if(!card||!body)return;
  const isUser=!_netRoleId||_netRoleId==='user';
  const view=isUser?await _netUserView():_netRoleView(_netCfg(_netRoleId)||{id:_netRoleId,nickname:'（角色已删除）'});
  card.innerHTML='';

  const banner=_netEl('div','net-profile-banner'+(view.banner?' has-img':' is-empty'));
  if(view.banner)banner.style.backgroundImage='url("'+view.banner+'")';
  else banner.appendChild(_netEl('div','net-profile-banner-letter',String(view.name||'?').charAt(0).toUpperCase()));
  card.appendChild(banner);

  const head=_netEl('div','net-profile-head');
  head.appendChild(_netAvatarEl(view,{className:'net-profile-avatar'}));
  const ident=_netEl('div','net-profile-ident');
  ident.appendChild(_netEl('div','net-profile-name',view.name));
  ident.appendChild(_netEl('div','net-profile-handle',view.handle));
  if(view.signature)ident.appendChild(_netEl('div','net-profile-signature',view.signature));
  if(view.bio)ident.appendChild(_netEl('div','net-profile-bio',view.bio));
  ident.appendChild(_netEl('div','net-profile-joined',_netJoinedLabel(view.joined)));
  head.appendChild(ident);
  if(!isUser){
    const fw=_netEl('div','net-profile-follow');
    fw.appendChild(_netFollowBtn(view));
    head.appendChild(fw);
  }
  card.appendChild(head);

  /* 发布区：用户本人 → 发布框；AI 角色 → 「让 TA 发一条」 */
  const pub=_netEl('div','net-profile-note');
  if(isUser){
    const pbox=_netEl('div','net-pf-compose');
    const ta=document.createElement('textarea');
    ta.id='net-pf-text';ta.className='net-compose-text';ta.placeholder='说点什么…（发布到社交圈）';ta.maxLength=2000;
    const row=_netEl('div','net-compose-row');
    const sel=document.createElement('select');
    sel.id='net-pf-vis';sel.className='net-compose-select';
    const o1=document.createElement('option');o1.value='all';o1.textContent='所有人可见';
    const o2=document.createElement('option');o2.value='private';o2.textContent='仅自己可见';
    sel.append(o1,o2);
    const btn=_netEl('button','btn btn-primary','＋ 发布');
    btn.type='button';
    btn.addEventListener('click',_netProfilePublish);
    row.append(sel,btn);
    pbox.append(ta,row);
    pub.appendChild(pbox);
  }else{
    pub.appendChild(_netEl('div','net-profile-note-text','TA 在自主发布与互动，你也可以请 TA 此刻分享一条：'));
    const gb=_netEl('button','btn','让 TA 发一条');
    gb.type='button';
    gb.addEventListener('click',function(){_momentsAskGenerate(view.id)});
    pub.appendChild(gb);
  }
  card.appendChild(pub);

  _netProfileTab(_netPtab);
}
async function _netProfilePublish(){
  const ta=document.getElementById('net-pf-text');
  const vis=document.getElementById('net-pf-vis');
  const text=ta?(ta.value||'').trim():'';
  if(!text){toast('写点什么再发布');return}
  const r=await createMoment({authorType:'user',authorId:_activeUserId(),content:text,source:'manual',visibility:vis?(vis.value==='private'?'private':'all'):'all'});
  if(r.ok){if(ta)ta.value='';toast('已发布');_netRenderProfile()}
  else toast(r.error||'发布失败');
}
async function _netProfileTab(tab){
  _netPtab=tab;
  const seq=++_netPtabSeq;
  document.querySelectorAll('.net-ptab').forEach(function(b){b.classList.toggle('is-active',b.getAttribute('data-ptab')===tab)});
  const body=document.getElementById('net-profile-body');
  if(!body)return;
  const isUser=!_netRoleId||_netRoleId==='user';
  body.innerHTML='<div class="mom-state">加载中…</div>';
  let list=[];
  try{
    if(isUser){
      const all=await getMoments();
      if(seq!==_netPtabSeq)return;/* 过期页签渲染丢弃 */
      list=all.filter(function(m){return _momentIsUserAuthor(m)&&String(m.authorId||'')===String(_activeUserId())});
    }else{
      const own=await getRoleMoments(_netRoleId);
      if(seq!==_netPtabSeq)return;
      list=own.filter(function(m){return _momentsVisibleToUser(m)});
    }
  }catch(e){list=[]}
  if(tab==='media')list=list.filter(function(m){return m.images&&m.images.length});
  if(!list.length){
    body.innerHTML='<div class="net-pf-empty">'+(tab==='media'?'还没有图片动态。':(tab==='replies'?'还没有回复。':'还没有动态。'))+'</div>';
    return;
  }
  if(tab==='replies'){
    /* 回复页签：扫描全量（有界）收集该主体发表过的评论 */
    let scanned=[];
    try{scanned=await _momentsScanDesc(360)}catch(e){scanned=[]}
    if(seq!==_netPtabSeq)return;/* 过期页签渲染丢弃 */
    const rows=[];
    scanned.forEach(function(m){
      if(!(m.comments&&m.comments.length))return;
      m.comments.forEach(function(c){
        const mine=isUser?(c.authorType==='user'&&String(c.authorId||'')===String(_activeUserId())):(c.authorType==='role'&&String(c.authorId||'')===String(_netRoleId));
        if(mine)rows.push({moment:m,comment:c});
      });
    });
    rows.sort(function(a,b){return String(b.comment.createdAt||'').localeCompare(String(a.comment.createdAt||''))});
    if(!rows.length){body.innerHTML='<div class="net-pf-empty">还没有回复。</div>';return}
    const frag=document.createDocumentFragment();
    rows.slice(0,60).forEach(function(r){
      const row=_netEl('div','net-comment-row net-reply-row');
      const qa=_netAuthorQuick(r.moment);
      const who=_netEl('span','net-comment-name',_netCommentName(r.comment));
      const rep=r.comment.replyTo?(' 回复 '+_netCommentName(findComment(r.moment,r.comment.replyTo)||{authorType:'user',authorId:''})):'';
      row.append(who,document.createTextNode((rep?rep+': ':'：')+String(r.comment.content||'')));
      row.appendChild(_netEl('span','net-comment-meta','回复了 '+qa.name+' · '+_netRelTime(r.moment.createdAt)));
      row.addEventListener('click',function(){_netOpenThread(r.moment.id)});
      frag.appendChild(row);
    });
    body.appendChild(frag);
    return;
  }
  body.innerHTML='';
  const frag=document.createDocumentFragment();
  for(const m of list)frag.appendChild(await _netCardFor(m));
  body.appendChild(frag);
}

/* ══════════ 讨论串（Thread） ══════════ */
async function _netOpenThread(id){
  const m=await getMoment(id);
  if(!m){toast('动态不存在');return}
  _netThreadId=id;_netReplyTargetId='';_netReplyTargetName='';
  const ov=document.getElementById('net-thread-overlay');
  if(!ov)return;
  ov.hidden=false;
  _netThreadRender();
  const inp=document.getElementById('net-thread-input');
  if(inp)setTimeout(function(){inp.focus()},60);
}
function _netCloseThread(){
  const ov=document.getElementById('net-thread-overlay');
  if(ov)ov.hidden=true;
  _netThreadId='';_netReplyTargetId='';_netReplyTargetName='';
}
async function _netThreadRender(){
  const post=document.getElementById('net-thread-post');
  const tree=document.getElementById('net-thread-tree');
  const title=document.getElementById('net-thread-title');
  if(!post||!tree)return;
  const m=await getMoment(_netThreadId);
  if(!m){post.innerHTML='';tree.innerHTML='';return}
  if(title)title.textContent='讨论串 · '+(function(){const qa=_netAuthorQuick(m);return qa.name+(_momentIsUserAuthor(m)?'（本人）':'')})();
  post.innerHTML='';
  const author=await _netAuthorOf(m);
  const head=_netEl('div','net-card-head');
  head.appendChild(_netAvatarEl(author,{onClick:function(){_netOpenProfile(author.sub==='user'?'user':author.id)}}));
  const ident=_netEl('div','net-card-ident');
  ident.appendChild(_netNameBtn(author));
  ident.appendChild(_netEl('div','net-card-handle',author.handle));
  head.appendChild(ident);
  head.appendChild(_netEl('div','net-card-time',_netRelTime(m.createdAt)));
  post.appendChild(head);
  if(m.content)post.appendChild(_netEl('div','net-card-body',m.content));
  if(m.images&&m.images.length)post.appendChild(_netImagesEl(m.images));
  if(m.repostOf)post.appendChild(await _netRepostBlock(m));

  tree.innerHTML='';
  const comments=(m.comments||[]).slice().sort(function(a,b){return String(a.createdAt||'').localeCompare(String(b.createdAt||''))});
  const byId={};
  comments.forEach(function(c){byId[c.id]=c});
  const children={};
  comments.forEach(function(c){
    const p=c.replyTo&&byId[c.replyTo]?c.replyTo:null;
    (children[p||'__root']=children[p||'__root']||[]).push(c);
  });
  const frag=document.createDocumentFragment();
  function walk(list,depth){
    list.forEach(function(c){
      frag.appendChild(_netCommentRow(m,c,depth,comments));
      walk(children[c.id]||[],Math.min(3,depth+1));
    });
  }
  walk(children['__root']||[],0);
  if(!comments.length)tree.appendChild(_netEl('div','net-pf-empty','还没有评论。成为第一个回复的人吧。'));
  else tree.appendChild(frag);

  const tgt=document.getElementById('net-thread-target');
  if(tgt)tgt.textContent=_netReplyTargetName?('正在回复 @'+_netReplyTargetName):'';
  const inp=document.getElementById('net-thread-input');
  if(inp)inp.placeholder=_netReplyTargetName?('回复 '+_netReplyTargetName+'…'):'写下你的评论…';
}
function _netCommentRow(m,c,depth,all){
  const row=_netEl('div','net-cmt'+(depth?' depth-'+depth:''));
  const view=c.authorType==='role'
    ?_netRoleView(_netCfg(c.authorId)||{id:c.authorId,nickname:'（角色已删除）'})
    :{sub:'user',id:'',name:'我',handle:'',avatar:''};
  row.appendChild(_netAvatarEl(view,{onClick:view.sub==='role'?function(){_netOpenProfile(view.id)}:function(){_netOpenProfile('user')}}));
  const main=_netEl('div','net-cmt-main');
  const line=_netEl('div','');
  line.appendChild(_netEl('span','net-cmt-name',_netCommentName(c)));
  const rep=c.replyTo?(findComment(m,c.replyTo)||null):null;
  if(rep)line.appendChild(_netEl('span','net-cmt-text','回复 '+_netCommentName(rep)+'：'));
  line.appendChild(_netEl('span','net-cmt-text',String(c.content||'')));
  main.appendChild(line);
  const after=_netEl('div','net-cmt-after');
  after.appendChild(_netEl('span','net-cmt-time',_netRelTime(c.createdAt)));
  const rb=_netEl('button','net-cmt-act','回复');
  rb.type='button';
  rb.addEventListener('click',function(){
    _netReplyTargetId=c.id;
    _netReplyTargetName=_netCommentName(c);
    const tgt=document.getElementById('net-thread-target');
    if(tgt)tgt.textContent='正在回复 @'+_netReplyTargetName;
    const inp=document.getElementById('net-thread-input');
    if(inp){inp.placeholder='回复 '+_netReplyTargetName+'…';inp.focus()}
  });
  after.appendChild(rb);
  if(c.authorType==='user'&&String(c.authorId||'')===String(_activeUserId())){
    const db=_netEl('button','net-cmt-del','删除');
    db.type='button';
    db.addEventListener('click',async function(){
      const r=await deleteMomentComment(m.id,c.id);
      if(r.ok){toast('评论已删除');_netThreadRender();if(_netView==='feed')_netRenderFeed()}
      else if(r.error)toast(r.error);
    });
    after.appendChild(db);
  }
  main.appendChild(after);
  row.appendChild(main);
  return row;
}
async function _netThreadSubmit(){
  const inp=document.getElementById('net-thread-input');
  const text=inp?(inp.value||'').trim():'';
  if(!text)return;
  const r=await addMomentComment(_netThreadId,{authorType:'user',authorId:_activeUserId(),content:text,replyTo:_netReplyTargetId||''});
  if(r.ok){
    if(inp)inp.value='';
    _netReplyTargetId='';_netReplyTargetName='';
    toast('已回复');
    _netThreadRender();
    if(_netView==='feed')_netRenderFeed();
    if(_netView==='profile')_netRenderProfile();
  }else toast(r.error||'回复失败');
}

/* ══════════ 转发 / 引用 ══════════ */
async function _netOpenRepost(m){
  _netRepostId=m.id;
  const ov=document.getElementById('net-repost-overlay');
  const orig=document.getElementById('net-repost-original');
  const txt=document.getElementById('net-repost-text');
  if(!ov||!orig)return;
  orig.innerHTML='';
  const qa=_netAuthorQuick(m);
  orig.appendChild(_netEl('div','net-repost-head',qa.name+' '+qa.handle+' · '+_netRelTime(m.createdAt)));
  orig.appendChild(_netEl('div','net-repost-body',String(m.content||'')));
  if(m.images&&m.images.length)orig.appendChild(_netEl('div','net-repost-body','（附 '+(m.images.length)+' 张图片）'));
  if(txt)txt.value='';
  ov.hidden=false;
}
function _netCloseRepost(){
  const ov=document.getElementById('net-repost-overlay');
  if(ov)ov.hidden=true;
  _netRepostId='';
}
async function _netSubmitRepost(){
  const orig=await getMoment(_netRepostId);
  if(!orig){toast('原动态不存在');return{ok:false,error:'原动态不存在'}}
  const txt=document.getElementById('net-repost-text');
  const text=txt?(txt.value||'').trim():'';
  const r=await createMoment({authorType:'user',authorId:_activeUserId(),content:text,repostOf:orig.id,source:'manual',visibility:'all'});
  if(r.ok){
    _netCloseRepost();
    toast('已转发');
    if(_netView==='feed')_netRenderFeed();
    if(_netView==='profile')_netRenderProfile();
  }else toast(r.error||'转发失败');
  return r;
}

/* ══════════ 视图切换与入口 ══════════ */
async function _netShow(view){
  _netView=view;
  const tabs=document.querySelectorAll('.net-tab');
  tabs.forEach(function(b){b.classList.toggle('is-active',b.getAttribute('data-netview')===view)});
  const feed=document.getElementById('net-view-feed');
  const friends=document.getElementById('net-view-friends');
  const profile=document.getElementById('net-view-profile');
  if(feed)feed.hidden=view!=='feed';
  if(friends)friends.hidden=view!=='friends';
  if(profile)profile.hidden=view!=='profile';
  if(view==='feed'){_netRenderFeed();_netRenderRail()}
  else if(view==='friends'){_netRenderFriendsGrid()}
  else if(view==='profile'){_netRenderProfile()}
}
function _netApplyFollowUI(roleId,on){
  /* 关注状态变化后的局部刷新（好友栏/好友目录/主页按钮由各自渲染器全量重绘） */
  if(_netView==='friends')_netRenderFriendsGrid();
}
async function _netOpenProfile(id){
  _netRoleId=String(id==='user'?'user':(String(id||'')));
  if(_netRoleId==='user')_netRoleId='';
  const label=document.getElementById('net-profile-tab-label');
  if(label){
    if(_netRoleId){const c=_netCfg(_netRoleId);label.textContent=c?(c.nickname||c.model||'主页'):'主页'}
    else label.textContent='主页';
  }
  _netPtab='posts';
  document.querySelectorAll('.net-ptab').forEach(function(b){b.classList.toggle('is-active',b.getAttribute('data-ptab')==='posts')});
  _netShow('profile');
  try{
    const outer=document.getElementById('net-view-profile');
    if(outer)outer.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){}
}
async function _netRefresh(){
  try{
    if(typeof _momentsPullCompanionEvents==='function')await _momentsPullCompanionEvents();
  }catch(e){}
  if(_netView==='feed'){await _netRenderFeed();await _netRenderRail()}
  else if(_netView==='friends')await _netRenderFriendsGrid();
  else if(_netView==='profile')await _netRenderProfile();
  toast('已刷新');
}
function _netSearch(v){
  _netQuery=String(v||'');
  if(_netView==='feed')_netRenderFeed();
}

/* ══════════ 页面装配（包装 loadMomentsPage，保留旧 id 契约） ══════════ */
async function _netInitPage(){
  const page=document.getElementById('page-moments');
  if(!page)return;
  try{if(typeof _momentsRenderComposeIdentity==='function')_momentsRenderComposeIdentity()}catch(e){}
  const pend=window._netPendingRole;
  if(pend){
    window._netPendingRole='';
    _netOpenProfile(pend);
    return;
  }
  _netShow('feed');
}
const _netOrigLoad=typeof window.loadMomentsPage==='function'?window.loadMomentsPage:null;
window.loadMomentsPage=function(opts){
  const pm=document.getElementById('page-moments');
  const active=!!(pm&&pm.classList.contains('active'));
  if(active){
    /* Moments 活动页：只跑旧渲染器的页面级设置（skipFeed，不渲染 feed），
       feed 由 _netInitPage→_netRenderFeed 单独渲染——消灭双渲染/重复 IDB 扫描。
       注意 _netOrigLoad 为同步函数，opts 透传给它而不是传给本包装层自身。 */
    try{if(_netOrigLoad)_netOrigLoad({skipFeed:true})}catch(e){console.warn('[SocialNet] legacy load failed',e)}
    Promise.resolve(_netInitPage()).catch(function(e){console.warn('[SocialNet] init failed',e)});
    return;
  }
  /* 非 Moments 页（后台 ingest / 测试直调等）：保持旧行为完全不变 */
  try{if(_netOrigLoad)_netOrigLoad(opts)}catch(e){console.warn('[SocialNet] legacy load failed',e)}
};
/* API 编辑页「朋友圈」入口 → 直接落到该角色主页 */
const _netOrigOpenRole=typeof window._momentsOpenRole==='function'?window._momentsOpenRole:null;
window._momentsOpenRole=function(roleId){
  window._netPendingRole=roleId||'';
  if(_netOrigOpenRole)_netOrigOpenRole(roleId);
};

/* ══════════ 薄 API（新社交能力，不动 moments.js 既有函数） ══════════ */
async function repostMoment(origId,text){
  const orig=await getMoment(origId);
  if(!orig)return{ok:false,error:'原动态不存在'};
  return createMoment({authorType:'user',authorId:_activeUserId(),content:String(text||'').trim(),repostOf:orig.id,source:'manual',visibility:'all'});
}

/* ══════════ 双挂载 ══════════ */
window._netShow=_netShow;
window._netSearch=_netSearch;
window._netRefresh=_netRefresh;
window._netOpenProfile=_netOpenProfile;
window._netProfileTab=_netProfileTab;
window._netSetFriendsFilter=_netSetFriendsFilter;
window._netOpenThread=_netOpenThread;
window._netCloseThread=_netCloseThread;
window._netThreadSubmit=_netThreadSubmit;
window._netOpenRepost=_netOpenRepost;
window._netCloseRepost=_netCloseRepost;
window._netSubmitRepost=_netSubmitRepost;
window.repostMoment=repostMoment;
window._netRenderFeed=_netRenderFeed;
window._netRelTime=_netRelTime;
window._netHandleOf=_netHandleOf;
window._netInitPage=_netInitPage;

NS.socialnet={
  _netShow:_netShow,_netSearch:_netSearch,_netRefresh:_netRefresh,
  _netOpenProfile:_netOpenProfile,_netProfileTab:_netProfileTab,
  _netSetFriendsFilter:_netSetFriendsFilter,_netOpenThread:_netOpenThread,
  _netCloseThread:_netCloseThread,_netThreadSubmit:_netThreadSubmit,
  _netOpenRepost:_netOpenRepost,_netCloseRepost:_netCloseRepost,
  _netSubmitRepost:_netSubmitRepost,repostMoment:repostMoment,
  _netRenderFeed:_netRenderFeed,_netRelTime:_netRelTime,
  _netHandleOf:_netHandleOf,_netInitPage:_netInitPage
};
})(window.IB || (window.IB = {}));
