/* ============================================================
   window.IB — 全局命名空间（Internal Beyond 前端 API 收拢点）
   ------------------------------------------------------------
   约定：
   1. 本脚本在全部 assets 脚本之前加载，创建 window.IB 与 IB.section()。
   2. 每个领域脚本在自己的命名空间下注册导出（IB.chat / IB.memory / IB.room …）。
   3. 迁移期采用双挂载：函数同时保留在 window 与 IB 下，全部文件迁移完成后
      再移除 window 挂载（在此之前任何脚本的加载顺序与全局调用不受影响）。
   ============================================================ */
(function(){
  var IB = window.IB || {};
  window.IB = IB;
  if (!IB.__boot) {
    IB.__boot = { version: 1, loadedAt: Date.now() };
  }
  /* IB.section('chat.letters') -> IB.chat.letters（自动建链） */
  IB.section = function(name){
    var parts = String(name || '').split('.').filter(Boolean);
    var node = IB;
    for (var i = 0; i < parts.length; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    return node;
  };
  /* IB.expose(ns, obj)：注册导出（幂等合并） */
  IB.expose = function(name, exports){
    var node = IB.section(name);
    if (exports) {
      for (var k in exports) {
        if (Object.prototype.hasOwnProperty.call(exports, k)) node[k] = exports[k];
      }
    }
    return node;
  };
})();
