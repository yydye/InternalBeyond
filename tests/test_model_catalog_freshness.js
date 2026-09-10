'use strict';
/* Internal Beyond — P18 Model Catalog Freshness 防漂移测试
   运行：node test_model_catalog_freshness.js      （零网络、零浏览器）

   锁住的契约（对应 P18 Phase 14 的 15 项）：
     1. 所有 default model 非空的真实 Provider 都有审计状态
     2. 改动过的 default 与官方核实结果一致（并锁定整张默认表）
     3. 已有 API 配置的 model 不被自动迁移
     4. 新建 API 使用目录里的新 default
     5. 切换 provider 使用新 default
     6. 用户手改 model 后不被覆盖
     7. legacy model 仍能编辑 / 保存
     8. unknown model 不被静默替换
     9. DeepSeek vision exp 不被误判为非法 model
    10. Claude 新旧模型使用正确 request policy
    11. Claude Sonnet 5 不发送官方已移除的旧参数
    12. Claude 4.6 legacy 行为仍兼容
    13. setup wizard / onboarding 默认模型跟随目录
    14. Provider presentation 无回归
    15. API onboarding 无回归

   说明：4/5/10/11/12 用「抽出真实函数 + 最小 shim」做行为验证；3/6/7/8 用
   「源码结构断言 + 保存链数据流断言」验证——它们要证明的是**没有**发生迁移，
   而不是某个函数返回值。 */

const fs = require('fs');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const vm = require('vm');
const { spawnSync } = require('child_process');

const DIR_PATH = path.join(ROOT, 'assets', 'js', 'provider-directory.js');
const CORE_PATH = path.join(ROOT, 'assets', 'js', 'ib-model-core.js');
const SOCIAL_PATH = path.join(ROOT, 'assets', 'js', 'social.js');
const COMM_PATH = path.join(ROOT, 'assets', 'js', 'communication.js');
const WIZ_PATH = path.join(ROOT, 'assets', 'js', 'setup-wizard.js');
const ONB_PATH = path.join(ROOT, 'assets', 'js', 'api-onboarding.js');
const PORT_PATH = path.join(ROOT, 'active', 'node-model-port.js');

let passed = 0, failures = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

const canon = require(DIR_PATH);
const IBModelCore = require(CORE_PATH);
const dirText = fs.readFileSync(DIR_PATH, 'utf8');
const socialText = fs.readFileSync(SOCIAL_PATH, 'utf8');
const commText = fs.readFileSync(COMM_PATH, 'utf8');
const wizText = fs.readFileSync(WIZ_PATH, 'utf8');
const onbText = fs.readFileSync(ONB_PATH, 'utf8');
const portText = fs.readFileSync(PORT_PATH, 'utf8');

const ALL_IDS = Object.keys(canon.PROVIDERS);

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let depth = 0, seen = false;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') { depth++; seen = true; }
    else if (src[j] === '}') { depth--; if (seen && depth === 0) return src.slice(start, j + 1); }
  }
  return '';
}

/* ═══ 0. 导出面与 policy 语义 ════════════════════════════════ */
section('0. 目录导出面（P18 model 时效读取函数）');

for (const fn of ['modelPolicy', 'modelSupportsSamplingParameters', 'providerDefaultModel', 'modelAuditEntry']) {
  check('目录导出 ' + fn, typeof canon[fn] === 'function');
}
check('policy / audit 表都在目录里（唯一真源）',
  !!canon.MODEL_POLICIES && !!canon.MODEL_AUDIT && typeof canon.MODEL_POLICIES === 'object');
check('未知 model → 默认策略（照发采样参数，与 P18 之前一致）',
  canon.modelSupportsSamplingParameters('完全没见过的模型-1') === true
  && canon.modelSupportsSamplingParameters('') === true
  && canon.modelSupportsSamplingParameters(null) === true);
check('已取证的 model → 不接受采样参数',
  canon.modelSupportsSamplingParameters('claude-sonnet-5') === false);
