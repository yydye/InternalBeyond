/* ====================================================================
   P19 · Anthropic assistant prefill compatibility 专项测试
   --------------------------------------------------------------------
   锁定「结构化 JSON 意图（jsonMode）」与「assistant prefill 传输实现」解耦后的行为：

   A. model policy：Claude 4.6+ 不接受 assistant prefill（supportsAssistantPrefill=false），
      dated snapshot 走同一个 canonical lookup；未知 model 保持旧行为。
   B. request 构造：不支持 prefill 的 model 不追加 seed assistant 消息，改为 JSON-only
      prompt 约束；约束只注入一次；consumer 已自带等价指令时不插第二份。
   C. parsePlanJson：完整 JSON 优先；围栏次之；续写容错仅在调用方显式声明真的用了
      prefill 时开放；malformed 必须失败。
   D. Node Model Port / compat 与 core 的 policy 一致（prefillApplied 透传）。
   E. 反回归：普通聊天历史中的 assistant 消息永不因 policy 被删除。

   运行：node test_anthropic_prefill_policy.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const IBMC = require('./assets/js/ib-model-core.js');
const CANON = require('./assets/js/provider-directory.js');
const planDomain = require('./active/plan-domain.js')({
  getState: () => ({ plans: {}, settings: {} }),
  armedUsers: () => [],
  saveNow() {}
});
const createNodeModelPort = require('./active/node-model-port.js');
const createNodeModelCompat = require('./active/node-model-compat.js');
const createMomentsDomain = require('./active/moments.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✘ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const dirText = read('assets/js/provider-directory.js');
const coreText = read('assets/js/ib-model-core.js');
const commText = read('assets/js/communication.js');
const portText = read('active/node-model-port.js');
const momentsText = read('active/moments.js');
const planText = read('active/plan-domain.js');
const browserPlanText = read('assets/js/active-diary/active-plans.js');

/* ── 测试用 moments 域（只用到 parseMomentOutput / buildMomentPrompt，deps 全部为纯桩） ── */
const moments = createMomentsDomain({
  getState: () => ({ moments: {} }),
  armedUsers: () => [],
  saveNow() {}, queueSave() {},
  trimText: (s, n) => String(s == null ? '' : s).slice(0, n == null ? 1000 : n),
  deepClone: o => JSON.parse(JSON.stringify(o)),
  finiteTimestamp: () => 0,
  parsePlanJson: planDomain.parsePlanJson,
  contentText: c => (typeof c === 'string' ? c : String(c == null ? '' : c)),
  isCharacterModelReady: () => true,
  callCharacterModel: async () => ({}),
  proactiveTextSimilarity: () => 0,
  observe: () => {}
});

const anthBody = (model, prompt, opts) => IBMC.buildRequestBody(
  { provider: 'anthropic', model: model },
  prompt || { system: '你是 Sui。', messages: [{ role: 'user', content: '你好' }] },
  opts || {}
);
const msgsOf = body => (body && body.messages) || [];
const textOf = m => (typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('') : ''));
const jsonConstraintCount = body => msgsOf(body).reduce((n, m) => n + (textOf(m).match(/Return exactly one valid JSON object\./g) || []).length, 0);
const hasAssistantTail = body => msgsOf(body).length > 0 && msgsOf(body)[msgsOf(body).length - 1].role === 'assistant';

/* ═══ 1. model policy（canonical 唯一来源） ═══════════════════════ */
section('1. MODEL_POLICIES：supportsAssistantPrefill（canonical lookup）');

check('claude-sonnet-4-6 不接受 assistant prefill',
  CANON.modelSupportsAssistantPrefill('claude-sonnet-4-6') === false);
check('claude-sonnet-4-6 仍接受 temperature（P18 行为不变）',
  CANON.modelSupportsSamplingParameters('claude-sonnet-4-6') === true);
