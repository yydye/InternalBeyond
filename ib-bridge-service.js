'use strict';

/*
 * Internal Beyond - 本地一键 Bridge 后端
 *
 * 零依赖（Node.js 18+ 内置模块即可运行），个人自用。
 *
 * 能力：
 *  - WebSocket Bridge：与 InternalBeyond.html 里的 IBNET 客户端握手，
 *    向 AI 暴露工具（心语墙 / 健康 / 地理 / 天气 / 点歌 / 表情 / 推送 / 会话 / 上下文统计等）
 *  - REST 接口：给 iOS 快捷指令、前端面板、测试脚本调用
 *  - 数据持久化：JSON 文件保存在本机数据目录
 *  - 表情包：内置默认表情 + 用户可往 stickers 目录放 PNG/SVG
 *  - 可选 Bark 推送：主动消息/工具结果推送到手机手表
 *
 * 启动：  node ib-bridge-service.js
 * 一键：  start-bridge-service.cmd（Windows）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* 常量与数据目录                                                      */
/* ------------------------------------------------------------------ */

const HOST = process.env.IB_BRIDGE_HOST || '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.IB_BRIDGE_PORT) || 23115));
const DATA_DIR = process.env.IB_BRIDGE_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond', 'bridge')
    : path.join(os.homedir(), '.internal-beyond', 'bridge'));
const STICKER_DIR = path.join(DATA_DIR, 'stickers');

const MAX_BODY = 8 * 1024 * 1024;
const MAX_FRAME = 8 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const VERSION = '1.0.0';
const SERVER_NAME = 'IB Bridge';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STICKER_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 模块依赖：bridge/ 下按域提取的叶子模块（composition root 注入依赖） */
/* ------------------------------------------------------------------ */

const util = require('./bridge/util');
const createPersistence = require('./bridge/persistence');
const createConfig = require('./bridge/config');
const uid = util.uid;
const todayStr = util.todayStr;
const constantTimeTokenMatch = util.constantTimeTokenMatch;
const parseQuery = util.parseQuery;

/* ------------------------------------------------------------------ */
/* 支付（Phase 2B）：Payment Authorization + Alipay Provider + Gate    */
/*   · payment-auth.js 是唯一授权策略来源（Bridge 权威重放）            */
/*   · Provider 仅在 ALLOW / 人工确认后的 CONFIRM 时被调用               */
/*   · 支付凭证绝不进 prompt/DOM: 授权域与 Provider 均不接触凭证         */
/* ------------------------------------------------------------------ */
const createPaymentAuth = require('./active/payment-auth.js').createPaymentAuth;
const createPaymentProviderRegistry = require('./bridge/payment-provider.js').createPaymentProviderRegistry;
const createAlipayProvider = require('./bridge/alipay-provider.js');
const createPayGate = require('./bridge/pay-gate.js');

function jsonStore(file) {
  return {
    load: function () { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } },
    save: function (obj) { try { fs.writeFileSync(file + '.tmp', JSON.stringify(obj)); fs.renameSync(file + '.tmp', file); } catch (e) { /* 持久化失败不阻断授权 */ } }
  };
}
const payAuth = createPaymentAuth({ persist: jsonStore(path.join(DATA_DIR, 'pay-auth.json')) });
const payProviderRegistry = createPaymentProviderRegistry();
/* 真实 Alipay Provider 总是注册（内建）；可用性由 gate 在无 Provider/执行失败时回落 manualLink */
payProviderRegistry.register(createAlipayProvider({}));
const payGate = createPayGate({
  payAuth: payAuth,
  registry: payProviderRegistry,
  providerName: 'alipay',
  persist: jsonStore(path.join(DATA_DIR, 'pay-gate.json'))
});

/* 授权配置入口（供改配置/诊断）：与 payment-auth 的 setConfig 同步 */
function payConfigure(cfg) { return payAuth.setConfig(cfg || {}); }
function payConfig() { return payAuth.getConfig(); }


/* ------------------------------------------------------------------ */
/* 轻量 JSON 持久化（已提取到 bridge/persistence.js；业务数据仍由根文件持有） */
/* ------------------------------------------------------------------ */

const persistence = createPersistence({ dataDir: DATA_DIR });
const jsonPath = persistence.jsonPath;
const writeJson = persistence.writeJson;
const saveJson = persistence.saveJson;
const loadJson = persistence.loadJson;
const loadList = persistence.loadList;
const saveList = persistence.saveList;
const fileSummary = persistence.fileSummary;
const directoryUsage = persistence.directoryUsage;

/* 配置工厂：可变状态收在闭包内；jsonPath / config / LAN_EXPOSED 等
   保持原有名字，供根文件其余部分无感使用。 */
const cfg = createConfig({ dataDir: DATA_DIR, writeJson });
const config = cfg.config;
const configInvalid = cfg.configInvalid;
const LAN_EXPOSED = cfg.lanExposed;
const BIND_HOST = cfg.bindHost;
const persistConfig = cfg.persistConfig;
const isLoopbackHost = cfg.isLoopbackHost;
const createAccessToken = cfg.createAccessToken;
const lanAddresses = cfg.lanAddresses;
const corsOrigin = cfg.corsOrigin;
const isLoopbackRequest = cfg.isLoopbackRequest;
const suppliedToken = cfg.suppliedToken;
const needsHttpToken = cfg.needsHttpToken;
const httpAuthorized = cfg.httpAuthorized;

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/* defaultConfig 已提取到 bridge/config.js */

/* configRaw / configInvalid / config 装载已提取到 bridge/config.js */

/* isLoopbackHost / createAccessToken / lanAddresses / corsOrigin 已提取到 bridge/config.js */

/* persistConfig / configNeedsUpgrade / ensureConfigFile 已提取到 bridge/config.js（工厂创建时自动执行） */

/* configuredHost / LAN_EXPOSED / BIND_HOST 与 LAN token 自动生成已提取到 bridge/config.js */

/* isLoopbackRequest / suppliedToken / constantTimeTokenMatch / needsHttpToken / httpAuthorized 已提取到 bridge/config.js */

function authRequiredResponse(res) {
  sendJsonRes(res, 401, {
    ok: false,
    error: '认证失败：局域网 Bridge 请求需要 Authorization: Bearer <token>、X-IB-Token 或 token 查询参数。'
  });
}

/* ------------------------------------------------------------------ */
/* 各业务数据                                                          */
/* ------------------------------------------------------------------ */

