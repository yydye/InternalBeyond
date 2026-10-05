'use strict';
/* ============================================================================
   Internal Beyond · UI-P1 · Memory World — 确定性布局 + 规模/性能
   ----------------------------------------------------------------------------
   运行：node tests/test_memory_world_layout.js   （需要本机 Chrome / Edge）

   冻结的断言：
     · 同一 memory 集合 → 同一布局（模块重读 + 真实页面重载都一致）
     · 不同 id → 不同分布（不是所有 id 落到同一个位置）
     · 分布合理（均值和方差有界，全部落在画幅内）
     · 200 / 500 / 1000 条：世界完整渲染 N 个节点（不做 sampling）、
       DOM 节点数有界、reload 与绘制耗时被如实记录、无异常、交互可执行
   ============================================================================ */

const H = require('./helpers/memory-world-cdp.js');

const LABEL = 'Memory World deterministic layout + scale';
const { check, info, finish } = H.makeChecker(LABEL);

function section(title) { console.log('\n── ' + title + ' ──'); }

function stats(values) {
  const n = values.length;
  if (!n) return { mean: 0, sd: 0, min: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { mean, sd: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };
}

async function fingerprint(cdp) {
  return H.evaluate(cdp, 'IB.memoryWorld.layoutFingerprint()');
}

async function layoutOf(cdp) {
  return H.evaluate(cdp, 'JSON.stringify(IB.memoryWorld.layout())');
}

async function seedAndReady(cdp, count, prefix) {
  await H.clearMemories(cdp);
  if (count > 0) await H.seedMemories(cdp, H.makeRecords(count, prefix || 'lay'));
  const started = Date.now();
  await H.evaluate(cdp, 'IB.memoryWorld.reload()');
  const elapsed = Date.now() - started;
  await H.settle(cdp);
  return elapsed;
}

async function main() {
  const session = await H.launch({ width: 1440, height: 900 });
  const { cdp } = session;
  try {
    await H.enterAppShell(cdp);
    info('首次引导处理: ' + await H.dismissSetupWizard(cdp));
    await H.waitForWorld(cdp);
    await H.goToMemoryPage(cdp);

    section('§1 同一集合 → 同一布局');
    await seedAndReady(cdp, 200, 'lay');
    const fpA = await fingerprint(cdp);
    const layoutA = await layoutOf(cdp);
    check('determinism.firstRenderReady', await H.evaluate(cdp, 'IB.memoryWorld.stats().renderedNodes === 200'));

    await H.evaluate(cdp, 'IB.memoryWorld.reload()');
    await H.settle(cdp);
    const fpB = await fingerprint(cdp);
    const layoutB = await layoutOf(cdp);
    check('determinism.moduleReloadStable', fpA === fpB && layoutA === layoutB,
      fpA + ' vs ' + fpB);

    await session.reload();
    await H.enterAppShell(cdp);
    await H.goToMemoryPage(cdp);
    const fpC = await fingerprint(cdp);
    const layoutC = await layoutOf(cdp);
    check('determinism.fullPageReloadStable', fpA === fpC && layoutA === layoutC,
      fpA + ' vs ' + fpC);
    info('layout fingerprint: ' + fpA);

    section('§2 位置只由 id 决定（与输入顺序、与同集合的其它 id 无关）');
    const probe = await H.evaluate(cdp, `(function(){
      var I = IB.memoryWorld._internals;
      function nodes(ids) { return I.computeLayout(ids.map(function (id) { return { id: id }; })); }
      function fp(ids) { var n = nodes(ids); return I.layoutFingerprint(n, ids.map(function (id) { return { id: id }; })); }
      var a = [], b = [], shuffled = [];
      for (var i = 0; i < 40; i++) { a.push('alpha-' + i); b.push('beta-' + i); }
      shuffled = a.slice().reverse();
      var na = nodes(a), ns = nodes(shuffled);
      var byId = {};
      na.forEach(function (n) { byId[n.id] = n; });
      var orderStable = ns.every(function (n) {
        var ref = byId[n.id];
        return ref && ref.x === n.x && ref.y === n.y;
      });
      var nb = nodes(b);
      var sameSpot = 0;
      for (var k = 0; k < na.length; k++) {
        if (Math.abs(na[k].x - nb[k].x) < 1e-6 && Math.abs(na[k].y - nb[k].y) < 1e-6) sameSpot++;
      }
      return JSON.stringify({ orderStable: orderStable, fpA: fp(a), fpB: fp(b), sameSpot: sameSpot, total: na.length });
    })()`);
    const p = JSON.parse(probe);
    info('不同 id 集合的指纹: ' + p.fpA + ' / ' + p.fpB);
    check('determinism.inputOrderIndependent', p.orderStable,
      '同一 id 在正序/逆序输入下必须落在同一位置');
    check('determinism.distinctIdSetsDiffer', p.fpA !== p.fpB);
    check('determinism.distinctIdsDoNotSharePositions', p.sameSpot < p.total * 0.05,
      p.sameSpot + '/' + p.total + ' 对 id 落在了同一点');

    section('§3 分布合理性');
    const points = JSON.parse(await layoutOf(cdp));
    const xs = stats(points.map(n => n.x));
    const ys = stats(points.map(n => n.y));
    info('x: mean=' + xs.mean.toFixed(3) + ' sd=' + xs.sd.toFixed(3) + ' [' + xs.min.toFixed(3) + ',' + xs.max.toFixed(3) + ']');
    info('y: mean=' + ys.mean.toFixed(3) + ' sd=' + ys.sd.toFixed(3) + ' [' + ys.min.toFixed(3) + ',' + ys.max.toFixed(3) + ']');
    check('distribution.spreadAcrossX', xs.sd > 0.15);
    check('distribution.spreadAcrossY', ys.sd > 0.15);
    check('distribution.centeredX', Math.abs(xs.mean - 0.5) < 0.08);
    check('distribution.centeredY', Math.abs(ys.mean - 0.5) < 0.08);
    check('distribution.insideFrame',
      xs.min >= 0.05 && xs.max <= 0.95 && ys.min >= 0.05 && ys.max <= 0.95,
      'x[' + xs.min.toFixed(3) + ',' + xs.max.toFixed(3) + '] y[' + ys.min.toFixed(3) + ',' + ys.max.toFixed(3) + ']');
    check('distribution.uniqueIds', new Set(points.map(n => n.id)).size === points.length);

    section('§4 规模与性能 200 / 500 / 1000');
    const report = [];
    for (const count of [200, 500, 1000]) {
      const reloadMs = await seedAndReady(cdp, count, 'scale');
      const s = await H.evaluate(cdp, 'IB.memoryWorld.stats()');
      await H.evaluate(cdp, "document.getElementById('mem-world-entry').click()");
      await H.settle(cdp);
      await H.sleep(200);
      const clickable = await H.evaluate(cdp, `(function(){
        var layout = IB.memoryWorld.layout();
        var canvas = document.getElementById('mem-world-nodes');
        var box = canvas.getBoundingClientRect();
        var n = layout[0];
        return !!(box.width > 0 && box.height > 0 && isFinite(n.x) && isFinite(n.y));
      })()`);
      const selected = await H.evaluate(cdp, "var l=IB.memoryWorld.layout(); IB.memoryWorld.select(l[Math.floor(l.length/2)].id)");
      const previewOk = await H.evaluate(cdp, "document.getElementById('mem-world-preview').hidden === false");
      await H.evaluate(cdp, 'IB.memoryWorld.close()');
      await H.settle(cdp);
      report.push({ count, reloadMs, renderMs: s.renderMs, rendered: s.renderedNodes, domNodes: s.domNodes, clickable, previewOk });
      info(count + ' 条: reload ' + reloadMs + 'ms · 绘制 ' + s.renderMs + 'ms · 节点 ' + s.renderedNodes +
        ' · DOM ' + s.domNodes + ' · 可交互 ' + clickable + ' · 预览 ' + previewOk);
      check('scale.' + count + '.allNodesRendered', s.renderedNodes === count && s.items === count,
        'rendered=' + s.renderedNodes + ' items=' + s.items);
      check('scale.' + count + '.noSamplingOrFakeAbsence', s.renderedNodes === count,
        '任何 sampling 都会让未显示的 memory 看起来不存在');
      check('scale.' + count + '.domNodesBounded', s.domNodes > 0 && s.domNodes < 200,
        'DOM 节点 ' + s.domNodes + '（世界是 canvas，不是每 memory 一张卡）');
      check('scale.' + count + '.interactive', clickable && previewOk);
      check('scale.' + count + '.mountCompletesInBudget', reloadMs < 8000, reloadMs + 'ms');
      check('scale.' + count + '.paintCompletesInBudget', s.renderMs < 1500, s.renderMs + 'ms');
    }
    check('scale.renderCostIsLinearish',
      report[2].renderMs < report[0].renderMs * 25 + 50,
      JSON.stringify(report.map(r => ({ n: r.count, paint: r.renderMs, reload: r.reloadMs }))));

    section('§5 边界与异常');
    const one = await seedAndReady(cdp, 1, 'one');
    check('edge.singleMemoryRenders', await H.evaluate(cdp, 'IB.memoryWorld.stats().renderedNodes === 1'), 'reload ' + one + 'ms');
    const zero = await seedAndReady(cdp, 0, 'zero');
    check('edge.zeroMemoriesIsSuccess',
      await H.evaluate(cdp, "IB.memoryWorld.stats().renderedNodes === 0 && IB.memoryWorld.stats().error === null"),
      'reload ' + zero + 'ms');
    check('edge.corruptRecordDoesNotBreakWorld', await H.evaluate(cdp, `(async function(){
      await dbPut('memories', { id: 'mw_corrupt', title: null, content: 123, valence: 'bad', arousal: null });
      await dbPut('memories', { id: 'mw_no_created', title: '缺少 created', summary: 'x' });
      await IB.memoryWorld.reload();
      var s = IB.memoryWorld.stats();
      return s.error === null && s.renderedNodes === 2 && s.items === 2;
    })()`), '缺字段 / 类型错误的记录不得让世界报错');
    check('layout.noUncaughtExceptions', session.exceptions.length === 0, session.exceptions.slice(0, 3).join(' | '));
  } finally {
    await session.close();
  }
  finish();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
