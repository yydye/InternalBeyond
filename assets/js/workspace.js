/* ====================== WORKSPACE SYSTEM ====================== */
/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.workspace 注册）。 */
(function(NS){
/* ── Parse workspace ops from AI response ──
   基于 _segmentAiText 的按位置扫描：多项目/多操作严格按出现顺序执行，
   修复旧版"按类型分组解析"导致的跨项目操作错位问题 */
function _parseWsOps(text){
  var segs=_segmentAiText(text||'');
  var ops=[],files=[],clean='';
  segs.forEach(function(s){
    if(s.type==='text')clean+=(clean?'\n\n':'')+s.text;
    else if(s.type==='file'){clean+=(clean?'\n\n':'')+'```file:'+s.name+'\n'+s.content+'\n```';files.push({path:(s.name||'').trim(),content:s.content||'',truncated:!!s.truncated})}
    else ops.push(s.op);
  });
  return{cleanText:clean,ops:ops,files:files};
}


/* ── ```file: 下载块自动归档：聊天里的下载卡照旧，同时把文件存入默认文件夹「ICode」，
   让 AI 生成的所有文件都能在 ICode 里找到（仅实时回复调用一次，历史渲染不会重复入库） ── */
async function _wsArchiveFileBlocks(files,author){
  if(!files||!files.length)return;
  try{
    var pid=await wsEnsureDefaultProject();
    for(var i=0;i<files.length;i++){
      var f=files[i];
      if(!f||!f.path||!f.content||!f.content.trim())continue;
      /* 归档撞名且旧文件出自用户手改（你）或导入 → 不覆盖，改存新名； */
      var dest=f.path;
      try{
        var old=await wsGetFileByPath(pid,f.path);
        if(old&&(old.lastModifiedBy==='User'||old.lastModifiedBy==='你'||old.lastModifiedBy==='导入'))dest=await _wsUniquePath(pid,f.path);
      }catch(e2){}
      await wsSaveFile(pid,dest,f.content,author||'AI');
    }
  }catch(e){}
}

/* ── 图像生成执行器：按好友配置调用生图接口，成功返回 dataUrl/base64 ──
   OpenAI 兼容（官方/中转站）走 /images/generations；Gemini 走 generateContent + responseModalities；
   用量（若接口回传）按生图模型名计入 Token 仪表盘，单价可在仪表盘中为该模型单独设置 */
async function _wsExecImageGen(cfg,prompt,size){
  var model=(cfg.imageGenModel||'').trim()||(cfg.provider==='gemini'?'gemini-2.5-flash-image':'gpt-image-1');
  var ctrl=new AbortController();var _tm=setTimeout(function(){try{ctrl.abort()}catch(e){}},120000);
  try{
    if(cfg.provider==='anthropic'||cfg.provider==='deepseek'){
      return{ok:false,reason:(cfg.provider==='anthropic'?'Anthropic':'DeepSeek')+' 接口不提供图像生成；请在 OpenAI 兼容或 Gemini 的 API 配置上开启此功能'};
    }
    var b64='',mime='image/png';
    if(cfg.provider==='gemini'){
      var gUrl=cfg.endpoint||'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
      if(gUrl.indexOf('{model}')!==-1)gUrl=gUrl.replace('{model}',model);
      else if(/models\/[^:\/?]+:generateContent/i.test(gUrl))gUrl=gUrl.replace(/models\/[^:\/?]+:generateContent/i,'models/'+model+':generateContent');
      else{try{gUrl=new URL(gUrl).origin+'/v1beta/models/'+model+':generateContent'}catch(e){gUrl='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent'}}
      gUrl+=(gUrl.indexOf('?')===-1?'?':'&')+'key='+cfg.apiKey;
      var gRes=await fetch(gUrl,{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,
        body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:['TEXT','IMAGE']}})});
      var gj=await gRes.json().catch(function(){return{}});
      if(!gRes.ok)return{ok:false,reason:'Gemini 生图请求失败（'+gRes.status+'）'+String((gj.error&&gj.error.message)||'').slice(0,160)};
      var _gParts=(gj.candidates&&gj.candidates[0]&&gj.candidates[0].content&&gj.candidates[0].content.parts)||[];
      for(var pi=0;pi<_gParts.length;pi++){var _pd=_gParts[pi].inlineData||_gParts[pi].inline_data;if(_pd&&_pd.data){b64=_pd.data;mime=_pd.mimeType||_pd.mime_type||'image/png';break}}
      if(!b64)return{ok:false,reason:'Gemini 未返回图像数据：该模型可能不支持图像输出，请在 API 设置中把生图模型改为 gemini-2.5-flash-image 等生图型号'};
      try{if(gj.usageMetadata)_tkRecord(Object.assign({},cfg,{model:model}),{i:gj.usageMetadata.promptTokenCount||0,cr:0,cw:0,o:gj.usageMetadata.candidatesTokenCount||0})}catch(e){}
    }else{
      /* OpenAI 官方与兼容端点（含中转站）：从聊天端点推导生图端点 */
      var oUrl='';
      try{
        if(/\/chat\/completions/i.test(cfg.endpoint||''))oUrl=cfg.endpoint.replace(/\/chat\/completions[^?#]*/i,'/images/generations');
        else oUrl=new URL(cfg.endpoint).origin+'/v1/images/generations';
      }catch(e){oUrl='https://api.openai.com/v1/images/generations'}
      var oBody={model:model,prompt:prompt,n:1};
      /* 尺寸白名单：生图接口只接受枚举值，任意尺寸（如 200x200）会直接 400。
         gpt-image 系：1024x1024/1536x1024/1024x1536/auto；dall-e-3：1024x1024/1792x1024/1024x1792；dall-e-2：256/512/1024 方图。
         不在白名单的 size 不传，交给服务端默认，避免整次请求失败 */
      var _szOk=/^dall-e-2/i.test(model)?['256x256','512x512','1024x1024']:/^dall-e/i.test(model)?['1024x1024','1792x1024','1024x1792']:['1024x1024','1536x1024','1024x1536','auto'];
      if(size&&_szOk.indexOf(String(size).toLowerCase())>-1)oBody.size=String(size).toLowerCase();
      if(/^dall-e/i.test(model))oBody.response_format='b64_json';/* gpt-image 系默认回 b64，且不接受此参数 */
      var oRes=await fetch(oUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.apiKey},signal:ctrl.signal,body:JSON.stringify(oBody)});
      var oj=await oRes.json().catch(function(){return{}});
      if(!oRes.ok)return{ok:false,reason:'生图请求失败（'+oRes.status+'）'+String((oj.error&&oj.error.message)||'').slice(0,160)};
      var _d0=(oj.data&&oj.data[0])||{};
      if(_d0.b64_json)b64=_d0.b64_json;
      else if(_d0.url){
        try{
          var _ir=await fetch(_d0.url,{signal:ctrl.signal});var _ib=await _ir.blob();mime=_ib.type||'image/png';
          b64=await new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(String(fr.result).split(',')[1]||'')};fr.onerror=rej;fr.readAsDataURL(_ib)});
        }catch(eU){return{ok:false,reason:'图像已生成但下载失败（返回临时 URL 且跨域受限）：'+String(_d0.url).slice(0,120)}}
      }
      if(!b64)return{ok:false,reason:'接口未返回图像数据'};
      try{if(oj.usage)_tkRecord(Object.assign({},cfg,{model:model}),{i:(oj.usage.input_tokens||oj.usage.prompt_tokens||0),cr:0,cw:0,o:(oj.usage.output_tokens||oj.usage.completion_tokens||0)})}catch(e){}
    }
    return{ok:true,dataUrl:'data:'+mime+';base64,'+b64,base64:b64,mime:mime,model:model,bytes:Math.floor(b64.length*0.75)};
  }catch(e){
    return{ok:false,reason:(e&&e.name==='AbortError')?'生图超时（120 秒）':'网络错误：'+String(e&&e.message||e).slice(0,140)};
  }finally{clearTimeout(_tm)}
}
/* 收集执行结果里生成成功的图片，供挂到消息 images 上持久化 */
function _wsCollectGenImages(results){
  var out=[];(results||[]).forEach(function(r){if(r&&r.type==='gen_image'&&r.ok&&r.dataUrl)out.push({dataUrl:r.dataUrl,base64:r.base64||'',mime:r.mime||'image/png',name:r.path||'AI生成图像.png'})});
  return out;
}

/* ── Execute workspace ops and return results ──
   注意：results 与 ops 严格一一对应（顺序、数量），渲染层依赖这一点做卡片对齐 */
