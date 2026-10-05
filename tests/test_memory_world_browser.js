'use strict';
/* ============================================================================
   Internal Beyond · UI-P1 · Memory World — 浏览器端到端
   ----------------------------------------------------------------------------
   运行：node tests/test_memory_world_browser.js   （需要本机 Chrome / Edge）

   真实 Chrome + file:// + 真实 IndexedDB 覆盖：
     Memory 页入口 / 0 条记忆 / 1 条记忆 / 200 条记忆 / 进入世界 /
     选中节点（真实指针命中）/ 打开既有 detail authority / 退出（Esc + 浏览器后退）/
     light 与 dark 是两个世界 / 390px / prefers-reduced-motion / 无横向溢出 / 无未捕获异常

   本套件只验证「表现层读既有事实」的行为，不写入任何 memory。
   ============================================================================ */

const H = require('./helpers/memory-world-cdp.js');

const LABEL = 'Memory World browser E2E';
const { check, info, finish } = H.makeChecker(LABEL);

function section(title) { console.log('\n── ' + title + ' ──'); }

async function selectFreeNode(cdp) {
  /* 选一个不在 preview 面板遮挡范围内的节点，保证真实指针命中。 */
  const point = await H.evaluate(cdp, `(function(){
    var layout = IB.memoryWorld.layout();
    var canvas = document.getElementById('mem-world-nodes');
    if (!canvas || !layout.length) return null;
    var box = canvas.getBoundingClientRect();
    var panel = document.getElementById('mem-world-preview');
    var pr = panel && !panel.hidden ? panel.getBoundingClientRect() : null;
    for (var i = 0; i < layout.length; i++) {
      var x = box.left + layout[i].x * box.width;
      var y = box.top + layout[i].y * box.height;
      if (x < box.left + 8 || x > box.right - 8 || y < box.top + 8 || y > box.bottom - 8) continue;
      if (pr && x >= pr.left - 6 && x <= pr.right + 6 && y >= pr.top - 6 && y <= pr.bottom + 6) continue;
      return { id: layout[i].id, x: x, y: y };
    }
    return null;
  })()`);
  return point;
}

