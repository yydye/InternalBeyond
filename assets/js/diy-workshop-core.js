(function(root,factory){
  'use strict';
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.IBDIYWorkshopCore=api;
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:this),function(){
  'use strict';

  var STORAGE_ID='ibDiyWorkshopV1';
  var MAX_ASSET_CHARS=7*1024*1024;
  var VISUAL_SLOT_COUNT=4;
  var BUBBLE_SLOT_COUNT=10;
  var ASSET_KEYS=['homeInternal','homeInfernal','roomDay','roomNight','tarotCloth','tarotBack','storyWinDay','storyWinNight','teaInternal','teaInfernal','teaChat','canvas'];
  var SECTION_KEYS=['home','chat','room','settings'];
  var LIBRARY={
    'assets/images/bg-internal.jpg':'主页背景 · Internal',
    'assets/images/bg-infernal.jpg':'主页背景 · Infernal',
    'assets/images/bg-canvas.png':'画窗背景 · PNG',
    'assets/images/bg-canvas.jpg':'画窗背景 · JPG',
    'game/room_day.png':'Room 场景 · 日间',
    'game/room_night.png':'Room 场景 · 夜间',
    'game/story_win_day.png':'Story 窗口 · 日间',
    'game/story_win_night.png':'Story 窗口 · 夜间',
    'game/tea_select_bg_internal.png':'Tea 选择页 · Internal',
    'game/tea_select_bg_infernal.png':'Tea 选择页 · Infernal',
    'game/tea_chat_bg.png':'Tea 对话背景'
  };
  var BUBBLE_DECORATIONS=['none','corner','spark','dots','dash'];
  var BUBBLE_BORDER_STYLES=['solid','dashed','double'];
  function isColor(value){return typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)}
  function finite(value,fallback){var n=Number(value);return Number.isFinite(n)?n:fallback}
  function clamp(value,min,max,fallback){return Math.max(min,Math.min(max,finite(value,fallback)))}
  function safeImageSource(value){
    if(typeof value!=='string'||value.length>MAX_ASSET_CHARS)return '';
    if(Object.prototype.hasOwnProperty.call(LIBRARY,value))return value;
    if(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return value;
    return '';
  }
  function validSlot(value,count){var n=String(value==null?'':value);return /^(0|[1-9])$/.test(n)&&Number(n)<count?n:''}
  function cleanLabel(value,fallback,max){
    var text=typeof value==='string'?value:'';
    text=text.replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,max||32);
    return text||fallback;
  }
  function normalizeBubbleSide(raw){
    raw=raw&&typeof raw==='object'?raw:{};
    var stops=Array.isArray(raw.stops)?raw.stops.filter(isColor).slice(0,4).map(function(c){return c.toLowerCase()}):[];
    return {
      stops:stops,
      angle:clamp(raw.angle,0,360,135),
      opacity:clamp(raw.opacity,.08,1,.82),
      borderColor:isColor(raw.borderColor)?raw.borderColor.toLowerCase():'',
      borderWidth:clamp(raw.borderWidth,0,4,1),
      borderOpacity:clamp(raw.borderOpacity,.05,1,.5),
      borderStyle:BUBBLE_BORDER_STYLES.indexOf(raw.borderStyle)>=0?raw.borderStyle:'solid',
      radius:clamp(raw.radius,4,32,16),
      textMode:['auto','dark','light'].indexOf(raw.textMode)>=0?raw.textMode:'auto',
      shadow:clamp(raw.shadow,0,.6,.08),
      fontScale:clamp(raw.fontScale,.8,1.2,1),
      tail:raw.tail!==false,
      decoration:BUBBLE_DECORATIONS.indexOf(raw.decoration)>=0?raw.decoration:'none',
      decorationColor:isColor(raw.decorationColor)?raw.decorationColor.toLowerCase():''
    };
  }
  function normalizeBubbleScheme(raw){
    if(!raw||typeof raw!=='object')return null;
    return {
      name:cleanLabel(raw.name,'气泡方案',24),
      user:normalizeBubbleSide(raw.user),
      assistant:normalizeBubbleSide(raw.assistant)
    };
  }
  function defaultBubbleScheme(){
    return normalizeBubbleScheme({
      name:'气泡方案',
      user:{stops:[],textMode:'auto',decoration:'none'},
      assistant:{stops:[],textMode:'auto',decoration:'none'}
    });
  }
  function normalizeVisualSnapshot(raw,accentFallback){
    raw=raw&&typeof raw==='object'?raw:{};
    var out=defaultConfig(accentFallback);
    if(isColor(raw.accent))out.accent=raw.accent.toLowerCase();
    var sections=raw.sectionColors&&typeof raw.sectionColors==='object'?raw.sectionColors:{};
    SECTION_KEYS.forEach(function(key){if(isColor(sections[key]))out.sectionColors[key]=sections[key].toLowerCase()});
    out.fontScale=clamp(raw.fontScale,.9,1.1,1);
    out.fontFamily=raw.fontFamily==='serif'?'serif':'sans';
    out.chatFont=raw.chatFont==='serif'?'serif':'inherit';
    out.cardShadow=raw.cardShadow!==false;
    out.widgetStyle=['frost','ink'].indexOf(raw.widgetStyle)>=0?raw.widgetStyle:'default';
    out.decorations=raw.decorations!==false;
    out.bubbleActive={
      internal:validSlot(raw.bubbleActive&&raw.bubbleActive.internal,BUBBLE_SLOT_COUNT),
      infernal:validSlot(raw.bubbleActive&&raw.bubbleActive.infernal,BUBBLE_SLOT_COUNT)
    };
    return out;
  }
  function defaultConfig(accent){
    return {
      id:STORAGE_ID,
      version:2,
      accent:isColor(accent)?accent.toLowerCase():'',
      sectionColors:{},
      fontScale:1,
      fontFamily:'sans',
      chatFont:'inherit',
      cardShadow:true,
      widgetStyle:'default',
      decorations:true,
      tarotFaceStyle:'veil',
      assets:{},
      portraits:{},
      visualSchemes:Array(VISUAL_SLOT_COUNT).fill(null),
      bubbleSchemes:Array(BUBBLE_SLOT_COUNT).fill(null),
      bubbleActive:{internal:'',infernal:''},
      bubbleBindings:{}
    };
  }
  function normalize(raw,accentFallback){
    var out=defaultConfig(isColor(accentFallback)?accentFallback:'');
    if(!raw||typeof raw!=='object')return out;
    out.version=2;
    if(isColor(raw.accent))out.accent=raw.accent.toLowerCase();
    if(raw.tarotFaceStyle==='orrery')out.tarotFaceStyle='orrery';
    var sections=raw.sectionColors&&typeof raw.sectionColors==='object'?raw.sectionColors:{};
    SECTION_KEYS.forEach(function(key){if(isColor(sections[key]))out.sectionColors[key]=sections[key].toLowerCase()});
    var assets=raw.assets&&typeof raw.assets==='object'?raw.assets:{};
    ASSET_KEYS.forEach(function(key){
      var src=safeImageSource(assets[key]);
      if(src)out.assets[key]=src;
    });
    var portraits=raw.portraits&&typeof raw.portraits==='object'?raw.portraits:{};
    Object.keys(portraits).forEach(function(id){
      if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)||id==='__proto__'||id==='constructor'||id==='prototype')return;
      var item=portraits[id];
      if(!item||typeof item!=='object')return;
      var src=safeImageSource(item.src);
      if(!src)return;
      out.portraits[id]={
        src:src,
        name:typeof item.name==='string'?item.name.slice(0,160):'',
        scale:clamp(item.scale,0.65,1.5,1),
        x:clamp(item.x,-100,100,0),
        y:clamp(item.y,-100,100,0)
      };
    });
    out.fontScale=clamp(raw.fontScale,.9,1.1,1);
    out.fontFamily=raw.fontFamily==='serif'?'serif':'sans';
    out.chatFont=raw.chatFont==='serif'?'serif':'inherit';
    out.cardShadow=raw.cardShadow!==false;
    out.widgetStyle=['frost','ink'].indexOf(raw.widgetStyle)>=0?raw.widgetStyle:'default';
    out.decorations=raw.decorations!==false;
    var schemes=Array.isArray(raw.visualSchemes)?raw.visualSchemes:[];
    for(var vi=0;vi<VISUAL_SLOT_COUNT;vi++){
      var visual=schemes[vi];
      if(visual&&typeof visual==='object'){
        var snapshot=normalizeVisualSnapshot(visual.snapshot||visual,accentFallback);
        out.visualSchemes[vi]={name:cleanLabel(visual.name,'外观方案 '+(vi+1),24),snapshot:{
          accent:snapshot.accent,sectionColors:snapshot.sectionColors,fontScale:snapshot.fontScale,
          fontFamily:snapshot.fontFamily,chatFont:snapshot.chatFont,cardShadow:snapshot.cardShadow,
          widgetStyle:snapshot.widgetStyle,decorations:snapshot.decorations,bubbleActive:snapshot.bubbleActive
        }};
      }
    }
    var bubbles=Array.isArray(raw.bubbleSchemes)?raw.bubbleSchemes:[];
    for(var bi=0;bi<BUBBLE_SLOT_COUNT;bi++)out.bubbleSchemes[bi]=bubbles[bi]?normalizeBubbleScheme(bubbles[bi]):null;
    var active=raw.bubbleActive&&typeof raw.bubbleActive==='object'?raw.bubbleActive:{};
    out.bubbleActive={
      internal:validSlot(active.internal,BUBBLE_SLOT_COUNT),
      infernal:validSlot(active.infernal,BUBBLE_SLOT_COUNT)
    };
    var bindings=raw.bubbleBindings&&typeof raw.bubbleBindings==='object'?raw.bubbleBindings:{};
    Object.keys(bindings).forEach(function(id){
      if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)||id==='__proto__'||id==='constructor'||id==='prototype')return;
      var binding=bindings[id]&&typeof bindings[id]==='object'?bindings[id]:{};
      var normalized={internal:validSlot(binding.internal,BUBBLE_SLOT_COUNT),infernal:validSlot(binding.infernal,BUBBLE_SLOT_COUNT)};
      if(normalized.internal||normalized.infernal)out.bubbleBindings[id]=normalized;
    });
    return out;
  }
  function isDefault(config,accent){
    var c=normalize(config,accent);
    return c.accent.toLowerCase()===(isColor(accent)?accent.toLowerCase():'')
      &&c.sectionColors&&Object.keys(c.sectionColors).length===0
      &&c.fontScale===1&&c.fontFamily==='sans'&&c.chatFont==='inherit'
      &&c.cardShadow===true&&c.widgetStyle==='default'&&c.decorations===true
      &&c.tarotFaceStyle==='veil'
      &&Object.keys(c.assets).length===0
      &&Object.keys(c.portraits).length===0
      &&c.visualSchemes.every(function(slot){return slot===null})
      &&c.bubbleSchemes.every(function(slot){return slot===null})
      &&!c.bubbleActive.internal&&!c.bubbleActive.infernal
      &&Object.keys(c.bubbleBindings).length===0;
  }
  return Object.freeze({
    STORAGE_ID:STORAGE_ID,
    VISUAL_SLOT_COUNT:VISUAL_SLOT_COUNT,
    BUBBLE_SLOT_COUNT:BUBBLE_SLOT_COUNT,
    ASSET_KEYS:ASSET_KEYS.slice(),
    SECTION_KEYS:SECTION_KEYS.slice(),
    LIBRARY:Object.freeze(Object.assign({},LIBRARY)),
    isColor:isColor,
    safeImageSource:safeImageSource,
    defaultConfig:defaultConfig,
    normalize:normalize,
    defaultBubbleScheme:defaultBubbleScheme,
    normalizeBubbleScheme:normalizeBubbleScheme,
    normalizeVisualSnapshot:normalizeVisualSnapshot,
    isDefault:isDefault
  });
});