async function _execWsOps(ops,authorName,cfg){
  var results=[];
  for(var op of ops){
    try{
    if(op.type==='gen_image'){
      var _giPrompt=(op.prompt||'').trim();
      if(op.truncated&&!_giPrompt){results.push({type:'gen_image',prompt:'',ok:false,reason:'输出被截断，提示词不完整'});continue}
      if(!_giPrompt){results.push({type:'gen_image',prompt:'',ok:false,reason:'缺少提示词（prompt 属性为空）'});continue}
      if(!cfg){results.push({type:'gen_image',prompt:_giPrompt,ok:false,reason:'当前入口不支持图像生成（缺少 API 配置上下文）'});continue}
      if(!cfg.imageGen){results.push({type:'gen_image',prompt:_giPrompt,ok:false,reason:'该好友未开启图像生成（可在 API 设置中开启）'});continue}
      /* 实时读秒：生图接口等待可达 120 秒，期间把本轮生图卡切为"正在生成图像…（N秒）"，让用户确认仍在等待而非无响应 */
      var _giCards=[];try{document.querySelectorAll('.ws-op-card[data-gi-wait]').forEach(function(el){el.removeAttribute('data-gi-wait');_giCards.push(el)})}catch(e){}
      var _giLbl=_giPrompt.slice(0,40)+(_giPrompt.length>40?'…':'');
      var _giT0=Date.now(),_giTimer=null;
      _giCards.forEach(function(el){
        el.classList.add('pending');
        var t=el.querySelector('.ws-op-text');if(t)t.innerHTML='正在生成图像 · <b>'+esc(_giLbl)+'</b>';
        var sp=document.createElement('span');sp.className='ws-op-sec';sp.textContent='（0秒）';
        el.insertBefore(sp,el.querySelector('.ws-op-chevron'));
      });
      if(_giCards.length){
        _giTimer=setInterval(function(){
          var s=Math.round((Date.now()-_giT0)/1000),alive=false;
          _giCards.forEach(function(el){if(!el.isConnected)return;alive=true;var sp=el.querySelector('.ws-op-sec');if(sp)sp.textContent='（'+s+'秒）'});
          if(!alive&&_giTimer){clearInterval(_giTimer);_giTimer=null}
        },1000);
      }
      var _gi=await _wsExecImageGen(cfg,_giPrompt,op.size||'');
      if(_giTimer){clearInterval(_giTimer);_giTimer=null}
      _giCards.forEach(function(el){
        if(!el.isConnected)return;
        el.classList.remove('pending');
        var sp=el.querySelector('.ws-op-sec');if(sp)sp.remove();
        var t=el.querySelector('.ws-op-text');if(t)t.innerHTML='已提交生图请求 · <b>'+esc(_giLbl)+'</b>';
      });
      if(_gi.ok){
        var _giPath='';
        try{/* 自动归档进 ICode 默认文件夹：dataUrl 作为文件内容存储（与富文件同一存法） */
          var _giPid=await wsEnsureDefaultProject();
          var _giName=(op.file&&op.file.trim())||('AI生图_'+String(Date.now()).slice(-8)+'.png');
          if(!/\.(png|jpe?g|webp)$/i.test(_giName))_giName+='.png';
          _giPath=await _wsUniquePath(_giPid,_giName);
          await wsSaveFile(_giPid,_giPath,_gi.dataUrl,authorName);
        }catch(eS){_giPath=''}
        _wsPendingOpFeedback.push({actor:authorName,text:'图像已生成并展示给用户'+(_giPath?'，同时已存入 ICode 默认文件夹（'+_giPath+'）':'')+'。提示词：'+_giPrompt.slice(0,120)});
        results.push({type:'gen_image',ok:true,prompt:_giPrompt,model:_gi.model,dataUrl:_gi.dataUrl,base64:_gi.base64,mime:_gi.mime,path:_giPath,bytes:_gi.bytes||0});
      }else{
        results.push({type:'gen_image',ok:false,prompt:_giPrompt,reason:_gi.reason||'生成失败'});
      }
    }else if(op.type==='project'){
      if(!op.name){results.push({type:'project',name:'',ok:false,reason:'缺少项目名（name 属性为空或无法解析）'});continue}
      var _allP=await wsGetProjects();
      var _existed=_allP.some(function(pp){return pp.name===op.name});
      var pid=await wsEnsureProject(op.name);
      results.push({type:'project',name:op.name,ok:true,projId:pid,existed:_existed,isDefault:pid===WS_DEFAULT_PROJ_ID});
    }else if(op.type==='create'){
      if(!op.path){results.push({type:'create',path:'',ok:false,reason:'缺少文件名（path 属性为空或无法解析）'});continue}
      if(!_wsActiveProject){
        await _wsResolveProject(op.path);
        if(!_wsActiveProject)_wsActiveProject=await wsEnsureDefaultProject();/* 未指定项目 → 静默存入默认文件夹 ICode */
      }
      /* 重名保护：ws_create 语义是"新建"。撞名且未声明 overwrite="true" 时不再静默覆盖旧文件，
         而是自动改存为「名 (2).ext」，并把改名结果反馈给 AI（想改写请用 ws_edit 或显式 overwrite） */
      var _cPath=op.path,_cRenamedFrom='';
      if(!op.overwrite){
        var _cUniq=await _wsUniquePath(_wsActiveProject,op.path);
        if(_cUniq!==op.path){_cRenamedFrom=op.path;_cPath=_cUniq}
      }
      await wsSaveFile(_wsActiveProject,_cPath,op.content,authorName);
      results.push({type:'create',path:_cPath,ok:true,size:new Blob([op.content]).size,truncated:!!op.truncated,projId:_wsActiveProject,renamedFrom:_cRenamedFrom||undefined});
    }else if(op.type==='edit'){
      if(op.malformed){results.push({type:'edit',path:op.path,ok:false,reason:op.truncated?'输出被截断':'指令格式不完整'});continue}
      if(!op.path){results.push({type:'edit',path:'',ok:false,reason:'缺少文件名（path 属性为空或无法解析）'});continue}
      if(!_wsActiveProject)await _wsResolveProject(op.path);
      if(!_wsActiveProject){results.push({type:'edit',path:op.path,ok:false,reason:'未指定项目'});continue}
      var er=await wsEditFileContent(_wsActiveProject,op.path,op.find,op.replace,authorName);
      results.push({type:'edit',path:op.path,ok:er.ok,reason:er.reason||'',find:op.find,replace:op.replace,projId:_wsActiveProject});
    }else if(op.type==='read'){
      if(!op.path){results.push({type:'read',path:'',ok:false,reason:'缺少文件名（path 属性为空或无法解析）'});continue}
      if(!_wsActiveProject)await _wsResolveProject(op.path);
      if(!_wsActiveProject){results.push({type:'read',path:op.path,ok:false,reason:'未指定项目'});continue}
      var rf=await wsGetFileByPath(_wsActiveProject,op.path);
      if(rf){
        var _rContent=rf.content;
        if(typeof _rContent==='string'&&_rContent.slice(0,5)==='data:'&&_icodeIsRich(rf.path||op.path)){_rContent=await _wsExtractRichText(rf)}/* 富文件：注入提取文本而非 base64 */
        var _rEntry={path:op.path,projectId:_wsActiveProject,actor:authorName,total:_rContent.length};
        if(op.from>0||op.chars>0){/* 分段读取：from（1 起）+ chars，单段仍受注入上限约束 */
          var _rStart=Math.max(0,(op.from||1)-1);
          var _rLen=op.chars>0?Math.min(op.chars,_ibInjectMax()):_ibInjectMax();
          _rEntry.content=_rContent.slice(_rStart,_rStart+_rLen);
          _rEntry.range={from:_rStart+1,to:_rStart+_rEntry.content.length};
        }else{_rEntry.content=_rContent}
        _wsPendingReads.push(_rEntry);
        results.push({type:'read',path:op.path,ok:true,size:rf.size,projId:_wsActiveProject});
      }else{results.push({type:'read',path:op.path,ok:false,reason:'文件不存在'})}
    }else if(op.type==='make_docx'||op.type==='make_pdf'||op.type==='make_xlsx'){
      var _mkKind=op.type.slice(5);
      if(op.malformed){results.push({type:op.type,path:op.path||'',ok:false,reason:op.truncated?'输出被截断，内容不完整':'指令格式不完整'});continue}
      if(op.truncated){results.push({type:op.type,path:op.path||'',ok:false,reason:'输出被截断，内容不完整，未生成；请完整重发'});continue}
      if(!op.path){results.push({type:op.type,path:'',ok:false,reason:'缺少文件名（path 属性为空或无法解析）'});continue}
      if(!op.content||!op.content.trim()){results.push({type:op.type,path:op.path,ok:false,reason:'内容为空'});continue}
      if(!_wsActiveProject){
        await _wsResolveProject(op.path);
        if(!_wsActiveProject)_wsActiveProject=await wsEnsureDefaultProject();/* 未指定项目 → 静默存入默认文件夹 ICode */
      }
      var _mkR=await _wsExecMakeOp(_mkKind,op,authorName);
      results.push(Object.assign({type:op.type,projId:_wsActiveProject},_mkR,{path:_mkR.path||op.path}));
    }else if(op.type==='tool'){
      results.push(await _ibExecToolOp(op,authorName));
    }else if(op.type==='run'){
      if(op.malformed){results.push({type:'run',entry:op.entry||'',ok:false,reason:op.truncated?'输出被截断，脚本不完整':'指令格式不完整'});continue}
      if(op.truncated&&op.code){results.push({type:'run',entry:op.entry||'',ok:false,reason:'输出被截断，脚本不完整，未运行；请完整重发'});continue}
      if(!op.entry&&!(op.code&&op.code.trim())){results.push({type:'run',entry:'',ok:false,reason:'空脚本：请提供 entry 属性或在标签内写代码'});continue}
      if(!_wsActiveProject){
        if(op.entry)await _wsResolveProject(op.entry);
        if(!_wsActiveProject)_wsActiveProject=await wsEnsureDefaultProject();
      }
      var _rCtx={lang:op.lang||'',entry:op.entry||'',code:op.code||'',projId:_wsActiveProject,timeoutSec:op.timeoutSec||0,author:authorName,pip:op.pip||''};
      if(op.pip&&typeof IBSandbox!=='undefined'){
        var _pipChk=IBSandbox.checkPip(IBSandbox.parsePipAttr(op.pip));
        if(!_pipChk.ok){results.push({type:'run',entry:op.entry||'',ok:false,reason:'pip 包未在白名单: '+_pipChk.denied.join(', ')+'（DIY 页·沙箱扩展中添加后重试）'});continue}
      }
      if(_wsRunMode()!=='auto'){
        /* 询问模式：出待运行卡，等用户点击；先告知 AI 等待，避免它重复提交 */
        _wsPendingOpFeedback.push({actor:authorName,text:'脚本「'+(op.entry||'内联代码')+'」已生成并进入待运行状态（用户开启了运行确认）。等用户点击「运行」后，输出会在之后的消息回传给你——请耐心等待，不要重复提交同一脚本。'});
        results.push(Object.assign({type:'run',ok:true,pendingConfirm:true},_rCtx));
      }else{
        var _rr=await _wsExecuteRun(_rCtx);
        _wsQueueRunOutput(_rCtx,_rr);
        results.push(Object.assign({type:'run',ok:!!_rr.ok,fed:true},_rCtx,{output:_rr.output||'',errText:_rr.errText||'',reason:_rr.ok?'':(_rr.timedOut?'超时':String(_rr.errText||'').slice(0,120)),ms:_rr.ms,timedOut:!!_rr.timedOut,changedNames:_rr.changedNames||[],images:_rr.images||[]}));
      }
    }
    }catch(e){
      if(_giTimer){clearInterval(_giTimer);_giTimer=null}/* 兜底：异常路径下停止生图读秒 */
      /* 存储层异常（如 IndexedDB 配额）不再让整条消息崩掉或被外层静默吞掉：
         记为失败结果 → 卡片显示失败 + 下一轮自动反馈给 AI */
      results.push({type:op.type,path:op.path,name:op.name,ok:false,reason:'执行异常：'+String(e&&e.message||e).slice(0,120)});
    }
  }
  /* 失败 / 截断 / 重名改名信息收集 → 下一条消息自动回传给 AI， */
  results.forEach(function(r){
    if(r.ok===false){
      if(r.type==='run'&&r.fed)return;/* 自动运行的失败详情已由脚本输出通道回传，避免重复 */
      if(r.type==='tool'&&r.fed)return;/* 同上：工具结果通道已回传 */
      var act=r.type==='edit'?'编辑':r.type==='create'?'创建':r.type==='read'?'读取':r.type==='run'?'运行脚本':r.type==='tool'?'调用工具':r.type==='gen_image'?'生成图像':r.type==='make_docx'?'生成 Word 文档':r.type==='make_pdf'?'生成 PDF':r.type==='make_xlsx'?'生成 Excel 表格':'项目操作';
      _wsPendingOpFeedback.push({actor:authorName,text:act+' '+(r.path||r.name||(r.prompt?'「'+String(r.prompt).slice(0,40)+'」':'')||'')+' 失败：'+(r.reason||'未知原因')});
    }else if(r.type==='create'&&r.renamedFrom){
      _wsPendingOpFeedback.push({actor:authorName,text:'创建时发现 '+r.renamedFrom+' 已存在，为避免覆盖旧文件，新文件已自动改存为 '+r.path+'。若你本意就是改写原文件，请改用 <ws_edit path="'+r.renamedFrom+'"> 做局部修改，或用 <ws_create path="'+r.renamedFrom+'" overwrite="true"> 整份重写。'});
    }else if(r.type&&r.type.slice(0,5)==='make_'&&r.renamedFrom){
      _wsPendingOpFeedback.push({actor:authorName,text:'生成时发现 '+r.renamedFrom+' 已存在，为避免覆盖旧文件，成品已自动改存为 '+r.path+'；后续读取或引用请使用新文件名。'});
    }else if(r.type==='create'&&r.truncated){
      _wsPendingOpFeedback.push({actor:authorName,text:'创建 '+r.path+' 已保存，但内容可能在末尾被截断，建议 <ws_read path="'+r.path+'"/> 校验结尾是否完整'});
    }
  });
  /* ICode 悬浮窗开着时同步刷新列表 + 底部存储条，让 AI 的操作"当场可见" */
  try{
    var _wsWin=document.getElementById('ws-overlay');
    if(_wsWin&&_wsWin.style.display!=='none'&&_wsWin.style.display!==''){
      if(_wsViewingProject)renderWsFiles(_wsViewingProject);else renderWsProjects();
    }
    _wsUpdateStorage();
  }catch(e){}
  return results;
}

