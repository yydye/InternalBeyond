(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var tauri = root.__TAURI__;
  var invoke = tauri && tauri.core && tauri.core.invoke;
  if (typeof invoke !== 'function') return;

  var doc = root.document;
  var banner = doc.createElement('div');
  banner.id = 'ib-tauri-runtime-status';
  banner.className = 'ib-tauri-runtime-status';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.hidden = true;
  doc.body.appendChild(banner);

  var lastText = '';
  var stopped = false;
  function render(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    var visible = snapshot.state === 'HOST_STARTING' || snapshot.degraded === true;
    if (!visible) {
      banner.hidden = true;
      lastText = '';
      if (snapshot.hostReady === true) stopped = true;
      return;
    }
    var text = String(snapshot.message || '本地服务正在准备');
    banner.dataset.state = snapshot.degraded === true ? 'degraded' : 'starting';
    if (text !== lastText) {
      banner.textContent = text;
      lastText = text;
    }
    banner.hidden = false;
  }

  function refresh() {
    if (stopped) return;
    Promise.resolve(invoke('tauri_runtime_status')).then(render).catch(function () {
      /* Native status can be briefly unavailable while the Host is wiring up. */
    });
  }

  refresh();
  var timer = root.setInterval(function () {
    refresh();
    if (stopped) root.clearInterval(timer);
  }, 1200);
})(typeof window !== 'undefined' ? window : null);
