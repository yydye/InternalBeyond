/* PRELOADER — 仅遮罩，不触碰 #splash 任何 style/class，资源就绪后自行淡出 */
(function(){
  var pre=document.getElementById('preloader');
  if(!pre)return;
  var revealed=false;
  function reveal(){
    if(revealed)return;
    revealed=true;
    pre.classList.add('fade-out');
    setTimeout(function(){
      if(pre.parentNode)pre.parentNode.removeChild(pre);
    },1500);
  }
  if(document.readyState==='complete'){
    setTimeout(reveal,200);
  }else{
    window.addEventListener('load',function(){setTimeout(reveal,350)});
    /* 兜底：最长 10s */
    setTimeout(reveal,10000);
  }
})();

/* RAIN VISIBILITY — splash 期间隐藏雨丝避免 b */
(function(){
  var rc=document.getElementById('rain-container');
  var sp=document.getElementById('splash');
  if(!rc||!sp)return;
  function show(){rc.classList.add('rain-visible')}
  if(sp.classList.contains('hidden')){show();return}
  var obs=new MutationObserver(function(){
    if(sp.classList.contains('dissolving')||sp.classList.contains('hidden')){
      show(); obs.disconnect();
    }
  });
  obs.observe(sp,{attributes:true,attributeFilter:['class']});
})();
/* IB 命名空间迁移：注册所有权标记（副作用脚本，行为不变）。 */
(function(NS){
  NS.expose('preloader', { mounted: true });
})(window.IB || (window.IB = {}));

/* ---- UI-P2 · Chat Image Deck 的加载接缝 ----
   assets/js/chat-image-deck.js 由本文件在运行时注入，因此不需要改动
   InternalBeyond.html（用户 own 且 dirty），也不需要改动
   assets/js/communication.js（同样 dirty）—— deck 完全位于渲染器之外：
   它观察 #chat-full-messages / #chat-messages，把 renderer 已经追加的那一段
   <img class="chat-bubble-img"> 重新组合成叠层，并保留图片自己的 onclick
   → 既有 viewer。做法与 communication.js（behavior-effect-render.js）和
   app-store.js 的动态注入一致；失败时静默退化，聊天原有功能不受影响。 */
(function loadChatImageDeck(){
  if (!document || !document.head) return;
  if (document.getElementById('ib-chat-image-deck-loader')) return;
  var s=document.createElement('script');
  s.id='ib-chat-image-deck-loader';
  s.src='assets/js/chat-image-deck.js';
  document.head.appendChild(s);
})();
