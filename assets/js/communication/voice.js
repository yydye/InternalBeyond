/* VOICE MESSAGE SYSTEM（点按录音）—— 自 communication.js 机械提取（只动位置，不改逻辑；加载于 communication.js 之前）。 */
(function(NS){
/* ── VOICE MESSAGE SYSTEM（点按录音）──────────────────────
   点按麦克风按钮开始录音，再次点按（任一语音按钮）停止录音并发送；
   达到时长上限自动停止并发送。
   消息记录同时保存音频（dataUrl）、文字稿（transcript）与本地声学语气特征（tone）；
   文字稿来源优先级：外部转写接口（API 页面「语音转写」配置后浏览器识别不再启动）→ 浏览器内置识别。
   发送给 API 的等效文本为 "[语音消息 N秒｜声学语气参考: …] 文字稿"（语气段仅对听不到原声的模型附加；
   识别不可用时注明未识别）。能听音频的模型（Gemini 等）当轮直接收到原声 WAV，历史轮回落文字稿行。
   注入方式与文件上传一致：逐条消息确定性拼接，历史前缀保持稳定，不影响提示缓存命中。 */
var _vmSt=null;/* 当前录音会话状态 */
var _vmAudio=null,_vmPlayingEl=null;/* 语音播放：全局单实例，点击新语音条时自动停掉上一条 */
var _vmNoSrWarned=false;
var _vmRecogWarned=false;/* 识别失败原因提示：每次会话只弹一次，具体错误码每次都写入控制台 */
function _vmRecogErrMsg(code){
  var m={
    'network':'语音识别失败：浏览器无法连接其内置的在线识别服务（Edge 依赖微软服务、Chrome 依赖谷歌服务，受网络与代理影响）',
    'language-not-supported':'语音识别失败：当前浏览器的识别服务不支持所用语言（Edge 对中文识别支持有限，可尝试 Chrome）',
    'service-not-allowed':'语音识别失败：识别服务被浏览器或系统设置禁用',
    'not-allowed':'语音识别失败：识别服务被浏览器或系统设置禁用',
    'audio-capture':'语音识别失败：识别服务无法获取麦克风输入',
    'no-speech':'语音识别未检测到人声'
  };
  var t=m[String(code||'')]||'语音识别未返回结果（错误码: '+(code||'无')+'）';
  return t+'。语音本身已正常发送，但 AI 无法读取内容。可在 API 页面「语音转写」配置外部转写服务，不再依赖浏览器识别';
}
const VM_MAX_SEC=60;/* 最长录音 60 秒，达到后自动停止并发送 */

function _vmSupported(){return !!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia&&window.MediaRecorder)}
function _voiceApiLine(v,withTone){var d=Math.max(1,Math.round((v&&v.duration)||1));var t=((v&&v.transcript)||'').trim();var tn=(withTone&&v&&v.tone)?('｜声学语气参考: '+v.tone):'';return '[语音消息 '+d+'秒'+tn+'] '+(t||'（语音内容未能自动识别）')}

/* ── 语音转写（外部接口）· 音频直发 · 本地声学语气分析 ─────────
   1) 转写：在 API 页面配置 OpenAI 兼容转写接口（/audio/transcriptions）后，
      文字稿改由该服务产出，浏览器内置识别整条通道不再启动；任何浏览器、任何聊天模型可用。
      设置为全局一份（apiSettings/voiceTrans），三项留空则维持原浏览器识别路径。
   2) 直发：能听音频的模型（Gemini 原生通道；OpenAI 兼容通道下模型名含 gemini/omni/audio）
      在语音发送当轮直接收到原声（16kHz 单声道 WAV 内联 parts），注入方式与图片附件完全一致：
      仅当轮携带，历史轮次回落为文字稿行——沿用现有附件的缓存行为，不改变缓存结构。
   3) 语气：录音结束后本地计算语速/音量/停顿/基频等声学特征（不联网、确定性），
      定格存入消息（voice.tone），仅拼进「听不到原声的模型」的语音等效文本供其自行判断情绪；
      能听原声的模型不附加任何语气标签；界面不显示；不动 system、不改旧消息文本，升级零缓存重建。 */
var _vtCfg=null;
async function getVoiceTransSettings(){try{const s=await dbGet('apiSettings','voiceTrans');return s||{endpoint:'',apiKey:'',model:'',direct:true}}catch(e){return{endpoint:'',apiKey:'',model:'',direct:true}}}
async function _vtGet(){if(_vtCfg)return _vtCfg;_vtCfg=await getVoiceTransSettings();return _vtCfg}
function _vtOn(s){return !!(s&&s.endpoint&&s.apiKey&&s.model)}
function _vtUrl(u){u=String(u||'').trim().replace(/\/+$/,'');if(!u)return '';if(/\/audio\/transcriptions$/i.test(u))return u;if(/\/v\d+[a-z]*$/i.test(u))return u+'/audio/transcriptions';return u+'/v1/audio/transcriptions'}
async function saveVoiceTransSettings(){
  const s={id:'voiceTrans',
    endpoint:(document.getElementById('api-vt-endpoint')?.value||'').trim(),
    apiKey:(document.getElementById('api-vt-key')?.value||'').trim(),
    model:(document.getElementById('api-vt-model')?.value||'').trim(),
    direct:!!document.getElementById('api-vt-direct')?.checked};
  await dbPut('apiSettings',s);_vtCfg=s;toast('设置已保存');
}
async function loadVoiceTransUI(){
  const s=await getVoiceTransSettings();_vtCfg=s;
  const e=document.getElementById('api-vt-endpoint');if(e)e.value=s.endpoint||'';
  const k=document.getElementById('api-vt-key');if(k)k.value=s.apiKey||'';
  const m=document.getElementById('api-vt-model');if(m)m.value=s.model||'';
  const d=document.getElementById('api-vt-direct');if(d)d.checked=s.direct!==false;
}
/* 能否直接听音频：Gemini 原生通道恒可；OpenAI 兼容通道按模型名判断（gemini 系经兼容层/中转、GPT-Audio、Qwen-Omni 等）；Anthropic 文本接口不支持 */
function _vmAudioNative(cfg){
  if(!cfg)return false;
  const fmt=(PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].format)||'openai';
  if(fmt==='gemini')return true;
  if(fmt==='anthropic')return false;
  return /(gemini|omni|audio)/i.test(String(cfg.model||''));
}
/* OpenAI 兼容转写请求：multipart 上传原始录音（webm/mp4 原样交给服务端解码） */
async function _vtTranscribe(vt,blob,mime){
  const url=_vtUrl(vt.endpoint);
  if(!url)throw new Error('转写接口地址为空');
  const fd=new FormData();
  const ext=/mp4/i.test(mime||'')?'mp4':(/ogg/i.test(mime||'')?'ogg':'webm');
  fd.append('file',blob,'voice.'+ext);
  fd.append('model',vt.model);
  const ac=new AbortController();const tm=setTimeout(function(){try{ac.abort()}catch(e){}},30000);
  try{
    const res=await fetch(url,{method:'POST',signal:ac.signal,headers:{'Authorization':'Bearer '+vt.apiKey},body:fd});
    clearTimeout(tm);
    if(!res.ok){const t=await res.text();throw new Error(res.status+': '+String(t||'').slice(0,200))}
    const ct=res.headers.get('content-type')||'';
    if(ct.includes('json')){const j=await res.json();return String((j&&(j.text!=null?j.text:(j.data&&j.data.text!=null?j.data.text:'')))||'').trim()}
    return String(await res.text()||'').trim();
  }catch(e){clearTimeout(tm);if(e&&e.name==='AbortError')throw new Error('转写请求超时（30秒）');throw e}
}
/* 解码到 AudioBuffer（回调式写法兼容 Safari） */
var _vmACtx=null;
async function _vmDecode(blob){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw new Error('WebAudio 不可用');
  if(!_vmACtx)_vmACtx=new AC();
  const buf=await blob.arrayBuffer();
  return await new Promise(function(res,rej){_vmACtx.decodeAudioData(buf,res,function(e){rej(e||new Error('音频解码失败'))})});
}
/* AudioBuffer → 16kHz 单声道 16bit WAV 的 base64（音频直发用；线性插值重采样） */
function _vmWav16kBase64(ab){
  const srcRate=ab.sampleRate,chN=ab.numberOfChannels,len=ab.length;
  const mono=new Float32Array(len);
  for(let c=0;c<chN;c++){const d=ab.getChannelData(c);for(let i=0;i<len;i++)mono[i]+=d[i]/chN}
  const tRate=16000,ratio=srcRate/tRate,tLen=Math.max(1,Math.floor(len/ratio));
  const bytes=new ArrayBuffer(44+tLen*2),dv=new DataView(bytes);
  const wstr=function(o,s){for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i))};
  wstr(0,'RIFF');dv.setUint32(4,36+tLen*2,true);wstr(8,'WAVE');wstr(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,tRate,true);dv.setUint32(28,tRate*2,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);wstr(36,'data');dv.setUint32(40,tLen*2,true);
  for(let i=0;i<tLen;i++){const pos=i*ratio,i0=Math.floor(pos),fr=pos-i0;const s0=mono[i0]||0,s1=(i0+1<len)?mono[i0+1]:s0;let v=s0+(s1-s0)*fr;v=Math.max(-1,Math.min(1,v));dv.setInt16(44+i*2,v<0?v*0x8000:v*0x7FFF,true)}
  const u8=new Uint8Array(bytes);let bin='';
  for(let i=0;i<u8.length;i+=0x8000)bin+=String.fromCharCode.apply(null,u8.subarray(i,Math.min(i+0x8000,u8.length)));
  return btoa(bin);
}
/* 当轮语音的 API 内联音频（结果缓存在 voiceMsg 对象上，群聊多成员共用一次转换） */
async function _vmApiAudioWav(v){
  if(!v)throw new Error('无语音数据');
  if(v._wav16k)return v._wav16k;
  const ab=v._ab?v._ab:await _vmDecode(await (await fetch(v.dataUrl)).blob());
  v._wav16k=_vmWav16kBase64(ab);
  return v._wav16k;
}
/* 本地声学语气分析：语速/音量/停顿/基频。产出一句确定性短描述，随消息定格存储；失败返回空串 */
function _vmToneAnalyze(ab,transcript){
  try{
    if(!ab||!ab.length||ab.duration<0.6)return '';
    const srcRate=ab.sampleRate,chN=ab.numberOfChannels,srcLen=ab.length;
    /* 简易降采样到 ~16k：整数步长抽取（分析用途足够） */
    const step=Math.max(1,Math.round(srcRate/16000)),sr=srcRate/step,n=Math.floor(srcLen/step);
    const x=new Float32Array(n);
    for(let c=0;c<chN;c++){const d=ab.getChannelData(c);for(let i=0;i<n;i++)x[i]+=d[i*step]/chN}
    const frame=Math.round(sr*0.03),hop=Math.round(sr*0.015),nf=Math.max(1,Math.floor((n-frame)/hop));
    if(nf<8)return '';
    const _median=function(a){if(!a.length)return 0;const b=a.slice().sort(function(u,v){return u-v});const m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2};
    const rms=new Float32Array(nf);
    for(let f=0;f<nf;f++){let s=0,o=f*hop;for(let i=0;i<frame;i++){const v=x[o+i];s+=v*v}rms[f]=Math.sqrt(s/frame)}
    const sorted=Array.from(rms).sort(function(a,b){return a-b});
    const p10=sorted[Math.floor(nf*0.10)]||0,p90=sorted[Math.floor(nf*0.90)]||0;
    if(p90<0.004)return '';/* 几乎无声 */
    const thr=Math.min(p90*0.65,Math.max(p90*0.18,p10*2.5,0.0025));/* 连续发声时 p10≈p90，阈值需封顶，避免整段被误判为静音 */
    let first=-1,last=-1;const act=new Uint8Array(nf);
    for(let f=0;f<nf;f++){if(rms[f]>=thr){act[f]=1;if(first<0)first=f;last=f}}
    if(first<0||last-first<4)return '';
    let actN=0,sumDb=0,sumR=0,sumR2=0;const activeRms=[];
    for(let f=first;f<=last;f++){if(act[f]){const rv=rms[f];actN++;sumDb+=20*Math.log10(rv+1e-8);sumR+=rv;sumR2+=rv*rv;activeRms.push(rv)}}
    const meanDb=sumDb/Math.max(1,actN),meanR=sumR/Math.max(1,actN);
    const rmsStd=Math.sqrt(Math.max(0,sumR2/Math.max(1,actN)-meanR*meanR));
    const energyCv=rmsStd/Math.max(1e-6,meanR);
    const _segRms=function(a,b){let s=0,k=0;for(let f=Math.max(first,a);f<=Math.min(last,b);f++){if(act[f]){s+=rms[f];k++}}return k?s/k:0};
    const span=last-first+1,seg=Math.max(3,Math.floor(span*0.28));
    const earlyR=_segRms(first,first+seg-1),lateR=_segRms(last-seg+1,last);
    const energyTailDb=(earlyR>0&&lateR>0)?20*Math.log10(lateR/earlyR):0;
    /* 停顿：讲话跨度内的静音段占比与明显停顿次数 */
    let pauseFrames=0,longPauses=0,run=0;
    const hopSec=hop/sr;
    for(let f=first;f<=last;f++){
      if(!act[f]){run++;pauseFrames++}
      else{if(run*hopSec>=0.35)longPauses++;run=0}
    }
    if(run*hopSec>=0.35)longPauses++;
    const pauseRatio=pauseFrames/span;
    /* 基频：活跃帧自相关（60–400Hz）。保留时间顺序，用于尾音和声线变化判断 */
    const lagMin=Math.max(2,Math.floor(sr/400)),lagMax=Math.min(frame-2,Math.ceil(sr/60));
    const f0seq=[];
    for(let f=first;f<=last;f+=2){
      if(!act[f])continue;
      const o=f*hop;let e0=0;
      for(let i=0;i<frame;i++){const v=x[o+i];e0+=v*v}
      if(e0<=0)continue;
      let best=0,bestLag=0;
      for(let lag=lagMin;lag<=lagMax;lag++){
        let s=0;const lim=frame-lag;
        for(let i=0;i<lim;i+=2)s+=x[o+i]*x[o+i+lag];
        if(s>best){best=s;bestLag=lag}
      }
      const q=bestLag?best/(e0*0.5):0;
      if(bestLag&&q>0.32)f0seq.push({hz:sr/bestLag,f:f,q:Math.max(0,Math.min(1,q))});
    }
    let f0med=0,f0spread=0,f0TailDelta=0,f0Jitter=0,f0Quality=0;
    if(f0seq.length>=6){
      const f0vals=f0seq.map(function(v){return v.hz});
      f0med=_median(f0vals);
      const f0sorted=f0vals.slice().sort(function(a,b){return a-b});
      const q1=f0sorted[Math.floor(f0sorted.length*0.25)],q3=f0sorted[Math.floor(f0sorted.length*0.75)];
      f0spread=(q3-q1)/Math.max(1,f0med);
      const edge=Math.max(2,Math.floor(f0seq.length*0.30));
      const fEarly=_median(f0seq.slice(0,edge).map(function(v){return v.hz}));
      const fLate=_median(f0seq.slice(-edge).map(function(v){return v.hz}));
      if(fEarly&&fLate)f0TailDelta=(fLate-fEarly)/Math.max(1,f0med);
      let jd=0,jn=0,qs=0;
      for(let i=0;i<f0seq.length;i++){
        qs+=f0seq[i].q;
        if(i){const d=Math.abs(f0seq[i].hz-f0seq[i-1].hz);if(d/f0med<0.45){jd+=d;jn++}}
      }
      f0Jitter=(jn?jd/jn:0)/Math.max(1,f0med);
      f0Quality=qs/f0seq.length;
    }
    /* 语速：中文按字数，其他语言按词数 / 有效发声时长 */
    const txt=String(transcript||'').trim();
    const cjk=(txt.match(/[\u3400-\u9fff]/g)||[]).length;
    const words=(txt.match(/[A-Za-z0-9]+(?:'[A-Za-z]+)?/g)||[]).length;
    const voicedSec=actN*hopSec;
    const useCjk=cjk>=Math.max(4,words),units=useCjk?cjk:words,unitName=useCjk?'字':'词';
    let rate=0;if(units>=(useCjk?4:2)&&voicedSec>0.8)rate=units/voicedSec;
    const slowThr=useCjk?2.6:1.5,fastThr=useCjk?5.4:3.2;
    const rateDesc=!rate?'语速未知':(rate<slowThr?'语速偏慢':(rate>fastThr?'语速偏快':'语速中等'))+'('+rate.toFixed(1)+unitName+'/秒)';
    const volumeDesc=meanDb<-31?'音量很低':meanDb<-24?'音量偏低':meanDb>-11?'音量较大':'音量中等';
    const pauseDesc=(pauseRatio>0.42||longPauses>=3)?'停顿较多('+longPauses+'次明显停顿)':(pauseRatio>0.24||longPauses>=1)?'有少量停顿':'停顿较少';
    const pitchDesc=!f0med?'':(f0spread>0.30?'语调起伏明显':f0spread<0.08?'语调较平':'语调起伏中等');

    /* 声线变化：只描述本段内可观测变化，不建立说话人身份或长期基线 */
    const voice=[];
    const soft=meanDb<-21&&energyCv<0.72,strong=meanDb>-14;
    if(soft)voice.push('声线偏轻柔');else if(strong)voice.push('声线偏有力');
    if(f0TailDelta>0.14)voice.push('尾音明显上扬');else if(f0TailDelta>0.07)voice.push('尾音轻微上扬');else if(f0TailDelta<-0.14)voice.push('尾音明显下沉');else if(f0TailDelta<-0.07)voice.push('尾音轻微下沉');
    if(energyTailDb>3.5)voice.push('后段音量渐强');else if(energyTailDb<-3.5)voice.push('后段音量渐弱');
    if(f0Jitter>0.13&&f0Quality>0.45&&f0spread>0.12)voice.push('音高有轻微颤动倾向');
    if(!voice.length&&f0med)voice.push(f0spread<0.08?'声线较稳定':'声线有自然起伏');

    /* 本地情绪融合：借鉴“声学特征 + 文字语义”的两阶段思路，但不增加第二次联网调用 */
    const score={'亲昵/撒娇':0,'开心':0,'兴奋':0,'愤怒/激动':0,'难过/低落':0,'疲惫':0,'紧张/不安':0,'犹豫/不确定':0,'平静/中性':0.8};
    const add=function(k,v){score[k]+=v};
    if(/(宝贝|宝宝|亲爱的|老公|老婆|爹地|哥哥|姐姐|想你|爱你|抱抱|亲亲|么么|撒娇|陪我|哄我|叫我)/i.test(txt))add('亲昵/撒娇',3.6);
    if(/(开心|高兴|好棒|太好|喜欢|幸福|哈哈|嘿嘿|笑死|爱死)/i.test(txt))add('开心',3.4);
    if(/(激动|兴奋|迫不及待|太爽|绝了|冲啊|哇塞)/i.test(txt))add('兴奋',3.6);
    if(/(生气|气死|愤怒|烦死|闭嘴|讨厌|滚|凭什么|受够)/i.test(txt))add('愤怒/激动',4.0);
    if(/(难过|伤心|委屈|想哭|哭了|失落|心疼|痛苦|不开心|崩溃)/i.test(txt))add('难过/低落',4.0);
    if(/(好累|累死|疲惫|困死|好困|没力气|撑不住|想睡|熬不动)/i.test(txt))add('疲惫',4.2);
    if(/(紧张|害怕|怕死|担心|焦虑|不安|慌|怎么办|完了)/i.test(txt))add('紧张/不安',3.9);
    if(/(不知道|不确定|也许|可能吧|要不要|可以吗|行吗|好吗|是不是)/i.test(txt))add('犹豫/不确定',2.8);
    if(/(没事|还好|没关系|慢慢来|挺好的|平静|放心)/i.test(txt))add('平静/中性',2.2);
    const endingSoft=/[嘛呀啦呐哟哦诶哼～~]{1,3}[。！？!?]*$/.test(txt);
    if(endingSoft)add('亲昵/撒娇',0.8);
    if(rate){
      if(rate<slowThr){add('疲惫',1.1);add('难过/低落',0.7);add('平静/中性',0.5);add('亲昵/撒娇',0.3)}
      else if(rate>fastThr){add('兴奋',1.2);add('紧张/不安',0.9);add('愤怒/激动',0.8)}
    }
    if(meanDb<-25){add('疲惫',1.1);add('难过/低落',0.8);add('亲昵/撒娇',0.4)}
    else if(meanDb>-13){add('兴奋',1.2);add('愤怒/激动',1.1);add('开心',0.5)}
    if(pauseRatio>0.40||longPauses>=3){add('疲惫',1.2);add('难过/低落',0.9);add('紧张/不安',0.5)}
    else if(pauseRatio<0.12){add('开心',0.4);add('兴奋',0.4)}
    if(f0spread>0.30){add('兴奋',0.9);add('紧张/不安',0.7);add('亲昵/撒娇',0.4)}
    else if(f0med&&f0spread<0.08){add('平静/中性',0.9);add('疲惫',0.3)}
    if(f0TailDelta>0.10){add('亲昵/撒娇',1.1);add('开心',0.3);add('犹豫/不确定',0.3)}
    else if(f0TailDelta<-0.10){add('难过/低落',0.5);add('疲惫',0.5);add('平静/中性',0.3)}
    if(soft){add('亲昵/撒娇',0.7);add('平静/中性',0.7);add('疲惫',0.3)}
    if(strong&&rate>fastThr){add('愤怒/激动',0.9);add('兴奋',0.8)}
    if(energyCv>0.75){add('兴奋',0.5);add('紧张/不安',0.4);add('愤怒/激动',0.3)}
    else if(energyCv<0.35){add('平静/中性',0.7);add('疲惫',0.2)}
    if(endingSoft&&soft&&f0TailDelta>0.05)add('亲昵/撒娇',1.2);
    const ranked=Object.keys(score).sort(function(a,b){return score[b]-score[a]});
    const top=ranked[0],second=ranked[1],topScore=score[top],gap=topScore-score[second];
    let emotion=top;
    if(topScore<2.2)emotion='平静/中性';
    else if(score[second]>=2.8&&gap<0.9&&second!=='平静/中性')emotion=top+'，兼有'+second;
    const confidence=(topScore>=6&&gap>=1.2)?'较高':topScore>=3.5?'中等':'较低';

    const parts=['情绪倾向:'+emotion+'('+confidence+'置信)'];
    if(voice.length)parts.push('声线/变化:'+voice.slice(0,3).join('、'));
    parts.push(rateDesc,volumeDesc,pauseDesc);
    if(f0med)parts.push('基频约'+Math.round(f0med)+'Hz',pitchDesc);
    return parts.filter(Boolean).join('；');
  }catch(e){return ''}
}
/* Call 路径适配：worklet 产出 16kHz 单声道 Int16 PCM，而 _vmToneAnalyze 需要
   AudioBuffer。此函数把 Int16 + sampleRate 包成一个最小的 AudioBuffer 兼容壳
   （length/duration/sampleRate/numberOfChannels/getChannelData），让 Call 路径
   复用同一个声学算法核心，不复制 _vmToneAnalyze 算法本身。纯函数、零副作用。 */
function _vmPcmToAudioLike(pcm, sampleRate){
  var sr=Number(sampleRate)||16000;
  if(!pcm)return null;
  var arr=pcm;
  if(pcm instanceof ArrayBuffer)arr=new Int16Array(pcm);
  else if(ArrayBuffer.isView(pcm)&&!(pcm instanceof Int16Array))arr=pcm;
  if(!arr||!arr.length)return null;
  var n=arr.length,ch=new Float32Array(n);
  for(var i=0;i<n;i++)ch[i]=arr[i]/32768;
  var self={sampleRate:sr,numberOfChannels:1,length:n,_ch:[ch]};
  Object.defineProperty(self,'duration',{get:function(){return n/sr}});
  self.getChannelData=function(c){return self._ch[c]||self._ch[0]};
  return self;
}
function _vmInit(){
  ['chat-voice-full','chat-voice-mini'].forEach(function(id){
    var btn=document.getElementById(id);if(!btn)return;
    btn.addEventListener('contextmenu',function(e){e.preventDefault()});/* 移动端长按防弹出系统菜单 */
    btn.addEventListener('click',function(e){e.preventDefault();_vmToggle(btn)});
  });
}

/* 点按切换：无录音会话时开始录音；录音中再次点按（任一语音按钮）停止并发送 */
function _vmToggle(btn){
  if(_vmSt){_vmFinish(_vmSt);return}
  _vmStart(btn);
}

async function _vmStart(btn){
  if(_vmSt)return;/* 已有录音进行中 */
  if(!_vmSupported()){toast('当前浏览器不支持录音');return}
  if(_chatArchMode)return;
  if(!activeFriendId&&apiConfigs.length===0){toast('请先在 API 页面配置密钥');return}
  var _tgt=activeFriendId||(apiConfigs[0]&&apiConfigs[0].id);
  if(_tgt&&_chatSendingFor.has(_tgt)){toast('对方正在回复中，请稍后再发语音');return}
  var st={btn:btn,friendId:_tgt,released:false,chunks:[],transcript:'',interim:'',start:0,timer:null,rec:null,recog:null,recogDone:null,stream:null,mime:'',vt:null,vtOn:false};/* friendId：记录开始录音时的目标对话，发送前校验，防止录音期间切换对话导致语音串发 */
  _vmSt=st;
  try{st.vt=await _vtGet()}catch(e){st.vt=null}
  st.vtOn=_vtOn(st.vt);/* 已配置外部转写：本次录音走转写接口，浏览器内置识别不启动 */
  var stream;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:true})}
  catch(err){if(_vmSt===st)_vmSt=null;toast('无法访问麦克风，请检查浏览器权限');return}
  if(_vmSt!==st||st.released){stream.getTracks().forEach(function(t){t.stop()});if(_vmSt===st)_vmSt=null;return}/* 授权弹窗期间已被再次点按停止 */
  st.stream=stream;
  var mime='';
  try{
    if(MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))mime='audio/webm;codecs=opus';
    else if(MediaRecorder.isTypeSupported('audio/webm'))mime='audio/webm';
    else if(MediaRecorder.isTypeSupported('audio/mp4'))mime='audio/mp4';
  }catch(ex){}
  st.mime=mime||'audio/webm';
  try{st.rec=mime?new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:32000}):new MediaRecorder(stream)}
  catch(ex){try{st.rec=new MediaRecorder(stream);st.mime=st.rec.mimeType||st.mime}catch(e2){stream.getTracks().forEach(function(t){t.stop()});_vmSt=null;toast('录音初始化失败');return}}
  st.rec.ondataavailable=function(ev){if(ev.data&&ev.data.size)st.chunks.push(ev.data)};
  /* 本地语音识别（浏览器内置：Chrome / Edge 可用，Firefox 不支持）——识别失败不影响语音本身的发送；
     已配置外部转写服务时整条浏览器识别通道跳过（其失联/报错提示也随之消失） */
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(SR&&!st.vtOn){
    try{
      var rg=new SR();
      rg.lang=navigator.language||'zh-CN';
      rg.continuous=true;rg.interimResults=true;
      rg.onresult=function(ev){var fin='',inter='';for(var i=0;i<ev.results.length;i++){var r=ev.results[i];if(r.isFinal)fin+=r[0].transcript;else inter+=r[0].transcript}st.transcript=fin;st.interim=inter};
      st.recogDone=new Promise(function(res){rg.onend=function(){res()};rg.onerror=function(ev){st.recogErr=(ev&&ev.error)||'unknown';res()}});
      rg.start();st.recog=rg;
    }catch(ex){st.recog=null}
  }
  st.start=Date.now();
  try{st.rec.start(250)}catch(ex){if(st.recog){try{st.recog.stop()}catch(e3){}}stream.getTracks().forEach(function(t){t.stop()});_vmSt=null;toast('录音启动失败');return}
  btn.classList.add('recording');
  _vmIndicator(true);
  st.timer=setInterval(function(){
    var s=Math.floor((Date.now()-st.start)/1000);
    _vmIndicatorTime(s);
    if(s>=VM_MAX_SEC)_vmFinish(st);/* 到达时长上限：自动停止并发送 */
  },200);
}

