/* ====================================================================
   GPT-6 Astra 最小适配层 · runtime-neutral 测试（纯 Node，无需 Chrome）
   覆盖：PROVIDERS 含 astra & 配置字段 / AstraAdapter.isAstra /
        buildRequest 归一(openai wire: system+role/jsonMode/temperature) /
        parseResponse 归一(content/reasoning/truncated/usage) /
        不改动其它 provider 既有格式。
   运行：node test_astra_adapter.js
   ==================================================================== */
'use strict';
const modelCore = require('./assets/js/ib-model-core.js');
let failures = 0;
const check = (n, c, d = '') => { if (c) console.log('  PASS  ' + n); else { failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const PROVIDERS = modelCore.PROVIDERS;
const ADAPTER = modelCore.AstraAdapter;

/* ① Astra 不是角色 Provider（PROVIDERS 注册表不含 astra），保持其它 provider 不变 */
check('astra.notRoleProvider', !PROVIDERS.astra, 'astra 不应作为角色 Provider 注册');
check('registry.noBehaviorChange.others', PROVIDERS.openai && PROVIDERS.openai.model === 'gpt-4o-mini' && PROVIDERS.anthropic.format === 'anthropic' && PROVIDERS.gemini.format === 'gemini' && !!PROVIDERS.custom);

/* ② AstraAdapter.isAstra */
check('isAstra.provider', ADAPTER.isAstra({ provider: 'astra' }) === true);
check('isAstra.gpt6model', ADAPTER.isAstra({ model: 'gpt-6-astra' }) === true);
check('isAstra.no', ADAPTER.isAstra({ provider: 'openai', model: 'gpt-4o-mini' }) === false);
check('isAstra.null', ADAPTER.isAstra(null) === false);

/* ③ buildRequest 归一（openai wire 形状） */
const req = ADAPTER.buildRequest(
  { provider: 'astra', model: 'gpt-6-astra', endpoint: 'https://api.astra.example.com/v1/chat/completions', temperature: 0.7 },
  { system: '你是 Astra。', messages: [{ role: 'user', content: '你好' }] },
  { maxTokens: 256, temperature: 0.7 }
);
check('buildReq.endpoint', req.endpoint === 'https://api.astra.example.com/v1/chat/completions');
check('buildReq.model', req.body.model === 'gpt-6-astra');
check('buildReq.systemFirst', req.body.messages[0].role === 'system' && req.body.messages[0].content === '你是 Astra。');
check('buildReq.userRole', req.body.messages[1].role === 'user' && req.body.messages[1].content === '你好');
check('buildReq.maxTokens', req.body.max_tokens === 256);
check('buildReq.temperature', req.body.temperature === 0.7);
check('buildReq.json', ADAPTER.buildRequest({ provider: 'astra', model: 'm' }, { messages: [{ role: 'user', content: 'x' }] }, { jsonMode: true }).body.response_format.type === 'json_object');
check('buildReq.noSideEffectOnOthers', modelCore.buildRequestBody({ provider: 'anthropic', model: 'c' }, { system: 's', messages: [{ role: 'user', content: 'u' }] }, {}).system !== undefined, 'anthropic shape changed');

/* ④ parseResponse 归一 */
const r = ADAPTER.parseResponse({ choices: [{ message: { content: 'Astra 回复', reasoning_content: '思考中' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }, { provider: 'astra' });
check('parseResp.content', r.content === 'Astra 回复');
check('parseResp.reasoning', r.reasoning === '思考中');
check('parseResp.truncated', r.truncated === true);
check('parseResp.usage', r.usage && r.usage.prompt_tokens === 10 && r.usage.completion_tokens === 5);

/* ⑤ normalizePrompt 统一入口 */
const np = ADAPTER.normalizePrompt([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { systemPrompt: '' });
check('normalizePrompt.system', np.system === 'S');
check('normalizePrompt.messages', Array.isArray(np.messages) && np.messages.length === 1 && np.messages[0].role === 'user');

console.log(failures === 0 ? '\nGPT-6 Astra adapter (runtime-neutral) passed ✔' : '\nGPT-6 Astra adapter FAILED ✘');
process.exit(failures ? 1 : 0);