/* ── Build operation card DOM ──
   同时接受"实时执行结果"与"历史消息解析出的操作"：历史加载时也能还原操作卡，
   可折叠展开查看文件内容 / 编辑对比，展开后提供下载与打开工作区入口 */
function _buildWsOpCard(d){
  /* 指向默认文件夹的 <ws_project> 不出卡：并没有创建任何项目，文件只是照常落进默认文件夹「ICode」；
     真正创建/选定具名项目时才显示卡片（失败卡照常显示） */
  if(d.type==='project'&&d.ok!==false&&!d.malformed&&(d.isDefault||d.projId===WS_DEFAULT_PROJ_ID||_wsIsDefaultName(d.name)))return null;
  var card=document.createElement('div');card.className='ws-op-card';
  var ok=d.ok!==false&&!d.malformed;
  var icons={project:WS_ICON.proj,create:WS_ICON.create,edit:WS_ICON.edit,read:WS_ICON.read,run:WS_ICON.run,tool:WS_ICON.tool,gen_image:WS_ICON.image,make_docx:WS_ICON.create,make_pdf:WS_ICON.create,make_xlsx:WS_ICON.create};
  var label;
  if(d.type==='project')label=ok?(d.existed?'已选定项目':'已创建项目'):'项目操作失败';
  else if(d.type==='create')label=ok?(d.truncated?'已创建文件（可能不完整）':(d.renamedFrom?'已创建文件（重名自动改名）':'已创建文件')):'创建失败';
  else if(d.type==='make_docx')label=ok?(d.renamedFrom?'已生成 Word 文档（重名自动改名）':'已生成 Word 文档'):'生成 Word 文档失败';
  else if(d.type==='make_pdf')label=ok?(d.renamedFrom?'已生成 PDF（重名自动改名）':'已生成 PDF'):'生成 PDF 失败';
  else if(d.type==='make_xlsx')label=ok?(d.renamedFrom?'已生成 Excel 表格（重名自动改名）':'已生成 Excel 表格'):'生成 Excel 表格失败';
  else if(d.type==='edit')label=ok?'已编辑文件':'编辑失败';
  else if(d.type==='run'){
    if(!ok)label=d.timedOut?'脚本运行超时':'脚本运行失败';
    else if(d.pendingConfirm)label='脚本待运行';
    else if(d.output!==undefined)label='脚本运行完成'+(d.ms?'（'+(d.ms/1000).toFixed(1)+'s）':'');
    else label='运行脚本';
  }
  else if(d.type==='tool'){
    if(!ok)label='工具调用失败';
    else if(d.pendingConfirm)label='工具待执行';
    else if(d.response!==undefined)label='工具调用完成';
    else label='调用工具';
  }
  else if(d.type==='gen_image'){
    if(!ok)label='生成图像失败';
    else if(d.dataUrl)label='已生成图像'+(d.path?'（已存入 ICode）':'');
    else label='生图请求';
  }
  else label=ok?'已读取文件':'读取失败';
  var detail=d.type==='project'?(d.name||''):d.type==='run'?(d.entry||'内联代码'):d.type==='tool'?(d.name||''):d.type==='gen_image'?String(d.prompt||'').slice(0,40)+(String(d.prompt||'').length>40?'…':''):(d.path||'');
  var size=d.size!==undefined?d.size:(d.type!=='run'&&d.content!==undefined?new Blob([d.content]).size:undefined);
  var sizeStr=(d.type==='create'||d.type==='read'||d.type.slice(0,5)==='make_')&&ok&&size!==undefined?' ('+_fmtFileSize(size)+')':'';
  var expandable=(d.type==='create'&&d.content!==undefined)||(d.type==='edit'&&d.find!==undefined)||(d.type==='run'&&(d.code||d.output!==undefined||d.errText||(d.images&&d.images.length)))||(d.type==='tool'&&(d.args||d.response!==undefined||d.pendingConfirm||(d.images&&d.images.length)))||(d.type==='gen_image'&&(d.dataUrl||d.prompt));
  if(!ok)card.classList.add('fail');
  if(expandable)card.classList.add('expandable');
  var html=(icons[d.type]||'')
    +'<span class="ws-op-text">'+esc(label)+' · <b>'+esc(detail)+'</b>'+esc(sizeStr)+'</span>';
  if(!ok)html+='<span class="ws-op-tag fail">'+esc(d.reason||(d.truncated?'输出被截断':'指令格式不完整'))+'</span>';
  else if((d.type==='create'||d.type.slice(0,5)==='make_')&&d.renamedFrom)html+='<span class="ws-op-tag">原名 '+esc(d.renamedFrom)+' 已存在</span>';
  else if(d.type==='run'&&d.changedNames&&d.changedNames.length)html+='<span class="ws-op-tag">写回 '+d.changedNames.length+' 个文件</span>';
  if(expandable)html+='<svg class="ws-op-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
  card.innerHTML=html;
  if(d.type==='run'&&d.pendingConfirm){
    var runBtn=document.createElement('button');runBtn.className='ws-file-btn primary';runBtn.style.flexShrink='0';runBtn.textContent='运行';
    var _rc={lang:d.lang||'',entry:d.entry||'',code:d.code||'',projId:d.projId||_wsActiveProject,timeoutSec:d.timeoutSec||0,author:d.author||'AI',pip:d.pip||''};
    runBtn.onclick=function(ev){ev.stopPropagation();_wsConfirmRunFromCard(runBtn,_rc,card)};
    var chev=card.querySelector('.ws-op-chevron');
    if(chev)card.insertBefore(runBtn,chev);else card.appendChild(runBtn);
  }
  if(d.type==='tool'&&d.pendingConfirm){
    var tBtn=document.createElement('button');tBtn.className='ws-file-btn primary';tBtn.style.flexShrink='0';tBtn.textContent='执行';
    var _tc={name:d.name||'',args:d.args||'',author:d.author||'AI'};
    tBtn.onclick=function(ev){ev.stopPropagation();_ibConfirmToolFromCard(tBtn,_tc,card)};
    var tChev=card.querySelector('.ws-op-chevron');
    if(tChev)card.insertBefore(tBtn,tChev);else card.appendChild(tBtn);
  }
  if(expandable){
    var det=document.createElement('div');det.className='ws-op-detail';
    if(d.type==='create'){
      det.textContent=d.content.length>1600?d.content.slice(0,1600)+'\n…（预览截断，完整内容见 ICode）':d.content;
    }else if(d.type==='run'){
      det.textContent=d.code?(d.code.length>1600?d.code.slice(0,1600)+'\n…（代码过长已截断）':d.code):('入口: '+(d.entry||''));
      if(d.output!==undefined||d.errText){
        var ro=document.createElement('div');ro.className='ws-run-out';
        ro.textContent=(d.output||'')+(d.errText?((d.output?'\n':'')+'[错误] '+d.errText):'')+(d.changedNames&&d.changedNames.length?'\n[已写回: '+d.changedNames.join(', ')+']':'')||'（无输出）';
        det.appendChild(ro);
      }
      if(d.images&&d.images.length&&typeof IBSandbox!=='undefined'){var _irw=document.createElement('div');_irw.innerHTML=IBSandbox.imagesRow(d.images);if(_irw.firstChild)det.appendChild(_irw.firstChild)}
    }else if(d.type==='tool'){
      det.textContent='args: '+(d.args||'（无参数）');
      if(d.response!==undefined){
        var tro=document.createElement('div');tro.className='ws-run-out';
        tro.textContent=d.response||'（无返回内容）';
        det.appendChild(tro);
      }
      if(d.images&&d.images.length&&typeof IBSandbox!=='undefined'){var _trw=document.createElement('div');_trw.innerHTML=IBSandbox.imagesRow(d.images);if(_trw.firstChild)det.appendChild(_trw.firstChild)}
    }else if(d.type==='gen_image'){
      det.textContent='提示词: '+(d.prompt||'');
      if(d.dataUrl){
        var _gImg=document.createElement('img');_gImg.className='chat-bubble-img';_gImg.loading='lazy';_gImg.decoding='async';
        _gImg.src=d.dataUrl;_gImg.alt='AI 生成图像';_gImg.style.cssText='display:block;margin-top:8px;max-width:min(360px,100%);border-radius:10px;cursor:zoom-in';
        _gImg.onclick=function(ev){ev.stopPropagation();if(typeof _viewImageFull==='function')_viewImageFull(d.dataUrl)};
        det.appendChild(_gImg);
        var _gMeta=document.createElement('div');_gMeta.className='ws-run-out';
        _gMeta.textContent='模型: '+(d.model||'?')+(d.path?' · 已存入 ICode: '+d.path:'');
        det.appendChild(_gMeta);
      }
    }else{
      det.textContent='- '+(d.find||'').slice(0,300)+((d.find||'').length>300?'…':'')+'\n+ '+(d.replace||'').slice(0,300)+((d.replace||'').length>300?'…':'');
    }
    card.appendChild(det);
    var acts=document.createElement('div');acts.className='ws-op-detail-actions';
    if(d.type==='create'){
      var dl=document.createElement('button');dl.className='ws-file-btn';dl.textContent='下载';
      dl.onclick=function(ev){ev.stopPropagation();_downloadTextFile(d.path,d.content)};
      acts.appendChild(dl);
    }
    if(d.type!=='tool'&&!(d.type==='gen_image'&&!d.path)){/* 工具调用与工作区文件无关，不出"打开 ICode"入口；生图未归档成功时同样不出 */
      var go=document.createElement('button');go.className='ws-file-btn';go.textContent='打开 ICode';
      go.onclick=function(ev){ev.stopPropagation();openWorkspace();var pj=d.projId||_wsActiveProject;if(pj)renderWsFiles(pj)};
      acts.appendChild(go);
    }
    card.appendChild(acts);
    card.onclick=function(){card.classList.toggle('expanded')};
    if(d.type==='gen_image'&&ok&&d.dataUrl)card.classList.add('expanded');/* 生图成功默认展开：图片即刻可见 */
  }
  return card;
}

