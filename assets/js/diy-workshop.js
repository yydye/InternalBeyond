(function(NS){
  'use strict';
  var Core=window.IBDIYWorkshopCore;
  if(!Core)return;
  var root=document.getElementById('ib-diy-workshop');
  if(!root)return;

  var MAX_UPLOAD_BYTES=5*1024*1024;
  var ASSET_GROUPS=[
    {title:'主页与画窗',target:'scenes',keys:['homeInternal','homeInfernal','canvas']},
    {title:'Room 与 Story',target:'scenes',keys:['roomDay','roomNight','storyWinDay','storyWinNight']},
    {title:'Tea 与 Tarot',target:'tarot',keys:['teaInternal','teaInfernal','teaChat','tarotCloth','tarotBack']}
  ];
  var ASSET_LABELS={
    homeInternal:'主页背景 · Internal',homeInfernal:'主页背景 · Infernal',
    roomDay:'Room 场景 · 日间',roomNight:'Room 场景 · 夜间',
    storyWinDay:'Story 窗口 · 日间',storyWinNight:'Story 窗口 · 夜间',
    teaInternal:'Tea 选择页 · Internal',teaInfernal:'Tea 选择页 · Infernal',
    teaChat:'Tea 对话背景',tarotCloth:'Tarot 桌布',tarotBack:'Tarot 卡背',canvas:'画窗背景'
  };
  var DEFAULT_PREVIEW_SOURCES={
    homeInternal:'assets/images/bg-internal.jpg',homeInfernal:'assets/images/bg-infernal.jpg',
    roomDay:'game/room_day.png',roomNight:'game/room_night.png',
    storyWinDay:'game/story_win_day.png',storyWinNight:'game/story_win_night.png',
    teaInternal:'game/tea_select_bg_internal.png',teaInfernal:'game/tea_select_bg_infernal.png',
    teaChat:'game/tea_chat_bg.png',canvas:'assets/images/bg-canvas.png'
  };
  var ZONES=[
    {key:'home',label:'主页',selector:'#page-home',className:'ib-diy-zone-home'},
    {key:'chat',label:'Chat',selector:'#page-chat',className:'ib-diy-zone-chat'},
    {key:'room',label:'Room',selector:'#game-panel',className:'ib-diy-zone-room'},
    {key:'settings',label:'设置',selector:'#page-settings',className:'ib-diy-zone-settings'}
  ];
  var applied=Core.defaultConfig(baseAccent());
  var draft=copy(applied);
  var roles=[];
  var selectedRoleId='';
  var selectedBubbleRoleId='';
  var selectedBubbleSlot='0';
  var selectedBubbleApiId='';
  var bubbleProposal=null;
  var bubbleHistory=[];
  var bubbleBusy=false;
  var activeTab='appearance';
  var activeVisualSection='main';
  var activeBubblePanel='lab';
  var bubbleThemeOverride='';
  var dirty=false;
  var draftRevision=0;
  var appliedRevision=0;
  var loading=false;
  var loaded=false;
  var loadPromise=Promise.resolve();
  var readyPromise=Promise.resolve();
  var toastTimer=0;
  var accentWasClamped=false;
  var tabs=['appearance','portrait','scene','materials','bubble'];
  var storageKey=Core.STORAGE_ID;
  var libraryOptions=Object.keys(Core.LIBRARY);

  function copy(value){return JSON.parse(JSON.stringify(value))}
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
  function baseToken(name){
    var html=document.documentElement,old=html.style.getPropertyValue(name);
    html.style.removeProperty(name);
    var value=getComputedStyle(document.body).getPropertyValue(name).trim();
    if(old)html.style.setProperty(name,old);
    return value;
  }
  function baseAccent(){
    var value=baseToken('--accent');
    return Core.isColor(value)?value:'';
  }
  function defaultConfig(){return Core.defaultConfig(baseAccent())}
  function notify(message){
    var status=root.querySelector('[data-diy-status]');
    if(status)status.textContent=message;
    if(toastTimer)clearTimeout(toastTimer);
    toastTimer=setTimeout(function(){refreshStatus()},3600);
  }
  function isDirty(){return draftRevision!==appliedRevision}
  function markChanged(){draftRevision++;refreshStatus()}
  function refreshStatus(){
    dirty=isDirty();
    var status=root.querySelector('[data-diy-status]');
    var apply=root.querySelector('[data-action="apply"]');
    var cancel=root.querySelector('[data-action="cancel"]');
    if(status)status.textContent=dirty?'有尚未应用的草稿更改。':'当前视觉配置已保存。';
    if(apply)apply.disabled=!dirty;
    if(cancel)cancel.disabled=!dirty;
    root.classList.toggle('is-dirty',dirty);
  }
  function mount(){
    var sectionInputs=ZONES.map(function(zone){
      return '<div class="uvrow diy-zone-row"><div class="uvr-h"><label>'+esc(zone.label)+'分区</label><span class="uvv" data-zone-value="'+zone.key+'">主题默认</span></div><input type="color" data-section-color="'+zone.key+'" aria-label="'+esc(zone.label)+'分区配色"></div>';
    }).join('');
    root.innerHTML=[
      '<div class="diy-workshop-head diy-port-head"><div class="diy-workshop-title"><p class="diy-eyebrow">VISUAL · UI</p><h3>外观与创作</h3></div>',
      '<div class="diy-workshop-actions"><span class="diy-save-state" data-diy-status role="status" aria-live="polite">正在读取已保存配置…</span><button type="button" class="btn mini" data-puppet-studio-open>角色动画工作室</button><button type="button" class="btn mini" data-action="cancel" disabled>撤销草稿</button><button type="button" class="btn mini" data-action="reset">恢复默认</button><button type="button" class="btn mini primary" data-action="apply" disabled>应用</button></div></div>',
      '<div class="diy-tabs" role="tablist" aria-label="DIY 工作坊分区">',
      '<button type="button" role="tab" aria-selected="true" data-tab="appearance">Visual</button>',
      '<button type="button" role="tab" aria-selected="false" data-tab="portrait">立绘</button>',
      '<button type="button" role="tab" aria-selected="false" data-tab="scene">场景</button>',
      '<button type="button" role="tab" aria-selected="false" data-tab="materials">Tarot</button>',
      '<button type="button" role="tab" aria-selected="false" data-tab="bubble">Bubble Lab</button></div>',
      '<section class="diy-tab-panel diy-visual-panel" data-panel="appearance"><div class="uvprev diy-theme-preview" id="diy-theme-preview"><i class="uvp-bg"></i><i class="uvp-scrim"></i><span class="wgt-lab">PREVIEW</span><div class="uvp-glass glass"><span class="uvp-aa">Project-IB</span><i></i><span class="uvp-cn">边界之外</span></div><div class="uvp-zones"><span data-preview-zone="home">主页</span><span data-preview-zone="chat">Chat</span><span data-preview-zone="room">Room</span><span data-preview-zone="settings">设置</span></div></div>',
      '<div class="uvseg diy-visual-nav" role="tablist" aria-label="Visual 分区"><button type="button" class="on" data-visual-section="main">基础</button><button type="button" data-visual-section="text">文字</button><button type="button" data-visual-section="chat">气泡</button><button type="button" data-visual-section="desk">桌面</button></div><div class="diy-visual-sections">',
      '<div class="diy-visual-section" data-visual-panel="main"><div class="set-card"><div class="sc-t">Accent — 强调色</div><div class="swatches diy-accent-swatches" id="diy-accent-swatches"></div><div class="uvrow diy-custom-color-row"><div class="uvr-h"><label for="diy-accent">自定义强调色</label><span class="uvv" id="diy-accent-value"></span></div><input id="diy-accent" type="color" aria-describedby="diy-accent-help"></div><p class="hint" id="diy-accent-help">作用于按钮、选中态与强调线；草稿可撤销，应用后保存。</p></div>',
      '<div class="set-card" id="diy-zone-card"><div class="sc-t">Zone Glass — 分区玻璃</div>'+sectionInputs+'<p class="hint">为各区面板指定轻微染色，保留现有文字与状态对比。</p></div>',
      '<div class="set-card"><div class="sc-t">Themes — Visual 方案</div><div class="diy-port-note">4 个本机方案槽。预览载入草稿；一键应用会持久化当前方案。</div><div class="diy-visual-scheme-grid" id="diy-visual-scheme-grid"></div></div></div>',
      '<div class="diy-visual-section" data-visual-panel="text" hidden><div class="set-card"><div class="sc-t">Font — 字体</div><div class="uvrow"><div class="uvr-h"><label for="diy-font-scale">全局字号</label><span class="uvv" id="diy-font-scale-value">100%</span></div><input id="diy-font-scale" class="ib-range" type="range" min="90" max="110" step="5" value="100"></div><div class="uvrow"><div class="uvr-h"><label for="diy-font-family">界面字体</label></div><div class="sel"><select id="diy-font-family" class="diy-select"><option value="sans">清晰黑体</option><option value="serif">衬线文字</option></select></div></div><div class="tog diy-toggle-row"><div class="tog-m"><div class="tog-t">卡片投影</div><div class="tog-s">切换工作区卡片与面板的投影。</div></div><input id="diy-card-shadow" class="diy-port-toggle" type="checkbox" aria-label="卡片投影"></div></div></div>',
      '<div class="diy-visual-section" data-visual-panel="chat" hidden><div class="set-card"><div class="sc-t">Chat — 聊天文字</div><div class="uvrow"><div class="uvr-h"><label for="diy-chat-font">聊天正文字体</label></div><div class="sel"><select id="diy-chat-font" class="diy-select"><option value="inherit">跟随全站</option><option value="serif">衬线</option></select></div></div><p class="hint">聊天气泡样式、方案和角色绑定统一在 Bubble Lab 中管理。</p><button type="button" class="btn wide" data-action="open-bubble">打开 Bubble Lab</button></div></div>',
      '<div class="diy-visual-section" data-visual-panel="desk" hidden><div class="set-card"><div class="sc-t">Desk — 桌面挂件</div><div class="uvrow"><div class="uvr-h"><label for="diy-widget-style">挂件材质</label></div><div class="uvseg" id="diy-widget-style"><button type="button" data-visual-setting="widgetStyle" data-v="default">默认</button><button type="button" data-visual-setting="widgetStyle" data-v="frost">雾面玻璃</button><button type="button" data-visual-setting="widgetStyle" data-v="ink">墨色玻璃</button></div></div><div class="tog diy-toggle-row"><div class="tog-m"><div class="tog-t">显示日历装饰花瓣</div><div class="tog-s">桌面功能坞上的花瓣装饰。</div></div><input id="diy-decorations" class="diy-port-toggle" type="checkbox" aria-label="显示日历装饰花瓣"></div></div></div></div></section>',
      '<section class="diy-tab-panel" data-panel="portrait" hidden><div class="diy-content-grid diy-portrait-grid"><div class="diy-form-stack"><div class="diy-field"><label for="diy-role-select">绑定角色</label><select id="diy-role-select" class="diy-select"><option value="">选择角色</option></select><small>立绘按角色 ID 保存，修改角色聊天 Provider 不会影响绑定。</small></div>',
      '<div class="diy-field"><input id="diy-portrait-file" class="diy-file-input" type="file" accept="image/png,image/jpeg,image/webp"><label class="diy-file-button" for="diy-portrait-file">导入本地立绘</label><small>PNG、JPG 或 WebP，单张不超过 5 MB。透明 PNG 更适合 Room。</small></div>',
      '<div class="diy-field diy-range-field"><label for="diy-portrait-scale">缩放 <output id="diy-scale-value">100%</output></label><input id="diy-portrait-scale" type="range" min="65" max="150" value="100"></div>',
      '<div class="diy-range-grid"><div class="diy-field diy-range-field"><label for="diy-portrait-x">左右 <output id="diy-x-value">0</output></label><input id="diy-portrait-x" type="range" min="-100" max="100" value="0"></div><div class="diy-field diy-range-field"><label for="diy-portrait-y">上下 <output id="diy-y-value">0</output></label><input id="diy-portrait-y" type="range" min="-100" max="100" value="0"></div></div>',
      '<button type="button" class="btn diy-remove-portrait" data-action="remove-portrait">移除此角色的自定义立绘</button></div>',
      '<div class="diy-preview-column"><div class="diy-preview-label">ROOM PORTRAIT · 实际布局预览</div><div class="diy-room-preview" id="diy-room-preview"><div class="diy-room-preview-backdrop" id="diy-room-preview-backdrop"></div><div class="diy-room-preview-overlay"></div><div class="diy-room-preview-label">ROOM · STORY / TEA</div><div class="diy-room-portrait" id="diy-room-portrait"><img alt="角色立绘预览" id="diy-room-portrait-img" hidden><span id="diy-portrait-placeholder">选择角色并导入立绘</span></div><div class="diy-dialogue-preview"><strong id="diy-preview-role-name">角色名称</strong><span>立绘底部贴齐场景底边；可用滑块微调比例与位置。</span></div></div></div></div></section>',
      '<section class="diy-tab-panel" data-panel="scene" hidden><div class="diy-panel-intro"><h4>主页与 Room 场景</h4><p>导入后即时预览；主页、Room、Story 与 Tea 会在确认应用后读取用户素材。</p></div><div class="diy-assets-grid" id="diy-scenes-grid"></div></section>',
      '<section class="diy-tab-panel" data-panel="materials" hidden><div class="diy-content-grid"><div class="diy-form-stack"><div class="diy-field"><label for="diy-tarot-style">塔罗牌面样式</label><select id="diy-tarot-style" class="diy-select"><option value="veil">Gossamer Veil · 薄纱银线</option><option value="orrery">Astral Orrery · 星象仪</option></select><small>复用 Room 内已有的两种 Deck 样式。</small></div><div class="diy-field"><h4>桌布与卡背</h4><p class="diy-field-note">桌布作用于占卜面板，卡背作用于未抽取的牌。两个素材相互独立。</p></div></div><div class="diy-tarot-preview-wrap"><div class="diy-preview-label">TAROT · 桌布与卡背预览</div><div class="diy-tarot-preview" id="diy-tarot-preview"><div class="diy-tarot-preview-card" id="diy-tarot-preview-card"><span>✦</span></div><div class="diy-tarot-preview-caption">未抽取牌 · 卡背</div></div></div></div><div class="diy-assets-grid diy-tarot-assets" id="diy-tarot-grid"></div></section>',
      '<section class="diy-tab-panel diy-bl-panel" data-panel="bubble" hidden><div class="blx-shell">',
      '<div class="blx-hd"><div class="blx-tt"><span class="blx-t1">Bubble Lab · 气泡工作室</span><small>Sui’s Lab · Chat Bubble Designer</small></div><select id="diy-bubble-api" class="blx-pen"><option value="">执笔 API · 选择配置</option></select><button type="button" class="blx-clr" data-action="bubble-clear">清空</button></div>',
      '<div class="blx-thbar"><button type="button" class="blx-thp" data-bubble-theme-select="internal"><svg class="blx-th-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg><span><b>明亮</b><i data-bubble-theme-status="internal">主题气泡</i></span></button><button type="button" class="blx-thp" data-bubble-theme-select="infernal"><svg class="blx-th-icon" viewBox="0 0 24 24"><path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z"/></svg><span><b>暗色</b><i data-bubble-theme-status="infernal">主题气泡</i></span></button></div>',
      '<div class="blx-pages"><div class="blx-page" data-bubble-page-panel="lab"><div class="blx-lab-scroll"><div class="blx-intro"><div class="blx-chips"><button type="button" data-bubble-prompt="蓝白渐变、雾面玻璃、细描边">蓝白雾玻璃</button><button type="button" data-bubble-prompt="奶油色双段渐变，圆角大一点">奶油拟物</button><button type="button" data-bubble-prompt="蓝紫渐变，角落有一点星光">星雾边角</button></div><div class="blx-tip">说一句想要的气泡样子，执笔 API 会返回安全的颜色与样式字段；SVG、HTML 与脚本不会应用。点击建议会填入输入框，发送时才会调用 API。</div></div><div class="blx-log" id="diy-bubble-log" role="log" aria-live="polite"><div class="blx-empty"><div class="blx-sec">SUI’S LAB</div>我是水水。说一句想要的感觉，我会直接做成一套气泡给你预览。</div></div>',
      '<div class="blx-live-preview"><div class="blx-sec">LIVE PREVIEW · 当前主题</div><div class="blx-pv" data-bubble-preview><div class="mrow ai"><div class="m" data-bubble-side="assistant">TA 的消息预览</div></div><div class="mrow user"><div class="m user" data-bubble-side="user">我发出的消息预览</div></div></div><div class="blx-acts"><button type="button" data-action="bubble-set-global" disabled>穿上（全局）</button><button type="button" data-action="bubble-save-slot" disabled>存为方案</button></div></div></div>',
      '<div class="blx-in"><textarea id="diy-bubble-prompt" rows="1" maxlength="600" placeholder="说一句想要的气泡……"></textarea><button type="button" class="blx-send" data-action="bubble-generate" aria-label="生成预览"><svg viewBox="0 0 20 20"><path d="M3 10h12M10 5l5 5-5 5"/></svg></button></div></div>',
      '<div class="blx-page" data-bubble-page-panel="schemes" hidden><div class="blx-sec">当前气泡 · 穿衣室</div><div class="blx-pv blx-current-preview" id="diy-bubble-preview"><div class="mrow ai"><div class="m" data-bubble-side="assistant">TA 的消息预览</div></div><div class="mrow user"><div class="m user" data-bubble-side="user">我发出的消息预览</div></div></div><div class="blx-row"><label>预览角色<select id="diy-bubble-preview-role" class="diy-select"><option value="">全局默认</option></select></label><label>预览方案<select id="diy-bubble-preview-slot" class="diy-select"><option value="">当前全局</option></select></label></div>',
      '<div class="set-card"><div class="sc-t">基础调整 — 我方与 TA 同调</div><div class="blx-rg"><span>圆角</span><input id="diy-bubble-radius" type="range" min="4" max="32" value="16"><b id="diy-bubble-radius-value">16</b></div><div class="blx-rg"><span>背景不透明</span><input id="diy-bubble-opacity" type="range" min="10" max="100" value="82"><b id="diy-bubble-opacity-value">82%</b></div><div class="blx-row"><label>保存到方案<select id="diy-bubble-save-slot" class="diy-select"></select></label><button type="button" class="btn mini" data-action="bubble-save-slot" disabled>存当前</button><button type="button" class="btn mini primary" data-action="bubble-set-global" disabled>穿上全局</button></div></div>',
      '<div class="blx-sec">方案槽 · 10 套</div><div class="blx-grid" id="diy-bubble-slots"></div><div class="set-card diy-bubble-binding"><div class="sc-t">Bind — 全局默认与角色绑定</div><div class="blx-row"><label>角色<select id="diy-bubble-role" class="diy-select"><option value="">选择角色</option></select></label><label>该角色的气泡<select id="diy-bubble-binding-slot" class="diy-select"><option value="">跟随全局</option></select></label><button type="button" class="btn mini" data-action="bubble-bind">保存绑定</button></div><p class="hint">角色绑定按角色 ID 保存；未绑定时使用当前主题的全局方案。</p></div></div>',
      '</div>',
      '<div class="blx-tabs"><button type="button" class="on" data-bubble-page="lab"><span><svg viewBox="0 0 24 24"><path d="M4 6.5A3.5 3.5 0 0 1 7.5 3h9A3.5 3.5 0 0 1 20 6.5v6a3.5 3.5 0 0 1-3.5 3.5H10l-4 3.5V16A3.5 3.5 0 0 1 4 12.5z"/></svg></span>Sui’s Lab</button><button type="button" data-bubble-page="schemes"><span><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg></span>气泡方案</button></div>',
      '</div></section>',
      '<details class="diy-advanced"><summary>高级说明 · 文件规格与旧素材路径</summary><div class="diy-advanced-copy"><p><strong>角色立绘：</strong>PNG、JPG 或 WebP；推荐 PNG 透明底，800×920 左右。原有兼容路径为 <code>game/portraits/portrait_[API昵称].png</code>；工坊导入的立绘按角色 ID 保存在本机用户数据中。</p><p><strong>主页背景：</strong>分别覆盖 Internal / Infernal。旧素材路径为 <code>assets/images/bg-internal.jpg</code>、<code>assets/images/bg-infernal.jpg</code>。</p><p><strong>Room 场景：</strong>日夜场景路径为 <code>game/room_day.png</code>、<code>game/room_night.png</code>。Story 与 Tea 的内置背景也可从素材库选择。</p><p><strong>Tarot：</strong>桌布旧路径为 <code>game/tarot_bg.png</code>，推荐 1920×1080；画窗背景可用 JPG 或 PNG，建议 1600×900 及以上。素材由本机 IndexedDB 用户数据保存，不会改写安装目录文件。</p></div></details>'
    ].join('');
    buildAssetSlots();
    bindEvents();
    selectTab('appearance');
  }
  function buildAssetSlots(){
    ASSET_GROUPS.forEach(function(group){
      var target=root.querySelector(group.target==='tarot'?'#diy-tarot-grid':'#diy-scenes-grid');
      var heading=document.createElement('h4');
      heading.className='diy-assets-group-title';
      heading.textContent=group.title;
      target.appendChild(heading);
      group.keys.forEach(function(key){
        var wrap=document.createElement('article');
        wrap.className='diy-asset-slot';
        wrap.innerHTML='<div class="diy-asset-preview" id="diy-asset-preview-'+key+'" role="img" aria-label="'+esc(ASSET_LABELS[key])+' 预览"><span>尚未选择素材</span></div>'
          +'<div class="diy-asset-info"><strong>'+esc(ASSET_LABELS[key])+'</strong><select class="diy-select diy-asset-select" data-asset-slot="'+key+'" aria-label="'+esc(ASSET_LABELS[key])+' 来源"><option value="default">沿用现有配置</option><option value="custom">本机导入素材</option>'
          +libraryOptions.map(function(src){return '<option value="'+esc(src)+'">'+esc(Core.LIBRARY[src])+'</option>'}).join('')
          +'</select><div class="diy-asset-actions"><input class="diy-file-input" id="diy-file-'+key+'" type="file" accept="image/png,image/jpeg,image/webp" data-asset-file="'+key+'"><label class="diy-file-button diy-small-file-button" for="diy-file-'+key+'">导入图片</label><button type="button" class="btn diy-small-button" data-action="clear-asset" data-slot="'+key+'" aria-label="清除'+esc(ASSET_LABELS[key])+'">清除</button></div></div>';
        target.appendChild(wrap);
      });
    });
  }
  function selectTab(name){
    if(tabs.indexOf(name)<0)return;
    activeTab=name;
    root.querySelectorAll('[data-tab]').forEach(function(button){
      var selected=button.getAttribute('data-tab')===name;
      button.setAttribute('aria-selected',selected?'true':'false');
      button.tabIndex=selected?0:-1;
    });
    root.querySelectorAll('[data-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-panel')!==name});
  }
  function selectVisualSection(name){
    if(['main','text','chat','desk'].indexOf(name)<0)return;
    activeVisualSection=name;
    root.querySelectorAll('[data-visual-section]').forEach(function(button){
      var selected=button.getAttribute('data-visual-section')===name;
      button.classList.toggle('on',selected);button.setAttribute('aria-selected',selected?'true':'false');
    });
    root.querySelectorAll('[data-visual-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-visual-panel')!==name});
  }
  function selectBubblePanel(name){
    if(name!=='lab'&&name!=='schemes')return;
    activeBubblePanel=name;
    root.querySelectorAll('[data-bubble-page]').forEach(function(button){button.classList.toggle('on',button.getAttribute('data-bubble-page')===name)});
    root.querySelectorAll('[data-bubble-page-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-bubble-page-panel')!==name});
  }
  function selectedBubbleThemeKey(){return bubbleThemeOverride||currentThemeKey()}
  function bindEvents(){
    root.addEventListener('click',function(event){
      var tab=event.target.closest('[data-tab]');
      if(tab){selectTab(tab.getAttribute('data-tab'));return}
      var visualSection=event.target.closest('[data-visual-section]');
      if(visualSection){selectVisualSection(visualSection.getAttribute('data-visual-section'));return}
      var bubblePage=event.target.closest('[data-bubble-page]');
      if(bubblePage){selectBubblePanel(bubblePage.getAttribute('data-bubble-page'));return}
      var bubbleThemeButton=event.target.closest('[data-bubble-theme-select]');
      if(bubbleThemeButton){bubbleThemeOverride=bubbleThemeButton.getAttribute('data-bubble-theme-select');renderBubbleControls();renderBubblePreview();renderBubbleSlots();return}
      var accentButton=event.target.closest('[data-accent-value]');
      if(accentButton){
        if(accentButton.getAttribute('data-accent-value')==='custom'){root.querySelector('#diy-accent').click();return}
        draft.accent=guardAccent(accentButton.getAttribute('data-accent-value'));
        root.querySelector('#diy-accent').value=draft.accent;updateAppearancePreview();renderAccentSwatches();markChanged();return;
      }
      var promptChip=event.target.closest('[data-bubble-prompt]');
      if(promptChip){var promptInput=root.querySelector('#diy-bubble-prompt');if(promptInput){promptInput.value=promptChip.getAttribute('data-bubble-prompt')||'';generateBubbleProposal()}return}
      var visualSetting=event.target.closest('[data-visual-setting]');
      if(visualSetting){setVisualSetting(visualSetting.getAttribute('data-visual-setting'),visualSetting.getAttribute('data-v'));return}
      var action=event.target.closest('[data-action]');
      if(!action)return;
      var name=action.getAttribute('data-action');
      if(name==='apply')applyDraft();
      else if(name==='cancel')cancelDraft();
      else if(name==='reset')resetDraft();
      else if(name==='remove-portrait')removePortrait();
      else if(name==='open-bubble'){selectTab('bubble');selectBubblePanel('lab')}
      else if(name==='clear-asset')clearAsset(action.getAttribute('data-slot'));
      else if(name==='save-visual-slot')saveVisualSlot(Number(action.getAttribute('data-slot')));
      else if(name==='load-visual-slot')loadVisualSlot(Number(action.getAttribute('data-slot')));
      else if(name==='apply-visual-slot')applyVisualSlot(Number(action.getAttribute('data-slot')));
      else if(name==='clear-visual-slot')clearVisualSlot(Number(action.getAttribute('data-slot')));
      else if(name==='bubble-generate')generateBubbleProposal();
      else if(name==='bubble-clear')clearBubbleConversation();
      else if(name==='bubble-save-slot')saveBubbleSlot();
      else if(name==='bubble-set-global')saveAndSetBubbleGlobal();
      else if(name==='bubble-bind')bindBubbleRole();
      else if(name==='bubble-preview-slot')previewBubbleSlot(action.getAttribute('data-slot'));
      else if(name==='bubble-activate-slot')setBubbleGlobal(action.getAttribute('data-slot'));
      else if(name==='bubble-save-at-slot'){selectedBubbleSlot=String(action.getAttribute('data-slot')||'0');var slotSelect=root.querySelector('#diy-bubble-save-slot');if(slotSelect)slotSelect.value=selectedBubbleSlot;saveBubbleSlot()}
      else if(name==='bubble-delete-slot')deleteBubbleSlot(action.getAttribute('data-slot'));
    });
    root.addEventListener('input',function(event){
      var target=event.target;
      if(target.id==='diy-accent'){
        draft.accent=guardAccent(target.value);
        var help=root.querySelector('#diy-accent-help');
        if(help)help.textContent=accentWasClamped?'为保持两种主题下的可读对比，预览色已调整为 '+draft.accent.toUpperCase()+'。':'用于主要按钮、强调线与选中状态。';
        updateAppearancePreview();markChanged();return;
      }
      if(target.hasAttribute('data-section-color')){
        var key=target.getAttribute('data-section-color');
        if(target.value.toLowerCase()===baseAccent().toLowerCase())delete draft.sectionColors[key];
        else draft.sectionColors[key]=target.value.toLowerCase();
        updateAppearancePreview();markChanged();return;
      }
      if(target.id==='diy-font-scale'){
        draft.fontScale=Number(target.value)/100;
        root.querySelector('#diy-font-scale-value').textContent=target.value+'%';
        updateAppearancePreview();markChanged();return;
      }
      if(target.id==='diy-portrait-scale'||target.id==='diy-portrait-x'||target.id==='diy-portrait-y'){
        savePortraitControls();renderPortraitPreview();markChanged();
      }
      if(target.id==='diy-bubble-radius'||target.id==='diy-bubble-opacity'){
        updateBubbleProposalField(target.id,target.value);
      }
    });
    root.addEventListener('change',function(event){
      var target=event.target;
      if(target.id==='diy-role-select'){selectRole(target.value);return}
      if(target.id==='diy-bubble-api'){selectedBubbleApiId=String(target.value||'');return}
      if(target.id==='diy-bubble-role'||target.id==='diy-bubble-preview-role'){
        selectedBubbleRoleId=String(target.value||'');syncBubbleRoleSelects();renderBubblePreview();return;
      }
      if(target.id==='diy-bubble-preview-slot'){
        var previewSlot=target.value;
        bubbleProposal=previewSlot!==''?copy(draft.bubbleSchemes[Number(previewSlot)]||null):null;
        renderBubblePreview();refreshBubbleActions();return;
      }
      if(target.id==='diy-bubble-save-slot'){selectedBubbleSlot=String(target.value||'0');refreshBubbleActions();return}
      if(target.id==='diy-bubble-binding-slot'){return}
      if(target.id==='diy-font-family'){
        draft.fontFamily=target.value==='serif'?'serif':'sans';updateAppearancePreview();markChanged();return;
      }
      if(target.id==='diy-chat-font'){
        draft.chatFont=target.value==='serif'?'serif':'inherit';updateAppearancePreview();markChanged();return;
      }
      if(target.id==='diy-widget-style'){
        draft.widgetStyle=['frost','ink'].indexOf(target.value)>=0?target.value:'default';updateAppearancePreview();markChanged();return;
      }
      if(target.id==='diy-card-shadow'){
        draft.cardShadow=target.checked;updateAppearancePreview();markChanged();return;
      }
      if(target.id==='diy-decorations'){
        draft.decorations=target.checked;updateAppearancePreview();markChanged();return;
      }
      if(target.id==='diy-tarot-style'){draft.tarotFaceStyle=target.value==='orrery'?'orrery':'veil';renderTarotPreview();markChanged();return}
      if(target.hasAttribute('data-asset-slot')){
        var key=target.getAttribute('data-asset-slot'),value=target.value;
        if(value==='default')delete draft.assets[key];
        else if(value!=='custom')draft.assets[key]=value;
        updateAssetPreview(key);renderTarotPreview();renderPortraitPreview();markChanged();
        return;
      }
      if(target.id==='diy-portrait-file'){readPortraitFile(target);return}
      if(target.hasAttribute('data-asset-file'))readAssetFile(target);
    });
    root.addEventListener('keydown',function(event){
      if(event.key==='ArrowRight'||event.key==='ArrowLeft'){
        var tab=event.target.closest('[role="tab"]');
        if(!tab)return;
        event.preventDefault();
        var index=tabs.indexOf(tab.getAttribute('data-tab'));
        var next=tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];
        selectTab(next);
        var button=root.querySelector('[data-tab="'+next+'"]');
        if(button)button.focus();
      }
    });
  }
  function updateControls(){
    accentWasClamped=false;
    var accent=root.querySelector('#diy-accent');
    accent.value=draft.accent;
    root.querySelector('#diy-accent-value').textContent=draft.accent.toUpperCase();
    root.querySelectorAll('[data-section-color]').forEach(function(input){
      var key=input.getAttribute('data-section-color');
      input.value=draft.sectionColors[key]||baseAccent();
    });
    var accentHelp=root.querySelector('#diy-accent-help');
    if(accentHelp)accentHelp.textContent='用于主要按钮、强调线与选中状态；低对比颜色会自动调深或调浅。';
    root.querySelector('#diy-tarot-style').value=draft.tarotFaceStyle;
    root.querySelector('#diy-font-scale').value=Math.round(draft.fontScale*100);
    root.querySelector('#diy-font-scale-value').textContent=Math.round(draft.fontScale*100)+'%';
    root.querySelector('#diy-font-family').value=draft.fontFamily;
    root.querySelector('#diy-chat-font').value=draft.chatFont;
    root.querySelector('#diy-card-shadow').checked=!!draft.cardShadow;
    root.querySelectorAll('[data-visual-setting="widgetStyle"]').forEach(function(button){button.classList.toggle('on',button.getAttribute('data-v')===draft.widgetStyle)});
    root.querySelector('#diy-decorations').checked=!!draft.decorations;
    renderAccentSwatches();
    selectVisualSection(activeVisualSection);
    updateAppearancePreview();
    renderAssetControls();
    renderRoleOptions();
    loadRoleControls();
    renderTarotPreview();
    renderPortraitPreview();
    renderVisualSchemes();
    renderBubbleControls();
    selectBubblePanel(activeBubblePanel);
    renderBubbleSlots();
    renderBubblePreview();
    refreshStatus();
  }
  function updateAppearancePreview(){
    var color=draft.accent||baseAccent();
    var preview=root.querySelector('#diy-theme-preview');
    if(preview)preview.style.setProperty('--diy-preview-accent',color);
    if(preview){
      preview.style.setProperty('--diy-preview-font-scale',String(draft.fontScale||1));
      preview.dataset.fontFamily=draft.fontFamily||'sans';
      preview.classList.toggle('no-shadow',!draft.cardShadow);
      preview.dataset.widgetStyle=draft.widgetStyle||'default';
    }
    var picker=root.querySelector('#diy-accent');
    if(picker)picker.value=color;
    root.querySelector('#diy-accent-value').textContent=color.toUpperCase();
    root.querySelectorAll('[data-preview-zone]').forEach(function(node){
      var key=node.getAttribute('data-preview-zone');
      node.style.setProperty('--diy-preview-zone',draft.sectionColors[key]||color);
    });
  }
  function renderAccentSwatches(){
    var host=root.querySelector('#diy-accent-swatches');if(!host)return;
    var base=baseAccent()||'#5080b0',palette=[{value:base,label:'主题默认'},{value:'#1c2330',label:'墨黑'},{value:'#f5f8fc',label:'雪白'},{value:'#8a94a8',label:'石灰'}];
    host.replaceChildren();
    palette.forEach(function(item){
      var button=document.createElement('button');button.type='button';button.className='sw'+(draft.accent.toLowerCase()===item.value.toLowerCase()?' on':'');
      button.title=item.label;button.setAttribute('aria-label',item.label);button.dataset.accentValue=item.value;button.style.background=item.value;host.appendChild(button);
    });
    var isPreset=palette.some(function(item){return item.value.toLowerCase()===draft.accent.toLowerCase()});
    var custom=document.createElement('button');custom.type='button';custom.className='sw sw-custom'+(isPreset?'':' on has');custom.title='自定义颜色';custom.setAttribute('aria-label','自定义强调色');custom.dataset.accentValue='custom';
    if(!isPreset)custom.style.setProperty('--cc',draft.accent);
    host.appendChild(custom);
    root.querySelectorAll('[data-zone-value]').forEach(function(label){var key=label.getAttribute('data-zone-value');label.textContent=draft.sectionColors[key]||'主题默认'});
  }
  function setVisualSetting(key,value){
    if(key!=='widgetStyle')return;
    draft.widgetStyle=['frost','ink'].indexOf(value)>=0?value:'default';
    root.querySelectorAll('[data-visual-setting="widgetStyle"]').forEach(function(button){button.classList.toggle('on',button.getAttribute('data-v')===draft.widgetStyle)});
    updateAppearancePreview();markChanged();
  }
  function renderAssetControls(){
    Core.ASSET_KEYS.forEach(function(key){
      var select=root.querySelector('[data-asset-slot="'+key+'"]');
      if(!select)return;
      var source=draft.assets[key]||'default';
      select.value=source==='default'?'default':(libraryOptions.indexOf(source)>=0?source:'custom');
      updateAssetPreview(key);
    });
  }
  function sourceForAsset(key,config){
    return config&&config.assets&&config.assets[key]?config.assets[key]:'';
  }
  function imageCss(source){
    if(!source)return '';
    return 'url("'+source+'")';
  }
  function updateAssetPreview(key){
    var element=root.querySelector('#diy-asset-preview-'+key);
    if(!element)return;
    var source=sourceForAsset(key,draft)||DEFAULT_PREVIEW_SOURCES[key]||'';
    element.style.backgroundImage=source?imageCss(source):'';
    var caption=element.querySelector('span');
    if(caption)caption.textContent=source?(source.indexOf('data:image/')===0?'本机导入素材':(draft.assets[key]?(Core.LIBRARY[source]||'素材预览'):'沿用内置素材')):'尚未选择素材';
  }
  function currentThemeKey(){
    return document.body.classList.contains('theme-infernal')?'infernal':'internal';
  }
  function visualSnapshot(config){
    config=config||draft;
    return {
      accent:config.accent,
      sectionColors:copy(config.sectionColors||{}),
      fontScale:config.fontScale||1,
      fontFamily:config.fontFamily||'sans',
      chatFont:config.chatFont||'inherit',
      cardShadow:config.cardShadow!==false,
      widgetStyle:config.widgetStyle||'default',
      decorations:config.decorations!==false,
      bubbleActive:copy(config.bubbleActive||{internal:'',infernal:''})
    };
  }
  function applyVisualSnapshot(snapshot){
    snapshot=Core.normalizeVisualSnapshot(snapshot,baseAccent());
    draft.accent=snapshot.accent;
    draft.sectionColors=snapshot.sectionColors;
    draft.fontScale=snapshot.fontScale;
    draft.fontFamily=snapshot.fontFamily;
    draft.chatFont=snapshot.chatFont;
    draft.cardShadow=snapshot.cardShadow;
    draft.widgetStyle=snapshot.widgetStyle;
    draft.decorations=snapshot.decorations;
    draft.bubbleActive=snapshot.bubbleActive;
    updateControls();
    markChanged();
  }
  function renderVisualSchemes(){
    var host=root.querySelector('#diy-visual-scheme-grid');
    if(!host)return;
    host.innerHTML='';
    for(var i=0;i<Core.VISUAL_SLOT_COUNT;i++){
      (function(index){
        var slot=draft.visualSchemes[index],row=document.createElement('div');
        row.className='uvt-row';
        var marker=document.createElement('i');marker.className='uvt-dot';marker.style.setProperty('--diy-scheme-accent',slot&&slot.snapshot&&slot.snapshot.accent||baseAccent());
        var meta=document.createElement('div');meta.className='uvt-m';
        var title=document.createElement('div');title.className='uvt-t';title.textContent=slot?slot.name:('方案 '+(index+1));
        var note=document.createElement('div');note.className='uvt-s';note.textContent=slot?'存于本机 · 配色 / 字体 / 投影 / 挂件':'空槽 · 保存当前 Visual 草稿';
        meta.appendChild(title);meta.appendChild(note);
        var name=document.createElement('input');name.className='diy-select uvt-name';name.type='text';name.maxLength=24;name.value=slot?slot.name:('方案 '+(index+1));name.dataset.visualName=String(index);name.setAttribute('aria-label','方案 '+(index+1)+' 名称');
        var actions=document.createElement('div');actions.className='uvt-ops';
        actions.innerHTML='<button type="button" class="btn mini" data-action="load-visual-slot" data-slot="'+index+'" '+(slot?'':'disabled')+'>预览草稿</button>'
          +'<button type="button" class="btn mini primary" data-action="apply-visual-slot" data-slot="'+index+'" '+(slot?'':'disabled')+'>一键应用</button>'
          +'<button type="button" class="btn mini" data-action="save-visual-slot" data-slot="'+index+'">'+(slot?'覆盖':'存入')+'</button>'
          +'<button type="button" class="btn mini" data-action="clear-visual-slot" data-slot="'+index+'" '+(slot?'':'disabled')+'>清除</button>';
        row.appendChild(marker);row.appendChild(meta);row.appendChild(name);row.appendChild(actions);host.appendChild(row);
      })(i);
    }
  }
  function saveVisualSlot(index){
    if(!Number.isInteger(index)||index<0||index>=Core.VISUAL_SLOT_COUNT)return;
    var current=draft.visualSchemes[index];
    if(current&&!window.confirm('覆盖「'+current.name+'」？'))return;
    var input=root.querySelector('[data-visual-name="'+index+'"]');
    draft.visualSchemes[index]={name:(input&&input.value||'方案 '+(index+1)).trim().slice(0,24)||('方案 '+(index+1)),snapshot:visualSnapshot(draft)};
    renderVisualSchemes();markChanged();notify('外观方案已加入草稿，点击「应用更改」后保存。');
  }
  function loadVisualSlot(index){
    var slot=draft.visualSchemes[index];
    if(!slot||!slot.snapshot)return;
    applyVisualSnapshot(slot.snapshot);
    notify('方案「'+slot.name+'」已载入草稿预览。');
  }
  function clearVisualSlot(index){
    if(!draft.visualSchemes[index])return;
    draft.visualSchemes[index]=null;
    renderVisualSchemes();markChanged();
  }
  function applyVisualSlot(index){
    var slot=draft.visualSchemes[index];
    if(!slot||!slot.snapshot)return;
    var snapshot=Core.normalizeVisualSnapshot(slot.snapshot,baseAccent());
    draft.accent=snapshot.accent;draft.sectionColors=snapshot.sectionColors;draft.fontScale=snapshot.fontScale;
    draft.fontFamily=snapshot.fontFamily;draft.chatFont=snapshot.chatFont;draft.cardShadow=snapshot.cardShadow;
    draft.widgetStyle=snapshot.widgetStyle;draft.decorations=snapshot.decorations;draft.bubbleActive=snapshot.bubbleActive;
    draftRevision++;updateControls();applyDraft();
  }
  function syncBubbleBindingControl(){
    var select=root.querySelector('#diy-bubble-binding-slot');
    if(!select)return;
    var binding=selectedBubbleRoleId&&draft.bubbleBindings[selectedBubbleRoleId];
    select.value=binding&&binding[selectedBubbleThemeKey()]||'';
  }
  function syncBubbleRoleSelects(){
    ['#diy-bubble-role','#diy-bubble-preview-role'].forEach(function(selector){
      var select=root.querySelector(selector);
      if(select)select.value=selectedBubbleRoleId;
    });
    syncBubbleBindingControl();
  }
  function renderRoleOptions(){
    function optionList(blankLabel){
      return '<option value="">'+esc(blankLabel)+'</option>'+roles.map(function(role){
        var name=role.nickname||role.model||role.provider||'角色';
        return '<option value="'+esc(role.id)+'">'+esc(name)+(role.model&&role.model!==name?' · '+esc(role.model):'')+'</option>';
      }).join('');
    }
    var select=root.querySelector('#diy-role-select');
    if(select){
      var old=selectedRoleId;
      select.innerHTML=optionList('选择角色');
      if(!roles.some(function(role){return String(role.id)===String(old)}))old=roles.length?String(roles[0].id):'';
      selectedRoleId=old;
      select.value=old;
      select.disabled=!roles.length;
    }
    var writerRoles=roles.filter(function(role){return !role.archived&&!role._group});
    var writer=root.querySelector('#diy-bubble-api');
    if(writer){
      writer.innerHTML='<option value="">'+(writerRoles.length?'选择执笔 API':'尚无可用 API')+'</option>'+writerRoles.map(function(role){
        var name=role.nickname||role.model||role.provider||'角色';
        return '<option value="'+esc(role.id)+'">'+esc(name)+(role.model&&role.model!==name?' · '+esc(role.model):'')+'</option>';
      }).join('');
      if(!writerRoles.some(function(role){return String(role.id)===String(selectedBubbleApiId)}))selectedBubbleApiId=writerRoles.length?String(writerRoles[0].id):'';
      writer.value=selectedBubbleApiId;
      writer.disabled=!writerRoles.length;
    }
    var bubbleRoles=roles.filter(function(role){return !role._group});
    ['#diy-bubble-role','#diy-bubble-preview-role'].forEach(function(selector){
      var bubbleRole=root.querySelector(selector);
      if(!bubbleRole)return;
      var blank=selector==='#diy-bubble-role'?'选择角色':'全局默认';
      bubbleRole.innerHTML='<option value="">'+blank+'</option>'+bubbleRoles.map(function(role){
        var name=role.nickname||role.model||role.provider||'角色';
        return '<option value="'+esc(role.id)+'">'+esc(name)+(role.model&&role.model!==name?' · '+esc(role.model):'')+'</option>';
      }).join('');
      if(!bubbleRoles.some(function(role){return String(role.id)===String(selectedBubbleRoleId)}))selectedBubbleRoleId='';
      bubbleRole.value=selectedBubbleRoleId;
      bubbleRole.disabled=selector==='#diy-bubble-role'&&!bubbleRoles.length;
    });
    syncBubbleBindingControl();
  }
  function selectedRole(){return roles.find(function(role){return String(role.id)===String(selectedRoleId)})||null}
  function selectRole(id){
    savePortraitControls();
    selectedRoleId=String(id||'');
    loadRoleControls();
    renderPortraitPreview();
  }
  function portraitRecord(){
    return selectedRoleId&&draft.portraits[selectedRoleId]?draft.portraits[selectedRoleId]:null;
  }
  function loadRoleControls(){
    var record=portraitRecord()||{scale:1,x:0,y:0};
    root.querySelector('#diy-portrait-scale').value=Math.round((record.scale||1)*100);
    root.querySelector('#diy-portrait-x').value=Math.round(record.x||0);
    root.querySelector('#diy-portrait-y').value=Math.round(record.y||0);
    updateRangeLabels();
    var remove=root.querySelector('[data-action="remove-portrait"]');
    if(remove)remove.disabled=!portraitRecord();
    var input=root.querySelector('#diy-portrait-file');
    if(input)input.disabled=!selectedRoleId;
    ['#diy-portrait-scale','#diy-portrait-x','#diy-portrait-y'].forEach(function(selector){
      var control=root.querySelector(selector);
      if(control)control.disabled=!portraitRecord();
    });
  }
  function savePortraitControls(){
    if(!selectedRoleId)return;
    var existing=draft.portraits[selectedRoleId];
    if(!existing)return;
    var scale=Number(root.querySelector('#diy-portrait-scale').value)/100;
    var x=Number(root.querySelector('#diy-portrait-x').value);
    var y=Number(root.querySelector('#diy-portrait-y').value);
    existing.scale=Math.max(.65,Math.min(1.5,scale));
    existing.x=Math.max(-100,Math.min(100,x));
    existing.y=Math.max(-100,Math.min(100,y));
    updateRangeLabels();
  }
  function updateRangeLabels(){
    var scale=root.querySelector('#diy-portrait-scale');
    var x=root.querySelector('#diy-portrait-x');
    var y=root.querySelector('#diy-portrait-y');
    root.querySelector('#diy-scale-value').textContent=scale.value+'%';
    root.querySelector('#diy-x-value').textContent=x.value;
    root.querySelector('#diy-y-value').textContent=y.value;
  }
  function renderPortraitPreview(){
    var scene=root.querySelector('#diy-room-preview-backdrop');
    var day=sourceForAsset('roomDay',draft)||DEFAULT_PREVIEW_SOURCES.roomDay;
    scene.style.backgroundImage=day?imageCss(day):'';
    var img=root.querySelector('#diy-room-portrait-img');
    var placeholder=root.querySelector('#diy-portrait-placeholder');
    var role=selectedRole();
    var record=portraitRecord();
    var src=record&&record.src?record.src:'';
    if(!src&&role&&typeof window.customPortraitSrc==='function')src=window.customPortraitSrc(role)||'';
    img.hidden=true;
    placeholder.hidden=false;
    if(src){
      var requestedSrc=String(src);
      img.onload=function(){
        if(img.getAttribute('src')!==requestedSrc)return;
        img.hidden=false;
        placeholder.hidden=true;
      };
      img.onerror=function(){
        if(img.getAttribute('src')!==requestedSrc)return;
        img.onload=null;
        img.onerror=null;
        img.removeAttribute('src');
        img.hidden=true;
        placeholder.hidden=false;
      };
      if(img.getAttribute('src')===requestedSrc&&img.complete&&img.naturalWidth>0){
        img.hidden=false;
        placeholder.hidden=true;
      }else{
        img.src=requestedSrc;
      }
    }else{
      img.onload=null;
      img.onerror=null;
      img.removeAttribute('src');
    }
    root.querySelector('#diy-preview-role-name').textContent=role?(role.nickname||role.model||'角色'):'角色名称';
    var scale=record?record.scale||1:1;
    var x=record?record.x||0:0;
    var y=record?record.y||0:0;
    root.querySelector('#diy-room-portrait').style.transform='translate('+Math.round(x*.3)+'px, '+Math.round(-y*.3)+'px) scale('+scale+')';
  }
  function renderTarotPreview(){
    var preview=root.querySelector('#diy-tarot-preview');
    var back=root.querySelector('#diy-tarot-preview-card');
    var cloth=sourceForAsset('tarotCloth',draft);
    var card=sourceForAsset('tarotBack',draft);
    preview.style.backgroundImage=cloth?imageCss(cloth):'';
    back.style.backgroundImage=card?imageCss(card):'';
    back.classList.toggle('has-custom-back',!!card);
    back.classList.toggle('is-orrery',draft.tarotFaceStyle==='orrery');
  }
  function currentThemeLabel(){return currentThemeKey()==='infernal'?'Infernal 暗色':'Internal 明亮'}
  function bubbleSlotIndex(value){
    var n=String(value==null?'':value);
    return /^(0|[1-9])$/.test(n)&&Number(n)<Core.BUBBLE_SLOT_COUNT?Number(n):-1;
  }
  function bubbleForSlot(value,config){
    var index=bubbleSlotIndex(value);
    return index>=0&&config&&Array.isArray(config.bubbleSchemes)?config.bubbleSchemes[index]||null:null;
  }
  function resolveBubbleScheme(roleId,config,themeOverride){
    config=config||draft;
    var theme=themeOverride||currentThemeKey(),slot='';
    if(roleId&&config.bubbleBindings&&config.bubbleBindings[String(roleId)]){
      slot=config.bubbleBindings[String(roleId)][theme]||'';
    }
    var bound=bubbleForSlot(slot,config);
    if(bound)return bound;
    slot=config.bubbleActive&&config.bubbleActive[theme]||'';
    return bubbleForSlot(slot,config);
  }
  function renderBubbleControls(){
    var theme=selectedBubbleThemeKey();
    function fill(select,includeDefault,defaultLabel){
      if(!select)return;
      select.innerHTML=(includeDefault?'<option value="">'+defaultLabel+'</option>':'')+draft.bubbleSchemes.map(function(scheme,index){
        return scheme?'<option value="'+index+'">'+esc(scheme.name||('方案 '+(index+1)))+'</option>':'';
      }).join('');
    }
    fill(root.querySelector('#diy-bubble-preview-slot'),true,'当前全局');
    fill(root.querySelector('#diy-bubble-binding-slot'),true,'跟随全局');
    var save=root.querySelector('#diy-bubble-save-slot');
    if(save){
      save.innerHTML=draft.bubbleSchemes.map(function(scheme,index){
        return '<option value="'+index+'">方案 '+(index+1)+(scheme?' · 覆盖「'+esc(scheme.name)+'」':' · 空槽')+'</option>';
      }).join('');
      save.value=String(bubbleSlotIndex(selectedBubbleSlot)>=0?selectedBubbleSlot:0);
    }
    var bind=root.querySelector('#diy-bubble-binding-slot'),assignment=selectedBubbleRoleId&&draft.bubbleBindings[selectedBubbleRoleId];
    if(bind)bind.value=assignment&&assignment[theme]||'';
    root.querySelectorAll('[data-bubble-theme-select]').forEach(function(button){
      var selected=button.getAttribute('data-bubble-theme-select')===theme;
      button.classList.toggle('cur',selected);
      var status=button.querySelector('[data-bubble-theme-status]');
      if(status)status.textContent=(selected?'当前主题 · ':'')+(draft.bubbleActive[theme]&&draft.bubbleSchemes[Number(draft.bubbleActive[theme])]?draft.bubbleSchemes[Number(draft.bubbleActive[theme])].name:'默认气泡');
    });
    refreshBubbleActions();
  }
  function rgb(hex){
    return [parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];
  }
  function linearChannel(value){
    value=value/255;
    return value<=.04045?value/12.92:Math.pow((value+.055)/1.055,2.4);
  }
  function colorLuminance(hex){
    if(!Core.isColor(hex))return 0;
    var channels=rgb(hex);
    return .2126*linearChannel(channels[0])+.7152*linearChannel(channels[1])+.0722*linearChannel(channels[2]);
  }
  function contrastRatio(a,b){
    var la=colorLuminance(a),lb=colorLuminance(b);
    return (Math.max(la,lb)+.05)/(Math.min(la,lb)+.05);
  }
  function mixHex(color,toWhite,amount){
    var a=rgb(color),b=toWhite?[255,255,255]:[0,0,0];
    return '#'+a.map(function(value,index){return Math.round(value*(1-amount)+b[index]*amount).toString(16).padStart(2,'0')}).join('');
  }
  function guardBubbleStop(color,foreground){
    if(!Core.isColor(color)||!Core.isColor(foreground)||contrastRatio(color,foreground)>=4.5)return color;
    var toWhite=colorLuminance(foreground)<.45,low=0,high=1;
    for(var i=0;i<22;i++){
      var mid=(low+high)/2,next=mixHex(color,toWhite,mid);
      if(contrastRatio(next,foreground)<4.5)low=mid;else high=mid;
    }
    return mixHex(color,toWhite,high);
  }
  function colorRgba(hex,alpha){
    var c=rgb(hex);
    return 'rgba('+c[0]+','+c[1]+','+c[2]+','+Math.max(0,Math.min(1,Number(alpha)||0)).toFixed(3)+')';
  }
  function bubbleSideProperties(scheme,side){
    var config=scheme&&scheme[side]?scheme[side]:Core.defaultBubbleScheme()[side];
    var foreground=config.textMode==='light'?'#f5f7fb':(config.textMode==='dark'?'#172033':baseToken('--surface-chat-bubble-fg'));
    if(!Core.isColor(foreground))foreground=baseToken('--content-primary');
    var stops=(config.stops||[]).map(function(color){return guardBubbleStop(color,foreground)});
    var background='';
    if(stops.length===1)background=colorRgba(stops[0],config.opacity);
    else if(stops.length>1)background='linear-gradient('+config.angle+'deg,'+stops.map(function(color){return colorRgba(color,config.opacity)}).join(',')+')';
    var border=config.borderColor?colorRgba(config.borderColor,config.borderOpacity):'';
    var radius=config.radius,tail=config.tail!==false,bottom=tail?'4px':radius+'px';
    var radiusCss=side==='user'?radius+'px '+radius+'px '+bottom+' '+radius+'px':radius+'px '+radius+'px '+radius+'px '+bottom;
    var shadow='';
    if(config.shadow>0&&stops.length)shadow='0 4px 18px '+colorRgba(stops[0],config.shadow);
    return {background:background,border:border,borderWidth:config.borderWidth+'px',borderStyle:config.borderStyle,
      radius:radiusCss,text:foreground,shadow:shadow,fontScale:String(config.fontScale||1),
      decoration:config.decoration||'none',decorationColor:config.decorationColor||stops[0]||baseAccent()};
  }
  function applyBubbleSide(element,scheme,side){
    var props=bubbleSideProperties(scheme,side);
    element.classList.add('ib-diy-bubble-custom');
    element.dataset.ibDiyBubbleSide=side;
    if(props.background)element.style.setProperty('--ib-diy-bubble-background',props.background);else element.style.removeProperty('--ib-diy-bubble-background');
    if(props.border)element.style.setProperty('--ib-diy-bubble-border-color',props.border);else element.style.removeProperty('--ib-diy-bubble-border-color');
    element.style.setProperty('--ib-diy-bubble-border-width',props.borderWidth);
    element.style.setProperty('--ib-diy-bubble-border-style',props.borderStyle);
    element.style.setProperty('--ib-diy-bubble-radius',props.radius);
    element.style.setProperty('--surface-chat-bubble-fg',props.text);
    element.style.setProperty('--ib-diy-bubble-shadow',props.shadow);
    element.style.setProperty('--ib-diy-bubble-font-scale',props.fontScale);
    element.style.setProperty('--ib-diy-bubble-decoration-color',props.decorationColor);
    element.classList.remove('ib-diy-deco-corner','ib-diy-deco-spark','ib-diy-deco-dots','ib-diy-deco-dash');
    if(props.decoration&&props.decoration!=='none')element.classList.add('ib-diy-deco-'+props.decoration);
  }
  function clearBubbleStyle(element){
    if(!element)return;
    element.classList.remove('ib-diy-bubble-custom','ib-diy-deco-corner','ib-diy-deco-spark','ib-diy-deco-dots','ib-diy-deco-dash');
    ['--ib-diy-bubble-background','--ib-diy-bubble-border-color','--ib-diy-bubble-border-width','--ib-diy-bubble-border-style','--ib-diy-bubble-radius','--surface-chat-bubble-fg','--ib-diy-bubble-shadow','--ib-diy-bubble-font-scale','--ib-diy-bubble-decoration-color'].forEach(function(key){element.style.removeProperty(key)});
    delete element.dataset.ibDiyBubbleSide;
  }
  function applyBubbleStyle(element,roleId,side){
    if(!element)return;
    var scheme=resolveBubbleScheme(roleId,applied);
    if(!scheme){clearBubbleStyle(element);return}
    applyBubbleSide(element,scheme,side==='user'?'user':'assistant');
  }
  function applyBubbleStylesToDom(){
    document.querySelectorAll('#page-chat .chat-msg.user, #page-chat .chat-msg.ai, #chat-panel .chat-msg.user, #chat-panel .chat-msg.ai').forEach(function(element){
      applyBubbleStyle(element,element.dataset.diyRoleId||element.dataset.friendId||'',element.classList.contains('user')?'user':'assistant');
    });
  }
  function previewBubbleStyle(element,side,scheme){
    clearBubbleStyle(element);
    if(scheme)applyBubbleSide(element,scheme,side);
  }
  function renderBubblePreview(){
    var roleSelect=root.querySelector('#diy-bubble-preview-role'),roleId=roleSelect?String(roleSelect.value||''):'';
    var slotSelect=root.querySelector('#diy-bubble-preview-slot');
    var scheme=bubbleProposal||(slotSelect&&slotSelect.value!==''?bubbleForSlot(slotSelect.value,draft):null)||resolveBubbleScheme(roleId,draft,selectedBubbleThemeKey());
    var base=Core.defaultBubbleScheme();
    root.querySelectorAll('[data-bubble-side]').forEach(function(element){
      previewBubbleStyle(element,element.getAttribute('data-bubble-side')==='user'?'user':'assistant',scheme||base);
    });
    root.querySelectorAll('[data-bubble-theme-current]').forEach(function(label){label.textContent=selectedBubbleThemeKey()==='infernal'?'Infernal 暗色':'Internal 明亮'});
  }
  function renderBubbleSlots(){
    var host=root.querySelector('#diy-bubble-slots');if(!host)return;
    host.innerHTML='';
    for(var i=0;i<Core.BUBBLE_SLOT_COUNT;i++){
      (function(index){
        var scheme=draft.bubbleSchemes[index],card=document.createElement('article');
        card.className='blx-slot'+(scheme?'':' empty');
        var title=document.createElement('strong');title.textContent='方案 '+(index+1);
        var mini=document.createElement('div');mini.className='blx-pv mini';
        var userRow=document.createElement('div');userRow.className='mrow user';var user=document.createElement('div');user.className='m user';user.textContent='我方消息';userRow.appendChild(user);
        var assistantRow=document.createElement('div');assistantRow.className='mrow ai';var assistant=document.createElement('div');assistant.className='m';assistant.textContent='TA 的消息';assistantRow.appendChild(assistant);
        mini.appendChild(assistantRow);mini.appendChild(userRow);
        if(scheme){previewBubbleStyle(user,'user',scheme);previewBubbleStyle(assistant,'assistant',scheme)}
        var label=document.createElement('div');label.className='blx-sn';label.textContent=scheme?'方案 '+(index+1)+' · '+scheme.name:'方案 '+(index+1)+' · 空槽';
        var buttons=document.createElement('div');buttons.className='blx-sb';
        buttons.innerHTML=scheme?'<button type="button" data-action="bubble-preview-slot" data-slot="'+index+'">预览</button><button type="button" data-action="bubble-activate-slot" data-slot="'+index+'">穿上</button><button type="button" data-action="bubble-save-at-slot" data-slot="'+index+'">覆盖</button><button type="button" data-action="bubble-delete-slot" data-slot="'+index+'">删</button>'
          :'<button type="button" data-action="bubble-save-at-slot" data-slot="'+index+'" '+(bubbleProposal?'':'disabled')+'>存当前</button>';
        card.appendChild(title);card.appendChild(mini);card.appendChild(label);card.appendChild(buttons);host.appendChild(card);
      })(i);
    }
  }
  function refreshBubbleActions(){
    root.querySelectorAll('[data-action="bubble-save-slot"],[data-action="bubble-set-global"],[data-action="bubble-save-at-slot"]').forEach(function(button){
      if(button.getAttribute('data-action')==='bubble-save-at-slot'&&button.getAttribute('data-slot')!==null&&!bubbleForSlot(button.getAttribute('data-slot'),draft))button.disabled=!bubbleProposal||bubbleBusy;
      else button.disabled=!bubbleProposal||bubbleBusy;
    });
  }
  function appendBubbleMessage(role,text){
    var log=root.querySelector('#diy-bubble-log');if(!log)return;
    var empty=log.querySelector('.blx-empty');if(empty)empty.remove();
    var message=document.createElement('div');message.className='blx-m '+(role==='user'?'u':'a');message.textContent=String(text||'').slice(0,900);
    log.appendChild(message);log.scrollTop=log.scrollHeight;
  }
  function clearBubbleConversation(){bubbleHistory=[];var log=root.querySelector('#diy-bubble-log');if(log){log.replaceChildren();var empty=document.createElement('div');empty.className='blx-empty';empty.textContent='我是水水。说一句想要的感觉，我会直接做成一套气泡给你预览。';log.appendChild(empty)}}
  function bubbleSystemPrompt(base){
    return '你是 Bubble Lab 的聊天气泡设计助手。只返回 JSON 对象，不要 HTML、CSS、JavaScript、SVG 或 Markdown。只允许 name、user、assistant 字段。user/assistant 气泡字段：stops（1-4 个 #RRGGBB 渐变颜色）、angle（0-360）、opacity（0.08-1）、borderColor（#RRGGBB）、borderWidth（0-4）、borderOpacity（0.05-1）、borderStyle（solid/dashed/double）、radius（4-32）、shadow（0-0.6）、fontScale（0.8-1.2）、tail（true/false）、decoration（none/corner/spark/dots/dash）、decorationColor（#RRGGBB）。未知字段会忽略。微调时返回完整 user 与 assistant 对象。当前方案：'+JSON.stringify(base||Core.defaultBubbleScheme());
  }
  function parseBubbleResponse(raw){
    raw=String(raw||'').trim();
    if(!raw||raw.length>16000)throw new Error('模型回复为空或过长，请重试。');
    if(/<\s*\/?\s*(svg|script|html|iframe|foreignObject)\b|javascript:|data:text\/html/i.test(raw))throw new Error('回复包含不支持的标记内容，已拒绝应用。');
    var text=raw,fence=String.fromCharCode(96),re=new RegExp(fence+fence+fence+'(?:json)?\\s*([\\s\\S]*?)'+fence+fence+fence,'i'),match=raw.match(re);
    if(match)text=match[1].trim();
    var parsed;
    try{parsed=JSON.parse(text)}catch(e){throw new Error('没有收到有效的 JSON 气泡方案，请再描述一次。')}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||(!parsed.user&&!parsed.assistant))throw new Error('回复缺少 user / assistant 气泡字段。');
    var base=bubbleProposal||Core.defaultBubbleScheme();
    function mergeSide(baseSide,value){
      var allowed=['stops','angle','opacity','borderColor','borderWidth','borderOpacity','borderStyle','radius','textMode','shadow','fontScale','tail','decoration','decorationColor'];
      var picked={};
      if(value&&typeof value==='object'&&!Array.isArray(value))allowed.forEach(function(key){
        if(Object.prototype.hasOwnProperty.call(value,key))picked[key]=value[key];
      });
      return Object.assign({},baseSide,picked);
    }
    return Core.normalizeBubbleScheme({
      name:typeof parsed.name==='string'?parsed.name:base.name,
      user:mergeSide(base.user,parsed.user),
      assistant:mergeSide(base.assistant,parsed.assistant)
    });
  }
  async function generateBubbleProposal(){
    if(bubbleBusy)return;
    var prompt=String(root.querySelector('#diy-bubble-prompt').value||'').trim();
    if(!prompt){notify('先写一句气泡设计方向。');return}
    var cfg=roles.find(function(role){return String(role.id)===String(selectedBubbleApiId)&&!role.archived&&!role._group});
    if(!cfg){notify('先选择一条已配置的角色 API。');return}
    if(typeof window.callApiChat!=='function'){notify('当前无法调用聊天 API。');return}
    bubbleBusy=true;refreshBubbleActions();
    var generate=root.querySelector('[data-action="bubble-generate"]');if(generate)generate.disabled=true;
    appendBubbleMessage('user',prompt);
    var history=[{role:'system',content:bubbleSystemPrompt(bubbleProposal||Core.defaultBubbleScheme())}].concat(bubbleHistory.slice(-8));
    history.push({role:'user',content:prompt});
    root.querySelector('#diy-bubble-prompt').value='';
    try{
      var requestCfg=Object.assign({},cfg,{streaming:false,thinkingEnabled:false,promptCache:false,webSearch:false});
      var response=await window.callApiChat(requestCfg,history,{
        _ibConsumer:'diy_bubble_lab',disableTools:true,autoContinue:false,wantThinking:false,
        _noWebSearch:true,jsonMode:true,maxTokens:1400,timeoutMs:90000,wantMeta:false
      });
      var raw=typeof response==='string'?response:(response&&typeof response.text==='string'?response.text:'');
      bubbleProposal=parseBubbleResponse(raw);
      bubbleHistory.push({role:'user',content:prompt},{role:'assistant',content:'已生成方案「'+bubbleProposal.name+'」。'});
      appendBubbleMessage('assistant','已生成方案「'+bubbleProposal.name+'」，可继续微调、预览或存入方案槽。');
      renderBubblePreview();refreshBubbleActions();
    }catch(error){
      appendBubbleMessage('assistant','生成失败，方案未应用。请检查所选 API 后重试。');
    }finally{
      bubbleBusy=false;
      if(generate)generate.disabled=false;
      refreshBubbleActions();
    }
  }
  function updateBubbleProposalField(id,value){
    if(!bubbleProposal){
      var slot=root.querySelector('#diy-bubble-preview-slot');
      bubbleProposal=Core.normalizeBubbleScheme(slot&&slot.value!==''?bubbleForSlot(slot.value,draft):(resolveBubbleScheme(selectedBubbleRoleId,draft,selectedBubbleThemeKey())||Core.defaultBubbleScheme()));
    }
    var next=copy(bubbleProposal),numeric=Number(value);
    ['user','assistant'].forEach(function(side){
      if(id==='diy-bubble-radius')next[side].radius=numeric;
      else if(id==='diy-bubble-opacity')next[side].opacity=numeric/100;
    });
    bubbleProposal=Core.normalizeBubbleScheme(next);
    root.querySelector('#diy-bubble-radius-value').textContent=Math.round(bubbleProposal.user.radius)+' px';
    root.querySelector('#diy-bubble-opacity-value').textContent=Math.round(bubbleProposal.user.opacity*100)+'%';
    renderBubblePreview();refreshBubbleActions();
  }
  function saveBubbleSlot(){
    if(!bubbleProposal)return;
    var index=bubbleSlotIndex(selectedBubbleSlot);if(index<0)return;
    if(draft.bubbleSchemes[index]&&!window.confirm('覆盖「'+draft.bubbleSchemes[index].name+'」？'))return;
    draft.bubbleSchemes[index]=Core.normalizeBubbleScheme(bubbleProposal);
    renderBubbleControls();renderBubbleSlots();renderBubblePreview();markChanged();
    notify('气泡方案已加入草稿，点击「应用更改」后保存。');
  }
  function saveAndSetBubbleGlobal(){
    if(!bubbleProposal){notify('先生成或选择一个气泡方案。');return}
    var index=bubbleSlotIndex(selectedBubbleSlot);
    if(index<0){notify('先选择一个保存槽。');return}
    var current=draft.bubbleSchemes[index];
    var normalized=Core.normalizeBubbleScheme(bubbleProposal);
    if(current&&JSON.stringify(current)!==JSON.stringify(normalized)&&!window.confirm('覆盖「'+current.name+'」并设为全局？'))return;
    draft.bubbleSchemes[index]=normalized;
    setBubbleGlobal(String(index));
    notify('气泡方案已保存到草稿并设为当前主题的全局默认。');
  }
  function setBubbleGlobal(value){
    var slot=String(value==null?selectedBubbleSlot:value||'');
    if(slot!==''&&!bubbleForSlot(slot,draft)){notify('这个方案槽目前是空的。');return}
    draft.bubbleActive[selectedBubbleThemeKey()]=slot;
    renderBubbleControls();renderBubbleSlots();renderBubblePreview();markChanged();
  }
  function bindBubbleRole(){
    if(!selectedBubbleRoleId){notify('先选择要绑定的角色。');return}
    var slot=String(root.querySelector('#diy-bubble-binding-slot').value||''),theme=selectedBubbleThemeKey();
    if(slot!==''&&!bubbleForSlot(slot,draft)){notify('这个方案槽目前是空的。');return}
    var binding=draft.bubbleBindings[selectedBubbleRoleId]||{internal:'',infernal:''};
    binding[theme]=slot;
    if(binding.internal||binding.infernal)draft.bubbleBindings[selectedBubbleRoleId]=binding;
    else delete draft.bubbleBindings[selectedBubbleRoleId];
    renderBubbleSlots();renderBubblePreview();markChanged();
    notify(slot?'角色气泡绑定已加入草稿。':'角色将跟随全局气泡，已加入草稿。');
  }
  function previewBubbleSlot(value){
    var scheme=bubbleForSlot(value,draft);if(!scheme)return;
    bubbleProposal=copy(scheme);selectedBubbleSlot=String(value);
    var preview=root.querySelector('#diy-bubble-preview-slot');if(preview)preview.value=String(value);
    var save=root.querySelector('#diy-bubble-save-slot');if(save)save.value=selectedBubbleSlot;
    renderBubblePreview();refreshBubbleActions();selectTab('bubble');selectBubblePanel('schemes');
  }
  function deleteBubbleSlot(value){
    var index=bubbleSlotIndex(value);if(index<0||!draft.bubbleSchemes[index])return;
    if(!window.confirm('清除气泡方案「'+draft.bubbleSchemes[index].name+'」？'))return;
    draft.bubbleSchemes[index]=null;
    ['internal','infernal'].forEach(function(theme){if(draft.bubbleActive[theme]===String(index))draft.bubbleActive[theme]=''});
    Object.keys(draft.bubbleBindings).forEach(function(roleId){
      ['internal','infernal'].forEach(function(theme){if(draft.bubbleBindings[roleId][theme]===String(index))draft.bubbleBindings[roleId][theme]=''});
      if(!draft.bubbleBindings[roleId].internal&&!draft.bubbleBindings[roleId].infernal)delete draft.bubbleBindings[roleId];
    });
    draft.visualSchemes.forEach(function(slot){
      if(!slot||!slot.snapshot||!slot.snapshot.bubbleActive)return;
      ['internal','infernal'].forEach(function(theme){if(slot.snapshot.bubbleActive[theme]===String(index))slot.snapshot.bubbleActive[theme]=''});
    });
    renderBubbleControls();renderBubbleSlots();renderBubblePreview();markChanged();
  }
  function readDataUrl(file){
    return new Promise(function(resolve,reject){
      if(!file||!/^image\/(png|jpeg|webp)$/.test(file.type||'')){reject(new Error('请选择 PNG、JPG 或 WebP 图片。'));return}
      if(file.size>MAX_UPLOAD_BYTES){reject(new Error('单张图片不能超过 5 MB。'));return}
      var reader=new FileReader();
      reader.onerror=function(){reject(new Error('读取图片失败。'))};
      reader.onload=function(){
        var source=String(reader.result||'');
        var img=new Image();
        img.onerror=function(){reject(new Error('图片无法解码，请换一张图片。'))};
        img.onload=function(){
          if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth>8192||img.naturalHeight>8192){reject(new Error('图片尺寸无效或超过 8192×8192。'));return}
          var safe=Core.safeImageSource(source);
          if(!safe){reject(new Error('图片格式未通过本地校验。'));return}
          resolve(safe);
        };
        img.src=source;
      };
      reader.readAsDataURL(file);
    });
  }
  function readPortraitFile(input){
    var file=input.files&&input.files[0];
    if(!file||!selectedRoleId){input.value='';return}
    readDataUrl(file).then(function(source){
      var existing=draft.portraits[selectedRoleId]||{scale:1,x:0,y:0};
      existing.src=source;
      existing.name=file.name||'';
      draft.portraits[selectedRoleId]=existing;
      loadRoleControls();
      renderPortraitPreview();
      markChanged();
      notify('立绘已加入草稿预览，点击“应用更改”后保存。');
    }).catch(function(error){notify(error.message||'导入图片失败。')}).finally(function(){input.value=''});
  }
  function readAssetFile(input){
    var file=input.files&&input.files[0];
    var key=input.getAttribute('data-asset-file');
    if(!file||Core.ASSET_KEYS.indexOf(key)<0){input.value='';return}
    readDataUrl(file).then(function(source){
      draft.assets[key]=source;
      renderAssetControls();
      renderTarotPreview();
      renderPortraitPreview();
      markChanged();
      notify(ASSET_LABELS[key]+'已加入草稿预览，点击“应用更改”后保存。');
    }).catch(function(error){notify(error.message||'导入图片失败。')}).finally(function(){input.value=''});
  }
  function removePortrait(){
    if(!selectedRoleId||!draft.portraits[selectedRoleId])return;
    delete draft.portraits[selectedRoleId];
    loadRoleControls();
    renderPortraitPreview();
    markChanged();
  }
  function clearAsset(key){
    if(Core.ASSET_KEYS.indexOf(key)<0)return;
    delete draft.assets[key];
    renderAssetControls();
    renderTarotPreview();
    renderPortraitPreview();
    markChanged();
  }
  function resetDraft(){
    draft=defaultConfig();
    draftRevision++;
    updateControls();
    notify('默认配置预览中；点击“应用更改”后才会移除已保存的自定义素材。');
  }
  function cancelDraft(){
    draft=copy(applied);
    draftRevision=appliedRevision;
    updateControls();
    notify('草稿已取消。');
  }
  function guardAccent(value){
    if(!Core.isColor(value))return applied.accent;
    var guarded=clampAccent(value);
    accentWasClamped=guarded.toLowerCase()!==value.toLowerCase();
    return guarded;
  }
  function luminance(hex){
    var rgb=[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)].map(function(v){v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});
    return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
  }
  function mix(hex,toWhite,amount){
    var a=[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];
    var b=toWhite?[255,255,255]:[0,0,0];
    return '#'+a.map(function(v,i){return Math.round(v*(1-amount)+b[i]*amount).toString(16).padStart(2,'0')}).join('');
  }
  function clampAccent(hex){
    var value=hex.toLowerCase(),lum=luminance(value);
    if(lum>=.19&&lum<=.30)return value;
    var toWhite=lum<.19,low=0,high=1;
    for(var i=0;i<22;i++){
      var mid=(low+high)/2,next=mix(value,toWhite,mid),nextLum=luminance(next);
      if(toWhite){if(nextLum<.22)low=mid;else high=mid}
      else{if(nextLum>.27)low=mid;else high=mid}
    }
    return mix(value,toWhite,high);
  }
  function applyDraft(){
    savePortraitControls();
    draft=Core.normalize(draft,baseAccent());
    var isDefault=Core.isDefault(draft,baseAccent());
    var write=isDefault?window.dbDelete('apiSettings',storageKey):window.dbPut('apiSettings',draft);
    Promise.resolve(write).then(function(){
      applied=copy(draft);
      appliedRevision=draftRevision;
      applyConfig(applied);
      updateControls();
      notify(isDefault?'已恢复默认视觉配置。':'视觉配置已应用并保存到本机用户数据。');
    }).catch(function(error){notify('保存失败：'+(error&&error.message||'IndexedDB 不可用'))});
  }
  function applyConfig(config){
    var html=document.documentElement;
    var body=document.body;
    var accent=config.accent;
    var baseline=baseAccent();
    if(config.fontScale&&config.fontScale!==1)html.style.fontSize=Math.round(config.fontScale*100)+'%';
    else html.style.removeProperty('font-size');
    if(config.fontFamily==='serif')html.style.setProperty('--font-ui','"Noto Serif SC","Source Han Serif SC",serif');
    else html.style.removeProperty('--font-ui');
    if(config.chatFont==='serif')body.dataset.ibDiyChatFont='serif';
    else delete body.dataset.ibDiyChatFont;
    ['--shadow-card','--shadow-panel','--shadow-floating'].forEach(function(token){
      if(config.cardShadow===false)body.style.setProperty(token,'none');
      else body.style.removeProperty(token);
    });
    body.dataset.ibDiyWidgetStyle=['frost','ink'].indexOf(config.widgetStyle)>=0?config.widgetStyle:'default';
    body.classList.toggle('ib-diy-no-decorations',config.decorations===false);
    if(accent&&accent.toLowerCase()!==baseline.toLowerCase()){
      html.style.setProperty('--accent',accent);
      html.style.setProperty('--accent-light','color-mix(in srgb, '+accent+' 58%, var(--content-primary) 42%)');
    }else{
      html.style.removeProperty('--accent');
      html.style.removeProperty('--accent-light');
    }
    applySectionColors(config);
    try{localStorage.setItem('ibTarotFaceStyle',config.tarotFaceStyle==='orrery'?'orrery':'veil')}catch(e){}
    if(typeof window.TAROT_FACE_STYLE==='string')window.TAROT_FACE_STYLE=config.tarotFaceStyle==='orrery'?'orrery':'veil';
    applyHomeBackgrounds(config);
    applyRoomAssets(document,config);
    applyBubbleStylesToDom();
  }
  function applySectionColors(config){
    ZONES.forEach(function(zone){
      document.querySelectorAll(zone.selector).forEach(function(element){
        var color=config.sectionColors[zone.key];
        if(color){
          element.classList.add(zone.className);
          element.style.setProperty('--ib-diy-region-tint',color);
        }else{
          element.classList.remove(zone.className);
          element.style.removeProperty('--ib-diy-region-tint');
        }
      });
    });
  }
  function applyHomeBackgrounds(config){
    var internal=document.getElementById('bg-internal-img'),infernal=document.getElementById('bg-infernal-img');
    var src=sourceForAsset('homeInternal',config);
    if(internal)internal.style.backgroundImage=src?imageCss(src):'';
    src=sourceForAsset('homeInfernal',config);
    if(infernal)infernal.style.backgroundImage=src?imageCss(src):'';
    applyCanvasBackground(config);
  }
  function matchingElements(scope,selector){
    var found=[];
    if(scope&&scope.nodeType===1&&scope.matches&&scope.matches(selector))found.push(scope);
    if(scope&&scope.querySelectorAll)found=found.concat(Array.prototype.slice.call(scope.querySelectorAll(selector)));
    return found;
  }
  function setImageSource(scope,selector,key,config){
    var src=sourceForAsset(key,config);
    var defaults={storyWinDay:'game/story_win_day.png',storyWinNight:'game/story_win_night.png',teaInternal:'game/tea_select_bg_internal.png',teaInfernal:'game/tea_select_bg_infernal.png',teaChat:'game/tea_chat_bg.png'};
    matchingElements(scope,selector).forEach(function(element){
      if(src){if(element.getAttribute('src')!==src)element.setAttribute('src',src)}
      else if(defaults[key])element.setAttribute('src',defaults[key]);
    });
  }
  function applyRoomAssets(scope,config){
    config=config||applied;
    if(!scope)return;
    applySectionColors(config);
    var day=sourceForAsset('roomDay',config),night=sourceForAsset('roomNight',config);
    matchingElements(scope,'.game-bg-day').forEach(function(el){el.style.backgroundImage=day?imageCss(day):''});
    matchingElements(scope,'.game-bg-night').forEach(function(el){el.style.backgroundImage=night?imageCss(night):''});
    var cloth=sourceForAsset('tarotCloth',config);
    matchingElements(scope,'#game-tarot').forEach(function(el){
      if(cloth){el.style.backgroundImage='linear-gradient(rgba(8,12,25,.32), rgba(8,12,25,.32)), '+imageCss(cloth)}
      else el.style.backgroundImage='';
      var back=sourceForAsset('tarotBack',config);
      if(back){el.classList.add('diy-has-card-back');el.style.setProperty('--ib-diy-tarot-back-image',imageCss(back))}
      else{el.classList.remove('diy-has-card-back');el.style.removeProperty('--ib-diy-tarot-back-image')}
    });
    setImageSource(scope,'#sw-bg-day','storyWinDay',config);
    setImageSource(scope,'#sw-bg-night','storyWinNight',config);
    setImageSource(scope,'#tea-bg-internal','teaInternal',config);
    setImageSource(scope,'#tea-bg-infernal','teaInfernal',config);
    setImageSource(scope,'.game-tea-chat-bg','teaChat',config);
    applyCanvasBackground(config);
  }
  function applyCanvasBackground(config){
    var source=sourceForAsset('canvas',config||applied);
    var image=document.getElementById('gw-img');
    if(image){
      if(source)image.style.backgroundImage=imageCss(source);
      else if(image.getAttribute('data-ib-diy-default-bg'))image.style.backgroundImage=image.getAttribute('data-ib-diy-default-bg');
      else image.style.removeProperty('background-image');
    }
  }
  function applyPortrait(element,cfg){
    if(!element)return;
    var record=cfg&&cfg.id&&applied.portraits[String(cfg.id)];
    if(!record){element.style.removeProperty('--ib-diy-portrait-scale');element.style.removeProperty('--ib-diy-portrait-x');element.style.removeProperty('--ib-diy-portrait-y');return}
    element.style.setProperty('--ib-diy-portrait-scale',String(record.scale||1));
    element.style.setProperty('--ib-diy-portrait-x',String(record.x||0)+'px');
    element.style.setProperty('--ib-diy-portrait-y',String(-(record.y||0))+'px');
  }
  function portraitSource(cfg){
    var record=cfg&&cfg.id&&applied.portraits[String(cfg.id)];
    return record&&record.src||'';
  }
  function readSavedConfig(){
    if(loading)return loadPromise;
    loading=true;
    root.setAttribute('aria-busy','true');
    loadPromise=Promise.resolve().then(function(){return window.dbGet('apiSettings',storageKey)}).then(function(record){
      applied=Core.normalize(record,baseAccent());
      if(Core.isColor(applied.accent))applied.accent=clampAccent(applied.accent);
      applied.tarotFaceStyle=readTarotStyle();
      draft=copy(applied);
      draftRevision=0;
      appliedRevision=0;
      applyConfig(applied);
      updateControls();
      loadRoles();
    }).catch(function(){
      applied=defaultConfig();
      applied.tarotFaceStyle=readTarotStyle();
      draft=copy(applied);
      draftRevision=0;
      appliedRevision=0;
      updateControls();
      loadRoles();
      notify('本机存储暂不可用，配置不会被写入。');
    }).finally(function(){
      loading=false;
      loaded=true;
      root.removeAttribute('aria-busy');
    });
    return loadPromise;
  }
  function readTarotStyle(){
    try{var value=localStorage.getItem('ibTarotFaceStyle');if(value==='orrery'||value==='veil')return value}catch(e){}
    return 'veil';
  }
  function loadRoles(){
    return Promise.resolve().then(function(){return window.dbGetAll('apiConfigs')}).then(function(rows){
      roles=(Array.isArray(rows)?rows:[]).filter(function(row){return row&&typeof row.id==='string'&&row.id});
      renderRoleOptions();
      loadRoleControls();
      renderPortraitPreview();
    }).catch(function(){roles=apiRoleFallback();renderRoleOptions();loadRoleControls();renderPortraitPreview()});
  }
  function apiRoleFallback(){
    return Array.isArray(window.apiConfigs)?window.apiConfigs.filter(function(row){return row&&row.id}):[];
  }
  function onPageEnter(){
    hideRoomEdgeOverlap();
    if(!loaded||isDirty())return;
    readyPromise=readSavedConfig();
  }
  function hideRoomEdgeOverlap(){
    try{
      var room=window.IB&&window.IB.room;
      if(!room||typeof room.isRoomEdgeTab!=='function')return;
      document.querySelectorAll('body *').forEach(function(element){
        if(room.isRoomEdgeTab(element))element.classList.add('ib-diy-room-edge-tab');
      });
    }catch(e){}
  }
  function installObservers(){
    var page=document.getElementById('page-diy');
    if(page&&window.MutationObserver){
      var observer=new MutationObserver(function(){
        if(page.classList.contains('active'))onPageEnter();
      });
      observer.observe(page,{attributes:true,attributeFilter:['class']});
    }
    if(window.MutationObserver){
      var themeObserver=new MutationObserver(function(){
        applySectionColors(applied);applyBubbleStylesToDom();
        renderBubbleControls();renderBubbleSlots();renderBubblePreview();
      });
      themeObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
    }
  }
  function init(){
    mount();
    if(window.IBPuppetStudio&&typeof window.IBPuppetStudio.mount==='function')window.IBPuppetStudio.mount(root);
    readyPromise=readSavedConfig();
    installObservers();
  }
  function getAssetSource(key){return sourceForAsset(key,applied)}
  function api(){
    return Object.freeze({
      ready:readyPromise,
      getAssetSource:getAssetSource,
      getPortraitSource:portraitSource,
      applyPortrait:applyPortrait,
      applyRoomAssets:applyRoomAssets,
      applyCanvasBackground:applyCanvasBackground,
      applyBubbleStyle:applyBubbleStyle,
      getAppliedConfig:function(){return copy(applied)},
      getDraftConfig:function(){return copy(draft)},
      isDirty:function(){return dirty},
      resetDraft:resetDraft,
      cancelDraft:cancelDraft,
      applyDraft:applyDraft
    });
  }
  init();
  window.IBDIYWorkshop=api();
  NS.expose('diyWorkshop',window.IBDIYWorkshop);
})(window.IB||{expose:function(name,value){window.IB=window.IB||{};window.IB[name]=value}});
