/* Character voice calls. Audio transport lives here; AI work stays in sendChatMessage.
   Phase 2+:
     - ordered sentence audio queue (seq + done) so a barge-in can truly stop playback
     - streaming protocol: transcript_partial / transcript_final, adapter_reply_sentence
     - explicit state machine (idle/connecting/listening/thinking/speaking/interrupted)
     - reconnect on socket drop, mute/speaker controls */
(function(NS){
'use strict';

var WORKLET_SOURCE="class IBVoiceCapture extends AudioWorkletProcessor{constructor(){super();this.acc=0;this.ratio=sampleRate/16000}process(inputs){var ch=inputs[0]&&inputs[0][0];if(!ch)return true;var out=[];for(var i=0;i<ch.length;i++){this.acc++;if(this.acc>=this.ratio){this.acc-=this.ratio;out.push(ch[i])}}var sum=0;for(var j=0;j<ch.length;j++)sum+=ch[j]*ch[j];var pcm=new Int16Array(out.length);for(var k=0;k<out.length;k++){var v=Math.max(-1,Math.min(1,out[k]));pcm[k]=v<0?v*32768:v*32767}this.port.postMessage({pcm:pcm.buffer,rms:Math.sqrt(sum/Math.max(1,ch.length))},[pcm.buffer]);return true}}registerProcessor('ib-voice-capture',IBVoiceCapture);";

function wsUrl(){
  var base=typeof ibBridgeBase==='function'?ibBridgeBase():'http://127.0.0.1:23115';
  var value=String(base).replace(/^http:/,'ws:').replace(/^https:/,'wss:').replace(/\/+$/,'')+'/voice';
  var access=token();return access?value+'?token='+encodeURIComponent(access):value;
}
function token(){try{return typeof ibBridgeToken==='function'?ibBridgeToken():''}catch(e){return ''}}
function byId(id){return document.getElementById(id)}
function text(el,value){if(el)el.textContent=value}
function safeName(cfg){return String(cfg&&(cfg.nickname||cfg.model)||'AI')}
function b64ToAudioUrl(data,mime){
  var raw=atob(String(data||'')),bytes=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  try{return URL.createObjectURL(new Blob([bytes],{type:mime||'audio/mpeg'}))}catch(e){return ''}
}

const VS_MAX_RECONNECT=5;

function VoiceCall(opts){
  this.roleId=opts.roleId;
  this.conversationId=opts.conversationId;
  this.role=opts.role;
  /* 呼入 / 主动语音呼入代理状态：只反映「呼入邀请 → 接听 → 挂断」阶段；真实语音会话状态仍由 runtime 同步。 */
  this.incoming=!!opts.incoming;
  this.openingMessage=String(opts.openingMessage||'').trim();
  this._pendingEvent=null;
  this.connectedAt=0;this.durationTimer=null;this._wave=[];
  this.ws=null;this.stream=null;this.ctx=null;this.node=null;
  this.state='idle';this.callSessionId='';this.generationId=0;this.asrGeneration=0;this.turnEpoch=0;
  this.speaking=false;this.playing=false;
  this.audioQueue=[];this.currentAudio=null;this.audioUrl='';this.replyDone=false;this.replyEnded=false;
  /* Streaming audio: ordered per-sentence entries, played head-to-toe. */
  this.aEntries=[];this.aIndex=0;this.aPlaying=false;this.playingEntry=null;
  this._mseOk=('MediaSource' in window)&&!!window.MediaSource.isTypeSupported('audio/mpeg');
  this.micMuted=false;this.speakerMuted=false;this.sinkActive=false;
  this.turnId='';this.replyText='';this._t0=0;
  this.noise=0.008;this.hot=0;this.hotSince=0;this.silenceSince=0;this.lastHot=0;
  this.preRoll=[];this.preRollBytes=0;
  this.vad={floor:0.006,gain:3.2,exitRatio:0.62,startHold:3,endSilenceMs:650,bargeInMs:500,speakingGain:2.8};
  this.reconnectTimer=null;this.reconnectAttempts=0;this.destroyed=false;this.reconnecting=false;
  /* 声学语气参考：当前 turn 累积的 Int16 PCM 分片（16kHz 单声道，来自 worklet），
     仅在 onTranscript 分析一次后立即释放；绝不复用跨 turn、绝不持久化。 */
  this._acTurn=[];
  /* P2 · Video Runtime 编排：外部 attachVideo(runtime) 注入；仅在有可用帧且模型可看时
     把帧交给 Communication Runtime（visionReference, request-local）。 */
  this.videoRuntime=null;
}

VoiceCall.prototype.setState=function(state){
  this.state=state;
  var labels={idle:'Idle',incoming:'Incoming',connecting:'Connecting',connected:'Connected',listening:'Listening',thinking:'Thinking',speaking:'Speaking',interrupted:'Interrupted',interrupting:'Interrupting',ending:'Ending',error:'Error',ended:'Call ended'};
  var root=byId('voice-call-modal');if(root)root.dataset.state=state;
  text(byId('voice-call-state'),labels[state]||state);
  /* 通话一旦进入语音活动状态即开始计时；挂断/结束停止。 */
  if(state==='listening'||state==='speaking'||state==='thinking'||state==='connected'){
    if(!this.connectedAt)this.connectedAt=Date.now();
    this._startDuration();
  }
};
VoiceCall.prototype._startDuration=function(){
  var self=this;
  if(this.durationTimer||!this.connectedAt)return;
  var el=byId('voice-call-duration');
  var tick=function(){if(!self.connectedAt)return;var s=Date.now()-self.connectedAt;if(el&&window.IB&&IB.proactiveInteraction)el.textContent=IB.proactiveInteraction.formatDuration(s);};
  tick();
  this.durationTimer=setInterval(tick,1000);
};
VoiceCall.prototype._stopDuration=function(){
  if(this.durationTimer){clearInterval(this.durationTimer);this.durationTimer=null}
};
VoiceCall.prototype.send=function(obj){if(this.ws&&this.ws.readyState===1)this.ws.send(JSON.stringify(obj))};

VoiceCall.prototype.start=async function(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('This browser does not support microphone capture');
  this.setState('connecting');
  try{
    this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false});
  }catch(error){
    if(error&&(/NotAllowed|PermissionDenied/.test(error.name)||error.name==='SecurityError'))throw new Error('Microphone permission was denied. Allow microphone access and try again.');
    if(error&&/NotFound|DevicesNotFound/.test(error.name))throw new Error('No microphone was found');
    throw error;
  }
  var AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw new Error('Web Audio is not supported');
  this.ctx=new AC();await this.ctx.resume();
  /* Load the AudioWorklet from a static same-origin file (works over localhost;
     the opaque file:// origin rejects Blob URL worklets). Fall back to the inline
     Blob for parity. Processor logic is unchanged, so VAD/barge-in/mute are intact. */
  try{await this.ctx.audioWorklet.addModule('assets/js/voice-worklet.js')}
  catch(e){
    var url=URL.createObjectURL(new Blob([WORKLET_SOURCE],{type:'application/javascript'}));
    try{await this.ctx.audioWorklet.addModule(url)}finally{URL.revokeObjectURL(url)}
  }
  var source=this.ctx.createMediaStreamSource(new MediaStream([this.stream.getAudioTracks()[0]]));
  this.node=new AudioWorkletNode(this.ctx,'ib-voice-capture');
  this.node.port.onmessage=this.onCapture.bind(this);
  source.connect(this.node);
  await this.connect(false);
};