check('claude-sonnet-5 不接受 assistant prefill',
  CANON.modelSupportsAssistantPrefill('claude-sonnet-5') === false);
check('P18 已登记的其余新 Claude 全部不接受 prefill',
  ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-4-6']
    .every(id => CANON.modelSupportsAssistantPrefill(id) === false),
  ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-4-6']
    .map(id => id + ':' + CANON.modelSupportsAssistantPrefill(id)));
check('dated snapshot 与别名走同一 canonical policy（两个能力都归一）',
  CANON.modelSupportsAssistantPrefill('claude-sonnet-5-20260701') === false
  && CANON.modelSupportsSamplingParameters('claude-sonnet-5-20260701') === false
  && CANON.modelPolicy('claude-sonnet-5-20260701') === CANON.modelPolicy('claude-sonnet-5'));
check('legacy model 默认保留 prefill（claude-sonnet-4-5 / claude-sonnet-4-6 之前）',
  CANON.modelSupportsAssistantPrefill('claude-sonnet-4-5') === true
  && CANON.modelSupportsAssistantPrefill('claude-3-5-sonnet-20241022') === true);
check('unknown / 空 / null model 默认保留旧行为',
  CANON.modelSupportsAssistantPrefill('some-relay-model') === true
  && CANON.modelSupportsAssistantPrefill('') === true
  && CANON.modelSupportsAssistantPrefill(null) === true
  && CANON.modelSupportsAssistantPrefill(undefined) === true);
check('两条能力共用同一个 modelPolicy（没有第二套 model 表）',
  CANON.modelSupportsAssistantPrefill('__nope__') === CANON.modelPolicy('__nope__').supportsAssistantPrefill
  && CANON.modelSupportsSamplingParameters('__nope__') === CANON.modelPolicy('__nope__').supportsSamplingParameters
  && !/ANTHROPIC_PREFILL_MODELS|NO_PREFILL_MODELS|PREFILL_MODEL/.test(dirText + coreText + momentsText));
check('IBModelCore 与目录判定逐位一致',
  IBMC.modelSupportsAssistantPrefill('claude-sonnet-5') === false
  && IBMC.modelSupportsAssistantPrefill('claude-sonnet-4-6') === false
  && IBMC.modelSupportsAssistantPrefill('claude-sonnet-4-5') === true
  && IBMC.modelSupportsAssistantPrefill('whatever') === true);

/* ═══ 2. request 构造 ════════════════════════════════════════════ */
section('2. buildRequestBody：不支持 prefill → JSON 约束（不追加 seed）');

const barePrompt = { system: '你是 Sui。', messages: [{ role: 'user', content: '给我一个计划。' }] };
const s5Json = anthBody('claude-sonnet-5', barePrompt, { jsonMode: true, jsonPrefill: '{"action":', maxTokens: 1024, temperature: 0.7 });
check('Sonnet 5：没有 assistant seed', !hasAssistantTail(s5Json) && msgsOf(s5Json).every(m => m.role !== 'assistant'));
check('Sonnet 5：注入 JSON-only 约束一次', jsonConstraintCount(s5Json) === 1);
check('Sonnet 5：不发送 temperature', s5Json.temperature === undefined);
const s46Json = anthBody('claude-sonnet-4-6', barePrompt, { jsonMode: true, jsonPrefill: '{"action":', maxTokens: 1024, temperature: 0.7 });
check('Sonnet 4.6：没有 assistant seed', !hasAssistantTail(s46Json));
check('Sonnet 4.6：注入 JSON-only 约束一次', jsonConstraintCount(s46Json) === 1);
check('Sonnet 4.6：仍发送 temperature', s46Json.temperature === 0.7);
check('约束不进 system（不污染角色设定 / 缓存前缀）',
  s5Json.system === '你是 Sui。' && jsonConstraintCount(s5Json) === 1);
