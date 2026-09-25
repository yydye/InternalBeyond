'use strict';

/*
 * Internal Beyond — local Active Messages companion
 *
 * Runs a durable scheduler outside the browser. The browser explicitly syncs
 * only schedules whose "background_enabled" switch is on. Generated results
 * remain queued here until InternalBeyond.html imports and acknowledges them.
 *
 * Node.js 18+ is required (uses the built-in fetch implementation).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

if (typeof fetch !== 'function') {
  console.error('Internal Beyond Active Messages requires Node.js 18 or newer.');
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.IB_ACTIVE_PORT) || 23114));
const START_DELAY_MS = Math.max(500, Number(process.env.IB_ACTIVE_START_DELAY_MS) || 35000);
const DATA_DIR = process.env.IB_ACTIVE_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
    : path.join(os.homedir(), '.internal-beyond'));
const DATA_FILE = path.join(DATA_DIR, 'active-message-service.json');
const DATA_TEMP_FILE = `${DATA_FILE}.tmp`;
const DATA_BACKUP_FILE = `${DATA_FILE}.bak`;
const MAX_BODY = 4 * 1024 * 1024;
const PROACTIVE_MAX_ATTEMPTS = 3; // initial request + at most two regeneration attempts
const PROACTIVE_SIMILARITY_LIMIT = 0.82;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 持久化层（已提取到 active/persistence.js 工厂；state 为共享引用）    */
/* ------------------------------------------------------------------ */

const createPersistence = require('../active/persistence');
const persistence = createPersistence({ dataDir: DATA_DIR, getState: () => state });
let state = persistence.loadData();
const saveNow = persistence.saveNow;
const queueSave = persistence.queueSave;
const emptyData = persistence.emptyData;
const parseDataFile = persistence.parseDataFile;
const loadData = persistence.loadData;
const mutateTargetMetadata = persistence.mutateTargetMetadata;
const rollbackTargetMetadata = persistence.rollbackTargetMetadata;

let ticking = false;
/* Deliberately process-local: every service restart requires a fresh browser reconcile. */
const armedUsers = new Set();

/* ------------------------------------------------------------------ */
/* 计划域（已提取到 active/plan-domain.js 工厂；state 经 getState 注入） */
/* ------------------------------------------------------------------ */

const createPlanDomain = require('../active/plan-domain');
const planDomain = createPlanDomain({ getState: () => state, armedUsers, saveNow });
const pad = planDomain.pad;
const timeParts = planDomain.timeParts;
const atConfiguredTime = planDomain.atConfiguredTime;
const intervalMs = planDomain.intervalMs;
const nextRun = planDomain.nextRun;
const safePart = planDomain.safePart;
const runId = planDomain.runId;
const messageId = planDomain.messageId;
const trimText = planDomain.trimText;
const deepClone = planDomain.deepClone;
const sanitizeActiveSetting = planDomain.sanitizeActiveSetting;
const PLAN_MIN_DELAY_MS = planDomain.PLAN_MIN_DELAY_MS;
const PLAN_MAX_DELAY_MS = planDomain.PLAN_MAX_DELAY_MS;
const PLAN_MAX_LATE_MS = planDomain.PLAN_MAX_LATE_MS;
const PLAN_DEFAULT_MAX_ATTEMPTS = planDomain.PLAN_DEFAULT_MAX_ATTEMPTS;
const PLAN_STATUSES = planDomain.PLAN_STATUSES;
const sanitizeAiPlan = planDomain.sanitizeAiPlan;
const parsePlanJson = planDomain.parsePlanJson;
const isInDnd = planDomain.isInDnd;
const nextDndFree = planDomain.nextDndFree;
const planRunId = planDomain.planRunId;
const planMessageId = planDomain.planMessageId;
const publicPlan = planDomain.publicPlan;
const settingFromPlan = planDomain.settingFromPlan;
const planSnapshotTask = planDomain.planSnapshotTask;
const stableJson = planDomain.stableJson;
const hashValue = planDomain.hashValue;
const finiteTimestamp = planDomain.finiteTimestamp;
const settingControl = planDomain.settingControl;
const taskFingerprints = planDomain.taskFingerprints;
const ensureTaskMetadata = planDomain.ensureTaskMetadata;
const recordUserId = planDomain.recordUserId;
const sameRunRevision = planDomain.sameRunRevision;
const terminalRun = planDomain.terminalRun;
const replaceTaskRuntime = planDomain.replaceTaskRuntime;
const currentForRun = planDomain.currentForRun;
const cancelRun = planDomain.cancelRun;
const mergeRecentProactiveMessages = planDomain.mergeRecentProactiveMessages;
const buildTaskReplacement = planDomain.buildTaskReplacement;