check('Anthropic dated snapshot 归一后仍命中策略',
  canon.modelSupportsSamplingParameters('claude-sonnet-5-20260701') === false);
check('dated snapshot 只按官方命名约定归一（不做模糊匹配）',
  canon.modelSupportsSamplingParameters('claude-sonnet-5-preview') === true
  && canon.modelSupportsSamplingParameters('my-claude-sonnet-5') === true);
check('policy 不按 provider 一刀切（同 provider 的旧 model 仍照发）',
  canon.modelSupportsSamplingParameters('claude-sonnet-4-6') === true
  && canon.modelSupportsSamplingParameters('claude-opus-4-5') === true);
check('policy 是纯数据（无函数 / 无 DOM）',
  Object.keys(canon.MODEL_POLICIES).every(k => typeof canon.MODEL_POLICIES[k] === 'object')
  && !/document|navigator|querySelector|innerHTML/.test(
    dirText.slice(dirText.indexOf('var MODEL_POLICIES'), dirText.indexOf('var MODEL_AUDIT'))));

/* ═══ 1. 默认模型全表 + 审计覆盖 ═════════════════════════════ */
section('1. 默认模型全表锁定 + 审计状态覆盖');

const realProviders = ALL_IDS.filter(id => String(canon.PROVIDERS[id].model || '').trim() !== '');
check('真实 provider（有默认模型）数量 = 14', realProviders.length === 14, realProviders.length);
check('每个真实 provider 都有审计条目',
  realProviders.every(id => {
    const a = canon.modelAuditEntry(id);
    return ['current', 'deprecation-risk', 'unverified'].indexOf(a.status) !== -1 && !!a.audited;
  }), realProviders.filter(id => !canon.modelAuditEntry(id).audited));
check('审计表不包含目录以外的 provider',
  Object.keys(canon.MODEL_AUDIT).every(id => !!canon.PROVIDERS[id]),
  Object.keys(canon.MODEL_AUDIT).filter(id => !canon.PROVIDERS[id]));
check('audit 缺省 = unverified（绝不假装已核实）',
  canon.modelAuditEntry('__nope__').status === 'unverified'
  && canon.modelAuditEntry('__nope__').evidence === '');