VoiceCall.prototype.connect=function(isReconnect){
  var self=this;
  return new Promise(function(resolve,reject){
    if(self.destroyed)return reject(new Error('closed'));
    var settled=false,ws=new WebSocket(wsUrl());ws.binaryType='arraybuffer';self.ws=ws;
    ws.onopen=function(){self.send({type:'hello',token:token()})};
    ws.onerror=function(){if(!settled){settled=true;if(!isReconnect)reject(new Error('Cannot connect to the InternalBeyond Bridge'))}};
    ws.onclose=function(){
      if(!settled){settled=true;if(!isReconnect)reject(new Error('Voice connection closed'));else return}
      if(self.state==='ended'||self.destroyed)return;
      self.setState('error');self.showError('Voice connection lost');
      self.scheduleReconnect();
    };
    ws.onmessage=function(event){
      var msg;try{msg=JSON.parse(event.data)}catch(e){return}
      if(msg.type==='hello_ack'){
        self.send({type:'start',roleId:self.roleId,conversationId:self.conversationId,voice:self.role.voice||{}});
        if(!settled){settled=true;resolve()}
        return;
      }
      self.onMessage(msg);
    };
  });
};

VoiceCall.prototype.scheduleReconnect=function(){
  var self=this;
  if(this.destroyed||this.state==='ended'||this.reconnecting)return;
  if(this.reconnectAttempts>=VS_MAX_RECONNECT){this.setState('error');this.showError('Voice connection could not be re-established');return}
  this.reconnecting=true;
  this.reconnectAttempts++;
  var delay=Math.min(8000,1000*this.reconnectAttempts);
  this.reconnectTimer=setTimeout(async function(){
    self.reconnecting=false;self.setState('connecting');self.showError('');
    try{await self.connect(true);self.reconnectAttempts=0}
    catch(e){self.scheduleReconnect()}
  },delay);
};

/* The worklet posts {pcm:ArrayBuffer, rms:number}; MessagePort delivers it wrapped
   in a MessageEvent, so the payload lives on `.data`. Accept either shape (a bare
   payload keeps direct onCapture() calls and tests working) and normalise pcm to a
   plain ArrayBuffer — ws.send and byteLength both require one. */
function capturePayload(input){
  if(!input||typeof input!=='object')return null;
  if('pcm' in input||'rms' in input)return input;
  var inner=input.data;
  return inner&&typeof inner==='object'?inner:null;
}
function capturePcm(pcm){
  if(pcm instanceof ArrayBuffer)return pcm.byteLength?pcm:null;
  /* Int16Array/Uint8Array etc: take exactly the view's window, not the whole buffer. */
  if(ArrayBuffer.isView(pcm))return pcm.byteLength?pcm.buffer.slice(pcm.byteOffset,pcm.byteOffset+pcm.byteLength):null;
  return null;
}
function describe(value){
  if(value===null)return 'null';
  if(value===undefined)return 'undefined';
  var name=value&&value.constructor&&value.constructor.name;
  return name||typeof value;
}
VoiceCall.prototype._captureWarn=function(reason,detail){
  /* Rate-limited so a persistently bad producer cannot flood the console, but the
     first occurrence of each problem is always reported — never silently dropped. */
  this._captureBad=(this._captureBad||0)+1;
  var n=this._captureBad;
  if(n===1||n===10||n%200===0)console.warn('[IB Voice] dropped capture chunk #'+n+': '+reason+' ('+detail+')');
};

