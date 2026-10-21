(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.IBAppBuilderCore = api;
    if (root.IB) { root.IB.appBuilder = api; }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var FILE_NAMES = Object.freeze(['index.html', 'styles.css', 'app.js']);
  var FILE_LIMIT = 24 * 1024;
  var TOTAL_LIMIT = 64 * 1024;
  var livePreviewIds = Object.create(null);
  var pagehideCleanupInstalled = false;
  function validFiles(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && FILE_NAMES.every(function (name) {
        return typeof value[name] === 'string' && value[name].length > 0
          && new Blob([value[name]]).size <= FILE_LIMIT;
      }) && Object.keys(value).every(function (name) { return FILE_NAMES.indexOf(name) >= 0; })
      && FILE_NAMES.reduce(function (sum, name) { return sum + new Blob([value[name]]).size; }, 0) <= TOTAL_LIMIT
      && !/<\s*(?:script|iframe|frame|object|embed|base|link)\b|\son[a-z]+\s*=|javascript\s*:|\s(?:href|src|target)\s*=|<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(value['index.html'])
      && !/@import\b|url\s*\(/i.test(value['styles.css'])
      && !/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|localStorage|sessionStorage|indexedDB|navigator|history|location)\b|\b(?:parent|top|opener)\b|\bdocument\.(?:cookie|domain|forms)\b|\bwindow\s*\.\s*open\b|\bopen\s*\(/i.test(value['app.js']);
  }
  function normalizeDraft(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.draftRef !== 'string' || !/^ad_[A-Fa-f0-9-]{36}$/.test(value.draftRef)
      || !validFiles(value.files)) return null;
    return { draftRef: value.draftRef, projectRef: String(value.projectRef || ''), name: String(value.name || 'Generated App').slice(0, 48),
      version: Number(value.version) || 0, files: { 'index.html': value.files['index.html'], 'styles.css': value.files['styles.css'], 'app.js': value.files['app.js'] },
      changes: value.changes && typeof value.changes === 'object' ? value.changes : {} };
  }
  function appIdForDraft(draftRef) {
    var match = String(draftRef || '').match(/^ad_([A-Fa-f0-9-]{36})$/);
    return match ? 'dsh-' + match[1].replace(/-/g, '').slice(0, 24).toLowerCase() : '';
  }
  function diff(before, after) {
    before = before == null ? '' : String(before);
    after = after == null ? '' : String(after);
    if (before === after) return '（无变化）';
    if (!before) return after.split('\n').map(function (line) { return '+ ' + line; }).join('\n');
    if (!after) return before.split('\n').map(function (line) { return '- ' + line; }).join('\n');
    var left = before.split('\n'), right = after.split('\n'), start = 0, suffix = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    while (suffix < left.length - start && suffix < right.length - start
      && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
    var out = [];
    if (start) out.push('  … ' + start + ' unchanged lines');
    left.slice(start, left.length - suffix).forEach(function (line) { out.push('- ' + line); });
    right.slice(start, right.length - suffix).forEach(function (line) { out.push('+ ' + line); });
    if (suffix) out.push('  … ' + suffix + ' unchanged lines');
    return out.join('\n').slice(0, 12000);
  }
  function buildSrcdoc(value) {
    var draft = normalizeDraft(value);
    if (!draft) return '';
    var csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; form-action \'none\'; navigate-to \'none\'; object-src \'none\'; base-uri \'none\'; frame-src \'none\'">';
    var html = draft.files['index.html'];
    var bootData = JSON.stringify({ draftRef: draft.draftRef, css: draft.files['styles.css'], js: draft.files['app.js'] }).replace(/</g, '\\u003c');
    /* Clear exposed globals where the WebView permits it. The native invoke
       key/origin checks remain the authority if Tauri installs a non-configurable internal bridge in a child. */
    var boot = '<script>(function(p){var seq=0,pending=Object.create(null),runtimeError=false;function notify(type){try{parent.postMessage({type:type,draftRef:p.draftRef},"*")}catch(_){}}' +
      'function scrubTauriBridge(){if(window.top!==window){["__TAURI__","__TAURI_INTERNALS__"].forEach(function(key){try{window[key]=undefined;delete window[key]}catch(_){try{Object.defineProperty(window,key,{value:undefined,configurable:false})}catch(__){}}})}}scrubTauriBridge();' +
      'window.addEventListener("error",function(){runtimeError=true;notify("ib-generated-app-runtime-error")});window.addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.type!=="ib-generated-app-storage-response")return;var wait=pending[e.data.requestId];if(wait){delete pending[e.data.requestId];wait(e.data)}});' +
      'function call(action,key,value){return new Promise(function(resolve){var requestId="appstore-"+(++seq)+"-"+Date.now();pending[requestId]=resolve;parent.postMessage({type:"ib-generated-app-storage-request",requestId:requestId,action:action,key:String(key||""),value:value},"*");setTimeout(function(){if(pending[requestId]){delete pending[requestId];resolve({ok:false,error:"storage-timeout"})}},3000)})}' +
      'window.AppStorage=Object.freeze({get:function(k){return call("get",k)},set:function(k,v){return call("set",k,v)},remove:function(k){return call("remove",k)}});document.addEventListener("DOMContentLoaded",function(){scrubTauriBridge();var style=document.createElement("style");style.textContent=p.css;document.head.appendChild(style);var app=document.createElement("script");app.textContent=p.js;document.body.appendChild(app);setTimeout(function(){if(!runtimeError)notify("ib-generated-app-ready")},0)})})(' + bootData + ');<\/script>';
    var head = /<head(?:\s[^>]*)?>/i;
    if (head.test(html)) html = html.replace(head, function (match) { return match + csp + boot; });
    else html = '<!doctype html><html><head>' + csp + '</head><body>' + html + boot + '</body></html>';
    return html;
  }
  function buildStandaloneHtml(value) {
    var draft = normalizeDraft(value);
    if (!draft) return '';
    var appSrcdoc = buildSrcdoc(draft).replace(/ib-generated-app-storage-request/g, 'standalone-app-storage-request')
      .replace(/ib-generated-app-storage-response/g, 'standalone-app-storage-response');
    var data = JSON.stringify({ draftRef: draft.draftRef, name: draft.name, srcdoc: appSrcdoc }).replace(/</g, '\\u003c');
    var csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; frame-src \'self\' about:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + csp + '<title></title><style>html,body,#app{width:100%;height:100%;margin:0}body{overflow:hidden}#app{display:block;border:0}.standalone-storage-error{position:fixed;z-index:10;top:8px;left:8px;right:8px;padding:10px 14px;border-radius:8px;background:#fff1f0;color:#7a211d;font:14px/1.4 system-ui,sans-serif}#standalone-storage-error:empty{display:none}</style></head><body>'
      + '<iframe id="app" title=""></iframe><div id="standalone-storage-error" class="standalone-storage-error" role="status" aria-live="polite"></div>'
      + '<script>(function(p){var frame=document.getElementById("app"),error=document.getElementById("standalone-storage-error");document.title=p.name;frame.title=p.name;'
      + 'function respond(data){try{frame.contentWindow.postMessage(data,"*")}catch(_){}}window.addEventListener("message",function(event){var d=event.data;if(event.source!==frame.contentWindow||!d||d.type!=="standalone-app-storage-request"'
      + '||typeof d.requestId!=="string"||!/^[A-Za-z0-9-]{1,100}$/.test(d.requestId)||typeof d.key!=="string"||!d.key||d.key.length>160||/[\\u0000-\\u001f\\u007f]/.test(d.key))return;'
      + 'var result={type:"standalone-app-storage-response",requestId:d.requestId,ok:false};try{var key="ib-app-standalone-v1:"+p.draftRef+":"+d.key;if(d.action==="get"){var raw=localStorage.getItem(key);result.ok=true;result.value=raw===null?null:JSON.parse(raw)}'
      + 'else if(d.action==="set"){var rawValue=JSON.stringify(d.value);if(typeof rawValue!=="string"||rawValue.length>262144)throw new Error("storage-value-invalid");localStorage.setItem(key,rawValue);result.ok=true}'
      + 'else if(d.action==="remove"){localStorage.removeItem(key);result.ok=true}else throw new Error("storage-action-invalid");error.textContent=""}catch(e){result.error=String(e&&e.message||"local-storage-unavailable");error.textContent="此浏览器无法访问本地存储；请用允许本地文件存储的浏览器重新打开。"}respond(result)});'
      + 'frame.setAttribute("sandbox","allow-scripts");frame.srcdoc=p.srcdoc})(' + data + ');</script></body></html>';
  }
  function sandboxServiceOrigin() {
    var dev = root && root.__IB_DEV_SERVICE_CONFIG__;
    var candidate = dev && typeof dev.webOrigin === 'string' ? dev.webOrigin : '';
    var loc = root && root.location;
    if (!candidate && loc && /^https?:\/\/tauri\.localhost(?::\d+)?$/i.test(String(loc.origin || ''))) {
      candidate = 'http://127.0.0.1:23120';
    }
    if (!candidate && loc && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?$/i.test(String(loc.origin || ''))) {
      candidate = String(loc.origin);
    }
    var parsed;
    try { parsed = new URL(candidate); } catch (_) { return ''; }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(String(parsed.hostname).toLowerCase())) return '';
    return parsed.origin;
  }
  function appPreviewHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var dev = root && root.__IB_DEV_SERVICE_CONFIG__;
    if (dev && dev.mode && dev.mode !== 'production') {
      if (typeof dev.sessionToken !== 'string' || typeof dev.instanceId !== 'string') return null;
      headers['X-IB-Dev-Session'] = dev.sessionToken;
      headers['X-IB-Dev-Instance'] = dev.instanceId;
    }
    return headers;
  }
  function canUseLocalSrcdocPreview() {
    var loc = root && root.location;
    /* Preserve the offline file:// App Store mode. A Tauri-origin WebView can
       never take this branch, even if its location is later changed to file:. */
    return !!(loc && loc.protocol === 'file:' && !root.__TAURI__ && !root.__TAURI_INTERNALS__);
  }
  /* srcdoc inherits the host document's CSP, including Tauri's build-time
     script hashes. App Store preview therefore uses a short-lived local HTTP
     document with its own strict CSP; callers still apply sandbox=allow-scripts
     without allow-same-origin. Standalone export remains self-contained. */
  async function publishSandboxedPreview(value) {
    var draft = normalizeDraft(value), origin = sandboxServiceOrigin(), headers = appPreviewHeaders();
    if (!draft || !origin || !headers || typeof root.fetch !== 'function') throw new Error('generated-app-preview-unavailable');
    var response = await root.fetch(origin + '/__ib-generated-app', {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', headers: headers,
      body: JSON.stringify({ draft: draft })
    });
    var result = null;
    try { result = await response.json(); } catch (_) {}
    if (!response.ok || !result || result.ok !== true || typeof result.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.id)) {
      throw new Error('generated-app-preview-publish-failed');
    }
    livePreviewIds[result.id] = origin;
    if (!pagehideCleanupInstalled && root && typeof root.addEventListener === 'function') {
      pagehideCleanupInstalled = true;
      root.addEventListener('pagehide', function () {
        var navigator = root.navigator;
        if (!navigator || typeof navigator.sendBeacon !== 'function') return;
        Object.keys(livePreviewIds).forEach(function (id) {
          var serviceOrigin = livePreviewIds[id];
          try { navigator.sendBeacon(serviceOrigin + '/__ib-generated-app/cleanup/' + id, ''); } catch (_) {}
          delete livePreviewIds[id];
        });
      });
    }
    return { id: result.id, url: origin + '/__ib-generated-app/' + result.id };
  }
  async function revokeSandboxedPreview(id, options) {
    id = String(id || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return false;
    var origin = sandboxServiceOrigin(), headers = appPreviewHeaders();
    if (!origin || !headers || typeof root.fetch !== 'function') return false;
    try {
      var response = await root.fetch(origin + '/__ib-generated-app/' + id, {
        method: 'DELETE', mode: 'cors', credentials: 'omit', cache: 'no-store', headers: headers,
        keepalive: !!(options && options.keepalive)
      });
      if (response.ok) delete livePreviewIds[id];
      return response.ok;
    } catch (_) { return false; }
  }
  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function writeZip(files) {
    var encoder = new TextEncoder();
    var entries = Object.keys(files).map(function (name) {
      var pathname = encoder.encode(name), bytes = encoder.encode(files[name]);
      return { name: pathname, bytes: bytes, crc: crc32(bytes), offset: 0 };
    });
    var localSize = entries.reduce(function (sum, item) { return sum + 30 + item.name.length + item.bytes.length; }, 0);
    var centralSize = entries.reduce(function (sum, item) { return sum + 46 + item.name.length; }, 0);
    var output = new Uint8Array(localSize + centralSize + 22), view = new DataView(output.buffer), cursor = 0;
    entries.forEach(function (item) {
      item.offset = cursor;
      view.setUint32(cursor, 0x04034b50, true); view.setUint16(cursor + 4, 20, true); view.setUint16(cursor + 6, 0x0800, true);
      view.setUint16(cursor + 8, 0, true); view.setUint16(cursor + 10, 0, true); view.setUint16(cursor + 12, 0x21, true);
      view.setUint32(cursor + 14, item.crc, true); view.setUint32(cursor + 18, item.bytes.length, true); view.setUint32(cursor + 22, item.bytes.length, true);
      view.setUint16(cursor + 26, item.name.length, true); view.setUint16(cursor + 28, 0, true);
      output.set(item.name, cursor + 30); output.set(item.bytes, cursor + 30 + item.name.length); cursor += 30 + item.name.length + item.bytes.length;
    });
    var centralOffset = cursor;
    entries.forEach(function (item) {
      view.setUint32(cursor, 0x02014b50, true); view.setUint16(cursor + 4, 20, true); view.setUint16(cursor + 6, 20, true);
      view.setUint16(cursor + 8, 0x0800, true); view.setUint16(cursor + 10, 0, true); view.setUint16(cursor + 12, 0, true);
      view.setUint16(cursor + 14, 0x21, true); view.setUint32(cursor + 16, item.crc, true);
      view.setUint32(cursor + 20, item.bytes.length, true); view.setUint32(cursor + 24, item.bytes.length, true);
      view.setUint16(cursor + 28, item.name.length, true); view.setUint16(cursor + 30, 0, true); view.setUint16(cursor + 32, 0, true);
      view.setUint16(cursor + 34, 0, true); view.setUint16(cursor + 36, 0, true); view.setUint32(cursor + 38, 0, true);
      view.setUint32(cursor + 42, item.offset, true); output.set(item.name, cursor + 46); cursor += 46 + item.name.length;
    });
    view.setUint32(cursor, 0x06054b50, true); view.setUint16(cursor + 4, 0, true); view.setUint16(cursor + 6, 0, true);
    view.setUint16(cursor + 8, entries.length, true); view.setUint16(cursor + 10, entries.length, true);
    view.setUint32(cursor + 12, centralSize, true); view.setUint32(cursor + 16, centralOffset, true); view.setUint16(cursor + 20, 0, true);
    return output;
  }
  function buildSourceZip(value) {
    var draft = normalizeDraft(value);
    if (!draft) return null;
    var standalone = buildStandaloneHtml(draft);
    if (!standalone) return null;
    var readme = '# ' + draft.name + '\n\n已提交草稿版本：v' + draft.version + '\n\n'
      + '直接打开 `standalone.html` 即可在浏览器运行。该页面将 `AppStorage` 适配到独立的浏览器 localStorage 命名空间；不会连接归墟、Home Node 或 DSH。\n\n'
      + '源码文件：`index.html`、`styles.css`、`app.js`。这些文件来自选定的不可变草稿版本。\n\n'
      + '应用数据由浏览器保存在本地。当前 App Builder 版本只包含这三个文本源码文件，不包含外部资源或依赖。\n';
    return writeZip({ 'index.html': draft.files['index.html'], 'styles.css': draft.files['styles.css'],
      'app.js': draft.files['app.js'], 'standalone.html': standalone, 'README.md': readme });
  }
  return Object.freeze({ FILE_NAMES: FILE_NAMES, FILE_LIMIT: FILE_LIMIT, TOTAL_LIMIT: TOTAL_LIMIT,
    validFiles: validFiles, normalizeDraft: normalizeDraft, appIdForDraft: appIdForDraft, diff: diff,
    buildSrcdoc: buildSrcdoc, buildStandaloneHtml: buildStandaloneHtml, buildSourceZip: buildSourceZip,
    canUseLocalSrcdocPreview: canUseLocalSrcdocPreview,
    publishSandboxedPreview: publishSandboxedPreview, revokeSandboxedPreview: revokeSandboxedPreview });
});
