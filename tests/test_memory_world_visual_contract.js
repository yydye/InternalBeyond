'use strict';
/* ============================================================================
   Internal Beyond · UI-P1.1 · Memory World 视觉契约
   ----------------------------------------------------------------------------
   运行：node tests/test_memory_world_visual_contract.js  （需要本机 Chrome / Edge）

   这是**结构 / 几何契约**，不是像素 golden：
     · 宏观断层存在，且是「贯穿画面的曲线」而不是噪声
     · 环境几何确定性（固定世界种子；重载后大结构逐值相同）
     · 深度层次与节点视觉分层（70 / 20 / 8 / 2，且所有 memory 都渲染）
     · light / dark 都有宏观结构，且是不同的材质（不是反相）
     · UI chrome 契约（世界满幅；次要动作收在 ··· 菜单里）
     · preview 是 annotation（无底、无边框），不是 card
     · 无 association 连线
     · prefers-reduced-motion 停止全部环境运动
   ============================================================================ */

const fs = require('fs');
const path = require('path');
const H = require('./helpers/memory-world-cdp.js');

const LABEL = 'Memory World visual contract';
const { check, info, finish } = H.makeChecker(LABEL);
const SOURCE_PATH = path.join(H.ROOT, 'assets', 'js', 'memory-world.js');

function section(title) { console.log('\n── ' + title + ' ──'); }

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* 在页面里对给定画布做列剖面：返回每列「偏离该列均值的最大像素」所在的相对高度。
   亮脊（dark）与暗脊（light）都能被这一步检出，所以同一个度量对两个世界都成立。 */
const COLUMN_PROFILE = `function (selector, cols) {
  var c = document.querySelector(selector);
  if (!c || !c.width || !c.height) return null;
  var ctx = c.getContext('2d');
  var W = c.width, H = c.height;
  var data = ctx.getImageData(0, 0, W, H).data;
  var out = [];
  for (var k = 0; k < cols; k++) {
    var x = Math.floor((k + 0.5) / cols * W);
    var sum = 0, n = 0, y;
    for (y = 0; y < H; y += 2) {
      var i = (y * W + x) * 4;
      sum += data[i] + data[i + 1] + data[i + 2];
      n += 1;
    }
    var mean = sum / n;
    var bestY = 0, bestD = -1;
    for (y = 0; y < H; y += 2) {
      var j = (y * W + x) * 4;
      var l = data[j] + data[j + 1] + data[j + 2];
      var d = Math.abs(l - mean);
      if (d > bestD) { bestD = d; bestY = y; }
    }
    out.push({ x: k / (cols - 1), y: bestY / H, dev: bestD / 3, mean: mean / 3 });
  }
  return out;
}`;

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roughness(profile) {
  /* 只关心「同一段曲线在相邻采样列之间是否连续」。画面里有两条断层，
     最大偏差列会在两条之间跳 —— 用中位数而不是均值，跳变就不会主导度量。 */
  const deltas = [];
  for (let i = 1; i < profile.length; i++) deltas.push(Math.abs(profile[i].y - profile[i - 1].y));
  return median(deltas);
}

/* 采样必须等画布真的画完：批量跑套件时机器负载会让 rAF 重绘晚一拍，
   于是同一段几何在不同时刻被读到不同结果。这里轮询到稳定为止，
   而不是靠固定 sleep —— 断言本身仍然严格。 */
async function waitPainted(cdp, timeoutMs = 10000) {
  await H.waitFor(cdp, 'IB.memoryWorld.stats().surfaces.every(function (s) { return s.painted && s.w > 2 && s.h > 2; })', timeoutMs);
  await H.settle(cdp);
  await H.sleep(250);
}

async function stableBrightness(cdp, selector, accept, tries = 15) {
  let value = -1;
  for (let i = 0; i < tries; i++) {
    value = await H.canvasBrightness(cdp, selector);
    if (accept(value)) return value;
    await H.sleep(200);
  }
  return value;
}

async function stableProfile(cdp, selector, cols, accept, tries = 15) {
  let profile = null;
  for (let i = 0; i < tries; i++) {
    profile = await H.evaluate(cdp, `(${COLUMN_PROFILE})(${JSON.stringify(selector)}, ${cols})`);
    if (Array.isArray(profile) && accept(median(profile.map(p => p.dev)))) return profile;
    await H.sleep(200);
  }
  return profile;
}