/* 删除消息时同步停止该消息语音条的播放 */
function _vmStopForMsgIds(ids){
  if(!_vmPlayingEl)return;
  var pm=_vmPlayingEl.closest?_vmPlayingEl.closest('.chat-msg'):null;
  if(pm&&pm.dataset&&ids.indexOf(pm.dataset.msgId)!==-1){
    try{if(_vmAudio)_vmAudio.pause()}catch(e){}
    _vmPlayingEl.classList.remove('playing');_vmPlayingEl=null;
  }
}

async function _vmFinish(st){
  if(st.released)return;st.released=true;
  if(st.timer){clearInterval(st.timer);st.timer=null}
  st.btn.classList.remove('recording');
  _vmIndicator(false);
  if(!st.rec){_vmSt=null;return}/* 麦克风尚未就绪就被再次点按：授权分支自行收尾 */
  var durMs=Date.now()-st.start;
  var stopped=new Promise(function(res){
    if(st.rec.state==='inactive'){res();return}
    st.rec.onstop=function(){res()};
    try{st.rec.stop()}catch(ex){res()}
  });
  if(st.recog){try{st.recog.stop()}catch(ex){}}
  await stopped;
  if(st.stream)st.stream.getTracks().forEach(function(t){t.stop()});
  var tooShort=durMs<800;
  if(tooShort){
    _vmSt=null;
    toast('说话时间太短');
    return;
  }
  /* 点按模式下录音期间界面可自由操作：发送前校验目标对话未切换、对方未在回复中，避免语音串发或被静默丢弃 */
  var _nowTgt=activeFriendId||(apiConfigs[0]&&apiConfigs[0].id);
  if(st.friendId&&_nowTgt!==st.friendId){_vmSt=null;toast('对话已切换，语音未发送');return}
  if(_nowTgt&&_chatSendingFor.has(_nowTgt)){_vmSt=null;toast('对方正在回复中，语音未发送');return}
  /* 等待识别收尾（上限 1.5 秒），拿到最后一段结果 */
  if(st.recogDone)await Promise.race([st.recogDone,new Promise(function(res){setTimeout(res,1500)})]);
  var transcript=((st.transcript||'')+(st.interim||'')).trim();
  var blob=new Blob(st.chunks,{type:st.mime});
  _vmSt=null;
  if(!blob.size){toast('录音失败，未捕获到音频');return}
  /* 外部转写：配置后文字稿由转写接口产出（本次录音的浏览器识别通道未启动）；失败不拦截发送 */
  if(st.vtOn&&st.vt){
    toast('语音转写中…');
    try{
      var _tx=await _vtTranscribe(st.vt,blob,st.mime);
      if(_tx)transcript=_tx;
      try{console.info('[IB语音转写] 完成，'+(_tx?_tx.length:0)+' 字')}catch(e){}
    }catch(exv){
      try{console.info('[IB语音转写] 失败: '+((exv&&exv.message)||exv))}catch(e){}
      toast('语音转写失败：'+String((exv&&exv.message)||'未知错误').slice(0,140)+'。语音仍将发送（标注未能识别）');
    }
    /* 转写耗时期间可能切换了对话或对方开始回复：重新校验，避免语音串发或被静默丢弃 */
    var _tgt2=activeFriendId||(apiConfigs[0]&&apiConfigs[0].id);
    if(st.friendId&&_tgt2!==st.friendId){toast('对话已切换，语音未发送');return}
    if(_tgt2&&_chatSendingFor.has(_tgt2)){toast('对方正在回复中，语音未发送');return}
  }
  /* 本地声学语气分析（不联网、确定性）：结果定格存入消息，仅发给听不到原声的模型，界面不显示 */
  var _ab=null,_tone='';
  try{_ab=await _vmDecode(blob)}catch(exd){try{console.info('[IB语音语气] 音频解码失败，本条不附带语气特征: '+((exd&&exd.message)||exd))}catch(e){}}
  if(_ab)_tone=_vmToneAnalyze(_ab,transcript);
  /* 无文字稿提醒：仅在「未配置转写 且 当前模型也听不到原声」时提示（转写失败上方已单独提示过） */
  if(!transcript&&!st.vtOn){
    var _cfgV=apiConfigs.find(function(a){return a.id===st.friendId});
    var _nativeV=_cfgV&&_vmAudioNative(_cfgV)&&!(st.vt&&st.vt.direct===false);
    if(!_nativeV){
      if(!(window.SpeechRecognition||window.webkitSpeechRecognition)){if(!_vmNoSrWarned){_vmNoSrWarned=true;toast('当前浏览器不支持语音识别，AI 将无法读取语音内容。可在 API 页面「语音转写」配置外部转写服务解决')}}
      else{
        try{console.info('[IB语音识别] 未获得文字稿。错误码: '+(st.recogErr||'（无错误事件，识别服务未返回任何结果）'))}catch(e){}
        if(!_vmRecogWarned){_vmRecogWarned=true;toast(_vmRecogErrMsg(st.recogErr))}
      }
    }
  }
  var dataUrl;
  try{dataUrl=await new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result)};fr.onerror=rej;fr.readAsDataURL(blob)})}
  catch(ex){toast('录音数据读取失败');return}
  sendChatMessage({dataUrl:dataUrl,mime:st.mime,duration:Math.max(1,Math.round(durMs/1000)),transcript:transcript,tone:_tone,_ab:_ab});
}

