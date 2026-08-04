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
/* 轻量 JSON 持久化                                                    */
/* ------------------------------------------------------------------ */

function jsonPath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function deepMerge(base, extra) {
  const out = Object.assign({}, base);
  Object.keys(extra || {}).forEach(k => {
    const bv = base[k], ev = extra[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) &&
        ev && typeof ev === 'object' && !Array.isArray(ev)) {
      out[k] = deepMerge(bv, ev);
    } else {
      out[k] = ev;
    }
  });
  return out;
}

function backupBrokenFile(file, reason) {
  try {
    const broken = file + '.broken-' + Date.now().toString(36);
    fs.copyFileSync(file, broken);
    console.warn('[IB Bridge] 数据文件' + reason + '，已备份到 ' + broken);
  } catch (e) { /* 备份失败不阻断启动 */ }
}

function loadJson(name, fallback) {
  const file = jsonPath(name);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (fs.existsSync(file)) backupBrokenFile(file, '不是合法对象');
    return fallback;
  } catch (e) {
    if (fs.existsSync(file)) backupBrokenFile(file, '解析失败');
    return fallback;
  }
}

function saveJson(name, obj) {
  const file = jsonPath(name);
  const tmp = file + '.tmp';
  const bak = file + '.bak';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, bak); } catch (e) { /* 忽略备份失败 */ }
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    return false;
  }
}

function loadList(name) {
  const file = jsonPath(name);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (fs.existsSync(file)) backupBrokenFile(file, '不是数组');
    return [];
  } catch (e) {
    if (fs.existsSync(file)) backupBrokenFile(file, '解析失败');
    return [];
  }
}

function saveList(name, list) {
  return saveJson(name, list);
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function defaultConfig() {
  return {
    version: 1,
    token: '',                     // 留空 = 仅本机、不鉴权；设置后 IBNET 需要填写相同 token
    contextBudget: 200000,         // 上下文估算预算（token），进度条按此计算
    lan: false,                    // true = 监听 0.0.0.0，方便 OPPO/Android 手机访问（注意放行防火墙）
    music: {                       // 点歌：默认酷狗（你会员在酷狗）；可切 netease
      provider: 'kugou',
      kugouCookie: '',             // 可选：浏览器里登录酷狗后复制的 Cookie，会员歌/高品质更稳
      fallbackNetease: true        // 酷狗拿不到播放地址时，按歌名自动切网易云兜底
    },
    tts: {                         // AI 语音气泡：OpenAI 兼容 TTS 接口
      enabled: false,
      endpoint: 'https://api.openai.com/v1/audio/speech',
      apiKey: '',
      model: 'tts-1',
      voice: 'alloy',
      lang: 'zh-CN'
    },
    bark: { enabled: false, url: '' },   // 例：https://api.day.app/你的Key
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },  // Android/OPPO 推荐
    webhooks: {},                  // { 名称: { url, method, headers, confirm } }
    proactive: {                   // 可选：本地低频主动消息（默认关闭）
      enabled: false,
      intervalMin: 50,
      endpoint: '',
      apiKey: '',
      model: '',
      system: '你是陪伴者，发一条简短、自然、像真人一样主动发来的消息。',
      prompt: '现在主动给用户发一条消息（50 字以内，不要加任何前缀或解释）。',
      from: 'Sui'
    }
  };
}

const CONFIG_FILE = jsonPath('config');
let configRaw = null;
let configInvalid = false;
try {
  const text = fs.readFileSync(CONFIG_FILE, 'utf8');
  configRaw = JSON.parse(text);
  if (!configRaw || typeof configRaw !== 'object' || Array.isArray(configRaw)) {
    throw new Error('配置根节点不是对象');
  }
} catch (e) {
  configInvalid = true;
  configRaw = null;
}
let config = deepMerge(defaultConfig(), configRaw || {});

const BIND_HOST = process.env.IB_BRIDGE_HOST || (config.lan ? '0.0.0.0' : '127.0.0.1');

function lanAddresses() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(k => {
      (ifs[k] || []).forEach(a => {
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
      });
    });
  } catch (e) { /* 忽略 */ }
  return out;
}

/* 只允许本机 / file:// 页面跨域读取，避免 lan 模式下任意网站读写本服务 */
function corsOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return null;
  if (origin === 'null') return origin;
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:') return origin;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const host = String(u.hostname).toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return origin;
    }
  } catch (e) { /* 忽略非法 Origin */ }
  return null;
}

function persistConfig() {
  saveJson('config', config);
}

function configNeedsUpgrade() {
  const d = defaultConfig();
  if (!configRaw || typeof configRaw !== 'object') return false;
  if (Object.keys(d).some(k => !(k in configRaw))) return true;
  let nestedMissing = false;
  ['music', 'tts', 'bark', 'ntfy', 'proactive'].forEach(k => {
    const dv = d[k], rv = configRaw[k];
    if (dv && typeof dv === 'object' && rv && typeof rv === 'object') {
      if (Object.keys(dv).some(n => !(n in rv))) nestedMissing = true;
    }
  });
  return nestedMissing;
}