/* ── Process workspace ops in AI response (called after response received) ── */
async function _processWsResponse(text,authorName,cfg){
  var parsed=_parseWsOps(text);
  if(parsed.files&&parsed.files.length){try{await _wsArchiveFileBlocks(parsed.files,authorName)}catch(e){}}
  if(!parsed.ops.length)return{cleanText:text,cards:[]};
  var results=await _execWsOps(parsed.ops,authorName,cfg);
  var cards=results.map(_buildWsOpCard).filter(Boolean);
  return{cleanText:parsed.cleanText,cards:cards};
}

/* ── 操作结果反馈注入：上一轮失败的工作区操作，下一条消息告知 AI ──
   可选 filterFn：只取出（并消费）匹配的条目，其余留在队列里——群聊按成员精准派发用 */
function _getWsOpFeedbackInjection(filterFn){
  if(!_wsPendingOpFeedback.length)return'';
  var take,keep=[];
  if(typeof filterFn==='function'){take=[];_wsPendingOpFeedback.forEach(function(it){(filterFn(it)?take:keep).push(it)})}
  else{take=_wsPendingOpFeedback}
  _wsPendingOpFeedback=keep;
  if(!take.length)return'';
  var ctx='\n\n【工作区操作结果反馈】你上一轮的部分工作区操作有需要注意的结果，请据此处理（操作失败时请修正后重试；编辑失败先 <ws_read> 拿到最新原文，逐字复制片段后再改）：';
  take.forEach(function(s){ctx+='\n- '+(s&&s.text!==undefined?s.text:s)});
  return ctx;
}

/* ── 空头支票检测：回复里"声称"创建/修改了项目或文件，却没有任何可执行的工作区指令 ──
   这是"AI 说建好了但工作区里什么都没有"的另一大根源（模型只输出自然语言、
   或模仿历史占位符、或标签残缺无法解析）。检测到后：
   ① 聊天里插入一张醒目的提醒卡（附"让它重试"按钮）；
   ② 把纠正指令排进反馈队列，下一条消息自动注入，让 AI 自我修正。
   返回 'claim' / 'malformed' / null。 */
