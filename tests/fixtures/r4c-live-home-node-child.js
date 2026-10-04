'use strict';
/* ====================================================================
   R4-C LIVE · CDP 浏览器边界 smoke 的 **Home Node 子进程**夹具
   （LIVE-2.1 建立，LIVE-3 增补 canonical 种子）
   --------------------------------------------------------------------
   运行：由 tests/test_r4c_live_browser_boundary.js `spawn`（不单独运行）。
   环境：IB_R4C_DATA_DIR / IB_R4C_CREDENTIAL_DIR / IB_R4C_TOKEN / IB_R4C_PORT
         IB_R4C_INJECT_COST_POLICY（'1' 才注入成本闸门；缺省 = 生产默认：关）
         IB_R4C_CANONICAL_ROWS（JSON 数组：要种进**真实** memory store 的行）

   ── 它为什么必须是一个**文件**而不是 `node -e` ─────────────────────────
   `node -e` 的引号转义会让"这个子进程到底跑了什么装配"变成一段读不出形状的
   字符串；而这条 smoke 的**全部意义**就是"页面看到一个**真实装配**的节点"。
   放进 tests/fixtures/ 之后，装配参数是一份可读、可评审的文件。

   ── 它**是**真的什么 ────────────────────────────────────────────────
     · 真实 services/home-node-service.js 的 buildHomeNode()（同一个装配函数，
       与 tests/test_mobile_p0_continuity.js 等既有 HTTP 验收用的是同一条路径）；
     · 真实 SQLite store / 真实设备注册表 / 真实 Vault 取用 / 真实 NodeModelPort；
     · 真实 HTTP 服务，监听 127.0.0.1 上的显式端口。
   成本闸门**只有**父进程显式注入时才开（装配事实），因为 production
   require.main 路径**刻意**没有任何启用旋钮（F8：本阶段不存在生产启用路径）。

   ── P21-R4-C-LIVE-3：canonical 行由**这里**种，不由浏览器送 ─────────────
   浏览器只提交 selectedMemoryIds；服务端从 canonical store 取正文。
   因此这条 E2E 要能成立，store 里必须**真的**有那些行 —— 种子归测试所有
   （IB_R4C_CANONICAL_ROWS 由父进程给出），而**写入**只发生在这个夹具里：
   它是这一轮唯一的 store 写者，于是"模型读到的正文来自 store"这句话
   有一个可核对的来源。种子在 listen **之前**写完，所以节点对外服务时
   它的 canonical 世界已经确定。

   ── 它**不**碰什么 ──────────────────────────────────────────────────
     · 不读 %LOCALAPPDATA%：两个目录都由环境变量显式给出，并且同时把
       IB_HOME_NODE_DATA_DIR / IB_CREDENTIAL_DATA_DIR 设成它们 —— 模块顶层
       `resolveDesktopCredential()` 也是按这两个变量决定数据目录的，
       因此连"装配期的副作用"都落在临时目录里（生产数据目录一个字节不动）。
       ★ 这一点还由下面那条硬门守着：两个目录不在 os.tmpdir() 下就拒绝启动。
     · 不写任何产品文件、不注册任何路由（require 该模块不会 listen：
       它是 require.main-guarded 的）。

   ── 就绪协议（父进程据此断言闸门真的开着、种子真的落了）────────────────
     stdout 两行：
       IB-R4C-NODE-SEEDED {"count":<n>,"ids":[...],"revision":<r>}
       IB-R4C-NODE-READY  {"port":<n>,"costPolicy":{...}}
     两行都取自**子进程自己**（store 的写入返回值 / describe()），
     而不是父进程对环境的猜测。
   ==================================================================== */

const os = require('os');
const path = require('path');

const SERVICE = require('../../services/home-node-service.js');

const dataDir = String(process.env.IB_R4C_DATA_DIR || '').trim();
const credentialDir = String(process.env.IB_R4C_CREDENTIAL_DIR || process.env.IB_R4C_DATA_DIR || '').trim();
const token = String(process.env.IB_R4C_TOKEN || '').trim();
const port = Number(process.env.IB_R4C_PORT);
/* 成本闸门的注入必须是**显式**的（P21-R4-C-LIVE-3 冻结项：本阶段**没有**
   生产启用路径）。父进程不给这个变量 ⇒ 与生产一致：闸门关着，服务回答
   503 disabled。夹具因此既能构造"闸门开"的形态，也不会把"开着"变成默认。 */
const injectCostPolicy = String(process.env.IB_R4C_INJECT_COST_POLICY || '') === '1';
/* 要种进**真实** canonical store 的记忆行（JSON 数组）：id / title / content /
   visibility 由父进程给出。E2E 的关键正是"模型读到的正文来自这里，
   而不是来自浏览器" —— 因此这些常量归测试所有，夹具只负责**写进 store**。 */
let seedRows = [];
try { seedRows = JSON.parse(String(process.env.IB_R4C_CANONICAL_ROWS || '[]')); } catch (_) { seedRows = null; }

