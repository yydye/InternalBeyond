'use strict';
/* ====================================================================
   R19 / §3.14 · LAN 模式桌面端鉴权一致性契约测试（static，零依赖）
   --------------------------------------------------------------------
   背景（MOBILE_HOME_NODE_AUDIT.md §3.14，已端到端验证）：
     config.lan = true 时 bridge/config.js 的 LAN_EXPOSED 为真，
     needsHttpToken() 对**所有**调用者（含 loopback）为真，于是：
       ① 语音通话的 WebSocket 升级被 services/ib-bridge-service.js:1055 以 401 拒绝；
       ② TTS 试听按钮的裸 fetch 被 bridge/routes.js:316 的全局闸门拒绝；
       ③ new Audio(base+url) 按构造无法携带请求头，同样拿不到受保护资产。
     根因是 ibBridgeToken 从未发布到 window，导致 communication/call.js:17
     的 `typeof ibBridgeToken==='function'?ibBridgeToken():''` 恒为空串。

   本测试锁住「已经想清楚了的三条规则」，防止回归：
     R-A  读取 Bridge token 的唯一入口必须全局可达（window.ibBridgeToken）。
     R-B  任何以 ibBridgeBase() 拼出的 Bridge 调用必须经 ibBridgeFetch
          （即带 Authorization 头），不得裸 fetch。
     R-C  任何以 ibBridgeBase() 拼出的媒体资产不得交给 <audio>/<img>/new Audio
          直接消费，必须经 ibBridgeLoadAudio / ibBridgeLoadImage（blob 取回）。

   纯静态文本分析，不联网、不开浏览器、不启动任何服务。
   ==================================================================== */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else { failures++; console.error('✖ ' + name + (extra ? ' — ' + extra : '')); }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
}
function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (/\.js$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/* ── R-A · token 读取器必须全局可达 ───────────────────────────────── */
const bridgeText = read('assets/js/bridge.js');
check('R-A window.ibBridgeToken 已发布', /window\.ibBridgeToken\s*=\s*ibBridgeToken\s*;/.test(bridgeText),
  'bridge.js 未把 ibBridgeToken 发布到 window；call.js 的 typeof 读取会恒为空串');
check('R-A window.ibBridgeBase 仍然发布', /window\.ibBridgeBase\s*=\s*ibBridgeBase\s*;/.test(bridgeText));
check('R-A window.ibBridgeFetch 仍然发布', /window\.ibBridgeFetch\s*=\s*ibBridgeFetch\s*;/.test(bridgeText));
check('R-A ibBridgeToken 定义在 IIFE 内（未被别的全局同名覆盖）',
  /function ibBridgeToken\(\)\{/.test(bridgeText));

/* 读取侧：call.js 的 token() 必须真的能拿到值（形状守卫，不由本测试执行浏览器）。
   这里只断言它仍然使用 typeof 守卫 + 调用 ibBridgeToken（发布后即可拿到 token）。 */
const callText = read('assets/js/communication/call.js');
check('R-A call.js token() 仍走 ibBridgeToken()',
  /typeof ibBridgeToken===\'function\'\?ibBridgeToken\(\):\'\'/.test(callText));
check('R-A call.js wsUrl() 把 token 放进 query（WebSocket 无法带头）',
  /access\?value\+\'\?token=\'\+encodeURIComponent\(access\):value/.test(callText));

/* ── R-B / R-C · 扫描所有前端 JS 的 Bridge 调用点 ──────────────────── */
const files = listJs(path.join(ROOT, 'assets', 'js'));
const bareFetch = [];
const bareMedia = [];
const ASSET_CTX = /(?:ibBridgeBase\(\)|ibBridgeAssetUrl\()/;

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (rel === 'assets/js/bridge.js') continue; /* 定义处自身就是实现 */
  const lines = read(rel).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ASSET_CTX.test(line)) continue;
    /* 命中「不是 ibBridgeFetch 的 fetch(」——用否定前瞻避免把 ibBridgeFetch 自己算成裸调用。 */
    if (/(?<![A-Za-z_$])fetch\s*\(/.test(line.replace(/ibBridgeFetch\s*\(/g, 'ibBridgeFetchX('))) {
      bareFetch.push(rel + ':' + (i + 1));
    }
    if (/new\s+Audio\(|\.src\s*=\s*ibBridge/.test(line)) {
      bareMedia.push(rel + ':' + (i + 1));
    }
  }
}
check('R-B 无裸 fetch(ibBridgeBase()…) 调用点', bareFetch.length === 0, bareFetch.join(', '));
check('R-C 无 new Audio(ibBridgeBase()…) / <media>.src=ibBridge… 调用点', bareMedia.length === 0, bareMedia.join(', '));

/* 正向确认：social.js 的 TTS 试听已按规则改写（否则上面两条可能因为改法不同而漏检）。 */
const socialText = read('assets/js/social.js');
check('R-B social.js TTS 试听经 ibBridgeFetch',
  /ibBridgeFetch\(ibBridgeBase\(\)\+\'\/api\/tts\'/.test(socialText));
check('R-C social.js TTS 试听经 ibBridgeLoadAudio',
  /ibBridgeLoadAudio\(j\.url/.test(socialText));
check('R-C social.js 不再直接 new Audio(ibBridgeBase()…)',
  !/new Audio\(ibBridgeBase\(\)/.test(socialText));

/* ── R-D · 既有正确路径不得被改坏（它们是这条规则的正样本）───────── */
const bridgeSites = [
  'ibBridgeFetch(ibBridgeBase()+\'/api/tts\'',
  'ibBridgeFetch(ibBridgeBase()+\'/health\'',
  'ibBridgeLoadAudio(url,',
  'ibBridgeFetch(ibBridgeAssetUrl('
];
for (const site of bridgeSites) {
  check('R-D bridge.js 正确路径仍在: ' + site, bridgeText.includes(site));
}

console.log('');
if (failures) {
  console.error('LAN 鉴权一致性契约测试失败：' + failures + ' 项 ✘');
  process.exitCode = 1;
} else {
  console.log('LAN bridge auth parity contract passed ✔');
}