function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    persistConfig();
    console.log('[IB Bridge] 已生成配置文件: ' + CONFIG_FILE);
    console.log('[IB Bridge] 默认不开启鉴权（仅监听 127.0.0.1）。如需鉴权，请编辑配置里的 token。');
    return;
  }
  if (configInvalid) {
    try {
      const broken = CONFIG_FILE + '.broken-' + Date.now().toString(36);
      fs.copyFileSync(CONFIG_FILE, broken);
      console.warn('[IB Bridge] 配置文件损坏，已备份到 ' + broken + '，并重建默认配置。');
    } catch (e) {
      console.warn('[IB Bridge] 配置文件损坏且备份失败：' + String(e && e.message || e));
    }
    persistConfig();
    return;
  }
  if (configNeedsUpgrade()) {
    persistConfig();
    console.log('[IB Bridge] 配置文件已自动补齐新字段（lan / music / tts / ntfy 等）。');
  }
}
ensureConfigFile();

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

function saveWhispers() { saveList('whispers', whispers); }
function saveHealth() { saveList('health', healthData); }
function saveGeo() { saveJson('geo', geoLatest); }
function saveLetters() { saveList('letters', letters); }
function saveSessions() { saveJson('sessions', sessions); }
function saveResident() { saveJson('resident', resident); }
function saveContext() { saveJson('context', contextStats); }
function savePushes() { saveList('push_history', pushes.slice(0, 200)); }

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function todayStr(d) {
  const x = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

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
/* 外部服务：天气 / 网易云音乐 / Bark                                  */
/* ------------------------------------------------------------------ */

async function fetchJson(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal, redirect: 'follow' }, options || {}));
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, json: JSON.parse(text), text }; }
    catch (e) { return { ok: res.ok, status: res.status, json: null, text }; }
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function getWeather(city) {
  const q = String(city || '').trim() || (geoLatest && (geoLatest.city || geoLatest.address)) || '';
  const url = 'https://wttr.in/' + encodeURIComponent(q || '') + '?format=j1&lang=zh';
  const r = await fetchJson(url, {
    headers: { 'User-Agent': 'curl/8.0' }
  }, 12000);
  if (!r.ok || !r.json) return { ok: false, error: '天气服务暂不可用：' + (r.text || '').slice(0, 120) };
  const j = r.json;
  const cur = j.current_condition && j.current_condition[0];
  const today = j.weather && j.weather[0];
  const days = (j.weather || []).slice(0, 5).map(w => ({
    date: w.date,
    max: w.maxtempC,
    min: w.mintempC,
    text: w.hourly && w.hourly[0] && w.hourly[0].lang_zh && w.hourly[0].lang_zh[0] ? w.hourly[0].lang_zh[0].value : (w.hourly && w.hourly[0] && w.hourly[0].weatherDesc && w.hourly[0].weatherDesc[0] && w.hourly[0].weatherDesc[0].value || '')
  }));
  return {
    ok: true,
    city: (today && today.area && today.area[0] && today.area[0].value) || q || '未知',
    temp: cur && cur.temp_C,
    feels: cur && cur.FeelsLikeC,
    humidity: cur && cur.humidity,
    wind: cur && cur.windspeedKmph,
    text: cur && cur.lang_zh && cur.lang_zh[0] && cur.lang_zh[0].value || (cur && cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '',
    days
  };
}

async function searchNetease(keyword, limit) {
  const q = String(keyword || '').trim();
  if (!q) return { ok: false, error: '缺少搜索关键词' };
  const n = Math.max(1, Math.min(20, Number(limit) || 10));
  const body = new URLSearchParams({ s: q, type: '1', limit: String(n), offset: '0', total: 'true' }).toString();
  const r = await fetchJson('https://music.163.com/api/search/get/web', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://music.163.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    },
    body
  }, 15000);
  if (!r.ok || !r.json) return { ok: false, error: '网易云搜索暂不可用：' + (r.text || '').slice(0, 120) };
  const songs = (r.json.result && r.json.result.songs) || [];
  return {
    ok: true,
    songs: songs.slice(0, n).map(s => ({
      id: String(s.id || ''),
      name: s.name || '',
      artist: (s.artists || []).map(a => a.name).join(' / '),
      album: s.album && s.album.name || '',
      duration: s.duration || 0
    }))
  };
}

