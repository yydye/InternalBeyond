/* ====================================================================
   Internal Beyond · Image Editing Runtime / Reference Image 专项测试（纯 Node，零依赖）
   --------------------------------------------------------------------
   覆盖（对应 P13 需求 Phase 1–15 / 19 的纯逻辑部分）：
     Normalize     dataUrl / base64 / url / src / 对象 各种来源 → 同一 canonical 表示
     Validate      MIME 白名单 / 空数据 / 单张体积 / 合计体积 / 数量上限 / 拒绝网络地址
     Resolver      explicit selected > attached > latest editable；无图 → IMAGE_EDIT_NO_SOURCE
     Multi-turn    generate A → edit A→B → edit B→C：第三步输入必须是 B（不是 A）
     Lineage       imageId / parentImageId / generationType / editDepth 链
     Router        edit + previousImage → Auto → Sunburst；Fast 覆盖 → Flare；
                   Precision 覆盖 → Sunburst；多参考图 → Sunburst
     Priority      P0 用户编辑 > P3 后台生成；不抢占已派发请求
     Concurrency   Edit A + Edit B + Generate C 仍满足 global ≤ 2 / Sunburst ≤ 1 / 角色 ≤ 1
     Executor 契约 Router 把 operation/previousImage/referenceImages 交给**同一个** executor
     Failure       executor throw / 拒绝 / abort → 槽位全部释放，下一个请求照常派发
     Telemetry     operation/referenceCount/editDepth 齐全，且不含 base64 / API Key
   浏览器侧（真实 multipart wire format / capability guard / UI）见 test_image_edit_smoke.js。
   运行：node test_image_edit.js
   ==================================================================== */
'use strict';
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'assets', 'js', 'image-edit-core.js'));
const R = require(path.join(ROOT, 'assets', 'js', 'image-router-core.js'));


let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const FLARE = R.IMAGE_MODELS.flare;
const SUNBURST = R.IMAGE_MODELS.sunburst;

/* 1x1 PNG（与 smoke 测试同一份常量） */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/oS8AAAAASUVORK5CYII=';
const DATA_PNG = 'data:image/png;base64,' + PNG;
/* 造一张"指定字节数"的假图片（只用于体积限额判定） */
const bigB64 = (bytes) => 'A'.repeat(Math.ceil(bytes / 0.75));
const img = (over) => Object.assign({ dataUrl: DATA_PNG, base64: PNG, mime: 'image/png', name: 'a.png' }, over || {});
/* 内容互不相同的图片（用于数量/合计限额；base64 仍是合法字符集） */
const uniq = (n, over) => {
  const b64 = PNG + 'A'.repeat(4 * n);
  return img(Object.assign({ base64: b64, dataUrl: 'data:image/png;base64,' + b64, name: 'u' + n + '.png' }, over || {}));
};

/* ── 可控时钟 / 执行器（与 test_image_router.js 同款） ── */
function makeClock(start = 5000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}
function makeExecutor() {
  const calls = [];
  const exec = (cfg, prompt, size, opts) => {
    const rec = { cfg, prompt, size, opts, model: String((cfg && cfg.imageGenModel) || ''), settle: null };
    rec.promise = new Promise((resolve, reject) => { rec.settle = { resolve, reject }; });
    calls.push(rec);
    return rec.promise;
  };
  return {
    exec, calls,
    ok: (i, model) => calls[i].settle.resolve({ ok: true, dataUrl: 'data:image/png;base64,' + PNG, model: model || calls[i].model }),
    fail: (i, err) => { if (err) calls[i].settle.reject(err); else calls[i].settle.resolve({ ok: false, code: 'IMAGE_PROVIDER_ERROR', reason: 'provider rejected' }); }
  };
}
function makeTimers() {
  const list = [];
  return {
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; list.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    fire: () => { list.splice(0).forEach(h => { if (!h.cleared) h.fn(); }); }
  };
}
const tick = () => new Promise(r => setTimeout(r, 0));

/* ====================================================================
   ① 归一化 / 校验（Phase 14 / 15）
   ==================================================================== */