if (!dataDir || !credentialDir || !token || !(port > 0)) {
  console.error('IB-R4C-NODE-FAILED missing IB_R4C_DATA_DIR / IB_R4C_CREDENTIAL_DIR / IB_R4C_TOKEN / IB_R4C_PORT');
  process.exit(2);
}
if (!Array.isArray(seedRows)) {
  console.error('IB-R4C-NODE-FAILED IB_R4C_CANONICAL_ROWS must be a JSON array');
  process.exit(2);
}
/* ★ 环境隔离的第二道锁：这个子进程只允许在系统临时目录里工作。
   它是一次 E2E 夹具，而"夹具指错目录"的唯一后果是**生产数据被写** ——
   那是不该靠"调用方记得传对"来防的事，因此这里硬拒绝。 */
(function guardTempOnly() {
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const inTmp = (p) => path.resolve(p).toLowerCase().indexOf(tmp) === 0;
  if (!inTmp(dataDir) || !inTmp(credentialDir)) {
    console.error('IB-R4C-NODE-FAILED refusing to run outside os.tmpdir(): ' + dataDir + ' / ' + credentialDir);
    process.exit(2);
  }
})();

/* 日志只留**事件名**：这条 smoke 不需要正文，而"少打印"本身就是一条纪律
   （服务的既有纪律是永远不把凭据/正文写进日志，这里不制造第二条通道）。 */
function childLog(level, event) {
  try { console.log('[' + String(level || 'info') + '] ' + String(event || '')); } catch (_) { /* 无 stdout */ }
}

let instance = null;
try {
  instance = SERVICE.buildHomeNode({
    dataDir: dataDir,
    credentialDataDir: credentialDir,
    token: token,
    /* 只是 /health、/status 里"这条面是哪一条"的自述；真正的监听在下面。 */
    listenPort: port,
    /* ★ 唯一的测试注入点：成本闸门（装配事实），而且只有父进程显式要求时才注入。
       不注入时服务按冻结语义回答 503 disabled —— 那是生产默认，
       也是本阶段刻意保留的默认。 */
    runtimeInterpretationPolicy: injectCostPolicy ? { memoryInterpretationEnabled: true } : undefined,
    logger: childLog
  });
  instance.open();

  /* ── 种 canonical 行（**真实** memory store，唯一写者就是这个夹具）──────
     形状与 tests/test_r4c_live_authority_truth.js 的 canonicalRecord 同款：
     它是真实 store 接受的合法记录。行在 listen **之前** 写完，因此节点对外
     服务时它的 canonical 世界已经是确定的（"服务中"不存在半个种子）。 */
  const seededIds = [];
  const now = Date.now();
  for (const row of seedRows) {
    const id = String((row && row.id) || '').trim();
    if (!id) continue;
    const record = {
      id: id,
      kind: String((row && row.kind) || 'episodic'),
      title: String((row && row.title) || ('T-' + id)),
      summary: '',
      content: String((row && row.content) || ''),
      domain: '日常', tags: [],
      valence: row && row.valence != null ? Number(row.valence) : 0.5,
      arousal: row && row.arousal != null ? Number(row.arousal) : 0.3,
      importance: 5, resolved: false,
      /* visibility 归测试所有：'public' 可读、'private' 对任何主体都不可读
         （见 memory-visibility-core 的既有语义）。 */
      visibility: String((row && row.visibility) || 'public'),
      visibleTo: [], excludeFrom: [],
      activationCount: 0,
      created: now, lastActivated: now,
      createdBy: String((row && row.createdBy) || 'user'), createdByName: '', editedByUser: false,
      consolidatedFrom: [], lastConsolidatedAt: null
    };
    const written = instance.memoryStore.putRecord(record, {});
    if (!written || written.ok !== true) {
      console.error('IB-R4C-NODE-FAILED seed failed for ' + id + ' :: ' + JSON.stringify(written));
      process.exit(5);
    }
    seededIds.push(id);
  }
  if (seededIds.length) {
    console.log('IB-R4C-NODE-SEEDED ' + JSON.stringify({ count: seededIds.length, ids: seededIds, revision: instance.memoryStore.getRevision() }));
  }
} catch (error) {
  console.error('IB-R4C-NODE-FAILED ' + String((error && (error.stack || error.message)) || error));
  process.exit(3);
}

instance.server.listen(port, '127.0.0.1', function () {
  let costPolicy = null;
  try {
    const described = instance.runtimeInterpretation && typeof instance.runtimeInterpretation.describe === 'function'
      ? instance.runtimeInterpretation.describe() : null;
    costPolicy = described && described.costPolicy ? described.costPolicy : null;
  } catch (_) { costPolicy = null; }
  console.log('IB-R4C-NODE-READY ' + JSON.stringify({ port: port, costPolicy: costPolicy }));
});

function shutdown() {
  try { instance.close(); } catch (_) { /* 已关闭 */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', function (error) {
  console.error('IB-R4C-NODE-CRASHED ' + String((error && (error.stack || error.message)) || error));
  process.exit(4);
});