async function searchKugou(keyword, limit) {
  const q = String(keyword || '').trim();
  if (!q) return { ok: false, error: '缺少搜索关键词' };
  const n = Math.max(1, Math.min(20, Number(limit) || 10));
  const url = 'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(q) +
    '&page=1&pagesize=' + n + '&userid=-1&clientver=&platform=WebFilter&tag=em&filter=2&iscorrection=1&privilege_filter=0';
  const r = await fetchJson(url, {
    headers: {
      'Referer': 'https://www.kugou.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    }
  }, 15000);
  if (!r.ok || !r.json) return { ok: false, error: '酷狗搜索暂不可用：' + (r.text || '').slice(0, 120) };
  const list = (r.json.data && r.json.data.lists) || [];
  const strip = s => String(s || '').replace(/<[^>]+>/g, '').trim();
  return {
    ok: true,
    provider: 'kugou',
    songs: list.slice(0, n).map(s => ({
      id: String(s.FileHash || s.EMixSongID || ''),
      name: strip(s.SongName || s.SongCName || ''),
      artist: strip(s.SingerName || ''),
      album: strip(s.AlbumName || ''),
      duration: (Number(s.Duration) || 0) * 1000
    })).filter(s => s.id)
  };
}

async function searchMusic(keyword, limit) {
  const provider = (config.music && config.music.provider) || 'kugou';
  if (provider === 'netease') return searchNetease(keyword, limit);
  return searchKugou(keyword, limit);
}

async function kugouPlayUrl(hash) {
  const h = String(hash || '').trim();
  if (!/^[A-Za-z0-9]+$/.test(h)) return { ok: false, error: '歌曲 ID 无效' };
  const url = 'https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + encodeURIComponent(h);
  const cookie = (config.music && config.music.kugouCookie) || '';
  const r = await fetchJson(url, {
    headers: {
      'Referer': 'https://m.kugou.com/',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'Cookie': cookie
    }
  }, 20000);
  if (!r.ok || !r.json || r.json.status !== 1) {
    const j = r.json;
    const msg = String((j && j.error) || '无法播放').slice(0, 80);
    const vipHint = (msg.indexOf('付费') >= 0 || msg.indexOf('会员') >= 0)
      ? '（你有会员的话，把浏览器登录酷狗后的 Cookie 填进 config.json 的 music.kugouCookie）'
      : '';
    return { ok: false, error: '酷狗：' + msg + vipHint };
  }
  const j = r.json;
  if (!j.url) {
    return { ok: false, error: '这首歌没有可播放地址（可能需要登录/会员，或把酷狗 Cookie 填进 config.json 的 music.kugouCookie）' };
  }
  return {
    ok: true,
    provider: 'kugou',
    id: h,
    name: j.songName || '',
    artist: j.singerName || '',
    rawUrl: String(j.url),
    url: '/api/music/play?id=' + encodeURIComponent(h)
  };
}

async function musicPlayUrl(id) {
  const sid = String(id || '').trim();
  if (!sid) return { ok: false, error: '歌曲 ID 无效' };
  const provider = (config.music && config.music.provider) || 'kugou';
  if (provider === 'netease') {
    if (!/^\d+$/.test(sid)) return { ok: false, error: '网易云歌曲 ID 无效' };
    return { ok: true, provider: 'netease', id: sid, url: '/api/music/play?id=' + sid };
  }
  return kugouPlayUrl(sid);
}

async function musicPlayRemote(id) {
  const sid = String(id || '').trim();
  const provider = (config.music && config.music.provider) || 'kugou';
  if (provider === 'netease') {
    if (!/^\d+$/.test(sid)) return { ok: false, error: '网易云歌曲 ID 无效' };
    return { ok: true, url: 'https://music.163.com/song/media/outer/url?id=' + sid + '.mp3' };
  }
  const k = await kugouPlayUrl(sid);
  if (!k.ok) return k;
  return { ok: true, url: k.rawUrl };
}

async function barkPush(title, text, url) {
  const bark = config.bark || {};
  if (!bark.enabled || !bark.url) return { ok: false, error: 'Bark 未配置' };
  let target = String(bark.url).replace(/\/+$/, '');
  target += '/' + encodeURIComponent(String(title || 'Internal Beyond'));
  target += '/' + encodeURIComponent(String(text || ''));
  if (url) target += '?url=' + encodeURIComponent(url);
  const r = await fetchJson(target, {}, 10000);
  if (!r.ok) return { ok: false, error: 'Bark 推送失败：' + (r.text || '').slice(0, 120) };
  const j = r.json;
  if (j && j.code === 200) return { ok: true, message: j.message || '已推送' };
  return { ok: false, error: 'Bark 返回异常：' + (r.text || '').slice(0, 120) };
}

async function ntfyPush(title, text, url) {
  const n = config.ntfy || {};
  if (!n.enabled || !n.topic) return { ok: false, error: 'ntfy 未配置' };
  const server = String(n.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const body = String(text || '') + (url ? ('\n' + url) : '');
  const r = await fetchJson(server + '/' + encodeURIComponent(String(n.topic)), {
    method: 'POST',
    headers: {
      'Title': String(title || 'Internal Beyond'),
      'Priority': 'default',
      'Content-Type': 'text/plain',
      'User-Agent': 'InternalBeyond-Bridge'
    },
    body
  }, 10000);
  if (!r.ok) return { ok: false, error: 'ntfy 推送失败（HTTP ' + r.status + '）：' + (r.text || '').slice(0, 120) };
  return { ok: true, message: '已推送到 ntfy' };
}

/* ------------------------------------------------------------------ */
/* AI 语音气泡（TTS，OpenAI 兼容 /audio/speech）                        */
/* ------------------------------------------------------------------ */

async function ttsGenerate(text, voice) {
  const t = config.tts || {};
  if (!t.enabled || !t.endpoint || !t.apiKey) {
    return { ok: false, error: 'TTS 未配置：编辑 config.json 的 tts（enabled/endpoint/apiKey/model/voice）' };
  }
  const input = String(text || '').trim();
  if (!input) return { ok: false, error: '缺少朗读文本' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(t.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (t.apiKey || '')
      },
      body: JSON.stringify({
        model: t.model || 'tts-1',
        input: input.slice(0, 4000),
        voice: voice || t.voice || 'alloy',
        response_format: 'mp3'
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return { ok: false, error: 'TTS 合成失败（HTTP ' + res.status + '）：' + err.slice(0, 200) };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'TTS 返回空音频' };
    const id = uid('tts');
    fs.writeFileSync(path.join(DATA_DIR, id + '.mp3'), buf);
    return { ok: true, id, url: '/tts/' + id + '.mp3', bytes: buf.length, lang: t.lang || 'zh-CN' };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: 'TTS 请求失败：' + String(e && e.message || e).slice(0, 200) };
  }
}

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
        const w = { id: uid('whisper'), text: text.slice(0, 2000), author: String(a.author || 'AI').slice(0, 40), created: Date.now() };
        whispers.push(w);
        saveWhispers();
        return { ok: true, text: '已写入心语墙。', data: w };
      }

      case 'whispers_delete': {
        const id = String(a.id || '');
        const before = whispers.length;
        whispers = whispers.filter(w => w.id !== id);
        saveWhispers();
        return { ok: before !== whispers.length, text: before !== whispers.length ? '已删除。' : '未找到该心语。' };
      }

      case 'whispers_update': {
        const id = String(a.id || '');
        const w = whispers.find(x => x.id === id);
        if (!w) return { ok: false, error: '未找到该心语' };
        if (a.text !== undefined) {
          const text = String(a.text || '').trim();
          if (!text) return { ok: false, error: '心语内容不能为空' };
          w.text = text.slice(0, 2000);
        }
        if (a.author !== undefined) w.author = String(a.author || '').slice(0, 40);
        saveWhispers();
        return { ok: true, text: '心语已更新。', data: w };
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
        const r = await ttsGenerate(a.text, a.voice);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, text: '已生成语音气泡（' + r.url + '），前端会显示可播放的语音条。', data: r };
      }

      case 'letter_write': {
        const content = String(a.content || '').trim();
        if (!content) return { ok: false, error: '缺少信件内容' };
        const l = { id: uid('letter'), to: String(a.to || '').slice(0, 40), from: String(a.from || 'AI').slice(0, 40), content: content.slice(0, 10000), reply_to: String(a.reply_to || ''), read: false, created: Date.now() };
        letters.push(l);
        saveLetters();
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
  { name: 'tts_speak', description: '把一段文字合成为语音（AI 语音气泡）。参数 text 必填，voice 可选。', inputSchema: toolSchema({ properties: { text: { type: 'string' }, voice: { type: 'string' } } }) },
  { name: 'push_send', description: '向当前打开的 Internal Beyond 页面推送一条消息（可选同时 Bark / ntfy）。', inputSchema: toolSchema({ properties: { title: { type: 'string' }, text: { type: 'string' }, from: { type: 'string' }, bark: { type: 'boolean' }, ntfy: { type: 'boolean' } } }) },
  { name: 'letter_write', description: '写一封服务器持久化的信。参数 to/from/content/reply_to。', inputSchema: toolSchema({ properties: { to: { type: 'string' }, from: { type: 'string' }, content: { type: 'string' }, reply_to: { type: 'string' } } }) },
  { name: 'letter_list', description: '读取服务器信箱里的信。参数 box（in/out/角色名）可选。', inputSchema: toolSchema({ properties: { box: { type: 'string' }, limit: { type: 'number' } } }) },
  { name: 'session_get', description: '读取某个窗口/话题的服务端持久化会话状态。参数 key 必填。', inputSchema: toolSchema({ properties: { key: { type: 'string' } } }) },
  { name: 'session_save', description: '保存某个窗口/话题的服务端持久化会话状态（断线/换设备不丢）。参数 key/data。', inputSchema: toolSchema({ properties: { key: { type: 'string' }, data: {} } }) },
  { name: 'context_stats', description: '查看当前聊天上下文估算用量（token 与百分比）。参数 friend 可选。', inputSchema: toolSchema({ properties: { friend: { type: 'string' } } }) }
];