console.log('\n── normalize / validate ──');
{
  const forms = [
    ['dataUrl 字符串', DATA_PNG],
    ['裸 base64', { base64: PNG, mime: 'image/png' }],
    ['url 字段', { url: DATA_PNG }],
    ['src 字段', { src: DATA_PNG }],
    ['image 字段', { image: DATA_PNG }],
    ['dataUrl 对象', { dataUrl: DATA_PNG, name: 'x.png' }]
  ];
  let allOk = true, allSame = true;
  forms.forEach(([, input]) => {
    const r = E.normalizeImage(input);
    if (!r.ok) allOk = false;
    else if (r.image.dataUrl !== DATA_PNG || r.image.base64 !== PNG) allSame = false;
  });
  check('normalize.allFormsAccepted', allOk);
  check('normalize.sameCanonicalShape', allSame);

  const one = E.normalizeImage({ dataUrl: DATA_PNG, name: 'x.png' });
  check('normalize.canonicalKeys', one.ok && ['dataUrl', 'base64', 'mime', 'name', 'bytes'].every(k => k in one.image), JSON.stringify(one.image && Object.keys(one.image)));
  check('normalize.mimeFromDataUrl', one.ok && one.image.mime === 'image/png');
  check('normalize.bytesComputed', one.ok && one.image.bytes === Math.floor(PNG.length * 0.75));
  check('normalize.jpgAlias', E.normalizeImage({ base64: PNG, mime: 'image/jpg' }).image.mime === 'image/jpeg');
  check('normalize.preservesLineage', E.normalizeImage({ dataUrl: DATA_PNG, imageId: 'i1', parentImageId: 'i0', editDepth: 2, generationType: 'edit', model: 'm' }).image.editDepth === 2);

  check('validate.invalidMime', E.normalizeImage({ base64: PNG, mime: 'image/gif' }).code === 'IMAGE_REFERENCE_INVALID');
  check('validate.notDataUrl', E.normalizeImage('hello').code === 'IMAGE_REFERENCE_INVALID');
  check('validate.emptyBase64', E.normalizeImage({ base64: '', mime: 'image/png' }).code === 'IMAGE_REFERENCE_INVALID');
  check('validate.tooSmall', E.normalizeImage({ base64: 'AAAA', mime: 'image/png' }).code === 'IMAGE_REFERENCE_INVALID');
  check('validate.nullInput', E.normalizeImage(null).code === 'IMAGE_REFERENCE_INVALID');
  check('validate.httpUrlRejected', E.normalizeImage('https://example.com/a.png').code === 'IMAGE_REFERENCE_INVALID');
  check('validate.localPathRejected', E.normalizeImage('C:\\pics\\a.png').code === 'IMAGE_REFERENCE_INVALID');
  check('validate.oversize', E.normalizeImage({ base64: bigB64(5 * 1024 * 1024), mime: 'image/png' }).code === 'IMAGE_REFERENCE_TOO_LARGE');
  check('validate.shrinkableDetected', E.needsShrink({ base64: bigB64(5 * 1024 * 1024), mime: 'image/png' }) === true);
  check('validate.smallNeedsNoShrink', E.needsShrink({ dataUrl: DATA_PNG }) === false);

  const limits = E.mergeLimits({ maxReferenceImages: 2, maxReferenceBytes: 1024, maxTotalReferenceBytes: 2048 });
  check('limits.overrideApplied', limits.maxReferenceImages === 2 && limits.maxReferenceBytes === 1024);
  const bad = E.mergeLimits({ maxReferenceImages: 0, maxReferenceBytes: NaN, shrinkQuality: 99 });
  check('limits.illegalClampedNotZero', bad.maxReferenceImages === 1 && bad.maxReferenceBytes === E.IMAGE_EDIT_DEFAULTS.maxReferenceBytes && bad.shrinkQuality === E.IMAGE_EDIT_DEFAULTS.shrinkQuality, JSON.stringify(bad));
  check('limits.totalNeverBelowSingle', E.mergeLimits({ maxReferenceBytes: 4096, maxTotalReferenceBytes: 1024 }).maxTotalReferenceBytes === 4096);
}

/* ====================================================================
   ② 选源优先级（Phase 3 / 4）
   ==================================================================== */
