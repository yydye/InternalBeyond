/* ====================================================================
   IB Model Core · provider wire-format 契约测试（纯 Node，零依赖，无需 Chrome）
   --------------------------------------------------------------------
   用途（两件事，缺一不可）：

   A. 契约锁定：钉住 IBModelCore.buildRequestBody / parseResponse 在
      anthropic / gemini / openai 三种 wire format 下的当前行为，作为
      后续把 communication.js 解析逻辑收敛到 core 时的黄金参考。

   B. 差异探针（PARITY）：把 communication.js 现有的解析表达式逐字转录
      成本文件的 legacy* 函数，与 IBModelCore.parseResponse 在同一组
      fixture 上逐字段对照（content / reasoning / reasoning_content /
      analysis / thinking / usage / finish_reason / truncated）。

   ⚠ 关于差异：本文件**不判定差异为失败**。发现差异时打印 WARN 并汇总，
     退出码仍为 0。原因：core 与现有实现存在差异是**已知且待决策**的，
     按改造约定「任何行为变化都先停下来报告」，不得为了统一而强行覆盖
     原行为。待步骤 4 逐项决策后，再把已确认的项转为硬断言。

   运行：node test_model_core_contract.js
   ==================================================================== */
'use strict';

const assert = require('assert');
const IBModelCore = require('./assets/js/ib-model-core.js');