VoiceCall.prototype.onCapture=function(event){
  var data=capturePayload(event);
  if(!data){this._captureWarn('unrecognised capture message',describe(event));return}
  var pcm=capturePcm(data.pcm);
  if(!pcm){this._captureWarn('no usable PCM buffer',describe(data.pcm));return}
  var rms=Number(data.rms);
  if(!isFinite(rms)||rms<0){this._captureWarn('invalid rms',describe(data.rms)+':'+String(data.rms));return}
  var now=performance.now();
  var meter=byId('voice-call-meter-fill');if(meter)meter.style.transform='scaleX('+Math.min(1,rms*14)+')';
  this._wavePush(rms);
  if(!this.speaking){this.preRoll.push(pcm);this.preRollBytes+=pcm.byteLength;while(this.preRollBytes>8000&&this.preRoll.length){this.preRollBytes-=this.preRoll[0].byteLength;this.preRoll.shift()}}
  if(!this.speaking)this.noise=this.noise*0.97+rms*0.03;
  var enter=Math.max(this.vad.floor,this.noise*this.vad.gain)*(this.playing?this.vad.speakingGain:1);
  var exit=enter*this.vad.exitRatio;
  if(rms>enter)this.lastHot=now;
  if(!this.speaking){
    if(rms>enter){
      this.hot++;if(!this.hotSince)this.hotSince=now;
      var hold=this.playing?this.vad.bargeInMs:0;
      if(this.hot>=this.vad.startHold&&now-this.hotSince>=hold)this.speechStart();
    }else{this.hot=0;this.hotSince=0}
    return;
  }
  if(this.ws&&this.ws.readyState===1&&!this.micMuted)this.ws.send(pcm);
  if(!this.micMuted&&typeof this._acTurn==='object'&&this._acTurn)this._acTurn.push(pcm);
  if(rms<exit){if(!this.silenceSince)this.silenceSince=now;else if(now-this.silenceSince>=this.vad.endSilenceMs){this.speechEnd();return}}else this.silenceSince=0;
  if(this.lastHot&&now-this.lastHot>1600)this.speechEnd();
};

VoiceCall.prototype.speechStart=function(){
  if(this.micMuted)return;
  if(this.state==='thinking'||this.state==='speaking'||this.playing)this.interrupt('barge_in');
  this.speaking=true;this.hot=0;this.hotSince=0;this.silenceSince=0;this.lastHot=performance.now();
  /* 开始新 turn：重置声学 PCM 累积，并把 preRoll 一并计入（它属于本次发声前段） */
  this._acTurn=[];
  this.send({type:'speech_start'});
  for(var i=0;i<this.preRoll.length;i++){if(typeof this._acTurn==='object'&&this._acTurn)this._acTurn.push(this.preRoll[i]);if(this.ws&&this.ws.readyState===1)this.ws.send(this.preRoll[i]);}
  this.preRoll=[];this.preRollBytes=0;
  var mic=byId('voice-call-mute');if(mic&&!this.micMuted)mic.classList.add('active');
};
VoiceCall.prototype.speechEnd=function(){
  if(!this.speaking)return;
  this.speaking=false;this.silenceSince=0;this.send({type:'speech_end'});this.setState('thinking');
  var mic=byId('voice-call-mute');if(mic)mic.classList.remove('active');
};

/* 挂载一个 Video Runtime（P2 · 编排）：call 在 turn 里抓帧交给 Communication Runtime。 */
VoiceCall.prototype.attachVideo=function(runtime){this.videoRuntime=runtime||null;return this};

VoiceCall.prototype.interrupt=function(reason){
  this.turnEpoch++;this.asrGeneration++;this.stopAudio();
  if(typeof stopStreaming==='function')try{stopStreaming()}catch(e){}
  this.send({type:'interrupt',reason:reason||'user'});this.setState('interrupted');
};

/* Freeze playback: stop the playing element, empty the sentence queue, release
   MSE source buffers and revoke blob urls so stale audio can never resume. */
VoiceCall.prototype.stopAudio=function(){
  for(var i=0;i<this.aEntries.length;i++){
    var e=this.aEntries[i];
    if(e.mse){try{e.mse.destroy()}catch(_){/*ignore*/}}
    if(e.el){try{e.el.pause()}catch(_){/*ignore*/}}
    if(e.url){try{URL.revokeObjectURL(e.url)}catch(_){/*ignore*/}}
  }
  this.aEntries=[];this.aIndex=0;this.aPlaying=false;this.playingEntry=null;
  if(this.currentAudio){try{this.currentAudio.pause();this.currentAudio.src=''}catch(e){}this.currentAudio=null}
  if(this.audioUrl){try{URL.revokeObjectURL(this.audioUrl)}catch(e){}this.audioUrl=''}
  this.audioQueue=[];this.playing=false;this.replyDone=false;this.replyEnded=false;
};

function b64ToBuf(data){
  var raw=atob(String(data||'')),ab=new ArrayBuffer(raw.length),u8=new Uint8Array(ab);
  for(var i=0;i<raw.length;i++)u8[i]=raw.charCodeAt(i);
  return ab;
}