function _vmIndicator(show){
  var el=document.getElementById('vm-indicator');
  if(!show){if(el)el.remove();return}
  if(!el){
    el=document.createElement('div');el.id='vm-indicator';
    el.innerHTML='<div class="vm-ind-core"><span class="vm-ind-dot"></span><span class="vm-ind-time">0:00</span></div><div class="vm-ind-hint">点按麦克风按钮停止并发送</div>';
    document.body.appendChild(el);
  }
  _vmIndicatorTime(0);
}
function _vmIndicatorTime(s){var el=document.querySelector('#vm-indicator .vm-ind-time');if(el)el.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}

/* 语音条气泡：宽度随时长增长，点击播放/停止 */
function _buildVoiceEl(v){
  var el=document.createElement('div');
  el.className='chat-voice-bar';
  var d=Math.max(1,Math.round((v&&v.duration)||1));
  el.style.width=Math.min(220,86+d*2.2)+'px';
  el.innerHTML='<span class="vm-arcs"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path class="vm-a1" d="M8.5 9.5a4 4 0 0 1 0 5"/><path class="vm-a2" d="M11.5 7a8 8 0 0 1 0 10"/><path class="vm-a3" d="M14.5 4.5a12.5 12.5 0 0 1 0 15"/></svg></span><span class="vm-dur">'+d+'″</span>';
  el.title='点击播放语音';
  el.onclick=function(ev){ev.stopPropagation();_vmTogglePlay(el,v)};
  return el;
}
function _vmTogglePlay(el,v){
  if(_vmPlayingEl===el&&_vmAudio&&!_vmAudio.paused){try{_vmAudio.pause()}catch(e){}el.classList.remove('playing');_vmPlayingEl=null;return}
  if(_vmAudio){try{_vmAudio.pause()}catch(e){}}
  if(_vmPlayingEl)_vmPlayingEl.classList.remove('playing');
  var au=new Audio(v.dataUrl);
  _vmAudio=au;_vmPlayingEl=el;
  el.classList.add('playing');
  var clear=function(){el.classList.remove('playing');if(_vmPlayingEl===el)_vmPlayingEl=null};
  au.onended=clear;
  au.onerror=function(){clear();toast('语音播放失败')};
  au.play().catch(function(){clear();toast('语音播放失败')});
}