let failures = 0;
let warnings = 0;
const check = (n, c, d) => {
  if (c) { console.log('  PASS  ' + n); }
  else { failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const warn = (n, c, d) => {
  if (c) { console.log('  PASS  ' + n); }
  else { warnings++; console.warn('  WARN  ' + n + (d ? '  -> ' + d : '')); }
};

/* ====================================================================
   PART A · 契约锁定：IBModelCore 当前行为
   ==================================================================== */
console.log('\n[A] IBModelCore 契约锁定 — buildRequestBody');

/* A1. providerFormat 判定 */
check('format.anthropic', IBModelCore.providerFormat('anthropic') === 'anthropic');
check('format.gemini', IBModelCore.providerFormat('gemini') === 'gemini');
check('format.openai', IBModelCore.providerFormat('openai') === 'openai');
check('format.deepseekIsOpenai', IBModelCore.providerFormat('deepseek') === 'openai');
check('format.glmIsOpenai', IBModelCore.providerFormat('glm') === 'openai');
check('format.unknownFallsBackOpenai', IBModelCore.providerFormat('不存在的厂商') === 'openai');
check('format.nullFallsBackOpenai', IBModelCore.providerFormat(null) === 'openai');

/* A2. anthropic 请求体（P19 起：assistant prefill 由 model policy 决定）
   · legacy model（未登记 policy）→ 保留历史 seed 行为 */
const abBody = IBModelCore.buildRequestBody(
  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  { system: '你是 Sui。', messages: [{ role: 'user', content: '你好' }] },
  { maxTokens: 1024, temperature: 0.5, jsonMode: true, jsonPrefill: '{"action":' }
);
check('anth.body.model', abBody.model === 'claude-sonnet-4-5');
check('anth.body.systemTopLevel', abBody.system === '你是 Sui。');
check('anth.body.maxTokens', abBody.max_tokens === 1024);
check('anth.body.temperature', abBody.temperature === 0.5);
check('anth.body.noMessagesSystem', abBody.messages.every(m => m.role !== 'system'));
check('anth.body.jsonPrefill.legacyModel', abBody.messages[abBody.messages.length - 1].role === 'assistant'
  && abBody.messages[abBody.messages.length - 1].content === '{"action":');

/* A2b. P19 · Claude 4.6+ 不接受 assistant prefill → 改为 JSON 约束 */
const ab46 = IBModelCore.buildRequestBody(
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { system: '你是 Sui。', messages: [{ role: 'user', content: '你好' }] },
  { maxTokens: 1024, temperature: 0.5, jsonMode: true, jsonPrefill: '{"action":' }
);
check('anth.body.46.noPrefill', ab46.messages.every(m => m.role !== 'assistant'));
check('anth.body.46.jsonConstraint', /Return exactly one valid JSON object/.test(ab46.messages[0].content));
check('anth.body.46.temperatureKept', ab46.temperature === 0.5);
const ab5 = IBModelCore.buildRequestBody(
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { system: '你是 Sui。', messages: [{ role: 'user', content: '你好' }] },
  { maxTokens: 1024, temperature: 0.5, jsonMode: true, jsonPrefill: '{"action":' }
);
check('anth.body.5.noPrefill', ab5.messages.every(m => m.role !== 'assistant'));
check('anth.body.5.noTemperature', ab5.temperature === undefined);

/* A3. gemini 请求体 */
const gbBody = IBModelCore.buildRequestBody(
  { provider: 'gemini', model: 'gemini-2.0-flash' },
  { system: '你是 Sui。', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在的' }] },
  { maxTokens: 2048, jsonMode: true }
);
check('gem.body.systemInstruction', gbBody.system_instruction.parts[0].text === '你是 Sui。');
check('gem.body.roleMap', gbBody.contents[0].role === 'user' && gbBody.contents[1].role === 'model');
check('gem.body.maxOutput', gbBody.generationConfig.maxOutputTokens === 2048);
check('gem.body.responseMimeType', gbBody.generationConfig.responseMimeType === 'application/json');

/* A4. openai 请求体 */
const obBody = IBModelCore.buildRequestBody(
  { provider: 'deepseek', model: 'deepseek-v4-flash' },
  { system: '你是 Sui。', messages: [{ role: 'user', content: '你好' }] },
  { maxTokens: 512, jsonMode: true }
);
check('oai.body.systemAsMessage', obBody.messages[0].role === 'system' && obBody.messages[0].content === '你是 Sui。');
check('oai.body.jsonObject', obBody.response_format.type === 'json_object');
check('oai.body.maxTokens', obBody.max_tokens === 512);

/* A5. 图片 part 三种塞法 */
const imgMsg = [{ role: 'user', content: [{ type: '_image', mime: 'image/png', base64: 'AAA' }, { type: 'text', text: '看图' }] }];
check('img.anthropic', JSON.stringify(IBModelCore.buildRequestBody({ provider: 'anthropic', model: 'm' }, { messages: imgMsg }, {}).messages[0].content)
  .indexOf('"source":{"type":"base64"') > -1);
check('img.gemini', JSON.stringify(IBModelCore.buildRequestBody({ provider: 'gemini', model: 'm' }, { messages: imgMsg }, {}).contents[0].parts)
  .indexOf('inlineData') > -1);
check('img.openai', JSON.stringify(IBModelCore.buildRequestBody({ provider: 'openai', model: 'm' }, { messages: imgMsg }, {}).messages[1].content)
  .indexOf('data:image/png;base64,AAA') > -1);

/* A6. 空/异常输入不炸 */
check('robust.emptyWire', IBModelCore.parseResponse(null, { provider: 'openai' }).content === '');
check('robust.emptyChoices', IBModelCore.parseResponse({}, { provider: 'openai' }).content === '');
check('robust.emptyAnthropic', IBModelCore.parseResponse({ content: [] }, { provider: 'anthropic' }).content === '');
check('robust.emptyGemini', IBModelCore.parseResponse({ candidates: [] }, { provider: 'gemini' }).content === '');

/* ====================================================================
   PART B · 差异探针：communication.js 现有实现 vs IBModelCore
   --------------------------------------------------------------------
   以下 legacy* 函数逐字转录自 communication.js（行号见注释），
   仅去掉外层 try/catch 与副作用调用（_mSetThink / _tkRecord / pack）。
   ==================================================================== */
console.log('\n[B] 差异探针 — 现有实现 vs IBModelCore.parseResponse');

/* —— 转录：现有 anthropic 解析（communication.js:3635-3647）—— */
function legacyAnthropicContent(data) {
  const textParts = (data.content || []).filter(function (c) { return c.type !== 'thinking'; });
  return textParts.map(function (c) { return c.text || ''; }).join('');
}
function legacyAnthropicThinking(data) {
  const thinkParts = (data.content || []).filter(function (c) { return c.type === 'thinking'; });
  return thinkParts.map(function (c) { return c.thinking || c.text || ''; }).join('\n');
}
function legacyAnthropicTruncated(data) { return data.stop_reason === 'max_tokens'; }

/* —— 转录：现有 gemini 解析（communication.js:3677-3684）—— */
function legacyGeminiContent(data) {
  const cand = (data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  return parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
}
function legacyGeminiThinking(data) {
  const cand = (data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  return parts.filter(function (p) { return p.thought === true; }).map(function (p) { return p.text || ''; }).join('\n');
}
function legacyGeminiTruncated(data) {
  const cand = (data.candidates && data.candidates[0]) || {};
  return cand.finishReason === 'MAX_TOKENS';
}

/* —— 转录：现有 openai 解析（communication.js:3712-3714）—— */
function legacyOpenAIContent(data) {
  const ch = (data.choices && data.choices[0]) || {};
  return (ch.message && ch.message.content) || '';
}
function legacyOpenAIThinking(data) {
  const ch = (data.choices && data.choices[0]) || {};
  return (ch.message && ch.message.reasoning_content != null) ? String(ch.message.reasoning_content) : '';
}
function legacyOpenAITruncated(data) {
  const ch = (data.choices && data.choices[0]) || {};
  return ch.finish_reason === 'length';
}

/* —— 转录：现有 usage 记账字段（anthropic 3626 / gemini 3676 / openai 3710）—— */
function legacyAnthropicUsage(data) {
  const u = data.usage || {};
  return { i: u.input_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0, o: u.output_tokens || 0 };
}
function legacyOpenAIUsage(data) {
  const u = data.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
    || (u.input_tokens_details && u.input_tokens_details.cached_tokens)
    || u.prompt_cache_hit_tokens || 0;
  return { i: Math.max(0, (u.prompt_tokens || 0) - cached), cr: cached, o: u.completion_tokens || 0 };
}

const FIXTURES = [
  {
    name: 'anthropic.basic', provider: 'anthropic',
    wire: { content: [{ type: 'text', text: '你好' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } },
    legacy: { content: legacyAnthropicContent, reasoning: legacyAnthropicThinking, truncated: legacyAnthropicTruncated }
  },
  {
    name: 'anthropic.thinking', provider: 'anthropic',
    wire: { content: [{ type: 'thinking', thinking: '思考中' }, { type: 'text', text: '答案' }], stop_reason: 'end_turn' },
    legacy: { content: legacyAnthropicContent, reasoning: legacyAnthropicThinking, truncated: legacyAnthropicTruncated }
  },
  {
    name: 'anthropic.toolUse', provider: 'anthropic',
    wire: { content: [{ type: 'tool_use', name: 'x', input: {} }, { type: 'text', text: '答案' }], stop_reason: 'tool_use' },
    legacy: { content: legacyAnthropicContent, reasoning: legacyAnthropicThinking, truncated: legacyAnthropicTruncated }
  },
  {
    name: 'anthropic.maxTokens', provider: 'anthropic',
    wire: { content: [{ type: 'text', text: '被截断' }], stop_reason: 'max_tokens' },
    legacy: { content: legacyAnthropicContent, reasoning: legacyAnthropicThinking, truncated: legacyAnthropicTruncated }
  },
  {
    name: 'gemini.basic', provider: 'gemini',
    wire: { candidates: [{ content: { parts: [{ text: '你好' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, cachedContentTokenCount: 0 } },
    legacy: { content: legacyGeminiContent, reasoning: legacyGeminiThinking, truncated: legacyGeminiTruncated }
  },
  {
    name: 'gemini.thought', provider: 'gemini',
    wire: { candidates: [{ content: { parts: [{ text: '思考', thought: true }, { text: '答案' }] }, finishReason: 'STOP' }] },
    legacy: { content: legacyGeminiContent, reasoning: legacyGeminiThinking, truncated: legacyGeminiTruncated }
  },
  {
    name: 'gemini.MAX_TOKENS', provider: 'gemini',
    wire: { candidates: [{ content: { parts: [{ text: '截断' }] }, finishReason: 'MAX_TOKENS' }] },
    legacy: { content: legacyGeminiContent, reasoning: legacyGeminiThinking, truncated: legacyGeminiTruncated }
  },
  {
    name: 'gemini.finishReasonLowercase', provider: 'gemini',
    wire: { candidates: [{ content: { parts: [{ text: '截断' }] }, finishReason: 'max_tokens' }] },
    legacy: { content: legacyGeminiContent, reasoning: legacyGeminiThinking, truncated: legacyGeminiTruncated }
  },
  {
    name: 'openai.basic', provider: 'openai',
    wire: { choices: [{ message: { content: '你好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  },
  {
    name: 'openai.reasoningContent(DeepSeek)', provider: 'deepseek',
    wire: { choices: [{ message: { reasoning_content: '推理中', content: '答案' }, finish_reason: 'stop' }] },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  },
  {
    name: 'openai.reasoningField', provider: 'openai',
    wire: { choices: [{ message: { reasoning: '推理中', content: '答案' }, finish_reason: 'stop' }] },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  },
  {
    name: 'openai.analysisField', provider: 'openai',
    wire: { choices: [{ message: { analysis: '分析中', content: '答案' }, finish_reason: 'stop' }] },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  },
  {
    name: 'openai.thinkingField', provider: 'openai',
    wire: { choices: [{ message: { thinking: '思考中', content: '答案' }, finish_reason: 'stop' }] },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  },
  {
    name: 'openai.finishReasonLength', provider: 'openai',
    wire: { choices: [{ message: { content: '截断' }, finish_reason: 'length' }] },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  },
  {
    name: 'openai.finishReasonMaxTokens', provider: 'openai',
    wire: { choices: [{ message: { content: '截断' }, finish_reason: 'max_tokens' }] },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  },
  {
    name: 'openai.emptyContent', provider: 'openai',
    wire: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
    legacy: { content: legacyOpenAIContent, reasoning: legacyOpenAIThinking, truncated: legacyOpenAITruncated }
  }
];

const divergences = [];
for (const fx of FIXTURES) {
  const core = IBModelCore.parseResponse(fx.wire, { provider: fx.provider });
  const lc = fx.legacy.content(fx.wire);
  const lr = fx.legacy.reasoning(fx.wire);
  const lt = fx.legacy.truncated(fx.wire);
  if (core.content !== lc) divergences.push({ fixture: fx.name, field: 'content', legacy: lc, core: core.content });
  if (core.reasoning !== lr) divergences.push({ fixture: fx.name, field: 'reasoning', legacy: lr, core: core.reasoning });
  if (core.truncated !== lt) divergences.push({ fixture: fx.name, field: 'truncated', legacy: lt, core: core.truncated });
  warn('parity.' + fx.name + '.content', core.content === lc, 'legacy=' + JSON.stringify(lc) + ' core=' + JSON.stringify(core.content));
  warn('parity.' + fx.name + '.reasoning', core.reasoning === lr, 'legacy=' + JSON.stringify(lr) + ' core=' + JSON.stringify(core.reasoning));
  warn('parity.' + fx.name + '.truncated', core.truncated === lt, 'legacy=' + String(lt) + ' core=' + String(core.truncated));
}

/* —— usage 字段覆盖度对照（core 是否会丢字段）—— */
console.log('\n[B2] usage 字段覆盖度对照');
const anthFx = FIXTURES[0].wire;
const coreAnthUsage = IBModelCore.parseResponse(anthFx, { provider: 'anthropic' }).usage;
const legacyAnthUsage = legacyAnthropicUsage(anthFx);
warn('usage.anthropic.input', coreAnthUsage.input_tokens === (legacyAnthUsage.i > 0 ? legacyAnthUsage.i : 0),
  'legacy.i=' + legacyAnthUsage.i + ' core.input_tokens=' + coreAnthUsage.input_tokens);
warn('usage.anthropic.hasCacheRead', Object.prototype.hasOwnProperty.call(coreAnthUsage, 'cache_read_input_tokens'),
  'core 未暴露 cache_read_input_tokens（现实现 cr=' + legacyAnthUsage.cr + '）');
warn('usage.anthropic.hasCacheCreation', Object.prototype.hasOwnProperty.call(coreAnthUsage, 'cache_creation_input_tokens'),
  'core 未暴露 cache_creation_input_tokens（现实现 cw=' + legacyAnthUsage.cw + '）');

const dsWire = { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 } };
const coreDsUsage = IBModelCore.parseResponse(dsWire, { provider: 'deepseek' }).usage;
const legacyDsUsage = legacyOpenAIUsage(dsWire);
warn('usage.deepseek.cached', coreDsUsage && (coreDsUsage.cache_read != null || coreDsUsage.prompt_cache_hit_tokens != null),
  'core 未暴露缓存命中字段（现实现 cr=' + legacyDsUsage.cr + '）');

/* —— 汇总 —— */
console.log('\n' + '─'.repeat(72));
if (divergences.length) {
  console.log('发现语义差异 ' + divergences.length + ' 处（按约定：仅报告，不自动统一）：');
  divergences.forEach(function (d) {
    console.log('  · [' + d.field + '] ' + d.fixture);
    console.log('      现有实现 = ' + JSON.stringify(d.legacy));
    console.log('      core     = ' + JSON.stringify(d.core));
  });
} else {
  console.log('未发现语义差异。');
}
console.log('─'.repeat(72));

console.log('\n' + (failures === 0
  ? 'Model Core 契约测试：断言全部通过 ✔（差异 WARN ' + warnings + ' 处，见上表）'
  : 'Model Core 契约测试 FAILED ✘'));
process.exit(failures ? 1 : 0);