/* Find-or-create an ordered per-sentence audio entry for the current generation. */
VoiceCall.prototype._findOrCreateEntry=function(msg){
  var gen=Number(msg.generation_id), sid=Number(msg.sentence_id!=null?msg.sentence_id:(msg.seq||0));
  for(var i=0;i<this.aEntries.length;i++) if(this.aEntries[i].generation_id===gen&&this.aEntries[i].sentence_id===sid) return this.aEntries[i];
  var entry={generation_id:gen,sentence_id:sid,mime:msg.mime||'audio/mpeg',chunks:[],blob:null,url:'',done:!!msg.done,mse:null,el:null,error:false,started:false};
  this.aEntries.push(entry);
  return entry;
};

/* Create a per-sentence MediaSource streaming player (true chunk playback). */
VoiceCall.prototype._createMse=function(entry){
  var self=this;
  var ms=new MediaSource();
  var url=URL.createObjectURL(ms);
  var el=new Audio();el.src=url;
  var sb=null,q=[],appending=false;
  function flush(){
    if(!sb||appending||!q.length||ms.readyState!=='open')return;
    appending=true;
    var chunk=q.shift();
    try{sb.appendBuffer(chunk)}catch(e){appending=false;return}
  }
  ms.addEventListener('sourceopen',function(){
    try{sb=ms.addSourceBuffer(entry.mime)}catch(e){entry.error=true;return}
    sb.addEventListener('updateend',function(){appending=false;flush()});
    flush();
  });
  el.addEventListener('ended',function(){self._onEntryEnded(entry)});
  el.addEventListener('error',function(){entry.error=true;self._onEntryEnded(entry)});
  entry.el=el;
  return {
    append:function(ab){if(entry.error)return;if(sb){q.push(ab);flush()}},
    end:function(){if(ms.readyState==='open'){try{ms.endOfStream()}catch(e){/*ignore*/}}},
    play:function(){try{return el.play()}catch(e){return Promise.resolve()}},
    destroy:function(){try{el.pause()}catch(e){}try{el.src=''}catch(e){}try{URL.revokeObjectURL(url)}catch(e){}}
  };
};

VoiceCall.prototype._appendToEntry=function(entry,msg){
  var ab=b64ToBuf(msg.data||'');
  entry.done=entry.done||!!msg.done;
  if(this._mseOk&&/mpeg|webm|opus/.test(entry.mime)){
    if(!entry.mse)entry.mse=this._createMse(entry);
    entry.mse.append(ab);
    if(entry.done)entry.mse.end();
  }else{
    entry.chunks.push(ab);
    if(entry.done)this._assemble(entry);
  }
};

/* Fallback (no MSE): assemble a sentence's chunks into one Blob for playback. */
VoiceCall.prototype._assemble=function(entry){
  if(entry.blob||entry.url)return;
  var parts=entry.chunks,total=0,i;
  for(i=0;i<parts.length;i++)total+=parts[i].byteLength;
  var merged=new Uint8Array(total),off=0;
  for(i=0;i<parts.length;i++){merged.set(new Uint8Array(parts[i]),off);off+=parts[i].byteLength}
  entry.blob=new Blob([merged],{type:entry.mime});
  entry.url=URL.createObjectURL(entry.blob);
  entry.chunks=[];
};

VoiceCall.prototype._onEntryEnded=function(entry){
  if(this.playingEntry===entry)this.playingEntry=null;
  this.aPlaying=false;
  this.aIndex++;
  this._maybePlay();
};

/* Advance the head of the sentence queue; in MSE mode an entry plays live as its
   chunks stream in, so playback can start before the whole sentence arrives. */
VoiceCall.prototype._maybePlay=function(){
  var self=this;
  if(this.aPlaying||this.speakerMuted||this.destroyed)return;
  if(this.aIndex>=this.aEntries.length){
    if((this.replyDone||this.replyEnded)&&this.state!=='ended'&&this.state!=='idle')this.setState('listening');
    return;
  }
  var entry=this.aEntries[this.aIndex];
  if(!entry.mse&&!entry.url&&!entry.done)return;/* fallback entry not ready yet */
  this.aPlaying=true;this.playingEntry=entry;this.setState('speaking');
  if(this._playFirstMs==null&&this._t0)this._playFirstMs=performance.now()-this._t0;
  if(entry.mse){
    if(!entry.started){entry.started=true}
    entry.mse.play();
  }else{
    var audio=new Audio(entry.url);entry.el=audio;
    audio.addEventListener('ended',function(){self._onEntryEnded(entry)});
    audio.addEventListener('error',function(){entry.error=true;self._onEntryEnded(entry)});
    audio.play().catch(function(){entry.error=true;self._onEntryEnded(entry)});
  }
};

VoiceCall.prototype._onAudio=function(msg){
  /* Barge-in / reconnect guard: any chunk from a stale generation is dropped. */
  if(Number(msg.generation_id)!==Number(this.generationId))return;
  if(this._audioFirstMs==null&&this._t0)this._audioFirstMs=performance.now()-this._t0;
  var entry=this._findOrCreateEntry(msg);
  this._appendToEntry(entry,msg);
  this.replyDone=this.replyDone||!!msg.done;
  this._maybePlay();
};

