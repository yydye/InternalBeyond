'use strict';

/*
 * Internal Beyond — Home Node (canonical chat authority)
 *
 * M1-A：这个进程是 chatMessages 的 canonical authority。
 * The browser still executes its own chat orchestration on the desktop surface;
 * what moves here is **authority over the world's chat records**, not the desktop
 * UI. See docs/HOME_NODE_CHAT.md for the full authority/mirror/fallback model.
 *
 * 与其它本地服务的边界（刻意如此）：
 *   · 默认只绑 127.0.0.1（IB_HOME_NODE_HOST 可覆盖）；
 *   · 不 require bridge/routes.js，因此没有 /api/llm-proxy、没有工具表、没有支付；
 *   · 设备身份与配对在 services/home-node/device-registry.js，
 *     传输在 services/home-node/mobile-gateway.js —— 本文件只负责装配。
 *
 * LAN 姿态（M1-C blocker 修复）：`allowRemote` **不再**是一个可以随手打开的
 * 布尔开关，而是一条被验证的谓词：显式非 loopback 绑定 **且** 设备鉴权此刻
 * 真的就绪（见 deviceAuthReady）。默认（HOST=127.0.0.1）永远 loopback-only。
 *
 * 存储：%LOCALAPPDATA%\InternalBeyond\home-node\home-node.db（node:sqlite，零 npm 依赖）。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const createStore = require('../services/home-node/chat-store.js');
const createMemoryStore = require('../services/home-node/memory-store.js');
const createMemoryRetrieval = require('../services/home-node/memory-retrieval.js');
const { createRecallSessionState } = require('../assets/js/memory-recall/recall-session-state.js');
/* M1-C.2m：canonical Understanding 的三个组件（store / 取回 / 派生）。 */
const createUnderstandingStore = require('../services/home-node/understanding-store.js');
const createUnderstandingDerivation = require('../services/home-node/understanding-derivation.js');
const createUnderstandingRetrieval = require('../services/home-node/understanding-retrieval.js');
/* M1-C.2k：线索（open thread）的派生器 —— 与记忆共用 canonical memory store。 */
const createThreadRetrieval = require('../services/home-node/thread-retrieval.js');
/* M1-C.2n：canonical Moments 的两个组件（store / 取回）。
   ACL 与渲染都在浏览器共用的 moments-visibility-core 里，所以这里没有第三个组件。 */
const createMomentsStore = require('../services/home-node/moments-store.js');
const createMomentsRetrieval = require('../services/home-node/moments-retrieval.js');
const createHttp = require('../services/home-node/http.js');
const createExecutor = require('../services/home-node/execution.js');
const createDeviceRegistry = require('../services/home-node/device-registry.js');
const createMobileGateway = require('../services/home-node/mobile-gateway.js');
/* P22-2：Agent Economy 的第一块 canonical runtime（SQLite Ledger + 派生
   Wallet 余额）。**唯一** require 点是这里 —— Economy 自己不 require
   本文件、不 require 网关、不 require 设备注册表，方向是单向的。 */
const createEconomyStore = require('../services/home-node/economy-store.js');
/* P22-9：Economy 的准入门（**唯一**一个）。它**不是** store 的一部分 ——
   门长在 store 上面，因此 P22-6 ~ P22-8 的 canonical ownership 一行不改。
   与 createEconomyStore 同款：**只有**这一处 require 它。 */
const createEconomyCapabilityGate = require('../services/home-node/economy-capability.js');
/* P22-10：Economy 的 **Action Adapter** —— Agent / Action runtime 与整个
   经济域之间的**唯一**界面。它与上面两个同款：**只有**这一处 require 它，
   而且它 require 的仍是那份已有的契约（依赖闭包没有变宽）。
   ★ 这里只取 bindActiveAgentEconomyAdapter（装配助手）：全仓库唯一一次
   `gate.bind(consumer)` 就发生在它里面，而 consumer 身份写在适配器旁边。 */
const economyActionAdapterModule = require('../services/home-node/economy-action-adapter.js');
/* P22-11：Economy 的 **Command Channel** —— Active（23114）与 Home Node
   （23118）之间唯一的 command 面。与前面三个文件同款：**只有**装配层
   require 它，而它 require 的目标仍然只有那份契约（依赖闭包不再变宽）。
   ★ 通道是**第五**个文件，理由与第四个逐字同构：它必须长在适配器上面。
     把 handler 写进 http.js 会让"这条路径能做什么"分散在路由层里，而
     写进适配器就是把传输混进动作层。§1 还逐字要求"能复用就复用" ——
     它复用的正是 http.js 既有的 transport（loopback + 凭据 + 信封 +
     有界 body），只新增来源登记与一条专用路径。 */
const economyCommandChannelModule = require('../services/home-node/economy-command-channel.js');
/* P22-13：Economy 的 **Approval Decision Seam** —— 用户对一条等待中的 Agent
   Intent 点头 / 摇头的**唯一生产入口**（桌面面的一条窄 POST 路径）。
   ★ 与它上面每一个模块同款：**只有**这一处 require 它。 */
const economyApprovalDecisionModule = require('../services/home-node/economy-approval-decision.js');
/* P22-14：Economy 的 **Configuration Seam** —— fresh install 在不改代码、
   不直接操作 SQLite 的前提下完成初始配置（初始 IB Credit / Budget Policy /
   Autonomy Policy）的**唯一生产入口**。
   ★ 与它上面每一个模块同款：**只有**这一处 require 它。
   ★ 它为什么是**第七**个文件、而且必须与 P22-13 分开：那一条是"用户对一条
     具体的 intent 点头/摇头"，这一条是"用户预设这台节点的钱与规则"。两者
     都是用户操作，但它们是**两种权威**；合成一条万能 user command endpoint
     会让"允许 Agent 自主花多少钱"与"批准这一笔"在审计里变成同一件事。 */
const economyConfigurationModule = require('../services/home-node/economy-configuration.js');
/* ── P21-R4-LIVE-2.1 · Runtime Interpretation —— Vault 授权、非持久化、
   受成本闸门约束的**运行时**解释执行边界。
   ★ 与它上面每一个模块同款：**只有**装配层 require 它，而它 require 的目标
     仍是既有契约（依赖闭包没有变宽）。
   ★ 它为什么必须由**装配层**构造：它的四个依赖（registry / credentialAccess /
     modelPort / costPolicy）全是装配事实；而 costPolicy 的**唯一**启用入口
     就是下面的 options.runtimeInterpretationPolicy —— 本文件不读任何 env、
     http.js 也不写任何默认值（frozen：本阶段没有生产启用路径）。 */
const createRuntimeInterpretation = require('../services/home-node/runtime-interpretation.js');
/* ── P21-R4-LIVE-4.3 · 服务端自有的**成本权威文件**（唯一生产权威）。
   只有装配层 require 它：它没有 HTTP 路由、没有 window 面、本阶段没有 Tauri
   命令；唯一写者是 Node 侧的 `set()`（见 runtime-policy.js 头部）。 */
const createRuntimePolicy = require('../services/home-node/runtime-policy.js').createRuntimePolicy;
/* ── P21-R4-LIVE-3.3 · Runtime Recall —— "这一轮想起什么"的服务端窄边界。
   ★ 与它上面每一个模块同款：**只有**装配层 require 它，而且它 require 的
     目标仍是既有实现（memory-retrieval.js + 共享可见性核），没有第二套召回。
   ★ 它为什么必须由**装配层**构造：memoryRetrieval / memoryStore / registry /
     sessionState 全是装配事实；而 glossary 条目来源按契约**只**能从装配层
     注入（request 里出现 glossary* 会被逐名拒绝）。
   ★ 它不带 modelPort、不带 credentialAccess：这条边界不出网、不读 Vault，
     因此"召回顺手调一次 provider"在依赖闭包上就不可能。 */
const createRuntimeRecall = require('../services/home-node/runtime-recall.js');
/* ── P21-R4-LIVE-5 · L5 期望运行时（**兄弟**模块，不是解释的一部分）──────
   它 require 的纯核心仍是既有实现（assets/js/memory-recall/
   expectation-shadow-core.js，UMD）+ 既有 runner —— 没有第二套期望。
   ★ 它**没有**任何返回期望正文的公开入口：外部只能看到状态/计数/延迟/原因，
     因此"没有消费者"是结构性的（见该文件头部）。 */
const createRuntimeExpectation = require('../services/home-node/runtime-expectation.js').createRuntimeExpectation;
/* ── P21-R4-F · L7 行为基调（**确定性**派生：没有模型调用、没有第三个成本位）──
   它只把已验证的 L3（且该回合 L5 已成立）投影成闭合枚举的基调，交给**下一轮**。 */
const createRuntimeBehaviorEffect = require('../services/home-node/runtime-behavior-effect.js').createRuntimeBehaviorEffect;
const createNodeModelPort = require('../active/node-model-port.js');
/* P11-3E：canonical store 失败分类器（**唯一**一份，见 runtime/db-failure.js）。
   它在 runtime/ 下，与 runtime/local-services-runner.js 那份是同一模块 ——
   "库为什么打不开"的类别不该在服务里被重新猜一遍。 */
const dbFailure = require('../runtime/db-failure.js');
/* P11-3H：合作停止面（唯一契约见 runtime/service-control.js）。 */
const serviceControl = require('../runtime/service-control.js');
/* M1-C.2i · canonical Middle Brain 的 Node 宿主适配（不是第二份实现：
   它 require assets/js 下那五层 + facade，只补宿主 shim 与配置注入）。 */
const createNodeMiddleBrain = require('../services/home-node/middle-brain.js');
/* P22-23：桌面凭据的**唯一** authority（生成 / 持久化 / 加载 / 诊断）。 */
const desktopCredential = require('../services/home-node/desktop-credential.js');
const createCredentialAccess = require('../services/home-node/credential-access.js');
/* P22-25：目录 bootstrap 的**唯一** authority（种子 / 图片引用 / 幂等键）。
   ★ 它为什么在**装配层**被 require，而不是在 http.js 里：P22-21 §9 的 T5
     逐字断言 http.js 的代码里 28 个 store 写动词零调用形态，而
     `putStore` / `putProduct` 都在那份名单上。那条不变量本阶段一字未改 ——
     因此"把第一件商品放进去"是一个装配期动作，不是一条路由。
   ★ 它的模块名里没有 "economy" 是**刻意的**：P22-1 的 B4.2 与 P22-10 的 A6
     用一份**精确的** require 白名单把"装配层能碰 Economy 的哪几个模块"
     钉死了（各六处）。目录 bootstrap 不是第七个经济 seam：它是一个消费者，
     拿到的就是已有那个 economyStore，**没有**第二个 store owner。 */
const catalogBootstrap = require('../services/home-node/catalog-bootstrap.js');

if (typeof fetch !== 'function') {
  console.error('Internal Beyond Home Node requires Node.js 18 or newer.');
  process.exit(1);
}

const HOST = String(process.env.IB_HOME_NODE_HOST || '127.0.0.1');
const PORT = Math.max(1, Math.min(65535, Number(process.env.IB_HOME_NODE_PORT) || 23118));
const DATA_DIR = process.env.IB_HOME_NODE_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond', 'home-node')
    : path.join(os.homedir(), '.internal-beyond', 'home-node'));
/* Credential Vault is shared with Active and the Tauri resolver at the app data root,
   while Home Node's SQLite stores live in the `home-node` child directory. */
const CREDENTIAL_DATA_DIR = process.env.IB_CREDENTIAL_DATA_DIR || process.env.IB_ACTIVE_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
    : path.join(os.homedir(), '.internal-beyond'));
/* ── P22-23 · 桌面凭据的**唯一** authority ────────────────────────────
   这一行以前是 `String(process.env.IB_HOME_NODE_TOKEN || '')`。那个表达式
   在产品上的后果是：普通用户装好、启动、打开 Economy，看到的是"请先设置
   环境变量"——因为**没有任何代码创造过这份凭据**，两端（服务端 env /
   浏览器 localStorage）都是空的。真正的问题不是那句提示的措辞，而是
   "凭据从来没有被创造过"。

   现在它由 services/home-node/desktop-credential.js 唯一决定，优先级
   env > 显式文件 > 数据目录内生成并持久化。env 的语义一个字没改：显式设置
   它依旧覆盖其余一切，并关闭自动 provisioning（developer / headless /
   测试的既有旋钮）。
   ★ 失败时**不退回空串**：见下面 require.main 里的硬门 —— 一个无法建立
     凭据的节点以"健康但什么都写不了"的姿态对外服务，正是本阶段要消灭的
     那种"看起来正常"的故障。 */
const CREDENTIAL = desktopCredential.resolveDesktopCredential({ dataDir: DATA_DIR });
const TOKEN = CREDENTIAL.ok ? CREDENTIAL.token : '';
const TOKEN_SOURCE = CREDENTIAL.ok ? CREDENTIAL.source : null;
/* P34.3-B · Home Node credential access (ADR P34.3-A.1 Decision 1 = Option A).
   Least-privilege allowlist = the Node's own published characters. The predicate
   is lazy because the production registry is created later in this module; it is
   only evaluated at request time. */
let productionRegistry = null;
function registryAllowsCredentialRef(reg, requestedRef) {
  const ref = String(requestedRef || '').trim();
  if (!ref || !reg || typeof reg.listCharacters !== 'function' || typeof reg.getCharacterSpec !== 'function') return false;
  try {
    return reg.listCharacters().some((character) => {
      if (!character || !character.id) return false;
      const spec = reg.getCharacterSpec(character.id);
      if (!spec || typeof spec !== 'object') return false;
      const hasRef = Object.prototype.hasOwnProperty.call(spec, 'credentialRef');
      const allowedRef = hasRef ? String(spec.credentialRef || '').trim() : String(character.id);
      return !!allowedRef && allowedRef === ref;
    });
  } catch (_) { return false; }
}
const productionCredentialAccess = createCredentialAccess({
  dataDir: CREDENTIAL_DATA_DIR,
  isAllowed: (id) => registryAllowsCredentialRef(productionRegistry, id)
});
const ALLOWED_ORIGINS = String(process.env.IB_HOME_NODE_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
/* Mobile Gateway 的额外出站 Origin 白名单。**不是**安全边界（设备 token 才是），
   只是"哪些浏览器外壳允许读响应"的兼容开关：capacitor://localhost / null /
   loopback 已经内建允许，这里用于未来真的换了壳的情况。 */
const MOBILE_ORIGINS = String(process.env.IB_HOME_NODE_MOBILE_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const SERVICE_VERSION = '1.0.0';

/* 只读探针用的版本号：与产品版本保持一致（VERSION 文件），读不到时退回服务版本。
   绝不因为版本文件缺失而拒绝启动。 */
function productVersion() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || SERVICE_VERSION; }
  catch (_) { return SERVICE_VERSION; }
}

