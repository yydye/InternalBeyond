/* Browser 传输层路由决策单测：从 communication.js 逐字复制 _ibProxy* 函数，
   用 mock 全局验证 file:// 走 Bridge、http/https 直连、Bridge 不可达回落到直连、
   X-IB-Token 独立于上游 Authorization、_forceDirect 豁免。 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'assets/js/communication.js'), 'utf8');

const results = [];
function ok(name, pass, detail) { results.push({ name, pass }); console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')); }

function carve(fnName) {
  const start = src.indexOf('function ' + fnName + '(');
  let depth = 0, i = start, seen = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; seen = true; }
    if (c === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  /* 若声明前有 `async ` 修饰，一并截取以保留 await 语义 */
  const before = src.slice(Math.max(0, start - 8), start);
  const withAsync = /async\s+$/.test(before);
  return src.slice(withAsync ? start - 6 : start, i);
}
const code = ['_ibProxyShouldRoute', '_ibProxyBase', '_ibProxyToken', '_ibApiPost'].map(carve).join('\n');

(async () => {
  /* mock 全局 */
  let calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts, via: String(url).includes('/api/llm-proxy') ? 'bridge' : 'direct' }); return { __fake: true }; };
  global.localStorage = { getItem: () => null };
  global.window = { ibBridgeBase: () => 'http://127.0.0.1:23115', ibBridgeToken: () => 'BRIDGETOK' };
  global.IBNET = undefined;

  /* eval 声明函数于当前 IIFE 作用域，随后同作用域调用 */
  const _fn = new Function('return (async function(){' + code + '; return { _ibApiPost, _ibProxyShouldRoute };})()');
  global.__t = await _fn();

  global.location = { protocol: 'file:' };
  calls = [];
  await __t._ibApiPost('https://token.android-doc.com/api/token/v1/chat/completions', { 'Content-Type': 'application/json', 'Authorization': 'Bearer APIKEY' }, '{"a":1}', {});
  const bridgeCall = calls.find(c => c.via === 'bridge');
  const directCall = calls.find(c => c.via === 'direct');
  ok('file:// 走 Bridge', !!bridgeCall && !directCall);
  ok('Bridge 目标 URL 正确', bridgeCall && bridgeCall.url === 'http://127.0.0.1:23115/api/llm-proxy');
  ok('Bridge 携带独立 X-IB-Token', bridgeCall && bridgeCall.opts.headers['X-IB-Token'] === 'BRIDGETOK');
  ok('上游 Authorization 在请求体内而非 header', (() => {
    const p = JSON.parse(bridgeCall.opts.body);
    return !bridgeCall.opts.headers['Authorization'] && p.headers['Authorization'] === 'Bearer APIKEY' && p.url === 'https://token.android-doc.com/api/token/v1/chat/completions';
  })());

  /* http:// 承载 → 直连（不射 Bridge） */
  global.location = { protocol: 'http:' };
  calls = [];
  await __t._ibApiPost('https://api.openai.com/v1/chat/completions', { 'Content-Type': 'application/json' }, '{}', {});
  ok('http:// 承载走直连', calls.length === 1 && calls[0].via === 'direct' && calls[0].url === 'https://api.openai.com/v1/chat/completions');

  /* Bridge 不可达（fetch 拒绝）→ 回落到直连 */
  global.location = { protocol: 'file:' };
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, via: String(url).includes('/api/llm-proxy') ? 'bridge' : 'direct' });
    if (String(url).includes('/api/llm-proxy')) throw new TypeError('Failed to fetch');
    return { __fake: true };
  };
  global.window = { ibBridgeBase: () => 'http://127.0.0.1:23115', ibBridgeToken: () => '' };
  calls = [];
  await __t._ibApiPost('https://x.example/v1/chat/completions', { 'Content-Type': 'application/json' }, '{}', {});
  ok('Bridge 不可达回落到直连', calls.some(c => c.via === 'bridge') && calls.some(c => c.via === 'direct'));

  /* _forceDirect 豁免（即使 file:// 也不经 Bridge） */
  global.fetch = async (url, opts) => { calls.push({ url, via: String(url).includes('/api/llm-proxy') ? 'bridge' : 'direct' }); return { __fake: true }; };
  calls = [];
  await __t._ibApiPost('https://x.example/v1/chat/completions', { 'Content-Type': 'application/json' }, '{}', { _forceDirect: true });
  ok('_forceDirect 豁免走直连', calls.length === 1 && calls[0].via === 'direct');

  const passCount = results.filter(r => r.pass).length;
  console.log('\n==== ' + passCount + '/' + results.length + ' PASS ====');
  process.exit(passCount === results.length ? 0 : 1);
})();
