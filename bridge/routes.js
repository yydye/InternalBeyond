/* IB Bridge · HTTP 路由层：JSON 响应 / CORS / 限流 / 请求体解析 / 配置脱敏 /
   诊断快照 / REST 分发器。从 ib-bridge-service.js 提取为工厂：全部依赖经 ctx 注入。
   whispers / geoLatest / letters 在路由内存在重新赋值，通过 getter/setter 注入
   保持与 composition root 的绑定一致；其余状态仅原地变更，按引用注入。
   原逻辑逐字不变。 */
'use strict';

const fs = require('fs');
const path = require('path');

function createRoutes(ctx) {
  const {
    config, LAN_EXPOSED, configInvalid, SERVER_NAME, VERSION, HOST, PORT, BIND_HOST,
    DATA_DIR, STICKER_DIR, maxBody,
    wsSockets, TOOLS, listStickers,
    getWhispers, setWhispers, healthData, getGeoLatest, setGeoLatest,
    getLetters, setLetters, sessions, resident, contextStats, pushHistory,
    withListLock, uid, todayStr, saveList, saveGeo, saveSessions, saveResident,
    getWeather, searchMusic, musicPlayUrl, musicPlayRemote, searchNetease,
    barkPush, ntfyPush, ttsNormalize, ttsSynthesize, ttsVoices,
    sessionGet, sessionSave, contextAppend, contextSummary,
    residentList, residentUpsert, residentSummary, residentChat, residentProactive,
    broadcast, recordPush, lanAddresses, fileSummary, directoryUsage,
    httpAuthorized, authRequiredResponse,
    parseQuery, corsOrigin
  } = ctx;

  function sendJsonRes(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-IB-Token',
      'Cache-Control': 'no-store'
    };
    if (res._reqOrigin) headers['Access-Control-Allow-Origin'] = res._reqOrigin;
    res.writeHead(status, headers);
    res.end(body);
  }

  function corsHeaders(res) {
    return res._reqOrigin ? { 'Access-Control-Allow-Origin': res._reqOrigin } : {};
  }

  /* 轻量速率限制：每 IP 每秒最多 60 次，突发容忍度 80 */
  const rateMap = new Map();
  const RATE_LIMIT = { window: 1000, max: 60, burst: 80 };
  function rateCheck(req) {
    try {
      let ip = (req.socket && req.socket.remoteAddress) || (req.headers && req.headers['x-forwarded-for']) || '127.0.0.1';
      ip = String(ip).split(',')[0].trim();
      const now = Date.now();
      let entry = rateMap.get(ip);
      if (!entry || now - entry.windowStart > RATE_LIMIT.window) {
        rateMap.set(ip, { windowStart: now, count: 1 });
      } else {
        entry.count++;
        if (entry.count > RATE_LIMIT.burst) return false;
      }
      return true;
    } catch (e) { return true; }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', c => {
        total += c.length;
        if (total > maxBody) { reject(new Error('body too large')); req.destroy(); return; }
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

  /* 原始二进制流式读取（上传用）：边读边计数，超上限立即暂停并拒绝，
     绝不把超大 body 无限制读入内存后再判断。入口处另有 Content-Length 预检。 */
  function readRawBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;
      req.on('data', c => {
        if (settled) return;
        total += c.length;
        if (total > limit) { settled = true; req.pause(); reject(new Error('body too large')); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
      req.on('error', e => { if (!settled) { settled = true; reject(e); } });
    });
  }

  function safeConfigSnapshot() {
    /* JSON round-trip avoids mutating the live nested config while masking. */
    let copy = {};
    try { copy = JSON.parse(JSON.stringify(config)); } catch (e) { copy = {}; }
    const mask = value => value ? '***' : '';
    copy.token = mask(copy.token);
    if (copy.proactive) copy.proactive.apiKey = mask(copy.proactive.apiKey);
    if (copy.music) copy.music.kugouCookie = mask(copy.music.kugouCookie);
    if (copy.tts) copy.tts.apiKey = mask(copy.tts.apiKey);
    if (copy.ttsMimo) copy.ttsMimo.apiKey = mask(copy.ttsMimo.apiKey);
    if (copy.bark) copy.bark.url = mask(copy.bark.url);
    if (copy.webhooks && typeof copy.webhooks === 'object') {
      Object.keys(copy.webhooks).forEach(key => {
        const hook = copy.webhooks[key];
        if (!hook || typeof hook !== 'object') return;
        hook.url = mask(hook.url);
        if (hook.headers && typeof hook.headers === 'object') {
          Object.keys(hook.headers).forEach(name => { hook.headers[name] = '***'; });
        }
      });
    }
    return copy;
  }

  function diagnosticsSnapshot() {
    const storage = directoryUsage(DATA_DIR);
    const warnings = [];
    if (LAN_EXPOSED) warnings.push('局域网监听已启用；所有业务接口均需访问令牌。');
    if (configInvalid) warnings.push('配置文件曾损坏，已回退并重建。');
    if (!config.tts || !config.tts.enabled) warnings.push('OpenAI 兼容 TTS 未配置；页面仍可使用 Edge / 浏览器语音回退。');
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      service: {
        name: SERVER_NAME,
        version: VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        host: BIND_HOST,
        port: PORT,
        lan: LAN_EXPOSED,
        tokenRequired: !!(LAN_EXPOSED || String(config.token || '').trim()),
        websocketConnections: wsSockets.size
      },
      data: {
        directory: DATA_DIR,
        stickersDirectory: STICKER_DIR,
        usage: storage,
        records: {
          whispers: getWhispers().length,
          health: healthData.length,
          letters: getLetters().length,
          sessions: Object.keys(sessions).length,
          residents: Object.keys(resident).length,
          contextFriends: Object.keys(contextStats).length,
          pushes: pushHistory.length
        },
        files: ['config', 'whispers', 'health', 'geo', 'letters', 'sessions', 'resident', 'context', 'push_history'].map(fileSummary)
      },
      voiceAssets: (function () {
        /* VoiceClone Reference Audio 诊断：注册表 ↔ 磁盘对账（只读，不自动清理） */
        try {
          const d = ttsVoices.listReferencedVoiceAssets();
          return {
            assets: d.assets.length,
            bytes: d.assets.reduce((s, a) => s + (a.size || 0), 0),
            orphanFiles: d.orphanFiles,
            missingFiles: d.missingFiles
          };
        } catch (e) { return { assets: 0, bytes: 0, orphanFiles: [], missingFiles: [] }; }
      })(),
      capabilities: {
        bark: !!(config.bark && config.bark.enabled && config.bark.url),
        ntfy: !!(config.ntfy && config.ntfy.enabled && config.ntfy.topic),
        openaiTts: !!(config.tts && config.tts.enabled && config.tts.endpoint && config.tts.apiKey),
        mimoTts: !!(config.ttsMimo && config.ttsMimo.enabled && config.ttsMimo.endpoint && config.ttsMimo.apiKey),
        proactive: !!(config.proactive && config.proactive.enabled && config.proactive.endpoint),
        localAddresses: LAN_EXPOSED ? lanAddresses() : []
      },
      warnings
    };
  }

  /* ── 通用 LLM 代理 ──
     file://(Origin: null) 页面无法跨域直连的 OpenAI-compatible API，交给本地
     Bridge 在服务端发起，绕开浏览器 CORS。浏览器把「上游 URL / 头 / 包体」以
     JSON 交给本地 Bridge；Bridge 只负责转发并镜像状态码 / content-type / 包体，
     不解析、不改写厂商协议，因此 Provider 的 Base URL / API Key / Model /
     streaming / headers / endpoint 全部原样生效。
     · 上游敏感头（Authorization / x-api-key）随请求体交给 Bridge，仅经本机
       localhost，由 Bridge 转发到真实端点；不落盘、不写日志。
     · Bridge 自身鉴权由调用方以独立的 X-IB-Token 头提供，绝不与上游 API Key
       混用（避免把鉴权 token 当 API Key 转发，或反之）。 */
  async function proxyLlm(req, res) {
    let payload;
    try { payload = await readBody(req); }
    catch (e) { sendJsonRes(res, 400, { ok: false, error: '请求体解析失败' }); return; }
    const target = String(payload && payload.url || '').trim();
    let tu;
    try { tu = new URL(target); } catch (e) { sendJsonRes(res, 400, { ok: false, error: '目标地址无效' }); return; }
    if (tu.protocol !== 'https:' && tu.protocol !== 'http:') {
      sendJsonRes(res, 400, { ok: false, error: '仅支持 http/https 目标' }); return;
    }
    const method = String(payload.method || 'POST').toUpperCase();
    /* 只转发字符串型头；显式丢弃 Host 以防被用于伪造 / 污染。其余原样透传。 */
    const upHeaders = {};
    const ph = payload.headers || {};
    for (const k of Object.keys(ph)) {
      if (/^host$/i.test(String(k))) continue;
      if (typeof ph[k] === 'string') upHeaders[k] = ph[k];
    }
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const upBody = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    const ac = new AbortController();
    let upstreamReturned = false;
    /* 客户端断开 → 立即终止上游请求，避免后台继续计费/占用连接 */
    req.on('close', () => { if (!upstreamReturned) ac.abort(); });
    let up;
    try {
      up = await fetch(target, { method, headers: upHeaders, body: hasBody ? upBody : undefined, signal: ac.signal });
    } catch (e) {
      if (!ac.signal.aborted) sendJsonRes(res, 502, { ok: false, error: '上游请求失败: ' + String(e && e.message || e) });
      else { try { res.destroy(); } catch (e2) { /* 忽略 */ } }
      return;
    }
    upstreamReturned = true;
    const upStatus = up.status;
    const upCtRaw = String(up.headers.get('content-type') || '');
    const upCt = upCtRaw.toLowerCase();
    const isOk = upStatus >= 200 && upStatus < 300;
    const isStream = isOk && (upCt.includes('text/event-stream') || upCt.includes('application/x-ndjson') || upCt.includes('text/plain'));
    /* 镜像上游状态码与 content-type；补充本机 CORS 允许（file:// Origin: null 可读） */
    res.writeHead(upStatus, {
      'Content-Type': upCtRaw || 'application/json',
      'Cache-Control': 'no-store',
      ...(res._reqOrigin ? { 'Access-Control-Allow-Origin': res._reqOrigin } : {})
    });
    if (isStream) {
      /* 长流：取消默认 30s 空闲超时，逐块透传 SSE 包体 */
      try { req.socket.setTimeout(0); } catch (e) { /* 忽略 */ }
      const reader = up.body && up.body.getReader ? up.body.getReader() : null;
      if (!reader) { res.end(); return; }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch (e) { /* 客户端中止或上游中断：以落定方式收场 */ }
      try { res.end(); } catch (e) { /* 忽略 */ }
    } else {
      try {
        const text = await up.text().catch(() => '');
        res.end(Buffer.from(text, 'utf8'));
      } catch (e) { try { res.end(); } catch (e2) { /* 忽略 */ } }
    }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://' + req.headers.host || ('http://' + HOST + ':' + PORT));
    const pathname = url.pathname;
    const q = parseQuery(url);
    res._reqOrigin = corsOrigin(req);
    if (!rateCheck(req)) { sendJsonRes(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' }); return; }
    if (req.method === 'OPTIONS') {
      const headers = {
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-IB-Token'
      };
      if (res._reqOrigin) headers['Access-Control-Allow-Origin'] = res._reqOrigin;
      res.writeHead(204, headers);
      res.end();
      return;
    }

    /* 健康检查 */
    if (req.method === 'GET' && pathname === '/health') {
      sendJsonRes(res, 200, {
        ok: true, server: SERVER_NAME, version: VERSION, uptime: Math.round(process.uptime()),
        connections: wsSockets.size, tools: TOOLS.map(t => t.name),
        lan: LAN_EXPOSED, tokenRequired: !!(LAN_EXPOSED || String(config.token || '').trim())
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/status') {
      sendJsonRes(res, 200, {
        ok: true, server: SERVER_NAME, version: VERSION, connections: wsSockets.size,
        whispers: getWhispers().length, health: healthData.length, letters: getLetters().length,
        sessions: Object.keys(sessions).length, contextFriends: Object.keys(contextStats).length,
        stickers: listStickers().length, hasGeo: !!getGeoLatest(),
        bark: !!(config.bark && config.bark.enabled && config.bark.url),
        ntfy: !!(config.ntfy && config.ntfy.enabled && config.ntfy.topic),
        tts: !!(config.tts && config.tts.enabled && config.tts.endpoint && config.tts.apiKey),
        mimoTts: !!(config.ttsMimo && config.ttsMimo.enabled && config.ttsMimo.endpoint && config.ttsMimo.apiKey),
        resident: Object.keys(resident).length,
        musicProvider: (config.music && config.music.provider) || 'kugou',
        lan: LAN_EXPOSED,
        tokenRequired: !!(LAN_EXPOSED || String(config.token || '').trim()),
        proactive: !!(config.proactive && config.proactive.enabled)
      });
      return;
    }

    /* Diagnostics is deliberately authenticated whenever a token is required:
       it reveals data volume and enabled integration metadata. */
    if (req.method === 'GET' && pathname === '/api/diagnostics') {
      if (!httpAuthorized(req, q)) { authRequiredResponse(res); return; }
      sendJsonRes(res, 200, diagnosticsSnapshot());
      return;
    }

    /* Health is intentionally unauthenticated to allow a launcher to detect an
       existing service. Everything else has a token boundary in LAN mode. */
    if (!httpAuthorized(req, q)) { authRequiredResponse(res); return; }

    /* 通用 LLM 代理（file:// Origin:null 页面经本地 Bridge 跨域获取） */
    if (pathname === '/api/llm-proxy' && req.method === 'POST') {
      await proxyLlm(req, res);
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
      sendJsonRes(res, 200, { ok: true, whispers: getWhispers().slice(-limit).reverse() });
      return;
    }
    if (pathname === '/api/whispers' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) { sendJsonRes(res, 400, { ok: false, error: '缺少 text' }); return; }
        const w = await withListLock('whispers', () => {
          const item = { id: uid('whisper'), text: text.slice(0, 2000), author: String(body.author || '你').slice(0, 40), created: Date.now() };
          getWhispers().push(item);
          if (!saveList('whispers', getWhispers())) throw new Error('磁盘写入失败');
          return item;
        });
        sendJsonRes(res, 200, { ok: true, whisper: w });
      } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
      return;
    }
    const wDel = pathname.match(/^\/api\/whispers\/([^/]+)$/);
    if (wDel && req.method === 'DELETE') {
      const id = decodeURIComponent(wDel[1]);
      const r = await withListLock('whispers', () => {
        const before = getWhispers().length;
        setWhispers(getWhispers().filter(w => w.id !== id));
        if (before !== getWhispers().length) { if (!saveList('whispers', getWhispers())) throw new Error('磁盘写入失败'); }
        return before !== getWhispers().length;
      });
      sendJsonRes(res, 200, { ok: r });
      return;
    }
    if (wDel && req.method === 'PATCH') {
      const id = decodeURIComponent(wDel[1]);
      try {
        const body = await readBody(req);
        const r = await withListLock('whispers', () => {
          const w = getWhispers().find(x => x.id === id);
          if (!w) throw new Error('未找到该心语');
          if (body.text !== undefined) {
            const text = String(body.text || '').trim();
            if (!text) throw new Error('心语内容不能为空');
            w.text = text.slice(0, 2000);
          }
          if (body.author !== undefined) w.author = String(body.author || '').slice(0, 40);
          if (!saveList('whispers', getWhispers())) throw new Error('磁盘写入失败');
          return w;
        });
        sendJsonRes(res, 200, { ok: true, whisper: r });
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
        let metrics = body.metrics && typeof body.metrics === 'object' && !Array.isArray(body.metrics) ? body.metrics : {};
        let note = body.note !== undefined ? String(body.note).slice(0, 500) : '';
        await withListLock('health', () => {
          const existing = healthData.find(h => h.date === date);
          if (existing) {
            if (!existing.metrics || typeof existing.metrics !== 'object' || Array.isArray(existing.metrics)) existing.metrics = {};
            Object.assign(existing.metrics, metrics);
            existing.ts = Date.now();
            if (body.note !== undefined) existing.note = note;
          } else {
            healthData.push({ id: uid('health'), date, metrics: Object.assign({}, metrics), note: note, ts: Date.now() });
          }
          if (!saveList('health', healthData)) throw new Error('磁盘写入失败');
        });
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
        setGeoLatest({
          lat, lng,
          accuracy: isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
          address: String(body.address || '').slice(0, 300),
          city: String(body.city || '').slice(0, 100),
          source: String(body.source || 'manual').slice(0, 40),
          ts: Date.now()
        });
        saveGeo();
        sendJsonRes(res, 200, { ok: true, geo: getGeoLatest() });
      } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
      return;
    }
    if (pathname === '/api/geo/latest' && req.method === 'GET') {
      sendJsonRes(res, getGeoLatest() ? 200 : 404, getGeoLatest() ? { ok: true, geo: getGeoLatest() } : { ok: false, error: '还没有位置数据' });
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
        if (!remote.ok && (config.music && config.music.fallbackNetease !== false)) {
          /* 酷狗播放受限时按歌名自动切网易云兜底（仅当前这次播放，不改变默认源） */
          const fallbackName = String(q.name || '').trim();
          if (fallbackName) {
            const fallback = await searchNetease(fallbackName, 1);
            if (fallback.ok && fallback.songs.length) {
              remote = { ok: true, url: 'https://music.163.com/song/media/outer/url?id=' + fallback.songs[0].id + '.mp3' };
              isNetease = true;
            }
          }
        }
        if (!remote.ok) { sendJsonRes(res, 502, { ok: false, error: remote.error || '无法获取播放地址（酷狗服务端限制，可补填 ?name=歌名 启用网易云兜底）' }); return; }
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
      const list = getLetters().sort((x, y) => y.created - x.created).slice(0, Math.max(1, Math.min(100, Number(q.limit) || 50)));
      sendJsonRes(res, 200, { ok: true, letters: list });
      return;
    }
    if (pathname === '/api/letters' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        if (!content) { sendJsonRes(res, 400, { ok: false, error: '缺少 content' }); return; }
        const l = await withListLock('letters', () => {
          const item = { id: uid('letter'), to: String(body.to || '').slice(0, 40), from: String(body.from || '你').slice(0, 40), content: content.slice(0, 10000), reply_to: String(body.reply_to || ''), read: false, created: Date.now() };
          getLetters().push(item);
          if (!saveList('letters', getLetters())) throw new Error('磁盘写入失败');
          return item;
        });
        sendJsonRes(res, 200, { ok: true, letter: l });
      } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
      return;
    }
    const lDel = pathname.match(/^\/api\/letters\/([^/]+)$/);
    if (lDel && req.method === 'DELETE') {
      const id = decodeURIComponent(lDel[1]);
      const r = await withListLock('letters', () => {
        const before = getLetters().length;
        setLetters(getLetters().filter(l => l.id !== id));
        if (before !== getLetters().length && !saveList('letters', getLetters())) throw new Error('磁盘写入失败');
        return before !== getLetters().length;
      });
      sendJsonRes(res, 200, { ok: r });
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
        const r = await contextAppend(q.friend || body.friend, body);
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
      sendJsonRes(res, 200, { ok: true, config: safeConfigSnapshot(), dataDir: DATA_DIR, stickerDir: STICKER_DIR });
      return;
    }
    if (pathname === '/api/tools' && req.method === 'GET') {
      sendJsonRes(res, 200, { ok: true, tools: TOOLS.map(t => ({ name: t.name, description: t.description })) });
      return;
    }

    /* TTS 合成（Voice Profile 统一入口：normalize 兼容旧平铺参数与新 profile，按 provider 能力过滤） */
    if (pathname === '/api/tts' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const r = await ttsSynthesize(ttsNormalize(body));
        sendJsonRes(res, r.ok ? 200 : 503, r);
      } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
      return;
    }

    /* ── Reference Audio 资产 API（VoiceClone 基础设施 · 第三阶段 B1）──
       POST   /api/tts/voices           上传（原始二进制 body；?name= 原始文件名仅作 metadata）
       GET    /api/tts/voices           列出资产 + 磁盘↔注册表对账诊断（只读）
       GET    /api/tts/voices/:id       按 refAudioId 读取文件（HEAD 同支持）
       DELETE /api/tts/voices/:id       删除（body {referencedIds:[...]} 声明当前仍被角色引用的 id，
                                        命中则拒绝，防止角色引用静默失效） */
    if (pathname === '/api/tts/voices' && req.method === 'GET') {
      const d = ttsVoices.listReferencedVoiceAssets();
      sendJsonRes(res, 200, { ok: true, voices: d.assets, diagnostics: { orphanFiles: d.orphanFiles, missingFiles: d.missingFiles } });
      return;
    }
    if (pathname === '/api/tts/voices' && req.method === 'POST') {
      try {
        const maxBytes = ttsVoices.maxBytes;
        const declared = Number(req.headers['content-length']);
        if (declared > maxBytes) {
          /* 入口即拒绝（不读取 body）；等响应写完再断开，避免客户端看到的是连接重置而非明确错误 */
          res.on('finish', () => { try { req.destroy(); } catch (e) { /* 忽略 */ } });
          sendJsonRes(res, 413, { ok: false, error: 'Reference Audio 超过 10 MB 上限' });
          return;
        }
        const buf = await readRawBody(req, maxBytes);
        const r = ttsVoices.saveRefAudio({
          buf,
          contentType: req.headers['content-type'] || '',
          originalName: q.name || ''
        });
        sendJsonRes(res, r.ok ? 200 : 400, r);
      } catch (e) {
        if (/body too large/.test(String(e && e.message || e))) {
          res.on('finish', () => { try { req.destroy(); } catch (e2) { /* 忽略 */ } });
          sendJsonRes(res, 413, { ok: false, error: 'Reference Audio 超过 10 MB 上限' });
        } else {
          sendJsonRes(res, 400, { ok: false, error: e && e.message || 'upload failed' });
        }
      }
      return;
    }
    const voiceMatch = pathname.match(/^\/api\/tts\/voices\/([^/]+)$/);
    if (voiceMatch) {
      let id;
      try { id = decodeURIComponent(voiceMatch[1]); } catch (e) {
        sendJsonRes(res, 400, { ok: false, error: 'Reference Audio id 不合法' });
        return;
      }
      if (!ttsVoices.getRefAudioMeta(id)) {
        /* 不存在或非法 id 一律 404（不区分，避免探测），路径穿越也在 id 白名单校验下失败 */
        sendJsonRes(res, 404, { ok: false, error: 'Reference Audio 不存在' });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const resolved = ttsVoices.resolveRefAudio(id);
        if (!resolved) { sendJsonRes(res, 404, { ok: false, error: 'Reference Audio 不存在' }); return; }
        const stat = fs.statSync(resolved.file);
        res.writeHead(200, Object.assign({
          'Content-Type': resolved.meta.mime,
          'Content-Length': stat.size,
          'Cache-Control': 'no-store'
        }, corsHeaders(res)));
        if (req.method === 'HEAD') { res.end(); return; }
        const rs = fs.createReadStream(resolved.file);
        rs.on('error', () => { try { res.destroy(); } catch (e) { /* 忽略 */ } });
        rs.pipe(res);
        return;
      }
      if (req.method === 'DELETE') {
        try {
          const body = await readBody(req);
          const referenced = Array.isArray(body && body.referencedIds) ? body.referencedIds : [];
          if (referenced.indexOf(id) !== -1) {
            sendJsonRes(res, 409, { ok: false, error: '该 Reference Audio 仍被角色引用，拒绝删除。请先将被引用角色切换为 Built-in 音色或解除引用（删除即解绑会静默破坏 VoiceClone）。' });
            return;
          }
          const r = ttsVoices.deleteRefAudio(id);
          sendJsonRes(res, r.ok ? 200 : 404, r);
        } catch (e) { sendJsonRes(res, 400, { ok: false, error: e.message }); }
        return;
      }
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

  return { sendJsonRes, corsHeaders, rateCheck, readBody, safeConfigSnapshot, diagnosticsSnapshot, handleHttp };
}

module.exports = createRoutes;