/* ── 日志：与 local-services-runner 的 redact() 同一条纪律 ——
     apiKey / Authorization / token 一律掩码；正文永远不进日志。 ── */
function redact(text) {
  let out = String(text == null ? '' : text);
  out = out.replace(/(\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|bearer|authorization|x-ib-token|x-ib-home-token)\b\s*[:=]\s*)(['"]?)[^\s,'";]{4,}/gi,
    (m, p1, p2) => p1 + (p2 || '') + '***' + (p2 || ''));
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, '****');
  return out;
}
function log(level, event, fields) {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + event +
    (fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '');
  const safe = redact(line);
  if (level === 'error') console.error(safe); else console.log(safe);
}

/* ── 数据目录：先建目录，失败必须**明确报错**而不是静默换路径。 ── */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch (error) {
  console.error('Home Node cannot create its data directory: ' + DATA_DIR + ' — ' + (error && error.message || error));
  process.exit(1);
}

const store = createStore({ dataDir: DATA_DIR, logger: (event, fields) => log('info', event, fields) });
const port = createNodeModelPort({});
const executor = createExecutor({
  store,
  port,
  credentialAccess: productionCredentialAccess,
  logger: (event, fields) => log('info', event, fields)
});

/* ── 绑定地址判定（Phase 2/20）─────────────────────────────────────────
   **没有设备鉴权就绝不监听 LAN。** 这不是"最好别"的软约束，而是启动前的硬门：
   设备注册表必须成功打开，否则非 loopback 绑定直接拒绝启动。
   绝不静默降级成"先绑上再说" —— 那等于把一个没有身份概念的聊天库
   挂到整个局域网里。 */
function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (/^127\./.test(value)) return true;
  /* 其余一律按"非 loopback"处理（含 0.0.0.0 / :: / 具体 LAN 地址 / 主机名）。 */
  return false;
}
const LOOPBACK_BIND = isLoopbackHost(HOST);

/* ── 设备鉴权就绪判定（LAN 门的**唯一**条件）──────────────────────────
   "设备注册表已打开"是一个配置事实；"LAN 客户端真的能被认证"是一个**运行时
   能力**。这条规则保护的东西（整个聊天库 + 签发/撤销设备凭据的能力）值得
   后者被真正验证一次，而不是从前者的布尔值推断出来。

   所以探针不是"看 flag"，而是**走一遍真实鉴权路径**：拿一个格式合法但不可能
   存在的 token 去问注册表，期望得到一个明确的 AUTH_INVALID。这同时排除掉
   几种"看起来就绪其实不可用"的状态：
     · 注册表没开 → STORE_CLOSED（而不是 AUTH_INVALID）；
     · 查询路径抛错 → 抛出来（而不是静默当成"没匹配到"）；
     · 鉴权实现坏了、把陌生 token 判成有效 → ok:true（宁可拒绝服务也不放行）。

   探针用 `touch:false`：它只回答"鉴权可用吗"，不产生任何设备状态副作用。 */
const AUTH_PROBE_TOKEN = 'ibd1_probe-not-a-real-device-token-000000';
function deviceAuthReady(registry) {
  if (!registry) return { ready: false, reason: 'no-device-registry' };
  if (typeof registry.isOpen !== 'function') return { ready: false, reason: 'device-registry-invalid' };
  if (!registry.isOpen()) return { ready: false, reason: 'device-registry-not-open' };
  if (typeof registry.verifyDeviceToken !== 'function') return { ready: false, reason: 'device-auth-missing' };
  let probe = null;
  try { probe = registry.verifyDeviceToken(AUTH_PROBE_TOKEN, { touch: false }); }
  catch (error) {
    return { ready: false, reason: 'auth-probe-threw: ' + String((error && error.message) || error).slice(0, 120) };
  }
  if (!probe || probe.ok === true) return { ready: false, reason: 'auth-probe-unexpected-allow' };
  if (probe.code === 'STORE_CLOSED') return { ready: false, reason: 'device-registry-not-open' };
  if (probe.code !== 'AUTH_INVALID') return { ready: false, reason: 'auth-probe-code:' + String(probe.code) };
  return { ready: true, reason: 'device-auth-verified' };
}

/* ── LAN 主机名（配对载荷用）──────────────────────────────────────────
   只在真的绑到 LAN 时才有意义；绑 loopback 时返回空串，配对载荷会如实
   声明 lanReachable:false，而不是给一个手机永远连不上的地址。 */
function lanAddress() {
  if (LOOPBACK_BIND) return '';
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const entry of interfaces[name] || []) {
        const family = String(entry.family);
        if ((family === 'IPv4' || family === '4') && !entry.internal) return String(entry.address);
      }
    }
  } catch (_) { /* 拿不到就返回空串，绝不猜 */ }
  return '';
}

/* ── canonical memory 装配（**唯一**一处）────────────────────────────
   M1-C.2d Wave 2 的 `memories` 是**第二个 canonical 域**：它的 store 与召回器
   必须真的被交给网关，否则 /memory/* 的每一条 handler 都会走 `if (!memoryStore)`
   分支返回 501 UNSUPPORTED —— 路由存在、能力不可用。这种失败很容易被误读成
   "路由没注册"，因为两者在浏览器侧都表现为记忆镜像补不上。

   为什么必须是一个共享函数（而不是在两处各写一遍）：本仓库真实发生过一次
   drift —— `buildHomeNode()`（测试路径）传了 memoryStore/memoryRetrieval，
   而进程级 `createMobileGateway({...})`（生产启动路径）没有传。测试因此
   全绿，而 23118 上 /memory/* 不可用。**同一个域的两套装配必然漂移**，
   所以这里只保留一套，两条路径都从这里取。

   ⚠️ 顺序有语义：**先把 store 解析成最终实例，再用它构造召回器**。
   召回器如果绑的是"解析之前的那个值"，那么调用方一旦省略 memoryStore
   （buildHomeNode 的默认用法就是这样），它就会绑到一个**临时创建的第二份
   store** 上 —— 那个库能开、能查、永远返回空记录，症状是"她突然什么都不记得"。
   这条曾经被真正踩到（test_mobile_memory_continuity 的召回用例整组变空）。 */
function memoryAssembly(options) {
  options = options || {};
  const dataDir = options.dataDir || DATA_DIR;
  const serviceLog = options.logger || ((level, event, fields) => log(level, event, fields));
  const memoryStore = options.memoryStore ||
    createMemoryStore({ dataDir: dataDir, logger: (e, f) => serviceLog('info', e, f) });
  return {
    memoryStore: memoryStore,
    memoryRetrieval: options.memoryRetrieval || createMemoryRetrieval({
      store: memoryStore,
      clock: options.clock,
      random: options.random,
      logger: serviceLog
    })
  };
}
/* 缺一不可的硬校验：memoryRetrieval 没有 store 会静默召回空块
   （"她忽然不记得了"这种最难查的症状），因此宁可在这里明确失败。 */
function canonicalMemoryDeps(memory) {
  if (!memory || !memory.memoryStore) throw new Error('home-node assembly: canonical memory requires a memoryStore');
  if (!memory.memoryRetrieval) throw new Error('home-node assembly: canonical memory requires a memoryRetrieval');
  /* 反向守卫（实证过的坑）：召回器绑定的 store 必须就是这一个。
     绑到"另一个能开、能查、永远空"的实例上不会报任何错 —— 只会表现为失忆。 */
  if (memory.memoryRetrieval.store && memory.memoryRetrieval.store !== memory.memoryStore) {
    throw new Error('home-node assembly: memoryRetrieval is bound to a different memoryStore instance');
  }
  return { memoryStore: memory.memoryStore, memoryRetrieval: memory.memoryRetrieval };
}
/* 缺一不可的硬校验（与 canonicalMemoryDeps 同款）：
   线索派生器必须存在，且必须绑定**同一个** canonical memory store。
   绑到另一个能开、能查、永远返回空的实例上不会报任何错 ——
   只会表现为"她忽然什么都不惦记了"，那种 bug 无法从行为反推。
   M1-C.2k：线索没有自己的表，它与记忆共用 canonical store，
   因此这里的守卫就是"两边真的是同一个 store 实例"。 */
function canonicalThreadDeps(threads, memoryStore) {
  if (!threads.threadRetrieval) throw new Error('home-node assembly: canonical threads require a threadRetrieval');
  if (threads.threadRetrieval.store && threads.threadRetrieval.store !== memoryStore) {
    throw new Error('home-node assembly: threadRetrieval is bound to a different memoryStore instance');
  }
  return { threadRetrieval: threads.threadRetrieval };
}

/* 缺一不可的硬校验（与 canonicalThreadDeps 同款）：
   理解域的 **store / retrieval / derivation 必须绑在同一个 store 实例**上。
   这条守卫与本仓库已经吃过一次亏的 memoryRetrieval 漂移完全同形：
   绑到"另一个能开、能查、永远为空"的实例不会抛任何错，只会表现为
   "她对我的理解永远停在很久以前" —— 那种 bug 无法从行为反推。 */
function canonicalUnderstandingDeps(understanding, memoryStore) {
  const inst = understanding || {};
  if (!inst.understandingStore) throw new Error('home-node assembly: canonical understanding requires an understandingStore');
  if (inst.understandingRetrieval && inst.understandingRetrieval.store && inst.understandingRetrieval.store !== inst.understandingStore) {
    throw new Error('home-node assembly: understandingRetrieval is bound to a different understandingStore instance');
  }
  if (inst.understandingDerivation && inst.understandingDerivation.store && inst.understandingDerivation.store !== inst.understandingStore) {
    throw new Error('home-node assembly: understandingDerivation is bound to a different understandingStore instance');
  }
  /* 派生读的是 canonical memory（本阶段唯一的证据源，§5）—— 也必须是真的那一份。 */
  if (inst.understandingDerivation && inst.understandingDerivation.memoryStore && inst.understandingDerivation.memoryStore !== memoryStore) {
    throw new Error('home-node assembly: understandingDerivation is bound to a different memoryStore instance');
  }
  return inst;
}

/* ── canonical Understanding 装配（**唯一**一处）─────────────────────
   M1-C.2m：理解域有三个组件（store / retrieval / derivation），它们必须
   共享同一个 store；而 derivation 还需要 canonical memory、角色目录与
   model port。
   与 memoryAssembly 同一个理由（见其头部说明）：装配只能有一份定义。

   modelPort 可以缺席：缺席时**不**建派生器 —— 也就是"这个宿主只能读理解，
   不能推进它"。这比"建一个永远失败的派生器"诚实，也让隔离测试不必提供凭据。 */
function understandingAssembly(options) {
  options = options || {};
  const dataDir = options.dataDir || DATA_DIR;
  const serviceLog = options.logger || ((level, event, fields) => log(level, event, fields));
  const understandingStore = options.understandingStore ||
    createUnderstandingStore({ dataDir: dataDir, clock: options.clock, logger: (e, f) => serviceLog('info', e, f) });
  const understandingRetrieval = options.understandingRetrieval || createUnderstandingRetrieval({
    store: understandingStore,
    memoryStore: options.memoryStore || null,
    logger: serviceLog
  });
  /* 派生器：需要 canonical memory + 角色目录 + model port 三者齐备。
     缺任一项时如实缺席（返回 null），而不是造一个"看起来在跑"的空壳。 */
  const modelPort = options.modelPort || null;
  const understandingDerivation = options.understandingDerivation || (
    (modelPort && options.memoryStore && options.registry)
      ? createUnderstandingDerivation({
        store: understandingStore,
        memoryStore: options.memoryStore,
        registry: options.registry,
        modelPort: modelPort,
        credentialAccess: options.credentialAccess || null,
        clock: options.clock,
        logger: (e, f) => serviceLog('info', e, f)
      })
      : null
  );
  return { understandingStore: understandingStore, understandingRetrieval: understandingRetrieval, understandingDerivation: understandingDerivation };
}

/* 缺一不可的硬校验（与 canonicalUnderstandingDeps 同款）：
   Moments 的 **store / retrieval 必须绑在同一个 store 实例**上。
   绑到"另一个能开、能查、永远为空"的实例不会抛任何错，只会表现为
   "她从来不记得最近发过什么" —— 与 M1-C.2i 的 memoryRetrieval 漂移同形。 */
function canonicalMomentsDeps(moments) {
  const inst = moments || {};
  if (!inst.momentsStore) throw new Error('home-node assembly: canonical moments require a momentsStore');
  if (inst.momentsRetrieval && inst.momentsRetrieval.store && inst.momentsRetrieval.store !== inst.momentsStore) {
    throw new Error('home-node assembly: momentsRetrieval is bound to a different momentsStore instance');
  }
  return inst;
}

/* ── canonical Moments 装配（**唯一**一处）───────────────────────────
   M1-C.2n：动态域只有两个组件（store / retrieval），两者必须共享同一个
   store。与 understandingAssembly 同一个理由：装配只能有一份定义，
   生产启动路径与 buildHomeNode() 共用它，因此"某个 canonical 域没有接线"
   不可能只在一侧发生。 */
function momentsAssembly(options) {
  options = options || {};
  const dataDir = options.dataDir || DATA_DIR;
  const serviceLog = options.logger || ((level, event, fields) => log(level, event, fields));
  const momentsStore = options.momentsStore ||
    createMomentsStore({ dataDir: dataDir, clock: options.clock, logger: (e, f) => serviceLog('info', e, f) });
  /* 角色名字解析：节点侧来自 characters 表（mobile-safe DTO）。
     桌面用 apiConfigs 的 nickname||model，这里用同一个表达式，
     因此"同一份 canonical 状态 + 同一份角色目录 → 同一段文本"可以逐字比较。
     解析失败回落空串，渲染层与桌面做同样的回落（'另一角色'/'我'）。 */
  const characterNameOf = function (roleId) {
    try {
      const row = options.store && typeof options.store.getCharacter === 'function'
        ? options.store.getCharacter(String(roleId)) : null;
      const dto = (row && (row.dto || row)) || null;
      return dto ? String(dto.nickname || dto.model || '') : '';
    } catch (error) { return ''; }
  };
  const momentsRetrieval = options.momentsRetrieval || createMomentsRetrieval({
    store: momentsStore,
    logger: serviceLog,
    characterNameOf: characterNameOf
  });
  return { momentsStore: momentsStore, momentsRetrieval: momentsRetrieval };
}