let whispers = loadList('whispers');        // [{id,text,author,created}]
let healthData = loadList('health');        // [{id,date,metrics,ts}]
let geoLatest = loadJson('geo', null);      // {lat,lng,address,city,source,ts}
let letters = loadList('letters');          // [{id,to,from,content,reply_to,read,created}]
let sessions = loadJson('sessions', {});    // { key: {key,data,updated} }
let resident = loadJson('resident', {});    // { key: {key,name,provider,system,history,intervalMin,...} }
let contextStats = loadJson('context', {}); // { friend: [ {ts,i,cr,cw,o} ] }
let pushes = loadList('push_history');      // 最近推送记录

/* 列表操作的简易并发锁（内存锁，仅本进程） */
const _listLocks = { whispers: false, health: false, letters: false, context: false, pushes: false, resident: false };
function withListLock(name, fn) {
  return new Promise((resolve) => {
    function tryAcquire() {
      if (_listLocks[name]) { setImmediate(tryAcquire); return; }
      _listLocks[name] = true;
      try {
        const r = fn();
        resolve(r);
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e).slice(0, 500) });
      } finally {
        _listLocks[name] = false;
      }
    }
    tryAcquire();
  });
}

function saveWhispers() { if(!saveList('whispers', whispers)) console.error('[IB Bridge] 心语保存失败'); }
function saveHealth() { if(!saveList('health', healthData)) console.error('[IB Bridge] 健康数据保存失败'); }
function saveGeo() { if(!saveJson('geo', geoLatest)) console.error('[IB Bridge] 地理数据保存失败'); }
function saveLetters() { if(!saveList('letters', letters)) console.error('[IB Bridge] 信件保存失败'); }
function saveSessions() { if(!saveJson('sessions', sessions)) console.error('[IB Bridge] 会话保存失败'); }
function saveResident() { if(!saveJson('resident', resident)) console.error('[IB Bridge] AI 常驻保存失败'); }
function saveContext() { if(!saveJson('context', contextStats)) console.error('[IB Bridge] 上下文保存失败'); }
function savePushes() { if(!saveList('push_history', pushes.slice(0, 200))) console.error('[IB Bridge] 推送历史保存失败'); }

/* uid / todayStr 已提取到 bridge/util.js */

/* ------------------------------------------------------------------ */
/* 内置默认表情（SVG，个人自用够用；用户可放 PNG 到 stickers 目录）     */
/* ------------------------------------------------------------------ */

const DEFAULT_STICKERS = {
  'heart': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 88 C20 68 8 50 8 34 C8 20 20 12 32 12 C41 12 48 18 50 25 C52 18 59 12 68 12 C80 12 92 20 92 34 C92 50 80 68 50 88 Z" fill="#ff6b81"/></svg>',
  'hug': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="30" cy="52" r="26" fill="#f4c98d"/><circle cx="70" cy="52" r="26" fill="#f4c98d"/><circle cx="36" cy="48" r="3" fill="#333"/><circle cx="64" cy="48" r="3" fill="#333"/><path d="M40 66 Q50 76 60 66" stroke="#333" stroke-width="3" fill="none" stroke-linecap="round"/></svg>',
  'smile': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#ffd93d"/><circle cx="36" cy="42" r="4" fill="#333"/><circle cx="64" cy="42" r="4" fill="#333"/><path d="M32 60 Q50 78 68 60" stroke="#333" stroke-width="4" fill="none" stroke-linecap="round"/></svg>',
  'cry': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#9ecbff"/><circle cx="36" cy="42" r="4" fill="#333"/><circle cx="64" cy="42" r="4" fill="#333"/><path d="M32 62 Q50 74 68 62" stroke="#333" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M16 30 q-8 10 0 18 M84 30 q8 10 0 18" stroke="#7fb4f0" stroke-width="4" fill="none" stroke-linecap="round"/></svg>',
  'laugh': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#ffd93d"/><path d="M28 44 q8 -8 16 0 M56 44 q8 -8 16 0" stroke="#333" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M30 58 Q50 78 70 58 Q50 84 30 58 Z" fill="#ff8a80"/></svg>',
  'angry': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#ff8a80"/><path d="M26 34 l14 10 M74 34 l-14 10" stroke="#333" stroke-width="4" stroke-linecap="round"/><circle cx="36" cy="48" r="4" fill="#333"/><circle cx="64" cy="48" r="4" fill="#333"/><path d="M38 70 Q50 62 62 70" stroke="#333" stroke-width="4" fill="none" stroke-linecap="round"/></svg>',
  'kiss': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#ffb6c1"/><circle cx="36" cy="42" r="4" fill="#333"/><circle cx="64" cy="42" r="4" fill="#333"/><path d="M50 76 q10 -8 18 0 q-8 8 -18 0 Z" fill="#ff6b81"/></svg>',
  'star': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 8 L62 38 L94 40 L69 61 L77 93 L50 75 L23 93 L31 61 L6 40 L38 38 Z" fill="#ffd700" stroke="#e6b800" stroke-width="2"/></svg>'
};

function ensureDefaultStickers() {
  let n = 0;
  Object.keys(DEFAULT_STICKERS).forEach(name => {
    const file = path.join(STICKER_DIR, name + '.svg');
    if (!fs.existsSync(file)) {
      try {
        fs.writeFileSync(file, DEFAULT_STICKERS[name], 'utf8');
        n++;
      } catch (e) { /* 忽略 */ }
    }
  });
  if (n) console.log('[IB Bridge] 已写入 ' + n + ' 个默认表情到 ' + STICKER_DIR);
}
ensureDefaultStickers();

