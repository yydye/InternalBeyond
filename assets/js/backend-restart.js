/* Silent backend restart (UI) — 一键静默重启本地后端（Bridge 23115 + Active 23114）。
 * 走本地 localhost 重启控制面（local-services-runner.js 内置）：
 *   POST /restart   发起重启（互斥：进行中再点会被隔离/忽略）
 *   GET  /status    查询 idle|restarting|ready|failed
 * 页面不在重启过程中刷新、不丢聊天状态；ready 后复用既有 IBNET WebSocket 重连
 * 与 active-companion 健康检查恢复连接。不新增第二套连接系统。 */
(function(NS){
'use strict';

var RESTART_DEFAULT_PORT = 23116;
var RESTART_TIMEOUT_MS = 38000;   /* 与 runner waitUntilHealthy(25s)x2 对齐，留裕量 */
var STATE_TEXT = { idle: '后端空闲', restarting: '正在重启…', ready: '后端已重启', failed: '后端重启失败，请查看诊断信息' };
var _state = 'idle';
var _busy = false;
var _lastError = '';

function restartBase(){
  var port = RESTART_DEFAULT_PORT;
  try{
    if(window.IB_RESTART_PORT && /^\d+$/.test(String(window.IB_RESTART_PORT))) port = Number(window.IB_RESTART_PORT);
  }catch(e){}
  return 'http://127.0.0.1:' + port;
}

/* 确保注入的控制行在“后端连接卡”里存在（renderNet 会整卡重绘，用观察器补回）。 */
/* 通过 <style> 注入极简样式（不占用 style= 内联预算）。 */
function ensureStyle(){
  if(document.getElementById('ib-rs-style')) return;
  var st = document.createElement('style');
  st.id = 'ib-rs-style';
  st.textContent =
    '#ib-rs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--glass-border);font-size:0.82rem}' +
    '#ib-rs-row .ib-rs-status{opacity:0.75}' +
    '#ib-rs-row .ib-rs-status.ib-rs-ready{color:var(--accent-light);opacity:1}' +
    '#ib-rs-row .ib-rs-status.ib-rs-failed{color:#c46060;opacity:1}';
  document.head.appendChild(st);
}

function ensureControl(){
  ensureStyle();
  var box = document.getElementById('ib-net-body');
  if(!box) return;
  if(document.getElementById('ib-rs-row')) return;
  var row = document.createElement('div');
  row.id = 'ib-rs-row';
  row.className = 'ib-rs-row';
  row.innerHTML =
    '<span class="ib-rs-status" id="ib-rs-status">' + STATE_TEXT[_state] + '</span>' +
    '<button class="btn btn-primary" id="ib-rs-btn" type="button">重启后端</button>';
  box.appendChild(row);
  var btn = document.getElementById('ib-rs-btn');
  if(btn) btn.onclick = function(){ ibRestartBackend(); };
  syncStatusEl();
}
function startObserver(){
  if(window.__ibRsObserver) return;
  window.__ibRsObserver = true;
  try{
    var mo = new MutationObserver(function(){ ensureControl(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }catch(e){}
  ensureControl();
}
function syncStatusEl(){
  var el = document.getElementById('ib-rs-status');
  var btn = document.getElementById('ib-rs-btn');
  if(el){
    el.textContent = STATE_TEXT[_state];
    el.classList.toggle('ib-rs-failed', _state === 'failed');
    el.classList.toggle('ib-rs-ready', _state === 'ready');
  }
  if(btn) btn.disabled = (_state === 'restarting' || _busy);
}
function say(msg){ try{ if(typeof toast === 'function') toast(msg); }catch(e){} }

function getStatus(){
  var ctl = new AbortController();
  var tm = setTimeout(function(){ ctl.abort(); }, 4000);
  return fetch(restartBase() + '/status', { cache: 'no-store', signal: ctl.signal })
    .then(function(r){ return r.ok ? r.json() : null; })
    .catch(function(){ return null; })
    .finally(function(){ clearTimeout(tm); });
}

/* 重启完成后触发既有连接恢复（不改连接系统，只“踹”一下现有重连逻辑）。 */
function nudgeExistingReconnects(){
  try{
    if(typeof IBNET !== 'undefined' && IBNET && typeof IBNET.cfg === 'function'){
      var c = IBNET.cfg();
      if(c && c.enabled && c.url && typeof IBNET.connect === 'function') IBNET.connect(true);
    }
  }catch(e){}
  try{
    if(typeof window._activeCheckCompanion === 'function') window._activeCheckCompanion(true, true);
  }catch(e){}
}

function setState(s){
  _state = s;
  syncStatusEl();
}

function pollUntilDone(){
  return new Promise(function(resolve){
    var deadline = Date.now() + RESTART_TIMEOUT_MS;
    var tick = function(){
      getStatus().then(function(s){
        if(!s){ if(Date.now() < deadline){ setTimeout(tick, 900); return; } resolve({ state: 'failed', error: 'restart-control-unreachable' }); return; }
        if(s.state === 'restarting'){ if(Date.now() < deadline){ setTimeout(tick, 1400); return; } resolve({ state: 'failed', error: 'timeout' }); return; }
        resolve({ state: s.state === 'ready' ? 'ready' : 'failed', error: s.error || '' });
      });
    };
    tick();
  });
}

/* 主入口：幂等，_busy=true 期间重复调用直接被忽略（防重复点击 → 防多实例）。 */
function ibRestartBackend(){
  if(_busy || _state === 'restarting'){ say('重启已在进行中'); return false; }
  _busy = true;
  setState('restarting');
  var ctl = new AbortController();
  var tm = setTimeout(function(){ ctl.abort(); }, 6000);
  fetch(restartBase() + '/restart', { method: 'POST', cache: 'no-store', signal: ctl.signal })
    .then(function(r){
      return { status: r.status, body: r.json ? r.json().catch(function(){ return null; }) : null };
    })
    .then(function(res){
      clearTimeout(tm);
      if(res.status === 409){ _busy = false; say('后端正在重启…'); return; }          /* 已在重启：优雅忽略 */
      if(res.status === 403){ _busy = false; setState('idle'); say('触发被拒绝：本地 Origin 校验失败'); return; }
      if(res.status !== 202 && res.status !== 200){ _busy = false; fail('restart-control-error'); return; }
      /* 已接单：查询直至 ready/failed */
      return pollUntilDone().then(function(out){
        _busy = false;
        if(out.state === 'ready'){ setState('ready'); _lastError = ''; say('后端已重启'); nudgeExistingReconnects(); }
        else { fail(out.error || 'restart-failed'); }
      });
    })
    .catch(function(){
      clearTimeout(tm);
      _busy = false;
      fail('restart-control-unreachable');
    });
}
function fail(reason){
  _lastError = String(reason || '');
  setState('failed');
  say('后端重启失败，请查看诊断信息');
}

/* 挂 window（供内联/测试/日志）并注册到 IB 命名空间。 */
window.ibRestartBackend = ibRestartBackend;
window.__ibRestartState = function(){ return { state: _state, lastError: _lastError }; };
NS.backendRestart = { trigger: ibRestartBackend, state: function(){ return _state; }, getStatus: getStatus };

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver);
  else startObserver();
}

})(window.IB || (window.IB = {}));