check('constraint 文本稳定且含首尾字符约束',
  /first non-whitespace character must be \{/.test(textOf(msgsOf(s5Json)[0]))
  && /final non-whitespace character must be \}/.test(textOf(msgsOf(s5Json)[0]))
  && /Do not use Markdown code fences/.test(textOf(msgsOf(s5Json)[0])));
check('重复构建（retry / rebuild）不堆叠约束',
  jsonConstraintCount(anthBody('claude-sonnet-5', barePrompt, { jsonMode: true, jsonPrefill: '{"action":' })) === 1
  && jsonConstraintCount(anthBody('claude-sonnet-5', s5Json, { jsonMode: true, jsonPrefill: '{"action":' })) === 1);
check('consumer 已自带等价 JSON 指令 → 不插第二份（moments / scheduler 措辞）',
  jsonConstraintCount(anthBody('claude-sonnet-5',
    { system: 'sys', messages: [{ role: 'user', content: '6. 只输出一个 JSON 对象：{"publish":true}' }] },
    { jsonMode: true, jsonPrefill: '{"publish":' })) === 0
  && jsonConstraintCount(anthBody('claude-sonnet-5',
    { system: '你只输出严格 JSON，不输出任何其他文字。', messages: [{ role: 'user', content: '评估一下' }] },
    { jsonMode: true })) === 0);
check('非 jsonMode 的普通 Chat：完全没有 JSON 约束',
  jsonConstraintCount(anthBody('claude-sonnet-5', barePrompt, { maxTokens: 512 })) === 0);
check('legacy model：保留原 assistant prefill（逐字不变）',
  hasAssistantTail(anthBody('claude-sonnet-4-5', barePrompt, { jsonMode: true, jsonPrefill: '{"action":' }))
  && msgsOf(anthBody('claude-sonnet-4-5', barePrompt, { jsonMode: true, jsonPrefill: '{"action":' })).slice(-1)[0].content === '{"action":');
check('未知 provider / 未知 model 的 anthropic 兼容端点行为不变',
  hasAssistantTail(anthBody('claude-sonnet-4-5', barePrompt, { jsonMode: true, jsonPrefill: '{"action":' })));
check('无 user 消息时约束也能落地（不会产出非法请求）',
  jsonConstraintCount(anthBody('claude-sonnet-5', { system: 'sys', messages: [] }, { jsonMode: true })) === 1);

/* ═══ 3. parsePlanJson 契约 ══════════════════════════════════════ */
section('3. parsePlanJson：完整 JSON 优先 / 围栏 / 续写受控 / malformed 失败');

const parse = planDomain.parsePlanJson;
check('A. 完整 JSON 直接解析（Claude 4.6+ 的正常返回）',
  JSON.stringify(parse('{"publish":true,"content":"你好"}')) === '{"publish":true,"content":"你好"}');
check('A. 完整 JSON 优先于任何续写容错（不会被多加 seed 破坏）',
  parse('{"a":1}', { prefillSeed: '{"publish":' }).a === 1);
check('B. ```json 围栏按既有兼容契约解析',
  parse('```json\n{"action":"schedule"}\n```').action === 'schedule'
  && parse('```\n{"action":"none"}\n```').action === 'none');
check('C. 续写形态：声明了真实 seed 时才补回完整 seed 解析',
  parse('true,"content":"你好"}', { prefillSeed: '{"publish":' }).content === '你好'
  && parse('"a":1}', { prefillSeed: '{' }).a === 1);
check("C. 旧式布尔写法等价于 seed = '{'（严格受限）",
  parse('"a":1}', { allowPrefillContinuation: true }).a === 1);
check('C. 未声明 prefill 时，续写形态必须失败（不做全局修复）',
  parse('"publish":true,"content":"你好"}') === null
  && parse('"publish":true,"content":"你好"}', { prefillSeed: '' }) === null
  && parse('"publish":true,"content":"你好"}', { allowPrefillContinuation: false }) === null);
