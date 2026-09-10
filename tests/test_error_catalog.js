'use strict';
/* Internal Beyond — error-catalog 契约测试（零网络、零浏览器）
   运行：node test_error_catalog.js
   P1/P2 原有断言（分类 + 角色文案 + Gemini URL 脱敏）保持；
   P3 追加：统一用户错误模型（present/model/show）、产品文案、技术详情脱敏。 */
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const fs = require('fs');
const vm = require('vm');


const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'error-catalog.js'), 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'error-catalog.js' });
const IBERR = sandbox.window.IBERR;

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

/* ═══ 1. 原有分类契约（P1/P2 回归） ═══ */
section('分类契约（原有）');
const userStop = new Error('请求超时或已停止'); userStop.ibCat = 'aborted';
check('user stop (ibCat=aborted) → aborted', IBERR.classify(userStop) === 'aborted', IBERR.classify(userStop));
const userStop2 = new Error('已停止'); userStop2.name = 'AbortError'; userStop2.abortReason = 'user_stop';
check('user stop (abortReason=user_stop) → aborted', IBERR.classify(userStop2) === 'aborted', IBERR.classify(userStop2));

const hb = new Error('请求超时'); hb.ibCat = 'timeout';
check('heartbeat timeout (ibCat=timeout) → timeout', IBERR.classify(hb) === 'timeout', IBERR.classify(hb));
const hbRaw = new Error('x'); hbRaw.name = 'AbortError'; hbRaw.abortReason = 'heartbeat';
check('heartbeat timeout (abortReason=heartbeat) → timeout', IBERR.classify(hbRaw) === 'timeout', IBERR.classify(hbRaw));

const tt = new Error('请求超时'); tt.ibCat = 'timeout';
check('total timeout (ibCat=timeout) → timeout', IBERR.classify(tt) === 'timeout', IBERR.classify(tt));
const ttRaw = new Error('x'); ttRaw.name = 'AbortError'; ttRaw.abortReason = 'timeout';
check('total timeout (abortReason=timeout) → timeout', IBERR.classify(ttRaw) === 'timeout', IBERR.classify(ttRaw));

const bare = new Error('x'); bare.name = 'AbortError';
check('bare AbortError → timeout (not aborted)', IBERR.classify(bare) === 'timeout', IBERR.classify(bare));

check('HTTP 429 "429: …" → rate_limit', IBERR.classify(new Error('429: {"error":"rate limit exceeded"}')) === 'rate_limit');
check('HTTP 429 Bridge body → rate_limit', IBERR.classify(new Error('429: {"error":"请求过于频繁，请稍后再试"}')) === 'rate_limit');
check('HTTP 429 "API返回 429" → rate_limit', IBERR.classify(new Error('API返回 429')) === 'rate_limit');

/* P3 明确改动：403 不再归 auth（密钥问题），而是独立的 forbidden（权限/区域/拒绝） */
check('HTTP 403 → forbidden（P3 从 auth 拆出）', IBERR.classify(new Error('403: Forbidden')) === 'forbidden', IBERR.classify(new Error('403: Forbidden')));

/* ═══ 2. P3 新增分类（按真实 provider / runtime 行为） ═══ */
section('分类契约（P3 新增）');
check('401 → auth', IBERR.classify(new Error('401: {"error":{"message":"Invalid API key"}}')) === 'auth');
check('408 → timeout', IBERR.classify(new Error('408: Request Timeout')) === 'timeout');
check('500 → provider', IBERR.classify(new Error('500: Internal Server Error')) === 'provider');
check('503 → provider', IBERR.classify(new Error('503: {"error":"Service Unavailable"}')) === 'provider');
check('404 + 模型关键词 → model', IBERR.classify(new Error('404: {"error":{"message":"The model gpt-5 does not exist"}}')) === 'model');
check('404 无模型关键词 → endpoint', IBERR.classify(new Error('404: {"error":"Not Found"}')) === 'endpoint');
check('unsupported model → model', IBERR.classify(new Error('400: model_not_found')) === 'model');
check('"fetch failed" → network', IBERR.classify(new Error('fetch failed')) === 'network');
check('ECONNREFUSED → network', IBERR.classify(new Error('connect ECONNREFUSED 127.0.0.1:23115')) === 'network');
check('JSON 解析失败 → malformed', IBERR.classify(new Error('Unexpected token < in JSON at position 0')) === 'malformed');
check('HTML 而非 JSON → endpoint', IBERR.classify(new Error('API端点返回了网页而非JSON——请检查端点URL是否正确')) === 'endpoint');
check('空内容 → empty_output', IBERR.classify(new Error('API 返回了空内容（finish_reason: length）')) === 'empty_output');
check('安全策略 → content', IBERR.classify(new Error('内容被该服务商的安全策略拦截（finish_reason: sensitive）')) === 'content');

