/* WORKSPACE FILES —— 项目/文件状态与 CRUD、导入管线、文件列表 UI 与行操作。自 workspace.js 机械提取（四段，只动位置，不改逻辑；加载于 preview.js / run.js / workspace.js 之前）。 */
(function(NS){
var _wsActiveProject=null;/* 当前 AI 操作的项目 ID */
var _wsPendingReads=[];/* 待注入的文件读取结果 */
/* ws_read 单文件注入上限统一由 _ibInjectMax() 提供（默认 100 万字符，DIY 页可调） */
var _wsPendingOpFeedback=[];/* 待回传给 AI 的操作失败/截断信息（闭环反馈，防止 AI 误以为操作成功） */
var _wsViewingProject=null;/* UI 当前浏览的项目 */
var WS_DEFAULT_PROJ_ID='proj_icode_default';/* 默认文件夹：固定 ID、不可删除/重命名，AI 未指定项目时的统一落点 */
var WS_USER_PROJ_ID='proj_icode_user';/* User 文件夹：聊天里发出的上传文件自动归档于此，可像普通文件一样预览/编辑/让 AI 加工 */
/* 默认文件夹的各种叫法：AI 写 <ws_project name="默认"/> / "ICode" / "default" 等都视为默认文件夹本体，
   绝不另建同义项目，也不出"已创建项目"卡（并没有创建任何项目，只是落进默认文件夹） */
var _WS_DEF_NAME_RE=/^(icode|默认|默认文件夹|默认项目|default(\s*folder)?)$/i;
function _wsIsDefaultName(n){return _WS_DEF_NAME_RE.test(String(n||'').trim())}
/* User 文件夹同理：user / 用户 / 上传… 一律指向同一个上传文件夹本体 */
var _WS_USER_NAME_RE=/^(user|users|用户|用户上传|上传|上传文件|uploads?)$/i;
function _wsIsUserName(n){return _WS_USER_NAME_RE.test(String(n||'').trim())}
async function wsEnsureDefaultProject(){
  var p=null;try{p=await dbGet('projects',WS_DEFAULT_PROJ_ID)}catch(e){}
  if(p)return WS_DEFAULT_PROJ_ID;
  await dbPut('projects',{id:WS_DEFAULT_PROJ_ID,name:'ICode',isDefault:true,created:Date.now(),lastModified:Date.now()});
  return WS_DEFAULT_PROJ_ID;
}
async function wsEnsureUserProject(){
  var p=null;try{p=await dbGet('projects',WS_USER_PROJ_ID)}catch(e){}
  if(p){if(p.name==='USER'){p.name='User';try{await dbPut('projects',p)}catch(e){}}return WS_USER_PROJ_ID}
  await dbPut('projects',{id:WS_USER_PROJ_ID,name:'User',isUser:true,created:Date.now(),lastModified:Date.now()});
  return WS_USER_PROJ_ID;
}
/* ── 上传文件自动归档：聊天里发送的文件在进入聊天记录的同时，一份存进「User」文件夹 ──
   同名且内容完全相同 → 跳过（重复发送不制造副本）；同名但内容不同 → 按「名 (2).ext」另存，
   绝不覆盖旧版本（与 ws_create 的重名保护同一套哲学）。作者记为「你」，享受归档覆盖保护。 */
async function _wsArchiveUserUploads(files){
  if(!files||!files.length)return;
  var pid=await wsEnsureUserProject();
  for(var i=0;i<files.length;i++){
    var f=files[i];if(!f||!f.name)continue;
    if(f._fromWs)continue;/* 从 ICode 拖来的附件本就在工作区里，不再往 User 夹归档副本 */
    var text=f.raw!=null?String(f.raw):(f.text!=null?String(f.text):'');/* 富文件归档原始 base64，文本文件归档原文 */
    try{
      var old=await wsGetFileByPath(pid,f.name);
      if(old&&old.content===text)continue;
      var dest=old?await _wsUniquePath(pid,f.name):f.name;
      await wsSaveFile(pid,dest,text,'User');
    }catch(e){}
  }
  /* ICode 悬浮窗开着时当场刷新，让归档立刻可见 */
  try{
    var _upWin=document.getElementById('ws-overlay');
    if(_upWin&&_upWin.style.display!=='none'&&_upWin.style.display!==''){
      if(_wsViewingProject)renderWsFiles(_wsViewingProject);else renderWsProjects();
    }
    _wsUpdateStorage();
  }catch(e){}
}

/* ── SVG Icons ── */
var WS_ICON={
  folder:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a2 2 0 0 1 2-2h3.17a2 2 0 0 1 1.41.59l1.42 1.41h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5z"/></svg>',
  file:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6l-4-4z"/><path d="M12 2v4h4"/></svg>',
  create:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  edit:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8H3v-3l8-8z"/></svg>',
  read:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M13 13l-3-3"/></svg>',
  run:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5v9l7.2-4.5L5 3.5z"/></svg>',
  image:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="6" cy="6" r="1.2"/><path d="M13.5 10.5l-3-3-5 5"/></svg>',
  proj:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1.5 1.5 0 0 1 1.5-1.5h2.38a1.5 1.5 0 0 1 1.06.44l1.12 1.12h4.44A1.5 1.5 0 0 1 14 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5V4z"/></svg>',
  warn:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2 14.6 13.4H1.4L8 2.2z"/><path d="M8 6.6v3.2"/><path d="M8 11.9h.01"/></svg>',
  tool:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.8 3.6 8.6h3.2L6 14.2 12.4 7H8.8L9 1.8z"/></svg>',
  search:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.2"/><path d="M13.5 13.5 10 10"/><path d="M4.8 7a2.2 2.2 0 0 1 2.2-2.2"/></svg>',
  mem:'<svg class="ws-op-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h8v11l-4-2.6-4 2.6v-11z"/></svg>',
  rename:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5-8 8H3v-2.5l8-8z"/><path d="M9.5 4l2.5 2.5"/></svg>',
  organize:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3a1.5 1.5 0 0 1 1.06.44l.7.7a1.5 1.5 0 0 0 1.06.44h3.88A1.5 1.5 0 0 1 14 6.08v6.42a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8z"/><path d="M5.6 9.8h4.4"/><path d="m8.4 8 1.8 1.8-1.8 1.8"/></svg>',
  trash:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11"/><path d="M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5"/><path d="M4 4.5l.6 8a1 1 0 0 0 1 .95h4.8a1 1 0 0 0 1-.95l.6-8"/></svg>'
};

/* ── DB Helpers ── */
async function wsGetProjects(){try{return await dbGetAll('projects')}catch(e){return[]}}
async function wsGetFiles(projId){try{return(await dbGetAll('projectFiles')).filter(f=>f.projectId===projId)}catch(e){return[]}}
async function wsGetFileByPath(projId,path){var all=await wsGetFiles(projId);return all.find(f=>f.path===path)||null}

async function wsCreateProject(name){
  var id='proj_'+Date.now();
  await dbPut('projects',{id:id,name:name,created:Date.now(),lastModified:Date.now()});
  _wsActiveProject=id;return id;
}
async function wsEnsureProject(name){
  /* 默认文件夹的各种叫法（ICode/默认/default…）一律落到默认文件夹本体，绝不另建同义项目 */
  if(_wsIsDefaultName(name)){var did=await wsEnsureDefaultProject();_wsActiveProject=did;return did}
  /* User/用户/上传… 同理指向上传文件夹本体（AI 借此读取/编辑用户上传的文件） */
  if(_wsIsUserName(name)){var uid=await wsEnsureUserProject();_wsActiveProject=uid;return uid}
  var all=await wsGetProjects();
  var existing=all.find(p=>p.name===name);
  if(existing){_wsActiveProject=existing.id;return existing.id}
  return await wsCreateProject(name);
}
async function wsDeleteProject(id){
  if(id===WS_DEFAULT_PROJ_ID||id===WS_USER_PROJ_ID)return;/* 默认 / User 文件夹不可删除 */
  var files=await wsGetFiles(id);
  for(var f of files){try{await dbDelete('projectFiles',f.id)}catch(e){}}
  await dbDelete('projects',id);
  if(_wsViewingProject===id)_wsViewingProject=null;
  if(_wsActiveProject===id)_wsActiveProject=null;
}
async function wsSaveFile(projId,path,content,author){
  var existing=await wsGetFileByPath(projId,path);
  var now=Date.now();
  if(existing){
    existing.content=content;existing.size=new Blob([content]).size;
    existing.lastModified=now;existing.lastModifiedBy=author||'AI';
    await dbPut('projectFiles',existing);
    /* update project lastModified */
    try{var p=await dbGet('projects',projId);if(p){p.lastModified=now;await dbPut('projects',p)}}catch(e){}
    return existing.id;
  }
  var id='pf_'+now+'_'+Math.random().toString(36).slice(2,6);
  await dbPut('projectFiles',{id:id,projectId:projId,path:path,content:content,size:new Blob([content]).size,created:now,lastModified:now,lastModifiedBy:author||'AI'});
  try{var p=await dbGet('projects',projId);if(p){p.lastModified=now;await dbPut('projects',p)}}catch(e){}
  return id;
}
/* ── 重名保护：为撞名的新文件生成「名 (2).ext」式的唯一路径（扩展名判定避开目录里的点） ── */
async function _wsUniquePath(projId,path){
  var files=await wsGetFiles(projId);
  var names={};files.forEach(function(f){names[f.path]=1});
  if(!names[path])return path;
  var slash=path.lastIndexOf('/');
  var dot=path.lastIndexOf('.');
  if(dot<=slash)dot=-1;/* 目录名里的点不算扩展名分隔符 */
  var stem=dot>0?path.slice(0,dot):path,ext=dot>0?path.slice(dot):'';
  for(var n=2;n<1000;n++){var cand=stem+' ('+n+')'+ext;if(!names[cand])return cand}
  return stem+' ('+Date.now()+')'+ext;
}
function _wsCountOcc(hay,needle){
  if(!needle)return 0;
  var n=0,i=0;
  while((i=hay.indexOf(needle,i))!==-1){n++;i+=needle.length;if(n>9)break}
  return n;
}
async function wsEditFileContent(projId,path,findStr,replaceStr,author){
  var f=await wsGetFileByPath(projId,path);
  if(!f)return{ok:false,reason:'文件不存在: '+path};
  var content=f.content;
  var idx=-1,matchLen=0;
  /* ① 精确匹配 + 唯一性校验（多处命中时拒绝执行，防止改错位置） */
  var exact=content.indexOf(findStr);
  if(exact!==-1){
    var occ=_wsCountOcc(content,findStr);
    if(occ>1)return{ok:false,reason:'匹配到 '+occ+' 处，请提供更长的唯一片段'};
    idx=exact;matchLen=findStr.length;
  }else{
    /* ② 换行符差异兜底（\r\n vs \n） */
    var nFind=findStr.replace(/\r\n/g,'\n');
    if(nFind!==findStr&&content.indexOf(nFind)!==-1){
      var occN=_wsCountOcc(content,nFind);
      if(occN>1)return{ok:false,reason:'匹配到 '+occN+' 处，请提供更长的唯一片段'};
      idx=content.indexOf(nFind);matchLen=nFind.length;
    }else if(findStr.trim()&&findStr.length<=3000){
      /* ③ 空白宽松匹配：容忍缩进/空格数量差异（AI 复述代码时最常见的偏差） */
      try{
        var toks=findStr.trim().split(/\s+/).map(function(t){return t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')});
        var pat=toks.join('[\\s]+');
        if(pat){
          var re=new RegExp(pat,'g');
          var m1=re.exec(content);
          if(m1){
            var m2=re.exec(content);
            if(m2)return{ok:false,reason:'宽松匹配到多处，请提供更长的唯一片段'};
            idx=m1.index;matchLen=m1[0].length;
          }
        }
      }catch(e){}
    }
    if(idx===-1)return{ok:false,reason:'未找到匹配内容（文件可能已更新，请先用 <ws_read path="'+path+'"/> 获取最新原文再重试）'};
  }
  f.content=content.slice(0,idx)+replaceStr+content.slice(idx+matchLen);
  f.size=new Blob([f.content]).size;f.lastModified=Date.now();f.lastModifiedBy=author||'AI';
  await dbPut('projectFiles',f);
  try{var p=await dbGet('projects',projId);if(p){p.lastModified=Date.now();await dbPut('projects',p)}}catch(e){}
  return{ok:true};
}
async function wsDeleteFile(fileId){await dbDelete('projectFiles',fileId)}

/* ── 项目回退解析：AI 忘记 <ws_project>（例如页面刷新后）时，按文件路径反查唯一归属项目 ── */
async function _wsResolveProject(path){
  if(_wsActiveProject)return _wsActiveProject;
  try{
    var all=await dbGetAll('projectFiles');
    var uniq=[...new Set(all.filter(function(f){return f.path===path}).map(function(f){return f.projectId}))];
    if(uniq.length===1){_wsActiveProject=uniq[0];return uniq[0]}
  }catch(e){}
  return null;
}
/* ══════════ ICode 文件夹导入 ══════════
   把整个项目文件夹拖进 ICode 窗口 → 递归收集全部文本文件 → 确认对话框 → 入库为项目。
   导入本身零 token 消耗（纯本地入库）；只有 AI 之后读取文件时才产生调用费用。 */
var ICODE_IMP={MAX_FILES:2000,MAX_TOTAL:500*1024*1024,MAX_FILE:50*1024*1024};/* 导入上限：2000 个 / 500MB / 单文件 50MB */
var _ICODE_SKIP_DIRS={'node_modules':1,'.git':1,'.svn':1,'.hg':1,'dist':1,'build':1,'out':1,'__pycache__':1,'.venv':1,'venv':1,'env':1,'.idea':1,'.vscode':1,'.next':1,'.nuxt':1,'coverage':1,'target':1,'vendor':1,'.cache':1};
var _ICODE_TEXT_EXT=/\.(txt|md|markdown|rst|adoc|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|jsonc|json5|csv|tsv|xml|html?|xhtml|css|scss|sass|less|styl|py|pyi|ipynb|java|kt|kts|scala|groovy|c|h|cpp|hpp|cc|cxx|cs|go|rs|rb|erb|php|swift|m|mm|lua|sql|sh|bash|zsh|fish|bat|cmd|ps1|ya?ml|log|ini|cfg|conf|config|toml|env|properties|lock|gradle|tex|bib|srt|vtt|ass|gd|r|jl|pl|pm|ex|exs|erl|hrl|clj|cljs|edn|hs|elm|dart|proto|graphql|gql|prisma|sol|asm|s|diff|patch|gitignore|gitattributes|editorconfig|dockerfile|dockerignore|npmrc|nvmrc|babelrc|eslintignore|prettierignore)$/i;
var _ICODE_TEXT_NAMES=/^(readme|license|licence|copying|changelog|changes|history|authors|contributors|notice|todo|makefile|gnumakefile|dockerfile|containerfile|procfile|rakefile|gemfile|justfile|cmakelists\.txt|requirements[^\/]*|pipfile|cargo\.toml|go\.(mod|sum)|\.gitignore|\.gitattributes|\.gitmodules|\.editorconfig|\.env[^\/]*|\.eslintrc[^\/]*|\.prettierrc[^\/]*|\.babelrc[^\/]*|\.npmrc|\.nvmrc)$/i;
function _icodeIsText(name){return _ICODE_TEXT_EXT.test(name)||_ICODE_TEXT_NAMES.test(name)}
/* ── 图片附加公共件：R1 / R2 共用的体积预算（单条消息约 8.5MB）── */
function _wsPushChatImage(item,budget){
  if(budget.used+item.size>budget.limit)return false;
  budget.used+=item.size;
  _pendingImages.push(item);
  return true;
}
function _ibRichNum(key,def,min,max){
  var v=0;try{v=parseInt(localStorage.getItem(key)||'',10)||0}catch(e){}
  if(!v)v=def;
  return Math.min(max,Math.max(min,v));
}
function _ibPdfImgPages(){return _ibRichNum('ib_pdfImgPages',20,1,60)}
function _ibDocxImgMax(){return _ibRichNum('ib_docxImgN',10,1,30)}
/* ── R1：PDF 页面 → 图片附件（预览面板「以图片发送」按钮） ── */
function _wsPromptPdfPages(f,total,cap){
  return new Promise(function(resolve){
    var host=document.getElementById('ws-overlay')||document.body;
    var mask=document.createElement('div');mask.className='ws-dialog-mask';
    var d=document.createElement('div');d.className='ws-dialog';
    d.innerHTML='<h4>以图片发送</h4>'
      +'<p>「'+esc(String(f.path||'').split('/').pop())+'」共 <b>'+total+'</b> 页。页面将转为图片挂到输入栏，随下一条消息发送。</p>'
      +'<div style="display:flex;gap:10px;align-items:center;margin:6px 0 2px;font-size:0.85rem">起始页 <input type="number" id="ws-pdfimg-from" class="ib-num" min="1" max="'+total+'" value="1" style="width:64px">　页数 <input type="number" id="ws-pdfimg-cnt" class="ib-num" min="1" max="'+Math.min(cap,total)+'" value="'+Math.min(cap,total)+'" style="width:64px"></div>'
      +'<div class="ws-dialog-note">单次上限 '+cap+' 页（DIY 页「文件解析库」可调）。每页约折合 1000–2000 token；需要支持图像输入的模型才能看到内容。</div>'
      +'<div class="ws-dialog-actions"><button class="ws-file-btn" data-act="cancel">取消</button><button class="ws-file-btn primary" data-act="ok">转换并附加</button></div>';
    mask.appendChild(d);host.appendChild(mask);
    var done=function(v){mask.remove();resolve(v)};
    mask.addEventListener('mousedown',function(e){if(e.target===mask)done(null)});
    d.querySelector('[data-act="cancel"]').onclick=function(){done(null)};
    d.querySelector('[data-act="ok"]').onclick=function(){
      var from=parseInt(d.querySelector('#ws-pdfimg-from').value,10)||1;
      var cnt=parseInt(d.querySelector('#ws-pdfimg-cnt').value,10)||1;
      from=Math.min(total,Math.max(1,from));
      cnt=Math.min(Math.min(cap,total-from+1),Math.max(1,cnt));
      done({from:from,to:from+cnt-1});
    };
  });
}
async function wsPdfPagesToChat(fileId){
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f){toast('文件不存在或已被删除');return}
  var doc;
  try{doc=await _wsPdfEnsureOpen(f,{interactive:true})}
  catch(e){toast((e&&e._wsMsg)||'PDF 解析失败');return}
  if(!doc)return;/* 用户取消了密码输入 */
  var total=doc.numPages,cap=_ibPdfImgPages();
  var sel=await _wsPromptPdfPages(f,total,cap);
  if(!sel){try{doc.destroy()}catch(e){}return}
  toast('正在把第 '+sel.from+'–'+sel.to+' 页转为图片…');
  var name=String(f.path||'PDF').split('/').pop().replace(/\.pdf$/i,'');
  var budget={used:0,limit:Math.round(8.5*1024*1024)},added=0,full=false;
  try{
    for(var n=sel.from;n<=sel.to;n++){
      var page=await doc.getPage(n);
      var vp1=page.getViewport({scale:1});
      var scale=Math.min(1200/vp1.width,2);
      var vp=page.getViewport({scale:scale});
      var canvas=document.createElement('canvas');
      canvas.width=Math.round(vp.width);canvas.height=Math.round(vp.height);
      await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
      var dataUrl=canvas.toDataURL('image/jpeg',0.85);
      var b64=dataUrl.slice(dataUrl.indexOf(',')+1);
      var item={dataUrl:dataUrl,base64:b64,mime:'image/jpeg',name:name+'-p'+n+'.jpg',size:Math.round(b64.length*0.75)};
      if(!_wsPushChatImage(item,budget)){full=true;break}
      added++;
    }
  }catch(e){toast('页面转换中断：'+String(e&&e.message||e).slice(0,60))}
  finally{try{doc.destroy()}catch(e){}}
  if(added){
    renderAttachPreviews();
    toast('已附加「'+name+'」第 '+sel.from+'–'+(sel.from+added-1)+' 页，共 '+added+' 张图片'+(full?'（体积达到单条消息上限，其余未附加）':'')+'。请用支持图像的模型发送');
  }else toast(full?'单页体积过大，超出单条消息上限，未能附加':'未生成任何页面图片');
}
/* ── R2：DOCX 内嵌图片提取（预览面板「提取图片」按钮）──
   内置 ZIP 读取器抽 word/media 下的图片挂到输入栏，张数上限 DIY 可调 */
async function wsDocxImagesToChat(fileId){
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f){toast('文件不存在或已被删除');return}
  var name=String(f.path||'').split('/').pop();
  var bytes;try{bytes=_wsDataUrlToBytes(f.content)}catch(e){toast('文件数据无法解析');return}
  var ents;try{ents=_wsZipList(bytes)}catch(e){toast('无法读取该 DOCX 的内部结构');return}
  var pics=ents.filter(function(en){return /^word\/media\//i.test(en.name)&&/\.(png|jpe?g|gif|webp|bmp)$/i.test(en.name)});
  if(!pics.length){toast('「'+name+'」中没有内嵌图片');return}
  pics.sort(function(a,b){return a.name<b.name?-1:(a.name>b.name?1:0)});
  var cap=_ibDocxImgMax(),budget={used:0,limit:Math.round(8.5*1024*1024)},added=0,full=false;
  var mimeOf=function(nm){var m=nm.toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp)$/);var e2=m?m[1]:'png';return (e2==='jpg'||e2==='jpeg')?'image/jpeg':'image/'+e2};
  for(var i=0;i<pics.length&&added<cap;i++){
    var data;try{data=await _wsZipRead(bytes,pics[i])}catch(e){continue}
    var du=_wsBytesToDataUrl(data,mimeOf(pics[i].name));
    var b64=du.slice(du.indexOf(',')+1);
    var item={dataUrl:du,base64:b64,mime:mimeOf(pics[i].name),name:pics[i].name.split('/').pop(),size:data.length};
    if(!_wsPushChatImage(item,budget)){full=true;break}
    added++;
  }
  if(added){
    renderAttachPreviews();
    var tail=full?'（体积达到单条消息上限）':(pics.length>added?'（达到张数上限，DIY 页可调）':'');
    toast('已附加「'+name+'」内嵌图片 '+added+' 张，共发现 '+pics.length+' 张'+tail+'。请用支持图像的模型发送');
  }else toast(full?'图片体积超出单条消息上限，未能附加':'图片读取失败，未能附加');
}
/* ── 生成器共用：把 AI 引用的图片路径解析为 ICode 里的真实图片数据 ── */
async function _wsResolveIcodeImage(ref){
  ref=String(ref||'').trim();
  if(!ref)return null;
  if(ref.slice(0,11)==='data:image/')return ref;
  var base=ref.split('/').pop();
  try{
    var all=await dbGetAll('projectFiles');
    var isImg=function(f){return f&&typeof f.content==='string'&&f.content.slice(0,11)==='data:image/'};
    var hit=all.find(function(f){return f.projectId===_wsActiveProject&&f.path===ref&&isImg(f)})
      ||all.find(function(f){return f.projectId===_wsActiveProject&&String(f.path).split('/').pop()===base&&isImg(f)})
      ||all.find(function(f){return f.path===ref&&isImg(f)})
      ||all.find(function(f){return String(f.path).split('/').pop()===base&&isImg(f)});
    return hit?hit.content:null;
  }catch(e){return null}
}
/* ── W1：Markdown 子集 → 真实 DOCX（docx 库） ── */
async function _wsBuildDocxFromMd(md){
  await _wsLoadScript(_WS_RICH_CDN.docx,'DOCX 生成');
  var D=window.docx;
  if(!D||!D.Document||!D.Packer)throw new Error('docx 生成库未正确加载');
  function runs(s){
    var out=[],re=/\*\*([^*]+)\*\*/g,last=0,m;
    while((m=re.exec(s))!==null){
      if(m.index>last)out.push(new D.TextRun(s.slice(last,m.index)));
      out.push(new D.TextRun({text:m[1],bold:true}));
      last=re.lastIndex;
    }
    if(last<s.length)out.push(new D.TextRun(s.slice(last)));
    if(!out.length)out.push(new D.TextRun(''));
    return out;
  }
  async function imgPara(src){
    var rs=await _wsResolveIcodeImage(src);
    if(!rs)return new D.Paragraph({children:[new D.TextRun('[图片未找到：'+src+']')]});
    var dim=await new Promise(function(res){
      var im=new Image();
      im.onload=function(){res({w:im.naturalWidth||600,h:im.naturalHeight||400})};
      im.onerror=function(){res(null)};
      im.src=rs;
    });
    if(!dim)return new D.Paragraph({children:[new D.TextRun('[图片无法解码：'+src+']')]});
    var maxW=600,w=dim.w,h=dim.h;
    if(w>maxW){h=Math.round(h*maxW/w);w=maxW}
    return new D.Paragraph({children:[new D.ImageRun({data:_wsDataUrlToBytes(rs),transformation:{width:w,height:h}})]});
  }
  var lines=String(md||'').replace(/\r\n?/g,'\n').split('\n');
  var kids=[],i=0;
  while(i<lines.length){
    var ln=lines[i];
    if(/^\s*$/.test(ln)){i++;continue}
    if(/^\|.*\|\s*$/.test(ln)){/* 表格块：连续管道行；|---| 分隔线跳过 */
      var rows=[];
      while(i<lines.length&&/^\|.*\|\s*$/.test(lines[i])){
        var cells=lines[i].replace(/^\s*\||\|\s*$/g,'').split('|').map(function(c){return c.trim()});
        if(!cells.every(function(c){return /^:?-{3,}:?$/.test(c)}))rows.push(cells);
        i++;
      }
      if(rows.length){
        var trs=rows.map(function(r,ri){
          return new D.TableRow({children:r.map(function(c){
            return new D.TableCell({children:[new D.Paragraph({children:ri===0?[new D.TextRun({text:c,bold:true})]:runs(c)})]});
          })});
        });
        kids.push(new D.Table({rows:trs,width:{size:100,type:D.WidthType.PERCENTAGE}}));
      }
      continue;
    }
    var hm=ln.match(/^(#{1,3})\s+(.*)$/);
    if(hm){kids.push(new D.Paragraph({children:runs(hm[2]),heading:D.HeadingLevel['HEADING_'+hm[1].length]}));i++;continue}
    var im2=ln.match(/^!\[[^\]]*\]\(([^)]+)\)\s*$/);
    if(im2){kids.push(await imgPara(im2[1]));i++;continue}
    var bm=ln.match(/^\s*[-*]\s+(.*)$/);
    if(bm){kids.push(new D.Paragraph({children:runs(bm[1]),bullet:{level:0}}));i++;continue}
    kids.push(new D.Paragraph({children:runs(ln),spacing:{after:120}}));i++;
  }
  if(!kids.length)throw new Error('内容为空');
  var doc=new D.Document({sections:[{properties:{},children:kids}]});
  return await D.Packer.toBlob(doc);
}
/* ── W2B：HTML → 隐藏渲染 → 逐页截图 → 合成 PDF（html2canvas + jsPDF） ── */
async function _wsBuildPdfFromHtml(html){
  await _wsLoadScript(_WS_RICH_CDN.h2c,'页面截图');
  await _wsLoadScript(_WS_RICH_CDN.jspdf,'PDF 生成');
  if(typeof window.html2canvas!=='function'||!window.jspdf||!window.jspdf.jsPDF)throw new Error('PDF 生成库未正确加载');
  var src=String(html||'');
  /* XSS 修复：旧实现只删 <script>，但 innerHTML 落入活动 DOM 时 <img onerror=...>、<iframe> 等仍会执行。
     改为 DOMParser 惰性文档解析（脚本不执行、图片不加载），剥除可执行内容后再进页面。 */
  try{
    var _sd=new DOMParser().parseFromString(src,'text/html');
    _sd.querySelectorAll('script,iframe,object,embed,base,meta,link,form').forEach(function(n){n.remove()});
    _sd.querySelectorAll('*').forEach(function(n){
      for(var _ai=n.attributes.length-1;_ai>=0;_ai--){
        var _at=n.attributes[_ai],_an=_at.name.toLowerCase();
        if(_an.slice(0,2)==='on'||((_an==='href'||_an==='src'||_an==='xlink:href')&&/^\s*(javascript|vbscript)\s*:/i.test(_at.value)))n.removeAttribute(_at.name);
      }
    });
    src=(_sd.head?_sd.head.innerHTML:'')+(_sd.body?_sd.body.innerHTML:'');
  }catch(e){src=src.replace(/<script\b[\s\S]*?<\/script\s*>/gi,'')}
  var host=document.createElement('div');
  host.style.cssText='position:fixed;left:-12000px;top:0;width:794px;background:#ffffff;z-index:-1';
  var inner=document.createElement('div');
  inner.style.cssText='width:794px;box-sizing:border-box;padding:34px 38px;background:#ffffff;color:#111;font:14px/1.7 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;word-break:break-word';
  inner.innerHTML=src;
  host.appendChild(inner);
  document.body.appendChild(host);
  try{
    /* ICode 图片路径 → 真实数据；解析不到且非网络地址的图片移除，避免截图挂起 */
    var imgs=Array.prototype.slice.call(inner.querySelectorAll('img'));
    for(var i=0;i<imgs.length;i++){
      var s=imgs[i].getAttribute('src')||'';
      if(s.slice(0,5)==='data:')continue;
      var rs=await _wsResolveIcodeImage(s);
      if(rs)imgs[i].setAttribute('src',rs);
      else if(!/^https?:/i.test(s))imgs[i].remove();
    }
    imgs=Array.prototype.slice.call(inner.querySelectorAll('img'));
    await Promise.all(imgs.map(function(im){return new Promise(function(res){
      if(im.complete)return res();
      im.onload=res;im.onerror=res;setTimeout(res,8000);
    })}));
    try{if(document.fonts&&document.fonts.ready)await Promise.race([document.fonts.ready,new Promise(function(r){setTimeout(r,2500)})])}catch(e){}
    var contentH=Math.max(inner.scrollHeight,1);
    var estPages=Math.ceil(contentH/1123);
    if(estPages>25)throw new Error('内容过长（约 '+estPages+' 页）：单次生成请控制在 25 页以内，可拆成多个文件');
    var scale=contentH>15000?1:(contentH>7500?1.5:2);/* 超长内容降采样，避免超出浏览器画布面积上限 */
    var canvas=await window.html2canvas(inner,{scale:scale,backgroundColor:'#ffffff',logging:false,useCORS:true});
    var pageWpt=595.28,pageHpt=841.89;
    var pxPerPt=canvas.width/pageWpt;
    var pagePx=Math.max(1,Math.floor(pageHpt*pxPerPt));
    var pdf=new window.jspdf.jsPDF({orientation:'portrait',unit:'pt',format:'a4'});
    var y=0,first=true;
    while(y<canvas.height){
      var h=Math.min(pagePx,canvas.height-y);
      var pc=document.createElement('canvas');
      pc.width=canvas.width;pc.height=h;
      pc.getContext('2d').drawImage(canvas,0,y,canvas.width,h,0,0,canvas.width,h);
      if(!first)pdf.addPage();
      pdf.addImage(pc.toDataURL('image/jpeg',0.92),'JPEG',0,0,pageWpt,h/pxPerPt);
      first=false;y+=h;
    }
    return pdf.output('blob');
  }finally{try{host.remove()}catch(e){}}
}
/* ── W3：CSV 协议 → 真实 XLSX（SheetJS） ── */
function _wsCsvParse(text){
  var rows=[],row=[],cell='',q=false,i=0,s=String(text||'');
  while(i<s.length){
    var ch=s[i];
    if(q){
      if(ch==='"'){if(s[i+1]==='"'){cell+='"';i+=2;continue}q=false;i++;continue}
      cell+=ch;i++;continue;
    }
    if(ch==='"'){q=true;i++;continue}
    if(ch===','){row.push(cell);cell='';i++;continue}
    if(ch==='\n'||ch==='\r'){
      if(ch==='\r'&&s[i+1]==='\n')i++;
      row.push(cell);rows.push(row);row=[];cell='';i++;continue;
    }
    cell+=ch;i++;
  }
  row.push(cell);rows.push(row);
  while(rows.length&&rows[rows.length-1].every(function(c){return c===''}))rows.pop();
  return rows;
}
function _wsAoaToSheet(X,rows){
  var ws={},R=rows.length,C=0;
  rows.forEach(function(r){if(r.length>C)C=r.length});
  for(var r=0;r<R;r++)for(var c=0;c<rows[r].length;c++){
    var v=rows[r][c];
    if(v===''||v==null)continue;
    var addr=X.utils.encode_cell({r:r,c:c}),cell;
    if(typeof v==='string'&&v.charAt(0)==='=')cell={t:'n',f:v.slice(1)};
    else if(typeof v==='string'&&/^-?\d+(\.\d+)?$/.test(v.trim()))cell={t:'n',v:parseFloat(v)};
    else cell={t:'s',v:String(v)};
    ws[addr]=cell;
  }
  ws['!ref']=X.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,R-1),c:Math.max(0,C-1)}});
  return ws;
}
async function _wsBuildXlsxFromCsv(text){
  await _wsLoadScript(_WS_RICH_CDN.xlsx,'XLSX');
  var X=window.XLSX;
  if(!X||!X.utils)throw new Error('XLSX 库未正确加载');
  var src=String(text||'').replace(/\r\n?/g,'\n');
  var marks=[],re=/^【表[:：]\s*([^】]+?)\s*】\s*$/gm,m;
  while((m=re.exec(src))!==null)marks.push({idx:m.index,end:re.lastIndex,name:m[1]});
  var blocks=[];
  if(!marks.length)blocks.push({name:'Sheet1',body:src});
  else{
    if(src.slice(0,marks[0].idx).trim())blocks.push({name:'Sheet1',body:src.slice(0,marks[0].idx)});
    for(var i=0;i<marks.length;i++){
      var end=i+1<marks.length?marks[i+1].idx:src.length;
      blocks.push({name:marks[i].name,body:src.slice(marks[i].end,end)});
    }
  }
  var wb=X.utils.book_new(),used={};
  blocks.forEach(function(b,bi){
    var rows=_wsCsvParse(b.body.replace(/^\n+/,''));
    if(!rows.length||rows.every(function(r){return r.every(function(c){return c===''})}))return;
    var nm=String(b.name||('表'+(bi+1))).replace(/[\[\]:*?\/\\]/g,'').slice(0,31)||('表'+(bi+1));
    var base=nm,k=2;
    while(used[nm]){nm=base.slice(0,28)+'('+k+')';k++}
    used[nm]=1;
    X.utils.book_append_sheet(wb,_wsAoaToSheet(X,rows),nm);
  });
  if(!wb.SheetNames.length)throw new Error('未解析到任何表格内容');
  var out=X.write(wb,{bookType:'xlsx',type:'array'});
  return new Blob([out],{type:_wsRichMime('x.xlsx')});
}
/* ── ── ws_make_* 执行器：构建 → base64 入库（与导入的富 ── */
async function _wsExecMakeOp(kind,op,authorName){
  var extMap={docx:'.docx',pdf:'.pdf',xlsx:'.xlsx'};
  var path=String(op.path||'').trim();
  if(path.toLowerCase().slice(-extMap[kind].length)!==extMap[kind])path+=extMap[kind];
  try{
    var blob;
    if(kind==='docx')blob=await _wsBuildDocxFromMd(op.content);
    else if(kind==='pdf')blob=await _wsBuildPdfFromHtml(op.content);
    else blob=await _wsBuildXlsxFromCsv(op.content);
    var bytes=new Uint8Array(await blob.arrayBuffer());
    var dataUrl=_wsBytesToDataUrl(bytes,_wsRichMime(path));
    var renamedFrom='';
    var uniq=await _wsUniquePath(_wsActiveProject,path);
    if(uniq!==path){renamedFrom=path;path=uniq}
    await wsSaveFile(_wsActiveProject,path,dataUrl,authorName);
    return{ok:true,size:bytes.length,path:path,renamedFrom:renamedFrom||undefined};
  }catch(e){
    var msg=(e&&e._wsLibMsg)?e._wsLibMsg.replace(/^\[|\]$/g,''):('生成失败：'+String(e&&e.message||e).slice(0,120));
    return{ok:false,path:path,reason:msg};
  }
}
/* 提取文本填充到预览的文本视图（预览切换与纯文本格式初始化共用） */
async function _wsRichLoadTextInto(code,fileId){
  if(!code||code._richLoaded)return;
  code.textContent='正在提取文本…';
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  var text=f?await _wsExtractRichText(f):'[无法提取文本内容]';
  if(!code.isConnected)return;
  code.textContent=text.split('\n').map(function(l,i){return String(i+1).padStart(4,' ')+'  '+l}).join('\n');
  code._richLoaded=!_wsRichEnvFail(text);/* 环境性失败不锁定，开启开关后再次切到文本视图即自动重试 */
}
/* ── DIY 页「文件解析库」卡片：总开关（默认关）+ 各库就绪状态 +
   一次性全部获取 / 清除已下载 + 三个数值设置 ── */