check('C. 声明了 prefill 但形态不是续写时不得瞎补',
  parse('完全不是 JSON 的一段话', { prefillSeed: '{"publish":' }) === null
  && parse('{不是合法 JSON}', { prefillSeed: '{"publish":' }) === null
  && parse('"publish":true,"content":"你好"', { prefillSeed: '{"publish":' }) === null);
check('C. 非 { 开头的 seed 一律拒绝（不允许拼非法 JSON）',
  parse('"publish":true}', { prefillSeed: '[{"x":' }) === null);
check('D. malformed JSON 必须失败',
  parse('{"a":}') === null
  && parse('{') === null
  && parse('null') === null
  && parse('[]') === null
  && parse('not json at all') === null
  && parse('') === null);
check('D. 既有前后杂文容错保持不变（产品契约，test_active_plans.js 锁定）',
  parse('好的，结果如下：{"action":"cancel","reason":"ok"} 完毕').action === 'cancel');
check('Node 与浏览器两侧 parser 契约同源（都含 A/B/C 四段）',
  /prefillSeed/.test(planText) && /prefillSeed/.test(browserPlanText)
  && /allowPrefillContinuation/.test(planText) && /allowPrefillContinuation/.test(browserPlanText)
  && /asObject/.test(planText) && /asObject/.test(browserPlanText));

/* ═══ 4. Moments / consumer 真实行为 ════════════════════════════ */
section('4. Moments consumer：真实 prompt + 真实 parse');

const momentTask = {
  character: { id: 'c1', nickname: 'Sui', model: 'claude-sonnet-5', systemPrompt: '你是 Sui。' },
  user: { name: '用户' },
  chat_summary: '',
  recent_messages: [{ role: 'user', content: '晚上好' }, { role: 'assistant', content: '晚上好。' }],
  lastPostAt: 0,
  declineStreak: 0
};
const built = moments.buildMomentPrompt(momentTask);
check('moments prompt 自带 JSON-only 指令（因此不重复注入约束）',
  /只输出一个 JSON/.test(built.messages[1].content));
const momentsS5 = anthBody('claude-sonnet-5', built, { jsonMode: true, jsonPrefill: '{"publish":', maxTokens: 2048, temperature: 0.9 });
check('Moments + Sonnet 5：最后一条不是 assistant seed',
  !hasAssistantTail(momentsS5) && msgsOf(momentsS5).slice(-1)[0].role === 'user');
check('Moments + Sonnet 5：约束不重复（consumer 已有等价指令）', jsonConstraintCount(momentsS5) === 0);
check('Moments + Sonnet 5：不发送 temperature', momentsS5.temperature === undefined);
const moments46 = anthBody('claude-sonnet-4-6', built, { jsonMode: true, jsonPrefill: '{"publish":', maxTokens: 2048 });
check('Moments + Sonnet 4.6：同样无 assistant seed', !hasAssistantTail(moments46));
const momentsLegacy = anthBody('claude-sonnet-4-5', built, { jsonMode: true, jsonPrefill: '{"publish":' });
check('Moments + legacy model：保留 assistant prefill',
  hasAssistantTail(momentsLegacy) && msgsOf(momentsLegacy).slice(-1)[0].content === '{"publish":');
check('Moments parse：完整 JSON（4.6+ 返回）正常发布',
  (() => { const p = moments.parseMomentOutput('{"publish":true,"content":"今天很好","visibility":"all"}', { prefillSeed: '' }); return !!(p && p.publish === true && p.content === '今天很好'); })());
check('Moments parse：legacy 续写 + 真实 seed → 正常发布',
  (() => { const p = moments.parseMomentOutput('true,"content":"今天很好"}', { prefillSeed: '{"publish":' }); return !!(p && p.publish === true && p.content === '今天很好'); })());
check('Moments parse：legacy 续写但无 seed → 失败（不静默产出错计划）',
  moments.parseMomentOutput('true,"content":"今天很好"}', { prefillSeed: '' }) === null
  && moments.parseMomentOutput('true,"content":"今天很好"}') === null);