/* ── canonical Economy 装配（**唯一**一处 · P22-2）────────────────────
   与 memoryAssembly / momentsAssembly 同一个理由，而且这一次尤其必要：
   P11-3X-B（memory）、M1-C.2m（understanding）、P11-3E（moments）已经
   **三次**出现同一个缺口 —— store 装配好了、网关接线了，只是
   production 的 openAll() 没打开它，于是所有直接 createXStore() 的测试
   全绿，而真实进程上那一整域不可服务。Economy 因此从第一天起就把
   "创建"与"打开"放在同一份装配定义里，两条启动路径共用它。

   ── 为什么 ownerExists 用**注入**而不是 require ──────────────────────
   wallet 的 owner 只允许引用 `characters.id`（P22 §25）。角色的 canonical
   owner 是 device-registry（它同时持有 character_runtime_specs，也就是
   角色凭据面）。Economy 因此**不 require** 它，而是在这里把一个
   "这个角色 id 存在吗"的谓词注入进去 —— 于是：
     · Economy 的依赖闭包里没有凭据面（boundary B3/B7 逐字断言这件事）；
     · "角色不存在就必须失败"仍然是真的（不自动凭空创建角色）。
   注册表**尚未**打开时谓词回答 false（fail closed），而不是抛错：
   一个未就绪的注册表不该让整个装配炸掉，而"查不到就说存在"才是最坏的。 */
function economyAssembly(options) {
  options = options || {};
  const dataDir = options.dataDir || DATA_DIR;
  const serviceLog = options.logger || ((level, event, fields) => log(level, event, fields));
  const registry = options.registry || null;
  const ownerExists = typeof options.ownerExists === 'function' ? options.ownerExists : function (party) {
    if (!party || party.type !== 'character') return true;
    try {
      if (!registry || typeof registry.getCharacter !== 'function') return false;
      if (typeof registry.isOpen === 'function' && !registry.isOpen()) return false;
      return !!registry.getCharacter(String(party.id));
    } catch (error) { return false; }
  };
  const economyStore = options.economyStore || createEconomyStore({
    dataDir: dataDir,
    clock: options.clock,
    logger: (e, f) => serviceLog('info', e, f),
    ownerExists: ownerExists,
    /* 系统铸币/销毁的授权。**只有**内部路径能调用 store 的
       mintForSystem / burnForSystem；它们是 store 的方法，不在任何 HTTP
       路由上（http.js 的 /economy/* 全是 GET）。这个谓词是第二道：
       测试显式关掉它，就能证明"即使有人把某个入口接到铸币上，
       铸币权也不会自动跟着来"。 */
    systemAuthority: typeof options.systemAuthority === 'function'
      ? options.systemAuthority
      : () => options.systemMintingEnabled !== false
  });

  /* ── P22-9 · 准入门（**唯一**一处装配）──────────────────────────────
     ★ 它为什么在**装配期**构造，而不是让每个 consumer 自己 new 一个：
       构造就是身份绑定（`bind(consumer)`）。把构造放在装配层意味着
       "这台节点上有哪些消费者、各自拿到哪个句柄"是一份**唯一的**装配
       事实，而不是分散在每个调用点上的一句自觉。

     ★ 它为什么不传进 http.js：HTTP 上的经济写面从 P22-2 起就是 0，
       把门交给路由层只会凭空多出一条需要防守的边。门的公开面只到
       buildHomeNode() 的返回值为止。

     ★ `economyCapabilityConfig` 只允许**收窄**（revokedCapabilities），
       而一个损坏的配置让整扇门 fail closed（见 economy-capability.js）。 */
  const economyCapabilityGate = options.economyGate || createEconomyCapabilityGate({
    store: economyStore,
    config: options.economyCapabilityConfig,
    logger: (e, f) => serviceLog('info', e, f)
  });

  /* ── P22-10 · Action Adapter（**唯一**一处装配 · 全仓库唯一一次 bind）──
     ★ 为什么 bind 发生在**装配层**：P22-9 说得很准 —— "构造就是身份绑定"。
       把 `gate.bind('active_agent_runtime')` 放在这里，意味着
       "这台节点上哪一个消费者真的拿到了句柄"是一份**唯一的**装配事实。
       在 P22-10 之前，这句话在 production 里是**零次**（bind 只出现在
       tests/）；本阶段让那个被声明的身份第一次真的被实例化。
     ★ 为什么只绑**一个**消费者：审计（P22-9 §1 复核）结论是 Active 是
       这个仓库里唯一一个"Agent 自己决定要不要动手"的 Node 运行时。
       Chat / Group / Voice / Diary / desktop_bridge / home_node_authority /
       MCP 一个都不绑 —— 它们作为 Node 运行时消费者**不存在**，
       凭空绑一个等于凭空发明一个已经授予的权限。
     ★ 适配器**不**交给 http.js：HTTP 上的经济写面从 P22-2 起就是 0，
       而 P22-8 逐字写着 proposeAgentPurchaseIntent 的调用方是
       Decision/Action seam，不是一个 HTTP 请求。它的公开面到此为止
       （buildHomeNode() 的返回值），与门逐字同级。 */
  const economyActionAdapter = options.economyActionAdapter
    || economyActionAdapterModule.bindActiveAgentEconomyAdapter(economyCapabilityGate);

  /* ── P22-11 · Economy Command Channel（**唯一**一处装配）──────────────
     ★ 来源登记册在这一行成形，而且只有一份：哪个 consumer 能从哪条本机
       端口提出哪种 command。它**不是**配置项 —— §3 逐字要求身份由
       "authenticated transport + registered source"确定，而"登记"
       这件事必须有一个唯一的、可核对的落点；分散到环境变量里就等于
       让身份变成运行期可改的一件东西。
     ★ token 从**部署环境**读（IB_ECONOMY_CHANNEL_TOKEN）：装配层不生成、
       不落盘、不打日志、不进返回值 —— describe() 也只有一个 hasSourceCredential
       风格的布尔（在客户端那一侧），服务端连布尔都不给。
     ★ 未配置 token ⇒ 登记册为空 ⇒ 通道**关闭**（503）。
       这不是"默认放行"，也不是一条永远失败的入口：`/security` 的
       economyPolicy.commandChannel.open 会如实报 false。
     ★ 登记项**只能**是 P22-9 契约里真实存在的 consumer id；给一个不存在的
       身份会在构造期抛（见 economy-command-channel.js 的 normalizeSources）。
       本阶段只登记**一个**来源：active_agent_runtime（P22-10 已证明它是
       这个仓库里唯一一个"Agent 自己决定要不要动手"的 Node 运行时）。
       ★ 它被登记的准入能力只有 PROPOSE_PURCHASE 一项 —— P22-9 给
       active_agent_runtime 的矩阵里还有 RESUME_APPROVED_PURCHASE，而
       P22-10 §9 已经决定不开放 resume；本阶段**不**偷偷恢复它：通道的
       command 词表里恰好一个成员，resume 那个字符串在通道代码里一次都
       不出现。 */
  const economyCommandChannel = options.economyCommandChannel
    || economyCommandChannelModule.createEconomyCommandChannel({
      adapter: economyActionAdapter,
      sources: options.economyChannelSources !== undefined
        ? options.economyChannelSources
        : defaultEconomyChannelSources(),
      timeoutMs: options.economyChannelTimeoutMs,
      maxAttempts: options.economyChannelMaxAttempts,
      clock: options.clock,
      logger: (e, f) => serviceLog('info', e, f)
    });
  /* ── P22-13 · Approval Decision Seam（**唯一**一处装配）──────────────
     ★ 它是本仓库里**第二次** `gate.bind(consumer)`，而这一次绑的是一个
       新身份（contract 的 ECONOMY_CONSUMER.USER_DECISION_SEAM）。审计
       （P22-13 §1）的结论是：用户对一条 intent 的点头/摇头在这之前
       **没有任何生产入口**（P22-12C §10.2 的 B1），而它必须经过门 ——
       因为 P22-9 §6 的纪律是"P22-8 的公开写面被完整覆盖"，漏掉任何一条
       能到钱的路径都会让"唯一准入门"变成一句声明。
     ★ 为什么这个身份**不是** home_node_authority，也**不是**
       active_agent_runtime：前者是"权威不行动"（A5 冻结它的能力表为空），
       后者恰恰是**被决定**的一方 —— 把用户的决定记在 Agent 的身份下，
       等于让"Agent 自己批准自己"在审计里看不出来（§2）。
     ★ 句柄**只**给 seam 一个（resumeApprovedPurchase 那一个成员可达），
       而它**不能**提出意图：user_decision_seam 的能力表里没有
       PROPOSE_PURCHASE（见契约的矩阵）。
     ★ seam 拿到的 store 视图是**一个对象、一个键**：decideApproval。
       本文件不把 store 本体交给它 —— 于是"seam 顺便 settle 一笔"在这条
       依赖上也不成立（它连那个成员名都拿不到）。 */
  const economyApprovalDecision = options.economyApprovalDecision
    || economyApprovalDecisionModule({
      store: Object.freeze({ decideApproval: economyStore.decideApproval }),
      resumeHandle: economyCapabilityGate.bind(economyApprovalDecisionModule.CONSUMER),
      desktopCredential: options.desktopToken === undefined ? TOKEN : String(options.desktopToken == null ? '' : options.desktopToken),
      clock: options.clock,
      logger: (e, f) => serviceLog('info', e, f)
    });

  /* ── P22-14 · Economy Configuration Seam（**唯一**一处装配）───────────
     ★ 它的 store 视图**恰好三个键**：bootstrapInitialCredit /
       putBudgetPolicy / putAutonomyPolicy。本文件在这一行完成的是
       §1「不要新造 generic Economy mutation API」的**结构性**版本：
       seam 拿到的不是 store，而是三个**具名**入口，因此
       `mintForSystem` / `burnForSystem` / `commitLedgerTransaction` /
       `openWallet` / `settlePurchase` / `grantInventory` / `decideApproval`
       在这段依赖上**不存在** —— 它连那些成员名都拿不到。
     ★ 为什么凭据是**桌面 token**（与 P22-13 同一份）：在这个仓库里，
       "这台机器的用户"的唯一既有凭据就是它，而 §1 逐字要求优先复用既有
       认证。Agent 的来源凭据（IB_ECONOMY_CHANNEL_TOKEN，按端口登记）在这条
       路径上根本不被读 —— 于是"Agent 凭据换配置权威"没有输入位（§12）。
     ★ 为什么它与 approvalDecision 是**两个实例**而不是一个实例的两种
       command：它们各有自己的词表、自己的信封键、自己的拒绝码，而
       `describe()` 会把"两者不共用命令、不共用信封"写成可断言字段（§8）。
     ★ 与 P22-11 修掉的那个装配缺口同款纪律：`desktopToken` 必须是**可注入**
       的，测试才能构造出"未配置凭据 ⇒ 这一面关闭"这个真实部署形态。 */
  const economyConfiguration = options.economyConfiguration
    || economyConfigurationModule({
      store: Object.freeze({
        bootstrapInitialCredit: economyStore.bootstrapInitialCredit,
        putBudgetPolicy: economyStore.putBudgetPolicy,
        putAutonomyPolicy: economyStore.putAutonomyPolicy
      }),
      desktopCredential: options.desktopToken === undefined ? TOKEN : String(options.desktopToken == null ? '' : options.desktopToken),
      clock: options.clock,
      logger: (e, f) => serviceLog('info', e, f)
    });
  return {
    economyStore: economyStore,
    economyCapabilityGate: economyCapabilityGate,
    economyActionAdapter: economyActionAdapter,
    economyCommandChannel: economyCommandChannel,
    economyApprovalDecision: economyApprovalDecision,
    economyConfiguration: economyConfiguration
  };
}

/* ══ P22-11 · 通道的来源登记册（**唯一**一处读取那些环境键）══════════
   ★ 默认**空**：没有 IB_ECONOMY_CHANNEL_TOKEN 就没有登记项，通道关闭。
     显式地把"空"写成一个具名函数，是为了让"为什么生产上没开"这个问题
     有一个可读的答案，而不是藏在一处 `|| []` 里。
   ★ 端口取 IB_ECONOMY_CHANNEL_SOURCE_PORT（与 active/economy-channel-client.js
     读的是**同一个键**），缺省回落到 IB_ACTIVE_PORT，再缺省 23114。
     ★ 为什么要有那个专用键，而不是直接用 Active 的端口：Windows 上把一个
     客户端 socket 绑到**已经被监听**的端口会一直失败（实测
     `bind EADDRINUSE 127.0.0.1:<IB_ACTIVE_PORT>`，就地重试三次都不行）。
     来源身份要的是一个**确定的、被登记的、不被监听**的端口，因此部署上
     应当显式配置它。回落只是为了在没有它的部署上给出一个**可解释的
     失败**（第一次提议 EADDRINUSE），而不是悄悄换一个没人登记的端口。
   ★ 这里**不**校验端口"像不像 Active"：登记册是装配事实，用错端口
     只会让那条来源连不上（fail closed），不会放行别人。 */
function defaultEconomyChannelSources() {
  const token = String(process.env.IB_ECONOMY_CHANNEL_TOKEN || '');
  if (!token) return [];
  const pick = value => (Number.isInteger(value) && value > 0 && value <= 65535 ? value : null);
  const boundPort = pick(Number(process.env.IB_ECONOMY_CHANNEL_SOURCE_PORT))
    || pick(Number(process.env.IB_ACTIVE_PORT))
    || 23114;
  return [{
    consumer: economyCommandChannelModule.CONSUMER,
    token: token,
    boundPort: boundPort
  }];
}

/* ── canonical Moments store 的失败探针（**唯一**一处）────────────────
   P11-3E：store 成功打开之后又被关掉，`isOpen()` 自己就能回答；而
   "open() 抛了"这一半只有扔出来的那个错误记得。两条路径因此都只能走这里，
   否则同一件事会有两个答案（"库没开"与"库打不开"）。

   这里只负责"记住最后那次开库事故"；**类别**由 http.js 那一份唯一实现决定
   （module.exports.createStoreFailureProbe + runtime/db-failure.js 的分类器）——
   在服务里再写一遍"为什么打不开"就是同一句话的第二个回答。 */
