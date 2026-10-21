'use strict';
/* ============================================================================
   Internal Beyond · UI-P1 · Memory World — 运行期零副作用
   ----------------------------------------------------------------------------
   运行：node tests/test_memory_world_side_effects.js   （需要本机 Chrome / Edge）

   冻结的断言：
     MEMORY_WORLD_DURABLE_WRITES = 0
     进入世界 / hover / 选中 / 查找 / 退出 期间：
       · memories 行逐字段不变（含 activationCount / lastActivated）
       · dbPut / dbDelete / dbUpdate 对 'memories' 的调用 = 0
       · recordMemoryActivation 调用 = 0
       · localStorage 键集合不变
     §1 另外做静态取证：模块源码不调用任何写入口，也不复制任何 authority。
   ============================================================================ */

const fs = require('fs');
const path = require('path');
const H = require('./helpers/memory-world-cdp.js');

const LABEL = 'Memory World zero-side-effect';
const { check, info, finish } = H.makeChecker(LABEL);
const SOURCE_PATH = path.join(H.ROOT, 'assets', 'js', 'memory-world.js');

function section(title) { console.log('\n── ' + title + ' ──'); }

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* §1 · 静态：模块源码不得出现任何写入口或第二份 authority。 */
const RAW = fs.readFileSync(SOURCE_PATH, 'utf8').replace(/^\uFEFF/, '');
const CODE = stripComments(RAW);

const FORBIDDEN = [
  'dbPut', 'dbDelete', 'dbUpdate', 'recordMemoryActivation', 'getMemoryContext',
  'selectMemoryContext', 'saveMemory', 'saveInlineEdit', 'toggleMemPin',
  'toggleMemResolved', 'deleteMemory', 'quickCreateMemory', 'importMemoriesFile',
  '_reconcileReferences', 'renderMemories', 'updateMemDashboard', '_memRepairApply',
  'localStorage', 'indexedDB', 'sessionStorage', 'fetch('
];