VoiceCall.prototype._sendMetrics=function(){
  /* Debug-gated latency report; never spams the console unless enabled. */
  var dbg=false;try{dbg=localStorage.getItem('ib_voice_debug')==='1'}catch(e){}
  if(!dbg)return;
  this.send({type:'metrics',asr_final_ms:0,model_first_token_ms:Math.round(this._modelFirstMs||0),tts_first_chunk_ms:Math.round(this._audioFirstMs||0),audio_first_play_ms:Math.round(this._playFirstMs||0)});
};

/* 声学语气参考（request-local）：把当前 turn 累积的 Int16 PCM + transcript 交给
   现有 voice.js::_vmPcmToAudioLike / _vmToneAnalyze，得出语气描述句。
   - 仅当非 audio-native 模型（_vmAudioNative(cfg) 为真或 cfg.audioInput===true 则跳过）时产出；
   - 无 PCM / 静音 / 过短（_vmToneAnalyze 返回空）→ 返回 ''，不伪造；
   - 纯函数、只服务于这一次 request；结果由调用方在 onTranscript 及时使用后丢弃。
   不复制 _vmToneAnalyze 算法；不持久化任何音频。 */
function _acousticReferenceFor(roleCfg,chunks,transcript){
  try{
    if(typeof window._vmPcmToAudioLike!=='function'||typeof window._vmToneAnalyze!=='function')return '';
    if(!chunks||!chunks.length)return '';
    var n=0,i;for(i=0;i<chunks.length;i++)n+=(chunks[i]&&chunks[i].byteLength)||0;
    if(!n)return '';
    var all=new Int16Array(n/2),off=0;
    for(i=0;i<chunks.length;i++){var seg=new Int16Array(chunks[i]);all.set(seg,off);off+=seg.length;}
    var ab=window._vmPcmToAudioLike(all,16000);
    var tone=window._vmToneAnalyze(ab,transcript)||'';
    if(!tone)return '';
    var native=(typeof window._vmAudioNative==='function')?!!window._vmAudioNative(roleCfg):false;
    if(native||(roleCfg&&roleCfg.audioInput===true))return '';
    return tone;
  }catch(e){return ''}
}

VoiceCall.prototype.onTranscript=async function(msg){
  var epoch=++this.turnEpoch;
  this._t0=performance.now();
  this.turnId=msg.turn_id||this.turnId;
  this.replyText='';text(byId('voice-call-reply'),'');
  text(byId('voice-call-transcript'),msg.text||'');
  /* 声学语气参考：对本次 turn 分析一次，立即释放；acousticReference 只用于本次 request */
  var _acref=_acousticReferenceFor(this.role,this._acTurn,String(msg.text||''));
  this._acTurn=[];
  /* P2 · Vision 帧：若挂载了 Video Runtime 且正在运行，抓一帧转成 request-local visionReference；
     无可用帧时为空（不影响）。帧只进本次 request，绝不持久化。 */
  var _visionRef=null;
  if(this.videoRuntime&&typeof this.videoRuntime.captureFrame==='function'&&this.videoRuntime.started){
    try{_visionRef=await this.videoRuntime.captureFrame({targetWidth:512});}catch(e){_visionRef=null;}
  }
  try{
    var result=await sendChatMessage({voiceCall:true,transcript:String(msg.text||''),acousticReference:_acref,visionReference:_visionRef,callSessionId:this.callSessionId,turnId:this.turnId,roleId:this.roleId,conversationId:this.conversationId});
    if(epoch!==this.turnEpoch||this.state==='ended')return;
    if(!result||!result.ok)throw new Error(result&&result.error||'The character did not return a reply');
    if(result.voiceStreamed)return;/* 语句已随流式推送，避免二次提交 */
    this.send({type:'adapter_reply',turn_id:this.turnId,text:result.replyText});
  }catch(error){if(epoch===this.turnEpoch){this.showError(String(error&&error.message||error));this.send({type:'adapter_reply',turn_id:this.turnId,text:''})}}
};

/* Streaming model tap target: called by communication.js as clean sentences arrive. */
VoiceCall.prototype.pushSentence=function(text,done){
  if(this.destroyed||this.state==='ended'||!this.turnId)return;
  var t=String(text||'').trim();
  if(this._modelFirstMs==null&&this._t0)this._modelFirstMs=performance.now()-this._t0;
  if(t){this.sinkActive=true;this.replyText+=t;text(byId('voice-call-reply'),this.replyText)}
  this.send({type:'adapter_reply_sentence',turn_id:this.turnId,text:t,done:!!done});
};

VoiceCall.prototype._wavePush=function(rms){
  this._wave.push(Number(rms)||0);
  if(this._wave.length>36)this._wave.shift();
  this._renderWave();
};
VoiceCall.prototype._renderWave=function(){
  var box=byId('voice-call-wave');if(!box)return;
  var bars=box.children,n=bars.length;
  if(!n)return;
  for(var i=0;i<n;i++){
    var v=this._wave[Math.floor(i*this._wave.length/n)]||0;
    var h=Math.max(0.10,Math.min(1,0.22+Math.min(1,(v||0)*14)));
    try{bars[i].style.animation='none';bars[i].style.transform='scaleY('+h.toFixed(3)+')'}catch(e){}
  }
};

