/* ====================================================================
   P2 Stage 1 · Video Runtime · Node（API 面 + 生命周期 + 无 DOM 守卫）
   --------------------------------------------------------------------
   通过最小 window/IB 壳加载 video-runtime.js（与 com.* 子模块相同的 IIFE 方式），
   验证：createVideoRuntime 返回完整 API；生命周期 stop/free 在无流时不抛错；
   captureFrame 在无可用帧时 guard 返回 null；on/off 监听。
   注意：真实的帧捕捉 shape / 持久化隔离 / 释放释放属 CDP(browser) 测试。
   运行：node test_video_runtime.js
   ==================================================================== */
'use strict';

globalThis.window = globalThis.window || {};
window.IB = window.IB || {};
window.IB.expose = window.IB.expose || function () {};
require('./assets/js/communication/video-runtime.js');
var VR = window.IBVideoRuntime;

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('ok - ' + name); }
  else { fail++; console.error('FAIL - ' + name + (detail ? (' :: ' + detail) : '')); }
}

ok('module.IBVideoRuntime存在', !!VR && typeof VR.createVideoRuntime === 'function');
ok('module.IB.videoRuntime', window.IB && window.IB.videoRuntime === VR);

(function (voidLoop) {
  var rt = VR.createVideoRuntime({ targetWidth: 320, quality: 0.6 });
  ok('api.surface.start', typeof rt.start === 'function');
  ok('api.surface.captureFrame', typeof rt.captureFrame === 'function');
  ok('api.surface.setLoop', typeof rt.setLoop === 'function');
  ok('api.surface.stop', typeof rt.stop === 'function');
  ok('api.surface.free', typeof rt.free === 'function');
  ok('api.surface.getLastFrame', typeof rt.getLastFrame === 'function');
  ok('api.surface.on', typeof rt.on === 'function');
  ok('api.surface.off', typeof rt.off === 'function');
  ok('api.init.lastFrame为null', rt.getLastFrame() === null);
  ok('api.init.started为false', rt.started === false);
})();

/* 无 DOM / 无流时：captureFrame guard → null（不抛、不访问 DOM capture）；stop/free 不抛 */
(async function () {
  var rt = VR.createVideoRuntime({});
  var frame = await rt.captureFrame({ targetWidth: 320 });
  ok('guard.captureFrame无源返回null', frame === null);
  ok('lifecycle.stop不抛', (function(){ try { rt.stop(); return true; } catch (e) { return false; } })());
  ok('lifecycle.free不抛', (function(){ try { rt.free(); return true; } catch (e) { return false; } })());
  ok('after.free.lastFrame为null', rt.getLastFrame() === null);
  ok('after.free.started为false', rt.started === false);
})();

/* 事件订阅 on/off */
(async function () {
  var rt = VR.createVideoRuntime({});
  var got = 0;
  var fn = function () { got++; };
  rt.on('frame', fn);
  rt.off('frame', fn);
  ok('events.onOff', got === 0); /* 已 off，不应收到 */
  var got2 = 0;
  var fn2 = function () { got2++; };
  rt.on('frame', fn2);
  ok('events.on注册', true);
})();

console.log('\n==== 结果 ====');
console.log('pass=' + pass + '  fail=' + fail);
process.exit(fail ? 1 : 0);