/* ------------------------------------------------------------------ */
/* WebSocket 服务（RFC6455 最小实现，零依赖）                          */
/* ------------------------------------------------------------------ */

let wsSockets = new Set();
const pushHistory = pushes;

function recordPush(p) {
  pushHistory.unshift({
    id: uid('push'), ts: Date.now(),
    title: p && p.title, text: p && p.text, from: p && p.from,
    bark: !!(p && p.bark), ntfy: !!(p && p.ntfy)
  });
  savePushes();
}

function broadcast(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  wsSockets.forEach(conn => {
    try { conn.sendFrame(0x1, payload); } catch (e) { /* 忽略单个连接错误 */ }
  });
}

class WSConnection {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOp = null;
    this.closed = false;
    this.alive = true;
    this.remote = req.socket && (req.socket.remoteAddress || '');
  }

  onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.alive = true;
    try { this.processFrames(); } catch (e) {
      this.close(1002, '协议解析错误');
    }
  }

  processFrames() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const high = this.buf.readUInt32BE(off);
        const low = this.buf.readUInt32BE(off + 4);
        if (high !== 0 || low > MAX_FRAME) throw new Error('frame too large');
        len = low;
        off += 8;
      }
      if (len > MAX_FRAME) throw new Error('frame too large');
      let maskKey = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        maskKey = this.buf.slice(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (maskKey) {
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      if (opcode === 0x8) { /* close */
        let code = 1000, reason = '';
        if (payload.length >= 2) { code = payload.readUInt16BE(0); reason = payload.slice(2).toString('utf8'); }
        this.close(code === 1005 ? 1000 : code, reason);
        return;
      }
      if (opcode === 0x9) { /* ping */
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue; /* pong */
      if (opcode === 0x0) { /* continuation */
        if (this.fragOp === null) throw new Error('unexpected continuation');
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const op = this.fragOp;
          this.fragments = [];
          this.fragOp = null;
          this.handleMessage(op, full);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragments = [payload];
          this.fragOp = opcode;
          continue;
        }
        this.handleMessage(opcode, payload);
        continue;
      }
      throw new Error('unsupported opcode ' + opcode);
    }
  }

  handleMessage(opcode, payload) {
    if (opcode !== 0x1) return;
    let msg = null;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    this.dispatch(msg);
  }

  dispatch(msg) {
    const t = msg.type;
    if (t === 'ping') {
      this.sendFrame(0x1, Buffer.from(JSON.stringify({ type: 'pong', t: msg.t })));
      return;
    }
    if (t === 'pong') return;
    if (t === 'hello') {
      const token = String(msg.token || '');
      const expect = String(config.token || '');
      if (expect && token !== expect) {
        this.close(4401, 'unauthorized');
        return;
      }
      this.authorized = true;
      wsSockets.add(this);
      this.sendFrame(0x1, Buffer.from(JSON.stringify({
        type: 'hello_ack', ok: true, server: SERVER_NAME, version: VERSION,
        tools: TOOLS.map(x => ({ name: x.name, description: x.description, inputSchema: x.inputSchema }))
      })));
      return;
    }
    if (!this.authorized) {
      this.close(4401, 'unauthorized');
      return;
    }
    if (t === 'tool_catalog_request') {
      this.sendFrame(0x1, Buffer.from(JSON.stringify({ type: 'tool_catalog', tools: TOOLS.map(x => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })) })));
      return;
    }
    if (t === 'tool_call') {
      const id = String(msg.id || '');
      const name = String(msg.name || '');
      const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
      Promise.resolve(executeTool(name, args)).then(r => {
        const out = { type: 'tool_result', id, ok: r.ok !== false, error: r.ok === false ? String(r.error || '工具调用失败') : '', text: String(r.text || ''), data: r.data };
        if (!this.closed) this.sendFrame(0x1, Buffer.from(JSON.stringify(out)));
      }).catch(e => {
        if (!this.closed) this.sendFrame(0x1, Buffer.from(JSON.stringify({ type: 'tool_result', id, ok: false, error: String(e && e.message || e).slice(0, 500), text: '' })));
      });
      return;
    }
    /* 其他类型原样忽略（未知消息不视为错误） */
  }

  sendFrame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | (opcode & 0x0f);
    this.socket.write(Buffer.concat([header, payload]));
  }

  sendJson(obj) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close(code, reason) {
    if (this.closed) return;
    try {
      const rbuf = Buffer.from(String(reason || ''), 'utf8');
      const out = Buffer.alloc(2 + rbuf.length);
      out.writeUInt16BE(code || 1000, 0);
      rbuf.copy(out, 2);
      /* 必须先发 close frame 再置 closed，否则 sendFrame 会直接跳过 */
      this.sendFrame(0x8, out);
    } catch (e) { /* 忽略 */ }
    this.closed = true;
    wsSockets.delete(this);
    try { this.socket.end(); } catch (e) { /* 忽略 */ }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

function sendJsonRes(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Cache-Control': 'no-store'
  };
  if (res._reqOrigin) headers['Access-Control-Allow-Origin'] = res._reqOrigin;
  res.writeHead(status, headers);
  res.end(body);
}

