/* ====================================================================
   P21 · Middle Brain 统一思考深度（canonical reasoningEffort）· capability 专项测试
   --------------------------------------------------------------------
   只测「canonical 值 → provider wire 参数」这条边界，不碰任何业务链：

   A. canonical 归一：auto/low/medium/high/max；历史 xhigh → high；非法/缺失 → auto
   B. auto = 一个字段都不写：三种 format 的 body 与"完全不传 reasoningEffort"逐字节相等
      （= 上线前行为，DeepSeek 等 provider 的原生 auto reasoning 不受影响）
   C. 逐档映射：astra 直传 / OpenAI 官方值域就近降级 / Anthropic 预算表
   D. 未取证 provider（glm/qwen/minimax/mimo/gemini/custom/未知）与未取证 **model** 不污染 body
   E. provider fallback：未知 model、format 不支持、预算超出 max_tokens、预算 clamp
   F. 能力真源唯一性：provider 字段名只出现在 provider-directory.js（+ 边界翻译器），
      communication.js / Middle Brain 各层 / UI **零** provider 判断
   G. Speed 与 Reasoning Effort 相互独立（互不写对方字段）
   H. usage：实际 reasoning tokens 只读提取 + 只读回填到同一次调用的 trace 记录
   J. P21.1 · DeepSeek 校准：**模型级**登记（仅 deepseek-flash），canonical → reasoning_effort

   运行：node test_reasoning_capability.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IBMC = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js'));
const CANON = require(path.join(ROOT, 'assets', 'js', 'provider-directory.js'));
const createNodeModelPort = require(path.join(ROOT, 'active', 'node-model-port.js'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✘ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const prompt = [{ role: 'user', content: 'hi' }];
const bodyFor = (spec, opts) => IBMC.buildRequestBody(spec, prompt, Object.assign({ maxTokens: 4096 }, opts || {}));

(async () => {
  /* ══════════ A. canonical 归一 ══════════ */
  section('A · canonical 档位归一');
  check('A1.tiers', JSON.stringify(CANON.REASONING_TIERS) === JSON.stringify(['auto', 'low', 'medium', 'high', 'max']), CANON.REASONING_TIERS);
  check('A2.normalize.valid', ['auto', 'low', 'medium', 'high', 'max'].every(t => CANON.normalizeReasoningTier(t) === t));
  check('A3.normalize.legacyXhigh', CANON.normalizeReasoningTier('xhigh') === 'high');
  check('A4.normalize.invalid', CANON.normalizeReasoningTier('banana') === 'auto' && CANON.normalizeReasoningTier(null) === 'auto' && CANON.normalizeReasoningTier('HIGH') === 'high');
  check('A5.coreDelegatesToCanon', IBMC.normalizeReasoningTier('xhigh') === 'high' && IBMC.normalizeReasoningTier('nope') === 'auto');

  /* ══════════ B. auto 不改变现有请求（逐字节） ══════════ */
  section('B · auto = 不写任何字段（与上线前逐字节一致）');
  const specs = [
    { provider: 'deepseek', model: 'deepseek-flash' },
    { provider: 'openai', model: 'gpt-5.6-luna' },
    { provider: 'anthropic', model: 'claude-sonnet-5' },
    { provider: 'gemini', model: 'gemini-3.5-flash' },
    { provider: 'custom', model: 'whatever' }
  ];
  let autoOk = true, autoDetail = null;
  for (const spec of specs) {
    const plain = JSON.stringify(bodyFor(spec, {}));
    const auto = JSON.stringify(bodyFor(spec, { reasoningEffort: 'auto' }));
    if (plain !== auto) { autoOk = false; autoDetail = { spec, plain, auto }; break; }
  }
  check('B1.autoByteIdentical', autoOk, autoDetail);
  check('B2.autoNoReasoningKeys', (() => {
    const b = bodyFor({ provider: 'openai', model: 'gpt-5.6-luna' }, { reasoningEffort: 'auto' });
    return b.reasoning === undefined && b.reasoning_effort === undefined && b.thinking === undefined
      && !(b.generationConfig && b.generationConfig.thinkingConfig);
  })());
  check('B3.autoPlanReason', (() => { const p = CANON.reasoningWirePlan({ provider: 'openai', model: 'gpt-5.6-luna', format: 'openai', effort: 'auto' }); return p.effective === 'auto' && p.value === undefined && p.fallbackReason === 'auto'; })());

  /* ══════════ C. 逐档映射 ══════════ */
  section('C · canonical 档位 → 真实 wire 参数');
  /* astra（IB 自有 Responses 端点）：直传 Phase 4 契约。
     astra 不在 PROVIDERS 目录里（它不是目录 provider，而是 Middle Brain 自己的端点），
     所以这里走 Responses builder（= 生产路径），而不是 buildRequestBody 的 openai 分支。 */
  const astraMap = ['low', 'medium', 'high', 'max'].map(e => {
    const r = IBMC.AstraAdapter.buildResponsesRequest({ provider: 'astra', model: 'gpt-6-astra' }, prompt, { maxTokens: 1600, reasoningEffort: e });
    return r.body.reasoning && r.body.reasoning.effort;
  });
  check('C1.astraPassthrough', JSON.stringify(astraMap) === JSON.stringify(['low', 'medium', 'high', 'max']), astraMap);
  const astraPlan = CANON.reasoningWirePlan({ provider: 'astra', model: 'gpt-6-astra', format: 'responses', effort: 'max' });
  check('C2.astraWirePath', astraPlan.wirePath.join('.') === 'reasoning.effort' && astraPlan.fallbackReason === '');
  /* OpenAI：Responses 面 reasoning.effort；Chat 面 reasoning_effort；max 就近降级 high */
  check('C3.openaiChat.low', bodyFor({ provider: 'openai', model: 'gpt-5.6-luna' }, { reasoningEffort: 'low' }).reasoning_effort === 'low');
  check('C4.openaiChat.medium', bodyFor({ provider: 'openai', model: 'gpt-5.6-luna' }, { reasoningEffort: 'medium' }).reasoning_effort === 'medium');
  check('C5.openaiChat.high', bodyFor({ provider: 'openai', model: 'gpt-5.6-luna' }, { reasoningEffort: 'high' }).reasoning_effort === 'high');
  check('C6.openaiChat.maxDowngraded', (() => { const b = bodyFor({ provider: 'openai', model: 'gpt-5.6-luna' }, { reasoningEffort: 'max' }); return b.reasoning_effort === 'high'; })());
  check('C7.openaiResponses', (() => {
    const r = IBMC.AstraAdapter.buildResponsesRequest({ provider: 'openai', model: 'gpt-5.6-luna' }, prompt, { maxTokens: 1600, reasoningEffort: 'high' });
    return r.body.reasoning && r.body.reasoning.effort === 'high' && r.body.reasoning_effort === undefined;
  })());
  check('C8.openaiMaxPlanReason', CANON.reasoningWirePlan({ provider: 'openai', model: 'gpt-5.6-luna', format: 'openai', effort: 'max' }).fallbackReason === 'tier_downgraded');
  /* Anthropic：没有档位枚举 → official 预算是我们唯一能表达的手段，且必须 < max_tokens */
  const anthPlan = e => CANON.reasoningWirePlan({ provider: 'anthropic', model: 'claude-sonnet-5', format: 'anthropic', effort: e, maxTokens: 64000 });
  check('C9.anthropicBudgets', JSON.stringify([anthPlan('low').value, anthPlan('medium').value, anthPlan('high').value, anthPlan('max').value]) ===
    JSON.stringify([{ type: 'enabled', budget_tokens: 1024 }, { type: 'enabled', budget_tokens: 4096 }, { type: 'enabled', budget_tokens: 16384 }, { type: 'enabled', budget_tokens: 32768 }]));
  check('C10.anthropicWirePath', anthPlan('high').wirePath.join('.') === 'thinking');
  check('C11.anthropicBody', (() => {
    const b = bodyFor({ provider: 'anthropic', model: 'claude-sonnet-5' }, { reasoningEffort: 'high', maxTokens: 64000 });
    return b.thinking && b.thinking.type === 'enabled' && b.thinking.budget_tokens === 16384;
  })());
  check('C12.anthropicDatedSnapshot', CANON.reasoningWirePlan({ provider: 'anthropic', model: 'claude-sonnet-5-20260701', format: 'anthropic', effort: 'high', maxTokens: 64000 }).effective === 'high');

  /* ══════════ D. 不支持 / 未取证的 provider 不污染 body ══════════ */
  section('D · 未取证 provider 不污染 body');
  const untouched = [
    /* P21.1：deepseek-flash 已取证（见 J 段）→ 这里换成**未登记**的 DeepSeek model：
       能力是 model 级成立，绝不能因为 provider 是 deepseek 就跟着开启。 */
    { provider: 'deepseek', model: 'deepseek-v4-pro', format: 'openai' },
    { provider: 'glm', model: 'glm-4-flash', format: 'openai' },
    { provider: 'qwen', model: 'qwen-plus', format: 'openai' },
    { provider: 'minimax', model: 'MiniMax-Text-01', format: 'openai' },
    { provider: 'mimo', model: 'mimo-v2.5', format: 'openai' },
    { provider: 'gemini', model: 'gemini-3.5-flash', format: 'gemini' },
    { provider: 'moonshot', model: 'kimi-k2.6', format: 'openai' },
    { provider: 'custom', model: 'anything', format: 'openai' },
    { provider: 'totally-unknown', model: 'x', format: 'openai' }
  ];
  let cleanOk = true, cleanDetail = null;
  for (const spec of untouched) {
    const base = JSON.stringify(IBMC.buildRequestBody(spec, prompt, { maxTokens: 4096 }));
    for (const e of ['low', 'medium', 'high', 'max']) {
      const withEffort = JSON.stringify(IBMC.buildRequestBody(spec, prompt, { maxTokens: 4096, reasoningEffort: e }));
      if (base !== withEffort) { cleanOk = false; cleanDetail = { spec, e, base, withEffort }; break; }
    }
    if (!cleanOk) break;
  }
  check('D1.unsupportedBodyUntouched', cleanOk, cleanDetail);
  check('D2.unsupportedReason', CANON.reasoningWirePlan({ provider: 'deepseek', model: 'deepseek-v4-pro', format: 'openai', effort: 'high' }).fallbackReason === 'unverified_provider');
  /* 非推理型 OpenAI 模型（目录默认 gpt-4o-mini）：reasoning_effort 会 400，必须一条都不发 */
  check('D2b.openaiNonReasoningModelUntouched', (() => {
    const base = JSON.stringify(bodyFor({ provider: 'openai', model: 'gpt-4o-mini' }, {}));
    const withEffort = JSON.stringify(bodyFor({ provider: 'openai', model: 'gpt-4o-mini' }, { reasoningEffort: 'max' }));
    return base === withEffort && !/reasoning/.test(withEffort);
  })());
  check('D3.pendingIsAuditOnly', (() => {
    const t = read('assets/js/provider-directory.js');
    const pendingBlock = t.slice(t.indexOf('var REASONING_PENDING'), t.indexOf('function _reasoningStr'));
    return /REASONING_PENDING/.test(pendingBlock) && !/REASONING_PENDING\[/.test(t) && !/REASONING_CAPABILITIES\s*=\s*REASONING_PENDING/.test(t);
  })());

  /* ══════════ E. provider fallback ══════════ */
  section('E · provider fallback / 降级');
  check('E1.unknownModelOfVerifiedProvider', CANON.reasoningWirePlan({ provider: 'anthropic', model: 'claude-3-5-sonnet', format: 'anthropic', effort: 'high' }).fallbackReason === 'unverified_provider');
  check('E2.formatUnsupported', CANON.reasoningWirePlan({ provider: 'astra', model: 'gpt-6-astra', format: 'openai', effort: 'high' }).fallbackReason === 'format_unsupported');
  check('E3.budgetExceedsMaxTokens', CANON.reasoningWirePlan({ provider: 'anthropic', model: 'claude-sonnet-5', format: 'anthropic', effort: 'low', maxTokens: 300 }).fallbackReason === 'budget_exceeds_max_tokens');
  check('E4.budgetClamped', (() => { const p = CANON.reasoningWirePlan({ provider: 'anthropic', model: 'claude-sonnet-5', format: 'anthropic', effort: 'max', maxTokens: 2000 }); return p.fallbackReason === 'budget_clamped_to_max_tokens' && p.value.budget_tokens === 1999; })());
  check('E5.nearestNeverUpgrades', CANON.reasoningWirePlan({ provider: 'openai', model: 'gpt-5.6-luna', format: 'openai', effort: 'medium' }).effective === 'medium');
  check('E6.capabilityShape', (() => {
    const c = CANON.reasoningCapability('openai', 'gpt-5.6-luna');
    return c && c.verified === true && c.source === 'model' && c.kind === 'effort' && !!c.evidence;
  })());
  check('E7.capabilityUnknownProvider', CANON.reasoningCapability('nope', 'x') === null);

  /* ══════════ F. 能力真源唯一性（禁止散落 provider 判断） ══════════ */
  section('F · 能力真源唯一性（P21 结构守卫）');
  const PROVIDER_WIRE_TOKENS = /reasoning_effort|thinking_budget|enable_thinking|thinking_type|thinkingLevel|thinkingConfig|reasoning\.effort|budget_tokens/;
  const guardFiles = [
    'assets/js/communication.js',
    'assets/js/middle-brain-config.js',
    'assets/js/middle-brain-astra.js',
    'assets/js/middle-brain-judge.js',
    'assets/js/middle-brain-integrity.js',
    'assets/js/middle-brain.js',
    'assets/js/middle-brain-policy.js',
    'InternalBeyond.html'
  ];
  /* 只对「代码」做守卫：注释里说明既有契约（如 astra 的 reasoning.effort）不算散落判断。 */
  const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const offenders = guardFiles.filter(f => PROVIDER_WIRE_TOKENS.test(stripComments(read(f))));
  check('F1.noScatteredProviderWire', offenders.length === 0, offenders);
  check('F2.capabilityOnlyInDirectory', /REASONING_CAPABILITIES/.test(read('assets/js/provider-directory.js'))
    && !/REASONING_CAPABILITIES/.test(read('assets/js/ib-model-core.js')));
  check('F3.boundaryOnlyTranslator', /function applyReasoningEffort/.test(read('assets/js/ib-model-core.js')));
  check('F4.mbLayerForwardsCanonicalOnly', (() => {
    const t = read('assets/js/middle-brain-astra.js');
    return /middleBrainReasoningEffort/.test(t) && !/provider\s*===\s*'(openai|anthropic|gemini|deepseek)/.test(t);
  })());
  check('F5.consumerReadsCanonicalOnly', (() => {
    const t = read('assets/js/communication.js');
    return /middleBrainReasoningEffort/.test(t) && /applyReasoningEffort/.test(t)
      && !/provider\s*===\s*'openai'\s*&&[^\n]*reasoning/.test(t);
  })());

  /* ══════════ G. Speed 与 Reasoning Effort 相互独立 ══════════ */
  section('G · Speed / Reasoning Effort 严格分离');
  check('G1.effortNeverWritesServiceTier', ['low', 'high', 'max'].every(e => {
    const b = bodyFor({ provider: 'astra', model: 'gpt-6-astra' }, { reasoningEffort: e });
    return b.service_tier === undefined && b.speed === undefined;
  }));
  check('G2.speedNeverWritesReasoning', (() => {
    const b = bodyFor({ provider: 'astra', model: 'gpt-6-astra' }, { reasoningEffort: 'auto' });
    return b.reasoning === undefined;
  })());
  check('G3.separateFieldsInConfig', (() => {
    const t = read('assets/js/middle-brain-config.js');
    return /reasoningEffort/.test(t) && /speed/.test(t) && !/speed\s*:\s*reasoningEffort|reasoningEffort\s*:\s*_mbReadSpeed/.test(t);
  })());

  /* ══════════ H. usage：实际 reasoning tokens ══════════ */
  section('H · 实际 reasoning tokens（只读观测）');
  check('H1.openaiShape', IBMC.reasoningTokensFromUsage({ completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 125 } }, 'openai') === 125);
  check('H2.responsesShape', IBMC.reasoningTokensFromUsage({ output_tokens: 5, output_tokens_details: { reasoning_tokens: 1082 } }, 'responses') === 1082);
  check('H3.geminiShape', IBMC.reasoningTokensFromUsage({ thoughtsTokenCount: 77 }, 'gemini') === 77);
  check('H4.absentIsNull', IBMC.reasoningTokensFromUsage({ completion_tokens: 10 }, 'openai') === null && IBMC.reasoningTokensFromUsage(null, 'openai') === null);
  check('H5.parseResponseKeepsReasoningTokens', (() => {
    const p = IBMC.parseResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 4 } } }, { provider: 'openai' });
    return p.usage && p.usage.reasoning_tokens === 4;
  })());
  check('H6.tracePairing', (() => {
    IBMC.reasoningTraceReset();
    IBMC.applyReasoningEffort({ messages: [] }, { provider: 'openai', model: 'gpt-5.6-luna' }, { format: 'openai', effort: 'high', consumer: 'chat' });
    IBMC.applyReasoningEffort({ messages: [] }, { provider: 'deepseek', model: 'deepseek-v4-pro' }, { format: 'openai', effort: 'high', consumer: 'chat' });
    IBMC.noteReasoningTokens(125, { consumer: 'chat', provider: 'deepseek', model: 'deepseek-v4-pro' });
    const tr = IBMC.reasoningTrace(5);
    const openai = tr.find(r => r.provider === 'openai');
    const deepseek = tr.find(r => r.provider === 'deepseek');
    return openai && openai.reasoningTokens === null && deepseek && deepseek.reasoningTokens === 125
      && deepseek.requestedReasoningEffort === 'high' && deepseek.effectiveReasoningEffort === 'auto'
      && deepseek.reasoningFallbackReason === 'unverified_provider';
  })());
  check('H7.traceHasNoSecrets', (() => {
    const tr = IBMC.reasoningTrace(5);
    const keys = Object.keys(tr[0] || {});
    return keys.every(k => ['at', 'consumer', 'provider', 'model', 'format', 'requestedReasoningEffort', 'effectiveReasoningEffort', 'reasoningWireParam', 'reasoningFallbackReason', 'reasoningTokens'].includes(k));
  })());

  /* ══════════ I. Node ModelPort parity ══════════ */
  section('I · Node ModelPort（与浏览器 builder 同一份翻译）');
  const calls = [];
  const port = createNodeModelPort({ fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 9 } } }) }; } });
  await port.run({ spec: { provider: 'openai', model: 'gpt-5.6-luna', endpoint: 'https://x/y' }, messages: prompt, maxTokens: 100, reasoningEffort: 'high', consumer: 'diary' }, {});
  await port.run({ spec: { provider: 'openai', model: 'gpt-5.6-luna', endpoint: 'https://x/y' }, messages: prompt, maxTokens: 100, reasoningEffort: 'auto', consumer: 'diary' }, {});
  await port.run({ spec: { provider: 'deepseek', model: 'deepseek-v4-pro', endpoint: 'https://x/y' }, messages: prompt, maxTokens: 100, reasoningEffort: 'max', consumer: 'diary' }, {});
  await port.run({ spec: { provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://x/y' }, messages: prompt, maxTokens: 100, reasoningEffort: 'max', consumer: 'diary' }, {});
  check('I1.portEmitsWhenRequested', calls[0] && calls[0].reasoning_effort === 'high', calls[0]);
  check('I2.portAutoSilent', calls[1] && calls[1].reasoning_effort === undefined);
  check('I3.portUnverifiedSilent', calls[2] && calls[2].reasoning_effort === undefined && calls[2].thinking === undefined);
  check('I5.portDeepseekFlashEmitsMax', calls[3] && calls[3].reasoning_effort === 'max'
    && calls[3].thinking === undefined && calls[3].model === 'deepseek-flash', calls[3]);
  check('I4.portTraceParity', (() => {
    const tr = IBMC.reasoningTrace(10).filter(r => r.consumer === 'diary');
    return tr.some(r => r.provider === 'openai' && r.effectiveReasoningEffort === 'high' && r.reasoningWireParam === 'reasoning_effort');
  })());

  /* ══════════ J. P21.1 · DeepSeek 校准（模型级 · reasoning_effort low|high|max） ══════════ */
  section('J · P21.1 DeepSeek 校准（仅 deepseek-flash 一个 model id）');
  const dsSpec = { provider: 'deepseek', model: 'deepseek-flash' };
  const dsPlan = e => CANON.reasoningWirePlan({ provider: 'deepseek', model: 'deepseek-flash', format: 'openai', effort: e });
  const dsBody = e => bodyFor(dsSpec, { reasoningEffort: e });
  check('J1.modelLevelOnly', (() => {
    const c = CANON.reasoningCapability('deepseek', 'deepseek-flash');
    return !!c && c.source === 'model' && c.verified === true && c.kind === 'effort'
      && JSON.stringify(c.values) === JSON.stringify(['low', 'high', 'max'])
      /* provider 级条目必须不存在：不许按 provider 宽泛开启 */
      && !CANON.REASONING_CAPABILITIES.deepseek
      && !CANON.REASONING_PENDING.deepseek;
  })(), CANON.REASONING_CAPABILITIES.deepseek);
  check('J2.autoByteIdenticalToBaseline', (() => {
    const plain = JSON.stringify(bodyFor(dsSpec, {}));
    const auto = JSON.stringify(dsBody('auto'));
    const p = dsPlan('auto');
    return plain === auto && p.value === undefined && p.effective === 'auto' && p.fallbackReason === 'auto'
      && !/reasoning|thinking|service_tier/.test(plain);
  })(), bodyFor(dsSpec, { reasoningEffort: 'auto' }));
  check('J3.low', dsBody('low').reasoning_effort === 'low' && dsPlan('low').effective === 'low' && dsPlan('low').fallbackReason === '', dsPlan('low'));
  check('J4.mediumDowngradesToHigh', dsBody('medium').reasoning_effort === 'high'
    && dsPlan('medium').effective === 'high' && dsPlan('medium').fallbackReason === 'tier_downgraded', dsPlan('medium'));
  check('J5.high', dsBody('high').reasoning_effort === 'high' && dsPlan('high').fallbackReason === '' && dsPlan('high').effective === 'high');
  check('J6.max', dsBody('max').reasoning_effort === 'max' && dsPlan('max').effective === 'max' && dsPlan('max').fallbackReason === '');
  check('J7.wirePathIsChatEffort', dsPlan('high').wirePath.join('.') === 'reasoning_effort');
  check('J8.neverSendsThinking', ['auto', 'low', 'medium', 'high', 'max'].every(e => {
    const b = dsBody(e);
    const keys = Object.keys(b).filter(k => /reasoning|thinking/.test(k));
    return !('thinking' in b) && JSON.stringify(keys) === JSON.stringify(e === 'auto' ? [] : ['reasoning_effort']);
  }), ['auto', 'low', 'medium', 'high', 'max'].map(e => Object.keys(dsBody(e)).filter(k => /reasoning|thinking/.test(k))));
  check('J9.unregisteredDeepseekModelsStillAbstain', ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'deepseek-reasoner', 'deepseek-chat'].every(m => {
    const plan = CANON.reasoningWirePlan({ provider: 'deepseek', model: m, format: 'openai', effort: 'high' });
    const base = JSON.stringify(IBMC.buildRequestBody({ provider: 'deepseek', model: m }, prompt, { maxTokens: 4096 }));
    const withEffort = JSON.stringify(IBMC.buildRequestBody({ provider: 'deepseek', model: m }, prompt, { maxTokens: 4096, reasoningEffort: 'high' }));
    return plan.fallbackReason === 'unverified_provider' && base === withEffort && !/reasoning/.test(withEffort);
  }));
  check('J10.tierMapIsDataAndInValues', (() => {
    const pol = CANON.REASONING_MODEL_POLICIES['deepseek-flash'];
    const map = pol.tierMap || {};
    const keys = Object.keys(map).sort().join(',');
    /* 映射必须逐档写死，且取值只能是官方值域内的值（越界 → 运行时 abstain，不可能静默发出） */
    return keys === 'high,low,max,medium'
      && map.low === 'low' && map.medium === 'high' && map.high === 'high' && map.max === 'max'
      && Object.keys(map).every(k => pol.values.indexOf(map[k]) >= 0)
      && CANON.reasoningWirePlan({ provider: 'deepseek', model: 'deepseek-flash', format: 'openai', effort: 'medium' }).fallbackReason === 'tier_downgraded';
  })());
  check('J11.noDeepseekReasoningBranchOutsideData', (() => {
    const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    /* 翻译器本身必须完全不认识 deepseek 这个名字 */
    if (/deepseek/i.test(strip(read('assets/js/ib-model-core.js')))) return 'translator';
    /* consumer / Middle Brain 各层：没有任何一行同时出现 deepseek 与 reasoning
       （这些文件里 deepseek 的既有用法是图片能力与 max tokens 表，与思考深度无关） */
    const consumers = ['assets/js/communication.js', 'assets/js/middle-brain-astra.js', 'assets/js/middle-brain-config.js', 'assets/js/middle-brain.js'];
    const offenders = consumers.filter(f => strip(read(f)).split('\n').some(l => /deepseek/i.test(l) && /reasoning/i.test(l)));
    if (offenders.length) return offenders;
    /* provider-directory.js 内部：deepseek 只允许活在数据表里；查找/翻译逻辑段必须干净 */
    const raw = read('assets/js/provider-directory.js');
    const logic = strip(raw.slice(raw.indexOf('function _reasoningStr'), raw.indexOf('P16 · Provider Onboarding Metadata')));
    return !/deepseek/i.test(logic) && /DEEPSEEK_REASONING_MODELS/.test(raw);
  })());
  check('J12.responsesFormatUnsupported', dsPlan('high').fallbackReason === ''
    && CANON.reasoningWirePlan({ provider: 'deepseek', model: 'deepseek-flash', format: 'responses', effort: 'high' }).fallbackReason === 'format_unsupported');
  check('J13.speedUnaffected', ['low', 'medium', 'high', 'max'].every(e => {
    const b = dsBody(e);
    return b.service_tier === undefined && b.speed === undefined;
  }));
  check('J14.reasoningTokensTelemetryUnchanged', (() => {
    IBMC.reasoningTraceReset();
    IBMC.applyReasoningEffort({ messages: [] }, { provider: 'deepseek', model: 'deepseek-flash' }, { format: 'openai', effort: 'medium', consumer: 'chat' });
    IBMC.noteReasoningTokens(125, { consumer: 'chat', provider: 'deepseek', model: 'deepseek-flash' });
    const r = IBMC.reasoningTrace(3)[0];
    return !!r && r.requestedReasoningEffort === 'medium' && r.effectiveReasoningEffort === 'high'
      && r.reasoningWireParam === 'reasoning_effort' && r.reasoningFallbackReason === 'tier_downgraded'
      && r.reasoningTokens === 125
      && IBMC.reasoningTokensFromUsage({ completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 125 } }, 'openai') === 125;
  })(), IBMC.reasoningTrace(2));

  console.log('\n' + (failed === 0 ? 'reasoning capability test passed ✔' : 'reasoning capability test FAILED ✘')
    + ' (' + passed + ' passed, ' + failed + ' failed)');
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(err => {
  console.error('测试执行异常：', err && err.stack || err);
  process.exitCode = 1;
});
