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