VoiceCall.prototype.onMessage=function(msg){
  if(msg.type==='call_started'){
    this.callSessionId=msg.call_session_id||msg.callSessionId||'';
    if(!this.connectedAt)this.connectedAt=Date.now();
    this._startDuration();
    if(msg.asr&&msg.asr.configured===false)this.showError('Bridge ASR is not configured');
    if(this.openingMessage){this.send({type:'greeting',turn_id:'greeting',text:this.openingMessage});this.openingMessage='';}
    return
  }
  if(msg.type==='state'){if(!(msg.mode==='listening'&&this.playing))this.setState(msg.mode||this.state);return}
  if(msg.type==='speech_start'){this.asrGeneration=Number(msg.generation_id)||this.asrGeneration;return}
  if(msg.type==='transcript_final'){
    if(Number(msg.generation_id)===Number(this.asrGeneration)||msg.generation_id==null){this.onTranscript(msg)}return;
  }
  if(msg.type==='transcript_partial'){
    if(Number(msg.generation_id)===Number(this.asrGeneration)||msg.generation_id==null){text(byId('voice-call-transcript'),msg.text||'');}return;
  }
  if(msg.type==='reply_text'){this.generationId=Number(msg.generation_id)||0;if(!this.sinkActive)this.replyText=String(msg.text||'');text(byId('voice-call-reply'),this.replyText);if(!this.playing)this.setState('speaking');return}
  if(msg.type==='audio'){this._onAudio(msg);return}
  if(msg.type==='interrupted'){this.generationId=Number(msg.next_generation_id)||this.generationId+1;this.stopAudio();this.sinkActive=false;this.setState('interrupted');return}
  if(msg.type==='generation_end'){if(Number(msg.generation_id)===Number(this.generationId)){this.sinkActive=false;this._sendMetrics();if(!this.playing){this.setState('listening')}else{this.replyEnded=true}}return}
  if(msg.type==='nothing_heard'){this.sinkActive=false;text(byId('voice-call-transcript'),'No speech detected');this.setState('listening');return}
  if(msg.type==='hangup'){this.finish();return}
  if(msg.type==='error'){this.showError(msg.error||'Voice call failed');if(msg.stage==='asr'||msg.stage==='tts')this.setState('error')}
};
VoiceCall.prototype.showError=function(message){var el=byId('voice-call-error');if(el)el.textContent=message||'';if(el)el.hidden=!message};

VoiceCall.prototype.toggleMute=function(){
  this.micMuted=!this.micMuted;
  var btn=byId('voice-call-mute');if(btn){btn.classList.toggle('muted',this.micMuted);btn.title=this.micMuted?'Unmute microphone':'Mute microphone';btn.setAttribute('aria-label',btn.title)}
  if(this.micMuted){this.speechEnd();var mic=byId('voice-call-mute');if(mic)mic.classList.remove('active')}
};
VoiceCall.prototype.toggleSpeaker=function(){
  this.speakerMuted=!this.speakerMuted;
  var btn=byId('voice-call-speaker');if(btn)btn.classList.toggle('speaker-off',this.speakerMuted);
  text(byId('voice-call-speaker'),this.speakerMuted?'\u2605':'');
  if(this.speakerMuted)this.stopAudio();
  else this._maybePlay();
};
VoiceCall.prototype.hangup=function(){this.send({type:'hangup'});this.finish()};
VoiceCall.prototype.release=function(){
  this.turnEpoch++;this.stopAudio();this.speaking=false;this._stopDuration();
  if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=null}
  if(this.node){try{this.node.disconnect()}catch(e){}this.node=null}
  if(this.stream){this.stream.getTracks().forEach(function(track){track.stop()});this.stream=null}
  if(this.ctx){try{this.ctx.close()}catch(e){}this.ctx=null}
  if(this.ws){try{this.ws.close(1000,'hangup')}catch(e){}this.ws=null}
  if(this.videoRuntime&&typeof this.videoRuntime.free==='function'){try{this.videoRuntime.free()}catch(e){}this.videoRuntime=null}
};
VoiceCall.prototype.finish=function(){
  this.destroyed=true;
  this.release();
  this.setState('ended');setTimeout(closeVoiceCall,280);
};

