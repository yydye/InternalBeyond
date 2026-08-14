/* DANGEROUS OPERATIONS */
/* IB 命名空间迁移：IIFE 私有作用域 + 双挂载（window 实时 + IB 注册）。 */
(function(NS){
async function clearAllApiKeys(){
  if(!confirm('⚠ 确定要清除所有 API 密钥吗？\n\nAPI昵称和其他设置会保留，但密钥会被清空。'))return;
  if(typeof _activePrepareAllBackgroundRemoval==='function'&&!(await _activePrepareAllBackgroundRemoval('清除全部 API Key')))return;
  for(const cfg of apiConfigs){cfg.apiKey='';await _persistApiConfig(cfg)}
  /* Also hide editor panel and refresh UI */
  var editor=document.getElementById('api-editor');if(editor)editor.style.display='none';
  await renderApiList();
  try{if(typeof _activeSyncAllBackground==='function'&&_activeCompanionOnline){_activeLastContextSync=0;await _activeSyncAllBackground()}}catch(e){console.warn('[Active Messages] cleared API key sync failed',e)}
  /* Clear all chat panel sessions */
  if(typeof activeFriendId!=='undefined')activeFriendId=null;
  var chatMsgs=document.querySelector('.chat-messages');if(chatMsgs)chatMsgs.innerHTML='';
  var chatName=document.querySelector('.chat-ai-name');if(chatName)chatName.textContent='';
  toast('所有 API 密钥已清除。其他模块中的好友列表将在刷新后更新。');
}
async function resetAllData(){
  if(!confirm('⚠ 这将删除所有数据：日志、聊天记录、信件、API配置、个人资料…\n\n确定要重置吗？'))return;
  if(!confirm('最后确认：此操作不可逆，所有数据将永久丢失。'))return;
  if(typeof _activePrepareAllBackgroundRemoval==='function'&&!(await _activePrepareAllBackgroundRemoval('重置全部数据')))return;
  try{localStorage.setItem('ib_resetAt',String(Date.now()))}catch(e){}/* 主动重置：熔断警告静音 15 分钟 */
  const stores=['posts','categories','about','music','apiSettings','chatMessages','letters','apiConfigs','groups','blogComments','memories','chatThreads','chatSummaries','uploadedFiles','projects','projectFiles','blogAnnotations','active_message_settings','active_message_history','active_message_plans','diary_entries'];
  for(const s of stores){try{const all=await dbGetAll(s);for(const item of all)await dbDelete(s,item.id||item.name)}catch(e){}}
  try{if(typeof _activeSyncAllBackground==='function'&&_activeCompanionOnline){_activeLastContextSync=0;await _activeSyncAllBackground()}}catch(e){}
  try{if(typeof ibExtReset==='function')ibExtReset()}catch(e){}/* 扩展数据（MCP 配置/向量库/白名单等）一并清理 */
  apiConfigs=[];activeFriendId=null;activeThreadId=null;lockedDiaryUnlocked=false;diaryMode=false;activeCat='all';
  toast('所有数据已重置');navTo('home');
}

async function clearChatImages(){
  if(!confirm('⚠ 确定要清除所有聊天记录中的图片？\n\n文字消息会保留，仅删除图片数据。'))return;
  const all=await dbGetAll('chatMessages');let count=0;
  for(const m of all){if(m.images&&m.images.length){delete m.images;await dbPut('chatMessages',m);count++}}
  toast('已清除 '+count+' 条消息中的图片');updateChatStorageInfo();updateDangerStorageInfo();
}
async function clearAllMemories(){
  if(!confirm('⚠ 确定要清空整个记忆库？\n\n所有记忆将被永久删除。'))return;
  const all=await dbGetAll('memories');for(const m of all){await dbDelete('memories',m.id)}
  toast('记忆库已清空');if(typeof renderMemories==='function')renderMemories();/* fix: 原函数名 renderMemoryList 早已改名，守卫使其成为死代码，清空后列表不刷新 */updateDangerStorageInfo();
}
async function clearAllLetters(){
  if(!confirm('⚠ 确定要清空所有信件？'))return;
  const all=await dbGetAll('letters');for(const l of all){await dbDelete('letters',l.id)}
  toast('所有信件已清空');updateDangerStorageInfo();
}
async function clearAllSummaries(){
  if(!confirm('⚠ 确定要清除所有对话摘要缓存？\n\n下次聊天时会自动重新生成。'))return;
  try{const all=await dbGetAll('chatSummaries');for(const s of all){await dbDelete('chatSummaries',s.id)}}catch(e){}
  toast('对话摘要已清除');updateDangerStorageInfo();
}
async function clearUploadedFiles(){
  if(!confirm('⚠ 确定要清除所有上传的文件缓存？'))return;
  try{const all=await dbGetAll('uploadedFiles');for(const f of all){await dbDelete('uploadedFiles',f.id)}}catch(e){}
  toast('上传文件缓存已清除');updateDangerStorageInfo();
}


/* Build website context for AI — lets AI "see" the site content */
const _WS_INSTR_BLOCK='\n\n【ICode 工作区指令】当用户需要你生成、编辑、翻译文件或代码时，用工作区完成（每步操作会在聊天中渲染为操作卡片，用户可在工作区悬浮窗中预览和下载）：\n<ws_project name="项目名"/> 创建或选定项目（仅当用户明确要求建立/使用某个具名项目时才输出；零散文件直接写 ws_create 即可，会自动存入默认文件夹「ICode」，不要为默认文件夹输出本指令。用户在聊天中上传的文件都自动归档在「User」文件夹，需要读取或修改上传文件时，先写 <ws_project name="User"/> 选定它）\n<ws_create path="文件名.ext">\n文件完整内容\n</ws_create>\n（ws_create 语义是"新建"：路径与已有文件重名时不会覆盖旧文件，系统会自动改存为「名 (2).ext」并告知你；确要整份改写既有文件时写 <ws_create path="文件名.ext" overwrite="true">，小改动优先用 ws_edit）\n<ws_edit path="文件名.ext">\n<find>要替换的旧内容（必须与文件最新原文逐字一致，选取短小且唯一的片段）</find>\n<replace>替换后的新内容</replace>\n</ws_edit>\n<ws_read path="文件名.ext"/> 请求读取文件；内容会在用户下一条消息时注入给你，请提示用户点击"继续"\n<ws_run lang="python" entry="文件名.py"/> 或 <ws_run lang="js">\n代码\n</ws_run> 在用户浏览器的本地沙箱里运行脚本（lang 支持 python / js）。运行时可读取当前选定项目里的全部文本文件——Python 的工作目录就是项目目录、可直接 import 同项目模块；脚本新建或修改的文件会自动写回项目（同名直接覆盖，适合游戏存档等场景）。请用 print / console.log 打印你需要看到的内容，输出与报错会在之后的消息注入给你。限制：脚本内无网络访问；默认超时 20 秒（可加 timeout="秒" 属性，上限 120）。Python 支持科学计算包：入口/内联代码里 import numpy、pandas、matplotlib、scipy、sympy 等会自动从官方源加载（首次需联网下载、稍慢，请耐心等待）；matplotlib 画的图会自动出现在聊天的运行卡片里并回传说明给你（无需 plt.show，也不必存文件）；其他纯 Python 第三方包可加 pip="包名,包名" 属性安装，但仅限用户白名单（DIY 页·沙箱扩展）内的包，不在白名单会拒绝运行。注意：用户可能开启"运行前询问"——脚本会先变成待运行卡，等用户点击运行后你才会在之后的消息收到输出，这种情况请耐心等待、不要重复提交同一脚本。\n<ws_make_docx path=\"文件名.docx\">\n文档内容\n</ws_make_docx> 生成真实 Word 文档并存入当前项目（用户可预览、下载、在 Word/WPS 里继续编辑）。内容用 Markdown 子集书写：# ## ### 标题、空行分段、**加粗**、- 无序列表、|A|B| 表格（首行表头，次行可写 |---|---| 分隔线）、![说明](图片路径) 插入本工作区中的图片。\n<ws_make_pdf path=\"文件名.pdf\">\n完整 HTML 片段（可含 <style> 与内联样式）\n</ws_make_pdf> 生成 PDF 存入当前项目：系统按 A4 纸宽渲染 HTML 后逐页转为图像合成，所见即所得、可图文混排（img 的 src 写工作区图片路径即可，会自动替换为真实数据）。注意成品文字不可选中、体积偏大；纯文字长文档优先用 ws_make_docx。样式用常规 CSS，不要引用外部网络资源，单次控制在 25 页以内。\n<ws_make_xlsx path=\"文件名.xlsx\">\n【表:工作表名】\nCSV 行…\n</ws_make_xlsx> 生成真实 Excel：单元格用英文逗号分隔，含逗号/引号/换行的单元格用双引号包裹，以 = 开头的单元格视为公式；多个【表:名】块生成多个工作表（仅一个表时可省略【表:】行）；不支持设置颜色与字体样式。三个生成指令的解析库需用户在 DIY 页「文件解析库」开启后获取，未就绪时会执行失败并把原因反馈给你。\nws_read 补充：对 PDF/DOCX/XLSX/XLS/PPTX/EPUB/RTF 会自动注入提取的纯文本（无文字层的扫描件 PDF 除外，此时请建议用户在 ICode 预览用「以图片发送」）；超长文件可加 from=\"起始字符序号\" chars=\"本次读取字符数\" 分段读取，注入头会标明范围与全文长度；ws_edit 对这些格式无效。\n要点：标签必须完整闭合，属性值用英文双引号；标签直接写在正文里，不要包进 markdown 代码块；长文件可放心用 ws_create 一次性输出完整内容，输出触及长度上限时系统会自动续写拼接；ws_edit 的 <find> 必须逐字复制自文件最新内容、且在文件中唯一，若操作失败，失败原因会在下一条消息反馈给你，请先 <ws_read> 再重试；自然语言说明写在标签外面。\n【重要】只有上述标签会被系统真实执行。绝对不要只在文字里说"已创建/已保存/已生成"——没有标签就没有任何文件被创建，系统会检测到并要求你重做。历史消息中形如"[系统归档：…]"的占位符是系统对旧内容的压缩记录，不是输出格式，禁止模仿输出。';
var _siteCtxLastHash='';/* 跟踪上次注入的 profile 内容哈希：内容变了就重新全量注入 */
/* 图像生成指令块：按好友开关注入 system prompt（与思考链同模式——切换重建一次缓存后恢复稳定命中） */
const _IMGGEN_INSTR_BLOCK='\n\n【图像生成】本对话已开启图像生成能力。当用户希望你画图/生成图片时，输出：\n<ws_gen_image prompt="画面的完整描述" size="1024x1024"/>\n规则：prompt 写清晰具体的画面描述（主体、风格、构图、光线、色调等，中英文皆可）；size 可选且仅支持枚举值 1024x1024、1536x1024、1024x1536（不写则用默认——生图接口不接受 200x200 之类的任意尺寸，用户要小图时请照常按默认尺寸生成，并说明图片可自行缩放使用）；描述很长时也可写成 <ws_gen_image>描述…</ws_gen_image> 的正文形式；每条回复最多 1 个生图标签。生成的图片会直接显示在聊天中并自动存入 ICode，生成结果会在之后的消息回传给你。不要在文字里假装已生成——没有标签就没有图片。';
async function buildSiteContext(){
  try{
    const about=await dbGet('about','main');
    const lim=await getReadingLimits();
    const posts=await dbGetAll('posts');
    const recentPosts=posts.filter(p=>!isLockedPost(p)).sort((a,b)=>b.created-a.created).slice(0,lim.postsLimit);
    /* 缓存优化：时间戳移至末条用户消息注入（_tailCtx），此处只保留会话内稳定的内容 */
    let ctx='[网站上下文（系统参考，勿复述此段内容）] 你正在 Internal Beyond 个人网站中与用户对话。';
    if(about){
      ctx+='\n\n【对方的个人资料】';
      ctx+='\n昵称：'+about.name;
      if(about.bio)ctx+='\n简介：'+about.bio.slice(0,300);
      ctx+='\n（以上为对方的个人资料。）';
    }
    if(recentPosts.length){
      ctx+='\n\n【用户最近写的日志】';
      recentPosts.forEach(p=>{ctx+='\n'+(p.title||'无标题')+'：'+p.content.slice(0,60)+'…'});
    }
    ctx+='\n\n【文件输出能力】只有当用户要的是一小段（50行以内）可直接保存的纯文本时，才用如下格式在聊天里直接输出下载卡片：\n```file:文件名.扩展名\n文件内容\n```\n更长的文件、代码项目、需要后续修改的内容，一律改用工作区指令。';
    /* 工作区指令单独拼接，不参与截断 */
    let wsBlock=_WS_INSTR_BLOCK;
    /* 外部工具指令：本地 Webhook（启用且有配置时）与 MCP 服务器工具（IBMCP，独立开关）合并注入 */
    try{
      const tcfg=await getIbTools();
      var _mcpPB='';try{if(typeof IBMCP!=='undefined')_mcpPB=IBMCP.promptBlock()}catch(e){}
      var _bridgePB='';try{if(typeof IBNET!=='undefined')_bridgePB=IBNET.promptBlock()}catch(e){}
      const _locOn=tcfg.enabled&&(tcfg.tools||[]).length;
      if(_locOn||_mcpPB||_bridgePB){
        var _cfNeed=(_locOn&&tcfg.confirm)||(_mcpPB&&IBMCP.cfg().confirm!==false)||(_bridgePB&&IBNET.cfg().confirmTools!==false);
        wsBlock+='\n\n【外部工具】用户配置了以下可调用的外部工具。需要执行用户接入的外部操作时输出：\n<ws_tool name="工具名" args=\'{"参数":"值"}\'/>\n规则：name 必须与下方列表完全一致（mcp. 开头的是 MCP 服务器工具，用同一个标签调用）；args 是单行 JSON（无参数时省略整个 args 属性；参数较长时也可写成 <ws_tool name="工具名">{JSON}</ws_tool> 的形式）；只能调用列表内的工具，不要虚构工具名；调用结果会在之后的消息注入给你'+(_cfNeed?'；用户开启了调用前确认——提交后请等待结果回传，不要重复提交同一调用':'')+'。\n可用工具：';
        if(_locOn)tcfg.tools.forEach(function(t){wsBlock+='\n- '+t.name+(t.desc?'：'+t.desc:'')+(t.params?'（参数：'+t.params+'）':'（无参数）')});
        if(_mcpPB)wsBlock+='\n'+_mcpPB;
        if(_bridgePB)wsBlock+='\n'+_bridgePB;
      }
    }catch(e){}
    return truncateContext(ctx,Math.max(2000,8000-wsBlock.length))+wsBlock;
  }catch(e){return ''}
}


/* ── 外部工具设置页 UI ── */
var _ibToolEditingId=null;
async function renderIbToolsList(){
  const cfg=await getIbTools();
  const en=document.getElementById('ibtools-enabled');if(en)en.checked=!!cfg.enabled;
  const cf=document.getElementById('ibtools-confirm');if(cf)cf.checked=cfg.confirm!==false;
  const c=document.getElementById('ibtools-list');if(!c)return;
  if(!(cfg.tools||[]).length){c.innerHTML='<div style="font-size:0.78rem;color:var(--text-muted);opacity:0.7;padding:4px 0">还没有配置工具</div>';return}
  c.innerHTML=cfg.tools.map(function(t){
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--glass-border)">'
      +'<div style="flex:1;min-width:0"><div style="font-size:0.86rem;font-weight:500">'+esc(t.name)+'</div>'
      +'<div style="font-size:0.72rem;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((t.method||'GET')+' · '+t.url)+(t.desc?' · '+esc(t.desc):'')+'</div></div>'
      +'<button class="btn" style="font-size:0.72rem;padding:4px 10px" onclick="ibToolTest(\''+t.id+'\')">测试</button>'
      +'<button class="btn" style="font-size:0.72rem;padding:4px 10px" onclick="ibToolOpenEditor(\''+t.id+'\')">编辑</button>'
      +'<button class="btn" style="font-size:0.72rem;padding:4px 10px;color:#e88" onclick="ibToolDelete(\''+t.id+'\')">删除</button>'
      +'</div>';
  }).join('');
}
async function ibToolsSaveSwitches(){
  const cfg=await getIbTools();
  cfg.enabled=!!document.getElementById('ibtools-enabled')?.checked;
  cfg.confirm=!!document.getElementById('ibtools-confirm')?.checked;
  await saveIbTools(cfg);
  toast(cfg.enabled?'外部工具已启用':'外部工具已关闭');
}
async function ibToolOpenEditor(id){
  const cfg=await getIbTools();
  const t=id?(cfg.tools||[]).find(function(x){return x.id===id}):null;
  _ibToolEditingId=t?t.id:null;
  document.getElementById('ibtool-name').value=t?t.name:'';
  document.getElementById('ibtool-desc').value=t?(t.desc||''):'';
  document.getElementById('ibtool-params').value=t?(t.params||''):'';
  document.getElementById('ibtool-method').value=t?(t.method||'POST'):'POST';
  document.getElementById('ibtool-url').value=t?(t.url||''):'';
  document.getElementById('ibtool-headers').value=t?(t.headers||''):'';
  document.getElementById('ibtool-body').value=t?(t.body||''):'';
  const ed=document.getElementById('ibtools-editor');ed.style.display='block';
  ed.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function ibToolCancelEdit(){_ibToolEditingId=null;document.getElementById('ibtools-editor').style.display='none'}
async function ibToolSave(){
  const name=document.getElementById('ibtool-name').value.trim();
  const url=document.getElementById('ibtool-url').value.trim();
  if(!name){toast('请填写工具名');return}
  if(!/^https?:\/\//i.test(url)){toast('URL 必须以 http:// 或 https:// 开头');return}
  const headers=document.getElementById('ibtool-headers').value.trim();
  if(headers){try{JSON.parse(headers.replace(/\{\{\s*[\w.-]+\s*\}\}/g,'0'))}catch(e){toast('Headers 不是合法 JSON');return}}
  const cfg=await getIbTools();
  cfg.tools=cfg.tools||[];
  /* 工具名唯一：AI 按名字调用 */
  if(cfg.tools.some(function(t){return t.name===name&&t.id!==_ibToolEditingId})){toast('已有同名工具');return}
  const data={
    id:_ibToolEditingId||('ibtool_'+Date.now()),
    name:name,
    desc:document.getElementById('ibtool-desc').value.trim(),
    params:document.getElementById('ibtool-params').value.trim(),
    method:document.getElementById('ibtool-method').value,
    url:url,
    headers:headers,
    body:document.getElementById('ibtool-body').value.trim()
  };
  const idx=cfg.tools.findIndex(function(t){return t.id===data.id});
  if(idx>=0)cfg.tools[idx]=data;else cfg.tools.push(data);
  await saveIbTools(cfg);
  ibToolCancelEdit();
  renderIbToolsList();
  toast('工具已保存');
}
async function ibToolDelete(id){
  if(!confirm('删除这个工具？'))return;
  const cfg=await getIbTools();
  cfg.tools=(cfg.tools||[]).filter(function(t){return t.id!==id});
  await saveIbTools(cfg);
  renderIbToolsList();
  toast('已删除');
}
/* 测试：用空 args 直接发一次请求，结果 toast 提示（不回传给 AI） */
async function ibToolTest(id){
  const cfg=await getIbTools();
  const t=(cfg.tools||[]).find(function(x){return x.id===id});
  if(!t)return;
  toast('正在测试「'+t.name+'」…');
  const r=await _ibToolFetch(t,{});
  toast((r.ok?'测试成功：':'测试失败：')+String(r.detail||'').slice(0,120));
}

/* ══════════ 外部工具（ws_tool）══════════ */
var _ibToolsCache=null;
var _ibToolPendingResults=[];/* 待注入的工具调用结果 */
var _ibToolDrainImages=[];/* 视觉回注：随文本一同出队的工具图片（下次发送时并入图像块，上限4张） */
async function getIbTools(){
  if(_ibToolsCache)return _ibToolsCache;
  try{
    const r=await dbGet('apiSettings','ibTools');
    _ibToolsCache=(r&&Array.isArray(r.tools))?r:{id:'ibTools',enabled:false,confirm:true,tools:[]};
  }catch(e){_ibToolsCache={id:'ibTools',enabled:false,confirm:true,tools:[]}}
  if(_ibToolsCache.confirm===undefined)_ibToolsCache.confirm=true;
  return _ibToolsCache;
}
async function saveIbTools(cfg){_ibToolsCache=cfg;await dbPut('apiSettings',cfg)}
/* 模板变量替换：{{key}} → args[key]。encode=true 时（URL）对值做 URI 编码 */
function _ibToolFill(tpl,args,encode){
  return String(tpl||'').replace(/\{\{\s*([\w.-]+)\s*\}\}/g,function(mm,k){
    var v=args&&args[k]!==undefined?args[k]:'';
    if(typeof v==='object')v=JSON.stringify(v);
    v=String(v);
    return encode?encodeURIComponent(v):v;
  });
}
/* 发出 HTTP 请求：15 秒超时；返回 {ok,status,detail}。detail 为回传给 AI 的摘要文本 */
async function _ibToolFetch(tool,args){
  var url=_ibToolFill(tool.url,args,true);
  if(!/^https?:\/\//i.test(url))return{ok:false,detail:'URL 必须以 http:// 或 https:// 开头'};
  var method=(tool.method||'GET').toUpperCase();
  var headers={};
  if(tool.headers&&tool.headers.trim()){
    try{headers=JSON.parse(_ibToolFill(tool.headers,args,false))}
    catch(e){return{ok:false,detail:'Headers 配置不是合法 JSON'}}
  }
  var body;
  if(method!=='GET'&&method!=='HEAD'){
    if(tool.body&&tool.body.trim())body=_ibToolFill(tool.body,args,false);
    else if(args&&Object.keys(args).length)body=JSON.stringify(args);/* 无模板时直接把 args 作为请求体 */
    var hasCT=Object.keys(headers).some(function(k){return k.toLowerCase()==='content-type'});
    if(body&&!hasCT)headers['Content-Type']='application/json';
  }
  var ctrl=new AbortController();
  var tm=setTimeout(function(){ctrl.abort()},15000);
  try{
    var resp=await fetch(url,{method:method,headers:headers,body:body,signal:ctrl.signal});
    clearTimeout(tm);
    var txt='';try{txt=await resp.text()}catch(e2){}
    return{ok:resp.ok,status:resp.status,detail:'HTTP '+resp.status+(txt?' · '+txt.slice(0,600):'')};
  }catch(e){
    clearTimeout(tm);
    var msg=(e&&e.name==='AbortError')?'请求超时（15秒）':String(e&&e.message||e);
    if(/Failed to fetch/i.test(msg))msg='无法连接（目标不可达，或被浏览器 CORS/混合内容策略拦截）';
    return{ok:false,detail:msg};
  }
}
function _ibQueueToolResult(author,name,ok,detail){
  _ibToolPendingResults.push({actor:author,images:[],text:'- 工具「'+name+'」：'+(ok?'成功':'失败')+(detail?' · '+String(detail).slice(0,700):'')});
}
/* 执行一次 ws_tool 操作，返回结果对象（渲染层据此出卡片） */
async function _ibExecToolOp(op,author){
  /* FC 原生通道已执行（fc="1"）：从台账取结果填卡，不再执行、不再排队注入 */
  if(op.fc&&typeof IBFC!=='undefined'){
    var _led=IBFC.ledgerGetByOp(op);
    if(_led)return{type:'tool',name:op.name||'',ok:!!_led.ok,fed:true,args:String(op.args||''),response:_led.ok?(_led.response||''):((_led.reason||'')+(_led.response?' · '+_led.response:'')),images:_led.images||[],reason:_led.ok?'':String(_led.reason||'').slice(0,120)};
    return{type:'tool',name:op.name||'',ok:false,fed:true,reason:'FC 台账缺失（页面可能已刷新），结果不可恢复',args:String(op.args||'')};
  }
  /* Internal Bridge 工具（bridge.工具名）：走 WebSocket RPC，独立于本地 Webhook/MCP 开关 */
  if(typeof IBNET!=='undefined'&&/^bridge\./.test(String(op.name||''))){
    if(op.truncated)return{type:'tool',name:op.name||'',ok:false,reason:'输出被截断，未执行；请完整重发'};
    var _bArgsRaw=String(op.args||'').trim(),_bArgs={};
    if(_bArgsRaw){try{_bArgs=JSON.parse(_bArgsRaw)}catch(e){return{type:'tool',name:op.name,ok:false,reason:'args 不是合法 JSON'}}}
    if(IBNET.confirmRequired(op.name)){
      _wsPendingOpFeedback.push({actor:author,text:'后端工具「'+op.name+'」调用请求已生成，等待用户确认。用户点击"执行"后，结果会在之后的消息回传给你——请等待，不要重复提交。'});
      return{type:'tool',name:op.name,ok:true,pendingConfirm:true,args:_bArgsRaw,author:author};
    }
    var _br=await IBNET.execOp(op.name,_bArgs);
    var _bDet=_br.ok?(_br.response||''):((_br.reason||'')+(_br.response?' · '+_br.response:''));
    _ibToolPendingResults.push({actor:author,images:(_br&&_br.images)||[],text:'- 工具「'+op.name+'」：'+(_br.ok?'成功':'失败')+(_bDet?' · '+String(_bDet).slice(0,4000):'')});
    return{type:'tool',name:op.name,ok:_br.ok,fed:true,args:_bArgsRaw,response:_bDet,images:_br.images||[],reason:_br.ok?'':String(_br.reason||'').slice(0,120)};
  }
  /* MCP 工具（mcp.别名.工具名）：走 IBMCP 通道，独立于本地 Webhook 开关 */
  if(typeof IBMCP!=='undefined'&&/^mcp\./.test(String(op.name||''))){
    if(op.truncated)return{type:'tool',name:op.name||'',ok:false,reason:'输出被截断，未执行；请完整重发'};
    var _mArgsRaw=String(op.args||'').trim(),_mArgs={};
    if(_mArgsRaw){try{_mArgs=JSON.parse(_mArgsRaw)}catch(e){return{type:'tool',name:op.name,ok:false,reason:'args 不是合法 JSON'}}}
    if(IBMCP.cfg().confirm!==false){
      _wsPendingOpFeedback.push({actor:author,text:'工具「'+op.name+'」调用请求已生成，等待用户确认（用户开启了调用前询问）。用户点击"执行"后，结果会在之后的消息回传给你——请耐心等待，不要重复提交。'});
      return{type:'tool',name:op.name,ok:true,pendingConfirm:true,args:_mArgsRaw,author:author};
    }
    var _mr=await IBMCP.execOp(op.name,_mArgs);
    var _mDet=_mr.ok?(_mr.response||''):((_mr.reason||'')+(_mr.response?' · '+_mr.response:''));
    _ibToolPendingResults.push({actor:author,images:(_mr&&_mr.images)||[],text:'- 工具「'+op.name+'」：'+(_mr.ok?'成功':'失败')+(_mDet?' · '+String(_mDet).slice(0,4000):'')});
    return{type:'tool',name:op.name,ok:_mr.ok,fed:true,args:_mArgsRaw,response:_mDet,images:_mr.images||[],reason:_mr.ok?'':String(_mr.reason||'').slice(0,120)};
  }
  var cfg=await getIbTools();
  if(!cfg.enabled)return{type:'tool',name:op.name||'',ok:false,reason:'外部工具功能未启用（API 设置页可开启）'};
  if(op.truncated)return{type:'tool',name:op.name||'',ok:false,reason:'输出被截断，未执行；请完整重发'};
  if(!op.name)return{type:'tool',name:'',ok:false,reason:'缺少工具名（name 属性为空或无法解析）'};
  var tool=(cfg.tools||[]).find(function(t){return t.name===op.name})
        ||(cfg.tools||[]).find(function(t){return t.name.toLowerCase()===String(op.name).toLowerCase()});
  if(!tool)return{type:'tool',name:op.name,ok:false,reason:'未找到该工具（名称须与配置完全一致）'};
  var rawArgs=String(op.args||'').trim(),args={};
  if(rawArgs){
    try{args=JSON.parse(rawArgs)}
    catch(e){return{type:'tool',name:op.name,ok:false,reason:'args 不是合法 JSON'}}
  }
  if(cfg.confirm){
    /* 询问模式：出待执行卡，先告知 AI 等待，避免重复提交 */
    _wsPendingOpFeedback.push({actor:author,text:'工具「'+op.name+'」调用请求已生成，等待用户确认（用户开启了调用前询问）。用户点击"执行"后，结果会在之后的消息回传给你——请耐心等待，不要重复提交。'});
    return{type:'tool',name:op.name,ok:true,pendingConfirm:true,args:rawArgs,author:author};
  }
  var r=await _ibToolFetch(tool,args);
  _ibQueueToolResult(author,op.name,r.ok,r.detail);
  return{type:'tool',name:op.name,ok:r.ok,fed:true,args:rawArgs,response:r.detail,reason:r.ok?'':String(r.detail||'').slice(0,120)};
}
/* 待执行卡的「执行」按钮 */
async function _ibConfirmToolFromCard(btn,ctx,card){
  btn.disabled=true;btn.textContent='执行中…';
  var args={};
  if(ctx.args){try{args=JSON.parse(ctx.args)}catch(e){}}
  var r;
  if(typeof IBNET!=='undefined'&&/^bridge\./.test(String(ctx.name||''))){
    var _br=await IBNET.execOp(ctx.name,args);
    r={ok:_br.ok,detail:_br.ok?(_br.response||''):((_br.reason||'')+(_br.response?' · '+_br.response:'')),images:_br.images||[]};
    _ibToolPendingResults.push({actor:ctx.author,images:(r&&r.images)||[],text:'- 工具「'+ctx.name+'」：'+(r.ok?'成功':'失败')+(r.detail?' · '+String(r.detail).slice(0,4000):'')});
  }else if(typeof IBMCP!=='undefined'&&/^mcp\./.test(String(ctx.name||''))){
    var _mr=await IBMCP.execOp(ctx.name,args);
    r={ok:_mr.ok,detail:_mr.ok?(_mr.response||''):((_mr.reason||'')+(_mr.response?' · '+_mr.response:'')),images:_mr.images||[]};
    _ibToolPendingResults.push({actor:ctx.author,images:(r&&r.images)||[],text:'- 工具「'+ctx.name+'」：'+(r.ok?'成功':'失败')+(r.detail?' · '+String(r.detail).slice(0,4000):'')});
  }else{
    var cfg=await getIbTools();
    var tool=(cfg.tools||[]).find(function(t){return t.name===ctx.name});
    if(!tool){toast('工具不存在或已删除');btn.disabled=false;btn.textContent='执行';return}
    r=await _ibToolFetch(tool,args);
    _ibQueueToolResult(ctx.author,ctx.name,r.ok,r.detail);
  }
  btn.remove();
  var t=card.querySelector('.ws-op-text');
  if(t)t.innerHTML=esc(r.ok?'工具调用完成':'工具调用失败')+' · <b>'+esc(ctx.name)+'</b>';
  if(!r.ok)card.classList.add('fail');
  var det=card.querySelector('.ws-op-detail');
  if(det){
    var o=document.createElement('div');o.className='ws-run-out';
    o.textContent=r.detail||'（无返回内容）';
    det.appendChild(o);
    if(r.images&&r.images.length&&typeof IBSandbox!=='undefined'){var _iw=document.createElement('div');_iw.innerHTML=IBSandbox.imagesRow(r.images);if(_iw.firstChild)det.appendChild(_iw.firstChild)}
    card.classList.add('expanded');
  }
  toast(r.ok?'工具调用完成，结果将在下一条消息回传给 AI':'工具调用失败，失败信息将回传给 AI');
}
function _getIbToolResultInjection(filterFn){
  if(!_ibToolPendingResults.length)return'';
  var take,keep=[];
  if(typeof filterFn==='function'){take=[];_ibToolPendingResults.forEach(function(it){(filterFn(it)?take:keep).push(it)})}
  else{take=_ibToolPendingResults}
  _ibToolPendingResults=keep;
  if(!take.length)return'';
  try{take.forEach(function(s2){(s2.images||[]).forEach(function(u){if(_ibToolDrainImages.length<4)_ibToolDrainImages.push(u)})})}catch(e){}
  var ctx='\n\n【工具调用结果】此前发起的外部工具调用已执行完毕，结果如下（据此答复用户；失败请核对工具名与 args 后可重试）：';
  take.forEach(function(s2){ctx+='\n'+s2.text});
  return ctx;
}

/* ══════════════════ IB-EXT 扩展模块包(MCP/FC/沙箱) ══════════════════ */

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB 命名空间登记导出 ---- */
function ibOpsLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.clearAllApiKeys=clearAllApiKeys;
window.resetAllData=resetAllData;
window.clearChatImages=clearChatImages;
window.clearAllMemories=clearAllMemories;
window.clearAllLetters=clearAllLetters;
window.clearAllSummaries=clearAllSummaries;
window.clearUploadedFiles=clearUploadedFiles;
window.buildSiteContext=buildSiteContext;
window.renderIbToolsList=renderIbToolsList;
window.ibToolsSaveSwitches=ibToolsSaveSwitches;
window.ibToolOpenEditor=ibToolOpenEditor;
window.ibToolCancelEdit=ibToolCancelEdit;
window.ibToolSave=ibToolSave;
window.ibToolDelete=ibToolDelete;
window.ibToolTest=ibToolTest;
window.getIbTools=getIbTools;
window.saveIbTools=saveIbTools;
window._ibToolFill=_ibToolFill;
window._ibToolFetch=_ibToolFetch;
window._ibQueueToolResult=_ibQueueToolResult;
window._ibExecToolOp=_ibExecToolOp;
window._ibConfirmToolFromCard=_ibConfirmToolFromCard;
window._getIbToolResultInjection=_getIbToolResultInjection;
window._WS_INSTR_BLOCK=_WS_INSTR_BLOCK;
window._IMGGEN_INSTR_BLOCK=_IMGGEN_INSTR_BLOCK;
/* 可变状态：getter/setter 转发 IIFE 局部绑定，外部读写保持实时（_ibToolPendingResults 会被重新赋值） */
ibOpsLive('_ibToolsCache', function(){return _ibToolsCache}, function(v){_ibToolsCache=v});
ibOpsLive('_ibToolPendingResults', function(){return _ibToolPendingResults}, function(v){_ibToolPendingResults=v});
ibOpsLive('_ibToolDrainImages', function(){return _ibToolDrainImages}, function(v){_ibToolDrainImages=v});
ibOpsLive('_siteCtxLastHash', function(){return _siteCtxLastHash}, function(v){_siteCtxLastHash=v});
ibOpsLive('_ibToolEditingId', function(){return _ibToolEditingId}, function(v){_ibToolEditingId=v});
NS.expose('ops', {
  clearAllApiKeys: clearAllApiKeys,
  resetAllData: resetAllData,
  clearChatImages: clearChatImages,
  clearAllMemories: clearAllMemories,
  clearAllLetters: clearAllLetters,
  clearAllSummaries: clearAllSummaries,
  clearUploadedFiles: clearUploadedFiles,
  buildSiteContext: buildSiteContext,
  renderIbToolsList: renderIbToolsList,
  ibToolOpenEditor: ibToolOpenEditor,
  ibToolCancelEdit: ibToolCancelEdit,
  ibToolSave: ibToolSave,
  ibToolDelete: ibToolDelete,
  ibToolTest: ibToolTest,
  getIbTools: getIbTools,
  saveIbTools: saveIbTools,
  _getIbToolResultInjection: _getIbToolResultInjection,
  _WS_INSTR_BLOCK: _WS_INSTR_BLOCK,
  _IMGGEN_INSTR_BLOCK: _IMGGEN_INSTR_BLOCK
});
})(window.IB || (window.IB = {}));