/* 来源优先：本地服务的 500/404 不能变成 provider/model */
section('来源判定（本地服务 / TTS）');
check('source=local_service + 500 → local_service', IBERR.present(new Error('后台服务 500: boom'), { source: 'local_service', component: 'active' }).category === 'local_service');
check('source=local_service + 404 → local_service', IBERR.present(new Error('后台服务 404: not found'), { source: 'local_service', component: 'bridge' }).category === 'local_service');
check('e.ibSource=local_service 同样生效', IBERR.present(Object.assign(new Error('后台服务 500: boom'), { ibSource: 'local_service', ibComponent: 'active' })).category === 'local_service');
check('source=tts → tts', IBERR.present(new Error('语音合成失败'), { source: 'tts' }).category === 'tts');

/* ═══ 3. 统一用户错误模型 schema ═══ */
section('用户错误模型 schema');
const modelKeys = ['code', 'category', 'title', 'message', 'suggestion', 'retryable', 'technicalDetails', 'action'];
const sample = IBERR.present(new Error('401: {"error":{"message":"Invalid API key"}}'), { cfg: { provider: 'openai', model: 'gpt-4o', id: 'c1', endpoint: 'https://api.openai.com/v1/chat/completions' }, stage: 'chat' });
check('present() 返回全部必需字段', modelKeys.every(k => Object.prototype.hasOwnProperty.call(sample, k)), Object.keys(sample));
check('retryable 是布尔', typeof sample.retryable === 'boolean');
check('technicalDetails 是对象', sample.technicalDetails && typeof sample.technicalDetails === 'object' && !Array.isArray(sample.technicalDetails));
check('action 是对象或 null', sample.action === null || typeof sample.action === 'object');
check('code 形如 IBERR.<CAT>.<SUFFIX>', /^IBERR\.[A-Z_]+\.[A-Z0-9_]+$/.test(sample.code), sample.code);
check('code = IBERR.AUTH.401', sample.code === 'IBERR.AUTH.401', sample.code);
check('每个类别都有完整产品文案', IBERR.CATEGORIES.every(c => {
  const m = IBERR.model(c, { component: 'bridge' });
  return !!(m.title && m.message && m.suggestion && typeof m.retryable === 'boolean');
}), IBERR.CATEGORIES.filter(c => !IBERR.model(c, { component: 'bridge' }).title));
check('show() 在无 DOM 环境安全返回 null', IBERR.show(sample) === null);

/* ═══ 4. 验收场景文案（1–11） ═══ */
section('验收场景文案');
const FORBIDDEN_IN_USER_TEXT = ['127.0.0.1', 'localhost', 'ws://', 'http://', 'https://', 'ECONNREFUSED', 'fetch failed', 'stack', 'Error:', '{', '}', 'sk-', 'Bearer', '23115', '23117', '23120', 'undefined', 'null'];
function userText(m) { return m.title + '\n' + m.message + '\n' + m.suggestion; }
function assertClean(label, m) {
  const t = userText(m);
  const hit = FORBIDDEN_IN_USER_TEXT.filter(x => t.indexOf(x) !== -1);
  check(label + '：普通提示不含技术细节', hit.length === 0, hit);
}
function assertModel(label, m, expect) {
  const ok = Object.keys(expect).every(k => (k === 'has' ? expect.has.every(x => userText(m).indexOf(x) !== -1) : m[k] === expect[k]));
  check(label, ok, { code: m.code, category: m.category, title: m.title, message: m.message, suggestion: m.suggestion, retryable: m.retryable });
  assertClean(label, m);
}