/* ------------------------------------------------------------------ */
/* Proactive Observability v1：零决策 trace（IB_PROACTIVE_TRACE=on 才记录） */
/* ------------------------------------------------------------------ */

const createProactiveTrace = require('../active/proactive-trace');
const proactiveTrace = createProactiveTrace({
  enabled: String(process.env.IB_PROACTIVE_TRACE || '').trim().toLowerCase() === 'on',
  limit: 50
});

/* ------------------------------------------------------------------ */
/* 模型客户端（已提取到 active/model-client.js 工厂；getState / 常量注入） */
/* ------------------------------------------------------------------ */

const createModelClient = require('../active/model-client');
const modelClient = createModelClient({
  getState: () => state,
  trimText,
  finiteTimestamp,
  mergeRecentProactiveMessages,
  maxAttempts: PROACTIVE_MAX_ATTEMPTS,
  similarityLimit: PROACTIVE_SIMILARITY_LIMIT,
  proactiveTrace
});
const proactiveLog = modelClient.proactiveLog;
const currentTimeText = modelClient.currentTimeText;
const elapsedText = modelClient.elapsedText;
const recentProactiveMessages = modelClient.recentProactiveMessages;
const proactiveModeGuide = modelClient.proactiveModeGuide;
const buildProactivePrompt = modelClient.buildProactivePrompt;
const contentText = modelClient.contentText;
const responseParts = modelClient.responseParts;
const fetchJson = modelClient.fetchJson;
const isLoopbackEndpoint = modelClient.isLoopbackEndpoint;
const hasCharacterCredential = modelClient.hasCharacterCredential;
const isCharacterModelReady = modelClient.isCharacterModelReady;
const callCharacterModel = modelClient.callCharacterModel;
const visibleProactiveReply = modelClient.visibleProactiveReply;
const proactiveTextKey = modelClient.proactiveTextKey;
const proactiveTextSimilarity = modelClient.proactiveTextSimilarity;
const validateProactiveReply = modelClient.validateProactiveReply;
const proactiveFallbackMessage = modelClient.proactiveFallbackMessage;
const delay = modelClient.delay;
const generateProactiveMessage = modelClient.generateProactiveMessage;
const windowsNotify = modelClient.windowsNotify;

/* ------------------------------------------------------------------ */
/* Credential Vault v1：凭证与角色业务状态分离（AES-256-GCM 加密落盘）   */
/*   旧业务 snapshot 中的 character.apiKey 一次性迁移进 vault（幂等；   */
/*   不覆盖已存在的有效凭证），之后业务 snapshot 不再持久化明文 Key。   */
/* ------------------------------------------------------------------ */

const createCredentialVault = require('../active/credential-vault');
const credentialVault = createCredentialVault({ dataDir: DATA_DIR });
credentialVault.load();
try {
  const mig = credentialVault.migrateFromState(() => state);
  if (mig.migrated > 0) console.log(`[CredentialVault] migrated ${mig.migrated} legacy credential(s); ${mig.skipped} already present (not overwritten).`);
  else if (mig.skipped > 0) console.log(`[CredentialVault] ${mig.skipped} credential(s) already present; none overwritten.`);
} catch (_) { /* migration must never prevent startup */ }


/* ------------------------------------------------------------------ */
/* Moments 域（后台朋友圈调度：每角色 nextAt + 频率；事件经 events 回传） */
/* ------------------------------------------------------------------ */

/* 行为观测（观察期专用；纯本地文件统计，见 assets/js/social-observe.js）。
   - 存 DATA_DIR/social-observe.json（原子写），30s 节流 flush + 退出时 flush；
   - 只记后台的失败/拒绝/拦截/调用次数（成功结果由浏览器 ingest 入账）；
   - 关闭方式：环境变量 IB_SOCIAL_OBSERVE=off。 */