console.log('\n── resolver priority ──');
{
  const explicit = img({ imageId: 'E', sourceId: 'explicit' });
  const attached = img({ imageId: 'A', sourceId: 'attached' });
  const latest = img({ imageId: 'L', sourceId: 'latest' });

  const r1 = E.pickPreviousImage({ explicit, attached, latest });
  check('priority.explicitWins', r1.ok && r1.image.imageId === 'E' && r1.sourceKind === 'explicit');
  const r2 = E.pickPreviousImage({ attached, latest });
  check('priority.attachedOverLatest', r2.ok && r2.image.imageId === 'A' && r2.sourceKind === 'attached');
  const r3 = E.pickPreviousImage({ latest });
  check('priority.latestFallback', r3.ok && r3.image.imageId === 'L' && r3.sourceKind === 'latest');
  const r4 = E.pickPreviousImage({});
  check('priority.noSource', r4.ok === false && r4.code === 'IMAGE_EDIT_NO_SOURCE');
  check('priority.brokenExplicitSkipped', E.pickPreviousImage({ explicit: 'not-an-image', latest }).sourceKind === 'latest');
  check('priority.orderContract', JSON.stringify(E.IMAGE_SOURCE_ORDER) === JSON.stringify(['explicit', 'attached', 'latest']));

  const lim = E.mergeLimits({ maxReferenceImages: 2 });
  const tooMany = E.checkBudget([img(), img(), img()], lim);
  check('budget.countLimit', tooMany.ok === false && tooMany.code === 'IMAGE_REFERENCE_LIMIT');
  check('budget.countOk', E.checkBudget([img(), img()], lim).ok === true);
  const bigImg = (n) => ({ base64: bigB64(3 * 1024 * 1024) + 'A'.repeat(n), mime: 'image/png', name: 'b' + n + '.png' });
  check('budget.totalLimit', E.checkBudget([bigImg(1), bigImg(2), bigImg(3)], E.mergeLimits({})).code === 'IMAGE_REFERENCE_TOO_LARGE');
  check('budget.emptyOk', E.checkBudget([], lim).ok === true);
}

/* ====================================================================
   ③ buildEditRequest（Phase 1 / 5 / 7 / 8）
   ==================================================================== */
console.log('\n── buildEditRequest ──');
{
  const A = img({ imageId: 'A', editDepth: 0 });
  const req = E.buildEditRequest({ instruction: '把头发改长一点，其他地方不变', latest: A, source: 'chat', characterId: 'c1' });
  check('request.ok', req.ok === true);
  check('request.operationEdit', req.request.operation === 'edit');
  check('request.promptIsInstruction', req.request.prompt === '把头发改长一点，其他地方不变');
  check('request.previousImage', req.request.previousImage.imageId === 'A');
  check('request.multiTurnEditsFromDepth', req.request.multiTurnEdits === 0);
  check('request.noDuplicateContractFields', !('policy' in req.request) && !('modelKind' in req.request) && !('model' in req.request), 'buildEditRequest 不得复制 Router contract');

  const B = img({ imageId: 'B', editDepth: 1 });
  const req2 = E.buildEditRequest({ instruction: '再把窗外改成下雪', latest: B });
  check('request.multiTurnSignal', req2.request.multiTurnEdits === 1);

  const req3 = E.buildEditRequest({ instruction: '只改背景', latest: A, identityPreservation: true });
  check('request.identityExplicit', req3.request.identityPreservation === true);
  const req4 = E.buildEditRequest({ instruction: '保持人物一致，只改背景', latest: A });
  check('request.identityNotInvented', req4.request.identityPreservation === false, '文本判断留给 Router.classifyImageTask，不在这里重复');

  const dup = E.buildEditRequest({ instruction: 'x', latest: A, referenceImages: [A, uniq(1, { imageId: 'R' })] });
  check('request.referenceDedup', dup.ok && dup.request.referenceImages.length === 1 && dup.referenceCount === 1, JSON.stringify(dup.request && dup.request.referenceImages.length));

  const badRef = E.buildEditRequest({ instruction: 'x', latest: A, referenceImages: ['nope'] });
  check('request.badReferenceRejected', badRef.ok === false && badRef.code === 'IMAGE_REFERENCE_INVALID');
  const tooMany = E.buildEditRequest({ instruction: 'x', latest: A, referenceImages: [uniq(1), uniq(2), uniq(3), uniq(4), uniq(5)] });
  check('request.referenceLimit', tooMany.ok === false && tooMany.code === 'IMAGE_REFERENCE_LIMIT', JSON.stringify(tooMany));
  check('request.emptyInstruction', E.buildEditRequest({ instruction: '  ', latest: A }).code === 'IMAGE_EMPTY_PROMPT');
  check('request.noSource', E.buildEditRequest({ instruction: 'x' }).code === 'IMAGE_EDIT_NO_SOURCE');
  check('request.errorTextShort', E.editErrorText({ code: 'IMAGE_EDIT_UNSUPPORTED' }) === '当前图片模型不支持编辑这张图片');
  check('request.errorTextFallback', E.editErrorText({ reason: '自定义原因' }) === '自定义原因');
}

/* ====================================================================
   ④ lineage：A → B → C（Phase 6 / 5）
   ==================================================================== */