async function main() {
  section('§1 静态契约：几何确定性 / 无 association / 视觉分层存在');

  const RAW = fs.readFileSync(SOURCE_PATH, 'utf8').replace(/^\uFEFF/, '');
  const CODE = stripComments(RAW);

  check('static.noRandomSource', !/Math\.random/.test(CODE),
    '世界几何必须是确定性的：不允许任何随机源');
  check('static.declaresFixedWorldSeed', /WORLD_SEED\s*=\s*0x[0-9a-f]+/i.test(CODE));
  check('static.noAssociationDrawing',
    CODE.indexOf('<line') === -1 && CODE.indexOf('createElementNS') === -1,
    '任何 node-to-node 连线都会让这里变红');
  check('static.declaresAssociationDisabled', CODE.indexOf("associationLines: 'DISABLED'") >= 0);
  check('static.macroBandsWithinBudget',
    /MACRO_ENVIRONMENT_BANDS\s*=\s*2/.test(RAW) || (CODE.match(/key:\s*'/g) || []).length >= 2,
    '宏观断层数量必须落在 1–2 条');
  check('static.tierHierarchyDeclared',
    CODE.indexOf("'speck'") >= 0 && CODE.indexOf("'anchor'") >= 0 && CODE.indexOf('0.02') >= 0,
    '视觉分层（70/20/8/2）必须在代码里可见');
  check('static.previewIsNotACard',
    !/memory-world__preview\s*\{[^}]*background:/s.test(fs.readFileSync(path.join(H.ROOT, 'assets', 'css', 'memory-world.css'), 'utf8')),
    'preview 不得有面板底');

  const session = await H.launch({ width: 1440, height: 900 });
  const { cdp } = session;
  try {
    await H.enterAppShell(cdp);
    info('首次引导处理: ' + await H.dismissSetupWizard(cdp));
    await H.waitForWorld(cdp);
    await H.goToMemoryPage(cdp);
    await H.clearMemories(cdp);
    await H.seedMemories(cdp, H.makeRecords(200, 'vc'));
    await H.evaluate(cdp, 'IB.memoryWorld.reload()');
    await H.settle(cdp);
    await H.sleep(400);

    section('§2 宏观断层：贯穿画面的大形（不是噪声）');

    check('macro.bandCountWithinBudget', await H.evaluate(cdp, 'IB.memoryWorld.macroBands >= 1 && IB.memoryWorld.macroBands <= 2'),
      String(await H.evaluate(cdp, 'IB.memoryWorld.macroBands')));

    await H.evaluate(cdp, "document.getElementById('mem-world-entry').click()");
    await H.settle(cdp);
    await H.sleep(400);

    const profile = await stableProfile(cdp, '#mem-world-env', 48, function (dev) { return dev > 12; });
    await waitPainted(cdp);
    check('macro.profileAvailable', Array.isArray(profile) && profile.length === 48);
    const deviations = profile.map(p => p.dev);
    const medDev = median(deviations);
    const rough = roughness(profile);
    const ys = profile.map(p => p.y);
    const span = Math.max(...ys) - Math.min(...ys);
    info('脊偏差中位数=' + medDev.toFixed(1) + ' · 相邻列中位跳变=' + rough.toFixed(4) + ' · 纵向跨度=' + span.toFixed(3));
    check('macro.ridgeIsPresent', medDev > 10, '中位偏差 ' + medDev.toFixed(1));
    check('macro.ridgeIsACurveNotNoise', rough < 0.10, '相邻列中位跳变 ' + rough.toFixed(4) + '（均匀噪声约 0.25）');
    check('macro.ridgeTraversesFrame', span > 0.12, '跨度 ' + span.toFixed(3));

    section('§3 环境几何确定性');

    const seedA = await H.evaluate(cdp, 'IB.memoryWorld.worldSeed');
    const geomA = JSON.stringify(await H.evaluate(cdp, 'IB.memoryWorld.bandGeometry()'));
    await session.reload();
    await H.enterAppShell(cdp);
    await H.goToMemoryPage(cdp);
    const seedB = await H.evaluate(cdp, 'IB.memoryWorld.worldSeed');
    const geomB = JSON.stringify(await H.evaluate(cdp, 'IB.memoryWorld.bandGeometry()'));
    check('determinism.worldSeedStable', seedA === seedB, seedA + ' vs ' + seedB);
    check('determinism.bandGeometryStable', geomA === geomB, 'band geometry drifted across reload');
    check('determinism.memoryLayoutStable', typeof (await H.evaluate(cdp, 'IB.memoryWorld.layoutFingerprint()')) === 'string');

    /* 重载把世界关上了：后面的层次 / 材质 / chrome 度量都需要世界是打开的。 */
    await H.evaluate(cdp, 'IB.memoryWorld.open()');
    await H.settle(cdp);
    await H.sleep(400);

    section('§4 深度层次与节点视觉分层');

    const tiers = await H.evaluate(cdp, 'JSON.stringify(IB.memoryWorld.stats().tierCounts)');
    const t = JSON.parse(tiers);
    const total = t.anchor + t.strong + t.light + t.speck;
    info('视觉分层: ' + tiers + '（总数 ' + total + '）');
    check('hierarchy.allMemoriesRendered',
      await H.evaluate(cdp, 'IB.memoryWorld.stats().renderedNodes === 200 && IB.memoryWorld.items() === 200'));
    check('hierarchy.everyMemoryHasExactlyOneTier', total === 200, String(total));
    check('hierarchy.specksAreTheMajority', t.speck / total > 0.6 && t.speck / total < 0.8, String(t.speck / total));
    check('hierarchy.anchorsAreFew', t.anchor >= 1 && t.anchor / total <= 0.04, String(t.anchor));
    check('hierarchy.strongIsSmallCohort', t.strong / total > 0.05 && t.strong / total < 0.12, String(t.strong / total));

    check('depth.envAndMistAreSeparateLayers',
      await H.evaluate(cdp, "!!document.getElementById('mem-world-env') && !!document.getElementById('mem-world-mist') && document.getElementById('mem-world-mist') !== document.getElementById('mem-world-env')"),
      '两层环境画布 = 视差纵深');

    section('§5 light / dark：两个世界，独立材质');

    await H.evaluate(cdp, "document.body.classList.add('theme-infernal')");
    await H.settle(cdp);
    await H.sleep(600);
    const darkBright = await stableBrightness(cdp, '#mem-world-env', function (v) { return v > 0 && v < 90; });
    const darkProfile = await stableProfile(cdp, '#mem-world-env', 48, function (dev) { return dev > 12; });
    await H.evaluate(cdp, "document.body.classList.remove('theme-infernal')");
    await H.settle(cdp);
    await H.sleep(600);
    const lightBright = await stableBrightness(cdp, '#mem-world-env', function (v) { return v > 190; });
    info('环境层平均通道: dark=' + Math.round(darkBright) + ' light=' + Math.round(lightBright));
    check('material.darkIsDark', darkBright < 90, String(Math.round(darkBright)));
    check('material.lightIsLight', lightBright > 190, String(Math.round(lightBright)));
    check('material.notInverted', Math.abs(lightBright - darkBright) > 110);
    check('material.darkHasMacroStructure', median(darkProfile.map(p => p.dev)) > 10);

    const lightProfile = await stableProfile(cdp, '#mem-world-env', 48, function (dev) { return dev > 4; });
    const lightDev = median(lightProfile.map(p => p.dev));
    info('light 脊偏差中位数=' + lightDev.toFixed(1));
    check('material.lightHasItsOwnMacroStructure', lightDev > 4,
      '浅色世界也必须有宏观断裂（不是白底 + 模糊黑点）');

    section('§6 UI chrome 契约');

    const chrome = JSON.parse(await H.evaluate(cdp, `(function(){
      function visible(id) {
        var el = document.getElementById(id);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), shown: r.width > 0 && r.height > 0 };
      }
      var buttons = document.querySelectorAll('.memory-world__bar button');
      var visibleCount = 0;
      for (var i = 0; i < buttons.length; i++) {
        var r = buttons[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) visibleCount += 1;
      }
      return JSON.stringify({
        menu: visible('mem-world-menu-toggle'),
        exit: visible('mem-world-exit'),
        finderToggle: visible('mem-world-finder-toggle'),
        motion: visible('mem-world-motion-toggle'),
        barButtons: buttons.length,
        barVisible: visibleCount
      });
    })()`));
    info('chrome: ' + JSON.stringify(chrome));
    check('chrome.onlyTwoAlwaysVisibleControls',
      chrome.barVisible === 2 && chrome.menu.shown && chrome.exit.shown,
      '顶部常驻只有 ··· 与 ×（其余按钮收在菜单里）barVisible=' + chrome.barVisible);
    check('chrome.secondaryActionsCollapsed',
      chrome.finderToggle.shown === false && chrome.motion.shown === false,
      '查找 / 环境运动 默认收在菜单里');
    const viewport = JSON.parse(await H.evaluate(cdp, `(function(){
      var r = document.getElementById('mem-world-overlay').getBoundingClientRect();
      return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), iw: document.documentElement.clientWidth, ih: document.documentElement.clientHeight, open: document.getElementById('mem-world-overlay').classList.contains('is-open') });
    })()`));
    info('viewport: ' + JSON.stringify(viewport));
    check('chrome.worldOccupiesFullViewport',
      viewport.open && Math.abs(viewport.w - viewport.iw) < 2 && Math.abs(viewport.h - viewport.ih) < 2,
      JSON.stringify(viewport));

    section('§7 preview 是 annotation，不是 card');

    await H.evaluate(cdp, `(function(){ var l = IB.memoryWorld.layout(); IB.memoryWorld.select(l[5].id); })()`);
    await H.settle(cdp);
    await H.sleep(200);
    const preview = JSON.parse(await H.evaluate(cdp, `(function(){
      var p = document.getElementById('mem-world-preview');
      var cs = getComputedStyle(p);
      var foot = p.querySelector('.memory-world__preview-foot');
      var fcs = getComputedStyle(foot);
      return JSON.stringify({
        hidden: p.hidden,
        bg: cs.backgroundColor,
        borderTop: cs.borderTopWidth,
        borderLeft: cs.borderLeftWidth,
        borderRight: cs.borderRightWidth,
        footRule: fcs.borderTopWidth,
        hasOpen: !!document.getElementById('mem-world-open')
      });
    })()`));
    info('preview: ' + JSON.stringify(preview));
    check('preview.visibleAfterSelect', preview.hidden === false);
    check('preview.hasNoPanelFill',
      preview.bg === 'rgba(0, 0, 0, 0)' || preview.bg === 'transparent', preview.bg);
    check('preview.hasNoCardBorder',
      preview.borderTop === '0px' && preview.borderLeft === '0px' && preview.borderRight === '0px',
      preview.borderTop + '/' + preview.borderLeft + '/' + preview.borderRight);
    check('preview.keepsASingleHairlineRule', preview.footRule === '1px', preview.footRule);
    check('preview.keepsOpenMemoryAction', preview.hasOpen);

    section('§8 无连线 / 减少动态');

    check('association.noSvgInWorld',
      await H.evaluate(cdp, "!document.querySelector('#mem-world-overlay svg, #mem-world-overlay line')"));
    check('association.declaredDisabled', await H.evaluate(cdp, "IB.memoryWorld.associationLines === 'DISABLED'"));

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await H.sleep(400);
    check('motion.envStops',
      await H.evaluate(cdp, "getComputedStyle(document.getElementById('mem-world-env')).animationName === 'none'"));
    check('motion.mistStops',
      await H.evaluate(cdp, "getComputedStyle(document.getElementById('mem-world-mist')).animationName === 'none'"));
    check('motion.moduleFlagOff',
      await H.evaluate(cdp, "document.getElementById('mem-world-overlay').getAttribute('data-motion') === 'off'"));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await H.sleep(200);
    check('motion.envResumesWhenAllowed',
      await H.evaluate(cdp, "getComputedStyle(document.getElementById('mem-world-env')).animationName !== 'none'"));

    check('visual.noUncaughtExceptions', session.exceptions.length === 0, session.exceptions.slice(0, 3).join(' | '));
  } finally {
    await session.close();
  }
  finish();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