const OBSERVE_DISABLED = String(process.env.IB_SOCIAL_OBSERVE || '').trim().toLowerCase() === 'off';
const socialObserveCore = require('../assets/js/social-observe.js');
const socialObserveFile = path.join(DATA_DIR, 'social-observe.json');
let socialObserver = null;
if (!OBSERVE_DISABLED) {
  const obsFs = require('fs');
  const inst = socialObserveCore.createWith({
    load: () => {
      try { return JSON.parse(obsFs.readFileSync(socialObserveFile, 'utf8')); } catch (_) { return null; }
    },
    save: st => {
      const tmp = `${socialObserveFile}.tmp`;
      obsFs.writeFileSync(tmp, JSON.stringify(st));
      obsFs.renameSync(tmp, socialObserveFile);
    }
  });
  setInterval(() => { try { inst.flush(); } catch (_) {} }, 30000).unref();
  process.on('exit', () => { try { inst.flush(); } catch (_) {} });
  socialObserver = inst;
}

const createMomentsDomain = require('../active/moments');
/* 前后台共享核心（回复链规则/Prompt/常量唯一来源）：浏览器 <script> 与 Node require 的是同一文件 */
const replyChainCore = require('../assets/js/reply-chain-core.js');
const momentsDomain = createMomentsDomain({
  getState: () => state,
  armedUsers,
  saveNow,
  queueSave,
  trimText,
  deepClone,
  finiteTimestamp,
  parsePlanJson,
  contentText,
  isCharacterModelReady,
  callCharacterModel,
  proactiveTextSimilarity,
  replyChainCore,
  observe: socialObserver ? socialObserver.record.bind(socialObserver) : undefined,
  credentialVault
});
const sanitizeMomentSchedule = momentsDomain.sanitizeMomentSchedule;
const publicMomentSchedule = momentsDomain.publicMomentSchedule;
const parseMomentOutput = momentsDomain.parseMomentOutput;
/* P25-2D：canonical semantic 视图（与桌面端同一 parser）。事件里的 recommendation/reasonCode/
   topic 都来自它 —— 这里是 companion 侧唯一的语义入口。 */
const parseMomentSemantic = momentsDomain.parseMomentSemantic;
const executeMomentSchedule = momentsDomain.executeMomentSchedule;
const momentsTick = momentsDomain.momentsTick;
const momentsEvent = momentsDomain.momentsEvent;
const buildMomentPrompt = momentsDomain.buildMomentPrompt;
const replyChainTick = momentsDomain.replyChainTick;
const syncReplyChainThreads = momentsDomain.syncReplyChainThreads;
const maybeCreateReplyTask = momentsDomain.maybeCreateReplyTask;
const executeReplyChainTask = momentsDomain.executeReplyChainTask;
const replyChainTaskCount = momentsDomain.replyChainTaskCount;
const replyStore = momentsDomain.replyStore;
const sanitizeReplyThread = momentsDomain.sanitizeReplyThread;
const mergeThreadComments = momentsDomain.mergeThreadComments;
const replyTaskKey = momentsDomain.replyTaskKey;

/* ------------------------------------------------------------------ */
/* 调度器（已提取到 active/scheduler.js 工厂；state 经 getState 注入） */
/* ------------------------------------------------------------------ */

const createScheduler = require('../active/scheduler');
/* P25-3C-Node：Node companion 与 Browser **共用同一个** Active Message Authority
   （同一份 assets/js/active-message-authority.js；不复制、不新建 Node 版权威），
   并把既有 Node 事实探针（validateProactiveReply / recentProactiveMessages）注入调度器
   —— 冷却 / 去重 / 免打扰规则仍然只有一份。 */
