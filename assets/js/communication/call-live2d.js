/* Optional Live2D role presentation for VoiceCall. It owns only the renderer;
   call state, audio and camera capture remain in the existing VoiceCall runtime. */
(function(NS){
  'use strict';

  var scripts={
    pixi:'assets/vendor/live2d/pixi.min.js',
    cubism4:'assets/vendor/live2d/cubism4.min.js',
    core:'assets/live2d/runtime/live2dcubismcore.min.js'
  };
  var runtimePromise=null,activeCall=null;

  function modelReference(role){
    if(!role||typeof role!=='object')return '';
    if(role.live2dMode==='portrait')return '';
    var value=role.live2dModelUrl||role.live2dModelPath;
    if(!value&&typeof role.live2dModel==='string')value=role.live2dModel;
    if(!value&&role.live2dModel&&typeof role.live2dModel==='object')value=role.live2dModel.url||role.live2dModel.path||role.live2dModel.model3Json;
    value=String(value||'').trim();
    if(!value||/^\s*(?:javascript|data|blob|file):/i.test(value)||value.indexOf('\\')>=0||value.indexOf('//')===0)return '';
    try{
      var resolved=new URL(value,window.location.href);
      if(!/\.model3\.json$/i.test(resolved.pathname))return '';
      if(['http:','https:','tauri:'].indexOf(resolved.protocol)<0)return '';
      if(resolved.protocol==='http:'&&resolved.origin!==window.location.origin)return '';
      if(resolved.username||resolved.password)return '';
      return resolved.href;
    }catch(e){return ''}
  }
  function resolvedModelUrl(value){
    value=String(value||'').trim();if(!value)return '';
    try{
      var url=new URL(value,window.location.href);
      if(!/\.model3\.json$/i.test(url.pathname)||url.username||url.password)return '';
      if(url.protocol==='https:'||url.protocol==='tauri:')return url.href;
      if(url.protocol==='http:'&&(url.origin===window.location.origin||url.hostname==='asset.localhost'))return url.href;
      return '';
    }catch(e){return ''}
  }
  function resolveModelUrl(role){
    var ref=String(role&&role.live2dModelRef||'').trim(),library=window.IB&&window.IB.host&&window.IB.host.live2dModels;
    if(ref&&library&&library.available&&typeof library.resolve==='function'){
      return library.resolve(ref).then(resolvedModelUrl);
    }
    return Promise.resolve(modelReference(role));
  }
  function diyPortraitRecord(role){
    var workshop=window.IBDIYWorkshop,id=String(role&&role.id||'');
    if(!workshop||!id||typeof workshop.getAppliedConfig!=='function')return null;
    try{var config=workshop.getAppliedConfig(),portraits=config&&config.portraits;return portraits&&portraits[id]||null}catch(e){return null}
  }
  function avatarSource(role,diy){
    if(arguments.length<2)diy=diyPortraitRecord(role);
    var value=(diy&&diy.src)||(role&&(role.avatar||role.avatarUrl||(role.character&&(role.character.avatar||role.character.avatarUrl||role.character.image))))||'';
    try{return window.IBSafeImage&&typeof window.IBSafeImage.normalizeSource==='function'?window.IBSafeImage.normalizeSource(value):''}catch(e){return ''}
  }
  function appendScript(src,ready){
    return new Promise(function(resolve,reject){
      if(ready()){resolve();return}
      var scriptsNow=document.querySelectorAll('script[data-live2d-src]'),existing=null;
      for(var i=0;i<scriptsNow.length;i++)if(scriptsNow[i].dataset.live2dSrc===src){existing=scriptsNow[i];break}
      if(existing){
        if(existing.dataset.failed==='true'){existing.remove();existing=null}
      }
      if(existing){
        if(existing.dataset.loaded==='true'){ready()?resolve():reject(new Error('Live2D runtime symbol is missing'));return}
        existing.addEventListener('load',function(){ready()?resolve():reject(new Error('Live2D runtime symbol is missing'))},{once:true});
        existing.addEventListener('error',function(){reject(new Error('Could not load '+src))},{once:true});
        return;
      }
      var script=document.createElement('script');script.src=src;script.async=false;script.dataset.live2dSrc=src;
      script.onload=function(){script.dataset.loaded='true';ready()?resolve():reject(new Error('Live2D runtime symbol is missing'))};
      script.onerror=function(){script.dataset.failed='true';reject(new Error('Could not load '+src))};
      (document.head||document.documentElement).appendChild(script);
    });
  }
  function ensureRuntime(){
    if(runtimePromise)return runtimePromise;
    runtimePromise=appendScript(scripts.pixi,function(){return !!(window.PIXI&&window.PIXI.Application)}).then(function(){
      var coreReady=!!window.Live2DCubismCore;
      var coreLoad=Promise.resolve();
      if(!coreReady){
        var library=window.IB&&window.IB.host&&window.IB.host.live2dModels;
        var corePath=library&&library.available&&typeof library.runtimeUrl==='function'?library.runtimeUrl():Promise.resolve(scripts.core);
        coreLoad=Promise.resolve(corePath).then(function(url){if(!url)throw new Error('LIVE2D_CORE_UNAVAILABLE');return appendScript(String(url),function(){return !!window.Live2DCubismCore})});
      }
      return coreLoad;
    }).then(function(){
      return appendScript(scripts.cubism4,function(){return !!(window.PIXI&&window.PIXI.live2d&&window.PIXI.live2d.Live2DModel)});
    }).then(function(){
      var renderer=window.PIXI&&window.PIXI.live2d;
      if(!renderer||!renderer.Live2DModel||!window.Live2DCubismCore)throw new Error('Cubism 4 runtime is not ready');
      return renderer;
    }).catch(function(error){runtimePromise=null;throw error});
    return runtimePromise;
  }
  function roleLayer(stage,role){
    var layer=stage.querySelector('.voice-call-role-layer');
    if(!layer){layer=document.createElement('div');layer.className='voice-call-role-layer';layer.setAttribute('aria-hidden','true');stage.appendChild(layer)}
    layer.replaceChildren();
    var diy=diyPortraitRecord(role),avatar=avatarSource(role,diy),note=document.createElement('div');note.className='voice-call-role-fallback-note';
    if(avatar){var image=document.createElement('img');image.className='voice-call-role-portrait';image.alt='';image.draggable=false;image.src=avatar;image.addEventListener('error',function(){try{image.remove()}catch(e){};layer.classList.remove('has-portrait');note.textContent='当前角色尚未添加立绘或 Live2D 模型';if(!note.parentNode)layer.appendChild(note);var panel=stage.closest('.voice-call-panel');if(panel)panel.classList.remove('has-role-avatar')},{once:true});layer.appendChild(image);layer.classList.add('has-portrait')}
    else{layer.classList.remove('has-portrait');note.textContent='当前角色尚未添加立绘或 Live2D 模型';layer.appendChild(note)}
    var panel=stage.closest('.voice-call-panel');if(panel)panel.classList.toggle('has-role-avatar',!!avatar);
    stage.classList.add('has-role-presentation');
    return {layer:layer,avatar:avatar,note:note,portrait:layer.querySelector('.voice-call-role-portrait'),diyPortrait:diy};
  }
  function fitPortrait(stage,image,role,record){
    if(!stage||!image)return;
    var rect=stage.getBoundingClientRect(),w=Math.max(0,rect.width||stage.clientWidth||0),h=Math.max(0,rect.height||stage.clientHeight||0);
    if(!(w>0&&h>0))return;
    image.style.width='auto';image.style.height=Math.max(160,h-210)+'px';
    image.style.maxWidth=Math.min(w*.62,680)+'px';image.style.maxHeight='none';
    if(arguments.length<4)record=diyPortraitRecord(role);
    var scale=clamp(record&&record.scale,.65,1.5,1),x=(Number(record&&record.x)||0)*.3,y=-(Number(record&&record.y)||0)*.3;
    image.style.transformOrigin='center bottom';image.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';
  }
  function fitModel(app,model,host){
    if(!app||!model||!host)return;
    var rect=host.getBoundingClientRect(),w=Math.max(1,rect.width),h=Math.max(1,rect.height),usableH=Math.max(1,h-Math.min(156,h*.2));
    try{app.renderer.resize(w,h)}catch(e){}
    var bounds=null;try{bounds=model.getLocalBounds()}catch(e){}
    var bw=Math.max(1,Number(bounds&&bounds.width)||Number(model.width)||1),bh=Math.max(1,Number(bounds&&bounds.height)||Number(model.height)||1);
    var role=host.closest('.voice-call-video')&&host.closest('.voice-call-video')._ibLive2dRole||{};
    var scale=Math.min(w*.72/bw,usableH*.92/bh)*clamp(role.live2dScale,75,135,100)/100;
    var offsetX=clamp(role.live2dOffsetX,-20,20,0)/100,offsetY=clamp(role.live2dOffsetY,-30,20,0)/100;
    model.anchor.set(.5,.96);model.scale.set(scale);model.position.set(w*(.5+offsetX),usableH*(.98+offsetY));
  }
  function clamp(value,min,max,fallback){value=Number(value);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback}
  function startIdleMotion(renderer,model){
    try{
      var internal=model&&model.internalModel,settings=internal&&internal.settings;
      var groups=settings&&(settings.motionGroups||settings.motions)||(internal&&internal.motionManager&&internal.motionManager.motionGroups);
      if(!groups)return;
      var keys=Object.keys(groups),idle=null;
      for(var i=0;i<keys.length;i++)if(/idle/i.test(keys[i])){idle=keys[i];break}
      if(idle&&renderer.MotionPriority&&typeof model.motion==='function')model.motion(idle,Math.floor(Math.random()*Math.max(1,groups[idle].length||1)),renderer.MotionPriority.IDLE);
    }catch(e){}
  }
  function applyMouth(state){
    if(!state||!state.model||state.cancelled)return 0;
    var reduced=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)||document.documentElement.dataset.reducedMotion==='true'||document.documentElement.dataset.motion==='off';
    var audioLevel=clamp(state.call._live2dAudioLevel,0,1,0);
    var speaking=!reduced&&state.state==='speaking'&&audioLevel>.025;
    var value=speaking ? Math.min(.88,.08+audioLevel*.82) : 0;
    try{var core=state.model.internalModel&&state.model.internalModel.coreModel;if(core&&typeof core.setParameterValueById==='function')core.setParameterValueById('ParamMouthOpenY',value)}catch(e){}
    state.mouthValue=value;return value;
  }
  function applyNaturalIdle(state,phase,now){
    if(!state||!state.model||state.cancelled)return;
    var core=state.model.internalModel&&state.model.internalModel.coreModel;if(!core||typeof core.setParameterValueById!=='function')return;
    var reduced=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)||document.documentElement.dataset.reducedMotion==='true'||document.documentElement.dataset.motion==='off';
    if(reduced)return;
    try{core.setParameterValueById('ParamBreath',.5+.5*Math.sin(phase*.52))}catch(e){}
    if(!state.nextBlinkAt)state.nextBlinkAt=now+2600+Math.random()*2600;
    if(now>=state.nextBlinkAt){state.blinkStartedAt=now;state.nextBlinkAt=now+3000+Math.random()*3200}
    var blink=1;
    if(state.blinkStartedAt){var t=(now-state.blinkStartedAt)/210;if(t>=1){state.blinkStartedAt=0}else if(t<.42)blink=1-t/.42;else if(t<.58)blink=0;else blink=(t-.58)/.42}
    blink=clamp(blink,0,1,1);
    try{core.setParameterValueById('ParamEyeLOpen',blink);core.setParameterValueById('ParamEyeROpen',blink)}catch(e){}
  }
  function mount(stage,role,call){
    if(!stage||!call)return Promise.resolve({ok:false,reason:'missing-stage'});
    var engine=String(role&&role.characterEngine||'');
    var hasLive2d=!!(role&&(role.live2dModelRef||role.live2dModelUrl||role.live2dModelPath||role.live2dModel));
    if((engine==='puppet'||(engine==='auto'&&role&&role.puppetRef&&!hasLive2d))&&window.IBCallPuppet&&typeof window.IBCallPuppet.attach==='function'){
      return window.IBCallPuppet.attach(stage,role,call);
    }
    if(activeCall&&activeCall!==call)destroy(activeCall);
    destroy(call);
    activeCall=call;
    var token=(Number(call._live2dGeneration)||0)+1;call._live2dGeneration=token;
    var boundRole=role||call.role||{};stage._ibLive2dRole=boundRole;
    var diy=window.IBDIYWorkshop,ready=diy&&diy.ready;
    if(ready&&typeof ready.then==='function')return Promise.resolve(ready).then(function(){return mountReady(stage,boundRole,call,token)},function(){return mountReady(stage,boundRole,call,token)});
    return mountReady(stage,boundRole,call,token);
  }
  function mountReady(stage,boundRole,call,token){
    if(call.destroyed||call._live2dGeneration!==token||!stage.isConnected||stage.hidden)return Promise.resolve({ok:false,reason:'cancelled'});
    var fallback=roleLayer(stage,boundRole),urlPromise=String(boundRole.live2dMode||'auto')==='portrait'?Promise.resolve(''):resolveModelUrl(boundRole);
    var state={stage:stage,role:boundRole,call:call,token:token,layer:fallback.layer,note:fallback.note,portrait:fallback.portrait,avatar:fallback.avatar,modelUrl:'',mode:fallback.avatar?'portrait':'none',app:null,model:null,observer:null,resizeListener:null,tick:null,motionManager:null,originalMotionUpdate:null,motionWrapper:null,mouthHook:false,mouthValue:0,audioLevel:0,state:call.state||'connected',cancelled:false};
    call._live2dPresentation=state;
    if(state.portrait){fitPortrait(stage,state.portrait,boundRole,fallback.diyPortrait);state.resizeListener=function(){fitPortrait(stage,state.portrait,boundRole,fallback.diyPortrait)};window.addEventListener('resize',state.resizeListener,{passive:true})}
    if(String(boundRole.live2dMode||'auto')==='portrait')return Promise.resolve({ok:true,mode:state.mode,reason:'portrait-selected'});
    return urlPromise.then(function(url){
      state.modelUrl=url;
      if(!url)return {ok:true,mode:state.mode,reason:'no-model-configured'};
      if(state.note)state.note.textContent='正在加载角色模型…';
      return ensureRuntime().then(function(renderer){
      if(state.cancelled||call._live2dGeneration!==token||!stage.isConnected||stage.hidden)return {ok:false,reason:'cancelled'};
      var canvas=document.createElement('canvas');canvas.className='voice-call-live2d-canvas';canvas.setAttribute('aria-hidden','true');canvas.style.transform='none';canvas.style.direction='ltr';
      state.layer.appendChild(canvas);
      var rect=state.layer.getBoundingClientRect(),resolution=Math.min(1.5,window.devicePixelRatio||1);
      var app=new window.PIXI.Application({view:canvas,width:Math.max(1,rect.width),height:Math.max(1,rect.height),backgroundAlpha:0,transparent:true,antialias:true,autoDensity:true,resolution:resolution,autoStart:true,sharedTicker:false,sharedLoader:false});
      state.app=app;
      if(app.ticker){app.ticker.maxFPS=30;app.ticker.minFPS=15}
      return renderer.Live2DModel.from(url,{autoInteract:false,autoUpdate:true}).then(function(model){
        if(state.cancelled||call._live2dGeneration!==token||!stage.isConnected||stage.hidden){try{model.destroy({children:true,texture:true,baseTexture:true})}catch(e){};return {ok:false,reason:'cancelled'}}
        state.model=model;app.stage.addChild(model);fitModel(app,model,state.layer);startIdleMotion(renderer,model);
        state.mode='live2d';state.layer.dataset.mode='live2d';state.layer.classList.add('is-live2d');
        if(state.resizeListener){window.removeEventListener('resize',state.resizeListener);state.resizeListener=null}
        if(fallback.avatar&&state.portrait)state.portrait.hidden=true;
        if(state.note&&state.note.parentNode)state.note.remove();
        try{
          var motionManager=model.internalModel&&model.internalModel.motionManager;
          if(motionManager&&typeof motionManager.update==='function'){
            state.motionManager=motionManager;state.originalMotionUpdate=motionManager.update;
            state.motionWrapper=function(){var result=state.originalMotionUpdate.apply(this,arguments),now=performance.now();applyNaturalIdle(state,(now-state.createdAt)/1000,now);applyMouth(state);return result};
            motionManager.update=state.motionWrapper;state.mouthHook=true;
          }
        }catch(e){}
        state.createdAt=performance.now();
        var motionPhase=Math.random()*Math.PI*2;
        state.tick=function(delta){
          if(state.cancelled||!state.model||!state.app)return;
          var reduced=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)||document.documentElement.dataset.reducedMotion==='true'||document.documentElement.dataset.motion==='off';
          var speaking=!reduced&&(state.state==='speaking'||!!call.speaking||!!call.playing);
          motionPhase+=(Number(delta)||1)/60;
          if(!state.mouthHook)applyNaturalIdle(state,motionPhase,performance.now());
          try{
            if(!state.mouthHook){var core=state.model.internalModel&&state.model.internalModel.coreModel;if(core&&typeof core.setParameterValueById==='function')core.setParameterValueById('ParamMouthOpenY',applyMouth(state))}
            if(state.app.view)state.app.view.dataset.speaking=speaking?'true':'false';
          }catch(e){}
        };
        if(app.ticker&&state.tick)app.ticker.add(state.tick);
        function resize(){fitModel(app,model,state.layer)}
        if(window.ResizeObserver){state.observer=new ResizeObserver(resize);state.observer.observe(state.layer)}else window.addEventListener('resize',resize,{passive:true});
        state.resize=resize;state.mode='live2d';state.layer.dataset.mode='live2d';
        return {ok:true,mode:'live2d',url:url};
      });
      });
    }).catch(function(error){
      if(state.cancelled||call._live2dGeneration!==token)return {ok:false,reason:'cancelled'};
      state.mode=fallback.avatar?'portrait':'none';state.layer.dataset.mode=state.mode;
      if(!fallback.avatar&&state.note)state.note.textContent='Live2D 暂不可用，当前为无画面模式';
      try{if(state.app&&state.app.ticker)state.app.ticker.stop();var failedView=state.app&&state.app.view;if(state.app)state.app.destroy(true,{children:true,texture:false,baseTexture:false});if(failedView&&failedView.parentNode)failedView.remove()}catch(e){}
      state.app=null;state.model=null;
      try{console.warn('[Live2D] role presentation fallback',String(error&&error.message||error))}catch(e){}
      return {ok:false,mode:state.mode,error:String(error&&error.message||error)};
    });
  }
  function syncState(call,state){var current=call&&call._live2dPresentation;if(current&&!current.cancelled)current.state=String(state||'idle');else if(call&&call._puppetPresentation&&window.IBCallPuppet&&typeof window.IBCallPuppet.syncAudioLevel==='function')call._puppetPresentation.state=String(state||'idle')}
  function syncAudioLevel(call,value){var current=call&&call._live2dPresentation;if(current&&!current.cancelled)current.audioLevel=clamp(value,0,1,0);else if(call&&window.IBCallPuppet&&typeof window.IBCallPuppet.syncAudioLevel==='function')window.IBCallPuppet.syncAudioLevel(call,value)}
  function destroy(call){
    call=call||activeCall;if(!call)return;
    if(call._puppetPresentation&&window.IBCallPuppet&&typeof window.IBCallPuppet.destroy==='function'){window.IBCallPuppet.destroy(call);return}
    call._live2dGeneration=(Number(call._live2dGeneration)||0)+1;
    var state=call._live2dPresentation;if(!state){if(activeCall===call)activeCall=null;return}
    state.cancelled=true;
    try{if(state.observer)state.observer.disconnect();else if(state.resize)window.removeEventListener('resize',state.resize)}catch(e){}
    try{if(state.resizeListener)window.removeEventListener('resize',state.resizeListener)}catch(e){}
    try{if(state.app&&state.tick&&state.app.ticker)state.app.ticker.remove(state.tick)}catch(e){}
    try{if(state.motionManager&&state.motionWrapper&&state.motionManager.update===state.motionWrapper)state.motionManager.update=state.originalMotionUpdate}catch(e){}
    try{if(state.app&&state.app.ticker)state.app.ticker.stop()}catch(e){}
    try{if(state.model&&state.model.parent)state.model.parent.removeChild(state.model)}catch(e){}
    try{if(state.model)state.model.destroy({children:true,texture:true,baseTexture:true})}catch(e){}
    try{if(state.app)state.app.destroy(true,{children:false,texture:false,baseTexture:false})}catch(e){}
    try{if(state.layer)state.layer.remove()}catch(e){}
    try{if(state.stage){state.stage.classList.remove('has-role-presentation');delete state.stage._ibLive2dRole;var panel=state.stage.closest('.voice-call-panel');if(panel)panel.classList.remove('has-role-avatar')}}catch(e){}
    try{call._live2dAudioLevel=0}catch(e){}
    delete call._live2dPresentation;
    if(activeCall===call)activeCall=null;
  }
  function peek(call){var state=call&&call._live2dPresentation;return state?{mode:state.mode,url:state.modelUrl,state:state.state,cancelled:state.cancelled}:null}
  var api={attach:mount,mount:mount,destroy:destroy,syncState:syncState,syncAudioLevel:syncAudioLevel,modelReference:modelReference,resolveModelUrl:resolveModelUrl,createRoleLayer:roleLayer,fitPortrait:fitPortrait,peek:peek};
  window.IBCallLive2D=api;NS.callLive2D=api;
})(window.IB||(window.IB={}));