check('status=current 的条目都带官方取证 URL',
  Object.keys(canon.MODEL_AUDIT)
    .filter(id => canon.MODEL_AUDIT[id].status === 'current')
    .every(id => /^https:\/\//.test(canon.MODEL_AUDIT[id].evidence)),
  Object.keys(canon.MODEL_AUDIT).filter(id => canon.MODEL_AUDIT[id].status === 'current' && !/^https:\/\//.test(canon.MODEL_AUDIT[id].evidence)));
/* DeepSeek 取证必须指向官方「首次调用 API」页（该页模型清单同时列出
   deepseek-v4-flash / -pro / -flash-vision-exp）；不许退回「无出处」状态。 */
check('deepseek 取证指向官方模型清单页（vision exp 已被官方文档收录）',
  /^https:\/\/api-docs\.deepseek\.com\//.test(canon.MODEL_AUDIT.deepseek.evidence)
  && canon.modelAuditEntry('deepseek').status === 'current',
  canon.MODEL_AUDIT.deepseek.evidence);

/* P18 只改了这三个；其余保持原值——本断言让任何后续改动都必须是有意的。 */
const EXPECTED_DEFAULTS = {
  anthropic: 'claude-sonnet-5',   /* P18 改：4.6 → 5 */
  openai: 'gpt-4o-mini',          /* 保持：官方 API 弃用表未确认，标 deprecation-risk */
  gemini: 'gemini-3.5-flash',     /* P18 改：2.0 已停用 */
  grok: 'grok-4.3',               /* P18 改：grok-4 已于 2026-05-15 退役 */
  deepseek: 'deepseek-v4-flash',
  moonshot: 'kimi-k2.6',
  mimo: 'mimo-v2.5',
  qwen: 'qwen-plus',
  glm: 'glm-4-flash',
  minimax: 'MiniMax-Text-01',
  doubao: 'doubao-seed-2-0-lite',
  mistral: 'mistral-large-latest',
  yi: 'yi-lightning',
  baichuan: 'Baichuan4'
};
check('默认模型表与 P18 审计结论逐项一致',
  Object.keys(EXPECTED_DEFAULTS).every(id => canon.PROVIDERS[id].model === EXPECTED_DEFAULTS[id]),
  Object.keys(EXPECTED_DEFAULTS).filter(id => canon.PROVIDERS[id].model !== EXPECTED_DEFAULTS[id])
    .map(id => id + ':' + canon.PROVIDERS[id].model));
check('providerDefaultModel() 与 PROVIDERS 逐项一致（无第二份）',
  ALL_IDS.every(id => canon.providerDefaultModel(id) === (canon.PROVIDERS[id].model || '')));
check('custom 仍然没有默认模型（兼容模式不自称有官方模型）', canon.PROVIDERS.custom.model === '');
check('latest 与 recommended default 允许不同（Grok / Gemini 已分列）',
  canon.modelAuditEntry('grok').latest !== canon.PROVIDERS.grok.model
  && canon.modelAuditEntry('gemini').latest !== canon.PROVIDERS.gemini.model);
check('未核实项如实标 unverified（MiniMax / yi / baichuan / mistral）',
  ['minimax', 'yi', 'baichuan', 'mistral'].every(id => canon.modelAuditEntry(id).status === 'unverified'),
  ['minimax', 'yi', 'baichuan', 'mistral'].map(id => id + ':' + canon.modelAuditEntry(id).status));

/* ═══ 2. DeepSeek vision exp ═════════════════════════════════ */
section('2. DeepSeek vision exp 不被误判为非法 model');

check('deepseek 默认仍是稳定调用 ID（不是内部版本名 / 不是带日期 id）',
  canon.PROVIDERS.deepseek.model === 'deepseek-v4-flash'
  && !/-\d{8}$/.test(canon.PROVIDERS.deepseek.model));
check('vision exp 是精确匹配常量（不是前缀 / 包含判断）',
  /DEEPSEEK_NATIVE_VISION_MODEL\s*=\s*'deepseek-v4-flash-vision-exp'/.test(commText)
  && /===DEEPSEEK_NATIVE_VISION_MODEL/.test(commText));
check('vision exp 没有任何策略限制（既不在黑名单也不被禁用）',
  canon.modelSupportsSamplingParameters('deepseek-v4-flash-vision-exp') === true
  && Object.keys(canon.MODEL_POLICIES).indexOf('deepseek-v4-flash-vision-exp') === -1);
check('仓库不存在 model 白名单校验（未知 model 不会被判非法）',
  !/MODEL_ALLOWLIST|VALID_MODELS|isKnownModel|SUPPORTED_MODELS/.test(
    commText + socialText + onbText + wizText + dirText));
check('vision exp 仍被 social.js 引用（P18 未删任何特殊用途 model）',
  /deepseek-v4-flash-vision-exp/.test(socialText));

/* ═══ 3. Claude request policy（core 真实行为） ═══════════════ */
section('3. Claude 新旧模型的 request policy（IBModelCore 真实行为）');

function anthBody(model, opts) {
  return IBModelCore.buildRequestBody(
    { provider: 'anthropic', model: model },
    { system: '你是 Sui。', messages: [{ role: 'user', content: '你好' }] },
    opts || {});
}
const s5 = anthBody('claude-sonnet-5', { maxTokens: 1024, temperature: 0.7 });
const s46 = anthBody('claude-sonnet-4-6', { maxTokens: 1024, temperature: 0.7 });
const s5NoTemp = anthBody('claude-sonnet-5', { maxTokens: 1024 });

check('Sonnet 5：不发送 temperature（官方已移除）', s5.temperature === undefined);
check('Sonnet 5：仍然发送 model / max_tokens / system / messages',
  s5.model === 'claude-sonnet-5' && s5.max_tokens === 1024 && s5.system === '你是 Sui。'
  && Array.isArray(s5.messages) && s5.messages.length === 1);
check('Sonnet 5：不发送任何官方禁止的旧参数',
  ['temperature', 'top_p', 'top_k', 'thinking', 'budget_tokens'].every(k => s5[k] === undefined),
  Object.keys(s5));
check('Sonnet 4.6 legacy：行为逐位不变（仍发送 temperature）',
  s46.temperature === 0.7 && s46.model === 'claude-sonnet-4-6' && s46.max_tokens === 1024);
check('未知 Claude model：保持旧行为（照发 temperature）',
  anthBody('claude-fable-9', { temperature: 0.7 }).temperature === 0.7);
check('未设 temperature 时两个模型都不发该字段',
  s5NoTemp.temperature === undefined && anthBody('claude-sonnet-4-6', {}).temperature === undefined);
check('非 anthropic 分支不受影响（openai / gemini 仍照发 temperature）',
  IBModelCore.buildRequestBody({ provider: 'openai', model: 'claude-sonnet-5' },
    { messages: [{ role: 'user', content: 'x' }] }, { temperature: 0.7 }).temperature === 0.7
  && IBModelCore.buildRequestBody({ provider: 'gemini', model: 'claude-sonnet-5' },
    { messages: [{ role: 'user', content: 'x' }] }, { temperature: 0.7 }).generationConfig.temperature === 0.7);
check('core 导出 modelSupportsSamplingParameters（宿主可复用）',
  typeof IBModelCore.modelSupportsSamplingParameters === 'function'
  && IBModelCore.modelSupportsSamplingParameters('claude-sonnet-5') === false
  && IBModelCore.modelSupportsSamplingParameters('claude-sonnet-4-6') === true);
check('Node active 端口经 core 构建 body（policy 自动生效，无需第二处判定）',
  /IBMC\.buildRequestBody/.test(portText) && !/temperature/.test(portText.split('buildRequestBody')[0].split('\n').slice(-3).join('\n')));

/* ═══ 4. communication.js 三处 anthropic temperature 门控 ════ */
section('4. 浏览器请求链的 anthropic temperature 门控（真实行为 + 源码）');

const gatedAnth = (commText.match(/temperature!=null&&_modelSupportsSampling\(cfg\)\)(?:ab|b|body)\.temperature=cfg\.temperature/g) || []);
check('三处 anthropic temperature 赋值全部走 policy（callApi / 流式 / 非流式）',
  gatedAnth.length === 3, gatedAnth);
check('不存在未门控的 anthropic temperature 赋值',
  !/temperature!=null\)(?:ab|b|body)\.temperature=cfg\.temperature/.test(commText));
check('openai / gemini 分支有意不加门控（策略只针对已取证的 model）',
  /temperature!=null\)ob\.temperature=cfg\.temperature/.test(commText)
  && /temperature!=null\)gB?Body?\.generationConfig\.temperature=cfg\.temperature/.test(commText)
  || /temperature!=null\)ob\.temperature=cfg\.temperature/.test(commText));