const activeMessageAuthority = require('../assets/js/active-message-authority.js');
const scheduler = createScheduler({
  getState: () => state,
  armedUsers,
  saveNow,
  queueSave,
  ensureTaskMetadata, replaceTaskRuntime, currentForRun, cancelRun, nextRun,
  runId, messageId, trimText, deepClone, mergeRecentProactiveMessages,
  sanitizeAiPlan, PLAN_STATUSES, PLAN_DEFAULT_MAX_ATTEMPTS,
  PLAN_MIN_DELAY_MS, PLAN_MAX_DELAY_MS, PLAN_MAX_LATE_MS,
  isInDnd, nextDndFree, planRunId, planMessageId, planSnapshotTask,
  generateProactiveMessage, windowsNotify, proactiveLog,
  callCharacterModel, contentText, parsePlanJson, isCharacterModelReady,
  terminalRun, sameRunRevision, momentsTick,
  startDelayMs: START_DELAY_MS,
  closeServer: callback => server.close(callback),
  proactiveTrace,
  credentialVault,
  /* P25-3C-Node：发送授权接缝的注入面（权威 + 既有事实探针） */
  activeMessageAuthority,
  validateProactiveReply,
  recentProactiveMessages
});
const adaptiveSkipReason = scheduler.adaptiveSkipReason;
const executeTask = scheduler.executeTask;
const buildPlanEvalPrompt = scheduler.buildPlanEvalPrompt;
const updatePlan = scheduler.updatePlan;
const planEvent = scheduler.planEvent;
const evaluatePlan = scheduler.evaluatePlan;
const executePlan = scheduler.executePlan;
const schedulerTick = scheduler.schedulerTick;
const startScheduler = scheduler.startScheduler;
const stopSchedulerTimers = scheduler.stopTimers;

/* ------------------------------------------------------------------ */
/* P11-3H · 合作停止面（唯一契约见 runtime/service-control.js）          */
/* ------------------------------------------------------------------ */

/* 修复前：这个进程只能被信号终止，而 Windows 上 child.kill('SIGTERM') 是
   TerminateProcess —— 调度器不会 flush、状态文件不会落盘、`process.on('exit')`
   的观测写回也不会运行。现在停止是一次**消息**：POST /__shutdown →
   停调度器 tick 与定时器 → 落盘 → 关 HTTP → 有界退出。

   判定钩子必须在 http 工厂之前创建（工厂立刻要拿到它）。判定本身必须在
   **本组件自己的 dispatch 里**做（active/http.js 的路由链内），不能在 server 上
   再挂一个 'request' listener：Node 同步派发 listener，后注册的那个一定在前一个
   已经应答之后才跑，于是停止请求会拿到 404（本阶段在真实 Bridge 上实测过）。 */
const serviceControl = require('../runtime/service-control.js');
let activeStopping = false;
const activeStopDispatch = serviceControl.createStopDispatch({
  service: 'internal-beyond-active-messages',
  stop: () => activeTeardown('http'),
  /* The dispatch owns the ENDING, uniformly for every component: run the
     teardown, then close the listener bounded, then exit. Before this the
     companion's teardown closed nothing, so the process stayed alive holding
     its port until the caller's fallback kill — a stop that "worked" and still
     needed a kill. */
  server: () => server,
  exit: code => process.exit(code),
  onAccepted: info => console.log('[Active] stop requested over http (pid ' + info.pid + ')')
});

/* ------------------------------------------------------------------ */
/* P22-11 · Economy command channel（23114 → 23118 的**唯一**出站腿）    */
/* ------------------------------------------------------------------ */

/* 客户端本身只做传输：有界超时、有界重试、以及"确定"与"未知"的区分。
   地址与来源凭据来自**部署环境**（IB_ECONOMY_CHANNEL_*），缺省时
   configured === false —— 一条写路径**不**继承本机的 loopback 零门槛。 */
const createActiveEconomyChannelClient = require('../active/economy-channel-client.js');
const economyChannel = createActiveEconomyChannelClient({});
/* ── 净化：与浏览器侧**同一个答案**，但是 companion 的一份镜像 ─────────
   ★ 为什么不是 require assets/js/active-diary/active-plans.js：那是个
     浏览器 IIFE（末行 `window.IB || (window.IB = {})`），在 Node 里
     require 会直接抛 ReferenceError（开发期实测）。硬给它造一个全局
     `window` 才能载入 —— 而那会改掉那个文件在 Node 测试里的既有语义。
   ★ 这一份是**镜像**，不是第二个权威：经济提案的形状权威是 P22-10 的
     净化器 + P22-8 的 proposal 校验，本函数只做两件在任何运行时都必须
     成立的事（与浏览器侧逐字同款）：① 动作/载荷形状不对 → 返回 null
     （fail closed）；② payload 里出现身份自报键 → 返回 null。
     它**不**列经济事实（那是 P22-8 的名单），也不填任何默认值。 */
