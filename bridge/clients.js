/* IB Bridge · 外部服务客户端：天气（wttr.in）、网易云/酷狗搜索与播放、Bark/ntfy 推送。
   从 ib-bridge-service.js 提取为工厂：config 与 geoLatest 经依赖注入传入，
   避免反向依赖根文件。原逻辑逐字不变。 */
'use strict';

function createClients(deps) {
  const config = deps.config;            // config 工厂持有的共享对象
  const getGeoLatest = deps.getGeoLatest; // () => geoLatest | null

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
    const geo = getGeoLatest();
    const q = String(city || '').trim() || (geo && (geo.city || geo.address)) || '';
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

  return { fetchJson, getWeather, searchNetease, searchKugou, searchMusic, kugouPlayUrl, musicPlayUrl, musicPlayRemote, barkPush, ntfyPush };
}

module.exports = createClients;
