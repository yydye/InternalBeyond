/* Presence 2.0 pure policies. Lifecycle and storage remain owned by communication.js. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.IBPresenceCore=factory();
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const DEFAULT_INTERVAL_HOURS=2;
  const MAX_INTERVAL_HOURS=8;
  const GREETING_COOLDOWN_MS=12*60*60*1000;
  const CONTEXT_MAX_AGE_MS=24*60*60*1000;
  function normalizeSettings(value){
    const s=value&&typeof value==='object'?value:{};
    const raw=parseInt(s.welcomeInterval,10);
    const hours=[1,2,4,8].includes(raw)?raw:DEFAULT_INTERVAL_HOURS;
    return{
      silentEnabled:s.presenceEnabled===undefined?!!s.welcomeEnabled:s.presenceEnabled===true,
      greetingEnabled:s.presenceGreetingEnabled===true,
      intervalHours:Math.min(MAX_INTERVAL_HOURS,hours),
      intervalMs:hours*60*60*1000
    };
  }
  function buildReturnEvent(departedAt,returnedAt,minimumAwayMs){
    const left=Number(departedAt),back=Number(returnedAt),minimum=Math.max(0,Number(minimumAwayMs)||0);
    if(!Number.isFinite(left)||left<=0||!Number.isFinite(back)||back<left)return null;
    const durationMs=back-left;
    if(durationMs<minimum)return null;
    return{id:'presence_'+Math.floor(left),departedAt:left,returnedAt:back,durationMs:durationMs};
  }
  function formatDuration(durationMs){
    const total=Math.max(0,Math.floor(Number(durationMs)||0)/60000);
    const minutes=Math.floor(total),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
    const parts=[];
    if(days)parts.push(days+' 天');
    if(hours%24)parts.push((hours%24)+' 小时');
    if(minutes%60)parts.push((minutes%60)+' 分钟');
    if(!parts.length)return '不到 1 分钟';
    return parts.join(' ');
  }
  function contextForReturn(event){
    if(!event||!Number.isFinite(Number(event.durationMs)))return '';
    return '【最近一次离开与归来】对方刚回到这里，此前离开约 '+formatDuration(event.durationMs)+'。这是背景信息，不要求你提及离开时长或专门问候；请结合角色人设和当前对话，自然判断是否回应。如果当前话题已经继续，或提起此事显得突兀，就直接接着当前话题。';
  }
  function mayDeliverContext(event,now){
    const n=Number(now)||Date.now();
    return !!(event&&Number(event.returnedAt)>0&&n>=Number(event.returnedAt)
      &&n-Number(event.returnedAt)<=CONTEXT_MAX_AGE_MS);
  }
  function mayAttemptGreeting(input){
    const x=input&&typeof input==='object'?input:{};
    if(x.enabled!==true||!x.event)return false;
    if(x.isGroup===true||x.chatBusy===true||x.hasDraft===true||x.hasAttachments===true)return false;
    const now=Number(x.now)||Date.now(),last=Number(x.lastGreetingAt)||0;
    if(!mayDeliverContext(x.event,now))return false;
    if(last>0&&now-last<GREETING_COOLDOWN_MS)return false;
    return true;
  }
  return{
    DEFAULT_INTERVAL_HOURS:DEFAULT_INTERVAL_HOURS,
    GREETING_COOLDOWN_MS:GREETING_COOLDOWN_MS,
    CONTEXT_MAX_AGE_MS:CONTEXT_MAX_AGE_MS,
    normalizeSettings:normalizeSettings,
    buildReturnEvent:buildReturnEvent,
    formatDuration:formatDuration,
    contextForReturn:contextForReturn,
    mayDeliverContext:mayDeliverContext,
    mayAttemptGreeting:mayAttemptGreeting
  };
});