const ACTIVE_ECONOMY_PROPOSAL_ACTION = 'economy_propose_purchase';
const ACTIVE_ECONOMY_IDENTITY_KEYS = ['consumerId', 'consumer', 'capability', 'role', 'authority', 'approved', 'autoAllow'];
/* ★ P22-12 §4：与浏览器侧**逐字相同**的构造式白名单（模型只能选择意图
   字段）。它恰好是 P22-8 的 PURCHASE_INTENT_PROPOSAL_KEYS 减去 agentId
   （由运行环境注入，不由模型自报）与 expiresAt（生命周期，P22-8 自己夹取）。
   ★ 为什么两处都要有：它们挡的是**两件不同的事** —— 浏览器那份挡的是
   "模型写了什么"，这份挡的是"任何绕过生产者的调用方递了什么"。两份必须
   给出**同一个答案**，而这件事由 test_p22_12_economy_active_plan.js 的
   等价矩阵（同一批 payload 喂给两个实现，逐条比较接受/拒绝）钉住，
   不是靠注释承诺。 */
const ACTIVE_ECONOMY_PROPOSAL_FIELDS = ['productId', 'recipientId', 'units', 'reason'];
/* ★ 这一份守在**传输边界**上，而不是模型边界上，因此它比浏览器那份多**一个**
   名字：agentId。
   为什么必须多这一个：生产者的顺序是"模型选意图 → 运行环境补上本地身份
   （agentId）→ 净化 → 送出"，因此到达 23114 的 payload **本来就应该**带着
   agentId。把它也拦掉，等于把唯一的合法生产者挡在门外（开发期实测过：
   症状是每一次真实提议都在 23114 拿到 400 economy-proposal-rejected）。
   ★ 反过来，浏览器那一份**必须**拦它：那里是模型输出的入口，而
   "我是谁"不由模型自报。
   ⇒ 两份名单的差集恰好是 ['agentId']，这件事由
   test_p22_12_economy_intent_producer.js 的等价矩阵逐条钉住，
   而不是靠这段注释承诺。 */
const ACTIVE_ECONOMY_WIRE_FIELDS = ['agentId'].concat(ACTIVE_ECONOMY_PROPOSAL_FIELDS);
const ACTIVE_ECONOMY_REASON_MAX = 400;
function sanitizeActiveEconomyProposal(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const proposal = raw.proposal;
  if (proposal == null || typeof proposal !== 'object' || Array.isArray(proposal)) return null;
  for (const key of ACTIVE_ECONOMY_IDENTITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(proposal, key)) return null;
    if (Object.prototype.hasOwnProperty.call(raw, key)) return null;
  }
  /* ② 白名单外的键 ⇒ 整条拒绝（与浏览器侧同款：价 格 / 金额 / 币种 /
     余额 / 预算 / 批准 / autoAllow / 结算 / 账本 / 发放数量 都在这里结束）。
     ★ 顶层键**不**在这里做白名单，这是刻意的：这一层是**投影**（返回值只含
     {proposal, idempotencyKey}），因此顶层多出来的键本来就不会被转发 ——
     再拒一次只会让一条无害的调用失败。而"模型写了不该写的东西"必须在**模型
     边界**上被拒（浏览器那一份做白名单），不是在这里被悄悄丢掉。
     开发期实测：这里曾经也拒顶层键，症状是 P22-11 的 bridge 直接红 ——
     那个 fixture 的测试入口把整条 {command, commandId, idempotencyKey,
     proposal} 交给这同一个净化器，于是"未知 command 应该被 23118 拒"这条
     跨进程断言变成了"在 23114 就被拒"，也就测不到它要测的东西了。 */
  const keys = Object.keys(proposal);
  for (const key of keys) {
    if (ACTIVE_ECONOMY_WIRE_FIELDS.indexOf(key) < 0) return null;
  }
  if (typeof proposal.agentId !== 'string') return null;
  const agentId = proposal.agentId.trim();
  if (!agentId || agentId.length > 200) return null;
  if (typeof proposal.productId !== 'string') return null;
  const productId = proposal.productId.trim();
  if (!productId || productId.length > 200) return null;
  const projected = { agentId: agentId, productId: productId };
  if (proposal.recipientId != null) {
    if (typeof proposal.recipientId !== 'string') return null;
    const recipientId = proposal.recipientId.trim();
    if (recipientId) {
      if (recipientId.length > 200) return null;
      projected.recipientId = recipientId;
    }
  }
  if (proposal.units != null) {
    if (typeof proposal.units !== 'number' || !Number.isSafeInteger(proposal.units) || proposal.units < 1) return null;
    projected.units = proposal.units;
  }
  if (proposal.reason != null) {
    if (typeof proposal.reason !== 'string') return null;
    projected.reason = proposal.reason.trim().slice(0, ACTIVE_ECONOMY_REASON_MAX);
  }
  const idempotencyKey = trimText(raw.idempotencyKey, 200);
  if (!idempotencyKey) return null;
  return { proposal: projected, idempotencyKey: idempotencyKey };
}