function sweepTtsFiles() {
  try {
    const cutoff = Date.now() - 7 * 86400000;
    fs.readdirSync(DATA_DIR).forEach(name => {
      if (!/^tts_[^.]+\.mp3$/.test(name)) return;
      const file = path.join(DATA_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (e) { /* 单个文件失败不影响其他清理 */ }
    });
  } catch (e) { /* 目录不可读时跳过清理 */ }
}
sweepTtsFiles();

function listStickers() {
  const out = [];
  try {
    const names = fs.readdirSync(STICKER_DIR);
    names.forEach(name => {
      if (!/\.(png|webp|gif|jpg|jpeg|svg)$/i.test(name)) return;
      out.push({ name: path.basename(name, path.extname(name)), file: name });
    });
  } catch (e) { /* 忽略 */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* 外部服务：天气 / 网易云音乐 / Bark / ntfy                            */
/* （已提取到 bridge/clients.js 工厂；config 与 geoLatest 经依赖注入）  */
/* ------------------------------------------------------------------ */

const createClients = require('./bridge/clients');
const clients = createClients({ config, getGeoLatest: () => geoLatest });
const fetchJson = clients.fetchJson;
const getWeather = clients.getWeather;
const searchNetease = clients.searchNetease;
const searchKugou = clients.searchKugou;
const searchMusic = clients.searchMusic;
const kugouPlayUrl = clients.kugouPlayUrl;
const musicPlayUrl = clients.musicPlayUrl;
const musicPlayRemote = clients.musicPlayRemote;
const barkPush = clients.barkPush;
const ntfyPush = clients.ntfyPush;

/* ------------------------------------------------------------------ */
/* AI Voice（TTS，OpenAI / Edge / MiMo 三 provider + VoiceClone）       */
/* （已提取到 bridge/tts.js 工厂；config / uid / ttsDir / ttsVoices 经依赖注入） */
/* ------------------------------------------------------------------ */

/* ── VoiceClone Reference Audio 资产层（第三阶段 B1：文件基础设施） ──
   文件在 DATA_DIR/tts-voices/<refAudioId>.<ext>；metadata 注册表 DATA_DIR/tts-voices.json。
   必须在 createTts 之前创建，供 B2 VoiceClone 适配器经 ttsVoices.resolveRefAudio 读取真实文件。 */
const createTtsVoices = require('./bridge/tts-voices');
const ttsVoices = createTtsVoices({ dataDir: DATA_DIR, writeJson, loadJson });

const createTts = require('./bridge/tts');
const tts = createTts({ config, uid, ttsDir: DATA_DIR, ttsVoices });
const edgeTtsGen = tts.edgeTtsGen;
const ttsGenerate = tts.ttsGenerate;
/* Voice Profile 统一入口（normalize 按 provider capabilities 过滤并补默认值） */
const ttsNormalize = tts.normalizeVoiceProfile;
const ttsSynthesize = tts.ttsSynthesize;

/* ASR provider interface (turn-based OpenAI-Whisper-compatible default;
   streaming recognizer is opt-in). Wired into the voice runtime via deps so
   tests can inject a fake `asr`. */
const createAsr = require('./bridge/asr');
const asr = createAsr(config);

/* Voice Runtime only owns audio, ASR, call state and generation lifecycle. */
const createVoiceRuntime = require('./bridge/voice-runtime');
const voiceRuntime = createVoiceRuntime({
  config,
  ttsNormalize,
  ttsSynthesize,
  streamSynthesize: tts.streamSynthesize,
  dataDir: DATA_DIR,
  uid,
  asr
});

/* ------------------------------------------------------------------ */
/* AI 常驻会话引擎（多模型通用，不绑定 Claude Code）                    */
/* ------------------------------------------------------------------ */

function maskProvider(p) {
  const c = Object.assign({}, p || {});
  if (c.apiKey) c.apiKey = '***';
  return c;
}

function residentSummary(key) {
  const s = resident[key];
  if (!s) return null;
  return {
    key,
    name: s.name || key,
    provider: maskProvider(s.provider),
    model: s.provider && s.provider.model || '',
    system: s.system || '',
    relationship: s.relationship || '',
    messages: (s.history || []).length,
    intervalMin: s.intervalMin || 0,
    lastProactive: s.lastProactive || 0,
    created: s.created || 0,
    updated: s.updated || 0
  };
}

function residentList() {
  return Object.keys(resident).map(residentSummary).filter(Boolean)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

function residentUpsert(key, body) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: '缺少会话 key' };
  const now = Date.now();
  const base = resident[k] || { key: k, history: [], created: now };
  const prov = Object.assign({}, base.provider || {}, body.provider || {});
  if (body.endpoint !== undefined) prov.endpoint = String(body.endpoint);
  if (body.apiKey !== undefined) prov.apiKey = String(body.apiKey);
  if (body.model !== undefined) prov.model = String(body.model);
  if (body.format !== undefined) prov.format = String(body.format);
  if (!prov.endpoint) return { ok: false, error: '缺少 provider.endpoint' };
  if (!prov.model) return { ok: false, error: '缺少 provider.model' };
  const s = {
    key: k,
    name: body.name !== undefined ? String(body.name).slice(0, 40) : (base.name || k),
    provider: prov,
    system: body.system !== undefined ? String(body.system).slice(0, 8000) : (base.system || ''),
    relationship: body.relationship !== undefined ? String(body.relationship).slice(0, 200) : (base.relationship || ''),
    temperature: body.temperature !== undefined ? Math.max(0, Math.min(2, Number(body.temperature) || 0.8)) : (base.temperature !== undefined ? base.temperature : 0.8),
    intervalMin: body.intervalMin !== undefined ? Math.max(0, Number(body.intervalMin) || 0) : (base.intervalMin || 0),
    history: Array.isArray(base.history) ? base.history.slice(-60) : [],
    created: base.created || now,
    updated: now
  };
  resident[k] = s;
  saveResident();
  return { ok: true, session: residentSummary(k) };
}

function residentSystem(s) {
  let out = String(s.system || '你是这个空间里的陪伴者，说话自然、克制、有温度。').trim();
  if (s.relationship) out += '\n\n你和对方的关系：' + String(s.relationship);
  out += '\n\n当前时间：' + new Date().toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit'
  });
  return out;
}

async function aiChatOnce(provider, messages, system, temperature) {
  const fmt = String(provider.format || 'openai').toLowerCase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    if (fmt === 'anthropic') {
      const msgs = [];
      (messages || []).forEach(m => {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const content = String(m.content || '');
        const last = msgs[msgs.length - 1];
        if (last && last.role === role) last.content += '\n\n' + content;
        else msgs.push({ role, content });
      });
      /* Anthropic 要求最后一条是 user；常驻主动消息会留下 assistant 结尾，请求副本里丢弃即可 */
      while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey || '',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: provider.model,
          system: system || '',
          messages: msgs,
          max_tokens: 2048,
          temperature: temperature == null ? 0.8 : temperature
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: 'AI 常驻调用失败（HTTP ' + res.status + '）：' + JSON.stringify(data).slice(0, 240) };
      const text = (data.content || []).filter(p => p && p.type === 'text').map(p => p.text || '').join('');
      const usage = data.usage ? { i: data.usage.input_tokens || 0, o: data.usage.output_tokens || 0 } : null;
      return { ok: true, text, usage };
    }
    if (fmt === 'gemini') {
      const model = String(provider.model || '');
      const endpoint = String(provider.endpoint || '').replace('{model}', encodeURIComponent(model));
      const contents = [];
      (messages || []).forEach(m => {
        const role = m.role === 'assistant' ? 'model' : 'user';
        const content = String(m.content || '');
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts[0].text += '\n\n' + content;
        else contents.push({ role, parts: [{ text: content }] });
      });
      if (!contents.length) contents.push({ role: 'user', parts: [{ text: '你好' }] });
      const body = { contents, generationConfig: { temperature: temperature == null ? 0.8 : temperature } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': provider.apiKey || ''
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: 'AI 常驻调用失败（HTTP ' + res.status + '）：' + JSON.stringify(data).slice(0, 240) };
      const text = String((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
        .map(p => p.text || '').join(''));
      const u = data.usageMetadata;
      const usage = u ? { i: u.promptTokenCount || 0, o: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } : null;
      return { ok: true, text, usage };
    }
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    (messages || []).forEach(m => msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (provider.apiKey || '')
      },
      body: JSON.stringify({
        model: provider.model,
        messages: msgs,
        temperature: temperature == null ? 0.8 : temperature
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: 'AI 常驻调用失败（HTTP ' + res.status + '）：' + JSON.stringify(data).slice(0, 240) };
    const text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '');
    const usage = data.usage ? { i: data.usage.prompt_tokens || 0, o: data.usage.completion_tokens || 0 } : null;
    return { ok: true, text, usage };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: 'AI 常驻请求失败：' + String(e && e.message || e).slice(0, 240) };
  }
}

