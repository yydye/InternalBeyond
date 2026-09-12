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
const createNodeModelPort = require('../active/node-model-port.js');
/* M1-C.2i · canonical Middle Brain 的 Node 宿主适配（不是第二份实现：
   它 require assets/js 下那五层 + facade，只补宿主 shim 与配置注入）。 */
const createNodeMiddleBrain = require('../services/home-node/middle-brain.js');

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
const TOKEN = String(process.env.IB_HOME_NODE_TOKEN || '');
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

/* ── 网关装配（**唯一**一处）─────────────────────────────────────────
   与 memoryAssembly 同一个理由：网关的依赖集合只能有一份定义。
   生产启动路径与 buildHomeNode() 都调用它，因此"某个 canonical 域没有接线"
   不可能只在一侧发生。 */
function gatewayAssembly(options) {
  const memory = canonicalMemoryDeps(memoryAssembly({
    dataDir: options.dataDir,
    memoryStore: options.memoryStore,
    memoryRetrieval: options.memoryRetrieval,
    clock: options.clock,
    random: options.random,
    logger: options.logger
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
  return createMobileGateway(Object.assign({
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
  const serviceLog = options.logger || ((level, event, fields) => log(level, event, fields));
  const instanceStore = options.store || createStore({ dataDir: dataDir, logger: (e, f) => serviceLog('info', e, f) });
  /* M1-C.2d Wave 2：canonical `memories`（与 chatMessages 同一个 SQLite 文件，
     但拥有**自己的** revision / change_log 命名空间 —— 见 memory-store.js 头部）。
     刻意晚于 chat store 打开：chat store 负责损坏隔离（会给坏库改名），
     同一文件上的第二个 opener 不能去 rename 它。 */
  const memoryDeps = canonicalMemoryDeps(memoryAssembly({
    dataDir: dataDir,
    memoryStore: options.memoryStore,
    memoryRetrieval: options.memoryRetrieval,
    clock: options.clock,
    random: options.random,
    logger: serviceLog
  }));
  const instanceMemoryStore = memoryDeps.memoryStore;
  const instanceMemoryRetrieval = memoryDeps.memoryRetrieval;
  const instanceRegistry = options.registry || createDeviceRegistry({ dataDir: dataDir, logger: (e, f) => serviceLog('info', e, f) });
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
    clock: options.clock,
    logger: serviceLog
  });
  const host = options.host || HOST;
  const loopbackBind = isLoopbackHost(host);
  /* M1-C.2n：动态域的挂载点。与理解域同款位置与理由（同一 dataDir、
     同一 store 实例共享给网关，装配守卫在 gatewayAssembly 里强制）。 */
  const instanceMoments = options.moments || momentsAssembly({
    dataDir: dataDir,
    momentsStore: options.momentsStore,
    momentsRetrieval: options.momentsRetrieval,
    store: instanceStore,
    clock: options.clock,
    logger: serviceLog
  });
  /* 与进程级启动路径**共用** gatewayAssembly（见其头部说明：两条路径两套装配
     必然漂移，memoryStore 就是这样在 production 上丢过一次）。 */
  const instanceGateway = options.gateway || gatewayAssembly({
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
    version: options.version || productVersion(),
    allowedOrigins: options.allowedOrigins || ALLOWED_ORIGINS,
    /* LAN 门：显式非 loopback 绑定 **且** 设备鉴权此刻真的就绪。
       刻意传**函数**：http 层在这里被构造时 open() 还没发生（见下面 open()），
       固化成布尔就等于把"注册表一定会成功打开"这个尚未证实的假设写进安全决策。
       刻意**不提供**任何覆盖入口：这是一个安全谓词，唯一合法的回答来自
       deviceAuthReady() 的真实探针。 */
    allowRemote: () => !loopbackBind && deviceAuthReady(instanceRegistry).ready,
    logger: serviceLog
  });
  /* 打开顺序有语义：chat store 先开（它负责损坏隔离 —— 会给坏库改名），
     设备表与它同库，必须等隔离完成之后再连。 */
  function open() {
    const openedStore = instanceStore.open();
    instanceMemoryStore.open();
    instanceUnderstanding.understandingStore.open();
    instanceMoments.momentsStore.open();
    instanceRegistry.open();
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
    try { instanceMemoryStore.close(); } catch (_) { /* 已关闭 */ }
    try { instanceStore.close(); } catch (_) { /* 已关闭 */ }
  }
  return {
    store: instanceStore,
    memoryStore: instanceMemoryStore,
    memoryRetrieval: instanceMemoryRetrieval,
    understandingStore: instanceUnderstanding.understandingStore,
    understandingRetrieval: instanceUnderstanding.understandingRetrieval,
    understandingDerivation: instanceUnderstanding.understandingDerivation,
    momentsStore: instanceMoments.momentsStore,
    momentsRetrieval: instanceMoments.momentsRetrieval,
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
const memory = memoryAssembly({
  dataDir: DATA_DIR,
  logger: (level, event, fields) => log(level, event, fields)
});
const registry = createDeviceRegistry({
  dataDir: DATA_DIR,
  logger: (event, fields) => log('info', event, fields)
});
/* M1-C.2m：进程级启动路径同样必须挂上理解域 —— 与 memory 那次教训逐字同形
   （只接 buildHomeNode 会让 23118 上的 /understanding/* 全 501，而测试全绿）。
   modelPort 复用进程级 port：派生与回合走同一条 wire 层。 */
const understanding = understandingAssembly({
  dataDir: DATA_DIR,
  memoryStore: memory.memoryStore,
  registry,
  modelPort: port,
  logger: (level, event, fields) => log(level, event, fields)
});
/* M1-C.2n：进程级启动路径同样必须挂上动态域 —— 与理解域那次教训逐字同形
   （只接 buildHomeNode 会让网关在 Home Node 上看不到任何动态，而测试全绿）。 */
const moments = momentsAssembly({
  dataDir: DATA_DIR,
  store,
  logger: (level, event, fields) => log(level, event, fields)
});
const gateway = gatewayAssembly({
  store,
  registry,
  executor,
  memoryStore: memory.memoryStore,
  memoryRetrieval: memory.memoryRetrieval,
  understandingStore: understanding.understandingStore,
  understandingRetrieval: understanding.understandingRetrieval,
  understandingDerivation: understanding.understandingDerivation,
  momentsStore: moments.momentsStore,
  momentsRetrieval: moments.momentsRetrieval,
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
  version: productVersion(),
  allowedOrigins: ALLOWED_ORIGINS,
  /* 与 buildHomeNode 同一条谓词（进程级实例）。这里的注册表要等 openAll()
     才打开，所以更必须是函数而不是布尔。 */
  allowRemote: () => !LOOPBACK_BIND && deviceAuthReady(registry).ready,
  logger: (level, event, fields) => log(level, event, fields)
});
const server = httpLayer.server;

/* 让调用方（测试与诊断）能构建一个"已打开 + 已接好网关"的完整实例。
   打开顺序与 buildHomeNode().open() 一致：chat store 先开（它负责损坏隔离，
   会给坏库改名），memory store 与设备表同库、必须等隔离完成之后再连。
   M1-C.2m：理解 store 也在同一批里打开 —— 漏掉它不会抛错，只会让
   /understanding/* 全部返回 store-closed，而那种症状很容易被读成"路由没注册"。 */
function openAll() {
  const opened = store.open();
  memory.memoryStore.open();
  understanding.understandingStore.open();
  registry.open();
  return opened;
}

/* require.main guard：测试可以直接 require 本模块并使用 createStore/createHttp，
   只有真正被当作入口运行时才监听端口。 */
if (require.main === module) {
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
      /* 如实区分三种状态：只服务本机 / 远端可达但每次都要设备 token / 远端一律拒绝。 */
      remoteClients: LOOPBACK_BIND ? 'refused (loopback bind)' : (remoteOpen ? 'device-token-required' : 'refused (' + authState.reason + ')'),
      mobileGateway: '/mobile/v1', deviceAuth: 'per-device'
    });
  });

  server.on('error', error => {
    console.error('Home Node could not listen on ' + HOST + ':' + PORT + ' — ' + (error && error.message || error));
    process.exit(1);
  });

  let shuttingDown = false;
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutdown', { reason: String(reason || 'signal'), revision: store.getRevision() });
    try { server.close(); } catch (_) { /* 已关闭 */ }
    /* 先停网关（它会清掉事件泵与订阅者），再关两个数据库连接。
       顺序反过来会让事件泵在一个已关闭的连接上查询。 */
    try { gateway.stop(); } catch (_) { /* 已停止 */ }
    /* M1-C.2m：理解派生器的调度器要先停（它会在 tick 里读 store），
       再关理解 store —— 留下一个仍排队的 timer 去读已关闭的库只会产生噪音错误。 */
    try { if (understanding.understandingDerivation) understanding.understandingDerivation.stop(); } catch (_) { /* 未启动 */ }
    try { understanding.understandingStore.close(); } catch (_) { /* 已关闭 */ }
    try { registry.close(); } catch (_) { /* 已关闭 */ }
    /* memory store 与 chat store 同库（同一 SQLite 文件），先关它再关 chat，
       与打开顺序相反 —— 反过来会让 memory 的连接留在一个已关闭的库上。 */
    try { memory.memoryStore.close(); } catch (_) { /* 已关闭 */ }
    try { store.close(); } catch (_) { /* 已关闭 */ }
    setTimeout(() => process.exit(0), 20);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', error => {
    log('error', 'uncaught-exception', { error: String((error && error.stack) || error).slice(0, 800) });
  });
  process.on('unhandledRejection', reason => {
    log('error', 'unhandled-rejection', { error: String((reason && reason.stack) || reason).slice(0, 800) });
  });
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
  buildHomeNode,
  memoryAssembly,
  canonicalMemoryDeps,
  openAll,
  lanAddress,
  isLoopbackHost,
  deviceAuthReady,
  AUTH_PROBE_TOKEN,
  HOST,
  PORT,
  DATA_DIR,
  LOOPBACK_BIND,
  MOBILE_ORIGINS,
  SERVICE_VERSION,
  productVersion,
  redact
};