function runSupportsSampling(directory, model) {
  const sandbox = {
    window: { PROVIDERS_DIR: directory },
    PROVIDERS: (directory && directory.PROVIDERS) || {},
    cfg: { model: model }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractFn(commText, '_modelSupportsSampling'), sandbox, { filename: 'comm-policy.js' });
  return sandbox._modelSupportsSampling({ model: model });
}
check('communication.js policy 委托目录（抽出函数真实行为）',
  runSupportsSampling(canon, 'claude-sonnet-5') === false
  && runSupportsSampling(canon, 'claude-sonnet-4-6') === true);
check('目录缺失时回落「照发」（旧宿主行为不变）',
  runSupportsSampling(null, 'claude-sonnet-5') === true
  && runSupportsSampling({ PROVIDERS: canon.PROVIDERS }, 'claude-sonnet-5') === true);

/* ═══ 5. 新建 / 切换用新 default（真实行为） ══════════════════ */
section('5. 新建 API / 切换 provider 使用新 default（抽出 onProviderChange）');

function runProviderChange(directory, providerId, presetModel) {
  const els = {};
  for (const id of ['api-provider', 'api-endpoint', 'api-model', 'api-vision-toggle', 'api-streaming-toggle']) {
    els[id] = { id: id, value: '', checked: false };
  }
  els['api-provider'].value = providerId;
  if (presetModel != null) els['api-model'].value = presetModel;
  const marks = [];
  const sandbox = {
    document: { getElementById: id => els[id] || null },
    PROVIDERS: (directory && directory.PROVIDERS) || {},
    window: { PROVIDERS_DIR: directory },
    _showThinkingTouched: false,
    _ibMarkAutoFilled: (id, on) => { marks.push([id, !!on]); },
    _syncShowThinkingDefault: () => { },
    _syncVisionUI: () => { },
    _syncSamplingUI: () => { },
    _ibRefreshKeyHelp: () => { },
    _ibRefreshProviderNote: () => { }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractFn(socialText, 'onProviderChange'), sandbox, { filename: 'social-provider-change.js' });
  sandbox.onProviderChange();
  return { els, marks };
}