async function residentChat(key, message, maxContinues) {
  return withResidentLock(String(key || '').trim(), () => residentChatImpl(key, message, maxContinues));
}

async function residentChatImpl(key, message, maxContinues) {
  const s = resident[key];
  if (!s) return { ok: false, error: '会话不存在：' + key };
  const text = String(message || '').trim().slice(0, 20000);
  if (!text) return { ok: false, error: '消息不能为空' };
  const userIdx = s.history.length;
  s.history.push({ role: 'user', content: text });
  const maxC = maxContinues == null ? 2 : Math.max(0, Math.min(4, Number(maxContinues) || 0));
  let continued = 0, reply = '', usageTotal = { i: 0, o: 0 };
  try {
    for (;;) {
      const r = await aiChatOnce(s.provider, s.history, residentSystem(s), s.temperature);
      if (!r.ok) {
        s.history.splice(userIdx);
        return { ok: false, error: r.error };
      }
      if (r.usage) { usageTotal.i += r.usage.i || 0; usageTotal.o += r.usage.o || 0; }
      const raw = String(r.text || '').trim();
      const m = raw.match(/(?:^|[\s，。！？!?,.;；])\/continue\s*$/i);
      const clean = m ? raw.slice(0, m.index).replace(/\s+$/, '') : raw;
      s.history.push({ role: 'assistant', content: clean || '（空回复）' });
      reply = clean;
      if (m && continued < maxC) { continued++; continue; }
      break;
    }
    s.updated = Date.now();
    if (s.history.length > 120) s.history = s.history.slice(-120);
    saveResident();
    return { ok: true, reply, continued, usage: usageTotal, messages: s.history.length };
  } catch (e) {
    s.history.splice(userIdx);
    return { ok: false, error: String(e && e.message || e).slice(0, 240) };
  }
}

async function residentProactive(key, prompt) {
  return withResidentLock(String(key || '').trim(), () => residentProactiveImpl(key, prompt));
}

async function residentProactiveImpl(key, prompt) {
  const s = resident[key];
  if (!s) return { ok: false, error: '会话不存在：' + key };
  const userText = String(prompt || '').trim().slice(0, 2000) ||
    '现在主动给用户发一条消息（80 字以内，像真人一样自然，不要加任何前缀或解释）。';
  const r = await aiChatOnce(s.provider, [{ role: 'user', content: userText }], residentSystem(s), Math.min(1.2, (s.temperature || 0.8) + 0.1));
  if (!r.ok) return r;
  const text = String(r.text || '').trim().replace(/(?:^|[\s，。！？!?,.;；])\/continue\s*$/i, '');
  if (!text) return { ok: false, error: '主动消息为空' };
  s.history.push({ role: 'assistant', content: text });
  if (s.history.length > 120) s.history = s.history.slice(-120);
  s.lastProactive = Date.now();
  s.updated = Date.now();
  saveResident();
  const from = String(s.name || key).slice(0, 40);
  broadcast({ type: 'push', title: '主动消息', text, from });
  const bark = await barkPush('主动消息', text, '');
  const ntfy = await ntfyPush('主动消息', text, '');
  recordPush({ title: '主动消息', text, from, bark: bark.ok, ntfy: ntfy.ok });
  return { ok: true, text, bark: bark.ok, ntfy: ntfy.ok };
}

const _residentBusy = new Set();
const _residentLocks = new Map();

async function withResidentLock(key, fn) {
  if (_residentLocks.has(key)) {
    return { ok: false, error: '该会话正在生成中，请稍候（上一轮还没结束）' };
  }
  const token = {};
  _residentLocks.set(key, token);
  try {
    return await fn();
  } finally {
    if (_residentLocks.get(key) === token) _residentLocks.delete(key);
  }
}

async function residentTick() {
  const now = Date.now();
  residentList().forEach(sum => {
    if (!sum.intervalMin || sum.intervalMin <= 0) return;
    if (sum.lastProactive && now - sum.lastProactive < sum.intervalMin * 60000) return;
    if (_residentBusy.has(sum.key)) return;
    _residentBusy.add(sum.key);
    residentProactive(sum.key, '').catch(() => {}).finally(() => _residentBusy.delete(sum.key));
  });
}

setInterval(() => { try { residentTick(); } catch (e) { /* 忽略 */ } }, Math.max(100, Number(process.env.IB_RESIDENT_TICK_MS) || 60000));

/* ------------------------------------------------------------------ */
/* 工具执行（供 WebSocket tool_call 与 REST 复用）                     */
/* ------------------------------------------------------------------ */

function contextAppend(friend, u) {
  return withListLock('context', () => {
    const key = String(friend || '_default');
    const arr = Array.isArray(contextStats[key]) ? contextStats[key] : [];
    arr.push({
      ts: Date.now(),
      i: Math.max(0, Number(u && u.input_tokens) || 0),
      cr: Math.max(0, Number(u && u.cached_tokens) || 0),
      cw: Math.max(0, Number(u && u.cache_creation_tokens) || 0),
      o: Math.max(0, Number(u && u.output_tokens) || 0)
    });
    while (arr.length > 200) arr.shift();
    contextStats[key] = arr;
    saveContext();
    return contextSummary(key);
  });
}

function contextSummary(friend) {
  const key = String(friend || '_default');
  const arr = Array.isArray(contextStats[key]) ? contextStats[key] : [];
  const budget = Math.max(10000, Number(config.contextBudget) || 200000);
  const total = arr.reduce((s, r) => s + (r.i || 0) + (r.o || 0) + (r.cr || 0) + (r.cw || 0), 0);
  const recent = arr.slice(-16).reduce((s, r) => s + (r.i || 0) + (r.o || 0) + (r.cr || 0) + (r.cw || 0), 0);
  return {
    ok: true,
    friend: key,
    budget,
    total,
    recent,
    records: arr.length,
    pct: Math.min(100, Math.round(recent / budget * 1000) / 10)
  };
}