/* ------------------------------------------------------------------ */
/* HTTP 层（已提取到 active/http.js 工厂；server 实例随工厂返回）       */
/* ------------------------------------------------------------------ */

const createHttp = require('../active/http');
const httpLayer = createHttp({
  HOST, PORT,
  maxBody: MAX_BODY,
  /* P11-3H：停止面的判定钩子（见上）。 */
  stopDispatch: activeStopDispatch,
  getState: () => state,
  armedUsers,
  saveNow,
  queueSave,
  publicPlan, sanitizeAiPlan, buildTaskReplacement, recordUserId,
  trimText, deepClone, finiteTimestamp,
  sanitizeMomentSchedule, publicMomentSchedule,
  proactiveTrace,
  credentialVault,
  /* P22-11：把通道与**同一个**净化器交给路由层。两者都缺席（分解装配 /
     未配置通道）时 `/economy/propose-purchase` 那条分支根本不存在。
     ★ P22-12 的唯一一处改动：把生产者给出的**稳定** idempotencyKey 也作为
     命令身份交给通道（commandId 与 idempotencyKey 是这条通道对"一条 command"
     的身份定义，见契约的 createCommandIdentity）。
     为什么必须带：不带时通道会为每次调用**新生成**一个身份，于是"同一份模型
     输出复读两次"在下游变成两条不同的请求身份，P22-8 的幂等那条腿就形同虚设
     （只剩它自己的 60s 指纹窗口兜着）。带上它之后，同一份输出 → 同一个身份
     → 下游给回**同一笔** Intent。这不是新增语义，只是不再把调用方已经算好的
     身份丢掉。 */
  economyPropose: economyChannel.configured
    ? input => economyChannel.proposePurchase({
      proposal: input.proposal,
      commandId: input.idempotencyKey,
      idempotencyKey: input.idempotencyKey
    })
    : undefined,
  sanitizeEconomyProposal: sanitizeActiveEconomyProposal
});
const server = httpLayer.server;
const originAllowed = httpLayer.originAllowed;
const applyCors = httpLayer.applyCors;
const json = httpLayer.json;
const readBody = httpLayer.readBody;
const publicTask = httpLayer.publicTask;

/* 停止动作：与信号路径共用同一份（见下方 require.main 块）。 */
async function activeTeardown(reason) {
  if (activeStopping) return { ok: true, alreadyStopped: true, steps: [], errors: [] };
  activeStopping = true;
  const result = await serviceControl.runStop('active', {
    entering: () => { /* activeStopping 已置位；重复停止是 no-op */ },
    stopWork: () => { try { stopSchedulerTimers(); } catch (_) { /* 未启动 */ } },
    stopTimers: () => { try { if (socialObserver) socialObserver.flush(); } catch (_) { /* 观测不得阻断停止 */ } },
    closeStores: () => { saveNow(); },
    report: () => { console.log('[Active] stopped cooperatively'); }
  });
  return result;
}

/* require.main guard: the module can be imported by tests without starting the server. */
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('Internal Beyond Active Messages companion is running.');
    console.log(`Listening: http://${HOST}:${PORT}`);
    console.log(`State:     ${DATA_FILE}`);
    console.log('');
    console.log('Keep this window open for schedules to run after the browser closes.');
    console.log('After each service restart, open Internal Beyond once so it can reconcile and arm your schedules.');
    console.log('Only plans explicitly marked "浏览器关闭后继续运行" are synced here.');
    console.log('The local state file contains the API credentials required by those plans.');
    console.log('');
  });
  startScheduler();
  /* P11-3H：信号路径与 HTTP 停止面走**同一份**拆除动作。POSIX 上信号有效，
     Windows 上不会到达 —— 因此 HTTP 那条才是生产上真正会跑的路径。 */
  const onSignal = reason => { activeTeardown(reason).then(() => process.exit(0), () => process.exit(0)); };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  /* 兜底：单个请求的意外异常不得杀死调度进程（记录后继续运行） */
  process.on('uncaughtException', error => {
    console.error('[Active] Uncaught exception (service continues):', error && error.stack || error);
  });
  process.on('unhandledRejection', reason => {
    console.error('[Active] Unhandled rejection (service continues):', reason && reason.stack || reason);
  });
}

