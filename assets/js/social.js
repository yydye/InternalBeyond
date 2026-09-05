/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.social 注册）。 */
(function(NS){
/* CHAT & API */
const PROVIDERS={
  anthropic:{name:'Claude',endpoint:'https://api.anthropic.com/v1/messages',model:'claude-sonnet-4-6',format:'anthropic',vision:true,streaming:true},
  openai:{name:'GPT',endpoint:'https://api.openai.com/v1/chat/completions',model:'gpt-4o-mini',format:'openai',vision:true,streaming:true},
  grok:{name:'Grok',endpoint:'https://api.x.ai/v1/chat/completions',model:'grok-4',format:'openai',vision:true,streaming:true},
  deepseek:{name:'DeepSeek',endpoint:'https://api.deepseek.com/v1/chat/completions',model:'deepseek-v4-flash',format:'openai',vision:true,streaming:true,showThinking:true},
  gemini:{name:'Gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',model:'gemini-2.0-flash',format:'gemini',vision:true,streaming:true},
  glm:{name:'GLM',endpoint:'https://open.bigmodel.cn/api/paas/v4/chat/completions',model:'glm-4-flash',format:'openai',vision:true,streaming:true,showThinking:false},
  qwen:{name:'通义千问',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',model:'qwen-plus',format:'openai',vision:true,streaming:true},
  doubao:{name:'豆包',endpoint:'https://ark.cn-beijing.volces.com/api/v3/chat/completions',model:'doubao-seed-2-0-lite',format:'openai',vision:true,streaming:true},
  moonshot:{name:'Kimi',endpoint:'https://api.moonshot.cn/v1/chat/completions',model:'kimi-k2.6',format:'openai',vision:true,streaming:true},
  mimo:{name:'MiMo',endpoint:'https://api.xiaomimimo.com/v1/chat/completions',model:'mimo-v2.5',format:'openai',vision:true,streaming:true,showThinking:true},
  minimax:{name:'MiniMax',endpoint:'https://api.minimax.chat/v1/text/chatcompletion_v2',model:'MiniMax-Text-01',format:'openai',vision:false,streaming:true},
  yi:{name:'零一万物',endpoint:'https://api.lingyiwanwu.com/v1/chat/completions',model:'yi-lightning',format:'openai',vision:false,streaming:true},
  baichuan:{name:'百川',endpoint:'https://api.baichuan-ai.com/v1/chat/completions',model:'Baichuan4',format:'openai',vision:false,streaming:true},
  mistral:{name:'Mistral',endpoint:'https://api.mistral.ai/v1/chat/completions',model:'mistral-large-latest',format:'openai',vision:false,streaming:true},
  custom:{name:'Custom',endpoint:'',model:'',format:'openai',vision:true,streaming:true}
};
/* Local OpenAI-compatible runtimes such as Ollama and LM Studio normally do
   not use a credential.  Treat that narrow, loopback-only case as ready while
   keeping the normal API-key requirement for every network endpoint. */
function _ibIsLoopbackEndpoint(endpoint){
  try{
    const url=new URL(String(endpoint||''));
    const host=String(url.hostname||'').toLowerCase();
    return (url.protocol==='http:'||url.protocol==='https:')&&(host==='localhost'||host==='127.0.0.1'||host==='::1'||host==='[::1]');
  }catch(e){return false}
}
function _ibApiHasCredential(cfg){
  return !!(cfg&&(String(cfg.apiKey||'').trim()||_ibIsLoopbackEndpoint(cfg.endpoint)));
}
function _ibApiReady(cfg){
  return !!(cfg&&String(cfg.endpoint||'').trim()&&String(cfg.model||'').trim()&&_ibApiHasCredential(cfg));
}
function _modelThinkingDefault(provider,model){
  provider=String(provider||'').toLowerCase();model=String(model||'').toLowerCase();
  if(provider==='glm'||/^glm(?:[-_.]|$)/.test(model))return false;
  if(provider==='deepseek'||/deepseek[-_.]?(?:reasoner|r1)/.test(model))return true;
  const p=PROVIDERS[provider];
  return !!(p&&p.showThinking);
}
function _resolveShowThinking(cfg){
  if(!cfg)return false;
  if(typeof cfg.showThinking==='boolean')return cfg.showThinking;
  /* GLM 安全默认优先；其余模型尊重旧版显式开关，再应用新默认。 */
  const provider=String(cfg.provider||'').toLowerCase(),model=String(cfg.model||'').toLowerCase();
  if(provider==='glm'||/^glm(?:[-_.]|$)/.test(model))return false;
  if(typeof cfg.thinkingEnabled==='boolean')return cfg.thinkingEnabled;
  if(provider==='deepseek'||/deepseek[-_.]?(?:reasoner|r1)/.test(model))return true;
  return _modelThinkingDefault(provider,model);
}
let _showThinkingTouched=false;
function _syncShowThinkingDefault(){
  if(_showThinkingTouched)return;
  const el=document.getElementById('api-thinking-toggle');if(!el)return;
  const provider=document.getElementById('api-provider');
  const model=document.getElementById('api-model');
  el.checked=_modelThinkingDefault(provider&&provider.value,model&&model.value);
}

/* DeepSeek 原生视觉模型：模型名精确命中时，图片直接随消息发给 DeepSeek，
   不再经本地 Qwen2.5-VL 识别，也不先转成描述文本。
   其它 DeepSeek 模型继续走原有本地视觉链路。 */
const DEEPSEEK_NATIVE_VISION_MODEL='deepseek-v4-flash-vision-exp';
function _isDeepSeekNativeVisionModel(model){
  return String((model==null?'':model)).trim().toLowerCase()===DEEPSEEK_NATIVE_VISION_MODEL;
}
/* API 编辑器：按当前 provider/model 同步“支持图片识别”开关与提示。 */
function _syncVisionUI(){
  const modelEl=document.getElementById('api-model');
  if(!modelEl)return;
  const providerEl=document.getElementById('api-provider');
  const visionEl=document.getElementById('api-vision-toggle');
  const hintEl=document.getElementById('api-vision-hint');
  const model=String(modelEl.value||'').trim().toLowerCase();
  const provider=String((providerEl&&providerEl.value)||'').toLowerCase();
  const nativeVision=_isDeepSeekNativeVisionModel(model);
  const deepSeekVision=provider==='deepseek'||model.indexOf('deepseek')>=0;
  if(visionEl){
    if(nativeVision){
      visionEl.checked=true;
      visionEl.disabled=true;
      visionEl.title='该模型原生支持图片输入，始终直接把图片发送给模型';
    }else{
      visionEl.disabled=false;
      visionEl.removeAttribute('title');
    }
  }
  if(hintEl){
    if(nativeVision){
      hintEl.textContent='已识别 DeepSeek 原生视觉模型：聊天图片会与文字一起直接发送给 DeepSeek，由模型完成视觉理解与推理；不会经过本地 Qwen 视觉模型，也不会先转换为描述文本。';
    }else if(deepSeekVision){
      hintEl.textContent='当前为 DeepSeek 文本模型：图片会先由本地 Qwen2.5-VL 识别为文字描述，再交给 DeepSeek。将模型填写为 deepseek-v4-flash-vision-exp 可改为直接向模型发送图片。';
    }else{
      hintEl.textContent='开启后图片会编码发送给 API，关闭则仅发文字。默认值按服务商自动设定。';
    }
  }
}

/* Voice UI helpers */
/* Voice Provider 目录：与 bridge/tts.js 的 TTS_PROVIDER_REGISTRY 字段对齐（label/capabilities/models/cloneModels/designModels）。
   B2 起 MiMo clone=true（mimo-v2.5-tts-voiceclone，参考音频 data URI）；C 起 design=true
   （mimo-v2.5-tts-voicedesign，user 消息=音色设计描述，无 audio.voice）。
   MiMo builtin 音色官方枚举（见 mimo.mi.com Speech Synthesis v2.5；语言由音色决定，无独立 language 参数）。 */
const IB_TTS_CATALOG=[
  {id:'openai',label:'OpenAI TTS',capabilities:{builtin:true,clone:false,design:false,style:true,language:false,prosody:false},models:['tts-1','tts-1-hd','gpt-4o-mini-tts'],voices:[]},
  {id:'edge',label:'Edge TTS (free)',capabilities:{builtin:true,clone:false,design:false,style:false,language:false,prosody:true},models:[],voices:[]},
  {id:'mimo',label:'MiMo TTS',capabilities:{builtin:true,clone:true,design:true,style:true,language:false,prosody:false},models:['mimo-v2.5-tts'],cloneModels:['mimo-v2.5-tts-voiceclone'],designModels:['mimo-v2.5-tts-voicedesign'],emptyModelLabel:'默认（mimo-v2.5-tts）',cloneModelLabel:'默认（mimo-v2.5-tts-voiceclone）',designModelLabel:'默认（mimo-v2.5-tts-voicedesign）',voices:['mimo_default','冰糖','茉莉','苏打','白桦','Mia','Chloe','Milo','Dean'],voiceLabels:{'mimo_default':'MiMo 默认（随集群）','冰糖':'冰糖 · 中文女声','茉莉':'茉莉 · 中文女声','苏打':'苏打 · 中文男声','白桦':'白桦 · 中文男声','Mia':'Mia · 英文女声','Chloe':'Chloe · 英文女声','Milo':'Milo · 英文男声','Dean':'Dean · 英文男声'}}
];
function _voiceCatalogOf(id){
  for(var i=0;i<IB_TTS_CATALOG.length;i++)if(IB_TTS_CATALOG[i].id===id)return IB_TTS_CATALOG[i];
  return null;
}
/* Provider 下拉改由目录驱动生成：幂等重建，保留当前选中值（缺失时回落首项，保持 openai 在前的历史默认序）。 */
function _voiceSyncProviderOptions(){
  var sel=document.getElementById('api-voice-provider');if(!sel||sel.dataset.ibCatalog==='1')return;
  var cur=sel.value;
  sel.dataset.ibCatalog='1';
  sel.innerHTML='';
  IB_TTS_CATALOG.forEach(function(p){
    var o=document.createElement('option');o.value=p.id;o.textContent=p.label;sel.appendChild(o);
  });
  if(cur&&_voiceCatalogOf(cur))sel.value=cur;
}
/* 按 provider capabilities + Voice Type 显隐 Model / Voice / Language / Style / Rate+Pitch 容器。
   有官方预置音色列表的 provider（如 MiMo）改用下拉选择并隐藏自由文本输入；
   其余保持既有 #api-voice-id 自由输入。VoiceClone：只显示参考音频面板 + 克隆模型 + Style + Test，
   隐藏原始 provider 行 / 预置音色 / language / prosody（clone 音色由参考音频决定）。
   VoiceDesign：同 clone 隐藏 provider 行 / 预置音色 / language / prosody（音色由「Voice Design 描述」决定），
   Style 标签改为「Voice Design 描述」。 */
function _voiceSyncCapabilityFields(){
  var sel=document.getElementById('api-voice-provider');
  var def=_voiceCatalogOf(sel&&sel.value||'')||IB_TTS_CATALOG[0];
  var hasVoices=!!(def.voices&&def.voices.length);
  var vt=_voiceCurrentType();
  var isSpecial=(vt==='clone'||vt==='design');
  var show=function(id,on){var el=document.getElementById(id);if(el)el.style.display=on?'':'none'};
  show('api-voice-model-wrap', vt==='clone'?(def.cloneModels&&def.cloneModels.length>0):(vt==='design'?(def.designModels&&def.designModels.length>0):def.models.length>0));
  show('api-voice-select-wrap', !isSpecial && hasVoices);
  show('api-voice-id-wrap', !isSpecial && !hasVoices);
  show('api-voice-provider-wrap', !isSpecial);
  show('api-voice-language-wrap', !isSpecial && !!(def.capabilities&&def.capabilities.language));
  show('api-voice-style-wrap', !!(def.capabilities&&def.capabilities.style));
  show('api-voice-prosody-wrap', !isSpecial && !!(def.capabilities&&def.capabilities.prosody));
  /* Style 标签按类型切换：Design 的 style=音色设计描述（官方 user 消息），其余为 Instructions / Style */
  var styleLabel=document.querySelector('#api-voice-style-wrap .ibv-label');
  if(styleLabel)styleLabel.textContent=(vt==='design')?'Voice Design 描述（音色设计）':'Instructions / Style';
  var styleInput=document.getElementById('api-voice-style');
  if(styleInput)styleInput.placeholder=(vt==='design')?'用自然语言描述想要的音色，如「一位年迈的先生，嗓音略带沙哑与沧桑感，语速缓慢」。':'说话风格指令；仅支持的 Provider 会随请求发送（如 gpt-4o-mini-tts）';
}
function _voiceSyncVoiceOptions(def){
  var sel=document.getElementById('api-voice-select');if(!sel)return;
  var list=(def&&def.voices)||[];
  /* 无官方预置目录的 provider（edge/openai）：下拉本就不该有值——清空，
     防止把上一个角色/上一次会话残留在 select 里的 id 以「(当前配置)」形式带进别的角色。 */
  if(!list.length){sel.innerHTML='';sel.value='';return;}
  var cur=sel.value;
  sel.innerHTML='';
  list.forEach(function(v){
    var o=document.createElement('option');
    o.value=v;
    o.textContent=(def.voiceLabels&&def.voiceLabels[v])||v;
    sel.appendChild(o);
  });
  /* 兼容：既存值不在官方枚举内（历史手填/上游更新列表）时不静默丢弃 */
  if(cur&&list.indexOf(cur)<0){
    var o=document.createElement('option');o.value=cur;o.textContent='(当前配置) '+cur;sel.appendChild(o);
  }
  if(cur&&sel.querySelector('option[value="'+cur.replace(/"/g,'\\"')+'"]'))sel.value=cur;
}
/* Model 下拉按目录重建：builtin 用 models（openai 保持「跟随全局配置」语义；mimo 空选项即官方默认模型）；
   VoiceClone 用 cloneModels、VoiceDesign 用 designModels，均默认选中官方专用模型，避免误选普通 TTS model。 */
function _voiceSyncModelOptions(def){
  var sel=document.getElementById('api-voice-model');if(!sel)return;
  var vt=_voiceCurrentType();
  var list=(def&&(vt==='clone'?(def.cloneModels||[]):(vt==='design'?(def.designModels||[]):(def.models||[]))))||[];
  var cur=sel.value;
  sel.innerHTML='';
  if(vt==='clone'||vt==='design'){
    if(!list.length){
      var oe0=document.createElement('option');oe0.value='';oe0.textContent=(def&&def.emptyModelLabel)||'跟随全局配置（config.tts.model）';sel.appendChild(oe0);
    }else{
      list.forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o);});
      /* clone/design 默认选中官方专用模型；已显式保存过则保留 */
      sel.value=(cur&&list.indexOf(cur)!==-1)?cur:list[0];
    }
    return;
  }
  var oe=document.createElement('option');
  oe.value='';
  oe.textContent=(def&&def.emptyModelLabel)||'跟随全局配置（config.tts.model）';
  sel.appendChild(oe);
  list.forEach(function(m){
    var o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o);
  });
  /* Built-in 模式防脏字段：Clone/Design 切换残留下的专用 model（mimo-v2.5-tts-voiceclone /
     mimo-v2.5-tts-voicedesign）绝不允许作为「(当前配置)」带回 Built-in（保存后上游会收到
     voiceType 与 model 错配的请求；服务端 normalize 另有同规则兜底）。 */
  if(cur&&cur!==''){
    for(var ci=0;ci<IB_TTS_CATALOG.length;ci++){
      var _cd=IB_TTS_CATALOG[ci];
      if((_cd.cloneModels&&_cd.cloneModels.indexOf(cur)!==-1)||(_cd.designModels&&_cd.designModels.indexOf(cur)!==-1)){cur='';break;}
    }
  }
  if(cur&&cur!==''){
    if(!sel.querySelector('option[value="'+String(cur).replace(/"/g,'\\"')+'"]')){
      var oc=document.createElement('option');oc.value=cur;oc.textContent='(当前配置) '+cur;sel.appendChild(oc);
    }
    sel.value=cur;
  }
}
/* 当前生效的 Voice ID 取/设：按目录决定读写预置下拉还是自由输入框。 */
function _voiceUsesSelect(){
  var sel=document.getElementById('api-voice-provider');
  var def=_voiceCatalogOf(sel&&sel.value||'')||IB_TTS_CATALOG[0];
  return !!(def.voices&&def.voices.length);
}
function _voiceGetId(){
  var el=document.getElementById(_voiceUsesSelect()?'api-voice-select':'api-voice-id');
  return (el&&el.value)||'';
}
function _voiceSetId(val){
  var v=val==null?'':String(val);
  var sel=document.getElementById('api-voice-select'),inp=document.getElementById('api-voice-id');
  if(_voiceUsesSelect()){
    _voiceSyncVoiceOptions(_voiceCatalogOf((document.getElementById('api-voice-provider')||{}).value||''));
    if(sel&&v&&!(sel.querySelector&&sel.querySelector('option[value="'+v.replace(/"/g,'\\"')+'"]'))){
      var o=document.createElement('option');o.value=v;o.textContent='(当前配置) '+v;sel.appendChild(o);
    }
    if(sel)sel.value=v;
  }else if(inp)inp.value=v;
}
function _voiceRateUpdate(){
  var r=document.getElementById('api-voice-rate');var v=document.getElementById('api-voice-rate-val');
  if(r&&v)v.textContent=parseFloat(r.value).toFixed(2);
}
function _voiceToggleDetail(){
  var t=document.getElementById('api-voice-toggle');var d=document.getElementById('api-voice-detail');
  if(t&&d)d.style.display=t.checked?'':'none';
  _voiceSyncProviderOptions();
  var provEl=document.getElementById('api-voice-provider');
  var def=_voiceCatalogOf(provEl&&provEl.value||'')||IB_TTS_CATALOG[0];
  _voiceSyncCapabilityFields();
  _voiceSyncModelOptions(def);
  _voiceSyncVoiceOptions(def);
  _voiceTypeChange();
}
/* ── VoiceClone Reference Audio（第三阶段 B1）──
   编辑器当前选中的 Reference Audio：{refAudioId,mime,ext,name,size} 或 null。
   二进制永不进入 IndexedDB / 导出 JSON；voiceData 只保存引用与元数据。 */
var _voiceCloneSelection=null;
var _voiceCloneBound=false;
/* VoiceType 切换记忆：Clone/Design 强制 provider=mimo 前的值；回 Built-in 时恢复。
   仅当次编辑器会话内有效（addNewApi/editApi 打开编辑器时重置）。 */
var _voiceProvBeforeSpecial=null;
function _voiceCurrentType(){
  var c=document.getElementById('api-voice-type-clone');
  var d=document.getElementById('api-voice-type-design');
  var b=document.getElementById('api-voice-type-builtin');
  if(c&&c.checked)return 'clone';
  if(d&&d.checked)return 'design';
  if(b&&b.checked)return 'builtin';
  return 'builtin';
}
function _voiceSetType(t){
  var b=document.getElementById('api-voice-type-builtin');
  var c=document.getElementById('api-voice-type-clone');
  var d=document.getElementById('api-voice-type-design');
  if(b)b.checked=t!=='clone'&&t!=='design';
  if(c)c.checked=t==='clone';
  if(d)d.checked=t==='design';
}
function _voiceFmtBytes(n){
  var v=Number(n)||0;
  if(v<1024)return v+' B';
  if(v<1024*1024)return (Math.round(v/10.24)/100)+' KB';
  return (Math.round(v/10485.76)/100)+' MB';
}
/* 全角色当前引用的 refAudioId 集合：只统计 voiceType==='clone' 且 voiceData.refAudioId 存在。 */
/* 全角色当前引用的 refAudioId 集合：只统计 voiceType==='clone' 且 voiceData.refAudioId 存在。
   归档角色同样计入（恢复后仍引用同一文件，删除不能静默破坏）。 */
function _ibReferencedRefAudioIds(onlyId){
  var out=[];
  try{
    if(typeof apiConfigs==='undefined'||!Array.isArray(apiConfigs))return out;
    apiConfigs.concat(typeof archivedConfigs!=='undefined'&&Array.isArray(archivedConfigs)?archivedConfigs:[]).forEach(function(c){
      var v=c&&c.voice;
      if(!v||v.voiceType!=='clone')return;
      var id=v.voiceData&&v.voiceData.refAudioId;
      if(id&&(!onlyId||id===onlyId)&&out.indexOf(id)===-1)out.push(id);
    });
  }catch(e){}
  return out;
}
function _voiceCloneBind(){
  if(_voiceCloneBound)return;
  _voiceCloneBound=true;
  var up=document.getElementById('api-voice-clone-upload-btn');
  var del=document.getElementById('api-voice-clone-delete-btn');
  var fi=document.getElementById('api-voice-clone-file');
  if(up)up.onclick=function(){ var i=document.getElementById('api-voice-clone-file'); if(i)i.click(); };
  if(del)del.onclick=function(){ _voiceCloneDeleteCurrent(); };
  if(fi)fi.onchange=function(){
    var f=fi.files&&fi.files[0];
    if(f)_voiceCloneUploadFile(f);
    fi.value='';
  };
}
function _voiceCloneRender(){
  _voiceCloneBind();
  var vt=_voiceCurrentType();
  var isClone=vt==='clone';
  var panel=document.getElementById('api-voice-clone-panel');
  var cur=document.getElementById('api-voice-clone-current');
  var status=document.getElementById('api-voice-clone-status');
  var delBtn=document.getElementById('api-voice-clone-delete-btn');
  var testBtn=document.getElementById('api-voice-test-btn');
  /* B2/B3：VoiceClone/VoiceDesign 正常可用，Test Voice 不再禁用；builtin-fields 保持可见，
     由 _voiceSyncCapabilityFields 按类型显隐 provider/预置音色/language/prosody/model/style；
     clone 面板只在 clone 且选中参考音频时显示，design 隐藏（参考音频非 design 需要）。 */
  if(panel)panel.style.display=isClone?'':'none';
  if(testBtn){testBtn.disabled=false;testBtn.title=vt==='design'?'用 MiMo Voice Design 试听':'（内置音色）试听';}
  var sel=_voiceCloneSelection;
  if(cur){
    if(isClone&&sel&&sel.refAudioId){
      var nm=(typeof esc==='function')?esc(sel.name||''):String(sel.name||'');
      cur.innerHTML='<span>当前：</span><b>'+nm+'</b><span class="muted"> '+_voiceFmtBytes(sel.size)+'</span>';
    }else{
      cur.innerHTML='<span class="muted">尚未选择参考音频（上传后自动绑定到角色）</span>';
    }
  }
  if(delBtn)delBtn.style.display=(sel&&sel.refAudioId)?'':'none';
  if(status){
    if(isClone&&sel&&sel.refAudioId){
      status.className='ibv-clone-status';
      status.textContent='检查文件存在性…';
      /* 异步存在性检查：dangling reference（导入/其它机器）给出明确状态 */
      (function(idRef,el){
        var ok=typeof ibTtsVoiceHead==='function'?ibTtsVoiceHead(idRef):Promise.resolve(true);
        ok.then(function(exists){
          if(!el.isConnected)return;
          if(_voiceCloneSelection&&_voiceCloneSelection.refAudioId===idRef){
            if(exists){el.className='ibv-clone-status ok';el.textContent='✓ 参考音频文件存在（Bridge）';}
            else{el.className='ibv-clone-status warn';el.textContent='⚠ 引用文件在本机 Bridge 不存在（可能来自其它备份/机器导入）；可删除后重新上传';}
          }
        }).catch(function(){});
      })(sel.refAudioId,status);
    }else{
      status.className='ibv-clone-status';
      status.textContent='';
    }
  }
}
function _voiceTypeChange(){
  _voiceCloneBind();
  /* 只有 MiMo 支持克隆/设计（服务端 mimo.clone/design=true 才放行）。选中 Clone/Design 时把 Provider 强制为 MiMo，
     避免 edge/openai + clone/design 被 normalize 回落到 builtin 造成"选了特性却是内置音色"的困惑；
     回 Built-in 时恢复强制前的 provider（否则旧 Edge 角色看一眼 Clone 再切回来会被静默改成 MiMo + 不匹配音色）。 */
  var vt=_voiceCurrentType();
  var provEl=document.getElementById('api-voice-provider');
  if(vt==='clone'||vt==='design'){
    if(provEl&&provEl.value!=='mimo'){_voiceProvBeforeSpecial=provEl.value;provEl.value='mimo';}
  }else if(vt==='builtin'){
    if(_voiceProvBeforeSpecial&&provEl&&provEl.value==='mimo')provEl.value=_voiceProvBeforeSpecial;
    _voiceProvBeforeSpecial=null;
  }
  var def=_voiceCatalogOf(provEl&&provEl.value||'')||IB_TTS_CATALOG[0];
  _voiceSyncCapabilityFields();
  _voiceSyncModelOptions(def);
  _voiceCloneRender();
}
async function _voiceCloneUploadFile(file){
  if(!file)return;
  var okName=/\.(mp3|wav)$/i.test(String(file.name||''));
  var okType=/(audio\/(mpeg|mp3|x-mp3|wav|x-wav|wave)|application\/octet-stream)/i.test(String(file.type||''));
  if(!okName&&!okType){toast('仅支持 MP3 / WAV 参考音频');return;}
  if(!file.size||file.size===0){toast('文件为空');return;}
  if(file.size>10*1024*1024){toast('超过 10 MB 上限');return;}
  var btn=document.getElementById('api-voice-clone-upload-btn');
  if(btn)btn.disabled=true;
  try{
    var j=await ibBridgeFetch(ibBridgeBase()+'/api/tts/voices?name='+encodeURIComponent(file.name||''),{
      method:'POST',
      headers:{'Content-Type':file.type||'application/octet-stream'},
      body:file
    }).then(function(r){return r.json()}).catch(function(NS){return {ok:false,error:'Bridge 未连接'}});
    if(j&&j.ok&&j.voice){
      _voiceCloneSelection={
        refAudioId:String(j.voice.refAudioId||''),
        mime:j.voice.mime||'',
        ext:j.voice.ext||'',
        name:j.voice.originalName||file.name||'',
        size:Number(j.voice.size)||file.size||0
      };
      toast('参考音频已上传：'+_voiceCloneSelection.refAudioId);
    }else toast('上传失败：'+(j&&j.error||'未知错误'));
  }catch(e){toast('上传失败：'+String(e&&e.message||e).slice(0,80));}
  finally{if(btn)btn.disabled=false;}
  _voiceCloneRender();
}
async function _voiceCloneDeleteCurrent(){
  var sel=_voiceCloneSelection;
  if(!sel||!sel.refAudioId)return;
  var hinted=_ibReferencedRefAudioIds(sel.refAudioId).length>0?'\n\n该文件仍被角色引用，按设计会被拒绝删除。':'';
  if(!confirm('确定删除这个 Reference Audio？('+sel.refAudioId+')'+hinted))return;
  var btn=document.getElementById('api-voice-clone-delete-btn');
  if(btn)btn.disabled=true;
  try{
    var j=await ibBridgeFetch(ibBridgeBase()+'/api/tts/voices/'+encodeURIComponent(sel.refAudioId),{
      method:'DELETE',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({referencedIds:_ibReferencedRefAudioIds()})
    }).then(function(r){return r.json()}).catch(function(NS){return {ok:false,error:'Bridge 未连接'}});
    if(j&&j.ok){_voiceCloneSelection=null;toast('参考音频已删除');}
    else toast('删除失败：'+(j&&j.error||'未知错误'));
  }catch(e){toast('删除失败：'+String(e&&e.message||e).slice(0,80));}
  finally{if(btn)btn.disabled=false;}
  _voiceCloneRender();
}
async function testCharacterVoice(){
  /* 只负责收集表单里 Role 形态的 Voice Profile；wire payload 一律经 IB.bridge.ttsPayload（唯一组装点）。
     B2：VoiceClone 模式走真实 /api/tts → MiMo VoiceClone；无 refAudioId 则阻断。
     B3：VoiceDesign 模式走真实 /api/tts → MiMo Voice Design；无「Voice Design 描述」则阻断。 */
  var _vt=_voiceCurrentType();
  var _vd=null;
  if(_vt==='clone'){
    var _sel=_voiceCloneSelection;
    if(!_sel||!_sel.refAudioId){toast('请先上传 Reference Audio 再试听克隆音色');return;}
    _vd={refAudioId:_sel.refAudioId,mime:_sel.mime||'',name:_sel.name||'',size:_sel.size||0};
  }else if(_vt==='design'){
    var _vs=document.getElementById('api-voice-style');
    var _designPrompt=String((_vs&&_vs.value)||'').trim();
    if(!_designPrompt){toast('请先填写 Voice Design 描述再试听');return;}
  }
  var vp=document.getElementById('api-voice-provider');
  var vmC=document.getElementById('api-voice-model');
  var vlC=document.getElementById('api-voice-language');
  var vsC=document.getElementById('api-voice-style');
  var sampleText='你好，我是'+(document.getElementById('api-ai-name').value||'AI')+'。';
  var vc={provider:(vp&&vp.value)||'edge',voiceId:_voiceGetId(),rate:parseFloat((document.getElementById('api-voice-rate')&&document.getElementById('api-voice-rate').value)||'1.0'),pitch:(document.getElementById('api-voice-pitch')&&document.getElementById('api-voice-pitch').value)||'+0Hz',model:(vmC&&vmC.value)||'',language:(vlC&&vlC.value)||'',style:(vsC&&vsC.value)||'',voiceType:_vt,voiceData:_vd};
  try{
    var j=await fetch(ibBridgeBase()+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(IB.bridge.ttsPayload(vc,sampleText))}).then(function(r){return r.json()});
    if(j&&j.ok){
      var au=new Audio(ibBridgeBase()+j.url);au.play().catch(function(){});
      toast('Playing test voice...');
    }else{toast('TTS failed: '+(j&&j.error||'unknown'))}
  }catch(e){toast('Bridge not connected')}
}

const _chatSendingFor=new Set();
/* 全量渲染：不做分批、不做 content-visibility 跳过，打开即渲染全部消息 */

function onProviderChange(){
  const p=document.getElementById('api-provider').value;
  const cfg=PROVIDERS[p];
  if(cfg){
    document.getElementById('api-endpoint').value=cfg.endpoint;
    document.getElementById('api-model').value=cfg.model;
    var ve=document.getElementById('api-vision-toggle');
    if(ve)ve.checked=!!cfg.vision;
    var se=document.getElementById('api-streaming-toggle');
    if(se)se.checked=!!cfg.streaming;
    _showThinkingTouched=false;
    _syncShowThinkingDefault();
    _syncVisionUI();
  }
}

/* MULTI-API MANAGEMENT */
let apiConfigs=[];
let archivedConfigs=[];/* 归档区：不进入好友列表、群聊、选择器、AM 展区与迷你面板；仅归档视图读取 */
let editingApiId=null;
let activeFriendId=null;
let activeThreadId=null;/* null=主对话, 有值=话题频道 */
/* 角色库数量与群聊成员数量是两个独立的维度。10 是当前群聊的既有有效成员上限，
   不再用它限制 apiConfigs 的数量。 */
const MAX_GROUP_MEMBERS=10;
let _groupRoleSearch='';
let _memberPickerSearch='';
const API_CONFIG_FALLBACK_KEY='ib_apiConfigsFallback_v1';
/* ── 存储能力探测与分级降级 ──
   file:// 以及部分隐私模式下 IndexedDB / localStorage 可能被浏览器禁用，但「是否被禁用」
   只能实测，不能按协议推断（同一个 file:// 页面在不同浏览器/不同启动参数下能力并不一致）。
   因此这里对每种后端做一次真实的写-读-删往返，再按持久化强度分级：
     persistent  IndexedDB 或 localStorage —— 真正持久化，跨会话存活
     session     sessionStorage           —— 仅当前会话，关闭标签页即失
     memory      页内变量                 —— 仅当前页面生命周期，刷新即失
     unavailable 全部不可写               —— 无法保存
   分级结果如实向上层返回，避免把 session / memory 谎报成持久化。 */
var _ibApiMemStore=null;/* memory 层载体：仅当前页面生命周期 */
var _ibStoreProbe=null;
const API_STORE_TIERS=['local','session','memory'];
function _ibProbeWebStorage(kind){
  try{
    const s=window[kind];
    if(!s)return false;
    const k='__ib_probe_'+kind+'__';
    s.setItem(k,'1');
    const ok=s.getItem(k)==='1';
    s.removeItem(k);
    return ok;
  }catch(e){return false}
}
/* 探测结果缓存；传 true 强制重测（配额被占满等运行期变化后可刷新） */
function _ibStorageCaps(refresh){
  if(!_ibStoreProbe||refresh)_ibStoreProbe={local:_ibProbeWebStorage('localStorage'),session:_ibProbeWebStorage('sessionStorage')};
  return _ibStoreProbe;
}
function _apiStoreArea(kind){return kind==='session'?window.sessionStorage:window.localStorage}
function _apiStoreReadFrom(kind){
  try{
    const raw=kind==='memory'?_ibApiMemStore:_apiStoreArea(kind).getItem(API_CONFIG_FALLBACK_KEY);
    if(!raw)return[];
    const v=JSON.parse(raw);
    return Array.isArray(v)?v.filter(a=>a&&a.id):[];
  }catch(e){return[]}
}
function _apiStoreWriteTo(kind,v){
  try{
    const json=JSON.stringify(v);
    if(kind==='memory'){_ibApiMemStore=json;return true}
    const caps=_ibStorageCaps();
    if(!caps[kind])return false;/* 探测判定不可写就不再尝试，避免每次保存都抛一轮异常 */
    _apiStoreArea(kind).setItem(API_CONFIG_FALLBACK_KEY,json);
    return true;
  }catch(e){return false}
}
function _apiStoreClear(kind){
  try{
    if(kind==='memory'){_ibApiMemStore=null;return}
    _apiStoreArea(kind).removeItem(API_CONFIG_FALLBACK_KEY);
  }catch(e){}
}
/* 跨层合并读取：持久性更弱的层优先级更高（memory > session > local）。
   这一顺序处理「降级」方向：localStorage 配额耗尽时 setItem 抛错但 getItem 仍可读，
   旧值留在 local、新值落在 session，此时必须取 session。
   「恢复」方向由 _apiFallbackWrite 写入成功后清空更弱的层来保证，两者合起来确保
   任一 id 不会同时存在于多层、也不会被旧值反向遮蔽。 */
function _apiFallbackRead(){
  const merged=new Map();
  API_STORE_TIERS.forEach(function(kind){
    _apiStoreReadFrom(kind).forEach(function(a){merged.set(a.id,a)});
  });
  return Array.from(merged.values());
}
/* 返回实际落地的层级字符串（'persistent' / 'session' / 'memory' / 'unavailable'），不再返回布尔值。
   写入成功后清空所有更弱的层：否则某层曾降级留下的旧值会在能力恢复后
   按 _apiFallbackRead 的优先级永久遮蔽新值。 */
function _apiFallbackWrite(v){
  for(let i=0;i<API_STORE_TIERS.length;i++){
    if(!_apiStoreWriteTo(API_STORE_TIERS[i],v))continue;
    for(let j=i+1;j<API_STORE_TIERS.length;j++)_apiStoreClear(API_STORE_TIERS[j]);
    return API_STORE_TIERS[i]==='local'?'persistent':API_STORE_TIERS[i];
  }
  return 'unavailable';
}
function _apiFallbackRemove(id){
  API_STORE_TIERS.forEach(function(kind){
    const cur=_apiStoreReadFrom(kind);
    if(!cur.length)return;
    const v=cur.filter(a=>a.id!==id);
    if(v.length===cur.length)return;
    if(v.length)_apiStoreWriteTo(kind,v);else _apiStoreClear(kind);
  });
}
function _apiFallbackPut(cfg){
  const v=_apiFallbackRead().filter(a=>a.id!==cfg.id);v.push(cfg);
  const tier=_apiFallbackWrite(v);
  if(tier==='unavailable')throw new Error('浏览器禁用了本页全部可用存储（IndexedDB / localStorage / sessionStorage 均不可写）');
  return tier;
}
/* 返回 {durability,backend,idb}：durability 如实反映持久化强度，供 UI 区分提示。 */
async function _persistApiConfig(cfg){
  try{
    /* 正常 http/https 环境维持原有首选路径：IndexedDB 写入成功后照旧留一份轻量同源镜像，
       因为部分损坏状态会出现 put/get 成功、随后的 getAll 却返回空列表，
       导致界面看起来像“保存后消失”。 */
    await dbPut('apiConfigs',cfg);
    let mirror='unavailable';
    try{mirror=_apiFallbackPut(cfg)}catch(e){console.warn('API config mirror write failed',e)}
    return {durability:'persistent',backend:'indexeddb',idb:true,mirror:mirror};
  }catch(e){
    /* IndexedDB 不可用（file:// 常见）→ localStorage → sessionStorage → 内存 逐级降级 */
    const tier=_apiFallbackPut(cfg);
    console.warn('IndexedDB API config write failed; fell back to '+tier+' storage',e);
    return {durability:tier,backend:tier==='persistent'?'localstorage':(tier==='session'?'sessionstorage':'memory'),idb:false,mirror:tier};
  }
}
/* 保存提示语：持久化与「仅会话/仅本页」必须让用户看得出区别 */
function _apiSaveNotice(res){
  const d=res&&res.durability;
  if(d==='session')return 'API已保存（仅当前会话有效，关闭标签页后会丢失）';
  if(d==='memory')return 'API已保存（仅当前页面有效，刷新后会丢失）';
  if(d==='persistent'&&res&&!res.idb)return 'API已保存（IndexedDB 不可用，已写入本地存储）';
  return 'API已保存';
}

async function loadApiConfigs(){
  let all=[];
  try{all=await dbGetAll('apiConfigs')}catch(e){console.warn('IndexedDB API config read failed; using local fallback',e)}
  /* 保留可读记录，并让本地镜像中的新版本覆盖同 id 的旧记录。 */
  const fallback=_apiFallbackRead();
  if(fallback.length){
    /* ⚠ IndexedDB 是权威配置源；localStorage 镜像仅在 IndexedDB 缺失该 id 时兜底补入，
       绝不反向覆盖。否则任一「无 key」的旧/残留镜像拷贝会遮蔽 IndexedDB 中仍完好
       的凭证（apiKey），导致 API 页误报「（无密钥）」而真实凭证并未丢失。 */
    const merged=new Map(all.map(a=>[a.id,a]));
    fallback.forEach(a=>{ if(!merged.has(a.id)) merged.set(a.id,a); });
    all=Array.from(merged.values());
  }
  apiConfigs=all.filter(a=>!a.archived);
  archivedConfigs=all.filter(a=>!!a.archived);
  if(!all.length){
    /* Migrate old single config */
    const old=await dbGet('apiSettings','main');
    if(old&&old.apiKey){
      const cfg={id:'friend_1',provider:old.provider||'anthropic',apiKey:old.apiKey,model:old.model||'',endpoint:old.endpoint||'',systemPrompt:old.systemPrompt||'',nickname:old.aiName||'Glasswing',created:Date.now()};
      await dbPut('apiConfigs',cfg);
      apiConfigs=[cfg];
    }
  }
  /* Sort by user-defined order if present, otherwise by creation time */
  apiConfigs.sort((a,b)=>(a.sortOrder!=null&&b.sortOrder!=null)?(a.sortOrder-b.sortOrder):((a.created||0)-(b.created||0)));
  archivedConfigs.sort((a,b)=>(b.archivedAt||0)-(a.archivedAt||0));
}

async function renderApiList(){
  await loadApiConfigs();
  if(_apiArchView){renderApiArchiveList();return}
  const c=document.getElementById('api-list-container');
  if(!apiConfigs.length){c.innerHTML='<div class="empty-state u-pad-20">还没有添加API</div>';return}
  c.innerHTML=apiConfigs.map((a,idx)=>{
    var keyTag=a.apiKey?'':(_ibIsLoopbackEndpoint(a.endpoint)?'<span style="color:#8bc9a8;font-size:0.68rem;margin-left:6px;font-weight:400">（本机免密钥）</span>':'<span style="color:#e88;font-size:0.68rem;margin-left:6px;font-weight:400">（无密钥）</span>');
    var avInit=(a.nickname||a.model||'?').charAt(0).toUpperCase();
    var avHtml=a.avatar?'<div class="api-item-avatar"><img src="'+a.avatar+'" alt=""></div>':'<div class="api-item-avatar">'+avInit+'</div>';
    return '<div class="chat-history-item" style="cursor:grab;gap:12px" draggable="true" data-api-idx="'+idx+'" data-api-id="'+a.id+'" ondragstart="_apiDragStart(event)" ondragover="_apiDragOver(event)" ondrop="_apiDrop(event)" ondragend="_apiDragEnd(event)" onclick="editApi(\''+a.id+'\')">'+avHtml+'<div style="flex:1;min-width:0"><strong class="api-item-name">'+esc(a.nickname||a.model||'未命名')+keyTag+'</strong>'+(a.relationship?'<span style="font-size:0.7rem;color:var(--accent-light);opacity:0.7;margin-left:6px">'+esc(a.relationship)+'</span>':'')+'<div class="api-item-detail" style="font-size:0.72rem;margin-top:2px">'+esc(a.provider)+' · '+esc(a.model)+'</div></div><span class="del-btn" onclick="event.stopPropagation();deleteApiConfig(\''+a.id+'\')" title="删除">✕</span></div>'}).join('');
}
var _dragApiIdx=null;
function _apiDragStart(e){_dragApiIdx=parseInt(e.currentTarget.dataset.apiIdx);e.currentTarget.style.opacity='0.4';e.dataTransfer.effectAllowed='move'}
function _apiDragOver(e){e.preventDefault();e.dataTransfer.dropEffect='move';const t=e.currentTarget;t.style.borderTop=e.offsetY<t.offsetHeight/2?'2px solid var(--accent)':'none';t.style.borderBottom=e.offsetY>=t.offsetHeight/2?'2px solid var(--accent)':'none'}
function _apiDragEnd(e){e.currentTarget.style.opacity='';document.querySelectorAll('#api-list-container .chat-history-item').forEach(el=>{el.style.borderTop='';el.style.borderBottom=''})}
async function _apiDrop(e){
  e.preventDefault();const targetIdx=parseInt(e.currentTarget.dataset.apiIdx);
  if(_dragApiIdx===null||_dragApiIdx===targetIdx){_apiDragEnd(e);return}
  const insertBefore=e.offsetY<e.currentTarget.offsetHeight/2;
  const item=apiConfigs.splice(_dragApiIdx,1)[0];
  let newIdx=targetIdx>_dragApiIdx?targetIdx-1:targetIdx;
  if(!insertBefore)newIdx++;
  apiConfigs.splice(newIdx,0,item);
  /* Save new order: update all configs with an order field */
  for(let i=0;i<apiConfigs.length;i++){apiConfigs[i].sortOrder=i;await _persistApiConfig(apiConfigs[i])}
  _dragApiIdx=null;renderApiList();loadFriendsList();toast('排序已更新');
}

var _pendingApiAvatar=null;/* null=no change, ''=remove, string=new dataUrl */
function handleApiAvatarUpload(e){
  var f=e.target.files[0];if(!f)return;
  var r=new FileReader();r.onload=function(){
    _pendingApiAvatar=r.result;
    _renderApiAvatarPreview(r.result);
    toast('头像已选择');
  };r.readAsDataURL(f);e.target.value='';
}
function removeApiAvatar(){_pendingApiAvatar='';_renderApiAvatarPreview('');toast('头像已移除（保存后生效）')}
function _renderApiAvatarPreview(src){
  var el=document.getElementById('api-avatar-preview-el');
  if(!el)return;
  if(src){el.innerHTML='<img class="aav-img" src="'+src+'" alt="" onerror="_apiAvatarLoadError(this)">';el.className=''}
  else{
    var nn=(document.getElementById('api-ai-name').value||'').trim();
    var init=nn?nn.charAt(0).toUpperCase():'?';
    el.innerHTML='';el.textContent=init;el.className='aav-placeholder';
  }
}
/* 头像图片加载失败（损坏 dataURL / 失效链接）→ 回退默认占位，不显示破图 */
function _apiAvatarLoadError(img){
  try{
    var el=img&&img.parentElement;if(!el)return;
    var nn=(document.getElementById('api-ai-name')&&document.getElementById('api-ai-name').value||'').trim();
    el.innerHTML='';el.textContent=nn?nn.charAt(0).toUpperCase():'?';el.className='aav-placeholder';
  }catch(e){}
}
/* ── 社交身份：Banner（背景大图，dataUrl；null=no change, ''=remove, string=new） ── */
var _pendingApiBanner=null;
function handleApiBannerUpload(e){
  var f=e.target.files[0];if(!f)return;
  var r=new FileReader();r.onload=function(){
    _pendingApiBanner=r.result;
    _renderApiBannerPreview(r.result);
    toast('背景图已选择');
  };r.readAsDataURL(f);e.target.value='';
}
function removeApiBanner(){_pendingApiBanner='';_renderApiBannerPreview('');toast('背景图已移除（保存后生效）')}
function _renderApiBannerPreview(src){
  var el=document.getElementById('api-banner-preview-el');
  if(!el)return;
  if(src){el.style.backgroundImage='url("'+src+'")';el.classList.add('has-img');el.classList.remove('is-empty')}
  else{el.style.backgroundImage='';el.classList.remove('has-img');el.classList.add('is-empty')}
}
function _normApiHandle(v){
  return String(v||'').trim().replace(/^@+/,'').replace(/\s+/g,'_').replace(/[^\w\u4e00-\u9fa5.\-]/g,'').replace(/^[_.]+/,'').slice(0,32);
}
function addNewApi(){
  editingApiId='friend_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
  _pendingApiAvatar=null;
  _pendingApiBanner=null;
  var _hb=document.getElementById('api-handle');if(_hb)_hb.value='';
  var _bb=document.getElementById('api-bio');if(_bb)_bb.value='';
  var _sb=document.getElementById('api-signature');if(_sb)_sb.value='';
  _renderApiBannerPreview('');
  document.getElementById('api-editor-title').textContent='添加API';
  document.getElementById('api-editor').style.display='block';
  var _dw0=document.getElementById('api-daywrap');if(_dw0)_dw0.style.display='none';
  document.getElementById('api-ai-name').value='';
  document.getElementById('api-provider').value='anthropic';
  onProviderChange();
  document.getElementById('api-key').value='';
  document.getElementById('api-system').value='';
  document.getElementById('api-system').style.opacity='';document.getElementById('api-system').style.fontStyle='';
  document.getElementById('api-system').placeholder=getDefaultPromptForTheme();
  document.getElementById('api-system-default-hint').style.display='block';
  _sysPromptCleared=false;
  document.getElementById('api-relationship').value='';
  document.getElementById('api-temperature').value='1.0';
  document.getElementById('api-temp-val').textContent='1.0';
  document.getElementById('api-story-personalize').checked=false;
  var visionEl=document.getElementById('api-vision-toggle');
  if(visionEl)visionEl.checked=!!(PROVIDERS[document.getElementById('api-provider').value]&&PROVIDERS[document.getElementById('api-provider').value].vision);
  var streamEl=document.getElementById('api-streaming-toggle');
  if(streamEl)streamEl.checked=!!(PROVIDERS[document.getElementById('api-provider').value]&&PROVIDERS[document.getElementById('api-provider').value].streaming);
  var thinkEl=document.getElementById('api-thinking-toggle');
  _showThinkingTouched=false;_syncShowThinkingDefault();thinkEl.disabled=false;
  var wsEl=document.getElementById('api-websearch-toggle');
  if(wsEl)wsEl.checked=false;
  _syncVisionUI();
  var _igT=document.getElementById('api-imagegen-toggle');if(_igT)_igT.checked=false;
  var _igM=document.getElementById('api-imagegen-model');if(_igM)_igM.value='';
  var amT=document.getElementById('api-automem-toggle');if(amT)amT.checked=false;
  var amM=document.getElementById('api-automem-mode');if(amM)amM.value='hybrid';
  var amB=document.getElementById('api-automem-budget');if(amB)amB.value='1200';
  var amR=document.getElementById('api-automem-recordonly');if(amR)amR.checked=false;
  var pcT=document.getElementById('api-cache-toggle');if(pcT)pcT.checked=true;
  var ttlT=document.getElementById('api-cache-ttl');if(ttlT)ttlT.checked=false;
  var _thHint=document.getElementById('api-thinking-hint');
  if(_thHint){_thHint.textContent='只控制展示；reasoning_content 始终与正文分开保存。GLM 默认关闭，DeepSeek 默认开启。';_thHint.style.opacity='0.55'}
  document.getElementById('api-ai-name').focus();
  _renderApiAvatarPreview('');
  /* Voice：新角色回退 Built-in 并清空当前 Reference Audio 选择（防止把上一个角色的克隆引用带进新角色） */
  _voiceProvBeforeSpecial=null;
  _voiceSetType('builtin');
  _voiceCloneSelection=null;
  _voiceTypeChange();
}

/* ===== Token 仪表盘：用量采集、存储与渲染（明细记录上限 5000 条、超出滚动清理最旧；按API隔离展示） ===== */
var _tkCacheDoc=null;
var _tkT0=(function(){var d=new Date();d.setHours(0,0,0,0);return d.getTime()})(),_tkT1=_tkT0;/* 选定起止日（含端点，本地零点），默认为今日单日 */
async function _tkLoad(){if(_tkCacheDoc)return _tkCacheDoc;try{const r=await dbGet('apiSettings','ibTokenStats');_tkCacheDoc=(r&&r.data)||null}catch(e){}if(!_tkCacheDoc)_tkCacheDoc={since:Date.now(),records:[],prices:{}};if(!_tkCacheDoc.records)_tkCacheDoc.records=[];if(!_tkCacheDoc.prices)_tkCacheDoc.prices={};return _tkCacheDoc}
function _tkSave(){if(_tkCacheDoc)try{dbPut('apiSettings',{id:'ibTokenStats',data:_tkCacheDoc})}catch(e){}}
async function _tkRecord(cfg,u){try{if(!u)return;u={i:Math.max(0,u.i|0),cr:Math.max(0,u.cr|0),cw:Math.max(0,u.cw|0),o:Math.max(0,u.o|0)};if(!(u.i||u.cr||u.cw||u.o))return;const d=await _tkLoad();const _r={t:Date.now(),cid:(cfg&&cfg.id)||'',m:(cfg&&cfg.model)||'',i:u.i,cr:u.cr,cw:u.cw,o:u.o};if(cfg&&cfg.cacheTtl1h&&cfg.promptCache!==false)_r.h=1;/* 与 _ccObj 同判定：该次请求的缓存写入按 1 小时 ×2 计价 */d.records.push(_r);if(d.records.length>5000)d.records.splice(0,d.records.length-5000);_tkSave();}catch(e){}}
function _tkFmt(n){n=n||0;if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n)}
function _tkEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function _tkCost(a,p){if(!p||(p.i==null&&p.o==null))return null;var pi=+p.i||0,po=+p.o||0;var ch=a.cwh!=null?(+a.cwh||0):(a.h?(a.cw||0):0);return(a.i*pi+a.cr*pi*0.1+a.cw*pi*1.25+ch*pi*0.75+a.o*po)/1e6}/* 官方口径：缓存读取 ×0.1；缓存写入 5 分钟 ×1.25、1 小时 ×2（ch 为 1h 写入量，在 ×1.25 基础上补 ×0.75）；无 h/cwh 的历史记录与旧版结果逐位一致 */
async function _tkPrice(m,k,v){const d=await _tkLoad();const pr=d.prices[m]=d.prices[m]||{};const n=parseFloat(v);if(isFinite(n)&&n>=0)pr[k]=n;else delete pr[k];_tkSave();renderTokenDash()}
/* ── 起止日期任选（含端点，本地零点对齐）：渲染与删除共用同一套计算，保证"清除此范围"删掉的恰好是当前视图展示的记录 ── */
function _tkDay0(t){var d=new Date(t);d.setHours(0,0,0,0);return d.getTime()}
function _tkAddD(t,n){var d=new Date(t);d.setDate(d.getDate()+n);d.setHours(0,0,0,0);return d.getTime()}
function _tkRangeT0(){return _tkT0}
function _tkRangeT1x(){return _tkAddD(_tkT1,1)}/* 结束日次日零点（开区间上界），跨夏令时安全 */
function _tkFmtD(t){var d=new Date(t);return (d.getMonth()+1)+'/'+d.getDate()}
function _tkRangeLabel(){if(_tkT0===_tkT1)return _tkT0===_tkDay0(Date.now())?'今日':_tkFmtD(_tkT0);return _tkFmtD(_tkT0)+' — '+_tkFmtD(_tkT1)}
function _tkRangeTextSync(){var el=document.getElementById('tk-range-text');if(el)el.textContent=_tkRangeLabel()}
/* ── 日历弹层：第一次点选起始日，第二次点选结束日（自动纠正先后），点同一天即单日 ── */
var _tkCalM=null,_tkCalPick=null;
function _tkCalToggle(ev){if(ev)ev.stopPropagation();var c=document.getElementById('tk-cal');if(!c)return;
  if(!c.hidden){_tkCalClose();return}
  _tkCalM=new Date(_tkT1);_tkCalM.setDate(1);_tkCalM.setHours(0,0,0,0);_tkCalPick=null;
  if(c.parentNode!==document.body)document.body.appendChild(c);/* 传送到 body:脱离祖先 backdrop-filter/transform,真模糊+顶层层叠 */
  _tkCalRender();c.hidden=false;_tkCalPlace();
  window.addEventListener('scroll',_tkCalPlace,true);window.addEventListener('resize',_tkCalPlace);
  setTimeout(function(){document.addEventListener('click',_tkCalDoc,true);document.addEventListener('keydown',_tkCalKey,true)},0)}
function _tkCalPlace(){var c=document.getElementById('tk-cal'),b=document.getElementById('tk-range-btn');if(!c||c.hidden||!b)return;
  var r=b.getBoundingClientRect(),W=c.offsetWidth,H=c.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;
  var x=Math.max(8,Math.min(r.right-W,vw-W-8));
  var y=r.bottom+8;if(y+H>vh-8&&r.top-H-8>8)y=r.top-H-8;y=Math.max(8,Math.min(y,vh-H-8));
  c.style.left=Math.round(x)+'px';c.style.top=Math.round(y)+'px'}
function _tkCalClose(){var c=document.getElementById('tk-cal');if(c)c.hidden=true;_tkCalPick=null;
  window.removeEventListener('scroll',_tkCalPlace,true);window.removeEventListener('resize',_tkCalPlace);
  document.removeEventListener('click',_tkCalDoc,true);document.removeEventListener('keydown',_tkCalKey,true)}
function _tkCalDoc(e){var w=document.getElementById('tk-range'),c=document.getElementById('tk-cal');
  if((w&&w.contains(e.target))||(c&&c.contains(e.target)))return;_tkCalClose()}
function _tkCalKey(e){if(e.key==='Escape')_tkCalClose()}
function _tkCalNav(n,ev){if(ev)ev.stopPropagation();_tkCalM.setMonth(_tkCalM.getMonth()+n);_tkCalRender()}
function _tkCalPickDay(t,ev){if(ev)ev.stopPropagation();
  if(_tkCalPick==null){_tkCalPick=t;_tkCalRender();return}
  var a=Math.min(_tkCalPick,t),b=Math.max(_tkCalPick,t);
  _tkT0=a;_tkT1=b;_tkCalPick=null;_tkCalClose();_tkRangeTextSync();renderTokenDash()}
function _tkCalRender(){var c=document.getElementById('tk-cal');if(!c)return;
  var y=_tkCalM.getFullYear(),mo=_tkCalM.getMonth(),td=_tkDay0(Date.now());
  var lead=(new Date(y,mo,1).getDay()+6)%7,dim=new Date(y,mo+1,0).getDate();
  var selA=(_tkCalPick!=null)?_tkCalPick:Math.min(_tkT0,_tkT1),selB=(_tkCalPick!=null)?_tkCalPick:Math.max(_tkT0,_tkT1);
  var _MN=['January','February','March','April','May','June','July','August','September','October','November','December'];
  var h='<div class="tk-cal-hd"><button type="button" onclick="_tkCalNav(-1,event)" aria-label="上一月">&#8249;</button><span>'+_MN[mo]+' '+y+'</span><button type="button" onclick="_tkCalNav(1,event)" aria-label="下一月">&#8250;</button></div>'
   +'<div class="tk-cal-wk"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="tk-cal-g">';
  for(var i=0;i<lead;i++)h+='<i></i>';
  for(var d=1;d<=dim;d++){var t=new Date(y,mo,d).getTime();var cls='';
    if(t>=selA&&t<=selB)cls+=' in';
    if(t===selA||t===selB)cls+=' cap';
    if(t===td)cls+=' today';
    h+='<button type="button" class="tk-cal-d'+cls+'" onclick="_tkCalPickDay('+t+',event)">'+d+'</button>'}
  h+='</div><div class="tk-cal-ft">'+(_tkCalPick!=null?('已选起点 '+_tkFmtD(_tkCalPick)+'，再点一天作为终点'):'点两次选起止；点同一天即查看单日')+'</div>';
  c.innerHTML=h;if(!c.hidden)_tkCalPlace()}
async function _tkClearRange(){
  const d=await _tkLoad();
  const t0=_tkRangeT0(),t1=_tkRangeT1x();
  const hit=d.records.filter(function(x){return x.t>=t0&&x.t<t1}).length;
  if(!hit){toast('该时间段暂无可删除的记录');return}
  if(!confirm('\u26a0 将删除【'+_tkRangeLabel()+'】范围内的 '+hit+' 条用量记录，此操作不可恢复。\n\n（聊天记录与模型单价设置不受影响）'))return;
  d.records=d.records.filter(function(x){return x.t<t0||x.t>=t1});
  if(!d.records.length)d.since=Date.now();
  _tkSave();renderTokenDash();
  toast('已删除 '+hit+' 条用量记录');
  try{updateDangerStorageInfo()}catch(e){}
}
async function _tkWipeAll(){
  const d=await _tkLoad();
  const n=(d.records||[]).length;
  if(!n){toast('Token 仪表盘暂无记录');return}
  if(!confirm('\u26a0 确定要一键清空 Token 仪表盘的全部用量记录？\n\n共 '+n+' 条明细将被删除且不可恢复（模型单价设置会保留）。'))return;
  d.records=[];d.since=Date.now();
  _tkSave();
  try{renderTokenDash()}catch(e){}
  toast('Token 统计已全部清空');
  try{updateDangerStorageInfo()}catch(e){}
}
async function renderTokenDash(){
  const body=document.getElementById('tk-body'),note=document.getElementById('tk-note');
  if(!body)return;
  const d=await _tkLoad();
  const now=Date.now();
  const t0=_tkRangeT0(),t1=_tkRangeT1x();
  const recs=d.records.filter(function(x){return x.t>=t0&&x.t<t1});
  const noteBase='缓存读取按输入单价 \u00d70.1、缓存写入 \u00d71.25（勾选「长效缓存 1 小时」的写入按官方口径 \u00d72）估算；费用为估算值，与账单可能有差异；个别 OpenAI 兼容端点不回传用量时该次无记录。明细最多保留最近 5000 条，超出自动清理最旧。';
  if(!recs.length){var _tkS=document.getElementById('tk-summary');if(_tkS)_tkS.textContent='该时间段暂无记录';body.innerHTML='<div class="tk-empty">开始对话后自动统计用量。</div>';if(note)note.textContent=noteBase;return}
  var _tkS2=document.getElementById('tk-summary');if(_tkS2)_tkS2.textContent='共 '+recs.length+' 次请求';const T={i:0,cr:0,cw:0,o:0};const byM={};
  recs.forEach(function(r){T.i+=r.i;T.cr+=r.cr;T.cw+=r.cw;T.o+=r.o;const g=byM[r.m]=byM[r.m]||{i:0,cr:0,cw:0,cwh:0,o:0,n:0,days:{}};g.i+=r.i;g.cr+=r.cr;g.cw+=r.cw;if(r.h)g.cwh+=r.cw;g.o+=r.o;g.n++;const dk=Math.floor((now-r.t)/864e5);if(dk>=0&&dk<7)g.days[6-dk]=(g.days[6-dk]||0)+r.i+r.cr+r.o});
  const inAll=T.i+T.cr+T.cw;const hit=inAll?Math.round(T.cr/inAll*1000)/10:0;
  const CC=251.33,tt=(inAll+T.o)||1;
  const segCr=CC*T.cr/tt,segIn=CC*(T.i+T.cw)/tt,segO=Math.max(0,CC-segCr-segIn);
  let cost=0,costKnown=true;
  const models=Object.keys(byM).sort(function(a,b){return(byM[b].i+byM[b].cr+byM[b].o)-(byM[a].i+byM[a].cr+byM[a].o)});
  models.forEach(function(m){const c=_tkCost(byM[m],d.prices[m]);if(c==null)costKnown=false;else cost+=c});
  let h='<div class="tk-grid"><div class="tk-left">'
   +'<div class="tk-ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" class="tk-rb"></circle>'
   +'<circle cx="50" cy="50" r="40" class="tk-rc" stroke-dasharray="'+segCr.toFixed(1)+' '+CC+'"></circle>'
   +'<circle cx="50" cy="50" r="40" class="tk-ri" stroke-dasharray="'+segIn.toFixed(1)+' '+CC+'" stroke-dashoffset="'+(-segCr).toFixed(1)+'"></circle>'
   +'<circle cx="50" cy="50" r="40" class="tk-ro" stroke-dasharray="'+segO.toFixed(1)+' '+CC+'" stroke-dashoffset="'+(-(segCr+segIn)).toFixed(1)+'"></circle></svg>'
   +'<div class="tk-cx"><span class="tk-pct">'+hit+'%</span><span>缓存命中</span></div></div>'
   +'<div class="tk-tot">输入 <b>'+_tkFmt(T.i+T.cw)+'</b> · 缓存读取 <b>'+_tkFmt(T.cr)+'</b><br>输出 <b>'+_tkFmt(T.o)+'</b> · 共 '+recs.length+' 次请求<br>估算费用 <b class="au">'+(costKnown?'$'+cost.toFixed(2):(cost>0?'&ge; $'+cost.toFixed(2):'&mdash;'))+'</b></div>'
   +'<div class="tk-leg"><i class="lc">缓存读取</i><i class="li">未缓存输入</i><i class="lo">输出</i></div></div>'
   +'<div class="tk-rows">';
  models.forEach(function(m){
    const g=byM[m];const pr=d.prices[m]||{};const c=_tkCost(g,pr);
    const hm=(g.i+g.cr+g.cw)?Math.round(g.cr/(g.i+g.cr+g.cw)*100):0;
    let mx=1,k;for(k=0;k<7;k++)if((g.days[k]||0)>mx)mx=g.days[k];
    let bars='';for(k=0;k<7;k++)bars+='<i style="height:'+Math.max(8,Math.round((g.days[k]||0)/mx*100))+'%"></i>';
    const mq=_tkEsc(m).replace(/'/g,'&#39;');
    const ptt=(pr.i!=null)?('按输入单价推导：缓存读取 $'+(+pr.i*0.1).toFixed(2)+'/M · 缓存写入 $'+(+pr.i*1.25).toFixed(2)+'/M（1小时长效 $'+(+pr.i*2).toFixed(2)+'/M）'):'填写输入单价后自动按官方口径推导：缓存读取 ×0.1 · 缓存写入 ×1.25（1小时长效 ×2）';
    h+='<div class="tk-row"><div class="r1"><span class="nm" title="'+_tkEsc(m)+'">'+(_tkEsc(m)||'（未记录模型名）')+'</span>'
     +'<span class="tk-spark">'+bars+'</span>'
     +'<input class="tk-price" placeholder="输入$/M" title="'+ptt+'" value="'+(pr.i!=null?pr.i:'')+'" onchange="_tkPrice(&#39;'+mq+'&#39;,&#39;i&#39;,this.value)">'
     +'<input class="tk-price" placeholder="输出$/M" value="'+(pr.o!=null?pr.o:'')+'" onchange="_tkPrice(&#39;'+mq+'&#39;,&#39;o&#39;,this.value)">'
     +'<span class="tk-c">'+(c==null?'&mdash;':'$'+c.toFixed(2))+'</span></div>'
     +'<div class="sub">输入 '+_tkFmt(g.i+g.cw)+' · 缓存 '+_tkFmt(g.cr)+' · 输出 '+_tkFmt(g.o)+' · 命中 '+hm+'%</div></div>';
  });
  h+='</div></div>';
  h+='<div class="tk-exh">最近对话消耗<span class="tk-exn">全部 '+recs.length+' 条</span></div><div class="tk-exl">';
  recs.slice().reverse().forEach(function(r){/* 完整展示当前时间段内的全部明细（原先截断为最近40条） */
    const c=_tkCost(r,d.prices[r.m]);const tmd=new Date(r.t);
    const hh=('0'+tmd.getHours()).slice(-2)+':'+('0'+tmd.getMinutes()).slice(-2);
    const dd=(now-r.t)>864e5?((tmd.getMonth()+1)+'/'+tmd.getDate()+' '):'';
    h+='<div class="tk-ex"><span class="t">'+dd+hh+'</span><span class="m">'+_tkEsc(r.m)+'</span><span class="d">输入 '+_tkFmt(r.i+r.cw)+'（缓存 '+_tkFmt(r.cr)+'）· 输出 '+_tkFmt(r.o)+'</span><span class="c">'+(c==null?'&mdash;':'$'+c.toFixed(3))+'</span></div>';
  });
  h+='</div>';
  body.innerHTML=h;
  /* 「最近对话消耗」高度：默认约 6 条；用户拖动右下角调节后记忆到本机（ib_tkExlH），重渲染时恢复 */
  try{
    var _exl=body.querySelector('.tk-exl');
    if(_exl){
      var _exh=parseInt(localStorage.getItem('ib_tkExlH')||'',10);
      if(_exh>=54&&_exh<=2000)_exl.style.height=_exh+'px';
      if(typeof ResizeObserver!=='undefined'){
        var _exT=null;
        new ResizeObserver(function(){
          if(_exT)clearTimeout(_exT);
          _exT=setTimeout(function(){try{if(_exl.isConnected&&_exl.offsetHeight>0)localStorage.setItem('ib_tkExlH',String(Math.round(_exl.offsetHeight)))}catch(e){}},300);
        }).observe(_exl);
      }
    }
  }catch(e){}
  if(note)note.textContent='记录自 '+new Date(d.since).toLocaleDateString()+' 起 · '+noteBase;
}

function editApi(id){
  const cfg=apiConfigs.find(a=>a.id===id);
  if(!cfg)return;
  editingApiId=id;
  document.getElementById('api-editor-title').textContent='编辑API';
  document.getElementById('api-editor').style.display='block';
  var _dw1=document.getElementById('api-daywrap');if(_dw1)_dw1.style.display='';
  var _db1=document.getElementById('api-daybox');if(_db1)_db1.style.display='none';
  var _dc1=document.getElementById('api-daycaret');if(_dc1)_dc1.classList.remove('open');
  document.getElementById('api-ai-name').value=cfg.nickname||'';
  document.getElementById('api-relationship').value=cfg.relationship||'';
  document.getElementById('api-provider').value=cfg.provider||'anthropic';
  document.getElementById('api-key').value=cfg.apiKey||'';
  document.getElementById('api-model').value=cfg.model||'';
  document.getElementById('api-endpoint').value=cfg.endpoint||'';
  document.getElementById('api-system').value=cfg.systemPrompt||'';
  var isDefault=cfg.systemPrompt&&(cfg.systemPrompt===DEFAULT_SYSTEM_PROMPT||cfg.systemPrompt===INFERNAL_SYSTEM_PROMPT);
  if(isDefault){document.getElementById('api-system').value='';document.getElementById('api-system').placeholder=getDefaultPromptForTheme();document.getElementById('api-system-default-hint').style.display='block';_sysPromptCleared=false}else{document.getElementById('api-system').placeholder='设置AI的系统提示词…';document.getElementById('api-system-default-hint').style.display='none';_sysPromptCleared=true}
  document.getElementById('api-temperature').value=cfg.temperature!=null?cfg.temperature:1.0;
  document.getElementById('api-temp-val').textContent=cfg.temperature!=null?cfg.temperature:'1.0';
  document.getElementById('api-story-personalize').checked=!!cfg.storyPersonalize;
  var visionEl=document.getElementById('api-vision-toggle');
  if(visionEl)visionEl.checked=cfg.vision!==undefined?!!cfg.vision:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].vision);
  var streamEl=document.getElementById('api-streaming-toggle');
  if(streamEl)streamEl.checked=cfg.streaming!==undefined?!!cfg.streaming:!!(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].streaming);
  _syncVisionUI();
  var _amT=document.getElementById('api-automem-toggle');if(_amT)_amT.checked=!!cfg.autoMem;
  var _amM=document.getElementById('api-automem-mode');if(_amM)_amM.value=cfg.autoMemMode||'hybrid';
  var _amB=document.getElementById('api-automem-budget');if(_amB)_amB.value=cfg.autoMemBudget||1200;
  var _amR=document.getElementById('api-automem-recordonly');if(_amR)_amR.checked=!!cfg.amRecordOnly;
  var _pcT=document.getElementById('api-cache-toggle');if(_pcT)_pcT.checked=cfg.promptCache!==false;
  var _ttlT=document.getElementById('api-cache-ttl');if(_ttlT)_ttlT.checked=!!cfg.cacheTtl1h;
  var thinkEl=document.getElementById('api-thinking-toggle');
  thinkEl.checked=_resolveShowThinking(cfg);
  thinkEl.disabled=false;
  _showThinkingTouched=typeof cfg.showThinking==='boolean';
  var wsEl=document.getElementById('api-websearch-toggle');
  if(wsEl)wsEl.checked=!!cfg.webSearch;
  var _ct2=document.getElementById('api-concise-toggle');if(_ct2)_ct2.checked=(cfg.replyStyle==='concise');
  var _ne2=document.getElementById('api-naturalending-toggle');if(_ne2)_ne2.checked=!!cfg.naturalEnding;
  var _cc2=document.getElementById('api-continuity-toggle');if(_cc2)_cc2.checked=!!cfg.conversationContinuity;
  var _igT2=document.getElementById('api-imagegen-toggle');if(_igT2)_igT2.checked=!!cfg.imageGen;
  var _igW2=document.getElementById('api-waifu-toggle');if(_igW2)_igW2.checked=!!cfg.waifu;
  var _igM2=document.getElementById('api-imagegen-model');if(_igM2)_igM2.value=cfg.imageGenModel||'';
  var _igP2=document.getElementById('api-imagegen-provider');if(_igP2)_igP2.value=cfg.imageGenProvider||'';
  var _igE2=document.getElementById('api-imagegen-endpoint');if(_igE2)_igE2.value=cfg.imageGenEndpoint||'';
  var _igK2=document.getElementById('api-imagegen-apikey');if(_igK2)_igK2.value=cfg.imageGenApiKey||'';
  /* Voice settings */
  var vc=cfg.voice||{};
  var _vt=document.getElementById('api-voice-toggle');if(_vt)_vt.checked=!!vc.enabled;
  var _vp=document.getElementById('api-voice-provider');if(_vp)_vp.value=vc.provider||'edge';
  var _vi=document.getElementById('api-voice-id');if(_vi)_vi.value=vc.voiceId||'';
  var _vr=document.getElementById('api-voice-rate');if(_vr)_vr.value=vc.rate||1.0;_voiceRateUpdate();
  var _vpi=document.getElementById('api-voice-pitch');if(_vpi)_vpi.value=vc.pitch||'+0Hz';
  var _va=document.getElementById('api-voice-autoplay');if(_va)_va.checked=!!vc.autoPlay;
  /* Voice Profile 新字段（可编辑：model/language/style；voiceType/voiceData 仅透传不展示） */
  var _vm2=document.getElementById('api-voice-model');if(_vm2)_vm2.value=vc.model||'';
  var _vl2=document.getElementById('api-voice-language');if(_vl2)_vl2.value=vc.language||'';
  var _vs2=document.getElementById('api-voice-style');if(_vs2)_vs2.value=vc.style||'';
  /* VoiceClone/VoiceDesign（第三阶段 B1/B2/C）：Voice Type 与当前引用恢复 */
  _voiceProvBeforeSpecial=null;
  _voiceSetType((vc.voiceType==='clone'||vc.voiceType==='design')?vc.voiceType:'builtin');
  _voiceCloneSelection=(vc.voiceType==='clone'&&vc.voiceData&&typeof vc.voiceData==='object'&&vc.voiceData.refAudioId)
    ?{refAudioId:String(vc.voiceData.refAudioId),mime:vc.voiceData.mime||'',ext:vc.voiceData.ext||'',name:vc.voiceData.name||'',size:Number(vc.voiceData.size)||0}
    :null;
  _voiceToggleDetail();
  /* 重建目录选项后再按 provider 归位 Voice ID（预置下拉 / 自由输入二选一） */
  _voiceSetId(vc.voiceId);
  var _thHint=document.getElementById('api-thinking-hint');
  if(_thHint){_thHint.textContent='只控制展示；reasoning_content 始终与正文分开保存。GLM 默认关闭，DeepSeek 默认开启。';_thHint.style.opacity='0.7'}
  _pendingApiAvatar=null;
  /* 头像来源：优先 cfg.avatar；兼容历史/导入数据中的 avatarUrl 与 character 子对象字段 */
  var _avSrc=cfg.avatar||cfg.avatarUrl||(cfg.character&&(cfg.character.avatar||cfg.character.avatarUrl||cfg.character.image))||'';
  console.log('API Editor character avatar:',cfg.avatar,'| avatarUrl:',cfg.avatarUrl||'','| character sub-object:',cfg.character&&(cfg.character.avatar||cfg.character.avatarUrl||cfg.character.image)||'');
  _renderApiAvatarPreview(_avSrc);
  var lbl=document.getElementById('api-avatar-label');
  if(lbl)lbl.textContent=(cfg.nickname||'AI')+' 的头像';
  /* 社交身份（AI 社交网络）：handle / banner / bio / signature / joinedAt（旧数据无字段则回落到派生值） */
  var _hd=document.getElementById('api-handle');if(_hd)_hd.value=cfg.handle||'';
  var _bd=document.getElementById('api-bio');if(_bd)_bd.value=cfg.bio||'';
  var _sd=document.getElementById('api-signature');if(_sd)_sd.value=cfg.signature||'';
  _pendingApiBanner=null;
  _renderApiBannerPreview(cfg.banner||'');
  var _jl=document.getElementById('api-joined-label');
  if(_jl)_jl.textContent=cfg.joinedAt||cfg.created?('Joined '+(new Date(Number(cfg.joinedAt||cfg.created)||Date.now()).toLocaleDateString('en-US',{year:'numeric',month:'long'}))):'Joined —';
}

async function saveCurrentApi(btn){
  if(btn&&btn.disabled)return;
  const oldBtnText=btn&&btn.textContent;
  if(btn){btn.disabled=true;btn.textContent='保存中…'}
  /* Check nickname uniqueness：按最终显示名比较（昵称留空时回落到模型名），覆盖"同模型+空昵称"的重名情况 */
  var nn=(document.getElementById('api-ai-name').value||'').trim();
  var modelVal=(document.getElementById('api-model').value||'').trim();
  var effName=nn||modelVal||'AI';
  var dup=apiConfigs.find(function(c){return c.id!==editingApiId&&String(c.nickname||c.model||'').trim()===effName});
  if(dup){toast(nn?('昵称「'+nn+'」已被其他API使用，请换一个不同的昵称。'):('昵称留空时显示名为模型名「'+effName+'」，与其他API重复，请填写一个昵称。'));if(btn){btn.disabled=false;btn.textContent=oldBtnText}return}
  /* @账号（社交身份）：规范化 + 查重（留空则由展示层回落到昵称派生名） */
  var _hRaw=(document.getElementById('api-handle')?document.getElementById('api-handle').value:'').trim();
  var _hVal=_normApiHandle(_hRaw);
  if(_hVal){
    var _hDup=apiConfigs.find(function(c){return c.id!==editingApiId&&String(c.handle||'').toLowerCase()===_hVal.toLowerCase()});
    if(_hDup){toast('@账号「@'+_hVal+'」已被「'+(_hDup.nickname||_hDup.model||'另一角色')+'」使用，请换一个。');if(btn){btn.disabled=false;btn.textContent=oldBtnText}return}
  }
  if(!editingApiId){toast('保存失败：API 配置标识已失效，请重新打开编辑器');if(btn){btn.disabled=false;btn.textContent=oldBtnText}return}
  /* VoiceClone：选了 Clone 但还没有 Reference Audio（未上传 / 引用已清空）→ 阻断保存 */
  if(_voiceCurrentType()==='clone'&&(!_voiceCloneSelection||!_voiceCloneSelection.refAudioId)){
    toast('请先上传 Reference Audio 再保存克隆音色');
    if(btn){btn.disabled=false;btn.textContent=oldBtnText}return;
  }
  /* VoiceDesign：选了 Design 但没有「Voice Design 描述」→ 阻断保存（官方 user 消息必填） */
  if(_voiceCurrentType()==='design'&&!String((document.getElementById('api-voice-style')||{}).value||'').trim()){
    toast('请先填写 Voice Design 描述再保存');
    if(btn){btn.disabled=false;btn.textContent=oldBtnText}return;
  }
  /* Merge with existing config to preserve sortOrder, avatar, created, archived etc. */
  _syncVisionUI();/* 视觉模型名命中时保持“支持图片识别”与保存值一致 */
  const existing=apiConfigs.find(a=>a.id===editingApiId)||{};
  /* Resolve avatar: _pendingApiAvatar===null means no change, ''=remove, string=new */
  var avatarVal=existing.avatar||'';
  if(_pendingApiAvatar!==null)avatarVal=_pendingApiAvatar;
  /* Resolve banner（社交身份背景图）：三态同头像 */
  var bannerVal=existing.banner||'';
  if(_pendingApiBanner!==null)bannerVal=_pendingApiBanner;
  const cfg=Object.assign({},existing,{
    id:editingApiId,
    provider:document.getElementById('api-provider').value,
    apiKey:document.getElementById('api-key').value.trim(),
    model:modelVal,
    endpoint:document.getElementById('api-endpoint').value.trim(),
    systemPrompt:document.getElementById('api-system').value||(_sysPromptCleared?'':getDefaultPromptForTheme()),
    nickname:effName,
    relationship:document.getElementById('api-relationship').value.trim().slice(0,16)||'',
    /* ── 社交身份（AI 社交网络）：全部可选、带回落，旧数据兼容 ── */
    handle:_hVal,
    banner:bannerVal,
    bio:document.getElementById('api-bio')?document.getElementById('api-bio').value.trim().slice(0,160):'',
    signature:document.getElementById('api-signature')?document.getElementById('api-signature').value.trim().slice(0,80):'',
    joinedAt:existing.joinedAt||existing.created||Date.now(),
    temperature:parseFloat(document.getElementById('api-temperature').value)||1.0,
    storyPersonalize:document.getElementById('api-story-personalize').checked,
    vision:_isDeepSeekNativeVisionModel(modelVal)?true:!!document.getElementById('api-vision-toggle').checked,
    streaming:!!document.getElementById('api-streaming-toggle').checked,
    webSearch:!!(document.getElementById('api-websearch-toggle')&&document.getElementById('api-websearch-toggle').checked),
    replyStyle:(document.getElementById('api-concise-toggle')&&document.getElementById('api-concise-toggle').checked)?'concise':'normal',
    naturalEnding:!!(document.getElementById('api-naturalending-toggle')&&document.getElementById('api-naturalending-toggle').checked),
    conversationContinuity:!!(document.getElementById('api-continuity-toggle')&&document.getElementById('api-continuity-toggle').checked),
    imageGen:(document.getElementById('api-imagegen-toggle')&&document.getElementById('api-imagegen-toggle').checked),
    imageGenModel:(document.getElementById('api-imagegen-model')?document.getElementById('api-imagegen-model').value.trim():''),
    waifu:!!(document.getElementById('api-waifu-toggle')&&document.getElementById('api-waifu-toggle').checked),
    imageGenProvider:(function(){var el=document.getElementById('api-imagegen-provider');var v=(el&&el.value||'');return['','openai','gemini'].indexOf(v)>-1?v:''})(),
    imageGenEndpoint:(document.getElementById('api-imagegen-endpoint')?document.getElementById('api-imagegen-endpoint').value.trim():''),
    imageGenApiKey:(document.getElementById('api-imagegen-apikey')?document.getElementById('api-imagegen-apikey').value.trim():''),
    autoMem:!!(document.getElementById('api-automem-toggle')&&document.getElementById('api-automem-toggle').checked),
    autoMemMode:(document.getElementById('api-automem-mode')&&document.getElementById('api-automem-mode').value)||'hybrid',
    autoMemBudget:parseInt(document.getElementById('api-automem-budget')&&document.getElementById('api-automem-budget').value)||1200,
    amRecordOnly:!!(document.getElementById('api-automem-recordonly')&&document.getElementById('api-automem-recordonly').checked),
    promptCache:!(document.getElementById('api-cache-toggle')&&!document.getElementById('api-cache-toggle').checked),
    cacheTtl1h:!!(document.getElementById('api-cache-ttl')&&document.getElementById('api-cache-ttl').checked),
    showThinking:document.getElementById('api-thinking-toggle').checked,
    thinkingEnabled:existing.thinkingEnabled!==undefined?existing.thinkingEnabled:true,
    /* Voice：合并式写入 —— 旧字段语义不变；UI 未展示的扩展字段（如 voiceData 内未来的字段）
       必须原样保留，防止「打开编辑器再保存」清掉手改 JSON 的配置（Voice Profile 兼容铁律）。
       VoiceClone：voiceData 在既有对象之上合并 refAudioId/mime/name/size，绝不覆盖未来字段；
       Built-in：voiceData 原样透传（含历史未来字段）。 */
    voice:(function(){
      var _pv=existing.voice&&typeof existing.voice==='object'?existing.voice:{};
      var _pvType=_voiceCurrentType();
      var _pvData;
      if(_pvType==='clone'){
        var _sel=_voiceCloneSelection||{};
        var _baseVoiceData=(_pv.voiceData&&typeof _pv.voiceData==='object'&&!Array.isArray(_pv.voiceData))?_pv.voiceData:{};
        _pvData=Object.assign({},_baseVoiceData,{
          refAudioId:String(_sel.refAudioId||_baseVoiceData.refAudioId||''),
          mime:String(_sel.mime||_baseVoiceData.mime||''),
          name:String(_sel.name||_baseVoiceData.name||''),
          size:Number(_sel.size||_baseVoiceData.size||0)
        });
      }else{
        _pvData=_pv.voiceData!=null?_pv.voiceData:null;
      }
      return Object.assign({},_pv,{
        enabled:!!(document.getElementById('api-voice-toggle')&&document.getElementById('api-voice-toggle').checked),
        provider:(document.getElementById('api-voice-provider')&&document.getElementById('api-voice-provider').value)||'edge',
        voiceId:_voiceGetId(),
        rate:parseFloat((document.getElementById('api-voice-rate')&&document.getElementById('api-voice-rate').value)||'1.0')||1.0,
        pitch:(document.getElementById('api-voice-pitch')&&document.getElementById('api-voice-pitch').value)||'+0Hz',
        autoPlay:!!(document.getElementById('api-voice-autoplay')&&document.getElementById('api-voice-autoplay').checked),
        model:(document.getElementById('api-voice-model')&&document.getElementById('api-voice-model').value)||'',
        language:(document.getElementById('api-voice-language')&&document.getElementById('api-voice-language').value)||'',
        style:(document.getElementById('api-voice-style')&&document.getElementById('api-voice-style').value)||'',
        voiceType:_pvType,
        voiceData:_pvData
      });
    })(),
    avatar:avatarVal,
    sortOrder:existing.sortOrder!=null?existing.sortOrder:undefined,
    created:existing.created||Date.now(),
    sealTimestamp:existing.sealTimestamp||undefined
  });
  if(existing.id&&typeof _activePrepareCharacterBackgroundChange==='function'&&!(await _activePrepareCharacterBackgroundChange(existing.id,'更新角色 API 配置'))){if(btn){btn.disabled=false;btn.textContent=oldBtnText}return}
  try{
    const persisted=await _persistApiConfig(cfg);
    /* 校验读回：走 IndexedDB 时仍以 IndexedDB 为准，降级后从实际落地的那一层读回 */
    const saved=persisted.idb?await dbGet('apiConfigs',cfg.id):_apiFallbackRead().find(a=>a.id===cfg.id);
    if(!saved||saved.apiKey!==cfg.apiKey)throw new Error('保存后校验失败');
    _pendingApiAvatar=null;
    await renderApiList();
    try{await loadFriendsList()}catch(e){}
    try{if(activeFriendId)await loadChatMessages()}catch(e){}
    try{if(typeof _activeSyncAllBackground==='function'&&_activeCompanionOnline){_activeLastContextSync=0;await _activeSyncAllBackground()}}catch(e){console.warn('[Active Messages] API update sync failed',e)}
    document.getElementById('api-editor').style.display='none';
    toast(_apiSaveNotice(persisted));
  }catch(e){
    console.error('API config save failed',e);
    toast('API保存失败：'+String(e&&e.message||e||'浏览器存储不可用').slice(0,80));
  }finally{
    if(btn){btn.disabled=false;btn.textContent=oldBtnText}
  }
}

function cancelApiEdit(){document.getElementById('api-editor').style.display='none'}

/* ── Archived（归档区）：删除对话框（归档 / 彻底删除）、归档、恢复与归档视图 ── */
var _ARCH_CLOCK_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><polyline points="12 7.2 12 12 15.3 13.9"/></svg>';
var _ARCH_RETURN_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="10 6 4 12 10 18"/><path d="M4 12h16"/></svg>';
var _ARCH_RESTORE_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>';
var _adlTargetId=null,_adlChoice='archive',_adlResolve=null;
async function _findGroupsReferencingCharacter(characterId){
  let groups=[];
  try{groups=await dbGetAll('groups')}catch(e){return[]}
  return groups.filter(function(group){
    if(!group)return false;
    normalizeGroupMembers(group);
    return group.members.some(function(member){return member&&member.characterId===characterId});
  });
}
async function _detachCharacterFromGroups(characterId){
  const groups=await _findGroupsReferencingCharacter(characterId);
  let detached=0;
  for(const group of groups){
    const before=group.members.length;
    group.members=group.members.filter(function(member){return member.characterId!==characterId});
    if(group.members.length===before)continue;
    await dbPut('groups',group);
    try{await insertGroupSystemEvent(group.id,'member_leave',characterId)}catch(e){}
    detached++;
  }
  return detached;
}
function deleteApiConfig(id){
  return (async function(){
    const cfg=apiConfigs.find(a=>a.id===id);
    if(!cfg)return false;
    const refs=await _findGroupsReferencingCharacter(id);
    _adlTargetId=id;
    document.getElementById('api-del-title').textContent='删除 '+(cfg.nickname||cfg.model||'API')+'？'+(refs.length?'（将从 '+refs.length+' 个群聊中移除）':'');
    _adlPick('archive');
    document.getElementById('api-del-overlay').classList.add('show');
    return new Promise(function(resolve){_adlResolve=resolve});
  })();
}
function _adlPick(v){
  _adlChoice=v;
  document.getElementById('adl-opt-archive').classList.toggle('on',v==='archive');
  document.getElementById('adl-opt-delete').classList.toggle('on',v==='delete');
}
function closeApiDelDialog(ok){
  document.getElementById('api-del-overlay').classList.remove('show');
  const r=_adlResolve;_adlTargetId=null;_adlResolve=null;
  if(r)r(!!ok);
}
async function confirmApiDelDialog(){
  const id=_adlTargetId;if(!id){closeApiDelDialog(false);return}
  let ok=false;
  if(_adlChoice==='archive')ok=await _archiveApiConfig(id);
  else ok=await _hardDeleteApiConfig(id);
  closeApiDelDialog(ok);
}
async function _archiveApiConfig(id){
  if(archivedConfigs.length>=20){toast('归档区已满，请先彻底删除部分归档 API 后重试');return false}
  const cfg=apiConfigs.find(a=>a.id===id);if(!cfg)return false;
  if(typeof _activePrepareCharacterBackgroundChange==='function'&&!(await _activePrepareCharacterBackgroundChange(id,'归档角色')))return false;
  try{await _detachCharacterFromGroups(id)}catch(e){console.error('Group reference cleanup failed',e);toast('归档失败：无法清理群聊成员引用');return false}
  cfg.archived=true;cfg.archivedAt=Date.now();cfg.apiKey='';/* 归档即清除密钥，其余设置全部保留 */
  await _persistApiConfig(cfg);
  await renderApiList();
  try{await loadFriendsList()}catch(e){}
  try{if(typeof _activeSyncAllBackground==='function'&&_activeCompanionOnline){_activeLastContextSync=0;await _activeSyncAllBackground()}}catch(e){console.warn('[Active Messages] archived API cleanup failed',e)}
  toast('已归档');
  return true;
}
async function _hardDeleteApiConfig(id){
  if(typeof _activePrepareCharacterBackgroundChange==='function'&&!(await _activePrepareCharacterBackgroundChange(id,'彻底删除角色')))return false;
  try{await _detachCharacterFromGroups(id)}catch(e){console.error('Group reference cleanup failed',e);toast('删除失败：无法清理群聊成员引用');return false}
  try{await dbDelete('apiConfigs',id)}catch(e){console.warn('IndexedDB API delete failed',e);toast('删除失败：角色配置未能从数据库移除');return false}
  _apiFallbackRemove(id);
  /* Clear related messages */
  const msgs=await dbGetByIndex('chatMessages','byFriend',id);
  for(const m of msgs){await dbDelete('chatMessages',m.id)}
  /* Clear related threads */
  try{const threads=await dbGetAll('chatThreads');for(const t of threads){if(t.friendId===id)await dbDelete('chatThreads',t.id)}}catch(e){}
  /* Clear related summaries */
  try{const sums=await dbGetAll('chatSummaries');for(const s of sums){if(s.friendId===id)await dbDelete('chatSummaries',s.id)}}catch(e){}
  /* Clear related auto memory entries */
  try{const ams=await dbGetByIndex('autoMemory','byFriend',id);for(const am of ams){await dbDelete('autoMemory',am.id)}}catch(e){}
  if(activeFriendId===id){activeFriendId=null;activeThreadId=null}
  await renderApiList();
  try{if(typeof _activeSyncAllBackground==='function'&&_activeCompanionOnline){_activeLastContextSync=0;await _activeSyncAllBackground()}}catch(e){console.warn('[Active Messages] deleted API cleanup failed',e)}
  toast('已删除');
  return true;
}

async function deleteCurrentApi(){
  if(!editingApiId){cancelApiEdit();return}
  const id=editingApiId;
  const ok=await deleteApiConfig(id);
  /* Close the editor only if the deletion was confirmed and it's still showing that API */
  if(ok&&editingApiId===id){editingApiId=null;document.getElementById('api-editor').style.display='none'}
}

/* ── API 页归档视图 ── */
var _apiArchView=false;
function _apiArchToggleUI(){
  const t=document.getElementById('api-mgmt-title');
  const b=document.getElementById('api-arch-toggle');
  const add=document.getElementById('api-add-actions');
  if(!t||!b)return;
  if(_apiArchView){
    t.innerHTML='已归档的API <span class="section-meta">（最多20个API）</span>';
    b.classList.add('arch-return');
    b.innerHTML=_ARCH_RETURN_SVG+'Return';
    b.title='返回API管理区';
    if(add)add.style.display='none';
  }else{
    t.innerHTML='角色库 <span class="section-meta">（数量不限）</span>';
    b.classList.remove('arch-return');
    b.innerHTML=_ARCH_CLOCK_SVG+'Archived';
    b.title='Archived：已归档的API档案区';
    if(add)add.style.display='';
  }
}
function toggleApiArchiveView(){
  _apiArchView=!_apiArchView;
  if(_apiArchView)cancelApiEdit();
  _apiArchToggleUI();
  if(_apiArchView)renderApiArchiveList();else renderApiList();
}
async function renderApiArchiveList(){
  const c=document.getElementById('api-list-container');
  if(!archivedConfigs.length){c.innerHTML='<div class="empty-state u-pad-20">归档区暂无API</div>';return}
  c.innerHTML=archivedConfigs.map(a=>{
    var avInit=(a.nickname||a.model||'?').charAt(0).toUpperCase();
    var avHtml=a.avatar?'<div class="api-item-avatar"><img src="'+a.avatar+'" alt=""></div>':'<div class="api-item-avatar">'+avInit+'</div>';
    return '<div class="chat-history-item api-arch-item" style="gap:12px" data-arch-id="'+a.id+'">'+avHtml
      +'<div style="flex:1;min-width:0"><strong class="api-item-name">'+esc(a.nickname||a.model||'未命名')+'</strong>'
      +(a.relationship?'<span style="font-size:0.7rem;color:var(--accent-light);opacity:0.7;margin-left:6px">'+esc(a.relationship)+'</span>':'')
      +'<div class="api-item-detail" style="font-size:0.72rem;margin-top:2px">'+esc(a.provider||'')+' · '+esc(a.model||'')+'</div></div>'
      +'<span class="arch-ops"><button class="arch-restore-btn" title="恢复到API管理区" onclick="openApiRestoreDialog(\''+a.id+'\')">'+_ARCH_RESTORE_SVG+'</button>'
      +'<span class="del-btn" title="彻底删除" onclick="archHardDeleteAsk(this,\''+a.id+'\')">✕</span></span></div>';
  }).join('');
}
function archHardDeleteAsk(el,id){
  const row=el.closest('.api-arch-item');if(!row||row.dataset.cf)return;
  row.dataset.cf='1';
  const cfg=archivedConfigs.find(a=>a.id===id);
  const keep=row.innerHTML;
  row.innerHTML='<span class="api-arch-confirm">彻底删除 '+esc(cfg?(cfg.nickname||cfg.model||'API'):'API')+'？清除所有数据：聊天记录、话题频道、对话摘要、Auto Memory。不可撤销。</span>'
    +'<span class="am-entry-ops" style="opacity:1;margin-left:auto"><button class="am-mini am-mini-danger" title="Confirm">\u2713</button><button class="am-mini" title="Cancel">\u21ba</button></span>';
  const bs=row.querySelectorAll('.am-mini');
  bs[0].onclick=async function(){await _hardDeleteApiConfig(id)};
  bs[1].onclick=function(){delete row.dataset.cf;row.innerHTML=keep};
}
var _apiRestoreId=null;
function openApiRestoreDialog(id){
  const cfg=archivedConfigs.find(a=>a.id===id);if(!cfg)return;
  _apiRestoreId=id;
  document.getElementById('api-restore-desc').textContent='将 '+(cfg.nickname||cfg.model||'API')+' 移回 API 管理区。归档时密钥已清除，恢复后需重新填写 API Key 才能继续对话。';
  document.getElementById('api-restore-overlay').classList.add('show');
}
function closeApiRestoreDialog(){document.getElementById('api-restore-overlay').classList.remove('show');_apiRestoreId=null}
async function confirmApiRestore(){
  const id=_apiRestoreId;if(!id){closeApiRestoreDialog();return}
  const cfg=archivedConfigs.find(a=>a.id===id);if(!cfg){closeApiRestoreDialog();return}
  const nn=(cfg.nickname||cfg.model||'').trim();/* 查重按最终显示名：昵称留空的旧数据回落到模型名 */
  if(nn&&apiConfigs.some(c=>String(c.nickname||c.model||'').trim()===nn)){toast('显示名「'+nn+'」已被管理区其他API使用，请先处理同名API后再恢复');closeApiRestoreDialog();return}
  delete cfg.archived;delete cfg.archivedAt;
  await _persistApiConfig(cfg);
  closeApiRestoreDialog();
  _apiArchView=false;_apiArchToggleUI();
  await renderApiList();
  editApi(id);
  const k=document.getElementById('api-key');if(k)k.focus();
  toast('已恢复，请填写 API Key');
}

async function loadApiSettingsUI(){_apiArchView=false;_apiArchToggleUI();renderApiList();updateChatCount();try{renderTokenDash()}catch(e){}loadReadingLimitsUI();loadVoiceTransUI();loadMemorySettingsUI();loadSummarySettingsUI();loadOutputSettings();updateDangerStorageInfo();
  /* Sync memory budget hint in the Memory page dashboard */
  getMemorySettings().then(function(s){var hint=document.getElementById('mem-deck-tok-hint');if(hint)hint.textContent='每次注入上限约 '+s.budget+' 字符'})
}

/* FRIENDS LIST */
async function loadFriendsList(){
  if(_chatArchMode)return renderArchFriendsList();
  await loadApiConfigs();
  const c=document.getElementById('friends-list');
  if(!apiConfigs.length){c.innerHTML='<div style="font-size:0.72rem;color:var(--text-muted);padding:8px">去 API 页面添加API</div>';return}
  const allThreads=await (async()=>{try{return await dbGetAll('chatThreads')}catch(e){return[]}})();
  let html='';
  for(const a of apiConfigs){
    const threads=allThreads.filter(t=>t.friendId===a.id).sort((x,y)=>x.created-y.created);
    const isActive=activeFriendId===a.id&&!activeThreadId;
    const isExpanded=activeFriendId===a.id;
    const badge=threads.length?'<span class="friend-thread-badge">('+threads.length+')</span>':'';
    html+='<div class="friend-item'+(isActive?' active':'')+'" onclick="selectFriend(\''+a.id+'\')">'
      +'<span class="friend-dot"></span><span>'+esc(a.nickname||a.model)+'</span>'
      +'<span class="friend-actions">'+badge
      +'<span class="friend-add-thread" onclick="event.stopPropagation();createThread(\''+a.id+'\')" title="新建话题频道">+</span>'
      +'</span></div>';
    if(threads.length){
      html+='<div class="friend-thread-list'+(isExpanded?' open':'')+'">';
      threads.forEach(t=>{
        const tActive=activeThreadId===t.id;
        html+='<div class="thread-item'+(tActive?' active':'')+'" onclick="selectThread(\''+a.id+'\',\''+t.id+'\')">'
          +'<span class="thread-dot"></span><span>'+esc(t.name)+'</span>'
          +'<span class="del-btn" onclick="event.stopPropagation();deleteThread(\''+t.id+'\')" title="删除">✕</span>'
          +'</div>';
      });
      html+='</div>';
    }
  }
  c.innerHTML=html;
  /* Load and render groups */
  const groups=await loadGroups();
  const gc=document.getElementById('groups-list');
  if(!groups.length){
    gc.innerHTML='<div style="font-size:0.75rem;padding:4px" class="chat-sidebar-muted">暂无群聊</div>';
  }else{
    gc.innerHTML=groups.map(g=>{
      normalizeGroupMembers(g);/* 自动迁移 */
      const memberNames=getGroupMemberIds(g).map(mid=>{const cfg=apiConfigs.find(a=>a.id===mid);return cfg?esc(cfg.nickname||cfg.model):'?'});
      const tags=memberNames.map(n=>'<span class="group-member-tag">'+n+'</span>').join('');
      return '<div class="friend-item'+(activeFriendId===g.id?' active':'')+'" onclick="selectGroup(\''+g.id+'\')"><span class="friend-dot" style="background:#72a8d8"></span><span>'+esc(g.name)+'</span><span class="del-btn" onclick="event.stopPropagation();deleteGroup(\''+g.id+'\')" title="删除群聊" style="margin-left:auto;font-size:0.7rem;cursor:pointer;opacity:0.5">✕</span></div>';
    }).join('');
  }
}

async function selectFriend(id){
  if(_chatSelectMode)exitChatSelectMode();
  activeFriendId=id;
  activeThreadId=null;/* 回到主对话 */
  _siteCtxLastHash='';/* 换人后首轮重新注入完整上下文 */
  _clearUnread(id);
  loadFriendsList();
  renderChatCalendar();
  /* Show memory generation button for 1v1 */
  const memBtn=document.getElementById('chat-gen-mem-btn');
  if(memBtn)memBtn.style.display='';
  const memSel=document.getElementById('chat-mem-member-select');
  if(memSel)memSel.style.display='none';
  const memMgrBtn=document.getElementById('chat-mem-mgr-btn');
  if(memMgrBtn)memMgrBtn.style.display='none';
  /* Load chat for this friend — exclude thread messages */
  const friendMsgs=(await dbGetByIndex('chatMessages','byFriend',id)).filter(m=>!m.threadId).sort((a,b)=>(a.timestamp||a.created)-(b.timestamp||b.created));
  const container=document.getElementById('chat-full-messages');
  if(!friendMsgs.length){
    const cfg=apiConfigs.find(a=>a.id===id);
    container.innerHTML='<div class="chat-msg system">与 '+esc(cfg?.nickname||'AI')+' 的对话</div>';
  }else{
    _renderAllChat(container,friendMsgs,true);
  }
  /* Update mini chat header too */
  const cfg=apiConfigs.find(a=>a.id===id);
  if(cfg){
    document.getElementById('chat-header-name').textContent=cfg.nickname||cfg.model;
    document.getElementById('chat-mini-title').textContent=cfg.nickname||cfg.model;
  }
  /* 打开聊天时自动检查/生成摘要 */
  setTimeout(()=>autoSummaryOnOpen(id,null),300);
}

function _roleSearchText(a){
  return [a&&a.nickname,a&&a.model,a&&a.provider,a&&a.relationship,a&&a.id].filter(Boolean).join(' ').toLocaleLowerCase();
}
function _roleMatchesSearch(a,query){
  const q=String(query==null?'':query).trim().toLocaleLowerCase();
  return !q||_roleSearchText(a).indexOf(q)!==-1;
}
function _renderGroupRolePicker(){
  const list=document.getElementById('group-api-list');
  if(!list)return;
  const available=apiConfigs.filter(a=>_roleMatchesSearch(a,_groupRoleSearch));
  list.innerHTML=available.length?available.map(a=>'<div class="group-api-item" data-id="'+a.id+'" onclick="_toggleGroupMember(this)"><input type="checkbox" tabindex="-1"><span>'+esc(a.nickname||a.model||'AI')+'</span><span class="group-order-badge" style="display:none;margin-left:auto;font-size:0.62rem;opacity:0.6;min-width:16px;text-align:center"></span></div>').join(''):'<div class="group-role-empty">没有匹配的角色</div>';
  document.querySelectorAll('#group-api-list .group-api-item').forEach(item=>{
    const selected=_groupSelectOrder.indexOf(item.dataset.id)>=0;
    item.classList.toggle('selected',selected);
    item.querySelector('input').checked=selected;
    const badge=item.querySelector('.group-order-badge');
    const idx=_groupSelectOrder.indexOf(item.dataset.id);
    if(badge){if(idx>=0){badge.textContent=idx+1;badge.style.display=''}else{badge.style.display='none'}}
  });
}
function filterGroupRolePicker(value){
  _groupRoleSearch=String(value||'');
  _renderGroupRolePicker();
}

function createGroup(){
  if(apiConfigs.length<2){toast('至少需要2个API才能创建群聊');return}
  _groupSelectOrder=[];
  _groupMentionOnly=new Set();
  _groupRoleSearch='';
  const search=document.getElementById('group-role-search');if(search)search.value='';
  _renderGroupRolePicker();
  document.getElementById('group-name-input').value='';
  document.getElementById('group-memory-toggle').checked=false;/* BUGFIX: 原先只重置思考链开关，记忆开关会残留上次的勾选 */
  document.getElementById('group-thinking-toggle').checked=false;
  _renderGroupMentionList();
  document.getElementById('group-dialog-overlay').classList.add('show');
}
var _groupSelectOrder=[];
var _groupMentionOnly=new Set();/* 静默模式：开启静默的成员 id 集合（仅被@时才发言） */
function _renderGroupMentionList(){
  const wrap=document.getElementById('group-mention-wrap');
  const list=document.getElementById('group-mention-list');
  if(!wrap||!list)return;
  const sel=_groupSelectOrder.filter(id=>apiConfigs.some(a=>a.id===id));
  if(sel.length===0){wrap.style.display='none';list.innerHTML='';return}
  wrap.style.display='';
  list.innerHTML=sel.map(id=>{
    const a=apiConfigs.find(x=>x.id===id);
    const on=_groupMentionOnly.has(id);
    return '<div class="group-api-item'+(on?' selected':'')+'" data-mid="'+id+'" onclick="_toggleGroupMentionOnly(this)"><input type="checkbox" tabindex="-1"'+(on?' checked':'')+'><span>@ '+esc(a?(a.nickname||a.model||'AI'):'AI')+'</span><span style="margin-left:auto;font-size:0.62rem;opacity:0.55">静默</span></div>';
  }).join('');
}
function _toggleGroupMentionOnly(el){
  const id=el.dataset.mid;
  if(!_groupMentionOnly.has(id)){
    /* 群里必须留一位不开静默的成员正常发言，最后一位不允许被静默 */
    const sel=_groupSelectOrder.filter(x=>apiConfigs.some(a=>a.id===x));
    const others=sel.filter(x=>x!==id&&!_groupMentionOnly.has(x));
    if(others.length===0){toast('至少留一位不开静默的成员');return}
    _groupMentionOnly.add(id);
  }else{
    _groupMentionOnly.delete(id);
  }
  el.classList.toggle('selected',_groupMentionOnly.has(id));
  el.querySelector('input').checked=_groupMentionOnly.has(id);
}
function _toggleGroupMember(el){
  const id=el.dataset.id;
  if(!el.classList.contains('selected')&&_groupSelectOrder.length>=MAX_GROUP_MEMBERS){toast('群聊最多添加'+MAX_GROUP_MEMBERS+'名成员');return}
  el.classList.toggle('selected');
  el.querySelector('input').checked=el.classList.contains('selected');
  if(el.classList.contains('selected')){
    _groupSelectOrder.push(id);
  }else{
    _groupSelectOrder=_groupSelectOrder.filter(x=>x!==id);
    _groupMentionOnly.delete(id);/* 取消成员时同步关掉TA的静默模式 */
  }
  /* Update order badges */
  document.querySelectorAll('#group-api-list .group-api-item').forEach(item=>{
    const badge=item.querySelector('.group-order-badge');
    const idx=_groupSelectOrder.indexOf(item.dataset.id);
    if(idx>=0){badge.textContent=idx+1;badge.style.display=''}else{badge.style.display='none'}
  });
  _renderGroupMentionList();
}

function closeGroupDialog(){document.getElementById('group-dialog-overlay').classList.remove('show')}

/* ===== 群成员管理 ===== */
async function openMemberManager(){
  if(!activeFriendId||!activeFriendId.startsWith('group_')){toast('请先打开一个群聊');return}
  const groups=await loadGroups();
  const group=groups.find(g=>g.id===activeFriendId);
  if(!group){toast('群聊不存在');return}
  normalizeGroupMembers(group);
  _memberPickerSearch='';
  const search=document.getElementById('member-mgr-search');if(search)search.value='';
  const ov=document.getElementById('member-mgr-overlay');
  ov.classList.add('show');
  document.getElementById('member-mgr-title').textContent='Members / '+esc(group.name);
  renderMemberMgrList(group);
  renderMemberPicker(group);
}

function closeMemberManager(){
  var ov=document.getElementById('member-mgr-overlay');
  ov.classList.remove('show');
}

/* overlay 点击空白区关闭 */
document.addEventListener('click',function(ev){
  if(ev.target.id==='member-mgr-overlay')closeMemberManager();
});

function renderMemberMgrList(group){
  const el=document.getElementById('member-mgr-list');
  if(!el)return;
  let html='';
  group.members.forEach(m=>{
    const cfg=apiConfigs.find(a=>a.id===m.characterId)||archivedConfigs.find(a=>a.id===m.characterId);
    const name=cfg?(cfg.nickname||cfg.model):m.characterId;
    const statusText={active:'🟢 active',muted:'🔇 muted',removed:'❌ left'}[m.status]||m.status;
    html+='<div class="member-mgr-item">';
    html+='<span class="member-mgr-name" title="'+esc(m.characterId)+'">'+esc(name)+'</span>';
    html+='<span class="member-mgr-status '+esc(m.status)+'">'+statusText+'</span>';
    html+='<span class="member-mgr-actions">';
    if(m.status==='active'){
      html+='<button onclick="memberAction(\''+group.id+'\',\''+m.characterId+'\',\'mute\')" aria-label="Mute '+esc(name)+'">Mute</button>';
      html+='<button class="danger" onclick="memberAction(\''+group.id+'\',\''+m.characterId+'\',\'remove\')" aria-label="Remove '+esc(name)+'">Remove</button>';
    }else if(m.status==='muted'){
      html+='<button onclick="memberAction(\''+group.id+'\',\''+m.characterId+'\',\'unmute\')" aria-label="Unmute '+esc(name)+'">Unmute</button>';
      html+='<button class="danger" onclick="memberAction(\''+group.id+'\',\''+m.characterId+'\',\'remove\')" aria-label="Remove '+esc(name)+'">Remove</button>';
    }
    html+='</span></div>';
  });
  el.innerHTML=html||'<div style="font-size:0.78rem;opacity:0.6;padding:8px">No members</div>';
}

function renderMemberPicker(group){
  const sel=document.getElementById('member-mgr-picker');
  if(!sel)return;
  const existingIds=group.members.filter(m=>m.status!=='removed').map(m=>m.characterId);
  const available=apiConfigs.filter(a=>existingIds.indexOf(a.id)<0&&_roleMatchesSearch(a,_memberPickerSearch));
  sel.innerHTML='';
  const activeCount=countGroupMembersByStatus(group,'active')+countGroupMembersByStatus(group,'muted');
  const atLimit=activeCount>=MAX_GROUP_MEMBERS;
  const addBtn=document.getElementById('member-mgr-add-btn');
  if(addBtn)addBtn.disabled=atLimit;
  if(atLimit){
    var lim=document.createElement('option');lim.value='';lim.textContent='(已达到群聊成员上限 '+MAX_GROUP_MEMBERS+' 人)';sel.appendChild(lim);return;
  }
  if(!available.length){
    var o=document.createElement('option');o.value='';o.textContent=_memberPickerSearch?'(没有匹配的角色)':'(没有可添加的角色)';sel.appendChild(o);
    return;
  }
  var o0=document.createElement('option');o0.value='';o0.textContent='Select a role...';sel.appendChild(o0);
  available.forEach(a=>{
    var o=document.createElement('option');
    o.value=a.id;
    o.textContent=(a.nickname||a.model)+' · '+(PROVIDERS[a.provider]?.name||a.provider||'');
    sel.appendChild(o);
  });
}
function filterMemberPicker(value){
  _memberPickerSearch=String(value||'');
  if(!activeFriendId||!activeFriendId.startsWith('group_'))return;
  loadGroups().then(function(groups){
    const group=groups.find(g=>g.id===activeFriendId);
    if(group){normalizeGroupMembers(group);renderMemberPicker(group)}
  });
}

async function addMemberFromPicker(){
  const sel=document.getElementById('member-mgr-picker');
  const characterId=sel&&sel.value;
  if(!characterId){toast('Please select a role');return}
  const btn=document.getElementById('member-mgr-add-btn');if(btn)btn.disabled=true;
  const r=await addGroupMember(activeFriendId,characterId);
  if(r.ok){
    toast(r.rejoined?('Rejoined: '+((apiConfigs.find(a=>a.id===characterId)||{}).nickname||characterId)):('Joined: '+((apiConfigs.find(a=>a.id===characterId)||{}).nickname||characterId)));
    const groups=await loadGroups();
    const group=groups.find(g=>g.id===activeFriendId);
    if(group){normalizeGroupMembers(group);renderMemberMgrList(group);renderMemberPicker(group)}
    if(currentPage==='chat'){selectGroup(activeFriendId)}
  }else{toast(r.error||'Add failed');if(btn)btn.disabled=false}
}

async function memberAction(gid,characterId,action){
  const cfg=apiConfigs.find(a=>a.id===characterId)||archivedConfigs.find(a=>a.id===characterId);
  const nm=cfg?(cfg.nickname||cfg.model):characterId;
  if(action==='mute'){
    if(!confirm('Mute '+nm+'? (Silent unless @mentioned)'))return;
    const r=await setGroupMemberStatus(gid,characterId,'muted');
    if(r.ok){
      toast('Muted: '+nm);
      await insertGroupSystemEvent(gid,'member_muted',characterId);
    }else toast(r.error||'Failed');
  }else if(action==='unmute'){
    const r=await setGroupMemberStatus(gid,characterId,'active');
    if(r.ok){
      toast('Unmuted: '+nm);
      await insertGroupSystemEvent(gid,'member_unmuted',characterId);
    }else toast(r.error||'Failed');
  }else if(action==='remove'){
    if(!confirm('Remove '+nm+'? (Data preserved, can rejoin later)'))return;
    const r=await removeGroupMember(gid,characterId);
    if(r.ok)toast('Removed: '+nm);
    else toast(r.error||'Remove failed');
  }
  const groups=await loadGroups();
  const group=groups.find(g=>g.id===gid);
  if(group){normalizeGroupMembers(group);renderMemberMgrList(group);renderMemberPicker(group)}
  if(currentPage==='chat'&&activeFriendId===gid){selectGroup(gid);loadFriendsList()}
}

async function confirmCreateGroup(){
  const name=document.getElementById('group-name-input').value.trim();
  if(!name){toast('请输入群聊名称');return}
  const selected=_groupSelectOrder.filter(id=>apiConfigs.some(a=>a.id===id));
  if(selected.length<2){toast('请至少选择2个API成员');return}
  if(selected.length>MAX_GROUP_MEMBERS){toast('群聊最多添加'+MAX_GROUP_MEMBERS+'名成员');return}
  /* 静默模式兜底校验：先勾静默、再取消掉唯一发言者的路径也会被这里拦下 */
  const silentIds=selected.filter(id=>_groupMentionOnly.has(id));
  if(silentIds.length>=selected.length){toast('至少留一位不开静默的成员');return}
  const group={id:'group_'+Date.now(),name:name,members:selected.map(id=>({characterId:id,status:silentIds.indexOf(id)>=0?'muted':'active',joinedAt:Date.now()})),memoryEnabled:!!document.getElementById('group-memory-toggle').checked,thinkingEnabled:!!document.getElementById('group-thinking-toggle').checked,created:Date.now()};
  await dbPut('groups',group);
  closeGroupDialog();
  loadFriendsList();
  toast('群聊 "'+name+'" 已创建');
}

async function loadGroups(){
  try{return await dbGetAll('groups')}catch(e){return[]}
}

/* ===== 群聊动态成员系统：数据迁移与工具函数 ===== */
/* 旧格式 group.members = ["friend_xxx", "friend_yyy"] (string[] 或无 status 字段)
   新格式 group.members = [{characterId:"friend_xxx", status:"active"|"muted"|"removed", joinedAt:ts}] */
function normalizeGroupMembers(group){
  if(!group)return;
  if(!Array.isArray(group.members)){group.members=[];return;}
  if(group.members.length===0)return;
  /* 检测是否已是新格式：第一项为对象且含 characterId */
  if(typeof group.members[0]==='object'&&group.members[0]!==null&&'characterId' in group.members[0]){
    /* 已是新格式，补齐缺失字段 */
    for(let i=0;i<group.members.length;i++){
      const m=group.members[i];
      if(typeof m!=='object'||!m){group.members[i]={characterId:String(m||''),status:'active',joinedAt:0};continue}
      if(!m.characterId)continue;
      if(!m.status||!['active','muted','removed'].includes(m.status))m.status='active';
      if(!m.joinedAt)m.joinedAt=group.created||0;
    }
    return;
  }
  /* 旧格式：string[] → 新格式对象数组 */
  const migrated=group.members.map(id=>({characterId:String(id),status:'active',joinedAt:group.created||Date.now()}));
  group.members=migrated;
  /* 静默成员也迁移：mentionOnly 中的 id 标记为 muted */
  if(Array.isArray(group.mentionOnly)&&group.mentionOnly.length){
    const silentSet=new Set(group.mentionOnly);
    group.members.forEach(m=>{if(silentSet.has(m.characterId))m.status='muted'});
    delete group.mentionOnly;/* 迁移后不再使用旧字段 */
  }
}

/* 从 group.members 获取所有有效 characterId */
function getGroupMemberIds(group){
  if(!group||!Array.isArray(group.members))return[];
  return group.members.map(m=>{
    if(typeof m==='object'&&m!==null)return m.characterId;
    return String(m);
  }).filter(Boolean);
}

/* 获取成员状态，兼容新旧格式 */
function getGroupMemberStatus(group,characterId){
  if(!group||!Array.isArray(group.members))return null;
  const m=group.members.find(x=>{
    if(typeof x==='object'&&x!==null)return x.characterId===characterId;
    return String(x)===characterId;
  });
  if(!m)return null;
  if(typeof m==='object'&&m!==null)return m.status||'active';
  /* 旧格式：检查 mentionOnly */
  const mo=new Set(group.mentionOnly||[]);
  return mo.has(characterId)?'muted':'active';
}

/* 获取指定状态的成员数 */
function countGroupMembersByStatus(group,status){
  if(!group||!Array.isArray(group.members))return 0;
  return group.members.filter(m=>{
    if(typeof m==='object'&&m!==null)return m.status===status;
    /* 旧格式：被移除/离职在旧格式用 not in members 表示，所以旧格式成员都是 active 或 muted */
    if(status==='active')return !(group.mentionOnly||[]).includes(String(m));
    if(status==='muted')return (group.mentionOnly||[]).includes(String(m));
    return false;
  }).length;
}

/* 修改成员状态并持久化 */
async function setGroupMemberStatus(gid,characterId,newStatus){
  const groups=await loadGroups();
  const group=groups.find(g=>g.id===gid);
  if(!group)return {ok:false,error:'群聊不存在'};
  normalizeGroupMembers(group);
  const member=group.members.find(m=>m.characterId===characterId);
  if(!member)return {ok:false,error:'该成员不在群聊中'};
  const oldStatus=member.status;
  if(oldStatus==='removed'&&newStatus!=='removed'&&countGroupMembersByStatus(group,'active')+countGroupMembersByStatus(group,'muted')>=MAX_GROUP_MEMBERS)return {ok:false,error:'群聊最多添加'+MAX_GROUP_MEMBERS+'名成员'};
  member.status=newStatus;
  await dbPut('groups',group);
  return {ok:true,oldStatus,newStatus,member};
}

/* 插入系统事件消息到群聊 */
async function insertGroupSystemEvent(gid,eventType,characterId,content){
  const cfg=apiConfigs.find(a=>a.id===characterId)||archivedConfigs.find(a=>a.id===characterId);
  const charName=cfg?(cfg.nickname||cfg.model):characterId;
  const sysMsg={
    id:'msg_sys_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),
    role:'system',
    content:content||(charName+{member_join:' joined the group',member_leave:' left the group',member_muted:' was muted',member_unmuted:' was unmuted'}[eventType]||''),
    friendId:gid,
    timestamp:Date.now(),
    metadata:{eventType,characterId}
  };
  await dbPut('chatMessages',sysMsg);
  return sysMsg;
}

/* 添加成员到群聊 */
async function addGroupMember(gid,characterId){
  const groups=await loadGroups();
  const group=groups.find(g=>g.id===gid);
  if(!group)return {ok:false,error:'群聊不存在'};
  normalizeGroupMembers(group);
  /* 防重复 */
  if(group.members.some(m=>m.characterId===characterId)){
    /* 若之前被移除，改为 active */
    const existing=group.members.find(m=>m.characterId===characterId);
    if(existing.status==='removed'){
      if(countGroupMembersByStatus(group,'active')+countGroupMembersByStatus(group,'muted')>=MAX_GROUP_MEMBERS)return {ok:false,error:'群聊最多添加'+MAX_GROUP_MEMBERS+'名成员'};
      existing.status='active';
      existing.joinedAt=Date.now();
      await dbPut('groups',group);
      const r=await insertGroupSystemEvent(gid,'member_join',characterId);
      return {ok:true,member:existing,sysMsg:r,rejoined:true};
    }
    return {ok:false,error:'该成员已在群聊中（状态：'+(existing.status||'active')+'）'};
  }
  if(countGroupMembersByStatus(group,'active')+countGroupMembersByStatus(group,'muted')>=MAX_GROUP_MEMBERS)return {ok:false,error:'群聊最多添加'+MAX_GROUP_MEMBERS+'名成员'};
  /* 验证角色存在 */
  const exists=apiConfigs.some(a=>a.id===characterId)||archivedConfigs.some(a=>a.id===characterId);
  if(!exists)return {ok:false,error:'角色不存在：'+characterId};
  const member={characterId,status:'active',joinedAt:Date.now()};
  group.members.push(member);
  await dbPut('groups',group);
  const r=await insertGroupSystemEvent(gid,'member_join',characterId);
  return {ok:true,member,sysMsg:r};
}

/* 从群聊移除成员（保留数据） */
async function removeGroupMember(gid,characterId){
  const groups=await loadGroups();
  const group=groups.find(g=>g.id===gid);
  if(!group)return {ok:false,error:'群聊不存在'};
  normalizeGroupMembers(group);
  const idx=group.members.findIndex(m=>m.characterId===characterId);
  if(idx<0)return {ok:false,error:'该成员不在群聊中'};
  const member=group.members[idx];
  member.status='removed';
  await dbPut('groups',group);
  const r=await insertGroupSystemEvent(gid,'member_leave',characterId);
  return {ok:true,member,sysMsg:r};
}

/* 静默模式：群内「隐性」API调用（自动摘要、选择生成记忆的默认执笔者等）
   优先避开开启静默的成员——不该在用户没点名时替TA花Token。
   全员皆静默时按 fallbackCfgs（如本轮实际发言者）> 首位成员 兜底 */
function pickGroupUtilityCfg(group,fallbackCfgs){
  const ids=getGroupMemberIds(group);
  if(!ids.length)return (fallbackCfgs&&fallbackCfgs[0])||null;
  const cfgs=ids.map(id=>apiConfigs.find(a=>a.id===id)).filter(Boolean);
  const ready=cfgs.filter(_ibApiReady);
  const readyFallback=(fallbackCfgs||[]).find(_ibApiReady);
  return ready.find(c=>getGroupMemberStatus(group,c.id)==='active')||readyFallback||ready[0]||null;
}

async function selectGroup(gid){
  if(_chatSelectMode)exitChatSelectMode();
  activeFriendId=gid;
  activeThreadId=null;
  _clearUnread(gid);
  loadFriendsList();
  renderChatCalendar();
  /* Show memory generation button in group chat with member selector */
  const memBtn=document.getElementById('chat-gen-mem-btn');
  if(memBtn)memBtn.style.display='';
  const memMgrBtn=document.getElementById('chat-mem-mgr-btn');
  if(memMgrBtn)memMgrBtn.style.display='';
  const groups=await loadGroups();
  const group=groups.find(g=>g.id===gid);
  normalizeGroupMembers(group);/* 自动迁移旧格式数据 */
  const memSel=document.getElementById('chat-mem-member-select');
  if(memSel){
    if(group&&group.members&&group.members.length){
      memSel.innerHTML=group.members.filter(m=>m.status!=='removed').map(m=>{const c=apiConfigs.find(a=>a.id===m.characterId);if(c)return '<option value="'+m.characterId+'">'+esc(c.nickname||c.model)+'</option>';if(archivedConfigs.find(a=>a.id===m.characterId))return '';return '<option value="'+m.characterId+'">AI</option>'}).join('');
      memSel.style.display='';
    }else{memSel.style.display='none'}
  }
  if(!group)return;
  const gMsgs=(await dbGetByIndex('chatMessages','byFriend',gid)).sort((a,b)=>(a.timestamp||a.created)-(b.timestamp||b.created));
  const container=document.getElementById('chat-full-messages');
  if(!gMsgs.length){
    const memberNames=group.members.filter(m=>m.status!=='removed').map(m=>{const c=apiConfigs.find(a=>a.id===m.characterId);if(c){const nm=esc(c.nickname||c.model);return m.status==='muted'?nm+'（静默）':nm}const ac=archivedConfigs.find(a=>a.id===m.characterId);if(ac)return '<span style="opacity:0.5">'+esc(ac.nickname||ac.model)+'（已归档）</span>';return '?'}).join('、');
    container.innerHTML='<div class="chat-msg system">群聊 "'+esc(group.name)+'"<br><span style="font-size:0.68rem">成员：'+memberNames+'</span></div>';
  }else{
    _renderAllChat(container,gMsgs,true);
  }
  document.getElementById('chat-header-name').textContent=group.name;
  document.getElementById('chat-mini-title').textContent=group.name;
  /* 打开群聊时自动检查/生成摘要 */
  setTimeout(()=>autoSummaryOnOpen(gid,null),300);
}

async function deleteGroup(gid){
  if(!confirm('确定删除该群聊及其消息？'))return;
  await dbDelete('groups',gid);
  const msgs=await dbGetByIndex('chatMessages','byFriend',gid);
  for(const m of msgs){await dbDelete('chatMessages',m.id)}
  /* 清理群聊摘要 */
  try{const sums=await dbGetAll('chatSummaries');for(const s of sums){if(s.friendId===gid)await dbDelete('chatSummaries',s.id)}}catch(e){}
  if(activeFriendId===gid)activeFriendId=null;
  loadFriendsList();
  document.getElementById('chat-full-messages').innerHTML='<div class="chat-msg system">选择一个API开始对话</div>';
  toast('群聊已删除');
}

/* ===== CHAT THREADS (话题频道) ===== */
async function loadThreads(friendId){
  try{const all=await dbGetAll('chatThreads');return all.filter(t=>t.friendId===friendId).sort((a,b)=>a.created-b.created)}catch(e){return[]}
}
var _threadCreatingFor=null;
function createThread(friendId){
  _threadCreatingFor=friendId;
  document.getElementById('thread-name-input').value='';
  document.getElementById('thread-memory-toggle').checked=false;
  document.getElementById('thread-dialog-overlay').classList.add('show');
}
function closeThreadDialog(){document.getElementById('thread-dialog-overlay').classList.remove('show');_threadCreatingFor=null}
async function confirmCreateThread(){
  const name=document.getElementById('thread-name-input').value.trim();
  if(!name){toast('请输入频道名称');return}
  if(!_threadCreatingFor)return;
  const thread={id:'thread_'+Date.now(),friendId:_threadCreatingFor,name:name,
    memoryEnabled:!!document.getElementById('thread-memory-toggle').checked,created:Date.now()};
  await dbPut('chatThreads',thread);
  closeThreadDialog();
  loadFriendsList();
  toast('话题频道「'+name+'」已创建');
}
async function deleteThread(tid){
  if(!confirm('确定删除该话题频道及其消息？'))return;
  await dbDelete('chatThreads',tid);
  const msgs=await dbGetAll('chatMessages');
  for(const m of msgs){if(m.threadId===tid)await dbDelete('chatMessages',m.id)}
  /* 清理话题摘要 */
  try{await dbDelete('chatSummaries','sum_'+tid)}catch(e){}
  if(activeThreadId===tid){activeThreadId=null;if(activeFriendId)selectFriend(activeFriendId)}
  loadFriendsList();toast('话题频道已删除');
}
async function selectThread(friendId,threadId){
  if(_chatSelectMode)exitChatSelectMode();
  activeFriendId=friendId;
  activeThreadId=threadId;
  _clearUnread(friendId);
  loadFriendsList();
  renderChatCalendar();
  const memBtn=document.getElementById('chat-gen-mem-btn');
  if(memBtn)memBtn.style.display='';
  const memSel=document.getElementById('chat-mem-member-select');
  if(memSel)memSel.style.display='none';
  const allMsgs=(await dbGetByIndex('chatMessages','byFriend',friendId)).filter(m=>m.threadId===threadId);
  allMsgs.sort((a,b)=>(a.timestamp||a.created)-(b.timestamp||b.created));
  const container=document.getElementById('chat-full-messages');
  const threads=await loadThreads(friendId);
  const thread=threads.find(t=>t.id===threadId);
  const threadName=thread?thread.name:'话题';
  const cfg=apiConfigs.find(a=>a.id===friendId);
  if(!allMsgs.length){
    container.innerHTML='<div class="chat-msg system">'+esc(threadName)+'</div>';
  }else{
    _renderAllChat(container,allMsgs,true);
  }
  if(cfg){
    document.getElementById('chat-header-name').textContent=(cfg.nickname||cfg.model)+' · '+threadName;
    document.getElementById('chat-mini-title').textContent=(cfg.nickname||cfg.model)+' · '+threadName;
  }
  /* 打开话题频道时自动检查/生成摘要 */
  setTimeout(()=>autoSummaryOnOpen(friendId,threadId),300);
}

function searchChat(q){
  if(!q){
    if(_chatArchMode){
      if(activeThreadId&&activeFriendId)selectArchThread(activeFriendId,activeThreadId);
      else if(activeFriendId)selectArchFriend(activeFriendId);
      return;
    }
    if(activeThreadId&&activeFriendId)selectThread(activeFriendId,activeThreadId);
    else if(activeFriendId)selectFriend(activeFriendId);
    return;
  }
  if(!activeFriendId){toast('请先选择一个聊天对象');return}
  dbGetByIndex('chatMessages','byFriend',activeFriendId).then(msgs=>{
    /* Filter by current thread */
    const filtered=activeThreadId?msgs.filter(m=>m.threadId===activeThreadId):msgs.filter(m=>!m.threadId);
    const results=filtered.filter(m=>m.content&&m.content.toLowerCase().includes(q.toLowerCase())).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
    const container=document.getElementById('chat-full-messages');
    if(!results.length){container.innerHTML='<div class="chat-msg system">未找到相关消息</div>';return}
    _renderAllChat(container,results.slice(0,50),true);
  });
}

/* ═══ Chat 归档模式：只读浏览已归档好友的聊天记录（进入/退出仅切换本页视图，不影响迷你面板与在线对话） ═══ */
var _chatArchMode=false,_chatArchPrevTitles=null;
function toggleChatArchive(){if(_chatArchMode)exitChatArchive();else enterChatArchive()}
function enterChatArchive(){
  if(_chatArchMode)return;
  if(_chatSelectMode)exitChatSelectMode();
  _chatArchMode=true;
  activeFriendId=null;activeThreadId=null;
  /* 标题块 */
  const t=document.getElementById('chat-intro-title');if(t)t.textContent='Archived';
  const s=document.getElementById('chat-intro-sub');if(s)s.textContent='Preserved conversations';
  const d=document.getElementById('chat-intro-desc');if(d)d.innerHTML='已离线好友的历史对话存档。可搜索与按日期浏览，所有记录为只读状态。<br>归档好友可随时前往 API Settings 恢复至API管理区。记忆库中的关联记忆不受归档影响。';
  const b=document.getElementById('chat-arch-toggle');
  if(b){b.classList.add('arch-return');b.classList.remove('arch-clock');b.innerHTML=_ARCH_RETURN_SVG+'Return';b.title='返回Chat'}
  /* 侧栏 */
  const h=document.getElementById('chat-friends-title');if(h)h.textContent='离线好友';
  const g=document.getElementById('chat-groups-section');if(g)g.style.display='none';
  /* 工具按钮置为禁用态（保留 title 提示） */
  const selBtn=document.getElementById('chat-select-toggle');
  const memBtn=document.getElementById('chat-gen-mem-btn');
  _chatArchPrevTitles={sel:selBtn?selBtn.title:'',mem:memBtn?memBtn.title:''};
  if(selBtn){selBtn.classList.add('chat-tool-disabled');selBtn.title='归档对话不支持选择操作'}
  if(memBtn){memBtn.classList.add('chat-tool-disabled');memBtn.title='归档对话不支持生成记忆';memBtn.style.display=''}
  const memSel=document.getElementById('chat-mem-member-select');if(memSel)memSel.style.display='none';
  /* 消息区只读、输入区替换为静态提示 */
  const full=document.getElementById('chat-full-messages');
  if(full){full.classList.add('chat-arch-ro');full.innerHTML='<div class="chat-msg system">选择一位离线好友查看对话</div>'}
  const ia=full?full.parentElement.querySelector('.chat-input-area'):null;if(ia)ia.style.display='none';
  const notice=document.getElementById('chat-arch-notice');if(notice)notice.style.display='';
  const si=document.getElementById('chat-search-input');if(si)si.value='';
  renderArchFriendsList();
  renderChatCalendar();
}
function exitChatArchive(quiet){
  if(!_chatArchMode)return;
  _chatArchMode=false;
  activeFriendId=null;activeThreadId=null;
  const t=document.getElementById('chat-intro-title');if(t)t.textContent='Chat';
  const s=document.getElementById('chat-intro-sub');if(s)s.textContent='Real-time AI dialogue';
  const d=document.getElementById('chat-intro-desc');if(d)d.innerHTML='支持多个 API 端口的实时对话站。可在浮动面板与全屏模式之间自由切换。<br>好友列表由 API 配置自动生成。支持群聊、开启话题频道、处理附件与生成记忆。';
  const b=document.getElementById('chat-arch-toggle');
  if(b){b.classList.remove('arch-return');b.classList.add('arch-clock');b.innerHTML=_ARCH_CLOCK_SVG;b.title='Archived（离线好友的聊天记录）'}
  const h=document.getElementById('chat-friends-title');if(h)h.textContent='好友列表';
  const g=document.getElementById('chat-groups-section');if(g)g.style.display='';
  const selBtn=document.getElementById('chat-select-toggle');
  const memBtn=document.getElementById('chat-gen-mem-btn');
  if(selBtn){selBtn.classList.remove('chat-tool-disabled');selBtn.title=(_chatArchPrevTitles&&_chatArchPrevTitles.sel)||''}
  if(memBtn){memBtn.classList.remove('chat-tool-disabled');memBtn.title=(_chatArchPrevTitles&&_chatArchPrevTitles.mem)||''}
  _chatArchPrevTitles=null;
  const full=document.getElementById('chat-full-messages');
  if(full){full.classList.remove('chat-arch-ro');full.innerHTML='<div class="chat-msg system">选择一个API开始对话</div>'}
  const ia=full?full.parentElement.querySelector('.chat-input-area'):null;if(ia)ia.style.display='';
  const notice=document.getElementById('chat-arch-notice');if(notice)notice.style.display='none';
  const si=document.getElementById('chat-search-input');if(si)si.value='';
  if(!quiet){loadFriendsList();renderChatCalendar()}
}
async function renderArchFriendsList(){
  await loadApiConfigs();
  const c=document.getElementById('friends-list');if(!c)return;
  if(!archivedConfigs.length){c.innerHTML='<div style="font-size:0.72rem;color:var(--text-muted);padding:8px">暂无离线好友</div>';return}
  const allThreads=await (async()=>{try{return await dbGetAll('chatThreads')}catch(e){return[]}})();
  let html='';
  for(const a of archivedConfigs){
    const threads=allThreads.filter(t=>t.friendId===a.id).sort((x,y)=>x.created-y.created);
    const isActive=activeFriendId===a.id&&!activeThreadId;
    const isExpanded=activeFriendId===a.id;
    const badge=threads.length?'<span class="friend-thread-badge">('+threads.length+')</span>':'';
    html+='<div class="friend-item arch-item'+(isActive?' active':'')+'" onclick="selectArchFriend(\''+a.id+'\')">'
      +'<span class="friend-dot"></span><span>'+esc(a.nickname||a.model)+'</span>'
      +'<span class="friend-actions">'+badge
      +'<span class="friend-add-thread arch-lock" onclick="event.stopPropagation()" title="归档好友的话题频道为只读状态">+</span>'
      +'</span></div>';
    if(threads.length){
      html+='<div class="friend-thread-list'+(isExpanded?' open':'')+'">';
      threads.forEach(t=>{
        const tActive=activeThreadId===t.id;
        html+='<div class="thread-item'+(tActive?' active':'')+'" onclick="selectArchThread(\''+a.id+'\',\''+t.id+'\')">'
          +'<span class="thread-dot"></span><span>'+esc(t.name)+'</span>'
          +'</div>';
      });
      html+='</div>';
    }
  }
  c.innerHTML=html;
}
async function selectArchFriend(id){
  activeFriendId=id;
  activeThreadId=null;
  renderArchFriendsList();
  renderChatCalendar();
  const friendMsgs=(await dbGetByIndex('chatMessages','byFriend',id)).filter(m=>!m.threadId).sort((a,b)=>(a.timestamp||a.created)-(b.timestamp||b.created));
  const container=document.getElementById('chat-full-messages');
  container.classList.add('chat-arch-ro');
  const cfg=archivedConfigs.find(a=>a.id===id);
  if(!friendMsgs.length){
    container.innerHTML='<div class="chat-msg system">与 '+esc(cfg?(cfg.nickname||cfg.model):'AI')+' 的对话</div>';
  }else{
    _renderAllChat(container,friendMsgs,true);
  }
}
async function selectArchThread(friendId,threadId){
  activeFriendId=friendId;
  activeThreadId=threadId;
  renderArchFriendsList();
  renderChatCalendar();
  const allMsgs=(await dbGetByIndex('chatMessages','byFriend',friendId)).filter(m=>m.threadId===threadId).sort((a,b)=>(a.timestamp||a.created)-(b.timestamp||b.created));
  const container=document.getElementById('chat-full-messages');
  container.classList.add('chat-arch-ro');
  const threads=await loadThreads(friendId);
  const thread=threads.find(t=>t.id===threadId);
  if(!allMsgs.length){
    container.innerHTML='<div class="chat-msg system">'+esc(thread?thread.name:'话题')+'</div>';
  }else{
    _renderAllChat(container,allMsgs,true);
  }
}

/* ===== CHAT CALENDAR ===== */
var _calYear=new Date().getFullYear(),_calMonth=new Date().getMonth(),_calChatDays={},_calEarliest=null;
const _CAL_MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
async function _getCalRange(){try{const all=await dbGetAll('chatMessages');if(!all.length)return null;let min=Infinity;all.forEach(m=>{if(m.timestamp&&m.timestamp<min)min=m.timestamp});return min<Infinity?new Date(min):null}catch(e){return null}}
async function buildCalData(year,month){
  const start=new Date(year,month,1).getTime(),end=new Date(year,month+1,0,23,59,59,999).getTime();
  try{const all=await dbGetAll('chatMessages');const groups=await loadGroups();const dm={};
  const archSet=new Set((archivedConfigs||[]).map(x=>x.id));/* 归档模式仅统计归档好友；常规模式排除归档好友 */
  all.forEach(m=>{if(!m.timestamp||m.timestamp<start||m.timestamp>end)return;const fid=m.friendId||'?';if(_chatArchMode){if(!archSet.has(fid))return}else{if(archSet.has(fid))return}const d=new Date(m.timestamp);const dk=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');if(!dm[dk])dm[dk]={};if(!dm[dk][fid])dm[dk][fid]={c:0,n:''};dm[dk][fid].c++;if(!dm[dk][fid].n){if(fid.startsWith('group_')){const g=groups.find(gr=>gr.id===fid);dm[dk][fid].n='👥'+(g?g.name:fid)}else{const cfg=apiConfigs.find(a=>a.id===fid)||archivedConfigs.find(a=>a.id===fid);dm[dk][fid].n=cfg?(cfg.nickname||cfg.model):'?'}}});
  const r={};for(const[dk,f]of Object.entries(dm))r[dk]=Object.entries(f).map(([fid,i])=>({fid,n:i.n,c:i.c}));_calChatDays=r}catch(e){_calChatDays={}}
}
async function renderChatCalendar(){
  const el=document.getElementById('chat-calendar');if(!el)return;
  if(!_calEarliest)_calEarliest=await _getCalRange();
  const now=new Date(),ea=_calEarliest;
  if(ea){const eY=ea.getFullYear(),eM=ea.getMonth();if(_calYear<eY||(_calYear===eY&&_calMonth<eM)){_calYear=eY;_calMonth=eM}}
  if(_calYear>now.getFullYear()||(_calYear===now.getFullYear()&&_calMonth>now.getMonth())){_calYear=now.getFullYear();_calMonth=now.getMonth()}
  await buildCalData(_calYear,_calMonth);
  const fd=new Date(_calYear,_calMonth,1),ld=new Date(_calYear,_calMonth+1,0);
  const sw=fd.getDay(),dim=ld.getDate(),pl=new Date(_calYear,_calMonth,0).getDate();
  const canP=ea?(_calYear>ea.getFullYear()||(_calYear===ea.getFullYear()&&_calMonth>ea.getMonth())):true;
  const canN=_calYear<now.getFullYear()||(_calYear===now.getFullYear()&&_calMonth<now.getMonth());
  let h='<div class="chat-cal-header"><button class="chat-cal-nav" onclick="calNav(-1)"'+(canP?'':' disabled')+'>◂</button>'
    +'<span class="chat-cal-title" onclick="toggleCalJump(event)">'+_calYear+' '+_CAL_MONTHS[_calMonth]+'</span>'
    +'<button class="chat-cal-nav" onclick="calNav(1)"'+(canN?'':' disabled')+'>▸</button></div>';
  h+='<div class="chat-cal-grid">';
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d=>{h+='<div class="chat-cal-dow">'+d+'</div>'});
  for(let i=sw-1;i>=0;i--)h+='<div class="chat-cal-day other-month">'+(pl-i)+'</div>';
  for(let d=1;d<=dim;d++){
    const dk=_calYear+'-'+String(_calMonth+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const isT=(_calYear===now.getFullYear()&&_calMonth===now.getMonth()&&d===now.getDate());
    const ci=_calChatDays[dk],hc=!!ci&&ci.length>0;
    let cls='chat-cal-day';if(isT)cls+=' today';if(hc)cls+=' has-chat';
    let tip='';if(hc)tip=' data-tip="'+esc(d+'日 · '+ci.map(c=>c.n+'('+c.c+')').join(', '))+'"';
    h+='<div class="'+cls+'"'+(hc?' onclick="calJump(\''+dk+'\',this)"':'')+tip+' style="position:relative">'+d+'</div>';
  }
  const tc=sw+dim,rm=tc%7;if(rm>0)for(let i=1;i<=7-rm;i++)h+='<div class="chat-cal-day other-month">'+i+'</div>';
  h+='</div>';el.innerHTML=h;
}
function calNav(dir){_calMonth+=dir;if(_calMonth<0){_calMonth=11;_calYear--}if(_calMonth>11){_calMonth=0;_calYear++}renderChatCalendar()}

/* Global floating calendar tooltip — avoids sidebar overflow:hidden clipping */
(function(){
  var tip=document.createElement('div');tip.className='chat-cal-tip';document.body.appendChild(tip);
  var hideTimer=null;
  document.addEventListener('mouseenter',function(e){
    var cell=e.target.closest&&e.target.closest('.chat-cal-day[data-tip]');
    if(!cell)return;
    clearTimeout(hideTimer);
    tip.textContent=cell.getAttribute('data-tip');
    var r=cell.getBoundingClientRect();
    tip.style.opacity='1';
    /* Position above the cell, clamped to viewport */
    var tipW=tip.offsetWidth||140,tipH=tip.offsetHeight||28;
    var left=r.left+r.width/2-tipW/2;
    if(left<6)left=6;if(left+tipW>window.innerWidth-6)left=window.innerWidth-6-tipW;
    var top=r.top-tipH-6;if(top<6)top=r.bottom+6;
    tip.style.left=left+'px';tip.style.top=top+'px';
  },true);
  document.addEventListener('mouseleave',function(e){
    var cell=e.target.closest&&e.target.closest('.chat-cal-day[data-tip]');
    if(!cell)return;
    hideTimer=setTimeout(function(){tip.style.opacity='0'},80);
  },true);
})();
function toggleCalJump(ev){
  ev.stopPropagation();const hdr=ev.target.closest('.chat-cal-header');
  let p=hdr.querySelector('.chat-cal-jump');if(p){p.remove();return}
  const now=new Date(),eY=_calEarliest?_calEarliest.getFullYear():now.getFullYear(),eM=_calEarliest?_calEarliest.getMonth():0;
  p=document.createElement('div');p.className='chat-cal-jump';
  let yo='';for(let y=eY;y<=now.getFullYear();y++)yo+='<option value="'+y+'"'+(_calYear===y?' selected':'')+'>'+y+'</option>';
  let mo='';for(let m=0;m<12;m++){const dis=(_calYear===eY&&m<eM)||(_calYear===now.getFullYear()&&m>now.getMonth());mo+='<option value="'+m+'"'+(_calMonth===m?' selected':'')+(dis?' disabled':'')+'>'+_CAL_MONTHS[m]+'</option>'}
  p.innerHTML='<select onchange="event.stopPropagation();calJYU(+this.value,this)">'+yo+'</select><select onchange="event.stopPropagation();calJM(+this.value)">'+mo+'</select>';
  hdr.appendChild(p);
  setTimeout(()=>{document.addEventListener('click',function _c(ev){if(ev.target.closest&&ev.target.closest('.chat-cal-jump'))return;document.removeEventListener('click',_c,true);const q=hdr.querySelector('.chat-cal-jump');if(q)q.remove()},true)},50);
}
function calJYU(y,sel){
  _calYear=y;
  /* Update month select options for new year's valid range */
  var jmp=sel.closest('.chat-cal-jump');if(!jmp)return renderChatCalendar();
  var ms=jmp.querySelectorAll('select')[1];if(!ms)return renderChatCalendar();
  var now=new Date(),eY=_calEarliest?_calEarliest.getFullYear():now.getFullYear(),eM=_calEarliest?_calEarliest.getMonth():0;
  for(var i=0;i<ms.options.length;i++){var dis=(y===eY&&i<eM)||(y===now.getFullYear()&&i>now.getMonth());ms.options[i].disabled=dis}
  if(ms.options[_calMonth]&&ms.options[_calMonth].disabled){for(var i=0;i<12;i++){if(!ms.options[i].disabled){_calMonth=i;ms.value=i;break}}}
}
function calJY(y){_calYear=y;renderChatCalendar()}
function calJM(m){_calMonth=m;renderChatCalendar()}
async function calJump(dk,dayEl){
  if(!activeFriendId)return;
  document.querySelectorAll('.chat-cal-day.selected').forEach(e=>e.classList.remove('selected'));
  if(dayEl)dayEl.classList.add('selected');
  const p=dk.split('-'),ds=new Date(+p[0],+p[1]-1,+p[2]).getTime(),de=ds+86399999;
  const msgs=(await dbGetByIndex('chatMessages','byFriend',activeFriendId)).filter(m=>m.timestamp>=ds&&m.timestamp<=de).sort((a,b)=>a.timestamp-b.timestamp);
  const ct=document.getElementById('chat-full-messages');ct.innerHTML='';
  const lb=document.createElement('div');lb.className='chat-msg system';lb.textContent=dk+' ('+msgs.length+'条)';ct.appendChild(lb);
  msgs.forEach(function(m,i){var prev=i>0?msgs[i-1]:null;var isCont=prev&&prev.role===m.role&&(m.role==='user'||((prev.friendId||'_')===(m.friendId||'_')&&(!m.senderName||(prev.senderName||'_')===(m.senderName||'_'))));ct.appendChild(_buildMsgEl(m,true,isCont))});ct.scrollTop=0;
  const bb=document.createElement('button');bb.className='chat-load-more';bb.textContent='← 返回完整对话';bb.style.cssText='margin-top:12px;cursor:pointer';
  bb.onclick=function(){document.querySelectorAll('.chat-cal-day.selected').forEach(e=>e.classList.remove('selected'));if(_chatArchMode){if(activeThreadId)selectArchThread(activeFriendId,activeThreadId);else selectArchFriend(activeFriendId)}else if(activeFriendId.startsWith('group_'))selectGroup(activeFriendId);else selectFriend(activeFriendId)};
  ct.appendChild(bb);
}

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.social 登记全部导出 ---- */
function ibSocialLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._ibIsLoopbackEndpoint=_ibIsLoopbackEndpoint;
window._ibApiHasCredential=_ibApiHasCredential;
window._ibApiReady=_ibApiReady;
window._modelThinkingDefault=_modelThinkingDefault;
window._resolveShowThinking=_resolveShowThinking;
window._syncShowThinkingDefault=_syncShowThinkingDefault;
window.DEEPSEEK_NATIVE_VISION_MODEL=DEEPSEEK_NATIVE_VISION_MODEL;
window._isDeepSeekNativeVisionModel=_isDeepSeekNativeVisionModel;
window._syncVisionUI=_syncVisionUI;
window._voiceRateUpdate=_voiceRateUpdate;
window._voiceToggleDetail=_voiceToggleDetail;
window._voiceTypeChange=_voiceTypeChange;
window._voiceCurrentType=_voiceCurrentType;
window._voiceCloneUploadFile=_voiceCloneUploadFile;
window._voiceCloneDeleteCurrent=_voiceCloneDeleteCurrent;
window._voiceCloneSelectionGet=function(){return _voiceCloneSelection?Object.assign({},_voiceCloneSelection):null;};
window._ibReferencedRefAudioIds=_ibReferencedRefAudioIds;
window.testCharacterVoice=testCharacterVoice;
window.onProviderChange=onProviderChange;
window._apiFallbackRead=_apiFallbackRead;
window._apiFallbackWrite=_apiFallbackWrite;
window._apiFallbackRemove=_apiFallbackRemove;
window._apiFallbackPut=_apiFallbackPut;
window._ibStorageCaps=_ibStorageCaps;
window._apiSaveNotice=_apiSaveNotice;
window._persistApiConfig=_persistApiConfig;
window.loadApiConfigs=loadApiConfigs;
window.renderApiList=renderApiList;
window._apiDragStart=_apiDragStart;
window._apiDragOver=_apiDragOver;
window._apiDragEnd=_apiDragEnd;
window._apiDrop=_apiDrop;
window.handleApiAvatarUpload=handleApiAvatarUpload;
window.removeApiAvatar=removeApiAvatar;
window._renderApiAvatarPreview=_renderApiAvatarPreview;
window._apiAvatarLoadError=_apiAvatarLoadError;
window.handleApiBannerUpload=handleApiBannerUpload;
window.removeApiBanner=removeApiBanner;
window._renderApiBannerPreview=_renderApiBannerPreview;
window._normApiHandle=_normApiHandle;
window.addNewApi=addNewApi;
window.MAX_GROUP_MEMBERS=MAX_GROUP_MEMBERS;
window._tkLoad=_tkLoad;
window._tkSave=_tkSave;
window._tkRecord=_tkRecord;
window._tkFmt=_tkFmt;
window._tkEsc=_tkEsc;
window._tkCost=_tkCost;
window._tkPrice=_tkPrice;
window._tkDay0=_tkDay0;
window._tkAddD=_tkAddD;
window._tkRangeT0=_tkRangeT0;
window._tkRangeT1x=_tkRangeT1x;
window._tkFmtD=_tkFmtD;
window._tkRangeLabel=_tkRangeLabel;
window._tkRangeTextSync=_tkRangeTextSync;
window._tkCalToggle=_tkCalToggle;
window._tkCalPlace=_tkCalPlace;
window._tkCalClose=_tkCalClose;
window._tkCalDoc=_tkCalDoc;
window._tkCalKey=_tkCalKey;
window._tkCalNav=_tkCalNav;
window._tkCalPickDay=_tkCalPickDay;
window._tkCalRender=_tkCalRender;
window._tkClearRange=_tkClearRange;
window._tkWipeAll=_tkWipeAll;
window.renderTokenDash=renderTokenDash;
window.editApi=editApi;
window.saveCurrentApi=saveCurrentApi;
window.cancelApiEdit=cancelApiEdit;
window.deleteApiConfig=deleteApiConfig;
window._adlPick=_adlPick;
window.closeApiDelDialog=closeApiDelDialog;
window.confirmApiDelDialog=confirmApiDelDialog;
window._archiveApiConfig=_archiveApiConfig;
window._hardDeleteApiConfig=_hardDeleteApiConfig;
window._findGroupsReferencingCharacter=_findGroupsReferencingCharacter;
window._detachCharacterFromGroups=_detachCharacterFromGroups;
window.deleteCurrentApi=deleteCurrentApi;
window._apiArchToggleUI=_apiArchToggleUI;
window.toggleApiArchiveView=toggleApiArchiveView;
window.renderApiArchiveList=renderApiArchiveList;
window.archHardDeleteAsk=archHardDeleteAsk;
window.openApiRestoreDialog=openApiRestoreDialog;
window.closeApiRestoreDialog=closeApiRestoreDialog;
window.confirmApiRestore=confirmApiRestore;
window.loadApiSettingsUI=loadApiSettingsUI;
window.loadFriendsList=loadFriendsList;
window.selectFriend=selectFriend;
window.createGroup=createGroup;
window.filterGroupRolePicker=filterGroupRolePicker;
window._renderGroupMentionList=_renderGroupMentionList;
window._toggleGroupMentionOnly=_toggleGroupMentionOnly;
window._toggleGroupMember=_toggleGroupMember;
window.closeGroupDialog=closeGroupDialog;
window.openMemberManager=openMemberManager;
window.closeMemberManager=closeMemberManager;
window.renderMemberMgrList=renderMemberMgrList;
window.renderMemberPicker=renderMemberPicker;
window.filterMemberPicker=filterMemberPicker;
window.addMemberFromPicker=addMemberFromPicker;
window.memberAction=memberAction;
window.confirmCreateGroup=confirmCreateGroup;
window.loadGroups=loadGroups;
window.normalizeGroupMembers=normalizeGroupMembers;
window.getGroupMemberIds=getGroupMemberIds;
window.getGroupMemberStatus=getGroupMemberStatus;
window.countGroupMembersByStatus=countGroupMembersByStatus;
window.setGroupMemberStatus=setGroupMemberStatus;
window.insertGroupSystemEvent=insertGroupSystemEvent;
window.addGroupMember=addGroupMember;
window.removeGroupMember=removeGroupMember;
window.pickGroupUtilityCfg=pickGroupUtilityCfg;
window.selectGroup=selectGroup;
window.deleteGroup=deleteGroup;
window.loadThreads=loadThreads;
window.createThread=createThread;
window.closeThreadDialog=closeThreadDialog;
window.confirmCreateThread=confirmCreateThread;
window.deleteThread=deleteThread;
window.selectThread=selectThread;
window.searchChat=searchChat;
window.toggleChatArchive=toggleChatArchive;
window.enterChatArchive=enterChatArchive;
window.exitChatArchive=exitChatArchive;
window.renderArchFriendsList=renderArchFriendsList;
window.selectArchFriend=selectArchFriend;
window.selectArchThread=selectArchThread;
window._getCalRange=_getCalRange;
window.buildCalData=buildCalData;
window.renderChatCalendar=renderChatCalendar;
window.calNav=calNav;
window.toggleCalJump=toggleCalJump;
window.calJYU=calJYU;
window.calJY=calJY;
window.calJM=calJM;
window.calJump=calJump;
window.PROVIDERS=PROVIDERS;
window._chatSendingFor=_chatSendingFor;
window.API_CONFIG_FALLBACK_KEY=API_CONFIG_FALLBACK_KEY;
window._CAL_MONTHS=_CAL_MONTHS;
ibSocialLive('_showThinkingTouched', function(){return _showThinkingTouched}, function(v){_showThinkingTouched=v});
ibSocialLive('apiConfigs', function(){return apiConfigs}, function(v){apiConfigs=v});
ibSocialLive('archivedConfigs', function(){return archivedConfigs}, function(v){archivedConfigs=v});
ibSocialLive('editingApiId', function(){return editingApiId}, function(v){editingApiId=v});
ibSocialLive('activeFriendId', function(){return activeFriendId}, function(v){activeFriendId=v});
ibSocialLive('activeThreadId', function(){return activeThreadId}, function(v){activeThreadId=v});
ibSocialLive('_dragApiIdx', function(){return _dragApiIdx}, function(v){_dragApiIdx=v});
ibSocialLive('_pendingApiAvatar', function(){return _pendingApiAvatar}, function(v){_pendingApiAvatar=v});
ibSocialLive('_pendingApiBanner', function(){return _pendingApiBanner}, function(v){_pendingApiBanner=v});
ibSocialLive('_tkCacheDoc', function(){return _tkCacheDoc}, function(v){_tkCacheDoc=v});
ibSocialLive('_tkT0', function(){return _tkT0}, function(v){_tkT0=v});
ibSocialLive('_tkCalM', function(){return _tkCalM}, function(v){_tkCalM=v});
ibSocialLive('_ARCH_CLOCK_SVG', function(){return _ARCH_CLOCK_SVG}, function(v){_ARCH_CLOCK_SVG=v});
ibSocialLive('_ARCH_RETURN_SVG', function(){return _ARCH_RETURN_SVG}, function(v){_ARCH_RETURN_SVG=v});
ibSocialLive('_ARCH_RESTORE_SVG', function(){return _ARCH_RESTORE_SVG}, function(v){_ARCH_RESTORE_SVG=v});
ibSocialLive('_adlTargetId', function(){return _adlTargetId}, function(v){_adlTargetId=v});
ibSocialLive('_apiArchView', function(){return _apiArchView}, function(v){_apiArchView=v});
ibSocialLive('_apiRestoreId', function(){return _apiRestoreId}, function(v){_apiRestoreId=v});
ibSocialLive('_groupSelectOrder', function(){return _groupSelectOrder}, function(v){_groupSelectOrder=v});
ibSocialLive('_groupMentionOnly', function(){return _groupMentionOnly}, function(v){_groupMentionOnly=v});
ibSocialLive('_threadCreatingFor', function(){return _threadCreatingFor}, function(v){_threadCreatingFor=v});
ibSocialLive('_chatArchMode', function(){return _chatArchMode}, function(v){_chatArchMode=v});
ibSocialLive('_calYear', function(){return _calYear}, function(v){_calYear=v});
ibSocialLive('_tkCalPick', function(){return _tkCalPick}, function(v){_tkCalPick=v});
ibSocialLive('_adlChoice', function(){return _adlChoice}, function(v){_adlChoice=v});
ibSocialLive('_adlResolve', function(){return _adlResolve}, function(v){_adlResolve=v});
ibSocialLive('_chatArchPrevTitles', function(){return _chatArchPrevTitles}, function(v){_chatArchPrevTitles=v});
ibSocialLive('_calMonth', function(){return _calMonth}, function(v){_calMonth=v});
ibSocialLive('_calChatDays', function(){return _calChatDays}, function(v){_calChatDays=v});
ibSocialLive('_calEarliest', function(){return _calEarliest}, function(v){_calEarliest=v});
NS.expose('social', {
  _ibIsLoopbackEndpoint: _ibIsLoopbackEndpoint,
  _ibApiHasCredential: _ibApiHasCredential,
  _ibApiReady: _ibApiReady,
  _modelThinkingDefault: _modelThinkingDefault,
  _resolveShowThinking: _resolveShowThinking,
  _syncShowThinkingDefault: _syncShowThinkingDefault,
  _voiceRateUpdate: _voiceRateUpdate,
  _voiceToggleDetail: _voiceToggleDetail,
  _voiceTypeChange: _voiceTypeChange,
  _voiceCurrentType: _voiceCurrentType,
  _voiceCloneUploadFile: _voiceCloneUploadFile,
  _voiceCloneDeleteCurrent: _voiceCloneDeleteCurrent,
  _voiceCloneSelectionGet: function(){return _voiceCloneSelection?Object.assign({},_voiceCloneSelection):null;},
  _ibReferencedRefAudioIds: _ibReferencedRefAudioIds,
  _voiceSyncProviderOptions: _voiceSyncProviderOptions,
  _voiceSyncCapabilityFields: _voiceSyncCapabilityFields,
  _voiceUsesSelect: _voiceUsesSelect,
  _voiceGetId: _voiceGetId,
  _voiceSetId: _voiceSetId,
  IB_TTS_CATALOG: IB_TTS_CATALOG,
  testCharacterVoice: testCharacterVoice,
  onProviderChange: onProviderChange,
  _apiFallbackRead: _apiFallbackRead,
  _apiFallbackWrite: _apiFallbackWrite,
  _apiFallbackRemove: _apiFallbackRemove,
  _apiFallbackPut: _apiFallbackPut,
  _ibStorageCaps: _ibStorageCaps,
  _apiSaveNotice: _apiSaveNotice,
  _persistApiConfig: _persistApiConfig,
  loadApiConfigs: loadApiConfigs,
  renderApiList: renderApiList,
  _apiDragStart: _apiDragStart,
  _apiDragOver: _apiDragOver,
  _apiDragEnd: _apiDragEnd,
  _apiDrop: _apiDrop,
  handleApiAvatarUpload: handleApiAvatarUpload,
  removeApiAvatar: removeApiAvatar,
  _renderApiAvatarPreview: _renderApiAvatarPreview,
  _apiAvatarLoadError: _apiAvatarLoadError,
  addNewApi: addNewApi,
  MAX_GROUP_MEMBERS: MAX_GROUP_MEMBERS,
  _tkLoad: _tkLoad,
  _tkSave: _tkSave,
  _tkRecord: _tkRecord,
  _tkFmt: _tkFmt,
  _tkEsc: _tkEsc,
  _tkCost: _tkCost,
  _tkPrice: _tkPrice,
  _tkDay0: _tkDay0,
  _tkAddD: _tkAddD,
  _tkRangeT0: _tkRangeT0,
  _tkRangeT1x: _tkRangeT1x,
  _tkFmtD: _tkFmtD,
  _tkRangeLabel: _tkRangeLabel,
  _tkRangeTextSync: _tkRangeTextSync,
  _tkCalToggle: _tkCalToggle,
  _tkCalPlace: _tkCalPlace,
  _tkCalClose: _tkCalClose,
  _tkCalDoc: _tkCalDoc,
  _tkCalKey: _tkCalKey,
  _tkCalNav: _tkCalNav,
  _tkCalPickDay: _tkCalPickDay,
  _tkCalRender: _tkCalRender,
  _tkClearRange: _tkClearRange,
  _tkWipeAll: _tkWipeAll,
  renderTokenDash: renderTokenDash,
  editApi: editApi,
  saveCurrentApi: saveCurrentApi,
  cancelApiEdit: cancelApiEdit,
  deleteApiConfig: deleteApiConfig,
  _adlPick: _adlPick,
  closeApiDelDialog: closeApiDelDialog,
  confirmApiDelDialog: confirmApiDelDialog,
  _archiveApiConfig: _archiveApiConfig,
  _hardDeleteApiConfig: _hardDeleteApiConfig,
  _findGroupsReferencingCharacter: _findGroupsReferencingCharacter,
  _detachCharacterFromGroups: _detachCharacterFromGroups,
  deleteCurrentApi: deleteCurrentApi,
  _apiArchToggleUI: _apiArchToggleUI,
  toggleApiArchiveView: toggleApiArchiveView,
  renderApiArchiveList: renderApiArchiveList,
  archHardDeleteAsk: archHardDeleteAsk,
  openApiRestoreDialog: openApiRestoreDialog,
  closeApiRestoreDialog: closeApiRestoreDialog,
  confirmApiRestore: confirmApiRestore,
  loadApiSettingsUI: loadApiSettingsUI,
  loadFriendsList: loadFriendsList,
  selectFriend: selectFriend,
  createGroup: createGroup,
  filterGroupRolePicker: filterGroupRolePicker,
  _renderGroupMentionList: _renderGroupMentionList,
  _toggleGroupMentionOnly: _toggleGroupMentionOnly,
  _toggleGroupMember: _toggleGroupMember,
  closeGroupDialog: closeGroupDialog,
  openMemberManager: openMemberManager,
  closeMemberManager: closeMemberManager,
  renderMemberMgrList: renderMemberMgrList,
  renderMemberPicker: renderMemberPicker,
  filterMemberPicker: filterMemberPicker,
  addMemberFromPicker: addMemberFromPicker,
  memberAction: memberAction,
  confirmCreateGroup: confirmCreateGroup,
  loadGroups: loadGroups,
  normalizeGroupMembers: normalizeGroupMembers,
  getGroupMemberIds: getGroupMemberIds,
  getGroupMemberStatus: getGroupMemberStatus,
  countGroupMembersByStatus: countGroupMembersByStatus,
  setGroupMemberStatus: setGroupMemberStatus,
  insertGroupSystemEvent: insertGroupSystemEvent,
  addGroupMember: addGroupMember,
  removeGroupMember: removeGroupMember,
  pickGroupUtilityCfg: pickGroupUtilityCfg,
  selectGroup: selectGroup,
  deleteGroup: deleteGroup,
  loadThreads: loadThreads,
  createThread: createThread,
  closeThreadDialog: closeThreadDialog,
  confirmCreateThread: confirmCreateThread,
  deleteThread: deleteThread,
  selectThread: selectThread,
  searchChat: searchChat,
  toggleChatArchive: toggleChatArchive,
  enterChatArchive: enterChatArchive,
  exitChatArchive: exitChatArchive,
  renderArchFriendsList: renderArchFriendsList,
  selectArchFriend: selectArchFriend,
  selectArchThread: selectArchThread,
  _getCalRange: _getCalRange,
  buildCalData: buildCalData,
  renderChatCalendar: renderChatCalendar,
  calNav: calNav,
  toggleCalJump: toggleCalJump,
  calJYU: calJYU,
  calJY: calJY,
  calJM: calJM,
  calJump: calJump,
  PROVIDERS: PROVIDERS,
  _chatSendingFor: _chatSendingFor,
  API_CONFIG_FALLBACK_KEY: API_CONFIG_FALLBACK_KEY,
  _CAL_MONTHS: _CAL_MONTHS,
  _showThinkingTouched: _showThinkingTouched,
  DEEPSEEK_NATIVE_VISION_MODEL: DEEPSEEK_NATIVE_VISION_MODEL,
  _isDeepSeekNativeVisionModel: _isDeepSeekNativeVisionModel,
  _syncVisionUI: _syncVisionUI,
  apiConfigs: apiConfigs,
  archivedConfigs: archivedConfigs,
  editingApiId: editingApiId,
  activeFriendId: activeFriendId,
  activeThreadId: activeThreadId,
  _dragApiIdx: _dragApiIdx,
  _pendingApiAvatar: _pendingApiAvatar,
  _tkCacheDoc: _tkCacheDoc,
  _tkT0: _tkT0,
  _tkCalM: _tkCalM,
  _ARCH_CLOCK_SVG: _ARCH_CLOCK_SVG,
  _ARCH_RETURN_SVG: _ARCH_RETURN_SVG,
  _ARCH_RESTORE_SVG: _ARCH_RESTORE_SVG,
  _adlTargetId: _adlTargetId,
  _apiArchView: _apiArchView,
  _apiRestoreId: _apiRestoreId,
  _groupSelectOrder: _groupSelectOrder,
  _groupMentionOnly: _groupMentionOnly,
  _threadCreatingFor: _threadCreatingFor,
  _chatArchMode: _chatArchMode,
  _calYear: _calYear,
  _tkCalPick: _tkCalPick,
  _adlChoice: _adlChoice,
  _adlResolve: _adlResolve,
  _chatArchPrevTitles: _chatArchPrevTitles,
  _calMonth: _calMonth,
  _calChatDays: _calChatDays,
  _calEarliest: _calEarliest,
});
})(window.IB || (window.IB = {}));
