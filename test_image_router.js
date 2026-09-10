/* ====================================================================
   Internal Beyond · Image Router / Image Scheduler 专项测试（纯 Node，零依赖）
   --------------------------------------------------------------------
   覆盖（对应 P12 需求 Phase 1–9 / 13）：
     Routing       普通生成→Flare；precision edit→Sunburst；reference→Sunburst；
                   Fast 覆盖→Flare；Precision 覆盖→Sunburst；provider_managed 不改用户模型
     Auto upgrade  先 Flare 生成 → 对同一张图 precision 续修 → Sunburst
     Concurrency   Flare A/B/C 任意时刻 executing ≤ 2；Sunburst A/B ≤ 1；
                   global ≤ 2；同角色 ≤ 1 且不阻塞其它角色
     Priority      P0 用户编辑 > 未执行的 P3 后台；不抢占已派发请求；aging 防饥饿且后台永不超过 P0
     Failure       throw / 执行器拒绝 / abort → global+model+character 槽位全部释放
     Overflow      第 9 个任务进满队列：不无限增长；用户请求顶掉最低优先级后台
     Coalescing    相同 character+source+prompt+operation+reference 短时间只执行一次
     Background    同角色后台冷却；后台 Sunburst 长排队 → Auto 降级 Flare；显式 Precision 不降级
     Telemetry     字段齐全且不含 API Key / base64 / 请求体
   运行：node test_image_router.js
   ==================================================================== */
'use strict';
const R = require('./assets/js/image-router-core.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const tick = () => new Promise(r => setTimeout(r, 0));
const FLARE = R.IMAGE_MODELS.flare;
const SUNBURST = R.IMAGE_MODELS.sunburst;

/* ── 可控时钟 ─────────────────────────────────────────────────────── */
function makeClock(start = 1000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; return t; } };
}
/* ── 可控执行器：每个请求返回一个手动 resolve 的 promise ────────────── */
function makeExecutor() {
  const calls = [];
  const exec = (cfg, prompt, size, opts) => {
    const rec = { cfg, prompt, size, opts, model: String(cfg && cfg.imageGenModel || ''), settle: null, aborted: false };
    rec.promise = new Promise((resolve, reject) => { rec.settle = { resolve, reject }; });
    calls.push(rec);
    if (opts && opts.signal) {
      opts.signal.addEventListener('abort', () => { rec.aborted = true; });
    }
    return rec.promise;
  };
  return { exec, calls, ok: (i, model) => { calls[i].settle.resolve({ ok: true, dataUrl: 'data:image/png;base64,AAAA', model: model || calls[i].model }); }, fail: (i, err) => { if (err) calls[i].settle.reject(err); else calls[i].settle.resolve({ ok: false, code: 'IMAGE_PROVIDER_ERROR', reason: 'provider rejected' }); } };
}

/* ── 假定时器（降级唤醒是时间路径，必须确定性验证，且不得留下悬空 timer） ── */
function makeFakeTimers() {
  const list = [];
  return {
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false, fired: false }; list.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    fire: () => { list.splice(0).forEach(h => { if (!h.cleared) { h.fired = true; h.fn(); } }); },
    pending: () => list.filter(h => !h.cleared && !h.fired).length
  };
}

const BASE_CFG = { id: 'char_x', provider: 'openai', imageGen: true, imageGenModel: 'gpt-image-1', apiKey: 'sk-secret-must-not-leak' };
const deps = (executor, extra) => Object.assign({
  executor: executor.exec,
  resolveProvider: (cfg) => String((cfg && cfg.imageGenProvider) || (cfg && cfg.provider) || ''),
  getUserMode: () => 'auto',
  getConfig: () => null,
  now: () => 1000000,
  log: () => {}
}, extra || {});