function createMomentStoreFailureProbe(store) {
  const state = { lastOpenError: null };
  const probe = createHttp.createStoreFailureProbe({
    store: store,
    name: 'moments',
    role: 'canonical-moments-authority',
    lastError: () => state.lastOpenError
  }, {
    classifyFailure: dbFailure.classify,
    isDatabaseError: dbFailure.isDatabaseError
  });
  /* 开库事故记在这里：openMomentStore 是唯一写入点。 */
  probe.noteOpenError = function (error) { state.lastOpenError = error; };
  return probe;
}

/* 打开一个 canonical Moments store，并把事故记进探针（供事后如实上报）。
   **不把异常扔给调用方**：调用方需要继续把剩下的 store 开完，并在 /health 上
   如实报告这一域不可服务 —— 一个起不来的派生域不该让整台节点连聊天都不服务。 */
function openMomentStore(store, probe) {
  try {
    return { ok: true, result: store.open() };
  } catch (error) {
    if (probe && typeof probe.noteOpenError === 'function') probe.noteOpenError(error);
    return { ok: false, error: error };
  }
}

/* ── P22-25 · 目录 bootstrap（**唯一**调用点，两条装配路径共用）─────────
   两条启动路径（进程级 openAll 与 buildHomeNode().open()）都必须走这一个
   函数。理由与上面那三个 assembly 逐字相同：把调用写两遍，"某个入口没种
   目录"就只会在其中一侧发生 —— 而那正是 P11-3E / P22-2 已经踩过的
   "测试全绿、生产那台是空的"的形状。

   它**不是**一个 fatal gate：种子写不进去不是"这台节点坏了"，而
   economyStore.open() 本身抛错才是（那条路径一字未改）。因此这里只记录
   一次，不拦启动 —— 一个空目录仍然是 canonical 的合法状态
   （P22-21 · D1），而它不该让聊天也起不来。 */
function applyCatalogBootstrap(economyStore) {
  let outcome = null;
  /* catalog-bootstrap.js 的 logger 是 (event, fields) 的两参形状，而本文件的
     log 是三参 (level, event, fields)。在这里补齐那一层，而不是把 level 塞进
     bootstrap 模块 —— 后者会让一个纯领域模块知道"日志级别"这件宿主的事。 */
  const note = function (event, fields) { log('info', event, fields); };
  try {
    outcome = catalogBootstrap.apply(economyStore, { logger: note });
  } catch (error) {
    /* 抛出来的是"bootstrap 自己坏了"，与"store 说不行"是两件事。
       两者都不得拦启动；差别只在日志里说得清。 */
    log('error', 'economy-catalog-bootstrap-failed', {
      error: (error && error.message) || String(error)
    });
    return { ok: false, applied: false, requested: false, reason: 'bootstrap-threw',
      errors: [(error && error.message) || String(error)] };
  }
  if (!outcome.ok) {
    log('error', 'economy-catalog-bootstrap-failed', { reason: outcome.reason, errors: outcome.errors });
  }
  return outcome;
}

/* ── 网关装配（**唯一**一处）─────────────────────────────────────────
   与 memoryAssembly 同一个理由：网关的依赖集合只能有一份定义。
   生产启动路径与 buildHomeNode() 都调用它，因此"某个 canonical 域没有接线"
   不可能只在一侧发生。 */
function gatewayAssembly(options) {
  /* F1b：若调用方已创建（buildHomeNode / openAll），就**复用同一个实例**；
     否则本装配自己建一个。关键是不管走哪条路，retrieval 读的与 gateway 写的
     必须是同一个对象 —— 两份状态不会报错，只会让 cooldown 静默失效。 */
  const recallSessionState = options.sessionState || createRecallSessionState();
  const memory = canonicalMemoryDeps(memoryAssembly({
    dataDir: options.dataDir,
    memoryStore: options.memoryStore,
    memoryRetrieval: options.memoryRetrieval,
    clock: options.clock,
    random: options.random,
    logger: options.logger,
    sessionState: recallSessionState
  }));
  /* M1-C.2k：线索派生器与记忆**共用同一个 canonical store**。
     它没有自己的表 —— 线索是 canonical memory 上的确定性函数，
     因此装配期唯一要保证的就是"两边真的是同一个 store 实例"。 */
  const threads = canonicalThreadDeps({
    threadRetrieval: options.threadRetrieval || createThreadRetrieval({
      store: memory.memoryStore,
      logger: options.logger
    })
  }, memory.memoryStore);
  /* M1-C.2m：理解域（store + 取回 + 派生）。三者共享同一个 store。 */
  const understanding = canonicalUnderstandingDeps(understandingAssembly({
    dataDir: options.dataDir,
    understandingStore: options.understandingStore,
    understandingRetrieval: options.understandingRetrieval,
    understandingDerivation: options.understandingDerivation,
    memoryStore: memory.memoryStore,
    registry: options.registry,
    modelPort: options.modelPort,
    clock: options.clock,
    logger: options.logger
  }), memory.memoryStore);
  /* M1-C.2n：动态域（store + 取回）。与记忆/线索/理解同款装配纪律。 */
  const moments = canonicalMomentsDeps(momentsAssembly({
    dataDir: options.dataDir,
    momentsStore: options.momentsStore,
    momentsRetrieval: options.momentsRetrieval,
    store: options.store,
    clock: options.clock,
    logger: options.logger
  }));
  const gateway = createMobileGateway(Object.assign({
    /* F1b：与 memoryRetrieval 注入了**同一个** recallSessionState。
       读写必须是同一份状态，否则 cooldown 静默失效。 */
    sessionState: recallSessionState,
    store: options.store,
    registry: options.registry,
    executor: options.executor,
    version: options.version || productVersion(),
    allowedOrigins: options.mobileOrigins || MOBILE_ORIGINS,
    lanMode: !options.loopbackBind,
    lanHost: options.lanAddress || lanAddress,
    port: options.listenPort || PORT,
    clock: options.clock,
    timeZone: options.timeZone,
    random: options.random,
    logger: options.logger || ((level, event, fields) => log(level, event, fields))
  }, memory, threads, understanding, moments));
  /* P11-3E：canonical Moments store 的失败报告由**装配层**提供 —— 它知道这个
     store 是"打不开"还是"被关掉了"。网关只负责把报告翻译成一次响应（503 +
     类别），分类器由 http.js 在委派时注入。缺探针时 /moments/* 退回改动之前的
     行为：不做半套接线。 */
  if (options.momentStoreFailure && typeof gateway.useMomentsStoreFailureProbe === 'function') {
    gateway.useMomentsStoreFailureProbe(options.momentStoreFailure);
  }
  return gateway;
}

/* ── 组装一个完整的 Home Node 实例（不监听）──────────────────────────
   这是**唯一**一处把 chat store / 设备注册表 / executor / gateway / HTTP
   接起来的代码。服务入口用它（然后 listen），每个 HTTP 测试进程也用它
   （然后在临时端口上 listen）。

   为什么必须是同一处：网关的协议语义只能在真实服务上验证（真实 token 校验、
   真实体积上限、真实 SSE 连接），而 Windows 上不能开 unix domain socket
   （实测 EACCES），所以"每个测试一条隔离连接"的唯一可行方式就是
   **每个测试一个真实端口**。如果测试自己复制一遍接线，它验证的就不再是
   生产装配（这正是"测试与产品漂移"最典型的来源）。 */