var _WS_CLAIM_RE=/(已|已经)(为你|帮你|成功)?(创建|新建|生成|建立|保存|写入|建好|做好|完成)[^。！？!?\n]{0,30}(项目|文件|表格|文档|工作区)|(项目|文件|表格|文档)[^。！？!?\n]{0,16}(已|已经)(创建|生成|保存|建好|就绪|完成|写好)|(创建|生成|保存|写|建)好了[^。！？!?\n]{0,16}(项目|文件|表格|文档)|工作区里?(已|已经)(有|生成|创建|保存)|\[已(创建|编辑|输出)|\[系统归档/;
function _wsCheckPhantom(cleanText,opsCount,actor){
  if(opsCount>0)return null;
  var t=cleanText||'';
  /* 情形一：存在疑似标签但连开标签的 > 都没有 → 格式残缺，未执行 */
  if(/<ws_(project|read|create|edit|run|tool|make_docx|make_pdf|make_xlsx)\b(?![^<]*>)/i.test(t)){
    _wsPendingOpFeedback.push({actor:actor,text:'你上一条回复包含疑似工作区标签，但格式不完整、系统无法解析（常见原因：开标签没有以 > 结束，或缺少对应的闭合标签），因此本轮没有执行任何操作、工作区没有任何变化。请按标准格式把全部指令完整重发一次。'});
    return 'malformed';
  }
  if(/<ws_(project|read|create|edit|run|tool|make_docx|make_pdf|make_xlsx)\b/i.test(t))return null;/* 有完整标签却 0 op 的情况交由解析层处理 */
  /* 情形二：纯口头声称 */
  if(_WS_CLAIM_RE.test(t)){
    _wsPendingOpFeedback.push({actor:actor,text:'你上一条回复在文字中声称已创建/修改了项目或文件，但回复中没有任何 <ws_project/>、<ws_create>、<ws_edit> 指令标签，因此系统没有执行任何操作，工作区里没有产生任何内容。请立即重新输出完整的工作区指令来真正完成刚才的操作——只有标签会被执行，纯文字描述（包括"[系统归档：…]"之类的占位写法）不会创建任何文件。'});
    return 'claim';
  }
  return null;
}
/* 空头支票提醒卡：告知用户实际未执行，一键让 AI 重做 */
function _buildWsPhantomHint(kind){
  var c=document.createElement('div');c.className='ws-op-card warn';
  var txt=kind==='malformed'
    ?'检测到 ICode 指令但格式残缺，本轮未执行任何操作'
    :'AI 声称已创建/修改文件，但未输出 ICode 指令，实际未执行任何操作';
  c.innerHTML=WS_ICON.warn+'<span class="ws-op-text">'+esc(txt)+'</span>';
  var b=document.createElement('button');b.className='ws-file-btn';b.style.flexShrink='0';b.textContent='让它重试';
  b.onclick=function(ev){
    ev.stopPropagation();
    var inp=currentPage==='chat'?document.getElementById('chat-full-input'):document.getElementById('chat-input');
    if(!inp)return;
    if(!inp.value.trim())inp.value='请用工作区指令重新执行刚才的操作';
    c.remove();sendChatMessage();
  };
  c.appendChild(b);
  return c;
}

/* ── Inject pending reads into system prompt ──
   可选 filterFn：只取出（并消费）匹配的条目，其余留队——群聊里读取结果精准回注给请求它的成员 */
function _getWsReadInjection(filterFn){
  if(!_wsPendingReads.length)return'';
  var take,keep=[];
  if(typeof filterFn==='function'){take=[];_wsPendingReads.forEach(function(r){(filterFn(r)?take:keep).push(r)})}
  else{take=_wsPendingReads}
  _wsPendingReads=keep;
  if(!take.length)return'';
  var ctx='\n\n【工作区文件内容（AI 上一轮请求读取的文件）】';
  take.forEach(function(r){
    var MAX=_ibInjectMax();
    if(r.range){
      ctx+='\n--- '+r.path+'（分段读取：第 '+r.range.from+'–'+r.range.to+' 字符，全文共 '+r.total+' 字符）---\n'+r.content
        +(r.range.to<r.total?'\n[后续内容未注入：继续读取请用 <ws_read path="'+r.path+'" from="'+(r.range.to+1)+'" chars="…"/>]':'');
    }else{
      ctx+='\n--- '+r.path+' ---\n'+r.content.slice(0,MAX)
        +(r.content.length>MAX?'\n[…文件超过 '+Math.round(MAX/10000)+' 万字符注入上限，已截断（原文共 '+r.content.length+' 字符）；可用 <ws_read path="'+r.path+'" from="'+(MAX+1)+'"/> 分段继续读取]':'');
    }
  });
  return ctx;
}

/* ── 流式写入器：每个气泡维护"当前文本节点"，插卡后另起新文本节点，保证文字与卡片按顺序交错 ──
   全部/部分渲染模式：文本改走"分段缓冲 + 节流重渲染"，直播期即以排版后的样子呈现，
   不再回显 Markdown 原文；收尾仍由 _wsFinalizeBubble 以完整原文重建，直播渲染只是过程视图。 */
function _wsMakeStreamWriters(refs){
  var _wm=_mdMode(),_wLive=(_wm==='full'||_wm==='partial');
  return refs.map(function(ref){
    var host=ref.isTextNode?ref.div:ref.txt;
    var node=ref.isTextNode?ref.txt:null;
    var seg=null,segBuf='',pendT=0;
    function paint(){pendT=0;if(!seg)return;seg.innerHTML=_mdRenderHtml(segBuf,_wm==='partial');ref.container.scrollTop=ref.container.scrollHeight}
    function flushSeg(){if(pendT){clearTimeout(pendT);paint()}}
    return{
      text:function(ch){
        if(!ch)return;
        if(_wLive){
          /* 直播渲染：分段缓冲整体重渲（约 30fps 节流；超长段降频，防高频全量重排拖垮 DOM）。
             未闭合的 **加粗** 等记号在闭合前会短暂按原样显示，闭合即渲染；未闭合围栏由
             _mdRenderHtml 收尾分支按代码块呈现——与主流聊天应用的流式渲染表现一致。 */
          if(!seg){seg=document.createElement('div');seg.className='md-live-seg'+(ref.isTextNode?' r-text':'');host.appendChild(seg)}
          segBuf+=ch;
          if(!pendT)pendT=setTimeout(paint,segBuf.length>30000?150:33);
          return;
        }
        if(!node){node=document.createTextNode('');host.appendChild(node)}node.textContent+=ch;ref.container.scrollTop=ref.container.scrollHeight
      },
      card:function(build){
        if(_wLive){flushSeg();seg=null;segBuf=''}/* 插卡前先落定当前分段，卡后另起新段，保持文字与卡片交错顺序 */
        var el=build();host.appendChild(el);node=null;ref.container.scrollTop=ref.container.scrollHeight;return el
      }
    };
  });
}

/* ── 流式拦截器：直播时把 ws 标签 / file 块从文字流里截下，替换为"进行中"操作卡，
   避免整屏原始代码炸进气泡；最终以完整回复为准重新渲染 ── */
var _WS_STREAM_STARTS=['<ws_project','<ws_create','<ws_edit','<ws_read','<ws_run','<ws_tool','<ws_gen_image','<ws_make_docx','<ws_make_pdf','<ws_make_xlsx','```file:'];
function _wsMakeStreamFilter(writers){
  var buf='',mode=0,closer='',pend=[],pendPath='',pendKind='',contentLen=0,liveTail='',pendTimer=null;
  var _LIVE_CAP=4000;/* 直播详情只保留末尾 4000 字，防超长文件拖垮 DOM */
  var _liveMd=_mkLiveMdCleaner();/* 直播期 Markdown 净化；收尾重渲染以 _mdSoften 为最终口径 */
  var _liveMode=_mdMode();
  function flushText(t){if(!t)return;if(_liveMode==='clean'){t=_liveMd.push(t)}if(t)writers.forEach(function(w){w.text(t)})}
  function holdLen(s){
    var low=s.toLowerCase();
    for(var l=Math.min(low.length,13);l>0;l--){/* 13 = 最长起始标记 '<ws_make_docx' 的长度 */
      var tail=low.slice(-l);
      if(_WS_STREAM_STARTS.some(function(st){return st.indexOf(tail)===0}))return l;
    }
    return 0;
  }
  function beginPending(kind,pathOrName){
    pendKind=kind;pendPath=pathOrName;contentLen=0;liveTail='';
    var lbl=kind==='edit'?'正在编辑文件':kind==='run'?'正在编写脚本':kind==='tool'?'正在调用工具':kind==='gen_image'?'正在提交生图请求':kind==='make_docx'?'正在生成 Word 文档':kind==='make_pdf'?'正在生成 PDF':kind==='make_xlsx'?'正在生成 Excel 表格':'正在创建文件';
    var ic=kind==='edit'?WS_ICON.edit:kind==='run'?WS_ICON.run:kind==='tool'?WS_ICON.tool:kind==='gen_image'?WS_ICON.image:WS_ICON.create;
    pend=writers.map(function(w){
      return w.card(function(){
        /* 直播中的操作卡即刻可展开：点开就能看到正在写入的内容（工作过程） */
        var c=document.createElement('div');c.className='ws-op-card pending expandable';
        c.innerHTML=ic+'<span class="ws-op-text">'+esc(lbl)+' · <b>'+esc(pathOrName)+'</b><span class="ws-op-live"></span></span>'
          +'<span class="ws-op-sec">（0秒）</span>'
          +'<svg class="ws-op-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
        var det=document.createElement('div');det.className='ws-op-detail';
        c.appendChild(det);
        c.onclick=function(){c.classList.toggle('expanded');if(c.classList.contains('expanded'))det.scrollTop=det.scrollHeight};
        return c;
      });
    });
    /* 实时读秒：高延迟时数据可能长时间无增长，按秒跳动让用户确认仍在等待 AI 完成，而非无响应 */
    if(pendTimer){clearInterval(pendTimer);pendTimer=null}
    var _pt0=Date.now(),_ptCards=pend;
    pendTimer=setInterval(function(){
      var s=Math.round((Date.now()-_pt0)/1000),alive=false;
      _ptCards.forEach(function(c){if(!c.isConnected)return;alive=true;var sp=c.querySelector('.ws-op-sec');if(sp)sp.textContent='（'+s+'秒）'});
      if(!alive&&pendTimer){clearInterval(pendTimer);pendTimer=null}
    },1000);
  }
  function growPending(chunk){
    if(!chunk)return;
    contentLen+=chunk.length;
    liveTail+=chunk;
    if(liveTail.length>_LIVE_CAP)liveTail=liveTail.slice(liveTail.length-_LIVE_CAP);
    var s=' ('+_fmtFileSize(contentLen)+'…)';
    var dTxt=(contentLen>liveTail.length?'…\n':'')+liveTail;
    pend.forEach(function(c){
      var lv=c.querySelector('.ws-op-live');if(lv)lv.textContent=s;
      var det=c.querySelector('.ws-op-detail');
      if(det){det.textContent=dTxt;if(c.classList.contains('expanded'))det.scrollTop=det.scrollHeight}
    });
  }
  function endPending(){
    if(pendTimer){clearInterval(pendTimer);pendTimer=null}
    var lbl=pendKind==='edit'?'已编辑文件':pendKind==='run'?'脚本已提交':pendKind==='tool'?'已提交调用':pendKind==='gen_image'?'已提交生图请求':pendKind.slice(0,5)==='make_'?'已提交生成':'已创建文件';
    pend.forEach(function(c){
      c.classList.remove('pending');
      if(pendKind==='gen_image')c.dataset.giWait='1';/* 标记：生图请求已提交，执行阶段（真正调用生图接口）由 _execWsOps 接管读秒 */
      var se=c.querySelector('.ws-op-sec');if(se)se.remove();
      var t=c.querySelector('.ws-op-text');
      if(t)t.innerHTML=esc(lbl)+' · <b>'+esc(pendPath)+'</b>'+((pendKind==='edit'||pendKind==='run'||pendKind==='tool'||pendKind==='gen_image')?'':esc(' ('+_fmtFileSize(contentLen)+')'));
    });
    pend=[];
  }
  function miniCard(kind,val){
    var lbl=kind==='project'?'已创建项目':kind==='run'?'已提交运行':kind==='tool'?'调用工具':kind==='gen_image'?'已提交生图请求':'读取文件';
    var ic=kind==='project'?WS_ICON.proj:kind==='run'?WS_ICON.run:kind==='tool'?WS_ICON.tool:kind==='gen_image'?WS_ICON.image:WS_ICON.read;
    writers.forEach(function(w){w.card(function(){
      var c=document.createElement('div');c.className='ws-op-card';
      if(kind==='gen_image')c.dataset.giWait='1';/* 标记：执行阶段（真正调用生图接口）由 _execWsOps 接管读秒 */
      c.innerHTML=ic+'<span class="ws-op-text">'+esc(lbl)+' · <b>'+esc(val)+'</b></span>';
      return c;
    })});
  }
  function scanText(){
    for(;;){
      var low=buf.toLowerCase();
      var idx=-1,which=-1;
      for(var i=0;i<_WS_STREAM_STARTS.length;i++){
        var p=low.indexOf(_WS_STREAM_STARTS[i]);
        if(p!==-1&&(idx===-1||p<idx)){idx=p;which=i}
      }
      if(idx===-1){
        var h=holdLen(buf);
        flushText(buf.slice(0,buf.length-h));
        buf=buf.slice(buf.length-h);
        return;
      }
      flushText(buf.slice(0,idx));
      buf=buf.slice(idx);
      var st=_WS_STREAM_STARTS[which];
      if(st==='```file:'){
        var nl=buf.indexOf('\n');
        if(nl===-1)return;
        beginPending('file',buf.slice(8,nl).trim());
        buf=buf.slice(nl+1);closer='```';mode=1;
        return scanIn();
      }
      var gt=buf.indexOf('>');
      if(gt===-1)return;
      var opener=buf.slice(0,gt+1);
      buf=buf.slice(gt+1);
      var val=_wsAttr(opener,'path')||_wsAttr(opener,'name')||_wsAttr(opener,'entry')||_wsAttr(opener,'file');
      if(st==='<ws_project'){if(val&&!_wsIsDefaultName(val))miniCard('project',val);continue}
      if(st==='<ws_read'){miniCard('read',val);continue}
      if(st==='<ws_run'){
        if(/\/\s*>$/.test(opener)){miniCard('run',val||'脚本');continue}
        beginPending('run',val||'内联脚本');closer='</ws_run>';mode=1;
        return scanIn();
      }
      if(st==='<ws_tool'){
        if(/\/\s*>$/.test(opener)){miniCard('tool',val||'工具');continue}
        beginPending('tool',val||'工具');closer='</ws_tool>';mode=1;
        return scanIn();
      }
      if(st==='<ws_gen_image'){
        var _giv=(_wsAttr(opener,'prompt')||'').slice(0,40)||'图像';
        if(/\/\s*>$/.test(opener)){miniCard('gen_image',_giv);continue}
        beginPending('gen_image',_giv);closer='</ws_gen_image>';mode=1;
        return scanIn();
      }
      if(st.slice(0,9)==='<ws_make_'){/* 生成指令：源内容（Markdown/HTML/CSV）收进直播卡，避免整段原文炸进气泡 */
        var mkKind=st.slice(4);
        beginPending(mkKind,val||(st.slice(9).toUpperCase()+' 文件'));
        closer='</ws_'+mkKind+'>';mode=1;
        return scanIn();
      }
      beginPending(st==='<ws_create'?'create':'edit',val);
      closer=st==='<ws_create'?'</ws_create>':'</ws_edit>';
      mode=1;
      return scanIn();
    }
  }
  function scanIn(){
    var idx=buf.toLowerCase().indexOf(closer);
    if(idx===-1){
      var keep=closer.length-1;
      if(buf.length>keep){growPending(buf.slice(0,buf.length-keep));buf=buf.slice(buf.length-keep)}
      return;
    }
    growPending(buf.slice(0,idx));
    endPending();
    buf=buf.slice(idx+closer.length);
    mode=0;
    return scanText();
  }
  return{
    push:function(ch){buf+=ch;if(mode===0)scanText();else scanIn()},
    finish:function(){if(pendTimer){clearInterval(pendTimer);pendTimer=null}if(mode===0)flushText(buf);buf='';var _rest=_liveMd.finish();if(_rest)writers.forEach(function(w){w.text(_rest)})},
    card:function(build){var els=[];writers.forEach(function(w){els.push(w.card(build))});return els}
  };
}

/* ── 收尾重渲染：流式结束后以完整回复为准，把气泡重建为 文本+操作卡+下载卡 的分段结构 ── */
function _wsFinalizeBubble(ref,rawText,wsResults){
  var host=ref.isTextNode?ref.div:ref.txt;
  var keep=null;
  if(ref.isTextNode){
    var first=host.firstChild;
    if(first&&first.nodeType===1&&first.tagName==='SPAN')keep=first;
  }
  host.textContent='';
  if(keep)host.appendChild(keep);
  var mode=_mdMode();
  if(mode==='full'||mode==='partial'){ref.div.classList.add('md-rendered')}
  _renderSegments(ref.isTextNode?_panelMdHost(host):host,rawText,wsResults);
}

/* ══════════ 任务6：手动「继续生成」 ══════════
   自动续写轮数用尽后消息仍被截断（finish_reason=length）时：
   · 消息落库时带 truncated:true；
   · 气泡尾部渲染「▸ 继续生成」按钮（历史重载同样渲染）；
   · 点击 → 以"assistant 原文 + 续写指令"请求增量，接缝去重后拼进原消息并更新数据库；
   · 增量里新出现的工作区指令照常执行（上一段末尾被截断的指令此前已按失败反馈，
     模型会按既有恢复策略完整重发，两相衔接）。 */
function _buildContinuePill(msgId){
  var c=document.createElement('div');c.className='ws-op-card ws-continue-pill';c.dataset.contFor=msgId;
  c.innerHTML='<span class="ws-op-text">回复因输出上限被截断</span>';
  var b=document.createElement('button');b.className='ws-file-btn';b.style.flexShrink='0';b.textContent='▸ 继续生成';
  b.onclick=function(ev){ev.stopPropagation();continueTruncatedMsg(msgId,c)};
  c.appendChild(b);
  return c;
}
var _contBusy=new Set();
async function continueTruncatedMsg(msgId,pillEl){
  if(_contBusy.has(msgId))return;
  var m=await dbGet('chatMessages',msgId);
  if(!m||!m.content){toast('原消息不存在');return}
  /* “继续生成”会把原 assistant 文本再次发送给 API；封档线之前的消息必须禁止续写。 */
  if(!m.threadId){
    const _contSealTs=await getChatSealTimestamp(m.friendId);
    if(_contSealTs&&(m.timestamp||m.created||0)<=_contSealTs){toast('该消息位于封档线之前，不能继续发送给 API');return}
  }
  /* 找到该消息的 API 配置：群聊按 senderName 反查成员，1对1按 friendId */
  var cfg=null;
  if((m.friendId||'').startsWith('group_')){
    try{var g=await dbGet('groups',m.friendId);
      if(g&&g.members)cfg=g.members.map(id=>apiConfigs.find(a=>a.id===id)).filter(Boolean).find(a=>(a.nickname||a.model)===m.senderName)}catch(e){}
  }else{cfg=apiConfigs.find(a=>a.id===m.friendId)}
  if(!_ibApiReady(cfg)){toast('找不到可用的 API 配置');return}
  _contBusy.add(msgId);
  var btn=pillEl&&pillEl.querySelector('button');if(btn){btn.disabled=true;btn.textContent='续写中…'}
  /* 定位页面上的气泡，准备直播续写文本 */
  var refs=[];
  document.querySelectorAll('.chat-msg[data-msg-id="'+msgId+'"]').forEach(function(el){
    var txt=el.querySelector('.r-text');
    if(txt)refs.push({div:el,txt:txt,full:true,isTextNode:false,container:el.parentElement});
  });
  var liveSpans=refs.map(function(r){var s=document.createElement('span');s.className='chat-stream-cursor';r.txt.appendChild(s);return s});
  var oldContent=m.content;
  var oldOps=_parseWsOps(oldContent).ops;
  var lastOldBroken=oldOps.length&&(oldOps[oldOps.length-1].malformed||oldOps[oldOps.length-1].truncated)?1:0;
  var msgs=[
    {role:'system',content:(cfg.systemPrompt?cfg.systemPrompt+'\n\n':'')+_WS_INSTR_BLOCK.replace(/^\n+/,'')},
    {role:'assistant',content:oldContent},
    {role:'user',content:_WS_CONT_PROMPT}
  ];
  var piece='',_ctRes={};/* 并发隔离：本次续写调用的截断结果 */
  try{
    var streamOk=cfg.streaming!==undefined?!!cfg.streaming:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].streaming);
    if(streamOk&&typeof callApiChatStream==='function'){
      piece=await callApiChatStream(cfg,msgs,{wantThinking:false,autoContinue:true,chatKey:m.friendId,result:_ctRes,
        onChunk:function(){/* wait for normalized final content so legacy thinking tags never flash on screen */}});
    }else{
      piece=await callApiChat(cfg,msgs,{wantThinking:false,autoContinue:true,result:_ctRes});
    }
  }catch(e){
    liveSpans.forEach(function(s){s.remove()});
    if(btn){btn.disabled=false;btn.textContent='▸ 继续生成'}
    _contBusy.delete(msgId);
    toast('续写失败：'+String(e&&e.message||e).slice(0,80));
    return;
  }
  var _ctParts=_assistantResponseParts(piece,_ctRes.reasoning_content||'');
  piece=_wsDedupSeam(oldContent,_ctParts.content||piece);
  var stillTrunc=!!_ctRes.truncated;
  var newContent=oldContent+piece;
  /* 只执行增量里"新出现"的工作区指令；旧段末尾那条残缺指令若被完整重发，也落在增量里 */
  var combined=_parseWsOps(newContent);
  var deltaStart=Math.max(0,oldOps.length-lastOldBroken);
  var deltaOps=combined.ops.slice(deltaStart);
  var deltaResults=deltaOps.length?await _execWsOps(deltaOps,cfg.nickname||cfg.model||'AI',cfg):[];
  if(combined.files&&combined.files.length){try{await _wsArchiveFileBlocks(combined.files.slice(_parseWsOps(oldContent).files.length),cfg.nickname||cfg.model||'AI')}catch(e){}}
  var fullResults=new Array(deltaStart).fill(null).concat(deltaResults);
  /* 落库并重建气泡（旧指令卡呈历史中性态，新指令卡带真实执行状态） */
  m.content=newContent;
  if(_ctParts.reasoning_content){const priorReasoning=m.reasoning_content||m.thinking||'';m.reasoning_content=(priorReasoning?priorReasoning+'\n\n':'')+_ctParts.reasoning_content}
  else if(m.reasoning_content==null)m.reasoning_content=m.thinking||'';
  if(!m.metadata)m.metadata={};
  if(!m.metadata.model)m.metadata.model=cfg.provider||cfg.model||'';
  if(!m.metadata.model_id)m.metadata.model_id=cfg.model||'';
  if(!m.metadata.config_id)m.metadata.config_id=cfg.id;
  if(typeof m.metadata.showThinking!=='boolean')m.metadata.showThinking=_resolveShowThinking(cfg);
  {const _ctGiImgs=_wsCollectGenImages(deltaResults);if(_ctGiImgs.length)m.images=(m.images||[]).concat(_ctGiImgs);}/* 续写增量里的生成图并入消息 */
  if(stillTrunc)m.truncated=true; else delete m.truncated;
  await dbPut('chatMessages',m);
  liveSpans.forEach(function(s){s.remove()});
  refs.forEach(function(r){
    _wsFinalizeBubble(r,newContent,fullResults);
    var old=r.div.querySelector('.ws-continue-pill');if(old)old.remove();
    if(stillTrunc)r.txt.appendChild(_buildContinuePill(msgId));
    if(_wsPendingReads.length)r.txt.appendChild(_buildWsReadHint());
  });
  /* 续写可能追加 reasoning；当前对话整刷一次，确保思考面板与数据库立即一致。 */
  try{if(activeFriendId===m.friendId)loadChatMessages()}catch(e){}
  _contBusy.delete(msgId);
  if(!stillTrunc)toast('续写完成');
}