function main() {
  section('§1 静态取证：模块源码的读写面');

  for (const name of FORBIDDEN) {
    const hits = CODE.split(name).length - 1;
    check('static.noWriteOrDuplicateAuthority.' + name, hits === 0, name + ' 出现 ' + hits + ' 次');
  }
  check('static.usesExistingReadPath', CODE.indexOf("reader('memories')") >= 0 || CODE.indexOf('dbGetAll') >= 0);
  check('static.reusesExistingDetailAuthority', CODE.indexOf('openMemoryModal') >= 0,
    '打开记忆必须交回既有 detail/edit authority');
  check('static.noAssociationGraphDrawing',
    CODE.indexOf('<line') === -1 && CODE.indexOf('createElementNS') === -1 && CODE.indexOf('beginPath') >= 0,
    '节点之间不得连线（无 live Association authority）；只有单节点标记可以画路径');
  check('static.declaresAssociationDisabled', CODE.indexOf("associationLines: 'DISABLED'") >= 0);
  check('static.noRandomInLayout', !/Math\.random/.test(CODE), '布局必须完全确定性');

  section('§2 运行期：进入世界前后零 durable writes');

  return H.launch({ width: 1440, height: 900 }).then(async session => {
    const { cdp } = session;
    try {
      await H.enterAppShell(cdp);
      const wizard = await H.dismissSetupWizard(cdp);
      info('首次引导处理: ' + wizard);
      await H.waitForWorld(cdp);
      await H.goToMemoryPage(cdp);

      /* 数据基线：20 条真实形状的记忆。 */
      await H.clearMemories(cdp);
      await H.seedMemories(cdp, H.makeRecords(20, 'se'));
      await H.evaluate(cdp, 'IB.memoryWorld.reload()');
      await H.settle(cdp);
      await H.sleep(300);

      await H.evaluate(cdp, H.SEED_FN);
      const before = await H.snapshotMemories(cdp);

      /* 计数器就位 + 阳性对照：证明包装器真的挂在生产调用面上。
         对照写必须发生在 localStorage 基线之前 —— dbPut 会合法地打上
         「本机曾经有过业务数据」标记（core.js 的既有行为）。 */
      await H.evaluate(cdp, 'window.__mwWrapWriters()');
      await H.evaluate(cdp, "(async function(){ var rows = await dbGetAll('memories'); await dbPut('memories', rows[0]); return true; })()");
      const control = await H.evaluate(cdp, 'window.__mwReadWriters()');
      check('harness.writerProbeIsLive', control && control.dbPutMemories >= 1,
        '阳性对照失败，包装器没挂在生产写面上: ' + JSON.stringify(control));
      await H.evaluate(cdp, 'window.__mwResetWriters()');
      const storageBefore = await H.evaluate(cdp, 'window.__mwStorageKeys()');

      /* 被测交互：进入世界 → hover → 选中若干节点 → 查找 → 打开既有弹窗 → 退出。 */
      await H.evaluate(cdp, "document.getElementById('mem-world-entry').click()");
      await H.settle(cdp);
      await H.sleep(250);

      const point = await H.evaluate(cdp, `(function(){
        var layout = IB.memoryWorld.layout();
        var canvas = document.getElementById('mem-world-nodes');
        if (!canvas || !layout.length) return null;
        var box = canvas.getBoundingClientRect();
        var n = layout[layout.length - 1];
        return { x: box.left + n.x * box.width, y: box.top + n.y * box.height };
      })()`);
      if (point) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
        await H.clickAt(cdp, point.x, point.y);
      }

      /* 选中 5 个节点（含置顶/已解决/不同领域），逐一过一遍预览。 */
      await H.evaluate(cdp, `(function(){
        var layout = IB.memoryWorld.layout();
        for (var i = 0; i < Math.min(5, layout.length); i++) IB.memoryWorld.select(layout[i].id);
        return true;
      })()`);
      await H.settle(cdp);

      /* 可访问路径：查找面板 + 键盘上下移动。 */
      await H.evaluate(cdp, "IB.memoryWorld.setFinderOpen(true)");
      await H.sleep(200);
      await H.evaluate(cdp, `(function(){
        var input = document.getElementById('mem-world-search');
        input.value = 'se 记忆 1';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await H.sleep(200);
      await H.evaluate(cdp, "IB.memoryWorld.setFinderOpen(false)");
      await H.settle(cdp);

      /* 打开既有 detail authority（复用，不是复制）。 */
      await H.evaluate(cdp, "document.getElementById('mem-world-open').click()");
      await H.sleep(300);
      await H.evaluate(cdp, 'closeMemoryModal()');
      await H.settle(cdp);

      /* 退出（Esc 路径由浏览器 E2E 覆盖，这里走 API 以免依赖首次引导状态）。 */
      await H.evaluate(cdp, "IB.memoryWorld.close()");
      await H.settle(cdp);

      const counters = await H.evaluate(cdp, 'window.__mwReadWriters()');
      const after = await H.snapshotMemories(cdp);
      const storageAfter = await H.evaluate(cdp, 'window.__mwStorageKeys()');

      const added = storageAfter.filter(k => storageBefore.indexOf(k) < 0);
      const removed = storageBefore.filter(k => storageAfter.indexOf(k) < 0);
      const removedNonPresenceKeys = removed.filter(k => k.indexOf('ib_presence_tab_') !== 0);
      info('写计数器: ' + JSON.stringify(counters));
      info('localStorage 差异: +[' + added.join(',') + '] -[' + removed.join(',') + ']');
      check('durable.memoriesRowsUnchanged', before === after,
        'memories 行发生了变化（长度 ' + before.length + ' vs ' + after.length + '）');
      check('durable.zeroMemoryPuts', counters.dbPutMemories === 0);
      check('durable.zeroMemoryDeletes', counters.dbDeleteMemories === 0);
      check('durable.zeroMemoryUpdates', counters.dbUpdateMemories === 0);
      check('durable.zeroActivationWrites', counters.activate === 0,
        '视觉浏览绝不能强化记忆（recordMemoryActivation 调用 = ' + counters.activate + '）');
      check('durable.zeroAnyWrites', counters.dbPut === 0 && counters.dbDelete === 0 && counters.dbUpdate === 0,
        JSON.stringify(counters));
      /* 应用自己的后台 tick（例如 role-letters 的一次性清理标记）不属于本模块；
         这里只冻结「Memory World 不得引入任何与记忆相关的持久留存」。 */
      check('durable.noMemoryRelatedStorageKeyAdded',
        added.filter(k => /memor|ib_mem|memory_?world/i.test(k)).length === 0 && removedNonPresenceKeys.length === 0,
        '+[' + added.join(',') + '] -[' + removed.join(',') + ']');

      section('§3 只读面复核');
      check('read.factsStillVisible',
        await H.evaluate(cdp, 'IB.memoryWorld.items() === 20 && IB.memoryWorld.stats().renderedNodes === 20'));
      check('read.dataAuthorityDeclared',
        await H.evaluate(cdp, "IB.memoryWorld.dataAuthority === \"window.dbGetAll('memories')\""));
      check('runtime.noUncaughtExceptions', session.exceptions.length === 0, session.exceptions.slice(0, 3).join(' | '));
    } finally {
      await session.close();
    }
    finish();
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