/* 1. 401 */
assertModel('401 密钥无效', IBERR.present(new Error('401: {"error":{"message":"Invalid API key"}}'), { cfg: { provider: 'openai', model: 'gpt-4o' } }),
  { category: 'auth', retryable: false, has: ['密钥'] });
/* 2. 403 */
assertModel('403 权限/区域/拒绝（中性）', IBERR.present(new Error('403: {"error":{"message":"Forbidden"}}')),
  { category: 'forbidden', retryable: false, has: ['权限', '地区'] });
/* 3. 404 endpoint / model */
assertModel('404 地址不正确', IBERR.present(new Error('404: {"error":"Not Found"}')),
  { category: 'endpoint', retryable: false, has: ['地址'] });
assertModel('404 模型不可用', IBERR.present(new Error('404: {"error":{"message":"model not found"}}')),
  { category: 'model', retryable: false, has: ['模型'] });
/* 4. 429 —— 不得武断写成“余额不足” */
const m429 = IBERR.present(new Error('429: {"error":"rate limit exceeded"}'));
assertModel('429 频率/额度受限', m429, { category: 'rate_limit', retryable: true, has: ['请求过于频繁'] });
check('429 文案不武断断言余额不足', /可能是/.test(m429.message) && !/余额不足/.test(m429.message), m429.message);
/* 5. 5xx */
assertModel('5xx 服务商异常', IBERR.present(new Error('502: Bad Gateway')),
  { category: 'provider', retryable: true, has: ['服务商'] });
/* 6. timeout */
assertModel('超时', IBERR.present(new Error('请求超时')),
  { category: 'timeout', retryable: true, has: ['超时'] });
/* 7. network */
assertModel('网络失败', IBERR.present(new Error('fetch failed')),
  { category: 'network', retryable: true, has: ['网络'] });
/* 8. malformed */
assertModel('响应格式无法识别', IBERR.present(new Error('Unexpected token < in JSON at position 0')),
  { category: 'malformed', retryable: true, has: ['无法识别'] });
/* 9. Bridge */
assertModel('Bridge 不可用', IBERR.model('local_service', { component: 'bridge' }),
  { category: 'local_service', code: 'IBERR.LOCAL_SERVICE.BRIDGE', retryable: true, has: ['部分本地功能暂时不可用', '仍然可以继续聊天'] });
/* 10. Active */
assertModel('Active 不可用', IBERR.model('local_service', { component: 'active' }),
  { category: 'local_service', code: 'IBERR.LOCAL_SERVICE.ACTIVE', retryable: true, has: ['后台功能暂时不可用', '聊天不受影响'] });
/* 11. TTS */
assertModel('TTS 失败', IBERR.model('tts', {}),
  { category: 'tts', code: 'IBERR.TTS.FAILED', retryable: true, has: ['语音生成失败', '文字聊天不受影响'] });

/* 文案一致性：Bridge 示例必须逐字符合需求给的措辞 */
const bridgeModel = IBERR.model('local_service', { component: 'bridge' });
check('Bridge 文案 = 「部分本地功能暂时不可用。你仍然可以继续聊天。」',
  bridgeModel.message === '本地增强服务没有响应。你仍然可以继续聊天。' && bridgeModel.title === '部分本地功能暂时不可用', bridgeModel);

/* 12. retryable 语义矩阵 */
section('retryable 语义');
const retryMatrix = [
  ['network', true], ['timeout', true], ['rate_limit', true], ['provider', true], ['malformed', true],
  ['empty_output', true], ['aborted', true], ['local_service', true], ['tts', true], ['unknown', true],
  ['auth', false], ['forbidden', false], ['endpoint', false], ['model', false], ['bad_request', false], ['content', false]
];
retryMatrix.forEach(([cat, want]) => {
  const got = IBERR.model(cat, { component: 'bridge' }).retryable;
  check('retryable ' + cat + ' = ' + want, got === want, got);
});