/* ══════════ BLOG 阅读申请（仅 1对1 聊天开放）══════════
   AI 输出 <blog_read name="日志标题"/>（长文可加 from="起始字符位" chars="长度" 分段）→
   界面在聊天卡内生成申请卡（标题、字符数、估算 token）→ 用户点「允许阅读」后正文进入待注入队列，
   并自动续答一轮；点「拒绝」只回传拒绝反馈。正文走末条消息尾部一次性注入，读完即回收，
   不写入聊天记录，不进入可缓存前缀。密码日记（locked）不进入匹配范围，视为不存在。
   申请卡与待注入内容均为会话内存态，刷新页面后失效，需重新申请（与工作区读取一致）。 */
const _BLOG_READ_INSTR_BLOCK='\n\n【Blog 阅读申请】用户的 Blog 日志可以申请阅读完整内容。需要阅读某篇日志时输出：\n<blog_read name="日志标题"/>\n规则：标题从上方日志列表获得，或由用户口头提供；提交后界面会向用户展示该篇字数并请求授权，用户点击允许后全文才会在下一条消息注入给你；未收到注入前不要声称已经读过；一次只申请一篇；被拒绝后不要重复申请同一篇，除非用户主动要求。长文可加 from="起始字符位"（1 起）与 chars="长度" 分段申请。';
var _blogReqReg={};/* 申请状态注册表：uid -> {state:'pending'|'allowed'|'denied',postId,title,...} */
var _blogPendingReads=[];/* 已允许待注入的日志内容（一次性，注入后清空） */
var _blogReadFeedback=[];/* 申请结果反馈（拒绝/未找到/多篇匹配），随下一条消息注入 */

function _parseBlogReadOps(text){
  var ops=[];if(!text||text.indexOf('<blog_read')===-1)return{clean:text,ops:ops};
  var clean=text.replace(/<blog_read\b([^>]*?)(?:\/>|>\s*<\/blog_read\s*>)/gi,function(_m,attrStr){
    var attrs={};String(attrStr||'').replace(/(\w+)\s*=\s*"([^"]*)"/g,function(__,k,v){attrs[k]=v;return''});
    ops.push({name:(attrs.name||'').trim(),from:parseInt(attrs.from,10)||0,chars:parseInt(attrs.chars,10)||0});
    return '';
  }).replace(/\n{3,}/g,'\n\n');
  return{clean:clean,ops:ops};
}

/* token 估算：中日韩字符每字按 1，其余字符每 4 个按 1；仅为参考值 */
function _blogTokenEst(s){s=String(s||'');var cjk=0,other=0;for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if((c>=0x4e00&&c<=0x9fff)||(c>=0x3400&&c<=0x4dbf)||(c>=0x3040&&c<=0x30ff)||(c>=0xac00&&c<=0xd7af)||(c>=0xf900&&c<=0xfaff))cjk++;else other++}return cjk+Math.ceil(other/4)}

/* 标题匹配：精确 → 唯一包含；多篇命中返回候选；locked 日志不进入匹配范围 */
async function _blogFindPost(name){
  var q=String(name||'').trim();
  if(!q)return{status:'notfound',name:q};
  var posts=(await dbGetAll('posts')).filter(function(p){return !isLockedPost(p)});
  var exact=posts.filter(function(p){return String(p.title||'').trim()===q});
  if(exact.length===1)return{status:'ok',post:exact[0]};
  var pool=exact.length>1?exact:posts.filter(function(p){return String(p.title||'').indexOf(q)!==-1});
  if(pool.length===1)return{status:'ok',post:pool[0]};
  if(pool.length>1)return{status:'multi',name:q,titles:pool.slice(0,8).map(function(p){return p.title||'无标题'})};
  return{status:'notfound',name:q};
}

/* 执行申请：生成卡片数据；未找到/多篇匹配的结果直接进反馈队列。每轮最多处理 3 个申请 */
async function _execBlogReadOps(ops){
  var cards=[];
  for(var i=0;i<ops.length&&i<3;i++){
    var op=ops[i];
    var r=await _blogFindPost(op.name);
    if(r.status==='ok'){
      var full=String(r.post.content||'');
      var from=Math.max(0,(op.from||0)-1);
      if(from>=full.length&&full.length>0){_blogReadFeedback.push('《'+(r.post.title||'无标题')+'》全文共 '+full.length+' 字符，from='+op.from+' 超出范围');cards.push({kind:'info',text:'申请的起始位置超出《'+(r.post.title||'无标题')+'》的全文范围'});continue}
      var segLen=op.chars>0?Math.min(op.chars,full.length-from):(full.length-from);
      var segTxt=full.slice(from,from+segLen);
      var uid='br_'+Date.now()+'_'+Math.floor(Math.random()*100000);
      _blogReqReg[uid]={state:'pending',postId:r.post.id,title:r.post.title||'无标题',from:op.from||0,chars:op.chars||0,charCount:segTxt.length,total:full.length,tokens:_blogTokenEst(segTxt)};
      cards.push({kind:'req',uid:uid});
    }else if(r.status==='multi'){
      _blogReadFeedback.push('日志名称「'+r.name+'」匹配到多篇：《'+r.titles.join('》《')+'》，请向用户确认是哪一篇后重新申请');
      cards.push({kind:'info',text:'「'+r.name+'」匹配到多篇日志，已请 AI 与你确认'});
    }else{
      _blogReadFeedback.push('日志「'+r.name+'」不存在，可向用户确认名称');
      cards.push({kind:'info',text:'未找到名为「'+r.name+'」的日志'});
    }
  }
  return cards;
}

function _brBuildCard(c){
  if(c.kind==='info'){
    var d=document.createElement('div');d.className='ws-op-card';
    d.innerHTML=WS_ICON.read+'<span class="ws-op-text">'+esc(c.text)+'</span>';
    return d;
  }
  var el=document.createElement('div');el.className='ws-op-card';el.dataset.blogreq=c.uid;
  el.style.flexWrap='wrap';
  _brRenderCard(el,c.uid);
  return el;
}
function _brRenderCard(el,uid){
  var req=_blogReqReg[uid];if(!req)return;
  var rangeTxt=(req.from>1||req.chars>0)?('第 '+Math.max(1,req.from||1)+' 字符起 '+req.charCount+' 字符（全文 '+req.total+' 字符）'):(req.charCount+' 字符');
  var head=WS_ICON.read+'<span class="ws-op-text"><b>阅读申请</b> · 《'+esc(req.title)+'》 · '+rangeTxt+' · 约 '+req.tokens.toLocaleString()+' tokens<br><span style="opacity:0.65;font-size:0.9em">允许后，全文将随下一条消息发送。</span></span>';
  if(req.state==='pending'){
    el.innerHTML=head;
    var ok=document.createElement('button');ok.className='ws-file-btn';ok.style.flexShrink='0';ok.textContent='允许阅读';
    ok.onclick=function(ev){ev.stopPropagation();_brAllow(uid)};
    var no=document.createElement('button');no.className='ws-file-btn';no.style.cssText='flex-shrink:0;opacity:0.7';no.textContent='拒绝';
    no.onclick=function(ev){ev.stopPropagation();_brDeny(uid)};
    el.appendChild(ok);el.appendChild(no);
  }else if(req.state==='allowed'){
    el.innerHTML=head+'<span class="ws-op-text" style="flex-basis:100%;opacity:0.75">已允许 · 内容随下一条消息注入</span>';
  }else{
    el.innerHTML=head+'<span class="ws-op-text" style="flex-basis:100%;opacity:0.75">已拒绝 · 内容未发送</span>';
  }
}
function _brUpdateCards(uid){document.querySelectorAll('[data-blogreq="'+uid+'"]').forEach(function(el){_brRenderCard(el,uid)})}

