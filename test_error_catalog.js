'use strict';
/* Internal Beyond — error-catalog 分类契约测试（零网络、零浏览器）
   运行：node test_error_catalog.js
   验证：user stop→aborted、heartbeat/timeout→timeout、HTTP 429→rate_limit、
   裸 AbortError 不再无条件归 aborted（不依赖中文文案区分）。 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'assets', 'js', 'error-catalog.js'), 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'error-catalog.js' });
const IBERR = sandbox.window.IBERR;

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

/* 用户主动停止 → aborted */
const userStop = new Error('请求超时或已停止'); userStop.ibCat = 'aborted';
check('user stop (ibCat=aborted) → aborted', IBERR.classify(userStop) === 'aborted', IBERR.classify(userStop));
const userStop2 = new Error('已停止'); userStop2.name = 'AbortError'; userStop2.abortReason = 'user_stop';
check('user stop (abortReason=user_stop) → aborted', IBERR.classify(userStop2) === 'aborted', IBERR.classify(userStop2));

/* 45s heartbeat 超时 → timeout */
const hb = new Error('请求超时'); hb.ibCat = 'timeout';
check('heartbeat timeout (ibCat=timeout) → timeout', IBERR.classify(hb) === 'timeout', IBERR.classify(hb));
const hbRaw = new Error('x'); hbRaw.name = 'AbortError'; hbRaw.abortReason = 'heartbeat';
check('heartbeat timeout (abortReason=heartbeat) → timeout', IBERR.classify(hbRaw) === 'timeout', IBERR.classify(hbRaw));

/* 60s 总超时 → timeout */
const tt = new Error('请求超时'); tt.ibCat = 'timeout';
check('total timeout (ibCat=timeout) → timeout', IBERR.classify(tt) === 'timeout', IBERR.classify(tt));
const ttRaw = new Error('x'); ttRaw.name = 'AbortError'; ttRaw.abortReason = 'timeout';
check('total timeout (abortReason=timeout) → timeout', IBERR.classify(ttRaw) === 'timeout', IBERR.classify(ttRaw));

/* 裸 AbortError（无信号）→ timeout，不再无条件归 aborted */
const bare = new Error('x'); bare.name = 'AbortError';
check('bare AbortError → timeout (not aborted)', IBERR.classify(bare) === 'timeout', IBERR.classify(bare));

/* HTTP 429 → rate_limit（干净路径，不含中文文案） */
check('HTTP 429 "429: …" → rate_limit', IBERR.classify(new Error('429: {"error":"rate limit exceeded"}')) === 'rate_limit');
check('HTTP 429 Bridge body → rate_limit', IBERR.classify(new Error('429: {"error":"请求过于频繁，请稍后再试"}')) === 'rate_limit');
check('HTTP 429 "API返回 429" → rate_limit', IBERR.classify(new Error('API返回 429')) === 'rate_limit');

/* 无歧义守卫：403 仍归 auth，不被自愈路径干扰 */
check('HTTP 403 → auth', IBERR.classify(new Error('403: Forbidden')) === 'auth', IBERR.classify(new Error('403: Forbidden')));

/* ── Gemini debug URL redaction（communication.js `_dbgRedactUrl` 契约）──
   与 communication.js 中完全一致的正则：?key=<API_KEY> 必须被隐藏为 ***。 */
function redactUrl(u){ return String(u || '').replace(/([?&])key=[^&]*/gi, '$1key=***********'); }
const gemUrl = 'https://generativelanguage.googleapis.com/v1beta/models/{m}:streamGenerateContent?key=sk-GEMINI-SECRET&alt=sse';
const red = redactUrl(gemUrl);
check('Gemini URL 隐藏 ?key= 值', red.indexOf('sk-GEMINI-SECRET') === -1 && /\?key=\*{11}/.test(red), red);
const alt = redactUrl('https://e/v1/messages?foo=1&key=SECRETKEY&alt=sse');
check('query 中部的 key 也被隐藏', alt.indexOf('SECRETKEY') === -1, alt);
const noKey = redactUrl('https://e/v1/chat/completions?model=x');
check('无 key 的 URL 不受影响', noKey === 'https://e/v1/chat/completions?model=x', noKey);

console.log(failures ? `\nerror-catalog test failed: ${failures}` : `\nerror-catalog test passed ✔ (${passed})`);
if (failures) process.exitCode = 1;
