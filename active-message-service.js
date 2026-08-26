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

const createPersistence = require('./active/persistence');
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

const createPlanDomain = require('./active/plan-domain');
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
/* 模型客户端（已提取到 active/model-client.js 工厂；getState / 常量注入） */
/* ------------------------------------------------------------------ */

const createModelClient = require('./active/model-client');
const modelClient = createModelClient({
  getState: () => state,
  trimText,
  finiteTimestamp,
  mergeRecentProactiveMessages,
  maxAttempts: PROACTIVE_MAX_ATTEMPTS,
  similarityLimit: PROACTIVE_SIMILARITY_LIMIT
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
/* Moments 域（后台朋友圈调度：每角色 nextAt + 频率；事件经 events 回传） */
/* ------------------------------------------------------------------ */

/* 行为观测（观察期专用；纯本地文件统计，见 assets/js/social-observe.js）。
   - 存 DATA_DIR/social-observe.json（原子写），30s 节流 flush + 退出时 flush；
   - 只记后台的失败/拒绝/拦截/调用次数（成功结果由浏览器 ingest 入账）；
   - 关闭方式：环境变量 IB_SOCIAL_OBSERVE=off。 */
const OBSERVE_DISABLED = String(process.env.IB_SOCIAL_OBSERVE || '').trim().toLowerCase() === 'off';
const socialObserveCore = require('./assets/js/social-observe.js');
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

const createMomentsDomain = require('./active/moments');
/* 前后台共享核心（回复链规则/Prompt/常量唯一来源）：浏览器 <script> 与 Node require 的是同一文件 */
const replyChainCore = require('./assets/js/reply-chain-core.js');
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
  observe: socialObserver ? socialObserver.record.bind(socialObserver) : undefined
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

const createScheduler = require('./active/scheduler');
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
  closeServer: callback => server.close(callback)
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
const shutdown = scheduler.shutdown;

/* ------------------------------------------------------------------ */
/* HTTP 层（已提取到 active/http.js 工厂；server 实例随工厂返回）       */
/* ------------------------------------------------------------------ */

const createHttp = require('./active/http');
const httpLayer = createHttp({
  HOST, PORT,
  maxBody: MAX_BODY,
  getState: () => state,
  armedUsers,
  saveNow,
  queueSave,
  publicPlan, sanitizeAiPlan, buildTaskReplacement, recordUserId,
  trimText, deepClone, finiteTimestamp,
  sanitizeMomentSchedule, publicMomentSchedule
});
const server = httpLayer.server;
const originAllowed = httpLayer.originAllowed;
const applyCors = httpLayer.applyCors;
const json = httpLayer.json;
const readBody = httpLayer.readBody;
const publicTask = httpLayer.publicTask;


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
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
  replyChainTick,
  syncReplyChainThreads,
  maybeCreateReplyTask,
  executeReplyChainTask,
  replyChainTaskCount,
  replyStore,
  sanitizeReplyThread,
  mergeThreadComments,
  replyTaskKey,
  replyChainCore
};