async function _brAllow(uid){
  var req=_blogReqReg[uid];if(!req||req.state!=='pending')return;
  var _tf=activeFriendId;
  if(_tf&&_chatSendingFor.has(_tf)){toast('对方正在回复中，请稍后再点允许');return}
  /* 允许瞬间按最新内容注入（申请后用户可能编辑过日志）；已删除或已转私密则作废 */
  var p=null;try{p=await dbGet('posts',req.postId)}catch(e){}
  if(!p||isLockedPost(p)){req.state='denied';_brUpdateCards(uid);_blogReadFeedback.push('《'+req.title+'》已不可读（被删除或转为私密），申请作废');toast('该日志已不可读，申请作废');return}
  var full=String(p.content||'');
  var from=Math.max(0,(req.from||0)-1);
  var segLen=req.chars>0?Math.min(req.chars,Math.max(0,full.length-from)):Math.max(0,full.length-from);
  var seg=full.slice(from,from+segLen);
  var range=(req.from>1||req.chars>0)?{from:from+1,to:from+seg.length,total:full.length}:null;
  _blogPendingReads.push({title:p.title||req.title,content:seg,range:range,total:full.length});
  req.state='allowed';_brUpdateCards(uid);
  /* 自动续答一轮：临时借用输入框触发发送，随后还原草稿与待发送附件（不让"请继续"带走它们） */
  var inp=currentPage==='chat'?document.getElementById('chat-full-input'):document.getElementById('chat-input');
  if(!inp)return;
  var _draft=inp.value;
  var _pi=_pendingImages,_pf=_pendingFiles;_pendingImages=[];_pendingFiles=[];
  inp.value='请继续';
  sendChatMessage();
  setTimeout(function(){
    if(inp.value===''||inp.value==='请继续')inp.value=_draft;
    if(!_pendingImages.length)_pendingImages=_pi;
    if(!_pendingFiles.length)_pendingFiles=_pf;
    try{renderImagePreviews();renderAttachPreviews()}catch(e){}
  },120);
}
function _brDeny(uid){
  var req=_blogReqReg[uid];if(!req||req.state!=='pending')return;
  req.state='denied';_brUpdateCards(uid);
  _blogReadFeedback.push('用户拒绝了阅读《'+req.title+'》的申请，内容未注入，请勿再次申请，除非用户主动要求');
}

/* 已允许的正文与申请结果反馈 → 末条消息尾部一次性注入 */
function _getBlogReadInjection(){
  if(!_blogPendingReads.length&&!_blogReadFeedback.length)return'';
  var ctx='';
  if(_blogPendingReads.length){
    var MAX=_ibInjectMax();
    ctx+='\n\n【Blog 日志内容（用户已允许阅读；仅本轮注入，后续轮次不再携带）】';
    _blogPendingReads.forEach(function(r){
      var body=r.content.length>MAX?r.content.slice(0,MAX)+'\n[…超过注入上限，已截断（本段原为 '+r.content.length+' 字符）；如需后续部分，请用 <blog_read name="'+r.title+'" from="'+(MAX+1)+'"/> 重新申请，仍需用户允许]':r.content;
      ctx+='\n--- 《'+r.title+'》'+(r.range?'（第 '+r.range.from+'–'+r.range.to+' 字符，全文共 '+r.range.total+' 字符）':'（全文 '+r.total+' 字符）')+' ---\n'+body;
      if(r.range&&r.range.to<r.range.total)ctx+='\n[后续内容未注入：继续阅读请用 <blog_read name="'+r.title+'" from="'+(r.range.to+1)+'"/> 重新申请，仍需用户允许]';
    });
    _blogPendingReads=[];
  }
  if(_blogReadFeedback.length){
    ctx+='\n\n【Blog 阅读申请结果】';
    _blogReadFeedback.forEach(function(f){ctx+='\n- '+f});
    _blogReadFeedback=[];
  }
  return ctx;
}

/* ── ws_read 后的续接提示卡：读取内容会在下一条消息注入，一键"继续" ── */
function _buildWsReadHint(){
  var c=document.createElement('div');c.className='ws-op-card';
  c.innerHTML=WS_ICON.read+'<span class="ws-op-text">文件内容已就绪，将在下一条消息注入给 AI</span>';
  var b=document.createElement('button');b.className='ws-file-btn';b.style.flexShrink='0';b.textContent='继续';
  b.onclick=function(ev){
    ev.stopPropagation();
    var inp=currentPage==='chat'?document.getElementById('chat-full-input'):document.getElementById('chat-input');
    if(!inp)return;
    if(!inp.value.trim())inp.value='请继续';
    c.remove();sendChatMessage();
  };
  c.appendChild(b);
  return c;
}


/* ── 底部存储信息条：ICode 实时占用（全部项目文件字节和）/ 浏览器为本站分配的总配额 ──
   打开窗口、列表重渲、AI 执行操作后都会重算；estimate() 不可用时只显示占用。 */
async function _wsUpdateStorage(){
  var box=document.getElementById('ws-storage');if(!box)return;
  try{
    var files=await dbGetAll('projectFiles');
    var used=0;files.forEach(function(f){used+=f.size||0});
    var quota=0;
    try{if(navigator.storage&&navigator.storage.estimate){var est=await navigator.storage.estimate();quota=est.quota||0}}catch(e){}
    var pct=quota>0?Math.min(100,used/quota*100):0;
    var width=used>0?Math.max(pct,0.6):0;/* 有内容时至少露出一丝用量 */
    box.innerHTML='<span class="ws-storage-label">Storage</span>'
      +'<span class="ws-storage-bar"><i style="width:'+width.toFixed(2)+'%"></i></span>'
      +'<span class="ws-storage-val">'+_fmtFileSize(used)+(quota>0?' / '+_fmtFileSize(quota):'')+'</span>';
  }catch(e){}
}

/* ══════════ ICode 悬浮窗管理器 ══════════
   打开（可拖拽/缩放的悬浮窗）↔ 收起。入口：右下组合坞 ICode 段 / 聊天工具栏按钮。
   位置与尺寸记忆到 localStorage；AI 操作项目时组合坞上的圆点点亮。 */
var _wsWinState=null;/* {x,y,w,h} 窗口位置尺寸 */
function _wsLoadWinState(){
  if(_wsWinState)return _wsWinState;
  try{_wsWinState=JSON.parse(localStorage.getItem('ib_wsWin')||'null')}catch(e){_wsWinState=null}
  return _wsWinState;
}
function _wsSaveWinState(){try{localStorage.setItem('ib_wsWin',JSON.stringify(_wsWinState))}catch(e){}}
function _wsClampWin(el){
  /* 防止拖出屏幕：横向至少留 120px 可抓取，纵向标题栏必须在屏内 */
  var r=el.getBoundingClientRect();
  var x=Math.max(120-r.width,Math.min(r.left,window.innerWidth-120));
  var y=Math.max(0,Math.min(r.top,window.innerHeight-48));
  el.style.left=x+'px';el.style.top=y+'px';el.style.right='auto';el.style.bottom='auto';
}
function _wsApplyWinState(el){
  var s=_wsLoadWinState();if(!s)return;
  if(s.w)el.style.width=Math.min(s.w,window.innerWidth-24)+'px';
  if(s.h)el.style.height=Math.min(s.h,window.innerHeight-16)+'px';
  if(typeof s.x==='number'&&typeof s.y==='number'){el.style.left=s.x+'px';el.style.top=s.y+'px';el.style.right='auto';el.style.bottom='auto'}
  _wsClampWin(el);
}

document.addEventListener('keydown',function(e){
  if(e.key!=='Escape')return;
  var ov=document.getElementById('ws-overlay');
  if(ov&&ov.style.display!=='none')wsBack();
});

/* ── 一次性入场动画：只在"从隐藏到显示"的瞬间播放，animationend 后立即摘除动画类。
   旧实现把 wsWinIn 常驻在 .ws-window 基类上，拖拽期间靠 .ws-dragging 的
   animation:none 压制；拖拽结束移除该类时动画规则重新生效并【从头重播】——
   窗口瞬间跳回透明+下移+缩小再淡入，即用户报告的"拖一下闪一下"。 ── */
function _wsPlayIn(el){
  el.classList.remove('ws-anim-in');
  void el.offsetWidth;/* 强制 reflow，保证下次能重新触发 */
  el.classList.add('ws-anim-in');
  var done=function(){el.classList.remove('ws-anim-in');el.removeEventListener('animationend',done)};
  el.addEventListener('animationend',done);
  setTimeout(done,450);/* 兜底：极端情况下 animationend 不触发也能摘除 */
}
/* 退场：淡出下沉后再真正隐藏；期间禁点，重复调用安全 */

/* ── 窗口开合 ── */
function openWorkspace(){
  var ov=document.getElementById('ws-overlay');if(!ov)return;
  var wasHidden=ov.style.display==='none';
  ov.style.display='flex';
  if(wasHidden){_wsApplyWinState(ov);_wsPlayIn(ov)}
  _wsSyncRunSwitch();
  /* 恢复收起前正在浏览的项目，否则回到项目列表 */
  if(_wsViewingProject)renderWsFiles(_wsViewingProject);
  else renderWsProjects();
}
function minimizeWorkspace(){/* 收起：入口在右下组合坞的 ICode 段或聊天工具栏按钮 */
  var ov=document.getElementById('ws-overlay');if(ov)ov.style.display='none';
}
function closeWorkspace(){
  var ov=document.getElementById('ws-overlay');if(ov)ov.style.display='none';
  _wsViewingProject=null;
}
function wsBack(){
  if(_wsViewingProject){_wsViewingProject=null;renderWsProjects()}
  else closeWorkspace();
}

/* ── 组合坞高度对齐：实测音乐播放器胶囊的渲染高度写入 --fab-h，
   保证右下角 Chat 胶囊 / ICode 滑纽与播放器像素级等高、底边对齐（字体加载与窗口变化后重测） ── */
function _fabSyncHeight(){
  try{
    var m=document.getElementById('music-mini');if(!m)return;
    var h=m.offsetHeight;
    if(h>10)document.documentElement.style.setProperty('--fab-h',h+'px');
  }catch(e){}
}
_fabSyncHeight();
window.addEventListener('resize',_fabSyncHeight);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){_fabSyncHeight()});