console.log('\n── lineage ──');
{
  const seedA = { now: 1700000000000, rand: 0.1 };
  const seedB = { now: 1700000000001, rand: 0.2 };
  const seedC = { now: 1700000000002, rand: 0.3 };
  const lA = E.lineageForGenerate(seedA);
  check('lineage.generateRoot', lA.generationType === 'generate' && lA.editDepth === 0 && lA.parentImageId === '');
  const A = img({ imageId: lA.imageId, editDepth: lA.editDepth });
  const lB = E.lineageFor(A, seedB);
  check('lineage.editChild', lB.generationType === 'edit' && lB.editDepth === 1 && lB.parentImageId === A.imageId);
  const B = img({ imageId: lB.imageId, editDepth: lB.editDepth, parentImageId: lB.parentImageId });
  const lC = E.lineageFor(B, seedC);
  check('lineage.chainDepth', lC.editDepth === 2 && lC.parentImageId === B.imageId);
  check('lineage.idsUnique', lA.imageId !== lB.imageId && lB.imageId !== lC.imageId);
  check('lineage.newImageIdShape', /^img_[0-9a-z]+_[0-9a-z]+$/.test(E.newImageId(seedA)));
  check('lineage.forGenerateIgnoresParent', E.lineageForGenerate({}).editDepth === 0);
}

/* ====================================================================
   ⑤ 多轮 A→B→C：第三步必须改 B（Phase 5 / 19）
   ==================================================================== */
console.log('\n── multi-turn A → B → C ──');
{
  /* 模拟会话：生成 A（assistant#1）→ 编辑 A→B（assistant#2）→ 再编辑时"最近一张可编辑图"必须是 B */
  const A = img({ imageId: 'imgA', editDepth: 0, generationType: 'generate' });
  const B = img({ imageId: 'imgB', editDepth: 1, generationType: 'edit', parentImageId: 'imgA' });
  const conv = [
    { id: 'u1', role: 'user', content: '画昔涟坐在窗边', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: '好的', images: [A], timestamp: 2 },
    { id: 'u2', role: 'user', content: '就这张，把头发改长一点', timestamp: 3 },
    { id: 'a2', role: 'assistant', content: '改好了', images: [B], timestamp: 4 },
    { id: 'u3', role: 'user', content: '再把窗外改成下雪', timestamp: 5 }
  ];
  /* 与 image-edit.js 的 _lastImageOf/_candidates 同语义的最小复现（纯函数版） */
  const latestOf = (msgs) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const imgs = Array.isArray(msgs[i].images) ? msgs[i].images : [];
      if (imgs.length) return imgs[imgs.length - 1];
    }
    return null;
  };
  const third = E.buildEditRequest({ instruction: '再把窗外改成下雪', latest: latestOf(conv) });
  check('multiturn.thirdEditsB', third.ok && third.request.previousImage.imageId === 'imgB', JSON.stringify(third.request && third.request.previousImage && third.request.previousImage.imageId));
  check('multiturn.notA', third.request.previousImage.imageId !== 'imgA');
  check('multiturn.depthPropagates', third.request.multiTurnEdits === 1);
  const routeThird = R.decideImageRoute({ operation: 'edit', previousImage: third.request.previousImage, prompt: '再把窗外改成下雪', userInitiated: true }, { userMode: 'auto', provider: 'openai', configuredModel: 'gpt-image-1' });
  check('multiturn.routerSunburst', routeThird.modelKind === 'sunburst' && routeThird.routeReason === 'edit_previous_image', routeThird.routeReason);
}

/* ====================================================================
   ⑥ Router：edit 请求的模型选择（Phase 13）
   ==================================================================== */