function buildHomeNode(options) {
  options = options || {};
  const dataDir = options.dataDir || DATA_DIR;
  const credentialDataDir = options.credentialDataDir || (options.dataDir ? dataDir : CREDENTIAL_DATA_DIR);
  const serviceLog = options.logger || ((level, event, fields) => log(level, event, fields));
  const instanceStore = options.store || createStore({ dataDir: dataDir, logger: (e, f) => serviceLog('info', e, f) });
  /* M1-C.2d Wave 2：canonical `memories`（与 chatMessages 同一个 SQLite 文件，
     但拥有**自己的** revision / change_log 命名空间 —— 见 memory-store.js 头部）。
     刻意晚于 chat store 打开：chat store 负责损坏隔离（会给坏库改名），
     同一文件上的第二个 opener 不能去 rename 它。 */
  /* F1b · 一个 service instance 一个 cooldown state；两条装配共用（§16）。 */
  const recallSessionState = options.sessionState || createRecallSessionState();
  const memoryDeps = canonicalMemoryDeps(memoryAssembly({
    dataDir: dataDir,
    memoryStore: options.memoryStore,
    memoryRetrieval: options.memoryRetrieval,
    clock: options.clock,
    random: options.random,
    logger: serviceLog,
    sessionState: recallSessionState

  }));
  const instanceMemoryStore = memoryDeps.memoryStore;
  const instanceMemoryRetrieval = memoryDeps.memoryRetrieval;
  const instanceRegistry = options.registry || createDeviceRegistry({ dataDir: dataDir, logger: (e, f) => serviceLog('info', e, f) });
  /* P34.3-B · instance-scoped credential access bound to the instance registry
     (test instances never read the production data directory's registry). */
  const instanceCredentialAccess = options.credentialAccess || createCredentialAccess({
    dataDir: credentialDataDir,
    isAllowed: (id) => registryAllowsCredentialRef(instanceRegistry, id)
  });
  /* M1-C.2i · canonical Middle Brain 执行缝（Node 宿主适配）。
     工厂本身不抛错：canonical 层加载失败时它返回一个"永远未参与"的降级对象，
     于是回合照常跑（Middle Brain 是认知增强层，不是聊天单点故障）。
     配置来源 = registry 里已发布的执行策略投影（桌面经 /characters/publish 送来）。
     这里刻意**不**给它传什么凭据：Home Node 不需要 Middle Brain 凭据，
     投影里也没有（见 middle-brain-config-core.projectExecutionConfig）。 */
  const instanceMiddleBrain = options.middleBrain || createNodeMiddleBrain({
    /* 配置来源 = registry 里已发布的执行策略投影。
       读**实例** registry 而不是模块级的那个：buildHomeNode() 的存在意义就是
       "测试实例绝不读写生产数据目录"。退回模块级只发生在 require.main 路径
       （那里 instanceRegistry 为 null），测试路径永远命中前者。 */
    executionConfig: () => {
      const reg = instanceRegistry || registry;
      if (!reg || typeof reg.getMiddleBrainExecutionConfig !== 'function') return null;
      return reg.getMiddleBrainExecutionConfig();
    },
    logger: (event, fields) => serviceLog('info', event, fields)
  });
  const instanceExecutor = options.executor || createExecutor({
    store: instanceStore,
    port: options.port || createNodeModelPort({}),
    middleBrain: instanceMiddleBrain,
    credentialAccess: instanceCredentialAccess,
    logger: (e, f) => serviceLog('info', e, f)
  });
  /* M1-C.2m：理解域的挂载点（网关委派给它的 store / 取回 / 派生）。
     为什么 modelPort 用**同一个** options.port：派生是"用角色自己的凭据做
     后台工作"，它必须走与回合执行完全相同的那条 wire 层（IBModelCore 的唯一
     翻译器）—— 另建一个 port 会让"派生请求"与"聊天请求"在 provider 形状上
     分叉，而那种分叉只会在某个特定 provider 上才暴露。 */
  const instanceUnderstanding = options.understanding || understandingAssembly({
    dataDir: dataDir,
    understandingStore: options.understandingStore,
    understandingRetrieval: options.understandingRetrieval,
    understandingDerivation: options.understandingDerivation,
    memoryStore: instanceMemoryStore,
    registry: instanceRegistry,
    modelPort: options.port || createNodeModelPort({}),
    credentialAccess: instanceCredentialAccess,
    clock: options.clock,
    logger: serviceLog
  });
  const host = options.host || HOST;
  const loopbackBind = isLoopbackHost(host);
  /* M1-C.2n：动态域的挂载点。与理解域同款位置与理由（同一 dataDir、
     同一 store 实例共享给网关，装配守卫在 gatewayAssembly 里强制）。
     P11-3E：探针实例在**任何**用到它的地方之前建立 —— 它同时喂网关
     （/moments/* 的失败报告）与 http 层（/health 的裁决与状态码），
     而这两处共用同一份"最后那次开库事故"的记忆。 */
  const instanceMoments = options.moments || momentsAssembly({
    dataDir: dataDir,
    momentsStore: options.momentsStore,
    momentsRetrieval: options.momentsRetrieval,
    store: instanceStore,
    clock: options.clock,
    logger: serviceLog
  });
  const instanceMomentProbe = createMomentStoreFailureProbe(instanceMoments.momentsStore);
  /* P22-2 · Economy 的挂载点。位置在 registry 之后、http 之前：
     ownerExists 谓词要读 registry，而 http 层要拿到这个 store。
     与 moments 同款纪律 —— 同一个 dataDir、同一个实例，两条启动路径
     共用 economyAssembly。 */
  const instanceEconomy = options.economy || economyAssembly({
    dataDir: dataDir,
    registry: instanceRegistry,
    economyStore: options.economyStore,
    economyGate: options.economyGate,
    economyCapabilityConfig: options.economyCapabilityConfig,
    /* P22-11 修掉的一个**真实装配缺口**（开发期实测）：这两行以前不在
       这里。economyAssembly 明确支持 `options.economyActionAdapter`
       （P22-10 写的），但 buildHomeNode **没有把它转发下去** —— 于是
       "注入一个适配器"在装配层被静默忽略，测试拿到的永远是内部自建的
       那一个（实测症状：包装器的调用计数恒为 0，而命令照样成功）。
       这正是这个文件里已经写过三次的同一种病（memory / understanding /
       moments 的"装配好了但没接上"），只是这一次的受害者是注入点。
       ★ 两行都必须在这里：漏掉 adapter 会让"谁被绑定了"不可注入，
         漏掉 channel 会让通道在测试里永远是环境默认那一个。 */
    economyActionAdapter: options.economyActionAdapter,
    economyChannelSources: options.economyChannelSources,
    economyChannelTimeoutMs: options.economyChannelTimeoutMs,
    economyChannelMaxAttempts: options.economyChannelMaxAttempts,
    /* P22-13：Approval Decision Seam 的**身份**来自与桌面面同一份凭据 ——
       也就是 http.js 从 `deps.token` 读到的那一个。两处必须是同一份，
       否则"用户点得动 UI、却过不了 seam"会成为一个只在生产上出现的缺口。
       ★ 与 P22-11 修掉的那个缺口逐字同形（"buildHomeNode 没有把某个注入点
       转发下去"）：这一行也必须是可注入的，测试才能构造出"未配置凭据 ⇒
       这一面关闭"这个真实部署形态。 */
    desktopToken: options.token === undefined ? TOKEN : options.token,
    ownerExists: options.ownerExists,
    /* P22-14：Configuration Seam 与 Approval Decision Seam 一样必须是
       **可注入**的 —— 理由逐字相同（P22-11 修掉的那个缺口：装配层支持某个
       注入点、而 buildHomeNode 没有把它转发下去，于是"注入"被静默忽略）。
       ★ 它也是"未配置凭据 ⇒ 这一面关闭"这个部署形态可被真实构造的前提。 */
    economyConfiguration: options.economyConfiguration,
    systemAuthority: options.systemAuthority,
    systemMintingEnabled: options.systemMintingEnabled,
    clock: options.clock,
    logger: serviceLog
  });
  /* ── P21-R4-LIVE-2.1 · Runtime Interpretation 的挂载点 ────────────────
     位置在 registry / credentialAccess 之后、http 之前：服务的四个依赖恰好是
     "这台实例的设备目录 + 这台实例的 Vault 取用 + 这条实例的 wire 层 + 成本
     闸门"，而它自己**不**持有 store、不持有凭据本体（公开面只有
     { path, operations, describe, run }）。
     ★ modelPort 与 executor / understanding 用**同一个**表达式（options.port）：
       解释走的是与回合执行完全相同的那条 wire 层（IBModelCore 的唯一翻译器）
       —— 另建一个 port 会让"解释请求"与"聊天请求"在 provider 形状上分叉，
       而那种分叉只会在某个特定 provider 上才暴露。
     ★ costPolicy 只接受装配层显式传进来的 options.runtimeInterpretationPolicy：
       缺席即 false（默认关），而**没有任何环境变量或 UI 开关**能把它打开 ——
       这正是本阶段的冻结项（"没有生产启用路径"）。 */
  /* ── P21-R4-LIVE-4.3 · 这台实例的**成本权威文件** ──────────────────────
     它落在实例自己的数据目录里（与 registry / memory store 同一层保护），
     默认 OFF：fresh dataDir ⇒ 文件不存在 ⇒ 每个角色都关。
     `options.runtimePolicy` 是**装配注入**（测试用同一个实例做 A/B）；生产不传。 */
  const instanceRuntimePolicy = options.runtimePolicy
    || createRuntimePolicy({ dataDir: dataDir, logger: serviceLog });
  /* ── P21-R4-LIVE-5 · L5 期望运行时（**兄弟**依赖，与解释各自独立）──────
     成本权威来自 instanceRuntimePolicy 的**期望段**（readExpectation），与解释段
     是两个独立布尔：解释开着**不**蕴含期望开着。默认 OFF ⇒ 零模型调用。
     modelPort 与解释/派生/聊天复用同一个 port（理由同上：另建一个会让 wire 形状分叉）。 */
  const instanceRuntimeBehaviorEffect = options.runtimeBehaviorEffect || createRuntimeBehaviorEffect({
    clock: options.clock, logger: serviceLog
  });
  const instanceRuntimeExpectation = options.runtimeExpectation || createRuntimeExpectation({
    modelPort: options.port || createNodeModelPort({}),
    policy: instanceRuntimePolicy,
    /* canonical 内容的唯一来源：与 instanceRuntimeInterpretation 用**同一个**
       store 实例（换第二个 store 不会抛错，只会让每次期望都回答
       "没有已授权的记忆" —— 与 M1-C.2i 的 memoryRetrieval 漂移同形）。 */
    memoryStore: instanceMemoryStore,
    /* 角色 spec 与凭据：与解释边界同一对实例依赖。 */
    registry: instanceRegistry,
    credentialAccess: instanceCredentialAccess,
    autoExpectationPolicy: options.runtimeAutoExpectationPolicy,
    clock: options.clock,
    logger: serviceLog
  });
  const instanceRuntimeInterpretation = options.runtimeInterpretation || createRuntimeInterpretation({
    registry: instanceRegistry,
    credentialAccess: instanceCredentialAccess,
    modelPort: options.port || createNodeModelPort({}),
    costPolicy: options.runtimeInterpretationPolicy,
    /* ── P21-R4-LIVE-4 · **第二条**策略：服务端内部自动解释 ────────────────
       与上面那条**不同**的键、**不同**的默认（都缺席 ⇒ 都关）。生产路径同样
       不传它（见进程级装配处的说明）：READY-but-OFF。
       装配选项名 = runtimeAutoInterpretationPolicy，键 =
       { autoInterpretationEnabled: true }。
       ★ P21-R4-LIVE-4.3：这个键的身份是**测试缝**（describe() 会如实报
         authoritySource:'TEST_INJECTION'）。生产权威是下面的文件策略。 */
    autoInterpretationPolicy: options.runtimeAutoInterpretationPolicy,
    /* 文件权威：read(characterId) 每次读文件；唯一写者是 Node 侧 set()。 */
    policy: instanceRuntimePolicy,
    /* P21-R4-LIVE-3 · canonical 证据的唯一来源。
       ★ 必须与网关/召回读的是**同一个** store 实例：绑定的正是"这台实例
         的 canonical 记忆"。给一个"能开、能查、永远为空"的第二实例不会抛
         任何错，只会让每一次解释都回答"没有已授权的记忆" —— 与 M1-C.2i 的
         memoryRetrieval 漂移同形，因此这里刻意复用 instanceMemoryStore。 */
    memoryStore: instanceMemoryStore,
    clock: options.clock,
    logger: serviceLog
  });
  /* ── P21-R4-LIVE-3.3 · Runtime Recall 的挂载点 ────────────────────────
     依赖全部是**实例**作用域：这台实例的召回器、这台实例的 canonical memory
     store、这台实例的设备目录、这台实例的 cooldown session state。
     ★ memoryStore 与 memoryRetrieval **同时**传：服务在构造时核对
       `memoryRetrieval.store === memoryStore`，不一致就 fail closed ——
       "绑到另一个能开、能查、永远为空的实例"不会抛任何错，只会表现为
       "她突然什么都不记得"，那种缺口必须在装配期拦住。
     ★ sessionState 传的是**与网关同一个**实例（身份可核对），但本边界
       绝不动它：它只用于读 cooldown 的 exposure，且**不推进**任何回合。
     ★ glossary 条目来源只从这里进（options.*，默认 undefined）—— 请求侧
       出现 glossary* 一律被逐名拒绝，因此"浏览器提交词表"这条路不存在。 */
  const instanceRuntimeRecall = options.runtimeRecall || createRuntimeRecall({
    memoryRetrieval: instanceMemoryRetrieval,
    memoryStore: instanceMemoryStore,
    registry: instanceRegistry,
    sessionState: recallSessionState,
    clock: options.clock,
    random: options.random,
    glossaryProvider: options.glossaryProvider,
    getGlossaryEntries: options.getGlossaryEntries,
    /* P21-R4-LIVE-4 · post-recall hook 的解释服务。缺席 ⇒ 自动路径整体不存在
       （与今天逐字节相同）；在场时它也只在 autoPolicy 为 ON 且通道 eligible
       时才会真的调用 provider。 */
    interpretation: instanceRuntimeInterpretation,
    /* P21-R4-LIVE-5 · 期望的兄弟依赖（POST_INTERPRETATION_NONBLOCKING）。
       缺席 ⇒ 期望这条路径整体不存在（与今天逐字节相同）。 */
    expectation: instanceRuntimeExpectation,
    /* P21-R4-F · L7：确定性派生 + 第 17 键交付（无模型调用）。 */
    behaviorEffect: instanceRuntimeBehaviorEffect,
    logger: serviceLog
  });
  /* 与进程级启动路径**共用** gatewayAssembly（见其头部说明：两条路径两套装配
     必然漂移，memoryStore 就是这样在 production 上丢过一次）。 */
  const instanceGateway = options.gateway || gatewayAssembly({
    sessionState: recallSessionState,
    /* dataDir 必须传下去：网关内部（经 memoryAssembly）可能自己建 memory store，
       不传就会兜到生产 DATA_DIR —— 一个"测试实例读写生产记忆库"的静默越界。 */
    dataDir: dataDir,
    store: instanceStore,
    registry: instanceRegistry,
    executor: instanceExecutor,
    memoryStore: instanceMemoryStore,
    memoryRetrieval: instanceMemoryRetrieval,
    understandingStore: instanceUnderstanding.understandingStore,
    understandingRetrieval: instanceUnderstanding.understandingRetrieval,
    understandingDerivation: instanceUnderstanding.understandingDerivation,
    momentsStore: instanceMoments.momentsStore,
    momentsRetrieval: instanceMoments.momentsRetrieval,
    momentStoreFailure: instanceMomentProbe,
    /* 派生用同一个 model port（理由见 instanceUnderstanding 的注释）。 */
    modelPort: options.port || createNodeModelPort({}),
    version: options.version,
    mobileOrigins: options.mobileOrigins,
    loopbackBind: loopbackBind,
    lanAddress: options.lanAddress,
    listenPort: options.listenPort,
    /* P0（M1-C.2c-A）：时钟与时区可注入，只为让"当前时间"可被确定性测试。
       生产默认仍是系统时钟 + 进程本地时区。 */
    clock: options.clock,
    timeZone: options.timeZone,
    random: options.random,
    logger: serviceLog
  });
  const instanceHttp = createHttp({
    store: instanceStore,
    executor: instanceExecutor,
    gateway: instanceGateway,
    token: options.token === undefined ? TOKEN : options.token,
    /* P22-23 · 凭据**来源**（不是凭据本体）交给传输层，因为它要回答两个
       只有它才能回答的问题：
         · bootstrap 交付面该不该开（env 显式配置时必须整面关闭 —— 那是
           "部署方已经决定了凭据"，让浏览器再取一份就又多了一个来源）；
         · /security 要如实说"凭据已配置 / 从哪来"，让 UI 能区分
           「Home Node 没起来」与「凭据没配上」这两件不同的事。
       ★ `desktopCredentialSource` 缺席（测试直接 buildHomeNode 且注入 token）
         时传输层按"已配置但不允许 bootstrap"处理 —— 见 http.js 的那条默认值。 */
    desktopCredentialSource: options.desktopCredentialSource === undefined
      ? (options.token === undefined ? TOKEN_SOURCE : null)
      : options.desktopCredentialSource,
    desktopCredentialAutoProvision: options.desktopCredentialAutoProvision === undefined
      ? (options.token === undefined && TOKEN_SOURCE === desktopCredential.SOURCE.GENERATED)
      : options.desktopCredentialAutoProvision === true,
    version: options.version || productVersion(),
    allowedOrigins: options.allowedOrigins || ALLOWED_ORIGINS,
    /* P11-3E：canonical store 的失败分类只有一份（http.js 的 resolveStoreFailure），
       这里把分类器与"最后一次开库是怎么失败的"探针一起交上去 ——
       于是 /moments/* 在库不能服务时回答 503 + 类别，而不是 400。 */
    classifyFailure: dbFailure.classify,
    isDatabaseError: dbFailure.isDatabaseError,
    momentStore: instanceMoments.momentsStore,
    momentStoreFailure: instanceMomentProbe,
    /* P22-2 · Economy 的只读观测面。**只**给 store，不给任何写入口：
       http.js 的 /economy/* 全是 GET（见那边的注释），铸币与提交交易的
       入口都留在 store 内部 API 上。 */
    economyStore: instanceEconomy.economyStore,
    /* P22-11 · Economy 的 command 通道（**唯一**一条写路径的承载者）。
       ★ 与上面那一行刻意**不同级**：economyStore 是只读观测面，而这一行
         是一个能到达适配器的对象。它替换不了 store —— 通道的公开面里
         没有 store、没有门、没有 SQL，只有 dispatch。 */
    economyCommand: instanceEconomy.economyCommandChannel,
    /* P22-13 · Economy 的 **Approval Decision Seam**（第二条、也是最后一条
       写路径的承载者）。
       ★ 与 economyCommand 同级、与 economyStore 不同级：它是一个能到达
         P22-9 门的对象，但它的公开面里没有 store、没有门、没有 SQL，
         只有 { path, dispatch }。
       ★ 为什么它能上 HTTP，而适配器与门不能：它**不是**权威 —— 它把用户的
         决定写成一条 canonical 批准（P22-7），再把同一条 intent 交回 P22-8；
         它自己不判断价格、预算、自主性或商品。P22-12C §10.2 的 B1 说的
         正是"缺这条入口"，而不是"不该有这条入口"。 */
    economyApprovalDecision: instanceEconomy.economyApprovalDecision,
    /* P22-14 · Economy 的 **Configuration Seam**（fresh install 的配置入口）。
       ★ 与上面两行同级、与 economyStore 不同级：它的公开面里没有 store、
         没有门、没有 SQL，只有 { path, dispatch, describe, audit }；而它
         拿到的 store 视图恰好三个键（见 economyAssembly 那一行）。
       ★ 为什么它可以上 HTTP，而 store 的铸币原语不能：它**不是**一个通用
         mutation 入口 —— 它是一条**封闭三命令**的配置面，其中"初始额度恰好
         一次"这条规则由 store 的 canonical 事实（economy_meta 行）持有，
         而不是由这一层"记得检查"。
       ★ 它**不是** /internal/economy/approval-decision 的别名，也不是它的
         扩展：两条路径不共用命令、不共用信封（§8）。 */
    economyConfiguration: instanceEconomy.economyConfiguration,
    /* ── P21-R4-LIVE-2.1 · Runtime Interpretation（**唯一**一条运行时执行面）──
       ★ 与上面三条 economy seam 同级、与 economyStore 不同级：它替换不了任何
         store，公开面只有 { path, operations, describe, run }。
       ★ 为什么它能上 HTTP 而不违反"HTTP 面只读"：它不是读面，而是一条与
         economy 写面同级的**执行**面，而它的准入完全由桌面凭据判定负责
         （http.js 里那块在 authorized() 之后，没有 isEconomyCommandPath
         式豁免）。 */
    runtimeInterpretation: instanceRuntimeInterpretation,
    /* P21-R4-LIVE-4.3 · 实例的**成本权威文件**（服务端对象，没有任何路由：
       把它交给测试/宿主是为了 `set()`，而 set() 只存在于 Node 侧）。 */
    runtimePolicy: instanceRuntimePolicy,
    /* ── P21-R4-LIVE-3.3 · Runtime Recall（**唯一**一条运行时召回面）──────
       ★ 与解释边界同级、与 memoryStore 不同级：它替换不了 store，公开面只有
         { path, operations, run, describe }。准入同样由桌面凭据判定负责
         （http.js 里那块在 authorized() 之后，没有豁免）。
       ★ 它**不**与解释边界共用信封或路径：一条读本地 canonical 记忆并只回
         ids，一条出网读 Vault。合成一条会让审计读不出"这一步花没花钱"。 */
    runtimeRecall: instanceRuntimeRecall,
  runtimeExpectation: instanceRuntimeExpectation,
  runtimeBehaviorEffect: instanceRuntimeBehaviorEffect,
    /* P11-3E · canonical store 清单：健康与"能不能服务"是同一个问题，
       所以这里列出本进程承诺的全部 canonical store，而不是只有 chat。
       声明角色（chat）在最前，`failure` 取第一个命中它的。 */
    stores: [
      { store: instanceStore, name: 'chat', role: 'canonical-chat-authority' },
      {
        store: instanceMoments.momentsStore, name: 'moments', role: 'canonical-moments-authority',
        probe: instanceMomentProbe
      }
    ],
    /* LAN 门：显式非 loopback 绑定 **且** 设备鉴权此刻真的就绪。
       刻意传**函数**：http 层在这里被构造时 open() 还没发生（见下面 open()），
       固化成布尔就等于把"注册表一定会成功打开"这个尚未证实的假设写进安全决策。
       刻意**不提供**任何覆盖入口：这是一个安全谓词，唯一合法的回答来自
       deviceAuthReady() 的真实探针。 */
    allowRemote: () => !loopbackBind && deviceAuthReady(instanceRegistry).ready,
    logger: serviceLog
  });
  /* 打开顺序有语义：chat store 先开（它负责损坏隔离 —— 会给坏库改名），
     设备表与它同库，必须等隔离完成之后再连。
     P11-3E：Moments 走 openMomentStore —— 开库事故要留给探针（`/health` 与
     `/moments/*` 靠它如实上报），而不是让整台节点连聊天都不服务。 */
  function open() {
    const openedStore = instanceStore.open();
    instanceMemoryStore.open();
    instanceUnderstanding.understandingStore.open();
    openMomentStore(instanceMoments.momentsStore, instanceMomentProbe);
    instanceRegistry.open();
    /* P22-2：Economy 在最后打开。**顺序是有意的**：ownerExists 谓词
       要读 registry，因此注册表必须先就绪；而 Economy 自己不参与
       损坏隔离（quarantine 由 chat store 负责），所以它在隔离完成之后
       连接同一个文件是安全的。 */
    instanceEconomy.economyStore.open();
    /* P22-25：目录 bootstrap 紧跟在 open() 之后、**早于任何请求**。
       顺序是有意的：它只可能写一次（目录非空即不再进入写路径），因此
       放在监听之前意味着"这台节点对外服务时，它的目录已经是 canonical
       的初始状态"。 */
    applyCatalogBootstrap(instanceEconomy.economyStore);
    return openedStore;
  }
  function close() {
    try { instanceGateway.stop(); } catch (_) { /* 已停止 */ }
    /* 关掉监听并**主动断开**所有还在的 keep-alive 连接。
       只调 server.close() 是不够的：它只是停止接受新连接，已建立的空闲
       keep-alive socket 会让事件循环一直活着（测试进程表现为"跑完不退出"，
       实测在 gateway HTTP 测试里就是这个症状）。
       server.closeAllConnections() 是 Node 18.2+ 的正式 API，正是为这种
       "优雅关闭但不想等空闲连接" 的场景提供的。 */
    try { instanceHttp.server.close(); } catch (_) { /* 未监听 */ }
    try {
      if (typeof instanceHttp.server.closeAllConnections === 'function') instanceHttp.server.closeAllConnections();
    } catch (_) { /* 尽力而为 */ }
    /* 理解派生器的调度器必须先停：它会在 tick 里读 store，
       留下一个仍排队的 timer 去读一个已关闭的库只会把"已关闭"变成噪音错误。 */
    try { if (instanceUnderstanding.understandingDerivation) instanceUnderstanding.understandingDerivation.stop(); } catch (_) { /* 未启动 */ }
    try { instanceRegistry.close(); } catch (_) { /* 已关闭 */ }
    try { instanceUnderstanding.understandingStore.close(); } catch (_) { /* 已关闭 */ }
    try { instanceMoments.momentsStore.close(); } catch (_) { /* 已关闭 */ }
    try { instanceEconomy.economyStore.close(); } catch (_) { /* 已关闭 */ }
    try { instanceMemoryStore.close(); } catch (_) { /* 已关闭 */ }
    try { instanceStore.close(); } catch (_) { /* 已关闭 */ }
  }
  return {
    store: instanceStore,
    memoryStore: instanceMemoryStore,
    /* F1b：与 memoryRetrieval / gateway 注入的是**同一个**实例（§16 identity spy）。 */
    recallSessionState: recallSessionState,
    memoryRetrieval: instanceMemoryRetrieval,
    understandingStore: instanceUnderstanding.understandingStore,
    understandingRetrieval: instanceUnderstanding.understandingRetrieval,
    understandingDerivation: instanceUnderstanding.understandingDerivation,
    momentsStore: instanceMoments.momentsStore,
    momentsRetrieval: instanceMoments.momentsRetrieval,
    /* P22-2：Economy 的实例，导出给"两条装配路径不得再次漂移"这类断言
       （与 memoryStore / momentsStore 被导出的理由逐字相同）。
       ★ P22-9 把门一并导出，理由完全相同：它是装配事实，而不是 store 的
       一个内部细节；"这台节点到底装没装门"必须可以直接断言。 */
    economyStore: instanceEconomy.economyStore,
    economyCapabilityGate: instanceEconomy.economyCapabilityGate,
    /* P22-10：Action Adapter 也一并导出。它与 store / 门逐字同级 ——
       "这台节点上有没有一个 Agent 能提议"必须是一句可断言的事实，
       而它同时也是 §6 的机器可读答案：装配里**只**绑了 active_agent_runtime
       一个消费者（describe().consumer）。 */
    economyActionAdapter: instanceEconomy.economyActionAdapter,
    /* P22-11：通道与 adapter/store/门同级导出 —— "这台节点上真实的
       command 面是哪一条、它是开还是关"必须是一个可核对的事实，
       而不是读者从环境变量里推断的东西。 */
    economyCommandChannel: instanceEconomy.economyCommandChannel,
    /* P22-13：Approval Decision Seam 与上面四个同级导出 ——
       "这台节点上用户能不能对一条等待中的 intent 点头/摇头"必须是一句可以
       直接断言的事实，而不是读者从路由表或环境变量里推断的东西。
       它同时也是 §2 的机器可读答案：这条面绑的是**用户**那个身份
       （user_decision_seam），而不是 Agent。 */
    economyApprovalDecision: instanceEconomy.economyApprovalDecision,
    /* P22-14：Configuration Seam 与上面五个同级导出 —— "fresh install 能不能
       在不改代码、不碰 SQLite 的前提下被配到可运行"必须是一句可以直接断言的
       事实。★ 它与 approvalDecision 是**两个**导出、两条路径、两份词表：
       一个答案是"用户能决定一条 intent"，另一个是"用户能预设这台节点的钱与
       规则"。 */
    economyConfiguration: instanceEconomy.economyConfiguration,
    /* P21-R4-LIVE-2.1：Runtime Interpretation 与上面每一个域同级导出 ——
       "这台节点上到底有没有一条运行时解释执行面、它开不开"必须是一句可以
       直接断言的事实，而不是读者从路由表或环境变量里推断的东西。
       ★ 它与 http.js 从 deps 里拿到的是**同一个对象**：这正是"两条装配路径
         不得漂移"这句断言的载体（identity，而不是两个形状相同的对象）。 */
    runtimeInterpretation: instanceRuntimeInterpretation,
    /* P21-R4-LIVE-4.3 · 实例的**成本权威文件**（服务端对象，没有任何路由：
       把它交给测试/宿主是为了 `set()`，而 set() 只存在于 Node 侧）。 */
    runtimePolicy: instanceRuntimePolicy,
    /* P21-R4-LIVE-3.3：Runtime Recall 与上面每一个域同级导出 —— "这台节点上
       到底有没有一条运行时召回面"必须是一句可以直接断言的事实。
       ★ 与 http.js 从 deps 里拿到的是**同一个对象**（identity）：这正是
         "两条装配路径不得漂移"这句断言的载体。 */
    runtimeRecall: instanceRuntimeRecall,
  runtimeExpectation: instanceRuntimeExpectation,
  runtimeBehaviorEffect: instanceRuntimeBehaviorEffect,
    registry: instanceRegistry,
    gateway: instanceGateway,
    executor: instanceExecutor,
    httpLayer: instanceHttp,
    server: instanceHttp.server,
    open: open,
    close: close,
    loopbackBind: loopbackBind
  };
}