/* 13. code 稳定性（P5 可复用标识） */
section('code 稳定性');
const codeMatrix = [
  ['401', 'auth', 'IBERR.AUTH.401'],
  ['403', 'forbidden', 'IBERR.FORBIDDEN.403'],
  ['404', 'endpoint', 'IBERR.ENDPOINT.404'],
  ['429', 'rate_limit', 'IBERR.RATE_LIMIT.429'],
  ['500', 'provider', 'IBERR.PROVIDER.500']
];
codeMatrix.forEach(([st, cat, code]) => {
  const m = IBERR.present(new Error(st + ': boom'));
  check('code ' + st + ' → ' + code, m.code === code && m.category === cat, m.code);
});
check('本地服务 code 带组件名', IBERR.model('local_service', { component: 'vision' }).code === 'IBERR.LOCAL_SERVICE.VISION');
check('缺少密钥 code = IBERR.AUTH.MISSING', IBERR.model('auth', { reason: 'missing-key' }).code === 'IBERR.AUTH.MISSING');
check('缺少地址 code = IBERR.ENDPOINT.MISSING', IBERR.model('endpoint', { reason: 'missing-endpoint' }).code === 'IBERR.ENDPOINT.MISSING');
check('缺少密钥文案指向设置', /API 密钥/.test(IBERR.model('auth', { reason: 'missing-key' }).title));
check('缺少地址文案指向设置', /API 地址/.test(IBERR.model('endpoint', { reason: 'missing-endpoint' }).title));

/* ═══ 5. 技术详情：够用 + 脱敏 ═══ */
section('技术详情');
const SECRET = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX';
const detailModel = IBERR.present(
  new Error('401: {"error":{"message":"Invalid API key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX","request_id":"req_0123456789abcdef"}}'),
  {
    cfg: { provider: 'openai', model: 'gpt-4o', id: 'cfg_1', endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: SECRET },
    stage: 'chat', friendId: 'f1',
    /* 这些字段必须被忽略：请求体 / 用户 prompt 绝不进详情 */
    requestBody: '{"messages":[{"role":"user","content":"我的身份证号是 110101199001011234"}]}',
    messages: [{ role: 'user', content: '我的身份证号是 110101199001011234' }],
    prompt: '我的身份证号是 110101199001011234'
  }
);
const dt = detailModel.technicalDetails;
check('详情含 HTTP 状态', dt['HTTP 状态'] === '401', dt['HTTP 状态']);
check('详情含接口地址', dt['接口地址'] === 'https://api.openai.com/v1/chat/completions', dt['接口地址']);
check('详情含服务商 / 模型', dt['服务商'] === 'openai' && dt['模型'] === 'gpt-4o');
check('详情含发生位置', dt['发生位置'] === 'chat');
check('详情含请求 ID', dt['请求 ID'] === 'req_0123456789abcdef', dt['请求 ID']);
check('详情含原始信息', /Invalid API key/.test(dt['原始信息'] || ''), dt['原始信息']);
check('详情含调用栈', typeof dt['调用栈'] === 'string' && dt['调用栈'].length > 0);
check('详情含错误代码 / 类别', dt['错误代码'] === 'IBERR.AUTH.401' && dt['类别'] === 'auth');
const detailJson = JSON.stringify(dt);
check('详情不含 API Key', detailJson.indexOf(SECRET) === -1, detailJson.slice(0, 200));
check('详情不含 cfg.apiKey 字段', detailJson.indexOf('apiKey') === -1);
check('详情不含用户 prompt / 请求体', detailJson.indexOf('110101199001011234') === -1);
check('详情不含 requestBody / messages 键', detailJson.indexOf('requestBody') === -1 && detailJson.indexOf('messages') === -1);
check('detailsText() 可读且脱敏', /HTTP 状态：401/.test(IBERR.detailsText(detailModel)) && IBERR.detailsText(detailModel).indexOf(SECRET) === -1);