var current=null;
var _voiceCallOpener=null;  /* Focus restoration anchor: the element that opened the modal */
var _incomingCallOpener=null;  /* Focus anchor for the incoming call overlay */
/* ── P2 · Call modal 视频面 UI：注入相机开关 + 视频预览（不碰 .voice-call-controls）── */
function _toggleVideoSurface(call){
  var modal=byId('voice-call-modal');if(!modal)return;
  var stage=modal.querySelector('#voice-call-video');
  var cam=modal.querySelector('#voice-call-cam');
  if(call&&call.videoRuntime&&call.videoRuntime.started){
    if(call.videoRuntime.free){try{call.videoRuntime.free()}catch(e){}}
    call.videoRuntime=null;
    if(stage)stage.hidden=true;
    if(cam)cam.classList.remove('on');
    return;
  }
  var vid=modal.querySelector('#voice-call-video-el');
  if(!vid){vid=document.createElement('video');vid.id='voice-call-video-el';vid.muted=true;vid.playsInline=true;vid.autoplay=true;}
  if(!call.videoRuntime){try{call.videoRuntime=window.IBVideoRuntime.createVideoRuntime({videoHost:vid,targetWidth:512});}catch(e){try{toast('视频运行时不可用')}catch(x){};return}}
  try{call.videoRuntime.start().then(function(){if(stage){stage.hidden=false;}if(cam){cam.classList.add('on');}}).catch(function(e){if(call&&call.videoRuntime){try{call.videoRuntime.free()}catch(x){}}call.videoRuntime=null;try{toast('无法开启相机：'+String(e&&e.message||e).slice(0,80))}catch(x){}});}catch(e){if(call&&call.videoRuntime){try{call.videoRuntime.free()}catch(x){}}call.videoRuntime=null;try{toast('无法开启相机')}catch(x){}}
}
function _mountCallVideoSurface(call){
  try{
    var modal=byId('voice-call-modal');if(!modal)return;
    if(modal.querySelector('#voice-call-video'))return;/* 幂等 */
    var panel=modal.querySelector('.voice-call-panel')||modal;
    var stage=document.createElement('div');stage.className='voice-call-video';stage.id='voice-call-video';stage.hidden=true;
    var vid=document.createElement('video');vid.id='voice-call-video-el';vid.muted=true;vid.playsInline=true;vid.autoplay=true;
    stage.appendChild(vid);
    var controls=modal.querySelector('.voice-call-controls');
    if(controls){panel.insertBefore(stage,controls);}else{panel.appendChild(stage);}
    var cam=document.createElement('button');cam.type='button';cam.className='voice-call-cam';cam.id='voice-call-cam';cam.textContent='\u25c9';cam.title='开启/关闭视频';cam.setAttribute('aria-label','开启或关闭视频');
    var nameEl=byId('voice-call-role-name');if(nameEl){nameEl.parentNode.insertBefore(cam,nameEl);}else{panel.appendChild(cam);}
    cam.onclick=function(){_toggleVideoSurface(call);return false;};
  }catch(e){}
}
/* 以指定角色开一次语音通话（outgoing，或由主动呼入 accept 后进入）。 */
async function startVoiceCallFor(roleId,opts){
  opts=opts||{};
  if(current){if(opts.incoming)toast('已有一通通话进行中');return}
  if(String(roleId).indexOf('group_')===0){toast('Voice calls currently support one character at a time');return}
  var role=(apiConfigs||[]).find(function(item){return String(item.id)===String(roleId)})||(typeof archivedConfigs!=='undefined'?(archivedConfigs||[]).find(function(item){return String(item.id)===String(roleId)}):null);
  if(!role){toast('The selected character is unavailable');return}
  var modal=byId('voice-call-modal');if(!modal)return;
  /* Capture the element that triggered the modal for focus restoration on close. */
  if(!_voiceCallOpener&&document.activeElement&&document.activeElement!==document.body)_voiceCallOpener=document.activeElement;
  modal.hidden=false;modal.setAttribute('aria-hidden','false');
  var err=byId('voice-call-error');if(err){err.hidden=true;err.textContent=''}
  text(byId('voice-call-role-name'),safeName(role));text(byId('voice-call-transcript'),'');text(byId('voice-call-reply'),'');
  var dur=byId('voice-call-duration');if(dur)dur.textContent='0:00';
  var wave=byId('voice-call-wave');if(wave){wave.innerHTML='';for(var w=0;w<32;w++){var bar=document.createElement('span');bar.className='voice-call-wave-bar';wave.appendChild(bar)}}
  var avatar=byId('voice-call-avatar');if(avatar){avatar.innerHTML='';var av=opts.avatar||role.avatar;if(av){var img=document.createElement('img');img.src=av;img.alt='';avatar.appendChild(img)}else avatar.textContent=safeName(role).charAt(0).toUpperCase()}
  var conversationId=opts.conversationId||(activeThreadId?('thread:'+activeThreadId):('main:'+String(roleId)));
  /* Move focus to the first control (mute button) after the modal opens, so keyboard
     navigation works and screen readers announce the modal's purpose. */
  window.setTimeout(function(){var btn=byId('voice-call-mute');if(btn)try{btn.focus()}catch(e){}},0);
  current=new VoiceCall({roleId:String(roleId),conversationId:conversationId,role:role,incoming:!!opts.incoming,openingMessage:opts.openingMessage||''});
  _mountCallVideoSurface(current);/* P2 · 视频面 UI（可切换预览 + 相机开关；不碰 .voice-call-controls 计数） */
  try{await current.start()}catch(error){current.showError(String(error&&error.message||error));current.setState('error');current.release()}
}
async function startVoiceCall(){
  if(current)return;
  if(typeof activeFriendId==='undefined'||!activeFriendId){toast('Please select a character first');return}
  await startVoiceCallFor(String(activeFriendId),{})
}
/* ── 主动语音呼入：来电卡片（参考「AI 主动发起联系」）── */
function _findInteractionEvent(eventId){
  try{if(typeof window._activeInteractionList==='function')return (window._activeInteractionList()).find(function(e){return e.eventId===eventId})||null}catch(e){}
  return null
}
function _markInteraction(eventId,status){
  try{if(typeof window._activeUpdateInteraction==='function')window._activeUpdateInteraction(eventId,{status:status,actedAt:new Date().toISOString()})}catch(e){}
}
function _resolvePlan(planId,outcome){
  try{if(typeof window._activeResolveVoiceCallPlan==='function')window._activeResolveVoiceCallPlan(planId,outcome)}catch(e){}
}
/* 弹出呼入卡片：avatar / 角色 / 开场词 / 接听 / 拒绝。由主动语音呼入计划调用。 */
function offerIncoming(event){
  var ev=event&&typeof event==='object'?event:{};
  try{
    if(current){return}/* 已在通话中：忽略新的来电（失败静默，不打扰通话） */
    var overlay=byId('incoming-call-overlay');if(!overlay)return;
    /* Capture focus anchor for restoration when the overlay closes. */
    if(!_incomingCallOpener&&document.activeElement&&document.activeElement!==document.body)_incomingCallOpener=document.activeElement;
    text(byId('incoming-call-role-name'),ev.roleName||'AI');
    text(byId('incoming-call-msg'),ev.openingMessage||'');
    text(byId('incoming-call-reason'),ev.reason||'');
    var avatar=byId('incoming-call-avatar');
    if(avatar){avatar.innerHTML='';if(ev.avatar){var img=document.createElement('img');img.src=ev.avatar;img.alt='';avatar.appendChild(img)}else avatar.textContent=(ev.roleName||'A').charAt(0).toUpperCase()}
    overlay.hidden=false;overlay.setAttribute('aria-hidden','false');
    overlay.dataset.eventId=ev.eventId||'';
    /* Move focus to the accept button so the overlay is keyboard-navigable. */
    window.setTimeout(function(){var btn=overlay.querySelector('.incoming-call-accept');if(btn)try{btn.focus()}catch(e){}},0);
  }catch(e){}
}
function _hideIncoming(){
  var overlay=byId('incoming-call-overlay');
  if(overlay){
    /* Restore focus before hiding the incoming call overlay. */
    if(_incomingCallOpener&&document.contains(_incomingCallOpener)&&typeof _incomingCallOpener.focus==='function'){
      try{_incomingCallOpener.focus()}catch(e){}
    }else if(document.body){
      try{document.body.focus()}catch(e){}
    }
    _incomingCallOpener=null;
    overlay.hidden=true;overlay.setAttribute('aria-hidden','true');
  }
}
function acceptIncoming(eventId){
  var ev=_findInteractionEvent(eventId)||{eventId:eventId};
  if(ev.eventId)_markInteraction(ev.eventId,'accepted');
  if(ev.planId)_resolvePlan(ev.planId,'accepted');
  _hideIncoming();
  var roleId=ev.roleId;if(!roleId){toast('来电角色信息缺失');return}
  startVoiceCallFor(String(roleId),{incoming:true,openingMessage:ev.openingMessage||ev.openingLine||'',conversationId:(ev.callMeta&&ev.callMeta.conversationId)||('main:'+roleId),avatar:ev.avatar||''})
}
function declineIncoming(eventId){
  var ev=_findInteractionEvent(eventId)||{eventId:eventId};
  if(ev.eventId)_markInteraction(ev.eventId,'declined');
  if(ev.planId)_resolvePlan(ev.planId,'declined');
  _hideIncoming();toast('已拒绝本次来电')
}
function dismissIncoming(eventId){
  var ev=_findInteractionEvent(eventId)||{eventId:eventId};
  if(ev.eventId)_markInteraction(ev.eventId,'dismissed');
  if(ev.planId)_resolvePlan(ev.planId,'dismissed');
  _hideIncoming()
}
function interruptVoiceCall(){if(current)current.interrupt('button')}
function toggleVoiceMute(){if(current)current.toggleMute()}
function toggleVoiceSpeaker(){if(current)current.toggleSpeaker()}
function hangupVoiceCall(){if(current)current.hangup();else closeVoiceCall()}
function closeVoiceCall(){
  var modal=byId('voice-call-modal');
  if(modal){
    /* Before hiding the modal, restore focus to the element that opened it (if still
       in the document and focusable) or to a safe fallback. This prevents focus from
       being trapped in an aria-hidden tree, which triggers browser accessibility warnings. */
    if(_voiceCallOpener&&document.contains(_voiceCallOpener)&&typeof _voiceCallOpener.focus==='function'){
      try{_voiceCallOpener.focus()}catch(e){}
    }else{
      /* Fallback: move focus to body or the first visible voice-call-launch button. */
      var fallback=document.querySelector('.voice-call-launch:not([hidden])');
      if(fallback)try{fallback.focus()}catch(e){}
      else if(document.body)try{document.body.focus()}catch(e){}
    }
    _voiceCallOpener=null;
    modal.hidden=true;modal.setAttribute('aria-hidden','true');
  }
  current=null;
}

window.startVoiceCall=startVoiceCall;window.startVoiceCallFor=startVoiceCallFor;window.interruptVoiceCall=interruptVoiceCall;window.hangupVoiceCall=hangupVoiceCall;
window.toggleVoiceMute=toggleVoiceMute;window.toggleVoiceSpeaker=toggleVoiceSpeaker;
window.offerIncomingCall=offerIncoming;window.acceptIncomingCall=acceptIncoming;window.declineIncomingCall=declineIncoming;window.dismissIncomingCall=dismissIncoming;
window._acousticReferenceFor=_acousticReferenceFor;
window._mountCallVideoSurface=_mountCallVideoSurface;
NS.expose('voiceCall',{start:startVoiceCall,startFor:startVoiceCallFor,interrupt:interruptVoiceCall,hangup:hangupVoiceCall,toggleMute:toggleVoiceMute,toggleSpeaker:toggleVoiceSpeaker,offerIncoming:offerIncoming,acceptIncoming:acceptIncoming,declineIncoming:declineIncoming,dismissIncoming:dismissIncoming,VoiceCall:VoiceCall,getCurrent:function(){return current}});
})(window.IB || (window.IB = {}));
