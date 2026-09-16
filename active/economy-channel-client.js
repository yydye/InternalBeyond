/* ====================================================================
   IB Active · Economy Command Channel client（P22-11 · 23114 → 23118 出站腿）
   --------------------------------------------------------------------
   位置：Active companion（端口 23114）**唯一**一条通向 Home Node 经济域的
   出站路径。它与 Home Node 侧的 handler 是**同一个**通道的两半，契约由
   services/home-node/economy-command-channel.js 一份持有（路径常量、信封键、
   command 词表、拒绝码都从那里取，这里一个字都不重写）。

   ── 为什么出站腿不需要一个新的传输框架（§1）─────────────────────────
   它用的就是既有 Home Node HTTP transport 的三件既有事实：
     · 同一个 loopback 目标（127.0.0.1:23118，与 home-node-client.js 同源约定）；
     · 同一个协议头（X-IB-Protocol: 1）；
     · 同一族凭据头（Home Node 的 X-IB-Home-Token 语义：只在服务端配置了
       token 时才强制）。本通道用自己的来源头 X-IB-Economy-Channel-Source，
       而它**只**在这条 command 路径上有意义 —— 于是启用它不需要改动任何
       既有路径的行为（既有面在未配置桌面 token 时保持原样）。
   ⇒ 因此这里没有第二套 transport：没有新的服务器、没有新的协议、
     没有新的信封形状。

   ── 凭据从哪来（且为什么它不在 payload 里）──────────────────────────
   来源凭据由**部署环境**提供（IB_ECONOMY_CHANNEL_TOKEN），与 Home Node
   侧同名的那个值成对。它：
     · 绝不出现在请求体里（§3：payload 不得自报身份）；
     · 绝不进日志（本文件不打任何含凭据的日志）；
     · 缺省时**不是**"走匿名"—— 默认配置为空，通道关闭，
       proposePurchase() 直接回答 TRANSPORT_FAILED / NOT_CONFIGURED。
   这与本仓库既有的 loopback 零门槛姿态是**两件不同的事**：那条是"本机
   单用户模型下的读取面"，而这条是一条**写**路径，因此它从第一天起就
   要求凭据。

   ── §8 · bounded timeout / bounded retry ──────────────────────────
   超时与重试上限都由通道契约持有（DEFAULT_TIMEOUT_MS /
   DEFAULT_MAX_ATTEMPTS / HARD_MAX_ATTEMPTS）。这里**不**提供"无限重试"
   这个选项，也不提供 retry 循环：循环在契约的 createEconomyCommandClient
   里，只有那**一个**实现。
   ==================================================================== */
'use strict';

/* 与 Home Node 侧同款：唯一一次 require，指向那**一份**通道契约。
   ★ 它 require 的不是 store、不是门、不是适配器 —— Active 的依赖闭包里
   依然没有任何经济事实面（P22-1 boundary B3/B7 对 Active 的断言不变）。 */
const CHANNEL = require('../services/home-node/economy-command-channel.js');

const ENV = Object.freeze({
  BASE: 'IB_ECONOMY_CHANNEL_BASE',
  TOKEN: 'IB_ECONOMY_CHANNEL_TOKEN',
  TIMEOUT_MS: 'IB_ECONOMY_CHANNEL_TIMEOUT_MS',
  MAX_ATTEMPTS: 'IB_ECONOMY_CHANNEL_MAX_ATTEMPTS',
  HOME_NODE_PORT: 'IB_HOME_NODE_PORT',
  /* ★ 出站 socket 要绑的本机端口 —— **必须与 Active 的监听端口分开**。
     这不是审美：Windows 上把一个客户端 socket 绑到**已经被监听**的端口
     会一直失败（实测 `bind EADDRINUSE 127.0.0.1:<IB_ACTIVE_PORT>`，三次
     就地重试都不行 —— 因为那不是 TIME_WAIT，而是"这个地址已经被占用"）。
     因此来源身份用的是**另一条**专用于出站的 loopback 端口：它被登记在
     Home Node 的来源表里（services/home-node-service.js 的
     defaultEconomyChannelSources 读**同一个键**），而没有任何人监听它 ——
     "登记并被使用"与"被监听"是两件事，而这条通道要的是前者。
     ★ 它仍然是**一个确定的值**（不是每次随机的临时端口），因此
     "未登记的端口 → 拒绝"这条断言依然成立。 */
  SOURCE_PORT: 'IB_ECONOMY_CHANNEL_SOURCE_PORT',
  ACTIVE_PORT: 'IB_ACTIVE_PORT'
});