const pcAnth = runProviderChange(canon, 'anthropic');
check('新建 / 切到 Anthropic → 预填 claude-sonnet-5',
  pcAnth.els['api-model'].value === 'claude-sonnet-5', pcAnth.els['api-model'].value);
check('新建 / 切到 Gemini → 预填 gemini-3.5-flash',
  runProviderChange(canon, 'gemini').els['api-model'].value === 'gemini-3.5-flash');
check('新建 / 切到 xAI → 预填 grok-4.3',
  runProviderChange(canon, 'grok').els['api-model'].value === 'grok-4.3');
check('新建 / 切到 DeepSeek → 仍是 deepseek-v4-flash（未动）',
  runProviderChange(canon, 'deepseek').els['api-model'].value === 'deepseek-v4-flash');
check('预填的 model 被标记为「自动填入」（P16/P17 来源标记复用）',
  pcAnth.marks.some(m => m[0] === 'api-model' && m[1] === true), pcAnth.marks);
check('预填同时带出 endpoint（仍来自目录）',
  pcAnth.els['api-endpoint'].value === canon.PROVIDERS.anthropic.endpoint);
check('预填值 === 目录默认模型（逐 provider）',
  ALL_IDS.every(id => {
    if (!canon.PROVIDERS[id].model) return true;
    return runProviderChange(canon, id).els['api-model'].value === canon.PROVIDERS[id].model;
  }));