check('Moments：publish:false 语义不变', (() => { const p = moments.parseMomentOutput('{"publish":false,"reason":"不想发"}', { prefillSeed: '' }); return !!(p && p.publish === false && p.reason === '不想发'); })());
check('moments / scheduler / reply 链都把真实 prefillSeed 传给 parser',
  /prefillSeed: prefillSeed/.test(momentsText)
  && /prefillSeed: \(out && out\.prefillSeed\)/.test(read('active/scheduler.js'))
  && /parseJson\(raw, parseOpts\)/.test(read('assets/js/reply-chain-core.js')));

/* ═══ 5. Node Model Port / compat 继承 ══════════════════════════ */
section('5. Node Model Port：同一 policy、prefillApplied 透传');

const captured = [];
const fakeFetch = async (url, init) => {
  captured.push({ url: url, body: JSON.parse(init.body), headers: init.headers });
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({ content: [{ type: 'text', text: '{"publish":true,"content":"ok"}' }] })
  };
};

async function runPort(spec, request) {
  const port = createNodeModelPort({ fetch: fakeFetch, maxTokens: 512 });
  const compat = createNodeModelCompat({ modelPort: port });
  captured.length = 0;
  const out = await compat.run(Object.assign({
    spec: Object.assign({ endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'k', systemPrompt: 'sys' }, spec),
    messages: [{ role: 'user', content: 'hi' }]
  }, request || {}), {});
  return { out: out, body: captured[0] && captured[0].body };
}

