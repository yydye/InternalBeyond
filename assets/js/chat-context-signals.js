/* ============================================================
   Chat Context Signals — 可选上下文的逐轮注入信号（只读事实源聚合）
   ------------------------------------------------------------
   问题：普通单聊每一轮都把「ICode 工作区指令 / 网站日志 / Blog 阅读申请 /
   文件输出 / 联网搜索使用规则」等可选说明无条件拼进 system，与当轮语义无关，
   造成 4K+ 字符的恒定注入（见 .dsh-research/token-audit/TOKEN-PROVENANCE-AUDIT-P2.md）。

   契约（本次改动的唯一原则）：
   1. 本模块**只聚合已存在的结构化事实源**，不新增任何"角色表 / 状态表"：
      · ICode 待注入队列（_wsPendingReads / _wsPendingOpFeedback …）
      · 本轮附件（sentFiles / _pendingFiles，即 workspace.js 归档的「User」文件夹来源）
      · 历史里真实存在的工作区操作标签（模型上一轮确实产出过 <ws_…>）
      · ICode 悬浮窗开合状态（DOM 事实）
      · 角色配置里的能力开关（cfg.imageGen / cfg.webSearch）
      · 数据库里真实的实体名（projects / projectFiles / posts 的 name / path / title）
   2. **禁止关键词清单式判定**。"文件/代码/博客/图片/搜索/日历" 这类词表会立刻腐化；
      文本意图只作为末端兜底，且只承认"明确的祈使式文件/代码操作请求"这一条，
      与 integrations.js 既有的 IBWS.FILE_RE / IBWS.fileTurn（唯一真源）配合使用。
   3. 全部判定只读、失败即 fail-safe（返回 false / 不注入），绝不改变任何能力本身是否可用。
   ============================================================ */