/* ══ 环境 → 配置（唯一一处解释这些键）══════════════════════════════
   ★ 默认 target 与 assets/js/home-node-client.js 的 DEFAULT_BASE 同款
   （127.0.0.1:23118），端口同样可由 IB_HOME_NODE_PORT 注入 —— 与
   runtime/component-registry.js 的 homeNode.portEnv 是同一个键，
   因此测试与真实运行用的是同一条约定，而不是第二条。
   ★ token 缺席 ⇒ configured:false（fail closed），不抛错：一个没配
   通道的部署应该照常运行，只是提不出购买意图。 */
function configFromEnv(env) {
  env = env || {};
  const port = Number(env[ENV.HOME_NODE_PORT]);
  const defaultBase = 'http://127.0.0.1:' +
    (Number.isInteger(port) && port > 0 && port <= 65535 ? port : 23118);
  const base = String(env[ENV.BASE] || defaultBase).replace(/\/+$/, '');
  const explicitSource = Number(env[ENV.SOURCE_PORT]);
  const activePort = Number(env[ENV.ACTIVE_PORT]);
  /* ★ 来源端口优先取显式的专用键；没有它时**退回** Active 的端口，并如实
     在 describe() 里说这是退回（fallbackUsed）。退回不是"安全默认"，
     而是一个明说的兼容姿态：在没有专用键的部署上，通道会在第一次提议时
     以 EADDRINUSE 失败，而不是悄悄换一个没人登记的端口发出去。 */
  const sourcePort = Number.isInteger(explicitSource) && explicitSource > 0 && explicitSource <= 65535
    ? explicitSource
    : (Number.isInteger(activePort) && activePort > 0 && activePort <= 65535 ? activePort : undefined);
  return {
    base: base,
    token: String(env[ENV.TOKEN] || ''),
    timeoutMs: Number(env[ENV.TIMEOUT_MS]) || undefined,
    maxAttempts: Number(env[ENV.MAX_ATTEMPTS]) || undefined,
    sourcePort: sourcePort,
    sourcePortIsDedicated: Number.isInteger(explicitSource) && explicitSource > 0
  };
}

/* ══ 工厂：Active 侧的通道客户端 ═══════════════════════════════════ */
function createActiveEconomyChannelClient(options) {
  options = options || {};
  const fromEnv = configFromEnv(options.env || process.env);
  const client = CHANNEL.createEconomyCommandClient({
    base: options.base === undefined ? fromEnv.base : options.base,
    token: options.token === undefined ? fromEnv.token : options.token,
    timeoutMs: options.timeoutMs === undefined ? fromEnv.timeoutMs : options.timeoutMs,
    maxAttempts: options.maxAttempts === undefined ? fromEnv.maxAttempts : options.maxAttempts,
    /* ★ 出站端口绑定：Home Node 侧的来源登记册登记的是 Active 的端口，
       因此真实运行时必须从那条端口发出去 —— 否则那一半登记不生效。 */
    localPort: options.localPort === undefined ? fromEnv.sourcePort : options.localPort,
    fetch: options.fetch
  });

  function describe() {
    return Object.freeze(Object.assign({
      side: 'active',
      anchor: 'runtime/component-registry.js#active',
      consumerOnTheHomeNodeSide: CHANNEL.CONSUMER,
      envKeys: ENV,
      environmentDefaults: Object.freeze({ homeNodePort: 23118, base: 'http://127.0.0.1:23118' }),
      needsNoSecondTransportFramework: true,
      credentialNeverInPayload: true,
      credentialNeverLogged: true,
      bindsItsOutgoingSocketToTheRegisteredSourcePort: true,
      sourcePortIsDedicated: fromEnv.sourcePortIsDedicated === true,
      sourcePort: fromEnv.sourcePort == null ? null : fromEnv.sourcePort
    }, client.describe()));
  }

  return Object.freeze({
    path: client.path,
    configured: client.configured,
    proposePurchase: client.proposePurchase,
    /* ★ 显式命名的测试入口：生产链上**没有**任何调用方（见契约里
       sendCommand 的说明）—— 它的存在只是为了让"未知 command 会被
       服务端拒绝"这条不变量可以被跨进程地证明。 */
    sendCommand: client.sendCommand,
    createCommandIdentity: CHANNEL.createCommandIdentity,
    describe: describe,
    /* 通道契约本身也一并透出，供装配层/测试核对词表（不新增第二份）。 */
    contract: CHANNEL
  });
}

module.exports = createActiveEconomyChannelClient;
module.exports.createActiveEconomyChannelClient = createActiveEconomyChannelClient;
module.exports.configFromEnv = configFromEnv;
module.exports.ENV = ENV;
module.exports.CHANNEL = CHANNEL;
