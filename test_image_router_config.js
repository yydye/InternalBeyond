/* ====================================================================
   Internal Beyond · Image Router 配置层专项测试（纯 Node，零依赖）
   --------------------------------------------------------------------
   覆盖（P15）：
     Catalog     唯一模型目录：Image 2.5 真实 id、能力过滤、wire format、档位映射
     Route cfg   normalizeRoute / saveRoutes 与并发覆盖字段共存（不新建第二套存储）
     Resolve     inherit / bound / disabled / 配置缺失 / 缺 Key / 缺 Endpoint / 不支持 provider
     Model       显式模型 → 能力校验（IMAGE_MODEL_UNKNOWN / IMAGE_MODEL_CAPABILITY）
     Fallback    备用通道解析（缺失/不支持时如实降级为"没有备用"）
     Core 接线   resolveRoute → 决策 → executor：模型进入请求 cfg、配置错误 0 次请求、
                 备用通道只在 provider 类失败时重试、telemetry 含路由来源且不含凭证
     Describe    Settings UI 只读描述（状态码 / provider / 能力过滤后的模型列表）
     Text        每个错误码都有不同且可执行的用户文案（指明"去哪里修"）
   运行：node test_image_router_config.js
   ==================================================================== */
'use strict';
const path = require('path');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const MODELS = require('./assets/js/image-models-core.js');
const CORE = require('./assets/js/image-router-core.js');

/* ── 浏览器宿主最小桩：window / IB.expose / IndexedDB 三个全局 + 执行器契约桩 ──
   执行器的 provider 推断与编辑能力判定属于 workspace.js（浏览器），
   这里用**契约桩**覆盖配置层逻辑；真实实现由 test_image_router_settings_smoke.js 在
   浏览器里逐字验证。 */
const store = { apiSettings: {}, apiConfigs: {} };
global.dbGet = (s, id) => Promise.resolve(store[s] ? store[s][id] : undefined);
global.dbPut = (s, rec) => { store[s][rec.id] = rec; return Promise.resolve(rec.id); };
global.dbGetAll = (s) => Promise.resolve(Object.keys(store[s] || {}).map(k => store[s][k]));
global.window = {};
global.window.IBImageModelsCore = MODELS;
global.window.IB = { expose: (name, obj) => { const node = (global.window.IB[name] = global.window.IB[name] || {}); Object.assign(node, obj); return node; } };
global.window.IB.imageRouter = { imageRejectText: CORE.imageRejectText, reloadConfig: () => true };
/* provider 推断桩：显式 imageGenProvider > provider；anthropic/deepseek + 有生图模型 → 按模型名推断 */
global.window._imgResolveProvider = (cfg) => {
  cfg = cfg || {};
  const ip = String(cfg.imageGenProvider || '').trim().toLowerCase();
  if (ip) return ip;
  const prov = String(cfg.provider || '').trim().toLowerCase();
  if (prov === 'anthropic' || prov === 'deepseek') {
    const m = String(cfg.imageGenModel || '').toLowerCase();
    return m ? (/gemini/i.test(m) ? 'gemini' : 'openai') : prov;
  }
  return prov;
};
/* 编辑能力桩：与 workspace.js._imgEditCapability 的判定边界一致 */
global.window._imgEditCapability = (cfg) => {
  cfg = cfg || {};
  const iprov = global.window._imgResolveProvider(cfg);
  const model = String(cfg.imageGenModel || '').trim() || (iprov === 'gemini' ? 'gemini-2.5-flash-image' : 'gpt-image-1');
  if (iprov === 'anthropic' || iprov === 'deepseek') return { ok: false, code: 'IMAGE_EDIT_UNSUPPORTED', reason: 'provider 不支持图片编辑' };
  if (iprov === 'gemini') return { ok: true, wire: 'gemini_inline', model: model };
  if (/^gpt-image/i.test(model) || /^dall-e-2/i.test(model)) return { ok: true, wire: 'openai_images_edits', model: model };
  return { ok: false, code: 'IMAGE_EDIT_UNSUPPORTED', reason: '模型 ' + model + ' 不支持图片编辑' };
};