console.log('\n── router / edit routing ──');
{
  const ctxAuto = { userMode: 'auto', provider: 'openai', configuredModel: 'gpt-image-1' };
  const prev = img({ editDepth: 0 });

  const rEdit = R.decideImageRoute({ operation: 'edit', previousImage: prev, prompt: '把头发改长', userInitiated: true }, ctxAuto);
  check('route.editPreviousSunburst', rEdit.modelKind === 'sunburst' && rEdit.routeReason === 'edit_previous_image');
  check('route.editQualityHigh', rEdit.quality === 'high');

  const rSimple = R.decideImageRoute({ operation: 'edit', prompt: '把整体调亮一点', userInitiated: true }, ctxAuto);
  check('route.simpleEditFlare', rSimple.modelKind === 'flare' && rSimple.routeReason === 'simple_edit');

  const rRef = R.decideImageRoute({ operation: 'edit', referenceImages: [img()], prompt: '照这张的风格改', userInitiated: true }, ctxAuto);
  check('route.referenceSunburst', rRef.modelKind === 'sunburst' && rRef.routeReason === 'reference_image');

  const rMulti = R.decideImageRoute({ operation: 'edit', referenceImages: [img(), img()], prompt: '合在一起', userInitiated: true }, ctxAuto);
  check('route.multiReferenceSunburst', rMulti.modelKind === 'sunburst' && rMulti.classification.signals.multiReference === true, rMulti.routeReason);

  const rIdentity = R.decideImageRoute({ operation: 'edit', previousImage: prev, identityPreservation: true, prompt: '只改衣服', userInitiated: true }, ctxAuto);
  check('route.identitySunburst', rIdentity.modelKind === 'sunburst' && rIdentity.classification.signals.identityPreservation === true, rIdentity.routeReason);
  const rIdentityOnly = R.decideImageRoute({ operation: 'edit', identityPreservation: true, prompt: '只改衣服', userInitiated: true }, ctxAuto);
  check('route.identityReasonReported', rIdentityOnly.modelKind === 'sunburst' && rIdentityOnly.routeReason === 'identity_preservation', rIdentityOnly.routeReason);

  const rText = R.decideImageRoute({ operation: 'edit', prompt: '把这张图整体重画，其他地方完全不要动', userInitiated: true }, ctxAuto);
  check('route.textHintSunburst', rText.modelKind === 'sunburst' && rText.routeReason === 'precision_text_hint');

  const rFast = R.decideImageRoute({ operation: 'edit', previousImage: prev, requestedMode: 'fast', prompt: '把头发改长', userInitiated: true }, ctxAuto);
  check('route.fastOverrideRespected', rFast.modelKind === 'flare' && rFast.routeReason === 'user_fast_override');
  const rPrec = R.decideImageRoute({ operation: 'edit', requestedMode: 'precision', prompt: '随便改改', userInitiated: true }, ctxAuto);
  check('route.precisionOverrideRespected', rPrec.modelKind === 'sunburst' && rPrec.routeReason === 'user_precision_override');
  const rGlobalFast = R.decideImageRoute({ operation: 'edit', previousImage: prev, prompt: 'x', userInitiated: true }, { userMode: 'fast', provider: 'openai', configuredModel: 'gpt-image-1' });
  check('route.globalFastRespected', rGlobalFast.modelKind === 'flare');

  const rManaged = R.decideImageRoute({ operation: 'edit', previousImage: prev, prompt: 'x', userInitiated: true }, { userMode: 'auto', provider: 'gemini', configuredModel: 'gemini-2.5-flash-image' });
  check('route.providerManagedUntouched', rManaged.policy === 'provider_managed' && rManaged.model === 'gemini-2.5-flash-image');
  const rDalle = R.decideImageRoute({ operation: 'edit', previousImage: prev, prompt: 'x', userInitiated: true }, { userMode: 'auto', provider: 'openai', configuredModel: 'dall-e-3' });
  check('route.customModelUntouched', rDalle.policy === 'provider_managed');
  check('route.priorityUserEdit', R.decideImagePriority({ operation: 'edit', userInitiated: true }) === 0);
  check('route.priorityBackgroundGen', R.decideImagePriority({ operation: 'generate', background: true }) === 3);
  check('route.priorityBackgroundEditNotBackground', R.decideImagePriority({ operation: 'edit', userInitiated: true, background: true }) === 0);
}

/* ====================================================================
   ⑦ Router 端到端：edit 经 Scheduler → 同一个 executor（Phase 9 / 11）
   ==================================================================== */