function corsHeaders(res) {
  return res._reqOrigin ? { 'Access-Control-Allow-Origin': res._reqOrigin } : {};
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function parseQuery(url) {
  const out = {};
  try { new URLSearchParams(url.search).forEach((v, k) => { out[k] = v; }); } catch (e) { /* 忽略 */ }
  return out;
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://' + req.headers.host || ('http://' + HOST + ':' + PORT));
  const pathname = url.pathname;
  const q = parseQuery(url);
  res._reqOrigin = corsOrigin(req);
  if (req.method === 'OPTIONS') {
    const headers = {
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    };
    if (res._reqOrigin) headers['Access-Control-Allow-Origin'] = res._reqOrigin;
    res.writeHead(204, headers);
    res.end();
    return;
  }

  /* 健康检查 */
  if (req.method === 'GET' && pathname === '/health') {
    sendJsonRes(res, 200, { ok: true, server: SERVER_NAME, version: VERSION, uptime: Math.round(process.uptime()), connections: wsSockets.size, tools: TOOLS.map(t => t.name) });
    return;
  }
  if (req.method === 'GET' && pathname === '/status') {
    sendJsonRes(res, 200, {
      ok: true, server: SERVER_NAME, version: VERSION, connections: wsSockets.size,
      whispers: whispers.length, health: healthData.length, letters: letters.length,
      sessions: Object.keys(sessions).length, contextFriends: Object.keys(contextStats).length,
      stickers: listStickers().length, hasGeo: !!geoLatest,
      bark: !!(config.bark && config.bark.enabled && config.bark.url),
      ntfy: !!(config.ntfy && config.ntfy.enabled && config.ntfy.topic),
      tts: !!(config.tts && config.tts.enabled && config.tts.endpoint && config.tts.apiKey),
      resident: Object.keys(resident).length,
      musicProvider: (config.music && config.music.provider) || 'kugou',
      lan: !!config.lan,
      proactive: !!(config.proactive && config.proactive.enabled)
    });
    return;
  }

  /* 表情文件 */
  if (pathname === '/stickers' || pathname === '/stickers/') {
    const list = listStickers();
    sendJsonRes(res, 200, { ok: true, stickers: list });
    return;
  }
  const stMatch = pathname.match(/^\/stickers\/([^/]+)$/);
  if (stMatch && req.method === 'GET') {
    const name = path.basename(decodeURIComponent(stMatch[1]));
    if (!/^[\w.\-]+\.(png|webp|gif|jpg|jpeg|svg)$/i.test(name)) {
      sendJsonRes(res, 400, { ok: false, error: '文件名不合法' });
      return;
    }
    const file = path.join(STICKER_DIR, name);
    if (!file.startsWith(STICKER_DIR) || !fs.existsSync(file)) {
      sendJsonRes(res, 404, { ok: false, error: '表情不存在' });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const types = { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
    res.writeHead(200, Object.assign({
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'max-age=3600'
    }, corsHeaders(res)));
    const st = fs.createReadStream(file);
    st.on('error', () => { try { res.destroy(); } catch (e) { /* 忽略 */ } });
    st.pipe(res);
    return;
  }

  /* TTS 音频文件 */
  const ttsMatch = pathname.match(/^\/tts\/([^/]+)$/);
  if (ttsMatch && req.method === 'GET') {
    const name = path.basename(decodeURIComponent(ttsMatch[1]));
    if (!/^[\w.\-]+\.mp3$/i.test(name)) {
      sendJsonRes(res, 400, { ok: false, error: '文件名不合法' });
      return;
    }
    const file = path.join(DATA_DIR, name);
    if (!file.startsWith(DATA_DIR) || !fs.existsSync(file)) {
      sendJsonRes(res, 404, { ok: false, error: '音频不存在' });
      return;
    }
    res.writeHead(200, Object.assign({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'max-age=3600'
    }, corsHeaders(res)));
    const ts = fs.createReadStream(file);
    ts.on('error', () => { try { res.destroy(); } catch (e) { /* 忽略 */ } });
    ts.pipe(res);
    return;
  }

  /* 心语墙 */
  if (pathname === '/api/whispers' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
    sendJsonRes(res, 200, { ok: true, whispers: whispers.slice(-limit).reverse() });
    return;
  }
  if (pathname === '/api/whispers' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) { sendJsonRes(res, 400, { ok: false, error: '缺少 text' }); return; }
      const w = { id: uid('whisper'), text: text.slice(0, 2000), author: String(body.author || '你').slice(0, 40), created: Date.now() };
      whispers.push(w);
      saveWhispers();
      sendJsonRes(res, 200, { ok: true, whisper: w });
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  const wDel = pathname.match(/^\/api\/whispers\/([^/]+)$/);
  if (wDel && req.method === 'DELETE') {
    const id = decodeURIComponent(wDel[1]);
    const before = whispers.length;
    whispers = whispers.filter(w => w.id !== id);
    if (before !== whispers.length) saveWhispers();
    sendJsonRes(res, 200, { ok: before !== whispers.length });
    return;
  }
  if (wDel && req.method === 'PATCH') {
    const id = decodeURIComponent(wDel[1]);
    try {
      const body = await readBody(req);
      const w = whispers.find(x => x.id === id);
      if (!w) { sendJsonRes(res, 404, { ok: false, error: '未找到该心语' }); return; }
      if (body.text !== undefined) {
        const text = String(body.text || '').trim();
        if (!text) { sendJsonRes(res, 400, { ok: false, error: '心语内容不能为空' }); return; }
        w.text = text.slice(0, 2000);
      }
      if (body.author !== undefined) w.author = String(body.author || '').slice(0, 40);
      saveWhispers();
      sendJsonRes(res, 200, { ok: true, whisper: w });
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }

  /* 健康看板 */
  if (pathname === '/api/health' && req.method === 'GET') {
    const days = Math.max(1, Math.min(365, Number(q.days) || 90));
    const since = Date.now() - days * 86400000;
    const list = healthData.filter(h => h.ts >= since).sort((x, y) => x.ts - y.ts);
    sendJsonRes(res, 200, { ok: true, days, count: list.length, records: list });
    return;
  }
  if (pathname === '/api/health' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const date = String(body.date || todayStr());
      const metrics = body.metrics && typeof body.metrics === 'object' && !Array.isArray(body.metrics) ? body.metrics : {};
      const existing = healthData.find(h => h.date === date);
      if (existing) {
        if (!existing.metrics || typeof existing.metrics !== 'object' || Array.isArray(existing.metrics)) existing.metrics = {};
        Object.assign(existing.metrics, metrics);
        existing.ts = Date.now();
        if (body.note !== undefined) existing.note = String(body.note).slice(0, 500);
      } else {
        healthData.push({ id: uid('health'), date, metrics: Object.assign({}, metrics), note: body.note ? String(body.note).slice(0, 500) : '', ts: Date.now() });
      }
      saveHealth();
      sendJsonRes(res, 200, { ok: true });
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }

  /* 地理 */
  if (pathname === '/api/geo' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        sendJsonRes(res, 400, { ok: false, error: 'lat/lng 无效' });
        return;
      }
      geoLatest = {
        lat, lng,
        accuracy: isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
        address: String(body.address || '').slice(0, 300),
        city: String(body.city || '').slice(0, 100),
        source: String(body.source || 'manual').slice(0, 40),
        ts: Date.now()
      };
      saveGeo();
      sendJsonRes(res, 200, { ok: true, geo: geoLatest });
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (pathname === '/api/geo/latest' && req.method === 'GET') {
    sendJsonRes(res, geoLatest ? 200 : 404, geoLatest ? { ok: true, geo: geoLatest } : { ok: false, error: '还没有位置数据' });
    return;
  }

  /* 天气 */
  if (pathname === '/api/weather' && req.method === 'GET') {
    const w = await getWeather(q.city);
    sendJsonRes(res, w.ok ? 200 : 502, w);
    return;
  }

  /* 网易云音乐 */
  if (pathname === '/api/music/search' && req.method === 'GET') {
    const r = await searchMusic(q.q || q.keyword, q.limit);
    sendJsonRes(res, r.ok ? 200 : 502, r);
    return;
  }
  if (pathname === '/api/music/url' && req.method === 'GET') {
    const r = await musicPlayUrl(q.id);
    sendJsonRes(res, r.ok ? 200 : 400, r);
    return;
  }
  if (pathname === '/api/music/open' && req.method === 'GET') {
    const id = String(q.id || '').trim();
    if (!id) { sendJsonRes(res, 400, { ok: false, error: 'ID 无效' }); return; }
    const provider = (config.music && config.music.provider) || 'kugou';
    if (provider === 'netease') {
      if (!/^\d+$/.test(id)) { sendJsonRes(res, 400, { ok: false, error: '网易云歌曲 ID 无效' }); return; }
      sendJsonRes(res, 200, {
        ok: true, provider: 'netease', name: String(q.name || '').slice(0, 200),
        webUrl: 'https://music.163.com/#/song?id=' + id, deepLink: null
      });
      return;
    }
    sendJsonRes(res, 200, {
      ok: true, provider: 'kugou', name: String(q.name || '').slice(0, 200),
      webUrl: 'https://www.kugou.com/song/#hash=' + encodeURIComponent(id),
      deepLink: 'kugou://kugou/play.html?hash=' + encodeURIComponent(id)
    });
    return;
  }
  if (pathname === '/api/music/play' && req.method === 'GET') {
    const sid = String(q.id || '');
    if (!sid) { sendJsonRes(res, 400, { ok: false, error: 'ID 无效' }); return; }
    try {
      let remote = await musicPlayRemote(sid);
      let isNetease = (config.music && config.music.provider) === 'netease';
      if (!remote.ok && (config.music && config.music.fallbackNetease !== false) && String(q.name || '').trim()) {
        /* 酷狗播放受限时按歌名自动切网易云兜底（仅当前这次播放，不改变默认源） */
        const fallback = await searchNetease(String(q.name).trim(), 1);
        if (fallback.ok && fallback.songs.length) {
          remote = { ok: true, url: 'https://music.163.com/song/media/outer/url?id=' + fallback.songs[0].id + '.mp3' };
          isNetease = true;
        }
      }
      if (!remote.ok) { sendJsonRes(res, 502, { ok: false, error: remote.error || '无法获取播放地址' }); return; }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      res.on('close', () => ctrl.abort());
      const up = await fetch(remote.url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
          'Referer': isNetease ? 'https://music.163.com/' : 'https://m.kugou.com/',
          'Cookie': (config.music && config.music.kugouCookie) || ''
        },
        signal: ctrl.signal
      });
      if (!up.ok) { clearTimeout(timer); sendJsonRes(res, 502, { ok: false, error: '音乐上游返回 HTTP ' + up.status }); return; }
      const ct = up.headers.get('content-type') || 'audio/mpeg';
      res.writeHead(200, Object.assign({
        'Content-Type': ct,
        'Cache-Control': 'no-store'
      }, corsHeaders(res)));
      const reader = up.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (e) {
        try { reader.cancel(); } catch (e2) { /* 忽略 */ }
        try { res.destroy(); } catch (e2) { /* 忽略 */ }
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (!res.headersSent) sendJsonRes(res, 502, { ok: false, error: '播放地址获取失败：' + String(e && e.message || e) });
      else res.end();
    }
    return;
  }

  /* 信件 */
  if (pathname === '/api/letters' && req.method === 'GET') {
    const list = letters.sort((x, y) => y.created - x.created).slice(0, Math.max(1, Math.min(100, Number(q.limit) || 50)));
    sendJsonRes(res, 200, { ok: true, letters: list });
    return;
  }
  if (pathname === '/api/letters' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      if (!content) { sendJsonRes(res, 400, { ok: false, error: '缺少 content' }); return; }
      const l = { id: uid('letter'), to: String(body.to || '').slice(0, 40), from: String(body.from || '你').slice(0, 40), content: content.slice(0, 10000), reply_to: String(body.reply_to || ''), read: false, created: Date.now() };
      letters.push(l);
      saveLetters();
      sendJsonRes(res, 200, { ok: true, letter: l });
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  const lDel = pathname.match(/^\/api\/letters\/([^/]+)$/);
  if (lDel && req.method === 'DELETE') {
    const id = decodeURIComponent(lDel[1]);
    const before = letters.length;
    letters = letters.filter(l => l.id !== id);
    if (before !== letters.length) saveLetters();
    sendJsonRes(res, 200, { ok: before !== letters.length });
    return;
  }

  /* 会话状态（多窗口/断线恢复） */
  const sessMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessMatch && req.method === 'GET') {
    const r = sessionGet(decodeURIComponent(sessMatch[1]));
    sendJsonRes(res, r.ok ? 200 : 400, r);
    return;
  }
  if (sessMatch && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = sessionSave(decodeURIComponent(sessMatch[1]), body.data);
      sendJsonRes(res, r.ok ? 200 : 400, r);
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (sessMatch && req.method === 'DELETE') {
    const k = decodeURIComponent(sessMatch[1]);
    delete sessions[k];
    saveSessions();
    sendJsonRes(res, 200, { ok: true });
    return;
  }

  /* 上下文统计 */
  if (pathname === '/api/context' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = contextAppend(q.friend || body.friend, body);
      sendJsonRes(res, 200, r);
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (pathname === '/api/context' && req.method === 'GET') {
    sendJsonRes(res, 200, contextSummary(q.friend));
    return;
  }

  /* 推送 */
  if (pathname === '/api/push' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const title = String(body.title || 'Internal Beyond').slice(0, 120);
      const text = String(body.text || '').slice(0, 2000);
      if (!text) { sendJsonRes(res, 400, { ok: false, error: '缺少 text' }); return; }
      broadcast({ type: 'push', title, text, from: String(body.from || 'Sui').slice(0, 40) });
      const bp = body.bark !== false ? await barkPush(title, text, body.url) : { ok: false };
      const np = body.ntfy !== false ? await ntfyPush(title, text, body.url) : { ok: false };
      recordPush({ title, text, from: body.from, bark: bp.ok, ntfy: np.ok });
      sendJsonRes(res, 200, { ok: true, bark: bp.ok, barkError: bp.ok ? '' : (bp.error || ''), ntfy: np.ok, ntfyError: np.ok ? '' : (np.error || '') });
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (pathname === '/api/push/history' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 20));
    sendJsonRes(res, 200, { ok: true, history: pushHistory.slice(0, limit) });
    return;
  }

  /* 配置（脱敏）与工具列表 */
  if (pathname === '/api/config' && req.method === 'GET') {
    const c = Object.assign({}, config);
    if (c.token) c.token = '***';
    if (c.proactive && c.proactive.apiKey) c.proactive.apiKey = '***';
    if (c.music && c.music.kugouCookie) c.music.kugouCookie = '***';
    if (c.tts && c.tts.apiKey) c.tts.apiKey = '***';
    sendJsonRes(res, 200, { ok: true, config: c, dataDir: DATA_DIR, stickerDir: STICKER_DIR });
    return;
  }
  if (pathname === '/api/tools' && req.method === 'GET') {
    sendJsonRes(res, 200, { ok: true, tools: TOOLS.map(t => ({ name: t.name, description: t.description })) });
    return;
  }

  /* TTS 合成 */
  if (pathname === '/api/tts' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = await ttsGenerate(body.text, body.voice);
      sendJsonRes(res, r.ok ? 200 : 503, r);
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }

  /* AI 常驻会话 */
  if (pathname === '/api/ai/sessions' && req.method === 'GET') {
    sendJsonRes(res, 200, { ok: true, sessions: residentList() });
    return;
  }
  if (pathname === '/api/ai/sessions' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const key = String(body.key || '').trim() || ('resident_' + Date.now().toString(36));
      const r = residentUpsert(key, body);
      sendJsonRes(res, r.ok ? 200 : 400, r.ok ? { ok: true, session: r.session } : r);
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  const aiSess = pathname.match(/^\/api\/ai\/sessions\/([^/]+)$/);
  if (aiSess && req.method === 'GET') {
    const sum = residentSummary(decodeURIComponent(aiSess[1]));
    if (!sum) { sendJsonRes(res, 404, { ok: false, error: '会话不存在' }); return; }
    const full = Object.assign({}, sum, { history: (resident[sum.key] && resident[sum.key].history) || [] });
    sendJsonRes(res, 200, { ok: true, session: full });
    return;
  }
  if (aiSess && req.method === 'DELETE') {
    const k = decodeURIComponent(aiSess[1]);
    delete resident[k];
    saveResident();
    sendJsonRes(res, 200, { ok: true });
    return;
  }
  if (pathname === '/api/ai/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = await residentChat(String(body.key || ''), body.message, body.maxContinues);
      sendJsonRes(res, r.ok ? 200 : 400, r);
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (pathname === '/api/ai/proactive' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const r = await residentProactive(String(body.key || ''), body.prompt);
      sendJsonRes(res, r.ok ? 200 : 400, r);
    } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
    return;
  }

  sendJsonRes(res, 404, { ok: false, error: '未找到接口：' + req.method + ' ' + pathname });
}

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
          (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]')) {
        originOk = true;
      }
    } catch (e) { /* 非法 Origin 一律拒绝 */ }
    if (!originOk) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
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
    if (!config.token) console.log('  ⚠ 已监听局域网但未设置 token：局域网内其他设备可访问本服务。建议配置 token 或配合 Tailscale。');
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