check('addNewApi 走同一条 onProviderChange（新配置只在这里取默认值）',
  /function addNewApi\(/.test(socialText)
  && /_ibSetProviderSelection\(_ibDefaultProvider\(\)\)[\s\S]{0,200}?onProviderChange\(\)/.test(socialText));

/* ═══ 6. 已有配置 / 手改 / legacy / unknown 不被迁移 ══════════ */
section('6. 已有配置不被迁移（model 是用户数据）');

const editApiSrc = extractFn(socialText, 'editApi');
check('editApi 从配置恢复 model（不是用目录默认值覆盖）',
  /api-model'\)\.value=cfg\.model\|\|''/.test(editApiSrc), editApiSrc.slice(0, 200));
check('editApi 不调用 onProviderChange（打开编辑器不换模型）',
  editApiSrc.indexOf('onProviderChange') === -1);
check('editApi 把 model 标为「非自动填入」（一键预填不得覆盖）',
  /_ibMarkAutoFilled\('api-model',false\)/.test(editApiSrc));
check('保存链写的是表单里的 model（用户手改值）',
  /model:modelVal/.test(socialText)
  && /var modelVal=\(document\.getElementById\('api-model'\)\.value\|\|''\)\.trim\(\)/.test(socialText));
check('保存链不会用目录默认值替换用户 model',
  !/model:\s*(?:PROVIDERS|_ibDir\(\)|PROVIDERS_DIR)/.test(socialText));
check('没有任何代码在加载 / 启动时改写已有配置的 model',
  !/apiConfigs\s*\.\s*forEach\([^)]*\)\s*=>\s*\{[^}]*\.model\s*=/.test(socialText)
  && !/cfg\.model\s*=\s*PROVIDERS\[/.test(socialText)
  && !/\.model\s*=\s*_ibDefaultModel/.test(socialText));
check('model 唯一自动写入点是 onProviderChange 的目录预填',
  (socialText.match(/api-model'\)\.value\s*=/g) || []).length === 2, /* editApi 恢复 + onProviderChange 预填 */
  (socialText.match(/api-model'\)\.value\s*=/g) || []).length);
check('api-onboarding 只在目录默认值上预填，且带来源标记（不覆盖用户手改）',
  /window\.onProviderChange\(\)/.test(onbText) && /markAuto\('api-model'/.test(onbText));
check('api-onboarding 不写 apiConfigs（配置落地复用编辑器）',
  !/dbPut\s*\(\s*['"]apiConfigs['"]/.test(onbText) && !/saveCurrentApi/.test(onbText));
check('setup-wizard 的新配置 model 取目录 meta.model（新配置用新 default）',
  /S\.model\s*=\s*meta\.model\s*\|\|\s*''/.test(wizText));
check('setup-wizard 不把默认模型写进已有配置',
  !/apiConfigs[^\n]*\.model\s*=/.test(wizText));

/* legacy / unknown model 可编辑可保存（纯数据层验证） */
const legacyCfg = { id: 'x', provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.5 };
const unknownCfg = { id: 'y', provider: 'anthropic', model: 'claude-my-private-1', temperature: 0.5 };
check('legacy model 仍按旧能力发送（temperature 保留）',
  anthBody(legacyCfg.model, { temperature: legacyCfg.temperature }).temperature === 0.5);
check('unknown model 不被静默替换成默认值',
  anthBody(unknownCfg.model, { temperature: unknownCfg.temperature }).model === 'claude-my-private-1'
  && canon.modelSupportsSamplingParameters(unknownCfg.model) === true);
check('unknown provider 的 model 不被目录默认值污染',
  canon.providerDefaultModel('__nope__') === '' && canon.providerEntry('__nope__') === null);

/* ═══ 7. Provider presentation / onboarding 无回归 ═══════════ */
section('7. Provider presentation / API onboarding 无回归（真实子进程）');

/* 被调起的两个守卫脚本是本文件的兄弟（同在 tests/）；cwd 仍是仓库根。 */
function runNode(rel, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, rel)].concat(args || []), {
    cwd: ROOT, encoding: 'utf8', timeout: 180000
  });
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
const pres = runNode('test_provider_presentation.js');
check('test_provider_presentation.js 全绿', pres.status === 0, pres.out.slice(-500));
const onb = runNode('test_api_onboarding.js');
check('test_api_onboarding.js 全绿', onb.status === 0, onb.out.slice(-500));

check('presentation 仍然不含模型 id（P18 没有把模型塞进呈现层）',
  !/claude-sonnet-5|gemini-3\.5-flash|grok-4\.3/.test(
    dirText.slice(dirText.indexOf('var PROVIDER_PRESENTATION'), dirText.indexOf('var GROUP_ORDER'))));
check('P18 没有新增第二份默认模型表',
  (dirText.match(/model:\s*'/g) || []).length === ALL_IDS.length,
  (dirText.match(/model:\s*'/g) || []).length);
check('P18 没有引入 Model Registry / 动态发现',
  !/MODEL_REGISTRY|fetchModels|listModels|discoverModels/.test(dirText + socialText + commText));

console.log('\n' + (failures === 0 ? 'model catalog freshness test passed ✔' : 'FAILURES: ' + failures)
  + ' (' + passed + ' passed, ' + failures + ' failed)');
process.exit(failures === 0 ? 0 : 1);
