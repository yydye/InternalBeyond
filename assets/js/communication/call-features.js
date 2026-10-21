/* Call presentation and conversation records.
   Reuses VoiceCall, chatMessages, apiSettings, callApiChat and Memory approval.
   No separate model runtime, credential store, or chat history is introduced. */
(function(NS){
  'use strict';

  var SETTINGS_ID='callSettings';
  var defaults={id:SETTINGS_ID,on:true,vidSee:'turn',vidQ:'medium',vidSnap:true,vidGift:false,perApi:{}};
  var settings=null;
  var inviteCache=Object.create(null);
  var presented=Object.create(null);
  var summaryBusy=Object.create(null);
  var memoryBusy=Object.create(null);
  var gifts={
    heart:{label:'小心心',icon:'❤️',tier:1,fx:'heart'},
    bouquet:{label:'花束',icon:'💐',tier:2,fx:'bouquet'},
    fireworks:{label:'夏日烟火',icon:'🎆',tier:3,fx:'fireworks'},
    meteor:{label:'流星雨',icon:'🌠',tier:4,fx:'meteor'},
    galaxy:{label:'银河铁道之夜',icon:'🌌',tier:5,fx:'galaxy'}
  };

  function safeText(value,max){
    var text=String(value==null?'':value).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
    return max&&text.length>max?text.slice(0,max):text;
  }
  function withoutSecrets(value){
    if(Array.isArray(value))return value.map(withoutSecrets);
    if(!value||typeof value!=='object')return value;
    var clean={};
    Object.keys(value).forEach(function(key){
      if(/^(?:key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|credentials|private[_-]?key)$/i.test(key))return;
      clean[key]=withoutSecrets(value[key]);
    });
    return clean;
  }
  function cloneSettings(value){
    var result=Object.assign({},defaults,withoutSecrets(value||{}));
    result.id=SETTINGS_ID;
    result.perApi=result.perApi&&typeof result.perApi==='object'?Object.assign({},result.perApi):{};
    result.vidSee=['off','turn','10','30','60'].indexOf(String(result.vidSee))>=0?String(result.vidSee):'turn';
    result.vidQ=['low','medium','high'].indexOf(String(result.vidQ))>=0?String(result.vidQ):'medium';
    return result;
  }
  async function loadSettings(force){
    if(settings&&!force)return settings;
    var row=null;
    try{if(typeof dbGet==='function')row=await dbGet('apiSettings',SETTINGS_ID)}catch(e){}
    settings=cloneSettings(row);
    return settings;
  }
  function peekSettings(){return settings||cloneSettings(null)}
  async function saveSettings(next){
    settings=cloneSettings(next);
    try{
      if(typeof dbPut!=='function')throw new Error('IndexedDB is unavailable');
      await dbPut('apiSettings',settings);
      var verify=await dbGet('apiSettings',SETTINGS_ID);
      if(!verify||verify.id!==SETTINGS_ID)throw new Error('Saved settings could not be verified');
      settings=cloneSettings(verify);
      return {ok:true,settings:settings};
    }catch(error){return {ok:false,error:String(error&&error.message||error)}}
  }
  function currentCall(){
    try{return window.IB&&IB.voiceCall&&IB.voiceCall.getCurrent?IB.voiceCall.getCurrent():null}catch(e){return null}
  }
  function videoSettings(){
    var s=peekSettings(),map={low:{width:320,quality:0.62},medium:{width:512,quality:0.78},high:{width:768,quality:0.86}};
    return Object.assign({interval:s.vidSee},map[s.vidQ]||map.medium);
  }
  function stripControlTags(value){
    return String(value||'')
      .replace(/<ws_(call|vsnap|vgift)\b[^>]*>(?:[\s\S]*?<\/ws_\1\s*>)?/gi,'')
      .replace(/<\/ws_(?:call|vsnap|vgift)\s*>/gi,'')
      .replace(/<ws_(?:call|vsnap|vgift)\b[^>]*$/gim,'')
      .replace(/<\/ws_(?:call|vsnap|vgift)\s*$/gim,'')
      .replace(/\n{3,}/g,'\n\n')
      .trim();
  }
  function createReplyTagFilter(){
    var pending='',dropClose='';
    function emit(final){
      var out='';
      while(pending){
        if(dropClose){
          var close='</'+dropClose;
          var ci=pending.toLowerCase().indexOf(close);
          if(ci<0){
            if(final){pending='';dropClose='';break}
            var keep=Math.min(pending.length,close.length-1);
            pending=pending.slice(-keep);
            break;
          }
          var closeEnd=pending.indexOf('>',ci);
          if(closeEnd<0){if(final){pending='';dropClose=''}else pending=pending.slice(ci);break}
          pending=pending.slice(closeEnd+1);dropClose='';
          continue;
        }
        var lowerPending=pending.toLowerCase(),openAt=lowerPending.indexOf('<ws_'),closeAt=lowerPending.indexOf('</ws_');
        var at=openAt<0?closeAt:(closeAt<0?openAt:Math.min(openAt,closeAt));
        if(at<0){
          if(final){out+=pending;pending='';break}
          var hold=Math.min(pending.length,4);
          if(pending.length>hold){out+=pending.slice(0,-hold);pending=pending.slice(-hold)}
          break;
        }
        if(at>0){out+=pending.slice(0,at);pending=pending.slice(at)}
        if(pending.toLowerCase().indexOf('</ws_')===0){
          var closeMatch=/^<\/ws_(?:call|vsnap|vgift)\s*>/i.exec(pending);
          if(closeMatch){pending=pending.slice(closeMatch[0].length);continue}
          var closeEnd=pending.indexOf('>');
          if(closeEnd<0){if(final)pending='';break}
          out+=pending.charAt(0);pending=pending.slice(1);continue;
        }
        var prefix=pending.slice(0,5).toLowerCase();
        if(prefix.length<5){if(final)pending='';break}
        var matched=/^<ws_(call|vsnap|vgift)\b/i.exec(pending);
        if(!matched){
          if(pending.length<5&&!final)break;
          out+=pending.charAt(0);pending=pending.slice(1);continue;
        }
        var end=pending.indexOf('>');
        if(end<0){if(final){pending='';break}return out}
        var open=pending.slice(0,end+1);
        if(!/\/\s*>$/.test(open))dropClose='ws_'+matched[1].toLowerCase();
        pending=pending.slice(end+1);
      }
      return out;
    }
    return {push:function(chunk){pending+=String(chunk||'');return emit(false)},finish:function(){return emit(true)}};
  }
  function readAttr(attrs,name){
    var re=new RegExp("(?:^|\\s)"+name+"\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))","i");
    var m=re.exec(String(attrs||''));return m?safeText(m[1]||m[2]||m[3]||'',120):'';
  }
  function queueFeedback(roleId,message){
    try{
      var queue=window._wsPendingOpFeedback;
      if(Array.isArray(queue))queue.push({cfgId:String(roleId||''),actor:'IB',text:safeText(message,360)});
    }catch(e){}
  }
  function getRole(roleId){
    var rows=Array.isArray(window.apiConfigs)?window.apiConfigs:[];
    return rows.find(function(row){return String(row&&row.id||'')===String(roleId||'')})||null;
  }
  function callKind(call){return call&&(call.videoMode||call.kind==='video')?'video':'voice'}
  function promptForTurn(turn){
    if(!turn||turn.videoCall!==true)return '';
    var s=peekSettings(),available=turn.videoAvailable===true;
    var lines=['【视频通话】你正在与用户进行视频通话。用户的话以「[视频通话] 」前缀出现。'];
    if(available&&s.vidSee==='off'){
      lines.push('摄像头画面只在本机预览，本轮不会发送画面帧给你；不要猜测画面内容。');
    }else if(available){
      lines.push('本轮若附有图片，那是用户摄像头的一帧；没有图片就不要猜画面内容。可以自然地提起看见的内容，不要逐帧汇报。');
    }else{
      lines.push('本机当前没有可用画面帧。请只进行语音对话，不要推测画面内容。');
    }
    if(available&&s.vidSnap!==false){
      lines.push('想留影时在回复中输出 <ws_vsnap/>；系统会将当前帧存进聊天。每条回复最多一张；没有标签就没有动作，不要口头假装拍过。');
    }else{
      lines.push('当前没有可用留影能力，不要输出 <ws_vsnap/>。');
    }
    if(available&&s.vidGift===true){
      lines.push('【送礼物】可在合适时送出一份虚拟心意，不涉及真实支付。每条回复最多一件：<ws_vgift kind="heart"/> 小心心、kind="bouquet" 花束、kind="fireworks" 夏日烟火、kind="meteor" 流星雨、kind="galaxy" 银河铁道之夜。送礼时说清来由，礼物选择由你决定；没有标签就没有礼物。');
    }
    return lines.join('\n');
  }
  function promptForChat(roleId){
    var s=peekSettings(),role=String(roleId||'');
    if(!role||role.indexOf('group_')===0||s.on===false||!(s.perApi[role]&&s.perApi[role].procall===true))return '';
    return '【主动来电】用户已允许你在必要时主动发起电话；通常使用语音，确有需要看见对方或让对方看见画面时才使用视频。在确有合适理由时，单独输出 <ws_call say="不超过 16 个字的来意"/>，或输出 <ws_call say="不超过 16 个字的来意" kind="video"/> 发起视频来电。每次回复最多一条。只有标签被系统实际接受后才会显示来电卡；不要在文字里假装已经打通。用户接听后进入正常通话，未接听也请尊重用户选择。';
  }
  function createInvite(attrs,opts){
    var say=readAttr(attrs,'say')||readAttr(attrs,'reason');
    var kind=String(readAttr(attrs,'kind')||'voice').toLowerCase()==='video'?'video':'voice';
    return {say:say,kind:kind,status:'pending',createdAt:Date.now(),friendId:String(opts.friendId||''),threadId:String(opts.threadId||'')};
  }
  function normalizeGiftKind(value){var key=String(value||'').toLowerCase();return gifts[key]?key:''}
  async function processAssistantReply(opts){
    opts=opts||{};
    await loadSettings(true);
    var source=String(opts.replyText||''),clean=stripControlTags(source),invite=null;
    var callMatch=/<ws_call\b([^>]*?)\/?>(?:\s*<\/ws_call\s*>)?/i.exec(source);
    var callTurn=opts.callTurn||null;
    var call=currentCall(),s=peekSettings();
    if(callMatch&&!callTurn){
      var requested=createInvite(callMatch[1],opts);
      var reason='';
      if(String(opts.friendId||'').indexOf('group_')===0)reason='群聊不支持主动来电';
      else if(s.on===false||!(s.perApi[String(opts.friendId||'')]&&s.perApi[String(opts.friendId||'')].procall===true))reason='尚未在通话设置中授权此角色主动来电';
      else if(call)reason='当前已有通话正在进行';
      else if(!getRole(opts.friendId))reason='来电角色配置不可用';
      if(reason)queueFeedback(opts.friendId,'来电邀请未执行：'+reason+'。没有显示成功来电卡。');
      else invite=requested;
    }
    if(callTurn&&call&&callKind(call)==='video'){
      var snapMatch=/<ws_vsnap\b[^>]*\/?>(?:\s*<\/ws_vsnap\s*>)?/i.test(source);
      if(snapMatch){
        if(s.vidSnap!==false&&call.videoRuntime&&call.videoRuntime.started&&typeof call.captureSnapshot==='function'){
          var snapResult=await call.captureSnapshot(false);
          if(!snapResult||snapResult.ok!==true){queueFeedback(call.roleId,'视频留影没有保存：当前画面不可用或保存失败；不要声称照片已存档。');try{toast('留影没有保存：当前画面不可用或写入失败')}catch(e){}}
        }else{queueFeedback(call.roleId,'视频留影没有执行：当前是无画面模式或用户已关闭留影。');try{toast('当前没有可留存的视频画面')}catch(e){}}
      }
      var giftMatch=/<ws_vgift\b([^>]*?)\/?>(?:\s*<\/ws_vgift\s*>)?/i.exec(source);
      if(giftMatch){
        var kind=normalizeGiftKind(readAttr(giftMatch[1],'kind'));
        if(s.vidGift===true&&call.videoRuntime&&call.videoRuntime.started&&kind){
          var giftResult=await recordGift(call,kind);
          if(!giftResult||giftResult.ok!==true)try{toast('礼物没有保存到聊天记录')}catch(e){}
        }else queueFeedback(call.roleId,'礼物没有执行：礼物系统未开启、来电没有画面，或礼物种类无效。');
      }
    }
    return {replyText:clean,invite:invite};
  }

  function formatDuration(ms){
    var total=Math.max(0,Math.floor(Number(ms||0)/1000));
    return Math.floor(total/60)+':'+String(total%60).padStart(2,'0');
  }
  function formatGiftKind(kind){
    var gift=gifts[kind]||{label:String(kind||'礼物'),icon:'🎁',tier:0,fx:''};
    var art={bouquet:'assets/communication/gifts/bouquet.webp',fireworks:'assets/communication/gifts/fireworks.webp',meteor:'assets/communication/gifts/meteor.webp',galaxy:'assets/communication/gifts/galaxy.webp'};
    return Object.assign({},gift,{art:art[kind]||''});
  }
  function addDanmaku(call,who,value){
    if(!call||callKind(call)!=='video')return;
    var stage=document.getElementById('voice-call-video'),host=stage&&stage.querySelector('.voice-call-danmaku');
    var text=safeText(value,180);if(!host||!text)return;
    var item=document.createElement('div');item.className='voice-call-danmaku-item'+(who==='me'?' me':'');
    item.textContent=(who==='me'?'你：':'TA：')+text;
    var lane=(Number(host.dataset.callDanmakuLane)||0)%2;host.dataset.callDanmakuLane=String(lane+1);
    item.style.setProperty('--danmaku-y',(lane?44:38).toFixed(1)+'%');
    item.style.setProperty('--danmaku-duration',(7.2+Math.random()*2.2).toFixed(1)+'s');
    host.appendChild(item);
    requestAnimationFrame(function(){try{var stageRect=host.getBoundingClientRect(),itemRect=item.getBoundingClientRect();item.style.setProperty('--danmaku-travel',(-Math.ceil(stageRect.width+itemRect.width+18))+'px')}catch(e){}});
    while(host.children.length>6)host.removeChild(host.firstChild);
    setTimeout(function(){try{item.remove()}catch(e){}},10000);
  }
  function playGiftEffect(call,kind){
    var stage=document.getElementById('voice-call-video'),gift=formatGiftKind(kind);
    if(!stage||!call||!call.videoRuntime||!call.videoRuntime.started)return;
    if(window.IBCallGiftEffects&&typeof window.IBCallGiftEffects.play==='function')window.IBCallGiftEffects.play(stage,kind,gift);
  }
  async function recordGift(call,kind){
    if(!call||!gifts[kind])return {ok:false};
    var row={
      id:'msg_'+Date.now()+'_gift',role:'user',content:'[视频通话礼物：'+gifts[kind].label+']',
      friendId:String(call.roleId||''),timestamp:Date.now(),
      gift:{kind:kind,n:1,by:'ai'},
      metadata:{source:'voice_call_gift',callSessionId:String(call.callSessionId||''),callKind:'video'}
    };
    if(call.conversationId&&String(call.conversationId).indexOf('thread:')===0)row.threadId=String(call.conversationId).slice(7);
    try{
      await dbPut('chatMessages',row);
      call.giftCounts=call.giftCounts||{};
      call.giftCounts[kind]=(call.giftCounts[kind]||0)+1;
      call.giftTotal=(call.giftTotal||0)+1;
      call.transcriptTurns=Number(call.transcriptTurns)||0;
      addDanmaku(call,'ai','送给你一份心意：'+gifts[kind].label);
      playGiftEffect(call,kind);
      appendSpecialRecord(row);
      return {ok:true,row:row};
    }catch(error){
      queueFeedback(call.roleId,'礼物卡未能保存到聊天记录，请不要声称已经送出。');
      return {ok:false,error:String(error&&error.message||error)};
    }
  }
  async function captureAndStoreAiSnapshot(call){
    if(!call||!call.videoRuntime||!call.videoRuntime.started)return {ok:false,error:'no-frame'};
    var frame=null;
    try{frame=await call.videoRuntime.captureFrame({targetWidth:videoSettings().width})}catch(e){}
    if(!frame||!frame.dataUrl)return {ok:false,error:'capture-failed'};
    var row={
      id:'msg_'+Date.now()+'_snap',role:'user',content:'[视频通话快照]',
      friendId:String(call.roleId||''),timestamp:Date.now(),
      images:[{dataUrl:frame.dataUrl,base64:frame.dataUrl.split(',')[1]||'',mime:'image/jpeg',name:'call-snapshot.jpg'}],
      snap:'ai',metadata:{source:'voice_call_snapshot',callSessionId:String(call.callSessionId||''),callKind:'video'}
    };
    if(call.conversationId&&String(call.conversationId).indexOf('thread:')===0)row.threadId=String(call.conversationId).slice(7);
    try{
      await dbPut('chatMessages',row);
      call.snapshotCount=(Number(call.snapshotCount)||0)+1;
      var host=chatContainer(row.friendId,String(row.threadId||''));
      if(host&&typeof window.appendChatBubble==='function')window.appendChatBubble('user',row.content,undefined,undefined,row.id,row.images,undefined,undefined,undefined,undefined,row);
      addDanmaku(call,'ai','拍下了这一刻');
      return{ok:true,row:row}
    }
    catch(error){return{ok:false,error:String(error&&error.message||error)}}
  }
  function callTranscript(sessionId,friendId,threadId){
    if(!String(sessionId||''))return Promise.resolve([]);
    return dbGetByIndex('chatMessages','byFriend',friendId).then(function(rows){
      return (rows||[]).filter(function(row){
        if(!row||!row.metadata||String(row.metadata.callSessionId||'')!==String(sessionId||''))return false;
        if(row.callEnd)return false;
        if(['voice_call','voice_call_gift','voice_call_snapshot'].indexOf(String(row.metadata.source||''))<0)return false;
        return threadId?String(row.threadId||'')===String(threadId):!row.threadId;
      }).sort(function(a,b){return(Number(a.timestamp)||0)-(Number(b.timestamp)||0)});
    });
  }
  function transcriptText(rows,roleName){
    return (rows||[]).map(function(row){
      var speaker=row.gift||row.snap==='ai'?safeText(roleName,48):(row.role==='user'?'用户':safeText(row.senderName||roleName,48));
      if(row.gift){var g=formatGiftKind(row.gift.kind);return speaker+'：（向用户送出礼物：'+g.label+'）'}
      if(row.snap)return speaker+'：（'+(row.snap==='ai'?'拍了一张画面快照':'附带一张画面快照')+'）';
      var content=String(row.content||'').replace(/^\[(?:语音|视频)通话\]\s*/,'');
      return speaker+'：'+safeText(content,1200);
    }).filter(Boolean).join('\n').slice(0,12000);
  }
  async function finishCall(call){
    if(!call||call._callRecordFinished)return null;
    try{if(window.IBCallGiftEffects)window.IBCallGiftEffects.reset(true)}catch(e){}
    call._callRecordFinished=true;
    var sessionId=String(call.callSessionId||''),friendId=String(call.roleId||'');
    var threadId=call.conversationId&&String(call.conversationId).indexOf('thread:')===0?String(call.conversationId).slice(7):'';
    if(!call.connectedAt||!(Number(call.transcriptTurns)>0))return null;
    var giftsSnapshot={total:Number(call.giftTotal)||0,kinds:Object.assign({},call.giftCounts||{})};
    var row={
      id:'msg_'+Date.now()+'_callend',role:'user',
      content:'['+(callKind(call)==='video'?'视频':'语音')+'通话已结束 · 时长 '+formatDuration(Date.now()-call.connectedAt)+' · 共 '+Number(call.transcriptTurns)+' 轮]',
      friendId:friendId,timestamp:Date.now(),
      callEnd:{dur:Math.floor((Date.now()-call.connectedAt)/1000),turns:Number(call.transcriptTurns),video:callKind(call)==='video'?1:0,
        sessionId:sessionId,gifts:giftsSnapshot.total?giftsSnapshot:null,snapshots:Number(call.snapshotCount)||0,endedAt:Date.now()},
      metadata:{source:'voice_call_end',callSessionId:sessionId,callKind:callKind(call)}
    };
    if(threadId)row.threadId=threadId;
    try{
      await dbPut('chatMessages',row);
      appendSpecialRecord(row);
      return row;
    }catch(error){
      try{toast('通话已结束，但结束卡未能保存：'+String(error&&error.message||error).slice(0,80))}catch(e){}
      return null;
    }
  }
  function roleName(roleId){
    var role=getRole(roleId);return safeText(role&&(role.nickname||role.model)||'TA',48)
  }
  function userName(){try{return safeText(window._cachedUserName||'用户',48)}catch(e){return'用户'}}
  async function generateCallSummary(row,button){
    if(!row||!row.callEnd)return;
    if(summaryBusy[row.id])return;
    summaryBusy[row.id]=true;
    if(button){button.disabled=true;button.textContent='正在生成…'}
    try{
      var sessionId=String(row.callEnd.sessionId||''),threadId=String(row.threadId||'');
      var rows=await callTranscript(sessionId,row.friendId,threadId);
      var body=transcriptText(rows,roleName(row.friendId));
      if(!body)throw new Error('这通电话没有可用文字稿');
      var cfg=getRole(row.friendId);
      if(!cfg||typeof window.callApiChat!=='function')throw new Error('找不到这位角色的模型配置');
      var prompt='请根据下面这通电话的原始文字稿，写一段第三人称通话纪要。只记录对话里实际出现的事、约定和情绪，不推测或补充；用双方名字称呼，不写模糊代词。保持自然、简洁，约 100 到 600 字。'+(row.callEnd.gifts&&row.callEnd.gifts.total?' 礼物记录表示角色送给用户的礼物，请写清赠送方向。':'')+
        '\n\n角色：'+roleName(row.friendId)+'\n用户：'+userName()+'\n通话类型：'+(row.callEnd.video?'视频':'语音')+'\n时长：'+formatDuration((Number(row.callEnd.dur)||0)*1000)+'，'+(Number(row.callEnd.turns)||0)+' 轮\n\n【原始文字稿】\n'+body;
      var result=await window.callApiChat(cfg,[{role:'system',content:'你负责整理通话纪要。遵守用户给出的范围，不使用角色聊天记录以外的背景。只输出纪要正文。'},{role:'user',content:prompt}],{
        _ibConsumer:'voice_call_summary',maxTokens:1000,timeoutMs:120000,disableTools:true,_noWebSearch:true
      });
      var text=String(result&&result.text!=null?result.text:result||'').trim().replace(/^["“”]+|["“”]+$/g,'').slice(0,4000);
      if(!text)throw new Error('模型没有返回纪要');
      row.callEnd.summary=text;row.callEnd.summaryAt=Date.now();
      await dbPut('chatMessages',row);
      refreshSpecialRecord(row);
      return {ok:true,summary:text};
    }catch(error){
      row.callEnd.summaryError=safeText(error&&error.message||error,240);
      try{await dbPut('chatMessages',row)}catch(e){}
      refreshSpecialRecord(row);
      return {ok:false,error:row.callEnd.summaryError};
    }finally{delete summaryBusy[row.id]}
  }
  async function memorySaved(row){
    try{
      var all=await dbGetAll('memories');
      return (all||[]).find(function(item){return item&&String(item.rawSource||item.source||'')==='voice_call'&&String(item.sourceId||'')===String(row.id||'')})||null;
    }catch(e){return null}
  }
  async function saveCallMemory(row,button){
    if(!row||!row.callEnd||memoryBusy[row.id])return;
    memoryBusy[row.id]=true;
    if(button){button.disabled=true;button.textContent='准备记忆…'}
    try{
      var existing=await memorySaved(row);
      if(existing){row.callEnd.memoryId=existing.id;row.callEnd.memSaved=true;await dbPut('chatMessages',row);refreshSpecialRecord(row);return}
      var rows=await callTranscript(String(row.callEnd.sessionId||''),row.friendId,String(row.threadId||''));
      var body=transcriptText(rows,roleName(row.friendId));
      if(!body)throw new Error('这通电话没有可用文字稿');
      var cfg=getRole(row.friendId);
      if(!cfg||typeof window._generateMemoryCore!=='function')throw new Error('角色记忆通道未就绪');
      var prompt='你是'+roleName(row.friendId)+'，刚刚和'+userName()+'结束了一通'+(row.callEnd.video?'视频':'语音')+'电话。请以第一人称写成一条具体、自然的角色记忆：记录谈到的事情、约定、时间地点、对方在意之处，以及让你记住的瞬间。只写文字稿里真实出现的内容，不推测，不写成会议摘要，也不要提及数据库。使用你和对方的名字，约 120 到 280 字。\n\n【通话文字稿】\n'+body;
      await window._generateMemoryCore(cfg,prompt,{
        source:'voice_call',sourceId:String(row.id),createdBy:cfg.id,createdByName:roleName(cfg.id),
        titleFallback:'通话记忆 · '+roleName(cfg.id),domainFallback:'日常',
        successPrefix:'通话记忆候选已提交审核'
      });
      var saved=await memorySaved(row);
      if(saved){row.callEnd.memoryId=saved.id;row.callEnd.memSaved=true;await dbPut('chatMessages',row);refreshSpecialRecord(row)}
      else if(button){button.disabled=false;button.textContent='写入角色记忆'}
    }catch(error){
      try{toast('记忆没有保存：'+safeText(error&&error.message||error,120))}catch(e){}
      if(button){button.disabled=false;button.textContent='写入角色记忆'}
    }finally{delete memoryBusy[row.id]}
  }

  function addWrapClass(element,kind,id){
    element.className='ib-call-card-wrap';
    element.dataset.callCard=String(id||'');
    element.dataset.callType=kind;
    return element;
  }
  function iconText(value,className){
    var node=document.createElement('span');node.className=className;node.textContent=value;return node;
  }
  function roleAvatar(roleId,host){
    var role=getRole(roleId),avatar=role&&role.avatar;
    var node=document.createElement('span');node.className='ib-call-card-avatar';
    var src='';
    try{src=window.IBSafeImage&&window.IBSafeImage.normalizeSource?window.IBSafeImage.normalizeSource(avatar):''}catch(e){}
    if(src){var img=document.createElement('img');img.src=src;img.alt='';node.appendChild(img)}
    else node.textContent=roleName(roleId).charAt(0).toUpperCase();
    host.appendChild(node);
  }
  function makeCardBase(kind,id){
    var wrap=addWrapClass(document.createElement('div'),kind,id);
    var card=document.createElement('article');card.className='ib-call-card '+kind;
    wrap.appendChild(card);return {wrap:wrap,card:card};
  }
  function buildInviteCard(row){
    var data=row.callInvite||{},built=makeCardBase('invite',row.id),card=built.card;
    var head=document.createElement('div');head.className='ib-call-card-head';roleAvatar(row.friendId,head);
    var info=document.createElement('div');info.className='ib-call-card-info';
    var name=document.createElement('strong');name.textContent=roleName(row.friendId);
    var type=document.createElement('span');type.textContent=data.kind==='video'?'邀你视频通话':'邀你语音通话';
    info.appendChild(name);info.appendChild(type);head.appendChild(info);card.appendChild(head);
    if(data.say){var say=document.createElement('p');say.className='ib-call-card-say';say.textContent='“'+safeText(data.say,100)+'”';card.appendChild(say)}
    var status=document.createElement('p');status.className='ib-call-card-status';
    var state=String(data.status||'pending');
    var labels={pending:'等你决定',answered:data.kind==='video'&&data.videoUnavailable?'已接听 · 无画面模式':'已接听',declined:'这次未接听',dismissed:'稍后再说',failed:'没有接通'};
    status.textContent=labels[state]||safeText(data.reason||'来电状态已更新',100);card.appendChild(status);
    if(data.status==='pending'){
      var actions=document.createElement('div');actions.className='ib-call-card-actions';
      var decline=document.createElement('button');decline.type='button';decline.textContent='暂不接听';
      decline.addEventListener('click',function(){if(window.IBCallFeatures)window.IBCallFeatures.declineInviteByMessageId(row.id)});
      var accept=document.createElement('button');accept.type='button';accept.className='primary';accept.textContent=data.kind==='video'?'接听视频':'接听';
      accept.addEventListener('click',function(){if(window.IBCallFeatures)window.IBCallFeatures.acceptInviteByMessageId(row.id)});
      actions.appendChild(decline);actions.appendChild(accept);card.appendChild(actions);
    }
    appendDeleteAction(card,row);
    return built.wrap;
  }
  function buildGiftCard(row){
    var gift=row.gift||{},info=formatGiftKind(gift.kind),built=makeCardBase('gift '+(gifts[gift.kind]?'tier-'+info.tier:'tier-1'),row.id),card=built.card;
    var giftIcon=document.createElement('span');giftIcon.className='ib-call-gift-icon';
    if(info.art){var art=document.createElement('img');art.src=info.art;art.alt='';art.draggable=false;giftIcon.appendChild(art)}
    else giftIcon.textContent=info.icon;
    card.appendChild(giftIcon);
    var copy=document.createElement('div');copy.className='ib-call-card-info';
    var title=document.createElement('strong');title.textContent=info.label;
    var meta=document.createElement('span');meta.textContent='视频通话 · '+(gift.by==='ai'?roleName(row.friendId)+' 送给你':'你送给 '+roleName(row.friendId));
    copy.appendChild(title);copy.appendChild(meta);card.appendChild(copy);
    appendDeleteAction(card,row);
    return built.wrap;
  }
  function buildEndCard(row){
    var end=row.callEnd||{},built=makeCardBase('end',row.id),card=built.card;
    var head=document.createElement('div');head.className='ib-call-card-head';roleAvatar(row.friendId,head);
    var info=document.createElement('div');info.className='ib-call-card-info';
    var title=document.createElement('strong');title.textContent=roleName(row.friendId);
    var kind=document.createElement('span');kind.textContent=end.video?'VIDEO CALL · ENDED':'VOICE CALL · ENDED';
    var meta=document.createElement('span');meta.textContent=formatDuration(Number(end.dur||0)*1000)+' · '+Number(end.turns||0)+' 轮'+(Number(end.snapshots)>0?' · 留影 '+Number(end.snapshots):'');
    info.appendChild(title);info.appendChild(kind);info.appendChild(meta);head.appendChild(info);card.appendChild(head);
    if(end.gifts&&Number(end.gifts.total)>0){
      var line=document.createElement('div');line.className='ib-call-gift-summary';
      Object.keys(end.gifts.kinds||{}).forEach(function(key){
        var count=Number(end.gifts.kinds[key])||0;if(!count)return;
        var chip=document.createElement('span');chip.textContent=formatGiftKind(key).icon+' '+formatGiftKind(key).label+' ×'+count;line.appendChild(chip);
      });
      if(line.childNodes.length){var label=document.createElement('span');label.className='label';label.textContent='本次礼物';line.insertBefore(label,line.firstChild);card.appendChild(line)}
    }
    var actions=document.createElement('div');actions.className='ib-call-card-actions end-actions';
    if(!end.memSaved){
      var memory=document.createElement('button');memory.type='button';memory.textContent='写入角色记忆';
      memory.addEventListener('click',function(){saveCallMemory(row,memory)});
      actions.appendChild(memory);
    }else{
      var saved=document.createElement('span');saved.className='ib-call-card-status';saved.textContent='角色记忆已保存';actions.appendChild(saved);
    }
    if(!end.summary){
      var summary=document.createElement('button');summary.type='button';summary.className='primary';summary.textContent=end.summaryError?'重试生成纪要':'生成通话纪要';
      summary.title='使用当前角色模型整理这通电话的文字稿';
      summary.addEventListener('click',function(){generateCallSummary(row,summary)});
      actions.appendChild(summary);
    }else{
      var toggle=document.createElement('button');toggle.type='button';toggle.textContent='通话纪要 ▾';
      var summaryBody=document.createElement('div');summaryBody.className='ib-call-summary-body';summaryBody.hidden=true;summaryBody.textContent=end.summary;
      toggle.addEventListener('click',function(){summaryBody.hidden=!summaryBody.hidden;toggle.textContent=summaryBody.hidden?'通话纪要 ▾':'收起纪要 ▴'});
      card.appendChild(actions);card.appendChild(toggle);card.appendChild(summaryBody);
      appendDeleteAction(card,row);return built.wrap;
    }
    card.appendChild(actions);
    if(end.summaryError){var err=document.createElement('p');err.className='ib-call-card-error';err.textContent='纪要没有生成：'+safeText(end.summaryError,200);card.appendChild(err)}
    appendDeleteAction(card,row);
    return built.wrap;
  }
  function appendDeleteAction(card,row){
    var remove=document.createElement('button');remove.type='button';remove.className='ib-call-card-delete';remove.title='删除这条通话记录';remove.setAttribute('aria-label','删除这条通话记录');remove.textContent='×';
    remove.addEventListener('click',function(){
      if(typeof window.deleteSingleMsg==='function')window.deleteSingleMsg(row.id,card.parentElement).catch(function(){});
      else if(typeof dbDelete==='function')dbDelete('chatMessages',row.id).catch(function(){});
    });
    card.appendChild(remove);
  }
  function renderSpecial(row){
    if(!row)return null;
    if(row.callEnd)return buildEndCard(row);
    if(row.gift)return buildGiftCard(row);
    if(row.callInvite)return buildInviteCard(row);
    return null;
  }
  function snapshotCaption(row){
    var caption=document.createElement('div');caption.className='ib-call-snapshot-caption';
    caption.textContent=row&&row.snap==='ai'?roleName(row.friendId)+' 拍下了这一刻':'视频通话留影';
    return caption;
  }
  function chatContainer(friendId,threadId){
    if(String(window.activeFriendId||'')!==String(friendId||''))return null;
    if(String(window.activeThreadId||'')!==String(threadId||''))return null;
    var ids=window.currentPage==='chat'?['chat-full-messages','chat-messages']:['chat-messages','chat-full-messages'];
    for(var i=0;i<ids.length;i++){var el=document.getElementById(ids[i]);if(el)return el}
    return null;
  }
  function appendSpecialRecord(row){
    var threadId=String(row.threadId||''),host=chatContainer(row.friendId,threadId),card=renderSpecial(row);
    if(!host||!card)return false;
    var existing=host.querySelector('.ib-call-card-wrap[data-call-card="'+String(row.id||'')+'"]');
    if(existing)existing.replaceWith(card);else host.appendChild(card);
    host.scrollTop=host.scrollHeight;
    return true;
  }
  function refreshSpecialRecord(row){
    var host=chatContainer(row.friendId,String(row.threadId||''));if(!host)return;
    var old=host.querySelector('.ib-call-card-wrap[data-call-card="'+String(row.id||'')+'"]'),next=renderSpecial(row);
    if(old&&next)old.replaceWith(next);
  }
  async function findInvite(messageId){
    var cached=inviteCache[String(messageId||'')];
    if(cached)return cached;
    try{
      var row=await dbGet('chatMessages',String(messageId||''));
      if(row&&row.callInvite)return row;
    }catch(e){}
    return null;
  }
  function updateInviteRow(row,status,patch){
    row.callInvite=Object.assign({},row.callInvite||{},patch||{},{status:status,updatedAt:Date.now()});
    return dbPut('chatMessages',row).then(function(){refreshSpecialRecord(row);return row});
  }
  async function answerInviteRow(row){
    if(!row||!row.callInvite||row.callInvite.status!=='pending')return {ok:false,error:'这条来电已经处理'};
    var result=null;
    try{
      result=await window.startVoiceCallFor(String(row.friendId||''),{
        incoming:true,video:row.callInvite.kind==='video',
        conversationId:row.threadId?'thread:'+row.threadId:'main:'+String(row.friendId||''),
        openingMessage:row.callInvite.say||''
      });
    }catch(error){result={ok:false,error:String(error&&error.message||error)}}
    if(result&&result.ok){
      await updateInviteRow(row,'answered',{videoUnavailable:row.callInvite.kind==='video'&&!result.videoStarted});
      queueFeedback(row.friendId,'用户已接听你的'+(row.callInvite.kind==='video'?'视频':'语音')+'来电。');
      return result;
    }
    await updateInviteRow(row,'failed',{reason:safeText(result&&result.error||'通话没有建立',200)});
    queueFeedback(row.friendId,'来电没有接通：'+safeText(result&&result.error||'通话没有建立',200)+'。不要声称通话已开始。');
    return result||{ok:false,error:'通话没有建立'};
  }
  async function declineInviteRow(row,status){
    if(!row||!row.callInvite||row.callInvite.status!=='pending')return false;
    await updateInviteRow(row,status||'declined');
    queueFeedback(row.friendId,status==='dismissed'?'用户选择稍后接听，没有接通。':'用户暂不接听，没有接通。');
    return true;
  }
  function acceptInviteByMessageId(id){return findInvite(id).then(answerInviteRow)}
  function declineInviteByMessageId(id){findInvite(id).then(function(row){declineInviteRow(row,'declined')})}
  function dismissInviteByMessageId(id){findInvite(id).then(function(row){declineInviteRow(row,'dismissed')})}
  function findInviteSync(eventId){return inviteCache[String(eventId||'')]||null}
  function afterMessagePersist(row){
    if(!row||!row.callInvite)return;
    var invite=Object.assign({},row.callInvite);
    invite.eventId=String(row.id||'');
    invite.roleId=String(row.friendId||'');
    invite.roleName=roleName(row.friendId);
    invite.avatar=(getRole(row.friendId)||{}).avatar||'';
    invite.openingMessage=invite.say||'';
    invite.conversationId=row.threadId?'thread:'+row.threadId:'main:'+String(row.friendId||'');
    invite.messageId=String(row.id||'');
    inviteCache[invite.eventId]=row;
    appendSpecialRecord(row);
    if(presented[invite.eventId])return;
    presented[invite.eventId]=true;
    try{if(typeof window.offerIncomingCall==='function')window.offerIncomingCall(invite)}catch(e){}
  }
  function addCallFeaturesToMessageElement(fragment,row){
    if(!fragment||!row)return;
    if(row.callEnd||row.gift){
      while(fragment.firstChild)fragment.removeChild(fragment.firstChild);
      var special=renderSpecial(row);if(special)fragment.appendChild(special);
      return;
    }
    if(row.snap){
      var base=fragment.querySelector&&fragment.querySelector('.chat-msg');
      if(base&&!base.querySelector('.ib-call-snapshot-caption'))base.appendChild(snapshotCaption(row));
    }
    if(row.callInvite){
      var exists=fragment.querySelector&&fragment.querySelector('.ib-call-card-wrap[data-call-card="'+String(row.id||'')+'"]');
      if(!exists){var invite=renderSpecial(row);if(invite)fragment.appendChild(invite)}
    }
  }
  function patchMessageRenderer(){
    if(window.__ibCallRendererPatched||typeof window._buildMsgEl!=='function')return;
    window.__ibCallRendererPatched=true;
    var original=window._buildMsgEl;
    window._buildMsgEl=function(row){
      var fragment=original.apply(this,arguments);
      try{addCallFeaturesToMessageElement(fragment,row)}catch(e){}
      return fragment;
    };
  }

  function insertCallSettingsButton(){
    document.querySelectorAll('.voice-call-launch').forEach(function(launch){
      if(launch.dataset.callSettingsAdded)return;
      launch.dataset.callSettingsAdded='1';
      var button=document.createElement('button');button.type='button';button.className='voice-call-settings-launch';
      button.title='通话设置';button.setAttribute('aria-label','通话设置');
      button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.08-.02a1.7 1.7 0 0 0-1.72.48l-.06.06h-3.4l-.03-.08a1.7 1.7 0 0 0-1.37-1.06l-.09-.01-1.7-2.94.06-.06A1.7 1.7 0 0 0 9.3 15l-.08-.04v-3.4l.08-.03a1.7 1.7 0 0 0 1.06-1.37l.01-.09 2.94-1.7.06.06a1.7 1.7 0 0 0 1.88.34l.06-.03 2.94 1.7-.02.08a1.7 1.7 0 0 0 .48 1.72l.06.06v3.4z"/></svg>';
      button.addEventListener('click',openSettings);
      launch.insertAdjacentElement('afterend',button);
    });
  }
  function settingField(labelText,control){
    var label=document.createElement('label');label.className='ib-call-setting-field';
    var text=document.createElement('span');text.textContent=labelText;label.appendChild(text);label.appendChild(control);return label;
  }
  function settingsDialog(){
    var existing=document.getElementById('voice-call-settings');
    if(existing)return existing;
    var dialog=document.createElement('section');dialog.id='voice-call-settings';dialog.className='ib-call-settings';
    dialog.hidden=true;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','false');dialog.setAttribute('aria-labelledby','voice-call-settings-title');
    var head=document.createElement('header');head.className='ib-call-settings-head';
    var title=document.createElement('strong');title.id='voice-call-settings-title';title.textContent='通话设置';
    var close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','关闭通话设置');close.addEventListener('click',function(){dialog.hidden=true});
    head.appendChild(title);head.appendChild(close);dialog.appendChild(head);
    var body=document.createElement('div');body.className='ib-call-settings-body';body.id='voice-call-settings-body';dialog.appendChild(body);
    var footer=document.createElement('footer');footer.className='ib-call-settings-footer';
    var status=document.createElement('span');status.className='ib-call-settings-status';status.id='voice-call-settings-status';
    var save=document.createElement('button');save.type='button';save.className='primary';save.textContent='保存设置';save.addEventListener('click',saveSettingsFromUi);
    footer.appendChild(status);footer.appendChild(save);dialog.appendChild(footer);document.body.appendChild(dialog);
    return dialog;
  }
  async function openSettings(){
    await loadSettings(true);
    var dialog=settingsDialog(),body=document.getElementById('voice-call-settings-body');
    body.replaceChildren();
    var s=cloneSettings(settings);
    var on=document.createElement('input');on.type='checkbox';on.checked=s.on!==false;on.id='call-setting-on';
    body.appendChild(settingField('启用通话',on));
    var see=document.createElement('select');see.id='call-setting-see';
    [['turn','每轮对话'],['10','每 10 秒'],['30','每 30 秒'],['60','每 60 秒'],['off','不发送画面']].forEach(function(item){var o=document.createElement('option');o.value=item[0];o.textContent=item[1];see.appendChild(o)});
    see.value=s.vidSee;body.appendChild(settingField('视频帧频',see));
    var quality=document.createElement('select');quality.id='call-setting-quality';
    [['low','省流'],['medium','均衡'],['high','清晰']].forEach(function(item){var o=document.createElement('option');o.value=item[0];o.textContent=item[1];quality.appendChild(o)});
    quality.value=s.vidQ;body.appendChild(settingField('画面画质',quality));
    var snap=document.createElement('input');snap.type='checkbox';snap.id='call-setting-snap';snap.checked=s.vidSnap!==false;
    body.appendChild(settingField('允许 TA 留影',snap));
    var gift=document.createElement('input');gift.type='checkbox';gift.id='call-setting-gift';gift.checked=s.vidGift===true;
    body.appendChild(settingField('视频通话礼物',gift));
    var roleSelect=document.createElement('select');roleSelect.id='call-setting-role';
    var rows=Array.isArray(window.apiConfigs)?window.apiConfigs:[];
    rows.forEach(function(role){var option=document.createElement('option');option.value=String(role.id||'');option.textContent=roleName(role.id);roleSelect.appendChild(option)});
    if(!rows.length){var empty=document.createElement('option');empty.value='';empty.textContent='尚无角色 API 配置';roleSelect.appendChild(empty)}
    var roleSetting=document.createElement('div');roleSetting.className='ib-call-role-setting';
    roleSetting.appendChild(settingField('角色',roleSelect));
    var proactive=document.createElement('input');proactive.type='checkbox';proactive.id='call-setting-procall';
    var pcLabel=settingField('允许主动来电',proactive);pcLabel.classList.add('procall-field');roleSetting.appendChild(pcLabel);
    body.appendChild(roleSetting);
    function syncRole(){var pref=s.perApi[roleSelect.value]||{};proactive.checked=pref.procall===true;proactive.disabled=!roleSelect.value}
    roleSelect.addEventListener('change',syncRole);syncRole();
    dialog.hidden=false;
    setTimeout(function(){try{dialog.querySelector('button').focus()}catch(e){}},0);
  }
  async function saveSettingsFromUi(){
    var next=cloneSettings(settings),roleId=String((document.getElementById('call-setting-role')||{}).value||'');
    next.on=!!document.getElementById('call-setting-on').checked;
    next.vidSee=document.getElementById('call-setting-see').value;
    next.vidQ=document.getElementById('call-setting-quality').value;
    next.vidSnap=!!document.getElementById('call-setting-snap').checked;
    next.vidGift=!!document.getElementById('call-setting-gift').checked;
    if(roleId){next.perApi[roleId]=Object.assign({},next.perApi[roleId]||{},{procall:!!document.getElementById('call-setting-procall').checked})}
    var result=await saveSettings(next),status=document.getElementById('voice-call-settings-status');
    if(status)status.textContent=result.ok?'已保存':'保存失败：'+safeText(result.error,120);
    if(result.ok){try{toast('通话设置已保存')}catch(e){}}
  }
  function mountModalControls(){
    var panel=document.querySelector('#voice-call-modal .voice-call-panel');
    if(!panel)return;
    if(!document.getElementById('voice-call-settings-open')){
      var settingsButton=document.createElement('button');settingsButton.id='voice-call-settings-open';settingsButton.type='button';
      settingsButton.className='voice-call-settings-open';settingsButton.title='通话设置';settingsButton.setAttribute('aria-label','通话设置');settingsButton.textContent='⚙';
      settingsButton.addEventListener('click',openSettings);panel.appendChild(settingsButton);
    }
    if(!document.getElementById('voice-call-capture')){
      var controls=panel.querySelector('.voice-call-controls');if(controls){
        var capture=document.createElement('button');capture.id='voice-call-capture';capture.type='button';capture.className='voice-call-control voice-call-capture';
        capture.title='夹入下一句的画面';capture.setAttribute('aria-label','夹入下一句的画面');capture.hidden=true;
        capture.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l2-2h6l2 2h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
        capture.addEventListener('click',function(){var call=currentCall();if(call&&call.captureSnapshot)call.captureSnapshot(true)});
        controls.insertBefore(capture,controls.lastElementChild||null);
      }
    }
    var stage=document.getElementById('voice-call-video');
    if(stage&&!stage.querySelector('.voice-call-danmaku')){var danmaku=document.createElement('div');danmaku.className='voice-call-danmaku';danmaku.setAttribute('aria-live','off');stage.appendChild(danmaku)}
    if(!document.getElementById('voice-call-shot-preview')){
      var preview=document.createElement('div');preview.id='voice-call-shot-preview';preview.className='voice-call-shot-preview';preview.hidden=true;
      var image=document.createElement('img');image.alt='已夹入下一句的画面';
      var caption=document.createElement('span');caption.textContent='画面已夹入下一句';
      var remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.title='取消留影';
      remove.addEventListener('click',function(){var call=currentCall();if(call)call.pendingSnapshot=null;preview.hidden=true});
      preview.appendChild(image);preview.appendChild(caption);preview.appendChild(remove);panel.appendChild(preview);
    }
  }
  function setManualPreview(frame){
    var preview=document.getElementById('voice-call-shot-preview'),image=preview&&preview.querySelector('img');
    if(!preview||!image)return;
    if(frame&&frame.dataUrl){image.src=frame.dataUrl;preview.hidden=false}else{image.removeAttribute('src');preview.hidden=true}
  }
  function attachFeedbackToNextTurn(friendId,messages){
    try{
      var queue=window._wsPendingOpFeedback;
      if(!Array.isArray(queue)||!queue.length||!Array.isArray(messages))return;
      var take=[],keep=[];
      queue.forEach(function(item){if(String(item&&item.cfgId||'')===String(friendId||''))take.push(item);else keep.push(item)});
      if(!take.length)return;
      window._wsPendingOpFeedback=keep;
      for(var i=messages.length-1;i>=0;i--){
        if(messages[i]&&messages[i].role==='user'&&typeof messages[i].content==='string'){
          messages[i].content+='\n\n【上次来电执行结果】\n'+take.map(function(item){return safeText(item.text,360)}).join('\n');
          break;
        }
      }
    }catch(e){}
  }
  function init(){
    patchMessageRenderer();
    insertCallSettingsButton();
    mountModalControls();
    loadSettings(false).catch(function(){});
    document.addEventListener('click',function(){setTimeout(insertCallSettingsButton,0)},true);
  }

  var api={
    settingsId:SETTINGS_ID,loadSettings:loadSettings,saveSettings:saveSettings,peekSettings:peekSettings,
    videoSettings:videoSettings,promptForTurn:promptForTurn,promptForChat:promptForChat,createReplyTagFilter:createReplyTagFilter,
    processAssistantReply:processAssistantReply,afterMessagePersist:afterMessagePersist,
    renderSpecial:renderSpecial,snapshotCaption:snapshotCaption,
    findInviteSync:findInviteSync,acceptInviteByMessageId:acceptInviteByMessageId,
    declineInviteByMessageId:declineInviteByMessageId,dismissInviteByMessageId:dismissInviteByMessageId,
    finishCall:finishCall,captureAndStoreAiSnapshot:captureAndStoreAiSnapshot,addDanmaku:addDanmaku,
    recordGift:recordGift,setManualPreview:setManualPreview,attachFeedbackToNextTurn:attachFeedbackToNextTurn,
    callKind:callKind,formatDuration:formatDuration,mountModalControls:mountModalControls
  };
  window.IBCallFeatures=api;NS.callFeatures=api;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(window.IB||(window.IB={}));
