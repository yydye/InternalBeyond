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
  credentialVault
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
  credentialVault
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
  buildMomentPrompt,
  executeMomentSchedule,
  momentsTick,
  momentsEvent,
  getState: () => state,
  setArmed: userId => { armedUsers.add(userId); },
  saveNow,
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
  credentialVault
};
