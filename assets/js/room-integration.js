/* ROOM 侧边标签上移：避开右下角 Chat 悬浮窗 */
/* IB 命名空间迁移：注册到 IB.room（双挂载过渡期，行为不变）。 */
(function(NS){
  var ROOM_TAB_TOP='25vh';

  function norm(value){
    return String(value||'').replace(/[^a-z]/gi,'').toLowerCase();
  }

  function isRoomEdgeTab(el){
    if(!(el instanceof HTMLElement))return false;
    var labels=[el.getAttribute('aria-label'),el.getAttribute('title'),el.textContent];
    if(!labels.some(function(value){return norm(value)==='room'}))return false;

    var style=getComputedStyle(el);
    if(style.position!=='fixed')return false;

    var rect=el.getBoundingClientRect();
    return style.right!=='auto'||rect.right>=window.innerWidth-24;
  }

  function moveRoomTab(root){
    var nodes=[];
    if(root instanceof HTMLElement)nodes.push(root);
    if(root&&root.querySelectorAll)nodes=nodes.concat(Array.prototype.slice.call(root.querySelectorAll('*')));

    for(var i=0;i<nodes.length;i++){
      if(!isRoomEdgeTab(nodes[i]))continue;
      nodes[i].style.setProperty('top',ROOM_TAB_TOP,'important');
      nodes[i].style.setProperty('bottom','auto','important');
      return true;
    }
    return false;
  }

  if(moveRoomTab(document.body)){NS.expose('room', { moveRoomTab: moveRoomTab, isRoomEdgeTab: isRoomEdgeTab });return;}

  var observer=new MutationObserver(function(records){
    for(var i=0;i<records.length;i++){
      for(var j=0;j<records[i].addedNodes.length;j++){
        var node=records[i].addedNodes[j];
        if(node.nodeType===1&&moveRoomTab(node)){
          observer.disconnect();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('load',function(){
    if(moveRoomTab(document.body))observer.disconnect();
  },{once:true});
  NS.expose('room', { moveRoomTab: moveRoomTab, isRoomEdgeTab: isRoomEdgeTab });
})(window.IB || (window.IB = {}));