function _ibRichLibCatalog(){
  return[
    {label:'PDF 读取与渲染（pdf.js）',urls:[_WS_RICH_CDN.pdf,_WS_RICH_CDN.pdfWorker],mode:'all'},
    {label:'DOCX 读取（mammoth）',urls:[_WS_RICH_CDN.mammoth],mode:'all'},
    {label:'表格读取与生成（SheetJS）',urls:[_WS_RICH_CDN.xlsx],mode:'all'},
    {label:'DOCX 生成（docx）',urls:_WS_RICH_CDN.docx.slice(),mode:'any'},
    {label:'PDF 生成（jsPDF）',urls:_WS_RICH_CDN.jspdf.slice(),mode:'any'},
    {label:'页面截图（html2canvas）',urls:_WS_RICH_CDN.h2c.slice(),mode:'any'}
  ];
}
async function _ibRichLibsRefreshCard(){
  var list=document.getElementById('ib-richlib-list');
  if(!list||!list.isConnected)return;
  var cat=_ibRichLibCatalog(),html='';
  for(var i=0;i<cat.length;i++){
    var it=cat[i],okc=0;
    for(var j=0;j<it.urls.length;j++){if(await _ibLibGet(it.urls[j]))okc++}
    var ready=it.mode==='all'?okc>=it.urls.length:okc>0;
    html+='<div style="display:flex;justify-content:space-between;gap:10px"><span>'+it.label+'</span><span style="'+(ready?'color:var(--accent)':'opacity:0.5')+'">'+(ready?'已就绪':'未获取')+'</span></div>';
  }
  if(list.isConnected)list.innerHTML=html;
  var allBtn=document.getElementById('ib-richlib-all');
  if(allBtn)allBtn.disabled=!_ibRichLibsOn();
}
async function _ibRichLibsFetchAll(){
  if(!_ibRichLibsOn()){toast('请先开启「允许联网获取解析库」');return}
  var btn=document.getElementById('ib-richlib-all');
  if(btn){btn.disabled=true;btn.textContent='获取中…'}
  var cat=_ibRichLibCatalog(),okN=0,failN=0;
  for(var i=0;i<cat.length;i++){
    var it=cat[i];
    try{
      if(it.mode==='all'){for(var j=0;j<it.urls.length;j++)await _wsFetchLibText([it.urls[j]],it.label)}
      else await _wsFetchLibText(it.urls,it.label);
      okN++;
    }catch(e){failN++}
    await _ibRichLibsRefreshCard();
  }
  if(btn){btn.disabled=!_ibRichLibsOn();btn.textContent='一次性全部获取'}
  toast(failN?('解析库获取完成：'+okN+' 组成功、'+failN+' 组失败，可稍后重试'):'全部解析库已获取，此后离线可用');
}
async function _ibRichLibsClear(){
  try{await _ibLibClear()}catch(e){}
  _wsScriptCache={};_wsPdfLibPromise=null;
  await _ibRichLibsRefreshCard();
  toast('已清除本地解析库缓存；本页已加载过的库需刷新页面后才会完全卸载');
}
function _ibRichLibsMount(){
  var body=document.getElementById('ib-richlib-body');
  if(!body)return;
  body.innerHTML=''
    +'<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" id="ib-richlib-toggle" class="u-native-check"'+(_ibRichLibsOn()?' checked':'')+'> 允许联网获取解析库</label>'
    +'<div style="font-size:0.72rem;opacity:0.6;line-height:1.7;margin:4px 0 10px">解析库用于 PDF / DOCX / XLSX / PPTX 等文件的预览、文本提取与文件生成。开启后，首次用到某格式时才从公共代码源（cdnjs / jsDelivr，均为开源许可）下载对应库，并长期保存在浏览器本地，此后离线可用；关闭状态不发起任何网络请求，相关功能会提示先开启本开关。默认关闭。</div>'
    +'<div id="ib-richlib-list" style="font-size:0.8rem;line-height:2">检测中…</div>'
    +'<div style="margin:8px 0 14px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-compact" id="ib-richlib-all">一次性全部获取</button><button class="btn btn-compact" id="ib-richlib-clear">清除已下载</button></div>'
    +'<div style="font-size:13px;display:flex;flex-direction:column;gap:6px">'
    +'<label>单文件注入上限（万字符，10–300）<input type="number" id="ib-richlib-inj" class="ib-num" min="10" max="300" style="width:64px;margin-left:6px"></label>'
    +'<label>PDF「以图片发送」单次页数上限（1–60）<input type="number" id="ib-richlib-pgs" class="ib-num" min="1" max="60" style="width:64px;margin-left:6px"></label>'
    +'<label>DOCX 内嵌图片提取张数上限（1–30）<input type="number" id="ib-richlib-din" class="ib-num" min="1" max="30" style="width:64px;margin-left:6px"></label>'
    +'</div>'
    +'<div style="font-size:0.72rem;opacity:0.6;line-height:1.7;margin-top:6px">注入上限同时作用于聊天附件与 ws_read 的单文件文本；超出部分自动截断并注明，AI 可用 ws_read 的分段参数继续读取。调大仅对超长上下文模型有意义，且按输入计费。</div>';
  var tg=document.getElementById('ib-richlib-toggle');
  if(tg)tg.onchange=function(){
    try{localStorage.setItem('ib_richLibs',tg.checked?'1':'0')}catch(e){}
    toast('联网获取解析库已'+(tg.checked?'开启':'关闭'));
    _ibRichLibsRefreshCard();
  };
  var allBtn=document.getElementById('ib-richlib-all');
  if(allBtn)allBtn.onclick=function(){_ibRichLibsFetchAll()};
  var clrBtn=document.getElementById('ib-richlib-clear');
  if(clrBtn)clrBtn.onclick=function(){_ibRichLibsClear()};
  var wire=function(id,getFn,key,mul){
    var el=document.getElementById(id);
    if(!el)return;
    el.value=Math.round(getFn()/(mul||1));
    el.onchange=function(){
      var v=parseInt(el.value,10)||0;
      var mn=parseInt(el.min,10),mx=parseInt(el.max,10);
      v=Math.min(mx,Math.max(mn,v));el.value=v;
      try{localStorage.setItem(key,String(v*(mul||1)))}catch(e){}
    };
  };
  wire('ib-richlib-inj',_ibInjectMax,'ib_injectMax',10000);
  wire('ib-richlib-pgs',_ibPdfImgPages,'ib_pdfImgPages',1);
  wire('ib-richlib-din',_ibDocxImgMax,'ib_docxImgN',1);
  _ibRichLibsRefreshCard();
}
/* ── ZIP 直接导入：零依赖的最小 ZIP 读取器 ──────────────────────
   解析中央目录 → 逐条抽出文本条目。DEFLATE 用浏览器原生
   DecompressionStream('deflate-raw') 解压（Chrome 103+ / Edge / Safari 16.4+ / Firefox 113+），
   STORED 直接切片。不支持加密条目与 ZIP64（>4GB / >65535 条），
   GitHub 下载的源码包与常见打包工具产物均可直接拖入。
   条目名解码：优先按 UTF-8 标志位，失败回退 GBK（兼容中文压缩工具）。 */