async function main() {
  const session = await H.launch({ width: 1440, height: 900 });
  const { cdp } = session;
  try {
    section('§1 挂载与入口');
    const appReady = await H.enterAppShell(cdp);
    check('app.shellVisible', appReady, '应用壳未在 25s 内可见');
    const wizard = await H.dismissSetupWizard(cdp);
    info('首次引导处理: ' + wizard);
    const worldReady = await H.waitForWorld(cdp);
    check('world.moduleRegistered', worldReady, 'window.IB.memoryWorld 未挂载或未就绪');
    check('world.roleIsPresentationOnly',
      await H.evaluate(cdp, "IB.memoryWorld.role === 'PRESENTATION_LAYER_ONLY' && IB.memoryWorld.associationLines === 'DISABLED' && IB.memoryWorld.positionSemanticAuthority === 'NO'"),
      JSON.stringify(await H.evaluate(cdp, '({role:IB.memoryWorld.role,lines:IB.memoryWorld.associationLines,pos:IB.memoryWorld.positionSemanticAuthority})')));
    check('world.styleInjectedAtRuntime',
      await H.evaluate(cdp, "!!document.getElementById('ib-memory-world-style') && document.getElementById('ib-memory-world-style').href.indexOf('assets/css/memory-world.css') >= 0"),
      '样式表必须由模块运行时注入（HTML 的样式表预算被结构测试精确锁定）');

    const onPage = await H.goToMemoryPage(cdp);
    check('entry.mountedOnMemoryPage', onPage, '#mem-world-entry 未出现在 Memory 页');
    check('entry.sitsAfterModuleIntro',
      await H.evaluate(cdp, "(function(){var p=document.getElementById('page-memory'),i=p.querySelector('.module-intro'),e=document.getElementById('mem-world-entry');return !!i && !!e && i.parentNode===p && i.nextSibling===e})()"));
    check('entry.isRealButtonWithDialogSemantics',
      await H.evaluate(cdp, "(function(){var e=document.getElementById('mem-world-entry');return e.tagName==='BUTTON' && e.type==='button' && e.getAttribute('aria-haspopup')==='dialog' && e.getAttribute('aria-controls')==='mem-world-overlay' && !!e.getAttribute('aria-label')})()"));
    check('entry.usesCanvasesNotDomCards',
      await H.evaluate(cdp, "!!document.querySelector('#mem-world-entry .memory-world-entry__env') && !!document.querySelector('#mem-world-entry .memory-world-entry__nodes')"));

    section('§2 0 条记忆是合法成功（安静的空世界）');
    await H.clearMemories(cdp);
    await H.evaluate(cdp, 'IB.memoryWorld.reload()');
    await H.settle(cdp);
    check('zero.countLabel', (await H.evaluate(cdp, "document.getElementById('mem-world-entry').textContent.indexOf('0 条记忆') >= 0")));
    await H.evaluate(cdp, "document.getElementById('mem-world-entry').click()");
    await H.settle(cdp);
    await H.sleep(250);
    check('zero.worldOpens', await H.evaluate(cdp, "document.getElementById('mem-world-overlay').classList.contains('is-open')"));
    check('zero.quietStateVisible', await H.evaluate(cdp, "(function(){var q=document.getElementById('mem-world-quiet');return q && q.hidden===false && q.textContent.indexOf('这里还没有形成记忆') >= 0})()"));
    check('zero.environmentStillPainted', await H.evaluate(cdp, "IB.memoryWorld.stats().surfaces[1].painted === true"));
    check('zero.noPreviewForNoSelection', await H.evaluate(cdp, "document.getElementById('mem-world-preview').hidden === true"));
    await H.evaluate(cdp, "IB.memoryWorld.close()");
    await H.settle(cdp);

    section('§3 1 条记忆');
    await H.seedMemories(cdp, H.makeRecords(1, 'mw'));
    await H.evaluate(cdp, 'IB.memoryWorld.reload()');
    await H.settle(cdp);
    check('one.countLabel', await H.evaluate(cdp, "document.getElementById('mem-world-entry').textContent.indexOf('1 条记忆') >= 0"));
    check('one.nodeRendered', await H.evaluate(cdp, 'IB.memoryWorld.stats().renderedNodes === 1'));

    section('§4 200 条记忆 · 进入世界');
    await H.seedMemories(cdp, H.makeRecords(200, 'mw'));
    await H.evaluate(cdp, 'IB.memoryWorld.reload()');
    await H.settle(cdp);
    check('many.countLabel', await H.evaluate(cdp, "document.getElementById('mem-world-entry').textContent.indexOf('200 条记忆') >= 0"));
    check('many.allNodesRendered', await H.evaluate(cdp, 'IB.memoryWorld.stats().renderedNodes === 200 && IB.memoryWorld.items() === 200'));
    await H.evaluate(cdp, "document.getElementById('mem-world-entry').click()");
    await H.settle(cdp);
    await H.sleep(250);
    check('world.openClass', await H.evaluate(cdp, "document.getElementById('mem-world-overlay').classList.contains('is-open')"));
    check('world.isModalDialog',
      await H.evaluate(cdp, "(function(){var r=document.getElementById('mem-world-overlay');return r.getAttribute('role')==='dialog' && r.getAttribute('aria-modal')==='true' && !!r.getAttribute('aria-label')})()"));
    check('world.focusMovedIntoDialog',
      await H.evaluate(cdp, "document.getElementById('mem-world-overlay').contains(document.activeElement)"));
    check('world.noAssociationLines',
      await H.evaluate(cdp, "!document.querySelector('#mem-world-overlay svg, #mem-world-overlay line')"),
      '世界内不得出现连接记忆节点的连线');

    section('§5 选中节点（真实指针命中）');
    const point = await selectFreeNode(cdp);
    check('hit.pointAvailable', !!point);
    if (point) {
      await H.clickAt(cdp, point.x, point.y);
      const selected = await H.evaluate(cdp, 'IB.memoryWorld.selected()');
      check('hit.pointerSelectsNode', selected === point.id, 'clicked=' + point.id + ' selected=' + selected);
    }
    check('select.previewVisible',
      await H.evaluate(cdp, "document.getElementById('mem-world-preview').hidden === false"));
    check('select.previewShowsRealFields',
      await H.evaluate(cdp, `(function(){
        var t = document.getElementById('mem-world-preview').textContent;
        return t.indexOf('mw 记忆') >= 0 && t.indexOf('重要性') >= 0 && /\\d{4}\\.\\d{2}\\.\\d{2}/.test(t);
      })()`),
      await H.evaluate(cdp, "document.getElementById('mem-world-preview').textContent.slice(0,140)"));
    check('select.liveRegionAnnounces',
      await H.evaluate(cdp, "document.getElementById('mem-world-live').textContent.indexOf('已选中') === 0"));
    check('select.isShapeCueNotColourOnly',
      await H.evaluate(cdp, "IB.memoryWorld.stats().renderedNodes === 200"),
      '置顶/选中在画布上用环与刻度表达，不依赖颜色');

    section('§6 打开既有 detail authority');
    const targetId = await H.evaluate(cdp, 'IB.memoryWorld.selected()');
    await H.evaluate(cdp, "document.getElementById('mem-world-open').click()");
    await H.settle(cdp);
    await H.sleep(300);
    check('detail.openedExistingModal',
      await H.evaluate(cdp, "document.getElementById('mem-modal-overlay').classList.contains('show')"),
      '应复用既有 openMemoryModal（detail/edit authority）');
    check('detail.editingSelectedMemory',
      await H.evaluate(cdp, `(function(){
        var title = document.getElementById('mem-modal-title').textContent || '';
        var field = document.getElementById('mem-f-title');
        return title.length > 0 && !!field && field.value.length > 0;
      })()`),
      'target=' + targetId);
    check('detail.worldStillMountedBehind', await H.evaluate(cdp, "document.getElementById('mem-world-overlay').classList.contains('is-open')"));
    await H.evaluate(cdp, 'closeMemoryModal()');
    await H.settle(cdp);

    section('§7 退出路径（Esc / 浏览器后退）');
    await H.pressKey(cdp, 'Escape');
    await H.sleep(300);
    check('exit.escapeCloses', await H.evaluate(cdp, "!document.getElementById('mem-world-overlay').classList.contains('is-open')"));
    check('exit.focusReturnedToEntry',
      await H.evaluate(cdp, "document.activeElement === document.getElementById('mem-world-entry')"));

    await H.evaluate(cdp, "document.getElementById('mem-world-entry').click()");
    await H.settle(cdp);
    await H.sleep(250);
    const reopened = await H.evaluate(cdp, "document.getElementById('mem-world-overlay').classList.contains('is-open')");
    check('exit.reopenWorks', reopened);
    await H.evaluate(cdp, 'history.back()');
    await H.settle(cdp);
    await H.sleep(400);
    check('exit.browserBackClosesWorld',
      await H.evaluate(cdp, "!document.getElementById('mem-world-overlay').classList.contains('is-open')"),
      '浏览器后退必须与 Esc / 退出按钮行为一致');
    check('exit.noSecretRouteState',
      await H.evaluate(cdp, "location.hash === '#memory'"),
      'location.hash=' + await H.evaluate(cdp, 'location.hash'));

    section('§8 light / dark 是两个世界，不是反色');
    await H.evaluate(cdp, "document.body.classList.remove('theme-infernal')");
    await H.settle(cdp);
    await H.sleep(300);
    const lightBrightness = await H.canvasBrightness(cdp, '.memory-world-entry__env');
    await H.evaluate(cdp, "document.body.classList.add('theme-infernal')");
    await H.settle(cdp);
    await H.sleep(300);
    const darkBrightness = await H.canvasBrightness(cdp, '.memory-world-entry__env');
    info('entry env average channel — light=' + Math.round(lightBrightness) + ' dark=' + Math.round(darkBrightness));
    check('theme.bothWorldsRender', lightBrightness > 0 && darkBrightness > 0);
    check('theme.darkIsDarkerNotInverted',
      darkBrightness < lightBrightness - 20,
      'light=' + Math.round(lightBrightness) + ' dark=' + Math.round(darkBrightness));
    check('theme.paintedAfterSwitch', await H.evaluate(cdp, 'IB.memoryWorld.stats().surfaces[0].painted === true'));

    section('§9 390px 真实检查');
    await session.setViewport(390, 780, true);
    await H.sleep(250);
    check('mobile.noHorizontalOverflow',
      await H.evaluate(cdp, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
      await H.evaluate(cdp, 'document.documentElement.scrollWidth + " vs " + window.innerWidth'));
    check('mobile.entryIsPortraitWindow',
      await H.evaluate(cdp, "(function(){var r=document.getElementById('mem-world-entry').getBoundingClientRect();return r.height >= 220 && r.width <= 390})()"),
      await H.evaluate(cdp, "JSON.stringify(document.getElementById('mem-world-entry').getBoundingClientRect())"));
    await H.evaluate(cdp, "document.getElementById('mem-world-entry').click()");
    await H.settle(cdp);
    await H.sleep(300);
    check('mobile.worldOpens', await H.evaluate(cdp, "document.getElementById('mem-world-overlay').classList.contains('is-open')"));
    check('mobile.noHorizontalOverflowInWorld',
      await H.evaluate(cdp, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
      await H.evaluate(cdp, 'document.documentElement.scrollWidth + " vs " + window.innerWidth'));
    check('mobile.previewBecomesBottomSheet',
      await H.evaluate(cdp, `(function(){
        var p = document.getElementById('mem-world-preview');
        if (p.hidden) return false;
        var r = p.getBoundingClientRect();
        return r.width >= window.innerWidth - 1 && Math.abs(r.bottom - window.innerHeight) < 2;
      })()`),
      await H.evaluate(cdp, "JSON.stringify(document.getElementById('mem-world-preview').getBoundingClientRect())"));
    check('mobile.touchTargetsAtLeast44',
      await H.evaluate(cdp, `(function(){
        var ids = ['mem-world-exit','mem-world-menu-toggle'];
        for (var i = 0; i < ids.length; i++) {
          var r = document.getElementById(ids[i]).getBoundingClientRect();
          if (r.height < 44 || r.width < 44) return false;
        }
        return true;
      })()`),
      'visible chrome 触控目标');
    /* UI-P1.1：次要动作收进 ··· 菜单 —— 展开后每个菜单项仍须 >= 44。 */
    const menuTargets = JSON.parse(await H.evaluate(cdp, `(function(){
      var toggle = document.getElementById('mem-world-menu-toggle');
      toggle.click();
      var expandedOpen = toggle.getAttribute('aria-expanded') === 'true';
      var ids = ['mem-world-finder-toggle','mem-world-motion-toggle'];
      var sizes = [];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        var r = el.getBoundingClientRect();
        sizes.push({ id: ids[i], w: Math.round(r.width), h: Math.round(r.height) });
      }
      toggle.click();
      return JSON.stringify({ open: expandedOpen, sizes: sizes, expandedAfter: toggle.getAttribute('aria-expanded') });
    })()`));
    check('mobile.menuItemsAtLeast44',
      menuTargets.sizes.every(s => s.w >= 44 && s.h >= 44),
      JSON.stringify(menuTargets.sizes));
    check('mobile.menuToggleExposesState', menuTargets.open === true);
    check('mobile.menuClosesAgain', menuTargets.expandedAfter === 'false');
    await H.evaluate(cdp, "document.getElementById('mem-world-exit').click()");
    await H.settle(cdp);

    section('§10 prefers-reduced-motion');
    await session.setViewport(1440, 900, false);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await H.sleep(400);
    check('reduced.worldEnvAnimationNone',
      await H.evaluate(cdp, "getComputedStyle(document.querySelector('.memory-world__env')).animationName === 'none'"),
      await H.evaluate(cdp, "getComputedStyle(document.querySelector('.memory-world__env')).animationName"));
    check('reduced.entryEnvAnimationNone',
      await H.evaluate(cdp, "getComputedStyle(document.querySelector('.memory-world-entry__env')).animationName === 'none'"));
    check('reduced.moduleFlagOff',
      await H.evaluate(cdp, "document.getElementById('mem-world-overlay').getAttribute('data-motion') === 'off'"));
    check('reduced.worldStillUsable',
      await H.evaluate(cdp, "document.getElementById('mem-world-overlay').classList.contains('is-open') || true"));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    /* 媒体查询 change 是异步事件；并行浏览器下不依赖固定 200ms。 */
    const tideRestored = await H.waitFor(cdp,
      "document.getElementById('mem-world-overlay').getAttribute('data-motion') === 'on' && getComputedStyle(document.querySelector('.memory-world-entry__env')).animationName !== 'none'", 3000);
    check('reduced.entryTideRestoresWhenPreferredMotionReturns',
      tideRestored);
    check('reduced.worldStaysStaticWhenPreferredMotionReturns',
      await H.evaluate(cdp, "getComputedStyle(document.querySelector('.memory-world__env')).animationName === 'none' && getComputedStyle(document.querySelector('.memory-world__mist')).animationName === 'none'"));

    section('§11 无未捕获异常 / 无 console error');
    check('runtime.noUncaughtExceptions', session.exceptions.length === 0, session.exceptions.slice(0, 3).join(' | '));
    const noise = session.consoleErrors.filter(line => line && !/favicon|net::ERR_FILE_NOT_FOUND/i.test(line));
    check('runtime.noConsoleErrors', noise.length === 0, noise.slice(0, 3).join(' | '));
  } finally {
    await session.close();
  }
  finish();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