function sessionGet(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: '缺少 session key' };
  const s = sessions[k];
  return { ok: true, session: s ? s.data : null, updated: s ? s.updated : null };
}

function sessionSave(key, data) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: '缺少 session key' };
  sessions[k] = { key: k, data: data === undefined ? null : data, updated: Date.now() };
  saveSessions();
  return { ok: true, updated: sessions[k].updated };
}

async function executeTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  try {
    switch (String(name || '')) {
      case 'echo':
        return { ok: true, text: 'pong', data: { echo: a } };

      case 'sticker_list': {
        const list = listStickers();
        return { ok: true, text: '可用表情：' + list.map(s => s.name).join('、') + '。消息中用 [sticker:' + (list[0] ? list[0].name : 'smile') + '] 这样的标记发送。', data: list };
      }

      case 'whispers_list':
      case 'whispers_read': {
        const limit = Math.max(1, Math.min(100, Number(a.limit) || 20));
        const list = whispers.slice(-limit).reverse();
        return { ok: true, text: list.length ? list.map(w => (w.author ? w.author + '：' : '') + w.text).join('\n') : '心语墙还是空的。', data: list };
      }

      case 'whispers_write': {
        const text = String(a.text || '').trim();
        if (!text) return { ok: false, error: '缺少心语内容' };
        const ww = await withListLock('whispers', () => {
          const w = { id: uid('whisper'), text: text.slice(0, 2000), author: String(a.author || 'AI').slice(0, 40), created: Date.now() };
          whispers.push(w);
          if (!saveList('whispers', whispers)) throw new Error('磁盘写入失败');
          return w;
        });
        return { ok: true, text: '已写入心语墙。', data: ww };
      }

      case 'whispers_delete': {
        const id = String(a.id || '');
        const r = await withListLock('whispers', () => {
          const before = whispers.length;
          whispers = whispers.filter(w => w.id !== id);
          if (before !== whispers.length && !saveList('whispers', whispers)) throw new Error('磁盘写入失败');
          return before !== whispers.length;
        });
        return { ok: r, text: r ? '已删除。' : '未找到该心语。' };
      }

      case 'whispers_update': {
        const id = String(a.id || '');
        const r = await withListLock('whispers', () => {
          const w = whispers.find(x => x.id === id);
          if (!w) throw new Error('未找到该心语');
          if (a.text !== undefined) {
            const text = String(a.text || '').trim();
            if (!text) throw new Error('心语内容不能为空');
            w.text = text.slice(0, 2000);
          }
          if (a.author !== undefined) w.author = String(a.author || '').slice(0, 40);
          if (!saveList('whispers', whispers)) throw new Error('磁盘写入失败');
          return w;
        });
        return { ok: true, text: '心语已更新。', data: r };
      }

      case 'health_read': {
        const days = Math.max(1, Math.min(365, Number(a.days) || 30));
        const since = Date.now() - days * 86400000;
        const list = healthData.filter(h => h.ts >= since).sort((x, y) => x.ts - y.ts);
        return { ok: true, text: '最近 ' + days + ' 天共 ' + list.length + ' 条健康记录。', data: list };
      }

      case 'geo_read': {
        if (!geoLatest) return { ok: false, error: '还没有位置数据。可在 DIY 的桥接面板里更新，或用 iOS 快捷指令推送。' };
        const w = a.withWeather ? await getWeather(geoLatest.city || geoLatest.address) : { ok: false };
        const data = Object.assign({}, geoLatest, w && w.ok ? { weather: w } : {});
        return { ok: true, text: '最近位置：' + (geoLatest.address || geoLatest.city || geoLatest.lat + ',' + geoLatest.lng) + '（' + new Date(geoLatest.ts).toLocaleString('zh-CN') + '）' + (w && w.ok ? '，当前天气 ' + (w.temp || '?') + '°C ' + (w.text || '') : ''), data };
      }

      case 'weather': {
        const w = await getWeather(a.city);
        if (!w.ok) return { ok: false, error: w.error };
        return { ok: true, text: w.city + '：' + (w.temp || '?') + '°C，体感 ' + (w.feels || '?') + '°C，' + (w.text || '') + '，湿度 ' + (w.humidity || '?') + '%。', data: w };
      }

      case 'music_search': {
        const r = await searchMusic(a.q || a.keyword, a.limit);
        if (!r.ok) return { ok: false, error: r.error };
        if (!r.songs.length) return { ok: true, text: '没有搜到相关歌曲。', data: { songs: [] } };
        const lines = r.songs.map((s, i) => (i + 1) + '. ' + s.name + ' - ' + s.artist);
        return { ok: true, text: '搜索结果：\n' + lines.join('\n') + '\n\n播放请用 [music:' + r.songs[0].id + '|' + r.songs[0].name + '] 标记，点击会直接打开酷狗播放。', data: r };
      }

      case 'music_url': {
        const r = await musicPlayUrl(a.id);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, text: '播放地址：' + r.url, data: r };
      }

      case 'webhook': {
        const name = String(a.name || '');
        const hooks = config.webhooks || {};
        const hook = hooks[name];
        if (!hook || !hook.url) return { ok: false, error: '未配置名为「' + name + '」的 Webhook' };
        const payload = a.data === undefined ? {} : a.data;
        const r = await fetchJson(hook.url, {
          method: String(hook.method || 'POST').toUpperCase(),
          headers: Object.assign({ 'Content-Type': 'application/json' }, hook.headers || {}),
          body: typeof payload === 'string' ? payload : JSON.stringify(payload)
        }, 15000);
        return { ok: r.ok, text: r.ok ? ('Webhook 调用成功（HTTP ' + r.status + '）' + (r.text ? '：' + r.text.slice(0, 200) : '')) : ('Webhook 调用失败（HTTP ' + r.status + '）：' + (r.text || '').slice(0, 200)), data: { status: r.status } };
      }

      case 'bark_push': {
        const r = await barkPush(a.title, a.text, a.url);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, text: '已推送到手机/手表。', data: r };
      }

      case 'push_send': {
        broadcast({ type: 'push', title: String(a.title || 'Internal Beyond').slice(0, 120), text: String(a.text || '').slice(0, 2000), from: String(a.from || 'Sui').slice(0, 40) });
        const bp = a.bark !== false && a.text ? await barkPush(a.title, a.text, a.url) : { ok: false };
        const np = a.ntfy !== false && a.text ? await ntfyPush(a.title, a.text, a.url) : { ok: false };
        recordPush({ title: a.title, text: a.text, from: a.from, bark: bp.ok, ntfy: np.ok });
        const pushed = (bp.ok ? '，Bark' : '') + (np.ok ? '，ntfy' : '');
        return { ok: true, text: '已推送给打开的页面' + (pushed ? '，并已推送（' + pushed.slice(1) + '）' : '。') };
      }

      case 'ntfy_push': {
        const r = await ntfyPush(a.title, a.text, a.url);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, text: '已推送到 Android/OPPO 手机。', data: r };
      }

      case 'tts_speak': {
        /* normalize 接受旧平铺参数（text/voice/provider/rate/pitch）与可选新字段（model/style/language 等） */
        const r = await ttsSynthesize(ttsNormalize(a));
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, text: 'Voice generated (' + r.url + ').', data: r };
      }

      case 'letter_write': {
        const content = String(a.content || '').trim();
        if (!content) return { ok: false, error: '缺少信件内容' };
        const l = await withListLock('letters', () => {
          const item = { id: uid('letter'), to: String(a.to || '').slice(0, 40), from: String(a.from || 'AI').slice(0, 40), content: content.slice(0, 10000), reply_to: String(a.reply_to || ''), read: false, created: Date.now() };
          letters.push(item);
          if (!saveList('letters', letters)) throw new Error('磁盘写入失败');
          return item;
        });
        return { ok: true, text: '信件已写好并投递。', data: l };
      }

      case 'letter_list': {
        const box = String(a.box || '');
        const list = letters
          .filter(l => !box || (box === 'out' ? l.from : l.to) === box)
          .sort((x, y) => y.created - x.created)
          .slice(0, Math.max(1, Math.min(50, Number(a.limit) || 20)));
        return { ok: true, text: list.length ? list.map(l => '[' + l.id + '] ' + (l.from || '?') + ' → ' + (l.to || '?') + '：' + l.content.slice(0, 80)).join('\n') : '邮箱是空的。', data: list };
      }

      case 'session_get': {
        const r = sessionGet(a.key);
        return { ok: r.ok, text: r.ok ? '会话状态已读取。' : r.error, data: r.session };
      }

      case 'session_save': {
        const r = sessionSave(a.key, a.data);
        return { ok: r.ok, text: r.ok ? '会话状态已保存。' : r.error, data: r };
      }

      case 'context_stats': {
        const r = contextSummary(a.friend);
        return { ok: true, text: '上下文用量约 ' + r.recent + ' / ' + r.budget + ' token（' + r.pct + '%）。', data: r };
      }

      case 'pay_register_checkout': {
        /* 3C-H2：checkout 捕获时在 Bridge 登记 canonical PaymentIntent（订单域字段，无凭证）。
           submit_payment 只凭 canonicalId+nonce，不再信任客户端重报的金额/域/orderId。 */
        const r = payGate.registerCheckout(a.fields || {});
        return { ok: !!r.ok, text: r.ok ? ('已登记 canonical 收银台（id=' + r.canonicalId + '，金额=' + r.amount + '）') : ('登记失败：' + (r.reason || '')), data: r };
      }

      case 'submit_payment': {
        /* 服务端权威支付入口：只信 canonical PaymentIntent（canonicalId+nonce）。
           绝不信任浏览器传来的 ALLOW / claimedAction / 重报的金额/orderId/domain/checkoutUrl。 */
        const g = await Promise.resolve(payGate.submitCanonical(a.canonicalId, {
          confirmToken: a.confirmToken,
          claimedAction: a.claimedAction,
          nonce: a.nonce,
          client: a.client || a.intent || {}
        }));
        const ok = g && g.status === 'SUCCESS';
        const lines = [];
        lines.push('支付决策=' + g.status);
        if (g.note) lines.push(g.note);
        if (g.manualLink) lines.push('人工支付宝链接=' + g.manualLink);
        if (g.reference) lines.push('交易引用=' + g.reference);
        return { ok: ok, text: lines.join('\n'), data: g };
      }

      case 'pay_request_confirm': {
        /* 人工确认卡路径：为一个 intent 签发 Bridge 侧确认令牌（模型无法自行签发） */
        const r = payGate.requestConfirm(a.intent);
        return { ok: true, text: '已生成确认令牌，需用户在确认卡点击后才可提交支付。', data: r };
      }

      case 'pay_get_config': {
        /* 授权策略配置 + 当前预算（Bridge 权威；UI 只读展示） */
        const b = payAuth.ledger();
        const cfg = payConfig();
        return {
          ok: true,
          text: '授权模式=' + cfg.mode + ' · 单笔上限=' + cfg.perOrderLimit + ' · 单日上限=' + cfg.dailyLimit + ' · 今日已花=' + b.spent + '/' + b.dailyLimit,
          data: { config: cfg, budget: b }
        };
      }

      case 'pay_set_config': {
        /* 更新授权策略（仅用于管理项；Gate 仍会独立重放 decide，不受 UI「声称」影响） */
        const next = payConfigure({
          mode: a.mode, perOrderLimit: a.perOrderLimit, dailyLimit: a.dailyLimit,
          allowedDomains: a.allowedDomains, currency: a.currency, ttlMs: a.ttlMs
        });
        return { ok: true, text: '支付授权配置已更新（模式=' + next.mode + '）。', data: { config: next, budget: payAuth.ledger() } };
      }

      default:
        return { ok: false, error: '未知工具：' + name };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 500) };
  }
}