(async () => {
  /* 看门狗：任何未释放的 promise/定时器都会让事件循环空转 → 30s 后显式失败，
     绝不允许"进程自然退出码 0"掩盖挂起的用例（与仓库测试纪律一致）。 */
  const watchdog = setTimeout(() => {
    console.error('  FAIL  harness.timeout — 用例未在 30s 内完成（存在未释放的 promise/timer）');
    process.exit(1);
  }, 30000);
  console.log('Image Router / Scheduler 专项测试');

  /* ══ 1 · Routing（模型选择） ═══════════════════════════════════════ */
  {
    const d = (opts, ctx) => R.decideImageRoute(opts, Object.assign({ userMode: 'auto', provider: 'openai', configuredModel: 'gpt-image-1' }, ctx || {}));
    check('route.generateFlare', d({ prompt: '一只坐在窗边的猫' }).modelKind === 'flare' && d({ prompt: '一只坐在窗边的猫' }).routeReason === 'standard_generation');
    check('route.simpleEditFlare', d({ prompt: '把窗外的天空换成黄昏', operation: 'edit' }).modelKind === 'flare'
      && d({ prompt: '把窗外的天空换成黄昏', operation: 'edit' }).routeReason === 'simple_edit');
    check('route.precisionEditSunburst', d({ prompt: '把窗外的天空换成黄昏，其他地方不要动', operation: 'edit' }).modelKind === 'sunburst'
      && d({ prompt: '把窗外的天空换成黄昏，其他地方不要动', operation: 'edit' }).routeReason === 'precision_text_hint');
    check('route.referencePreservationSunburst', d({ prompt: '换成海边背景', operation: 'edit', referenceImages: ['data:image/png;base64,AAAA'] }).modelKind === 'sunburst'
      && d({ prompt: '换成海边背景', operation: 'edit', referenceImages: ['data:image/png;base64,AAAA'] }).classification.strictReference === true);
    check('route.identityPreservationSunburst', d({ prompt: '换个姿势', operation: 'edit', identityPreservation: true }).modelKind === 'sunburst');
    check('route.multiReferenceSunburst', d({ prompt: '合成这两张', operation: 'edit', referenceImages: ['a', 'b'] }).modelKind === 'sunburst');
    check('route.fastOverrideFlare', d({ prompt: '精修这张图，其他地方完全不要动', operation: 'edit' }, { userMode: 'fast' }).modelKind === 'flare');
    check('route.precisionOverrideSunburst', d({ prompt: '随便画一只猫' }, { userMode: 'precision' }).modelKind === 'sunburst');
    check('route.requestModeBeatsGlobal', d({ prompt: '随便画', requestedMode: 'fast' }, { userMode: 'precision' }).modelKind === 'flare'
      && d({ prompt: '随便画', requestedMode: 'precision' }, { userMode: 'fast' }).modelKind === 'sunburst');
    check('route.providerManagedKeepsUserModel', d({ prompt: '一只猫' }, { configuredModel: 'dall-e-3' }).policy === 'provider_managed'
      && d({ prompt: '一只猫' }, { configuredModel: 'dall-e-3' }).model === 'dall-e-3');
    check('route.geminiProviderManaged', d({ prompt: '一只猫' }, { provider: 'gemini', configuredModel: 'gemini-2.5-flash-image' }).policy === 'provider_managed');
    check('route.unknownProviderNoOverride', R.decideImageRoute({ prompt: '一只猫' }, { userMode: 'auto', provider: null, configuredModel: 'gpt-image-1' }).policy === 'provider_managed');
    check('route.modelNamesCentralized', R.IMAGE_MODELS.flare === 'gpt-image-2.5-flare' && R.IMAGE_MODELS.sunburst === 'gpt-image-2.5-sunburst');
    check('route.qualityPrecisionHigh', d({ prompt: '精修', operation: 'edit' }).quality === 'high' && d({ prompt: '一只猫' }).quality === 'auto');
    check('route.explicitQualityWins', d({ prompt: '一只猫', requestedQuality: 'low' }).quality === 'low');
  }

  /* ══ 2 · Priority 决策 ════════════════════════════════════════════ */
  {
    check('priority.userEditP0', R.decideImagePriority({ userInitiated: true, operation: 'edit' }) === R.IMAGE_PRIORITY.USER_EDIT);
    check('priority.userGenerateP1', R.decideImagePriority({ userInitiated: true }) === R.IMAGE_PRIORITY.USER_GENERATE);
    check('priority.foregroundP2', R.decideImagePriority({ userInitiated: false, background: false }) === R.IMAGE_PRIORITY.FOREGROUND);
    check('priority.backgroundP3', R.decideImagePriority({ background: true }) === R.IMAGE_PRIORITY.BACKGROUND);
  }

  /* ══ 3 · Concurrency（global / model / character） ══════════════════ */
  {
    const clock = makeClock();
    const sched = R.createImageScheduler({ now: clock.now });
    let live = 0, maxLive = 0, maxFlare = 0, maxSun = 0, liveFlare = 0, liveSun = 0;
    const seen = [];
    const mk = (name, kind, characterId) => ({
      modelKind: kind, characterId, priority: R.IMAGE_PRIORITY.USER_GENERATE,
      run: () => { live++; liveFlare += kind === 'flare' ? 1 : 0; liveSun += kind === 'sunburst' ? 1 : 0;
        maxLive = Math.max(maxLive, live); maxFlare = Math.max(maxFlare, liveFlare); maxSun = Math.max(maxSun, liveSun);
        seen.push(name);
        return new Promise(res => { setTimeout(() => { live--; liveFlare -= kind === 'flare' ? 1 : 0; liveSun -= kind === 'sunburst' ? 1 : 0; res({ ok: true }); }, 5); }); }
    });
    const all = [sched.enqueue(mk('F1', 'flare', 'a')), sched.enqueue(mk('F2', 'flare', 'b')), sched.enqueue(mk('F3', 'flare', 'c'))];
    await Promise.all(all);
    check('concurrency.flareMax2', maxLive <= 2 && maxFlare <= 2, 'maxLive=' + maxLive + ' maxFlare=' + maxFlare);
    check('concurrency.flareAllRan', seen.length === 3);
    const seen2 = []; let sunLive = 0, sunMax = 0;
    const mkSun = (name) => ({ modelKind: 'sunburst', characterId: name, priority: 1,
      run: () => { sunLive++; sunMax = Math.max(sunMax, sunLive); seen2.push(name);
        return new Promise(res => setTimeout(() => { sunLive--; res({ ok: true }); }, 5)); } });
    await Promise.all([sched.enqueue(mkSun('S1')), sched.enqueue(mkSun('S2'))]);
    check('concurrency.sunburstMax1', sunMax === 1, 'sunMax=' + sunMax);
    check('concurrency.sunburstAllRan', seen2.length === 2);
  }
  {
    /* 同角色互斥，但不阻塞其它角色：昔涟 A 执行中，昔涟 B 排队，初音未来 C 可并行 */
    const order = [];
    const gates = {};
    const gate = (k) => new Promise(res => { gates[k] = res; });
    const sched = R.createImageScheduler({ now: () => 1 });
    const mk = (k, characterId) => ({ modelKind: 'flare', characterId, priority: 1,
      run: () => { order.push('start:' + k); return gate(k).then(() => { order.push('end:' + k); return { ok: true }; }); } });
    const pA = sched.enqueue(mk('xilianA', '昔涟'));
    const pB = sched.enqueue(mk('xilianB', '昔涟'));
    const pC = sched.enqueue(mk('mikuC', '初音未来'));
    await tick();
    check('character.sameCharacterSerialized', order.indexOf('start:xilianA') >= 0 && order.indexOf('start:xilianB') < 0, order.join(','));
    check('character.otherCharacterNotBlocked', order.indexOf('start:mikuC') >= 0, order.join(','));
    check('character.snapshot', sched.snapshot().running === 2 && sched.snapshot().queued === 1, JSON.stringify(sched.snapshot()));
    gates.xilianA({ ok: true }); gates.mikuC({ ok: true });
    await tick();
    check('character.secondStartsAfterFirst', order.indexOf('start:xilianB') >= 0, order.join(','));
    gates.xilianB({ ok: true });
    await Promise.all([pA, pB, pC]);
  }
  {
    /* global=2 且 Sunburst=1：两个 Flare + 一个 Sunburst 同时排队时，Sunburst 不能与两个 Flare 一起跑 */
    let live = 0, maxLive = 0;
    const sched = R.createImageScheduler({ now: () => 1 });
    const mk = (kind, id) => ({ modelKind: kind, characterId: id, priority: 1,
      run: () => { live++; maxLive = Math.max(maxLive, live); return new Promise(res => setTimeout(() => { live--; res({ ok: true }); }, 5)); } });
    await Promise.all([sched.enqueue(mk('flare', 'a')), sched.enqueue(mk('flare', 'b')), sched.enqueue(mk('sunburst', 'c'))]);
    check('concurrency.globalNeverExceeds2', maxLive <= 2, 'maxLive=' + maxLive);
  }

  /* ══ 4 · Priority + 防饥饿 ════════════════════════════════════════ */
  {
    const order = [];
    const gates = {};
    const sched = R.createImageScheduler({ now: () => 1, maxConcurrent: 1, agingStepMs: 8000, agingMaxBoost: 2 });
    const mk = (name, priority, background) => ({ modelKind: 'flare', characterId: name, priority, background,
      run: () => { order.push(name); return new Promise(res => { gates[name] = res; }); } });
    const pBg = sched.enqueue(mk('bg1', R.IMAGE_PRIORITY.BACKGROUND, false));
    await tick();
    const pBg2 = sched.enqueue(mk('bg2', R.IMAGE_PRIORITY.BACKGROUND, false));
    const pUser = sched.enqueue(mk('userEdit', R.IMAGE_PRIORITY.USER_EDIT, false));
    check('priority.backgroundFirstRuns', order.join(',') === 'bg1', order.join(','));
    gates.bg1({ ok: true });
    await tick();
    check('priority.p0BeatsQueuedP3', order.join(',') === 'bg1,userEdit', order.join(','));
    gates.userEdit({ ok: true });
    await tick();
    gates.bg2({ ok: true });
    await Promise.all([pBg, pBg2, pUser]);
  }
  {
    /* aging：P3 等满 agingStepMs*agingMaxBoost 后有效优先级提升（最多到 P1），
       连续用户 P1 请求下后台仍能执行；但永远不超过 P0 */
    const clock = makeClock();
    const order = [];
    const gates = {};
    const sched = R.createImageScheduler({ now: clock.now, maxConcurrent: 1, agingStepMs: 8000, agingMaxBoost: 2 });
    const mk = (name, priority, background) => ({ modelKind: 'flare', characterId: name, priority, background,
      run: () => { order.push(name); return new Promise(res => { gates[name] = res; }); } });
    const pRunning = sched.enqueue(mk('busy', R.IMAGE_PRIORITY.USER_GENERATE, false));
    await tick();
    const pOld = sched.enqueue(mk('oldBackground', R.IMAGE_PRIORITY.BACKGROUND, true));
    clock.advance(20000);   /* 后台等待 20s → 有效优先级 3-2=1 */
    const pFresh = sched.enqueue(mk('freshUser', R.IMAGE_PRIORITY.USER_GENERATE, false));
    gates.busy({ ok: true });
    await tick();
    check('priority.agingPreventsStarvation', order.join(',') === 'busy,oldBackground', order.join(','));
    gates.oldBackground({ ok: true });
    await tick();
    check('priority.freshUserRunsAfterAgedBackground', order.indexOf('freshUser') >= 0, order.join(','));
    gates.freshUser({ ok: true });
    await Promise.all([pRunning, pOld, pFresh]);
    /* 后台即使等很久也不会抢占用户主动编辑 */
    const order2 = [];
    const gates2 = {};
    const sched2 = R.createImageScheduler({ now: clock.now, maxConcurrent: 1, agingStepMs: 8000, agingMaxBoost: 2 });
    const mk2 = (name, priority, background) => ({ modelKind: 'flare', characterId: name, priority, background,
      run: () => { order2.push(name); return new Promise(res => { gates2[name] = res; }); } });
    const pR2 = sched2.enqueue(mk2('busy', 1, false));
    await tick();
    const pOldBg = sched2.enqueue(mk2('ancientBackground', R.IMAGE_PRIORITY.BACKGROUND, true));
    clock.advance(120000);
    const pP0 = sched2.enqueue(mk2('userEdit', R.IMAGE_PRIORITY.USER_EDIT, false));
    gates2.busy({ ok: true });
    await tick();
    check('priority.backgroundNeverBeatsP0', order2.join(',') === 'busy,userEdit', order2.join(','));
    gates2.userEdit({ ok: true });
    await tick();
    check('priority.agedBackgroundRunsLast', order2.join(',') === 'busy,userEdit,ancientBackground', order2.join(','));
    gates2.ancientBackground({ ok: true });
    await Promise.all([pR2, pOldBg, pP0]);
    /* 已派发到 provider 的请求不被抢占 */
    const order3 = [];
    const gates3 = {};
    const sched3 = R.createImageScheduler({ now: clock.now, maxConcurrent: 1 });
    const pRun3 = sched3.enqueue({ modelKind: 'flare', characterId: 'a', priority: R.IMAGE_PRIORITY.BACKGROUND, background: true,
      run: () => { order3.push('running'); return new Promise(res => { gates3.r = res; }); } });
    await tick();
    sched3.enqueue({ modelKind: 'flare', characterId: 'b', priority: R.IMAGE_PRIORITY.USER_EDIT, run: () => { order3.push('p0'); return Promise.resolve({ ok: true }); } });
    await tick();
    check('priority.noPreemptionOfDispatched', order3.join(',') === 'running', order3.join(','));
    gates3.r({ ok: true });
    await pRun3;
  }

  /* ══ 5 · Failure safety（槽位释放） ════════════════════════════════ */
  {
    const sched = R.createImageScheduler({ now: () => 1 });
    const results = [];
    const p1 = sched.enqueue({ modelKind: 'sunburst', characterId: 'x', priority: 1, run: () => { throw new Error('boom'); } });
    const p2 = sched.enqueue({ modelKind: 'sunburst', characterId: 'y', priority: 1, run: () => Promise.reject(new Error('provider down')) });
    const p3 = sched.enqueue({ modelKind: 'flare', characterId: 'z', priority: 1, run: () => Promise.resolve({ ok: false, code: 'IMAGE_PROVIDER_ERROR' }) });
    const p4 = sched.enqueue({ modelKind: 'flare', characterId: 'w', priority: 1, run: () => Promise.resolve({ ok: true }) });
    results.push(await p1, await p2, await p3, await p4);
    check('failure.syncThrowReleases', results[0].ok === false && results[0].code === 'IMAGE_EXECUTOR_ERROR');
    check('failure.providerRejectReleases', results[1].ok === false && results[1].code === 'IMAGE_EXECUTOR_ERROR');
    check('failure.providerErrorResultPassesThrough', results[2].ok === false && results[2].code === 'IMAGE_PROVIDER_ERROR');
    check('failure.nextRequestStillRuns', results[3].ok === true);
    check('failure.allSlotsReleased', sched.snapshot().running === 0 && sched.snapshot().queued === 0, JSON.stringify(sched.snapshot()));
    /* Sunburst 抛错 → sunburst + global 槽位释放 → 下一个排队请求开跑 */
    const order = [];
    let first = true;
    const gate = {};
    const s = R.createImageScheduler({ now: () => 1, maxSunburstConcurrent: 1 });
    const pa = s.enqueue({ modelKind: 'sunburst', characterId: 'a', priority: 1, run: () => new Promise((_, rej) => { gate.rej = rej; }) });
    const pb = s.enqueue({ modelKind: 'sunburst', characterId: 'b', priority: 1, run: () => { order.push('second'); return Promise.resolve({ ok: true }); } });
    await tick();
    gate.rej(new Error('sunburst blew up'));
    const ra = await pa; const rb = await pb;
    check('failure.sunburstSlotReleasedForNext', ra.ok === false && rb.ok === true && order.join(',') === 'second', order.join(','));
  }
  {
    /* abort：排队中的请求立即取消，不占槽位；已派发的由 executor 自己的 AbortController 负责 */
    const sched = R.createImageScheduler({ now: () => 1, maxConcurrent: 1 });
    const gate = {};
    const pRun = sched.enqueue({ modelKind: 'flare', characterId: 'a', priority: 1, run: () => new Promise(res => { gate.r = res; }) });
    await tick();
    const ac = new AbortController();
    const pQueued = sched.enqueue({ modelKind: 'flare', characterId: 'b', priority: 1, signal: ac.signal, run: () => Promise.resolve({ ok: true }) });
    await tick();
    ac.abort();
    const rq = await pQueued;
    check('failure.abortQueuedCancels', rq.ok === false && rq.code === 'IMAGE_ABORTED', JSON.stringify(rq));
    gate.r({ ok: true });
    await pRun;
    check('failure.abortLeavesQueueClean', sched.snapshot().queued === 0, JSON.stringify(sched.snapshot()));
  }

  /* ══ 6 · Queue overflow ════════════════════════════════════════════ */
  {
    const sched = R.createImageScheduler({ now: () => 1, maxConcurrent: 1, queueLimit: 8 });
    let releaseRun = null;
    /* 正在执行的任务手动把住；排队任务自动完成，避免测试自身留下悬空 promise */
    const pRun = sched.enqueue({ modelKind: 'flare', characterId: 'running', priority: 1, run: () => new Promise(res => { releaseRun = res; }) });
    const autoRun = () => new Promise(res => setTimeout(() => res({ ok: true }), 1));
    await tick();
    const queued = [];
    for (let i = 0; i < 8; i++) {
      queued.push(sched.enqueue({ modelKind: 'flare', characterId: 'bg' + i, priority: R.IMAGE_PRIORITY.BACKGROUND, background: true, run: autoRun }));
    }
    check('overflow.queueCapped', sched.snapshot().queued === 8, JSON.stringify(sched.snapshot()));
    const ninth = await sched.enqueue({ modelKind: 'flare', characterId: 'bg9', priority: R.IMAGE_PRIORITY.BACKGROUND, background: true, run: autoRun });
    check('overflow.backgroundRejected', ninth.ok === false && ninth.code === 'IMAGE_QUEUE_OVERFLOW', JSON.stringify(ninth));
    check('overflow.queueStillCapped', sched.snapshot().queued === 8, JSON.stringify(sched.snapshot()));
    /* 用户请求进满队列 → 顶掉最低优先级后台，自身入队 */
    let evicted = null;
    queued[7].then(r => { evicted = r; });
    const userP = sched.enqueue({ modelKind: 'flare', characterId: 'user', priority: R.IMAGE_PRIORITY.USER_EDIT, run: autoRun });
    await tick();
    check('overflow.userEvictsBackground', evicted && evicted.ok === false && evicted.code === 'IMAGE_QUEUE_EVICTED', JSON.stringify(evicted));
    check('overflow.queueNeverGrows', sched.snapshot().queued === 8, JSON.stringify(sched.snapshot()));
    releaseRun({ ok: true });
    await Promise.all([pRun, userP].concat(queued.slice(0, 7)));
    check('overflow.drainsToZero', sched.snapshot().queued === 0 && sched.snapshot().running === 0, JSON.stringify(sched.snapshot()));
  }

  /* ══ 7 · Duplicate coalescing ══════════════════════════════════════ */
  {
    const clock = makeClock();
    const sched = R.createImageScheduler({ now: clock.now, coalesceWindowMs: 8000, maxConcurrent: 1 });
    let runs = 0;
    const gate = {};
    const mk = (key) => ({ modelKind: 'flare', characterId: 'c', priority: 1, coalesceKey: key, run: () => { runs++; return new Promise(res => { gate.r = res; }); } });
    const key = R.imageCoalesceKey({ characterId: 'c', source: 'moments', operation: 'generate', prompt: '窗边的猫', referenceImages: [] }, 'flare');
    const p1 = sched.enqueue(mk(key));
    await tick();
    const p2 = sched.enqueue(mk(key));
    await tick();
    check('coalesce.singleExecution', runs === 1, 'runs=' + runs);
    check('coalesce.sharedResult', p1 === p2, 'coalesced promise 应复用同一结果');
    gate.r({ ok: true });
    const r1 = await p1;
    check('coalesce.sameResult', r1.ok === true);
    check('coalesce.stats', sched.stats().coalesced === 1, JSON.stringify(sched.stats()));
    check('coalesce.keyIncludesIdentity', R.imageCoalesceKey({ characterId: 'a', source: 'moments', prompt: 'x' }, 'flare')
      !== R.imageCoalesceKey({ characterId: 'b', source: 'moments', prompt: 'x' }, 'flare')
      && R.imageCoalesceKey({ characterId: 'a', source: 'moments', prompt: 'x' }, 'flare')
      !== R.imageCoalesceKey({ characterId: 'a', source: 'chat', prompt: 'x' }, 'flare'));
  }

  /* ══ 8 · Background protection（冷却 + 降级） ══════════════════════ */
  {
    const clock = makeClock();
    const ex = makeExecutor();
    const router = R.createImageRouter(deps(ex, { now: clock.now, getConfig: () => ({ backgroundCooldownMs: 15000, debug: false }) }));
    const p1 = router.routeImageRequest({ source: 'ai_moments', characterId: 'xilian', cfg: BASE_CFG, prompt: '随手拍一张', background: true, userInitiated: false });
    await tick();
    ex.ok(0);
    await p1;
    clock.advance(5000);
    const r2 = await router.routeImageRequest({ source: 'ai_moments', characterId: 'xilian', cfg: BASE_CFG, prompt: '再拍一张不同的', background: true, userInitiated: false });
    check('background.cooldownBlocks', r2.ok === false && r2.code === 'IMAGE_BACKGROUND_COOLDOWN', JSON.stringify(r2));
    check('background.otherCharacterAllowed', true);
    const r3p = router.routeImageRequest({ source: 'ai_moments', characterId: 'miku', cfg: BASE_CFG, prompt: '另一张', background: true, userInitiated: false });
    await tick(); ex.ok(1);
    const r3 = await r3p;
    check('background.cooldownPerCharacter', r3.ok === true);
    clock.advance(20000);
    const r4p = router.routeImageRequest({ source: 'ai_moments', characterId: 'xilian', cfg: BASE_CFG, prompt: '冷却过后的新图', background: true, userInitiated: false });
    await tick(); ex.ok(2);
    check('background.cooldownExpires', (await r4p).ok === true);
    router.reset();
  }
  {
    /* 后台 Sunburst 长排队 + Sunburst 槽位被占 → Auto 降级 Flare；显式 Precision 不降级 */
    const clock = makeClock();
    const ex = makeExecutor();
    const fake = makeFakeTimers();
    const router = R.createImageRouter(deps(ex, { now: clock.now, setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout, getConfig: () => ({ downgradeAfterWaitMs: 30000, maxSunburstConcurrent: 1, maxConcurrent: 2 }) }));
    /* 先占住 Sunburst 槽位 */
    const hold = router.routeImageRequest({ source: 'chat', characterId: 'holder', cfg: BASE_CFG, prompt: '精修占用槽位', operation: 'edit', referenceImages: ['data:image/png;base64,AAAA'], userInitiated: true });
    await tick();
    check('downgrade.holderIsSunburst', ex.calls[0].model === SUNBURST, ex.calls[0].model);
    /* 后台任务（Auto + precision 任务画像，无严格参考）→ 排队并挂上到期唤醒定时器 */
    const bgP = router.routeImageRequest({ source: 'ai_moments', characterId: 'bgchar', cfg: BASE_CFG, prompt: '把这张图的光线调暖一点，风格保持', operation: 'edit', background: true, userInitiated: false, multiTurnEdits: 1 });
    await tick();
    check('downgrade.backgroundQueuedAsSunburst', ex.calls.length === 1, 'calls=' + ex.calls.length);
    check('downgrade.timerArmedWhileWaiting', fake.pending() === 1, 'pending=' + fake.pending());
    clock.advance(31000);
    fake.fire();
    await tick();
    check('downgrade.timerWakesAndDowngrades', ex.calls.length === 2 && ex.calls[1].model === FLARE, JSON.stringify(ex.calls.map(c => c.model)));
    ex.ok(1);
    const bgR = await bgP;
    check('downgrade.reportsDowngraded', bgR.route && bgR.route.downgraded === true && bgR.route.modelKind === 'flare' && bgR.ok === true, JSON.stringify(bgR.route));
    ex.ok(0);
    await hold;
    check('downgrade.timerClearedAfterDrain', fake.pending() === 0 && router.stats().queued === 0 && router.stats().running === 0, 'pending=' + fake.pending());
    router.reset();
    /* 显式 Precision：即使长排队也不降级 */
    const clock2 = makeClock();
    const ex2 = makeExecutor();
    const router2 = R.createImageRouter(deps(ex2, { now: clock2.now, getConfig: () => ({ downgradeAfterWaitMs: 1000, maxSunburstConcurrent: 1, maxConcurrent: 2 }), getUserMode: () => 'precision' }));
    const hold2 = router2.routeImageRequest({ source: 'chat', characterId: 'holder', cfg: BASE_CFG, prompt: '占位', userInitiated: true });
    await tick();
    const bg2 = router2.routeImageRequest({ source: 'ai_moments', characterId: 'bgchar', cfg: BASE_CFG, prompt: '后台精修', background: true, userInitiated: false });
    clock2.advance(60000);
    await tick();
    check('downgrade.explicitPrecisionNeverDowngraded', ex2.calls.length === 1, 'calls=' + ex2.calls.length);
    ex2.ok(0);
    await hold2;
    await tick();
    check('downgrade.precisionRunsAfterSlotFrees', ex2.calls.length === 2 && ex2.calls[1].model === SUNBURST, JSON.stringify(ex2.calls.map(c => c.model)));
    ex2.ok(1);
    await bg2;
    router2.reset();
  }

  /* ══ 9 · Auto upgrade（Flare 生成 → precision 续修 → Sunburst） ═════ */
  {
    const ex = makeExecutor();
    const router = R.createImageRouter(deps(ex));
    const gen = router.routeImageRequest({ source: 'chat', characterId: 'xilian', cfg: BASE_CFG, prompt: '生成昔涟坐在窗边的图片', userInitiated: true });
    await tick(); ex.ok(0);
    const genR = await gen;
    check('upgrade.firstGenerationFlare', ex.calls[0].model === FLARE && genR.route.modelKind === 'flare', JSON.stringify(genR.route));
    const editP = router.routeImageRequest({
      source: 'chat', characterId: 'xilian', cfg: BASE_CFG, operation: 'edit',
      prompt: '这张很好，只把头发改长一点，其他地方完全不要动',
      previousImage: { model: FLARE, dataUrl: 'data:image/png;base64,AAAA' }, userInitiated: true
    });
    await tick(); ex.ok(1);
    const editR = await editP;
    check('upgrade.followUpPrecisionEditSunburst', ex.calls[1].model === SUNBURST && editR.route.routeReason === 'edit_previous_image', JSON.stringify(editR.route));
    check('upgrade.telemetryRecordsBoth', router.telemetry().length === 2 && router.telemetry()[0].selectedModel === FLARE && router.telemetry()[1].selectedModel === SUNBURST);
    router.reset();
  }

  /* ══ 10 · Router 端到端：模型下发 / provider_managed / 失败路径 ══════ */
  {
    const ex = makeExecutor();
    const router = R.createImageRouter(deps(ex));
    const p = router.routeImageRequest({ source: 'chat', characterId: 'x', cfg: BASE_CFG, prompt: '一只猫', size: '1024x1024', userInitiated: true });
    await tick();
    check('router.forwardsSelectedModelToExecutor', ex.calls[0].model === FLARE, ex.calls[0].model);
    check('router.preservesUserCfg', ex.calls[0].cfg.apiKey === BASE_CFG.apiKey && ex.calls[0].cfg.provider === 'openai');
    check('router.forwardsSizeAndQuality', ex.calls[0].size === '1024x1024' && ex.calls[0].opts.quality === 'auto');
    ex.ok(0);
    const r = await p;
    check('router.resultShape', r.ok === true && !!r.dataUrl && !!r.route && r.route.source === 'chat' && r.route.priorityName === 'P1', JSON.stringify(r.route));
    const pm = router.routeImageRequest({ source: 'moments', characterId: 'x', cfg: Object.assign({}, BASE_CFG, { imageGenModel: 'p4-img-gen' }), prompt: '一只猫' });
    await tick();
    check('router.providerManagedKeepsModel', ex.calls[1].model === 'p4-img-gen', ex.calls[1].model);
    ex.ok(1); await pm;
    const noCfg = await router.routeImageRequest({ source: 'chat', prompt: 'x' });
    check('router.noCfgFails', noCfg.ok === false && noCfg.code === 'IMAGE_NO_CONFIG');
    const noPrompt = await router.routeImageRequest({ source: 'chat', cfg: BASE_CFG, prompt: '   ' });
    check('router.emptyPromptFails', noPrompt.ok === false && noPrompt.code === 'IMAGE_EMPTY_PROMPT');
    const noExec = R.createImageRouter({ resolveProvider: () => 'openai' });
    const rNoExec = await noExec.routeImageRequest({ source: 'chat', cfg: BASE_CFG, prompt: 'x' });
    check('router.noExecutorFails', rNoExec.ok === false && rNoExec.code === 'IMAGE_NO_EXECUTOR');
    /* 依赖失败不得让路由层变成单点故障：用户策略读取异常 → 回退 auto */
    const exFb = makeExecutor();
    const rFb = R.createImageRouter(deps(exFb, { getUserMode: () => { throw new Error('mb down'); } }));
    const pFb = rFb.routeImageRequest({ source: 'chat', cfg: BASE_CFG, prompt: '一只猫', userInitiated: true });
    await tick(); exFb.ok(0);
    const rFbRes = await pFb;
    check('router.getUserModeFailureFallsBack', rFbRes.ok === true && rFbRes.route.mode === 'auto' && exFb.calls[0].model === FLARE, JSON.stringify(rFbRes.route));
    router.reset();
  }

  /* ══ 11 · Telemetry（字段齐全 + 不含敏感数据） ═════════════════════ */
  {
    const ex = makeExecutor();
    const router = R.createImageRouter(deps(ex));
    const p = router.routeImageRequest({ source: 'moments', characterId: '昔涟', cfg: BASE_CFG, prompt: '窗边的猫', background: true, userInitiated: false });
    await tick(); ex.ok(0);
    await p;
    const rec = router.telemetry()[0];
    const fields = ['source', 'characterId', 'requestedMode', 'selectedModel', 'priority', 'queueWaitMs', 'executionMs', 'downgraded', 'routeReason'];
    check('telemetry.fields', fields.every(f => rec[f] !== undefined), JSON.stringify(rec));
    check('telemetry.values', rec.source === 'moments' && rec.characterId === '昔涟' && rec.selectedModel === FLARE && rec.priorityName === 'P3' && rec.ok === true, JSON.stringify(rec));
    const blob = JSON.stringify(router.telemetry());
    check('telemetry.noApiKey', blob.indexOf('sk-secret') < 0 && blob.indexOf('apiKey') < 0, blob);
    check('telemetry.noImageData', blob.indexOf('base64') < 0 && blob.indexOf('data:image') < 0, blob);
    const ex2 = makeExecutor();
    const r2 = R.createImageRouter(deps(ex2, { getConfig: () => ({ telemetryLimit: 2 }) }));
    for (let i = 0; i < 3; i++) {
      const pp = r2.routeImageRequest({ source: 'chat', cfg: BASE_CFG, prompt: 'p' + i });
      await tick();
      ex2.ok(i);
      await pp;
    }
    check('telemetry.ringBufferCapped', r2.telemetry().length === 2, 'len=' + r2.telemetry().length);
    r2.reset();
    router.reset();
  }

  /* ══ 12 · 拒绝码文案 ═══════════════════════════════════════════════ */
  {
    check('rejectText.knownCode', R.imageRejectText({ code: 'IMAGE_QUEUE_OVERFLOW' }).indexOf('排队') >= 0);
    check('rejectText.fallbackReason', R.imageRejectText({ reason: '生图请求失败（401）' }) === '生图请求失败（401）');
    check('rejectText.nullSafe', R.imageRejectText(null) === '生成失败');
  }

  clearTimeout(watchdog);
  console.log(failures === 0 ? '\nImage Router / Scheduler passed ✔' : '\nImage Router / Scheduler FAILED ✘');
  process.exit(failures ? 1 : 0);
})();