/* 脱敏规则逐项验证 */
section('脱敏规则');
const redactCases = [
  ['OpenAI sk- key', 'Authorization: Bearer sk-proj-abcdefghijklmnop123456', ['sk-proj-abcdefghijklmnop123456']],
  ['Google AIza key', 'https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent?key=AIzaSyD-abcdefghijklmnopqrst&alt=sse', ['AIzaSyD-abcdefghijklmnopqrst']],
  ['xAI / hf / ghp', 'xai-abcdefghijk hf_abcdefghijklm ghp_abcdefghijklmnop', ['xai-abcdefghijk', 'hf_abcdefghijklm', 'ghp_abcdefghijklmnop']],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', ['eyJhbGciOiJIUzI1NiJ9']],
  ['Cookie 头', 'Cookie: ib_session=deadbeefdeadbeef; token=zzzz', ['deadbeefdeadbeef', 'zzzz']],
  ['JSON api_key 字段', '{"api_key":"supersecretvalue","model":"gpt-4o"}', ['supersecretvalue']],
  ['JSON password 字段', '{"password":"hunter2hunter2"}', ['hunter2hunter2']],
  ['query token', 'https://e/v1/x?token=abcdef123456&foo=1', ['abcdef123456']],
  ['data:base64 图片', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB']],
  ['AWS AKIA', 'AKIAIOSFODNN7EXAMPLE', ['AKIAIOSFODNN7EXAMPLE']]
];
redactCases.forEach(([label, input, secrets]) => {
  const out = IBERR.redact(input);
  const leaked = secrets.filter(s => out.indexOf(s) !== -1);
  check('redact ' + label, leaked.length === 0, { out: out.slice(0, 160), leaked });
});
check('redactUrl 保留 host/path', IBERR.redactUrl('https://api.openai.com/v1/chat/completions?key=SECRET123&alt=sse').indexOf('https://api.openai.com/v1/chat/completions') === 0);
check('redactUrl 掩码 key', IBERR.redactUrl('https://x/y?key=SECRET123').indexOf('SECRET123') === -1);
check('redact 保留普通文本', IBERR.redact('服务商返回了 401，密钥无效') === '服务商返回了 401，密钥无效');
check('redact 截断超长文本', IBERR.redact('a'.repeat(5000), 100).length < 200);

/* ═══ 6. report() 向后兼容 ═══ */
section('report() 兼容性');
const logs = [];
const origErr = console.error;
console.error = function () { logs.push(Array.prototype.slice.call(arguments)); };
const rep = IBERR.report(new Error('429: {"error":"rate limit"}'), { cfg: { provider: 'openai', model: 'gpt-4o' }, friendId: 'f2', stage: 'chat' });
const repDup = IBERR.report(new Error('429: x'), { friendId: 'f2' });
console.error = origErr;
check('report 仍返回 category/text/dup', rep.category === 'rate_limit' && typeof rep.text === 'string' && typeof rep.dup === 'boolean', rep);
check('report 新增 code/model', rep.code === 'IBERR.RATE_LIMIT.429' && !!rep.model && rep.model.code === rep.code, rep.code);
check('report 仍写 console 完整诊断', logs.length === 2 && logs[0][0] === '[IB请求失败]' && logs[0][1].status === '429', logs.length);
check('report dup 抑制仍生效', repDup.dup === true);

/* 角色文案仍按角色稳定挑选（P1 行为） */
check('text() 仍可用且稳定', IBERR.text('network', 'Alice') === IBERR.text('network', 'Alice'));
check('text() 新类别有角色文案', IBERR.text('local_service', 'Alice').length > 0 && IBERR.text('tts', 'Bob').length > 0);

/* Gemini URL 脱敏（communication.js `_dbgRedactUrl` 契约） */
section('Gemini debug URL 脱敏（原有）');
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