/* ---- 双挂载：其它文件与延迟回调（onclick 模板串）仍经 window 访问；IB.chat.voice 登记导出 ---- */
function ibVoiceLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._vmRecogErrMsg=_vmRecogErrMsg;
window._vmSupported=_vmSupported;
window._voiceApiLine=_voiceApiLine;
window.getVoiceTransSettings=getVoiceTransSettings;
window._vtGet=_vtGet;
window._vtOn=_vtOn;
window._vtUrl=_vtUrl;
window.saveVoiceTransSettings=saveVoiceTransSettings;
window.loadVoiceTransUI=loadVoiceTransUI;
window._vmAudioNative=_vmAudioNative;
window._vtTranscribe=_vtTranscribe;
window._vmDecode=_vmDecode;
window._vmWav16kBase64=_vmWav16kBase64;
window._vmApiAudioWav=_vmApiAudioWav;
window._vmToneAnalyze=_vmToneAnalyze;
window._vmPcmToAudioLike=_vmPcmToAudioLike;
window._vmInit=_vmInit;
window._vmToggle=_vmToggle;
window._vmStart=_vmStart;
window._vmStopForMsgIds=_vmStopForMsgIds;
window._vmFinish=_vmFinish;
window._vmIndicator=_vmIndicator;
window._vmIndicatorTime=_vmIndicatorTime;
window._buildVoiceEl=_buildVoiceEl;
window._vmTogglePlay=_vmTogglePlay;
window.VM_MAX_SEC=VM_MAX_SEC;
ibVoiceLive('_vmSt', function(){return _vmSt}, function(v){_vmSt=v});
ibVoiceLive('_vmAudio', function(){return _vmAudio}, function(v){_vmAudio=v});
ibVoiceLive('_vmNoSrWarned', function(){return _vmNoSrWarned}, function(v){_vmNoSrWarned=v});
ibVoiceLive('_vmRecogWarned', function(){return _vmRecogWarned}, function(v){_vmRecogWarned=v});
ibVoiceLive('_vtCfg', function(){return _vtCfg}, function(v){_vtCfg=v});
ibVoiceLive('_vmACtx', function(){return _vmACtx}, function(v){_vmACtx=v});
ibVoiceLive('_vmPlayingEl', function(){return _vmPlayingEl}, function(v){_vmPlayingEl=v});
NS.expose('chat.voice', {
  _vmRecogErrMsg: _vmRecogErrMsg,
  _vmSupported: _vmSupported,
  _voiceApiLine: _voiceApiLine,
  getVoiceTransSettings: getVoiceTransSettings,
  _vtGet: _vtGet,
  _vtOn: _vtOn,
  _vtUrl: _vtUrl,
  saveVoiceTransSettings: saveVoiceTransSettings,
  loadVoiceTransUI: loadVoiceTransUI,
  _vmAudioNative: _vmAudioNative,
  _vtTranscribe: _vtTranscribe,
  _vmDecode: _vmDecode,
  _vmWav16kBase64: _vmWav16kBase64,
  _vmApiAudioWav: _vmApiAudioWav,
  _vmToneAnalyze: _vmToneAnalyze,
  _vmPcmToAudioLike: _vmPcmToAudioLike,
  _vmInit: _vmInit,
  _vmToggle: _vmToggle,
  _vmStart: _vmStart,
  _vmStopForMsgIds: _vmStopForMsgIds,
  _vmFinish: _vmFinish,
  _vmIndicator: _vmIndicator,
  _vmIndicatorTime: _vmIndicatorTime,
  _buildVoiceEl: _buildVoiceEl,
  _vmTogglePlay: _vmTogglePlay,
  VM_MAX_SEC: VM_MAX_SEC,
  _vmSt: _vmSt,
  _vmAudio: _vmAudio,
  _vmNoSrWarned: _vmNoSrWarned,
  _vmRecogWarned: _vmRecogWarned,
  _vtCfg: _vtCfg,
  _vmACtx: _vmACtx,
  _vmPlayingEl: _vmPlayingEl,
});
})(window.IB || (window.IB = {}));