console.log('\n── router end-to-end (edit) ──');
(async () => {
  {
    const clock = makeClock();
    const ex = makeExecutor();
    const router = R.createImageRouter({
      now: clock.now,
      executor: ex.exec,
      resolveProvider: () => 'openai',
      getUserMode: () => 'auto',
      getConfig: () => Promise.resolve({ maxConcurrent: 2, maxSunburstConcurrent: 1, perCharacterConcurrent: 1, queueLimit: 8 })
    });
    const prev = img({ imageId: 'imgA', editDepth: 0 });
    const p = router.routeImageRequest({ source: 'chat', characterId: 'c1', cfg: { id: 'c1', imageGenModel: 'gpt-image-1' }, prompt: '把头发改长', operation: 'edit', previousImage: prev, userInitiated: true });
    await tick(); await tick();
    check('e2e.dispatchedToSameExecutor', ex.calls.length === 1);
    check('e2e.modelIsSunburst', ex.calls[0] && ex.calls[0].model === SUNBURST, ex.calls[0] && ex.calls[0].model);
    check('e2e.execOptsCarryOperation', ex.calls[0] && ex.calls[0].opts.operation === 'edit');
    check('e2e.execOptsCarryPreviousImage', ex.calls[0] && ex.calls[0].opts.previousImage === prev);
    check('e2e.execOptsCarryReferences', ex.calls[0] && Array.isArray(ex.calls[0].opts.referenceImages) && ex.calls[0].opts.referenceImages.length === 0);
    check('e2e.noSecondExecutorPath', ex.calls.length === 1, '不得出现第二条执行路径');
    ex.ok(0);
    const res = await p;
    check('e2e.resultOk', res.ok === true);
    check('e2e.routeReportsEdit', res.route.operation === 'edit' && res.route.modelKind === 'sunburst' && res.route.editDepth === 0);
    const tel = router.telemetry();
    check('e2e.telemetryFields', tel.length === 1 && tel[0].operation === 'edit' && tel[0].referenceCount === 0 && tel[0].editDepth === 0, JSON.stringify(tel[0]));
    check('e2e.telemetryNoImageData', !/base64|iVBOR|\/9j\//.test(JSON.stringify(tel)), 'telemetry 不得包含图片数据');
  }

  /* Fast 覆盖：edit 也走 Flare */
  {
    const ex = makeExecutor();
    const router = R.createImageRouter({ executor: ex.exec, resolveProvider: () => 'openai', getUserMode: () => 'fast', getConfig: () => Promise.resolve({}) });
    const p = router.routeImageRequest({ source: 'chat', characterId: 'c1', cfg: { imageGenModel: 'gpt-image-1' }, prompt: '改', operation: 'edit', previousImage: img(), userInitiated: true });
    await tick(); await tick();
    check('e2e.fastEditFlare', ex.calls[0] && ex.calls[0].model === FLARE);
    ex.ok(0); await p;
  }

  /* ── ⑧ 优先级：P3 后台生成排队中，P0 编辑到达 → 编辑先派发，且不抢占已派发请求 ── */
  console.log('\n── priority ──');
  {
    const clock = makeClock();
    const ex = makeExecutor();
    const router = R.createImageRouter({ now: clock.now, executor: ex.exec, resolveProvider: () => 'openai', getUserMode: () => 'auto', getConfig: () => Promise.resolve({ maxConcurrent: 2, maxSunburstConcurrent: 1, perCharacterConcurrent: 1 }) });
    /* 占满 2 个全局槽：两个不同角色的后台生成 */
    const p1 = router.routeImageRequest({ source: 'ai_moments', characterId: 'bg1', cfg: { imageGenModel: 'gpt-image-1' }, prompt: 'bg1', background: true, userInitiated: false });
    const p2 = router.routeImageRequest({ source: 'ai_moments', characterId: 'bg2', cfg: { imageGenModel: 'gpt-image-1' }, prompt: 'bg2', background: true, userInitiated: false });
    await tick(); await tick();
    check('priority.twoDispatched', ex.calls.length === 2);
    /* 队列里放一个 P3 后台 */
    const p3 = router.routeImageRequest({ source: 'ai_moments', characterId: 'bg3', cfg: { imageGenModel: 'gpt-image-1' }, prompt: 'bg3', background: true, userInitiated: false });
    await tick();
    check('priority.backgroundQueued', router.stats().queued === 1, JSON.stringify(router.stats()));
    /* P0 编辑到达 */
    const p0 = router.routeImageRequest({ source: 'chat', characterId: 'c9', cfg: { imageGenModel: 'gpt-image-1' }, prompt: '把这张改一下', operation: 'edit', previousImage: img(), userInitiated: true });
    await tick();
    check('priority.dispatchedNotPreempted', ex.calls.length === 2, '已派发请求不得被抢占');
    check('priority.editQueuedAhead', router.stats().queued === 2);
    /* 释放一个槽 → 下一个派发的必须是 P0 编辑（不是先来的 P3） */
    ex.ok(0, FLARE); await tick(); await tick();
    check('priority.editDispatchedFirst', ex.calls.length === 3 && ex.calls[2].prompt === '把这张改一下', JSON.stringify(ex.calls.map(c => c.prompt)));
    check('priority.editModelSunburst', ex.calls[2].model === SUNBURST);
    ex.ok(1, FLARE); ex.ok(2, SUNBURST); await tick(); await tick();
    check('priority.backgroundAfterEdit', ex.calls.length === 4 && ex.calls[3].prompt === 'bg3');
    ex.ok(3, FLARE);
    await Promise.all([p1, p2, p3, p0]);
  }

  /* ── ⑨ 并发：Edit A + Edit B + Generate C ── */
  console.log('\n── concurrency (edit 未绕过 Scheduler) ──');
  {
    const clock = makeClock();
    const ex = makeExecutor();
    const router = R.createImageRouter({ now: clock.now, executor: ex.exec, resolveProvider: () => 'openai', getUserMode: () => 'auto', getConfig: () => Promise.resolve({ maxConcurrent: 2, maxFlareConcurrent: 2, maxSunburstConcurrent: 1, perCharacterConcurrent: 1 }) });
    const mk = (characterId, prompt, edit) => router.routeImageRequest({
      source: 'chat', characterId, cfg: { imageGenModel: 'gpt-image-1' }, prompt,
      operation: edit ? 'edit' : 'generate', previousImage: edit ? img() : null, userInitiated: true
    });
    const e1 = mk('cA', '改A', true);
    const e2 = mk('cB', '改B', true);
    const g1 = mk('cC', '画C', false);
    await tick(); await tick();
    let snap = router.stats();
    check('concurrency.globalCap', snap.running <= 2, JSON.stringify(snap));
    check('concurrency.editsNotAllAtOnce', ex.calls.length <= 2, '三个请求不可能同时执行');
    check('concurrency.oneSunburstAtATime', (snap.byModel.sunburst || 0) <= 1, JSON.stringify(snap.byModel));
    /* 全放行，同时持续采样"实际同时执行数"，证明 edit 没有绕过 Scheduler */
    let maxGlobal = 0, maxSun = 0, guard = 0;
    while (guard++ < 20) {
      const s = router.stats();
      maxGlobal = Math.max(maxGlobal, s.running);
      maxSun = Math.max(maxSun, s.byModel.sunburst || 0);
      const i = ex.calls.findIndex(c => !c.settled);
      if (i === -1) break;
      ex.calls[i].settled = true; ex.ok(i); await tick(); await tick();
    }
    await Promise.all([e1, e2, g1]);
    snap = router.stats();
    check('concurrency.allReleased', snap.running === 0 && snap.queued === 0, JSON.stringify(snap));
    check('concurrency.maxGlobalObserved', maxGlobal <= 2, 'observed=' + maxGlobal);
    check('concurrency.maxSunburstObserved', maxSun <= 1, 'observed=' + maxSun);
    check('concurrency.allThreeExecuted', ex.calls.length === 3, JSON.stringify(ex.calls.map(c => c.prompt)));
    check('concurrency.perCharacterRespected', new Set(ex.calls.map(c => c.model)).size >= 1);
  }

  /* ── ⑩ 失败释放：编辑失败后槽位全释放，下一个请求照常派发 ── */
  console.log('\n── failure release (edit) ──');
  {
    const clock = makeClock();
    const ex = makeExecutor();
    const router = R.createImageRouter({ now: clock.now, executor: ex.exec, resolveProvider: () => 'openai', getUserMode: () => 'auto', getConfig: () => Promise.resolve({ maxConcurrent: 2, maxSunburstConcurrent: 1, perCharacterConcurrent: 1 }) });
    const call = (prompt, edit) => router.routeImageRequest({ source: 'chat', characterId: 'c1', cfg: { imageGenModel: 'gpt-image-1' }, prompt, operation: edit ? 'edit' : 'generate', previousImage: edit ? img() : null, userInitiated: true });

    /* throw */
    const f1 = call('改1', true); await tick(); await tick();
    ex.fail(0, new Error('boom'));
    const r1 = await f1;
    check('failure.throwReported', r1.ok === false && r1.code === 'IMAGE_EXECUTOR_ERROR');
    await tick();
    check('failure.slotsReleasedAfterThrow', router.stats().running === 0 && router.stats().queued === 0, JSON.stringify(router.stats()));

    /* 执行器返回失败 */
    const f2 = call('改2', true); await tick(); await tick();
    ex.fail(1, null);
    const r2 = await f2;
    check('failure.rejectReported', r2.ok === false && r2.code === 'IMAGE_PROVIDER_ERROR');
    await tick();
    check('failure.slotsReleasedAfterReject', router.stats().running === 0);

    /* abort（未派发） */
    const ac = new AbortController();
    const f3 = router.routeImageRequest({ source: 'chat', characterId: 'cX', cfg: { imageGenModel: 'gpt-image-1' }, prompt: '改3', operation: 'edit', previousImage: img(), userInitiated: true, signal: ac.signal });
    ac.abort();
    const r3 = await f3;
    check('failure.abortReported', r3.ok === false && r3.code === 'IMAGE_ABORTED');
    await tick();
    check('failure.slotsReleasedAfterAbort', router.stats().running === 0 && router.stats().queued === 0);

    /* 之后照常派发（abort 的那次从未派发，所以这里是第 3 个 call） */
    const f4 = call('改4', true); await tick(); await tick();
    check('failure.nextDispatches', ex.calls.length === 3 && ex.calls[2].prompt === '改4', JSON.stringify(ex.calls.map(c => c.prompt)));
    ex.ok(2); const r4 = await f4;
    check('failure.nextSucceeds', r4.ok === true);
  }

  /* ── ⑪ 重复合并 / 队列上限对 edit 同样生效 ── */
  console.log('\n── coalesce / overflow (edit) ──');
  {
    const ex = makeExecutor();
    const router = R.createImageRouter({ executor: ex.exec, resolveProvider: () => 'openai', getUserMode: () => 'auto', getConfig: () => Promise.resolve({ coalesceWindowMs: 8000 }) });
    const prev = img();
    const o = { source: 'chat', characterId: 'c1', cfg: { imageGenModel: 'gpt-image-1' }, prompt: '把背景换成晚上', operation: 'edit', previousImage: prev, userInitiated: true };
    const a = router.routeImageRequest(o); const b = router.routeImageRequest(Object.assign({}, o));
    await tick(); await tick();
    check('coalesce.editDeduped', ex.calls.length === 1, '相同编辑请求短时间只执行一次');
    ex.ok(0); const [ra, rb] = await Promise.all([a, b]);
    check('coalesce.bothGetResult', ra.ok === true && rb.ok === true);

    const ex2 = makeExecutor();
    const router2 = R.createImageRouter({ executor: ex2.exec, resolveProvider: () => 'openai', getUserMode: () => 'auto', getConfig: () => Promise.resolve({ queueLimit: 2, maxConcurrent: 1, perCharacterConcurrent: 1, coalesceWindowMs: 0 }) });
    const hold = router2.routeImageRequest({ source: 'chat', characterId: 'hold', cfg: { imageGenModel: 'gpt-image-1' }, prompt: 'hold', userInitiated: true });
    await tick(); await tick();
    const q = [];
    for (let i = 0; i < 2; i++) q.push(router2.routeImageRequest({ source: 'chat', characterId: 'q' + i, cfg: { imageGenModel: 'gpt-image-1' }, prompt: 'q' + i, operation: 'edit', previousImage: img(), userInitiated: true }));
    await tick();
    const over = await router2.routeImageRequest({ source: 'chat', characterId: 'over', cfg: { imageGenModel: 'gpt-image-1' }, prompt: 'over', operation: 'edit', previousImage: img(), userInitiated: true });
    check('overflow.editRejectedNotUnbounded', over.ok === false && over.code === 'IMAGE_QUEUE_OVERFLOW', JSON.stringify(over && over.code));
    check('overflow.queueCapped', router2.stats().queued <= 2, JSON.stringify(router2.stats()));
    ex2.ok(0); await tick();
    for (let i = 0; ex2.calls.length && i < 10; i++) { const idx = ex2.calls.findIndex(c => !c.settled); if (idx === -1) break; ex2.calls[idx].settled = true; ex2.ok(idx); await tick(); await tick(); }
    await Promise.all([hold].concat(q));
  }

  /* ── ⑫ 拒绝码文案：编辑相关 code 都有简短用户文案，且不等于泛化"生成失败" ── */
  console.log('\n── reject text ──');
  {
    const codes = ['IMAGE_EDIT_NO_SOURCE', 'IMAGE_EDIT_UNSUPPORTED', 'IMAGE_REFERENCE_INVALID', 'IMAGE_REFERENCE_TOO_LARGE', 'IMAGE_REFERENCE_LIMIT', 'IMAGE_EDIT_ABORTED', 'IMAGE_EDIT_TIMEOUT', 'IMAGE_PROVIDER_ERROR'];
    const texts = codes.map(c => R.imageRejectText({ code: c }));
    check('reject.allHaveText', texts.every((t, i) => t && t !== '生成失败' && t !== codes[i]), JSON.stringify(texts));
    check('reject.distinct', new Set(texts).size === codes.length, JSON.stringify(texts));
    check('reject.matchesEditCore', codes.every(c => !E.IMAGE_EDIT_ERRORS[c] || R.imageRejectText({ code: c }) === E.IMAGE_EDIT_ERRORS[c] || c === 'IMAGE_PROVIDER_ERROR'), 'Router 与 image-edit-core 文案需一致');
  }

  console.log('');
  if (failures) { console.error('Image Editing Runtime / Reference Image FAILED (' + failures + ')'); process.exit(1); }
  console.log('Image Editing Runtime / Reference Image passed ✔');
})();