function _icodeZipName(buf,flags){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buf)}catch(e){}
  try{return new TextDecoder('gbk').decode(buf)}catch(e){}
  return new TextDecoder('utf-8').decode(buf);
}
async function _icodeIngestZip(file,base,out,skip){
  if(file.size>ICODE_IMP.MAX_TOTAL*2){skip.big++;return}
  var buf,dv;
  try{buf=new Uint8Array(await file.arrayBuffer());dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength)}catch(e){skip.err++;return}
  /* 定位 EOCD 记录（PK\x05\x06）：从尾部回扫，注释区最长 64K */
  var eocd=-1,lo=Math.max(0,buf.length-22-65535);
  for(var i=buf.length-22;i>=lo;i--){if(dv.getUint32(i,true)===0x06054b50){eocd=i;break}}
  if(eocd<0){skip.err++;return}
  var count=dv.getUint16(eocd+10,true),cdOff=dv.getUint32(eocd+16,true);
  if(count===0xffff||cdOff===0xffffffff){skip.err++;return}/* ZIP64 不支持 */
  var canInflate=typeof DecompressionStream!=='undefined';
  var ents=[],p=cdOff;
  for(var n2=0;n2<count;n2++){
    if(p+46>buf.length||dv.getUint32(p,true)!==0x02014b50)break;
    var flags=dv.getUint16(p+8,true),method=dv.getUint16(p+10,true);
    var csize=dv.getUint32(p+20,true),usize=dv.getUint32(p+24,true);
    var nlen=dv.getUint16(p+28,true),elen=dv.getUint16(p+30,true),clen=dv.getUint16(p+32,true);
    var lho=dv.getUint32(p+42,true);
    var nm=_icodeZipName(buf.subarray(p+46,p+46+nlen),flags);
    p+=46+nlen+elen+clen;
    ents.push({name:nm,flags:flags,method:method,csize:csize,usize:usize,lho:lho});
  }
  /* 全部有效条目共享同一顶层目录时剥掉它（GitHub 源码包结构），并用作项目名建议。
     判定前先排除 __MACOSX / .DS_Store 等垃圾条目，否则它们会破坏"共同根目录"判断 */
  var root='';
  var meaningful=ents.filter(function(e2){return !/^__MACOSX\//.test(e2.name)&&!/(^|\/)\.DS_Store$/i.test(e2.name)});
  if(meaningful.length){
    var seg=meaningful[0].name.split('/')[0];
    if(seg&&meaningful.every(function(e2){return e2.name===seg+'/'||e2.name.indexOf(seg+'/')===0}))root=seg;
  }
  if(base===''&&out.zipRoot===undefined)out.zipRoot=root||String(file.name||'').replace(/\.zip$/i,'');
  for(var k2=0;k2<ents.length;k2++){
    if(out.stop)return;
    var en=ents[k2];
    var path=root?en.name.slice(root.length+1):en.name;
    if(!path||path.slice(-1)==='/')continue;/* 目录项 */
    if(/^__MACOSX\//.test(en.name)||/(^|\/)\.DS_Store$/i.test(path))continue;
    var segs=path.split('/'),hitDir=false;
    for(var s2=0;s2<segs.length-1;s2++)if(_ICODE_SKIP_DIRS[segs[s2].toLowerCase()]){hitDir=true;break}
    if(hitDir){skip.dir++;continue}
    if(en.flags&0x1){skip.err++;continue}/* 加密条目 */
    if(/\.zip$/i.test(path)){skip.bin++;continue}/* 不递归嵌套压缩包 */
    if(/\.(doc|ppt)$/i.test(path)){skip.doc=(skip.doc||0)+1;continue}/* 老式二进制 Office：请另存为 .docx/.pptx */
    if(en.usize>ICODE_IMP.MAX_FILE){skip.big++;continue}
    if(out.list.length>=ICODE_IMP.MAX_FILES||out.total+en.usize>ICODE_IMP.MAX_TOTAL){out.stop=true;skip.over=true;return}
    var lp=en.lho;
    if(lp+30>buf.length||dv.getUint32(lp,true)!==0x04034b50){skip.err++;continue}
    var lnl=dv.getUint16(lp+26,true),lel=dv.getUint16(lp+28,true);
    var start=lp+30+lnl+lel;
    if(start+en.csize>buf.length){skip.err++;continue}
    var raw=buf.subarray(start,start+en.csize),bytes;
    if(en.method===0)bytes=raw;
    else if(en.method===8){
      if(!canInflate){skip.err++;out.zipNoInflate=true;continue}
      try{bytes=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())}
      catch(e){skip.err++;continue}
    }else{skip.err++;continue}
    if(_icodeIsRich(path)){/* 富文件：以 base64 data URL 入库 */
      out.total+=bytes.length;out.list.push({path:base+path,content:_wsBytesToDataUrl(bytes,_wsRichMime(path)),size:bytes.length});continue;
    }
    if(!_icodeIsText(path.split('/').pop())&&_icodeLooksBinary(bytes)){skip.bin++;continue}
    var text;try{text=new TextDecoder('utf-8').decode(bytes)}catch(e){skip.err++;continue}
    out.total+=bytes.length;out.list.push({path:base+path,content:text,size:bytes.length});
  }
}
/* DirectoryReader.readEntries 一次最多返回100条，必须循环读空 */
function _icodeReadAllEntries(reader){
  return new Promise(function(res,rej){
    var all=[];
    (function loop(){reader.readEntries(function(es){if(!es.length)return res(all);all=all.concat(Array.from(es));loop()},rej)})();
  });
}
function _icodeFileOf(entry){return new Promise(function(res,rej){entry.file(res,rej)})}
async function _icodeWalk(entry,base,out,skip,fbFile){
  if(out.stop)return;
  if(entry.isFile){
    var f=null;try{f=await _icodeFileOf(entry)}catch(e){}
    /* entry.file() 读不出来（虚拟文件等）时，退回拖放时同步抓到的 File 快照 */
    if(!f&&fbFile)f=fbFile;
    if(!f){skip.err++;return}
    if(/\.zip$/i.test(entry.name)){await _icodeIngestZip(f,base,out,skip);return}
    if(/\.(doc|ppt)$/i.test(entry.name)){skip.doc=(skip.doc||0)+1;return}/* 老式二进制 Office：请另存为 .docx/.pptx */
    if(_icodeIsRich(entry.name)){/* 富文件：读为 base64 data URL 入库 */
      if(f.size>ICODE_IMP.MAX_FILE){skip.big++;return}
      if(out.list.length>=ICODE_IMP.MAX_FILES||out.total+f.size>ICODE_IMP.MAX_TOTAL){out.stop=true;skip.over=true;return}
      var du;try{du=await _wsFileToDataUrl(f,entry.name)}catch(e){skip.err++;return}
      out.total+=f.size;out.list.push({path:base+entry.name,content:du,size:f.size});return;
    }
    if(!_icodeIsText(entry.name)){
      /* 扩展名不在白名单：嗅探内容，无 NUL 字节的按纯文本放行（如无后缀的说明文件） */
      var isTxt=false;try{isTxt=await _icodeSniffText(f)}catch(e){}
      if(!isTxt){skip.bin++;return}
    }
    if(f.size>ICODE_IMP.MAX_FILE){skip.big++;return}
    if(out.list.length>=ICODE_IMP.MAX_FILES||out.total+f.size>ICODE_IMP.MAX_TOTAL){out.stop=true;skip.over=true;return}
    var text;try{text=await f.text()}catch(e){skip.err++;return}
    out.total+=f.size;out.list.push({path:base+entry.name,content:text,size:f.size});
  }else if(entry.isDirectory){
    if(_ICODE_SKIP_DIRS[entry.name.toLowerCase()]){skip.dir++;return}
    var es;try{es=await _icodeReadAllEntries(entry.createReader())}catch(e){skip.err++;return}
    for(var i=0;i<es.length;i++){if(out.stop)return;await _icodeWalk(es[i],base+entry.name+'/',out,skip)}
  }
}
/* 从 drop 事件的 dataTransfer 收集：优先 entry API（支持文件夹递归）；
   拿不到 entry 时兜底走 dt.files（只收平铺文件）。 */
/* ── 平铺文件清单收集（拖入兜底 + 「导入」按钮选择器共用管线）── */
async function _icodeCollectFlatFiles(arr,out,skip){
  for(var k=0;k<arr.length;k++){
    if(out.stop)break;
    var f2=arr[k];if(!f2||!f2.name)continue;
    if(/\.zip$/i.test(f2.name)){await _icodeIngestZip(f2,'',out,skip);continue}
    if(/\.(doc|ppt)$/i.test(f2.name)){skip.doc=(skip.doc||0)+1;continue}/* 老式二进制 Office：请另存为 .docx/.pptx */
    if(_icodeIsRich(f2.name)){/* 富文件：读为 base64 data URL 入库 */
      if(f2.size>ICODE_IMP.MAX_FILE){skip.big++;continue}
      if(out.list.length>=ICODE_IMP.MAX_FILES||out.total+f2.size>ICODE_IMP.MAX_TOTAL){out.stop=true;skip.over=true;break}
      try{out.list.push({path:f2.webkitRelativePath||f2.name,content:await _wsFileToDataUrl(f2,f2.name),size:f2.size});out.total+=f2.size}catch(e){skip.err++}
      continue;
    }
    if(!_icodeIsText(f2.name)){
      var isTxt2=false;try{isTxt2=await _icodeSniffText(f2)}catch(e){}
      if(!isTxt2){skip.bin++;continue}
    }
    if(f2.size>ICODE_IMP.MAX_FILE){skip.big++;continue}
    if(out.list.length>=ICODE_IMP.MAX_FILES||out.total+f2.size>ICODE_IMP.MAX_TOTAL){out.stop=true;skip.over=true;break}
    try{out.list.push({path:f2.webkitRelativePath||f2.name,content:await f2.text(),size:f2.size});out.total+=f2.size}catch(e){skip.err++}
  }
}
async function _icodeCollectDrop(dt){
  var out={list:[],total:0,stop:false},skip={bin:0,doc:0,big:0,dir:0,err:0,over:false},rootName='';
  /* ⚠ 关键：DataTransfer 的 items 在事件处理器第一次 await 之后会被浏览器清空。
     所以 entry / getAsFile / files 三样都必须在这里同步抓取快照，后面再慢慢读。 */
  var items=dt&&dt.items?Array.from(dt.items):[];
  var itemFiles=items.map(function(it){try{return it.kind==='file'?it.getAsFile():null}catch(e){return null}});
  var flatFiles=[];try{flatFiles=Array.from(dt&&dt.files?dt.files:[])}catch(e){}
  var pairs=[];
  for(var pi=0;pi<items.length;pi++){
    var en0=null;try{en0=(items[pi].kind==='file'&&items[pi].webkitGetAsEntry)?items[pi].webkitGetAsEntry():null}catch(e){}
    if(en0)pairs.push({entry:en0,fb:itemFiles[pi]});
  }
  if(pairs.length){
    if(pairs.length===1&&pairs[0].entry.isDirectory)rootName=pairs[0].entry.name;
    for(var i=0;i<pairs.length;i++){
      var e=pairs[i].entry;
      if(out.stop)break;
      if(e.isDirectory){
        if(_ICODE_SKIP_DIRS[e.name.toLowerCase()]){skip.dir++;continue}
        var es;try{es=await _icodeReadAllEntries(e.createReader())}catch(x){skip.err++;continue}
        /* 只拖一个文件夹时，路径去掉最外层目录名（engine.py 而不是 项目名/engine.py） */
        var base=pairs.length===1?'':(e.name+'/');
        for(var j=0;j<es.length;j++){if(out.stop)break;await _icodeWalk(es[j],base,out,skip)}
      }else await _icodeWalk(e,'',out,skip,pairs[i].fb);
    }
  }else{
    /* 拿不到 entry：退回 dt.files 快照；连它也是空的就试 getAsFile 快照 */
    var flat=flatFiles.length?flatFiles:itemFiles.filter(Boolean);
    if(flat.length)await _icodeCollectFlatFiles(flat,out,skip);
  }
  /* 虚拟文件识别：拖放声称带了文件（types 含 Files / items 有 file 项），
     却既没有 entry、也没有任何可用的 File 对象——典型来源是压缩包预览窗口、
     邮件客户端附件等"延迟渲染"拖拽，浏览器拿不到字节。 */
  var claimed=false;
  try{claimed=items.some(function(it){return it&&it.kind==='file'})||Array.prototype.indexOf.call((dt&&dt.types)||[],'Files')>-1}catch(e){}
  if(claimed&&!pairs.length&&!flatFiles.length&&!itemFiles.some(Boolean))out.virtual=true;
  if(!rootName&&out.zipRoot)rootName=out.zipRoot;/* 拖入单个 zip 时，用包内顶层目录 / 包名作项目名建议 */
  return{files:out.list,total:out.total,skip:skip,rootName:rootName,zipNoInflate:!!out.zipNoInflate,virtual:!!out.virtual};
}
/* ── 空结果的统一提示：把"为什么没导入"说清楚，并给出能走通的替代路径 ── */
function _icodeEmptyToast(col){
  if(col.virtual){toast('浏览器无法读取本次拖入的文件内容：从压缩包（.zip）预览窗口中直接拖出的文件属于"虚拟文件"，网页无法获取其数据。请先解压后再拖入，或直接拖入整个 .zip，或使用标题栏「导入」按钮选择文件');return}
  if(col.zipNoInflate){toast('当前浏览器不支持在线解压 ZIP，请更新浏览器至较新版本，或解压后再行导入');return}
  var parts=[];
  if(col.skip.bin)parts.push(col.skip.bin+' 个二进制或不支持的文件');
  if(col.skip.doc)parts.push(col.skip.doc+' 个老式 .doc/.ppt（请另存为 .docx/.pptx）');
  if(col.skip.big)parts.push(col.skip.big+' 个超过大小上限');
  if(col.skip.dir)parts.push(col.skip.dir+' 个依赖/系统目录');
  if(col.skip.err)parts.push(col.skip.err+' 个读取失败');
  if(!parts.length){toast('未检测到可导入的文件');return}
  toast('未导入任何文件：已跳过 '+parts.join('、')+(col.skip.err?'。若文件来自压缩包预览窗口，请先解压，或使用标题栏「导入」按钮':''));
}
/* ── 「导入」按钮：系统文件选择器，与拖入完全同一条管线 ──
   拖拽在某些环境不可靠（虚拟文件 / 浏览器差异 / 触屏设备），这条路径永远走得通。 */
function wsPickImport(){
  var inp=document.createElement('input');inp.type='file';inp.multiple=true;
  inp.onchange=async function(){
    var files=Array.from(inp.files||[]);
    if(!files.length)return;
    await _icodeImportFromFiles(files);
  };
  inp.click();
}
async function _icodeImportFromFiles(files){
  var out={list:[],total:0,stop:false},skip={bin:0,doc:0,big:0,dir:0,err:0,over:false};
  await _icodeCollectFlatFiles(files,out,skip);
  var col={files:out.list,total:out.total,skip:skip,rootName:out.zipRoot||'',zipNoInflate:!!out.zipNoInflate,virtual:false};
  if(!col.files.length){_icodeEmptyToast(col);return}
  _icodeShowImportDialog(col);
}
/* 导入确认对话框：明确告知数量/体积/跳过项，以及 token 只在 AI 读取时消耗 */
function _icodeShowImportDialog(col){
  var win=document.getElementById('ws-overlay');if(!win)return;
  var old=win.querySelector('.ws-dialog-mask');if(old)old.remove();
  var intoCurrent=!!_wsViewingProject;
  var curName=intoCurrent?((document.getElementById('ws-title')||{}).textContent||'当前项目'):'';
  var defName=col.rootName||('导入 '+new Date().toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}));
  var skipParts=[];
  if(col.skip.bin)skipParts.push(col.skip.bin+' 个不支持的二进制文件');
  if(col.skip.doc)skipParts.push(col.skip.doc+' 个老式 .doc/.ppt（请另存为 .docx/.pptx）');
  if(col.skip.dir)skipParts.push(col.skip.dir+' 个依赖/版本目录');
  if(col.skip.big)skipParts.push(col.skip.big+' 个超过 '+_fmtFileSize(ICODE_IMP.MAX_FILE)+' 的文件');
  if(col.skip.err)skipParts.push(col.skip.err+' 个读取失败');
  var mask=document.createElement('div');mask.className='ws-dialog-mask';
  var d=document.createElement('div');d.className='ws-dialog';
  d.innerHTML='<h4>导入到 ICode</h4>'
    +'<p>共 <b>'+col.files.length+'</b> 个文件 · '+_fmtFileSize(col.total)
    +(intoCurrent?('<br>将并入当前项目「<b>'+esc(curName)+'</b>」，同名文件会被覆盖。'):('<br>将创建新项目「<b>'+esc(defName)+'</b>」。'))+'</p>'
    +(skipParts.length?('<div class="ws-dialog-note">已自动跳过 '+skipParts.join('、')+(col.skip.over?'；数量/体积达到导入上限（'+ICODE_IMP.MAX_FILES+' 个 / '+_fmtFileSize(ICODE_IMP.MAX_TOTAL)+'），其余未收录':'')+'。</div>'):(col.skip.over?'<div class="ws-dialog-note">数量/体积达到导入上限（'+ICODE_IMP.MAX_FILES+' 个 / '+_fmtFileSize(ICODE_IMP.MAX_TOTAL)+'），超出部分未收录。</div>':''))
    +'<div class="ws-dialog-note">导入只是存进浏览器本地，不消耗任何 token；之后让 AI 读取或修改这些文件时才会产生调用消耗。</div>'
    +'<div class="ws-dialog-actions"><button class="ws-file-btn" data-act="cancel">取消</button><button class="ws-file-btn primary" data-act="ok">确认导入</button></div>';
  mask.appendChild(d);win.appendChild(mask);
  mask.addEventListener('mousedown',function(e){if(e.target===mask)mask.remove()});
  d.querySelector('[data-act="cancel"]').onclick=function(){mask.remove()};
  d.querySelector('[data-act="ok"]').onclick=async function(){
    this.disabled=true;this.textContent='导入中…';
    try{await _icodeDoImport(col,intoCurrent?_wsViewingProject:null,defName)}
    catch(e){toast('导入失败：'+String(e&&e.message||e).slice(0,60))}
    mask.remove();
  };
}
async function _icodeDoImport(col,projId,name){
  if(!col.files.length){toast('没有可导入的文件');return}
  if(!projId){
    var all=await wsGetProjects();var nm=name,n=2;
    while(all.some(function(p){return p.name===nm})){nm=name+' ('+n+')';n++}
    projId=await wsEnsureProject(nm);
  }
  for(var i=0;i<col.files.length;i++){
    var f=col.files[i];
    try{await wsSaveFile(projId,f.path,f.content,'导入')}catch(e){}
  }
  _wsActiveProject=projId;
  toast('已导入 '+col.files.length+' 个文件');
  renderWsFiles(projId);
}
async function wsRenameProject(projId,newName){
  if(projId===WS_DEFAULT_PROJ_ID)return{ok:false,reason:'「ICode」是默认文件夹，不可重命名'};
  newName=(newName||'').trim();
  if(!newName)return{ok:false,reason:'名称不能为空'};
  if(newName.length>60)return{ok:false,reason:'名称过长（最多 60 字）'};
  var all=await wsGetProjects();
  if(all.some(function(p){return p.name===newName&&p.id!==projId}))return{ok:false,reason:'已存在同名项目'};
  var p=null;try{p=await dbGet('projects',projId)}catch(e){}
  if(!p)return{ok:false,reason:'项目不存在'};
  if(p.name===newName)return{ok:true,name:newName};
  p.name=newName;p.lastModified=Date.now();
  try{await dbPut('projects',p)}catch(e){return{ok:false,reason:'保存失败'}}
  return{ok:true,name:newName};
}
/* 内联重命名：把名称元素临时换成输入框，Enter 保存 / Esc 取消 / 失焦保存 */
function _wsInlineRename(projId,nameEl,after){
  if(!nameEl||nameEl.querySelector('input'))return;
  var old=nameEl.textContent;
  var inp=document.createElement('input');
  inp.type='text';inp.className='ws-rename-input';inp.value=old;inp.maxLength=60;inp.placeholder='项目名称';
  nameEl.textContent='';nameEl.appendChild(inp);
  inp.focus();inp.select();
  var done=false;
  async function commit(save){
    if(done)return;done=true;
    var val=inp.value;
    if(!save||val.trim()===old||!val.trim()){nameEl.textContent=old;return}
    var r=await wsRenameProject(projId,val);
    if(r.ok){
      nameEl.textContent=r.name;
      toast('已重命名为「'+r.name+'」');
      if(after)after(r.name);
    }else{
      nameEl.textContent=old;
      toast(r.reason||'重命名失败');
    }
  }
  inp.onkeydown=function(e){
    e.stopPropagation();/* 防止 Esc 触发关闭窗口、Enter 泄漏到全局 */
    if(e.key==='Enter'){e.preventDefault();commit(true)}
    else if(e.key==='Escape'){e.preventDefault();commit(false)}
  };
  inp.onblur=function(){commit(true)};
  inp.onclick=function(e){e.stopPropagation()};
  inp.onmousedown=function(e){e.stopPropagation()};
}
/* 文件视图标题处重命名当前项目 */
function wsRenameCurrentProject(projId){
  var t=document.getElementById('ws-title');if(!t)return;
  _wsInlineRename(projId,t);
}
async function renderWsProjects(){
  var body=document.getElementById('ws-body');if(!body)return;
  var title=document.getElementById('ws-title');if(title)title.textContent='ICode';
  var sub=document.getElementById('ws-subtitle');if(sub)sub.textContent='';
  try{await wsEnsureDefaultProject()}catch(e){}
  var projects=await wsGetProjects();
  /* 老库迁移：上传文件夹旧名 USER 统一为 User（写回一次，之后不再触发） */
  projects.forEach(function(p){if(p.id===WS_USER_PROJ_ID&&p.name==='USER'){p.name='User';try{dbPut('projects',p).catch(function(){})}catch(e){}}});
  projects.sort(function(a,b){
    var ra=a.id===WS_DEFAULT_PROJ_ID?0:(a.id===WS_USER_PROJ_ID?1:2);/* 默认恒置顶，User 紧随其后 */
    var rb=b.id===WS_DEFAULT_PROJ_ID?0:(b.id===WS_USER_PROJ_ID?1:2);
    if(ra!==rb)return ra-rb;
    return(b.lastModified||b.created)-(a.lastModified||a.created)});
  if(!projects.length){
    body.innerHTML='<div class="ws-empty">'+WS_ICON.folder+'<div>还没有工作项目</div><div style="font-size:0.78rem;margin-top:4px">在对话中让 AI 创建，或把文件夹拖进这扇窗导入</div></div>';
    return;
  }
  var html='';
  for(var p of projects){
    var files=await wsGetFiles(p.id);
    var totalSize=0;files.forEach(function(f){totalSize+=f.size||0});
    var isDef=p.id===WS_DEFAULT_PROJ_ID;
    var isUsr=p.id===WS_USER_PROJ_ID;
    html+='<div class="ws-proj-card" onclick="renderWsFiles(\''+p.id+'\')">'
      +'<span class="ws-proj-icon">'+WS_ICON.folder+'</span>'
      +'<div class="ws-proj-info">'
      +'<div class="ws-proj-name-row"><span class="ws-proj-name" id="wspn-'+p.id+'">'+esc(p.name)+'</span>'+(isDef?'<span class="ws-proj-tag">默认</span>':(isUsr?'<span class="ws-proj-tag">上传</span>':''))+'</div>'
      +'<div class="ws-proj-meta">'+files.length+' 个文件 · '+_fmtFileSize(totalSize)+' · 更新于 '+new Date(p.lastModified||p.created).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</div>'
      +'</div>'
      +((isDef||isUsr)?'':'<div class="ws-card-actions">'
      +'<button class="ws-icon-btn" title="重命名" onclick="event.stopPropagation();_wsInlineRename(\''+p.id+'\',document.getElementById(\'wspn-'+p.id+'\'))">'+WS_ICON.rename+'</button>'
      +'<button class="ws-icon-btn danger" title="删除项目" onclick="event.stopPropagation();wsConfirmDeleteProject(\''+p.id+'\')">'+WS_ICON.trash+'</button>'
      +'</div>')
      +'</div>';
  }
  body.innerHTML=html;
  _wsUpdateStorage();
}
async function renderWsFiles(projId){
  _wsViewingProject=projId;
  var body=document.getElementById('ws-body');if(!body)return;
  var proj=null;try{proj=await dbGet('projects',projId)}catch(e){}
  if(!proj){body.innerHTML='<div class="ws-empty">项目不存在</div>';return}
  var title=document.getElementById('ws-title');if(title)title.textContent=proj.name;
  var sub=document.getElementById('ws-subtitle');
  var files=await wsGetFiles(projId);
  files.sort(function(a,b){return(b.lastModified||b.created)-(a.lastModified||a.created)});
  if(sub)sub.innerHTML='<b>'+files.length+'</b>'+(files.length===1?'File':'Files');
  var isDef=projId===WS_DEFAULT_PROJ_ID;
  var isUsr=projId===WS_USER_PROJ_ID;
  var isSys=isDef||isUsr;/* 系统文件夹（默认 / User）：不可重命名、不可删除 */
  var html='<div class="ws-file-header"><div class="ws-file-header-title"><h3>Files</h3>'+(isDef?'<span class="ws-proj-tag">默认</span>':(isUsr?'<span class="ws-proj-tag">上传</span>':''))+'</div>'
    +'<div class="ws-file-header-actions">'
    +(isSys?'':'<button class="ws-file-btn" onclick="wsRenameCurrentProject(\''+projId+'\')">重命名</button>'
    +'<button class="ws-file-btn danger" onclick="wsConfirmDeleteProject(\''+projId+'\')">删除项目</button>')
    +'</div></div>';
  if(!files.length){html+='<div class="ws-empty" style="padding:30px">'+(isUsr?'还没有上传过文件<br><span style="font-size:0.72rem;opacity:0.8">在聊天里附加发送的文件会自动归档到这里</span>':'项目中还没有文件')+'</div>';body.innerHTML=html;_wsUpdateStorage();return}
  for(var f of files){
    html+='<div class="ws-file-row" id="wsf-'+f.id+'" draggable="true" ondragstart="wsFileDragStart(event,this,\''+f.id+'\')" title="拖到聊天窗口可作为附件发送">'
      +'<div class="ws-file-icon">'+WS_ICON.file+'</div>'
      +'<div class="ws-file-info"><div class="ws-file-name">'+esc(f.path)+'</div>'
      +'<div class="ws-file-meta">'+_fmtFileSize(f.size||0)+' · '+((f.lastModifiedBy==='你'?'User':f.lastModifiedBy)||'AI')+' · '+new Date(f.lastModified).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</div></div>'
      +'<div class="ws-file-actions">'
      +'<button class="ws-file-btn" onclick="wsTogglePreview(\''+f.id+'\')">预览</button>'
      +(/\.(py|mjs|js)$/i.test(f.path)?'<button class="ws-file-btn" onclick="wsRunFileFromUI(\''+f.id+'\')">运行</button>':'')
      +'<button class="ws-file-btn" onclick="wsDownloadFile(\''+f.id+'\')">下载</button>'
      +'<button class="ws-icon-btn" title="复制或移动到其他文件夹" onclick="wsMoveCopyDialog(\''+f.id+'\',\''+projId+'\')">'+WS_ICON.organize+'</button>'
      +'<button class="ws-file-btn danger" onclick="wsConfirmDeleteFile(\''+f.id+'\',\''+projId+'\')">删除</button>'
      +'</div></div>';
  }
  body.innerHTML=html;
  _wsUpdateStorage();
}
/* ── ICode → Chat：把文件行拖进聊天窗口，作为附件挂到输入栏 ── */
var _WS_DRAG_MIME='application/x-ib-wsfile';
function wsFileDragStart(e,row,fileId){
  try{
    e.dataTransfer.setData(_WS_DRAG_MIME,fileId);
    var nmEl=row&&row.querySelector?row.querySelector('.ws-file-name'):null;
    e.dataTransfer.setData('text/plain',nmEl?nmEl.textContent:'ICode 文件');
    e.dataTransfer.effectAllowed='copy';
  }catch(err){}
}
async function wsAttachFileToChat(fileId){
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f){toast('文件不存在或已被删除');return}
  var name=String(f.path||'file').split('/').pop();
  var content=typeof f.content==='string'?f.content:'';
  if(content.slice(0,11)==='data:image/'){
    if(_pendingImages.length>=IMG_MAX_COUNT){toast('最多附加'+IMG_MAX_COUNT+'张图片');return}
    var m=content.match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
    if(!m){toast('图片数据无法解析');return}
    _pendingImages.push({dataUrl:content,base64:m[2],mime:m[1],name:name,size:Math.round(m[2].length*0.75)});
    renderAttachPreviews();toast('已附加图片：'+name);return;
  }
  if(_icodeIsRich(f.path)&&content.slice(0,5)==='data:'){/* 富文件：提取文本后作为文本附件 */
    if(_pendingFiles.length>=FILE_MAX_COUNT){toast('最多附加 '+FILE_MAX_COUNT+' 个文件');return}
    var rSize=f.size||0;
    if(_pendingFiles.some(function(p){return p.name===name&&p.size===rSize})){toast('「'+name+'」已在附件栏');return}
    toast('正在提取「'+name+'」的文本…');
    var rText=await _wsExtractRichText(f);
    if(_wsRichIsFailText(rText)){toast('「'+name+'」未附加：'+rText.replace(/^\[|\]$/g,''));return}
    if(_pendingFiles.length>=FILE_MAX_COUNT){toast('最多附加 '+FILE_MAX_COUNT+' 个文件');return}
    var rExt=name.indexOf('.')>-1?name.split('.').pop():'';
    _pendingFiles.push({name:name,text:rText,size:rSize,ext:rExt,_fromWs:true});
    renderAttachPreviews();
    toast('已附加：'+name);return;
  }
  if(content.slice(0,5)==='data:'){toast('「'+name+'」是二进制文件，暂不支持作为附件发送');return}
  if(_pendingFiles.length>=FILE_MAX_COUNT){toast('最多附加 '+FILE_MAX_COUNT+' 个文件');return}
  var size=f.size||content.length;
  if(size>FILE_MAX_BYTES){toast('「'+name+'」过大（上限 '+_fmtFileSize(FILE_MAX_BYTES)+'）');return}
  if(_pendingFiles.some(function(p){return p.name===name&&p.size===size})){toast('「'+name+'」已在附件栏');return}
  var ext=name.indexOf('.')>-1?name.split('.').pop():'';
  _pendingFiles.push({name:name,text:content,size:size,ext:ext,_fromWs:true});
  renderAttachPreviews();
  toast('已附加：'+name);
}
(function(){
  function hasWsFile(e){try{return Array.prototype.indexOf.call((e.dataTransfer&&e.dataTransfer.types)||[],_WS_DRAG_MIME)>-1}catch(x){return false}}
  /* 有效落点：浮动聊天面板整体，或全屏 Chat 的主区域（消息流 + 预览栏 + 输入栏） */
  function zoneOf(t){if(!t||!t.closest)return null;return t.closest('#chat-panel')||t.closest('.chat-main-area')}
  var hl=null;
  function clearHl(){if(hl){hl.classList.remove('chat-drop-target');hl=null}}
  document.addEventListener('dragover',function(e){
    if(!hasWsFile(e))return;
    var z=zoneOf(e.target);
    if(!z){clearHl();return}
    e.preventDefault();e.dataTransfer.dropEffect='copy';
    if(hl!==z){clearHl();hl=z;z.classList.add('chat-drop-target')}
  });
  /* 捕获阶段拦截：先于消息区已有的图片 drop 处理，也阻止浏览器把 text/plain 兜底文本插进输入框 */
  document.addEventListener('drop',function(e){
    if(!hasWsFile(e))return;
    var z=zoneOf(e.target);clearHl();
    if(!z)return;
    e.preventDefault();e.stopPropagation();
    var fid='';try{fid=e.dataTransfer.getData(_WS_DRAG_MIME)}catch(x){}
    if(fid)wsAttachFileToChat(fid);
  },true);
  document.addEventListener('dragend',clearHl);
})();
async function wsDownloadFile(fileId){
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f)return;
  var content=typeof f.content==='string'?f.content:'';
  if(content.slice(0,5)==='data:'&&content.indexOf(';base64,')>-1){/* base64 存储的文件还原为原始二进制下载 */
    var blob=_wsBase64ToBlob(content);
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');a.href=url;a.download=String(f.path||'file').split('/').pop();
    document.body.appendChild(a);a.click();
    setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url)},200);
    return;
  }
  _downloadTextFile(f.path,f.content);
}
async function wsConfirmDeleteProject(projId){
  if(projId===WS_DEFAULT_PROJ_ID){toast('「ICode」是默认文件夹，不可删除');return}
  if(projId===WS_USER_PROJ_ID){toast('「User」是上传文件归档夹，不可删除');return}
  var p=null;try{p=await dbGet('projects',projId)}catch(e){}
  if(!p)return;
  if(!confirm('确定删除项目「'+p.name+'」及其所有文件？'))return;
  await wsDeleteProject(projId);
  renderWsProjects();toast('项目已删除');
}
async function wsConfirmDeleteFile(fileId,projId){
  if(!confirm('确定删除此文件？'))return;
  await wsDeleteFile(fileId);
  renderWsFiles(projId);toast('文件已删除');
}