(function(NS){
'use strict';

/* ── 末端兜底 ①：明确祈使式的文件 / 代码操作请求 ──
   只在"没有任何结构化信号"时才被问到，且必须同时出现
   编写类动作（写/做/生成/改/新建/创建/编辑/整理/重构/翻译/实现/补/加 …）
   与制品类名词（文件/文档/表格/代码/脚本/程序/项目/工作区/附件/PDF/Excel/PPT…）。
   单说"代码"、"文件"不触发——那类提及常常与操作无关。 */
var _WRITE_ACT_RE=/[写做改生成建创编整重构翻译实现补加转存导]|整理|新建|创建|编辑|修改|重构|翻译|实现/;
var _ARTIFACT_RE=/文件|文档|表格|代码|脚本|程序|工程|项目|工作区|附件|压缩包|幻灯片|简历|报告|清单|模板|pdf|xlsx?|docx?|pptx?|csv|markdown|\bjson\b|\bhtml?\b|\bpython\b|\bjavascript\b|\btypescript\b|\.py\b|\.js\b|\.ts\b|\.md\b|\.zip\b|\.txt\b/i;
/* ── 末端兜底 ②：指名请求"工作区/项目/文件"类操作（索引式提及） ──
   "帮我在工作区里…" "这个项目加个文件"：即使没有具体制品名词，也是明确的入口状态。 */
var _WS_ASK_RE=/工作区|ICode|项目里|项目下|这个项目|该文件|这个文件|那个文件|附件里|上传的(文件|图片)/i;

function _s(v){return String(v==null?'':v)}

/* ── 结构化信号：ICode 待注入队列是否非空 ──
   非空 = 上一轮确实发生了工作区操作（ws_read / ws_run / ws_create…）且结果尚未回传。
   这是"工作区正在使用中"最强的结构化证据，与回复文本无关。 */
function _hasPendingWsInjection(){
  try{
    if(typeof _wsPendingReads!=='undefined'&&_wsPendingReads&&_wsPendingReads.length)return true;
    if(typeof _wsPendingOpFeedback!=='undefined'&&_wsPendingOpFeedback&&_wsPendingOpFeedback.length)return true;
    if(typeof _wsPendingRunOutputs!=='undefined'&&_wsPendingRunOutputs&&_wsPendingRunOutputs.length)return true;
  }catch(e){}
  return false;
}

/* ── 结构化信号：本轮附件（含 workspace.js 从 ICode 送进来的 _fromWs 附件） ──
   调用方可以传本轮真实落库的附件数组（sentFiles），否则回落到附件栏的当前状态。 */
function _hasAttachments(sig){
  try{
    var a=sig&&sig.attachments;
    if(a!=null)return Array.isArray(a)?a.length>0:(a|0)>0;
    if(typeof _pendingFiles!=='undefined'&&_pendingFiles&&_pendingFiles.length)return true;
    if(typeof _pendingImages!=='undefined'&&_pendingImages&&_pendingImages.length)return true;
  }catch(e){}
  return false;
}

/* ── 结构化信号：用户消息里是否**逐字**提到了真实存在的工作区项目名 / 文件名 ──
   直接拿数据库里的实体名做匹配，不维护任何词表：
   说得出名字就说明用户此刻在谈这个项目/文件。 */
async function _mentionsRealWorkspaceEntry(text){
  var t=_s(text);
  if(t.length<2)return false;
  try{
    var projects=await dbGetAll('projects');
    for(var i=0;i<(projects||[]).length;i++){
      var pn=_s(projects[i]&&projects[i].name).trim();
      if(pn.length>1&&t.indexOf(pn)>=0)return true;
    }
    var files=await dbGetAll('projectFiles');
    for(var j=0;j<(files||[]).length;j++){
      var fp=_s(files[j]&&files[j].path).trim();
      if(!fp)continue;
      if(t.indexOf(fp)>=0)return true;
      var base=fp.split('/').pop();
      if(base&&base.length>2&&t.indexOf(base)>=0)return true;
    }
  }catch(e){}
  return false;
}

/* ── 结构化信号：历史里真实出现过工作区操作标签（模型上一轮确实在操作工作区） ──
   只扫末尾若干条：更早的历史位于缓存断点之前，且"当前是否还在工作区"由末尾决定。 */
function _hasRecentWsTags(history){
  try{
    var n=(history&&history.length)||0;
    for(var i=Math.max(0,n-4);i<n;i++){
      if(_s(history[i]&&history[i].content).indexOf('<ws_')>=0)return true;
    }
  }catch(e){}
  return false;
}

/* ── 结构化信号：ICode 悬浮窗当前是打开的（DOM 事实，非猜测） ── */
function _iCodeEntryOpen(){
  try{
    var ov=document.getElementById('ws-overlay');
    if(ov&&ov.style&&ov.style.display&&ov.style.display!=='none')return true;
  }catch(e){}
  return false;
}

/* ── 兜底：明确的文件/代码操作请求，或指名请求工作区/项目/文件类操作 ── */
function _explicitWsRequest(text){
  var t=_s(text).trim();
  if(!t)return false;
  if(_WS_ASK_RE.test(t))return true;
  return _WRITE_ACT_RE.test(t)&&_ARTIFACT_RE.test(t);
}

/* ════════ ICode / 工作区指令块（_WS_INSTR_BLOCK）的注入门控 ════════
   优先级：结构化信号 → 能力/入口状态 → 末端兜底。
   注意：本函数只决定"要不要把说明拼进 prompt"，不影响工作区标签的解析与执行
        （workspace.js 的 _parseWsOps 与执行链完全不经过这里）。 */
async function workspaceInstrNeeded(opts){
  opts=opts||{};
  var text=_s(opts.userMessage);
  /* ① 当前已有 workspace/file/code action 状态：待注入队列非空 = 操作正在进行 */
  if(_hasPendingWsInjection())return true;
  /* ② 附件/文件上下文：本轮确实带了文件（或工作区送来的附件） */
  if(_hasAttachments({attachments:opts.attachments}))return true;
  /* ③ 用户指名真实存在的项目 / 文件 */
  if(await _mentionsRealWorkspaceEntry(text))return true;
  /* ④ 已存在的 capability flag / 入口状态：ICode 开着，或历史里刚发生过工作区操作 */
  if(_iCodeEntryOpen())return true;
  if(_hasRecentWsTags(opts.history))return true;
  /* ⑤ 复用 integrations.js 的既有文件/工作区意图真源（IBWS.FILE_RE），避免第二套判定 */
  try{ if(typeof IBWS!=='undefined'&&IBWS.FILE_RE&&IBWS.FILE_RE.test(text))return true; }catch(e){}
  /* ⑥ 末端兜底：极小、可解释 */
  return _explicitWsRequest(text);
}

/* ════════ 图像生成说明块（_IMGGEN_INSTR_BLOCK）的逐轮门控 ════════
   只在"本轮可能真的要用生图标签"时注入说明：
     · 本轮用户消息里是明确的**请求产出图像**的祈使式（画/生成图/配个图/修一下这张…）；
     · 或本轮带着图片（有图可改）；
     · 或上一轮的生图结果/改图反馈尚未回传（队列非空 = 生图流程正在进行）。
   说明只讲"标签怎么写"，与"能力是否开启"是两件事：cfg.imageGen 仍由调用方判定，
   本函数不改变能力开关，也不会让任何已开启的生图请求失去标签语法（触发条件成立即注入）。
   刻意不把"历史里出现过图片"作为条件：那会让一次生图之后的每轮寒暄都常驻 700+ 字符。 */
var _IMG_GEN_ACT_RE=/画|绘|生成图|生图|出图|配图|作图|p图|修图|做成图|生成一张|来一张|给我一张|来张|帮我做张/;
/* 图像名词：含真实图像制品名词，以及"画一张/来一张"这类量词宾语（动作词已给出"要产出图像"的意图） */
var _IMG_NOUN_RE=/图|照片|画像|插画|海报|头像|立绘|壁纸|封面|表情包|自拍|风景|画面|一张|一幅|一副|image|photo|poster|avatar|wallpaper|illustration|artwork/i;
function imageGenInstrNeeded(opts){
  opts=opts||{};
  var t=_s(opts.userMessage).trim();
  try{
    if(typeof _wsPendingOpFeedback!=='undefined'&&_wsPendingOpFeedback){
      for(var i=0;i<_wsPendingOpFeedback.length;i++){
        if(/图像|图片|生图|画/.test(_s(_wsPendingOpFeedback[i]&&_wsPendingOpFeedback[i].text)))return true;
      }
    }
  }catch(e){}
  if(_hasAttachments({attachments:opts.attachments}))return true;
  /* 显式祈使式请求：动作词 + 图像名词同时出现，或"来一张/给我一张"这类省略宾语的强动作式 */
  if(_IMG_GEN_ACT_RE.test(t)&&(_IMG_NOUN_RE.test(t)||/来一张|来张|给我一张|生成一张|帮我做张/.test(t)))return true;
  return false;
}

/* ════════ 联网搜索"使用规则"段的逐轮门控 ════════
   只决定那句"何时可以用 web_search"的说明要不要拼进 system。
   注意：搜索**工具本身**照旧由 IBWS.attach 按 cfg.webSearch 挂载，本模块不参与，
        故"角色支持联网搜索"这一能力完全不变。
   只跳过"纯粹的寒暄/闲聊回合"——询问类、文件类、搜索类回合一律照常提醒。 */
function webSearchNoteNeeded(userMessage,cfg){
  var t=_s(userMessage).trim();
  if(!t)return false;
  try{ if(typeof IBWS!=='undefined'&&IBWS.FILE_RE&&IBWS.FILE_RE.test(t))return true; }catch(e){}
  /* 问句（？/?/吗/呢 结尾 或 怎样/如何/为什么/是多少 之类）倾向需要信息 → 照常提醒 */
  if(/[?？]/.test(t))return true;
  if(/(吗|呢|吧|么)[。！!~～\s]*$/.test(t))return true;
  if(/怎样|怎么|如何|为何|为什么|多少|哪[个里些]|什么时候|什么是|是不是|有没有|推荐|介绍|解释|告诉我|帮我(看|查|找|分析|总结)/.test(t))return true;
  /* 明显的闲聊/寒暄/情绪回合：不需要联网说明（也无需提醒模型别搜） */
  var casual=t.replace(/[\s，。！!？?、~～…,.]+/g,'');
  if(casual.length<=12){
    var small=/^(你好|您好|哈喽|嗨|hi|hello|在吗|在么|早安|早上好|午安|晚上好|晚安|睡了|我睡了|去睡了|拜拜|再见|么么|抱抱|亲亲|辛苦|谢谢|多谢|感谢|好的|好呀|好滴|收到|嗯|嗯嗯|哦|噢|哈哈|嘿嘿|嘻嘻|爱你|想你|今天怎么样|最近怎么样|怎么样|在干嘛|干嘛呢|吃饭了吗|吃了吗|早|安)(呀|啊|哇|哦|噢|啦|了|呢|哈)*$/;
    if(small.test(casual))return false;
  }
  return true;
}

/* ════════ 日历便笺指令（CAL_NOTE_INSTR）的注入门控 ════════
   只在"当轮真的有事可提"时才注入：即该角色可见且有提前提醒的事项 / 节日。
   一旦渲染出栏（buildTail 产物非空），说明确有内容 —— 与栏同生共死。
   权限与总开关仍由 calendar.js 自己判定，本函数不改变可见性。 */
function calendarNoteNeeded(tailText){
  return !!_s(tailText).trim();
}

NS.expose('chat.contextSignals', {
  workspaceInstrNeeded: workspaceInstrNeeded,
  imageGenInstrNeeded: imageGenInstrNeeded,
  webSearchNoteNeeded: webSearchNoteNeeded,
  calendarNoteNeeded: calendarNoteNeeded,
  /* 只读诊断用（供 tests 与 dev 观测；不参与任何写路径） */
  _explicitWsRequest: _explicitWsRequest,
  _mentionsRealWorkspaceEntry: _mentionsRealWorkspaceEntry,
  _hasRecentWsTags: _hasRecentWsTags,
  _iCodeEntryOpen: _iCodeEntryOpen,
  _hasPendingWsInjection: _hasPendingWsInjection,
  _hasAttachments: _hasAttachments
});
/* 双挂载：site-operations.js / communication.js 经 window 访问，HTML 内联与其它文件不受影响 */
window.IBContextSignals=NS.chat.contextSignals;
})(window.IB || (window.IB = {}));