/* ── 设备注册表 + Mobile Gateway ─────────────────────────────────────
   进程级实例：非 require.main 时被测试复用（见 tests/test_home_node_service.js
   与 tests/test_mobile_gateway_http.js —— 后者用 buildHomeNode 自己建隔离实例）。

   **这里是生产启动路径**（runtime/local-services-runner.js 直接跑本文件，
   不走 buildHomeNode）。canonical memory 的 store / 召回器必须在这里也真的
   接到网关上 —— 曾经漏掉，导致 23118 上 /memory/* 全部 `if (!memoryStore)`
   → 501，而测试因为只覆盖 buildHomeNode 而全绿。现在两条路径共用
   memoryAssembly()/gatewayAssembly()，缺席会在装配期直接抛错。 */
/* F1b · 进程级路径同样只建一份 cooldown state（§16）。 */
const recallSessionState = createRecallSessionState();
const memory = memoryAssembly({
  dataDir: DATA_DIR,
  logger: (level, event, fields) => log(level, event, fields),
  sessionState: recallSessionState
});
const registry = createDeviceRegistry({
  dataDir: DATA_DIR,
  logger: (event, fields) => log('info', event, fields)
});
productionRegistry = registry;
/* M1-C.2m：进程级启动路径同样必须挂上理解域 —— 与 memory 那次教训逐字同形
   （只接 buildHomeNode 会让 23118 上的 /understanding/* 全 501，而测试全绿）。
   modelPort 复用进程级 port：派生与回合走同一条 wire 层。 */
const understanding = understandingAssembly({
  dataDir: DATA_DIR,
  memoryStore: memory.memoryStore,
  registry,
  modelPort: port,
  credentialAccess: productionCredentialAccess,
  logger: (level, event, fields) => log(level, event, fields)
});
/* M1-C.2n：进程级启动路径同样必须挂上动态域 —— 与理解域那次教训逐字同形
   （只接 buildHomeNode 会让网关在 Home Node 上看不到任何动态，而测试全绿）。 */
const moments = momentsAssembly({
  dataDir: DATA_DIR,
  store,
  logger: (level, event, fields) => log(level, event, fields)
});
/* P22-2：进程级启动路径同样必须挂上 Economy —— 与 memory / understanding /
   moments 那三次教训逐字同形（只接 buildHomeNode 会让真实进程上的
   /economy/* 全部不可服务，而所有直接 createEconomyStore() 的测试全绿）。
   ownerExists 复用进程级 registry：角色的 canonical owner 只有它一个。 */
const economy = economyAssembly({
  dataDir: DATA_DIR,
  registry,
  logger: (level, event, fields) => log(level, event, fields)
});
/* ── P21-R4-LIVE-2.1 · **进程级**的 Runtime Interpretation ───────────────
   与 memory / understanding / moments / economy 那四次的教训逐字同形：
   只接 buildHomeNode 会让**真实进程**上这条路径整个不存在
   （http.js 收不到 deps.runtimeInterpretation ⇒ 分支不存在 ⇒ 落到通用 404），
   而所有 buildHomeNode 的测试全绿 —— 这正是本文件已经记过**四次**的那种缺口。
   ★ 刻意**不传** costPolicy：生产路径上它是 undefined ⇒ 服务的默认（关）。
     本阶段冻结"没有生产启用路径"：不加 env、不加 UI 开关、不加默认值。
   ★ registry 用进程级的那一个；credentialAccess 用生产实例 —— 它的 isAllowed
     读 productionRegistry，是"这台节点自己发布过的角色"那份最小权限白名单。 */
/* ── P21-R4-LIVE-4.3 / 5 · **进程级**唯一的生产成本权威实例 ──────────────
   一份文件、一个实例，被**解释**与**期望**两条路径共用：解释段与期望段是同一份
   runtime-policy.json 里的两个**独立**布尔（`set()` / `setExpectation()`），
   共用一个实例不构成耦合 —— 耦合只会在"一个键同时喂两个功能"时出现。
   唯一写者是 Node 侧 set()/setExpectation()（没有路由 / 没有 window 面 /
   本阶段没有 Tauri 命令）。fresh 安装 ⇒ 文件不存在 ⇒ 两个功能都 OFF。 */
const runtimePolicy = createRuntimePolicy({ dataDir: DATA_DIR, logger: (level, event, fields) => log(level, event, fields) });
const runtimeInterpretation = createRuntimeInterpretation({
  registry,
  credentialAccess: productionCredentialAccess,
  modelPort: port,
  /* P21-R4-LIVE-3 · 生产路径同样必须拿到 canonical 记忆 store ——
     与 buildHomeNode 那一行逐字同源。少了这一行，真实进程上每一次解释都会
     以 canonical-evidence-unavailable 失败，而所有 buildHomeNode 的测试全绿
     （这正是本文件已经记过四次的同一种装配缺口）。 */
  memoryStore: memory.memoryStore,
  /* ── P21-R4-LIVE-4.3 · **生产权威**：这台节点的策略文件（解释段）────── */
  policy: runtimePolicy,
  /* P21-R4-LIVE-4 · 生产路径**刻意不传** autoInterpretationPolicy：
     它是**测试缝**（describe() 会报 authoritySource:'TEST_INJECTION'），生产
     两侧都不传 ⇒ 文件权威生效；没有 env、没有 UI 开关、没有默认 true。 */
  logger: (level, event, fields) => log(level, event, fields)
});
/* ── P21-R4-LIVE-3.3 · **进程级**的 Runtime Recall ──────────────────────
   与 memory / understanding / moments / economy / interpretation 那几次的教训
   逐字同形：只接 buildHomeNode 会让**真实进程**上这条路径整个不存在
   （http.js 收不到 deps.runtimeRecall ⇒ 分支不存在 ⇒ 落到通用 404），
   而所有 buildHomeNode 的测试全绿 —— 这正是本文件已经记过**五次**的那种缺口。
   ★ memoryRetrieval / memoryStore 都用进程级那**一份**（identity）：
     绑到别的实例不会抛错，只会让她"什么都不记得"。
   ★ sessionState 用进程级那只（与网关同一个）—— 本边界只读它，绝不推进。
   ★ 不传 glossary provider：生产侧今天没有词汇表条目来源，传 undefined 就是
     如实（glossary 通道在服务端因此不可达，直到真的有来源为止）；
     绝不为了"看起来对称"造一个空目录来源。 */