/* ── 文件整理：把单个文件复制 / 移动到其他文件夹（含就地新建文件夹）──
   同名冲突不覆盖：自动改存为「名称 (2).ext」（复用上方 _wsUniquePath）并在提示里说明。 */
async function wsMoveCopyDialog(fileId,fromProjId){
  var win=document.getElementById('ws-overlay');if(!win)return;
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f){toast('文件不存在');return}
  var old=win.querySelector('.ws-dialog-mask');if(old)old.remove();
  var projects=await wsGetProjects();
  projects.sort(function(a,b){
    if(a.id===WS_DEFAULT_PROJ_ID)return -1;
    if(b.id===WS_DEFAULT_PROJ_ID)return 1;
    return(b.lastModified||b.created)-(a.lastModified||a.created)});
  var targets=projects.filter(function(p){return p.id!==fromProjId});
  var listHtml='';
  targets.forEach(function(p){
    listHtml+='<div class="ws-dialog-item" data-pid="'+p.id+'">'+WS_ICON.folder
      +'<span class="ws-dialog-item-name">'+esc(p.name)+'</span>'
      +(p.id===WS_DEFAULT_PROJ_ID?'<span class="ws-proj-tag">默认</span>':'')
      +'</div>';
  });
  listHtml+='<div class="ws-dialog-item" data-pid="__new__"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
    +'<span class="ws-dialog-item-name">新建文件夹…</span></div>';
  var mask=document.createElement('div');mask.className='ws-dialog-mask';
  var d=document.createElement('div');d.className='ws-dialog';
  d.innerHTML='<h4>复制或移动文件</h4>'
    +'<p><b>'+esc(f.path)+'</b>　<span style="font-size:0.72rem;opacity:0.75">'+_fmtFileSize(f.size||0)+'</span></p>'
    +'<div class="ws-dialog-list">'+listHtml+'</div>'
    +'<div class="ws-dialog-note">若目标里已有同名文件，会自动存为「名称 (2)」的形式，不会覆盖。</div>'
    +'<div class="ws-dialog-actions">'
    +'<button class="ws-file-btn" data-act="cancel">取消</button>'
    +'<button class="ws-file-btn" data-act="copy" disabled>复制到此</button>'
    +'<button class="ws-file-btn primary" data-act="move" disabled>移动到此</button>'
    +'</div>';
  mask.appendChild(d);win.appendChild(mask);
  var sel=null,newInput=null;
  var btnCopy=d.querySelector('[data-act="copy"]'),btnMove=d.querySelector('[data-act="move"]');
  function refresh(){
    var ready=!!sel&&(sel!=='__new__'||(newInput&&newInput.value.trim()));
    btnCopy.disabled=!ready;btnMove.disabled=!ready;
  }
  d.querySelectorAll('.ws-dialog-item').forEach(function(item){
    item.onclick=function(){
      d.querySelectorAll('.ws-dialog-item').forEach(function(i2){i2.classList.remove('sel')});
      item.classList.add('sel');
      sel=item.getAttribute('data-pid');
      if(sel==='__new__'){
        if(!newInput){
          newInput=document.createElement('input');
          newInput.className='ws-dialog-newname';newInput.type='text';
          newInput.placeholder='新文件夹名称';newInput.maxLength=60;
          newInput.oninput=refresh;
          newInput.onkeydown=function(e){e.stopPropagation()};
          newInput.onclick=function(e){e.stopPropagation()};
          item.after(newInput);
        }
        newInput.style.display='';newInput.focus();
      }else if(newInput){newInput.style.display='none'}
      refresh();
    };
  });
  mask.addEventListener('mousedown',function(e){if(e.target===mask)mask.remove()});
  d.querySelector('[data-act="cancel"]').onclick=function(){mask.remove()};
  async function resolveTarget(){
    if(sel!=='__new__')return sel;
    var name=(newInput&&newInput.value||'').trim();
    if(!name){toast('请输入文件夹名称');return null}
    if(name.length>60){toast('名称过长（最多 60 字）');return null}
    if(_wsIsDefaultName(name))return await wsEnsureDefaultProject();
    var all=await wsGetProjects();
    var ex=all.find(function(p){return p.name===name});
    if(ex)return ex.id;
    var id='proj_'+Date.now();
    await dbPut('projects',{id:id,name:name,created:Date.now(),lastModified:Date.now()});
    return id;
  }
  async function doAct(move){
    var pid=await resolveTarget();if(!pid)return;
    if(pid===fromProjId){toast('目标与当前文件夹相同');return}
    btnCopy.disabled=true;btnMove.disabled=true;
    try{
      var cur=await dbGet('projectFiles',fileId);
      if(!cur){toast('文件不存在');mask.remove();return}
      var destPath=await _wsUniquePath(pid,cur.path);
      var renamed=destPath!==cur.path;
      var now=Date.now();
      var tp=null;try{tp=await dbGet('projects',pid)}catch(e){}
      if(move){
        cur.projectId=pid;cur.path=destPath;cur.lastModified=now;
        await dbPut('projectFiles',cur);
        try{var fp=await dbGet('projects',fromProjId);if(fp){fp.lastModified=now;await dbPut('projects',fp)}}catch(e){}
      }else{
        var nid='pf_'+now+'_'+Math.random().toString(36).slice(2,6);
        await dbPut('projectFiles',{id:nid,projectId:pid,path:destPath,content:cur.content,size:cur.size,created:now,lastModified:now,lastModifiedBy:cur.lastModifiedBy||'AI'});
      }
      if(tp){tp.lastModified=now;await dbPut('projects',tp)}
      toast((move?'已移动到「':'已复制到「')+(tp?tp.name:'目标文件夹')+'」'+(renamed?'，同名已存为 '+destPath:''));
      mask.remove();
      renderWsFiles(fromProjId);
    }catch(e){toast('操作失败：'+String(e&&e.message||e).slice(0,60));mask.remove()}
  }
  btnCopy.onclick=function(){doAct(false)};
  btnMove.onclick=function(){doAct(true)};
}