/* ------------------------------------------------------------------ */
/* 工具目录                                                            */
/* ------------------------------------------------------------------ */

function toolSchema(extra) {
  return Object.assign({ type: 'object', properties: {} }, extra || {});
}

const TOOLS = [
  { name: 'echo', description: '连通性测试工具。', inputSchema: toolSchema() },
  { name: 'sticker_list', description: '列出当前可用的表情包名称，供 [sticker:名称] 使用。', inputSchema: toolSchema() },
  { name: 'whispers_read', description: '读取心语墙上最近的心情便笺。参数 limit（可选，默认20）。', inputSchema: toolSchema({ properties: { limit: { type: 'number' } } }) },
  { name: 'whispers_write', description: '在心语墙上写一条心情/碎碎念。参数 text 必填，author 可选。', inputSchema: toolSchema({ properties: { text: { type: 'string' }, author: { type: 'string' } } }) },
  { name: 'whispers_delete', description: '删除一条心语。参数 id 必填。', inputSchema: toolSchema({ properties: { id: { type: 'string' } } }) },
  { name: 'whispers_update', description: '修改一条心语。参数 id 必填，text/author 至少给一个。', inputSchema: toolSchema({ properties: { id: { type: 'string' }, text: { type: 'string' }, author: { type: 'string' } } }) },
  { name: 'health_read', description: '读取健康看板数据（来自 iOS 快捷指令推送的 Apple Health 摘要）。参数 days（可选，默认30）。', inputSchema: toolSchema({ properties: { days: { type: 'number' } } }) },
  { name: 'geo_read', description: '读取最近一次位置（来自 iOS 快捷指令或页面定位），withWeather=true 时附带天气。', inputSchema: toolSchema({ properties: { withWeather: { type: 'boolean' } } }) },
  { name: 'weather', description: '查询某城市实时天气与未来几天预报。参数 city 可选（缺省用最近位置）。', inputSchema: toolSchema({ properties: { city: { type: 'string' } } }) },
  { name: 'music_search', description: '搜索音乐（默认酷狗，可配置网易云）。参数 q 必填，limit 可选。返回歌曲列表，播放用 [music:ID|歌名] 标记。', inputSchema: toolSchema({ properties: { q: { type: 'string' }, limit: { type: 'number' } } }) },
  { name: 'music_url', description: '获取某首歌的播放地址（酷狗 hash 或网易云数字 ID）。参数 id 必填。', inputSchema: toolSchema({ properties: { id: { type: 'string' } } }) },
  { name: 'webhook', description: '调用用户在配置里登记的 Webhook。参数 name 必填，data 为传给对方的 JSON。', inputSchema: toolSchema({ properties: { name: { type: 'string' }, data: {} } }) },
  { name: 'bark_push', description: '推送一条消息到用户的手机/手表（需配置 Bark）。参数 title/text/url。', inputSchema: toolSchema({ properties: { title: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' } } }) },
  { name: 'ntfy_push', description: '推送一条消息到 Android/OPPO 手机（需配置 ntfy）。参数 title/text/url。', inputSchema: toolSchema({ properties: { title: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' } } }) },
  { name: 'tts_speak', description: '把一段文字合成为语音（AI 语音气泡）。参数 text 必填；voice/provider/model/style/language 均可选。', inputSchema: toolSchema({ properties: { text: { type: 'string' }, voice: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, style: { type: 'string' }, language: { type: 'string' } } }) },
  { name: 'push_send', description: '向当前打开的 Internal Beyond 页面推送一条消息（可选同时 Bark / ntfy）。', inputSchema: toolSchema({ properties: { title: { type: 'string' }, text: { type: 'string' }, from: { type: 'string' }, bark: { type: 'boolean' }, ntfy: { type: 'boolean' } } }) },
  { name: 'letter_write', description: '写一封服务器持久化的信。参数 to/from/content/reply_to。', inputSchema: toolSchema({ properties: { to: { type: 'string' }, from: { type: 'string' }, content: { type: 'string' }, reply_to: { type: 'string' } } }) },
  { name: 'letter_list', description: '读取服务器信箱里的信。参数 box（in/out/角色名）可选。', inputSchema: toolSchema({ properties: { box: { type: 'string' }, limit: { type: 'number' } } }) },
  { name: 'session_get', description: '读取某个窗口/话题的服务端持久化会话状态。参数 key 必填。', inputSchema: toolSchema({ properties: { key: { type: 'string' } } }) },
  { name: 'session_save', description: '保存某个窗口/话题的服务端持久化会话状态（断线/换设备不丢）。参数 key/data。', inputSchema: toolSchema({ properties: { key: { type: 'string' }, data: {} } }) },
  { name: 'context_stats', description: '查看当前聊天上下文估算用量（token 与百分比）。参数 friend 可选。', inputSchema: toolSchema({ properties: { friend: { type: 'string' } } }) },
  { name: 'pay_register_checkout', description: '在 checkout 捕获时登记 canonical PaymentIntent（amount/orderId/domain/checkoutUrl）。返回 canonicalId+nonce，供 submit_payment 使用；不保存支付凭证。', inputSchema: toolSchema({ properties: { fields: {} } }) },
  { name: 'submit_payment', description: '提交支付宝 AI 付支付（服务端权威授权）。参数 canonicalId 必填、nonce 必填；可选 client 仅用于校验一致（不一致会 DENY）。绝不信任客户端重报的金额/orderId/domain/checkoutUrl。', inputSchema: toolSchema({ properties: { canonicalId: { type: 'string' }, nonce: { type: 'string' }, confirmToken: { type: 'string' }, claimedAction: { type: 'string' }, client: {} } }) },
  { name: 'pay_request_confirm', description: '为一笔需人工确认的支付签发确认令牌（仅在此后才可 Enter Provider）。参数 intent 必填。', inputSchema: toolSchema({ properties: { intent: {} } }) },
  { name: 'pay_get_config', description: '读取支付授权策略配置与当前预算（只读）。无参数。', inputSchema: toolSchema() },
  { name: 'pay_set_config', description: '更新支付授权策略（mode/perOrderLimit/dailyLimit/allowedDomains）。参数可选。', inputSchema: toolSchema({ properties: { mode: { type: 'string' }, perOrderLimit: { type: 'number' }, dailyLimit: { type: 'number' }, allowedDomains: { type: 'array' } } }) }
];

/* ------------------------------------------------------------------ */
/* WebSocket 服务（RFC6455 最小实现，零依赖）                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* WebSocket 层（已提取到 bridge/ws.js 工厂；心跳 / 广播 / 连接 / 分发） */
/* ------------------------------------------------------------------ */

const createWs = require('./bridge/ws');
const pushHistory = pushes;
const wsLayer = createWs({
  config,
  executeTool,
  tools: TOOLS,
  maxFrame: MAX_FRAME,
  serverName: SERVER_NAME,
  version: VERSION,
  pushHistory,
  withListLock,
  uid,
  savePushes,
  voiceRuntime
});
const wsSockets = wsLayer.wsSockets;
const recordPush = wsLayer.recordPush;
const broadcast = wsLayer.broadcast;
const WSConnection = wsLayer.WSConnection;

/* WSConnection 已提取到 bridge/ws.js */

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* HTTP 路由层（已提取到 bridge/routes.js 工厂；全部依赖经 ctx 注入）  */
/* ------------------------------------------------------------------ */

const createRoutes = require('./bridge/routes');
const httpLayer = createRoutes({
  config, LAN_EXPOSED, configInvalid, SERVER_NAME, VERSION, HOST, PORT, BIND_HOST,
  DATA_DIR, STICKER_DIR, maxBody: MAX_BODY,
  wsSockets, TOOLS, listStickers,
  getWhispers: () => whispers, setWhispers: v => { whispers = v; },
  healthData,
  getGeoLatest: () => geoLatest, setGeoLatest: v => { geoLatest = v; },
  getLetters: () => letters, setLetters: v => { letters = v; },
  sessions, resident, contextStats, pushHistory,
  withListLock, uid, todayStr, saveList, saveGeo, saveSessions, saveResident,
  getWeather, searchMusic, musicPlayUrl, musicPlayRemote, searchNetease,
  barkPush, ntfyPush, ttsNormalize, ttsSynthesize, ttsVoices,
  sessionGet, sessionSave, contextAppend, contextSummary,
  residentList, residentUpsert, residentSummary, residentChat, residentProactive,
  broadcast, recordPush, lanAddresses, fileSummary, directoryUsage,
  httpAuthorized, authRequiredResponse,
  parseQuery, corsOrigin
});
const sendJsonRes = httpLayer.sendJsonRes;
const corsHeaders = httpLayer.corsHeaders;
const rateCheck = httpLayer.rateCheck;
const readBody = httpLayer.readBody;
const safeConfigSnapshot = httpLayer.safeConfigSnapshot;
const diagnosticsSnapshot = httpLayer.diagnosticsSnapshot;
const handleHttp = httpLayer.handleHttp;

/* parseQuery 已提取到 bridge/util.js */

/* safeConfigSnapshot 已提取到 bridge/routes.js */

/* fileSummary / directoryUsage 已提取到 bridge/persistence.js */

/* diagnosticsSnapshot 已提取到 bridge/routes.js */

/* handleHttp 已提取到 bridge/routes.js（工厂注入 getter/setter 保持状态一致） */

/* ------------------------------------------------------------------ */
/* 可选：低频主动消息（本地心跳）                                      */
/* ------------------------------------------------------------------ */

let proactiveTimer = null;

async function proactiveTick() {
  const p = config.proactive || {};
  if (!p.enabled || !p.endpoint) return;
  try {
    const messages = [
      { role: 'system', content: String(p.system || '你是陪伴者。') },
      { role: 'user', content: String(p.prompt || '主动给用户发一条简短消息。') }
    ];
    const body = { model: String(p.model || 'gpt-4o-mini'), messages, temperature: 0.9, max_tokens: 300 };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let data = {};
    try {
      const res = await fetch(p.endpoint, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, p.apiKey ? { 'Authorization': 'Bearer ' + p.apiKey } : {}),
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      data = await res.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
    const text = String(((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '')).trim().slice(0, 2000);
    if (!text) return;
    const from = String(p.from || 'Sui').slice(0, 40);
    broadcast({ type: 'push', title: '主动消息', text, from });
    const bp = await barkPush('主动消息', text, '');
    const np = await ntfyPush('主动消息', text, '');
    recordPush({ title: '主动消息', text, from, bark: bp.ok, ntfy: np.ok });
  } catch (e) {
    console.error('[IB Bridge] 主动消息失败：' + String(e && e.message || e));
  }
}

function ensureProactive() {
  if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null; }
  const p = config.proactive || {};
  if (!p.enabled || !p.endpoint) return;
  const min = Math.max(1, Number(p.intervalMin) || 50);
  proactiveTimer = setInterval(proactiveTick, min * 60000);
  console.log('[IB Bridge] 主动消息已启用，每 ' + min + ' 分钟一次');
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch(e => {
    try { sendJsonRes(res, 500, { ok: false, error: String(e && e.message || e) }); } catch (e2) { /* 忽略 */ }
  });
});
server.timeout = 30000;             /* 30 秒无活动自动断开 */
server.requestTimeout = 30000;       /* 30 秒请求超时 */
server.headersTimeout = 10000;       /* 10 秒等待请求头 */
server.keepAliveTimeout = 10000;     /* 10 秒空闲保持 */

server.on('upgrade', (req, socket, head) => {
  const key = String(req.headers['sec-websocket-key'] || '');
  const version = String(req.headers['sec-websocket-version'] || '');
  if (!key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const origin = String(req.headers.origin || '').trim();
  if (origin && origin !== 'null') {
    let originOk = false;
    try {
      const u = new URL(origin);
      const host = String(u.hostname).toLowerCase();
      if ((u.protocol === 'http:' || u.protocol === 'https:') &&
          (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' ||
           (LAN_EXPOSED && lanAddresses().indexOf(host) !== -1))) {
        originOk = true;
      }
    } catch (e) { /* 非法 Origin 一律拒绝 */ }
    if (!originOk) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  /* In LAN mode require a token before upgrading. Browser WebSocket clients
     cannot set Authorization, so the DIY client passes it as a URL parameter
     for this one handshake; the hello-frame check remains a second boundary. */
  const upgradeToken = suppliedToken(req, parseQuery(new URL(req.url || '/', 'http://localhost')));
  if (LAN_EXPOSED && !constantTimeTokenMatch(upgradeToken, config.token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );
  const conn = new WSConnection(socket, req);
  if (head && head.length) conn.onData(head);
  socket.on('data', chunk => conn.onData(chunk));
  socket.on('error', () => conn.close(1006, 'socket error'));
  socket.on('close', () => conn.close(1006, 'socket closed'));
  socket.setKeepAlive(true);
});

server.listen(PORT, BIND_HOST, () => {
  console.log('==========================================================');
  console.log('  Internal Beyond - 本地 Bridge 后端 v' + VERSION);
  console.log('  地址:  http://' + BIND_HOST + ':' + PORT);
  console.log('  WS:    ws://' + BIND_HOST + ':' + PORT);
  console.log('  数据:  ' + DATA_DIR);
  console.log('  表情:  ' + STICKER_DIR);
  console.log('  音乐:  ' + ((config.music && config.music.provider) || 'kugou') + '（config.json 可切换）');
  console.log('  AI常驻: ' + Object.keys(resident).length + ' 个会话 · TTS: ' + ((config.tts && config.tts.enabled) ? '已启用' : '未启用（config.json 配置 tts）'));
  console.log('  健康:  GET /health');
  console.log('==========================================================');
  console.log('  InternalBeyond.html → DIY → 后端连接 →');
  console.log('  地址填 ws://' + BIND_HOST + ':' + PORT + '，勾选启用后点连接。');
  if (BIND_HOST === '0.0.0.0') {
    const lans = lanAddresses();
    console.log('  已监听局域网（config.lan=true）。手机访问：');
    lans.forEach(ip => console.log('    http://' + ip + ':' + PORT + '   /   ws://' + ip + ':' + PORT));
    if (!lans.length) console.log('    （未找到局域网 IPv4 地址，请检查网络）');
    console.log('  局域网业务接口已启用 token 鉴权（Authorization: Bearer 或 X-IB-Token）。');
  }
  if (config.token) console.log('  已开启鉴权 token（在 IBNET 配置里填写相同 token）。');
  ensureProactive();
});

server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('[IB Bridge] 端口 ' + PORT + ' 已被占用。可设置环境变量 IB_BRIDGE_PORT 换端口。');
  } else {
    console.error('[IB Bridge] 启动失败：', e);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[IB Bridge] 正在退出…');
  if (proactiveTimer) clearInterval(proactiveTimer);
  try { server.close(); } catch (e) { /* 忽略 */ }
  process.exit(0);
});