require('./assets/js/image-router-config.js');
const CFG = global.window.IB.imageRouterConfig;

const flush = () => new Promise(r => setTimeout(r, 0));
function seedConfigs(list) {
  store.apiConfigs = {};
  list.forEach(c => { store.apiConfigs[c.id] = c; });
}
const openaiCfg = (id, over) => Object.assign({
  id: id, nickname: id, provider: 'openai', model: 'gpt-4o-mini', endpoint: 'https://api.example.com/v1/chat/completions',
  apiKey: 'sk-test', imageGen: true, imageGenModel: ''
}, over || {});

(async function run() {
  /* ── ① 唯一模型目录 ────────────────────────────────────────────────── */
  console.log('Catalog');
  check('catalog.image25RealIds', MODELS.tierModelId('flare') === 'gpt-image-2.5-flare' && MODELS.tierModelId('sunburst') === 'gpt-image-2.5-sunburst');
  check('catalog.coreUsesCatalog', CORE.IMAGE_MODELS.flare === MODELS.tierModelId('flare') && CORE.IMAGE_MODELS.sunburst === MODELS.tierModelId('sunburst'));
  const genIds = MODELS.listImageModels({ capability: 'image-generation' }).map(m => m.id);
  const editIds = MODELS.listImageModels({ capability: 'image-editing' }).map(m => m.id);
  check('catalog.generationFilter', genIds.includes('gpt-image-2.5-flare') && genIds.includes('dall-e-3') && !genIds.includes('nonexistent'));
  check('catalog.editingFilterExcludesDallE3', editIds.includes('gpt-image-2.5-sunburst') && !editIds.includes('dall-e-3'));
  check('catalog.unknownCapabilityEmpty', MODELS.listImageModels({ capability: 'image-translation' }).length === 0);
  check('catalog.providerFilter', MODELS.listImageModels({ provider: 'gemini' }).every(m => m.provider === 'gemini'));
  check('catalog.displayNameAndIdSameRecord', MODELS.imageModel('GPT-IMAGE-2.5-FLARE').label === 'GPT Image 2.5 Flare' && MODELS.requestModelId('GPT-IMAGE-2.5-FLARE') === 'gpt-image-2.5-flare');
  check('catalog.wireFor', MODELS.wireFor('gpt-image-2.5-sunburst', 'edit') === 'openai_images_edits'
    && MODELS.wireFor('gemini-2.5-flash-image', 'generate') === 'gemini_inline'
    && MODELS.wireFor('dall-e-3', 'edit') === null);
  check('catalog.capabilityByOperation', MODELS.capabilityForOperation('edit') === 'image-editing' && MODELS.capabilityForOperation('generate') === 'image-generation');
  check('catalog.normalizeOperation', MODELS.normalizeOperation({}) === 'generate' && MODELS.normalizeOperation({ previousImage: {} }) === 'edit'
    && MODELS.normalizeOperation({ operation: 'edit' }) === 'edit' && MODELS.normalizeOperation({ referenceImages: ['a'] }) === 'edit');

  /* ── ② 路由配置归一与持久化 ────────────────────────────────────────── */
  console.log('Route config');
  check('cfg.defaultEnabled', CFG.normalizeRoute({}).enabled === true && CFG.normalizeRoute({ enabled: false }).enabled === false && CFG.normalizeRoute({ enabled: 'no' }).enabled === true);
  check('cfg.normalizeModelId', CFG.normalizeRoute({ model: ' GPT-IMAGE-2.5-SUNBURST ' }).model === 'gpt-image-2.5-sunburst');
  check('cfg.normalizeRoutesBoth', Object.keys(CFG.normalizeRoutes({})).sort().join(',') === 'editing,generation');
  check('cfg.routeNameForOperation', CFG.routeNameForOperation('edit') === 'editing' && CFG.routeNameForOperation('generate') === 'generation' && CFG.routeNameForOperation(undefined) === 'generation');
  /* 与既有并发覆盖字段共存：保存 routes 不得丢掉 maxConcurrent 等 P12 字段 */
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, maxConcurrent: 3, queueLimit: 5, debug: true };
  await CFG.saveRoutes({ generation: { apiConfigId: 'a', model: 'gpt-image-2.5-flare' } });
  const saved = store.apiSettings[CFG.CFG_KEY];
  check('cfg.savePreservesConcurrency', saved.maxConcurrent === 3 && saved.queueLimit === 5 && saved.debug === true && saved.id === CFG.CFG_KEY, JSON.stringify(saved));
  check('cfg.saveWritesBothRoutes', !!saved.routes.generation && !!saved.routes.editing && saved.routes.generation.apiConfigId === 'a');
  const reloaded = await CFG.getRoutes();
  check('cfg.reloadRoundTrip', reloaded.generation.model === 'gpt-image-2.5-flare' && reloaded.editing.enabled === true);

  /* ── ③ 解析语义：inherit / bound / disabled / 配置问题 ─────────────── */
  console.log('Resolve');
  const character = openaiCfg('char1', { nickname: '小明' });
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY };
  let r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.inheritUsesCharacterCfg', r.ok === true && r.mode === 'inherit' && r.cfg.id === 'char1' && r.model === '' && r.modelSource === 'auto');
  r = await CFG.resolveRoute({ operation: 'edit', opts: {} });
  check('resolve.inheritWithoutContextFails', r.ok === false && r.code === 'IMAGE_NO_CONFIG');

  seedConfigs([openaiCfg('img1', { nickname: '图片专用' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'img1', model: 'gpt-image-2.5-sunburst' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.boundUsesBoundCfg', r.ok === true && r.mode === 'bound' && r.cfg.id === 'img1' && r.cfg.imageGen === true && r.cfg.imageGenModel === 'gpt-image-2.5-sunburst' && r.modelSource === 'route');
  check('resolve.boundLabelAndProvider', r.apiConfigLabel === '图片专用' && r.provider === 'openai');
  check('resolve.editingStillInherits', (await CFG.resolveRoute({ operation: 'edit', opts: { cfg: character } })).mode === 'inherit');

  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { enabled: false } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.disabled', r.ok === false && r.code === 'IMAGE_ROUTER_DISABLED');

  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'ghost' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.missingConfig', r.ok === false && r.code === 'IMAGE_ROUTER_CONFIG_MISSING');

  seedConfigs([openaiCfg('nokey', { apiKey: '', imageGenApiKey: '', endpoint: 'https://api.openai.com/v1/chat/completions', imageGenEndpoint: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'nokey' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.missingKey', r.ok === false && r.code === 'IMAGE_ROUTER_NO_KEY');

  /* 端点留空：provider 有官方默认端点 → 可用（与执行器回落一致）；无默认端点 → 才是配置错误 */
  seedConfigs([openaiCfg('noep', { endpoint: '', imageGenEndpoint: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'noep' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.emptyEndpointUsesProviderDefault', r.ok === true && r.endpoint === 'https://api.openai.com/v1/images/generations', JSON.stringify(r));
  seedConfigs([openaiCfg('noep2', { provider: 'custom', endpoint: '', imageGenEndpoint: '', imageGenProvider: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'noep2' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.missingEndpoint', r.ok === false && r.code === 'IMAGE_ROUTER_NO_ENDPOINT', JSON.stringify(r));
  /* 本地/内网端点允许不填 Key（local-first / Bridge 本地服务的常态，不得判死） */
  seedConfigs([openaiCfg('local', { endpoint: 'http://127.0.0.1:23115/v1/chat/completions', apiKey: '', imageGenApiKey: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'local' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.localKeylessAllowed', r.ok === true && r.warnings.includes('no_key_local'), JSON.stringify(r));
  seedConfigs([openaiCfg('lan', { endpoint: 'http://192.168.1.9:8000/v1/chat/completions', apiKey: '', imageGenApiKey: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'lan' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.privateLanKeylessAllowed', r.ok === true && r.warnings.includes('no_key_local'));

  seedConfigs([openaiCfg('anth', { provider: 'anthropic', imageGenProvider: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'anth' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('resolve.unsupportedProvider', r.ok === false && r.code === 'IMAGE_ROUTER_PROVIDER_UNSUPPORTED');
  r = await CFG.resolveRoute({ operation: 'edit', opts: { cfg: openaiCfg('anthChar', { provider: 'anthropic', imageGenProvider: '' }) } });
  check('resolve.unsupportedProviderEditInherit', r.ok === false && r.code === 'IMAGE_EDIT_UNSUPPORTED', JSON.stringify(r));

  /* ── ④ 模型能力校验 ────────────────────────────────────────────────── */
  console.log('Model capability');
  seedConfigs([openaiCfg('img2', { nickname: '图片专用' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ editing: { apiConfigId: 'img2', model: 'dall-e-3' } }) };
  r = await CFG.resolveRoute({ operation: 'edit', opts: { cfg: character } });
  check('model.editRejectsGenerationOnly', r.ok === false && r.code === 'IMAGE_MODEL_CAPABILITY', JSON.stringify(r));
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ editing: { apiConfigId: 'img2', model: 'gpt-image-2.5-sunburst' } }) };
  r = await CFG.resolveRoute({ operation: 'edit', opts: { cfg: character } });
  check('model.editAcceptsSunburst', r.ok === true && r.model === 'gpt-image-2.5-sunburst' && r.cfg.imageGenProvider === 'openai');
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'img2', model: 'totally-made-up' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('model.unknownRejected', r.ok === false && r.code === 'IMAGE_MODEL_UNKNOWN');
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'img2', model: 'gemini-2.5-flash-image' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('model.providerFollowsModel', r.ok === true && r.cfg.imageGenProvider === 'gemini' && r.provider === 'gemini');
  /* 绑定配置自带模型：不支持当前操作时同样如实失败（不偷偷换模型） */
  seedConfigs([openaiCfg('withModel', { imageGenModel: 'dall-e-3' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ editing: { apiConfigId: 'withModel' } }) };
  r = await CFG.resolveRoute({ operation: 'edit', opts: { cfg: character } });
  check('model.boundConfigModelChecked', r.ok === false && r.code === 'IMAGE_MODEL_CAPABILITY', JSON.stringify(r));

  /* ── ⑤ 备用通道 ────────────────────────────────────────────────────── */
  console.log('Fallback');
  seedConfigs([openaiCfg('main', { nickname: '主' }), openaiCfg('backup', { nickname: '备' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'main', fallback: { apiConfigId: 'backup', model: 'gpt-image-1' } } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('fallback.resolved', r.ok === true && r.fallback && r.fallback.cfg.id === 'backup' && r.fallback.model === 'gpt-image-1' && r.fallback.modelSource === 'route_fallback');
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'main', fallback: { apiConfigId: 'gone' } } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('fallback.missingDegrades', r.ok === true && r.fallback === null && r.warnings.includes('fallback_config_missing'));
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ editing: { apiConfigId: 'main', fallback: { apiConfigId: 'main', model: 'dall-e-3' } } }) };
  r = await CFG.resolveRoute({ operation: 'edit', opts: { cfg: character } });
  check('fallback.unsupportedModelDegrades', r.ok === true && r.fallback === null && r.warnings.includes('fallback_model_unsupported'));
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'main' } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('fallback.noneWhenUnset', r.ok === true && r.fallback === null);
  /* 备用通道同样适用"本地端点免 Key / 官方默认端点"规则 */
  seedConfigs([openaiCfg('main2'), openaiCfg('localFb', { endpoint: 'http://127.0.0.1:23115/v1/chat/completions', apiKey: '', imageGenApiKey: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'main2', fallback: { apiConfigId: 'localFb', model: 'gpt-image-1' } } }) };
  r = await CFG.resolveRoute({ operation: 'generate', opts: { cfg: character } });
  check('fallback.localKeylessAllowed', r.ok === true && r.fallback && r.fallback.cfg.id === 'localFb', JSON.stringify(r));

  /* ── ⑥ Core 接线：路由模型进入请求 cfg，配置错误 0 次请求 ───────────── */
  console.log('Core integration');
  const calls = [];
  const exec = (cfg, prompt, size, opts) => { calls.push({ cfg, prompt, size, opts }); return Promise.resolve({ ok: true, dataUrl: 'data:image/png;base64,AAAA', model: cfg.imageGenModel }); };
  const routeStub = (result) => ({ resolveRoute: () => Promise.resolve(result) });
  let router = CORE.createImageRouter({ executor: exec, resolveProvider: () => 'openai', ...routeStub({ ok: true, cfg: openaiCfg('img3', { imageGenModel: 'gpt-image-2.5-sunburst' }), model: 'gpt-image-2.5-sunburst', mode: 'bound', apiConfigId: 'img3', routeName: 'generation', warnings: [], fallback: null }) });
  let out = await router.routeImageRequest({ prompt: '一只猫', cfg: openaiCfg('char1'), source: 'chat' });
  check('core.routeModelReachesExecutor', out.ok === true && calls[0].cfg.imageGenModel === 'gpt-image-2.5-sunburst' && out.route.model === 'gpt-image-2.5-sunburst' && out.route.policy === 'route_model');
  check('core.routeModelBeatsFastOverride', out.route.model === 'gpt-image-2.5-sunburst', 'Fast 覆盖不得改显式模型');
  const rec = router.telemetry().pop();
  check('core.telemetryRouteFields', rec.apiConfigId === 'img3' && rec.routeName === 'generation' && rec.modelSource === 'route' && rec.policy === 'route_model' && rec.fallbackUsed === false, JSON.stringify(rec));
  check('core.telemetryNoSecrets', !JSON.stringify(rec).includes('sk-test') && !JSON.stringify(rec).includes('base64'));

  calls.length = 0;
  router = CORE.createImageRouter({ executor: exec, resolveProvider: () => 'openai', ...routeStub({ ok: false, code: 'IMAGE_ROUTER_NO_KEY', reason: '缺少 API Key' }) });
  out = await router.routeImageRequest({ prompt: '一只猫', cfg: openaiCfg('char1'), source: 'chat' });
  check('core.configErrorNoRequest', out.ok === false && out.code === 'IMAGE_ROUTER_NO_KEY' && calls.length === 0, JSON.stringify(out));
  check('core.configErrorText', CORE.imageRejectText(out).includes('Image Router'));

  calls.length = 0;
  router = CORE.createImageRouter({ executor: exec, resolveProvider: () => 'openai', ...routeStub({ ok: true, cfg: openaiCfg('img3', { imageGenModel: 'dall-e-3' }), model: 'dall-e-3', mode: 'bound', routeName: 'editing', warnings: [], fallback: null }) });
  out = await router.routeImageRequest({ prompt: '改头发', operation: 'edit', previousImage: { dataUrl: 'data:image/png;base64,AAAA', base64: 'AAAA', mime: 'image/png' }, cfg: openaiCfg('char1'), source: 'chat' });
  check('core.routeModelCapabilityGuard', out.ok === false && out.code === 'IMAGE_MODEL_CAPABILITY' && calls.length === 0, JSON.stringify(out));

  /* 备用通道：provider 类失败重试一次；配置类失败不重试 */
  let n = 0;
  const flakyExec = (cfg) => { n++; return Promise.resolve(n === 1 ? { ok: false, code: 'IMAGE_PROVIDER_ERROR', reason: 'boom' } : { ok: true, dataUrl: 'data:image/png;base64,AAAA', model: cfg.imageGenModel }); };
  calls.length = 0;
  router = CORE.createImageRouter({ executor: flakyExec, resolveProvider: () => 'openai', ...routeStub({ ok: true, cfg: openaiCfg('main', { imageGenModel: 'gpt-image-2.5-flare' }), model: 'gpt-image-2.5-flare', mode: 'bound', routeName: 'generation', warnings: [], fallback: { cfg: openaiCfg('backup', { imageGenModel: 'gpt-image-1' }), model: 'gpt-image-1' } }) });
  out = await router.routeImageRequest({ prompt: '一只猫', cfg: openaiCfg('char1'), source: 'chat' });
  check('fallback.retriesOnProviderError', out.ok === true && out.fallbackUsed === true && n === 2 && router.telemetry().pop().fallbackUsed === true);

  n = 0;
  const configErrExec = () => { n++; return Promise.resolve({ ok: false, code: 'IMAGE_EDIT_UNSUPPORTED', reason: 'no edit endpoint' }); };
  router = CORE.createImageRouter({ executor: configErrExec, resolveProvider: () => 'openai', ...routeStub({ ok: true, cfg: openaiCfg('main', { imageGenModel: 'gpt-image-2.5-flare' }), model: 'gpt-image-2.5-flare', mode: 'bound', routeName: 'generation', warnings: [], fallback: { cfg: openaiCfg('backup'), model: 'gpt-image-1' } }) });
  out = await router.routeImageRequest({ prompt: '一只猫', cfg: openaiCfg('char1'), source: 'chat' });
  check('fallback.noRetryOnConfigError', out.ok === false && n === 1 && CORE.imageFallbackEligible('IMAGE_EDIT_UNSUPPORTED') === false);

  /* ── ⑦ describe（Settings UI 只读描述） ────────────────────────────── */
  console.log('Describe');
  seedConfigs([openaiCfg('imgA', { nickname: '图片A' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'imgA', model: 'gpt-image-2.5-flare' }, editing: { model: 'dall-e-3' } }) };
  const d = await CFG.describe();
  check('describe.generationStatus', d.status.generation.ok === true && d.status.generation.mode === 'bound' && d.status.generation.apiConfigLabel === '图片A' && d.status.generation.provider === 'openai');
  check('describe.editingCapabilityProblem', d.status.editing.ok === false && d.status.editing.code === 'IMAGE_MODEL_CAPABILITY');
  check('describe.modelsFiltered', d.models.generation.some(m => m.id === 'dall-e-3') && !d.models.editing.some(m => m.id === 'dall-e-3') && d.models.editing.some(m => m.id === 'gpt-image-2.5-sunburst'));
  check('describe.listsApiConfigs', d.apiConfigs.length === 1 && d.apiConfigs[0].id === 'imgA');
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ editing: { apiConfigId: 'ghost' } }) };
  const d2 = await CFG.describe();
  check('describe.missingConfigCode', d2.status.editing.ok === false && d2.status.editing.code === 'IMAGE_ROUTER_CONFIG_MISSING');
  seedConfigs([openaiCfg('localUi', { nickname: '本地', endpoint: 'http://127.0.0.1:23115/v1/chat/completions', apiKey: '', imageGenApiKey: '' })]);
  store.apiSettings[CFG.CFG_KEY] = { id: CFG.CFG_KEY, routes: CFG.normalizeRoutes({ generation: { apiConfigId: 'localUi' } }) };
  const d3 = await CFG.describe();
  check('describe.localKeylessWarns', d3.status.generation.ok === true && d3.status.generation.warnings.includes('no_key_local'), JSON.stringify(d3.status.generation));

  /* ── ⑧ 错误文案：每个 code 都不同且指明去哪修 ─────────────────────── */
  console.log('Error text');
  const codes = ['IMAGE_ROUTER_DISABLED', 'IMAGE_ROUTER_UNBOUND', 'IMAGE_ROUTER_CONFIG_MISSING', 'IMAGE_ROUTER_NO_KEY',
    'IMAGE_ROUTER_NO_ENDPOINT', 'IMAGE_ROUTER_PROVIDER_UNSUPPORTED', 'IMAGE_MODEL_CAPABILITY', 'IMAGE_MODEL_UNKNOWN'];
  const texts = codes.map(c => CORE.imageRejectText({ code: c }));
  check('text.allDistinct', new Set(texts).size === codes.length, texts.join(' | '));
  check('text.noneIsGeneric', texts.every(t => t && t !== '生成失败' && t !== '图片服务暂时不可用，请稍后重试'), texts.join(' | '));
  check('text.pointsToSettings', texts.filter(t => t.includes('Image Router')).length >= 6, texts.join(' | '));
  check('text.configErrorTextHelper', CFG.errorText('IMAGE_ROUTER_NO_KEY') === CORE.imageRejectText({ code: 'IMAGE_ROUTER_NO_KEY' }));

  await flush();
  console.log('');
  if (failures) { console.error('FAILED: ' + failures); process.exit(1); }
  console.log('ALL PASS');
})();