/* ---- 双挂载：communication.js（_wsArchiveUserUploads/_wsArchiveFileBlocks/_wsPendingReads）与 site-operations.js（_wsPendingOpFeedback）的运行时读写、HTML 内联 onclick（wsPickImport 等）仍经 window 访问；IB.workspace.files 登记导出 ---- */
function ibWsFilesLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._wsIsDefaultName=_wsIsDefaultName;
window._wsIsUserName=_wsIsUserName;
window.wsEnsureDefaultProject=wsEnsureDefaultProject;
window.wsEnsureUserProject=wsEnsureUserProject;
window._wsArchiveUserUploads=_wsArchiveUserUploads;
window.wsGetProjects=wsGetProjects;
window.wsGetFiles=wsGetFiles;
window.wsGetFileByPath=wsGetFileByPath;
window.wsCreateProject=wsCreateProject;
window.wsEnsureProject=wsEnsureProject;
window.wsDeleteProject=wsDeleteProject;
window.wsSaveFile=wsSaveFile;
window._wsUniquePath=_wsUniquePath;
window._wsCountOcc=_wsCountOcc;
window.wsEditFileContent=wsEditFileContent;
window.wsDeleteFile=wsDeleteFile;
window._wsResolveProject=_wsResolveProject;
window._icodeIsText=_icodeIsText;
window._wsPushChatImage=_wsPushChatImage;
window._ibRichNum=_ibRichNum;
window._ibPdfImgPages=_ibPdfImgPages;
window._ibDocxImgMax=_ibDocxImgMax;
window._wsPromptPdfPages=_wsPromptPdfPages;
window.wsPdfPagesToChat=wsPdfPagesToChat;
window.wsDocxImagesToChat=wsDocxImagesToChat;
window._wsResolveIcodeImage=_wsResolveIcodeImage;
window._wsBuildDocxFromMd=_wsBuildDocxFromMd;
window._wsBuildPdfFromHtml=_wsBuildPdfFromHtml;
window._wsCsvParse=_wsCsvParse;
window._wsAoaToSheet=_wsAoaToSheet;
window._wsBuildXlsxFromCsv=_wsBuildXlsxFromCsv;
window._wsExecMakeOp=_wsExecMakeOp;
window._wsRichLoadTextInto=_wsRichLoadTextInto;
window._ibRichLibCatalog=_ibRichLibCatalog;
window._ibRichLibsRefreshCard=_ibRichLibsRefreshCard;
window._ibRichLibsFetchAll=_ibRichLibsFetchAll;
window._ibRichLibsClear=_ibRichLibsClear;
window._ibRichLibsMount=_ibRichLibsMount;
window._icodeZipName=_icodeZipName;
window._icodeIngestZip=_icodeIngestZip;
window._icodeReadAllEntries=_icodeReadAllEntries;
window._icodeFileOf=_icodeFileOf;
window._icodeWalk=_icodeWalk;
window._icodeCollectFlatFiles=_icodeCollectFlatFiles;
window._icodeCollectDrop=_icodeCollectDrop;
window._icodeEmptyToast=_icodeEmptyToast;
window.wsPickImport=wsPickImport;
window._icodeImportFromFiles=_icodeImportFromFiles;
window._icodeShowImportDialog=_icodeShowImportDialog;
window._icodeDoImport=_icodeDoImport;
window.wsRenameProject=wsRenameProject;
window._wsInlineRename=_wsInlineRename;
window.wsRenameCurrentProject=wsRenameCurrentProject;
window.renderWsProjects=renderWsProjects;
window.renderWsFiles=renderWsFiles;
window.wsFileDragStart=wsFileDragStart;
window.wsAttachFileToChat=wsAttachFileToChat;
window.wsDownloadFile=wsDownloadFile;
window.wsConfirmDeleteProject=wsConfirmDeleteProject;
window.wsConfirmDeleteFile=wsConfirmDeleteFile;
window.wsMoveCopyDialog=wsMoveCopyDialog;
ibWsFilesLive('_wsActiveProject', function(){return _wsActiveProject}, function(v){_wsActiveProject=v});
ibWsFilesLive('_wsPendingReads', function(){return _wsPendingReads}, function(v){_wsPendingReads=v});
ibWsFilesLive('_wsPendingOpFeedback', function(){return _wsPendingOpFeedback}, function(v){_wsPendingOpFeedback=v});
ibWsFilesLive('_wsViewingProject', function(){return _wsViewingProject}, function(v){_wsViewingProject=v});
ibWsFilesLive('WS_DEFAULT_PROJ_ID', function(){return WS_DEFAULT_PROJ_ID}, function(v){WS_DEFAULT_PROJ_ID=v});
ibWsFilesLive('WS_USER_PROJ_ID', function(){return WS_USER_PROJ_ID}, function(v){WS_USER_PROJ_ID=v});
ibWsFilesLive('_WS_DEF_NAME_RE', function(){return _WS_DEF_NAME_RE}, function(v){_WS_DEF_NAME_RE=v});
ibWsFilesLive('_WS_USER_NAME_RE', function(){return _WS_USER_NAME_RE}, function(v){_WS_USER_NAME_RE=v});
ibWsFilesLive('WS_ICON', function(){return WS_ICON}, function(v){WS_ICON=v});
ibWsFilesLive('ICODE_IMP', function(){return ICODE_IMP}, function(v){ICODE_IMP=v});
ibWsFilesLive('_ICODE_SKIP_DIRS', function(){return _ICODE_SKIP_DIRS}, function(v){_ICODE_SKIP_DIRS=v});
ibWsFilesLive('_ICODE_TEXT_EXT', function(){return _ICODE_TEXT_EXT}, function(v){_ICODE_TEXT_EXT=v});
ibWsFilesLive('_ICODE_TEXT_NAMES', function(){return _ICODE_TEXT_NAMES}, function(v){_ICODE_TEXT_NAMES=v});
ibWsFilesLive('_WS_DRAG_MIME', function(){return _WS_DRAG_MIME}, function(v){_WS_DRAG_MIME=v});
NS.expose('workspace.files', {
  _wsIsDefaultName: _wsIsDefaultName,
  _wsIsUserName: _wsIsUserName,
  wsEnsureDefaultProject: wsEnsureDefaultProject,
  wsEnsureUserProject: wsEnsureUserProject,
  _wsArchiveUserUploads: _wsArchiveUserUploads,
  wsGetProjects: wsGetProjects,
  wsGetFiles: wsGetFiles,
  wsGetFileByPath: wsGetFileByPath,
  wsCreateProject: wsCreateProject,
  wsEnsureProject: wsEnsureProject,
  wsDeleteProject: wsDeleteProject,
  wsSaveFile: wsSaveFile,
  _wsUniquePath: _wsUniquePath,
  _wsCountOcc: _wsCountOcc,
  wsEditFileContent: wsEditFileContent,
  wsDeleteFile: wsDeleteFile,
  _wsResolveProject: _wsResolveProject,
  _icodeIsText: _icodeIsText,
  _wsPushChatImage: _wsPushChatImage,
  _ibRichNum: _ibRichNum,
  _ibPdfImgPages: _ibPdfImgPages,
  _ibDocxImgMax: _ibDocxImgMax,
  _wsPromptPdfPages: _wsPromptPdfPages,
  wsPdfPagesToChat: wsPdfPagesToChat,
  wsDocxImagesToChat: wsDocxImagesToChat,
  _wsResolveIcodeImage: _wsResolveIcodeImage,
  _wsBuildDocxFromMd: _wsBuildDocxFromMd,
  _wsBuildPdfFromHtml: _wsBuildPdfFromHtml,
  _wsCsvParse: _wsCsvParse,
  _wsAoaToSheet: _wsAoaToSheet,
  _wsBuildXlsxFromCsv: _wsBuildXlsxFromCsv,
  _wsExecMakeOp: _wsExecMakeOp,
  _wsRichLoadTextInto: _wsRichLoadTextInto,
  _ibRichLibCatalog: _ibRichLibCatalog,
  _ibRichLibsRefreshCard: _ibRichLibsRefreshCard,
  _ibRichLibsFetchAll: _ibRichLibsFetchAll,
  _ibRichLibsClear: _ibRichLibsClear,
  _ibRichLibsMount: _ibRichLibsMount,
  _icodeZipName: _icodeZipName,
  _icodeIngestZip: _icodeIngestZip,
  _icodeReadAllEntries: _icodeReadAllEntries,
  _icodeFileOf: _icodeFileOf,
  _icodeWalk: _icodeWalk,
  _icodeCollectFlatFiles: _icodeCollectFlatFiles,
  _icodeCollectDrop: _icodeCollectDrop,
  _icodeEmptyToast: _icodeEmptyToast,
  wsPickImport: wsPickImport,
  _icodeImportFromFiles: _icodeImportFromFiles,
  _icodeShowImportDialog: _icodeShowImportDialog,
  _icodeDoImport: _icodeDoImport,
  wsRenameProject: wsRenameProject,
  _wsInlineRename: _wsInlineRename,
  wsRenameCurrentProject: wsRenameCurrentProject,
  renderWsProjects: renderWsProjects,
  renderWsFiles: renderWsFiles,
  wsFileDragStart: wsFileDragStart,
  wsAttachFileToChat: wsAttachFileToChat,
  wsDownloadFile: wsDownloadFile,
  wsConfirmDeleteProject: wsConfirmDeleteProject,
  wsConfirmDeleteFile: wsConfirmDeleteFile,
  wsMoveCopyDialog: wsMoveCopyDialog,
  _wsActiveProject: _wsActiveProject,
  _wsPendingReads: _wsPendingReads,
  _wsPendingOpFeedback: _wsPendingOpFeedback,
  _wsViewingProject: _wsViewingProject,
  WS_DEFAULT_PROJ_ID: WS_DEFAULT_PROJ_ID,
  WS_USER_PROJ_ID: WS_USER_PROJ_ID,
  _WS_DEF_NAME_RE: _WS_DEF_NAME_RE,
  _WS_USER_NAME_RE: _WS_USER_NAME_RE,
  WS_ICON: WS_ICON,
  ICODE_IMP: ICODE_IMP,
  _ICODE_SKIP_DIRS: _ICODE_SKIP_DIRS,
  _ICODE_TEXT_EXT: _ICODE_TEXT_EXT,
  _ICODE_TEXT_NAMES: _ICODE_TEXT_NAMES,
  _WS_DRAG_MIME: _WS_DRAG_MIME,
});
})(window.IB || (window.IB = {}));