module.exports = {
  sanitizeAiPlan,
  parsePlanJson,
  isInDnd,
  nextDndFree,
  validatePlanResult: (raw, nowParam, prefs) => {
    /* 浏览器端同款白名单校验的 companion 镜像（测试用） */
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const action = String(raw.action || '').trim();
    if (!['schedule', 'none', 'cancel_existing'].includes(action)) return null;
    const out = { action, reason: trimText(raw.reason, 300) };
    if (action !== 'schedule') return out;
    const t = Date.parse(raw.scheduledAt);
    if (!Number.isFinite(t)) return null;
    const nowMs = Number(nowParam) || Date.now();
    const p = prefs || {};
    const minMs = Math.max(PLAN_MIN_DELAY_MS, (Number(p.minIntervalMinutes) || 30) * 60000);
    const maxMs = Math.min(PLAN_MAX_DELAY_MS, (Number(p.maxPlanHours) || 168) * 3600000);
    let delay = t - nowMs;
    if (delay < minMs) return null;
    if (delay > maxMs) delay = maxMs;
    out.scheduledAt = new Date(nowMs + delay).toISOString();
    out.intent = trimText(raw.intent, 200);
    const cc = raw.cancelConditions && typeof raw.cancelConditions === 'object' ? raw.cancelConditions : {};
    const pick = (top, inner, fallback) => top != null ? !!top : (inner != null ? !!inner : !!fallback);
    out.cancelIfUserReplies = pick(raw.cancelIfUserReplies, cc.cancelIfUserReplies, p.cancelIfUserReplies !== false);
    out.cancelIfIntentResolved = pick(raw.cancelIfIntentResolved, cc.cancelIfIntentResolved, false);
    out.cancelIfNewerPlanExists = pick(raw.cancelIfNewerPlanExists, cc.cancelIfNewerPlanExists, true);
    out.respectDoNotDisturb = pick(raw.respectDoNotDisturb, cc.respectDoNotDisturb, true);
    out.allowReschedule = pick(raw.allowReschedule, cc.allowReschedule, p.allowReschedule !== false);
    out.allowFollowUpPlan = pick(raw.allowFollowUpPlan, cc.allowFollowUpPlan, false);
    return out;
  },
  executePlan,
  evaluatePlan,
  schedulerTick,
  executeTask,
  adaptiveSkipReason,
  buildPlanEvalPrompt,
  settingFromPlan,
  planSnapshotTask,
  planRunId,
  planMessageId,
  updatePlan,
  isLoopbackEndpoint,
  isCharacterModelReady,
  sanitizeMomentSchedule,
  publicMomentSchedule,
  parseMomentOutput,
  parseMomentSemantic,
  buildMomentPrompt,
  executeMomentSchedule,
  momentsTick,
  momentsEvent,
  getState: () => state,
  setArmed: userId => { armedUsers.add(userId); },
  saveNow,
  mutateTargetMetadata,
  rollbackTargetMetadata,
  resetStateForTest: () => { state = emptyData(); },
  proactiveTrace,
  replyChainTick,
  syncReplyChainThreads,
  maybeCreateReplyTask,
  executeReplyChainTask,
  replyChainTaskCount,
  replyStore,
  sanitizeReplyThread,
  mergeThreadComments,
  replyTaskKey,
  replyChainCore,
  credentialVault,
  /* P22-11：出站通道与净化链的既有入口。导出它们是为了让"生产侧到底有
     没有一点通向 Home Node 的经济能力"成为一句可以断言的事实 ——
     而不是让读者从 active/http.js 的路由表里推断。 */
  economyChannel,
  sanitizeActiveEconomyProposal,
  ACTIVE_ECONOMY_PROPOSAL_ACTION,
  ACTIVE_ECONOMY_IDENTITY_KEYS,
  ACTIVE_ECONOMY_PROPOSAL_FIELDS,
  ACTIVE_ECONOMY_WIRE_FIELDS,
  ACTIVE_ECONOMY_REASON_MAX
};