/* ── 拖拽 / 缩放初始化 ── */
(function(){
  function initWsWindow(){
    var win=document.getElementById('ws-overlay');
    var head=document.getElementById('ws-drag-handle');
    var rez=document.getElementById('ws-resize-handle');
    if(!win||!head)return;

    /* 通用拖拽：handle 上按下 → 拖动 target；返回本次是否发 */
    function dragify(handle,target,onEnd){
      var sx,sy,sl,st,dx=0,dy=0,moved=false,active=false,raf=0;
      function apply(){raf=0;target.style.transform='translate3d('+dx+'px,'+dy+'px,0)'}
      function down(cx,cy,ev){
        if(ev.target.closest('button')||ev.target.closest('input'))return false;
        active=true;moved=false;dx=0;dy=0;
        var r=target.getBoundingClientRect();
        sx=cx;sy=cy;sl=r.left;st=r.top;
        target.style.left=sl+'px';target.style.top=st+'px';
        target.style.right='auto';target.style.bottom='auto';
        target.classList.add('ws-dragging');
        return true;
      }
      function move(cx,cy){
        if(!active)return;
        dx=cx-sx;dy=cy-sy;
        if(Math.abs(dx)+Math.abs(dy)>4)moved=true;
        if(!raf)raf=requestAnimationFrame(apply);
      }
      function up(){
        if(!active)return;
        active=false;
        if(raf){cancelAnimationFrame(raf);raf=0}
        target.style.transform='';
        target.style.left=(sl+dx)+'px';target.style.top=(st+dy)+'px';
        target.classList.remove('ws-dragging');
        _wsClampWin(target);
        if(onEnd)onEnd(moved);
      }
      handle.addEventListener('mousedown',function(e){if(down(e.clientX,e.clientY,e))e.preventDefault()});
      document.addEventListener('mousemove',function(e){move(e.clientX,e.clientY)});
      document.addEventListener('mouseup',up);
      handle.addEventListener('touchstart',function(e){var t=e.touches[0];down(t.clientX,t.clientY,e)},{passive:true});
      document.addEventListener('touchmove',function(e){if(!active)return;var t=e.touches[0];move(t.clientX,t.clientY)},{passive:true});
      document.addEventListener('touchend',up);
    }

    /* 窗口标题栏拖拽 → 记忆位置 */
    dragify(head,win,function(){
      var r=win.getBoundingClientRect();
      _wsWinState={x:r.left,y:r.top,w:r.width,h:r.height};
      _wsSaveWinState();
    });

    /* ── 拖入导入：把文件/文件夹拖到 ICode 窗口上，蒙层提示 → 松手弹确认对话框 ── */
    var dropMask=document.createElement('div');
    dropMask.className='ws-drop-mask';
    dropMask.innerHTML=WS_ICON.folder+'<div>松开，导入到 ICode</div><small>支持项目文件夹与 .zip 压缩包 · 自动跳过依赖目录与非文本文件</small>';
    win.appendChild(dropMask);
    function _hasFiles(e){try{return Array.from((e.dataTransfer&&e.dataTransfer.types)||[]).indexOf('Files')>-1}catch(x){return false}}
    win.addEventListener('dragover',function(e){if(!_hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';dropMask.classList.add('show')});
    win.addEventListener('dragleave',function(e){if(e.relatedTarget&&win.contains(e.relatedTarget))return;dropMask.classList.remove('show')});
    win.addEventListener('drop',async function(e){
      if(!_hasFiles(e))return;
      e.preventDefault();dropMask.classList.remove('show');
      var col;
      try{col=await _icodeCollectDrop(e.dataTransfer)}catch(err){toast('读取拖入内容失败');return}
      if(!col.files.length){_icodeEmptyToast(col);return}
      _icodeShowImportDialog(col);
    });

    /* 右下角缩放（rAF 合帧） */
    if(rez){
      var rsx,rsy,rw,rh,rW,rH,ract=false,rraf=0;
      function rapply(){rraf=0;win.style.width=rW+'px';win.style.height=rH+'px'}
      function rdown(cx,cy){
        ract=true;
        var r=win.getBoundingClientRect();
        rsx=cx;rsy=cy;rw=r.width;rh=r.height;rW=rw;rH=rh;
        win.style.left=r.left+'px';win.style.top=r.top+'px';
        win.style.right='auto';win.style.bottom='auto';
        win.classList.add('ws-dragging');
      }
      function rmove(cx,cy){
        if(!ract)return;
        rW=Math.max(380,Math.min(rw+(cx-rsx),window.innerWidth-24));
        rH=Math.max(320,Math.min(rh+(cy-rsy),window.innerHeight-16));
        if(!rraf)rraf=requestAnimationFrame(rapply);
      }
      function rup(){
        if(!ract)return;
        ract=false;
        if(rraf){cancelAnimationFrame(rraf);rraf=0}
        win.style.width=rW+'px';win.style.height=rH+'px';
        win.classList.remove('ws-dragging');
        var r=win.getBoundingClientRect();
        _wsWinState={x:r.left,y:r.top,w:r.width,h:r.height};
        _wsSaveWinState();
      }
      rez.addEventListener('mousedown',function(e){rdown(e.clientX,e.clientY);e.preventDefault();e.stopPropagation()});
      document.addEventListener('mousemove',function(e){rmove(e.clientX,e.clientY)});
      document.addEventListener('mouseup',rup);
      rez.addEventListener('touchstart',function(e){var t=e.touches[0];rdown(t.clientX,t.clientY);e.stopPropagation()},{passive:true});
      document.addEventListener('touchmove',function(e){if(!ract)return;var t=e.touches[0];rmove(t.clientX,t.clientY)},{passive:true});
      document.addEventListener('touchend',rup);
    }

    /* 浏览器窗口变化时收回屏内 */
    window.addEventListener('resize',function(){
      if(win.style.display!=='none')_wsClampWin(win);
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initWsWindow);
  else initWsWindow();
})();
/* ── 项目重命名 ── */

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.workspace 登记全部导出 ---- */
function ibWsLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._parseWsOps=_parseWsOps;
window._wsArchiveFileBlocks=_wsArchiveFileBlocks;
window._wsExecImageGen=_wsExecImageGen;
window._wsCollectGenImages=_wsCollectGenImages;
window._execWsOps=_execWsOps;
window._buildWsOpCard=_buildWsOpCard;
window._processWsResponse=_processWsResponse;
window._getWsOpFeedbackInjection=_getWsOpFeedbackInjection;
window._wsCheckPhantom=_wsCheckPhantom;
window._buildWsPhantomHint=_buildWsPhantomHint;
window._getWsReadInjection=_getWsReadInjection;
window._wsMakeStreamWriters=_wsMakeStreamWriters;
window._wsMakeStreamFilter=_wsMakeStreamFilter;
window._wsFinalizeBubble=_wsFinalizeBubble;
window._buildContinuePill=_buildContinuePill;
window.continueTruncatedMsg=continueTruncatedMsg;
window._parseBlogReadOps=_parseBlogReadOps;
window._blogTokenEst=_blogTokenEst;
window._blogFindPost=_blogFindPost;
window._execBlogReadOps=_execBlogReadOps;
window._brBuildCard=_brBuildCard;
window._brRenderCard=_brRenderCard;
window._brUpdateCards=_brUpdateCards;
window._brAllow=_brAllow;
window._brDeny=_brDeny;
window._getBlogReadInjection=_getBlogReadInjection;
window._buildWsReadHint=_buildWsReadHint;
window._wsUpdateStorage=_wsUpdateStorage;
window._wsLoadWinState=_wsLoadWinState;
window._wsSaveWinState=_wsSaveWinState;
window._wsClampWin=_wsClampWin;
window._wsApplyWinState=_wsApplyWinState;
window._wsPlayIn=_wsPlayIn;
window.openWorkspace=openWorkspace;
window.minimizeWorkspace=minimizeWorkspace;
window.closeWorkspace=closeWorkspace;
window.wsBack=wsBack;
window._fabSyncHeight=_fabSyncHeight;
window._BLOG_READ_INSTR_BLOCK=_BLOG_READ_INSTR_BLOCK;
ibWsLive('_WS_CLAIM_RE', function(){return _WS_CLAIM_RE}, function(v){_WS_CLAIM_RE=v});
ibWsLive('_WS_STREAM_STARTS', function(){return _WS_STREAM_STARTS}, function(v){_WS_STREAM_STARTS=v});
ibWsLive('_contBusy', function(){return _contBusy}, function(v){_contBusy=v});
ibWsLive('_blogReqReg', function(){return _blogReqReg}, function(v){_blogReqReg=v});
ibWsLive('_blogPendingReads', function(){return _blogPendingReads}, function(v){_blogPendingReads=v});
ibWsLive('_blogReadFeedback', function(){return _blogReadFeedback}, function(v){_blogReadFeedback=v});
ibWsLive('_wsWinState', function(){return _wsWinState}, function(v){_wsWinState=v});
NS.expose('workspace', {
  _parseWsOps: _parseWsOps,
  _wsArchiveFileBlocks: _wsArchiveFileBlocks,
  _wsExecImageGen: _wsExecImageGen,
  _wsCollectGenImages: _wsCollectGenImages,
  _execWsOps: _execWsOps,
  _buildWsOpCard: _buildWsOpCard,
  _processWsResponse: _processWsResponse,
  _getWsOpFeedbackInjection: _getWsOpFeedbackInjection,
  _wsCheckPhantom: _wsCheckPhantom,
  _buildWsPhantomHint: _buildWsPhantomHint,
  _getWsReadInjection: _getWsReadInjection,
  _wsMakeStreamWriters: _wsMakeStreamWriters,
  _wsMakeStreamFilter: _wsMakeStreamFilter,
  _wsFinalizeBubble: _wsFinalizeBubble,
  _buildContinuePill: _buildContinuePill,
  continueTruncatedMsg: continueTruncatedMsg,
  _parseBlogReadOps: _parseBlogReadOps,
  _blogTokenEst: _blogTokenEst,
  _blogFindPost: _blogFindPost,
  _execBlogReadOps: _execBlogReadOps,
  _brBuildCard: _brBuildCard,
  _brRenderCard: _brRenderCard,
  _brUpdateCards: _brUpdateCards,
  _brAllow: _brAllow,
  _brDeny: _brDeny,
  _getBlogReadInjection: _getBlogReadInjection,
  _buildWsReadHint: _buildWsReadHint,
  _wsUpdateStorage: _wsUpdateStorage,
  _wsLoadWinState: _wsLoadWinState,
  _wsSaveWinState: _wsSaveWinState,
  _wsClampWin: _wsClampWin,
  _wsApplyWinState: _wsApplyWinState,
  _wsPlayIn: _wsPlayIn,
  openWorkspace: openWorkspace,
  minimizeWorkspace: minimizeWorkspace,
  closeWorkspace: closeWorkspace,
  wsBack: wsBack,
  _fabSyncHeight: _fabSyncHeight,
  _BLOG_READ_INSTR_BLOCK: _BLOG_READ_INSTR_BLOCK,
  _WS_CLAIM_RE: _WS_CLAIM_RE,
  _WS_STREAM_STARTS: _WS_STREAM_STARTS,
  _contBusy: _contBusy,
  _blogReqReg: _blogReqReg,
  _blogPendingReads: _blogPendingReads,
  _blogReadFeedback: _blogReadFeedback,
  _wsWinState: _wsWinState,
});
})(window.IB || (window.IB = {}));
