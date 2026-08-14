/* WORKSPACE RUN —— 脚本沙箱（JS 一次性 Worker / Pyodide 常驻 Worker、超时强杀、写回项目、输出回注队列、询问模式待运行卡）。自 workspace.js 机械提取（只动位置，不改逻辑；加载于 workspace.js 之前）。 */
(function(NS){
/* ══════════ ws_run：脚本沙箱运行 ══════════
   AI 输出 <ws_run> 指令（或用户在预览面板点「运行」）→ 脚本在浏览器沙箱里执行：
   · JS：一次性 Web Worker（无 DOM、可强杀），console/print 捕获
   · Python：常驻 Pyodide Worker（首次从 CDN 下载运行时 ~10MB，之后走缓存；仅标准库、无网络无 pip）
   运行前把当前项目的全部文本文件挂载进沙箱（Python 可直接 import 同项目模块），
   运行后把脚本新建/修改的文件写回项目（同名直接覆盖——存档语义），
   输出/报错排进 _wsPendingRunOutputs，下一条消息精准回注给发起成员（群聊按名字派发）。
   安全阀：默认「每次询问」，AI 的脚本先出待运行卡、用户点击才执行；ICode 底栏可切「自动」。 */
var _wsRunBusy=false;
var _wsPendingRunOutputs=[];/* 待注入的脚本输出 */
var _wsPyWorker=null,_wsPyLoaded=false;
var WS_RUN_JS_TIMEOUT=20000,WS_RUN_PY_TIMEOUT=20000,WS_RUN_OUT_CAP=20000;/* ICODE-FIX: JS 默认超时 10s→20s，对齐指令块/文档承诺的"默认 20 秒" */
function _wsRunMode(){try{return localStorage.getItem('ib_wsRunMode')==='auto'?'auto':'ask'}catch(e){return 'ask'}}
function _wsToggleRunMode(){try{localStorage.setItem('ib_wsRunMode',_wsRunMode()==='auto'?'ask':'auto')}catch(e){}_wsSyncRunSwitch();toast('AI 提交的脚本改为「'+(_wsRunMode()==='auto'?'自动运行':'每次询问')+'」')}
/* 标题栏 Script 开关状态同步：on = 自动运行 */
function _wsSyncRunSwitch(){var s=document.getElementById('ws-run-switch');if(!s)return;var on=_wsRunMode()==='auto';s.classList.toggle('on',on);s.setAttribute('aria-pressed',on?'true':'false')}
function _wsRunLangOf(op){
  var l=String(op.lang||'').toLowerCase();
  if(/^(py|python)$/.test(l))return 'python';
  if(/^(js|javascript|node)$/.test(l))return 'js';
  var en=op.entry||'';
  if(/\.py$/i.test(en))return 'python';
  if(/\.(js|mjs)$/i.test(en))return 'js';
  return '';
}
function _wsRunGatherFiles(projFiles){
  var map={},total=0;
  (projFiles||[]).forEach(function(f){
    if(!f||!f.path||typeof f.content!=='string')return;
    if(f.content.slice(0,5)==='data:')return;/* 二进制 dataURL 不挂载 */
    if(f.content.length>1000000)return;
    if(total+f.content.length>6000000)return;
    if(/[\\]|\.\./.test(f.path))return;
    map[f.path]=f.content;total+=f.content.length;
  });
  return map;
}
/* —— JS 沙箱 Worker 源码（每次运行一枚，一次性用完即弃） —— */
var _WS_JS_WORKER_SRC=[
IBSandbox.JS_HARDEN,/* 禁 fetch/XHR/importScripts/indexedDB/caches/WebSocket/EventSource */
'self.onmessage=async function(e){',
' var d=e.data,files=d.files||{},out=[],changed={};',
' function fmt(a){try{if(typeof a==="object"&&a!==null)return JSON.stringify(a);return String(a)}catch(_){return String(a)}}',
' function push(){out.push(Array.prototype.map.call(arguments,fmt).join(" "))}',
' var api={log:push,info:push,warn:push,error:function(){out.push("[error] "+Array.prototype.map.call(arguments,fmt).join(" "))}};',
' var readFile=function(n){return Object.prototype.hasOwnProperty.call(files,n)?files[n]:null};',
' var save=function(n,c){n=String(n);if(n.length>200||n.indexOf("..")!==-1)return;changed[n]=String(c);files[n]=String(c)};',
' var src=d.entry?files[d.entry]:d.code;',
' if(typeof src!=="string"){postMessage({ok:false,errText:"入口文件不存在: "+d.entry,output:"",changed:{}});return}',
' try{',
'  var AF=Object.getPrototypeOf(async function(){}).constructor;',
'  var fn=new AF("console","readFile","save","files","print",src);',
'  var r=await fn(api,readFile,save,files,push);',
'  if(r!==undefined)out.push("[return] "+fmt(r));',
'  postMessage({ok:true,output:out.join("\\n").slice(0,20000),changed:changed});',
' }catch(err){postMessage({ok:false,errText:String(err&&(err.stack||err.message)||err).slice(0,4000),output:out.join("\\n").slice(0,20000),changed:changed})}',
'};'
].join('\n');
function _wsRunJs(code,entry,files,timeoutMs){
  return new Promise(function(resolve){
    var url,w;
    try{
      url=URL.createObjectURL(new Blob([_WS_JS_WORKER_SRC],{type:'text/javascript'}));
      w=new Worker(url);
    }catch(e){resolve({ok:false,errText:'无法创建运行沙箱: '+String(e&&e.message||e),output:'',changed:{}});return}
    var t0=Date.now(),done=false;
    function fin(res){if(done)return;done=true;try{w.terminate()}catch(_){}try{URL.revokeObjectURL(url)}catch(_){}res.ms=Date.now()-t0;resolve(res)}
    var timer=setTimeout(function(){fin({ok:false,timedOut:true,errText:'超时（'+Math.round(timeoutMs/1000)+'s），已强制终止（若脚本里有死循环请修正）',output:'',changed:{}})},timeoutMs);
    w.onmessage=function(e){clearTimeout(timer);fin(e.data||{ok:false,errText:'空响应',output:'',changed:{}})};
    w.onerror=function(err){clearTimeout(timer);fin({ok:false,errText:'沙箱错误: '+String(err&&err.message||err).slice(0,300),output:'',changed:{}})};
    try{w.postMessage({code:code,entry:entry,files:files})}catch(e){clearTimeout(timer);fin({ok:false,errText:'无法发送脚本: '+String(e&&e.message||e),output:'',changed:{}})}
  });
}
/* —— Python 沙箱 Worker 源码（常驻复用；超时即整体弃掉，下次重建） —— */
var _WS_PY_WORKER_SRC=[
'var P="https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";',
'importScripts(P+"pyodide.js");',
'var ready=loadPyodide({indexURL:P});',
'self.onmessage=async function(e){',
' var d=e.data,out=[],py=null;',
' function put(s){if(out.length<4000)out.push(String(s))}',
' function collect(){',
'  var ch={},c=0;',
'  if(!py)return ch;',
'  try{py.FS.readdir("/proj").forEach(function(n){',
'   if(n==="."||n===".."||c>=20)return;',
'   var p="/proj/"+n,st;',
'   try{st=py.FS.stat(p)}catch(_){return}',
'   if(!py.FS.isFile(st.mode)||st.size>1000000)return;',
'   var t;try{t=py.FS.readFile(p,{encoding:"utf8"})}catch(_){return}',
'   if(d.files[n]!==t){ch[n]=t;c++}',
'  })}catch(_){}',
'  return ch;',
' }',
' function grabFigs(){if(!py)return[];try{return JSON.parse(py.runPython("import json\\n__ib_fr=json.dumps(__ib_figs())\\n__ib_fr"))}catch(_){return[]}}',
' try{',
'  py=await ready;',
'  py.setStdout({batched:put});py.setStderr({batched:put});',
'  py.runPython('+JSON.stringify(IBSandbox.PY_SETUP)+');',
'  py.runPython('+JSON.stringify(IBSandbox.PY_FIGS)+');',
'  try{py.FS.mkdir("/proj")}catch(_){}',
'  try{py.FS.readdir("/proj").forEach(function(n){if(n==="."||n==="..")return;try{var st=py.FS.stat("/proj/"+n);if(py.FS.isFile(st.mode))py.FS.unlink("/proj/"+n)}catch(_){}})}catch(_){}',
'  for(var name in d.files){if(name.indexOf("/")!==-1||name.indexOf("\\\\")!==-1)continue;try{py.FS.writeFile("/proj/"+name,d.files[name])}catch(_){}}',
'  py.runPython(["import os,sys","os.chdir(\'/proj\')","if \'/proj\' not in sys.path:","    sys.path.insert(0,\'/proj\')"].join("\\n"));',
'  var _dsrc=(d.entry?String(d.files[d.entry]||""):String(d.code||""));',
'  if(/^\\s*(import|from)\\s+(numpy|matplotlib|pandas|scipy|sympy|networkx)/m.test(_dsrc)||(d.pip&&d.pip.length))postMessage({__pkgLoad:1});',
'  try{await py.loadPackagesFromImports(_dsrc)}catch(_){}',
'  if(d.pip&&d.pip.length){try{await py.loadPackage("micropip");var _mp=py.pyimport("micropip");await _mp.install(py.toPy(d.pip));_mp.destroy()}catch(_e){put("[pip] 安装失败: "+String(_e&&_e.message||_e).slice(0,300))}}',
'  var code=d.entry?("import runpy\\nrunpy.run_path("+JSON.stringify(d.entry)+", run_name=\'__main__\')"):d.code;',
'  var r;',
'  try{r=await py.runPythonAsync(code)}',
'  catch(perr){postMessage({ok:false,errText:String(perr&&perr.message||perr).slice(0,4000),output:out.join("\\n").slice(0,20000),changed:collect(),images:grabFigs()});return}',
'  if(r!==undefined&&r!==null){var s="";try{s=r.toString()}catch(_){s=""}if(s&&s!=="undefined"&&s!=="None")put(s);try{if(typeof r.destroy==="function")r.destroy()}catch(_){}}',
'  postMessage({ok:true,output:out.join("\\n").slice(0,20000),changed:collect(),images:grabFigs()});',
' }catch(err){postMessage({ok:false,errText:String(err&&err.message||err).slice(0,4000)+"（Python 运行时需联网加载）",output:out.join("\\n").slice(0,20000),changed:{}})}',
'};'
].join('\n');
function _wsEnsurePyWorker(){
  if(_wsPyWorker)return _wsPyWorker;
  var url=URL.createObjectURL(new Blob([_WS_PY_WORKER_SRC],{type:'text/javascript'}));
  _wsPyWorker=new Worker(url);
  return _wsPyWorker;
}
function _wsRunPy(code,entry,files,timeoutMs,pip){
  return new Promise(function(resolve){
    var w;
    try{w=_wsEnsurePyWorker()}catch(e){resolve({ok:false,errText:'无法创建运行沙箱: '+String(e&&e.message||e),output:'',changed:{}});return}
    var t0=Date.now(),done=false;
    var grace=_wsPyLoaded?0:90000;/* 首次给下载运行时留时间 */
    function fin(res){if(done)return;done=true;res.ms=Date.now()-t0;resolve(res)}
    var timer=setTimeout(function(){
      try{w.terminate()}catch(_){}
      _wsPyWorker=null;
      fin({ok:false,timedOut:true,errText:'超时（'+Math.round(timeoutMs/1000)+'s'+(grace?' + 加载宽限':'')+'），已强制终止'+(_wsPyLoaded?'':'；如果是首次运行，可能是 Python 运行时下载失败（需要联网）'),output:'',changed:{}});
    },timeoutMs+grace);
    w.onmessage=function(e){
      if(e.data&&e.data.__pkgLoad){/* 科学包/pip 下载中：一次性放宽计时（首装 numpy/matplotlib 可达数十秒） */
        clearTimeout(timer);
        timer=setTimeout(function(){try{w.terminate()}catch(_){}_wsPyWorker=null;fin({ok:false,timedOut:true,errText:'超时（科学包下载中被终止；网络恢复后可重试）',output:'',changed:{}})},timeoutMs+90000);
        return}
      clearTimeout(timer);_wsPyLoaded=true;fin(e.data||{ok:false,errText:'空响应',output:'',changed:{}})};
    w.onerror=function(err){clearTimeout(timer);try{w.terminate()}catch(_){}_wsPyWorker=null;fin({ok:false,errText:'沙箱错误: '+String(err&&err.message||err).slice(0,300)+'（Python 运行时需联网加载）',output:'',changed:{}})};
    try{w.postMessage({code:code,entry:entry,files:files,pip:pip||[]})}catch(e){clearTimeout(timer);fin({ok:false,errText:'无法发送脚本: '+String(e&&e.message||e),output:'',changed:{}})}
  });
}
/* —— 执行 + 写回（供自动模式 / 待运行卡 / 预览面板共用） —— */
async function _wsExecuteRun(ctx){
  if(_wsRunBusy)return{ok:false,busy:true,errText:'上一个脚本仍在运行，请稍后再试',output:'',changed:{},changedNames:[]};
  _wsRunBusy=true;
  try{
    var lang=_wsRunLangOf(ctx);
    if(!lang)return{ok:false,errText:'无法识别脚本语言：请写 lang="python" 或 lang="js"，或提供带扩展名的 entry',output:'',changed:{},changedNames:[]};
    var pf=await wsGetFiles(ctx.projId);
    var files=_wsRunGatherFiles(pf);
    if(ctx.entry&&files[ctx.entry]===undefined)return{ok:false,errText:'入口文件不存在于当前项目: '+ctx.entry,output:'',changed:{},changedNames:[]};
    var tms=Math.min(Math.max((ctx.timeoutSec|0)||0,0),120)*1000||(lang==='python'?WS_RUN_PY_TIMEOUT:WS_RUN_JS_TIMEOUT);
    var _pipArr=[];
    if(ctx.pip){
      _pipArr=Array.isArray(ctx.pip)?ctx.pip:(typeof IBSandbox!=='undefined'?IBSandbox.parsePipAttr(ctx.pip):[]);
      if(typeof IBSandbox!=='undefined'){var _pc=IBSandbox.checkPip(_pipArr);if(!_pc.ok)return{ok:false,errText:'pip 包未在白名单: '+_pc.denied.join(', ')+'（DIY 页·沙箱扩展中添加后重试）',output:'',changed:{},changedNames:[]}}
    }
    var res=lang==='python'?await _wsRunPy(ctx.code||'',ctx.entry||'',files,tms,_pipArr):await _wsRunJs(ctx.code||'',ctx.entry||'',files,tms);
    res.lang=lang;
    if(res.images&&typeof IBSandbox!=='undefined')res.images=IBSandbox.capImages(res.images);
    /* 写回：脚本新建/修改的文件覆盖同名入库（存档语义），作者记为「脚本」 */
    /* ICODE-FIX: 写回上限（单文件 100 万字符 / 单次 20 个）此前仅 Python 端在收集时限制单文件体量，
       JS 端 save() 无体量上限、超过 20 个的文件被静默丢弃。改为在此统一钳制，并把被跳过的内容反馈给 AI */
    var names=[],wbSkipped=[];
    if(res.changed){
      var _wbKeys=Object.keys(res.changed);
      for(var _wi=0;_wi<_wbKeys.length;_wi++){
        if(names.length>=20){wbSkipped.push('其余 '+(_wbKeys.length-_wi)+' 个文件超出单次 20 个写回上限');break}
        var n=_wbKeys[_wi],c=res.changed[n];
        if(typeof c!=='string')continue;
        if(c.length>1000000){wbSkipped.push(n+'（超过 100 万字符写回上限）');continue}
        try{await wsSaveFile(ctx.projId,n,c,'脚本');names.push(n)}catch(e){}
      }
    }
    res.changedNames=names;
    if(wbSkipped.length)res.writebackSkipped=wbSkipped;
    try{
      var _w=document.getElementById('ws-overlay');
      if(_w&&_w.style.display!=='none'&&_w.style.display!==''){if(_wsViewingProject)renderWsFiles(_wsViewingProject);else renderWsProjects()}
      _wsUpdateStorage();
    }catch(e){}
    return res;
  }finally{_wsRunBusy=false}
}
/* —— 输出回注队列（带执行者名字，群聊精准派发；与读取/反馈同一套消费协议） —— */
function _wsQueueRunOutput(ctx,res){
  var srcName=ctx.entry?ctx.entry:'内联代码';
  var head=res.ok?('脚本运行完成（'+srcName+(res.ms?'，'+(res.ms/1000).toFixed(1)+'s':'')+'）'):(res.timedOut?('脚本运行超时（'+srcName+'）'):('脚本运行失败（'+srcName+'）'));
  var body='';
  var outp=(res.output||'').slice(0,4000);
  if(outp)body+='\n--- 输出 ---\n'+outp+((res.output||'').length>4000?'\n[输出过长已截断]':'');
  if(res.errText)body+='\n--- 错误 ---\n'+String(res.errText).slice(0,1500);
  if(res.changedNames&&res.changedNames.length)body+='\n[脚本已写回项目文件: '+res.changedNames.join(', ')+']';
  if(res.images&&res.images.length)body+='\n[已生成图表 '+res.images.length+' 张，展示在聊天的运行卡片中]';
  if(res.writebackSkipped&&res.writebackSkipped.length)body+='\n[部分内容未写回: '+res.writebackSkipped.join('；')+']';
  if(!body)body='\n（无输出。请用 print / console.log 打印你需要看到的内容）';
  _wsPendingRunOutputs.push({actor:ctx.author,text:head+body});
}
function _getWsRunOutputInjection(filterFn){
  if(!_wsPendingRunOutputs.length)return'';
  var take,keep=[];
  if(typeof filterFn==='function'){take=[];_wsPendingRunOutputs.forEach(function(it){(filterFn(it)?take:keep).push(it)})}
  else{take=_wsPendingRunOutputs}
  _wsPendingRunOutputs=keep;
  if(!take.length)return'';
  var ctx='\n\n【脚本运行输出】此前提交的脚本已在浏览器沙箱中执行完毕，结果如下（据此继续；失败请修正后重发 <ws_run>）：';
  take.forEach(function(s){ctx+='\n'+s.text});
  return ctx;
}
/* —— 待运行卡的「运行」按钮 —— */
async function _wsConfirmRunFromCard(btn,ctx,card){
  btn.disabled=true;btn.textContent='运行中…';
  if(ctx.lang!=='js'&&!_wsPyLoaded&&_wsRunLangOf(ctx)==='python')toast('正在准备 Python 运行时（首次约 10MB，需联网）…');
  var res=await _wsExecuteRun(ctx);
  if(res.busy){btn.disabled=false;btn.textContent='运行';toast(res.errText);return}
  _wsQueueRunOutput(ctx,res);
  btn.remove();
  var t=card.querySelector('.ws-op-text');
  if(t)t.innerHTML=esc(res.ok?('脚本运行完成'+(res.ms?'（'+(res.ms/1000).toFixed(1)+'s）':'')):(res.timedOut?'脚本运行超时':'脚本运行失败'))+' · <b>'+esc(ctx.entry||'内联代码')+'</b>';
  if(!res.ok)card.classList.add('fail');
  var det=card.querySelector('.ws-op-detail');
  if(det){
    var o=document.createElement('div');o.className='ws-run-out';
    o.textContent=(res.output||'')+(res.errText?((res.output?'\n':'')+'[错误] '+res.errText):'')+(res.changedNames&&res.changedNames.length?'\n[已写回: '+res.changedNames.join(', ')+']':'')||'（无输出）';
    det.appendChild(o);
    card.classList.add('expanded');
  }
  toast(res.ok?'脚本运行完成，输出将在下一条消息回传给 AI':'脚本运行失败，失败信息将回传给 AI');
}
/* —— 预览面板 / 文件行的手动运行（用户发起，不受「询问」模式限制） —— */
async function wsRunFileFromUI(fileId){
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f){toast('文件不存在');return}
  if(_wsRunBusy){toast('上一个脚本仍在运行');return}
  var isPy=/\.py$/i.test(f.path);
  toast(isPy&&!_wsPyLoaded?'正在准备 Python 运行时（首次约 10MB，需联网）…':'运行中…');
  var res=await _wsExecuteRun({lang:isPy?'python':'js',entry:f.path,code:'',projId:f.projectId,timeoutSec:0,author:'User'});
  await renderWsFiles(f.projectId);
  await wsTogglePreview(fileId);
  var pv=document.getElementById('wsp-'+fileId);
  if(pv){
    var old=pv.querySelector('.ws-run-out');if(old)old.remove();
    var o=document.createElement('div');o.className='ws-run-out';
    o.textContent=(res.ok?('✓ 运行完成'+(res.ms?'（'+(res.ms/1000).toFixed(1)+'s）':'')):(res.timedOut?'✕ 运行超时':'✕ 运行失败'))
      +((res.output)?'\n'+res.output:'')
      +(res.errText?'\n[错误] '+res.errText:'')
      +(res.changedNames&&res.changedNames.length?'\n[已写回: '+res.changedNames.join(', ')+']':'');
    pv.appendChild(o);
  }
}

/* ---- 双挂载：communication.js 发送路径（_getWsRunOutputInjection）与父文件卡片模板内联 onclick（_wsConfirmRunFromCard / wsRunFileFromUI）仍经 window 访问；IB.workspace.run 登记导出 ---- */
function ibWsRunLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._wsRunMode=_wsRunMode;
window._wsToggleRunMode=_wsToggleRunMode;
window._wsSyncRunSwitch=_wsSyncRunSwitch;
window._wsRunLangOf=_wsRunLangOf;
window._wsRunGatherFiles=_wsRunGatherFiles;
window._wsRunJs=_wsRunJs;
window._wsEnsurePyWorker=_wsEnsurePyWorker;
window._wsRunPy=_wsRunPy;
window._wsExecuteRun=_wsExecuteRun;
window._wsQueueRunOutput=_wsQueueRunOutput;
window._getWsRunOutputInjection=_getWsRunOutputInjection;
window._wsConfirmRunFromCard=_wsConfirmRunFromCard;
window.wsRunFileFromUI=wsRunFileFromUI;
ibWsRunLive('_wsRunBusy', function(){return _wsRunBusy}, function(v){_wsRunBusy=v});
ibWsRunLive('_wsPendingRunOutputs', function(){return _wsPendingRunOutputs}, function(v){_wsPendingRunOutputs=v});
ibWsRunLive('_wsPyWorker', function(){return _wsPyWorker}, function(v){_wsPyWorker=v});
ibWsRunLive('WS_RUN_JS_TIMEOUT', function(){return WS_RUN_JS_TIMEOUT}, function(v){WS_RUN_JS_TIMEOUT=v});
ibWsRunLive('_WS_JS_WORKER_SRC', function(){return _WS_JS_WORKER_SRC}, function(v){_WS_JS_WORKER_SRC=v});
ibWsRunLive('_WS_PY_WORKER_SRC', function(){return _WS_PY_WORKER_SRC}, function(v){_WS_PY_WORKER_SRC=v});
ibWsRunLive('_wsPyLoaded', function(){return _wsPyLoaded}, function(v){_wsPyLoaded=v});
ibWsRunLive('WS_RUN_PY_TIMEOUT', function(){return WS_RUN_PY_TIMEOUT}, function(v){WS_RUN_PY_TIMEOUT=v});
ibWsRunLive('WS_RUN_OUT_CAP', function(){return WS_RUN_OUT_CAP}, function(v){WS_RUN_OUT_CAP=v});
NS.expose('workspace.run', {
  _wsRunMode: _wsRunMode,
  _wsToggleRunMode: _wsToggleRunMode,
  _wsSyncRunSwitch: _wsSyncRunSwitch,
  _wsRunLangOf: _wsRunLangOf,
  _wsRunGatherFiles: _wsRunGatherFiles,
  _wsRunJs: _wsRunJs,
  _wsEnsurePyWorker: _wsEnsurePyWorker,
  _wsRunPy: _wsRunPy,
  _wsExecuteRun: _wsExecuteRun,
  _wsQueueRunOutput: _wsQueueRunOutput,
  _getWsRunOutputInjection: _getWsRunOutputInjection,
  _wsConfirmRunFromCard: _wsConfirmRunFromCard,
  wsRunFileFromUI: wsRunFileFromUI,
  _wsRunBusy: _wsRunBusy,
  _wsPendingRunOutputs: _wsPendingRunOutputs,
  _wsPyWorker: _wsPyWorker,
  WS_RUN_JS_TIMEOUT: WS_RUN_JS_TIMEOUT,
  _WS_JS_WORKER_SRC: _WS_JS_WORKER_SRC,
  _WS_PY_WORKER_SRC: _WS_PY_WORKER_SRC,
  _wsPyLoaded: _wsPyLoaded,
  WS_RUN_PY_TIMEOUT: WS_RUN_PY_TIMEOUT,
  WS_RUN_OUT_CAP: WS_RUN_OUT_CAP,
});
})(window.IB || (window.IB = {}));
