/* Internal Beyond · Cinema helpers — privacy-preserving media identity and bounded resume. */
(function(root){
  'use strict';

  function legacyHash(value){
    var h=0,s=String(value||'');
    for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;
    return String(Math.abs(h));
  }

  function stableHash(value){
    var s=String(value||''),a=2166136261,b=5381;
    for(var i=0;i<s.length;i++){
      a=Math.imul(a^s.charCodeAt(i),16777619)>>>0;
      b=(Math.imul(b^s.charCodeAt(i),2246822519)>>>0);
    }
    return a.toString(36)+'-'+b.toString(36);
  }

  function mediaIdentity(media,title){
    media=media||{};
    var provider=String(media.provider||'unknown');
    var url=String(media.url||'');
    var id=String(media.id||'');
    var legacyResourceId='cin_'+legacyHash(String(title||'')+'|'+url+'|'+id);
    if(provider!=='local')return{resourceId:legacyResourceId,legacyResourceId:legacyResourceId,provider:provider,fileName:''};
    var file=media.caps&&media.caps.file||{};
    var name=String(file.name||id||title||'local-video').slice(0,240);
    /* resolveMedia(local) historically sets url=''; preserve that exact legacy key for migration. */
    legacyResourceId='cin_'+legacyHash(String(title||'')+'||'+String(id||name));
    var size=Math.max(0,Number(file.size)||0);
    var lastModified=Math.max(0,Number(file.lastModified)||0);
    var type=String(file.type||'').slice(0,80);
    var fingerprint=[name,size,lastModified,type].join('\u001f');
    return{
      resourceId:'cin_v2_local_'+stableHash(fingerprint),
      legacyResourceId:legacyResourceId,
      provider:provider,
      fileName:name,
      fileFingerprint:stableHash(fingerprint)
    };
  }

  function resumePoint(progress,duration,canSeek){
    progress=progress||{};
    if(canSeek===false||progress.noTime===true)return null;
    var sec=Number(progress.sec),dur=Number(duration)||Number(progress.dur)||0;
    if(!isFinite(sec)||sec<1.5)return null;
    if(dur>0){
      var endMargin=Math.max(0.5,Math.min(3,dur*0.03));
      if(sec>=dur-endMargin)return null;
      sec=Math.min(sec,dur-endMargin);
    }
    return Math.max(0,sec);
  }

  function recapSegment(subtitles,fromSec,toSec,maxWindowSeconds,maxChars){
    var from=Math.max(0,Number(fromSec)||0),to=Math.max(from,Number(toSec)||from);
    var windowSeconds=Math.max(60,Math.min(900,Number(maxWindowSeconds)||900));
    var end=Math.min(to,from+windowSeconds),limit=Math.max(800,Math.min(8000,Number(maxChars)||6000));
    var rows=Array.isArray(subtitles)?subtitles:[],lines=[],used=0,truncated=false;
    for(var i=0;i<rows.length;i++){
      var cue=rows[i]||[],start=Number(cue[0])||0,finish=Number(cue[1])||start,text=String(cue[2]||'').replace(/\s+/g,' ').trim();
      if(!text||start<from||start>end||finish<=from)continue;
      var line='['+Math.floor(start)+'s] '+text;
      if(used+line.length+1>limit){truncated=true;break}
      lines.push(line);used+=line.length+1;
    }
    return{fromSec:from,toSec:end,lines:lines,truncated:truncated,text:lines.join('\n')};
  }

  function buildRecapPrompt(input){
    input=input||{};
    var segment=input.segment||{},text=String(segment.text||'').trim();
    if(!text)return'';
    var old=String(input.previousRecap||'').trim().slice(0,800);
    return '【观影前情整理】你正在和用户一起看《'+String(input.title||'未命名视频').slice(0,160)+'》。请把已有梗概与下面这段新增字幕合并为一段不超过 350 字的连贯剧情梗概。重点保留人物、目标、冲突与因果，不逐句改写台词；只总结到 '+Math.floor(Number(segment.toSec)||0)+' 秒，不预告后续剧情。若字幕信息不足或存在歧义，请保留不确定性。\n'
      +(old?'［已有梗概］\n'+old+'\n':'')
      +'［新增字幕 '+Math.floor(Number(segment.fromSec)||0)+'–'+Math.floor(Number(segment.toSec)||0)+' 秒］\n'+text
      +(segment.truncated?'\n［说明：本段字幕很长，输入只包含前部片段。梗概不得推断未提供的字幕。］':'');
  }

  function visibleText(value){
    return String(value||'').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi,' ')
      .replace(/<\|[^|]{1,80}\|>/g,' ').replace(/\s+\n/g,'\n').trim();
  }

  var api=Object.freeze({mediaIdentity:mediaIdentity,resumePoint:resumePoint,recapSegment:recapSegment,buildRecapPrompt:buildRecapPrompt,visibleText:visibleText});
  root.IBCinemaCore=api;
  if(root.IB)root.IB.cinemaCore=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