(async function main() {
  const s5 = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5' }, { jsonMode: true, jsonPrefill: '{"publish":' });
  check('port · Sonnet 5：body 最后一条不是 assistant seed', !hasAssistantTail(s5.body));
  check('port · Sonnet 5：JSON 约束一次', jsonConstraintCount(s5.body) === 1);
  check('port · Sonnet 5：prefillApplied=false / seed 为空',
    s5.out.prefillApplied === false && s5.out.prefillSeed === '');
  check('port · Sonnet 5：不发送 temperature（P18 行为保持）',
    (await runPort({ provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.9 }, { jsonMode: true, jsonPrefill: '{"publish":' })).body.temperature === undefined);

  const s46 = await runPort({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { jsonMode: true, jsonPrefill: '{"publish":' });
  check('port · Sonnet 4.6：无 assistant seed + prefillApplied=false',
    !hasAssistantTail(s46.body) && s46.out.prefillApplied === false);
  const legacy = await runPort({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, { jsonMode: true, jsonPrefill: '{"publish":' });
  check('port · legacy model：保留 seed + prefillApplied=true + seed 透传一致',
    hasAssistantTail(legacy.body) && legacy.out.prefillApplied === true
    && legacy.out.prefillSeed === '{"publish":'
    && legacy.body.messages.slice(-1)[0].content === legacy.out.prefillSeed);
  const chat = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5' },
    { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好。' }, { role: 'user', content: '继续' }] });
  check('port · 普通 Chat：assistant 历史完整保留',
    chat.body.messages.length === 3 && chat.body.messages[1].role === 'assistant'
    && chat.body.messages[1].content === '你好。');
  check('port · 普通 Chat：无 JSON 约束', jsonConstraintCount(chat.body) === 0);
  check('port · 普通 Chat：prefillApplied=false', chat.out.prefillApplied === false);

  const diary = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5' }, { jsonMode: false });
  check('port · Diary（非 JSON consumer）：无约束、无 seed',
    jsonConstraintCount(diary.body) === 0 && !hasAssistantTail(diary.body));
  const roleLetters = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5' }, { jsonMode: true });
  check('port · Role Letters 类（jsonMode 无自定义指令）：得到一条 JSON 约束',
    jsonConstraintCount(roleLetters.body) === 1 && !hasAssistantTail(roleLetters.body));

  /* Moments 真实 prompt 走真实 port（Fake fetch）—— Phase 16 A/B/C 的 request-construction smoke */
  const mS5 = await runPort({ provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.9 },
    { messages: built.messages, jsonMode: true, jsonPrefill: '{"publish":' });
  check('smoke · Moments→port→Sonnet 5：最后一条是 user（无 seed）',
    mS5.body.messages.slice(-1)[0].role === 'user' && !hasAssistantTail(mS5.body));
  check('smoke · Moments→port→Sonnet 5：无第二条 JSON 约束、不发 temperature',
    jsonConstraintCount(mS5.body) === 0 && mS5.body.temperature === undefined);
  check('smoke · Moments→port→Sonnet 5：只去掉 seed，user 消息一字未改',
    mS5.body.messages.slice(-1)[0].role === 'user'
    && mS5.body.messages.slice(-1)[0].content === built.messages[1].content);
  /* P19 登记、P20 已修的 Node 侧 transport 差异：moments 的 prompt 自带一条 system 消息，
     Node 端口以 {system, messages} 形态交给 core。P20 后由 IBModelCore.normalizeAnthropicMessages
     把 system 消息提到顶层 system（与 spec.systemPrompt 合并、同文本去重），wire messages 里
     不再残留 system role。此处锁 P20 契约（完整契约见 test_anthropic_wire_contract.js）。
     本用例的 spec.systemPrompt('sys') 与消息内 system 文本**不同**，因此两条按序合并。 */
  check('P20：Node anthropic messages 里的 system 消息已归一到顶层（无 system role）',
    mS5.body.messages.map(m => m.role).join(',') === 'user'
    && mS5.body.messages.length === 1
    && mS5.body.system.indexOf('sys') === 0
    && mS5.body.system.indexOf(built.messages[0].content) > 0);
  const mS46 = await runPort({ provider: 'anthropic', model: 'claude-sonnet-4-6' },
    { messages: built.messages, jsonMode: true, jsonPrefill: '{"publish":' });
  check('smoke · Moments→port→Sonnet 4.6：同样无 seed + prefillApplied=false',
    !hasAssistantTail(mS46.body) && mS46.out.prefillApplied === false);
  const mLegacy = await runPort({ provider: 'anthropic', model: 'claude-sonnet-4-5' },
    { messages: built.messages, jsonMode: true, jsonPrefill: '{"publish":' });
  check('smoke · Moments→port→legacy：保留 seed + prefillApplied=true',
    hasAssistantTail(mLegacy.body) && mLegacy.out.prefillApplied === true);

  const openaiBody = await runPort({ provider: 'deepseek', model: 'deepseek-v4-flash' }, { jsonMode: true, jsonPrefill: '{"publish":' });
  check('port · DeepSeek（openai wire）：response_format 不变、无约束',
    openaiBody.body.response_format && openaiBody.body.response_format.type === 'json_object'
    && jsonConstraintCount(openaiBody.body) === 0);
  const geminiBody = await runPort({ provider: 'gemini', model: 'gemini-3.5-flash' }, { jsonMode: true });
  check('port · Gemini（gemini wire）：responseMimeType 不变',
    geminiBody.body.generationConfig && geminiBody.body.generationConfig.responseMimeType === 'application/json');

  /* ═══ 6. 反回归：绝不通过删除 assistant 来修 prefill ═══════════ */
  section('6. 反回归：assistant 历史 vs assistant prefill');

  check('实现里不存在「删掉所有 assistant」式修法',
    !/filter\([^)]*role\s*!==\s*'assistant'/.test(coreText + commText + momentsText + planText + browserPlanText + portText)
    && !/role\s*!==\s*'assistant'\s*\)\s*\)\s*;?\s*\/\* *P19/.test(coreText));
  check('buildRequestBody 只对「自己追加的 seed」做 policy 判定（不改入参 messages）',
    /ab\.messages = ab\.messages\.concat/.test(coreText)
    && /ab\.messages = _appendJsonOnlyConstraint\(ab\.system, ab\.messages\)/.test(coreText));
  const hist = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好。' }, { role: 'user', content: '继续' }];
  const histBody = anthBody('claude-sonnet-5', { system: 'sys', messages: hist }, { maxTokens: 100 });
  check('Sonnet 5：正常对话历史逐条保留',
    histBody.messages.length === 3 && histBody.messages.map(m => m.role).join(',') === 'user,assistant,user'
    && histBody.messages[1].content === '你好。');
  check('Sonnet 5：jsonMode 下历史 assistant 也保留（只去掉 seed）',
    (() => { const b = anthBody('claude-sonnet-5', { system: 'sys', messages: hist }, { jsonMode: true, jsonPrefill: '{"a":' }); return b.messages.length === 3 && b.messages[1].role === 'assistant'; })());
  check('浏览器侧从不使用 jsonPrefill（不存在浏览器 prefill 路径）',
    !/jsonPrefill/.test(commText));
  const astra = IBMC.AstraAdapter.buildRequest({ provider: 'astra', model: 'gpt-6-astra', endpoint: 'https://api.openai.com/v1/responses' },
    { system: 's', messages: [{ role: 'user', content: 'u' }] }, { jsonMode: true, jsonPrefill: '{"a":' });
  check('Middle Brain（Astra / Responses）不经该策略：无 seed、无约束、json_object 不变',
    astra.body.messages.every(m => m.role !== 'assistant')
    && !/Return exactly one valid JSON object/.test(JSON.stringify(astra.body))
    && astra.body.response_format.type === 'json_object');
  check('Role Letters / Diary 未引入 prefill 逻辑（浏览器 jsonMode 路径零变化）',
    !/jsonPrefill|supportsAssistantPrefill/.test(read('assets/js/role-letters.js'))
    && !/jsonPrefill|supportsAssistantPrefill/.test(read('assets/js/active-diary/diary.js'))
    && !/supportsAssistantPrefill/.test(commText));
  check('P19 未引入第二份模型能力表 / 未建 Registry',
    !/MODEL_REGISTRY|PREFILL_ALLOWLIST|supportsAssistantPrefill\s*=\s*\{/.test(dirText + coreText)
    && (dirText.match(/var MODEL_POLICIES/g) || []).length === 1);
  check('P19 未改动 provider 默认模型 / 未迁移用户配置',
    CANON.PROVIDERS.anthropic.model === 'claude-sonnet-5'
    && CANON.PROVIDERS.deepseek.model === 'deepseek-v4-flash'
    && !/apiConfigs\[[^\]]*\]\.model\s*=/.test(read('assets/js/social.js')));
  check('DeepSeek vision exp 审计状态保持已纠正（Phase 13 不回归）',
    CANON.modelAuditEntry('deepseek').status === 'current'
    && /^https:\/\/api-docs\.deepseek\.com\//.test(CANON.MODEL_AUDIT.deepseek.evidence));
  const socialText = read('assets/js/social.js');
  const samplingFn = socialText.slice(socialText.indexOf('function _syncSamplingUI()'), socialText.indexOf('/* Voice UI helpers */'));
  check('Temperature UI 同步只读 policy、不删除用户数值',
    samplingFn.length > 0
    && /modelSupportsSamplingParameters/.test(samplingFn)
    && /\.disabled=!supported/.test(samplingFn)
    && !/\.value\s*=/.test(samplingFn));

  console.log('\n' + (failed === 0 ? 'anthropic prefill policy test passed ✔' : 'anthropic prefill policy test FAILED ✘')
    + ' (' + passed + ' passed, ' + failed + ' failed)');
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(err => {
  console.error('测试执行异常：', err && err.stack || err);
  process.exitCode = 1;
});