/* ── P21-R4-LIVE-5 · **进程级**的 L5 期望运行时 ─────────────────────────
   与上面那些的教训逐字同形：只接 buildHomeNode 会让**真实进程**上这条路径
   整个不存在，而所有 buildHomeNode 的测试全绿。
   ★ 权威 = 进程级那一份 runtime-policy 的**期望段**（readExpectation）；两个
     布尔互相独立，生产两侧都**不传** autoExpectationPolicy（它是测试缝）。
   ★ modelPort 复用进程级 port：期望与聊天/派生/解释走同一条 wire 层。 */
const runtimeBehaviorEffect = createRuntimeBehaviorEffect({
  clock: function () { return Date.now(); },
  logger: (level, event, fields) => log(level, event, fields)
});
const runtimeExpectation = createRuntimeExpectation({
  modelPort: port,
  policy: runtimePolicy,
  /* 进程级那**一份** canonical store（与解释/召回同一个实例）。 */
  memoryStore: memory.memoryStore,
  /* 角色 spec 与凭据：与 runtimeInterpretation 同一对进程级依赖。 */
  registry: registry,
  credentialAccess: productionCredentialAccess,
  logger: (level, event, fields) => log(level, event, fields)
});
const runtimeRecall = createRuntimeRecall({
  memoryRetrieval: memory.memoryRetrieval,
  memoryStore: memory.memoryStore,
  registry,
  sessionState: recallSessionState,
  /* 词汇表条目来源：两个装配路径都必须**有能力**接上它（buildHomeNode 侧
     由 options.glossaryProvider / options.getGlossaryEntries 注入）。
     生产侧今天**没有**任何来源 —— 桌面 wrapper 与 Node wrapper 都没有真的
     provider，因此 glossary 通道在两侧都是 dormant 的。这里显式写着"缺席"，
     而不是让读者以为忘了接线；请求侧出现 glossary* 一律被逐名拒绝，
     所以"浏览器提交词表"这条路不存在。 */
  glossaryProvider: undefined,
  getGlossaryEntries: undefined,
  /* P21-R4-LIVE-4 · 进程级的 post-recall hook：与 buildHomeNode 那一行逐字同源。
     少了它，真实进程上"自动解释"这条路径整体不存在，而所有 buildHomeNode 的
     测试全绿 —— 正是本文件已经记过五次的那种装配缺口。 */
  interpretation: runtimeInterpretation,
  /* P21-R4-LIVE-5 · 进程级的期望兄弟依赖（与 buildHomeNode 那一行逐字同源）。 */
  expectation: runtimeExpectation,
  behaviorEffect: runtimeBehaviorEffect,
  logger: (level, event, fields) => log(level, event, fields)
});
/* P11-3E：进程级 Moments 探针。openAll() 写它、/health 与 /moments/* 读它。
   这是**唯一**一处持有"最后那次开库事故"的地方（与 buildHomeNode 各自持有一个
   实例，但两边的分类器是同一份代码 —— 那是分类的唯一来源）。 */
const momentStoreFailureProbe = createMomentStoreFailureProbe(moments.momentsStore);
const gateway = gatewayAssembly({
  store,
  sessionState: recallSessionState,
  registry,
  executor,
  memoryStore: memory.memoryStore,
  memoryRetrieval: memory.memoryRetrieval,
  understandingStore: understanding.understandingStore,
  understandingRetrieval: understanding.understandingRetrieval,
  understandingDerivation: understanding.understandingDerivation,
  momentsStore: moments.momentsStore,
  momentsRetrieval: moments.momentsRetrieval,
  momentStoreFailure: momentStoreFailureProbe,
  modelPort: port,
  version: productVersion(),
  mobileOrigins: MOBILE_ORIGINS,
  loopbackBind: LOOPBACK_BIND,
  lanAddress: lanAddress,
  listenPort: PORT,
  logger: (level, event, fields) => log(level, event, fields)
});
const httpLayer = createHttp({
  store,
  executor,
  gateway,
  token: TOKEN,
  /* P22-23：凭据的来源与自动 provisioning 事实上交给传输层 —— 只有它才能
     回答"bootstrap 交付面该不该开"。**生产路径与 buildHomeNode 必须写同一份
     事实**，这正是本文件已经记过三次的同一种病（装配了两条路径，其中一条
     漏了一个字段，于是只有生产上出现缺口）。 */
  desktopCredentialSource: TOKEN_SOURCE,
  desktopCredentialAutoProvision: TOKEN_SOURCE === desktopCredential.SOURCE.GENERATED,
  version: productVersion(),
  allowedOrigins: ALLOWED_ORIGINS,
  /* P11-3H · 合作停止面。装在 http 层**内部**（而不是在 server 上再挂一个
     request listener）：http 层才是这条请求的最后一站，挂在外面会让两层都尝试
     应答同一个 `/__shutdown` —— 实测症状是日志里出现
     `unhandled … Cannot write headers after they are sent to the client`。
     这里只传一个**取值器**：route 在下面的 `installHomeNodeStopRoute()` 里创建，
     而它需要已经在同一个作用域里的 teardown()。http 层拿不到取值器（或它返回
     null）时，这个分支整体不存在 —— 修复前的语义逐字保留。 */
  stopRoute: () => homeNodeStop.route,
  /* P11-3E：与 buildHomeNode 逐字同款 —— 分类器 + canonical store 清单。
     "两条路径两套装配必然漂移"是这个文件里已经写过两次的教训（memory 一次、
     understanding 一次），所以这里连参数形状都不另写。 */
  classifyFailure: dbFailure.classify,
  isDatabaseError: dbFailure.isDatabaseError,
  momentStore: moments.momentsStore,
  momentStoreFailure: momentStoreFailureProbe,
  /* P22-2：**这一行就是真实子进程测试抓到的那个缺口。**
     openAll() 打开 Economy store 只证明"账本可用"；而 http 层要服务
     /economy/* 还必须**拿到这个实例**。实测（tests/test_p22_2_economy_runtime.js
     D2，修复前）：子进程日志里明明有 economy-opened，而
     GET /economy/health 回的是 501 economy-not-assembled ——
     两个事实同时为真，正是 P11-3E 那个缺口的第四次形态。
     单元测试与直接 store 测试全绿，缺的只是这一行接线。 */
  economyStore: economy.economyStore,
  /* P22-11：**进程级**的 command 通道。这一行与上面那行一样，是
     "生产启动路径上真的有一条可用的 command 面"的机器可读形式 ——
     通道的存在不等于它是**开**的（open 取决于来源登记册），
     因此 /security 的 commandChannel.open 才是那个诚实的答案。 */
  economyCommand: economy.economyCommandChannel,
  /* P22-13：**进程级**的 Approval Decision Seam。与上面那一行逐字同源 ——
     它是"生产启动路径上真的有一个用户决定入口"的机器可读形式，而它的
     开/关由凭据决定（未配置 IB_HOME_NODE_TOKEN ⇒ 整面 403），
     因此 /security 的 economyPolicy.approvalDecision.open 才是诚实的答案。 */
  economyApprovalDecision: economy.economyApprovalDecision,
  /* P22-14：**进程级**的 Configuration Seam。与上面那一行逐字同源 ——
     它是"生产启动路径上真的有一个 fresh-install 配置入口"的机器可读形式，
     而它的开/关由凭据与三个 store 入口是否齐全共同决定，
     因此 /security 的 economyPolicy.configuration.open 才是诚实的答案。 */
  economyConfiguration: economy.economyConfiguration,
  /* ── P21-R4-LIVE-2.1：**进程级**的 Runtime Interpretation ──────────────
     这一行与 buildHomeNode 里那一行逐字同源，而它正是"生产启动路径上真的
     有一条可用的解释面"的机器可读形式。★ 没有它，上面的构造函数只是一个
     没人引用的对象：路由分支不存在、日志里永远不会出现一行
     runtime-interpretation，而单元测试全绿（本文件已经记过四次同一种病）。 */
  runtimeInterpretation: runtimeInterpretation,
  /* ── P21-R4-LIVE-3.3：**进程级**的 Runtime Recall ──────────────────────
     这一行与 buildHomeNode 里那一行逐字同源，而它正是"生产启动路径上真的
     有一条可用的召回面"的机器可读形式。★ 没有它，上面的构造函数只是一个
     没人引用的对象：路由分支不存在、日志里永远不会出现一行 runtime-recall，
     而单元测试全绿（本文件已经记过多次同一种病）。 */
  runtimeRecall: runtimeRecall,
  runtimeExpectation: runtimeExpectation,
  runtimeBehaviorEffect: runtimeBehaviorEffect,
  /* P22-9：**进程级**的门。它与 store 同级导出，理由逐字相同 —— 门的缺席
     在生产上是一个静默的"每个 consumer 都能直接提议"，而那种缺口只有
     直接断言语料才能发现。 */
  economyCapabilityGate: economy.economyCapabilityGate,
  /* P22-10：**进程级**的 Action Adapter。这一行是"生产启动路径上真的有一个
     Agent 动作面"的机器可读形式：P22-9 导出的门在 P22-10 之前**没有任何
     production 调用方 bind 过它**，于是"谁被授予了 PROPOSE_PURCHASE"
     只是一个声明。这里是那个声明第一次被实例化的地方。 */
  economyActionAdapter: economy.economyActionAdapter,
  stores: [
    { store, name: 'chat', role: 'canonical-chat-authority' },
    { store: moments.momentsStore, name: 'moments', role: 'canonical-moments-authority', probe: momentStoreFailureProbe }
  ],
  /* 与 buildHomeNode 同一条谓词（进程级实例）。这里的注册表要等 openAll()
     才打开，所以更必须是函数而不是布尔。 */
  allowRemote: () => !LOOPBACK_BIND && deviceAuthReady(registry).ready,
  logger: (level, event, fields) => log(level, event, fields)
});
const server = httpLayer.server;

/* ── P11-3H · the cooperative stop surface ────────────────────────────────
 *
 * The stop route has to be created AFTER `server` exists (its teardown closes
 * that server) and its `stop` action has to be the SAME teardown the signal
 * path uses. So the route is a module-level box that the http layer reads
 * through a getter, and `installHomeNodeStopRoute()` fills it in — called from
 * the production start path below, and callable by a test that builds its own
 * instance without turning it into a process.
 *
 * The path is `/__shutdown`: the same one the static server has exposed since
 * P7, and the same one declared for every component in
 * runtime/component-registry.js. Nothing new is invented here.
 */
const homeNodeStop = { route: null, teardown: null };

function installHomeNodeStopRoute(teardownFn, opts) {
  const o = opts || {};
  if (homeNodeStop.route) return homeNodeStop.route;
  homeNodeStop.teardown = teardownFn;
  /* P11-3H：这里的判定来自 runtime/service-control.js 的 createStopDispatch()，
     由 http 层在**它自己的 dispatch 里**、在凭据/来源规则之前调用
     （services/home-node/http.js 的 route()）。不在这里做任何来源或方法判定：
     那是共享模块的唯一职责，抄一份到这里就会变成第二个实现。 */
  homeNodeStop.route = serviceControl.createStopDispatch({
    service: 'internal-beyond-home-node',
    stop: () => teardownFn('http'),
    onAccepted: info => log('info', 'stop-requested', { via: 'http', pid: info.pid }),
    onStopped: result => log('info', 'stop-complete', {
      steps: (result && result.steps) || null,
      errors: (result && result.errors && result.errors.length) ? result.errors : null
    })
  });
  return homeNodeStop.route;
}

/* 让调用方（测试与诊断）能构建一个"已打开 + 已接好网关"的完整实例。
   打开顺序与 buildHomeNode().open() 一致：chat store 先开（它负责损坏隔离，
   会给坏库改名），memory store 与设备表同库、必须等隔离完成之后再连。
   M1-C.2m：理解 store 也在同一批里打开 —— 漏掉它不会抛错，只会让
   /understanding/* 全部返回 store-closed，而那种症状很容易被读成"路由没注册"。

   P11-3E：Moments store 是**第三次**出现同一个缺口，而且这次它的症状最隐蔽 ——
   P11-3X-B / 3X-C 实测：production 的 openAll() 从来没打开过它，于是 23118 上
   `/moments/list` 回 503、`/moments/record` POST 抛 500，而所有 Moments 测试
   都直接 `createMomentsStore()`（绕过启动路径）因此全绿。这里补上它，并用
   tests/test_p11_3e_moments_canonical_closure.js 对**真实子进程**下断言。 */
function openAll() {
  const opened = store.open();
  memory.memoryStore.open();
  understanding.understandingStore.open();
  openMomentStore(moments.momentsStore, momentStoreFailureProbe);
  registry.open();
  /* P22-2：Economy store 必须在这里被**真的打开**。它会抛错（schema 过新 /
     库不可写），而那时 require.main 的 catch 会如实退出 —— 一个打不开的
     canonical 账本不该被静默降级成"余额 0"。 */
  economy.economyStore.open();
  /* P22-25：与 buildHomeNode().open() 走**同一个**调用点。 */
  applyCatalogBootstrap(economy.economyStore);
  return opened;
}

/* require.main guard：测试可以直接 require 本模块并使用 createStore/createHttp，
   只有真正被当作入口运行时才监听端口。 */
