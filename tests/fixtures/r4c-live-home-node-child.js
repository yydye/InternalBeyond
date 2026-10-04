'use strict';
/* ====================================================================
   R4-C LIVE-2.1 · CDP 浏览器边界 smoke 的 **Home Node 子进程**夹具
   --------------------------------------------------------------------
   运行：由 tests/test_r4c_live_browser_boundary.js `spawn`（不单独运行）。
   环境：IB_R4C_DATA_DIR / IB_R4C_CREDENTIAL_DIR / IB_R4C_TOKEN / IB_R4C_PORT

   ── 它为什么必须是一个**文件**而不是 `node -e` ─────────────────────────
   `node -e` 的引号转义会让"这个子进程到底跑了什么装配"变成一段读不出形状的
   字符串；而这条 smoke 的**全部意义**就是"页面看到一个**真实装配**的节点"。
   放进 tests/fixtures/ 之后，装配参数是一份可读、可评审的文件。

   ── 它**是**真的什么 ────────────────────────────────────────────────
     · 真实 services/home-node-service.js 的 buildHomeNode()（同一个装配函数，
       与 tests/test_mobile_p0_continuity.js 等既有 HTTP 验收用的是同一条路径）；
     · 真实 SQLite store / 真实设备注册表 / 真实 Vault 取用 / 真实 NodeModelPort；
     · 真实 HTTP 服务，监听 127.0.0.1 上的显式端口。
   唯一被注入的是 **成本闸门**（runtimeInterpretationPolicy）：它是装配事实，
   而 production require.main 路径**刻意**没有任何启用旋钮（F8：本阶段不存在
   生产启用路径）。因此"打开它"只能发生在这里 —— 一个测试夹具里。

   ── 它**不**碰什么 ──────────────────────────────────────────────────
     · 不读 %LOCALAPPDATA%：两个目录都由环境变量显式给出，并且同时把
       IB_HOME_NODE_DATA_DIR / IB_CREDENTIAL_DATA_DIR 设成它们 —— 模块顶层
       `resolveDesktopCredential()` 也是按这两个变量决定数据目录的，
       因此连"装配期的副作用"都落在临时目录里（生产数据目录一个字节不动）。
     · 不写任何产品文件、不注册任何路由（require 该模块不会 listen：
       它是 require.main-guarded 的）。

   ── 就绪协议（父进程据此断言闸门真的开着）────────────────────────────
     stdout 一行：
       IB-R4C-NODE-READY {"port":<n>,"costPolicy":{"memoryInterpretationEnabled":true,...}}
     这一行取自**子进程自己**的 runtimeInterpretation.describe()，而不是父进程
     对环境的猜测 —— 于是"闸门开着"是节点自己的自述。
   ==================================================================== */

const SERVICE = require('../../services/home-node-service.js');

const dataDir = String(process.env.IB_R4C_DATA_DIR || '').trim();
const credentialDir = String(process.env.IB_R4C_CREDENTIAL_DIR || process.env.IB_R4C_DATA_DIR || '').trim();
const token = String(process.env.IB_R4C_TOKEN || '').trim();
const port = Number(process.env.IB_R4C_PORT);

if (!dataDir || !credentialDir || !token || !(port > 0)) {
  console.error('IB-R4C-NODE-FAILED missing IB_R4C_DATA_DIR / IB_R4C_CREDENTIAL_DIR / IB_R4C_TOKEN / IB_R4C_PORT');
  process.exit(2);
}

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
    /* ★ 唯一的测试注入点：成本闸门（装配事实）。没有它，服务按冻结语义
       回答 503 disabled —— 那是生产默认，也是本阶段刻意保留的默认。 */
    runtimeInterpretationPolicy: { memoryInterpretationEnabled: true },
    logger: childLog
  });
  instance.open();
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
