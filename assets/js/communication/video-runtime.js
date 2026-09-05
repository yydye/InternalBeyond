/* ====================================================================
   IB Video Runtime — 独立可复用的视觉输入层（P2 · Stage 1）
   --------------------------------------------------------------------
   职责：Camera → MediaStream → <video> 自预览 → Frame Capture → Compression。
        只产出【原始帧】{dataUrl,width,height,timestamp}。
   边界：不生成 visionReference、不做模型路由、不持久化、不碰 LLM。
        压缩复用 communication.js 的 compressImage（window.compressImage，不重造）。
   加载：与 com.* 子模块一致（IIFE + window.IB 双挂载），与 call.js 等共存。
   ==================================================================== */
(function(NS){
  'use strict';

  function _createFrame(dataUrl, width, height) {
    return { dataUrl: dataUrl, width: width, height: height, timestamp: Date.now() };
  }

  function createVideoRuntime(opts) {
    opts = opts || {};
    var videoHost = opts.videoHost || null;   /* 可选：外部 <video>；缺省内部自建 */
    var stream = null;
    var lastFrame = null;
    var list = {};
    var capTimer = null;
    var capEvery = 0;
    var targetW = opts.targetWidth || 640;
    var quality = (opts.quality != null ? opts.quality : 0.8);

    var api = { _ownVideo: null, started: false };

    function _video() {
      if (videoHost) return videoHost;
      if (!api._ownVideo) {
        var v = document.createElement('video');
        v.setAttribute('playsinline', '');
        v.setAttribute('muted', '');
        v.setAttribute('autoplay', '');
        v.playsInline = true;
        api._ownVideo = v;
      }
      return api._ownVideo;
    }
    function _emit(ev, payload) {
      var a = list[ev];
      if (!a) return;
      for (var i = 0; i < a.length; i++) { try { a[i](payload); } catch (e) { /* ignore */ } }
    }
    function _clearTimer() { if (capTimer) { clearInterval(capTimer); capTimer = null; } }
    function _compress() {
      return (typeof window.compressImage === 'function') ? window.compressImage
        : (window.IB && typeof window.IB.compressImage === 'function') ? window.IB.compressImage : null;
    }

    /* 打开相机：getUserMedia({video}) → 挂到 <video> 自预览。返回 {stream, video}。 */
    function start(cameraOpts) {
      cameraOpts = cameraOpts || {};
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.reject(new Error('This browser does not support camera capture'));
      }
      if (cameraOpts.width) targetW = cameraOpts.width;
      if (cameraOpts.quality != null) quality = cameraOpts.quality;
      return navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: targetW }, height: { ideal: Math.max(2, Math.round(targetW * 0.75)) } },
        audio: false
      }).then(function (s) {
        stream = s;
        var v = _video();
        v.srcObject = stream;
        return v.play().catch(function () {}).then(function () {
          api.started = true;
          return { stream: stream, video: v };
        });
      });
    }

    /* 抓一帧：video 当前帧 → 离屏 canvas（等比限宽）→ 复用 compressImage → 原始帧对象。
       无可用帧时 resolve(null)。产物纯 request-local，不落任何存储。 */
    function captureFrame(o) {
      o = o || {};
      return new Promise(function (resolve) {
        try {
          var v = videoHost || api._ownVideo;
          if (!v || !v.videoWidth || !v.videoHeight) { resolve(null); return; }
          var dw = Math.min(o.targetWidth || targetW, v.videoWidth);
          var dh = Math.max(2, Math.round(v.videoHeight * (dw / v.videoWidth)));
          var canvas = document.createElement('canvas');
          canvas.width = dw; canvas.height = dh;
          canvas.getContext('2d').drawImage(v, 0, 0, dw, dh);
          canvas.toBlob(function (blob) {
            if (!blob) { resolve(null); return; }
            var f;
            try { f = new File([blob], 'frame_' + Date.now() + '.jpg', { type: 'image/jpeg' }); }
            catch (e) { f = blob; }
            var comp = _compress();
            if (typeof comp === 'function') {
              comp(f).then(function (c) {
                var out = _createFrame(c.dataUrl || canvas.toDataURL('image/jpeg', quality), dw, dh);
                lastFrame = out; _emit('frame', out); resolve(out);
              }).catch(function () {
                var out = _createFrame(canvas.toDataURL('image/jpeg', quality), dw, dh);
                lastFrame = out; _emit('frame', out); resolve(out);
              });
            } else {
              var out = _createFrame(canvas.toDataURL('image/jpeg', quality), dw, dh);
              lastFrame = out; _emit('frame', out); resolve(out);
            }
          }, 'image/jpeg', quality);
        } catch (e) { resolve(null); }
      });
    }

    /* 周期性抓帧（ms>0 开启，否则关闭）。仅当 started 时运行。 */
    function setLoop(ms) {
      capEvery = Math.max(0, Number(ms) || 0);
      _clearTimer();
      if (capEvery > 0) capTimer = setInterval(function () {
        if (api.started) { captureFrame({ targetWidth: targetW }).catch(function () {}); }
      }, capEvery);
    }
    /* 停预览（不动流资源）。 */
    function stop() {
      _clearTimer();
      var v = videoHost || api._ownVideo;
      if (v) { try { v.pause(); } catch (e) { /* ignore */ } }
    }
    /* 释放：清定时器 + 停 tracks（含当前显示的流）+ 摘流 + 清内存帧。无持久化。 */
    function free() {
      stop();
      var v = videoHost || api._ownVideo;
      var seen = [];
      var kill = function (t) { if (t && seen.indexOf(t) === -1) { seen.push(t); try { t.stop(); } catch (e) { /* ignore */ } } };
      if (stream) stream.getTracks().forEach(kill);
      if (v && v.srcObject && typeof v.srcObject.getTracks === 'function') v.srcObject.getTracks().forEach(kill);
      if (v) { try { v.srcObject = null; } catch (e) {} }
      stream = null;
      api._ownVideo = null;
      lastFrame = null;
      api.started = false;
    }
    function on(ev, fn) { (list[ev] = list[ev] || []).push(fn); }
    function off(ev, fn) {
      var a = list[ev];
      if (a && fn) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    }

    api.start = start;
    api.captureFrame = captureFrame;
    api.setLoop = setLoop;
    api.stop = stop;
    api.free = free;
    api.getLastFrame = function () { return lastFrame; };
    api.on = on;
    api.off = off;
    return api;
  }

  var exposed = { createVideoRuntime: createVideoRuntime };
  window.IBVideoRuntime = exposed;
  NS.videoRuntime = exposed;
})(window.IB || (window.IB = {}));