if (require.main === module) {
  /* ── P22-23 · 凭据硬门（fail closed）──────────────────────────────
     走到这里意味着凭据 authority **失败了**：一个既有的凭据文件读不动 /
     内容坏了，或者生成后落盘失败。这两种情况的共同点是"我们无法确定这台
     机器的凭据是什么"，而唯一比它更糟的选择是**假装它不存在**继续启动 ——
     服务会健康地监听、读面照常可达，而每一条写路径都回答 503。用户看到的是
     "Economy 用不了"，日志里没有任何一行说明为什么。

     因此这里拒绝启动并指名那个文件。这不是把 Home Node 变成一个脆弱组件：
     失败的原因只有一个可执行的下一步（检查/删除那个文件），而 runnner 会把
     Home Node 的缺席记为 degraded 而不是 fatal（runtime/local-services-runner.js:157），
     桌面主 UI 不受影响。

     ★ 只有**显式设置过** env 部署才退回旧姿态：那是运维方明确的部署决策，
       我们不去推翻它。判据取自凭据 authority 自己解析出来的来源，而不是
       在这里再读一次 env —— "这台机器的凭据是什么"只能有一个答案，多读
       一次就是给第二个答案留了一个位置。 */
  if (!CREDENTIAL.ok && CREDENTIAL.source !== desktopCredential.SOURCE.ENV) {
    console.error('Home Node could not establish its desktop credential (' +
      CREDENTIAL.reason + '): ' + (CREDENTIAL.message || '') +
      ' — inspect or remove ' + CREDENTIAL.file +
      '. A node that cannot say what its desktop credential is must not serve.');
    process.exit(1);
  }
  let openResult = null;
  try { openResult = openAll(); }
  catch (error) {
    /* SQLite 不可用 / schema 过新 / 设备注册表打不开 → 明确失败退出。
       浏览器侧会把「Home Node 不在线」判为 degraded 并走兼容回退，
       因此这里失败不会阻塞桌面主 UI（P2 纪律）。

       **但非 loopback 绑定时理由必须说清楚**：数据目录问题导致的启动失败
       与"我们不让你在没有设备鉴权的情况下监听 LAN"是两回事，用户看到的
       应当是后者那条可执行的规则（改绑 127.0.0.1 或修数据目录），
       而不是一句笼统的"打不开库"。 */
    if (!LOOPBACK_BIND) {
      console.error('Home Node refuses to listen on ' + HOST + ': its device registry could not be opened, ' +
        'so LAN clients could not be authenticated. Bind 127.0.0.1 or fix the data directory. — ' +
        String((error && error.message) || error));
      process.exit(1);
    }
    console.error('Home Node failed to open its canonical store: ' + (error && error.message || error));
    process.exit(1);
  }

  /* **硬门**：非 loopback 绑定要求设备鉴权子系统已经就绪。
     这里有两层，刻意分开：
       · registry 打不开 → 直接拒绝启动（上面已经退出到这里）；
       · registry 打开了但鉴权路径回答不了（探针不通过）→ **不退出**：
         服务只服务 loopback，并把"远端会被拒"的原因写进日志。
     第二层不退出是刻意的：一个坏掉的鉴权子系统不该让本机用户连不上
     自己的 Home Node，而"远端一律拒绝"本身就是安全的失败方向。 */
  if (!LOOPBACK_BIND) {
    if (!registry.isOpen()) {
      console.error('Home Node refuses to listen on ' + HOST + ': the device registry is not available, ' +
        'so LAN clients could not be authenticated. Bind 127.0.0.1 or fix the data directory.');
      process.exit(1);
    }
    const authState = deviceAuthReady(registry);
    log('info', 'lan-bind-enabled', {
      host: HOST, port: PORT, deviceAuth: 'required',
      allowRemote: authState.ready, deviceAuthProbe: authState.reason,
      lanAddress: lanAddress() || null
    });
    if (!authState.ready) {
      console.error('Home Node is listening on ' + HOST + ' but will refuse every non-loopback request (' +
        authState.reason + '). Only 127.0.0.1 clients are served.');
    }
  }

  server.listen(PORT, HOST, () => {
    const authState = deviceAuthReady(registry);
    const remoteOpen = !LOOPBACK_BIND && authState.ready;
    log('info', 'listening', {
      host: HOST, port: PORT, db: store.file, schema: store.schemaVersion,
      tokenRequired: !!TOKEN, loopbackOnly: !remoteOpen,
      /* P22-23：凭据**从哪来**是这条日志最要紧的一栏。以前它只有
         tokenRequired 一个布尔，于是"没配"与"配了但来源不明"看起来一样，
         而排查"为什么配置面是 503"的第一步正是这个问题。
         ★ 只有来源 / 长度 / 指纹，凭据本体**绝不**进日志。 */
      credentialSource: TOKEN_SOURCE,
      credentialLength: CREDENTIAL.ok ? CREDENTIAL.length : 0,
      credentialFingerprint: CREDENTIAL.ok ? CREDENTIAL.fingerprint : null,
      credentialGeneratedNow: CREDENTIAL.generatedNow === true,
      /* 如实区分三种状态：只服务本机 / 远端可达但每次都要设备 token / 远端一律拒绝。 */
      remoteClients: LOOPBACK_BIND ? 'refused (loopback bind)' : (remoteOpen ? 'device-token-required' : 'refused (' + authState.reason + ')'),
      /* P11-3A：凭据铸造面（配对 / 设备 / 目录发布）在未配置桌面 token 时是关的。
         把这件事写进启动日志，是为了让"为什么配对用不了"有一个可查的答案，
         而不是让用户对着一个 403 猜。
         P22-23：措辞跟着事实改了 —— 正常桌面启动**不再**需要用户去设环境变量，
         因此这里说的是凭据的来源，而不是一条让用户去执行的指令。 */
      credentialMinting: TOKEN
        ? ('enabled (desktop credential configured via ' + TOKEN_SOURCE + ')')
        : 'disabled (no desktop credential: set IB_HOME_NODE_TOKEN or allow first-run provisioning)',
      mobileGateway: '/mobile/v1', deviceAuth: 'per-device'
    });
  });

  server.on('error', error => {
    console.error('Home Node could not listen on ' + HOST + ':' + PORT + ' — ' + (error && error.message || error));
    process.exit(1);
  });

  let shuttingDown = false;

  /* ── P11-3H · the one teardown ladder ──────────────────────────────────
     修复前这段代码只挂在 SIGINT/SIGTERM 上，而 Windows 上这两个信号**永远不会
     被投递**：`child.kill('SIGTERM')` 就是 TerminateProcess。实测（P11-3H Phase 1，
     真实本文件 + 私有端口 + 私有数据目录）：

       process.kill(pid, 'SIGTERM') → 进程 0ms 内消失
       数据目录                      → home-node.db-wal 仍有 440 KB
       stdout                        → 没有 {"event":"shutdown"} 这一行

     端口会被释放、WAL 会在下次开库时恢复，所以数据没有丢 —— 但
     gateway.stop / derivation.stop / 各 store 的 close 一次都没跑，"这个组件
     是不是干净地停下来的"变得无法回答。

     现在这段拆除动作同时挂在**两条**路径上，而且是同一份代码：
       · HTTP：POST /__shutdown（runtime/service-control.js）—— 在 Windows 上
         这是唯一真正会到达的路径；
       · 信号：SIGINT/SIGTERM —— POSIX 上仍然有效，保持不变。
     两条路径都返回 steps/errors，因此"哪一步真的跑了"是可断言的，而不是靠日志猜。

     顺序是有负载的，逐条保留原注释的理由：先停网关（它会清掉事件泵与订阅者），
     再关两个数据库连接；理解派生器的调度器要先停，再关理解 store；
     memory store 与 chat store 同库，先关 memory 再关 chat，与打开顺序相反。 */
  async function teardown(reason) {
    if (shuttingDown) return { ok: true, alreadyStopped: true, steps: [], errors: [] };
    shuttingDown = true;
    log('info', 'shutdown', { reason: String(reason || 'signal'), revision: store.getRevision() });
    const result = await serviceControl.runStop('homeNode', {
      entering: () => { /* shuttingDown 已置位；重复停止是 no-op */ },
      stopWork: () => {
        try { server.close(); } catch (_) { /* 已关闭 */ }
        try { gateway.stop(); } catch (_) { /* 已停止 */ }
      },
      stopTimers: () => {
        try { if (understanding.understandingDerivation) understanding.understandingDerivation.stop(); } catch (_) { /* 未启动 */ }
      },
      closeStores: () => {
        try { understanding.understandingStore.close(); } catch (_) { /* 已关闭 */ }
        try { moments.momentsStore.close(); } catch (_) { /* 已关闭 */ }
        try { economy.economyStore.close(); } catch (_) { /* 已关闭 */ }
        try { registry.close(); } catch (_) { /* 已关闭 */ }
        try { memory.memoryStore.close(); } catch (_) { /* 已关闭 */ }
        try { store.close(); } catch (_) { /* 已关闭 */ }
      },
      report: () => {
        /* 每关闭一个 canonical store 都会自己写一行 `closed`，
           因此这里只记录"拆除完成"这一事实本身。 */
        log('info', 'stopped', { reason: String(reason || 'signal') });
      }
    });
    return result;
  }
  /* 信号路径：拆完自己退出（行为与修复前逐字一致，只是拆除本身被抽出来复用）。 */
  function shutdown(reason) {
    teardown(reason).then(() => { setTimeout(() => process.exit(0), 20); })
      .catch(() => { setTimeout(() => process.exit(0), 20); });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', error => {
    log('error', 'uncaught-exception', { error: String((error && error.stack) || error).slice(0, 800) });
  });
  process.on('unhandledRejection', reason => {
    log('error', 'unhandled-rejection', { error: String((reason && reason.stack) || reason).slice(0, 800) });
  });

  /* HTTP 停止面：与信号路径共用 teardown()，退出由停止面统一负责。
     它被装在 http 层**内部**（见上方 stopRoute 的注释），因此这个请求只会被
     应答一次 —— 提前 return 的那条 req 由 http 层的路由链处理，重复应答在
     实测里表现为 "Cannot write headers after they are sent to the client"。 */
  installHomeNodeStopRoute(teardown);
}

module.exports = {
  store,
  registry,
  gateway,
  executor,
  server,
  httpLayer,
  /* M1-C.2d Wave 2：**进程级**（= 生产启动路径）的 canonical memory 实例。
     导出它是为了让"production assembly 与 buildHomeNode assembly 不得再次漂移"
     可以被真实断言，而不是靠读代码（见 tests/test_home_node_production_memory_assembly.js）。 */
  memoryStore: memory.memoryStore,
  memoryRetrieval: memory.memoryRetrieval,
  /* P11-3E：**进程级**（= 生产启动路径）的 canonical Moments 实例，理由与上面
     memory 那两行逐字相同。这一域已经**两次**被同一个缺口咬到（memory 一次、
     understanding 一次），而这一次的形态最隐蔽：store 装配好了、网关接线了，
     只是 openAll() 没打开它 —— 于是所有直接 createMomentsStore() 的测试全绿。
     把它们导出来，"生产侧到底有没有一个可用的 Moments authority"就成了一句话
     可以断言的事实（见 tests/test_p11_3e_moments_canonical_closure.js A/B/C）。 */
  momentsStore: moments.momentsStore,
  momentsRetrieval: moments.momentsRetrieval,
  momentsAssembly,
  canonicalMomentsDeps,
  /* P22-2：**进程级**（= 生产启动路径）的 canonical Economy 实例。
     导出理由与上面 memory/moments 那几行逐字相同 —— 这一域已经被同一个
     缺口咬过**三次**（memory / understanding / moments 都出现过"装配好了
     但 openAll() 没打开它"），因此"生产侧到底有没有一个打开的 Economy
     authority"必须是一句可以直接断言的事实，而不是靠读代码。
     见 tests/test_p22_2_economy_runtime.js 的 C/D 组。 */
  economyStore: economy.economyStore,
  /* P22-9：进程级的门与进程级的 store 一起导出。 */
  economyCapabilityGate: economy.economyCapabilityGate,
  /* P22-10：进程级的 Action Adapter（= 生产侧"Agent 能不能提议"的唯一答案）。 */
  economyActionAdapter: economy.economyActionAdapter,
  /* P22-11：进程级的 command 通道（= 生产侧"Active 能不能把一条话语送进来"
     的唯一答案）。它导出的**不是**一条路由，而是那个能到达适配器的对象；
     路由由 http.js 从 buildHomeNode() 的 deps 里拿到。 */
  economyCommandChannel: economy.economyCommandChannel,
  /* P22-13：进程级的 Approval Decision Seam（= 生产侧"用户能不能对一条
     等待中的 intent 点头/摇头"的唯一答案）。与上面那一行同级导出：
     它同样**不是**一条路由，而是那个能到达 P22-7 与 P22-9 句柄的对象。 */
  economyApprovalDecision: economy.economyApprovalDecision,
  /* P22-14：进程级的 Configuration Seam（= 生产侧"fresh install 能不能在不改
      代码、不碰 SQLite 的前提下被配到可运行"的唯一答案）。
      ★ 与上面那一行同级导出，但它是**另一条**路径、**另一份**词表：把两者
      合成一个导出会掩盖"这是两种权威"。 */
  economyConfiguration: economy.economyConfiguration,
  /* P21-R4-LIVE-2.1：**进程级**的 Runtime Interpretation（= 生产侧"这条路
     存在吗、它开不开"的唯一答案）。导出理由与上面每一个域逐字相同：这一域
     还没有被咬过，但"两条装配路径只接一条"在本文件已经发生过**四次**
     （memory / understanding / moments / economy），所以它的形式必须是可
     直接断言的，而不是靠读代码。 */
  runtimeInterpretation,
  /* P21-R4-LIVE-3.3：**进程级**的 Runtime Recall（= 生产侧"这台节点到底有
     没有一条运行时召回面"的唯一答案）。导出理由与上面每一个域逐字相同 ——
     这一域的接线**同时**落在 buildHomeNode 与 require.main 两条路径上，
     而"只接一条"在本文件已经发生过多次。 */
  runtimeRecall,
  defaultEconomyChannelSources,
  economyAssembly,
  buildHomeNode,
  memoryAssembly,
  canonicalMemoryDeps,
  openAll,
  installHomeNodeStopRoute,
  homeNodeStop,
  lanAddress,
  isLoopbackHost,
  deviceAuthReady,
  AUTH_PROBE_TOKEN,
  HOST,
  PORT,
  DATA_DIR,
  /* P22-23：进程级的凭据 authority 与它的诊断投影。
     ★ 导出的是**描述**（来源 / 长度 / 指纹 / 原因），不是凭据本体 ——
       "凭据从哪来"必须是一句可以直接断言的事实，而"凭据是什么"不需要
       经过这个导出被任何人看到（测试要验它时自己按来源去读那个文件）。 */
  credentialAuthority: desktopCredential,
  credentialDescription: desktopCredential.describeCredential(CREDENTIAL),
  credentialSource: TOKEN_SOURCE,
  LOOPBACK_BIND,
  MOBILE_ORIGINS,
  SERVICE_VERSION,
  productVersion,
  redact
};
